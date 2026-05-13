import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadSyncMapping,
  saveSyncMapping,
  createEmptyMapping,
  getMilestoneRecord,
  getSliceRecord,
  getTaskRecord,
  getTaskIssueNumber,
  setMilestoneRecord,
  setSliceRecord,
  setTaskRecord
} from "../mapping.js";
describe("mapping", () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gsd-sync-test-"));
    mkdirSync(join(tmpDir, ".gsd"), { recursive: true });
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });
  it("loadSyncMapping returns null when no file exists", () => {
    const result = loadSyncMapping(tmpDir);
    assert.equal(result, null);
  });
  it("round-trips save/load", () => {
    const mapping = createEmptyMapping("owner/repo");
    saveSyncMapping(tmpDir, mapping);
    const loaded = loadSyncMapping(tmpDir);
    assert.deepEqual(loaded, mapping);
  });
  it("createEmptyMapping has correct structure", () => {
    const mapping = createEmptyMapping("owner/repo");
    assert.equal(mapping.version, 1);
    assert.equal(mapping.repo, "owner/repo");
    assert.deepEqual(mapping.milestones, {});
    assert.deepEqual(mapping.slices, {});
    assert.deepEqual(mapping.tasks, {});
  });
  it("milestone record accessors work", () => {
    const mapping = createEmptyMapping("owner/repo");
    assert.equal(getMilestoneRecord(mapping, "M001"), null);
    const record = {
      issueNumber: 42,
      ghMilestoneNumber: 1,
      lastSyncedAt: "2025-01-01T00:00:00Z",
      state: "open"
    };
    setMilestoneRecord(mapping, "M001", record);
    assert.deepEqual(getMilestoneRecord(mapping, "M001"), record);
  });
  it("slice record accessors work", () => {
    const mapping = createEmptyMapping("owner/repo");
    assert.equal(getSliceRecord(mapping, "M001", "S01"), null);
    const record = {
      issueNumber: 0,
      prNumber: 50,
      branch: "milestone/M001/S01",
      lastSyncedAt: "2025-01-01T00:00:00Z",
      state: "open"
    };
    setSliceRecord(mapping, "M001", "S01", record);
    assert.deepEqual(getSliceRecord(mapping, "M001", "S01"), record);
  });
  it("task record accessors work", () => {
    const mapping = createEmptyMapping("owner/repo");
    assert.equal(getTaskRecord(mapping, "M001", "S01", "T01"), null);
    assert.equal(getTaskIssueNumber(mapping, "M001", "S01", "T01"), null);
    const record = {
      issueNumber: 43,
      lastSyncedAt: "2025-01-01T00:00:00Z",
      state: "open"
    };
    setTaskRecord(mapping, "M001", "S01", "T01", record);
    assert.deepEqual(getTaskRecord(mapping, "M001", "S01", "T01"), record);
    assert.equal(getTaskIssueNumber(mapping, "M001", "S01", "T01"), 43);
  });
  it("rejects mapping with wrong version", () => {
    const mapping = createEmptyMapping("owner/repo");
    mapping.version = 2;
    saveSyncMapping(tmpDir, mapping);
    const loaded = loadSyncMapping(tmpDir);
    assert.equal(loaded, null);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dpdGh1Yi1zeW5jL3Rlc3RzL21hcHBpbmcudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgZGVzY3JpYmUsIGl0LCBiZWZvcmVFYWNoLCBhZnRlckVhY2ggfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBta2RpclN5bmMsIHJtU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7XG4gIGxvYWRTeW5jTWFwcGluZyxcbiAgc2F2ZVN5bmNNYXBwaW5nLFxuICBjcmVhdGVFbXB0eU1hcHBpbmcsXG4gIGdldE1pbGVzdG9uZVJlY29yZCxcbiAgZ2V0U2xpY2VSZWNvcmQsXG4gIGdldFRhc2tSZWNvcmQsXG4gIGdldFRhc2tJc3N1ZU51bWJlcixcbiAgc2V0TWlsZXN0b25lUmVjb3JkLFxuICBzZXRTbGljZVJlY29yZCxcbiAgc2V0VGFza1JlY29yZCxcbn0gZnJvbSBcIi4uL21hcHBpbmcudHNcIjtcbmltcG9ydCB0eXBlIHsgU3luY01hcHBpbmcsIE1pbGVzdG9uZVN5bmNSZWNvcmQsIFNsaWNlU3luY1JlY29yZCwgU3luY0VudGl0eVJlY29yZCB9IGZyb20gXCIuLi90eXBlcy50c1wiO1xuXG5kZXNjcmliZShcIm1hcHBpbmdcIiwgKCkgPT4ge1xuICBsZXQgdG1wRGlyOiBzdHJpbmc7XG5cbiAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgdG1wRGlyID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2Qtc3luYy10ZXN0LVwiKSk7XG4gICAgbWtkaXJTeW5jKGpvaW4odG1wRGlyLCBcIi5nc2RcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB9KTtcblxuICBhZnRlckVhY2goKCkgPT4ge1xuICAgIHJtU3luYyh0bXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfSk7XG5cbiAgaXQoXCJsb2FkU3luY01hcHBpbmcgcmV0dXJucyBudWxsIHdoZW4gbm8gZmlsZSBleGlzdHNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGxvYWRTeW5jTWFwcGluZyh0bXBEaXIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIG51bGwpO1xuICB9KTtcblxuICBpdChcInJvdW5kLXRyaXBzIHNhdmUvbG9hZFwiLCAoKSA9PiB7XG4gICAgY29uc3QgbWFwcGluZyA9IGNyZWF0ZUVtcHR5TWFwcGluZyhcIm93bmVyL3JlcG9cIik7XG4gICAgc2F2ZVN5bmNNYXBwaW5nKHRtcERpciwgbWFwcGluZyk7XG4gICAgY29uc3QgbG9hZGVkID0gbG9hZFN5bmNNYXBwaW5nKHRtcERpcik7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChsb2FkZWQsIG1hcHBpbmcpO1xuICB9KTtcblxuICBpdChcImNyZWF0ZUVtcHR5TWFwcGluZyBoYXMgY29ycmVjdCBzdHJ1Y3R1cmVcIiwgKCkgPT4ge1xuICAgIGNvbnN0IG1hcHBpbmcgPSBjcmVhdGVFbXB0eU1hcHBpbmcoXCJvd25lci9yZXBvXCIpO1xuICAgIGFzc2VydC5lcXVhbChtYXBwaW5nLnZlcnNpb24sIDEpO1xuICAgIGFzc2VydC5lcXVhbChtYXBwaW5nLnJlcG8sIFwib3duZXIvcmVwb1wiKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKG1hcHBpbmcubWlsZXN0b25lcywge30pO1xuICAgIGFzc2VydC5kZWVwRXF1YWwobWFwcGluZy5zbGljZXMsIHt9KTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKG1hcHBpbmcudGFza3MsIHt9KTtcbiAgfSk7XG5cbiAgaXQoXCJtaWxlc3RvbmUgcmVjb3JkIGFjY2Vzc29ycyB3b3JrXCIsICgpID0+IHtcbiAgICBjb25zdCBtYXBwaW5nID0gY3JlYXRlRW1wdHlNYXBwaW5nKFwib3duZXIvcmVwb1wiKTtcbiAgICBhc3NlcnQuZXF1YWwoZ2V0TWlsZXN0b25lUmVjb3JkKG1hcHBpbmcsIFwiTTAwMVwiKSwgbnVsbCk7XG5cbiAgICBjb25zdCByZWNvcmQ6IE1pbGVzdG9uZVN5bmNSZWNvcmQgPSB7XG4gICAgICBpc3N1ZU51bWJlcjogNDIsXG4gICAgICBnaE1pbGVzdG9uZU51bWJlcjogMSxcbiAgICAgIGxhc3RTeW5jZWRBdDogXCIyMDI1LTAxLTAxVDAwOjAwOjAwWlwiLFxuICAgICAgc3RhdGU6IFwib3BlblwiLFxuICAgIH07XG4gICAgc2V0TWlsZXN0b25lUmVjb3JkKG1hcHBpbmcsIFwiTTAwMVwiLCByZWNvcmQpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwoZ2V0TWlsZXN0b25lUmVjb3JkKG1hcHBpbmcsIFwiTTAwMVwiKSwgcmVjb3JkKTtcbiAgfSk7XG5cbiAgaXQoXCJzbGljZSByZWNvcmQgYWNjZXNzb3JzIHdvcmtcIiwgKCkgPT4ge1xuICAgIGNvbnN0IG1hcHBpbmcgPSBjcmVhdGVFbXB0eU1hcHBpbmcoXCJvd25lci9yZXBvXCIpO1xuICAgIGFzc2VydC5lcXVhbChnZXRTbGljZVJlY29yZChtYXBwaW5nLCBcIk0wMDFcIiwgXCJTMDFcIiksIG51bGwpO1xuXG4gICAgY29uc3QgcmVjb3JkOiBTbGljZVN5bmNSZWNvcmQgPSB7XG4gICAgICBpc3N1ZU51bWJlcjogMCxcbiAgICAgIHByTnVtYmVyOiA1MCxcbiAgICAgIGJyYW5jaDogXCJtaWxlc3RvbmUvTTAwMS9TMDFcIixcbiAgICAgIGxhc3RTeW5jZWRBdDogXCIyMDI1LTAxLTAxVDAwOjAwOjAwWlwiLFxuICAgICAgc3RhdGU6IFwib3BlblwiLFxuICAgIH07XG4gICAgc2V0U2xpY2VSZWNvcmQobWFwcGluZywgXCJNMDAxXCIsIFwiUzAxXCIsIHJlY29yZCk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChnZXRTbGljZVJlY29yZChtYXBwaW5nLCBcIk0wMDFcIiwgXCJTMDFcIiksIHJlY29yZCk7XG4gIH0pO1xuXG4gIGl0KFwidGFzayByZWNvcmQgYWNjZXNzb3JzIHdvcmtcIiwgKCkgPT4ge1xuICAgIGNvbnN0IG1hcHBpbmcgPSBjcmVhdGVFbXB0eU1hcHBpbmcoXCJvd25lci9yZXBvXCIpO1xuICAgIGFzc2VydC5lcXVhbChnZXRUYXNrUmVjb3JkKG1hcHBpbmcsIFwiTTAwMVwiLCBcIlMwMVwiLCBcIlQwMVwiKSwgbnVsbCk7XG4gICAgYXNzZXJ0LmVxdWFsKGdldFRhc2tJc3N1ZU51bWJlcihtYXBwaW5nLCBcIk0wMDFcIiwgXCJTMDFcIiwgXCJUMDFcIiksIG51bGwpO1xuXG4gICAgY29uc3QgcmVjb3JkOiBTeW5jRW50aXR5UmVjb3JkID0ge1xuICAgICAgaXNzdWVOdW1iZXI6IDQzLFxuICAgICAgbGFzdFN5bmNlZEF0OiBcIjIwMjUtMDEtMDFUMDA6MDA6MDBaXCIsXG4gICAgICBzdGF0ZTogXCJvcGVuXCIsXG4gICAgfTtcbiAgICBzZXRUYXNrUmVjb3JkKG1hcHBpbmcsIFwiTTAwMVwiLCBcIlMwMVwiLCBcIlQwMVwiLCByZWNvcmQpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwoZ2V0VGFza1JlY29yZChtYXBwaW5nLCBcIk0wMDFcIiwgXCJTMDFcIiwgXCJUMDFcIiksIHJlY29yZCk7XG4gICAgYXNzZXJ0LmVxdWFsKGdldFRhc2tJc3N1ZU51bWJlcihtYXBwaW5nLCBcIk0wMDFcIiwgXCJTMDFcIiwgXCJUMDFcIiksIDQzKTtcbiAgfSk7XG5cbiAgaXQoXCJyZWplY3RzIG1hcHBpbmcgd2l0aCB3cm9uZyB2ZXJzaW9uXCIsICgpID0+IHtcbiAgICBjb25zdCBtYXBwaW5nID0gY3JlYXRlRW1wdHlNYXBwaW5nKFwib3duZXIvcmVwb1wiKTtcbiAgICAobWFwcGluZyBhcyBhbnkpLnZlcnNpb24gPSAyO1xuICAgIHNhdmVTeW5jTWFwcGluZyh0bXBEaXIsIG1hcHBpbmcpO1xuICAgIGNvbnN0IGxvYWRlZCA9IGxvYWRTeW5jTWFwcGluZyh0bXBEaXIpO1xuICAgIGFzc2VydC5lcXVhbChsb2FkZWQsIG51bGwpO1xuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxVQUFVLElBQUksWUFBWSxpQkFBaUI7QUFDcEQsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxXQUFXLGNBQWM7QUFDL0MsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUN2QjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBR1AsU0FBUyxXQUFXLE1BQU07QUFDeEIsTUFBSTtBQUVKLGFBQVcsTUFBTTtBQUNmLGFBQVMsWUFBWSxLQUFLLE9BQU8sR0FBRyxnQkFBZ0IsQ0FBQztBQUNyRCxjQUFVLEtBQUssUUFBUSxNQUFNLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUFBLEVBQ3JELENBQUM7QUFFRCxZQUFVLE1BQU07QUFDZCxXQUFPLFFBQVEsRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUNqRCxDQUFDO0FBRUQsS0FBRyxvREFBb0QsTUFBTTtBQUMzRCxVQUFNLFNBQVMsZ0JBQWdCLE1BQU07QUFDckMsV0FBTyxNQUFNLFFBQVEsSUFBSTtBQUFBLEVBQzNCLENBQUM7QUFFRCxLQUFHLHlCQUF5QixNQUFNO0FBQ2hDLFVBQU0sVUFBVSxtQkFBbUIsWUFBWTtBQUMvQyxvQkFBZ0IsUUFBUSxPQUFPO0FBQy9CLFVBQU0sU0FBUyxnQkFBZ0IsTUFBTTtBQUNyQyxXQUFPLFVBQVUsUUFBUSxPQUFPO0FBQUEsRUFDbEMsQ0FBQztBQUVELEtBQUcsNENBQTRDLE1BQU07QUFDbkQsVUFBTSxVQUFVLG1CQUFtQixZQUFZO0FBQy9DLFdBQU8sTUFBTSxRQUFRLFNBQVMsQ0FBQztBQUMvQixXQUFPLE1BQU0sUUFBUSxNQUFNLFlBQVk7QUFDdkMsV0FBTyxVQUFVLFFBQVEsWUFBWSxDQUFDLENBQUM7QUFDdkMsV0FBTyxVQUFVLFFBQVEsUUFBUSxDQUFDLENBQUM7QUFDbkMsV0FBTyxVQUFVLFFBQVEsT0FBTyxDQUFDLENBQUM7QUFBQSxFQUNwQyxDQUFDO0FBRUQsS0FBRyxtQ0FBbUMsTUFBTTtBQUMxQyxVQUFNLFVBQVUsbUJBQW1CLFlBQVk7QUFDL0MsV0FBTyxNQUFNLG1CQUFtQixTQUFTLE1BQU0sR0FBRyxJQUFJO0FBRXRELFVBQU0sU0FBOEI7QUFBQSxNQUNsQyxhQUFhO0FBQUEsTUFDYixtQkFBbUI7QUFBQSxNQUNuQixjQUFjO0FBQUEsTUFDZCxPQUFPO0FBQUEsSUFDVDtBQUNBLHVCQUFtQixTQUFTLFFBQVEsTUFBTTtBQUMxQyxXQUFPLFVBQVUsbUJBQW1CLFNBQVMsTUFBTSxHQUFHLE1BQU07QUFBQSxFQUM5RCxDQUFDO0FBRUQsS0FBRywrQkFBK0IsTUFBTTtBQUN0QyxVQUFNLFVBQVUsbUJBQW1CLFlBQVk7QUFDL0MsV0FBTyxNQUFNLGVBQWUsU0FBUyxRQUFRLEtBQUssR0FBRyxJQUFJO0FBRXpELFVBQU0sU0FBMEI7QUFBQSxNQUM5QixhQUFhO0FBQUEsTUFDYixVQUFVO0FBQUEsTUFDVixRQUFRO0FBQUEsTUFDUixjQUFjO0FBQUEsTUFDZCxPQUFPO0FBQUEsSUFDVDtBQUNBLG1CQUFlLFNBQVMsUUFBUSxPQUFPLE1BQU07QUFDN0MsV0FBTyxVQUFVLGVBQWUsU0FBUyxRQUFRLEtBQUssR0FBRyxNQUFNO0FBQUEsRUFDakUsQ0FBQztBQUVELEtBQUcsOEJBQThCLE1BQU07QUFDckMsVUFBTSxVQUFVLG1CQUFtQixZQUFZO0FBQy9DLFdBQU8sTUFBTSxjQUFjLFNBQVMsUUFBUSxPQUFPLEtBQUssR0FBRyxJQUFJO0FBQy9ELFdBQU8sTUFBTSxtQkFBbUIsU0FBUyxRQUFRLE9BQU8sS0FBSyxHQUFHLElBQUk7QUFFcEUsVUFBTSxTQUEyQjtBQUFBLE1BQy9CLGFBQWE7QUFBQSxNQUNiLGNBQWM7QUFBQSxNQUNkLE9BQU87QUFBQSxJQUNUO0FBQ0Esa0JBQWMsU0FBUyxRQUFRLE9BQU8sT0FBTyxNQUFNO0FBQ25ELFdBQU8sVUFBVSxjQUFjLFNBQVMsUUFBUSxPQUFPLEtBQUssR0FBRyxNQUFNO0FBQ3JFLFdBQU8sTUFBTSxtQkFBbUIsU0FBUyxRQUFRLE9BQU8sS0FBSyxHQUFHLEVBQUU7QUFBQSxFQUNwRSxDQUFDO0FBRUQsS0FBRyxzQ0FBc0MsTUFBTTtBQUM3QyxVQUFNLFVBQVUsbUJBQW1CLFlBQVk7QUFDL0MsSUFBQyxRQUFnQixVQUFVO0FBQzNCLG9CQUFnQixRQUFRLE9BQU87QUFDL0IsVUFBTSxTQUFTLGdCQUFnQixNQUFNO0FBQ3JDLFdBQU8sTUFBTSxRQUFRLElBQUk7QUFBQSxFQUMzQixDQUFDO0FBQ0gsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
