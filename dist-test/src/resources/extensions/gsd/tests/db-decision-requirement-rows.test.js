import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  rowToActiveDecision,
  rowToActiveRequirement,
  rowToDecision,
  rowToRequirement,
  rowsToRequirementCounts
} from "../db-decision-requirement-rows.js";
describe("db-decision-requirement-rows", () => {
  test("maps persisted decision rows with defaults", () => {
    const decision = rowToDecision({
      seq: 7,
      id: "D007",
      when_context: "during planning",
      scope: "M001/S01",
      decision: "keep SQL writes in gsd-db",
      choice: "facade wrappers",
      rationale: "preserve the single-writer invariant",
      revisable: "after repository split",
      superseded_by: "D008"
    });
    assert.deepEqual(decision, {
      seq: 7,
      id: "D007",
      when_context: "during planning",
      scope: "M001/S01",
      decision: "keep SQL writes in gsd-db",
      choice: "facade wrappers",
      rationale: "preserve the single-writer invariant",
      revisable: "after repository split",
      made_by: "agent",
      source: "discussion",
      superseded_by: "D008"
    });
  });
  test("maps active decision rows as non-superseded", () => {
    const decision = rowToActiveDecision({
      seq: 1,
      id: "D001",
      when_context: "now",
      scope: "global",
      decision: "active only",
      choice: "view row",
      rationale: "view filters superseded rows",
      revisable: "yes",
      made_by: "human",
      source: "planning",
      superseded_by: "ignored"
    });
    assert.equal(decision.made_by, "human");
    assert.equal(decision.source, "planning");
    assert.equal(decision.superseded_by, null);
  });
  test("maps persisted requirement rows", () => {
    const requirement = rowToRequirement({
      id: "R001",
      class: "functional",
      status: "active",
      description: "Persist requirements",
      why: "planning needs durable context",
      source: "roadmap",
      primary_owner: "S01",
      supporting_slices: "S02",
      validation: "roundtrip",
      notes: "important",
      full_content: "Full requirement text",
      superseded_by: "R002"
    });
    assert.deepEqual(requirement, {
      id: "R001",
      class: "functional",
      status: "active",
      description: "Persist requirements",
      why: "planning needs durable context",
      source: "roadmap",
      primary_owner: "S01",
      supporting_slices: "S02",
      validation: "roundtrip",
      notes: "important",
      full_content: "Full requirement text",
      superseded_by: "R002"
    });
  });
  test("maps active requirement rows as non-superseded", () => {
    const requirement = rowToActiveRequirement({
      id: "R001",
      class: "functional",
      status: "validated",
      description: "Validated requirement",
      why: "done",
      source: "roadmap",
      primary_owner: "S01",
      supporting_slices: "",
      validation: "tests",
      notes: "",
      full_content: "Full requirement text",
      superseded_by: "ignored"
    });
    assert.equal(requirement.status, "validated");
    assert.equal(requirement.superseded_by, null);
  });
  test("reduces requirement status rows into stable counts", () => {
    const counts = rowsToRequirementCounts([
      { status: "active", count: 2 },
      { status: "validated", count: 3 },
      { status: "deferred", count: 5 },
      { status: "out-of-scope", count: 7 },
      { status: "out_of_scope", count: 11 },
      { status: "blocked", count: 13 },
      { status: "unknown", count: 17 }
    ]);
    assert.deepEqual(counts, {
      active: 2,
      validated: 3,
      deferred: 5,
      outOfScope: 18,
      blocked: 13,
      total: 58
    });
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9kYi1kZWNpc2lvbi1yZXF1aXJlbWVudC1yb3dzLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFByb2plY3QvQXBwOiBHU0QtMlxuLy8gRmlsZSBQdXJwb3NlOiBUZXN0cyBmb3IgZGVjaXNpb24gYW5kIHJlcXVpcmVtZW50IGRhdGFiYXNlIHJvdyBtYXBwZXJzLlxuXG5pbXBvcnQgeyBkZXNjcmliZSwgdGVzdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHtcbiAgcm93VG9BY3RpdmVEZWNpc2lvbixcbiAgcm93VG9BY3RpdmVSZXF1aXJlbWVudCxcbiAgcm93VG9EZWNpc2lvbixcbiAgcm93VG9SZXF1aXJlbWVudCxcbiAgcm93c1RvUmVxdWlyZW1lbnRDb3VudHMsXG59IGZyb20gXCIuLi9kYi1kZWNpc2lvbi1yZXF1aXJlbWVudC1yb3dzLnRzXCI7XG5cbmRlc2NyaWJlKFwiZGItZGVjaXNpb24tcmVxdWlyZW1lbnQtcm93c1wiLCAoKSA9PiB7XG4gIHRlc3QoXCJtYXBzIHBlcnNpc3RlZCBkZWNpc2lvbiByb3dzIHdpdGggZGVmYXVsdHNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGRlY2lzaW9uID0gcm93VG9EZWNpc2lvbih7XG4gICAgICBzZXE6IDcsXG4gICAgICBpZDogXCJEMDA3XCIsXG4gICAgICB3aGVuX2NvbnRleHQ6IFwiZHVyaW5nIHBsYW5uaW5nXCIsXG4gICAgICBzY29wZTogXCJNMDAxL1MwMVwiLFxuICAgICAgZGVjaXNpb246IFwia2VlcCBTUUwgd3JpdGVzIGluIGdzZC1kYlwiLFxuICAgICAgY2hvaWNlOiBcImZhY2FkZSB3cmFwcGVyc1wiLFxuICAgICAgcmF0aW9uYWxlOiBcInByZXNlcnZlIHRoZSBzaW5nbGUtd3JpdGVyIGludmFyaWFudFwiLFxuICAgICAgcmV2aXNhYmxlOiBcImFmdGVyIHJlcG9zaXRvcnkgc3BsaXRcIixcbiAgICAgIHN1cGVyc2VkZWRfYnk6IFwiRDAwOFwiLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmRlZXBFcXVhbChkZWNpc2lvbiwge1xuICAgICAgc2VxOiA3LFxuICAgICAgaWQ6IFwiRDAwN1wiLFxuICAgICAgd2hlbl9jb250ZXh0OiBcImR1cmluZyBwbGFubmluZ1wiLFxuICAgICAgc2NvcGU6IFwiTTAwMS9TMDFcIixcbiAgICAgIGRlY2lzaW9uOiBcImtlZXAgU1FMIHdyaXRlcyBpbiBnc2QtZGJcIixcbiAgICAgIGNob2ljZTogXCJmYWNhZGUgd3JhcHBlcnNcIixcbiAgICAgIHJhdGlvbmFsZTogXCJwcmVzZXJ2ZSB0aGUgc2luZ2xlLXdyaXRlciBpbnZhcmlhbnRcIixcbiAgICAgIHJldmlzYWJsZTogXCJhZnRlciByZXBvc2l0b3J5IHNwbGl0XCIsXG4gICAgICBtYWRlX2J5OiBcImFnZW50XCIsXG4gICAgICBzb3VyY2U6IFwiZGlzY3Vzc2lvblwiLFxuICAgICAgc3VwZXJzZWRlZF9ieTogXCJEMDA4XCIsXG4gICAgfSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJtYXBzIGFjdGl2ZSBkZWNpc2lvbiByb3dzIGFzIG5vbi1zdXBlcnNlZGVkXCIsICgpID0+IHtcbiAgICBjb25zdCBkZWNpc2lvbiA9IHJvd1RvQWN0aXZlRGVjaXNpb24oe1xuICAgICAgc2VxOiAxLFxuICAgICAgaWQ6IFwiRDAwMVwiLFxuICAgICAgd2hlbl9jb250ZXh0OiBcIm5vd1wiLFxuICAgICAgc2NvcGU6IFwiZ2xvYmFsXCIsXG4gICAgICBkZWNpc2lvbjogXCJhY3RpdmUgb25seVwiLFxuICAgICAgY2hvaWNlOiBcInZpZXcgcm93XCIsXG4gICAgICByYXRpb25hbGU6IFwidmlldyBmaWx0ZXJzIHN1cGVyc2VkZWQgcm93c1wiLFxuICAgICAgcmV2aXNhYmxlOiBcInllc1wiLFxuICAgICAgbWFkZV9ieTogXCJodW1hblwiLFxuICAgICAgc291cmNlOiBcInBsYW5uaW5nXCIsXG4gICAgICBzdXBlcnNlZGVkX2J5OiBcImlnbm9yZWRcIixcbiAgICB9KTtcblxuICAgIGFzc2VydC5lcXVhbChkZWNpc2lvbi5tYWRlX2J5LCBcImh1bWFuXCIpO1xuICAgIGFzc2VydC5lcXVhbChkZWNpc2lvbi5zb3VyY2UsIFwicGxhbm5pbmdcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGRlY2lzaW9uLnN1cGVyc2VkZWRfYnksIG51bGwpO1xuICB9KTtcblxuICB0ZXN0KFwibWFwcyBwZXJzaXN0ZWQgcmVxdWlyZW1lbnQgcm93c1wiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVxdWlyZW1lbnQgPSByb3dUb1JlcXVpcmVtZW50KHtcbiAgICAgIGlkOiBcIlIwMDFcIixcbiAgICAgIGNsYXNzOiBcImZ1bmN0aW9uYWxcIixcbiAgICAgIHN0YXR1czogXCJhY3RpdmVcIixcbiAgICAgIGRlc2NyaXB0aW9uOiBcIlBlcnNpc3QgcmVxdWlyZW1lbnRzXCIsXG4gICAgICB3aHk6IFwicGxhbm5pbmcgbmVlZHMgZHVyYWJsZSBjb250ZXh0XCIsXG4gICAgICBzb3VyY2U6IFwicm9hZG1hcFwiLFxuICAgICAgcHJpbWFyeV9vd25lcjogXCJTMDFcIixcbiAgICAgIHN1cHBvcnRpbmdfc2xpY2VzOiBcIlMwMlwiLFxuICAgICAgdmFsaWRhdGlvbjogXCJyb3VuZHRyaXBcIixcbiAgICAgIG5vdGVzOiBcImltcG9ydGFudFwiLFxuICAgICAgZnVsbF9jb250ZW50OiBcIkZ1bGwgcmVxdWlyZW1lbnQgdGV4dFwiLFxuICAgICAgc3VwZXJzZWRlZF9ieTogXCJSMDAyXCIsXG4gICAgfSk7XG5cbiAgICBhc3NlcnQuZGVlcEVxdWFsKHJlcXVpcmVtZW50LCB7XG4gICAgICBpZDogXCJSMDAxXCIsXG4gICAgICBjbGFzczogXCJmdW5jdGlvbmFsXCIsXG4gICAgICBzdGF0dXM6IFwiYWN0aXZlXCIsXG4gICAgICBkZXNjcmlwdGlvbjogXCJQZXJzaXN0IHJlcXVpcmVtZW50c1wiLFxuICAgICAgd2h5OiBcInBsYW5uaW5nIG5lZWRzIGR1cmFibGUgY29udGV4dFwiLFxuICAgICAgc291cmNlOiBcInJvYWRtYXBcIixcbiAgICAgIHByaW1hcnlfb3duZXI6IFwiUzAxXCIsXG4gICAgICBzdXBwb3J0aW5nX3NsaWNlczogXCJTMDJcIixcbiAgICAgIHZhbGlkYXRpb246IFwicm91bmR0cmlwXCIsXG4gICAgICBub3RlczogXCJpbXBvcnRhbnRcIixcbiAgICAgIGZ1bGxfY29udGVudDogXCJGdWxsIHJlcXVpcmVtZW50IHRleHRcIixcbiAgICAgIHN1cGVyc2VkZWRfYnk6IFwiUjAwMlwiLFxuICAgIH0pO1xuICB9KTtcblxuICB0ZXN0KFwibWFwcyBhY3RpdmUgcmVxdWlyZW1lbnQgcm93cyBhcyBub24tc3VwZXJzZWRlZFwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVxdWlyZW1lbnQgPSByb3dUb0FjdGl2ZVJlcXVpcmVtZW50KHtcbiAgICAgIGlkOiBcIlIwMDFcIixcbiAgICAgIGNsYXNzOiBcImZ1bmN0aW9uYWxcIixcbiAgICAgIHN0YXR1czogXCJ2YWxpZGF0ZWRcIixcbiAgICAgIGRlc2NyaXB0aW9uOiBcIlZhbGlkYXRlZCByZXF1aXJlbWVudFwiLFxuICAgICAgd2h5OiBcImRvbmVcIixcbiAgICAgIHNvdXJjZTogXCJyb2FkbWFwXCIsXG4gICAgICBwcmltYXJ5X293bmVyOiBcIlMwMVwiLFxuICAgICAgc3VwcG9ydGluZ19zbGljZXM6IFwiXCIsXG4gICAgICB2YWxpZGF0aW9uOiBcInRlc3RzXCIsXG4gICAgICBub3RlczogXCJcIixcbiAgICAgIGZ1bGxfY29udGVudDogXCJGdWxsIHJlcXVpcmVtZW50IHRleHRcIixcbiAgICAgIHN1cGVyc2VkZWRfYnk6IFwiaWdub3JlZFwiLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlcXVpcmVtZW50LnN0YXR1cywgXCJ2YWxpZGF0ZWRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlcXVpcmVtZW50LnN1cGVyc2VkZWRfYnksIG51bGwpO1xuICB9KTtcblxuICB0ZXN0KFwicmVkdWNlcyByZXF1aXJlbWVudCBzdGF0dXMgcm93cyBpbnRvIHN0YWJsZSBjb3VudHNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGNvdW50cyA9IHJvd3NUb1JlcXVpcmVtZW50Q291bnRzKFtcbiAgICAgIHsgc3RhdHVzOiBcImFjdGl2ZVwiLCBjb3VudDogMiB9LFxuICAgICAgeyBzdGF0dXM6IFwidmFsaWRhdGVkXCIsIGNvdW50OiAzIH0sXG4gICAgICB7IHN0YXR1czogXCJkZWZlcnJlZFwiLCBjb3VudDogNSB9LFxuICAgICAgeyBzdGF0dXM6IFwib3V0LW9mLXNjb3BlXCIsIGNvdW50OiA3IH0sXG4gICAgICB7IHN0YXR1czogXCJvdXRfb2Zfc2NvcGVcIiwgY291bnQ6IDExIH0sXG4gICAgICB7IHN0YXR1czogXCJibG9ja2VkXCIsIGNvdW50OiAxMyB9LFxuICAgICAgeyBzdGF0dXM6IFwidW5rbm93blwiLCBjb3VudDogMTcgfSxcbiAgICBdKTtcblxuICAgIGFzc2VydC5kZWVwRXF1YWwoY291bnRzLCB7XG4gICAgICBhY3RpdmU6IDIsXG4gICAgICB2YWxpZGF0ZWQ6IDMsXG4gICAgICBkZWZlcnJlZDogNSxcbiAgICAgIG91dE9mU2NvcGU6IDE4LFxuICAgICAgYmxvY2tlZDogMTMsXG4gICAgICB0b3RhbDogNTgsXG4gICAgfSk7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFHQSxTQUFTLFVBQVUsWUFBWTtBQUMvQixPQUFPLFlBQVk7QUFDbkI7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFFUCxTQUFTLGdDQUFnQyxNQUFNO0FBQzdDLE9BQUssOENBQThDLE1BQU07QUFDdkQsVUFBTSxXQUFXLGNBQWM7QUFBQSxNQUM3QixLQUFLO0FBQUEsTUFDTCxJQUFJO0FBQUEsTUFDSixjQUFjO0FBQUEsTUFD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
