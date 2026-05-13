import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  insertGateRow,
  getGateResults
} from "../gsd-db.js";
import { handleCompleteSlice } from "../tools/complete-slice.js";
function makeValidSliceParams(overrides = {}) {
  return {
    sliceId: "S01",
    milestoneId: "M001",
    sliceTitle: "Test Slice",
    oneLiner: "Implemented test slice",
    narrative: "Built and tested.",
    verification: "All tests pass.",
    deviations: "None.",
    knownLimitations: "None.",
    followUps: "None.",
    keyFiles: ["src/foo.ts"],
    keyDecisions: [],
    patternsEstablished: [],
    observabilitySurfaces: [],
    provides: [],
    requirementsSurfaced: [],
    drillDownPaths: [],
    affects: [],
    requirementsAdvanced: [],
    requirementsValidated: [],
    requirementsInvalidated: [],
    filesModified: [],
    requires: [],
    uatContent: "## Smoke Test\n\nVerify happy path.",
    ...overrides
  };
}
describe("complete-slice closes complete-slice-owned gates", () => {
  let dbPath;
  let basePath;
  beforeEach(() => {
    dbPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "gsd-slice-gate-")),
      "test.db"
    );
    openDatabase(dbPath);
    basePath = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-slice-gate-handler-"));
    const sliceDir = path.join(
      basePath,
      ".gsd",
      "milestones",
      "M001",
      "slices",
      "S01",
      "tasks"
    );
    fs.mkdirSync(sliceDir, { recursive: true });
    fs.writeFileSync(
      path.join(basePath, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
      [
        "# M001: Test Milestone",
        "",
        "## Slices",
        "",
        "- [ ] **S01: Test Slice** `risk:medium` `depends:[]`",
        "  - After this: basic functionality works"
      ].join("\n")
    );
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001" });
    insertTask({
      id: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      status: "complete",
      title: "Task 1"
    });
    insertGateRow({
      milestoneId: "M001",
      sliceId: "S01",
      gateId: "Q8",
      scope: "slice"
    });
  });
  afterEach(() => {
    closeDatabase();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    fs.rmSync(basePath, { recursive: true, force: true });
  });
  test("Q8 closes as 'pass' when operationalReadiness is populated", async () => {
    const params = makeValidSliceParams({
      operationalReadiness: [
        "- Health signal: /health endpoint returns 200",
        "- Failure signal: error rate alert in observability dashboard",
        "- Recovery: systemd auto-restart"
      ].join("\n")
    });
    const result = await handleCompleteSlice(params, basePath);
    assert.ok(!("error" in result), `handler failed: ${result.error}`);
    const gates = getGateResults("M001", "S01", "slice");
    const q8 = gates.find((g) => g.gate_id === "Q8");
    assert.ok(q8, "Q8 row must exist after complete-slice");
    assert.equal(q8.status, "complete");
    assert.equal(q8.verdict, "pass");
    assert.ok(
      q8.findings.includes("Health signal"),
      "Q8 findings must capture the operationalReadiness content"
    );
  });
  test("Q8 closes as 'omitted' when operationalReadiness is empty", async () => {
    const params = makeValidSliceParams({ operationalReadiness: "" });
    const result = await handleCompleteSlice(params, basePath);
    assert.ok(!("error" in result), `handler failed: ${result.error}`);
    const gates = getGateResults("M001", "S01", "slice");
    const q8 = gates.find((g) => g.gate_id === "Q8");
    assert.ok(q8, "Q8 row must exist after complete-slice");
    assert.equal(q8.status, "complete");
    assert.equal(q8.verdict, "omitted");
  });
  test("Q8 also closes when operationalReadiness is omitted entirely", async () => {
    const params = makeValidSliceParams();
    const result = await handleCompleteSlice(params, basePath);
    assert.ok(!("error" in result), `handler failed: ${result.error}`);
    const gates = getGateResults("M001", "S01", "slice");
    const q8 = gates.find((g) => g.gate_id === "Q8");
    assert.ok(q8);
    assert.notEqual(q8.status, "pending", "Q8 must never remain pending after complete-slice");
    assert.equal(q8.verdict, "omitted");
  });
  test("summary markdown contains Operational Readiness section", async () => {
    const params = makeValidSliceParams({
      operationalReadiness: "- Health signal: /health\n- Failure signal: alert"
    });
    const result = await handleCompleteSlice(params, basePath);
    assert.ok(!("error" in result));
    if (!("error" in result)) {
      const summary = fs.readFileSync(result.summaryPath, "utf-8");
      assert.match(summary, /^## Operational Readiness/m);
      assert.match(summary, /Health signal: \/health/);
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9jb21wbGV0ZS1zbGljZS1nYXRlLWNsb3N1cmUudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBjb21wbGV0ZS1zbGljZSBnYXRlIGNsb3N1cmUgaW50ZWdyYXRpb24gdGVzdC5cbiAqXG4gKiBQaW5zIHRoZSBmaXggZm9yIHRoZSBROC1zdGFsbCBidWc6IGNvbXBsZXRlLXNsaWNlIG11c3QgY2xvc2UgZXZlcnkgZ2F0ZVxuICogb3duZWQgYnkgdGhlIGNvbXBsZXRlLXNsaWNlIHR1cm4gYmFzZWQgb24gdGhlIGNvbnRlbnQgb2YgdGhlIG1hdGNoaW5nXG4gKiBDb21wbGV0ZVNsaWNlUGFyYW1zIGZpZWxkLiBXaXRob3V0IHRoaXMsIFE4IHN0YXlzIHBlbmRpbmcgZm9yZXZlciBhbmRcbiAqIGJsb2NrcyBzdGF0ZSBkZXJpdmF0aW9uIG9uIHN1YnNlcXVlbnQgbG9vcHMuXG4gKi9cblxuaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QsIGJlZm9yZUVhY2gsIGFmdGVyRWFjaCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0ICogYXMgZnMgZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCAqIGFzIHBhdGggZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0ICogYXMgb3MgZnJvbSBcIm5vZGU6b3NcIjtcblxuaW1wb3J0IHtcbiAgb3BlbkRhdGFiYXNlLFxuICBjbG9zZURhdGFiYXNlLFxuICBpbnNlcnRNaWxlc3RvbmUsXG4gIGluc2VydFNsaWNlLFxuICBpbnNlcnRUYXNrLFxuICBpbnNlcnRHYXRlUm93LFxuICBnZXRHYXRlUmVzdWx0cyxcbn0gZnJvbSBcIi4uL2dzZC1kYi50c1wiO1xuaW1wb3J0IHsgaGFuZGxlQ29tcGxldGVTbGljZSB9IGZyb20gXCIuLi90b29scy9jb21wbGV0ZS1zbGljZS50c1wiO1xuaW1wb3J0IHR5cGUgeyBDb21wbGV0ZVNsaWNlUGFyYW1zIH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5cbmZ1bmN0aW9uIG1ha2VWYWxpZFNsaWNlUGFyYW1zKG92ZXJyaWRlczogUGFydGlhbDxDb21wbGV0ZVNsaWNlUGFyYW1zPiA9IHt9KTogQ29tcGxldGVTbGljZVBhcmFtcyB7XG4gIHJldHVybiB7XG4gICAgc2xpY2VJZDogXCJTMDFcIixcbiAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgc2xpY2VUaXRsZTogXCJUZXN0IFNsaWNlXCIsXG4gICAgb25lTGluZXI6IFwiSW1wbGVtZW50ZWQgdGVzdCBzbGljZVwiLFxuICAgIG5hcnJhdGl2ZTogXCJCdWlsdCBhbmQgdGVzdGVkLlwiLFxuICAgIHZlcmlmaWNhdGlvbjogXCJBbGwgdGVzdHMgcGFzcy5cIixcbiAgICBkZXZpYXRpb25zOiBcIk5vbmUuXCIsXG4gICAga25vd25MaW1pdGF0aW9uczogXCJOb25lLlwiLFxuICAgIGZvbGxvd1VwczogXCJOb25lLlwiLFxuICAgIGtleUZpbGVzOiBbXCJzcmMvZm9vLnRzXCJdLFxuICAgIGtleURlY2lzaW9uczogW10sXG4gICAgcGF0dGVybnNFc3RhYmxpc2hlZDogW10sXG4gICAgb2JzZXJ2YWJpbGl0eVN1cmZhY2VzOiBbXSxcbiAgICBwcm92aWRlczogW10sXG4gICAgcmVxdWlyZW1lbnRzU3VyZmFjZWQ6IFtdLFxuICAgIGRyaWxsRG93blBhdGhzOiBbXSxcbiAgICBhZmZlY3RzOiBbXSxcbiAgICByZXF1aXJlbWVudHNBZHZhbmNlZDogW10sXG4gICAgcmVxdWlyZW1lbnRzVmFsaWRhdGVkOiBbXSxcbiAgICByZXF1aXJlbWVudHNJbnZhbGlkYXRlZDogW10sXG4gICAgZmlsZXNNb2RpZmllZDogW10sXG4gICAgcmVxdWlyZXM6IFtdLFxuICAgIHVhdENvbnRlbnQ6IFwiIyMgU21va2UgVGVzdFxcblxcblZlcmlmeSBoYXBweSBwYXRoLlwiLFxuICAgIC4uLm92ZXJyaWRlcyxcbiAgfTtcbn1cblxuZGVzY3JpYmUoXCJjb21wbGV0ZS1zbGljZSBjbG9zZXMgY29tcGxldGUtc2xpY2Utb3duZWQgZ2F0ZXNcIiwgKCkgPT4ge1xuICBsZXQgZGJQYXRoOiBzdHJpbmc7XG4gIGxldCBiYXNlUGF0aDogc3RyaW5nO1xuXG4gIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgIGRiUGF0aCA9IHBhdGguam9pbihcbiAgICAgIGZzLm1rZHRlbXBTeW5jKHBhdGguam9pbihvcy50bXBkaXIoKSwgXCJnc2Qtc2xpY2UtZ2F0ZS1cIikpLFxuICAgICAgXCJ0ZXN0LmRiXCIsXG4gICAgKTtcbiAgICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcblxuICAgIGJhc2VQYXRoID0gZnMubWtkdGVtcFN5bmMocGF0aC5qb2luKG9zLnRtcGRpcigpLCBcImdzZC1zbGljZS1nYXRlLWhhbmRsZXItXCIpKTtcbiAgICBjb25zdCBzbGljZURpciA9IHBhdGguam9pbihcbiAgICAgIGJhc2VQYXRoLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMVwiLCBcInRhc2tzXCIsXG4gICAgKTtcbiAgICBmcy5ta2RpclN5bmMoc2xpY2VEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIGZzLndyaXRlRmlsZVN5bmMoXG4gICAgICBwYXRoLmpvaW4oYmFzZVBhdGgsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwiTTAwMS1ST0FETUFQLm1kXCIpLFxuICAgICAgW1xuICAgICAgICBcIiMgTTAwMTogVGVzdCBNaWxlc3RvbmVcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCIjIyBTbGljZXNcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgJy0gWyBdICoqUzAxOiBUZXN0IFNsaWNlKiogYHJpc2s6bWVkaXVtYCBgZGVwZW5kczpbXWAnLFxuICAgICAgICBcIiAgLSBBZnRlciB0aGlzOiBiYXNpYyBmdW5jdGlvbmFsaXR5IHdvcmtzXCIsXG4gICAgICBdLmpvaW4oXCJcXG5cIiksXG4gICAgKTtcblxuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiB9KTtcbiAgICBpbnNlcnRTbGljZSh7IGlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIgfSk7XG4gICAgaW5zZXJ0VGFzayh7XG4gICAgICBpZDogXCJUMDFcIiwgc2xpY2VJZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgc3RhdHVzOiBcImNvbXBsZXRlXCIsIHRpdGxlOiBcIlRhc2sgMVwiLFxuICAgIH0pO1xuXG4gICAgLy8gU2VlZCBROCBhcyBwZW5kaW5nIFx1MjAxNCB0aGlzIGlzIHdoYXQgcGxhbi1zbGljZSBkb2VzIHRvZGF5LlxuICAgIGluc2VydEdhdGVSb3coe1xuICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCBzbGljZUlkOiBcIlMwMVwiLFxuICAgICAgZ2F0ZUlkOiBcIlE4XCIsIHNjb3BlOiBcInNsaWNlXCIsXG4gICAgfSk7XG4gIH0pO1xuXG4gIGFmdGVyRWFjaCgoKSA9PiB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIGZzLnJtU3luYyhwYXRoLmRpcm5hbWUoZGJQYXRoKSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIGZzLnJtU3luYyhiYXNlUGF0aCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcblxuICB0ZXN0KFwiUTggY2xvc2VzIGFzICdwYXNzJyB3aGVuIG9wZXJhdGlvbmFsUmVhZGluZXNzIGlzIHBvcHVsYXRlZFwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgcGFyYW1zID0gbWFrZVZhbGlkU2xpY2VQYXJhbXMoe1xuICAgICAgb3BlcmF0aW9uYWxSZWFkaW5lc3M6IFtcbiAgICAgICAgXCItIEhlYWx0aCBzaWduYWw6IC9oZWFsdGggZW5kcG9pbnQgcmV0dXJucyAyMDBcIixcbiAgICAgICAgXCItIEZhaWx1cmUgc2lnbmFsOiBlcnJvciByYXRlIGFsZXJ0IGluIG9ic2VydmFiaWxpdHkgZGFzaGJvYXJkXCIsXG4gICAgICAgIFwiLSBSZWNvdmVyeTogc3lzdGVtZCBhdXRvLXJlc3RhcnRcIixcbiAgICAgIF0uam9pbihcIlxcblwiKSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZUNvbXBsZXRlU2xpY2UocGFyYW1zLCBiYXNlUGF0aCk7XG4gICAgYXNzZXJ0Lm9rKCEoXCJlcnJvclwiIGluIHJlc3VsdCksIGBoYW5kbGVyIGZhaWxlZDogJHsocmVzdWx0IGFzIGFueSkuZXJyb3J9YCk7XG5cbiAgICBjb25zdCBnYXRlcyA9IGdldEdhdGVSZXN1bHRzKFwiTTAwMVwiLCBcIlMwMVwiLCBcInNsaWNlXCIpO1xuICAgIGNvbnN0IHE4ID0gZ2F0ZXMuZmluZCgoZykgPT4gZy5nYXRlX2lkID09PSBcIlE4XCIpO1xuICAgIGFzc2VydC5vayhxOCwgXCJROCByb3cgbXVzdCBleGlzdCBhZnRlciBjb21wbGV0ZS1zbGljZVwiKTtcbiAgICBhc3NlcnQuZXF1YWwocTguc3RhdHVzLCBcImNvbXBsZXRlXCIpO1xuICAgIGFzc2VydC5lcXVhbChxOC52ZXJkaWN0LCBcInBhc3NcIik7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgcTguZmluZGluZ3MuaW5jbHVkZXMoXCJIZWFsdGggc2lnbmFsXCIpLFxuICAgICAgXCJROCBmaW5kaW5ncyBtdXN0IGNhcHR1cmUgdGhlIG9wZXJhdGlvbmFsUmVhZGluZXNzIGNvbnRlbnRcIixcbiAgICApO1xuICB9KTtcblxuICB0ZXN0KFwiUTggY2xvc2VzIGFzICdvbWl0dGVkJyB3aGVuIG9wZXJhdGlvbmFsUmVhZGluZXNzIGlzIGVtcHR5XCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBwYXJhbXMgPSBtYWtlVmFsaWRTbGljZVBhcmFtcyh7IG9wZXJhdGlvbmFsUmVhZGluZXNzOiBcIlwiIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlQ29tcGxldGVTbGljZShwYXJhbXMsIGJhc2VQYXRoKTtcbiAgICBhc3NlcnQub2soIShcImVycm9yXCIgaW4gcmVzdWx0KSwgYGhhbmRsZXIgZmFpbGVkOiAkeyhyZXN1bHQgYXMgYW55KS5lcnJvcn1gKTtcblxuICAgIGNvbnN0IGdhdGVzID0gZ2V0R2F0ZVJlc3VsdHMoXCJNMDAxXCIsIFwiUzAxXCIsIFwic2xpY2VcIik7XG4gICAgY29uc3QgcTggPSBnYXRlcy5maW5kKChnKSA9PiBnLmdhdGVfaWQgPT09IFwiUThcIik7XG4gICAgYXNzZXJ0Lm9rKHE4LCBcIlE4IHJvdyBtdXN0IGV4aXN0IGFmdGVyIGNvbXBsZXRlLXNsaWNlXCIpO1xuICAgIGFzc2VydC5lcXVhbChxOC5zdGF0dXMsIFwiY29tcGxldGVcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHE4LnZlcmRpY3QsIFwib21pdHRlZFwiKTtcbiAgfSk7XG5cbiAgdGVzdChcIlE4IGFsc28gY2xvc2VzIHdoZW4gb3BlcmF0aW9uYWxSZWFkaW5lc3MgaXMgb21pdHRlZCBlbnRpcmVseVwiLCBhc3luYyAoKSA9PiB7XG4gICAgLy8gQSBtb2RlbCB0aGF0IGRvZXNuJ3QgcGFzcyBvcGVyYXRpb25hbFJlYWRpbmVzcyBhdCBhbGwgbXVzdCBzdGlsbFxuICAgIC8vIG1vdmUgUTggb3V0IG9mICdwZW5kaW5nJyBcdTIwMTQgbGVhdmluZyBpdCBwZW5kaW5nIHByb2R1Y2VzIHRoZSBzdGFsbC5cbiAgICBjb25zdCBwYXJhbXMgPSBtYWtlVmFsaWRTbGljZVBhcmFtcygpO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZUNvbXBsZXRlU2xpY2UocGFyYW1zLCBiYXNlUGF0aCk7XG4gICAgYXNzZXJ0Lm9rKCEoXCJlcnJvclwiIGluIHJlc3VsdCksIGBoYW5kbGVyIGZhaWxlZDogJHsocmVzdWx0IGFzIGFueSkuZXJyb3J9YCk7XG5cbiAgICBjb25zdCBnYXRlcyA9IGdldEdhdGVSZXN1bHRzKFwiTTAwMVwiLCBcIlMwMVwiLCBcInNsaWNlXCIpO1xuICAgIGNvbnN0IHE4ID0gZ2F0ZXMuZmluZCgoZykgPT4gZy5nYXRlX2lkID09PSBcIlE4XCIpO1xuICAgIGFzc2VydC5vayhxOCk7XG4gICAgYXNzZXJ0Lm5vdEVxdWFsKHE4LnN0YXR1cywgXCJwZW5kaW5nXCIsIFwiUTggbXVzdCBuZXZlciByZW1haW4gcGVuZGluZyBhZnRlciBjb21wbGV0ZS1zbGljZVwiKTtcbiAgICBhc3NlcnQuZXF1YWwocTgudmVyZGljdCwgXCJvbWl0dGVkXCIpO1xuICB9KTtcblxuICB0ZXN0KFwic3VtbWFyeSBtYXJrZG93biBjb250YWlucyBPcGVyYXRpb25hbCBSZWFkaW5lc3Mgc2VjdGlvblwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgcGFyYW1zID0gbWFrZVZhbGlkU2xpY2VQYXJhbXMoe1xuICAgICAgb3BlcmF0aW9uYWxSZWFkaW5lc3M6IFwiLSBIZWFsdGggc2lnbmFsOiAvaGVhbHRoXFxuLSBGYWlsdXJlIHNpZ25hbDogYWxlcnRcIixcbiAgICB9KTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVDb21wbGV0ZVNsaWNlKHBhcmFtcywgYmFzZVBhdGgpO1xuICAgIGFzc2VydC5vayghKFwiZXJyb3JcIiBpbiByZXN1bHQpKTtcbiAgICBpZiAoIShcImVycm9yXCIgaW4gcmVzdWx0KSkge1xuICAgICAgY29uc3Qgc3VtbWFyeSA9IGZzLnJlYWRGaWxlU3luYyhyZXN1bHQuc3VtbWFyeVBhdGgsIFwidXRmLThcIik7XG4gICAgICBhc3NlcnQubWF0Y2goc3VtbWFyeSwgL14jIyBPcGVyYXRpb25hbCBSZWFkaW5lc3MvbSk7XG4gICAgICBhc3NlcnQubWF0Y2goc3VtbWFyeSwgL0hlYWx0aCBzaWduYWw6IFxcL2hlYWx0aC8pO1xuICAgIH1cbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQVNBLFNBQVMsVUFBVSxNQUFNLFlBQVksaUJBQWlCO0FBQ3RELE9BQU8sWUFBWTtBQUNuQixZ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
