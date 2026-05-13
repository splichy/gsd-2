import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DISPATCH_RULES } from "../auto-dispatch.js";
import { closeDatabase, insertMilestone, openDatabase } from "../gsd-db.js";
function makeBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-complete-dispatch-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
  writeFileSync(join(base, ".gsd", "milestones", "M001", "ROADMAP.md"), "# M001\n\n## Slices\n\n- [x] **S01**: Done\n");
  writeFileSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "SUMMARY.md"), "# Summary\n");
  writeFileSync(join(base, "implementation.txt"), "done\n");
  return base;
}
function buildDispatchCtx(basePath) {
  return {
    basePath,
    mid: "M001",
    midTitle: "Milestone One",
    state: {
      activeMilestone: { id: "M001", title: "Milestone One" },
      activeSlice: null,
      activeTask: null,
      phase: "completing-milestone",
      recentDecisions: [],
      blockers: [],
      nextAction: "",
      registry: [{ id: "M001", title: "Milestone One", status: "active" }],
      requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
      progress: { milestones: { done: 0, total: 1 } }
    },
    prefs: void 0
  };
}
describe("completing-milestone dispatch guard (#4324)", () => {
  let base = "";
  const rule = DISPATCH_RULES.find((candidate) => candidate.name === "completing-milestone \u2192 complete-milestone");
  assert.ok(rule, "complete-milestone dispatch rule should exist");
  afterEach(() => {
    try {
      closeDatabase();
    } catch {
    }
    if (base) rmSync(base, { recursive: true, force: true });
    base = "";
  });
  test("skips complete-milestone dispatch when the DB milestone is already closed", async () => {
    base = makeBase();
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone One", status: "complete" });
    const result = await rule.match(buildDispatchCtx(base));
    assert.equal(result?.action, "skip");
  });
  test("dispatches complete-milestone when the DB milestone is still active", async () => {
    base = makeBase();
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone One", status: "active" });
    const result = await rule.match(buildDispatchCtx(base));
    assert.equal(result?.action, "dispatch");
    assert.equal(result?.unitType, "complete-milestone");
    assert.equal(result?.unitId, "M001");
  });
});
describe("complete phase dispatch guard (#5683)", () => {
  let base = "";
  const rule = DISPATCH_RULES.find((candidate) => candidate.name === "complete \u2192 stop");
  assert.ok(rule, "complete phase terminal rule should exist");
  afterEach(() => {
    try {
      closeDatabase();
    } catch {
    }
    if (base) rmSync(base, { recursive: true, force: true });
    base = "";
  });
  test("dispatches complete-milestone when derived state is complete but DB milestone is still open", async () => {
    base = makeBase();
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone One", status: "in_progress" });
    const ctx = buildDispatchCtx(base);
    ctx.state.phase = "complete";
    const result = await rule.match(ctx);
    assert.equal(result?.action, "dispatch");
    assert.equal(result?.unitType, "complete-milestone");
    assert.equal(result?.unitId, "M001");
  });
  test("stops when derived state is complete and DB milestone is closed", async () => {
    base = makeBase();
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone One", status: "complete" });
    const ctx = buildDispatchCtx(base);
    ctx.state.phase = "complete";
    const result = await rule.match(ctx);
    assert.equal(result?.action, "stop");
    assert.equal(result?.reason, "All milestones complete.");
  });
});
describe("complete milestone context recovery guard (#5831)", () => {
  let base = "";
  const executionEntryRule = DISPATCH_RULES.find(
    (candidate) => candidate.name === "execution-entry phase (no context) \u2192 discuss-milestone"
  );
  const prePlanningRule = DISPATCH_RULES.find(
    (candidate) => candidate.name === "pre-planning (no context) \u2192 discuss-milestone"
  );
  assert.ok(executionEntryRule, "execution-entry missing-context rule should exist");
  assert.ok(prePlanningRule, "pre-planning missing-context rule should exist");
  afterEach(() => {
    if (base) rmSync(base, { recursive: true, force: true });
    base = "";
  });
  test("does not discuss a complete execution-entry milestone with no CONTEXT file", async () => {
    base = makeBase();
    const ctx = buildDispatchCtx(base);
    ctx.state.registry = [{ id: "M001", title: "Milestone One", status: "complete" }];
    ctx.state.phase = "completing-milestone";
    const result = await executionEntryRule.match(ctx);
    assert.equal(result, null);
  });
  test("does not discuss a complete pre-planning milestone with no CONTEXT file", async () => {
    base = makeBase();
    const ctx = buildDispatchCtx(base);
    ctx.state.registry = [{ id: "M001", title: "Milestone One", status: "complete" }];
    ctx.state.phase = "pre-planning";
    const result = await prePlanningRule.match(ctx);
    assert.equal(result, null);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9kaXNwYXRjaC1jb21wbGV0ZS1taWxlc3RvbmUtZ3VhcmQudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IFJlZ3Jlc3Npb24gdGVzdHMgZm9yIGNvbXBsZXRlLW1pbGVzdG9uZSBkaXNwYXRjaCBndWFyZHMuXG5cbi8qKlxuICogZGlzcGF0Y2gtY29tcGxldGUtbWlsZXN0b25lLWd1YXJkLnRlc3QudHMgXHUyMDE0ICM0MzI0XG4gKi9cblxuaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QsIGFmdGVyRWFjaCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuXG5pbXBvcnQgeyBESVNQQVRDSF9SVUxFUywgdHlwZSBEaXNwYXRjaENvbnRleHQgfSBmcm9tIFwiLi4vYXV0by1kaXNwYXRjaC50c1wiO1xuaW1wb3J0IHsgY2xvc2VEYXRhYmFzZSwgaW5zZXJ0TWlsZXN0b25lLCBvcGVuRGF0YWJhc2UgfSBmcm9tIFwiLi4vZ3NkLWRiLnRzXCI7XG5cbmZ1bmN0aW9uIG1ha2VCYXNlKCk6IHN0cmluZyB7XG4gIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1jb21wbGV0ZS1kaXNwYXRjaC1cIikpO1xuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcIlJPQURNQVAubWRcIiksIFwiIyBNMDAxXFxuXFxuIyMgU2xpY2VzXFxuXFxuLSBbeF0gKipTMDEqKjogRG9uZVxcblwiKTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIsIFwiU1VNTUFSWS5tZFwiKSwgXCIjIFN1bW1hcnlcXG5cIik7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcImltcGxlbWVudGF0aW9uLnR4dFwiKSwgXCJkb25lXFxuXCIpO1xuICByZXR1cm4gYmFzZTtcbn1cblxuZnVuY3Rpb24gYnVpbGREaXNwYXRjaEN0eChiYXNlUGF0aDogc3RyaW5nKTogRGlzcGF0Y2hDb250ZXh0IHtcbiAgcmV0dXJuIHtcbiAgICBiYXNlUGF0aCxcbiAgICBtaWQ6IFwiTTAwMVwiLFxuICAgIG1pZFRpdGxlOiBcIk1pbGVzdG9uZSBPbmVcIixcbiAgICBzdGF0ZToge1xuICAgICAgYWN0aXZlTWlsZXN0b25lOiB7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiTWlsZXN0b25lIE9uZVwiIH0sXG4gICAgICBhY3RpdmVTbGljZTogbnVsbCxcbiAgICAgIGFjdGl2ZVRhc2s6IG51bGwsXG4gICAgICBwaGFzZTogXCJjb21wbGV0aW5nLW1pbGVzdG9uZVwiLFxuICAgICAgcmVjZW50RGVjaXNpb25zOiBbXSxcbiAgICAgIGJsb2NrZXJzOiBbXSxcbiAgICAgIG5leHRBY3Rpb246IFwiXCIsXG4gICAgICByZWdpc3RyeTogW3sgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJNaWxlc3RvbmUgT25lXCIsIHN0YXR1czogXCJhY3RpdmVcIiB9XSxcbiAgICAgIHJlcXVpcmVtZW50czogeyBhY3RpdmU6IDAsIHZhbGlkYXRlZDogMCwgZGVmZXJyZWQ6IDAsIG91dE9mU2NvcGU6IDAsIGJsb2NrZWQ6IDAsIHRvdGFsOiAwIH0sXG4gICAgICBwcm9ncmVzczogeyBtaWxlc3RvbmVzOiB7IGRvbmU6IDAsIHRvdGFsOiAxIH0gfSxcbiAgICB9LFxuICAgIHByZWZzOiB1bmRlZmluZWQsXG4gIH07XG59XG5cbmRlc2NyaWJlKFwiY29tcGxldGluZy1taWxlc3RvbmUgZGlzcGF0Y2ggZ3VhcmQgKCM0MzI0KVwiLCAoKSA9PiB7XG4gIGxldCBiYXNlID0gXCJcIjtcbiAgY29uc3QgcnVsZSA9IERJU1BBVENIX1JVTEVTLmZpbmQoKGNhbmRpZGF0ZSkgPT4gY2FuZGlkYXRlLm5hbWUgPT09IFwiY29tcGxldGluZy1taWxlc3RvbmUgXHUyMTkyIGNvbXBsZXRlLW1pbGVzdG9uZVwiKTtcbiAgYXNzZXJ0Lm9rKHJ1bGUsIFwiY29tcGxldGUtbWlsZXN0b25lIGRpc3BhdGNoIHJ1bGUgc2hvdWxkIGV4aXN0XCIpO1xuXG4gIGFmdGVyRWFjaCgoKSA9PiB7XG4gICAgdHJ5IHsgY2xvc2VEYXRhYmFzZSgpOyB9IGNhdGNoIHsgLyogaWdub3JlICovIH1cbiAgICBpZiAoYmFzZSkgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICBiYXNlID0gXCJcIjtcbiAgfSk7XG5cbiAgdGVzdChcInNraXBzIGNvbXBsZXRlLW1pbGVzdG9uZSBkaXNwYXRjaCB3aGVuIHRoZSBEQiBtaWxlc3RvbmUgaXMgYWxyZWFkeSBjbG9zZWRcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGJhc2UgPSBtYWtlQmFzZSgpO1xuICAgIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsIFwiLmdzZFwiLCBcImdzZC5kYlwiKSk7XG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJNaWxlc3RvbmUgT25lXCIsIHN0YXR1czogXCJjb21wbGV0ZVwiIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVsZS5tYXRjaChidWlsZERpc3BhdGNoQ3R4KGJhc2UpKTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQ/LmFjdGlvbiwgXCJza2lwXCIpO1xuICB9KTtcblxuICB0ZXN0KFwiZGlzcGF0Y2hlcyBjb21wbGV0ZS1taWxlc3RvbmUgd2hlbiB0aGUgREIgbWlsZXN0b25lIGlzIHN0aWxsIGFjdGl2ZVwiLCBhc3luYyAoKSA9PiB7XG4gICAgYmFzZSA9IG1ha2VCYXNlKCk7XG4gICAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiZ3NkLmRiXCIpKTtcbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIk1pbGVzdG9uZSBPbmVcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVsZS5tYXRjaChidWlsZERpc3BhdGNoQ3R4KGJhc2UpKTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQ/LmFjdGlvbiwgXCJkaXNwYXRjaFwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Py51bml0VHlwZSwgXCJjb21wbGV0ZS1taWxlc3RvbmVcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdD8udW5pdElkLCBcIk0wMDFcIik7XG4gIH0pO1xufSk7XG5cbmRlc2NyaWJlKFwiY29tcGxldGUgcGhhc2UgZGlzcGF0Y2ggZ3VhcmQgKCM1NjgzKVwiLCAoKSA9PiB7XG4gIGxldCBiYXNlID0gXCJcIjtcbiAgY29uc3QgcnVsZSA9IERJU1BBVENIX1JVTEVTLmZpbmQoKGNhbmRpZGF0ZSkgPT4gY2FuZGlkYXRlLm5hbWUgPT09IFwiY29tcGxldGUgXHUyMTkyIHN0b3BcIik7XG4gIGFzc2VydC5vayhydWxlLCBcImNvbXBsZXRlIHBoYXNlIHRlcm1pbmFsIHJ1bGUgc2hvdWxkIGV4aXN0XCIpO1xuXG4gIGFmdGVyRWFjaCgoKSA9PiB7XG4gICAgdHJ5IHsgY2xvc2VEYXRhYmFzZSgpOyB9IGNhdGNoIHsgLyogaWdub3JlICovIH1cbiAgICBpZiAoYmFzZSkgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICBiYXNlID0gXCJcIjtcbiAgfSk7XG5cbiAgdGVzdChcImRpc3BhdGNoZXMgY29tcGxldGUtbWlsZXN0b25lIHdoZW4gZGVyaXZlZCBzdGF0ZSBpcyBjb21wbGV0ZSBidXQgREIgbWlsZXN0b25lIGlzIHN0aWxsIG9wZW5cIiwgYXN5bmMgKCkgPT4ge1xuICAgIGJhc2UgPSBtYWtlQmFzZSgpO1xuICAgIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsIFwiLmdzZFwiLCBcImdzZC5kYlwiKSk7XG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJNaWxlc3RvbmUgT25lXCIsIHN0YXR1czogXCJpbl9wcm9ncmVzc1wiIH0pO1xuXG4gICAgY29uc3QgY3R4ID0gYnVpbGREaXNwYXRjaEN0eChiYXNlKTtcbiAgICBjdHguc3RhdGUucGhhc2UgPSBcImNvbXBsZXRlXCI7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBydWxlLm1hdGNoKGN0eCk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Py5hY3Rpb24sIFwiZGlzcGF0Y2hcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdD8udW5pdFR5cGUsIFwiY29tcGxldGUtbWlsZXN0b25lXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQ/LnVuaXRJZCwgXCJNMDAxXCIpO1xuICB9KTtcblxuICB0ZXN0KFwic3RvcHMgd2hlbiBkZXJpdmVkIHN0YXRlIGlzIGNvbXBsZXRlIGFuZCBEQiBtaWxlc3RvbmUgaXMgY2xvc2VkXCIsIGFzeW5jICgpID0+IHtcbiAgICBiYXNlID0gbWFrZUJhc2UoKTtcbiAgICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJnc2QuZGJcIikpO1xuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiTWlsZXN0b25lIE9uZVwiLCBzdGF0dXM6IFwiY29tcGxldGVcIiB9KTtcblxuICAgIGNvbnN0IGN0eCA9IGJ1aWxkRGlzcGF0Y2hDdHgoYmFzZSk7XG4gICAgY3R4LnN0YXRlLnBoYXNlID0gXCJjb21wbGV0ZVwiO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVsZS5tYXRjaChjdHgpO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdD8uYWN0aW9uLCBcInN0b3BcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdD8ucmVhc29uLCBcIkFsbCBtaWxlc3RvbmVzIGNvbXBsZXRlLlwiKTtcbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoXCJjb21wbGV0ZSBtaWxlc3RvbmUgY29udGV4dCByZWNvdmVyeSBndWFyZCAoIzU4MzEpXCIsICgpID0+IHtcbiAgbGV0IGJhc2UgPSBcIlwiO1xuICBjb25zdCBleGVjdXRpb25FbnRyeVJ1bGUgPSBESVNQQVRDSF9SVUxFUy5maW5kKFxuICAgIChjYW5kaWRhdGUpID0+IGNhbmRpZGF0ZS5uYW1lID09PSBcImV4ZWN1dGlvbi1lbnRyeSBwaGFzZSAobm8gY29udGV4dCkgXHUyMTkyIGRpc2N1c3MtbWlsZXN0b25lXCIsXG4gICk7XG4gIGNvbnN0IHByZVBsYW5uaW5nUnVsZSA9IERJU1BBVENIX1JVTEVTLmZpbmQoXG4gICAgKGNhbmRpZGF0ZSkgPT4gY2FuZGlkYXRlLm5hbWUgPT09IFwicHJlLXBsYW5uaW5nIChubyBjb250ZXh0KSBcdTIxOTIgZGlzY3Vzcy1taWxlc3RvbmVcIixcbiAgKTtcbiAgYXNzZXJ0Lm9rKGV4ZWN1dGlvbkVudHJ5UnVsZSwgXCJleGVjdXRpb24tZW50cnkgbWlzc2luZy1jb250ZXh0IHJ1bGUgc2hvdWxkIGV4aXN0XCIpO1xuICBhc3NlcnQub2socHJlUGxhbm5pbmdSdWxlLCBcInByZS1wbGFubmluZyBtaXNzaW5nLWNvbnRleHQgcnVsZSBzaG91bGQgZXhpc3RcIik7XG5cbiAgYWZ0ZXJFYWNoKCgpID0+IHtcbiAgICBpZiAoYmFzZSkgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICBiYXNlID0gXCJcIjtcbiAgfSk7XG5cbiAgdGVzdChcImRvZXMgbm90IGRpc2N1c3MgYSBjb21wbGV0ZSBleGVjdXRpb24tZW50cnkgbWlsZXN0b25lIHdpdGggbm8gQ09OVEVYVCBmaWxlXCIsIGFzeW5jICgpID0+IHtcbiAgICBiYXNlID0gbWFrZUJhc2UoKTtcbiAgICBjb25zdCBjdHggPSBidWlsZERpc3BhdGNoQ3R4KGJhc2UpO1xuICAgIGN0eC5zdGF0ZS5yZWdpc3RyeSA9IFt7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiTWlsZXN0b25lIE9uZVwiLCBzdGF0dXM6IFwiY29tcGxldGVcIiB9XTtcbiAgICBjdHguc3RhdGUucGhhc2UgPSBcImNvbXBsZXRpbmctbWlsZXN0b25lXCI7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBleGVjdXRpb25FbnRyeVJ1bGUubWF0Y2goY3R4KTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIG51bGwpO1xuICB9KTtcblxuICB0ZXN0KFwiZG9lcyBub3QgZGlzY3VzcyBhIGNvbXBsZXRlIHByZS1wbGFubmluZyBtaWxlc3RvbmUgd2l0aCBubyBDT05URVhUIGZpbGVcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGJhc2UgPSBtYWtlQmFzZSgpO1xuICAgIGNvbnN0IGN0eCA9IGJ1aWxkRGlzcGF0Y2hDdHgoYmFzZSk7XG4gICAgY3R4LnN0YXRlLnJlZ2lzdHJ5ID0gW3sgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJNaWxlc3RvbmUgT25lXCIsIHN0YXR1czogXCJjb21wbGV0ZVwiIH1dO1xuICAgIGN0eC5zdGF0ZS5waGFzZSA9IFwicHJlLXBsYW5uaW5nXCI7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBwcmVQbGFubmluZ1J1bGUubWF0Y2goY3R4KTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIG51bGwpO1xuICB9KTtcbn0pO1xuIl0sCiAgIm1h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
