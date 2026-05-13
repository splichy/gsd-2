import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createDbAdapter } from "../db-adapter.js";
import { createBaseSchemaObjects } from "../db-base-schema.js";
import { columnExists } from "../db-schema-metadata.js";
import {
  applyMigrationV2Artifacts,
  applyMigrationV3Memories,
  applyMigrationV4DecisionMadeBy,
  applyMigrationV5HierarchyTables,
  applyMigrationV6SliceSummaries,
  applyMigrationV7Dependencies,
  applyMigrationV8PlanningFields,
  applyMigrationV9Ordering,
  applyMigrationV10ReplanTrigger,
  applyMigrationV11TaskPlanning,
  applyMigrationV12QualityGates,
  applyMigrationV13HotPathIndexes,
  applyMigrationV22QualityGateRepair
} from "../db-migration-steps.js";
const _require = createRequire(import.meta.url);
function openMemoryAdapter() {
  const sqlite = _require("node:sqlite");
  const raw = new sqlite.DatabaseSync(":memory:");
  const adapter = createDbAdapter(raw);
  return {
    adapter,
    close: () => adapter.close()
  };
}
function tableInfo(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all();
}
function columnNames(db, table) {
  return tableInfo(db, table).map((c) => c.name);
}
function tableExists(db, table) {
  return !!db.prepare("SELECT 1 as present FROM sqlite_master WHERE type='table' AND name=?").get(table);
}
function indexExists(db, name) {
  return !!db.prepare("SELECT 1 as present FROM sqlite_master WHERE type='index' AND name=?").get(name);
}
function viewExists(db, name) {
  return !!db.prepare("SELECT 1 as present FROM sqlite_master WHERE type='view' AND name=?").get(name);
}
describe("db base schema bring-up against :memory: sqlite", () => {
  test("createBaseSchemaObjects executes all DDL without throwing", () => {
    const { adapter, close } = openMemoryAdapter();
    try {
      assert.doesNotThrow(() => {
        createBaseSchemaObjects(adapter, {
          tryCreateMemoriesFts: () => true,
          ensureVerificationEvidenceDedupIndex: () => {
          }
        });
      });
    } finally {
      close();
    }
  });
  test("base schema produces all expected tables, indexes, and views", () => {
    const { adapter, close } = openMemoryAdapter();
    try {
      createBaseSchemaObjects(adapter, {
        tryCreateMemoriesFts: () => true,
        ensureVerificationEvidenceDedupIndex: () => {
        }
      });
      const expectedTables = [
        "schema_version",
        "decisions",
        "requirements",
        "artifacts",
        "memories",
        "memory_processed_units",
        "memory_sources",
        "memory_embeddings",
        "memory_relations",
        "milestones",
        "slices",
        "tasks",
        "verification_evidence",
        "replan_history",
        "assessments",
        "quality_gates",
        "slice_dependencies",
        "gate_runs",
        "turn_git_transactions",
        "audit_events",
        "audit_turn_index"
      ];
      for (const t of expectedTables) {
        assert.ok(tableExists(adapter, t), `expected table ${t} to exist`);
      }
      const expectedIndexes = [
        "idx_memories_active",
        "idx_replan_history_milestone",
        "idx_tasks_active",
        "idx_slices_active",
        "idx_milestones_status",
        "idx_quality_gates_pending",
        "idx_verification_evidence_task",
        "idx_slice_deps_target",
        "idx_gate_runs_turn",
        "idx_gate_runs_lookup",
        "idx_turn_git_tx_turn",
        "idx_audit_events_trace",
        "idx_audit_events_turn"
      ];
      for (const i of expectedIndexes) {
        assert.ok(indexExists(adapter, i), `expected index ${i}`);
      }
      for (const v of ["active_decisions", "active_requirements", "active_memories"]) {
        assert.ok(viewExists(adapter, v), `expected view ${v}`);
      }
    } finally {
      close();
    }
  });
  test("base schema decisions table has the documented column shape", () => {
    const { adapter, close } = openMemoryAdapter();
    try {
      createBaseSchemaObjects(adapter, {
        tryCreateMemoriesFts: () => true,
        ensureVerificationEvidenceDedupIndex: () => {
        }
      });
      const cols = tableInfo(adapter, "decisions");
      const byName = new Map(cols.map((c) => [c.name, c]));
      const seq = byName.get("seq");
      assert.ok(seq, "decisions.seq column missing");
      assert.equal(seq.type, "INTEGER");
      assert.equal(seq.pk, 1, "seq should be primary key");
      const id = byName.get("id");
      assert.ok(id);
      assert.equal(id.type, "TEXT");
      assert.equal(id.notnull, 1);
      const madeBy = byName.get("made_by");
      assert.ok(madeBy, "decisions.made_by missing (V4 migration column)");
      assert.equal(madeBy.notnull, 1);
      const source = byName.get("source");
      assert.ok(source, "decisions.source missing (V16 migration column)");
      assert.equal(source.notnull, 1);
    } finally {
      close();
    }
  });
  test("base schema tasks table promotes composite primary key correctly", () => {
    const { adapter, close } = openMemoryAdapter();
    try {
      createBaseSchemaObjects(adapter, {
        tryCreateMemoriesFts: () => true,
        ensureVerificationEvidenceDedupIndex: () => {
        }
      });
      const cols = tableInfo(adapter, "tasks");
      const pkCols = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
      assert.deepEqual(pkCols, ["milestone_id", "slice_id", "id"]);
    } finally {
      close();
    }
  });
});
describe("db migration steps end-to-end against :memory: sqlite", () => {
  function runUpToV13(adapter) {
    adapter.exec(`
      CREATE TABLE schema_version (
        version INTEGER NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    adapter.exec(`
      CREATE TABLE decisions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        when_context TEXT NOT NULL DEFAULT '',
        scope TEXT NOT NULL DEFAULT '',
        decision TEXT NOT NULL DEFAULT '',
        choice TEXT NOT NULL DEFAULT '',
        rationale TEXT NOT NULL DEFAULT '',
        revisable TEXT NOT NULL DEFAULT '',
        superseded_by TEXT DEFAULT NULL
      )
    `);
    adapter.exec(`
      CREATE TABLE requirements (
        id TEXT PRIMARY KEY,
        class TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        why TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        primary_owner TEXT NOT NULL DEFAULT '',
        supporting_slices TEXT NOT NULL DEFAULT '',
        validation TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        full_content TEXT NOT NULL DEFAULT '',
        superseded_by TEXT DEFAULT NULL
      )
    `);
    adapter.exec("CREATE VIEW active_decisions AS SELECT * FROM decisions WHERE superseded_by IS NULL");
    adapter.exec("CREATE VIEW active_requirements AS SELECT * FROM requirements WHERE superseded_by IS NULL");
    applyMigrationV2Artifacts(adapter);
    applyMigrationV3Memories(adapter);
    applyMigrationV4DecisionMadeBy(adapter);
    applyMigrationV5HierarchyTables(adapter);
    applyMigrationV6SliceSummaries(adapter);
    applyMigrationV7Dependencies(adapter);
    applyMigrationV8PlanningFields(adapter);
    applyMigrationV9Ordering(adapter);
    applyMigrationV10ReplanTrigger(adapter);
    applyMigrationV11TaskPlanning(adapter);
    applyMigrationV12QualityGates(adapter);
    applyMigrationV13HotPathIndexes(adapter, () => {
    });
  }
  test("V8 PlanningFields adds every promised ALTER column without throwing", () => {
    const { adapter, close } = openMemoryAdapter();
    try {
      runUpToV13(adapter);
      assert.ok(columnExists(adapter, "milestones", "vision"));
      assert.ok(columnExists(adapter, "milestones", "verification_uat"));
      assert.ok(columnExists(adapter, "milestones", "definition_of_done"));
      assert.ok(columnExists(adapter, "milestones", "boundary_map_markdown"));
      assert.ok(columnExists(adapter, "slices", "goal"));
      assert.ok(columnExists(adapter, "slices", "proof_level"));
      assert.ok(columnExists(adapter, "slices", "observability_impact"));
      assert.ok(columnExists(adapter, "tasks", "estimate"));
      assert.ok(columnExists(adapter, "tasks", "files"));
      assert.ok(columnExists(adapter, "tasks", "expected_output"));
      assert.ok(tableExists(adapter, "replan_history"));
      assert.ok(tableExists(adapter, "assessments"));
    } finally {
      close();
    }
  });
  test("V13 HotPathIndexes succeeds when prior migrations have run (ordering)", () => {
    const { adapter, close } = openMemoryAdapter();
    try {
      runUpToV13(adapter);
      for (const i of [
        "idx_tasks_active",
        "idx_slices_active",
        "idx_milestones_status",
        "idx_quality_gates_pending",
        "idx_verification_evidence_task"
      ]) {
        assert.ok(indexExists(adapter, i), `expected index ${i} after V13`);
      }
    } finally {
      close();
    }
  });
  test("V13 HotPathIndexes throws if quality_gates table does not yet exist (ordering guard)", () => {
    const { adapter, close } = openMemoryAdapter();
    try {
      adapter.exec("CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL)");
      assert.throws(
        () => applyMigrationV13HotPathIndexes(adapter, () => {
        }),
        /no such table/i
      );
    } finally {
      close();
    }
  });
  test("V22 QualityGateRepair rebuilds quality_gates with task_id NOT NULL and preserves indexes", () => {
    const { adapter, close } = openMemoryAdapter();
    try {
      runUpToV13(adapter);
      adapter.exec("DROP INDEX IF EXISTS idx_quality_gates_pending");
      adapter.exec("DROP TABLE quality_gates");
      adapter.exec(`
        CREATE TABLE quality_gates (
          milestone_id TEXT NOT NULL,
          slice_id TEXT NOT NULL,
          gate_id TEXT NOT NULL,
          task_id TEXT DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending',
          verdict TEXT NOT NULL DEFAULT '',
          rationale TEXT NOT NULL DEFAULT '',
          findings TEXT NOT NULL DEFAULT '',
          evaluated_at TEXT DEFAULT NULL,
          PRIMARY KEY (milestone_id, slice_id, gate_id, task_id),
          FOREIGN KEY (milestone_id, slice_id) REFERENCES slices(milestone_id, id)
        )
      `);
      const before = tableInfo(adapter, "quality_gates").find((c) => c.name === "task_id");
      assert.ok(before);
      assert.equal(before.notnull, 0, "pre-repair fixture should have nullable task_id");
      let copyCalled = 0;
      applyMigrationV22QualityGateRepair(adapter, {
        copyQualityGateRowsToRepairedTable: () => {
          copyCalled += 1;
        }
      });
      assert.equal(copyCalled, 1, "repair branch should invoke the row-copy hook exactly once");
      const after = tableInfo(adapter, "quality_gates").find((c) => c.name === "task_id");
      assert.ok(after);
      assert.equal(after.notnull, 1, "post-repair task_id must be NOT NULL");
      assert.ok(columnExists(adapter, "quality_gates", "scope"));
      assert.ok(columnExists(adapter, "assessments", "scope"));
      assert.ok(indexExists(adapter, "idx_quality_gates_pending"));
      assert.equal(tableExists(adapter, "quality_gates_new"), false);
      assert.deepEqual(columnNames(adapter, "quality_gates"), [
        "milestone_id",
        "slice_id",
        "gate_id",
        "scope",
        "task_id",
        "status",
        "verdict",
        "rationale",
        "findings",
        "evaluated_at"
      ]);
    } finally {
      close();
    }
  });
  test("V22 is a no-op on already-repaired quality_gates", () => {
    const { adapter, close } = openMemoryAdapter();
    try {
      runUpToV13(adapter);
      let copyCalled = 0;
      applyMigrationV22QualityGateRepair(adapter, {
        copyQualityGateRowsToRepairedTable: () => {
          copyCalled += 1;
        }
      });
      assert.equal(copyCalled, 0, "no-op when task_id is already NOT NULL");
      assert.ok(columnExists(adapter, "quality_gates", "scope"));
    } finally {
      close();
    }
  });
});
describe("db provider happy path against :memory: sqlite", () => {
  test("createDbAdapter wraps node:sqlite and supports exec/prepare/close", () => {
    const sqlite = _require("node:sqlite");
    const raw = new sqlite.DatabaseSync(":memory:");
    const adapter = createDbAdapter(raw);
    assert.doesNotThrow(() => adapter.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)"));
    const insert = adapter.prepare("INSERT INTO t (id, v) VALUES (?, ?)");
    insert.run(1, "alpha");
    insert.run(2, "beta");
    const selectOne = adapter.prepare("SELECT v FROM t WHERE id = ?");
    const row = selectOne.get(1);
    assert.deepEqual(row, { v: "alpha" });
    const selectAll = adapter.prepare("SELECT id, v FROM t ORDER BY id");
    const rows = selectAll.all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0]["v"], "alpha");
    assert.equal(rows[1]["v"], "beta");
    const selectAgain = adapter.prepare("SELECT v FROM t WHERE id = ?");
    assert.deepEqual(selectAgain.get(2), { v: "beta" });
    assert.doesNotThrow(() => adapter.close());
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9kYi1taWdyYXRpb24tc3RlcHMuaW50ZWdyYXRpb24udGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gZ3NkLTIgKEdTRDIpICsgZGIgbWlncmF0aW9uIGA6bWVtb3J5OmAgaW50ZWdyYXRpb24gdGVzdHNcbi8vXG4vLyBDb3ZlcnMgdGhlIGdhcCBsZWZ0IGJ5IHRoZSBGYWtlQWRhcHRlciB1bml0IHRlc3RzIGZvciB0aGUgZ3NkLWRiIHNwbGl0XG4vLyAoUFIgIzUzMDgpOiB0aG9zZSBhc3NlcnQgU1FMIHN0cmluZ3MsIG5vdCB0aGF0IERETCBhY3R1YWxseSBleGVjdXRlcy5cbi8vIFRoZXNlIHRlc3RzIG9wZW4gYSByZWFsIG5vZGU6c3FsaXRlIGA6bWVtb3J5OmAgZGF0YWJhc2UsIHJ1biB0aGUgc2NoZW1hXG4vLyBoZWxwZXJzLCBhbmQgdmVyaWZ5IHRoZSByZXN1bHRpbmcgc2NoZW1hIHZpYSBQUkFHTUEgaW50cm9zcGVjdGlvbi5cblxuaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IGNyZWF0ZVJlcXVpcmUgfSBmcm9tIFwibm9kZTptb2R1bGVcIjtcblxuaW1wb3J0IHsgY3JlYXRlRGJBZGFwdGVyLCB0eXBlIERiQWRhcHRlciB9IGZyb20gXCIuLi9kYi1hZGFwdGVyLnRzXCI7XG5pbXBvcnQgeyBjcmVhdGVCYXNlU2NoZW1hT2JqZWN0cyB9IGZyb20gXCIuLi9kYi1iYXNlLXNjaGVtYS50c1wiO1xuaW1wb3J0IHsgY29sdW1uRXhpc3RzIH0gZnJvbSBcIi4uL2RiLXNjaGVtYS1tZXRhZGF0YS50c1wiO1xuaW1wb3J0IHtcbiAgYXBwbHlNaWdyYXRpb25WMkFydGlmYWN0cyxcbiAgYXBwbHlNaWdyYXRpb25WM01lbW9yaWVzLFxuICBhcHBseU1pZ3JhdGlvblY0RGVjaXNpb25NYWRlQnksXG4gIGFwcGx5TWlncmF0aW9uVjVIaWVyYXJjaHlUYWJsZXMsXG4gIGFwcGx5TWlncmF0aW9uVjZTbGljZVN1bW1hcmllcyxcbiAgYXBwbHlNaWdyYXRpb25WN0RlcGVuZGVuY2llcyxcbiAgYXBwbHlNaWdyYXRpb25WOFBsYW5uaW5nRmllbGRzLFxuICBhcHBseU1pZ3JhdGlvblY5T3JkZXJpbmcsXG4gIGFwcGx5TWlncmF0aW9uVjEwUmVwbGFuVHJpZ2dlcixcbiAgYXBwbHlNaWdyYXRpb25WMTFUYXNrUGxhbm5pbmcsXG4gIGFwcGx5TWlncmF0aW9uVjEyUXVhbGl0eUdhdGVzLFxuICBhcHBseU1pZ3JhdGlvblYxM0hvdFBhdGhJbmRleGVzLFxuICBhcHBseU1pZ3JhdGlvblYyMlF1YWxpdHlHYXRlUmVwYWlyLFxufSBmcm9tIFwiLi4vZGItbWlncmF0aW9uLXN0ZXBzLnRzXCI7XG5cbmNvbnN0IF9yZXF1aXJlID0gY3JlYXRlUmVxdWlyZShpbXBvcnQubWV0YS51cmwpO1xuXG5pbnRlcmZhY2UgQ29sdW1uSW5mbyB7XG4gIG5hbWU6IHN0cmluZztcbiAgdHlwZTogc3RyaW5nO1xuICBub3RudWxsOiBudW1iZXI7XG4gIGRmbHRfdmFsdWU6IHVua25vd247XG4gIHBrOiBudW1iZXI7XG59XG5cbmZ1bmN0aW9uIG9wZW5NZW1vcnlBZGFwdGVyKCk6IHsgYWRhcHRlcjogRGJBZGFwdGVyOyBjbG9zZTogKCkgPT4gdm9pZCB9IHtcbiAgY29uc3Qgc3FsaXRlID0gX3JlcXVpcmUoXCJub2RlOnNxbGl0ZVwiKSBhcyB7IERhdGFiYXNlU3luYzogbmV3IChwYXRoOiBzdHJpbmcpID0+IHVua25vd24gfTtcbiAgY29uc3QgcmF3ID0gbmV3IHNxbGl0ZS5EYXRhYmFzZVN5bmMoXCI6bWVtb3J5OlwiKTtcbiAgY29uc3QgYWRhcHRlciA9IGNyZWF0ZURiQWRhcHRlcihyYXcpO1xuICByZXR1cm4ge1xuICAgIGFkYXB0ZXIsXG4gICAgY2xvc2U6ICgpID0+IGFkYXB0ZXIuY2xvc2UoKSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gdGFibGVJbmZvKGRiOiBEYkFkYXB0ZXIsIHRhYmxlOiBzdHJpbmcpOiBDb2x1bW5JbmZvW10ge1xuICByZXR1cm4gZGIucHJlcGFyZShgUFJBR01BIHRhYmxlX2luZm8oJHt0YWJsZX0pYCkuYWxsKCkgYXMgdW5rbm93biBhcyBDb2x1bW5JbmZvW107XG59XG5cbmZ1bmN0aW9uIGNvbHVtbk5hbWVzKGRiOiBEYkFkYXB0ZXIsIHRhYmxlOiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIHJldHVybiB0YWJsZUluZm8oZGIsIHRhYmxlKS5tYXAoKGMpID0+IGMubmFtZSk7XG59XG5cbmZ1bmN0aW9uIHRhYmxlRXhpc3RzKGRiOiBEYkFkYXB0ZXIsIHRhYmxlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuICEhZGJcbiAgICAucHJlcGFyZShcIlNFTEVDVCAxIGFzIHByZXNlbnQgRlJPTSBzcWxpdGVfbWFzdGVyIFdIRVJFIHR5cGU9J3RhYmxlJyBBTkQgbmFtZT0/XCIpXG4gICAgLmdldCh0YWJsZSk7XG59XG5cbmZ1bmN0aW9uIGluZGV4RXhpc3RzKGRiOiBEYkFkYXB0ZXIsIG5hbWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gISFkYlxuICAgIC5wcmVwYXJlKFwiU0VMRUNUIDEgYXMgcHJlc2VudCBGUk9NIHNxbGl0ZV9tYXN0ZXIgV0hFUkUgdHlwZT0naW5kZXgnIEFORCBuYW1lPT9cIilcbiAgICAuZ2V0KG5hbWUpO1xufVxuXG5mdW5jdGlvbiB2aWV3RXhpc3RzKGRiOiBEYkFkYXB0ZXIsIG5hbWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gISFkYlxuICAgIC5wcmVwYXJlKFwiU0VMRUNUIDEgYXMgcHJlc2VudCBGUk9NIHNxbGl0ZV9tYXN0ZXIgV0hFUkUgdHlwZT0ndmlldycgQU5EIG5hbWU9P1wiKVxuICAgIC5nZXQobmFtZSk7XG59XG5cbmRlc2NyaWJlKFwiZGIgYmFzZSBzY2hlbWEgYnJpbmctdXAgYWdhaW5zdCA6bWVtb3J5OiBzcWxpdGVcIiwgKCkgPT4ge1xuICB0ZXN0KFwiY3JlYXRlQmFzZVNjaGVtYU9iamVjdHMgZXhlY3V0ZXMgYWxsIERETCB3aXRob3V0IHRocm93aW5nXCIsICgpID0+IHtcbiAgICBjb25zdCB7IGFkYXB0ZXIsIGNsb3NlIH0gPSBvcGVuTWVtb3J5QWRhcHRlcigpO1xuICAgIHRyeSB7XG4gICAgICBhc3NlcnQuZG9lc05vdFRocm93KCgpID0+IHtcbiAgICAgICAgY3JlYXRlQmFzZVNjaGVtYU9iamVjdHMoYWRhcHRlciwge1xuICAgICAgICAgIHRyeUNyZWF0ZU1lbW9yaWVzRnRzOiAoKSA9PiB0cnVlLFxuICAgICAgICAgIGVuc3VyZVZlcmlmaWNhdGlvbkV2aWRlbmNlRGVkdXBJbmRleDogKCkgPT4ge30sXG4gICAgICAgIH0pO1xuICAgICAgfSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsb3NlKCk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwiYmFzZSBzY2hlbWEgcHJvZHVjZXMgYWxsIGV4cGVjdGVkIHRhYmxlcywgaW5kZXhlcywgYW5kIHZpZXdzXCIsICgpID0+IHtcbiAgICBjb25zdCB7IGFkYXB0ZXIsIGNsb3NlIH0gPSBvcGVuTWVtb3J5QWRhcHRlcigpO1xuICAgIHRyeSB7XG4gICAgICBjcmVhdGVCYXNlU2NoZW1hT2JqZWN0cyhhZGFwdGVyLCB7XG4gICAgICAgIHRyeUNyZWF0ZU1lbW9yaWVzRnRzOiAoKSA9PiB0cnVlLFxuICAgICAgICBlbnN1cmVWZXJpZmljYXRpb25FdmlkZW5jZURlZHVwSW5kZXg6ICgpID0+IHt9LFxuICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IGV4cGVjdGVkVGFibGVzID0gW1xuICAgICAgICBcInNjaGVtYV92ZXJzaW9uXCIsXG4gICAgICAgIFwiZGVjaXNpb25zXCIsXG4gICAgICAgIFwicmVxdWlyZW1lbnRzXCIsXG4gICAgICAgIFwiYXJ0aWZhY3RzXCIsXG4gICAgICAgIFwibWVtb3JpZXNcIixcbiAgICAgICAgXCJtZW1vcnlfcHJvY2Vzc2VkX3VuaXRzXCIsXG4gICAgICAgIFwibWVtb3J5X3NvdXJjZXNcIixcbiAgICAgICAgXCJtZW1vcnlfZW1iZWRkaW5nc1wiLFxuICAgICAgICBcIm1lbW9yeV9yZWxhdGlvbnNcIixcbiAgICAgICAgXCJtaWxlc3RvbmVzXCIsXG4gICAgICAgIFwic2xpY2VzXCIsXG4gICAgICAgIFwidGFza3NcIixcbiAgICAgICAgXCJ2ZXJpZmljYXRpb25fZXZpZGVuY2VcIixcbiAgICAgICAgXCJyZXBsYW5faGlzdG9yeVwiLFxuICAgICAgICBcImFzc2Vzc21lbnRzXCIsXG4gICAgICAgIFwicXVhbGl0eV9nYXRlc1wiLFxuICAgICAgICBcInNsaWNlX2RlcGVuZGVuY2llc1wiLFxuICAgICAgICBcImdhdGVfcnVuc1wiLFxuICAgICAgICBcInR1cm5fZ2l0X3RyYW5zYWN0aW9uc1wiLFxuICAgICAgICBcImF1ZGl0X2V2ZW50c1wiLFxuICAgICAgICBcImF1ZGl0X3R1cm5faW5kZXhcIixcbiAgICAgIF07XG4gICAgICBmb3IgKGNvbnN0IHQgb2YgZXhwZWN0ZWRUYWJsZXMpIHtcbiAgICAgICAgYXNzZXJ0Lm9rKHRhYmxlRXhpc3RzKGFkYXB0ZXIsIHQpLCBgZXhwZWN0ZWQgdGFibGUgJHt0fSB0byBleGlzdGApO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBleHBlY3RlZEluZGV4ZXMgPSBbXG4gICAgICAgIFwiaWR4X21lbW9yaWVzX2FjdGl2ZVwiLFxuICAgICAgICBcImlkeF9yZXBsYW5faGlzdG9yeV9taWxlc3RvbmVcIixcbiAgICAgICAgXCJpZHhfdGFza3NfYWN0aXZlXCIsXG4gICAgICAgIFwiaWR4X3NsaWNlc19hY3RpdmVcIixcbiAgICAgICAgXCJpZHhfbWlsZXN0b25lc19zdGF0dXNcIixcbiAgICAgICAgXCJpZHhfcXVhbGl0eV9nYXRlc19wZW5kaW5nXCIsXG4gICAgICAgIFwiaWR4X3ZlcmlmaWNhdGlvbl9ldmlkZW5jZV90YXNrXCIsXG4gICAgICAgIFwiaWR4X3NsaWNlX2RlcHNfdGFyZ2V0XCIsXG4gICAgICAgIFwiaWR4X2dhdGVfcnVuc190dXJuXCIsXG4gICAgICAgIFwiaWR4X2dhdGVfcnVuc19sb29rdXBcIixcbiAgICAgICAgXCJpZHhfdHVybl9naXRfdHhfdHVyblwiLFxuICAgICAgICBcImlkeF9hdWRpdF9ldmVudHNfdHJhY2VcIixcbiAgICAgICAgXCJpZHhfYXVkaXRfZXZlbnRzX3R1cm5cIixcbiAgICAgIF07XG4gICAgICBmb3IgKGNvbnN0IGkgb2YgZXhwZWN0ZWRJbmRleGVzKSB7XG4gICAgICAgIGFzc2VydC5vayhpbmRleEV4aXN0cyhhZGFwdGVyLCBpKSwgYGV4cGVjdGVkIGluZGV4ICR7aX1gKTtcbiAgICAgIH1cblxuICAgICAgZm9yIChjb25zdCB2IG9mIFtcImFjdGl2ZV9kZWNpc2lvbnNcIiwgXCJhY3RpdmVfcmVxdWlyZW1lbnRzXCIsIFwiYWN0aXZlX21lbW9yaWVzXCJdKSB7XG4gICAgICAgIGFzc2VydC5vayh2aWV3RXhpc3RzKGFkYXB0ZXIsIHYpLCBgZXhwZWN0ZWQgdmlldyAke3Z9YCk7XG4gICAgICB9XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsb3NlKCk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwiYmFzZSBzY2hlbWEgZGVjaXNpb25zIHRhYmxlIGhhcyB0aGUgZG9jdW1lbnRlZCBjb2x1bW4gc2hhcGVcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHsgYWRhcHRlciwgY2xvc2UgfSA9IG9wZW5NZW1vcnlBZGFwdGVyKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNyZWF0ZUJhc2VTY2hlbWFPYmplY3RzKGFkYXB0ZXIsIHtcbiAgICAgICAgdHJ5Q3JlYXRlTWVtb3JpZXNGdHM6ICgpID0+IHRydWUsXG4gICAgICAgIGVuc3VyZVZlcmlmaWNhdGlvbkV2aWRlbmNlRGVkdXBJbmRleDogKCkgPT4ge30sXG4gICAgICB9KTtcblxuICAgICAgY29uc3QgY29scyA9IHRhYmxlSW5mbyhhZGFwdGVyLCBcImRlY2lzaW9uc1wiKTtcbiAgICAgIGNvbnN0IGJ5TmFtZSA9IG5ldyBNYXAoY29scy5tYXAoKGMpID0+IFtjLm5hbWUsIGNdKSk7XG5cbiAgICAgIGNvbnN0IHNlcSA9IGJ5TmFtZS5nZXQoXCJzZXFcIik7XG4gICAgICBhc3NlcnQub2soc2VxLCBcImRlY2lzaW9ucy5zZXEgY29sdW1uIG1pc3NpbmdcIik7XG4gICAgICBhc3NlcnQuZXF1YWwoc2VxIS50eXBlLCBcIklOVEVHRVJcIik7XG4gICAgICBhc3NlcnQuZXF1YWwoc2VxIS5waywgMSwgXCJzZXEgc2hvdWxkIGJlIHByaW1hcnkga2V5XCIpO1xuXG4gICAgICBjb25zdCBpZCA9IGJ5TmFtZS5nZXQoXCJpZFwiKTtcbiAgICAgIGFzc2VydC5vayhpZCk7XG4gICAgICBhc3NlcnQuZXF1YWwoaWQhLnR5cGUsIFwiVEVYVFwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChpZCEubm90bnVsbCwgMSk7XG5cbiAgICAgIGNvbnN0IG1hZGVCeSA9IGJ5TmFtZS5nZXQoXCJtYWRlX2J5XCIpO1xuICAgICAgYXNzZXJ0Lm9rKG1hZGVCeSwgXCJkZWNpc2lvbnMubWFkZV9ieSBtaXNzaW5nIChWNCBtaWdyYXRpb24gY29sdW1uKVwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChtYWRlQnkhLm5vdG51bGwsIDEpO1xuXG4gICAgICBjb25zdCBzb3VyY2UgPSBieU5hbWUuZ2V0KFwic291cmNlXCIpO1xuICAgICAgYXNzZXJ0Lm9rKHNvdXJjZSwgXCJkZWNpc2lvbnMuc291cmNlIG1pc3NpbmcgKFYxNiBtaWdyYXRpb24gY29sdW1uKVwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChzb3VyY2UhLm5vdG51bGwsIDEpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbG9zZSgpO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcImJhc2Ugc2NoZW1hIHRhc2tzIHRhYmxlIHByb21vdGVzIGNvbXBvc2l0ZSBwcmltYXJ5IGtleSBjb3JyZWN0bHlcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHsgYWRhcHRlciwgY2xvc2UgfSA9IG9wZW5NZW1vcnlBZGFwdGVyKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNyZWF0ZUJhc2VTY2hlbWFPYmplY3RzKGFkYXB0ZXIsIHtcbiAgICAgICAgdHJ5Q3JlYXRlTWVtb3JpZXNGdHM6ICgpID0+IHRydWUsXG4gICAgICAgIGVuc3VyZVZlcmlmaWNhdGlvbkV2aWRlbmNlRGVkdXBJbmRleDogKCkgPT4ge30sXG4gICAgICB9KTtcblxuICAgICAgY29uc3QgY29scyA9IHRhYmxlSW5mbyhhZGFwdGVyLCBcInRhc2tzXCIpO1xuICAgICAgY29uc3QgcGtDb2xzID0gY29scy5maWx0ZXIoKGMpID0+IGMucGsgPiAwKS5zb3J0KChhLCBiKSA9PiBhLnBrIC0gYi5waykubWFwKChjKSA9PiBjLm5hbWUpO1xuICAgICAgYXNzZXJ0LmRlZXBFcXVhbChwa0NvbHMsIFtcIm1pbGVzdG9uZV9pZFwiLCBcInNsaWNlX2lkXCIsIFwiaWRcIl0pO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbG9zZSgpO1xuICAgIH1cbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoXCJkYiBtaWdyYXRpb24gc3RlcHMgZW5kLXRvLWVuZCBhZ2FpbnN0IDptZW1vcnk6IHNxbGl0ZVwiLCAoKSA9PiB7XG4gIC8vIERyaXZlIGEgZnJlc2ggREIgZnJvbSBWMSBiYXNlbGluZSB1cCB0byBWMTMgc28gZWFjaCBoaWdoLXJpc2sgbWlncmF0aW9uXG4gIC8vIHNlZXMgYSByZWFsaXN0aWMgc2NoZW1hIChub3QgdGhlIEZha2VBZGFwdGVyIG5vLW9wIHN1cmZhY2UpLlxuICBmdW5jdGlvbiBydW5VcFRvVjEzKGFkYXB0ZXI6IERiQWRhcHRlcik6IHZvaWQge1xuICAgIGFkYXB0ZXIuZXhlYyhgXG4gICAgICBDUkVBVEUgVEFCTEUgc2NoZW1hX3ZlcnNpb24gKFxuICAgICAgICB2ZXJzaW9uIElOVEVHRVIgTk9UIE5VTEwsXG4gICAgICAgIGFwcGxpZWRfYXQgVEVYVCBOT1QgTlVMTFxuICAgICAgKVxuICAgIGApO1xuICAgIGFkYXB0ZXIuZXhlYyhgXG4gICAgICBDUkVBVEUgVEFCTEUgZGVjaXNpb25zIChcbiAgICAgICAgc2VxIElOVEVHRVIgUFJJTUFSWSBLRVkgQVVUT0lOQ1JFTUVOVCxcbiAgICAgICAgaWQgVEVYVCBOT1QgTlVMTCBVTklRVUUsXG4gICAgICAgIHdoZW5fY29udGV4dCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICAgIHNjb3BlIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgICAgZGVjaXNpb24gVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgICBjaG9pY2UgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgICByYXRpb25hbGUgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgICByZXZpc2FibGUgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgICBzdXBlcnNlZGVkX2J5IFRFWFQgREVGQVVMVCBOVUxMXG4gICAgICApXG4gICAgYCk7XG4gICAgYWRhcHRlci5leGVjKGBcbiAgICAgIENSRUFURSBUQUJMRSByZXF1aXJlbWVudHMgKFxuICAgICAgICBpZCBURVhUIFBSSU1BUlkgS0VZLFxuICAgICAgICBjbGFzcyBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICAgIHN0YXR1cyBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICAgIGRlc2NyaXB0aW9uIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgICAgd2h5IFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgICAgc291cmNlIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgICAgcHJpbWFyeV9vd25lciBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICAgIHN1cHBvcnRpbmdfc2xpY2VzIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgICAgdmFsaWRhdGlvbiBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICAgIG5vdGVzIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgICAgZnVsbF9jb250ZW50IFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgICAgc3VwZXJzZWRlZF9ieSBURVhUIERFRkFVTFQgTlVMTFxuICAgICAgKVxuICAgIGApO1xuICAgIGFkYXB0ZXIuZXhlYyhcIkNSRUFURSBWSUVXIGFjdGl2ZV9kZWNpc2lvbnMgQVMgU0VMRUNUICogRlJPTSBkZWNpc2lvbnMgV0hFUkUgc3VwZXJzZWRlZF9ieSBJUyBOVUxMXCIpO1xuICAgIGFkYXB0ZXIuZXhlYyhcIkNSRUFURSBWSUVXIGFjdGl2ZV9yZXF1aXJlbWVudHMgQVMgU0VMRUNUICogRlJPTSByZXF1aXJlbWVudHMgV0hFUkUgc3VwZXJzZWRlZF9ieSBJUyBOVUxMXCIpO1xuXG4gICAgYXBwbHlNaWdyYXRpb25WMkFydGlmYWN0cyhhZGFwdGVyKTtcbiAgICBhcHBseU1pZ3JhdGlvblYzTWVtb3JpZXMoYWRhcHRlcik7XG4gICAgYXBwbHlNaWdyYXRpb25WNERlY2lzaW9uTWFkZUJ5KGFkYXB0ZXIpO1xuICAgIGFwcGx5TWlncmF0aW9uVjVIaWVyYXJjaHlUYWJsZXMoYWRhcHRlcik7XG4gICAgYXBwbHlNaWdyYXRpb25WNlNsaWNlU3VtbWFyaWVzKGFkYXB0ZXIpO1xuICAgIGFwcGx5TWlncmF0aW9uVjdEZXBlbmRlbmNpZXMoYWRhcHRlcik7XG4gICAgYXBwbHlNaWdyYXRpb25WOFBsYW5uaW5nRmllbGRzKGFkYXB0ZXIpO1xuICAgIGFwcGx5TWlncmF0aW9uVjlPcmRlcmluZyhhZGFwdGVyKTtcbiAgICBhcHBseU1pZ3JhdGlvblYxMFJlcGxhblRyaWdnZXIoYWRhcHRlcik7XG4gICAgYXBwbHlNaWdyYXRpb25WMTFUYXNrUGxhbm5pbmcoYWRhcHRlcik7XG4gICAgYXBwbHlNaWdyYXRpb25WMTJRdWFsaXR5R2F0ZXMoYWRhcHRlcik7XG4gICAgYXBwbHlNaWdyYXRpb25WMTNIb3RQYXRoSW5kZXhlcyhhZGFwdGVyLCAoKSA9PiB7fSk7XG4gIH1cblxuICB0ZXN0KFwiVjggUGxhbm5pbmdGaWVsZHMgYWRkcyBldmVyeSBwcm9taXNlZCBBTFRFUiBjb2x1bW4gd2l0aG91dCB0aHJvd2luZ1wiLCAoKSA9PiB7XG4gICAgY29uc3QgeyBhZGFwdGVyLCBjbG9zZSB9ID0gb3Blbk1lbW9yeUFkYXB0ZXIoKTtcbiAgICB0cnkge1xuICAgICAgcnVuVXBUb1YxMyhhZGFwdGVyKTtcblxuICAgICAgYXNzZXJ0Lm9rKGNvbHVtbkV4aXN0cyhhZGFwdGVyLCBcIm1pbGVzdG9uZXNcIiwgXCJ2aXNpb25cIikpO1xuICAgICAgYXNzZXJ0Lm9rKGNvbHVtbkV4aXN0cyhhZGFwdGVyLCBcIm1pbGVzdG9uZXNcIiwgXCJ2ZXJpZmljYXRpb25fdWF0XCIpKTtcbiAgICAgIGFzc2VydC5vayhjb2x1bW5FeGlzdHMoYWRhcHRlciwgXCJtaWxlc3RvbmVzXCIsIFwiZGVmaW5pdGlvbl9vZl9kb25lXCIpKTtcbiAgICAgIGFzc2VydC5vayhjb2x1bW5FeGlzdHMoYWRhcHRlciwgXCJtaWxlc3RvbmVzXCIsIFwiYm91bmRhcnlfbWFwX21hcmtkb3duXCIpKTtcblxuICAgICAgYXNzZXJ0Lm9rKGNvbHVtbkV4aXN0cyhhZGFwdGVyLCBcInNsaWNlc1wiLCBcImdvYWxcIikpO1xuICAgICAgYXNzZXJ0Lm9rKGNvbHVtbkV4aXN0cyhhZGFwdGVyLCBcInNsaWNlc1wiLCBcInByb29mX2xldmVsXCIpKTtcbiAgICAgIGFzc2VydC5vayhjb2x1bW5FeGlzdHMoYWRhcHRlciwgXCJzbGljZXNcIiwgXCJvYnNlcnZhYmlsaXR5X2ltcGFjdFwiKSk7XG5cbiAgICAgIGFzc2VydC5vayhjb2x1bW5FeGlzdHMoYWRhcHRlciwgXCJ0YXNrc1wiLCBcImVzdGltYXRlXCIpKTtcbiAgICAgIGFzc2VydC5vayhjb2x1bW5FeGlzdHMoYWRhcHRlciwgXCJ0YXNrc1wiLCBcImZpbGVzXCIpKTtcbiAgICAgIGFzc2VydC5vayhjb2x1bW5FeGlzdHMoYWRhcHRlciwgXCJ0YXNrc1wiLCBcImV4cGVjdGVkX291dHB1dFwiKSk7XG5cbiAgICAgIGFzc2VydC5vayh0YWJsZUV4aXN0cyhhZGFwdGVyLCBcInJlcGxhbl9oaXN0b3J5XCIpKTtcbiAgICAgIGFzc2VydC5vayh0YWJsZUV4aXN0cyhhZGFwdGVyLCBcImFzc2Vzc21lbnRzXCIpKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xvc2UoKTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJWMTMgSG90UGF0aEluZGV4ZXMgc3VjY2VlZHMgd2hlbiBwcmlvciBtaWdyYXRpb25zIGhhdmUgcnVuIChvcmRlcmluZylcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHsgYWRhcHRlciwgY2xvc2UgfSA9IG9wZW5NZW1vcnlBZGFwdGVyKCk7XG4gICAgdHJ5IHtcbiAgICAgIHJ1blVwVG9WMTMoYWRhcHRlcik7XG5cbiAgICAgIGZvciAoY29uc3QgaSBvZiBbXG4gICAgICAgIFwiaWR4X3Rhc2tzX2FjdGl2ZVwiLFxuICAgICAgICBcImlkeF9zbGljZXNfYWN0aXZlXCIsXG4gICAgICAgIFwiaWR4X21pbGVzdG9uZXNfc3RhdHVzXCIsXG4gICAgICAgIFwiaWR4X3F1YWxpdHlfZ2F0ZXNfcGVuZGluZ1wiLFxuICAgICAgICBcImlkeF92ZXJpZmljYXRpb25fZXZpZGVuY2VfdGFza1wiLFxuICAgICAgXSkge1xuICAgICAgICBhc3NlcnQub2soaW5kZXhFeGlzdHMoYWRhcHRlciwgaSksIGBleHBlY3RlZCBpbmRleCAke2l9IGFmdGVyIFYxM2ApO1xuICAgICAgfVxuICAgIH0gZmluYWxseSB7XG4gICAgICBjbG9zZSgpO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcIlYxMyBIb3RQYXRoSW5kZXhlcyB0aHJvd3MgaWYgcXVhbGl0eV9nYXRlcyB0YWJsZSBkb2VzIG5vdCB5ZXQgZXhpc3QgKG9yZGVyaW5nIGd1YXJkKVwiLCAoKSA9PiB7XG4gICAgY29uc3QgeyBhZGFwdGVyLCBjbG9zZSB9ID0gb3Blbk1lbW9yeUFkYXB0ZXIoKTtcbiAgICB0cnkge1xuICAgICAgYWRhcHRlci5leGVjKFwiQ1JFQVRFIFRBQkxFIHNjaGVtYV92ZXJzaW9uICh2ZXJzaW9uIElOVEVHRVIgTk9UIE5VTEwsIGFwcGxpZWRfYXQgVEVYVCBOT1QgTlVMTClcIik7XG4gICAgICBhc3NlcnQudGhyb3dzKFxuICAgICAgICAoKSA9PiBhcHBseU1pZ3JhdGlvblYxM0hvdFBhdGhJbmRleGVzKGFkYXB0ZXIsICgpID0+IHt9KSxcbiAgICAgICAgL25vIHN1Y2ggdGFibGUvaSxcbiAgICAgICk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsb3NlKCk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwiVjIyIFF1YWxpdHlHYXRlUmVwYWlyIHJlYnVpbGRzIHF1YWxpdHlfZ2F0ZXMgd2l0aCB0YXNrX2lkIE5PVCBOVUxMIGFuZCBwcmVzZXJ2ZXMgaW5kZXhlc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgeyBhZGFwdGVyLCBjbG9zZSB9ID0gb3Blbk1lbW9yeUFkYXB0ZXIoKTtcbiAgICB0cnkge1xuICAgICAgcnVuVXBUb1YxMyhhZGFwdGVyKTtcblxuICAgICAgYWRhcHRlci5leGVjKFwiRFJPUCBJTkRFWCBJRiBFWElTVFMgaWR4X3F1YWxpdHlfZ2F0ZXNfcGVuZGluZ1wiKTtcbiAgICAgIGFkYXB0ZXIuZXhlYyhcIkRST1AgVEFCTEUgcXVhbGl0eV9nYXRlc1wiKTtcbiAgICAgIGFkYXB0ZXIuZXhlYyhgXG4gICAgICAgIENSRUFURSBUQUJMRSBxdWFsaXR5X2dhdGVzIChcbiAgICAgICAgICBtaWxlc3RvbmVfaWQgVEVYVCBOT1QgTlVMTCxcbiAgICAgICAgICBzbGljZV9pZCBURVhUIE5PVCBOVUxMLFxuICAgICAgICAgIGdhdGVfaWQgVEVYVCBOT1QgTlVMTCxcbiAgICAgICAgICB0YXNrX2lkIFRFWFQgREVGQVVMVCAnJyxcbiAgICAgICAgICBzdGF0dXMgVEVYVCBOT1QgTlVMTCBERUZBVUxUICdwZW5kaW5nJyxcbiAgICAgICAgICB2ZXJkaWN0IFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgICAgICByYXRpb25hbGUgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgICAgIGZpbmRpbmdzIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgICAgICBldmFsdWF0ZWRfYXQgVEVYVCBERUZBVUxUIE5VTEwsXG4gICAgICAgICAgUFJJTUFSWSBLRVkgKG1pbGVzdG9uZV9pZCwgc2xpY2VfaWQsIGdhdGVfaWQsIHRhc2tfaWQpLFxuICAgICAgICAgIEZPUkVJR04gS0VZIChtaWxlc3RvbmVfaWQsIHNsaWNlX2lkKSBSRUZFUkVOQ0VTIHNsaWNlcyhtaWxlc3RvbmVfaWQsIGlkKVxuICAgICAgICApXG4gICAgICBgKTtcblxuICAgICAgY29uc3QgYmVmb3JlID0gdGFibGVJbmZvKGFkYXB0ZXIsIFwicXVhbGl0eV9nYXRlc1wiKS5maW5kKChjKSA9PiBjLm5hbWUgPT09IFwidGFza19pZFwiKTtcbiAgICAgIGFzc2VydC5vayhiZWZvcmUpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGJlZm9yZSEubm90bnVsbCwgMCwgXCJwcmUtcmVwYWlyIGZpeHR1cmUgc2hvdWxkIGhhdmUgbnVsbGFibGUgdGFza19pZFwiKTtcblxuICAgICAgbGV0IGNvcHlDYWxsZWQgPSAwO1xuICAgICAgYXBwbHlNaWdyYXRpb25WMjJRdWFsaXR5R2F0ZVJlcGFpcihhZGFwdGVyLCB7XG4gICAgICAgIGNvcHlRdWFsaXR5R2F0ZVJvd3NUb1JlcGFpcmVkVGFibGU6ICgpID0+IHtcbiAgICAgICAgICBjb3B5Q2FsbGVkICs9IDE7XG4gICAgICAgIH0sXG4gICAgICB9KTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKGNvcHlDYWxsZWQsIDEsIFwicmVwYWlyIGJyYW5jaCBzaG91bGQgaW52b2tlIHRoZSByb3ctY29weSBob29rIGV4YWN0bHkgb25jZVwiKTtcblxuICAgICAgY29uc3QgYWZ0ZXIgPSB0YWJsZUluZm8oYWRhcHRlciwgXCJxdWFsaXR5X2dhdGVzXCIpLmZpbmQoKGMpID0+IGMubmFtZSA9PT0gXCJ0YXNrX2lkXCIpO1xuICAgICAgYXNzZXJ0Lm9rKGFmdGVyKTtcbiAgICAgIGFzc2VydC5lcXVhbChhZnRlciEubm90bnVsbCwgMSwgXCJwb3N0LXJlcGFpciB0YXNrX2lkIG11c3QgYmUgTk9UIE5VTExcIik7XG5cbiAgICAgIGFzc2VydC5vayhjb2x1bW5FeGlzdHMoYWRhcHRlciwgXCJxdWFsaXR5X2dhdGVzXCIsIFwic2NvcGVcIikpO1xuICAgICAgYXNzZXJ0Lm9rKGNvbHVtbkV4aXN0cyhhZGFwdGVyLCBcImFzc2Vzc21lbnRzXCIsIFwic2NvcGVcIikpO1xuXG4gICAgICBhc3NlcnQub2soaW5kZXhFeGlzdHMoYWRhcHRlciwgXCJpZHhfcXVhbGl0eV9nYXRlc19wZW5kaW5nXCIpKTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKHRhYmxlRXhpc3RzKGFkYXB0ZXIsIFwicXVhbGl0eV9nYXRlc19uZXdcIiksIGZhbHNlKTtcblxuICAgICAgYXNzZXJ0LmRlZXBFcXVhbChjb2x1bW5OYW1lcyhhZGFwdGVyLCBcInF1YWxpdHlfZ2F0ZXNcIiksIFtcbiAgICAgICAgXCJtaWxlc3RvbmVfaWRcIixcbiAgICAgICAgXCJzbGljZV9pZFwiLFxuICAgICAgICBcImdhdGVfaWRcIixcbiAgICAgICAgXCJzY29wZVwiLFxuICAgICAgICBcInRhc2tfaWRcIixcbiAgICAgICAgXCJzdGF0dXNcIixcbiAgICAgICAgXCJ2ZXJkaWN0XCIsXG4gICAgICAgIFwicmF0aW9uYWxlXCIsXG4gICAgICAgIFwiZmluZGluZ3NcIixcbiAgICAgICAgXCJldmFsdWF0ZWRfYXRcIixcbiAgICAgIF0pO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbG9zZSgpO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcIlYyMiBpcyBhIG5vLW9wIG9uIGFscmVhZHktcmVwYWlyZWQgcXVhbGl0eV9nYXRlc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgeyBhZGFwdGVyLCBjbG9zZSB9ID0gb3Blbk1lbW9yeUFkYXB0ZXIoKTtcbiAgICB0cnkge1xuICAgICAgcnVuVXBUb1YxMyhhZGFwdGVyKTtcblxuICAgICAgbGV0IGNvcHlDYWxsZWQgPSAwO1xuICAgICAgYXBwbHlNaWdyYXRpb25WMjJRdWFsaXR5R2F0ZVJlcGFpcihhZGFwdGVyLCB7XG4gICAgICAgIGNvcHlRdWFsaXR5R2F0ZVJvd3NUb1JlcGFpcmVkVGFibGU6ICgpID0+IHtcbiAgICAgICAgICBjb3B5Q2FsbGVkICs9IDE7XG4gICAgICAgIH0sXG4gICAgICB9KTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKGNvcHlDYWxsZWQsIDAsIFwibm8tb3Agd2hlbiB0YXNrX2lkIGlzIGFscmVhZHkgTk9UIE5VTExcIik7XG4gICAgICBhc3NlcnQub2soY29sdW1uRXhpc3RzKGFkYXB0ZXIsIFwicXVhbGl0eV9nYXRlc1wiLCBcInNjb3BlXCIpKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xvc2UoKTtcbiAgICB9XG4gIH0pO1xufSk7XG5cbmRlc2NyaWJlKFwiZGIgcHJvdmlkZXIgaGFwcHkgcGF0aCBhZ2FpbnN0IDptZW1vcnk6IHNxbGl0ZVwiLCAoKSA9PiB7XG4gIHRlc3QoXCJjcmVhdGVEYkFkYXB0ZXIgd3JhcHMgbm9kZTpzcWxpdGUgYW5kIHN1cHBvcnRzIGV4ZWMvcHJlcGFyZS9jbG9zZVwiLCAoKSA9PiB7XG4gICAgY29uc3Qgc3FsaXRlID0gX3JlcXVpcmUoXCJub2RlOnNxbGl0ZVwiKSBhcyB7IERhdGFiYXNlU3luYzogbmV3IChwYXRoOiBzdHJpbmcpID0+IHVua25vd24gfTtcbiAgICBjb25zdCByYXcgPSBuZXcgc3FsaXRlLkRhdGFiYXNlU3luYyhcIjptZW1vcnk6XCIpO1xuICAgIGNvbnN0IGFkYXB0ZXIgPSBjcmVhdGVEYkFkYXB0ZXIocmF3KTtcblxuICAgIGFzc2VydC5kb2VzTm90VGhyb3coKCkgPT4gYWRhcHRlci5leGVjKFwiQ1JFQVRFIFRBQkxFIHQgKGlkIElOVEVHRVIgUFJJTUFSWSBLRVksIHYgVEVYVClcIikpO1xuXG4gICAgY29uc3QgaW5zZXJ0ID0gYWRhcHRlci5wcmVwYXJlKFwiSU5TRVJUIElOVE8gdCAoaWQsIHYpIFZBTFVFUyAoPywgPylcIik7XG4gICAgaW5zZXJ0LnJ1bigxLCBcImFscGhhXCIpO1xuICAgIGluc2VydC5ydW4oMiwgXCJiZXRhXCIpO1xuXG4gICAgY29uc3Qgc2VsZWN0T25lID0gYWRhcHRlci5wcmVwYXJlKFwiU0VMRUNUIHYgRlJPTSB0IFdIRVJFIGlkID0gP1wiKTtcbiAgICBjb25zdCByb3cgPSBzZWxlY3RPbmUuZ2V0KDEpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwocm93LCB7IHY6IFwiYWxwaGFcIiB9KTtcblxuICAgIGNvbnN0IHNlbGVjdEFsbCA9IGFkYXB0ZXIucHJlcGFyZShcIlNFTEVDVCBpZCwgdiBGUk9NIHQgT1JERVIgQlkgaWRcIik7XG4gICAgY29uc3Qgcm93cyA9IHNlbGVjdEFsbC5hbGwoKTtcbiAgICBhc3NlcnQuZXF1YWwocm93cy5sZW5ndGgsIDIpO1xuICAgIGFzc2VydC5lcXVhbChyb3dzWzBdW1widlwiXSwgXCJhbHBoYVwiKTtcbiAgICBhc3NlcnQuZXF1YWwocm93c1sxXVtcInZcIl0sIFwiYmV0YVwiKTtcblxuICAgIGNvbnN0IHNlbGVjdEFnYWluID0gYWRhcHRlci5wcmVwYXJlKFwiU0VMRUNUIHYgRlJPTSB0IFdIRVJFIGlkID0gP1wiKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHNlbGVjdEFnYWluLmdldCgyKSwgeyB2OiBcImJldGFcIiB9KTtcblxuICAgIGFzc2VydC5kb2VzTm90VGhyb3coKCkgPT4gYWRhcHRlci5jbG9zZSgpKTtcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQU9BLFNBQVMsVUFBVSxZQUFZO0FBQy9CLE9BQU8sWUFBWTtBQUNuQixTQUFTLHFCQUFxQjtBQUU5QixTQUFTLHVCQUF1QztBQUNoRCxTQUFTLCtCQUErQjtBQUN4QyxTQUFTLG9CQUFvQjtBQUM3QjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBRVAsTUFBTSxXQUFXLGNBQWMsWUFBWSxHQUFHO0FBVTlDLFNBQVMsb0JBQStEO0FBQ3RFLFFBQU0sU0FBUyxTQUFTLGFBQWE7QUFDckMsUUFBTSxNQUFNLElBQUksT0FBTyxhQUFhLFVBQVU7QUFDOUMsUUFBTSxVQUFVLGdCQUFnQixHQUFHO0FBQ25DLFNBQU87QUFBQSxJQUNMO0FBQUEsSUFDQSxPQUFPLE1BQU0sUUFBUSxNQUFNO0FBQUEsRUFDN0I7QUFDRjtBQUVBLFNBQVMsVUFBVSxJQUFlLE9BQTZCO0FBQzdELFNBQU8sR0FBRyxRQUFRLHFCQUFxQixLQUFLLEdBQUcsRUFBRSxJQUFJO0FBQ3ZEO0FBRUEsU0FBUyxZQUFZLElBQWUsT0FBeUI7QUFDM0QsU0FBTyxVQUFVLElBQUksS0FBSyxFQUFFLElBQUksQ0FBQyxNQUFNLEVBQUUsSUFBSTtBQUMvQztBQUVBLFNBQVMsWUFBWSxJQUFlLE9BQXdCO0FBQzFELFNBQU8sQ0FBQyxDQUFDLEdBQ04sUUFBUSxzRUFBc0UsRUFDOUUsSUFBSSxLQUFLO0FBQ2Q7QUFFQSxTQUFTLFlBQVksSUFBZSxNQUF1QjtBQUN6RCxTQUFPLENBQUMsQ0FBQyxHQUNOLFFBQVEsc0VBQXNFLEVBQzlFLElBQUksSUFBSTtBQUNiO0FBRUEsU0FBUyxXQUFXLElBQWUsTUFBdUI7QUFDeEQsU0FBTyxDQUFDLENBQUMsR0FDTixRQUFRLHFFQUFxRSxFQUM3RSxJQUFJLElBQUk7QUFDYjtBQUVBLFNBQVMsbURBQW1ELE1BQU07QUFDaEUsT0FBSyw2REFBNkQsTUFBTTtBQUN0RSxVQUFNLEVBQUUsU0FBUyxNQUFNLElBQUksa0JBQWtCO0FBQzdDLFFBQUk7QUFDRixhQUFPLGFBQWEsTUFBTTtBQUN4QixnQ0FBd0IsU0FBUztBQUFBLFVBQy9CLHNCQUFzQixNQUFNO0FBQUEsVUFDNUIsc0NBQXNDLE1BQU07QUFBQSxVQUFDO0FBQUEsUUFDL0MsQ0FBQztBQUFBLE1BQ0gsQ0FBQztBQUFBLElBQ0gsVUFBRTtBQUNBLFlBQU07QUFBQSxJQUNSO0FBQUEsRUFDRixDQUFDO0FBRUQsT0FBSyxnRUFBZ0UsTUFBTTtBQUN6RSxVQUFNLEVBQUUsU0FBUyxNQUFNLElBQUksa0JBQWtCO0FBQzdDLFFBQUk7QUFDRiw4QkFBd0IsU0FBUztBQUFBLFFBQy9CLHNCQUFzQixNQUFNO0FBQUEsUUFDNUIsc0NBQXNDLE1BQU07QUFBQSxRQUFDO0FBQUEsTUFDL0MsQ0FBQztBQUVELFlBQU0saUJBQWlCO0FBQUEsUUFDckI7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLE1BQ0Y7QUFDQSxpQkFBVyxLQUFLLGdCQUFnQjtBQUM5QixlQUFPLEdBQUcsWUFBWSxTQUFTLENBQUMsR0FBRyxrQkFBa0IsQ0FBQyxXQUFXO0FBQUEsTUFDbkU7QUFFQSxZQUFNLGtCQUFrQjtBQUFBLFFBQ3RCO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsTUFDRjtBQUNBLGlCQUFXLEtBQUssaUJBQWlCO0FBQy9CLGVBQU8sR0FBRyxZQUFZLFNBQVMsQ0FBQyxHQUFHLGtCQUFrQixDQUFDLEVBQUU7QUFBQSxNQUMxRDtBQUVBLGlCQUFXLEtBQUssQ0FBQyxvQkFBb0IsdUJBQXVCLGlCQUFpQixHQUFHO0FBQzlFLGVBQU8sR0FBRyxXQUFXLFNBQVMsQ0FBQyxHQUFHLGlCQUFpQixDQUFDLEVBQUU7QUFBQSxNQUN4RDtBQUFBLElBQ0YsVUFBRTtBQUNBLFlBQU07QUFBQSxJQUNSO0FBQUEsRUFDRixDQUFDO0FBRUQsT0FBSywrREFBK0QsTUFBTTtBQUN4RSxVQUFNLEVBQUUsU0FBUyxNQUFNLElBQUksa0JBQWtCO0FBQzdDLFFBQUk7QUFDRiw4QkFBd0IsU0FBUztBQUFBLFFBQy9CLHNCQUFzQixNQUFNO0FBQUEsUUFDNUIsc0NBQXNDLE1BQU07QUFBQSxRQUFDO0FBQUEsTUFDL0MsQ0FBQztBQUVELFlBQU0sT0FBTyxVQUFVLFNBQVMsV0FBVztBQUMzQyxZQUFNLFNBQVMsSUFBSSxJQUFJLEtBQUssSUFBSSxDQUFDLE1BQU0sQ0FBQyxFQUFFLE1BQU0sQ0FBQyxDQUFDLENBQUM7QUFFbkQsWUFBTSxNQUFNLE9BQU8sSUFBSSxLQUFLO0FBQzVCLGFBQU8sR0FBRyxLQUFLLDhCQUE4QjtBQUM3QyxhQUFPLE1BQU0sSUFBSyxNQUFNLFNBQVM7QUFDakMsYUFBTyxNQUFNLElBQUssSUFBSSxHQUFHLDJCQUEyQjtBQUVwRCxZQUFNLEtBQUssT0FBTyxJQUFJLElBQUk7QUFDMUIsYUFBTyxHQUFHLEVBQUU7QUFDWixhQUFPLE1BQU0sR0FBSSxNQUFNLE1BQU07QUFDN0IsYUFBTyxNQUFNLEdBQUksU0FBUyxDQUFDO0FBRTNCLFlBQU0sU0FBUyxPQUFPLElBQUksU0FBUztBQUNuQyxhQUFPLEdBQUcsUUFBUSxpREFBaUQ7QUFDbkUsYUFBTyxNQUFNLE9BQVEsU0FBUyxDQUFDO0FBRS9CLFlBQU0sU0FBUyxPQUFPLElBQUksUUFBUTtBQUNsQyxhQUFPLEdBQUcsUUFBUSxpREFBaUQ7QUFDbkUsYUFBTyxNQUFNLE9BQVEsU0FBUyxDQUFDO0FBQUEsSUFDakMsVUFBRTtBQUNBLFlBQU07QUFBQSxJQUNSO0FBQUEsRUFDRixDQUFDO0FBRUQsT0FBSyxvRUFBb0UsTUFBTTtBQUM3RSxVQUFNLEVBQUUsU0FBUyxNQUFNLElBQUksa0JBQWtCO0FBQzdDLFFBQUk7QUFDRiw4QkFBd0IsU0FBUztBQUFBLFFBQy9CLHNCQUFzQixNQUFNO0FBQUEsUUFDNUIsc0NBQXNDLE1BQU07QUFBQSxRQUFDO0FBQUEsTUFDL0MsQ0FBQztBQUVELFlBQU0sT0FBTyxVQUFVLFNBQVMsT0FBTztBQUN2QyxZQUFNLFNBQVMsS0FBSyxPQUFPLENBQUMsTUFBTSxFQUFFLEtBQUssQ0FBQyxFQUFFLEtBQUssQ0FBQyxHQUFHLE1BQU0sRUFBRSxLQUFLLEVBQUUsRUFBRSxFQUFFLElBQUksQ0FBQyxNQUFNLEVBQUUsSUFBSTtBQUN6RixhQUFPLFVBQVUsUUFBUSxDQUFDLGdCQUFnQixZQUFZLElBQUksQ0FBQztBQUFBLElBQzdELFVBQUU7QUFDQSxZQUFNO0FBQUEsSUFDUjtBQUFBLEVBQ0YsQ0FBQztBQUNILENBQUM7QUFFRCxTQUFTLHlEQUF5RCxNQUFNO0FBR3RFLFdBQVMsV0FBVyxTQUEwQjtBQUM1QyxZQUFRLEtBQUs7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLEtBS1o7QUFDRCxZQUFRLEtBQUs7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsS0FZWjtBQUNELFlBQVEsS0FBSztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxLQWVaO0FBQ0QsWUFBUSxLQUFLLHFGQUFxRjtBQUNsRyxZQUFRLEtBQUssMkZBQTJGO0FBRXhHLDhCQUEwQixPQUFPO0FBQ2pDLDZCQUF5QixPQUFPO0FBQ2hDLG1DQUErQixPQUFPO0FBQ3RDLG9DQUFnQyxPQUFPO0FBQ3ZDLG1DQUErQixPQUFPO0FBQ3RDLGlDQUE2QixPQUFPO0FBQ3BDLG1DQUErQixPQUFPO0FBQ3RDLDZCQUF5QixPQUFPO0FBQ2hDLG1DQUErQixPQUFPO0FBQ3RDLGtDQUE4QixPQUFPO0FBQ3JDLGtDQUE4QixPQUFPO0FBQ3JDLG9DQUFnQyxTQUFTLE1BQU07QUFBQSxJQUFDLENBQUM7QUFBQSxFQUNuRDtBQUVBLE9BQUssdUVBQXVFLE1BQU07QUFDaEYsVUFBTSxFQUFFLFNBQVMsTUFBTSxJQUFJLGtCQUFrQjtBQUM3QyxRQUFJO0FBQ0YsaUJBQVcsT0FBTztBQUVsQixhQUFPLEdBQUcsYUFBYSxTQUFTLGNBQWMsUUFBUSxDQUFDO0FBQ3ZELGFBQU8sR0FBRyxhQUFhLFNBQVMsY0FBYyxrQkFBa0IsQ0FBQztBQUNqRSxhQUFPLEdBQUcsYUFBYSxTQUFTLGNBQWMsb0JBQW9CLENBQUM7QUFDbkUsYUFBTyxHQUFHLGFBQWEsU0FBUyxjQUFjLHVCQUF1QixDQUFDO0FBRXRFLGFBQU8sR0FBRyxhQUFhLFNBQVMsVUFBVSxNQUFNLENBQUM7QUFDakQsYUFBTyxHQUFHLGFBQWEsU0FBUyxVQUFVLGFBQWEsQ0FBQztBQUN4RCxhQUFPLEdBQUcsYUFBYSxTQUFTLFVBQVUsc0JBQXNCLENBQUM7QUFFakUsYUFBTyxHQUFHLGFBQWEsU0FBUyxTQUFTLFVBQVUsQ0FBQztBQUNwRCxhQUFPLEdBQUcsYUFBYSxTQUFTLFNBQVMsT0FBTyxDQUFDO0FBQ2pELGFBQU8sR0FBRyxhQUFhLFNBQVMsU0FBUyxpQkFBaUIsQ0FBQztBQUUzRCxhQUFPLEdBQUcsWUFBWSxTQUFTLGdCQUFnQixDQUFDO0FBQ2hELGFBQU8sR0FBRyxZQUFZLFNBQVMsYUFBYSxDQUFDO0FBQUEsSUFDL0MsVUFBRTtBQUNBLFlBQU07QUFBQSxJQUNSO0FBQUEsRUFDRixDQUFDO0FBRUQsT0FBSyx5RUFBeUUsTUFBTTtBQUNsRixVQUFNLEVBQUUsU0FBUyxNQUFNLElBQUksa0JBQWtCO0FBQzdDLFFBQUk7QUFDRixpQkFBVyxPQUFPO0FBRWxCLGlCQUFXLEtBQUs7QUFBQSxRQUNkO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLE1BQ0YsR0FBRztBQUNELGVBQU8sR0FBRyxZQUFZLFNBQVMsQ0FBQyxHQUFHLGtCQUFrQixDQUFDLFlBQVk7QUFBQSxNQUNwRTtBQUFBLElBQ0YsVUFBRTtBQUNBLFlBQU07QUFBQSxJQUNSO0FBQUEsRUFDRixDQUFDO0FBRUQsT0FBSyx3RkFBd0YsTUFBTTtBQUNqRyxVQUFNLEVBQUUsU0FBUyxNQUFNLElBQUksa0JBQWtCO0FBQzdDLFFBQUk7QUFDRixjQUFRLEtBQUssa0ZBQWtGO0FBQy9GLGFBQU87QUFBQSxRQUNMLE1BQU0sZ0NBQWdDLFNBQVMsTUFBTTtBQUFBLFFBQUMsQ0FBQztBQUFBLFFBQ3ZEO0FBQUEsTUFDRjtBQUFBLElBQ0YsVUFBRTtBQUNBLFlBQU07QUFBQSxJQUNSO0FBQUEsRUFDRixDQUFDO0FBRUQsT0FBSyw0RkFBNEYsTUFBTTtBQUNyRyxVQUFNLEVBQUUsU0FBUyxNQUFNLElBQUksa0JBQWtCO0FBQzdDLFFBQUk7QUFDRixpQkFBVyxPQUFPO0FBRWxCLGNBQVEsS0FBSyxnREFBZ0Q7QUFDN0QsY0FBUSxLQUFLLDBCQUEwQjtBQUN2QyxjQUFRLEtBQUs7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLE9BY1o7QUFFRCxZQUFNLFNBQVMsVUFBVSxTQUFTLGVBQWUsRUFBRSxLQUFLLENBQUMsTUFBTSxFQUFFLFNBQVMsU0FBUztBQUNuRixhQUFPLEdBQUcsTUFBTTtBQUNoQixhQUFPLE1BQU0sT0FBUSxTQUFTLEdBQUcsaURBQWlEO0FBRWxGLFVBQUksYUFBYTtBQUNqQix5Q0FBbUMsU0FBUztBQUFBLFFBQzFDLG9DQUFvQyxNQUFNO0FBQ3hDLHdCQUFjO0FBQUEsUUFDaEI7QUFBQSxNQUNGLENBQUM7QUFFRCxhQUFPLE1BQU0sWUFBWSxHQUFHLDREQUE0RDtBQUV4RixZQUFNLFFBQVEsVUFBVSxTQUFTLGVBQWUsRUFBRSxLQUFLLENBQUMsTUFBTSxFQUFFLFNBQVMsU0FBUztBQUNsRixhQUFPLEdBQUcsS0FBSztBQUNmLGFBQU8sTUFBTSxNQUFPLFNBQVMsR0FBRyxzQ0FBc0M7QUFFdEUsYUFBTyxHQUFHLGFBQWEsU0FBUyxpQkFBaUIsT0FBTyxDQUFDO0FBQ3pELGFBQU8sR0FBRyxhQUFhLFNBQVMsZUFBZSxPQUFPLENBQUM7QUFFdkQsYUFBTyxHQUFHLFlBQVksU0FBUywyQkFBMkIsQ0FBQztBQUUzRCxhQUFPLE1BQU0sWUFBWSxTQUFTLG1CQUFtQixHQUFHLEtBQUs7QUFFN0QsYUFBTyxVQUFVLFlBQVksU0FBUyxlQUFlLEdBQUc7QUFBQSxRQUN0RDtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLE1BQ0YsQ0FBQztBQUFBLElBQ0gsVUFBRTtBQUNBLFlBQU07QUFBQSxJQUNSO0FBQUEsRUFDRixDQUFDO0FBRUQsT0FBSyxvREFBb0QsTUFBTTtBQUM3RCxVQUFNLEVBQUUsU0FBUyxNQUFNLElBQUksa0JBQWtCO0FBQzdDLFFBQUk7QUFDRixpQkFBVyxPQUFPO0FBRWxCLFVBQUksYUFBYTtBQUNqQix5Q0FBbUMsU0FBUztBQUFBLFFBQzFDLG9DQUFvQyxNQUFNO0FBQ3hDLHdCQUFjO0FBQUEsUUFDaEI7QUFBQSxNQUNGLENBQUM7QUFFRCxhQUFPLE1BQU0sWUFBWSxHQUFHLHdDQUF3QztBQUNwRSxhQUFPLEdBQUcsYUFBYSxTQUFTLGlCQUFpQixPQUFPLENBQUM7QUFBQSxJQUMzRCxVQUFFO0FBQ0EsWUFBTTtBQUFBLElBQ1I7QUFBQSxFQUNGLENBQUM7QUFDSCxDQUFDO0FBRUQsU0FBUyxrREFBa0QsTUFBTTtBQUMvRCxPQUFLLHFFQUFxRSxNQUFNO0FBQzlFLFVBQU0sU0FBUyxTQUFTLGFBQWE7QUFDckMsVUFBTSxNQUFNLElBQUksT0FBTyxhQUFhLFVBQVU7QUFDOUMsVUFBTSxVQUFVLGdCQUFnQixHQUFHO0FBRW5DLFdBQU8sYUFBYSxNQUFNLFFBQVEsS0FBSyxpREFBaUQsQ0FBQztBQUV6RixVQUFNLFNBQVMsUUFBUSxRQUFRLHFDQUFxQztBQUNwRSxXQUFPLElBQUksR0FBRyxPQUFPO0FBQ3JCLFdBQU8sSUFBSSxHQUFHLE1BQU07QUFFcEIsVUFBTSxZQUFZLFFBQVEsUUFBUSw4QkFBOEI7QUFDaEUsVUFBTSxNQUFNLFVBQVUsSUFBSSxDQUFDO0FBQzNCLFdBQU8sVUFBVSxLQUFLLEVBQUUsR0FBRyxRQUFRLENBQUM7QUFFcEMsVUFBTSxZQUFZLFFBQVEsUUFBUSxpQ0FBaUM7QUFDbkUsVUFBTSxPQUFPLFVBQVUsSUFBSTtBQUMzQixXQUFPLE1BQU0sS0FBSyxRQUFRLENBQUM7QUFDM0IsV0FBTyxNQUFNLEtBQUssQ0FBQyxFQUFFLEdBQUcsR0FBRyxPQUFPO0FBQ2xDLFdBQU8sTUFBTSxLQUFLLENBQUMsRUFBRSxHQUFHLEdBQUcsTUFBTTtBQUVqQyxVQUFNLGNBQWMsUUFBUSxRQUFRLDhCQUE4QjtBQUNsRSxXQUFPLFVBQVUsWUFBWSxJQUFJLENBQUMsR0FBRyxFQUFFLEdBQUcsT0FBTyxDQUFDO0FBRWxELFdBQU8sYUFBYSxNQUFNLFFBQVEsTUFBTSxDQUFDO0FBQUEsRUFDM0MsQ0FBQztBQUNILENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
