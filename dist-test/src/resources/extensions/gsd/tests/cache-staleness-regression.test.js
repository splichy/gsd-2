import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveState, invalidateStateCache } from "../state.js";
import { invalidateAllCaches } from "../cache.js";
function createBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-cache-stale-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}
function cleanup(base) {
  rmSync(base, { recursive: true, force: true });
}
function writeMilestoneFile(base, mid, suffix, content) {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-${suffix}.md`), content);
}
function writeSliceFile(base, mid, sid, suffix, content) {
  const dir = join(base, ".gsd", "milestones", mid, "slices", sid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}-${suffix}.md`), content);
}
describe("cache-staleness-regression", () => {
  test("#1240: roadmap written after first derive \u2192 detected after invalidation", async () => {
    const base = createBase();
    try {
      writeMilestoneFile(base, "M001", "CONTEXT", "# M001: Test\n\nBuild a thing.\n");
      invalidateAllCaches();
      invalidateStateCache();
      const state1 = await deriveState(base);
      assert.strictEqual(state1.phase, "pre-planning", "initial: pre-planning (no roadmap)");
      const roadmap = [
        "# M001: Test",
        "",
        "## Slices",
        "",
        "- [ ] **S01: First Slice** `risk:low` `depends:[]`",
        "",
        "## Boundary Map",
        ""
      ].join("\n");
      writeMilestoneFile(base, "M001", "ROADMAP", roadmap);
      invalidateAllCaches();
      invalidateStateCache();
      const state2 = await deriveState(base);
      assert.strictEqual(state2.phase, "planning", "#1240: after roadmap write + invalidation \u2192 planning phase");
      assert.strictEqual(state2.activeSlice?.id, "S01", "#1240: S01 is now the active slice");
    } finally {
      cleanup(base);
    }
  });
  test("#1249: slice context written mid-loop \u2192 detected after invalidation", async () => {
    const base = createBase();
    try {
      const mDir = join(base, ".gsd", "milestones", "M001");
      mkdirSync(mDir, { recursive: true });
      writeFileSync(join(mDir, "M001-CONTEXT-DRAFT.md"), "# Draft\n\nSome ideas.\n");
      invalidateAllCaches();
      invalidateStateCache();
      const state1 = await deriveState(base);
      assert.strictEqual(state1.phase, "needs-discussion", "initial: needs-discussion");
      writeMilestoneFile(base, "M001", "CONTEXT", "# M001: Test\n\nFull context after discussion.\n");
      invalidateAllCaches();
      invalidateStateCache();
      const state2 = await deriveState(base);
      assert.ok(
        state2.phase !== "needs-discussion",
        "#1249: after context write + invalidation \u2192 not stuck in needs-discussion"
      );
    } finally {
      cleanup(base);
    }
  });
  test("state cache TTL: within window returns cached; past window re-derives", async () => {
    const base = createBase();
    try {
      writeMilestoneFile(base, "M001", "CONTEXT", "# M001\n\nDesc.\n");
      invalidateAllCaches();
      invalidateStateCache();
      const state1 = await deriveState(base);
      assert.strictEqual(state1.phase, "pre-planning", "initial: pre-planning");
      writeMilestoneFile(base, "M001", "ROADMAP", [
        "# M001: Test",
        "",
        "## Slices",
        "",
        "- [ ] **S01: Slice** `risk:low` `depends:[]`",
        ""
      ].join("\n"));
      const state2 = await deriveState(base);
      assert.strictEqual(state2.phase, "pre-planning", "within TTL: cached pre-planning is returned");
      await new Promise((r) => setTimeout(r, 150));
      invalidateAllCaches();
      const state3 = await deriveState(base);
      assert.strictEqual(state3.phase, "planning", "past TTL: re-derive sees new roadmap");
    } finally {
      cleanup(base);
    }
  });
  test("task marked done in plan \u2192 state advances", async () => {
    const base = createBase();
    try {
      writeMilestoneFile(base, "M001", "CONTEXT", "# M001\n\nDesc.\n");
      writeMilestoneFile(base, "M001", "ROADMAP", [
        "# M001: Test",
        "",
        "## Slices",
        "",
        "- [ ] **S01: Slice** `risk:low` `depends:[]`",
        ""
      ].join("\n"));
      writeSliceFile(base, "M001", "S01", "PLAN", [
        "# S01: Slice",
        "",
        "## Tasks",
        "",
        "- [ ] **T01: First Task** `est:1h`",
        "- [ ] **T02: Second Task** `est:1h`"
      ].join("\n"));
      const tasksDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
      mkdirSync(tasksDir, { recursive: true });
      writeFileSync(join(tasksDir, "T01-PLAN.md"), "# T01\nDo thing.");
      writeFileSync(join(tasksDir, "T02-PLAN.md"), "# T02\nDo other thing.");
      invalidateAllCaches();
      invalidateStateCache();
      const state1 = await deriveState(base);
      assert.strictEqual(state1.activeTask?.id, "T01", "initial: T01 is active task");
      writeSliceFile(base, "M001", "S01", "PLAN", [
        "# S01: Slice",
        "",
        "## Tasks",
        "",
        "- [x] **T01: First Task** `est:1h`",
        "- [ ] **T02: Second Task** `est:1h`"
      ].join("\n"));
      invalidateAllCaches();
      invalidateStateCache();
      const state2 = await deriveState(base);
      assert.strictEqual(state2.activeTask?.id, "T02", "after T01 done \u2192 T02 is active task");
    } finally {
      cleanup(base);
    }
  });
  test("all tasks done \u2192 summarizing phase", async () => {
    const base = createBase();
    try {
      writeMilestoneFile(base, "M001", "CONTEXT", "# M001\n\nDesc.\n");
      writeMilestoneFile(base, "M001", "ROADMAP", [
        "# M001: Test",
        "",
        "## Slices",
        "",
        "- [ ] **S01: First** `risk:low` `depends:[]`",
        "- [ ] **S02: Second** `risk:low` `depends:[S01]`",
        ""
      ].join("\n"));
      writeSliceFile(base, "M001", "S01", "PLAN", [
        "# S01",
        "",
        "## Tasks",
        "",
        "- [ ] **T01: Task** `est:1h`"
      ].join("\n"));
      const tasksDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
      mkdirSync(tasksDir, { recursive: true });
      writeFileSync(join(tasksDir, "T01-PLAN.md"), "# T01\nDo it.");
      invalidateAllCaches();
      invalidateStateCache();
      const state1 = await deriveState(base);
      assert.strictEqual(state1.phase, "executing", "initial: executing");
      writeSliceFile(base, "M001", "S01", "PLAN", [
        "# S01",
        "",
        "## Tasks",
        "",
        "- [x] **T01: Task** `est:1h`"
      ].join("\n"));
      invalidateAllCaches();
      invalidateStateCache();
      const state2 = await deriveState(base);
      assert.strictEqual(state2.phase, "summarizing", "after all tasks done \u2192 summarizing");
    } finally {
      cleanup(base);
    }
  });
  test("roadmap slice marked [x] \u2192 next slice active", async () => {
    const base = createBase();
    try {
      writeMilestoneFile(base, "M001", "CONTEXT", "# M001\n\nDesc.\n");
      writeMilestoneFile(base, "M001", "ROADMAP", [
        "# M001: Test",
        "",
        "## Slices",
        "",
        "- [ ] **S01: First** `risk:low` `depends:[]`",
        "- [ ] **S02: Second** `risk:low` `depends:[S01]`",
        ""
      ].join("\n"));
      invalidateAllCaches();
      invalidateStateCache();
      const state1 = await deriveState(base);
      assert.strictEqual(state1.activeSlice?.id, "S01", "initial: S01 active");
      writeMilestoneFile(base, "M001", "ROADMAP", [
        "# M001: Test",
        "",
        "## Slices",
        "",
        "- [x] **S01: First** `risk:low` `depends:[]`",
        "- [ ] **S02: Second** `risk:low` `depends:[S01]`",
        ""
      ].join("\n"));
      invalidateAllCaches();
      invalidateStateCache();
      const state2 = await deriveState(base);
      assert.strictEqual(state2.activeSlice?.id, "S02", "after S01 done \u2192 S02 active");
    } finally {
      cleanup(base);
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9jYWNoZS1zdGFsZW5lc3MtcmVncmVzc2lvbi50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIGNhY2hlLXN0YWxlbmVzcy1yZWdyZXNzaW9uLnRlc3QudHMgXHUyMDE0IFJlZ3Jlc3Npb24gdGVzdHMgZm9yIHN0YWxlIGNhY2hlIGJ1Z3MuXG4gKlxuICogVGhlIEdTRCBwYXJzZXIgY2FjaGVzIGFyZSBjcml0aWNhbCBmb3IgcGVyZm9ybWFuY2UgYnV0IGhhdmUgY2F1c2VkIG11bHRpcGxlXG4gKiBwcm9kdWN0aW9uIGJ1Z3Mgd2hlbiBub3QgaW52YWxpZGF0ZWQgYXQgdGhlIHJpZ2h0IHRpbWUuXG4gKlxuICogUmVncmVzc2lvbiBjb3ZlcmFnZSBmb3I6XG4gKiAgICMxMjQ5ICBTdGFsZSBjYWNoZXMgaW4gZGlzY3VzcyBsb29wIFx1MjE5MiBzbGljZSBhcHBlYXJzIFwibm90IGRpc2N1c3NlZFwiXG4gKiAgICMxMjQwICBTdGFsZSBjYWNoZXMgYWZ0ZXIgbWlsZXN0b25lIGNyZWF0aW9uIFx1MjE5MiBcIk5vIHJvYWRtYXAgeWV0XCJcbiAqICAgIzEyMzYgIFNhbWUgcm9vdCBjYXVzZSBhcyAjMTI0MFxuICpcbiAqIFBhdHRlcm46IGRlcml2ZSBzdGF0ZSBcdTIxOTIgd3JpdGUgZmlsZSBcdTIxOTIgaW52YWxpZGF0ZSBjYWNoZSBcdTIxOTIgZGVyaXZlIGFnYWluIFx1MjE5MiB2ZXJpZnkgdXBkYXRlXG4gKi9cblxuaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QsIGFmdGVyRWFjaCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgd3JpdGVGaWxlU3luYywgcm1TeW5jIH0gZnJvbSAnbm9kZTpmcyc7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJztcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gJ25vZGU6b3MnO1xuXG5pbXBvcnQgeyBkZXJpdmVTdGF0ZSwgaW52YWxpZGF0ZVN0YXRlQ2FjaGUgfSBmcm9tICcuLi9zdGF0ZS50cyc7XG5pbXBvcnQgeyBpbnZhbGlkYXRlQWxsQ2FjaGVzIH0gZnJvbSAnLi4vY2FjaGUudHMnO1xuXG5mdW5jdGlvbiBjcmVhdGVCYXNlKCk6IHN0cmluZyB7XG4gIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCAnZ3NkLWNhY2hlLXN0YWxlLScpKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgcmV0dXJuIGJhc2U7XG59XG5cbmZ1bmN0aW9uIGNsZWFudXAoYmFzZTogc3RyaW5nKTogdm9pZCB7XG4gIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG59XG5cbmZ1bmN0aW9uIHdyaXRlTWlsZXN0b25lRmlsZShiYXNlOiBzdHJpbmcsIG1pZDogc3RyaW5nLCBzdWZmaXg6IHN0cmluZywgY29udGVudDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGRpciA9IGpvaW4oYmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsIG1pZCk7XG4gIG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBgJHttaWR9LSR7c3VmZml4fS5tZGApLCBjb250ZW50KTtcbn1cblxuZnVuY3Rpb24gd3JpdGVTbGljZUZpbGUoYmFzZTogc3RyaW5nLCBtaWQ6IHN0cmluZywgc2lkOiBzdHJpbmcsIHN1ZmZpeDogc3RyaW5nLCBjb250ZW50OiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgZGlyID0gam9pbihiYXNlLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgbWlkLCAnc2xpY2VzJywgc2lkKTtcbiAgbWtkaXJTeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIGAke3NpZH0tJHtzdWZmaXh9Lm1kYCksIGNvbnRlbnQpO1xufVxuXG5kZXNjcmliZShcImNhY2hlLXN0YWxlbmVzcy1yZWdyZXNzaW9uXCIsICgpID0+IHtcblxuICB0ZXN0KFwiIzEyNDA6IHJvYWRtYXAgd3JpdHRlbiBhZnRlciBmaXJzdCBkZXJpdmUgXHUyMTkyIGRldGVjdGVkIGFmdGVyIGludmFsaWRhdGlvblwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgLy8gU3RlcCAxOiBDcmVhdGUgbWlsZXN0b25lIHdpdGgganVzdCBjb250ZXh0IChubyByb2FkbWFwKVxuICAgICAgd3JpdGVNaWxlc3RvbmVGaWxlKGJhc2UsICdNMDAxJywgJ0NPTlRFWFQnLCAnIyBNMDAxOiBUZXN0XFxuXFxuQnVpbGQgYSB0aGluZy5cXG4nKTtcblxuICAgICAgaW52YWxpZGF0ZUFsbENhY2hlcygpO1xuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IHN0YXRlMSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuICAgICAgYXNzZXJ0LnN0cmljdEVxdWFsKHN0YXRlMS5waGFzZSwgJ3ByZS1wbGFubmluZycsICdpbml0aWFsOiBwcmUtcGxhbm5pbmcgKG5vIHJvYWRtYXApJyk7XG5cbiAgICAgIC8vIFN0ZXAgMjogV3JpdGUgcm9hZG1hcCAoc2ltdWxhdGluZyB3aGF0IHRoZSBMTE0gZG9lcyBkdXJpbmcgcGxhbm5pbmcpXG4gICAgICBjb25zdCByb2FkbWFwID0gW1xuICAgICAgICAnIyBNMDAxOiBUZXN0JyxcbiAgICAgICAgJycsXG4gICAgICAgICcjIyBTbGljZXMnLFxuICAgICAgICAnJyxcbiAgICAgICAgJy0gWyBdICoqUzAxOiBGaXJzdCBTbGljZSoqIGByaXNrOmxvd2AgYGRlcGVuZHM6W11gJyxcbiAgICAgICAgJycsXG4gICAgICAgICcjIyBCb3VuZGFyeSBNYXAnLFxuICAgICAgICAnJyxcbiAgICAgIF0uam9pbignXFxuJyk7XG4gICAgICB3cml0ZU1pbGVzdG9uZUZpbGUoYmFzZSwgJ00wMDEnLCAnUk9BRE1BUCcsIHJvYWRtYXApO1xuXG4gICAgICAvLyBTdGVwIDM6IEV4cGxpY2l0IGludmFsaWRhdGlvbiBcdTIwMTQgdGhpcyBpcyB0aGUgIzEyNDAgZml4IHBhdGguIFdlXG4gICAgICAvLyBkbyBOT1QgcmVseSBvbiB0aGUgMTAwbXMgVFRMIGhlcmU7IHRoZSBwcm9kdWN0aW9uIGNvZGUgY2FsbHNcbiAgICAgIC8vIGludmFsaWRhdGVBbGxDYWNoZXMoKSAvIGludmFsaWRhdGVTdGF0ZUNhY2hlKCkgaW1tZWRpYXRlbHkgYWZ0ZXJcbiAgICAgIC8vIHdyaXRpbmcgcGxhbm5pbmcgZmlsZXMsIHNvIHRoZSBuZXh0IGRlcml2ZVN0YXRlKCkgbXVzdCBzZWUgdGhlXG4gICAgICAvLyBuZXcgcm9hZG1hcCB3aXRob3V0IGFueSB3YWxsLWNsb2NrIHdhaXQuXG4gICAgICBpbnZhbGlkYXRlQWxsQ2FjaGVzKCk7XG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUyID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG4gICAgICBhc3NlcnQuc3RyaWN0RXF1YWwoc3RhdGUyLnBoYXNlLCAncGxhbm5pbmcnLCAnIzEyNDA6IGFmdGVyIHJvYWRtYXAgd3JpdGUgKyBpbnZhbGlkYXRpb24gXHUyMTkyIHBsYW5uaW5nIHBoYXNlJyk7XG4gICAgICBhc3NlcnQuc3RyaWN0RXF1YWwoc3RhdGUyLmFjdGl2ZVNsaWNlPy5pZCwgJ1MwMScsICcjMTI0MDogUzAxIGlzIG5vdyB0aGUgYWN0aXZlIHNsaWNlJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwiIzEyNDk6IHNsaWNlIGNvbnRleHQgd3JpdHRlbiBtaWQtbG9vcCBcdTIxOTIgZGV0ZWN0ZWQgYWZ0ZXIgaW52YWxpZGF0aW9uXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICAvLyBDcmVhdGUgYSBtaWxlc3RvbmUgaW4gbmVlZHMtZGlzY3Vzc2lvbiBwaGFzZSAoQ09OVEVYVC1EUkFGVCwgbm8gQ09OVEVYVClcbiAgICAgIGNvbnN0IG1EaXIgPSBqb2luKGJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScpO1xuICAgICAgbWtkaXJTeW5jKG1EaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKG1EaXIsICdNMDAxLUNPTlRFWFQtRFJBRlQubWQnKSwgJyMgRHJhZnRcXG5cXG5Tb21lIGlkZWFzLlxcbicpO1xuXG4gICAgICBpbnZhbGlkYXRlQWxsQ2FjaGVzKCk7XG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUxID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG4gICAgICBhc3NlcnQuc3RyaWN0RXF1YWwoc3RhdGUxLnBoYXNlLCAnbmVlZHMtZGlzY3Vzc2lvbicsICdpbml0aWFsOiBuZWVkcy1kaXNjdXNzaW9uJyk7XG5cbiAgICAgIC8vIFNpbXVsYXRlOiBkaXNjdXNzaW9uIGNvbXBsZXRlcywgQ09OVEVYVC5tZCBpcyB3cml0dGVuXG4gICAgICB3cml0ZU1pbGVzdG9uZUZpbGUoYmFzZSwgJ00wMDEnLCAnQ09OVEVYVCcsICcjIE0wMDE6IFRlc3RcXG5cXG5GdWxsIGNvbnRleHQgYWZ0ZXIgZGlzY3Vzc2lvbi5cXG4nKTtcblxuICAgICAgLy8gRXhwbGljaXQgaW52YWxpZGF0aW9uIGlzIHRoZSBwcm9kdWN0aW9uIGZpeCBwYXRoIGZvciAjMTI0OSBcdTIwMTRcbiAgICAgIC8vIG5vIHdhbGwtY2xvY2sgd2FpdCBuZWVkZWQuXG4gICAgICBpbnZhbGlkYXRlQWxsQ2FjaGVzKCk7XG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUyID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG4gICAgICBhc3NlcnQub2soXG4gICAgICAgIHN0YXRlMi5waGFzZSAhPT0gJ25lZWRzLWRpc2N1c3Npb24nLFxuICAgICAgICAnIzEyNDk6IGFmdGVyIGNvbnRleHQgd3JpdGUgKyBpbnZhbGlkYXRpb24gXHUyMTkyIG5vdCBzdHVjayBpbiBuZWVkcy1kaXNjdXNzaW9uJyxcbiAgICAgICk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwic3RhdGUgY2FjaGUgVFRMOiB3aXRoaW4gd2luZG93IHJldHVybnMgY2FjaGVkOyBwYXN0IHdpbmRvdyByZS1kZXJpdmVzXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICB3cml0ZU1pbGVzdG9uZUZpbGUoYmFzZSwgJ00wMDEnLCAnQ09OVEVYVCcsICcjIE0wMDFcXG5cXG5EZXNjLlxcbicpO1xuXG4gICAgICBpbnZhbGlkYXRlQWxsQ2FjaGVzKCk7XG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUxID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG4gICAgICBhc3NlcnQuc3RyaWN0RXF1YWwoc3RhdGUxLnBoYXNlLCAncHJlLXBsYW5uaW5nJywgJ2luaXRpYWw6IHByZS1wbGFubmluZycpO1xuXG4gICAgICAvLyBXcml0ZSByb2FkbWFwIGltbWVkaWF0ZWx5IFx1MjAxNCBubyBpbnZhbGlkYXRpb25cbiAgICAgIHdyaXRlTWlsZXN0b25lRmlsZShiYXNlLCAnTTAwMScsICdST0FETUFQJywgW1xuICAgICAgICAnIyBNMDAxOiBUZXN0JyxcbiAgICAgICAgJycsXG4gICAgICAgICcjIyBTbGljZXMnLFxuICAgICAgICAnJyxcbiAgICAgICAgJy0gWyBdICoqUzAxOiBTbGljZSoqIGByaXNrOmxvd2AgYGRlcGVuZHM6W11gJyxcbiAgICAgICAgJycsXG4gICAgICBdLmpvaW4oJ1xcbicpKTtcblxuICAgICAgLy8gV2l0aGluIHRoZSBUVEwgd2luZG93LCBkZXJpdmVTdGF0ZSgpIG11c3QgcmV0dXJuIHRoZSBjYWNoZWRcbiAgICAgIC8vIHByZS1wbGFubmluZyBzdGF0ZSBcdTIwMTQgdGhpcyBpcyB0aGUgXCJjYWNoZWRcIiBoYWxmIG9mIHRoZSBUVExcbiAgICAgIC8vIGNvbnRyYWN0IGFuZCB0aGUgcmVhc29uIGludmFsaWRhdGVTdGF0ZUNhY2hlKCkgZXhpc3RzLlxuICAgICAgY29uc3Qgc3RhdGUyID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG4gICAgICBhc3NlcnQuc3RyaWN0RXF1YWwoc3RhdGUyLnBoYXNlLCAncHJlLXBsYW5uaW5nJywgJ3dpdGhpbiBUVEw6IGNhY2hlZCBwcmUtcGxhbm5pbmcgaXMgcmV0dXJuZWQnKTtcblxuICAgICAgLy8gUGFzdCB0aGUgVFRMICsgZXhwbGljaXQgcGFyc2UtY2FjaGUgZmx1c2gsIHRoZSBmcmVzaCBkZXJpdmUgbXVzdFxuICAgICAgLy8gc2VlIHRoZSBuZXcgcm9hZG1hcC4gaW52YWxpZGF0ZUFsbENhY2hlcygpIGlzIHJlcXVpcmVkIGJlY2F1c2VcbiAgICAgIC8vIHRoZSBmaWxlLXBhcnNlIGNhY2hlIGlzIGluZGVwZW5kZW50IG9mIHRoZSBzdGF0ZSBUVEwuXG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZShyID0+IHNldFRpbWVvdXQociwgMTUwKSk7XG4gICAgICBpbnZhbGlkYXRlQWxsQ2FjaGVzKCk7XG4gICAgICBjb25zdCBzdGF0ZTMgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcbiAgICAgIGFzc2VydC5zdHJpY3RFcXVhbChzdGF0ZTMucGhhc2UsICdwbGFubmluZycsICdwYXN0IFRUTDogcmUtZGVyaXZlIHNlZXMgbmV3IHJvYWRtYXAnKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJ0YXNrIG1hcmtlZCBkb25lIGluIHBsYW4gXHUyMTkyIHN0YXRlIGFkdmFuY2VzXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICB3cml0ZU1pbGVzdG9uZUZpbGUoYmFzZSwgJ00wMDEnLCAnQ09OVEVYVCcsICcjIE0wMDFcXG5cXG5EZXNjLlxcbicpO1xuICAgICAgd3JpdGVNaWxlc3RvbmVGaWxlKGJhc2UsICdNMDAxJywgJ1JPQURNQVAnLCBbXG4gICAgICAgICcjIE0wMDE6IFRlc3QnLFxuICAgICAgICAnJyxcbiAgICAgICAgJyMjIFNsaWNlcycsXG4gICAgICAgICcnLFxuICAgICAgICAnLSBbIF0gKipTMDE6IFNsaWNlKiogYHJpc2s6bG93YCBgZGVwZW5kczpbXWAnLFxuICAgICAgICAnJyxcbiAgICAgIF0uam9pbignXFxuJykpO1xuICAgICAgd3JpdGVTbGljZUZpbGUoYmFzZSwgJ00wMDEnLCAnUzAxJywgJ1BMQU4nLCBbXG4gICAgICAgICcjIFMwMTogU2xpY2UnLFxuICAgICAgICAnJyxcbiAgICAgICAgJyMjIFRhc2tzJyxcbiAgICAgICAgJycsXG4gICAgICAgICctIFsgXSAqKlQwMTogRmlyc3QgVGFzayoqIGBlc3Q6MWhgJyxcbiAgICAgICAgJy0gWyBdICoqVDAyOiBTZWNvbmQgVGFzayoqIGBlc3Q6MWhgJyxcbiAgICAgIF0uam9pbignXFxuJykpO1xuICAgICAgLy8gV3JpdGUgdGFzayBwbGFuIGZpbGVzXG4gICAgICBjb25zdCB0YXNrc0RpciA9IGpvaW4oYmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAxJywgJ3NsaWNlcycsICdTMDEnLCAndGFza3MnKTtcbiAgICAgIG1rZGlyU3luYyh0YXNrc0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4odGFza3NEaXIsICdUMDEtUExBTi5tZCcpLCAnIyBUMDFcXG5EbyB0aGluZy4nKTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbih0YXNrc0RpciwgJ1QwMi1QTEFOLm1kJyksICcjIFQwMlxcbkRvIG90aGVyIHRoaW5nLicpO1xuXG4gICAgICBpbnZhbGlkYXRlQWxsQ2FjaGVzKCk7XG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUxID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG4gICAgICBhc3NlcnQuc3RyaWN0RXF1YWwoc3RhdGUxLmFjdGl2ZVRhc2s/LmlkLCAnVDAxJywgJ2luaXRpYWw6IFQwMSBpcyBhY3RpdmUgdGFzaycpO1xuXG4gICAgICAvLyBNYXJrIFQwMSBhcyBkb25lIGJ5IHJld3JpdGluZyB0aGUgcGxhblxuICAgICAgd3JpdGVTbGljZUZpbGUoYmFzZSwgJ00wMDEnLCAnUzAxJywgJ1BMQU4nLCBbXG4gICAgICAgICcjIFMwMTogU2xpY2UnLFxuICAgICAgICAnJyxcbiAgICAgICAgJyMjIFRhc2tzJyxcbiAgICAgICAgJycsXG4gICAgICAgICctIFt4XSAqKlQwMTogRmlyc3QgVGFzayoqIGBlc3Q6MWhgJyxcbiAgICAgICAgJy0gWyBdICoqVDAyOiBTZWNvbmQgVGFzayoqIGBlc3Q6MWhgJyxcbiAgICAgIF0uam9pbignXFxuJykpO1xuXG4gICAgICBpbnZhbGlkYXRlQWxsQ2FjaGVzKCk7XG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUyID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG4gICAgICBhc3NlcnQuc3RyaWN0RXF1YWwoc3RhdGUyLmFjdGl2ZVRhc2s/LmlkLCAnVDAyJywgJ2FmdGVyIFQwMSBkb25lIFx1MjE5MiBUMDIgaXMgYWN0aXZlIHRhc2snKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJhbGwgdGFza3MgZG9uZSBcdTIxOTIgc3VtbWFyaXppbmcgcGhhc2VcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIHdyaXRlTWlsZXN0b25lRmlsZShiYXNlLCAnTTAwMScsICdDT05URVhUJywgJyMgTTAwMVxcblxcbkRlc2MuXFxuJyk7XG4gICAgICB3cml0ZU1pbGVzdG9uZUZpbGUoYmFzZSwgJ00wMDEnLCAnUk9BRE1BUCcsIFtcbiAgICAgICAgJyMgTTAwMTogVGVzdCcsXG4gICAgICAgICcnLFxuICAgICAgICAnIyMgU2xpY2VzJyxcbiAgICAgICAgJycsXG4gICAgICAgICctIFsgXSAqKlMwMTogRmlyc3QqKiBgcmlzazpsb3dgIGBkZXBlbmRzOltdYCcsXG4gICAgICAgICctIFsgXSAqKlMwMjogU2Vjb25kKiogYHJpc2s6bG93YCBgZGVwZW5kczpbUzAxXWAnLFxuICAgICAgICAnJyxcbiAgICAgIF0uam9pbignXFxuJykpO1xuICAgICAgd3JpdGVTbGljZUZpbGUoYmFzZSwgJ00wMDEnLCAnUzAxJywgJ1BMQU4nLCBbXG4gICAgICAgICcjIFMwMScsXG4gICAgICAgICcnLFxuICAgICAgICAnIyMgVGFza3MnLFxuICAgICAgICAnJyxcbiAgICAgICAgJy0gWyBdICoqVDAxOiBUYXNrKiogYGVzdDoxaGAnLFxuICAgICAgXS5qb2luKCdcXG4nKSk7XG4gICAgICBjb25zdCB0YXNrc0RpciA9IGpvaW4oYmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAxJywgJ3NsaWNlcycsICdTMDEnLCAndGFza3MnKTtcbiAgICAgIG1rZGlyU3luYyh0YXNrc0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4odGFza3NEaXIsICdUMDEtUExBTi5tZCcpLCAnIyBUMDFcXG5EbyBpdC4nKTtcblxuICAgICAgaW52YWxpZGF0ZUFsbENhY2hlcygpO1xuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IHN0YXRlMSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuICAgICAgYXNzZXJ0LnN0cmljdEVxdWFsKHN0YXRlMS5waGFzZSwgJ2V4ZWN1dGluZycsICdpbml0aWFsOiBleGVjdXRpbmcnKTtcblxuICAgICAgLy8gTWFyayB0YXNrIGRvbmVcbiAgICAgIHdyaXRlU2xpY2VGaWxlKGJhc2UsICdNMDAxJywgJ1MwMScsICdQTEFOJywgW1xuICAgICAgICAnIyBTMDEnLFxuICAgICAgICAnJyxcbiAgICAgICAgJyMjIFRhc2tzJyxcbiAgICAgICAgJycsXG4gICAgICAgICctIFt4XSAqKlQwMTogVGFzayoqIGBlc3Q6MWhgJyxcbiAgICAgIF0uam9pbignXFxuJykpO1xuXG4gICAgICBpbnZhbGlkYXRlQWxsQ2FjaGVzKCk7XG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUyID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG4gICAgICBhc3NlcnQuc3RyaWN0RXF1YWwoc3RhdGUyLnBoYXNlLCAnc3VtbWFyaXppbmcnLCAnYWZ0ZXIgYWxsIHRhc2tzIGRvbmUgXHUyMTkyIHN1bW1hcml6aW5nJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwicm9hZG1hcCBzbGljZSBtYXJrZWQgW3hdIFx1MjE5MiBuZXh0IHNsaWNlIGFjdGl2ZVwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgd3JpdGVNaWxlc3RvbmVGaWxlKGJhc2UsICdNMDAxJywgJ0NPTlRFWFQnLCAnIyBNMDAxXFxuXFxuRGVzYy5cXG4nKTtcbiAgICAgIHdyaXRlTWlsZXN0b25lRmlsZShiYXNlLCAnTTAwMScsICdST0FETUFQJywgW1xuICAgICAgICAnIyBNMDAxOiBUZXN0JyxcbiAgICAgICAgJycsXG4gICAgICAgICcjIyBTbGljZXMnLFxuICAgICAgICAnJyxcbiAgICAgICAgJy0gWyBdICoqUzAxOiBGaXJzdCoqIGByaXNrOmxvd2AgYGRlcGVuZHM6W11gJyxcbiAgICAgICAgJy0gWyBdICoqUzAyOiBTZWNvbmQqKiBgcmlzazpsb3dgIGBkZXBlbmRzOltTMDFdYCcsXG4gICAgICAgICcnLFxuICAgICAgXS5qb2luKCdcXG4nKSk7XG5cbiAgICAgIGludmFsaWRhdGVBbGxDYWNoZXMoKTtcbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBzdGF0ZTEgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcbiAgICAgIGFzc2VydC5zdHJpY3RFcXVhbChzdGF0ZTEuYWN0aXZlU2xpY2U/LmlkLCAnUzAxJywgJ2luaXRpYWw6IFMwMSBhY3RpdmUnKTtcblxuICAgICAgLy8gTWFyayBTMDEgYXMgZG9uZSBpbiByb2FkbWFwXG4gICAgICB3cml0ZU1pbGVzdG9uZUZpbGUoYmFzZSwgJ00wMDEnLCAnUk9BRE1BUCcsIFtcbiAgICAgICAgJyMgTTAwMTogVGVzdCcsXG4gICAgICAgICcnLFxuICAgICAgICAnIyMgU2xpY2VzJyxcbiAgICAgICAgJycsXG4gICAgICAgICctIFt4XSAqKlMwMTogRmlyc3QqKiBgcmlzazpsb3dgIGBkZXBlbmRzOltdYCcsXG4gICAgICAgICctIFsgXSAqKlMwMjogU2Vjb25kKiogYHJpc2s6bG93YCBgZGVwZW5kczpbUzAxXWAnLFxuICAgICAgICAnJyxcbiAgICAgIF0uam9pbignXFxuJykpO1xuXG4gICAgICBpbnZhbGlkYXRlQWxsQ2FjaGVzKCk7XG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUyID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG4gICAgICBhc3NlcnQuc3RyaWN0RXF1YWwoc3RhdGUyLmFjdGl2ZVNsaWNlPy5pZCwgJ1MwMicsICdhZnRlciBTMDEgZG9uZSBcdTIxOTIgUzAyIGFjdGl2ZScpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQWNBLFNBQVMsVUFBVSxZQUF1QjtBQUMxQyxPQUFPLFlBQVk7QUFDbkIsU0FBUyxhQUFhLFdBQVcsZUFBZSxjQUFjO0FBQzlELFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFFdkIsU0FBUyxhQUFhLDRCQUE0QjtBQUNsRCxTQUFTLDJCQUEyQjtBQUVwQyxTQUFTLGFBQXFCO0FBQzVCLFFBQU0sT0FBTyxZQUFZLEtBQUssT0FBTyxHQUFHLGtCQUFrQixDQUFDO0FBQzNELFlBQVUsS0FBSyxNQUFNLFFBQVEsWUFBWSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDL0QsU0FBTztBQUNUO0FBRUEsU0FBUyxRQUFRLE1BQW9CO0FBQ25DLFNBQU8sTUFBTSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUMvQztBQUVBLFNBQVMsbUJBQW1CLE1BQWMsS0FBYSxRQUFnQixTQUF1QjtBQUM1RixRQUFNLE1BQU0sS0FBSyxNQUFNLFFBQVEsY0FBYyxHQUFHO0FBQ2hELFlBQVUsS0FBSyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ2xDLGdCQUFjLEtBQUssS0FBSyxHQUFHLEdBQUcsSUFBSSxNQUFNLEtBQUssR0FBRyxPQUFPO0FBQ3pEO0FBRUEsU0FBUyxlQUFlLE1BQWMsS0FBYSxLQUFhLFFBQWdCLFNBQXVCO0FBQ3JHLFFBQU0sTUFBTSxLQUFLLE1BQU0sUUFBUSxjQUFjLEtBQUssVUFBVSxHQUFHO0FBQy9ELFlBQVUsS0FBSyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ2xDLGdCQUFjLEtBQUssS0FBSyxHQUFHLEdBQUcsSUFBSSxNQUFNLEtBQUssR0FBRyxPQUFPO0FBQ3pEO0FBRUEsU0FBUyw4QkFBOEIsTUFBTTtBQUUzQyxPQUFLLGdGQUEyRSxZQUFZO0FBQzFGLFVBQU0sT0FBTyxXQUFXO0FBQ3hCLFFBQUk7QUFFRix5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
