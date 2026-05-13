import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveStateFromDb, invalidateStateCache } from "../state.js";
import {
  openDatabase,
  closeDatabase,
  isDbAvailable,
  insertMilestone,
  insertSlice
} from "../gsd-db.js";
import { isDeferredStatus } from "../status-guards.js";
function createFixtureBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-deferred-dispatch-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}
function writeFile(base, relativePath, content) {
  const full = join(base, ".gsd", relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}
function cleanup(base) {
  rmSync(base, { recursive: true, force: true });
}
describe("deferred-slice-dispatch (#2661)", () => {
  test("isDeferredStatus returns true for 'deferred'", () => {
    assert.ok(isDeferredStatus("deferred"), "should recognize 'deferred'");
    assert.ok(!isDeferredStatus("active"), "should not match 'active'");
    assert.ok(!isDeferredStatus("complete"), "should not match 'complete'");
    assert.ok(!isDeferredStatus("pending"), "should not match 'pending'");
  });
  test("deriveStateFromDb skips deferred slice and picks next eligible", async () => {
    const base = createFixtureBase();
    try {
      openDatabase(":memory:");
      assert.ok(isDbAvailable());
      insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "Done Slice", status: "complete", risk: "low", depends: [] });
      insertSlice({ id: "S02", milestoneId: "M001", title: "Deferred Slice", status: "deferred", risk: "low", depends: [] });
      insertSlice({ id: "S03", milestoneId: "M001", title: "Next Slice", status: "pending", risk: "low", depends: [] });
      writeFile(base, "milestones/M001/M001-ROADMAP.md", `# M001: Test Milestone

**Vision:** Test deferred slices.

## Slices

- [x] **S01: Done Slice** \`risk:low\` \`depends:[]\`
  > Done.

- [ ] **S02: Deferred Slice** \`risk:low\` \`depends:[]\`
  > Deferred.

- [ ] **S03: Next Slice** \`risk:low\` \`depends:[]\`
  > Next.
`);
      writeFile(base, "milestones/M001/slices/S01/S01-SUMMARY.md", "# S01 Summary\nDone.");
      invalidateStateCache();
      const state = await deriveStateFromDb(base);
      assert.equal(state.activeMilestone?.id, "M001", "active milestone is M001");
      assert.equal(state.activeSlice?.id, "S03", "active slice should skip deferred S02 and land on S03");
      assert.notEqual(state.activeSlice?.id, "S02", "active slice must NOT be the deferred S02");
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("deriveStateFromDb does not count deferred slices as done for progress", async () => {
    const base = createFixtureBase();
    try {
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "Complete", status: "complete", risk: "low", depends: [] });
      insertSlice({ id: "S02", milestoneId: "M001", title: "Deferred", status: "deferred", risk: "low", depends: [] });
      insertSlice({ id: "S03", milestoneId: "M001", title: "Pending", status: "pending", risk: "low", depends: [] });
      writeFile(base, "milestones/M001/M001-ROADMAP.md", `# M001
## Slices
- [x] **S01: Complete** \`risk:low\` \`depends:[]\`
- [ ] **S02: Deferred** \`risk:low\` \`depends:[]\`
- [ ] **S03: Pending** \`risk:low\` \`depends:[]\`
`);
      writeFile(base, "milestones/M001/slices/S01/S01-SUMMARY.md", "# Done");
      invalidateStateCache();
      const state = await deriveStateFromDb(base);
      assert.equal(state.progress?.slices?.done, 1, "only 1 slice (S01) should be done");
      assert.equal(state.progress?.slices?.total, 3, "all 3 slices counted in total");
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("all slices deferred results in blocked state", async () => {
    const base = createFixtureBase();
    try {
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "Deferred A", status: "deferred", risk: "low", depends: [] });
      insertSlice({ id: "S02", milestoneId: "M001", title: "Deferred B", status: "deferred", risk: "low", depends: [] });
      writeFile(base, "milestones/M001/M001-ROADMAP.md", `# M001
## Slices
- [ ] **S01: Deferred A** \`risk:low\` \`depends:[]\`
- [ ] **S02: Deferred B** \`risk:low\` \`depends:[]\`
`);
      invalidateStateCache();
      const state = await deriveStateFromDb(base);
      assert.equal(state.activeSlice, null, "no active slice when all deferred");
      assert.equal(state.phase, "blocked", "phase should be blocked when all slices deferred");
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("saveDecisionToDb marks slice as deferred when decision is a deferral", async () => {
    const base = createFixtureBase();
    try {
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "Test", status: "active" });
      insertSlice({ id: "S03", milestoneId: "M001", title: "Target Slice", status: "active", risk: "low", depends: [] });
      writeFile(base, "milestones/M001/M001-ROADMAP.md", `# M001
## Slices
- [ ] **S03: Target Slice** \`risk:low\` \`depends:[]\`
`);
      const { saveDecisionToDb } = await import("../db-writer.js");
      const { getSlice } = await import("../gsd-db.js");
      await saveDecisionToDb(
        {
          scope: "deferral",
          decision: "Defer S03 to focus on higher priority work",
          choice: "defer M001/S03",
          rationale: "Not ready yet"
        },
        base
      );
      const slice = getSlice("M001", "S03");
      assert.equal(slice?.status, "deferred", "slice status should be updated to 'deferred' after deferral decision");
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9kZWZlcnJlZC1zbGljZS1kaXNwYXRjaC50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFJlZ3Jlc3Npb24gdGVzdCBmb3IgIzI2NjE6IEF1dG8tbW9kZSBkaXNwYXRjaGVzIGRlZmVycmVkIHNsaWNlcy5cbiAqXG4gKiBXaGVuIGEgZGVjaXNpb24gZGVmZXJzIGEgc2xpY2UsIHRoZSBkaXNwYXRjaGVyIG11c3Qgc2tpcCBpdCBhbmQgYWR2YW5jZVxuICogdG8gdGhlIG5leHQgZWxpZ2libGUgc2xpY2UuIFRoaXMgdGVzdHMgYm90aDpcbiAqICAgMS4gZGVyaXZlU3RhdGVGcm9tRGIgc2tpcHMgc2xpY2VzIHdpdGggc3RhdHVzIFwiZGVmZXJyZWRcIlxuICogICAyLiBzYXZlRGVjaXNpb25Ub0RiIHVwZGF0ZXMgdGhlIHNsaWNlIHN0YXR1cyB3aGVuIHRoZSBkZWNpc2lvbiBpcyBhIGRlZmVycmFsXG4gKi9cblxuaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBta2RpclN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcblxuaW1wb3J0IHsgZGVyaXZlU3RhdGVGcm9tRGIsIGludmFsaWRhdGVTdGF0ZUNhY2hlIH0gZnJvbSBcIi4uL3N0YXRlLnRzXCI7XG5pbXBvcnQge1xuICBvcGVuRGF0YWJhc2UsXG4gIGNsb3NlRGF0YWJhc2UsXG4gIGlzRGJBdmFpbGFibGUsXG4gIGluc2VydE1pbGVzdG9uZSxcbiAgaW5zZXJ0U2xpY2UsXG4gIGluc2VydFRhc2ssXG4gIGluc2VydEFydGlmYWN0LFxuICB1cGRhdGVTbGljZVN0YXR1cyxcbn0gZnJvbSBcIi4uL2dzZC1kYi50c1wiO1xuaW1wb3J0IHsgaXNEZWZlcnJlZFN0YXR1cyB9IGZyb20gXCIuLi9zdGF0dXMtZ3VhcmRzLnRzXCI7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBIZWxwZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBjcmVhdGVGaXh0dXJlQmFzZSgpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtZGVmZXJyZWQtZGlzcGF0Y2gtXCIpKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHJldHVybiBiYXNlO1xufVxuXG5mdW5jdGlvbiB3cml0ZUZpbGUoYmFzZTogc3RyaW5nLCByZWxhdGl2ZVBhdGg6IHN0cmluZywgY29udGVudDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGZ1bGwgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCByZWxhdGl2ZVBhdGgpO1xuICBta2RpclN5bmMoam9pbihmdWxsLCBcIi4uXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhmdWxsLCBjb250ZW50KTtcbn1cblxuZnVuY3Rpb24gY2xlYW51cChiYXNlOiBzdHJpbmcpOiB2b2lkIHtcbiAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRlc3RzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcImRlZmVycmVkLXNsaWNlLWRpc3BhdGNoICgjMjY2MSlcIiwgKCkgPT4ge1xuICB0ZXN0KFwiaXNEZWZlcnJlZFN0YXR1cyByZXR1cm5zIHRydWUgZm9yICdkZWZlcnJlZCdcIiwgKCkgPT4ge1xuICAgIGFzc2VydC5vayhpc0RlZmVycmVkU3RhdHVzKFwiZGVmZXJyZWRcIiksIFwic2hvdWxkIHJlY29nbml6ZSAnZGVmZXJyZWQnXCIpO1xuICAgIGFzc2VydC5vayghaXNEZWZlcnJlZFN0YXR1cyhcImFjdGl2ZVwiKSwgXCJzaG91bGQgbm90IG1hdGNoICdhY3RpdmUnXCIpO1xuICAgIGFzc2VydC5vayghaXNEZWZlcnJlZFN0YXR1cyhcImNvbXBsZXRlXCIpLCBcInNob3VsZCBub3QgbWF0Y2ggJ2NvbXBsZXRlJ1wiKTtcbiAgICBhc3NlcnQub2soIWlzRGVmZXJyZWRTdGF0dXMoXCJwZW5kaW5nXCIpLCBcInNob3VsZCBub3QgbWF0Y2ggJ3BlbmRpbmcnXCIpO1xuICB9KTtcblxuICB0ZXN0KFwiZGVyaXZlU3RhdGVGcm9tRGIgc2tpcHMgZGVmZXJyZWQgc2xpY2UgYW5kIHBpY2tzIG5leHQgZWxpZ2libGVcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBvcGVuRGF0YWJhc2UoXCI6bWVtb3J5OlwiKTtcbiAgICAgIGFzc2VydC5vayhpc0RiQXZhaWxhYmxlKCkpO1xuXG4gICAgICAvLyBNMDAxIHdpdGggdGhyZWUgc2xpY2VzOiBTMDEgY29tcGxldGUsIFMwMiBkZWZlcnJlZCwgUzAzIHBlbmRpbmdcbiAgICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdCBNaWxlc3RvbmVcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuXG4gICAgICBpbnNlcnRTbGljZSh7IGlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHRpdGxlOiBcIkRvbmUgU2xpY2VcIiwgc3RhdHVzOiBcImNvbXBsZXRlXCIsIHJpc2s6IFwibG93XCIsIGRlcGVuZHM6IFtdIH0pO1xuICAgICAgaW5zZXJ0U2xpY2UoeyBpZDogXCJTMDJcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJEZWZlcnJlZCBTbGljZVwiLCBzdGF0dXM6IFwiZGVmZXJyZWRcIiwgcmlzazogXCJsb3dcIiwgZGVwZW5kczogW10gfSk7XG4gICAgICBpbnNlcnRTbGljZSh7IGlkOiBcIlMwM1wiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHRpdGxlOiBcIk5leHQgU2xpY2VcIiwgc3RhdHVzOiBcInBlbmRpbmdcIiwgcmlzazogXCJsb3dcIiwgZGVwZW5kczogW10gfSk7XG5cbiAgICAgIC8vIFMwMSBuZWVkcyBhIFNVTU1BUlkgZmlsZSB0byBjb3VudCBhcyBjb21wbGV0ZSBmb3IgbWlsZXN0b25lLWxldmVsIGNoZWNrc1xuICAgICAgd3JpdGVGaWxlKGJhc2UsIFwibWlsZXN0b25lcy9NMDAxL00wMDEtUk9BRE1BUC5tZFwiLCBgIyBNMDAxOiBUZXN0IE1pbGVzdG9uZVxuXG4qKlZpc2lvbjoqKiBUZXN0IGRlZmVycmVkIHNsaWNlcy5cblxuIyMgU2xpY2VzXG5cbi0gW3hdICoqUzAxOiBEb25lIFNsaWNlKiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbXVxcYFxuICA+IERvbmUuXG5cbi0gWyBdICoqUzAyOiBEZWZlcnJlZCBTbGljZSoqIFxcYHJpc2s6bG93XFxgIFxcYGRlcGVuZHM6W11cXGBcbiAgPiBEZWZlcnJlZC5cblxuLSBbIF0gKipTMDM6IE5leHQgU2xpY2UqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgXG4gID4gTmV4dC5cbmApO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsIFwibWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvUzAxLVNVTU1BUlkubWRcIiwgXCIjIFMwMSBTdW1tYXJ5XFxuRG9uZS5cIik7XG5cbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlRnJvbURiKGJhc2UpO1xuXG4gICAgICAvLyBUaGUgYWN0aXZlIHNsaWNlIG11c3QgYmUgUzAzLCBOT1QgUzAyICh3aGljaCBpcyBkZWZlcnJlZClcbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5hY3RpdmVNaWxlc3RvbmU/LmlkLCBcIk0wMDFcIiwgXCJhY3RpdmUgbWlsZXN0b25lIGlzIE0wMDFcIik7XG4gICAgICBhc3NlcnQuZXF1YWwoc3RhdGUuYWN0aXZlU2xpY2U/LmlkLCBcIlMwM1wiLCBcImFjdGl2ZSBzbGljZSBzaG91bGQgc2tpcCBkZWZlcnJlZCBTMDIgYW5kIGxhbmQgb24gUzAzXCIpO1xuICAgICAgYXNzZXJ0Lm5vdEVxdWFsKHN0YXRlLmFjdGl2ZVNsaWNlPy5pZCwgXCJTMDJcIiwgXCJhY3RpdmUgc2xpY2UgbXVzdCBOT1QgYmUgdGhlIGRlZmVycmVkIFMwMlwiKTtcblxuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcImRlcml2ZVN0YXRlRnJvbURiIGRvZXMgbm90IGNvdW50IGRlZmVycmVkIHNsaWNlcyBhcyBkb25lIGZvciBwcm9ncmVzc1wiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIG9wZW5EYXRhYmFzZShcIjptZW1vcnk6XCIpO1xuXG4gICAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuICAgICAgaW5zZXJ0U2xpY2UoeyBpZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJDb21wbGV0ZVwiLCBzdGF0dXM6IFwiY29tcGxldGVcIiwgcmlzazogXCJsb3dcIiwgZGVwZW5kczogW10gfSk7XG4gICAgICBpbnNlcnRTbGljZSh7IGlkOiBcIlMwMlwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHRpdGxlOiBcIkRlZmVycmVkXCIsIHN0YXR1czogXCJkZWZlcnJlZFwiLCByaXNrOiBcImxvd1wiLCBkZXBlbmRzOiBbXSB9KTtcbiAgICAgIGluc2VydFNsaWNlKHsgaWQ6IFwiUzAzXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiUGVuZGluZ1wiLCBzdGF0dXM6IFwicGVuZGluZ1wiLCByaXNrOiBcImxvd1wiLCBkZXBlbmRzOiBbXSB9KTtcblxuICAgICAgd3JpdGVGaWxlKGJhc2UsIFwibWlsZXN0b25lcy9NMDAxL00wMDEtUk9BRE1BUC5tZFwiLCBgIyBNMDAxXG4jIyBTbGljZXNcbi0gW3hdICoqUzAxOiBDb21wbGV0ZSoqIFxcYHJpc2s6bG93XFxgIFxcYGRlcGVuZHM6W11cXGBcbi0gWyBdICoqUzAyOiBEZWZlcnJlZCoqIFxcYHJpc2s6bG93XFxgIFxcYGRlcGVuZHM6W11cXGBcbi0gWyBdICoqUzAzOiBQZW5kaW5nKiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbXVxcYFxuYCk7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgXCJtaWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMS9TMDEtU1VNTUFSWS5tZFwiLCBcIiMgRG9uZVwiKTtcblxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGVGcm9tRGIoYmFzZSk7XG5cbiAgICAgIC8vIERlZmVycmVkIHNsaWNlcyBzaG91bGQgbm90IGNvdW50IGFzIFwiZG9uZVwiIGluIHByb2dyZXNzXG4gICAgICAvLyBPbmx5IFMwMSAoY29tcGxldGUpIGNvdW50cyBhcyBkb25lXG4gICAgICBhc3NlcnQuZXF1YWwoc3RhdGUucHJvZ3Jlc3M/LnNsaWNlcz8uZG9uZSwgMSwgXCJvbmx5IDEgc2xpY2UgKFMwMSkgc2hvdWxkIGJlIGRvbmVcIik7XG4gICAgICAvLyBUb3RhbCBzaG91bGQgc3RpbGwgYmUgMyAoZGVmZXJyZWQgc2xpY2VzIGFyZSBzdGlsbCBwYXJ0IG9mIHRoZSBtaWxlc3RvbmUpXG4gICAgICBhc3NlcnQuZXF1YWwoc3RhdGUucHJvZ3Jlc3M/LnNsaWNlcz8udG90YWwsIDMsIFwiYWxsIDMgc2xpY2VzIGNvdW50ZWQgaW4gdG90YWxcIik7XG5cbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJhbGwgc2xpY2VzIGRlZmVycmVkIHJlc3VsdHMgaW4gYmxvY2tlZCBzdGF0ZVwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIG9wZW5EYXRhYmFzZShcIjptZW1vcnk6XCIpO1xuXG4gICAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuICAgICAgaW5zZXJ0U2xpY2UoeyBpZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJEZWZlcnJlZCBBXCIsIHN0YXR1czogXCJkZWZlcnJlZFwiLCByaXNrOiBcImxvd1wiLCBkZXBlbmRzOiBbXSB9KTtcbiAgICAgIGluc2VydFNsaWNlKHsgaWQ6IFwiUzAyXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiRGVmZXJyZWQgQlwiLCBzdGF0dXM6IFwiZGVmZXJyZWRcIiwgcmlzazogXCJsb3dcIiwgZGVwZW5kczogW10gfSk7XG5cbiAgICAgIHdyaXRlRmlsZShiYXNlLCBcIm1pbGVzdG9uZXMvTTAwMS9NMDAxLVJPQURNQVAubWRcIiwgYCMgTTAwMVxuIyMgU2xpY2VzXG4tIFsgXSAqKlMwMTogRGVmZXJyZWQgQSoqIFxcYHJpc2s6bG93XFxgIFxcYGRlcGVuZHM6W11cXGBcbi0gWyBdICoqUzAyOiBEZWZlcnJlZCBCKiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbXVxcYFxuYCk7XG5cbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlRnJvbURiKGJhc2UpO1xuXG4gICAgICAvLyBObyBlbGlnaWJsZSBzbGljZSBcdTIwMTQgc2hvdWxkIGJlIGJsb2NrZWRcbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5hY3RpdmVTbGljZSwgbnVsbCwgXCJubyBhY3RpdmUgc2xpY2Ugd2hlbiBhbGwgZGVmZXJyZWRcIik7XG4gICAgICBhc3NlcnQuZXF1YWwoc3RhdGUucGhhc2UsIFwiYmxvY2tlZFwiLCBcInBoYXNlIHNob3VsZCBiZSBibG9ja2VkIHdoZW4gYWxsIHNsaWNlcyBkZWZlcnJlZFwiKTtcblxuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcInNhdmVEZWNpc2lvblRvRGIgbWFya3Mgc2xpY2UgYXMgZGVmZXJyZWQgd2hlbiBkZWNpc2lvbiBpcyBhIGRlZmVycmFsXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgb3BlbkRhdGFiYXNlKFwiOm1lbW9yeTpcIik7XG5cbiAgICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdFwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSk7XG4gICAgICBpbnNlcnRTbGljZSh7IGlkOiBcIlMwM1wiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRhcmdldCBTbGljZVwiLCBzdGF0dXM6IFwiYWN0aXZlXCIsIHJpc2s6IFwibG93XCIsIGRlcGVuZHM6IFtdIH0pO1xuXG4gICAgICB3cml0ZUZpbGUoYmFzZSwgXCJtaWxlc3RvbmVzL00wMDEvTTAwMS1ST0FETUFQLm1kXCIsIGAjIE0wMDFcbiMjIFNsaWNlc1xuLSBbIF0gKipTMDM6IFRhcmdldCBTbGljZSoqIFxcYHJpc2s6bG93XFxgIFxcYGRlcGVuZHM6W11cXGBcbmApO1xuXG4gICAgICBjb25zdCB7IHNhdmVEZWNpc2lvblRvRGIgfSA9IGF3YWl0IGltcG9ydChcIi4uL2RiLXdyaXRlci50c1wiKTtcbiAgICAgIGNvbnN0IHsgZ2V0U2xpY2UgfSA9IGF3YWl0IGltcG9ydChcIi4uL2dzZC1kYi50c1wiKTtcblxuICAgICAgLy8gU2F2ZSBhIGRlZmVycmFsIGRlY2lzaW9uIHRoYXQgcmVmZXJlbmNlcyBNMDAxL1MwM1xuICAgICAgYXdhaXQgc2F2ZURlY2lzaW9uVG9EYihcbiAgICAgICAge1xuICAgICAgICAgIHNjb3BlOiBcImRlZmVycmFsXCIsXG4gICAgICAgICAgZGVjaXNpb246IFwiRGVmZXIgUzAzIHRvIGZvY3VzIG9uIGhpZ2hlciBwcmlvcml0eSB3b3JrXCIsXG4gICAgICAgICAgY2hvaWNlOiBcImRlZmVyIE0wMDEvUzAzXCIsXG4gICAgICAgICAgcmF0aW9uYWxlOiBcIk5vdCByZWFkeSB5ZXRcIixcbiAgICAgICAgfSxcbiAgICAgICAgYmFzZSxcbiAgICAgICk7XG5cbiAgICAgIC8vIFRoZSBzbGljZSBzdGF0dXMgc2hvdWxkIG5vdyBiZSBcImRlZmVycmVkXCJcbiAgICAgIGNvbnN0IHNsaWNlID0gZ2V0U2xpY2UoXCJNMDAxXCIsIFwiUzAzXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHNsaWNlPy5zdGF0dXMsIFwiZGVmZXJyZWRcIiwgXCJzbGljZSBzdGF0dXMgc2hvdWxkIGJlIHVwZGF0ZWQgdG8gJ2RlZmVycmVkJyBhZnRlciBkZWZlcnJhbCBkZWNpc2lvblwiKTtcblxuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQVNBLFNBQVMsVUFBVSxZQUFZO0FBQy9CLE9BQU8sWUFBWTtBQUNuQixTQUFTLGFBQWEsV0FBVyxRQUFRLHFCQUFxQjtBQUM5RCxTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBRXZCLFNBQVMsbUJBQW1CLDRCQUE0QjtBQUN4RDtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FJSztB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
