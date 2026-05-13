import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkRuntimeHealth } from "../doctor-runtime-checks.js";
import {
  openDatabase,
  closeDatabase,
  insertMilestone
} from "../gsd-db.js";
import { invalidateAllCaches } from "../cache.js";
function makeBase(prefix = "gsd-doctor-orphan-") {
  const base = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}
function stubDir(base, mid) {
  mkdirSync(join(base, ".gsd", "milestones", mid, "slices"), { recursive: true });
}
function populateDir(base, mid) {
  mkdirSync(join(base, ".gsd", "milestones", mid), { recursive: true });
  writeFileSync(join(base, ".gsd", "milestones", mid, `${mid}-CONTEXT.md`), `# ${mid}
`);
}
describe("gsd_doctor orphan milestone directory check (#4996)", () => {
  let base;
  afterEach(() => {
    try {
      closeDatabase();
    } catch {
    }
    try {
      invalidateAllCaches();
    } catch {
    }
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  it("(a) empty stub dir with no DB row is reported as orphan_milestone_dir", async () => {
    base = makeBase();
    stubDir(base, "M003");
    const issues = [];
    const fixes = [];
    await checkRuntimeHealth(base, issues, fixes, () => false);
    const orphan = issues.find((i) => i.code === "orphan_milestone_dir" && i.unitId === "M003");
    assert.ok(orphan, "should report orphan_milestone_dir for empty stub");
    assert.equal(orphan?.severity, "warning");
    assert.equal(orphan?.fixable, true);
    assert.ok(orphan?.message.includes("M003"), "message should name the milestone");
  });
  it("(b) populated milestone dir is NOT reported", async () => {
    base = makeBase();
    populateDir(base, "M001");
    const issues = [];
    const fixes = [];
    await checkRuntimeHealth(base, issues, fixes, () => false);
    const orphan = issues.find((i) => i.code === "orphan_milestone_dir" && i.unitId === "M001");
    assert.ok(!orphan, "populated milestone dir must not be reported as orphan");
  });
  it("(c) worktree-only milestone (no content files, no DB row, but worktree exists) is NOT reported", async () => {
    base = makeBase();
    stubDir(base, "M003");
    mkdirSync(join(base, ".gsd", "worktrees", "M003"), { recursive: true });
    const issues = [];
    const fixes = [];
    await checkRuntimeHealth(base, issues, fixes, () => false);
    const orphan = issues.find((i) => i.code === "orphan_milestone_dir" && i.unitId === "M003");
    assert.ok(!orphan, "milestone with a worktree must not be reported as orphan");
  });
  it("(d) queued DB row (in-flight ID) is NOT reported as orphan", async () => {
    base = makeBase();
    stubDir(base, "M003");
    const dbPath = join(base, ".gsd", "gsd.db");
    openDatabase(dbPath);
    insertMilestone({ id: "M003", status: "queued" });
    const issues = [];
    const fixes = [];
    await checkRuntimeHealth(base, issues, fixes, () => false);
    const orphan = issues.find((i) => i.code === "orphan_milestone_dir" && i.unitId === "M003");
    assert.ok(!orphan, "queued DB row must block orphan report (in-flight race protection)");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9kb2N0b3Itb3JwaGFuLW1pbGVzdG9uZS00OTk2LnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRCBFeHRlbnNpb24gXHUyMDE0IFJlZ3Jlc3Npb24gdGVzdCBmb3IgIzQ5OTY6IGRvY3RvciBvcnBoYW4gbWlsZXN0b25lIGRpciBjaGVja1xuLy8gVmVyaWZpZXMgdGhhdCBjaGVja1J1bnRpbWVIZWFsdGggcmVwb3J0cyBvcnBoYW5fbWlsZXN0b25lX2RpciBmb3IgZW1wdHkgc3R1YlxuLy8gZGlycyB3aXRoIG5vIERCIHJvdywgZG9lcyBub3QgcmVwb3J0IHBvcHVsYXRlZCBkaXJzLCBhbmQgZG9lcyBub3QgcmVwb3J0XG4vLyBsZWdpdGltYXRlIGluLWZsaWdodCB3b3JrdHJlZS1vbmx5IG1pbGVzdG9uZSBkaXJzLlxuXG5pbXBvcnQgeyBkZXNjcmliZSwgaXQsIGFmdGVyRWFjaCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgd3JpdGVGaWxlU3luYywgcm1TeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuXG5pbXBvcnQgeyBjaGVja1J1bnRpbWVIZWFsdGggfSBmcm9tIFwiLi4vZG9jdG9yLXJ1bnRpbWUtY2hlY2tzLnRzXCI7XG5pbXBvcnQge1xuICBvcGVuRGF0YWJhc2UsXG4gIGNsb3NlRGF0YWJhc2UsXG4gIGluc2VydE1pbGVzdG9uZSxcbn0gZnJvbSBcIi4uL2dzZC1kYi50c1wiO1xuaW1wb3J0IHsgaW52YWxpZGF0ZUFsbENhY2hlcyB9IGZyb20gXCIuLi9jYWNoZS50c1wiO1xuaW1wb3J0IHR5cGUgeyBEb2N0b3JJc3N1ZSwgRG9jdG9ySXNzdWVDb2RlIH0gZnJvbSBcIi4uL2RvY3Rvci10eXBlcy50c1wiO1xuXG5mdW5jdGlvbiBtYWtlQmFzZShwcmVmaXggPSBcImdzZC1kb2N0b3Itb3JwaGFuLVwiKTogc3RyaW5nIHtcbiAgY29uc3QgYmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIHByZWZpeCkpO1xuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgcmV0dXJuIGJhc2U7XG59XG5cbmZ1bmN0aW9uIHN0dWJEaXIoYmFzZTogc3RyaW5nLCBtaWQ6IHN0cmluZyk6IHZvaWQge1xuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIG1pZCwgXCJzbGljZXNcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xufVxuXG5mdW5jdGlvbiBwb3B1bGF0ZURpcihiYXNlOiBzdHJpbmcsIG1pZDogc3RyaW5nKTogdm9pZCB7XG4gIG1rZGlyU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgbWlkKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIG1pZCwgYCR7bWlkfS1DT05URVhULm1kYCksIGAjICR7bWlkfVxcbmApO1xufVxuXG5kZXNjcmliZShcImdzZF9kb2N0b3Igb3JwaGFuIG1pbGVzdG9uZSBkaXJlY3RvcnkgY2hlY2sgKCM0OTk2KVwiLCAoKSA9PiB7XG4gIGxldCBiYXNlOiBzdHJpbmc7XG5cbiAgYWZ0ZXJFYWNoKCgpID0+IHtcbiAgICB0cnkgeyBjbG9zZURhdGFiYXNlKCk7IH0gY2F0Y2ggeyAvKiBpZ25vcmUgKi8gfVxuICAgIHRyeSB7IGludmFsaWRhdGVBbGxDYWNoZXMoKTsgfSBjYXRjaCB7IC8qIGlnbm9yZSAqLyB9XG4gICAgdHJ5IHsgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTsgfSBjYXRjaCB7IC8qIGlnbm9yZSAqLyB9XG4gIH0pO1xuXG4gIGl0KFwiKGEpIGVtcHR5IHN0dWIgZGlyIHdpdGggbm8gREIgcm93IGlzIHJlcG9ydGVkIGFzIG9ycGhhbl9taWxlc3RvbmVfZGlyXCIsIGFzeW5jICgpID0+IHtcbiAgICBiYXNlID0gbWFrZUJhc2UoKTtcbiAgICBzdHViRGlyKGJhc2UsIFwiTTAwM1wiKTtcblxuICAgIGNvbnN0IGlzc3VlczogRG9jdG9ySXNzdWVbXSA9IFtdO1xuICAgIGNvbnN0IGZpeGVzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGF3YWl0IGNoZWNrUnVudGltZUhlYWx0aChiYXNlLCBpc3N1ZXMsIGZpeGVzLCAoKSA9PiBmYWxzZSk7XG5cbiAgICBjb25zdCBvcnBoYW4gPSBpc3N1ZXMuZmluZChpID0+IGkuY29kZSA9PT0gXCJvcnBoYW5fbWlsZXN0b25lX2RpclwiICYmIGkudW5pdElkID09PSBcIk0wMDNcIik7XG4gICAgYXNzZXJ0Lm9rKG9ycGhhbiwgXCJzaG91bGQgcmVwb3J0IG9ycGhhbl9taWxlc3RvbmVfZGlyIGZvciBlbXB0eSBzdHViXCIpO1xuICAgIGFzc2VydC5lcXVhbChvcnBoYW4/LnNldmVyaXR5LCBcIndhcm5pbmdcIik7XG4gICAgYXNzZXJ0LmVxdWFsKG9ycGhhbj8uZml4YWJsZSwgdHJ1ZSk7XG4gICAgYXNzZXJ0Lm9rKG9ycGhhbj8ubWVzc2FnZS5pbmNsdWRlcyhcIk0wMDNcIiksIFwibWVzc2FnZSBzaG91bGQgbmFtZSB0aGUgbWlsZXN0b25lXCIpO1xuICB9KTtcblxuICBpdChcIihiKSBwb3B1bGF0ZWQgbWlsZXN0b25lIGRpciBpcyBOT1QgcmVwb3J0ZWRcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGJhc2UgPSBtYWtlQmFzZSgpO1xuICAgIHBvcHVsYXRlRGlyKGJhc2UsIFwiTTAwMVwiKTtcblxuICAgIGNvbnN0IGlzc3VlczogRG9jdG9ySXNzdWVbXSA9IFtdO1xuICAgIGNvbnN0IGZpeGVzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGF3YWl0IGNoZWNrUnVudGltZUhlYWx0aChiYXNlLCBpc3N1ZXMsIGZpeGVzLCAoKSA9PiBmYWxzZSk7XG5cbiAgICBjb25zdCBvcnBoYW4gPSBpc3N1ZXMuZmluZChpID0+IGkuY29kZSA9PT0gXCJvcnBoYW5fbWlsZXN0b25lX2RpclwiICYmIGkudW5pdElkID09PSBcIk0wMDFcIik7XG4gICAgYXNzZXJ0Lm9rKCFvcnBoYW4sIFwicG9wdWxhdGVkIG1pbGVzdG9uZSBkaXIgbXVzdCBub3QgYmUgcmVwb3J0ZWQgYXMgb3JwaGFuXCIpO1xuICB9KTtcblxuICBpdChcIihjKSB3b3JrdHJlZS1vbmx5IG1pbGVzdG9uZSAobm8gY29udGVudCBmaWxlcywgbm8gREIgcm93LCBidXQgd29ya3RyZWUgZXhpc3RzKSBpcyBOT1QgcmVwb3J0ZWRcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGJhc2UgPSBtYWtlQmFzZSgpO1xuICAgIHN0dWJEaXIoYmFzZSwgXCJNMDAzXCIpO1xuICAgIC8vIFNpbXVsYXRlIGEgbGVnaXRpbWF0ZSBpbi1mbGlnaHQgd29ya3RyZWVcbiAgICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJ3b3JrdHJlZXNcIiwgXCJNMDAzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAgIGNvbnN0IGlzc3VlczogRG9jdG9ySXNzdWVbXSA9IFtdO1xuICAgIGNvbnN0IGZpeGVzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGF3YWl0IGNoZWNrUnVudGltZUhlYWx0aChiYXNlLCBpc3N1ZXMsIGZpeGVzLCAoKSA9PiBmYWxzZSk7XG5cbiAgICBjb25zdCBvcnBoYW4gPSBpc3N1ZXMuZmluZChpID0+IGkuY29kZSA9PT0gXCJvcnBoYW5fbWlsZXN0b25lX2RpclwiICYmIGkudW5pdElkID09PSBcIk0wMDNcIik7XG4gICAgYXNzZXJ0Lm9rKCFvcnBoYW4sIFwibWlsZXN0b25lIHdpdGggYSB3b3JrdHJlZSBtdXN0IG5vdCBiZSByZXBvcnRlZCBhcyBvcnBoYW5cIik7XG4gIH0pO1xuXG4gIGl0KFwiKGQpIHF1ZXVlZCBEQiByb3cgKGluLWZsaWdodCBJRCkgaXMgTk9UIHJlcG9ydGVkIGFzIG9ycGhhblwiLCBhc3luYyAoKSA9PiB7XG4gICAgYmFzZSA9IG1ha2VCYXNlKCk7XG4gICAgc3R1YkRpcihiYXNlLCBcIk0wMDNcIik7XG4gICAgY29uc3QgZGJQYXRoID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJnc2QuZGJcIik7XG4gICAgb3BlbkRhdGFiYXNlKGRiUGF0aCk7XG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwM1wiLCBzdGF0dXM6IFwicXVldWVkXCIgfSk7XG5cbiAgICBjb25zdCBpc3N1ZXM6IERvY3Rvcklzc3VlW10gPSBbXTtcbiAgICBjb25zdCBmaXhlczogc3RyaW5nW10gPSBbXTtcbiAgICBhd2FpdCBjaGVja1J1bnRpbWVIZWFsdGgoYmFzZSwgaXNzdWVzLCBmaXhlcywgKCkgPT4gZmFsc2UpO1xuXG4gICAgY29uc3Qgb3JwaGFuID0gaXNzdWVzLmZpbmQoaSA9PiBpLmNvZGUgPT09IFwib3JwaGFuX21pbGVzdG9uZV9kaXJcIiAmJiBpLnVuaXRJZCA9PT0gXCJNMDAzXCIpO1xuICAgIGFzc2VydC5vayghb3JwaGFuLCBcInF1ZXVlZCBEQiByb3cgbXVzdCBibG9jayBvcnBoYW4gcmVwb3J0IChpbi1mbGlnaHQgcmFjZSBwcm90ZWN0aW9uKVwiKTtcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUtBLFNBQVMsVUFBVSxJQUFJLGlCQUFpQjtBQUN4QyxPQUFPLFlBQVk7QUFDbkIsU0FBUyxhQUFhLFdBQVcsZUFBZSxjQUFjO0FBQzlELFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFFdkIsU0FBUywwQkFBMEI7QUFDbkM7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1AsU0FBUywyQkFBMkI7QUFHcEMsU0FBUyxTQUFTLFNBQVMsc0JBQThCO0FBQ3ZELFFBQU0sT0FBTyxZQUFZLEtBQUssT0FBTyxHQUFHLE1BQU0sQ0FBQztBQUMvQyxZQUFVLEtBQUssTUFBTSxRQUFRLFlBQVksR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQy9ELFNBQU87QUFDVDtBQUVBLFNBQVMsUUFBUSxNQUFjLEtBQW1CO0FBQ2hELFlBQVUsS0FBSyxNQUFNLFFBQVEsY0FBYyxLQUFLLFFBQVEsR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ2hGO0FBRUEsU0FBUyxZQUFZLE1BQWMsS0FBbUI7QUFDcEQsWUFBVSxLQUFLLE1BQU0sUUFBUSxjQUFjLEdBQUcsR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3BFLGdCQUFjLEtBQUssTUFBTSxRQUFRLGNBQWMsS0FBSyxHQUFHLEdBQUcsYUFBYSxHQUFHLEtBQUssR0FBRztBQUFBLENBQUk7QUFDeEY7QUFFQSxTQUFTLHVEQUF1RCxNQUFNO0FBQ3BFLE1BQUk7QUFFSixZQUFVLE1BQU07QUFDZCxRQUFJO0FBQUUsb0JBQWM7QUFBQSxJQUFHLFFBQVE7QUFBQSxJQUFlO0FBQzlDLFFBQUk7QUFBRSwwQkFBb0I7QUFBQSxJQUFHLFFBQVE7QUFBQSxJQUFlO0FBQ3BELFFBQUk7QUFBRSxhQUFPLE1BQU0sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUFHLFFBQVE7QUFBQSxJQUFlO0FBQUEsRUFDL0UsQ0FBQztBQUVELEtBQUcseUVBQXlFLFlBQVk7QUFDdEYsV0FBTyxTQUFTO0FBQ2hCLFlBQVEsTUFBTSxNQUFNO0FBRXBCLFVBQU0sU0FBd0IsQ0FBQztBQUMvQixVQUFNLFFBQWtCLENBQUM7QUFDekIsVUFBTSxtQkFBbUIsTUFBTSxRQUFRLE9BQU8sTUFBTSxLQUFLO0FBRXpELFVBQU0sU0FBUyxPQUFPLEtBQUssT0FBSyxFQUFFLFNBQVMsMEJBQTBCLEVBQUUsV0FBVyxNQUFNO0FBQ3hGLFdBQU8sR0FBRyxRQUFRLG1EQUFtRDtBQUNyRSxXQUFPLE1BQU0sUUFBUSxVQUFVLFNBQVM7QUFDeEMsV0FBTyxNQUFNLFFBQVEsU0FBUyxJQUFJO0FBQ2xDLFdBQU8sR0FBRyxRQUFRLFFBQVEsU0FBUyxNQUFNLEdBQUcsbUNBQW1DO0FBQUEsRUFDakYsQ0FBQztBQUVELEtBQUcsK0NBQStDLFlBQVk7QUFDNUQsV0FBTyxTQUFTO0FBQ2hCLGdCQUFZLE1BQU0sTUFBTTtBQUV4QixVQUFNLFNBQXdCLENBQUM7QUFDL0IsVUFBTSxRQUFrQixDQUFDO0FBQ3pCLFVBQU0sbUJBQW1CLE1BQU0sUUFBUSxPQUFPLE1BQU0sS0FBSztBQUV6RCxVQUFNLFNBQVMsT0FBTyxLQUFLLE9BQUssRUFBRSxTQUFTLDBCQUEwQixFQUFFLFdBQVcsTUFBTTtBQUN4RixXQUFPLEdBQUcsQ0FBQyxRQUFRLHdEQUF3RDtBQUFBLEVBQzdFLENBQUM7QUFFRCxLQUFHLGtHQUFrRyxZQUFZO0FBQy9HLFdBQU8sU0FBUztBQUNoQixZQUFRLE1BQU0sTUFBTTtBQUVwQixjQUFVLEtBQUssTUFBTSxRQUFRLGFBQWEsTUFBTSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFFdEUsVUFBTSxTQUF3QixDQUFDO0FBQy9CLFVBQU0sUUFBa0IsQ0FBQztBQUN6QixVQUFNLG1CQUFtQixNQUFNLFFBQVEsT0FBTyxNQUFNLEtBQUs7QUFFekQsVUFBTSxTQUFTLE9BQU8sS0FBSyxPQUFLLEVBQUUsU0FBUywwQkFBMEIsRUFBRSxXQUFXLE1BQU07QUFDeEYsV0FBTyxHQUFHLENBQUMsUUFBUSwwREFBMEQ7QUFBQSxFQUMvRSxDQUFDO0FBRUQsS0FBRyw4REFBOEQsWUFBWTtBQUMzRSxXQUFPLFNBQVM7QUFDaEIsWUFBUSxNQUFNLE1BQU07QUFDcEIsVUFBTSxTQUFTLEtBQUssTUFBTSxRQUFRLFFBQVE7QUFDMUMsaUJBQWEsTUFBTTtBQUNuQixvQkFBZ0IsRUFBRSxJQUFJLFFBQVEsUUFBUSxTQUFTLENBQUM7QUFFaEQsVUFBTSxTQUF3QixDQUFDO0FBQy9CLFVBQU0sUUFBa0IsQ0FBQztBQUN6QixVQUFNLG1CQUFtQixNQUFNLFFBQVEsT0FBTyxNQUFNLEtBQUs7QUFFekQsVUFBTSxTQUFTLE9BQU8sS0FBSyxPQUFLLEVBQUUsU0FBUywwQkFBMEIsRUFBRSxXQUFXLE1BQU07QUFDeEYsV0FBTyxHQUFHLENBQUMsUUFBUSxvRUFBb0U7QUFBQSxFQUN6RixDQUFDO0FBQ0gsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
