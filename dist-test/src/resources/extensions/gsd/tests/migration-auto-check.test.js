import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { ensureDbOpen } from "../bootstrap/dynamic-tools.js";
import {
  _getAdapter,
  closeDatabase,
  getAllMilestones,
  getSliceTasks
} from "../gsd-db.js";
import {
  autoImportMarkdownHierarchyIfDbMismatch,
  countMarkdownHierarchy
} from "../migration-auto-check.js";
import { writeGSDDirectory } from "../migrate/writer.js";
function makeBase() {
  return mkdtempSync(join(tmpdir(), "gsd-migration-auto-check-"));
}
function cleanup(base) {
  closeDatabase();
  rmSync(base, { recursive: true, force: true });
}
function projectFixture() {
  return {
    projectContent: "# Legacy Project\n",
    decisionsContent: "",
    requirements: [],
    milestones: [
      {
        id: "M001",
        title: "Legacy Milestone",
        vision: "Carry forward previous work",
        successCriteria: ["Existing task is visible"],
        research: null,
        boundaryMap: [],
        slices: [
          {
            id: "S01",
            title: "Legacy Slice",
            risk: "medium",
            depends: [],
            done: false,
            demo: "Legacy slice demo",
            goal: "Legacy slice demo",
            research: null,
            summary: null,
            tasks: [
              {
                id: "T01",
                title: "Legacy Task",
                description: "Task carried from markdown",
                done: false,
                estimate: "",
                files: ["src/index.ts"],
                mustHaves: [],
                summary: null
              }
            ]
          }
        ]
      }
    ]
  };
}
test("migration auto-check imports markdown hierarchy when DB is empty", async () => {
  const base = makeBase();
  try {
    await writeGSDDirectory(projectFixture(), base);
    assert.deepEqual(countMarkdownHierarchy(base), { milestones: 1, slices: 1, tasks: 1 });
    assert.equal(await ensureDbOpen(base), true);
    assert.equal(getAllMilestones().length, 0, "fresh authoritative DB starts empty");
    const result = await autoImportMarkdownHierarchyIfDbMismatch(base);
    assert.equal(result.action, "imported");
    assert.equal(result.reason, "db-empty");
    assert.deepEqual(result.afterDb, { milestones: 1, slices: 1, tasks: 1 });
    assert.equal(getAllMilestones().length, 1);
    assert.equal(getSliceTasks("M001", "S01").length, 1);
  } finally {
    cleanup(base);
  }
});
test("migration auto-check repairs DB hierarchy count mismatch", async () => {
  const base = makeBase();
  try {
    await writeGSDDirectory(projectFixture(), base);
    await autoImportMarkdownHierarchyIfDbMismatch(base);
    _getAdapter().prepare("DELETE FROM tasks WHERE milestone_id = ? AND slice_id = ? AND id = ?").run("M001", "S01", "T01");
    assert.equal(getSliceTasks("M001", "S01").length, 0, "test fixture simulates stale DB task count");
    const result = await autoImportMarkdownHierarchyIfDbMismatch(base);
    assert.equal(result.action, "imported");
    assert.equal(result.reason, "count-mismatch");
    assert.deepEqual(result.beforeDb, { milestones: 1, slices: 1, tasks: 0 });
    assert.deepEqual(result.afterDb, { milestones: 1, slices: 1, tasks: 1 });
    assert.equal(getSliceTasks("M001", "S01").length, 1);
  } finally {
    cleanup(base);
  }
});
test("migration auto-check leaves matching DB hierarchy alone", async () => {
  const base = makeBase();
  try {
    await writeGSDDirectory(projectFixture(), base);
    await autoImportMarkdownHierarchyIfDbMismatch(base);
    const result = await autoImportMarkdownHierarchyIfDbMismatch(base);
    assert.equal(result.action, "none");
    assert.equal(result.reason, "in-sync");
    assert.deepEqual(result.markdown, { milestones: 1, slices: 1, tasks: 1 });
    assert.deepEqual(result.afterDb, { milestones: 1, slices: 1, tasks: 1 });
  } finally {
    cleanup(base);
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9taWdyYXRpb24tYXV0by1jaGVjay50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBybVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5cbmltcG9ydCB7IGVuc3VyZURiT3BlbiB9IGZyb20gXCIuLi9ib290c3RyYXAvZHluYW1pYy10b29scy50c1wiO1xuaW1wb3J0IHtcbiAgX2dldEFkYXB0ZXIsXG4gIGNsb3NlRGF0YWJhc2UsXG4gIGdldEFsbE1pbGVzdG9uZXMsXG4gIGdldFNsaWNlVGFza3MsXG59IGZyb20gXCIuLi9nc2QtZGIudHNcIjtcbmltcG9ydCB7XG4gIGF1dG9JbXBvcnRNYXJrZG93bkhpZXJhcmNoeUlmRGJNaXNtYXRjaCxcbiAgY291bnRNYXJrZG93bkhpZXJhcmNoeSxcbn0gZnJvbSBcIi4uL21pZ3JhdGlvbi1hdXRvLWNoZWNrLnRzXCI7XG5pbXBvcnQgeyB3cml0ZUdTRERpcmVjdG9yeSB9IGZyb20gXCIuLi9taWdyYXRlL3dyaXRlci50c1wiO1xuaW1wb3J0IHR5cGUgeyBHU0RQcm9qZWN0IH0gZnJvbSBcIi4uL21pZ3JhdGUvdHlwZXMudHNcIjtcblxuZnVuY3Rpb24gbWFrZUJhc2UoKTogc3RyaW5nIHtcbiAgcmV0dXJuIG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLW1pZ3JhdGlvbi1hdXRvLWNoZWNrLVwiKSk7XG59XG5cbmZ1bmN0aW9uIGNsZWFudXAoYmFzZTogc3RyaW5nKTogdm9pZCB7XG4gIGNsb3NlRGF0YWJhc2UoKTtcbiAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbn1cblxuZnVuY3Rpb24gcHJvamVjdEZpeHR1cmUoKTogR1NEUHJvamVjdCB7XG4gIHJldHVybiB7XG4gICAgcHJvamVjdENvbnRlbnQ6IFwiIyBMZWdhY3kgUHJvamVjdFxcblwiLFxuICAgIGRlY2lzaW9uc0NvbnRlbnQ6IFwiXCIsXG4gICAgcmVxdWlyZW1lbnRzOiBbXSxcbiAgICBtaWxlc3RvbmVzOiBbXG4gICAgICB7XG4gICAgICAgIGlkOiBcIk0wMDFcIixcbiAgICAgICAgdGl0bGU6IFwiTGVnYWN5IE1pbGVzdG9uZVwiLFxuICAgICAgICB2aXNpb246IFwiQ2FycnkgZm9yd2FyZCBwcmV2aW91cyB3b3JrXCIsXG4gICAgICAgIHN1Y2Nlc3NDcml0ZXJpYTogW1wiRXhpc3RpbmcgdGFzayBpcyB2aXNpYmxlXCJdLFxuICAgICAgICByZXNlYXJjaDogbnVsbCxcbiAgICAgICAgYm91bmRhcnlNYXA6IFtdLFxuICAgICAgICBzbGljZXM6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBpZDogXCJTMDFcIixcbiAgICAgICAgICAgIHRpdGxlOiBcIkxlZ2FjeSBTbGljZVwiLFxuICAgICAgICAgICAgcmlzazogXCJtZWRpdW1cIixcbiAgICAgICAgICAgIGRlcGVuZHM6IFtdLFxuICAgICAgICAgICAgZG9uZTogZmFsc2UsXG4gICAgICAgICAgICBkZW1vOiBcIkxlZ2FjeSBzbGljZSBkZW1vXCIsXG4gICAgICAgICAgICBnb2FsOiBcIkxlZ2FjeSBzbGljZSBkZW1vXCIsXG4gICAgICAgICAgICByZXNlYXJjaDogbnVsbCxcbiAgICAgICAgICAgIHN1bW1hcnk6IG51bGwsXG4gICAgICAgICAgICB0YXNrczogW1xuICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgaWQ6IFwiVDAxXCIsXG4gICAgICAgICAgICAgICAgdGl0bGU6IFwiTGVnYWN5IFRhc2tcIixcbiAgICAgICAgICAgICAgICBkZXNjcmlwdGlvbjogXCJUYXNrIGNhcnJpZWQgZnJvbSBtYXJrZG93blwiLFxuICAgICAgICAgICAgICAgIGRvbmU6IGZhbHNlLFxuICAgICAgICAgICAgICAgIGVzdGltYXRlOiBcIlwiLFxuICAgICAgICAgICAgICAgIGZpbGVzOiBbXCJzcmMvaW5kZXgudHNcIl0sXG4gICAgICAgICAgICAgICAgbXVzdEhhdmVzOiBbXSxcbiAgICAgICAgICAgICAgICBzdW1tYXJ5OiBudWxsLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSxcbiAgICBdLFxuICB9O1xufVxuXG50ZXN0KFwibWlncmF0aW9uIGF1dG8tY2hlY2sgaW1wb3J0cyBtYXJrZG93biBoaWVyYXJjaHkgd2hlbiBEQiBpcyBlbXB0eVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICB0cnkge1xuICAgIGF3YWl0IHdyaXRlR1NERGlyZWN0b3J5KHByb2plY3RGaXh0dXJlKCksIGJhc2UpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwoY291bnRNYXJrZG93bkhpZXJhcmNoeShiYXNlKSwgeyBtaWxlc3RvbmVzOiAxLCBzbGljZXM6IDEsIHRhc2tzOiAxIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKGF3YWl0IGVuc3VyZURiT3BlbihiYXNlKSwgdHJ1ZSk7XG4gICAgYXNzZXJ0LmVxdWFsKGdldEFsbE1pbGVzdG9uZXMoKS5sZW5ndGgsIDAsIFwiZnJlc2ggYXV0aG9yaXRhdGl2ZSBEQiBzdGFydHMgZW1wdHlcIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBhdXRvSW1wb3J0TWFya2Rvd25IaWVyYXJjaHlJZkRiTWlzbWF0Y2goYmFzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5hY3Rpb24sIFwiaW1wb3J0ZWRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5yZWFzb24sIFwiZGItZW1wdHlcIik7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQuYWZ0ZXJEYiwgeyBtaWxlc3RvbmVzOiAxLCBzbGljZXM6IDEsIHRhc2tzOiAxIH0pO1xuICAgIGFzc2VydC5lcXVhbChnZXRBbGxNaWxlc3RvbmVzKCkubGVuZ3RoLCAxKTtcbiAgICBhc3NlcnQuZXF1YWwoZ2V0U2xpY2VUYXNrcyhcIk0wMDFcIiwgXCJTMDFcIikubGVuZ3RoLCAxKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcIm1pZ3JhdGlvbiBhdXRvLWNoZWNrIHJlcGFpcnMgREIgaGllcmFyY2h5IGNvdW50IG1pc21hdGNoXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gIHRyeSB7XG4gICAgYXdhaXQgd3JpdGVHU0REaXJlY3RvcnkocHJvamVjdEZpeHR1cmUoKSwgYmFzZSk7XG4gICAgYXdhaXQgYXV0b0ltcG9ydE1hcmtkb3duSGllcmFyY2h5SWZEYk1pc21hdGNoKGJhc2UpO1xuXG4gICAgX2dldEFkYXB0ZXIoKSEucHJlcGFyZShcIkRFTEVURSBGUk9NIHRhc2tzIFdIRVJFIG1pbGVzdG9uZV9pZCA9ID8gQU5EIHNsaWNlX2lkID0gPyBBTkQgaWQgPSA/XCIpLnJ1bihcIk0wMDFcIiwgXCJTMDFcIiwgXCJUMDFcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGdldFNsaWNlVGFza3MoXCJNMDAxXCIsIFwiUzAxXCIpLmxlbmd0aCwgMCwgXCJ0ZXN0IGZpeHR1cmUgc2ltdWxhdGVzIHN0YWxlIERCIHRhc2sgY291bnRcIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBhdXRvSW1wb3J0TWFya2Rvd25IaWVyYXJjaHlJZkRiTWlzbWF0Y2goYmFzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5hY3Rpb24sIFwiaW1wb3J0ZWRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5yZWFzb24sIFwiY291bnQtbWlzbWF0Y2hcIik7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQuYmVmb3JlRGIsIHsgbWlsZXN0b25lczogMSwgc2xpY2VzOiAxLCB0YXNrczogMCB9KTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdC5hZnRlckRiLCB7IG1pbGVzdG9uZXM6IDEsIHNsaWNlczogMSwgdGFza3M6IDEgfSk7XG4gICAgYXNzZXJ0LmVxdWFsKGdldFNsaWNlVGFza3MoXCJNMDAxXCIsIFwiUzAxXCIpLmxlbmd0aCwgMSk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJtaWdyYXRpb24gYXV0by1jaGVjayBsZWF2ZXMgbWF0Y2hpbmcgREIgaGllcmFyY2h5IGFsb25lXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gIHRyeSB7XG4gICAgYXdhaXQgd3JpdGVHU0REaXJlY3RvcnkocHJvamVjdEZpeHR1cmUoKSwgYmFzZSk7XG4gICAgYXdhaXQgYXV0b0ltcG9ydE1hcmtkb3duSGllcmFyY2h5SWZEYk1pc21hdGNoKGJhc2UpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgYXV0b0ltcG9ydE1hcmtkb3duSGllcmFyY2h5SWZEYk1pc21hdGNoKGJhc2UpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuYWN0aW9uLCBcIm5vbmVcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5yZWFzb24sIFwiaW4tc3luY1wiKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdC5tYXJrZG93biwgeyBtaWxlc3RvbmVzOiAxLCBzbGljZXM6IDEsIHRhc2tzOiAxIH0pO1xuICAgIGFzc2VydC5kZWVwRXF1YWwocmVzdWx0LmFmdGVyRGIsIHsgbWlsZXN0b25lczogMSwgc2xpY2VzOiAxLCB0YXNrczogMSB9KTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcbiJdLAogICJtYXBwaW5ncyI6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
