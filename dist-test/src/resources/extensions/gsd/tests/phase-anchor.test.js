import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writePhaseAnchor, readPhaseAnchor, formatAnchorForPrompt } from "../phase-anchor.js";
function makeTempBase() {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-anchor-test-"));
  mkdirSync(join(tmp, ".gsd", "milestones", "M001", "anchors"), { recursive: true });
  return tmp;
}
test("writePhaseAnchor creates anchor file in correct location", () => {
  const base = makeTempBase();
  try {
    const anchor = {
      phase: "discuss",
      milestoneId: "M001",
      generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      intent: "Define authentication requirements",
      decisions: ["Use JWT tokens", "Session expiry 24h"],
      blockers: [],
      nextSteps: ["Plan the implementation slices"]
    };
    writePhaseAnchor(base, "M001", anchor);
    assert.ok(existsSync(join(base, ".gsd", "milestones", "M001", "anchors", "discuss.json")));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("readPhaseAnchor returns written anchor", () => {
  const base = makeTempBase();
  try {
    const anchor = {
      phase: "plan",
      milestoneId: "M001",
      generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      intent: "Break work into slices",
      decisions: ["3 slices: auth, UI, tests"],
      blockers: ["Need DB schema first"],
      nextSteps: ["Execute S01"]
    };
    writePhaseAnchor(base, "M001", anchor);
    const read = readPhaseAnchor(base, "M001", "plan");
    assert.ok(read);
    assert.equal(read.intent, "Break work into slices");
    assert.deepEqual(read.decisions, ["3 slices: auth, UI, tests"]);
    assert.deepEqual(read.blockers, ["Need DB schema first"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("readPhaseAnchor returns null when no anchor exists", () => {
  const base = makeTempBase();
  try {
    const read = readPhaseAnchor(base, "M001", "discuss");
    assert.equal(read, null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("formatAnchorForPrompt produces markdown block", () => {
  const anchor = {
    phase: "discuss",
    milestoneId: "M001",
    generatedAt: "2026-04-03T00:00:00.000Z",
    intent: "Define requirements",
    decisions: ["Use JWT"],
    blockers: [],
    nextSteps: ["Plan slices"]
  };
  const md = formatAnchorForPrompt(anchor);
  assert.ok(md.includes("## Handoff from discuss"));
  assert.ok(md.includes("Define requirements"));
  assert.ok(md.includes("Use JWT"));
  assert.ok(md.includes("Plan slices"));
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9waGFzZS1hbmNob3IudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgbWtkaXJTeW5jLCBybVN5bmMsIGV4aXN0c1N5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5cbmltcG9ydCB7IHdyaXRlUGhhc2VBbmNob3IsIHJlYWRQaGFzZUFuY2hvciwgZm9ybWF0QW5jaG9yRm9yUHJvbXB0IH0gZnJvbSBcIi4uL3BoYXNlLWFuY2hvci5qc1wiO1xuaW1wb3J0IHR5cGUgeyBQaGFzZUFuY2hvciB9IGZyb20gXCIuLi9waGFzZS1hbmNob3IuanNcIjtcblxuZnVuY3Rpb24gbWFrZVRlbXBCYXNlKCk6IHN0cmluZyB7XG4gIGNvbnN0IHRtcCA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLWFuY2hvci10ZXN0LVwiKSk7XG4gIG1rZGlyU3luYyhqb2luKHRtcCwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJhbmNob3JzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgcmV0dXJuIHRtcDtcbn1cblxudGVzdChcIndyaXRlUGhhc2VBbmNob3IgY3JlYXRlcyBhbmNob3IgZmlsZSBpbiBjb3JyZWN0IGxvY2F0aW9uXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUZW1wQmFzZSgpO1xuICB0cnkge1xuICAgIGNvbnN0IGFuY2hvcjogUGhhc2VBbmNob3IgPSB7XG4gICAgICBwaGFzZTogXCJkaXNjdXNzXCIsXG4gICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICBnZW5lcmF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgaW50ZW50OiBcIkRlZmluZSBhdXRoZW50aWNhdGlvbiByZXF1aXJlbWVudHNcIixcbiAgICAgIGRlY2lzaW9uczogW1wiVXNlIEpXVCB0b2tlbnNcIiwgXCJTZXNzaW9uIGV4cGlyeSAyNGhcIl0sXG4gICAgICBibG9ja2VyczogW10sXG4gICAgICBuZXh0U3RlcHM6IFtcIlBsYW4gdGhlIGltcGxlbWVudGF0aW9uIHNsaWNlc1wiXSxcbiAgICB9O1xuICAgIHdyaXRlUGhhc2VBbmNob3IoYmFzZSwgXCJNMDAxXCIsIGFuY2hvcik7XG4gICAgYXNzZXJ0Lm9rKGV4aXN0c1N5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcImFuY2hvcnNcIiwgXCJkaXNjdXNzLmpzb25cIikpKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcInJlYWRQaGFzZUFuY2hvciByZXR1cm5zIHdyaXR0ZW4gYW5jaG9yXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUZW1wQmFzZSgpO1xuICB0cnkge1xuICAgIGNvbnN0IGFuY2hvcjogUGhhc2VBbmNob3IgPSB7XG4gICAgICBwaGFzZTogXCJwbGFuXCIsXG4gICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICBnZW5lcmF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgaW50ZW50OiBcIkJyZWFrIHdvcmsgaW50byBzbGljZXNcIixcbiAgICAgIGRlY2lzaW9uczogW1wiMyBzbGljZXM6IGF1dGgsIFVJLCB0ZXN0c1wiXSxcbiAgICAgIGJsb2NrZXJzOiBbXCJOZWVkIERCIHNjaGVtYSBmaXJzdFwiXSxcbiAgICAgIG5leHRTdGVwczogW1wiRXhlY3V0ZSBTMDFcIl0sXG4gICAgfTtcbiAgICB3cml0ZVBoYXNlQW5jaG9yKGJhc2UsIFwiTTAwMVwiLCBhbmNob3IpO1xuICAgIGNvbnN0IHJlYWQgPSByZWFkUGhhc2VBbmNob3IoYmFzZSwgXCJNMDAxXCIsIFwicGxhblwiKTtcbiAgICBhc3NlcnQub2socmVhZCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlYWQhLmludGVudCwgXCJCcmVhayB3b3JrIGludG8gc2xpY2VzXCIpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwocmVhZCEuZGVjaXNpb25zLCBbXCIzIHNsaWNlczogYXV0aCwgVUksIHRlc3RzXCJdKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHJlYWQhLmJsb2NrZXJzLCBbXCJOZWVkIERCIHNjaGVtYSBmaXJzdFwiXSk7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJyZWFkUGhhc2VBbmNob3IgcmV0dXJucyBudWxsIHdoZW4gbm8gYW5jaG9yIGV4aXN0c1wiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVGVtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICBjb25zdCByZWFkID0gcmVhZFBoYXNlQW5jaG9yKGJhc2UsIFwiTTAwMVwiLCBcImRpc2N1c3NcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlYWQsIG51bGwpO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZm9ybWF0QW5jaG9yRm9yUHJvbXB0IHByb2R1Y2VzIG1hcmtkb3duIGJsb2NrXCIsICgpID0+IHtcbiAgY29uc3QgYW5jaG9yOiBQaGFzZUFuY2hvciA9IHtcbiAgICBwaGFzZTogXCJkaXNjdXNzXCIsXG4gICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgIGdlbmVyYXRlZEF0OiBcIjIwMjYtMDQtMDNUMDA6MDA6MDAuMDAwWlwiLFxuICAgIGludGVudDogXCJEZWZpbmUgcmVxdWlyZW1lbnRzXCIsXG4gICAgZGVjaXNpb25zOiBbXCJVc2UgSldUXCJdLFxuICAgIGJsb2NrZXJzOiBbXSxcbiAgICBuZXh0U3RlcHM6IFtcIlBsYW4gc2xpY2VzXCJdLFxuICB9O1xuICBjb25zdCBtZCA9IGZvcm1hdEFuY2hvckZvclByb21wdChhbmNob3IpO1xuICBhc3NlcnQub2sobWQuaW5jbHVkZXMoXCIjIyBIYW5kb2ZmIGZyb20gZGlzY3Vzc1wiKSk7XG4gIGFzc2VydC5vayhtZC5pbmNsdWRlcyhcIkRlZmluZSByZXF1aXJlbWVudHNcIikpO1xuICBhc3NlcnQub2sobWQuaW5jbHVkZXMoXCJVc2UgSldUXCIpKTtcbiAgYXNzZXJ0Lm9rKG1kLmluY2x1ZGVzKFwiUGxhbiBzbGljZXNcIikpO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxXQUFXLFFBQVEsa0JBQWtCO0FBQzNELFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFFdkIsU0FBUyxrQkFBa0IsaUJBQWlCLDZCQUE2QjtBQUd6RSxTQUFTLGVBQXVCO0FBQzlCLFFBQU0sTUFBTSxZQUFZLEtBQUssT0FBTyxHQUFHLGtCQUFrQixDQUFDO0FBQzFELFlBQVUsS0FBSyxLQUFLLFFBQVEsY0FBYyxRQUFRLFNBQVMsR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ2pGLFNBQU87QUFDVDtBQUVBLEtBQUssNERBQTRELE1BQU07QUFDckUsUUFBTSxPQUFPLGFBQWE7QUFDMUIsTUFBSTtBQUNGLFVBQU0sU0FBc0I7QUFBQSxNQUMxQixPQUFPO0FBQUEsTUFDUCxhQUFhO0FBQUEsTUFDYixjQUFhLG9CQUFJLEtBQUssR0FBRSxZQUFZO0FBQUEsTUFDcEMsUUFBUTtBQUFBLE1BQ1IsV0FBVyxDQUFDLGtCQUFrQixvQkFBb0I7QUFBQSxNQUNsRCxVQUFVLENBQUM7QUFBQSxNQUNYLFdBQVcsQ0FBQyxnQ0FBZ0M7QUFBQSxJQUM5QztBQUNBLHFCQUFpQixNQUFNLFFBQVEsTUFBTTtBQUNyQyxXQUFPLEdBQUcsV0FBVyxLQUFLLE1BQU0sUUFBUSxjQUFjLFFBQVEsV0FBVyxjQUFjLENBQUMsQ0FBQztBQUFBLEVBQzNGLFVBQUU7QUFDQSxXQUFPLE1BQU0sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUMvQztBQUNGLENBQUM7QUFFRCxLQUFLLDBDQUEwQyxNQUFNO0FBQ25ELFFBQU0sT0FBTyxhQUFhO0FBQzFCLE1BQUk7QUFDRixVQUFNLFNBQXNCO0FBQUEsTUFDMUIsT0FBTztBQUFBLE1BQ1AsYUFBYTtBQUFBLE1BQ2IsY0FBYSxvQkFBSSxLQUFLLEdBQUUsWUFBWTtBQUFBLE1BQ3BDLFFBQVE7QUFBQSxNQUNSLFdBQVcsQ0FBQywyQkFBMkI7QUFBQSxNQUN2QyxVQUFVLENBQUMsc0JBQXNCO0FBQUEsTUFDakMsV0FBVyxDQUFDLGFBQWE7QUFBQSxJQUMzQjtBQUNBLHFCQUFpQixNQUFNLFFBQVEsTUFBTTtBQUNyQyxVQUFNLE9BQU8sZ0JBQWdCLE1BQU0sUUFBUSxNQUFNO0FBQ2pELFdBQU8sR0FBRyxJQUFJO0FBQ2QsV0FBTyxNQUFNLEtBQU0sUUFBUSx3QkFBd0I7QUFDbkQsV0FBTyxVQUFVLEtBQU0sV0FBVyxDQUFDLDJCQUEyQixDQUFDO0FBQy9ELFdBQU8sVUFBVSxLQUFNLFVBQVUsQ0FBQyxzQkFBc0IsQ0FBQztBQUFBLEVBQzNELFVBQUU7QUFDQSxXQUFPLE1BQU0sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUMvQztBQUNGLENBQUM7QUFFRCxLQUFLLHNEQUFzRCxNQUFNO0FBQy9ELFFBQU0sT0FBTyxhQUFhO0FBQzFCLE1BQUk7QUFDRixVQUFNLE9BQU8sZ0JBQWdCLE1BQU0sUUFBUSxTQUFTO0FBQ3BELFdBQU8sTUFBTSxNQUFNLElBQUk7QUFBQSxFQUN6QixVQUFFO0FBQ0EsV0FBTyxNQUFNLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsRUFDL0M7QUFDRixDQUFDO0FBRUQsS0FBSyxpREFBaUQsTUFBTTtBQUMxRCxRQUFNLFNBQXNCO0FBQUEsSUFDMUIsT0FBTztBQUFBLElBQ1AsYUFBYTtBQUFBLElBQ2IsYUFBYTtBQUFBLElBQ2IsUUFBUTtBQUFBLElBQ1IsV0FBVyxDQUFDLFNBQVM7QUFBQSxJQUNyQixVQUFVLENBQUM7QUFBQSxJQUNYLFdBQVcsQ0FBQyxhQUFhO0FBQUEsRUFDM0I7QUFDQSxRQUFNLEtBQUssc0JBQXNCLE1BQU07QUFDdkMsU0FBTyxHQUFHLEdBQUcsU0FBUyx5QkFBeUIsQ0FBQztBQUNoRCxTQUFPLEdBQUcsR0FBRyxTQUFTLHFCQUFxQixDQUFDO0FBQzVDLFNBQU8sR0FBRyxHQUFHLFNBQVMsU0FBUyxDQUFDO0FBQ2hDLFNBQU8sR0FBRyxHQUFHLFNBQVMsYUFBYSxDQUFDO0FBQ3RDLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
