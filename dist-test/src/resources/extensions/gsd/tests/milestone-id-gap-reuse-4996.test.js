import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isReusableGhostMilestone } from "../state.js";
import { nextMilestoneIdReserved } from "../milestone-id-reservation.js";
import {
  openDatabase,
  closeDatabase,
  insertMilestone
} from "../gsd-db.js";
import { clearReservedMilestoneIds, findMilestoneIds } from "../milestone-ids.js";
import { invalidateAllCaches } from "../cache.js";
function makeBase(prefix = "gsd-gap-4996-") {
  const base = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}
function stubDir(base, mid) {
  mkdirSync(join(base, ".gsd", "milestones", mid, "slices"), { recursive: true });
}
function populateDir(base, mid) {
  mkdirSync(join(base, ".gsd", "milestones", mid), { recursive: true });
  writeFileSync(join(base, ".gsd", "milestones", mid, `${mid}-CONTEXT.md`), `# ${mid} Context
`);
}
describe("isReusableGhostMilestone (#4996)", () => {
  let base;
  afterEach(() => {
    try {
      closeDatabase();
    } catch {
    }
    try {
      invalidateAllCaches();
    } catch {
    }
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  it("(a) fails closed when the DB is unavailable", () => {
    base = makeBase();
    stubDir(base, "M003");
    assert.equal(isReusableGhostMilestone(base, "M003"), false, "closed DB should block reusable-ghost claims");
  });
  it("(b) empty stub dir with an open DB and no DB row is reusable", () => {
    base = makeBase();
    openDatabase(join(base, ".gsd", "gsd.db"));
    stubDir(base, "M003");
    assert.ok(isReusableGhostMilestone(base, "M003"), "empty stub with no DB row should be reusable");
  });
  it("(c) queued DB row with no content must NOT be reusable (race window regression)", () => {
    base = makeBase();
    stubDir(base, "M003");
    const dbPath = join(base, ".gsd", "gsd.db");
    openDatabase(dbPath);
    insertMilestone({ id: "M003", status: "queued" });
    assert.ok(!isReusableGhostMilestone(base, "M003"), "queued DB row must block reuse");
  });
  it("(d) populated milestone dir is not reusable", () => {
    base = makeBase();
    openDatabase(join(base, ".gsd", "gsd.db"));
    populateDir(base, "M001");
    assert.ok(!isReusableGhostMilestone(base, "M001"), "populated dir must not be reusable");
  });
  it("(e) stub dir with worktree is not reusable (legitimate in-flight)", () => {
    base = makeBase();
    openDatabase(join(base, ".gsd", "gsd.db"));
    stubDir(base, "M003");
    mkdirSync(join(base, ".gsd", "worktrees", "M003"), { recursive: true });
    assert.ok(!isReusableGhostMilestone(base, "M003"), "dir with worktree must not be reusable");
  });
  it("(f) active DB row makes dir not reusable", () => {
    base = makeBase();
    stubDir(base, "M003");
    const dbPath = join(base, ".gsd", "gsd.db");
    openDatabase(dbPath);
    insertMilestone({ id: "M003", status: "active" });
    assert.ok(!isReusableGhostMilestone(base, "M003"), "active DB row must block reuse");
  });
});
describe("primary regression: M003/M004 stubs returned as next ID (#4996)", () => {
  let base;
  beforeEach(() => {
    clearReservedMilestoneIds();
  });
  afterEach(() => {
    try {
      closeDatabase();
    } catch {
    }
    try {
      invalidateAllCaches();
    } catch {
    }
    try {
      clearReservedMilestoneIds();
    } catch {
    }
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  it("M001/M002 populated + M003/M004 stubs \u2192 isReusableGhostMilestone returns true for M003 and M004", () => {
    base = makeBase();
    openDatabase(join(base, ".gsd", "gsd.db"));
    populateDir(base, "M001");
    populateDir(base, "M002");
    stubDir(base, "M003");
    stubDir(base, "M004");
    assert.ok(isReusableGhostMilestone(base, "M003"), "M003 should be identified as reusable ghost");
    assert.ok(isReusableGhostMilestone(base, "M004"), "M004 should be identified as reusable ghost");
    assert.ok(!isReusableGhostMilestone(base, "M001"), "M001 should not be reusable");
    assert.ok(!isReusableGhostMilestone(base, "M002"), "M002 should not be reusable");
    const nextId = nextMilestoneIdReserved(findMilestoneIds(base), false, base);
    assert.equal(nextId, "M003", "ID reservation should select the lowest reusable ghost");
  });
  it("when all dirs are populated, no ghost exists and the function returns false for all", () => {
    base = makeBase();
    openDatabase(join(base, ".gsd", "gsd.db"));
    populateDir(base, "M001");
    populateDir(base, "M002");
    assert.ok(!isReusableGhostMilestone(base, "M001"), "M001 is populated, not reusable");
    assert.ok(!isReusableGhostMilestone(base, "M002"), "M002 is populated, not reusable");
    const nextId = nextMilestoneIdReserved(findMilestoneIds(base), false, base);
    assert.equal(nextId, "M003", "ID reservation should fall back to max+1 when no ghost is reusable");
  });
  it("does not return an already-reserved reusable ghost twice", () => {
    base = makeBase();
    openDatabase(join(base, ".gsd", "gsd.db"));
    stubDir(base, "M001");
    const firstId = nextMilestoneIdReserved(findMilestoneIds(base), false, base);
    const secondId = nextMilestoneIdReserved(findMilestoneIds(base), false, base);
    assert.equal(firstId, "M001", "first reservation should reuse the ghost");
    assert.equal(secondId, "M002", "second reservation must skip the already-reserved ghost");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9taWxlc3RvbmUtaWQtZ2FwLXJldXNlLTQ5OTYudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NEIEV4dGVuc2lvbiBcdTIwMTQgUmVncmVzc2lvbiB0ZXN0IGZvciAjNDk5NjogZ2hvc3QgbWlsZXN0b25lIElEIHJldXNlXG4vLyBWZXJpZmllcyB0aGF0IGlzUmV1c2FibGVHaG9zdE1pbGVzdG9uZSBjb3JyZWN0bHkgaWRlbnRpZmllcyByZWNsYWltLXNhZmUgc3R1YiBkaXJzLFxuLy8gYW5kIHRoYXQgbmV4dE1pbGVzdG9uZUlkUmVzZXJ2ZWQgKGd1aWRlZC1mbG93KSBwcmVmZXJzIHRoZSBsb3dlc3QgcmV1c2FibGUgZ2hvc3Rcbi8vIG92ZXIgbWF4KzEuIEFsc28gY292ZXJzIHRoZSByYWNlLXdpbmRvdyByZWdyZXNzaW9uOiBhIHF1ZXVlZCBEQiByb3cgbXVzdCBOT1QgYmUgcmV1c2VkLlxuXG5pbXBvcnQgeyBkZXNjcmliZSwgaXQsIGJlZm9yZUVhY2gsIGFmdGVyRWFjaCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgd3JpdGVGaWxlU3luYywgcm1TeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuXG5pbXBvcnQgeyBpc1JldXNhYmxlR2hvc3RNaWxlc3RvbmUgfSBmcm9tIFwiLi4vc3RhdGUudHNcIjtcbmltcG9ydCB7IG5leHRNaWxlc3RvbmVJZFJlc2VydmVkIH0gZnJvbSBcIi4uL21pbGVzdG9uZS1pZC1yZXNlcnZhdGlvbi50c1wiO1xuaW1wb3J0IHtcbiAgb3BlbkRhdGFiYXNlLFxuICBjbG9zZURhdGFiYXNlLFxuICBpbnNlcnRNaWxlc3RvbmUsXG59IGZyb20gXCIuLi9nc2QtZGIudHNcIjtcbmltcG9ydCB7IGNsZWFyUmVzZXJ2ZWRNaWxlc3RvbmVJZHMsIGZpbmRNaWxlc3RvbmVJZHMgfSBmcm9tIFwiLi4vbWlsZXN0b25lLWlkcy50c1wiO1xuaW1wb3J0IHsgaW52YWxpZGF0ZUFsbENhY2hlcyB9IGZyb20gXCIuLi9jYWNoZS50c1wiO1xuXG5mdW5jdGlvbiBtYWtlQmFzZShwcmVmaXggPSBcImdzZC1nYXAtNDk5Ni1cIik6IHN0cmluZyB7XG4gIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBwcmVmaXgpKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHJldHVybiBiYXNlO1xufVxuXG5mdW5jdGlvbiBzdHViRGlyKGJhc2U6IHN0cmluZywgbWlkOiBzdHJpbmcpOiB2b2lkIHtcbiAgLy8gQ3JlYXRlIGFuIGVtcHR5IHN0dWIgXHUyMDE0IHRoZSBwaGFudG9tIHBhdHRlcm5cbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBtaWQsIFwic2xpY2VzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbn1cblxuZnVuY3Rpb24gcG9wdWxhdGVEaXIoYmFzZTogc3RyaW5nLCBtaWQ6IHN0cmluZyk6IHZvaWQge1xuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIG1pZCksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBtaWQsIGAke21pZH0tQ09OVEVYVC5tZGApLCBgIyAke21pZH0gQ29udGV4dFxcbmApO1xufVxuXG5kZXNjcmliZShcImlzUmV1c2FibGVHaG9zdE1pbGVzdG9uZSAoIzQ5OTYpXCIsICgpID0+IHtcbiAgbGV0IGJhc2U6IHN0cmluZztcblxuICBhZnRlckVhY2goKCkgPT4ge1xuICAgIHRyeSB7IGNsb3NlRGF0YWJhc2UoKTsgfSBjYXRjaCB7IC8qIGlnbm9yZSAqLyB9XG4gICAgdHJ5IHsgaW52YWxpZGF0ZUFsbENhY2hlcygpOyB9IGNhdGNoIHsgLyogaWdub3JlICovIH1cbiAgICB0cnkgeyBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pOyB9IGNhdGNoIHsgLyogaWdub3JlICovIH1cbiAgfSk7XG5cbiAgaXQoXCIoYSkgZmFpbHMgY2xvc2VkIHdoZW4gdGhlIERCIGlzIHVuYXZhaWxhYmxlXCIsICgpID0+IHtcbiAgICBiYXNlID0gbWFrZUJhc2UoKTtcbiAgICBzdHViRGlyKGJhc2UsIFwiTTAwM1wiKTtcbiAgICBhc3NlcnQuZXF1YWwoaXNSZXVzYWJsZUdob3N0TWlsZXN0b25lKGJhc2UsIFwiTTAwM1wiKSwgZmFsc2UsIFwiY2xvc2VkIERCIHNob3VsZCBibG9jayByZXVzYWJsZS1naG9zdCBjbGFpbXNcIik7XG4gIH0pO1xuXG4gIGl0KFwiKGIpIGVtcHR5IHN0dWIgZGlyIHdpdGggYW4gb3BlbiBEQiBhbmQgbm8gREIgcm93IGlzIHJldXNhYmxlXCIsICgpID0+IHtcbiAgICBiYXNlID0gbWFrZUJhc2UoKTtcbiAgICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJnc2QuZGJcIikpO1xuICAgIHN0dWJEaXIoYmFzZSwgXCJNMDAzXCIpO1xuICAgIGFzc2VydC5vayhpc1JldXNhYmxlR2hvc3RNaWxlc3RvbmUoYmFzZSwgXCJNMDAzXCIpLCBcImVtcHR5IHN0dWIgd2l0aCBubyBEQiByb3cgc2hvdWxkIGJlIHJldXNhYmxlXCIpO1xuICB9KTtcblxuICBpdChcIihjKSBxdWV1ZWQgREIgcm93IHdpdGggbm8gY29udGVudCBtdXN0IE5PVCBiZSByZXVzYWJsZSAocmFjZSB3aW5kb3cgcmVncmVzc2lvbilcIiwgKCkgPT4ge1xuICAgIGJhc2UgPSBtYWtlQmFzZSgpO1xuICAgIHN0dWJEaXIoYmFzZSwgXCJNMDAzXCIpO1xuICAgIGNvbnN0IGRiUGF0aCA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiZ3NkLmRiXCIpO1xuICAgIG9wZW5EYXRhYmFzZShkYlBhdGgpO1xuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDNcIiwgc3RhdHVzOiBcInF1ZXVlZFwiIH0pO1xuICAgIC8vIEV2ZW4gdGhvdWdoIG5vIGNvbnRlbnQgZmlsZXMgZXhpc3QsIHRoZSBxdWV1ZWQgREIgcm93IG1lYW5zIGFuIGluLWZsaWdodCBkaXNjdXNzXG4gICAgLy8gaXMgcmVzZXJ2aW5nIHRoaXMgSUQgXHUyMDE0IGl0IG11c3Qgbm90IGJlIHJlY2xhaW1lZC5cbiAgICBhc3NlcnQub2soIWlzUmV1c2FibGVHaG9zdE1pbGVzdG9uZShiYXNlLCBcIk0wMDNcIiksIFwicXVldWVkIERCIHJvdyBtdXN0IGJsb2NrIHJldXNlXCIpO1xuICB9KTtcblxuICBpdChcIihkKSBwb3B1bGF0ZWQgbWlsZXN0b25lIGRpciBpcyBub3QgcmV1c2FibGVcIiwgKCkgPT4ge1xuICAgIGJhc2UgPSBtYWtlQmFzZSgpO1xuICAgIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsIFwiLmdzZFwiLCBcImdzZC5kYlwiKSk7XG4gICAgcG9wdWxhdGVEaXIoYmFzZSwgXCJNMDAxXCIpO1xuICAgIGFzc2VydC5vayghaXNSZXVzYWJsZUdob3N0TWlsZXN0b25lKGJhc2UsIFwiTTAwMVwiKSwgXCJwb3B1bGF0ZWQgZGlyIG11c3Qgbm90IGJlIHJldXNhYmxlXCIpO1xuICB9KTtcblxuICBpdChcIihlKSBzdHViIGRpciB3aXRoIHdvcmt0cmVlIGlzIG5vdCByZXVzYWJsZSAobGVnaXRpbWF0ZSBpbi1mbGlnaHQpXCIsICgpID0+IHtcbiAgICBiYXNlID0gbWFrZUJhc2UoKTtcbiAgICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJnc2QuZGJcIikpO1xuICAgIHN0dWJEaXIoYmFzZSwgXCJNMDAzXCIpO1xuICAgIC8vIFNpbXVsYXRlIGFuIGV4aXN0aW5nIHdvcmt0cmVlXG4gICAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwid29ya3RyZWVzXCIsIFwiTTAwM1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgYXNzZXJ0Lm9rKCFpc1JldXNhYmxlR2hvc3RNaWxlc3RvbmUoYmFzZSwgXCJNMDAzXCIpLCBcImRpciB3aXRoIHdvcmt0cmVlIG11c3Qgbm90IGJlIHJldXNhYmxlXCIpO1xuICB9KTtcblxuICBpdChcIihmKSBhY3RpdmUgREIgcm93IG1ha2VzIGRpciBub3QgcmV1c2FibGVcIiwgKCkgPT4ge1xuICAgIGJhc2UgPSBtYWtlQmFzZSgpO1xuICAgIHN0dWJEaXIoYmFzZSwgXCJNMDAzXCIpO1xuICAgIGNvbnN0IGRiUGF0aCA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiZ3NkLmRiXCIpO1xuICAgIG9wZW5EYXRhYmFzZShkYlBhdGgpO1xuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDNcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuICAgIGFzc2VydC5vayghaXNSZXVzYWJsZUdob3N0TWlsZXN0b25lKGJhc2UsIFwiTTAwM1wiKSwgXCJhY3RpdmUgREIgcm93IG11c3QgYmxvY2sgcmV1c2VcIik7XG4gIH0pO1xufSk7XG5cbmRlc2NyaWJlKFwicHJpbWFyeSByZWdyZXNzaW9uOiBNMDAzL00wMDQgc3R1YnMgcmV0dXJuZWQgYXMgbmV4dCBJRCAoIzQ5OTYpXCIsICgpID0+IHtcbiAgbGV0IGJhc2U6IHN0cmluZztcblxuICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICBjbGVhclJlc2VydmVkTWlsZXN0b25lSWRzKCk7XG4gIH0pO1xuXG4gIGFmdGVyRWFjaCgoKSA9PiB7XG4gICAgdHJ5IHsgY2xvc2VEYXRhYmFzZSgpOyB9IGNhdGNoIHsgLyogaWdub3JlICovIH1cbiAgICB0cnkgeyBpbnZhbGlkYXRlQWxsQ2FjaGVzKCk7IH0gY2F0Y2ggeyAvKiBpZ25vcmUgKi8gfVxuICAgIHRyeSB7IGNsZWFyUmVzZXJ2ZWRNaWxlc3RvbmVJZHMoKTsgfSBjYXRjaCB7IC8qIGlnbm9yZSAqLyB9XG4gICAgdHJ5IHsgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTsgfSBjYXRjaCB7IC8qIGlnbm9yZSAqLyB9XG4gIH0pO1xuXG4gIGl0KFwiTTAwMS9NMDAyIHBvcHVsYXRlZCArIE0wMDMvTTAwNCBzdHVicyBcdTIxOTIgaXNSZXVzYWJsZUdob3N0TWlsZXN0b25lIHJldHVybnMgdHJ1ZSBmb3IgTTAwMyBhbmQgTTAwNFwiLCAoKSA9PiB7XG4gICAgYmFzZSA9IG1ha2VCYXNlKCk7XG4gICAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiZ3NkLmRiXCIpKTtcbiAgICBwb3B1bGF0ZURpcihiYXNlLCBcIk0wMDFcIik7XG4gICAgcG9wdWxhdGVEaXIoYmFzZSwgXCJNMDAyXCIpO1xuICAgIHN0dWJEaXIoYmFzZSwgXCJNMDAzXCIpO1xuICAgIHN0dWJEaXIoYmFzZSwgXCJNMDA0XCIpO1xuXG4gICAgYXNzZXJ0Lm9rKGlzUmV1c2FibGVHaG9zdE1pbGVzdG9uZShiYXNlLCBcIk0wMDNcIiksIFwiTTAwMyBzaG91bGQgYmUgaWRlbnRpZmllZCBhcyByZXVzYWJsZSBnaG9zdFwiKTtcbiAgICBhc3NlcnQub2soaXNSZXVzYWJsZUdob3N0TWlsZXN0b25lKGJhc2UsIFwiTTAwNFwiKSwgXCJNMDA0IHNob3VsZCBiZSBpZGVudGlmaWVkIGFzIHJldXNhYmxlIGdob3N0XCIpO1xuICAgIGFzc2VydC5vayghaXNSZXVzYWJsZUdob3N0TWlsZXN0b25lKGJhc2UsIFwiTTAwMVwiKSwgXCJNMDAxIHNob3VsZCBub3QgYmUgcmV1c2FibGVcIik7XG4gICAgYXNzZXJ0Lm9rKCFpc1JldXNhYmxlR2hvc3RNaWxlc3RvbmUoYmFzZSwgXCJNMDAyXCIpLCBcIk0wMDIgc2hvdWxkIG5vdCBiZSByZXVzYWJsZVwiKTtcblxuICAgIGNvbnN0IG5leHRJZCA9IG5leHRNaWxlc3RvbmVJZFJlc2VydmVkKGZpbmRNaWxlc3RvbmVJZHMoYmFzZSksIGZhbHNlLCBiYXNlKTtcbiAgICBhc3NlcnQuZXF1YWwobmV4dElkLCBcIk0wMDNcIiwgXCJJRCByZXNlcnZhdGlvbiBzaG91bGQgc2VsZWN0IHRoZSBsb3dlc3QgcmV1c2FibGUgZ2hvc3RcIik7XG4gIH0pO1xuXG4gIGl0KFwid2hlbiBhbGwgZGlycyBhcmUgcG9wdWxhdGVkLCBubyBnaG9zdCBleGlzdHMgYW5kIHRoZSBmdW5jdGlvbiByZXR1cm5zIGZhbHNlIGZvciBhbGxcIiwgKCkgPT4ge1xuICAgIGJhc2UgPSBtYWtlQmFzZSgpO1xuICAgIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsIFwiLmdzZFwiLCBcImdzZC5kYlwiKSk7XG4gICAgcG9wdWxhdGVEaXIoYmFzZSwgXCJNMDAxXCIpO1xuICAgIHBvcHVsYXRlRGlyKGJhc2UsIFwiTTAwMlwiKTtcblxuICAgIGFzc2VydC5vayghaXNSZXVzYWJsZUdob3N0TWlsZXN0b25lKGJhc2UsIFwiTTAwMVwiKSwgXCJNMDAxIGlzIHBvcHVsYXRlZCwgbm90IHJldXNhYmxlXCIpO1xuICAgIGFzc2VydC5vayghaXNSZXVzYWJsZUdob3N0TWlsZXN0b25lKGJhc2UsIFwiTTAwMlwiKSwgXCJNMDAyIGlzIHBvcHVsYXRlZCwgbm90IHJldXNhYmxlXCIpO1xuXG4gICAgY29uc3QgbmV4dElkID0gbmV4dE1pbGVzdG9uZUlkUmVzZXJ2ZWQoZmluZE1pbGVzdG9uZUlkcyhiYXNlKSwgZmFsc2UsIGJhc2UpO1xuICAgIGFzc2VydC5lcXVhbChuZXh0SWQsIFwiTTAwM1wiLCBcIklEIHJlc2VydmF0aW9uIHNob3VsZCBmYWxsIGJhY2sgdG8gbWF4KzEgd2hlbiBubyBnaG9zdCBpcyByZXVzYWJsZVwiKTtcbiAgfSk7XG5cbiAgaXQoXCJkb2VzIG5vdCByZXR1cm4gYW4gYWxyZWFkeS1yZXNlcnZlZCByZXVzYWJsZSBnaG9zdCB0d2ljZVwiLCAoKSA9PiB7XG4gICAgYmFzZSA9IG1ha2VCYXNlKCk7XG4gICAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiZ3NkLmRiXCIpKTtcbiAgICBzdHViRGlyKGJhc2UsIFwiTTAwMVwiKTtcblxuICAgIGNvbnN0IGZpcnN0SWQgPSBuZXh0TWlsZXN0b25lSWRSZXNlcnZlZChmaW5kTWlsZXN0b25lSWRzKGJhc2UpLCBmYWxzZSwgYmFzZSk7XG4gICAgY29uc3Qgc2Vjb25kSWQgPSBuZXh0TWlsZXN0b25lSWRSZXNlcnZlZChmaW5kTWlsZXN0b25lSWRzKGJhc2UpLCBmYWxzZSwgYmFzZSk7XG5cbiAgICBhc3NlcnQuZXF1YWwoZmlyc3RJZCwgXCJNMDAxXCIsIFwiZmlyc3QgcmVzZXJ2YXRpb24gc2hvdWxkIHJldXNlIHRoZSBnaG9zdFwiKTtcbiAgICBhc3NlcnQuZXF1YWwoc2Vjb25kSWQsIFwiTTAwMlwiLCBcInNlY29uZCByZXNlcnZhdGlvbiBtdXN0IHNraXAgdGhlIGFscmVhZHktcmVzZXJ2ZWQgZ2hvc3RcIik7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFLQSxTQUFTLFVBQVUsSUFBSSxZQUFZLGlCQUFpQjtBQUNwRCxPQUFPLFlBQVk7QUFDbkIsU0FBUyxhQUFhLFdBQVcsZUFBZSxjQUFjO0FBQzlELFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFFdkIsU0FBUyxnQ0FBZ0M7QUFDekMsU0FBUywrQkFBK0I7QUFDeEM7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1AsU0FBUywyQkFBMkIsd0JBQXdCO0FBQzVELFNBQVMsMkJBQTJCO0FBRXBDLFNBQVMsU0FBUyxTQUFTLGlCQUF5QjtBQUNsRCxRQUFNLE9BQU8sWUFBWSxLQUFLLE9BQU8sR0FBRyxNQUFNLENBQUM7QUFDL0MsWUFBVSxLQUFLLE1BQU0sUUFBUSxZQUFZLEdBQUcsRUFBRSxXQUFXLEtB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
