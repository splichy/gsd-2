import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  openDatabase,
  closeDatabase,
  isDbAvailable,
  insertMilestone,
  getMilestone
} from "../gsd-db.js";
import { resolveMilestoneFile } from "../paths.js";
describe("pre-flight CONTEXT-DRAFT filter (#2473)", () => {
  let tmpBase;
  let gsd;
  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), "gsd-preflight-draft-"));
    gsd = join(tmpBase, ".gsd");
    for (const id of ["M001", "M002", "M003"]) {
      const msDir = join(gsd, "milestones", id);
      mkdirSync(msDir, { recursive: true });
      writeFileSync(join(msDir, `${id}-CONTEXT-DRAFT.md`), `# ${id}: Draft
`);
    }
    const dbPath = join(gsd, "gsd.db");
    openDatabase(dbPath);
    insertMilestone({ id: "M001", title: "Complete milestone", status: "complete" });
    insertMilestone({ id: "M002", title: "Active milestone", status: "active" });
    insertMilestone({ id: "M003", title: "Parked milestone", status: "parked" });
  });
  afterEach(() => {
    closeDatabase();
    rmSync(tmpBase, { recursive: true, force: true });
  });
  test("completed milestone is skipped \u2014 no warning emitted", () => {
    assert.ok(isDbAvailable(), "DB should be available");
    const ms = getMilestone("M001");
    assert.equal(ms?.status, "complete");
  });
  test("parked milestone is skipped \u2014 no warning emitted", () => {
    const ms = getMilestone("M003");
    assert.equal(ms?.status, "parked");
  });
  test("active milestone with CONTEXT-DRAFT produces warning", () => {
    const ms = getMilestone("M002");
    assert.equal(ms?.status, "active");
    const draft = resolveMilestoneFile(tmpBase, "M002", "CONTEXT-DRAFT");
    assert.ok(draft, "CONTEXT-DRAFT file should be found for active milestone");
  });
  test("full pre-flight filter produces warnings only for active milestones", () => {
    const milestoneIds = ["M001", "M002", "M003"];
    const issues = [];
    for (const id of milestoneIds) {
      if (isDbAvailable()) {
        const ms = getMilestone(id);
        if (ms?.status === "complete" || ms?.status === "parked") continue;
      }
      const draft = resolveMilestoneFile(tmpBase, id, "CONTEXT-DRAFT");
      if (draft) {
        issues.push(`${id}: has CONTEXT-DRAFT.md (will pause for discussion)`);
      }
    }
    assert.equal(issues.length, 1, "only one warning should be emitted");
    assert.match(issues[0], /M002/, "warning should be for the active milestone only");
  });
  test("when DB is unavailable, all milestones with CONTEXT-DRAFT produce warnings (safe fallback)", () => {
    closeDatabase();
    assert.ok(!isDbAvailable(), "DB should be unavailable after close");
    const milestoneIds = ["M001", "M002", "M003"];
    const issues = [];
    for (const id of milestoneIds) {
      if (isDbAvailable()) {
        const ms = getMilestone(id);
        if (ms?.status === "complete" || ms?.status === "parked") continue;
      }
      const draft = resolveMilestoneFile(tmpBase, id, "CONTEXT-DRAFT");
      if (draft) {
        issues.push(`${id}: has CONTEXT-DRAFT.md (will pause for discussion)`);
      }
    }
    assert.equal(issues.length, 3, "all milestones should warn when DB is unavailable");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wcmVmbGlnaHQtY29udGV4dC1kcmFmdC1maWx0ZXIudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBSZWdyZXNzaW9uIHRlc3QgZm9yICMyNDczOiBQcmUtZmxpZ2h0IENPTlRFWFQtRFJBRlQgd2FybmluZyBzaG91bGQgc2tpcFxuICogY29tcGxldGVkIGFuZCBwYXJrZWQgbWlsZXN0b25lcy5cbiAqXG4gKiBUaGUgcHJlLWZsaWdodCBsb29wIGluIGF1dG8tc3RhcnQudHMgd2FybnMgYWJvdXQgQ09OVEVYVC1EUkFGVC5tZCBmaWxlc1xuICogc28gdGhlIHVzZXIga25vd3Mgd2hpY2ggbWlsZXN0b25lcyB3aWxsIHBhdXNlIGZvciBkaXNjdXNzaW9uLiBCdXQgY29tcGxldGVkXG4gKiBtaWxlc3RvbmVzIHdpdGggbGVmdG92ZXIgQ09OVEVYVC1EUkFGVC5tZCBmaWxlcyBhcmUgbm90IGFjdGlvbmFibGUgXHUyMDE0IHRoZVxuICogd2FybmluZyBpcyBub2lzZS5cbiAqXG4gKiBUaGlzIHRlc3QgZXhlcmNpc2VzIHRoZSBmaWx0ZXJpbmcgbG9naWMgZGlyZWN0bHk6IGdpdmVuIGEgc2V0IG9mIG1pbGVzdG9uZXNcbiAqIHdpdGggQ09OVEVYVC1EUkFGVCBmaWxlcywgb25seSBhY3RpdmUvcGVuZGluZyBvbmVzIHNob3VsZCBwcm9kdWNlIHdhcm5pbmdzLlxuICovXG5pbXBvcnQgeyBkZXNjcmliZSwgdGVzdCwgYmVmb3JlRWFjaCwgYWZ0ZXJFYWNoIH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgbWtkaXJTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5cbmltcG9ydCB7XG4gIG9wZW5EYXRhYmFzZSxcbiAgY2xvc2VEYXRhYmFzZSxcbiAgaXNEYkF2YWlsYWJsZSxcbiAgaW5zZXJ0TWlsZXN0b25lLFxuICBnZXRNaWxlc3RvbmUsXG59IGZyb20gXCIuLi9nc2QtZGIudHNcIjtcbmltcG9ydCB7IHJlc29sdmVNaWxlc3RvbmVGaWxlIH0gZnJvbSBcIi4uL3BhdGhzLnRzXCI7XG5cbmRlc2NyaWJlKFwicHJlLWZsaWdodCBDT05URVhULURSQUZUIGZpbHRlciAoIzI0NzMpXCIsICgpID0+IHtcbiAgbGV0IHRtcEJhc2U6IHN0cmluZztcbiAgbGV0IGdzZDogc3RyaW5nO1xuXG4gIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgIHRtcEJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1wcmVmbGlnaHQtZHJhZnQtXCIpKTtcbiAgICBnc2QgPSBqb2luKHRtcEJhc2UsIFwiLmdzZFwiKTtcblxuICAgIC8vIENyZWF0ZSBtaWxlc3RvbmUgZGlyZWN0b3JpZXMgd2l0aCBDT05URVhULURSQUZUIGZpbGVzXG4gICAgZm9yIChjb25zdCBpZCBvZiBbXCJNMDAxXCIsIFwiTTAwMlwiLCBcIk0wMDNcIl0pIHtcbiAgICAgIGNvbnN0IG1zRGlyID0gam9pbihnc2QsIFwibWlsZXN0b25lc1wiLCBpZCk7XG4gICAgICBta2RpclN5bmMobXNEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKG1zRGlyLCBgJHtpZH0tQ09OVEVYVC1EUkFGVC5tZGApLCBgIyAke2lkfTogRHJhZnRcXG5gKTtcbiAgICB9XG5cbiAgICAvLyBPcGVuIERCIGFuZCBpbnNlcnQgbWlsZXN0b25lcyB3aXRoIGRpZmZlcmVudCBzdGF0dXNlc1xuICAgIGNvbnN0IGRiUGF0aCA9IGpvaW4oZ3NkLCBcImdzZC5kYlwiKTtcbiAgICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIkNvbXBsZXRlIG1pbGVzdG9uZVwiLCBzdGF0dXM6IFwiY29tcGxldGVcIiB9KTtcbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAyXCIsIHRpdGxlOiBcIkFjdGl2ZSBtaWxlc3RvbmVcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDNcIiwgdGl0bGU6IFwiUGFya2VkIG1pbGVzdG9uZVwiLCBzdGF0dXM6IFwicGFya2VkXCIgfSk7XG4gIH0pO1xuXG4gIGFmdGVyRWFjaCgoKSA9PiB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIHJtU3luYyh0bXBCYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJjb21wbGV0ZWQgbWlsZXN0b25lIGlzIHNraXBwZWQgXHUyMDE0IG5vIHdhcm5pbmcgZW1pdHRlZFwiLCAoKSA9PiB7XG4gICAgYXNzZXJ0Lm9rKGlzRGJBdmFpbGFibGUoKSwgXCJEQiBzaG91bGQgYmUgYXZhaWxhYmxlXCIpO1xuICAgIGNvbnN0IG1zID0gZ2V0TWlsZXN0b25lKFwiTTAwMVwiKTtcbiAgICBhc3NlcnQuZXF1YWwobXM/LnN0YXR1cywgXCJjb21wbGV0ZVwiKTtcbiAgfSk7XG5cbiAgdGVzdChcInBhcmtlZCBtaWxlc3RvbmUgaXMgc2tpcHBlZCBcdTIwMTQgbm8gd2FybmluZyBlbWl0dGVkXCIsICgpID0+IHtcbiAgICBjb25zdCBtcyA9IGdldE1pbGVzdG9uZShcIk0wMDNcIik7XG4gICAgYXNzZXJ0LmVxdWFsKG1zPy5zdGF0dXMsIFwicGFya2VkXCIpO1xuICB9KTtcblxuICB0ZXN0KFwiYWN0aXZlIG1pbGVzdG9uZSB3aXRoIENPTlRFWFQtRFJBRlQgcHJvZHVjZXMgd2FybmluZ1wiLCAoKSA9PiB7XG4gICAgY29uc3QgbXMgPSBnZXRNaWxlc3RvbmUoXCJNMDAyXCIpO1xuICAgIGFzc2VydC5lcXVhbChtcz8uc3RhdHVzLCBcImFjdGl2ZVwiKTtcblxuICAgIGNvbnN0IGRyYWZ0ID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUodG1wQmFzZSwgXCJNMDAyXCIsIFwiQ09OVEVYVC1EUkFGVFwiKTtcbiAgICBhc3NlcnQub2soZHJhZnQsIFwiQ09OVEVYVC1EUkFGVCBmaWxlIHNob3VsZCBiZSBmb3VuZCBmb3IgYWN0aXZlIG1pbGVzdG9uZVwiKTtcbiAgfSk7XG5cbiAgdGVzdChcImZ1bGwgcHJlLWZsaWdodCBmaWx0ZXIgcHJvZHVjZXMgd2FybmluZ3Mgb25seSBmb3IgYWN0aXZlIG1pbGVzdG9uZXNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IG1pbGVzdG9uZUlkcyA9IFtcIk0wMDFcIiwgXCJNMDAyXCIsIFwiTTAwM1wiXTtcbiAgICBjb25zdCBpc3N1ZXM6IHN0cmluZ1tdID0gW107XG5cbiAgICBmb3IgKGNvbnN0IGlkIG9mIG1pbGVzdG9uZUlkcykge1xuICAgICAgLy8gUmVwbGljYXRlIHRoZSBmaXhlZCBwcmUtZmxpZ2h0IGxvZ2ljIGZyb20gYXV0by1zdGFydC50c1xuICAgICAgaWYgKGlzRGJBdmFpbGFibGUoKSkge1xuICAgICAgICBjb25zdCBtcyA9IGdldE1pbGVzdG9uZShpZCk7XG4gICAgICAgIGlmIChtcz8uc3RhdHVzID09PSBcImNvbXBsZXRlXCIgfHwgbXM/LnN0YXR1cyA9PT0gXCJwYXJrZWRcIikgY29udGludWU7XG4gICAgICB9XG4gICAgICBjb25zdCBkcmFmdCA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKHRtcEJhc2UsIGlkLCBcIkNPTlRFWFQtRFJBRlRcIik7XG4gICAgICBpZiAoZHJhZnQpIHtcbiAgICAgICAgaXNzdWVzLnB1c2goYCR7aWR9OiBoYXMgQ09OVEVYVC1EUkFGVC5tZCAod2lsbCBwYXVzZSBmb3IgZGlzY3Vzc2lvbilgKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBhc3NlcnQuZXF1YWwoaXNzdWVzLmxlbmd0aCwgMSwgXCJvbmx5IG9uZSB3YXJuaW5nIHNob3VsZCBiZSBlbWl0dGVkXCIpO1xuICAgIGFzc2VydC5tYXRjaChpc3N1ZXNbMF0sIC9NMDAyLywgXCJ3YXJuaW5nIHNob3VsZCBiZSBmb3IgdGhlIGFjdGl2ZSBtaWxlc3RvbmUgb25seVwiKTtcbiAgfSk7XG5cbiAgdGVzdChcIndoZW4gREIgaXMgdW5hdmFpbGFibGUsIGFsbCBtaWxlc3RvbmVzIHdpdGggQ09OVEVYVC1EUkFGVCBwcm9kdWNlIHdhcm5pbmdzIChzYWZlIGZhbGxiYWNrKVwiLCAoKSA9PiB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIGFzc2VydC5vayghaXNEYkF2YWlsYWJsZSgpLCBcIkRCIHNob3VsZCBiZSB1bmF2YWlsYWJsZSBhZnRlciBjbG9zZVwiKTtcblxuICAgIGNvbnN0IG1pbGVzdG9uZUlkcyA9IFtcIk0wMDFcIiwgXCJNMDAyXCIsIFwiTTAwM1wiXTtcbiAgICBjb25zdCBpc3N1ZXM6IHN0cmluZ1tdID0gW107XG5cbiAgICBmb3IgKGNvbnN0IGlkIG9mIG1pbGVzdG9uZUlkcykge1xuICAgICAgaWYgKGlzRGJBdmFpbGFibGUoKSkge1xuICAgICAgICBjb25zdCBtcyA9IGdldE1pbGVzdG9uZShpZCk7XG4gICAgICAgIGlmIChtcz8uc3RhdHVzID09PSBcImNvbXBsZXRlXCIgfHwgbXM/LnN0YXR1cyA9PT0gXCJwYXJrZWRcIikgY29udGludWU7XG4gICAgICB9XG4gICAgICBjb25zdCBkcmFmdCA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKHRtcEJhc2UsIGlkLCBcIkNPTlRFWFQtRFJBRlRcIik7XG4gICAgICBpZiAoZHJhZnQpIHtcbiAgICAgICAgaXNzdWVzLnB1c2goYCR7aWR9OiBoYXMgQ09OVEVYVC1EUkFGVC5tZCAod2lsbCBwYXVzZSBmb3IgZGlzY3Vzc2lvbilgKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBhc3NlcnQuZXF1YWwoaXNzdWVzLmxlbmd0aCwgMywgXCJhbGwgbWlsZXN0b25lcyBzaG91bGQgd2FybiB3aGVuIERCIGlzIHVuYXZhaWxhYmxlXCIpO1xuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBWUEsU0FBUyxVQUFVLE1BQU0sWUFBWSxpQkFBaUI7QUFDdEQsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxXQUFXLFFBQVEscUJBQXFCO0FBQzlELFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFFdkI7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFDUCxTQUFTLDRCQUE0QjtBQUVyQyxTQUFTLDJDQUEyQyxNQUFNO0FBQ3hELE1BQUk7QUFDSixNQUFJO0FBRUosYUFBVyxNQUFNO0FBQ2YsY0FBVSxZQUFZLEtBQUssT0FBTyxHQUFHLHNCQUFzQixDQUFDO0FBQzVELFVBQU0sS0FBSyxTQUFTLE1BQU07QUFHMUIsZUFBVyxNQUFNLENBQUMsUUFBUSxRQUFRLE1BQU0sR0FBRztBQUN6QyxZQUFNLFFBQVEsS0FBSyxLQUFLLGNBQWMsRUFBRTtBQUN4QyxnQkFBVSxPQUFPLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDcEMsb0JBQWMsS0FBSyxPQUFPLEdBQUcsRUFBRSxtQkFBbUIsR0FBRyxLQUFLLEVBQUU7QUFBQSxDQUFXO0FBQUEsSUFDekU7QUFHQSxVQUFNLFNBQVMsS0FBSyxLQUFLLFFBQVE7QUFDakMsaUJBQWEsTUFBTTtBQUNuQixvQkFBZ0IsRUFBRSxJQUFJLFFBQVEsT0FBTyxzQkFBc0IsUUFBUSxXQUFXLENBQUM7QUFDL0Usb0JBQWdCLEVBQUUsSUFBSSxRQUFRLE9BQU8sb0JBQW9CLFFBQVEsU0FBUyxDQUFDO0FBQzNFLG9CQUFnQixFQUFFLElBQUksUUFBUSxPQUFPLG9CQUFvQixRQUFRLFNBQVMsQ0FBQztBQUFBLEVBQzdFLENBQUM7QUFFRCxZQUFVLE1BQU07QUFDZCxrQkFBYztBQUNkLFdBQU8sU0FBUyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLEVBQ2xELENBQUM7QUFFRCxPQUFLLDREQUF1RCxNQUFNO0FBQ2hFLFdBQU8sR0FBRyxjQUFjLEdBQUcsd0JBQXdCO0FBQ25ELFVBQU0sS0FBSyxhQUFhLE1BQU07QUFDOUIsV0FBTyxNQUFNLElBQUksUUFBUSxVQUFVO0FBQUEsRUFDckMsQ0FBQztBQUVELE9BQUsseURBQW9ELE1BQU07QUFDN0QsVUFBTSxLQUFLLGFBQWEsTUFBTTtBQUM5QixXQUFPLE1BQU0sSUFBSSxRQUFRLFFBQVE7QUFBQSxFQUNuQyxDQUFDO0FBRUQsT0FBSyx3REFBd0QsTUFBTTtBQUNqRSxVQUFNLEtBQUssYUFBYSxNQUFNO0FBQzlCLFdBQU8sTUFBTSxJQUFJLFFBQVEsUUFBUTtBQUVqQyxVQUFNLFFBQVEscUJBQXFCLFNBQVMsUUFBUSxlQUFlO0FBQ25FLFdBQU8sR0FBRyxPQUFPLHlEQUF5RDtBQUFBLEVBQzVFLENBQUM7QUFFRCxPQUFLLHVFQUF1RSxNQUFNO0FBQ2hGLFVBQU0sZUFBZSxDQUFDLFFBQVEsUUFBUSxNQUFNO0FBQzVDLFVBQU0sU0FBbUIsQ0FBQztBQUUxQixlQUFXLE1BQU0sY0FBYztBQUU3QixVQUFJLGNBQWMsR0FBRztBQUNuQixjQUFNLEtBQUssYUFBYSxFQUFFO0FBQzFCLFlBQUksSUFBSSxXQUFXLGNBQWMsSUFBSSxXQUFXLFNBQVU7QUFBQSxNQUM1RDtBQUNBLFlBQU0sUUFBUSxxQkFBcUIsU0FBUyxJQUFJLGVBQWU7QUFDL0QsVUFBSSxPQUFPO0FBQ1QsZUFBTyxLQUFLLEdBQUcsRUFBRSxvREFBb0Q7QUFBQSxNQUN2RTtBQUFBLElBQ0Y7QUFFQSxXQUFPLE1BQU0sT0FBTyxRQUFRLEdBQUcsb0NBQW9DO0FBQ25FLFdBQU8sTUFBTSxPQUFPLENBQUMsR0FBRyxRQUFRLGlEQUFpRDtBQUFBLEVBQ25GLENBQUM7QUFFRCxPQUFLLDhGQUE4RixNQUFNO0FBQ3ZHLGtCQUFjO0FBQ2QsV0FBTyxHQUFHLENBQUMsY0FBYyxHQUFHLHNDQUFzQztBQUVsRSxVQUFNLGVBQWUsQ0FBQyxRQUFRLFFBQVEsTUFBTTtBQUM1QyxVQUFNLFNBQW1CLENBQUM7QUFFMUIsZUFBVyxNQUFNLGNBQWM7QUFDN0IsVUFBSSxjQUFjLEdBQUc7QUFDbkIsY0FBTSxLQUFLLGFBQWEsRUFBRTtBQUMxQixZQUFJLElBQUksV0FBVyxjQUFjLElBQUksV0FBVyxTQUFVO0FBQUEsTUFDNUQ7QUFDQSxZQUFNLFFBQVEscUJBQXFCLFNBQVMsSUFBSSxlQUFlO0FBQy9ELFVBQUksT0FBTztBQUNULGVBQU8sS0FBSyxHQUFHLEVBQUUsb0RBQW9EO0FBQUEsTUFDdkU7QUFBQSxJQUNGO0FBRUEsV0FBTyxNQUFNLE9BQU8sUUFBUSxHQUFHLG1EQUFtRDtBQUFBLEVBQ3BGLENBQUM7QUFDSCxDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
