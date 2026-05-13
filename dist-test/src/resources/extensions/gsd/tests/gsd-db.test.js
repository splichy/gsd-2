import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createRequire } from "node:module";
import {
  openDatabase,
  closeDatabase,
  isDbAvailable,
  wasDbOpenAttempted,
  getDbProvider,
  getDbStatus,
  SCHEMA_VERSION,
  insertDecision,
  getDecisionById,
  insertRequirement,
  getRequirementById,
  getActiveDecisions,
  getActiveRequirements,
  transaction,
  readTransaction,
  isInTransaction,
  _getAdapter,
  insertMilestone,
  insertSlice,
  insertTask,
  getTask,
  getSliceTasks,
  deleteMilestone,
  clearEngineHierarchy,
  recordMilestoneCommitAttribution,
  getMilestoneCommitAttributionShas,
  checkpointDatabase,
  refreshOpenDatabaseFromDisk,
  tryCreateMemoriesFts
} from "../gsd-db.js";
import { _resetLogs, peekLogs, setStderrLoggingEnabled } from "../workflow-logger.js";
const _require = createRequire(import.meta.url);
function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-db-test-"));
  return path.join(dir, "test.db");
}
function cleanup(dbPath) {
  closeDatabase();
  try {
    const dir = path.dirname(dbPath);
    for (const f of fs.readdirSync(dir)) {
      fs.unlinkSync(path.join(dir, f));
    }
    fs.rmdirSync(dir);
  } catch {
  }
}
function withPlatform(platform, fn) {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", { value: original });
  }
}
function openRawSqliteForTest(dbPath) {
  try {
    const mod = _require("node:sqlite");
    return new mod.DatabaseSync(dbPath);
  } catch {
    const mod = _require("better-sqlite3");
    const DatabaseCtor = typeof mod === "function" ? mod : mod.default;
    return new DatabaseCtor(dbPath);
  }
}
describe("gsd-db", () => {
  test("gsd-db: provider detection", () => {
    const provider = getDbProvider();
    assert.ok(provider !== null, "provider should be non-null");
    assert.ok(
      provider === "node:sqlite" || provider === "better-sqlite3",
      `provider should be a known name, got: ${provider}`
    );
  });
  test("gsd-db: fresh DB schema init (memory)", () => {
    const ok = openDatabase(":memory:");
    assert.ok(ok, "openDatabase should return true");
    assert.ok(isDbAvailable(), "isDbAvailable should be true after open");
    const adapter = _getAdapter();
    const version = adapter.prepare("SELECT MAX(version) as version FROM schema_version").get();
    assert.deepStrictEqual(version?.["version"], SCHEMA_VERSION, `schema version should be ${SCHEMA_VERSION}`);
    const dRows = adapter.prepare("SELECT count(*) as cnt FROM decisions").get();
    assert.deepStrictEqual(dRows?.["cnt"], 0, "decisions table should exist and be empty");
    const rRows = adapter.prepare("SELECT count(*) as cnt FROM requirements").get();
    assert.deepStrictEqual(rRows?.["cnt"], 0, "requirements table should exist and be empty");
    closeDatabase();
    assert.ok(!isDbAvailable(), "isDbAvailable should be false after close");
  });
  test("gsd-db: double-init idempotency", () => {
    const dbPath = tempDbPath();
    openDatabase(dbPath);
    insertDecision({
      id: "D001",
      when_context: "test",
      scope: "global",
      decision: "test decision",
      choice: "option A",
      rationale: "because",
      revisable: "yes",
      made_by: "agent",
      superseded_by: null
    });
    closeDatabase();
    openDatabase(dbPath);
    const d = getDecisionById("D001");
    assert.ok(d !== null, "decision should survive re-init");
    assert.deepStrictEqual(d?.id, "D001", "decision ID preserved after re-init");
    const adapter = _getAdapter();
    const versions = adapter.prepare("SELECT count(*) as cnt FROM schema_version").get();
    assert.deepStrictEqual(versions?.["cnt"], 1, "schema_version should have exactly 1 row after double-init");
    cleanup(dbPath);
  });
  test("gsd-db: insert + get decision", () => {
    openDatabase(":memory:");
    insertDecision({
      id: "D042",
      when_context: "during sprint 3",
      scope: "M001/S02",
      decision: "use SQLite for storage",
      choice: "node:sqlite",
      rationale: "built-in, zero deps",
      revisable: "yes, if perf insufficient",
      made_by: "agent",
      superseded_by: null
    });
    const d = getDecisionById("D042");
    assert.ok(d !== null, "should find inserted decision");
    assert.deepStrictEqual(d?.id, "D042", "decision id");
    assert.deepStrictEqual(d?.scope, "M001/S02", "decision scope");
    assert.deepStrictEqual(d?.choice, "node:sqlite", "decision choice");
    assert.ok(typeof d?.seq === "number" && d.seq > 0, "seq should be auto-assigned positive number");
    assert.deepStrictEqual(d?.superseded_by, null, "superseded_by should be null");
    const missing = getDecisionById("D999");
    assert.deepStrictEqual(missing, null, "non-existent decision returns null");
    closeDatabase();
  });
  test("gsd-db: insert + get requirement", () => {
    openDatabase(":memory:");
    insertRequirement({
      id: "R007",
      class: "functional",
      status: "active",
      description: "System must persist decisions",
      why: "decisions inform future agents",
      source: "M001-CONTEXT",
      primary_owner: "S01",
      supporting_slices: "S02, S03",
      validation: "insert and query roundtrip",
      notes: "high priority",
      full_content: "Full text of requirement...",
      superseded_by: null
    });
    const r = getRequirementById("R007");
    assert.ok(r !== null, "should find inserted requirement");
    assert.deepStrictEqual(r?.id, "R007", "requirement id");
    assert.deepStrictEqual(r?.class, "functional", "requirement class");
    assert.deepStrictEqual(r?.status, "active", "requirement status");
    assert.deepStrictEqual(r?.primary_owner, "S01", "requirement primary_owner");
    assert.deepStrictEqual(r?.superseded_by, null, "superseded_by should be null");
    const missing = getRequirementById("R999");
    assert.deepStrictEqual(missing, null, "non-existent requirement returns null");
    closeDatabase();
  });
  test("gsd-db: active_decisions view excludes superseded", () => {
    openDatabase(":memory:");
    insertDecision({
      id: "D001",
      when_context: "early",
      scope: "global",
      decision: "use JSON files",
      choice: "JSON",
      rationale: "simple",
      revisable: "yes",
      made_by: "agent",
      superseded_by: "D002"
      // superseded!
    });
    insertDecision({
      id: "D002",
      when_context: "later",
      scope: "global",
      decision: "use SQLite",
      choice: "SQLite",
      rationale: "better querying",
      revisable: "yes",
      made_by: "agent",
      superseded_by: null
      // active
    });
    insertDecision({
      id: "D003",
      when_context: "same time",
      scope: "local",
      decision: "use WAL mode",
      choice: "WAL",
      rationale: "concurrent reads",
      revisable: "no",
      made_by: "agent",
      superseded_by: null
      // active
    });
    const active = getActiveDecisions();
    assert.deepStrictEqual(active.length, 2, "active_decisions should return 2 (not the superseded one)");
    const ids = active.map((d) => d.id).sort();
    assert.deepStrictEqual(ids, ["D002", "D003"], "active decisions should be D002 and D003");
    const d1 = getDecisionById("D001");
    assert.ok(d1 !== null, "superseded decision still exists in raw table");
    assert.deepStrictEqual(d1?.superseded_by, "D002", "superseded_by is set");
    closeDatabase();
  });
  test("gsd-db: active_requirements view excludes superseded", () => {
    openDatabase(":memory:");
    insertRequirement({
      id: "R001",
      class: "functional",
      status: "active",
      description: "old requirement",
      why: "was needed",
      source: "M001",
      primary_owner: "S01",
      supporting_slices: "",
      validation: "test",
      notes: "",
      full_content: "",
      superseded_by: "R002"
      // superseded!
    });
    insertRequirement({
      id: "R002",
      class: "functional",
      status: "active",
      description: "new requirement",
      why: "replaces R001",
      source: "M001",
      primary_owner: "S01",
      supporting_slices: "",
      validation: "test",
      notes: "",
      full_content: "",
      superseded_by: null
      // active
    });
    const active = getActiveRequirements();
    assert.deepStrictEqual(active.length, 1, "active_requirements should return 1");
    assert.deepStrictEqual(active[0]?.id, "R002", "only R002 should be active");
    const r1 = getRequirementById("R001");
    assert.ok(r1 !== null, "superseded requirement still in raw table");
    closeDatabase();
  });
  test("gsd-db: WAL mode on file-backed DB", () => {
    const dbPath = tempDbPath();
    openDatabase(dbPath);
    const adapter = _getAdapter();
    const mode = adapter.prepare("PRAGMA journal_mode").get();
    assert.deepStrictEqual(mode?.["journal_mode"], "wal", "journal_mode should be wal for file-backed DB");
    cleanup(dbPath);
  });
  test("gsd-db: mmap stays disabled on darwin file-backed DBs", () => {
    const darwinDbPath = tempDbPath();
    withPlatform("darwin", () => {
      openDatabase(darwinDbPath);
      const adapter = _getAdapter();
      const mmap = adapter.prepare("PRAGMA mmap_size").get();
      assert.deepStrictEqual(mmap?.["mmap_size"], 0, "darwin should leave mmap_size disabled");
      cleanup(darwinDbPath);
    });
    const linuxDbPath = tempDbPath();
    withPlatform("linux", () => {
      openDatabase(linuxDbPath);
      const adapter = _getAdapter();
      const mmap = adapter.prepare("PRAGMA mmap_size").get();
      assert.deepStrictEqual(mmap?.["mmap_size"], 67108864, "non-darwin should still enable mmap_size");
      cleanup(linuxDbPath);
    });
  });
  test("gsd-db: transaction rollback on error", () => {
    openDatabase(":memory:");
    insertDecision({
      id: "D010",
      when_context: "test",
      scope: "test",
      decision: "test",
      choice: "test",
      rationale: "test",
      revisable: "test",
      made_by: "agent",
      superseded_by: null
    });
    let threw = false;
    try {
      transaction(() => {
        insertDecision({
          id: "D011",
          when_context: "should be rolled back",
          scope: "test",
          decision: "test",
          choice: "test",
          rationale: "test",
          revisable: "test",
          made_by: "agent",
          superseded_by: null
        });
        throw new Error("intentional failure");
      });
    } catch (err) {
      if (err.message === "intentional failure") {
        threw = true;
      }
    }
    assert.ok(threw, "transaction should re-throw the error");
    const d11 = getDecisionById("D011");
    assert.deepStrictEqual(d11, null, "D011 should be rolled back (not found)");
    const d10 = getDecisionById("D010");
    assert.ok(d10 !== null, "D010 should survive the failed transaction");
    closeDatabase();
  });
  test("gsd-db: failed BEGIN does not poison transaction depth", () => {
    openDatabase(":memory:");
    const adapter = _getAdapter();
    const assertFailedBeginLeavesDepthClear = (label, fn) => {
      adapter.exec("BEGIN");
      try {
        let threw = false;
        try {
          fn();
        } catch {
          threw = true;
        }
        assert.equal(threw, true, `${label} should surface the SQLite BEGIN failure`);
        assert.equal(isInTransaction(), false, `${label} failed BEGIN must not leave depth active`);
      } finally {
        adapter.exec("ROLLBACK");
      }
    };
    try {
      assertFailedBeginLeavesDepthClear("transaction", () => transaction(() => void 0));
      assertFailedBeginLeavesDepthClear("readTransaction", () => readTransaction(() => void 0));
    } finally {
      closeDatabase();
    }
  });
  test("gsd-db: recreates missing verification evidence dedup index after removing duplicate rows", () => {
    const dbPath = tempDbPath();
    openDatabase(dbPath);
    let adapter = _getAdapter();
    adapter.prepare("INSERT INTO milestones (id, created_at) VALUES (?, '')").run("M001");
    adapter.prepare("INSERT INTO slices (milestone_id, id, created_at) VALUES (?, ?, '')").run("M001", "S01");
    adapter.prepare("INSERT INTO tasks (milestone_id, slice_id, id) VALUES (?, ?, ?)").run("M001", "S01", "T01");
    adapter.exec("DROP INDEX IF EXISTS idx_verification_evidence_dedup");
    const insertEvidence = adapter.prepare(
      `INSERT INTO verification_evidence (
        task_id, slice_id, milestone_id, command, exit_code, verdict, duration_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insertEvidence.run("T01", "S01", "M001", "npm test", 1, "fail", 125, "2026-04-12T00:00:00.000Z");
    insertEvidence.run("T01", "S01", "M001", "npm test", 1, "fail", 125, "2026-04-12T00:00:01.000Z");
    insertEvidence.run("T01", "S01", "M001", "npm run lint", 0, "pass", 90, "2026-04-12T00:00:02.000Z");
    closeDatabase();
    assert.equal(openDatabase(dbPath), true, "openDatabase should repair legacy duplicate evidence rows");
    adapter = _getAdapter();
    const countRow = adapter.prepare(
      `SELECT count(*) as cnt
       FROM verification_evidence
       WHERE task_id = ? AND slice_id = ? AND milestone_id = ? AND command = ? AND verdict = ?`
    ).get("T01", "S01", "M001", "npm test", "fail");
    assert.equal(countRow?.["cnt"], 1, "duplicate verification evidence rows should be deduplicated before index creation");
    const indexRow = adapter.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_verification_evidence_dedup'"
    ).get();
    assert.equal(indexRow?.["name"], "idx_verification_evidence_dedup", "dedup index should be recreated on reopen");
    cleanup(dbPath);
  });
  test("gsd-db: legacy DB missing memories.scope opens and bootstraps index columns", () => {
    const dbPath = tempDbPath();
    const legacyDb = openRawSqliteForTest(dbPath);
    legacyDb.exec(`
      CREATE TABLE schema_version (
        version INTEGER NOT NULL,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_version(version, applied_at) VALUES (17, '2026-04-20T00:00:00.000Z');
      CREATE TABLE memories (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.8,
        source_unit_type TEXT,
        source_unit_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        superseded_by TEXT DEFAULT NULL,
        hit_count INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO memories(id, category, content, created_at, updated_at)
      VALUES ('legacy-memory', 'note', 'legacy row', '2026-04-20T00:00:00.000Z', '2026-04-20T00:00:00.000Z');
    `);
    legacyDb.close();
    assert.equal(openDatabase(dbPath), true, "openDatabase should succeed for legacy DB missing memories.scope");
    const adapter = _getAdapter();
    const columns = adapter.prepare("PRAGMA table_info(memories)").all();
    const names = columns.map((row2) => row2["name"]);
    assert.ok(names.includes("scope"), "memories.scope should be added during bootstrap");
    assert.ok(names.includes("tags"), "memories.tags should be added during bootstrap");
    const row = adapter.prepare(`SELECT scope, tags FROM memories WHERE id = 'legacy-memory'`).get();
    assert.equal(row?.["scope"], "project", "legacy rows should receive default scope");
    assert.equal(row?.["tags"], "[]", "legacy rows should receive default tags");
    const index = adapter.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_memories_scope'"
    ).get();
    assert.equal(index?.["name"], "idx_memories_scope", "scope index should be created after bootstrap columns are present");
    cleanup(dbPath);
  });
  test("gsd-db: pre-v18 DB with memory_sources missing scope opens without crash (issue #4607)", () => {
    const dbPath = tempDbPath();
    const legacyDb = openRawSqliteForTest(dbPath);
    legacyDb.exec(`
      CREATE TABLE schema_version (
        version INTEGER NOT NULL,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_version(version, applied_at) VALUES (17, '2026-01-01T00:00:00.000Z');

      CREATE TABLE decisions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        when_context TEXT NOT NULL DEFAULT '',
        scope TEXT NOT NULL DEFAULT '',
        decision TEXT NOT NULL DEFAULT '',
        choice TEXT NOT NULL DEFAULT '',
        rationale TEXT NOT NULL DEFAULT '',
        revisable TEXT NOT NULL DEFAULT '',
        made_by TEXT NOT NULL DEFAULT 'agent',
        superseded_by TEXT DEFAULT NULL
      );

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
      );

      CREATE TABLE memories (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.8,
        source_unit_type TEXT,
        source_unit_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        superseded_by TEXT DEFAULT NULL,
        hit_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE memory_processed_units (
        unit_key TEXT PRIMARY KEY,
        activity_file TEXT,
        processed_at TEXT NOT NULL
      );

      -- memory_sources existed before v18 but lacked the scope column
      CREATE TABLE memory_sources (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        uri TEXT,
        title TEXT,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL UNIQUE,
        imported_at TEXT NOT NULL
      );

      CREATE TABLE milestones (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        depends_on TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT '',
        completed_at TEXT DEFAULT NULL,
        vision TEXT NOT NULL DEFAULT '',
        success_criteria TEXT NOT NULL DEFAULT '[]',
        key_risks TEXT NOT NULL DEFAULT '[]',
        proof_strategy TEXT NOT NULL DEFAULT '[]',
        verification_contract TEXT NOT NULL DEFAULT '',
        verification_integration TEXT NOT NULL DEFAULT '',
        verification_operational TEXT NOT NULL DEFAULT '',
        verification_uat TEXT NOT NULL DEFAULT '',
        definition_of_done TEXT NOT NULL DEFAULT '[]',
        requirement_coverage TEXT NOT NULL DEFAULT '',
        boundary_map_markdown TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE slices (
        milestone_id TEXT NOT NULL,
        id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        risk TEXT NOT NULL DEFAULT 'medium',
        depends TEXT NOT NULL DEFAULT '[]',
        demo TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT '',
        completed_at TEXT DEFAULT NULL,
        full_summary_md TEXT NOT NULL DEFAULT '',
        full_uat_md TEXT NOT NULL DEFAULT '',
        goal TEXT NOT NULL DEFAULT '',
        success_criteria TEXT NOT NULL DEFAULT '',
        proof_level TEXT NOT NULL DEFAULT '',
        integration_closure TEXT NOT NULL DEFAULT '',
        observability_impact TEXT NOT NULL DEFAULT '',
        sequence INTEGER DEFAULT 0,
        PRIMARY KEY (milestone_id, id)
      );

      CREATE TABLE tasks (
        milestone_id TEXT NOT NULL,
        slice_id TEXT NOT NULL,
        id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        one_liner TEXT NOT NULL DEFAULT '',
        narrative TEXT NOT NULL DEFAULT '',
        verification_result TEXT NOT NULL DEFAULT '',
        duration TEXT NOT NULL DEFAULT '',
        completed_at TEXT DEFAULT NULL,
        blocker_discovered INTEGER DEFAULT 0,
        deviations TEXT NOT NULL DEFAULT '',
        known_issues TEXT NOT NULL DEFAULT '',
        key_files TEXT NOT NULL DEFAULT '[]',
        key_decisions TEXT NOT NULL DEFAULT '[]',
        full_summary_md TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        estimate TEXT NOT NULL DEFAULT '',
        files TEXT NOT NULL DEFAULT '[]',
        verify TEXT NOT NULL DEFAULT '',
        inputs TEXT NOT NULL DEFAULT '[]',
        expected_output TEXT NOT NULL DEFAULT '[]',
        observability_impact TEXT NOT NULL DEFAULT '',
        full_plan_md TEXT NOT NULL DEFAULT '',
        sequence INTEGER DEFAULT 0,
        blocker_source TEXT NOT NULL DEFAULT '',
        escalation_pending INTEGER NOT NULL DEFAULT 0,
        escalation_awaiting_review INTEGER NOT NULL DEFAULT 0,
        escalation_artifact_path TEXT DEFAULT NULL,
        escalation_override_applied_at TEXT DEFAULT NULL,
        PRIMARY KEY (milestone_id, slice_id, id)
      );

      CREATE TABLE replan_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        milestone_id TEXT NOT NULL DEFAULT '',
        slice_id TEXT DEFAULT NULL,
        task_id TEXT DEFAULT NULL,
        summary TEXT NOT NULL DEFAULT '',
        previous_artifact_path TEXT DEFAULT NULL,
        replacement_artifact_path TEXT DEFAULT NULL,
        full_content TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE quality_gates (
        milestone_id TEXT NOT NULL,
        slice_id TEXT NOT NULL,
        gate_id TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'slice',
        task_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        verdict TEXT NOT NULL DEFAULT '',
        rationale TEXT NOT NULL DEFAULT '',
        findings TEXT NOT NULL DEFAULT '',
        evaluated_at TEXT DEFAULT NULL,
        PRIMARY KEY (milestone_id, slice_id, gate_id, task_id)
      );

      CREATE TABLE verification_evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL DEFAULT '',
        slice_id TEXT NOT NULL DEFAULT '',
        milestone_id TEXT NOT NULL DEFAULT '',
        command TEXT NOT NULL DEFAULT '',
        exit_code INTEGER DEFAULT 0,
        verdict TEXT NOT NULL DEFAULT '',
        duration_ms INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE slice_dependencies (
        milestone_id TEXT NOT NULL,
        slice_id TEXT NOT NULL,
        depends_on_slice_id TEXT NOT NULL,
        PRIMARY KEY (milestone_id, slice_id, depends_on_slice_id)
      );

      CREATE TABLE gate_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trace_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        gate_id TEXT NOT NULL,
        gate_type TEXT NOT NULL DEFAULT '',
        unit_type TEXT DEFAULT NULL,
        unit_id TEXT DEFAULT NULL,
        milestone_id TEXT DEFAULT NULL,
        slice_id TEXT DEFAULT NULL,
        task_id TEXT DEFAULT NULL,
        outcome TEXT NOT NULL DEFAULT 'pass',
        failure_class TEXT NOT NULL DEFAULT 'none',
        rationale TEXT NOT NULL DEFAULT '',
        findings TEXT NOT NULL DEFAULT '',
        attempt INTEGER NOT NULL DEFAULT 1,
        max_attempts INTEGER NOT NULL DEFAULT 1,
        retryable INTEGER NOT NULL DEFAULT 0,
        evaluated_at TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE turn_git_transactions (
        trace_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        unit_type TEXT DEFAULT NULL,
        unit_id TEXT DEFAULT NULL,
        stage TEXT NOT NULL DEFAULT 'turn-start',
        action TEXT NOT NULL DEFAULT 'status-only',
        push INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'ok',
        error TEXT DEFAULT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (trace_id, turn_id, stage)
      );

      CREATE TABLE audit_events (
        event_id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        turn_id TEXT DEFAULT NULL,
        caused_by TEXT DEFAULT NULL,
        category TEXT NOT NULL,
        type TEXT NOT NULL,
        ts TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE audit_turn_index (
        trace_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        first_ts TEXT NOT NULL,
        last_ts TEXT NOT NULL,
        event_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (trace_id, turn_id)
      );

      CREATE INDEX idx_memories_active ON memories(superseded_by);
      CREATE INDEX idx_tasks_active ON tasks(milestone_id, slice_id, status);
      CREATE INDEX idx_slices_active ON slices(milestone_id, status);
      CREATE INDEX idx_milestones_status ON milestones(status);
      CREATE INDEX idx_quality_gates_pending ON quality_gates(milestone_id, slice_id, status);
      CREATE INDEX idx_verification_evidence_task ON verification_evidence(milestone_id, slice_id, task_id);
      CREATE INDEX idx_slice_deps_target ON slice_dependencies(milestone_id, depends_on_slice_id);
      CREATE INDEX idx_tasks_escalation_pending ON tasks(milestone_id, slice_id, escalation_pending);
    `);
    legacyDb.close();
    assert.doesNotThrow(
      () => openDatabase(dbPath),
      "openDatabase must not throw on a v17 DB where memory_sources lacks scope"
    );
    const adapter = _getAdapter();
    const memCols = adapter.prepare("PRAGMA table_info(memories)").all().map((r) => r["name"]);
    assert.ok(memCols.includes("scope"), "memories.scope must be present after migration");
    const scopeIdx = adapter.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memories_scope'").get();
    assert.ok(scopeIdx, "idx_memories_scope must exist after open on v17 DB");
    const srcScopeIdx = adapter.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memory_sources_scope'").get();
    assert.ok(srcScopeIdx, "idx_memory_sources_scope must exist after open on v17 DB");
    cleanup(dbPath);
  });
  test("gsd-db: rowToTask tolerates legacy comma-separated task arrays", () => {
    openDatabase(":memory:");
    const adapter = _getAdapter();
    adapter.prepare("INSERT INTO milestones (id, created_at) VALUES (?, '')").run("M001");
    adapter.prepare("INSERT INTO slices (milestone_id, id, created_at) VALUES (?, ?, '')").run("M001", "S01");
    adapter.prepare(
      `INSERT INTO tasks (
        milestone_id, slice_id, id, key_files, key_decisions, files, inputs, expected_output
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "M001",
      "S01",
      "T01",
      "[]",
      "[]",
      "tests/test_verify.py, config.yaml, configs/roster_2026-05-11.yaml",
      "tests/test_verify.py",
      "reports/summary.md, artifacts/output.json"
    );
    const task = getTask("M001", "S01", "T01");
    assert.ok(task, "task should load successfully from DB");
    assert.deepEqual(task?.files, [
      "tests/test_verify.py",
      "config.yaml",
      "configs/roster_2026-05-11.yaml"
    ]);
    assert.deepEqual(task?.inputs, ["tests/test_verify.py"]);
    assert.deepEqual(task?.expected_output, ["reports/summary.md", "artifacts/output.json"]);
    closeDatabase();
  });
  test("gsd-db: query wrappers return null/empty when DB unavailable", () => {
    closeDatabase();
    assert.ok(!isDbAvailable(), "DB should not be available");
    const d = getDecisionById("D001");
    assert.deepStrictEqual(d, null, "getDecisionById returns null when DB closed");
    const r = getRequirementById("R001");
    assert.deepStrictEqual(r, null, "getRequirementById returns null when DB closed");
    const ad = getActiveDecisions();
    assert.deepStrictEqual(ad, [], "getActiveDecisions returns [] when DB closed");
    const ar = getActiveRequirements();
    assert.deepStrictEqual(ar, [], "getActiveRequirements returns [] when DB closed");
  });
  test("gsd-db: closeDatabase resets wasDbOpenAttempted after an intentional close", () => {
    openDatabase(":memory:");
    assert.ok(wasDbOpenAttempted(), "wasDbOpenAttempted should be true after openDatabase was called");
    closeDatabase();
    assert.ok(!isDbAvailable(), "DB should not be available after close");
    assert.ok(!wasDbOpenAttempted(), "wasDbOpenAttempted should reset after closeDatabase");
  });
  test("gsd-db: rowToTask tolerates corrupt comma-separated task arrays", () => {
    openDatabase(":memory:");
    insertMilestone({ id: "M001", status: "active" });
    insertSlice({ milestoneId: "M001", id: "S01", status: "active" });
    insertTask({
      milestoneId: "M001",
      sliceId: "S01",
      id: "T01",
      title: "Recover corrupt arrays",
      planning: {
        description: "desc",
        estimate: "small",
        files: ["src/original.ts"],
        verify: "npm test",
        inputs: ["docs/original.md"],
        expectedOutput: ["dist/original.md"],
        observabilityImpact: ""
      }
    });
    const adapter = _getAdapter();
    adapter.prepare(
      `UPDATE tasks
         SET files = ?, inputs = ?, expected_output = ?, key_files = ?, key_decisions = ?
       WHERE milestone_id = ? AND slice_id = ? AND id = ?`
    ).run(
      "src-erf/Models/foo.cs, src-erf/Models/bar.cs",
      "docs/input-a.md, docs/input-b.md",
      "dist/out-a.md, dist/out-b.md",
      "src/resources/extensions/gsd/gsd-db.ts, src/resources/extensions/gsd/state.ts",
      '"decision-1"',
      "M001",
      "S01",
      "T01"
    );
    const task = getTask("M001", "S01", "T01");
    assert.ok(task, "getTask should still return the corrupt row");
    assert.deepStrictEqual(task.files, ["src-erf/Models/foo.cs", "src-erf/Models/bar.cs"]);
    assert.deepStrictEqual(task.inputs, ["docs/input-a.md", "docs/input-b.md"]);
    assert.deepStrictEqual(task.expected_output, ["dist/out-a.md", "dist/out-b.md"]);
    assert.deepStrictEqual(
      task.key_files,
      ["src/resources/extensions/gsd/gsd-db.ts", "src/resources/extensions/gsd/state.ts"]
    );
    assert.deepStrictEqual(task.key_decisions, ["decision-1"]);
    const sliceTasks = getSliceTasks("M001", "S01");
    assert.equal(sliceTasks.length, 1, "getSliceTasks should also survive corrupt rows");
    assert.deepStrictEqual(sliceTasks[0].files, task.files);
    closeDatabase();
  });
  test("gsd-db: FTS5 unavailable warning normalizes provider typo", () => {
    const previousStderr = setStderrLoggingEnabled(false);
    _resetLogs();
    try {
      const ok = tryCreateMemoriesFts({
        exec() {
          throw new Error("no such moduel : fts5");
        },
        prepare() {
          throw new Error("prepare should not be called");
        },
        close() {
        }
      });
      assert.equal(ok, false, "FTS5 creation should report fallback");
      const warning = peekLogs().find((entry) => entry.component === "db" && entry.message.includes("FTS5 unavailable"));
      assert.ok(warning, "FTS5 fallback warning should be logged");
      assert.match(warning.message, /no such module: fts5/);
      assert.doesNotMatch(warning.message, /moduel/);
    } finally {
      _resetLogs();
      setStderrLoggingEnabled(previousStderr);
    }
  });
  describe("checkpointDatabase", () => {
    test("checkpointDatabase: flushes WAL into base file (TRUNCATE)", (t) => {
      const dbPath = tempDbPath();
      t.after(() => cleanup(dbPath));
      openDatabase(dbPath);
      transaction(() => {
        insertDecision({
          id: "D001",
          when_context: "test",
          scope: "global",
          decision: "WAL flush test",
          choice: "checkpoint",
          rationale: "WAL checkpoint regression test \u2014 #4418",
          revisable: "yes",
          made_by: "agent",
          superseded_by: null
        });
      });
      const walPath = dbPath + "-wal";
      assert.ok(fs.existsSync(walPath), "WAL file should exist after write");
      const walSizeBefore = fs.statSync(walPath).size;
      assert.ok(walSizeBefore > 0, "WAL file should be non-empty after write");
      checkpointDatabase();
      const walSizeAfter = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
      assert.equal(walSizeAfter, 0, "WAL file should be truncated to 0 after checkpoint");
    });
    test("checkpointDatabase: is a no-op when no database is open", () => {
      closeDatabase();
      assert.doesNotThrow(() => checkpointDatabase());
    });
  });
  describe("refreshOpenDatabaseFromDisk", () => {
    test("refreshOpenDatabaseFromDisk: reopens the active file-backed database and sees external writes", (t) => {
      const dbPath = tempDbPath();
      t.after(() => cleanup(dbPath));
      openDatabase(dbPath);
      insertMilestone({ id: "M001", title: "Test", status: "active" });
      insertSlice({
        id: "S01",
        milestoneId: "M001",
        title: "Slice 1",
        status: "pending",
        sequence: 1
      });
      insertTask({
        id: "T01",
        milestoneId: "M001",
        sliceId: "S01",
        title: "Task 1",
        status: "pending",
        sequence: 1
      });
      const adapterBefore = _getAdapter();
      const externalDb = openRawSqliteForTest(dbPath);
      try {
        externalDb.exec(`
          INSERT INTO tasks (milestone_id, slice_id, id, title, status, sequence)
          VALUES ('M001', 'S01', 'T02', 'Task 2', 'pending', 2)
        `);
      } finally {
        externalDb.close();
      }
      const visibleBeforeRefresh = getSliceTasks("M001", "S01").map((task) => task.id);
      assert.ok(visibleBeforeRefresh.includes("T01"));
      assert.equal(refreshOpenDatabaseFromDisk(), true);
      assert.notEqual(_getAdapter(), adapterBefore, "refresh must replace the active adapter rather than becoming a no-op");
      const sliceTaskIds = getSliceTasks("M001", "S01").map((task) => task.id);
      assert.deepEqual(sliceTaskIds, ["T01", "T02"]);
      assert.equal(isDbAvailable(), true);
    });
    test("refreshOpenDatabaseFromDisk: refuses in-memory databases without closing them", () => {
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "Test", status: "active" });
      assert.equal(refreshOpenDatabaseFromDisk(), false);
      assert.equal(isDbAvailable(), true);
      assert.ok(_getAdapter().prepare("SELECT 1 FROM milestones WHERE id = 'M001'").get());
      closeDatabase();
    });
    test("refreshOpenDatabaseFromDisk: is a no-op when no database is open", () => {
      closeDatabase();
      assert.equal(refreshOpenDatabaseFromDisk(), false);
      assert.equal(isDbAvailable(), false);
    });
  });
  describe("milestone commit attribution teardown", () => {
    test("deleteMilestone removes persisted milestone commit attributions", () => {
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "Milestone", status: "active" });
      recordMilestoneCommitAttribution({
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        milestoneId: "M001",
        source: "backfill",
        confidence: 0.8,
        files: ["app.js"],
        createdAt: "2026-05-05T00:00:00.000Z"
      });
      assert.deepEqual(getMilestoneCommitAttributionShas("M001"), ["0123456789abcdef0123456789abcdef01234567"]);
      deleteMilestone("M001");
      assert.deepEqual(getMilestoneCommitAttributionShas("M001"), []);
      closeDatabase();
    });
    test("clearEngineHierarchy removes persisted milestone commit attributions", () => {
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "Milestone", status: "active" });
      recordMilestoneCommitAttribution({
        commitSha: "fedcba9876543210fedcba9876543210fedcba98",
        milestoneId: "M001",
        source: "backfill",
        confidence: 0.8,
        files: ["app.js"],
        createdAt: "2026-05-05T00:00:00.000Z"
      });
      assert.deepEqual(getMilestoneCommitAttributionShas("M001"), ["fedcba9876543210fedcba9876543210fedcba98"]);
      clearEngineHierarchy();
      assert.deepEqual(getMilestoneCommitAttributionShas("M001"), []);
      closeDatabase();
    });
  });
  describe("getDbStatus", () => {
    test("getDbStatus: initial state before any open", () => {
      closeDatabase();
      const status = getDbStatus();
      assert.strictEqual(status.available, false, "available false before open");
      assert.strictEqual(status.attempted, false, "attempted false before open");
      assert.strictEqual(status.lastError, null, "lastError null before open");
      assert.strictEqual(status.lastPhase, null, "lastPhase null before open");
    });
    test("getDbStatus: available after successful open", () => {
      openDatabase(":memory:");
      const status = getDbStatus();
      assert.strictEqual(status.available, true, "available true after open");
      assert.strictEqual(status.attempted, true, "attempted true after open");
      assert.ok(status.provider !== null, "provider set after open");
      assert.strictEqual(status.lastError, null, "lastError null on success");
      assert.strictEqual(status.lastPhase, null, "lastPhase null on success");
      closeDatabase();
    });
    test("getDbStatus: resets lastError/lastPhase after closeDatabase", () => {
      const corruptPath = path.join(os.tmpdir(), `gsd-corrupt-${Date.now()}.db`);
      fs.writeFileSync(corruptPath, Buffer.from("not a sqlite file at all!!!!!"));
      try {
        openDatabase(corruptPath);
      } catch {
      }
      assert.ok(getDbStatus().lastError !== null, "lastError set after failed open");
      closeDatabase();
      const status = getDbStatus();
      assert.strictEqual(status.lastError, null, "lastError cleared by closeDatabase");
      assert.strictEqual(status.lastPhase, null, "lastPhase cleared by closeDatabase");
      assert.strictEqual(status.attempted, false, "attempted reset by closeDatabase");
      fs.unlinkSync(corruptPath);
    });
    test("getDbStatus: captures open-phase error on corrupt file", () => {
      closeDatabase();
      const corruptPath = path.join(os.tmpdir(), `gsd-corrupt-${Date.now()}.db`);
      fs.writeFileSync(corruptPath, Buffer.from("not a sqlite file at all!!!!!"));
      try {
        openDatabase(corruptPath);
      } catch {
      }
      const status = getDbStatus();
      if (!status.available) {
        assert.strictEqual(status.attempted, true, "attempted true after failed open");
        assert.ok(
          status.lastPhase === "open" || status.lastPhase === "initSchema",
          `lastPhase should be "open" or "initSchema", got: ${status.lastPhase}`
        );
        assert.ok(status.lastError instanceof Error, "lastError is an Error");
      }
      closeDatabase();
      try {
        fs.unlinkSync(corruptPath);
      } catch {
      }
    });
    test("getDbStatus: error state resets on next successful open", () => {
      closeDatabase();
      const corruptPath = path.join(os.tmpdir(), `gsd-corrupt-${Date.now()}.db`);
      fs.writeFileSync(corruptPath, Buffer.from("not a sqlite file at all!!!!!"));
      try {
        openDatabase(corruptPath);
      } catch {
      }
      assert.ok(!getDbStatus().available, "DB unavailable after corrupt open");
      openDatabase(":memory:");
      const status = getDbStatus();
      assert.strictEqual(status.available, true, "available after valid open");
      assert.strictEqual(status.lastError, null, "lastError cleared on successful open");
      assert.strictEqual(status.lastPhase, null, "lastPhase cleared on successful open");
      closeDatabase();
      try {
        fs.unlinkSync(corruptPath);
      } catch {
      }
    });
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9nc2QtZGIudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NEIEV4dGVuc2lvbiAtIERhdGFiYXNlIHJlZ3Jlc3Npb24gdGVzdHMuXG5cbmltcG9ydCB7IGRlc2NyaWJlLCB0ZXN0IH0gZnJvbSAnbm9kZTp0ZXN0JztcbmltcG9ydCBhc3NlcnQgZnJvbSAnbm9kZTphc3NlcnQvc3RyaWN0JztcbmltcG9ydCAqIGFzIGZzIGZyb20gJ25vZGU6ZnMnO1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tICdub2RlOnBhdGgnO1xuaW1wb3J0ICogYXMgb3MgZnJvbSAnbm9kZTpvcyc7XG5pbXBvcnQgeyBjcmVhdGVSZXF1aXJlIH0gZnJvbSAnbm9kZTptb2R1bGUnO1xuaW1wb3J0IHtcbiAgb3BlbkRhdGFiYXNlLFxuICBjbG9zZURhdGFiYXNlLFxuICBpc0RiQXZhaWxhYmxlLFxuICB3YXNEYk9wZW5BdHRlbXB0ZWQsXG4gIGdldERiUHJvdmlkZXIsXG4gIGdldERiU3RhdHVzLFxuICBTQ0hFTUFfVkVSU0lPTixcbiAgaW5zZXJ0RGVjaXNpb24sXG4gIGdldERlY2lzaW9uQnlJZCxcbiAgaW5zZXJ0UmVxdWlyZW1lbnQsXG4gIGdldFJlcXVpcmVtZW50QnlJZCxcbiAgZ2V0QWN0aXZlRGVjaXNpb25zLFxuICBnZXRBY3RpdmVSZXF1aXJlbWVudHMsXG4gIHRyYW5zYWN0aW9uLFxuICByZWFkVHJhbnNhY3Rpb24sXG4gIGlzSW5UcmFuc2FjdGlvbixcbiAgX2dldEFkYXB0ZXIsXG4gIF9yZXNldFByb3ZpZGVyLFxuICBpbnNlcnRNaWxlc3RvbmUsXG4gIGluc2VydFNsaWNlLFxuICBpbnNlcnRUYXNrLFxuICBnZXRUYXNrLFxuICBnZXRTbGljZVRhc2tzLFxuICBkZWxldGVNaWxlc3RvbmUsXG4gIGNsZWFyRW5naW5lSGllcmFyY2h5LFxuICByZWNvcmRNaWxlc3RvbmVDb21taXRBdHRyaWJ1dGlvbixcbiAgZ2V0TWlsZXN0b25lQ29tbWl0QXR0cmlidXRpb25TaGFzLFxuICBjaGVja3BvaW50RGF0YWJhc2UsXG4gIHJlZnJlc2hPcGVuRGF0YWJhc2VGcm9tRGlzayxcbiAgdHJ5Q3JlYXRlTWVtb3JpZXNGdHMsXG59IGZyb20gJy4uL2dzZC1kYi50cyc7XG5pbXBvcnQgeyBfcmVzZXRMb2dzLCBwZWVrTG9ncywgc2V0U3RkZXJyTG9nZ2luZ0VuYWJsZWQgfSBmcm9tICcuLi93b3JrZmxvdy1sb2dnZXIudHMnO1xuXG5jb25zdCBfcmVxdWlyZSA9IGNyZWF0ZVJlcXVpcmUoaW1wb3J0Lm1ldGEudXJsKTtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBIZWxwZXI6IGNyZWF0ZSBhIHRlbXAgZmlsZSBwYXRoIGZvciBmaWxlLWJhY2tlZCBEQiB0ZXN0c1xuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbmZ1bmN0aW9uIHRlbXBEYlBhdGgoKTogc3RyaW5nIHtcbiAgY29uc3QgZGlyID0gZnMubWtkdGVtcFN5bmMocGF0aC5qb2luKG9zLnRtcGRpcigpLCAnZ3NkLWRiLXRlc3QtJykpO1xuICByZXR1cm4gcGF0aC5qb2luKGRpciwgJ3Rlc3QuZGInKTtcbn1cblxuZnVuY3Rpb24gY2xlYW51cChkYlBhdGg6IHN0cmluZyk6IHZvaWQge1xuICBjbG9zZURhdGFiYXNlKCk7XG4gIHRyeSB7XG4gICAgY29uc3QgZGlyID0gcGF0aC5kaXJuYW1lKGRiUGF0aCk7XG4gICAgLy8gUmVtb3ZlIERCIGZpbGUgYW5kIFdBTC9TSE0gZmlsZXNcbiAgICBmb3IgKGNvbnN0IGYgb2YgZnMucmVhZGRpclN5bmMoZGlyKSkge1xuICAgICAgZnMudW5saW5rU3luYyhwYXRoLmpvaW4oZGlyLCBmKSk7XG4gICAgfVxuICAgIGZzLnJtZGlyU3luYyhkaXIpO1xuICB9IGNhdGNoIHtcbiAgICAvLyBiZXN0IGVmZm9ydFxuICB9XG59XG5cbmZ1bmN0aW9uIHdpdGhQbGF0Zm9ybTxUPihwbGF0Zm9ybTogTm9kZUpTLlBsYXRmb3JtLCBmbjogKCkgPT4gVCk6IFQge1xuICBjb25zdCBvcmlnaW5hbCA9IHByb2Nlc3MucGxhdGZvcm07XG4gIE9iamVjdC5kZWZpbmVQcm9wZXJ0eShwcm9jZXNzLCAncGxhdGZvcm0nLCB7IHZhbHVlOiBwbGF0Zm9ybSB9KTtcbiAgdHJ5IHtcbiAgICByZXR1cm4gZm4oKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBPYmplY3QuZGVmaW5lUHJvcGVydHkocHJvY2VzcywgJ3BsYXRmb3JtJywgeyB2YWx1ZTogb3JpZ2luYWwgfSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gb3BlblJhd1NxbGl0ZUZvclRlc3QoZGJQYXRoOiBzdHJpbmcpOiB7IGV4ZWMoc3FsOiBzdHJpbmcpOiB2b2lkOyBjbG9zZSgpOiB2b2lkIH0ge1xuICB0cnkge1xuICAgIGNvbnN0IG1vZCA9IF9yZXF1aXJlKCdub2RlOnNxbGl0ZScpIGFzIHsgRGF0YWJhc2VTeW5jOiBuZXcgKHBhdGg6IHN0cmluZykgPT4geyBleGVjKHNxbDogc3RyaW5nKTogdm9pZDsgY2xvc2UoKTogdm9pZCB9IH07XG4gICAgcmV0dXJuIG5ldyBtb2QuRGF0YWJhc2VTeW5jKGRiUGF0aCk7XG4gIH0gY2F0Y2gge1xuICAgIHR5cGUgU3FsaXRlQ3RvciA9IG5ldyAocGF0aDogc3RyaW5nKSA9PiB7IGV4ZWMoc3FsOiBzdHJpbmcpOiB2b2lkOyBjbG9zZSgpOiB2b2lkIH07XG4gICAgY29uc3QgbW9kID0gX3JlcXVpcmUoJ2JldHRlci1zcWxpdGUzJykgYXNcbiAgICAgIHwgU3FsaXRlQ3RvclxuICAgICAgfCB7IGRlZmF1bHQ6IFNxbGl0ZUN0b3IgfTtcbiAgICBjb25zdCBEYXRhYmFzZUN0b3I6IFNxbGl0ZUN0b3IgPSB0eXBlb2YgbW9kID09PSAnZnVuY3Rpb24nID8gbW9kIDogbW9kLmRlZmF1bHQ7XG4gICAgcmV0dXJuIG5ldyBEYXRhYmFzZUN0b3IoZGJQYXRoKTtcbiAgfVxufVxuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIGdzZC1kYiB0ZXN0c1xuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbmRlc2NyaWJlKCdnc2QtZGInLCAoKSA9PiB7XG4gIHRlc3QoJ2dzZC1kYjogcHJvdmlkZXIgZGV0ZWN0aW9uJywgKCkgPT4ge1xuICAgIGNvbnN0IHByb3ZpZGVyID0gZ2V0RGJQcm92aWRlcigpO1xuICAgIGFzc2VydC5vayhwcm92aWRlciAhPT0gbnVsbCwgJ3Byb3ZpZGVyIHNob3VsZCBiZSBub24tbnVsbCcpO1xuICAgIGFzc2VydC5vayhcbiAgICAgIHByb3ZpZGVyID09PSAnbm9kZTpzcWxpdGUnIHx8IHByb3ZpZGVyID09PSAnYmV0dGVyLXNxbGl0ZTMnLFxuICAgICAgYHByb3ZpZGVyIHNob3VsZCBiZSBhIGtub3duIG5hbWUsIGdvdDogJHtwcm92aWRlcn1gLFxuICAgICk7XG4gIH0pO1xuXG4gIHRlc3QoJ2dzZC1kYjogZnJlc2ggREIgc2NoZW1hIGluaXQgKG1lbW9yeSknLCAoKSA9PiB7XG4gICAgY29uc3Qgb2sgPSBvcGVuRGF0YWJhc2UoJzptZW1vcnk6Jyk7XG4gICAgYXNzZXJ0Lm9rKG9rLCAnb3BlbkRhdGFiYXNlIHNob3VsZCByZXR1cm4gdHJ1ZScpO1xuICAgIGFzc2VydC5vayhpc0RiQXZhaWxhYmxlKCksICdpc0RiQXZhaWxhYmxlIHNob3VsZCBiZSB0cnVlIGFmdGVyIG9wZW4nKTtcblxuICAgIC8vIENoZWNrIHNjaGVtYV92ZXJzaW9uIHRhYmxlXG4gICAgY29uc3QgYWRhcHRlciA9IF9nZXRBZGFwdGVyKCkhO1xuICAgIGNvbnN0IHZlcnNpb24gPSBhZGFwdGVyLnByZXBhcmUoJ1NFTEVDVCBNQVgodmVyc2lvbikgYXMgdmVyc2lvbiBGUk9NIHNjaGVtYV92ZXJzaW9uJykuZ2V0KCk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbCh2ZXJzaW9uPy5bJ3ZlcnNpb24nXSwgU0NIRU1BX1ZFUlNJT04sIGBzY2hlbWEgdmVyc2lvbiBzaG91bGQgYmUgJHtTQ0hFTUFfVkVSU0lPTn1gKTtcblxuICAgIC8vIENoZWNrIHRhYmxlcyBleGlzdCBieSBxdWVyeWluZyB0aGVtXG4gICAgY29uc3QgZFJvd3MgPSBhZGFwdGVyLnByZXBhcmUoJ1NFTEVDVCBjb3VudCgqKSBhcyBjbnQgRlJPTSBkZWNpc2lvbnMnKS5nZXQoKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRSb3dzPy5bJ2NudCddLCAwLCAnZGVjaXNpb25zIHRhYmxlIHNob3VsZCBleGlzdCBhbmQgYmUgZW1wdHknKTtcblxuICAgIGNvbnN0IHJSb3dzID0gYWRhcHRlci5wcmVwYXJlKCdTRUxFQ1QgY291bnQoKikgYXMgY250IEZST00gcmVxdWlyZW1lbnRzJykuZ2V0KCk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyUm93cz8uWydjbnQnXSwgMCwgJ3JlcXVpcmVtZW50cyB0YWJsZSBzaG91bGQgZXhpc3QgYW5kIGJlIGVtcHR5Jyk7XG5cbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgYXNzZXJ0Lm9rKCFpc0RiQXZhaWxhYmxlKCksICdpc0RiQXZhaWxhYmxlIHNob3VsZCBiZSBmYWxzZSBhZnRlciBjbG9zZScpO1xuICB9KTtcblxuICB0ZXN0KCdnc2QtZGI6IGRvdWJsZS1pbml0IGlkZW1wb3RlbmN5JywgKCkgPT4ge1xuICAgIGNvbnN0IGRiUGF0aCA9IHRlbXBEYlBhdGgoKTtcbiAgICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcblxuICAgIC8vIEluc2VydCBhIGRlY2lzaW9uIHNvIHdlIGNhbiB2ZXJpZnkgaXQgc3Vydml2ZXMgcmUtaW5pdFxuICAgIGluc2VydERlY2lzaW9uKHtcbiAgICAgIGlkOiAnRDAwMScsXG4gICAgICB3aGVuX2NvbnRleHQ6ICd0ZXN0JyxcbiAgICAgIHNjb3BlOiAnZ2xvYmFsJyxcbiAgICAgIGRlY2lzaW9uOiAndGVzdCBkZWNpc2lvbicsXG4gICAgICBjaG9pY2U6ICdvcHRpb24gQScsXG4gICAgICByYXRpb25hbGU6ICdiZWNhdXNlJyxcbiAgICAgIHJldmlzYWJsZTogJ3llcycsXG4gICAgICBtYWRlX2J5OiAnYWdlbnQnLFxuICAgICAgc3VwZXJzZWRlZF9ieTogbnVsbCxcbiAgICB9KTtcblxuICAgIGNsb3NlRGF0YWJhc2UoKTtcblxuICAgIC8vIFJlLW9wZW4gc2FtZSBEQiBcdTIwMTQgc2NoZW1hIGluaXQgc2hvdWxkIGJlIGlkZW1wb3RlbnRcbiAgICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcbiAgICBjb25zdCBkID0gZ2V0RGVjaXNpb25CeUlkKCdEMDAxJyk7XG4gICAgYXNzZXJ0Lm9rKGQgIT09IG51bGwsICdkZWNpc2lvbiBzaG91bGQgc3Vydml2ZSByZS1pbml0Jyk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkPy5pZCwgJ0QwMDEnLCAnZGVjaXNpb24gSUQgcHJlc2VydmVkIGFmdGVyIHJlLWluaXQnKTtcblxuICAgIC8vIFNjaGVtYSB2ZXJzaW9uIHNob3VsZCBzdGlsbCBiZSAxIChub3QgZHVwbGljYXRlZClcbiAgICBjb25zdCBhZGFwdGVyID0gX2dldEFkYXB0ZXIoKSE7XG4gICAgY29uc3QgdmVyc2lvbnMgPSBhZGFwdGVyLnByZXBhcmUoJ1NFTEVDVCBjb3VudCgqKSBhcyBjbnQgRlJPTSBzY2hlbWFfdmVyc2lvbicpLmdldCgpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwodmVyc2lvbnM/LlsnY250J10sIDEsICdzY2hlbWFfdmVyc2lvbiBzaG91bGQgaGF2ZSBleGFjdGx5IDEgcm93IGFmdGVyIGRvdWJsZS1pbml0Jyk7XG5cbiAgICBjbGVhbnVwKGRiUGF0aCk7XG4gIH0pO1xuXG4gIHRlc3QoJ2dzZC1kYjogaW5zZXJ0ICsgZ2V0IGRlY2lzaW9uJywgKCkgPT4ge1xuICAgIG9wZW5EYXRhYmFzZSgnOm1lbW9yeTonKTtcbiAgICBpbnNlcnREZWNpc2lvbih7XG4gICAgICBpZDogJ0QwNDInLFxuICAgICAgd2hlbl9jb250ZXh0OiAnZHVyaW5nIHNwcmludCAzJyxcbiAgICAgIHNjb3BlOiAnTTAwMS9TMDInLFxuICAgICAgZGVjaXNpb246ICd1c2UgU1FMaXRlIGZvciBzdG9yYWdlJyxcbiAgICAgIGNob2ljZTogJ25vZGU6c3FsaXRlJyxcbiAgICAgIHJhdGlvbmFsZTogJ2J1aWx0LWluLCB6ZXJvIGRlcHMnLFxuICAgICAgcmV2aXNhYmxlOiAneWVzLCBpZiBwZXJmIGluc3VmZmljaWVudCcsXG4gICAgICBtYWRlX2J5OiAnYWdlbnQnLFxuICAgICAgc3VwZXJzZWRlZF9ieTogbnVsbCxcbiAgICB9KTtcblxuICAgIGNvbnN0IGQgPSBnZXREZWNpc2lvbkJ5SWQoJ0QwNDInKTtcbiAgICBhc3NlcnQub2soZCAhPT0gbnVsbCwgJ3Nob3VsZCBmaW5kIGluc2VydGVkIGRlY2lzaW9uJyk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkPy5pZCwgJ0QwNDInLCAnZGVjaXNpb24gaWQnKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGQ/LnNjb3BlLCAnTTAwMS9TMDInLCAnZGVjaXNpb24gc2NvcGUnKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGQ/LmNob2ljZSwgJ25vZGU6c3FsaXRlJywgJ2RlY2lzaW9uIGNob2ljZScpO1xuICAgIGFzc2VydC5vayh0eXBlb2YgZD8uc2VxID09PSAnbnVtYmVyJyAmJiBkLnNlcSA+IDAsICdzZXEgc2hvdWxkIGJlIGF1dG8tYXNzaWduZWQgcG9zaXRpdmUgbnVtYmVyJyk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkPy5zdXBlcnNlZGVkX2J5LCBudWxsLCAnc3VwZXJzZWRlZF9ieSBzaG91bGQgYmUgbnVsbCcpO1xuXG4gICAgLy8gTm9uLWV4aXN0ZW50XG4gICAgY29uc3QgbWlzc2luZyA9IGdldERlY2lzaW9uQnlJZCgnRDk5OScpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwobWlzc2luZywgbnVsbCwgJ25vbi1leGlzdGVudCBkZWNpc2lvbiByZXR1cm5zIG51bGwnKTtcblxuICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgfSk7XG5cbiAgdGVzdCgnZ3NkLWRiOiBpbnNlcnQgKyBnZXQgcmVxdWlyZW1lbnQnLCAoKSA9PiB7XG4gICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuICAgIGluc2VydFJlcXVpcmVtZW50KHtcbiAgICAgIGlkOiAnUjAwNycsXG4gICAgICBjbGFzczogJ2Z1bmN0aW9uYWwnLFxuICAgICAgc3RhdHVzOiAnYWN0aXZlJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU3lzdGVtIG11c3QgcGVyc2lzdCBkZWNpc2lvbnMnLFxuICAgICAgd2h5OiAnZGVjaXNpb25zIGluZm9ybSBmdXR1cmUgYWdlbnRzJyxcbiAgICAgIHNvdXJjZTogJ00wMDEtQ09OVEVYVCcsXG4gICAgICBwcmltYXJ5X293bmVyOiAnUzAxJyxcbiAgICAgIHN1cHBvcnRpbmdfc2xpY2VzOiAnUzAyLCBTMDMnLFxuICAgICAgdmFsaWRhdGlvbjogJ2luc2VydCBhbmQgcXVlcnkgcm91bmR0cmlwJyxcbiAgICAgIG5vdGVzOiAnaGlnaCBwcmlvcml0eScsXG4gICAgICBmdWxsX2NvbnRlbnQ6ICdGdWxsIHRleHQgb2YgcmVxdWlyZW1lbnQuLi4nLFxuICAgICAgc3VwZXJzZWRlZF9ieTogbnVsbCxcbiAgICB9KTtcblxuICAgIGNvbnN0IHIgPSBnZXRSZXF1aXJlbWVudEJ5SWQoJ1IwMDcnKTtcbiAgICBhc3NlcnQub2sociAhPT0gbnVsbCwgJ3Nob3VsZCBmaW5kIGluc2VydGVkIHJlcXVpcmVtZW50Jyk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyPy5pZCwgJ1IwMDcnLCAncmVxdWlyZW1lbnQgaWQnKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHI/LmNsYXNzLCAnZnVuY3Rpb25hbCcsICdyZXF1aXJlbWVudCBjbGFzcycpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocj8uc3RhdHVzLCAnYWN0aXZlJywgJ3JlcXVpcmVtZW50IHN0YXR1cycpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocj8ucHJpbWFyeV9vd25lciwgJ1MwMScsICdyZXF1aXJlbWVudCBwcmltYXJ5X293bmVyJyk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyPy5zdXBlcnNlZGVkX2J5LCBudWxsLCAnc3VwZXJzZWRlZF9ieSBzaG91bGQgYmUgbnVsbCcpO1xuXG4gICAgLy8gTm9uLWV4aXN0ZW50XG4gICAgY29uc3QgbWlzc2luZyA9IGdldFJlcXVpcmVtZW50QnlJZCgnUjk5OScpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwobWlzc2luZywgbnVsbCwgJ25vbi1leGlzdGVudCByZXF1aXJlbWVudCByZXR1cm5zIG51bGwnKTtcblxuICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgfSk7XG5cbiAgdGVzdCgnZ3NkLWRiOiBhY3RpdmVfZGVjaXNpb25zIHZpZXcgZXhjbHVkZXMgc3VwZXJzZWRlZCcsICgpID0+IHtcbiAgICBvcGVuRGF0YWJhc2UoJzptZW1vcnk6Jyk7XG5cbiAgICBpbnNlcnREZWNpc2lvbih7XG4gICAgICBpZDogJ0QwMDEnLFxuICAgICAgd2hlbl9jb250ZXh0OiAnZWFybHknLFxuICAgICAgc2NvcGU6ICdnbG9iYWwnLFxuICAgICAgZGVjaXNpb246ICd1c2UgSlNPTiBmaWxlcycsXG4gICAgICBjaG9pY2U6ICdKU09OJyxcbiAgICAgIHJhdGlvbmFsZTogJ3NpbXBsZScsXG4gICAgICByZXZpc2FibGU6ICd5ZXMnLFxuICAgICAgbWFkZV9ieTogJ2FnZW50JyxcbiAgICAgIHN1cGVyc2VkZWRfYnk6ICdEMDAyJywgIC8vIHN1cGVyc2VkZWQhXG4gICAgfSk7XG5cbiAgICBpbnNlcnREZWNpc2lvbih7XG4gICAgICBpZDogJ0QwMDInLFxuICAgICAgd2hlbl9jb250ZXh0OiAnbGF0ZXInLFxuICAgICAgc2NvcGU6ICdnbG9iYWwnLFxuICAgICAgZGVjaXNpb246ICd1c2UgU1FMaXRlJyxcbiAgICAgIGNob2ljZTogJ1NRTGl0ZScsXG4gICAgICByYXRpb25hbGU6ICdiZXR0ZXIgcXVlcnlpbmcnLFxuICAgICAgcmV2aXNhYmxlOiAneWVzJyxcbiAgICAgIG1hZGVfYnk6ICdhZ2VudCcsXG4gICAgICBzdXBlcnNlZGVkX2J5OiBudWxsLCAgLy8gYWN0aXZlXG4gICAgfSk7XG5cbiAgICBpbnNlcnREZWNpc2lvbih7XG4gICAgICBpZDogJ0QwMDMnLFxuICAgICAgd2hlbl9jb250ZXh0OiAnc2FtZSB0aW1lJyxcbiAgICAgIHNjb3BlOiAnbG9jYWwnLFxuICAgICAgZGVjaXNpb246ICd1c2UgV0FMIG1vZGUnLFxuICAgICAgY2hvaWNlOiAnV0FMJyxcbiAgICAgIHJhdGlvbmFsZTogJ2NvbmN1cnJlbnQgcmVhZHMnLFxuICAgICAgcmV2aXNhYmxlOiAnbm8nLFxuICAgICAgbWFkZV9ieTogJ2FnZW50JyxcbiAgICAgIHN1cGVyc2VkZWRfYnk6IG51bGwsICAvLyBhY3RpdmVcbiAgICB9KTtcblxuICAgIGNvbnN0IGFjdGl2ZSA9IGdldEFjdGl2ZURlY2lzaW9ucygpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoYWN0aXZlLmxlbmd0aCwgMiwgJ2FjdGl2ZV9kZWNpc2lvbnMgc2hvdWxkIHJldHVybiAyIChub3QgdGhlIHN1cGVyc2VkZWQgb25lKScpO1xuICAgIGNvbnN0IGlkcyA9IGFjdGl2ZS5tYXAoZCA9PiBkLmlkKS5zb3J0KCk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChpZHMsIFsnRDAwMicsICdEMDAzJ10sICdhY3RpdmUgZGVjaXNpb25zIHNob3VsZCBiZSBEMDAyIGFuZCBEMDAzJyk7XG5cbiAgICAvLyBWZXJpZnkgRDAwMSBpcyBzdGlsbCBpbiB0aGUgcmF3IHRhYmxlXG4gICAgY29uc3QgZDEgPSBnZXREZWNpc2lvbkJ5SWQoJ0QwMDEnKTtcbiAgICBhc3NlcnQub2soZDEgIT09IG51bGwsICdzdXBlcnNlZGVkIGRlY2lzaW9uIHN0aWxsIGV4aXN0cyBpbiByYXcgdGFibGUnKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGQxPy5zdXBlcnNlZGVkX2J5LCAnRDAwMicsICdzdXBlcnNlZGVkX2J5IGlzIHNldCcpO1xuXG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICB9KTtcblxuICB0ZXN0KCdnc2QtZGI6IGFjdGl2ZV9yZXF1aXJlbWVudHMgdmlldyBleGNsdWRlcyBzdXBlcnNlZGVkJywgKCkgPT4ge1xuICAgIG9wZW5EYXRhYmFzZSgnOm1lbW9yeTonKTtcblxuICAgIGluc2VydFJlcXVpcmVtZW50KHtcbiAgICAgIGlkOiAnUjAwMScsXG4gICAgICBjbGFzczogJ2Z1bmN0aW9uYWwnLFxuICAgICAgc3RhdHVzOiAnYWN0aXZlJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnb2xkIHJlcXVpcmVtZW50JyxcbiAgICAgIHdoeTogJ3dhcyBuZWVkZWQnLFxuICAgICAgc291cmNlOiAnTTAwMScsXG4gICAgICBwcmltYXJ5X293bmVyOiAnUzAxJyxcbiAgICAgIHN1cHBvcnRpbmdfc2xpY2VzOiAnJyxcbiAgICAgIHZhbGlkYXRpb246ICd0ZXN0JyxcbiAgICAgIG5vdGVzOiAnJyxcbiAgICAgIGZ1bGxfY29udGVudDogJycsXG4gICAgICBzdXBlcnNlZGVkX2J5OiAnUjAwMicsICAvLyBzdXBlcnNlZGVkIVxuICAgIH0pO1xuXG4gICAgaW5zZXJ0UmVxdWlyZW1lbnQoe1xuICAgICAgaWQ6ICdSMDAyJyxcbiAgICAgIGNsYXNzOiAnZnVuY3Rpb25hbCcsXG4gICAgICBzdGF0dXM6ICdhY3RpdmUnLFxuICAgICAgZGVzY3JpcHRpb246ICduZXcgcmVxdWlyZW1lbnQnLFxuICAgICAgd2h5OiAncmVwbGFjZXMgUjAwMScsXG4gICAgICBzb3VyY2U6ICdNMDAxJyxcbiAgICAgIHByaW1hcnlfb3duZXI6ICdTMDEnLFxuICAgICAgc3VwcG9ydGluZ19zbGljZXM6ICcnLFxuICAgICAgdmFsaWRhdGlvbjogJ3Rlc3QnLFxuICAgICAgbm90ZXM6ICcnLFxuICAgICAgZnVsbF9jb250ZW50OiAnJyxcbiAgICAgIHN1cGVyc2VkZWRfYnk6IG51bGwsICAvLyBhY3RpdmVcbiAgICB9KTtcblxuICAgIGNvbnN0IGFjdGl2ZSA9IGdldEFjdGl2ZVJlcXVpcmVtZW50cygpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoYWN0aXZlLmxlbmd0aCwgMSwgJ2FjdGl2ZV9yZXF1aXJlbWVudHMgc2hvdWxkIHJldHVybiAxJyk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChhY3RpdmVbMF0/LmlkLCAnUjAwMicsICdvbmx5IFIwMDIgc2hvdWxkIGJlIGFjdGl2ZScpO1xuXG4gICAgLy8gUjAwMSBzdGlsbCBpbiByYXcgdGFibGVcbiAgICBjb25zdCByMSA9IGdldFJlcXVpcmVtZW50QnlJZCgnUjAwMScpO1xuICAgIGFzc2VydC5vayhyMSAhPT0gbnVsbCwgJ3N1cGVyc2VkZWQgcmVxdWlyZW1lbnQgc3RpbGwgaW4gcmF3IHRhYmxlJyk7XG5cbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gIH0pO1xuXG4gIHRlc3QoJ2dzZC1kYjogV0FMIG1vZGUgb24gZmlsZS1iYWNrZWQgREInLCAoKSA9PiB7XG4gICAgY29uc3QgZGJQYXRoID0gdGVtcERiUGF0aCgpO1xuICAgIG9wZW5EYXRhYmFzZShkYlBhdGgpO1xuXG4gICAgY29uc3QgYWRhcHRlciA9IF9nZXRBZGFwdGVyKCkhO1xuICAgIGNvbnN0IG1vZGUgPSBhZGFwdGVyLnByZXBhcmUoJ1BSQUdNQSBqb3VybmFsX21vZGUnKS5nZXQoKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKG1vZGU/Llsnam91cm5hbF9tb2RlJ10sICd3YWwnLCAnam91cm5hbF9tb2RlIHNob3VsZCBiZSB3YWwgZm9yIGZpbGUtYmFja2VkIERCJyk7XG5cbiAgICBjbGVhbnVwKGRiUGF0aCk7XG4gIH0pO1xuXG4gIHRlc3QoJ2dzZC1kYjogbW1hcCBzdGF5cyBkaXNhYmxlZCBvbiBkYXJ3aW4gZmlsZS1iYWNrZWQgREJzJywgKCkgPT4ge1xuICAgIGNvbnN0IGRhcndpbkRiUGF0aCA9IHRlbXBEYlBhdGgoKTtcbiAgICB3aXRoUGxhdGZvcm0oJ2RhcndpbicsICgpID0+IHtcbiAgICAgIG9wZW5EYXRhYmFzZShkYXJ3aW5EYlBhdGgpO1xuICAgICAgY29uc3QgYWRhcHRlciA9IF9nZXRBZGFwdGVyKCkhO1xuICAgICAgY29uc3QgbW1hcCA9IGFkYXB0ZXIucHJlcGFyZSgnUFJBR01BIG1tYXBfc2l6ZScpLmdldCgpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChtbWFwPy5bJ21tYXBfc2l6ZSddLCAwLCAnZGFyd2luIHNob3VsZCBsZWF2ZSBtbWFwX3NpemUgZGlzYWJsZWQnKTtcbiAgICAgIGNsZWFudXAoZGFyd2luRGJQYXRoKTtcbiAgICB9KTtcblxuICAgIGNvbnN0IGxpbnV4RGJQYXRoID0gdGVtcERiUGF0aCgpO1xuICAgIHdpdGhQbGF0Zm9ybSgnbGludXgnLCAoKSA9PiB7XG4gICAgICBvcGVuRGF0YWJhc2UobGludXhEYlBhdGgpO1xuICAgICAgY29uc3QgYWRhcHRlciA9IF9nZXRBZGFwdGVyKCkhO1xuICAgICAgY29uc3QgbW1hcCA9IGFkYXB0ZXIucHJlcGFyZSgnUFJBR01BIG1tYXBfc2l6ZScpLmdldCgpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChtbWFwPy5bJ21tYXBfc2l6ZSddLCA2NzEwODg2NCwgJ25vbi1kYXJ3aW4gc2hvdWxkIHN0aWxsIGVuYWJsZSBtbWFwX3NpemUnKTtcbiAgICAgIGNsZWFudXAobGludXhEYlBhdGgpO1xuICAgIH0pO1xuICB9KTtcblxuICB0ZXN0KCdnc2QtZGI6IHRyYW5zYWN0aW9uIHJvbGxiYWNrIG9uIGVycm9yJywgKCkgPT4ge1xuICAgIG9wZW5EYXRhYmFzZSgnOm1lbW9yeTonKTtcblxuICAgIC8vIEluc2VydCBhIGRlY2lzaW9uIG5vcm1hbGx5XG4gICAgaW5zZXJ0RGVjaXNpb24oe1xuICAgICAgaWQ6ICdEMDEwJyxcbiAgICAgIHdoZW5fY29udGV4dDogJ3Rlc3QnLFxuICAgICAgc2NvcGU6ICd0ZXN0JyxcbiAgICAgIGRlY2lzaW9uOiAndGVzdCcsXG4gICAgICBjaG9pY2U6ICd0ZXN0JyxcbiAgICAgIHJhdGlvbmFsZTogJ3Rlc3QnLFxuICAgICAgcmV2aXNhYmxlOiAndGVzdCcsXG4gICAgICBtYWRlX2J5OiAnYWdlbnQnLFxuICAgICAgc3VwZXJzZWRlZF9ieTogbnVsbCxcbiAgICB9KTtcblxuICAgIC8vIFRyeSBhIHRyYW5zYWN0aW9uIHRoYXQgZmFpbHMgXHUyMDE0IHRoZSBpbnNlcnQgaW5zaWRlIHNob3VsZCBiZSByb2xsZWQgYmFja1xuICAgIGxldCB0aHJldyA9IGZhbHNlO1xuICAgIHRyeSB7XG4gICAgICB0cmFuc2FjdGlvbigoKSA9PiB7XG4gICAgICAgIGluc2VydERlY2lzaW9uKHtcbiAgICAgICAgICBpZDogJ0QwMTEnLFxuICAgICAgICAgIHdoZW5fY29udGV4dDogJ3Nob3VsZCBiZSByb2xsZWQgYmFjaycsXG4gICAgICAgICAgc2NvcGU6ICd0ZXN0JyxcbiAgICAgICAgICBkZWNpc2lvbjogJ3Rlc3QnLFxuICAgICAgICAgIGNob2ljZTogJ3Rlc3QnLFxuICAgICAgICAgIHJhdGlvbmFsZTogJ3Rlc3QnLFxuICAgICAgICAgIHJldmlzYWJsZTogJ3Rlc3QnLFxuICAgICAgICAgIG1hZGVfYnk6ICdhZ2VudCcsXG4gICAgICAgICAgc3VwZXJzZWRlZF9ieTogbnVsbCxcbiAgICAgICAgfSk7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignaW50ZW50aW9uYWwgZmFpbHVyZScpO1xuICAgICAgfSk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBpZiAoKGVyciBhcyBFcnJvcikubWVzc2FnZSA9PT0gJ2ludGVudGlvbmFsIGZhaWx1cmUnKSB7XG4gICAgICAgIHRocmV3ID0gdHJ1ZTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBhc3NlcnQub2sodGhyZXcsICd0cmFuc2FjdGlvbiBzaG91bGQgcmUtdGhyb3cgdGhlIGVycm9yJyk7XG4gICAgY29uc3QgZDExID0gZ2V0RGVjaXNpb25CeUlkKCdEMDExJyk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkMTEsIG51bGwsICdEMDExIHNob3VsZCBiZSByb2xsZWQgYmFjayAobm90IGZvdW5kKScpO1xuXG4gICAgLy8gRDAxMCBzaG91bGQgc3RpbGwgYmUgdGhlcmVcbiAgICBjb25zdCBkMTAgPSBnZXREZWNpc2lvbkJ5SWQoJ0QwMTAnKTtcbiAgICBhc3NlcnQub2soZDEwICE9PSBudWxsLCAnRDAxMCBzaG91bGQgc3Vydml2ZSB0aGUgZmFpbGVkIHRyYW5zYWN0aW9uJyk7XG5cbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gIH0pO1xuXG4gIHRlc3QoJ2dzZC1kYjogZmFpbGVkIEJFR0lOIGRvZXMgbm90IHBvaXNvbiB0cmFuc2FjdGlvbiBkZXB0aCcsICgpID0+IHtcbiAgICBvcGVuRGF0YWJhc2UoJzptZW1vcnk6Jyk7XG4gICAgY29uc3QgYWRhcHRlciA9IF9nZXRBZGFwdGVyKCkhO1xuXG4gICAgY29uc3QgYXNzZXJ0RmFpbGVkQmVnaW5MZWF2ZXNEZXB0aENsZWFyID0gKGxhYmVsOiBzdHJpbmcsIGZuOiAoKSA9PiB2b2lkKSA9PiB7XG4gICAgICBhZGFwdGVyLmV4ZWMoJ0JFR0lOJyk7XG4gICAgICB0cnkge1xuICAgICAgICBsZXQgdGhyZXcgPSBmYWxzZTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBmbigpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICB0aHJldyA9IHRydWU7XG4gICAgICAgIH1cbiAgICAgICAgYXNzZXJ0LmVxdWFsKHRocmV3LCB0cnVlLCBgJHtsYWJlbH0gc2hvdWxkIHN1cmZhY2UgdGhlIFNRTGl0ZSBCRUdJTiBmYWlsdXJlYCk7XG4gICAgICAgIGFzc2VydC5lcXVhbChpc0luVHJhbnNhY3Rpb24oKSwgZmFsc2UsIGAke2xhYmVsfSBmYWlsZWQgQkVHSU4gbXVzdCBub3QgbGVhdmUgZGVwdGggYWN0aXZlYCk7XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICBhZGFwdGVyLmV4ZWMoJ1JPTExCQUNLJyk7XG4gICAgICB9XG4gICAgfTtcblxuICAgIHRyeSB7XG4gICAgICBhc3NlcnRGYWlsZWRCZWdpbkxlYXZlc0RlcHRoQ2xlYXIoJ3RyYW5zYWN0aW9uJywgKCkgPT4gdHJhbnNhY3Rpb24oKCkgPT4gdW5kZWZpbmVkKSk7XG4gICAgICBhc3NlcnRGYWlsZWRCZWdpbkxlYXZlc0RlcHRoQ2xlYXIoJ3JlYWRUcmFuc2FjdGlvbicsICgpID0+IHJlYWRUcmFuc2FjdGlvbigoKSA9PiB1bmRlZmluZWQpKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdCgnZ3NkLWRiOiByZWNyZWF0ZXMgbWlzc2luZyB2ZXJpZmljYXRpb24gZXZpZGVuY2UgZGVkdXAgaW5kZXggYWZ0ZXIgcmVtb3ZpbmcgZHVwbGljYXRlIHJvd3MnLCAoKSA9PiB7XG4gICAgY29uc3QgZGJQYXRoID0gdGVtcERiUGF0aCgpO1xuICAgIG9wZW5EYXRhYmFzZShkYlBhdGgpO1xuXG4gICAgbGV0IGFkYXB0ZXIgPSBfZ2V0QWRhcHRlcigpITtcbiAgICBhZGFwdGVyLnByZXBhcmUoXCJJTlNFUlQgSU5UTyBtaWxlc3RvbmVzIChpZCwgY3JlYXRlZF9hdCkgVkFMVUVTICg/LCAnJylcIikucnVuKCdNMDAxJyk7XG4gICAgYWRhcHRlci5wcmVwYXJlKFwiSU5TRVJUIElOVE8gc2xpY2VzIChtaWxlc3RvbmVfaWQsIGlkLCBjcmVhdGVkX2F0KSBWQUxVRVMgKD8sID8sICcnKVwiKS5ydW4oJ00wMDEnLCAnUzAxJyk7XG4gICAgYWRhcHRlci5wcmVwYXJlKFwiSU5TRVJUIElOVE8gdGFza3MgKG1pbGVzdG9uZV9pZCwgc2xpY2VfaWQsIGlkKSBWQUxVRVMgKD8sID8sID8pXCIpLnJ1bignTTAwMScsICdTMDEnLCAnVDAxJyk7XG4gICAgYWRhcHRlci5leGVjKCdEUk9QIElOREVYIElGIEVYSVNUUyBpZHhfdmVyaWZpY2F0aW9uX2V2aWRlbmNlX2RlZHVwJyk7XG5cbiAgICBjb25zdCBpbnNlcnRFdmlkZW5jZSA9IGFkYXB0ZXIucHJlcGFyZShcbiAgICAgIGBJTlNFUlQgSU5UTyB2ZXJpZmljYXRpb25fZXZpZGVuY2UgKFxuICAgICAgICB0YXNrX2lkLCBzbGljZV9pZCwgbWlsZXN0b25lX2lkLCBjb21tYW5kLCBleGl0X2NvZGUsIHZlcmRpY3QsIGR1cmF0aW9uX21zLCBjcmVhdGVkX2F0XG4gICAgICApIFZBTFVFUyAoPywgPywgPywgPywgPywgPywgPywgPylgLFxuICAgICk7XG4gICAgaW5zZXJ0RXZpZGVuY2UucnVuKCdUMDEnLCAnUzAxJywgJ00wMDEnLCAnbnBtIHRlc3QnLCAxLCAnZmFpbCcsIDEyNSwgJzIwMjYtMDQtMTJUMDA6MDA6MDAuMDAwWicpO1xuICAgIGluc2VydEV2aWRlbmNlLnJ1bignVDAxJywgJ1MwMScsICdNMDAxJywgJ25wbSB0ZXN0JywgMSwgJ2ZhaWwnLCAxMjUsICcyMDI2LTA0LTEyVDAwOjAwOjAxLjAwMFonKTtcbiAgICBpbnNlcnRFdmlkZW5jZS5ydW4oJ1QwMScsICdTMDEnLCAnTTAwMScsICducG0gcnVuIGxpbnQnLCAwLCAncGFzcycsIDkwLCAnMjAyNi0wNC0xMlQwMDowMDowMi4wMDBaJyk7XG5cbiAgICBjbG9zZURhdGFiYXNlKCk7XG5cbiAgICBhc3NlcnQuZXF1YWwob3BlbkRhdGFiYXNlKGRiUGF0aCksIHRydWUsICdvcGVuRGF0YWJhc2Ugc2hvdWxkIHJlcGFpciBsZWdhY3kgZHVwbGljYXRlIGV2aWRlbmNlIHJvd3MnKTtcblxuICAgIGFkYXB0ZXIgPSBfZ2V0QWRhcHRlcigpITtcbiAgICBjb25zdCBjb3VudFJvdyA9IGFkYXB0ZXIucHJlcGFyZShcbiAgICAgIGBTRUxFQ1QgY291bnQoKikgYXMgY250XG4gICAgICAgRlJPTSB2ZXJpZmljYXRpb25fZXZpZGVuY2VcbiAgICAgICBXSEVSRSB0YXNrX2lkID0gPyBBTkQgc2xpY2VfaWQgPSA/IEFORCBtaWxlc3RvbmVfaWQgPSA/IEFORCBjb21tYW5kID0gPyBBTkQgdmVyZGljdCA9ID9gLFxuICAgICkuZ2V0KCdUMDEnLCAnUzAxJywgJ00wMDEnLCAnbnBtIHRlc3QnLCAnZmFpbCcpO1xuICAgIGFzc2VydC5lcXVhbChjb3VudFJvdz8uWydjbnQnXSwgMSwgJ2R1cGxpY2F0ZSB2ZXJpZmljYXRpb24gZXZpZGVuY2Ugcm93cyBzaG91bGQgYmUgZGVkdXBsaWNhdGVkIGJlZm9yZSBpbmRleCBjcmVhdGlvbicpO1xuXG4gICAgY29uc3QgaW5kZXhSb3cgPSBhZGFwdGVyLnByZXBhcmUoXG4gICAgICBcIlNFTEVDVCBuYW1lIEZST00gc3FsaXRlX21hc3RlciBXSEVSRSB0eXBlID0gJ2luZGV4JyBBTkQgbmFtZSA9ICdpZHhfdmVyaWZpY2F0aW9uX2V2aWRlbmNlX2RlZHVwJ1wiLFxuICAgICkuZ2V0KCk7XG4gICAgYXNzZXJ0LmVxdWFsKGluZGV4Um93Py5bJ25hbWUnXSwgJ2lkeF92ZXJpZmljYXRpb25fZXZpZGVuY2VfZGVkdXAnLCAnZGVkdXAgaW5kZXggc2hvdWxkIGJlIHJlY3JlYXRlZCBvbiByZW9wZW4nKTtcblxuICAgIGNsZWFudXAoZGJQYXRoKTtcbiAgfSk7XG5cbiAgdGVzdCgnZ3NkLWRiOiBsZWdhY3kgREIgbWlzc2luZyBtZW1vcmllcy5zY29wZSBvcGVucyBhbmQgYm9vdHN0cmFwcyBpbmRleCBjb2x1bW5zJywgKCkgPT4ge1xuICAgIGNvbnN0IGRiUGF0aCA9IHRlbXBEYlBhdGgoKTtcbiAgICBjb25zdCBsZWdhY3lEYiA9IG9wZW5SYXdTcWxpdGVGb3JUZXN0KGRiUGF0aCk7XG4gICAgbGVnYWN5RGIuZXhlYyhgXG4gICAgICBDUkVBVEUgVEFCTEUgc2NoZW1hX3ZlcnNpb24gKFxuICAgICAgICB2ZXJzaW9uIElOVEVHRVIgTk9UIE5VTEwsXG4gICAgICAgIGFwcGxpZWRfYXQgVEVYVCBOT1QgTlVMTFxuICAgICAgKTtcbiAgICAgIElOU0VSVCBJTlRPIHNjaGVtYV92ZXJzaW9uKHZlcnNpb24sIGFwcGxpZWRfYXQpIFZBTFVFUyAoMTcsICcyMDI2LTA0LTIwVDAwOjAwOjAwLjAwMFonKTtcbiAgICAgIENSRUFURSBUQUJMRSBtZW1vcmllcyAoXG4gICAgICAgIHNlcSBJTlRFR0VSIFBSSU1BUlkgS0VZIEFVVE9JTkNSRU1FTlQsXG4gICAgICAgIGlkIFRFWFQgTk9UIE5VTEwgVU5JUVVFLFxuICAgICAgICBjYXRlZ29yeSBURVhUIE5PVCBOVUxMLFxuICAgICAgICBjb250ZW50IFRFWFQgTk9UIE5VTEwsXG4gICAgICAgIGNvbmZpZGVuY2UgUkVBTCBOT1QgTlVMTCBERUZBVUxUIDAuOCxcbiAgICAgICAgc291cmNlX3VuaXRfdHlwZSBURVhULFxuICAgICAgICBzb3VyY2VfdW5pdF9pZCBURVhULFxuICAgICAgICBjcmVhdGVkX2F0IFRFWFQgTk9UIE5VTEwsXG4gICAgICAgIHVwZGF0ZWRfYXQgVEVYVCBOT1QgTlVMTCxcbiAgICAgICAgc3VwZXJzZWRlZF9ieSBURVhUIERFRkFVTFQgTlVMTCxcbiAgICAgICAgaGl0X2NvdW50IElOVEVHRVIgTk9UIE5VTEwgREVGQVVMVCAwXG4gICAgICApO1xuICAgICAgSU5TRVJUIElOVE8gbWVtb3JpZXMoaWQsIGNhdGVnb3J5LCBjb250ZW50LCBjcmVhdGVkX2F0LCB1cGRhdGVkX2F0KVxuICAgICAgVkFMVUVTICgnbGVnYWN5LW1lbW9yeScsICdub3RlJywgJ2xlZ2FjeSByb3cnLCAnMjAyNi0wNC0yMFQwMDowMDowMC4wMDBaJywgJzIwMjYtMDQtMjBUMDA6MDA6MDAuMDAwWicpO1xuICAgIGApO1xuICAgIGxlZ2FjeURiLmNsb3NlKCk7XG5cbiAgICBhc3NlcnQuZXF1YWwob3BlbkRhdGFiYXNlKGRiUGF0aCksIHRydWUsICdvcGVuRGF0YWJhc2Ugc2hvdWxkIHN1Y2NlZWQgZm9yIGxlZ2FjeSBEQiBtaXNzaW5nIG1lbW9yaWVzLnNjb3BlJyk7XG5cbiAgICBjb25zdCBhZGFwdGVyID0gX2dldEFkYXB0ZXIoKSE7XG4gICAgY29uc3QgY29sdW1ucyA9IGFkYXB0ZXIucHJlcGFyZSgnUFJBR01BIHRhYmxlX2luZm8obWVtb3JpZXMpJykuYWxsKCk7XG4gICAgY29uc3QgbmFtZXMgPSBjb2x1bW5zLm1hcCgocm93KSA9PiByb3dbJ25hbWUnXSk7XG4gICAgYXNzZXJ0Lm9rKG5hbWVzLmluY2x1ZGVzKCdzY29wZScpLCAnbWVtb3JpZXMuc2NvcGUgc2hvdWxkIGJlIGFkZGVkIGR1cmluZyBib290c3RyYXAnKTtcbiAgICBhc3NlcnQub2sobmFtZXMuaW5jbHVkZXMoJ3RhZ3MnKSwgJ21lbW9yaWVzLnRhZ3Mgc2hvdWxkIGJlIGFkZGVkIGR1cmluZyBib290c3RyYXAnKTtcblxuICAgIGNvbnN0IHJvdyA9IGFkYXB0ZXIucHJlcGFyZShgU0VMRUNUIHNjb3BlLCB0YWdzIEZST00gbWVtb3JpZXMgV0hFUkUgaWQgPSAnbGVnYWN5LW1lbW9yeSdgKS5nZXQoKTtcbiAgICBhc3NlcnQuZXF1YWwocm93Py5bJ3Njb3BlJ10sICdwcm9qZWN0JywgJ2xlZ2FjeSByb3dzIHNob3VsZCByZWNlaXZlIGRlZmF1bHQgc2NvcGUnKTtcbiAgICBhc3NlcnQuZXF1YWwocm93Py5bJ3RhZ3MnXSwgJ1tdJywgJ2xlZ2FjeSByb3dzIHNob3VsZCByZWNlaXZlIGRlZmF1bHQgdGFncycpO1xuXG4gICAgY29uc3QgaW5kZXggPSBhZGFwdGVyLnByZXBhcmUoXG4gICAgICBcIlNFTEVDVCBuYW1lIEZST00gc3FsaXRlX21hc3RlciBXSEVSRSB0eXBlID0gJ2luZGV4JyBBTkQgbmFtZSA9ICdpZHhfbWVtb3JpZXNfc2NvcGUnXCIsXG4gICAgKS5nZXQoKTtcbiAgICBhc3NlcnQuZXF1YWwoaW5kZXg/LlsnbmFtZSddLCAnaWR4X21lbW9yaWVzX3Njb3BlJywgJ3Njb3BlIGluZGV4IHNob3VsZCBiZSBjcmVhdGVkIGFmdGVyIGJvb3RzdHJhcCBjb2x1bW5zIGFyZSBwcmVzZW50Jyk7XG5cbiAgICBjbGVhbnVwKGRiUGF0aCk7XG4gIH0pO1xuXG4gIHRlc3QoJ2dzZC1kYjogcHJlLXYxOCBEQiB3aXRoIG1lbW9yeV9zb3VyY2VzIG1pc3Npbmcgc2NvcGUgb3BlbnMgd2l0aG91dCBjcmFzaCAoaXNzdWUgIzQ2MDcpJywgKCkgPT4ge1xuICAgIC8vIFJlZ3Jlc3Npb246IGluaXRTY2hlbWEoKSByYW4gQ1JFQVRFIElOREVYIG9uIG1lbW9yaWVzLnNjb3BlIGFuZFxuICAgIC8vIG1lbW9yeV9zb3VyY2VzLnNjb3BlIHVuY29uZGl0aW9uYWxseSwgYmVmb3JlIHRoZSB2MTggbWlncmF0aW9uIGFkZHMgdGhvc2VcbiAgICAvLyBjb2x1bW5zIHRvIGV4aXN0aW5nIHJvd3MuICBEYXRhYmFzZXMgYXQgc2NoZW1hIHYxNyB0aGF0IGhhZCBhXG4gICAgLy8gbWVtb3J5X3NvdXJjZXMgdGFibGUgd2l0aG91dCB0aGUgc2NvcGUgY29sdW1uIGNyYXNoZWQgb24gb3BlbiB3aXRoXG4gICAgLy8gXCJubyBzdWNoIGNvbHVtbjogc2NvcGVcIi5cbiAgICAvLyBUaGUgZml4IG1vdmVzIHRob3NlIGluZGV4IHN0YXRlbWVudHMgaW5zaWRlIHRoZSB2MTggbWlncmF0aW9uIGd1YXJkIHNvXG4gICAgLy8gdGhleSBvbmx5IGV4ZWN1dGUgYWZ0ZXIgdGhlIGNvbHVtbiBhbHJlYWR5IGV4aXN0cy5cbiAgICBjb25zdCBkYlBhdGggPSB0ZW1wRGJQYXRoKCk7XG4gICAgY29uc3QgbGVnYWN5RGIgPSBvcGVuUmF3U3FsaXRlRm9yVGVzdChkYlBhdGgpO1xuXG4gICAgLy8gQnVpbGQgYSByZWFsaXN0aWMgdjE3IHNjaGVtYTogZnVsbCB0YWJsZSBzZXQgdGhhdCBleGlzdGVkIGJlZm9yZSB2MTgsXG4gICAgLy8gd2l0aCBtZW1vcnlfc291cmNlcyBwcmVzZW50IGJ1dCBtaXNzaW5nIHRoZSBzY29wZSBjb2x1bW4gdGhhdCB2MTggYWRkcy5cbiAgICBsZWdhY3lEYi5leGVjKGBcbiAgICAgIENSRUFURSBUQUJMRSBzY2hlbWFfdmVyc2lvbiAoXG4gICAgICAgIHZlcnNpb24gSU5URUdFUiBOT1QgTlVMTCxcbiAgICAgICAgYXBwbGllZF9hdCBURVhUIE5PVCBOVUxMXG4gICAgICApO1xuICAgICAgSU5TRVJUIElOVE8gc2NoZW1hX3ZlcnNpb24odmVyc2lvbiwgYXBwbGllZF9hdCkgVkFMVUVTICgxNywgJzIwMjYtMDEtMDFUMDA6MDA6MDAuMDAwWicpO1xuXG4gICAgICBDUkVBVEUgVEFCTEUgZGVjaXNpb25zIChcbiAgICAgICAgc2VxIElOVEVHRVIgUFJJTUFSWSBLRVkgQVVUT0lOQ1JFTUVOVCxcbiAgICAgICAgaWQgVEVYVCBOT1QgTlVMTCBVTklRVUUsXG4gICAgICAgIHdoZW5fY29udGV4dCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICAgIHNjb3BlIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgICAgZGVjaXNpb24gVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgICBjaG9pY2UgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgICByYXRpb25hbGUgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgICByZXZpc2FibGUgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgICBtYWRlX2J5IFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnYWdlbnQnLFxuICAgICAgICBzdXBlcnNlZGVkX2J5IFRFWFQgREVGQVVMVCBOVUxMXG4gICAgICApO1xuXG4gICAgICBDUkVBVEUgVEFCTEUgcmVxdWlyZW1lbnRzIChcbiAgICAgICAgaWQgVEVYVCBQUklNQVJZIEtFWSxcbiAgICAgICAgY2xhc3MgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgICBzdGF0dXMgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgICBkZXNjcmlwdGlvbiBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICAgIHdoeSBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICAgIHNvdXJjZSBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICAgIHByaW1hcnlfb3duZXIgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgICBzdXBwb3J0aW5nX3NsaWNlcyBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICAgIHZhbGlkYXRpb24gVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgICBub3RlcyBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICAgIGZ1bGxfY29udGVudCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICAgIHN1cGVyc2VkZWRfYnkgVEVYVCBERUZBVUxUIE5VTExcbiAgICAgICk7XG5cbiAgICAgIENSRUFURSBUQUJMRSBtZW1vcmllcyAoXG4gICAgICAgIHNlcSBJTlRFR0VSIFBSSU1BUlkgS0VZIEFVVE9JTkNSRU1FTlQsXG4gICAgICAgIGlkIFRFWFQgTk9UIE5VTEwgVU5JUVVFLFxuICAgICAgICBjYXRlZ29yeSBURVhUIE5PVCBOVUxMLFxuICAgICAgICBjb250ZW50IFRFWFQgTk9UIE5VTEwsXG4gICAgICAgIGNvbmZpZGVuY2UgUkVBTCBOT1QgTlVMTCBERUZBVUxUIDAuOCxcbiAgICAgICAgc291cmNlX3VuaXRfdHlwZSBURVhULFxuICAgICAgICBzb3VyY2VfdW5pdF9pZCBURVhULFxuICAgICAgICBjcmVhdGVkX2F0IFRFWFQgTk9UIE5VTEwsXG4gICAgICAgIHVwZGF0ZWRfYXQgVEVYVCBOT1QgTlVMTCxcbiAgICAgICAgc3VwZXJzZWRlZF9ieSBURVhUIERFRkFVTFQgTlVMTCxcbiAgICAgICAgaGl0X2NvdW50IElOVEVHRVIgTk9UIE5VTEwgREVGQVVMVCAwXG4gICAgICApO1xuXG4gICAgICBDUkVBVEUgVEFCTEUgbWVtb3J5X3Byb2Nlc3NlZF91bml0cyAoXG4gICAgICAgIHVuaXRfa2V5IFRFWFQgUFJJTUFSWSBLRVksXG4gICAgICAgIGFjdGl2aXR5X2ZpbGUgVEVYVCxcbiAgICAgICAgcHJvY2Vzc2VkX2F0IFRFWFQgTk9UIE5VTExcbiAgICAgICk7XG5cbiAgICAgIC0tIG1lbW9yeV9zb3VyY2VzIGV4aXN0ZWQgYmVmb3JlIHYxOCBidXQgbGFja2VkIHRoZSBzY29wZSBjb2x1bW5cbiAgICAgIENSRUFURSBUQUJMRSBtZW1vcnlfc291cmNlcyAoXG4gICAgICAgIGlkIFRFWFQgUFJJTUFSWSBLRVksXG4gICAgICAgIGtpbmQgVEVYVCBOT1QgTlVMTCxcbiAgICAgICAgdXJpIFRFWFQsXG4gICAgICAgIHRpdGxlIFRFWFQsXG4gICAgICAgIGNvbnRlbnQgVEVYVCBOT1QgTlVMTCxcbiAgICAgICAgY29udGVudF9oYXNoIFRFWFQgTk9UIE5VTEwgVU5JUVVFLFxuICAgICAgICBpbXBvcnRlZF9hdCBURVhUIE5PVCBOVUxMXG4gICAgICApO1xuXG4gICAgICBDUkVBVEUgVEFCTEUgbWlsZXN0b25lcyAoXG4gICAgICAgIGlkIFRFWFQgUFJJTUFSWSBLRVksXG4gICAgICAgIHRpdGxlIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgICAgc3RhdHVzIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnYWN0aXZlJyxcbiAgICAgICAgZGVwZW5kc19vbiBURVhUIE5PVCBOVUxMIERFRkFVTFQgJ1tdJyxcbiAgICAgICAgY3JlYXRlZF9hdCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICAgIGNvbXBsZXRlZF9hdCBURVhUIERFRkFVTFQgTlVMTCxcbiAgICAgICAgdmlzaW9uIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgICAgc3VjY2Vzc19jcml0ZXJpYSBURVhUIE5PVCBOVUxMIERFRkFVTFQgJ1tdJyxcbiAgICAgICAga2V5X3Jpc2tzIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnW10nLFxuICAgICAgICBwcm9vZl9zdHJhdGVneSBURVhUIE5PVCBOVUxMIERFRkFVTFQgJ1tdJyxcbiAgICAgICAgdmVyaWZpY2F0aW9uX2NvbnRyYWN0IFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgICAgdmVyaWZpY2F0aW9uX2ludGVncmF0aW9uIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgICAgdmVyaWZpY2F0aW9uX29wZXJhdGlvbmFsIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgICAgdmVyaWZpY2F0aW9uX3VhdCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICAgIGRlZmluaXRpb25fb2ZfZG9uZSBURVhUIE5PVCBOVUxMIERFRkFVTFQgJ1tdJyxcbiAgICAgICAgcmVxdWlyZW1lbnRfY292ZXJhZ2UgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgICBib3VuZGFyeV9tYXBfbWFya2Rvd24gVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnXG4gICAgICApO1xuXG4gICAgICBDUkVBVEUgVEFCTEUgc2xpY2VzIChcbiAgICAgICAgbWlsZXN0b25lX2lkIFRFWFQgTk9UIE5VTEwsXG4gICAgICAgIGlkIFRFWFQgTk9UIE5VTEwsXG4gICAgICAgIHRpdGxlIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgICAgc3RhdHVzIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAncGVuZGluZycsXG4gICAgICAgIHJpc2sgVEVYVCBOT1QgTlVMTCBERUZBVUxUICdtZWRpdW0nLFxuICAgICAgICBkZXBlbmRzIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnW10nLFxuICAgICAgICBkZW1vIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgICAgY3JlYXRlZF9hdCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICAgIGNvbXBsZXRlZF9hdCBURVhUIERFRkFVTFQgTlVMTCxcbiAgICAgICAgZnVsbF9zdW1tYXJ5X21kIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgICAgZnVsbF91YXRfbWQgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgICBnb2FsIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgICAgc3VjY2Vzc19jcml0ZXJpYSBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICAgIHByb29mX2xldmVsIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgICAgaW50ZWdyYXRpb25fY2xvc3VyZSBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICAgIG9ic2VydmFiaWxpdHlfaW1wYWN0IFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgICAgc2VxdWVuY2UgSU5URUdFUiBERUZBVUxUIDAsXG4gICAgICAgIFBSSU1BUlkgS0VZIChtaWxlc3RvbmVfaWQsIGlkKVxuICAgICAgKTtcblxuICAgICAgQ1JFQVRFIFRBQkxFIHRhc2tzIChcbiAgICAgICAgbWlsZXN0b25lX2lkIFRFWFQgTk9UIE5VTEwsXG4gICAgICAgIHNsaWNlX2lkIFRFWFQgTk9UIE5VTEwsXG4gICAgICAgIGlkIFRFWFQgTk9UIE5VTEwsXG4gICAgICAgIHRpdGxlIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgICAgc3RhdHVzIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAncGVuZGluZycsXG4gICAgICAgIG9uZV9saW5lciBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICAgIG5hcnJhdGl2ZSBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICAgIHZlcmlmaWNhdGlvbl9yZXN1bHQgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgICBkdXJhdGlvbiBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICAgIGNvbXBsZXRlZF9hdCBURVhUIERFRkFVTFQgTlVMTCxcbiAgICAgICAgYmxvY2tlcl9kaXNjb3ZlcmVkIElOVEVHRVIgREVGQVVMVCAwLFxuICAgICAgICBkZXZpYXRpb25zIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgICAga25vd25faXNzdWVzIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgICAga2V5X2ZpbGVzIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnW10nLFxuICAgICAgICBrZXlfZGVjaXNpb25zIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnW10nLFxuICAgICAgICBmdWxsX3N1bW1hcnlfbWQgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgICBkZXNjcmlwdGlvbiBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICAgIGVzdGltYXRlIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgICAgZmlsZXMgVEVYVCBOT1QgTlVMTCBERUZBVUxUICdbXScsXG4gICAgICAgIHZlcmlmeSBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICAgIGlucHV0cyBURVhUIE5PVCBOVUxMIERFRkFVTFQgJ1tdJyxcbiAgICAgICAgZXhwZWN0ZWRfb3V0cHV0IFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnW10nLFxuICAgICAgICBvYnNlcnZhYmlsaXR5X2ltcGFjdCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICAgIGZ1bGxfcGxhbl9tZCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICAgIHNlcXVlbmNlIElOVEVHRVIgREVGQVVMVCAwLFxuICAgICAgICBibG9ja2VyX3NvdXJjZSBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICAgIGVzY2FsYXRpb25fcGVuZGluZyBJTlRFR0VSIE5PVCBOVUxMIERFRkFVTFQgMCxcbiAgICAgICAgZXNjYWxhdGlvbl9hd2FpdGluZ19yZXZpZXcgSU5URUdFUiBOT1QgTlVMTCBERUZBVUxUIDAsXG4gICAgICAgIGVzY2FsYXRpb25fYXJ0aWZhY3RfcGF0aCBURVhUIERFRkFVTFQgTlVMTCxcbiAgICAgICAgZXNjYWxhdGlvbl9vdmVycmlkZV9hcHBsaWVkX2F0IFRFWFQgREVGQVVMVCBOVUxMLFxuICAgICAgICBQUklNQVJZIEtFWSAobWlsZXN0b25lX2lkLCBzbGljZV9pZCwgaWQpXG4gICAgICApO1xuXG4gICAgICBDUkVBVEUgVEFCTEUgcmVwbGFuX2hpc3RvcnkgKFxuICAgICAgICBpZCBJTlRFR0VSIFBSSU1BUlkgS0VZIEFVVE9JTkNSRU1FTlQsXG4gICAgICAgIG1pbGVzdG9uZV9pZCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICAgIHNsaWNlX2lkIFRFWFQgREVGQVVMVCBOVUxMLFxuICAgICAgICB0YXNrX2lkIFRFWFQgREVGQVVMVCBOVUxMLFxuICAgICAgICBzdW1tYXJ5IFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgICAgcHJldmlvdXNfYXJ0aWZhY3RfcGF0aCBURVhUIERFRkFVTFQgTlVMTCxcbiAgICAgICAgcmVwbGFjZW1lbnRfYXJ0aWZhY3RfcGF0aCBURVhUIERFRkFVTFQgTlVMTCxcbiAgICAgICAgZnVsbF9jb250ZW50IFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgICAgY3JlYXRlZF9hdCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJydcbiAgICAgICk7XG5cbiAgICAgIENSRUFURSBUQUJMRSBxdWFsaXR5X2dhdGVzIChcbiAgICAgICAgbWlsZXN0b25lX2lkIFRFWFQgTk9UIE5VTEwsXG4gICAgICAgIHNsaWNlX2lkIFRFWFQgTk9UIE5VTEwsXG4gICAgICAgIGdhdGVfaWQgVEVYVCBOT1QgTlVMTCxcbiAgICAgICAgc2NvcGUgVEVYVCBOT1QgTlVMTCBERUZBVUxUICdzbGljZScsXG4gICAgICAgIHRhc2tfaWQgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgICBzdGF0dXMgVEVYVCBOT1QgTlVMTCBERUZBVUxUICdwZW5kaW5nJyxcbiAgICAgICAgdmVyZGljdCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICAgIHJhdGlvbmFsZSBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICAgIGZpbmRpbmdzIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgICAgZXZhbHVhdGVkX2F0IFRFWFQgREVGQVVMVCBOVUxMLFxuICAgICAgICBQUklNQVJZIEtFWSAobWlsZXN0b25lX2lkLCBzbGljZV9pZCwgZ2F0ZV9pZCwgdGFza19pZClcbiAgICAgICk7XG5cbiAgICAgIENSRUFURSBUQUJMRSB2ZXJpZmljYXRpb25fZXZpZGVuY2UgKFxuICAgICAgICBpZCBJTlRFR0VSIFBSSU1BUlkgS0VZIEFVVE9JTkNSRU1FTlQsXG4gICAgICAgIHRhc2tfaWQgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgICBzbGljZV9pZCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICAgIG1pbGVzdG9uZV9pZCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICAgIGNvbW1hbmQgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgICBleGl0X2NvZGUgSU5URUdFUiBERUZBVUxUIDAsXG4gICAgICAgIHZlcmRpY3QgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgICBkdXJhdGlvbl9tcyBJTlRFR0VSIERFRkFVTFQgMCxcbiAgICAgICAgY3JlYXRlZF9hdCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJydcbiAgICAgICk7XG5cbiAgICAgIENSRUFURSBUQUJMRSBzbGljZV9kZXBlbmRlbmNpZXMgKFxuICAgICAgICBtaWxlc3RvbmVfaWQgVEVYVCBOT1QgTlVMTCxcbiAgICAgICAgc2xpY2VfaWQgVEVYVCBOT1QgTlVMTCxcbiAgICAgICAgZGVwZW5kc19vbl9zbGljZV9pZCBURVhUIE5PVCBOVUxMLFxuICAgICAgICBQUklNQVJZIEtFWSAobWlsZXN0b25lX2lkLCBzbGljZV9pZCwgZGVwZW5kc19vbl9zbGljZV9pZClcbiAgICAgICk7XG5cbiAgICAgIENSRUFURSBUQUJMRSBnYXRlX3J1bnMgKFxuICAgICAgICBpZCBJTlRFR0VSIFBSSU1BUlkgS0VZIEFVVE9JTkNSRU1FTlQsXG4gICAgICAgIHRyYWNlX2lkIFRFWFQgTk9UIE5VTEwsXG4gICAgICAgIHR1cm5faWQgVEVYVCBOT1QgTlVMTCxcbiAgICAgICAgZ2F0ZV9pZCBURVhUIE5PVCBOVUxMLFxuICAgICAgICBnYXRlX3R5cGUgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgICB1bml0X3R5cGUgVEVYVCBERUZBVUxUIE5VTEwsXG4gICAgICAgIHVuaXRfaWQgVEVYVCBERUZBVUxUIE5VTEwsXG4gICAgICAgIG1pbGVzdG9uZV9pZCBURVhUIERFRkFVTFQgTlVMTCxcbiAgICAgICAgc2xpY2VfaWQgVEVYVCBERUZBVUxUIE5VTEwsXG4gICAgICAgIHRhc2tfaWQgVEVYVCBERUZBVUxUIE5VTEwsXG4gICAgICAgIG91dGNvbWUgVEVYVCBOT1QgTlVMTCBERUZBVUxUICdwYXNzJyxcbiAgICAgICAgZmFpbHVyZV9jbGFzcyBURVhUIE5PVCBOVUxMIERFRkFVTFQgJ25vbmUnLFxuICAgICAgICByYXRpb25hbGUgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgICBmaW5kaW5ncyBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICAgIGF0dGVtcHQgSU5URUdFUiBOT1QgTlVMTCBERUZBVUxUIDEsXG4gICAgICAgIG1heF9hdHRlbXB0cyBJTlRFR0VSIE5PVCBOVUxMIERFRkFVTFQgMSxcbiAgICAgICAgcmV0cnlhYmxlIElOVEVHRVIgTk9UIE5VTEwgREVGQVVMVCAwLFxuICAgICAgICBldmFsdWF0ZWRfYXQgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnXG4gICAgICApO1xuXG4gICAgICBDUkVBVEUgVEFCTEUgdHVybl9naXRfdHJhbnNhY3Rpb25zIChcbiAgICAgICAgdHJhY2VfaWQgVEVYVCBOT1QgTlVMTCxcbiAgICAgICAgdHVybl9pZCBURVhUIE5PVCBOVUxMLFxuICAgICAgICB1bml0X3R5cGUgVEVYVCBERUZBVUxUIE5VTEwsXG4gICAgICAgIHVuaXRfaWQgVEVYVCBERUZBVUxUIE5VTEwsXG4gICAgICAgIHN0YWdlIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAndHVybi1zdGFydCcsXG4gICAgICAgIGFjdGlvbiBURVhUIE5PVCBOVUxMIERFRkFVTFQgJ3N0YXR1cy1vbmx5JyxcbiAgICAgICAgcHVzaCBJTlRFR0VSIE5PVCBOVUxMIERFRkFVTFQgMCxcbiAgICAgICAgc3RhdHVzIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnb2snLFxuICAgICAgICBlcnJvciBURVhUIERFRkFVTFQgTlVMTCxcbiAgICAgICAgbWV0YWRhdGFfanNvbiBURVhUIE5PVCBOVUxMIERFRkFVTFQgJ3t9JyxcbiAgICAgICAgdXBkYXRlZF9hdCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICAgIFBSSU1BUlkgS0VZICh0cmFjZV9pZCwgdHVybl9pZCwgc3RhZ2UpXG4gICAgICApO1xuXG4gICAgICBDUkVBVEUgVEFCTEUgYXVkaXRfZXZlbnRzIChcbiAgICAgICAgZXZlbnRfaWQgVEVYVCBQUklNQVJZIEtFWSxcbiAgICAgICAgdHJhY2VfaWQgVEVYVCBOT1QgTlVMTCxcbiAgICAgICAgdHVybl9pZCBURVhUIERFRkFVTFQgTlVMTCxcbiAgICAgICAgY2F1c2VkX2J5IFRFWFQgREVGQVVMVCBOVUxMLFxuICAgICAgICBjYXRlZ29yeSBURVhUIE5PVCBOVUxMLFxuICAgICAgICB0eXBlIFRFWFQgTk9UIE5VTEwsXG4gICAgICAgIHRzIFRFWFQgTk9UIE5VTEwsXG4gICAgICAgIHBheWxvYWRfanNvbiBURVhUIE5PVCBOVUxMIERFRkFVTFQgJ3t9J1xuICAgICAgKTtcblxuICAgICAgQ1JFQVRFIFRBQkxFIGF1ZGl0X3R1cm5faW5kZXggKFxuICAgICAgICB0cmFjZV9pZCBURVhUIE5PVCBOVUxMLFxuICAgICAgICB0dXJuX2lkIFRFWFQgTk9UIE5VTEwsXG4gICAgICAgIGZpcnN0X3RzIFRFWFQgTk9UIE5VTEwsXG4gICAgICAgIGxhc3RfdHMgVEVYVCBOT1QgTlVMTCxcbiAgICAgICAgZXZlbnRfY291bnQgSU5URUdFUiBOT1QgTlVMTCBERUZBVUxUIDAsXG4gICAgICAgIFBSSU1BUlkgS0VZICh0cmFjZV9pZCwgdHVybl9pZClcbiAgICAgICk7XG5cbiAgICAgIENSRUFURSBJTkRFWCBpZHhfbWVtb3JpZXNfYWN0aXZlIE9OIG1lbW9yaWVzKHN1cGVyc2VkZWRfYnkpO1xuICAgICAgQ1JFQVRFIElOREVYIGlkeF90YXNrc19hY3RpdmUgT04gdGFza3MobWlsZXN0b25lX2lkLCBzbGljZV9pZCwgc3RhdHVzKTtcbiAgICAgIENSRUFURSBJTkRFWCBpZHhfc2xpY2VzX2FjdGl2ZSBPTiBzbGljZXMobWlsZXN0b25lX2lkLCBzdGF0dXMpO1xuICAgICAgQ1JFQVRFIElOREVYIGlkeF9taWxlc3RvbmVzX3N0YXR1cyBPTiBtaWxlc3RvbmVzKHN0YXR1cyk7XG4gICAgICBDUkVBVEUgSU5ERVggaWR4X3F1YWxpdHlfZ2F0ZXNfcGVuZGluZyBPTiBxdWFsaXR5X2dhdGVzKG1pbGVzdG9uZV9pZCwgc2xpY2VfaWQsIHN0YXR1cyk7XG4gICAgICBDUkVBVEUgSU5ERVggaWR4X3ZlcmlmaWNhdGlvbl9ldmlkZW5jZV90YXNrIE9OIHZlcmlmaWNhdGlvbl9ldmlkZW5jZShtaWxlc3RvbmVfaWQsIHNsaWNlX2lkLCB0YXNrX2lkKTtcbiAgICAgIENSRUFURSBJTkRFWCBpZHhfc2xpY2VfZGVwc190YXJnZXQgT04gc2xpY2VfZGVwZW5kZW5jaWVzKG1pbGVzdG9uZV9pZCwgZGVwZW5kc19vbl9zbGljZV9pZCk7XG4gICAgICBDUkVBVEUgSU5ERVggaWR4X3Rhc2tzX2VzY2FsYXRpb25fcGVuZGluZyBPTiB0YXNrcyhtaWxlc3RvbmVfaWQsIHNsaWNlX2lkLCBlc2NhbGF0aW9uX3BlbmRpbmcpO1xuICAgIGApO1xuICAgIGxlZ2FjeURiLmNsb3NlKCk7XG5cbiAgICAvLyBUaGlzIG11c3Qgbm90IHRocm93IFx1MjAxNCBiZWZvcmUgdGhlIGZpeCwgaW5pdFNjaGVtYSgpIGNyYXNoZWQgd2l0aFxuICAgIC8vIFwibm8gc3VjaCBjb2x1bW46IHNjb3BlXCIgd2hlbiBpdCB0cmllZCB0byBDUkVBVEUgSU5ERVggb24gbWVtb3J5X3NvdXJjZXMuc2NvcGVcbiAgICAvLyBiZWZvcmUgdGhlIHYxOCBtaWdyYXRpb24gaGFkIGFkZGVkIHRoYXQgY29sdW1uLlxuICAgIGFzc2VydC5kb2VzTm90VGhyb3coXG4gICAgICAoKSA9PiBvcGVuRGF0YWJhc2UoZGJQYXRoKSxcbiAgICAgICdvcGVuRGF0YWJhc2UgbXVzdCBub3QgdGhyb3cgb24gYSB2MTcgREIgd2hlcmUgbWVtb3J5X3NvdXJjZXMgbGFja3Mgc2NvcGUnLFxuICAgICk7XG5cbiAgICBjb25zdCBhZGFwdGVyID0gX2dldEFkYXB0ZXIoKSE7XG5cbiAgICAvLyBBZnRlciBvcGVuK21pZ3JhdGUsIG1lbW9yaWVzLnNjb3BlIG11c3QgZXhpc3RcbiAgICBjb25zdCBtZW1Db2xzID0gYWRhcHRlci5wcmVwYXJlKCdQUkFHTUEgdGFibGVfaW5mbyhtZW1vcmllcyknKS5hbGwoKS5tYXAoKHIpID0+IHJbJ25hbWUnXSk7XG4gICAgYXNzZXJ0Lm9rKG1lbUNvbHMuaW5jbHVkZXMoJ3Njb3BlJyksICdtZW1vcmllcy5zY29wZSBtdXN0IGJlIHByZXNlbnQgYWZ0ZXIgbWlncmF0aW9uJyk7XG5cbiAgICAvLyBpZHhfbWVtb3JpZXNfc2NvcGUgbXVzdCBiZSBjcmVhdGVkIGJ5IHRoZSB2MTggbWlncmF0aW9uXG4gICAgY29uc3Qgc2NvcGVJZHggPSBhZGFwdGVyXG4gICAgICAucHJlcGFyZShcIlNFTEVDVCBuYW1lIEZST00gc3FsaXRlX21hc3RlciBXSEVSRSB0eXBlPSdpbmRleCcgQU5EIG5hbWU9J2lkeF9tZW1vcmllc19zY29wZSdcIilcbiAgICAgIC5nZXQoKTtcbiAgICBhc3NlcnQub2soc2NvcGVJZHgsICdpZHhfbWVtb3JpZXNfc2NvcGUgbXVzdCBleGlzdCBhZnRlciBvcGVuIG9uIHYxNyBEQicpO1xuXG4gICAgLy8gaWR4X21lbW9yeV9zb3VyY2VzX3Njb3BlIG11c3QgYmUgY3JlYXRlZCBieSB0aGUgdjE4IG1pZ3JhdGlvblxuICAgIGNvbnN0IHNyY1Njb3BlSWR4ID0gYWRhcHRlclxuICAgICAgLnByZXBhcmUoXCJTRUxFQ1QgbmFtZSBGUk9NIHNxbGl0ZV9tYXN0ZXIgV0hFUkUgdHlwZT0naW5kZXgnIEFORCBuYW1lPSdpZHhfbWVtb3J5X3NvdXJjZXNfc2NvcGUnXCIpXG4gICAgICAuZ2V0KCk7XG4gICAgYXNzZXJ0Lm9rKHNyY1Njb3BlSWR4LCAnaWR4X21lbW9yeV9zb3VyY2VzX3Njb3BlIG11c3QgZXhpc3QgYWZ0ZXIgb3BlbiBvbiB2MTcgREInKTtcblxuICAgIGNsZWFudXAoZGJQYXRoKTtcbiAgfSk7XG5cbiAgdGVzdCgnZ3NkLWRiOiByb3dUb1Rhc2sgdG9sZXJhdGVzIGxlZ2FjeSBjb21tYS1zZXBhcmF0ZWQgdGFzayBhcnJheXMnLCAoKSA9PiB7XG4gICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuXG4gICAgY29uc3QgYWRhcHRlciA9IF9nZXRBZGFwdGVyKCkhO1xuICAgIGFkYXB0ZXIucHJlcGFyZShcIklOU0VSVCBJTlRPIG1pbGVzdG9uZXMgKGlkLCBjcmVhdGVkX2F0KSBWQUxVRVMgKD8sICcnKVwiKS5ydW4oJ00wMDEnKTtcbiAgICBhZGFwdGVyLnByZXBhcmUoXCJJTlNFUlQgSU5UTyBzbGljZXMgKG1pbGVzdG9uZV9pZCwgaWQsIGNyZWF0ZWRfYXQpIFZBTFVFUyAoPywgPywgJycpXCIpLnJ1bignTTAwMScsICdTMDEnKTtcbiAgICBhZGFwdGVyLnByZXBhcmUoXG4gICAgICBgSU5TRVJUIElOVE8gdGFza3MgKFxuICAgICAgICBtaWxlc3RvbmVfaWQsIHNsaWNlX2lkLCBpZCwga2V5X2ZpbGVzLCBrZXlfZGVjaXNpb25zLCBmaWxlcywgaW5wdXRzLCBleHBlY3RlZF9vdXRwdXRcbiAgICAgICkgVkFMVUVTICg/LCA/LCA/LCA/LCA/LCA/LCA/LCA/KWAsXG4gICAgKS5ydW4oXG4gICAgICAnTTAwMScsXG4gICAgICAnUzAxJyxcbiAgICAgICdUMDEnLFxuICAgICAgJ1tdJyxcbiAgICAgICdbXScsXG4gICAgICAndGVzdHMvdGVzdF92ZXJpZnkucHksIGNvbmZpZy55YW1sLCBjb25maWdzL3Jvc3Rlcl8yMDI2LTA1LTExLnlhbWwnLFxuICAgICAgJ3Rlc3RzL3Rlc3RfdmVyaWZ5LnB5JyxcbiAgICAgICdyZXBvcnRzL3N1bW1hcnkubWQsIGFydGlmYWN0cy9vdXRwdXQuanNvbicsXG4gICAgKTtcblxuICAgIGNvbnN0IHRhc2sgPSBnZXRUYXNrKCdNMDAxJywgJ1MwMScsICdUMDEnKTtcbiAgICBhc3NlcnQub2sodGFzaywgJ3Rhc2sgc2hvdWxkIGxvYWQgc3VjY2Vzc2Z1bGx5IGZyb20gREInKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHRhc2s/LmZpbGVzLCBbXG4gICAgICAndGVzdHMvdGVzdF92ZXJpZnkucHknLFxuICAgICAgJ2NvbmZpZy55YW1sJyxcbiAgICAgICdjb25maWdzL3Jvc3Rlcl8yMDI2LTA1LTExLnlhbWwnLFxuICAgIF0pO1xuICAgIGFzc2VydC5kZWVwRXF1YWwodGFzaz8uaW5wdXRzLCBbJ3Rlc3RzL3Rlc3RfdmVyaWZ5LnB5J10pO1xuICAgIGFzc2VydC5kZWVwRXF1YWwodGFzaz8uZXhwZWN0ZWRfb3V0cHV0LCBbJ3JlcG9ydHMvc3VtbWFyeS5tZCcsICdhcnRpZmFjdHMvb3V0cHV0Lmpzb24nXSk7XG5cbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gIH0pO1xuXG4gIHRlc3QoJ2dzZC1kYjogcXVlcnkgd3JhcHBlcnMgcmV0dXJuIG51bGwvZW1wdHkgd2hlbiBEQiB1bmF2YWlsYWJsZScsICgpID0+IHtcbiAgICAvLyBFbnN1cmUgREIgaXMgY2xvc2VkXG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIGFzc2VydC5vayghaXNEYkF2YWlsYWJsZSgpLCAnREIgc2hvdWxkIG5vdCBiZSBhdmFpbGFibGUnKTtcblxuICAgIGNvbnN0IGQgPSBnZXREZWNpc2lvbkJ5SWQoJ0QwMDEnKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGQsIG51bGwsICdnZXREZWNpc2lvbkJ5SWQgcmV0dXJucyBudWxsIHdoZW4gREIgY2xvc2VkJyk7XG5cbiAgICBjb25zdCByID0gZ2V0UmVxdWlyZW1lbnRCeUlkKCdSMDAxJyk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyLCBudWxsLCAnZ2V0UmVxdWlyZW1lbnRCeUlkIHJldHVybnMgbnVsbCB3aGVuIERCIGNsb3NlZCcpO1xuXG4gICAgY29uc3QgYWQgPSBnZXRBY3RpdmVEZWNpc2lvbnMoKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGFkLCBbXSwgJ2dldEFjdGl2ZURlY2lzaW9ucyByZXR1cm5zIFtdIHdoZW4gREIgY2xvc2VkJyk7XG5cbiAgICBjb25zdCBhciA9IGdldEFjdGl2ZVJlcXVpcmVtZW50cygpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoYXIsIFtdLCAnZ2V0QWN0aXZlUmVxdWlyZW1lbnRzIHJldHVybnMgW10gd2hlbiBEQiBjbG9zZWQnKTtcbiAgfSk7XG5cbiAgdGVzdCgnZ3NkLWRiOiBjbG9zZURhdGFiYXNlIHJlc2V0cyB3YXNEYk9wZW5BdHRlbXB0ZWQgYWZ0ZXIgYW4gaW50ZW50aW9uYWwgY2xvc2UnLCAoKSA9PiB7XG4gICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuICAgIGFzc2VydC5vayh3YXNEYk9wZW5BdHRlbXB0ZWQoKSwgJ3dhc0RiT3BlbkF0dGVtcHRlZCBzaG91bGQgYmUgdHJ1ZSBhZnRlciBvcGVuRGF0YWJhc2Ugd2FzIGNhbGxlZCcpO1xuXG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIGFzc2VydC5vayghaXNEYkF2YWlsYWJsZSgpLCAnREIgc2hvdWxkIG5vdCBiZSBhdmFpbGFibGUgYWZ0ZXIgY2xvc2UnKTtcbiAgICBhc3NlcnQub2soIXdhc0RiT3BlbkF0dGVtcHRlZCgpLCAnd2FzRGJPcGVuQXR0ZW1wdGVkIHNob3VsZCByZXNldCBhZnRlciBjbG9zZURhdGFiYXNlJyk7XG4gIH0pO1xuXG4gIHRlc3QoJ2dzZC1kYjogcm93VG9UYXNrIHRvbGVyYXRlcyBjb3JydXB0IGNvbW1hLXNlcGFyYXRlZCB0YXNrIGFycmF5cycsICgpID0+IHtcbiAgICBvcGVuRGF0YWJhc2UoJzptZW1vcnk6Jyk7XG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgc3RhdHVzOiAnYWN0aXZlJyB9KTtcbiAgICBpbnNlcnRTbGljZSh7IG1pbGVzdG9uZUlkOiAnTTAwMScsIGlkOiAnUzAxJywgc3RhdHVzOiAnYWN0aXZlJyB9KTtcbiAgICBpbnNlcnRUYXNrKHtcbiAgICAgIG1pbGVzdG9uZUlkOiAnTTAwMScsXG4gICAgICBzbGljZUlkOiAnUzAxJyxcbiAgICAgIGlkOiAnVDAxJyxcbiAgICAgIHRpdGxlOiAnUmVjb3ZlciBjb3JydXB0IGFycmF5cycsXG4gICAgICBwbGFubmluZzoge1xuICAgICAgICBkZXNjcmlwdGlvbjogJ2Rlc2MnLFxuICAgICAgICBlc3RpbWF0ZTogJ3NtYWxsJyxcbiAgICAgICAgZmlsZXM6IFsnc3JjL29yaWdpbmFsLnRzJ10sXG4gICAgICAgIHZlcmlmeTogJ25wbSB0ZXN0JyxcbiAgICAgICAgaW5wdXRzOiBbJ2RvY3Mvb3JpZ2luYWwubWQnXSxcbiAgICAgICAgZXhwZWN0ZWRPdXRwdXQ6IFsnZGlzdC9vcmlnaW5hbC5tZCddLFxuICAgICAgICBvYnNlcnZhYmlsaXR5SW1wYWN0OiAnJyxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBjb25zdCBhZGFwdGVyID0gX2dldEFkYXB0ZXIoKSE7XG4gICAgYWRhcHRlci5wcmVwYXJlKFxuICAgICAgYFVQREFURSB0YXNrc1xuICAgICAgICAgU0VUIGZpbGVzID0gPywgaW5wdXRzID0gPywgZXhwZWN0ZWRfb3V0cHV0ID0gPywga2V5X2ZpbGVzID0gPywga2V5X2RlY2lzaW9ucyA9ID9cbiAgICAgICBXSEVSRSBtaWxlc3RvbmVfaWQgPSA/IEFORCBzbGljZV9pZCA9ID8gQU5EIGlkID0gP2AsXG4gICAgKS5ydW4oXG4gICAgICAnc3JjLWVyZi9Nb2RlbHMvZm9vLmNzLCBzcmMtZXJmL01vZGVscy9iYXIuY3MnLFxuICAgICAgJ2RvY3MvaW5wdXQtYS5tZCwgZG9jcy9pbnB1dC1iLm1kJyxcbiAgICAgICdkaXN0L291dC1hLm1kLCBkaXN0L291dC1iLm1kJyxcbiAgICAgICdzcmMvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL2dzZC1kYi50cywgc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9zdGF0ZS50cycsXG4gICAgICAnXCJkZWNpc2lvbi0xXCInLFxuICAgICAgJ00wMDEnLFxuICAgICAgJ1MwMScsXG4gICAgICAnVDAxJyxcbiAgICApO1xuXG4gICAgY29uc3QgdGFzayA9IGdldFRhc2soJ00wMDEnLCAnUzAxJywgJ1QwMScpO1xuICAgIGFzc2VydC5vayh0YXNrLCAnZ2V0VGFzayBzaG91bGQgc3RpbGwgcmV0dXJuIHRoZSBjb3JydXB0IHJvdycpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwodGFzayEuZmlsZXMsIFsnc3JjLWVyZi9Nb2RlbHMvZm9vLmNzJywgJ3NyYy1lcmYvTW9kZWxzL2Jhci5jcyddKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHRhc2shLmlucHV0cywgWydkb2NzL2lucHV0LWEubWQnLCAnZG9jcy9pbnB1dC1iLm1kJ10pO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwodGFzayEuZXhwZWN0ZWRfb3V0cHV0LCBbJ2Rpc3Qvb3V0LWEubWQnLCAnZGlzdC9vdXQtYi5tZCddKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKFxuICAgICAgdGFzayEua2V5X2ZpbGVzLFxuICAgICAgWydzcmMvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL2dzZC1kYi50cycsICdzcmMvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL3N0YXRlLnRzJ10sXG4gICAgKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHRhc2shLmtleV9kZWNpc2lvbnMsIFsnZGVjaXNpb24tMSddKTtcblxuICAgIGNvbnN0IHNsaWNlVGFza3MgPSBnZXRTbGljZVRhc2tzKCdNMDAxJywgJ1MwMScpO1xuICAgIGFzc2VydC5lcXVhbChzbGljZVRhc2tzLmxlbmd0aCwgMSwgJ2dldFNsaWNlVGFza3Mgc2hvdWxkIGFsc28gc3Vydml2ZSBjb3JydXB0IHJvd3MnKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHNsaWNlVGFza3NbMF0hLmZpbGVzLCB0YXNrIS5maWxlcyk7XG5cbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gIH0pO1xuXG4gIHRlc3QoJ2dzZC1kYjogRlRTNSB1bmF2YWlsYWJsZSB3YXJuaW5nIG5vcm1hbGl6ZXMgcHJvdmlkZXIgdHlwbycsICgpID0+IHtcbiAgICBjb25zdCBwcmV2aW91c1N0ZGVyciA9IHNldFN0ZGVyckxvZ2dpbmdFbmFibGVkKGZhbHNlKTtcbiAgICBfcmVzZXRMb2dzKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IG9rID0gdHJ5Q3JlYXRlTWVtb3JpZXNGdHMoe1xuICAgICAgICBleGVjKCk6IHZvaWQge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcignbm8gc3VjaCBtb2R1ZWwgOiBmdHM1Jyk7XG4gICAgICAgIH0sXG4gICAgICAgIHByZXBhcmUoKTogbmV2ZXIge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcigncHJlcGFyZSBzaG91bGQgbm90IGJlIGNhbGxlZCcpO1xuICAgICAgICB9LFxuICAgICAgICBjbG9zZSgpOiB2b2lkIHt9LFxuICAgICAgfSk7XG5cbiAgICAgIGFzc2VydC5lcXVhbChvaywgZmFsc2UsICdGVFM1IGNyZWF0aW9uIHNob3VsZCByZXBvcnQgZmFsbGJhY2snKTtcbiAgICAgIGNvbnN0IHdhcm5pbmcgPSBwZWVrTG9ncygpLmZpbmQoKGVudHJ5KSA9PiBlbnRyeS5jb21wb25lbnQgPT09ICdkYicgJiYgZW50cnkubWVzc2FnZS5pbmNsdWRlcygnRlRTNSB1bmF2YWlsYWJsZScpKTtcbiAgICAgIGFzc2VydC5vayh3YXJuaW5nLCAnRlRTNSBmYWxsYmFjayB3YXJuaW5nIHNob3VsZCBiZSBsb2dnZWQnKTtcbiAgICAgIGFzc2VydC5tYXRjaCh3YXJuaW5nIS5tZXNzYWdlLCAvbm8gc3VjaCBtb2R1bGU6IGZ0czUvKTtcbiAgICAgIGFzc2VydC5kb2VzTm90TWF0Y2god2FybmluZyEubWVzc2FnZSwgL21vZHVlbC8pO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBfcmVzZXRMb2dzKCk7XG4gICAgICBzZXRTdGRlcnJMb2dnaW5nRW5hYmxlZChwcmV2aW91c1N0ZGVycik7XG4gICAgfVxuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgY2hlY2twb2ludERhdGFiYXNlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4gIGRlc2NyaWJlKCdjaGVja3BvaW50RGF0YWJhc2UnLCAoKSA9PiB7XG4gICAgdGVzdCgnY2hlY2twb2ludERhdGFiYXNlOiBmbHVzaGVzIFdBTCBpbnRvIGJhc2UgZmlsZSAoVFJVTkNBVEUpJywgKHQpID0+IHtcbiAgICAgIGNvbnN0IGRiUGF0aCA9IHRlbXBEYlBhdGgoKTtcbiAgICAgIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cChkYlBhdGgpKTtcblxuICAgICAgb3BlbkRhdGFiYXNlKGRiUGF0aCk7XG5cbiAgICAgIC8vIFdyaXRlIGVub3VnaCBkYXRhIHRvIGVuc3VyZSBXQUwgaGFzIGNvbnRlbnRcbiAgICAgIHRyYW5zYWN0aW9uKCgpID0+IHtcbiAgICAgICAgaW5zZXJ0RGVjaXNpb24oe1xuICAgICAgICAgIGlkOiAnRDAwMScsXG4gICAgICAgICAgd2hlbl9jb250ZXh0OiAndGVzdCcsXG4gICAgICAgICAgc2NvcGU6ICdnbG9iYWwnLFxuICAgICAgICAgIGRlY2lzaW9uOiAnV0FMIGZsdXNoIHRlc3QnLFxuICAgICAgICAgIGNob2ljZTogJ2NoZWNrcG9pbnQnLFxuICAgICAgICAgIHJhdGlvbmFsZTogJ1dBTCBjaGVja3BvaW50IHJlZ3Jlc3Npb24gdGVzdCBcdTIwMTQgIzQ0MTgnLFxuICAgICAgICAgIHJldmlzYWJsZTogJ3llcycsXG4gICAgICAgICAgbWFkZV9ieTogJ2FnZW50JyxcbiAgICAgICAgICBzdXBlcnNlZGVkX2J5OiBudWxsLFxuICAgICAgICB9KTtcbiAgICAgIH0pO1xuXG4gICAgICBjb25zdCB3YWxQYXRoID0gZGJQYXRoICsgJy13YWwnO1xuICAgICAgYXNzZXJ0Lm9rKGZzLmV4aXN0c1N5bmMod2FsUGF0aCksICdXQUwgZmlsZSBzaG91bGQgZXhpc3QgYWZ0ZXIgd3JpdGUnKTtcbiAgICAgIGNvbnN0IHdhbFNpemVCZWZvcmUgPSBmcy5zdGF0U3luYyh3YWxQYXRoKS5zaXplO1xuICAgICAgYXNzZXJ0Lm9rKHdhbFNpemVCZWZvcmUgPiAwLCAnV0FMIGZpbGUgc2hvdWxkIGJlIG5vbi1lbXB0eSBhZnRlciB3cml0ZScpO1xuXG4gICAgICBjaGVja3BvaW50RGF0YWJhc2UoKTtcblxuICAgICAgY29uc3Qgd2FsU2l6ZUFmdGVyID0gZnMuZXhpc3RzU3luYyh3YWxQYXRoKSA/IGZzLnN0YXRTeW5jKHdhbFBhdGgpLnNpemUgOiAwO1xuICAgICAgYXNzZXJ0LmVxdWFsKHdhbFNpemVBZnRlciwgMCwgJ1dBTCBmaWxlIHNob3VsZCBiZSB0cnVuY2F0ZWQgdG8gMCBhZnRlciBjaGVja3BvaW50Jyk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjaGVja3BvaW50RGF0YWJhc2U6IGlzIGEgbm8tb3Agd2hlbiBubyBkYXRhYmFzZSBpcyBvcGVuJywgKCkgPT4ge1xuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgICAgLy8gTXVzdCBub3QgdGhyb3dcbiAgICAgIGFzc2VydC5kb2VzTm90VGhyb3coKCkgPT4gY2hlY2twb2ludERhdGFiYXNlKCkpO1xuICAgIH0pO1xuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgcmVmcmVzaE9wZW5EYXRhYmFzZUZyb21EaXNrIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4gIGRlc2NyaWJlKCdyZWZyZXNoT3BlbkRhdGFiYXNlRnJvbURpc2snLCAoKSA9PiB7XG4gICAgdGVzdCgncmVmcmVzaE9wZW5EYXRhYmFzZUZyb21EaXNrOiByZW9wZW5zIHRoZSBhY3RpdmUgZmlsZS1iYWNrZWQgZGF0YWJhc2UgYW5kIHNlZXMgZXh0ZXJuYWwgd3JpdGVzJywgKHQpID0+IHtcbiAgICAgIGNvbnN0IGRiUGF0aCA9IHRlbXBEYlBhdGgoKTtcbiAgICAgIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cChkYlBhdGgpKTtcblxuICAgICAgb3BlbkRhdGFiYXNlKGRiUGF0aCk7XG4gICAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogJ00wMDEnLCB0aXRsZTogJ1Rlc3QnLCBzdGF0dXM6ICdhY3RpdmUnIH0pO1xuICAgICAgaW5zZXJ0U2xpY2Uoe1xuICAgICAgICBpZDogJ1MwMScsXG4gICAgICAgIG1pbGVzdG9uZUlkOiAnTTAwMScsXG4gICAgICAgIHRpdGxlOiAnU2xpY2UgMScsXG4gICAgICAgIHN0YXR1czogJ3BlbmRpbmcnLFxuICAgICAgICBzZXF1ZW5jZTogMSxcbiAgICAgIH0pO1xuICAgICAgaW5zZXJ0VGFzayh7XG4gICAgICAgIGlkOiAnVDAxJyxcbiAgICAgICAgbWlsZXN0b25lSWQ6ICdNMDAxJyxcbiAgICAgICAgc2xpY2VJZDogJ1MwMScsXG4gICAgICAgIHRpdGxlOiAnVGFzayAxJyxcbiAgICAgICAgc3RhdHVzOiAncGVuZGluZycsXG4gICAgICAgIHNlcXVlbmNlOiAxLFxuICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IGFkYXB0ZXJCZWZvcmUgPSBfZ2V0QWRhcHRlcigpITtcblxuICAgICAgY29uc3QgZXh0ZXJuYWxEYiA9IG9wZW5SYXdTcWxpdGVGb3JUZXN0KGRiUGF0aCk7XG4gICAgICB0cnkge1xuICAgICAgICBleHRlcm5hbERiLmV4ZWMoYFxuICAgICAgICAgIElOU0VSVCBJTlRPIHRhc2tzIChtaWxlc3RvbmVfaWQsIHNsaWNlX2lkLCBpZCwgdGl0bGUsIHN0YXR1cywgc2VxdWVuY2UpXG4gICAgICAgICAgVkFMVUVTICgnTTAwMScsICdTMDEnLCAnVDAyJywgJ1Rhc2sgMicsICdwZW5kaW5nJywgMilcbiAgICAgICAgYCk7XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICBleHRlcm5hbERiLmNsb3NlKCk7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHZpc2libGVCZWZvcmVSZWZyZXNoID0gZ2V0U2xpY2VUYXNrcygnTTAwMScsICdTMDEnKS5tYXAodGFzayA9PiB0YXNrLmlkKTtcbiAgICAgIGFzc2VydC5vayh2aXNpYmxlQmVmb3JlUmVmcmVzaC5pbmNsdWRlcygnVDAxJykpO1xuXG4gICAgICBhc3NlcnQuZXF1YWwocmVmcmVzaE9wZW5EYXRhYmFzZUZyb21EaXNrKCksIHRydWUpO1xuICAgICAgYXNzZXJ0Lm5vdEVxdWFsKF9nZXRBZGFwdGVyKCksIGFkYXB0ZXJCZWZvcmUsICdyZWZyZXNoIG11c3QgcmVwbGFjZSB0aGUgYWN0aXZlIGFkYXB0ZXIgcmF0aGVyIHRoYW4gYmVjb21pbmcgYSBuby1vcCcpO1xuICAgICAgY29uc3Qgc2xpY2VUYXNrSWRzID0gZ2V0U2xpY2VUYXNrcygnTTAwMScsICdTMDEnKS5tYXAodGFzayA9PiB0YXNrLmlkKTtcbiAgICAgIGFzc2VydC5kZWVwRXF1YWwoc2xpY2VUYXNrSWRzLCBbJ1QwMScsICdUMDInXSk7XG4gICAgICBhc3NlcnQuZXF1YWwoaXNEYkF2YWlsYWJsZSgpLCB0cnVlKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3JlZnJlc2hPcGVuRGF0YWJhc2VGcm9tRGlzazogcmVmdXNlcyBpbi1tZW1vcnkgZGF0YWJhc2VzIHdpdGhvdXQgY2xvc2luZyB0aGVtJywgKCkgPT4ge1xuICAgICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuICAgICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgdGl0bGU6ICdUZXN0Jywgc3RhdHVzOiAnYWN0aXZlJyB9KTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKHJlZnJlc2hPcGVuRGF0YWJhc2VGcm9tRGlzaygpLCBmYWxzZSk7XG4gICAgICBhc3NlcnQuZXF1YWwoaXNEYkF2YWlsYWJsZSgpLCB0cnVlKTtcbiAgICAgIGFzc2VydC5vayhfZ2V0QWRhcHRlcigpIS5wcmVwYXJlKFwiU0VMRUNUIDEgRlJPTSBtaWxlc3RvbmVzIFdIRVJFIGlkID0gJ00wMDEnXCIpLmdldCgpKTtcblxuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIH0pO1xuXG4gICAgdGVzdCgncmVmcmVzaE9wZW5EYXRhYmFzZUZyb21EaXNrOiBpcyBhIG5vLW9wIHdoZW4gbm8gZGF0YWJhc2UgaXMgb3BlbicsICgpID0+IHtcbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICAgIGFzc2VydC5lcXVhbChyZWZyZXNoT3BlbkRhdGFiYXNlRnJvbURpc2soKSwgZmFsc2UpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGlzRGJBdmFpbGFibGUoKSwgZmFsc2UpO1xuICAgIH0pO1xuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgbWlsZXN0b25lX2NvbW1pdF9hdHRyaWJ1dGlvbnMgdGVhcmRvd24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbiAgZGVzY3JpYmUoJ21pbGVzdG9uZSBjb21taXQgYXR0cmlidXRpb24gdGVhcmRvd24nLCAoKSA9PiB7XG4gICAgdGVzdCgnZGVsZXRlTWlsZXN0b25lIHJlbW92ZXMgcGVyc2lzdGVkIG1pbGVzdG9uZSBjb21taXQgYXR0cmlidXRpb25zJywgKCkgPT4ge1xuICAgICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuICAgICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgdGl0bGU6ICdNaWxlc3RvbmUnLCBzdGF0dXM6ICdhY3RpdmUnIH0pO1xuICAgICAgcmVjb3JkTWlsZXN0b25lQ29tbWl0QXR0cmlidXRpb24oe1xuICAgICAgICBjb21taXRTaGE6ICcwMTIzNDU2Nzg5YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3JyxcbiAgICAgICAgbWlsZXN0b25lSWQ6ICdNMDAxJyxcbiAgICAgICAgc291cmNlOiAnYmFja2ZpbGwnLFxuICAgICAgICBjb25maWRlbmNlOiAwLjgsXG4gICAgICAgIGZpbGVzOiBbJ2FwcC5qcyddLFxuICAgICAgICBjcmVhdGVkQXQ6ICcyMDI2LTA1LTA1VDAwOjAwOjAwLjAwMFonLFxuICAgICAgfSk7XG5cbiAgICAgIGFzc2VydC5kZWVwRXF1YWwoZ2V0TWlsZXN0b25lQ29tbWl0QXR0cmlidXRpb25TaGFzKCdNMDAxJyksIFsnMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2NyddKTtcbiAgICAgIGRlbGV0ZU1pbGVzdG9uZSgnTTAwMScpO1xuICAgICAgYXNzZXJ0LmRlZXBFcXVhbChnZXRNaWxlc3RvbmVDb21taXRBdHRyaWJ1dGlvblNoYXMoJ00wMDEnKSwgW10pO1xuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY2xlYXJFbmdpbmVIaWVyYXJjaHkgcmVtb3ZlcyBwZXJzaXN0ZWQgbWlsZXN0b25lIGNvbW1pdCBhdHRyaWJ1dGlvbnMnLCAoKSA9PiB7XG4gICAgICBvcGVuRGF0YWJhc2UoJzptZW1vcnk6Jyk7XG4gICAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogJ00wMDEnLCB0aXRsZTogJ01pbGVzdG9uZScsIHN0YXR1czogJ2FjdGl2ZScgfSk7XG4gICAgICByZWNvcmRNaWxlc3RvbmVDb21taXRBdHRyaWJ1dGlvbih7XG4gICAgICAgIGNvbW1pdFNoYTogJ2ZlZGNiYTk4NzY1NDMyMTBmZWRjYmE5ODc2NTQzMjEwZmVkY2JhOTgnLFxuICAgICAgICBtaWxlc3RvbmVJZDogJ00wMDEnLFxuICAgICAgICBzb3VyY2U6ICdiYWNrZmlsbCcsXG4gICAgICAgIGNvbmZpZGVuY2U6IDAuOCxcbiAgICAgICAgZmlsZXM6IFsnYXBwLmpzJ10sXG4gICAgICAgIGNyZWF0ZWRBdDogJzIwMjYtMDUtMDVUMDA6MDA6MDAuMDAwWicsXG4gICAgICB9KTtcblxuICAgICAgYXNzZXJ0LmRlZXBFcXVhbChnZXRNaWxlc3RvbmVDb21taXRBdHRyaWJ1dGlvblNoYXMoJ00wMDEnKSwgWydmZWRjYmE5ODc2NTQzMjEwZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4J10pO1xuICAgICAgY2xlYXJFbmdpbmVIaWVyYXJjaHkoKTtcbiAgICAgIGFzc2VydC5kZWVwRXF1YWwoZ2V0TWlsZXN0b25lQ29tbWl0QXR0cmlidXRpb25TaGFzKCdNMDAxJyksIFtdKTtcbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGdldERiU3RhdHVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4gIGRlc2NyaWJlKCdnZXREYlN0YXR1cycsICgpID0+IHtcbiAgICB0ZXN0KCdnZXREYlN0YXR1czogaW5pdGlhbCBzdGF0ZSBiZWZvcmUgYW55IG9wZW4nLCAoKSA9PiB7XG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgICBjb25zdCBzdGF0dXMgPSBnZXREYlN0YXR1cygpO1xuICAgICAgYXNzZXJ0LnN0cmljdEVxdWFsKHN0YXR1cy5hdmFpbGFibGUsIGZhbHNlLCAnYXZhaWxhYmxlIGZhbHNlIGJlZm9yZSBvcGVuJyk7XG4gICAgICBhc3NlcnQuc3RyaWN0RXF1YWwoc3RhdHVzLmF0dGVtcHRlZCwgZmFsc2UsICdhdHRlbXB0ZWQgZmFsc2UgYmVmb3JlIG9wZW4nKTtcbiAgICAgIGFzc2VydC5zdHJpY3RFcXVhbChzdGF0dXMubGFzdEVycm9yLCBudWxsLCAnbGFzdEVycm9yIG51bGwgYmVmb3JlIG9wZW4nKTtcbiAgICAgIGFzc2VydC5zdHJpY3RFcXVhbChzdGF0dXMubGFzdFBoYXNlLCBudWxsLCAnbGFzdFBoYXNlIG51bGwgYmVmb3JlIG9wZW4nKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2dldERiU3RhdHVzOiBhdmFpbGFibGUgYWZ0ZXIgc3VjY2Vzc2Z1bCBvcGVuJywgKCkgPT4ge1xuICAgICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuICAgICAgY29uc3Qgc3RhdHVzID0gZ2V0RGJTdGF0dXMoKTtcbiAgICAgIGFzc2VydC5zdHJpY3RFcXVhbChzdGF0dXMuYXZhaWxhYmxlLCB0cnVlLCAnYXZhaWxhYmxlIHRydWUgYWZ0ZXIgb3BlbicpO1xuICAgICAgYXNzZXJ0LnN0cmljdEVxdWFsKHN0YXR1cy5hdHRlbXB0ZWQsIHRydWUsICdhdHRlbXB0ZWQgdHJ1ZSBhZnRlciBvcGVuJyk7XG4gICAgICBhc3NlcnQub2soc3RhdHVzLnByb3ZpZGVyICE9PSBudWxsLCAncHJvdmlkZXIgc2V0IGFmdGVyIG9wZW4nKTtcbiAgICAgIGFzc2VydC5zdHJpY3RFcXVhbChzdGF0dXMubGFzdEVycm9yLCBudWxsLCAnbGFzdEVycm9yIG51bGwgb24gc3VjY2VzcycpO1xuICAgICAgYXNzZXJ0LnN0cmljdEVxdWFsKHN0YXR1cy5sYXN0UGhhc2UsIG51bGwsICdsYXN0UGhhc2UgbnVsbCBvbiBzdWNjZXNzJyk7XG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdnZXREYlN0YXR1czogcmVzZXRzIGxhc3RFcnJvci9sYXN0UGhhc2UgYWZ0ZXIgY2xvc2VEYXRhYmFzZScsICgpID0+IHtcbiAgICAgIC8vIFNpbXVsYXRlIGEgZmFpbGVkIG9wZW4gdG8gc2V0IGVycm9yIHN0YXRlXG4gICAgICBjb25zdCBjb3JydXB0UGF0aCA9IHBhdGguam9pbihvcy50bXBkaXIoKSwgYGdzZC1jb3JydXB0LSR7RGF0ZS5ub3coKX0uZGJgKTtcbiAgICAgIGZzLndyaXRlRmlsZVN5bmMoY29ycnVwdFBhdGgsIEJ1ZmZlci5mcm9tKCdub3QgYSBzcWxpdGUgZmlsZSBhdCBhbGwhISEhIScpKTtcbiAgICAgIHRyeSB7XG4gICAgICAgIG9wZW5EYXRhYmFzZShjb3JydXB0UGF0aCk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLy8gZXhwZWN0ZWRcbiAgICAgIH1cbiAgICAgIGFzc2VydC5vayhnZXREYlN0YXR1cygpLmxhc3RFcnJvciAhPT0gbnVsbCwgJ2xhc3RFcnJvciBzZXQgYWZ0ZXIgZmFpbGVkIG9wZW4nKTtcblxuICAgICAgLy8gY2xvc2VEYXRhYmFzZSBzaG91bGQgY2xlYXIgaXQgZXZlbiB0aG91Z2ggbm8gREIgd2FzIG9wZW5lZFxuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgICAgY29uc3Qgc3RhdHVzID0gZ2V0RGJTdGF0dXMoKTtcbiAgICAgIGFzc2VydC5zdHJpY3RFcXVhbChzdGF0dXMubGFzdEVycm9yLCBudWxsLCAnbGFzdEVycm9yIGNsZWFyZWQgYnkgY2xvc2VEYXRhYmFzZScpO1xuICAgICAgYXNzZXJ0LnN0cmljdEVxdWFsKHN0YXR1cy5sYXN0UGhhc2UsIG51bGwsICdsYXN0UGhhc2UgY2xlYXJlZCBieSBjbG9zZURhdGFiYXNlJyk7XG4gICAgICBhc3NlcnQuc3RyaWN0RXF1YWwoc3RhdHVzLmF0dGVtcHRlZCwgZmFsc2UsICdhdHRlbXB0ZWQgcmVzZXQgYnkgY2xvc2VEYXRhYmFzZScpO1xuICAgICAgZnMudW5saW5rU3luYyhjb3JydXB0UGF0aCk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdnZXREYlN0YXR1czogY2FwdHVyZXMgb3Blbi1waGFzZSBlcnJvciBvbiBjb3JydXB0IGZpbGUnLCAoKSA9PiB7XG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgICBjb25zdCBjb3JydXB0UGF0aCA9IHBhdGguam9pbihvcy50bXBkaXIoKSwgYGdzZC1jb3JydXB0LSR7RGF0ZS5ub3coKX0uZGJgKTtcbiAgICAgIGZzLndyaXRlRmlsZVN5bmMoY29ycnVwdFBhdGgsIEJ1ZmZlci5mcm9tKCdub3QgYSBzcWxpdGUgZmlsZSBhdCBhbGwhISEhIScpKTtcbiAgICAgIHRyeSB7XG4gICAgICAgIG9wZW5EYXRhYmFzZShjb3JydXB0UGF0aCk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLy8gZXhwZWN0ZWQgXHUyMDE0IGJvdGggcHJvdmlkZXJzIHNob3VsZCByZWplY3QgYSBub24tU1FMaXRlIGZpbGVcbiAgICAgIH1cbiAgICAgIGNvbnN0IHN0YXR1cyA9IGdldERiU3RhdHVzKCk7XG4gICAgICBpZiAoIXN0YXR1cy5hdmFpbGFibGUpIHtcbiAgICAgICAgLy8gb3BlbiBmYWlsZWQgKGV4cGVjdGVkIGluIG1vc3QgZW52aXJvbm1lbnRzKVxuICAgICAgICBhc3NlcnQuc3RyaWN0RXF1YWwoc3RhdHVzLmF0dGVtcHRlZCwgdHJ1ZSwgJ2F0dGVtcHRlZCB0cnVlIGFmdGVyIGZhaWxlZCBvcGVuJyk7XG4gICAgICAgIC8vIHByb3ZpZGVyIG1heSByZWplY3QgYXQgcmF3LW9wZW4gbGV2ZWwgKFwib3BlblwiKSBvciBhdCBTUUwgaW5pdCBsZXZlbCAoXCJpbml0U2NoZW1hXCIpXG4gICAgICAgIGFzc2VydC5vayhcbiAgICAgICAgICBzdGF0dXMubGFzdFBoYXNlID09PSAnb3BlbicgfHwgc3RhdHVzLmxhc3RQaGFzZSA9PT0gJ2luaXRTY2hlbWEnLFxuICAgICAgICAgIGBsYXN0UGhhc2Ugc2hvdWxkIGJlIFwib3BlblwiIG9yIFwiaW5pdFNjaGVtYVwiLCBnb3Q6ICR7c3RhdHVzLmxhc3RQaGFzZX1gLFxuICAgICAgICApO1xuICAgICAgICBhc3NlcnQub2soc3RhdHVzLmxhc3RFcnJvciBpbnN0YW5jZW9mIEVycm9yLCAnbGFzdEVycm9yIGlzIGFuIEVycm9yJyk7XG4gICAgICB9XG4gICAgICAvLyBJZiBzb21laG93IGl0IHN1Y2NlZWRlZCAodW5saWtlbHkgd2l0aCBnYXJiYWdlIGNvbnRlbnQpLCB0aGF0J3MgYWxzbyBmaW5lXG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgICB0cnkgeyBmcy51bmxpbmtTeW5jKGNvcnJ1cHRQYXRoKTsgfSBjYXRjaCB7IC8qIGJlc3QgZWZmb3J0ICovIH1cbiAgICB9KTtcblxuICAgIHRlc3QoJ2dldERiU3RhdHVzOiBlcnJvciBzdGF0ZSByZXNldHMgb24gbmV4dCBzdWNjZXNzZnVsIG9wZW4nLCAoKSA9PiB7XG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgICBjb25zdCBjb3JydXB0UGF0aCA9IHBhdGguam9pbihvcy50bXBkaXIoKSwgYGdzZC1jb3JydXB0LSR7RGF0ZS5ub3coKX0uZGJgKTtcbiAgICAgIGZzLndyaXRlRmlsZVN5bmMoY29ycnVwdFBhdGgsIEJ1ZmZlci5mcm9tKCdub3QgYSBzcWxpdGUgZmlsZSBhdCBhbGwhISEhIScpKTtcbiAgICAgIHRyeSB7IG9wZW5EYXRhYmFzZShjb3JydXB0UGF0aCk7IH0gY2F0Y2ggeyAvKiBleHBlY3RlZCAqLyB9XG4gICAgICBhc3NlcnQub2soIWdldERiU3RhdHVzKCkuYXZhaWxhYmxlLCAnREIgdW5hdmFpbGFibGUgYWZ0ZXIgY29ycnVwdCBvcGVuJyk7XG5cbiAgICAgIC8vIE5vdyBvcGVuIGEgdmFsaWQgaW4tbWVtb3J5IERCIFx1MjAxNCBlcnJvciBzdGF0ZSBzaG91bGQgY2xlYXJcbiAgICAgIG9wZW5EYXRhYmFzZSgnOm1lbW9yeTonKTtcbiAgICAgIGNvbnN0IHN0YXR1cyA9IGdldERiU3RhdHVzKCk7XG4gICAgICBhc3NlcnQuc3RyaWN0RXF1YWwoc3RhdHVzLmF2YWlsYWJsZSwgdHJ1ZSwgJ2F2YWlsYWJsZSBhZnRlciB2YWxpZCBvcGVuJyk7XG4gICAgICBhc3NlcnQuc3RyaWN0RXF1YWwoc3RhdHVzLmxhc3RFcnJvciwgbnVsbCwgJ2xhc3RFcnJvciBjbGVhcmVkIG9uIHN1Y2Nlc3NmdWwgb3BlbicpO1xuICAgICAgYXNzZXJ0LnN0cmljdEVxdWFsKHN0YXR1cy5sYXN0UGhhc2UsIG51bGwsICdsYXN0UGhhc2UgY2xlYXJlZCBvbiBzdWNjZXNzZnVsIG9wZW4nKTtcbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICAgIHRyeSB7IGZzLnVubGlua1N5bmMoY29ycnVwdFBhdGgpOyB9IGNhdGNoIHsgLyogYmVzdCBlZmZvcnQgKi8gfVxuICAgIH0pO1xuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgRmluYWwgUmVwb3J0IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUVBLFNBQVMsVUFBVSxZQUFZO0FBQy9CLE9BQU8sWUFBWTtBQUNuQixZQUFZLFFBQVE7QUFDcEIsWUFBWSxVQUFVO0FBQ3RCLFlBQVksUUFBUTtBQUNwQixTQUFTLHFCQUFxQjtBQUM5QjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFFQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUNQLFNBQVMsWUFBWSxVQUFVLCtCQUErQjtBQUU5RCxNQUFNLFdBQVcsY0FBYyxZQUFZLEdBQUc7QUFNOUMsU0FBUyxhQUFxQjtBQUM1QixRQUFNLE1BQU0sR0FBRyxZQUFZLEtBQUssS0FBSyxHQUFHLE9BQU8sR0FBRyxjQUFjLENBQUM7QUFDakUsU0FBTyxLQUFLLEtBQUssS0FBSyxTQUFTO0FBQ2pDO0FBRUEsU0FBUyxRQUFRLFFBQXNCO0FBQ3JDLGdCQUFjO0FBQ2QsTUFBSTtBQUNGLFVBQU0sTUFBTSxLQUFLLFFBQVEsTUFBTTtBQUUvQixlQUFXLEtBQUss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QUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtB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
