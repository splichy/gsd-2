import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, closeDatabase, getMilestone, getMilestoneSlices, getSlice, updateSliceStatus, insertMilestone } from "../gsd-db.js";
import { handlePlanMilestone } from "../tools/plan-milestone.js";
import { parseRoadmap } from "../parsers-legacy.js";
function makeTmpBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-plan-milestone-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  return base;
}
function cleanup(base) {
  try {
    closeDatabase();
  } catch {
  }
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
  }
}
function validParams() {
  return {
    milestoneId: "M001",
    title: "DB-backed planning",
    vision: "Make planning write through the database.",
    successCriteria: ["Planning persists", "Roadmap renders from DB"],
    keyRisks: [
      { risk: "Renderer mismatch", whyItMatters: "Rendered roadmap may stop round-tripping." }
    ],
    proofStrategy: [
      { riskOrUnknown: "Render correctness", retireIn: "S01", whatWillBeProven: "ROADMAP output matches DB state." }
    ],
    verificationContract: "Contract verification text",
    verificationIntegration: "Integration verification text",
    verificationOperational: "Operational verification text",
    verificationUat: "UAT verification text",
    definitionOfDone: ["Tests pass", "Tool reruns cleanly"],
    requirementCoverage: "Covers R015.",
    boundaryMapMarkdown: "| From | To | Produces | Consumes |\n|------|----|----------|----------|\n| S01 | terminal | roadmap | nothing |",
    slices: [
      {
        sliceId: "S01",
        title: "Tool wiring",
        risk: "medium",
        depends: [],
        demo: "The tool writes roadmap state.",
        goal: "Wire the handler.",
        successCriteria: "Handler persists state and renders markdown.",
        proofLevel: "integration",
        integrationClosure: "Downstream callers read rendered roadmap output.",
        observabilityImpact: "Tests expose render and validation failures."
      },
      {
        sliceId: "S02",
        title: "Prompt migration",
        risk: "low",
        depends: ["S01"],
        demo: "Prompts call the tool.",
        goal: "Migrate prompts to DB-backed path.",
        successCriteria: "Prompt contracts reference the new tool.",
        proofLevel: "integration",
        integrationClosure: "Prompt tests cover the new planning route.",
        observabilityImpact: "Prompt and rogue-write failures become explicit."
      }
    ]
  };
}
test("handlePlanMilestone writes milestone and slice planning state and renders roadmap", async () => {
  const base = makeTmpBase();
  const dbPath = join(base, ".gsd", "gsd.db");
  openDatabase(dbPath);
  try {
    const result = await handlePlanMilestone(validParams(), base);
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    const milestone = getMilestone("M001");
    assert.ok(milestone, "milestone should exist");
    assert.equal(milestone?.vision, "Make planning write through the database.");
    assert.deepEqual(milestone?.success_criteria, ["Planning persists", "Roadmap renders from DB"]);
    assert.equal(milestone?.verification_contract, "Contract verification text");
    const slices = getMilestoneSlices("M001");
    assert.equal(slices.length, 2);
    assert.equal(slices[0]?.id, "S01");
    assert.equal(slices[0]?.goal, "Wire the handler.");
    assert.equal(slices[1]?.depends[0], "S01");
    const roadmapPath = join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md");
    assert.ok(existsSync(roadmapPath), "roadmap should be rendered to disk");
    const roadmap = readFileSync(roadmapPath, "utf-8");
    assert.match(roadmap, /# M001: DB-backed planning/);
    assert.match(roadmap, /\*\*Vision:\*\* Make planning write through the database\./);
    assert.match(roadmap, /^## Slices$/m);
    assert.match(roadmap, /- \[ \] \*\*S01: Tool wiring\*\* `risk:medium` `depends:\[\]`/);
    assert.match(roadmap, /- \[ \] \*\*S02: Prompt migration\*\* `risk:low` `depends:\[S01\]`/);
  } finally {
    cleanup(base);
  }
});
test("handlePlanMilestone rejects invalid payloads", async () => {
  const base = makeTmpBase();
  const dbPath = join(base, ".gsd", "gsd.db");
  openDatabase(dbPath);
  try {
    const params = validParams();
    const result = await handlePlanMilestone({ ...params, slices: [] }, base);
    assert.ok("error" in result);
    assert.match(result.error, /validation failed: slices must be a non-empty array/);
  } finally {
    cleanup(base);
  }
});
test("handlePlanMilestone rejects delimiter characters in milestone and slice titles", async () => {
  const base = makeTmpBase();
  const dbPath = join(base, ".gsd", "gsd.db");
  openDatabase(dbPath);
  try {
    const milestoneResult = await handlePlanMilestone({ ...validParams(), title: "Client/Server split" }, base);
    assert.ok("error" in milestoneResult);
    assert.match(milestoneResult.error, /validation failed: title is invalid: .*forward slash/);
    assert.equal(getMilestone("M001"), null, "invalid milestone title must not persist");
    const sliceResult = await handlePlanMilestone({
      ...validParams(),
      slices: [
        validParams().slices[0],
        { ...validParams().slices[1], title: "Client/Server migration" }
      ]
    }, base);
    assert.ok("error" in sliceResult);
    assert.match(sliceResult.error, /validation failed: slices\[1\]\.title is invalid: .*forward slash/);
    assert.equal(getMilestoneSlices("M001").length, 0, "invalid slice title must not persist partial roadmap state");
  } finally {
    cleanup(base);
  }
});
test("handlePlanMilestone surfaces render failures and does not clear parse-visible state on failure", async () => {
  const base = makeTmpBase();
  const dbPath = join(base, ".gsd", "gsd.db");
  openDatabase(dbPath);
  try {
    const fallbackRoadmapPath = join(base, ".gsd", "milestones", "MISSING", "MISSING-ROADMAP.md");
    mkdirSync(fallbackRoadmapPath, { recursive: true });
    const result = await handlePlanMilestone({ ...validParams(), milestoneId: "MISSING" }, base);
    assert.ok("error" in result);
    assert.match(result.error, /render failed:/);
    const existingRoadmapPath = join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md");
    writeFileSync(existingRoadmapPath, "# M001: Cached roadmap\n\n**Vision:** old value\n\n## Slices\n\n", "utf-8");
    const cachedAfter = parseRoadmap(readFileSync(existingRoadmapPath, "utf-8"));
    assert.equal(cachedAfter.vision, "old value");
  } finally {
    cleanup(base);
  }
});
test("handlePlanMilestone clears parse-visible roadmap state after successful render", async () => {
  const base = makeTmpBase();
  const dbPath = join(base, ".gsd", "gsd.db");
  openDatabase(dbPath);
  try {
    const roadmapPath = join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md");
    writeFileSync(roadmapPath, "# M001: Cached roadmap\n\n**Vision:** old value\n\n## Slices\n\n", "utf-8");
    const cachedBefore = parseRoadmap(readFileSync(roadmapPath, "utf-8"));
    assert.equal(cachedBefore.vision, "old value");
    const result = await handlePlanMilestone(validParams(), base);
    assert.ok(!("error" in result));
    const contentAfter = readFileSync(roadmapPath, "utf-8");
    assert.match(contentAfter, /Make planning write through the database\./);
    assert.match(contentAfter, /S01/);
    assert.match(contentAfter, /S02/);
  } finally {
    cleanup(base);
  }
});
test("handlePlanMilestone reruns idempotently and updates existing planning state", async () => {
  const base = makeTmpBase();
  const dbPath = join(base, ".gsd", "gsd.db");
  openDatabase(dbPath);
  try {
    const first = await handlePlanMilestone(validParams(), base);
    assert.ok(!("error" in first));
    const second = await handlePlanMilestone({
      ...validParams(),
      vision: "Updated vision",
      slices: [
        {
          ...validParams().slices[0],
          goal: "Updated goal",
          observabilityImpact: "Updated observability"
        },
        validParams().slices[1]
      ]
    }, base);
    assert.ok(!("error" in second));
    const milestone = getMilestone("M001");
    assert.equal(milestone?.vision, "Updated vision");
    const slices = getMilestoneSlices("M001");
    assert.equal(slices.length, 2);
    assert.equal(slices[0]?.goal, "Updated goal");
    assert.equal(slices[0]?.observability_impact, "Updated observability");
  } finally {
    cleanup(base);
  }
});
test("handlePlanMilestone preserves completed slice status on re-plan (#2558)", async () => {
  const base = makeTmpBase();
  const dbPath = join(base, ".gsd", "gsd.db");
  openDatabase(dbPath);
  try {
    const first = await handlePlanMilestone(validParams(), base);
    assert.ok(!("error" in first), `unexpected error: ${"error" in first ? first.error : ""}`);
    updateSliceStatus("M001", "S01", "complete", (/* @__PURE__ */ new Date()).toISOString());
    const s01Before = getSlice("M001", "S01");
    assert.equal(s01Before?.status, "complete", "S01 should be complete before re-plan");
    const second = await handlePlanMilestone(validParams(), base);
    assert.ok(!("error" in second), `unexpected error: ${"error" in second ? second.error : ""}`);
    const s01After = getSlice("M001", "S01");
    assert.equal(s01After?.status, "complete", "S01 status must be preserved as complete after re-plan");
    const s02After = getSlice("M001", "S02");
    assert.equal(s02After?.status, "pending", "S02 should remain pending");
  } finally {
    cleanup(base);
  }
});
test("plan-milestone re-plan preserves completed status and updates slice fields (#2558)", async () => {
  const base = makeTmpBase();
  const dbPath = join(base, ".gsd", "gsd.db");
  openDatabase(dbPath);
  try {
    const first = await handlePlanMilestone(validParams(), base);
    assert.ok(!("error" in first), `unexpected error: ${"error" in first ? first.error : ""}`);
    updateSliceStatus("M001", "S01", "complete", (/* @__PURE__ */ new Date()).toISOString());
    assert.equal(getSlice("M001", "S01")?.status, "complete");
    const updatedParams = {
      ...validParams(),
      slices: [
        { ...validParams().slices[0], title: "Updated S01 title", risk: "high" },
        validParams().slices[1]
      ]
    };
    const second = await handlePlanMilestone(updatedParams, base);
    assert.ok(!("error" in second), `unexpected error: ${"error" in second ? second.error : ""}`);
    const s01After = getSlice("M001", "S01");
    assert.equal(s01After?.status, "complete", "completed slice status must survive re-plan");
    assert.equal(s01After?.title, "Updated S01 title", "title should update on re-plan");
    assert.equal(s01After?.risk, "high", "risk should update on re-plan");
    const s02After = getSlice("M001", "S02");
    assert.equal(s02After?.status, "pending", "pending slice stays pending");
  } finally {
    cleanup(base);
  }
});
test("handlePlanMilestone promotes pre-existing queued milestone to active (#3022)", async () => {
  const base = makeTmpBase();
  const dbPath = join(base, ".gsd", "gsd.db");
  openDatabase(dbPath);
  try {
    insertMilestone({ id: "M001", status: "queued" });
    const before = getMilestone("M001");
    assert.equal(before?.status, "queued", "pre-condition: milestone should start as queued");
    const result = await handlePlanMilestone(validParams(), base);
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    const after = getMilestone("M001");
    assert.equal(after?.status, "active", "milestone status should be promoted from queued to active");
    assert.equal(after?.title, "DB-backed planning", "milestone title should be set");
  } finally {
    cleanup(base);
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wbGFuLW1pbGVzdG9uZS50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdGVzdCBmcm9tICdub2RlOnRlc3QnO1xuaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydC9zdHJpY3QnO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgcm1TeW5jLCByZWFkRmlsZVN5bmMsIGV4aXN0c1N5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tICdub2RlOmZzJztcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdub2RlOnBhdGgnO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSAnbm9kZTpvcyc7XG5cbmltcG9ydCB7IG9wZW5EYXRhYmFzZSwgY2xvc2VEYXRhYmFzZSwgZ2V0TWlsZXN0b25lLCBnZXRNaWxlc3RvbmVTbGljZXMsIGdldFNsaWNlLCB1cGRhdGVTbGljZVN0YXR1cywgZGVsZXRlU2xpY2UsIGluc2VydE1pbGVzdG9uZSB9IGZyb20gJy4uL2dzZC1kYi50cyc7XG5pbXBvcnQgeyBoYW5kbGVQbGFuTWlsZXN0b25lIH0gZnJvbSAnLi4vdG9vbHMvcGxhbi1taWxlc3RvbmUudHMnO1xuaW1wb3J0IHsgcGFyc2VSb2FkbWFwIH0gZnJvbSAnLi4vcGFyc2Vycy1sZWdhY3kudHMnO1xuXG5mdW5jdGlvbiBtYWtlVG1wQmFzZSgpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgJ2dzZC1wbGFuLW1pbGVzdG9uZS0nKSk7XG4gIG1rZGlyU3luYyhqb2luKGJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgcmV0dXJuIGJhc2U7XG59XG5cbmZ1bmN0aW9uIGNsZWFudXAoYmFzZTogc3RyaW5nKTogdm9pZCB7XG4gIHRyeSB7IGNsb3NlRGF0YWJhc2UoKTsgfSBjYXRjaCB7IC8qIG5vb3AgKi8gfVxuICB0cnkgeyBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pOyB9IGNhdGNoIHsgLyogbm9vcCAqLyB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkUGFyYW1zKCkge1xuICByZXR1cm4ge1xuICAgIG1pbGVzdG9uZUlkOiAnTTAwMScsXG4gICAgdGl0bGU6ICdEQi1iYWNrZWQgcGxhbm5pbmcnLFxuICAgIHZpc2lvbjogJ01ha2UgcGxhbm5pbmcgd3JpdGUgdGhyb3VnaCB0aGUgZGF0YWJhc2UuJyxcbiAgICBzdWNjZXNzQ3JpdGVyaWE6IFsnUGxhbm5pbmcgcGVyc2lzdHMnLCAnUm9hZG1hcCByZW5kZXJzIGZyb20gREInXSxcbiAgICBrZXlSaXNrczogW1xuICAgICAgeyByaXNrOiAnUmVuZGVyZXIgbWlzbWF0Y2gnLCB3aHlJdE1hdHRlcnM6ICdSZW5kZXJlZCByb2FkbWFwIG1heSBzdG9wIHJvdW5kLXRyaXBwaW5nLicgfSxcbiAgICBdLFxuICAgIHByb29mU3RyYXRlZ3k6IFtcbiAgICAgIHsgcmlza09yVW5rbm93bjogJ1JlbmRlciBjb3JyZWN0bmVzcycsIHJldGlyZUluOiAnUzAxJywgd2hhdFdpbGxCZVByb3ZlbjogJ1JPQURNQVAgb3V0cHV0IG1hdGNoZXMgREIgc3RhdGUuJyB9LFxuICAgIF0sXG4gICAgdmVyaWZpY2F0aW9uQ29udHJhY3Q6ICdDb250cmFjdCB2ZXJpZmljYXRpb24gdGV4dCcsXG4gICAgdmVyaWZpY2F0aW9uSW50ZWdyYXRpb246ICdJbnRlZ3JhdGlvbiB2ZXJpZmljYXRpb24gdGV4dCcsXG4gICAgdmVyaWZpY2F0aW9uT3BlcmF0aW9uYWw6ICdPcGVyYXRpb25hbCB2ZXJpZmljYXRpb24gdGV4dCcsXG4gICAgdmVyaWZpY2F0aW9uVWF0OiAnVUFUIHZlcmlmaWNhdGlvbiB0ZXh0JyxcbiAgICBkZWZpbml0aW9uT2ZEb25lOiBbJ1Rlc3RzIHBhc3MnLCAnVG9vbCByZXJ1bnMgY2xlYW5seSddLFxuICAgIHJlcXVpcmVtZW50Q292ZXJhZ2U6ICdDb3ZlcnMgUjAxNS4nLFxuICAgIGJvdW5kYXJ5TWFwTWFya2Rvd246ICd8IEZyb20gfCBUbyB8IFByb2R1Y2VzIHwgQ29uc3VtZXMgfFxcbnwtLS0tLS18LS0tLXwtLS0tLS0tLS0tfC0tLS0tLS0tLS18XFxufCBTMDEgfCB0ZXJtaW5hbCB8IHJvYWRtYXAgfCBub3RoaW5nIHwnLFxuICAgIHNsaWNlczogW1xuICAgICAge1xuICAgICAgICBzbGljZUlkOiAnUzAxJyxcbiAgICAgICAgdGl0bGU6ICdUb29sIHdpcmluZycsXG4gICAgICAgIHJpc2s6ICdtZWRpdW0nLFxuICAgICAgICBkZXBlbmRzOiBbXSxcbiAgICAgICAgZGVtbzogJ1RoZSB0b29sIHdyaXRlcyByb2FkbWFwIHN0YXRlLicsXG4gICAgICAgIGdvYWw6ICdXaXJlIHRoZSBoYW5kbGVyLicsXG4gICAgICAgIHN1Y2Nlc3NDcml0ZXJpYTogJ0hhbmRsZXIgcGVyc2lzdHMgc3RhdGUgYW5kIHJlbmRlcnMgbWFya2Rvd24uJyxcbiAgICAgICAgcHJvb2ZMZXZlbDogJ2ludGVncmF0aW9uJyxcbiAgICAgICAgaW50ZWdyYXRpb25DbG9zdXJlOiAnRG93bnN0cmVhbSBjYWxsZXJzIHJlYWQgcmVuZGVyZWQgcm9hZG1hcCBvdXRwdXQuJyxcbiAgICAgICAgb2JzZXJ2YWJpbGl0eUltcGFjdDogJ1Rlc3RzIGV4cG9zZSByZW5kZXIgYW5kIHZhbGlkYXRpb24gZmFpbHVyZXMuJyxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIHNsaWNlSWQ6ICdTMDInLFxuICAgICAgICB0aXRsZTogJ1Byb21wdCBtaWdyYXRpb24nLFxuICAgICAgICByaXNrOiAnbG93JyxcbiAgICAgICAgZGVwZW5kczogWydTMDEnXSxcbiAgICAgICAgZGVtbzogJ1Byb21wdHMgY2FsbCB0aGUgdG9vbC4nLFxuICAgICAgICBnb2FsOiAnTWlncmF0ZSBwcm9tcHRzIHRvIERCLWJhY2tlZCBwYXRoLicsXG4gICAgICAgIHN1Y2Nlc3NDcml0ZXJpYTogJ1Byb21wdCBjb250cmFjdHMgcmVmZXJlbmNlIHRoZSBuZXcgdG9vbC4nLFxuICAgICAgICBwcm9vZkxldmVsOiAnaW50ZWdyYXRpb24nLFxuICAgICAgICBpbnRlZ3JhdGlvbkNsb3N1cmU6ICdQcm9tcHQgdGVzdHMgY292ZXIgdGhlIG5ldyBwbGFubmluZyByb3V0ZS4nLFxuICAgICAgICBvYnNlcnZhYmlsaXR5SW1wYWN0OiAnUHJvbXB0IGFuZCByb2d1ZS13cml0ZSBmYWlsdXJlcyBiZWNvbWUgZXhwbGljaXQuJyxcbiAgICAgIH0sXG4gICAgXSxcbiAgfTtcbn1cblxudGVzdCgnaGFuZGxlUGxhbk1pbGVzdG9uZSB3cml0ZXMgbWlsZXN0b25lIGFuZCBzbGljZSBwbGFubmluZyBzdGF0ZSBhbmQgcmVuZGVycyByb2FkbWFwJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgY29uc3QgZGJQYXRoID0gam9pbihiYXNlLCAnLmdzZCcsICdnc2QuZGInKTtcbiAgb3BlbkRhdGFiYXNlKGRiUGF0aCk7XG5cbiAgdHJ5IHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVQbGFuTWlsZXN0b25lKHZhbGlkUGFyYW1zKCksIGJhc2UpO1xuICAgIGFzc2VydC5vayghKCdlcnJvcicgaW4gcmVzdWx0KSwgYHVuZXhwZWN0ZWQgZXJyb3I6ICR7J2Vycm9yJyBpbiByZXN1bHQgPyByZXN1bHQuZXJyb3IgOiAnJ31gKTtcblxuICAgIGNvbnN0IG1pbGVzdG9uZSA9IGdldE1pbGVzdG9uZSgnTTAwMScpO1xuICAgIGFzc2VydC5vayhtaWxlc3RvbmUsICdtaWxlc3RvbmUgc2hvdWxkIGV4aXN0Jyk7XG4gICAgYXNzZXJ0LmVxdWFsKG1pbGVzdG9uZT8udmlzaW9uLCAnTWFrZSBwbGFubmluZyB3cml0ZSB0aHJvdWdoIHRoZSBkYXRhYmFzZS4nKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKG1pbGVzdG9uZT8uc3VjY2Vzc19jcml0ZXJpYSwgWydQbGFubmluZyBwZXJzaXN0cycsICdSb2FkbWFwIHJlbmRlcnMgZnJvbSBEQiddKTtcbiAgICBhc3NlcnQuZXF1YWwobWlsZXN0b25lPy52ZXJpZmljYXRpb25fY29udHJhY3QsICdDb250cmFjdCB2ZXJpZmljYXRpb24gdGV4dCcpO1xuXG4gICAgY29uc3Qgc2xpY2VzID0gZ2V0TWlsZXN0b25lU2xpY2VzKCdNMDAxJyk7XG4gICAgYXNzZXJ0LmVxdWFsKHNsaWNlcy5sZW5ndGgsIDIpO1xuICAgIGFzc2VydC5lcXVhbChzbGljZXNbMF0/LmlkLCAnUzAxJyk7XG4gICAgYXNzZXJ0LmVxdWFsKHNsaWNlc1swXT8uZ29hbCwgJ1dpcmUgdGhlIGhhbmRsZXIuJyk7XG4gICAgYXNzZXJ0LmVxdWFsKHNsaWNlc1sxXT8uZGVwZW5kc1swXSwgJ1MwMScpO1xuXG4gICAgY29uc3Qgcm9hZG1hcFBhdGggPSBqb2luKGJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScsICdNMDAxLVJPQURNQVAubWQnKTtcbiAgICBhc3NlcnQub2soZXhpc3RzU3luYyhyb2FkbWFwUGF0aCksICdyb2FkbWFwIHNob3VsZCBiZSByZW5kZXJlZCB0byBkaXNrJyk7XG4gICAgY29uc3Qgcm9hZG1hcCA9IHJlYWRGaWxlU3luYyhyb2FkbWFwUGF0aCwgJ3V0Zi04Jyk7XG4gICAgYXNzZXJ0Lm1hdGNoKHJvYWRtYXAsIC8jIE0wMDE6IERCLWJhY2tlZCBwbGFubmluZy8pO1xuICAgIGFzc2VydC5tYXRjaChyb2FkbWFwLCAvXFwqXFwqVmlzaW9uOlxcKlxcKiBNYWtlIHBsYW5uaW5nIHdyaXRlIHRocm91Z2ggdGhlIGRhdGFiYXNlXFwuLyk7XG4gICAgYXNzZXJ0Lm1hdGNoKHJvYWRtYXAsIC9eIyMgU2xpY2VzJC9tKTtcbiAgICBhc3NlcnQubWF0Y2gocm9hZG1hcCwgLy0gXFxbIFxcXSBcXCpcXCpTMDE6IFRvb2wgd2lyaW5nXFwqXFwqIGByaXNrOm1lZGl1bWAgYGRlcGVuZHM6XFxbXFxdYC8pO1xuICAgIGFzc2VydC5tYXRjaChyb2FkbWFwLCAvLSBcXFsgXFxdIFxcKlxcKlMwMjogUHJvbXB0IG1pZ3JhdGlvblxcKlxcKiBgcmlzazpsb3dgIGBkZXBlbmRzOlxcW1MwMVxcXWAvKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdCgnaGFuZGxlUGxhbk1pbGVzdG9uZSByZWplY3RzIGludmFsaWQgcGF5bG9hZHMnLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICBjb25zdCBkYlBhdGggPSBqb2luKGJhc2UsICcuZ3NkJywgJ2dzZC5kYicpO1xuICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcblxuICB0cnkge1xuICAgIGNvbnN0IHBhcmFtcyA9IHZhbGlkUGFyYW1zKCk7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlUGxhbk1pbGVzdG9uZSh7IC4uLnBhcmFtcywgc2xpY2VzOiBbXSB9LCBiYXNlKTtcbiAgICBhc3NlcnQub2soJ2Vycm9yJyBpbiByZXN1bHQpO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQuZXJyb3IsIC92YWxpZGF0aW9uIGZhaWxlZDogc2xpY2VzIG11c3QgYmUgYSBub24tZW1wdHkgYXJyYXkvKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdCgnaGFuZGxlUGxhbk1pbGVzdG9uZSByZWplY3RzIGRlbGltaXRlciBjaGFyYWN0ZXJzIGluIG1pbGVzdG9uZSBhbmQgc2xpY2UgdGl0bGVzJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgY29uc3QgZGJQYXRoID0gam9pbihiYXNlLCAnLmdzZCcsICdnc2QuZGInKTtcbiAgb3BlbkRhdGFiYXNlKGRiUGF0aCk7XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBtaWxlc3RvbmVSZXN1bHQgPSBhd2FpdCBoYW5kbGVQbGFuTWlsZXN0b25lKHsgLi4udmFsaWRQYXJhbXMoKSwgdGl0bGU6ICdDbGllbnQvU2VydmVyIHNwbGl0JyB9LCBiYXNlKTtcbiAgICBhc3NlcnQub2soJ2Vycm9yJyBpbiBtaWxlc3RvbmVSZXN1bHQpO1xuICAgIGFzc2VydC5tYXRjaChtaWxlc3RvbmVSZXN1bHQuZXJyb3IsIC92YWxpZGF0aW9uIGZhaWxlZDogdGl0bGUgaXMgaW52YWxpZDogLipmb3J3YXJkIHNsYXNoLyk7XG4gICAgYXNzZXJ0LmVxdWFsKGdldE1pbGVzdG9uZSgnTTAwMScpLCBudWxsLCAnaW52YWxpZCBtaWxlc3RvbmUgdGl0bGUgbXVzdCBub3QgcGVyc2lzdCcpO1xuXG4gICAgY29uc3Qgc2xpY2VSZXN1bHQgPSBhd2FpdCBoYW5kbGVQbGFuTWlsZXN0b25lKHtcbiAgICAgIC4uLnZhbGlkUGFyYW1zKCksXG4gICAgICBzbGljZXM6IFtcbiAgICAgICAgdmFsaWRQYXJhbXMoKS5zbGljZXNbMF0sXG4gICAgICAgIHsgLi4udmFsaWRQYXJhbXMoKS5zbGljZXNbMV0sIHRpdGxlOiAnQ2xpZW50L1NlcnZlciBtaWdyYXRpb24nIH0sXG4gICAgICBdLFxuICAgIH0sIGJhc2UpO1xuICAgIGFzc2VydC5vaygnZXJyb3InIGluIHNsaWNlUmVzdWx0KTtcbiAgICBhc3NlcnQubWF0Y2goc2xpY2VSZXN1bHQuZXJyb3IsIC92YWxpZGF0aW9uIGZhaWxlZDogc2xpY2VzXFxbMVxcXVxcLnRpdGxlIGlzIGludmFsaWQ6IC4qZm9yd2FyZCBzbGFzaC8pO1xuICAgIGFzc2VydC5lcXVhbChnZXRNaWxlc3RvbmVTbGljZXMoJ00wMDEnKS5sZW5ndGgsIDAsICdpbnZhbGlkIHNsaWNlIHRpdGxlIG11c3Qgbm90IHBlcnNpc3QgcGFydGlhbCByb2FkbWFwIHN0YXRlJyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoJ2hhbmRsZVBsYW5NaWxlc3RvbmUgc3VyZmFjZXMgcmVuZGVyIGZhaWx1cmVzIGFuZCBkb2VzIG5vdCBjbGVhciBwYXJzZS12aXNpYmxlIHN0YXRlIG9uIGZhaWx1cmUnLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICBjb25zdCBkYlBhdGggPSBqb2luKGJhc2UsICcuZ3NkJywgJ2dzZC5kYicpO1xuICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcblxuICB0cnkge1xuICAgIGNvbnN0IGZhbGxiYWNrUm9hZG1hcFBhdGggPSBqb2luKGJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTUlTU0lORycsICdNSVNTSU5HLVJPQURNQVAubWQnKTtcbiAgICBta2RpclN5bmMoZmFsbGJhY2tSb2FkbWFwUGF0aCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVQbGFuTWlsZXN0b25lKHsgLi4udmFsaWRQYXJhbXMoKSwgbWlsZXN0b25lSWQ6ICdNSVNTSU5HJyB9LCBiYXNlKTtcbiAgICBhc3NlcnQub2soJ2Vycm9yJyBpbiByZXN1bHQpO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQuZXJyb3IsIC9yZW5kZXIgZmFpbGVkOi8pO1xuXG4gICAgY29uc3QgZXhpc3RpbmdSb2FkbWFwUGF0aCA9IGpvaW4oYmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAxJywgJ00wMDEtUk9BRE1BUC5tZCcpO1xuICAgIHdyaXRlRmlsZVN5bmMoZXhpc3RpbmdSb2FkbWFwUGF0aCwgJyMgTTAwMTogQ2FjaGVkIHJvYWRtYXBcXG5cXG4qKlZpc2lvbjoqKiBvbGQgdmFsdWVcXG5cXG4jIyBTbGljZXNcXG5cXG4nLCAndXRmLTgnKTtcbiAgICBjb25zdCBjYWNoZWRBZnRlciA9IHBhcnNlUm9hZG1hcChyZWFkRmlsZVN5bmMoZXhpc3RpbmdSb2FkbWFwUGF0aCwgJ3V0Zi04JykpO1xuICAgIGFzc2VydC5lcXVhbChjYWNoZWRBZnRlci52aXNpb24sICdvbGQgdmFsdWUnKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdCgnaGFuZGxlUGxhbk1pbGVzdG9uZSBjbGVhcnMgcGFyc2UtdmlzaWJsZSByb2FkbWFwIHN0YXRlIGFmdGVyIHN1Y2Nlc3NmdWwgcmVuZGVyJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgY29uc3QgZGJQYXRoID0gam9pbihiYXNlLCAnLmdzZCcsICdnc2QuZGInKTtcbiAgb3BlbkRhdGFiYXNlKGRiUGF0aCk7XG5cbiAgdHJ5IHtcbiAgICBjb25zdCByb2FkbWFwUGF0aCA9IGpvaW4oYmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAxJywgJ00wMDEtUk9BRE1BUC5tZCcpO1xuICAgIHdyaXRlRmlsZVN5bmMocm9hZG1hcFBhdGgsICcjIE0wMDE6IENhY2hlZCByb2FkbWFwXFxuXFxuKipWaXNpb246Kiogb2xkIHZhbHVlXFxuXFxuIyMgU2xpY2VzXFxuXFxuJywgJ3V0Zi04Jyk7XG5cbiAgICBjb25zdCBjYWNoZWRCZWZvcmUgPSBwYXJzZVJvYWRtYXAocmVhZEZpbGVTeW5jKHJvYWRtYXBQYXRoLCAndXRmLTgnKSk7XG4gICAgYXNzZXJ0LmVxdWFsKGNhY2hlZEJlZm9yZS52aXNpb24sICdvbGQgdmFsdWUnKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZVBsYW5NaWxlc3RvbmUodmFsaWRQYXJhbXMoKSwgYmFzZSk7XG4gICAgYXNzZXJ0Lm9rKCEoJ2Vycm9yJyBpbiByZXN1bHQpKTtcblxuICAgIGNvbnN0IGNvbnRlbnRBZnRlciA9IHJlYWRGaWxlU3luYyhyb2FkbWFwUGF0aCwgJ3V0Zi04Jyk7XG4gICAgYXNzZXJ0Lm1hdGNoKGNvbnRlbnRBZnRlciwgL01ha2UgcGxhbm5pbmcgd3JpdGUgdGhyb3VnaCB0aGUgZGF0YWJhc2VcXC4vKTtcbiAgICBhc3NlcnQubWF0Y2goY29udGVudEFmdGVyLCAvUzAxLyk7XG4gICAgYXNzZXJ0Lm1hdGNoKGNvbnRlbnRBZnRlciwgL1MwMi8pO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KCdoYW5kbGVQbGFuTWlsZXN0b25lIHJlcnVucyBpZGVtcG90ZW50bHkgYW5kIHVwZGF0ZXMgZXhpc3RpbmcgcGxhbm5pbmcgc3RhdGUnLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICBjb25zdCBkYlBhdGggPSBqb2luKGJhc2UsICcuZ3NkJywgJ2dzZC5kYicpO1xuICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcblxuICB0cnkge1xuICAgIGNvbnN0IGZpcnN0ID0gYXdhaXQgaGFuZGxlUGxhbk1pbGVzdG9uZSh2YWxpZFBhcmFtcygpLCBiYXNlKTtcbiAgICBhc3NlcnQub2soISgnZXJyb3InIGluIGZpcnN0KSk7XG5cbiAgICBjb25zdCBzZWNvbmQgPSBhd2FpdCBoYW5kbGVQbGFuTWlsZXN0b25lKHtcbiAgICAgIC4uLnZhbGlkUGFyYW1zKCksXG4gICAgICB2aXNpb246ICdVcGRhdGVkIHZpc2lvbicsXG4gICAgICBzbGljZXM6IFtcbiAgICAgICAge1xuICAgICAgICAgIC4uLnZhbGlkUGFyYW1zKCkuc2xpY2VzWzBdLFxuICAgICAgICAgIGdvYWw6ICdVcGRhdGVkIGdvYWwnLFxuICAgICAgICAgIG9ic2VydmFiaWxpdHlJbXBhY3Q6ICdVcGRhdGVkIG9ic2VydmFiaWxpdHknLFxuICAgICAgICB9LFxuICAgICAgICB2YWxpZFBhcmFtcygpLnNsaWNlc1sxXSxcbiAgICAgIF0sXG4gICAgfSwgYmFzZSk7XG4gICAgYXNzZXJ0Lm9rKCEoJ2Vycm9yJyBpbiBzZWNvbmQpKTtcblxuICAgIGNvbnN0IG1pbGVzdG9uZSA9IGdldE1pbGVzdG9uZSgnTTAwMScpO1xuICAgIGFzc2VydC5lcXVhbChtaWxlc3RvbmU/LnZpc2lvbiwgJ1VwZGF0ZWQgdmlzaW9uJyk7XG5cbiAgICBjb25zdCBzbGljZXMgPSBnZXRNaWxlc3RvbmVTbGljZXMoJ00wMDEnKTtcbiAgICBhc3NlcnQuZXF1YWwoc2xpY2VzLmxlbmd0aCwgMik7XG4gICAgYXNzZXJ0LmVxdWFsKHNsaWNlc1swXT8uZ29hbCwgJ1VwZGF0ZWQgZ29hbCcpO1xuICAgIGFzc2VydC5lcXVhbChzbGljZXNbMF0/Lm9ic2VydmFiaWxpdHlfaW1wYWN0LCAnVXBkYXRlZCBvYnNlcnZhYmlsaXR5Jyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoJ2hhbmRsZVBsYW5NaWxlc3RvbmUgcHJlc2VydmVzIGNvbXBsZXRlZCBzbGljZSBzdGF0dXMgb24gcmUtcGxhbiAoIzI1NTgpJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgY29uc3QgZGJQYXRoID0gam9pbihiYXNlLCAnLmdzZCcsICdnc2QuZGInKTtcbiAgb3BlbkRhdGFiYXNlKGRiUGF0aCk7XG5cbiAgdHJ5IHtcbiAgICAvLyBJbml0aWFsIHBsYW4gXHUyMDE0IGJvdGggc2xpY2VzIHN0YXJ0IGFzIFwicGVuZGluZ1wiXG4gICAgY29uc3QgZmlyc3QgPSBhd2FpdCBoYW5kbGVQbGFuTWlsZXN0b25lKHZhbGlkUGFyYW1zKCksIGJhc2UpO1xuICAgIGFzc2VydC5vayghKCdlcnJvcicgaW4gZmlyc3QpLCBgdW5leHBlY3RlZCBlcnJvcjogJHsnZXJyb3InIGluIGZpcnN0ID8gZmlyc3QuZXJyb3IgOiAnJ31gKTtcblxuICAgIC8vIE1hcmsgUzAxIGFzIGNvbXBsZXRlIChzaW11bGF0ZXMgd29yayBkb25lIGluIGEgd29ya3RyZWUpXG4gICAgdXBkYXRlU2xpY2VTdGF0dXMoJ00wMDEnLCAnUzAxJywgJ2NvbXBsZXRlJywgbmV3IERhdGUoKS50b0lTT1N0cmluZygpKTtcblxuICAgIGNvbnN0IHMwMUJlZm9yZSA9IGdldFNsaWNlKCdNMDAxJywgJ1MwMScpO1xuICAgIGFzc2VydC5lcXVhbChzMDFCZWZvcmU/LnN0YXR1cywgJ2NvbXBsZXRlJywgJ1MwMSBzaG91bGQgYmUgY29tcGxldGUgYmVmb3JlIHJlLXBsYW4nKTtcblxuICAgIC8vIFJlLXBsYW4gdGhlIHNhbWUgbWlsZXN0b25lIFx1MjAxNCBTMDEgbXVzdCBzdGF5IFwiY29tcGxldGVcIiwgUzAyIHN0YXlzIFwicGVuZGluZ1wiXG4gICAgY29uc3Qgc2Vjb25kID0gYXdhaXQgaGFuZGxlUGxhbk1pbGVzdG9uZSh2YWxpZFBhcmFtcygpLCBiYXNlKTtcbiAgICBhc3NlcnQub2soISgnZXJyb3InIGluIHNlY29uZCksIGB1bmV4cGVjdGVkIGVycm9yOiAkeydlcnJvcicgaW4gc2Vjb25kID8gc2Vjb25kLmVycm9yIDogJyd9YCk7XG5cbiAgICBjb25zdCBzMDFBZnRlciA9IGdldFNsaWNlKCdNMDAxJywgJ1MwMScpO1xuICAgIGFzc2VydC5lcXVhbChzMDFBZnRlcj8uc3RhdHVzLCAnY29tcGxldGUnLCAnUzAxIHN0YXR1cyBtdXN0IGJlIHByZXNlcnZlZCBhcyBjb21wbGV0ZSBhZnRlciByZS1wbGFuJyk7XG5cbiAgICBjb25zdCBzMDJBZnRlciA9IGdldFNsaWNlKCdNMDAxJywgJ1MwMicpO1xuICAgIGFzc2VydC5lcXVhbChzMDJBZnRlcj8uc3RhdHVzLCAncGVuZGluZycsICdTMDIgc2hvdWxkIHJlbWFpbiBwZW5kaW5nJyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoJ3BsYW4tbWlsZXN0b25lIHJlLXBsYW4gcHJlc2VydmVzIGNvbXBsZXRlZCBzdGF0dXMgYW5kIHVwZGF0ZXMgc2xpY2UgZmllbGRzICgjMjU1OCknLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICBjb25zdCBkYlBhdGggPSBqb2luKGJhc2UsICcuZ3NkJywgJ2dzZC5kYicpO1xuICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcblxuICB0cnkge1xuICAgIC8vIEluaXRpYWwgcGxhbiBcdTIwMTQgYm90aCBzbGljZXMgc3RhcnQgYXMgXCJwZW5kaW5nXCJcbiAgICBjb25zdCBmaXJzdCA9IGF3YWl0IGhhbmRsZVBsYW5NaWxlc3RvbmUodmFsaWRQYXJhbXMoKSwgYmFzZSk7XG4gICAgYXNzZXJ0Lm9rKCEoJ2Vycm9yJyBpbiBmaXJzdCksIGB1bmV4cGVjdGVkIGVycm9yOiAkeydlcnJvcicgaW4gZmlyc3QgPyBmaXJzdC5lcnJvciA6ICcnfWApO1xuXG4gICAgLy8gTWFyayBTMDEgYXMgY29tcGxldGUgKHNpbXVsYXRlcyB3b3JrIGRvbmUgaW4gd29ya3RyZWUsIHRoZW4gcmVjb25jaWxlZClcbiAgICB1cGRhdGVTbGljZVN0YXR1cygnTTAwMScsICdTMDEnLCAnY29tcGxldGUnLCBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkpO1xuICAgIGFzc2VydC5lcXVhbChnZXRTbGljZSgnTTAwMScsICdTMDEnKT8uc3RhdHVzLCAnY29tcGxldGUnKTtcblxuICAgIC8vIFJlLXBsYW4gd2l0aCB1cGRhdGVkIHRpdGxlIGZvciBTMDEuXG4gICAgLy8gVGhlIGhhbmRsZXIgbXVzdDpcbiAgICAvLyAgIDEuIE5PVCBkb3duZ3JhZGUgUzAxIGZyb20gXCJjb21wbGV0ZVwiIHRvIFwicGVuZGluZ1wiXG4gICAgLy8gICAyLiBVcGRhdGUgUzAxJ3Mgbm9uLXN0YXR1cyBmaWVsZHMgKHRpdGxlLCByaXNrLCBkZXBlbmRzLCBkZW1vKVxuICAgIC8vICAgMy4gS2VlcCBTMDIgYXMgXCJwZW5kaW5nXCJcbiAgICBjb25zdCB1cGRhdGVkUGFyYW1zID0ge1xuICAgICAgLi4udmFsaWRQYXJhbXMoKSxcbiAgICAgIHNsaWNlczogW1xuICAgICAgICB7IC4uLnZhbGlkUGFyYW1zKCkuc2xpY2VzWzBdLCB0aXRsZTogJ1VwZGF0ZWQgUzAxIHRpdGxlJywgcmlzazogJ2hpZ2gnIH0sXG4gICAgICAgIHZhbGlkUGFyYW1zKCkuc2xpY2VzWzFdLFxuICAgICAgXSxcbiAgICB9O1xuICAgIGNvbnN0IHNlY29uZCA9IGF3YWl0IGhhbmRsZVBsYW5NaWxlc3RvbmUodXBkYXRlZFBhcmFtcywgYmFzZSk7XG4gICAgYXNzZXJ0Lm9rKCEoJ2Vycm9yJyBpbiBzZWNvbmQpLCBgdW5leHBlY3RlZCBlcnJvcjogJHsnZXJyb3InIGluIHNlY29uZCA/IHNlY29uZC5lcnJvciA6ICcnfWApO1xuXG4gICAgY29uc3QgczAxQWZ0ZXIgPSBnZXRTbGljZSgnTTAwMScsICdTMDEnKTtcbiAgICBhc3NlcnQuZXF1YWwoczAxQWZ0ZXI/LnN0YXR1cywgJ2NvbXBsZXRlJywgJ2NvbXBsZXRlZCBzbGljZSBzdGF0dXMgbXVzdCBzdXJ2aXZlIHJlLXBsYW4nKTtcbiAgICBhc3NlcnQuZXF1YWwoczAxQWZ0ZXI/LnRpdGxlLCAnVXBkYXRlZCBTMDEgdGl0bGUnLCAndGl0bGUgc2hvdWxkIHVwZGF0ZSBvbiByZS1wbGFuJyk7XG4gICAgYXNzZXJ0LmVxdWFsKHMwMUFmdGVyPy5yaXNrLCAnaGlnaCcsICdyaXNrIHNob3VsZCB1cGRhdGUgb24gcmUtcGxhbicpO1xuXG4gICAgY29uc3QgczAyQWZ0ZXIgPSBnZXRTbGljZSgnTTAwMScsICdTMDInKTtcbiAgICBhc3NlcnQuZXF1YWwoczAyQWZ0ZXI/LnN0YXR1cywgJ3BlbmRpbmcnLCAncGVuZGluZyBzbGljZSBzdGF5cyBwZW5kaW5nJyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoJ2hhbmRsZVBsYW5NaWxlc3RvbmUgcHJvbW90ZXMgcHJlLWV4aXN0aW5nIHF1ZXVlZCBtaWxlc3RvbmUgdG8gYWN0aXZlICgjMzAyMiknLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICBjb25zdCBkYlBhdGggPSBqb2luKGJhc2UsICcuZ3NkJywgJ2dzZC5kYicpO1xuICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcblxuICB0cnkge1xuICAgIC8vIFNpbXVsYXRlIGVuc3VyZU1pbGVzdG9uZURiUm93OiBwcmUtY3JlYXRlIHJvdyB3aXRoIHN0YXR1cyBcInF1ZXVlZFwiXG4gICAgLy8gKHRoaXMgaXMgd2hhdCBnc2RfbWlsZXN0b25lX2dlbmVyYXRlX2lkIGRvZXMpXG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgc3RhdHVzOiAncXVldWVkJyB9KTtcblxuICAgIGNvbnN0IGJlZm9yZSA9IGdldE1pbGVzdG9uZSgnTTAwMScpO1xuICAgIGFzc2VydC5lcXVhbChiZWZvcmU/LnN0YXR1cywgJ3F1ZXVlZCcsICdwcmUtY29uZGl0aW9uOiBtaWxlc3RvbmUgc2hvdWxkIHN0YXJ0IGFzIHF1ZXVlZCcpO1xuXG4gICAgLy8gTm93IHBsYW4gdGhlIG1pbGVzdG9uZSBcdTIwMTQgc3RhdHVzIHNob3VsZCBiZSBwcm9tb3RlZCB0byBcImFjdGl2ZVwiXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlUGxhbk1pbGVzdG9uZSh2YWxpZFBhcmFtcygpLCBiYXNlKTtcbiAgICBhc3NlcnQub2soISgnZXJyb3InIGluIHJlc3VsdCksIGB1bmV4cGVjdGVkIGVycm9yOiAkeydlcnJvcicgaW4gcmVzdWx0ID8gcmVzdWx0LmVycm9yIDogJyd9YCk7XG5cbiAgICBjb25zdCBhZnRlciA9IGdldE1pbGVzdG9uZSgnTTAwMScpO1xuICAgIGFzc2VydC5lcXVhbChhZnRlcj8uc3RhdHVzLCAnYWN0aXZlJywgJ21pbGVzdG9uZSBzdGF0dXMgc2hvdWxkIGJlIHByb21vdGVkIGZyb20gcXVldWVkIHRvIGFjdGl2ZScpO1xuICAgIGFzc2VydC5lcXVhbChhZnRlcj8udGl0bGUsICdEQi1iYWNrZWQgcGxhbm5pbmcnLCAnbWlsZXN0b25lIHRpdGxlIHNob3VsZCBiZSBzZXQnKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxhQUFhLFdBQVcsUUFBUSxjQUFjLFlBQVkscUJBQXFCO0FBQ3hGLFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFF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
