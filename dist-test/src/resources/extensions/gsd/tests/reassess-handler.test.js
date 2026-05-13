import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertAssessment,
  getSlice,
  getMilestoneSlices,
  getAssessment,
  _getAdapter
} from "../gsd-db.js";
import { handleReassessRoadmap } from "../tools/reassess-roadmap.js";
function makeTmpBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-reassess-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S02"), { recursive: true });
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S03"), { recursive: true });
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
function seedMilestoneWithSlices(opts) {
  insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice One", status: opts?.s01Status ?? "complete", demo: "Demo one." });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Slice Two", status: opts?.s02Status ?? "pending", demo: "Demo two." });
  insertSlice({ id: "S03", milestoneId: "M001", title: "Slice Three", status: opts?.s03Status ?? "pending", demo: "Demo three." });
}
function validReassessParams() {
  return {
    milestoneId: "M001",
    completedSliceId: "S01",
    verdict: "confirmed",
    assessment: "S01 completed successfully. Roadmap is on track.",
    sliceChanges: {
      modified: [
        {
          sliceId: "S02",
          title: "Updated Slice Two",
          risk: "high",
          depends: ["S01"],
          demo: "Updated demo two."
        }
      ],
      added: [
        {
          sliceId: "S04",
          title: "New Slice Four",
          risk: "low",
          depends: ["S02"],
          demo: "Demo four."
        }
      ],
      removed: ["S03"]
    }
  };
}
test("handleReassessRoadmap rejects invalid payloads (missing milestoneId)", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedMilestoneWithSlices();
    const result = await handleReassessRoadmap({ ...validReassessParams(), milestoneId: "" }, base);
    assert.ok("error" in result);
    assert.match(result.error, /validation failed/);
    assert.match(result.error, /milestoneId/);
  } finally {
    cleanup(base);
  }
});
test("handleReassessRoadmap rejects missing milestone", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    const result = await handleReassessRoadmap(validReassessParams(), base);
    assert.ok("error" in result);
    assert.match(result.error, /not found/);
  } finally {
    cleanup(base);
  }
});
test("handleReassessRoadmap rejects structural violation: modifying a completed slice", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedMilestoneWithSlices({ s01Status: "complete", s02Status: "pending", s03Status: "pending" });
    const result = await handleReassessRoadmap({
      ...validReassessParams(),
      sliceChanges: {
        modified: [{ sliceId: "S01", title: "Trying to modify completed S01" }],
        added: [],
        removed: []
      }
    }, base);
    assert.ok("error" in result);
    assert.match(result.error, /completed slice/);
    assert.match(result.error, /S01/);
  } finally {
    cleanup(base);
  }
});
test("handleReassessRoadmap rejects structural violation: removing a completed slice", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedMilestoneWithSlices({ s01Status: "complete", s02Status: "pending", s03Status: "pending" });
    const result = await handleReassessRoadmap({
      ...validReassessParams(),
      sliceChanges: {
        modified: [],
        added: [],
        removed: ["S01"]
      }
    }, base);
    assert.ok("error" in result);
    assert.match(result.error, /completed slice/);
    assert.match(result.error, /S01/);
  } finally {
    cleanup(base);
  }
});
test("handleReassessRoadmap succeeds when modifying only pending slices", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedMilestoneWithSlices({ s01Status: "complete", s02Status: "pending", s03Status: "pending" });
    const params = validReassessParams();
    const result = await handleReassessRoadmap(params, base);
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    const assessmentPath = join(".gsd", "milestones", "M001", "slices", "S01", "S01-ASSESSMENT.md");
    const assessment = getAssessment(assessmentPath);
    assert.ok(assessment, "assessment row should exist in DB");
    assert.equal(assessment["milestone_id"], "M001");
    assert.equal(assessment["status"], "confirmed");
    assert.equal(assessment["scope"], "roadmap");
    assert.ok(assessment["full_content"].includes("S01 completed successfully"), "assessment content should be stored");
    const s02 = getSlice("M001", "S02");
    assert.ok(s02, "S02 should still exist");
    assert.equal(s02?.title, "Updated Slice Two");
    assert.equal(s02?.risk, "high");
    assert.equal(s02?.demo, "Updated demo two.");
    const s03 = getSlice("M001", "S03");
    assert.equal(s03, null, "S03 should have been deleted");
    const s04 = getSlice("M001", "S04");
    assert.ok(s04, "S04 should exist as a new slice");
    assert.equal(s04?.title, "New Slice Four");
    assert.equal(s04?.status, "pending");
    const s01 = getSlice("M001", "S01");
    assert.ok(s01, "S01 should still exist");
    assert.equal(s01?.status, "complete");
    const roadmapPath = join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md");
    assert.ok(existsSync(roadmapPath), "ROADMAP.md should be rendered to disk");
    const roadmapContent = readFileSync(roadmapPath, "utf-8");
    assert.ok(roadmapContent.includes("Updated Slice Two"), "ROADMAP.md should contain updated S02 title");
    const assessmentDiskPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-ASSESSMENT.md");
    assert.ok(existsSync(assessmentDiskPath), "ASSESSMENT.md should be rendered to disk");
    const assessmentContent = readFileSync(assessmentDiskPath, "utf-8");
    assert.ok(assessmentContent.includes("confirmed"), "ASSESSMENT.md should contain verdict");
    assert.ok(assessmentContent.includes("S01"), "ASSESSMENT.md should reference completed slice");
  } finally {
    cleanup(base);
  }
});
test("handleReassessRoadmap cache invalidation: getMilestoneSlices reflects mutations", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedMilestoneWithSlices({ s01Status: "complete", s02Status: "pending", s03Status: "pending" });
    const params = validReassessParams();
    const result = await handleReassessRoadmap(params, base);
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    const slices = getMilestoneSlices("M001");
    const sliceIds = slices.map((s) => s.id);
    assert.ok(sliceIds.includes("S01"), "S01 should still exist after reassess");
    assert.ok(sliceIds.includes("S02"), "S02 should still exist after reassess");
    assert.ok(!sliceIds.includes("S03"), "S03 should be gone after removal");
    assert.ok(sliceIds.includes("S04"), "S04 should exist after addition");
  } finally {
    cleanup(base);
  }
});
test("handleReassessRoadmap is idempotent: calling twice with same params succeeds", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedMilestoneWithSlices({ s01Status: "complete", s02Status: "pending", s03Status: "pending" });
    const params = validReassessParams();
    const first = await handleReassessRoadmap(params, base);
    assert.ok(!("error" in first), `first call error: ${"error" in first ? first.error : ""}`);
    const second = await handleReassessRoadmap(params, base);
    assert.ok(!("error" in second), `second call error: ${"error" in second ? second.error : ""}`);
  } finally {
    cleanup(base);
  }
});
test('handleReassessRoadmap rejects slice with status "done" (alias for complete)', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedMilestoneWithSlices({ s01Status: "done", s02Status: "pending", s03Status: "pending" });
    const result = await handleReassessRoadmap({
      ...validReassessParams(),
      sliceChanges: {
        modified: [{ sliceId: "S01", title: "Trying to modify done S01" }],
        added: [],
        removed: []
      }
    }, base);
    assert.ok("error" in result);
    assert.match(result.error, /completed slice/);
    assert.match(result.error, /S01/);
  } finally {
    cleanup(base);
  }
});
test("handleReassessRoadmap returns structured error payloads with actionable messages", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedMilestoneWithSlices({ s01Status: "complete", s02Status: "complete", s03Status: "pending" });
    const modifyResult = await handleReassessRoadmap({
      ...validReassessParams(),
      sliceChanges: {
        modified: [{ sliceId: "S01", title: "x" }],
        added: [],
        removed: []
      }
    }, base);
    assert.ok("error" in modifyResult);
    assert.ok(typeof modifyResult.error === "string", "error should be a string");
    assert.ok(modifyResult.error.includes("S01"), "error should name the specific slice ID S01");
    const removeResult = await handleReassessRoadmap({
      ...validReassessParams(),
      sliceChanges: {
        modified: [],
        added: [],
        removed: ["S02"]
      }
    }, base);
    assert.ok("error" in removeResult);
    assert.ok(removeResult.error.includes("S02"), "error should name the specific slice ID S02");
  } finally {
    cleanup(base);
  }
});
test("handleReassessRoadmap invalidates stale milestone-validation when roadmap changes (#2957)", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice One", status: "complete", demo: "Demo" });
    insertSlice({ id: "S02", milestoneId: "M001", title: "Slice Two", status: "complete", demo: "Demo" });
    insertSlice({ id: "S03", milestoneId: "M001", title: "Slice Three", status: "complete", demo: "Demo" });
    insertSlice({ id: "S04", milestoneId: "M001", title: "Slice Four", status: "complete", demo: "Demo" });
    const validationPath = join(".gsd", "milestones", "M001", "M001-VALIDATION.md");
    insertAssessment({
      path: validationPath,
      milestoneId: "M001",
      sliceId: null,
      taskId: null,
      status: "needs-remediation",
      scope: "milestone-validation",
      fullContent: "---\nverdict: needs-remediation\nremediation_round: 0\n---\n\n# Validation\nNeeds remediation."
    });
    const adapter = _getAdapter();
    const before = adapter.prepare(
      `SELECT * FROM assessments WHERE milestone_id = 'M001' AND scope = 'milestone-validation'`
    ).get();
    assert.ok(before, "milestone-validation row should exist before reassess");
    const result = await handleReassessRoadmap({
      milestoneId: "M001",
      completedSliceId: "S04",
      verdict: "on-track",
      assessment: "S04 completed. Adding remediation slice S05.",
      sliceChanges: {
        modified: [],
        added: [
          {
            sliceId: "S05",
            title: "Remediation Slice",
            risk: "low",
            depends: ["S04"],
            demo: "Fix the issues found during validation."
          }
        ],
        removed: []
      }
    }, base);
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    const after = adapter.prepare(
      `SELECT * FROM assessments WHERE milestone_id = 'M001' AND scope = 'milestone-validation'`
    ).get();
    assert.equal(after, void 0, "milestone-validation row should be deleted after roadmap changes \u2014 stale validation must not survive remediation (#2957)");
  } finally {
    cleanup(base);
  }
});
test("handleReassessRoadmap does NOT invalidate validation when no roadmap structural changes (#2957)", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice One", status: "complete", demo: "Demo" });
    insertSlice({ id: "S02", milestoneId: "M001", title: "Slice Two", status: "pending", demo: "Demo" });
    const validationPath = join(".gsd", "milestones", "M001", "M001-VALIDATION.md");
    insertAssessment({
      path: validationPath,
      milestoneId: "M001",
      sliceId: null,
      taskId: null,
      status: "pass",
      scope: "milestone-validation",
      fullContent: "---\nverdict: pass\nremediation_round: 0\n---\n\n# Validation\nAll good."
    });
    const result = await handleReassessRoadmap({
      milestoneId: "M001",
      completedSliceId: "S01",
      verdict: "confirmed",
      assessment: "S01 completed. No changes needed.",
      sliceChanges: {
        modified: [],
        added: [],
        removed: []
      }
    }, base);
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    const adapter = _getAdapter();
    const row = adapter.prepare(
      `SELECT * FROM assessments WHERE milestone_id = 'M001' AND scope = 'milestone-validation'`
    ).get();
    assert.ok(row, "milestone-validation row should survive when no structural changes occurred");
  } finally {
    cleanup(base);
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9yZWFzc2Vzcy1oYW5kbGVyLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0ZXN0IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgbWtkaXJTeW5jLCBybVN5bmMsIGV4aXN0c1N5bmMsIHJlYWRGaWxlU3luYyB9IGZyb20gJ25vZGU6ZnMnO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gJ25vZGU6cGF0aCc7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tICdub2RlOm9zJztcblxuaW1wb3J0IHtcbiAgb3BlbkRhdGFiYXNlLFxuICBjbG9zZURhdGFiYXNlLFxuICBpbnNlcnRNaWxlc3RvbmUsXG4gIGluc2VydFNsaWNlLFxuICBpbnNlcnRBc3Nlc3NtZW50LFxuICBnZXRTbGljZSxcbiAgZ2V0TWlsZXN0b25lU2xpY2VzLFxuICBnZXRBc3Nlc3NtZW50LFxuICBfZ2V0QWRhcHRlcixcbn0gZnJvbSAnLi4vZ3NkLWRiLnRzJztcbmltcG9ydCB7IGhhbmRsZVJlYXNzZXNzUm9hZG1hcCB9IGZyb20gJy4uL3Rvb2xzL3JlYXNzZXNzLXJvYWRtYXAudHMnO1xuXG5mdW5jdGlvbiBtYWtlVG1wQmFzZSgpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgJ2dzZC1yZWFzc2Vzcy0nKSk7XG4gIG1rZGlyU3luYyhqb2luKGJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScsICdzbGljZXMnLCAnUzAxJyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBta2RpclN5bmMoam9pbihiYXNlLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgJ00wMDEnLCAnc2xpY2VzJywgJ1MwMicpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAxJywgJ3NsaWNlcycsICdTMDMnKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHJldHVybiBiYXNlO1xufVxuXG5mdW5jdGlvbiBjbGVhbnVwKGJhc2U6IHN0cmluZyk6IHZvaWQge1xuICB0cnkgeyBjbG9zZURhdGFiYXNlKCk7IH0gY2F0Y2ggeyAvKiBub29wICovIH1cbiAgdHJ5IHsgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTsgfSBjYXRjaCB7IC8qIG5vb3AgKi8gfVxufVxuXG5mdW5jdGlvbiBzZWVkTWlsZXN0b25lV2l0aFNsaWNlcyhvcHRzPzoge1xuICBzMDFTdGF0dXM/OiBzdHJpbmc7XG4gIHMwMlN0YXR1cz86IHN0cmluZztcbiAgczAzU3RhdHVzPzogc3RyaW5nO1xufSk6IHZvaWQge1xuICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogJ00wMDEnLCB0aXRsZTogJ1Rlc3QgTWlsZXN0b25lJywgc3RhdHVzOiAnYWN0aXZlJyB9KTtcbiAgaW5zZXJ0U2xpY2UoeyBpZDogJ1MwMScsIG1pbGVzdG9uZUlkOiAnTTAwMScsIHRpdGxlOiAnU2xpY2UgT25lJywgc3RhdHVzOiBvcHRzPy5zMDFTdGF0dXMgPz8gJ2NvbXBsZXRlJywgZGVtbzogJ0RlbW8gb25lLicgfSk7XG4gIGluc2VydFNsaWNlKHsgaWQ6ICdTMDInLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ1NsaWNlIFR3bycsIHN0YXR1czogb3B0cz8uczAyU3RhdHVzID8/ICdwZW5kaW5nJywgZGVtbzogJ0RlbW8gdHdvLicgfSk7XG4gIGluc2VydFNsaWNlKHsgaWQ6ICdTMDMnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ1NsaWNlIFRocmVlJywgc3RhdHVzOiBvcHRzPy5zMDNTdGF0dXMgPz8gJ3BlbmRpbmcnLCBkZW1vOiAnRGVtbyB0aHJlZS4nIH0pO1xufVxuXG5mdW5jdGlvbiB2YWxpZFJlYXNzZXNzUGFyYW1zKCkge1xuICByZXR1cm4ge1xuICAgIG1pbGVzdG9uZUlkOiAnTTAwMScsXG4gICAgY29tcGxldGVkU2xpY2VJZDogJ1MwMScsXG4gICAgdmVyZGljdDogJ2NvbmZpcm1lZCcsXG4gICAgYXNzZXNzbWVudDogJ1MwMSBjb21wbGV0ZWQgc3VjY2Vzc2Z1bGx5LiBSb2FkbWFwIGlzIG9uIHRyYWNrLicsXG4gICAgc2xpY2VDaGFuZ2VzOiB7XG4gICAgICBtb2RpZmllZDogW1xuICAgICAgICB7XG4gICAgICAgICAgc2xpY2VJZDogJ1MwMicsXG4gICAgICAgICAgdGl0bGU6ICdVcGRhdGVkIFNsaWNlIFR3bycsXG4gICAgICAgICAgcmlzazogJ2hpZ2gnLFxuICAgICAgICAgIGRlcGVuZHM6IFsnUzAxJ10sXG4gICAgICAgICAgZGVtbzogJ1VwZGF0ZWQgZGVtbyB0d28uJyxcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgICBhZGRlZDogW1xuICAgICAgICB7XG4gICAgICAgICAgc2xpY2VJZDogJ1MwNCcsXG4gICAgICAgICAgdGl0bGU6ICdOZXcgU2xpY2UgRm91cicsXG4gICAgICAgICAgcmlzazogJ2xvdycsXG4gICAgICAgICAgZGVwZW5kczogWydTMDInXSxcbiAgICAgICAgICBkZW1vOiAnRGVtbyBmb3VyLicsXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgICAgcmVtb3ZlZDogWydTMDMnXSxcbiAgICB9LFxuICB9O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoJ2hhbmRsZVJlYXNzZXNzUm9hZG1hcCByZWplY3RzIGludmFsaWQgcGF5bG9hZHMgKG1pc3NpbmcgbWlsZXN0b25lSWQpJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgJy5nc2QnLCAnZ3NkLmRiJykpO1xuXG4gIHRyeSB7XG4gICAgc2VlZE1pbGVzdG9uZVdpdGhTbGljZXMoKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVSZWFzc2Vzc1JvYWRtYXAoeyAuLi52YWxpZFJlYXNzZXNzUGFyYW1zKCksIG1pbGVzdG9uZUlkOiAnJyB9LCBiYXNlKTtcbiAgICBhc3NlcnQub2soJ2Vycm9yJyBpbiByZXN1bHQpO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQuZXJyb3IsIC92YWxpZGF0aW9uIGZhaWxlZC8pO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQuZXJyb3IsIC9taWxlc3RvbmVJZC8pO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KCdoYW5kbGVSZWFzc2Vzc1JvYWRtYXAgcmVqZWN0cyBtaXNzaW5nIG1pbGVzdG9uZScsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsICcuZ3NkJywgJ2dzZC5kYicpKTtcblxuICB0cnkge1xuICAgIC8vIE5vIG1pbGVzdG9uZSBzZWVkZWRcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVSZWFzc2Vzc1JvYWRtYXAodmFsaWRSZWFzc2Vzc1BhcmFtcygpLCBiYXNlKTtcbiAgICBhc3NlcnQub2soJ2Vycm9yJyBpbiByZXN1bHQpO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQuZXJyb3IsIC9ub3QgZm91bmQvKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdCgnaGFuZGxlUmVhc3Nlc3NSb2FkbWFwIHJlamVjdHMgc3RydWN0dXJhbCB2aW9sYXRpb246IG1vZGlmeWluZyBhIGNvbXBsZXRlZCBzbGljZScsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsICcuZ3NkJywgJ2dzZC5kYicpKTtcblxuICB0cnkge1xuICAgIHNlZWRNaWxlc3RvbmVXaXRoU2xpY2VzKHsgczAxU3RhdHVzOiAnY29tcGxldGUnLCBzMDJTdGF0dXM6ICdwZW5kaW5nJywgczAzU3RhdHVzOiAncGVuZGluZycgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVSZWFzc2Vzc1JvYWRtYXAoe1xuICAgICAgLi4udmFsaWRSZWFzc2Vzc1BhcmFtcygpLFxuICAgICAgc2xpY2VDaGFuZ2VzOiB7XG4gICAgICAgIG1vZGlmaWVkOiBbeyBzbGljZUlkOiAnUzAxJywgdGl0bGU6ICdUcnlpbmcgdG8gbW9kaWZ5IGNvbXBsZXRlZCBTMDEnIH1dLFxuICAgICAgICBhZGRlZDogW10sXG4gICAgICAgIHJlbW92ZWQ6IFtdLFxuICAgICAgfSxcbiAgICB9LCBiYXNlKTtcblxuICAgIGFzc2VydC5vaygnZXJyb3InIGluIHJlc3VsdCk7XG4gICAgYXNzZXJ0Lm1hdGNoKHJlc3VsdC5lcnJvciwgL2NvbXBsZXRlZCBzbGljZS8pO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQuZXJyb3IsIC9TMDEvKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdCgnaGFuZGxlUmVhc3Nlc3NSb2FkbWFwIHJlamVjdHMgc3RydWN0dXJhbCB2aW9sYXRpb246IHJlbW92aW5nIGEgY29tcGxldGVkIHNsaWNlJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgJy5nc2QnLCAnZ3NkLmRiJykpO1xuXG4gIHRyeSB7XG4gICAgc2VlZE1pbGVzdG9uZVdpdGhTbGljZXMoeyBzMDFTdGF0dXM6ICdjb21wbGV0ZScsIHMwMlN0YXR1czogJ3BlbmRpbmcnLCBzMDNTdGF0dXM6ICdwZW5kaW5nJyB9KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZVJlYXNzZXNzUm9hZG1hcCh7XG4gICAgICAuLi52YWxpZFJlYXNzZXNzUGFyYW1zKCksXG4gICAgICBzbGljZUNoYW5nZXM6IHtcbiAgICAgICAgbW9kaWZpZWQ6IFtdLFxuICAgICAgICBhZGRlZDogW10sXG4gICAgICAgIHJlbW92ZWQ6IFsnUzAxJ10sXG4gICAgICB9LFxuICAgIH0sIGJhc2UpO1xuXG4gICAgYXNzZXJ0Lm9rKCdlcnJvcicgaW4gcmVzdWx0KTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LmVycm9yLCAvY29tcGxldGVkIHNsaWNlLyk7XG4gICAgYXNzZXJ0Lm1hdGNoKHJlc3VsdC5lcnJvciwgL1MwMS8pO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KCdoYW5kbGVSZWFzc2Vzc1JvYWRtYXAgc3VjY2VlZHMgd2hlbiBtb2RpZnlpbmcgb25seSBwZW5kaW5nIHNsaWNlcycsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsICcuZ3NkJywgJ2dzZC5kYicpKTtcblxuICB0cnkge1xuICAgIHNlZWRNaWxlc3RvbmVXaXRoU2xpY2VzKHsgczAxU3RhdHVzOiAnY29tcGxldGUnLCBzMDJTdGF0dXM6ICdwZW5kaW5nJywgczAzU3RhdHVzOiAncGVuZGluZycgfSk7XG5cbiAgICBjb25zdCBwYXJhbXMgPSB2YWxpZFJlYXNzZXNzUGFyYW1zKCk7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlUmVhc3Nlc3NSb2FkbWFwKHBhcmFtcywgYmFzZSk7XG4gICAgYXNzZXJ0Lm9rKCEoJ2Vycm9yJyBpbiByZXN1bHQpLCBgdW5leHBlY3RlZCBlcnJvcjogJHsnZXJyb3InIGluIHJlc3VsdCA/IHJlc3VsdC5lcnJvciA6ICcnfWApO1xuXG4gICAgLy8gVmVyaWZ5IGFzc2Vzc21lbnRzIHJvdyBleGlzdHMgaW4gREJcbiAgICBjb25zdCBhc3Nlc3NtZW50UGF0aCA9IGpvaW4oJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAxJywgJ3NsaWNlcycsICdTMDEnLCAnUzAxLUFTU0VTU01FTlQubWQnKTtcbiAgICBjb25zdCBhc3Nlc3NtZW50ID0gZ2V0QXNzZXNzbWVudChhc3Nlc3NtZW50UGF0aCk7XG4gICAgYXNzZXJ0Lm9rKGFzc2Vzc21lbnQsICdhc3Nlc3NtZW50IHJvdyBzaG91bGQgZXhpc3QgaW4gREInKTtcbiAgICBhc3NlcnQuZXF1YWwoYXNzZXNzbWVudFsnbWlsZXN0b25lX2lkJ10sICdNMDAxJyk7XG4gICAgYXNzZXJ0LmVxdWFsKGFzc2Vzc21lbnRbJ3N0YXR1cyddLCAnY29uZmlybWVkJyk7XG4gICAgYXNzZXJ0LmVxdWFsKGFzc2Vzc21lbnRbJ3Njb3BlJ10sICdyb2FkbWFwJyk7XG4gICAgYXNzZXJ0Lm9rKChhc3Nlc3NtZW50WydmdWxsX2NvbnRlbnQnXSBhcyBzdHJpbmcpLmluY2x1ZGVzKCdTMDEgY29tcGxldGVkIHN1Y2Nlc3NmdWxseScpLCAnYXNzZXNzbWVudCBjb250ZW50IHNob3VsZCBiZSBzdG9yZWQnKTtcblxuICAgIC8vIFZlcmlmeSBTMDIgd2FzIHVwZGF0ZWRcbiAgICBjb25zdCBzMDIgPSBnZXRTbGljZSgnTTAwMScsICdTMDInKTtcbiAgICBhc3NlcnQub2soczAyLCAnUzAyIHNob3VsZCBzdGlsbCBleGlzdCcpO1xuICAgIGFzc2VydC5lcXVhbChzMDI/LnRpdGxlLCAnVXBkYXRlZCBTbGljZSBUd28nKTtcbiAgICBhc3NlcnQuZXF1YWwoczAyPy5yaXNrLCAnaGlnaCcpO1xuICAgIGFzc2VydC5lcXVhbChzMDI/LmRlbW8sICdVcGRhdGVkIGRlbW8gdHdvLicpO1xuXG4gICAgLy8gVmVyaWZ5IFMwMyB3YXMgZGVsZXRlZFxuICAgIGNvbnN0IHMwMyA9IGdldFNsaWNlKCdNMDAxJywgJ1MwMycpO1xuICAgIGFzc2VydC5lcXVhbChzMDMsIG51bGwsICdTMDMgc2hvdWxkIGhhdmUgYmVlbiBkZWxldGVkJyk7XG5cbiAgICAvLyBWZXJpZnkgUzA0IHdhcyBpbnNlcnRlZFxuICAgIGNvbnN0IHMwNCA9IGdldFNsaWNlKCdNMDAxJywgJ1MwNCcpO1xuICAgIGFzc2VydC5vayhzMDQsICdTMDQgc2hvdWxkIGV4aXN0IGFzIGEgbmV3IHNsaWNlJyk7XG4gICAgYXNzZXJ0LmVxdWFsKHMwND8udGl0bGUsICdOZXcgU2xpY2UgRm91cicpO1xuICAgIGFzc2VydC5lcXVhbChzMDQ/LnN0YXR1cywgJ3BlbmRpbmcnKTtcblxuICAgIC8vIFZlcmlmeSBTMDEgKGNvbXBsZXRlZCkgd2FzIE5PVCB0b3VjaGVkXG4gICAgY29uc3QgczAxID0gZ2V0U2xpY2UoJ00wMDEnLCAnUzAxJyk7XG4gICAgYXNzZXJ0Lm9rKHMwMSwgJ1MwMSBzaG91bGQgc3RpbGwgZXhpc3QnKTtcbiAgICBhc3NlcnQuZXF1YWwoczAxPy5zdGF0dXMsICdjb21wbGV0ZScpO1xuXG4gICAgLy8gVmVyaWZ5IFJPQURNQVAubWQgcmUtcmVuZGVyZWQgb24gZGlza1xuICAgIGNvbnN0IHJvYWRtYXBQYXRoID0gam9pbihiYXNlLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgJ00wMDEnLCAnTTAwMS1ST0FETUFQLm1kJyk7XG4gICAgYXNzZXJ0Lm9rKGV4aXN0c1N5bmMocm9hZG1hcFBhdGgpLCAnUk9BRE1BUC5tZCBzaG91bGQgYmUgcmVuZGVyZWQgdG8gZGlzaycpO1xuICAgIGNvbnN0IHJvYWRtYXBDb250ZW50ID0gcmVhZEZpbGVTeW5jKHJvYWRtYXBQYXRoLCAndXRmLTgnKTtcbiAgICBhc3NlcnQub2socm9hZG1hcENvbnRlbnQuaW5jbHVkZXMoJ1VwZGF0ZWQgU2xpY2UgVHdvJyksICdST0FETUFQLm1kIHNob3VsZCBjb250YWluIHVwZGF0ZWQgUzAyIHRpdGxlJyk7XG5cbiAgICAvLyBWZXJpZnkgQVNTRVNTTUVOVC5tZCBleGlzdHMgb24gZGlza1xuICAgIGNvbnN0IGFzc2Vzc21lbnREaXNrUGF0aCA9IGpvaW4oYmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAxJywgJ3NsaWNlcycsICdTMDEnLCAnUzAxLUFTU0VTU01FTlQubWQnKTtcbiAgICBhc3NlcnQub2soZXhpc3RzU3luYyhhc3Nlc3NtZW50RGlza1BhdGgpLCAnQVNTRVNTTUVOVC5tZCBzaG91bGQgYmUgcmVuZGVyZWQgdG8gZGlzaycpO1xuICAgIGNvbnN0IGFzc2Vzc21lbnRDb250ZW50ID0gcmVhZEZpbGVTeW5jKGFzc2Vzc21lbnREaXNrUGF0aCwgJ3V0Zi04Jyk7XG4gICAgYXNzZXJ0Lm9rKGFzc2Vzc21lbnRDb250ZW50LmluY2x1ZGVzKCdjb25maXJtZWQnKSwgJ0FTU0VTU01FTlQubWQgc2hvdWxkIGNvbnRhaW4gdmVyZGljdCcpO1xuICAgIGFzc2VydC5vayhhc3Nlc3NtZW50Q29udGVudC5pbmNsdWRlcygnUzAxJyksICdBU1NFU1NNRU5ULm1kIHNob3VsZCByZWZlcmVuY2UgY29tcGxldGVkIHNsaWNlJyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoJ2hhbmRsZVJlYXNzZXNzUm9hZG1hcCBjYWNoZSBpbnZhbGlkYXRpb246IGdldE1pbGVzdG9uZVNsaWNlcyByZWZsZWN0cyBtdXRhdGlvbnMnLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCAnLmdzZCcsICdnc2QuZGInKSk7XG5cbiAgdHJ5IHtcbiAgICBzZWVkTWlsZXN0b25lV2l0aFNsaWNlcyh7IHMwMVN0YXR1czogJ2NvbXBsZXRlJywgczAyU3RhdHVzOiAncGVuZGluZycsIHMwM1N0YXR1czogJ3BlbmRpbmcnIH0pO1xuXG4gICAgY29uc3QgcGFyYW1zID0gdmFsaWRSZWFzc2Vzc1BhcmFtcygpO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZVJlYXNzZXNzUm9hZG1hcChwYXJhbXMsIGJhc2UpO1xuICAgIGFzc2VydC5vayghKCdlcnJvcicgaW4gcmVzdWx0KSwgYHVuZXhwZWN0ZWQgZXJyb3I6ICR7J2Vycm9yJyBpbiByZXN1bHQgPyByZXN1bHQuZXJyb3IgOiAnJ31gKTtcblxuICAgIC8vIEFmdGVyIGNhY2hlIGludmFsaWRhdGlvbiwgREIgcXVlcmllcyBzaG91bGQgcmVmbGVjdCBtdXRhdGlvbnNcbiAgICBjb25zdCBzbGljZXMgPSBnZXRNaWxlc3RvbmVTbGljZXMoJ00wMDEnKTtcbiAgICBjb25zdCBzbGljZUlkcyA9IHNsaWNlcy5tYXAocyA9PiBzLmlkKTtcblxuICAgIC8vIFMwMSBzaG91bGQgcmVtYWluIChjb21wbGV0ZWQsIHVudG91Y2hlZClcbiAgICBhc3NlcnQub2soc2xpY2VJZHMuaW5jbHVkZXMoJ1MwMScpLCAnUzAxIHNob3VsZCBzdGlsbCBleGlzdCBhZnRlciByZWFzc2VzcycpO1xuXG4gICAgLy8gUzAyIHNob3VsZCByZW1haW4gKG1vZGlmaWVkLCBub3QgcmVtb3ZlZClcbiAgICBhc3NlcnQub2soc2xpY2VJZHMuaW5jbHVkZXMoJ1MwMicpLCAnUzAyIHNob3VsZCBzdGlsbCBleGlzdCBhZnRlciByZWFzc2VzcycpO1xuXG4gICAgLy8gUzAzIHNob3VsZCBiZSBnb25lIChyZW1vdmVkKVxuICAgIGFzc2VydC5vayghc2xpY2VJZHMuaW5jbHVkZXMoJ1MwMycpLCAnUzAzIHNob3VsZCBiZSBnb25lIGFmdGVyIHJlbW92YWwnKTtcblxuICAgIC8vIFMwNCBzaG91bGQgZXhpc3QgKGFkZGVkKVxuICAgIGFzc2VydC5vayhzbGljZUlkcy5pbmNsdWRlcygnUzA0JyksICdTMDQgc2hvdWxkIGV4aXN0IGFmdGVyIGFkZGl0aW9uJyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoJ2hhbmRsZVJlYXNzZXNzUm9hZG1hcCBpcyBpZGVtcG90ZW50OiBjYWxsaW5nIHR3aWNlIHdpdGggc2FtZSBwYXJhbXMgc3VjY2VlZHMnLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCAnLmdzZCcsICdnc2QuZGInKSk7XG5cbiAgdHJ5IHtcbiAgICBzZWVkTWlsZXN0b25lV2l0aFNsaWNlcyh7IHMwMVN0YXR1czogJ2NvbXBsZXRlJywgczAyU3RhdHVzOiAncGVuZGluZycsIHMwM1N0YXR1czogJ3BlbmRpbmcnIH0pO1xuXG4gICAgLy8gRmlyc3QgY2FsbCB3aXRoIGZ1bGwgbXV0YXRpb25zXG4gICAgY29uc3QgcGFyYW1zID0gdmFsaWRSZWFzc2Vzc1BhcmFtcygpO1xuICAgIGNvbnN0IGZpcnN0ID0gYXdhaXQgaGFuZGxlUmVhc3Nlc3NSb2FkbWFwKHBhcmFtcywgYmFzZSk7XG4gICAgYXNzZXJ0Lm9rKCEoJ2Vycm9yJyBpbiBmaXJzdCksIGBmaXJzdCBjYWxsIGVycm9yOiAkeydlcnJvcicgaW4gZmlyc3QgPyBmaXJzdC5lcnJvciA6ICcnfWApO1xuXG4gICAgLy8gU2Vjb25kIGNhbGwgXHUyMDE0IFMwMyBhbHJlYWR5IGRlbGV0ZWQsIFMwNCBhbHJlYWR5IGV4aXN0cyAoSU5TRVJUIE9SIElHTk9SRSksIFMwMiBhbHJlYWR5IHVwZGF0ZWRcbiAgICAvLyBUaGlzIHNob3VsZCBzdGlsbCBzdWNjZWVkIGJlY2F1c2U6XG4gICAgLy8gLSBhc3Nlc3NtZW50cyB1c2VzIElOU0VSVCBPUiBSRVBMQUNFIChwYXRoIFBLKVxuICAgIC8vIC0gUzA0IGluc2VydCB1c2VzIElOU0VSVCBPUiBJR05PUkVcbiAgICAvLyAtIFMwMiB1cGRhdGUgaXMgaWRlbXBvdGVudFxuICAgIC8vIC0gUzAzIGRlbGV0ZSBvbiBub25leGlzdGVudCBpcyBhIG5vLW9wXG4gICAgY29uc3Qgc2Vjb25kID0gYXdhaXQgaGFuZGxlUmVhc3Nlc3NSb2FkbWFwKHBhcmFtcywgYmFzZSk7XG4gICAgYXNzZXJ0Lm9rKCEoJ2Vycm9yJyBpbiBzZWNvbmQpLCBgc2Vjb25kIGNhbGwgZXJyb3I6ICR7J2Vycm9yJyBpbiBzZWNvbmQgPyBzZWNvbmQuZXJyb3IgOiAnJ31gKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdCgnaGFuZGxlUmVhc3Nlc3NSb2FkbWFwIHJlamVjdHMgc2xpY2Ugd2l0aCBzdGF0dXMgXCJkb25lXCIgKGFsaWFzIGZvciBjb21wbGV0ZSknLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCAnLmdzZCcsICdnc2QuZGInKSk7XG5cbiAgdHJ5IHtcbiAgICBzZWVkTWlsZXN0b25lV2l0aFNsaWNlcyh7IHMwMVN0YXR1czogJ2RvbmUnLCBzMDJTdGF0dXM6ICdwZW5kaW5nJywgczAzU3RhdHVzOiAncGVuZGluZycgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVSZWFzc2Vzc1JvYWRtYXAoe1xuICAgICAgLi4udmFsaWRSZWFzc2Vzc1BhcmFtcygpLFxuICAgICAgc2xpY2VDaGFuZ2VzOiB7XG4gICAgICAgIG1vZGlmaWVkOiBbeyBzbGljZUlkOiAnUzAxJywgdGl0bGU6ICdUcnlpbmcgdG8gbW9kaWZ5IGRvbmUgUzAxJyB9XSxcbiAgICAgICAgYWRkZWQ6IFtdLFxuICAgICAgICByZW1vdmVkOiBbXSxcbiAgICAgIH0sXG4gICAgfSwgYmFzZSk7XG5cbiAgICBhc3NlcnQub2soJ2Vycm9yJyBpbiByZXN1bHQpO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQuZXJyb3IsIC9jb21wbGV0ZWQgc2xpY2UvKTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LmVycm9yLCAvUzAxLyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoJ2hhbmRsZVJlYXNzZXNzUm9hZG1hcCByZXR1cm5zIHN0cnVjdHVyZWQgZXJyb3IgcGF5bG9hZHMgd2l0aCBhY3Rpb25hYmxlIG1lc3NhZ2VzJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgJy5nc2QnLCAnZ3NkLmRiJykpO1xuXG4gIHRyeSB7XG4gICAgc2VlZE1pbGVzdG9uZVdpdGhTbGljZXMoeyBzMDFTdGF0dXM6ICdjb21wbGV0ZScsIHMwMlN0YXR1czogJ2NvbXBsZXRlJywgczAzU3RhdHVzOiAncGVuZGluZycgfSk7XG5cbiAgICAvLyBUcnkgdG8gbW9kaWZ5IFMwMSAoY29tcGxldGVkKVxuICAgIGNvbnN0IG1vZGlmeVJlc3VsdCA9IGF3YWl0IGhhbmRsZVJlYXNzZXNzUm9hZG1hcCh7XG4gICAgICAuLi52YWxpZFJlYXNzZXNzUGFyYW1zKCksXG4gICAgICBzbGljZUNoYW5nZXM6IHtcbiAgICAgICAgbW9kaWZpZWQ6IFt7IHNsaWNlSWQ6ICdTMDEnLCB0aXRsZTogJ3gnIH1dLFxuICAgICAgICBhZGRlZDogW10sXG4gICAgICAgIHJlbW92ZWQ6IFtdLFxuICAgICAgfSxcbiAgICB9LCBiYXNlKTtcbiAgICBhc3NlcnQub2soJ2Vycm9yJyBpbiBtb2RpZnlSZXN1bHQpO1xuICAgIGFzc2VydC5vayh0eXBlb2YgbW9kaWZ5UmVzdWx0LmVycm9yID09PSAnc3RyaW5nJywgJ2Vycm9yIHNob3VsZCBiZSBhIHN0cmluZycpO1xuICAgIGFzc2VydC5vayhtb2RpZnlSZXN1bHQuZXJyb3IuaW5jbHVkZXMoJ1MwMScpLCAnZXJyb3Igc2hvdWxkIG5hbWUgdGhlIHNwZWNpZmljIHNsaWNlIElEIFMwMScpO1xuXG4gICAgLy8gVHJ5IHRvIHJlbW92ZSBTMDIgKGNvbXBsZXRlZClcbiAgICBjb25zdCByZW1vdmVSZXN1bHQgPSBhd2FpdCBoYW5kbGVSZWFzc2Vzc1JvYWRtYXAoe1xuICAgICAgLi4udmFsaWRSZWFzc2Vzc1BhcmFtcygpLFxuICAgICAgc2xpY2VDaGFuZ2VzOiB7XG4gICAgICAgIG1vZGlmaWVkOiBbXSxcbiAgICAgICAgYWRkZWQ6IFtdLFxuICAgICAgICByZW1vdmVkOiBbJ1MwMiddLFxuICAgICAgfSxcbiAgICB9LCBiYXNlKTtcbiAgICBhc3NlcnQub2soJ2Vycm9yJyBpbiByZW1vdmVSZXN1bHQpO1xuICAgIGFzc2VydC5vayhyZW1vdmVSZXN1bHQuZXJyb3IuaW5jbHVkZXMoJ1MwMicpLCAnZXJyb3Igc2hvdWxkIG5hbWUgdGhlIHNwZWNpZmljIHNsaWNlIElEIFMwMicpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQnVnICMyOTU3OiBTdGFsZSBWQUxJREFUSU9OIHN1cnZpdmVzIHJvYWRtYXAgcmVtZWRpYXRpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoJ2hhbmRsZVJlYXNzZXNzUm9hZG1hcCBpbnZhbGlkYXRlcyBzdGFsZSBtaWxlc3RvbmUtdmFsaWRhdGlvbiB3aGVuIHJvYWRtYXAgY2hhbmdlcyAoIzI5NTcpJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgJy5nc2QnLCAnZ3NkLmRiJykpO1xuXG4gIHRyeSB7XG4gICAgLy8gU2VlZDogTTAwMSB3aXRoIFMwMS1TMDQgYWxsIGNvbXBsZXRlLCBwbHVzIGEgc3RhbGUgVkFMSURBVElPTiB3aXRoIG5lZWRzLXJlbWVkaWF0aW9uXG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgdGl0bGU6ICdUZXN0IE1pbGVzdG9uZScsIHN0YXR1czogJ2FjdGl2ZScgfSk7XG4gICAgaW5zZXJ0U2xpY2UoeyBpZDogJ1MwMScsIG1pbGVzdG9uZUlkOiAnTTAwMScsIHRpdGxlOiAnU2xpY2UgT25lJywgc3RhdHVzOiAnY29tcGxldGUnLCBkZW1vOiAnRGVtbycgfSk7XG4gICAgaW5zZXJ0U2xpY2UoeyBpZDogJ1MwMicsIG1pbGVzdG9uZUlkOiAnTTAwMScsIHRpdGxlOiAnU2xpY2UgVHdvJywgc3RhdHVzOiAnY29tcGxldGUnLCBkZW1vOiAnRGVtbycgfSk7XG4gICAgaW5zZXJ0U2xpY2UoeyBpZDogJ1MwMycsIG1pbGVzdG9uZUlkOiAnTTAwMScsIHRpdGxlOiAnU2xpY2UgVGhyZWUnLCBzdGF0dXM6ICdjb21wbGV0ZScsIGRlbW86ICdEZW1vJyB9KTtcbiAgICBpbnNlcnRTbGljZSh7IGlkOiAnUzA0JywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdTbGljZSBGb3VyJywgc3RhdHVzOiAnY29tcGxldGUnLCBkZW1vOiAnRGVtbycgfSk7XG5cbiAgICAvLyBJbnNlcnQgbWlsZXN0b25lLXZhbGlkYXRpb24gYXNzZXNzbWVudCB3aXRoIG5lZWRzLXJlbWVkaWF0aW9uIHZlcmRpY3QgKHN0YWxlKVxuICAgIGNvbnN0IHZhbGlkYXRpb25QYXRoID0gam9pbignLmdzZCcsICdtaWxlc3RvbmVzJywgJ00wMDEnLCAnTTAwMS1WQUxJREFUSU9OLm1kJyk7XG4gICAgaW5zZXJ0QXNzZXNzbWVudCh7XG4gICAgICBwYXRoOiB2YWxpZGF0aW9uUGF0aCxcbiAgICAgIG1pbGVzdG9uZUlkOiAnTTAwMScsXG4gICAgICBzbGljZUlkOiBudWxsLFxuICAgICAgdGFza0lkOiBudWxsLFxuICAgICAgc3RhdHVzOiAnbmVlZHMtcmVtZWRpYXRpb24nLFxuICAgICAgc2NvcGU6ICdtaWxlc3RvbmUtdmFsaWRhdGlvbicsXG4gICAgICBmdWxsQ29udGVudDogJy0tLVxcbnZlcmRpY3Q6IG5lZWRzLXJlbWVkaWF0aW9uXFxucmVtZWRpYXRpb25fcm91bmQ6IDBcXG4tLS1cXG5cXG4jIFZhbGlkYXRpb25cXG5OZWVkcyByZW1lZGlhdGlvbi4nLFxuICAgIH0pO1xuXG4gICAgLy8gVmVyaWZ5IHRoZSB2YWxpZGF0aW9uIHJvdyBleGlzdHMgYmVmb3JlIHJlYXNzZXNzXG4gICAgY29uc3QgYWRhcHRlciA9IF9nZXRBZGFwdGVyKCkhO1xuICAgIGNvbnN0IGJlZm9yZSA9IGFkYXB0ZXIucHJlcGFyZShcbiAgICAgIGBTRUxFQ1QgKiBGUk9NIGFzc2Vzc21lbnRzIFdIRVJFIG1pbGVzdG9uZV9pZCA9ICdNMDAxJyBBTkQgc2NvcGUgPSAnbWlsZXN0b25lLXZhbGlkYXRpb24nYCxcbiAgICApLmdldCgpIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkO1xuICAgIGFzc2VydC5vayhiZWZvcmUsICdtaWxlc3RvbmUtdmFsaWRhdGlvbiByb3cgc2hvdWxkIGV4aXN0IGJlZm9yZSByZWFzc2VzcycpO1xuXG4gICAgLy8gTm93IHJlYXNzZXNzIHRoZSByb2FkbWFwOiBhZGQgcmVtZWRpYXRpb24gc2xpY2UgUzA1XG4gICAgLy8gVGhpcyBzaW11bGF0ZXMgdGhlIHNjZW5hcmlvIGZyb20gIzI5NTcgd2hlcmUgdmFsaWRhdGlvbiBwcm9kdWNlZCBuZWVkcy1yZW1lZGlhdGlvblxuICAgIC8vIGFuZCB0aGVuIHJvYWRtYXAgd2FzIHJlYXNzZXNzZWQgdG8gYWRkIGEgcmVtZWRpYXRpb24gc2xpY2VcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVSZWFzc2Vzc1JvYWRtYXAoe1xuICAgICAgbWlsZXN0b25lSWQ6ICdNMDAxJyxcbiAgICAgIGNvbXBsZXRlZFNsaWNlSWQ6ICdTMDQnLFxuICAgICAgdmVyZGljdDogJ29uLXRyYWNrJyxcbiAgICAgIGFzc2Vzc21lbnQ6ICdTMDQgY29tcGxldGVkLiBBZGRpbmcgcmVtZWRpYXRpb24gc2xpY2UgUzA1LicsXG4gICAgICBzbGljZUNoYW5nZXM6IHtcbiAgICAgICAgbW9kaWZpZWQ6IFtdLFxuICAgICAgICBhZGRlZDogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIHNsaWNlSWQ6ICdTMDUnLFxuICAgICAgICAgICAgdGl0bGU6ICdSZW1lZGlhdGlvbiBTbGljZScsXG4gICAgICAgICAgICByaXNrOiAnbG93JyxcbiAgICAgICAgICAgIGRlcGVuZHM6IFsnUzA0J10sXG4gICAgICAgICAgICBkZW1vOiAnRml4IHRoZSBpc3N1ZXMgZm91bmQgZHVyaW5nIHZhbGlkYXRpb24uJyxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgICByZW1vdmVkOiBbXSxcbiAgICAgIH0sXG4gICAgfSwgYmFzZSk7XG5cbiAgICBhc3NlcnQub2soISgnZXJyb3InIGluIHJlc3VsdCksIGB1bmV4cGVjdGVkIGVycm9yOiAkeydlcnJvcicgaW4gcmVzdWx0ID8gcmVzdWx0LmVycm9yIDogJyd9YCk7XG5cbiAgICAvLyBUaGUgc3RhbGUgbWlsZXN0b25lLXZhbGlkYXRpb24gcm93IG11c3QgYmUgZGVsZXRlZCBhZnRlciByb2FkbWFwIGNoYW5nZXNcbiAgICBjb25zdCBhZnRlciA9IGFkYXB0ZXIucHJlcGFyZShcbiAgICAgIGBTRUxFQ1QgKiBGUk9NIGFzc2Vzc21lbnRzIFdIRVJFIG1pbGVzdG9uZV9pZCA9ICdNMDAxJyBBTkQgc2NvcGUgPSAnbWlsZXN0b25lLXZhbGlkYXRpb24nYCxcbiAgICApLmdldCgpIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkO1xuICAgIGFzc2VydC5lcXVhbChhZnRlciwgdW5kZWZpbmVkLCAnbWlsZXN0b25lLXZhbGlkYXRpb24gcm93IHNob3VsZCBiZSBkZWxldGVkIGFmdGVyIHJvYWRtYXAgY2hhbmdlcyBcdTIwMTQgc3RhbGUgdmFsaWRhdGlvbiBtdXN0IG5vdCBzdXJ2aXZlIHJlbWVkaWF0aW9uICgjMjk1NyknKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdCgnaGFuZGxlUmVhc3Nlc3NSb2FkbWFwIGRvZXMgTk9UIGludmFsaWRhdGUgdmFsaWRhdGlvbiB3aGVuIG5vIHJvYWRtYXAgc3RydWN0dXJhbCBjaGFuZ2VzICgjMjk1NyknLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCAnLmdzZCcsICdnc2QuZGInKSk7XG5cbiAgdHJ5IHtcbiAgICAvLyBTZWVkOiBNMDAxIHdpdGggc2xpY2VzLCBwbHVzIGEgdmFsaWRhdGlvbiB3aXRoIHBhc3MgdmVyZGljdFxuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiAnTTAwMScsIHRpdGxlOiAnVGVzdCBNaWxlc3RvbmUnLCBzdGF0dXM6ICdhY3RpdmUnIH0pO1xuICAgIGluc2VydFNsaWNlKHsgaWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ1NsaWNlIE9uZScsIHN0YXR1czogJ2NvbXBsZXRlJywgZGVtbzogJ0RlbW8nIH0pO1xuICAgIGluc2VydFNsaWNlKHsgaWQ6ICdTMDInLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ1NsaWNlIFR3bycsIHN0YXR1czogJ3BlbmRpbmcnLCBkZW1vOiAnRGVtbycgfSk7XG5cbiAgICAvLyBJbnNlcnQgbWlsZXN0b25lLXZhbGlkYXRpb24gYXNzZXNzbWVudCB3aXRoIHBhc3MgdmVyZGljdFxuICAgIGNvbnN0IHZhbGlkYXRpb25QYXRoID0gam9pbignLmdzZCcsICdtaWxlc3RvbmVzJywgJ00wMDEnLCAnTTAwMS1WQUxJREFUSU9OLm1kJyk7XG4gICAgaW5zZXJ0QXNzZXNzbWVudCh7XG4gICAgICBwYXRoOiB2YWxpZGF0aW9uUGF0aCxcbiAgICAgIG1pbGVzdG9uZUlkOiAnTTAwMScsXG4gICAgICBzbGljZUlkOiBudWxsLFxuICAgICAgdGFza0lkOiBudWxsLFxuICAgICAgc3RhdHVzOiAncGFzcycsXG4gICAgICBzY29wZTogJ21pbGVzdG9uZS12YWxpZGF0aW9uJyxcbiAgICAgIGZ1bGxDb250ZW50OiAnLS0tXFxudmVyZGljdDogcGFzc1xcbnJlbWVkaWF0aW9uX3JvdW5kOiAwXFxuLS0tXFxuXFxuIyBWYWxpZGF0aW9uXFxuQWxsIGdvb2QuJyxcbiAgICB9KTtcblxuICAgIC8vIFJlYXNzZXNzIHdpdGggbm8gc3RydWN0dXJhbCBjaGFuZ2VzIChlbXB0eSBhZGRlZC9tb2RpZmllZC9yZW1vdmVkKVxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZVJlYXNzZXNzUm9hZG1hcCh7XG4gICAgICBtaWxlc3RvbmVJZDogJ00wMDEnLFxuICAgICAgY29tcGxldGVkU2xpY2VJZDogJ1MwMScsXG4gICAgICB2ZXJkaWN0OiAnY29uZmlybWVkJyxcbiAgICAgIGFzc2Vzc21lbnQ6ICdTMDEgY29tcGxldGVkLiBObyBjaGFuZ2VzIG5lZWRlZC4nLFxuICAgICAgc2xpY2VDaGFuZ2VzOiB7XG4gICAgICAgIG1vZGlmaWVkOiBbXSxcbiAgICAgICAgYWRkZWQ6IFtdLFxuICAgICAgICByZW1vdmVkOiBbXSxcbiAgICAgIH0sXG4gICAgfSwgYmFzZSk7XG5cbiAgICBhc3NlcnQub2soISgnZXJyb3InIGluIHJlc3VsdCksIGB1bmV4cGVjdGVkIGVycm9yOiAkeydlcnJvcicgaW4gcmVzdWx0ID8gcmVzdWx0LmVycm9yIDogJyd9YCk7XG5cbiAgICAvLyBWYWxpZGF0aW9uIHNob3VsZCBzdGlsbCBleGlzdCB3aGVuIG5vIHN0cnVjdHVyYWwgY2hhbmdlcyBvY2N1cnJlZFxuICAgIGNvbnN0IGFkYXB0ZXIgPSBfZ2V0QWRhcHRlcigpITtcbiAgICBjb25zdCByb3cgPSBhZGFwdGVyLnByZXBhcmUoXG4gICAgICBgU0VMRUNUICogRlJPTSBhc3Nlc3NtZW50cyBXSEVSRSBtaWxlc3RvbmVfaWQgPSAnTTAwMScgQU5EIHNjb3BlID0gJ21pbGVzdG9uZS12YWxpZGF0aW9uJ2AsXG4gICAgKS5nZXQoKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZDtcbiAgICBhc3NlcnQub2socm93LCAnbWlsZXN0b25lLXZhbGlkYXRpb24gcm93IHNob3VsZCBzdXJ2aXZlIHdoZW4gbm8gc3RydWN0dXJhbCBjaGFuZ2VzIG9jY3VycmVkJyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxXQUFXLFFBQVEsWUFBWSxvQkFBb0I7QUFDekUsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUV2QjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFDUCxTQUFTLDZCQUE2QjtBQUV0QyxTQUFTLGNBQXNCO0FBQzdCLFFBQU0sT0FBTyxZQUFZLEtBQUssT0FBTyxHQUFHLGVBQWUsQ0FBQztBQUN4RCxZQUFVLEtBQUssTUFBTSxRQUFRLGNBQWMsUUFBUSxVQUFVLEtBQUssR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3hGLFlBQVUsS0FBSyxNQUFNLFFBQVEsY0FBYyxRQUFRLFVBQVUsS0FBSyxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDeEYsWUFBVSxLQUFLLE1BQU0sUUFBUSxjQUFjLFFBQVEsVUFBVSxLQUFLLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUN4RixTQUFPO0FBQ1Q7QUFFQSxTQUFTLFFBQVEsTUFBb0I7QUFDbkMsTUFBSTtBQUFFLGtCQUFjO0FBQUEsRUFBRyxRQUFRO0FBQUEsRUFBYTtBQUM1QyxNQUFJO0FBQUUsV0FBTyxNQUFNLEVBQUUsV0FB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
