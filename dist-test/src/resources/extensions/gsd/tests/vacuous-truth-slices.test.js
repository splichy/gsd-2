import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveStateFromDb, invalidateStateCache } from "../state.js";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice
} from "../gsd-db.js";
test("deriveStateFromDb does NOT skip to validating when slice array is empty (#2667)", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-vacuous-truth-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  try {
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
      [
        "# M001: Test Milestone",
        "",
        "## Slices",
        "",
        "### S01 \u2014 First Slice",
        "Do something.",
        "",
        "### S02 \u2014 Second Slice",
        "Do another thing."
      ].join("\n")
    );
    openDatabase(":memory:");
    insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
    invalidateStateCache();
    const state = await deriveStateFromDb(base);
    assert.notEqual(
      state.phase,
      "validating-milestone",
      "empty slice array must not trigger validating-milestone (vacuous truth)"
    );
    assert.notEqual(
      state.phase,
      "completing-milestone",
      "empty slice array must not trigger completing-milestone (vacuous truth)"
    );
    closeDatabase();
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});
test("deriveStateFromDb correctly reaches validating when all slices are done (#2667 guard)", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-vacuous-truth-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
  try {
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
      [
        "# M001: Test Milestone",
        "",
        "## Slices",
        "",
        "### S01 \u2014 First Slice",
        "Do something."
      ].join("\n")
    );
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md"),
      "# S01 Summary\n\nDone."
    );
    openDatabase(":memory:");
    insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "First Slice", status: "complete", risk: "low", depends: [] });
    invalidateStateCache();
    const state = await deriveStateFromDb(base);
    assert.ok(
      state.phase === "validating-milestone" || state.phase === "completing-milestone",
      `expected validating or completing phase, got "${state.phase}"`
    );
    closeDatabase();
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy92YWN1b3VzLXRydXRoLXNsaWNlcy50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFJlZ3Jlc3Npb24gdGVzdCBmb3IgIzI2Njc6IGRlcml2ZVN0YXRlRnJvbURiIG11c3QgTk9UIHRyZWF0IGFuIGVtcHR5XG4gKiBzbGljZSBhcnJheSBhcyBcImFsbCBzbGljZXMgZG9uZVwiIGR1ZSB0byBKYXZhU2NyaXB0J3MgdmFjdW91cy10cnV0aFxuICogYmVoYXZpb3Igb2YgQXJyYXkucHJvdG90eXBlLmV2ZXJ5IG9uIGFuIGVtcHR5IGFycmF5LlxuICpcbiAqIFtdLmV2ZXJ5KHByZWRpY2F0ZSkgPT09IHRydWUgaW4gSmF2YVNjcmlwdC4gV2l0aG91dCBhIGxlbmd0aCA+IDAgZ3VhcmQsXG4gKiB0aGlzIGNhdXNlcyBhIHByZW1hdHVyZSBwaGFzZSB0cmFuc2l0aW9uIHRvIHZhbGlkYXRpbmctbWlsZXN0b25lIHdoZW5cbiAqIHRoZSBEQiByZXR1cm5zIDAgc2xpY2VzIChlLmcuIGFmdGVyIGEgd29ya3RyZWUgREIgd2lwZSkuXG4gKi9cbmltcG9ydCB7IHRlc3QgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBta2RpclN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcblxuaW1wb3J0IHsgZGVyaXZlU3RhdGVGcm9tRGIsIGludmFsaWRhdGVTdGF0ZUNhY2hlIH0gZnJvbSBcIi4uL3N0YXRlLnRzXCI7XG5pbXBvcnQge1xuICBvcGVuRGF0YWJhc2UsXG4gIGNsb3NlRGF0YWJhc2UsXG4gIGluc2VydE1pbGVzdG9uZSxcbiAgaW5zZXJ0U2xpY2UsXG59IGZyb20gXCIuLi9nc2QtZGIudHNcIjtcblxudGVzdChcImRlcml2ZVN0YXRlRnJvbURiIGRvZXMgTk9UIHNraXAgdG8gdmFsaWRhdGluZyB3aGVuIHNsaWNlIGFycmF5IGlzIGVtcHR5ICgjMjY2NylcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtdmFjdW91cy10cnV0aC1cIikpO1xuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgdHJ5IHtcbiAgICAvLyBTZXQgdXAgYSBtaWxlc3RvbmUgd2l0aCBhIHJvYWRtYXAgdGhhdCByZWZlcmVuY2VzIHNsaWNlcyxcbiAgICAvLyBidXQgdGhlIERCIGhhcyBOTyBzbGljZSByb3dzIChzaW11bGF0aW5nIGEgd29ya3RyZWUgREIgd2lwZSlcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcIk0wMDEtUk9BRE1BUC5tZFwiKSxcbiAgICAgIFtcbiAgICAgICAgXCIjIE0wMDE6IFRlc3QgTWlsZXN0b25lXCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiIyMgU2xpY2VzXCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiIyMjIFMwMSBcdTIwMTQgRmlyc3QgU2xpY2VcIixcbiAgICAgICAgXCJEbyBzb21ldGhpbmcuXCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiIyMjIFMwMiBcdTIwMTQgU2Vjb25kIFNsaWNlXCIsXG4gICAgICAgIFwiRG8gYW5vdGhlciB0aGluZy5cIixcbiAgICAgIF0uam9pbihcIlxcblwiKSxcbiAgICApO1xuXG4gICAgb3BlbkRhdGFiYXNlKFwiOm1lbW9yeTpcIik7XG4gICAgLy8gTWlsZXN0b25lIGV4aXN0cyBidXQgTk8gc2xpY2VzIGluc2VydGVkIFx1MjAxNCBzaW11bGF0ZXMgREIgd2lwZVxuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdCBNaWxlc3RvbmVcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuXG4gICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlRnJvbURiKGJhc2UpO1xuXG4gICAgLy8gVGhlIHBoYXNlIG11c3QgTk9UIGJlIFwidmFsaWRhdGluZy1taWxlc3RvbmVcIiBvciBcImNvbXBsZXRpbmctbWlsZXN0b25lXCJcbiAgICAvLyBiZWNhdXNlIG5vIHNsaWNlcyBoYXZlIGJlZW4gZXhlY3V0ZWQgXHUyMDE0IHRoZSBlbXB0eSBhcnJheSBzaG91bGQgbm90XG4gICAgLy8gdHJpZ2dlciB0aGUgXCJhbGwgc2xpY2VzIGRvbmVcIiBjb2RlIHBhdGguXG4gICAgYXNzZXJ0Lm5vdEVxdWFsKFxuICAgICAgc3RhdGUucGhhc2UsXG4gICAgICBcInZhbGlkYXRpbmctbWlsZXN0b25lXCIsXG4gICAgICBcImVtcHR5IHNsaWNlIGFycmF5IG11c3Qgbm90IHRyaWdnZXIgdmFsaWRhdGluZy1taWxlc3RvbmUgKHZhY3VvdXMgdHJ1dGgpXCIsXG4gICAgKTtcbiAgICBhc3NlcnQubm90RXF1YWwoXG4gICAgICBzdGF0ZS5waGFzZSxcbiAgICAgIFwiY29tcGxldGluZy1taWxlc3RvbmVcIixcbiAgICAgIFwiZW1wdHkgc2xpY2UgYXJyYXkgbXVzdCBub3QgdHJpZ2dlciBjb21wbGV0aW5nLW1pbGVzdG9uZSAodmFjdW91cyB0cnV0aClcIixcbiAgICApO1xuXG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcImRlcml2ZVN0YXRlRnJvbURiIGNvcnJlY3RseSByZWFjaGVzIHZhbGlkYXRpbmcgd2hlbiBhbGwgc2xpY2VzIGFyZSBkb25lICgjMjY2NyBndWFyZClcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtdmFjdW91cy10cnV0aC1cIikpO1xuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcIk0wMDEtUk9BRE1BUC5tZFwiKSxcbiAgICAgIFtcbiAgICAgICAgXCIjIE0wMDE6IFRlc3QgTWlsZXN0b25lXCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiIyMgU2xpY2VzXCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiIyMjIFMwMSBcdTIwMTQgRmlyc3QgU2xpY2VcIixcbiAgICAgICAgXCJEbyBzb21ldGhpbmcuXCIsXG4gICAgICBdLmpvaW4oXCJcXG5cIiksXG4gICAgKTtcblxuICAgIC8vIFdyaXRlIGEgc2xpY2Ugc3VtbWFyeSBzbyB0aGUgZmlsZXN5c3RlbSByZWNvZ25pemVzIGl0IGFzIGNvbXBsZXRlXG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDFcIiwgXCJTMDEtU1VNTUFSWS5tZFwiKSxcbiAgICAgIFwiIyBTMDEgU3VtbWFyeVxcblxcbkRvbmUuXCIsXG4gICAgKTtcblxuICAgIG9wZW5EYXRhYmFzZShcIjptZW1vcnk6XCIpO1xuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdCBNaWxlc3RvbmVcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuICAgIGluc2VydFNsaWNlKHsgaWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiRmlyc3QgU2xpY2VcIiwgc3RhdHVzOiBcImNvbXBsZXRlXCIsIHJpc2s6IFwibG93XCIsIGRlcGVuZHM6IFtdIH0pO1xuXG4gICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlRnJvbURiKGJhc2UpO1xuXG4gICAgLy8gV2l0aCBvbmUgc2xpY2UgdGhhdCBJUyBjb21wbGV0ZSwgcGhhc2Ugc2hvdWxkIGFkdmFuY2VcbiAgICBhc3NlcnQub2soXG4gICAgICBzdGF0ZS5waGFzZSA9PT0gXCJ2YWxpZGF0aW5nLW1pbGVzdG9uZVwiIHx8IHN0YXRlLnBoYXNlID09PSBcImNvbXBsZXRpbmctbWlsZXN0b25lXCIsXG4gICAgICBgZXhwZWN0ZWQgdmFsaWRhdGluZyBvciBjb21wbGV0aW5nIHBoYXNlLCBnb3QgXCIke3N0YXRlLnBoYXNlfVwiYCxcbiAgICApO1xuXG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQVNBLFNBQVMsWUFBWTtBQUNyQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxhQUFhLFdBQVcsUUFBUSxxQkFBcUI7QUFDOUQsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUV2QixTQUFTLG1CQUFtQiw0QkFBNEI7QUFDeEQ7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUVQLEtBQUssbUZBQW1GLFlBQVk7QUFDbEcsUUFBTSxPQUFPLFlBQVksS0FBSyxPQUFPLEdBQUcsb0JBQW9CLENBQUM7QUFDN0QsWUFBVSxLQUFLLE1BQU0sUUFBUSxjQUFjLE1BQU0sR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBRXZFLE1BQUk7QUFHRjtBQUFBLE1BQ0UsS0FBSyxNQUFNLFFBQVEsY0FBYyxRQUFRLGlCQUFpQjtBQUFBLE1BQzFEO0FBQUEsUUFDRTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsTUFDRixFQUFFLEtBQUssSUFBSTtBQUFBLElBQ2I7QUFFQSxpQkFBYSxVQUFVO0FBRXZCLG9CQUFnQixFQUFFLElBQUksUUFBUSxPQUFPLGtCQUFrQixRQUFRLFNBQVMsQ0FBQztBQUV6RSx5QkFBcUI7QUFDckIsVUFBTSxRQUFRLE1BQU0sa0JBQWtCLElBQUk7QUFLMUMsV0FBTztBQUFBLE1BQ0wsTUFBTTtBQUFBLE1BQ047QUFBQSxNQUNBO0FBQUEsSUFDRjtBQUNBLFdBQU87QUFBQSxNQUNMLE1BQU07QUFBQSxNQUNOO0FBQUEsTUFDQTtBQUFBLElBQ0Y7QUFFQSxrQkFBYztBQUFBLEVBQ2hCLFVBQUU7QUFDQSxrQkFBYztBQUNkLFdBQU8sTUFBTSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLEVBQy9DO0FBQ0YsQ0FBQztBQUVELEtBQUsseUZBQXlGLFlBQVk7QUFDeEcsUUFBTSxPQUFPLFlBQVksS0FBSyxPQUFPLEdBQUcsb0JBQW9CLENBQUM7QUFDN0QsWUFBVSxLQUFLLE1BQU0sUUFBUSxjQUFjLFFBQVEsVUFBVSxLQUFLLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUV4RixNQUFJO0FBQ0Y7QUFBQSxNQUNFLEtBQUssTUFBTSxRQUFRLGNBQWMsUUFBUSxpQkFBaUI7QUFBQSxNQUMxRDtBQUFBLFFBQ0U7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLE1BQ0YsRUFBRSxLQUFLLElBQUk7QUFBQSxJQUNiO0FBR0E7QUFBQSxNQUNFLEtBQUssTUFBTSxRQUFRLGNBQWMsUUFBUSxVQUFVLE9BQU8sZ0JBQWdCO0FBQUEsTUFDMUU7QUFBQSxJQUNGO0FBRUEsaUJBQWEsVUFBVTtBQUN2QixvQkFBZ0IsRUFBRSxJQUFJLFFBQVEsT0FBTyxrQkFBa0IsUUFBUSxTQUFTLENBQUM7QUFDekUsZ0JBQVksRUFBRSxJQUFJLE9BQU8sYUFBYSxRQUFRLE9BQU8sZUFBZSxRQUFRLFlBQVksTUFBTSxPQUFPLFNBQVMsQ0FBQyxFQUFFLENBQUM7QUFFbEgseUJBQXFCO0FBQ3JCLFVBQU0sUUFBUSxNQUFNLGtCQUFrQixJQUFJO0FBRzFDLFdBQU87QUFBQSxNQUNMLE1BQU0sVUFBVSwwQkFBMEIsTUFBTSxVQUFVO0FBQUEsTUFDMUQsaURBQWlELE1BQU0sS0FBSztBQUFBLElBQzlEO0FBRUEsa0JBQWM7QUFBQSxFQUNoQixVQUFFO0FBQ0Esa0JBQWM7QUFDZCxXQUFPLE1BQU0sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUMvQztBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
