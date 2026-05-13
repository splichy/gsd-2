import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DISPATCH_RULES } from "../auto-dispatch.js";
import {
  closeDatabase,
  insertMilestone,
  insertSlice,
  openDatabase,
  upsertMilestonePlanning
} from "../gsd-db.js";
import { invalidateAllCaches } from "../cache.js";
const COMPLETE_RULE = "completing-milestone \u2192 complete-milestone";
function makeBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-skipped-validation-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  writeFileSync(join(base, "app.js"), "export const shipped = true;\n");
  return base;
}
function cleanup(base) {
  try {
    closeDatabase();
  } catch {
  }
  invalidateAllCaches();
  rmSync(base, { recursive: true, force: true });
}
function seedMilestone(base) {
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({
    id: "M001",
    title: "Preference-skipped validation milestone",
    status: "active",
    depends_on: []
  });
  upsertMilestonePlanning("M001", {
    title: "Preference-skipped validation milestone",
    status: "active",
    vision: "Ship a small implementation with a documented validation skip.",
    successCriteria: ["Completion remains unblocked when validation was intentionally skipped."],
    keyRisks: [],
    proofStrategy: [],
    verificationContract: "",
    verificationIntegration: "",
    verificationOperational: "Smoke-test the shipped workflow before completion.",
    verificationUat: "",
    definitionOfDone: [],
    requirementCoverage: "",
    boundaryMapMarkdown: ""
  });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "First",
    status: "done",
    risk: "low",
    depends: [],
    demo: "",
    sequence: 1
  });
}
function writeFixtureFiles(base) {
  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  writeFileSync(
    join(milestoneDir, "M001-ROADMAP.md"),
    [
      "# M001",
      "## Slices",
      "- [x] **S01: First** `risk:low` `depends:[]`"
    ].join("\n")
  );
  writeFileSync(
    join(milestoneDir, "slices", "S01", "S01-SUMMARY.md"),
    "# S01\n\nImplemented the shipped workflow.\n"
  );
  writeFileSync(
    join(milestoneDir, "M001-VALIDATION.md"),
    [
      "---",
      "verdict: pass",
      "skip_validation: true",
      "skip_validation_reason: preference",
      "remediation_round: 0",
      "---",
      "",
      "# Milestone Validation (skipped)",
      "",
      "Milestone validation was skipped by preference."
    ].join("\n")
  );
}
function findRule(name) {
  const rule = DISPATCH_RULES.find((candidate) => candidate.name === name);
  assert.ok(rule, `rule "${name}" must exist`);
  return rule;
}
function makeCtx(base) {
  const state = {
    phase: "completing-milestone",
    activeMilestone: { id: "M001", title: "Preference-skipped validation milestone" },
    activeSlice: null,
    activeTask: null,
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: [{ id: "M001", title: "Preference-skipped validation milestone", status: "active" }]
  };
  return {
    basePath: base,
    mid: "M001",
    midTitle: "Preference-skipped validation milestone",
    state,
    prefs: void 0
  };
}
test("#3698: completing-milestone dispatch accepts skipped validation fixture", async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedMilestone(base);
  writeFixtureFiles(base);
  const result = await findRule(COMPLETE_RULE).match(makeCtx(base));
  assert.ok(result, "rule must return a result");
  assert.strictEqual(result.action, "dispatch", "skipped validation should still allow completion dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "complete-milestone");
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9za2lwcGVkLXZhbGlkYXRpb24tY29tcGxldGlvbi50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFJlZ3Jlc3Npb24gdGVzdCBmb3IgIzM2OTggXHUyMDE0IGFsbG93IG1pbGVzdG9uZSBjb21wbGV0aW9uIHdoZW4gdmFsaWRhdGlvblxuICogd2FzIHNraXBwZWQgYnkgcHJlZmVyZW5jZS5cbiAqL1xuXG5pbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBta2RpclN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcblxuaW1wb3J0IHsgRElTUEFUQ0hfUlVMRVMsIHR5cGUgRGlzcGF0Y2hDb250ZXh0IH0gZnJvbSBcIi4uL2F1dG8tZGlzcGF0Y2gudHNcIjtcbmltcG9ydCB7XG4gIGNsb3NlRGF0YWJhc2UsXG4gIGluc2VydE1pbGVzdG9uZSxcbiAgaW5zZXJ0U2xpY2UsXG4gIG9wZW5EYXRhYmFzZSxcbiAgdXBzZXJ0TWlsZXN0b25lUGxhbm5pbmcsXG59IGZyb20gXCIuLi9nc2QtZGIudHNcIjtcbmltcG9ydCB7IGludmFsaWRhdGVBbGxDYWNoZXMgfSBmcm9tIFwiLi4vY2FjaGUudHNcIjtcbmltcG9ydCB0eXBlIHsgR1NEU3RhdGUgfSBmcm9tIFwiLi4vdHlwZXMudHNcIjtcblxuY29uc3QgQ09NUExFVEVfUlVMRSA9IFwiY29tcGxldGluZy1taWxlc3RvbmUgXHUyMTkyIGNvbXBsZXRlLW1pbGVzdG9uZVwiO1xuXG5mdW5jdGlvbiBtYWtlQmFzZSgpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2Qtc2tpcHBlZC12YWxpZGF0aW9uLVwiKSk7XG4gIG1rZGlyU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIsIFwidGFza3NcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCJhcHAuanNcIiksIFwiZXhwb3J0IGNvbnN0IHNoaXBwZWQgPSB0cnVlO1xcblwiKTtcbiAgcmV0dXJuIGJhc2U7XG59XG5cbmZ1bmN0aW9uIGNsZWFudXAoYmFzZTogc3RyaW5nKTogdm9pZCB7XG4gIHRyeSB7IGNsb3NlRGF0YWJhc2UoKTsgfSBjYXRjaCB7IC8qIG5vb3AgKi8gfVxuICBpbnZhbGlkYXRlQWxsQ2FjaGVzKCk7XG4gIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG59XG5cbmZ1bmN0aW9uIHNlZWRNaWxlc3RvbmUoYmFzZTogc3RyaW5nKTogdm9pZCB7XG4gIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsIFwiLmdzZFwiLCBcImdzZC5kYlwiKSk7XG4gIGluc2VydE1pbGVzdG9uZSh7XG4gICAgaWQ6IFwiTTAwMVwiLFxuICAgIHRpdGxlOiBcIlByZWZlcmVuY2Utc2tpcHBlZCB2YWxpZGF0aW9uIG1pbGVzdG9uZVwiLFxuICAgIHN0YXR1czogXCJhY3RpdmVcIixcbiAgICBkZXBlbmRzX29uOiBbXSxcbiAgfSk7XG4gIHVwc2VydE1pbGVzdG9uZVBsYW5uaW5nKFwiTTAwMVwiLCB7XG4gICAgdGl0bGU6IFwiUHJlZmVyZW5jZS1za2lwcGVkIHZhbGlkYXRpb24gbWlsZXN0b25lXCIsXG4gICAgc3RhdHVzOiBcImFjdGl2ZVwiLFxuICAgIHZpc2lvbjogXCJTaGlwIGEgc21hbGwgaW1wbGVtZW50YXRpb24gd2l0aCBhIGRvY3VtZW50ZWQgdmFsaWRhdGlvbiBza2lwLlwiLFxuICAgIHN1Y2Nlc3NDcml0ZXJpYTogW1wiQ29tcGxldGlvbiByZW1haW5zIHVuYmxvY2tlZCB3aGVuIHZhbGlkYXRpb24gd2FzIGludGVudGlvbmFsbHkgc2tpcHBlZC5cIl0sXG4gICAga2V5Umlza3M6IFtdLFxuICAgIHByb29mU3RyYXRlZ3k6IFtdLFxuICAgIHZlcmlmaWNhdGlvbkNvbnRyYWN0OiBcIlwiLFxuICAgIHZlcmlmaWNhdGlvbkludGVncmF0aW9uOiBcIlwiLFxuICAgIHZlcmlmaWNhdGlvbk9wZXJhdGlvbmFsOiBcIlNtb2tlLXRlc3QgdGhlIHNoaXBwZWQgd29ya2Zsb3cgYmVmb3JlIGNvbXBsZXRpb24uXCIsXG4gICAgdmVyaWZpY2F0aW9uVWF0OiBcIlwiLFxuICAgIGRlZmluaXRpb25PZkRvbmU6IFtdLFxuICAgIHJlcXVpcmVtZW50Q292ZXJhZ2U6IFwiXCIsXG4gICAgYm91bmRhcnlNYXBNYXJrZG93bjogXCJcIixcbiAgfSk7XG4gIGluc2VydFNsaWNlKHtcbiAgICBpZDogXCJTMDFcIixcbiAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgdGl0bGU6IFwiRmlyc3RcIixcbiAgICBzdGF0dXM6IFwiZG9uZVwiLFxuICAgIHJpc2s6IFwibG93XCIsXG4gICAgZGVwZW5kczogW10sXG4gICAgZGVtbzogXCJcIixcbiAgICBzZXF1ZW5jZTogMSxcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHdyaXRlRml4dHVyZUZpbGVzKGJhc2U6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBtaWxlc3RvbmVEaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIpO1xuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4obWlsZXN0b25lRGlyLCBcIk0wMDEtUk9BRE1BUC5tZFwiKSxcbiAgICBbXG4gICAgICBcIiMgTTAwMVwiLFxuICAgICAgXCIjIyBTbGljZXNcIixcbiAgICAgIFwiLSBbeF0gKipTMDE6IEZpcnN0KiogYHJpc2s6bG93YCBgZGVwZW5kczpbXWBcIixcbiAgICBdLmpvaW4oXCJcXG5cIiksXG4gICk7XG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbihtaWxlc3RvbmVEaXIsIFwic2xpY2VzXCIsIFwiUzAxXCIsIFwiUzAxLVNVTU1BUlkubWRcIiksXG4gICAgXCIjIFMwMVxcblxcbkltcGxlbWVudGVkIHRoZSBzaGlwcGVkIHdvcmtmbG93LlxcblwiLFxuICApO1xuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4obWlsZXN0b25lRGlyLCBcIk0wMDEtVkFMSURBVElPTi5tZFwiKSxcbiAgICBbXG4gICAgICBcIi0tLVwiLFxuICAgICAgXCJ2ZXJkaWN0OiBwYXNzXCIsXG4gICAgICBcInNraXBfdmFsaWRhdGlvbjogdHJ1ZVwiLFxuICAgICAgXCJza2lwX3ZhbGlkYXRpb25fcmVhc29uOiBwcmVmZXJlbmNlXCIsXG4gICAgICBcInJlbWVkaWF0aW9uX3JvdW5kOiAwXCIsXG4gICAgICBcIi0tLVwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyBNaWxlc3RvbmUgVmFsaWRhdGlvbiAoc2tpcHBlZClcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIk1pbGVzdG9uZSB2YWxpZGF0aW9uIHdhcyBza2lwcGVkIGJ5IHByZWZlcmVuY2UuXCIsXG4gICAgXS5qb2luKFwiXFxuXCIpLFxuICApO1xufVxuXG5mdW5jdGlvbiBmaW5kUnVsZShuYW1lOiBzdHJpbmcpIHtcbiAgY29uc3QgcnVsZSA9IERJU1BBVENIX1JVTEVTLmZpbmQoY2FuZGlkYXRlID0+IGNhbmRpZGF0ZS5uYW1lID09PSBuYW1lKTtcbiAgYXNzZXJ0Lm9rKHJ1bGUsIGBydWxlIFwiJHtuYW1lfVwiIG11c3QgZXhpc3RgKTtcbiAgcmV0dXJuIHJ1bGUhO1xufVxuXG5mdW5jdGlvbiBtYWtlQ3R4KGJhc2U6IHN0cmluZyk6IERpc3BhdGNoQ29udGV4dCB7XG4gIGNvbnN0IHN0YXRlOiBHU0RTdGF0ZSA9IHtcbiAgICBwaGFzZTogXCJjb21wbGV0aW5nLW1pbGVzdG9uZVwiLFxuICAgIGFjdGl2ZU1pbGVzdG9uZTogeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlByZWZlcmVuY2Utc2tpcHBlZCB2YWxpZGF0aW9uIG1pbGVzdG9uZVwiIH0sXG4gICAgYWN0aXZlU2xpY2U6IG51bGwsXG4gICAgYWN0aXZlVGFzazogbnVsbCxcbiAgICByZWNlbnREZWNpc2lvbnM6IFtdLFxuICAgIGJsb2NrZXJzOiBbXSxcbiAgICBuZXh0QWN0aW9uOiBcIlwiLFxuICAgIHJlZ2lzdHJ5OiBbeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlByZWZlcmVuY2Utc2tpcHBlZCB2YWxpZGF0aW9uIG1pbGVzdG9uZVwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfV0sXG4gIH07XG4gIHJldHVybiB7XG4gICAgYmFzZVBhdGg6IGJhc2UsXG4gICAgbWlkOiBcIk0wMDFcIixcbiAgICBtaWRUaXRsZTogXCJQcmVmZXJlbmNlLXNraXBwZWQgdmFsaWRhdGlvbiBtaWxlc3RvbmVcIixcbiAgICBzdGF0ZSxcbiAgICBwcmVmczogdW5kZWZpbmVkLFxuICB9O1xufVxuXG50ZXN0KFwiIzM2OTg6IGNvbXBsZXRpbmctbWlsZXN0b25lIGRpc3BhdGNoIGFjY2VwdHMgc2tpcHBlZCB2YWxpZGF0aW9uIGZpeHR1cmVcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cChiYXNlKSk7XG5cbiAgc2VlZE1pbGVzdG9uZShiYXNlKTtcbiAgd3JpdGVGaXh0dXJlRmlsZXMoYmFzZSk7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZmluZFJ1bGUoQ09NUExFVEVfUlVMRSkubWF0Y2gobWFrZUN0eChiYXNlKSk7XG5cbiAgYXNzZXJ0Lm9rKHJlc3VsdCwgXCJydWxlIG11c3QgcmV0dXJuIGEgcmVzdWx0XCIpO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0IS5hY3Rpb24sIFwiZGlzcGF0Y2hcIiwgXCJza2lwcGVkIHZhbGlkYXRpb24gc2hvdWxkIHN0aWxsIGFsbG93IGNvbXBsZXRpb24gZGlzcGF0Y2hcIik7XG4gIGlmIChyZXN1bHQhLmFjdGlvbiA9PT0gXCJkaXNwYXRjaFwiKSB7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC51bml0VHlwZSwgXCJjb21wbGV0ZS1taWxlc3RvbmVcIik7XG4gIH1cbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBS0EsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUNuQixTQUFTLGFBQWEsV0FBVyxRQUFRLHFCQUFxQjtBQUM5RCxTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBRXZCLFNBQVMsc0JBQTRDO0FBQ3JEO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1AsU0FBUywyQkFBMkI7QUFHcEMsTUFBTSxnQkFBZ0I7QUFFdEIsU0FBUyxXQUFtQjtBQUMxQixRQUFNLE9BQU8sWUFBWSxLQUFLLE9BQU8sR0FBRyx5QkFBeUIsQ0FBQztBQUNsRSxZQUFVLEtBQUssTUFBTSxRQUFRLGNBQWMsUUFBUSxVQUFVLE9BQU8sT0FBTyxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDakcsZ0JBQWMsS0FBSyxNQUFNLFFBQVEsR0FBRyxnQ0FBZ0M7QUFDcEUsU0FBTztBQUNUO0FBRUEsU0FBUyxRQUFRLE1BQW9CO0FBQ25DLE1BQUk7QUFBRSxrQkFBYztBQUFBLEVBQUcsUUFBUTtBQUFBLEVBQWE7QUFDNUMsc0JBQW9CO0FBQ3BCLFNBQU8sTUFBTSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUMvQztBQUVBLFNBQVMsY0FBYyxNQUFvQjtBQUN6QyxlQUFhLEtBQUssTUFBTSxRQUFRLFFBQVEsQ0FBQztBQUN6QyxrQkFBZ0I7QUFBQSxJQUNkLElBQUk7QUFBQSxJQUNKLE9BQU87QUFBQSxJQUNQLFFBQVE7QUFBQSxJQUNSLFlBQVksQ0FBQztBQUFBLEVBQ2YsQ0FBQztB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
