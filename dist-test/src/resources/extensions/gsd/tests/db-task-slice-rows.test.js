import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseTaskArrayColumn, rowToSlice, rowToTask } from "../db-task-slice-rows.js";
describe("db-task-slice-rows", () => {
  test("parseTaskArrayColumn handles JSON arrays, scalar JSON, raw arrays, and legacy CSV", () => {
    assert.deepEqual(parseTaskArrayColumn('["a.ts","b.ts"]'), ["a.ts", "b.ts"]);
    assert.deepEqual(parseTaskArrayColumn('"single.ts"'), ["single.ts"]);
    assert.deepEqual(parseTaskArrayColumn(["a.ts", 42, "b.ts"]), ["a.ts", "b.ts"]);
    assert.deepEqual(parseTaskArrayColumn(" a.ts, b.ts ,, "), ["a.ts", "b.ts"]);
    assert.deepEqual(parseTaskArrayColumn(""), []);
    assert.deepEqual(parseTaskArrayColumn(null), []);
  });
  test("rowToSlice maps optional DB columns to stable defaults", () => {
    const slice = rowToSlice({
      milestone_id: "M001",
      id: "S01",
      title: "Build the thing",
      status: "active",
      risk: "medium",
      depends: '["S00"]',
      created_at: "2026-05-04T00:00:00.000Z"
    });
    assert.deepEqual(slice, {
      milestone_id: "M001",
      id: "S01",
      title: "Build the thing",
      status: "active",
      risk: "medium",
      depends: ["S00"],
      demo: "",
      created_at: "2026-05-04T00:00:00.000Z",
      completed_at: null,
      full_summary_md: "",
      full_uat_md: "",
      goal: "",
      success_criteria: "",
      proof_level: "",
      integration_closure: "",
      observability_impact: "",
      sequence: 0,
      replan_triggered_at: null,
      is_sketch: 0,
      sketch_scope: ""
    });
  });
  test("rowToTask maps planning and escalation columns", () => {
    const task = rowToTask({
      milestone_id: "M001",
      slice_id: "S01",
      id: "T01",
      title: "Extract row mapper",
      status: "done",
      one_liner: "Mapper extraction",
      narrative: "Moved row shaping",
      verification_result: "passed",
      duration: "5m",
      completed_at: "2026-05-04T00:00:00.000Z",
      blocker_discovered: 1,
      deviations: "",
      known_issues: "",
      key_files: "a.ts,b.ts",
      key_decisions: '["D001"]',
      full_summary_md: "summary",
      description: "description",
      estimate: "small",
      files: '["src/a.ts"]',
      verify: "npm test",
      inputs: '"input.md"',
      expected_output: "result.md,report.md",
      observability_impact: "none",
      full_plan_md: "plan",
      sequence: 3,
      blocker_source: "test",
      escalation_pending: 1,
      escalation_awaiting_review: 0,
      escalation_artifact_path: "/tmp/escalation.md",
      escalation_override_applied_at: "2026-05-04T00:01:00.000Z"
    });
    assert.equal(task.blocker_discovered, true);
    assert.deepEqual(task.key_files, ["a.ts", "b.ts"]);
    assert.deepEqual(task.key_decisions, ["D001"]);
    assert.deepEqual(task.files, ["src/a.ts"]);
    assert.deepEqual(task.inputs, ["input.md"]);
    assert.deepEqual(task.expected_output, ["result.md", "report.md"]);
    assert.equal(task.sequence, 3);
    assert.equal(task.escalation_pending, 1);
    assert.equal(task.escalation_artifact_path, "/tmp/escalation.md");
  });
  test("rowToTask defaults optional planning and escalation fields", () => {
    const task = rowToTask({
      milestone_id: "M001",
      slice_id: "S01",
      id: "T01",
      title: "Pending",
      status: "pending",
      one_liner: "",
      narrative: "",
      verification_result: "",
      duration: "",
      blocker_discovered: 0,
      deviations: "",
      known_issues: "",
      key_files: "",
      key_decisions: "",
      full_summary_md: ""
    });
    assert.equal(task.completed_at, null);
    assert.deepEqual(task.files, []);
    assert.deepEqual(task.inputs, []);
    assert.deepEqual(task.expected_output, []);
    assert.equal(task.sequence, 0);
    assert.equal(task.blocker_source, "");
    assert.equal(task.escalation_pending, 0);
    assert.equal(task.escalation_awaiting_review, 0);
    assert.equal(task.escalation_artifact_path, null);
    assert.equal(task.escalation_override_applied_at, null);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9kYi10YXNrLXNsaWNlLXJvd3MudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IFRlc3RzIGZvciB0YXNrIGFuZCBzbGljZSBkYXRhYmFzZSByb3cgbWFwcGVycy5cblxuaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IHBhcnNlVGFza0FycmF5Q29sdW1uLCByb3dUb1NsaWNlLCByb3dUb1Rhc2sgfSBmcm9tIFwiLi4vZGItdGFzay1zbGljZS1yb3dzLnRzXCI7XG5cbmRlc2NyaWJlKFwiZGItdGFzay1zbGljZS1yb3dzXCIsICgpID0+IHtcbiAgdGVzdChcInBhcnNlVGFza0FycmF5Q29sdW1uIGhhbmRsZXMgSlNPTiBhcnJheXMsIHNjYWxhciBKU09OLCByYXcgYXJyYXlzLCBhbmQgbGVnYWN5IENTVlwiLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChwYXJzZVRhc2tBcnJheUNvbHVtbignW1wiYS50c1wiLFwiYi50c1wiXScpLCBbXCJhLnRzXCIsIFwiYi50c1wiXSk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChwYXJzZVRhc2tBcnJheUNvbHVtbignXCJzaW5nbGUudHNcIicpLCBbXCJzaW5nbGUudHNcIl0pO1xuICAgIGFzc2VydC5kZWVwRXF1YWwocGFyc2VUYXNrQXJyYXlDb2x1bW4oW1wiYS50c1wiLCA0MiwgXCJiLnRzXCJdKSwgW1wiYS50c1wiLCBcImIudHNcIl0pO1xuICAgIGFzc2VydC5kZWVwRXF1YWwocGFyc2VUYXNrQXJyYXlDb2x1bW4oXCIgYS50cywgYi50cyAsLCBcIiksIFtcImEudHNcIiwgXCJiLnRzXCJdKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHBhcnNlVGFza0FycmF5Q29sdW1uKFwiXCIpLCBbXSk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChwYXJzZVRhc2tBcnJheUNvbHVtbihudWxsKSwgW10pO1xuICB9KTtcblxuICB0ZXN0KFwicm93VG9TbGljZSBtYXBzIG9wdGlvbmFsIERCIGNvbHVtbnMgdG8gc3RhYmxlIGRlZmF1bHRzXCIsICgpID0+IHtcbiAgICBjb25zdCBzbGljZSA9IHJvd1RvU2xpY2Uoe1xuICAgICAgbWlsZXN0b25lX2lkOiBcIk0wMDFcIixcbiAgICAgIGlkOiBcIlMwMVwiLFxuICAgICAgdGl0bGU6IFwiQnVpbGQgdGhlIHRoaW5nXCIsXG4gICAgICBzdGF0dXM6IFwiYWN0aXZlXCIsXG4gICAgICByaXNrOiBcIm1lZGl1bVwiLFxuICAgICAgZGVwZW5kczogJ1tcIlMwMFwiXScsXG4gICAgICBjcmVhdGVkX2F0OiBcIjIwMjYtMDUtMDRUMDA6MDA6MDAuMDAwWlwiLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmRlZXBFcXVhbChzbGljZSwge1xuICAgICAgbWlsZXN0b25lX2lkOiBcIk0wMDFcIixcbiAgICAgIGlkOiBcIlMwMVwiLFxuICAgICAgdGl0bGU6IFwiQnVpbGQgdGhlIHRoaW5nXCIsXG4gICAgICBzdGF0dXM6IFwiYWN0aXZlXCIsXG4gICAgICByaXNrOiBcIm1lZGl1bVwiLFxuICAgICAgZGVwZW5kczogW1wiUzAwXCJdLFxuICAgICAgZGVtbzogXCJcIixcbiAgICAgIGNyZWF0ZWRfYXQ6IFwiMjAyNi0wNS0wNFQwMDowMDowMC4wMDBaXCIsXG4gICAgICBjb21wbGV0ZWRfYXQ6IG51bGwsXG4gICAgICBmdWxsX3N1bW1hcnlfbWQ6IFwiXCIsXG4gICAgICBmdWxsX3VhdF9tZDogXCJcIixcbiAgICAgIGdvYWw6IFwiXCIsXG4gICAgICBzdWNjZXNzX2NyaXRlcmlhOiBcIlwiLFxuICAgICAgcHJvb2ZfbGV2ZWw6IFwiXCIsXG4gICAgICBpbnRlZ3JhdGlvbl9jbG9zdXJlOiBcIlwiLFxuICAgICAgb2JzZXJ2YWJpbGl0eV9pbXBhY3Q6IFwiXCIsXG4gICAgICBzZXF1ZW5jZTogMCxcbiAgICAgIHJlcGxhbl90cmlnZ2VyZWRfYXQ6IG51bGwsXG4gICAgICBpc19za2V0Y2g6IDAsXG4gICAgICBza2V0Y2hfc2NvcGU6IFwiXCIsXG4gICAgfSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJyb3dUb1Rhc2sgbWFwcyBwbGFubmluZyBhbmQgZXNjYWxhdGlvbiBjb2x1bW5zXCIsICgpID0+IHtcbiAgICBjb25zdCB0YXNrID0gcm93VG9UYXNrKHtcbiAgICAgIG1pbGVzdG9uZV9pZDogXCJNMDAxXCIsXG4gICAgICBzbGljZV9pZDogXCJTMDFcIixcbiAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgdGl0bGU6IFwiRXh0cmFjdCByb3cgbWFwcGVyXCIsXG4gICAgICBzdGF0dXM6IFwiZG9uZVwiLFxuICAgICAgb25lX2xpbmVyOiBcIk1hcHBlciBleHRyYWN0aW9uXCIsXG4gICAgICBuYXJyYXRpdmU6IFwiTW92ZWQgcm93IHNoYXBpbmdcIixcbiAgICAgIHZlcmlmaWNhdGlvbl9yZXN1bHQ6IFwicGFzc2VkXCIsXG4gICAgICBkdXJhdGlvbjogXCI1bVwiLFxuICAgICAgY29tcGxldGVkX2F0OiBcIjIwMjYtMDUtMDRUMDA6MDA6MDAuMDAwWlwiLFxuICAgICAgYmxvY2tlcl9kaXNjb3ZlcmVkOiAxLFxuICAgICAgZGV2aWF0aW9uczogXCJcIixcbiAgICAgIGtub3duX2lzc3VlczogXCJcIixcbiAgICAgIGtleV9maWxlczogXCJhLnRzLGIudHNcIixcbiAgICAgIGtleV9kZWNpc2lvbnM6ICdbXCJEMDAxXCJdJyxcbiAgICAgIGZ1bGxfc3VtbWFyeV9tZDogXCJzdW1tYXJ5XCIsXG4gICAgICBkZXNjcmlwdGlvbjogXCJkZXNjcmlwdGlvblwiLFxuICAgICAgZXN0aW1hdGU6IFwic21hbGxcIixcbiAgICAgIGZpbGVzOiAnW1wic3JjL2EudHNcIl0nLFxuICAgICAgdmVyaWZ5OiBcIm5wbSB0ZXN0XCIsXG4gICAgICBpbnB1dHM6ICdcImlucHV0Lm1kXCInLFxuICAgICAgZXhwZWN0ZWRfb3V0cHV0OiBcInJlc3VsdC5tZCxyZXBvcnQubWRcIixcbiAgICAgIG9ic2VydmFiaWxpdHlfaW1wYWN0OiBcIm5vbmVcIixcbiAgICAgIGZ1bGxfcGxhbl9tZDogXCJwbGFuXCIsXG4gICAgICBzZXF1ZW5jZTogMyxcbiAgICAgIGJsb2NrZXJfc291cmNlOiBcInRlc3RcIixcbiAgICAgIGVzY2FsYXRpb25fcGVuZGluZzogMSxcbiAgICAgIGVzY2FsYXRpb25fYXdhaXRpbmdfcmV2aWV3OiAwLFxuICAgICAgZXNjYWxhdGlvbl9hcnRpZmFjdF9wYXRoOiBcIi90bXAvZXNjYWxhdGlvbi5tZFwiLFxuICAgICAgZXNjYWxhdGlvbl9vdmVycmlkZV9hcHBsaWVkX2F0OiBcIjIwMjYtMDUtMDRUMDA6MDE6MDAuMDAwWlwiLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHRhc2suYmxvY2tlcl9kaXNjb3ZlcmVkLCB0cnVlKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHRhc2sua2V5X2ZpbGVzLCBbXCJhLnRzXCIsIFwiYi50c1wiXSk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbCh0YXNrLmtleV9kZWNpc2lvbnMsIFtcIkQwMDFcIl0pO1xuICAgIGFzc2VydC5kZWVwRXF1YWwodGFzay5maWxlcywgW1wic3JjL2EudHNcIl0pO1xuICAgIGFzc2VydC5kZWVwRXF1YWwodGFzay5pbnB1dHMsIFtcImlucHV0Lm1kXCJdKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHRhc2suZXhwZWN0ZWRfb3V0cHV0LCBbXCJyZXN1bHQubWRcIiwgXCJyZXBvcnQubWRcIl0pO1xuICAgIGFzc2VydC5lcXVhbCh0YXNrLnNlcXVlbmNlLCAzKTtcbiAgICBhc3NlcnQuZXF1YWwodGFzay5lc2NhbGF0aW9uX3BlbmRpbmcsIDEpO1xuICAgIGFzc2VydC5lcXVhbCh0YXNrLmVzY2FsYXRpb25fYXJ0aWZhY3RfcGF0aCwgXCIvdG1wL2VzY2FsYXRpb24ubWRcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJyb3dUb1Rhc2sgZGVmYXVsdHMgb3B0aW9uYWwgcGxhbm5pbmcgYW5kIGVzY2FsYXRpb24gZmllbGRzXCIsICgpID0+IHtcbiAgICBjb25zdCB0YXNrID0gcm93VG9UYXNrKHtcbiAgICAgIG1pbGVzdG9uZV9pZDogXCJNMDAxXCIsXG4gICAgICBzbGljZV9pZDogXCJTMDFcIixcbiAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgdGl0bGU6IFwiUGVuZGluZ1wiLFxuICAgICAgc3RhdHVzOiBcInBlbmRpbmdcIixcbiAgICAgIG9uZV9saW5lcjogXCJcIixcbiAgICAgIG5hcnJhdGl2ZTogXCJcIixcbiAgICAgIHZlcmlmaWNhdGlvbl9yZXN1bHQ6IFwiXCIsXG4gICAgICBkdXJhdGlvbjogXCJcIixcbiAgICAgIGJsb2NrZXJfZGlzY292ZXJlZDogMCxcbiAgICAgIGRldmlhdGlvbnM6IFwiXCIsXG4gICAgICBrbm93bl9pc3N1ZXM6IFwiXCIsXG4gICAgICBrZXlfZmlsZXM6IFwiXCIsXG4gICAgICBrZXlfZGVjaXNpb25zOiBcIlwiLFxuICAgICAgZnVsbF9zdW1tYXJ5X21kOiBcIlwiLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHRhc2suY29tcGxldGVkX2F0LCBudWxsKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHRhc2suZmlsZXMsIFtdKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHRhc2suaW5wdXRzLCBbXSk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbCh0YXNrLmV4cGVjdGVkX291dHB1dCwgW10pO1xuICAgIGFzc2VydC5lcXVhbCh0YXNrLnNlcXVlbmNlLCAwKTtcbiAgICBhc3NlcnQuZXF1YWwodGFzay5ibG9ja2VyX3NvdXJjZSwgXCJcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHRhc2suZXNjYWxhdGlvbl9wZW5kaW5nLCAwKTtcbiAgICBhc3NlcnQuZXF1YWwodGFzay5lc2NhbGF0aW9uX2F3YWl0aW5nX3JldmlldywgMCk7XG4gICAgYXNzZXJ0LmVxdWFsKHRhc2suZXNjYWxhdGlvbl9hcnRpZmFjdF9wYXRoLCBudWxsKTtcbiAgICBhc3NlcnQuZXF1YWwodGFzay5lc2NhbGF0aW9uX292ZXJyaWRlX2FwcGxpZWRfYXQsIG51bGwpO1xuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBR0EsU0FBUyxVQUFVLFlBQVk7QUFDL0IsT0FBTyxZQUFZO0FBQ25CLFNBQVMsc0JBQXNCLFlBQVksaUJBQWlCO0FBRTVELFNBQVMsc0JBQXNCLE1BQU07QUFDbkMsT0FBSyxxRkFBcUYsTUFBTTtBQUM5RixXQUFPLFVBQVUscUJBQXFCLGlCQUFpQixHQUFHLENBQUMsUUFBUSxNQUFNLENBQUM7QUFDMUUsV0FBTyxVQUFVLHFCQUFxQixhQUFhLEdBQUcsQ0FBQyxXQUFXLENBQUM7QUFDbkUsV0FBTyxVQUFVLHFCQUFxQixDQUFDLFFBQVEsSUFBSSxNQUFNLENBQUMsR0FBRyxDQUFDLFFBQVEsTUFBTSxDQUFDO0FBQzdFLFdBQU8sVUFBVSxxQkFBcUIsaUJBQWlCLEdBQUcsQ0FBQyxRQUFRLE1BQU0sQ0FBQztBQUMxRSxXQUFPLFVBQVUscUJBQXFCLEVBQUUsR0FBRyxDQUFDLENBQUM7QUFDN0MsV0FBTyxVQUFVLHFCQUFxQixJQUFJLEdBQUcsQ0FBQyxDQUFDO0FBQUEsRUFDakQsQ0FBQztBQUVELE9BQUssMERBQTBELE1BQU07QUFDbkUsVUFBTSxRQUFRLFdBQVc7QUFBQSxNQUN2QixjQUFjO0FBQUEsTUFDZCxJQUFJO0FBQUEsTUFDSixPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixNQUFNO0FBQUEsTUFDTixTQUFTO0FBQUEsTUFDVCxZQUFZO0FBQUEsSUFDZCxDQUFDO0FBRUQsV0FBTyxVQUFVLE9BQU87QUFBQSxNQUN0QixjQUFjO0FBQUEsTUFDZCxJQUFJO0FBQUEsTUFDSixPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixNQUFNO0FBQUEsTUFDTixTQUFTLENBQUMsS0FBSztBQUFBLE1BQ2YsTUFBTTtBQUFBLE1BQ04sWUFBWTtBQUFBLE1BQ1osY0FBYztBQUFBLE1BQ2QsaUJBQWlCO0FBQUEsTUFDakIsYUFBYTtBQUFBLE1BQ2IsTUFBTTtBQUFBLE1BQ04sa0JBQWtCO0FBQUEsTUFDbEIsYUFBYTtBQUFBLE1BQ2IscUJBQXFCO0FBQUEsTUFDckIsc0JBQXNCO0FBQUEsTUFDdEIsVUFBVTtBQUFBLE1BQ1YscUJBQXFCO0FBQUEsTUFDckIsV0FBVztBQUFBLE1BQ1gsY0FBYztBQUFBLElBQ2hCLENBQUM7QUFBQSxFQUNILENBQUM7QUFFRCxPQUFLLGtEQUFrRCxNQUFNO0FBQzNELFVBQU0sT0FBTyxVQUFVO0FBQUEsTUFDckIsY0FBYztBQUFBLE1BQ2QsVUFBVTtBQUFBLE1BQ1YsSUFBSTtBQUFBLE1BQ0osT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsV0FBVztBQUFBLE1BQ1gscUJBQXFCO0FBQUEsTUFDckIsVUFBVTtBQUFBLE1BQ1YsY0FBYztBQUFBLE1BQ2Qsb0JBQW9CO0FBQUEsTUFDcEIsWUFBWTtBQUFBLE1BQ1osY0FBYztBQUFBLE1BQ2QsV0FBVztBQUFBLE1BQ1gsZUFBZTtBQUFBLE1BQ2YsaUJBQWlCO0FBQUEsTUFDakIsYUFBYTtBQUFBLE1BQ2IsVUFBVTtBQUFBLE1BQ1YsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsUUFBUTtBQUFBLE1BQ1IsaUJBQWlCO0FBQUEsTUFDakIsc0JBQXNCO0FBQUEsTUFDdEIsY0FBYztBQUFBLE1BQ2QsVUFBVTtBQUFBLE1BQ1YsZ0JBQWdCO0FBQUEsTUFDaEIsb0JBQW9CO0FBQUEsTUFDcEIsNEJBQTRCO0FBQUEsTUFDNUIsMEJBQTBCO0FBQUEsTUFDMUIsZ0NBQWdDO0FBQUEsSUFDbEMsQ0FBQztBQUVELFdBQU8sTUFBTSxLQUFLLG9CQUFvQixJQUFJO0FBQzFDLFdBQU8sVUFBVSxLQUFLLFdBQVcsQ0FBQyxRQUFRLE1BQU0sQ0FBQztBQUNqRCxXQUFPLFVBQVUsS0FBSyxlQUFlLENBQUMsTUFBTSxDQUFDO0FBQzdDLFdBQU8sVUFBVSxLQUFLLE9BQU8sQ0FBQyxVQUFVLENBQUM7QUFDekMsV0FBTyxVQUFVLEtBQUssUUFBUSxDQUFDLFVBQVUsQ0FBQztBQUMxQyxXQUFPLFVBQVUsS0FBSyxpQkFBaUIsQ0FBQyxhQUFhLFdBQVcsQ0FBQztBQUNqRSxXQUFPLE1BQU0sS0FBSyxVQUFVLENBQUM7QUFDN0IsV0FBTyxNQUFNLEtBQUssb0JBQW9CLENBQUM7QUFDdkMsV0FBTyxNQUFNLEtBQUssMEJBQTBCLG9CQUFvQjtBQUFBLEVBQ2xFLENBQUM7QUFFRCxPQUFLLDhEQUE4RCxNQUFNO0FBQ3ZFLFVBQU0sT0FBTyxVQUFVO0FBQUEsTUFDckIsY0FBYztBQUFBLE1BQ2QsVUFBVTtBQUFBLE1BQ1YsSUFBSTtBQUFBLE1BQ0osT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsV0FBVztBQUFBLE1BQ1gscUJBQXFCO0FBQUEsTUFDckIsVUFBVTtBQUFBLE1BQ1Ysb0JBQW9CO0FBQUEsTUFDcEIsWUFBWTtBQUFBLE1BQ1osY0FBYztBQUFBLE1BQ2QsV0FBVztBQUFBLE1BQ1gsZUFBZTtBQUFBLE1BQ2YsaUJBQWlCO0FBQUEsSUFDbkIsQ0FBQztBQUVELFdBQU8sTUFBTSxLQUFLLGNBQWMsSUFBSTtBQUNwQyxXQUFPLFVBQVUsS0FBSyxPQUFPLENBQUMsQ0FBQztBQUMvQixXQUFPLFVBQVUsS0FBSyxRQUFRLENBQUMsQ0FBQztBQUNoQyxXQUFPLFVBQVUsS0FBSyxpQkFBaUIsQ0FBQyxDQUFDO0FBQ3pDLFdBQU8sTUFBTSxLQUFLLFVBQVUsQ0FBQztBQUM3QixXQUFPLE1BQU0sS0FBSyxnQkFBZ0IsRUFBRTtBQUNwQyxXQUFPLE1BQU0sS0FBSyxvQkFBb0IsQ0FBQztBQUN2QyxXQUFPLE1BQU0sS0FBSyw0QkFBNEIsQ0FBQztBQUMvQyxXQUFPLE1BQU0sS0FBSywwQkFBMEIsSUFBSTtBQUNoRCxXQUFPLE1BQU0sS0FBSyxnQ0FBZ0MsSUFBSTtBQUFBLEVBQ3hELENBQUM7QUFDSCxDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
