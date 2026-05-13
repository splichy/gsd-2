import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  openDatabase,
  closeDatabase,
  getDecisionById,
  getActiveDecisions,
  getRequirementById,
  SCHEMA_VERSION,
  _getAdapter
} from "../gsd-db.js";
import {
  parseDecisionsTable,
  parseRequirementsSections,
  migrateFromMarkdown
} from "../md-importer.js";
import { test } from "node:test";
import assert from "node:assert/strict";
const DECISIONS_MD = `# Decisions Register

| # | When | Scope | Decision | Choice | Rationale | Revisable? |
|---|------|-------|----------|--------|-----------|------------|
| D001 | M001 | library | SQLite library | better-sqlite3 | Sync API | No |
| D002 | M001 | arch | DB location | .gsd/gsd.db | Derived state | No |
| D010 | M001/S01 | library | Provider strategy (amends D001) | node:sqlite fallback | Zero deps | No |
| D020 | M001/S02 | library | Importer approach (amends D010) | Direct parse | Simple | Yes |
`;
const REQUIREMENTS_MD = `# Requirements

## Active

### R001 \u2014 SQLite DB layer
- Class: core-capability
- Status: active
- Description: A SQLite database with typed wrappers
- Why it matters: Foundation for storage
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: none
- Validation: unmapped
- Notes: WAL mode enabled

### R002 \u2014 Graceful fallback
- Class: failure-visibility
- Status: active
- Description: Falls back to markdown if SQLite unavailable
- Why it matters: Must not break on exotic platforms
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: M001/S03
- Validation: unmapped
- Notes: Transparent fallback

## Validated

### R017 \u2014 Sub-5ms query latency
- Validated by: M001/S01
- Proof: 50 decisions queried in 0.62ms

## Deferred

### R030 \u2014 Vector search
- Class: differentiator
- Status: deferred
- Description: Rust crate for embeddings
- Why it matters: Semantic retrieval
- Source: user
- Primary owning slice: none
- Supporting slices: none
- Validation: unmapped
- Notes: Deferred to M002

## Out of Scope

### R040 \u2014 Web UI
- Class: anti-feature
- Status: out-of-scope
- Description: No web interface for DB
- Why it matters: Prevents scope creep
- Source: user
- Primary owning slice: none
- Supporting slices: none
- Validation: n/a
- Notes: Excluded in PRD
`;
function createFixtureTree(baseDir) {
  const gsd = path.join(baseDir, ".gsd");
  fs.mkdirSync(gsd, { recursive: true });
  fs.writeFileSync(path.join(gsd, "DECISIONS.md"), DECISIONS_MD);
  fs.writeFileSync(path.join(gsd, "REQUIREMENTS.md"), REQUIREMENTS_MD);
  fs.writeFileSync(path.join(gsd, "PROJECT.md"), "# Test Project\nA test project.");
  const m001 = path.join(gsd, "milestones", "M001");
  fs.mkdirSync(m001, { recursive: true });
  fs.writeFileSync(path.join(m001, "M001-ROADMAP.md"), "# M001 Roadmap\nTest roadmap content.");
  fs.writeFileSync(path.join(m001, "M001-CONTEXT.md"), "# M001 Context\nTest context.");
  const s01 = path.join(m001, "slices", "S01");
  fs.mkdirSync(s01, { recursive: true });
  fs.writeFileSync(path.join(s01, "S01-PLAN.md"), "# S01 Plan\nTest plan.");
  fs.writeFileSync(path.join(s01, "S01-SUMMARY.md"), "# S01 Summary\nTest summary.");
  const tasks = path.join(s01, "tasks");
  fs.mkdirSync(tasks, { recursive: true });
  fs.writeFileSync(path.join(tasks, "T01-PLAN.md"), "# T01 Plan\nTask plan.");
  fs.writeFileSync(path.join(tasks, "T01-SUMMARY.md"), "# T01 Summary\nTask summary.");
}
function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
  }
}
test("md-importer: parseDecisionsTable", () => {
  const decisions = parseDecisionsTable(DECISIONS_MD);
  assert.deepStrictEqual(decisions.length, 4, "should parse 4 decisions");
  assert.deepStrictEqual(decisions[0].id, "D001", "first decision should be D001");
  assert.deepStrictEqual(decisions[0].decision, "SQLite library", "D001 decision text");
  assert.deepStrictEqual(decisions[0].choice, "better-sqlite3", "D001 choice");
  assert.deepStrictEqual(decisions[0].scope, "library", "D001 scope");
  assert.deepStrictEqual(decisions[0].revisable, "No", "D001 revisable");
});
test("md-importer: supersession detection", () => {
  const decisions = parseDecisionsTable(DECISIONS_MD);
  const d001 = decisions.find((d) => d.id === "D001");
  assert.deepStrictEqual(d001?.superseded_by, "D010", "D001 should be superseded by D010");
  const d010 = decisions.find((d) => d.id === "D010");
  assert.deepStrictEqual(d010?.superseded_by, "D020", "D010 should be superseded by D020");
  const d002 = decisions.find((d) => d.id === "D002");
  assert.deepStrictEqual(d002?.superseded_by, null, "D002 should not be superseded");
  const d020 = decisions.find((d) => d.id === "D020");
  assert.deepStrictEqual(d020?.superseded_by, null, "D020 should not be superseded");
});
test("md-importer: malformed/empty rows skipped", () => {
  const malformedInput = `# Decisions

| # | When | Scope | Decision | Choice | Rationale | Revisable? |
|---|------|-------|----------|--------|-----------|------------|
| D001 | M001 | lib | Pick lib | sqlite | Fast | No |
| not-a-decision | bad | x | y | z | w | q |
| | | | | | | |
| D003 | M001 | arch | Config | JSON | Simple | Yes |
`;
  const decisions = parseDecisionsTable(malformedInput);
  assert.deepStrictEqual(decisions.length, 2, "should skip rows without D-prefix IDs");
  assert.deepStrictEqual(decisions[0].id, "D001", "first valid row");
  assert.deepStrictEqual(decisions[1].id, "D003", "second valid row (skipping malformed)");
});
test("md-importer: made_by backward compatibility (old 7-column format)", () => {
  const decisions = parseDecisionsTable(DECISIONS_MD);
  for (const d of decisions) {
    assert.deepStrictEqual(d.made_by, "agent", `${d.id} made_by defaults to agent for legacy format`);
  }
});
test("md-importer: made_by column parsing (new 8-column format)", () => {
  const newFormatMd = `# Decisions Register

| # | When | Scope | Decision | Choice | Rationale | Revisable? | Made By |
|---|------|-------|----------|--------|-----------|------------|---------|
| D001 | M001 | library | SQLite library | better-sqlite3 | Sync API | No | human |
| D002 | M001 | arch | DB location | .gsd/gsd.db | Derived state | No | agent |
| D003 | M002 | impl | Config format | JSON | Simple | Yes | collaborative |
| D004 | M002 | impl | Cache strategy | LRU | Predictable | No | bogus |
`;
  const decisions = parseDecisionsTable(newFormatMd);
  assert.deepStrictEqual(decisions.length, 4, "should parse 4 decisions with new format");
  assert.deepStrictEqual(decisions[0].made_by, "human", "D001 made_by = human");
  assert.deepStrictEqual(decisions[1].made_by, "agent", "D002 made_by = agent");
  assert.deepStrictEqual(decisions[2].made_by, "collaborative", "D003 made_by = collaborative");
  assert.deepStrictEqual(decisions[3].made_by, "agent", "D004 invalid made_by defaults to agent");
});
test("md-importer: parseRequirementsSections", () => {
  const reqs = parseRequirementsSections(REQUIREMENTS_MD);
  assert.deepStrictEqual(reqs.length, 5, "should parse 5 unique requirements");
  const r001 = reqs.find((r) => r.id === "R001");
  assert.ok(!!r001, "R001 should exist");
  assert.deepStrictEqual(r001?.class, "core-capability", "R001 class");
  assert.deepStrictEqual(r001?.status, "active", "R001 status");
  assert.deepStrictEqual(r001?.description, "A SQLite database with typed wrappers", "R001 description");
  assert.deepStrictEqual(r001?.why, "Foundation for storage", "R001 why");
  assert.deepStrictEqual(r001?.source, "user", "R001 source");
  assert.deepStrictEqual(r001?.primary_owner, "M001/S01", "R001 primary_owner");
  assert.deepStrictEqual(r001?.supporting_slices, "none", "R001 supporting_slices");
  assert.deepStrictEqual(r001?.validation, "unmapped", "R001 validation");
  assert.deepStrictEqual(r001?.notes, "WAL mode enabled", "R001 notes");
  assert.ok(r001?.full_content?.includes("### R001") ?? false, "R001 full_content should have heading");
  const r017 = reqs.find((r) => r.id === "R017");
  assert.ok(!!r017, "R017 should exist");
  assert.deepStrictEqual(r017?.status, "validated", "R017 status from validated section");
  assert.deepStrictEqual(r017?.validation, "M001/S01", 'R017 validation (from "Validated by" bullet)');
  assert.deepStrictEqual(r017?.notes, "50 decisions queried in 0.62ms", 'R017 notes (from "Proof" bullet)');
  const r030 = reqs.find((r) => r.id === "R030");
  assert.deepStrictEqual(r030?.status, "deferred", "R030 status should be deferred");
  assert.deepStrictEqual(r030?.class, "differentiator", "R030 class");
  assert.deepStrictEqual(r030?.description, "Rust crate for embeddings", "R030 description");
  const r040 = reqs.find((r) => r.id === "R040");
  assert.deepStrictEqual(r040?.status, "out-of-scope", "R040 status should be out-of-scope");
  assert.deepStrictEqual(r040?.class, "anti-feature", "R040 class");
});
test("md-importer: migrateFromMarkdown orchestrator", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-import-test-"));
  createFixtureTree(tmpDir);
  try {
    openDatabase(":memory:");
    const result = migrateFromMarkdown(tmpDir);
    assert.deepStrictEqual(result.decisions, 4, "should import 4 decisions");
    assert.deepStrictEqual(result.requirements, 5, "should import 5 requirements");
    assert.ok(result.artifacts > 0, "should import some artifacts");
    const d001 = getDecisionById("D001");
    assert.ok(!!d001, "D001 should be queryable");
    assert.deepStrictEqual(d001?.superseded_by, "D010", "D001 superseded_by should be D010");
    const r001 = getRequirementById("R001");
    assert.ok(!!r001, "R001 should be queryable");
    assert.deepStrictEqual(r001?.status, "active", "R001 status from DB");
    const activeD = getActiveDecisions();
    assert.deepStrictEqual(activeD.length, 2, "should have 2 active decisions (D002, D020)");
    const adapter = _getAdapter();
    const artifacts = adapter?.prepare("SELECT count(*) as c FROM artifacts").get();
    assert.ok(artifacts?.c > 0, "artifacts table should have rows");
    const roadmap = adapter?.prepare("SELECT * FROM artifacts WHERE artifact_type = :type").get({ ":type": "ROADMAP" });
    assert.ok(!!roadmap, "ROADMAP artifact should exist");
    assert.deepStrictEqual(roadmap?.milestone_id, "M001", "ROADMAP should be in M001");
    const taskPlan = adapter?.prepare("SELECT * FROM artifacts WHERE task_id = :taskId AND artifact_type = :type").get({
      ":taskId": "T01",
      ":type": "PLAN"
    });
    assert.ok(!!taskPlan, "T01-PLAN artifact should exist");
    closeDatabase();
  } finally {
    cleanupDir(tmpDir);
  }
});
test("md-importer: idempotent re-import", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-idemp-test-"));
  createFixtureTree(tmpDir);
  try {
    openDatabase(":memory:");
    const r1 = migrateFromMarkdown(tmpDir);
    const r2 = migrateFromMarkdown(tmpDir);
    assert.deepStrictEqual(r1.decisions, r2.decisions, "double import should produce same decision count");
    assert.deepStrictEqual(r1.requirements, r2.requirements, "double import should produce same requirement count");
    assert.deepStrictEqual(r1.artifacts, r2.artifacts, "double import should produce same artifact count");
    const adapter = _getAdapter();
    const dc = adapter?.prepare("SELECT count(*) as c FROM decisions").get()?.c;
    const rc = adapter?.prepare("SELECT count(*) as c FROM requirements").get()?.c;
    const ac = adapter?.prepare("SELECT count(*) as c FROM artifacts").get()?.c;
    assert.deepStrictEqual(dc, r1.decisions, "DB decision count matches import count");
    assert.deepStrictEqual(rc, r1.requirements, "DB requirement count matches import count");
    assert.deepStrictEqual(ac, r1.artifacts, "DB artifact count matches import count");
    closeDatabase();
  } finally {
    cleanupDir(tmpDir);
  }
});
test("md-importer: missing file handling", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-empty-test-"));
  fs.mkdirSync(path.join(tmpDir, ".gsd"), { recursive: true });
  try {
    openDatabase(":memory:");
    const result = migrateFromMarkdown(tmpDir);
    assert.deepStrictEqual(result.decisions, 0, "missing DECISIONS.md \u2192 0 decisions");
    assert.deepStrictEqual(result.requirements, 0, "missing REQUIREMENTS.md \u2192 0 requirements");
    assert.deepStrictEqual(result.artifacts, 0, "empty tree \u2192 0 artifacts");
    closeDatabase();
  } finally {
    cleanupDir(tmpDir);
  }
});
test("md-importer: schema v1\u2192v2 migration", () => {
  openDatabase(":memory:");
  const adapter = _getAdapter();
  const version = adapter?.prepare("SELECT MAX(version) as v FROM schema_version").get();
  assert.deepStrictEqual(version?.v, SCHEMA_VERSION, `new DB should be at schema version ${SCHEMA_VERSION}`);
  const tableCheck = adapter?.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='artifacts'").get();
  assert.deepStrictEqual(tableCheck?.c, 1, "artifacts table should exist");
  closeDatabase();
});
test("md-importer: round-trip fidelity", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-roundtrip-test-"));
  createFixtureTree(tmpDir);
  try {
    openDatabase(":memory:");
    migrateFromMarkdown(tmpDir);
    const d002 = getDecisionById("D002");
    assert.deepStrictEqual(d002?.when_context, "M001", "D002 when_context round-trip");
    assert.deepStrictEqual(d002?.scope, "arch", "D002 scope round-trip");
    assert.deepStrictEqual(d002?.decision, "DB location", "D002 decision round-trip");
    assert.deepStrictEqual(d002?.choice, ".gsd/gsd.db", "D002 choice round-trip");
    assert.deepStrictEqual(d002?.rationale, "Derived state", "D002 rationale round-trip");
    const r002 = getRequirementById("R002");
    assert.deepStrictEqual(r002?.class, "failure-visibility", "R002 class round-trip");
    assert.deepStrictEqual(r002?.description, "Falls back to markdown if SQLite unavailable", "R002 description round-trip");
    assert.deepStrictEqual(r002?.why, "Must not break on exotic platforms", "R002 why round-trip");
    assert.deepStrictEqual(r002?.primary_owner, "M001/S01", "R002 primary_owner round-trip");
    assert.deepStrictEqual(r002?.supporting_slices, "M001/S03", "R002 supporting_slices round-trip");
    assert.deepStrictEqual(r002?.notes, "Transparent fallback", "R002 notes round-trip");
    assert.deepStrictEqual(r002?.validation, "unmapped", "R002 validation round-trip");
    const adapter = _getAdapter();
    const project = adapter?.prepare("SELECT * FROM artifacts WHERE path = :path").get({ ":path": "PROJECT.md" });
    assert.ok(project?.full_content?.includes("Test Project"), "PROJECT.md content round-trip");
    closeDatabase();
  } finally {
    cleanupDir(tmpDir);
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9tZC1pbXBvcnRlci50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgKiBhcyBmcyBmcm9tICdub2RlOmZzJztcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAnbm9kZTpwYXRoJztcbmltcG9ydCAqIGFzIG9zIGZyb20gJ25vZGU6b3MnO1xuaW1wb3J0IHtcbiAgb3BlbkRhdGFiYXNlLFxuICBjbG9zZURhdGFiYXNlLFxuICBnZXREZWNpc2lvbkJ5SWQsXG4gIGdldEFjdGl2ZURlY2lzaW9ucyxcbiAgZ2V0UmVxdWlyZW1lbnRCeUlkLFxuICBnZXRBY3RpdmVSZXF1aXJlbWVudHMsXG4gIGluc2VydEFydGlmYWN0LFxuICBTQ0hFTUFfVkVSU0lPTixcbiAgX2dldEFkYXB0ZXIsXG59IGZyb20gJy4uL2dzZC1kYi50cyc7XG5pbXBvcnQge1xuICBwYXJzZURlY2lzaW9uc1RhYmxlLFxuICBwYXJzZVJlcXVpcmVtZW50c1NlY3Rpb25zLFxuICBtaWdyYXRlRnJvbU1hcmtkb3duLFxufSBmcm9tICcuLi9tZC1pbXBvcnRlci50cyc7XG5pbXBvcnQgeyBkZXNjcmliZSwgdGVzdCwgYmVmb3JlRWFjaCwgYWZ0ZXJFYWNoIH0gZnJvbSAnbm9kZTp0ZXN0JztcbmltcG9ydCBhc3NlcnQgZnJvbSAnbm9kZTphc3NlcnQvc3RyaWN0JztcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBGaXh0dXJlc1xuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbmNvbnN0IERFQ0lTSU9OU19NRCA9IGAjIERlY2lzaW9ucyBSZWdpc3RlclxuXG58ICMgfCBXaGVuIHwgU2NvcGUgfCBEZWNpc2lvbiB8IENob2ljZSB8IFJhdGlvbmFsZSB8IFJldmlzYWJsZT8gfFxufC0tLXwtLS0tLS18LS0tLS0tLXwtLS0tLS0tLS0tfC0tLS0tLS0tfC0tLS0tLS0tLS0tfC0tLS0tLS0tLS0tLXxcbnwgRDAwMSB8IE0wMDEgfCBsaWJyYXJ5IHwgU1FMaXRlIGxpYnJhcnkgfCBiZXR0ZXItc3FsaXRlMyB8IFN5bmMgQVBJIHwgTm8gfFxufCBEMDAyIHwgTTAwMSB8IGFyY2ggfCBEQiBsb2NhdGlvbiB8IC5nc2QvZ3NkLmRiIHwgRGVyaXZlZCBzdGF0ZSB8IE5vIHxcbnwgRDAxMCB8IE0wMDEvUzAxIHwgbGlicmFyeSB8IFByb3ZpZGVyIHN0cmF0ZWd5IChhbWVuZHMgRDAwMSkgfCBub2RlOnNxbGl0ZSBmYWxsYmFjayB8IFplcm8gZGVwcyB8IE5vIHxcbnwgRDAyMCB8IE0wMDEvUzAyIHwgbGlicmFyeSB8IEltcG9ydGVyIGFwcHJvYWNoIChhbWVuZHMgRDAxMCkgfCBEaXJlY3QgcGFyc2UgfCBTaW1wbGUgfCBZZXMgfFxuYDtcblxuY29uc3QgUkVRVUlSRU1FTlRTX01EID0gYCMgUmVxdWlyZW1lbnRzXG5cbiMjIEFjdGl2ZVxuXG4jIyMgUjAwMSBcdTIwMTQgU1FMaXRlIERCIGxheWVyXG4tIENsYXNzOiBjb3JlLWNhcGFiaWxpdHlcbi0gU3RhdHVzOiBhY3RpdmVcbi0gRGVzY3JpcHRpb246IEEgU1FMaXRlIGRhdGFiYXNlIHdpdGggdHlwZWQgd3JhcHBlcnNcbi0gV2h5IGl0IG1hdHRlcnM6IEZvdW5kYXRpb24gZm9yIHN0b3JhZ2Vcbi0gU291cmNlOiB1c2VyXG4tIFByaW1hcnkgb3duaW5nIHNsaWNlOiBNMDAxL1MwMVxuLSBTdXBwb3J0aW5nIHNsaWNlczogbm9uZVxuLSBWYWxpZGF0aW9uOiB1bm1hcHBlZFxuLSBOb3RlczogV0FMIG1vZGUgZW5hYmxlZFxuXG4jIyMgUjAwMiBcdTIwMTQgR3JhY2VmdWwgZmFsbGJhY2tcbi0gQ2xhc3M6IGZhaWx1cmUtdmlzaWJpbGl0eVxuLSBTdGF0dXM6IGFjdGl2ZVxuLSBEZXNjcmlwdGlvbjogRmFsbHMgYmFjayB0byBtYXJrZG93biBpZiBTUUxpdGUgdW5hdmFpbGFibGVcbi0gV2h5IGl0IG1hdHRlcnM6IE11c3Qgbm90IGJyZWFrIG9uIGV4b3RpYyBwbGF0Zm9ybXNcbi0gU291cmNlOiB1c2VyXG4tIFByaW1hcnkgb3duaW5nIHNsaWNlOiBNMDAxL1MwMVxuLSBTdXBwb3J0aW5nIHNsaWNlczogTTAwMS9TMDNcbi0gVmFsaWRhdGlvbjogdW5tYXBwZWRcbi0gTm90ZXM6IFRyYW5zcGFyZW50IGZhbGxiYWNrXG5cbiMjIFZhbGlkYXRlZFxuXG4jIyMgUjAxNyBcdTIwMTQgU3ViLTVtcyBxdWVyeSBsYXRlbmN5XG4tIFZhbGlkYXRlZCBieTogTTAwMS9TMDFcbi0gUHJvb2Y6IDUwIGRlY2lzaW9ucyBxdWVyaWVkIGluIDAuNjJtc1xuXG4jIyBEZWZlcnJlZFxuXG4jIyMgUjAzMCBcdTIwMTQgVmVjdG9yIHNlYXJjaFxuLSBDbGFzczogZGlmZmVyZW50aWF0b3Jcbi0gU3RhdHVzOiBkZWZlcnJlZFxuLSBEZXNjcmlwdGlvbjogUnVzdCBjcmF0ZSBmb3IgZW1iZWRkaW5nc1xuLSBXaHkgaXQgbWF0dGVyczogU2VtYW50aWMgcmV0cmlldmFsXG4tIFNvdXJjZTogdXNlclxuLSBQcmltYXJ5IG93bmluZyBzbGljZTogbm9uZVxuLSBTdXBwb3J0aW5nIHNsaWNlczogbm9uZVxuLSBWYWxpZGF0aW9uOiB1bm1hcHBlZFxuLSBOb3RlczogRGVmZXJyZWQgdG8gTTAwMlxuXG4jIyBPdXQgb2YgU2NvcGVcblxuIyMjIFIwNDAgXHUyMDE0IFdlYiBVSVxuLSBDbGFzczogYW50aS1mZWF0dXJlXG4tIFN0YXR1czogb3V0LW9mLXNjb3BlXG4tIERlc2NyaXB0aW9uOiBObyB3ZWIgaW50ZXJmYWNlIGZvciBEQlxuLSBXaHkgaXQgbWF0dGVyczogUHJldmVudHMgc2NvcGUgY3JlZXBcbi0gU291cmNlOiB1c2VyXG4tIFByaW1hcnkgb3duaW5nIHNsaWNlOiBub25lXG4tIFN1cHBvcnRpbmcgc2xpY2VzOiBub25lXG4tIFZhbGlkYXRpb246IG4vYVxuLSBOb3RlczogRXhjbHVkZWQgaW4gUFJEXG5gO1xuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIEhlbHBlcnNcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG5mdW5jdGlvbiBjcmVhdGVGaXh0dXJlVHJlZShiYXNlRGlyOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgZ3NkID0gcGF0aC5qb2luKGJhc2VEaXIsICcuZ3NkJyk7XG4gIGZzLm1rZGlyU3luYyhnc2QsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBmcy53cml0ZUZpbGVTeW5jKHBhdGguam9pbihnc2QsICdERUNJU0lPTlMubWQnKSwgREVDSVNJT05TX01EKTtcbiAgZnMud3JpdGVGaWxlU3luYyhwYXRoLmpvaW4oZ3NkLCAnUkVRVUlSRU1FTlRTLm1kJyksIFJFUVVJUkVNRU5UU19NRCk7XG4gIGZzLndyaXRlRmlsZVN5bmMocGF0aC5qb2luKGdzZCwgJ1BST0pFQ1QubWQnKSwgJyMgVGVzdCBQcm9qZWN0XFxuQSB0ZXN0IHByb2plY3QuJyk7XG5cbiAgLy8gQ3JlYXRlIG1pbGVzdG9uZSBoaWVyYXJjaHlcbiAgY29uc3QgbTAwMSA9IHBhdGguam9pbihnc2QsICdtaWxlc3RvbmVzJywgJ00wMDEnKTtcbiAgZnMubWtkaXJTeW5jKG0wMDEsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBmcy53cml0ZUZpbGVTeW5jKHBhdGguam9pbihtMDAxLCAnTTAwMS1ST0FETUFQLm1kJyksICcjIE0wMDEgUm9hZG1hcFxcblRlc3Qgcm9hZG1hcCBjb250ZW50LicpO1xuICBmcy53cml0ZUZpbGVTeW5jKHBhdGguam9pbihtMDAxLCAnTTAwMS1DT05URVhULm1kJyksICcjIE0wMDEgQ29udGV4dFxcblRlc3QgY29udGV4dC4nKTtcblxuICAvLyBDcmVhdGUgc2xpY2VcbiAgY29uc3QgczAxID0gcGF0aC5qb2luKG0wMDEsICdzbGljZXMnLCAnUzAxJyk7XG4gIGZzLm1rZGlyU3luYyhzMDEsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBmcy53cml0ZUZpbGVTeW5jKHBhdGguam9pbihzMDEsICdTMDEtUExBTi5tZCcpLCAnIyBTMDEgUGxhblxcblRlc3QgcGxhbi4nKTtcbiAgZnMud3JpdGVGaWxlU3luYyhwYXRoLmpvaW4oczAxLCAnUzAxLVNVTU1BUlkubWQnKSwgJyMgUzAxIFN1bW1hcnlcXG5UZXN0IHN1bW1hcnkuJyk7XG5cbiAgLy8gQ3JlYXRlIHRhc2tzXG4gIGNvbnN0IHRhc2tzID0gcGF0aC5qb2luKHMwMSwgJ3Rhc2tzJyk7XG4gIGZzLm1rZGlyU3luYyh0YXNrcywgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGZzLndyaXRlRmlsZVN5bmMocGF0aC5qb2luKHRhc2tzLCAnVDAxLVBMQU4ubWQnKSwgJyMgVDAxIFBsYW5cXG5UYXNrIHBsYW4uJyk7XG4gIGZzLndyaXRlRmlsZVN5bmMocGF0aC5qb2luKHRhc2tzLCAnVDAxLVNVTU1BUlkubWQnKSwgJyMgVDAxIFN1bW1hcnlcXG5UYXNrIHN1bW1hcnkuJyk7XG59XG5cbmZ1bmN0aW9uIGNsZWFudXBEaXIoZGlyOiBzdHJpbmcpOiB2b2lkIHtcbiAgdHJ5IHtcbiAgICBmcy5ybVN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH0gY2F0Y2gge1xuICAgIC8vIGJlc3QgZWZmb3J0XG4gIH1cbn1cblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBtZC1pbXBvcnRlcjogcGFyc2VEZWNpc2lvbnNUYWJsZVxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbnRlc3QoJ21kLWltcG9ydGVyOiBwYXJzZURlY2lzaW9uc1RhYmxlJywgKCkgPT4ge1xuICBjb25zdCBkZWNpc2lvbnMgPSBwYXJzZURlY2lzaW9uc1RhYmxlKERFQ0lTSU9OU19NRCk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZGVjaXNpb25zLmxlbmd0aCwgNCwgJ3Nob3VsZCBwYXJzZSA0IGRlY2lzaW9ucycpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRlY2lzaW9uc1swXS5pZCwgJ0QwMDEnLCAnZmlyc3QgZGVjaXNpb24gc2hvdWxkIGJlIEQwMDEnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkZWNpc2lvbnNbMF0uZGVjaXNpb24sICdTUUxpdGUgbGlicmFyeScsICdEMDAxIGRlY2lzaW9uIHRleHQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkZWNpc2lvbnNbMF0uY2hvaWNlLCAnYmV0dGVyLXNxbGl0ZTMnLCAnRDAwMSBjaG9pY2UnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkZWNpc2lvbnNbMF0uc2NvcGUsICdsaWJyYXJ5JywgJ0QwMDEgc2NvcGUnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkZWNpc2lvbnNbMF0ucmV2aXNhYmxlLCAnTm8nLCAnRDAwMSByZXZpc2FibGUnKTtcbn0pO1xuXG50ZXN0KCdtZC1pbXBvcnRlcjogc3VwZXJzZXNzaW9uIGRldGVjdGlvbicsICgpID0+IHtcbiAgY29uc3QgZGVjaXNpb25zID0gcGFyc2VEZWNpc2lvbnNUYWJsZShERUNJU0lPTlNfTUQpO1xuXG4gIC8vIEQwMTAgYW1lbmRzIEQwMDEgXHUyMTkyIEQwMDEuc3VwZXJzZWRlZF9ieSA9IEQwMTBcbiAgY29uc3QgZDAwMSA9IGRlY2lzaW9ucy5maW5kKGQgPT4gZC5pZCA9PT0gJ0QwMDEnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkMDAxPy5zdXBlcnNlZGVkX2J5LCAnRDAxMCcsICdEMDAxIHNob3VsZCBiZSBzdXBlcnNlZGVkIGJ5IEQwMTAnKTtcblxuICAvLyBEMDIwIGFtZW5kcyBEMDEwIFx1MjE5MiBEMDEwLnN1cGVyc2VkZWRfYnkgPSBEMDIwXG4gIGNvbnN0IGQwMTAgPSBkZWNpc2lvbnMuZmluZChkID0+IGQuaWQgPT09ICdEMDEwJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZDAxMD8uc3VwZXJzZWRlZF9ieSwgJ0QwMjAnLCAnRDAxMCBzaG91bGQgYmUgc3VwZXJzZWRlZCBieSBEMDIwJyk7XG5cbiAgLy8gRDAwMiBpcyBub3QgYW1lbmRlZFxuICBjb25zdCBkMDAyID0gZGVjaXNpb25zLmZpbmQoZCA9PiBkLmlkID09PSAnRDAwMicpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGQwMDI/LnN1cGVyc2VkZWRfYnksIG51bGwsICdEMDAyIHNob3VsZCBub3QgYmUgc3VwZXJzZWRlZCcpO1xuXG4gIC8vIEQwMjAgaXMgdGhlIGxhdGVzdCBpbiBjaGFpbiwgbm90IHN1cGVyc2VkZWRcbiAgY29uc3QgZDAyMCA9IGRlY2lzaW9ucy5maW5kKGQgPT4gZC5pZCA9PT0gJ0QwMjAnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkMDIwPy5zdXBlcnNlZGVkX2J5LCBudWxsLCAnRDAyMCBzaG91bGQgbm90IGJlIHN1cGVyc2VkZWQnKTtcbn0pO1xuXG50ZXN0KCdtZC1pbXBvcnRlcjogbWFsZm9ybWVkL2VtcHR5IHJvd3Mgc2tpcHBlZCcsICgpID0+IHtcbiAgY29uc3QgbWFsZm9ybWVkSW5wdXQgPSBgIyBEZWNpc2lvbnNcblxufCAjIHwgV2hlbiB8IFNjb3BlIHwgRGVjaXNpb24gfCBDaG9pY2UgfCBSYXRpb25hbGUgfCBSZXZpc2FibGU/IHxcbnwtLS18LS0tLS0tfC0tLS0tLS18LS0tLS0tLS0tLXwtLS0tLS0tLXwtLS0tLS0tLS0tLXwtLS0tLS0tLS0tLS18XG58IEQwMDEgfCBNMDAxIHwgbGliIHwgUGljayBsaWIgfCBzcWxpdGUgfCBGYXN0IHwgTm8gfFxufCBub3QtYS1kZWNpc2lvbiB8IGJhZCB8IHggfCB5IHwgeiB8IHcgfCBxIHxcbnwgfCB8IHwgfCB8IHwgfFxufCBEMDAzIHwgTTAwMSB8IGFyY2ggfCBDb25maWcgfCBKU09OIHwgU2ltcGxlIHwgWWVzIHxcbmA7XG4gIGNvbnN0IGRlY2lzaW9ucyA9IHBhcnNlRGVjaXNpb25zVGFibGUobWFsZm9ybWVkSW5wdXQpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRlY2lzaW9ucy5sZW5ndGgsIDIsICdzaG91bGQgc2tpcCByb3dzIHdpdGhvdXQgRC1wcmVmaXggSURzJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZGVjaXNpb25zWzBdLmlkLCAnRDAwMScsICdmaXJzdCB2YWxpZCByb3cnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkZWNpc2lvbnNbMV0uaWQsICdEMDAzJywgJ3NlY29uZCB2YWxpZCByb3cgKHNraXBwaW5nIG1hbGZvcm1lZCknKTtcbn0pO1xuXG50ZXN0KCdtZC1pbXBvcnRlcjogbWFkZV9ieSBiYWNrd2FyZCBjb21wYXRpYmlsaXR5IChvbGQgNy1jb2x1bW4gZm9ybWF0KScsICgpID0+IHtcbiAgY29uc3QgZGVjaXNpb25zID0gcGFyc2VEZWNpc2lvbnNUYWJsZShERUNJU0lPTlNfTUQpO1xuICAvLyBPbGQgZm9ybWF0IGhhcyBubyBNYWRlIEJ5IGNvbHVtbiBcdTIwMTQgc2hvdWxkIGRlZmF1bHQgdG8gJ2FnZW50J1xuICBmb3IgKGNvbnN0IGQgb2YgZGVjaXNpb25zKSB7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkLm1hZGVfYnksICdhZ2VudCcsIGAke2QuaWR9IG1hZGVfYnkgZGVmYXVsdHMgdG8gYWdlbnQgZm9yIGxlZ2FjeSBmb3JtYXRgKTtcbiAgfVxufSk7XG5cbnRlc3QoJ21kLWltcG9ydGVyOiBtYWRlX2J5IGNvbHVtbiBwYXJzaW5nIChuZXcgOC1jb2x1bW4gZm9ybWF0KScsICgpID0+IHtcbiAgY29uc3QgbmV3Rm9ybWF0TWQgPSBgIyBEZWNpc2lvbnMgUmVnaXN0ZXJcblxufCAjIHwgV2hlbiB8IFNjb3BlIHwgRGVjaXNpb24gfCBDaG9pY2UgfCBSYXRpb25hbGUgfCBSZXZpc2FibGU/IHwgTWFkZSBCeSB8XG58LS0tfC0tLS0tLXwtLS0tLS0tfC0tLS0tLS0tLS18LS0tLS0tLS18LS0tLS0tLS0tLS18LS0tLS0tLS0tLS0tfC0tLS0tLS0tLXxcbnwgRDAwMSB8IE0wMDEgfCBsaWJyYXJ5IHwgU1FMaXRlIGxpYnJhcnkgfCBiZXR0ZXItc3FsaXRlMyB8IFN5bmMgQVBJIHwgTm8gfCBodW1hbiB8XG58IEQwMDIgfCBNMDAxIHwgYXJjaCB8IERCIGxvY2F0aW9uIHwgLmdzZC9nc2QuZGIgfCBEZXJpdmVkIHN0YXRlIHwgTm8gfCBhZ2VudCB8XG58IEQwMDMgfCBNMDAyIHwgaW1wbCB8IENvbmZpZyBmb3JtYXQgfCBKU09OIHwgU2ltcGxlIHwgWWVzIHwgY29sbGFib3JhdGl2ZSB8XG58IEQwMDQgfCBNMDAyIHwgaW1wbCB8IENhY2hlIHN0cmF0ZWd5IHwgTFJVIHwgUHJlZGljdGFibGUgfCBObyB8IGJvZ3VzIHxcbmA7XG4gIGNvbnN0IGRlY2lzaW9ucyA9IHBhcnNlRGVjaXNpb25zVGFibGUobmV3Rm9ybWF0TWQpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRlY2lzaW9ucy5sZW5ndGgsIDQsICdzaG91bGQgcGFyc2UgNCBkZWNpc2lvbnMgd2l0aCBuZXcgZm9ybWF0Jyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZGVjaXNpb25zWzBdLm1hZGVfYnksICdodW1hbicsICdEMDAxIG1hZGVfYnkgPSBodW1hbicpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRlY2lzaW9uc1sxXS5tYWRlX2J5LCAnYWdlbnQnLCAnRDAwMiBtYWRlX2J5ID0gYWdlbnQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkZWNpc2lvbnNbMl0ubWFkZV9ieSwgJ2NvbGxhYm9yYXRpdmUnLCAnRDAwMyBtYWRlX2J5ID0gY29sbGFib3JhdGl2ZScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRlY2lzaW9uc1szXS5tYWRlX2J5LCAnYWdlbnQnLCAnRDAwNCBpbnZhbGlkIG1hZGVfYnkgZGVmYXVsdHMgdG8gYWdlbnQnKTtcbn0pO1xuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIG1kLWltcG9ydGVyOiBwYXJzZVJlcXVpcmVtZW50c1NlY3Rpb25zXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxudGVzdCgnbWQtaW1wb3J0ZXI6IHBhcnNlUmVxdWlyZW1lbnRzU2VjdGlvbnMnLCAoKSA9PiB7XG4gIGNvbnN0IHJlcXMgPSBwYXJzZVJlcXVpcmVtZW50c1NlY3Rpb25zKFJFUVVJUkVNRU5UU19NRCk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVxcy5sZW5ndGgsIDUsICdzaG91bGQgcGFyc2UgNSB1bmlxdWUgcmVxdWlyZW1lbnRzJyk7XG5cbiAgY29uc3QgcjAwMSA9IHJlcXMuZmluZChyID0+IHIuaWQgPT09ICdSMDAxJyk7XG4gIGFzc2VydC5vayghIXIwMDEsICdSMDAxIHNob3VsZCBleGlzdCcpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHIwMDE/LmNsYXNzLCAnY29yZS1jYXBhYmlsaXR5JywgJ1IwMDEgY2xhc3MnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyMDAxPy5zdGF0dXMsICdhY3RpdmUnLCAnUjAwMSBzdGF0dXMnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyMDAxPy5kZXNjcmlwdGlvbiwgJ0EgU1FMaXRlIGRhdGFiYXNlIHdpdGggdHlwZWQgd3JhcHBlcnMnLCAnUjAwMSBkZXNjcmlwdGlvbicpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHIwMDE/LndoeSwgJ0ZvdW5kYXRpb24gZm9yIHN0b3JhZ2UnLCAnUjAwMSB3aHknKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyMDAxPy5zb3VyY2UsICd1c2VyJywgJ1IwMDEgc291cmNlJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocjAwMT8ucHJpbWFyeV9vd25lciwgJ00wMDEvUzAxJywgJ1IwMDEgcHJpbWFyeV9vd25lcicpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHIwMDE/LnN1cHBvcnRpbmdfc2xpY2VzLCAnbm9uZScsICdSMDAxIHN1cHBvcnRpbmdfc2xpY2VzJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocjAwMT8udmFsaWRhdGlvbiwgJ3VubWFwcGVkJywgJ1IwMDEgdmFsaWRhdGlvbicpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHIwMDE/Lm5vdGVzLCAnV0FMIG1vZGUgZW5hYmxlZCcsICdSMDAxIG5vdGVzJyk7XG4gIGFzc2VydC5vayhyMDAxPy5mdWxsX2NvbnRlbnQ/LmluY2x1ZGVzKCcjIyMgUjAwMScpID8/IGZhbHNlLCAnUjAwMSBmdWxsX2NvbnRlbnQgc2hvdWxkIGhhdmUgaGVhZGluZycpO1xuXG4gIC8vIFZhbGlkYXRlZCBzZWN0aW9uIFx1MjAxNCBSMDE3IChhYmJyZXZpYXRlZCBmb3JtYXQgd2l0aCBcIlZhbGlkYXRlZCBieVwiIC8gXCJQcm9vZlwiIGJ1bGxldHMpXG4gIGNvbnN0IHIwMTcgPSByZXFzLmZpbmQociA9PiByLmlkID09PSAnUjAxNycpO1xuICBhc3NlcnQub2soISFyMDE3LCAnUjAxNyBzaG91bGQgZXhpc3QnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyMDE3Py5zdGF0dXMsICd2YWxpZGF0ZWQnLCAnUjAxNyBzdGF0dXMgZnJvbSB2YWxpZGF0ZWQgc2VjdGlvbicpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHIwMTc/LnZhbGlkYXRpb24sICdNMDAxL1MwMScsICdSMDE3IHZhbGlkYXRpb24gKGZyb20gXCJWYWxpZGF0ZWQgYnlcIiBidWxsZXQpJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocjAxNz8ubm90ZXMsICc1MCBkZWNpc2lvbnMgcXVlcmllZCBpbiAwLjYybXMnLCAnUjAxNyBub3RlcyAoZnJvbSBcIlByb29mXCIgYnVsbGV0KScpO1xuXG4gIC8vIERlZmVycmVkIHJlcXVpcmVtZW50XG4gIGNvbnN0IHIwMzAgPSByZXFzLmZpbmQociA9PiByLmlkID09PSAnUjAzMCcpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHIwMzA/LnN0YXR1cywgJ2RlZmVycmVkJywgJ1IwMzAgc3RhdHVzIHNob3VsZCBiZSBkZWZlcnJlZCcpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHIwMzA/LmNsYXNzLCAnZGlmZmVyZW50aWF0b3InLCAnUjAzMCBjbGFzcycpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHIwMzA/LmRlc2NyaXB0aW9uLCAnUnVzdCBjcmF0ZSBmb3IgZW1iZWRkaW5ncycsICdSMDMwIGRlc2NyaXB0aW9uJyk7XG5cbiAgLy8gT3V0IG9mIHNjb3BlXG4gIGNvbnN0IHIwNDAgPSByZXFzLmZpbmQociA9PiByLmlkID09PSAnUjA0MCcpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHIwNDA/LnN0YXR1cywgJ291dC1vZi1zY29wZScsICdSMDQwIHN0YXR1cyBzaG91bGQgYmUgb3V0LW9mLXNjb3BlJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocjA0MD8uY2xhc3MsICdhbnRpLWZlYXR1cmUnLCAnUjA0MCBjbGFzcycpO1xufSk7XG5cbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuLy8gbWQtaW1wb3J0ZXI6IG1pZ3JhdGVGcm9tTWFya2Rvd24gb3JjaGVzdHJhdG9yXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxudGVzdCgnbWQtaW1wb3J0ZXI6IG1pZ3JhdGVGcm9tTWFya2Rvd24gb3JjaGVzdHJhdG9yJywgKCkgPT4ge1xuICBjb25zdCB0bXBEaXIgPSBmcy5ta2R0ZW1wU3luYyhwYXRoLmpvaW4ob3MudG1wZGlyKCksICdnc2QtaW1wb3J0LXRlc3QtJykpO1xuICBjcmVhdGVGaXh0dXJlVHJlZSh0bXBEaXIpO1xuXG4gIHRyeSB7XG4gICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuICAgIGNvbnN0IHJlc3VsdCA9IG1pZ3JhdGVGcm9tTWFya2Rvd24odG1wRGlyKTtcblxuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0LmRlY2lzaW9ucywgNCwgJ3Nob3VsZCBpbXBvcnQgNCBkZWNpc2lvbnMnKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC5yZXF1aXJlbWVudHMsIDUsICdzaG91bGQgaW1wb3J0IDUgcmVxdWlyZW1lbnRzJyk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5hcnRpZmFjdHMgPiAwLCAnc2hvdWxkIGltcG9ydCBzb21lIGFydGlmYWN0cycpO1xuXG4gICAgLy8gVmVyaWZ5IGRlY2lzaW9ucyBxdWVyeWFibGVcbiAgICBjb25zdCBkMDAxID0gZ2V0RGVjaXNpb25CeUlkKCdEMDAxJyk7XG4gICAgYXNzZXJ0Lm9rKCEhZDAwMSwgJ0QwMDEgc2hvdWxkIGJlIHF1ZXJ5YWJsZScpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZDAwMT8uc3VwZXJzZWRlZF9ieSwgJ0QwMTAnLCAnRDAwMSBzdXBlcnNlZGVkX2J5IHNob3VsZCBiZSBEMDEwJyk7XG5cbiAgICAvLyBWZXJpZnkgcmVxdWlyZW1lbnRzIHF1ZXJ5YWJsZVxuICAgIGNvbnN0IHIwMDEgPSBnZXRSZXF1aXJlbWVudEJ5SWQoJ1IwMDEnKTtcbiAgICBhc3NlcnQub2soISFyMDAxLCAnUjAwMSBzaG91bGQgYmUgcXVlcnlhYmxlJyk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyMDAxPy5zdGF0dXMsICdhY3RpdmUnLCAnUjAwMSBzdGF0dXMgZnJvbSBEQicpO1xuXG4gICAgLy8gVmVyaWZ5IGFjdGl2ZSB2aWV3c1xuICAgIGNvbnN0IGFjdGl2ZUQgPSBnZXRBY3RpdmVEZWNpc2lvbnMoKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGFjdGl2ZUQubGVuZ3RoLCAyLCAnc2hvdWxkIGhhdmUgMiBhY3RpdmUgZGVjaXNpb25zIChEMDAyLCBEMDIwKScpO1xuXG4gICAgLy8gVmVyaWZ5IGFydGlmYWN0cyB0YWJsZVxuICAgIGNvbnN0IGFkYXB0ZXIgPSBfZ2V0QWRhcHRlcigpO1xuICAgIGNvbnN0IGFydGlmYWN0cyA9IGFkYXB0ZXI/LnByZXBhcmUoJ1NFTEVDVCBjb3VudCgqKSBhcyBjIEZST00gYXJ0aWZhY3RzJykuZ2V0KCk7XG4gICAgYXNzZXJ0Lm9rKChhcnRpZmFjdHM/LmMgYXMgbnVtYmVyKSA+IDAsICdhcnRpZmFjdHMgdGFibGUgc2hvdWxkIGhhdmUgcm93cycpO1xuXG4gICAgLy8gVmVyaWZ5IGhpZXJhcmNoeSBjb3JyZWN0bmVzc1xuICAgIGNvbnN0IHJvYWRtYXAgPSBhZGFwdGVyPy5wcmVwYXJlKCdTRUxFQ1QgKiBGUk9NIGFydGlmYWN0cyBXSEVSRSBhcnRpZmFjdF90eXBlID0gOnR5cGUnKS5nZXQoeyAnOnR5cGUnOiAnUk9BRE1BUCcgfSk7XG4gICAgYXNzZXJ0Lm9rKCEhcm9hZG1hcCwgJ1JPQURNQVAgYXJ0aWZhY3Qgc2hvdWxkIGV4aXN0Jyk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyb2FkbWFwPy5taWxlc3RvbmVfaWQsICdNMDAxJywgJ1JPQURNQVAgc2hvdWxkIGJlIGluIE0wMDEnKTtcblxuICAgIGNvbnN0IHRhc2tQbGFuID0gYWRhcHRlcj8ucHJlcGFyZSgnU0VMRUNUICogRlJPTSBhcnRpZmFjdHMgV0hFUkUgdGFza19pZCA9IDp0YXNrSWQgQU5EIGFydGlmYWN0X3R5cGUgPSA6dHlwZScpLmdldCh7XG4gICAgICAnOnRhc2tJZCc6ICdUMDEnLFxuICAgICAgJzp0eXBlJzogJ1BMQU4nLFxuICAgIH0pO1xuICAgIGFzc2VydC5vayghIXRhc2tQbGFuLCAnVDAxLVBMQU4gYXJ0aWZhY3Qgc2hvdWxkIGV4aXN0Jyk7XG5cbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cERpcih0bXBEaXIpO1xuICB9XG59KTtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBtZC1pbXBvcnRlcjogaWRlbXBvdGVudCByZS1pbXBvcnRcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG50ZXN0KCdtZC1pbXBvcnRlcjogaWRlbXBvdGVudCByZS1pbXBvcnQnLCAoKSA9PiB7XG4gIGNvbnN0IHRtcERpciA9IGZzLm1rZHRlbXBTeW5jKHBhdGguam9pbihvcy50bXBkaXIoKSwgJ2dzZC1pZGVtcC10ZXN0LScpKTtcbiAgY3JlYXRlRml4dHVyZVRyZWUodG1wRGlyKTtcblxuICB0cnkge1xuICAgIG9wZW5EYXRhYmFzZSgnOm1lbW9yeTonKTtcbiAgICBjb25zdCByMSA9IG1pZ3JhdGVGcm9tTWFya2Rvd24odG1wRGlyKTtcbiAgICBjb25zdCByMiA9IG1pZ3JhdGVGcm9tTWFya2Rvd24odG1wRGlyKTtcblxuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocjEuZGVjaXNpb25zLCByMi5kZWNpc2lvbnMsICdkb3VibGUgaW1wb3J0IHNob3VsZCBwcm9kdWNlIHNhbWUgZGVjaXNpb24gY291bnQnKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHIxLnJlcXVpcmVtZW50cywgcjIucmVxdWlyZW1lbnRzLCAnZG91YmxlIGltcG9ydCBzaG91bGQgcHJvZHVjZSBzYW1lIHJlcXVpcmVtZW50IGNvdW50Jyk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyMS5hcnRpZmFjdHMsIHIyLmFydGlmYWN0cywgJ2RvdWJsZSBpbXBvcnQgc2hvdWxkIHByb2R1Y2Ugc2FtZSBhcnRpZmFjdCBjb3VudCcpO1xuXG4gICAgLy8gVmVyaWZ5IG5vIGR1cGxpY2F0ZXNcbiAgICBjb25zdCBhZGFwdGVyID0gX2dldEFkYXB0ZXIoKTtcbiAgICBjb25zdCBkYyA9IGFkYXB0ZXI/LnByZXBhcmUoJ1NFTEVDVCBjb3VudCgqKSBhcyBjIEZST00gZGVjaXNpb25zJykuZ2V0KCk/LmMgYXMgbnVtYmVyO1xuICAgIGNvbnN0IHJjID0gYWRhcHRlcj8ucHJlcGFyZSgnU0VMRUNUIGNvdW50KCopIGFzIGMgRlJPTSByZXF1aXJlbWVudHMnKS5nZXQoKT8uYyBhcyBudW1iZXI7XG4gICAgY29uc3QgYWMgPSBhZGFwdGVyPy5wcmVwYXJlKCdTRUxFQ1QgY291bnQoKikgYXMgYyBGUk9NIGFydGlmYWN0cycpLmdldCgpPy5jIGFzIG51bWJlcjtcblxuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZGMsIHIxLmRlY2lzaW9ucywgJ0RCIGRlY2lzaW9uIGNvdW50IG1hdGNoZXMgaW1wb3J0IGNvdW50Jyk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyYywgcjEucmVxdWlyZW1lbnRzLCAnREIgcmVxdWlyZW1lbnQgY291bnQgbWF0Y2hlcyBpbXBvcnQgY291bnQnKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGFjLCByMS5hcnRpZmFjdHMsICdEQiBhcnRpZmFjdCBjb3VudCBtYXRjaGVzIGltcG9ydCBjb3VudCcpO1xuXG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXBEaXIodG1wRGlyKTtcbiAgfVxufSk7XG5cbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuLy8gbWQtaW1wb3J0ZXI6IG1pc3NpbmcgZmlsZSBncmFjZWZ1bCBoYW5kbGluZ1xuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbnRlc3QoJ21kLWltcG9ydGVyOiBtaXNzaW5nIGZpbGUgaGFuZGxpbmcnLCAoKSA9PiB7XG4gIGNvbnN0IHRtcERpciA9IGZzLm1rZHRlbXBTeW5jKHBhdGguam9pbihvcy50bXBkaXIoKSwgJ2dzZC1lbXB0eS10ZXN0LScpKTtcbiAgLy8gQ3JlYXRlIGVtcHR5IC5nc2QvIHdpdGggbm8gZmlsZXNcbiAgZnMubWtkaXJTeW5jKHBhdGguam9pbih0bXBEaXIsICcuZ3NkJyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gIHRyeSB7XG4gICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuICAgIGNvbnN0IHJlc3VsdCA9IG1pZ3JhdGVGcm9tTWFya2Rvd24odG1wRGlyKTtcblxuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0LmRlY2lzaW9ucywgMCwgJ21pc3NpbmcgREVDSVNJT05TLm1kIFx1MjE5MiAwIGRlY2lzaW9ucycpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0LnJlcXVpcmVtZW50cywgMCwgJ21pc3NpbmcgUkVRVUlSRU1FTlRTLm1kIFx1MjE5MiAwIHJlcXVpcmVtZW50cycpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0LmFydGlmYWN0cywgMCwgJ2VtcHR5IHRyZWUgXHUyMTkyIDAgYXJ0aWZhY3RzJyk7XG5cbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cERpcih0bXBEaXIpO1xuICB9XG59KTtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBtZC1pbXBvcnRlcjogc2NoZW1hIHYxXHUyMTkydjIgbWlncmF0aW9uIG9uIGV4aXN0aW5nIERCc1xuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbnRlc3QoJ21kLWltcG9ydGVyOiBzY2hlbWEgdjFcdTIxOTJ2MiBtaWdyYXRpb24nLCAoKSA9PiB7XG4gIC8vIFRoaXMgdGVzdCB2ZXJpZmllcyB0aGF0IG9wZW5pbmcgYSBmcmVzaCBEQiBhdXRvLW1pZ3JhdGVzIHRvIGN1cnJlbnQgc2NoZW1hIHZlcnNpb25cbiAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuICBjb25zdCBhZGFwdGVyID0gX2dldEFkYXB0ZXIoKTtcbiAgY29uc3QgdmVyc2lvbiA9IGFkYXB0ZXI/LnByZXBhcmUoJ1NFTEVDVCBNQVgodmVyc2lvbikgYXMgdiBGUk9NIHNjaGVtYV92ZXJzaW9uJykuZ2V0KCk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwodmVyc2lvbj8udiwgU0NIRU1BX1ZFUlNJT04sIGBuZXcgREIgc2hvdWxkIGJlIGF0IHNjaGVtYSB2ZXJzaW9uICR7U0NIRU1BX1ZFUlNJT059YCk7XG5cbiAgLy8gQXJ0aWZhY3RzIHRhYmxlIHNob3VsZCBleGlzdFxuICBjb25zdCB0YWJsZUNoZWNrID0gYWRhcHRlcj8ucHJlcGFyZShcIlNFTEVDVCBjb3VudCgqKSBhcyBjIEZST00gc3FsaXRlX21hc3RlciBXSEVSRSB0eXBlPSd0YWJsZScgQU5EIG5hbWU9J2FydGlmYWN0cydcIikuZ2V0KCk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwodGFibGVDaGVjaz8uYywgMSwgJ2FydGlmYWN0cyB0YWJsZSBzaG91bGQgZXhpc3QnKTtcblxuICBjbG9zZURhdGFiYXNlKCk7XG59KTtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBtZC1pbXBvcnRlcjogcm91bmQtdHJpcCBmaWRlbGl0eVxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbnRlc3QoJ21kLWltcG9ydGVyOiByb3VuZC10cmlwIGZpZGVsaXR5JywgKCkgPT4ge1xuICBjb25zdCB0bXBEaXIgPSBmcy5ta2R0ZW1wU3luYyhwYXRoLmpvaW4ob3MudG1wZGlyKCksICdnc2Qtcm91bmR0cmlwLXRlc3QtJykpO1xuICBjcmVhdGVGaXh0dXJlVHJlZSh0bXBEaXIpO1xuXG4gIHRyeSB7XG4gICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuICAgIG1pZ3JhdGVGcm9tTWFya2Rvd24odG1wRGlyKTtcblxuICAgIC8vIFJvdW5kLXRyaXA6IHZlcmlmeSBpbXBvcnRlZCBmaWVsZCB2YWx1ZXMgbWF0Y2ggc291cmNlXG4gICAgY29uc3QgZDAwMiA9IGdldERlY2lzaW9uQnlJZCgnRDAwMicpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZDAwMj8ud2hlbl9jb250ZXh0LCAnTTAwMScsICdEMDAyIHdoZW5fY29udGV4dCByb3VuZC10cmlwJyk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkMDAyPy5zY29wZSwgJ2FyY2gnLCAnRDAwMiBzY29wZSByb3VuZC10cmlwJyk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkMDAyPy5kZWNpc2lvbiwgJ0RCIGxvY2F0aW9uJywgJ0QwMDIgZGVjaXNpb24gcm91bmQtdHJpcCcpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZDAwMj8uY2hvaWNlLCAnLmdzZC9nc2QuZGInLCAnRDAwMiBjaG9pY2Ugcm91bmQtdHJpcCcpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZDAwMj8ucmF0aW9uYWxlLCAnRGVyaXZlZCBzdGF0ZScsICdEMDAyIHJhdGlvbmFsZSByb3VuZC10cmlwJyk7XG5cbiAgICBjb25zdCByMDAyID0gZ2V0UmVxdWlyZW1lbnRCeUlkKCdSMDAyJyk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyMDAyPy5jbGFzcywgJ2ZhaWx1cmUtdmlzaWJpbGl0eScsICdSMDAyIGNsYXNzIHJvdW5kLXRyaXAnKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHIwMDI/LmRlc2NyaXB0aW9uLCAnRmFsbHMgYmFjayB0byBtYXJrZG93biBpZiBTUUxpdGUgdW5hdmFpbGFibGUnLCAnUjAwMiBkZXNjcmlwdGlvbiByb3VuZC10cmlwJyk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyMDAyPy53aHksICdNdXN0IG5vdCBicmVhayBvbiBleG90aWMgcGxhdGZvcm1zJywgJ1IwMDIgd2h5IHJvdW5kLXRyaXAnKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHIwMDI/LnByaW1hcnlfb3duZXIsICdNMDAxL1MwMScsICdSMDAyIHByaW1hcnlfb3duZXIgcm91bmQtdHJpcCcpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocjAwMj8uc3VwcG9ydGluZ19zbGljZXMsICdNMDAxL1MwMycsICdSMDAyIHN1cHBvcnRpbmdfc2xpY2VzIHJvdW5kLXRyaXAnKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHIwMDI/Lm5vdGVzLCAnVHJhbnNwYXJlbnQgZmFsbGJhY2snLCAnUjAwMiBub3RlcyByb3VuZC10cmlwJyk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyMDAyPy52YWxpZGF0aW9uLCAndW5tYXBwZWQnLCAnUjAwMiB2YWxpZGF0aW9uIHJvdW5kLXRyaXAnKTtcblxuICAgIC8vIFZlcmlmeSBhcnRpZmFjdCBjb250ZW50IGlzIHN0b3JlZFxuICAgIGNvbnN0IGFkYXB0ZXIgPSBfZ2V0QWRhcHRlcigpO1xuICAgIGNvbnN0IHByb2plY3QgPSBhZGFwdGVyPy5wcmVwYXJlKFwiU0VMRUNUICogRlJPTSBhcnRpZmFjdHMgV0hFUkUgcGF0aCA9IDpwYXRoXCIpLmdldCh7ICc6cGF0aCc6ICdQUk9KRUNULm1kJyB9KTtcbiAgICBhc3NlcnQub2soKHByb2plY3Q/LmZ1bGxfY29udGVudCBhcyBzdHJpbmcpPy5pbmNsdWRlcygnVGVzdCBQcm9qZWN0JyksICdQUk9KRUNULm1kIGNvbnRlbnQgcm91bmQtdHJpcCcpO1xuXG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXBEaXIodG1wRGlyKTtcbiAgfVxufSk7XG5cbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsWUFBWSxRQUFRO0FBQ3BCLFlBQVksVUFBVTtBQUN0QixZQUFZLFFBQVE7QUFDcEI7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBR0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUNQO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUNQLFNBQW1CLFlBQW1DO0FBQ3RELE9BQU8sWUFBWTtBQU1uQixNQUFNLGVBQWU7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBVXJCLE1BQU0sa0JBQWtCO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBK0R4QixTQUFTLGtCQUFrQixTQUF1QjtBQUNoRCxRQUFNLE1BQU0sS0FBSyxLQUFLLFNBQVMsTUFBTTtB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
