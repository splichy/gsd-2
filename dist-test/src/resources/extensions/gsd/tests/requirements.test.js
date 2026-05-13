import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { parseRequirementCounts } from "../files.js";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveState } from "../state.js";
import { runGSDDoctor } from "../doctor.js";
describe("requirements", () => {
  test("requirement counts parser", () => {
    const counts = parseRequirementCounts(`# Requirements

## Active

### R001 \u2014 Foo
- Status: active

### R002 \u2014 Bar
- Status: blocked

## Validated

### R010 \u2014 Baz
- Status: validated

## Deferred

### R020 \u2014 Qux
- Status: deferred

## Out of Scope

### R030 \u2014 No
- Status: out-of-scope
`);
    assert.deepStrictEqual(counts.active, 2, "counts active requirements by section");
    assert.deepStrictEqual(counts.validated, 1, "counts validated requirements");
    assert.deepStrictEqual(counts.deferred, 1, "counts deferred requirements");
    assert.deepStrictEqual(counts.outOfScope, 1, "counts out of scope requirements");
    assert.deepStrictEqual(counts.blocked, 1, "counts blocked statuses");
  });
  const base = mkdtempSync(join(tmpdir(), "gsd-requirements-test-"));
  const gsd = join(base, ".gsd");
  const mDir = join(gsd, "milestones", "M001");
  const sDir = join(mDir, "slices", "S01");
  const tDir = join(sDir, "tasks");
  mkdirSync(tDir, { recursive: true });
  writeFileSync(join(gsd, "REQUIREMENTS.md"), [
    "# Requirements",
    "## Active",
    "### R001 \u2014 Missing owner",
    "- Class: core-capability",
    "- Status: active",
    "- Description: thing",
    "- Why it matters: thing",
    "- Source: user",
    "- Primary owning slice: none yet",
    "- Supporting slices: none",
    "- Validation: unmapped",
    "- Notes: none",
    "## Validated",
    "## Deferred",
    "## Out of Scope",
    "## Traceability",
    ""
  ].join("\n"), "utf-8");
  writeFileSync(join(mDir, "M001-ROADMAP.md"), [
    "# M001: Demo",
    "## Slices",
    "- [ ] **S01: Demo Slice** `risk:low` `depends:[]`",
    "  > After this: demo works",
    ""
  ].join("\n"), "utf-8");
  writeFileSync(join(sDir, "S01-PLAN.md"), [
    "# S01: Demo Slice",
    "**Goal:** Demo",
    "**Demo:** Demo",
    "## Must-Haves",
    "- done",
    "## Tasks",
    "- [ ] **T01: Implement thing** `est:10m`",
    "  Task is in progress.",
    ""
  ].join("\n"), "utf-8");
  test("deriveState includes requirements counts", async () => {
    const state = await deriveState(base);
    assert.ok(state.requirements !== void 0, "state includes requirements summary");
    assert.deepStrictEqual(state.requirements?.active, 1, "state reports active requirement count");
  });
  test("doctor flags orphaned active requirement", async () => {
    const report = await runGSDDoctor(base);
    assert.ok(report.issues.some((issue) => issue.code === "active_requirement_missing_owner"), "doctor flags missing owner");
  });
  test("#4414: active_requirement_missing_owner is a warning, not an error", async () => {
    const report = await runGSDDoctor(base);
    const issue = report.issues.find((i) => i.code === "active_requirement_missing_owner");
    assert.ok(issue, "issue is present");
    assert.equal(issue.severity, "warning", "severity downgraded so doctor report.ok is not flipped to false");
  });
  after(() => {
    rmSync(base, { recursive: true, force: true });
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9yZXF1aXJlbWVudHMudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QsIGFmdGVyIH0gZnJvbSAnbm9kZTp0ZXN0JztcbmltcG9ydCBhc3NlcnQgZnJvbSAnbm9kZTphc3NlcnQvc3RyaWN0JztcbmltcG9ydCB7IHBhcnNlUmVxdWlyZW1lbnRDb3VudHMgfSBmcm9tIFwiLi4vZmlsZXMudHNcIjtcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBta2RpclN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGRlcml2ZVN0YXRlIH0gZnJvbSBcIi4uL3N0YXRlLnRzXCI7XG5pbXBvcnQgeyBydW5HU0REb2N0b3IgfSBmcm9tIFwiLi4vZG9jdG9yLnRzXCI7XG5cbmRlc2NyaWJlKCdyZXF1aXJlbWVudHMnLCAoKSA9PiB7XG4gIHRlc3QoJ3JlcXVpcmVtZW50IGNvdW50cyBwYXJzZXInLCAoKSA9PiB7XG4gICAgY29uc3QgY291bnRzID0gcGFyc2VSZXF1aXJlbWVudENvdW50cyhgIyBSZXF1aXJlbWVudHNcblxuIyMgQWN0aXZlXG5cbiMjIyBSMDAxIFx1MjAxNCBGb29cbi0gU3RhdHVzOiBhY3RpdmVcblxuIyMjIFIwMDIgXHUyMDE0IEJhclxuLSBTdGF0dXM6IGJsb2NrZWRcblxuIyMgVmFsaWRhdGVkXG5cbiMjIyBSMDEwIFx1MjAxNCBCYXpcbi0gU3RhdHVzOiB2YWxpZGF0ZWRcblxuIyMgRGVmZXJyZWRcblxuIyMjIFIwMjAgXHUyMDE0IFF1eFxuLSBTdGF0dXM6IGRlZmVycmVkXG5cbiMjIE91dCBvZiBTY29wZVxuXG4jIyMgUjAzMCBcdTIwMTQgTm9cbi0gU3RhdHVzOiBvdXQtb2Ytc2NvcGVcbmApO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoY291bnRzLmFjdGl2ZSwgMiwgXCJjb3VudHMgYWN0aXZlIHJlcXVpcmVtZW50cyBieSBzZWN0aW9uXCIpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoY291bnRzLnZhbGlkYXRlZCwgMSwgXCJjb3VudHMgdmFsaWRhdGVkIHJlcXVpcmVtZW50c1wiKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGNvdW50cy5kZWZlcnJlZCwgMSwgXCJjb3VudHMgZGVmZXJyZWQgcmVxdWlyZW1lbnRzXCIpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoY291bnRzLm91dE9mU2NvcGUsIDEsIFwiY291bnRzIG91dCBvZiBzY29wZSByZXF1aXJlbWVudHNcIik7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChjb3VudHMuYmxvY2tlZCwgMSwgXCJjb3VudHMgYmxvY2tlZCBzdGF0dXNlc1wiKTtcbiAgfSk7XG5cbiAgY29uc3QgYmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXJlcXVpcmVtZW50cy10ZXN0LVwiKSk7XG4gIGNvbnN0IGdzZCA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIpO1xuICBjb25zdCBtRGlyID0gam9pbihnc2QsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIik7XG4gIGNvbnN0IHNEaXIgPSBqb2luKG1EaXIsIFwic2xpY2VzXCIsIFwiUzAxXCIpO1xuICBjb25zdCB0RGlyID0gam9pbihzRGlyLCBcInRhc2tzXCIpO1xuICBta2RpclN5bmModERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihnc2QsIFwiUkVRVUlSRU1FTlRTLm1kXCIpLCBbXG4gICAgXCIjIFJlcXVpcmVtZW50c1wiLFxuICAgIFwiIyMgQWN0aXZlXCIsXG4gICAgXCIjIyMgUjAwMSBcdTIwMTQgTWlzc2luZyBvd25lclwiLFxuICAgIFwiLSBDbGFzczogY29yZS1jYXBhYmlsaXR5XCIsXG4gICAgXCItIFN0YXR1czogYWN0aXZlXCIsXG4gICAgXCItIERlc2NyaXB0aW9uOiB0aGluZ1wiLFxuICAgIFwiLSBXaHkgaXQgbWF0dGVyczogdGhpbmdcIixcbiAgICBcIi0gU291cmNlOiB1c2VyXCIsXG4gICAgXCItIFByaW1hcnkgb3duaW5nIHNsaWNlOiBub25lIHlldFwiLFxuICAgIFwiLSBTdXBwb3J0aW5nIHNsaWNlczogbm9uZVwiLFxuICAgIFwiLSBWYWxpZGF0aW9uOiB1bm1hcHBlZFwiLFxuICAgIFwiLSBOb3Rlczogbm9uZVwiLFxuICAgIFwiIyMgVmFsaWRhdGVkXCIsXG4gICAgXCIjIyBEZWZlcnJlZFwiLFxuICAgIFwiIyMgT3V0IG9mIFNjb3BlXCIsXG4gICAgXCIjIyBUcmFjZWFiaWxpdHlcIixcbiAgICBcIlwiLFxuICBdLmpvaW4oXCJcXG5cIiksIFwidXRmLThcIik7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihtRGlyLCBcIk0wMDEtUk9BRE1BUC5tZFwiKSwgW1xuICAgIFwiIyBNMDAxOiBEZW1vXCIsXG4gICAgXCIjIyBTbGljZXNcIixcbiAgICBcIi0gWyBdICoqUzAxOiBEZW1vIFNsaWNlKiogYHJpc2s6bG93YCBgZGVwZW5kczpbXWBcIixcbiAgICBcIiAgPiBBZnRlciB0aGlzOiBkZW1vIHdvcmtzXCIsXG4gICAgXCJcIixcbiAgXS5qb2luKFwiXFxuXCIpLCBcInV0Zi04XCIpO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oc0RpciwgXCJTMDEtUExBTi5tZFwiKSwgW1xuICAgIFwiIyBTMDE6IERlbW8gU2xpY2VcIixcbiAgICBcIioqR29hbDoqKiBEZW1vXCIsXG4gICAgXCIqKkRlbW86KiogRGVtb1wiLFxuICAgIFwiIyMgTXVzdC1IYXZlc1wiLFxuICAgIFwiLSBkb25lXCIsXG4gICAgXCIjIyBUYXNrc1wiLFxuICAgIFwiLSBbIF0gKipUMDE6IEltcGxlbWVudCB0aGluZyoqIGBlc3Q6MTBtYFwiLFxuICAgIFwiICBUYXNrIGlzIGluIHByb2dyZXNzLlwiLFxuICAgIFwiXCIsXG4gIF0uam9pbihcIlxcblwiKSwgXCJ1dGYtOFwiKTtcbiAgdGVzdCgnZGVyaXZlU3RhdGUgaW5jbHVkZXMgcmVxdWlyZW1lbnRzIGNvdW50cycsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuICAgIGFzc2VydC5vayhzdGF0ZS5yZXF1aXJlbWVudHMgIT09IHVuZGVmaW5lZCwgXCJzdGF0ZSBpbmNsdWRlcyByZXF1aXJlbWVudHMgc3VtbWFyeVwiKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnJlcXVpcmVtZW50cz8uYWN0aXZlLCAxLCBcInN0YXRlIHJlcG9ydHMgYWN0aXZlIHJlcXVpcmVtZW50IGNvdW50XCIpO1xuICB9KTtcblxuICB0ZXN0KCdkb2N0b3IgZmxhZ3Mgb3JwaGFuZWQgYWN0aXZlIHJlcXVpcmVtZW50JywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHJlcG9ydCA9IGF3YWl0IHJ1bkdTRERvY3RvcihiYXNlKTtcbiAgICBhc3NlcnQub2socmVwb3J0Lmlzc3Vlcy5zb21lKGlzc3VlID0+IGlzc3VlLmNvZGUgPT09IFwiYWN0aXZlX3JlcXVpcmVtZW50X21pc3Npbmdfb3duZXJcIiksIFwiZG9jdG9yIGZsYWdzIG1pc3Npbmcgb3duZXJcIik7XG4gIH0pO1xuXG4gIC8vICM0NDE0OiBhY3RpdmVfcmVxdWlyZW1lbnRfbWlzc2luZ19vd25lciBpcyBhIHBsYW5uaW5nLWh5Z2llbmUgc2lnbmFsLFxuICAvLyBub3QgYSBjb3JyZWN0bmVzcyBibG9ja2VyIFx1MjAxNCBzZXZlcml0eSBtdXN0IGJlIHdhcm5pbmcsIG5vdCBlcnJvci5cbiAgdGVzdCgnIzQ0MTQ6IGFjdGl2ZV9yZXF1aXJlbWVudF9taXNzaW5nX293bmVyIGlzIGEgd2FybmluZywgbm90IGFuIGVycm9yJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHJlcG9ydCA9IGF3YWl0IHJ1bkdTRERvY3RvcihiYXNlKTtcbiAgICBjb25zdCBpc3N1ZSA9IHJlcG9ydC5pc3N1ZXMuZmluZChpID0+IGkuY29kZSA9PT0gXCJhY3RpdmVfcmVxdWlyZW1lbnRfbWlzc2luZ19vd25lclwiKTtcbiAgICBhc3NlcnQub2soaXNzdWUsIFwiaXNzdWUgaXMgcHJlc2VudFwiKTtcbiAgICBhc3NlcnQuZXF1YWwoaXNzdWUhLnNldmVyaXR5LCBcIndhcm5pbmdcIiwgXCJzZXZlcml0eSBkb3duZ3JhZGVkIHNvIGRvY3RvciByZXBvcnQub2sgaXMgbm90IGZsaXBwZWQgdG8gZmFsc2VcIik7XG4gIH0pO1xuXG4gIGFmdGVyKCgpID0+IHtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxVQUFVLE1BQU0sYUFBYTtBQUN0QyxPQUFPLFlBQVk7QUFDbkIsU0FBUyw4QkFBOEI7QUFDdkMsU0FBUyxhQUFhLFdBQVcsUUFBUSxxQkFBcUI7QUFDOUQsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUN2QixTQUFTLG1CQUFtQjtBQUM1QixTQUFTLG9CQUFvQjtBQUU3QixTQUFTLGdCQUFnQixNQUFNO0FBQzdCLE9BQUssNkJBQTZCLE1BQU07QUFDdEMsVUFBTSxTQUFTLHVCQUF1QjtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxDQXdCekM7QUFDRyxXQUFPLGdCQUFnQixPQUFPLFFBQVEsR0FBRyx1Q0FBdUM7QUFDaEYsV0FBTyxnQkFBZ0IsT0FBTyxXQUFXLEdBQUcsK0JBQStCO0FBQzNFLFdBQU8sZ0JBQWdCLE9BQU8sVUFBVSxHQUFHLDhCQUE4QjtBQUN6RSxXQUFPLGdCQUFnQixPQUFPLFlBQVksR0FBRyxrQ0FBa0M7QUFDL0UsV0FBTyxnQkFBZ0IsT0FBTyxTQUFTLEdBQUcseUJBQXlCO0FBQUEsRUFDckUsQ0FBQztBQUVELFFBQU0sT0FBTyxZQUFZLEtBQUssT0FBTyxHQUFHLHdCQUF3QixDQUFDO0FBQ2pFLFFBQU0sTUFBTSxLQUFLLE1BQU0sTUFBTTtBQUM3QixRQUFNLE9BQU8sS0FBSyxLQUFLLGNBQWMsTUFBTTtBQUMzQyxRQUFNLE9BQU8sS0FBSyxNQUFNLFVBQVUsS0FBSztBQUN2QyxRQUFNLE9BQU8sS0FBSyxNQUFNLE9BQU87QUFDL0IsWUFBVSxNQUFNLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDbkMsZ0JBQWMsS0FBSyxLQUFLLGlCQUFpQixHQUFHO0FBQUEsSUFDMUM7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsRUFDRixFQUFFLEtBQUssSUFBSSxHQUFHLE9BQU87QUFDckIsZ0JBQWMsS0FBSyxNQUFNLGlCQUFpQixHQUFHO0FBQUEsSUFDM0M7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsRUFDRixFQUFFLEtBQUssSUFBSSxHQUFHLE9BQU87QUFDckIsZ0JBQWMsS0FBSyxNQUFNLGFBQWEsR0FBRztBQUFBLElBQ3ZDO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxFQUNGLEVBQUUsS0FBSyxJQUFJLEdBQUcsT0FBTztBQUNyQixPQUFLLDRDQUE0QyxZQUFZO0FBQzNELFVBQU0sUUFBUSxNQUFNLFlBQVksSUFBSTtBQUNwQyxXQUFPLEdBQUcsTUFBTSxpQkFBaUIsUUFBVyxxQ0FBcUM7QUFDakYsV0FBTyxnQkFBZ0IsTUFBTSxjQUFjLFFBQVEsR0FBRyx3Q0FBd0M7QUFBQSxFQUNoRyxDQUFDO0FBRUQsT0FBSyw0Q0FBNEMsWUFBWTtBQUMzRCxVQUFNLFNBQVMsTUFBTSxhQUFhLElBQUk7QUFDdEMsV0FBTyxHQUFHLE9BQU8sT0FBTyxLQUFLLFdBQVMsTUFBTSxTQUFTLGtDQUFrQyxHQUFHLDRCQUE0QjtBQUFBLEVBQ3hILENBQUM7QUFJRCxPQUFLLHNFQUFzRSxZQUFZO0FBQ3JGLFVBQU0sU0FBUyxNQUFNLGFBQWEsSUFBSTtBQUN0QyxVQUFNLFFBQVEsT0FBTyxPQUFPLEtBQUssT0FBSyxFQUFFLFNBQVMsa0NBQWtDO0FBQ25GLFdBQU8sR0FBRyxPQUFPLGtCQUFrQjtBQUNuQyxXQUFPLE1BQU0sTUFBTyxVQUFVLFdBQVcsaUVBQWlFO0FBQUEsRUFDNUcsQ0FBQztBQUVELFFBQU0sTUFBTTtBQUNWLFdBQU8sTUFBTSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLEVBQy9DLENBQUM7QUFDSCxDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
