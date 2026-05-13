import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateGSD,
  configureGSDPhaseAudit,
  deactivateGSD,
  setCurrentPhase,
  clearCurrentPhase,
  isGSDActive,
  getCurrentPhase
} from "../gsd-phase-state.js";
describe("gsd-phase-state", () => {
  beforeEach(() => {
    deactivateGSD();
  });
  it("tracks active/inactive state", () => {
    assert.equal(isGSDActive(), false);
    activateGSD();
    assert.equal(isGSDActive(), true);
    deactivateGSD();
    assert.equal(isGSDActive(), false);
  });
  it("tracks the current phase when active", () => {
    activateGSD();
    assert.equal(getCurrentPhase(), null);
    assert.equal(setCurrentPhase("plan-milestone"), true);
    assert.equal(getCurrentPhase(), "plan-milestone");
    clearCurrentPhase();
    assert.equal(getCurrentPhase(), null);
  });
  it("rejects phase changes while inactive", () => {
    assert.equal(setCurrentPhase("plan-milestone"), false);
    activateGSD();
    assert.equal(getCurrentPhase(), null);
  });
  it("returns null phase when inactive even if phase was set", () => {
    activateGSD();
    setCurrentPhase("plan-milestone");
    deactivateGSD();
    assert.equal(getCurrentPhase(), null);
  });
  it("deactivation clears the current phase", () => {
    activateGSD();
    setCurrentPhase("execute-task");
    deactivateGSD();
    activateGSD();
    assert.equal(getCurrentPhase(), null);
  });
  it("deactivation clears the audit context so later events do not carry stale trace data", () => {
    const basePath = mkdtempSync(join(tmpdir(), "gsd-phase-state-audit-"));
    try {
      activateGSD({ basePath, traceId: "stale-trace", causedBy: "test" });
      setCurrentPhase("plan-milestone");
      deactivateGSD();
      activateGSD();
      setCurrentPhase("execute-task");
      const eventsPath = join(basePath, ".gsd", "audit", "events.jsonl");
      if (existsSync(eventsPath)) {
        const contents = readFileSync(eventsPath, "utf-8");
        assert.equal(
          contents.includes("stale-trace") && contents.split("\n").filter((line) => line.includes("stale-trace") && line.includes("execute-task")).length > 0,
          false,
          "execute-task phase change must not be emitted under the deactivated trace"
        );
      }
    } finally {
      configureGSDPhaseAudit(null);
      deactivateGSD();
      rmSync(basePath, { recursive: true, force: true });
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL3NoYXJlZC90ZXN0cy9nc2QtcGhhc2Utc3RhdGUudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NEMiBTaGFyZWQgUGhhc2UgU3RhdGUgQ29vcmRpbmF0aW9uIFRlc3RzXG5cbmltcG9ydCB7IGRlc2NyaWJlLCBpdCwgYmVmb3JlRWFjaCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgZXhpc3RzU3luYywgbWtkdGVtcFN5bmMsIHJlYWRGaWxlU3luYywgcm1TeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHtcblx0YWN0aXZhdGVHU0QsXG5cdGNvbmZpZ3VyZUdTRFBoYXNlQXVkaXQsXG5cdGRlYWN0aXZhdGVHU0QsXG5cdHNldEN1cnJlbnRQaGFzZSxcblx0Y2xlYXJDdXJyZW50UGhhc2UsXG5cdGlzR1NEQWN0aXZlLFxuXHRnZXRDdXJyZW50UGhhc2UsXG59IGZyb20gXCIuLi9nc2QtcGhhc2Utc3RhdGUuanNcIjtcblxuZGVzY3JpYmUoXCJnc2QtcGhhc2Utc3RhdGVcIiwgKCkgPT4ge1xuXHRiZWZvcmVFYWNoKCgpID0+IHtcblx0XHRkZWFjdGl2YXRlR1NEKCk7XG5cdH0pO1xuXG5cdGl0KFwidHJhY2tzIGFjdGl2ZS9pbmFjdGl2ZSBzdGF0ZVwiLCAoKSA9PiB7XG5cdFx0YXNzZXJ0LmVxdWFsKGlzR1NEQWN0aXZlKCksIGZhbHNlKTtcblx0XHRhY3RpdmF0ZUdTRCgpO1xuXHRcdGFzc2VydC5lcXVhbChpc0dTREFjdGl2ZSgpLCB0cnVlKTtcblx0XHRkZWFjdGl2YXRlR1NEKCk7XG5cdFx0YXNzZXJ0LmVxdWFsKGlzR1NEQWN0aXZlKCksIGZhbHNlKTtcblx0fSk7XG5cblx0aXQoXCJ0cmFja3MgdGhlIGN1cnJlbnQgcGhhc2Ugd2hlbiBhY3RpdmVcIiwgKCkgPT4ge1xuXHRcdGFjdGl2YXRlR1NEKCk7XG5cdFx0YXNzZXJ0LmVxdWFsKGdldEN1cnJlbnRQaGFzZSgpLCBudWxsKTtcblx0XHRhc3NlcnQuZXF1YWwoc2V0Q3VycmVudFBoYXNlKFwicGxhbi1taWxlc3RvbmVcIiksIHRydWUpO1xuXHRcdGFzc2VydC5lcXVhbChnZXRDdXJyZW50UGhhc2UoKSwgXCJwbGFuLW1pbGVzdG9uZVwiKTtcblx0XHRjbGVhckN1cnJlbnRQaGFzZSgpO1xuXHRcdGFzc2VydC5lcXVhbChnZXRDdXJyZW50UGhhc2UoKSwgbnVsbCk7XG5cdH0pO1xuXG5cdGl0KFwicmVqZWN0cyBwaGFzZSBjaGFuZ2VzIHdoaWxlIGluYWN0aXZlXCIsICgpID0+IHtcblx0XHRhc3NlcnQuZXF1YWwoc2V0Q3VycmVudFBoYXNlKFwicGxhbi1taWxlc3RvbmVcIiksIGZhbHNlKTtcblx0XHRhY3RpdmF0ZUdTRCgpO1xuXHRcdGFzc2VydC5lcXVhbChnZXRDdXJyZW50UGhhc2UoKSwgbnVsbCk7XG5cdH0pO1xuXG5cdGl0KFwicmV0dXJucyBudWxsIHBoYXNlIHdoZW4gaW5hY3RpdmUgZXZlbiBpZiBwaGFzZSB3YXMgc2V0XCIsICgpID0+IHtcblx0XHRhY3RpdmF0ZUdTRCgpO1xuXHRcdHNldEN1cnJlbnRQaGFzZShcInBsYW4tbWlsZXN0b25lXCIpO1xuXHRcdGRlYWN0aXZhdGVHU0QoKTtcblx0XHRhc3NlcnQuZXF1YWwoZ2V0Q3VycmVudFBoYXNlKCksIG51bGwpO1xuXHR9KTtcblxuXHRpdChcImRlYWN0aXZhdGlvbiBjbGVhcnMgdGhlIGN1cnJlbnQgcGhhc2VcIiwgKCkgPT4ge1xuXHRcdGFjdGl2YXRlR1NEKCk7XG5cdFx0c2V0Q3VycmVudFBoYXNlKFwiZXhlY3V0ZS10YXNrXCIpO1xuXHRcdGRlYWN0aXZhdGVHU0QoKTtcblx0XHRhY3RpdmF0ZUdTRCgpO1xuXHRcdGFzc2VydC5lcXVhbChnZXRDdXJyZW50UGhhc2UoKSwgbnVsbCk7XG5cdH0pO1xuXG5cdGl0KFwiZGVhY3RpdmF0aW9uIGNsZWFycyB0aGUgYXVkaXQgY29udGV4dCBzbyBsYXRlciBldmVudHMgZG8gbm90IGNhcnJ5IHN0YWxlIHRyYWNlIGRhdGFcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGJhc2VQYXRoID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtcGhhc2Utc3RhdGUtYXVkaXQtXCIpKTtcblx0XHR0cnkge1xuXHRcdFx0YWN0aXZhdGVHU0QoeyBiYXNlUGF0aCwgdHJhY2VJZDogXCJzdGFsZS10cmFjZVwiLCBjYXVzZWRCeTogXCJ0ZXN0XCIgfSk7XG5cdFx0XHRzZXRDdXJyZW50UGhhc2UoXCJwbGFuLW1pbGVzdG9uZVwiKTtcblx0XHRcdGRlYWN0aXZhdGVHU0QoKTtcblxuXHRcdFx0Ly8gUmUtYWN0aXZhdGUgV0lUSE9VVCBhIGNvbnRleHQuIElmIGRlYWN0aXZhdGUgZGlkIG5vdCBjbGVhciB0aGVcblx0XHRcdC8vIHN0b3JlZCBjb250ZXh0LCB0aGlzIHNldEN1cnJlbnRQaGFzZSB3b3VsZCBlbWl0IGFuIGF1ZGl0IGV2ZW50XG5cdFx0XHQvLyB1c2luZyBcInN0YWxlLXRyYWNlXCIuXG5cdFx0XHRhY3RpdmF0ZUdTRCgpO1xuXHRcdFx0c2V0Q3VycmVudFBoYXNlKFwiZXhlY3V0ZS10YXNrXCIpO1xuXG5cdFx0XHRjb25zdCBldmVudHNQYXRoID0gam9pbihiYXNlUGF0aCwgXCIuZ3NkXCIsIFwiYXVkaXRcIiwgXCJldmVudHMuanNvbmxcIik7XG5cdFx0XHRpZiAoZXhpc3RzU3luYyhldmVudHNQYXRoKSkge1xuXHRcdFx0XHRjb25zdCBjb250ZW50cyA9IHJlYWRGaWxlU3luYyhldmVudHNQYXRoLCBcInV0Zi04XCIpO1xuXHRcdFx0XHRhc3NlcnQuZXF1YWwoXG5cdFx0XHRcdFx0Y29udGVudHMuaW5jbHVkZXMoXCJzdGFsZS10cmFjZVwiKSAmJlxuXHRcdFx0XHRcdFx0Y29udGVudHMuc3BsaXQoXCJcXG5cIikuZmlsdGVyKChsaW5lKSA9PiBsaW5lLmluY2x1ZGVzKFwic3RhbGUtdHJhY2VcIikgJiYgbGluZS5pbmNsdWRlcyhcImV4ZWN1dGUtdGFza1wiKSkubGVuZ3RoID4gMCxcblx0XHRcdFx0XHRmYWxzZSxcblx0XHRcdFx0XHRcImV4ZWN1dGUtdGFzayBwaGFzZSBjaGFuZ2UgbXVzdCBub3QgYmUgZW1pdHRlZCB1bmRlciB0aGUgZGVhY3RpdmF0ZWQgdHJhY2VcIixcblx0XHRcdFx0KTtcblx0XHRcdH1cblx0XHR9IGZpbmFsbHkge1xuXHRcdFx0Y29uZmlndXJlR1NEUGhhc2VBdWRpdChudWxsKTtcblx0XHRcdGRlYWN0aXZhdGVHU0QoKTtcblx0XHRcdHJtU3luYyhiYXNlUGF0aCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuXHRcdH1cblx0fSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUVBLFNBQVMsVUFBVSxJQUFJLGtCQUFrQjtBQUN6QyxPQUFPLFlBQVk7QUFDbkIsU0FBUyxZQUFZLGFBQWEsY0FBYyxjQUFjO0FBQzlELFNBQVMsY0FBYztBQUN2QixTQUFTLFlBQVk7QUFDckI7QUFBQSxFQUNDO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDTTtBQUVQLFNBQVMsbUJBQW1CLE1BQU07QUFDakMsYUFBVyxNQUFNO0FBQ2hCLGtCQUFjO0FBQUEsRUFDZixDQUFDO0FBRUQsS0FBRyxnQ0FBZ0MsTUFBTTtBQUN4QyxXQUFPLE1BQU0sWUFBWSxHQUFHLEtBQUs7QUFDakMsZ0JBQVk7QUFDWixXQUFPLE1BQU0sWUFBWSxHQUFHLElBQUk7QUFDaEMsa0JBQWM7QUFDZCxXQUFPLE1BQU0sWUFBWSxHQUFHLEtBQUs7QUFBQSxFQUNsQyxDQUFDO0FBRUQsS0FBRyx3Q0FBd0MsTUFBTTtBQUNoRCxnQkFBWTtBQUNaLFdBQU8sTUFBTSxnQkFBZ0IsR0FBRyxJQUFJO0FBQ3BDLFdBQU8sTUFBTSxnQkFBZ0IsZ0JBQWdCLEdBQUcsSUFBSTtBQUNwRCxXQUFPLE1BQU0sZ0JBQWdCLEdBQUcsZ0JBQWdCO0FBQ2hELHNCQUFrQjtBQUNsQixXQUFPLE1BQU0sZ0JBQWdCLEdBQUcsSUFBSTtBQUFBLEVBQ3JDLENBQUM7QUFFRCxLQUFHLHdDQUF3QyxNQUFNO0FBQ2hELFdBQU8sTUFBTSxnQkFBZ0IsZ0JBQWdCLEdBQUcsS0FBSztBQUNyRCxnQkFBWTtBQUNaLFdBQU8sTUFBTSxnQkFBZ0IsR0FBRyxJQUFJO0FBQUEsRUFDckMsQ0FBQztBQUVELEtBQUcsMERBQTBELE1BQU07QUFDbEUsZ0JBQVk7QUFDWixvQkFBZ0IsZ0JBQWdCO0FBQ2hDLGtCQUFjO0FBQ2QsV0FBTyxNQUFNLGdCQUFnQixHQUFHLElBQUk7QUFBQSxFQUNyQyxDQUFDO0FBRUQsS0FBRyx5Q0FBeUMsTUFBTTtBQUNqRCxnQkFBWTtBQUNaLG9CQUFnQixjQUFjO0FBQzlCLGtCQUFjO0FBQ2QsZ0JBQVk7QUFDWixXQUFPLE1BQU0sZ0JBQWdCLEdBQUcsSUFBSTtBQUFBLEVBQ3JDLENBQUM7QUFFRCxLQUFHLHVGQUF1RixNQUFNO0FBQy9GLFVBQU0sV0FBVyxZQUFZLEtBQUssT0FBTyxHQUFHLHdCQUF3QixDQUFDO0FBQ3JFLFFBQUk7QUFDSCxrQkFBWSxFQUFFLFVBQVUsU0FBUyxlQUFlLFVBQVUsT0FBTyxDQUFDO0FBQ2xFLHNCQUFnQixnQkFBZ0I7QUFDaEMsb0JBQWM7QUFLZCxrQkFBWTtBQUNaLHNCQUFnQixjQUFjO0FBRTlCLFlBQU0sYUFBYSxLQUFLLFVBQVUsUUFBUSxTQUFTLGNBQWM7QUFDakUsVUFBSSxXQUFXLFVBQVUsR0FBRztBQUMzQixjQUFNLFdBQVcsYUFBYSxZQUFZLE9BQU87QUFDakQsZUFBTztBQUFBLFVBQ04sU0FBUyxTQUFTLGFBQWEsS0FDOUIsU0FBUyxNQUFNLElBQUksRUFBRSxPQUFPLENBQUMsU0FBUyxLQUFLLFNBQVMsYUFBYSxLQUFLLEtBQUssU0FBUyxjQUFjLENBQUMsRUFBRSxTQUFTO0FBQUEsVUFDL0c7QUFBQSxVQUNBO0FBQUEsUUFDRDtBQUFBLE1BQ0Q7QUFBQSxJQUNELFVBQUU7QUFDRCw2QkFBdUIsSUFBSTtBQUMzQixvQkFBYztBQUNkLGFBQU8sVUFBVSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQ2xEO0FBQUEsRUFDRCxDQUFDO0FBQ0YsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
