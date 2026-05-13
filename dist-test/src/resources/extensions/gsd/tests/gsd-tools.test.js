import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import {
  openDatabase,
  closeDatabase,
  isDbAvailable,
  upsertRequirement,
  getRequirementById,
  _getAdapter
} from "../gsd-db.js";
import {
  saveDecisionToDb,
  updateRequirementInDb,
  saveRequirementToDb,
  saveArtifactToDb,
  nextDecisionId,
  nextRequirementId
} from "../db-writer.js";
import { getAllDecisionsFromMemories } from "../context-store.js";
function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-tools-"));
  fs.mkdirSync(path.join(dir, ".gsd"), { recursive: true });
  return dir;
}
function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
  }
}
describe("gsd-tools", () => {
  test("gsd_decision_save", async () => {
    const tmpDir = makeTmpDir();
    try {
      const dbPath = path.join(tmpDir, ".gsd", "gsd.db");
      openDatabase(dbPath);
      assert.ok(isDbAvailable(), "DB should be available after open");
      const result = await saveDecisionToDb(
        {
          scope: "architecture",
          decision: "Use SQLite for metadata",
          choice: "SQLite",
          rationale: "Sync API fits the CLI model",
          revisable: "Yes",
          when_context: "M001"
        },
        tmpDir
      );
      assert.deepStrictEqual(result.id, "D001", "First decision should be D001");
      const memoryDecisions = getAllDecisionsFromMemories();
      assert.equal(memoryDecisions.length, 1, "one memory row exists after save");
      const memDecision = memoryDecisions[0];
      assert.ok(memDecision, "memory decision exists after save");
      assert.equal(memDecision.id, "D001");
      assert.deepStrictEqual(memDecision.scope, "architecture", "memory decision scope should match");
      assert.deepStrictEqual(memDecision.decision, "Use SQLite for metadata", "memory decision text should match");
      assert.deepStrictEqual(memDecision.choice, "SQLite", "memory decision choice should match");
      const mdPath = path.join(tmpDir, ".gsd", "DECISIONS.md");
      assert.ok(fs.existsSync(mdPath), "DECISIONS.md should be created");
      const mdContent = fs.readFileSync(mdPath, "utf-8");
      assert.ok(mdContent.includes("D001"), "DECISIONS.md should contain D001");
      assert.ok(mdContent.includes("SQLite"), "DECISIONS.md should contain choice");
      const result2 = await saveDecisionToDb(
        {
          scope: "testing",
          decision: "Test runner",
          choice: "vitest",
          rationale: "Fast and ESM-native"
        },
        tmpDir
      );
      assert.deepStrictEqual(result2.id, "D002", "Second decision should be D002");
      const result3 = await saveDecisionToDb(
        {
          scope: "CI",
          decision: "CI platform",
          choice: "GitHub Actions",
          rationale: "Integrated with repo"
        },
        tmpDir
      );
      assert.deepStrictEqual(result3.id, "D003", "Third decision should be D003");
      closeDatabase();
    } finally {
      cleanupDir(tmpDir);
    }
  });
  test("gsd_requirement_update", async () => {
    const tmpDir = makeTmpDir();
    try {
      const dbPath = path.join(tmpDir, ".gsd", "gsd.db");
      openDatabase(dbPath);
      const seedReq = {
        id: "R001",
        class: "functional",
        status: "active",
        description: "Must support SQLite storage",
        why: "Structured data needs",
        source: "design",
        primary_owner: "S03",
        supporting_slices: "",
        validation: "",
        notes: "",
        full_content: "",
        superseded_by: null
      };
      upsertRequirement(seedReq);
      await updateRequirementInDb(
        "R001",
        { status: "validated", validation: "Unit tests pass", notes: "Verified in S06" },
        tmpDir
      );
      const updated = getRequirementById("R001");
      assert.ok(updated !== null, "R001 should still exist");
      assert.deepStrictEqual(updated.status, "validated", "Status should be updated");
      assert.deepStrictEqual(updated.validation, "Unit tests pass", "Validation should be updated");
      assert.deepStrictEqual(updated.notes, "Verified in S06", "Notes should be updated");
      assert.deepStrictEqual(updated.description, "Must support SQLite storage", "Description should be preserved");
      assert.deepStrictEqual(updated.primary_owner, "S03", "Primary owner should be preserved");
      const mdPath = path.join(tmpDir, ".gsd", "REQUIREMENTS.md");
      assert.ok(fs.existsSync(mdPath), "REQUIREMENTS.md should be created");
      const mdContent = fs.readFileSync(mdPath, "utf-8");
      assert.ok(mdContent.includes("R001"), "REQUIREMENTS.md should contain R001");
      assert.ok(mdContent.includes("validated"), "REQUIREMENTS.md should reflect updated status");
      await updateRequirementInDb("R999", { status: "deferred" }, tmpDir);
      const upserted = getRequirementById("R999");
      assert.ok(upserted !== null, "R999 should be created by upsert");
      assert.deepStrictEqual(upserted.status, "deferred", "Upserted requirement should have the updated status");
      closeDatabase();
    } finally {
      cleanupDir(tmpDir);
    }
  });
  test("gsd_summary_save", async () => {
    const tmpDir = makeTmpDir();
    try {
      const dbPath = path.join(tmpDir, ".gsd", "gsd.db");
      openDatabase(dbPath);
      await saveArtifactToDb(
        {
          path: "milestones/M001/slices/S01/S01-SUMMARY.md",
          artifact_type: "SUMMARY",
          content: "# S01 Summary\n\nThis is a test summary.",
          milestone_id: "M001",
          slice_id: "S01"
        },
        tmpDir
      );
      const adapter = _getAdapter();
      assert.ok(adapter !== null, "Adapter should be available");
      const rows = adapter.prepare(
        "SELECT * FROM artifacts WHERE path = 'milestones/M001/slices/S01/S01-SUMMARY.md'"
      ).all();
      assert.deepStrictEqual(rows.length, 1, "Should have 1 artifact row");
      assert.deepStrictEqual(rows[0]["artifact_type"], "SUMMARY", "Artifact type should be SUMMARY");
      assert.deepStrictEqual(rows[0]["milestone_id"], "M001", "Milestone ID should match");
      assert.deepStrictEqual(rows[0]["slice_id"], "S01", "Slice ID should match");
      const filePath = path.join(tmpDir, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md");
      assert.ok(fs.existsSync(filePath), "Summary file should be written to disk");
      const fileContent = fs.readFileSync(filePath, "utf-8");
      assert.ok(fileContent.includes("S01 Summary"), "File should contain summary content");
      await saveArtifactToDb(
        {
          path: "milestones/M001/M001-CONTEXT.md",
          artifact_type: "CONTEXT",
          content: "# M001 Context\n\nContext notes.",
          milestone_id: "M001"
        },
        tmpDir
      );
      const mFilePath = path.join(tmpDir, ".gsd", "milestones", "M001", "M001-CONTEXT.md");
      assert.ok(fs.existsSync(mFilePath), "Milestone-level artifact file should be created");
      await saveArtifactToDb(
        {
          path: "milestones/M001/slices/S01/tasks/T01-SUMMARY.md",
          artifact_type: "SUMMARY",
          content: "# T01 Summary\n\nTask summary.",
          milestone_id: "M001",
          slice_id: "S01",
          task_id: "T01"
        },
        tmpDir
      );
      const tFilePath = path.join(tmpDir, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md");
      assert.ok(fs.existsSync(tFilePath), "Task-level artifact file should be created");
      closeDatabase();
    } finally {
      cleanupDir(tmpDir);
    }
  });
  test("gsd_summary_save supports CONTEXT-DRAFT persistence", async () => {
    const tmpDir = makeTmpDir();
    try {
      const dbPath = path.join(tmpDir, ".gsd", "gsd.db");
      openDatabase(dbPath);
      await saveArtifactToDb(
        {
          path: "milestones/M001/M001-CONTEXT-DRAFT.md",
          artifact_type: "CONTEXT-DRAFT",
          content: "# M001 Draft Context\n\nDraft notes.",
          milestone_id: "M001"
        },
        tmpDir
      );
      const draftPath = path.join(tmpDir, ".gsd", "milestones", "M001", "M001-CONTEXT-DRAFT.md");
      assert.ok(fs.existsSync(draftPath), "Draft context file should be created");
      const draftContent = fs.readFileSync(draftPath, "utf-8");
      assert.ok(draftContent.includes("Draft Context"), "Draft context file should contain draft content");
      const adapter = _getAdapter();
      assert.ok(adapter !== null, "Adapter should be available");
      const rows = adapter.prepare(
        "SELECT * FROM artifacts WHERE path = 'milestones/M001/M001-CONTEXT-DRAFT.md'"
      ).all();
      assert.deepStrictEqual(rows.length, 1, "Should have 1 draft artifact row");
      assert.deepStrictEqual(rows[0]["artifact_type"], "CONTEXT-DRAFT", "Artifact type should be CONTEXT-DRAFT");
      closeDatabase();
    } finally {
      cleanupDir(tmpDir);
    }
  });
  test("DB unavailable error paths", async () => {
    try {
      closeDatabase();
    } catch {
    }
    assert.ok(!isDbAvailable(), "DB should be unavailable after close");
    const fallbackId = await nextDecisionId();
    assert.deepStrictEqual(fallbackId, "D001", "nextDecisionId should return D001 when DB unavailable");
  });
  test("gsd_requirement_save creates new requirement", async () => {
    const tmpDir = makeTmpDir();
    try {
      const dbPath = path.join(tmpDir, ".gsd", "gsd.db");
      openDatabase(dbPath);
      const result = await saveRequirementToDb(
        {
          class: "functional",
          status: "active",
          description: "Must support dark mode",
          why: "Accessibility requirement",
          source: "user-research"
        },
        tmpDir
      );
      assert.deepStrictEqual(result.id, "R001", "First requirement should be R001");
      const row = getRequirementById("R001");
      assert.ok(row !== null, "Requirement R001 should exist in DB");
      assert.deepStrictEqual(row.class, "functional", "Class should match");
      assert.deepStrictEqual(row.description, "Must support dark mode", "Description should match");
      assert.deepStrictEqual(row.status, "active", "Status should match");
      const mdPath = path.join(tmpDir, ".gsd", "REQUIREMENTS.md");
      assert.ok(fs.existsSync(mdPath), "REQUIREMENTS.md should be created");
      const mdContent = fs.readFileSync(mdPath, "utf-8");
      assert.ok(mdContent.includes("R001"), "REQUIREMENTS.md should contain R001");
      assert.ok(mdContent.includes("dark mode"), "REQUIREMENTS.md should contain description");
      const result2 = await saveRequirementToDb(
        {
          class: "non-functional",
          status: "active",
          description: "Must load in under 2 seconds",
          why: "Performance SLA",
          source: "design"
        },
        tmpDir
      );
      assert.deepStrictEqual(result2.id, "R002", "Second requirement should be R002");
      closeDatabase();
    } finally {
      cleanupDir(tmpDir);
    }
  });
  test("nextRequirementId computes correct next ID", async () => {
    const tmpDir = makeTmpDir();
    try {
      const dbPath = path.join(tmpDir, ".gsd", "gsd.db");
      openDatabase(dbPath);
      const id1 = await nextRequirementId();
      assert.deepStrictEqual(id1, "R001", "Should return R001 when no requirements exist");
      upsertRequirement({
        id: "R001",
        class: "functional",
        status: "active",
        description: "Test",
        why: "",
        source: "",
        primary_owner: "",
        supporting_slices: "",
        validation: "",
        notes: "",
        full_content: "",
        superseded_by: null
      });
      const id2 = await nextRequirementId();
      assert.deepStrictEqual(id2, "R002", "Should return R002 after R001 exists");
      closeDatabase();
    } finally {
      cleanupDir(tmpDir);
    }
  });
  test("gsd_requirement_update upserts when requirement not in DB", async () => {
    const tmpDir = makeTmpDir();
    try {
      const dbPath = path.join(tmpDir, ".gsd", "gsd.db");
      openDatabase(dbPath);
      await updateRequirementInDb(
        "R025",
        { status: "validated", validation: "Integration tests pass" },
        tmpDir
      );
      const created = getRequirementById("R025");
      assert.ok(created !== null, "R025 should be created by upsert");
      assert.deepStrictEqual(created.status, "validated", "Status should be set");
      assert.deepStrictEqual(created.validation, "Integration tests pass", "Validation should be set");
      const mdPath = path.join(tmpDir, ".gsd", "REQUIREMENTS.md");
      assert.ok(fs.existsSync(mdPath), "REQUIREMENTS.md should be created");
      closeDatabase();
    } finally {
      cleanupDir(tmpDir);
    }
  });
  test("Tool result format", async () => {
    const tmpDir = makeTmpDir();
    try {
      const dbPath = path.join(tmpDir, ".gsd", "gsd.db");
      openDatabase(dbPath);
      const result = await saveDecisionToDb(
        {
          scope: "format-test",
          decision: "Test format",
          choice: "TypeBox",
          rationale: "Schema validation"
        },
        tmpDir
      );
      assert.ok(typeof result.id === "string", "saveDecisionToDb should return {id: string}");
      assert.match(result.id, /^D\d{3}$/, "ID should match DXXX pattern");
      closeDatabase();
    } finally {
      cleanupDir(tmpDir);
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9nc2QtdG9vbHMudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QgfSBmcm9tICdub2RlOnRlc3QnO1xuaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydC9zdHJpY3QnO1xuLy8gZ3NkLXRvb2xzIFx1MjAxNCBTdHJ1Y3R1cmVkIExMTSB0b29sIHRlc3RzXG4vL1xuLy8gVGVzdHMgdGhlIHRocmVlIHJlZ2lzdGVyZWQgdG9vbHM6IGdzZF9kZWNpc2lvbl9zYXZlLCBnc2RfcmVxdWlyZW1lbnRfdXBkYXRlLCBnc2Rfc3VtbWFyeV9zYXZlLlxuLy8gRWFjaCB0b29sIGlzIHRlc3RlZCB2aWEgZGlyZWN0IGZ1bmN0aW9uIGludm9jYXRpb24gYWdhaW5zdCBhbiBpbi1tZW1vcnkgREIuXG5cbmltcG9ydCAqIGFzIHBhdGggZnJvbSAnbm9kZTpwYXRoJztcbmltcG9ydCAqIGFzIG9zIGZyb20gJ25vZGU6b3MnO1xuaW1wb3J0ICogYXMgZnMgZnJvbSAnbm9kZTpmcyc7XG5pbXBvcnQge1xuICBvcGVuRGF0YWJhc2UsXG4gIGNsb3NlRGF0YWJhc2UsXG4gIGlzRGJBdmFpbGFibGUsXG4gIHVwc2VydFJlcXVpcmVtZW50LFxuICBnZXRSZXF1aXJlbWVudEJ5SWQsXG4gIF9nZXRBZGFwdGVyLFxuICBpbnNlcnRBcnRpZmFjdCxcbn0gZnJvbSAnLi4vZ3NkLWRiLnRzJztcbmltcG9ydCB7XG4gIHNhdmVEZWNpc2lvblRvRGIsXG4gIHVwZGF0ZVJlcXVpcmVtZW50SW5EYixcbiAgc2F2ZVJlcXVpcmVtZW50VG9EYixcbiAgc2F2ZUFydGlmYWN0VG9EYixcbiAgbmV4dERlY2lzaW9uSWQsXG4gIG5leHRSZXF1aXJlbWVudElkLFxufSBmcm9tICcuLi9kYi13cml0ZXIudHMnO1xuaW1wb3J0IHsgZ2V0QWxsRGVjaXNpb25zRnJvbU1lbW9yaWVzIH0gZnJvbSAnLi4vY29udGV4dC1zdG9yZS50cyc7XG5pbXBvcnQgdHlwZSB7IFJlcXVpcmVtZW50IH0gZnJvbSAnLi4vdHlwZXMudHMnO1xuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIEhlbHBlcnNcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG5mdW5jdGlvbiBtYWtlVG1wRGlyKCk6IHN0cmluZyB7XG4gIGNvbnN0IGRpciA9IGZzLm1rZHRlbXBTeW5jKHBhdGguam9pbihvcy50bXBkaXIoKSwgJ2dzZC10b29scy0nKSk7XG4gIGZzLm1rZGlyU3luYyhwYXRoLmpvaW4oZGlyLCAnLmdzZCcpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgcmV0dXJuIGRpcjtcbn1cblxuZnVuY3Rpb24gY2xlYW51cERpcihkaXI6IHN0cmluZyk6IHZvaWQge1xuICB0cnkge1xuICAgIGZzLnJtU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfSBjYXRjaCB7IC8qIHN3YWxsb3cgKi8gfVxufVxuXG4vKipcbiAqIFNpbXVsYXRlIHRvb2wgZXhlY3V0ZSBieSBjYWxsaW5nIHRoZSB1bmRlcmx5aW5nIERCIGZ1bmN0aW9ucyBkaXJlY3RseS5cbiAqIFRoZSBhY3R1YWwgdG9vbCByZWdpc3RyYXRpb24gaGFwcGVucyBpbiBpbmRleC50czsgaGVyZSB3ZSB0ZXN0IHRoZVxuICogZXhlY3V0ZSBsb2dpYyBwYXR0ZXJuOiBjaGVjayBEQiAtPiBjYWxsIHdyaXRlciAtPiByZXR1cm4gcmVzdWx0LlxuICovXG5cbmRlc2NyaWJlKCdnc2QtdG9vbHMnLCAoKSA9PiB7XG4gIHRlc3QoJ2dzZF9kZWNpc2lvbl9zYXZlJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHRtcERpciA9IG1ha2VUbXBEaXIoKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgZGJQYXRoID0gcGF0aC5qb2luKHRtcERpciwgJy5nc2QnLCAnZ3NkLmRiJyk7XG4gICAgICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcbiAgICAgIGFzc2VydC5vayhpc0RiQXZhaWxhYmxlKCksICdEQiBzaG91bGQgYmUgYXZhaWxhYmxlIGFmdGVyIG9wZW4nKTtcblxuICAgICAgLy8gKGEpIERlY2lzaW9uIHRvb2wgY3JlYXRlcyBEQiByb3cgKyByZXR1cm5zIG5ldyBJRFxuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgc2F2ZURlY2lzaW9uVG9EYihcbiAgICAgICAge1xuICAgICAgICAgIHNjb3BlOiAnYXJjaGl0ZWN0dXJlJyxcbiAgICAgICAgICBkZWNpc2lvbjogJ1VzZSBTUUxpdGUgZm9yIG1ldGFkYXRhJyxcbiAgICAgICAgICBjaG9pY2U6ICdTUUxpdGUnLFxuICAgICAgICAgIHJhdGlvbmFsZTogJ1N5bmMgQVBJIGZpdHMgdGhlIENMSSBtb2RlbCcsXG4gICAgICAgICAgcmV2aXNhYmxlOiAnWWVzJyxcbiAgICAgICAgICB3aGVuX2NvbnRleHQ6ICdNMDAxJyxcbiAgICAgICAgfSxcbiAgICAgICAgdG1wRGlyLFxuICAgICAgKTtcblxuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQuaWQsICdEMDAxJywgJ0ZpcnN0IGRlY2lzaW9uIHNob3VsZCBiZSBEMDAxJyk7XG5cbiAgICAgIC8vIEFEUi0wMTMgU3RhZ2UgMzogZGVjaXNpb25zIGxhbmQgaW4gbWVtb3JpZXMsIG5vdCB0aGUgbGVnYWN5IGRlY2lzaW9uc1xuICAgICAgLy8gdGFibGUuIFZlcmlmeSB0aGUgbWVtb3J5IHJvdyBjYXJyaWVzIHRoZSBzYW1lIGNvbnRlbnQuXG4gICAgICBjb25zdCBtZW1vcnlEZWNpc2lvbnMgPSBnZXRBbGxEZWNpc2lvbnNGcm9tTWVtb3JpZXMoKTtcbiAgICAgIGFzc2VydC5lcXVhbChtZW1vcnlEZWNpc2lvbnMubGVuZ3RoLCAxLCAnb25lIG1lbW9yeSByb3cgZXhpc3RzIGFmdGVyIHNhdmUnKTtcbiAgICAgIGNvbnN0IG1lbURlY2lzaW9uID0gbWVtb3J5RGVjaXNpb25zWzBdO1xuICAgICAgYXNzZXJ0Lm9rKG1lbURlY2lzaW9uLCAnbWVtb3J5IGRlY2lzaW9uIGV4aXN0cyBhZnRlciBzYXZlJyk7XG4gICAgICBhc3NlcnQuZXF1YWwobWVtRGVjaXNpb24uaWQsICdEMDAxJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKG1lbURlY2lzaW9uLnNjb3BlLCAnYXJjaGl0ZWN0dXJlJywgJ21lbW9yeSBkZWNpc2lvbiBzY29wZSBzaG91bGQgbWF0Y2gnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwobWVtRGVjaXNpb24uZGVjaXNpb24sICdVc2UgU1FMaXRlIGZvciBtZXRhZGF0YScsICdtZW1vcnkgZGVjaXNpb24gdGV4dCBzaG91bGQgbWF0Y2gnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwobWVtRGVjaXNpb24uY2hvaWNlLCAnU1FMaXRlJywgJ21lbW9yeSBkZWNpc2lvbiBjaG9pY2Ugc2hvdWxkIG1hdGNoJyk7XG5cbiAgICAgIC8vIFZlcmlmeSBERUNJU0lPTlMubWQgd2FzIGdlbmVyYXRlZFxuICAgICAgY29uc3QgbWRQYXRoID0gcGF0aC5qb2luKHRtcERpciwgJy5nc2QnLCAnREVDSVNJT05TLm1kJyk7XG4gICAgICBhc3NlcnQub2soZnMuZXhpc3RzU3luYyhtZFBhdGgpLCAnREVDSVNJT05TLm1kIHNob3VsZCBiZSBjcmVhdGVkJyk7XG4gICAgICBjb25zdCBtZENvbnRlbnQgPSBmcy5yZWFkRmlsZVN5bmMobWRQYXRoLCAndXRmLTgnKTtcbiAgICAgIGFzc2VydC5vayhtZENvbnRlbnQuaW5jbHVkZXMoJ0QwMDEnKSwgJ0RFQ0lTSU9OUy5tZCBzaG91bGQgY29udGFpbiBEMDAxJyk7XG4gICAgICBhc3NlcnQub2sobWRDb250ZW50LmluY2x1ZGVzKCdTUUxpdGUnKSwgJ0RFQ0lTSU9OUy5tZCBzaG91bGQgY29udGFpbiBjaG9pY2UnKTtcblxuICAgICAgLy8gKGUpIERlY2lzaW9uIHRvb2wgYXV0by1hc3NpZ25zIGNvcnJlY3QgbmV4dCBJRFxuICAgICAgY29uc3QgcmVzdWx0MiA9IGF3YWl0IHNhdmVEZWNpc2lvblRvRGIoXG4gICAgICAgIHtcbiAgICAgICAgICBzY29wZTogJ3Rlc3RpbmcnLFxuICAgICAgICAgIGRlY2lzaW9uOiAnVGVzdCBydW5uZXInLFxuICAgICAgICAgIGNob2ljZTogJ3ZpdGVzdCcsXG4gICAgICAgICAgcmF0aW9uYWxlOiAnRmFzdCBhbmQgRVNNLW5hdGl2ZScsXG4gICAgICAgIH0sXG4gICAgICAgIHRtcERpcixcbiAgICAgICk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdDIuaWQsICdEMDAyJywgJ1NlY29uZCBkZWNpc2lvbiBzaG91bGQgYmUgRDAwMicpO1xuXG4gICAgICBjb25zdCByZXN1bHQzID0gYXdhaXQgc2F2ZURlY2lzaW9uVG9EYihcbiAgICAgICAge1xuICAgICAgICAgIHNjb3BlOiAnQ0knLFxuICAgICAgICAgIGRlY2lzaW9uOiAnQ0kgcGxhdGZvcm0nLFxuICAgICAgICAgIGNob2ljZTogJ0dpdEh1YiBBY3Rpb25zJyxcbiAgICAgICAgICByYXRpb25hbGU6ICdJbnRlZ3JhdGVkIHdpdGggcmVwbycsXG4gICAgICAgIH0sXG4gICAgICAgIHRtcERpcixcbiAgICAgICk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdDMuaWQsICdEMDAzJywgJ1RoaXJkIGRlY2lzaW9uIHNob3VsZCBiZSBEMDAzJyk7XG5cbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cERpcih0bXBEaXIpO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdCgnZ3NkX3JlcXVpcmVtZW50X3VwZGF0ZScsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB0bXBEaXIgPSBtYWtlVG1wRGlyKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGRiUGF0aCA9IHBhdGguam9pbih0bXBEaXIsICcuZ3NkJywgJ2dzZC5kYicpO1xuICAgICAgb3BlbkRhdGFiYXNlKGRiUGF0aCk7XG5cbiAgICAgIC8vIFNlZWQgYSByZXF1aXJlbWVudFxuICAgICAgY29uc3Qgc2VlZFJlcTogUmVxdWlyZW1lbnQgPSB7XG4gICAgICAgIGlkOiAnUjAwMScsXG4gICAgICAgIGNsYXNzOiAnZnVuY3Rpb25hbCcsXG4gICAgICAgIHN0YXR1czogJ2FjdGl2ZScsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnTXVzdCBzdXBwb3J0IFNRTGl0ZSBzdG9yYWdlJyxcbiAgICAgICAgd2h5OiAnU3RydWN0dXJlZCBkYXRhIG5lZWRzJyxcbiAgICAgICAgc291cmNlOiAnZGVzaWduJyxcbiAgICAgICAgcHJpbWFyeV9vd25lcjogJ1MwMycsXG4gICAgICAgIHN1cHBvcnRpbmdfc2xpY2VzOiAnJyxcbiAgICAgICAgdmFsaWRhdGlvbjogJycsXG4gICAgICAgIG5vdGVzOiAnJyxcbiAgICAgICAgZnVsbF9jb250ZW50OiAnJyxcbiAgICAgICAgc3VwZXJzZWRlZF9ieTogbnVsbCxcbiAgICAgIH07XG4gICAgICB1cHNlcnRSZXF1aXJlbWVudChzZWVkUmVxKTtcblxuICAgICAgLy8gKGIpIFJlcXVpcmVtZW50IHVwZGF0ZSB0b29sIG1vZGlmaWVzIGV4aXN0aW5nIHJlcXVpcmVtZW50XG4gICAgICBhd2FpdCB1cGRhdGVSZXF1aXJlbWVudEluRGIoXG4gICAgICAgICdSMDAxJyxcbiAgICAgICAgeyBzdGF0dXM6ICd2YWxpZGF0ZWQnLCB2YWxpZGF0aW9uOiAnVW5pdCB0ZXN0cyBwYXNzJywgbm90ZXM6ICdWZXJpZmllZCBpbiBTMDYnIH0sXG4gICAgICAgIHRtcERpcixcbiAgICAgICk7XG5cbiAgICAgIGNvbnN0IHVwZGF0ZWQgPSBnZXRSZXF1aXJlbWVudEJ5SWQoJ1IwMDEnKTtcbiAgICAgIGFzc2VydC5vayh1cGRhdGVkICE9PSBudWxsLCAnUjAwMSBzaG91bGQgc3RpbGwgZXhpc3QnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwodXBkYXRlZCEuc3RhdHVzLCAndmFsaWRhdGVkJywgJ1N0YXR1cyBzaG91bGQgYmUgdXBkYXRlZCcpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbCh1cGRhdGVkIS52YWxpZGF0aW9uLCAnVW5pdCB0ZXN0cyBwYXNzJywgJ1ZhbGlkYXRpb24gc2hvdWxkIGJlIHVwZGF0ZWQnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwodXBkYXRlZCEubm90ZXMsICdWZXJpZmllZCBpbiBTMDYnLCAnTm90ZXMgc2hvdWxkIGJlIHVwZGF0ZWQnKTtcbiAgICAgIC8vIE9yaWdpbmFsIGZpZWxkcyBwcmVzZXJ2ZWRcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwodXBkYXRlZCEuZGVzY3JpcHRpb24sICdNdXN0IHN1cHBvcnQgU1FMaXRlIHN0b3JhZ2UnLCAnRGVzY3JpcHRpb24gc2hvdWxkIGJlIHByZXNlcnZlZCcpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbCh1cGRhdGVkIS5wcmltYXJ5X293bmVyLCAnUzAzJywgJ1ByaW1hcnkgb3duZXIgc2hvdWxkIGJlIHByZXNlcnZlZCcpO1xuXG4gICAgICAvLyBWZXJpZnkgUkVRVUlSRU1FTlRTLm1kIHdhcyBnZW5lcmF0ZWRcbiAgICAgIGNvbnN0IG1kUGF0aCA9IHBhdGguam9pbih0bXBEaXIsICcuZ3NkJywgJ1JFUVVJUkVNRU5UUy5tZCcpO1xuICAgICAgYXNzZXJ0Lm9rKGZzLmV4aXN0c1N5bmMobWRQYXRoKSwgJ1JFUVVJUkVNRU5UUy5tZCBzaG91bGQgYmUgY3JlYXRlZCcpO1xuICAgICAgY29uc3QgbWRDb250ZW50ID0gZnMucmVhZEZpbGVTeW5jKG1kUGF0aCwgJ3V0Zi04Jyk7XG4gICAgICBhc3NlcnQub2sobWRDb250ZW50LmluY2x1ZGVzKCdSMDAxJyksICdSRVFVSVJFTUVOVFMubWQgc2hvdWxkIGNvbnRhaW4gUjAwMScpO1xuICAgICAgYXNzZXJ0Lm9rKG1kQ29udGVudC5pbmNsdWRlcygndmFsaWRhdGVkJyksICdSRVFVSVJFTUVOVFMubWQgc2hvdWxkIHJlZmxlY3QgdXBkYXRlZCBzdGF0dXMnKTtcblxuICAgICAgLy8gVXBkYXRpbmcgbm9uLWV4aXN0ZW50IHJlcXVpcmVtZW50IHVwc2VydHMgKGNyZWF0ZXMgaXQpIFx1MjAxNCBzZWUgIzI5MTlcbiAgICAgIGF3YWl0IHVwZGF0ZVJlcXVpcmVtZW50SW5EYignUjk5OScsIHsgc3RhdHVzOiAnZGVmZXJyZWQnIH0sIHRtcERpcik7XG4gICAgICBjb25zdCB1cHNlcnRlZCA9IGdldFJlcXVpcmVtZW50QnlJZCgnUjk5OScpO1xuICAgICAgYXNzZXJ0Lm9rKHVwc2VydGVkICE9PSBudWxsLCAnUjk5OSBzaG91bGQgYmUgY3JlYXRlZCBieSB1cHNlcnQnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwodXBzZXJ0ZWQhLnN0YXR1cywgJ2RlZmVycmVkJywgJ1Vwc2VydGVkIHJlcXVpcmVtZW50IHNob3VsZCBoYXZlIHRoZSB1cGRhdGVkIHN0YXR1cycpO1xuXG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXBEaXIodG1wRGlyKTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoJ2dzZF9zdW1tYXJ5X3NhdmUnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgdG1wRGlyID0gbWFrZVRtcERpcigpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBkYlBhdGggPSBwYXRoLmpvaW4odG1wRGlyLCAnLmdzZCcsICdnc2QuZGInKTtcbiAgICAgIG9wZW5EYXRhYmFzZShkYlBhdGgpO1xuXG4gICAgICAvLyAoYykgU3VtbWFyeSB0b29sIGNyZWF0ZXMgYXJ0aWZhY3Qgcm93XG4gICAgICBhd2FpdCBzYXZlQXJ0aWZhY3RUb0RiKFxuICAgICAgICB7XG4gICAgICAgICAgcGF0aDogJ21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzAxL1MwMS1TVU1NQVJZLm1kJyxcbiAgICAgICAgICBhcnRpZmFjdF90eXBlOiAnU1VNTUFSWScsXG4gICAgICAgICAgY29udGVudDogJyMgUzAxIFN1bW1hcnlcXG5cXG5UaGlzIGlzIGEgdGVzdCBzdW1tYXJ5LicsXG4gICAgICAgICAgbWlsZXN0b25lX2lkOiAnTTAwMScsXG4gICAgICAgICAgc2xpY2VfaWQ6ICdTMDEnLFxuICAgICAgICB9LFxuICAgICAgICB0bXBEaXIsXG4gICAgICApO1xuXG4gICAgICAvLyBWZXJpZnkgYXJ0aWZhY3QgaW4gREJcbiAgICAgIGNvbnN0IGFkYXB0ZXIgPSBfZ2V0QWRhcHRlcigpO1xuICAgICAgYXNzZXJ0Lm9rKGFkYXB0ZXIgIT09IG51bGwsICdBZGFwdGVyIHNob3VsZCBiZSBhdmFpbGFibGUnKTtcbiAgICAgIGNvbnN0IHJvd3MgPSBhZGFwdGVyIS5wcmVwYXJlKFxuICAgICAgICBcIlNFTEVDVCAqIEZST00gYXJ0aWZhY3RzIFdIRVJFIHBhdGggPSAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvUzAxLVNVTU1BUlkubWQnXCIsXG4gICAgICApLmFsbCgpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyb3dzLmxlbmd0aCwgMSwgJ1Nob3VsZCBoYXZlIDEgYXJ0aWZhY3Qgcm93Jyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJvd3NbMF1bJ2FydGlmYWN0X3R5cGUnXSBhcyBzdHJpbmcsICdTVU1NQVJZJywgJ0FydGlmYWN0IHR5cGUgc2hvdWxkIGJlIFNVTU1BUlknKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocm93c1swXVsnbWlsZXN0b25lX2lkJ10gYXMgc3RyaW5nLCAnTTAwMScsICdNaWxlc3RvbmUgSUQgc2hvdWxkIG1hdGNoJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJvd3NbMF1bJ3NsaWNlX2lkJ10gYXMgc3RyaW5nLCAnUzAxJywgJ1NsaWNlIElEIHNob3VsZCBtYXRjaCcpO1xuXG4gICAgICAvLyBWZXJpZnkgZmlsZSB3YXMgd3JpdHRlbiB0byBkaXNrXG4gICAgICBjb25zdCBmaWxlUGF0aCA9IHBhdGguam9pbih0bXBEaXIsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScsICdzbGljZXMnLCAnUzAxJywgJ1MwMS1TVU1NQVJZLm1kJyk7XG4gICAgICBhc3NlcnQub2soZnMuZXhpc3RzU3luYyhmaWxlUGF0aCksICdTdW1tYXJ5IGZpbGUgc2hvdWxkIGJlIHdyaXR0ZW4gdG8gZGlzaycpO1xuICAgICAgY29uc3QgZmlsZUNvbnRlbnQgPSBmcy5yZWFkRmlsZVN5bmMoZmlsZVBhdGgsICd1dGYtOCcpO1xuICAgICAgYXNzZXJ0Lm9rKGZpbGVDb250ZW50LmluY2x1ZGVzKCdTMDEgU3VtbWFyeScpLCAnRmlsZSBzaG91bGQgY29udGFpbiBzdW1tYXJ5IGNvbnRlbnQnKTtcblxuICAgICAgLy8gVGVzdCBtaWxlc3RvbmUtbGV2ZWwgYXJ0aWZhY3QgKG5vIHNsaWNlX2lkKVxuICAgICAgYXdhaXQgc2F2ZUFydGlmYWN0VG9EYihcbiAgICAgICAge1xuICAgICAgICAgIHBhdGg6ICdtaWxlc3RvbmVzL00wMDEvTTAwMS1DT05URVhULm1kJyxcbiAgICAgICAgICBhcnRpZmFjdF90eXBlOiAnQ09OVEVYVCcsXG4gICAgICAgICAgY29udGVudDogJyMgTTAwMSBDb250ZXh0XFxuXFxuQ29udGV4dCBub3Rlcy4nLFxuICAgICAgICAgIG1pbGVzdG9uZV9pZDogJ00wMDEnLFxuICAgICAgICB9LFxuICAgICAgICB0bXBEaXIsXG4gICAgICApO1xuXG4gICAgICBjb25zdCBtRmlsZVBhdGggPSBwYXRoLmpvaW4odG1wRGlyLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgJ00wMDEnLCAnTTAwMS1DT05URVhULm1kJyk7XG4gICAgICBhc3NlcnQub2soZnMuZXhpc3RzU3luYyhtRmlsZVBhdGgpLCAnTWlsZXN0b25lLWxldmVsIGFydGlmYWN0IGZpbGUgc2hvdWxkIGJlIGNyZWF0ZWQnKTtcblxuICAgICAgLy8gVGVzdCB0YXNrLWxldmVsIGFydGlmYWN0XG4gICAgICBhd2FpdCBzYXZlQXJ0aWZhY3RUb0RiKFxuICAgICAgICB7XG4gICAgICAgICAgcGF0aDogJ21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzAxL3Rhc2tzL1QwMS1TVU1NQVJZLm1kJyxcbiAgICAgICAgICBhcnRpZmFjdF90eXBlOiAnU1VNTUFSWScsXG4gICAgICAgICAgY29udGVudDogJyMgVDAxIFN1bW1hcnlcXG5cXG5UYXNrIHN1bW1hcnkuJyxcbiAgICAgICAgICBtaWxlc3RvbmVfaWQ6ICdNMDAxJyxcbiAgICAgICAgICBzbGljZV9pZDogJ1MwMScsXG4gICAgICAgICAgdGFza19pZDogJ1QwMScsXG4gICAgICAgIH0sXG4gICAgICAgIHRtcERpcixcbiAgICAgICk7XG5cbiAgICAgIGNvbnN0IHRGaWxlUGF0aCA9IHBhdGguam9pbih0bXBEaXIsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScsICdzbGljZXMnLCAnUzAxJywgJ3Rhc2tzJywgJ1QwMS1TVU1NQVJZLm1kJyk7XG4gICAgICBhc3NlcnQub2soZnMuZXhpc3RzU3luYyh0RmlsZVBhdGgpLCAnVGFzay1sZXZlbCBhcnRpZmFjdCBmaWxlIHNob3VsZCBiZSBjcmVhdGVkJyk7XG5cbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cERpcih0bXBEaXIpO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdCgnZ3NkX3N1bW1hcnlfc2F2ZSBzdXBwb3J0cyBDT05URVhULURSQUZUIHBlcnNpc3RlbmNlJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHRtcERpciA9IG1ha2VUbXBEaXIoKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgZGJQYXRoID0gcGF0aC5qb2luKHRtcERpciwgJy5nc2QnLCAnZ3NkLmRiJyk7XG4gICAgICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcblxuICAgICAgYXdhaXQgc2F2ZUFydGlmYWN0VG9EYihcbiAgICAgICAge1xuICAgICAgICAgIHBhdGg6ICdtaWxlc3RvbmVzL00wMDEvTTAwMS1DT05URVhULURSQUZULm1kJyxcbiAgICAgICAgICBhcnRpZmFjdF90eXBlOiAnQ09OVEVYVC1EUkFGVCcsXG4gICAgICAgICAgY29udGVudDogJyMgTTAwMSBEcmFmdCBDb250ZXh0XFxuXFxuRHJhZnQgbm90ZXMuJyxcbiAgICAgICAgICBtaWxlc3RvbmVfaWQ6ICdNMDAxJyxcbiAgICAgICAgfSxcbiAgICAgICAgdG1wRGlyLFxuICAgICAgKTtcblxuICAgICAgY29uc3QgZHJhZnRQYXRoID0gcGF0aC5qb2luKHRtcERpciwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAxJywgJ00wMDEtQ09OVEVYVC1EUkFGVC5tZCcpO1xuICAgICAgYXNzZXJ0Lm9rKGZzLmV4aXN0c1N5bmMoZHJhZnRQYXRoKSwgJ0RyYWZ0IGNvbnRleHQgZmlsZSBzaG91bGQgYmUgY3JlYXRlZCcpO1xuICAgICAgY29uc3QgZHJhZnRDb250ZW50ID0gZnMucmVhZEZpbGVTeW5jKGRyYWZ0UGF0aCwgJ3V0Zi04Jyk7XG4gICAgICBhc3NlcnQub2soZHJhZnRDb250ZW50LmluY2x1ZGVzKCdEcmFmdCBDb250ZXh0JyksICdEcmFmdCBjb250ZXh0IGZpbGUgc2hvdWxkIGNvbnRhaW4gZHJhZnQgY29udGVudCcpO1xuXG4gICAgICBjb25zdCBhZGFwdGVyID0gX2dldEFkYXB0ZXIoKTtcbiAgICAgIGFzc2VydC5vayhhZGFwdGVyICE9PSBudWxsLCAnQWRhcHRlciBzaG91bGQgYmUgYXZhaWxhYmxlJyk7XG4gICAgICBjb25zdCByb3dzID0gYWRhcHRlciEucHJlcGFyZShcbiAgICAgICAgXCJTRUxFQ1QgKiBGUk9NIGFydGlmYWN0cyBXSEVSRSBwYXRoID0gJ21pbGVzdG9uZXMvTTAwMS9NMDAxLUNPTlRFWFQtRFJBRlQubWQnXCIsXG4gICAgICApLmFsbCgpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyb3dzLmxlbmd0aCwgMSwgJ1Nob3VsZCBoYXZlIDEgZHJhZnQgYXJ0aWZhY3Qgcm93Jyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJvd3NbMF1bJ2FydGlmYWN0X3R5cGUnXSBhcyBzdHJpbmcsICdDT05URVhULURSQUZUJywgJ0FydGlmYWN0IHR5cGUgc2hvdWxkIGJlIENPTlRFWFQtRFJBRlQnKTtcblxuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwRGlyKHRtcERpcik7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KCdEQiB1bmF2YWlsYWJsZSBlcnJvciBwYXRocycsIGFzeW5jICgpID0+IHtcbiAgICAvLyAoZCkgQWxsIHRvb2xzIHJldHVybiBpc0Vycm9yIHdoZW4gREIgdW5hdmFpbGFibGVcbiAgICAvLyBDbG9zZSBhbnkgb3BlbiBEQiBhbmQgZG9uJ3Qgb3BlbiBhIG5ldyBvbmVcbiAgICB0cnkgeyBjbG9zZURhdGFiYXNlKCk7IH0gY2F0Y2ggeyAvKiBhbHJlYWR5IGNsb3NlZCAqLyB9XG5cbiAgICAvLyBpc0RiQXZhaWxhYmxlKCkgc2hvdWxkIHJldHVybiBmYWxzZVxuICAgIGFzc2VydC5vayghaXNEYkF2YWlsYWJsZSgpLCAnREIgc2hvdWxkIGJlIHVuYXZhaWxhYmxlIGFmdGVyIGNsb3NlJyk7XG5cbiAgICAvLyBuZXh0RGVjaXNpb25JZCBkZWdyYWRlcyBncmFjZWZ1bGx5XG4gICAgY29uc3QgZmFsbGJhY2tJZCA9IGF3YWl0IG5leHREZWNpc2lvbklkKCk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChmYWxsYmFja0lkLCAnRDAwMScsICduZXh0RGVjaXNpb25JZCBzaG91bGQgcmV0dXJuIEQwMDEgd2hlbiBEQiB1bmF2YWlsYWJsZScpO1xuICB9KTtcblxuICB0ZXN0KCdnc2RfcmVxdWlyZW1lbnRfc2F2ZSBjcmVhdGVzIG5ldyByZXF1aXJlbWVudCcsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB0bXBEaXIgPSBtYWtlVG1wRGlyKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGRiUGF0aCA9IHBhdGguam9pbih0bXBEaXIsICcuZ3NkJywgJ2dzZC5kYicpO1xuICAgICAgb3BlbkRhdGFiYXNlKGRiUGF0aCk7XG5cbiAgICAgIC8vIChhKSBzYXZlUmVxdWlyZW1lbnRUb0RiIGNyZWF0ZXMgYSBuZXcgcmVxdWlyZW1lbnQgd2l0aCBhdXRvLWFzc2lnbmVkIElEXG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBzYXZlUmVxdWlyZW1lbnRUb0RiKFxuICAgICAgICB7XG4gICAgICAgICAgY2xhc3M6ICdmdW5jdGlvbmFsJyxcbiAgICAgICAgICBzdGF0dXM6ICdhY3RpdmUnLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiAnTXVzdCBzdXBwb3J0IGRhcmsgbW9kZScsXG4gICAgICAgICAgd2h5OiAnQWNjZXNzaWJpbGl0eSByZXF1aXJlbWVudCcsXG4gICAgICAgICAgc291cmNlOiAndXNlci1yZXNlYXJjaCcsXG4gICAgICAgIH0sXG4gICAgICAgIHRtcERpcixcbiAgICAgICk7XG5cbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0LmlkLCAnUjAwMScsICdGaXJzdCByZXF1aXJlbWVudCBzaG91bGQgYmUgUjAwMScpO1xuXG4gICAgICAvLyBWZXJpZnkgREIgcm93IGV4aXN0c1xuICAgICAgY29uc3Qgcm93ID0gZ2V0UmVxdWlyZW1lbnRCeUlkKCdSMDAxJyk7XG4gICAgICBhc3NlcnQub2socm93ICE9PSBudWxsLCAnUmVxdWlyZW1lbnQgUjAwMSBzaG91bGQgZXhpc3QgaW4gREInKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocm93IS5jbGFzcywgJ2Z1bmN0aW9uYWwnLCAnQ2xhc3Mgc2hvdWxkIG1hdGNoJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJvdyEuZGVzY3JpcHRpb24sICdNdXN0IHN1cHBvcnQgZGFyayBtb2RlJywgJ0Rlc2NyaXB0aW9uIHNob3VsZCBtYXRjaCcpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyb3chLnN0YXR1cywgJ2FjdGl2ZScsICdTdGF0dXMgc2hvdWxkIG1hdGNoJyk7XG5cbiAgICAgIC8vIFZlcmlmeSBSRVFVSVJFTUVOVFMubWQgd2FzIGdlbmVyYXRlZFxuICAgICAgY29uc3QgbWRQYXRoID0gcGF0aC5qb2luKHRtcERpciwgJy5nc2QnLCAnUkVRVUlSRU1FTlRTLm1kJyk7XG4gICAgICBhc3NlcnQub2soZnMuZXhpc3RzU3luYyhtZFBhdGgpLCAnUkVRVUlSRU1FTlRTLm1kIHNob3VsZCBiZSBjcmVhdGVkJyk7XG4gICAgICBjb25zdCBtZENvbnRlbnQgPSBmcy5yZWFkRmlsZVN5bmMobWRQYXRoLCAndXRmLTgnKTtcbiAgICAgIGFzc2VydC5vayhtZENvbnRlbnQuaW5jbHVkZXMoJ1IwMDEnKSwgJ1JFUVVJUkVNRU5UUy5tZCBzaG91bGQgY29udGFpbiBSMDAxJyk7XG4gICAgICBhc3NlcnQub2sobWRDb250ZW50LmluY2x1ZGVzKCdkYXJrIG1vZGUnKSwgJ1JFUVVJUkVNRU5UUy5tZCBzaG91bGQgY29udGFpbiBkZXNjcmlwdGlvbicpO1xuXG4gICAgICAvLyAoYikgQXV0by1hc3NpZ25zIGNvcnJlY3QgbmV4dCBJRFxuICAgICAgY29uc3QgcmVzdWx0MiA9IGF3YWl0IHNhdmVSZXF1aXJlbWVudFRvRGIoXG4gICAgICAgIHtcbiAgICAgICAgICBjbGFzczogJ25vbi1mdW5jdGlvbmFsJyxcbiAgICAgICAgICBzdGF0dXM6ICdhY3RpdmUnLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiAnTXVzdCBsb2FkIGluIHVuZGVyIDIgc2Vjb25kcycsXG4gICAgICAgICAgd2h5OiAnUGVyZm9ybWFuY2UgU0xBJyxcbiAgICAgICAgICBzb3VyY2U6ICdkZXNpZ24nLFxuICAgICAgICB9LFxuICAgICAgICB0bXBEaXIsXG4gICAgICApO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQyLmlkLCAnUjAwMicsICdTZWNvbmQgcmVxdWlyZW1lbnQgc2hvdWxkIGJlIFIwMDInKTtcblxuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwRGlyKHRtcERpcik7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KCduZXh0UmVxdWlyZW1lbnRJZCBjb21wdXRlcyBjb3JyZWN0IG5leHQgSUQnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgdG1wRGlyID0gbWFrZVRtcERpcigpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBkYlBhdGggPSBwYXRoLmpvaW4odG1wRGlyLCAnLmdzZCcsICdnc2QuZGInKTtcbiAgICAgIG9wZW5EYXRhYmFzZShkYlBhdGgpO1xuXG4gICAgICAvLyBObyByZXF1aXJlbWVudHMgeWV0XG4gICAgICBjb25zdCBpZDEgPSBhd2FpdCBuZXh0UmVxdWlyZW1lbnRJZCgpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChpZDEsICdSMDAxJywgJ1Nob3VsZCByZXR1cm4gUjAwMSB3aGVuIG5vIHJlcXVpcmVtZW50cyBleGlzdCcpO1xuXG4gICAgICAvLyBBZGQgb25lIHJlcXVpcmVtZW50XG4gICAgICB1cHNlcnRSZXF1aXJlbWVudCh7XG4gICAgICAgIGlkOiAnUjAwMScsXG4gICAgICAgIGNsYXNzOiAnZnVuY3Rpb25hbCcsXG4gICAgICAgIHN0YXR1czogJ2FjdGl2ZScsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnVGVzdCcsXG4gICAgICAgIHdoeTogJycsXG4gICAgICAgIHNvdXJjZTogJycsXG4gICAgICAgIHByaW1hcnlfb3duZXI6ICcnLFxuICAgICAgICBzdXBwb3J0aW5nX3NsaWNlczogJycsXG4gICAgICAgIHZhbGlkYXRpb246ICcnLFxuICAgICAgICBub3RlczogJycsXG4gICAgICAgIGZ1bGxfY29udGVudDogJycsXG4gICAgICAgIHN1cGVyc2VkZWRfYnk6IG51bGwsXG4gICAgICB9KTtcblxuICAgICAgY29uc3QgaWQyID0gYXdhaXQgbmV4dFJlcXVpcmVtZW50SWQoKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoaWQyLCAnUjAwMicsICdTaG91bGQgcmV0dXJuIFIwMDIgYWZ0ZXIgUjAwMSBleGlzdHMnKTtcblxuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwRGlyKHRtcERpcik7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KCdnc2RfcmVxdWlyZW1lbnRfdXBkYXRlIHVwc2VydHMgd2hlbiByZXF1aXJlbWVudCBub3QgaW4gREInLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgdG1wRGlyID0gbWFrZVRtcERpcigpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBkYlBhdGggPSBwYXRoLmpvaW4odG1wRGlyLCAnLmdzZCcsICdnc2QuZGInKTtcbiAgICAgIG9wZW5EYXRhYmFzZShkYlBhdGgpO1xuXG4gICAgICAvLyBSZXF1aXJlbWVudCBSMDI1IGRvZXMgTk9UIGV4aXN0IGluIERCIFx1MjAxNCBzaW11bGF0ZXMgdGhlIGJ1ZyBzY2VuYXJpb1xuICAgICAgLy8gd2hlcmUgcmVxdWlyZW1lbnRzIGV4aXN0IGluIFJFUVVJUkVNRU5UUy5tZCBidXQgd2VyZSBuZXZlciBpbXBvcnRlZC5cbiAgICAgIC8vIHVwZGF0ZVJlcXVpcmVtZW50SW5EYiBzaG91bGQgY3JlYXRlIHRoZSByb3cgaW5zdGVhZCBvZiB0aHJvd2luZy5cbiAgICAgIGF3YWl0IHVwZGF0ZVJlcXVpcmVtZW50SW5EYihcbiAgICAgICAgJ1IwMjUnLFxuICAgICAgICB7IHN0YXR1czogJ3ZhbGlkYXRlZCcsIHZhbGlkYXRpb246ICdJbnRlZ3JhdGlvbiB0ZXN0cyBwYXNzJyB9LFxuICAgICAgICB0bXBEaXIsXG4gICAgICApO1xuXG4gICAgICBjb25zdCBjcmVhdGVkID0gZ2V0UmVxdWlyZW1lbnRCeUlkKCdSMDI1Jyk7XG4gICAgICBhc3NlcnQub2soY3JlYXRlZCAhPT0gbnVsbCwgJ1IwMjUgc2hvdWxkIGJlIGNyZWF0ZWQgYnkgdXBzZXJ0Jyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGNyZWF0ZWQhLnN0YXR1cywgJ3ZhbGlkYXRlZCcsICdTdGF0dXMgc2hvdWxkIGJlIHNldCcpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChjcmVhdGVkIS52YWxpZGF0aW9uLCAnSW50ZWdyYXRpb24gdGVzdHMgcGFzcycsICdWYWxpZGF0aW9uIHNob3VsZCBiZSBzZXQnKTtcblxuICAgICAgLy8gVmVyaWZ5IFJFUVVJUkVNRU5UUy5tZCB3YXMgZ2VuZXJhdGVkXG4gICAgICBjb25zdCBtZFBhdGggPSBwYXRoLmpvaW4odG1wRGlyLCAnLmdzZCcsICdSRVFVSVJFTUVOVFMubWQnKTtcbiAgICAgIGFzc2VydC5vayhmcy5leGlzdHNTeW5jKG1kUGF0aCksICdSRVFVSVJFTUVOVFMubWQgc2hvdWxkIGJlIGNyZWF0ZWQnKTtcblxuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwRGlyKHRtcERpcik7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KCdUb29sIHJlc3VsdCBmb3JtYXQnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgdG1wRGlyID0gbWFrZVRtcERpcigpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBkYlBhdGggPSBwYXRoLmpvaW4odG1wRGlyLCAnLmdzZCcsICdnc2QuZGInKTtcbiAgICAgIG9wZW5EYXRhYmFzZShkYlBhdGgpO1xuXG4gICAgICAvLyBWZXJpZnkgcmVzdWx0IGZvbGxvd3MgQWdlbnRUb29sUmVzdWx0IGludGVyZmFjZToge2NvbnRlbnQ6IFt7dHlwZTogXCJ0ZXh0XCIsIHRleHR9XSwgZGV0YWlsc31cbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHNhdmVEZWNpc2lvblRvRGIoXG4gICAgICAgIHtcbiAgICAgICAgICBzY29wZTogJ2Zvcm1hdC10ZXN0JyxcbiAgICAgICAgICBkZWNpc2lvbjogJ1Rlc3QgZm9ybWF0JyxcbiAgICAgICAgICBjaG9pY2U6ICdUeXBlQm94JyxcbiAgICAgICAgICByYXRpb25hbGU6ICdTY2hlbWEgdmFsaWRhdGlvbicsXG4gICAgICAgIH0sXG4gICAgICAgIHRtcERpcixcbiAgICAgICk7XG5cbiAgICAgIC8vIFRoZSBzYXZlRGVjaXNpb25Ub0RiIHJldHVybnMge2lkfSAtIHRoZSB0b29sIHdyYXBwaW5nIGFkZHMgdGhlIEFnZW50VG9vbFJlc3VsdCBzaGFwZS5cbiAgICAgIC8vIFZlcmlmeSB0aGUgcmF3IGZ1bmN0aW9uIHJldHVybnMgdGhlIGV4cGVjdGVkIHNoYXBlLlxuICAgICAgYXNzZXJ0Lm9rKHR5cGVvZiByZXN1bHQuaWQgPT09ICdzdHJpbmcnLCAnc2F2ZURlY2lzaW9uVG9EYiBzaG91bGQgcmV0dXJuIHtpZDogc3RyaW5nfScpO1xuICAgICAgYXNzZXJ0Lm1hdGNoKHJlc3VsdC5pZCwgL15EXFxkezN9JC8sICdJRCBzaG91bGQgbWF0Y2ggRFhYWCBwYXR0ZXJuJyk7XG5cbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cERpcih0bXBEaXIpO1xuICAgIH1cbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFNBQVMsVUFBVSxZQUFZO0FBQy9CLE9BQU8sWUFBWTtBQU1uQixZQUFZLFVBQVU7QUFDdEIsWUFBWSxRQUFRO0FBQ3BCLFlBQVksUUFBUTtBQUNwQjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BRUs7QUFDUDtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFDUCxTQUFTLG1DQUFtQztBQU81QyxTQUFTLGFBQXFCO0FBQzVCLFFBQU0sTUFBTSxHQUFHLFlBQVksS0FBSyxLQUFLLEdBQUcsT0FBTyxHQUFHLFlBQVksQ0FBQztBQUMvRCxLQUFHLFVBQVUsS0FBSyxLQUFLLEtBQUssTUFBTSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDeEQsU0FBTztBQUNUO0FBRUEsU0FBUyxXQUFXLEtBQW1CO0FBQ3JDLE1BQUk7QUFDRixPQUFHLE9B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
