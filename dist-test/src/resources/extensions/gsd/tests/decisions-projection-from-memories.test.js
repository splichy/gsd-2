import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  _getAdapter,
  closeDatabase,
  insertDecision,
  openDatabase
} from "../gsd-db.js";
import { saveDecisionToDb, generateDecisionsMd } from "../db-writer.js";
import {
  getAllDecisionsFromMemories,
  queryDecisionsFromMemories
} from "../context-store.js";
import { backfillDecisionsToMemories } from "../memory-backfill.js";
function makeTmpBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-decisions-stage2a-"));
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
function seedRawDecision(args) {
  insertDecision({
    id: args.id,
    when_context: args.when_context,
    scope: args.scope,
    decision: args.decision,
    choice: args.choice,
    rationale: args.rationale,
    revisable: args.revisable ?? "Yes",
    made_by: args.made_by ?? "agent",
    superseded_by: args.superseded_by ?? null
  });
}
function setDecisionSupersededBy(id, supersededBy) {
  const adapter = _getAdapter();
  if (!adapter) throw new Error("DB adapter unavailable");
  adapter.prepare("UPDATE decisions SET superseded_by = :s WHERE id = :id").run({ ":s": supersededBy, ":id": id });
}
test("backfill migrates superseded decisions (no active-only filter)", () => {
  const base = makeTmpBase();
  try {
    seedRawDecision({
      id: "D001",
      when_context: "M001 discuss",
      scope: "M001",
      decision: "Use A",
      choice: "A",
      rationale: "first idea",
      superseded_by: "D002"
    });
    seedRawDecision({
      id: "D002",
      when_context: "M001 discuss",
      scope: "M001",
      decision: "Switch to B",
      choice: "B",
      rationale: "second thought",
      superseded_by: null
    });
    const written = backfillDecisionsToMemories();
    assert.equal(written, 2, "both active and superseded rows should be migrated");
    const all = getAllDecisionsFromMemories();
    assert.equal(all.length, 2);
    const d001 = all.find((d) => d.id === "D001");
    const d002 = all.find((d) => d.id === "D002");
    assert.ok(d001 && d002);
    assert.equal(d001.superseded_by, "D002", "structuredFields.superseded_by must be preserved");
    assert.equal(d002.superseded_by, null);
  } finally {
    cleanup(base);
  }
});
test("backfill is idempotent \u2014 re-running over migrated rows is a no-op", () => {
  const base = makeTmpBase();
  try {
    seedRawDecision({
      id: "D001",
      when_context: "M001",
      scope: "M001",
      decision: "x",
      choice: "y",
      rationale: "z"
    });
    const first = backfillDecisionsToMemories();
    assert.equal(first, 1);
    const second = backfillDecisionsToMemories();
    assert.equal(second, 0, "already-migrated rows must not be re-inserted");
  } finally {
    cleanup(base);
  }
});
test("backfill auto-heals when a source decision's superseded_by changes after migration", () => {
  const base = makeTmpBase();
  try {
    seedRawDecision({
      id: "D001",
      when_context: "M001",
      scope: "M001",
      decision: "Original",
      choice: "A",
      rationale: "r"
    });
    backfillDecisionsToMemories();
    const beforeHeal = getAllDecisionsFromMemories().find((d) => d.id === "D001");
    assert.equal(beforeHeal?.superseded_by, null);
    seedRawDecision({
      id: "D002",
      when_context: "M001",
      scope: "M001",
      decision: "New",
      choice: "B",
      rationale: "newer"
    });
    setDecisionSupersededBy("D001", "D002");
    backfillDecisionsToMemories();
    const afterHeal = getAllDecisionsFromMemories().find((d) => d.id === "D001");
    assert.equal(
      afterHeal?.superseded_by,
      "D002",
      "drift auto-heal must update structuredFields.superseded_by on existing migrated memories"
    );
    const d002 = getAllDecisionsFromMemories().find((d) => d.id === "D002");
    assert.equal(d002?.superseded_by, null, "newly-migrated D002 stays active");
  } finally {
    cleanup(base);
  }
});
test("backfill drift auto-heal updates only the selected memory row", () => {
  const base = makeTmpBase();
  try {
    seedRawDecision({
      id: "D001",
      when_context: "M001",
      scope: "M001",
      decision: "Original",
      choice: "A",
      rationale: "r"
    });
    backfillDecisionsToMemories();
    const adapter = _getAdapter();
    if (!adapter) throw new Error("DB adapter unavailable");
    const now = (/* @__PURE__ */ new Date()).toISOString();
    adapter.prepare(
      `INSERT INTO memories (
          id, category, content, confidence, created_at, updated_at, scope, tags, structured_fields
        ) VALUES (
          :id, 'architecture', 'duplicate marker', 0.8, :created_at, :updated_at, 'project', '[]', :structured_fields
        )`
    ).run({
      ":id": "manual-duplicate-D001",
      ":created_at": now,
      ":updated_at": now,
      ":structured_fields": JSON.stringify({
        sourceDecisionId: "D001",
        superseded_by: null,
        note: "manual duplicate should not be healed as a side effect"
      })
    });
    setDecisionSupersededBy("D001", "D002");
    backfillDecisionsToMemories();
    const rows = adapter.prepare("SELECT id, structured_fields FROM memories WHERE structured_fields LIKE :pattern ORDER BY seq").all({ ":pattern": '%"sourceDecisionId":"D001"%' });
    assert.equal(rows.length, 2);
    const healed = rows.find((row) => row.id !== "manual-duplicate-D001");
    const duplicate = rows.find((row) => row.id === "manual-duplicate-D001");
    assert.equal(JSON.parse(healed?.structured_fields ?? "{}").superseded_by, "D002");
    assert.equal(
      JSON.parse(duplicate?.structured_fields ?? "{}").superseded_by,
      null,
      "drift auto-heal must not update every memory matching the sourceDecisionId pattern"
    );
  } finally {
    cleanup(base);
  }
});
test("queryDecisionsFromMemories filters out rows whose structuredFields.superseded_by is set", () => {
  const base = makeTmpBase();
  try {
    seedRawDecision({
      id: "D001",
      when_context: "M001",
      scope: "M001",
      decision: "Old",
      choice: "A",
      rationale: "r1",
      superseded_by: "D002"
    });
    seedRawDecision({
      id: "D002",
      when_context: "M001",
      scope: "M001",
      decision: "New",
      choice: "B",
      rationale: "r2"
    });
    backfillDecisionsToMemories();
    const active = queryDecisionsFromMemories();
    assert.equal(active.length, 1, "only the non-superseded decision should appear");
    assert.equal(active[0]?.id, "D002");
  } finally {
    cleanup(base);
  }
});
test("getAllDecisionsFromMemories returns the full register including superseded", () => {
  const base = makeTmpBase();
  try {
    seedRawDecision({
      id: "D001",
      when_context: "M001",
      scope: "M001",
      decision: "First",
      choice: "A",
      rationale: "r1",
      superseded_by: "D002"
    });
    seedRawDecision({
      id: "D002",
      when_context: "M001",
      scope: "M001",
      decision: "Second",
      choice: "B",
      rationale: "r2"
    });
    backfillDecisionsToMemories();
    const all = getAllDecisionsFromMemories();
    assert.equal(all.length, 2);
    assert.deepEqual(
      all.map((d) => ({ id: d.id, superseded_by: d.superseded_by })),
      [
        { id: "D001", superseded_by: "D002" },
        { id: "D002", superseded_by: null }
      ]
    );
  } finally {
    cleanup(base);
  }
});
function decisionFromLegacyRow(row) {
  return {
    seq: row["seq"],
    id: row["id"],
    when_context: row["when_context"],
    scope: row["scope"],
    decision: row["decision"],
    choice: row["choice"],
    rationale: row["rationale"],
    revisable: row["revisable"],
    made_by: row["made_by"] ?? "agent",
    superseded_by: row["superseded_by"] ?? null
  };
}
test("DECISIONS.md projection from memories matches the legacy decisions-table render", async () => {
  const base = makeTmpBase();
  try {
    seedRawDecision({
      id: "D001",
      when_context: "M001 discuss",
      scope: "M001",
      decision: "Initial direction",
      choice: "A",
      rationale: "rationale-1",
      superseded_by: "D003"
    });
    seedRawDecision({
      id: "D002",
      when_context: "M001 plan",
      scope: "M001-S01",
      decision: "Active call",
      choice: "B",
      rationale: "rationale-2"
    });
    seedRawDecision({
      id: "D003",
      when_context: "M002 review",
      scope: "M002",
      decision: "Replacement for D001",
      choice: "C",
      rationale: "rationale-3"
    });
    backfillDecisionsToMemories();
    const adapter = _getAdapter();
    if (!adapter) throw new Error("DB adapter unavailable");
    const legacyRows = adapter.prepare("SELECT * FROM decisions ORDER BY seq").all();
    const legacyDecisions = legacyRows.map(decisionFromLegacyRow);
    const legacyMd = generateDecisionsMd(legacyDecisions);
    const memoryDecisions = getAllDecisionsFromMemories();
    const memoryMd = generateDecisionsMd(memoryDecisions);
    assert.equal(memoryMd, legacyMd, "memory-sourced projection must match decisions-table render byte-for-byte");
  } finally {
    cleanup(base);
  }
});
test("saveDecisionToDb writes a DECISIONS.md projection sourced from memories that round-trips", async () => {
  const base = makeTmpBase();
  try {
    await saveDecisionToDb(
      {
        when_context: "M001 discuss",
        scope: "M001",
        decision: "Adopt SQLite",
        choice: "better-sqlite3",
        rationale: "synchronous + native",
        revisable: "Yes",
        made_by: "agent"
      },
      base
    );
    await saveDecisionToDb(
      {
        when_context: "M001 plan",
        scope: "M001-S01",
        decision: "Schema versioning",
        choice: "header column",
        rationale: "simplest to read"
      },
      base
    );
    const md = readFileSync(join(base, ".gsd", "DECISIONS.md"), "utf-8");
    assert.match(md, /\| D001 \|/);
    assert.match(md, /\| D002 \|/);
    assert.match(md, /Adopt SQLite/);
    assert.match(md, /Schema versioning/);
    assert.match(md, /# Decisions Register/);
    assert.match(md, /\| D002 \|[^\n]*\| Yes \| agent \|/);
  } finally {
    cleanup(base);
  }
});
test("saveDecisionToDb injects a projection fallback when memory mirror is absent", async () => {
  const base = makeTmpBase();
  try {
    const result = await saveDecisionToDb(
      {
        when_context: "M001 fallback",
        scope: "M001",
        decision: "",
        choice: "",
        rationale: ""
      },
      base
    );
    assert.equal(result.id, "D001");
    assert.equal(getAllDecisionsFromMemories().some((d) => d.id === "D001"), false);
    const md = readFileSync(join(base, ".gsd", "DECISIONS.md"), "utf-8");
    assert.match(md, /\| D001 \| M001 fallback \| M001 \|  \|  \|  \| Yes \| agent \|/);
  } finally {
    cleanup(base);
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9kZWNpc2lvbnMtcHJvamVjdGlvbi1mcm9tLW1lbW9yaWVzLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEFEUi0wMTMgUGhhc2UgNiBjdXRvdmVyIChTdGFnZSAyYSkgXHUyMDE0IGxvY2tzIGluIHRoZSBmb3VyIGJlaGF2aW9yYWwgY2hhbmdlczpcbi8vXG4vLyAgIDEuIG1lbW9yeS1iYWNrZmlsbCBpbmNsdWRlcyBzdXBlcnNlZGVkIGRlY2lzaW9ucyArIHByZXNlcnZlc1xuLy8gICAgICBzdHJ1Y3R1cmVkRmllbGRzLnN1cGVyc2VkZWRfYnlcbi8vICAgMi4gbWVtb3J5LWJhY2tmaWxsIGRyaWZ0IGF1dG8taGVhbDogd2hlbiBhIGRlY2lzaW9uJ3Mgc3VwZXJzZWRlZF9ieVxuLy8gICAgICBjaGFuZ2VzIGFmdGVyIG1pZ3JhdGlvbiwgdGhlIG1lbW9yeSdzIHN0cnVjdHVyZWRGaWVsZHMgdXBkYXRlXG4vLyAgIDMuIGNvbnRleHQtc3RvcmUucXVlcnlEZWNpc2lvbnNGcm9tTWVtb3JpZXMgZmlsdGVycyBvdXQgcm93cyB3aG9zZVxuLy8gICAgICBzdHJ1Y3R1cmVkRmllbGRzLnN1cGVyc2VkZWRfYnkgaXMgc2V0IChhY3RpdmUtb25seSlcbi8vICAgNC4gY29udGV4dC1zdG9yZS5nZXRBbGxEZWNpc2lvbnNGcm9tTWVtb3JpZXMgcmV0dXJucyB0aGUgZnVsbCByZWdpc3RlclxuLy8gICAgICBpbmNsdWRpbmcgc3VwZXJzZWRlZCByb3dzLCBhbmQgdGhlIHNhdmVEZWNpc2lvblRvRGIgcHJvamVjdGlvbiByZWdlblxuLy8gICAgICB1c2VzIGl0IFx1MjAxNCBwcm9kdWNpbmcgYnl0ZS1lcXVpdmFsZW50IERFQ0lTSU9OUy5tZCB0byB0aGUgbGVnYWN5IHBhdGhcblxuaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgbWtkaXJTeW5jLCBybVN5bmMsIHJlYWRGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcblxuaW1wb3J0IHtcbiAgX2dldEFkYXB0ZXIsXG4gIGNsb3NlRGF0YWJhc2UsXG4gIGluc2VydERlY2lzaW9uLFxuICBvcGVuRGF0YWJhc2UsXG59IGZyb20gXCIuLi9nc2QtZGIudHNcIjtcbmltcG9ydCB7IHNhdmVEZWNpc2lvblRvRGIsIGdlbmVyYXRlRGVjaXNpb25zTWQgfSBmcm9tIFwiLi4vZGItd3JpdGVyLnRzXCI7XG5pbXBvcnQge1xuICBnZXRBbGxEZWNpc2lvbnNGcm9tTWVtb3JpZXMsXG4gIHF1ZXJ5RGVjaXNpb25zRnJvbU1lbW9yaWVzLFxufSBmcm9tIFwiLi4vY29udGV4dC1zdG9yZS50c1wiO1xuaW1wb3J0IHsgYmFja2ZpbGxEZWNpc2lvbnNUb01lbW9yaWVzIH0gZnJvbSBcIi4uL21lbW9yeS1iYWNrZmlsbC50c1wiO1xuaW1wb3J0IHR5cGUgeyBEZWNpc2lvbiB9IGZyb20gXCIuLi90eXBlcy50c1wiO1xuXG5mdW5jdGlvbiBtYWtlVG1wQmFzZSgpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtZGVjaXNpb25zLXN0YWdlMmEtXCIpKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiZ3NkLmRiXCIpKTtcbiAgcmV0dXJuIGJhc2U7XG59XG5cbmZ1bmN0aW9uIGNsZWFudXAoYmFzZTogc3RyaW5nKTogdm9pZCB7XG4gIHRyeSB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICB9IGNhdGNoIHtcbiAgICAvKiBub29wICovXG4gIH1cbiAgdHJ5IHtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9IGNhdGNoIHtcbiAgICAvKiBub29wICovXG4gIH1cbn1cblxuZnVuY3Rpb24gc2VlZFJhd0RlY2lzaW9uKGFyZ3M6IHtcbiAgaWQ6IHN0cmluZztcbiAgd2hlbl9jb250ZXh0OiBzdHJpbmc7XG4gIHNjb3BlOiBzdHJpbmc7XG4gIGRlY2lzaW9uOiBzdHJpbmc7XG4gIGNob2ljZTogc3RyaW5nO1xuICByYXRpb25hbGU6IHN0cmluZztcbiAgcmV2aXNhYmxlPzogc3RyaW5nO1xuICBtYWRlX2J5PzogXCJodW1hblwiIHwgXCJhZ2VudFwiIHwgXCJjb2xsYWJvcmF0aXZlXCI7XG4gIHN1cGVyc2VkZWRfYnk/OiBzdHJpbmcgfCBudWxsO1xufSk6IHZvaWQge1xuICBpbnNlcnREZWNpc2lvbih7XG4gICAgaWQ6IGFyZ3MuaWQsXG4gICAgd2hlbl9jb250ZXh0OiBhcmdzLndoZW5fY29udGV4dCxcbiAgICBzY29wZTogYXJncy5zY29wZSxcbiAgICBkZWNpc2lvbjogYXJncy5kZWNpc2lvbixcbiAgICBjaG9pY2U6IGFyZ3MuY2hvaWNlLFxuICAgIHJhdGlvbmFsZTogYXJncy5yYXRpb25hbGUsXG4gICAgcmV2aXNhYmxlOiBhcmdzLnJldmlzYWJsZSA/PyBcIlllc1wiLFxuICAgIG1hZGVfYnk6IGFyZ3MubWFkZV9ieSA/PyBcImFnZW50XCIsXG4gICAgc3VwZXJzZWRlZF9ieTogYXJncy5zdXBlcnNlZGVkX2J5ID8/IG51bGwsXG4gIH0pO1xufVxuXG5mdW5jdGlvbiBzZXREZWNpc2lvblN1cGVyc2VkZWRCeShpZDogc3RyaW5nLCBzdXBlcnNlZGVkQnk6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBhZGFwdGVyID0gX2dldEFkYXB0ZXIoKTtcbiAgaWYgKCFhZGFwdGVyKSB0aHJvdyBuZXcgRXJyb3IoXCJEQiBhZGFwdGVyIHVuYXZhaWxhYmxlXCIpO1xuICBhZGFwdGVyXG4gICAgLnByZXBhcmUoXCJVUERBVEUgZGVjaXNpb25zIFNFVCBzdXBlcnNlZGVkX2J5ID0gOnMgV0hFUkUgaWQgPSA6aWRcIilcbiAgICAucnVuKHsgXCI6c1wiOiBzdXBlcnNlZGVkQnksIFwiOmlkXCI6IGlkIH0pO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQmFja2ZpbGw6IHN1cGVyc2VkZWQgaW5jbHVzaW9uICsgc3RydWN0dXJlZEZpZWxkcyBwcmVzZXJ2YXRpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJiYWNrZmlsbCBtaWdyYXRlcyBzdXBlcnNlZGVkIGRlY2lzaW9ucyAobm8gYWN0aXZlLW9ubHkgZmlsdGVyKVwiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIHNlZWRSYXdEZWNpc2lvbih7XG4gICAgICBpZDogXCJEMDAxXCIsXG4gICAgICB3aGVuX2NvbnRleHQ6IFwiTTAwMSBkaXNjdXNzXCIsXG4gICAgICBzY29wZTogXCJNMDAxXCIsXG4gICAgICBkZWNpc2lvbjogXCJVc2UgQVwiLFxuICAgICAgY2hvaWNlOiBcIkFcIixcbiAgICAgIHJhdGlvbmFsZTogXCJmaXJzdCBpZGVhXCIsXG4gICAgICBzdXBlcnNlZGVkX2J5OiBcIkQwMDJcIixcbiAgICB9KTtcbiAgICBzZWVkUmF3RGVjaXNpb24oe1xuICAgICAgaWQ6IFwiRDAwMlwiLFxuICAgICAgd2hlbl9jb250ZXh0OiBcIk0wMDEgZGlzY3Vzc1wiLFxuICAgICAgc2NvcGU6IFwiTTAwMVwiLFxuICAgICAgZGVjaXNpb246IFwiU3dpdGNoIHRvIEJcIixcbiAgICAgIGNob2ljZTogXCJCXCIsXG4gICAgICByYXRpb25hbGU6IFwic2Vjb25kIHRob3VnaHRcIixcbiAgICAgIHN1cGVyc2VkZWRfYnk6IG51bGwsXG4gICAgfSk7XG5cbiAgICBjb25zdCB3cml0dGVuID0gYmFja2ZpbGxEZWNpc2lvbnNUb01lbW9yaWVzKCk7XG4gICAgYXNzZXJ0LmVxdWFsKHdyaXR0ZW4sIDIsIFwiYm90aCBhY3RpdmUgYW5kIHN1cGVyc2VkZWQgcm93cyBzaG91bGQgYmUgbWlncmF0ZWRcIik7XG5cbiAgICBjb25zdCBhbGwgPSBnZXRBbGxEZWNpc2lvbnNGcm9tTWVtb3JpZXMoKTtcbiAgICBhc3NlcnQuZXF1YWwoYWxsLmxlbmd0aCwgMik7XG4gICAgY29uc3QgZDAwMSA9IGFsbC5maW5kKChkKSA9PiBkLmlkID09PSBcIkQwMDFcIik7XG4gICAgY29uc3QgZDAwMiA9IGFsbC5maW5kKChkKSA9PiBkLmlkID09PSBcIkQwMDJcIik7XG4gICAgYXNzZXJ0Lm9rKGQwMDEgJiYgZDAwMik7XG4gICAgYXNzZXJ0LmVxdWFsKGQwMDEuc3VwZXJzZWRlZF9ieSwgXCJEMDAyXCIsIFwic3RydWN0dXJlZEZpZWxkcy5zdXBlcnNlZGVkX2J5IG11c3QgYmUgcHJlc2VydmVkXCIpO1xuICAgIGFzc2VydC5lcXVhbChkMDAyLnN1cGVyc2VkZWRfYnksIG51bGwpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiYmFja2ZpbGwgaXMgaWRlbXBvdGVudCBcdTIwMTQgcmUtcnVubmluZyBvdmVyIG1pZ3JhdGVkIHJvd3MgaXMgYSBuby1vcFwiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIHNlZWRSYXdEZWNpc2lvbih7XG4gICAgICBpZDogXCJEMDAxXCIsXG4gICAgICB3aGVuX2NvbnRleHQ6IFwiTTAwMVwiLFxuICAgICAgc2NvcGU6IFwiTTAwMVwiLFxuICAgICAgZGVjaXNpb246IFwieFwiLFxuICAgICAgY2hvaWNlOiBcInlcIixcbiAgICAgIHJhdGlvbmFsZTogXCJ6XCIsXG4gICAgfSk7XG5cbiAgICBjb25zdCBmaXJzdCA9IGJhY2tmaWxsRGVjaXNpb25zVG9NZW1vcmllcygpO1xuICAgIGFzc2VydC5lcXVhbChmaXJzdCwgMSk7XG4gICAgY29uc3Qgc2Vjb25kID0gYmFja2ZpbGxEZWNpc2lvbnNUb01lbW9yaWVzKCk7XG4gICAgYXNzZXJ0LmVxdWFsKHNlY29uZCwgMCwgXCJhbHJlYWR5LW1pZ3JhdGVkIHJvd3MgbXVzdCBub3QgYmUgcmUtaW5zZXJ0ZWRcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBEcmlmdCBhdXRvLWhlYWwgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJiYWNrZmlsbCBhdXRvLWhlYWxzIHdoZW4gYSBzb3VyY2UgZGVjaXNpb24ncyBzdXBlcnNlZGVkX2J5IGNoYW5nZXMgYWZ0ZXIgbWlncmF0aW9uXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgc2VlZFJhd0RlY2lzaW9uKHtcbiAgICAgIGlkOiBcIkQwMDFcIixcbiAgICAgIHdoZW5fY29udGV4dDogXCJNMDAxXCIsXG4gICAgICBzY29wZTogXCJNMDAxXCIsXG4gICAgICBkZWNpc2lvbjogXCJPcmlnaW5hbFwiLFxuICAgICAgY2hvaWNlOiBcIkFcIixcbiAgICAgIHJhdGlvbmFsZTogXCJyXCIsXG4gICAgfSk7XG4gICAgLy8gSW5pdGlhbCBtaWdyYXRpb246IEQwMDEgaXMgYWN0aXZlLlxuICAgIGJhY2tmaWxsRGVjaXNpb25zVG9NZW1vcmllcygpO1xuICAgIGNvbnN0IGJlZm9yZUhlYWwgPSBnZXRBbGxEZWNpc2lvbnNGcm9tTWVtb3JpZXMoKS5maW5kKChkKSA9PiBkLmlkID09PSBcIkQwMDFcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGJlZm9yZUhlYWw/LnN1cGVyc2VkZWRfYnksIG51bGwpO1xuXG4gICAgLy8gU2ltdWxhdGUgbWQtaW1wb3J0ZXIgc2V0dGluZyBzdXBlcnNlZGVkX2J5IG9uIHRoZSBleGlzdGluZyBkZWNpc2lvbiByb3cuXG4gICAgc2VlZFJhd0RlY2lzaW9uKHtcbiAgICAgIGlkOiBcIkQwMDJcIixcbiAgICAgIHdoZW5fY29udGV4dDogXCJNMDAxXCIsXG4gICAgICBzY29wZTogXCJNMDAxXCIsXG4gICAgICBkZWNpc2lvbjogXCJOZXdcIixcbiAgICAgIGNob2ljZTogXCJCXCIsXG4gICAgICByYXRpb25hbGU6IFwibmV3ZXJcIixcbiAgICB9KTtcbiAgICBzZXREZWNpc2lvblN1cGVyc2VkZWRCeShcIkQwMDFcIiwgXCJEMDAyXCIpO1xuXG4gICAgLy8gU2Vjb25kIGJhY2tmaWxsIHBhc3M6IHNob3VsZCBoZWFsIEQwMDEncyBtZW1vcnkgKyBtaWdyYXRlIEQwMDIuXG4gICAgYmFja2ZpbGxEZWNpc2lvbnNUb01lbW9yaWVzKCk7XG5cbiAgICBjb25zdCBhZnRlckhlYWwgPSBnZXRBbGxEZWNpc2lvbnNGcm9tTWVtb3JpZXMoKS5maW5kKChkKSA9PiBkLmlkID09PSBcIkQwMDFcIik7XG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgYWZ0ZXJIZWFsPy5zdXBlcnNlZGVkX2J5LFxuICAgICAgXCJEMDAyXCIsXG4gICAgICBcImRyaWZ0IGF1dG8taGVhbCBtdXN0IHVwZGF0ZSBzdHJ1Y3R1cmVkRmllbGRzLnN1cGVyc2VkZWRfYnkgb24gZXhpc3RpbmcgbWlncmF0ZWQgbWVtb3JpZXNcIixcbiAgICApO1xuICAgIGNvbnN0IGQwMDIgPSBnZXRBbGxEZWNpc2lvbnNGcm9tTWVtb3JpZXMoKS5maW5kKChkKSA9PiBkLmlkID09PSBcIkQwMDJcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGQwMDI/LnN1cGVyc2VkZWRfYnksIG51bGwsIFwibmV3bHktbWlncmF0ZWQgRDAwMiBzdGF5cyBhY3RpdmVcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJiYWNrZmlsbCBkcmlmdCBhdXRvLWhlYWwgdXBkYXRlcyBvbmx5IHRoZSBzZWxlY3RlZCBtZW1vcnkgcm93XCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgc2VlZFJhd0RlY2lzaW9uKHtcbiAgICAgIGlkOiBcIkQwMDFcIixcbiAgICAgIHdoZW5fY29udGV4dDogXCJNMDAxXCIsXG4gICAgICBzY29wZTogXCJNMDAxXCIsXG4gICAgICBkZWNpc2lvbjogXCJPcmlnaW5hbFwiLFxuICAgICAgY2hvaWNlOiBcIkFcIixcbiAgICAgIHJhdGlvbmFsZTogXCJyXCIsXG4gICAgfSk7XG4gICAgYmFja2ZpbGxEZWNpc2lvbnNUb01lbW9yaWVzKCk7XG5cbiAgICBjb25zdCBhZGFwdGVyID0gX2dldEFkYXB0ZXIoKTtcbiAgICBpZiAoIWFkYXB0ZXIpIHRocm93IG5ldyBFcnJvcihcIkRCIGFkYXB0ZXIgdW5hdmFpbGFibGVcIik7XG4gICAgY29uc3Qgbm93ID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuICAgIGFkYXB0ZXJcbiAgICAgIC5wcmVwYXJlKFxuICAgICAgICBgSU5TRVJUIElOVE8gbWVtb3JpZXMgKFxuICAgICAgICAgIGlkLCBjYXRlZ29yeSwgY29udGVudCwgY29uZmlkZW5jZSwgY3JlYXRlZF9hdCwgdXBkYXRlZF9hdCwgc2NvcGUsIHRhZ3MsIHN0cnVjdHVyZWRfZmllbGRzXG4gICAgICAgICkgVkFMVUVTIChcbiAgICAgICAgICA6aWQsICdhcmNoaXRlY3R1cmUnLCAnZHVwbGljYXRlIG1hcmtlcicsIDAuOCwgOmNyZWF0ZWRfYXQsIDp1cGRhdGVkX2F0LCAncHJvamVjdCcsICdbXScsIDpzdHJ1Y3R1cmVkX2ZpZWxkc1xuICAgICAgICApYCxcbiAgICAgIClcbiAgICAgIC5ydW4oe1xuICAgICAgICBcIjppZFwiOiBcIm1hbnVhbC1kdXBsaWNhdGUtRDAwMVwiLFxuICAgICAgICBcIjpjcmVhdGVkX2F0XCI6IG5vdyxcbiAgICAgICAgXCI6dXBkYXRlZF9hdFwiOiBub3csXG4gICAgICAgIFwiOnN0cnVjdHVyZWRfZmllbGRzXCI6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICBzb3VyY2VEZWNpc2lvbklkOiBcIkQwMDFcIixcbiAgICAgICAgICBzdXBlcnNlZGVkX2J5OiBudWxsLFxuICAgICAgICAgIG5vdGU6IFwibWFudWFsIGR1cGxpY2F0ZSBzaG91bGQgbm90IGJlIGhlYWxlZCBhcyBhIHNpZGUgZWZmZWN0XCIsXG4gICAgICAgIH0pLFxuICAgICAgfSk7XG5cbiAgICBzZXREZWNpc2lvblN1cGVyc2VkZWRCeShcIkQwMDFcIiwgXCJEMDAyXCIpO1xuICAgIGJhY2tmaWxsRGVjaXNpb25zVG9NZW1vcmllcygpO1xuXG4gICAgY29uc3Qgcm93cyA9IGFkYXB0ZXJcbiAgICAgIC5wcmVwYXJlKFwiU0VMRUNUIGlkLCBzdHJ1Y3R1cmVkX2ZpZWxkcyBGUk9NIG1lbW9yaWVzIFdIRVJFIHN0cnVjdHVyZWRfZmllbGRzIExJS0UgOnBhdHRlcm4gT1JERVIgQlkgc2VxXCIpXG4gICAgICAuYWxsKHsgXCI6cGF0dGVyblwiOiAnJVwic291cmNlRGVjaXNpb25JZFwiOlwiRDAwMVwiJScgfSkgYXMgQXJyYXk8e1xuICAgICAgICBpZDogc3RyaW5nO1xuICAgICAgICBzdHJ1Y3R1cmVkX2ZpZWxkczogc3RyaW5nO1xuICAgICAgfT47XG4gICAgYXNzZXJ0LmVxdWFsKHJvd3MubGVuZ3RoLCAyKTtcbiAgICBjb25zdCBoZWFsZWQgPSByb3dzLmZpbmQoKHJvdykgPT4gcm93LmlkICE9PSBcIm1hbnVhbC1kdXBsaWNhdGUtRDAwMVwiKTtcbiAgICBjb25zdCBkdXBsaWNhdGUgPSByb3dzLmZpbmQoKHJvdykgPT4gcm93LmlkID09PSBcIm1hbnVhbC1kdXBsaWNhdGUtRDAwMVwiKTtcbiAgICBhc3NlcnQuZXF1YWwoSlNPTi5wYXJzZShoZWFsZWQ/LnN0cnVjdHVyZWRfZmllbGRzID8/IFwie31cIikuc3VwZXJzZWRlZF9ieSwgXCJEMDAyXCIpO1xuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIEpTT04ucGFyc2UoZHVwbGljYXRlPy5zdHJ1Y3R1cmVkX2ZpZWxkcyA/PyBcInt9XCIpLnN1cGVyc2VkZWRfYnksXG4gICAgICBudWxsLFxuICAgICAgXCJkcmlmdCBhdXRvLWhlYWwgbXVzdCBub3QgdXBkYXRlIGV2ZXJ5IG1lbW9yeSBtYXRjaGluZyB0aGUgc291cmNlRGVjaXNpb25JZCBwYXR0ZXJuXCIsXG4gICAgKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHF1ZXJ5RGVjaXNpb25zRnJvbU1lbW9yaWVzOiBhY3RpdmUtb25seSB2aWEgc3RydWN0dXJlZEZpZWxkcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcInF1ZXJ5RGVjaXNpb25zRnJvbU1lbW9yaWVzIGZpbHRlcnMgb3V0IHJvd3Mgd2hvc2Ugc3RydWN0dXJlZEZpZWxkcy5zdXBlcnNlZGVkX2J5IGlzIHNldFwiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIHNlZWRSYXdEZWNpc2lvbih7XG4gICAgICBpZDogXCJEMDAxXCIsXG4gICAgICB3aGVuX2NvbnRleHQ6IFwiTTAwMVwiLFxuICAgICAgc2NvcGU6IFwiTTAwMVwiLFxuICAgICAgZGVjaXNpb246IFwiT2xkXCIsXG4gICAgICBjaG9pY2U6IFwiQVwiLFxuICAgICAgcmF0aW9uYWxlOiBcInIxXCIsXG4gICAgICBzdXBlcnNlZGVkX2J5OiBcIkQwMDJcIixcbiAgICB9KTtcbiAgICBzZWVkUmF3RGVjaXNpb24oe1xuICAgICAgaWQ6IFwiRDAwMlwiLFxuICAgICAgd2hlbl9jb250ZXh0OiBcIk0wMDFcIixcbiAgICAgIHNjb3BlOiBcIk0wMDFcIixcbiAgICAgIGRlY2lzaW9uOiBcIk5ld1wiLFxuICAgICAgY2hvaWNlOiBcIkJcIixcbiAgICAgIHJhdGlvbmFsZTogXCJyMlwiLFxuICAgIH0pO1xuICAgIGJhY2tmaWxsRGVjaXNpb25zVG9NZW1vcmllcygpO1xuXG4gICAgY29uc3QgYWN0aXZlID0gcXVlcnlEZWNpc2lvbnNGcm9tTWVtb3JpZXMoKTtcbiAgICBhc3NlcnQuZXF1YWwoYWN0aXZlLmxlbmd0aCwgMSwgXCJvbmx5IHRoZSBub24tc3VwZXJzZWRlZCBkZWNpc2lvbiBzaG91bGQgYXBwZWFyXCIpO1xuICAgIGFzc2VydC5lcXVhbChhY3RpdmVbMF0/LmlkLCBcIkQwMDJcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBnZXRBbGxEZWNpc2lvbnNGcm9tTWVtb3JpZXM6IGZ1bGwgcmVnaXN0ZXIgaW5jbHVkaW5nIHN1cGVyc2VkZWQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJnZXRBbGxEZWNpc2lvbnNGcm9tTWVtb3JpZXMgcmV0dXJucyB0aGUgZnVsbCByZWdpc3RlciBpbmNsdWRpbmcgc3VwZXJzZWRlZFwiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIHNlZWRSYXdEZWNpc2lvbih7XG4gICAgICBpZDogXCJEMDAxXCIsXG4gICAgICB3aGVuX2NvbnRleHQ6IFwiTTAwMVwiLFxuICAgICAgc2NvcGU6IFwiTTAwMVwiLFxuICAgICAgZGVjaXNpb246IFwiRmlyc3RcIixcbiAgICAgIGNob2ljZTogXCJBXCIsXG4gICAgICByYXRpb25hbGU6IFwicjFcIixcbiAgICAgIHN1cGVyc2VkZWRfYnk6IFwiRDAwMlwiLFxuICAgIH0pO1xuICAgIHNlZWRSYXdEZWNpc2lvbih7XG4gICAgICBpZDogXCJEMDAyXCIsXG4gICAgICB3aGVuX2NvbnRleHQ6IFwiTTAwMVwiLFxuICAgICAgc2NvcGU6IFwiTTAwMVwiLFxuICAgICAgZGVjaXNpb246IFwiU2Vjb25kXCIsXG4gICAgICBjaG9pY2U6IFwiQlwiLFxuICAgICAgcmF0aW9uYWxlOiBcInIyXCIsXG4gICAgfSk7XG4gICAgYmFja2ZpbGxEZWNpc2lvbnNUb01lbW9yaWVzKCk7XG5cbiAgICBjb25zdCBhbGwgPSBnZXRBbGxEZWNpc2lvbnNGcm9tTWVtb3JpZXMoKTtcbiAgICBhc3NlcnQuZXF1YWwoYWxsLmxlbmd0aCwgMik7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICAgIGFsbC5tYXAoKGQpID0+ICh7IGlkOiBkLmlkLCBzdXBlcnNlZGVkX2J5OiBkLnN1cGVyc2VkZWRfYnkgfSkpLFxuICAgICAgW1xuICAgICAgICB7IGlkOiBcIkQwMDFcIiwgc3VwZXJzZWRlZF9ieTogXCJEMDAyXCIgfSxcbiAgICAgICAgeyBpZDogXCJEMDAyXCIsIHN1cGVyc2VkZWRfYnk6IG51bGwgfSxcbiAgICAgIF0sXG4gICAgKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFByb2plY3Rpb24gcGFyaXR5OiBsZWdhY3kgdGFibGUgc291cmNlIHZzIG1lbW9yaWVzIHNvdXJjZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gZGVjaXNpb25Gcm9tTGVnYWN5Um93KHJvdzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBEZWNpc2lvbiB7XG4gIHJldHVybiB7XG4gICAgc2VxOiByb3dbXCJzZXFcIl0gYXMgbnVtYmVyLFxuICAgIGlkOiByb3dbXCJpZFwiXSBhcyBzdHJpbmcsXG4gICAgd2hlbl9jb250ZXh0OiByb3dbXCJ3aGVuX2NvbnRleHRcIl0gYXMgc3RyaW5nLFxuICAgIHNjb3BlOiByb3dbXCJzY29wZVwiXSBhcyBzdHJpbmcsXG4gICAgZGVjaXNpb246IHJvd1tcImRlY2lzaW9uXCJdIGFzIHN0cmluZyxcbiAgICBjaG9pY2U6IHJvd1tcImNob2ljZVwiXSBhcyBzdHJpbmcsXG4gICAgcmF0aW9uYWxlOiByb3dbXCJyYXRpb25hbGVcIl0gYXMgc3RyaW5nLFxuICAgIHJldmlzYWJsZTogcm93W1wicmV2aXNhYmxlXCJdIGFzIHN0cmluZyxcbiAgICBtYWRlX2J5OiAoKHJvd1tcIm1hZGVfYnlcIl0gYXMgc3RyaW5nKSA/PyBcImFnZW50XCIpIGFzIERlY2lzaW9uW1wibWFkZV9ieVwiXSxcbiAgICBzdXBlcnNlZGVkX2J5OiAocm93W1wic3VwZXJzZWRlZF9ieVwiXSBhcyBzdHJpbmcpID8/IG51bGwsXG4gIH07XG59XG5cbnRlc3QoXCJERUNJU0lPTlMubWQgcHJvamVjdGlvbiBmcm9tIG1lbW9yaWVzIG1hdGNoZXMgdGhlIGxlZ2FjeSBkZWNpc2lvbnMtdGFibGUgcmVuZGVyXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgLy8gU2VlZCB0aHJlZSBkZWNpc2lvbnMgd2l0aCBtaXhlZCBzdXBlcnNlZGVkIGNoYWlucyBkaXJlY3RseSBpbnRvIHRoZVxuICAgIC8vIGRlY2lzaW9ucyB0YWJsZSB0byBlbnN1cmUgdGhlIGxlZ2FjeS1zaWRlIGZpeHR1cmUgaXMgcmVhbGlzdGljLlxuICAgIHNlZWRSYXdEZWNpc2lvbih7XG4gICAgICBpZDogXCJEMDAxXCIsXG4gICAgICB3aGVuX2NvbnRleHQ6IFwiTTAwMSBkaXNjdXNzXCIsXG4gICAgICBzY29wZTogXCJNMDAxXCIsXG4gICAgICBkZWNpc2lvbjogXCJJbml0aWFsIGRpcmVjdGlvblwiLFxuICAgICAgY2hvaWNlOiBcIkFcIixcbiAgICAgIHJhdGlvbmFsZTogXCJyYXRpb25hbGUtMVwiLFxuICAgICAgc3VwZXJzZWRlZF9ieTogXCJEMDAzXCIsXG4gICAgfSk7XG4gICAgc2VlZFJhd0RlY2lzaW9uKHtcbiAgICAgIGlkOiBcIkQwMDJcIixcbiAgICAgIHdoZW5fY29udGV4dDogXCJNMDAxIHBsYW5cIixcbiAgICAgIHNjb3BlOiBcIk0wMDEtUzAxXCIsXG4gICAgICBkZWNpc2lvbjogXCJBY3RpdmUgY2FsbFwiLFxuICAgICAgY2hvaWNlOiBcIkJcIixcbiAgICAgIHJhdGlvbmFsZTogXCJyYXRpb25hbGUtMlwiLFxuICAgIH0pO1xuICAgIHNlZWRSYXdEZWNpc2lvbih7XG4gICAgICBpZDogXCJEMDAzXCIsXG4gICAgICB3aGVuX2NvbnRleHQ6IFwiTTAwMiByZXZpZXdcIixcbiAgICAgIHNjb3BlOiBcIk0wMDJcIixcbiAgICAgIGRlY2lzaW9uOiBcIlJlcGxhY2VtZW50IGZvciBEMDAxXCIsXG4gICAgICBjaG9pY2U6IFwiQ1wiLFxuICAgICAgcmF0aW9uYWxlOiBcInJhdGlvbmFsZS0zXCIsXG4gICAgfSk7XG5cbiAgICAvLyBSdW4gYmFja2ZpbGwgc28gbWVtb3JpZXMgY2FycmllcyB0aGUgZnVsbCBjaGFpbi5cbiAgICBiYWNrZmlsbERlY2lzaW9uc1RvTWVtb3JpZXMoKTtcblxuICAgIC8vIExlZ2FjeSByZW5kZXI6IHJlYWQgdGhlIGRlY2lzaW9ucyB0YWJsZSBkaXJlY3RseSwgcmVuZGVyIHZpYSB0aGVcbiAgICAvLyBleGlzdGluZyBnZW5lcmF0ZURlY2lzaW9uc01kIGhlbHBlci5cbiAgICBjb25zdCBhZGFwdGVyID0gX2dldEFkYXB0ZXIoKTtcbiAgICBpZiAoIWFkYXB0ZXIpIHRocm93IG5ldyBFcnJvcihcIkRCIGFkYXB0ZXIgdW5hdmFpbGFibGVcIik7XG4gICAgY29uc3QgbGVnYWN5Um93cyA9IGFkYXB0ZXIucHJlcGFyZShcIlNFTEVDVCAqIEZST00gZGVjaXNpb25zIE9SREVSIEJZIHNlcVwiKS5hbGwoKSBhcyBBcnJheTxcbiAgICAgIFJlY29yZDxzdHJpbmcsIHVua25vd24+XG4gICAgPjtcbiAgICBjb25zdCBsZWdhY3lEZWNpc2lvbnMgPSBsZWdhY3lSb3dzLm1hcChkZWNpc2lvbkZyb21MZWdhY3lSb3cpO1xuICAgIGNvbnN0IGxlZ2FjeU1kID0gZ2VuZXJhdGVEZWNpc2lvbnNNZChsZWdhY3lEZWNpc2lvbnMpO1xuXG4gICAgLy8gTWVtb3J5LXNvdXJjZWQgcmVuZGVyOiBzYW1lIGdlbmVyYXRvciwgYnV0IERlY2lzaW9uW10gZnJvbSBtZW1vcmllcy5cbiAgICBjb25zdCBtZW1vcnlEZWNpc2lvbnMgPSBnZXRBbGxEZWNpc2lvbnNGcm9tTWVtb3JpZXMoKTtcbiAgICBjb25zdCBtZW1vcnlNZCA9IGdlbmVyYXRlRGVjaXNpb25zTWQobWVtb3J5RGVjaXNpb25zKTtcblxuICAgIGFzc2VydC5lcXVhbChtZW1vcnlNZCwgbGVnYWN5TWQsIFwibWVtb3J5LXNvdXJjZWQgcHJvamVjdGlvbiBtdXN0IG1hdGNoIGRlY2lzaW9ucy10YWJsZSByZW5kZXIgYnl0ZS1mb3ItYnl0ZVwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcInNhdmVEZWNpc2lvblRvRGIgd3JpdGVzIGEgREVDSVNJT05TLm1kIHByb2plY3Rpb24gc291cmNlZCBmcm9tIG1lbW9yaWVzIHRoYXQgcm91bmQtdHJpcHNcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICAvLyBVc2UgdGhlIHB1YmxpYyB3cml0ZSBwYXRoIHNvIGR1YWwtd3JpdGUgKyBwcm9qZWN0aW9uIGhhcHBlbiBlbmQtdG8tZW5kLlxuICAgIGF3YWl0IHNhdmVEZWNpc2lvblRvRGIoXG4gICAgICB7XG4gICAgICAgIHdoZW5fY29udGV4dDogXCJNMDAxIGRpc2N1c3NcIixcbiAgICAgICAgc2NvcGU6IFwiTTAwMVwiLFxuICAgICAgICBkZWNpc2lvbjogXCJBZG9wdCBTUUxpdGVcIixcbiAgICAgICAgY2hvaWNlOiBcImJldHRlci1zcWxpdGUzXCIsXG4gICAgICAgIHJhdGlvbmFsZTogXCJzeW5jaHJvbm91cyArIG5hdGl2ZVwiLFxuICAgICAgICByZXZpc2FibGU6IFwiWWVzXCIsXG4gICAgICAgIG1hZGVfYnk6IFwiYWdlbnRcIixcbiAgICAgIH0sXG4gICAgICBiYXNlLFxuICAgICk7XG4gICAgYXdhaXQgc2F2ZURlY2lzaW9uVG9EYihcbiAgICAgIHtcbiAgICAgICAgd2hlbl9jb250ZXh0OiBcIk0wMDEgcGxhblwiLFxuICAgICAgICBzY29wZTogXCJNMDAxLVMwMVwiLFxuICAgICAgICBkZWNpc2lvbjogXCJTY2hlbWEgdmVyc2lvbmluZ1wiLFxuICAgICAgICBjaG9pY2U6IFwiaGVhZGVyIGNvbHVtblwiLFxuICAgICAgICByYXRpb25hbGU6IFwic2ltcGxlc3QgdG8gcmVhZFwiLFxuICAgICAgfSxcbiAgICAgIGJhc2UsXG4gICAgKTtcblxuICAgIGNvbnN0IG1kID0gcmVhZEZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiREVDSVNJT05TLm1kXCIpLCBcInV0Zi04XCIpO1xuICAgIC8vIFRoZSBwcm9qZWN0aW9uIG11c3QgaW5jbHVkZSBib3RoIHJvd3MgYnkgSUQgXHUyMDE0IHByb3ZpbmcgdGhlIHJlZ2VuXG4gICAgLy8gc291cmNlZCBmcm9tIG1lbW9yaWVzICh3aGVyZSBkdWFsLXdyaXRlIGxhbmRlZCB0aGVtKSByYXRoZXIgdGhhblxuICAgIC8vIHNpbGVudGx5IHNraXBwaW5nIGFueXRoaW5nLlxuICAgIGFzc2VydC5tYXRjaChtZCwgL1xcfCBEMDAxIFxcfC8pO1xuICAgIGFzc2VydC5tYXRjaChtZCwgL1xcfCBEMDAyIFxcfC8pO1xuICAgIGFzc2VydC5tYXRjaChtZCwgL0Fkb3B0IFNRTGl0ZS8pO1xuICAgIGFzc2VydC5tYXRjaChtZCwgL1NjaGVtYSB2ZXJzaW9uaW5nLyk7XG4gICAgYXNzZXJ0Lm1hdGNoKG1kLCAvIyBEZWNpc2lvbnMgUmVnaXN0ZXIvKTtcbiAgICBhc3NlcnQubWF0Y2gobWQsIC9cXHwgRDAwMiBcXHxbXlxcbl0qXFx8IFllcyBcXHwgYWdlbnQgXFx8Lyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJzYXZlRGVjaXNpb25Ub0RiIGluamVjdHMgYSBwcm9qZWN0aW9uIGZhbGxiYWNrIHdoZW4gbWVtb3J5IG1pcnJvciBpcyBhYnNlbnRcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBzYXZlRGVjaXNpb25Ub0RiKFxuICAgICAge1xuICAgICAgICB3aGVuX2NvbnRleHQ6IFwiTTAwMSBmYWxsYmFja1wiLFxuICAgICAgICBzY29wZTogXCJNMDAxXCIsXG4gICAgICAgIGRlY2lzaW9uOiBcIlwiLFxuICAgICAgICBjaG9pY2U6IFwiXCIsXG4gICAgICAgIHJhdGlvbmFsZTogXCJcIixcbiAgICAgIH0sXG4gICAgICBiYXNlLFxuICAgICk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmlkLCBcIkQwMDFcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGdldEFsbERlY2lzaW9uc0Zyb21NZW1vcmllcygpLnNvbWUoKGQpID0+IGQuaWQgPT09IFwiRDAwMVwiKSwgZmFsc2UpO1xuXG4gICAgY29uc3QgbWQgPSByZWFkRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJERUNJU0lPTlMubWRcIiksIFwidXRmLThcIik7XG4gICAgYXNzZXJ0Lm1hdGNoKG1kLCAvXFx8IEQwMDEgXFx8IE0wMDEgZmFsbGJhY2sgXFx8IE0wMDEgXFx8ICBcXHwgIFxcfCAgXFx8IFllcyBcXHwgYWdlbnQgXFx8Lyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFZQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxXQUFXLFFBQVEsb0JBQW9CO0FBQzdELFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFFdkI7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUNQLFNBQVMsa0JBQWtCLDJCQUEyQjtBQUN0RDtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUNQLFNBQVMsbUNBQW1DO0FBRzVDLFNBQVMsY0FBc0I7QUFDN0IsUUFBTSxPQUFPLFlBQVksS0FBSyxPQUFPLEdBQUcsd0JBQXdCLENBQUM7QUFDakUsWUFBVSxLQUFLLE1BQU0sTUFBTSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDakQsZUFBYSxLQUFLLE1BQU0sUUFBUSxRQUFRLENBQUM7QUFDekMsU0FBTztBQUNUO0FBRUEsU0FBUyxRQUFRLE1BQW9CO0FBQ25DLE1BQUk7QUFDRixrQkFBYztBQUFBLEVBQ2hCLFFBQVE7QUFBQSxFQUVSO0FBQ0EsTUFBSTtBQUNGLFdBQU8sTUFBTSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLEVBQy9DLFFBQVE7QUFBQSxFQUVSO0FBQ0Y7QUFFQSxTQUFTLGdCQUFnQixNQVVoQjtBQUNQLGlCQUFlO0FBQUEsSUFDYixJQUFJLEtBQUs7QUFBQSxJQUNULGNBQWMsS0FBSztBQUFBLElBQ25CLE9BQU8sS0FBSztBQUFBLElBQ1osVUFBVSxLQUFLO0FBQUEsSUFDZixRQUFRLEtBQUs7QUFBQSxJQUNiLFdBQVcsS0FBSztBQUFBLElBQ2hCLFdBQVcsS0FBSyxhQUFhO0FBQUEsSUFDN0IsU0FBUyxLQUFLLFdBQVc7QUFBQSxJQUN6QixlQUFlLEtBQUssaUJB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
