import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  openDatabase,
  closeDatabase,
  insertGateRow,
  markAllGatesOmitted,
  getGateResults,
  getPendingGates,
  insertMilestone,
  insertSlice
} from "../gsd-db.js";
describe("gate-state canonicalization (#4950)", () => {
  let tmpDir;
  let dbPath;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gate-canon-test-"));
    dbPath = join(tmpDir, "gsd.db");
    openDatabase(dbPath);
    insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
    insertSlice({
      milestoneId: "M001",
      id: "S01",
      title: "Test Slice",
      status: "pending",
      risk: "medium",
      depends: []
    });
  });
  afterEach(() => {
    closeDatabase();
    rmSync(tmpDir, { recursive: true, force: true });
  });
  test("markAllGatesOmitted produces status=complete, verdict=omitted (not status=omitted)", () => {
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", scope: "slice" });
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q4", scope: "slice" });
    markAllGatesOmitted("M001", "S01");
    const all = getGateResults("M001", "S01");
    assert.equal(all.length, 2);
    for (const g of all) {
      assert.equal(g.status, "complete", `expected status=complete for gate ${g.gate_id}`);
      assert.equal(g.verdict, "omitted", `expected verdict=omitted for gate ${g.gate_id}`);
    }
  });
  test("markAllGatesOmitted leaves no pending gates", () => {
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", scope: "slice" });
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q4", scope: "slice" });
    markAllGatesOmitted("M001", "S01");
    const pending = getPendingGates("M001", "S01");
    assert.equal(pending.length, 0);
  });
  test("pending gate verdict is null, not empty string", () => {
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", scope: "slice" });
    const pending = getPendingGates("M001", "S01");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].verdict, null, "pending gate verdict must be null, not empty string");
  });
  test("complete gate verdict round-trips as a valid GateVerdict (pass/flag/omitted only)", () => {
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q4", scope: "slice" });
    markAllGatesOmitted("M001", "S01");
    const results = getGateResults("M001", "S01");
    const q4 = results.find((g) => g.gate_id === "Q4");
    assert.ok(q4, "Q4 gate must exist");
    const validVerdicts = ["pass", "flag", "omitted"];
    assert.ok(
      q4.verdict !== null && validVerdicts.includes(q4.verdict),
      `verdict "${q4.verdict}" must be one of: ${validVerdicts.join(", ")}`
    );
  });
  test("empty-string verdict is not reachable after round-trip through DB", () => {
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", scope: "slice" });
    markAllGatesOmitted("M001", "S01");
    const results = getGateResults("M001", "S01");
    for (const g of results) {
      assert.notEqual(g.verdict, "", `gate ${g.gate_id} verdict must not be empty string`);
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9nYXRlLXN0YXRlLWNhbm9uaWNhbGl6YXRpb24udGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NEIEdhdGUgU3RhdGUgQ2Fub25pY2FsaXphdGlvbiBUZXN0c1xuLy8gUmVncmVzc2lvbiB0ZXN0cyBmb3IgIzQ5NTA6IGNhbm9uaWNhbCBvbWl0dGVkIHN0YXRlIGFuZCBHYXRlVmVyZGljdCB0eXBlIG5hcnJvd2luZy5cblxuaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QsIGJlZm9yZUVhY2gsIGFmdGVyRWFjaCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIHJtU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcblxuaW1wb3J0IHtcbiAgb3BlbkRhdGFiYXNlLFxuICBjbG9zZURhdGFiYXNlLFxuICBpbnNlcnRHYXRlUm93LFxuICBtYXJrQWxsR2F0ZXNPbWl0dGVkLFxuICBnZXRHYXRlUmVzdWx0cyxcbiAgZ2V0UGVuZGluZ0dhdGVzLFxuICBpbnNlcnRNaWxlc3RvbmUsXG4gIGluc2VydFNsaWNlLFxufSBmcm9tIFwiLi4vZ3NkLWRiLnRzXCI7XG5pbXBvcnQgdHlwZSB7IEdhdGVWZXJkaWN0IH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5cbmRlc2NyaWJlKFwiZ2F0ZS1zdGF0ZSBjYW5vbmljYWxpemF0aW9uICgjNDk1MClcIiwgKCkgPT4ge1xuICBsZXQgdG1wRGlyOiBzdHJpbmc7XG4gIGxldCBkYlBhdGg6IHN0cmluZztcblxuICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICB0bXBEaXIgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdhdGUtY2Fub24tdGVzdC1cIikpO1xuICAgIGRiUGF0aCA9IGpvaW4odG1wRGlyLCBcImdzZC5kYlwiKTtcbiAgICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3QgTWlsZXN0b25lXCIsIHN0YXR1czogXCJhY3RpdmVcIiB9KTtcbiAgICBpbnNlcnRTbGljZSh7XG4gICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICBpZDogXCJTMDFcIixcbiAgICAgIHRpdGxlOiBcIlRlc3QgU2xpY2VcIixcbiAgICAgIHN0YXR1czogXCJwZW5kaW5nXCIsXG4gICAgICByaXNrOiBcIm1lZGl1bVwiLFxuICAgICAgZGVwZW5kczogW10sXG4gICAgfSk7XG4gIH0pO1xuXG4gIGFmdGVyRWFjaCgoKSA9PiB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIHJtU3luYyh0bXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfSk7XG5cbiAgdGVzdChcIm1hcmtBbGxHYXRlc09taXR0ZWQgcHJvZHVjZXMgc3RhdHVzPWNvbXBsZXRlLCB2ZXJkaWN0PW9taXR0ZWQgKG5vdCBzdGF0dXM9b21pdHRlZClcIiwgKCkgPT4ge1xuICAgIGluc2VydEdhdGVSb3coeyBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHNsaWNlSWQ6IFwiUzAxXCIsIGdhdGVJZDogXCJRM1wiLCBzY29wZTogXCJzbGljZVwiIH0pO1xuICAgIGluc2VydEdhdGVSb3coeyBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHNsaWNlSWQ6IFwiUzAxXCIsIGdhdGVJZDogXCJRNFwiLCBzY29wZTogXCJzbGljZVwiIH0pO1xuXG4gICAgbWFya0FsbEdhdGVzT21pdHRlZChcIk0wMDFcIiwgXCJTMDFcIik7XG5cbiAgICBjb25zdCBhbGwgPSBnZXRHYXRlUmVzdWx0cyhcIk0wMDFcIiwgXCJTMDFcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGFsbC5sZW5ndGgsIDIpO1xuICAgIGZvciAoY29uc3QgZyBvZiBhbGwpIHtcbiAgICAgIGFzc2VydC5lcXVhbChnLnN0YXR1cywgXCJjb21wbGV0ZVwiLCBgZXhwZWN0ZWQgc3RhdHVzPWNvbXBsZXRlIGZvciBnYXRlICR7Zy5nYXRlX2lkfWApO1xuICAgICAgYXNzZXJ0LmVxdWFsKGcudmVyZGljdCwgXCJvbWl0dGVkXCIsIGBleHBlY3RlZCB2ZXJkaWN0PW9taXR0ZWQgZm9yIGdhdGUgJHtnLmdhdGVfaWR9YCk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwibWFya0FsbEdhdGVzT21pdHRlZCBsZWF2ZXMgbm8gcGVuZGluZyBnYXRlc1wiLCAoKSA9PiB7XG4gICAgaW5zZXJ0R2F0ZVJvdyh7IG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgc2xpY2VJZDogXCJTMDFcIiwgZ2F0ZUlkOiBcIlEzXCIsIHNjb3BlOiBcInNsaWNlXCIgfSk7XG4gICAgaW5zZXJ0R2F0ZVJvdyh7IG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgc2xpY2VJZDogXCJTMDFcIiwgZ2F0ZUlkOiBcIlE0XCIsIHNjb3BlOiBcInNsaWNlXCIgfSk7XG5cbiAgICBtYXJrQWxsR2F0ZXNPbWl0dGVkKFwiTTAwMVwiLCBcIlMwMVwiKTtcblxuICAgIGNvbnN0IHBlbmRpbmcgPSBnZXRQZW5kaW5nR2F0ZXMoXCJNMDAxXCIsIFwiUzAxXCIpO1xuICAgIGFzc2VydC5lcXVhbChwZW5kaW5nLmxlbmd0aCwgMCk7XG4gIH0pO1xuXG4gIHRlc3QoXCJwZW5kaW5nIGdhdGUgdmVyZGljdCBpcyBudWxsLCBub3QgZW1wdHkgc3RyaW5nXCIsICgpID0+IHtcbiAgICBpbnNlcnRHYXRlUm93KHsgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCBzbGljZUlkOiBcIlMwMVwiLCBnYXRlSWQ6IFwiUTNcIiwgc2NvcGU6IFwic2xpY2VcIiB9KTtcblxuICAgIGNvbnN0IHBlbmRpbmcgPSBnZXRQZW5kaW5nR2F0ZXMoXCJNMDAxXCIsIFwiUzAxXCIpO1xuICAgIGFzc2VydC5lcXVhbChwZW5kaW5nLmxlbmd0aCwgMSk7XG4gICAgYXNzZXJ0LmVxdWFsKHBlbmRpbmdbMF0udmVyZGljdCwgbnVsbCwgXCJwZW5kaW5nIGdhdGUgdmVyZGljdCBtdXN0IGJlIG51bGwsIG5vdCBlbXB0eSBzdHJpbmdcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJjb21wbGV0ZSBnYXRlIHZlcmRpY3Qgcm91bmQtdHJpcHMgYXMgYSB2YWxpZCBHYXRlVmVyZGljdCAocGFzcy9mbGFnL29taXR0ZWQgb25seSlcIiwgKCkgPT4ge1xuICAgIGluc2VydEdhdGVSb3coeyBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHNsaWNlSWQ6IFwiUzAxXCIsIGdhdGVJZDogXCJRNFwiLCBzY29wZTogXCJzbGljZVwiIH0pO1xuICAgIG1hcmtBbGxHYXRlc09taXR0ZWQoXCJNMDAxXCIsIFwiUzAxXCIpO1xuXG4gICAgY29uc3QgcmVzdWx0cyA9IGdldEdhdGVSZXN1bHRzKFwiTTAwMVwiLCBcIlMwMVwiKTtcbiAgICBjb25zdCBxNCA9IHJlc3VsdHMuZmluZCgoZykgPT4gZy5nYXRlX2lkID09PSBcIlE0XCIpO1xuICAgIGFzc2VydC5vayhxNCwgXCJRNCBnYXRlIG11c3QgZXhpc3RcIik7XG5cbiAgICBjb25zdCB2YWxpZFZlcmRpY3RzOiBHYXRlVmVyZGljdFtdID0gW1wicGFzc1wiLCBcImZsYWdcIiwgXCJvbWl0dGVkXCJdO1xuICAgIGFzc2VydC5vayhcbiAgICAgIHE0LnZlcmRpY3QgIT09IG51bGwgJiYgdmFsaWRWZXJkaWN0cy5pbmNsdWRlcyhxNC52ZXJkaWN0KSxcbiAgICAgIGB2ZXJkaWN0IFwiJHtxNC52ZXJkaWN0fVwiIG11c3QgYmUgb25lIG9mOiAke3ZhbGlkVmVyZGljdHMuam9pbihcIiwgXCIpfWAsXG4gICAgKTtcbiAgfSk7XG5cbiAgdGVzdChcImVtcHR5LXN0cmluZyB2ZXJkaWN0IGlzIG5vdCByZWFjaGFibGUgYWZ0ZXIgcm91bmQtdHJpcCB0aHJvdWdoIERCXCIsICgpID0+IHtcbiAgICBpbnNlcnRHYXRlUm93KHsgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCBzbGljZUlkOiBcIlMwMVwiLCBnYXRlSWQ6IFwiUTNcIiwgc2NvcGU6IFwic2xpY2VcIiB9KTtcbiAgICBtYXJrQWxsR2F0ZXNPbWl0dGVkKFwiTTAwMVwiLCBcIlMwMVwiKTtcblxuICAgIGNvbnN0IHJlc3VsdHMgPSBnZXRHYXRlUmVzdWx0cyhcIk0wMDFcIiwgXCJTMDFcIik7XG4gICAgZm9yIChjb25zdCBnIG9mIHJlc3VsdHMpIHtcbiAgICAgIGFzc2VydC5ub3RFcXVhbChnLnZlcmRpY3QsIFwiXCIsIGBnYXRlICR7Zy5nYXRlX2lkfSB2ZXJkaWN0IG11c3Qgbm90IGJlIGVtcHR5IHN0cmluZ2ApO1xuICAgIH1cbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUdBLFNBQVMsVUFBVSxNQUFNLFlBQVksaUJBQWlCO0FBQ3RELE9BQU8sWUFBWTtBQUNuQixTQUFTLGFBQWEsY0FBYztBQUNwQyxTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBRXZCO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBR1AsU0FBUyx1Q0FBdUMsTUFBTTtBQUNwRCxNQUFJO0FBQ0osTUFBSTtBQUVKLGFBQVcsTUFBTTtBQUNmLGFBQVMsWUFBWSxLQUFLLE9BQU8sR0FBRyxrQkFBa0IsQ0FBQztBQUN2RCxhQUFTLEtBQUssUUFBUSxRQUFRO0FBQzlCLGlCQUFhLE1BQU07QUFDbkIsb0JBQWdCLEVBQUUsSUFBSSxRQUFRLE9BQU8sa0JBQWtCLFFBQVEsU0FBUyxDQUFDO0FBQ3pFLGdCQUFZO0FBQUEsTUFDVixhQUFhO0FBQUEsTUFDYixJQUFJO0FBQUEsTUFDSixPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixNQUFNO0FBQUEsTUFDTixTQUFTLENBQUM7QUFBQSxJQUNa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
