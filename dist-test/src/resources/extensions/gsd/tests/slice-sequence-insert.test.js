import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handlePlanMilestone } from "../tools/plan-milestone.js";
import { handleReassessRoadmap } from "../tools/reassess-roadmap.js";
import { migrateHierarchyToDb } from "../md-importer.js";
import {
  closeDatabase,
  getMilestoneSlices,
  insertMilestone,
  insertSlice,
  openDatabase
} from "../gsd-db.js";
let tempBase = null;
afterEach(() => {
  closeDatabase();
  if (tempBase) rmSync(tempBase, { recursive: true, force: true });
  tempBase = null;
});
function makeBase(name) {
  tempBase = mkdtempSync(join(tmpdir(), name));
  mkdirSync(join(tempBase, ".gsd", "milestones"), { recursive: true });
  openDatabase(join(tempBase, ".gsd", "gsd.db"));
  return tempBase;
}
function slice(sliceId, title) {
  return {
    sliceId,
    title,
    risk: "low",
    depends: [],
    demo: `${title} demo`,
    goal: `${title} goal`,
    successCriteria: `${title} success`,
    proofLevel: "unit",
    integrationClosure: "covered",
    observabilityImpact: "none"
  };
}
describe("slice sequence on insert (#3697)", () => {
  test("plan milestone persists slices in agent-provided order", async () => {
    const base = makeBase("gsd-sequence-plan-");
    const result = await handlePlanMilestone({
      milestoneId: "M001",
      title: "Sequence",
      vision: "Preserve slice order",
      slices: [slice("S01", "First"), slice("S02", "Second"), slice("S03", "Third")]
    }, base);
    assert.ok(!("error" in result), JSON.stringify(result));
    assert.deepEqual(
      getMilestoneSlices("M001").map((row) => [row.id, row.sequence]),
      [["S01", 1], ["S02", 2], ["S03", 3]]
    );
  });
  test("reassess roadmap appends new slices after existing slices", async () => {
    const base = makeBase("gsd-sequence-reassess-");
    insertMilestone({ id: "M001", title: "Sequence", status: "active", depends_on: [] });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Done", status: "complete", risk: "low", depends: [], demo: "", sequence: 1 });
    insertSlice({ id: "S02", milestoneId: "M001", title: "Existing", status: "pending", risk: "low", depends: [], demo: "", sequence: 2 });
    const result = await handleReassessRoadmap({
      milestoneId: "M001",
      completedSliceId: "S01",
      verdict: "pass",
      assessment: "Add follow-up slices.",
      sliceChanges: {
        modified: [],
        added: [
          { sliceId: "S03", title: "Added 1", risk: "low", depends: [], demo: "" },
          { sliceId: "S04", title: "Added 2", risk: "low", depends: [], demo: "" }
        ],
        removed: []
      }
    }, base);
    assert.ok(!("error" in result), JSON.stringify(result));
    assert.deepEqual(
      getMilestoneSlices("M001").map((row) => [row.id, row.sequence]),
      [["S01", 1], ["S02", 2], ["S03", 3], ["S04", 4]]
    );
  });
  test("markdown importer preserves roadmap order in sequence values", () => {
    const base = makeBase("gsd-sequence-import-");
    const milestoneDir = join(base, ".gsd", "milestones", "M001");
    mkdirSync(milestoneDir, { recursive: true });
    writeFileSync(
      join(milestoneDir, "M001-ROADMAP.md"),
      [
        "# M001: Imported",
        "",
        "## Slices",
        "- [ ] **S01: First** `risk:low`",
        "  Demo: first.",
        "- [ ] **S02: Second** `risk:low`",
        "  Demo: second."
      ].join("\n"),
      "utf-8"
    );
    const result = migrateHierarchyToDb(base);
    assert.equal(result.slices, 2);
    assert.deepEqual(
      getMilestoneSlices("M001").map((row) => [row.id, row.sequence]),
      [["S01", 1], ["S02", 2]]
    );
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9zbGljZS1zZXF1ZW5jZS1pbnNlcnQudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBSZWdyZXNzaW9uIHRlc3QgZm9yICMzNjk3IFx1MjAxNCBzZXQgc2xpY2Ugc2VxdWVuY2Ugb24gaW5zZXJ0LlxuICovXG5cbmltcG9ydCB7IGRlc2NyaWJlLCB0ZXN0LCBhZnRlckVhY2ggfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZGlyU3luYywgbWtkdGVtcFN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcblxuaW1wb3J0IHsgaGFuZGxlUGxhbk1pbGVzdG9uZSB9IGZyb20gXCIuLi90b29scy9wbGFuLW1pbGVzdG9uZS50c1wiO1xuaW1wb3J0IHsgaGFuZGxlUmVhc3Nlc3NSb2FkbWFwIH0gZnJvbSBcIi4uL3Rvb2xzL3JlYXNzZXNzLXJvYWRtYXAudHNcIjtcbmltcG9ydCB7IG1pZ3JhdGVIaWVyYXJjaHlUb0RiIH0gZnJvbSBcIi4uL21kLWltcG9ydGVyLnRzXCI7XG5pbXBvcnQge1xuICBjbG9zZURhdGFiYXNlLFxuICBnZXRNaWxlc3RvbmVTbGljZXMsXG4gIGluc2VydE1pbGVzdG9uZSxcbiAgaW5zZXJ0U2xpY2UsXG4gIG9wZW5EYXRhYmFzZSxcbn0gZnJvbSBcIi4uL2dzZC1kYi50c1wiO1xuXG5sZXQgdGVtcEJhc2U6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG5hZnRlckVhY2goKCkgPT4ge1xuICBjbG9zZURhdGFiYXNlKCk7XG4gIGlmICh0ZW1wQmFzZSkgcm1TeW5jKHRlbXBCYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIHRlbXBCYXNlID0gbnVsbDtcbn0pO1xuXG5mdW5jdGlvbiBtYWtlQmFzZShuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICB0ZW1wQmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIG5hbWUpKTtcbiAgbWtkaXJTeW5jKGpvaW4odGVtcEJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBvcGVuRGF0YWJhc2Uoam9pbih0ZW1wQmFzZSwgXCIuZ3NkXCIsIFwiZ3NkLmRiXCIpKTtcbiAgcmV0dXJuIHRlbXBCYXNlO1xufVxuXG5mdW5jdGlvbiBzbGljZShzbGljZUlkOiBzdHJpbmcsIHRpdGxlOiBzdHJpbmcpIHtcbiAgcmV0dXJuIHtcbiAgICBzbGljZUlkLFxuICAgIHRpdGxlLFxuICAgIHJpc2s6IFwibG93XCIsXG4gICAgZGVwZW5kczogW10sXG4gICAgZGVtbzogYCR7dGl0bGV9IGRlbW9gLFxuICAgIGdvYWw6IGAke3RpdGxlfSBnb2FsYCxcbiAgICBzdWNjZXNzQ3JpdGVyaWE6IGAke3RpdGxlfSBzdWNjZXNzYCxcbiAgICBwcm9vZkxldmVsOiBcInVuaXRcIixcbiAgICBpbnRlZ3JhdGlvbkNsb3N1cmU6IFwiY292ZXJlZFwiLFxuICAgIG9ic2VydmFiaWxpdHlJbXBhY3Q6IFwibm9uZVwiLFxuICB9O1xufVxuXG5kZXNjcmliZShcInNsaWNlIHNlcXVlbmNlIG9uIGluc2VydCAoIzM2OTcpXCIsICgpID0+IHtcbiAgdGVzdChcInBsYW4gbWlsZXN0b25lIHBlcnNpc3RzIHNsaWNlcyBpbiBhZ2VudC1wcm92aWRlZCBvcmRlclwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKFwiZ3NkLXNlcXVlbmNlLXBsYW4tXCIpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlUGxhbk1pbGVzdG9uZSh7XG4gICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICB0aXRsZTogXCJTZXF1ZW5jZVwiLFxuICAgICAgdmlzaW9uOiBcIlByZXNlcnZlIHNsaWNlIG9yZGVyXCIsXG4gICAgICBzbGljZXM6IFtzbGljZShcIlMwMVwiLCBcIkZpcnN0XCIpLCBzbGljZShcIlMwMlwiLCBcIlNlY29uZFwiKSwgc2xpY2UoXCJTMDNcIiwgXCJUaGlyZFwiKV0sXG4gICAgfSwgYmFzZSk7XG5cbiAgICBhc3NlcnQub2soIShcImVycm9yXCIgaW4gcmVzdWx0KSwgSlNPTi5zdHJpbmdpZnkocmVzdWx0KSk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICAgIGdldE1pbGVzdG9uZVNsaWNlcyhcIk0wMDFcIikubWFwKChyb3cpID0+IFtyb3cuaWQsIHJvdy5zZXF1ZW5jZV0pLFxuICAgICAgW1tcIlMwMVwiLCAxXSwgW1wiUzAyXCIsIDJdLCBbXCJTMDNcIiwgM11dLFxuICAgICk7XG4gIH0pO1xuXG4gIHRlc3QoXCJyZWFzc2VzcyByb2FkbWFwIGFwcGVuZHMgbmV3IHNsaWNlcyBhZnRlciBleGlzdGluZyBzbGljZXNcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBtYWtlQmFzZShcImdzZC1zZXF1ZW5jZS1yZWFzc2Vzcy1cIik7XG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJTZXF1ZW5jZVwiLCBzdGF0dXM6IFwiYWN0aXZlXCIsIGRlcGVuZHNfb246IFtdIH0pO1xuICAgIGluc2VydFNsaWNlKHsgaWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiRG9uZVwiLCBzdGF0dXM6IFwiY29tcGxldGVcIiwgcmlzazogXCJsb3dcIiwgZGVwZW5kczogW10sIGRlbW86IFwiXCIsIHNlcXVlbmNlOiAxIH0pO1xuICAgIGluc2VydFNsaWNlKHsgaWQ6IFwiUzAyXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiRXhpc3RpbmdcIiwgc3RhdHVzOiBcInBlbmRpbmdcIiwgcmlzazogXCJsb3dcIiwgZGVwZW5kczogW10sIGRlbW86IFwiXCIsIHNlcXVlbmNlOiAyIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlUmVhc3Nlc3NSb2FkbWFwKHtcbiAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICAgIGNvbXBsZXRlZFNsaWNlSWQ6IFwiUzAxXCIsXG4gICAgICB2ZXJkaWN0OiBcInBhc3NcIixcbiAgICAgIGFzc2Vzc21lbnQ6IFwiQWRkIGZvbGxvdy11cCBzbGljZXMuXCIsXG4gICAgICBzbGljZUNoYW5nZXM6IHtcbiAgICAgICAgbW9kaWZpZWQ6IFtdLFxuICAgICAgICBhZGRlZDogW1xuICAgICAgICAgIHsgc2xpY2VJZDogXCJTMDNcIiwgdGl0bGU6IFwiQWRkZWQgMVwiLCByaXNrOiBcImxvd1wiLCBkZXBlbmRzOiBbXSwgZGVtbzogXCJcIiB9LFxuICAgICAgICAgIHsgc2xpY2VJZDogXCJTMDRcIiwgdGl0bGU6IFwiQWRkZWQgMlwiLCByaXNrOiBcImxvd1wiLCBkZXBlbmRzOiBbXSwgZGVtbzogXCJcIiB9LFxuICAgICAgICBdLFxuICAgICAgICByZW1vdmVkOiBbXSxcbiAgICAgIH0sXG4gICAgfSwgYmFzZSk7XG5cbiAgICBhc3NlcnQub2soIShcImVycm9yXCIgaW4gcmVzdWx0KSwgSlNPTi5zdHJpbmdpZnkocmVzdWx0KSk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICAgIGdldE1pbGVzdG9uZVNsaWNlcyhcIk0wMDFcIikubWFwKChyb3cpID0+IFtyb3cuaWQsIHJvdy5zZXF1ZW5jZV0pLFxuICAgICAgW1tcIlMwMVwiLCAxXSwgW1wiUzAyXCIsIDJdLCBbXCJTMDNcIiwgM10sIFtcIlMwNFwiLCA0XV0sXG4gICAgKTtcbiAgfSk7XG5cbiAgdGVzdChcIm1hcmtkb3duIGltcG9ydGVyIHByZXNlcnZlcyByb2FkbWFwIG9yZGVyIGluIHNlcXVlbmNlIHZhbHVlc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKFwiZ3NkLXNlcXVlbmNlLWltcG9ydC1cIik7XG4gICAgY29uc3QgbWlsZXN0b25lRGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiKTtcbiAgICBta2RpclN5bmMobWlsZXN0b25lRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihtaWxlc3RvbmVEaXIsIFwiTTAwMS1ST0FETUFQLm1kXCIpLFxuICAgICAgW1xuICAgICAgICBcIiMgTTAwMTogSW1wb3J0ZWRcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCIjIyBTbGljZXNcIixcbiAgICAgICAgXCItIFsgXSAqKlMwMTogRmlyc3QqKiBgcmlzazpsb3dgXCIsXG4gICAgICAgIFwiICBEZW1vOiBmaXJzdC5cIixcbiAgICAgICAgXCItIFsgXSAqKlMwMjogU2Vjb25kKiogYHJpc2s6bG93YFwiLFxuICAgICAgICBcIiAgRGVtbzogc2Vjb25kLlwiLFxuICAgICAgXS5qb2luKFwiXFxuXCIpLFxuICAgICAgXCJ1dGYtOFwiLFxuICAgICk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBtaWdyYXRlSGllcmFyY2h5VG9EYihiYXNlKTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc2xpY2VzLCAyKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKFxuICAgICAgZ2V0TWlsZXN0b25lU2xpY2VzKFwiTTAwMVwiKS5tYXAoKHJvdykgPT4gW3Jvdy5pZCwgcm93LnNlcXVlbmNlXSksXG4gICAgICBbW1wiUzAxXCIsIDFdLCBbXCJTMDJcIiwgMl1dLFxuICAgICk7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFJQSxTQUFTLFVBQVUsTUFBTSxpQkFBaUI7QUFDMUMsT0FBTyxZQUFZO0FBQ25CLFNBQVMsV0FBVyxhQUFhLFFBQVEscUJBQXFCO0FBQzlELFNBQVMsWUFBWTtB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
