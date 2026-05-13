import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { closeDatabase, isDbAvailable, getDecisionById, SCHEMA_VERSION, _getAdapter } from "../gsd-db.js";
const _require = createRequire(import.meta.url);
function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-ensure-db-"));
  return dir;
}
function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
  }
}
function createLegacyV15Db(dbPath) {
  const sqlite = _require("node:sqlite");
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`
    CREATE TABLE schema_version (
      version INTEGER NOT NULL,
      applied_at TEXT NOT NULL
    );
    INSERT INTO schema_version (version, applied_at) VALUES (15, '2026-01-01T00:00:00.000Z');

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

    CREATE TABLE artifacts (
      path TEXT PRIMARY KEY,
      artifact_type TEXT NOT NULL DEFAULT '',
      milestone_id TEXT DEFAULT NULL,
      slice_id TEXT DEFAULT NULL,
      task_id TEXT DEFAULT NULL,
      full_content TEXT NOT NULL DEFAULT '',
      imported_at TEXT NOT NULL DEFAULT ''
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
      replan_triggered_at TEXT DEFAULT NULL,
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
      PRIMARY KEY (milestone_id, slice_id, id)
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

    CREATE TABLE replan_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      milestone_id TEXT NOT NULL DEFAULT '',
      slice_id TEXT DEFAULT NULL,
      task_id TEXT DEFAULT NULL,
      summary TEXT NOT NULL DEFAULT '',
      previous_artifact_path TEXT DEFAULT NULL,
      replacement_artifact_path TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE assessments (
      path TEXT PRIMARY KEY,
      milestone_id TEXT NOT NULL DEFAULT '',
      slice_id TEXT DEFAULT NULL,
      task_id TEXT DEFAULT NULL,
      status TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL DEFAULT '',
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
  `);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  try {
    fs.unlinkSync(`${dbPath}-wal`);
  } catch {
  }
  try {
    fs.unlinkSync(`${dbPath}-shm`);
  } catch {
  }
}
describe("ensure-db-open", () => {
  test("ensureDbOpen: creates empty DB without importing Markdown", async () => {
    const tmpDir = makeTmpDir();
    const gsdDir = path.join(tmpDir, ".gsd");
    fs.mkdirSync(gsdDir, { recursive: true });
    const decisionsContent = `# Decisions

  | # | When | Scope | Decision | Choice | Rationale | Revisable |
  |---|------|-------|----------|--------|-----------|-----------|
  | D001 | M001 | architecture | Use SQLite | SQLite | Sync API | Yes |
  `;
    fs.writeFileSync(path.join(gsdDir, "DECISIONS.md"), decisionsContent);
    const dbPath = path.join(gsdDir, "gsd.db");
    assert.ok(!fs.existsSync(dbPath), "DB file should not exist before ensureDbOpen");
    try {
      closeDatabase();
    } catch {
    }
    const origCwd = process.cwd;
    process.cwd = () => tmpDir;
    try {
      const { ensureDbOpen } = await import("../bootstrap/dynamic-tools.js");
      const result = await ensureDbOpen();
      assert.ok(result === true, "ensureDbOpen should return true when .gsd/ exists");
      assert.ok(fs.existsSync(dbPath), "DB file should be created after ensureDbOpen");
      assert.ok(isDbAvailable(), "DB should be available after ensureDbOpen");
      const decision = getDecisionById("D001");
      assert.equal(decision, null, "D001 should not be imported from DECISIONS.md without explicit migration");
    } finally {
      process.cwd = origCwd;
      closeDatabase();
      cleanupDir(tmpDir);
    }
  });
  test("ensureDbOpen: explicit basePath opens target project without cwd override", async () => {
    const tmpDir = makeTmpDir();
    const gsdDir = path.join(tmpDir, ".gsd");
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, "DECISIONS.md"), `# Decisions

| # | When | Scope | Decision | Choice | Rationale | Revisable |
|---|------|-------|----------|--------|-----------|-----------|
| D777 | M001 | architecture | Use explicit basePath | BasePath | Avoid cwd coupling | Yes |
`);
    try {
      closeDatabase();
    } catch {
    }
    const originalCwd = process.cwd();
    try {
      const { ensureDbOpen } = await import("../bootstrap/dynamic-tools.js");
      const result = await ensureDbOpen(tmpDir);
      assert.ok(result === true, "ensureDbOpen should honor explicit basePath");
      assert.equal(process.cwd(), originalCwd, "ensureDbOpen should not mutate process.cwd");
      assert.ok(isDbAvailable(), "DB should be available after explicit open");
      assert.equal(getDecisionById("D777"), null, "explicit basePath should not import DECISIONS.md");
    } finally {
      closeDatabase();
      cleanupDir(tmpDir);
    }
  });
  test("ensureDbOpen: migrates legacy v15 DB before bootstrap indexes touch new columns", async () => {
    const tmpDir = makeTmpDir();
    const gsdDir = path.join(tmpDir, ".gsd");
    fs.mkdirSync(gsdDir, { recursive: true });
    const dbPath = path.join(gsdDir, "gsd.db");
    createLegacyV15Db(dbPath);
    try {
      closeDatabase();
    } catch {
    }
    try {
      const { ensureDbOpen } = await import("../bootstrap/dynamic-tools.js");
      const result = await ensureDbOpen(tmpDir);
      assert.equal(result, true, "legacy v15 DB should open and migrate");
      assert.ok(isDbAvailable(), "DB should be available after migrating v15");
      const db = _getAdapter();
      assert.ok(db, "adapter should be available after ensureDbOpen");
      assert.equal(
        db.prepare("SELECT MAX(version) as version FROM schema_version").get()?.version,
        SCHEMA_VERSION,
        "legacy DB should migrate to current schema version"
      );
      const memoryColumns = new Set(db.prepare("PRAGMA table_info(memories)").all().map((row) => row.name));
      const taskColumns = new Set(db.prepare("PRAGMA table_info(tasks)").all().map((row) => row.name));
      assert.ok(memoryColumns.has("scope"), "memory scope column should be present");
      assert.ok(memoryColumns.has("tags"), "memory tags column should be present");
      assert.ok(taskColumns.has("escalation_pending"), "task escalation_pending column should be present");
      assert.ok(
        db.prepare("SELECT 1 as present FROM sqlite_master WHERE type = 'index' AND name = 'idx_memories_scope'").get(),
        "memory scope index should be created after migration-safe bootstrap"
      );
      assert.ok(
        db.prepare("SELECT 1 as present FROM sqlite_master WHERE type = 'index' AND name = 'idx_tasks_escalation_pending'").get(),
        "task escalation index should be created after migration-safe bootstrap"
      );
    } finally {
      closeDatabase();
      cleanupDir(tmpDir);
    }
  });
  test("ensureDbOpen: no .gsd/ returns false", async () => {
    const tmpDir = makeTmpDir();
    try {
      closeDatabase();
    } catch {
    }
    const origCwd = process.cwd;
    process.cwd = () => tmpDir;
    try {
      const { ensureDbOpen } = await import("../bootstrap/dynamic-tools.js");
      const result = await ensureDbOpen();
      assert.ok(result === false, "ensureDbOpen should return false when no .gsd/ exists");
      assert.ok(!isDbAvailable(), "DB should not be available");
    } finally {
      process.cwd = origCwd;
      cleanupDir(tmpDir);
    }
  });
  test("ensureDbOpen: opens existing DB", async () => {
    const tmpDir = makeTmpDir();
    const gsdDir = path.join(tmpDir, ".gsd");
    fs.mkdirSync(gsdDir, { recursive: true });
    const dbPath = path.join(gsdDir, "gsd.db");
    const { openDatabase } = await import("../gsd-db.js");
    openDatabase(dbPath);
    closeDatabase();
    assert.ok(fs.existsSync(dbPath), "DB file should exist from manual create");
    const origCwd = process.cwd;
    process.cwd = () => tmpDir;
    try {
      const { ensureDbOpen } = await import("../bootstrap/dynamic-tools.js");
      const result = await ensureDbOpen();
      assert.ok(result === true, "ensureDbOpen should open existing DB");
      assert.ok(isDbAvailable(), "DB should be available");
    } finally {
      process.cwd = origCwd;
      closeDatabase();
      cleanupDir(tmpDir);
    }
  });
  test("ensureDbOpen: empty .gsd/ creates empty DB (#2510)", async () => {
    const tmpDir = makeTmpDir();
    const gsdDir = path.join(tmpDir, ".gsd");
    fs.mkdirSync(gsdDir, { recursive: true });
    try {
      closeDatabase();
    } catch {
    }
    const origCwd = process.cwd;
    process.cwd = () => tmpDir;
    try {
      const { ensureDbOpen } = await import("../bootstrap/dynamic-tools.js");
      const result = await ensureDbOpen();
      assert.ok(result === true, "ensureDbOpen should create empty DB for fresh .gsd/");
      assert.ok(fs.existsSync(path.join(gsdDir, "gsd.db")), "DB file should be created");
      assert.ok(isDbAvailable(), "DB should be available");
    } finally {
      process.cwd = origCwd;
      closeDatabase();
      cleanupDir(tmpDir);
    }
  });
  test("ensureDbOpen: switches open database when basePath changes", async () => {
    const firstDir = makeTmpDir();
    const secondDir = makeTmpDir();
    fs.mkdirSync(path.join(firstDir, ".gsd"), { recursive: true });
    fs.mkdirSync(path.join(secondDir, ".gsd"), { recursive: true });
    fs.writeFileSync(path.join(firstDir, ".gsd", "DECISIONS.md"), `# Decisions

| # | When | Scope | Decision | Choice | Rationale | Revisable |
|---|------|-------|----------|--------|-----------|-----------|
| D101 | M001 | architecture | First DB | First | First rationale | Yes |
`);
    fs.writeFileSync(path.join(secondDir, ".gsd", "DECISIONS.md"), `# Decisions

| # | When | Scope | Decision | Choice | Rationale | Revisable |
|---|------|-------|----------|--------|-----------|-----------|
| D202 | M001 | architecture | Second DB | Second | Second rationale | Yes |
`);
    try {
      closeDatabase();
    } catch {
    }
    try {
      const { ensureDbOpen } = await import("../bootstrap/dynamic-tools.js");
      assert.equal(await ensureDbOpen(firstDir), true);
      assert.equal(getDecisionById("D101"), null, "first DB should not import DECISIONS.md");
      assert.equal(await ensureDbOpen(secondDir), true);
      assert.equal(getDecisionById("D202"), null, "second DB should not import DECISIONS.md");
      assert.equal(getDecisionById("D101"), null, "first DB should no longer be active after switch");
    } finally {
      closeDatabase();
      cleanupDir(firstDir);
      cleanupDir(secondDir);
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9lbnN1cmUtZGItb3Blbi50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyBkZXNjcmliZSwgdGVzdCB9IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7XG4vLyBlbnN1cmVEYk9wZW4gXHUyMDE0IFRlc3RzIHRoYXQgdGhlIGxhenkgREIgb3BlbmVyIGNyZWF0ZXMvb3BlbnMgdGhlIGF1dGhvcml0YXRpdmVcbi8vIGRhdGFiYXNlIHdpdGhvdXQgaW1wbGljaXRseSBpbXBvcnRpbmcgbWFya2Rvd24gcHJvamVjdGlvbnMuXG4vL1xuLy8gVGhpcyBjb3ZlcnMgdGhlIGJ1ZyB3aGVyZSBpbnRlcmFjdGl2ZSAobm9uLWF1dG8pIHNlc3Npb25zIGdvdFxuLy8gXCJHU0QgZGF0YWJhc2UgaXMgbm90IGF2YWlsYWJsZVwiIGJlY2F1c2UgZW5zdXJlRGJPcGVuIG9ubHkgb3BlbmVkXG4vLyBleGlzdGluZyBEQiBmaWxlcyBidXQgbmV2ZXIgY3JlYXRlZCB0aGVtLlxuXG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gJ25vZGU6cGF0aCc7XG5pbXBvcnQgKiBhcyBvcyBmcm9tICdub2RlOm9zJztcbmltcG9ydCAqIGFzIGZzIGZyb20gJ25vZGU6ZnMnO1xuaW1wb3J0IHsgY3JlYXRlUmVxdWlyZSB9IGZyb20gJ25vZGU6bW9kdWxlJztcbmltcG9ydCB7IGNsb3NlRGF0YWJhc2UsIGlzRGJBdmFpbGFibGUsIGdldERlY2lzaW9uQnlJZCwgU0NIRU1BX1ZFUlNJT04sIF9nZXRBZGFwdGVyIH0gZnJvbSAnLi4vZ3NkLWRiLnRzJztcblxuY29uc3QgX3JlcXVpcmUgPSBjcmVhdGVSZXF1aXJlKGltcG9ydC5tZXRhLnVybCk7XG5cbmZ1bmN0aW9uIG1ha2VUbXBEaXIoKTogc3RyaW5nIHtcbiAgY29uc3QgZGlyID0gZnMubWtkdGVtcFN5bmMocGF0aC5qb2luKG9zLnRtcGRpcigpLCAnZ3NkLWVuc3VyZS1kYi0nKSk7XG4gIHJldHVybiBkaXI7XG59XG5cbmZ1bmN0aW9uIGNsZWFudXBEaXIoZGlyOiBzdHJpbmcpOiB2b2lkIHtcbiAgdHJ5IHtcbiAgICBmcy5ybVN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH0gY2F0Y2ggeyAvKiBzd2FsbG93ICovIH1cbn1cblxuZnVuY3Rpb24gY3JlYXRlTGVnYWN5VjE1RGIoZGJQYXRoOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3Qgc3FsaXRlID0gX3JlcXVpcmUoJ25vZGU6c3FsaXRlJyk7XG4gIGNvbnN0IGRiID0gbmV3IHNxbGl0ZS5EYXRhYmFzZVN5bmMoZGJQYXRoKTtcbiAgZGIuZXhlYygnUFJBR01BIGpvdXJuYWxfbW9kZT1XQUwnKTtcbiAgZGIuZXhlYyhgXG4gICAgQ1JFQVRFIFRBQkxFIHNjaGVtYV92ZXJzaW9uIChcbiAgICAgIHZlcnNpb24gSU5URUdFUiBOT1QgTlVMTCxcbiAgICAgIGFwcGxpZWRfYXQgVEVYVCBOT1QgTlVMTFxuICAgICk7XG4gICAgSU5TRVJUIElOVE8gc2NoZW1hX3ZlcnNpb24gKHZlcnNpb24sIGFwcGxpZWRfYXQpIFZBTFVFUyAoMTUsICcyMDI2LTAxLTAxVDAwOjAwOjAwLjAwMFonKTtcblxuICAgIENSRUFURSBUQUJMRSBkZWNpc2lvbnMgKFxuICAgICAgc2VxIElOVEVHRVIgUFJJTUFSWSBLRVkgQVVUT0lOQ1JFTUVOVCxcbiAgICAgIGlkIFRFWFQgTk9UIE5VTEwgVU5JUVVFLFxuICAgICAgd2hlbl9jb250ZXh0IFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgIHNjb3BlIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgIGRlY2lzaW9uIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgIGNob2ljZSBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICByYXRpb25hbGUgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgcmV2aXNhYmxlIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgIG1hZGVfYnkgVEVYVCBOT1QgTlVMTCBERUZBVUxUICdhZ2VudCcsXG4gICAgICBzdXBlcnNlZGVkX2J5IFRFWFQgREVGQVVMVCBOVUxMXG4gICAgKTtcblxuICAgIENSRUFURSBUQUJMRSByZXF1aXJlbWVudHMgKFxuICAgICAgaWQgVEVYVCBQUklNQVJZIEtFWSxcbiAgICAgIGNsYXNzIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgIHN0YXR1cyBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICBkZXNjcmlwdGlvbiBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICB3aHkgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgc291cmNlIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgIHByaW1hcnlfb3duZXIgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgc3VwcG9ydGluZ19zbGljZXMgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgdmFsaWRhdGlvbiBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICBub3RlcyBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICBmdWxsX2NvbnRlbnQgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgc3VwZXJzZWRlZF9ieSBURVhUIERFRkFVTFQgTlVMTFxuICAgICk7XG5cbiAgICBDUkVBVEUgVEFCTEUgYXJ0aWZhY3RzIChcbiAgICAgIHBhdGggVEVYVCBQUklNQVJZIEtFWSxcbiAgICAgIGFydGlmYWN0X3R5cGUgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgbWlsZXN0b25lX2lkIFRFWFQgREVGQVVMVCBOVUxMLFxuICAgICAgc2xpY2VfaWQgVEVYVCBERUZBVUxUIE5VTEwsXG4gICAgICB0YXNrX2lkIFRFWFQgREVGQVVMVCBOVUxMLFxuICAgICAgZnVsbF9jb250ZW50IFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgIGltcG9ydGVkX2F0IFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJ1xuICAgICk7XG5cbiAgICBDUkVBVEUgVEFCTEUgbWVtb3JpZXMgKFxuICAgICAgc2VxIElOVEVHRVIgUFJJTUFSWSBLRVkgQVVUT0lOQ1JFTUVOVCxcbiAgICAgIGlkIFRFWFQgTk9UIE5VTEwgVU5JUVVFLFxuICAgICAgY2F0ZWdvcnkgVEVYVCBOT1QgTlVMTCxcbiAgICAgIGNvbnRlbnQgVEVYVCBOT1QgTlVMTCxcbiAgICAgIGNvbmZpZGVuY2UgUkVBTCBOT1QgTlVMTCBERUZBVUxUIDAuOCxcbiAgICAgIHNvdXJjZV91bml0X3R5cGUgVEVYVCxcbiAgICAgIHNvdXJjZV91bml0X2lkIFRFWFQsXG4gICAgICBjcmVhdGVkX2F0IFRFWFQgTk9UIE5VTEwsXG4gICAgICB1cGRhdGVkX2F0IFRFWFQgTk9UIE5VTEwsXG4gICAgICBzdXBlcnNlZGVkX2J5IFRFWFQgREVGQVVMVCBOVUxMLFxuICAgICAgaGl0X2NvdW50IElOVEVHRVIgTk9UIE5VTEwgREVGQVVMVCAwXG4gICAgKTtcblxuICAgIENSRUFURSBUQUJMRSBtZW1vcnlfcHJvY2Vzc2VkX3VuaXRzIChcbiAgICAgIHVuaXRfa2V5IFRFWFQgUFJJTUFSWSBLRVksXG4gICAgICBhY3Rpdml0eV9maWxlIFRFWFQsXG4gICAgICBwcm9jZXNzZWRfYXQgVEVYVCBOT1QgTlVMTFxuICAgICk7XG5cbiAgICBDUkVBVEUgVEFCTEUgbWlsZXN0b25lcyAoXG4gICAgICBpZCBURVhUIFBSSU1BUlkgS0VZLFxuICAgICAgdGl0bGUgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgc3RhdHVzIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnYWN0aXZlJyxcbiAgICAgIGRlcGVuZHNfb24gVEVYVCBOT1QgTlVMTCBERUZBVUxUICdbXScsXG4gICAgICBjcmVhdGVkX2F0IFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgIGNvbXBsZXRlZF9hdCBURVhUIERFRkFVTFQgTlVMTCxcbiAgICAgIHZpc2lvbiBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICBzdWNjZXNzX2NyaXRlcmlhIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnW10nLFxuICAgICAga2V5X3Jpc2tzIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnW10nLFxuICAgICAgcHJvb2Zfc3RyYXRlZ3kgVEVYVCBOT1QgTlVMTCBERUZBVUxUICdbXScsXG4gICAgICB2ZXJpZmljYXRpb25fY29udHJhY3QgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgdmVyaWZpY2F0aW9uX2ludGVncmF0aW9uIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgIHZlcmlmaWNhdGlvbl9vcGVyYXRpb25hbCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICB2ZXJpZmljYXRpb25fdWF0IFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgIGRlZmluaXRpb25fb2ZfZG9uZSBURVhUIE5PVCBOVUxMIERFRkFVTFQgJ1tdJyxcbiAgICAgIHJlcXVpcmVtZW50X2NvdmVyYWdlIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgIGJvdW5kYXJ5X21hcF9tYXJrZG93biBURVhUIE5PVCBOVUxMIERFRkFVTFQgJydcbiAgICApO1xuXG4gICAgQ1JFQVRFIFRBQkxFIHNsaWNlcyAoXG4gICAgICBtaWxlc3RvbmVfaWQgVEVYVCBOT1QgTlVMTCxcbiAgICAgIGlkIFRFWFQgTk9UIE5VTEwsXG4gICAgICB0aXRsZSBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICBzdGF0dXMgVEVYVCBOT1QgTlVMTCBERUZBVUxUICdwZW5kaW5nJyxcbiAgICAgIHJpc2sgVEVYVCBOT1QgTlVMTCBERUZBVUxUICdtZWRpdW0nLFxuICAgICAgZGVwZW5kcyBURVhUIE5PVCBOVUxMIERFRkFVTFQgJ1tdJyxcbiAgICAgIGRlbW8gVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgY3JlYXRlZF9hdCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICBjb21wbGV0ZWRfYXQgVEVYVCBERUZBVUxUIE5VTEwsXG4gICAgICBmdWxsX3N1bW1hcnlfbWQgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgZnVsbF91YXRfbWQgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgZ29hbCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICBzdWNjZXNzX2NyaXRlcmlhIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgIHByb29mX2xldmVsIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgIGludGVncmF0aW9uX2Nsb3N1cmUgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgb2JzZXJ2YWJpbGl0eV9pbXBhY3QgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgc2VxdWVuY2UgSU5URUdFUiBERUZBVUxUIDAsXG4gICAgICByZXBsYW5fdHJpZ2dlcmVkX2F0IFRFWFQgREVGQVVMVCBOVUxMLFxuICAgICAgUFJJTUFSWSBLRVkgKG1pbGVzdG9uZV9pZCwgaWQpXG4gICAgKTtcblxuICAgIENSRUFURSBUQUJMRSB0YXNrcyAoXG4gICAgICBtaWxlc3RvbmVfaWQgVEVYVCBOT1QgTlVMTCxcbiAgICAgIHNsaWNlX2lkIFRFWFQgTk9UIE5VTEwsXG4gICAgICBpZCBURVhUIE5PVCBOVUxMLFxuICAgICAgdGl0bGUgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgc3RhdHVzIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAncGVuZGluZycsXG4gICAgICBvbmVfbGluZXIgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgbmFycmF0aXZlIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgIHZlcmlmaWNhdGlvbl9yZXN1bHQgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgZHVyYXRpb24gVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgY29tcGxldGVkX2F0IFRFWFQgREVGQVVMVCBOVUxMLFxuICAgICAgYmxvY2tlcl9kaXNjb3ZlcmVkIElOVEVHRVIgREVGQVVMVCAwLFxuICAgICAgZGV2aWF0aW9ucyBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICBrbm93bl9pc3N1ZXMgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAga2V5X2ZpbGVzIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnW10nLFxuICAgICAga2V5X2RlY2lzaW9ucyBURVhUIE5PVCBOVUxMIERFRkFVTFQgJ1tdJyxcbiAgICAgIGZ1bGxfc3VtbWFyeV9tZCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICBkZXNjcmlwdGlvbiBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICBlc3RpbWF0ZSBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICBmaWxlcyBURVhUIE5PVCBOVUxMIERFRkFVTFQgJ1tdJyxcbiAgICAgIHZlcmlmeSBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICBpbnB1dHMgVEVYVCBOT1QgTlVMTCBERUZBVUxUICdbXScsXG4gICAgICBleHBlY3RlZF9vdXRwdXQgVEVYVCBOT1QgTlVMTCBERUZBVUxUICdbXScsXG4gICAgICBvYnNlcnZhYmlsaXR5X2ltcGFjdCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICBmdWxsX3BsYW5fbWQgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgc2VxdWVuY2UgSU5URUdFUiBERUZBVUxUIDAsXG4gICAgICBQUklNQVJZIEtFWSAobWlsZXN0b25lX2lkLCBzbGljZV9pZCwgaWQpXG4gICAgKTtcblxuICAgIENSRUFURSBUQUJMRSB2ZXJpZmljYXRpb25fZXZpZGVuY2UgKFxuICAgICAgaWQgSU5URUdFUiBQUklNQVJZIEtFWSBBVVRPSU5DUkVNRU5ULFxuICAgICAgdGFza19pZCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICBzbGljZV9pZCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICBtaWxlc3RvbmVfaWQgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgY29tbWFuZCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICBleGl0X2NvZGUgSU5URUdFUiBERUZBVUxUIDAsXG4gICAgICB2ZXJkaWN0IFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgIGR1cmF0aW9uX21zIElOVEVHRVIgREVGQVVMVCAwLFxuICAgICAgY3JlYXRlZF9hdCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJydcbiAgICApO1xuXG4gICAgQ1JFQVRFIFRBQkxFIHJlcGxhbl9oaXN0b3J5IChcbiAgICAgIGlkIElOVEVHRVIgUFJJTUFSWSBLRVkgQVVUT0lOQ1JFTUVOVCxcbiAgICAgIG1pbGVzdG9uZV9pZCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICBzbGljZV9pZCBURVhUIERFRkFVTFQgTlVMTCxcbiAgICAgIHRhc2tfaWQgVEVYVCBERUZBVUxUIE5VTEwsXG4gICAgICBzdW1tYXJ5IFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgIHByZXZpb3VzX2FydGlmYWN0X3BhdGggVEVYVCBERUZBVUxUIE5VTEwsXG4gICAgICByZXBsYWNlbWVudF9hcnRpZmFjdF9wYXRoIFRFWFQgREVGQVVMVCBOVUxMLFxuICAgICAgY3JlYXRlZF9hdCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJydcbiAgICApO1xuXG4gICAgQ1JFQVRFIFRBQkxFIGFzc2Vzc21lbnRzIChcbiAgICAgIHBhdGggVEVYVCBQUklNQVJZIEtFWSxcbiAgICAgIG1pbGVzdG9uZV9pZCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICBzbGljZV9pZCBURVhUIERFRkFVTFQgTlVMTCxcbiAgICAgIHRhc2tfaWQgVEVYVCBERUZBVUxUIE5VTEwsXG4gICAgICBzdGF0dXMgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgc2NvcGUgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgZnVsbF9jb250ZW50IFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgIGNyZWF0ZWRfYXQgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnXG4gICAgKTtcblxuICAgIENSRUFURSBUQUJMRSBxdWFsaXR5X2dhdGVzIChcbiAgICAgIG1pbGVzdG9uZV9pZCBURVhUIE5PVCBOVUxMLFxuICAgICAgc2xpY2VfaWQgVEVYVCBOT1QgTlVMTCxcbiAgICAgIGdhdGVfaWQgVEVYVCBOT1QgTlVMTCxcbiAgICAgIHNjb3BlIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnc2xpY2UnLFxuICAgICAgdGFza19pZCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICBzdGF0dXMgVEVYVCBOT1QgTlVMTCBERUZBVUxUICdwZW5kaW5nJyxcbiAgICAgIHZlcmRpY3QgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgcmF0aW9uYWxlIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgIGZpbmRpbmdzIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgIGV2YWx1YXRlZF9hdCBURVhUIERFRkFVTFQgTlVMTCxcbiAgICAgIFBSSU1BUlkgS0VZIChtaWxlc3RvbmVfaWQsIHNsaWNlX2lkLCBnYXRlX2lkLCB0YXNrX2lkKVxuICAgICk7XG5cbiAgICBDUkVBVEUgVEFCTEUgc2xpY2VfZGVwZW5kZW5jaWVzIChcbiAgICAgIG1pbGVzdG9uZV9pZCBURVhUIE5PVCBOVUxMLFxuICAgICAgc2xpY2VfaWQgVEVYVCBOT1QgTlVMTCxcbiAgICAgIGRlcGVuZHNfb25fc2xpY2VfaWQgVEVYVCBOT1QgTlVMTCxcbiAgICAgIFBSSU1BUlkgS0VZIChtaWxlc3RvbmVfaWQsIHNsaWNlX2lkLCBkZXBlbmRzX29uX3NsaWNlX2lkKVxuICAgICk7XG5cbiAgICBDUkVBVEUgVEFCTEUgZ2F0ZV9ydW5zIChcbiAgICAgIGlkIElOVEVHRVIgUFJJTUFSWSBLRVkgQVVUT0lOQ1JFTUVOVCxcbiAgICAgIHRyYWNlX2lkIFRFWFQgTk9UIE5VTEwsXG4gICAgICB0dXJuX2lkIFRFWFQgTk9UIE5VTEwsXG4gICAgICBnYXRlX2lkIFRFWFQgTk9UIE5VTEwsXG4gICAgICBnYXRlX3R5cGUgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgdW5pdF90eXBlIFRFWFQgREVGQVVMVCBOVUxMLFxuICAgICAgdW5pdF9pZCBURVhUIERFRkFVTFQgTlVMTCxcbiAgICAgIG1pbGVzdG9uZV9pZCBURVhUIERFRkFVTFQgTlVMTCxcbiAgICAgIHNsaWNlX2lkIFRFWFQgREVGQVVMVCBOVUxMLFxuICAgICAgdGFza19pZCBURVhUIERFRkFVTFQgTlVMTCxcbiAgICAgIG91dGNvbWUgVEVYVCBOT1QgTlVMTCBERUZBVUxUICdwYXNzJyxcbiAgICAgIGZhaWx1cmVfY2xhc3MgVEVYVCBOT1QgTlVMTCBERUZBVUxUICdub25lJyxcbiAgICAgIHJhdGlvbmFsZSBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICBmaW5kaW5ncyBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICBhdHRlbXB0IElOVEVHRVIgTk9UIE5VTEwgREVGQVVMVCAxLFxuICAgICAgbWF4X2F0dGVtcHRzIElOVEVHRVIgTk9UIE5VTEwgREVGQVVMVCAxLFxuICAgICAgcmV0cnlhYmxlIElOVEVHRVIgTk9UIE5VTEwgREVGQVVMVCAwLFxuICAgICAgZXZhbHVhdGVkX2F0IFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJ1xuICAgICk7XG5cbiAgICBDUkVBVEUgVEFCTEUgdHVybl9naXRfdHJhbnNhY3Rpb25zIChcbiAgICAgIHRyYWNlX2lkIFRFWFQgTk9UIE5VTEwsXG4gICAgICB0dXJuX2lkIFRFWFQgTk9UIE5VTEwsXG4gICAgICB1bml0X3R5cGUgVEVYVCBERUZBVUxUIE5VTEwsXG4gICAgICB1bml0X2lkIFRFWFQgREVGQVVMVCBOVUxMLFxuICAgICAgc3RhZ2UgVEVYVCBOT1QgTlVMTCBERUZBVUxUICd0dXJuLXN0YXJ0JyxcbiAgICAgIGFjdGlvbiBURVhUIE5PVCBOVUxMIERFRkFVTFQgJ3N0YXR1cy1vbmx5JyxcbiAgICAgIHB1c2ggSU5URUdFUiBOT1QgTlVMTCBERUZBVUxUIDAsXG4gICAgICBzdGF0dXMgVEVYVCBOT1QgTlVMTCBERUZBVUxUICdvaycsXG4gICAgICBlcnJvciBURVhUIERFRkFVTFQgTlVMTCxcbiAgICAgIG1ldGFkYXRhX2pzb24gVEVYVCBOT1QgTlVMTCBERUZBVUxUICd7fScsXG4gICAgICB1cGRhdGVkX2F0IFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgIFBSSU1BUlkgS0VZICh0cmFjZV9pZCwgdHVybl9pZCwgc3RhZ2UpXG4gICAgKTtcblxuICAgIENSRUFURSBUQUJMRSBhdWRpdF9ldmVudHMgKFxuICAgICAgZXZlbnRfaWQgVEVYVCBQUklNQVJZIEtFWSxcbiAgICAgIHRyYWNlX2lkIFRFWFQgTk9UIE5VTEwsXG4gICAgICB0dXJuX2lkIFRFWFQgREVGQVVMVCBOVUxMLFxuICAgICAgY2F1c2VkX2J5IFRFWFQgREVGQVVMVCBOVUxMLFxuICAgICAgY2F0ZWdvcnkgVEVYVCBOT1QgTlVMTCxcbiAgICAgIHR5cGUgVEVYVCBOT1QgTlVMTCxcbiAgICAgIHRzIFRFWFQgTk9UIE5VTEwsXG4gICAgICBwYXlsb2FkX2pzb24gVEVYVCBOT1QgTlVMTCBERUZBVUxUICd7fSdcbiAgICApO1xuXG4gICAgQ1JFQVRFIFRBQkxFIGF1ZGl0X3R1cm5faW5kZXggKFxuICAgICAgdHJhY2VfaWQgVEVYVCBOT1QgTlVMTCxcbiAgICAgIHR1cm5faWQgVEVYVCBOT1QgTlVMTCxcbiAgICAgIGZpcnN0X3RzIFRFWFQgTk9UIE5VTEwsXG4gICAgICBsYXN0X3RzIFRFWFQgTk9UIE5VTEwsXG4gICAgICBldmVudF9jb3VudCBJTlRFR0VSIE5PVCBOVUxMIERFRkFVTFQgMCxcbiAgICAgIFBSSU1BUlkgS0VZICh0cmFjZV9pZCwgdHVybl9pZClcbiAgICApO1xuICBgKTtcbiAgZGIuZXhlYygnUFJBR01BIHdhbF9jaGVja3BvaW50KFRSVU5DQVRFKScpO1xuICBkYi5jbG9zZSgpO1xuICB0cnkgeyBmcy51bmxpbmtTeW5jKGAke2RiUGF0aH0td2FsYCk7IH0gY2F0Y2ggeyAvKiBtYXkgbm90IGV4aXN0ICovIH1cbiAgdHJ5IHsgZnMudW5saW5rU3luYyhgJHtkYlBhdGh9LXNobWApOyB9IGNhdGNoIHsgLyogbWF5IG5vdCBleGlzdCAqLyB9XG59XG5cbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuLy8gZW5zdXJlRGJPcGVuIGNyZWF0ZXMgREIgd2l0aG91dCBpbXBsaWNpdCBNYXJrZG93biBtaWdyYXRpb25cbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG5kZXNjcmliZSgnZW5zdXJlLWRiLW9wZW4nLCAoKSA9PiB7XG4gIHRlc3QoJ2Vuc3VyZURiT3BlbjogY3JlYXRlcyBlbXB0eSBEQiB3aXRob3V0IGltcG9ydGluZyBNYXJrZG93bicsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB0bXBEaXIgPSBtYWtlVG1wRGlyKCk7XG4gICAgY29uc3QgZ3NkRGlyID0gcGF0aC5qb2luKHRtcERpciwgJy5nc2QnKTtcbiAgICBmcy5ta2RpclN5bmMoZ3NkRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAgIC8vIFdyaXRlIGEgbWluaW1hbCBERUNJU0lPTlMubWQgc28gbWlncmF0aW9uIGhhcyBjb250ZW50XG4gICAgY29uc3QgZGVjaXNpb25zQ29udGVudCA9IGAjIERlY2lzaW9uc1xuXG4gIHwgIyB8IFdoZW4gfCBTY29wZSB8IERlY2lzaW9uIHwgQ2hvaWNlIHwgUmF0aW9uYWxlIHwgUmV2aXNhYmxlIHxcbiAgfC0tLXwtLS0tLS18LS0tLS0tLXwtLS0tLS0tLS0tfC0tLS0tLS0tfC0tLS0tLS0tLS0tfC0tLS0tLS0tLS0tfFxuICB8IEQwMDEgfCBNMDAxIHwgYXJjaGl0ZWN0dXJlIHwgVXNlIFNRTGl0ZSB8IFNRTGl0ZSB8IFN5bmMgQVBJIHwgWWVzIHxcbiAgYDtcbiAgICBmcy53cml0ZUZpbGVTeW5jKHBhdGguam9pbihnc2REaXIsICdERUNJU0lPTlMubWQnKSwgZGVjaXNpb25zQ29udGVudCk7XG5cbiAgICAvLyBWZXJpZnkgbm8gREIgZmlsZSBleGlzdHMgeWV0XG4gICAgY29uc3QgZGJQYXRoID0gcGF0aC5qb2luKGdzZERpciwgJ2dzZC5kYicpO1xuICAgIGFzc2VydC5vayghZnMuZXhpc3RzU3luYyhkYlBhdGgpLCAnREIgZmlsZSBzaG91bGQgbm90IGV4aXN0IGJlZm9yZSBlbnN1cmVEYk9wZW4nKTtcblxuICAgIC8vIENsb3NlIGFueSBwcmV2aW91c2x5IG9wZW4gREJcbiAgICB0cnkgeyBjbG9zZURhdGFiYXNlKCk7IH0gY2F0Y2ggeyAvKiBvayAqLyB9XG5cbiAgICAvLyBPdmVycmlkZSBwcm9jZXNzLmN3ZCB0byBwb2ludCBhdCB0bXBEaXIgZm9yIGVuc3VyZURiT3BlblxuICAgIGNvbnN0IG9yaWdDd2QgPSBwcm9jZXNzLmN3ZDtcbiAgICBwcm9jZXNzLmN3ZCA9ICgpID0+IHRtcERpcjtcblxuICAgIHRyeSB7XG4gICAgICAvLyBEeW5hbWljIGltcG9ydCB0byBnZXQgdGhlIGZyZXNoZXN0IHZlcnNpb25cbiAgICAgIGNvbnN0IHsgZW5zdXJlRGJPcGVuIH0gPSBhd2FpdCBpbXBvcnQoJy4uL2Jvb3RzdHJhcC9keW5hbWljLXRvb2xzLnRzJyk7XG5cbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGVuc3VyZURiT3BlbigpO1xuXG4gICAgICBhc3NlcnQub2socmVzdWx0ID09PSB0cnVlLCAnZW5zdXJlRGJPcGVuIHNob3VsZCByZXR1cm4gdHJ1ZSB3aGVuIC5nc2QvIGV4aXN0cycpO1xuICAgICAgYXNzZXJ0Lm9rKGZzLmV4aXN0c1N5bmMoZGJQYXRoKSwgJ0RCIGZpbGUgc2hvdWxkIGJlIGNyZWF0ZWQgYWZ0ZXIgZW5zdXJlRGJPcGVuJyk7XG4gICAgICBhc3NlcnQub2soaXNEYkF2YWlsYWJsZSgpLCAnREIgc2hvdWxkIGJlIGF2YWlsYWJsZSBhZnRlciBlbnN1cmVEYk9wZW4nKTtcblxuICAgICAgY29uc3QgZGVjaXNpb24gPSBnZXREZWNpc2lvbkJ5SWQoJ0QwMDEnKTtcbiAgICAgIGFzc2VydC5lcXVhbChkZWNpc2lvbiwgbnVsbCwgJ0QwMDEgc2hvdWxkIG5vdCBiZSBpbXBvcnRlZCBmcm9tIERFQ0lTSU9OUy5tZCB3aXRob3V0IGV4cGxpY2l0IG1pZ3JhdGlvbicpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBwcm9jZXNzLmN3ZCA9IG9yaWdDd2Q7XG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgICBjbGVhbnVwRGlyKHRtcERpcik7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KCdlbnN1cmVEYk9wZW46IGV4cGxpY2l0IGJhc2VQYXRoIG9wZW5zIHRhcmdldCBwcm9qZWN0IHdpdGhvdXQgY3dkIG92ZXJyaWRlJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHRtcERpciA9IG1ha2VUbXBEaXIoKTtcbiAgICBjb25zdCBnc2REaXIgPSBwYXRoLmpvaW4odG1wRGlyLCAnLmdzZCcpO1xuICAgIGZzLm1rZGlyU3luYyhnc2REaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIGZzLndyaXRlRmlsZVN5bmMocGF0aC5qb2luKGdzZERpciwgJ0RFQ0lTSU9OUy5tZCcpLCBgIyBEZWNpc2lvbnNcblxufCAjIHwgV2hlbiB8IFNjb3BlIHwgRGVjaXNpb24gfCBDaG9pY2UgfCBSYXRpb25hbGUgfCBSZXZpc2FibGUgfFxufC0tLXwtLS0tLS18LS0tLS0tLXwtLS0tLS0tLS0tfC0tLS0tLS0tfC0tLS0tLS0tLS0tfC0tLS0tLS0tLS0tfFxufCBENzc3IHwgTTAwMSB8IGFyY2hpdGVjdHVyZSB8IFVzZSBleHBsaWNpdCBiYXNlUGF0aCB8IEJhc2VQYXRoIHwgQXZvaWQgY3dkIGNvdXBsaW5nIHwgWWVzIHxcbmApO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICB9IGNhdGNoIHsgLyogb2sgKi8gfVxuXG4gICAgY29uc3Qgb3JpZ2luYWxDd2QgPSBwcm9jZXNzLmN3ZCgpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCB7IGVuc3VyZURiT3BlbiB9ID0gYXdhaXQgaW1wb3J0KCcuLi9ib290c3RyYXAvZHluYW1pYy10b29scy50cycpO1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZW5zdXJlRGJPcGVuKHRtcERpcik7XG5cbiAgICAgIGFzc2VydC5vayhyZXN1bHQgPT09IHRydWUsICdlbnN1cmVEYk9wZW4gc2hvdWxkIGhvbm9yIGV4cGxpY2l0IGJhc2VQYXRoJyk7XG4gICAgICBhc3NlcnQuZXF1YWwocHJvY2Vzcy5jd2QoKSwgb3JpZ2luYWxDd2QsICdlbnN1cmVEYk9wZW4gc2hvdWxkIG5vdCBtdXRhdGUgcHJvY2Vzcy5jd2QnKTtcbiAgICAgIGFzc2VydC5vayhpc0RiQXZhaWxhYmxlKCksICdEQiBzaG91bGQgYmUgYXZhaWxhYmxlIGFmdGVyIGV4cGxpY2l0IG9wZW4nKTtcbiAgICAgIGFzc2VydC5lcXVhbChnZXREZWNpc2lvbkJ5SWQoJ0Q3NzcnKSwgbnVsbCwgJ2V4cGxpY2l0IGJhc2VQYXRoIHNob3VsZCBub3QgaW1wb3J0IERFQ0lTSU9OUy5tZCcpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgICBjbGVhbnVwRGlyKHRtcERpcik7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KCdlbnN1cmVEYk9wZW46IG1pZ3JhdGVzIGxlZ2FjeSB2MTUgREIgYmVmb3JlIGJvb3RzdHJhcCBpbmRleGVzIHRvdWNoIG5ldyBjb2x1bW5zJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHRtcERpciA9IG1ha2VUbXBEaXIoKTtcbiAgICBjb25zdCBnc2REaXIgPSBwYXRoLmpvaW4odG1wRGlyLCAnLmdzZCcpO1xuICAgIGZzLm1rZGlyU3luYyhnc2REaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIGNvbnN0IGRiUGF0aCA9IHBhdGguam9pbihnc2REaXIsICdnc2QuZGInKTtcbiAgICBjcmVhdGVMZWdhY3lWMTVEYihkYlBhdGgpO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICB9IGNhdGNoIHsgLyogb2sgKi8gfVxuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHsgZW5zdXJlRGJPcGVuIH0gPSBhd2FpdCBpbXBvcnQoJy4uL2Jvb3RzdHJhcC9keW5hbWljLXRvb2xzLnRzJyk7XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBlbnN1cmVEYk9wZW4odG1wRGlyKTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgdHJ1ZSwgJ2xlZ2FjeSB2MTUgREIgc2hvdWxkIG9wZW4gYW5kIG1pZ3JhdGUnKTtcbiAgICAgIGFzc2VydC5vayhpc0RiQXZhaWxhYmxlKCksICdEQiBzaG91bGQgYmUgYXZhaWxhYmxlIGFmdGVyIG1pZ3JhdGluZyB2MTUnKTtcblxuICAgICAgY29uc3QgZGIgPSBfZ2V0QWRhcHRlcigpO1xuICAgICAgYXNzZXJ0Lm9rKGRiLCAnYWRhcHRlciBzaG91bGQgYmUgYXZhaWxhYmxlIGFmdGVyIGVuc3VyZURiT3BlbicpO1xuICAgICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgICBkYi5wcmVwYXJlKCdTRUxFQ1QgTUFYKHZlcnNpb24pIGFzIHZlcnNpb24gRlJPTSBzY2hlbWFfdmVyc2lvbicpLmdldCgpPy52ZXJzaW9uLFxuICAgICAgICBTQ0hFTUFfVkVSU0lPTixcbiAgICAgICAgJ2xlZ2FjeSBEQiBzaG91bGQgbWlncmF0ZSB0byBjdXJyZW50IHNjaGVtYSB2ZXJzaW9uJyxcbiAgICAgICk7XG5cbiAgICAgIGNvbnN0IG1lbW9yeUNvbHVtbnMgPSBuZXcgU2V0KGRiLnByZXBhcmUoJ1BSQUdNQSB0YWJsZV9pbmZvKG1lbW9yaWVzKScpLmFsbCgpLm1hcCgocm93KSA9PiByb3cubmFtZSkpO1xuICAgICAgY29uc3QgdGFza0NvbHVtbnMgPSBuZXcgU2V0KGRiLnByZXBhcmUoJ1BSQUdNQSB0YWJsZV9pbmZvKHRhc2tzKScpLmFsbCgpLm1hcCgocm93KSA9PiByb3cubmFtZSkpO1xuICAgICAgYXNzZXJ0Lm9rKG1lbW9yeUNvbHVtbnMuaGFzKCdzY29wZScpLCAnbWVtb3J5IHNjb3BlIGNvbHVtbiBzaG91bGQgYmUgcHJlc2VudCcpO1xuICAgICAgYXNzZXJ0Lm9rKG1lbW9yeUNvbHVtbnMuaGFzKCd0YWdzJyksICdtZW1vcnkgdGFncyBjb2x1bW4gc2hvdWxkIGJlIHByZXNlbnQnKTtcbiAgICAgIGFzc2VydC5vayh0YXNrQ29sdW1ucy5oYXMoJ2VzY2FsYXRpb25fcGVuZGluZycpLCAndGFzayBlc2NhbGF0aW9uX3BlbmRpbmcgY29sdW1uIHNob3VsZCBiZSBwcmVzZW50Jyk7XG4gICAgICBhc3NlcnQub2soXG4gICAgICAgIGRiLnByZXBhcmUoXCJTRUxFQ1QgMSBhcyBwcmVzZW50IEZST00gc3FsaXRlX21hc3RlciBXSEVSRSB0eXBlID0gJ2luZGV4JyBBTkQgbmFtZSA9ICdpZHhfbWVtb3JpZXNfc2NvcGUnXCIpLmdldCgpLFxuICAgICAgICAnbWVtb3J5IHNjb3BlIGluZGV4IHNob3VsZCBiZSBjcmVhdGVkIGFmdGVyIG1pZ3JhdGlvbi1zYWZlIGJvb3RzdHJhcCcsXG4gICAgICApO1xuICAgICAgYXNzZXJ0Lm9rKFxuICAgICAgICBkYi5wcmVwYXJlKFwiU0VMRUNUIDEgYXMgcHJlc2VudCBGUk9NIHNxbGl0ZV9tYXN0ZXIgV0hFUkUgdHlwZSA9ICdpbmRleCcgQU5EIG5hbWUgPSAnaWR4X3Rhc2tzX2VzY2FsYXRpb25fcGVuZGluZydcIikuZ2V0KCksXG4gICAgICAgICd0YXNrIGVzY2FsYXRpb24gaW5kZXggc2hvdWxkIGJlIGNyZWF0ZWQgYWZ0ZXIgbWlncmF0aW9uLXNhZmUgYm9vdHN0cmFwJyxcbiAgICAgICk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICAgIGNsZWFudXBEaXIodG1wRGlyKTtcbiAgICB9XG4gIH0pO1xuXG4gIC8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuICAvLyBlbnN1cmVEYk9wZW4gcmV0dXJucyBmYWxzZSB3aGVuIG5vIC5nc2QvIGV4aXN0c1xuICAvLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuICB0ZXN0KCdlbnN1cmVEYk9wZW46IG5vIC5nc2QvIHJldHVybnMgZmFsc2UnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgdG1wRGlyID0gbWFrZVRtcERpcigpO1xuICAgIC8vIE5vIC5nc2QvIGRpcmVjdG9yeSBhdCBhbGxcblxuICAgIHRyeSB7IGNsb3NlRGF0YWJhc2UoKTsgfSBjYXRjaCB7IC8qIG9rICovIH1cbiAgICBjb25zdCBvcmlnQ3dkID0gcHJvY2Vzcy5jd2Q7XG4gICAgcHJvY2Vzcy5jd2QgPSAoKSA9PiB0bXBEaXI7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgeyBlbnN1cmVEYk9wZW4gfSA9IGF3YWl0IGltcG9ydCgnLi4vYm9vdHN0cmFwL2R5bmFtaWMtdG9vbHMudHMnKTtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGVuc3VyZURiT3BlbigpO1xuICAgICAgYXNzZXJ0Lm9rKHJlc3VsdCA9PT0gZmFsc2UsICdlbnN1cmVEYk9wZW4gc2hvdWxkIHJldHVybiBmYWxzZSB3aGVuIG5vIC5nc2QvIGV4aXN0cycpO1xuICAgICAgYXNzZXJ0Lm9rKCFpc0RiQXZhaWxhYmxlKCksICdEQiBzaG91bGQgbm90IGJlIGF2YWlsYWJsZScpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBwcm9jZXNzLmN3ZCA9IG9yaWdDd2Q7XG4gICAgICBjbGVhbnVwRGlyKHRtcERpcik7XG4gICAgfVxuICB9KTtcblxuICAvLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbiAgLy8gZW5zdXJlRGJPcGVuIG9wZW5zIGV4aXN0aW5nIERCIHdpdGhvdXQgcmUtbWlncmF0aW9uXG4gIC8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG4gIHRlc3QoJ2Vuc3VyZURiT3Blbjogb3BlbnMgZXhpc3RpbmcgREInLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgdG1wRGlyID0gbWFrZVRtcERpcigpO1xuICAgIGNvbnN0IGdzZERpciA9IHBhdGguam9pbih0bXBEaXIsICcuZ3NkJyk7XG4gICAgZnMubWtkaXJTeW5jKGdzZERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgICAvLyBDcmVhdGUgYSBEQiBmaWxlIGZpcnN0XG4gICAgY29uc3QgZGJQYXRoID0gcGF0aC5qb2luKGdzZERpciwgJ2dzZC5kYicpO1xuICAgIGNvbnN0IHsgb3BlbkRhdGFiYXNlIH0gPSBhd2FpdCBpbXBvcnQoJy4uL2dzZC1kYi50cycpO1xuICAgIG9wZW5EYXRhYmFzZShkYlBhdGgpO1xuICAgIGNsb3NlRGF0YWJhc2UoKTtcblxuICAgIGFzc2VydC5vayhmcy5leGlzdHNTeW5jKGRiUGF0aCksICdEQiBmaWxlIHNob3VsZCBleGlzdCBmcm9tIG1hbnVhbCBjcmVhdGUnKTtcblxuICAgIGNvbnN0IG9yaWdDd2QgPSBwcm9jZXNzLmN3ZDtcbiAgICBwcm9jZXNzLmN3ZCA9ICgpID0+IHRtcERpcjtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCB7IGVuc3VyZURiT3BlbiB9ID0gYXdhaXQgaW1wb3J0KCcuLi9ib290c3RyYXAvZHluYW1pYy10b29scy50cycpO1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZW5zdXJlRGJPcGVuKCk7XG4gICAgICBhc3NlcnQub2socmVzdWx0ID09PSB0cnVlLCAnZW5zdXJlRGJPcGVuIHNob3VsZCBvcGVuIGV4aXN0aW5nIERCJyk7XG4gICAgICBhc3NlcnQub2soaXNEYkF2YWlsYWJsZSgpLCAnREIgc2hvdWxkIGJlIGF2YWlsYWJsZScpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBwcm9jZXNzLmN3ZCA9IG9yaWdDd2Q7XG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgICBjbGVhbnVwRGlyKHRtcERpcik7XG4gICAgfVxuICB9KTtcblxuICAvLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbiAgLy8gZW5zdXJlRGJPcGVuIHJldHVybnMgZmFsc2UgZm9yIGVtcHR5IC5nc2QvIChubyBNYXJrZG93biwgbm8gREIpXG4gIC8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG4gIHRlc3QoJ2Vuc3VyZURiT3BlbjogZW1wdHkgLmdzZC8gY3JlYXRlcyBlbXB0eSBEQiAoIzI1MTApJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHRtcERpciA9IG1ha2VUbXBEaXIoKTtcbiAgICBjb25zdCBnc2REaXIgPSBwYXRoLmpvaW4odG1wRGlyLCAnLmdzZCcpO1xuICAgIGZzLm1rZGlyU3luYyhnc2REaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIC8vIC5nc2QvIGV4aXN0cyBidXQgbm8gREVDSVNJT05TLm1kLCBSRVFVSVJFTUVOVFMubWQsIG9yIG1pbGVzdG9uZXMvXG5cbiAgICB0cnkgeyBjbG9zZURhdGFiYXNlKCk7IH0gY2F0Y2ggeyAvKiBvayAqLyB9XG4gICAgY29uc3Qgb3JpZ0N3ZCA9IHByb2Nlc3MuY3dkO1xuICAgIHByb2Nlc3MuY3dkID0gKCkgPT4gdG1wRGlyO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHsgZW5zdXJlRGJPcGVuIH0gPSBhd2FpdCBpbXBvcnQoJy4uL2Jvb3RzdHJhcC9keW5hbWljLXRvb2xzLnRzJyk7XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBlbnN1cmVEYk9wZW4oKTtcbiAgICAgIGFzc2VydC5vayhyZXN1bHQgPT09IHRydWUsICdlbnN1cmVEYk9wZW4gc2hvdWxkIGNyZWF0ZSBlbXB0eSBEQiBmb3IgZnJlc2ggLmdzZC8nKTtcbiAgICAgIGFzc2VydC5vayhmcy5leGlzdHNTeW5jKHBhdGguam9pbihnc2REaXIsICdnc2QuZGInKSksICdEQiBmaWxlIHNob3VsZCBiZSBjcmVhdGVkJyk7XG4gICAgICBhc3NlcnQub2soaXNEYkF2YWlsYWJsZSgpLCAnREIgc2hvdWxkIGJlIGF2YWlsYWJsZScpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBwcm9jZXNzLmN3ZCA9IG9yaWdDd2Q7XG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgICBjbGVhbnVwRGlyKHRtcERpcik7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KCdlbnN1cmVEYk9wZW46IHN3aXRjaGVzIG9wZW4gZGF0YWJhc2Ugd2hlbiBiYXNlUGF0aCBjaGFuZ2VzJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGZpcnN0RGlyID0gbWFrZVRtcERpcigpO1xuICAgIGNvbnN0IHNlY29uZERpciA9IG1ha2VUbXBEaXIoKTtcbiAgICBmcy5ta2RpclN5bmMocGF0aC5qb2luKGZpcnN0RGlyLCAnLmdzZCcpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBmcy5ta2RpclN5bmMocGF0aC5qb2luKHNlY29uZERpciwgJy5nc2QnKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgZnMud3JpdGVGaWxlU3luYyhwYXRoLmpvaW4oZmlyc3REaXIsICcuZ3NkJywgJ0RFQ0lTSU9OUy5tZCcpLCBgIyBEZWNpc2lvbnNcblxufCAjIHwgV2hlbiB8IFNjb3BlIHwgRGVjaXNpb24gfCBDaG9pY2UgfCBSYXRpb25hbGUgfCBSZXZpc2FibGUgfFxufC0tLXwtLS0tLS18LS0tLS0tLXwtLS0tLS0tLS0tfC0tLS0tLS0tfC0tLS0tLS0tLS0tfC0tLS0tLS0tLS0tfFxufCBEMTAxIHwgTTAwMSB8IGFyY2hpdGVjdHVyZSB8IEZpcnN0IERCIHwgRmlyc3QgfCBGaXJzdCByYXRpb25hbGUgfCBZZXMgfFxuYCk7XG4gICAgZnMud3JpdGVGaWxlU3luYyhwYXRoLmpvaW4oc2Vjb25kRGlyLCAnLmdzZCcsICdERUNJU0lPTlMubWQnKSwgYCMgRGVjaXNpb25zXG5cbnwgIyB8IFdoZW4gfCBTY29wZSB8IERlY2lzaW9uIHwgQ2hvaWNlIHwgUmF0aW9uYWxlIHwgUmV2aXNhYmxlIHxcbnwtLS18LS0tLS0tfC0tLS0tLS18LS0tLS0tLS0tLXwtLS0tLS0tLXwtLS0tLS0tLS0tLXwtLS0tLS0tLS0tLXxcbnwgRDIwMiB8IE0wMDEgfCBhcmNoaXRlY3R1cmUgfCBTZWNvbmQgREIgfCBTZWNvbmQgfCBTZWNvbmQgcmF0aW9uYWxlIHwgWWVzIHxcbmApO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICB9IGNhdGNoIHsgLyogb2sgKi8gfVxuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHsgZW5zdXJlRGJPcGVuIH0gPSBhd2FpdCBpbXBvcnQoJy4uL2Jvb3RzdHJhcC9keW5hbWljLXRvb2xzLnRzJyk7XG4gICAgICBhc3NlcnQuZXF1YWwoYXdhaXQgZW5zdXJlRGJPcGVuKGZpcnN0RGlyKSwgdHJ1ZSk7XG4gICAgICBhc3NlcnQuZXF1YWwoZ2V0RGVjaXNpb25CeUlkKCdEMTAxJyksIG51bGwsICdmaXJzdCBEQiBzaG91bGQgbm90IGltcG9ydCBERUNJU0lPTlMubWQnKTtcbiAgICAgIGFzc2VydC5lcXVhbChhd2FpdCBlbnN1cmVEYk9wZW4oc2Vjb25kRGlyKSwgdHJ1ZSk7XG4gICAgICBhc3NlcnQuZXF1YWwoZ2V0RGVjaXNpb25CeUlkKCdEMjAyJyksIG51bGwsICdzZWNvbmQgREIgc2hvdWxkIG5vdCBpbXBvcnQgREVDSVNJT05TLm1kJyk7XG4gICAgICBhc3NlcnQuZXF1YWwoZ2V0RGVjaXNpb25CeUlkKCdEMTAxJyksIG51bGwsICdmaXJzdCBEQiBzaG91bGQgbm8gbG9uZ2VyIGJlIGFjdGl2ZSBhZnRlciBzd2l0Y2gnKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgICAgY2xlYW51cERpcihmaXJzdERpcik7XG4gICAgICBjbGVhbnVwRGlyKHNlY29uZERpcik7XG4gICAgfVxuICB9KTtcblxuICAvLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxTQUFTLFVBQVUsWUFBWTtBQUMvQixPQUFPLFlBQVk7QUFRbkIsWUFBWSxVQUFVO0FBQ3RCLFlBQVksUUFBUTtBQUNwQixZQUFZLFFBQVE7QUFDcEIsU0FBUyxxQkFBcUI7QUFDOUIsU0FBUyxlQUFlLGVBQWUsaUJBQWlCLGdCQUFnQixtQkFBbUI7QUFFM0YsTUFBTSxXQUFXLGNBQWMsWUFBWSxHQUFHO0FBRTlDLFNBQVMsYUFBcUI7QUFDNUIsUUFBTSxNQUFNLEdBQUcsWUFBWSxLQUFLLEtBQUssR0FBRyxPQUFPLEdBQUcsZ0JBQWdCLENBQUM7QUFDbkUsU0FBTztBQUNUO0FBRUEsU0FBUyxXQUFXLEtBQW1CO0FBQ3JDLE1BQUk7QUFDRixPQUFHLE9BQU8sS0FBSyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLEVBQ2pELFFBQVE7QUFBQSxFQUFnQjtBQUMxQjtBQUVBLFNBQVMsa0JBQWtCLFFBQXNCO0FBQy9DLFFBQU0sU0FBUyxTQUFTLGFBQWE7QUFDckMsUUFBTSxLQUFLLElBQUksT0FBTyxhQUFhLE1BQU07QUFDekMsS0FBRyxLQUFLLHlCQUF5QjtBQUNqQyxLQUFHLEtBQUs7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FB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
