import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, closeDatabase } from "../gsd-db.js";
import { handlePlanMilestone } from "../tools/plan-milestone.js";
const boundaryMap = [
  "| From | To | Produces | Consumes |",
  "|------|----|----------|----------|",
  "| S01 | S02 | roadmap | plan |",
  "| S02 | S03 | plan | tasks |",
  "",
  "### S01 \u2192 S02",
  "",
  "- Produces: roadmap",
  "- Consumes: plan",
  "",
  "### S02 \u2192 S03",
  "",
  "- Produces: plan",
  "- Consumes: tasks"
].join("\n");
function planParams() {
  return {
    milestoneId: "M001",
    title: "Preserve Boundary Map",
    vision: "Roadmap survives projection hook.",
    successCriteria: ["Boundary Map section survives post-mutation hook"],
    keyRisks: [
      { risk: "Projection clobber", whyItMatters: "Authoritative roadmap would be overwritten." }
    ],
    proofStrategy: [
      { riskOrUnknown: "Roadmap overwrite", retireIn: "S01", whatWillBeProven: "ROADMAP.md still contains ## Boundary Map after plan-milestone." }
    ],
    verificationContract: "Contract check",
    verificationIntegration: "Integration check",
    verificationOperational: "Operational check",
    verificationUat: "UAT check",
    definitionOfDone: ["Regression test green"],
    requirementCoverage: "Covers #4402.",
    boundaryMapMarkdown: boundaryMap,
    slices: [
      {
        sliceId: "S01",
        title: "First",
        risk: "low",
        depends: [],
        demo: "demo 1",
        goal: "goal 1",
        successCriteria: "sc 1",
        proofLevel: "unit",
        integrationClosure: "ic 1",
        observabilityImpact: "oi 1"
      },
      {
        sliceId: "S02",
        title: "Second",
        risk: "low",
        depends: ["S01"],
        demo: "demo 2",
        goal: "goal 2",
        successCriteria: "sc 2",
        proofLevel: "unit",
        integrationClosure: "ic 2",
        observabilityImpact: "oi 2"
      },
      {
        sliceId: "S03",
        title: "Third",
        risk: "low",
        depends: ["S02"],
        demo: "demo 3",
        goal: "goal 3",
        successCriteria: "sc 3",
        proofLevel: "unit",
        integrationClosure: "ic 3",
        observabilityImpact: "oi 3"
      }
    ]
  };
}
test("#4402 plan-milestone preserves ## Boundary Map after post-mutation projections", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-4402-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  t.after(() => {
    try {
      closeDatabase();
    } catch {
    }
    rmSync(base, { recursive: true, force: true });
  });
  const result = await handlePlanMilestone(planParams(), base);
  assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
  const roadmapPath = join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md");
  assert.ok(existsSync(roadmapPath), "ROADMAP.md must exist on disk");
  const roadmap = readFileSync(roadmapPath, "utf-8");
  assert.match(
    roadmap,
    /^## Boundary Map$/m,
    "final on-disk ROADMAP.md must still contain the Boundary Map heading after projection hook"
  );
  assert.match(roadmap, /\| S01 \| S02 \| roadmap \| plan \|/, "boundary map row S01\u2192S02 must survive");
  assert.match(roadmap, /\| S02 \| S03 \| plan \| tasks \|/, "boundary map row S02\u2192S03 must survive");
  assert.match(roadmap, /^### S01 → S02$/m, "boundary map edge subsection S01\u2192S02 must survive");
  assert.match(roadmap, /^### S02 → S03$/m, "boundary map edge subsection S02\u2192S03 must survive");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wbGFuLW1pbGVzdG9uZS1ib3VuZGFyeS1tYXAtcHJlc2VydmF0aW9uLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0ZXN0IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgbWtkaXJTeW5jLCBybVN5bmMsIHJlYWRGaWxlU3luYywgZXhpc3RzU3luYyB9IGZyb20gJ25vZGU6ZnMnO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gJ25vZGU6cGF0aCc7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tICdub2RlOm9zJztcblxuaW1wb3J0IHsgb3BlbkRhdGFiYXNlLCBjbG9zZURhdGFiYXNlIH0gZnJvbSAnLi4vZ3NkLWRiLnRzJztcbmltcG9ydCB7IGhhbmRsZVBsYW5NaWxlc3RvbmUgfSBmcm9tICcuLi90b29scy9wbGFuLW1pbGVzdG9uZS50cyc7XG5cbmNvbnN0IGJvdW5kYXJ5TWFwID0gW1xuICAnfCBGcm9tIHwgVG8gfCBQcm9kdWNlcyB8IENvbnN1bWVzIHwnLFxuICAnfC0tLS0tLXwtLS0tfC0tLS0tLS0tLS18LS0tLS0tLS0tLXwnLFxuICAnfCBTMDEgfCBTMDIgfCByb2FkbWFwIHwgcGxhbiB8JyxcbiAgJ3wgUzAyIHwgUzAzIHwgcGxhbiB8IHRhc2tzIHwnLFxuICAnJyxcbiAgJyMjIyBTMDEgXHUyMTkyIFMwMicsXG4gICcnLFxuICAnLSBQcm9kdWNlczogcm9hZG1hcCcsXG4gICctIENvbnN1bWVzOiBwbGFuJyxcbiAgJycsXG4gICcjIyMgUzAyIFx1MjE5MiBTMDMnLFxuICAnJyxcbiAgJy0gUHJvZHVjZXM6IHBsYW4nLFxuICAnLSBDb25zdW1lczogdGFza3MnLFxuXS5qb2luKCdcXG4nKTtcblxuZnVuY3Rpb24gcGxhblBhcmFtcygpIHtcbiAgcmV0dXJuIHtcbiAgICBtaWxlc3RvbmVJZDogJ00wMDEnLFxuICAgIHRpdGxlOiAnUHJlc2VydmUgQm91bmRhcnkgTWFwJyxcbiAgICB2aXNpb246ICdSb2FkbWFwIHN1cnZpdmVzIHByb2plY3Rpb24gaG9vay4nLFxuICAgIHN1Y2Nlc3NDcml0ZXJpYTogWydCb3VuZGFyeSBNYXAgc2VjdGlvbiBzdXJ2aXZlcyBwb3N0LW11dGF0aW9uIGhvb2snXSxcbiAgICBrZXlSaXNrczogW1xuICAgICAgeyByaXNrOiAnUHJvamVjdGlvbiBjbG9iYmVyJywgd2h5SXRNYXR0ZXJzOiAnQXV0aG9yaXRhdGl2ZSByb2FkbWFwIHdvdWxkIGJlIG92ZXJ3cml0dGVuLicgfSxcbiAgICBdLFxuICAgIHByb29mU3RyYXRlZ3k6IFtcbiAgICAgIHsgcmlza09yVW5rbm93bjogJ1JvYWRtYXAgb3ZlcndyaXRlJywgcmV0aXJlSW46ICdTMDEnLCB3aGF0V2lsbEJlUHJvdmVuOiAnUk9BRE1BUC5tZCBzdGlsbCBjb250YWlucyAjIyBCb3VuZGFyeSBNYXAgYWZ0ZXIgcGxhbi1taWxlc3RvbmUuJyB9LFxuICAgIF0sXG4gICAgdmVyaWZpY2F0aW9uQ29udHJhY3Q6ICdDb250cmFjdCBjaGVjaycsXG4gICAgdmVyaWZpY2F0aW9uSW50ZWdyYXRpb246ICdJbnRlZ3JhdGlvbiBjaGVjaycsXG4gICAgdmVyaWZpY2F0aW9uT3BlcmF0aW9uYWw6ICdPcGVyYXRpb25hbCBjaGVjaycsXG4gICAgdmVyaWZpY2F0aW9uVWF0OiAnVUFUIGNoZWNrJyxcbiAgICBkZWZpbml0aW9uT2ZEb25lOiBbJ1JlZ3Jlc3Npb24gdGVzdCBncmVlbiddLFxuICAgIHJlcXVpcmVtZW50Q292ZXJhZ2U6ICdDb3ZlcnMgIzQ0MDIuJyxcbiAgICBib3VuZGFyeU1hcE1hcmtkb3duOiBib3VuZGFyeU1hcCxcbiAgICBzbGljZXM6IFtcbiAgICAgIHtcbiAgICAgICAgc2xpY2VJZDogJ1MwMScsXG4gICAgICAgIHRpdGxlOiAnRmlyc3QnLFxuICAgICAgICByaXNrOiAnbG93JyxcbiAgICAgICAgZGVwZW5kczogW10gYXMgc3RyaW5nW10sXG4gICAgICAgIGRlbW86ICdkZW1vIDEnLFxuICAgICAgICBnb2FsOiAnZ29hbCAxJyxcbiAgICAgICAgc3VjY2Vzc0NyaXRlcmlhOiAnc2MgMScsXG4gICAgICAgIHByb29mTGV2ZWw6ICd1bml0JyxcbiAgICAgICAgaW50ZWdyYXRpb25DbG9zdXJlOiAnaWMgMScsXG4gICAgICAgIG9ic2VydmFiaWxpdHlJbXBhY3Q6ICdvaSAxJyxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIHNsaWNlSWQ6ICdTMDInLFxuICAgICAgICB0aXRsZTogJ1NlY29uZCcsXG4gICAgICAgIHJpc2s6ICdsb3cnLFxuICAgICAgICBkZXBlbmRzOiBbJ1MwMSddLFxuICAgICAgICBkZW1vOiAnZGVtbyAyJyxcbiAgICAgICAgZ29hbDogJ2dvYWwgMicsXG4gICAgICAgIHN1Y2Nlc3NDcml0ZXJpYTogJ3NjIDInLFxuICAgICAgICBwcm9vZkxldmVsOiAndW5pdCcsXG4gICAgICAgIGludGVncmF0aW9uQ2xvc3VyZTogJ2ljIDInLFxuICAgICAgICBvYnNlcnZhYmlsaXR5SW1wYWN0OiAnb2kgMicsXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBzbGljZUlkOiAnUzAzJyxcbiAgICAgICAgdGl0bGU6ICdUaGlyZCcsXG4gICAgICAgIHJpc2s6ICdsb3cnLFxuICAgICAgICBkZXBlbmRzOiBbJ1MwMiddLFxuICAgICAgICBkZW1vOiAnZGVtbyAzJyxcbiAgICAgICAgZ29hbDogJ2dvYWwgMycsXG4gICAgICAgIHN1Y2Nlc3NDcml0ZXJpYTogJ3NjIDMnLFxuICAgICAgICBwcm9vZkxldmVsOiAndW5pdCcsXG4gICAgICAgIGludGVncmF0aW9uQ2xvc3VyZTogJ2ljIDMnLFxuICAgICAgICBvYnNlcnZhYmlsaXR5SW1wYWN0OiAnb2kgMycsXG4gICAgICB9LFxuICAgIF0sXG4gIH07XG59XG5cbnRlc3QoJyM0NDAyIHBsYW4tbWlsZXN0b25lIHByZXNlcnZlcyAjIyBCb3VuZGFyeSBNYXAgYWZ0ZXIgcG9zdC1tdXRhdGlvbiBwcm9qZWN0aW9ucycsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCAnZ3NkLTQ0MDItJykpO1xuICBta2RpclN5bmMoam9pbihiYXNlLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgJ00wMDEnKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsICcuZ3NkJywgJ2dzZC5kYicpKTtcblxuICB0LmFmdGVyKCgpID0+IHtcbiAgICB0cnkgeyBjbG9zZURhdGFiYXNlKCk7IH0gY2F0Y2ggeyAvKiBub29wICovIH1cbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVQbGFuTWlsZXN0b25lKHBsYW5QYXJhbXMoKSwgYmFzZSk7XG4gIGFzc2VydC5vayghKCdlcnJvcicgaW4gcmVzdWx0KSwgYHVuZXhwZWN0ZWQgZXJyb3I6ICR7J2Vycm9yJyBpbiByZXN1bHQgPyByZXN1bHQuZXJyb3IgOiAnJ31gKTtcblxuICBjb25zdCByb2FkbWFwUGF0aCA9IGpvaW4oYmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAxJywgJ00wMDEtUk9BRE1BUC5tZCcpO1xuICBhc3NlcnQub2soZXhpc3RzU3luYyhyb2FkbWFwUGF0aCksICdST0FETUFQLm1kIG11c3QgZXhpc3Qgb24gZGlzaycpO1xuXG4gIGNvbnN0IHJvYWRtYXAgPSByZWFkRmlsZVN5bmMocm9hZG1hcFBhdGgsICd1dGYtOCcpO1xuXG4gIGFzc2VydC5tYXRjaChcbiAgICByb2FkbWFwLFxuICAgIC9eIyMgQm91bmRhcnkgTWFwJC9tLFxuICAgICdmaW5hbCBvbi1kaXNrIFJPQURNQVAubWQgbXVzdCBzdGlsbCBjb250YWluIHRoZSBCb3VuZGFyeSBNYXAgaGVhZGluZyBhZnRlciBwcm9qZWN0aW9uIGhvb2snLFxuICApO1xuICBhc3NlcnQubWF0Y2gocm9hZG1hcCwgL1xcfCBTMDEgXFx8IFMwMiBcXHwgcm9hZG1hcCBcXHwgcGxhbiBcXHwvLCAnYm91bmRhcnkgbWFwIHJvdyBTMDFcdTIxOTJTMDIgbXVzdCBzdXJ2aXZlJyk7XG4gIGFzc2VydC5tYXRjaChyb2FkbWFwLCAvXFx8IFMwMiBcXHwgUzAzIFxcfCBwbGFuIFxcfCB0YXNrcyBcXHwvLCAnYm91bmRhcnkgbWFwIHJvdyBTMDJcdTIxOTJTMDMgbXVzdCBzdXJ2aXZlJyk7XG4gIGFzc2VydC5tYXRjaChyb2FkbWFwLCAvXiMjIyBTMDEgXHUyMTkyIFMwMiQvbSwgJ2JvdW5kYXJ5IG1hcCBlZGdlIHN1YnNlY3Rpb24gUzAxXHUyMTkyUzAyIG11c3Qgc3Vydml2ZScpO1xuICBhc3NlcnQubWF0Y2gocm9hZG1hcCwgL14jIyMgUzAyIFx1MjE5MiBTMDMkL20sICdib3VuZGFyeSBtYXAgZWRnZSBzdWJzZWN0aW9uIFMwMlx1MjE5MlMwMyBtdXN0IHN1cnZpdmUnKTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUNuQixTQUFTLGFBQWEsV0FBVyxRQUFRLGNBQWMsa0JBQWtCO0FBQ3pFLFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFFdkIsU0FBUyxjQUFjLHFCQUFxQjtBQUM1QyxTQUFTLDJCQUEyQjtBQUVwQyxNQUFNLGNBQWM7QUFBQSxFQUNsQjtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFDRixFQUFFLEtBQUssSUFBSTtBQUVYLFNBQVMsYUFBYTtBQUNwQixTQUFPO0FBQUEsSUFDTCxhQUFhO0FBQUEsSUFDYixP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
