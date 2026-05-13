import { ensureColumn } from "./db-schema-metadata.js";
function applyMigrationV2Artifacts(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS artifacts (
      path TEXT PRIMARY KEY,
      artifact_type TEXT NOT NULL DEFAULT '',
      milestone_id TEXT DEFAULT NULL,
      slice_id TEXT DEFAULT NULL,
      task_id TEXT DEFAULT NULL,
      full_content TEXT NOT NULL DEFAULT '',
      imported_at TEXT NOT NULL DEFAULT ''
    )
  `);
}
function applyMigrationV3Memories(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
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
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_processed_units (
      unit_key TEXT PRIMARY KEY,
      activity_file TEXT,
      processed_at TEXT NOT NULL
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(superseded_by)");
  db.exec("DROP VIEW IF EXISTS active_memories");
  db.exec("CREATE VIEW active_memories AS SELECT * FROM memories WHERE superseded_by IS NULL");
}
function applyMigrationV4DecisionMadeBy(db) {
  ensureColumn(db, "decisions", "made_by", "ALTER TABLE decisions ADD COLUMN made_by TEXT NOT NULL DEFAULT 'agent'");
  db.exec("DROP VIEW IF EXISTS active_decisions");
  db.exec("CREATE VIEW active_decisions AS SELECT * FROM decisions WHERE superseded_by IS NULL");
}
function applyMigrationV5HierarchyTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS milestones (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      completed_at TEXT DEFAULT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS slices (
      milestone_id TEXT NOT NULL,
      id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      risk TEXT NOT NULL DEFAULT 'medium',
      created_at TEXT NOT NULL DEFAULT '',
      completed_at TEXT DEFAULT NULL,
      PRIMARY KEY (milestone_id, id),
      FOREIGN KEY (milestone_id) REFERENCES milestones(id)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
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
      PRIMARY KEY (milestone_id, slice_id, id),
      FOREIGN KEY (milestone_id, slice_id) REFERENCES slices(milestone_id, id)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS verification_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL DEFAULT '',
      slice_id TEXT NOT NULL DEFAULT '',
      milestone_id TEXT NOT NULL DEFAULT '',
      command TEXT NOT NULL DEFAULT '',
      exit_code INTEGER DEFAULT 0,
      verdict TEXT NOT NULL DEFAULT '',
      duration_ms INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (milestone_id, slice_id, task_id) REFERENCES tasks(milestone_id, slice_id, id)
    )
  `);
}
function applyMigrationV6SliceSummaries(db) {
  ensureColumn(db, "slices", "full_summary_md", "ALTER TABLE slices ADD COLUMN full_summary_md TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "slices", "full_uat_md", "ALTER TABLE slices ADD COLUMN full_uat_md TEXT NOT NULL DEFAULT ''");
}
function applyMigrationV7Dependencies(db) {
  ensureColumn(db, "slices", "depends", "ALTER TABLE slices ADD COLUMN depends TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "slices", "demo", "ALTER TABLE slices ADD COLUMN demo TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "milestones", "depends_on", "ALTER TABLE milestones ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]'");
}
function applyMigrationV8PlanningFields(db) {
  ensureColumn(db, "milestones", "vision", "ALTER TABLE milestones ADD COLUMN vision TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "milestones", "success_criteria", "ALTER TABLE milestones ADD COLUMN success_criteria TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "milestones", "key_risks", "ALTER TABLE milestones ADD COLUMN key_risks TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "milestones", "proof_strategy", "ALTER TABLE milestones ADD COLUMN proof_strategy TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "milestones", "verification_contract", "ALTER TABLE milestones ADD COLUMN verification_contract TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "milestones", "verification_integration", "ALTER TABLE milestones ADD COLUMN verification_integration TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "milestones", "verification_operational", "ALTER TABLE milestones ADD COLUMN verification_operational TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "milestones", "verification_uat", "ALTER TABLE milestones ADD COLUMN verification_uat TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "milestones", "definition_of_done", "ALTER TABLE milestones ADD COLUMN definition_of_done TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "milestones", "requirement_coverage", "ALTER TABLE milestones ADD COLUMN requirement_coverage TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "milestones", "boundary_map_markdown", "ALTER TABLE milestones ADD COLUMN boundary_map_markdown TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "slices", "goal", "ALTER TABLE slices ADD COLUMN goal TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "slices", "success_criteria", "ALTER TABLE slices ADD COLUMN success_criteria TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "slices", "proof_level", "ALTER TABLE slices ADD COLUMN proof_level TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "slices", "integration_closure", "ALTER TABLE slices ADD COLUMN integration_closure TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "slices", "observability_impact", "ALTER TABLE slices ADD COLUMN observability_impact TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "tasks", "description", "ALTER TABLE tasks ADD COLUMN description TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "tasks", "estimate", "ALTER TABLE tasks ADD COLUMN estimate TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "tasks", "files", "ALTER TABLE tasks ADD COLUMN files TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "tasks", "verify", "ALTER TABLE tasks ADD COLUMN verify TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "tasks", "inputs", "ALTER TABLE tasks ADD COLUMN inputs TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "tasks", "expected_output", "ALTER TABLE tasks ADD COLUMN expected_output TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "tasks", "observability_impact", "ALTER TABLE tasks ADD COLUMN observability_impact TEXT NOT NULL DEFAULT ''");
  db.exec(`
    CREATE TABLE IF NOT EXISTS replan_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      milestone_id TEXT NOT NULL DEFAULT '',
      slice_id TEXT DEFAULT NULL,
      task_id TEXT DEFAULT NULL,
      summary TEXT NOT NULL DEFAULT '',
      previous_artifact_path TEXT DEFAULT NULL,
      replacement_artifact_path TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (milestone_id) REFERENCES milestones(id)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS assessments (
      path TEXT PRIMARY KEY,
      milestone_id TEXT NOT NULL DEFAULT '',
      slice_id TEXT DEFAULT NULL,
      task_id TEXT DEFAULT NULL,
      status TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL DEFAULT '',
      full_content TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (milestone_id) REFERENCES milestones(id)
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_replan_history_milestone ON replan_history(milestone_id, created_at)");
}
function applyMigrationV9Ordering(db) {
  ensureColumn(db, "slices", "sequence", "ALTER TABLE slices ADD COLUMN sequence INTEGER DEFAULT 0");
  ensureColumn(db, "tasks", "sequence", "ALTER TABLE tasks ADD COLUMN sequence INTEGER DEFAULT 0");
}
function applyMigrationV10ReplanTrigger(db) {
  ensureColumn(db, "slices", "replan_triggered_at", "ALTER TABLE slices ADD COLUMN replan_triggered_at TEXT DEFAULT NULL");
}
function applyMigrationV11TaskPlanning(db) {
  ensureColumn(db, "tasks", "full_plan_md", "ALTER TABLE tasks ADD COLUMN full_plan_md TEXT NOT NULL DEFAULT ''");
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_replan_history_unique
    ON replan_history(milestone_id, slice_id, task_id)
    WHERE slice_id IS NOT NULL AND task_id IS NOT NULL
  `);
}
function applyMigrationV12QualityGates(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS quality_gates (
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
      PRIMARY KEY (milestone_id, slice_id, gate_id, task_id),
      FOREIGN KEY (milestone_id, slice_id) REFERENCES slices(milestone_id, id)
    )
  `);
}
function applyMigrationV13HotPathIndexes(db, ensureVerificationEvidenceDedupIndex) {
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_active ON tasks(milestone_id, slice_id, status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_slices_active ON slices(milestone_id, status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_milestones_status ON milestones(status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_quality_gates_pending ON quality_gates(milestone_id, slice_id, status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_verification_evidence_task ON verification_evidence(milestone_id, slice_id, task_id)");
  ensureVerificationEvidenceDedupIndex(db);
}
function applyMigrationV14SliceDependencies(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS slice_dependencies (
      milestone_id TEXT NOT NULL,
      slice_id TEXT NOT NULL,
      depends_on_slice_id TEXT NOT NULL,
      PRIMARY KEY (milestone_id, slice_id, depends_on_slice_id),
      FOREIGN KEY (milestone_id, slice_id) REFERENCES slices(milestone_id, id),
      FOREIGN KEY (milestone_id, depends_on_slice_id) REFERENCES slices(milestone_id, id)
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_slice_deps_target ON slice_dependencies(milestone_id, depends_on_slice_id)");
}
function applyMigrationV15AuditTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gate_runs (
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
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS turn_git_transactions (
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
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_events (
      event_id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      turn_id TEXT DEFAULT NULL,
      caused_by TEXT DEFAULT NULL,
      category TEXT NOT NULL,
      type TEXT NOT NULL,
      ts TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}'
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_turn_index (
      trace_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      first_ts TEXT NOT NULL,
      last_ts TEXT NOT NULL,
      event_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (trace_id, turn_id)
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_gate_runs_turn ON gate_runs(trace_id, turn_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_gate_runs_lookup ON gate_runs(milestone_id, slice_id, task_id, gate_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_turn_git_tx_turn ON turn_git_transactions(trace_id, turn_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_audit_events_trace ON audit_events(trace_id, ts)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_audit_events_turn ON audit_events(trace_id, turn_id, ts)");
}
function applyMigrationV16EscalationSource(db) {
  ensureColumn(db, "slices", "is_sketch", "ALTER TABLE slices ADD COLUMN is_sketch INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "slices", "sketch_scope", "ALTER TABLE slices ADD COLUMN sketch_scope TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "decisions", "source", "ALTER TABLE decisions ADD COLUMN source TEXT NOT NULL DEFAULT 'discussion'");
}
function applyMigrationV17TaskEscalation(db) {
  ensureColumn(db, "tasks", "blocker_source", "ALTER TABLE tasks ADD COLUMN blocker_source TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "tasks", "escalation_pending", "ALTER TABLE tasks ADD COLUMN escalation_pending INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "tasks", "escalation_awaiting_review", "ALTER TABLE tasks ADD COLUMN escalation_awaiting_review INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "tasks", "escalation_artifact_path", "ALTER TABLE tasks ADD COLUMN escalation_artifact_path TEXT DEFAULT NULL");
  ensureColumn(db, "tasks", "escalation_override_applied_at", "ALTER TABLE tasks ADD COLUMN escalation_override_applied_at TEXT DEFAULT NULL");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_escalation_pending ON tasks(milestone_id, slice_id, escalation_pending)");
}
function applyMigrationV18MemorySources(db) {
  ensureColumn(db, "memories", "scope", "ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'project'");
  ensureColumn(db, "memories", "tags", "ALTER TABLE memories ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_sources (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      uri TEXT,
      title TEXT,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL UNIQUE,
      imported_at TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'project',
      tags TEXT NOT NULL DEFAULT '[]'
    )
  `);
  ensureColumn(db, "memory_sources", "scope", "ALTER TABLE memory_sources ADD COLUMN scope TEXT NOT NULL DEFAULT 'project'");
  ensureColumn(db, "memory_sources", "tags", "ALTER TABLE memory_sources ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
  db.exec("CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_memory_sources_kind ON memory_sources(kind)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_memory_sources_scope ON memory_sources(scope)");
}
function applyMigrationV19MemoryFts(db, hooks) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_embeddings (
      memory_id TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      dim INTEGER NOT NULL,
      vector BLOB NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  hooks.tryCreateMemoriesFts(db);
  if (hooks.isMemoriesFtsAvailable(db)) {
    try {
      hooks.backfillMemoriesFts(db);
    } catch (err) {
      hooks.logWarning("db", `FTS5 backfill failed: ${err.message}`);
    }
  }
}
function applyMigrationV20MemoryRelations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_relations (
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      rel TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.8,
      created_at TEXT NOT NULL,
      PRIMARY KEY (from_id, to_id, rel)
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_memory_relations_from ON memory_relations(from_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_memory_relations_to ON memory_relations(to_id)");
}
function applyMigrationV21StructuredMemories(db) {
  ensureColumn(db, "memories", "structured_fields", "ALTER TABLE memories ADD COLUMN structured_fields TEXT DEFAULT NULL");
}
function applyMigrationV23MilestoneQueue(db) {
  ensureColumn(db, "milestones", "sequence", "ALTER TABLE milestones ADD COLUMN sequence INTEGER DEFAULT 0");
}
function applyMigrationV26MilestoneCommitAttributions(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS milestone_commit_attributions (
      commit_sha TEXT NOT NULL,
      milestone_id TEXT NOT NULL,
      slice_id TEXT DEFAULT NULL,
      task_id TEXT DEFAULT NULL,
      source TEXT NOT NULL DEFAULT 'recorded',
      confidence REAL NOT NULL DEFAULT 1.0,
      files_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (commit_sha, milestone_id)
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_milestone_commit_attr_milestone ON milestone_commit_attributions(milestone_id)");
}
function applyMigrationV27ArtifactHash(db) {
  ensureColumn(db, "artifacts", "content_hash", "ALTER TABLE artifacts ADD COLUMN content_hash TEXT DEFAULT NULL");
}
function applyMigrationV28MemoryLastHitAt(db) {
  ensureColumn(db, "memories", "last_hit_at", "ALTER TABLE memories ADD COLUMN last_hit_at TEXT DEFAULT NULL");
}
function applyMigrationV22QualityGateRepair(db, hooks) {
  const qgInfo = db.prepare("PRAGMA table_info(quality_gates)").all();
  const taskIdCol = qgInfo.find((r) => r["name"] === "task_id");
  const needsRepair = taskIdCol && (taskIdCol["notnull"] === 0 || taskIdCol["notnull"] === "0");
  if (needsRepair) {
    db.exec(`
      CREATE TABLE quality_gates_new (
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
        PRIMARY KEY (milestone_id, slice_id, gate_id, task_id),
        FOREIGN KEY (milestone_id, slice_id) REFERENCES slices(milestone_id, id)
      )
    `);
    hooks.copyQualityGateRowsToRepairedTable(db);
    db.exec("DROP TABLE quality_gates");
    db.exec("ALTER TABLE quality_gates_new RENAME TO quality_gates");
    db.exec("CREATE INDEX IF NOT EXISTS idx_quality_gates_pending ON quality_gates(milestone_id, slice_id, status)");
  }
  ensureColumn(db, "quality_gates", "scope", "ALTER TABLE quality_gates ADD COLUMN scope TEXT NOT NULL DEFAULT 'slice'");
  ensureColumn(db, "assessments", "scope", "ALTER TABLE assessments ADD COLUMN scope TEXT NOT NULL DEFAULT ''");
}
export {
  applyMigrationV10ReplanTrigger,
  applyMigrationV11TaskPlanning,
  applyMigrationV12QualityGates,
  applyMigrationV13HotPathIndexes,
  applyMigrationV14SliceDependencies,
  applyMigrationV15AuditTables,
  applyMigrationV16EscalationSource,
  applyMigrationV17TaskEscalation,
  applyMigrationV18MemorySources,
  applyMigrationV19MemoryFts,
  applyMigrationV20MemoryRelations,
  applyMigrationV21StructuredMemories,
  applyMigrationV22QualityGateRepair,
  applyMigrationV23MilestoneQueue,
  applyMigrationV26MilestoneCommitAttributions,
  applyMigrationV27ArtifactHash,
  applyMigrationV28MemoryLastHitAt,
  applyMigrationV2Artifacts,
  applyMigrationV3Memories,
  applyMigrationV4DecisionMadeBy,
  applyMigrationV5HierarchyTables,
  applyMigrationV6SliceSummaries,
  applyMigrationV7Dependencies,
  applyMigrationV8PlanningFields,
  applyMigrationV9Ordering
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9kYi1taWdyYXRpb24tc3RlcHMudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFByb2plY3QvQXBwOiBHU0QtMlxuLy8gRmlsZSBQdXJwb3NlOiBTY2hlbWEgbWlncmF0aW9uIERETCBzdGVwcyBmb3IgdGhlIEdTRCBkYXRhYmFzZSBmYWNhZGUuXG5cbmltcG9ydCB0eXBlIHsgRGJBZGFwdGVyIH0gZnJvbSBcIi4vZGItYWRhcHRlci5qc1wiO1xuaW1wb3J0IHsgZW5zdXJlQ29sdW1uIH0gZnJvbSBcIi4vZGItc2NoZW1hLW1ldGFkYXRhLmpzXCI7XG5cbmV4cG9ydCBmdW5jdGlvbiBhcHBseU1pZ3JhdGlvblYyQXJ0aWZhY3RzKGRiOiBEYkFkYXB0ZXIpOiB2b2lkIHtcbiAgZGIuZXhlYyhgXG4gICAgQ1JFQVRFIFRBQkxFIElGIE5PVCBFWElTVFMgYXJ0aWZhY3RzIChcbiAgICAgIHBhdGggVEVYVCBQUklNQVJZIEtFWSxcbiAgICAgIGFydGlmYWN0X3R5cGUgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgbWlsZXN0b25lX2lkIFRFWFQgREVGQVVMVCBOVUxMLFxuICAgICAgc2xpY2VfaWQgVEVYVCBERUZBVUxUIE5VTEwsXG4gICAgICB0YXNrX2lkIFRFWFQgREVGQVVMVCBOVUxMLFxuICAgICAgZnVsbF9jb250ZW50IFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgIGltcG9ydGVkX2F0IFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJ1xuICAgIClcbiAgYCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhcHBseU1pZ3JhdGlvblYzTWVtb3JpZXMoZGI6IERiQWRhcHRlcik6IHZvaWQge1xuICBkYi5leGVjKGBcbiAgICBDUkVBVEUgVEFCTEUgSUYgTk9UIEVYSVNUUyBtZW1vcmllcyAoXG4gICAgICBzZXEgSU5URUdFUiBQUklNQVJZIEtFWSBBVVRPSU5DUkVNRU5ULFxuICAgICAgaWQgVEVYVCBOT1QgTlVMTCBVTklRVUUsXG4gICAgICBjYXRlZ29yeSBURVhUIE5PVCBOVUxMLFxuICAgICAgY29udGVudCBURVhUIE5PVCBOVUxMLFxuICAgICAgY29uZmlkZW5jZSBSRUFMIE5PVCBOVUxMIERFRkFVTFQgMC44LFxuICAgICAgc291cmNlX3VuaXRfdHlwZSBURVhULFxuICAgICAgc291cmNlX3VuaXRfaWQgVEVYVCxcbiAgICAgIGNyZWF0ZWRfYXQgVEVYVCBOT1QgTlVMTCxcbiAgICAgIHVwZGF0ZWRfYXQgVEVYVCBOT1QgTlVMTCxcbiAgICAgIHN1cGVyc2VkZWRfYnkgVEVYVCBERUZBVUxUIE5VTEwsXG4gICAgICBoaXRfY291bnQgSU5URUdFUiBOT1QgTlVMTCBERUZBVUxUIDBcbiAgICApXG4gIGApO1xuICBkYi5leGVjKGBcbiAgICBDUkVBVEUgVEFCTEUgSUYgTk9UIEVYSVNUUyBtZW1vcnlfcHJvY2Vzc2VkX3VuaXRzIChcbiAgICAgIHVuaXRfa2V5IFRFWFQgUFJJTUFSWSBLRVksXG4gICAgICBhY3Rpdml0eV9maWxlIFRFWFQsXG4gICAgICBwcm9jZXNzZWRfYXQgVEVYVCBOT1QgTlVMTFxuICAgIClcbiAgYCk7XG4gIGRiLmV4ZWMoXCJDUkVBVEUgSU5ERVggSUYgTk9UIEVYSVNUUyBpZHhfbWVtb3JpZXNfYWN0aXZlIE9OIG1lbW9yaWVzKHN1cGVyc2VkZWRfYnkpXCIpO1xuICBkYi5leGVjKFwiRFJPUCBWSUVXIElGIEVYSVNUUyBhY3RpdmVfbWVtb3JpZXNcIik7XG4gIGRiLmV4ZWMoXCJDUkVBVEUgVklFVyBhY3RpdmVfbWVtb3JpZXMgQVMgU0VMRUNUICogRlJPTSBtZW1vcmllcyBXSEVSRSBzdXBlcnNlZGVkX2J5IElTIE5VTExcIik7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhcHBseU1pZ3JhdGlvblY0RGVjaXNpb25NYWRlQnkoZGI6IERiQWRhcHRlcik6IHZvaWQge1xuICBlbnN1cmVDb2x1bW4oZGIsIFwiZGVjaXNpb25zXCIsIFwibWFkZV9ieVwiLCBcIkFMVEVSIFRBQkxFIGRlY2lzaW9ucyBBREQgQ09MVU1OIG1hZGVfYnkgVEVYVCBOT1QgTlVMTCBERUZBVUxUICdhZ2VudCdcIik7XG4gIGRiLmV4ZWMoXCJEUk9QIFZJRVcgSUYgRVhJU1RTIGFjdGl2ZV9kZWNpc2lvbnNcIik7XG4gIGRiLmV4ZWMoXCJDUkVBVEUgVklFVyBhY3RpdmVfZGVjaXNpb25zIEFTIFNFTEVDVCAqIEZST00gZGVjaXNpb25zIFdIRVJFIHN1cGVyc2VkZWRfYnkgSVMgTlVMTFwiKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFwcGx5TWlncmF0aW9uVjVIaWVyYXJjaHlUYWJsZXMoZGI6IERiQWRhcHRlcik6IHZvaWQge1xuICBkYi5leGVjKGBcbiAgICBDUkVBVEUgVEFCTEUgSUYgTk9UIEVYSVNUUyBtaWxlc3RvbmVzIChcbiAgICAgIGlkIFRFWFQgUFJJTUFSWSBLRVksXG4gICAgICB0aXRsZSBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICBzdGF0dXMgVEVYVCBOT1QgTlVMTCBERUZBVUxUICdhY3RpdmUnLFxuICAgICAgY3JlYXRlZF9hdCBURVhUIE5PVCBOVUxMLFxuICAgICAgY29tcGxldGVkX2F0IFRFWFQgREVGQVVMVCBOVUxMXG4gICAgKVxuICBgKTtcbiAgZGIuZXhlYyhgXG4gICAgQ1JFQVRFIFRBQkxFIElGIE5PVCBFWElTVFMgc2xpY2VzIChcbiAgICAgIG1pbGVzdG9uZV9pZCBURVhUIE5PVCBOVUxMLFxuICAgICAgaWQgVEVYVCBOT1QgTlVMTCxcbiAgICAgIHRpdGxlIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgIHN0YXR1cyBURVhUIE5PVCBOVUxMIERFRkFVTFQgJ3BlbmRpbmcnLFxuICAgICAgcmlzayBURVhUIE5PVCBOVUxMIERFRkFVTFQgJ21lZGl1bScsXG4gICAgICBjcmVhdGVkX2F0IFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgIGNvbXBsZXRlZF9hdCBURVhUIERFRkFVTFQgTlVMTCxcbiAgICAgIFBSSU1BUlkgS0VZIChtaWxlc3RvbmVfaWQsIGlkKSxcbiAgICAgIEZPUkVJR04gS0VZIChtaWxlc3RvbmVfaWQpIFJFRkVSRU5DRVMgbWlsZXN0b25lcyhpZClcbiAgICApXG4gIGApO1xuICBkYi5leGVjKGBcbiAgICBDUkVBVEUgVEFCTEUgSUYgTk9UIEVYSVNUUyB0YXNrcyAoXG4gICAgICBtaWxlc3RvbmVfaWQgVEVYVCBOT1QgTlVMTCxcbiAgICAgIHNsaWNlX2lkIFRFWFQgTk9UIE5VTEwsXG4gICAgICBpZCBURVhUIE5PVCBOVUxMLFxuICAgICAgdGl0bGUgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgc3RhdHVzIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAncGVuZGluZycsXG4gICAgICBvbmVfbGluZXIgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgbmFycmF0aXZlIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgIHZlcmlmaWNhdGlvbl9yZXN1bHQgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgZHVyYXRpb24gVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgY29tcGxldGVkX2F0IFRFWFQgREVGQVVMVCBOVUxMLFxuICAgICAgYmxvY2tlcl9kaXNjb3ZlcmVkIElOVEVHRVIgREVGQVVMVCAwLFxuICAgICAgZGV2aWF0aW9ucyBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICBrbm93bl9pc3N1ZXMgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAga2V5X2ZpbGVzIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnW10nLFxuICAgICAga2V5X2RlY2lzaW9ucyBURVhUIE5PVCBOVUxMIERFRkFVTFQgJ1tdJyxcbiAgICAgIGZ1bGxfc3VtbWFyeV9tZCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICBQUklNQVJZIEtFWSAobWlsZXN0b25lX2lkLCBzbGljZV9pZCwgaWQpLFxuICAgICAgRk9SRUlHTiBLRVkgKG1pbGVzdG9uZV9pZCwgc2xpY2VfaWQpIFJFRkVSRU5DRVMgc2xpY2VzKG1pbGVzdG9uZV9pZCwgaWQpXG4gICAgKVxuICBgKTtcbiAgZGIuZXhlYyhgXG4gICAgQ1JFQVRFIFRBQkxFIElGIE5PVCBFWElTVFMgdmVyaWZpY2F0aW9uX2V2aWRlbmNlIChcbiAgICAgIGlkIElOVEVHRVIgUFJJTUFSWSBLRVkgQVVUT0lOQ1JFTUVOVCxcbiAgICAgIHRhc2tfaWQgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgc2xpY2VfaWQgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgbWlsZXN0b25lX2lkIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgIGNvbW1hbmQgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgZXhpdF9jb2RlIElOVEVHRVIgREVGQVVMVCAwLFxuICAgICAgdmVyZGljdCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICBkdXJhdGlvbl9tcyBJTlRFR0VSIERFRkFVTFQgMCxcbiAgICAgIGNyZWF0ZWRfYXQgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgRk9SRUlHTiBLRVkgKG1pbGVzdG9uZV9pZCwgc2xpY2VfaWQsIHRhc2tfaWQpIFJFRkVSRU5DRVMgdGFza3MobWlsZXN0b25lX2lkLCBzbGljZV9pZCwgaWQpXG4gICAgKVxuICBgKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFwcGx5TWlncmF0aW9uVjZTbGljZVN1bW1hcmllcyhkYjogRGJBZGFwdGVyKTogdm9pZCB7XG4gIGVuc3VyZUNvbHVtbihkYiwgXCJzbGljZXNcIiwgXCJmdWxsX3N1bW1hcnlfbWRcIiwgXCJBTFRFUiBUQUJMRSBzbGljZXMgQUREIENPTFVNTiBmdWxsX3N1bW1hcnlfbWQgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnXCIpO1xuICBlbnN1cmVDb2x1bW4oZGIsIFwic2xpY2VzXCIsIFwiZnVsbF91YXRfbWRcIiwgXCJBTFRFUiBUQUJMRSBzbGljZXMgQUREIENPTFVNTiBmdWxsX3VhdF9tZCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJydcIik7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhcHBseU1pZ3JhdGlvblY3RGVwZW5kZW5jaWVzKGRiOiBEYkFkYXB0ZXIpOiB2b2lkIHtcbiAgZW5zdXJlQ29sdW1uKGRiLCBcInNsaWNlc1wiLCBcImRlcGVuZHNcIiwgXCJBTFRFUiBUQUJMRSBzbGljZXMgQUREIENPTFVNTiBkZXBlbmRzIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnW10nXCIpO1xuICBlbnN1cmVDb2x1bW4oZGIsIFwic2xpY2VzXCIsIFwiZGVtb1wiLCBcIkFMVEVSIFRBQkxFIHNsaWNlcyBBREQgQ09MVU1OIGRlbW8gVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnXCIpO1xuICBlbnN1cmVDb2x1bW4oZGIsIFwibWlsZXN0b25lc1wiLCBcImRlcGVuZHNfb25cIiwgXCJBTFRFUiBUQUJMRSBtaWxlc3RvbmVzIEFERCBDT0xVTU4gZGVwZW5kc19vbiBURVhUIE5PVCBOVUxMIERFRkFVTFQgJ1tdJ1wiKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFwcGx5TWlncmF0aW9uVjhQbGFubmluZ0ZpZWxkcyhkYjogRGJBZGFwdGVyKTogdm9pZCB7XG4gIGVuc3VyZUNvbHVtbihkYiwgXCJtaWxlc3RvbmVzXCIsIFwidmlzaW9uXCIsIFwiQUxURVIgVEFCTEUgbWlsZXN0b25lcyBBREQgQ09MVU1OIHZpc2lvbiBURVhUIE5PVCBOVUxMIERFRkFVTFQgJydcIik7XG4gIGVuc3VyZUNvbHVtbihkYiwgXCJtaWxlc3RvbmVzXCIsIFwic3VjY2Vzc19jcml0ZXJpYVwiLCBcIkFMVEVSIFRBQkxFIG1pbGVzdG9uZXMgQUREIENPTFVNTiBzdWNjZXNzX2NyaXRlcmlhIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnW10nXCIpO1xuICBlbnN1cmVDb2x1bW4oZGIsIFwibWlsZXN0b25lc1wiLCBcImtleV9yaXNrc1wiLCBcIkFMVEVSIFRBQkxFIG1pbGVzdG9uZXMgQUREIENPTFVNTiBrZXlfcmlza3MgVEVYVCBOT1QgTlVMTCBERUZBVUxUICdbXSdcIik7XG4gIGVuc3VyZUNvbHVtbihkYiwgXCJtaWxlc3RvbmVzXCIsIFwicHJvb2Zfc3RyYXRlZ3lcIiwgXCJBTFRFUiBUQUJMRSBtaWxlc3RvbmVzIEFERCBDT0xVTU4gcHJvb2Zfc3RyYXRlZ3kgVEVYVCBOT1QgTlVMTCBERUZBVUxUICdbXSdcIik7XG4gIGVuc3VyZUNvbHVtbihkYiwgXCJtaWxlc3RvbmVzXCIsIFwidmVyaWZpY2F0aW9uX2NvbnRyYWN0XCIsIFwiQUxURVIgVEFCTEUgbWlsZXN0b25lcyBBREQgQ09MVU1OIHZlcmlmaWNhdGlvbl9jb250cmFjdCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJydcIik7XG4gIGVuc3VyZUNvbHVtbihkYiwgXCJtaWxlc3RvbmVzXCIsIFwidmVyaWZpY2F0aW9uX2ludGVncmF0aW9uXCIsIFwiQUxURVIgVEFCTEUgbWlsZXN0b25lcyBBREQgQ09MVU1OIHZlcmlmaWNhdGlvbl9pbnRlZ3JhdGlvbiBURVhUIE5PVCBOVUxMIERFRkFVTFQgJydcIik7XG4gIGVuc3VyZUNvbHVtbihkYiwgXCJtaWxlc3RvbmVzXCIsIFwidmVyaWZpY2F0aW9uX29wZXJhdGlvbmFsXCIsIFwiQUxURVIgVEFCTEUgbWlsZXN0b25lcyBBREQgQ09MVU1OIHZlcmlmaWNhdGlvbl9vcGVyYXRpb25hbCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJydcIik7XG4gIGVuc3VyZUNvbHVtbihkYiwgXCJtaWxlc3RvbmVzXCIsIFwidmVyaWZpY2F0aW9uX3VhdFwiLCBcIkFMVEVSIFRBQkxFIG1pbGVzdG9uZXMgQUREIENPTFVNTiB2ZXJpZmljYXRpb25fdWF0IFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJ1wiKTtcbiAgZW5zdXJlQ29sdW1uKGRiLCBcIm1pbGVzdG9uZXNcIiwgXCJkZWZpbml0aW9uX29mX2RvbmVcIiwgXCJBTFRFUiBUQUJMRSBtaWxlc3RvbmVzIEFERCBDT0xVTU4gZGVmaW5pdGlvbl9vZl9kb25lIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnW10nXCIpO1xuICBlbnN1cmVDb2x1bW4oZGIsIFwibWlsZXN0b25lc1wiLCBcInJlcXVpcmVtZW50X2NvdmVyYWdlXCIsIFwiQUxURVIgVEFCTEUgbWlsZXN0b25lcyBBREQgQ09MVU1OIHJlcXVpcmVtZW50X2NvdmVyYWdlIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJ1wiKTtcbiAgZW5zdXJlQ29sdW1uKGRiLCBcIm1pbGVzdG9uZXNcIiwgXCJib3VuZGFyeV9tYXBfbWFya2Rvd25cIiwgXCJBTFRFUiBUQUJMRSBtaWxlc3RvbmVzIEFERCBDT0xVTU4gYm91bmRhcnlfbWFwX21hcmtkb3duIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJ1wiKTtcblxuICBlbnN1cmVDb2x1bW4oZGIsIFwic2xpY2VzXCIsIFwiZ29hbFwiLCBcIkFMVEVSIFRBQkxFIHNsaWNlcyBBREQgQ09MVU1OIGdvYWwgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnXCIpO1xuICBlbnN1cmVDb2x1bW4oZGIsIFwic2xpY2VzXCIsIFwic3VjY2Vzc19jcml0ZXJpYVwiLCBcIkFMVEVSIFRBQkxFIHNsaWNlcyBBREQgQ09MVU1OIHN1Y2Nlc3NfY3JpdGVyaWEgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnXCIpO1xuICBlbnN1cmVDb2x1bW4oZGIsIFwic2xpY2VzXCIsIFwicHJvb2ZfbGV2ZWxcIiwgXCJBTFRFUiBUQUJMRSBzbGljZXMgQUREIENPTFVNTiBwcm9vZl9sZXZlbCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJydcIik7XG4gIGVuc3VyZUNvbHVtbihkYiwgXCJzbGljZXNcIiwgXCJpbnRlZ3JhdGlvbl9jbG9zdXJlXCIsIFwiQUxURVIgVEFCTEUgc2xpY2VzIEFERCBDT0xVTU4gaW50ZWdyYXRpb25fY2xvc3VyZSBURVhUIE5PVCBOVUxMIERFRkFVTFQgJydcIik7XG4gIGVuc3VyZUNvbHVtbihkYiwgXCJzbGljZXNcIiwgXCJvYnNlcnZhYmlsaXR5X2ltcGFjdFwiLCBcIkFMVEVSIFRBQkxFIHNsaWNlcyBBREQgQ09MVU1OIG9ic2VydmFiaWxpdHlfaW1wYWN0IFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJ1wiKTtcblxuICBlbnN1cmVDb2x1bW4oZGIsIFwidGFza3NcIiwgXCJkZXNjcmlwdGlvblwiLCBcIkFMVEVSIFRBQkxFIHRhc2tzIEFERCBDT0xVTU4gZGVzY3JpcHRpb24gVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnXCIpO1xuICBlbnN1cmVDb2x1bW4oZGIsIFwidGFza3NcIiwgXCJlc3RpbWF0ZVwiLCBcIkFMVEVSIFRBQkxFIHRhc2tzIEFERCBDT0xVTU4gZXN0aW1hdGUgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnXCIpO1xuICBlbnN1cmVDb2x1bW4oZGIsIFwidGFza3NcIiwgXCJmaWxlc1wiLCBcIkFMVEVSIFRBQkxFIHRhc2tzIEFERCBDT0xVTU4gZmlsZXMgVEVYVCBOT1QgTlVMTCBERUZBVUxUICdbXSdcIik7XG4gIGVuc3VyZUNvbHVtbihkYiwgXCJ0YXNrc1wiLCBcInZlcmlmeVwiLCBcIkFMVEVSIFRBQkxFIHRhc2tzIEFERCBDT0xVTU4gdmVyaWZ5IFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJ1wiKTtcbiAgZW5zdXJlQ29sdW1uKGRiLCBcInRhc2tzXCIsIFwiaW5wdXRzXCIsIFwiQUxURVIgVEFCTEUgdGFza3MgQUREIENPTFVNTiBpbnB1dHMgVEVYVCBOT1QgTlVMTCBERUZBVUxUICdbXSdcIik7XG4gIGVuc3VyZUNvbHVtbihkYiwgXCJ0YXNrc1wiLCBcImV4cGVjdGVkX291dHB1dFwiLCBcIkFMVEVSIFRBQkxFIHRhc2tzIEFERCBDT0xVTU4gZXhwZWN0ZWRfb3V0cHV0IFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnW10nXCIpO1xuICBlbnN1cmVDb2x1bW4oZGIsIFwidGFza3NcIiwgXCJvYnNlcnZhYmlsaXR5X2ltcGFjdFwiLCBcIkFMVEVSIFRBQkxFIHRhc2tzIEFERCBDT0xVTU4gb2JzZXJ2YWJpbGl0eV9pbXBhY3QgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnXCIpO1xuXG4gIGRiLmV4ZWMoYFxuICAgIENSRUFURSBUQUJMRSBJRiBOT1QgRVhJU1RTIHJlcGxhbl9oaXN0b3J5IChcbiAgICAgIGlkIElOVEVHRVIgUFJJTUFSWSBLRVkgQVVUT0lOQ1JFTUVOVCxcbiAgICAgIG1pbGVzdG9uZV9pZCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICBzbGljZV9pZCBURVhUIERFRkFVTFQgTlVMTCxcbiAgICAgIHRhc2tfaWQgVEVYVCBERUZBVUxUIE5VTEwsXG4gICAgICBzdW1tYXJ5IFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgIHByZXZpb3VzX2FydGlmYWN0X3BhdGggVEVYVCBERUZBVUxUIE5VTEwsXG4gICAgICByZXBsYWNlbWVudF9hcnRpZmFjdF9wYXRoIFRFWFQgREVGQVVMVCBOVUxMLFxuICAgICAgY3JlYXRlZF9hdCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICBGT1JFSUdOIEtFWSAobWlsZXN0b25lX2lkKSBSRUZFUkVOQ0VTIG1pbGVzdG9uZXMoaWQpXG4gICAgKVxuICBgKTtcbiAgZGIuZXhlYyhgXG4gICAgQ1JFQVRFIFRBQkxFIElGIE5PVCBFWElTVFMgYXNzZXNzbWVudHMgKFxuICAgICAgcGF0aCBURVhUIFBSSU1BUlkgS0VZLFxuICAgICAgbWlsZXN0b25lX2lkIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgIHNsaWNlX2lkIFRFWFQgREVGQVVMVCBOVUxMLFxuICAgICAgdGFza19pZCBURVhUIERFRkFVTFQgTlVMTCxcbiAgICAgIHN0YXR1cyBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICBzY29wZSBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICBmdWxsX2NvbnRlbnQgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgY3JlYXRlZF9hdCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICBGT1JFSUdOIEtFWSAobWlsZXN0b25lX2lkKSBSRUZFUkVOQ0VTIG1pbGVzdG9uZXMoaWQpXG4gICAgKVxuICBgKTtcbiAgZGIuZXhlYyhcIkNSRUFURSBJTkRFWCBJRiBOT1QgRVhJU1RTIGlkeF9yZXBsYW5faGlzdG9yeV9taWxlc3RvbmUgT04gcmVwbGFuX2hpc3RvcnkobWlsZXN0b25lX2lkLCBjcmVhdGVkX2F0KVwiKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFwcGx5TWlncmF0aW9uVjlPcmRlcmluZyhkYjogRGJBZGFwdGVyKTogdm9pZCB7XG4gIGVuc3VyZUNvbHVtbihkYiwgXCJzbGljZXNcIiwgXCJzZXF1ZW5jZVwiLCBcIkFMVEVSIFRBQkxFIHNsaWNlcyBBREQgQ09MVU1OIHNlcXVlbmNlIElOVEVHRVIgREVGQVVMVCAwXCIpO1xuICBlbnN1cmVDb2x1bW4oZGIsIFwidGFza3NcIiwgXCJzZXF1ZW5jZVwiLCBcIkFMVEVSIFRBQkxFIHRhc2tzIEFERCBDT0xVTU4gc2VxdWVuY2UgSU5URUdFUiBERUZBVUxUIDBcIik7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhcHBseU1pZ3JhdGlvblYxMFJlcGxhblRyaWdnZXIoZGI6IERiQWRhcHRlcik6IHZvaWQge1xuICBlbnN1cmVDb2x1bW4oZGIsIFwic2xpY2VzXCIsIFwicmVwbGFuX3RyaWdnZXJlZF9hdFwiLCBcIkFMVEVSIFRBQkxFIHNsaWNlcyBBREQgQ09MVU1OIHJlcGxhbl90cmlnZ2VyZWRfYXQgVEVYVCBERUZBVUxUIE5VTExcIik7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhcHBseU1pZ3JhdGlvblYxMVRhc2tQbGFubmluZyhkYjogRGJBZGFwdGVyKTogdm9pZCB7XG4gIGVuc3VyZUNvbHVtbihkYiwgXCJ0YXNrc1wiLCBcImZ1bGxfcGxhbl9tZFwiLCBcIkFMVEVSIFRBQkxFIHRhc2tzIEFERCBDT0xVTU4gZnVsbF9wbGFuX21kIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJ1wiKTtcbiAgZGIuZXhlYyhgXG4gICAgQ1JFQVRFIFVOSVFVRSBJTkRFWCBJRiBOT1QgRVhJU1RTIGlkeF9yZXBsYW5faGlzdG9yeV91bmlxdWVcbiAgICBPTiByZXBsYW5faGlzdG9yeShtaWxlc3RvbmVfaWQsIHNsaWNlX2lkLCB0YXNrX2lkKVxuICAgIFdIRVJFIHNsaWNlX2lkIElTIE5PVCBOVUxMIEFORCB0YXNrX2lkIElTIE5PVCBOVUxMXG4gIGApO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYXBwbHlNaWdyYXRpb25WMTJRdWFsaXR5R2F0ZXMoZGI6IERiQWRhcHRlcik6IHZvaWQge1xuICBkYi5leGVjKGBcbiAgICBDUkVBVEUgVEFCTEUgSUYgTk9UIEVYSVNUUyBxdWFsaXR5X2dhdGVzIChcbiAgICAgIG1pbGVzdG9uZV9pZCBURVhUIE5PVCBOVUxMLFxuICAgICAgc2xpY2VfaWQgVEVYVCBOT1QgTlVMTCxcbiAgICAgIGdhdGVfaWQgVEVYVCBOT1QgTlVMTCxcbiAgICAgIHNjb3BlIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnc2xpY2UnLFxuICAgICAgdGFza19pZCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICBzdGF0dXMgVEVYVCBOT1QgTlVMTCBERUZBVUxUICdwZW5kaW5nJyxcbiAgICAgIHZlcmRpY3QgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgcmF0aW9uYWxlIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgIGZpbmRpbmdzIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgIGV2YWx1YXRlZF9hdCBURVhUIERFRkFVTFQgTlVMTCxcbiAgICAgIFBSSU1BUlkgS0VZIChtaWxlc3RvbmVfaWQsIHNsaWNlX2lkLCBnYXRlX2lkLCB0YXNrX2lkKSxcbiAgICAgIEZPUkVJR04gS0VZIChtaWxlc3RvbmVfaWQsIHNsaWNlX2lkKSBSRUZFUkVOQ0VTIHNsaWNlcyhtaWxlc3RvbmVfaWQsIGlkKVxuICAgIClcbiAgYCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhcHBseU1pZ3JhdGlvblYxM0hvdFBhdGhJbmRleGVzKFxuICBkYjogRGJBZGFwdGVyLFxuICBlbnN1cmVWZXJpZmljYXRpb25FdmlkZW5jZURlZHVwSW5kZXg6IChkYjogRGJBZGFwdGVyKSA9PiB2b2lkLFxuKTogdm9pZCB7XG4gIGRiLmV4ZWMoXCJDUkVBVEUgSU5ERVggSUYgTk9UIEVYSVNUUyBpZHhfdGFza3NfYWN0aXZlIE9OIHRhc2tzKG1pbGVzdG9uZV9pZCwgc2xpY2VfaWQsIHN0YXR1cylcIik7XG4gIGRiLmV4ZWMoXCJDUkVBVEUgSU5ERVggSUYgTk9UIEVYSVNUUyBpZHhfc2xpY2VzX2FjdGl2ZSBPTiBzbGljZXMobWlsZXN0b25lX2lkLCBzdGF0dXMpXCIpO1xuICBkYi5leGVjKFwiQ1JFQVRFIElOREVYIElGIE5PVCBFWElTVFMgaWR4X21pbGVzdG9uZXNfc3RhdHVzIE9OIG1pbGVzdG9uZXMoc3RhdHVzKVwiKTtcbiAgZGIuZXhlYyhcIkNSRUFURSBJTkRFWCBJRiBOT1QgRVhJU1RTIGlkeF9xdWFsaXR5X2dhdGVzX3BlbmRpbmcgT04gcXVhbGl0eV9nYXRlcyhtaWxlc3RvbmVfaWQsIHNsaWNlX2lkLCBzdGF0dXMpXCIpO1xuICBkYi5leGVjKFwiQ1JFQVRFIElOREVYIElGIE5PVCBFWElTVFMgaWR4X3ZlcmlmaWNhdGlvbl9ldmlkZW5jZV90YXNrIE9OIHZlcmlmaWNhdGlvbl9ldmlkZW5jZShtaWxlc3RvbmVfaWQsIHNsaWNlX2lkLCB0YXNrX2lkKVwiKTtcbiAgZW5zdXJlVmVyaWZpY2F0aW9uRXZpZGVuY2VEZWR1cEluZGV4KGRiKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFwcGx5TWlncmF0aW9uVjE0U2xpY2VEZXBlbmRlbmNpZXMoZGI6IERiQWRhcHRlcik6IHZvaWQge1xuICBkYi5leGVjKGBcbiAgICBDUkVBVEUgVEFCTEUgSUYgTk9UIEVYSVNUUyBzbGljZV9kZXBlbmRlbmNpZXMgKFxuICAgICAgbWlsZXN0b25lX2lkIFRFWFQgTk9UIE5VTEwsXG4gICAgICBzbGljZV9pZCBURVhUIE5PVCBOVUxMLFxuICAgICAgZGVwZW5kc19vbl9zbGljZV9pZCBURVhUIE5PVCBOVUxMLFxuICAgICAgUFJJTUFSWSBLRVkgKG1pbGVzdG9uZV9pZCwgc2xpY2VfaWQsIGRlcGVuZHNfb25fc2xpY2VfaWQpLFxuICAgICAgRk9SRUlHTiBLRVkgKG1pbGVzdG9uZV9pZCwgc2xpY2VfaWQpIFJFRkVSRU5DRVMgc2xpY2VzKG1pbGVzdG9uZV9pZCwgaWQpLFxuICAgICAgRk9SRUlHTiBLRVkgKG1pbGVzdG9uZV9pZCwgZGVwZW5kc19vbl9zbGljZV9pZCkgUkVGRVJFTkNFUyBzbGljZXMobWlsZXN0b25lX2lkLCBpZClcbiAgICApXG4gIGApO1xuICBkYi5leGVjKFwiQ1JFQVRFIElOREVYIElGIE5PVCBFWElTVFMgaWR4X3NsaWNlX2RlcHNfdGFyZ2V0IE9OIHNsaWNlX2RlcGVuZGVuY2llcyhtaWxlc3RvbmVfaWQsIGRlcGVuZHNfb25fc2xpY2VfaWQpXCIpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYXBwbHlNaWdyYXRpb25WMTVBdWRpdFRhYmxlcyhkYjogRGJBZGFwdGVyKTogdm9pZCB7XG4gIGRiLmV4ZWMoYFxuICAgIENSRUFURSBUQUJMRSBJRiBOT1QgRVhJU1RTIGdhdGVfcnVucyAoXG4gICAgICBpZCBJTlRFR0VSIFBSSU1BUlkgS0VZIEFVVE9JTkNSRU1FTlQsXG4gICAgICB0cmFjZV9pZCBURVhUIE5PVCBOVUxMLFxuICAgICAgdHVybl9pZCBURVhUIE5PVCBOVUxMLFxuICAgICAgZ2F0ZV9pZCBURVhUIE5PVCBOVUxMLFxuICAgICAgZ2F0ZV90eXBlIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgIHVuaXRfdHlwZSBURVhUIERFRkFVTFQgTlVMTCxcbiAgICAgIHVuaXRfaWQgVEVYVCBERUZBVUxUIE5VTEwsXG4gICAgICBtaWxlc3RvbmVfaWQgVEVYVCBERUZBVUxUIE5VTEwsXG4gICAgICBzbGljZV9pZCBURVhUIERFRkFVTFQgTlVMTCxcbiAgICAgIHRhc2tfaWQgVEVYVCBERUZBVUxUIE5VTEwsXG4gICAgICBvdXRjb21lIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAncGFzcycsXG4gICAgICBmYWlsdXJlX2NsYXNzIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnbm9uZScsXG4gICAgICByYXRpb25hbGUgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgZmluZGluZ3MgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgYXR0ZW1wdCBJTlRFR0VSIE5PVCBOVUxMIERFRkFVTFQgMSxcbiAgICAgIG1heF9hdHRlbXB0cyBJTlRFR0VSIE5PVCBOVUxMIERFRkFVTFQgMSxcbiAgICAgIHJldHJ5YWJsZSBJTlRFR0VSIE5PVCBOVUxMIERFRkFVTFQgMCxcbiAgICAgIGV2YWx1YXRlZF9hdCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJydcbiAgICApXG4gIGApO1xuICBkYi5leGVjKGBcbiAgICBDUkVBVEUgVEFCTEUgSUYgTk9UIEVYSVNUUyB0dXJuX2dpdF90cmFuc2FjdGlvbnMgKFxuICAgICAgdHJhY2VfaWQgVEVYVCBOT1QgTlVMTCxcbiAgICAgIHR1cm5faWQgVEVYVCBOT1QgTlVMTCxcbiAgICAgIHVuaXRfdHlwZSBURVhUIERFRkFVTFQgTlVMTCxcbiAgICAgIHVuaXRfaWQgVEVYVCBERUZBVUxUIE5VTEwsXG4gICAgICBzdGFnZSBURVhUIE5PVCBOVUxMIERFRkFVTFQgJ3R1cm4tc3RhcnQnLFxuICAgICAgYWN0aW9uIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnc3RhdHVzLW9ubHknLFxuICAgICAgcHVzaCBJTlRFR0VSIE5PVCBOVUxMIERFRkFVTFQgMCxcbiAgICAgIHN0YXR1cyBURVhUIE5PVCBOVUxMIERFRkFVTFQgJ29rJyxcbiAgICAgIGVycm9yIFRFWFQgREVGQVVMVCBOVUxMLFxuICAgICAgbWV0YWRhdGFfanNvbiBURVhUIE5PVCBOVUxMIERFRkFVTFQgJ3t9JyxcbiAgICAgIHVwZGF0ZWRfYXQgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgUFJJTUFSWSBLRVkgKHRyYWNlX2lkLCB0dXJuX2lkLCBzdGFnZSlcbiAgICApXG4gIGApO1xuICBkYi5leGVjKGBcbiAgICBDUkVBVEUgVEFCTEUgSUYgTk9UIEVYSVNUUyBhdWRpdF9ldmVudHMgKFxuICAgICAgZXZlbnRfaWQgVEVYVCBQUklNQVJZIEtFWSxcbiAgICAgIHRyYWNlX2lkIFRFWFQgTk9UIE5VTEwsXG4gICAgICB0dXJuX2lkIFRFWFQgREVGQVVMVCBOVUxMLFxuICAgICAgY2F1c2VkX2J5IFRFWFQgREVGQVVMVCBOVUxMLFxuICAgICAgY2F0ZWdvcnkgVEVYVCBOT1QgTlVMTCxcbiAgICAgIHR5cGUgVEVYVCBOT1QgTlVMTCxcbiAgICAgIHRzIFRFWFQgTk9UIE5VTEwsXG4gICAgICBwYXlsb2FkX2pzb24gVEVYVCBOT1QgTlVMTCBERUZBVUxUICd7fSdcbiAgICApXG4gIGApO1xuICBkYi5leGVjKGBcbiAgICBDUkVBVEUgVEFCTEUgSUYgTk9UIEVYSVNUUyBhdWRpdF90dXJuX2luZGV4IChcbiAgICAgIHRyYWNlX2lkIFRFWFQgTk9UIE5VTEwsXG4gICAgICB0dXJuX2lkIFRFWFQgTk9UIE5VTEwsXG4gICAgICBmaXJzdF90cyBURVhUIE5PVCBOVUxMLFxuICAgICAgbGFzdF90cyBURVhUIE5PVCBOVUxMLFxuICAgICAgZXZlbnRfY291bnQgSU5URUdFUiBOT1QgTlVMTCBERUZBVUxUIDAsXG4gICAgICBQUklNQVJZIEtFWSAodHJhY2VfaWQsIHR1cm5faWQpXG4gICAgKVxuICBgKTtcbiAgZGIuZXhlYyhcIkNSRUFURSBJTkRFWCBJRiBOT1QgRVhJU1RTIGlkeF9nYXRlX3J1bnNfdHVybiBPTiBnYXRlX3J1bnModHJhY2VfaWQsIHR1cm5faWQpXCIpO1xuICBkYi5leGVjKFwiQ1JFQVRFIElOREVYIElGIE5PVCBFWElTVFMgaWR4X2dhdGVfcnVuc19sb29rdXAgT04gZ2F0ZV9ydW5zKG1pbGVzdG9uZV9pZCwgc2xpY2VfaWQsIHRhc2tfaWQsIGdhdGVfaWQpXCIpO1xuICBkYi5leGVjKFwiQ1JFQVRFIElOREVYIElGIE5PVCBFWElTVFMgaWR4X3R1cm5fZ2l0X3R4X3R1cm4gT04gdHVybl9naXRfdHJhbnNhY3Rpb25zKHRyYWNlX2lkLCB0dXJuX2lkKVwiKTtcbiAgZGIuZXhlYyhcIkNSRUFURSBJTkRFWCBJRiBOT1QgRVhJU1RTIGlkeF9hdWRpdF9ldmVudHNfdHJhY2UgT04gYXVkaXRfZXZlbnRzKHRyYWNlX2lkLCB0cylcIik7XG4gIGRiLmV4ZWMoXCJDUkVBVEUgSU5ERVggSUYgTk9UIEVYSVNUUyBpZHhfYXVkaXRfZXZlbnRzX3R1cm4gT04gYXVkaXRfZXZlbnRzKHRyYWNlX2lkLCB0dXJuX2lkLCB0cylcIik7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhcHBseU1pZ3JhdGlvblYxNkVzY2FsYXRpb25Tb3VyY2UoZGI6IERiQWRhcHRlcik6IHZvaWQge1xuICBlbnN1cmVDb2x1bW4oZGIsIFwic2xpY2VzXCIsIFwiaXNfc2tldGNoXCIsIFwiQUxURVIgVEFCTEUgc2xpY2VzIEFERCBDT0xVTU4gaXNfc2tldGNoIElOVEVHRVIgTk9UIE5VTEwgREVGQVVMVCAwXCIpO1xuICBlbnN1cmVDb2x1bW4oZGIsIFwic2xpY2VzXCIsIFwic2tldGNoX3Njb3BlXCIsIFwiQUxURVIgVEFCTEUgc2xpY2VzIEFERCBDT0xVTU4gc2tldGNoX3Njb3BlIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJ1wiKTtcbiAgZW5zdXJlQ29sdW1uKGRiLCBcImRlY2lzaW9uc1wiLCBcInNvdXJjZVwiLCBcIkFMVEVSIFRBQkxFIGRlY2lzaW9ucyBBREQgQ09MVU1OIHNvdXJjZSBURVhUIE5PVCBOVUxMIERFRkFVTFQgJ2Rpc2N1c3Npb24nXCIpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYXBwbHlNaWdyYXRpb25WMTdUYXNrRXNjYWxhdGlvbihkYjogRGJBZGFwdGVyKTogdm9pZCB7XG4gIGVuc3VyZUNvbHVtbihkYiwgXCJ0YXNrc1wiLCBcImJsb2NrZXJfc291cmNlXCIsIFwiQUxURVIgVEFCTEUgdGFza3MgQUREIENPTFVNTiBibG9ja2VyX3NvdXJjZSBURVhUIE5PVCBOVUxMIERFRkFVTFQgJydcIik7XG4gIGVuc3VyZUNvbHVtbihkYiwgXCJ0YXNrc1wiLCBcImVzY2FsYXRpb25fcGVuZGluZ1wiLCBcIkFMVEVSIFRBQkxFIHRhc2tzIEFERCBDT0xVTU4gZXNjYWxhdGlvbl9wZW5kaW5nIElOVEVHRVIgTk9UIE5VTEwgREVGQVVMVCAwXCIpO1xuICBlbnN1cmVDb2x1bW4oZGIsIFwidGFza3NcIiwgXCJlc2NhbGF0aW9uX2F3YWl0aW5nX3Jldmlld1wiLCBcIkFMVEVSIFRBQkxFIHRhc2tzIEFERCBDT0xVTU4gZXNjYWxhdGlvbl9hd2FpdGluZ19yZXZpZXcgSU5URUdFUiBOT1QgTlVMTCBERUZBVUxUIDBcIik7XG4gIGVuc3VyZUNvbHVtbihkYiwgXCJ0YXNrc1wiLCBcImVzY2FsYXRpb25fYXJ0aWZhY3RfcGF0aFwiLCBcIkFMVEVSIFRBQkxFIHRhc2tzIEFERCBDT0xVTU4gZXNjYWxhdGlvbl9hcnRpZmFjdF9wYXRoIFRFWFQgREVGQVVMVCBOVUxMXCIpO1xuICBlbnN1cmVDb2x1bW4oZGIsIFwidGFza3NcIiwgXCJlc2NhbGF0aW9uX292ZXJyaWRlX2FwcGxpZWRfYXRcIiwgXCJBTFRFUiBUQUJMRSB0YXNrcyBBREQgQ09MVU1OIGVzY2FsYXRpb25fb3ZlcnJpZGVfYXBwbGllZF9hdCBURVhUIERFRkFVTFQgTlVMTFwiKTtcbiAgZGIuZXhlYyhcIkNSRUFURSBJTkRFWCBJRiBOT1QgRVhJU1RTIGlkeF90YXNrc19lc2NhbGF0aW9uX3BlbmRpbmcgT04gdGFza3MobWlsZXN0b25lX2lkLCBzbGljZV9pZCwgZXNjYWxhdGlvbl9wZW5kaW5nKVwiKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFwcGx5TWlncmF0aW9uVjE4TWVtb3J5U291cmNlcyhkYjogRGJBZGFwdGVyKTogdm9pZCB7XG4gIGVuc3VyZUNvbHVtbihkYiwgXCJtZW1vcmllc1wiLCBcInNjb3BlXCIsIFwiQUxURVIgVEFCTEUgbWVtb3JpZXMgQUREIENPTFVNTiBzY29wZSBURVhUIE5PVCBOVUxMIERFRkFVTFQgJ3Byb2plY3QnXCIpO1xuICBlbnN1cmVDb2x1bW4oZGIsIFwibWVtb3JpZXNcIiwgXCJ0YWdzXCIsIFwiQUxURVIgVEFCTEUgbWVtb3JpZXMgQUREIENPTFVNTiB0YWdzIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnW10nXCIpO1xuICBkYi5leGVjKGBcbiAgICBDUkVBVEUgVEFCTEUgSUYgTk9UIEVYSVNUUyBtZW1vcnlfc291cmNlcyAoXG4gICAgICBpZCBURVhUIFBSSU1BUlkgS0VZLFxuICAgICAga2luZCBURVhUIE5PVCBOVUxMLFxuICAgICAgdXJpIFRFWFQsXG4gICAgICB0aXRsZSBURVhULFxuICAgICAgY29udGVudCBURVhUIE5PVCBOVUxMLFxuICAgICAgY29udGVudF9oYXNoIFRFWFQgTk9UIE5VTEwgVU5JUVVFLFxuICAgICAgaW1wb3J0ZWRfYXQgVEVYVCBOT1QgTlVMTCxcbiAgICAgIHNjb3BlIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAncHJvamVjdCcsXG4gICAgICB0YWdzIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnW10nXG4gICAgKVxuICBgKTtcbiAgZW5zdXJlQ29sdW1uKGRiLCBcIm1lbW9yeV9zb3VyY2VzXCIsIFwic2NvcGVcIiwgXCJBTFRFUiBUQUJMRSBtZW1vcnlfc291cmNlcyBBREQgQ09MVU1OIHNjb3BlIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAncHJvamVjdCdcIik7XG4gIGVuc3VyZUNvbHVtbihkYiwgXCJtZW1vcnlfc291cmNlc1wiLCBcInRhZ3NcIiwgXCJBTFRFUiBUQUJMRSBtZW1vcnlfc291cmNlcyBBREQgQ09MVU1OIHRhZ3MgVEVYVCBOT1QgTlVMTCBERUZBVUxUICdbXSdcIik7XG4gIGRiLmV4ZWMoXCJDUkVBVEUgSU5ERVggSUYgTk9UIEVYSVNUUyBpZHhfbWVtb3JpZXNfc2NvcGUgT04gbWVtb3JpZXMoc2NvcGUpXCIpO1xuICBkYi5leGVjKFwiQ1JFQVRFIElOREVYIElGIE5PVCBFWElTVFMgaWR4X21lbW9yeV9zb3VyY2VzX2tpbmQgT04gbWVtb3J5X3NvdXJjZXMoa2luZClcIik7XG4gIGRiLmV4ZWMoXCJDUkVBVEUgSU5ERVggSUYgTk9UIEVYSVNUUyBpZHhfbWVtb3J5X3NvdXJjZXNfc2NvcGUgT04gbWVtb3J5X3NvdXJjZXMoc2NvcGUpXCIpO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIE1pZ3JhdGlvblYxOUhvb2tzIHtcbiAgdHJ5Q3JlYXRlTWVtb3JpZXNGdHMoZGI6IERiQWRhcHRlcik6IGJvb2xlYW47XG4gIGlzTWVtb3JpZXNGdHNBdmFpbGFibGUoZGI6IERiQWRhcHRlcik6IGJvb2xlYW47XG4gIGJhY2tmaWxsTWVtb3JpZXNGdHMoZGI6IERiQWRhcHRlcik6IHZvaWQ7XG4gIGxvZ1dhcm5pbmcoc2NvcGU6IHN0cmluZywgbWVzc2FnZTogc3RyaW5nKTogdm9pZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFwcGx5TWlncmF0aW9uVjE5TWVtb3J5RnRzKGRiOiBEYkFkYXB0ZXIsIGhvb2tzOiBNaWdyYXRpb25WMTlIb29rcyk6IHZvaWQge1xuICBkYi5leGVjKGBcbiAgICBDUkVBVEUgVEFCTEUgSUYgTk9UIEVYSVNUUyBtZW1vcnlfZW1iZWRkaW5ncyAoXG4gICAgICBtZW1vcnlfaWQgVEVYVCBQUklNQVJZIEtFWSxcbiAgICAgIG1vZGVsIFRFWFQgTk9UIE5VTEwsXG4gICAgICBkaW0gSU5URUdFUiBOT1QgTlVMTCxcbiAgICAgIHZlY3RvciBCTE9CIE5PVCBOVUxMLFxuICAgICAgdXBkYXRlZF9hdCBURVhUIE5PVCBOVUxMXG4gICAgKVxuICBgKTtcbiAgaG9va3MudHJ5Q3JlYXRlTWVtb3JpZXNGdHMoZGIpO1xuICBpZiAoaG9va3MuaXNNZW1vcmllc0Z0c0F2YWlsYWJsZShkYikpIHtcbiAgICB0cnkge1xuICAgICAgaG9va3MuYmFja2ZpbGxNZW1vcmllc0Z0cyhkYik7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBob29rcy5sb2dXYXJuaW5nKFwiZGJcIiwgYEZUUzUgYmFja2ZpbGwgZmFpbGVkOiAkeyhlcnIgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgfVxuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhcHBseU1pZ3JhdGlvblYyME1lbW9yeVJlbGF0aW9ucyhkYjogRGJBZGFwdGVyKTogdm9pZCB7XG4gIGRiLmV4ZWMoYFxuICAgIENSRUFURSBUQUJMRSBJRiBOT1QgRVhJU1RTIG1lbW9yeV9yZWxhdGlvbnMgKFxuICAgICAgZnJvbV9pZCBURVhUIE5PVCBOVUxMLFxuICAgICAgdG9faWQgVEVYVCBOT1QgTlVMTCxcbiAgICAgIHJlbCBURVhUIE5PVCBOVUxMLFxuICAgICAgY29uZmlkZW5jZSBSRUFMIE5PVCBOVUxMIERFRkFVTFQgMC44LFxuICAgICAgY3JlYXRlZF9hdCBURVhUIE5PVCBOVUxMLFxuICAgICAgUFJJTUFSWSBLRVkgKGZyb21faWQsIHRvX2lkLCByZWwpXG4gICAgKVxuICBgKTtcbiAgZGIuZXhlYyhcIkNSRUFURSBJTkRFWCBJRiBOT1QgRVhJU1RTIGlkeF9tZW1vcnlfcmVsYXRpb25zX2Zyb20gT04gbWVtb3J5X3JlbGF0aW9ucyhmcm9tX2lkKVwiKTtcbiAgZGIuZXhlYyhcIkNSRUFURSBJTkRFWCBJRiBOT1QgRVhJU1RTIGlkeF9tZW1vcnlfcmVsYXRpb25zX3RvIE9OIG1lbW9yeV9yZWxhdGlvbnModG9faWQpXCIpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYXBwbHlNaWdyYXRpb25WMjFTdHJ1Y3R1cmVkTWVtb3JpZXMoZGI6IERiQWRhcHRlcik6IHZvaWQge1xuICBlbnN1cmVDb2x1bW4oZGIsIFwibWVtb3JpZXNcIiwgXCJzdHJ1Y3R1cmVkX2ZpZWxkc1wiLCBcIkFMVEVSIFRBQkxFIG1lbW9yaWVzIEFERCBDT0xVTU4gc3RydWN0dXJlZF9maWVsZHMgVEVYVCBERUZBVUxUIE5VTExcIik7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhcHBseU1pZ3JhdGlvblYyM01pbGVzdG9uZVF1ZXVlKGRiOiBEYkFkYXB0ZXIpOiB2b2lkIHtcbiAgZW5zdXJlQ29sdW1uKGRiLCBcIm1pbGVzdG9uZXNcIiwgXCJzZXF1ZW5jZVwiLCBcIkFMVEVSIFRBQkxFIG1pbGVzdG9uZXMgQUREIENPTFVNTiBzZXF1ZW5jZSBJTlRFR0VSIERFRkFVTFQgMFwiKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFwcGx5TWlncmF0aW9uVjI2TWlsZXN0b25lQ29tbWl0QXR0cmlidXRpb25zKGRiOiBEYkFkYXB0ZXIpOiB2b2lkIHtcbiAgZGIuZXhlYyhgXG4gICAgQ1JFQVRFIFRBQkxFIElGIE5PVCBFWElTVFMgbWlsZXN0b25lX2NvbW1pdF9hdHRyaWJ1dGlvbnMgKFxuICAgICAgY29tbWl0X3NoYSBURVhUIE5PVCBOVUxMLFxuICAgICAgbWlsZXN0b25lX2lkIFRFWFQgTk9UIE5VTEwsXG4gICAgICBzbGljZV9pZCBURVhUIERFRkFVTFQgTlVMTCxcbiAgICAgIHRhc2tfaWQgVEVYVCBERUZBVUxUIE5VTEwsXG4gICAgICBzb3VyY2UgVEVYVCBOT1QgTlVMTCBERUZBVUxUICdyZWNvcmRlZCcsXG4gICAgICBjb25maWRlbmNlIFJFQUwgTk9UIE5VTEwgREVGQVVMVCAxLjAsXG4gICAgICBmaWxlc19qc29uIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnW10nLFxuICAgICAgY3JlYXRlZF9hdCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICBQUklNQVJZIEtFWSAoY29tbWl0X3NoYSwgbWlsZXN0b25lX2lkKVxuICAgIClcbiAgYCk7XG4gIGRiLmV4ZWMoXCJDUkVBVEUgSU5ERVggSUYgTk9UIEVYSVNUUyBpZHhfbWlsZXN0b25lX2NvbW1pdF9hdHRyX21pbGVzdG9uZSBPTiBtaWxlc3RvbmVfY29tbWl0X2F0dHJpYnV0aW9ucyhtaWxlc3RvbmVfaWQpXCIpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYXBwbHlNaWdyYXRpb25WMjdBcnRpZmFjdEhhc2goZGI6IERiQWRhcHRlcik6IHZvaWQge1xuICBlbnN1cmVDb2x1bW4oZGIsIFwiYXJ0aWZhY3RzXCIsIFwiY29udGVudF9oYXNoXCIsIFwiQUxURVIgVEFCTEUgYXJ0aWZhY3RzIEFERCBDT0xVTU4gY29udGVudF9oYXNoIFRFWFQgREVGQVVMVCBOVUxMXCIpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYXBwbHlNaWdyYXRpb25WMjhNZW1vcnlMYXN0SGl0QXQoZGI6IERiQWRhcHRlcik6IHZvaWQge1xuICBlbnN1cmVDb2x1bW4oZGIsIFwibWVtb3JpZXNcIiwgXCJsYXN0X2hpdF9hdFwiLCBcIkFMVEVSIFRBQkxFIG1lbW9yaWVzIEFERCBDT0xVTU4gbGFzdF9oaXRfYXQgVEVYVCBERUZBVUxUIE5VTExcIik7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgTWlncmF0aW9uVjIySG9va3Mge1xuICBjb3B5UXVhbGl0eUdhdGVSb3dzVG9SZXBhaXJlZFRhYmxlKGRiOiBEYkFkYXB0ZXIpOiB2b2lkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYXBwbHlNaWdyYXRpb25WMjJRdWFsaXR5R2F0ZVJlcGFpcihkYjogRGJBZGFwdGVyLCBob29rczogTWlncmF0aW9uVjIySG9va3MpOiB2b2lkIHtcbiAgY29uc3QgcWdJbmZvID0gZGIucHJlcGFyZShcIlBSQUdNQSB0YWJsZV9pbmZvKHF1YWxpdHlfZ2F0ZXMpXCIpLmFsbCgpIGFzIEFycmF5PFJlY29yZDxzdHJpbmcsIHVua25vd24+PjtcbiAgY29uc3QgdGFza0lkQ29sID0gcWdJbmZvLmZpbmQoKHIpID0+IHJbXCJuYW1lXCJdID09PSBcInRhc2tfaWRcIik7XG4gIGNvbnN0IG5lZWRzUmVwYWlyID0gdGFza0lkQ29sICYmICh0YXNrSWRDb2xbXCJub3RudWxsXCJdID09PSAwIHx8IHRhc2tJZENvbFtcIm5vdG51bGxcIl0gPT09IFwiMFwiKTtcbiAgaWYgKG5lZWRzUmVwYWlyKSB7XG4gICAgZGIuZXhlYyhgXG4gICAgICBDUkVBVEUgVEFCTEUgcXVhbGl0eV9nYXRlc19uZXcgKFxuICAgICAgICBtaWxlc3RvbmVfaWQgVEVYVCBOT1QgTlVMTCxcbiAgICAgICAgc2xpY2VfaWQgVEVYVCBOT1QgTlVMTCxcbiAgICAgICAgZ2F0ZV9pZCBURVhUIE5PVCBOVUxMLFxuICAgICAgICBzY29wZSBURVhUIE5PVCBOVUxMIERFRkFVTFQgJ3NsaWNlJyxcbiAgICAgICAgdGFza19pZCBURVhUIE5PVCBOVUxMIERFRkFVTFQgJycsXG4gICAgICAgIHN0YXR1cyBURVhUIE5PVCBOVUxMIERFRkFVTFQgJ3BlbmRpbmcnLFxuICAgICAgICB2ZXJkaWN0IFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgICAgcmF0aW9uYWxlIFRFWFQgTk9UIE5VTEwgREVGQVVMVCAnJyxcbiAgICAgICAgZmluZGluZ3MgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnLFxuICAgICAgICBldmFsdWF0ZWRfYXQgVEVYVCBERUZBVUxUIE5VTEwsXG4gICAgICAgIFBSSU1BUlkgS0VZIChtaWxlc3RvbmVfaWQsIHNsaWNlX2lkLCBnYXRlX2lkLCB0YXNrX2lkKSxcbiAgICAgICAgRk9SRUlHTiBLRVkgKG1pbGVzdG9uZV9pZCwgc2xpY2VfaWQpIFJFRkVSRU5DRVMgc2xpY2VzKG1pbGVzdG9uZV9pZCwgaWQpXG4gICAgICApXG4gICAgYCk7XG4gICAgaG9va3MuY29weVF1YWxpdHlHYXRlUm93c1RvUmVwYWlyZWRUYWJsZShkYik7XG4gICAgZGIuZXhlYyhcIkRST1AgVEFCTEUgcXVhbGl0eV9nYXRlc1wiKTtcbiAgICBkYi5leGVjKFwiQUxURVIgVEFCTEUgcXVhbGl0eV9nYXRlc19uZXcgUkVOQU1FIFRPIHF1YWxpdHlfZ2F0ZXNcIik7XG4gICAgZGIuZXhlYyhcIkNSRUFURSBJTkRFWCBJRiBOT1QgRVhJU1RTIGlkeF9xdWFsaXR5X2dhdGVzX3BlbmRpbmcgT04gcXVhbGl0eV9nYXRlcyhtaWxlc3RvbmVfaWQsIHNsaWNlX2lkLCBzdGF0dXMpXCIpO1xuICB9XG4gIGVuc3VyZUNvbHVtbihkYiwgXCJxdWFsaXR5X2dhdGVzXCIsIFwic2NvcGVcIiwgXCJBTFRFUiBUQUJMRSBxdWFsaXR5X2dhdGVzIEFERCBDT0xVTU4gc2NvcGUgVEVYVCBOT1QgTlVMTCBERUZBVUxUICdzbGljZSdcIik7XG4gIGVuc3VyZUNvbHVtbihkYiwgXCJhc3Nlc3NtZW50c1wiLCBcInNjb3BlXCIsIFwiQUxURVIgVEFCTEUgYXNzZXNzbWVudHMgQUREIENPTFVNTiBzY29wZSBURVhUIE5PVCBOVUxMIERFRkFVTFQgJydcIik7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFJQSxTQUFTLG9CQUFvQjtBQUV0QixTQUFTLDBCQUEwQixJQUFxQjtBQUM3RCxLQUFHLEtBQUs7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxHQVVQO0FBQ0g7QUFFTyxTQUFTLHlCQUF5QixJQUFxQjtBQUM1RCxLQUFHLEtBQUs7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLEdBY1A7QUFDRCxLQUFHLEtBQUs7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsR0FNUDtBQUNELEtBQUcsS0FBSywyRUFBMkU7QUFDbkYsS0FBRyxLQUFLLHFDQUFxQztBQUM3QyxLQUFHLEtBQUssbUZBQW1GO0FBQzdGO0FBRU8sU0FBUywrQkFBK0IsSUFBcUI7QUFDbEUsZUFBYSxJQUFJLGFBQWEsV0FBVyx3RUFBd0U7QUFDakgsS0FBRyxLQUFLLHNDQUFzQztBQUM5QyxLQUFHLEtBQUsscUZBQXFGO0FBQy9GO0FBRU8sU0FBUyxnQ0FBZ0MsSUFBcUI7QUFDbkUsS0FBRyxLQUFLO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxHQVFQO0FBQ0QsS0FBRyxLQUFLO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLEdBWVA7QUFDRCxLQUFHLEtBQUs7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7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
