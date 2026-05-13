import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  closeDatabase,
  insertDecision,
  openDatabase
} from "../gsd-db.js";
import { saveDecisionToDb } from "../db-writer.js";
import {
  queryDecisions,
  queryDecisionsFromMemories
} from "../context-store.js";
function makeTmpBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-decisions-memories-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  return base;
}
function cleanup(base) {
  try {
    closeDatabase();
  } catch {
  }
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
  }
}
async function seedDecision(base, fields) {
  const result = await saveDecisionToDb(
    {
      when_context: fields.when_context,
      scope: fields.scope,
      decision: fields.decision,
      choice: fields.choice,
      rationale: fields.rationale,
      revisable: fields.revisable ?? "Yes",
      made_by: fields.made_by ?? "agent"
    },
    base
  );
  insertDecision({
    id: result.id,
    when_context: fields.when_context,
    scope: fields.scope,
    decision: fields.decision,
    choice: fields.choice,
    rationale: fields.rationale,
    revisable: fields.revisable ?? "Yes",
    made_by: fields.made_by ?? "agent",
    superseded_by: null
  });
  return result.id;
}
test("queryDecisionsFromMemories returns empty when no decisions exist", () => {
  const base = makeTmpBase();
  try {
    assert.deepEqual(queryDecisionsFromMemories(), []);
    assert.deepEqual(queryDecisionsFromMemories({ milestoneId: "M001" }), []);
  } finally {
    cleanup(base);
  }
});
test("queryDecisionsFromMemories matches queryDecisions for a single active decision", async () => {
  const base = makeTmpBase();
  try {
    await seedDecision(base, {
      when_context: "M001 discuss phase",
      scope: "M001",
      decision: "Adopt SQLite for persistence",
      choice: "better-sqlite3",
      rationale: "Native, synchronous, well-supported"
    });
    const fromDecisions = queryDecisions();
    const fromMemories = queryDecisionsFromMemories();
    assert.equal(fromDecisions.length, 1);
    assert.equal(fromMemories.length, 1);
    const { seq: _seq1, ...d1 } = fromDecisions[0];
    const { seq: _seq2, ...d2 } = fromMemories[0];
    assert.deepEqual(d1, d2);
  } finally {
    cleanup(base);
  }
});
test("queryDecisionsFromMemories preserves decision order across multiple writes", async () => {
  const base = makeTmpBase();
  try {
    const id1 = await seedDecision(base, {
      when_context: "M001 discuss",
      scope: "M001",
      decision: "First decision",
      choice: "A",
      rationale: "first"
    });
    const id2 = await seedDecision(base, {
      when_context: "M001 plan",
      scope: "M001",
      decision: "Second decision",
      choice: "B",
      rationale: "second"
    });
    const id3 = await seedDecision(base, {
      when_context: "M002 discuss",
      scope: "M002",
      decision: "Third decision",
      choice: "C",
      rationale: "third"
    });
    const fromMemories = queryDecisionsFromMemories();
    assert.equal(fromMemories.length, 3);
    assert.deepEqual(
      fromMemories.map((d) => d.id),
      [id1, id2, id3]
    );
  } finally {
    cleanup(base);
  }
});
test("queryDecisionsFromMemories filters by milestoneId (substring match on when_context)", async () => {
  const base = makeTmpBase();
  try {
    await seedDecision(base, {
      when_context: "M001 discuss",
      scope: "M001",
      decision: "M001 decision",
      choice: "A",
      rationale: "x"
    });
    await seedDecision(base, {
      when_context: "M002 plan",
      scope: "M002",
      decision: "M002 decision",
      choice: "B",
      rationale: "y"
    });
    await seedDecision(base, {
      when_context: "M001 execute",
      scope: "M001-S01",
      decision: "M001 follow-up",
      choice: "C",
      rationale: "z"
    });
    await seedDecision(base, {
      when_context: "M003 plan",
      scope: "M003",
      decision: "Use M001 as precedent",
      choice: "D",
      rationale: "Mentions M001 outside when_context"
    });
    const m001 = queryDecisionsFromMemories({ milestoneId: "M001" });
    assert.equal(m001.length, 2, "two decisions reference M001 in when_context");
    assert.ok(m001.every((d) => d.when_context.includes("M001")));
    const m002 = queryDecisionsFromMemories({ milestoneId: "M002" });
    assert.equal(m002.length, 1);
    assert.equal(m002[0]?.decision, "M002 decision");
  } finally {
    cleanup(base);
  }
});
test("queryDecisionsFromMemories filters by scope (exact match, no prefix collisions)", async () => {
  const base = makeTmpBase();
  try {
    await seedDecision(base, {
      when_context: "M001 discuss",
      scope: "M001",
      decision: "Milestone-level",
      choice: "A",
      rationale: "x"
    });
    await seedDecision(base, {
      when_context: "M001 plan",
      scope: "M001-S01",
      decision: "Slice-level",
      choice: "B",
      rationale: "y"
    });
    await seedDecision(base, {
      when_context: "M001 plan",
      scope: "M001-S02",
      decision: "Different slice",
      choice: "C",
      rationale: "z"
    });
    const milestoneScope = queryDecisionsFromMemories({ scope: "M001" });
    assert.equal(milestoneScope.length, 1, "scope=M001 must not match M001-S01 / M001-S02");
    assert.equal(milestoneScope[0]?.scope, "M001");
    const sliceScope = queryDecisionsFromMemories({ scope: "M001-S01" });
    assert.equal(sliceScope.length, 1);
    assert.equal(sliceScope[0]?.scope, "M001-S01");
  } finally {
    cleanup(base);
  }
});
test("queryDecisionsFromMemories matches queryDecisions for combined milestoneId + scope filters", async () => {
  const base = makeTmpBase();
  try {
    await seedDecision(base, {
      when_context: "M001 discuss",
      scope: "M001",
      decision: "A",
      choice: "1",
      rationale: "x"
    });
    await seedDecision(base, {
      when_context: "M001 plan",
      scope: "M001-S01",
      decision: "B",
      choice: "2",
      rationale: "y"
    });
    await seedDecision(base, {
      when_context: "M002 discuss",
      scope: "M002",
      decision: "C",
      choice: "3",
      rationale: "z"
    });
    const opts = { milestoneId: "M001", scope: "M001-S01" };
    const fromDecisions = queryDecisions(opts);
    const fromMemories = queryDecisionsFromMemories(opts);
    assert.equal(fromDecisions.length, fromMemories.length);
    assert.equal(fromMemories.length, 1);
    assert.equal(fromMemories[0]?.id, fromDecisions[0]?.id);
    assert.equal(fromMemories[0]?.scope, "M001-S01");
  } finally {
    cleanup(base);
  }
});
test("queryDecisionsFromMemories ignores memories without a sourceDecisionId marker", async () => {
  const base = makeTmpBase();
  try {
    const { createMemory } = await import("../memory-store.js");
    createMemory({
      category: "architecture",
      content: "User-authored architecture note, not derived from a decision",
      scope: "project"
    });
    await seedDecision(base, {
      when_context: "M001 discuss",
      scope: "M001",
      decision: "Real decision",
      choice: "A",
      rationale: "x"
    });
    const fromMemories = queryDecisionsFromMemories();
    assert.equal(fromMemories.length, 1, "user-authored memory must not appear as a decision");
    assert.equal(fromMemories[0]?.decision, "Real decision");
  } finally {
    cleanup(base);
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9jb250ZXh0LXN0b3JlLWRlY2lzaW9ucy1mcm9tLW1lbW9yaWVzLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEFEUi0wMTMgUGhhc2UgNiBjdXRvdmVyIChTdGFnZSAxKSBcdTIwMTQgcXVlcnlEZWNpc2lvbnNGcm9tTWVtb3JpZXMgcGFyaXR5IHRlc3QuXG4vL1xuLy8gVmVyaWZpZXMgdGhhdCByZWFkaW5nIGFjdGl2ZSBkZWNpc2lvbnMgZnJvbSB0aGUgYG1lbW9yaWVzYCB0YWJsZSByZXR1cm5zXG4vLyB0aGUgc2FtZSBEZWNpc2lvbltdIHNoYXBlIGFuZCBjb250ZW50IGFzIHRoZSBsZWdhY3kgYHF1ZXJ5RGVjaXNpb25zYCByZWFkXG4vLyBmcm9tIHRoZSBgZGVjaXNpb25zYCB0YWJsZSwgb25jZSBQaGFzZSA1IGR1YWwtd3JpdGUgaGFzIHBvcHVsYXRlZCBib3RoXG4vLyBzdXJmYWNlcy4gTG9jay1pbiByZWdyZXNzaW9uIGZvciB0aGUgcHJvbXB0LWlubGluZSByZWFkIHBhdGggd2hpY2ggd2FzXG4vLyBzd2l0Y2hlZCB0byB0aGUgbWVtb3JpZXMgc291cmNlIGluIGF1dG8tcHJvbXB0cy50czppbmxpbmVEZWNpc2lvbnNGcm9tRGIuXG4vL1xuLy8gU2NvcGUgb2YgcGFyaXR5OiBBQ1RJVkUgZGVjaXNpb25zIG9ubHkuIFN1cGVyc2VkZWQgcm93cyBhcmUgaW50ZW50aW9uYWxseVxuLy8gc2tpcHBlZCBieSB0aGUgZXhpc3RpbmcgYmFja2ZpbGwsIHNvIHRoaXMgdGVzdCBkb2VzIG5vdCBhc3NlcnQgcGFyaXR5IGZvclxuLy8gdGhlIHN1cGVyc2VkZXMtY2hhaW4gXHUyMDE0IHRoYXQgZ2FwIGlzIGFja25vd2xlZGdlZCBpblxuLy8gcXVlcnlEZWNpc2lvbnNGcm9tTWVtb3JpZXMnIGNvbnRyYWN0IGFuZCB0cmFja2VkIGZvciBTdGFnZSAyLzMuXG5cbmltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgcm1TeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuXG5pbXBvcnQge1xuICBjbG9zZURhdGFiYXNlLFxuICBpbnNlcnREZWNpc2lvbixcbiAgb3BlbkRhdGFiYXNlLFxufSBmcm9tIFwiLi4vZ3NkLWRiLnRzXCI7XG5pbXBvcnQgeyBzYXZlRGVjaXNpb25Ub0RiIH0gZnJvbSBcIi4uL2RiLXdyaXRlci50c1wiO1xuaW1wb3J0IHtcbiAgcXVlcnlEZWNpc2lvbnMsXG4gIHF1ZXJ5RGVjaXNpb25zRnJvbU1lbW9yaWVzLFxufSBmcm9tIFwiLi4vY29udGV4dC1zdG9yZS50c1wiO1xuXG5mdW5jdGlvbiBtYWtlVG1wQmFzZSgpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtZGVjaXNpb25zLW1lbW9yaWVzLVwiKSk7XG4gIG1rZGlyU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsIFwiLmdzZFwiLCBcImdzZC5kYlwiKSk7XG4gIHJldHVybiBiYXNlO1xufVxuXG5mdW5jdGlvbiBjbGVhbnVwKGJhc2U6IHN0cmluZyk6IHZvaWQge1xuICB0cnkge1xuICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgfSBjYXRjaCB7XG4gICAgLyogbm9vcCAqL1xuICB9XG4gIHRyeSB7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfSBjYXRjaCB7XG4gICAgLyogbm9vcCAqL1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHNlZWREZWNpc2lvbihcbiAgYmFzZTogc3RyaW5nLFxuICBmaWVsZHM6IHtcbiAgICB3aGVuX2NvbnRleHQ6IHN0cmluZztcbiAgICBzY29wZTogc3RyaW5nO1xuICAgIGRlY2lzaW9uOiBzdHJpbmc7XG4gICAgY2hvaWNlOiBzdHJpbmc7XG4gICAgcmF0aW9uYWxlOiBzdHJpbmc7XG4gICAgcmV2aXNhYmxlPzogc3RyaW5nO1xuICAgIG1hZGVfYnk/OiBcImh1bWFuXCIgfCBcImFnZW50XCIgfCBcImNvbGxhYm9yYXRpdmVcIjtcbiAgfSxcbik6IFByb21pc2U8c3RyaW5nPiB7XG4gIC8vIHNhdmVEZWNpc2lvblRvRGIgd3JpdGVzIE9OTFkgdG8gbWVtb3JpZXMgcG9zdC1TdGFnZS0zLiBGb3IgcGFyaXR5IHRlc3RzXG4gIC8vIGNvbXBhcmluZyB0aGUgbGVnYWN5IGBxdWVyeURlY2lzaW9uc2AgYWdhaW5zdCBgcXVlcnlEZWNpc2lvbnNGcm9tTWVtb3JpZXNgLFxuICAvLyBtaXJyb3IgdGhlIHNhbWUgcm93IGludG8gdGhlIGxlZ2FjeSBkZWNpc2lvbnMgdGFibGUgZGlyZWN0bHkgc28gYm90aFxuICAvLyBzdXJmYWNlcyBob2xkIHRoZSBzYW1lIGRhdGEgYW5kIHRoZSBwYXJpdHkgYXNzZXJ0aW9uIGlzIHdlbGwtZGVmaW5lZC5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgc2F2ZURlY2lzaW9uVG9EYihcbiAgICB7XG4gICAgICB3aGVuX2NvbnRleHQ6IGZpZWxkcy53aGVuX2NvbnRleHQsXG4gICAgICBzY29wZTogZmllbGRzLnNjb3BlLFxuICAgICAgZGVjaXNpb246IGZpZWxkcy5kZWNpc2lvbixcbiAgICAgIGNob2ljZTogZmllbGRzLmNob2ljZSxcbiAgICAgIHJhdGlvbmFsZTogZmllbGRzLnJhdGlvbmFsZSxcbiAgICAgIHJldmlzYWJsZTogZmllbGRzLnJldmlzYWJsZSA/PyBcIlllc1wiLFxuICAgICAgbWFkZV9ieTogZmllbGRzLm1hZGVfYnkgPz8gXCJhZ2VudFwiLFxuICAgIH0sXG4gICAgYmFzZSxcbiAgKTtcbiAgaW5zZXJ0RGVjaXNpb24oe1xuICAgIGlkOiByZXN1bHQuaWQsXG4gICAgd2hlbl9jb250ZXh0OiBmaWVsZHMud2hlbl9jb250ZXh0LFxuICAgIHNjb3BlOiBmaWVsZHMuc2NvcGUsXG4gICAgZGVjaXNpb246IGZpZWxkcy5kZWNpc2lvbixcbiAgICBjaG9pY2U6IGZpZWxkcy5jaG9pY2UsXG4gICAgcmF0aW9uYWxlOiBmaWVsZHMucmF0aW9uYWxlLFxuICAgIHJldmlzYWJsZTogZmllbGRzLnJldmlzYWJsZSA/PyBcIlllc1wiLFxuICAgIG1hZGVfYnk6IGZpZWxkcy5tYWRlX2J5ID8/IFwiYWdlbnRcIixcbiAgICBzdXBlcnNlZGVkX2J5OiBudWxsLFxuICB9KTtcbiAgcmV0dXJuIHJlc3VsdC5pZDtcbn1cblxudGVzdChcInF1ZXJ5RGVjaXNpb25zRnJvbU1lbW9yaWVzIHJldHVybnMgZW1wdHkgd2hlbiBubyBkZWNpc2lvbnMgZXhpc3RcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHF1ZXJ5RGVjaXNpb25zRnJvbU1lbW9yaWVzKCksIFtdKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHF1ZXJ5RGVjaXNpb25zRnJvbU1lbW9yaWVzKHsgbWlsZXN0b25lSWQ6IFwiTTAwMVwiIH0pLCBbXSk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJxdWVyeURlY2lzaW9uc0Zyb21NZW1vcmllcyBtYXRjaGVzIHF1ZXJ5RGVjaXNpb25zIGZvciBhIHNpbmdsZSBhY3RpdmUgZGVjaXNpb25cIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICBhd2FpdCBzZWVkRGVjaXNpb24oYmFzZSwge1xuICAgICAgd2hlbl9jb250ZXh0OiBcIk0wMDEgZGlzY3VzcyBwaGFzZVwiLFxuICAgICAgc2NvcGU6IFwiTTAwMVwiLFxuICAgICAgZGVjaXNpb246IFwiQWRvcHQgU1FMaXRlIGZvciBwZXJzaXN0ZW5jZVwiLFxuICAgICAgY2hvaWNlOiBcImJldHRlci1zcWxpdGUzXCIsXG4gICAgICByYXRpb25hbGU6IFwiTmF0aXZlLCBzeW5jaHJvbm91cywgd2VsbC1zdXBwb3J0ZWRcIixcbiAgICB9KTtcblxuICAgIGNvbnN0IGZyb21EZWNpc2lvbnMgPSBxdWVyeURlY2lzaW9ucygpO1xuICAgIGNvbnN0IGZyb21NZW1vcmllcyA9IHF1ZXJ5RGVjaXNpb25zRnJvbU1lbW9yaWVzKCk7XG5cbiAgICBhc3NlcnQuZXF1YWwoZnJvbURlY2lzaW9ucy5sZW5ndGgsIDEpO1xuICAgIGFzc2VydC5lcXVhbChmcm9tTWVtb3JpZXMubGVuZ3RoLCAxKTtcblxuICAgIC8vIENvbXBhcmUgdGhlIHVzZXItdmlzaWJsZSBEZWNpc2lvbiBmaWVsZHMuIHNlcSBkaWZmZXJzIGFjcm9zcyB0YWJsZXNcbiAgICAvLyAobWVtb3JpZXMuc2VxIHZzIGRlY2lzaW9ucy5zZXEpIHNvIGl0J3MgaW50ZW50aW9uYWxseSBleGNsdWRlZC5cbiAgICBjb25zdCB7IHNlcTogX3NlcTEsIC4uLmQxIH0gPSBmcm9tRGVjaXNpb25zWzBdITtcbiAgICBjb25zdCB7IHNlcTogX3NlcTIsIC4uLmQyIH0gPSBmcm9tTWVtb3JpZXNbMF0hO1xuICAgIGFzc2VydC5kZWVwRXF1YWwoZDEsIGQyKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcInF1ZXJ5RGVjaXNpb25zRnJvbU1lbW9yaWVzIHByZXNlcnZlcyBkZWNpc2lvbiBvcmRlciBhY3Jvc3MgbXVsdGlwbGUgd3JpdGVzXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgY29uc3QgaWQxID0gYXdhaXQgc2VlZERlY2lzaW9uKGJhc2UsIHtcbiAgICAgIHdoZW5fY29udGV4dDogXCJNMDAxIGRpc2N1c3NcIixcbiAgICAgIHNjb3BlOiBcIk0wMDFcIixcbiAgICAgIGRlY2lzaW9uOiBcIkZpcnN0IGRlY2lzaW9uXCIsXG4gICAgICBjaG9pY2U6IFwiQVwiLFxuICAgICAgcmF0aW9uYWxlOiBcImZpcnN0XCIsXG4gICAgfSk7XG4gICAgY29uc3QgaWQyID0gYXdhaXQgc2VlZERlY2lzaW9uKGJhc2UsIHtcbiAgICAgIHdoZW5fY29udGV4dDogXCJNMDAxIHBsYW5cIixcbiAgICAgIHNjb3BlOiBcIk0wMDFcIixcbiAgICAgIGRlY2lzaW9uOiBcIlNlY29uZCBkZWNpc2lvblwiLFxuICAgICAgY2hvaWNlOiBcIkJcIixcbiAgICAgIHJhdGlvbmFsZTogXCJzZWNvbmRcIixcbiAgICB9KTtcbiAgICBjb25zdCBpZDMgPSBhd2FpdCBzZWVkRGVjaXNpb24oYmFzZSwge1xuICAgICAgd2hlbl9jb250ZXh0OiBcIk0wMDIgZGlzY3Vzc1wiLFxuICAgICAgc2NvcGU6IFwiTTAwMlwiLFxuICAgICAgZGVjaXNpb246IFwiVGhpcmQgZGVjaXNpb25cIixcbiAgICAgIGNob2ljZTogXCJDXCIsXG4gICAgICByYXRpb25hbGU6IFwidGhpcmRcIixcbiAgICB9KTtcblxuICAgIGNvbnN0IGZyb21NZW1vcmllcyA9IHF1ZXJ5RGVjaXNpb25zRnJvbU1lbW9yaWVzKCk7XG4gICAgYXNzZXJ0LmVxdWFsKGZyb21NZW1vcmllcy5sZW5ndGgsIDMpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwoXG4gICAgICBmcm9tTWVtb3JpZXMubWFwKChkKSA9PiBkLmlkKSxcbiAgICAgIFtpZDEsIGlkMiwgaWQzXSxcbiAgICApO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwicXVlcnlEZWNpc2lvbnNGcm9tTWVtb3JpZXMgZmlsdGVycyBieSBtaWxlc3RvbmVJZCAoc3Vic3RyaW5nIG1hdGNoIG9uIHdoZW5fY29udGV4dClcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICBhd2FpdCBzZWVkRGVjaXNpb24oYmFzZSwge1xuICAgICAgd2hlbl9jb250ZXh0OiBcIk0wMDEgZGlzY3Vzc1wiLFxuICAgICAgc2NvcGU6IFwiTTAwMVwiLFxuICAgICAgZGVjaXNpb246IFwiTTAwMSBkZWNpc2lvblwiLFxuICAgICAgY2hvaWNlOiBcIkFcIixcbiAgICAgIHJhdGlvbmFsZTogXCJ4XCIsXG4gICAgfSk7XG4gICAgYXdhaXQgc2VlZERlY2lzaW9uKGJhc2UsIHtcbiAgICAgIHdoZW5fY29udGV4dDogXCJNMDAyIHBsYW5cIixcbiAgICAgIHNjb3BlOiBcIk0wMDJcIixcbiAgICAgIGRlY2lzaW9uOiBcIk0wMDIgZGVjaXNpb25cIixcbiAgICAgIGNob2ljZTogXCJCXCIsXG4gICAgICByYXRpb25hbGU6IFwieVwiLFxuICAgIH0pO1xuICAgIGF3YWl0IHNlZWREZWNpc2lvbihiYXNlLCB7XG4gICAgICB3aGVuX2NvbnRleHQ6IFwiTTAwMSBleGVjdXRlXCIsXG4gICAgICBzY29wZTogXCJNMDAxLVMwMVwiLFxuICAgICAgZGVjaXNpb246IFwiTTAwMSBmb2xsb3ctdXBcIixcbiAgICAgIGNob2ljZTogXCJDXCIsXG4gICAgICByYXRpb25hbGU6IFwielwiLFxuICAgIH0pO1xuICAgIGF3YWl0IHNlZWREZWNpc2lvbihiYXNlLCB7XG4gICAgICB3aGVuX2NvbnRleHQ6IFwiTTAwMyBwbGFuXCIsXG4gICAgICBzY29wZTogXCJNMDAzXCIsXG4gICAgICBkZWNpc2lvbjogXCJVc2UgTTAwMSBhcyBwcmVjZWRlbnRcIixcbiAgICAgIGNob2ljZTogXCJEXCIsXG4gICAgICByYXRpb25hbGU6IFwiTWVudGlvbnMgTTAwMSBvdXRzaWRlIHdoZW5fY29udGV4dFwiLFxuICAgIH0pO1xuXG4gICAgY29uc3QgbTAwMSA9IHF1ZXJ5RGVjaXNpb25zRnJvbU1lbW9yaWVzKHsgbWlsZXN0b25lSWQ6IFwiTTAwMVwiIH0pO1xuICAgIGFzc2VydC5lcXVhbChtMDAxLmxlbmd0aCwgMiwgXCJ0d28gZGVjaXNpb25zIHJlZmVyZW5jZSBNMDAxIGluIHdoZW5fY29udGV4dFwiKTtcbiAgICBhc3NlcnQub2sobTAwMS5ldmVyeSgoZCkgPT4gZC53aGVuX2NvbnRleHQuaW5jbHVkZXMoXCJNMDAxXCIpKSk7XG5cbiAgICBjb25zdCBtMDAyID0gcXVlcnlEZWNpc2lvbnNGcm9tTWVtb3JpZXMoeyBtaWxlc3RvbmVJZDogXCJNMDAyXCIgfSk7XG4gICAgYXNzZXJ0LmVxdWFsKG0wMDIubGVuZ3RoLCAxKTtcbiAgICBhc3NlcnQuZXF1YWwobTAwMlswXT8uZGVjaXNpb24sIFwiTTAwMiBkZWNpc2lvblwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcInF1ZXJ5RGVjaXNpb25zRnJvbU1lbW9yaWVzIGZpbHRlcnMgYnkgc2NvcGUgKGV4YWN0IG1hdGNoLCBubyBwcmVmaXggY29sbGlzaW9ucylcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICBhd2FpdCBzZWVkRGVjaXNpb24oYmFzZSwge1xuICAgICAgd2hlbl9jb250ZXh0OiBcIk0wMDEgZGlzY3Vzc1wiLFxuICAgICAgc2NvcGU6IFwiTTAwMVwiLFxuICAgICAgZGVjaXNpb246IFwiTWlsZXN0b25lLWxldmVsXCIsXG4gICAgICBjaG9pY2U6IFwiQVwiLFxuICAgICAgcmF0aW9uYWxlOiBcInhcIixcbiAgICB9KTtcbiAgICBhd2FpdCBzZWVkRGVjaXNpb24oYmFzZSwge1xuICAgICAgd2hlbl9jb250ZXh0OiBcIk0wMDEgcGxhblwiLFxuICAgICAgc2NvcGU6IFwiTTAwMS1TMDFcIixcbiAgICAgIGRlY2lzaW9uOiBcIlNsaWNlLWxldmVsXCIsXG4gICAgICBjaG9pY2U6IFwiQlwiLFxuICAgICAgcmF0aW9uYWxlOiBcInlcIixcbiAgICB9KTtcbiAgICBhd2FpdCBzZWVkRGVjaXNpb24oYmFzZSwge1xuICAgICAgd2hlbl9jb250ZXh0OiBcIk0wMDEgcGxhblwiLFxuICAgICAgc2NvcGU6IFwiTTAwMS1TMDJcIixcbiAgICAgIGRlY2lzaW9uOiBcIkRpZmZlcmVudCBzbGljZVwiLFxuICAgICAgY2hvaWNlOiBcIkNcIixcbiAgICAgIHJhdGlvbmFsZTogXCJ6XCIsXG4gICAgfSk7XG5cbiAgICAvLyBFeGFjdC1zY29wZSBmaWx0ZXIgbXVzdCBub3QgbWF0Y2ggcHJlZml4LXNpbWlsYXIgdmFsdWVzLlxuICAgIGNvbnN0IG1pbGVzdG9uZVNjb3BlID0gcXVlcnlEZWNpc2lvbnNGcm9tTWVtb3JpZXMoeyBzY29wZTogXCJNMDAxXCIgfSk7XG4gICAgYXNzZXJ0LmVxdWFsKG1pbGVzdG9uZVNjb3BlLmxlbmd0aCwgMSwgXCJzY29wZT1NMDAxIG11c3Qgbm90IG1hdGNoIE0wMDEtUzAxIC8gTTAwMS1TMDJcIik7XG4gICAgYXNzZXJ0LmVxdWFsKG1pbGVzdG9uZVNjb3BlWzBdPy5zY29wZSwgXCJNMDAxXCIpO1xuXG4gICAgY29uc3Qgc2xpY2VTY29wZSA9IHF1ZXJ5RGVjaXNpb25zRnJvbU1lbW9yaWVzKHsgc2NvcGU6IFwiTTAwMS1TMDFcIiB9KTtcbiAgICBhc3NlcnQuZXF1YWwoc2xpY2VTY29wZS5sZW5ndGgsIDEpO1xuICAgIGFzc2VydC5lcXVhbChzbGljZVNjb3BlWzBdPy5zY29wZSwgXCJNMDAxLVMwMVwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcInF1ZXJ5RGVjaXNpb25zRnJvbU1lbW9yaWVzIG1hdGNoZXMgcXVlcnlEZWNpc2lvbnMgZm9yIGNvbWJpbmVkIG1pbGVzdG9uZUlkICsgc2NvcGUgZmlsdGVyc1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIGF3YWl0IHNlZWREZWNpc2lvbihiYXNlLCB7XG4gICAgICB3aGVuX2NvbnRleHQ6IFwiTTAwMSBkaXNjdXNzXCIsXG4gICAgICBzY29wZTogXCJNMDAxXCIsXG4gICAgICBkZWNpc2lvbjogXCJBXCIsXG4gICAgICBjaG9pY2U6IFwiMVwiLFxuICAgICAgcmF0aW9uYWxlOiBcInhcIixcbiAgICB9KTtcbiAgICBhd2FpdCBzZWVkRGVjaXNpb24oYmFzZSwge1xuICAgICAgd2hlbl9jb250ZXh0OiBcIk0wMDEgcGxhblwiLFxuICAgICAgc2NvcGU6IFwiTTAwMS1TMDFcIixcbiAgICAgIGRlY2lzaW9uOiBcIkJcIixcbiAgICAgIGNob2ljZTogXCIyXCIsXG4gICAgICByYXRpb25hbGU6IFwieVwiLFxuICAgIH0pO1xuICAgIGF3YWl0IHNlZWREZWNpc2lvbihiYXNlLCB7XG4gICAgICB3aGVuX2NvbnRleHQ6IFwiTTAwMiBkaXNjdXNzXCIsXG4gICAgICBzY29wZTogXCJNMDAyXCIsXG4gICAgICBkZWNpc2lvbjogXCJDXCIsXG4gICAgICBjaG9pY2U6IFwiM1wiLFxuICAgICAgcmF0aW9uYWxlOiBcInpcIixcbiAgICB9KTtcblxuICAgIGNvbnN0IG9wdHMgPSB7IG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgc2NvcGU6IFwiTTAwMS1TMDFcIiB9O1xuICAgIGNvbnN0IGZyb21EZWNpc2lvbnMgPSBxdWVyeURlY2lzaW9ucyhvcHRzKTtcbiAgICBjb25zdCBmcm9tTWVtb3JpZXMgPSBxdWVyeURlY2lzaW9uc0Zyb21NZW1vcmllcyhvcHRzKTtcblxuICAgIGFzc2VydC5lcXVhbChmcm9tRGVjaXNpb25zLmxlbmd0aCwgZnJvbU1lbW9yaWVzLmxlbmd0aCk7XG4gICAgYXNzZXJ0LmVxdWFsKGZyb21NZW1vcmllcy5sZW5ndGgsIDEpO1xuICAgIGFzc2VydC5lcXVhbChmcm9tTWVtb3JpZXNbMF0/LmlkLCBmcm9tRGVjaXNpb25zWzBdPy5pZCk7XG4gICAgYXNzZXJ0LmVxdWFsKGZyb21NZW1vcmllc1swXT8uc2NvcGUsIFwiTTAwMS1TMDFcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJxdWVyeURlY2lzaW9uc0Zyb21NZW1vcmllcyBpZ25vcmVzIG1lbW9yaWVzIHdpdGhvdXQgYSBzb3VyY2VEZWNpc2lvbklkIG1hcmtlclwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIC8vIEluc2VydCBhIHVzZXItYXV0aG9yZWQgbWVtb3J5IChubyBzb3VyY2VEZWNpc2lvbklkKSBcdTIwMTQgbXVzdCBub3QgYXBwZWFyIGluXG4gICAgLy8gdGhlIGRlY2lzaW9ucy1mcm9tLW1lbW9yaWVzIHByb2plY3Rpb24uXG4gICAgY29uc3QgeyBjcmVhdGVNZW1vcnkgfSA9IGF3YWl0IGltcG9ydChcIi4uL21lbW9yeS1zdG9yZS50c1wiKTtcbiAgICBjcmVhdGVNZW1vcnkoe1xuICAgICAgY2F0ZWdvcnk6IFwiYXJjaGl0ZWN0dXJlXCIsXG4gICAgICBjb250ZW50OiBcIlVzZXItYXV0aG9yZWQgYXJjaGl0ZWN0dXJlIG5vdGUsIG5vdCBkZXJpdmVkIGZyb20gYSBkZWNpc2lvblwiLFxuICAgICAgc2NvcGU6IFwicHJvamVjdFwiLFxuICAgIH0pO1xuXG4gICAgYXdhaXQgc2VlZERlY2lzaW9uKGJhc2UsIHtcbiAgICAgIHdoZW5fY29udGV4dDogXCJNMDAxIGRpc2N1c3NcIixcbiAgICAgIHNjb3BlOiBcIk0wMDFcIixcbiAgICAgIGRlY2lzaW9uOiBcIlJlYWwgZGVjaXNpb25cIixcbiAgICAgIGNob2ljZTogXCJBXCIsXG4gICAgICByYXRpb25hbGU6IFwieFwiLFxuICAgIH0pO1xuXG4gICAgY29uc3QgZnJvbU1lbW9yaWVzID0gcXVlcnlEZWNpc2lvbnNGcm9tTWVtb3JpZXMoKTtcbiAgICBhc3NlcnQuZXF1YWwoZnJvbU1lbW9yaWVzLmxlbmd0aCwgMSwgXCJ1c2VyLWF1dGhvcmVkIG1lbW9yeSBtdXN0IG5vdCBhcHBlYXIgYXMgYSBkZWNpc2lvblwiKTtcbiAgICBhc3NlcnQuZXF1YWwoZnJvbU1lbW9yaWVzWzBdPy5kZWNpc2lvbiwgXCJSZWFsIGRlY2lzaW9uXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBYUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUNuQixTQUFTLGFBQWEsV0FBVyxjQUFjO0FBQy9DLFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFFdkI7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1AsU0FBUyx3QkFBd0I7QUFDakM7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFFUCxTQUFTLGNBQXNCO0FBQzdCLFFBQU0sT0FBTyxZQUFZLEtBQUssT0FBTyxHQUFHLHlCQUF5QixDQUFDO0FBQ2xFLFlBQVUsS0FBSyxNQUFNLE1BQU0sR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ2pELGVBQWEsS0FBSyxNQUFNLFFBQVEsUUFBUSxDQUFDO0FBQ3pDLFNBQU87QUFDVDtBQUVBLFNBQVMsUUFBUSxNQUFvQjtBQUNuQyxNQUFJO0FBQ0Ysa0JBQWM7QUFBQSxFQUNoQixRQUFRO0FBQUEsRUFFUjtBQUNBLE1BQUk7QUFDRixXQUFPLE1BQU0sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUMvQyxRQUFRO0FBQUEsRUFFUjtBQUNGO0FBRUEsZUFBZSxhQUNiLE1BQ0EsUUFTaUI7QUFLakIsUUFBTSxTQUFTLE1BQU07QUFBQSxJQUNuQjtBQUFBLE1BQ0UsY0FBYyxPQUFPO0FBQUEsTUFDckIsT0FBTyxPQUFPO0FBQUEsTUFDZCxVQUFVLE9BQU87QUFBQSxNQUNqQixRQUFRLE9BQU87QUFBQSxNQUNmLFdBQVcsT0FBTztBQUFBLE1BQ2xCLFdBQVcsT0FBTyxhQUFhO0FBQUEsTUFDL0IsU0FBUyxPQUFPLFdBQVc7QUFBQSxJQUM3QjtBQUFBLElBQ0E7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
