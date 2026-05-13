import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, closeDatabase } from "../gsd-db.js";
import { handlePlanMilestone } from "../tools/plan-milestone.js";
function makeTmpBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-plan-sketch-render-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
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
function planMilestoneWithSketches() {
  return {
    milestoneId: "M001",
    title: "Progressive Planning Demo",
    vision: "Demonstrate sketch slices in ROADMAP rendering.",
    successCriteria: ["S01 full, S02 sketch", "ROADMAP distinguishes them"],
    keyRisks: [{ risk: "Visual collision", whyItMatters: "Auditors need to spot sketches." }],
    proofStrategy: [{ riskOrUnknown: "Render correctness", retireIn: "S01", whatWillBeProven: "Roadmap shows the badge." }],
    verificationContract: "Contract verification text",
    verificationIntegration: "Integration verification text",
    verificationOperational: "Operational verification text",
    verificationUat: "UAT verification text",
    definitionOfDone: ["Renderer emits badge", "Test asserts it"],
    requirementCoverage: "Covers ADR-011 #5750.",
    boundaryMapMarkdown: "| From | To | Produces | Consumes |\n|------|----|----------|----------|\n| S01 | S02 | scaffold | nothing |",
    slices: [
      {
        sliceId: "S01",
        title: "Fully planned scaffold",
        risk: "medium",
        depends: [],
        demo: "Scaffold is in place.",
        goal: "Lay down the structural foundation.",
        successCriteria: "Scaffold tests pass.",
        proofLevel: "integration",
        integrationClosure: "Downstream slices depend on this scaffold.",
        observabilityImpact: "No new telemetry."
        // No isSketch flag — defaults to full plan.
      },
      {
        sliceId: "S02",
        title: "Refinement candidate",
        risk: "low",
        depends: ["S01"],
        demo: "Sketched until S01 ships.",
        goal: "Refine into a full plan after S01 lands.",
        successCriteria: "",
        proofLevel: "",
        integrationClosure: "",
        observabilityImpact: "",
        isSketch: true,
        sketchScope: "Pick up the scaffold from S01 and add the demo behavior. Stay inside the existing module boundaries."
      }
    ]
  };
}
test("ROADMAP renders sketch slices with [sketch] badge and full slices without", async () => {
  const base = makeTmpBase();
  try {
    const params = planMilestoneWithSketches();
    const result = await handlePlanMilestone(params, base);
    if ("error" in result) {
      assert.fail(`handlePlanMilestone failed: ${result.error}`);
    }
    const roadmapPath = join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md");
    const roadmap = readFileSync(roadmapPath, "utf-8");
    const s01Line = roadmap.split("\n").find((line) => line.includes("**S01:"));
    assert.ok(s01Line, "S01 slice line must exist in roadmap");
    assert.equal(
      s01Line.includes("`[sketch]`"),
      false,
      "fully-planned S01 must NOT carry the sketch badge"
    );
    assert.match(s01Line, /`risk:medium`/);
    const s02Line = roadmap.split("\n").find((line) => line.includes("**S02:"));
    assert.ok(s02Line, "S02 slice line must exist in roadmap");
    assert.ok(
      s02Line.includes("`[sketch]`"),
      `sketch slice S02 must carry the sketch badge, got: ${s02Line}`
    );
    const sketchIdx = s02Line.indexOf("`[sketch]`");
    const riskIdx = s02Line.indexOf("`risk:");
    assert.ok(
      sketchIdx >= 0 && riskIdx >= 0 && sketchIdx < riskIdx,
      "sketch badge must appear before the risk tag"
    );
  } finally {
    cleanup(base);
  }
});
test("ROADMAP omits sketch badge when no slices are sketches", async () => {
  const base = makeTmpBase();
  try {
    const params = planMilestoneWithSketches();
    params.slices[1] = {
      ...params.slices[1],
      isSketch: false,
      successCriteria: "Demo behavior works.",
      proofLevel: "unit",
      integrationClosure: "S02 closes the demo behavior.",
      observabilityImpact: "No new telemetry."
    };
    const result = await handlePlanMilestone(params, base);
    if ("error" in result) {
      assert.fail(`handlePlanMilestone failed: ${result.error}`);
    }
    const roadmap = readFileSync(
      join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
      "utf-8"
    );
    assert.equal(
      roadmap.includes("`[sketch]`"),
      false,
      "roadmap must not carry the sketch badge when no slice is a sketch"
    );
  } finally {
    cleanup(base);
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wbGFuLW1pbGVzdG9uZS1za2V0Y2gtcmVuZGVyLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEFEUi0wMTEgIzU3NTA6IFJPQURNQVAubWQgcmVuZGVycyBza2V0Y2ggc2xpY2VzIHdpdGggYSBgW3NrZXRjaF1gIGJhZGdlLlxuLy9cbi8vIExvY2tzIGluIHRoZSB2aXN1YWwgZGlzdGluY3Rpb24gc28gYW4gYXVkaXRvciBzY2FubmluZyB0aGUgcmVuZGVyZWQgcm9hZG1hcFxuLy8gY2FuIHRlbGwgd2hpY2ggc2xpY2VzIGFyZSBza2V0Y2hlcyBhd2FpdGluZyByZWZpbmUtc2xpY2UgZXhwYW5zaW9uIHZzIHdoaWNoXG4vLyBhbHJlYWR5IGNhcnJ5IGEgZnVsbCBwbGFuLiBTaXRzIGFsb25nc2lkZSBgcGxhbi1taWxlc3RvbmUudGVzdC50c2Agd2hpY2hcbi8vIGNvdmVycyB0aGUgZnVsbC1wbGFuIHJlbmRlciBwYXRoLlxuXG5pbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBta2RpclN5bmMsIHJtU3luYywgcmVhZEZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuXG5pbXBvcnQgeyBvcGVuRGF0YWJhc2UsIGNsb3NlRGF0YWJhc2UgfSBmcm9tIFwiLi4vZ3NkLWRiLnRzXCI7XG5pbXBvcnQgeyBoYW5kbGVQbGFuTWlsZXN0b25lLCB0eXBlIFBsYW5NaWxlc3RvbmVQYXJhbXMgfSBmcm9tIFwiLi4vdG9vbHMvcGxhbi1taWxlc3RvbmUudHNcIjtcblxuZnVuY3Rpb24gbWFrZVRtcEJhc2UoKTogc3RyaW5nIHtcbiAgY29uc3QgYmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXBsYW4tc2tldGNoLXJlbmRlci1cIikpO1xuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsIFwiLmdzZFwiLCBcImdzZC5kYlwiKSk7XG4gIHJldHVybiBiYXNlO1xufVxuXG5mdW5jdGlvbiBjbGVhbnVwKGJhc2U6IHN0cmluZyk6IHZvaWQge1xuICB0cnkge1xuICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgfSBjYXRjaCB7XG4gICAgLyogbm9vcCAqL1xuICB9XG4gIHRyeSB7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfSBjYXRjaCB7XG4gICAgLyogbm9vcCAqL1xuICB9XG59XG5cbmZ1bmN0aW9uIHBsYW5NaWxlc3RvbmVXaXRoU2tldGNoZXMoKTogUGxhbk1pbGVzdG9uZVBhcmFtcyB7XG4gIHJldHVybiB7XG4gICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgIHRpdGxlOiBcIlByb2dyZXNzaXZlIFBsYW5uaW5nIERlbW9cIixcbiAgICB2aXNpb246IFwiRGVtb25zdHJhdGUgc2tldGNoIHNsaWNlcyBpbiBST0FETUFQIHJlbmRlcmluZy5cIixcbiAgICBzdWNjZXNzQ3JpdGVyaWE6IFtcIlMwMSBmdWxsLCBTMDIgc2tldGNoXCIsIFwiUk9BRE1BUCBkaXN0aW5ndWlzaGVzIHRoZW1cIl0sXG4gICAga2V5Umlza3M6IFt7IHJpc2s6IFwiVmlzdWFsIGNvbGxpc2lvblwiLCB3aHlJdE1hdHRlcnM6IFwiQXVkaXRvcnMgbmVlZCB0byBzcG90IHNrZXRjaGVzLlwiIH1dLFxuICAgIHByb29mU3RyYXRlZ3k6IFt7IHJpc2tPclVua25vd246IFwiUmVuZGVyIGNvcnJlY3RuZXNzXCIsIHJldGlyZUluOiBcIlMwMVwiLCB3aGF0V2lsbEJlUHJvdmVuOiBcIlJvYWRtYXAgc2hvd3MgdGhlIGJhZGdlLlwiIH1dLFxuICAgIHZlcmlmaWNhdGlvbkNvbnRyYWN0OiBcIkNvbnRyYWN0IHZlcmlmaWNhdGlvbiB0ZXh0XCIsXG4gICAgdmVyaWZpY2F0aW9uSW50ZWdyYXRpb246IFwiSW50ZWdyYXRpb24gdmVyaWZpY2F0aW9uIHRleHRcIixcbiAgICB2ZXJpZmljYXRpb25PcGVyYXRpb25hbDogXCJPcGVyYXRpb25hbCB2ZXJpZmljYXRpb24gdGV4dFwiLFxuICAgIHZlcmlmaWNhdGlvblVhdDogXCJVQVQgdmVyaWZpY2F0aW9uIHRleHRcIixcbiAgICBkZWZpbml0aW9uT2ZEb25lOiBbXCJSZW5kZXJlciBlbWl0cyBiYWRnZVwiLCBcIlRlc3QgYXNzZXJ0cyBpdFwiXSxcbiAgICByZXF1aXJlbWVudENvdmVyYWdlOiBcIkNvdmVycyBBRFItMDExICM1NzUwLlwiLFxuICAgIGJvdW5kYXJ5TWFwTWFya2Rvd246IFwifCBGcm9tIHwgVG8gfCBQcm9kdWNlcyB8IENvbnN1bWVzIHxcXG58LS0tLS0tfC0tLS18LS0tLS0tLS0tLXwtLS0tLS0tLS0tfFxcbnwgUzAxIHwgUzAyIHwgc2NhZmZvbGQgfCBub3RoaW5nIHxcIixcbiAgICBzbGljZXM6IFtcbiAgICAgIHtcbiAgICAgICAgc2xpY2VJZDogXCJTMDFcIixcbiAgICAgICAgdGl0bGU6IFwiRnVsbHkgcGxhbm5lZCBzY2FmZm9sZFwiLFxuICAgICAgICByaXNrOiBcIm1lZGl1bVwiIGFzIGNvbnN0LFxuICAgICAgICBkZXBlbmRzOiBbXSxcbiAgICAgICAgZGVtbzogXCJTY2FmZm9sZCBpcyBpbiBwbGFjZS5cIixcbiAgICAgICAgZ29hbDogXCJMYXkgZG93biB0aGUgc3RydWN0dXJhbCBmb3VuZGF0aW9uLlwiLFxuICAgICAgICBzdWNjZXNzQ3JpdGVyaWE6IFwiU2NhZmZvbGQgdGVzdHMgcGFzcy5cIixcbiAgICAgICAgcHJvb2ZMZXZlbDogXCJpbnRlZ3JhdGlvblwiIGFzIGNvbnN0LFxuICAgICAgICBpbnRlZ3JhdGlvbkNsb3N1cmU6IFwiRG93bnN0cmVhbSBzbGljZXMgZGVwZW5kIG9uIHRoaXMgc2NhZmZvbGQuXCIsXG4gICAgICAgIG9ic2VydmFiaWxpdHlJbXBhY3Q6IFwiTm8gbmV3IHRlbGVtZXRyeS5cIixcbiAgICAgICAgLy8gTm8gaXNTa2V0Y2ggZmxhZyBcdTIwMTQgZGVmYXVsdHMgdG8gZnVsbCBwbGFuLlxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgc2xpY2VJZDogXCJTMDJcIixcbiAgICAgICAgdGl0bGU6IFwiUmVmaW5lbWVudCBjYW5kaWRhdGVcIixcbiAgICAgICAgcmlzazogXCJsb3dcIiBhcyBjb25zdCxcbiAgICAgICAgZGVwZW5kczogW1wiUzAxXCJdLFxuICAgICAgICBkZW1vOiBcIlNrZXRjaGVkIHVudGlsIFMwMSBzaGlwcy5cIixcbiAgICAgICAgZ29hbDogXCJSZWZpbmUgaW50byBhIGZ1bGwgcGxhbiBhZnRlciBTMDEgbGFuZHMuXCIsXG4gICAgICAgIHN1Y2Nlc3NDcml0ZXJpYTogXCJcIixcbiAgICAgICAgcHJvb2ZMZXZlbDogXCJcIixcbiAgICAgICAgaW50ZWdyYXRpb25DbG9zdXJlOiBcIlwiLFxuICAgICAgICBvYnNlcnZhYmlsaXR5SW1wYWN0OiBcIlwiLFxuICAgICAgICBpc1NrZXRjaDogdHJ1ZSxcbiAgICAgICAgc2tldGNoU2NvcGU6IFwiUGljayB1cCB0aGUgc2NhZmZvbGQgZnJvbSBTMDEgYW5kIGFkZCB0aGUgZGVtbyBiZWhhdmlvci4gU3RheSBpbnNpZGUgdGhlIGV4aXN0aW5nIG1vZHVsZSBib3VuZGFyaWVzLlwiLFxuICAgICAgfSxcbiAgICBdLFxuICB9O1xufVxuXG50ZXN0KFwiUk9BRE1BUCByZW5kZXJzIHNrZXRjaCBzbGljZXMgd2l0aCBbc2tldGNoXSBiYWRnZSBhbmQgZnVsbCBzbGljZXMgd2l0aG91dFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIGNvbnN0IHBhcmFtcyA9IHBsYW5NaWxlc3RvbmVXaXRoU2tldGNoZXMoKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVQbGFuTWlsZXN0b25lKHBhcmFtcywgYmFzZSk7XG4gICAgaWYgKFwiZXJyb3JcIiBpbiByZXN1bHQpIHtcbiAgICAgIGFzc2VydC5mYWlsKGBoYW5kbGVQbGFuTWlsZXN0b25lIGZhaWxlZDogJHtyZXN1bHQuZXJyb3J9YCk7XG4gICAgfVxuXG4gICAgY29uc3Qgcm9hZG1hcFBhdGggPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwiTTAwMS1ST0FETUFQLm1kXCIpO1xuICAgIGNvbnN0IHJvYWRtYXAgPSByZWFkRmlsZVN5bmMocm9hZG1hcFBhdGgsIFwidXRmLThcIik7XG5cbiAgICAvLyBTMDEgaXMgYSBmdWxsIHNsaWNlIFx1MjAxNCBubyBza2V0Y2ggYmFkZ2UuXG4gICAgY29uc3QgczAxTGluZSA9IHJvYWRtYXAuc3BsaXQoXCJcXG5cIikuZmluZCgobGluZSkgPT4gbGluZS5pbmNsdWRlcyhcIioqUzAxOlwiKSk7XG4gICAgYXNzZXJ0Lm9rKHMwMUxpbmUsIFwiUzAxIHNsaWNlIGxpbmUgbXVzdCBleGlzdCBpbiByb2FkbWFwXCIpO1xuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIHMwMUxpbmUuaW5jbHVkZXMoXCJgW3NrZXRjaF1gXCIpLFxuICAgICAgZmFsc2UsXG4gICAgICBcImZ1bGx5LXBsYW5uZWQgUzAxIG11c3QgTk9UIGNhcnJ5IHRoZSBza2V0Y2ggYmFkZ2VcIixcbiAgICApO1xuICAgIGFzc2VydC5tYXRjaChzMDFMaW5lLCAvYHJpc2s6bWVkaXVtYC8pO1xuXG4gICAgLy8gUzAyIGlzIGEgc2tldGNoIFx1MjAxNCBiYWRnZSByZXF1aXJlZCwgcG9zaXRpb25lZCBiZWZvcmUgcmlzay5cbiAgICBjb25zdCBzMDJMaW5lID0gcm9hZG1hcC5zcGxpdChcIlxcblwiKS5maW5kKChsaW5lKSA9PiBsaW5lLmluY2x1ZGVzKFwiKipTMDI6XCIpKTtcbiAgICBhc3NlcnQub2soczAyTGluZSwgXCJTMDIgc2xpY2UgbGluZSBtdXN0IGV4aXN0IGluIHJvYWRtYXBcIik7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgczAyTGluZS5pbmNsdWRlcyhcImBbc2tldGNoXWBcIiksXG4gICAgICBgc2tldGNoIHNsaWNlIFMwMiBtdXN0IGNhcnJ5IHRoZSBza2V0Y2ggYmFkZ2UsIGdvdDogJHtzMDJMaW5lfWAsXG4gICAgKTtcbiAgICAvLyBCYWRnZSBzaXRzIGJlZm9yZSByaXNrIHNvIGl0IHN0YXlzIHZpc2libGUgaWYgdGhlIGxpbmUgdHJ1bmNhdGVzLlxuICAgIGNvbnN0IHNrZXRjaElkeCA9IHMwMkxpbmUuaW5kZXhPZihcImBbc2tldGNoXWBcIik7XG4gICAgY29uc3Qgcmlza0lkeCA9IHMwMkxpbmUuaW5kZXhPZihcImByaXNrOlwiKTtcbiAgICBhc3NlcnQub2soXG4gICAgICBza2V0Y2hJZHggPj0gMCAmJiByaXNrSWR4ID49IDAgJiYgc2tldGNoSWR4IDwgcmlza0lkeCxcbiAgICAgIFwic2tldGNoIGJhZGdlIG11c3QgYXBwZWFyIGJlZm9yZSB0aGUgcmlzayB0YWdcIixcbiAgICApO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiUk9BRE1BUCBvbWl0cyBza2V0Y2ggYmFkZ2Ugd2hlbiBubyBzbGljZXMgYXJlIHNrZXRjaGVzXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgY29uc3QgcGFyYW1zID0gcGxhbk1pbGVzdG9uZVdpdGhTa2V0Y2hlcygpO1xuICAgIC8vIFN0cmlwIHRoZSBza2V0Y2ggZGVzaWduYXRpb24gZnJvbSBTMDIgc28gYm90aCBzbGljZXMgYXJlIGZ1bGx5IHBsYW5uZWQuXG4gICAgcGFyYW1zLnNsaWNlc1sxXSA9IHtcbiAgICAgIC4uLnBhcmFtcy5zbGljZXNbMV0sXG4gICAgICBpc1NrZXRjaDogZmFsc2UsXG4gICAgICBzdWNjZXNzQ3JpdGVyaWE6IFwiRGVtbyBiZWhhdmlvciB3b3Jrcy5cIixcbiAgICAgIHByb29mTGV2ZWw6IFwidW5pdFwiIGFzIGNvbnN0LFxuICAgICAgaW50ZWdyYXRpb25DbG9zdXJlOiBcIlMwMiBjbG9zZXMgdGhlIGRlbW8gYmVoYXZpb3IuXCIsXG4gICAgICBvYnNlcnZhYmlsaXR5SW1wYWN0OiBcIk5vIG5ldyB0ZWxlbWV0cnkuXCIsXG4gICAgfTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZVBsYW5NaWxlc3RvbmUocGFyYW1zLCBiYXNlKTtcbiAgICBpZiAoXCJlcnJvclwiIGluIHJlc3VsdCkge1xuICAgICAgYXNzZXJ0LmZhaWwoYGhhbmRsZVBsYW5NaWxlc3RvbmUgZmFpbGVkOiAke3Jlc3VsdC5lcnJvcn1gKTtcbiAgICB9XG5cbiAgICBjb25zdCByb2FkbWFwID0gcmVhZEZpbGVTeW5jKFxuICAgICAgam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcIk0wMDEtUk9BRE1BUC5tZFwiKSxcbiAgICAgIFwidXRmLThcIixcbiAgICApO1xuXG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgcm9hZG1hcC5pbmNsdWRlcyhcImBbc2tldGNoXWBcIiksXG4gICAgICBmYWxzZSxcbiAgICAgIFwicm9hZG1hcCBtdXN0IG5vdCBjYXJyeSB0aGUgc2tldGNoIGJhZGdlIHdoZW4gbm8gc2xpY2UgaXMgYSBza2V0Y2hcIixcbiAgICApO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBT0EsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUNuQixTQUFTLGFBQWEsV0FBVyxRQUFRLG9CQUFvQjtBQUM3RCxTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBRXZCLFNBQVMsY0FBYyxxQkFBcUI7QUFDNUMsU0FBUywyQkFBcUQ7QUFFOUQsU0FBUyxjQUFzQjtBQUM3QixRQUFNLE9BQU8sWUFBWSxLQUFLLE9BQU8sR0FBRyx5QkFBeUIsQ0FBQztBQUNsRSxZQUFVLEtBQUssTUFBTSxRQUFRLGNBQWMsTUFBTSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDdkUsZUFBYSxLQUFLLE1BQU0sUUFBUSxRQUFRLENBQUM7QUFDekMsU0FBTztBQUNUO0FBRUEsU0FBUyxRQUFRLE1BQW9CO0FBQ25DLE1BQUk7QUFDRixrQkFBYztBQUFBLEVBQ2hCLFFBQVE7QUFBQSxFQUVSO0FBQ0EsTUFBSTtBQUNGLFdBQU8sTUFBTSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLEVBQy9DLFFBQVE7QUFBQSxFQUVSO0FBQ0Y7QUFFQSxTQUFTLDRCQUFpRDtBQUN4RCxTQUFPO0FBQUEsSUFDTCxhQUFhO0FBQUEsSUFDYixPQUFPO0FBQUEsSUFDUCxRQUFRO0FBQUEsSUFDUixpQkFBaUIsQ0FBQyx3QkFBd0IsNEJBQTRCO0FBQUEsSUFDdEUsVUFBVSxDQUFDLEVBQUUsTUFBTSxvQkFBb0IsY0FBYyxrQ0FBa0MsQ0FBQztBQUFBLElBQ3hGLGVBQWUsQ0FBQyxFQUFFLGVBQWUsc0JBQXNCLFVBQVUsT0FBTyxrQkFBa0IsMkJBQTJCLENBQUM7QUFBQSxJQUN0SCxzQkFBc0I7QUFBQSxJQUN0Qix5QkFBeUI7QUFBQSxJQUN6Qix5QkFBeUI7QUFBQSxJQUN6QixpQkFBaUI7QUFBQSxJQUNqQixrQkFBa0IsQ0FBQyx3QkFBd0IsaUJBQWlCO0FBQUEsSUFDNUQscUJBQXFCO0FBQUEsSUFDckIscUJBQXFCO0FBQUEsSUFDckIsUUFBUTtBQUFBLE1BQ047QUFBQSxRQUNFLFNBQVM7QUFBQSxRQUNULE9BQU87QUFBQSxRQUNQLE1BQU07QUFBQSxRQUNOLFNBQVMsQ0FBQztBQUFBLFFBQ1YsTUFBTTtBQUFBLFFBQ04sTUFBTTtBQUFBLFFBQ04saUJBQWlCO0FBQUEsUUFDakIsWUFBWTtBQUFBLFFBQ1osb0JBQW9CO0FBQUEsUUFDcEIscUJBQXFCO0FBQUE7QUFBQSxNQUV2QjtBQUFBLE1BQ0E7QUFBQSxRQUNFLFNBQVM7QUFBQSxRQUNULE9BQU87QUFBQSxRQUNQLE1BQU07QUFBQSxRQUNOLFNBQVMsQ0FBQyxLQUFLO0FBQUEsUUFDZixNQUFNO0FBQUEsUUFDTixNQUFNO0FBQUEsUUFDTixpQkFBaUI7QUFBQSxRQUNqQixZQUFZO0FBQUEsUUFDWixvQkFBb0I7QUFBQSxRQUNwQixxQkFBcUI7QUFBQSxRQUNyQixVQUFVO0FBQUEsUUFDVixhQUFhO0FBQUEsTUFDZjtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQ0Y7QUFFQSxLQUFLLDZFQUE2RSxZQUFZO0FBQzVGLFFBQU0sT0FBTyxZQUFZO0FBQ3pCLE1BQUk7QUFDRixVQUFNLFNBQVMsMEJBQTBCO0FBQ3pDLFVBQU0sU0FBUyxNQUFNLG9CQUFvQixRQUFRLElBQUk7QUFDckQsUUFBSSxXQUFXLFFBQVE7QUFDckIsYUFBTyxLQUFLLCtCQUErQixPQUFPLEtBQUssRUFBRTtBQUFBLElBQzNEO0FBRUEsVUFBTSxjQUFjLEtBQUssTUFBTSxRQUFRLGNBQWMsUUFBUSxpQkFBaUI7QUFDOUUsVUFBTSxVQUFVLGFBQWEsYUFBYSxPQUFPO0FBR2pELFVBQU0sVUFBVSxRQUFRLE1BQU0sSUFBSSxFQUFFLEtBQUssQ0FBQyxTQUFTLEtBQUssU0FBUyxRQUFRLENBQUM7QUFDMUUsV0FBTyxHQUFHLFNBQVMsc0NBQXNDO0FBQ3pELFdBQU87QUFBQSxNQUNMLFFBQVEsU0FBUyxZQUFZO0FBQUEsTUFDN0I7QUFBQSxNQUNBO0FBQUEsSUFDRjtBQUNBLFdBQU8sTUFBTSxTQUFTLGVBQWU7QUFHckMsVUFBTSxVQUFVLFFBQVEsTUFBTSxJQUFJLEVBQUUsS0FBSyxDQUFDLFNBQVMsS0FBSyxTQUFTLFFBQVEsQ0FBQztBQUMxRSxXQUFPLEdBQUcsU0FBUyxzQ0FBc0M7QUFDekQsV0FBTztBQUFBLE1BQ0wsUUFBUSxTQUFTLFlBQVk7QUFBQSxNQUM3QixzREFBc0QsT0FBTztBQUFBLElBQy9EO0FBRUEsVUFBTSxZQUFZLFFBQVEsUUFBUSxZQUFZO0FBQzlDLFVBQU0sVUFBVSxRQUFRLFFBQVEsUUFBUTtBQUN4QyxXQUFPO0FBQUEsTUFDTCxhQUFhLEtBQUssV0FBVyxLQUFLLFlBQVk7QUFBQSxNQUM5QztBQUFBLElBQ0Y7QUFBQSxFQUNGLFVBQUU7QUFDQSxZQUFRLElBQUk7QUFBQSxFQUNkO0FBQ0YsQ0FBQztBQUVELEtBQUssMERBQTBELFlBQVk7QUFDekUsUUFBTSxPQUFPLFlBQVk7QUFDekIsTUFBSTtBQUNGLFVBQU0sU0FBUywwQkFBMEI7QUFFekMsV0FBTyxPQUFPLENBQUMsSUFBSTtBQUFBLE1BQ2pCLEdBQUcsT0FBTyxPQUFPLENBQUM7QUFBQSxNQUNsQixVQUFVO0FBQUEsTUFDVixpQkFBaUI7QUFBQSxNQUNqQixZQUFZO0FBQUEsTUFDWixvQkFBb0I7QUFBQSxNQUNwQixxQkFBcUI7QUFBQSxJQUN2QjtBQUVBLFVBQU0sU0FBUyxNQUFNLG9CQUFvQixRQUFRLElBQUk7QUFDckQsUUFBSSxXQUFXLFFBQVE7QUFDckIsYUFBTyxLQUFLLCtCQUErQixPQUFPLEtBQUssRUFBRTtBQUFBLElBQzNEO0FBRUEsVUFBTSxVQUFVO0FBQUEsTUFDZCxLQUFLLE1BQU0sUUFBUSxjQUFjLFFBQVEsaUJBQWlCO0FBQUEsTUFDMUQ7QUFBQSxJQUNGO0FBRUEsV0FBTztBQUFBLE1BQ0wsUUFBUSxTQUFTLFlBQVk7QUFBQSxNQUM3QjtBQUFBLE1BQ0E7QUFBQSxJQUNGO0FBQUEsRUFDRixVQUFFO0FBQ0EsWUFBUSxJQUFJO0FBQUEsRUFDZDtBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
