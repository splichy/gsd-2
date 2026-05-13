import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { shouldDegradeEmptyWorktreeToProjectRoot } from "../auto/phases.js";
function classification(kind) {
  return {
    kind,
    signals: {
      detectedFiles: [],
      isGitRepo: true,
      isMonorepo: false,
      xcodePlatforms: [],
      hasCI: false,
      hasTests: false,
      verificationCommands: []
    },
    trackedFiles: [],
    untrackedFiles: [],
    contentFiles: [],
    markers: [],
    reason: kind
  };
}
describe("worktree project-root degradation", () => {
  test("degrades when worktree is greenfield but project root has content", () => {
    assert.equal(
      shouldDegradeEmptyWorktreeToProjectRoot(
        classification("greenfield"),
        classification("typed-existing")
      ),
      true
    );
    assert.equal(
      shouldDegradeEmptyWorktreeToProjectRoot(
        classification("greenfield"),
        classification("untyped-existing")
      ),
      true
    );
  });
  test("keeps true greenfield worktrees in worktree mode", () => {
    assert.equal(
      shouldDegradeEmptyWorktreeToProjectRoot(
        classification("greenfield"),
        classification("greenfield")
      ),
      false
    );
  });
  test("does not degrade when project root classification is invalid", () => {
    assert.equal(
      shouldDegradeEmptyWorktreeToProjectRoot(
        classification("greenfield"),
        classification("invalid-repo")
      ),
      false
    );
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy93b3JrdHJlZS1wcm9qZWN0LXJvb3QtZGVncmFkZS50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBHU0QtMiArIFdvcmt0cmVlIGRpc3BhdGNoIGd1YXJkOiBkZWdyYWRlIGVtcHR5IHdvcmt0cmVlcyBvdmVyIHJlYWwgcHJvamVjdCByb290cy5cblxuaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcblxuaW1wb3J0IHsgc2hvdWxkRGVncmFkZUVtcHR5V29ya3RyZWVUb1Byb2plY3RSb290IH0gZnJvbSBcIi4uL2F1dG8vcGhhc2VzLnRzXCI7XG5pbXBvcnQgdHlwZSB7IFByb2plY3RDbGFzc2lmaWNhdGlvbiB9IGZyb20gXCIuLi9kZXRlY3Rpb24udHNcIjtcblxuZnVuY3Rpb24gY2xhc3NpZmljYXRpb24oa2luZDogUHJvamVjdENsYXNzaWZpY2F0aW9uW1wia2luZFwiXSk6IFByb2plY3RDbGFzc2lmaWNhdGlvbiB7XG4gIHJldHVybiB7XG4gICAga2luZCxcbiAgICBzaWduYWxzOiB7XG4gICAgICBkZXRlY3RlZEZpbGVzOiBbXSxcbiAgICAgIGlzR2l0UmVwbzogdHJ1ZSxcbiAgICAgIGlzTW9ub3JlcG86IGZhbHNlLFxuICAgICAgeGNvZGVQbGF0Zm9ybXM6IFtdLFxuICAgICAgaGFzQ0k6IGZhbHNlLFxuICAgICAgaGFzVGVzdHM6IGZhbHNlLFxuICAgICAgdmVyaWZpY2F0aW9uQ29tbWFuZHM6IFtdLFxuICAgIH0sXG4gICAgdHJhY2tlZEZpbGVzOiBbXSxcbiAgICB1bnRyYWNrZWRGaWxlczogW10sXG4gICAgY29udGVudEZpbGVzOiBbXSxcbiAgICBtYXJrZXJzOiBbXSxcbiAgICByZWFzb246IGtpbmQsXG4gIH07XG59XG5cbmRlc2NyaWJlKFwid29ya3RyZWUgcHJvamVjdC1yb290IGRlZ3JhZGF0aW9uXCIsICgpID0+IHtcbiAgdGVzdChcImRlZ3JhZGVzIHdoZW4gd29ya3RyZWUgaXMgZ3JlZW5maWVsZCBidXQgcHJvamVjdCByb290IGhhcyBjb250ZW50XCIsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICBzaG91bGREZWdyYWRlRW1wdHlXb3JrdHJlZVRvUHJvamVjdFJvb3QoXG4gICAgICAgIGNsYXNzaWZpY2F0aW9uKFwiZ3JlZW5maWVsZFwiKSxcbiAgICAgICAgY2xhc3NpZmljYXRpb24oXCJ0eXBlZC1leGlzdGluZ1wiKSxcbiAgICAgICksXG4gICAgICB0cnVlLFxuICAgICk7XG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgc2hvdWxkRGVncmFkZUVtcHR5V29ya3RyZWVUb1Byb2plY3RSb290KFxuICAgICAgICBjbGFzc2lmaWNhdGlvbihcImdyZWVuZmllbGRcIiksXG4gICAgICAgIGNsYXNzaWZpY2F0aW9uKFwidW50eXBlZC1leGlzdGluZ1wiKSxcbiAgICAgICksXG4gICAgICB0cnVlLFxuICAgICk7XG4gIH0pO1xuXG4gIHRlc3QoXCJrZWVwcyB0cnVlIGdyZWVuZmllbGQgd29ya3RyZWVzIGluIHdvcmt0cmVlIG1vZGVcIiwgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIHNob3VsZERlZ3JhZGVFbXB0eVdvcmt0cmVlVG9Qcm9qZWN0Um9vdChcbiAgICAgICAgY2xhc3NpZmljYXRpb24oXCJncmVlbmZpZWxkXCIpLFxuICAgICAgICBjbGFzc2lmaWNhdGlvbihcImdyZWVuZmllbGRcIiksXG4gICAgICApLFxuICAgICAgZmFsc2UsXG4gICAgKTtcbiAgfSk7XG5cbiAgdGVzdChcImRvZXMgbm90IGRlZ3JhZGUgd2hlbiBwcm9qZWN0IHJvb3QgY2xhc3NpZmljYXRpb24gaXMgaW52YWxpZFwiLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgc2hvdWxkRGVncmFkZUVtcHR5V29ya3RyZWVUb1Byb2plY3RSb290KFxuICAgICAgICBjbGFzc2lmaWNhdGlvbihcImdyZWVuZmllbGRcIiksXG4gICAgICAgIGNsYXNzaWZpY2F0aW9uKFwiaW52YWxpZC1yZXBvXCIpLFxuICAgICAgKSxcbiAgICAgIGZhbHNlLFxuICAgICk7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFFQSxTQUFTLFVBQVUsWUFBWTtBQUMvQixPQUFPLFlBQVk7QUFFbkIsU0FBUywrQ0FBK0M7QUFHeEQsU0FBUyxlQUFlLE1BQTREO0FBQ2xGLFNBQU87QUFBQSxJQUNMO0FBQUEsSUFDQSxTQUFTO0FBQUEsTUFDUCxlQUFlLENBQUM7QUFBQSxNQUNoQixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsTUFDWixnQkFBZ0IsQ0FBQztBQUFBLE1BQ2pCLE9BQU87QUFBQSxNQUNQLFVBQVU7QUFBQSxNQUNWLHNCQUFzQixDQUFDO0FBQUEsSUFDekI7QUFBQSxJQUNBLGNBQWMsQ0FBQztBQUFBLElBQ2YsZ0JBQWdCLENBQUM7QUFBQSxJQUNqQixjQUFjLENBQUM7QUFBQSxJQUNmLFNBQVMsQ0FBQztBQUFBLElBQ1YsUUFBUTtBQUFBLEVBQ1Y7QUFDRjtBQUVBLFNBQVMscUNBQXFDLE1BQU07QUFDbEQsT0FBSyxxRUFBcUUsTUFBTTtBQUM5RSxXQUFPO0FBQUEsTUFDTDtBQUFBLFFBQ0UsZUFBZSxZQUFZO0FBQUEsUUFDM0IsZUFBZSxnQkFBZ0I7QUFBQSxNQUNqQztBQUFBLE1BQ0E7QUFBQSxJQUNGO0FBQ0EsV0FBTztBQUFBLE1BQ0w7QUFBQSxRQUNFLGVBQWUsWUFBWTtBQUFBLFFBQzNCLGVBQWUsa0JBQWtCO0FBQUEsTUFDbkM7QUFBQSxNQUNBO0FBQUEsSUFDRjtBQUFBLEVBQ0YsQ0FBQztBQUVELE9BQUssb0RBQW9ELE1BQU07QUFDN0QsV0FBTztBQUFBLE1BQ0w7QUFBQSxRQUNFLGVBQWUsWUFBWTtBQUFBLFFBQzNCLGVBQWUsWUFBWTtBQUFBLE1BQzdCO0FBQUEsTUFDQTtBQUFBLElBQ0Y7QUFBQSxFQUNGLENBQUM7QUFFRCxPQUFLLGdFQUFnRSxNQUFNO0FBQ3pFLFdBQU87QUFBQSxNQUNMO0FBQUEsUUFDRSxlQUFlLFlBQVk7QUFBQSxRQUMzQixlQUFlLGNBQWM7QUFBQSxNQUMvQjtBQUFBLE1BQ0E7QUFBQSxJQUNGO0FBQUEsRUFDRixDQUFDO0FBQ0gsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
