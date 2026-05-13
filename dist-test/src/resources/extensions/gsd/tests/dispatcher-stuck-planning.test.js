import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, insertMilestone, insertSlice, openDatabase } from "../gsd-db.js";
import { deriveStateFromDb, invalidateStateCache } from "../state.js";
describe("dispatcher DB-authoritative planning boundary", () => {
  let base;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "gsd-dispatcher-planning-"));
    mkdirSync(join(base, ".gsd", "milestones", "M001", "S01"), { recursive: true });
    writeFileSync(join(base, ".gsd", "milestones", "M001", "CONTEXT.md"), "# M001\n");
    writeFileSync(join(base, ".gsd", "milestones", "M001", "ROADMAP.md"), [
      "## Slices",
      "- [ ] **S01: Build** `risk:low` `depends:[]`"
    ].join("\n"));
    writeFileSync(join(base, ".gsd", "milestones", "M001", "S01", "PLAN.md"), [
      "## Tasks",
      "- [ ] **T01: Projection-only task**"
    ].join("\n"));
    openDatabase(join(base, ".gsd", "gsd.db"));
  });
  afterEach(() => {
    closeDatabase();
    invalidateStateCache();
    rmSync(base, { recursive: true, force: true });
  });
  test("PLAN.md projection tasks are not imported into runtime DB state", async () => {
    insertMilestone({ id: "M001", title: "Milestone 1", status: "active", depends_on: [] });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Build", status: "active", depends: [] });
    const state = await deriveStateFromDb(base);
    assert.equal(state.phase, "planning");
    assert.equal(state.activeTask, null);
    assert.match(
      state.nextAction ?? "",
      /Slice S01 has no DB tasks\. Plan slice tasks before execution\./
    );
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9kaXNwYXRjaGVyLXN0dWNrLXBsYW5uaW5nLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogZGlzcGF0Y2hlci1zdHVjay1wbGFubmluZy50ZXN0LnRzXG4gKlxuICogVmVyaWZ5IHRoYXQgc3RhdGUudHMgbm8gbG9uZ2VyIGltcG9ydHMgZGlzayBQTEFOLm1kIHRhc2tzIGludG8gdGhlIHJ1bnRpbWVcbiAqIERCLiBQTEFOLm1kIGlzIGEgcHJvamVjdGlvbjsgdGFzayByb3dzIG11c3QgYmUgY3JlYXRlZCB0aHJvdWdoIERCLWJhY2tlZFxuICogcGxhbm5pbmcvaW1wb3J0IEFQSXMuXG4gKi9cblxuaW1wb3J0IHsgYWZ0ZXJFYWNoLCBiZWZvcmVFYWNoLCBkZXNjcmliZSwgdGVzdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuXG5pbXBvcnQgeyBjbG9zZURhdGFiYXNlLCBpbnNlcnRNaWxlc3RvbmUsIGluc2VydFNsaWNlLCBvcGVuRGF0YWJhc2UgfSBmcm9tIFwiLi4vZ3NkLWRiLnRzXCI7XG5pbXBvcnQgeyBkZXJpdmVTdGF0ZUZyb21EYiwgaW52YWxpZGF0ZVN0YXRlQ2FjaGUgfSBmcm9tIFwiLi4vc3RhdGUudHNcIjtcblxuZGVzY3JpYmUoXCJkaXNwYXRjaGVyIERCLWF1dGhvcml0YXRpdmUgcGxhbm5pbmcgYm91bmRhcnlcIiwgKCkgPT4ge1xuICBsZXQgYmFzZTogc3RyaW5nO1xuXG4gIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgIGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1kaXNwYXRjaGVyLXBsYW5uaW5nLVwiKSk7XG4gICAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJTMDFcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcIkNPTlRFWFQubWRcIiksIFwiIyBNMDAxXFxuXCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcIlJPQURNQVAubWRcIiksIFtcbiAgICAgIFwiIyMgU2xpY2VzXCIsXG4gICAgICBcIi0gWyBdICoqUzAxOiBCdWlsZCoqIGByaXNrOmxvd2AgYGRlcGVuZHM6W11gXCIsXG4gICAgXS5qb2luKFwiXFxuXCIpKTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJTMDFcIiwgXCJQTEFOLm1kXCIpLCBbXG4gICAgICBcIiMjIFRhc2tzXCIsXG4gICAgICBcIi0gWyBdICoqVDAxOiBQcm9qZWN0aW9uLW9ubHkgdGFzayoqXCIsXG4gICAgXS5qb2luKFwiXFxuXCIpKTtcbiAgICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJnc2QuZGJcIikpO1xuICB9KTtcblxuICBhZnRlckVhY2goKCkgPT4ge1xuICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJQTEFOLm1kIHByb2plY3Rpb24gdGFza3MgYXJlIG5vdCBpbXBvcnRlZCBpbnRvIHJ1bnRpbWUgREIgc3RhdGVcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiTWlsZXN0b25lIDFcIiwgc3RhdHVzOiBcImFjdGl2ZVwiLCBkZXBlbmRzX29uOiBbXSB9KTtcbiAgICBpbnNlcnRTbGljZSh7IGlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHRpdGxlOiBcIkJ1aWxkXCIsIHN0YXR1czogXCJhY3RpdmVcIiwgZGVwZW5kczogW10gfSk7XG5cbiAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlRnJvbURiKGJhc2UpO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHN0YXRlLnBoYXNlLCBcInBsYW5uaW5nXCIpO1xuICAgIGFzc2VydC5lcXVhbChzdGF0ZS5hY3RpdmVUYXNrLCBudWxsKTtcbiAgICBhc3NlcnQubWF0Y2goXG4gICAgICBzdGF0ZS5uZXh0QWN0aW9uID8/IFwiXCIsXG4gICAgICAvU2xpY2UgUzAxIGhhcyBubyBEQiB0YXNrc1xcLiBQbGFuIHNsaWNlIHRhc2tzIGJlZm9yZSBleGVjdXRpb25cXC4vLFxuICAgICk7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFRQSxTQUFTLFdBQVcsWUFBWSxVQUFVLFlBQVk7QUFDdEQsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxXQUFXLFFBQVEscUJBQXFCO0FBQzlELFNBQVMsY0FBYztBQUN2QixTQUFTLFlBQVk7QUFFckIsU0FBUyxlQUFlLGlCQUFpQixhQUFhLG9CQUFvQjtBQUMxRSxTQUFTLG1CQUFtQiw0QkFBNEI7QUFFeEQsU0FBUyxpREFBaUQsTUFBTTtBQUM5RCxNQUFJO0FBRUosYUFBVyxNQUFNO0FBQ2YsV0FBTyxZQUFZLEtBQUssT0FBTyxHQUFHLDBCQUEwQixDQUFDO0FBQzdELGNBQVUsS0FBSyxNQUFNLFFBQVEsY0FBYyxRQUFRLEtBQUssR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQzlFLGtCQUFjLEtBQUssTUFBTSxRQUFRLGNBQWMsUUFBUSxZQUFZLEdBQUcsVUFBVTtBQUNoRixrQkFBYyxLQUFLLE1BQU0sUUFBUSxjQUFjLFFBQVEsWUFBWSxHQUFHO0FBQUEsTUFDcEU7QUFBQSxNQUNBO0FBQUEsSUFDRixFQUFFLEtBQUssSUFBSSxDQUFDO0FBQ1osa0JBQWMsS0FBSyxNQUFNLFFBQVEsY0FBYyxRQUFRLE9BQU8sU0FBUyxHQUFHO0FBQUEsTUFDeEU7QUFBQSxNQUNBO0FBQUEsSUFDRixFQUFFLEtBQUssSUFBSSxDQUFDO0FBQ1osaUJBQWEsS0FBSyxNQUFNLFFBQVEsUUFBUSxDQUFDO0FBQUEsRUFDM0MsQ0FBQztBQUVELFlBQVUsTUFBTTtBQUNkLGtCQUFjO0FBQ2QseUJBQXFCO0FBQ3JCLFdBQU8sTUFBTSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLEVBQy9DLENBQUM7QUFFRCxPQUFLLG1FQUFtRSxZQUFZO0FBQ2xGLG9CQUFnQixFQUFFLElBQUksUUFBUSxPQUFPLGVBQWUsUUFBUSxVQUFVLFlBQVksQ0FBQyxFQUFFLENBQUM7QUFDdEYsZ0JBQVksRUFBRSxJQUFJLE9BQU8sYUFBYSxRQUFRLE9BQU8sU0FBUyxRQUFRLFVBQVUsU0FBUyxDQUFDLEVBQUUsQ0FBQztBQUU3RixVQUFNLFFBQVEsTUFBTSxrQkFBa0IsSUFBSTtBQUUxQyxXQUFPLE1BQU0sTUFBTSxPQUFPLFVBQVU7QUFDcEMsV0FBTyxNQUFNLE1BQU0sWUFBWSxJQUFJO0FBQ25DLFdBQU87QUFBQSxNQUNMLE1BQU0sY0FBYztBQUFBLE1BQ3BCO0FBQUEsSUFDRjtBQUFBLEVBQ0YsQ0FBQztBQUNILENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
