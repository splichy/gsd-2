import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import {
  openDatabase,
  closeDatabase,
  upsertDecision,
  upsertRequirement,
  getRequirementById,
  _getAdapter
} from "../gsd-db.js";
import {
  parseDecisionsTable,
  parseRequirementsSections
} from "../md-importer.js";
import {
  generateDecisionsMd,
  generateRequirementsMd,
  nextDecisionId,
  saveDecisionToDb,
  saveRequirementToDb,
  updateRequirementInDb,
  saveArtifactToDb,
  extractDeferredSliceRef
} from "../db-writer.js";
import { getAllDecisionsFromMemories } from "../context-store.js";
function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-dbwriter-"));
  fs.mkdirSync(path.join(dir, ".gsd"), { recursive: true });
  return dir;
}
function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
  }
}
const SAMPLE_DECISIONS = [
  {
    seq: 1,
    id: "D001",
    when_context: "M001",
    scope: "library",
    decision: "SQLite library",
    choice: "better-sqlite3",
    rationale: "Sync API",
    revisable: "No",
    made_by: "collaborative",
    superseded_by: null
  },
  {
    seq: 2,
    id: "D002",
    when_context: "M001",
    scope: "arch",
    decision: "DB location",
    choice: ".gsd/gsd.db",
    rationale: "Derived state",
    revisable: "No",
    made_by: "agent",
    superseded_by: null
  },
  {
    seq: 3,
    id: "D003",
    when_context: "M001/S01",
    scope: "impl",
    decision: "Provider strategy (amends D001)",
    choice: "node:sqlite fallback",
    rationale: "Zero deps",
    revisable: "Yes",
    made_by: "human",
    superseded_by: null
  }
];
const SAMPLE_REQUIREMENTS = [
  {
    id: "R001",
    class: "core-capability",
    status: "active",
    description: "A SQLite database with typed wrappers",
    why: "Foundation for storage",
    source: "user",
    primary_owner: "M001/S01",
    supporting_slices: "none",
    validation: "S01 verified",
    notes: "WAL mode enabled",
    full_content: "",
    superseded_by: null
  },
  {
    id: "R002",
    class: "failure-visibility",
    status: "validated",
    description: "Falls back to markdown if SQLite unavailable",
    why: "Must not break on exotic platforms",
    source: "user",
    primary_owner: "M001/S01",
    supporting_slices: "M001/S03",
    validation: "S03 validated",
    notes: "Transparent fallback",
    full_content: "",
    superseded_by: null
  },
  {
    id: "R030",
    class: "differentiator",
    status: "deferred",
    description: "Vector search support",
    why: "Semantic retrieval",
    source: "user",
    primary_owner: "none",
    supporting_slices: "none",
    validation: "unmapped",
    notes: "Deferred to M002",
    full_content: "",
    superseded_by: null
  },
  {
    id: "R040",
    class: "anti-feature",
    status: "out-of-scope",
    description: "GUI dashboard",
    why: "CLI-first design",
    source: "user",
    primary_owner: "none",
    supporting_slices: "none",
    validation: "",
    notes: "",
    full_content: "",
    superseded_by: null
  }
];
describe("db-writer", () => {
  test("generateDecisionsMd round-trip", () => {
    const md = generateDecisionsMd(SAMPLE_DECISIONS);
    const parsed = parseDecisionsTable(md);
    assert.deepStrictEqual(parsed.length, SAMPLE_DECISIONS.length, "decisions count matches");
    for (let i = 0; i < SAMPLE_DECISIONS.length; i++) {
      const orig = SAMPLE_DECISIONS[i];
      const rt = parsed[i];
      assert.deepStrictEqual(rt.id, orig.id, `decision ${orig.id} id round-trips`);
      assert.deepStrictEqual(rt.when_context, orig.when_context, `decision ${orig.id} when_context round-trips`);
      assert.deepStrictEqual(rt.scope, orig.scope, `decision ${orig.id} scope round-trips`);
      assert.deepStrictEqual(rt.decision, orig.decision, `decision ${orig.id} decision round-trips`);
      assert.deepStrictEqual(rt.choice, orig.choice, `decision ${orig.id} choice round-trips`);
      assert.deepStrictEqual(rt.rationale, orig.rationale, `decision ${orig.id} rationale round-trips`);
      assert.deepStrictEqual(rt.revisable, orig.revisable, `decision ${orig.id} revisable round-trips`);
      assert.deepStrictEqual(rt.made_by, orig.made_by, `decision ${orig.id} made_by round-trips`);
    }
  });
  test("generateDecisionsMd format", () => {
    const md = generateDecisionsMd(SAMPLE_DECISIONS);
    assert.ok(md.startsWith("# Decisions Register\n"), "starts with H1 header");
    assert.ok(md.includes("<!-- Append-only"), "contains HTML comment block");
    assert.ok(md.includes("| # | When | Scope"), "contains table header");
    assert.ok(md.includes("|---|------|-------"), "contains separator row");
    assert.ok(md.includes("| Made By |"), "contains Made By column header");
  });
  test("generateDecisionsMd empty input", () => {
    const md = generateDecisionsMd([]);
    const parsed = parseDecisionsTable(md);
    assert.deepStrictEqual(parsed.length, 0, "empty decisions produces empty parse");
    assert.ok(md.includes("| # | When | Scope"), "still has table header even when empty");
  });
  test("generateDecisionsMd pipe escaping", () => {
    const withPipe = {
      seq: 1,
      id: "D001",
      when_context: "M001",
      scope: "arch",
      decision: "Choice A | Choice B comparison",
      choice: "A",
      rationale: "Better",
      revisable: "No",
      made_by: "agent",
      superseded_by: null
    };
    const md = generateDecisionsMd([withPipe]);
    const parsed = parseDecisionsTable(md);
    assert.ok(parsed.length >= 1, "pipe-containing decision parses without breaking table");
  });
  test("generateRequirementsMd round-trip", () => {
    const md = generateRequirementsMd(SAMPLE_REQUIREMENTS);
    const parsed = parseRequirementsSections(md);
    assert.deepStrictEqual(parsed.length, SAMPLE_REQUIREMENTS.length, "requirements count matches");
    for (const orig of SAMPLE_REQUIREMENTS) {
      const rt = parsed.find((r) => r.id === orig.id);
      assert.ok(!!rt, `requirement ${orig.id} found in parsed output`);
      if (rt) {
        assert.deepStrictEqual(rt.class, orig.class, `requirement ${orig.id} class round-trips`);
        assert.deepStrictEqual(rt.description, orig.description, `requirement ${orig.id} description round-trips`);
        assert.deepStrictEqual(rt.why, orig.why, `requirement ${orig.id} why round-trips`);
        assert.deepStrictEqual(rt.source, orig.source, `requirement ${orig.id} source round-trips`);
        assert.deepStrictEqual(rt.primary_owner, orig.primary_owner, `requirement ${orig.id} primary_owner round-trips`);
        assert.deepStrictEqual(rt.supporting_slices, orig.supporting_slices, `requirement ${orig.id} supporting_slices round-trips`);
        if (orig.notes) {
          assert.deepStrictEqual(rt.notes, orig.notes, `requirement ${orig.id} notes round-trips`);
        }
      }
    }
  });
  test("generateRequirementsMd sections", () => {
    const md = generateRequirementsMd(SAMPLE_REQUIREMENTS);
    assert.ok(md.includes("## Active"), "has Active section");
    assert.ok(md.includes("## Validated"), "has Validated section");
    assert.ok(md.includes("## Deferred"), "has Deferred section");
    assert.ok(md.includes("## Out of Scope"), "has Out of Scope section");
    assert.ok(md.includes("## Traceability"), "has Traceability section");
    assert.ok(md.includes("## Coverage Summary"), "has Coverage Summary section");
  });
  test("generateRequirementsMd emits empty required sections", () => {
    const activeOnly = SAMPLE_REQUIREMENTS.filter((r) => r.status === "active");
    const md = generateRequirementsMd(activeOnly);
    assert.ok(md.includes("## Active"), "has Active section");
    assert.ok(md.includes("## Validated"), "has empty Validated section");
    assert.ok(md.includes("## Deferred"), "has empty Deferred section");
    assert.ok(md.includes("## Out of Scope"), "has empty Out of Scope section");
  });
  test("generateRequirementsMd empty input", () => {
    const md = generateRequirementsMd([]);
    const parsed = parseRequirementsSections(md);
    assert.deepStrictEqual(parsed.length, 0, "empty requirements produces empty parse");
    assert.ok(md.includes("## Active"), "empty requirements still has Active section");
    assert.ok(md.includes("## Validated"), "empty requirements still has Validated section");
    assert.ok(md.includes("## Deferred"), "empty requirements still has Deferred section");
    assert.ok(md.includes("## Out of Scope"), "empty requirements still has Out of Scope section");
  });
  test("nextDecisionId", async () => {
    openDatabase(":memory:");
    const id1 = await nextDecisionId();
    assert.deepStrictEqual(id1, "D001", "first ID when no decisions exist");
    upsertDecision({
      id: "D001",
      when_context: "M001",
      scope: "test",
      decision: "test decision",
      choice: "test choice",
      rationale: "test",
      revisable: "No",
      made_by: "agent",
      superseded_by: null
    });
    upsertDecision({
      id: "D005",
      when_context: "M001",
      scope: "test",
      decision: "test decision 5",
      choice: "test choice",
      rationale: "test",
      revisable: "No",
      made_by: "agent",
      superseded_by: null
    });
    const id2 = await nextDecisionId();
    assert.deepStrictEqual(id2, "D006", "next ID after D005 is D006");
    closeDatabase();
  });
  test("saveDecisionToDb", async () => {
    const tmpDir = makeTmpDir();
    const dbPath = path.join(tmpDir, ".gsd", "gsd.db");
    openDatabase(dbPath);
    try {
      const result = await saveDecisionToDb({
        scope: "arch",
        decision: "Test decision",
        choice: "Option A",
        rationale: "Best option",
        when_context: "M001"
      }, tmpDir);
      assert.deepStrictEqual(result.id, "D001", "saveDecisionToDb returns D001 as first ID");
      const memoryDecisions = getAllDecisionsFromMemories();
      assert.equal(memoryDecisions.length, 1, "one memory row exists after save");
      const memDecision = memoryDecisions[0];
      assert.ok(memDecision, "memory decision exists after save");
      assert.equal(memDecision.id, "D001");
      assert.equal(memDecision.scope, "arch", "memory decision has correct scope");
      assert.equal(memDecision.choice, "Option A", "memory decision has correct choice");
      const mdPath = path.join(tmpDir, ".gsd", "DECISIONS.md");
      assert.ok(fs.existsSync(mdPath), "DECISIONS.md file created");
      const mdContent = fs.readFileSync(mdPath, "utf-8");
      assert.ok(mdContent.includes("D001"), "DECISIONS.md contains new decision ID");
      assert.ok(mdContent.includes("Test decision"), "DECISIONS.md contains decision text");
      const parsed = parseDecisionsTable(mdContent);
      assert.deepStrictEqual(parsed.length, 1, "written DECISIONS.md parses to 1 decision");
      assert.deepStrictEqual(parsed[0].id, "D001", "parsed decision has correct ID");
      const result2 = await saveDecisionToDb({
        scope: "impl",
        decision: "Second decision",
        choice: "Option B",
        rationale: "Also good"
      }, tmpDir);
      assert.deepStrictEqual(result2.id, "D002", "second decision gets D002");
      const mdContent2 = fs.readFileSync(mdPath, "utf-8");
      const parsed2 = parseDecisionsTable(mdContent2);
      assert.deepStrictEqual(parsed2.length, 2, "DECISIONS.md now has 2 decisions");
    } finally {
      closeDatabase();
      cleanupDir(tmpDir);
    }
  });
  test("parallel saveDecisionToDb calls produce unique IDs", async () => {
    const tmpDir = makeTmpDir();
    const dbPath = path.join(tmpDir, ".gsd", "gsd.db");
    openDatabase(dbPath);
    try {
      const results = await Promise.all([
        saveDecisionToDb({ scope: "a", decision: "d1", choice: "c1", rationale: "r1" }, tmpDir),
        saveDecisionToDb({ scope: "b", decision: "d2", choice: "c2", rationale: "r2" }, tmpDir),
        saveDecisionToDb({ scope: "c", decision: "d3", choice: "c3", rationale: "r3" }, tmpDir),
        saveDecisionToDb({ scope: "d", decision: "d4", choice: "c4", rationale: "r4" }, tmpDir),
        saveDecisionToDb({ scope: "e", decision: "d5", choice: "c5", rationale: "r5" }, tmpDir)
      ]);
      const ids = results.map((r) => r.id);
      const uniqueIds = new Set(ids);
      assert.equal(uniqueIds.size, 5, `Expected 5 unique IDs, got ${uniqueIds.size}: ${ids.join(", ")}`);
      for (const id of ids) {
        assert.match(id, /^D\d{3}$/, `ID ${id} should match D### pattern`);
      }
      const memoryIds = new Set(getAllDecisionsFromMemories().map((d) => d.id));
      for (const id of ids) {
        assert.ok(memoryIds.has(id), `Decision ${id} should exist in memories`);
      }
    } finally {
      closeDatabase();
      cleanupDir(tmpDir);
    }
  });
  test("updateRequirementInDb", async () => {
    const tmpDir = makeTmpDir();
    const dbPath = path.join(tmpDir, ".gsd", "gsd.db");
    openDatabase(dbPath);
    try {
      upsertRequirement({
        id: "R001",
        class: "core-capability",
        status: "active",
        description: "Test requirement",
        why: "Testing",
        source: "test",
        primary_owner: "M001/S01",
        supporting_slices: "none",
        validation: "unmapped",
        notes: "",
        full_content: "",
        superseded_by: null
      });
      await updateRequirementInDb("R001", {
        status: "validated",
        validation: "S01 \u2014 all tests pass",
        notes: "Validated in S01"
      }, tmpDir);
      const updated = getRequirementById("R001");
      assert.ok(!!updated, "requirement still exists after update");
      assert.deepStrictEqual(updated?.status, "validated", "status updated in DB");
      assert.deepStrictEqual(updated?.validation, "S01 \u2014 all tests pass", "validation updated in DB");
      assert.deepStrictEqual(updated?.description, "Test requirement", "description preserved after update");
      const mdPath = path.join(tmpDir, ".gsd", "REQUIREMENTS.md");
      assert.ok(fs.existsSync(mdPath), "REQUIREMENTS.md file created");
      const mdContent = fs.readFileSync(mdPath, "utf-8");
      assert.ok(mdContent.includes("R001"), "REQUIREMENTS.md contains requirement ID");
      assert.ok(mdContent.includes("validated"), "REQUIREMENTS.md shows updated status");
      const parsed = parseRequirementsSections(mdContent);
      assert.deepStrictEqual(parsed.length, 1, "parsed 1 requirement from written file");
      assert.deepStrictEqual(parsed[0].status, "validated", "parsed status matches update");
    } finally {
      closeDatabase();
      cleanupDir(tmpDir);
    }
  });
  test("updateRequirementInDb \u2014 upserts when not found (#2919)", async () => {
    const tmpDir = makeTmpDir();
    const dbPath = path.join(tmpDir, ".gsd", "gsd.db");
    openDatabase(dbPath);
    try {
      await updateRequirementInDb("R999", { status: "validated" }, tmpDir);
      const created = getRequirementById("R999");
      assert.ok(created !== null, "R999 should be created by upsert");
      assert.deepStrictEqual(created.status, "validated", "Upserted requirement should have validated status");
      assert.deepStrictEqual(created.id, "R999", "Upserted requirement should keep the provided ID");
    } finally {
      closeDatabase();
      cleanupDir(tmpDir);
    }
  });
  test("updateRequirementInDb \u2014 ignores REQUIREMENTS.md projection when DB empty", async () => {
    const tmpDir = makeTmpDir();
    const dbPath = path.join(tmpDir, ".gsd", "gsd.db");
    openDatabase(dbPath);
    try {
      const reqContent = [
        "# Requirements",
        "",
        "## Active",
        "",
        "### R005 \u2014 User authentication",
        "- Class: functional",
        "- Why: Users need secure access",
        "- Source: user-research",
        "- Primary owner: M001/S02",
        "",
        "### R007 \u2014 API rate limiting",
        "- Class: non-functional",
        "- Why: Prevent abuse",
        "- Source: architecture",
        "- Primary owner: M001/S03",
        "",
        "## Validated",
        "",
        "### R001 \u2014 Database schema",
        "- Class: functional",
        "- Why: Foundation for storage",
        "- Source: design",
        "- Validation: S01 verified"
      ].join("\n");
      fs.writeFileSync(path.join(tmpDir, ".gsd", "REQUIREMENTS.md"), reqContent);
      await updateRequirementInDb("R005", {
        status: "validated",
        validation: "S02 \u2014 auth flow verified"
      }, tmpDir);
      const r005 = getRequirementById("R005");
      assert.ok(r005, "R005 should exist");
      assert.equal(r005.status, "validated", "status should be updated");
      assert.equal(r005.validation, "S02 \u2014 auth flow verified", "validation should be updated");
      assert.equal(r005.class, "", "class should not be imported from REQUIREMENTS.md");
      assert.ok(!r005.description?.includes("authentication"), "description should not be imported");
      assert.ok(!r005.full_content?.includes("authentication"), "full content should not be imported");
      const r007 = getRequirementById("R007");
      assert.equal(r007, null, "R007 should not be imported from REQUIREMENTS.md");
      const r001 = getRequirementById("R001");
      assert.equal(r001, null, "R001 should not be imported from REQUIREMENTS.md");
    } finally {
      closeDatabase();
      cleanupDir(tmpDir);
    }
  });
  test("saveRequirementToDb is idempotent for repeated descriptions", async () => {
    const tmpDir = makeTmpDir();
    const dbPath = path.join(tmpDir, ".gsd", "gsd.db");
    openDatabase(dbPath);
    try {
      const first = await saveRequirementToDb({
        class: "primary-user-loop",
        status: "active",
        description: "User can add a task by pressing Enter",
        why: "Core capture loop",
        source: "user",
        primary_owner: "M001/none yet",
        supporting_slices: "none",
        validation: "unmapped"
      }, tmpDir);
      const retry = await saveRequirementToDb({
        class: "primary-user-loop",
        status: "active",
        description: "  user CAN add a task by pressing Enter  ",
        why: "Core capture loop, restated on retry",
        source: "user",
        primary_owner: "M001/S01",
        supporting_slices: "none",
        validation: "mapped"
      }, tmpDir);
      assert.deepStrictEqual(retry.id, first.id, "retry save reuses existing requirement ID");
      const adapter = _getAdapter();
      const rows = adapter.prepare("SELECT id, description, primary_owner, validation FROM requirements ORDER BY id").all();
      assert.deepStrictEqual(rows.length, 1, "semantic duplicate does not create a new row");
      assert.deepStrictEqual(rows[0]["id"], "R001");
      assert.deepStrictEqual(rows[0]["primary_owner"], "M001/S01", "retry updates the existing row");
      assert.deepStrictEqual(rows[0]["validation"], "mapped", "retry updates validation");
    } finally {
      closeDatabase();
      cleanupDir(tmpDir);
    }
  });
  test("saveArtifactToDb", async () => {
    const tmpDir = makeTmpDir();
    const dbPath = path.join(tmpDir, ".gsd", "gsd.db");
    openDatabase(dbPath);
    try {
      const content = "# Task Summary\n\nTest content\n";
      await saveArtifactToDb({
        path: "milestones/M001/slices/S06/tasks/T01-SUMMARY.md",
        artifact_type: "SUMMARY",
        content,
        milestone_id: "M001",
        slice_id: "S06",
        task_id: "T01"
      }, tmpDir);
      const adapter = _getAdapter();
      assert.ok(!!adapter, "adapter available");
      const row = adapter.prepare("SELECT * FROM artifacts WHERE path = ?").get("milestones/M001/slices/S06/tasks/T01-SUMMARY.md");
      assert.ok(!!row, "artifact exists in DB");
      assert.deepStrictEqual(row["artifact_type"], "SUMMARY", "artifact type correct in DB");
      assert.deepStrictEqual(row["milestone_id"], "M001", "milestone_id correct in DB");
      assert.deepStrictEqual(row["slice_id"], "S06", "slice_id correct in DB");
      assert.deepStrictEqual(row["task_id"], "T01", "task_id correct in DB");
      const filePath = path.join(
        tmpDir,
        ".gsd",
        "milestones",
        "M001",
        "slices",
        "S06",
        "tasks",
        "T01-SUMMARY.md"
      );
      assert.ok(fs.existsSync(filePath), "artifact file written to disk");
      assert.deepStrictEqual(fs.readFileSync(filePath, "utf-8"), content, "file content matches");
    } finally {
      closeDatabase();
      cleanupDir(tmpDir);
    }
  });
  test("saveArtifactToDb \u2014 shrinkage guard preserves larger existing file", async () => {
    const tmpDir = makeTmpDir();
    const dbPath = path.join(tmpDir, ".gsd", "gsd.db");
    openDatabase(dbPath);
    try {
      const fullContent = "# Full Research\n\n" + "x".repeat(2e4) + "\n";
      const abbreviatedContent = "# Summary\n\nShort version.\n";
      const relPath = "milestones/M001/M001-RESEARCH.md";
      const filePath = path.join(tmpDir, ".gsd", relPath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, fullContent);
      await saveArtifactToDb({
        path: relPath,
        artifact_type: "RESEARCH",
        content: abbreviatedContent,
        milestone_id: "M001"
      }, tmpDir);
      assert.deepStrictEqual(
        fs.readFileSync(filePath, "utf-8"),
        fullContent,
        "disk file preserved \u2014 shrinkage guard prevented overwrite"
      );
      const adapter = _getAdapter();
      const row = adapter.prepare("SELECT full_content FROM artifacts WHERE path = ?").get(relPath);
      assert.deepStrictEqual(
        row["full_content"],
        abbreviatedContent,
        "DB stores caller-provided content instead of importing disk projection content"
      );
    } finally {
      closeDatabase();
      cleanupDir(tmpDir);
    }
  });
  test("saveArtifactToDb \u2014 final REQUIREMENTS renders from DB rows, ignoring caller-supplied markdown", async () => {
    const tmpDir = makeTmpDir();
    const dbPath = path.join(tmpDir, ".gsd", "gsd.db");
    openDatabase(dbPath);
    try {
      const canonicalRequirement = {
        id: "R001",
        class: "primary-user-loop",
        status: "active",
        description: "User can add a task",
        why: "Core loop",
        source: "user",
        primary_owner: "M001/none yet",
        supporting_slices: "none",
        validation: "unmapped",
        notes: "canonical",
        full_content: "",
        superseded_by: null
      };
      upsertRequirement(canonicalRequirement);
      const relPath = "REQUIREMENTS.md";
      const filePath = path.join(tmpDir, ".gsd", relPath);
      const bloatedInvalidContent = [
        "# Requirements",
        "",
        "## Active",
        "",
        ...Array.from({ length: 30 }, (_, i) => [
          `### R${String(i + 1).padStart(3, "0")} \u2014 Duplicate`,
          "- Class: primary-user-loop",
          "- Status: active",
          "- Description: Duplicate retry row",
          "- Why it matters: Retry drift",
          "- Source: test",
          "- Primary owning slice: M001/none yet",
          "- Supporting slices: none",
          "- Validation: unmapped",
          "- Notes:",
          ""
        ].join("\n")),
        "## Traceability",
        "",
        "## Coverage Summary",
        ""
      ].join("\n");
      fs.writeFileSync(filePath, bloatedInvalidContent);
      assert.ok(
        Buffer.byteLength(generateRequirementsMd([canonicalRequirement]), "utf-8") < Buffer.byteLength(bloatedInvalidContent, "utf-8") * 0.5,
        "test setup: DB-rendered content is small enough that the generic shrinkage guard would trigger"
      );
      await saveArtifactToDb({
        path: relPath,
        artifact_type: "REQUIREMENTS",
        content: bloatedInvalidContent
      }, tmpDir);
      const writtenContent = fs.readFileSync(filePath, "utf-8");
      assert.ok(
        writtenContent.includes("R001") && writtenContent.includes("User can add a task"),
        "disk file contains DB-sourced R001 requirement"
      );
      assert.ok(
        !writtenContent.includes("Duplicate retry row"),
        "disk file does not contain caller-supplied bloated content"
      );
      const adapter = _getAdapter();
      const reqRows = adapter.prepare("SELECT id, description FROM requirements ORDER BY id").all();
      assert.deepStrictEqual(
        reqRows.map((row) => [row["id"], row["description"]]),
        [["R001", "User can add a task"]],
        "artifact save does not parse markdown back into the requirements table"
      );
      const artifact = adapter.prepare("SELECT full_content FROM artifacts WHERE path = ?").get(relPath);
      const storedContent = artifact["full_content"];
      assert.ok(
        storedContent.includes("R001") && storedContent.includes("User can add a task"),
        "artifacts.full_content is DB-rendered output containing R001"
      );
      assert.ok(
        !storedContent.includes("Duplicate retry row"),
        "artifacts.full_content does not echo caller-supplied markdown payload"
      );
    } finally {
      closeDatabase();
      cleanupDir(tmpDir);
    }
  });
  test("saveArtifactToDb \u2014 allows overwrite when new content is similar size", async () => {
    const tmpDir = makeTmpDir();
    const dbPath = path.join(tmpDir, ".gsd", "gsd.db");
    openDatabase(dbPath);
    try {
      const oldContent = "# Summary v1\n\nOriginal content here.\n";
      const newContent = "# Summary v2\n\nUpdated content here with more details.\n";
      const relPath = "milestones/M001/M001-SUMMARY.md";
      const filePath = path.join(tmpDir, ".gsd", relPath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, oldContent);
      await saveArtifactToDb({
        path: relPath,
        artifact_type: "SUMMARY",
        content: newContent,
        milestone_id: "M001"
      }, tmpDir);
      assert.deepStrictEqual(
        fs.readFileSync(filePath, "utf-8"),
        newContent,
        "disk file updated when new content is similar size"
      );
    } finally {
      closeDatabase();
      cleanupDir(tmpDir);
    }
  });
  test("Full DB round-trip: decisions", () => {
    openDatabase(":memory:");
    for (const d of SAMPLE_DECISIONS) {
      upsertDecision({
        id: d.id,
        when_context: d.when_context,
        scope: d.scope,
        decision: d.decision,
        choice: d.choice,
        rationale: d.rationale,
        revisable: d.revisable,
        made_by: d.made_by,
        superseded_by: d.superseded_by
      });
    }
    const adapter = _getAdapter();
    const rows = adapter.prepare("SELECT * FROM decisions ORDER BY seq").all();
    const dbDecisions = rows.map((row) => ({
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
    }));
    const md = generateDecisionsMd(dbDecisions);
    const parsed = parseDecisionsTable(md);
    assert.deepStrictEqual(parsed.length, SAMPLE_DECISIONS.length, "DB round-trip decision count");
    for (const orig of SAMPLE_DECISIONS) {
      const rt = parsed.find((p) => p.id === orig.id);
      assert.ok(!!rt, `DB round-trip: ${orig.id} found`);
      if (rt) {
        assert.deepStrictEqual(rt.scope, orig.scope, `DB round-trip: ${orig.id} scope`);
        assert.deepStrictEqual(rt.choice, orig.choice, `DB round-trip: ${orig.id} choice`);
      }
    }
    closeDatabase();
  });
  test("Full DB round-trip: requirements", () => {
    openDatabase(":memory:");
    for (const r of SAMPLE_REQUIREMENTS) {
      upsertRequirement(r);
    }
    const adapter = _getAdapter();
    const rows = adapter.prepare("SELECT * FROM requirements ORDER BY id").all();
    const dbReqs = rows.map((row) => ({
      id: row["id"],
      class: row["class"],
      status: row["status"],
      description: row["description"],
      why: row["why"],
      source: row["source"],
      primary_owner: row["primary_owner"],
      supporting_slices: row["supporting_slices"],
      validation: row["validation"],
      notes: row["notes"],
      full_content: row["full_content"],
      superseded_by: row["superseded_by"] ?? null
    }));
    const md = generateRequirementsMd(dbReqs);
    const parsed = parseRequirementsSections(md);
    assert.deepStrictEqual(parsed.length, SAMPLE_REQUIREMENTS.length, "DB round-trip requirement count");
    for (const orig of SAMPLE_REQUIREMENTS) {
      const rt = parsed.find((p) => p.id === orig.id);
      assert.ok(!!rt, `DB round-trip: ${orig.id} found`);
      if (rt) {
        assert.deepStrictEqual(rt.class, orig.class, `DB round-trip: ${orig.id} class`);
        assert.deepStrictEqual(rt.description, orig.description, `DB round-trip: ${orig.id} description`);
      }
    }
    closeDatabase();
  });
  describe("extractDeferredSliceRef", () => {
    const fields = (scope, choice, decision) => ({
      scope,
      choice,
      decision
    });
    test("detects deferral in scope with M###/S## pattern in choice", () => {
      const result = extractDeferredSliceRef(
        fields("deferral of low-priority work", "Move M001/S03 to backlog", "")
      );
      assert.deepStrictEqual(result, { milestoneId: "M001", sliceId: "S03" });
    });
    test("detects deferral in choice field", () => {
      const result = extractDeferredSliceRef(
        fields("slice prioritization", "defer M002/S01 until next sprint", "")
      );
      assert.deepStrictEqual(result, { milestoneId: "M002", sliceId: "S01" });
    });
    test("detects deferral in decision field", () => {
      const result = extractDeferredSliceRef(
        fields("resource constraints", "", "deferred M010/S12 pending review")
      );
      assert.deepStrictEqual(result, { milestoneId: "M010", sliceId: "S12" });
    });
    test("returns null when no M###/S## pattern is present", () => {
      const result = extractDeferredSliceRef(
        fields("deferral of work", "will revisit later", "deferred indefinitely")
      );
      assert.strictEqual(result, null);
    });
    test('recognises "deferring" variant', () => {
      const result = extractDeferredSliceRef(
        fields("deferring this slice", "M005/S02 can wait", "")
      );
      assert.deepStrictEqual(result, { milestoneId: "M005", sliceId: "S02" });
    });
    test('recognises "defers" variant', () => {
      const result = extractDeferredSliceRef(
        fields("team defers slice", "M100/S10 not urgent", "")
      );
      assert.deepStrictEqual(result, { milestoneId: "M100", sliceId: "S10" });
    });
    test("returns first M###/S## match when multiple patterns exist", () => {
      const result = extractDeferredSliceRef(
        fields("", "defer M003/S01 and M003/S02", "")
      );
      assert.deepStrictEqual(result, { milestoneId: "M003", sliceId: "S01" });
    });
    test("returns null when no deferral keyword is present", () => {
      const result = extractDeferredSliceRef(
        fields("approved work", "M001/S01 is ready", "proceed with M001/S01")
      );
      assert.strictEqual(result, null);
    });
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9kYi13cml0ZXIudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QgfSBmcm9tICdub2RlOnRlc3QnO1xuaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydC9zdHJpY3QnO1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tICdub2RlOnBhdGgnO1xuaW1wb3J0ICogYXMgb3MgZnJvbSAnbm9kZTpvcyc7XG5pbXBvcnQgKiBhcyBmcyBmcm9tICdub2RlOmZzJztcbmltcG9ydCB7XG4gIG9wZW5EYXRhYmFzZSxcbiAgY2xvc2VEYXRhYmFzZSxcbiAgdXBzZXJ0RGVjaXNpb24sXG4gIHVwc2VydFJlcXVpcmVtZW50LFxuICBpbnNlcnRBcnRpZmFjdCxcbiAgZ2V0RGVjaXNpb25CeUlkLFxuICBnZXRSZXF1aXJlbWVudEJ5SWQsXG4gIF9nZXRBZGFwdGVyLFxufSBmcm9tICcuLi9nc2QtZGIudHMnO1xuaW1wb3J0IHtcbiAgcGFyc2VEZWNpc2lvbnNUYWJsZSxcbiAgcGFyc2VSZXF1aXJlbWVudHNTZWN0aW9ucyxcbn0gZnJvbSAnLi4vbWQtaW1wb3J0ZXIudHMnO1xuaW1wb3J0IHtcbiAgZ2VuZXJhdGVEZWNpc2lvbnNNZCxcbiAgZ2VuZXJhdGVSZXF1aXJlbWVudHNNZCxcbiAgbmV4dERlY2lzaW9uSWQsXG4gIHNhdmVEZWNpc2lvblRvRGIsXG4gIHNhdmVSZXF1aXJlbWVudFRvRGIsXG4gIHVwZGF0ZVJlcXVpcmVtZW50SW5EYixcbiAgc2F2ZUFydGlmYWN0VG9EYixcbiAgZXh0cmFjdERlZmVycmVkU2xpY2VSZWYsXG59IGZyb20gJy4uL2RiLXdyaXRlci50cyc7XG5pbXBvcnQgeyBnZXRBbGxEZWNpc2lvbnNGcm9tTWVtb3JpZXMgfSBmcm9tICcuLi9jb250ZXh0LXN0b3JlLnRzJztcbmltcG9ydCB0eXBlIHsgRGVjaXNpb24sIFJlcXVpcmVtZW50IH0gZnJvbSAnLi4vdHlwZXMudHMnO1xuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIEhlbHBlcnNcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG5mdW5jdGlvbiBtYWtlVG1wRGlyKCk6IHN0cmluZyB7XG4gIGNvbnN0IGRpciA9IGZzLm1rZHRlbXBTeW5jKHBhdGguam9pbihvcy50bXBkaXIoKSwgJ2dzZC1kYndyaXRlci0nKSk7XG4gIC8vIENyZWF0ZSAuZ3NkIGRpcmVjdG9yeSBzdHJ1Y3R1cmVcbiAgZnMubWtkaXJTeW5jKHBhdGguam9pbihkaXIsICcuZ3NkJyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICByZXR1cm4gZGlyO1xufVxuXG5mdW5jdGlvbiBjbGVhbnVwRGlyKGRpcjogc3RyaW5nKTogdm9pZCB7XG4gIHRyeSB7XG4gICAgZnMucm1TeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9IGNhdGNoIHsgLyogc3dhbGxvdyAqLyB9XG59XG5cbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuLy8gVGVzdCBGaXh0dXJlc1xuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbmNvbnN0IFNBTVBMRV9ERUNJU0lPTlM6IERlY2lzaW9uW10gPSBbXG4gIHtcbiAgICBzZXE6IDEsXG4gICAgaWQ6ICdEMDAxJyxcbiAgICB3aGVuX2NvbnRleHQ6ICdNMDAxJyxcbiAgICBzY29wZTogJ2xpYnJhcnknLFxuICAgIGRlY2lzaW9uOiAnU1FMaXRlIGxpYnJhcnknLFxuICAgIGNob2ljZTogJ2JldHRlci1zcWxpdGUzJyxcbiAgICByYXRpb25hbGU6ICdTeW5jIEFQSScsXG4gICAgcmV2aXNhYmxlOiAnTm8nLFxuICAgIG1hZGVfYnk6ICdjb2xsYWJvcmF0aXZlJyxcbiAgICBzdXBlcnNlZGVkX2J5OiBudWxsLFxuICB9LFxuICB7XG4gICAgc2VxOiAyLFxuICAgIGlkOiAnRDAwMicsXG4gICAgd2hlbl9jb250ZXh0OiAnTTAwMScsXG4gICAgc2NvcGU6ICdhcmNoJyxcbiAgICBkZWNpc2lvbjogJ0RCIGxvY2F0aW9uJyxcbiAgICBjaG9pY2U6ICcuZ3NkL2dzZC5kYicsXG4gICAgcmF0aW9uYWxlOiAnRGVyaXZlZCBzdGF0ZScsXG4gICAgcmV2aXNhYmxlOiAnTm8nLFxuICAgIG1hZGVfYnk6ICdhZ2VudCcsXG4gICAgc3VwZXJzZWRlZF9ieTogbnVsbCxcbiAgfSxcbiAge1xuICAgIHNlcTogMyxcbiAgICBpZDogJ0QwMDMnLFxuICAgIHdoZW5fY29udGV4dDogJ00wMDEvUzAxJyxcbiAgICBzY29wZTogJ2ltcGwnLFxuICAgIGRlY2lzaW9uOiAnUHJvdmlkZXIgc3RyYXRlZ3kgKGFtZW5kcyBEMDAxKScsXG4gICAgY2hvaWNlOiAnbm9kZTpzcWxpdGUgZmFsbGJhY2snLFxuICAgIHJhdGlvbmFsZTogJ1plcm8gZGVwcycsXG4gICAgcmV2aXNhYmxlOiAnWWVzJyxcbiAgICBtYWRlX2J5OiAnaHVtYW4nLFxuICAgIHN1cGVyc2VkZWRfYnk6IG51bGwsXG4gIH0sXG5dO1xuXG5jb25zdCBTQU1QTEVfUkVRVUlSRU1FTlRTOiBSZXF1aXJlbWVudFtdID0gW1xuICB7XG4gICAgaWQ6ICdSMDAxJyxcbiAgICBjbGFzczogJ2NvcmUtY2FwYWJpbGl0eScsXG4gICAgc3RhdHVzOiAnYWN0aXZlJyxcbiAgICBkZXNjcmlwdGlvbjogJ0EgU1FMaXRlIGRhdGFiYXNlIHdpdGggdHlwZWQgd3JhcHBlcnMnLFxuICAgIHdoeTogJ0ZvdW5kYXRpb24gZm9yIHN0b3JhZ2UnLFxuICAgIHNvdXJjZTogJ3VzZXInLFxuICAgIHByaW1hcnlfb3duZXI6ICdNMDAxL1MwMScsXG4gICAgc3VwcG9ydGluZ19zbGljZXM6ICdub25lJyxcbiAgICB2YWxpZGF0aW9uOiAnUzAxIHZlcmlmaWVkJyxcbiAgICBub3RlczogJ1dBTCBtb2RlIGVuYWJsZWQnLFxuICAgIGZ1bGxfY29udGVudDogJycsXG4gICAgc3VwZXJzZWRlZF9ieTogbnVsbCxcbiAgfSxcbiAge1xuICAgIGlkOiAnUjAwMicsXG4gICAgY2xhc3M6ICdmYWlsdXJlLXZpc2liaWxpdHknLFxuICAgIHN0YXR1czogJ3ZhbGlkYXRlZCcsXG4gICAgZGVzY3JpcHRpb246ICdGYWxscyBiYWNrIHRvIG1hcmtkb3duIGlmIFNRTGl0ZSB1bmF2YWlsYWJsZScsXG4gICAgd2h5OiAnTXVzdCBub3QgYnJlYWsgb24gZXhvdGljIHBsYXRmb3JtcycsXG4gICAgc291cmNlOiAndXNlcicsXG4gICAgcHJpbWFyeV9vd25lcjogJ00wMDEvUzAxJyxcbiAgICBzdXBwb3J0aW5nX3NsaWNlczogJ00wMDEvUzAzJyxcbiAgICB2YWxpZGF0aW9uOiAnUzAzIHZhbGlkYXRlZCcsXG4gICAgbm90ZXM6ICdUcmFuc3BhcmVudCBmYWxsYmFjaycsXG4gICAgZnVsbF9jb250ZW50OiAnJyxcbiAgICBzdXBlcnNlZGVkX2J5OiBudWxsLFxuICB9LFxuICB7XG4gICAgaWQ6ICdSMDMwJyxcbiAgICBjbGFzczogJ2RpZmZlcmVudGlhdG9yJyxcbiAgICBzdGF0dXM6ICdkZWZlcnJlZCcsXG4gICAgZGVzY3JpcHRpb246ICdWZWN0b3Igc2VhcmNoIHN1cHBvcnQnLFxuICAgIHdoeTogJ1NlbWFudGljIHJldHJpZXZhbCcsXG4gICAgc291cmNlOiAndXNlcicsXG4gICAgcHJpbWFyeV9vd25lcjogJ25vbmUnLFxuICAgIHN1cHBvcnRpbmdfc2xpY2VzOiAnbm9uZScsXG4gICAgdmFsaWRhdGlvbjogJ3VubWFwcGVkJyxcbiAgICBub3RlczogJ0RlZmVycmVkIHRvIE0wMDInLFxuICAgIGZ1bGxfY29udGVudDogJycsXG4gICAgc3VwZXJzZWRlZF9ieTogbnVsbCxcbiAgfSxcbiAge1xuICAgIGlkOiAnUjA0MCcsXG4gICAgY2xhc3M6ICdhbnRpLWZlYXR1cmUnLFxuICAgIHN0YXR1czogJ291dC1vZi1zY29wZScsXG4gICAgZGVzY3JpcHRpb246ICdHVUkgZGFzaGJvYXJkJyxcbiAgICB3aHk6ICdDTEktZmlyc3QgZGVzaWduJyxcbiAgICBzb3VyY2U6ICd1c2VyJyxcbiAgICBwcmltYXJ5X293bmVyOiAnbm9uZScsXG4gICAgc3VwcG9ydGluZ19zbGljZXM6ICdub25lJyxcbiAgICB2YWxpZGF0aW9uOiAnJyxcbiAgICBub3RlczogJycsXG4gICAgZnVsbF9jb250ZW50OiAnJyxcbiAgICBzdXBlcnNlZGVkX2J5OiBudWxsLFxuICB9LFxuXTtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBSb3VuZC1UcmlwIFRlc3RzOiBEZWNpc2lvbnNcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG5kZXNjcmliZSgnZGItd3JpdGVyJywgKCkgPT4ge1xuICB0ZXN0KCdnZW5lcmF0ZURlY2lzaW9uc01kIHJvdW5kLXRyaXAnLCAoKSA9PiB7XG4gICAgY29uc3QgbWQgPSBnZW5lcmF0ZURlY2lzaW9uc01kKFNBTVBMRV9ERUNJU0lPTlMpO1xuICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlRGVjaXNpb25zVGFibGUobWQpO1xuXG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwYXJzZWQubGVuZ3RoLCBTQU1QTEVfREVDSVNJT05TLmxlbmd0aCwgJ2RlY2lzaW9ucyBjb3VudCBtYXRjaGVzJyk7XG5cbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IFNBTVBMRV9ERUNJU0lPTlMubGVuZ3RoOyBpKyspIHtcbiAgICAgIGNvbnN0IG9yaWcgPSBTQU1QTEVfREVDSVNJT05TW2ldO1xuICAgICAgY29uc3QgcnQgPSBwYXJzZWRbaV07XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJ0LmlkLCBvcmlnLmlkLCBgZGVjaXNpb24gJHtvcmlnLmlkfSBpZCByb3VuZC10cmlwc2ApO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChydC53aGVuX2NvbnRleHQsIG9yaWcud2hlbl9jb250ZXh0LCBgZGVjaXNpb24gJHtvcmlnLmlkfSB3aGVuX2NvbnRleHQgcm91bmQtdHJpcHNgKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocnQuc2NvcGUsIG9yaWcuc2NvcGUsIGBkZWNpc2lvbiAke29yaWcuaWR9IHNjb3BlIHJvdW5kLXRyaXBzYCk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJ0LmRlY2lzaW9uLCBvcmlnLmRlY2lzaW9uLCBgZGVjaXNpb24gJHtvcmlnLmlkfSBkZWNpc2lvbiByb3VuZC10cmlwc2ApO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChydC5jaG9pY2UsIG9yaWcuY2hvaWNlLCBgZGVjaXNpb24gJHtvcmlnLmlkfSBjaG9pY2Ugcm91bmQtdHJpcHNgKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocnQucmF0aW9uYWxlLCBvcmlnLnJhdGlvbmFsZSwgYGRlY2lzaW9uICR7b3JpZy5pZH0gcmF0aW9uYWxlIHJvdW5kLXRyaXBzYCk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJ0LnJldmlzYWJsZSwgb3JpZy5yZXZpc2FibGUsIGBkZWNpc2lvbiAke29yaWcuaWR9IHJldmlzYWJsZSByb3VuZC10cmlwc2ApO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChydC5tYWRlX2J5LCBvcmlnLm1hZGVfYnksIGBkZWNpc2lvbiAke29yaWcuaWR9IG1hZGVfYnkgcm91bmQtdHJpcHNgKTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoJ2dlbmVyYXRlRGVjaXNpb25zTWQgZm9ybWF0JywgKCkgPT4ge1xuICAgIGNvbnN0IG1kID0gZ2VuZXJhdGVEZWNpc2lvbnNNZChTQU1QTEVfREVDSVNJT05TKTtcbiAgICBhc3NlcnQub2sobWQuc3RhcnRzV2l0aCgnIyBEZWNpc2lvbnMgUmVnaXN0ZXJcXG4nKSwgJ3N0YXJ0cyB3aXRoIEgxIGhlYWRlcicpO1xuICAgIGFzc2VydC5vayhtZC5pbmNsdWRlcygnPCEtLSBBcHBlbmQtb25seScpLCAnY29udGFpbnMgSFRNTCBjb21tZW50IGJsb2NrJyk7XG4gICAgYXNzZXJ0Lm9rKG1kLmluY2x1ZGVzKCd8ICMgfCBXaGVuIHwgU2NvcGUnKSwgJ2NvbnRhaW5zIHRhYmxlIGhlYWRlcicpO1xuICAgIGFzc2VydC5vayhtZC5pbmNsdWRlcygnfC0tLXwtLS0tLS18LS0tLS0tLScpLCAnY29udGFpbnMgc2VwYXJhdG9yIHJvdycpO1xuICAgIGFzc2VydC5vayhtZC5pbmNsdWRlcygnfCBNYWRlIEJ5IHwnKSwgJ2NvbnRhaW5zIE1hZGUgQnkgY29sdW1uIGhlYWRlcicpO1xuICB9KTtcblxuICB0ZXN0KCdnZW5lcmF0ZURlY2lzaW9uc01kIGVtcHR5IGlucHV0JywgKCkgPT4ge1xuICAgIGNvbnN0IG1kID0gZ2VuZXJhdGVEZWNpc2lvbnNNZChbXSk7XG4gICAgY29uc3QgcGFyc2VkID0gcGFyc2VEZWNpc2lvbnNUYWJsZShtZCk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwYXJzZWQubGVuZ3RoLCAwLCAnZW1wdHkgZGVjaXNpb25zIHByb2R1Y2VzIGVtcHR5IHBhcnNlJyk7XG4gICAgYXNzZXJ0Lm9rKG1kLmluY2x1ZGVzKCd8ICMgfCBXaGVuIHwgU2NvcGUnKSwgJ3N0aWxsIGhhcyB0YWJsZSBoZWFkZXIgZXZlbiB3aGVuIGVtcHR5Jyk7XG4gIH0pO1xuXG4gIHRlc3QoJ2dlbmVyYXRlRGVjaXNpb25zTWQgcGlwZSBlc2NhcGluZycsICgpID0+IHtcbiAgICBjb25zdCB3aXRoUGlwZTogRGVjaXNpb24gPSB7XG4gICAgICBzZXE6IDEsXG4gICAgICBpZDogJ0QwMDEnLFxuICAgICAgd2hlbl9jb250ZXh0OiAnTTAwMScsXG4gICAgICBzY29wZTogJ2FyY2gnLFxuICAgICAgZGVjaXNpb246ICdDaG9pY2UgQSB8IENob2ljZSBCIGNvbXBhcmlzb24nLFxuICAgICAgY2hvaWNlOiAnQScsXG4gICAgICByYXRpb25hbGU6ICdCZXR0ZXInLFxuICAgICAgcmV2aXNhYmxlOiAnTm8nLFxuICAgICAgbWFkZV9ieTogJ2FnZW50JyxcbiAgICAgIHN1cGVyc2VkZWRfYnk6IG51bGwsXG4gICAgfTtcbiAgICBjb25zdCBtZCA9IGdlbmVyYXRlRGVjaXNpb25zTWQoW3dpdGhQaXBlXSk7XG4gICAgLy8gU2hvdWxkIG5vdCBicmVhayB0aGUgdGFibGUgXHUyMDE0IHBpcGUgaW4gZGVjaXNpb24gdGV4dCBzaG91bGQgYmUgZXNjYXBlZFxuICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlRGVjaXNpb25zVGFibGUobWQpO1xuICAgIGFzc2VydC5vayhwYXJzZWQubGVuZ3RoID49IDEsICdwaXBlLWNvbnRhaW5pbmcgZGVjaXNpb24gcGFyc2VzIHdpdGhvdXQgYnJlYWtpbmcgdGFibGUnKTtcbiAgfSk7XG5cbiAgLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4gIC8vIFJvdW5kLVRyaXAgVGVzdHM6IFJlcXVpcmVtZW50c1xuICAvLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuICB0ZXN0KCdnZW5lcmF0ZVJlcXVpcmVtZW50c01kIHJvdW5kLXRyaXAnLCAoKSA9PiB7XG4gICAgY29uc3QgbWQgPSBnZW5lcmF0ZVJlcXVpcmVtZW50c01kKFNBTVBMRV9SRVFVSVJFTUVOVFMpO1xuICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlUmVxdWlyZW1lbnRzU2VjdGlvbnMobWQpO1xuXG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwYXJzZWQubGVuZ3RoLCBTQU1QTEVfUkVRVUlSRU1FTlRTLmxlbmd0aCwgJ3JlcXVpcmVtZW50cyBjb3VudCBtYXRjaGVzJyk7XG5cbiAgICBmb3IgKGNvbnN0IG9yaWcgb2YgU0FNUExFX1JFUVVJUkVNRU5UUykge1xuICAgICAgY29uc3QgcnQgPSBwYXJzZWQuZmluZChyID0+IHIuaWQgPT09IG9yaWcuaWQpO1xuICAgICAgYXNzZXJ0Lm9rKCEhcnQsIGByZXF1aXJlbWVudCAke29yaWcuaWR9IGZvdW5kIGluIHBhcnNlZCBvdXRwdXRgKTtcbiAgICAgIGlmIChydCkge1xuICAgICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJ0LmNsYXNzLCBvcmlnLmNsYXNzLCBgcmVxdWlyZW1lbnQgJHtvcmlnLmlkfSBjbGFzcyByb3VuZC10cmlwc2ApO1xuICAgICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJ0LmRlc2NyaXB0aW9uLCBvcmlnLmRlc2NyaXB0aW9uLCBgcmVxdWlyZW1lbnQgJHtvcmlnLmlkfSBkZXNjcmlwdGlvbiByb3VuZC10cmlwc2ApO1xuICAgICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJ0LndoeSwgb3JpZy53aHksIGByZXF1aXJlbWVudCAke29yaWcuaWR9IHdoeSByb3VuZC10cmlwc2ApO1xuICAgICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJ0LnNvdXJjZSwgb3JpZy5zb3VyY2UsIGByZXF1aXJlbWVudCAke29yaWcuaWR9IHNvdXJjZSByb3VuZC10cmlwc2ApO1xuICAgICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJ0LnByaW1hcnlfb3duZXIsIG9yaWcucHJpbWFyeV9vd25lciwgYHJlcXVpcmVtZW50ICR7b3JpZy5pZH0gcHJpbWFyeV9vd25lciByb3VuZC10cmlwc2ApO1xuICAgICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJ0LnN1cHBvcnRpbmdfc2xpY2VzLCBvcmlnLnN1cHBvcnRpbmdfc2xpY2VzLCBgcmVxdWlyZW1lbnQgJHtvcmlnLmlkfSBzdXBwb3J0aW5nX3NsaWNlcyByb3VuZC10cmlwc2ApO1xuICAgICAgICBpZiAob3JpZy5ub3Rlcykge1xuICAgICAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocnQubm90ZXMsIG9yaWcubm90ZXMsIGByZXF1aXJlbWVudCAke29yaWcuaWR9IG5vdGVzIHJvdW5kLXRyaXBzYCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoJ2dlbmVyYXRlUmVxdWlyZW1lbnRzTWQgc2VjdGlvbnMnLCAoKSA9PiB7XG4gICAgY29uc3QgbWQgPSBnZW5lcmF0ZVJlcXVpcmVtZW50c01kKFNBTVBMRV9SRVFVSVJFTUVOVFMpO1xuICAgIGFzc2VydC5vayhtZC5pbmNsdWRlcygnIyMgQWN0aXZlJyksICdoYXMgQWN0aXZlIHNlY3Rpb24nKTtcbiAgICBhc3NlcnQub2sobWQuaW5jbHVkZXMoJyMjIFZhbGlkYXRlZCcpLCAnaGFzIFZhbGlkYXRlZCBzZWN0aW9uJyk7XG4gICAgYXNzZXJ0Lm9rKG1kLmluY2x1ZGVzKCcjIyBEZWZlcnJlZCcpLCAnaGFzIERlZmVycmVkIHNlY3Rpb24nKTtcbiAgICBhc3NlcnQub2sobWQuaW5jbHVkZXMoJyMjIE91dCBvZiBTY29wZScpLCAnaGFzIE91dCBvZiBTY29wZSBzZWN0aW9uJyk7XG4gICAgYXNzZXJ0Lm9rKG1kLmluY2x1ZGVzKCcjIyBUcmFjZWFiaWxpdHknKSwgJ2hhcyBUcmFjZWFiaWxpdHkgc2VjdGlvbicpO1xuICAgIGFzc2VydC5vayhtZC5pbmNsdWRlcygnIyMgQ292ZXJhZ2UgU3VtbWFyeScpLCAnaGFzIENvdmVyYWdlIFN1bW1hcnkgc2VjdGlvbicpO1xuICB9KTtcblxuICB0ZXN0KCdnZW5lcmF0ZVJlcXVpcmVtZW50c01kIGVtaXRzIGVtcHR5IHJlcXVpcmVkIHNlY3Rpb25zJywgKCkgPT4ge1xuICAgIC8vIE9ubHkgYWN0aXZlIHJlcXVpcmVtZW50cywgYnV0IGRlZXAtbW9kZSB2YWxpZGF0aW9uIHJlcXVpcmVzIGFsbCBzZWN0aW9ucy5cbiAgICBjb25zdCBhY3RpdmVPbmx5ID0gU0FNUExFX1JFUVVJUkVNRU5UUy5maWx0ZXIociA9PiByLnN0YXR1cyA9PT0gJ2FjdGl2ZScpO1xuICAgIGNvbnN0IG1kID0gZ2VuZXJhdGVSZXF1aXJlbWVudHNNZChhY3RpdmVPbmx5KTtcbiAgICBhc3NlcnQub2sobWQuaW5jbHVkZXMoJyMjIEFjdGl2ZScpLCAnaGFzIEFjdGl2ZSBzZWN0aW9uJyk7XG4gICAgYXNzZXJ0Lm9rKG1kLmluY2x1ZGVzKCcjIyBWYWxpZGF0ZWQnKSwgJ2hhcyBlbXB0eSBWYWxpZGF0ZWQgc2VjdGlvbicpO1xuICAgIGFzc2VydC5vayhtZC5pbmNsdWRlcygnIyMgRGVmZXJyZWQnKSwgJ2hhcyBlbXB0eSBEZWZlcnJlZCBzZWN0aW9uJyk7XG4gICAgYXNzZXJ0Lm9rKG1kLmluY2x1ZGVzKCcjIyBPdXQgb2YgU2NvcGUnKSwgJ2hhcyBlbXB0eSBPdXQgb2YgU2NvcGUgc2VjdGlvbicpO1xuICB9KTtcblxuICB0ZXN0KCdnZW5lcmF0ZVJlcXVpcmVtZW50c01kIGVtcHR5IGlucHV0JywgKCkgPT4ge1xuICAgIGNvbnN0IG1kID0gZ2VuZXJhdGVSZXF1aXJlbWVudHNNZChbXSk7XG4gICAgY29uc3QgcGFyc2VkID0gcGFyc2VSZXF1aXJlbWVudHNTZWN0aW9ucyhtZCk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwYXJzZWQubGVuZ3RoLCAwLCAnZW1wdHkgcmVxdWlyZW1lbnRzIHByb2R1Y2VzIGVtcHR5IHBhcnNlJyk7XG4gICAgYXNzZXJ0Lm9rKG1kLmluY2x1ZGVzKCcjIyBBY3RpdmUnKSwgJ2VtcHR5IHJlcXVpcmVtZW50cyBzdGlsbCBoYXMgQWN0aXZlIHNlY3Rpb24nKTtcbiAgICBhc3NlcnQub2sobWQuaW5jbHVkZXMoJyMjIFZhbGlkYXRlZCcpLCAnZW1wdHkgcmVxdWlyZW1lbnRzIHN0aWxsIGhhcyBWYWxpZGF0ZWQgc2VjdGlvbicpO1xuICAgIGFzc2VydC5vayhtZC5pbmNsdWRlcygnIyMgRGVmZXJyZWQnKSwgJ2VtcHR5IHJlcXVpcmVtZW50cyBzdGlsbCBoYXMgRGVmZXJyZWQgc2VjdGlvbicpO1xuICAgIGFzc2VydC5vayhtZC5pbmNsdWRlcygnIyMgT3V0IG9mIFNjb3BlJyksICdlbXB0eSByZXF1aXJlbWVudHMgc3RpbGwgaGFzIE91dCBvZiBTY29wZSBzZWN0aW9uJyk7XG4gIH0pO1xuXG4gIC8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuICAvLyBuZXh0RGVjaXNpb25JZCBUZXN0c1xuICAvLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuICB0ZXN0KCduZXh0RGVjaXNpb25JZCcsIGFzeW5jICgpID0+IHtcbiAgICAvLyBPcGVuIGluLW1lbW9yeSBEQlxuICAgIG9wZW5EYXRhYmFzZSgnOm1lbW9yeTonKTtcblxuICAgIGNvbnN0IGlkMSA9IGF3YWl0IG5leHREZWNpc2lvbklkKCk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChpZDEsICdEMDAxJywgJ2ZpcnN0IElEIHdoZW4gbm8gZGVjaXNpb25zIGV4aXN0Jyk7XG5cbiAgICAvLyBJbnNlcnQgc29tZSBkZWNpc2lvbnNcbiAgICB1cHNlcnREZWNpc2lvbih7XG4gICAgICBpZDogJ0QwMDEnLFxuICAgICAgd2hlbl9jb250ZXh0OiAnTTAwMScsXG4gICAgICBzY29wZTogJ3Rlc3QnLFxuICAgICAgZGVjaXNpb246ICd0ZXN0IGRlY2lzaW9uJyxcbiAgICAgIGNob2ljZTogJ3Rlc3QgY2hvaWNlJyxcbiAgICAgIHJhdGlvbmFsZTogJ3Rlc3QnLFxuICAgICAgcmV2aXNhYmxlOiAnTm8nLFxuICAgICAgbWFkZV9ieTogJ2FnZW50JyxcbiAgICAgIHN1cGVyc2VkZWRfYnk6IG51bGwsXG4gICAgfSk7XG4gICAgdXBzZXJ0RGVjaXNpb24oe1xuICAgICAgaWQ6ICdEMDA1JyxcbiAgICAgIHdoZW5fY29udGV4dDogJ00wMDEnLFxuICAgICAgc2NvcGU6ICd0ZXN0JyxcbiAgICAgIGRlY2lzaW9uOiAndGVzdCBkZWNpc2lvbiA1JyxcbiAgICAgIGNob2ljZTogJ3Rlc3QgY2hvaWNlJyxcbiAgICAgIHJhdGlvbmFsZTogJ3Rlc3QnLFxuICAgICAgcmV2aXNhYmxlOiAnTm8nLFxuICAgICAgbWFkZV9ieTogJ2FnZW50JyxcbiAgICAgIHN1cGVyc2VkZWRfYnk6IG51bGwsXG4gICAgfSk7XG5cbiAgICBjb25zdCBpZDIgPSBhd2FpdCBuZXh0RGVjaXNpb25JZCgpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoaWQyLCAnRDAwNicsICduZXh0IElEIGFmdGVyIEQwMDUgaXMgRDAwNicpO1xuXG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICB9KTtcblxuICAvLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbiAgLy8gc2F2ZURlY2lzaW9uVG9EYiBUZXN0c1xuICAvLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuICB0ZXN0KCdzYXZlRGVjaXNpb25Ub0RiJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHRtcERpciA9IG1ha2VUbXBEaXIoKTtcbiAgICBjb25zdCBkYlBhdGggPSBwYXRoLmpvaW4odG1wRGlyLCAnLmdzZCcsICdnc2QuZGInKTtcbiAgICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBzYXZlRGVjaXNpb25Ub0RiKHtcbiAgICAgICAgc2NvcGU6ICdhcmNoJyxcbiAgICAgICAgZGVjaXNpb246ICdUZXN0IGRlY2lzaW9uJyxcbiAgICAgICAgY2hvaWNlOiAnT3B0aW9uIEEnLFxuICAgICAgICByYXRpb25hbGU6ICdCZXN0IG9wdGlvbicsXG4gICAgICAgIHdoZW5fY29udGV4dDogJ00wMDEnLFxuICAgICAgfSwgdG1wRGlyKTtcblxuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQuaWQsICdEMDAxJywgJ3NhdmVEZWNpc2lvblRvRGIgcmV0dXJucyBEMDAxIGFzIGZpcnN0IElEJyk7XG5cbiAgICAgIC8vIEFEUi0wMTMgU3RhZ2UgMzogZGVjaXNpb25zIGxhbmQgaW4gbWVtb3JpZXMsIG5vdCB0aGUgbGVnYWN5IHRhYmxlLlxuICAgICAgY29uc3QgbWVtb3J5RGVjaXNpb25zID0gZ2V0QWxsRGVjaXNpb25zRnJvbU1lbW9yaWVzKCk7XG4gICAgICBhc3NlcnQuZXF1YWwobWVtb3J5RGVjaXNpb25zLmxlbmd0aCwgMSwgJ29uZSBtZW1vcnkgcm93IGV4aXN0cyBhZnRlciBzYXZlJyk7XG4gICAgICBjb25zdCBtZW1EZWNpc2lvbiA9IG1lbW9yeURlY2lzaW9uc1swXTtcbiAgICAgIGFzc2VydC5vayhtZW1EZWNpc2lvbiwgJ21lbW9yeSBkZWNpc2lvbiBleGlzdHMgYWZ0ZXIgc2F2ZScpO1xuICAgICAgYXNzZXJ0LmVxdWFsKG1lbURlY2lzaW9uLmlkLCAnRDAwMScpO1xuICAgICAgYXNzZXJ0LmVxdWFsKG1lbURlY2lzaW9uLnNjb3BlLCAnYXJjaCcsICdtZW1vcnkgZGVjaXNpb24gaGFzIGNvcnJlY3Qgc2NvcGUnKTtcbiAgICAgIGFzc2VydC5lcXVhbChtZW1EZWNpc2lvbi5jaG9pY2UsICdPcHRpb24gQScsICdtZW1vcnkgZGVjaXNpb24gaGFzIGNvcnJlY3QgY2hvaWNlJyk7XG5cbiAgICAgIC8vIFZlcmlmeSBtYXJrZG93biBmaWxlIHdhcyB3cml0dGVuXG4gICAgICBjb25zdCBtZFBhdGggPSBwYXRoLmpvaW4odG1wRGlyLCAnLmdzZCcsICdERUNJU0lPTlMubWQnKTtcbiAgICAgIGFzc2VydC5vayhmcy5leGlzdHNTeW5jKG1kUGF0aCksICdERUNJU0lPTlMubWQgZmlsZSBjcmVhdGVkJyk7XG5cbiAgICAgIGNvbnN0IG1kQ29udGVudCA9IGZzLnJlYWRGaWxlU3luYyhtZFBhdGgsICd1dGYtOCcpO1xuICAgICAgYXNzZXJ0Lm9rKG1kQ29udGVudC5pbmNsdWRlcygnRDAwMScpLCAnREVDSVNJT05TLm1kIGNvbnRhaW5zIG5ldyBkZWNpc2lvbiBJRCcpO1xuICAgICAgYXNzZXJ0Lm9rKG1kQ29udGVudC5pbmNsdWRlcygnVGVzdCBkZWNpc2lvbicpLCAnREVDSVNJT05TLm1kIGNvbnRhaW5zIGRlY2lzaW9uIHRleHQnKTtcblxuICAgICAgLy8gVmVyaWZ5IHJvdW5kLXRyaXAgb2YgdGhlIHdyaXR0ZW4gZmlsZVxuICAgICAgY29uc3QgcGFyc2VkID0gcGFyc2VEZWNpc2lvbnNUYWJsZShtZENvbnRlbnQpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwYXJzZWQubGVuZ3RoLCAxLCAnd3JpdHRlbiBERUNJU0lPTlMubWQgcGFyc2VzIHRvIDEgZGVjaXNpb24nKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGFyc2VkWzBdLmlkLCAnRDAwMScsICdwYXJzZWQgZGVjaXNpb24gaGFzIGNvcnJlY3QgSUQnKTtcblxuICAgICAgLy8gQWRkIHNlY29uZCBkZWNpc2lvblxuICAgICAgY29uc3QgcmVzdWx0MiA9IGF3YWl0IHNhdmVEZWNpc2lvblRvRGIoe1xuICAgICAgICBzY29wZTogJ2ltcGwnLFxuICAgICAgICBkZWNpc2lvbjogJ1NlY29uZCBkZWNpc2lvbicsXG4gICAgICAgIGNob2ljZTogJ09wdGlvbiBCJyxcbiAgICAgICAgcmF0aW9uYWxlOiAnQWxzbyBnb29kJyxcbiAgICAgIH0sIHRtcERpcik7XG5cbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0Mi5pZCwgJ0QwMDInLCAnc2Vjb25kIGRlY2lzaW9uIGdldHMgRDAwMicpO1xuXG4gICAgICBjb25zdCBtZENvbnRlbnQyID0gZnMucmVhZEZpbGVTeW5jKG1kUGF0aCwgJ3V0Zi04Jyk7XG4gICAgICBjb25zdCBwYXJzZWQyID0gcGFyc2VEZWNpc2lvbnNUYWJsZShtZENvbnRlbnQyKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGFyc2VkMi5sZW5ndGgsIDIsICdERUNJU0lPTlMubWQgbm93IGhhcyAyIGRlY2lzaW9ucycpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgICBjbGVhbnVwRGlyKHRtcERpcik7XG4gICAgfVxuICB9KTtcblxuICAvLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbiAgLy8gUGFyYWxsZWwgc2F2ZSByYWNlIGNvbmRpdGlvbiByZWdyZXNzaW9uICgjMzMyNiwgIzMzMzksICMzNDU5KVxuICAvLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuICB0ZXN0KCdwYXJhbGxlbCBzYXZlRGVjaXNpb25Ub0RiIGNhbGxzIHByb2R1Y2UgdW5pcXVlIElEcycsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB0bXBEaXIgPSBtYWtlVG1wRGlyKCk7XG4gICAgY29uc3QgZGJQYXRoID0gcGF0aC5qb2luKHRtcERpciwgJy5nc2QnLCAnZ3NkLmRiJyk7XG4gICAgb3BlbkRhdGFiYXNlKGRiUGF0aCk7XG5cbiAgICB0cnkge1xuICAgICAgLy8gRmlyZSA1IHNhdmVzIGNvbmN1cnJlbnRseSBcdTIwMTQgYmVmb3JlIHRoZSBmaXgsIGFsbCB3b3VsZCBnZXQgRDAwMVxuICAgICAgY29uc3QgcmVzdWx0cyA9IGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICAgICAgc2F2ZURlY2lzaW9uVG9EYih7IHNjb3BlOiAnYScsIGRlY2lzaW9uOiAnZDEnLCBjaG9pY2U6ICdjMScsIHJhdGlvbmFsZTogJ3IxJyB9LCB0bXBEaXIpLFxuICAgICAgICBzYXZlRGVjaXNpb25Ub0RiKHsgc2NvcGU6ICdiJywgZGVjaXNpb246ICdkMicsIGNob2ljZTogJ2MyJywgcmF0aW9uYWxlOiAncjInIH0sIHRtcERpciksXG4gICAgICAgIHNhdmVEZWNpc2lvblRvRGIoeyBzY29wZTogJ2MnLCBkZWNpc2lvbjogJ2QzJywgY2hvaWNlOiAnYzMnLCByYXRpb25hbGU6ICdyMycgfSwgdG1wRGlyKSxcbiAgICAgICAgc2F2ZURlY2lzaW9uVG9EYih7IHNjb3BlOiAnZCcsIGRlY2lzaW9uOiAnZDQnLCBjaG9pY2U6ICdjNCcsIHJhdGlvbmFsZTogJ3I0JyB9LCB0bXBEaXIpLFxuICAgICAgICBzYXZlRGVjaXNpb25Ub0RiKHsgc2NvcGU6ICdlJywgZGVjaXNpb246ICdkNScsIGNob2ljZTogJ2M1JywgcmF0aW9uYWxlOiAncjUnIH0sIHRtcERpciksXG4gICAgICBdKTtcblxuICAgICAgY29uc3QgaWRzID0gcmVzdWx0cy5tYXAoKHIpID0+IHIuaWQpO1xuICAgICAgY29uc3QgdW5pcXVlSWRzID0gbmV3IFNldChpZHMpO1xuXG4gICAgICAvLyBBbGwgNSBJRHMgbXVzdCBiZSB1bmlxdWVcbiAgICAgIGFzc2VydC5lcXVhbCh1bmlxdWVJZHMuc2l6ZSwgNSwgYEV4cGVjdGVkIDUgdW5pcXVlIElEcywgZ290ICR7dW5pcXVlSWRzLnNpemV9OiAke2lkcy5qb2luKCcsICcpfWApO1xuXG4gICAgICAvLyBJRHMgc2hvdWxkIGJlIEQwMDEtRDAwNSAob3JkZXIgbWF5IHZhcnkgZHVlIHRvIGNvbmN1cnJlbmN5KVxuICAgICAgZm9yIChjb25zdCBpZCBvZiBpZHMpIHtcbiAgICAgICAgYXNzZXJ0Lm1hdGNoKGlkLCAvXkRcXGR7M30kLywgYElEICR7aWR9IHNob3VsZCBtYXRjaCBEIyMjIHBhdHRlcm5gKTtcbiAgICAgIH1cblxuICAgICAgLy8gQURSLTAxMyBTdGFnZSAzOiB2ZXJpZnkgYWxsIDUgZXhpc3QgaW4gdGhlIG1lbW9yaWVzIHRhYmxlIChkZWNpc2lvbnNcbiAgICAgIC8vIHRhYmxlIHJlY2VpdmVzIG5vIHdyaXRlcyBmcm9tIHNhdmVEZWNpc2lvblRvRGIgcG9zdC1jdXRvdmVyKS5cbiAgICAgIGNvbnN0IG1lbW9yeUlkcyA9IG5ldyBTZXQoZ2V0QWxsRGVjaXNpb25zRnJvbU1lbW9yaWVzKCkubWFwKChkKSA9PiBkLmlkKSk7XG4gICAgICBmb3IgKGNvbnN0IGlkIG9mIGlkcykge1xuICAgICAgICBhc3NlcnQub2sobWVtb3J5SWRzLmhhcyhpZCksIGBEZWNpc2lvbiAke2lkfSBzaG91bGQgZXhpc3QgaW4gbWVtb3JpZXNgKTtcbiAgICAgIH1cbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgICAgY2xlYW51cERpcih0bXBEaXIpO1xuICAgIH1cbiAgfSk7XG5cbiAgLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4gIC8vIHVwZGF0ZVJlcXVpcmVtZW50SW5EYiBUZXN0c1xuICAvLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuICB0ZXN0KCd1cGRhdGVSZXF1aXJlbWVudEluRGInLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgdG1wRGlyID0gbWFrZVRtcERpcigpO1xuICAgIGNvbnN0IGRiUGF0aCA9IHBhdGguam9pbih0bXBEaXIsICcuZ3NkJywgJ2dzZC5kYicpO1xuICAgIG9wZW5EYXRhYmFzZShkYlBhdGgpO1xuXG4gICAgdHJ5IHtcbiAgICAgIC8vIFNlZWQgYSByZXF1aXJlbWVudFxuICAgICAgdXBzZXJ0UmVxdWlyZW1lbnQoe1xuICAgICAgICBpZDogJ1IwMDEnLFxuICAgICAgICBjbGFzczogJ2NvcmUtY2FwYWJpbGl0eScsXG4gICAgICAgIHN0YXR1czogJ2FjdGl2ZScsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnVGVzdCByZXF1aXJlbWVudCcsXG4gICAgICAgIHdoeTogJ1Rlc3RpbmcnLFxuICAgICAgICBzb3VyY2U6ICd0ZXN0JyxcbiAgICAgICAgcHJpbWFyeV9vd25lcjogJ00wMDEvUzAxJyxcbiAgICAgICAgc3VwcG9ydGluZ19zbGljZXM6ICdub25lJyxcbiAgICAgICAgdmFsaWRhdGlvbjogJ3VubWFwcGVkJyxcbiAgICAgICAgbm90ZXM6ICcnLFxuICAgICAgICBmdWxsX2NvbnRlbnQ6ICcnLFxuICAgICAgICBzdXBlcnNlZGVkX2J5OiBudWxsLFxuICAgICAgfSk7XG5cbiAgICAgIC8vIFVwZGF0ZSBpdFxuICAgICAgYXdhaXQgdXBkYXRlUmVxdWlyZW1lbnRJbkRiKCdSMDAxJywge1xuICAgICAgICBzdGF0dXM6ICd2YWxpZGF0ZWQnLFxuICAgICAgICB2YWxpZGF0aW9uOiAnUzAxIFx1MjAxNCBhbGwgdGVzdHMgcGFzcycsXG4gICAgICAgIG5vdGVzOiAnVmFsaWRhdGVkIGluIFMwMScsXG4gICAgICB9LCB0bXBEaXIpO1xuXG4gICAgICAvLyBWZXJpZnkgREIgc3RhdGVcbiAgICAgIGNvbnN0IHVwZGF0ZWQgPSBnZXRSZXF1aXJlbWVudEJ5SWQoJ1IwMDEnKTtcbiAgICAgIGFzc2VydC5vayghIXVwZGF0ZWQsICdyZXF1aXJlbWVudCBzdGlsbCBleGlzdHMgYWZ0ZXIgdXBkYXRlJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHVwZGF0ZWQ/LnN0YXR1cywgJ3ZhbGlkYXRlZCcsICdzdGF0dXMgdXBkYXRlZCBpbiBEQicpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbCh1cGRhdGVkPy52YWxpZGF0aW9uLCAnUzAxIFx1MjAxNCBhbGwgdGVzdHMgcGFzcycsICd2YWxpZGF0aW9uIHVwZGF0ZWQgaW4gREInKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwodXBkYXRlZD8uZGVzY3JpcHRpb24sICdUZXN0IHJlcXVpcmVtZW50JywgJ2Rlc2NyaXB0aW9uIHByZXNlcnZlZCBhZnRlciB1cGRhdGUnKTtcblxuICAgICAgLy8gVmVyaWZ5IG1hcmtkb3duIGZpbGUgd2FzIHdyaXR0ZW5cbiAgICAgIGNvbnN0IG1kUGF0aCA9IHBhdGguam9pbih0bXBEaXIsICcuZ3NkJywgJ1JFUVVJUkVNRU5UUy5tZCcpO1xuICAgICAgYXNzZXJ0Lm9rKGZzLmV4aXN0c1N5bmMobWRQYXRoKSwgJ1JFUVVJUkVNRU5UUy5tZCBmaWxlIGNyZWF0ZWQnKTtcblxuICAgICAgY29uc3QgbWRDb250ZW50ID0gZnMucmVhZEZpbGVTeW5jKG1kUGF0aCwgJ3V0Zi04Jyk7XG4gICAgICBhc3NlcnQub2sobWRDb250ZW50LmluY2x1ZGVzKCdSMDAxJyksICdSRVFVSVJFTUVOVFMubWQgY29udGFpbnMgcmVxdWlyZW1lbnQgSUQnKTtcbiAgICAgIGFzc2VydC5vayhtZENvbnRlbnQuaW5jbHVkZXMoJ3ZhbGlkYXRlZCcpLCAnUkVRVUlSRU1FTlRTLm1kIHNob3dzIHVwZGF0ZWQgc3RhdHVzJyk7XG5cbiAgICAgIC8vIFZlcmlmeSByb3VuZC10cmlwXG4gICAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVJlcXVpcmVtZW50c1NlY3Rpb25zKG1kQ29udGVudCk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBhcnNlZC5sZW5ndGgsIDEsICdwYXJzZWQgMSByZXF1aXJlbWVudCBmcm9tIHdyaXR0ZW4gZmlsZScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwYXJzZWRbMF0uc3RhdHVzLCAndmFsaWRhdGVkJywgJ3BhcnNlZCBzdGF0dXMgbWF0Y2hlcyB1cGRhdGUnKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgICAgY2xlYW51cERpcih0bXBEaXIpO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdCgndXBkYXRlUmVxdWlyZW1lbnRJbkRiIFx1MjAxNCB1cHNlcnRzIHdoZW4gbm90IGZvdW5kICgjMjkxOSknLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgdG1wRGlyID0gbWFrZVRtcERpcigpO1xuICAgIGNvbnN0IGRiUGF0aCA9IHBhdGguam9pbih0bXBEaXIsICcuZ3NkJywgJ2dzZC5kYicpO1xuICAgIG9wZW5EYXRhYmFzZShkYlBhdGgpO1xuXG4gICAgdHJ5IHtcbiAgICAgIC8vIFByZXZpb3VzbHkgdGhyZXc7IG5vdyB1cHNlcnRzIGEgc2tlbGV0b24gcmVxdWlyZW1lbnQgd2l0aCB0aGUgcHJvdmlkZWQgdXBkYXRlc1xuICAgICAgYXdhaXQgdXBkYXRlUmVxdWlyZW1lbnRJbkRiKCdSOTk5JywgeyBzdGF0dXM6ICd2YWxpZGF0ZWQnIH0sIHRtcERpcik7XG4gICAgICBjb25zdCBjcmVhdGVkID0gZ2V0UmVxdWlyZW1lbnRCeUlkKCdSOTk5Jyk7XG4gICAgICBhc3NlcnQub2soY3JlYXRlZCAhPT0gbnVsbCwgJ1I5OTkgc2hvdWxkIGJlIGNyZWF0ZWQgYnkgdXBzZXJ0Jyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGNyZWF0ZWQhLnN0YXR1cywgJ3ZhbGlkYXRlZCcsICdVcHNlcnRlZCByZXF1aXJlbWVudCBzaG91bGQgaGF2ZSB2YWxpZGF0ZWQgc3RhdHVzJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGNyZWF0ZWQhLmlkLCAnUjk5OScsICdVcHNlcnRlZCByZXF1aXJlbWVudCBzaG91bGQga2VlcCB0aGUgcHJvdmlkZWQgSUQnKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgICAgY2xlYW51cERpcih0bXBEaXIpO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdCgndXBkYXRlUmVxdWlyZW1lbnRJbkRiIFx1MjAxNCBpZ25vcmVzIFJFUVVJUkVNRU5UUy5tZCBwcm9qZWN0aW9uIHdoZW4gREIgZW1wdHknLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgdG1wRGlyID0gbWFrZVRtcERpcigpO1xuICAgIGNvbnN0IGRiUGF0aCA9IHBhdGguam9pbih0bXBEaXIsICcuZ3NkJywgJ2dzZC5kYicpO1xuICAgIG9wZW5EYXRhYmFzZShkYlBhdGgpO1xuXG4gICAgdHJ5IHtcbiAgICAgIC8vIFdyaXRlIGEgUkVRVUlSRU1FTlRTLm1kIHdpdGggcmVhbCBjb250ZW50IChzaW11bGF0aW5nIGRpc2N1c3Npb24gcGhhc2Ugb3V0cHV0KVxuICAgICAgY29uc3QgcmVxQ29udGVudCA9IFtcbiAgICAgICAgJyMgUmVxdWlyZW1lbnRzJyxcbiAgICAgICAgJycsXG4gICAgICAgICcjIyBBY3RpdmUnLFxuICAgICAgICAnJyxcbiAgICAgICAgJyMjIyBSMDA1IFx1MjAxNCBVc2VyIGF1dGhlbnRpY2F0aW9uJyxcbiAgICAgICAgJy0gQ2xhc3M6IGZ1bmN0aW9uYWwnLFxuICAgICAgICAnLSBXaHk6IFVzZXJzIG5lZWQgc2VjdXJlIGFjY2VzcycsXG4gICAgICAgICctIFNvdXJjZTogdXNlci1yZXNlYXJjaCcsXG4gICAgICAgICctIFByaW1hcnkgb3duZXI6IE0wMDEvUzAyJyxcbiAgICAgICAgJycsXG4gICAgICAgICcjIyMgUjAwNyBcdTIwMTQgQVBJIHJhdGUgbGltaXRpbmcnLFxuICAgICAgICAnLSBDbGFzczogbm9uLWZ1bmN0aW9uYWwnLFxuICAgICAgICAnLSBXaHk6IFByZXZlbnQgYWJ1c2UnLFxuICAgICAgICAnLSBTb3VyY2U6IGFyY2hpdGVjdHVyZScsXG4gICAgICAgICctIFByaW1hcnkgb3duZXI6IE0wMDEvUzAzJyxcbiAgICAgICAgJycsXG4gICAgICAgICcjIyBWYWxpZGF0ZWQnLFxuICAgICAgICAnJyxcbiAgICAgICAgJyMjIyBSMDAxIFx1MjAxNCBEYXRhYmFzZSBzY2hlbWEnLFxuICAgICAgICAnLSBDbGFzczogZnVuY3Rpb25hbCcsXG4gICAgICAgICctIFdoeTogRm91bmRhdGlvbiBmb3Igc3RvcmFnZScsXG4gICAgICAgICctIFNvdXJjZTogZGVzaWduJyxcbiAgICAgICAgJy0gVmFsaWRhdGlvbjogUzAxIHZlcmlmaWVkJyxcbiAgICAgIF0uam9pbignXFxuJyk7XG4gICAgICBmcy53cml0ZUZpbGVTeW5jKHBhdGguam9pbih0bXBEaXIsICcuZ3NkJywgJ1JFUVVJUkVNRU5UUy5tZCcpLCByZXFDb250ZW50KTtcblxuICAgICAgLy8gREIgaXMgZW1wdHkuIFJFUVVJUkVNRU5UUy5tZCBpcyBhIHByb2plY3Rpb24gYW5kIG11c3Qgbm90IGJlIGltcG9ydGVkXG4gICAgICAvLyBpbXBsaWNpdGx5IGJ5IGEgcnVudGltZSBEQiB3cml0ZS5cbiAgICAgIGF3YWl0IHVwZGF0ZVJlcXVpcmVtZW50SW5EYignUjAwNScsIHtcbiAgICAgICAgc3RhdHVzOiAndmFsaWRhdGVkJyxcbiAgICAgICAgdmFsaWRhdGlvbjogJ1MwMiBcdTIwMTQgYXV0aCBmbG93IHZlcmlmaWVkJyxcbiAgICAgIH0sIHRtcERpcik7XG5cbiAgICAgIC8vIFIwMDUgc2hvdWxkIGhhdmUgdGhlIHJlcXVlc3RlZCB1cGRhdGUgb25seTsgZGlzayBwcm9qZWN0aW9uIGNvbnRlbnQgaXMgaWdub3JlZC5cbiAgICAgIGNvbnN0IHIwMDUgPSBnZXRSZXF1aXJlbWVudEJ5SWQoJ1IwMDUnKTtcbiAgICAgIGFzc2VydC5vayhyMDA1LCAnUjAwNSBzaG91bGQgZXhpc3QnKTtcbiAgICAgIGFzc2VydC5lcXVhbChyMDA1IS5zdGF0dXMsICd2YWxpZGF0ZWQnLCAnc3RhdHVzIHNob3VsZCBiZSB1cGRhdGVkJyk7XG4gICAgICBhc3NlcnQuZXF1YWwocjAwNSEudmFsaWRhdGlvbiwgJ1MwMiBcdTIwMTQgYXV0aCBmbG93IHZlcmlmaWVkJywgJ3ZhbGlkYXRpb24gc2hvdWxkIGJlIHVwZGF0ZWQnKTtcbiAgICAgIGFzc2VydC5lcXVhbChyMDA1IS5jbGFzcywgJycsICdjbGFzcyBzaG91bGQgbm90IGJlIGltcG9ydGVkIGZyb20gUkVRVUlSRU1FTlRTLm1kJyk7XG4gICAgICBhc3NlcnQub2soIXIwMDUhLmRlc2NyaXB0aW9uPy5pbmNsdWRlcygnYXV0aGVudGljYXRpb24nKSwgJ2Rlc2NyaXB0aW9uIHNob3VsZCBub3QgYmUgaW1wb3J0ZWQnKTtcbiAgICAgIGFzc2VydC5vayghcjAwNSEuZnVsbF9jb250ZW50Py5pbmNsdWRlcygnYXV0aGVudGljYXRpb24nKSwgJ2Z1bGwgY29udGVudCBzaG91bGQgbm90IGJlIGltcG9ydGVkJyk7XG5cbiAgICAgIC8vIE90aGVyIHJlcXVpcmVtZW50cyBpbiB0aGUgcHJvamVjdGlvbiBhcmUgbm90IHNlZWRlZC5cbiAgICAgIGNvbnN0IHIwMDcgPSBnZXRSZXF1aXJlbWVudEJ5SWQoJ1IwMDcnKTtcbiAgICAgIGFzc2VydC5lcXVhbChyMDA3LCBudWxsLCAnUjAwNyBzaG91bGQgbm90IGJlIGltcG9ydGVkIGZyb20gUkVRVUlSRU1FTlRTLm1kJyk7XG5cbiAgICAgIGNvbnN0IHIwMDEgPSBnZXRSZXF1aXJlbWVudEJ5SWQoJ1IwMDEnKTtcbiAgICAgIGFzc2VydC5lcXVhbChyMDAxLCBudWxsLCAnUjAwMSBzaG91bGQgbm90IGJlIGltcG9ydGVkIGZyb20gUkVRVUlSRU1FTlRTLm1kJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICAgIGNsZWFudXBEaXIodG1wRGlyKTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoJ3NhdmVSZXF1aXJlbWVudFRvRGIgaXMgaWRlbXBvdGVudCBmb3IgcmVwZWF0ZWQgZGVzY3JpcHRpb25zJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHRtcERpciA9IG1ha2VUbXBEaXIoKTtcbiAgICBjb25zdCBkYlBhdGggPSBwYXRoLmpvaW4odG1wRGlyLCAnLmdzZCcsICdnc2QuZGInKTtcbiAgICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCBmaXJzdCA9IGF3YWl0IHNhdmVSZXF1aXJlbWVudFRvRGIoe1xuICAgICAgICBjbGFzczogJ3ByaW1hcnktdXNlci1sb29wJyxcbiAgICAgICAgc3RhdHVzOiAnYWN0aXZlJyxcbiAgICAgICAgZGVzY3JpcHRpb246ICdVc2VyIGNhbiBhZGQgYSB0YXNrIGJ5IHByZXNzaW5nIEVudGVyJyxcbiAgICAgICAgd2h5OiAnQ29yZSBjYXB0dXJlIGxvb3AnLFxuICAgICAgICBzb3VyY2U6ICd1c2VyJyxcbiAgICAgICAgcHJpbWFyeV9vd25lcjogJ00wMDEvbm9uZSB5ZXQnLFxuICAgICAgICBzdXBwb3J0aW5nX3NsaWNlczogJ25vbmUnLFxuICAgICAgICB2YWxpZGF0aW9uOiAndW5tYXBwZWQnLFxuICAgICAgfSwgdG1wRGlyKTtcbiAgICAgIGNvbnN0IHJldHJ5ID0gYXdhaXQgc2F2ZVJlcXVpcmVtZW50VG9EYih7XG4gICAgICAgIGNsYXNzOiAncHJpbWFyeS11c2VyLWxvb3AnLFxuICAgICAgICBzdGF0dXM6ICdhY3RpdmUnLFxuICAgICAgICBkZXNjcmlwdGlvbjogJyAgdXNlciBDQU4gYWRkIGEgdGFzayBieSBwcmVzc2luZyBFbnRlciAgJyxcbiAgICAgICAgd2h5OiAnQ29yZSBjYXB0dXJlIGxvb3AsIHJlc3RhdGVkIG9uIHJldHJ5JyxcbiAgICAgICAgc291cmNlOiAndXNlcicsXG4gICAgICAgIHByaW1hcnlfb3duZXI6ICdNMDAxL1MwMScsXG4gICAgICAgIHN1cHBvcnRpbmdfc2xpY2VzOiAnbm9uZScsXG4gICAgICAgIHZhbGlkYXRpb246ICdtYXBwZWQnLFxuICAgICAgfSwgdG1wRGlyKTtcblxuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXRyeS5pZCwgZmlyc3QuaWQsICdyZXRyeSBzYXZlIHJldXNlcyBleGlzdGluZyByZXF1aXJlbWVudCBJRCcpO1xuXG4gICAgICBjb25zdCBhZGFwdGVyID0gX2dldEFkYXB0ZXIoKTtcbiAgICAgIGNvbnN0IHJvd3MgPSBhZGFwdGVyIVxuICAgICAgICAucHJlcGFyZSgnU0VMRUNUIGlkLCBkZXNjcmlwdGlvbiwgcHJpbWFyeV9vd25lciwgdmFsaWRhdGlvbiBGUk9NIHJlcXVpcmVtZW50cyBPUkRFUiBCWSBpZCcpXG4gICAgICAgIC5hbGwoKSBhcyBBcnJheTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj47XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJvd3MubGVuZ3RoLCAxLCAnc2VtYW50aWMgZHVwbGljYXRlIGRvZXMgbm90IGNyZWF0ZSBhIG5ldyByb3cnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocm93c1swXVsnaWQnXSwgJ1IwMDEnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocm93c1swXVsncHJpbWFyeV9vd25lciddLCAnTTAwMS9TMDEnLCAncmV0cnkgdXBkYXRlcyB0aGUgZXhpc3Rpbmcgcm93Jyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJvd3NbMF1bJ3ZhbGlkYXRpb24nXSwgJ21hcHBlZCcsICdyZXRyeSB1cGRhdGVzIHZhbGlkYXRpb24nKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgICAgY2xlYW51cERpcih0bXBEaXIpO1xuICAgIH1cbiAgfSk7XG5cbiAgLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4gIC8vIHNhdmVBcnRpZmFjdFRvRGIgVGVzdHNcbiAgLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbiAgdGVzdCgnc2F2ZUFydGlmYWN0VG9EYicsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB0bXBEaXIgPSBtYWtlVG1wRGlyKCk7XG4gICAgY29uc3QgZGJQYXRoID0gcGF0aC5qb2luKHRtcERpciwgJy5nc2QnLCAnZ3NkLmRiJyk7XG4gICAgb3BlbkRhdGFiYXNlKGRiUGF0aCk7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgY29udGVudCA9ICcjIFRhc2sgU3VtbWFyeVxcblxcblRlc3QgY29udGVudFxcbic7XG4gICAgICBhd2FpdCBzYXZlQXJ0aWZhY3RUb0RiKHtcbiAgICAgICAgcGF0aDogJ21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzA2L3Rhc2tzL1QwMS1TVU1NQVJZLm1kJyxcbiAgICAgICAgYXJ0aWZhY3RfdHlwZTogJ1NVTU1BUlknLFxuICAgICAgICBjb250ZW50LFxuICAgICAgICBtaWxlc3RvbmVfaWQ6ICdNMDAxJyxcbiAgICAgICAgc2xpY2VfaWQ6ICdTMDYnLFxuICAgICAgICB0YXNrX2lkOiAnVDAxJyxcbiAgICAgIH0sIHRtcERpcik7XG5cbiAgICAgIC8vIFZlcmlmeSBEQiBzdGF0ZVxuICAgICAgY29uc3QgYWRhcHRlciA9IF9nZXRBZGFwdGVyKCk7XG4gICAgICBhc3NlcnQub2soISFhZGFwdGVyLCAnYWRhcHRlciBhdmFpbGFibGUnKTtcbiAgICAgIGNvbnN0IHJvdyA9IGFkYXB0ZXIhXG4gICAgICAgIC5wcmVwYXJlKCdTRUxFQ1QgKiBGUk9NIGFydGlmYWN0cyBXSEVSRSBwYXRoID0gPycpXG4gICAgICAgIC5nZXQoJ21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzA2L3Rhc2tzL1QwMS1TVU1NQVJZLm1kJyk7XG4gICAgICBhc3NlcnQub2soISFyb3csICdhcnRpZmFjdCBleGlzdHMgaW4gREInKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocm93IVsnYXJ0aWZhY3RfdHlwZSddLCAnU1VNTUFSWScsICdhcnRpZmFjdCB0eXBlIGNvcnJlY3QgaW4gREInKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocm93IVsnbWlsZXN0b25lX2lkJ10sICdNMDAxJywgJ21pbGVzdG9uZV9pZCBjb3JyZWN0IGluIERCJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJvdyFbJ3NsaWNlX2lkJ10sICdTMDYnLCAnc2xpY2VfaWQgY29ycmVjdCBpbiBEQicpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyb3chWyd0YXNrX2lkJ10sICdUMDEnLCAndGFza19pZCBjb3JyZWN0IGluIERCJyk7XG5cbiAgICAgIC8vIFZlcmlmeSBmaWxlIG9uIGRpc2tcbiAgICAgIGNvbnN0IGZpbGVQYXRoID0gcGF0aC5qb2luKFxuICAgICAgICB0bXBEaXIsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScsICdzbGljZXMnLCAnUzA2JywgJ3Rhc2tzJywgJ1QwMS1TVU1NQVJZLm1kJyxcbiAgICAgICk7XG4gICAgICBhc3NlcnQub2soZnMuZXhpc3RzU3luYyhmaWxlUGF0aCksICdhcnRpZmFjdCBmaWxlIHdyaXR0ZW4gdG8gZGlzaycpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChmcy5yZWFkRmlsZVN5bmMoZmlsZVBhdGgsICd1dGYtOCcpLCBjb250ZW50LCAnZmlsZSBjb250ZW50IG1hdGNoZXMnKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgICAgY2xlYW51cERpcih0bXBEaXIpO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdCgnc2F2ZUFydGlmYWN0VG9EYiBcdTIwMTQgc2hyaW5rYWdlIGd1YXJkIHByZXNlcnZlcyBsYXJnZXIgZXhpc3RpbmcgZmlsZScsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB0bXBEaXIgPSBtYWtlVG1wRGlyKCk7XG4gICAgY29uc3QgZGJQYXRoID0gcGF0aC5qb2luKHRtcERpciwgJy5nc2QnLCAnZ3NkLmRiJyk7XG4gICAgb3BlbkRhdGFiYXNlKGRiUGF0aCk7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgZnVsbENvbnRlbnQgPSAnIyBGdWxsIFJlc2VhcmNoXFxuXFxuJyArICd4Jy5yZXBlYXQoMjAwMDApICsgJ1xcbic7XG4gICAgICBjb25zdCBhYmJyZXZpYXRlZENvbnRlbnQgPSAnIyBTdW1tYXJ5XFxuXFxuU2hvcnQgdmVyc2lvbi5cXG4nO1xuXG4gICAgICAvLyBQcmUtY3JlYXRlIHRoZSBmaWxlIHdpdGggZnVsbCBjb250ZW50IChzaW11bGF0aW5nIGEgcHJpb3IgYHdyaXRlYCB0b29sIGNhbGwpXG4gICAgICBjb25zdCByZWxQYXRoID0gJ21pbGVzdG9uZXMvTTAwMS9NMDAxLVJFU0VBUkNILm1kJztcbiAgICAgIGNvbnN0IGZpbGVQYXRoID0gcGF0aC5qb2luKHRtcERpciwgJy5nc2QnLCByZWxQYXRoKTtcbiAgICAgIGZzLm1rZGlyU3luYyhwYXRoLmRpcm5hbWUoZmlsZVBhdGgpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIGZzLndyaXRlRmlsZVN5bmMoZmlsZVBhdGgsIGZ1bGxDb250ZW50KTtcblxuICAgICAgLy8gQ2FsbCBzYXZlQXJ0aWZhY3RUb0RiIHdpdGggYWJicmV2aWF0ZWQgY29udGVudCBcdTIwMTQgc2hvdWxkIHRyaWdnZXIgc2hyaW5rYWdlIGd1YXJkXG4gICAgICBhd2FpdCBzYXZlQXJ0aWZhY3RUb0RiKHtcbiAgICAgICAgcGF0aDogcmVsUGF0aCxcbiAgICAgICAgYXJ0aWZhY3RfdHlwZTogJ1JFU0VBUkNIJyxcbiAgICAgICAgY29udGVudDogYWJicmV2aWF0ZWRDb250ZW50LFxuICAgICAgICBtaWxlc3RvbmVfaWQ6ICdNMDAxJyxcbiAgICAgIH0sIHRtcERpcik7XG5cbiAgICAgIC8vIERpc2sgZmlsZSBzaG91bGQgYmUgcHJlc2VydmVkIChub3Qgb3ZlcndyaXR0ZW4pXG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKFxuICAgICAgICBmcy5yZWFkRmlsZVN5bmMoZmlsZVBhdGgsICd1dGYtOCcpLFxuICAgICAgICBmdWxsQ29udGVudCxcbiAgICAgICAgJ2Rpc2sgZmlsZSBwcmVzZXJ2ZWQgXHUyMDE0IHNocmlua2FnZSBndWFyZCBwcmV2ZW50ZWQgb3ZlcndyaXRlJyxcbiAgICAgICk7XG5cbiAgICAgIC8vIERCIHNob3VsZCBrZWVwIHRoZSBjYWxsZXItcHJvdmlkZWQgY29udGVudC4gVGhlIGxhcmdlciBkaXNrIGZpbGUgaXMgYVxuICAgICAgLy8gc3RhbGUgcHJvamVjdGlvbiwgbm90IHJ1bnRpbWUgYXV0aG9yaXR5LlxuICAgICAgY29uc3QgYWRhcHRlciA9IF9nZXRBZGFwdGVyKCk7XG4gICAgICBjb25zdCByb3cgPSBhZGFwdGVyIVxuICAgICAgICAucHJlcGFyZSgnU0VMRUNUIGZ1bGxfY29udGVudCBGUk9NIGFydGlmYWN0cyBXSEVSRSBwYXRoID0gPycpXG4gICAgICAgIC5nZXQocmVsUGF0aCk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKFxuICAgICAgICByb3chWydmdWxsX2NvbnRlbnQnXSxcbiAgICAgICAgYWJicmV2aWF0ZWRDb250ZW50LFxuICAgICAgICAnREIgc3RvcmVzIGNhbGxlci1wcm92aWRlZCBjb250ZW50IGluc3RlYWQgb2YgaW1wb3J0aW5nIGRpc2sgcHJvamVjdGlvbiBjb250ZW50JyxcbiAgICAgICk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICAgIGNsZWFudXBEaXIodG1wRGlyKTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoJ3NhdmVBcnRpZmFjdFRvRGIgXHUyMDE0IGZpbmFsIFJFUVVJUkVNRU5UUyByZW5kZXJzIGZyb20gREIgcm93cywgaWdub3JpbmcgY2FsbGVyLXN1cHBsaWVkIG1hcmtkb3duJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHRtcERpciA9IG1ha2VUbXBEaXIoKTtcbiAgICBjb25zdCBkYlBhdGggPSBwYXRoLmpvaW4odG1wRGlyLCAnLmdzZCcsICdnc2QuZGInKTtcbiAgICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCBjYW5vbmljYWxSZXF1aXJlbWVudDogUmVxdWlyZW1lbnQgPSB7XG4gICAgICAgIGlkOiAnUjAwMScsXG4gICAgICAgIGNsYXNzOiAncHJpbWFyeS11c2VyLWxvb3AnLFxuICAgICAgICBzdGF0dXM6ICdhY3RpdmUnLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ1VzZXIgY2FuIGFkZCBhIHRhc2snLFxuICAgICAgICB3aHk6ICdDb3JlIGxvb3AnLFxuICAgICAgICBzb3VyY2U6ICd1c2VyJyxcbiAgICAgICAgcHJpbWFyeV9vd25lcjogJ00wMDEvbm9uZSB5ZXQnLFxuICAgICAgICBzdXBwb3J0aW5nX3NsaWNlczogJ25vbmUnLFxuICAgICAgICB2YWxpZGF0aW9uOiAndW5tYXBwZWQnLFxuICAgICAgICBub3RlczogJ2Nhbm9uaWNhbCcsXG4gICAgICAgIGZ1bGxfY29udGVudDogJycsXG4gICAgICAgIHN1cGVyc2VkZWRfYnk6IG51bGwsXG4gICAgICB9O1xuICAgICAgdXBzZXJ0UmVxdWlyZW1lbnQoY2Fub25pY2FsUmVxdWlyZW1lbnQpO1xuXG4gICAgICBjb25zdCByZWxQYXRoID0gJ1JFUVVJUkVNRU5UUy5tZCc7XG4gICAgICBjb25zdCBmaWxlUGF0aCA9IHBhdGguam9pbih0bXBEaXIsICcuZ3NkJywgcmVsUGF0aCk7XG4gICAgICBjb25zdCBibG9hdGVkSW52YWxpZENvbnRlbnQgPSBbXG4gICAgICAgICcjIFJlcXVpcmVtZW50cycsXG4gICAgICAgICcnLFxuICAgICAgICAnIyMgQWN0aXZlJyxcbiAgICAgICAgJycsXG4gICAgICAgIC4uLkFycmF5LmZyb20oeyBsZW5ndGg6IDMwIH0sIChfLCBpKSA9PiBbXG4gICAgICAgICAgYCMjIyBSJHtTdHJpbmcoaSArIDEpLnBhZFN0YXJ0KDMsICcwJyl9IFx1MjAxNCBEdXBsaWNhdGVgLFxuICAgICAgICAgICctIENsYXNzOiBwcmltYXJ5LXVzZXItbG9vcCcsXG4gICAgICAgICAgJy0gU3RhdHVzOiBhY3RpdmUnLFxuICAgICAgICAgICctIERlc2NyaXB0aW9uOiBEdXBsaWNhdGUgcmV0cnkgcm93JyxcbiAgICAgICAgICAnLSBXaHkgaXQgbWF0dGVyczogUmV0cnkgZHJpZnQnLFxuICAgICAgICAgICctIFNvdXJjZTogdGVzdCcsXG4gICAgICAgICAgJy0gUHJpbWFyeSBvd25pbmcgc2xpY2U6IE0wMDEvbm9uZSB5ZXQnLFxuICAgICAgICAgICctIFN1cHBvcnRpbmcgc2xpY2VzOiBub25lJyxcbiAgICAgICAgICAnLSBWYWxpZGF0aW9uOiB1bm1hcHBlZCcsXG4gICAgICAgICAgJy0gTm90ZXM6JyxcbiAgICAgICAgICAnJyxcbiAgICAgICAgXS5qb2luKCdcXG4nKSksXG4gICAgICAgICcjIyBUcmFjZWFiaWxpdHknLFxuICAgICAgICAnJyxcbiAgICAgICAgJyMjIENvdmVyYWdlIFN1bW1hcnknLFxuICAgICAgICAnJyxcbiAgICAgIF0uam9pbignXFxuJyk7XG4gICAgICBmcy53cml0ZUZpbGVTeW5jKGZpbGVQYXRoLCBibG9hdGVkSW52YWxpZENvbnRlbnQpO1xuXG4gICAgICBhc3NlcnQub2soXG4gICAgICAgIEJ1ZmZlci5ieXRlTGVuZ3RoKGdlbmVyYXRlUmVxdWlyZW1lbnRzTWQoW2Nhbm9uaWNhbFJlcXVpcmVtZW50XSksICd1dGYtOCcpIDwgQnVmZmVyLmJ5dGVMZW5ndGgoYmxvYXRlZEludmFsaWRDb250ZW50LCAndXRmLTgnKSAqIDAuNSxcbiAgICAgICAgJ3Rlc3Qgc2V0dXA6IERCLXJlbmRlcmVkIGNvbnRlbnQgaXMgc21hbGwgZW5vdWdoIHRoYXQgdGhlIGdlbmVyaWMgc2hyaW5rYWdlIGd1YXJkIHdvdWxkIHRyaWdnZXInLFxuICAgICAgKTtcblxuICAgICAgYXdhaXQgc2F2ZUFydGlmYWN0VG9EYih7XG4gICAgICAgIHBhdGg6IHJlbFBhdGgsXG4gICAgICAgIGFydGlmYWN0X3R5cGU6ICdSRVFVSVJFTUVOVFMnLFxuICAgICAgICBjb250ZW50OiBibG9hdGVkSW52YWxpZENvbnRlbnQsXG4gICAgICB9LCB0bXBEaXIpO1xuXG4gICAgICBjb25zdCB3cml0dGVuQ29udGVudCA9IGZzLnJlYWRGaWxlU3luYyhmaWxlUGF0aCwgJ3V0Zi04Jyk7XG4gICAgICBhc3NlcnQub2soXG4gICAgICAgIHdyaXR0ZW5Db250ZW50LmluY2x1ZGVzKCdSMDAxJykgJiYgd3JpdHRlbkNvbnRlbnQuaW5jbHVkZXMoJ1VzZXIgY2FuIGFkZCBhIHRhc2snKSxcbiAgICAgICAgJ2Rpc2sgZmlsZSBjb250YWlucyBEQi1zb3VyY2VkIFIwMDEgcmVxdWlyZW1lbnQnLFxuICAgICAgKTtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgIXdyaXR0ZW5Db250ZW50LmluY2x1ZGVzKCdEdXBsaWNhdGUgcmV0cnkgcm93JyksXG4gICAgICAgICdkaXNrIGZpbGUgZG9lcyBub3QgY29udGFpbiBjYWxsZXItc3VwcGxpZWQgYmxvYXRlZCBjb250ZW50JyxcbiAgICAgICk7XG5cbiAgICAgIGNvbnN0IGFkYXB0ZXIgPSBfZ2V0QWRhcHRlcigpO1xuICAgICAgY29uc3QgcmVxUm93cyA9IGFkYXB0ZXIhXG4gICAgICAgIC5wcmVwYXJlKCdTRUxFQ1QgaWQsIGRlc2NyaXB0aW9uIEZST00gcmVxdWlyZW1lbnRzIE9SREVSIEJZIGlkJylcbiAgICAgICAgLmFsbCgpIGFzIEFycmF5PFJlY29yZDxzdHJpbmcsIHVua25vd24+PjtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoXG4gICAgICAgIHJlcVJvd3MubWFwKChyb3cpID0+IFtyb3dbJ2lkJ10sIHJvd1snZGVzY3JpcHRpb24nXV0pLFxuICAgICAgICBbWydSMDAxJywgJ1VzZXIgY2FuIGFkZCBhIHRhc2snXV0sXG4gICAgICAgICdhcnRpZmFjdCBzYXZlIGRvZXMgbm90IHBhcnNlIG1hcmtkb3duIGJhY2sgaW50byB0aGUgcmVxdWlyZW1lbnRzIHRhYmxlJyxcbiAgICAgICk7XG5cbiAgICAgIGNvbnN0IGFydGlmYWN0ID0gYWRhcHRlciFcbiAgICAgICAgLnByZXBhcmUoJ1NFTEVDVCBmdWxsX2NvbnRlbnQgRlJPTSBhcnRpZmFjdHMgV0hFUkUgcGF0aCA9ID8nKVxuICAgICAgICAuZ2V0KHJlbFBhdGgpIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgY29uc3Qgc3RvcmVkQ29udGVudCA9IGFydGlmYWN0WydmdWxsX2NvbnRlbnQnXSBhcyBzdHJpbmc7XG4gICAgICBhc3NlcnQub2soXG4gICAgICAgIHN0b3JlZENvbnRlbnQuaW5jbHVkZXMoJ1IwMDEnKSAmJiBzdG9yZWRDb250ZW50LmluY2x1ZGVzKCdVc2VyIGNhbiBhZGQgYSB0YXNrJyksXG4gICAgICAgICdhcnRpZmFjdHMuZnVsbF9jb250ZW50IGlzIERCLXJlbmRlcmVkIG91dHB1dCBjb250YWluaW5nIFIwMDEnLFxuICAgICAgKTtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgIXN0b3JlZENvbnRlbnQuaW5jbHVkZXMoJ0R1cGxpY2F0ZSByZXRyeSByb3cnKSxcbiAgICAgICAgJ2FydGlmYWN0cy5mdWxsX2NvbnRlbnQgZG9lcyBub3QgZWNobyBjYWxsZXItc3VwcGxpZWQgbWFya2Rvd24gcGF5bG9hZCcsXG4gICAgICApO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgICBjbGVhbnVwRGlyKHRtcERpcik7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KCdzYXZlQXJ0aWZhY3RUb0RiIFx1MjAxNCBhbGxvd3Mgb3ZlcndyaXRlIHdoZW4gbmV3IGNvbnRlbnQgaXMgc2ltaWxhciBzaXplJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHRtcERpciA9IG1ha2VUbXBEaXIoKTtcbiAgICBjb25zdCBkYlBhdGggPSBwYXRoLmpvaW4odG1wRGlyLCAnLmdzZCcsICdnc2QuZGInKTtcbiAgICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCBvbGRDb250ZW50ID0gJyMgU3VtbWFyeSB2MVxcblxcbk9yaWdpbmFsIGNvbnRlbnQgaGVyZS5cXG4nO1xuICAgICAgY29uc3QgbmV3Q29udGVudCA9ICcjIFN1bW1hcnkgdjJcXG5cXG5VcGRhdGVkIGNvbnRlbnQgaGVyZSB3aXRoIG1vcmUgZGV0YWlscy5cXG4nO1xuXG4gICAgICBjb25zdCByZWxQYXRoID0gJ21pbGVzdG9uZXMvTTAwMS9NMDAxLVNVTU1BUlkubWQnO1xuICAgICAgY29uc3QgZmlsZVBhdGggPSBwYXRoLmpvaW4odG1wRGlyLCAnLmdzZCcsIHJlbFBhdGgpO1xuICAgICAgZnMubWtkaXJTeW5jKHBhdGguZGlybmFtZShmaWxlUGF0aCksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgZnMud3JpdGVGaWxlU3luYyhmaWxlUGF0aCwgb2xkQ29udGVudCk7XG5cbiAgICAgIGF3YWl0IHNhdmVBcnRpZmFjdFRvRGIoe1xuICAgICAgICBwYXRoOiByZWxQYXRoLFxuICAgICAgICBhcnRpZmFjdF90eXBlOiAnU1VNTUFSWScsXG4gICAgICAgIGNvbnRlbnQ6IG5ld0NvbnRlbnQsXG4gICAgICAgIG1pbGVzdG9uZV9pZDogJ00wMDEnLFxuICAgICAgfSwgdG1wRGlyKTtcblxuICAgICAgLy8gRGlzayBmaWxlIHNob3VsZCBiZSB1cGRhdGVkIChuZXcgY29udGVudCBpcyA+PTUwJSBvZiBvbGQgc2l6ZSlcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoXG4gICAgICAgIGZzLnJlYWRGaWxlU3luYyhmaWxlUGF0aCwgJ3V0Zi04JyksXG4gICAgICAgIG5ld0NvbnRlbnQsXG4gICAgICAgICdkaXNrIGZpbGUgdXBkYXRlZCB3aGVuIG5ldyBjb250ZW50IGlzIHNpbWlsYXIgc2l6ZScsXG4gICAgICApO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgICBjbGVhbnVwRGlyKHRtcERpcik7XG4gICAgfVxuICB9KTtcblxuICAvLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbiAgLy8gRnVsbCBSb3VuZC1UcmlwOiBEQiBcdTIxOTIgTWFya2Rvd24gXHUyMTkyIFBhcnNlIFx1MjE5MiBDb21wYXJlXG4gIC8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG4gIHRlc3QoJ0Z1bGwgREIgcm91bmQtdHJpcDogZGVjaXNpb25zJywgKCkgPT4ge1xuICAgIG9wZW5EYXRhYmFzZSgnOm1lbW9yeTonKTtcblxuICAgIC8vIEluc2VydCB2aWEgREJcbiAgICBmb3IgKGNvbnN0IGQgb2YgU0FNUExFX0RFQ0lTSU9OUykge1xuICAgICAgdXBzZXJ0RGVjaXNpb24oe1xuICAgICAgICBpZDogZC5pZCxcbiAgICAgICAgd2hlbl9jb250ZXh0OiBkLndoZW5fY29udGV4dCxcbiAgICAgICAgc2NvcGU6IGQuc2NvcGUsXG4gICAgICAgIGRlY2lzaW9uOiBkLmRlY2lzaW9uLFxuICAgICAgICBjaG9pY2U6IGQuY2hvaWNlLFxuICAgICAgICByYXRpb25hbGU6IGQucmF0aW9uYWxlLFxuICAgICAgICByZXZpc2FibGU6IGQucmV2aXNhYmxlLFxuICAgICAgICBtYWRlX2J5OiBkLm1hZGVfYnksXG4gICAgICAgIHN1cGVyc2VkZWRfYnk6IGQuc3VwZXJzZWRlZF9ieSxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIEdlbmVyYXRlIG1hcmtkb3duIGZyb20gREIgc3RhdGVcbiAgICBjb25zdCBhZGFwdGVyID0gX2dldEFkYXB0ZXIoKSE7XG4gICAgY29uc3Qgcm93cyA9IGFkYXB0ZXIucHJlcGFyZSgnU0VMRUNUICogRlJPTSBkZWNpc2lvbnMgT1JERVIgQlkgc2VxJykuYWxsKCk7XG4gICAgY29uc3QgZGJEZWNpc2lvbnM6IERlY2lzaW9uW10gPSByb3dzLm1hcChyb3cgPT4gKHtcbiAgICAgIHNlcTogcm93WydzZXEnXSBhcyBudW1iZXIsXG4gICAgICBpZDogcm93WydpZCddIGFzIHN0cmluZyxcbiAgICAgIHdoZW5fY29udGV4dDogcm93Wyd3aGVuX2NvbnRleHQnXSBhcyBzdHJpbmcsXG4gICAgICBzY29wZTogcm93WydzY29wZSddIGFzIHN0cmluZyxcbiAgICAgIGRlY2lzaW9uOiByb3dbJ2RlY2lzaW9uJ10gYXMgc3RyaW5nLFxuICAgICAgY2hvaWNlOiByb3dbJ2Nob2ljZSddIGFzIHN0cmluZyxcbiAgICAgIHJhdGlvbmFsZTogcm93WydyYXRpb25hbGUnXSBhcyBzdHJpbmcsXG4gICAgICByZXZpc2FibGU6IHJvd1sncmV2aXNhYmxlJ10gYXMgc3RyaW5nLFxuICAgICAgbWFkZV9ieTogKHJvd1snbWFkZV9ieSddIGFzIHN0cmluZyBhcyBpbXBvcnQoJy4uL3R5cGVzLmpzJykuRGVjaXNpb25NYWRlQnkpID8/ICdhZ2VudCcsXG4gICAgICBzdXBlcnNlZGVkX2J5OiAocm93WydzdXBlcnNlZGVkX2J5J10gYXMgc3RyaW5nKSA/PyBudWxsLFxuICAgIH0pKTtcblxuICAgIGNvbnN0IG1kID0gZ2VuZXJhdGVEZWNpc2lvbnNNZChkYkRlY2lzaW9ucyk7XG4gICAgY29uc3QgcGFyc2VkID0gcGFyc2VEZWNpc2lvbnNUYWJsZShtZCk7XG5cbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBhcnNlZC5sZW5ndGgsIFNBTVBMRV9ERUNJU0lPTlMubGVuZ3RoLCAnREIgcm91bmQtdHJpcCBkZWNpc2lvbiBjb3VudCcpO1xuICAgIGZvciAoY29uc3Qgb3JpZyBvZiBTQU1QTEVfREVDSVNJT05TKSB7XG4gICAgICBjb25zdCBydCA9IHBhcnNlZC5maW5kKHAgPT4gcC5pZCA9PT0gb3JpZy5pZCk7XG4gICAgICBhc3NlcnQub2soISFydCwgYERCIHJvdW5kLXRyaXA6ICR7b3JpZy5pZH0gZm91bmRgKTtcbiAgICAgIGlmIChydCkge1xuICAgICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJ0LnNjb3BlLCBvcmlnLnNjb3BlLCBgREIgcm91bmQtdHJpcDogJHtvcmlnLmlkfSBzY29wZWApO1xuICAgICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJ0LmNob2ljZSwgb3JpZy5jaG9pY2UsIGBEQiByb3VuZC10cmlwOiAke29yaWcuaWR9IGNob2ljZWApO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgfSk7XG5cbiAgdGVzdCgnRnVsbCBEQiByb3VuZC10cmlwOiByZXF1aXJlbWVudHMnLCAoKSA9PiB7XG4gICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuXG4gICAgZm9yIChjb25zdCByIG9mIFNBTVBMRV9SRVFVSVJFTUVOVFMpIHtcbiAgICAgIHVwc2VydFJlcXVpcmVtZW50KHIpO1xuICAgIH1cblxuICAgIGNvbnN0IGFkYXB0ZXIgPSBfZ2V0QWRhcHRlcigpITtcbiAgICBjb25zdCByb3dzID0gYWRhcHRlci5wcmVwYXJlKCdTRUxFQ1QgKiBGUk9NIHJlcXVpcmVtZW50cyBPUkRFUiBCWSBpZCcpLmFsbCgpO1xuICAgIGNvbnN0IGRiUmVxczogUmVxdWlyZW1lbnRbXSA9IHJvd3MubWFwKHJvdyA9PiAoe1xuICAgICAgaWQ6IHJvd1snaWQnXSBhcyBzdHJpbmcsXG4gICAgICBjbGFzczogcm93WydjbGFzcyddIGFzIHN0cmluZyxcbiAgICAgIHN0YXR1czogcm93WydzdGF0dXMnXSBhcyBzdHJpbmcsXG4gICAgICBkZXNjcmlwdGlvbjogcm93WydkZXNjcmlwdGlvbiddIGFzIHN0cmluZyxcbiAgICAgIHdoeTogcm93Wyd3aHknXSBhcyBzdHJpbmcsXG4gICAgICBzb3VyY2U6IHJvd1snc291cmNlJ10gYXMgc3RyaW5nLFxuICAgICAgcHJpbWFyeV9vd25lcjogcm93WydwcmltYXJ5X293bmVyJ10gYXMgc3RyaW5nLFxuICAgICAgc3VwcG9ydGluZ19zbGljZXM6IHJvd1snc3VwcG9ydGluZ19zbGljZXMnXSBhcyBzdHJpbmcsXG4gICAgICB2YWxpZGF0aW9uOiByb3dbJ3ZhbGlkYXRpb24nXSBhcyBzdHJpbmcsXG4gICAgICBub3Rlczogcm93Wydub3RlcyddIGFzIHN0cmluZyxcbiAgICAgIGZ1bGxfY29udGVudDogcm93WydmdWxsX2NvbnRlbnQnXSBhcyBzdHJpbmcsXG4gICAgICBzdXBlcnNlZGVkX2J5OiAocm93WydzdXBlcnNlZGVkX2J5J10gYXMgc3RyaW5nKSA/PyBudWxsLFxuICAgIH0pKTtcblxuICAgIGNvbnN0IG1kID0gZ2VuZXJhdGVSZXF1aXJlbWVudHNNZChkYlJlcXMpO1xuICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlUmVxdWlyZW1lbnRzU2VjdGlvbnMobWQpO1xuXG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwYXJzZWQubGVuZ3RoLCBTQU1QTEVfUkVRVUlSRU1FTlRTLmxlbmd0aCwgJ0RCIHJvdW5kLXRyaXAgcmVxdWlyZW1lbnQgY291bnQnKTtcbiAgICBmb3IgKGNvbnN0IG9yaWcgb2YgU0FNUExFX1JFUVVJUkVNRU5UUykge1xuICAgICAgY29uc3QgcnQgPSBwYXJzZWQuZmluZChwID0+IHAuaWQgPT09IG9yaWcuaWQpO1xuICAgICAgYXNzZXJ0Lm9rKCEhcnQsIGBEQiByb3VuZC10cmlwOiAke29yaWcuaWR9IGZvdW5kYCk7XG4gICAgICBpZiAocnQpIHtcbiAgICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChydC5jbGFzcywgb3JpZy5jbGFzcywgYERCIHJvdW5kLXRyaXA6ICR7b3JpZy5pZH0gY2xhc3NgKTtcbiAgICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChydC5kZXNjcmlwdGlvbiwgb3JpZy5kZXNjcmlwdGlvbiwgYERCIHJvdW5kLXRyaXA6ICR7b3JpZy5pZH0gZGVzY3JpcHRpb25gKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gIH0pO1xuXG4gIC8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG4gIC8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuICAvLyAgZXh0cmFjdERlZmVycmVkU2xpY2VSZWZcbiAgLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbiAgZGVzY3JpYmUoJ2V4dHJhY3REZWZlcnJlZFNsaWNlUmVmJywgKCkgPT4ge1xuICAgIGNvbnN0IGZpZWxkcyA9IChzY29wZTogc3RyaW5nLCBjaG9pY2U6IHN0cmluZywgZGVjaXNpb246IHN0cmluZykgPT4gKHtcbiAgICAgIHNjb3BlLFxuICAgICAgY2hvaWNlLFxuICAgICAgZGVjaXNpb24sXG4gICAgfSk7XG5cbiAgICB0ZXN0KCdkZXRlY3RzIGRlZmVycmFsIGluIHNjb3BlIHdpdGggTSMjIy9TIyMgcGF0dGVybiBpbiBjaG9pY2UnLCAoKSA9PiB7XG4gICAgICBjb25zdCByZXN1bHQgPSBleHRyYWN0RGVmZXJyZWRTbGljZVJlZihcbiAgICAgICAgZmllbGRzKCdkZWZlcnJhbCBvZiBsb3ctcHJpb3JpdHkgd29yaycsICdNb3ZlIE0wMDEvUzAzIHRvIGJhY2tsb2cnLCAnJyksXG4gICAgICApO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQsIHsgbWlsZXN0b25lSWQ6ICdNMDAxJywgc2xpY2VJZDogJ1MwMycgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdkZXRlY3RzIGRlZmVycmFsIGluIGNob2ljZSBmaWVsZCcsICgpID0+IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGV4dHJhY3REZWZlcnJlZFNsaWNlUmVmKFxuICAgICAgICBmaWVsZHMoJ3NsaWNlIHByaW9yaXRpemF0aW9uJywgJ2RlZmVyIE0wMDIvUzAxIHVudGlsIG5leHQgc3ByaW50JywgJycpLFxuICAgICAgKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0LCB7IG1pbGVzdG9uZUlkOiAnTTAwMicsIHNsaWNlSWQ6ICdTMDEnIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnZGV0ZWN0cyBkZWZlcnJhbCBpbiBkZWNpc2lvbiBmaWVsZCcsICgpID0+IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGV4dHJhY3REZWZlcnJlZFNsaWNlUmVmKFxuICAgICAgICBmaWVsZHMoJ3Jlc291cmNlIGNvbnN0cmFpbnRzJywgJycsICdkZWZlcnJlZCBNMDEwL1MxMiBwZW5kaW5nIHJldmlldycpLFxuICAgICAgKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0LCB7IG1pbGVzdG9uZUlkOiAnTTAxMCcsIHNsaWNlSWQ6ICdTMTInIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgncmV0dXJucyBudWxsIHdoZW4gbm8gTSMjIy9TIyMgcGF0dGVybiBpcyBwcmVzZW50JywgKCkgPT4ge1xuICAgICAgY29uc3QgcmVzdWx0ID0gZXh0cmFjdERlZmVycmVkU2xpY2VSZWYoXG4gICAgICAgIGZpZWxkcygnZGVmZXJyYWwgb2Ygd29yaycsICd3aWxsIHJldmlzaXQgbGF0ZXInLCAnZGVmZXJyZWQgaW5kZWZpbml0ZWx5JyksXG4gICAgICApO1xuICAgICAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdCwgbnVsbCk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdyZWNvZ25pc2VzIFwiZGVmZXJyaW5nXCIgdmFyaWFudCcsICgpID0+IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGV4dHJhY3REZWZlcnJlZFNsaWNlUmVmKFxuICAgICAgICBmaWVsZHMoJ2RlZmVycmluZyB0aGlzIHNsaWNlJywgJ00wMDUvUzAyIGNhbiB3YWl0JywgJycpLFxuICAgICAgKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0LCB7IG1pbGVzdG9uZUlkOiAnTTAwNScsIHNsaWNlSWQ6ICdTMDInIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgncmVjb2duaXNlcyBcImRlZmVyc1wiIHZhcmlhbnQnLCAoKSA9PiB7XG4gICAgICBjb25zdCByZXN1bHQgPSBleHRyYWN0RGVmZXJyZWRTbGljZVJlZihcbiAgICAgICAgZmllbGRzKCd0ZWFtIGRlZmVycyBzbGljZScsICdNMTAwL1MxMCBub3QgdXJnZW50JywgJycpLFxuICAgICAgKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0LCB7IG1pbGVzdG9uZUlkOiAnTTEwMCcsIHNsaWNlSWQ6ICdTMTAnIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgncmV0dXJucyBmaXJzdCBNIyMjL1MjIyBtYXRjaCB3aGVuIG11bHRpcGxlIHBhdHRlcm5zIGV4aXN0JywgKCkgPT4ge1xuICAgICAgY29uc3QgcmVzdWx0ID0gZXh0cmFjdERlZmVycmVkU2xpY2VSZWYoXG4gICAgICAgIGZpZWxkcygnJywgJ2RlZmVyIE0wMDMvUzAxIGFuZCBNMDAzL1MwMicsICcnKSxcbiAgICAgICk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdCwgeyBtaWxlc3RvbmVJZDogJ00wMDMnLCBzbGljZUlkOiAnUzAxJyB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3JldHVybnMgbnVsbCB3aGVuIG5vIGRlZmVycmFsIGtleXdvcmQgaXMgcHJlc2VudCcsICgpID0+IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGV4dHJhY3REZWZlcnJlZFNsaWNlUmVmKFxuICAgICAgICBmaWVsZHMoJ2FwcHJvdmVkIHdvcmsnLCAnTTAwMS9TMDEgaXMgcmVhZHknLCAncHJvY2VlZCB3aXRoIE0wMDEvUzAxJyksXG4gICAgICApO1xuICAgICAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdCwgbnVsbCk7XG4gICAgfSk7XG4gIH0pO1xuXG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFNBQVMsVUFBVSxZQUFZO0FBQy9CLE9BQU8sWUFBWTtBQUNuQixZQUFZLFVBQVU7QUFDdEIsWUFBWSxRQUFRO0FBQ3BCLFlBQVksUUFBUTtBQUNwQjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUdBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFDUDtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUNQO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1AsU0FBUyxtQ0FBbUM7QUFPNUMsU0FBUyxhQUFxQjtBQUM1QixRQUFNLE1BQU0sR0FBRyxZQUFZLEtBQUssS0FBSyxHQUFHLE9BQU8sR0FBRyxlQUFlLENBQUM7QUFFbEUsS0FBRyxVQUFVLEtBQUssS0FBSyxLQUFLLE1BQU0sR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3hELFNBQU87QUFDVDtBQUVBLFNBQVMsV0FBVyxLQUFtQjtBQUNyQyxNQUFJO0FBQ0YsT0FBRyxPQUFPLEtBQUssRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUNqRCxRQUFRO0FBQUEsRUFBZ0I7QUFDMUI7QUFNQSxNQUFNLG1CQUErQjtBQUFBLEVBQ25DO0FBQUEsSUFDRSxLQUFLO0FBQUEsSUFDTCxJQUFJO0FBQUEsSUFDSixjQUFjO0FBQUEsSUFDZCxPQUFPO0FBQUEsSUFDUCxVQUFVO0FBQUEsSUFDVixRQUFRO0FBQUEsSUFDUixXQUFXO0FBQUEsSUFDWCxXQUFXO0FBQUEsSUFDWCxTQUFTO0FBQUEsSUFDVCxlQUFlO0FBQUEsRUFDakI7QUFBQSxFQUNBO0FBQUEsSUFDRSxLQUFLO0FBQUEsSUFDTCxJQUFJO0FBQUEsSUFDSixjQUFjO0FBQUEsSUFDZCxPQUFPO0FBQUEsSUFDUCxVQUFVO0FBQUEsSUFDVixRQUFRO0FBQUEsSUFDUixXQUFXO0FBQUEsSUFDWCxXQUFXO0FBQUEsSUFDWCxTQUFTO0FBQUEsSUFDVCxlQUFlO0FBQUEsRUFDakI7QUFBQSxFQUNBO0FBQUEsSUFDRSxLQUFLO0FBQUEsSUFDTCxJQUFJO0FBQUEsSUFDSixjQUFjO0FBQUEsSUFDZCxPQUFPO0FBQUEsSUFDUCxVQUFVO0FBQUEsSUFDVixRQUFRO0FBQUEsSUFDUixXQUFXO0FBQUEsSUFDWCxXQUFXO0FBQUEsSUFDWCxTQUFTO0FBQUEsSUFDVCxlQUFlO0FBQUEsRUFDakI7QUFDRjtBQUVBLE1BQU0sc0JBQXFDO0FBQUEsRUFDekM7QUFBQSxJQUNFLElBQUk7QUFBQSxJQUNKLE9BQU87QUFBQSxJQUNQLFFBQVE7QUFBQSxJQUNSLGFBQWE7QUFBQSxJQUNiLEtBQUs7QUFBQSxJQUNMLFFBQVE7QUFBQSxJQUNSLGVBQWU7QUFBQSxJQUNmLG1CQUFtQjtBQUFBLElBQ25CLFlBQVk7QUFBQSxJQUNaLE9BQU87QUFBQSxJQUNQLGNBQWM7QUFBQSxJQUNkLGVBQWU7QUFBQSxFQUNqQjtBQUFBLEVBQ0E7QUFBQSxJQUNFLElBQUk7QUFBQSxJQUNKLE9BQU87QUFBQSxJQUNQLFFBQVE7QUFBQSxJQUNSLGFBQWE7QUFBQSxJQUNiLEtBQUs7QUFBQSxJQUNMLFFBQVE7QUFBQSxJQUNSLGVBQWU7QUFBQSxJQUNmLG1CQUFtQjtBQUFBLElBQ25CLFlBQVk7QUFBQSxJQUNaLE9BQU87QUFBQSxJQUNQLGNBQWM7QUFBQSxJQUNkLGVBQWU7QUFBQSxFQUNqQjtBQUFBLEVBQ0E7QUFBQSxJQUNFLElBQUk7QUFBQSxJQUNKLE9BQU87QUFBQSxJQUNQLFFBQVE7QUFBQSxJQUNSLGFBQWE7QUFBQSxJQUNiLEtBQUs7QUFBQSxJQUNMLFFBQVE7QUFBQSxJQUNSLGVBQWU7QUFBQSxJQUNmLG1CQUFtQjtBQUFBLElBQ25CLFlBQVk7QUFBQSxJQUNaLE9BQU87QUFBQSxJQUNQLGNBQWM7QUFBQSxJQUNkLGVBQWU7QUFBQSxFQUNqQjtBQUFBLEVBQ0E7QUFBQSxJQUNFLElBQUk7QUFBQSxJQUNKLE9BQU87QUFBQSxJQUNQLFFBQVE7QUFBQSxJQUNSLGFBQWE7QUFBQSxJQUNiLEtBQUs7QUFBQSxJQUNMLFFBQVE7QUFBQSxJQUNSLGVBQWU7QUFBQSxJQUNmLG1CQUFtQjtBQUFBLElBQ25CLFlBQVk7QUFBQSxJQUNaLE9BQU87QUFBQSxJQUNQLGNBQWM7QUFBQSxJQUNkLGVBQWU7QUFBQSxFQUNqQjtBQUNGO0FBTUEsU0FBUyxhQUFhLE1BQU07QUFDMUIsT0FBSyxrQ0FBa0MsTUFBTTtBQUMzQyxVQUFNLEtBQUssb0JBQW9CLGdCQUFnQjtBQUMvQyxVQUFNLFNBQVMsb0JBQW9CLEVBQUU7QUFFckMsV0FBTyxnQkFBZ0IsT0FBTyxRQUFRLGlCQUFpQixRQUFRLHlCQUF5QjtBQUV4RixhQUFTLElBQUksR0FBRyxJQUFJLGlCQUFpQixRQUFRLEtBQUs7QUFDaEQsWUFBTSxPQUFPLGlCQUFpQixDQUFDO0FBQy9CLFlBQU0sS0FBSyxPQUFPLENBQUM7QUFDbkIsYUFBTyxnQkFBZ0IsR0FBRyxJQUFJLEtBQUssSUFBSSxZQUFZLEtBQUssRUFBRSxpQkFBaUI7QUFDM0UsYUFBTyxnQkFBZ0IsR0FBRyxjQUFjLEtBQUssY0FBYyxZQUFZLEtBQUssRUFBRSwyQkFBMkI7QUFDekcsYUFBTyxnQkFBZ0IsR0FBRyxPQUFPLEtBQUssT0FBTyxZQUFZLEtBQUssRUFBRSxvQkFBb0I7QUFDcEYsYUFBTyxnQkFBZ0IsR0FBRyxVQUFVLEtBQUssVUFBVSxZQUFZLEtBQUssRUFBRSx1QkFBdUI7QUFDN0YsYUFBTyxnQkFBZ0IsR0FBRyxRQUFRLEtBQUssUUFBUSxZQUFZLEtBQUssRUFBRSxxQkFBcUI7QUFDdkYsYUFBTyxnQkFBZ0IsR0FBRyxXQUFXLEtBQUssV0FBVyxZQUFZLEtBQUssRUFBRSx3QkFBd0I7QUFDaEcsYUFBTyxnQkFBZ0IsR0FBRyxXQUFXLEtBQUssV0FBVyxZQUFZLEtBQUssRUFBRSx3QkFBd0I7QUFDaEcsYUFBTyxnQkFBZ0IsR0FBRyxTQUFTLEtBQUssU0FBUyxZQUFZLEtBQUssRUFBRSxzQkFBc0I7QUFBQSxJQUM1RjtBQUFBLEVBQ0YsQ0FBQztBQUVELE9BQUssOEJBQThCLE1BQU07QUFDdkMsVUFBTSxLQUFLLG9CQUFvQixnQkFBZ0I7QUFDL0MsV0FBTyxHQUFHLEdBQUcsV0FBVyx3QkFBd0IsR0FBRyx1QkFBdUI7QUFDMUUsV0FBTyxHQUFHLEdBQUcsU0FBUyxrQkFBa0IsR0FBRyw2QkFBNkI7QUFDeEUsV0FBTyxHQUFHLEdBQUcsU0FBUyxvQkFBb0IsR0FBRyx1QkFBdUI7QUFDcEUsV0FBTyxHQUFHLEdBQUcsU0FBUyxxQkFBcUIsR0FBRyx3QkFBd0I7QUFDdEUsV0FBTyxHQUFHLEdBQUcsU0FBUyxhQUFhLEdBQUcsZ0NBQWdDO0FBQUEsRUFDeEUsQ0FBQztBQUVELE9BQUssbUNBQW1DLE1BQU07QUFDNUMsVUFBTSxLQUFLLG9CQUFvQixDQUFDLENBQUM7QUFDakMsVUFBTSxTQUFTLG9CQUFvQixFQUFFO0FBQ3JDLFdBQU8sZ0JBQWdCLE9BQU8sUUFBUSxHQUFHLHNDQUFzQztBQUMvRSxXQUFPLEdBQUcsR0FBRyxTQUFTLG9CQUFvQixHQUFHLHdDQUF3QztBQUFBLEVBQ3ZGLENBQUM7QUFFRCxPQUFLLHFDQUFxQyxNQUFNO0FBQzlDLFVBQU0sV0FBcUI7QUFBQSxNQUN6QixLQUFLO0FBQUEsTUFDTCxJQUFJO0FBQUEsTUFDSixjQUFjO0FBQUEsTUFDZCxPQUFPO0FBQUEsTUFDUCxVQUFVO0FBQUEsTUFDVixRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxXQUFXO0FBQUEsTUFDWCxTQUFTO0FBQUEsTUFDVCxlQUFlO0FBQUEsSUFDakI7QUFDQSxVQUFNLEtBQUssb0JBQW9CLENBQUMsUUFBUSxDQUFDO0FBRXpDLFVBQU0sU0FBUyxvQkFBb0IsRUFBRTtBQUNyQyxXQUFPLEdBQUcsT0FBTyxVQUFVLEdBQUcsd0RBQXdEO0FBQUEsRUFDeEYsQ0FBQztBQU1ELE9BQUsscUNBQXFDLE1BQU07QUFDOUMsVUFBTSxLQUFLLHVCQUF1QixtQkFBbUI7QUFDckQsVUFBTSxTQUFTLDBCQUEwQixFQUFFO0FBRTNDLFdBQU8sZ0JBQWdCLE9BQU8sUUFBUSxvQkFBb0IsUUFBUSw0QkFBNEI7QUFFOUYsZUFBVyxRQUFRLHFCQUFxQjtBQUN0QyxZQUFNLEtBQUssT0FBTyxLQUFLLE9BQUssRUFBRSxPQUFPLEtBQUssRUFBRTtBQUM1QyxhQUFPLEdBQUcsQ0FBQyxDQUFDLElBQUksZUFBZSxLQUFLLEVBQUUseUJBQXlCO0FBQy9ELFVBQUksSUFBSTtBQUNOLGVBQU8sZ0JBQWdCLEdBQUcsT0FBTyxLQUFLLE9BQU8sZUFBZSxLQUFLLEVBQUUsb0JBQW9CO0FBQ3ZGLGVBQU8sZ0JBQWdCLEdBQUcsYUFBYSxLQUFLLGFBQWEsZUFBZSxLQUFLLEVBQUUsMEJBQTBCO0FBQ3pHLGVBQU8sZ0JBQWdCLEdBQUcsS0FBSyxLQUFLLEtBQUssZUFBZSxLQUFLLEVBQUUsa0JBQWtCO0FBQ2pGLGVBQU8sZ0JBQWdCLEdBQUcsUUFBUSxLQUFLLFFBQVEsZUFBZSxLQUFLLEVBQUUscUJBQXFCO0FBQzFGLGVBQU8sZ0JBQWdCLEdBQUcsZUFBZSxLQUFLLGVBQWUsZUFBZSxLQUFLLEVBQUUsNEJBQTRCO0FBQy9HLGVBQU8sZ0JBQWdCLEdBQUcsbUJBQW1CLEtBQUssbUJBQW1CLGVBQWUsS0FBSyxFQUFFLGdDQUFnQztBQUMzSCxZQUFJLEtBQUssT0FBTztBQUNkLGlCQUFPLGdCQUFnQixHQUFHLE9BQU8sS0FBSyxPQUFPLGVBQWUsS0FBSyxFQUFFLG9CQUFvQjtBQUFBLFFBQ3pGO0FBQUEsTUFDRjtBQUFBLElBQ0Y7QUFBQSxFQUNGLENBQUM7QUFFRCxPQUFLLG1DQUFtQyxNQUFNO0FBQzVDLFVBQU0sS0FBSyx1QkFBdUIsbUJBQW1CO0FBQ3JELFdBQU8sR0FBRyxHQUFHLFNBQVMsV0FBVyxHQUFHLG9CQUFvQjtBQUN4RCxXQUFPLEdBQUcsR0FBRyxTQUFTLGNBQWMsR0FBRyx1QkFBdUI7QUFDOUQsV0FBTyxHQUFHLEdBQUcsU0FBUyxhQUFhLEdBQUcsc0JBQXNCO0FBQzVELFdBQU8sR0FBRyxHQUFHLFNBQVMsaUJBQWlCLEdBQUcsMEJBQTBCO0FBQ3BFLFdBQU8sR0FBRyxHQUFHLFNBQVMsaUJBQWlCLEdBQUcsMEJBQTBCO0FBQ3BFLFdBQU8sR0FBRyxHQUFHLFNBQVMscUJBQXFCLEdBQUcsOEJBQThCO0FBQUEsRUFDOUUsQ0FBQztBQUVELE9BQUssd0RBQXdELE1BQU07QUFFakUsVUFBTSxhQUFhLG9CQUFvQixPQUFPLE9BQUssRUFBRSxXQUFXLFFBQVE7QUFDeEUsVUFBTSxLQUFLLHVCQUF1QixVQUFVO0FBQzVDLFdBQU8sR0FBRyxHQUFHLFNBQVMsV0FBVyxHQUFHLG9CQUFvQjtBQUN4RCxXQUFPLEdBQUcsR0FBRyxTQUFTLGNBQWMsR0FBRyw2QkFBNkI7QUFDcEUsV0FBTyxHQUFHLEdBQUcsU0FBUyxhQUFhLEdBQUcsNEJBQTRCO0FBQ2xFLFdBQU8sR0FBRyxHQUFHLFNBQVMsaUJBQWlCLEdBQUcsZ0NBQWdDO0FBQUEsRUFDNUUsQ0FBQztBQUVELE9BQUssc0NBQXNDLE1BQU07QUFDL0MsVUFBTSxLQUFLLHVCQUF1QixDQUFDLENBQUM7QUFDcEMsVUFBTSxTQUFTLDBCQUEwQixFQUFFO0FBQzNDLFdBQU8sZ0JBQWdCLE9BQU8sUUFBUSxHQUFHLHlDQUF5QztBQUNsRixXQUFPLEdBQUcsR0FBRyxTQUFTLFdBQVcsR0FBRyw2Q0FBNkM7QUFDakYsV0FBTyxHQUFHLEdBQUcsU0FBUyxjQUFjLEdBQUcsZ0RBQWdEO0FBQ3ZGLFdBQU8sR0FBRyxHQUFHLFNBQVMsYUFBYSxHQUFHLCtDQUErQztBQUNyRixXQUFPLEdBQUcsR0FBRyxTQUFTLGlCQUFpQixHQUFHLG1EQUFtRDtBQUFBLEVBQy9GLENBQUM7QUFNRCxPQUFLLGtCQUFrQixZQUFZO0FBRWpDLGlCQUFhLFVBQVU7QUFFdkIsVUFBTSxNQUFNLE1BQU0sZUFBZTtBQUNqQyxXQUFPLGdCQUFnQixLQUFLLFFBQVEsa0NBQWtDO0FBR3RFLG1CQUFlO0FBQUEsTUFDYixJQUFJO0FBQUEsTUFDSixjQUFjO0FBQUEsTUFDZCxPQUFPO0FBQUEsTUFDUCxVQUFVO0FBQUEsTUFDVixRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxXQUFXO0FBQUEsTUFDWCxTQUFTO0FBQUEsTUFDVCxlQUFlO0FBQUEsSUFDakIsQ0FBQztBQUNELG1CQUFlO0FBQUEsTUFDYixJQUFJO0FBQUEsTUFDSixjQUFjO0FBQUEsTUFDZCxPQUFPO0FBQUEsTUFDUCxVQUFVO0FBQUEsTUFDVixRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxXQUFXO0FBQUEsTUFDWCxTQUFTO0FBQUEsTUFDVCxlQUFlO0FBQUEsSUFDakIsQ0FBQztBQUVELFVBQU0sTUFBTSxNQUFNLGVBQWU7QUFDakMsV0FBTyxnQkFBZ0IsS0FBSyxRQUFRLDRCQUE0QjtBQUVoRSxrQkFBYztBQUFBLEVBQ2hCLENBQUM7QUFNRCxPQUFLLG9CQUFvQixZQUFZO0FBQ25DLFVBQU0sU0FBUyxXQUFXO0FBQzFCLFVBQU0sU0FBUyxLQUFLLEtBQUssUUFBUSxRQUFRLFFBQVE7QUFDakQsaUJBQWEsTUFBTTtBQUVuQixRQUFJO0FBQ0YsWUFBTSxTQUFTLE1BQU0saUJBQWlCO0FBQUEsUUFDcEMsT0FBTztBQUFBLFFBQ1AsVUFBVTtBQUFBLFFBQ1YsUUFBUTtBQUFBLFFBQ1IsV0FBVztBQUFBLFFBQ1gsY0FBYztBQUFBLE1BQ2hCLEdBQUcsTUFBTTtBQUVULGFBQU8sZ0JBQWdCLE9BQU8sSUFBSSxRQUFRLDJDQUEyQztBQUdyRixZQUFNLGtCQUFrQiw0QkFBNEI7QUFDcEQsYUFBTyxNQUFNLGdCQUFnQixRQUFRLEdBQUcsa0NBQWtDO0FBQzFFLFlBQU0sY0FBYyxnQkFBZ0IsQ0FBQztBQUNyQyxhQUFPLEdBQUcsYUFBYSxtQ0FBbUM7QUFDMUQsYUFBTyxNQUFNLFlBQVksSUFBSSxNQUFNO0FBQ25DLGFBQU8sTUFBTSxZQUFZLE9BQU8sUUFBUSxtQ0FBbUM7QUFDM0UsYUFBTyxNQUFNLFlBQVksUUFBUSxZQUFZLG9DQUFvQztBQUdqRixZQUFNLFNBQVMsS0FBSyxLQUFLLFFBQVEsUUFBUSxjQUFjO0FBQ3ZELGFBQU8sR0FBRyxHQUFHLFdBQVcsTUFBTSxHQUFHLDJCQUEyQjtBQUU1RCxZQUFNLFlBQVksR0FBRyxhQUFhLFFBQVEsT0FBTztBQUNqRCxhQUFPLEdBQUcsVUFBVSxTQUFTLE1BQU0sR0FBRyx1Q0FBdUM7QUFDN0UsYUFBTyxHQUFHLFVBQVUsU0FBUyxlQUFlLEdBQUcscUNBQXFDO0FBR3BGLFlBQU0sU0FBUyxvQkFBb0IsU0FBUztBQUM1QyxhQUFPLGdCQUFnQixPQUFPLFFBQVEsR0FBRywyQ0FBMkM7QUFDcEYsYUFBTyxnQkFBZ0IsT0FBTyxDQUFDLEVBQUUsSUFBSSxRQUFRLGdDQUFnQztBQUc3RSxZQUFNLFVBQVUsTUFBTSxpQkFBaUI7QUFBQSxRQUNyQyxPQUFPO0FBQUEsUUFDUCxVQUFVO0FBQUEsUUFDVixRQUFRO0FBQUEsUUFDUixXQUFXO0FBQUEsTUFDYixHQUFHLE1BQU07QUFFVCxhQUFPLGdCQUFnQixRQUFRLElBQUksUUFBUSwyQkFBMkI7QUFFdEUsWUFBTSxhQUFhLEdBQUcsYUFBYSxRQUFRLE9BQU87QUFDbEQsWUFBTSxVQUFVLG9CQUFvQixVQUFVO0FBQzlDLGFBQU8sZ0JBQWdCLFFBQVEsUUFBUSxHQUFHLGtDQUFrQztBQUFBLElBQzlFLFVBQUU7QUFDQSxvQkFBYztBQUNkLGlCQUFXLE1BQU07QUFBQSxJQUNuQjtBQUFBLEVBQ0YsQ0FBQztBQU1ELE9BQUssc0RBQXNELFlBQVk7QUFDckUsVUFBTSxTQUFTLFdBQVc7QUFDMUIsVUFBTSxTQUFTLEtBQUssS0FBSyxRQUFRLFFBQVEsUUFBUTtBQUNqRCxpQkFBYSxNQUFNO0FBRW5CLFFBQUk7QUFFRixZQUFNLFVBQVUsTUFBTSxRQUFRLElBQUk7QUFBQSxRQUNoQyxpQkFBaUIsRUFBRSxPQUFPLEtBQUssVUFBVSxNQUFNLFFBQVEsTUFBTSxXQUFXLEtBQUssR0FBRyxNQUFNO0FBQUEsUUFDdEYsaUJBQWlCLEVBQUUsT0FBTyxLQUFLLFVBQVUsTUFBTSxRQUFRLE1BQU0sV0FBVyxLQUFLLEdBQUcsTUFBTTtBQUFBLFFBQ3RGLGlCQUFpQixFQUFFLE9BQU8sS0FBSyxVQUFVLE1BQU0sUUFBUSxNQUFNLFdBQVcsS0FBSyxHQUFHLE1BQU07QUFBQSxRQUN0RixpQkFBaUIsRUFBRSxPQUFPLEtBQUssVUFBVSxNQUFNLFFBQVEsTUFBTSxXQUFXLEtBQUssR0FBRyxNQUFNO0FBQUEsUUFDdEYsaUJBQWlCLEVBQUUsT0FBTyxLQUFLLFVBQVUsTUFBTSxRQUFRLE1BQU0sV0FBVyxLQUFLLEdBQUcsTUFBTTtBQUFBLE1BQ3hGLENBQUM7QUFFRCxZQUFNLE1BQU0sUUFBUSxJQUFJLENBQUMsTUFBTSxFQUFFLEVBQUU7QUFDbkMsWUFBTSxZQUFZLElBQUksSUFBSSxHQUFHO0FBRzdCLGFBQU8sTUFBTSxVQUFVLE1BQU0sR0FBRyw4QkFBOEIsVUFBVSxJQUFJLEtBQUssSUFBSSxLQUFLLElBQUksQ0FBQyxFQUFFO0FBR2pHLGlCQUFXLE1BQU0sS0FBSztBQUNwQixlQUFPLE1BQU0sSUFBSSxZQUFZLE1BQU0sRUFBRSw0QkFBNEI7QUFBQSxNQUNuRTtBQUlBLFlBQU0sWUFBWSxJQUFJLElBQUksNEJBQTRCLEVBQUUsSUFBSSxDQUFDLE1BQU0sRUFBRSxFQUFFLENBQUM7QUFDeEUsaUJBQVcsTUFBTSxLQUFLO0FBQ3BCLGVBQU8sR0FBRyxVQUFVLElBQUksRUFBRSxHQUFHLFlBQVksRUFBRSwyQkFBMkI7QUFBQSxNQUN4RTtBQUFBLElBQ0YsVUFBRTtBQUNBLG9CQUFjO0FBQ2QsaUJBQVcsTUFBTTtBQUFBLElBQ25CO0FBQUEsRUFDRixDQUFDO0FBTUQsT0FBSyx5QkFBeUIsWUFBWTtBQUN4QyxVQUFNLFNBQVMsV0FBVztBQUMxQixVQUFNLFNBQVMsS0FBSyxLQUFLLFFBQVEsUUFBUSxRQUFRO0FBQ2pELGlCQUFhLE1BQU07QUFFbkIsUUFBSTtBQUVGLHdCQUFrQjtBQUFBLFFBQ2hCLElBQUk7QUFBQSxRQUNKLE9BQU87QUFBQSxRQUNQLFFBQVE7QUFBQSxRQUNSLGFBQWE7QUFBQSxRQUNiLEtBQUs7QUFBQSxRQUNMLFFBQVE7QUFBQSxRQUNSLGVBQWU7QUFBQSxRQUNmLG1CQUFtQjtBQUFBLFFBQ25CLFlBQVk7QUFBQSxRQUNaLE9BQU87QUFBQSxRQUNQLGNBQWM7QUFBQSxRQUNkLGVBQWU7QUFBQSxNQUNqQixDQUFDO0FBR0QsWUFBTSxzQkFBc0IsUUFBUTtBQUFBLFFBQ2xDLFFBQVE7QUFBQSxRQUNSLFlBQVk7QUFBQSxRQUNaLE9BQU87QUFBQSxNQUNULEdBQUcsTUFBTTtBQUdULFlBQU0sVUFBVSxtQkFBbUIsTUFBTTtBQUN6QyxhQUFPLEdBQUcsQ0FBQyxDQUFDLFNBQVMsdUNBQXVDO0FBQzVELGFBQU8sZ0JBQWdCLFNBQVMsUUFBUSxhQUFhLHNCQUFzQjtBQUMzRSxhQUFPLGdCQUFnQixTQUFTLFlBQVksNkJBQXdCLDBCQUEwQjtBQUM5RixhQUFPLGdCQUFnQixTQUFTLGFBQWEsb0JBQW9CLG9DQUFvQztBQUdyRyxZQUFNLFNBQVMsS0FBSyxLQUFLLFFBQVEsUUFBUSxpQkFBaUI7QUFDMUQsYUFBTyxHQUFHLEdBQUcsV0FBVyxNQUFNLEdBQUcsOEJBQThCO0FBRS9ELFlBQU0sWUFBWSxHQUFHLGFBQWEsUUFBUSxPQUFPO0FBQ2pELGFBQU8sR0FBRyxVQUFVLFNBQVMsTUFBTSxHQUFHLHlDQUF5QztBQUMvRSxhQUFPLEdBQUcsVUFBVSxTQUFTLFdBQVcsR0FBRyxzQ0FBc0M7QUFHakYsWUFBTSxTQUFTLDBCQUEwQixTQUFTO0FBQ2xELGFBQU8sZ0JBQWdCLE9BQU8sUUFBUSxHQUFHLHdDQUF3QztBQUNqRixhQUFPLGdCQUFnQixPQUFPLENBQUMsRUFBRSxRQUFRLGFBQWEsOEJBQThCO0FBQUEsSUFDdEYsVUFBRTtBQUNBLG9CQUFjO0FBQ2QsaUJBQVcsTUFBTTtBQUFBLElBQ25CO0FBQUEsRUFDRixDQUFDO0FBRUQsT0FBSywrREFBMEQsWUFBWTtBQUN6RSxVQUFNLFNBQVMsV0FBVztBQUMxQixVQUFNLFNBQVMsS0FBSyxLQUFLLFFBQVEsUUFBUSxRQUFRO0FBQ2pELGlCQUFhLE1BQU07QUFFbkIsUUFBSTtBQUVGLFlBQU0sc0JBQXNCLFFBQVEsRUFBRSxRQUFRLFlBQVksR0FBRyxNQUFNO0FBQ25FLFlBQU0sVUFBVSxtQkFBbUIsTUFBTTtBQUN6QyxhQUFPLEdBQUcsWUFBWSxNQUFNLGtDQUFrQztBQUM5RCxhQUFPLGdCQUFnQixRQUFTLFFBQVEsYUFBYSxtREFBbUQ7QUFDeEcsYUFBTyxnQkFBZ0IsUUFBUyxJQUFJLFFBQVEsa0RBQWtEO0FBQUEsSUFDaEcsVUFBRTtBQUNBLG9CQUFjO0FBQ2QsaUJBQVcsTUFBTTtBQUFBLElBQ25CO0FBQUEsRUFDRixDQUFDO0FBRUQsT0FBSyxpRkFBNEUsWUFBWTtBQUMzRixVQUFNLFNBQVMsV0FBVztBQUMxQixVQUFNLFNBQVMsS0FBSyxLQUFLLFFBQVEsUUFBUSxRQUFRO0FBQ2pELGlCQUFhLE1BQU07QUFFbkIsUUFBSTtBQUVGLFlBQU0sYUFBYTtBQUFBLFFBQ2pCO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLE1BQ0YsRUFBRSxLQUFLLElBQUk7QUFDWCxTQUFHLGNBQWMsS0FBSyxLQUFLLFFBQVEsUUFBUSxpQkFBaUIsR0FBRyxVQUFVO0FBSXpFLFlBQU0sc0JBQXNCLFFBQVE7QUFBQSxRQUNsQyxRQUFRO0FBQUEsUUFDUixZQUFZO0FBQUEsTUFDZCxHQUFHLE1BQU07QUFHVCxZQUFNLE9BQU8sbUJBQW1CLE1BQU07QUFDdEMsYUFBTyxHQUFHLE1BQU0sbUJBQW1CO0FBQ25DLGFBQU8sTUFBTSxLQUFNLFFBQVEsYUFBYSwwQkFBMEI7QUFDbEUsYUFBTyxNQUFNLEtBQU0sWUFBWSxpQ0FBNEIsOEJBQThCO0FBQ3pGLGFBQU8sTUFBTSxLQUFNLE9BQU8sSUFBSSxtREFBbUQ7QUFDakYsYUFBTyxHQUFHLENBQUMsS0FBTSxhQUFhLFNBQVMsZ0JBQWdCLEdBQUcsb0NBQW9DO0FBQzlGLGFBQU8sR0FBRyxDQUFDLEtBQU0sY0FBYyxTQUFTLGdCQUFnQixHQUFHLHFDQUFxQztBQUdoRyxZQUFNLE9BQU8sbUJBQW1CLE1BQU07QUFDdEMsYUFBTyxNQUFNLE1BQU0sTUFBTSxrREFBa0Q7QUFFM0UsWUFBTSxPQUFPLG1CQUFtQixNQUFNO0FBQ3RDLGFBQU8sTUFBTSxNQUFNLE1BQU0sa0RBQWtEO0FBQUEsSUFDN0UsVUFBRTtBQUNBLG9CQUFjO0FBQ2QsaUJBQVcsTUFBTTtBQUFBLElBQ25CO0FBQUEsRUFDRixDQUFDO0FBRUQsT0FBSywrREFBK0QsWUFBWTtBQUM5RSxVQUFNLFNBQVMsV0FBVztBQUMxQixVQUFNLFNBQVMsS0FBSyxLQUFLLFFBQVEsUUFBUSxRQUFRO0FBQ2pELGlCQUFhLE1BQU07QUFFbkIsUUFBSTtBQUNGLFlBQU0sUUFBUSxNQUFNLG9CQUFvQjtBQUFBLFFBQ3RDLE9BQU87QUFBQSxRQUNQLFFBQVE7QUFBQSxRQUNSLGFBQWE7QUFBQSxRQUNiLEtBQUs7QUFBQSxRQUNMLFFBQVE7QUFBQSxRQUNSLGVBQWU7QUFBQSxRQUNmLG1CQUFtQjtBQUFBLFFBQ25CLFlBQVk7QUFBQSxNQUNkLEdBQUcsTUFBTTtBQUNULFlBQU0sUUFBUSxNQUFNLG9CQUFvQjtBQUFBLFFBQ3RDLE9BQU87QUFBQSxRQUNQLFFBQVE7QUFBQSxRQUNSLGFBQWE7QUFBQSxRQUNiLEtBQUs7QUFBQSxRQUNMLFFBQVE7QUFBQSxRQUNSLGVBQWU7QUFBQSxRQUNmLG1CQUFtQjtBQUFBLFFBQ25CLFlBQVk7QUFBQSxNQUNkLEdBQUcsTUFBTTtBQUVULGFBQU8sZ0JBQWdCLE1BQU0sSUFBSSxNQUFNLElBQUksMkNBQTJDO0FBRXRGLFlBQU0sVUFBVSxZQUFZO0FBQzVCLFlBQU0sT0FBTyxRQUNWLFFBQVEsaUZBQWlGLEVBQ3pGLElBQUk7QUFDUCxhQUFPLGdCQUFnQixLQUFLLFFBQVEsR0FBRyw4Q0FBOEM7QUFDckYsYUFBTyxnQkFBZ0IsS0FBSyxDQUFDLEVBQUUsSUFBSSxHQUFHLE1BQU07QUFDNUMsYUFBTyxnQkFBZ0IsS0FBSyxDQUFDLEVBQUUsZUFBZSxHQUFHLFlBQVksZ0NBQWdDO0FBQzdGLGFBQU8sZ0JBQWdCLEtBQUssQ0FBQyxFQUFFLFlBQVksR0FBRyxVQUFVLDBCQUEwQjtBQUFBLElBQ3BGLFVBQUU7QUFDQSxvQkFBYztBQUNkLGlCQUFXLE1BQU07QUFBQSxJQUNuQjtBQUFBLEVBQ0YsQ0FBQztBQU1ELE9BQUssb0JBQW9CLFlBQVk7QUFDbkMsVUFBTSxTQUFTLFdBQVc7QUFDMUIsVUFBTSxTQUFTLEtBQUssS0FBSyxRQUFRLFFBQVEsUUFBUTtBQUNqRCxpQkFBYSxNQUFNO0FBRW5CLFFBQUk7QUFDRixZQUFNLFVBQVU7QUFDaEIsWUFBTSxpQkFBaUI7QUFBQSxRQUNyQixNQUFNO0FBQUEsUUFDTixlQUFlO0FBQUEsUUFDZjtBQUFBLFFBQ0EsY0FBYztBQUFBLFFBQ2QsVUFBVTtBQUFBLFFBQ1YsU0FBUztBQUFBLE1BQ1gsR0FBRyxNQUFNO0FBR1QsWUFBTSxVQUFVLFlBQVk7QUFDNUIsYUFBTyxHQUFHLENBQUMsQ0FBQyxTQUFTLG1CQUFtQjtBQUN4QyxZQUFNLE1BQU0sUUFDVCxRQUFRLHdDQUF3QyxFQUNoRCxJQUFJLGlEQUFpRDtBQUN4RCxhQUFPLEdBQUcsQ0FBQyxDQUFDLEtBQUssdUJBQXVCO0FBQ3hDLGFBQU8sZ0JBQWdCLElBQUssZUFBZSxHQUFHLFdBQVcsNkJBQTZCO0FBQ3RGLGFBQU8sZ0JBQWdCLElBQUssY0FBYyxHQUFHLFFBQVEsNEJBQTRCO0FBQ2pGLGFBQU8sZ0JBQWdCLElBQUssVUFBVSxHQUFHLE9BQU8sd0JBQXdCO0FBQ3hFLGFBQU8sZ0JBQWdCLElBQUssU0FBUyxHQUFHLE9BQU8sdUJBQXVCO0FBR3RFLFlBQU0sV0FBVyxLQUFLO0FBQUEsUUFDcEI7QUFBQSxRQUFRO0FBQUEsUUFBUTtBQUFBLFFBQWM7QUFBQSxRQUFRO0FBQUEsUUFBVTtBQUFBLFFBQU87QUFBQSxRQUFTO0FBQUEsTUFDbEU7QUFDQSxhQUFPLEdBQUcsR0FBRyxXQUFXLFFBQVEsR0FBRywrQkFBK0I7QUFDbEUsYUFBTyxnQkFBZ0IsR0FBRyxhQUFhLFVBQVUsT0FBTyxHQUFHLFNBQVMsc0JBQXNCO0FBQUEsSUFDNUYsVUFBRTtBQUNBLG9CQUFjO0FBQ2QsaUJBQVcsTUFBTTtBQUFBLElBQ25CO0FBQUEsRUFDRixDQUFDO0FBRUQsT0FBSywwRUFBcUUsWUFBWTtBQUNwRixVQUFNLFNBQVMsV0FBVztBQUMxQixVQUFNLFNBQVMsS0FBSyxLQUFLLFFBQVEsUUFBUSxRQUFRO0FBQ2pELGlCQUFhLE1BQU07QUFFbkIsUUFBSTtBQUNGLFlBQU0sY0FBYyx3QkFBd0IsSUFBSSxPQUFPLEdBQUssSUFBSTtBQUNoRSxZQUFNLHFCQUFxQjtBQUczQixZQUFNLFVBQVU7QUFDaEIsWUFBTSxXQUFXLEtBQUssS0FBSyxRQUFRLFFBQVEsT0FBTztBQUNsRCxTQUFHLFVBQVUsS0FBSyxRQUFRLFFBQVEsR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3hELFNBQUcsY0FBYyxVQUFVLFdBQVc7QUFHdEMsWUFBTSxpQkFBaUI7QUFBQSxRQUNyQixNQUFNO0FBQUEsUUFDTixlQUFlO0FBQUEsUUFDZixTQUFTO0FBQUEsUUFDVCxjQUFjO0FBQUEsTUFDaEIsR0FBRyxNQUFNO0FBR1QsYUFBTztBQUFBLFFBQ0wsR0FBRyxhQUFhLFVBQVUsT0FBTztBQUFBLFFBQ2pDO0FBQUEsUUFDQTtBQUFBLE1BQ0Y7QUFJQSxZQUFNLFVBQVUsWUFBWTtBQUM1QixZQUFNLE1BQU0sUUFDVCxRQUFRLG1EQUFtRCxFQUMzRCxJQUFJLE9BQU87QUFDZCxhQUFPO0FBQUEsUUFDTCxJQUFLLGNBQWM7QUFBQSxRQUNuQjtBQUFBLFFBQ0E7QUFBQSxNQUNGO0FBQUEsSUFDRixVQUFFO0FBQ0Esb0JBQWM7QUFDZCxpQkFBVyxNQUFNO0FBQUEsSUFDbkI7QUFBQSxFQUNGLENBQUM7QUFFRCxPQUFLLHNHQUFpRyxZQUFZO0FBQ2hILFVBQU0sU0FBUyxXQUFXO0FBQzFCLFVBQU0sU0FBUyxLQUFLLEtBQUssUUFBUSxRQUFRLFFBQVE7QUFDakQsaUJBQWEsTUFBTTtBQUVuQixRQUFJO0FBQ0YsWUFBTSx1QkFBb0M7QUFBQSxRQUN4QyxJQUFJO0FBQUEsUUFDSixPQUFPO0FBQUEsUUFDUCxRQUFRO0FBQUEsUUFDUixhQUFhO0FBQUEsUUFDYixLQUFLO0FBQUEsUUFDTCxRQUFRO0FBQUEsUUFDUixlQUFlO0FBQUEsUUFDZixtQkFBbUI7QUFBQSxRQUNuQixZQUFZO0FBQUEsUUFDWixPQUFPO0FBQUEsUUFDUCxjQUFjO0FBQUEsUUFDZCxlQUFlO0FBQUEsTUFDakI7QUFDQSx3QkFBa0Isb0JBQW9CO0FBRXRDLFlBQU0sVUFBVTtBQUNoQixZQUFNLFdBQVcsS0FBSyxLQUFLLFFBQVEsUUFBUSxPQUFPO0FBQ2xELFlBQU0sd0JBQXdCO0FBQUEsUUFDNUI7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBLEdBQUcsTUFBTSxLQUFLLEVBQUUsUUFBUSxHQUFHLEdBQUcsQ0FBQyxHQUFHLE1BQU07QUFBQSxVQUN0QyxRQUFRLE9BQU8sSUFBSSxDQUFDLEVBQUUsU0FBUyxHQUFHLEdBQUcsQ0FBQztBQUFBLFVBQ3RDO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsUUFDRixFQUFFLEtBQUssSUFBSSxDQUFDO0FBQUEsUUFDWjtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLE1BQ0YsRUFBRSxLQUFLLElBQUk7QUFDWCxTQUFHLGNBQWMsVUFBVSxxQkFBcUI7QUFFaEQsYUFBTztBQUFBLFFBQ0wsT0FBTyxXQUFXLHVCQUF1QixDQUFDLG9CQUFvQixDQUFDLEdBQUcsT0FBTyxJQUFJLE9BQU8sV0FBVyx1QkFBdUIsT0FBTyxJQUFJO0FBQUEsUUFDakk7QUFBQSxNQUNGO0FBRUEsWUFBTSxpQkFBaUI7QUFBQSxRQUNyQixNQUFNO0FBQUEsUUFDTixlQUFlO0FBQUEsUUFDZixTQUFTO0FBQUEsTUFDWCxHQUFHLE1BQU07QUFFVCxZQUFNLGlCQUFpQixHQUFHLGFBQWEsVUFBVSxPQUFPO0FBQ3hELGFBQU87QUFBQSxRQUNMLGVBQWUsU0FBUyxNQUFNLEtBQUssZUFBZSxTQUFTLHFCQUFxQjtBQUFBLFFBQ2hGO0FBQUEsTUFDRjtBQUNBLGFBQU87QUFBQSxRQUNMLENBQUMsZUFBZSxTQUFTLHFCQUFxQjtBQUFBLFFBQzlDO0FBQUEsTUFDRjtBQUVBLFlBQU0sVUFBVSxZQUFZO0FBQzVCLFlBQU0sVUFBVSxRQUNiLFFBQVEsc0RBQXNELEVBQzlELElBQUk7QUFDUCxhQUFPO0FBQUEsUUFDTCxRQUFRLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxJQUFJLEdBQUcsSUFBSSxhQUFhLENBQUMsQ0FBQztBQUFBLFFBQ3BELENBQUMsQ0FBQyxRQUFRLHFCQUFxQixDQUFDO0FBQUEsUUFDaEM7QUFBQSxNQUNGO0FBRUEsWUFBTSxXQUFXLFFBQ2QsUUFBUSxtREFBbUQsRUFDM0QsSUFBSSxPQUFPO0FBQ2QsWUFBTSxnQkFBZ0IsU0FBUyxjQUFjO0FBQzdDLGFBQU87QUFBQSxRQUNMLGNBQWMsU0FBUyxNQUFNLEtBQUssY0FBYyxTQUFTLHFCQUFxQjtBQUFBLFFBQzlFO0FBQUEsTUFDRjtBQUNBLGFBQU87QUFBQSxRQUNMLENBQUMsY0FBYyxTQUFTLHFCQUFxQjtBQUFBLFFBQzdDO0FBQUEsTUFDRjtBQUFBLElBQ0YsVUFBRTtBQUNBLG9CQUFjO0FBQ2QsaUJBQVcsTUFBTTtBQUFBLElBQ25CO0FBQUEsRUFDRixDQUFDO0FBRUQsT0FBSyw2RUFBd0UsWUFBWTtBQUN2RixVQUFNLFNBQVMsV0FBVztBQUMxQixVQUFNLFNBQVMsS0FBSyxLQUFLLFFBQVEsUUFBUSxRQUFRO0FBQ2pELGlCQUFhLE1BQU07QUFFbkIsUUFBSTtBQUNGLFlBQU0sYUFBYTtBQUNuQixZQUFNLGFBQWE7QUFFbkIsWUFBTSxVQUFVO0FBQ2hCLFlBQU0sV0FBVyxLQUFLLEtBQUssUUFBUSxRQUFRLE9BQU87QUFDbEQsU0FBRyxVQUFVLEtBQUssUUFBUSxRQUFRLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUN4RCxTQUFHLGNBQWMsVUFBVSxVQUFVO0FBRXJDLFlBQU0saUJBQWlCO0FBQUEsUUFDckIsTUFBTTtBQUFBLFFBQ04sZUFBZTtBQUFBLFFBQ2YsU0FBUztBQUFBLFFBQ1QsY0FBYztBQUFBLE1BQ2hCLEdBQUcsTUFBTTtBQUdULGFBQU87QUFBQSxRQUNMLEdBQUcsYUFBYSxVQUFVLE9BQU87QUFBQSxRQUNqQztBQUFBLFFBQ0E7QUFBQSxNQUNGO0FBQUEsSUFDRixVQUFFO0FBQ0Esb0JBQWM7QUFDZCxpQkFBVyxNQUFNO0FBQUEsSUFDbkI7QUFBQSxFQUNGLENBQUM7QUFNRCxPQUFLLGlDQUFpQyxNQUFNO0FBQzFDLGlCQUFhLFVBQVU7QUFHdkIsZUFBVyxLQUFLLGtCQUFrQjtBQUNoQyxxQkFBZTtBQUFBLFFBQ2IsSUFBSSxFQUFFO0FBQUEsUUFDTixjQUFjLEVBQUU7QUFBQSxRQUNoQixPQUFPLEVBQUU7QUFBQSxRQUNULFVBQVUsRUFBRTtBQUFBLFFBQ1osUUFBUSxFQUFFO0FBQUEsUUFDVixXQUFXLEVBQUU7QUFBQSxRQUNiLFdBQVcsRUFBRTtBQUFBLFFBQ2IsU0FBUyxFQUFFO0FBQUEsUUFDWCxlQUFlLEVBQUU7QUFBQSxNQUNuQixDQUFDO0FBQUEsSUFDSDtBQUdBLFVBQU0sVUFBVSxZQUFZO0FBQzVCLFVBQU0sT0FBTyxRQUFRLFFBQVEsc0NBQXNDLEVBQUUsSUFBSTtBQUN6RSxVQUFNLGNBQTBCLEtBQUssSUFBSSxVQUFRO0FBQUEsTUFDL0MsS0FBSyxJQUFJLEtBQUs7QUFBQSxNQUNkLElBQUksSUFBSSxJQUFJO0FBQUEsTUFDWixjQUFjLElBQUksY0FBYztBQUFBLE1BQ2hDLE9BQU8sSUFBSSxPQUFPO0FBQUEsTUFDbEIsVUFBVSxJQUFJLFVBQVU7QUFBQSxNQUN4QixRQUFRLElBQUksUUFBUTtBQUFBLE1BQ3BCLFdBQVcsSUFBSSxXQUFXO0FBQUEsTUFDMUIsV0FBVyxJQUFJLFdBQVc7QUFBQSxNQUMxQixTQUFVLElBQUksU0FBUyxLQUF3RDtBQUFBLE1BQy9FLGVBQWdCLElBQUksZUFBZSxLQUFnQjtBQUFBLElBQ3JELEVBQUU7QUFFRixVQUFNLEtBQUssb0JBQW9CLFdBQVc7QUFDMUMsVUFBTSxTQUFTLG9CQUFvQixFQUFFO0FBRXJDLFdBQU8sZ0JBQWdCLE9BQU8sUUFBUSxpQkFBaUIsUUFBUSw4QkFBOEI7QUFDN0YsZUFBVyxRQUFRLGtCQUFrQjtBQUNuQyxZQUFNLEtBQUssT0FBTyxLQUFLLE9BQUssRUFBRSxPQUFPLEtBQUssRUFBRTtBQUM1QyxhQUFPLEdBQUcsQ0FBQyxDQUFDLElBQUksa0JBQWtCLEtBQUssRUFBRSxRQUFRO0FBQ2pELFVBQUksSUFBSTtBQUNOLGVBQU8sZ0JBQWdCLEdBQUcsT0FBTyxLQUFLLE9BQU8sa0JBQWtCLEtBQUssRUFBRSxRQUFRO0FBQzlFLGVBQU8sZ0JBQWdCLEdBQUcsUUFBUSxLQUFLLFFBQVEsa0JBQWtCLEtBQUssRUFBRSxTQUFTO0FBQUEsTUFDbkY7QUFBQSxJQUNGO0FBRUEsa0JBQWM7QUFBQSxFQUNoQixDQUFDO0FBRUQsT0FBSyxvQ0FBb0MsTUFBTTtBQUM3QyxpQkFBYSxVQUFVO0FBRXZCLGVBQVcsS0FBSyxxQkFBcUI7QUFDbkMsd0JBQWtCLENBQUM7QUFBQSxJQUNyQjtBQUVBLFVBQU0sVUFBVSxZQUFZO0FBQzVCLFVBQU0sT0FBTyxRQUFRLFFBQVEsd0NBQXdDLEVBQUUsSUFBSTtBQUMzRSxVQUFNLFNBQXdCLEtBQUssSUFBSSxVQUFRO0FBQUEsTUFDN0MsSUFBSSxJQUFJLElBQUk7QUFBQSxNQUNaLE9BQU8sSUFBSSxPQUFPO0FBQUEsTUFDbEIsUUFBUSxJQUFJLFFBQVE7QUFBQSxNQUNwQixhQUFhLElBQUksYUFBYTtBQUFBLE1BQzlCLEtBQUssSUFBSSxLQUFLO0FBQUEsTUFDZCxRQUFRLElBQUksUUFBUTtBQUFBLE1BQ3BCLGVBQWUsSUFBSSxlQUFlO0FBQUEsTUFDbEMsbUJBQW1CLElBQUksbUJBQW1CO0FBQUEsTUFDMUMsWUFBWSxJQUFJLFlBQVk7QUFBQSxNQUM1QixPQUFPLElBQUksT0FBTztBQUFBLE1BQ2xCLGNBQWMsSUFBSSxjQUFjO0FBQUEsTUFDaEMsZUFBZ0IsSUFBSSxlQUFlLEtBQWdCO0FBQUEsSUFDckQsRUFBRTtBQUVGLFVBQU0sS0FBSyx1QkFBdUIsTUFBTTtBQUN4QyxVQUFNLFNBQVMsMEJBQTBCLEVBQUU7QUFFM0MsV0FBTyxnQkFBZ0IsT0FBTyxRQUFRLG9CQUFvQixRQUFRLGlDQUFpQztBQUNuRyxlQUFXLFFBQVEscUJBQXFCO0FBQ3RDLFlBQU0sS0FBSyxPQUFPLEtBQUssT0FBSyxFQUFFLE9BQU8sS0FBSyxFQUFFO0FBQzVDLGFBQU8sR0FBRyxDQUFDLENBQUMsSUFBSSxrQkFBa0IsS0FBSyxFQUFFLFFBQVE7QUFDakQsVUFBSSxJQUFJO0FBQ04sZUFBTyxnQkFBZ0IsR0FBRyxPQUFPLEtBQUssT0FBTyxrQkFBa0IsS0FBSyxFQUFFLFFBQVE7QUFDOUUsZUFBTyxnQkFBZ0IsR0FBRyxhQUFhLEtBQUssYUFBYSxrQkFBa0IsS0FBSyxFQUFFLGNBQWM7QUFBQSxNQUNsRztBQUFBLElBQ0Y7QUFFQSxrQkFBYztBQUFBLEVBQ2hCLENBQUM7QUFRRCxXQUFTLDJCQUEyQixNQUFNO0FBQ3hDLFVBQU0sU0FBUyxDQUFDLE9BQWUsUUFBZ0IsY0FBc0I7QUFBQSxNQUNuRTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRjtBQUVBLFNBQUssNkRBQTZELE1BQU07QUFDdEUsWUFBTSxTQUFTO0FBQUEsUUFDYixPQUFPLGlDQUFpQyw0QkFBNEIsRUFBRTtBQUFBLE1BQ3hFO0FBQ0EsYUFBTyxnQkFBZ0IsUUFBUSxFQUFFLGFBQWEsUUFBUSxTQUFTLE1BQU0sQ0FBQztBQUFBLElBQ3hFLENBQUM7QUFFRCxTQUFLLG9DQUFvQyxNQUFNO0FBQzdDLFlBQU0sU0FBUztBQUFBLFFBQ2IsT0FBTyx3QkFBd0Isb0NBQW9DLEVBQUU7QUFBQSxNQUN2RTtBQUNBLGFBQU8sZ0JBQWdCLFFBQVEsRUFBRSxhQUFhLFFBQVEsU0FBUyxNQUFNLENBQUM7QUFBQSxJQUN4RSxDQUFDO0FBRUQsU0FBSyxzQ0FBc0MsTUFBTTtBQUMvQyxZQUFNLFNBQVM7QUFBQSxRQUNiLE9BQU8sd0JBQXdCLElBQUksa0NBQWtDO0FBQUEsTUFDdkU7QUFDQSxhQUFPLGdCQUFnQixRQUFRLEVBQUUsYUFBYSxRQUFRLFNBQVMsTUFBTSxDQUFDO0FBQUEsSUFDeEUsQ0FBQztBQUVELFNBQUssb0RBQW9ELE1BQU07QUFDN0QsWUFBTSxTQUFTO0FBQUEsUUFDYixPQUFPLG9CQUFvQixzQkFBc0IsdUJBQXVCO0FBQUEsTUFDMUU7QUFDQSxhQUFPLFlBQVksUUFBUSxJQUFJO0FBQUEsSUFDakMsQ0FBQztBQUVELFNBQUssa0NBQWtDLE1BQU07QUFDM0MsWUFBTSxTQUFTO0FBQUEsUUFDYixPQUFPLHdCQUF3QixxQkFBcUIsRUFBRTtBQUFBLE1BQ3hEO0FBQ0EsYUFBTyxnQkFBZ0IsUUFBUSxFQUFFLGFBQWEsUUFBUSxTQUFTLE1BQU0sQ0FBQztBQUFBLElBQ3hFLENBQUM7QUFFRCxTQUFLLCtCQUErQixNQUFNO0FBQ3hDLFlBQU0sU0FBUztBQUFBLFFBQ2IsT0FBTyxxQkFBcUIsdUJBQXVCLEVBQUU7QUFBQSxNQUN2RDtBQUNBLGFBQU8sZ0JBQWdCLFFBQVEsRUFBRSxhQUFhLFFBQVEsU0FBUyxNQUFNLENBQUM7QUFBQSxJQUN4RSxDQUFDO0FBRUQsU0FBSyw2REFBNkQsTUFBTTtBQUN0RSxZQUFNLFNBQVM7QUFBQSxRQUNiLE9BQU8sSUFBSSwrQkFBK0IsRUFBRTtBQUFBLE1BQzlDO0FBQ0EsYUFBTyxnQkFBZ0IsUUFBUSxFQUFFLGFBQWEsUUFBUSxTQUFTLE1BQU0sQ0FBQztBQUFBLElBQ3hFLENBQUM7QUFFRCxTQUFLLG9EQUFvRCxNQUFNO0FBQzdELFlBQU0sU0FBUztBQUFBLFFBQ2IsT0FBTyxpQkFBaUIscUJBQXFCLHVCQUF1QjtBQUFBLE1BQ3RFO0FBQ0EsYUFBTyxZQUFZLFFBQVEsSUFBSTtBQUFBLElBQ2pDLENBQUM7QUFBQSxFQUNILENBQUM7QUFFSCxDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
