import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { existsSync, copyFileSync, mkdirSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { GSDError, GSD_STALE_STATE } from "./errors.js";
import { getGateIdsForTurn } from "./gate-registry.js";
import { logError, logWarning } from "./workflow-logger.js";
import { createDbAdapter } from "./db-adapter.js";
import { createBaseSchemaObjects } from "./db-base-schema.js";
import { createCoordinationTablesV24 } from "./db-coordination-schema.js";
import { createDbConnectionCache } from "./db-connection-cache.js";
import {
  emptyTaskStatusCounts,
  rowToActiveTaskSummary,
  rowToIdStatusSummary,
  rowToTaskStatusCounts,
  rowsToStringColumn
} from "./db-lightweight-query-rows.js";
import {
  rowToActiveDecision,
  rowToActiveRequirement,
  rowToDecision,
  rowToRequirement,
  rowsToRequirementCounts
} from "./db-decision-requirement-rows.js";
import { rowToGate } from "./db-gate-rows.js";
import { rowToArtifact, rowToMilestone } from "./db-milestone-artifact-rows.js";
import { backupDatabaseBeforeMigration } from "./db-migration-backup.js";
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
  applyMigrationV28MemoryLastHitAt
} from "./db-migration-steps.js";
import { isMemoriesFtsAvailableSchema, tryCreateMemoriesFtsSchema } from "./db-memory-fts-schema.js";
import { createDbOpenState } from "./db-open-state.js";
import { createRuntimeKvTableV25 } from "./db-runtime-kv-schema.js";
import { getCurrentSchemaVersion, recordSchemaVersion } from "./db-schema-metadata.js";
import { rowToSlice, rowToTask } from "./db-task-slice-rows.js";
import { createDbTransactionRunner } from "./db-transaction.js";
import { ensureVerificationEvidenceDedupIndex } from "./db-verification-evidence-schema.js";
import { createSqliteProviderLoader, suppressSqliteWarning } from "./db-provider.js";
const _require = createRequire(import.meta.url);
const providerLoader = createSqliteProviderLoader({
  requireModule: (id) => _require(id),
  suppressSqliteWarning,
  nodeVersion: process.versions.node,
  writeStderr: (message) => process.stderr.write(message)
});
const SCHEMA_VERSION = 28;
function initSchema(db, fileBacked) {
  if (fileBacked) db.exec("PRAGMA journal_mode=WAL");
  if (fileBacked) db.exec("PRAGMA busy_timeout = 5000");
  if (fileBacked) db.exec("PRAGMA synchronous = NORMAL");
  if (fileBacked) db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  if (fileBacked) db.exec("PRAGMA cache_size = -8000");
  if (fileBacked && process.platform !== "darwin") db.exec("PRAGMA mmap_size = 67108864");
  db.exec("PRAGMA temp_store = MEMORY");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("BEGIN");
  try {
    createBaseSchemaObjects(db, {
      tryCreateMemoriesFts,
      ensureVerificationEvidenceDedupIndex
    });
    const existing = db.prepare("SELECT count(*) as cnt FROM schema_version").get();
    if (existing && existing["cnt"] === 0) {
      createCoordinationTablesV24(db);
      createRuntimeKvTableV25(db);
      db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_escalation_pending ON tasks(milestone_id, slice_id, escalation_pending)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_memory_sources_kind ON memory_sources(kind)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_memory_sources_scope ON memory_sources(scope)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_memory_relations_from ON memory_relations(from_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_memory_relations_to ON memory_relations(to_id)");
      recordSchemaVersion(db, SCHEMA_VERSION);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  migrateSchema(db);
}
function tryCreateMemoriesFts(db) {
  return tryCreateMemoriesFtsSchema(db, {
    onUnavailable: (message) => logWarning("db", message)
  });
}
function isMemoriesFtsAvailable(db) {
  return isMemoriesFtsAvailableSchema(db);
}
function backfillMemoriesFts(db) {
  db.exec(`INSERT INTO memories_fts(rowid, content) SELECT seq, content FROM memories`);
}
function copyQualityGateRowsToRepairedTable(db) {
  db.exec(`
    INSERT OR IGNORE INTO quality_gates_new
      (milestone_id, slice_id, gate_id, scope, task_id, status, verdict, rationale, findings, evaluated_at)
    SELECT milestone_id, slice_id, gate_id, scope, COALESCE(task_id, ''), status, verdict, rationale, findings, evaluated_at
    FROM quality_gates
  `);
}
function migrateSchema(db) {
  const currentVersion = getCurrentSchemaVersion(db);
  if (currentVersion >= SCHEMA_VERSION) return;
  backupDatabaseBeforeMigration(db, currentPath, currentVersion, {
    existsSync,
    copyFileSync,
    logWarning
  });
  db.exec("BEGIN");
  try {
    if (currentVersion < 2) {
      applyMigrationV2Artifacts(db);
      recordSchemaVersion(db, 2);
    }
    if (currentVersion < 3) {
      applyMigrationV3Memories(db);
      recordSchemaVersion(db, 3);
    }
    if (currentVersion < 4) {
      applyMigrationV4DecisionMadeBy(db);
      recordSchemaVersion(db, 4);
    }
    if (currentVersion < 5) {
      applyMigrationV5HierarchyTables(db);
      recordSchemaVersion(db, 5);
    }
    if (currentVersion < 6) {
      applyMigrationV6SliceSummaries(db);
      recordSchemaVersion(db, 6);
    }
    if (currentVersion < 7) {
      applyMigrationV7Dependencies(db);
      recordSchemaVersion(db, 7);
    }
    if (currentVersion < 8) {
      applyMigrationV8PlanningFields(db);
      recordSchemaVersion(db, 8);
    }
    if (currentVersion < 9) {
      applyMigrationV9Ordering(db);
      recordSchemaVersion(db, 9);
    }
    if (currentVersion < 10) {
      applyMigrationV10ReplanTrigger(db);
      recordSchemaVersion(db, 10);
    }
    if (currentVersion < 11) {
      applyMigrationV11TaskPlanning(db);
      recordSchemaVersion(db, 11);
    }
    if (currentVersion < 12) {
      applyMigrationV12QualityGates(db);
      recordSchemaVersion(db, 12);
    }
    if (currentVersion < 13) {
      applyMigrationV13HotPathIndexes(db, ensureVerificationEvidenceDedupIndex);
      recordSchemaVersion(db, 13);
    }
    if (currentVersion < 14) {
      applyMigrationV14SliceDependencies(db);
      recordSchemaVersion(db, 14);
    }
    if (currentVersion < 15) {
      applyMigrationV15AuditTables(db);
      recordSchemaVersion(db, 15);
    }
    if (currentVersion < 16) {
      applyMigrationV16EscalationSource(db);
      recordSchemaVersion(db, 16);
    }
    if (currentVersion < 17) {
      applyMigrationV17TaskEscalation(db);
      recordSchemaVersion(db, 17);
    }
    if (currentVersion < 18) {
      applyMigrationV18MemorySources(db);
      recordSchemaVersion(db, 18);
    }
    if (currentVersion < 19) {
      applyMigrationV19MemoryFts(db, {
        tryCreateMemoriesFts,
        isMemoriesFtsAvailable,
        backfillMemoriesFts,
        logWarning
      });
      recordSchemaVersion(db, 19);
    }
    if (currentVersion < 20) {
      applyMigrationV20MemoryRelations(db);
      recordSchemaVersion(db, 20);
    }
    if (currentVersion < 21) {
      applyMigrationV21StructuredMemories(db);
      recordSchemaVersion(db, 21);
    }
    if (currentVersion < 22) {
      applyMigrationV22QualityGateRepair(db, { copyQualityGateRowsToRepairedTable });
      recordSchemaVersion(db, 22);
    }
    if (currentVersion < 23) {
      applyMigrationV23MilestoneQueue(db);
      recordSchemaVersion(db, 23);
    }
    if (currentVersion < 24) {
      createCoordinationTablesV24(db);
      recordSchemaVersion(db, 24);
    }
    if (currentVersion < 25) {
      createRuntimeKvTableV25(db);
      recordSchemaVersion(db, 25);
    }
    if (currentVersion < 26) {
      applyMigrationV26MilestoneCommitAttributions(db);
      recordSchemaVersion(db, 26);
    }
    if (currentVersion < 27) {
      applyMigrationV27ArtifactHash(db);
      recordSchemaVersion(db, 27);
    }
    if (currentVersion < 28) {
      applyMigrationV28MemoryLastHitAt(db);
      recordSchemaVersion(db, 28);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
let currentDb = null;
let currentPath = null;
let currentPid = 0;
let _exitHandlerRegistered = false;
const _dbOpenState = createDbOpenState();
let _currentIdentityKey = null;
const _dbCache = createDbConnectionCache();
function _getDbCache() {
  return _dbCache.asReadonlyMap();
}
function closeCachedConnection(entry, source) {
  try {
    entry.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (e) {
    if (source === "workspace") logWarning("db", `WAL checkpoint (byWorkspace) failed: ${e.message}`);
  }
  try {
    entry.db.exec("PRAGMA incremental_vacuum(64)");
  } catch (e) {
    if (source === "workspace") logWarning("db", `incremental vacuum (byWorkspace) failed: ${e.message}`);
  }
  try {
    entry.db.close();
  } catch (e) {
    if (source === "workspace") logWarning("db", `database close (byWorkspace) failed: ${e.message}`);
  }
}
function closeAllDatabases() {
  _dbCache.closeNonActive(currentDb, (entry) => closeCachedConnection(entry, "all"));
  closeDatabase();
}
function openDatabaseByWorkspace(workspace) {
  const key = workspace.identityKey;
  const dbPath = workspace.contract.projectDb;
  const cached = _dbCache.get(key);
  if (cached) {
    currentDb = cached.db;
    currentPath = cached.dbPath;
    currentPid = process.pid;
    _dbOpenState.markAttempted();
    _currentIdentityKey = key;
    return true;
  }
  let oldDb = null;
  let oldPath = null;
  let oldPid = 0;
  let oldKey = null;
  if (currentDb !== null && _currentIdentityKey !== null) {
    oldDb = currentDb;
    oldPath = currentPath;
    oldPid = currentPid;
    oldKey = _currentIdentityKey;
    _dbCache.set(_currentIdentityKey, {
      dbPath: currentPath,
      db: currentDb
    });
    currentDb = null;
    currentPath = null;
    currentPid = 0;
    _currentIdentityKey = null;
  }
  let opened;
  try {
    opened = openDatabase(dbPath);
  } catch (err) {
    if (oldDb !== null) {
      currentDb = oldDb;
      currentPath = oldPath;
      currentPid = oldPid;
      _currentIdentityKey = oldKey;
    }
    throw err;
  }
  if (opened && currentDb) {
    _dbCache.set(key, { dbPath, db: currentDb });
    _currentIdentityKey = key;
  } else if (!opened && oldDb !== null) {
    currentDb = oldDb;
    currentPath = oldPath;
    currentPid = oldPid;
    _currentIdentityKey = oldKey;
  }
  return opened;
}
function openDatabaseByScope(scope) {
  return openDatabaseByWorkspace(scope.workspace);
}
function closeDatabaseByWorkspace(workspace) {
  const key = workspace.identityKey;
  const cached = _dbCache.get(key);
  if (!cached) return;
  _dbCache.delete(key);
  if (currentDb === cached.db) {
    closeDatabase();
  } else {
    closeCachedConnection(cached, "workspace");
  }
}
function getDbProvider() {
  providerLoader.load();
  return providerLoader.getProviderName();
}
function isDbAvailable() {
  return currentDb !== null;
}
function wasDbOpenAttempted() {
  return _dbOpenState.snapshot().attempted;
}
function getDbStatus() {
  providerLoader.load();
  const openState = _dbOpenState.snapshot();
  return {
    available: currentDb !== null,
    provider: providerLoader.getProviderName(),
    attempted: openState.attempted,
    lastError: openState.lastError,
    lastPhase: openState.lastPhase
  };
}
function openDatabase(path) {
  _dbOpenState.markAttempted();
  if (currentDb && currentPath !== path) closeDatabase();
  if (currentDb && currentPath === path) return true;
  _dbOpenState.clearError();
  let rawDb;
  let fallbackOpen = null;
  try {
    rawDb = providerLoader.openRaw(path);
  } catch (primaryErr) {
    _dbOpenState.recordError("open", primaryErr);
    fallbackOpen = providerLoader.tryOpenBetterSqliteFallback(path);
    if (fallbackOpen) {
      rawDb = fallbackOpen.rawDb;
      _dbOpenState.clearError();
    }
    if (!rawDb) throw primaryErr;
  }
  if (!rawDb) return false;
  const adapter = createDbAdapter(rawDb);
  const fileBacked = path !== ":memory:";
  try {
    initSchema(adapter, fileBacked);
  } catch (err) {
    if (fileBacked && err instanceof Error && err.message?.includes("malformed")) {
      try {
        adapter.exec("VACUUM");
        initSchema(adapter, fileBacked);
        process.stderr.write("gsd-db: recovered corrupt database via VACUUM\n");
      } catch (retryErr) {
        _dbOpenState.recordError("vacuum-recovery", retryErr);
        try {
          adapter.close();
        } catch (e) {
          logWarning("db", `close after VACUUM failed: ${e.message}`);
        }
        throw retryErr;
      }
    } else {
      _dbOpenState.recordError("initSchema", err);
      try {
        adapter.close();
      } catch (e) {
        logWarning("db", `close after initSchema failed: ${e.message}`);
      }
      throw err;
    }
  }
  if (fallbackOpen) providerLoader.commitFallback(fallbackOpen);
  currentDb = adapter;
  currentPath = path;
  currentPid = process.pid;
  if (!_exitHandlerRegistered) {
    _exitHandlerRegistered = true;
    process.on("exit", () => {
      try {
        closeDatabase();
      } catch (e) {
        logWarning("db", `exit handler close failed: ${e.message}`);
      }
    });
  }
  return true;
}
function closeDatabase() {
  if (currentDb) {
    try {
      currentDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (e) {
      logWarning("db", `WAL checkpoint failed: ${e.message}`);
    }
    try {
      currentDb.exec("PRAGMA incremental_vacuum(64)");
    } catch (e) {
      logWarning("db", `incremental vacuum failed: ${e.message}`);
    }
    try {
      currentDb.close();
    } catch (e) {
      logWarning("db", `database close failed: ${e.message}`);
    }
    if (_currentIdentityKey !== null) {
      _dbCache.delete(_currentIdentityKey);
      _currentIdentityKey = null;
    }
    currentDb = null;
    currentPath = null;
    currentPid = 0;
  }
  _dbOpenState.reset();
}
function refreshOpenDatabaseFromDisk() {
  if (!currentDb || !currentPath) return false;
  if (currentPath === ":memory:") return false;
  const dbPath = currentPath;
  const identityKey = _currentIdentityKey;
  try {
    closeDatabase();
    const opened = openDatabase(dbPath);
    if (opened && identityKey && currentDb) {
      _dbCache.set(identityKey, { dbPath, db: currentDb });
      _currentIdentityKey = identityKey;
    }
    return opened;
  } catch (e) {
    logWarning("db", `database refresh failed: ${e.message}`);
    return false;
  }
}
function vacuumDatabase() {
  if (!currentDb) return;
  try {
    currentDb.exec("VACUUM");
  } catch (e) {
    logWarning("db", `VACUUM failed: ${e.message}`);
  }
}
function checkpointDatabase() {
  if (!currentDb) return;
  try {
    currentDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (e) {
    logWarning("db", `WAL checkpoint failed: ${e.message}`);
  }
}
const _transactionRunner = createDbTransactionRunner();
function createTransactionControls(db) {
  return {
    begin: () => db.exec("BEGIN"),
    beginRead: () => db.exec("BEGIN DEFERRED"),
    commit: () => db.exec("COMMIT"),
    rollback: () => db.exec("ROLLBACK")
  };
}
function isInTransaction() {
  return _transactionRunner.isInTransaction();
}
function transaction(fn) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  return _transactionRunner.transaction(createTransactionControls(currentDb), fn);
}
function readTransaction(fn) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  return _transactionRunner.readTransaction(createTransactionControls(currentDb), fn, (rollbackErr) => {
    logError("db", "snapshotState ROLLBACK failed", {
      error: rollbackErr.message
    });
  });
}
function insertDecision(d) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT INTO decisions (id, when_context, scope, decision, choice, rationale, revisable, made_by, source, superseded_by)
     VALUES (:id, :when_context, :scope, :decision, :choice, :rationale, :revisable, :made_by, :source, :superseded_by)`
  ).run({
    ":id": d.id,
    ":when_context": d.when_context,
    ":scope": d.scope,
    ":decision": d.decision,
    ":choice": d.choice,
    ":rationale": d.rationale,
    ":revisable": d.revisable,
    ":made_by": d.made_by ?? "agent",
    ":source": d.source ?? "discussion",
    ":superseded_by": d.superseded_by
  });
}
function getDecisionById(id) {
  if (!currentDb) return null;
  const row = currentDb.prepare("SELECT * FROM decisions WHERE id = ?").get(id);
  if (!row) return null;
  return rowToDecision(row);
}
function getActiveDecisions() {
  if (!currentDb) return [];
  const rows = currentDb.prepare("SELECT * FROM active_decisions").all();
  return rows.map(rowToActiveDecision);
}
function insertRequirement(r) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT INTO requirements (id, class, status, description, why, source, primary_owner, supporting_slices, validation, notes, full_content, superseded_by)
     VALUES (:id, :class, :status, :description, :why, :source, :primary_owner, :supporting_slices, :validation, :notes, :full_content, :superseded_by)`
  ).run({
    ":id": r.id,
    ":class": r.class,
    ":status": r.status,
    ":description": r.description,
    ":why": r.why,
    ":source": r.source,
    ":primary_owner": r.primary_owner,
    ":supporting_slices": r.supporting_slices,
    ":validation": r.validation,
    ":notes": r.notes,
    ":full_content": r.full_content,
    ":superseded_by": r.superseded_by
  });
}
function getRequirementById(id) {
  if (!currentDb) return null;
  const row = currentDb.prepare("SELECT * FROM requirements WHERE id = ?").get(id);
  if (!row) return null;
  return rowToRequirement(row);
}
function getActiveRequirements() {
  if (!currentDb) return [];
  const rows = currentDb.prepare("SELECT * FROM active_requirements").all();
  return rows.map(rowToActiveRequirement);
}
function getRequirementCounts() {
  if (!currentDb) {
    return { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 };
  }
  const rows = currentDb.prepare("SELECT lower(status) as status, COUNT(*) as count FROM requirements GROUP BY lower(status)").all();
  return rowsToRequirementCounts(rows);
}
function getDbOwnerPid() {
  return currentPid;
}
function getDbPath() {
  return currentPath;
}
function _getAdapter() {
  return currentDb;
}
function _resetProvider() {
  providerLoader.reset();
}
function upsertDecision(d) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT INTO decisions (id, when_context, scope, decision, choice, rationale, revisable, made_by, source, superseded_by)
     VALUES (:id, :when_context, :scope, :decision, :choice, :rationale, :revisable, :made_by, :source, :superseded_by)
     ON CONFLICT(id) DO UPDATE SET
       when_context = excluded.when_context,
       scope = excluded.scope,
       decision = excluded.decision,
       choice = excluded.choice,
       rationale = excluded.rationale,
       revisable = excluded.revisable,
       made_by = excluded.made_by,
       source = excluded.source,
       superseded_by = excluded.superseded_by`
  ).run({
    ":id": d.id,
    ":when_context": d.when_context,
    ":scope": d.scope,
    ":decision": d.decision,
    ":choice": d.choice,
    ":rationale": d.rationale,
    ":revisable": d.revisable,
    ":made_by": d.made_by ?? "agent",
    ":source": d.source ?? "discussion",
    ":superseded_by": d.superseded_by ?? null
  });
}
function upsertRequirement(r) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT OR REPLACE INTO requirements (id, class, status, description, why, source, primary_owner, supporting_slices, validation, notes, full_content, superseded_by)
     VALUES (:id, :class, :status, :description, :why, :source, :primary_owner, :supporting_slices, :validation, :notes, :full_content, :superseded_by)`
  ).run({
    ":id": r.id,
    ":class": r.class,
    ":status": r.status,
    ":description": r.description,
    ":why": r.why,
    ":source": r.source,
    ":primary_owner": r.primary_owner,
    ":supporting_slices": r.supporting_slices,
    ":validation": r.validation,
    ":notes": r.notes,
    ":full_content": r.full_content,
    ":superseded_by": r.superseded_by ?? null
  });
}
function clearArtifacts() {
  if (!currentDb) return;
  try {
    currentDb.exec("DELETE FROM artifacts");
  } catch (e) {
    logWarning("db", `clearArtifacts failed: ${e.message}`);
  }
}
function insertArtifact(a) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  const contentHash = createHash("sha256").update(a.full_content).digest("hex");
  currentDb.prepare(
    `INSERT OR REPLACE INTO artifacts (path, artifact_type, milestone_id, slice_id, task_id, full_content, imported_at, content_hash)
     VALUES (:path, :artifact_type, :milestone_id, :slice_id, :task_id, :full_content, :imported_at, :content_hash)`
  ).run({
    ":path": a.path,
    ":artifact_type": a.artifact_type,
    ":milestone_id": a.milestone_id,
    ":slice_id": a.slice_id,
    ":task_id": a.task_id,
    ":full_content": a.full_content,
    ":imported_at": (/* @__PURE__ */ new Date()).toISOString(),
    ":content_hash": contentHash
  });
}
function insertMilestone(m) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT OR IGNORE INTO milestones (
      id, title, status, depends_on, created_at,
      vision, success_criteria, key_risks, proof_strategy,
      verification_contract, verification_integration, verification_operational, verification_uat,
      definition_of_done, requirement_coverage, boundary_map_markdown
    ) VALUES (
      :id, :title, :status, :depends_on, :created_at,
      :vision, :success_criteria, :key_risks, :proof_strategy,
      :verification_contract, :verification_integration, :verification_operational, :verification_uat,
      :definition_of_done, :requirement_coverage, :boundary_map_markdown
    )`
  ).run({
    ":id": m.id,
    ":title": m.title ?? "",
    // Default to "queued" — never auto-create milestones as "active" (#3380).
    // Callers that need "active" must pass it explicitly.
    ":status": m.status ?? "queued",
    ":depends_on": JSON.stringify(m.depends_on ?? []),
    ":created_at": (/* @__PURE__ */ new Date()).toISOString(),
    ":vision": m.planning?.vision ?? "",
    ":success_criteria": JSON.stringify(m.planning?.successCriteria ?? []),
    ":key_risks": JSON.stringify(m.planning?.keyRisks ?? []),
    ":proof_strategy": JSON.stringify(m.planning?.proofStrategy ?? []),
    ":verification_contract": m.planning?.verificationContract ?? "",
    ":verification_integration": m.planning?.verificationIntegration ?? "",
    ":verification_operational": m.planning?.verificationOperational ?? "",
    ":verification_uat": m.planning?.verificationUat ?? "",
    ":definition_of_done": JSON.stringify(m.planning?.definitionOfDone ?? []),
    ":requirement_coverage": m.planning?.requirementCoverage ?? "",
    ":boundary_map_markdown": m.planning?.boundaryMapMarkdown ?? ""
  });
}
function upsertMilestonePlanning(milestoneId, planning) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `UPDATE milestones SET
      title = COALESCE(NULLIF(:title, ''), title),
      status = COALESCE(NULLIF(:status, ''), status),
      vision = COALESCE(:vision, vision),
      success_criteria = COALESCE(:success_criteria, success_criteria),
      key_risks = COALESCE(:key_risks, key_risks),
      proof_strategy = COALESCE(:proof_strategy, proof_strategy),
      verification_contract = COALESCE(:verification_contract, verification_contract),
      verification_integration = COALESCE(:verification_integration, verification_integration),
      verification_operational = COALESCE(:verification_operational, verification_operational),
      verification_uat = COALESCE(:verification_uat, verification_uat),
      definition_of_done = COALESCE(:definition_of_done, definition_of_done),
      requirement_coverage = COALESCE(:requirement_coverage, requirement_coverage),
      boundary_map_markdown = COALESCE(:boundary_map_markdown, boundary_map_markdown)
     WHERE id = :id`
  ).run({
    ":id": milestoneId,
    ":title": planning.title ?? "",
    ":status": planning.status ?? "",
    ":vision": planning.vision ?? null,
    ":success_criteria": planning.successCriteria ? JSON.stringify(planning.successCriteria) : null,
    ":key_risks": planning.keyRisks ? JSON.stringify(planning.keyRisks) : null,
    ":proof_strategy": planning.proofStrategy ? JSON.stringify(planning.proofStrategy) : null,
    ":verification_contract": planning.verificationContract ?? null,
    ":verification_integration": planning.verificationIntegration ?? null,
    ":verification_operational": planning.verificationOperational ?? null,
    ":verification_uat": planning.verificationUat ?? null,
    ":definition_of_done": planning.definitionOfDone ? JSON.stringify(planning.definitionOfDone) : null,
    ":requirement_coverage": planning.requirementCoverage ?? null,
    ":boundary_map_markdown": planning.boundaryMapMarkdown ?? null
  });
}
function insertSlice(s) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT INTO slices (
      milestone_id, id, title, status, risk, depends, demo, created_at,
      goal, success_criteria, proof_level, integration_closure, observability_impact, sequence,
      is_sketch, sketch_scope
    ) VALUES (
      :milestone_id, :id, :title, :status, :risk, :depends, :demo, :created_at,
      :goal, :success_criteria, :proof_level, :integration_closure, :observability_impact, :sequence,
      :is_sketch, :sketch_scope
    )
    ON CONFLICT (milestone_id, id) DO UPDATE SET
      title = CASE WHEN :raw_title IS NOT NULL THEN excluded.title ELSE slices.title END,
      status = CASE WHEN slices.status IN ('complete', 'done') THEN slices.status ELSE excluded.status END,
      risk = CASE WHEN :raw_risk IS NOT NULL THEN excluded.risk ELSE slices.risk END,
      depends = excluded.depends,
      demo = CASE WHEN :raw_demo IS NOT NULL THEN excluded.demo ELSE slices.demo END,
      goal = CASE WHEN :raw_goal IS NOT NULL THEN excluded.goal ELSE slices.goal END,
      success_criteria = CASE WHEN :raw_success_criteria IS NOT NULL THEN excluded.success_criteria ELSE slices.success_criteria END,
      proof_level = CASE WHEN :raw_proof_level IS NOT NULL THEN excluded.proof_level ELSE slices.proof_level END,
      integration_closure = CASE WHEN :raw_integration_closure IS NOT NULL THEN excluded.integration_closure ELSE slices.integration_closure END,
      observability_impact = CASE WHEN :raw_observability_impact IS NOT NULL THEN excluded.observability_impact ELSE slices.observability_impact END,
      sequence = CASE WHEN :raw_sequence IS NOT NULL THEN excluded.sequence ELSE slices.sequence END,
      is_sketch = CASE WHEN :raw_is_sketch IS NOT NULL THEN excluded.is_sketch ELSE slices.is_sketch END,
      sketch_scope = CASE WHEN :raw_sketch_scope IS NOT NULL THEN excluded.sketch_scope ELSE slices.sketch_scope END`
  ).run({
    ":milestone_id": s.milestoneId,
    ":id": s.id,
    ":title": s.title ?? "",
    ":status": s.status ?? "pending",
    ":risk": s.risk ?? "medium",
    ":depends": JSON.stringify(s.depends ?? []),
    ":demo": s.demo ?? "",
    ":created_at": (/* @__PURE__ */ new Date()).toISOString(),
    ":goal": s.planning?.goal ?? "",
    ":success_criteria": s.planning?.successCriteria ?? "",
    ":proof_level": s.planning?.proofLevel ?? "",
    ":integration_closure": s.planning?.integrationClosure ?? "",
    ":observability_impact": s.planning?.observabilityImpact ?? "",
    ":sequence": s.sequence ?? 0,
    ":is_sketch": s.isSketch ? 1 : 0,
    ":sketch_scope": s.sketchScope ?? "",
    // Raw sentinel params: NULL when caller omitted the field, used in ON CONFLICT guards
    ":raw_title": s.title ?? null,
    ":raw_risk": s.risk ?? null,
    ":raw_demo": s.demo ?? null,
    ":raw_goal": s.planning?.goal ?? null,
    ":raw_success_criteria": s.planning?.successCriteria ?? null,
    ":raw_proof_level": s.planning?.proofLevel ?? null,
    ":raw_integration_closure": s.planning?.integrationClosure ?? null,
    ":raw_observability_impact": s.planning?.observabilityImpact ?? null,
    ":raw_sequence": s.sequence ?? null,
    ":raw_is_sketch": s.isSketch === void 0 ? null : s.isSketch ? 1 : 0,
    // NOTE: use !== undefined (not ??) so an explicit empty string "" is treated
    // as a present value and correctly clears the existing sketch_scope on
    // CONFLICT. ?? would incorrectly preserve the stale value.
    ":raw_sketch_scope": s.sketchScope !== void 0 ? s.sketchScope : null
  });
}
function setSliceSketchFlag(milestoneId, sliceId, isSketch) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `UPDATE slices SET is_sketch = :is_sketch WHERE milestone_id = :mid AND id = :sid`
  ).run({ ":is_sketch": isSketch ? 1 : 0, ":mid": milestoneId, ":sid": sliceId });
}
function getSketchedSliceIds(milestoneId) {
  if (!currentDb) return [];
  const rows = currentDb.prepare(
    `SELECT id FROM slices WHERE milestone_id = :mid AND is_sketch = 1`
  ).all({ ":mid": milestoneId });
  return rows.map((r) => r.id);
}
function upsertSlicePlanning(milestoneId, sliceId, planning) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `UPDATE slices SET
      goal = COALESCE(:goal, goal),
      success_criteria = COALESCE(:success_criteria, success_criteria),
      proof_level = COALESCE(:proof_level, proof_level),
      integration_closure = COALESCE(:integration_closure, integration_closure),
      observability_impact = COALESCE(:observability_impact, observability_impact)
     WHERE milestone_id = :milestone_id AND id = :id`
  ).run({
    ":milestone_id": milestoneId,
    ":id": sliceId,
    ":goal": planning.goal ?? null,
    ":success_criteria": planning.successCriteria ?? null,
    ":proof_level": planning.proofLevel ?? null,
    ":integration_closure": planning.integrationClosure ?? null,
    ":observability_impact": planning.observabilityImpact ?? null
  });
}
function insertTask(t) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT INTO tasks (
      milestone_id, slice_id, id, title, status, one_liner, narrative,
      verification_result, duration, completed_at, blocker_discovered,
      deviations, known_issues, key_files, key_decisions, full_summary_md,
      description, estimate, files, verify, inputs, expected_output, observability_impact, sequence
    ) VALUES (
      :milestone_id, :slice_id, :id, :title, :status, :one_liner, :narrative,
      :verification_result, :duration, :completed_at, :blocker_discovered,
      :deviations, :known_issues, :key_files, :key_decisions, :full_summary_md,
      :description, :estimate, :files, :verify, :inputs, :expected_output, :observability_impact, :sequence
    )
    ON CONFLICT(milestone_id, slice_id, id) DO UPDATE SET
      title = CASE WHEN NULLIF(:title, '') IS NOT NULL THEN :title ELSE tasks.title END,
      status = :status,
      one_liner = :one_liner,
      narrative = :narrative,
      verification_result = :verification_result,
      duration = :duration,
      completed_at = :completed_at,
      blocker_discovered = :blocker_discovered,
      deviations = :deviations,
      known_issues = :known_issues,
      key_files = :key_files,
      key_decisions = :key_decisions,
      full_summary_md = :full_summary_md,
      description = CASE WHEN NULLIF(:description, '') IS NOT NULL THEN :description ELSE tasks.description END,
      estimate = CASE WHEN NULLIF(:estimate, '') IS NOT NULL THEN :estimate ELSE tasks.estimate END,
      files = CASE WHEN NULLIF(:files, '[]') IS NOT NULL THEN :files ELSE tasks.files END,
      verify = CASE WHEN NULLIF(:verify, '') IS NOT NULL THEN :verify ELSE tasks.verify END,
      inputs = CASE WHEN NULLIF(:inputs, '[]') IS NOT NULL THEN :inputs ELSE tasks.inputs END,
      expected_output = CASE WHEN NULLIF(:expected_output, '[]') IS NOT NULL THEN :expected_output ELSE tasks.expected_output END,
      observability_impact = CASE WHEN NULLIF(:observability_impact, '') IS NOT NULL THEN :observability_impact ELSE tasks.observability_impact END,
      sequence = :sequence`
  ).run({
    ":milestone_id": t.milestoneId,
    ":slice_id": t.sliceId,
    ":id": t.id,
    ":title": t.title ?? "",
    ":status": t.status ?? "pending",
    ":one_liner": t.oneLiner ?? "",
    ":narrative": t.narrative ?? "",
    ":verification_result": t.verificationResult ?? "",
    ":duration": t.duration ?? "",
    ":completed_at": t.status === "done" || t.status === "complete" ? (/* @__PURE__ */ new Date()).toISOString() : null,
    ":blocker_discovered": t.blockerDiscovered ? 1 : 0,
    ":deviations": t.deviations ?? "",
    ":known_issues": t.knownIssues ?? "",
    ":key_files": JSON.stringify(t.keyFiles ?? []),
    ":key_decisions": JSON.stringify(t.keyDecisions ?? []),
    ":full_summary_md": t.fullSummaryMd ?? "",
    ":description": t.planning?.description ?? "",
    ":estimate": t.planning?.estimate ?? "",
    ":files": JSON.stringify(t.planning?.files ?? []),
    ":verify": t.planning?.verify ?? "",
    ":inputs": JSON.stringify(t.planning?.inputs ?? []),
    ":expected_output": JSON.stringify(t.planning?.expectedOutput ?? []),
    ":observability_impact": t.planning?.observabilityImpact ?? "",
    ":sequence": t.sequence ?? 0
  });
}
function updateTaskStatus(milestoneId, sliceId, taskId, status, completedAt) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `UPDATE tasks SET status = :status, completed_at = :completed_at
     WHERE milestone_id = :milestone_id AND slice_id = :slice_id AND id = :id`
  ).run({
    ":status": status,
    ":completed_at": completedAt ?? null,
    ":milestone_id": milestoneId,
    ":slice_id": sliceId,
    ":id": taskId
  });
}
function setTaskBlockerDiscovered(milestoneId, sliceId, taskId, discovered) {
  if (!currentDb) return;
  currentDb.prepare(
    `UPDATE tasks SET blocker_discovered = :discovered WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid`
  ).run({ ":discovered": discovered ? 1 : 0, ":mid": milestoneId, ":sid": sliceId, ":tid": taskId });
}
function upsertTaskPlanning(milestoneId, sliceId, taskId, planning) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `UPDATE tasks SET
      title = COALESCE(:title, title),
      description = COALESCE(:description, description),
      estimate = COALESCE(:estimate, estimate),
      files = COALESCE(:files, files),
      verify = COALESCE(:verify, verify),
      inputs = COALESCE(:inputs, inputs),
      expected_output = COALESCE(:expected_output, expected_output),
      observability_impact = COALESCE(:observability_impact, observability_impact),
      full_plan_md = COALESCE(:full_plan_md, full_plan_md)
     WHERE milestone_id = :milestone_id AND slice_id = :slice_id AND id = :id`
  ).run({
    ":milestone_id": milestoneId,
    ":slice_id": sliceId,
    ":id": taskId,
    ":title": planning.title ?? null,
    ":description": planning.description ?? null,
    ":estimate": planning.estimate ?? null,
    ":files": planning.files ? JSON.stringify(planning.files) : null,
    ":verify": planning.verify ?? null,
    ":inputs": planning.inputs ? JSON.stringify(planning.inputs) : null,
    ":expected_output": planning.expectedOutput ? JSON.stringify(planning.expectedOutput) : null,
    ":observability_impact": planning.observabilityImpact ?? null,
    ":full_plan_md": planning.fullPlanMd ?? null
  });
}
function getSlice(milestoneId, sliceId) {
  if (!currentDb) return null;
  const row = currentDb.prepare("SELECT * FROM slices WHERE milestone_id = :mid AND id = :sid").get({ ":mid": milestoneId, ":sid": sliceId });
  if (!row) return null;
  return rowToSlice(row);
}
function updateSliceStatus(milestoneId, sliceId, status, completedAt) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `UPDATE slices SET status = :status, completed_at = :completed_at
     WHERE milestone_id = :milestone_id AND id = :id`
  ).run({
    ":status": status,
    ":completed_at": completedAt ?? null,
    ":milestone_id": milestoneId,
    ":id": sliceId
  });
}
function setTaskSummaryMd(milestoneId, sliceId, taskId, md) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `UPDATE tasks SET full_summary_md = :md WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid`
  ).run({ ":mid": milestoneId, ":sid": sliceId, ":tid": taskId, ":md": md });
}
function setSliceSummaryMd(milestoneId, sliceId, summaryMd, uatMd) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `UPDATE slices SET full_summary_md = :summary_md, full_uat_md = :uat_md WHERE milestone_id = :mid AND id = :sid`
  ).run({ ":mid": milestoneId, ":sid": sliceId, ":summary_md": summaryMd, ":uat_md": uatMd });
}
function getTask(milestoneId, sliceId, taskId) {
  if (!currentDb) return null;
  const row = currentDb.prepare(
    "SELECT * FROM tasks WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid"
  ).get({ ":mid": milestoneId, ":sid": sliceId, ":tid": taskId });
  if (!row) return null;
  return rowToTask(row);
}
function getSliceTasks(milestoneId, sliceId) {
  if (!currentDb) return [];
  const rows = currentDb.prepare(
    "SELECT * FROM tasks WHERE milestone_id = :mid AND slice_id = :sid ORDER BY sequence, id"
  ).all({ ":mid": milestoneId, ":sid": sliceId });
  return rows.map(rowToTask);
}
function getCompletedMilestoneTaskFileHints(milestoneId) {
  if (!currentDb) return [];
  const rows = currentDb.prepare(
    `SELECT files, key_files
     FROM tasks
     WHERE milestone_id = :mid AND status IN ('complete', 'done')`
  ).all({ ":mid": milestoneId });
  const hints = /* @__PURE__ */ new Set();
  for (const row of rows) {
    for (const raw of [row["files"], row["key_files"]]) {
      for (const file of parseStringArrayColumn(raw)) {
        const normalized = normalizeRepoPath(file);
        if (normalized) hints.add(normalized);
      }
    }
  }
  return [...hints];
}
function parseStringArrayColumn(raw) {
  if (Array.isArray(raw)) return raw.filter((entry) => typeof entry === "string");
  if (typeof raw !== "string") return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.filter((entry) => typeof entry === "string");
    if (typeof parsed === "string") return [parsed];
  } catch {
    return trimmed.split(",");
  }
  return [];
}
function normalizeRepoPath(file) {
  return file.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
}
function setTaskEscalationPending(milestoneId, sliceId, taskId, artifactPath) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `UPDATE tasks
       SET escalation_pending = 1,
           escalation_awaiting_review = 0,
           escalation_artifact_path = :path
     WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid`
  ).run({ ":path": artifactPath, ":mid": milestoneId, ":sid": sliceId, ":tid": taskId });
}
function setTaskEscalationAwaitingReview(milestoneId, sliceId, taskId, artifactPath) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `UPDATE tasks
       SET escalation_awaiting_review = 1,
           escalation_pending = 0,
           escalation_artifact_path = :path
     WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid`
  ).run({ ":path": artifactPath, ":mid": milestoneId, ":sid": sliceId, ":tid": taskId });
}
function clearTaskEscalationFlags(milestoneId, sliceId, taskId) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `UPDATE tasks
       SET escalation_pending = 0,
           escalation_awaiting_review = 0
     WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid`
  ).run({ ":mid": milestoneId, ":sid": sliceId, ":tid": taskId });
}
function claimEscalationOverride(milestoneId, sliceId, sourceTaskId) {
  if (!currentDb) return false;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const result = currentDb.prepare(
    `UPDATE tasks
       SET escalation_override_applied_at = :now
     WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid
       AND escalation_override_applied_at IS NULL
       AND escalation_artifact_path IS NOT NULL`
  ).run({ ":now": now, ":mid": milestoneId, ":sid": sliceId, ":tid": sourceTaskId });
  const changes = result.changes ?? 0;
  return changes > 0;
}
function findUnappliedEscalationOverride(milestoneId, sliceId) {
  if (!currentDb) return null;
  const row = currentDb.prepare(
    `SELECT id, escalation_artifact_path AS path
       FROM tasks
      WHERE milestone_id = :mid AND slice_id = :sid
        AND escalation_artifact_path IS NOT NULL
        AND escalation_override_applied_at IS NULL
        AND escalation_pending = 0
        AND escalation_awaiting_review = 0
      ORDER BY sequence DESC, id DESC
      LIMIT 1`
  ).get({ ":mid": milestoneId, ":sid": sliceId });
  if (!row || !row.path) return null;
  return { taskId: row.id, artifactPath: row.path };
}
function setTaskBlockerSource(milestoneId, sliceId, taskId, source) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `UPDATE tasks
       SET blocker_discovered = 1,
           blocker_source = :src
     WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid`
  ).run({ ":src": source, ":mid": milestoneId, ":sid": sliceId, ":tid": taskId });
}
function listEscalationArtifacts(milestoneId, includeResolved = false) {
  if (!currentDb) return [];
  const filter = includeResolved ? "escalation_artifact_path IS NOT NULL" : "(escalation_pending = 1 OR escalation_awaiting_review = 1) AND escalation_artifact_path IS NOT NULL";
  const rows = currentDb.prepare(
    `SELECT * FROM tasks WHERE milestone_id = :mid AND ${filter} ORDER BY slice_id, sequence, id`
  ).all({ ":mid": milestoneId });
  return rows.map(rowToTask);
}
function insertVerificationEvidence(e) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT OR IGNORE INTO verification_evidence (task_id, slice_id, milestone_id, command, exit_code, verdict, duration_ms, created_at)
     VALUES (:task_id, :slice_id, :milestone_id, :command, :exit_code, :verdict, :duration_ms, :created_at)`
  ).run({
    ":task_id": e.taskId,
    ":slice_id": e.sliceId,
    ":milestone_id": e.milestoneId,
    ":command": e.command,
    ":exit_code": e.exitCode,
    ":verdict": e.verdict,
    ":duration_ms": e.durationMs,
    ":created_at": (/* @__PURE__ */ new Date()).toISOString()
  });
}
function getVerificationEvidence(milestoneId, sliceId, taskId) {
  if (!currentDb) return [];
  const rows = currentDb.prepare(
    "SELECT * FROM verification_evidence WHERE milestone_id = :mid AND slice_id = :sid AND task_id = :tid ORDER BY id"
  ).all({ ":mid": milestoneId, ":sid": sliceId, ":tid": taskId });
  return rows;
}
function getAllMilestones() {
  if (!currentDb) return [];
  const rows = currentDb.prepare(
    "SELECT * FROM milestones ORDER BY CASE WHEN sequence > 0 THEN 0 ELSE 1 END, sequence, id"
  ).all();
  return rows.map(rowToMilestone);
}
function getMilestone(id) {
  if (!currentDb) return null;
  const row = currentDb.prepare("SELECT * FROM milestones WHERE id = :id").get({ ":id": id });
  if (!row) return null;
  return rowToMilestone(row);
}
function setMilestoneQueueOrder(order) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.exec("BEGIN IMMEDIATE");
  try {
    currentDb.prepare("UPDATE milestones SET sequence = 0").run();
    const stmt = currentDb.prepare("UPDATE milestones SET sequence = :sequence WHERE id = :id");
    order.forEach((id, index) => {
      stmt.run({ ":id": id, ":sequence": index + 1 });
    });
    currentDb.exec("COMMIT");
  } catch (err) {
    currentDb.exec("ROLLBACK");
    throw err;
  }
}
function updateMilestoneStatus(milestoneId, status, completedAt) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `UPDATE milestones SET status = :status, completed_at = :completed_at WHERE id = :id`
  ).run({ ":status": status, ":completed_at": completedAt ?? null, ":id": milestoneId });
}
function getActiveMilestoneFromDb() {
  if (!currentDb) return null;
  const row = currentDb.prepare(
    "SELECT * FROM milestones WHERE status NOT IN ('complete', 'parked') ORDER BY id LIMIT 1"
  ).get();
  if (!row) return null;
  return rowToMilestone(row);
}
function getActiveSliceFromDb(milestoneId) {
  if (!currentDb) return null;
  const row = currentDb.prepare(
    `SELECT s.* FROM slices s
     WHERE s.milestone_id = :mid
       AND s.status NOT IN ('complete', 'done', 'skipped')
       AND NOT EXISTS (
         SELECT 1 FROM json_each(s.depends) AS dep
         WHERE dep.value NOT IN (
           SELECT id FROM slices WHERE milestone_id = :mid AND status IN ('complete', 'done', 'skipped')
         )
       )
     ORDER BY s.sequence, s.id
     LIMIT 1`
  ).get({ ":mid": milestoneId });
  if (!row) return null;
  return rowToSlice(row);
}
function getActiveTaskFromDb(milestoneId, sliceId) {
  if (!currentDb) return null;
  const row = currentDb.prepare(
    "SELECT * FROM tasks WHERE milestone_id = :mid AND slice_id = :sid AND status NOT IN ('complete', 'done') ORDER BY sequence, id LIMIT 1"
  ).get({ ":mid": milestoneId, ":sid": sliceId });
  if (!row) return null;
  return rowToTask(row);
}
function getMilestoneSlices(milestoneId) {
  if (!currentDb) return [];
  const rows = currentDb.prepare("SELECT * FROM slices WHERE milestone_id = :mid ORDER BY sequence, id").all({ ":mid": milestoneId });
  return rows.map(rowToSlice);
}
function getArtifact(path) {
  if (!currentDb) return null;
  const row = currentDb.prepare("SELECT * FROM artifacts WHERE path = :path").get({ ":path": path });
  if (!row) return null;
  return rowToArtifact(row);
}
function getActiveMilestoneIdFromDb() {
  if (!currentDb) return null;
  const row = currentDb.prepare(
    "SELECT id, status FROM milestones WHERE status NOT IN ('complete', 'parked') ORDER BY id LIMIT 1"
  ).get();
  if (!row) return null;
  return rowToIdStatusSummary(row);
}
function getSliceStatusSummary(milestoneId) {
  if (!currentDb) return [];
  return currentDb.prepare(
    "SELECT id, status FROM slices WHERE milestone_id = :mid ORDER BY sequence, id"
  ).all({ ":mid": milestoneId }).map(rowToIdStatusSummary);
}
function getActiveTaskIdFromDb(milestoneId, sliceId) {
  if (!currentDb) return null;
  const row = currentDb.prepare(
    "SELECT id, status, title FROM tasks WHERE milestone_id = :mid AND slice_id = :sid AND status NOT IN ('complete', 'done') ORDER BY sequence, id LIMIT 1"
  ).get({ ":mid": milestoneId, ":sid": sliceId });
  if (!row) return null;
  return rowToActiveTaskSummary(row);
}
function getSliceTaskCounts(milestoneId, sliceId) {
  if (!currentDb) return emptyTaskStatusCounts();
  const row = currentDb.prepare(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN status IN ('complete', 'done') THEN 1 ELSE 0 END) as done,
       SUM(CASE WHEN status NOT IN ('complete', 'done') THEN 1 ELSE 0 END) as pending
     FROM tasks WHERE milestone_id = :mid AND slice_id = :sid`
  ).get({ ":mid": milestoneId, ":sid": sliceId });
  return rowToTaskStatusCounts(row);
}
function syncSliceDependencies(milestoneId, sliceId, depends) {
  if (!currentDb) return;
  currentDb.prepare(
    "DELETE FROM slice_dependencies WHERE milestone_id = :mid AND slice_id = :sid"
  ).run({ ":mid": milestoneId, ":sid": sliceId });
  for (const dep of depends) {
    currentDb.prepare(
      "INSERT OR IGNORE INTO slice_dependencies (milestone_id, slice_id, depends_on_slice_id) VALUES (:mid, :sid, :dep)"
    ).run({ ":mid": milestoneId, ":sid": sliceId, ":dep": dep });
  }
}
function getDependentSlices(milestoneId, sliceId) {
  if (!currentDb) return [];
  const rows = currentDb.prepare(
    "SELECT slice_id FROM slice_dependencies WHERE milestone_id = :mid AND depends_on_slice_id = :sid"
  ).all({ ":mid": milestoneId, ":sid": sliceId });
  return rowsToStringColumn(rows, "slice_id");
}
function copyWorktreeDb(srcDbPath, destDbPath) {
  try {
    if (!existsSync(srcDbPath)) return false;
    const destDir = dirname(destDbPath);
    mkdirSync(destDir, { recursive: true });
    copyFileSync(srcDbPath, destDbPath);
    return true;
  } catch (err) {
    logError("db", "failed to copy DB to worktree", { error: err.message });
    return false;
  }
}
function reconcileWorktreeDb(mainDbPath, worktreeDbPath) {
  const zero = { decisions: 0, requirements: 0, artifacts: 0, milestones: 0, slices: 0, tasks: 0, memories: 0, verification_evidence: 0, conflicts: [] };
  if (!existsSync(worktreeDbPath)) return zero;
  try {
    if (realpathSync(mainDbPath) === realpathSync(worktreeDbPath)) return zero;
  } catch (e) {
    logWarning("db", `realpathSync failed: ${e.message}`);
  }
  if (/['";\x00]/.test(worktreeDbPath)) {
    logError("db", "worktree DB reconciliation failed: path contains unsafe characters");
    return zero;
  }
  if (!currentDb) {
    const opened = openDatabase(mainDbPath);
    if (!opened) {
      logError("db", "worktree DB reconciliation failed: cannot open main DB");
      return zero;
    }
  }
  const adapter = currentDb;
  const conflicts = [];
  try {
    adapter.exec(`ATTACH DATABASE '${worktreeDbPath}' AS wt`);
    try {
      let countChanges2 = function(result) {
        return typeof result === "object" && result !== null ? result.changes ?? 0 : 0;
      };
      var countChanges = countChanges2;
      const wtInfo = adapter.prepare("PRAGMA wt.table_info('decisions')").all();
      const hasMadeBy = wtInfo.some((col) => col["name"] === "made_by");
      const hasDecisionSource = wtInfo.some((col) => col["name"] === "source");
      const wtMilestoneInfo = adapter.prepare("PRAGMA wt.table_info('milestones')").all();
      const hasMilestoneSequence = wtMilestoneInfo.some((col) => col["name"] === "sequence");
      const wtSliceInfo = adapter.prepare("PRAGMA wt.table_info('slices')").all();
      const hasIsSketch = wtSliceInfo.some((col) => col["name"] === "is_sketch");
      const hasSketchScope = wtSliceInfo.some((col) => col["name"] === "sketch_scope");
      const wtTaskInfo = adapter.prepare("PRAGMA wt.table_info('tasks')").all();
      const hasBlockerSource = wtTaskInfo.some((col) => col["name"] === "blocker_source");
      const hasEscalationPending = wtTaskInfo.some((col) => col["name"] === "escalation_pending");
      const hasEscalationAwaiting = wtTaskInfo.some((col) => col["name"] === "escalation_awaiting_review");
      const hasEscalationArtifact = wtTaskInfo.some((col) => col["name"] === "escalation_artifact_path");
      const hasEscalationOverride = wtTaskInfo.some((col) => col["name"] === "escalation_override_applied_at");
      const wtArtifactInfo = adapter.prepare("PRAGMA wt.table_info('artifacts')").all();
      const hasArtifactContentHash = wtArtifactInfo.some((col) => col["name"] === "content_hash");
      const wtMemoryInfo = adapter.prepare("PRAGMA wt.table_info('memories')").all();
      const hasMemoryScope = wtMemoryInfo.some((col) => col["name"] === "scope");
      const hasMemoryTags = wtMemoryInfo.some((col) => col["name"] === "tags");
      const hasMemoryStructuredFields = wtMemoryInfo.some((col) => col["name"] === "structured_fields");
      const hasMemoryLastHitAt = wtMemoryInfo.some((col) => col["name"] === "last_hit_at");
      const decConf = adapter.prepare(
        `SELECT m.id FROM decisions m INNER JOIN wt.decisions w ON m.id = w.id WHERE m.decision != w.decision OR m.choice != w.choice OR m.rationale != w.rationale OR ${hasMadeBy ? "m.made_by != w.made_by" : "'agent' != 'agent'"} OR m.superseded_by IS NOT w.superseded_by`
      ).all();
      for (const row of decConf) conflicts.push(`decision ${row["id"]}: modified in both`);
      const reqConf = adapter.prepare(
        `SELECT m.id FROM requirements m INNER JOIN wt.requirements w ON m.id = w.id WHERE m.description != w.description OR m.status != w.status OR m.notes != w.notes OR m.superseded_by IS NOT w.superseded_by`
      ).all();
      for (const row of reqConf) conflicts.push(`requirement ${row["id"]}: modified in both`);
      const merged = { decisions: 0, requirements: 0, artifacts: 0, milestones: 0, slices: 0, tasks: 0, memories: 0, verification_evidence: 0 };
      adapter.exec("BEGIN");
      try {
        merged.decisions = countChanges2(adapter.prepare(`
          INSERT OR REPLACE INTO decisions (
            id, when_context, scope, decision, choice, rationale, revisable, made_by, source, superseded_by
          )
          SELECT w.id, w.when_context, w.scope, w.decision, w.choice, w.rationale, w.revisable, ${hasMadeBy ? "w.made_by" : "COALESCE(m.made_by, 'agent')"}, ${hasDecisionSource ? "w.source" : "COALESCE(m.source, 'discussion')"}, w.superseded_by
          FROM wt.decisions w
          LEFT JOIN decisions m ON m.id = w.id
        `).run());
        merged.requirements = countChanges2(adapter.prepare(`
          INSERT OR REPLACE INTO requirements (
            id, class, status, description, why, source, primary_owner,
            supporting_slices, validation, notes, full_content, superseded_by
          )
          SELECT id, class, status, description, why, source, primary_owner,
                 supporting_slices, validation, notes, full_content, superseded_by
          FROM wt.requirements
        `).run());
        merged.artifacts = countChanges2(adapter.prepare(`
          INSERT OR REPLACE INTO artifacts (
            path, artifact_type, milestone_id, slice_id, task_id, full_content, imported_at, content_hash
          )
          SELECT w.path, w.artifact_type, w.milestone_id, w.slice_id, w.task_id, w.full_content, w.imported_at,
                 ${hasArtifactContentHash ? "w.content_hash" : "m.content_hash"}
          FROM wt.artifacts w
          LEFT JOIN artifacts m ON m.path = w.path
        `).run());
        merged.milestones = countChanges2(adapter.prepare(`
          INSERT OR REPLACE INTO milestones (
            id, title, status, depends_on, created_at, completed_at,
            vision, success_criteria, key_risks, proof_strategy,
            verification_contract, verification_integration, verification_operational, verification_uat,
            definition_of_done, requirement_coverage, boundary_map_markdown, sequence
          )
          SELECT w.id, w.title,
                 CASE
                   WHEN m.status IN ('complete', 'done') AND w.status NOT IN ('complete', 'done')
                   THEN m.status ELSE w.status
                 END,
                 w.depends_on,
                 CASE
                   WHEN m.status IN ('complete', 'done') AND w.status NOT IN ('complete', 'done')
                   THEN m.created_at ELSE w.created_at
                 END,
                 CASE
                   WHEN m.status IN ('complete', 'done') AND w.status NOT IN ('complete', 'done')
                   THEN m.completed_at ELSE w.completed_at
                 END,
                 w.vision, w.success_criteria, w.key_risks, w.proof_strategy,
                 w.verification_contract, w.verification_integration, w.verification_operational, w.verification_uat,
                 w.definition_of_done, w.requirement_coverage, w.boundary_map_markdown,
                 ${hasMilestoneSequence ? "COALESCE(w.sequence, 0)" : "COALESCE(m.sequence, 0)"}
          FROM wt.milestones w
          LEFT JOIN milestones m ON m.id = w.id
        `).run());
        merged.slices = countChanges2(adapter.prepare(`
          INSERT OR REPLACE INTO slices (
            milestone_id, id, title, status, risk, depends, demo, created_at, completed_at,
            full_summary_md, full_uat_md, goal, success_criteria, proof_level,
            integration_closure, observability_impact, sequence, replan_triggered_at,
            is_sketch, sketch_scope
          )
          SELECT w.milestone_id, w.id, w.title,
                 CASE
                   WHEN m.status IN ('complete', 'done') AND w.status NOT IN ('complete', 'done')
                   THEN m.status ELSE w.status
                 END,
                 w.risk, w.depends, w.demo, w.created_at,
                 CASE
                   WHEN m.status IN ('complete', 'done') AND w.status NOT IN ('complete', 'done')
                   THEN m.completed_at ELSE w.completed_at
                 END,
                 w.full_summary_md, w.full_uat_md, w.goal, w.success_criteria, w.proof_level,
                 w.integration_closure, w.observability_impact, w.sequence, w.replan_triggered_at,
                 ${hasIsSketch ? "w.is_sketch" : "COALESCE(m.is_sketch, 0)"},
                 ${hasSketchScope ? "w.sketch_scope" : "COALESCE(m.sketch_scope, '')"}
          FROM wt.slices w
          LEFT JOIN slices m ON m.milestone_id = w.milestone_id AND m.id = w.id
        `).run());
        merged.tasks = countChanges2(adapter.prepare(`
          INSERT OR REPLACE INTO tasks (
            milestone_id, slice_id, id, title, status, one_liner, narrative,
            verification_result, duration, completed_at, blocker_discovered,
            deviations, known_issues, key_files, key_decisions, full_summary_md,
            description, estimate, files, verify, inputs, expected_output,
            observability_impact, full_plan_md, sequence,
            blocker_source, escalation_pending, escalation_awaiting_review,
            escalation_artifact_path, escalation_override_applied_at
          )
          SELECT w.milestone_id, w.slice_id, w.id, w.title,
                 CASE
                   WHEN m.status IN ('complete', 'done') AND w.status NOT IN ('complete', 'done')
                   THEN m.status ELSE w.status
                 END,
                 w.one_liner, w.narrative,
                 w.verification_result, w.duration,
                 CASE
                   WHEN m.status IN ('complete', 'done') AND w.status NOT IN ('complete', 'done')
                   THEN m.completed_at ELSE w.completed_at
                 END,
                 w.blocker_discovered,
                 w.deviations, w.known_issues, w.key_files, w.key_decisions, w.full_summary_md,
                 w.description, w.estimate, w.files, w.verify, w.inputs, w.expected_output,
                 w.observability_impact, w.full_plan_md, w.sequence,
                 ${hasBlockerSource ? "w.blocker_source" : "COALESCE(m.blocker_source, '')"},
                 ${hasEscalationPending ? "w.escalation_pending" : "COALESCE(m.escalation_pending, 0)"},
                 ${hasEscalationAwaiting ? "w.escalation_awaiting_review" : "COALESCE(m.escalation_awaiting_review, 0)"},
                 ${hasEscalationArtifact ? "w.escalation_artifact_path" : "m.escalation_artifact_path"},
                 ${hasEscalationOverride ? "w.escalation_override_applied_at" : "m.escalation_override_applied_at"}
          FROM wt.tasks w
          LEFT JOIN tasks m ON m.milestone_id = w.milestone_id AND m.slice_id = w.slice_id AND m.id = w.id
        `).run());
        merged.memories = countChanges2(adapter.prepare(`
          INSERT OR REPLACE INTO memories (
            seq, id, category, content, confidence, source_unit_type, source_unit_id,
            created_at, updated_at, superseded_by, hit_count,
            scope, tags, structured_fields, last_hit_at
          )
          SELECT w.seq, w.id, w.category, w.content, w.confidence, w.source_unit_type, w.source_unit_id,
                 w.created_at, w.updated_at, w.superseded_by, w.hit_count,
                 ${hasMemoryScope ? "w.scope" : "COALESCE(m.scope, 'project')"},
                 ${hasMemoryTags ? "w.tags" : "COALESCE(m.tags, '[]')"},
                 ${hasMemoryStructuredFields ? "w.structured_fields" : "m.structured_fields"},
                 ${hasMemoryLastHitAt ? "w.last_hit_at" : "m.last_hit_at"}
          FROM wt.memories w
          LEFT JOIN memories m ON m.id = w.id
        `).run());
        merged.verification_evidence = countChanges2(adapter.prepare(`
          INSERT OR IGNORE INTO verification_evidence (
            task_id, slice_id, milestone_id, command, exit_code, verdict, duration_ms, created_at
          )
          SELECT task_id, slice_id, milestone_id, command, exit_code, verdict, duration_ms, created_at
          FROM wt.verification_evidence
        `).run());
        adapter.exec("COMMIT");
      } catch (txErr) {
        try {
          adapter.exec("ROLLBACK");
        } catch (e) {
          logWarning("db", `rollback failed: ${e.message}`);
        }
        throw txErr;
      }
      return { ...merged, conflicts };
    } finally {
      try {
        adapter.exec("DETACH DATABASE wt");
      } catch (e) {
        logWarning("db", `detach worktree DB failed: ${e.message}`);
      }
    }
  } catch (err) {
    logError("db", "worktree DB reconciliation failed", { error: err.message });
    return { ...zero, conflicts };
  }
}
function insertReplanHistory(entry) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT OR REPLACE INTO replan_history (milestone_id, slice_id, task_id, summary, previous_artifact_path, replacement_artifact_path, created_at)
     VALUES (:milestone_id, :slice_id, :task_id, :summary, :previous_artifact_path, :replacement_artifact_path, :created_at)`
  ).run({
    ":milestone_id": entry.milestoneId,
    ":slice_id": entry.sliceId ?? null,
    ":task_id": entry.taskId ?? null,
    ":summary": entry.summary,
    ":previous_artifact_path": entry.previousArtifactPath ?? null,
    ":replacement_artifact_path": entry.replacementArtifactPath ?? null,
    ":created_at": (/* @__PURE__ */ new Date()).toISOString()
  });
}
function insertAssessment(entry) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT OR REPLACE INTO assessments (path, milestone_id, slice_id, task_id, status, scope, full_content, created_at)
     VALUES (:path, :milestone_id, :slice_id, :task_id, :status, :scope, :full_content, :created_at)`
  ).run({
    ":path": entry.path,
    ":milestone_id": entry.milestoneId,
    ":slice_id": entry.sliceId ?? null,
    ":task_id": entry.taskId ?? null,
    ":status": entry.status,
    ":scope": entry.scope,
    ":full_content": entry.fullContent,
    ":created_at": (/* @__PURE__ */ new Date()).toISOString()
  });
}
function deleteAssessmentByScope(milestoneId, scope) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `DELETE FROM assessments WHERE milestone_id = :mid AND scope = :scope`
  ).run({ ":mid": milestoneId, ":scope": scope });
}
function deleteVerificationEvidence(milestoneId, sliceId, taskId) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `DELETE FROM verification_evidence WHERE milestone_id = :mid AND slice_id = :sid AND task_id = :tid`
  ).run({ ":mid": milestoneId, ":sid": sliceId, ":tid": taskId });
}
function deleteTask(milestoneId, sliceId, taskId) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  transaction(() => {
    currentDb.prepare(
      `DELETE FROM verification_evidence WHERE milestone_id = :mid AND slice_id = :sid AND task_id = :tid`
    ).run({ ":mid": milestoneId, ":sid": sliceId, ":tid": taskId });
    currentDb.prepare(
      `DELETE FROM quality_gates WHERE milestone_id = :mid AND slice_id = :sid AND task_id = :tid`
    ).run({ ":mid": milestoneId, ":sid": sliceId, ":tid": taskId });
    currentDb.prepare(
      `DELETE FROM tasks WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid`
    ).run({ ":mid": milestoneId, ":sid": sliceId, ":tid": taskId });
  });
}
function deleteSlice(milestoneId, sliceId) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  transaction(() => {
    currentDb.prepare(
      `DELETE FROM verification_evidence WHERE milestone_id = :mid AND slice_id = :sid`
    ).run({ ":mid": milestoneId, ":sid": sliceId });
    currentDb.prepare(
      `DELETE FROM tasks WHERE milestone_id = :mid AND slice_id = :sid`
    ).run({ ":mid": milestoneId, ":sid": sliceId });
    currentDb.prepare(
      `DELETE FROM slice_dependencies WHERE milestone_id = :mid AND slice_id = :sid`
    ).run({ ":mid": milestoneId, ":sid": sliceId });
    currentDb.prepare(
      `DELETE FROM slice_dependencies WHERE milestone_id = :mid AND depends_on_slice_id = :sid`
    ).run({ ":mid": milestoneId, ":sid": sliceId });
    currentDb.prepare(
      `DELETE FROM slices WHERE milestone_id = :mid AND id = :sid`
    ).run({ ":mid": milestoneId, ":sid": sliceId });
  });
}
function deleteMilestone(milestoneId) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  transaction(() => {
    currentDb.prepare(
      `DELETE FROM verification_evidence WHERE milestone_id = :mid`
    ).run({ ":mid": milestoneId });
    currentDb.prepare(
      `DELETE FROM quality_gates WHERE milestone_id = :mid`
    ).run({ ":mid": milestoneId });
    currentDb.prepare(
      `DELETE FROM gate_runs WHERE milestone_id = :mid`
    ).run({ ":mid": milestoneId });
    currentDb.prepare(
      `DELETE FROM tasks WHERE milestone_id = :mid`
    ).run({ ":mid": milestoneId });
    currentDb.prepare(
      `DELETE FROM slice_dependencies WHERE milestone_id = :mid`
    ).run({ ":mid": milestoneId });
    currentDb.prepare(
      `DELETE FROM slices WHERE milestone_id = :mid`
    ).run({ ":mid": milestoneId });
    currentDb.prepare(
      `DELETE FROM replan_history WHERE milestone_id = :mid`
    ).run({ ":mid": milestoneId });
    currentDb.prepare(
      `DELETE FROM assessments WHERE milestone_id = :mid`
    ).run({ ":mid": milestoneId });
    currentDb.prepare(
      `DELETE FROM artifacts WHERE milestone_id = :mid`
    ).run({ ":mid": milestoneId });
    currentDb.prepare(
      `DELETE FROM milestone_commit_attributions WHERE milestone_id = :mid`
    ).run({ ":mid": milestoneId });
    currentDb.prepare(
      `DELETE FROM milestone_leases WHERE milestone_id = :mid`
    ).run({ ":mid": milestoneId });
    currentDb.prepare(
      `DELETE FROM milestones WHERE id = :mid`
    ).run({ ":mid": milestoneId });
  });
}
function updateSliceFields(milestoneId, sliceId, fields) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `UPDATE slices SET
      title = COALESCE(:title, title),
      risk = COALESCE(:risk, risk),
      depends = COALESCE(:depends, depends),
      demo = COALESCE(:demo, demo)
     WHERE milestone_id = :milestone_id AND id = :id`
  ).run({
    ":milestone_id": milestoneId,
    ":id": sliceId,
    ":title": fields.title ?? null,
    ":risk": fields.risk ?? null,
    ":depends": fields.depends ? JSON.stringify(fields.depends) : null,
    ":demo": fields.demo ?? null
  });
}
function getReplanHistory(milestoneId, sliceId) {
  if (!currentDb) return [];
  if (sliceId) {
    return currentDb.prepare(
      `SELECT * FROM replan_history WHERE milestone_id = :mid AND slice_id = :sid ORDER BY created_at DESC`
    ).all({ ":mid": milestoneId, ":sid": sliceId });
  }
  return currentDb.prepare(
    `SELECT * FROM replan_history WHERE milestone_id = :mid ORDER BY created_at DESC`
  ).all({ ":mid": milestoneId });
}
function getAssessment(path) {
  if (!currentDb) return null;
  const row = currentDb.prepare(
    `SELECT * FROM assessments WHERE path = :path`
  ).get({ ":path": path });
  return row ?? null;
}
function getLatestAssessmentByScope(milestoneId, scope) {
  if (!currentDb) return null;
  const row = currentDb.prepare(
    `SELECT * FROM assessments
      WHERE milestone_id = :mid AND scope = :scope
      ORDER BY created_at DESC
      LIMIT 1`
  ).get({ ":mid": milestoneId, ":scope": scope });
  return row ?? null;
}
function insertGateRow(g) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT OR IGNORE INTO quality_gates (milestone_id, slice_id, gate_id, scope, task_id, status)
     VALUES (:mid, :sid, :gid, :scope, :tid, :status)`
  ).run({
    ":mid": g.milestoneId,
    ":sid": g.sliceId,
    ":gid": g.gateId,
    ":scope": g.scope,
    ":tid": g.taskId ?? "",
    ":status": g.status ?? "pending"
  });
}
function saveGateResult(g) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `UPDATE quality_gates
     SET status = 'complete', verdict = :verdict, rationale = :rationale,
         findings = :findings, evaluated_at = :evaluated_at
     WHERE milestone_id = :mid AND slice_id = :sid AND gate_id = :gid
       AND task_id = :tid`
  ).run({
    ":mid": g.milestoneId,
    ":sid": g.sliceId,
    ":gid": g.gateId,
    ":tid": g.taskId ?? "",
    ":verdict": g.verdict,
    ":rationale": g.rationale,
    ":findings": g.findings,
    ":evaluated_at": (/* @__PURE__ */ new Date()).toISOString()
  });
  const outcome = g.verdict === "pass" ? "pass" : g.verdict === "omitted" ? "manual-attention" : "fail";
  insertGateRun({
    traceId: `quality-gate:${g.milestoneId}:${g.sliceId}`,
    turnId: `gate:${g.gateId}:${g.taskId ?? "slice"}`,
    gateId: g.gateId,
    gateType: "quality-gate",
    milestoneId: g.milestoneId,
    sliceId: g.sliceId,
    taskId: g.taskId ?? void 0,
    outcome,
    failureClass: outcome === "fail" ? "verification" : outcome === "manual-attention" ? "manual-attention" : "none",
    rationale: g.rationale,
    findings: g.findings,
    attempt: 1,
    maxAttempts: 1,
    retryable: false,
    evaluatedAt: (/* @__PURE__ */ new Date()).toISOString()
  });
}
function getPendingGates(milestoneId, sliceId, scope) {
  if (!currentDb) return [];
  const sql = scope ? `SELECT * FROM quality_gates WHERE milestone_id = :mid AND slice_id = :sid AND scope = :scope AND status = 'pending'` : `SELECT * FROM quality_gates WHERE milestone_id = :mid AND slice_id = :sid AND status = 'pending'`;
  const params = { ":mid": milestoneId, ":sid": sliceId };
  if (scope) params[":scope"] = scope;
  return currentDb.prepare(sql).all(params).map(rowToGate);
}
function getGateResults(milestoneId, sliceId, scope) {
  if (!currentDb) return [];
  const sql = scope ? `SELECT * FROM quality_gates WHERE milestone_id = :mid AND slice_id = :sid AND scope = :scope` : `SELECT * FROM quality_gates WHERE milestone_id = :mid AND slice_id = :sid`;
  const params = { ":mid": milestoneId, ":sid": sliceId };
  if (scope) params[":scope"] = scope;
  return currentDb.prepare(sql).all(params).map(rowToGate);
}
function markAllGatesOmitted(milestoneId, sliceId) {
  if (!currentDb) return;
  currentDb.prepare(
    `UPDATE quality_gates SET status = 'complete', verdict = 'omitted', evaluated_at = :now
     WHERE milestone_id = :mid AND slice_id = :sid AND status = 'pending'`
  ).run({
    ":mid": milestoneId,
    ":sid": sliceId,
    ":now": (/* @__PURE__ */ new Date()).toISOString()
  });
}
function getPendingSliceGateCount(milestoneId, sliceId) {
  if (!currentDb) return 0;
  const row = currentDb.prepare(
    `SELECT COUNT(*) as cnt FROM quality_gates
     WHERE milestone_id = :mid AND slice_id = :sid AND scope = 'slice' AND status = 'pending'`
  ).get({ ":mid": milestoneId, ":sid": sliceId });
  return row ? row["cnt"] : 0;
}
function getPendingGatesForTurn(milestoneId, sliceId, turn, taskId) {
  if (!currentDb) return [];
  const ids = getGateIdsForTurn(turn);
  if (ids.size === 0) return [];
  const idList = [...ids];
  const placeholders = idList.map((_, i) => `:gid${i}`).join(",");
  const params = {
    ":mid": milestoneId,
    ":sid": sliceId
  };
  idList.forEach((id, i) => {
    params[`:gid${i}`] = id;
  });
  let sql = `SELECT * FROM quality_gates
     WHERE milestone_id = :mid AND slice_id = :sid
       AND status = 'pending'
       AND gate_id IN (${placeholders})`;
  if (taskId !== void 0) {
    sql += ` AND task_id = :tid`;
    params[":tid"] = taskId;
  }
  return currentDb.prepare(sql).all(params).map(rowToGate);
}
function getPendingGateCountForTurn(milestoneId, sliceId, turn) {
  return getPendingGatesForTurn(milestoneId, sliceId, turn).length;
}
function insertGateRun(entry) {
  if (!currentDb) return;
  currentDb.prepare(
    `INSERT INTO gate_runs (
      trace_id, turn_id, gate_id, gate_type, unit_type, unit_id, milestone_id, slice_id, task_id,
      outcome, failure_class, rationale, findings, attempt, max_attempts, retryable, evaluated_at
    ) VALUES (
      :trace_id, :turn_id, :gate_id, :gate_type, :unit_type, :unit_id, :milestone_id, :slice_id, :task_id,
      :outcome, :failure_class, :rationale, :findings, :attempt, :max_attempts, :retryable, :evaluated_at
    )`
  ).run({
    ":trace_id": entry.traceId,
    ":turn_id": entry.turnId,
    ":gate_id": entry.gateId,
    ":gate_type": entry.gateType,
    ":unit_type": entry.unitType ?? null,
    ":unit_id": entry.unitId ?? null,
    ":milestone_id": entry.milestoneId ?? null,
    ":slice_id": entry.sliceId ?? null,
    ":task_id": entry.taskId ?? null,
    ":outcome": entry.outcome,
    ":failure_class": entry.failureClass,
    ":rationale": entry.rationale ?? "",
    ":findings": entry.findings ?? "",
    ":attempt": entry.attempt,
    ":max_attempts": entry.maxAttempts,
    ":retryable": entry.retryable ? 1 : 0,
    ":evaluated_at": entry.evaluatedAt
  });
}
function upsertTurnGitTransaction(entry) {
  if (!currentDb) return;
  currentDb.prepare(
    `INSERT OR REPLACE INTO turn_git_transactions (
      trace_id, turn_id, unit_type, unit_id, stage, action, push, status, error, metadata_json, updated_at
    ) VALUES (
      :trace_id, :turn_id, :unit_type, :unit_id, :stage, :action, :push, :status, :error, :metadata_json, :updated_at
    )`
  ).run({
    ":trace_id": entry.traceId,
    ":turn_id": entry.turnId,
    ":unit_type": entry.unitType ?? null,
    ":unit_id": entry.unitId ?? null,
    ":stage": entry.stage,
    ":action": entry.action,
    ":push": entry.push ? 1 : 0,
    ":status": entry.status,
    ":error": entry.error ?? null,
    ":metadata_json": JSON.stringify(entry.metadata ?? {}),
    ":updated_at": entry.updatedAt
  });
}
function getMilestoneCommitAttributionShas(milestoneId) {
  if (!currentDb) return [];
  const rows = currentDb.prepare(
    `SELECT commit_sha
     FROM milestone_commit_attributions
     WHERE milestone_id = :mid
     ORDER BY created_at, commit_sha`
  ).all({ ":mid": milestoneId });
  return rows.map((row) => typeof row["commit_sha"] === "string" ? row["commit_sha"] : "").filter(Boolean);
}
function recordMilestoneCommitAttribution(entry) {
  if (!currentDb) return;
  transaction(() => {
    currentDb.prepare(
      `INSERT OR REPLACE INTO milestone_commit_attributions (
        commit_sha, milestone_id, slice_id, task_id, source, confidence, files_json, created_at
      ) VALUES (
        :commit_sha, :milestone_id, :slice_id, :task_id, :source, :confidence, :files_json, :created_at
      )`
    ).run({
      ":commit_sha": entry.commitSha,
      ":milestone_id": entry.milestoneId,
      ":slice_id": entry.sliceId ?? null,
      ":task_id": entry.taskId ?? null,
      ":source": entry.source,
      ":confidence": entry.confidence,
      ":files_json": JSON.stringify(entry.files),
      ":created_at": entry.createdAt
    });
    currentDb.prepare(
      `INSERT OR IGNORE INTO audit_events (
        event_id, trace_id, turn_id, caused_by, category, type, ts, payload_json
      ) VALUES (
        :event_id, :trace_id, :turn_id, :caused_by, :category, :type, :ts, :payload_json
      )`
    ).run({
      ":event_id": `milestone-commit-attribution:${entry.milestoneId}:${entry.commitSha}`,
      ":trace_id": "milestone-commit-attribution",
      ":turn_id": null,
      ":caused_by": null,
      ":category": "git",
      ":type": "milestone-commit-attribution-recorded",
      ":ts": entry.createdAt,
      ":payload_json": JSON.stringify({
        commitSha: entry.commitSha,
        milestoneId: entry.milestoneId,
        sliceId: entry.sliceId ?? null,
        taskId: entry.taskId ?? null,
        source: entry.source,
        confidence: entry.confidence,
        files: entry.files
      })
    });
  });
}
function insertAuditEvent(entry) {
  if (!currentDb) return;
  transaction(() => {
    currentDb.prepare(
      `INSERT OR IGNORE INTO audit_events (
        event_id, trace_id, turn_id, caused_by, category, type, ts, payload_json
      ) VALUES (
        :event_id, :trace_id, :turn_id, :caused_by, :category, :type, :ts, :payload_json
      )`
    ).run({
      ":event_id": entry.eventId,
      ":trace_id": entry.traceId,
      ":turn_id": entry.turnId ?? null,
      ":caused_by": entry.causedBy ?? null,
      ":category": entry.category,
      ":type": entry.type,
      ":ts": entry.ts,
      ":payload_json": JSON.stringify(entry.payload ?? {})
    });
    if (entry.turnId) {
      const row = currentDb.prepare(
        `SELECT event_count, first_ts, last_ts
         FROM audit_turn_index
         WHERE trace_id = :trace_id AND turn_id = :turn_id`
      ).get({
        ":trace_id": entry.traceId,
        ":turn_id": entry.turnId
      });
      if (row) {
        currentDb.prepare(
          `UPDATE audit_turn_index
           SET first_ts = CASE WHEN :ts < first_ts THEN :ts ELSE first_ts END,
               last_ts = CASE WHEN :ts > last_ts THEN :ts ELSE last_ts END,
               event_count = event_count + 1
           WHERE trace_id = :trace_id AND turn_id = :turn_id`
        ).run({
          ":trace_id": entry.traceId,
          ":turn_id": entry.turnId,
          ":ts": entry.ts
        });
      } else {
        currentDb.prepare(
          `INSERT INTO audit_turn_index (trace_id, turn_id, first_ts, last_ts, event_count)
           VALUES (:trace_id, :turn_id, :first_ts, :last_ts, :event_count)`
        ).run({
          ":trace_id": entry.traceId,
          ":turn_id": entry.turnId,
          ":first_ts": entry.ts,
          ":last_ts": entry.ts,
          ":event_count": 1
        });
      }
    }
  });
}
function deleteDecisionById(id) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare("DELETE FROM decisions WHERE id = :id").run({ ":id": id });
}
function deleteRequirementById(id) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare("DELETE FROM requirements WHERE id = :id").run({ ":id": id });
}
function deleteArtifactByPath(path) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare("DELETE FROM artifacts WHERE path = :path").run({ ":path": path });
}
function clearEngineHierarchy() {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  transaction(() => {
    currentDb.exec("DELETE FROM verification_evidence");
    currentDb.exec("DELETE FROM quality_gates");
    currentDb.exec("DELETE FROM slice_dependencies");
    currentDb.exec("DELETE FROM assessments");
    currentDb.exec("DELETE FROM replan_history");
    currentDb.exec("DELETE FROM milestone_commit_attributions");
    currentDb.exec("DELETE FROM tasks");
    currentDb.exec("DELETE FROM slices");
    currentDb.exec("DELETE FROM milestone_leases");
    currentDb.exec("DELETE FROM milestones");
  });
}
function insertOrIgnoreSlice(args) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT OR IGNORE INTO slices (milestone_id, id, title, status, created_at)
     VALUES (:mid, :sid, :title, 'pending', :ts)`
  ).run({
    ":mid": args.milestoneId,
    ":sid": args.sliceId,
    ":title": args.title,
    ":ts": args.createdAt
  });
}
function insertOrIgnoreTask(args) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT OR IGNORE INTO tasks (milestone_id, slice_id, id, title, status, created_at)
     VALUES (:mid, :sid, :tid, :title, 'pending', :ts)`
  ).run({
    ":mid": args.milestoneId,
    ":sid": args.sliceId,
    ":tid": args.taskId,
    ":title": args.title,
    ":ts": args.createdAt
  });
}
function setSliceReplanTriggeredAt(milestoneId, sliceId, ts) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    "UPDATE slices SET replan_triggered_at = :ts WHERE milestone_id = :mid AND id = :sid"
  ).run({ ":ts": ts, ":mid": milestoneId, ":sid": sliceId });
}
function upsertQualityGate(g) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT OR REPLACE INTO quality_gates
     (milestone_id, slice_id, gate_id, scope, task_id, status, verdict, rationale, findings, evaluated_at)
     VALUES (:mid, :sid, :gid, :scope, :tid, :status, :verdict, :rationale, :findings, :evaluated_at)`
  ).run({
    ":mid": g.milestoneId,
    ":sid": g.sliceId,
    ":gid": g.gateId,
    ":scope": g.scope,
    ":tid": g.taskId,
    ":status": g.status,
    ":verdict": g.verdict,
    ":rationale": g.rationale,
    ":findings": g.findings,
    ":evaluated_at": g.evaluatedAt
  });
}
function restoreManifest(manifest) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  const db = currentDb;
  transaction(() => {
    db.exec("DELETE FROM verification_evidence");
    db.exec("DELETE FROM tasks");
    db.exec("DELETE FROM slices");
    db.exec("DELETE FROM milestone_leases");
    db.exec("DELETE FROM milestones");
    db.exec("DELETE FROM decisions WHERE 1=1");
    const msStmt = db.prepare(
      `INSERT INTO milestones (id, title, status, depends_on, created_at, completed_at,
        vision, success_criteria, key_risks, proof_strategy,
        verification_contract, verification_integration, verification_operational, verification_uat,
        definition_of_done, requirement_coverage, boundary_map_markdown, sequence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const m of manifest.milestones) {
      msStmt.run(
        m.id,
        m.title,
        m.status,
        JSON.stringify(m.depends_on),
        m.created_at,
        m.completed_at,
        m.vision,
        JSON.stringify(m.success_criteria),
        JSON.stringify(m.key_risks),
        JSON.stringify(m.proof_strategy),
        m.verification_contract,
        m.verification_integration,
        m.verification_operational,
        m.verification_uat,
        JSON.stringify(m.definition_of_done),
        m.requirement_coverage,
        m.boundary_map_markdown,
        m.sequence ?? 0
      );
    }
    const slStmt = db.prepare(
      `INSERT INTO slices (milestone_id, id, title, status, risk, depends, demo,
        created_at, completed_at, full_summary_md, full_uat_md,
        goal, success_criteria, proof_level, integration_closure, observability_impact,
        sequence, replan_triggered_at, is_sketch, sketch_scope)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const s of manifest.slices) {
      slStmt.run(
        s.milestone_id,
        s.id,
        s.title,
        s.status,
        s.risk,
        JSON.stringify(s.depends),
        s.demo,
        s.created_at,
        s.completed_at,
        s.full_summary_md,
        s.full_uat_md,
        s.goal,
        s.success_criteria,
        s.proof_level,
        s.integration_closure,
        s.observability_impact,
        s.sequence,
        s.replan_triggered_at,
        s.is_sketch ?? 0,
        s.sketch_scope ?? ""
      );
    }
    const tkStmt = db.prepare(
      `INSERT INTO tasks (milestone_id, slice_id, id, title, status,
        one_liner, narrative, verification_result, duration, completed_at,
        blocker_discovered, deviations, known_issues, key_files, key_decisions,
        full_summary_md, description, estimate, files, verify,
        inputs, expected_output, observability_impact, sequence,
        blocker_source, escalation_pending, escalation_awaiting_review,
        escalation_artifact_path, escalation_override_applied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const t of manifest.tasks) {
      tkStmt.run(
        t.milestone_id,
        t.slice_id,
        t.id,
        t.title,
        t.status,
        t.one_liner,
        t.narrative,
        t.verification_result,
        t.duration,
        t.completed_at,
        t.blocker_discovered ? 1 : 0,
        t.deviations,
        t.known_issues,
        JSON.stringify(t.key_files),
        JSON.stringify(t.key_decisions),
        t.full_summary_md,
        t.description,
        t.estimate,
        JSON.stringify(t.files),
        t.verify,
        JSON.stringify(t.inputs),
        JSON.stringify(t.expected_output),
        t.observability_impact,
        t.sequence,
        t.blocker_source ?? "",
        t.escalation_pending ?? 0,
        t.escalation_awaiting_review ?? 0,
        t.escalation_artifact_path ?? null,
        t.escalation_override_applied_at ?? null
      );
    }
    const dcStmt = db.prepare(
      `INSERT INTO decisions (seq, id, when_context, scope, decision, choice, rationale, revisable, made_by, source, superseded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const d of manifest.decisions) {
      dcStmt.run(d.seq, d.id, d.when_context, d.scope, d.decision, d.choice, d.rationale, d.revisable, d.made_by, d.source ?? "discussion", d.superseded_by);
    }
    const evStmt = db.prepare(
      `INSERT INTO verification_evidence (task_id, slice_id, milestone_id, command, exit_code, verdict, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const e of manifest.verification_evidence) {
      evStmt.run(e.task_id, e.slice_id, e.milestone_id, e.command, e.exit_code, e.verdict, e.duration_ms, e.created_at);
    }
  });
}
function bulkInsertLegacyHierarchy(payload) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  const db = currentDb;
  const { milestones, slices, tasks, clearMilestoneIds, createdAt } = payload;
  if (clearMilestoneIds.length === 0) return;
  const placeholders = clearMilestoneIds.map(() => "?").join(",");
  transaction(() => {
    db.prepare(`DELETE FROM tasks WHERE milestone_id IN (${placeholders})`).run(...clearMilestoneIds);
    db.prepare(`DELETE FROM slices WHERE milestone_id IN (${placeholders})`).run(...clearMilestoneIds);
    db.prepare(`DELETE FROM milestone_leases WHERE milestone_id IN (${placeholders})`).run(...clearMilestoneIds);
    db.prepare(`DELETE FROM milestones WHERE id IN (${placeholders})`).run(...clearMilestoneIds);
    const insertMilestone2 = db.prepare(
      "INSERT INTO milestones (id, title, status, created_at) VALUES (?, ?, ?, ?)"
    );
    for (const m of milestones) {
      insertMilestone2.run(m.id, m.title, m.status, createdAt);
    }
    const insertSliceStmt = db.prepare(
      "INSERT INTO slices (id, milestone_id, title, status, risk, depends, sequence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const s of slices) {
      insertSliceStmt.run(s.id, s.milestoneId, s.title, s.status, s.risk, "[]", s.sequence, createdAt);
    }
    const insertTaskStmt = db.prepare(
      "INSERT INTO tasks (id, slice_id, milestone_id, title, description, status, estimate, files, sequence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const t of tasks) {
      insertTaskStmt.run(t.id, t.sliceId, t.milestoneId, t.title, "", t.status, "", "[]", t.sequence);
    }
  });
}
function insertMemoryRow(args) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT INTO memories (id, category, content, confidence, source_unit_type, source_unit_id, created_at, updated_at, scope, tags, structured_fields)
     VALUES (:id, :category, :content, :confidence, :source_unit_type, :source_unit_id, :created_at, :updated_at, :scope, :tags, :structured_fields)`
  ).run({
    ":id": args.id,
    ":category": args.category,
    ":content": args.content,
    ":confidence": args.confidence,
    ":source_unit_type": args.sourceUnitType,
    ":source_unit_id": args.sourceUnitId,
    ":created_at": args.createdAt,
    ":updated_at": args.updatedAt,
    ":scope": args.scope ?? "project",
    ":tags": JSON.stringify(args.tags ?? []),
    ":structured_fields": args.structuredFields == null ? null : JSON.stringify(args.structuredFields)
  });
}
function insertMemorySourceRow(args) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT OR IGNORE INTO memory_sources (id, kind, uri, title, content, content_hash, imported_at, scope, tags)
     VALUES (:id, :kind, :uri, :title, :content, :content_hash, :imported_at, :scope, :tags)`
  ).run({
    ":id": args.id,
    ":kind": args.kind,
    ":uri": args.uri,
    ":title": args.title,
    ":content": args.content,
    ":content_hash": args.contentHash,
    ":imported_at": args.importedAt,
    ":scope": args.scope ?? "project",
    ":tags": JSON.stringify(args.tags ?? [])
  });
}
function deleteMemorySourceRow(id) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  const res = currentDb.prepare("DELETE FROM memory_sources WHERE id = :id").run({ ":id": id });
  return (res?.changes ?? 0) > 0;
}
function upsertMemoryEmbedding(args) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT INTO memory_embeddings (memory_id, model, dim, vector, updated_at)
     VALUES (:memory_id, :model, :dim, :vector, :updated_at)
     ON CONFLICT(memory_id) DO UPDATE SET
       model = excluded.model,
       dim = excluded.dim,
       vector = excluded.vector,
       updated_at = excluded.updated_at`
  ).run({
    ":memory_id": args.memoryId,
    ":model": args.model,
    ":dim": args.dim,
    ":vector": args.vector,
    ":updated_at": args.updatedAt
  });
}
function deleteMemoryEmbedding(memoryId) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  const res = currentDb.prepare("DELETE FROM memory_embeddings WHERE memory_id = :id").run({ ":id": memoryId });
  return (res?.changes ?? 0) > 0;
}
function insertMemoryRelationRow(args) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT OR REPLACE INTO memory_relations (from_id, to_id, rel, confidence, created_at)
     VALUES (:from_id, :to_id, :rel, :confidence, :created_at)`
  ).run({
    ":from_id": args.fromId,
    ":to_id": args.toId,
    ":rel": args.rel,
    ":confidence": args.confidence,
    ":created_at": args.createdAt
  });
}
function deleteMemoryRelationsFor(memoryId) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare("DELETE FROM memory_relations WHERE from_id = :id OR to_id = :id").run({ ":id": memoryId });
}
function rewriteMemoryId(placeholderId, realId) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare("UPDATE memories SET id = :real_id WHERE id = :placeholder").run({
    ":real_id": realId,
    ":placeholder": placeholderId
  });
}
function updateMemoryContentRow(id, content, confidence, updatedAt) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  if (confidence != null) {
    currentDb.prepare(
      "UPDATE memories SET content = :content, confidence = :confidence, updated_at = :updated_at WHERE id = :id"
    ).run({ ":content": content, ":confidence": confidence, ":updated_at": updatedAt, ":id": id });
  } else {
    currentDb.prepare(
      "UPDATE memories SET content = :content, updated_at = :updated_at WHERE id = :id"
    ).run({ ":content": content, ":updated_at": updatedAt, ":id": id });
  }
}
function incrementMemoryHitCount(id, updatedAt) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    "UPDATE memories SET hit_count = hit_count + 1, updated_at = :updated_at, last_hit_at = :last_hit_at WHERE id = :id"
  ).run({ ":updated_at": updatedAt, ":last_hit_at": updatedAt, ":id": id });
}
function supersedeMemoryRow(oldId, newId, updatedAt) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    "UPDATE memories SET superseded_by = :new_id, updated_at = :updated_at WHERE id = :old_id"
  ).run({ ":new_id": newId, ":updated_at": updatedAt, ":old_id": oldId });
}
function markMemoryUnitProcessed(unitKey, activityFile, processedAt) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT OR IGNORE INTO memory_processed_units (unit_key, activity_file, processed_at)
     VALUES (:key, :file, :at)`
  ).run({ ":key": unitKey, ":file": activityFile, ":at": processedAt });
}
function decayMemoriesBefore(cutoffTs, now) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `UPDATE memories
     SET confidence = MAX(0.1, confidence - 0.1), updated_at = :now
     WHERE superseded_by IS NULL AND updated_at < :cutoff AND confidence > 0.1`
  ).run({ ":now": now, ":cutoff": cutoffTs });
}
function supersedeLowestRankedMemories(limit, now) {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `UPDATE memories SET superseded_by = 'CAP_EXCEEDED', updated_at = :now
     WHERE id IN (
       SELECT id FROM memories
       WHERE superseded_by IS NULL
       ORDER BY (confidence * (1.0 + hit_count * 0.1)) ASC
       LIMIT :limit
     )`
  ).run({ ":now": now, ":limit": limit });
}
export {
  SCHEMA_VERSION,
  _getAdapter,
  _getDbCache,
  _resetProvider,
  bulkInsertLegacyHierarchy,
  checkpointDatabase,
  claimEscalationOverride,
  clearArtifacts,
  clearEngineHierarchy,
  clearTaskEscalationFlags,
  closeAllDatabases,
  closeDatabase,
  closeDatabaseByWorkspace,
  copyWorktreeDb,
  decayMemoriesBefore,
  deleteArtifactByPath,
  deleteAssessmentByScope,
  deleteDecisionById,
  deleteMemoryEmbedding,
  deleteMemoryRelationsFor,
  deleteMemorySourceRow,
  deleteMilestone,
  deleteRequirementById,
  deleteSlice,
  deleteTask,
  deleteVerificationEvidence,
  findUnappliedEscalationOverride,
  getActiveDecisions,
  getActiveMilestoneFromDb,
  getActiveMilestoneIdFromDb,
  getActiveRequirements,
  getActiveSliceFromDb,
  getActiveTaskFromDb,
  getActiveTaskIdFromDb,
  getAllMilestones,
  getArtifact,
  getAssessment,
  getCompletedMilestoneTaskFileHints,
  getDbOwnerPid,
  getDbPath,
  getDbProvider,
  getDbStatus,
  getDecisionById,
  getDependentSlices,
  getGateResults,
  getLatestAssessmentByScope,
  getMilestone,
  getMilestoneCommitAttributionShas,
  getMilestoneSlices,
  getPendingGateCountForTurn,
  getPendingGates,
  getPendingGatesForTurn,
  getPendingSliceGateCount,
  getReplanHistory,
  getRequirementById,
  getRequirementCounts,
  getSketchedSliceIds,
  getSlice,
  getSliceStatusSummary,
  getSliceTaskCounts,
  getSliceTasks,
  getTask,
  getVerificationEvidence,
  incrementMemoryHitCount,
  insertArtifact,
  insertAssessment,
  insertAuditEvent,
  insertDecision,
  insertGateRow,
  insertGateRun,
  insertMemoryRelationRow,
  insertMemoryRow,
  insertMemorySourceRow,
  insertMilestone,
  insertOrIgnoreSlice,
  insertOrIgnoreTask,
  insertReplanHistory,
  insertRequirement,
  insertSlice,
  insertTask,
  insertVerificationEvidence,
  isDbAvailable,
  isInTransaction,
  isMemoriesFtsAvailable,
  listEscalationArtifacts,
  markAllGatesOmitted,
  markMemoryUnitProcessed,
  openDatabase,
  openDatabaseByScope,
  openDatabaseByWorkspace,
  readTransaction,
  reconcileWorktreeDb,
  recordMilestoneCommitAttribution,
  refreshOpenDatabaseFromDisk,
  restoreManifest,
  rewriteMemoryId,
  saveGateResult,
  setMilestoneQueueOrder,
  setSliceReplanTriggeredAt,
  setSliceSketchFlag,
  setSliceSummaryMd,
  setTaskBlockerDiscovered,
  setTaskBlockerSource,
  setTaskEscalationAwaitingReview,
  setTaskEscalationPending,
  setTaskSummaryMd,
  supersedeLowestRankedMemories,
  supersedeMemoryRow,
  syncSliceDependencies,
  transaction,
  tryCreateMemoriesFts,
  updateMemoryContentRow,
  updateMilestoneStatus,
  updateSliceFields,
  updateSliceStatus,
  updateTaskStatus,
  upsertDecision,
  upsertMemoryEmbedding,
  upsertMilestonePlanning,
  upsertQualityGate,
  upsertRequirement,
  upsertSlicePlanning,
  upsertTaskPlanning,
  upsertTurnGitTransaction,
  vacuumDatabase,
  wasDbOpenAttempted
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9nc2QtZGIudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFByb2plY3QvQXBwOiBHU0QtMlxuLy8gRmlsZSBQdXJwb3NlOiBHU0QgZGF0YWJhc2UgZmFjYWRlLCBzY2hlbWEsIG1pZ3JhdGlvbnMsIGFuZCBzaW5nbGUtd3JpdGVyIHdyaXRlIEFQSS5cbi8vIEdTRCBEYXRhYmFzZSBBYnN0cmFjdGlvbiBMYXllclxuLy8gUHJvdmlkZXMgYSBTUUxpdGUgZGF0YWJhc2Ugd2l0aCBwcm92aWRlciBmYWxsYmFjayBjaGFpbjpcbi8vICAgbm9kZTpzcWxpdGUgKGJ1aWx0LWluKSBcdTIxOTIgYmV0dGVyLXNxbGl0ZTMgKG5wbSkgXHUyMTkyIG51bGwgKHVuYXZhaWxhYmxlKVxuLy9cbi8vIEV4cG9zZXMgYSB1bmlmaWVkIHN5bmMgQVBJIGZvciBkZWNpc2lvbnMgYW5kIHJlcXVpcmVtZW50cyBzdG9yYWdlLlxuLy8gU2NoZW1hIGlzIGluaXRpYWxpemVkIG9uIGZpcnN0IG9wZW4gd2l0aCBXQUwgbW9kZSBmb3IgZmlsZS1iYWNrZWQgREJzLlxuLy9cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTaW5nbGUtd3JpdGVyIGludmFyaWFudCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbi8vIFRoaXMgZmlsZSBpcyB0aGUgT05MWSBwbGFjZSBpbiB0aGUgY29kZWJhc2UgdGhhdCBpc3N1ZXMgd3JpdGUgU1FMXG4vLyAoSU5TRVJUIC8gVVBEQVRFIC8gREVMRVRFIC8gUkVQTEFDRSAvIEJFR0lOLUNPTU1JVCB0cmFuc2FjdGlvbnMpIGFnYWluc3Rcbi8vIHRoZSBlbmdpbmUgZGF0YWJhc2UgYXQgYC5nc2QvZ3NkLmRiYC4gQWxsIG90aGVyIG1vZHVsZXMgbXVzdCBjYWxsIHRoZVxuLy8gdHlwZWQgd3JhcHBlcnMgZXhwb3J0ZWQgaGVyZS4gVGhlIHN0cnVjdHVyYWwgdGVzdFxuLy8gYHRlc3RzL3NpbmdsZS13cml0ZXItaW52YXJpYW50LnRlc3QudHNgIGZhaWxzIENJIGlmIGEgbmV3IGJ5cGFzcyBhcHBlYXJzLlxuLy9cbi8vIGBfZ2V0QWRhcHRlcigpYCBpcyByZXRhaW5lZCBmb3IgcmVhZC1vbmx5IFNFTEVDVHMgaW4gcXVlcnkgbW9kdWxlc1xuLy8gKGNvbnRleHQtc3RvcmUsIG1lbW9yeS1zdG9yZSBxdWVyaWVzLCBkb2N0b3IgY2hlY2tzLCBwcm9qZWN0aW9ucykuXG4vLyBEbyBOT1QgdXNlIGl0IGZvciB3cml0ZXMgXHUyMDE0IGFkZCBhIHdyYXBwZXIgaGVyZSBpbnN0ZWFkLlxuLy9cbi8vIFRoZSBzZXBhcmF0ZSBgLmdzZC91bml0LWNsYWltcy5kYmAgbWFuYWdlZCBieSBgdW5pdC1vd25lcnNoaXAudHNgIGlzIGFuXG4vLyBpbnRlbnRpb25hbGx5IGluZGVwZW5kZW50IHN0b3JlIGZvciBjcm9zcy13b3JrdHJlZSBjbGFpbSByYWNlcyBhbmQgaXNcbi8vIGV4Y2x1ZGVkIGZyb20gdGhpcyBpbnZhcmlhbnQuXG5cbmltcG9ydCB7IGNyZWF0ZVJlcXVpcmUgfSBmcm9tIFwibm9kZTptb2R1bGVcIjtcbmltcG9ydCB7IGNyZWF0ZUhhc2ggfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMsIGNvcHlGaWxlU3luYywgbWtkaXJTeW5jLCByZWFscGF0aFN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgZGlybmFtZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB0eXBlIHsgRGVjaXNpb24sIFJlcXVpcmVtZW50LCBHYXRlUm93LCBHYXRlSWQsIEdhdGVTY29wZSwgR2F0ZVN0YXR1cywgR2F0ZVZlcmRpY3QgfSBmcm9tIFwiLi90eXBlcy5qc1wiO1xuaW1wb3J0IHsgR1NERXJyb3IsIEdTRF9TVEFMRV9TVEFURSB9IGZyb20gXCIuL2Vycm9ycy5qc1wiO1xuaW1wb3J0IHR5cGUgeyBHc2RXb3Jrc3BhY2UsIE1pbGVzdG9uZVNjb3BlIH0gZnJvbSBcIi4vd29ya3NwYWNlLmpzXCI7XG5pbXBvcnQgeyBnZXRHYXRlSWRzRm9yVHVybiwgdHlwZSBPd25lclR1cm4gfSBmcm9tIFwiLi9nYXRlLXJlZ2lzdHJ5LmpzXCI7XG5pbXBvcnQgeyBsb2dFcnJvciwgbG9nV2FybmluZyB9IGZyb20gXCIuL3dvcmtmbG93LWxvZ2dlci5qc1wiO1xuaW1wb3J0IHsgY3JlYXRlRGJBZGFwdGVyLCB0eXBlIERiQWRhcHRlciB9IGZyb20gXCIuL2RiLWFkYXB0ZXIuanNcIjtcbmltcG9ydCB7IGNyZWF0ZUJhc2VTY2hlbWFPYmplY3RzIH0gZnJvbSBcIi4vZGItYmFzZS1zY2hlbWEuanNcIjtcbmltcG9ydCB7IGNyZWF0ZUNvb3JkaW5hdGlvblRhYmxlc1YyNCB9IGZyb20gXCIuL2RiLWNvb3JkaW5hdGlvbi1zY2hlbWEuanNcIjtcbmltcG9ydCB7IGNyZWF0ZURiQ29ubmVjdGlvbkNhY2hlLCB0eXBlIERiQ29ubmVjdGlvbkNhY2hlRW50cnkgfSBmcm9tIFwiLi9kYi1jb25uZWN0aW9uLWNhY2hlLmpzXCI7XG5pbXBvcnQge1xuICBlbXB0eVRhc2tTdGF0dXNDb3VudHMsXG4gIHJvd1RvQWN0aXZlVGFza1N1bW1hcnksXG4gIHJvd1RvSWRTdGF0dXNTdW1tYXJ5LFxuICByb3dUb1Rhc2tTdGF0dXNDb3VudHMsXG4gIHJvd3NUb1N0cmluZ0NvbHVtbixcbiAgdHlwZSBBY3RpdmVUYXNrU3VtbWFyeSxcbiAgdHlwZSBJZFN0YXR1c1N1bW1hcnksXG4gIHR5cGUgVGFza1N0YXR1c0NvdW50cyxcbn0gZnJvbSBcIi4vZGItbGlnaHR3ZWlnaHQtcXVlcnktcm93cy5qc1wiO1xuaW1wb3J0IHtcbiAgcm93VG9BY3RpdmVEZWNpc2lvbixcbiAgcm93VG9BY3RpdmVSZXF1aXJlbWVudCxcbiAgcm93VG9EZWNpc2lvbixcbiAgcm93VG9SZXF1aXJlbWVudCxcbiAgcm93c1RvUmVxdWlyZW1lbnRDb3VudHMsXG59IGZyb20gXCIuL2RiLWRlY2lzaW9uLXJlcXVpcmVtZW50LXJvd3MuanNcIjtcbmltcG9ydCB7IHJvd1RvR2F0ZSB9IGZyb20gXCIuL2RiLWdhdGUtcm93cy5qc1wiO1xuaW1wb3J0IHsgcm93VG9BcnRpZmFjdCwgcm93VG9NaWxlc3RvbmUsIHR5cGUgQXJ0aWZhY3RSb3csIHR5cGUgTWlsZXN0b25lUm93IH0gZnJvbSBcIi4vZGItbWlsZXN0b25lLWFydGlmYWN0LXJvd3MuanNcIjtcbmltcG9ydCB7IGJhY2t1cERhdGFiYXNlQmVmb3JlTWlncmF0aW9uIH0gZnJvbSBcIi4vZGItbWlncmF0aW9uLWJhY2t1cC5qc1wiO1xuaW1wb3J0IHtcbiAgYXBwbHlNaWdyYXRpb25WMkFydGlmYWN0cyxcbiAgYXBwbHlNaWdyYXRpb25WM01lbW9yaWVzLFxuICBhcHBseU1pZ3JhdGlvblY0RGVjaXNpb25NYWRlQnksXG4gIGFwcGx5TWlncmF0aW9uVjVIaWVyYXJjaHlUYWJsZXMsXG4gIGFwcGx5TWlncmF0aW9uVjZTbGljZVN1bW1hcmllcyxcbiAgYXBwbHlNaWdyYXRpb25WN0RlcGVuZGVuY2llcyxcbiAgYXBwbHlNaWdyYXRpb25WOFBsYW5uaW5nRmllbGRzLFxuICBhcHBseU1pZ3JhdGlvblY5T3JkZXJpbmcsXG4gIGFwcGx5TWlncmF0aW9uVjEwUmVwbGFuVHJpZ2dlcixcbiAgYXBwbHlNaWdyYXRpb25WMTFUYXNrUGxhbm5pbmcsXG4gIGFwcGx5TWlncmF0aW9uVjEyUXVhbGl0eUdhdGVzLFxuICBhcHBseU1pZ3JhdGlvblYxM0hvdFBhdGhJbmRleGVzLFxuICBhcHBseU1pZ3JhdGlvblYxNFNsaWNlRGVwZW5kZW5jaWVzLFxuICBhcHBseU1pZ3JhdGlvblYxNUF1ZGl0VGFibGVzLFxuICBhcHBseU1pZ3JhdGlvblYxNkVzY2FsYXRpb25Tb3VyY2UsXG4gIGFwcGx5TWlncmF0aW9uVjE3VGFza0VzY2FsYXRpb24sXG4gIGFwcGx5TWlncmF0aW9uVjE4TWVtb3J5U291cmNlcyxcbiAgYXBwbHlNaWdyYXRpb25WMTlNZW1vcnlGdHMsXG4gIGFwcGx5TWlncmF0aW9uVjIwTWVtb3J5UmVsYXRpb25zLFxuICBhcHBseU1pZ3JhdGlvblYyMVN0cnVjdHVyZWRNZW1vcmllcyxcbiAgYXBwbHlNaWdyYXRpb25WMjJRdWFsaXR5R2F0ZVJlcGFpcixcbiAgYXBwbHlNaWdyYXRpb25WMjNNaWxlc3RvbmVRdWV1ZSxcbiAgYXBwbHlNaWdyYXRpb25WMjZNaWxlc3RvbmVDb21taXRBdHRyaWJ1dGlvbnMsXG4gIGFwcGx5TWlncmF0aW9uVjI3QXJ0aWZhY3RIYXNoLFxuICBhcHBseU1pZ3JhdGlvblYyOE1lbW9yeUxhc3RIaXRBdCxcbn0gZnJvbSBcIi4vZGItbWlncmF0aW9uLXN0ZXBzLmpzXCI7XG5pbXBvcnQgeyBpc01lbW9yaWVzRnRzQXZhaWxhYmxlU2NoZW1hLCB0cnlDcmVhdGVNZW1vcmllc0Z0c1NjaGVtYSB9IGZyb20gXCIuL2RiLW1lbW9yeS1mdHMtc2NoZW1hLmpzXCI7XG5pbXBvcnQgeyBjcmVhdGVEYk9wZW5TdGF0ZSwgdHlwZSBEYk9wZW5QaGFzZSB9IGZyb20gXCIuL2RiLW9wZW4tc3RhdGUuanNcIjtcbmltcG9ydCB7IGNyZWF0ZVJ1bnRpbWVLdlRhYmxlVjI1IH0gZnJvbSBcIi4vZGItcnVudGltZS1rdi1zY2hlbWEuanNcIjtcbmltcG9ydCB7IGVuc3VyZUNvbHVtbiwgZ2V0Q3VycmVudFNjaGVtYVZlcnNpb24sIHJlY29yZFNjaGVtYVZlcnNpb24gfSBmcm9tIFwiLi9kYi1zY2hlbWEtbWV0YWRhdGEuanNcIjtcbmltcG9ydCB7IHJvd1RvU2xpY2UsIHJvd1RvVGFzaywgdHlwZSBTbGljZVJvdywgdHlwZSBUYXNrUm93IH0gZnJvbSBcIi4vZGItdGFzay1zbGljZS1yb3dzLmpzXCI7XG5pbXBvcnQgeyBjcmVhdGVEYlRyYW5zYWN0aW9uUnVubmVyIH0gZnJvbSBcIi4vZGItdHJhbnNhY3Rpb24uanNcIjtcbmltcG9ydCB7IGVuc3VyZVZlcmlmaWNhdGlvbkV2aWRlbmNlRGVkdXBJbmRleCB9IGZyb20gXCIuL2RiLXZlcmlmaWNhdGlvbi1ldmlkZW5jZS1zY2hlbWEuanNcIjtcbmltcG9ydCB7IGNyZWF0ZVNxbGl0ZVByb3ZpZGVyTG9hZGVyLCBzdXBwcmVzc1NxbGl0ZVdhcm5pbmcsIHR5cGUgRGJQcm92aWRlck5hbWUsIHR5cGUgU3FsaXRlRmFsbGJhY2tPcGVuIH0gZnJvbSBcIi4vZGItcHJvdmlkZXIuanNcIjtcbi8vIFR5cGUtb25seSBpbXBvcnQgdG8gYXZvaWQgYSBjaXJjdWxhciBydW50aW1lIGRlcC4gVGhlIHJ1bnRpbWUgc2lkZSBvZlxuLy8gd29ya2Zsb3ctbWFuaWZlc3QudHMgZGVwZW5kcyBvbiB0aGlzIGZpbGUsIGJ1dCB0aGUgU3RhdGVNYW5pZmVzdCB0eXBlIGlzXG4vLyBwdXJlIHN0cnVjdHVyZSB3aXRoIG5vIHJ1bnRpbWUgY291cGxpbmcuXG5pbXBvcnQgdHlwZSB7IFN0YXRlTWFuaWZlc3QgfSBmcm9tIFwiLi93b3JrZmxvdy1tYW5pZmVzdC5qc1wiO1xuXG5jb25zdCBfcmVxdWlyZSA9IGNyZWF0ZVJlcXVpcmUoaW1wb3J0Lm1ldGEudXJsKTtcbnR5cGUgUHJvdmlkZXJOYW1lID0gRGJQcm92aWRlck5hbWU7XG5cbmV4cG9ydCB0eXBlIHsgQXJ0aWZhY3RSb3csIE1pbGVzdG9uZVJvdyB9IGZyb20gXCIuL2RiLW1pbGVzdG9uZS1hcnRpZmFjdC1yb3dzLmpzXCI7XG5leHBvcnQgdHlwZSB7IEFjdGl2ZVRhc2tTdW1tYXJ5LCBJZFN0YXR1c1N1bW1hcnksIFRhc2tTdGF0dXNDb3VudHMgfSBmcm9tIFwiLi9kYi1saWdodHdlaWdodC1xdWVyeS1yb3dzLmpzXCI7XG5leHBvcnQgdHlwZSB7IFNsaWNlUm93LCBUYXNrUm93IH0gZnJvbSBcIi4vZGItdGFzay1zbGljZS1yb3dzLmpzXCI7XG5cbmNvbnN0IHByb3ZpZGVyTG9hZGVyID0gY3JlYXRlU3FsaXRlUHJvdmlkZXJMb2FkZXIoe1xuICByZXF1aXJlTW9kdWxlOiAoaWQ6IHN0cmluZykgPT4gX3JlcXVpcmUoaWQpLFxuICBzdXBwcmVzc1NxbGl0ZVdhcm5pbmcsXG4gIG5vZGVWZXJzaW9uOiBwcm9jZXNzLnZlcnNpb25zLm5vZGUsXG4gIHdyaXRlU3RkZXJyOiAobWVzc2FnZTogc3RyaW5nKSA9PiBwcm9jZXNzLnN0ZGVyci53cml0ZShtZXNzYWdlKSxcbn0pO1xuXG5leHBvcnQgY29uc3QgU0NIRU1BX1ZFUlNJT04gPSAyODtcblxuZnVuY3Rpb24gaW5pdFNjaGVtYShkYjogRGJBZGFwdGVyLCBmaWxlQmFja2VkOiBib29sZWFuKTogdm9pZCB7XG4gIGlmIChmaWxlQmFja2VkKSBkYi5leGVjKFwiUFJBR01BIGpvdXJuYWxfbW9kZT1XQUxcIik7XG4gIGlmIChmaWxlQmFja2VkKSBkYi5leGVjKFwiUFJBR01BIGJ1c3lfdGltZW91dCA9IDUwMDBcIik7XG4gIGlmIChmaWxlQmFja2VkKSBkYi5leGVjKFwiUFJBR01BIHN5bmNocm9ub3VzID0gTk9STUFMXCIpO1xuICBpZiAoZmlsZUJhY2tlZCkgZGIuZXhlYyhcIlBSQUdNQSBhdXRvX3ZhY3V1bSA9IElOQ1JFTUVOVEFMXCIpO1xuICBpZiAoZmlsZUJhY2tlZCkgZGIuZXhlYyhcIlBSQUdNQSBjYWNoZV9zaXplID0gLTgwMDBcIik7ICAgLy8gOCBNQiBwYWdlIGNhY2hlXG4gIGlmIChmaWxlQmFja2VkICYmIHByb2Nlc3MucGxhdGZvcm0gIT09IFwiZGFyd2luXCIpIGRiLmV4ZWMoXCJQUkFHTUEgbW1hcF9zaXplID0gNjcxMDg4NjRcIik7ICAvLyA2NCBNQiBtbWFwXG4gIGRiLmV4ZWMoXCJQUkFHTUEgdGVtcF9zdG9yZSA9IE1FTU9SWVwiKTtcbiAgZGIuZXhlYyhcIlBSQUdNQSBmb3JlaWduX2tleXMgPSBPTlwiKTtcblxuICBkYi5leGVjKFwiQkVHSU5cIik7XG4gIHRyeSB7XG4gICAgY3JlYXRlQmFzZVNjaGVtYU9iamVjdHMoZGIsIHtcbiAgICAgIHRyeUNyZWF0ZU1lbW9yaWVzRnRzLFxuICAgICAgZW5zdXJlVmVyaWZpY2F0aW9uRXZpZGVuY2VEZWR1cEluZGV4LFxuICAgIH0pO1xuXG4gICAgY29uc3QgZXhpc3RpbmcgPSBkYi5wcmVwYXJlKFwiU0VMRUNUIGNvdW50KCopIGFzIGNudCBGUk9NIHNjaGVtYV92ZXJzaW9uXCIpLmdldCgpO1xuICAgIGlmIChleGlzdGluZyAmJiAoZXhpc3RpbmdbXCJjbnRcIl0gYXMgbnVtYmVyKSA9PT0gMCkge1xuICAgICAgY3JlYXRlQ29vcmRpbmF0aW9uVGFibGVzVjI0KGRiKTtcbiAgICAgIGNyZWF0ZVJ1bnRpbWVLdlRhYmxlVjI1KGRiKTtcblxuICAgICAgLy8gRnJlc2ggaW5zdGFsbCBcdTIwMTQgYWxsIHRhYmxlcyBhcmUgY3JlYXRlZCBhYm92ZSB3aXRoIHRoZSBmdWxsIGN1cnJlbnQgc2NoZW1hLFxuICAgICAgLy8gc28gaXQgaXMgc2FmZSB0byBjcmVhdGUgYWxsIG1pZ3JhdGlvbi1zcGVjaWZpYyBpbmRleGVzIGhlcmUuICBGb3IgZXhpc3RpbmdcbiAgICAgIC8vIGRhdGFiYXNlcyB0aGVzZSBpbmRleGVzIGFyZSBjcmVhdGVkIGluc2lkZSB0aGUgaW5kaXZpZHVhbCBtaWdyYXRpb24gZ3VhcmRzXG4gICAgICAvLyBpbiBtaWdyYXRlU2NoZW1hKCkgYWZ0ZXIgdGhlIGNvcnJlc3BvbmRpbmcgY29sdW1ucyBoYXZlIGJlZW4gYWRkZWQuXG4gICAgICBkYi5leGVjKFwiQ1JFQVRFIElOREVYIElGIE5PVCBFWElTVFMgaWR4X3Rhc2tzX2VzY2FsYXRpb25fcGVuZGluZyBPTiB0YXNrcyhtaWxlc3RvbmVfaWQsIHNsaWNlX2lkLCBlc2NhbGF0aW9uX3BlbmRpbmcpXCIpO1xuICAgICAgZGIuZXhlYyhcIkNSRUFURSBJTkRFWCBJRiBOT1QgRVhJU1RTIGlkeF9tZW1vcmllc19zY29wZSBPTiBtZW1vcmllcyhzY29wZSlcIik7XG4gICAgICBkYi5leGVjKFwiQ1JFQVRFIElOREVYIElGIE5PVCBFWElTVFMgaWR4X21lbW9yeV9zb3VyY2VzX2tpbmQgT04gbWVtb3J5X3NvdXJjZXMoa2luZClcIik7XG4gICAgICBkYi5leGVjKFwiQ1JFQVRFIElOREVYIElGIE5PVCBFWElTVFMgaWR4X21lbW9yeV9zb3VyY2VzX3Njb3BlIE9OIG1lbW9yeV9zb3VyY2VzKHNjb3BlKVwiKTtcbiAgICAgIGRiLmV4ZWMoXCJDUkVBVEUgSU5ERVggSUYgTk9UIEVYSVNUUyBpZHhfbWVtb3J5X3JlbGF0aW9uc19mcm9tIE9OIG1lbW9yeV9yZWxhdGlvbnMoZnJvbV9pZClcIik7XG4gICAgICBkYi5leGVjKFwiQ1JFQVRFIElOREVYIElGIE5PVCBFWElTVFMgaWR4X21lbW9yeV9yZWxhdGlvbnNfdG8gT04gbWVtb3J5X3JlbGF0aW9ucyh0b19pZClcIik7XG5cbiAgICAgIHJlY29yZFNjaGVtYVZlcnNpb24oZGIsIFNDSEVNQV9WRVJTSU9OKTtcbiAgICB9XG5cbiAgICBkYi5leGVjKFwiQ09NTUlUXCIpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBkYi5leGVjKFwiUk9MTEJBQ0tcIik7XG4gICAgdGhyb3cgZXJyO1xuICB9XG5cbiAgbWlncmF0ZVNjaGVtYShkYik7XG59XG5cbi8qKlxuICogQ3JlYXRlIHRoZSBGVFM1IHZpcnR1YWwgdGFibGUgZm9yIG1lbW9yaWVzIHBsdXMgdGhlIHRyaWdnZXJzIHRoYXQga2VlcCBpdFxuICogaW4gc3luYyB3aXRoIHRoZSBiYXNlIHRhYmxlLiBGVFM1IG1heSBiZSB1bmF2YWlsYWJsZSBvbiBzdHJpcHBlZC1kb3duXG4gKiBTUUxpdGUgYnVpbGRzIFx1MjAxNCBjYWxsZXJzIHNob3VsZCB0cmVhdCBmYWlsdXJlIGFzIG5vbi1mYXRhbCBhbmQgZmFsbCBiYWNrXG4gKiB0byBMSUtFLWJhc2VkIHNjYW5zIGluIGBtZW1vcnktc3RvcmUucXVlcnlNZW1vcmllc1JhbmtlZGAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0cnlDcmVhdGVNZW1vcmllc0Z0cyhkYjogRGJBZGFwdGVyKTogYm9vbGVhbiB7XG4gIHJldHVybiB0cnlDcmVhdGVNZW1vcmllc0Z0c1NjaGVtYShkYiwge1xuICAgIG9uVW5hdmFpbGFibGU6IChtZXNzYWdlKSA9PiBsb2dXYXJuaW5nKFwiZGJcIiwgbWVzc2FnZSksXG4gIH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaXNNZW1vcmllc0Z0c0F2YWlsYWJsZShkYjogRGJBZGFwdGVyKTogYm9vbGVhbiB7XG4gIHJldHVybiBpc01lbW9yaWVzRnRzQXZhaWxhYmxlU2NoZW1hKGRiKTtcbn1cblxuZnVuY3Rpb24gYmFja2ZpbGxNZW1vcmllc0Z0cyhkYjogRGJBZGFwdGVyKTogdm9pZCB7XG4gIGRiLmV4ZWMoYElOU0VSVCBJTlRPIG1lbW9yaWVzX2Z0cyhyb3dpZCwgY29udGVudCkgU0VMRUNUIHNlcSwgY29udGVudCBGUk9NIG1lbW9yaWVzYCk7XG59XG5cbmZ1bmN0aW9uIGNvcHlRdWFsaXR5R2F0ZVJvd3NUb1JlcGFpcmVkVGFibGUoZGI6IERiQWRhcHRlcik6IHZvaWQge1xuICBkYi5leGVjKGBcbiAgICBJTlNFUlQgT1IgSUdOT1JFIElOVE8gcXVhbGl0eV9nYXRlc19uZXdcbiAgICAgIChtaWxlc3RvbmVfaWQsIHNsaWNlX2lkLCBnYXRlX2lkLCBzY29wZSwgdGFza19pZCwgc3RhdHVzLCB2ZXJkaWN0LCByYXRpb25hbGUsIGZpbmRpbmdzLCBldmFsdWF0ZWRfYXQpXG4gICAgU0VMRUNUIG1pbGVzdG9uZV9pZCwgc2xpY2VfaWQsIGdhdGVfaWQsIHNjb3BlLCBDT0FMRVNDRSh0YXNrX2lkLCAnJyksIHN0YXR1cywgdmVyZGljdCwgcmF0aW9uYWxlLCBmaW5kaW5ncywgZXZhbHVhdGVkX2F0XG4gICAgRlJPTSBxdWFsaXR5X2dhdGVzXG4gIGApO1xufVxuXG5mdW5jdGlvbiBtaWdyYXRlU2NoZW1hKGRiOiBEYkFkYXB0ZXIpOiB2b2lkIHtcbiAgY29uc3QgY3VycmVudFZlcnNpb24gPSBnZXRDdXJyZW50U2NoZW1hVmVyc2lvbihkYik7XG4gIGlmIChjdXJyZW50VmVyc2lvbiA+PSBTQ0hFTUFfVkVSU0lPTikgcmV0dXJuO1xuXG4gIGJhY2t1cERhdGFiYXNlQmVmb3JlTWlncmF0aW9uKGRiLCBjdXJyZW50UGF0aCwgY3VycmVudFZlcnNpb24sIHtcbiAgICBleGlzdHNTeW5jLFxuICAgIGNvcHlGaWxlU3luYyxcbiAgICBsb2dXYXJuaW5nLFxuICB9KTtcblxuICBkYi5leGVjKFwiQkVHSU5cIik7XG4gIHRyeSB7XG4gICAgaWYgKGN1cnJlbnRWZXJzaW9uIDwgMikge1xuICAgICAgYXBwbHlNaWdyYXRpb25WMkFydGlmYWN0cyhkYik7XG4gICAgICByZWNvcmRTY2hlbWFWZXJzaW9uKGRiLCAyKTtcbiAgICB9XG5cbiAgICBpZiAoY3VycmVudFZlcnNpb24gPCAzKSB7XG4gICAgICBhcHBseU1pZ3JhdGlvblYzTWVtb3JpZXMoZGIpO1xuICAgICAgcmVjb3JkU2NoZW1hVmVyc2lvbihkYiwgMyk7XG4gICAgfVxuXG4gICAgaWYgKGN1cnJlbnRWZXJzaW9uIDwgNCkge1xuICAgICAgYXBwbHlNaWdyYXRpb25WNERlY2lzaW9uTWFkZUJ5KGRiKTtcbiAgICAgIHJlY29yZFNjaGVtYVZlcnNpb24oZGIsIDQpO1xuICAgIH1cblxuICAgIGlmIChjdXJyZW50VmVyc2lvbiA8IDUpIHtcbiAgICAgIGFwcGx5TWlncmF0aW9uVjVIaWVyYXJjaHlUYWJsZXMoZGIpO1xuICAgICAgcmVjb3JkU2NoZW1hVmVyc2lvbihkYiwgNSk7XG4gICAgfVxuXG4gICAgaWYgKGN1cnJlbnRWZXJzaW9uIDwgNikge1xuICAgICAgYXBwbHlNaWdyYXRpb25WNlNsaWNlU3VtbWFyaWVzKGRiKTtcbiAgICAgIHJlY29yZFNjaGVtYVZlcnNpb24oZGIsIDYpO1xuICAgIH1cblxuICAgIGlmIChjdXJyZW50VmVyc2lvbiA8IDcpIHtcbiAgICAgIGFwcGx5TWlncmF0aW9uVjdEZXBlbmRlbmNpZXMoZGIpO1xuICAgICAgcmVjb3JkU2NoZW1hVmVyc2lvbihkYiwgNyk7XG4gICAgfVxuXG4gICAgaWYgKGN1cnJlbnRWZXJzaW9uIDwgOCkge1xuICAgICAgYXBwbHlNaWdyYXRpb25WOFBsYW5uaW5nRmllbGRzKGRiKTtcbiAgICAgIHJlY29yZFNjaGVtYVZlcnNpb24oZGIsIDgpO1xuICAgIH1cblxuICAgIGlmIChjdXJyZW50VmVyc2lvbiA8IDkpIHtcbiAgICAgIGFwcGx5TWlncmF0aW9uVjlPcmRlcmluZyhkYik7XG4gICAgICByZWNvcmRTY2hlbWFWZXJzaW9uKGRiLCA5KTtcbiAgICB9XG5cbiAgICBpZiAoY3VycmVudFZlcnNpb24gPCAxMCkge1xuICAgICAgYXBwbHlNaWdyYXRpb25WMTBSZXBsYW5UcmlnZ2VyKGRiKTtcbiAgICAgIHJlY29yZFNjaGVtYVZlcnNpb24oZGIsIDEwKTtcbiAgICB9XG5cbiAgICBpZiAoY3VycmVudFZlcnNpb24gPCAxMSkge1xuICAgICAgYXBwbHlNaWdyYXRpb25WMTFUYXNrUGxhbm5pbmcoZGIpO1xuICAgICAgcmVjb3JkU2NoZW1hVmVyc2lvbihkYiwgMTEpO1xuICAgIH1cblxuICAgIGlmIChjdXJyZW50VmVyc2lvbiA8IDEyKSB7XG4gICAgICAvLyBOT1RFOiBUaGUgb3JpZ2luYWwgRERMIHVzZWQgQ09BTEVTQ0UodGFza19pZCwgJycpIGluIHRoZSBQUklNQVJZIEtFWVxuICAgICAgLy8gZXhwcmVzc2lvbiwgd2hpY2ggaXMgaW52YWxpZCBTUUxpdGUgc3ludGF4IGFuZCBjYXVzZXMgc3RhcnR1cCBlcnJvcnMgb25cbiAgICAgIC8vIERCcyB0aGF0IG1pZ3JhdGUgdGhyb3VnaCB2MTIuIFRoZSBjb3JyZWN0ZWQgRERMIHVzZXNcbiAgICAgIC8vIHRhc2tfaWQgVEVYVCBOT1QgTlVMTCBERUZBVUxUICcnIHdpdGggYSBwbGFpbiBjb2x1bW4gbGlzdCBQSy4gREJzIHRoYXRcbiAgICAgIC8vIHdlcmUgY3JlYXRlZCB3aXRoIHRoZSBicm9rZW4gRERMIGFyZSByZXBhaXJlZCBieSB0aGUgdjIyIG1pZ3JhdGlvbiBiZWxvdy5cbiAgICAgIGFwcGx5TWlncmF0aW9uVjEyUXVhbGl0eUdhdGVzKGRiKTtcbiAgICAgIHJlY29yZFNjaGVtYVZlcnNpb24oZGIsIDEyKTtcbiAgICB9XG5cbiAgICBpZiAoY3VycmVudFZlcnNpb24gPCAxMykge1xuICAgICAgYXBwbHlNaWdyYXRpb25WMTNIb3RQYXRoSW5kZXhlcyhkYiwgZW5zdXJlVmVyaWZpY2F0aW9uRXZpZGVuY2VEZWR1cEluZGV4KTtcbiAgICAgIHJlY29yZFNjaGVtYVZlcnNpb24oZGIsIDEzKTtcbiAgICB9XG5cbiAgICBpZiAoY3VycmVudFZlcnNpb24gPCAxNCkge1xuICAgICAgYXBwbHlNaWdyYXRpb25WMTRTbGljZURlcGVuZGVuY2llcyhkYik7XG4gICAgICByZWNvcmRTY2hlbWFWZXJzaW9uKGRiLCAxNCk7XG4gICAgfVxuXG4gICAgaWYgKGN1cnJlbnRWZXJzaW9uIDwgMTUpIHtcbiAgICAgIGFwcGx5TWlncmF0aW9uVjE1QXVkaXRUYWJsZXMoZGIpO1xuICAgICAgcmVjb3JkU2NoZW1hVmVyc2lvbihkYiwgMTUpO1xuICAgIH1cblxuICAgIGlmIChjdXJyZW50VmVyc2lvbiA8IDE2KSB7XG4gICAgICBhcHBseU1pZ3JhdGlvblYxNkVzY2FsYXRpb25Tb3VyY2UoZGIpO1xuICAgICAgcmVjb3JkU2NoZW1hVmVyc2lvbihkYiwgMTYpO1xuICAgIH1cblxuICAgIGlmIChjdXJyZW50VmVyc2lvbiA8IDE3KSB7XG4gICAgICBhcHBseU1pZ3JhdGlvblYxN1Rhc2tFc2NhbGF0aW9uKGRiKTtcbiAgICAgIHJlY29yZFNjaGVtYVZlcnNpb24oZGIsIDE3KTtcbiAgICB9XG5cbiAgICBpZiAoY3VycmVudFZlcnNpb24gPCAxOCkge1xuICAgICAgYXBwbHlNaWdyYXRpb25WMThNZW1vcnlTb3VyY2VzKGRiKTtcbiAgICAgIHJlY29yZFNjaGVtYVZlcnNpb24oZGIsIDE4KTtcbiAgICB9XG5cbiAgICBpZiAoY3VycmVudFZlcnNpb24gPCAxOSkge1xuICAgICAgYXBwbHlNaWdyYXRpb25WMTlNZW1vcnlGdHMoZGIsIHtcbiAgICAgICAgdHJ5Q3JlYXRlTWVtb3JpZXNGdHMsXG4gICAgICAgIGlzTWVtb3JpZXNGdHNBdmFpbGFibGUsXG4gICAgICAgIGJhY2tmaWxsTWVtb3JpZXNGdHMsXG4gICAgICAgIGxvZ1dhcm5pbmcsXG4gICAgICB9KTtcbiAgICAgIHJlY29yZFNjaGVtYVZlcnNpb24oZGIsIDE5KTtcbiAgICB9XG5cbiAgICBpZiAoY3VycmVudFZlcnNpb24gPCAyMCkge1xuICAgICAgYXBwbHlNaWdyYXRpb25WMjBNZW1vcnlSZWxhdGlvbnMoZGIpO1xuICAgICAgcmVjb3JkU2NoZW1hVmVyc2lvbihkYiwgMjApO1xuICAgIH1cblxuICAgIGlmIChjdXJyZW50VmVyc2lvbiA8IDIxKSB7XG4gICAgICBhcHBseU1pZ3JhdGlvblYyMVN0cnVjdHVyZWRNZW1vcmllcyhkYik7XG4gICAgICByZWNvcmRTY2hlbWFWZXJzaW9uKGRiLCAyMSk7XG4gICAgfVxuXG4gICAgaWYgKGN1cnJlbnRWZXJzaW9uIDwgMjIpIHtcbiAgICAgIGFwcGx5TWlncmF0aW9uVjIyUXVhbGl0eUdhdGVSZXBhaXIoZGIsIHsgY29weVF1YWxpdHlHYXRlUm93c1RvUmVwYWlyZWRUYWJsZSB9KTtcbiAgICAgIHJlY29yZFNjaGVtYVZlcnNpb24oZGIsIDIyKTtcbiAgICB9XG5cbiAgICBpZiAoY3VycmVudFZlcnNpb24gPCAyMykge1xuICAgICAgYXBwbHlNaWdyYXRpb25WMjNNaWxlc3RvbmVRdWV1ZShkYik7XG4gICAgICByZWNvcmRTY2hlbWFWZXJzaW9uKGRiLCAyMyk7XG4gICAgfVxuXG4gICAgaWYgKGN1cnJlbnRWZXJzaW9uIDwgMjQpIHtcbiAgICAgIC8vIHYyNDogYXV0by1tb2RlIGNvb3JkaW5hdGlvbiB0YWJsZXMuIFNlZSBjcmVhdGVDb29yZGluYXRpb25UYWJsZXNWMjRcbiAgICAgIC8vIGZvciBmdWxsIHNjaGVtYSArIGludmFyaWFudHMuIE5vLW9wIGZvciBmcmVzaCBpbnN0YWxscyAodGhlIHNhbWVcbiAgICAgIC8vIGhlbHBlciBydW5zIGluIHRoZSBmcmVzaC1pbnN0YWxsIHBhdGgpOyBmb3IgdXBncmFkZWQgREJzIHRoaXMgaXNcbiAgICAgIC8vIHRoZSBvbmx5IHBsYWNlIHRoZXNlIHRhYmxlcyBnZXQgY3JlYXRlZC5cbiAgICAgIGNyZWF0ZUNvb3JkaW5hdGlvblRhYmxlc1YyNChkYik7XG4gICAgICByZWNvcmRTY2hlbWFWZXJzaW9uKGRiLCAyNCk7XG4gICAgfVxuXG4gICAgaWYgKGN1cnJlbnRWZXJzaW9uIDwgMjUpIHtcbiAgICAgIC8vIHYyNTogcnVudGltZV9rdiBub24tY29ycmVjdG5lc3MtY3JpdGljYWwga2V5LXZhbHVlIHN0b3JhZ2UuIFNlZVxuICAgICAgLy8gY3JlYXRlUnVudGltZUt2VGFibGVWMjUgZm9yIHRoZSBmdWxsIHNjaGVtYSArIGludmFyaWFudHMuXG4gICAgICBjcmVhdGVSdW50aW1lS3ZUYWJsZVYyNShkYik7XG4gICAgICByZWNvcmRTY2hlbWFWZXJzaW9uKGRiLCAyNSk7XG4gICAgfVxuXG4gICAgaWYgKGN1cnJlbnRWZXJzaW9uIDwgMjYpIHtcbiAgICAgIGFwcGx5TWlncmF0aW9uVjI2TWlsZXN0b25lQ29tbWl0QXR0cmlidXRpb25zKGRiKTtcbiAgICAgIHJlY29yZFNjaGVtYVZlcnNpb24oZGIsIDI2KTtcbiAgICB9XG5cbiAgICBpZiAoY3VycmVudFZlcnNpb24gPCAyNykge1xuICAgICAgYXBwbHlNaWdyYXRpb25WMjdBcnRpZmFjdEhhc2goZGIpO1xuICAgICAgcmVjb3JkU2NoZW1hVmVyc2lvbihkYiwgMjcpO1xuICAgIH1cblxuICAgIGlmIChjdXJyZW50VmVyc2lvbiA8IDI4KSB7XG4gICAgICBhcHBseU1pZ3JhdGlvblYyOE1lbW9yeUxhc3RIaXRBdChkYik7XG4gICAgICByZWNvcmRTY2hlbWFWZXJzaW9uKGRiLCAyOCk7XG4gICAgfVxuXG4gICAgZGIuZXhlYyhcIkNPTU1JVFwiKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgZGIuZXhlYyhcIlJPTExCQUNLXCIpO1xuICAgIHRocm93IGVycjtcbiAgfVxufVxuXG5sZXQgY3VycmVudERiOiBEYkFkYXB0ZXIgfCBudWxsID0gbnVsbDtcbmxldCBjdXJyZW50UGF0aDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5sZXQgY3VycmVudFBpZDogbnVtYmVyID0gMDtcbmxldCBfZXhpdEhhbmRsZXJSZWdpc3RlcmVkID0gZmFsc2U7XG5jb25zdCBfZGJPcGVuU3RhdGUgPSBjcmVhdGVEYk9wZW5TdGF0ZSgpO1xuLyoqXG4gKiBJZGVudGl0eSBrZXkgb2YgdGhlIHdvcmtzcGFjZSB3aG9zZSBjb25uZWN0aW9uIGlzIGN1cnJlbnRseSBhY3RpdmVcbiAqIChjdXJyZW50RGIpLiBTZXQgYnkgb3BlbkRhdGFiYXNlQnlXb3Jrc3BhY2UoKTsgbnVsbCB3aGVuIHRoZSBhY3RpdmVcbiAqIGNvbm5lY3Rpb24gd2FzIG9wZW5lZCB2aWEgdGhlIGxlZ2FjeSBvcGVuRGF0YWJhc2UocGF0aCkgcGF0aC5cbiAqL1xubGV0IF9jdXJyZW50SWRlbnRpdHlLZXk6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG4vKipcbiAqIFdvcmtzcGFjZS1zY29wZWQgY29ubmVjdGlvbiBjYWNoZS5cbiAqIEtleTogR3NkV29ya3NwYWNlLmlkZW50aXR5S2V5IChyZWFscGF0aC1ub3JtYWxpemVkIHByb2plY3Qgcm9vdCkuXG4gKiBWYWx1ZTogdGhlIERCIHBhdGggYW5kIG9wZW4gYWRhcHRlciBmb3IgdGhhdCB3b3Jrc3BhY2UuXG4gKlxuICogU2libGluZyB3b3JrdHJlZXMgb2YgdGhlIHNhbWUgcHJvamVjdCBzaGFyZSB0aGUgc2FtZSBpZGVudGl0eUtleSAoc2V0IGJ5XG4gKiBjcmVhdGVXb3Jrc3BhY2UpIGFuZCB0aGVyZWZvcmUgcmV1c2UgdGhlIHNhbWUgY2FjaGVkIGNvbm5lY3Rpb24sIHByZXNlcnZpbmdcbiAqIHNoYXJlZC1XQUwgc2VtYW50aWNzLiBEaWZmZXJlbnQgcHJvamVjdHMgZ2V0IGRpc3RpbmN0IGNhY2hlIGVudHJpZXMuXG4gKlxuICogTk9URTogT25seSBvbmUgY29ubmVjdGlvbiBpcyBcImFjdGl2ZVwiIGF0IGEgdGltZSAoY3VycmVudERiL2N1cnJlbnRQYXRoKS5cbiAqIFRoZSBjYWNoZSBhbGxvd3MgZmFzdCByZS1hY3RpdmF0aW9uIG9mIGEgcHJldmlvdXNseSBvcGVuZWQgY29ubmVjdGlvbiB3aGVuXG4gKiBjYWxsZXJzIHN3aXRjaCBiZXR3ZWVuIGtub3duIHdvcmtzcGFjZXMgdmlhIG9wZW5EYXRhYmFzZUJ5V29ya3NwYWNlKCkuXG4gKi9cbmNvbnN0IF9kYkNhY2hlID0gY3JlYXRlRGJDb25uZWN0aW9uQ2FjaGUoKTtcblxuLyoqIFRlc3QgaGVscGVyOiBleHBvc2UgdGhlIGludGVybmFsIGNhY2hlIGZvciBpbnNwZWN0aW9uLiBOb3QgZm9yIHByb2R1Y3Rpb24gdXNlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIF9nZXREYkNhY2hlKCk6IFJlYWRvbmx5TWFwPHN0cmluZywgRGJDb25uZWN0aW9uQ2FjaGVFbnRyeT4ge1xuICByZXR1cm4gX2RiQ2FjaGUuYXNSZWFkb25seU1hcCgpO1xufVxuXG5mdW5jdGlvbiBjbG9zZUNhY2hlZENvbm5lY3Rpb24oZW50cnk6IERiQ29ubmVjdGlvbkNhY2hlRW50cnksIHNvdXJjZTogXCJhbGxcIiB8IFwid29ya3NwYWNlXCIpOiB2b2lkIHtcbiAgdHJ5IHtcbiAgICBlbnRyeS5kYi5leGVjKFwiUFJBR01BIHdhbF9jaGVja3BvaW50KFRSVU5DQVRFKVwiKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGlmIChzb3VyY2UgPT09IFwid29ya3NwYWNlXCIpIGxvZ1dhcm5pbmcoXCJkYlwiLCBgV0FMIGNoZWNrcG9pbnQgKGJ5V29ya3NwYWNlKSBmYWlsZWQ6ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gIH1cbiAgdHJ5IHtcbiAgICBlbnRyeS5kYi5leGVjKFwiUFJBR01BIGluY3JlbWVudGFsX3ZhY3V1bSg2NClcIik7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBpZiAoc291cmNlID09PSBcIndvcmtzcGFjZVwiKSBsb2dXYXJuaW5nKFwiZGJcIiwgYGluY3JlbWVudGFsIHZhY3V1bSAoYnlXb3Jrc3BhY2UpIGZhaWxlZDogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgfVxuICB0cnkge1xuICAgIGVudHJ5LmRiLmNsb3NlKCk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBpZiAoc291cmNlID09PSBcIndvcmtzcGFjZVwiKSBsb2dXYXJuaW5nKFwiZGJcIiwgYGRhdGFiYXNlIGNsb3NlIChieVdvcmtzcGFjZSkgZmFpbGVkOiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWApO1xuICB9XG59XG5cbi8qKlxuICogQ2xvc2UgYW5kIGV2aWN0IGV2ZXJ5IGVudHJ5IGluIHRoZSB3b3Jrc3BhY2UgY29ubmVjdGlvbiBjYWNoZSwgdGhlbiBjYWxsXG4gKiBjbG9zZURhdGFiYXNlKCkgdG8gY2xvc2UgdGhlIGFjdGl2ZSBjb25uZWN0aW9uLlxuICpcbiAqIFVzZSB0aGlzIGZvciB0ZXN0IHRlYXJkb3duIG9yIHByb2Nlc3Mtc2h1dGRvd24gcGF0aHMgd2hlcmUgZXZlcnkgb3BlblxuICogY29ubmVjdGlvbiBtdXN0IGJlIGZsdXNoZWQuIE5vcm1hbCBjYWxsZXJzIHNob3VsZCB1c2UgY2xvc2VEYXRhYmFzZSgpIG9yXG4gKiBjbG9zZURhdGFiYXNlQnlXb3Jrc3BhY2UoKSBpbnN0ZWFkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY2xvc2VBbGxEYXRhYmFzZXMoKTogdm9pZCB7XG4gIC8vIENsb3NlIGFsbCBub24tYWN0aXZlIGNhY2hlZCBjb25uZWN0aW9ucyBmaXJzdC5cbiAgX2RiQ2FjaGUuY2xvc2VOb25BY3RpdmUoY3VycmVudERiLCAoZW50cnkpID0+IGNsb3NlQ2FjaGVkQ29ubmVjdGlvbihlbnRyeSwgXCJhbGxcIikpO1xuICBjbG9zZURhdGFiYXNlKCk7XG59XG5cbi8qKlxuICogT3BlbiAob3IgcmV1c2UpIHRoZSBkYXRhYmFzZSBjb25uZWN0aW9uIHNjb3BlZCB0byB0aGUgZ2l2ZW4gd29ya3NwYWNlLlxuICpcbiAqIFVzZXMgd29ya3NwYWNlLmlkZW50aXR5S2V5IGFzIHRoZSBjYWNoZSBrZXksIHNvIHNpYmxpbmcgd29ya3RyZWVzIG9mIHRoZVxuICogc2FtZSBwcm9qZWN0IHJlc29sdmUgdG8gdGhlIHNhbWUgY29ubmVjdGlvbi4gT24gYSBjYWNoZSBoaXQgdGhlIGV4aXN0aW5nXG4gKiBhZGFwdGVyIGlzIHJlYWN0aXZhdGVkIGFzIHRoZSBjdXJyZW50IGNvbm5lY3Rpb24gd2l0aG91dCByZS1vcGVuaW5nIHRoZVxuICogZmlsZS4gT24gYSBjYWNoZSBtaXNzLCBkZWxlZ2F0ZXMgdG8gb3BlbkRhdGFiYXNlKCkgZm9yIHRoZSBmdWxsXG4gKiBvcGVuICsgc2NoZW1hLWluaXQgKyBtaWdyYXRpb24gZmxvdywgdGhlbiBjYWNoZXMgdGhlIHJlc3VsdC5cbiAqXG4gKiBXaGVuIHN3aXRjaGluZyB0byBhIGRpZmZlcmVudCB3b3Jrc3BhY2UsIHRoZSBwcmV2aW91c2x5IGFjdGl2ZSBjb25uZWN0aW9uXG4gKiBpcyBwcmVzZXJ2ZWQgaW4gdGhlIGNhY2hlIChub3QgY2xvc2VkKSwgc28gY2FsbGVycyBjYW4gc3dpdGNoIGJhY2sgdG8gaXRcbiAqIGNoZWFwbHkgdmlhIGEgc3Vic2VxdWVudCBvcGVuRGF0YWJhc2VCeVdvcmtzcGFjZSgpIGNhbGwuXG4gKlxuICogQHBhcmFtIHdvcmtzcGFjZSBBIEdzZFdvcmtzcGFjZSBjcmVhdGVkIGJ5IGNyZWF0ZVdvcmtzcGFjZSgpLlxuICogQHJldHVybnMgdHJ1ZSBpZiB0aGUgY29ubmVjdGlvbiBpcyBvcGVuIGFuZCByZWFkeSwgZmFsc2Ugb3RoZXJ3aXNlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gb3BlbkRhdGFiYXNlQnlXb3Jrc3BhY2Uod29ya3NwYWNlOiBHc2RXb3Jrc3BhY2UpOiBib29sZWFuIHtcbiAgY29uc3Qga2V5ID0gd29ya3NwYWNlLmlkZW50aXR5S2V5O1xuICBjb25zdCBkYlBhdGggPSB3b3Jrc3BhY2UuY29udHJhY3QucHJvamVjdERiO1xuXG4gIGNvbnN0IGNhY2hlZCA9IF9kYkNhY2hlLmdldChrZXkpO1xuICBpZiAoY2FjaGVkKSB7XG4gICAgLy8gUmVhY3RpdmF0ZSB0aGUgY2FjaGVkIGNvbm5lY3Rpb24gYXMgdGhlIGN1cnJlbnQgc2luZ2xldG9uLlxuICAgIGN1cnJlbnREYiA9IGNhY2hlZC5kYjtcbiAgICBjdXJyZW50UGF0aCA9IGNhY2hlZC5kYlBhdGg7XG4gICAgY3VycmVudFBpZCA9IHByb2Nlc3MucGlkO1xuICAgIF9kYk9wZW5TdGF0ZS5tYXJrQXR0ZW1wdGVkKCk7XG4gICAgX2N1cnJlbnRJZGVudGl0eUtleSA9IGtleTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIC8vIENhY2hlIG1pc3MgXHUyMDE0IG5lZWQgdG8gb3BlbiBhIG5ldyBjb25uZWN0aW9uLlxuICAvL1xuICAvLyBJZiB0aGVyZSBpcyBhIGN1cnJlbnRseSBhY3RpdmUgd29ya3NwYWNlIGNvbm5lY3Rpb24sIHN0YXNoIGl0IGluIHRoZVxuICAvLyBjYWNoZSB1bmRlciBpdHMgaWRlbnRpdHkga2V5IGJlZm9yZSBjYWxsaW5nIG9wZW5EYXRhYmFzZSgpLCBiZWNhdXNlXG4gIC8vIG9wZW5EYXRhYmFzZSgpIHdpbGwgY2FsbCBjbG9zZURhdGFiYXNlKCkgd2hlbiB0aGUgcGF0aCBjaGFuZ2VzICh3aGljaFxuICAvLyB3b3VsZCBkZXN0cm95IHRoZSBleGlzdGluZyBhZGFwdGVyKS4gQnkgbnVsbGluZyBvdXQgY3VycmVudERiIGZpcnN0LFxuICAvLyB3ZSBwcmV2ZW50IG9wZW5EYXRhYmFzZSgpIGZyb20gY2xvc2luZyB0aGUgbGl2ZSBhZGFwdGVyLlxuICBsZXQgb2xkRGI6IHR5cGVvZiBjdXJyZW50RGIgPSBudWxsO1xuICBsZXQgb2xkUGF0aDogdHlwZW9mIGN1cnJlbnRQYXRoID0gbnVsbDtcbiAgbGV0IG9sZFBpZDogdHlwZW9mIGN1cnJlbnRQaWQgPSAwO1xuICBsZXQgb2xkS2V5OiB0eXBlb2YgX2N1cnJlbnRJZGVudGl0eUtleSA9IG51bGw7XG5cbiAgaWYgKGN1cnJlbnREYiAhPT0gbnVsbCAmJiBfY3VycmVudElkZW50aXR5S2V5ICE9PSBudWxsKSB7XG4gICAgLy8gU25hcHNob3QgdGhlIG9sZCBnbG9iYWxzIHNvIHdlIGNhbiByZXN0b3JlIHRoZW0gb24gZmFpbHVyZS5cbiAgICBvbGREYiA9IGN1cnJlbnREYjtcbiAgICBvbGRQYXRoID0gY3VycmVudFBhdGg7XG4gICAgb2xkUGlkID0gY3VycmVudFBpZDtcbiAgICBvbGRLZXkgPSBfY3VycmVudElkZW50aXR5S2V5O1xuICAgIC8vIFNhdmUgdGhlIGN1cnJlbnQgY29ubmVjdGlvbiBzbyBpdCBzdGF5cyBhbGl2ZSBpbiB0aGUgY2FjaGUuXG4gICAgX2RiQ2FjaGUuc2V0KF9jdXJyZW50SWRlbnRpdHlLZXksIHtcbiAgICAgIGRiUGF0aDogY3VycmVudFBhdGghLFxuICAgICAgZGI6IGN1cnJlbnREYixcbiAgICB9KTtcbiAgICAvLyBEZXRhY2ggZnJvbSBnbG9iYWxzIHNvIG9wZW5EYXRhYmFzZSgpIG9wZW5zIGZyZXNoIHdpdGhvdXQgY2xvc2luZyBpdC5cbiAgICBjdXJyZW50RGIgPSBudWxsO1xuICAgIGN1cnJlbnRQYXRoID0gbnVsbDtcbiAgICBjdXJyZW50UGlkID0gMDtcbiAgICBfY3VycmVudElkZW50aXR5S2V5ID0gbnVsbDtcbiAgfVxuXG4gIC8vIFJ1biB0aGUgZnVsbCBvcGVuL3NjaGVtYS9taWdyYXRpb24gZmxvdyBmb3IgdGhlIG5ldyB3b3Jrc3BhY2UuXG4gIC8vIG9wZW5EYXRhYmFzZSgpIGNhbiB0aHJvdyBvbiBjb3JydXB0IERCIG9yIHBlcm1pc3Npb24gZXJyb3IgXHUyMDE0IGNhdGNoIHNvIHdlXG4gIC8vIGNhbiByZXN0b3JlIHRoZSBwcmV2aW91cyBjb25uZWN0aW9uIHJhdGhlciB0aGFuIGxlYXZpbmcgZ2xvYmFscyBudWxsLlxuICBsZXQgb3BlbmVkOiBib29sZWFuO1xuICB0cnkge1xuICAgIG9wZW5lZCA9IG9wZW5EYXRhYmFzZShkYlBhdGgpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICAvLyBGYWlsZWQgdG8gb3BlbiB0aGUgbmV3IERCLiBSZXN0b3JlIHRoZSBwcmV2aW91cyB3b3Jrc3BhY2UgY29ubmVjdGlvbiBzb1xuICAgIC8vIHRoZSBjYWxsZXIncyB3b3Jrc3BhY2UgcmVtYWlucyBhY3RpdmUgKGl0IGlzIHN0aWxsIHNhZmUgaW4gX2RiQ2FjaGUpLlxuICAgIGlmIChvbGREYiAhPT0gbnVsbCkge1xuICAgICAgY3VycmVudERiID0gb2xkRGI7XG4gICAgICBjdXJyZW50UGF0aCA9IG9sZFBhdGg7XG4gICAgICBjdXJyZW50UGlkID0gb2xkUGlkO1xuICAgICAgX2N1cnJlbnRJZGVudGl0eUtleSA9IG9sZEtleTtcbiAgICB9XG4gICAgdGhyb3cgZXJyO1xuICB9XG4gIGlmIChvcGVuZWQgJiYgY3VycmVudERiKSB7XG4gICAgX2RiQ2FjaGUuc2V0KGtleSwgeyBkYlBhdGgsIGRiOiBjdXJyZW50RGIgfSk7XG4gICAgX2N1cnJlbnRJZGVudGl0eUtleSA9IGtleTtcbiAgfSBlbHNlIGlmICghb3BlbmVkICYmIG9sZERiICE9PSBudWxsKSB7XG4gICAgLy8gUmVzdG9yZSB0aGUgcHJldmlvdXMgY29ubmVjdGlvbiBzbyB0aGUgY2FsbGVyJ3Mgd29ya3NwYWNlIHJlbWFpbnMgYWN0aXZlLlxuICAgIC8vIFRoZSBmYWlsZWQgYXR0ZW1wdCBsZWZ0IG5vIGxpdmUgYWRhcHRlciwgc28gdGhlIGdsb2JhbHMgc3RheWVkIG51bGwuXG4gICAgY3VycmVudERiID0gb2xkRGI7XG4gICAgY3VycmVudFBhdGggPSBvbGRQYXRoO1xuICAgIGN1cnJlbnRQaWQgPSBvbGRQaWQ7XG4gICAgX2N1cnJlbnRJZGVudGl0eUtleSA9IG9sZEtleTtcbiAgfVxuICByZXR1cm4gb3BlbmVkO1xufVxuXG4vKipcbiAqIE9wZW4gKG9yIHJldXNlKSB0aGUgZGF0YWJhc2UgY29ubmVjdGlvbiBzY29wZWQgdG8gdGhlIHdvcmtzcGFjZSBpbiBhXG4gKiBNaWxlc3RvbmVTY29wZS4gVGhpbiBkZWxlZ2F0aW9uIHRvIG9wZW5EYXRhYmFzZUJ5V29ya3NwYWNlKCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBvcGVuRGF0YWJhc2VCeVNjb3BlKHNjb3BlOiBNaWxlc3RvbmVTY29wZSk6IGJvb2xlYW4ge1xuICByZXR1cm4gb3BlbkRhdGFiYXNlQnlXb3Jrc3BhY2Uoc2NvcGUud29ya3NwYWNlKTtcbn1cblxuLyoqXG4gKiBDbG9zZSB0aGUgZGF0YWJhc2UgY29ubmVjdGlvbiBmb3IgdGhlIGdpdmVuIHdvcmtzcGFjZSBhbmQgcmVtb3ZlIGl0IGZyb21cbiAqIHRoZSBjYWNoZS4gSWYgdGhlIHdvcmtzcGFjZSdzIGNvbm5lY3Rpb24gaXMgY3VycmVudGx5IGFjdGl2ZSAoY3VycmVudERiKSxcbiAqIHBlcmZvcm1zIGEgZnVsbCBjbG9zZURhdGFiYXNlKCkgaW5jbHVkaW5nIFdBTCBjaGVja3BvaW50LiBPdGhlcndpc2Ugb25seVxuICogcmVtb3ZlcyB0aGUgY2FjaGUgZW50cnkgKHRoZSBhZGFwdGVyIHdhcyBhbHJlYWR5IHJlcGxhY2VkIGJ5IGEgbGF0ZXIgb3BlbikuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjbG9zZURhdGFiYXNlQnlXb3Jrc3BhY2Uod29ya3NwYWNlOiBHc2RXb3Jrc3BhY2UpOiB2b2lkIHtcbiAgY29uc3Qga2V5ID0gd29ya3NwYWNlLmlkZW50aXR5S2V5O1xuICBjb25zdCBjYWNoZWQgPSBfZGJDYWNoZS5nZXQoa2V5KTtcbiAgaWYgKCFjYWNoZWQpIHJldHVybjtcblxuICBfZGJDYWNoZS5kZWxldGUoa2V5KTtcblxuICBpZiAoY3VycmVudERiID09PSBjYWNoZWQuZGIpIHtcbiAgICAvLyBUaGlzIHdvcmtzcGFjZSdzIGNvbm5lY3Rpb24gaXMgdGhlIGFjdGl2ZSBvbmUgXHUyMDE0IGZ1bGwgY2xvc2UuXG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICB9IGVsc2Uge1xuICAgIC8vIENvbm5lY3Rpb24gd2FzIGRpc3BsYWNlZCBieSBhIGxhdGVyIG9wZW47IGNsb3NlIHRoZSBhZGFwdGVyIGRpcmVjdGx5LlxuICAgIGNsb3NlQ2FjaGVkQ29ubmVjdGlvbihjYWNoZWQsIFwid29ya3NwYWNlXCIpO1xuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXREYlByb3ZpZGVyKCk6IFByb3ZpZGVyTmFtZSB8IG51bGwge1xuICBwcm92aWRlckxvYWRlci5sb2FkKCk7XG4gIHJldHVybiBwcm92aWRlckxvYWRlci5nZXRQcm92aWRlck5hbWUoKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzRGJBdmFpbGFibGUoKTogYm9vbGVhbiB7XG4gIHJldHVybiBjdXJyZW50RGIgIT09IG51bGw7XG59XG5cbi8qKlxuICogUmV0dXJucyB0cnVlIGlmIG9wZW5EYXRhYmFzZSgpIGhhcyBiZWVuIGNhbGxlZCBhdCBsZWFzdCBvbmNlIHRoaXMgc2Vzc2lvbi5cbiAqIFVzZWQgdG8gZGlzdGluZ3Vpc2ggXCJEQiBub3QgeWV0IGluaXRpYWxpemVkXCIgZnJvbSBcIkRCIGdlbnVpbmVseSB1bmF2YWlsYWJsZVwiXG4gKiBzbyB0aGF0IGVhcmx5IGNhbGxlcnMgKGUuZy4gYmVmb3JlX2FnZW50X3N0YXJ0IGNvbnRleHQgaW5qZWN0aW9uKSBkb24ndFxuICogdHJpZ2dlciBhIGZhbHNlIGRlZ3JhZGVkLW1vZGUgd2FybmluZy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdhc0RiT3BlbkF0dGVtcHRlZCgpOiBib29sZWFuIHtcbiAgcmV0dXJuIF9kYk9wZW5TdGF0ZS5zbmFwc2hvdCgpLmF0dGVtcHRlZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldERiU3RhdHVzKCk6IHtcbiAgYXZhaWxhYmxlOiBib29sZWFuO1xuICBwcm92aWRlcjogUHJvdmlkZXJOYW1lIHwgbnVsbDtcbiAgYXR0ZW1wdGVkOiBib29sZWFuO1xuICBsYXN0RXJyb3I6IEVycm9yIHwgbnVsbDtcbiAgbGFzdFBoYXNlOiBEYk9wZW5QaGFzZSB8IG51bGw7XG59IHtcbiAgcHJvdmlkZXJMb2FkZXIubG9hZCgpO1xuICBjb25zdCBvcGVuU3RhdGUgPSBfZGJPcGVuU3RhdGUuc25hcHNob3QoKTtcbiAgcmV0dXJuIHtcbiAgICBhdmFpbGFibGU6IGN1cnJlbnREYiAhPT0gbnVsbCxcbiAgICBwcm92aWRlcjogcHJvdmlkZXJMb2FkZXIuZ2V0UHJvdmlkZXJOYW1lKCksXG4gICAgYXR0ZW1wdGVkOiBvcGVuU3RhdGUuYXR0ZW1wdGVkLFxuICAgIGxhc3RFcnJvcjogb3BlblN0YXRlLmxhc3RFcnJvcixcbiAgICBsYXN0UGhhc2U6IG9wZW5TdGF0ZS5sYXN0UGhhc2UsXG4gIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBvcGVuRGF0YWJhc2UocGF0aDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIF9kYk9wZW5TdGF0ZS5tYXJrQXR0ZW1wdGVkKCk7XG4gIGlmIChjdXJyZW50RGIgJiYgY3VycmVudFBhdGggIT09IHBhdGgpIGNsb3NlRGF0YWJhc2UoKTtcbiAgaWYgKGN1cnJlbnREYiAmJiBjdXJyZW50UGF0aCA9PT0gcGF0aCkgcmV0dXJuIHRydWU7XG5cbiAgLy8gUmVzZXQgZXJyb3Igc3RhdGUgb25seSB3aGVuIGEgbmV3IG9wZW4gYXR0ZW1wdCBpcyBhY3R1YWxseSBnb2luZyB0byBydW4uXG4gIF9kYk9wZW5TdGF0ZS5jbGVhckVycm9yKCk7XG5cbiAgbGV0IHJhd0RiOiB1bmtub3duO1xuICBsZXQgZmFsbGJhY2tPcGVuOiBTcWxpdGVGYWxsYmFja09wZW4gfCBudWxsID0gbnVsbDtcbiAgdHJ5IHtcbiAgICByYXdEYiA9IHByb3ZpZGVyTG9hZGVyLm9wZW5SYXcocGF0aCk7XG4gIH0gY2F0Y2ggKHByaW1hcnlFcnIpIHtcbiAgICBfZGJPcGVuU3RhdGUucmVjb3JkRXJyb3IoXCJvcGVuXCIsIHByaW1hcnlFcnIpO1xuICAgIC8vIG5vZGU6c3FsaXRlIGxvYWRlZCBidXQgZmFpbGVkIHRvIG9wZW4gdGhpcyBmaWxlIFx1MjAxNCB0cnkgYmV0dGVyLXNxbGl0ZTMgYXMgZmFsbGJhY2suXG4gICAgZmFsbGJhY2tPcGVuID0gcHJvdmlkZXJMb2FkZXIudHJ5T3BlbkJldHRlclNxbGl0ZUZhbGxiYWNrKHBhdGgpO1xuICAgIGlmIChmYWxsYmFja09wZW4pIHtcbiAgICAgIHJhd0RiID0gZmFsbGJhY2tPcGVuLnJhd0RiO1xuICAgICAgX2RiT3BlblN0YXRlLmNsZWFyRXJyb3IoKTtcbiAgICB9XG4gICAgaWYgKCFyYXdEYikgdGhyb3cgcHJpbWFyeUVycjtcbiAgfVxuICBpZiAoIXJhd0RiKSByZXR1cm4gZmFsc2U7XG5cbiAgY29uc3QgYWRhcHRlciA9IGNyZWF0ZURiQWRhcHRlcihyYXdEYik7XG4gIGNvbnN0IGZpbGVCYWNrZWQgPSBwYXRoICE9PSBcIjptZW1vcnk6XCI7XG4gIHRyeSB7XG4gICAgaW5pdFNjaGVtYShhZGFwdGVyLCBmaWxlQmFja2VkKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgLy8gQ29ycnVwdCBmcmVlbGlzdDogRERMIGZhaWxzIHdpdGggXCJtYWxmb3JtZWRcIiBidXQgVkFDVVVNIGNhbiByZWJ1aWxkLlxuICAgIC8vIEF0dGVtcHQgVkFDVVVNIHJlY292ZXJ5IGJlZm9yZSBnaXZpbmcgdXAgKHNlZSAjMjUxOSkuXG4gICAgaWYgKGZpbGVCYWNrZWQgJiYgZXJyIGluc3RhbmNlb2YgRXJyb3IgJiYgZXJyLm1lc3NhZ2U/LmluY2x1ZGVzKFwibWFsZm9ybWVkXCIpKSB7XG4gICAgICB0cnkge1xuICAgICAgICBhZGFwdGVyLmV4ZWMoXCJWQUNVVU1cIik7XG4gICAgICAgIGluaXRTY2hlbWEoYWRhcHRlciwgZmlsZUJhY2tlZCk7XG4gICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFwiZ3NkLWRiOiByZWNvdmVyZWQgY29ycnVwdCBkYXRhYmFzZSB2aWEgVkFDVVVNXFxuXCIpO1xuICAgICAgfSBjYXRjaCAocmV0cnlFcnIpIHtcbiAgICAgICAgX2RiT3BlblN0YXRlLnJlY29yZEVycm9yKFwidmFjdXVtLXJlY292ZXJ5XCIsIHJldHJ5RXJyKTtcbiAgICAgICAgdHJ5IHsgYWRhcHRlci5jbG9zZSgpOyB9IGNhdGNoIChlKSB7IGxvZ1dhcm5pbmcoXCJkYlwiLCBgY2xvc2UgYWZ0ZXIgVkFDVVVNIGZhaWxlZDogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gKTsgfVxuICAgICAgICB0aHJvdyByZXRyeUVycjtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgX2RiT3BlblN0YXRlLnJlY29yZEVycm9yKFwiaW5pdFNjaGVtYVwiLCBlcnIpO1xuICAgICAgdHJ5IHsgYWRhcHRlci5jbG9zZSgpOyB9IGNhdGNoIChlKSB7IGxvZ1dhcm5pbmcoXCJkYlwiLCBgY2xvc2UgYWZ0ZXIgaW5pdFNjaGVtYSBmYWlsZWQ6ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7IH1cbiAgICAgIHRocm93IGVycjtcbiAgICB9XG4gIH1cblxuICAvLyBDb21taXQgZmFsbGJhY2sgcHJvdmlkZXIgc3dpdGNoIG9ubHkgYWZ0ZXIgb3BlbiArIHNjaGVtYSBib3RoIHN1Y2NlZWRlZC5cbiAgaWYgKGZhbGxiYWNrT3BlbikgcHJvdmlkZXJMb2FkZXIuY29tbWl0RmFsbGJhY2soZmFsbGJhY2tPcGVuKTtcblxuICBjdXJyZW50RGIgPSBhZGFwdGVyO1xuICBjdXJyZW50UGF0aCA9IHBhdGg7XG4gIGN1cnJlbnRQaWQgPSBwcm9jZXNzLnBpZDtcblxuICBpZiAoIV9leGl0SGFuZGxlclJlZ2lzdGVyZWQpIHtcbiAgICBfZXhpdEhhbmRsZXJSZWdpc3RlcmVkID0gdHJ1ZTtcbiAgICBwcm9jZXNzLm9uKFwiZXhpdFwiLCAoKSA9PiB7IHRyeSB7IGNsb3NlRGF0YWJhc2UoKTsgfSBjYXRjaCAoZSkgeyBsb2dXYXJuaW5nKFwiZGJcIiwgYGV4aXQgaGFuZGxlciBjbG9zZSBmYWlsZWQ6ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7IH0gfSk7XG4gIH1cblxuICByZXR1cm4gdHJ1ZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNsb3NlRGF0YWJhc2UoKTogdm9pZCB7XG4gIGlmIChjdXJyZW50RGIpIHtcbiAgICB0cnkge1xuICAgICAgY3VycmVudERiLmV4ZWMoJ1BSQUdNQSB3YWxfY2hlY2twb2ludChUUlVOQ0FURSknKTtcbiAgICB9IGNhdGNoIChlKSB7IGxvZ1dhcm5pbmcoXCJkYlwiLCBgV0FMIGNoZWNrcG9pbnQgZmFpbGVkOiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWApOyB9XG4gICAgdHJ5IHtcbiAgICAgIC8vIEluY3JlbWVudGFsIHZhY3V1bSB0byByZWNsYWltIHNwYWNlIHdpdGhvdXQgYmxvY2tpbmdcbiAgICAgIGN1cnJlbnREYi5leGVjKCdQUkFHTUEgaW5jcmVtZW50YWxfdmFjdXVtKDY0KScpO1xuICAgIH0gY2F0Y2ggKGUpIHsgbG9nV2FybmluZyhcImRiXCIsIGBpbmNyZW1lbnRhbCB2YWN1dW0gZmFpbGVkOiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWApOyB9XG4gICAgdHJ5IHtcbiAgICAgIGN1cnJlbnREYi5jbG9zZSgpO1xuICAgIH0gY2F0Y2ggKGUpIHsgbG9nV2FybmluZyhcImRiXCIsIGBkYXRhYmFzZSBjbG9zZSBmYWlsZWQ6ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7IH1cbiAgICAvLyBJZiB0aGlzIGNvbm5lY3Rpb24gd2FzIHdvcmtzcGFjZS10cmFja2VkLCBldmljdCBpdCBmcm9tIHRoZSBjYWNoZSBzb1xuICAgIC8vIHN1YnNlcXVlbnQgb3BlbkRhdGFiYXNlQnlXb3Jrc3BhY2UoKSBjYWxscyByZS1vcGVuIHJhdGhlciB0aGFuIHJlYWN0aXZhdGVcbiAgICAvLyBhIGNsb3NlZCBhZGFwdGVyLlxuICAgIGlmIChfY3VycmVudElkZW50aXR5S2V5ICE9PSBudWxsKSB7XG4gICAgICBfZGJDYWNoZS5kZWxldGUoX2N1cnJlbnRJZGVudGl0eUtleSk7XG4gICAgICBfY3VycmVudElkZW50aXR5S2V5ID0gbnVsbDtcbiAgICB9XG4gICAgY3VycmVudERiID0gbnVsbDtcbiAgICBjdXJyZW50UGF0aCA9IG51bGw7XG4gICAgY3VycmVudFBpZCA9IDA7XG4gIH1cbiAgLy8gUmVzZXQgc2Vzc2lvbi1zY29wZWQgc3RhdGUgdW5jb25kaXRpb25hbGx5IHNvIHN0YWxlIGVycm9yIGluZm8gZnJvbSBhXG4gIC8vIGZhaWxlZCBvcGVuIGRvZXNuJ3QgcGVyc2lzdCBpbnRvIHRoZSBuZXh0IG9wZW4gYXR0ZW1wdCBvciBzdGF0dXMgY2hlY2suXG4gIF9kYk9wZW5TdGF0ZS5yZXNldCgpO1xufVxuXG4vKipcbiAqIFJlLW9wZW4gdGhlIGFjdGl2ZSBkYXRhYmFzZSBjb25uZWN0aW9uIGZyb20gZGlzay5cbiAqXG4gKiBBdXRvLW1vZGUgY2FuIG9ic2VydmUgYXJ0aWZhY3RzIHdyaXR0ZW4gYnkgYSB3b3JrZmxvdyBzZXJ2ZXIgcnVubmluZyBpbiBhXG4gKiBkaWZmZXJlbnQgcHJvY2VzcyBiZWZvcmUgaXRzIGxvbmctbGl2ZWQgc2luZ2xldG9uIGhhcyByZS1zeW5jaHJvbml6ZWQuIFRoZVxuICogcmVjb3ZlcnkgcGF0aCB1c2VzIHRoaXMgdG8gZm9yY2UgdGhlIG5leHQgc3RhdGUgZGVyaXZhdGlvbiB0byByZWFkIGZyb20gdGhlXG4gKiBjdXJyZW50IG9uLWRpc2sgZGF0YWJhc2UgaW5zdGVhZCBvZiBjb250aW51aW5nIHdpdGggYSBwb3NzaWJseSBzdGFsZSBoYW5kbGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWZyZXNoT3BlbkRhdGFiYXNlRnJvbURpc2soKTogYm9vbGVhbiB7XG4gIGlmICghY3VycmVudERiIHx8ICFjdXJyZW50UGF0aCkgcmV0dXJuIGZhbHNlO1xuICBpZiAoY3VycmVudFBhdGggPT09IFwiOm1lbW9yeTpcIikgcmV0dXJuIGZhbHNlO1xuXG4gIGNvbnN0IGRiUGF0aCA9IGN1cnJlbnRQYXRoO1xuICBjb25zdCBpZGVudGl0eUtleSA9IF9jdXJyZW50SWRlbnRpdHlLZXk7XG5cbiAgdHJ5IHtcbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgY29uc3Qgb3BlbmVkID0gb3BlbkRhdGFiYXNlKGRiUGF0aCk7XG4gICAgaWYgKG9wZW5lZCAmJiBpZGVudGl0eUtleSAmJiBjdXJyZW50RGIpIHtcbiAgICAgIF9kYkNhY2hlLnNldChpZGVudGl0eUtleSwgeyBkYlBhdGgsIGRiOiBjdXJyZW50RGIgfSk7XG4gICAgICBfY3VycmVudElkZW50aXR5S2V5ID0gaWRlbnRpdHlLZXk7XG4gICAgfVxuICAgIHJldHVybiBvcGVuZWQ7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBsb2dXYXJuaW5nKFwiZGJcIiwgYGRhdGFiYXNlIHJlZnJlc2ggZmFpbGVkOiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWApO1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuXG4vKiogUnVuIGEgZnVsbCBWQUNVVU0gXHUyMDE0IGNhbGwgc3BhcmluZ2x5IChlLmcuIGFmdGVyIG1pbGVzdG9uZSBjb21wbGV0aW9uKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiB2YWN1dW1EYXRhYmFzZSgpOiB2b2lkIHtcbiAgaWYgKCFjdXJyZW50RGIpIHJldHVybjtcbiAgdHJ5IHtcbiAgICBjdXJyZW50RGIuZXhlYygnVkFDVVVNJyk7XG4gIH0gY2F0Y2ggKGUpIHsgbG9nV2FybmluZyhcImRiXCIsIGBWQUNVVU0gZmFpbGVkOiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWApOyB9XG59XG5cbi8qKiBGbHVzaCBXQUwgaW50byBnc2QuZGIgc28gYGdpdCBhZGQgLmdzZC9nc2QuZGJgIHN0YWdlcyBjdXJyZW50IHN0YXRlIFx1MjAxNCBzYWZlIHdoaWxlIERCIGlzIG9wZW4uICovXG5leHBvcnQgZnVuY3Rpb24gY2hlY2twb2ludERhdGFiYXNlKCk6IHZvaWQge1xuICBpZiAoIWN1cnJlbnREYikgcmV0dXJuO1xuICB0cnkge1xuICAgIGN1cnJlbnREYi5leGVjKCdQUkFHTUEgd2FsX2NoZWNrcG9pbnQoVFJVTkNBVEUpJyk7XG4gIH0gY2F0Y2ggKGUpIHsgbG9nV2FybmluZyhcImRiXCIsIGBXQUwgY2hlY2twb2ludCBmYWlsZWQ6ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7IH1cbn1cblxuY29uc3QgX3RyYW5zYWN0aW9uUnVubmVyID0gY3JlYXRlRGJUcmFuc2FjdGlvblJ1bm5lcigpO1xuXG5mdW5jdGlvbiBjcmVhdGVUcmFuc2FjdGlvbkNvbnRyb2xzKGRiOiBEYkFkYXB0ZXIpIHtcbiAgcmV0dXJuIHtcbiAgICBiZWdpbjogKCkgPT4gZGIuZXhlYyhcIkJFR0lOXCIpLFxuICAgIGJlZ2luUmVhZDogKCkgPT4gZGIuZXhlYyhcIkJFR0lOIERFRkVSUkVEXCIpLFxuICAgIGNvbW1pdDogKCkgPT4gZGIuZXhlYyhcIkNPTU1JVFwiKSxcbiAgICByb2xsYmFjazogKCkgPT4gZGIuZXhlYyhcIlJPTExCQUNLXCIpLFxuICB9O1xufVxuXG4vKipcbiAqIFdoZXRoZXIgdGhlIGN1cnJlbnQgY2FsbCBpcyBydW5uaW5nIGluc2lkZSBhbiBhY3RpdmUgU1FMaXRlIHRyYW5zYWN0aW9uLlxuICogU3RhdGVtZW50LXRpbWUgcmVjb3ZlcnkgcGF0aHMgKGUuZy4gVkFDVVVNIHJldHJ5IG9uIGEgbWFsZm9ybWVkIG1lbW9yeVxuICogc3RvcmUpIE1VU1QgZ2F0ZSBvbiB0aGlzIFx1MjAxNCBTUUxpdGUgcmVmdXNlcyBWQUNVVU0gaW5zaWRlIGEgdHJhbnNhY3Rpb25cbiAqIGFuZCB3b3VsZCBtYXNrIHRoZSBvcmlnaW5hbCBlcnJvciB3aXRoIGEgc2Vjb25kYXJ5IFwiY2Fubm90IFZBQ1VVTVwiIHRocm93LlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNJblRyYW5zYWN0aW9uKCk6IGJvb2xlYW4ge1xuICByZXR1cm4gX3RyYW5zYWN0aW9uUnVubmVyLmlzSW5UcmFuc2FjdGlvbigpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdHJhbnNhY3Rpb248VD4oZm46ICgpID0+IFQpOiBUIHtcbiAgaWYgKCFjdXJyZW50RGIpIHRocm93IG5ldyBHU0RFcnJvcihHU0RfU1RBTEVfU1RBVEUsIFwiZ3NkLWRiOiBObyBkYXRhYmFzZSBvcGVuXCIpO1xuICByZXR1cm4gX3RyYW5zYWN0aW9uUnVubmVyLnRyYW5zYWN0aW9uKGNyZWF0ZVRyYW5zYWN0aW9uQ29udHJvbHMoY3VycmVudERiKSwgZm4pO1xufVxuXG4vKipcbiAqIFdyYXAgYSBibG9jayBvZiByZWFkcyBpbiBhIERFRkVSUkVEIHRyYW5zYWN0aW9uIHNvIHRoYXQgYWxsIFNFTEVDVHMgb2JzZXJ2ZVxuICogYSBjb25zaXN0ZW50IHNuYXBzaG90IG9mIHRoZSBEQiBldmVuIGlmIGEgY29uY3VycmVudCB3cml0ZXIgY29tbWl0cyBiZXR3ZWVuXG4gKiB0aGVtLiBVc2UgdGhpcyBmb3IgbXVsdGktcXVlcnkgcmVhZCBmbG93cyAoZS5nLiB0b29sIGV4ZWN1dG9ycyB0aGF0IHF1ZXJ5XG4gKiBtaWxlc3RvbmUgKyBzbGljZXMgKyBjb3VudHMgYW5kIHdhbnQgb25lIHNuYXBzaG90KS4gUmUtZW50cmFudCBcdTIwMTQgaWYgYWxyZWFkeVxuICogaW5zaWRlIGEgdHJhbnNhY3Rpb24sIHJ1bnMgZm4oKSB3aXRob3V0IHN0YXJ0aW5nIGEgbmVzdGVkIG9uZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlYWRUcmFuc2FjdGlvbjxUPihmbjogKCkgPT4gVCk6IFQge1xuICBpZiAoIWN1cnJlbnREYikgdGhyb3cgbmV3IEdTREVycm9yKEdTRF9TVEFMRV9TVEFURSwgXCJnc2QtZGI6IE5vIGRhdGFiYXNlIG9wZW5cIik7XG5cbiAgcmV0dXJuIF90cmFuc2FjdGlvblJ1bm5lci5yZWFkVHJhbnNhY3Rpb24oY3JlYXRlVHJhbnNhY3Rpb25Db250cm9scyhjdXJyZW50RGIpLCBmbiwgKHJvbGxiYWNrRXJyKSA9PiB7XG4gICAgLy8gQSBmYWlsZWQgUk9MTEJBQ0sgYWZ0ZXIgYSBmYWlsZWQgcmVhZCBpcyBhIHNwbGl0LWJyYWluIHNpZ25hbCBcdTIwMTRcbiAgICAvLyB0aGUgdHJhbnNhY3Rpb24gaXMgaW4gYW4gaW5kZXRlcm1pbmF0ZSBzdGF0ZS4gU3VyZmFjZSBpdCB2aWEgdGhlXG4gICAgLy8gbG9nZ2VyIGluc3RlYWQgb2Ygc3dhbGxvd2luZyBpdC5cbiAgICBsb2dFcnJvcihcImRiXCIsIFwic25hcHNob3RTdGF0ZSBST0xMQkFDSyBmYWlsZWRcIiwge1xuICAgICAgZXJyb3I6IHJvbGxiYWNrRXJyLm1lc3NhZ2UsXG4gICAgfSk7XG4gIH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaW5zZXJ0RGVjaXNpb24oZDogT21pdDxEZWNpc2lvbiwgXCJzZXFcIj4pOiB2b2lkIHtcbiAgaWYgKCFjdXJyZW50RGIpIHRocm93IG5ldyBHU0RFcnJvcihHU0RfU1RBTEVfU1RBVEUsIFwiZ3NkLWRiOiBObyBkYXRhYmFzZSBvcGVuXCIpO1xuICBjdXJyZW50RGIucHJlcGFyZShcbiAgICBgSU5TRVJUIElOVE8gZGVjaXNpb25zIChpZCwgd2hlbl9jb250ZXh0LCBzY29wZSwgZGVjaXNpb24sIGNob2ljZSwgcmF0aW9uYWxlLCByZXZpc2FibGUsIG1hZGVfYnksIHNvdXJjZSwgc3VwZXJzZWRlZF9ieSlcbiAgICAgVkFMVUVTICg6aWQsIDp3aGVuX2NvbnRleHQsIDpzY29wZSwgOmRlY2lzaW9uLCA6Y2hvaWNlLCA6cmF0aW9uYWxlLCA6cmV2aXNhYmxlLCA6bWFkZV9ieSwgOnNvdXJjZSwgOnN1cGVyc2VkZWRfYnkpYCxcbiAgKS5ydW4oe1xuICAgIFwiOmlkXCI6IGQuaWQsXG4gICAgXCI6d2hlbl9jb250ZXh0XCI6IGQud2hlbl9jb250ZXh0LFxuICAgIFwiOnNjb3BlXCI6IGQuc2NvcGUsXG4gICAgXCI6ZGVjaXNpb25cIjogZC5kZWNpc2lvbixcbiAgICBcIjpjaG9pY2VcIjogZC5jaG9pY2UsXG4gICAgXCI6cmF0aW9uYWxlXCI6IGQucmF0aW9uYWxlLFxuICAgIFwiOnJldmlzYWJsZVwiOiBkLnJldmlzYWJsZSxcbiAgICBcIjptYWRlX2J5XCI6IGQubWFkZV9ieSA/PyBcImFnZW50XCIsXG4gICAgXCI6c291cmNlXCI6IGQuc291cmNlID8/IFwiZGlzY3Vzc2lvblwiLFxuICAgIFwiOnN1cGVyc2VkZWRfYnlcIjogZC5zdXBlcnNlZGVkX2J5LFxuICB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldERlY2lzaW9uQnlJZChpZDogc3RyaW5nKTogRGVjaXNpb24gfCBudWxsIHtcbiAgaWYgKCFjdXJyZW50RGIpIHJldHVybiBudWxsO1xuICBjb25zdCByb3cgPSBjdXJyZW50RGIucHJlcGFyZShcIlNFTEVDVCAqIEZST00gZGVjaXNpb25zIFdIRVJFIGlkID0gP1wiKS5nZXQoaWQpO1xuICBpZiAoIXJvdykgcmV0dXJuIG51bGw7XG4gIHJldHVybiByb3dUb0RlY2lzaW9uKHJvdyk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRBY3RpdmVEZWNpc2lvbnMoKTogRGVjaXNpb25bXSB7XG4gIGlmICghY3VycmVudERiKSByZXR1cm4gW107XG4gIGNvbnN0IHJvd3MgPSBjdXJyZW50RGIucHJlcGFyZShcIlNFTEVDVCAqIEZST00gYWN0aXZlX2RlY2lzaW9uc1wiKS5hbGwoKTtcbiAgcmV0dXJuIHJvd3MubWFwKHJvd1RvQWN0aXZlRGVjaXNpb24pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaW5zZXJ0UmVxdWlyZW1lbnQocjogUmVxdWlyZW1lbnQpOiB2b2lkIHtcbiAgaWYgKCFjdXJyZW50RGIpIHRocm93IG5ldyBHU0RFcnJvcihHU0RfU1RBTEVfU1RBVEUsIFwiZ3NkLWRiOiBObyBkYXRhYmFzZSBvcGVuXCIpO1xuICBjdXJyZW50RGIucHJlcGFyZShcbiAgICBgSU5TRVJUIElOVE8gcmVxdWlyZW1lbnRzIChpZCwgY2xhc3MsIHN0YXR1cywgZGVzY3JpcHRpb24sIHdoeSwgc291cmNlLCBwcmltYXJ5X293bmVyLCBzdXBwb3J0aW5nX3NsaWNlcywgdmFsaWRhdGlvbiwgbm90ZXMsIGZ1bGxfY29udGVudCwgc3VwZXJzZWRlZF9ieSlcbiAgICAgVkFMVUVTICg6aWQsIDpjbGFzcywgOnN0YXR1cywgOmRlc2NyaXB0aW9uLCA6d2h5LCA6c291cmNlLCA6cHJpbWFyeV9vd25lciwgOnN1cHBvcnRpbmdfc2xpY2VzLCA6dmFsaWRhdGlvbiwgOm5vdGVzLCA6ZnVsbF9jb250ZW50LCA6c3VwZXJzZWRlZF9ieSlgLFxuICApLnJ1bih7XG4gICAgXCI6aWRcIjogci5pZCxcbiAgICBcIjpjbGFzc1wiOiByLmNsYXNzLFxuICAgIFwiOnN0YXR1c1wiOiByLnN0YXR1cyxcbiAgICBcIjpkZXNjcmlwdGlvblwiOiByLmRlc2NyaXB0aW9uLFxuICAgIFwiOndoeVwiOiByLndoeSxcbiAgICBcIjpzb3VyY2VcIjogci5zb3VyY2UsXG4gICAgXCI6cHJpbWFyeV9vd25lclwiOiByLnByaW1hcnlfb3duZXIsXG4gICAgXCI6c3VwcG9ydGluZ19zbGljZXNcIjogci5zdXBwb3J0aW5nX3NsaWNlcyxcbiAgICBcIjp2YWxpZGF0aW9uXCI6IHIudmFsaWRhdGlvbixcbiAgICBcIjpub3Rlc1wiOiByLm5vdGVzLFxuICAgIFwiOmZ1bGxfY29udGVudFwiOiByLmZ1bGxfY29udGVudCxcbiAgICBcIjpzdXBlcnNlZGVkX2J5XCI6IHIuc3VwZXJzZWRlZF9ieSxcbiAgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRSZXF1aXJlbWVudEJ5SWQoaWQ6IHN0cmluZyk6IFJlcXVpcmVtZW50IHwgbnVsbCB7XG4gIGlmICghY3VycmVudERiKSByZXR1cm4gbnVsbDtcbiAgY29uc3Qgcm93ID0gY3VycmVudERiLnByZXBhcmUoXCJTRUxFQ1QgKiBGUk9NIHJlcXVpcmVtZW50cyBXSEVSRSBpZCA9ID9cIikuZ2V0KGlkKTtcbiAgaWYgKCFyb3cpIHJldHVybiBudWxsO1xuICByZXR1cm4gcm93VG9SZXF1aXJlbWVudChyb3cpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0QWN0aXZlUmVxdWlyZW1lbnRzKCk6IFJlcXVpcmVtZW50W10ge1xuICBpZiAoIWN1cnJlbnREYikgcmV0dXJuIFtdO1xuICBjb25zdCByb3dzID0gY3VycmVudERiLnByZXBhcmUoXCJTRUxFQ1QgKiBGUk9NIGFjdGl2ZV9yZXF1aXJlbWVudHNcIikuYWxsKCk7XG4gIHJldHVybiByb3dzLm1hcChyb3dUb0FjdGl2ZVJlcXVpcmVtZW50KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldFJlcXVpcmVtZW50Q291bnRzKCk6IHtcbiAgYWN0aXZlOiBudW1iZXI7XG4gIHZhbGlkYXRlZDogbnVtYmVyO1xuICBkZWZlcnJlZDogbnVtYmVyO1xuICBvdXRPZlNjb3BlOiBudW1iZXI7XG4gIGJsb2NrZWQ6IG51bWJlcjtcbiAgdG90YWw6IG51bWJlcjtcbn0ge1xuICBpZiAoIWN1cnJlbnREYikge1xuICAgIHJldHVybiB7IGFjdGl2ZTogMCwgdmFsaWRhdGVkOiAwLCBkZWZlcnJlZDogMCwgb3V0T2ZTY29wZTogMCwgYmxvY2tlZDogMCwgdG90YWw6IDAgfTtcbiAgfVxuICBjb25zdCByb3dzID0gY3VycmVudERiXG4gICAgLnByZXBhcmUoXCJTRUxFQ1QgbG93ZXIoc3RhdHVzKSBhcyBzdGF0dXMsIENPVU5UKCopIGFzIGNvdW50IEZST00gcmVxdWlyZW1lbnRzIEdST1VQIEJZIGxvd2VyKHN0YXR1cylcIilcbiAgICAuYWxsKCk7XG4gIHJldHVybiByb3dzVG9SZXF1aXJlbWVudENvdW50cyhyb3dzKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldERiT3duZXJQaWQoKTogbnVtYmVyIHtcbiAgcmV0dXJuIGN1cnJlbnRQaWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXREYlBhdGgoKTogc3RyaW5nIHwgbnVsbCB7XG4gIHJldHVybiBjdXJyZW50UGF0aDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIF9nZXRBZGFwdGVyKCk6IERiQWRhcHRlciB8IG51bGwge1xuICByZXR1cm4gY3VycmVudERiO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gX3Jlc2V0UHJvdmlkZXIoKTogdm9pZCB7XG4gIHByb3ZpZGVyTG9hZGVyLnJlc2V0KCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB1cHNlcnREZWNpc2lvbihkOiBPbWl0PERlY2lzaW9uLCBcInNlcVwiPik6IHZvaWQge1xuICBpZiAoIWN1cnJlbnREYikgdGhyb3cgbmV3IEdTREVycm9yKEdTRF9TVEFMRV9TVEFURSwgXCJnc2QtZGI6IE5vIGRhdGFiYXNlIG9wZW5cIik7XG4gIC8vIFVzZSBPTiBDT05GTElDVCBETyBVUERBVEUgaW5zdGVhZCBvZiBJTlNFUlQgT1IgUkVQTEFDRSB0byBwcmVzZXJ2ZSB0aGVcbiAgLy8gc2VxIGNvbHVtbi4gSU5TRVJUIE9SIFJFUExBQ0UgZGVsZXRlcyB0aGVuIHJlaW5zZXJ0cywgcmVzZXR0aW5nIHNlcSBhbmRcbiAgLy8gY29ycnVwdGluZyBkZWNpc2lvbiBvcmRlcmluZyBpbiBERUNJU0lPTlMubWQgYWZ0ZXIgcmVjb25jaWxlIHJlcGxheS5cbiAgY3VycmVudERiLnByZXBhcmUoXG4gICAgYElOU0VSVCBJTlRPIGRlY2lzaW9ucyAoaWQsIHdoZW5fY29udGV4dCwgc2NvcGUsIGRlY2lzaW9uLCBjaG9pY2UsIHJhdGlvbmFsZSwgcmV2aXNhYmxlLCBtYWRlX2J5LCBzb3VyY2UsIHN1cGVyc2VkZWRfYnkpXG4gICAgIFZBTFVFUyAoOmlkLCA6d2hlbl9jb250ZXh0LCA6c2NvcGUsIDpkZWNpc2lvbiwgOmNob2ljZSwgOnJhdGlvbmFsZSwgOnJldmlzYWJsZSwgOm1hZGVfYnksIDpzb3VyY2UsIDpzdXBlcnNlZGVkX2J5KVxuICAgICBPTiBDT05GTElDVChpZCkgRE8gVVBEQVRFIFNFVFxuICAgICAgIHdoZW5fY29udGV4dCA9IGV4Y2x1ZGVkLndoZW5fY29udGV4dCxcbiAgICAgICBzY29wZSA9IGV4Y2x1ZGVkLnNjb3BlLFxuICAgICAgIGRlY2lzaW9uID0gZXhjbHVkZWQuZGVjaXNpb24sXG4gICAgICAgY2hvaWNlID0gZXhjbHVkZWQuY2hvaWNlLFxuICAgICAgIHJhdGlvbmFsZSA9IGV4Y2x1ZGVkLnJhdGlvbmFsZSxcbiAgICAgICByZXZpc2FibGUgPSBleGNsdWRlZC5yZXZpc2FibGUsXG4gICAgICAgbWFkZV9ieSA9IGV4Y2x1ZGVkLm1hZGVfYnksXG4gICAgICAgc291cmNlID0gZXhjbHVkZWQuc291cmNlLFxuICAgICAgIHN1cGVyc2VkZWRfYnkgPSBleGNsdWRlZC5zdXBlcnNlZGVkX2J5YCxcbiAgKS5ydW4oe1xuICAgIFwiOmlkXCI6IGQuaWQsXG4gICAgXCI6d2hlbl9jb250ZXh0XCI6IGQud2hlbl9jb250ZXh0LFxuICAgIFwiOnNjb3BlXCI6IGQuc2NvcGUsXG4gICAgXCI6ZGVjaXNpb25cIjogZC5kZWNpc2lvbixcbiAgICBcIjpjaG9pY2VcIjogZC5jaG9pY2UsXG4gICAgXCI6cmF0aW9uYWxlXCI6IGQucmF0aW9uYWxlLFxuICAgIFwiOnJldmlzYWJsZVwiOiBkLnJldmlzYWJsZSxcbiAgICBcIjptYWRlX2J5XCI6IGQubWFkZV9ieSA/PyBcImFnZW50XCIsXG4gICAgXCI6c291cmNlXCI6IGQuc291cmNlID8/IFwiZGlzY3Vzc2lvblwiLFxuICAgIFwiOnN1cGVyc2VkZWRfYnlcIjogZC5zdXBlcnNlZGVkX2J5ID8/IG51bGwsXG4gIH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdXBzZXJ0UmVxdWlyZW1lbnQocjogUmVxdWlyZW1lbnQpOiB2b2lkIHtcbiAgaWYgKCFjdXJyZW50RGIpIHRocm93IG5ldyBHU0RFcnJvcihHU0RfU1RBTEVfU1RBVEUsIFwiZ3NkLWRiOiBObyBkYXRhYmFzZSBvcGVuXCIpO1xuICBjdXJyZW50RGIucHJlcGFyZShcbiAgICBgSU5TRVJUIE9SIFJFUExBQ0UgSU5UTyByZXF1aXJlbWVudHMgKGlkLCBjbGFzcywgc3RhdHVzLCBkZXNjcmlwdGlvbiwgd2h5LCBzb3VyY2UsIHByaW1hcnlfb3duZXIsIHN1cHBvcnRpbmdfc2xpY2VzLCB2YWxpZGF0aW9uLCBub3RlcywgZnVsbF9jb250ZW50LCBzdXBlcnNlZGVkX2J5KVxuICAgICBWQUxVRVMgKDppZCwgOmNsYXNzLCA6c3RhdHVzLCA6ZGVzY3JpcHRpb24sIDp3aHksIDpzb3VyY2UsIDpwcmltYXJ5X293bmVyLCA6c3VwcG9ydGluZ19zbGljZXMsIDp2YWxpZGF0aW9uLCA6bm90ZXMsIDpmdWxsX2NvbnRlbnQsIDpzdXBlcnNlZGVkX2J5KWAsXG4gICkucnVuKHtcbiAgICBcIjppZFwiOiByLmlkLFxuICAgIFwiOmNsYXNzXCI6IHIuY2xhc3MsXG4gICAgXCI6c3RhdHVzXCI6IHIuc3RhdHVzLFxuICAgIFwiOmRlc2NyaXB0aW9uXCI6IHIuZGVzY3JpcHRpb24sXG4gICAgXCI6d2h5XCI6IHIud2h5LFxuICAgIFwiOnNvdXJjZVwiOiByLnNvdXJjZSxcbiAgICBcIjpwcmltYXJ5X293bmVyXCI6IHIucHJpbWFyeV9vd25lcixcbiAgICBcIjpzdXBwb3J0aW5nX3NsaWNlc1wiOiByLnN1cHBvcnRpbmdfc2xpY2VzLFxuICAgIFwiOnZhbGlkYXRpb25cIjogci52YWxpZGF0aW9uLFxuICAgIFwiOm5vdGVzXCI6IHIubm90ZXMsXG4gICAgXCI6ZnVsbF9jb250ZW50XCI6IHIuZnVsbF9jb250ZW50LFxuICAgIFwiOnN1cGVyc2VkZWRfYnlcIjogci5zdXBlcnNlZGVkX2J5ID8/IG51bGwsXG4gIH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY2xlYXJBcnRpZmFjdHMoKTogdm9pZCB7XG4gIGlmICghY3VycmVudERiKSByZXR1cm47XG4gIHRyeSB7IGN1cnJlbnREYi5leGVjKFwiREVMRVRFIEZST00gYXJ0aWZhY3RzXCIpOyB9IGNhdGNoIChlKSB7IGxvZ1dhcm5pbmcoXCJkYlwiLCBgY2xlYXJBcnRpZmFjdHMgZmFpbGVkOiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWApOyB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpbnNlcnRBcnRpZmFjdChhOiB7XG4gIHBhdGg6IHN0cmluZztcbiAgYXJ0aWZhY3RfdHlwZTogc3RyaW5nO1xuICBtaWxlc3RvbmVfaWQ6IHN0cmluZyB8IG51bGw7XG4gIHNsaWNlX2lkOiBzdHJpbmcgfCBudWxsO1xuICB0YXNrX2lkOiBzdHJpbmcgfCBudWxsO1xuICBmdWxsX2NvbnRlbnQ6IHN0cmluZztcbn0pOiB2b2lkIHtcbiAgaWYgKCFjdXJyZW50RGIpIHRocm93IG5ldyBHU0RFcnJvcihHU0RfU1RBTEVfU1RBVEUsIFwiZ3NkLWRiOiBObyBkYXRhYmFzZSBvcGVuXCIpO1xuICBjb25zdCBjb250ZW50SGFzaCA9IGNyZWF0ZUhhc2goXCJzaGEyNTZcIikudXBkYXRlKGEuZnVsbF9jb250ZW50KS5kaWdlc3QoXCJoZXhcIik7XG4gIGN1cnJlbnREYi5wcmVwYXJlKFxuICAgIGBJTlNFUlQgT1IgUkVQTEFDRSBJTlRPIGFydGlmYWN0cyAocGF0aCwgYXJ0aWZhY3RfdHlwZSwgbWlsZXN0b25lX2lkLCBzbGljZV9pZCwgdGFza19pZCwgZnVsbF9jb250ZW50LCBpbXBvcnRlZF9hdCwgY29udGVudF9oYXNoKVxuICAgICBWQUxVRVMgKDpwYXRoLCA6YXJ0aWZhY3RfdHlwZSwgOm1pbGVzdG9uZV9pZCwgOnNsaWNlX2lkLCA6dGFza19pZCwgOmZ1bGxfY29udGVudCwgOmltcG9ydGVkX2F0LCA6Y29udGVudF9oYXNoKWAsXG4gICkucnVuKHtcbiAgICBcIjpwYXRoXCI6IGEucGF0aCxcbiAgICBcIjphcnRpZmFjdF90eXBlXCI6IGEuYXJ0aWZhY3RfdHlwZSxcbiAgICBcIjptaWxlc3RvbmVfaWRcIjogYS5taWxlc3RvbmVfaWQsXG4gICAgXCI6c2xpY2VfaWRcIjogYS5zbGljZV9pZCxcbiAgICBcIjp0YXNrX2lkXCI6IGEudGFza19pZCxcbiAgICBcIjpmdWxsX2NvbnRlbnRcIjogYS5mdWxsX2NvbnRlbnQsXG4gICAgXCI6aW1wb3J0ZWRfYXRcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgIFwiOmNvbnRlbnRfaGFzaFwiOiBjb250ZW50SGFzaCxcbiAgfSk7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgTWlsZXN0b25lUGxhbm5pbmdSZWNvcmQge1xuICB2aXNpb246IHN0cmluZztcbiAgc3VjY2Vzc0NyaXRlcmlhOiBzdHJpbmdbXTtcbiAga2V5Umlza3M6IEFycmF5PHsgcmlzazogc3RyaW5nOyB3aHlJdE1hdHRlcnM6IHN0cmluZyB9PjtcbiAgcHJvb2ZTdHJhdGVneTogQXJyYXk8eyByaXNrT3JVbmtub3duOiBzdHJpbmc7IHJldGlyZUluOiBzdHJpbmc7IHdoYXRXaWxsQmVQcm92ZW46IHN0cmluZyB9PjtcbiAgdmVyaWZpY2F0aW9uQ29udHJhY3Q6IHN0cmluZztcbiAgdmVyaWZpY2F0aW9uSW50ZWdyYXRpb246IHN0cmluZztcbiAgdmVyaWZpY2F0aW9uT3BlcmF0aW9uYWw6IHN0cmluZztcbiAgdmVyaWZpY2F0aW9uVWF0OiBzdHJpbmc7XG4gIGRlZmluaXRpb25PZkRvbmU6IHN0cmluZ1tdO1xuICByZXF1aXJlbWVudENvdmVyYWdlOiBzdHJpbmc7XG4gIGJvdW5kYXJ5TWFwTWFya2Rvd246IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBTbGljZVBsYW5uaW5nUmVjb3JkIHtcbiAgZ29hbDogc3RyaW5nO1xuICBzdWNjZXNzQ3JpdGVyaWE6IHN0cmluZztcbiAgcHJvb2ZMZXZlbDogc3RyaW5nO1xuICBpbnRlZ3JhdGlvbkNsb3N1cmU6IHN0cmluZztcbiAgb2JzZXJ2YWJpbGl0eUltcGFjdDogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFRhc2tQbGFubmluZ1JlY29yZCB7XG4gIHRpdGxlPzogc3RyaW5nO1xuICBkZXNjcmlwdGlvbjogc3RyaW5nO1xuICBlc3RpbWF0ZTogc3RyaW5nO1xuICBmaWxlczogc3RyaW5nW107XG4gIHZlcmlmeTogc3RyaW5nO1xuICBpbnB1dHM6IHN0cmluZ1tdO1xuICBleHBlY3RlZE91dHB1dDogc3RyaW5nW107XG4gIG9ic2VydmFiaWxpdHlJbXBhY3Q6IHN0cmluZztcbiAgZnVsbFBsYW5NZD86IHN0cmluZztcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGluc2VydE1pbGVzdG9uZShtOiB7XG4gIGlkOiBzdHJpbmc7XG4gIHRpdGxlPzogc3RyaW5nO1xuICBzdGF0dXM/OiBzdHJpbmc7XG4gIGRlcGVuZHNfb24/OiBzdHJpbmdbXTtcbiAgcGxhbm5pbmc/OiBQYXJ0aWFsPE1pbGVzdG9uZVBsYW5uaW5nUmVjb3JkPjtcbn0pOiB2b2lkIHtcbiAgaWYgKCFjdXJyZW50RGIpIHRocm93IG5ldyBHU0RFcnJvcihHU0RfU1RBTEVfU1RBVEUsIFwiZ3NkLWRiOiBObyBkYXRhYmFzZSBvcGVuXCIpO1xuICBjdXJyZW50RGIucHJlcGFyZShcbiAgICBgSU5TRVJUIE9SIElHTk9SRSBJTlRPIG1pbGVzdG9uZXMgKFxuICAgICAgaWQsIHRpdGxlLCBzdGF0dXMsIGRlcGVuZHNfb24sIGNyZWF0ZWRfYXQsXG4gICAgICB2aXNpb24sIHN1Y2Nlc3NfY3JpdGVyaWEsIGtleV9yaXNrcywgcHJvb2Zfc3RyYXRlZ3ksXG4gICAgICB2ZXJpZmljYXRpb25fY29udHJhY3QsIHZlcmlmaWNhdGlvbl9pbnRlZ3JhdGlvbiwgdmVyaWZpY2F0aW9uX29wZXJhdGlvbmFsLCB2ZXJpZmljYXRpb25fdWF0LFxuICAgICAgZGVmaW5pdGlvbl9vZl9kb25lLCByZXF1aXJlbWVudF9jb3ZlcmFnZSwgYm91bmRhcnlfbWFwX21hcmtkb3duXG4gICAgKSBWQUxVRVMgKFxuICAgICAgOmlkLCA6dGl0bGUsIDpzdGF0dXMsIDpkZXBlbmRzX29uLCA6Y3JlYXRlZF9hdCxcbiAgICAgIDp2aXNpb24sIDpzdWNjZXNzX2NyaXRlcmlhLCA6a2V5X3Jpc2tzLCA6cHJvb2Zfc3RyYXRlZ3ksXG4gICAgICA6dmVyaWZpY2F0aW9uX2NvbnRyYWN0LCA6dmVyaWZpY2F0aW9uX2ludGVncmF0aW9uLCA6dmVyaWZpY2F0aW9uX29wZXJhdGlvbmFsLCA6dmVyaWZpY2F0aW9uX3VhdCxcbiAgICAgIDpkZWZpbml0aW9uX29mX2RvbmUsIDpyZXF1aXJlbWVudF9jb3ZlcmFnZSwgOmJvdW5kYXJ5X21hcF9tYXJrZG93blxuICAgIClgLFxuICApLnJ1bih7XG4gICAgXCI6aWRcIjogbS5pZCxcbiAgICBcIjp0aXRsZVwiOiBtLnRpdGxlID8/IFwiXCIsXG4gICAgLy8gRGVmYXVsdCB0byBcInF1ZXVlZFwiIFx1MjAxNCBuZXZlciBhdXRvLWNyZWF0ZSBtaWxlc3RvbmVzIGFzIFwiYWN0aXZlXCIgKCMzMzgwKS5cbiAgICAvLyBDYWxsZXJzIHRoYXQgbmVlZCBcImFjdGl2ZVwiIG11c3QgcGFzcyBpdCBleHBsaWNpdGx5LlxuICAgIFwiOnN0YXR1c1wiOiBtLnN0YXR1cyA/PyBcInF1ZXVlZFwiLFxuICAgIFwiOmRlcGVuZHNfb25cIjogSlNPTi5zdHJpbmdpZnkobS5kZXBlbmRzX29uID8/IFtdKSxcbiAgICBcIjpjcmVhdGVkX2F0XCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICBcIjp2aXNpb25cIjogbS5wbGFubmluZz8udmlzaW9uID8/IFwiXCIsXG4gICAgXCI6c3VjY2Vzc19jcml0ZXJpYVwiOiBKU09OLnN0cmluZ2lmeShtLnBsYW5uaW5nPy5zdWNjZXNzQ3JpdGVyaWEgPz8gW10pLFxuICAgIFwiOmtleV9yaXNrc1wiOiBKU09OLnN0cmluZ2lmeShtLnBsYW5uaW5nPy5rZXlSaXNrcyA/PyBbXSksXG4gICAgXCI6cHJvb2Zfc3RyYXRlZ3lcIjogSlNPTi5zdHJpbmdpZnkobS5wbGFubmluZz8ucHJvb2ZTdHJhdGVneSA/PyBbXSksXG4gICAgXCI6dmVyaWZpY2F0aW9uX2NvbnRyYWN0XCI6IG0ucGxhbm5pbmc/LnZlcmlmaWNhdGlvbkNvbnRyYWN0ID8/IFwiXCIsXG4gICAgXCI6dmVyaWZpY2F0aW9uX2ludGVncmF0aW9uXCI6IG0ucGxhbm5pbmc/LnZlcmlmaWNhdGlvbkludGVncmF0aW9uID8/IFwiXCIsXG4gICAgXCI6dmVyaWZpY2F0aW9uX29wZXJhdGlvbmFsXCI6IG0ucGxhbm5pbmc/LnZlcmlmaWNhdGlvbk9wZXJhdGlvbmFsID8/IFwiXCIsXG4gICAgXCI6dmVyaWZpY2F0aW9uX3VhdFwiOiBtLnBsYW5uaW5nPy52ZXJpZmljYXRpb25VYXQgPz8gXCJcIixcbiAgICBcIjpkZWZpbml0aW9uX29mX2RvbmVcIjogSlNPTi5zdHJpbmdpZnkobS5wbGFubmluZz8uZGVmaW5pdGlvbk9mRG9uZSA/PyBbXSksXG4gICAgXCI6cmVxdWlyZW1lbnRfY292ZXJhZ2VcIjogbS5wbGFubmluZz8ucmVxdWlyZW1lbnRDb3ZlcmFnZSA/PyBcIlwiLFxuICAgIFwiOmJvdW5kYXJ5X21hcF9tYXJrZG93blwiOiBtLnBsYW5uaW5nPy5ib3VuZGFyeU1hcE1hcmtkb3duID8/IFwiXCIsXG4gIH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdXBzZXJ0TWlsZXN0b25lUGxhbm5pbmcobWlsZXN0b25lSWQ6IHN0cmluZywgcGxhbm5pbmc6IFBhcnRpYWw8TWlsZXN0b25lUGxhbm5pbmdSZWNvcmQ+ICYgeyB0aXRsZT86IHN0cmluZzsgc3RhdHVzPzogc3RyaW5nIH0pOiB2b2lkIHtcbiAgaWYgKCFjdXJyZW50RGIpIHRocm93IG5ldyBHU0RFcnJvcihHU0RfU1RBTEVfU1RBVEUsIFwiZ3NkLWRiOiBObyBkYXRhYmFzZSBvcGVuXCIpO1xuICBjdXJyZW50RGIucHJlcGFyZShcbiAgICBgVVBEQVRFIG1pbGVzdG9uZXMgU0VUXG4gICAgICB0aXRsZSA9IENPQUxFU0NFKE5VTExJRig6dGl0bGUsICcnKSwgdGl0bGUpLFxuICAgICAgc3RhdHVzID0gQ09BTEVTQ0UoTlVMTElGKDpzdGF0dXMsICcnKSwgc3RhdHVzKSxcbiAgICAgIHZpc2lvbiA9IENPQUxFU0NFKDp2aXNpb24sIHZpc2lvbiksXG4gICAgICBzdWNjZXNzX2NyaXRlcmlhID0gQ09BTEVTQ0UoOnN1Y2Nlc3NfY3JpdGVyaWEsIHN1Y2Nlc3NfY3JpdGVyaWEpLFxuICAgICAga2V5X3Jpc2tzID0gQ09BTEVTQ0UoOmtleV9yaXNrcywga2V5X3Jpc2tzKSxcbiAgICAgIHByb29mX3N0cmF0ZWd5ID0gQ09BTEVTQ0UoOnByb29mX3N0cmF0ZWd5LCBwcm9vZl9zdHJhdGVneSksXG4gICAgICB2ZXJpZmljYXRpb25fY29udHJhY3QgPSBDT0FMRVNDRSg6dmVyaWZpY2F0aW9uX2NvbnRyYWN0LCB2ZXJpZmljYXRpb25fY29udHJhY3QpLFxuICAgICAgdmVyaWZpY2F0aW9uX2ludGVncmF0aW9uID0gQ09BTEVTQ0UoOnZlcmlmaWNhdGlvbl9pbnRlZ3JhdGlvbiwgdmVyaWZpY2F0aW9uX2ludGVncmF0aW9uKSxcbiAgICAgIHZlcmlmaWNhdGlvbl9vcGVyYXRpb25hbCA9IENPQUxFU0NFKDp2ZXJpZmljYXRpb25fb3BlcmF0aW9uYWwsIHZlcmlmaWNhdGlvbl9vcGVyYXRpb25hbCksXG4gICAgICB2ZXJpZmljYXRpb25fdWF0ID0gQ09BTEVTQ0UoOnZlcmlmaWNhdGlvbl91YXQsIHZlcmlmaWNhdGlvbl91YXQpLFxuICAgICAgZGVmaW5pdGlvbl9vZl9kb25lID0gQ09BTEVTQ0UoOmRlZmluaXRpb25fb2ZfZG9uZSwgZGVmaW5pdGlvbl9vZl9kb25lKSxcbiAgICAgIHJlcXVpcmVtZW50X2NvdmVyYWdlID0gQ09BTEVTQ0UoOnJlcXVpcmVtZW50X2NvdmVyYWdlLCByZXF1aXJlbWVudF9jb3ZlcmFnZSksXG4gICAgICBib3VuZGFyeV9tYXBfbWFya2Rvd24gPSBDT0FMRVNDRSg6Ym91bmRhcnlfbWFwX21hcmtkb3duLCBib3VuZGFyeV9tYXBfbWFya2Rvd24pXG4gICAgIFdIRVJFIGlkID0gOmlkYCxcbiAgKS5ydW4oe1xuICAgIFwiOmlkXCI6IG1pbGVzdG9uZUlkLFxuICAgIFwiOnRpdGxlXCI6IHBsYW5uaW5nLnRpdGxlID8/IFwiXCIsXG4gICAgXCI6c3RhdHVzXCI6IHBsYW5uaW5nLnN0YXR1cyA/PyBcIlwiLFxuICAgIFwiOnZpc2lvblwiOiBwbGFubmluZy52aXNpb24gPz8gbnVsbCxcbiAgICBcIjpzdWNjZXNzX2NyaXRlcmlhXCI6IHBsYW5uaW5nLnN1Y2Nlc3NDcml0ZXJpYSA/IEpTT04uc3RyaW5naWZ5KHBsYW5uaW5nLnN1Y2Nlc3NDcml0ZXJpYSkgOiBudWxsLFxuICAgIFwiOmtleV9yaXNrc1wiOiBwbGFubmluZy5rZXlSaXNrcyA/IEpTT04uc3RyaW5naWZ5KHBsYW5uaW5nLmtleVJpc2tzKSA6IG51bGwsXG4gICAgXCI6cHJvb2Zfc3RyYXRlZ3lcIjogcGxhbm5pbmcucHJvb2ZTdHJhdGVneSA/IEpTT04uc3RyaW5naWZ5KHBsYW5uaW5nLnByb29mU3RyYXRlZ3kpIDogbnVsbCxcbiAgICBcIjp2ZXJpZmljYXRpb25fY29udHJhY3RcIjogcGxhbm5pbmcudmVyaWZpY2F0aW9uQ29udHJhY3QgPz8gbnVsbCxcbiAgICBcIjp2ZXJpZmljYXRpb25faW50ZWdyYXRpb25cIjogcGxhbm5pbmcudmVyaWZpY2F0aW9uSW50ZWdyYXRpb24gPz8gbnVsbCxcbiAgICBcIjp2ZXJpZmljYXRpb25fb3BlcmF0aW9uYWxcIjogcGxhbm5pbmcudmVyaWZpY2F0aW9uT3BlcmF0aW9uYWwgPz8gbnVsbCxcbiAgICBcIjp2ZXJpZmljYXRpb25fdWF0XCI6IHBsYW5uaW5nLnZlcmlmaWNhdGlvblVhdCA/PyBudWxsLFxuICAgIFwiOmRlZmluaXRpb25fb2ZfZG9uZVwiOiBwbGFubmluZy5kZWZpbml0aW9uT2ZEb25lID8gSlNPTi5zdHJpbmdpZnkocGxhbm5pbmcuZGVmaW5pdGlvbk9mRG9uZSkgOiBudWxsLFxuICAgIFwiOnJlcXVpcmVtZW50X2NvdmVyYWdlXCI6IHBsYW5uaW5nLnJlcXVpcmVtZW50Q292ZXJhZ2UgPz8gbnVsbCxcbiAgICBcIjpib3VuZGFyeV9tYXBfbWFya2Rvd25cIjogcGxhbm5pbmcuYm91bmRhcnlNYXBNYXJrZG93biA/PyBudWxsLFxuICB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGluc2VydFNsaWNlKHM6IHtcbiAgaWQ6IHN0cmluZztcbiAgbWlsZXN0b25lSWQ6IHN0cmluZztcbiAgdGl0bGU/OiBzdHJpbmc7XG4gIHN0YXR1cz86IHN0cmluZztcbiAgcmlzaz86IHN0cmluZztcbiAgZGVwZW5kcz86IHN0cmluZ1tdO1xuICBkZW1vPzogc3RyaW5nO1xuICBzZXF1ZW5jZT86IG51bWJlcjtcbiAgaXNTa2V0Y2g/OiBib29sZWFuO1xuICBza2V0Y2hTY29wZT86IHN0cmluZztcbiAgcGxhbm5pbmc/OiBQYXJ0aWFsPFNsaWNlUGxhbm5pbmdSZWNvcmQ+O1xufSk6IHZvaWQge1xuICBpZiAoIWN1cnJlbnREYikgdGhyb3cgbmV3IEdTREVycm9yKEdTRF9TVEFMRV9TVEFURSwgXCJnc2QtZGI6IE5vIGRhdGFiYXNlIG9wZW5cIik7XG4gIGN1cnJlbnREYi5wcmVwYXJlKFxuICAgIGBJTlNFUlQgSU5UTyBzbGljZXMgKFxuICAgICAgbWlsZXN0b25lX2lkLCBpZCwgdGl0bGUsIHN0YXR1cywgcmlzaywgZGVwZW5kcywgZGVtbywgY3JlYXRlZF9hdCxcbiAgICAgIGdvYWwsIHN1Y2Nlc3NfY3JpdGVyaWEsIHByb29mX2xldmVsLCBpbnRlZ3JhdGlvbl9jbG9zdXJlLCBvYnNlcnZhYmlsaXR5X2ltcGFjdCwgc2VxdWVuY2UsXG4gICAgICBpc19za2V0Y2gsIHNrZXRjaF9zY29wZVxuICAgICkgVkFMVUVTIChcbiAgICAgIDptaWxlc3RvbmVfaWQsIDppZCwgOnRpdGxlLCA6c3RhdHVzLCA6cmlzaywgOmRlcGVuZHMsIDpkZW1vLCA6Y3JlYXRlZF9hdCxcbiAgICAgIDpnb2FsLCA6c3VjY2Vzc19jcml0ZXJpYSwgOnByb29mX2xldmVsLCA6aW50ZWdyYXRpb25fY2xvc3VyZSwgOm9ic2VydmFiaWxpdHlfaW1wYWN0LCA6c2VxdWVuY2UsXG4gICAgICA6aXNfc2tldGNoLCA6c2tldGNoX3Njb3BlXG4gICAgKVxuICAgIE9OIENPTkZMSUNUIChtaWxlc3RvbmVfaWQsIGlkKSBETyBVUERBVEUgU0VUXG4gICAgICB0aXRsZSA9IENBU0UgV0hFTiA6cmF3X3RpdGxlIElTIE5PVCBOVUxMIFRIRU4gZXhjbHVkZWQudGl0bGUgRUxTRSBzbGljZXMudGl0bGUgRU5ELFxuICAgICAgc3RhdHVzID0gQ0FTRSBXSEVOIHNsaWNlcy5zdGF0dXMgSU4gKCdjb21wbGV0ZScsICdkb25lJykgVEhFTiBzbGljZXMuc3RhdHVzIEVMU0UgZXhjbHVkZWQuc3RhdHVzIEVORCxcbiAgICAgIHJpc2sgPSBDQVNFIFdIRU4gOnJhd19yaXNrIElTIE5PVCBOVUxMIFRIRU4gZXhjbHVkZWQucmlzayBFTFNFIHNsaWNlcy5yaXNrIEVORCxcbiAgICAgIGRlcGVuZHMgPSBleGNsdWRlZC5kZXBlbmRzLFxuICAgICAgZGVtbyA9IENBU0UgV0hFTiA6cmF3X2RlbW8gSVMgTk9UIE5VTEwgVEhFTiBleGNsdWRlZC5kZW1vIEVMU0Ugc2xpY2VzLmRlbW8gRU5ELFxuICAgICAgZ29hbCA9IENBU0UgV0hFTiA6cmF3X2dvYWwgSVMgTk9UIE5VTEwgVEhFTiBleGNsdWRlZC5nb2FsIEVMU0Ugc2xpY2VzLmdvYWwgRU5ELFxuICAgICAgc3VjY2Vzc19jcml0ZXJpYSA9IENBU0UgV0hFTiA6cmF3X3N1Y2Nlc3NfY3JpdGVyaWEgSVMgTk9UIE5VTEwgVEhFTiBleGNsdWRlZC5zdWNjZXNzX2NyaXRlcmlhIEVMU0Ugc2xpY2VzLnN1Y2Nlc3NfY3JpdGVyaWEgRU5ELFxuICAgICAgcHJvb2ZfbGV2ZWwgPSBDQVNFIFdIRU4gOnJhd19wcm9vZl9sZXZlbCBJUyBOT1QgTlVMTCBUSEVOIGV4Y2x1ZGVkLnByb29mX2xldmVsIEVMU0Ugc2xpY2VzLnByb29mX2xldmVsIEVORCxcbiAgICAgIGludGVncmF0aW9uX2Nsb3N1cmUgPSBDQVNFIFdIRU4gOnJhd19pbnRlZ3JhdGlvbl9jbG9zdXJlIElTIE5PVCBOVUxMIFRIRU4gZXhjbHVkZWQuaW50ZWdyYXRpb25fY2xvc3VyZSBFTFNFIHNsaWNlcy5pbnRlZ3JhdGlvbl9jbG9zdXJlIEVORCxcbiAgICAgIG9ic2VydmFiaWxpdHlfaW1wYWN0ID0gQ0FTRSBXSEVOIDpyYXdfb2JzZXJ2YWJpbGl0eV9pbXBhY3QgSVMgTk9UIE5VTEwgVEhFTiBleGNsdWRlZC5vYnNlcnZhYmlsaXR5X2ltcGFjdCBFTFNFIHNsaWNlcy5vYnNlcnZhYmlsaXR5X2ltcGFjdCBFTkQsXG4gICAgICBzZXF1ZW5jZSA9IENBU0UgV0hFTiA6cmF3X3NlcXVlbmNlIElTIE5PVCBOVUxMIFRIRU4gZXhjbHVkZWQuc2VxdWVuY2UgRUxTRSBzbGljZXMuc2VxdWVuY2UgRU5ELFxuICAgICAgaXNfc2tldGNoID0gQ0FTRSBXSEVOIDpyYXdfaXNfc2tldGNoIElTIE5PVCBOVUxMIFRIRU4gZXhjbHVkZWQuaXNfc2tldGNoIEVMU0Ugc2xpY2VzLmlzX3NrZXRjaCBFTkQsXG4gICAgICBza2V0Y2hfc2NvcGUgPSBDQVNFIFdIRU4gOnJhd19za2V0Y2hfc2NvcGUgSVMgTk9UIE5VTEwgVEhFTiBleGNsdWRlZC5za2V0Y2hfc2NvcGUgRUxTRSBzbGljZXMuc2tldGNoX3Njb3BlIEVORGAsXG4gICkucnVuKHtcbiAgICBcIjptaWxlc3RvbmVfaWRcIjogcy5taWxlc3RvbmVJZCxcbiAgICBcIjppZFwiOiBzLmlkLFxuICAgIFwiOnRpdGxlXCI6IHMudGl0bGUgPz8gXCJcIixcbiAgICBcIjpzdGF0dXNcIjogcy5zdGF0dXMgPz8gXCJwZW5kaW5nXCIsXG4gICAgXCI6cmlza1wiOiBzLnJpc2sgPz8gXCJtZWRpdW1cIixcbiAgICBcIjpkZXBlbmRzXCI6IEpTT04uc3RyaW5naWZ5KHMuZGVwZW5kcyA/PyBbXSksXG4gICAgXCI6ZGVtb1wiOiBzLmRlbW8gPz8gXCJcIixcbiAgICBcIjpjcmVhdGVkX2F0XCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICBcIjpnb2FsXCI6IHMucGxhbm5pbmc/LmdvYWwgPz8gXCJcIixcbiAgICBcIjpzdWNjZXNzX2NyaXRlcmlhXCI6IHMucGxhbm5pbmc/LnN1Y2Nlc3NDcml0ZXJpYSA/PyBcIlwiLFxuICAgIFwiOnByb29mX2xldmVsXCI6IHMucGxhbm5pbmc/LnByb29mTGV2ZWwgPz8gXCJcIixcbiAgICBcIjppbnRlZ3JhdGlvbl9jbG9zdXJlXCI6IHMucGxhbm5pbmc/LmludGVncmF0aW9uQ2xvc3VyZSA/PyBcIlwiLFxuICAgIFwiOm9ic2VydmFiaWxpdHlfaW1wYWN0XCI6IHMucGxhbm5pbmc/Lm9ic2VydmFiaWxpdHlJbXBhY3QgPz8gXCJcIixcbiAgICBcIjpzZXF1ZW5jZVwiOiBzLnNlcXVlbmNlID8/IDAsXG4gICAgXCI6aXNfc2tldGNoXCI6IHMuaXNTa2V0Y2ggPyAxIDogMCxcbiAgICBcIjpza2V0Y2hfc2NvcGVcIjogcy5za2V0Y2hTY29wZSA/PyBcIlwiLFxuICAgIC8vIFJhdyBzZW50aW5lbCBwYXJhbXM6IE5VTEwgd2hlbiBjYWxsZXIgb21pdHRlZCB0aGUgZmllbGQsIHVzZWQgaW4gT04gQ09ORkxJQ1QgZ3VhcmRzXG4gICAgXCI6cmF3X3RpdGxlXCI6IHMudGl0bGUgPz8gbnVsbCxcbiAgICBcIjpyYXdfcmlza1wiOiBzLnJpc2sgPz8gbnVsbCxcbiAgICBcIjpyYXdfZGVtb1wiOiBzLmRlbW8gPz8gbnVsbCxcbiAgICBcIjpyYXdfZ29hbFwiOiBzLnBsYW5uaW5nPy5nb2FsID8/IG51bGwsXG4gICAgXCI6cmF3X3N1Y2Nlc3NfY3JpdGVyaWFcIjogcy5wbGFubmluZz8uc3VjY2Vzc0NyaXRlcmlhID8/IG51bGwsXG4gICAgXCI6cmF3X3Byb29mX2xldmVsXCI6IHMucGxhbm5pbmc/LnByb29mTGV2ZWwgPz8gbnVsbCxcbiAgICBcIjpyYXdfaW50ZWdyYXRpb25fY2xvc3VyZVwiOiBzLnBsYW5uaW5nPy5pbnRlZ3JhdGlvbkNsb3N1cmUgPz8gbnVsbCxcbiAgICBcIjpyYXdfb2JzZXJ2YWJpbGl0eV9pbXBhY3RcIjogcy5wbGFubmluZz8ub2JzZXJ2YWJpbGl0eUltcGFjdCA/PyBudWxsLFxuICAgIFwiOnJhd19zZXF1ZW5jZVwiOiBzLnNlcXVlbmNlID8/IG51bGwsXG4gICAgXCI6cmF3X2lzX3NrZXRjaFwiOiBzLmlzU2tldGNoID09PSB1bmRlZmluZWQgPyBudWxsIDogKHMuaXNTa2V0Y2ggPyAxIDogMCksXG4gICAgLy8gTk9URTogdXNlICE9PSB1bmRlZmluZWQgKG5vdCA/Pykgc28gYW4gZXhwbGljaXQgZW1wdHkgc3RyaW5nIFwiXCIgaXMgdHJlYXRlZFxuICAgIC8vIGFzIGEgcHJlc2VudCB2YWx1ZSBhbmQgY29ycmVjdGx5IGNsZWFycyB0aGUgZXhpc3Rpbmcgc2tldGNoX3Njb3BlIG9uXG4gICAgLy8gQ09ORkxJQ1QuID8/IHdvdWxkIGluY29ycmVjdGx5IHByZXNlcnZlIHRoZSBzdGFsZSB2YWx1ZS5cbiAgICBcIjpyYXdfc2tldGNoX3Njb3BlXCI6IHMuc2tldGNoU2NvcGUgIT09IHVuZGVmaW5lZCA/IHMuc2tldGNoU2NvcGUgOiBudWxsLFxuICB9KTtcbn1cblxuLy8gQURSLTAxMTogc2tldGNoLXRoZW4tcmVmaW5lIGhlbHBlcnNcbmV4cG9ydCBmdW5jdGlvbiBzZXRTbGljZVNrZXRjaEZsYWcobWlsZXN0b25lSWQ6IHN0cmluZywgc2xpY2VJZDogc3RyaW5nLCBpc1NrZXRjaDogYm9vbGVhbik6IHZvaWQge1xuICBpZiAoIWN1cnJlbnREYikgdGhyb3cgbmV3IEdTREVycm9yKEdTRF9TVEFMRV9TVEFURSwgXCJnc2QtZGI6IE5vIGRhdGFiYXNlIG9wZW5cIik7XG4gIGN1cnJlbnREYi5wcmVwYXJlKFxuICAgIGBVUERBVEUgc2xpY2VzIFNFVCBpc19za2V0Y2ggPSA6aXNfc2tldGNoIFdIRVJFIG1pbGVzdG9uZV9pZCA9IDptaWQgQU5EIGlkID0gOnNpZGAsXG4gICkucnVuKHsgXCI6aXNfc2tldGNoXCI6IGlzU2tldGNoID8gMSA6IDAsIFwiOm1pZFwiOiBtaWxlc3RvbmVJZCwgXCI6c2lkXCI6IHNsaWNlSWQgfSk7XG59XG5cbi8qKlxuICogQURSLTAxNyByYXcgcHJpbWl0aXZlOiByZXR1cm5zIHNsaWNlIElEcyBpbiBhIG1pbGVzdG9uZSB3aG9zZSBpc19za2V0Y2ggZmxhZ1xuICogaXMgc3RpbGwgMS4gVGhlIHN0YWxlLXNrZXRjaC1mbGFnIGRyaWZ0IGhhbmRsZXIgYXRcbiAqIGBzdGF0ZS1yZWNvbmNpbGlhdGlvbi9kcmlmdC9za2V0Y2gtZmxhZy50c2AgY29tcG9zZXMgdGhpcyB3aXRoIFBMQU4ubWRcbiAqIGV4aXN0ZW5jZSBjaGVja3MgdG8gZGV0ZWN0IGRyaWZ0LCB0aGVuIHdyaXRlcyB2aWEgYHNldFNsaWNlU2tldGNoRmxhZ2AuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRTa2V0Y2hlZFNsaWNlSWRzKG1pbGVzdG9uZUlkOiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIGlmICghY3VycmVudERiKSByZXR1cm4gW107XG4gIGNvbnN0IHJvd3MgPSBjdXJyZW50RGIucHJlcGFyZShcbiAgICBgU0VMRUNUIGlkIEZST00gc2xpY2VzIFdIRVJFIG1pbGVzdG9uZV9pZCA9IDptaWQgQU5EIGlzX3NrZXRjaCA9IDFgLFxuICApLmFsbCh7IFwiOm1pZFwiOiBtaWxlc3RvbmVJZCB9KSBhcyBBcnJheTx7IGlkOiBzdHJpbmcgfT47XG4gIHJldHVybiByb3dzLm1hcCgocikgPT4gci5pZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB1cHNlcnRTbGljZVBsYW5uaW5nKG1pbGVzdG9uZUlkOiBzdHJpbmcsIHNsaWNlSWQ6IHN0cmluZywgcGxhbm5pbmc6IFBhcnRpYWw8U2xpY2VQbGFubmluZ1JlY29yZD4pOiB2b2lkIHtcbiAgaWYgKCFjdXJyZW50RGIpIHRocm93IG5ldyBHU0RFcnJvcihHU0RfU1RBTEVfU1RBVEUsIFwiZ3NkLWRiOiBObyBkYXRhYmFzZSBvcGVuXCIpO1xuICBjdXJyZW50RGIucHJlcGFyZShcbiAgICBgVVBEQVRFIHNsaWNlcyBTRVRcbiAgICAgIGdvYWwgPSBDT0FMRVNDRSg6Z29hbCwgZ29hbCksXG4gICAgICBzdWNjZXNzX2NyaXRlcmlhID0gQ09BTEVTQ0UoOnN1Y2Nlc3NfY3JpdGVyaWEsIHN1Y2Nlc3NfY3JpdGVyaWEpLFxuICAgICAgcHJvb2ZfbGV2ZWwgPSBDT0FMRVNDRSg6cHJvb2ZfbGV2ZWwsIHByb29mX2xldmVsKSxcbiAgICAgIGludGVncmF0aW9uX2Nsb3N1cmUgPSBDT0FMRVNDRSg6aW50ZWdyYXRpb25fY2xvc3VyZSwgaW50ZWdyYXRpb25fY2xvc3VyZSksXG4gICAgICBvYnNlcnZhYmlsaXR5X2ltcGFjdCA9IENPQUxFU0NFKDpvYnNlcnZhYmlsaXR5X2ltcGFjdCwgb2JzZXJ2YWJpbGl0eV9pbXBhY3QpXG4gICAgIFdIRVJFIG1pbGVzdG9uZV9pZCA9IDptaWxlc3RvbmVfaWQgQU5EIGlkID0gOmlkYCxcbiAgKS5ydW4oe1xuICAgIFwiOm1pbGVzdG9uZV9pZFwiOiBtaWxlc3RvbmVJZCxcbiAgICBcIjppZFwiOiBzbGljZUlkLFxuICAgIFwiOmdvYWxcIjogcGxhbm5pbmcuZ29hbCA/PyBudWxsLFxuICAgIFwiOnN1Y2Nlc3NfY3JpdGVyaWFcIjogcGxhbm5pbmcuc3VjY2Vzc0NyaXRlcmlhID8/IG51bGwsXG4gICAgXCI6cHJvb2ZfbGV2ZWxcIjogcGxhbm5pbmcucHJvb2ZMZXZlbCA/PyBudWxsLFxuICAgIFwiOmludGVncmF0aW9uX2Nsb3N1cmVcIjogcGxhbm5pbmcuaW50ZWdyYXRpb25DbG9zdXJlID8/IG51bGwsXG4gICAgXCI6b2JzZXJ2YWJpbGl0eV9pbXBhY3RcIjogcGxhbm5pbmcub2JzZXJ2YWJpbGl0eUltcGFjdCA/PyBudWxsLFxuICB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGluc2VydFRhc2sodDoge1xuICBpZDogc3RyaW5nO1xuICBzbGljZUlkOiBzdHJpbmc7XG4gIG1pbGVzdG9uZUlkOiBzdHJpbmc7XG4gIHRpdGxlPzogc3RyaW5nO1xuICBzdGF0dXM/OiBzdHJpbmc7XG4gIG9uZUxpbmVyPzogc3RyaW5nO1xuICBuYXJyYXRpdmU/OiBzdHJpbmc7XG4gIHZlcmlmaWNhdGlvblJlc3VsdD86IHN0cmluZztcbiAgZHVyYXRpb24/OiBzdHJpbmc7XG4gIGJsb2NrZXJEaXNjb3ZlcmVkPzogYm9vbGVhbjtcbiAgZGV2aWF0aW9ucz86IHN0cmluZztcbiAga25vd25Jc3N1ZXM/OiBzdHJpbmc7XG4gIGtleUZpbGVzPzogc3RyaW5nW107XG4gIGtleURlY2lzaW9ucz86IHN0cmluZ1tdO1xuICBmdWxsU3VtbWFyeU1kPzogc3RyaW5nO1xuICBzZXF1ZW5jZT86IG51bWJlcjtcbiAgcGxhbm5pbmc/OiBQYXJ0aWFsPFRhc2tQbGFubmluZ1JlY29yZD47XG59KTogdm9pZCB7XG4gIGlmICghY3VycmVudERiKSB0aHJvdyBuZXcgR1NERXJyb3IoR1NEX1NUQUxFX1NUQVRFLCBcImdzZC1kYjogTm8gZGF0YWJhc2Ugb3BlblwiKTtcbiAgY3VycmVudERiLnByZXBhcmUoXG4gICAgYElOU0VSVCBJTlRPIHRhc2tzIChcbiAgICAgIG1pbGVzdG9uZV9pZCwgc2xpY2VfaWQsIGlkLCB0aXRsZSwgc3RhdHVzLCBvbmVfbGluZXIsIG5hcnJhdGl2ZSxcbiAgICAgIHZlcmlmaWNhdGlvbl9yZXN1bHQsIGR1cmF0aW9uLCBjb21wbGV0ZWRfYXQsIGJsb2NrZXJfZGlzY292ZXJlZCxcbiAgICAgIGRldmlhdGlvbnMsIGtub3duX2lzc3Vlcywga2V5X2ZpbGVzLCBrZXlfZGVjaXNpb25zLCBmdWxsX3N1bW1hcnlfbWQsXG4gICAgICBkZXNjcmlwdGlvbiwgZXN0aW1hdGUsIGZpbGVzLCB2ZXJpZnksIGlucHV0cywgZXhwZWN0ZWRfb3V0cHV0LCBvYnNlcnZhYmlsaXR5X2ltcGFjdCwgc2VxdWVuY2VcbiAgICApIFZBTFVFUyAoXG4gICAgICA6bWlsZXN0b25lX2lkLCA6c2xpY2VfaWQsIDppZCwgOnRpdGxlLCA6c3RhdHVzLCA6b25lX2xpbmVyLCA6bmFycmF0aXZlLFxuICAgICAgOnZlcmlmaWNhdGlvbl9yZXN1bHQsIDpkdXJhdGlvbiwgOmNvbXBsZXRlZF9hdCwgOmJsb2NrZXJfZGlzY292ZXJlZCxcbiAgICAgIDpkZXZpYXRpb25zLCA6a25vd25faXNzdWVzLCA6a2V5X2ZpbGVzLCA6a2V5X2RlY2lzaW9ucywgOmZ1bGxfc3VtbWFyeV9tZCxcbiAgICAgIDpkZXNjcmlwdGlvbiwgOmVzdGltYXRlLCA6ZmlsZXMsIDp2ZXJpZnksIDppbnB1dHMsIDpleHBlY3RlZF9vdXRwdXQsIDpvYnNlcnZhYmlsaXR5X2ltcGFjdCwgOnNlcXVlbmNlXG4gICAgKVxuICAgIE9OIENPTkZMSUNUKG1pbGVzdG9uZV9pZCwgc2xpY2VfaWQsIGlkKSBETyBVUERBVEUgU0VUXG4gICAgICB0aXRsZSA9IENBU0UgV0hFTiBOVUxMSUYoOnRpdGxlLCAnJykgSVMgTk9UIE5VTEwgVEhFTiA6dGl0bGUgRUxTRSB0YXNrcy50aXRsZSBFTkQsXG4gICAgICBzdGF0dXMgPSA6c3RhdHVzLFxuICAgICAgb25lX2xpbmVyID0gOm9uZV9saW5lcixcbiAgICAgIG5hcnJhdGl2ZSA9IDpuYXJyYXRpdmUsXG4gICAgICB2ZXJpZmljYXRpb25fcmVzdWx0ID0gOnZlcmlmaWNhdGlvbl9yZXN1bHQsXG4gICAgICBkdXJhdGlvbiA9IDpkdXJhdGlvbixcbiAgICAgIGNvbXBsZXRlZF9hdCA9IDpjb21wbGV0ZWRfYXQsXG4gICAgICBibG9ja2VyX2Rpc2NvdmVyZWQgPSA6YmxvY2tlcl9kaXNjb3ZlcmVkLFxuICAgICAgZGV2aWF0aW9ucyA9IDpkZXZpYXRpb25zLFxuICAgICAga25vd25faXNzdWVzID0gOmtub3duX2lzc3VlcyxcbiAgICAgIGtleV9maWxlcyA9IDprZXlfZmlsZXMsXG4gICAgICBrZXlfZGVjaXNpb25zID0gOmtleV9kZWNpc2lvbnMsXG4gICAgICBmdWxsX3N1bW1hcnlfbWQgPSA6ZnVsbF9zdW1tYXJ5X21kLFxuICAgICAgZGVzY3JpcHRpb24gPSBDQVNFIFdIRU4gTlVMTElGKDpkZXNjcmlwdGlvbiwgJycpIElTIE5PVCBOVUxMIFRIRU4gOmRlc2NyaXB0aW9uIEVMU0UgdGFza3MuZGVzY3JpcHRpb24gRU5ELFxuICAgICAgZXN0aW1hdGUgPSBDQVNFIFdIRU4gTlVMTElGKDplc3RpbWF0ZSwgJycpIElTIE5PVCBOVUxMIFRIRU4gOmVzdGltYXRlIEVMU0UgdGFza3MuZXN0aW1hdGUgRU5ELFxuICAgICAgZmlsZXMgPSBDQVNFIFdIRU4gTlVMTElGKDpmaWxlcywgJ1tdJykgSVMgTk9UIE5VTEwgVEhFTiA6ZmlsZXMgRUxTRSB0YXNrcy5maWxlcyBFTkQsXG4gICAgICB2ZXJpZnkgPSBDQVNFIFdIRU4gTlVMTElGKDp2ZXJpZnksICcnKSBJUyBOT1QgTlVMTCBUSEVOIDp2ZXJpZnkgRUxTRSB0YXNrcy52ZXJpZnkgRU5ELFxuICAgICAgaW5wdXRzID0gQ0FTRSBXSEVOIE5VTExJRig6aW5wdXRzLCAnW10nKSBJUyBOT1QgTlVMTCBUSEVOIDppbnB1dHMgRUxTRSB0YXNrcy5pbnB1dHMgRU5ELFxuICAgICAgZXhwZWN0ZWRfb3V0cHV0ID0gQ0FTRSBXSEVOIE5VTExJRig6ZXhwZWN0ZWRfb3V0cHV0LCAnW10nKSBJUyBOT1QgTlVMTCBUSEVOIDpleHBlY3RlZF9vdXRwdXQgRUxTRSB0YXNrcy5leHBlY3RlZF9vdXRwdXQgRU5ELFxuICAgICAgb2JzZXJ2YWJpbGl0eV9pbXBhY3QgPSBDQVNFIFdIRU4gTlVMTElGKDpvYnNlcnZhYmlsaXR5X2ltcGFjdCwgJycpIElTIE5PVCBOVUxMIFRIRU4gOm9ic2VydmFiaWxpdHlfaW1wYWN0IEVMU0UgdGFza3Mub2JzZXJ2YWJpbGl0eV9pbXBhY3QgRU5ELFxuICAgICAgc2VxdWVuY2UgPSA6c2VxdWVuY2VgLFxuICApLnJ1bih7XG4gICAgXCI6bWlsZXN0b25lX2lkXCI6IHQubWlsZXN0b25lSWQsXG4gICAgXCI6c2xpY2VfaWRcIjogdC5zbGljZUlkLFxuICAgIFwiOmlkXCI6IHQuaWQsXG4gICAgXCI6dGl0bGVcIjogdC50aXRsZSA/PyBcIlwiLFxuICAgIFwiOnN0YXR1c1wiOiB0LnN0YXR1cyA/PyBcInBlbmRpbmdcIixcbiAgICBcIjpvbmVfbGluZXJcIjogdC5vbmVMaW5lciA/PyBcIlwiLFxuICAgIFwiOm5hcnJhdGl2ZVwiOiB0Lm5hcnJhdGl2ZSA/PyBcIlwiLFxuICAgIFwiOnZlcmlmaWNhdGlvbl9yZXN1bHRcIjogdC52ZXJpZmljYXRpb25SZXN1bHQgPz8gXCJcIixcbiAgICBcIjpkdXJhdGlvblwiOiB0LmR1cmF0aW9uID8/IFwiXCIsXG4gICAgXCI6Y29tcGxldGVkX2F0XCI6IHQuc3RhdHVzID09PSBcImRvbmVcIiB8fCB0LnN0YXR1cyA9PT0gXCJjb21wbGV0ZVwiID8gbmV3IERhdGUoKS50b0lTT1N0cmluZygpIDogbnVsbCxcbiAgICBcIjpibG9ja2VyX2Rpc2NvdmVyZWRcIjogdC5ibG9ja2VyRGlzY292ZXJlZCA/IDEgOiAwLFxuICAgIFwiOmRldmlhdGlvbnNcIjogdC5kZXZpYXRpb25zID8/IFwiXCIsXG4gICAgXCI6a25vd25faXNzdWVzXCI6IHQua25vd25Jc3N1ZXMgPz8gXCJcIixcbiAgICBcIjprZXlfZmlsZXNcIjogSlNPTi5zdHJpbmdpZnkodC5rZXlGaWxlcyA/PyBbXSksXG4gICAgXCI6a2V5X2RlY2lzaW9uc1wiOiBKU09OLnN0cmluZ2lmeSh0LmtleURlY2lzaW9ucyA/PyBbXSksXG4gICAgXCI6ZnVsbF9zdW1tYXJ5X21kXCI6IHQuZnVsbFN1bW1hcnlNZCA/PyBcIlwiLFxuICAgIFwiOmRlc2NyaXB0aW9uXCI6IHQucGxhbm5pbmc/LmRlc2NyaXB0aW9uID8/IFwiXCIsXG4gICAgXCI6ZXN0aW1hdGVcIjogdC5wbGFubmluZz8uZXN0aW1hdGUgPz8gXCJcIixcbiAgICBcIjpmaWxlc1wiOiBKU09OLnN0cmluZ2lmeSh0LnBsYW5uaW5nPy5maWxlcyA/PyBbXSksXG4gICAgXCI6dmVyaWZ5XCI6IHQucGxhbm5pbmc/LnZlcmlmeSA/PyBcIlwiLFxuICAgIFwiOmlucHV0c1wiOiBKU09OLnN0cmluZ2lmeSh0LnBsYW5uaW5nPy5pbnB1dHMgPz8gW10pLFxuICAgIFwiOmV4cGVjdGVkX291dHB1dFwiOiBKU09OLnN0cmluZ2lmeSh0LnBsYW5uaW5nPy5leHBlY3RlZE91dHB1dCA/PyBbXSksXG4gICAgXCI6b2JzZXJ2YWJpbGl0eV9pbXBhY3RcIjogdC5wbGFubmluZz8ub2JzZXJ2YWJpbGl0eUltcGFjdCA/PyBcIlwiLFxuICAgIFwiOnNlcXVlbmNlXCI6IHQuc2VxdWVuY2UgPz8gMCxcbiAgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVUYXNrU3RhdHVzKG1pbGVzdG9uZUlkOiBzdHJpbmcsIHNsaWNlSWQ6IHN0cmluZywgdGFza0lkOiBzdHJpbmcsIHN0YXR1czogc3RyaW5nLCBjb21wbGV0ZWRBdD86IHN0cmluZyk6IHZvaWQge1xuICBpZiAoIWN1cnJlbnREYikgdGhyb3cgbmV3IEdTREVycm9yKEdTRF9TVEFMRV9TVEFURSwgXCJnc2QtZGI6IE5vIGRhdGFiYXNlIG9wZW5cIik7XG4gIGN1cnJlbnREYi5wcmVwYXJlKFxuICAgIGBVUERBVEUgdGFza3MgU0VUIHN0YXR1cyA9IDpzdGF0dXMsIGNvbXBsZXRlZF9hdCA9IDpjb21wbGV0ZWRfYXRcbiAgICAgV0hFUkUgbWlsZXN0b25lX2lkID0gOm1pbGVzdG9uZV9pZCBBTkQgc2xpY2VfaWQgPSA6c2xpY2VfaWQgQU5EIGlkID0gOmlkYCxcbiAgKS5ydW4oe1xuICAgIFwiOnN0YXR1c1wiOiBzdGF0dXMsXG4gICAgXCI6Y29tcGxldGVkX2F0XCI6IGNvbXBsZXRlZEF0ID8/IG51bGwsXG4gICAgXCI6bWlsZXN0b25lX2lkXCI6IG1pbGVzdG9uZUlkLFxuICAgIFwiOnNsaWNlX2lkXCI6IHNsaWNlSWQsXG4gICAgXCI6aWRcIjogdGFza0lkLFxuICB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNldFRhc2tCbG9ja2VyRGlzY292ZXJlZChtaWxlc3RvbmVJZDogc3RyaW5nLCBzbGljZUlkOiBzdHJpbmcsIHRhc2tJZDogc3RyaW5nLCBkaXNjb3ZlcmVkOiBib29sZWFuKTogdm9pZCB7XG4gIGlmICghY3VycmVudERiKSByZXR1cm47XG4gIGN1cnJlbnREYi5wcmVwYXJlKFxuICAgIGBVUERBVEUgdGFza3MgU0VUIGJsb2NrZXJfZGlzY292ZXJlZCA9IDpkaXNjb3ZlcmVkIFdIRVJFIG1pbGVzdG9uZV9pZCA9IDptaWQgQU5EIHNsaWNlX2lkID0gOnNpZCBBTkQgaWQgPSA6dGlkYCxcbiAgKS5ydW4oeyBcIjpkaXNjb3ZlcmVkXCI6IGRpc2NvdmVyZWQgPyAxIDogMCwgXCI6bWlkXCI6IG1pbGVzdG9uZUlkLCBcIjpzaWRcIjogc2xpY2VJZCwgXCI6dGlkXCI6IHRhc2tJZCB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHVwc2VydFRhc2tQbGFubmluZyhtaWxlc3RvbmVJZDogc3RyaW5nLCBzbGljZUlkOiBzdHJpbmcsIHRhc2tJZDogc3RyaW5nLCBwbGFubmluZzogUGFydGlhbDxUYXNrUGxhbm5pbmdSZWNvcmQ+KTogdm9pZCB7XG4gIGlmICghY3VycmVudERiKSB0aHJvdyBuZXcgR1NERXJyb3IoR1NEX1NUQUxFX1NUQVRFLCBcImdzZC1kYjogTm8gZGF0YWJhc2Ugb3BlblwiKTtcbiAgY3VycmVudERiLnByZXBhcmUoXG4gICAgYFVQREFURSB0YXNrcyBTRVRcbiAgICAgIHRpdGxlID0gQ09BTEVTQ0UoOnRpdGxlLCB0aXRsZSksXG4gICAgICBkZXNjcmlwdGlvbiA9IENPQUxFU0NFKDpkZXNjcmlwdGlvbiwgZGVzY3JpcHRpb24pLFxuICAgICAgZXN0aW1hdGUgPSBDT0FMRVNDRSg6ZXN0aW1hdGUsIGVzdGltYXRlKSxcbiAgICAgIGZpbGVzID0gQ09BTEVTQ0UoOmZpbGVzLCBmaWxlcyksXG4gICAgICB2ZXJpZnkgPSBDT0FMRVNDRSg6dmVyaWZ5LCB2ZXJpZnkpLFxuICAgICAgaW5wdXRzID0gQ09BTEVTQ0UoOmlucHV0cywgaW5wdXRzKSxcbiAgICAgIGV4cGVjdGVkX291dHB1dCA9IENPQUxFU0NFKDpleHBlY3RlZF9vdXRwdXQsIGV4cGVjdGVkX291dHB1dCksXG4gICAgICBvYnNlcnZhYmlsaXR5X2ltcGFjdCA9IENPQUxFU0NFKDpvYnNlcnZhYmlsaXR5X2ltcGFjdCwgb2JzZXJ2YWJpbGl0eV9pbXBhY3QpLFxuICAgICAgZnVsbF9wbGFuX21kID0gQ09BTEVTQ0UoOmZ1bGxfcGxhbl9tZCwgZnVsbF9wbGFuX21kKVxuICAgICBXSEVSRSBtaWxlc3RvbmVfaWQgPSA6bWlsZXN0b25lX2lkIEFORCBzbGljZV9pZCA9IDpzbGljZV9pZCBBTkQgaWQgPSA6aWRgLFxuICApLnJ1bih7XG4gICAgXCI6bWlsZXN0b25lX2lkXCI6IG1pbGVzdG9uZUlkLFxuICAgIFwiOnNsaWNlX2lkXCI6IHNsaWNlSWQsXG4gICAgXCI6aWRcIjogdGFza0lkLFxuICAgIFwiOnRpdGxlXCI6IHBsYW5uaW5nLnRpdGxlID8/IG51bGwsXG4gICAgXCI6ZGVzY3JpcHRpb25cIjogcGxhbm5pbmcuZGVzY3JpcHRpb24gPz8gbnVsbCxcbiAgICBcIjplc3RpbWF0ZVwiOiBwbGFubmluZy5lc3RpbWF0ZSA/PyBudWxsLFxuICAgIFwiOmZpbGVzXCI6IHBsYW5uaW5nLmZpbGVzID8gSlNPTi5zdHJpbmdpZnkocGxhbm5pbmcuZmlsZXMpIDogbnVsbCxcbiAgICBcIjp2ZXJpZnlcIjogcGxhbm5pbmcudmVyaWZ5ID8/IG51bGwsXG4gICAgXCI6aW5wdXRzXCI6IHBsYW5uaW5nLmlucHV0cyA/IEpTT04uc3RyaW5naWZ5KHBsYW5uaW5nLmlucHV0cykgOiBudWxsLFxuICAgIFwiOmV4cGVjdGVkX291dHB1dFwiOiBwbGFubmluZy5leHBlY3RlZE91dHB1dCA/IEpTT04uc3RyaW5naWZ5KHBsYW5uaW5nLmV4cGVjdGVkT3V0cHV0KSA6IG51bGwsXG4gICAgXCI6b2JzZXJ2YWJpbGl0eV9pbXBhY3RcIjogcGxhbm5pbmcub2JzZXJ2YWJpbGl0eUltcGFjdCA/PyBudWxsLFxuICAgIFwiOmZ1bGxfcGxhbl9tZFwiOiBwbGFubmluZy5mdWxsUGxhbk1kID8/IG51bGwsXG4gIH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0U2xpY2UobWlsZXN0b25lSWQ6IHN0cmluZywgc2xpY2VJZDogc3RyaW5nKTogU2xpY2VSb3cgfCBudWxsIHtcbiAgaWYgKCFjdXJyZW50RGIpIHJldHVybiBudWxsO1xuICBjb25zdCByb3cgPSBjdXJyZW50RGIucHJlcGFyZShcIlNFTEVDVCAqIEZST00gc2xpY2VzIFdIRVJFIG1pbGVzdG9uZV9pZCA9IDptaWQgQU5EIGlkID0gOnNpZFwiKS5nZXQoeyBcIjptaWRcIjogbWlsZXN0b25lSWQsIFwiOnNpZFwiOiBzbGljZUlkIH0pO1xuICBpZiAoIXJvdykgcmV0dXJuIG51bGw7XG4gIHJldHVybiByb3dUb1NsaWNlKHJvdyk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVTbGljZVN0YXR1cyhtaWxlc3RvbmVJZDogc3RyaW5nLCBzbGljZUlkOiBzdHJpbmcsIHN0YXR1czogc3RyaW5nLCBjb21wbGV0ZWRBdD86IHN0cmluZyk6IHZvaWQge1xuICBpZiAoIWN1cnJlbnREYikgdGhyb3cgbmV3IEdTREVycm9yKEdTRF9TVEFMRV9TVEFURSwgXCJnc2QtZGI6IE5vIGRhdGFiYXNlIG9wZW5cIik7XG4gIGN1cnJlbnREYi5wcmVwYXJlKFxuICAgIGBVUERBVEUgc2xpY2VzIFNFVCBzdGF0dXMgPSA6c3RhdHVzLCBjb21wbGV0ZWRfYXQgPSA6Y29tcGxldGVkX2F0XG4gICAgIFdIRVJFIG1pbGVzdG9uZV9pZCA9IDptaWxlc3RvbmVfaWQgQU5EIGlkID0gOmlkYCxcbiAgKS5ydW4oe1xuICAgIFwiOnN0YXR1c1wiOiBzdGF0dXMsXG4gICAgXCI6Y29tcGxldGVkX2F0XCI6IGNvbXBsZXRlZEF0ID8/IG51bGwsXG4gICAgXCI6bWlsZXN0b25lX2lkXCI6IG1pbGVzdG9uZUlkLFxuICAgIFwiOmlkXCI6IHNsaWNlSWQsXG4gIH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2V0VGFza1N1bW1hcnlNZChtaWxlc3RvbmVJZDogc3RyaW5nLCBzbGljZUlkOiBzdHJpbmcsIHRhc2tJZDogc3RyaW5nLCBtZDogc3RyaW5nKTogdm9pZCB7XG4gIGlmICghY3VycmVudERiKSB0aHJvdyBuZXcgR1NERXJyb3IoR1NEX1NUQUxFX1NUQVRFLCBcImdzZC1kYjogTm8gZGF0YWJhc2Ugb3BlblwiKTtcbiAgY3VycmVudERiLnByZXBhcmUoXG4gICAgYFVQREFURSB0YXNrcyBTRVQgZnVsbF9zdW1tYXJ5X21kID0gOm1kIFdIRVJFIG1pbGVzdG9uZV9pZCA9IDptaWQgQU5EIHNsaWNlX2lkID0gOnNpZCBBTkQgaWQgPSA6dGlkYCxcbiAgKS5ydW4oeyBcIjptaWRcIjogbWlsZXN0b25lSWQsIFwiOnNpZFwiOiBzbGljZUlkLCBcIjp0aWRcIjogdGFza0lkLCBcIjptZFwiOiBtZCB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNldFNsaWNlU3VtbWFyeU1kKG1pbGVzdG9uZUlkOiBzdHJpbmcsIHNsaWNlSWQ6IHN0cmluZywgc3VtbWFyeU1kOiBzdHJpbmcsIHVhdE1kOiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKCFjdXJyZW50RGIpIHRocm93IG5ldyBHU0RFcnJvcihHU0RfU1RBTEVfU1RBVEUsIFwiZ3NkLWRiOiBObyBkYXRhYmFzZSBvcGVuXCIpO1xuICBjdXJyZW50RGIucHJlcGFyZShcbiAgICBgVVBEQVRFIHNsaWNlcyBTRVQgZnVsbF9zdW1tYXJ5X21kID0gOnN1bW1hcnlfbWQsIGZ1bGxfdWF0X21kID0gOnVhdF9tZCBXSEVSRSBtaWxlc3RvbmVfaWQgPSA6bWlkIEFORCBpZCA9IDpzaWRgLFxuICApLnJ1bih7IFwiOm1pZFwiOiBtaWxlc3RvbmVJZCwgXCI6c2lkXCI6IHNsaWNlSWQsIFwiOnN1bW1hcnlfbWRcIjogc3VtbWFyeU1kLCBcIjp1YXRfbWRcIjogdWF0TWQgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRUYXNrKG1pbGVzdG9uZUlkOiBzdHJpbmcsIHNsaWNlSWQ6IHN0cmluZywgdGFza0lkOiBzdHJpbmcpOiBUYXNrUm93IHwgbnVsbCB7XG4gIGlmICghY3VycmVudERiKSByZXR1cm4gbnVsbDtcbiAgY29uc3Qgcm93ID0gY3VycmVudERiLnByZXBhcmUoXG4gICAgXCJTRUxFQ1QgKiBGUk9NIHRhc2tzIFdIRVJFIG1pbGVzdG9uZV9pZCA9IDptaWQgQU5EIHNsaWNlX2lkID0gOnNpZCBBTkQgaWQgPSA6dGlkXCIsXG4gICkuZ2V0KHsgXCI6bWlkXCI6IG1pbGVzdG9uZUlkLCBcIjpzaWRcIjogc2xpY2VJZCwgXCI6dGlkXCI6IHRhc2tJZCB9KTtcbiAgaWYgKCFyb3cpIHJldHVybiBudWxsO1xuICByZXR1cm4gcm93VG9UYXNrKHJvdyk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRTbGljZVRhc2tzKG1pbGVzdG9uZUlkOiBzdHJpbmcsIHNsaWNlSWQ6IHN0cmluZyk6IFRhc2tSb3dbXSB7XG4gIGlmICghY3VycmVudERiKSByZXR1cm4gW107XG4gIGNvbnN0IHJvd3MgPSBjdXJyZW50RGIucHJlcGFyZShcbiAgICBcIlNFTEVDVCAqIEZST00gdGFza3MgV0hFUkUgbWlsZXN0b25lX2lkID0gOm1pZCBBTkQgc2xpY2VfaWQgPSA6c2lkIE9SREVSIEJZIHNlcXVlbmNlLCBpZFwiLFxuICApLmFsbCh7IFwiOm1pZFwiOiBtaWxlc3RvbmVJZCwgXCI6c2lkXCI6IHNsaWNlSWQgfSk7XG4gIHJldHVybiByb3dzLm1hcChyb3dUb1Rhc2spO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0Q29tcGxldGVkTWlsZXN0b25lVGFza0ZpbGVIaW50cyhtaWxlc3RvbmVJZDogc3RyaW5nKTogc3RyaW5nW10ge1xuICBpZiAoIWN1cnJlbnREYikgcmV0dXJuIFtdO1xuICBjb25zdCByb3dzID0gY3VycmVudERiLnByZXBhcmUoXG4gICAgYFNFTEVDVCBmaWxlcywga2V5X2ZpbGVzXG4gICAgIEZST00gdGFza3NcbiAgICAgV0hFUkUgbWlsZXN0b25lX2lkID0gOm1pZCBBTkQgc3RhdHVzIElOICgnY29tcGxldGUnLCAnZG9uZScpYCxcbiAgKS5hbGwoeyBcIjptaWRcIjogbWlsZXN0b25lSWQgfSkgYXMgQXJyYXk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+O1xuXG4gIGNvbnN0IGhpbnRzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGZvciAoY29uc3Qgcm93IG9mIHJvd3MpIHtcbiAgICBmb3IgKGNvbnN0IHJhdyBvZiBbcm93W1wiZmlsZXNcIl0sIHJvd1tcImtleV9maWxlc1wiXV0pIHtcbiAgICAgIGZvciAoY29uc3QgZmlsZSBvZiBwYXJzZVN0cmluZ0FycmF5Q29sdW1uKHJhdykpIHtcbiAgICAgICAgY29uc3Qgbm9ybWFsaXplZCA9IG5vcm1hbGl6ZVJlcG9QYXRoKGZpbGUpO1xuICAgICAgICBpZiAobm9ybWFsaXplZCkgaGludHMuYWRkKG5vcm1hbGl6ZWQpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuICByZXR1cm4gWy4uLmhpbnRzXTtcbn1cblxuZnVuY3Rpb24gcGFyc2VTdHJpbmdBcnJheUNvbHVtbihyYXc6IHVua25vd24pOiBzdHJpbmdbXSB7XG4gIGlmIChBcnJheS5pc0FycmF5KHJhdykpIHJldHVybiByYXcuZmlsdGVyKChlbnRyeSk6IGVudHJ5IGlzIHN0cmluZyA9PiB0eXBlb2YgZW50cnkgPT09IFwic3RyaW5nXCIpO1xuICBpZiAodHlwZW9mIHJhdyAhPT0gXCJzdHJpbmdcIikgcmV0dXJuIFtdO1xuICBjb25zdCB0cmltbWVkID0gcmF3LnRyaW0oKTtcbiAgaWYgKCF0cmltbWVkKSByZXR1cm4gW107XG4gIHRyeSB7XG4gICAgY29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZSh0cmltbWVkKTtcbiAgICBpZiAoQXJyYXkuaXNBcnJheShwYXJzZWQpKSByZXR1cm4gcGFyc2VkLmZpbHRlcigoZW50cnkpOiBlbnRyeSBpcyBzdHJpbmcgPT4gdHlwZW9mIGVudHJ5ID09PSBcInN0cmluZ1wiKTtcbiAgICBpZiAodHlwZW9mIHBhcnNlZCA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIFtwYXJzZWRdO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gdHJpbW1lZC5zcGxpdChcIixcIik7XG4gIH1cbiAgcmV0dXJuIFtdO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVSZXBvUGF0aChmaWxlOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gZmlsZS50cmltKCkucmVwbGFjZSgvXFxcXC9nLCBcIi9cIikucmVwbGFjZSgvXlxcLlxcLysvLCBcIlwiKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEFEUi0wMTEgUGhhc2UgMiBlc2NhbGF0aW9uIGhlbHBlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKiBTZXQgcGF1c2Utb24tZXNjYWxhdGlvbiBzdGF0ZSBvbiBhIGNvbXBsZXRlZCB0YXNrLiBNdXR1YWxseSBleGNsdXNpdmUgd2l0aCBhd2FpdGluZ19yZXZpZXcuICovXG5leHBvcnQgZnVuY3Rpb24gc2V0VGFza0VzY2FsYXRpb25QZW5kaW5nKFxuICBtaWxlc3RvbmVJZDogc3RyaW5nLCBzbGljZUlkOiBzdHJpbmcsIHRhc2tJZDogc3RyaW5nLFxuICBhcnRpZmFjdFBhdGg6IHN0cmluZyxcbik6IHZvaWQge1xuICBpZiAoIWN1cnJlbnREYikgdGhyb3cgbmV3IEdTREVycm9yKEdTRF9TVEFMRV9TVEFURSwgXCJnc2QtZGI6IE5vIGRhdGFiYXNlIG9wZW5cIik7XG4gIGN1cnJlbnREYi5wcmVwYXJlKFxuICAgIGBVUERBVEUgdGFza3NcbiAgICAgICBTRVQgZXNjYWxhdGlvbl9wZW5kaW5nID0gMSxcbiAgICAgICAgICAgZXNjYWxhdGlvbl9hd2FpdGluZ19yZXZpZXcgPSAwLFxuICAgICAgICAgICBlc2NhbGF0aW9uX2FydGlmYWN0X3BhdGggPSA6cGF0aFxuICAgICBXSEVSRSBtaWxlc3RvbmVfaWQgPSA6bWlkIEFORCBzbGljZV9pZCA9IDpzaWQgQU5EIGlkID0gOnRpZGAsXG4gICkucnVuKHsgXCI6cGF0aFwiOiBhcnRpZmFjdFBhdGgsIFwiOm1pZFwiOiBtaWxlc3RvbmVJZCwgXCI6c2lkXCI6IHNsaWNlSWQsIFwiOnRpZFwiOiB0YXNrSWQgfSk7XG59XG5cbi8qKiBTZXQgYXdhaXRpbmctcmV2aWV3IHN0YXRlIChhcnRpZmFjdCBleGlzdHMgYnV0IGNvbnRpbnVlV2l0aERlZmF1bHQ9dHJ1ZSwgbm8gcGF1c2UpLiBNdXR1YWxseSBleGNsdXNpdmUgd2l0aCBwZW5kaW5nLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNldFRhc2tFc2NhbGF0aW9uQXdhaXRpbmdSZXZpZXcoXG4gIG1pbGVzdG9uZUlkOiBzdHJpbmcsIHNsaWNlSWQ6IHN0cmluZywgdGFza0lkOiBzdHJpbmcsXG4gIGFydGlmYWN0UGF0aDogc3RyaW5nLFxuKTogdm9pZCB7XG4gIGlmICghY3VycmVudERiKSB0aHJvdyBuZXcgR1NERXJyb3IoR1NEX1NUQUxFX1NUQVRFLCBcImdzZC1kYjogTm8gZGF0YWJhc2Ugb3BlblwiKTtcbiAgY3VycmVudERiLnByZXBhcmUoXG4gICAgYFVQREFURSB0YXNrc1xuICAgICAgIFNFVCBlc2NhbGF0aW9uX2F3YWl0aW5nX3JldmlldyA9IDEsXG4gICAgICAgICAgIGVzY2FsYXRpb25fcGVuZGluZyA9IDAsXG4gICAgICAgICAgIGVzY2FsYXRpb25fYXJ0aWZhY3RfcGF0aCA9IDpwYXRoXG4gICAgIFdIRVJFIG1pbGVzdG9uZV9pZCA9IDptaWQgQU5EIHNsaWNlX2lkID0gOnNpZCBBTkQgaWQgPSA6dGlkYCxcbiAgKS5ydW4oeyBcIjpwYXRoXCI6IGFydGlmYWN0UGF0aCwgXCI6bWlkXCI6IG1pbGVzdG9uZUlkLCBcIjpzaWRcIjogc2xpY2VJZCwgXCI6dGlkXCI6IHRhc2tJZCB9KTtcbn1cblxuLyoqIENsZWFyIGVzY2FsYXRpb24tcGVuZGluZyBhbmQgYXdhaXRpbmctcmV2aWV3IGZsYWdzIG9uY2UgdGhlIHVzZXIgaGFzIHJlc29sdmVkIGl0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNsZWFyVGFza0VzY2FsYXRpb25GbGFncyhcbiAgbWlsZXN0b25lSWQ6IHN0cmluZywgc2xpY2VJZDogc3RyaW5nLCB0YXNrSWQ6IHN0cmluZyxcbik6IHZvaWQge1xuICBpZiAoIWN1cnJlbnREYikgdGhyb3cgbmV3IEdTREVycm9yKEdTRF9TVEFMRV9TVEFURSwgXCJnc2QtZGI6IE5vIGRhdGFiYXNlIG9wZW5cIik7XG4gIGN1cnJlbnREYi5wcmVwYXJlKFxuICAgIGBVUERBVEUgdGFza3NcbiAgICAgICBTRVQgZXNjYWxhdGlvbl9wZW5kaW5nID0gMCxcbiAgICAgICAgICAgZXNjYWxhdGlvbl9hd2FpdGluZ19yZXZpZXcgPSAwXG4gICAgIFdIRVJFIG1pbGVzdG9uZV9pZCA9IDptaWQgQU5EIHNsaWNlX2lkID0gOnNpZCBBTkQgaWQgPSA6dGlkYCxcbiAgKS5ydW4oeyBcIjptaWRcIjogbWlsZXN0b25lSWQsIFwiOnNpZFwiOiBzbGljZUlkLCBcIjp0aWRcIjogdGFza0lkIH0pO1xufVxuXG4vKipcbiAqIEF0b21pY2FsbHkgY2xhaW0gYSByZXNvbHZlZCBlc2NhbGF0aW9uIG92ZXJyaWRlIGZvciBpbmplY3Rpb24gaW50byBhIGRvd25zdHJlYW1cbiAqIHRhc2sncyBwcm9tcHQuIFJldHVybnMgdHJ1ZSBpZiB0aGlzIGNhbGxlciBjbGFpbWVkIGl0IChtdXN0IGluamVjdCksIGZhbHNlIGlmXG4gKiBhbm90aGVyIGNhbGxlciBhbHJlYWR5IGNsYWltZWQgaXQgKG11c3Qgc2tpcCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjbGFpbUVzY2FsYXRpb25PdmVycmlkZShcbiAgbWlsZXN0b25lSWQ6IHN0cmluZywgc2xpY2VJZDogc3RyaW5nLCBzb3VyY2VUYXNrSWQ6IHN0cmluZyxcbik6IGJvb2xlYW4ge1xuICBpZiAoIWN1cnJlbnREYikgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBub3cgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XG4gIGNvbnN0IHJlc3VsdCA9IGN1cnJlbnREYi5wcmVwYXJlKFxuICAgIGBVUERBVEUgdGFza3NcbiAgICAgICBTRVQgZXNjYWxhdGlvbl9vdmVycmlkZV9hcHBsaWVkX2F0ID0gOm5vd1xuICAgICBXSEVSRSBtaWxlc3RvbmVfaWQgPSA6bWlkIEFORCBzbGljZV9pZCA9IDpzaWQgQU5EIGlkID0gOnRpZFxuICAgICAgIEFORCBlc2NhbGF0aW9uX292ZXJyaWRlX2FwcGxpZWRfYXQgSVMgTlVMTFxuICAgICAgIEFORCBlc2NhbGF0aW9uX2FydGlmYWN0X3BhdGggSVMgTk9UIE5VTExgLFxuICApLnJ1bih7IFwiOm5vd1wiOiBub3csIFwiOm1pZFwiOiBtaWxlc3RvbmVJZCwgXCI6c2lkXCI6IHNsaWNlSWQsIFwiOnRpZFwiOiBzb3VyY2VUYXNrSWQgfSk7XG4gIC8vIG5vZGU6c3FsaXRlICsgYmV0dGVyLXNxbGl0ZTMgYm90aCBzdXJmYWNlIGBjaGFuZ2VzYCBvbiB0aGUgcnVuIHJlc3VsdC5cbiAgY29uc3QgY2hhbmdlcyA9IChyZXN1bHQgYXMgeyBjaGFuZ2VzPzogbnVtYmVyIH0pLmNoYW5nZXMgPz8gMDtcbiAgcmV0dXJuIGNoYW5nZXMgPiAwO1xufVxuXG4vKiogRmluZCB0aGUgbW9zdCByZWNlbnQgcmVzb2x2ZWQtYnV0LXVuYXBwbGllZCBlc2NhbGF0aW9uIG92ZXJyaWRlIGluIGEgc2xpY2UuICovXG5leHBvcnQgZnVuY3Rpb24gZmluZFVuYXBwbGllZEVzY2FsYXRpb25PdmVycmlkZShcbiAgbWlsZXN0b25lSWQ6IHN0cmluZywgc2xpY2VJZDogc3RyaW5nLFxuKTogeyB0YXNrSWQ6IHN0cmluZzsgYXJ0aWZhY3RQYXRoOiBzdHJpbmcgfSB8IG51bGwge1xuICBpZiAoIWN1cnJlbnREYikgcmV0dXJuIG51bGw7XG4gIC8vIEZpbHRlciBCT1RIIGZsYWdzOiBlc2NhbGF0aW9uX3BlbmRpbmc9MCBBTkQgZXNjYWxhdGlvbl9hd2FpdGluZ19yZXZpZXc9MFxuICAvLyBlbnN1cmVzIHdlIG9ubHkgY2xhaW0gb3ZlcnJpZGVzIHRoZSB1c2VyIGhhcyBleHBsaWNpdGx5IHJlc29sdmVkLlxuICAvLyBXaXRob3V0IHRoZSBhd2FpdGluZ19yZXZpZXcgZmlsdGVyLCBjb250aW51ZVdpdGhEZWZhdWx0PXRydWUgYXJ0aWZhY3RzXG4gIC8vIChub3QgeWV0IHJlc3BvbmRlZCB0bykgd291bGQgYmUgcHJlbWF0dXJlbHkgY2xhaW1lZCwgY2F1c2luZyB0aGUgb3ZlcnJpZGVcbiAgLy8gdG8gYmUgbG9zdCB3aGVuIHRoZSB1c2VyIGxhdGVyIHJlc29sdmVzICgjQURSLTAxMSBQaGFzZSAyIHBlZXItcmV2aWV3IEJ1ZyAyKS5cbiAgY29uc3Qgcm93ID0gY3VycmVudERiLnByZXBhcmUoXG4gICAgYFNFTEVDVCBpZCwgZXNjYWxhdGlvbl9hcnRpZmFjdF9wYXRoIEFTIHBhdGhcbiAgICAgICBGUk9NIHRhc2tzXG4gICAgICBXSEVSRSBtaWxlc3RvbmVfaWQgPSA6bWlkIEFORCBzbGljZV9pZCA9IDpzaWRcbiAgICAgICAgQU5EIGVzY2FsYXRpb25fYXJ0aWZhY3RfcGF0aCBJUyBOT1QgTlVMTFxuICAgICAgICBBTkQgZXNjYWxhdGlvbl9vdmVycmlkZV9hcHBsaWVkX2F0IElTIE5VTExcbiAgICAgICAgQU5EIGVzY2FsYXRpb25fcGVuZGluZyA9IDBcbiAgICAgICAgQU5EIGVzY2FsYXRpb25fYXdhaXRpbmdfcmV2aWV3ID0gMFxuICAgICAgT1JERVIgQlkgc2VxdWVuY2UgREVTQywgaWQgREVTQ1xuICAgICAgTElNSVQgMWAsXG4gICkuZ2V0KHsgXCI6bWlkXCI6IG1pbGVzdG9uZUlkLCBcIjpzaWRcIjogc2xpY2VJZCB9KSBhc1xuICAgIHwgeyBpZDogc3RyaW5nOyBwYXRoOiBzdHJpbmcgfCBudWxsIH1cbiAgICB8IHVuZGVmaW5lZDtcbiAgaWYgKCFyb3cgfHwgIXJvdy5wYXRoKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHsgdGFza0lkOiByb3cuaWQsIGFydGlmYWN0UGF0aDogcm93LnBhdGggfTtcbn1cblxuLyoqIFNldCB0aGUgYmxvY2tlcl9zb3VyY2UgcHJvdmVuYW5jZSBmaWVsZCAodXNlZCB3aGVuIHJlamVjdGluZyBhbiBlc2NhbGF0aW9uKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZXRUYXNrQmxvY2tlclNvdXJjZShcbiAgbWlsZXN0b25lSWQ6IHN0cmluZywgc2xpY2VJZDogc3RyaW5nLCB0YXNrSWQ6IHN0cmluZywgc291cmNlOiBzdHJpbmcsXG4pOiB2b2lkIHtcbiAgaWYgKCFjdXJyZW50RGIpIHRocm93IG5ldyBHU0RFcnJvcihHU0RfU1RBTEVfU1RBVEUsIFwiZ3NkLWRiOiBObyBkYXRhYmFzZSBvcGVuXCIpO1xuICBjdXJyZW50RGIucHJlcGFyZShcbiAgICBgVVBEQVRFIHRhc2tzXG4gICAgICAgU0VUIGJsb2NrZXJfZGlzY292ZXJlZCA9IDEsXG4gICAgICAgICAgIGJsb2NrZXJfc291cmNlID0gOnNyY1xuICAgICBXSEVSRSBtaWxlc3RvbmVfaWQgPSA6bWlkIEFORCBzbGljZV9pZCA9IDpzaWQgQU5EIGlkID0gOnRpZGAsXG4gICkucnVuKHsgXCI6c3JjXCI6IHNvdXJjZSwgXCI6bWlkXCI6IG1pbGVzdG9uZUlkLCBcIjpzaWRcIjogc2xpY2VJZCwgXCI6dGlkXCI6IHRhc2tJZCB9KTtcbn1cblxuLyoqIExpc3QgdGFza3Mgd2l0aCBhY3RpdmUgZXNjYWxhdGlvbiBhcnRpZmFjdHMgYWNyb3NzIGEgbWlsZXN0b25lIChmb3IgL2dzZCBlc2NhbGF0ZSBsaXN0KS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBsaXN0RXNjYWxhdGlvbkFydGlmYWN0cyhtaWxlc3RvbmVJZDogc3RyaW5nLCBpbmNsdWRlUmVzb2x2ZWQ6IGJvb2xlYW4gPSBmYWxzZSk6IFRhc2tSb3dbXSB7XG4gIGlmICghY3VycmVudERiKSByZXR1cm4gW107XG4gIGNvbnN0IGZpbHRlciA9IGluY2x1ZGVSZXNvbHZlZFxuICAgID8gXCJlc2NhbGF0aW9uX2FydGlmYWN0X3BhdGggSVMgTk9UIE5VTExcIlxuICAgIDogXCIoZXNjYWxhdGlvbl9wZW5kaW5nID0gMSBPUiBlc2NhbGF0aW9uX2F3YWl0aW5nX3JldmlldyA9IDEpIEFORCBlc2NhbGF0aW9uX2FydGlmYWN0X3BhdGggSVMgTk9UIE5VTExcIjtcbiAgY29uc3Qgcm93cyA9IGN1cnJlbnREYi5wcmVwYXJlKFxuICAgIGBTRUxFQ1QgKiBGUk9NIHRhc2tzIFdIRVJFIG1pbGVzdG9uZV9pZCA9IDptaWQgQU5EICR7ZmlsdGVyfSBPUkRFUiBCWSBzbGljZV9pZCwgc2VxdWVuY2UsIGlkYCxcbiAgKS5hbGwoeyBcIjptaWRcIjogbWlsZXN0b25lSWQgfSk7XG4gIHJldHVybiByb3dzLm1hcChyb3dUb1Rhc2spO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaW5zZXJ0VmVyaWZpY2F0aW9uRXZpZGVuY2UoZToge1xuICB0YXNrSWQ6IHN0cmluZztcbiAgc2xpY2VJZDogc3RyaW5nO1xuICBtaWxlc3RvbmVJZDogc3RyaW5nO1xuICBjb21tYW5kOiBzdHJpbmc7XG4gIGV4aXRDb2RlOiBudW1iZXI7XG4gIHZlcmRpY3Q6IHN0cmluZztcbiAgZHVyYXRpb25NczogbnVtYmVyO1xufSk6IHZvaWQge1xuICBpZiAoIWN1cnJlbnREYikgdGhyb3cgbmV3IEdTREVycm9yKEdTRF9TVEFMRV9TVEFURSwgXCJnc2QtZGI6IE5vIGRhdGFiYXNlIG9wZW5cIik7XG4gIGN1cnJlbnREYi5wcmVwYXJlKFxuICAgIGBJTlNFUlQgT1IgSUdOT1JFIElOVE8gdmVyaWZpY2F0aW9uX2V2aWRlbmNlICh0YXNrX2lkLCBzbGljZV9pZCwgbWlsZXN0b25lX2lkLCBjb21tYW5kLCBleGl0X2NvZGUsIHZlcmRpY3QsIGR1cmF0aW9uX21zLCBjcmVhdGVkX2F0KVxuICAgICBWQUxVRVMgKDp0YXNrX2lkLCA6c2xpY2VfaWQsIDptaWxlc3RvbmVfaWQsIDpjb21tYW5kLCA6ZXhpdF9jb2RlLCA6dmVyZGljdCwgOmR1cmF0aW9uX21zLCA6Y3JlYXRlZF9hdClgLFxuICApLnJ1bih7XG4gICAgXCI6dGFza19pZFwiOiBlLnRhc2tJZCxcbiAgICBcIjpzbGljZV9pZFwiOiBlLnNsaWNlSWQsXG4gICAgXCI6bWlsZXN0b25lX2lkXCI6IGUubWlsZXN0b25lSWQsXG4gICAgXCI6Y29tbWFuZFwiOiBlLmNvbW1hbmQsXG4gICAgXCI6ZXhpdF9jb2RlXCI6IGUuZXhpdENvZGUsXG4gICAgXCI6dmVyZGljdFwiOiBlLnZlcmRpY3QsXG4gICAgXCI6ZHVyYXRpb25fbXNcIjogZS5kdXJhdGlvbk1zLFxuICAgIFwiOmNyZWF0ZWRfYXRcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICB9KTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBWZXJpZmljYXRpb25FdmlkZW5jZVJvdyB7XG4gIGlkOiBudW1iZXI7XG4gIHRhc2tfaWQ6IHN0cmluZztcbiAgc2xpY2VfaWQ6IHN0cmluZztcbiAgbWlsZXN0b25lX2lkOiBzdHJpbmc7XG4gIGNvbW1hbmQ6IHN0cmluZztcbiAgZXhpdF9jb2RlOiBudW1iZXI7XG4gIHZlcmRpY3Q6IHN0cmluZztcbiAgZHVyYXRpb25fbXM6IG51bWJlcjtcbiAgY3JlYXRlZF9hdDogc3RyaW5nO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0VmVyaWZpY2F0aW9uRXZpZGVuY2UobWlsZXN0b25lSWQ6IHN0cmluZywgc2xpY2VJZDogc3RyaW5nLCB0YXNrSWQ6IHN0cmluZyk6IFZlcmlmaWNhdGlvbkV2aWRlbmNlUm93W10ge1xuICBpZiAoIWN1cnJlbnREYikgcmV0dXJuIFtdO1xuICBjb25zdCByb3dzID0gY3VycmVudERiLnByZXBhcmUoXG4gICAgXCJTRUxFQ1QgKiBGUk9NIHZlcmlmaWNhdGlvbl9ldmlkZW5jZSBXSEVSRSBtaWxlc3RvbmVfaWQgPSA6bWlkIEFORCBzbGljZV9pZCA9IDpzaWQgQU5EIHRhc2tfaWQgPSA6dGlkIE9SREVSIEJZIGlkXCIsXG4gICkuYWxsKHsgXCI6bWlkXCI6IG1pbGVzdG9uZUlkLCBcIjpzaWRcIjogc2xpY2VJZCwgXCI6dGlkXCI6IHRhc2tJZCB9KTtcbiAgcmV0dXJuIHJvd3MgYXMgdW5rbm93biBhcyBWZXJpZmljYXRpb25FdmlkZW5jZVJvd1tdO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0QWxsTWlsZXN0b25lcygpOiBNaWxlc3RvbmVSb3dbXSB7XG4gIGlmICghY3VycmVudERiKSByZXR1cm4gW107XG4gIGNvbnN0IHJvd3MgPSBjdXJyZW50RGIucHJlcGFyZShcbiAgICBcIlNFTEVDVCAqIEZST00gbWlsZXN0b25lcyBPUkRFUiBCWSBDQVNFIFdIRU4gc2VxdWVuY2UgPiAwIFRIRU4gMCBFTFNFIDEgRU5ELCBzZXF1ZW5jZSwgaWRcIixcbiAgKS5hbGwoKTtcbiAgcmV0dXJuIHJvd3MubWFwKHJvd1RvTWlsZXN0b25lKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldE1pbGVzdG9uZShpZDogc3RyaW5nKTogTWlsZXN0b25lUm93IHwgbnVsbCB7XG4gIGlmICghY3VycmVudERiKSByZXR1cm4gbnVsbDtcbiAgY29uc3Qgcm93ID0gY3VycmVudERiLnByZXBhcmUoXCJTRUxFQ1QgKiBGUk9NIG1pbGVzdG9uZXMgV0hFUkUgaWQgPSA6aWRcIikuZ2V0KHsgXCI6aWRcIjogaWQgfSk7XG4gIGlmICghcm93KSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHJvd1RvTWlsZXN0b25lKHJvdyk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRNaWxlc3RvbmVRdWV1ZU9yZGVyKG9yZGVyOiBzdHJpbmdbXSk6IHZvaWQge1xuICBpZiAoIWN1cnJlbnREYikgdGhyb3cgbmV3IEdTREVycm9yKEdTRF9TVEFMRV9TVEFURSwgXCJnc2QtZGI6IE5vIGRhdGFiYXNlIG9wZW5cIik7XG4gIGN1cnJlbnREYi5leGVjKFwiQkVHSU4gSU1NRURJQVRFXCIpO1xuICB0cnkge1xuICAgIGN1cnJlbnREYi5wcmVwYXJlKFwiVVBEQVRFIG1pbGVzdG9uZXMgU0VUIHNlcXVlbmNlID0gMFwiKS5ydW4oKTtcbiAgICBjb25zdCBzdG10ID0gY3VycmVudERiLnByZXBhcmUoXCJVUERBVEUgbWlsZXN0b25lcyBTRVQgc2VxdWVuY2UgPSA6c2VxdWVuY2UgV0hFUkUgaWQgPSA6aWRcIik7XG4gICAgb3JkZXIuZm9yRWFjaCgoaWQsIGluZGV4KSA9PiB7XG4gICAgICBzdG10LnJ1bih7IFwiOmlkXCI6IGlkLCBcIjpzZXF1ZW5jZVwiOiBpbmRleCArIDEgfSk7XG4gICAgfSk7XG4gICAgY3VycmVudERiLmV4ZWMoXCJDT01NSVRcIik7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGN1cnJlbnREYi5leGVjKFwiUk9MTEJBQ0tcIik7XG4gICAgdGhyb3cgZXJyO1xuICB9XG59XG5cbi8qKlxuICogVXBkYXRlIGEgbWlsZXN0b25lJ3Mgc3RhdHVzIGluIHRoZSBkYXRhYmFzZS5cbiAqIFVzZWQgYnkgcGFyay91bnBhcmsgdG8ga2VlcCB0aGUgREIgaW4gc3luYyB3aXRoIHRoZSBmaWxlc3lzdGVtIG1hcmtlci5cbiAqIFNlZTogaHR0cHM6Ly9naXRodWIuY29tL2dzZC1idWlsZC9nc2QtMi9pc3N1ZXMvMjY5NFxuICovXG5leHBvcnQgZnVuY3Rpb24gdXBkYXRlTWlsZXN0b25lU3RhdHVzKG1pbGVzdG9uZUlkOiBzdHJpbmcsIHN0YXR1czogc3RyaW5nLCBjb21wbGV0ZWRBdD86IHN0cmluZyB8IG51bGwpOiB2b2lkIHtcbiAgaWYgKCFjdXJyZW50RGIpIHRocm93IG5ldyBHU0RFcnJvcihHU0RfU1RBTEVfU1RBVEUsIFwiZ3NkLWRiOiBObyBkYXRhYmFzZSBvcGVuXCIpO1xuICBjdXJyZW50RGIucHJlcGFyZShcbiAgICBgVVBEQVRFIG1pbGVzdG9uZXMgU0VUIHN0YXR1cyA9IDpzdGF0dXMsIGNvbXBsZXRlZF9hdCA9IDpjb21wbGV0ZWRfYXQgV0hFUkUgaWQgPSA6aWRgLFxuICApLnJ1bih7IFwiOnN0YXR1c1wiOiBzdGF0dXMsIFwiOmNvbXBsZXRlZF9hdFwiOiBjb21wbGV0ZWRBdCA/PyBudWxsLCBcIjppZFwiOiBtaWxlc3RvbmVJZCB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldEFjdGl2ZU1pbGVzdG9uZUZyb21EYigpOiBNaWxlc3RvbmVSb3cgfCBudWxsIHtcbiAgaWYgKCFjdXJyZW50RGIpIHJldHVybiBudWxsO1xuICBjb25zdCByb3cgPSBjdXJyZW50RGIucHJlcGFyZShcbiAgICBcIlNFTEVDVCAqIEZST00gbWlsZXN0b25lcyBXSEVSRSBzdGF0dXMgTk9UIElOICgnY29tcGxldGUnLCAncGFya2VkJykgT1JERVIgQlkgaWQgTElNSVQgMVwiLFxuICApLmdldCgpO1xuICBpZiAoIXJvdykgcmV0dXJuIG51bGw7XG4gIHJldHVybiByb3dUb01pbGVzdG9uZShyb3cpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0QWN0aXZlU2xpY2VGcm9tRGIobWlsZXN0b25lSWQ6IHN0cmluZyk6IFNsaWNlUm93IHwgbnVsbCB7XG4gIGlmICghY3VycmVudERiKSByZXR1cm4gbnVsbDtcblxuICAvLyBTaW5nbGUgcXVlcnk6IGZpbmQgdGhlIGZpcnN0IG5vbi1jb21wbGV0ZSBzbGljZSB3aG9zZSBkZXBlbmRlbmNpZXMgYXJlIGFsbCBzYXRpc2ZpZWQuXG4gIC8vIFVzZXMganNvbl9lYWNoKCkgdG8gZXhwYW5kIHRoZSBKU09OIGRlcGVuZHMgYXJyYXkgYW5kIGNoZWNrcyBlYWNoIGRlcCBpcyBjb21wbGV0ZS5cbiAgY29uc3Qgcm93ID0gY3VycmVudERiLnByZXBhcmUoXG4gICAgYFNFTEVDVCBzLiogRlJPTSBzbGljZXMgc1xuICAgICBXSEVSRSBzLm1pbGVzdG9uZV9pZCA9IDptaWRcbiAgICAgICBBTkQgcy5zdGF0dXMgTk9UIElOICgnY29tcGxldGUnLCAnZG9uZScsICdza2lwcGVkJylcbiAgICAgICBBTkQgTk9UIEVYSVNUUyAoXG4gICAgICAgICBTRUxFQ1QgMSBGUk9NIGpzb25fZWFjaChzLmRlcGVuZHMpIEFTIGRlcFxuICAgICAgICAgV0hFUkUgZGVwLnZhbHVlIE5PVCBJTiAoXG4gICAgICAgICAgIFNFTEVDVCBpZCBGUk9NIHNsaWNlcyBXSEVSRSBtaWxlc3RvbmVfaWQgPSA6bWlkIEFORCBzdGF0dXMgSU4gKCdjb21wbGV0ZScsICdkb25lJywgJ3NraXBwZWQnKVxuICAgICAgICAgKVxuICAgICAgIClcbiAgICAgT1JERVIgQlkgcy5zZXF1ZW5jZSwgcy5pZFxuICAgICBMSU1JVCAxYCxcbiAgKS5nZXQoeyBcIjptaWRcIjogbWlsZXN0b25lSWQgfSk7XG4gIGlmICghcm93KSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHJvd1RvU2xpY2Uocm93KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldEFjdGl2ZVRhc2tGcm9tRGIobWlsZXN0b25lSWQ6IHN0cmluZywgc2xpY2VJZDogc3RyaW5nKTogVGFza1JvdyB8IG51bGwge1xuICBpZiAoIWN1cnJlbnREYikgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHJvdyA9IGN1cnJlbnREYi5wcmVwYXJlKFxuICAgIFwiU0VMRUNUICogRlJPTSB0YXNrcyBXSEVSRSBtaWxlc3RvbmVfaWQgPSA6bWlkIEFORCBzbGljZV9pZCA9IDpzaWQgQU5EIHN0YXR1cyBOT1QgSU4gKCdjb21wbGV0ZScsICdkb25lJykgT1JERVIgQlkgc2VxdWVuY2UsIGlkIExJTUlUIDFcIixcbiAgKS5nZXQoeyBcIjptaWRcIjogbWlsZXN0b25lSWQsIFwiOnNpZFwiOiBzbGljZUlkIH0pO1xuICBpZiAoIXJvdykgcmV0dXJuIG51bGw7XG4gIHJldHVybiByb3dUb1Rhc2socm93KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldE1pbGVzdG9uZVNsaWNlcyhtaWxlc3RvbmVJZDogc3RyaW5nKTogU2xpY2VSb3dbXSB7XG4gIGlmICghY3VycmVudERiKSByZXR1cm4gW107XG4gIGNvbnN0IHJvd3MgPSBjdXJyZW50RGIucHJlcGFyZShcIlNFTEVDVCAqIEZST00gc2xpY2VzIFdIRVJFIG1pbGVzdG9uZV9pZCA9IDptaWQgT1JERVIgQlkgc2VxdWVuY2UsIGlkXCIpLmFsbCh7IFwiOm1pZFwiOiBtaWxlc3RvbmVJZCB9KTtcbiAgcmV0dXJuIHJvd3MubWFwKHJvd1RvU2xpY2UpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0QXJ0aWZhY3QocGF0aDogc3RyaW5nKTogQXJ0aWZhY3RSb3cgfCBudWxsIHtcbiAgaWYgKCFjdXJyZW50RGIpIHJldHVybiBudWxsO1xuICBjb25zdCByb3cgPSBjdXJyZW50RGIucHJlcGFyZShcIlNFTEVDVCAqIEZST00gYXJ0aWZhY3RzIFdIRVJFIHBhdGggPSA6cGF0aFwiKS5nZXQoeyBcIjpwYXRoXCI6IHBhdGggfSk7XG4gIGlmICghcm93KSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHJvd1RvQXJ0aWZhY3Qocm93KTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIExpZ2h0d2VpZ2h0IFF1ZXJ5IFZhcmlhbnRzIChob3QtcGF0aCBvcHRpbWl6ZWQpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKiogRmFzdCBtaWxlc3RvbmUgc3RhdHVzIGNoZWNrIFx1MjAxNCBhdm9pZHMgZGVzZXJpYWxpemluZyBKU09OIHBsYW5uaW5nIGZpZWxkcy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRBY3RpdmVNaWxlc3RvbmVJZEZyb21EYigpOiBJZFN0YXR1c1N1bW1hcnkgfCBudWxsIHtcbiAgaWYgKCFjdXJyZW50RGIpIHJldHVybiBudWxsO1xuICBjb25zdCByb3cgPSBjdXJyZW50RGIucHJlcGFyZShcbiAgICBcIlNFTEVDVCBpZCwgc3RhdHVzIEZST00gbWlsZXN0b25lcyBXSEVSRSBzdGF0dXMgTk9UIElOICgnY29tcGxldGUnLCAncGFya2VkJykgT1JERVIgQlkgaWQgTElNSVQgMVwiLFxuICApLmdldCgpO1xuICBpZiAoIXJvdykgcmV0dXJuIG51bGw7XG4gIHJldHVybiByb3dUb0lkU3RhdHVzU3VtbWFyeShyb3cpO1xufVxuXG4vKiogRmFzdCBzbGljZSBzdGF0dXMgY2hlY2sgXHUyMDE0IGF2b2lkcyBkZXNlcmlhbGl6aW5nIEpTT04gZGVwZW5kcy9wbGFubmluZyBmaWVsZHMuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0U2xpY2VTdGF0dXNTdW1tYXJ5KG1pbGVzdG9uZUlkOiBzdHJpbmcpOiBJZFN0YXR1c1N1bW1hcnlbXSB7XG4gIGlmICghY3VycmVudERiKSByZXR1cm4gW107XG4gIHJldHVybiBjdXJyZW50RGIucHJlcGFyZShcbiAgICBcIlNFTEVDVCBpZCwgc3RhdHVzIEZST00gc2xpY2VzIFdIRVJFIG1pbGVzdG9uZV9pZCA9IDptaWQgT1JERVIgQlkgc2VxdWVuY2UsIGlkXCIsXG4gICkuYWxsKHsgXCI6bWlkXCI6IG1pbGVzdG9uZUlkIH0pLm1hcChyb3dUb0lkU3RhdHVzU3VtbWFyeSk7XG59XG5cbi8qKiBGYXN0IHRhc2sgc3RhdHVzIGNoZWNrIFx1MjAxNCBhdm9pZHMgZGVzZXJpYWxpemluZyBKU09OIGFycmF5cyBhbmQgbGFyZ2UgdGV4dCBmaWVsZHMuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0QWN0aXZlVGFza0lkRnJvbURiKG1pbGVzdG9uZUlkOiBzdHJpbmcsIHNsaWNlSWQ6IHN0cmluZyk6IEFjdGl2ZVRhc2tTdW1tYXJ5IHwgbnVsbCB7XG4gIGlmICghY3VycmVudERiKSByZXR1cm4gbnVsbDtcbiAgY29uc3Qgcm93ID0gY3VycmVudERiLnByZXBhcmUoXG4gICAgXCJTRUxFQ1QgaWQsIHN0YXR1cywgdGl0bGUgRlJPTSB0YXNrcyBXSEVSRSBtaWxlc3RvbmVfaWQgPSA6bWlkIEFORCBzbGljZV9pZCA9IDpzaWQgQU5EIHN0YXR1cyBOT1QgSU4gKCdjb21wbGV0ZScsICdkb25lJykgT1JERVIgQlkgc2VxdWVuY2UsIGlkIExJTUlUIDFcIixcbiAgKS5nZXQoeyBcIjptaWRcIjogbWlsZXN0b25lSWQsIFwiOnNpZFwiOiBzbGljZUlkIH0pO1xuICBpZiAoIXJvdykgcmV0dXJuIG51bGw7XG4gIHJldHVybiByb3dUb0FjdGl2ZVRhc2tTdW1tYXJ5KHJvdyk7XG59XG5cbi8qKiBDb3VudCB0YXNrcyBieSBzdGF0dXMgZm9yIGEgc2xpY2UgXHUyMDE0IHVzZWZ1bCBmb3IgcHJvZ3Jlc3MgcmVwb3J0aW5nIHdpdGhvdXQgZnVsbCByb3cgbG9hZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRTbGljZVRhc2tDb3VudHMobWlsZXN0b25lSWQ6IHN0cmluZywgc2xpY2VJZDogc3RyaW5nKTogVGFza1N0YXR1c0NvdW50cyB7XG4gIGlmICghY3VycmVudERiKSByZXR1cm4gZW1wdHlUYXNrU3RhdHVzQ291bnRzKCk7XG4gIGNvbnN0IHJvdyA9IGN1cnJlbnREYi5wcmVwYXJlKFxuICAgIGBTRUxFQ1RcbiAgICAgICBDT1VOVCgqKSBhcyB0b3RhbCxcbiAgICAgICBTVU0oQ0FTRSBXSEVOIHN0YXR1cyBJTiAoJ2NvbXBsZXRlJywgJ2RvbmUnKSBUSEVOIDEgRUxTRSAwIEVORCkgYXMgZG9uZSxcbiAgICAgICBTVU0oQ0FTRSBXSEVOIHN0YXR1cyBOT1QgSU4gKCdjb21wbGV0ZScsICdkb25lJykgVEhFTiAxIEVMU0UgMCBFTkQpIGFzIHBlbmRpbmdcbiAgICAgRlJPTSB0YXNrcyBXSEVSRSBtaWxlc3RvbmVfaWQgPSA6bWlkIEFORCBzbGljZV9pZCA9IDpzaWRgLFxuICApLmdldCh7IFwiOm1pZFwiOiBtaWxlc3RvbmVJZCwgXCI6c2lkXCI6IHNsaWNlSWQgfSk7XG4gIHJldHVybiByb3dUb1Rhc2tTdGF0dXNDb3VudHMocm93KTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFNsaWNlIERlcGVuZGVuY2llcyAoanVuY3Rpb24gdGFibGUpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKiogU3luYyB0aGUgc2xpY2VfZGVwZW5kZW5jaWVzIGp1bmN0aW9uIHRhYmxlIGZyb20gYSBzbGljZSdzIEpTT04gZGVwZW5kcyBhcnJheS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzeW5jU2xpY2VEZXBlbmRlbmNpZXMobWlsZXN0b25lSWQ6IHN0cmluZywgc2xpY2VJZDogc3RyaW5nLCBkZXBlbmRzOiBzdHJpbmdbXSk6IHZvaWQge1xuICBpZiAoIWN1cnJlbnREYikgcmV0dXJuO1xuICBjdXJyZW50RGIucHJlcGFyZShcbiAgICBcIkRFTEVURSBGUk9NIHNsaWNlX2RlcGVuZGVuY2llcyBXSEVSRSBtaWxlc3RvbmVfaWQgPSA6bWlkIEFORCBzbGljZV9pZCA9IDpzaWRcIixcbiAgKS5ydW4oeyBcIjptaWRcIjogbWlsZXN0b25lSWQsIFwiOnNpZFwiOiBzbGljZUlkIH0pO1xuICBmb3IgKGNvbnN0IGRlcCBvZiBkZXBlbmRzKSB7XG4gICAgY3VycmVudERiLnByZXBhcmUoXG4gICAgICBcIklOU0VSVCBPUiBJR05PUkUgSU5UTyBzbGljZV9kZXBlbmRlbmNpZXMgKG1pbGVzdG9uZV9pZCwgc2xpY2VfaWQsIGRlcGVuZHNfb25fc2xpY2VfaWQpIFZBTFVFUyAoOm1pZCwgOnNpZCwgOmRlcClcIixcbiAgICApLnJ1bih7IFwiOm1pZFwiOiBtaWxlc3RvbmVJZCwgXCI6c2lkXCI6IHNsaWNlSWQsIFwiOmRlcFwiOiBkZXAgfSk7XG4gIH1cbn1cblxuLyoqIEdldCBhbGwgc2xpY2VzIHRoYXQgZGVwZW5kIG9uIGEgZ2l2ZW4gc2xpY2UuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0RGVwZW5kZW50U2xpY2VzKG1pbGVzdG9uZUlkOiBzdHJpbmcsIHNsaWNlSWQ6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgaWYgKCFjdXJyZW50RGIpIHJldHVybiBbXTtcbiAgY29uc3Qgcm93cyA9IGN1cnJlbnREYi5wcmVwYXJlKFxuICAgIFwiU0VMRUNUIHNsaWNlX2lkIEZST00gc2xpY2VfZGVwZW5kZW5jaWVzIFdIRVJFIG1pbGVzdG9uZV9pZCA9IDptaWQgQU5EIGRlcGVuZHNfb25fc2xpY2VfaWQgPSA6c2lkXCIsXG4gICkuYWxsKHsgXCI6bWlkXCI6IG1pbGVzdG9uZUlkLCBcIjpzaWRcIjogc2xpY2VJZCB9KTtcbiAgcmV0dXJuIHJvd3NUb1N0cmluZ0NvbHVtbihyb3dzLCBcInNsaWNlX2lkXCIpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgV29ya3RyZWUgREIgSGVscGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGZ1bmN0aW9uIGNvcHlXb3JrdHJlZURiKHNyY0RiUGF0aDogc3RyaW5nLCBkZXN0RGJQYXRoOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgdHJ5IHtcbiAgICBpZiAoIWV4aXN0c1N5bmMoc3JjRGJQYXRoKSkgcmV0dXJuIGZhbHNlO1xuICAgIGNvbnN0IGRlc3REaXIgPSBkaXJuYW1lKGRlc3REYlBhdGgpO1xuICAgIG1rZGlyU3luYyhkZXN0RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBjb3B5RmlsZVN5bmMoc3JjRGJQYXRoLCBkZXN0RGJQYXRoKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgbG9nRXJyb3IoXCJkYlwiLCBcImZhaWxlZCB0byBjb3B5IERCIHRvIHdvcmt0cmVlXCIsIHsgZXJyb3I6IChlcnIgYXMgRXJyb3IpLm1lc3NhZ2UgfSk7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUmVjb25jaWxlUmVzdWx0IHtcbiAgZGVjaXNpb25zOiBudW1iZXI7XG4gIHJlcXVpcmVtZW50czogbnVtYmVyO1xuICBhcnRpZmFjdHM6IG51bWJlcjtcbiAgbWlsZXN0b25lczogbnVtYmVyO1xuICBzbGljZXM6IG51bWJlcjtcbiAgdGFza3M6IG51bWJlcjtcbiAgbWVtb3JpZXM6IG51bWJlcjtcbiAgdmVyaWZpY2F0aW9uX2V2aWRlbmNlOiBudW1iZXI7XG4gIGNvbmZsaWN0czogc3RyaW5nW107XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZWNvbmNpbGVXb3JrdHJlZURiKFxuICBtYWluRGJQYXRoOiBzdHJpbmcsXG4gIHdvcmt0cmVlRGJQYXRoOiBzdHJpbmcsXG4pOiBSZWNvbmNpbGVSZXN1bHQge1xuICBjb25zdCB6ZXJvOiBSZWNvbmNpbGVSZXN1bHQgPSB7IGRlY2lzaW9uczogMCwgcmVxdWlyZW1lbnRzOiAwLCBhcnRpZmFjdHM6IDAsIG1pbGVzdG9uZXM6IDAsIHNsaWNlczogMCwgdGFza3M6IDAsIG1lbW9yaWVzOiAwLCB2ZXJpZmljYXRpb25fZXZpZGVuY2U6IDAsIGNvbmZsaWN0czogW10gfTtcbiAgaWYgKCFleGlzdHNTeW5jKHdvcmt0cmVlRGJQYXRoKSkgcmV0dXJuIHplcm87XG4gIC8vIEd1YXJkOiBiYWlsIHdoZW4gYm90aCBwYXRocyByZXNvbHZlIHRvIHRoZSBzYW1lIHBoeXNpY2FsIGZpbGUuXG4gIC8vIEFUVEFDSGluZyBhIFdBTC1tb2RlIERCIHRvIGl0c2VsZiBjb3JydXB0cyB0aGUgV0FMICgjMjgyMykuXG4gIHRyeSB7XG4gICAgaWYgKHJlYWxwYXRoU3luYyhtYWluRGJQYXRoKSA9PT0gcmVhbHBhdGhTeW5jKHdvcmt0cmVlRGJQYXRoKSkgcmV0dXJuIHplcm87XG4gIH0gY2F0Y2ggKGUpIHsgbG9nV2FybmluZyhcImRiXCIsIGByZWFscGF0aFN5bmMgZmFpbGVkOiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWApOyB9XG4gIC8vIFNhbml0aXplIHBhdGg6IHJlamVjdCBhbnkgY2hhcmFjdGVycyB0aGF0IGNvdWxkIGJyZWFrIEFUVEFDSCBzeW50YXguXG4gIC8vIEFUVEFDSCBEQVRBQkFTRSBkb2Vzbid0IHN1cHBvcnQgcGFyYW1ldGVyaXplZCBwYXRocyBpbiBhbGwgcHJvdmlkZXJzLFxuICAvLyBzbyB3ZSB1c2Ugc3RyaWN0IGFsbG93bGlzdCB2YWxpZGF0aW9uIGluc3RlYWQuXG4gIGlmICgvWydcIjtcXHgwMF0vLnRlc3Qod29ya3RyZWVEYlBhdGgpKSB7XG4gICAgbG9nRXJyb3IoXCJkYlwiLCBcIndvcmt0cmVlIERCIHJlY29uY2lsaWF0aW9uIGZhaWxlZDogcGF0aCBjb250YWlucyB1bnNhZmUgY2hhcmFjdGVyc1wiKTtcbiAgICByZXR1cm4gemVybztcbiAgfVxuICBpZiAoIWN1cnJlbnREYikge1xuICAgIGNvbnN0IG9wZW5lZCA9IG9wZW5EYXRhYmFzZShtYWluRGJQYXRoKTtcbiAgICBpZiAoIW9wZW5lZCkge1xuICAgICAgbG9nRXJyb3IoXCJkYlwiLCBcIndvcmt0cmVlIERCIHJlY29uY2lsaWF0aW9uIGZhaWxlZDogY2Fubm90IG9wZW4gbWFpbiBEQlwiKTtcbiAgICAgIHJldHVybiB6ZXJvO1xuICAgIH1cbiAgfVxuICBjb25zdCBhZGFwdGVyID0gY3VycmVudERiITtcbiAgY29uc3QgY29uZmxpY3RzOiBzdHJpbmdbXSA9IFtdO1xuICB0cnkge1xuICAgIGFkYXB0ZXIuZXhlYyhgQVRUQUNIIERBVEFCQVNFICcke3dvcmt0cmVlRGJQYXRofScgQVMgd3RgKTtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgd3RJbmZvID0gYWRhcHRlci5wcmVwYXJlKFwiUFJBR01BIHd0LnRhYmxlX2luZm8oJ2RlY2lzaW9ucycpXCIpLmFsbCgpO1xuICAgICAgY29uc3QgaGFzTWFkZUJ5ID0gd3RJbmZvLnNvbWUoKGNvbCkgPT4gY29sW1wibmFtZVwiXSA9PT0gXCJtYWRlX2J5XCIpO1xuICAgICAgLy8gQURSLTAxMTogd29ya3RyZWUgbWF5IHByZWRhdGUgc2NoZW1hIHYxNi92MTcuIEZvciBtaXNzaW5nIGNvbHVtbnMgd2VcbiAgICAgIC8vIGZhbGwgdGhyb3VnaCB0byB0aGUgbWFpbiBEQidzIGV4aXN0aW5nIHZhbHVlIChub3QgYSBsaXRlcmFsIGRlZmF1bHQpXG4gICAgICAvLyBzbyByZWNvbmNpbGUgbmV2ZXIgc2lsZW50bHkgY2xlYXJzIHN0YXRlIHRoZSBtYWluIHRyZWUgaGFzIHJlY29yZGVkLlxuICAgICAgY29uc3QgaGFzRGVjaXNpb25Tb3VyY2UgPSB3dEluZm8uc29tZSgoY29sKSA9PiBjb2xbXCJuYW1lXCJdID09PSBcInNvdXJjZVwiKTtcbiAgICAgIGNvbnN0IHd0TWlsZXN0b25lSW5mbyA9IGFkYXB0ZXIucHJlcGFyZShcIlBSQUdNQSB3dC50YWJsZV9pbmZvKCdtaWxlc3RvbmVzJylcIikuYWxsKCk7XG4gICAgICBjb25zdCBoYXNNaWxlc3RvbmVTZXF1ZW5jZSA9IHd0TWlsZXN0b25lSW5mby5zb21lKChjb2wpID0+IGNvbFtcIm5hbWVcIl0gPT09IFwic2VxdWVuY2VcIik7XG4gICAgICBjb25zdCB3dFNsaWNlSW5mbyA9IGFkYXB0ZXIucHJlcGFyZShcIlBSQUdNQSB3dC50YWJsZV9pbmZvKCdzbGljZXMnKVwiKS5hbGwoKTtcbiAgICAgIGNvbnN0IGhhc0lzU2tldGNoID0gd3RTbGljZUluZm8uc29tZSgoY29sKSA9PiBjb2xbXCJuYW1lXCJdID09PSBcImlzX3NrZXRjaFwiKTtcbiAgICAgIGNvbnN0IGhhc1NrZXRjaFNjb3BlID0gd3RTbGljZUluZm8uc29tZSgoY29sKSA9PiBjb2xbXCJuYW1lXCJdID09PSBcInNrZXRjaF9zY29wZVwiKTtcbiAgICAgIGNvbnN0IHd0VGFza0luZm8gPSBhZGFwdGVyLnByZXBhcmUoXCJQUkFHTUEgd3QudGFibGVfaW5mbygndGFza3MnKVwiKS5hbGwoKTtcbiAgICAgIGNvbnN0IGhhc0Jsb2NrZXJTb3VyY2UgPSB3dFRhc2tJbmZvLnNvbWUoKGNvbCkgPT4gY29sW1wibmFtZVwiXSA9PT0gXCJibG9ja2VyX3NvdXJjZVwiKTtcbiAgICAgIGNvbnN0IGhhc0VzY2FsYXRpb25QZW5kaW5nID0gd3RUYXNrSW5mby5zb21lKChjb2wpID0+IGNvbFtcIm5hbWVcIl0gPT09IFwiZXNjYWxhdGlvbl9wZW5kaW5nXCIpO1xuICAgICAgY29uc3QgaGFzRXNjYWxhdGlvbkF3YWl0aW5nID0gd3RUYXNrSW5mby5zb21lKChjb2wpID0+IGNvbFtcIm5hbWVcIl0gPT09IFwiZXNjYWxhdGlvbl9hd2FpdGluZ19yZXZpZXdcIik7XG4gICAgICBjb25zdCBoYXNFc2NhbGF0aW9uQXJ0aWZhY3QgPSB3dFRhc2tJbmZvLnNvbWUoKGNvbCkgPT4gY29sW1wibmFtZVwiXSA9PT0gXCJlc2NhbGF0aW9uX2FydGlmYWN0X3BhdGhcIik7XG4gICAgICBjb25zdCBoYXNFc2NhbGF0aW9uT3ZlcnJpZGUgPSB3dFRhc2tJbmZvLnNvbWUoKGNvbCkgPT4gY29sW1wibmFtZVwiXSA9PT0gXCJlc2NhbGF0aW9uX292ZXJyaWRlX2FwcGxpZWRfYXRcIik7XG4gICAgICBjb25zdCB3dEFydGlmYWN0SW5mbyA9IGFkYXB0ZXIucHJlcGFyZShcIlBSQUdNQSB3dC50YWJsZV9pbmZvKCdhcnRpZmFjdHMnKVwiKS5hbGwoKTtcbiAgICAgIGNvbnN0IGhhc0FydGlmYWN0Q29udGVudEhhc2ggPSB3dEFydGlmYWN0SW5mby5zb21lKChjb2wpID0+IGNvbFtcIm5hbWVcIl0gPT09IFwiY29udGVudF9oYXNoXCIpO1xuICAgICAgY29uc3Qgd3RNZW1vcnlJbmZvID0gYWRhcHRlci5wcmVwYXJlKFwiUFJBR01BIHd0LnRhYmxlX2luZm8oJ21lbW9yaWVzJylcIikuYWxsKCk7XG4gICAgICBjb25zdCBoYXNNZW1vcnlTY29wZSA9IHd0TWVtb3J5SW5mby5zb21lKChjb2wpID0+IGNvbFtcIm5hbWVcIl0gPT09IFwic2NvcGVcIik7XG4gICAgICBjb25zdCBoYXNNZW1vcnlUYWdzID0gd3RNZW1vcnlJbmZvLnNvbWUoKGNvbCkgPT4gY29sW1wibmFtZVwiXSA9PT0gXCJ0YWdzXCIpO1xuICAgICAgY29uc3QgaGFzTWVtb3J5U3RydWN0dXJlZEZpZWxkcyA9IHd0TWVtb3J5SW5mby5zb21lKChjb2wpID0+IGNvbFtcIm5hbWVcIl0gPT09IFwic3RydWN0dXJlZF9maWVsZHNcIik7XG4gICAgICBjb25zdCBoYXNNZW1vcnlMYXN0SGl0QXQgPSB3dE1lbW9yeUluZm8uc29tZSgoY29sKSA9PiBjb2xbXCJuYW1lXCJdID09PSBcImxhc3RfaGl0X2F0XCIpO1xuXG4gICAgICBjb25zdCBkZWNDb25mID0gYWRhcHRlci5wcmVwYXJlKFxuICAgICAgICBgU0VMRUNUIG0uaWQgRlJPTSBkZWNpc2lvbnMgbSBJTk5FUiBKT0lOIHd0LmRlY2lzaW9ucyB3IE9OIG0uaWQgPSB3LmlkIFdIRVJFIG0uZGVjaXNpb24gIT0gdy5kZWNpc2lvbiBPUiBtLmNob2ljZSAhPSB3LmNob2ljZSBPUiBtLnJhdGlvbmFsZSAhPSB3LnJhdGlvbmFsZSBPUiAke1xuICAgICAgICAgIGhhc01hZGVCeSA/IFwibS5tYWRlX2J5ICE9IHcubWFkZV9ieVwiIDogXCInYWdlbnQnICE9ICdhZ2VudCdcIlxuICAgICAgICB9IE9SIG0uc3VwZXJzZWRlZF9ieSBJUyBOT1Qgdy5zdXBlcnNlZGVkX2J5YCxcbiAgICAgICkuYWxsKCk7XG4gICAgICBmb3IgKGNvbnN0IHJvdyBvZiBkZWNDb25mKSBjb25mbGljdHMucHVzaChgZGVjaXNpb24gJHsocm93IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KVtcImlkXCJdfTogbW9kaWZpZWQgaW4gYm90aGApO1xuXG4gICAgICBjb25zdCByZXFDb25mID0gYWRhcHRlci5wcmVwYXJlKFxuICAgICAgICBgU0VMRUNUIG0uaWQgRlJPTSByZXF1aXJlbWVudHMgbSBJTk5FUiBKT0lOIHd0LnJlcXVpcmVtZW50cyB3IE9OIG0uaWQgPSB3LmlkIFdIRVJFIG0uZGVzY3JpcHRpb24gIT0gdy5kZXNjcmlwdGlvbiBPUiBtLnN0YXR1cyAhPSB3LnN0YXR1cyBPUiBtLm5vdGVzICE9IHcubm90ZXMgT1IgbS5zdXBlcnNlZGVkX2J5IElTIE5PVCB3LnN1cGVyc2VkZWRfYnlgLFxuICAgICAgKS5hbGwoKTtcbiAgICAgIGZvciAoY29uc3Qgcm93IG9mIHJlcUNvbmYpIGNvbmZsaWN0cy5wdXNoKGByZXF1aXJlbWVudCAkeyhyb3cgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pW1wiaWRcIl19OiBtb2RpZmllZCBpbiBib3RoYCk7XG5cbiAgICAgIGNvbnN0IG1lcmdlZDogT21pdDxSZWNvbmNpbGVSZXN1bHQsIFwiY29uZmxpY3RzXCI+ID0geyBkZWNpc2lvbnM6IDAsIHJlcXVpcmVtZW50czogMCwgYXJ0aWZhY3RzOiAwLCBtaWxlc3RvbmVzOiAwLCBzbGljZXM6IDAsIHRhc2tzOiAwLCBtZW1vcmllczogMCwgdmVyaWZpY2F0aW9uX2V2aWRlbmNlOiAwIH07XG5cbiAgICAgIGZ1bmN0aW9uIGNvdW50Q2hhbmdlcyhyZXN1bHQ6IHVua25vd24pOiBudW1iZXIge1xuICAgICAgICByZXR1cm4gdHlwZW9mIHJlc3VsdCA9PT0gXCJvYmplY3RcIiAmJiByZXN1bHQgIT09IG51bGwgPyAoKHJlc3VsdCBhcyB7IGNoYW5nZXM/OiBudW1iZXIgfSkuY2hhbmdlcyA/PyAwKSA6IDA7XG4gICAgICB9XG5cbiAgICAgIGFkYXB0ZXIuZXhlYyhcIkJFR0lOXCIpO1xuICAgICAgdHJ5IHtcbiAgICAgICAgLy8gSm9pbiB0aGUgdGFyZ2V0IGRlY2lzaW9ucyBzbyB3ZSBjYW4gcHJlZmVyIGFuIGV4aXN0aW5nIG1haW4uc291cmNlXG4gICAgICAgIC8vIHdoZW4gdGhlIHdvcmt0cmVlIHByZWRhdGVzIHYxNiBcdTIwMTQgb3RoZXJ3aXNlIGEgd3JpdGUtdGhyb3VnaCByZWNvbmNpbGVcbiAgICAgICAgLy8gd291bGQgY2xvYmJlciAnZXNjYWxhdGlvbictc291cmNlZCBkZWNpc2lvbnMgd2l0aCB0aGUgbGl0ZXJhbCBkZWZhdWx0LlxuICAgICAgICBtZXJnZWQuZGVjaXNpb25zID0gY291bnRDaGFuZ2VzKGFkYXB0ZXIucHJlcGFyZShgXG4gICAgICAgICAgSU5TRVJUIE9SIFJFUExBQ0UgSU5UTyBkZWNpc2lvbnMgKFxuICAgICAgICAgICAgaWQsIHdoZW5fY29udGV4dCwgc2NvcGUsIGRlY2lzaW9uLCBjaG9pY2UsIHJhdGlvbmFsZSwgcmV2aXNhYmxlLCBtYWRlX2J5LCBzb3VyY2UsIHN1cGVyc2VkZWRfYnlcbiAgICAgICAgICApXG4gICAgICAgICAgU0VMRUNUIHcuaWQsIHcud2hlbl9jb250ZXh0LCB3LnNjb3BlLCB3LmRlY2lzaW9uLCB3LmNob2ljZSwgdy5yYXRpb25hbGUsIHcucmV2aXNhYmxlLCAke1xuICAgICAgICAgICAgaGFzTWFkZUJ5ID8gXCJ3Lm1hZGVfYnlcIiA6IFwiQ09BTEVTQ0UobS5tYWRlX2J5LCAnYWdlbnQnKVwiXG4gICAgICAgICAgfSwgJHtcbiAgICAgICAgICAgIGhhc0RlY2lzaW9uU291cmNlID8gXCJ3LnNvdXJjZVwiIDogXCJDT0FMRVNDRShtLnNvdXJjZSwgJ2Rpc2N1c3Npb24nKVwiXG4gICAgICAgICAgfSwgdy5zdXBlcnNlZGVkX2J5XG4gICAgICAgICAgRlJPTSB3dC5kZWNpc2lvbnMgd1xuICAgICAgICAgIExFRlQgSk9JTiBkZWNpc2lvbnMgbSBPTiBtLmlkID0gdy5pZFxuICAgICAgICBgKS5ydW4oKSk7XG5cbiAgICAgICAgbWVyZ2VkLnJlcXVpcmVtZW50cyA9IGNvdW50Q2hhbmdlcyhhZGFwdGVyLnByZXBhcmUoYFxuICAgICAgICAgIElOU0VSVCBPUiBSRVBMQUNFIElOVE8gcmVxdWlyZW1lbnRzIChcbiAgICAgICAgICAgIGlkLCBjbGFzcywgc3RhdHVzLCBkZXNjcmlwdGlvbiwgd2h5LCBzb3VyY2UsIHByaW1hcnlfb3duZXIsXG4gICAgICAgICAgICBzdXBwb3J0aW5nX3NsaWNlcywgdmFsaWRhdGlvbiwgbm90ZXMsIGZ1bGxfY29udGVudCwgc3VwZXJzZWRlZF9ieVxuICAgICAgICAgIClcbiAgICAgICAgICBTRUxFQ1QgaWQsIGNsYXNzLCBzdGF0dXMsIGRlc2NyaXB0aW9uLCB3aHksIHNvdXJjZSwgcHJpbWFyeV9vd25lcixcbiAgICAgICAgICAgICAgICAgc3VwcG9ydGluZ19zbGljZXMsIHZhbGlkYXRpb24sIG5vdGVzLCBmdWxsX2NvbnRlbnQsIHN1cGVyc2VkZWRfYnlcbiAgICAgICAgICBGUk9NIHd0LnJlcXVpcmVtZW50c1xuICAgICAgICBgKS5ydW4oKSk7XG5cbiAgICAgICAgLy8gVjI3OiBwcmVzZXJ2ZSBjb250ZW50X2hhc2guIElmIHRoZSB3b3JrdHJlZSBwcmVkYXRlcyBWMjcgKG5vIGNvbHVtbiksXG4gICAgICAgIC8vIGZhbGwgYmFjayB0byB0aGUgbWFpbiBEQidzIGV4aXN0aW5nIGhhc2ggc28gcmVjb25jaWxlIGRvZXNuJ3QgbnVsbFxuICAgICAgICAvLyBvdXQgaW50ZWdyaXR5IGZpbmdlcnByaW50cyBvbiBhcnRpZmFjdHMgdGhhdCB3ZXJlIHVuY2hhbmdlZCBpbiB3dC5cbiAgICAgICAgbWVyZ2VkLmFydGlmYWN0cyA9IGNvdW50Q2hhbmdlcyhhZGFwdGVyLnByZXBhcmUoYFxuICAgICAgICAgIElOU0VSVCBPUiBSRVBMQUNFIElOVE8gYXJ0aWZhY3RzIChcbiAgICAgICAgICAgIHBhdGgsIGFydGlmYWN0X3R5cGUsIG1pbGVzdG9uZV9pZCwgc2xpY2VfaWQsIHRhc2tfaWQsIGZ1bGxfY29udGVudCwgaW1wb3J0ZWRfYXQsIGNvbnRlbnRfaGFzaFxuICAgICAgICAgIClcbiAgICAgICAgICBTRUxFQ1Qgdy5wYXRoLCB3LmFydGlmYWN0X3R5cGUsIHcubWlsZXN0b25lX2lkLCB3LnNsaWNlX2lkLCB3LnRhc2tfaWQsIHcuZnVsbF9jb250ZW50LCB3LmltcG9ydGVkX2F0LFxuICAgICAgICAgICAgICAgICAke2hhc0FydGlmYWN0Q29udGVudEhhc2ggPyBcIncuY29udGVudF9oYXNoXCIgOiBcIm0uY29udGVudF9oYXNoXCJ9XG4gICAgICAgICAgRlJPTSB3dC5hcnRpZmFjdHMgd1xuICAgICAgICAgIExFRlQgSk9JTiBhcnRpZmFjdHMgbSBPTiBtLnBhdGggPSB3LnBhdGhcbiAgICAgICAgYCkucnVuKCkpO1xuXG4gICAgICAgIC8vIE1lcmdlIG1pbGVzdG9uZXMgXHUyMDE0IHdvcmt0cmVlIG1heSBoYXZlIHVwZGF0ZWQgc3RhdHVzL3BsYW5uaW5nIGZpZWxkcy5cbiAgICAgICAgLy8gTmV2ZXIgZG93bmdyYWRlIHN0YXR1czogY29tcGxldGUgPiBhY3RpdmUgPiBwcmUtcGxhbm5pbmcgKCM0MzcyKS5cbiAgICAgICAgLy8gQSBzdGFsZSB3b3JrdHJlZSBtYXkgY2FycnkgYW4gb2xkZXIgJ2FjdGl2ZScgc3RhdHVzIGZvciBhIG1pbGVzdG9uZVxuICAgICAgICAvLyB0aGF0IHRoZSBtYWluIERCIGhhcyBhbHJlYWR5IG1hcmtlZCAnY29tcGxldGUnOyBwcmVzZXJ2ZSB0aGUgaGlnaGVyIHN0YXR1cy5cbiAgICAgICAgbWVyZ2VkLm1pbGVzdG9uZXMgPSBjb3VudENoYW5nZXMoYWRhcHRlci5wcmVwYXJlKGBcbiAgICAgICAgICBJTlNFUlQgT1IgUkVQTEFDRSBJTlRPIG1pbGVzdG9uZXMgKFxuICAgICAgICAgICAgaWQsIHRpdGxlLCBzdGF0dXMsIGRlcGVuZHNfb24sIGNyZWF0ZWRfYXQsIGNvbXBsZXRlZF9hdCxcbiAgICAgICAgICAgIHZpc2lvbiwgc3VjY2Vzc19jcml0ZXJpYSwga2V5X3Jpc2tzLCBwcm9vZl9zdHJhdGVneSxcbiAgICAgICAgICAgIHZlcmlmaWNhdGlvbl9jb250cmFjdCwgdmVyaWZpY2F0aW9uX2ludGVncmF0aW9uLCB2ZXJpZmljYXRpb25fb3BlcmF0aW9uYWwsIHZlcmlmaWNhdGlvbl91YXQsXG4gICAgICAgICAgICBkZWZpbml0aW9uX29mX2RvbmUsIHJlcXVpcmVtZW50X2NvdmVyYWdlLCBib3VuZGFyeV9tYXBfbWFya2Rvd24sIHNlcXVlbmNlXG4gICAgICAgICAgKVxuICAgICAgICAgIFNFTEVDVCB3LmlkLCB3LnRpdGxlLFxuICAgICAgICAgICAgICAgICBDQVNFXG4gICAgICAgICAgICAgICAgICAgV0hFTiBtLnN0YXR1cyBJTiAoJ2NvbXBsZXRlJywgJ2RvbmUnKSBBTkQgdy5zdGF0dXMgTk9UIElOICgnY29tcGxldGUnLCAnZG9uZScpXG4gICAgICAgICAgICAgICAgICAgVEhFTiBtLnN0YXR1cyBFTFNFIHcuc3RhdHVzXG4gICAgICAgICAgICAgICAgIEVORCxcbiAgICAgICAgICAgICAgICAgdy5kZXBlbmRzX29uLFxuICAgICAgICAgICAgICAgICBDQVNFXG4gICAgICAgICAgICAgICAgICAgV0hFTiBtLnN0YXR1cyBJTiAoJ2NvbXBsZXRlJywgJ2RvbmUnKSBBTkQgdy5zdGF0dXMgTk9UIElOICgnY29tcGxldGUnLCAnZG9uZScpXG4gICAgICAgICAgICAgICAgICAgVEhFTiBtLmNyZWF0ZWRfYXQgRUxTRSB3LmNyZWF0ZWRfYXRcbiAgICAgICAgICAgICAgICAgRU5ELFxuICAgICAgICAgICAgICAgICBDQVNFXG4gICAgICAgICAgICAgICAgICAgV0hFTiBtLnN0YXR1cyBJTiAoJ2NvbXBsZXRlJywgJ2RvbmUnKSBBTkQgdy5zdGF0dXMgTk9UIElOICgnY29tcGxldGUnLCAnZG9uZScpXG4gICAgICAgICAgICAgICAgICAgVEhFTiBtLmNvbXBsZXRlZF9hdCBFTFNFIHcuY29tcGxldGVkX2F0XG4gICAgICAgICAgICAgICAgIEVORCxcbiAgICAgICAgICAgICAgICAgdy52aXNpb24sIHcuc3VjY2Vzc19jcml0ZXJpYSwgdy5rZXlfcmlza3MsIHcucHJvb2Zfc3RyYXRlZ3ksXG4gICAgICAgICAgICAgICAgIHcudmVyaWZpY2F0aW9uX2NvbnRyYWN0LCB3LnZlcmlmaWNhdGlvbl9pbnRlZ3JhdGlvbiwgdy52ZXJpZmljYXRpb25fb3BlcmF0aW9uYWwsIHcudmVyaWZpY2F0aW9uX3VhdCxcbiAgICAgICAgICAgICAgICAgdy5kZWZpbml0aW9uX29mX2RvbmUsIHcucmVxdWlyZW1lbnRfY292ZXJhZ2UsIHcuYm91bmRhcnlfbWFwX21hcmtkb3duLFxuICAgICAgICAgICAgICAgICAke2hhc01pbGVzdG9uZVNlcXVlbmNlID8gXCJDT0FMRVNDRSh3LnNlcXVlbmNlLCAwKVwiIDogXCJDT0FMRVNDRShtLnNlcXVlbmNlLCAwKVwifVxuICAgICAgICAgIEZST00gd3QubWlsZXN0b25lcyB3XG4gICAgICAgICAgTEVGVCBKT0lOIG1pbGVzdG9uZXMgbSBPTiBtLmlkID0gdy5pZFxuICAgICAgICBgKS5ydW4oKSk7XG5cbiAgICAgICAgLy8gTWVyZ2Ugc2xpY2VzIFx1MjAxNCBwcmVzZXJ2ZSB3b3JrdHJlZSBwcm9ncmVzcyBidXQgbmV2ZXIgZG93bmdyYWRlIGNvbXBsZXRlZCBzdGF0dXMgKCMyNTU4KS5cbiAgICAgICAgLy8gQURSLTAxMSBQaGFzZSAxOiBjYXJyeSBpc19za2V0Y2ggKyBza2V0Y2hfc2NvcGUgc28gcmVjb25jaWxlIGRvZXNuJ3RcbiAgICAgICAgLy8gc2lsZW50bHkgY2xlYXIgc2tldGNoIG1ldGFkYXRhLiBXaGVuIHRoZSB3b3JrdHJlZSBwcmVkYXRlcyB2MTYsXG4gICAgICAgIC8vIGZhbGwgYmFjayB0byB0aGUgbWFpbiBEQidzIGV4aXN0aW5nIHZhbHVlIHJhdGhlciB0aGFuIGEgbGl0ZXJhbCAwLycnLlxuICAgICAgICBtZXJnZWQuc2xpY2VzID0gY291bnRDaGFuZ2VzKGFkYXB0ZXIucHJlcGFyZShgXG4gICAgICAgICAgSU5TRVJUIE9SIFJFUExBQ0UgSU5UTyBzbGljZXMgKFxuICAgICAgICAgICAgbWlsZXN0b25lX2lkLCBpZCwgdGl0bGUsIHN0YXR1cywgcmlzaywgZGVwZW5kcywgZGVtbywgY3JlYXRlZF9hdCwgY29tcGxldGVkX2F0LFxuICAgICAgICAgICAgZnVsbF9zdW1tYXJ5X21kLCBmdWxsX3VhdF9tZCwgZ29hbCwgc3VjY2Vzc19jcml0ZXJpYSwgcHJvb2ZfbGV2ZWwsXG4gICAgICAgICAgICBpbnRlZ3JhdGlvbl9jbG9zdXJlLCBvYnNlcnZhYmlsaXR5X2ltcGFjdCwgc2VxdWVuY2UsIHJlcGxhbl90cmlnZ2VyZWRfYXQsXG4gICAgICAgICAgICBpc19za2V0Y2gsIHNrZXRjaF9zY29wZVxuICAgICAgICAgIClcbiAgICAgICAgICBTRUxFQ1Qgdy5taWxlc3RvbmVfaWQsIHcuaWQsIHcudGl0bGUsXG4gICAgICAgICAgICAgICAgIENBU0VcbiAgICAgICAgICAgICAgICAgICBXSEVOIG0uc3RhdHVzIElOICgnY29tcGxldGUnLCAnZG9uZScpIEFORCB3LnN0YXR1cyBOT1QgSU4gKCdjb21wbGV0ZScsICdkb25lJylcbiAgICAgICAgICAgICAgICAgICBUSEVOIG0uc3RhdHVzIEVMU0Ugdy5zdGF0dXNcbiAgICAgICAgICAgICAgICAgRU5ELFxuICAgICAgICAgICAgICAgICB3LnJpc2ssIHcuZGVwZW5kcywgdy5kZW1vLCB3LmNyZWF0ZWRfYXQsXG4gICAgICAgICAgICAgICAgIENBU0VcbiAgICAgICAgICAgICAgICAgICBXSEVOIG0uc3RhdHVzIElOICgnY29tcGxldGUnLCAnZG9uZScpIEFORCB3LnN0YXR1cyBOT1QgSU4gKCdjb21wbGV0ZScsICdkb25lJylcbiAgICAgICAgICAgICAgICAgICBUSEVOIG0uY29tcGxldGVkX2F0IEVMU0Ugdy5jb21wbGV0ZWRfYXRcbiAgICAgICAgICAgICAgICAgRU5ELFxuICAgICAgICAgICAgICAgICB3LmZ1bGxfc3VtbWFyeV9tZCwgdy5mdWxsX3VhdF9tZCwgdy5nb2FsLCB3LnN1Y2Nlc3NfY3JpdGVyaWEsIHcucHJvb2ZfbGV2ZWwsXG4gICAgICAgICAgICAgICAgIHcuaW50ZWdyYXRpb25fY2xvc3VyZSwgdy5vYnNlcnZhYmlsaXR5X2ltcGFjdCwgdy5zZXF1ZW5jZSwgdy5yZXBsYW5fdHJpZ2dlcmVkX2F0LFxuICAgICAgICAgICAgICAgICAke2hhc0lzU2tldGNoID8gXCJ3LmlzX3NrZXRjaFwiIDogXCJDT0FMRVNDRShtLmlzX3NrZXRjaCwgMClcIn0sXG4gICAgICAgICAgICAgICAgICR7aGFzU2tldGNoU2NvcGUgPyBcIncuc2tldGNoX3Njb3BlXCIgOiBcIkNPQUxFU0NFKG0uc2tldGNoX3Njb3BlLCAnJylcIn1cbiAgICAgICAgICBGUk9NIHd0LnNsaWNlcyB3XG4gICAgICAgICAgTEVGVCBKT0lOIHNsaWNlcyBtIE9OIG0ubWlsZXN0b25lX2lkID0gdy5taWxlc3RvbmVfaWQgQU5EIG0uaWQgPSB3LmlkXG4gICAgICAgIGApLnJ1bigpKTtcblxuICAgICAgICAvLyBNZXJnZSB0YXNrcyBcdTIwMTQgcHJlc2VydmUgZXhlY3V0aW9uIHJlc3VsdHMsIG5ldmVyIGRvd25ncmFkZSBjb21wbGV0ZWQgc3RhdHVzICgjMjU1OCkuXG4gICAgICAgIC8vIEFEUi0wMTEgUDI6IGNhcnJ5IGJsb2NrZXJfc291cmNlICsgZXNjYWxhdGlvbl8qIGNvbHVtbnMgc28gd29ya3RyZWUgcmVjb25jaWxlXG4gICAgICAgIC8vIGRvZXNuJ3Qgc2lsZW50bHkgY2xlYXIgZXNjYWxhdGlvbiBzdGF0ZSBiYWNrIHRvIGRlZmF1bHRzLlxuICAgICAgICBtZXJnZWQudGFza3MgPSBjb3VudENoYW5nZXMoYWRhcHRlci5wcmVwYXJlKGBcbiAgICAgICAgICBJTlNFUlQgT1IgUkVQTEFDRSBJTlRPIHRhc2tzIChcbiAgICAgICAgICAgIG1pbGVzdG9uZV9pZCwgc2xpY2VfaWQsIGlkLCB0aXRsZSwgc3RhdHVzLCBvbmVfbGluZXIsIG5hcnJhdGl2ZSxcbiAgICAgICAgICAgIHZlcmlmaWNhdGlvbl9yZXN1bHQsIGR1cmF0aW9uLCBjb21wbGV0ZWRfYXQsIGJsb2NrZXJfZGlzY292ZXJlZCxcbiAgICAgICAgICAgIGRldmlhdGlvbnMsIGtub3duX2lzc3Vlcywga2V5X2ZpbGVzLCBrZXlfZGVjaXNpb25zLCBmdWxsX3N1bW1hcnlfbWQsXG4gICAgICAgICAgICBkZXNjcmlwdGlvbiwgZXN0aW1hdGUsIGZpbGVzLCB2ZXJpZnksIGlucHV0cywgZXhwZWN0ZWRfb3V0cHV0LFxuICAgICAgICAgICAgb2JzZXJ2YWJpbGl0eV9pbXBhY3QsIGZ1bGxfcGxhbl9tZCwgc2VxdWVuY2UsXG4gICAgICAgICAgICBibG9ja2VyX3NvdXJjZSwgZXNjYWxhdGlvbl9wZW5kaW5nLCBlc2NhbGF0aW9uX2F3YWl0aW5nX3JldmlldyxcbiAgICAgICAgICAgIGVzY2FsYXRpb25fYXJ0aWZhY3RfcGF0aCwgZXNjYWxhdGlvbl9vdmVycmlkZV9hcHBsaWVkX2F0XG4gICAgICAgICAgKVxuICAgICAgICAgIFNFTEVDVCB3Lm1pbGVzdG9uZV9pZCwgdy5zbGljZV9pZCwgdy5pZCwgdy50aXRsZSxcbiAgICAgICAgICAgICAgICAgQ0FTRVxuICAgICAgICAgICAgICAgICAgIFdIRU4gbS5zdGF0dXMgSU4gKCdjb21wbGV0ZScsICdkb25lJykgQU5EIHcuc3RhdHVzIE5PVCBJTiAoJ2NvbXBsZXRlJywgJ2RvbmUnKVxuICAgICAgICAgICAgICAgICAgIFRIRU4gbS5zdGF0dXMgRUxTRSB3LnN0YXR1c1xuICAgICAgICAgICAgICAgICBFTkQsXG4gICAgICAgICAgICAgICAgIHcub25lX2xpbmVyLCB3Lm5hcnJhdGl2ZSxcbiAgICAgICAgICAgICAgICAgdy52ZXJpZmljYXRpb25fcmVzdWx0LCB3LmR1cmF0aW9uLFxuICAgICAgICAgICAgICAgICBDQVNFXG4gICAgICAgICAgICAgICAgICAgV0hFTiBtLnN0YXR1cyBJTiAoJ2NvbXBsZXRlJywgJ2RvbmUnKSBBTkQgdy5zdGF0dXMgTk9UIElOICgnY29tcGxldGUnLCAnZG9uZScpXG4gICAgICAgICAgICAgICAgICAgVEhFTiBtLmNvbXBsZXRlZF9hdCBFTFNFIHcuY29tcGxldGVkX2F0XG4gICAgICAgICAgICAgICAgIEVORCxcbiAgICAgICAgICAgICAgICAgdy5ibG9ja2VyX2Rpc2NvdmVyZWQsXG4gICAgICAgICAgICAgICAgIHcuZGV2aWF0aW9ucywgdy5rbm93bl9pc3N1ZXMsIHcua2V5X2ZpbGVzLCB3LmtleV9kZWNpc2lvbnMsIHcuZnVsbF9zdW1tYXJ5X21kLFxuICAgICAgICAgICAgICAgICB3LmRlc2NyaXB0aW9uLCB3LmVzdGltYXRlLCB3LmZpbGVzLCB3LnZlcmlmeSwgdy5pbnB1dHMsIHcuZXhwZWN0ZWRfb3V0cHV0LFxuICAgICAgICAgICAgICAgICB3Lm9ic2VydmFiaWxpdHlfaW1wYWN0LCB3LmZ1bGxfcGxhbl9tZCwgdy5zZXF1ZW5jZSxcbiAgICAgICAgICAgICAgICAgJHtoYXNCbG9ja2VyU291cmNlID8gXCJ3LmJsb2NrZXJfc291cmNlXCIgOiBcIkNPQUxFU0NFKG0uYmxvY2tlcl9zb3VyY2UsICcnKVwifSxcbiAgICAgICAgICAgICAgICAgJHtoYXNFc2NhbGF0aW9uUGVuZGluZyA/IFwidy5lc2NhbGF0aW9uX3BlbmRpbmdcIiA6IFwiQ09BTEVTQ0UobS5lc2NhbGF0aW9uX3BlbmRpbmcsIDApXCJ9LFxuICAgICAgICAgICAgICAgICAke2hhc0VzY2FsYXRpb25Bd2FpdGluZyA/IFwidy5lc2NhbGF0aW9uX2F3YWl0aW5nX3Jldmlld1wiIDogXCJDT0FMRVNDRShtLmVzY2FsYXRpb25fYXdhaXRpbmdfcmV2aWV3LCAwKVwifSxcbiAgICAgICAgICAgICAgICAgJHtoYXNFc2NhbGF0aW9uQXJ0aWZhY3QgPyBcIncuZXNjYWxhdGlvbl9hcnRpZmFjdF9wYXRoXCIgOiBcIm0uZXNjYWxhdGlvbl9hcnRpZmFjdF9wYXRoXCJ9LFxuICAgICAgICAgICAgICAgICAke2hhc0VzY2FsYXRpb25PdmVycmlkZSA/IFwidy5lc2NhbGF0aW9uX292ZXJyaWRlX2FwcGxpZWRfYXRcIiA6IFwibS5lc2NhbGF0aW9uX292ZXJyaWRlX2FwcGxpZWRfYXRcIn1cbiAgICAgICAgICBGUk9NIHd0LnRhc2tzIHdcbiAgICAgICAgICBMRUZUIEpPSU4gdGFza3MgbSBPTiBtLm1pbGVzdG9uZV9pZCA9IHcubWlsZXN0b25lX2lkIEFORCBtLnNsaWNlX2lkID0gdy5zbGljZV9pZCBBTkQgbS5pZCA9IHcuaWRcbiAgICAgICAgYCkucnVuKCkpO1xuXG4gICAgICAgIC8vIE1lcmdlIG1lbW9yaWVzIFx1MjAxNCBrZWVwIHdvcmt0cmVlLWxlYXJuZWQgaW5zaWdodHMuXG4gICAgICAgIC8vIFYxOCAoc2NvcGUsIHRhZ3MpLCBWMjEgKHN0cnVjdHVyZWRfZmllbGRzKSwgVjI4IChsYXN0X2hpdF9hdCk6IGZvciBlYWNoXG4gICAgICAgIC8vIGNvbHVtbiB0aGUgd3QgbWF5IG5vdCB5ZXQgaGF2ZSAob2xkZXIgd29ya3RyZWUgREIpLCBmYWxsIGJhY2sgdG8gdGhlXG4gICAgICAgIC8vIG1haW4gREIncyBleGlzdGluZyB2YWx1ZSB2aWEgTEVGVCBKT0lOIHNvIHJlY29uY2lsZSBuZXZlciBzaWxlbnRseVxuICAgICAgICAvLyByZXNldHMgdGhlc2UgZmllbGRzIHRvIGRlZmF1bHRzIG9uIHJvd3MgdGhhdCBhbHJlYWR5IGhhZCB0aGVtLlxuICAgICAgICBtZXJnZWQubWVtb3JpZXMgPSBjb3VudENoYW5nZXMoYWRhcHRlci5wcmVwYXJlKGBcbiAgICAgICAgICBJTlNFUlQgT1IgUkVQTEFDRSBJTlRPIG1lbW9yaWVzIChcbiAgICAgICAgICAgIHNlcSwgaWQsIGNhdGVnb3J5LCBjb250ZW50LCBjb25maWRlbmNlLCBzb3VyY2VfdW5pdF90eXBlLCBzb3VyY2VfdW5pdF9pZCxcbiAgICAgICAgICAgIGNyZWF0ZWRfYXQsIHVwZGF0ZWRfYXQsIHN1cGVyc2VkZWRfYnksIGhpdF9jb3VudCxcbiAgICAgICAgICAgIHNjb3BlLCB0YWdzLCBzdHJ1Y3R1cmVkX2ZpZWxkcywgbGFzdF9oaXRfYXRcbiAgICAgICAgICApXG4gICAgICAgICAgU0VMRUNUIHcuc2VxLCB3LmlkLCB3LmNhdGVnb3J5LCB3LmNvbnRlbnQsIHcuY29uZmlkZW5jZSwgdy5zb3VyY2VfdW5pdF90eXBlLCB3LnNvdXJjZV91bml0X2lkLFxuICAgICAgICAgICAgICAgICB3LmNyZWF0ZWRfYXQsIHcudXBkYXRlZF9hdCwgdy5zdXBlcnNlZGVkX2J5LCB3LmhpdF9jb3VudCxcbiAgICAgICAgICAgICAgICAgJHtoYXNNZW1vcnlTY29wZSA/IFwidy5zY29wZVwiIDogXCJDT0FMRVNDRShtLnNjb3BlLCAncHJvamVjdCcpXCJ9LFxuICAgICAgICAgICAgICAgICAke2hhc01lbW9yeVRhZ3MgPyBcIncudGFnc1wiIDogXCJDT0FMRVNDRShtLnRhZ3MsICdbXScpXCJ9LFxuICAgICAgICAgICAgICAgICAke2hhc01lbW9yeVN0cnVjdHVyZWRGaWVsZHMgPyBcIncuc3RydWN0dXJlZF9maWVsZHNcIiA6IFwibS5zdHJ1Y3R1cmVkX2ZpZWxkc1wifSxcbiAgICAgICAgICAgICAgICAgJHtoYXNNZW1vcnlMYXN0SGl0QXQgPyBcIncubGFzdF9oaXRfYXRcIiA6IFwibS5sYXN0X2hpdF9hdFwifVxuICAgICAgICAgIEZST00gd3QubWVtb3JpZXMgd1xuICAgICAgICAgIExFRlQgSk9JTiBtZW1vcmllcyBtIE9OIG0uaWQgPSB3LmlkXG4gICAgICAgIGApLnJ1bigpKTtcblxuICAgICAgICAvLyBNZXJnZSB2ZXJpZmljYXRpb24gZXZpZGVuY2UgXHUyMDE0IGFwcGVuZC1vbmx5LCB1c2UgSU5TRVJUIE9SIElHTk9SRSB0byBhdm9pZCBkdXBsaWNhdGVzXG4gICAgICAgIG1lcmdlZC52ZXJpZmljYXRpb25fZXZpZGVuY2UgPSBjb3VudENoYW5nZXMoYWRhcHRlci5wcmVwYXJlKGBcbiAgICAgICAgICBJTlNFUlQgT1IgSUdOT1JFIElOVE8gdmVyaWZpY2F0aW9uX2V2aWRlbmNlIChcbiAgICAgICAgICAgIHRhc2tfaWQsIHNsaWNlX2lkLCBtaWxlc3RvbmVfaWQsIGNvbW1hbmQsIGV4aXRfY29kZSwgdmVyZGljdCwgZHVyYXRpb25fbXMsIGNyZWF0ZWRfYXRcbiAgICAgICAgICApXG4gICAgICAgICAgU0VMRUNUIHRhc2tfaWQsIHNsaWNlX2lkLCBtaWxlc3RvbmVfaWQsIGNvbW1hbmQsIGV4aXRfY29kZSwgdmVyZGljdCwgZHVyYXRpb25fbXMsIGNyZWF0ZWRfYXRcbiAgICAgICAgICBGUk9NIHd0LnZlcmlmaWNhdGlvbl9ldmlkZW5jZVxuICAgICAgICBgKS5ydW4oKSk7XG5cbiAgICAgICAgYWRhcHRlci5leGVjKFwiQ09NTUlUXCIpO1xuICAgICAgfSBjYXRjaCAodHhFcnIpIHtcbiAgICAgICAgdHJ5IHsgYWRhcHRlci5leGVjKFwiUk9MTEJBQ0tcIik7IH0gY2F0Y2ggKGUpIHsgbG9nV2FybmluZyhcImRiXCIsIGByb2xsYmFjayBmYWlsZWQ6ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7IH1cbiAgICAgICAgdGhyb3cgdHhFcnI7XG4gICAgICB9XG4gICAgICByZXR1cm4geyAuLi5tZXJnZWQsIGNvbmZsaWN0cyB9O1xuICAgIH0gZmluYWxseSB7XG4gICAgICB0cnkgeyBhZGFwdGVyLmV4ZWMoXCJERVRBQ0ggREFUQUJBU0Ugd3RcIik7IH0gY2F0Y2ggKGUpIHsgbG9nV2FybmluZyhcImRiXCIsIGBkZXRhY2ggd29ya3RyZWUgREIgZmFpbGVkOiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWApOyB9XG4gICAgfVxuICB9IGNhdGNoIChlcnIpIHtcbiAgICBsb2dFcnJvcihcImRiXCIsIFwid29ya3RyZWUgREIgcmVjb25jaWxpYXRpb24gZmFpbGVkXCIsIHsgZXJyb3I6IChlcnIgYXMgRXJyb3IpLm1lc3NhZ2UgfSk7XG4gICAgcmV0dXJuIHsgLi4uemVybywgY29uZmxpY3RzIH07XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFJlcGxhbiAmIEFzc2Vzc21lbnQgSGVscGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGZ1bmN0aW9uIGluc2VydFJlcGxhbkhpc3RvcnkoZW50cnk6IHtcbiAgbWlsZXN0b25lSWQ6IHN0cmluZztcbiAgc2xpY2VJZD86IHN0cmluZyB8IG51bGw7XG4gIHRhc2tJZD86IHN0cmluZyB8IG51bGw7XG4gIHN1bW1hcnk6IHN0cmluZztcbiAgcHJldmlvdXNBcnRpZmFjdFBhdGg/OiBzdHJpbmcgfCBudWxsO1xuICByZXBsYWNlbWVudEFydGlmYWN0UGF0aD86IHN0cmluZyB8IG51bGw7XG59KTogdm9pZCB7XG4gIGlmICghY3VycmVudERiKSB0aHJvdyBuZXcgR1NERXJyb3IoR1NEX1NUQUxFX1NUQVRFLCBcImdzZC1kYjogTm8gZGF0YWJhc2Ugb3BlblwiKTtcbiAgLy8gSU5TRVJUIE9SIFJFUExBQ0U6IGlkZW1wb3RlbnQgb24gKG1pbGVzdG9uZV9pZCwgc2xpY2VfaWQsIHRhc2tfaWQpIHZpYSBzY2hlbWEgdjExIHVuaXF1ZSBpbmRleC5cbiAgLy8gUmV0cnlpbmcgdGhlIHNhbWUgcmVwbGFuIHNpbGVudGx5IHVwZGF0ZXMgc3VtbWFyeSBpbnN0ZWFkIG9mIGFjY3VtdWxhdGluZyBkdXBsaWNhdGUgcm93cy5cbiAgY3VycmVudERiLnByZXBhcmUoXG4gICAgYElOU0VSVCBPUiBSRVBMQUNFIElOVE8gcmVwbGFuX2hpc3RvcnkgKG1pbGVzdG9uZV9pZCwgc2xpY2VfaWQsIHRhc2tfaWQsIHN1bW1hcnksIHByZXZpb3VzX2FydGlmYWN0X3BhdGgsIHJlcGxhY2VtZW50X2FydGlmYWN0X3BhdGgsIGNyZWF0ZWRfYXQpXG4gICAgIFZBTFVFUyAoOm1pbGVzdG9uZV9pZCwgOnNsaWNlX2lkLCA6dGFza19pZCwgOnN1bW1hcnksIDpwcmV2aW91c19hcnRpZmFjdF9wYXRoLCA6cmVwbGFjZW1lbnRfYXJ0aWZhY3RfcGF0aCwgOmNyZWF0ZWRfYXQpYCxcbiAgKS5ydW4oe1xuICAgIFwiOm1pbGVzdG9uZV9pZFwiOiBlbnRyeS5taWxlc3RvbmVJZCxcbiAgICBcIjpzbGljZV9pZFwiOiBlbnRyeS5zbGljZUlkID8/IG51bGwsXG4gICAgXCI6dGFza19pZFwiOiBlbnRyeS50YXNrSWQgPz8gbnVsbCxcbiAgICBcIjpzdW1tYXJ5XCI6IGVudHJ5LnN1bW1hcnksXG4gICAgXCI6cHJldmlvdXNfYXJ0aWZhY3RfcGF0aFwiOiBlbnRyeS5wcmV2aW91c0FydGlmYWN0UGF0aCA/PyBudWxsLFxuICAgIFwiOnJlcGxhY2VtZW50X2FydGlmYWN0X3BhdGhcIjogZW50cnkucmVwbGFjZW1lbnRBcnRpZmFjdFBhdGggPz8gbnVsbCxcbiAgICBcIjpjcmVhdGVkX2F0XCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpbnNlcnRBc3Nlc3NtZW50KGVudHJ5OiB7XG4gIHBhdGg6IHN0cmluZztcbiAgbWlsZXN0b25lSWQ6IHN0cmluZztcbiAgc2xpY2VJZD86IHN0cmluZyB8IG51bGw7XG4gIHRhc2tJZD86IHN0cmluZyB8IG51bGw7XG4gIHN0YXR1czogc3RyaW5nO1xuICBzY29wZTogc3RyaW5nO1xuICBmdWxsQ29udGVudDogc3RyaW5nO1xufSk6IHZvaWQge1xuICBpZiAoIWN1cnJlbnREYikgdGhyb3cgbmV3IEdTREVycm9yKEdTRF9TVEFMRV9TVEFURSwgXCJnc2QtZGI6IE5vIGRhdGFiYXNlIG9wZW5cIik7XG4gIC8vIElkZW1wb3RlbnQ6IFBSSU1BUlkgS0VZIGlzIGBwYXRoYCwgd2hpY2ggaXMgZGV0ZXJtaW5pc3RpYyBnaXZlbiAobWlsZXN0b25lX2lkLCBzY29wZSkgcGVyXG4gIC8vIHRoZSBhcnRpZmFjdC1wYXRoIHJlc29sdmVyLiBSZXRyeWluZyB0aGUgc2FtZSByZWFzc2Vzcy1yb2FkbWFwIHNpbGVudGx5IG92ZXJ3cml0ZXMgdGhlIHJvd1xuICAvLyBpbnN0ZWFkIG9mIGFjY3VtdWxhdGluZyBkdXBsaWNhdGVzLlxuICBjdXJyZW50RGIucHJlcGFyZShcbiAgICBgSU5TRVJUIE9SIFJFUExBQ0UgSU5UTyBhc3Nlc3NtZW50cyAocGF0aCwgbWlsZXN0b25lX2lkLCBzbGljZV9pZCwgdGFza19pZCwgc3RhdHVzLCBzY29wZSwgZnVsbF9jb250ZW50LCBjcmVhdGVkX2F0KVxuICAgICBWQUxVRVMgKDpwYXRoLCA6bWlsZXN0b25lX2lkLCA6c2xpY2VfaWQsIDp0YXNrX2lkLCA6c3RhdHVzLCA6c2NvcGUsIDpmdWxsX2NvbnRlbnQsIDpjcmVhdGVkX2F0KWAsXG4gICkucnVuKHtcbiAgICBcIjpwYXRoXCI6IGVudHJ5LnBhdGgsXG4gICAgXCI6bWlsZXN0b25lX2lkXCI6IGVudHJ5Lm1pbGVzdG9uZUlkLFxuICAgIFwiOnNsaWNlX2lkXCI6IGVudHJ5LnNsaWNlSWQgPz8gbnVsbCxcbiAgICBcIjp0YXNrX2lkXCI6IGVudHJ5LnRhc2tJZCA/PyBudWxsLFxuICAgIFwiOnN0YXR1c1wiOiBlbnRyeS5zdGF0dXMsXG4gICAgXCI6c2NvcGVcIjogZW50cnkuc2NvcGUsXG4gICAgXCI6ZnVsbF9jb250ZW50XCI6IGVudHJ5LmZ1bGxDb250ZW50LFxuICAgIFwiOmNyZWF0ZWRfYXRcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGRlbGV0ZUFzc2Vzc21lbnRCeVNjb3BlKG1pbGVzdG9uZUlkOiBzdHJpbmcsIHNjb3BlOiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKCFjdXJyZW50RGIpIHRocm93IG5ldyBHU0RFcnJvcihHU0RfU1RBTEVfU1RBVEUsIFwiZ3NkLWRiOiBObyBkYXRhYmFzZSBvcGVuXCIpO1xuICBjdXJyZW50RGIucHJlcGFyZShcbiAgICBgREVMRVRFIEZST00gYXNzZXNzbWVudHMgV0hFUkUgbWlsZXN0b25lX2lkID0gOm1pZCBBTkQgc2NvcGUgPSA6c2NvcGVgLFxuICApLnJ1bih7IFwiOm1pZFwiOiBtaWxlc3RvbmVJZCwgXCI6c2NvcGVcIjogc2NvcGUgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBkZWxldGVWZXJpZmljYXRpb25FdmlkZW5jZShtaWxlc3RvbmVJZDogc3RyaW5nLCBzbGljZUlkOiBzdHJpbmcsIHRhc2tJZDogc3RyaW5nKTogdm9pZCB7XG4gIGlmICghY3VycmVudERiKSB0aHJvdyBuZXcgR1NERXJyb3IoR1NEX1NUQUxFX1NUQVRFLCBcImdzZC1kYjogTm8gZGF0YWJhc2Ugb3BlblwiKTtcbiAgY3VycmVudERiLnByZXBhcmUoXG4gICAgYERFTEVURSBGUk9NIHZlcmlmaWNhdGlvbl9ldmlkZW5jZSBXSEVSRSBtaWxlc3RvbmVfaWQgPSA6bWlkIEFORCBzbGljZV9pZCA9IDpzaWQgQU5EIHRhc2tfaWQgPSA6dGlkYCxcbiAgKS5ydW4oeyBcIjptaWRcIjogbWlsZXN0b25lSWQsIFwiOnNpZFwiOiBzbGljZUlkLCBcIjp0aWRcIjogdGFza0lkIH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZGVsZXRlVGFzayhtaWxlc3RvbmVJZDogc3RyaW5nLCBzbGljZUlkOiBzdHJpbmcsIHRhc2tJZDogc3RyaW5nKTogdm9pZCB7XG4gIGlmICghY3VycmVudERiKSB0aHJvdyBuZXcgR1NERXJyb3IoR1NEX1NUQUxFX1NUQVRFLCBcImdzZC1kYjogTm8gZGF0YWJhc2Ugb3BlblwiKTtcbiAgdHJhbnNhY3Rpb24oKCkgPT4ge1xuICAgIC8vIE11c3QgZGVsZXRlIHZlcmlmaWNhdGlvbl9ldmlkZW5jZSBmaXJzdCAoRksgY29uc3RyYWludClcbiAgICBjdXJyZW50RGIhLnByZXBhcmUoXG4gICAgICBgREVMRVRFIEZST00gdmVyaWZpY2F0aW9uX2V2aWRlbmNlIFdIRVJFIG1pbGVzdG9uZV9pZCA9IDptaWQgQU5EIHNsaWNlX2lkID0gOnNpZCBBTkQgdGFza19pZCA9IDp0aWRgLFxuICAgICkucnVuKHsgXCI6bWlkXCI6IG1pbGVzdG9uZUlkLCBcIjpzaWRcIjogc2xpY2VJZCwgXCI6dGlkXCI6IHRhc2tJZCB9KTtcbiAgICBjdXJyZW50RGIhLnByZXBhcmUoXG4gICAgICBgREVMRVRFIEZST00gcXVhbGl0eV9nYXRlcyBXSEVSRSBtaWxlc3RvbmVfaWQgPSA6bWlkIEFORCBzbGljZV9pZCA9IDpzaWQgQU5EIHRhc2tfaWQgPSA6dGlkYCxcbiAgICApLnJ1bih7IFwiOm1pZFwiOiBtaWxlc3RvbmVJZCwgXCI6c2lkXCI6IHNsaWNlSWQsIFwiOnRpZFwiOiB0YXNrSWQgfSk7XG4gICAgY3VycmVudERiIS5wcmVwYXJlKFxuICAgICAgYERFTEVURSBGUk9NIHRhc2tzIFdIRVJFIG1pbGVzdG9uZV9pZCA9IDptaWQgQU5EIHNsaWNlX2lkID0gOnNpZCBBTkQgaWQgPSA6dGlkYCxcbiAgICApLnJ1bih7IFwiOm1pZFwiOiBtaWxlc3RvbmVJZCwgXCI6c2lkXCI6IHNsaWNlSWQsIFwiOnRpZFwiOiB0YXNrSWQgfSk7XG4gIH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZGVsZXRlU2xpY2UobWlsZXN0b25lSWQ6IHN0cmluZywgc2xpY2VJZDogc3RyaW5nKTogdm9pZCB7XG4gIGlmICghY3VycmVudERiKSB0aHJvdyBuZXcgR1NERXJyb3IoR1NEX1NUQUxFX1NUQVRFLCBcImdzZC1kYjogTm8gZGF0YWJhc2Ugb3BlblwiKTtcbiAgdHJhbnNhY3Rpb24oKCkgPT4ge1xuICAgIC8vIENhc2NhZGUtc3R5bGUgbWFudWFsIGRlbGV0aW9uOiBldmlkZW5jZSBcdTIxOTIgdGFza3MgXHUyMTkyIGRlcGVuZGVuY2llcyBcdTIxOTIgc2xpY2VcbiAgICBjdXJyZW50RGIhLnByZXBhcmUoXG4gICAgICBgREVMRVRFIEZST00gdmVyaWZpY2F0aW9uX2V2aWRlbmNlIFdIRVJFIG1pbGVzdG9uZV9pZCA9IDptaWQgQU5EIHNsaWNlX2lkID0gOnNpZGAsXG4gICAgKS5ydW4oeyBcIjptaWRcIjogbWlsZXN0b25lSWQsIFwiOnNpZFwiOiBzbGljZUlkIH0pO1xuICAgIGN1cnJlbnREYiEucHJlcGFyZShcbiAgICAgIGBERUxFVEUgRlJPTSB0YXNrcyBXSEVSRSBtaWxlc3RvbmVfaWQgPSA6bWlkIEFORCBzbGljZV9pZCA9IDpzaWRgLFxuICAgICkucnVuKHsgXCI6bWlkXCI6IG1pbGVzdG9uZUlkLCBcIjpzaWRcIjogc2xpY2VJZCB9KTtcbiAgICBjdXJyZW50RGIhLnByZXBhcmUoXG4gICAgICBgREVMRVRFIEZST00gc2xpY2VfZGVwZW5kZW5jaWVzIFdIRVJFIG1pbGVzdG9uZV9pZCA9IDptaWQgQU5EIHNsaWNlX2lkID0gOnNpZGAsXG4gICAgKS5ydW4oeyBcIjptaWRcIjogbWlsZXN0b25lSWQsIFwiOnNpZFwiOiBzbGljZUlkIH0pO1xuICAgIGN1cnJlbnREYiEucHJlcGFyZShcbiAgICAgIGBERUxFVEUgRlJPTSBzbGljZV9kZXBlbmRlbmNpZXMgV0hFUkUgbWlsZXN0b25lX2lkID0gOm1pZCBBTkQgZGVwZW5kc19vbl9zbGljZV9pZCA9IDpzaWRgLFxuICAgICkucnVuKHsgXCI6bWlkXCI6IG1pbGVzdG9uZUlkLCBcIjpzaWRcIjogc2xpY2VJZCB9KTtcbiAgICBjdXJyZW50RGIhLnByZXBhcmUoXG4gICAgICBgREVMRVRFIEZST00gc2xpY2VzIFdIRVJFIG1pbGVzdG9uZV9pZCA9IDptaWQgQU5EIGlkID0gOnNpZGAsXG4gICAgKS5ydW4oeyBcIjptaWRcIjogbWlsZXN0b25lSWQsIFwiOnNpZFwiOiBzbGljZUlkIH0pO1xuICB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGRlbGV0ZU1pbGVzdG9uZShtaWxlc3RvbmVJZDogc3RyaW5nKTogdm9pZCB7XG4gIGlmICghY3VycmVudERiKSB0aHJvdyBuZXcgR1NERXJyb3IoR1NEX1NUQUxFX1NUQVRFLCBcImdzZC1kYjogTm8gZGF0YWJhc2Ugb3BlblwiKTtcbiAgdHJhbnNhY3Rpb24oKCkgPT4ge1xuICAgIGN1cnJlbnREYiEucHJlcGFyZShcbiAgICAgIGBERUxFVEUgRlJPTSB2ZXJpZmljYXRpb25fZXZpZGVuY2UgV0hFUkUgbWlsZXN0b25lX2lkID0gOm1pZGAsXG4gICAgKS5ydW4oeyBcIjptaWRcIjogbWlsZXN0b25lSWQgfSk7XG4gICAgY3VycmVudERiIS5wcmVwYXJlKFxuICAgICAgYERFTEVURSBGUk9NIHF1YWxpdHlfZ2F0ZXMgV0hFUkUgbWlsZXN0b25lX2lkID0gOm1pZGAsXG4gICAgKS5ydW4oeyBcIjptaWRcIjogbWlsZXN0b25lSWQgfSk7XG4gICAgY3VycmVudERiIS5wcmVwYXJlKFxuICAgICAgYERFTEVURSBGUk9NIGdhdGVfcnVucyBXSEVSRSBtaWxlc3RvbmVfaWQgPSA6bWlkYCxcbiAgICApLnJ1bih7IFwiOm1pZFwiOiBtaWxlc3RvbmVJZCB9KTtcbiAgICBjdXJyZW50RGIhLnByZXBhcmUoXG4gICAgICBgREVMRVRFIEZST00gdGFza3MgV0hFUkUgbWlsZXN0b25lX2lkID0gOm1pZGAsXG4gICAgKS5ydW4oeyBcIjptaWRcIjogbWlsZXN0b25lSWQgfSk7XG4gICAgY3VycmVudERiIS5wcmVwYXJlKFxuICAgICAgYERFTEVURSBGUk9NIHNsaWNlX2RlcGVuZGVuY2llcyBXSEVSRSBtaWxlc3RvbmVfaWQgPSA6bWlkYCxcbiAgICApLnJ1bih7IFwiOm1pZFwiOiBtaWxlc3RvbmVJZCB9KTtcbiAgICBjdXJyZW50RGIhLnByZXBhcmUoXG4gICAgICBgREVMRVRFIEZST00gc2xpY2VzIFdIRVJFIG1pbGVzdG9uZV9pZCA9IDptaWRgLFxuICAgICkucnVuKHsgXCI6bWlkXCI6IG1pbGVzdG9uZUlkIH0pO1xuICAgIGN1cnJlbnREYiEucHJlcGFyZShcbiAgICAgIGBERUxFVEUgRlJPTSByZXBsYW5faGlzdG9yeSBXSEVSRSBtaWxlc3RvbmVfaWQgPSA6bWlkYCxcbiAgICApLnJ1bih7IFwiOm1pZFwiOiBtaWxlc3RvbmVJZCB9KTtcbiAgICBjdXJyZW50RGIhLnByZXBhcmUoXG4gICAgICBgREVMRVRFIEZST00gYXNzZXNzbWVudHMgV0hFUkUgbWlsZXN0b25lX2lkID0gOm1pZGAsXG4gICAgKS5ydW4oeyBcIjptaWRcIjogbWlsZXN0b25lSWQgfSk7XG4gICAgY3VycmVudERiIS5wcmVwYXJlKFxuICAgICAgYERFTEVURSBGUk9NIGFydGlmYWN0cyBXSEVSRSBtaWxlc3RvbmVfaWQgPSA6bWlkYCxcbiAgICApLnJ1bih7IFwiOm1pZFwiOiBtaWxlc3RvbmVJZCB9KTtcbiAgICBjdXJyZW50RGIhLnByZXBhcmUoXG4gICAgICBgREVMRVRFIEZST00gbWlsZXN0b25lX2NvbW1pdF9hdHRyaWJ1dGlvbnMgV0hFUkUgbWlsZXN0b25lX2lkID0gOm1pZGAsXG4gICAgKS5ydW4oeyBcIjptaWRcIjogbWlsZXN0b25lSWQgfSk7XG4gICAgY3VycmVudERiIS5wcmVwYXJlKFxuICAgICAgYERFTEVURSBGUk9NIG1pbGVzdG9uZV9sZWFzZXMgV0hFUkUgbWlsZXN0b25lX2lkID0gOm1pZGAsXG4gICAgKS5ydW4oeyBcIjptaWRcIjogbWlsZXN0b25lSWQgfSk7XG4gICAgY3VycmVudERiIS5wcmVwYXJlKFxuICAgICAgYERFTEVURSBGUk9NIG1pbGVzdG9uZXMgV0hFUkUgaWQgPSA6bWlkYCxcbiAgICApLnJ1bih7IFwiOm1pZFwiOiBtaWxlc3RvbmVJZCB9KTtcbiAgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVTbGljZUZpZWxkcyhtaWxlc3RvbmVJZDogc3RyaW5nLCBzbGljZUlkOiBzdHJpbmcsIGZpZWxkczoge1xuICB0aXRsZT86IHN0cmluZztcbiAgcmlzaz86IHN0cmluZztcbiAgZGVwZW5kcz86IHN0cmluZ1tdO1xuICBkZW1vPzogc3RyaW5nO1xufSk6IHZvaWQge1xuICBpZiAoIWN1cnJlbnREYikgdGhyb3cgbmV3IEdTREVycm9yKEdTRF9TVEFMRV9TVEFURSwgXCJnc2QtZGI6IE5vIGRhdGFiYXNlIG9wZW5cIik7XG4gIGN1cnJlbnREYi5wcmVwYXJlKFxuICAgIGBVUERBVEUgc2xpY2VzIFNFVFxuICAgICAgdGl0bGUgPSBDT0FMRVNDRSg6dGl0bGUsIHRpdGxlKSxcbiAgICAgIHJpc2sgPSBDT0FMRVNDRSg6cmlzaywgcmlzayksXG4gICAgICBkZXBlbmRzID0gQ09BTEVTQ0UoOmRlcGVuZHMsIGRlcGVuZHMpLFxuICAgICAgZGVtbyA9IENPQUxFU0NFKDpkZW1vLCBkZW1vKVxuICAgICBXSEVSRSBtaWxlc3RvbmVfaWQgPSA6bWlsZXN0b25lX2lkIEFORCBpZCA9IDppZGAsXG4gICkucnVuKHtcbiAgICBcIjptaWxlc3RvbmVfaWRcIjogbWlsZXN0b25lSWQsXG4gICAgXCI6aWRcIjogc2xpY2VJZCxcbiAgICBcIjp0aXRsZVwiOiBmaWVsZHMudGl0bGUgPz8gbnVsbCxcbiAgICBcIjpyaXNrXCI6IGZpZWxkcy5yaXNrID8/IG51bGwsXG4gICAgXCI6ZGVwZW5kc1wiOiBmaWVsZHMuZGVwZW5kcyA/IEpTT04uc3RyaW5naWZ5KGZpZWxkcy5kZXBlbmRzKSA6IG51bGwsXG4gICAgXCI6ZGVtb1wiOiBmaWVsZHMuZGVtbyA/PyBudWxsLFxuICB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldFJlcGxhbkhpc3RvcnkobWlsZXN0b25lSWQ6IHN0cmluZywgc2xpY2VJZD86IHN0cmluZyk6IEFycmF5PFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gIGlmICghY3VycmVudERiKSByZXR1cm4gW107XG4gIGlmIChzbGljZUlkKSB7XG4gICAgcmV0dXJuIGN1cnJlbnREYi5wcmVwYXJlKFxuICAgICAgYFNFTEVDVCAqIEZST00gcmVwbGFuX2hpc3RvcnkgV0hFUkUgbWlsZXN0b25lX2lkID0gOm1pZCBBTkQgc2xpY2VfaWQgPSA6c2lkIE9SREVSIEJZIGNyZWF0ZWRfYXQgREVTQ2AsXG4gICAgKS5hbGwoeyBcIjptaWRcIjogbWlsZXN0b25lSWQsIFwiOnNpZFwiOiBzbGljZUlkIH0pO1xuICB9XG4gIHJldHVybiBjdXJyZW50RGIucHJlcGFyZShcbiAgICBgU0VMRUNUICogRlJPTSByZXBsYW5faGlzdG9yeSBXSEVSRSBtaWxlc3RvbmVfaWQgPSA6bWlkIE9SREVSIEJZIGNyZWF0ZWRfYXQgREVTQ2AsXG4gICkuYWxsKHsgXCI6bWlkXCI6IG1pbGVzdG9uZUlkIH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0QXNzZXNzbWVudChwYXRoOiBzdHJpbmcpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IG51bGwge1xuICBpZiAoIWN1cnJlbnREYikgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHJvdyA9IGN1cnJlbnREYi5wcmVwYXJlKFxuICAgIGBTRUxFQ1QgKiBGUk9NIGFzc2Vzc21lbnRzIFdIRVJFIHBhdGggPSA6cGF0aGAsXG4gICkuZ2V0KHsgXCI6cGF0aFwiOiBwYXRoIH0pO1xuICByZXR1cm4gcm93ID8/IG51bGw7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRMYXRlc3RBc3Nlc3NtZW50QnlTY29wZShcbiAgbWlsZXN0b25lSWQ6IHN0cmluZyxcbiAgc2NvcGU6IHN0cmluZyxcbik6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbCB7XG4gIGlmICghY3VycmVudERiKSByZXR1cm4gbnVsbDtcbiAgY29uc3Qgcm93ID0gY3VycmVudERiLnByZXBhcmUoXG4gICAgYFNFTEVDVCAqIEZST00gYXNzZXNzbWVudHNcbiAgICAgIFdIRVJFIG1pbGVzdG9uZV9pZCA9IDptaWQgQU5EIHNjb3BlID0gOnNjb3BlXG4gICAgICBPUkRFUiBCWSBjcmVhdGVkX2F0IERFU0NcbiAgICAgIExJTUlUIDFgLFxuICApLmdldCh7IFwiOm1pZFwiOiBtaWxlc3RvbmVJZCwgXCI6c2NvcGVcIjogc2NvcGUgfSk7XG4gIHJldHVybiByb3cgPz8gbnVsbDtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFF1YWxpdHkgR2F0ZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBmdW5jdGlvbiBpbnNlcnRHYXRlUm93KGc6IHtcbiAgbWlsZXN0b25lSWQ6IHN0cmluZztcbiAgc2xpY2VJZDogc3RyaW5nO1xuICBnYXRlSWQ6IEdhdGVJZDtcbiAgc2NvcGU6IEdhdGVTY29wZTtcbiAgdGFza0lkPzogc3RyaW5nIHwgbnVsbDtcbiAgc3RhdHVzPzogR2F0ZVN0YXR1cztcbn0pOiB2b2lkIHtcbiAgaWYgKCFjdXJyZW50RGIpIHRocm93IG5ldyBHU0RFcnJvcihHU0RfU1RBTEVfU1RBVEUsIFwiZ3NkLWRiOiBObyBkYXRhYmFzZSBvcGVuXCIpO1xuICBjdXJyZW50RGIucHJlcGFyZShcbiAgICBgSU5TRVJUIE9SIElHTk9SRSBJTlRPIHF1YWxpdHlfZ2F0ZXMgKG1pbGVzdG9uZV9pZCwgc2xpY2VfaWQsIGdhdGVfaWQsIHNjb3BlLCB0YXNrX2lkLCBzdGF0dXMpXG4gICAgIFZBTFVFUyAoOm1pZCwgOnNpZCwgOmdpZCwgOnNjb3BlLCA6dGlkLCA6c3RhdHVzKWAsXG4gICkucnVuKHtcbiAgICBcIjptaWRcIjogZy5taWxlc3RvbmVJZCxcbiAgICBcIjpzaWRcIjogZy5zbGljZUlkLFxuICAgIFwiOmdpZFwiOiBnLmdhdGVJZCxcbiAgICBcIjpzY29wZVwiOiBnLnNjb3BlLFxuICAgIFwiOnRpZFwiOiBnLnRhc2tJZCA/PyBcIlwiLFxuICAgIFwiOnN0YXR1c1wiOiBnLnN0YXR1cyA/PyBcInBlbmRpbmdcIixcbiAgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzYXZlR2F0ZVJlc3VsdChnOiB7XG4gIG1pbGVzdG9uZUlkOiBzdHJpbmc7XG4gIHNsaWNlSWQ6IHN0cmluZztcbiAgZ2F0ZUlkOiBzdHJpbmc7XG4gIHRhc2tJZD86IHN0cmluZyB8IG51bGw7XG4gIHZlcmRpY3Q6IEdhdGVWZXJkaWN0O1xuICByYXRpb25hbGU6IHN0cmluZztcbiAgZmluZGluZ3M6IHN0cmluZztcbn0pOiB2b2lkIHtcbiAgaWYgKCFjdXJyZW50RGIpIHRocm93IG5ldyBHU0RFcnJvcihHU0RfU1RBTEVfU1RBVEUsIFwiZ3NkLWRiOiBObyBkYXRhYmFzZSBvcGVuXCIpO1xuICBjdXJyZW50RGIucHJlcGFyZShcbiAgICBgVVBEQVRFIHF1YWxpdHlfZ2F0ZXNcbiAgICAgU0VUIHN0YXR1cyA9ICdjb21wbGV0ZScsIHZlcmRpY3QgPSA6dmVyZGljdCwgcmF0aW9uYWxlID0gOnJhdGlvbmFsZSxcbiAgICAgICAgIGZpbmRpbmdzID0gOmZpbmRpbmdzLCBldmFsdWF0ZWRfYXQgPSA6ZXZhbHVhdGVkX2F0XG4gICAgIFdIRVJFIG1pbGVzdG9uZV9pZCA9IDptaWQgQU5EIHNsaWNlX2lkID0gOnNpZCBBTkQgZ2F0ZV9pZCA9IDpnaWRcbiAgICAgICBBTkQgdGFza19pZCA9IDp0aWRgLFxuICApLnJ1bih7XG4gICAgXCI6bWlkXCI6IGcubWlsZXN0b25lSWQsXG4gICAgXCI6c2lkXCI6IGcuc2xpY2VJZCxcbiAgICBcIjpnaWRcIjogZy5nYXRlSWQsXG4gICAgXCI6dGlkXCI6IGcudGFza0lkID8/IFwiXCIsXG4gICAgXCI6dmVyZGljdFwiOiBnLnZlcmRpY3QsXG4gICAgXCI6cmF0aW9uYWxlXCI6IGcucmF0aW9uYWxlLFxuICAgIFwiOmZpbmRpbmdzXCI6IGcuZmluZGluZ3MsXG4gICAgXCI6ZXZhbHVhdGVkX2F0XCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgfSk7XG5cbiAgY29uc3Qgb3V0Y29tZSA9XG4gICAgZy52ZXJkaWN0ID09PSBcInBhc3NcIlxuICAgICAgPyBcInBhc3NcIlxuICAgICAgOiBnLnZlcmRpY3QgPT09IFwib21pdHRlZFwiXG4gICAgICAgID8gXCJtYW51YWwtYXR0ZW50aW9uXCJcbiAgICAgICAgOiBcImZhaWxcIjtcbiAgaW5zZXJ0R2F0ZVJ1bih7XG4gICAgdHJhY2VJZDogYHF1YWxpdHktZ2F0ZToke2cubWlsZXN0b25lSWR9OiR7Zy5zbGljZUlkfWAsXG4gICAgdHVybklkOiBgZ2F0ZToke2cuZ2F0ZUlkfToke2cudGFza0lkID8/IFwic2xpY2VcIn1gLFxuICAgIGdhdGVJZDogZy5nYXRlSWQsXG4gICAgZ2F0ZVR5cGU6IFwicXVhbGl0eS1nYXRlXCIsXG4gICAgbWlsZXN0b25lSWQ6IGcubWlsZXN0b25lSWQsXG4gICAgc2xpY2VJZDogZy5zbGljZUlkLFxuICAgIHRhc2tJZDogZy50YXNrSWQgPz8gdW5kZWZpbmVkLFxuICAgIG91dGNvbWUsXG4gICAgZmFpbHVyZUNsYXNzOiBvdXRjb21lID09PSBcImZhaWxcIiA/IFwidmVyaWZpY2F0aW9uXCIgOiBvdXRjb21lID09PSBcIm1hbnVhbC1hdHRlbnRpb25cIiA/IFwibWFudWFsLWF0dGVudGlvblwiIDogXCJub25lXCIsXG4gICAgcmF0aW9uYWxlOiBnLnJhdGlvbmFsZSxcbiAgICBmaW5kaW5nczogZy5maW5kaW5ncyxcbiAgICBhdHRlbXB0OiAxLFxuICAgIG1heEF0dGVtcHRzOiAxLFxuICAgIHJldHJ5YWJsZTogZmFsc2UsXG4gICAgZXZhbHVhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRQZW5kaW5nR2F0ZXMobWlsZXN0b25lSWQ6IHN0cmluZywgc2xpY2VJZDogc3RyaW5nLCBzY29wZT86IEdhdGVTY29wZSk6IEdhdGVSb3dbXSB7XG4gIGlmICghY3VycmVudERiKSByZXR1cm4gW107XG4gIGNvbnN0IHNxbCA9IHNjb3BlXG4gICAgPyBgU0VMRUNUICogRlJPTSBxdWFsaXR5X2dhdGVzIFdIRVJFIG1pbGVzdG9uZV9pZCA9IDptaWQgQU5EIHNsaWNlX2lkID0gOnNpZCBBTkQgc2NvcGUgPSA6c2NvcGUgQU5EIHN0YXR1cyA9ICdwZW5kaW5nJ2BcbiAgICA6IGBTRUxFQ1QgKiBGUk9NIHF1YWxpdHlfZ2F0ZXMgV0hFUkUgbWlsZXN0b25lX2lkID0gOm1pZCBBTkQgc2xpY2VfaWQgPSA6c2lkIEFORCBzdGF0dXMgPSAncGVuZGluZydgO1xuICBjb25zdCBwYXJhbXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0geyBcIjptaWRcIjogbWlsZXN0b25lSWQsIFwiOnNpZFwiOiBzbGljZUlkIH07XG4gIGlmIChzY29wZSkgcGFyYW1zW1wiOnNjb3BlXCJdID0gc2NvcGU7XG4gIHJldHVybiBjdXJyZW50RGIucHJlcGFyZShzcWwpLmFsbChwYXJhbXMpLm1hcChyb3dUb0dhdGUpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0R2F0ZVJlc3VsdHMobWlsZXN0b25lSWQ6IHN0cmluZywgc2xpY2VJZDogc3RyaW5nLCBzY29wZT86IEdhdGVTY29wZSk6IEdhdGVSb3dbXSB7XG4gIGlmICghY3VycmVudERiKSByZXR1cm4gW107XG4gIGNvbnN0IHNxbCA9IHNjb3BlXG4gICAgPyBgU0VMRUNUICogRlJPTSBxdWFsaXR5X2dhdGVzIFdIRVJFIG1pbGVzdG9uZV9pZCA9IDptaWQgQU5EIHNsaWNlX2lkID0gOnNpZCBBTkQgc2NvcGUgPSA6c2NvcGVgXG4gICAgOiBgU0VMRUNUICogRlJPTSBxdWFsaXR5X2dhdGVzIFdIRVJFIG1pbGVzdG9uZV9pZCA9IDptaWQgQU5EIHNsaWNlX2lkID0gOnNpZGA7XG4gIGNvbnN0IHBhcmFtczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7IFwiOm1pZFwiOiBtaWxlc3RvbmVJZCwgXCI6c2lkXCI6IHNsaWNlSWQgfTtcbiAgaWYgKHNjb3BlKSBwYXJhbXNbXCI6c2NvcGVcIl0gPSBzY29wZTtcbiAgcmV0dXJuIGN1cnJlbnREYi5wcmVwYXJlKHNxbCkuYWxsKHBhcmFtcykubWFwKHJvd1RvR2F0ZSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtYXJrQWxsR2F0ZXNPbWl0dGVkKG1pbGVzdG9uZUlkOiBzdHJpbmcsIHNsaWNlSWQ6IHN0cmluZyk6IHZvaWQge1xuICBpZiAoIWN1cnJlbnREYikgcmV0dXJuO1xuICBjdXJyZW50RGIucHJlcGFyZShcbiAgICBgVVBEQVRFIHF1YWxpdHlfZ2F0ZXMgU0VUIHN0YXR1cyA9ICdjb21wbGV0ZScsIHZlcmRpY3QgPSAnb21pdHRlZCcsIGV2YWx1YXRlZF9hdCA9IDpub3dcbiAgICAgV0hFUkUgbWlsZXN0b25lX2lkID0gOm1pZCBBTkQgc2xpY2VfaWQgPSA6c2lkIEFORCBzdGF0dXMgPSAncGVuZGluZydgLFxuICApLnJ1bih7XG4gICAgXCI6bWlkXCI6IG1pbGVzdG9uZUlkLFxuICAgIFwiOnNpZFwiOiBzbGljZUlkLFxuICAgIFwiOm5vd1wiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gIH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0UGVuZGluZ1NsaWNlR2F0ZUNvdW50KG1pbGVzdG9uZUlkOiBzdHJpbmcsIHNsaWNlSWQ6IHN0cmluZyk6IG51bWJlciB7XG4gIGlmICghY3VycmVudERiKSByZXR1cm4gMDtcbiAgY29uc3Qgcm93ID0gY3VycmVudERiLnByZXBhcmUoXG4gICAgYFNFTEVDVCBDT1VOVCgqKSBhcyBjbnQgRlJPTSBxdWFsaXR5X2dhdGVzXG4gICAgIFdIRVJFIG1pbGVzdG9uZV9pZCA9IDptaWQgQU5EIHNsaWNlX2lkID0gOnNpZCBBTkQgc2NvcGUgPSAnc2xpY2UnIEFORCBzdGF0dXMgPSAncGVuZGluZydgLFxuICApLmdldCh7IFwiOm1pZFwiOiBtaWxlc3RvbmVJZCwgXCI6c2lkXCI6IHNsaWNlSWQgfSk7XG4gIHJldHVybiByb3cgPyAocm93W1wiY250XCJdIGFzIG51bWJlcikgOiAwO1xufVxuXG4vKipcbiAqIFJldHVybiBwZW5kaW5nIGdhdGUgcm93cyBvd25lZCBieSBhIHNwZWNpZmljIHdvcmtmbG93IHR1cm4uXG4gKlxuICogVW5saWtlIGBnZXRQZW5kaW5nR2F0ZXMoLi4uLCBzY29wZSlgLCB0aGlzIGZpbHRlcnMgYnkgdGhlIHJlZ2lzdHJ5J3NcbiAqIGBvd25lclR1cm5gIG1ldGFkYXRhIHNvIGNhbGxlcnMgY2FuIGRpc3Rpbmd1aXNoIFEzL1E0IChvd25lZCBieVxuICogZ2F0ZS1ldmFsdWF0ZSkgZnJvbSBROCAob3duZWQgYnkgY29tcGxldGUtc2xpY2UpIGV2ZW4gdGhvdWdoIGJvdGggYXJlXG4gKiBzY29wZTpcInNsaWNlXCIuIFBhc3MgYHRhc2tJZGAgdG8gbmFycm93IHRhc2stc2NvcGVkIHJlc3VsdHMgdG8gb25lIHRhc2suXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRQZW5kaW5nR2F0ZXNGb3JUdXJuKFxuICBtaWxlc3RvbmVJZDogc3RyaW5nLFxuICBzbGljZUlkOiBzdHJpbmcsXG4gIHR1cm46IE93bmVyVHVybixcbiAgdGFza0lkPzogc3RyaW5nLFxuKTogR2F0ZVJvd1tdIHtcbiAgaWYgKCFjdXJyZW50RGIpIHJldHVybiBbXTtcbiAgY29uc3QgaWRzID0gZ2V0R2F0ZUlkc0ZvclR1cm4odHVybik7XG4gIGlmIChpZHMuc2l6ZSA9PT0gMCkgcmV0dXJuIFtdO1xuICBjb25zdCBpZExpc3QgPSBbLi4uaWRzXTtcbiAgY29uc3QgcGxhY2Vob2xkZXJzID0gaWRMaXN0Lm1hcCgoXywgaSkgPT4gYDpnaWQke2l9YCkuam9pbihcIixcIik7XG4gIGNvbnN0IHBhcmFtczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgXCI6bWlkXCI6IG1pbGVzdG9uZUlkLFxuICAgIFwiOnNpZFwiOiBzbGljZUlkLFxuICB9O1xuICBpZExpc3QuZm9yRWFjaCgoaWQsIGkpID0+IHtcbiAgICBwYXJhbXNbYDpnaWQke2l9YF0gPSBpZDtcbiAgfSk7XG4gIGxldCBzcWwgPVxuICAgIGBTRUxFQ1QgKiBGUk9NIHF1YWxpdHlfZ2F0ZXNcbiAgICAgV0hFUkUgbWlsZXN0b25lX2lkID0gOm1pZCBBTkQgc2xpY2VfaWQgPSA6c2lkXG4gICAgICAgQU5EIHN0YXR1cyA9ICdwZW5kaW5nJ1xuICAgICAgIEFORCBnYXRlX2lkIElOICgke3BsYWNlaG9sZGVyc30pYDtcbiAgaWYgKHRhc2tJZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgc3FsICs9IGAgQU5EIHRhc2tfaWQgPSA6dGlkYDtcbiAgICBwYXJhbXNbXCI6dGlkXCJdID0gdGFza0lkO1xuICB9XG4gIHJldHVybiBjdXJyZW50RGIucHJlcGFyZShzcWwpLmFsbChwYXJhbXMpLm1hcChyb3dUb0dhdGUpO1xufVxuXG4vKipcbiAqIENvdW50IHBlbmRpbmcgZ2F0ZXMgZm9yIGEgdHVybi4gQ29udmVuaWVuY2Ugd3JhcHBlciB1c2VkIGJ5IHN0YXRlXG4gKiBkZXJpdmF0aW9uIHRvIGRlY2lkZSB3aGV0aGVyIGEgcGhhc2UgdHJhbnNpdGlvbiBzaG91bGQgcGF1c2UuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRQZW5kaW5nR2F0ZUNvdW50Rm9yVHVybihcbiAgbWlsZXN0b25lSWQ6IHN0cmluZyxcbiAgc2xpY2VJZDogc3RyaW5nLFxuICB0dXJuOiBPd25lclR1cm4sXG4pOiBudW1iZXIge1xuICByZXR1cm4gZ2V0UGVuZGluZ0dhdGVzRm9yVHVybihtaWxlc3RvbmVJZCwgc2xpY2VJZCwgdHVybikubGVuZ3RoO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaW5zZXJ0R2F0ZVJ1bihlbnRyeToge1xuICB0cmFjZUlkOiBzdHJpbmc7XG4gIHR1cm5JZDogc3RyaW5nO1xuICBnYXRlSWQ6IHN0cmluZztcbiAgZ2F0ZVR5cGU6IHN0cmluZztcbiAgdW5pdFR5cGU/OiBzdHJpbmc7XG4gIHVuaXRJZD86IHN0cmluZztcbiAgbWlsZXN0b25lSWQ/OiBzdHJpbmc7XG4gIHNsaWNlSWQ/OiBzdHJpbmc7XG4gIHRhc2tJZD86IHN0cmluZztcbiAgb3V0Y29tZTogXCJwYXNzXCIgfCBcImZhaWxcIiB8IFwicmV0cnlcIiB8IFwibWFudWFsLWF0dGVudGlvblwiO1xuICBmYWlsdXJlQ2xhc3M6IFwibm9uZVwiIHwgXCJwb2xpY3lcIiB8IFwiaW5wdXRcIiB8IFwiZXhlY3V0aW9uXCIgfCBcImFydGlmYWN0XCIgfCBcInZlcmlmaWNhdGlvblwiIHwgXCJjbG9zZW91dFwiIHwgXCJnaXRcIiB8IFwidGltZW91dFwiIHwgXCJtYW51YWwtYXR0ZW50aW9uXCIgfCBcInVua25vd25cIjtcbiAgcmF0aW9uYWxlPzogc3RyaW5nO1xuICBmaW5kaW5ncz86IHN0cmluZztcbiAgYXR0ZW1wdDogbnVtYmVyO1xuICBtYXhBdHRlbXB0czogbnVtYmVyO1xuICByZXRyeWFibGU6IGJvb2xlYW47XG4gIGV2YWx1YXRlZEF0OiBzdHJpbmc7XG59KTogdm9pZCB7XG4gIGlmICghY3VycmVudERiKSByZXR1cm47XG4gIGN1cnJlbnREYi5wcmVwYXJlKFxuICAgIGBJTlNFUlQgSU5UTyBnYXRlX3J1bnMgKFxuICAgICAgdHJhY2VfaWQsIHR1cm5faWQsIGdhdGVfaWQsIGdhdGVfdHlwZSwgdW5pdF90eXBlLCB1bml0X2lkLCBtaWxlc3RvbmVfaWQsIHNsaWNlX2lkLCB0YXNrX2lkLFxuICAgICAgb3V0Y29tZSwgZmFpbHVyZV9jbGFzcywgcmF0aW9uYWxlLCBmaW5kaW5ncywgYXR0ZW1wdCwgbWF4X2F0dGVtcHRzLCByZXRyeWFibGUsIGV2YWx1YXRlZF9hdFxuICAgICkgVkFMVUVTIChcbiAgICAgIDp0cmFjZV9pZCwgOnR1cm5faWQsIDpnYXRlX2lkLCA6Z2F0ZV90eXBlLCA6dW5pdF90eXBlLCA6dW5pdF9pZCwgOm1pbGVzdG9uZV9pZCwgOnNsaWNlX2lkLCA6dGFza19pZCxcbiAgICAgIDpvdXRjb21lLCA6ZmFpbHVyZV9jbGFzcywgOnJhdGlvbmFsZSwgOmZpbmRpbmdzLCA6YXR0ZW1wdCwgOm1heF9hdHRlbXB0cywgOnJldHJ5YWJsZSwgOmV2YWx1YXRlZF9hdFxuICAgIClgLFxuICApLnJ1bih7XG4gICAgXCI6dHJhY2VfaWRcIjogZW50cnkudHJhY2VJZCxcbiAgICBcIjp0dXJuX2lkXCI6IGVudHJ5LnR1cm5JZCxcbiAgICBcIjpnYXRlX2lkXCI6IGVudHJ5LmdhdGVJZCxcbiAgICBcIjpnYXRlX3R5cGVcIjogZW50cnkuZ2F0ZVR5cGUsXG4gICAgXCI6dW5pdF90eXBlXCI6IGVudHJ5LnVuaXRUeXBlID8/IG51bGwsXG4gICAgXCI6dW5pdF9pZFwiOiBlbnRyeS51bml0SWQgPz8gbnVsbCxcbiAgICBcIjptaWxlc3RvbmVfaWRcIjogZW50cnkubWlsZXN0b25lSWQgPz8gbnVsbCxcbiAgICBcIjpzbGljZV9pZFwiOiBlbnRyeS5zbGljZUlkID8/IG51bGwsXG4gICAgXCI6dGFza19pZFwiOiBlbnRyeS50YXNrSWQgPz8gbnVsbCxcbiAgICBcIjpvdXRjb21lXCI6IGVudHJ5Lm91dGNvbWUsXG4gICAgXCI6ZmFpbHVyZV9jbGFzc1wiOiBlbnRyeS5mYWlsdXJlQ2xhc3MsXG4gICAgXCI6cmF0aW9uYWxlXCI6IGVudHJ5LnJhdGlvbmFsZSA/PyBcIlwiLFxuICAgIFwiOmZpbmRpbmdzXCI6IGVudHJ5LmZpbmRpbmdzID8/IFwiXCIsXG4gICAgXCI6YXR0ZW1wdFwiOiBlbnRyeS5hdHRlbXB0LFxuICAgIFwiOm1heF9hdHRlbXB0c1wiOiBlbnRyeS5tYXhBdHRlbXB0cyxcbiAgICBcIjpyZXRyeWFibGVcIjogZW50cnkucmV0cnlhYmxlID8gMSA6IDAsXG4gICAgXCI6ZXZhbHVhdGVkX2F0XCI6IGVudHJ5LmV2YWx1YXRlZEF0LFxuICB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHVwc2VydFR1cm5HaXRUcmFuc2FjdGlvbihlbnRyeToge1xuICB0cmFjZUlkOiBzdHJpbmc7XG4gIHR1cm5JZDogc3RyaW5nO1xuICB1bml0VHlwZT86IHN0cmluZztcbiAgdW5pdElkPzogc3RyaW5nO1xuICBzdGFnZTogc3RyaW5nO1xuICBhY3Rpb246IFwiY29tbWl0XCIgfCBcInNuYXBzaG90XCIgfCBcInN0YXR1cy1vbmx5XCI7XG4gIHB1c2g6IGJvb2xlYW47XG4gIHN0YXR1czogXCJva1wiIHwgXCJmYWlsZWRcIjtcbiAgZXJyb3I/OiBzdHJpbmc7XG4gIG1ldGFkYXRhPzogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIHVwZGF0ZWRBdDogc3RyaW5nO1xufSk6IHZvaWQge1xuICBpZiAoIWN1cnJlbnREYikgcmV0dXJuO1xuICBjdXJyZW50RGIucHJlcGFyZShcbiAgICBgSU5TRVJUIE9SIFJFUExBQ0UgSU5UTyB0dXJuX2dpdF90cmFuc2FjdGlvbnMgKFxuICAgICAgdHJhY2VfaWQsIHR1cm5faWQsIHVuaXRfdHlwZSwgdW5pdF9pZCwgc3RhZ2UsIGFjdGlvbiwgcHVzaCwgc3RhdHVzLCBlcnJvciwgbWV0YWRhdGFfanNvbiwgdXBkYXRlZF9hdFxuICAgICkgVkFMVUVTIChcbiAgICAgIDp0cmFjZV9pZCwgOnR1cm5faWQsIDp1bml0X3R5cGUsIDp1bml0X2lkLCA6c3RhZ2UsIDphY3Rpb24sIDpwdXNoLCA6c3RhdHVzLCA6ZXJyb3IsIDptZXRhZGF0YV9qc29uLCA6dXBkYXRlZF9hdFxuICAgIClgLFxuICApLnJ1bih7XG4gICAgXCI6dHJhY2VfaWRcIjogZW50cnkudHJhY2VJZCxcbiAgICBcIjp0dXJuX2lkXCI6IGVudHJ5LnR1cm5JZCxcbiAgICBcIjp1bml0X3R5cGVcIjogZW50cnkudW5pdFR5cGUgPz8gbnVsbCxcbiAgICBcIjp1bml0X2lkXCI6IGVudHJ5LnVuaXRJZCA/PyBudWxsLFxuICAgIFwiOnN0YWdlXCI6IGVudHJ5LnN0YWdlLFxuICAgIFwiOmFjdGlvblwiOiBlbnRyeS5hY3Rpb24sXG4gICAgXCI6cHVzaFwiOiBlbnRyeS5wdXNoID8gMSA6IDAsXG4gICAgXCI6c3RhdHVzXCI6IGVudHJ5LnN0YXR1cyxcbiAgICBcIjplcnJvclwiOiBlbnRyeS5lcnJvciA/PyBudWxsLFxuICAgIFwiOm1ldGFkYXRhX2pzb25cIjogSlNPTi5zdHJpbmdpZnkoZW50cnkubWV0YWRhdGEgPz8ge30pLFxuICAgIFwiOnVwZGF0ZWRfYXRcIjogZW50cnkudXBkYXRlZEF0LFxuICB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldE1pbGVzdG9uZUNvbW1pdEF0dHJpYnV0aW9uU2hhcyhtaWxlc3RvbmVJZDogc3RyaW5nKTogc3RyaW5nW10ge1xuICBpZiAoIWN1cnJlbnREYikgcmV0dXJuIFtdO1xuICBjb25zdCByb3dzID0gY3VycmVudERiLnByZXBhcmUoXG4gICAgYFNFTEVDVCBjb21taXRfc2hhXG4gICAgIEZST00gbWlsZXN0b25lX2NvbW1pdF9hdHRyaWJ1dGlvbnNcbiAgICAgV0hFUkUgbWlsZXN0b25lX2lkID0gOm1pZFxuICAgICBPUkRFUiBCWSBjcmVhdGVkX2F0LCBjb21taXRfc2hhYCxcbiAgKS5hbGwoeyBcIjptaWRcIjogbWlsZXN0b25lSWQgfSkgYXMgQXJyYXk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+O1xuICByZXR1cm4gcm93c1xuICAgIC5tYXAoKHJvdykgPT4gdHlwZW9mIHJvd1tcImNvbW1pdF9zaGFcIl0gPT09IFwic3RyaW5nXCIgPyByb3dbXCJjb21taXRfc2hhXCJdIDogXCJcIilcbiAgICAuZmlsdGVyKEJvb2xlYW4pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVjb3JkTWlsZXN0b25lQ29tbWl0QXR0cmlidXRpb24oZW50cnk6IHtcbiAgY29tbWl0U2hhOiBzdHJpbmc7XG4gIG1pbGVzdG9uZUlkOiBzdHJpbmc7XG4gIHNsaWNlSWQ/OiBzdHJpbmc7XG4gIHRhc2tJZD86IHN0cmluZztcbiAgc291cmNlOiBcInJlY29yZGVkXCIgfCBcImJhY2tmaWxsXCI7XG4gIGNvbmZpZGVuY2U6IG51bWJlcjtcbiAgZmlsZXM6IHN0cmluZ1tdO1xuICBjcmVhdGVkQXQ6IHN0cmluZztcbn0pOiB2b2lkIHtcbiAgaWYgKCFjdXJyZW50RGIpIHJldHVybjtcbiAgdHJhbnNhY3Rpb24oKCkgPT4ge1xuICAgIGN1cnJlbnREYiEucHJlcGFyZShcbiAgICAgIGBJTlNFUlQgT1IgUkVQTEFDRSBJTlRPIG1pbGVzdG9uZV9jb21taXRfYXR0cmlidXRpb25zIChcbiAgICAgICAgY29tbWl0X3NoYSwgbWlsZXN0b25lX2lkLCBzbGljZV9pZCwgdGFza19pZCwgc291cmNlLCBjb25maWRlbmNlLCBmaWxlc19qc29uLCBjcmVhdGVkX2F0XG4gICAgICApIFZBTFVFUyAoXG4gICAgICAgIDpjb21taXRfc2hhLCA6bWlsZXN0b25lX2lkLCA6c2xpY2VfaWQsIDp0YXNrX2lkLCA6c291cmNlLCA6Y29uZmlkZW5jZSwgOmZpbGVzX2pzb24sIDpjcmVhdGVkX2F0XG4gICAgICApYCxcbiAgICApLnJ1bih7XG4gICAgICBcIjpjb21taXRfc2hhXCI6IGVudHJ5LmNvbW1pdFNoYSxcbiAgICAgIFwiOm1pbGVzdG9uZV9pZFwiOiBlbnRyeS5taWxlc3RvbmVJZCxcbiAgICAgIFwiOnNsaWNlX2lkXCI6IGVudHJ5LnNsaWNlSWQgPz8gbnVsbCxcbiAgICAgIFwiOnRhc2tfaWRcIjogZW50cnkudGFza0lkID8/IG51bGwsXG4gICAgICBcIjpzb3VyY2VcIjogZW50cnkuc291cmNlLFxuICAgICAgXCI6Y29uZmlkZW5jZVwiOiBlbnRyeS5jb25maWRlbmNlLFxuICAgICAgXCI6ZmlsZXNfanNvblwiOiBKU09OLnN0cmluZ2lmeShlbnRyeS5maWxlcyksXG4gICAgICBcIjpjcmVhdGVkX2F0XCI6IGVudHJ5LmNyZWF0ZWRBdCxcbiAgICB9KTtcblxuICAgIGN1cnJlbnREYiEucHJlcGFyZShcbiAgICAgIGBJTlNFUlQgT1IgSUdOT1JFIElOVE8gYXVkaXRfZXZlbnRzIChcbiAgICAgICAgZXZlbnRfaWQsIHRyYWNlX2lkLCB0dXJuX2lkLCBjYXVzZWRfYnksIGNhdGVnb3J5LCB0eXBlLCB0cywgcGF5bG9hZF9qc29uXG4gICAgICApIFZBTFVFUyAoXG4gICAgICAgIDpldmVudF9pZCwgOnRyYWNlX2lkLCA6dHVybl9pZCwgOmNhdXNlZF9ieSwgOmNhdGVnb3J5LCA6dHlwZSwgOnRzLCA6cGF5bG9hZF9qc29uXG4gICAgICApYCxcbiAgICApLnJ1bih7XG4gICAgICBcIjpldmVudF9pZFwiOiBgbWlsZXN0b25lLWNvbW1pdC1hdHRyaWJ1dGlvbjoke2VudHJ5Lm1pbGVzdG9uZUlkfToke2VudHJ5LmNvbW1pdFNoYX1gLFxuICAgICAgXCI6dHJhY2VfaWRcIjogXCJtaWxlc3RvbmUtY29tbWl0LWF0dHJpYnV0aW9uXCIsXG4gICAgICBcIjp0dXJuX2lkXCI6IG51bGwsXG4gICAgICBcIjpjYXVzZWRfYnlcIjogbnVsbCxcbiAgICAgIFwiOmNhdGVnb3J5XCI6IFwiZ2l0XCIsXG4gICAgICBcIjp0eXBlXCI6IFwibWlsZXN0b25lLWNvbW1pdC1hdHRyaWJ1dGlvbi1yZWNvcmRlZFwiLFxuICAgICAgXCI6dHNcIjogZW50cnkuY3JlYXRlZEF0LFxuICAgICAgXCI6cGF5bG9hZF9qc29uXCI6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgY29tbWl0U2hhOiBlbnRyeS5jb21taXRTaGEsXG4gICAgICAgIG1pbGVzdG9uZUlkOiBlbnRyeS5taWxlc3RvbmVJZCxcbiAgICAgICAgc2xpY2VJZDogZW50cnkuc2xpY2VJZCA/PyBudWxsLFxuICAgICAgICB0YXNrSWQ6IGVudHJ5LnRhc2tJZCA/PyBudWxsLFxuICAgICAgICBzb3VyY2U6IGVudHJ5LnNvdXJjZSxcbiAgICAgICAgY29uZmlkZW5jZTogZW50cnkuY29uZmlkZW5jZSxcbiAgICAgICAgZmlsZXM6IGVudHJ5LmZpbGVzLFxuICAgICAgfSksXG4gICAgfSk7XG4gIH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaW5zZXJ0QXVkaXRFdmVudChlbnRyeToge1xuICBldmVudElkOiBzdHJpbmc7XG4gIHRyYWNlSWQ6IHN0cmluZztcbiAgdHVybklkPzogc3RyaW5nO1xuICBjYXVzZWRCeT86IHN0cmluZztcbiAgY2F0ZWdvcnk6IHN0cmluZztcbiAgdHlwZTogc3RyaW5nO1xuICB0czogc3RyaW5nO1xuICBwYXlsb2FkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbn0pOiB2b2lkIHtcbiAgaWYgKCFjdXJyZW50RGIpIHJldHVybjtcbiAgdHJhbnNhY3Rpb24oKCkgPT4ge1xuICAgIGN1cnJlbnREYiEucHJlcGFyZShcbiAgICAgIGBJTlNFUlQgT1IgSUdOT1JFIElOVE8gYXVkaXRfZXZlbnRzIChcbiAgICAgICAgZXZlbnRfaWQsIHRyYWNlX2lkLCB0dXJuX2lkLCBjYXVzZWRfYnksIGNhdGVnb3J5LCB0eXBlLCB0cywgcGF5bG9hZF9qc29uXG4gICAgICApIFZBTFVFUyAoXG4gICAgICAgIDpldmVudF9pZCwgOnRyYWNlX2lkLCA6dHVybl9pZCwgOmNhdXNlZF9ieSwgOmNhdGVnb3J5LCA6dHlwZSwgOnRzLCA6cGF5bG9hZF9qc29uXG4gICAgICApYCxcbiAgICApLnJ1bih7XG4gICAgICBcIjpldmVudF9pZFwiOiBlbnRyeS5ldmVudElkLFxuICAgICAgXCI6dHJhY2VfaWRcIjogZW50cnkudHJhY2VJZCxcbiAgICAgIFwiOnR1cm5faWRcIjogZW50cnkudHVybklkID8/IG51bGwsXG4gICAgICBcIjpjYXVzZWRfYnlcIjogZW50cnkuY2F1c2VkQnkgPz8gbnVsbCxcbiAgICAgIFwiOmNhdGVnb3J5XCI6IGVudHJ5LmNhdGVnb3J5LFxuICAgICAgXCI6dHlwZVwiOiBlbnRyeS50eXBlLFxuICAgICAgXCI6dHNcIjogZW50cnkudHMsXG4gICAgICBcIjpwYXlsb2FkX2pzb25cIjogSlNPTi5zdHJpbmdpZnkoZW50cnkucGF5bG9hZCA/PyB7fSksXG4gICAgfSk7XG5cbiAgICBpZiAoZW50cnkudHVybklkKSB7XG4gICAgICBjb25zdCByb3cgPSBjdXJyZW50RGIhLnByZXBhcmUoXG4gICAgICAgIGBTRUxFQ1QgZXZlbnRfY291bnQsIGZpcnN0X3RzLCBsYXN0X3RzXG4gICAgICAgICBGUk9NIGF1ZGl0X3R1cm5faW5kZXhcbiAgICAgICAgIFdIRVJFIHRyYWNlX2lkID0gOnRyYWNlX2lkIEFORCB0dXJuX2lkID0gOnR1cm5faWRgLFxuICAgICAgKS5nZXQoe1xuICAgICAgICBcIjp0cmFjZV9pZFwiOiBlbnRyeS50cmFjZUlkLFxuICAgICAgICBcIjp0dXJuX2lkXCI6IGVudHJ5LnR1cm5JZCxcbiAgICAgIH0pO1xuICAgICAgaWYgKHJvdykge1xuICAgICAgICBjdXJyZW50RGIhLnByZXBhcmUoXG4gICAgICAgICAgYFVQREFURSBhdWRpdF90dXJuX2luZGV4XG4gICAgICAgICAgIFNFVCBmaXJzdF90cyA9IENBU0UgV0hFTiA6dHMgPCBmaXJzdF90cyBUSEVOIDp0cyBFTFNFIGZpcnN0X3RzIEVORCxcbiAgICAgICAgICAgICAgIGxhc3RfdHMgPSBDQVNFIFdIRU4gOnRzID4gbGFzdF90cyBUSEVOIDp0cyBFTFNFIGxhc3RfdHMgRU5ELFxuICAgICAgICAgICAgICAgZXZlbnRfY291bnQgPSBldmVudF9jb3VudCArIDFcbiAgICAgICAgICAgV0hFUkUgdHJhY2VfaWQgPSA6dHJhY2VfaWQgQU5EIHR1cm5faWQgPSA6dHVybl9pZGAsXG4gICAgICAgICkucnVuKHtcbiAgICAgICAgICBcIjp0cmFjZV9pZFwiOiBlbnRyeS50cmFjZUlkLFxuICAgICAgICAgIFwiOnR1cm5faWRcIjogZW50cnkudHVybklkLFxuICAgICAgICAgIFwiOnRzXCI6IGVudHJ5LnRzLFxuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGN1cnJlbnREYiEucHJlcGFyZShcbiAgICAgICAgICBgSU5TRVJUIElOVE8gYXVkaXRfdHVybl9pbmRleCAodHJhY2VfaWQsIHR1cm5faWQsIGZpcnN0X3RzLCBsYXN0X3RzLCBldmVudF9jb3VudClcbiAgICAgICAgICAgVkFMVUVTICg6dHJhY2VfaWQsIDp0dXJuX2lkLCA6Zmlyc3RfdHMsIDpsYXN0X3RzLCA6ZXZlbnRfY291bnQpYCxcbiAgICAgICAgKS5ydW4oe1xuICAgICAgICAgIFwiOnRyYWNlX2lkXCI6IGVudHJ5LnRyYWNlSWQsXG4gICAgICAgICAgXCI6dHVybl9pZFwiOiBlbnRyeS50dXJuSWQsXG4gICAgICAgICAgXCI6Zmlyc3RfdHNcIjogZW50cnkudHMsXG4gICAgICAgICAgXCI6bGFzdF90c1wiOiBlbnRyeS50cyxcbiAgICAgICAgICBcIjpldmVudF9jb3VudFwiOiAxLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG4gIH0pO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU2luZ2xlLXdyaXRlciBieXBhc3Mgd3JhcHBlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4vLyBUaGVzZSB3cmFwcGVycyBleGlzdCBzbyBtb2R1bGVzIG91dHNpZGUgdGhpcyBmaWxlIG5ldmVyIG5lZWQgdG8gY2FsbFxuLy8gYF9nZXRBZGFwdGVyKClgIGZvciB3cml0ZXMuIEVhY2ggb25lIGlzIGEgYnl0ZS1lcXVpdmFsZW50IHJlcGxhY2VtZW50IGZvclxuLy8gYSByYXcgcHJlcGFyZS9ydW4gcHJldmlvdXNseSBpc3N1ZWQgZnJvbSBhbm90aGVyIG1vZHVsZS4gS2VlcCB0aGVtXG4vLyBtaW5pbWFsIGFuZCBkaXJlY3QgXHUyMDE0IHRoZXkgZXhpc3QgdG8gaG9sZCBTUUwgdGV4dCBpbiBvbmUgcGxhY2UsIG5vdCB0b1xuLy8gYWRkIG5ldyBiZWhhdmlvci5cblxuLyoqIERlbGV0ZSBhIGRlY2lzaW9uIHJvdyBieSBpZC4gVXNlZCBieSBkYi13cml0ZXIudHMgcm9sbGJhY2sgb24gZGlzay13cml0ZSBmYWlsdXJlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRlbGV0ZURlY2lzaW9uQnlJZChpZDogc3RyaW5nKTogdm9pZCB7XG4gIGlmICghY3VycmVudERiKSB0aHJvdyBuZXcgR1NERXJyb3IoR1NEX1NUQUxFX1NUQVRFLCBcImdzZC1kYjogTm8gZGF0YWJhc2Ugb3BlblwiKTtcbiAgY3VycmVudERiLnByZXBhcmUoXCJERUxFVEUgRlJPTSBkZWNpc2lvbnMgV0hFUkUgaWQgPSA6aWRcIikucnVuKHsgXCI6aWRcIjogaWQgfSk7XG59XG5cbi8qKiBEZWxldGUgYSByZXF1aXJlbWVudCByb3cgYnkgaWQuIFVzZWQgYnkgZGItd3JpdGVyLnRzIHJvbGxiYWNrIG9uIGRpc2std3JpdGUgZmFpbHVyZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkZWxldGVSZXF1aXJlbWVudEJ5SWQoaWQ6IHN0cmluZyk6IHZvaWQge1xuICBpZiAoIWN1cnJlbnREYikgdGhyb3cgbmV3IEdTREVycm9yKEdTRF9TVEFMRV9TVEFURSwgXCJnc2QtZGI6IE5vIGRhdGFiYXNlIG9wZW5cIik7XG4gIGN1cnJlbnREYi5wcmVwYXJlKFwiREVMRVRFIEZST00gcmVxdWlyZW1lbnRzIFdIRVJFIGlkID0gOmlkXCIpLnJ1bih7IFwiOmlkXCI6IGlkIH0pO1xufVxuXG4vKiogRGVsZXRlIGFuIGFydGlmYWN0IHJvdyBieSBwYXRoLiBVc2VkIGJ5IGRiLXdyaXRlci50cyByb2xsYmFjayBvbiBkaXNrLXdyaXRlIGZhaWx1cmUuICovXG5leHBvcnQgZnVuY3Rpb24gZGVsZXRlQXJ0aWZhY3RCeVBhdGgocGF0aDogc3RyaW5nKTogdm9pZCB7XG4gIGlmICghY3VycmVudERiKSB0aHJvdyBuZXcgR1NERXJyb3IoR1NEX1NUQUxFX1NUQVRFLCBcImdzZC1kYjogTm8gZGF0YWJhc2Ugb3BlblwiKTtcbiAgY3VycmVudERiLnByZXBhcmUoXCJERUxFVEUgRlJPTSBhcnRpZmFjdHMgV0hFUkUgcGF0aCA9IDpwYXRoXCIpLnJ1bih7IFwiOnBhdGhcIjogcGF0aCB9KTtcbn1cblxuLyoqXG4gKiBEcm9wIGhpZXJhcmNoeSByb3dzIGluIGRlcGVuZGVuY3kgb3JkZXIgaW5zaWRlIGEgdHJhbnNhY3Rpb24uIFVzZWQgYnlcbiAqIGBnc2QgcmVjb3ZlcmAgdG8gcmVidWlsZCBlbmdpbmUgc3RhdGUgZnJvbSBtYXJrZG93bi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNsZWFyRW5naW5lSGllcmFyY2h5KCk6IHZvaWQge1xuICBpZiAoIWN1cnJlbnREYikgdGhyb3cgbmV3IEdTREVycm9yKEdTRF9TVEFMRV9TVEFURSwgXCJnc2QtZGI6IE5vIGRhdGFiYXNlIG9wZW5cIik7XG4gIHRyYW5zYWN0aW9uKCgpID0+IHtcbiAgICBjdXJyZW50RGIhLmV4ZWMoXCJERUxFVEUgRlJPTSB2ZXJpZmljYXRpb25fZXZpZGVuY2VcIik7XG4gICAgY3VycmVudERiIS5leGVjKFwiREVMRVRFIEZST00gcXVhbGl0eV9nYXRlc1wiKTtcbiAgICBjdXJyZW50RGIhLmV4ZWMoXCJERUxFVEUgRlJPTSBzbGljZV9kZXBlbmRlbmNpZXNcIik7XG4gICAgY3VycmVudERiIS5leGVjKFwiREVMRVRFIEZST00gYXNzZXNzbWVudHNcIik7XG4gICAgY3VycmVudERiIS5leGVjKFwiREVMRVRFIEZST00gcmVwbGFuX2hpc3RvcnlcIik7XG4gICAgY3VycmVudERiIS5leGVjKFwiREVMRVRFIEZST00gbWlsZXN0b25lX2NvbW1pdF9hdHRyaWJ1dGlvbnNcIik7XG4gICAgY3VycmVudERiIS5leGVjKFwiREVMRVRFIEZST00gdGFza3NcIik7XG4gICAgY3VycmVudERiIS5leGVjKFwiREVMRVRFIEZST00gc2xpY2VzXCIpO1xuICAgIGN1cnJlbnREYiEuZXhlYyhcIkRFTEVURSBGUk9NIG1pbGVzdG9uZV9sZWFzZXNcIik7XG4gICAgY3VycmVudERiIS5leGVjKFwiREVMRVRFIEZST00gbWlsZXN0b25lc1wiKTtcbiAgfSk7XG59XG5cbi8qKlxuICogSU5TRVJUIE9SIElHTk9SRSBhIHNsaWNlIGR1cmluZyBldmVudCByZXBsYXkgKHdvcmtmbG93LXJlY29uY2lsZS50cykuXG4gKiBTdHJpY3QgaW5zZXJ0LW9yLWlnbm9yZSBzZW1hbnRpY3MgYXJlIHJlcXVpcmVkIGhlcmUgdG8gYXZvaWQgdGhlXG4gKiBgaW5zZXJ0U2xpY2VgIE9OIENPTkZMSUNUIHBhdGggdGhhdCBjb3VsZCBkb3duZ3JhZGUgYW4gYWxyZWFkeS1jb21wbGV0ZWRcbiAqIHNsaWNlIGJhY2sgdG8gJ3BlbmRpbmcnLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaW5zZXJ0T3JJZ25vcmVTbGljZShhcmdzOiB7XG4gIG1pbGVzdG9uZUlkOiBzdHJpbmc7XG4gIHNsaWNlSWQ6IHN0cmluZztcbiAgdGl0bGU6IHN0cmluZztcbiAgY3JlYXRlZEF0OiBzdHJpbmc7XG59KTogdm9pZCB7XG4gIGlmICghY3VycmVudERiKSB0aHJvdyBuZXcgR1NERXJyb3IoR1NEX1NUQUxFX1NUQVRFLCBcImdzZC1kYjogTm8gZGF0YWJhc2Ugb3BlblwiKTtcbiAgY3VycmVudERiLnByZXBhcmUoXG4gICAgYElOU0VSVCBPUiBJR05PUkUgSU5UTyBzbGljZXMgKG1pbGVzdG9uZV9pZCwgaWQsIHRpdGxlLCBzdGF0dXMsIGNyZWF0ZWRfYXQpXG4gICAgIFZBTFVFUyAoOm1pZCwgOnNpZCwgOnRpdGxlLCAncGVuZGluZycsIDp0cylgLFxuICApLnJ1bih7XG4gICAgXCI6bWlkXCI6IGFyZ3MubWlsZXN0b25lSWQsXG4gICAgXCI6c2lkXCI6IGFyZ3Muc2xpY2VJZCxcbiAgICBcIjp0aXRsZVwiOiBhcmdzLnRpdGxlLFxuICAgIFwiOnRzXCI6IGFyZ3MuY3JlYXRlZEF0LFxuICB9KTtcbn1cblxuLyoqXG4gKiBJTlNFUlQgT1IgSUdOT1JFIGEgdGFzayBkdXJpbmcgZXZlbnQgcmVwbGF5ICh3b3JrZmxvdy1yZWNvbmNpbGUudHMpLlxuICogU2FtZSByYXRpb25hbGUgYXMgYGluc2VydE9ySWdub3JlU2xpY2VgLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaW5zZXJ0T3JJZ25vcmVUYXNrKGFyZ3M6IHtcbiAgbWlsZXN0b25lSWQ6IHN0cmluZztcbiAgc2xpY2VJZDogc3RyaW5nO1xuICB0YXNrSWQ6IHN0cmluZztcbiAgdGl0bGU6IHN0cmluZztcbiAgY3JlYXRlZEF0OiBzdHJpbmc7XG59KTogdm9pZCB7XG4gIGlmICghY3VycmVudERiKSB0aHJvdyBuZXcgR1NERXJyb3IoR1NEX1NUQUxFX1NUQVRFLCBcImdzZC1kYjogTm8gZGF0YWJhc2Ugb3BlblwiKTtcbiAgY3VycmVudERiLnByZXBhcmUoXG4gICAgYElOU0VSVCBPUiBJR05PUkUgSU5UTyB0YXNrcyAobWlsZXN0b25lX2lkLCBzbGljZV9pZCwgaWQsIHRpdGxlLCBzdGF0dXMsIGNyZWF0ZWRfYXQpXG4gICAgIFZBTFVFUyAoOm1pZCwgOnNpZCwgOnRpZCwgOnRpdGxlLCAncGVuZGluZycsIDp0cylgLFxuICApLnJ1bih7XG4gICAgXCI6bWlkXCI6IGFyZ3MubWlsZXN0b25lSWQsXG4gICAgXCI6c2lkXCI6IGFyZ3Muc2xpY2VJZCxcbiAgICBcIjp0aWRcIjogYXJncy50YXNrSWQsXG4gICAgXCI6dGl0bGVcIjogYXJncy50aXRsZSxcbiAgICBcIjp0c1wiOiBhcmdzLmNyZWF0ZWRBdCxcbiAgfSk7XG59XG5cbi8qKlxuICogU3RhbXAgdGhlIGByZXBsYW5fdHJpZ2dlcmVkX2F0YCBjb2x1bW4gb24gYSBzbGljZS4gVXNlZCBieSB0cmlhZ2UtcmVzb2x1dGlvblxuICogd2hlbiBhIHVzZXIgY2FwdHVyZSByZXF1ZXN0cyBhIHJlcGxhbiBzbyB0aGUgZGlzcGF0Y2hlciBjYW4gZGV0ZWN0IHRoZVxuICogdHJpZ2dlciB2aWEgREIgaW4gYWRkaXRpb24gdG8gdGhlIG9uLWRpc2sgUkVQTEFOLVRSSUdHRVIubWQgbWFya2VyLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2V0U2xpY2VSZXBsYW5UcmlnZ2VyZWRBdChtaWxlc3RvbmVJZDogc3RyaW5nLCBzbGljZUlkOiBzdHJpbmcsIHRzOiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKCFjdXJyZW50RGIpIHRocm93IG5ldyBHU0RFcnJvcihHU0RfU1RBTEVfU1RBVEUsIFwiZ3NkLWRiOiBObyBkYXRhYmFzZSBvcGVuXCIpO1xuICBjdXJyZW50RGIucHJlcGFyZShcbiAgICBcIlVQREFURSBzbGljZXMgU0VUIHJlcGxhbl90cmlnZ2VyZWRfYXQgPSA6dHMgV0hFUkUgbWlsZXN0b25lX2lkID0gOm1pZCBBTkQgaWQgPSA6c2lkXCIsXG4gICkucnVuKHsgXCI6dHNcIjogdHMsIFwiOm1pZFwiOiBtaWxlc3RvbmVJZCwgXCI6c2lkXCI6IHNsaWNlSWQgfSk7XG59XG5cbi8qKlxuICogSU5TRVJUIE9SIFJFUExBQ0UgYSBxdWFsaXR5X2dhdGVzIHJvdy4gVXNlZCBieSBtaWxlc3RvbmUtdmFsaWRhdGlvbi1nYXRlcy50c1xuICogdG8gcGVyc2lzdCBtaWxlc3RvbmUtbGV2ZWwgKE1WKikgZ2F0ZSBvdXRjb21lcyBhZnRlciB2YWxpZGF0ZS1taWxlc3RvbmUgcnVucy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHVwc2VydFF1YWxpdHlHYXRlKGc6IHtcbiAgbWlsZXN0b25lSWQ6IHN0cmluZztcbiAgc2xpY2VJZDogc3RyaW5nO1xuICBnYXRlSWQ6IHN0cmluZztcbiAgc2NvcGU6IHN0cmluZztcbiAgdGFza0lkOiBzdHJpbmc7XG4gIHN0YXR1czogc3RyaW5nO1xuICB2ZXJkaWN0OiBzdHJpbmc7XG4gIHJhdGlvbmFsZTogc3RyaW5nO1xuICBmaW5kaW5nczogc3RyaW5nO1xuICBldmFsdWF0ZWRBdDogc3RyaW5nO1xufSk6IHZvaWQge1xuICBpZiAoIWN1cnJlbnREYikgdGhyb3cgbmV3IEdTREVycm9yKEdTRF9TVEFMRV9TVEFURSwgXCJnc2QtZGI6IE5vIGRhdGFiYXNlIG9wZW5cIik7XG4gIGN1cnJlbnREYi5wcmVwYXJlKFxuICAgIGBJTlNFUlQgT1IgUkVQTEFDRSBJTlRPIHF1YWxpdHlfZ2F0ZXNcbiAgICAgKG1pbGVzdG9uZV9pZCwgc2xpY2VfaWQsIGdhdGVfaWQsIHNjb3BlLCB0YXNrX2lkLCBzdGF0dXMsIHZlcmRpY3QsIHJhdGlvbmFsZSwgZmluZGluZ3MsIGV2YWx1YXRlZF9hdClcbiAgICAgVkFMVUVTICg6bWlkLCA6c2lkLCA6Z2lkLCA6c2NvcGUsIDp0aWQsIDpzdGF0dXMsIDp2ZXJkaWN0LCA6cmF0aW9uYWxlLCA6ZmluZGluZ3MsIDpldmFsdWF0ZWRfYXQpYCxcbiAgKS5ydW4oe1xuICAgIFwiOm1pZFwiOiBnLm1pbGVzdG9uZUlkLFxuICAgIFwiOnNpZFwiOiBnLnNsaWNlSWQsXG4gICAgXCI6Z2lkXCI6IGcuZ2F0ZUlkLFxuICAgIFwiOnNjb3BlXCI6IGcuc2NvcGUsXG4gICAgXCI6dGlkXCI6IGcudGFza0lkLFxuICAgIFwiOnN0YXR1c1wiOiBnLnN0YXR1cyxcbiAgICBcIjp2ZXJkaWN0XCI6IGcudmVyZGljdCxcbiAgICBcIjpyYXRpb25hbGVcIjogZy5yYXRpb25hbGUsXG4gICAgXCI6ZmluZGluZ3NcIjogZy5maW5kaW5ncyxcbiAgICBcIjpldmFsdWF0ZWRfYXRcIjogZy5ldmFsdWF0ZWRBdCxcbiAgfSk7XG59XG5cbi8qKlxuICogQXRvbWljYWxseSByZXBsYWNlIGFsbCB3b3JrZmxvdyBzdGF0ZSBmcm9tIGEgbWFuaWZlc3QuIExpZnRlZCB2ZXJiYXRpbSBmcm9tXG4gKiB3b3JrZmxvdy1tYW5pZmVzdC50cyBzbyB0aGUgc2luZ2xlLXdyaXRlciBpbnZhcmlhbnQgaG9sZHMuIE9ubHkgdG91Y2hlc1xuICogZW5naW5lIHRhYmxlcyArIGRlY2lzaW9ucy4gRG9lcyBOT1QgbW9kaWZ5IGFydGlmYWN0cyBvciBtZW1vcmllcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc3RvcmVNYW5pZmVzdChtYW5pZmVzdDogU3RhdGVNYW5pZmVzdCk6IHZvaWQge1xuICBpZiAoIWN1cnJlbnREYikgdGhyb3cgbmV3IEdTREVycm9yKEdTRF9TVEFMRV9TVEFURSwgXCJnc2QtZGI6IE5vIGRhdGFiYXNlIG9wZW5cIik7XG4gIGNvbnN0IGRiID0gY3VycmVudERiO1xuXG4gIHRyYW5zYWN0aW9uKCgpID0+IHtcbiAgICAvLyBDbGVhciBlbmdpbmUgdGFibGVzIChvcmRlciBtYXR0ZXJzIGZvciBmb3JlaWduLWtleS1saWtlIGNvbnNpc3RlbmN5KVxuICAgIGRiLmV4ZWMoXCJERUxFVEUgRlJPTSB2ZXJpZmljYXRpb25fZXZpZGVuY2VcIik7XG4gICAgZGIuZXhlYyhcIkRFTEVURSBGUk9NIHRhc2tzXCIpO1xuICAgIGRiLmV4ZWMoXCJERUxFVEUgRlJPTSBzbGljZXNcIik7XG4gICAgZGIuZXhlYyhcIkRFTEVURSBGUk9NIG1pbGVzdG9uZV9sZWFzZXNcIik7XG4gICAgZGIuZXhlYyhcIkRFTEVURSBGUk9NIG1pbGVzdG9uZXNcIik7XG4gICAgZGIuZXhlYyhcIkRFTEVURSBGUk9NIGRlY2lzaW9ucyBXSEVSRSAxPTFcIik7XG5cbiAgICAvLyBSZXN0b3JlIG1pbGVzdG9uZXNcbiAgICBjb25zdCBtc1N0bXQgPSBkYi5wcmVwYXJlKFxuICAgICAgYElOU0VSVCBJTlRPIG1pbGVzdG9uZXMgKGlkLCB0aXRsZSwgc3RhdHVzLCBkZXBlbmRzX29uLCBjcmVhdGVkX2F0LCBjb21wbGV0ZWRfYXQsXG4gICAgICAgIHZpc2lvbiwgc3VjY2Vzc19jcml0ZXJpYSwga2V5X3Jpc2tzLCBwcm9vZl9zdHJhdGVneSxcbiAgICAgICAgdmVyaWZpY2F0aW9uX2NvbnRyYWN0LCB2ZXJpZmljYXRpb25faW50ZWdyYXRpb24sIHZlcmlmaWNhdGlvbl9vcGVyYXRpb25hbCwgdmVyaWZpY2F0aW9uX3VhdCxcbiAgICAgICAgZGVmaW5pdGlvbl9vZl9kb25lLCByZXF1aXJlbWVudF9jb3ZlcmFnZSwgYm91bmRhcnlfbWFwX21hcmtkb3duLCBzZXF1ZW5jZSlcbiAgICAgICBWQUxVRVMgKD8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8pYCxcbiAgICApO1xuICAgIGZvciAoY29uc3QgbSBvZiBtYW5pZmVzdC5taWxlc3RvbmVzKSB7XG4gICAgICBtc1N0bXQucnVuKFxuICAgICAgICBtLmlkLCBtLnRpdGxlLCBtLnN0YXR1cyxcbiAgICAgICAgSlNPTi5zdHJpbmdpZnkobS5kZXBlbmRzX29uKSwgbS5jcmVhdGVkX2F0LCBtLmNvbXBsZXRlZF9hdCxcbiAgICAgICAgbS52aXNpb24sIEpTT04uc3RyaW5naWZ5KG0uc3VjY2Vzc19jcml0ZXJpYSksIEpTT04uc3RyaW5naWZ5KG0ua2V5X3Jpc2tzKSxcbiAgICAgICAgSlNPTi5zdHJpbmdpZnkobS5wcm9vZl9zdHJhdGVneSksXG4gICAgICAgIG0udmVyaWZpY2F0aW9uX2NvbnRyYWN0LCBtLnZlcmlmaWNhdGlvbl9pbnRlZ3JhdGlvbiwgbS52ZXJpZmljYXRpb25fb3BlcmF0aW9uYWwsIG0udmVyaWZpY2F0aW9uX3VhdCxcbiAgICAgICAgSlNPTi5zdHJpbmdpZnkobS5kZWZpbml0aW9uX29mX2RvbmUpLCBtLnJlcXVpcmVtZW50X2NvdmVyYWdlLCBtLmJvdW5kYXJ5X21hcF9tYXJrZG93biwgbS5zZXF1ZW5jZSA/PyAwLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICAvLyBSZXN0b3JlIHNsaWNlcyAoQURSLTAxMSBQaGFzZSAxOiBpbmNsdWRlcyBpc19za2V0Y2ggKyBza2V0Y2hfc2NvcGUpXG4gICAgY29uc3Qgc2xTdG10ID0gZGIucHJlcGFyZShcbiAgICAgIGBJTlNFUlQgSU5UTyBzbGljZXMgKG1pbGVzdG9uZV9pZCwgaWQsIHRpdGxlLCBzdGF0dXMsIHJpc2ssIGRlcGVuZHMsIGRlbW8sXG4gICAgICAgIGNyZWF0ZWRfYXQsIGNvbXBsZXRlZF9hdCwgZnVsbF9zdW1tYXJ5X21kLCBmdWxsX3VhdF9tZCxcbiAgICAgICAgZ29hbCwgc3VjY2Vzc19jcml0ZXJpYSwgcHJvb2ZfbGV2ZWwsIGludGVncmF0aW9uX2Nsb3N1cmUsIG9ic2VydmFiaWxpdHlfaW1wYWN0LFxuICAgICAgICBzZXF1ZW5jZSwgcmVwbGFuX3RyaWdnZXJlZF9hdCwgaXNfc2tldGNoLCBza2V0Y2hfc2NvcGUpXG4gICAgICAgVkFMVUVTICg/LCA/LCA/LCA/LCA/LCA/LCA/LCA/LCA/LCA/LCA/LCA/LCA/LCA/LCA/LCA/LCA/LCA/LCA/LCA/KWAsXG4gICAgKTtcbiAgICBmb3IgKGNvbnN0IHMgb2YgbWFuaWZlc3Quc2xpY2VzKSB7XG4gICAgICBzbFN0bXQucnVuKFxuICAgICAgICBzLm1pbGVzdG9uZV9pZCwgcy5pZCwgcy50aXRsZSwgcy5zdGF0dXMsIHMucmlzayxcbiAgICAgICAgSlNPTi5zdHJpbmdpZnkocy5kZXBlbmRzKSwgcy5kZW1vLFxuICAgICAgICBzLmNyZWF0ZWRfYXQsIHMuY29tcGxldGVkX2F0LCBzLmZ1bGxfc3VtbWFyeV9tZCwgcy5mdWxsX3VhdF9tZCxcbiAgICAgICAgcy5nb2FsLCBzLnN1Y2Nlc3NfY3JpdGVyaWEsIHMucHJvb2ZfbGV2ZWwsIHMuaW50ZWdyYXRpb25fY2xvc3VyZSwgcy5vYnNlcnZhYmlsaXR5X2ltcGFjdCxcbiAgICAgICAgcy5zZXF1ZW5jZSwgcy5yZXBsYW5fdHJpZ2dlcmVkX2F0LFxuICAgICAgICBzLmlzX3NrZXRjaCA/PyAwLFxuICAgICAgICBzLnNrZXRjaF9zY29wZSA/PyBcIlwiLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICAvLyBSZXN0b3JlIHRhc2tzIChBRFItMDExIFAyOiBpbmNsdWRlcyBibG9ja2VyX3NvdXJjZSArIGVzY2FsYXRpb25fKiBjb2x1bW5zKVxuICAgIGNvbnN0IHRrU3RtdCA9IGRiLnByZXBhcmUoXG4gICAgICBgSU5TRVJUIElOVE8gdGFza3MgKG1pbGVzdG9uZV9pZCwgc2xpY2VfaWQsIGlkLCB0aXRsZSwgc3RhdHVzLFxuICAgICAgICBvbmVfbGluZXIsIG5hcnJhdGl2ZSwgdmVyaWZpY2F0aW9uX3Jlc3VsdCwgZHVyYXRpb24sIGNvbXBsZXRlZF9hdCxcbiAgICAgICAgYmxvY2tlcl9kaXNjb3ZlcmVkLCBkZXZpYXRpb25zLCBrbm93bl9pc3N1ZXMsIGtleV9maWxlcywga2V5X2RlY2lzaW9ucyxcbiAgICAgICAgZnVsbF9zdW1tYXJ5X21kLCBkZXNjcmlwdGlvbiwgZXN0aW1hdGUsIGZpbGVzLCB2ZXJpZnksXG4gICAgICAgIGlucHV0cywgZXhwZWN0ZWRfb3V0cHV0LCBvYnNlcnZhYmlsaXR5X2ltcGFjdCwgc2VxdWVuY2UsXG4gICAgICAgIGJsb2NrZXJfc291cmNlLCBlc2NhbGF0aW9uX3BlbmRpbmcsIGVzY2FsYXRpb25fYXdhaXRpbmdfcmV2aWV3LFxuICAgICAgICBlc2NhbGF0aW9uX2FydGlmYWN0X3BhdGgsIGVzY2FsYXRpb25fb3ZlcnJpZGVfYXBwbGllZF9hdClcbiAgICAgICBWQUxVRVMgKD8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8pYCxcbiAgICApO1xuICAgIGZvciAoY29uc3QgdCBvZiBtYW5pZmVzdC50YXNrcykge1xuICAgICAgdGtTdG10LnJ1bihcbiAgICAgICAgdC5taWxlc3RvbmVfaWQsIHQuc2xpY2VfaWQsIHQuaWQsIHQudGl0bGUsIHQuc3RhdHVzLFxuICAgICAgICB0Lm9uZV9saW5lciwgdC5uYXJyYXRpdmUsIHQudmVyaWZpY2F0aW9uX3Jlc3VsdCwgdC5kdXJhdGlvbiwgdC5jb21wbGV0ZWRfYXQsXG4gICAgICAgIHQuYmxvY2tlcl9kaXNjb3ZlcmVkID8gMSA6IDAsIHQuZGV2aWF0aW9ucywgdC5rbm93bl9pc3N1ZXMsXG4gICAgICAgIEpTT04uc3RyaW5naWZ5KHQua2V5X2ZpbGVzKSwgSlNPTi5zdHJpbmdpZnkodC5rZXlfZGVjaXNpb25zKSxcbiAgICAgICAgdC5mdWxsX3N1bW1hcnlfbWQsIHQuZGVzY3JpcHRpb24sIHQuZXN0aW1hdGUsIEpTT04uc3RyaW5naWZ5KHQuZmlsZXMpLCB0LnZlcmlmeSxcbiAgICAgICAgSlNPTi5zdHJpbmdpZnkodC5pbnB1dHMpLCBKU09OLnN0cmluZ2lmeSh0LmV4cGVjdGVkX291dHB1dCksXG4gICAgICAgIHQub2JzZXJ2YWJpbGl0eV9pbXBhY3QsIHQuc2VxdWVuY2UsXG4gICAgICAgIHQuYmxvY2tlcl9zb3VyY2UgPz8gXCJcIixcbiAgICAgICAgdC5lc2NhbGF0aW9uX3BlbmRpbmcgPz8gMCxcbiAgICAgICAgdC5lc2NhbGF0aW9uX2F3YWl0aW5nX3JldmlldyA/PyAwLFxuICAgICAgICB0LmVzY2FsYXRpb25fYXJ0aWZhY3RfcGF0aCA/PyBudWxsLFxuICAgICAgICB0LmVzY2FsYXRpb25fb3ZlcnJpZGVfYXBwbGllZF9hdCA/PyBudWxsLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICAvLyBSZXN0b3JlIGRlY2lzaW9ucyAoQURSLTAxMSBQMjogaW5jbHVkZSBzb3VyY2Ugc28gZXNjYWxhdGlvbiBkZWNpc2lvbnMgc3Vydml2ZSlcbiAgICBjb25zdCBkY1N0bXQgPSBkYi5wcmVwYXJlKFxuICAgICAgYElOU0VSVCBJTlRPIGRlY2lzaW9ucyAoc2VxLCBpZCwgd2hlbl9jb250ZXh0LCBzY29wZSwgZGVjaXNpb24sIGNob2ljZSwgcmF0aW9uYWxlLCByZXZpc2FibGUsIG1hZGVfYnksIHNvdXJjZSwgc3VwZXJzZWRlZF9ieSlcbiAgICAgICBWQUxVRVMgKD8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8pYCxcbiAgICApO1xuICAgIGZvciAoY29uc3QgZCBvZiBtYW5pZmVzdC5kZWNpc2lvbnMpIHtcbiAgICAgIGRjU3RtdC5ydW4oZC5zZXEsIGQuaWQsIGQud2hlbl9jb250ZXh0LCBkLnNjb3BlLCBkLmRlY2lzaW9uLCBkLmNob2ljZSwgZC5yYXRpb25hbGUsIGQucmV2aXNhYmxlLCBkLm1hZGVfYnksIGQuc291cmNlID8/IFwiZGlzY3Vzc2lvblwiLCBkLnN1cGVyc2VkZWRfYnkpO1xuICAgIH1cblxuICAgIC8vIFJlc3RvcmUgdmVyaWZpY2F0aW9uIGV2aWRlbmNlXG4gICAgY29uc3QgZXZTdG10ID0gZGIucHJlcGFyZShcbiAgICAgIGBJTlNFUlQgSU5UTyB2ZXJpZmljYXRpb25fZXZpZGVuY2UgKHRhc2tfaWQsIHNsaWNlX2lkLCBtaWxlc3RvbmVfaWQsIGNvbW1hbmQsIGV4aXRfY29kZSwgdmVyZGljdCwgZHVyYXRpb25fbXMsIGNyZWF0ZWRfYXQpXG4gICAgICAgVkFMVUVTICg/LCA/LCA/LCA/LCA/LCA/LCA/LCA/KWAsXG4gICAgKTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgbWFuaWZlc3QudmVyaWZpY2F0aW9uX2V2aWRlbmNlKSB7XG4gICAgICBldlN0bXQucnVuKGUudGFza19pZCwgZS5zbGljZV9pZCwgZS5taWxlc3RvbmVfaWQsIGUuY29tbWFuZCwgZS5leGl0X2NvZGUsIGUudmVyZGljdCwgZS5kdXJhdGlvbl9tcywgZS5jcmVhdGVkX2F0KTtcbiAgICB9XG4gIH0pO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgTGVnYWN5IG1hcmtkb3duIFx1MjE5MiBEQiBidWxrIG1pZ3JhdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGludGVyZmFjZSBMZWdhY3lNaWxlc3RvbmVJbnNlcnQge1xuICBpZDogc3RyaW5nO1xuICB0aXRsZTogc3RyaW5nO1xuICBzdGF0dXM6IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBMZWdhY3lTbGljZUluc2VydCB7XG4gIGlkOiBzdHJpbmc7XG4gIG1pbGVzdG9uZUlkOiBzdHJpbmc7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIHN0YXR1czogc3RyaW5nO1xuICByaXNrOiBzdHJpbmc7XG4gIHNlcXVlbmNlOiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgTGVnYWN5VGFza0luc2VydCB7XG4gIGlkOiBzdHJpbmc7XG4gIHNsaWNlSWQ6IHN0cmluZztcbiAgbWlsZXN0b25lSWQ6IHN0cmluZztcbiAgdGl0bGU6IHN0cmluZztcbiAgc3RhdHVzOiBzdHJpbmc7XG4gIHNlcXVlbmNlOiBudW1iZXI7XG59XG5cbi8qKlxuICogQnVsayBkZWxldGUgKyBpbnNlcnQgYSBsZWdhY3kgbWlsZXN0b25lIGhpZXJhcmNoeSBmb3IgbWFya2Rvd24gXHUyMTkyIERCIG1pZ3JhdGlvbi5cbiAqIFVzZWQgYnkgd29ya2Zsb3ctbWlncmF0aW9uLnRzIHRvIHBvcHVsYXRlIGVuZ2luZSB0YWJsZXMgZnJvbSBwYXJzZWQgUk9BRE1BUC9QTEFOXG4gKiBmaWxlcy4gQWxsIG9wZXJhdGlvbnMgcnVuIGluc2lkZSBhIHNpbmdsZSB0cmFuc2FjdGlvbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ1bGtJbnNlcnRMZWdhY3lIaWVyYXJjaHkocGF5bG9hZDoge1xuICBtaWxlc3RvbmVzOiBMZWdhY3lNaWxlc3RvbmVJbnNlcnRbXTtcbiAgc2xpY2VzOiBMZWdhY3lTbGljZUluc2VydFtdO1xuICB0YXNrczogTGVnYWN5VGFza0luc2VydFtdO1xuICBjbGVhck1pbGVzdG9uZUlkczogc3RyaW5nW107XG4gIGNyZWF0ZWRBdDogc3RyaW5nO1xufSk6IHZvaWQge1xuICBpZiAoIWN1cnJlbnREYikgdGhyb3cgbmV3IEdTREVycm9yKEdTRF9TVEFMRV9TVEFURSwgXCJnc2QtZGI6IE5vIGRhdGFiYXNlIG9wZW5cIik7XG4gIGNvbnN0IGRiID0gY3VycmVudERiO1xuICBjb25zdCB7IG1pbGVzdG9uZXMsIHNsaWNlcywgdGFza3MsIGNsZWFyTWlsZXN0b25lSWRzLCBjcmVhdGVkQXQgfSA9IHBheWxvYWQ7XG5cbiAgaWYgKGNsZWFyTWlsZXN0b25lSWRzLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuICBjb25zdCBwbGFjZWhvbGRlcnMgPSBjbGVhck1pbGVzdG9uZUlkcy5tYXAoKCkgPT4gXCI/XCIpLmpvaW4oXCIsXCIpO1xuXG4gIHRyYW5zYWN0aW9uKCgpID0+IHtcbiAgICBkYi5wcmVwYXJlKGBERUxFVEUgRlJPTSB0YXNrcyBXSEVSRSBtaWxlc3RvbmVfaWQgSU4gKCR7cGxhY2Vob2xkZXJzfSlgKS5ydW4oLi4uY2xlYXJNaWxlc3RvbmVJZHMpO1xuICAgIGRiLnByZXBhcmUoYERFTEVURSBGUk9NIHNsaWNlcyBXSEVSRSBtaWxlc3RvbmVfaWQgSU4gKCR7cGxhY2Vob2xkZXJzfSlgKS5ydW4oLi4uY2xlYXJNaWxlc3RvbmVJZHMpO1xuICAgIGRiLnByZXBhcmUoYERFTEVURSBGUk9NIG1pbGVzdG9uZV9sZWFzZXMgV0hFUkUgbWlsZXN0b25lX2lkIElOICgke3BsYWNlaG9sZGVyc30pYCkucnVuKC4uLmNsZWFyTWlsZXN0b25lSWRzKTtcbiAgICBkYi5wcmVwYXJlKGBERUxFVEUgRlJPTSBtaWxlc3RvbmVzIFdIRVJFIGlkIElOICgke3BsYWNlaG9sZGVyc30pYCkucnVuKC4uLmNsZWFyTWlsZXN0b25lSWRzKTtcblxuICAgIGNvbnN0IGluc2VydE1pbGVzdG9uZSA9IGRiLnByZXBhcmUoXG4gICAgICBcIklOU0VSVCBJTlRPIG1pbGVzdG9uZXMgKGlkLCB0aXRsZSwgc3RhdHVzLCBjcmVhdGVkX2F0KSBWQUxVRVMgKD8sID8sID8sID8pXCIsXG4gICAgKTtcbiAgICBmb3IgKGNvbnN0IG0gb2YgbWlsZXN0b25lcykge1xuICAgICAgaW5zZXJ0TWlsZXN0b25lLnJ1bihtLmlkLCBtLnRpdGxlLCBtLnN0YXR1cywgY3JlYXRlZEF0KTtcbiAgICB9XG5cbiAgICBjb25zdCBpbnNlcnRTbGljZVN0bXQgPSBkYi5wcmVwYXJlKFxuICAgICAgXCJJTlNFUlQgSU5UTyBzbGljZXMgKGlkLCBtaWxlc3RvbmVfaWQsIHRpdGxlLCBzdGF0dXMsIHJpc2ssIGRlcGVuZHMsIHNlcXVlbmNlLCBjcmVhdGVkX2F0KSBWQUxVRVMgKD8sID8sID8sID8sID8sID8sID8sID8pXCIsXG4gICAgKTtcbiAgICBmb3IgKGNvbnN0IHMgb2Ygc2xpY2VzKSB7XG4gICAgICBpbnNlcnRTbGljZVN0bXQucnVuKHMuaWQsIHMubWlsZXN0b25lSWQsIHMudGl0bGUsIHMuc3RhdHVzLCBzLnJpc2ssIFwiW11cIiwgcy5zZXF1ZW5jZSwgY3JlYXRlZEF0KTtcbiAgICB9XG5cbiAgICBjb25zdCBpbnNlcnRUYXNrU3RtdCA9IGRiLnByZXBhcmUoXG4gICAgICBcIklOU0VSVCBJTlRPIHRhc2tzIChpZCwgc2xpY2VfaWQsIG1pbGVzdG9uZV9pZCwgdGl0bGUsIGRlc2NyaXB0aW9uLCBzdGF0dXMsIGVzdGltYXRlLCBmaWxlcywgc2VxdWVuY2UpIFZBTFVFUyAoPywgPywgPywgPywgPywgPywgPywgPywgPylcIixcbiAgICApO1xuICAgIGZvciAoY29uc3QgdCBvZiB0YXNrcykge1xuICAgICAgaW5zZXJ0VGFza1N0bXQucnVuKHQuaWQsIHQuc2xpY2VJZCwgdC5taWxlc3RvbmVJZCwgdC50aXRsZSwgXCJcIiwgdC5zdGF0dXMsIFwiXCIsIFwiW11cIiwgdC5zZXF1ZW5jZSk7XG4gICAgfVxuICB9KTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIE1lbW9yeSBzdG9yZSB3cml0ZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuLy8gQWxsIG1lbW9yeSB3cml0ZXMgZ28gdGhyb3VnaCBnc2QtZGIudHMgc28gdGhlIHNpbmdsZS13cml0ZXIgaW52YXJpYW50XG4vLyBob2xkcy4gVGhlc2UgYXJlIGRpcmVjdCBwYXNzLXRocm91Z2hzIHRvIHRoZSBTUUwgcHJldmlvdXNseSBpblxuLy8gbWVtb3J5LXN0b3JlLnRzIFx1MjAxNCBzYW1lIGJpbmRpbmdzLCBzYW1lIGJlaGF2aW9yLlxuXG5leHBvcnQgZnVuY3Rpb24gaW5zZXJ0TWVtb3J5Um93KGFyZ3M6IHtcbiAgaWQ6IHN0cmluZztcbiAgY2F0ZWdvcnk6IHN0cmluZztcbiAgY29udGVudDogc3RyaW5nO1xuICBjb25maWRlbmNlOiBudW1iZXI7XG4gIHNvdXJjZVVuaXRUeXBlOiBzdHJpbmcgfCBudWxsO1xuICBzb3VyY2VVbml0SWQ6IHN0cmluZyB8IG51bGw7XG4gIGNyZWF0ZWRBdDogc3RyaW5nO1xuICB1cGRhdGVkQXQ6IHN0cmluZztcbiAgc2NvcGU/OiBzdHJpbmc7XG4gIHRhZ3M/OiBzdHJpbmdbXTtcbiAgLyoqXG4gICAqIEFEUi0wMTMgU3RlcCAyOiBvcHRpb25hbCBzdHJ1Y3R1cmVkIHBheWxvYWQgcHJlc2VydmVkIGFsb25nc2lkZSB0aGUgZmxhdFxuICAgKiBgY29udGVudGAgZmllbGQuIFVzZWQgdG8gcmV0YWluIGdzZF9zYXZlX2RlY2lzaW9uLXN0eWxlIGZpZWxkcyAoc2NvcGUsXG4gICAqIGRlY2lzaW9uLCBjaG9pY2UsIHJhdGlvbmFsZSwgbWFkZV9ieSwgcmV2aXNhYmxlKSBvbiBhcmNoaXRlY3R1cmUtY2F0ZWdvcnlcbiAgICogbWVtb3JpZXMgc28gdGhlIGN1dG92ZXIgaW4gU3RlcCA2IGlzIGxvc3NsZXNzLiBTY2hlbWEgaXMgaW50ZW50aW9uYWxseVxuICAgKiBvcGVuIGluc2lkZSB0aGUgSlNPTjsgZG9jdW1lbnRlZCBwZXIgY2F0ZWdvcnkgaW4gQURSLTAxMy5cbiAgICovXG4gIHN0cnVjdHVyZWRGaWVsZHM/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IG51bGw7XG59KTogdm9pZCB7XG4gIGlmICghY3VycmVudERiKSB0aHJvdyBuZXcgR1NERXJyb3IoR1NEX1NUQUxFX1NUQVRFLCBcImdzZC1kYjogTm8gZGF0YWJhc2Ugb3BlblwiKTtcbiAgY3VycmVudERiLnByZXBhcmUoXG4gICAgYElOU0VSVCBJTlRPIG1lbW9yaWVzIChpZCwgY2F0ZWdvcnksIGNvbnRlbnQsIGNvbmZpZGVuY2UsIHNvdXJjZV91bml0X3R5cGUsIHNvdXJjZV91bml0X2lkLCBjcmVhdGVkX2F0LCB1cGRhdGVkX2F0LCBzY29wZSwgdGFncywgc3RydWN0dXJlZF9maWVsZHMpXG4gICAgIFZBTFVFUyAoOmlkLCA6Y2F0ZWdvcnksIDpjb250ZW50LCA6Y29uZmlkZW5jZSwgOnNvdXJjZV91bml0X3R5cGUsIDpzb3VyY2VfdW5pdF9pZCwgOmNyZWF0ZWRfYXQsIDp1cGRhdGVkX2F0LCA6c2NvcGUsIDp0YWdzLCA6c3RydWN0dXJlZF9maWVsZHMpYCxcbiAgKS5ydW4oe1xuICAgIFwiOmlkXCI6IGFyZ3MuaWQsXG4gICAgXCI6Y2F0ZWdvcnlcIjogYXJncy5jYXRlZ29yeSxcbiAgICBcIjpjb250ZW50XCI6IGFyZ3MuY29udGVudCxcbiAgICBcIjpjb25maWRlbmNlXCI6IGFyZ3MuY29uZmlkZW5jZSxcbiAgICBcIjpzb3VyY2VfdW5pdF90eXBlXCI6IGFyZ3Muc291cmNlVW5pdFR5cGUsXG4gICAgXCI6c291cmNlX3VuaXRfaWRcIjogYXJncy5zb3VyY2VVbml0SWQsXG4gICAgXCI6Y3JlYXRlZF9hdFwiOiBhcmdzLmNyZWF0ZWRBdCxcbiAgICBcIjp1cGRhdGVkX2F0XCI6IGFyZ3MudXBkYXRlZEF0LFxuICAgIFwiOnNjb3BlXCI6IGFyZ3Muc2NvcGUgPz8gXCJwcm9qZWN0XCIsXG4gICAgXCI6dGFnc1wiOiBKU09OLnN0cmluZ2lmeShhcmdzLnRhZ3MgPz8gW10pLFxuICAgIFwiOnN0cnVjdHVyZWRfZmllbGRzXCI6IGFyZ3Muc3RydWN0dXJlZEZpZWxkcyA9PSBudWxsID8gbnVsbCA6IEpTT04uc3RyaW5naWZ5KGFyZ3Muc3RydWN0dXJlZEZpZWxkcyksXG4gIH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaW5zZXJ0TWVtb3J5U291cmNlUm93KGFyZ3M6IHtcbiAgaWQ6IHN0cmluZztcbiAga2luZDogc3RyaW5nO1xuICB1cmk6IHN0cmluZyB8IG51bGw7XG4gIHRpdGxlOiBzdHJpbmcgfCBudWxsO1xuICBjb250ZW50OiBzdHJpbmc7XG4gIGNvbnRlbnRIYXNoOiBzdHJpbmc7XG4gIGltcG9ydGVkQXQ6IHN0cmluZztcbiAgc2NvcGU/OiBzdHJpbmc7XG4gIHRhZ3M/OiBzdHJpbmdbXTtcbn0pOiB2b2lkIHtcbiAgaWYgKCFjdXJyZW50RGIpIHRocm93IG5ldyBHU0RFcnJvcihHU0RfU1RBTEVfU1RBVEUsIFwiZ3NkLWRiOiBObyBkYXRhYmFzZSBvcGVuXCIpO1xuICBjdXJyZW50RGIucHJlcGFyZShcbiAgICBgSU5TRVJUIE9SIElHTk9SRSBJTlRPIG1lbW9yeV9zb3VyY2VzIChpZCwga2luZCwgdXJpLCB0aXRsZSwgY29udGVudCwgY29udGVudF9oYXNoLCBpbXBvcnRlZF9hdCwgc2NvcGUsIHRhZ3MpXG4gICAgIFZBTFVFUyAoOmlkLCA6a2luZCwgOnVyaSwgOnRpdGxlLCA6Y29udGVudCwgOmNvbnRlbnRfaGFzaCwgOmltcG9ydGVkX2F0LCA6c2NvcGUsIDp0YWdzKWAsXG4gICkucnVuKHtcbiAgICBcIjppZFwiOiBhcmdzLmlkLFxuICAgIFwiOmtpbmRcIjogYXJncy5raW5kLFxuICAgIFwiOnVyaVwiOiBhcmdzLnVyaSxcbiAgICBcIjp0aXRsZVwiOiBhcmdzLnRpdGxlLFxuICAgIFwiOmNvbnRlbnRcIjogYXJncy5jb250ZW50LFxuICAgIFwiOmNvbnRlbnRfaGFzaFwiOiBhcmdzLmNvbnRlbnRIYXNoLFxuICAgIFwiOmltcG9ydGVkX2F0XCI6IGFyZ3MuaW1wb3J0ZWRBdCxcbiAgICBcIjpzY29wZVwiOiBhcmdzLnNjb3BlID8/IFwicHJvamVjdFwiLFxuICAgIFwiOnRhZ3NcIjogSlNPTi5zdHJpbmdpZnkoYXJncy50YWdzID8/IFtdKSxcbiAgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBkZWxldGVNZW1vcnlTb3VyY2VSb3coaWQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBpZiAoIWN1cnJlbnREYikgdGhyb3cgbmV3IEdTREVycm9yKEdTRF9TVEFMRV9TVEFURSwgXCJnc2QtZGI6IE5vIGRhdGFiYXNlIG9wZW5cIik7XG4gIGNvbnN0IHJlcyA9IGN1cnJlbnREYlxuICAgIC5wcmVwYXJlKFwiREVMRVRFIEZST00gbWVtb3J5X3NvdXJjZXMgV0hFUkUgaWQgPSA6aWRcIilcbiAgICAucnVuKHsgXCI6aWRcIjogaWQgfSkgYXMgeyBjaGFuZ2VzPzogbnVtYmVyIH07XG4gIHJldHVybiAocmVzPy5jaGFuZ2VzID8/IDApID4gMDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHVwc2VydE1lbW9yeUVtYmVkZGluZyhhcmdzOiB7XG4gIG1lbW9yeUlkOiBzdHJpbmc7XG4gIG1vZGVsOiBzdHJpbmc7XG4gIGRpbTogbnVtYmVyO1xuICB2ZWN0b3I6IFVpbnQ4QXJyYXk7XG4gIHVwZGF0ZWRBdDogc3RyaW5nO1xufSk6IHZvaWQge1xuICBpZiAoIWN1cnJlbnREYikgdGhyb3cgbmV3IEdTREVycm9yKEdTRF9TVEFMRV9TVEFURSwgXCJnc2QtZGI6IE5vIGRhdGFiYXNlIG9wZW5cIik7XG4gIGN1cnJlbnREYi5wcmVwYXJlKFxuICAgIGBJTlNFUlQgSU5UTyBtZW1vcnlfZW1iZWRkaW5ncyAobWVtb3J5X2lkLCBtb2RlbCwgZGltLCB2ZWN0b3IsIHVwZGF0ZWRfYXQpXG4gICAgIFZBTFVFUyAoOm1lbW9yeV9pZCwgOm1vZGVsLCA6ZGltLCA6dmVjdG9yLCA6dXBkYXRlZF9hdClcbiAgICAgT04gQ09ORkxJQ1QobWVtb3J5X2lkKSBETyBVUERBVEUgU0VUXG4gICAgICAgbW9kZWwgPSBleGNsdWRlZC5tb2RlbCxcbiAgICAgICBkaW0gPSBleGNsdWRlZC5kaW0sXG4gICAgICAgdmVjdG9yID0gZXhjbHVkZWQudmVjdG9yLFxuICAgICAgIHVwZGF0ZWRfYXQgPSBleGNsdWRlZC51cGRhdGVkX2F0YCxcbiAgKS5ydW4oe1xuICAgIFwiOm1lbW9yeV9pZFwiOiBhcmdzLm1lbW9yeUlkLFxuICAgIFwiOm1vZGVsXCI6IGFyZ3MubW9kZWwsXG4gICAgXCI6ZGltXCI6IGFyZ3MuZGltLFxuICAgIFwiOnZlY3RvclwiOiBhcmdzLnZlY3RvcixcbiAgICBcIjp1cGRhdGVkX2F0XCI6IGFyZ3MudXBkYXRlZEF0LFxuICB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGRlbGV0ZU1lbW9yeUVtYmVkZGluZyhtZW1vcnlJZDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGlmICghY3VycmVudERiKSB0aHJvdyBuZXcgR1NERXJyb3IoR1NEX1NUQUxFX1NUQVRFLCBcImdzZC1kYjogTm8gZGF0YWJhc2Ugb3BlblwiKTtcbiAgY29uc3QgcmVzID0gY3VycmVudERiXG4gICAgLnByZXBhcmUoXCJERUxFVEUgRlJPTSBtZW1vcnlfZW1iZWRkaW5ncyBXSEVSRSBtZW1vcnlfaWQgPSA6aWRcIilcbiAgICAucnVuKHsgXCI6aWRcIjogbWVtb3J5SWQgfSkgYXMgeyBjaGFuZ2VzPzogbnVtYmVyIH07XG4gIHJldHVybiAocmVzPy5jaGFuZ2VzID8/IDApID4gMDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGluc2VydE1lbW9yeVJlbGF0aW9uUm93KGFyZ3M6IHtcbiAgZnJvbUlkOiBzdHJpbmc7XG4gIHRvSWQ6IHN0cmluZztcbiAgcmVsOiBzdHJpbmc7XG4gIGNvbmZpZGVuY2U6IG51bWJlcjtcbiAgY3JlYXRlZEF0OiBzdHJpbmc7XG59KTogdm9pZCB7XG4gIGlmICghY3VycmVudERiKSB0aHJvdyBuZXcgR1NERXJyb3IoR1NEX1NUQUxFX1NUQVRFLCBcImdzZC1kYjogTm8gZGF0YWJhc2Ugb3BlblwiKTtcbiAgY3VycmVudERiLnByZXBhcmUoXG4gICAgYElOU0VSVCBPUiBSRVBMQUNFIElOVE8gbWVtb3J5X3JlbGF0aW9ucyAoZnJvbV9pZCwgdG9faWQsIHJlbCwgY29uZmlkZW5jZSwgY3JlYXRlZF9hdClcbiAgICAgVkFMVUVTICg6ZnJvbV9pZCwgOnRvX2lkLCA6cmVsLCA6Y29uZmlkZW5jZSwgOmNyZWF0ZWRfYXQpYCxcbiAgKS5ydW4oe1xuICAgIFwiOmZyb21faWRcIjogYXJncy5mcm9tSWQsXG4gICAgXCI6dG9faWRcIjogYXJncy50b0lkLFxuICAgIFwiOnJlbFwiOiBhcmdzLnJlbCxcbiAgICBcIjpjb25maWRlbmNlXCI6IGFyZ3MuY29uZmlkZW5jZSxcbiAgICBcIjpjcmVhdGVkX2F0XCI6IGFyZ3MuY3JlYXRlZEF0LFxuICB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGRlbGV0ZU1lbW9yeVJlbGF0aW9uc0ZvcihtZW1vcnlJZDogc3RyaW5nKTogdm9pZCB7XG4gIGlmICghY3VycmVudERiKSB0aHJvdyBuZXcgR1NERXJyb3IoR1NEX1NUQUxFX1NUQVRFLCBcImdzZC1kYjogTm8gZGF0YWJhc2Ugb3BlblwiKTtcbiAgY3VycmVudERiXG4gICAgLnByZXBhcmUoXCJERUxFVEUgRlJPTSBtZW1vcnlfcmVsYXRpb25zIFdIRVJFIGZyb21faWQgPSA6aWQgT1IgdG9faWQgPSA6aWRcIilcbiAgICAucnVuKHsgXCI6aWRcIjogbWVtb3J5SWQgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZXdyaXRlTWVtb3J5SWQocGxhY2Vob2xkZXJJZDogc3RyaW5nLCByZWFsSWQ6IHN0cmluZyk6IHZvaWQge1xuICBpZiAoIWN1cnJlbnREYikgdGhyb3cgbmV3IEdTREVycm9yKEdTRF9TVEFMRV9TVEFURSwgXCJnc2QtZGI6IE5vIGRhdGFiYXNlIG9wZW5cIik7XG4gIGN1cnJlbnREYi5wcmVwYXJlKFwiVVBEQVRFIG1lbW9yaWVzIFNFVCBpZCA9IDpyZWFsX2lkIFdIRVJFIGlkID0gOnBsYWNlaG9sZGVyXCIpLnJ1bih7XG4gICAgXCI6cmVhbF9pZFwiOiByZWFsSWQsXG4gICAgXCI6cGxhY2Vob2xkZXJcIjogcGxhY2Vob2xkZXJJZCxcbiAgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVNZW1vcnlDb250ZW50Um93KFxuICBpZDogc3RyaW5nLFxuICBjb250ZW50OiBzdHJpbmcsXG4gIGNvbmZpZGVuY2U6IG51bWJlciB8IHVuZGVmaW5lZCxcbiAgdXBkYXRlZEF0OiBzdHJpbmcsXG4pOiB2b2lkIHtcbiAgaWYgKCFjdXJyZW50RGIpIHRocm93IG5ldyBHU0RFcnJvcihHU0RfU1RBTEVfU1RBVEUsIFwiZ3NkLWRiOiBObyBkYXRhYmFzZSBvcGVuXCIpO1xuICBpZiAoY29uZmlkZW5jZSAhPSBudWxsKSB7XG4gICAgY3VycmVudERiLnByZXBhcmUoXG4gICAgICBcIlVQREFURSBtZW1vcmllcyBTRVQgY29udGVudCA9IDpjb250ZW50LCBjb25maWRlbmNlID0gOmNvbmZpZGVuY2UsIHVwZGF0ZWRfYXQgPSA6dXBkYXRlZF9hdCBXSEVSRSBpZCA9IDppZFwiLFxuICAgICkucnVuKHsgXCI6Y29udGVudFwiOiBjb250ZW50LCBcIjpjb25maWRlbmNlXCI6IGNvbmZpZGVuY2UsIFwiOnVwZGF0ZWRfYXRcIjogdXBkYXRlZEF0LCBcIjppZFwiOiBpZCB9KTtcbiAgfSBlbHNlIHtcbiAgICBjdXJyZW50RGIucHJlcGFyZShcbiAgICAgIFwiVVBEQVRFIG1lbW9yaWVzIFNFVCBjb250ZW50ID0gOmNvbnRlbnQsIHVwZGF0ZWRfYXQgPSA6dXBkYXRlZF9hdCBXSEVSRSBpZCA9IDppZFwiLFxuICAgICkucnVuKHsgXCI6Y29udGVudFwiOiBjb250ZW50LCBcIjp1cGRhdGVkX2F0XCI6IHVwZGF0ZWRBdCwgXCI6aWRcIjogaWQgfSk7XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGluY3JlbWVudE1lbW9yeUhpdENvdW50KGlkOiBzdHJpbmcsIHVwZGF0ZWRBdDogc3RyaW5nKTogdm9pZCB7XG4gIGlmICghY3VycmVudERiKSB0aHJvdyBuZXcgR1NERXJyb3IoR1NEX1NUQUxFX1NUQVRFLCBcImdzZC1kYjogTm8gZGF0YWJhc2Ugb3BlblwiKTtcbiAgY3VycmVudERiLnByZXBhcmUoXG4gICAgXCJVUERBVEUgbWVtb3JpZXMgU0VUIGhpdF9jb3VudCA9IGhpdF9jb3VudCArIDEsIHVwZGF0ZWRfYXQgPSA6dXBkYXRlZF9hdCwgbGFzdF9oaXRfYXQgPSA6bGFzdF9oaXRfYXQgV0hFUkUgaWQgPSA6aWRcIixcbiAgKS5ydW4oeyBcIjp1cGRhdGVkX2F0XCI6IHVwZGF0ZWRBdCwgXCI6bGFzdF9oaXRfYXRcIjogdXBkYXRlZEF0LCBcIjppZFwiOiBpZCB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHN1cGVyc2VkZU1lbW9yeVJvdyhvbGRJZDogc3RyaW5nLCBuZXdJZDogc3RyaW5nLCB1cGRhdGVkQXQ6IHN0cmluZyk6IHZvaWQge1xuICBpZiAoIWN1cnJlbnREYikgdGhyb3cgbmV3IEdTREVycm9yKEdTRF9TVEFMRV9TVEFURSwgXCJnc2QtZGI6IE5vIGRhdGFiYXNlIG9wZW5cIik7XG4gIGN1cnJlbnREYi5wcmVwYXJlKFxuICAgIFwiVVBEQVRFIG1lbW9yaWVzIFNFVCBzdXBlcnNlZGVkX2J5ID0gOm5ld19pZCwgdXBkYXRlZF9hdCA9IDp1cGRhdGVkX2F0IFdIRVJFIGlkID0gOm9sZF9pZFwiLFxuICApLnJ1bih7IFwiOm5ld19pZFwiOiBuZXdJZCwgXCI6dXBkYXRlZF9hdFwiOiB1cGRhdGVkQXQsIFwiOm9sZF9pZFwiOiBvbGRJZCB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1hcmtNZW1vcnlVbml0UHJvY2Vzc2VkKFxuICB1bml0S2V5OiBzdHJpbmcsXG4gIGFjdGl2aXR5RmlsZTogc3RyaW5nLFxuICBwcm9jZXNzZWRBdDogc3RyaW5nLFxuKTogdm9pZCB7XG4gIGlmICghY3VycmVudERiKSB0aHJvdyBuZXcgR1NERXJyb3IoR1NEX1NUQUxFX1NUQVRFLCBcImdzZC1kYjogTm8gZGF0YWJhc2Ugb3BlblwiKTtcbiAgY3VycmVudERiLnByZXBhcmUoXG4gICAgYElOU0VSVCBPUiBJR05PUkUgSU5UTyBtZW1vcnlfcHJvY2Vzc2VkX3VuaXRzICh1bml0X2tleSwgYWN0aXZpdHlfZmlsZSwgcHJvY2Vzc2VkX2F0KVxuICAgICBWQUxVRVMgKDprZXksIDpmaWxlLCA6YXQpYCxcbiAgKS5ydW4oeyBcIjprZXlcIjogdW5pdEtleSwgXCI6ZmlsZVwiOiBhY3Rpdml0eUZpbGUsIFwiOmF0XCI6IHByb2Nlc3NlZEF0IH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZGVjYXlNZW1vcmllc0JlZm9yZShjdXRvZmZUczogc3RyaW5nLCBub3c6IHN0cmluZyk6IHZvaWQge1xuICBpZiAoIWN1cnJlbnREYikgdGhyb3cgbmV3IEdTREVycm9yKEdTRF9TVEFMRV9TVEFURSwgXCJnc2QtZGI6IE5vIGRhdGFiYXNlIG9wZW5cIik7XG4gIGN1cnJlbnREYi5wcmVwYXJlKFxuICAgIGBVUERBVEUgbWVtb3JpZXNcbiAgICAgU0VUIGNvbmZpZGVuY2UgPSBNQVgoMC4xLCBjb25maWRlbmNlIC0gMC4xKSwgdXBkYXRlZF9hdCA9IDpub3dcbiAgICAgV0hFUkUgc3VwZXJzZWRlZF9ieSBJUyBOVUxMIEFORCB1cGRhdGVkX2F0IDwgOmN1dG9mZiBBTkQgY29uZmlkZW5jZSA+IDAuMWAsXG4gICkucnVuKHsgXCI6bm93XCI6IG5vdywgXCI6Y3V0b2ZmXCI6IGN1dG9mZlRzIH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc3VwZXJzZWRlTG93ZXN0UmFua2VkTWVtb3JpZXMobGltaXQ6IG51bWJlciwgbm93OiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKCFjdXJyZW50RGIpIHRocm93IG5ldyBHU0RFcnJvcihHU0RfU1RBTEVfU1RBVEUsIFwiZ3NkLWRiOiBObyBkYXRhYmFzZSBvcGVuXCIpO1xuICBjdXJyZW50RGIucHJlcGFyZShcbiAgICBgVVBEQVRFIG1lbW9yaWVzIFNFVCBzdXBlcnNlZGVkX2J5ID0gJ0NBUF9FWENFRURFRCcsIHVwZGF0ZWRfYXQgPSA6bm93XG4gICAgIFdIRVJFIGlkIElOIChcbiAgICAgICBTRUxFQ1QgaWQgRlJPTSBtZW1vcmllc1xuICAgICAgIFdIRVJFIHN1cGVyc2VkZWRfYnkgSVMgTlVMTFxuICAgICAgIE9SREVSIEJZIChjb25maWRlbmNlICogKDEuMCArIGhpdF9jb3VudCAqIDAuMSkpIEFTQ1xuICAgICAgIExJTUlUIDpsaW1pdFxuICAgICApYCxcbiAgKS5ydW4oeyBcIjpub3dcIjogbm93LCBcIjpsaW1pdFwiOiBsaW1pdCB9KTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQXdCQSxTQUFTLHFCQUFxQjtBQUM5QixTQUFTLGtCQUFrQjtBQUMzQixTQUFTLFlBQVksY0FBYyxXQUFXLG9CQUFvQjtBQUNsRSxTQUFTLGVBQWU7QUFFeEIsU0FBUyxVQUFVLHVCQUF1QjtBQUUxQyxTQUFTLHlCQUF5QztBQUNsRCxTQUFTLFVBQVUsa0JBQWtCO0FBQ3JDLFNBQVMsdUJBQXVDO0FBQ2hELFNBQVMsK0JBQStCO0FBQ3hDLFNBQVMsbUNBQW1DO0FBQzVDLFNBQVMsK0JBQTREO0FBQ3JFO0FBQUEsRUFDRTtBQUFBLEVBQ0E7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
