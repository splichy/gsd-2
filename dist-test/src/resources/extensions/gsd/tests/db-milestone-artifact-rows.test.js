import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { rowToArtifact, rowToMilestone } from "../db-milestone-artifact-rows.js";
describe("db-milestone-artifact-rows", () => {
  test("rowToMilestone maps JSON planning fields and defaults optional strings", () => {
    const milestone = rowToMilestone({
      id: "M001",
      title: "Refactor DB",
      status: "active",
      depends_on: '["M000"]',
      created_at: "2026-05-04T00:00:00.000Z",
      success_criteria: '["tests pass"]',
      key_risks: '[{"risk":"drift","whyItMatters":"behavior"}]',
      proof_strategy: '[{"riskOrUnknown":"queries","retireIn":"tests","whatWillBeProven":"same rows"}]',
      definition_of_done: '["committed"]'
    });
    assert.deepEqual(milestone.depends_on, ["M000"]);
    assert.deepEqual(milestone.success_criteria, ["tests pass"]);
    assert.deepEqual(milestone.key_risks, [{ risk: "drift", whyItMatters: "behavior" }]);
    assert.deepEqual(milestone.proof_strategy, [
      { riskOrUnknown: "queries", retireIn: "tests", whatWillBeProven: "same rows" }
    ]);
    assert.deepEqual(milestone.definition_of_done, ["committed"]);
    assert.equal(milestone.completed_at, null);
    assert.equal(milestone.vision, "");
    assert.equal(milestone.sequence, 0);
  });
  test("rowToArtifact maps nullable ownership columns", () => {
    const artifact = rowToArtifact({
      path: "docs/report.md",
      artifact_type: "report",
      milestone_id: "M001",
      full_content: "content",
      imported_at: "2026-05-04T00:00:00.000Z"
    });
    assert.deepEqual(artifact, {
      path: "docs/report.md",
      artifact_type: "report",
      milestone_id: "M001",
      slice_id: null,
      task_id: null,
      full_content: "content",
      imported_at: "2026-05-04T00:00:00.000Z"
    });
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9kYi1taWxlc3RvbmUtYXJ0aWZhY3Qtcm93cy50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBQcm9qZWN0L0FwcDogR1NELTJcbi8vIEZpbGUgUHVycG9zZTogVGVzdHMgZm9yIG1pbGVzdG9uZSBhbmQgYXJ0aWZhY3QgZGF0YWJhc2Ugcm93IG1hcHBlcnMuXG5cbmltcG9ydCB7IGRlc2NyaWJlLCB0ZXN0IH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyByb3dUb0FydGlmYWN0LCByb3dUb01pbGVzdG9uZSB9IGZyb20gXCIuLi9kYi1taWxlc3RvbmUtYXJ0aWZhY3Qtcm93cy50c1wiO1xuXG5kZXNjcmliZShcImRiLW1pbGVzdG9uZS1hcnRpZmFjdC1yb3dzXCIsICgpID0+IHtcbiAgdGVzdChcInJvd1RvTWlsZXN0b25lIG1hcHMgSlNPTiBwbGFubmluZyBmaWVsZHMgYW5kIGRlZmF1bHRzIG9wdGlvbmFsIHN0cmluZ3NcIiwgKCkgPT4ge1xuICAgIGNvbnN0IG1pbGVzdG9uZSA9IHJvd1RvTWlsZXN0b25lKHtcbiAgICAgIGlkOiBcIk0wMDFcIixcbiAgICAgIHRpdGxlOiBcIlJlZmFjdG9yIERCXCIsXG4gICAgICBzdGF0dXM6IFwiYWN0aXZlXCIsXG4gICAgICBkZXBlbmRzX29uOiAnW1wiTTAwMFwiXScsXG4gICAgICBjcmVhdGVkX2F0OiBcIjIwMjYtMDUtMDRUMDA6MDA6MDAuMDAwWlwiLFxuICAgICAgc3VjY2Vzc19jcml0ZXJpYTogJ1tcInRlc3RzIHBhc3NcIl0nLFxuICAgICAga2V5X3Jpc2tzOiAnW3tcInJpc2tcIjpcImRyaWZ0XCIsXCJ3aHlJdE1hdHRlcnNcIjpcImJlaGF2aW9yXCJ9XScsXG4gICAgICBwcm9vZl9zdHJhdGVneTogJ1t7XCJyaXNrT3JVbmtub3duXCI6XCJxdWVyaWVzXCIsXCJyZXRpcmVJblwiOlwidGVzdHNcIixcIndoYXRXaWxsQmVQcm92ZW5cIjpcInNhbWUgcm93c1wifV0nLFxuICAgICAgZGVmaW5pdGlvbl9vZl9kb25lOiAnW1wiY29tbWl0dGVkXCJdJyxcbiAgICB9KTtcblxuICAgIGFzc2VydC5kZWVwRXF1YWwobWlsZXN0b25lLmRlcGVuZHNfb24sIFtcIk0wMDBcIl0pO1xuICAgIGFzc2VydC5kZWVwRXF1YWwobWlsZXN0b25lLnN1Y2Nlc3NfY3JpdGVyaWEsIFtcInRlc3RzIHBhc3NcIl0pO1xuICAgIGFzc2VydC5kZWVwRXF1YWwobWlsZXN0b25lLmtleV9yaXNrcywgW3sgcmlzazogXCJkcmlmdFwiLCB3aHlJdE1hdHRlcnM6IFwiYmVoYXZpb3JcIiB9XSk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChtaWxlc3RvbmUucHJvb2Zfc3RyYXRlZ3ksIFtcbiAgICAgIHsgcmlza09yVW5rbm93bjogXCJxdWVyaWVzXCIsIHJldGlyZUluOiBcInRlc3RzXCIsIHdoYXRXaWxsQmVQcm92ZW46IFwic2FtZSByb3dzXCIgfSxcbiAgICBdKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKG1pbGVzdG9uZS5kZWZpbml0aW9uX29mX2RvbmUsIFtcImNvbW1pdHRlZFwiXSk7XG4gICAgYXNzZXJ0LmVxdWFsKG1pbGVzdG9uZS5jb21wbGV0ZWRfYXQsIG51bGwpO1xuICAgIGFzc2VydC5lcXVhbChtaWxlc3RvbmUudmlzaW9uLCBcIlwiKTtcbiAgICBhc3NlcnQuZXF1YWwobWlsZXN0b25lLnNlcXVlbmNlLCAwKTtcbiAgfSk7XG5cbiAgdGVzdChcInJvd1RvQXJ0aWZhY3QgbWFwcyBudWxsYWJsZSBvd25lcnNoaXAgY29sdW1uc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgYXJ0aWZhY3QgPSByb3dUb0FydGlmYWN0KHtcbiAgICAgIHBhdGg6IFwiZG9jcy9yZXBvcnQubWRcIixcbiAgICAgIGFydGlmYWN0X3R5cGU6IFwicmVwb3J0XCIsXG4gICAgICBtaWxlc3RvbmVfaWQ6IFwiTTAwMVwiLFxuICAgICAgZnVsbF9jb250ZW50OiBcImNvbnRlbnRcIixcbiAgICAgIGltcG9ydGVkX2F0OiBcIjIwMjYtMDUtMDRUMDA6MDA6MDAuMDAwWlwiLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmRlZXBFcXVhbChhcnRpZmFjdCwge1xuICAgICAgcGF0aDogXCJkb2NzL3JlcG9ydC5tZFwiLFxuICAgICAgYXJ0aWZhY3RfdHlwZTogXCJyZXBvcnRcIixcbiAgICAgIG1pbGVzdG9uZV9pZDogXCJNMDAxXCIsXG4gICAgICBzbGljZV9pZDogbnVsbCxcbiAgICAgIHRhc2tfaWQ6IG51bGwsXG4gICAgICBmdWxsX2NvbnRlbnQ6IFwiY29udGVudFwiLFxuICAgICAgaW1wb3J0ZWRfYXQ6IFwiMjAyNi0wNS0wNFQwMDowMDowMC4wMDBaXCIsXG4gICAgfSk7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFHQSxTQUFTLFVBQVUsWUFBWTtBQUMvQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxlQUFlLHNCQUFzQjtBQUU5QyxTQUFTLDhCQUE4QixNQUFNO0FBQzNDLE9BQUssMEVBQTBFLE1BQU07QUFDbkYsVUFBTSxZQUFZLGVBQWU7QUFBQSxNQUMvQixJQUFJO0FBQUEsTUFDSixPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixZQUFZO0FBQUEsTUFDWixZQUFZO0FBQUEsTUFDWixrQkFBa0I7QUFBQSxNQUNsQixXQUFXO0FBQUEsTUFDWCxnQkFBZ0I7QUFBQSxNQUNoQixvQkFBb0I7QUFBQSxJQUN0QixDQUFDO0FBRUQsV0FBTyxVQUFVLFVBQVUsWUFBWSxDQUFDLE1BQU0sQ0FBQztBQUMvQyxXQUFPLFVBQVUsVUFBVSxrQkFBa0IsQ0FBQyxZQUFZLENBQUM7QUFDM0QsV0FBTyxVQUFVLFVBQVUsV0FBVyxDQUFDLEVBQUUsTUFBTSxTQUFTLGNBQWMsV0FBVyxDQUFDLENBQUM7QUFDbkYsV0FBTyxVQUFVLFVBQVUsZ0JBQWdCO0FBQUEsTUFDekMsRUFBRSxlQUFlLFdBQVcsVUFBVSxTQUFTLGtCQUFrQixZQUFZO0FBQUEsSUFDL0UsQ0FBQztBQUNELFdBQU8sVUFBVSxVQUFVLG9CQUFvQixDQUFDLFdBQVcsQ0FBQztBQUM1RCxXQUFPLE1BQU0sVUFBVSxjQUFjLElBQUk7QUFDekMsV0FBTyxNQUFNLFVBQVUsUUFBUSxFQUFFO0FBQ2pDLFdBQU8sTUFBTSxVQUFVLFVBQVUsQ0FBQztBQUFBLEVBQ3BDLENBQUM7QUFFRCxPQUFLLGlEQUFpRCxNQUFNO0FBQzFELFVBQU0sV0FBVyxjQUFjO0FBQUEsTUFDN0IsTUFBTTtBQUFBLE1BQ04sZUFBZTtBQUFBLE1BQ2YsY0FBYztBQUFBLE1BQ2QsY0FBYztBQUFBLE1BQ2QsYUFBYTtBQUFBLElBQ2YsQ0FBQztBQUVELFdBQU8sVUFBVSxVQUFVO0FBQUEsTUFDekIsTUFBTTtBQUFBLE1BQ04sZUFBZTtBQUFBLE1BQ2YsY0FBYztBQUFBLE1BQ2QsVUFBVTtBQUFBLE1BQ1YsU0FBUztBQUFBLE1BQ1QsY0FBYztBQUFBLE1BQ2QsYUFBYTtBQUFBLElBQ2YsQ0FBQztBQUFBLEVBQ0gsQ0FBQztBQUNILENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
