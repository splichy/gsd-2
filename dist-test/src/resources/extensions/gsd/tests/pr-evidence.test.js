import test from "node:test";
import assert from "node:assert/strict";
import { buildPrEvidence } from "../pr-evidence.js";
test("pr-evidence: generated body includes contribution-required sections", () => {
  const evidence = buildPrEvidence({
    milestoneId: "M001",
    milestoneTitle: "Authentication",
    linkedIssue: "Closes #123",
    summaries: ["### S01\nImplemented login."],
    roadmapItems: ["- [x] **S01: Login**"],
    metrics: ["**Units executed:** 3"],
    testsRun: ["npm test"],
    rollbackNotes: ["Revert the merge commit."]
  });
  assert.equal(evidence.title, "feat: Authentication");
  for (const section of [
    "## TL;DR",
    "## What",
    "## Why",
    "## How",
    "## Linked Issue",
    "## Tests Run",
    "## Change Type",
    "## Rollback And Compatibility",
    "## AI Assistance Disclosure"
  ]) {
    assert.ok(evidence.body.includes(section), `missing section: ${section}`);
  }
  assert.ok(evidence.body.includes("Closes #123"));
  assert.ok(evidence.body.includes("npm test"));
  assert.ok(evidence.body.includes("This PR was prepared with AI assistance."));
});
test("pr-evidence: every change type selects exactly one checklist row", () => {
  const changeTypes = ["feat", "fix", "refactor", "test", "docs", "chore"];
  for (const changeType of changeTypes) {
    const evidence = buildPrEvidence({ milestoneId: "M001", changeType });
    const checkedRows = evidence.body.split("\n").filter((line) => line.startsWith("- [x] `"));
    assert.deepEqual(checkedRows, [
      `- [x] \`${changeType}\` - ${{
        feat: "New feature or capability",
        fix: "Bug fix",
        refactor: "Code restructuring",
        test: "Adding or updating tests",
        docs: "Documentation only",
        chore: "Build, CI, or tooling changes"
      }[changeType]}`
    ]);
  }
});
test("pr-evidence: missing issue, tests, and rollback data are explicit", () => {
  const evidence = buildPrEvidence({ milestoneId: "M001", aiAssisted: false });
  assert.ok(evidence.body.includes("Not specified. Add an issue link"));
  assert.ok(evidence.body.includes("Not specified. Add exact verification commands"));
  assert.ok(evidence.body.includes("No behavior-changing rollback notes recorded."));
  assert.ok(!evidence.body.includes("## AI Assistance Disclosure"));
});
test("pr-evidence: subject metadata supports non-milestone PRs", () => {
  const evidence = buildPrEvidence({
    milestoneId: "M001",
    subjectId: "S01",
    subjectKind: "slice",
    milestoneTitle: "Auth Slice"
  });
  assert.equal(evidence.title, "feat: Auth Slice");
  assert.ok(evidence.body.includes("Ship slice S01 - Auth Slice"));
  assert.ok(evidence.body.includes("Slice work is complete and ready for review."));
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wci1ldmlkZW5jZS50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBQcm9qZWN0L0FwcDogR1NELTJcbi8vIEZpbGUgUHVycG9zZTogVGVzdHMgZm9yIHRoZSBzaGFyZWQgR1NEIHB1bGwgcmVxdWVzdCBldmlkZW5jZSBnZW5lcmF0b3IuXG5cbmltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuXG5pbXBvcnQgeyBidWlsZFByRXZpZGVuY2UsIHR5cGUgUHJDaGFuZ2VUeXBlIH0gZnJvbSBcIi4uL3ByLWV2aWRlbmNlLnRzXCI7XG5cbnRlc3QoXCJwci1ldmlkZW5jZTogZ2VuZXJhdGVkIGJvZHkgaW5jbHVkZXMgY29udHJpYnV0aW9uLXJlcXVpcmVkIHNlY3Rpb25zXCIsICgpID0+IHtcbiAgY29uc3QgZXZpZGVuY2UgPSBidWlsZFByRXZpZGVuY2Uoe1xuICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICBtaWxlc3RvbmVUaXRsZTogXCJBdXRoZW50aWNhdGlvblwiLFxuICAgIGxpbmtlZElzc3VlOiBcIkNsb3NlcyAjMTIzXCIsXG4gICAgc3VtbWFyaWVzOiBbXCIjIyMgUzAxXFxuSW1wbGVtZW50ZWQgbG9naW4uXCJdLFxuICAgIHJvYWRtYXBJdGVtczogW1wiLSBbeF0gKipTMDE6IExvZ2luKipcIl0sXG4gICAgbWV0cmljczogW1wiKipVbml0cyBleGVjdXRlZDoqKiAzXCJdLFxuICAgIHRlc3RzUnVuOiBbXCJucG0gdGVzdFwiXSxcbiAgICByb2xsYmFja05vdGVzOiBbXCJSZXZlcnQgdGhlIG1lcmdlIGNvbW1pdC5cIl0sXG4gIH0pO1xuXG4gIGFzc2VydC5lcXVhbChldmlkZW5jZS50aXRsZSwgXCJmZWF0OiBBdXRoZW50aWNhdGlvblwiKTtcbiAgZm9yIChjb25zdCBzZWN0aW9uIG9mIFtcbiAgICBcIiMjIFRMO0RSXCIsXG4gICAgXCIjIyBXaGF0XCIsXG4gICAgXCIjIyBXaHlcIixcbiAgICBcIiMjIEhvd1wiLFxuICAgIFwiIyMgTGlua2VkIElzc3VlXCIsXG4gICAgXCIjIyBUZXN0cyBSdW5cIixcbiAgICBcIiMjIENoYW5nZSBUeXBlXCIsXG4gICAgXCIjIyBSb2xsYmFjayBBbmQgQ29tcGF0aWJpbGl0eVwiLFxuICAgIFwiIyMgQUkgQXNzaXN0YW5jZSBEaXNjbG9zdXJlXCIsXG4gIF0pIHtcbiAgICBhc3NlcnQub2soZXZpZGVuY2UuYm9keS5pbmNsdWRlcyhzZWN0aW9uKSwgYG1pc3Npbmcgc2VjdGlvbjogJHtzZWN0aW9ufWApO1xuICB9XG4gIGFzc2VydC5vayhldmlkZW5jZS5ib2R5LmluY2x1ZGVzKFwiQ2xvc2VzICMxMjNcIikpO1xuICBhc3NlcnQub2soZXZpZGVuY2UuYm9keS5pbmNsdWRlcyhcIm5wbSB0ZXN0XCIpKTtcbiAgYXNzZXJ0Lm9rKGV2aWRlbmNlLmJvZHkuaW5jbHVkZXMoXCJUaGlzIFBSIHdhcyBwcmVwYXJlZCB3aXRoIEFJIGFzc2lzdGFuY2UuXCIpKTtcbn0pO1xuXG50ZXN0KFwicHItZXZpZGVuY2U6IGV2ZXJ5IGNoYW5nZSB0eXBlIHNlbGVjdHMgZXhhY3RseSBvbmUgY2hlY2tsaXN0IHJvd1wiLCAoKSA9PiB7XG4gIGNvbnN0IGNoYW5nZVR5cGVzOiBQckNoYW5nZVR5cGVbXSA9IFtcImZlYXRcIiwgXCJmaXhcIiwgXCJyZWZhY3RvclwiLCBcInRlc3RcIiwgXCJkb2NzXCIsIFwiY2hvcmVcIl07XG5cbiAgZm9yIChjb25zdCBjaGFuZ2VUeXBlIG9mIGNoYW5nZVR5cGVzKSB7XG4gICAgY29uc3QgZXZpZGVuY2UgPSBidWlsZFByRXZpZGVuY2UoeyBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIGNoYW5nZVR5cGUgfSk7XG4gICAgY29uc3QgY2hlY2tlZFJvd3MgPSBldmlkZW5jZS5ib2R5LnNwbGl0KFwiXFxuXCIpLmZpbHRlcigobGluZSkgPT4gbGluZS5zdGFydHNXaXRoKFwiLSBbeF0gYFwiKSk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChjaGVja2VkUm93cywgW1xuICAgICAgYC0gW3hdIFxcYCR7Y2hhbmdlVHlwZX1cXGAgLSAke3tcbiAgICAgICAgZmVhdDogXCJOZXcgZmVhdHVyZSBvciBjYXBhYmlsaXR5XCIsXG4gICAgICAgIGZpeDogXCJCdWcgZml4XCIsXG4gICAgICAgIHJlZmFjdG9yOiBcIkNvZGUgcmVzdHJ1Y3R1cmluZ1wiLFxuICAgICAgICB0ZXN0OiBcIkFkZGluZyBvciB1cGRhdGluZyB0ZXN0c1wiLFxuICAgICAgICBkb2NzOiBcIkRvY3VtZW50YXRpb24gb25seVwiLFxuICAgICAgICBjaG9yZTogXCJCdWlsZCwgQ0ksIG9yIHRvb2xpbmcgY2hhbmdlc1wiLFxuICAgICAgfVtjaGFuZ2VUeXBlXX1gLFxuICAgIF0pO1xuICB9XG59KTtcblxudGVzdChcInByLWV2aWRlbmNlOiBtaXNzaW5nIGlzc3VlLCB0ZXN0cywgYW5kIHJvbGxiYWNrIGRhdGEgYXJlIGV4cGxpY2l0XCIsICgpID0+IHtcbiAgY29uc3QgZXZpZGVuY2UgPSBidWlsZFByRXZpZGVuY2UoeyBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIGFpQXNzaXN0ZWQ6IGZhbHNlIH0pO1xuXG4gIGFzc2VydC5vayhldmlkZW5jZS5ib2R5LmluY2x1ZGVzKFwiTm90IHNwZWNpZmllZC4gQWRkIGFuIGlzc3VlIGxpbmtcIikpO1xuICBhc3NlcnQub2soZXZpZGVuY2UuYm9keS5pbmNsdWRlcyhcIk5vdCBzcGVjaWZpZWQuIEFkZCBleGFjdCB2ZXJpZmljYXRpb24gY29tbWFuZHNcIikpO1xuICBhc3NlcnQub2soZXZpZGVuY2UuYm9keS5pbmNsdWRlcyhcIk5vIGJlaGF2aW9yLWNoYW5naW5nIHJvbGxiYWNrIG5vdGVzIHJlY29yZGVkLlwiKSk7XG4gIGFzc2VydC5vayghZXZpZGVuY2UuYm9keS5pbmNsdWRlcyhcIiMjIEFJIEFzc2lzdGFuY2UgRGlzY2xvc3VyZVwiKSk7XG59KTtcblxudGVzdChcInByLWV2aWRlbmNlOiBzdWJqZWN0IG1ldGFkYXRhIHN1cHBvcnRzIG5vbi1taWxlc3RvbmUgUFJzXCIsICgpID0+IHtcbiAgY29uc3QgZXZpZGVuY2UgPSBidWlsZFByRXZpZGVuY2Uoe1xuICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICBzdWJqZWN0SWQ6IFwiUzAxXCIsXG4gICAgc3ViamVjdEtpbmQ6IFwic2xpY2VcIixcbiAgICBtaWxlc3RvbmVUaXRsZTogXCJBdXRoIFNsaWNlXCIsXG4gIH0pO1xuXG4gIGFzc2VydC5lcXVhbChldmlkZW5jZS50aXRsZSwgXCJmZWF0OiBBdXRoIFNsaWNlXCIpO1xuICBhc3NlcnQub2soZXZpZGVuY2UuYm9keS5pbmNsdWRlcyhcIlNoaXAgc2xpY2UgUzAxIC0gQXV0aCBTbGljZVwiKSk7XG4gIGFzc2VydC5vayhldmlkZW5jZS5ib2R5LmluY2x1ZGVzKFwiU2xpY2Ugd29yayBpcyBjb21wbGV0ZSBhbmQgcmVhZHkgZm9yIHJldmlldy5cIikpO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFHQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBRW5CLFNBQVMsdUJBQTBDO0FBRW5ELEtBQUssdUVBQXVFLE1BQU07QUFDaEYsUUFBTSxXQUFXLGdCQUFnQjtBQUFBLElBQy9CLGFBQWE7QUFBQSxJQUNiLGdCQUFnQjtBQUFBLElBQ2hCLGFBQWE7QUFBQSxJQUNiLFdBQVcsQ0FBQyw2QkFBNkI7QUFBQSxJQUN6QyxjQUFjLENBQUMsc0JBQXNCO0FBQUEsSUFDckMsU0FBUyxDQUFDLHVCQUF1QjtBQUFBLElBQ2pDLFVBQVUsQ0FBQyxVQUFVO0FBQUEsSUFDckIsZUFBZSxDQUFDLDBCQUEwQjtBQUFBLEVBQzVDLENBQUM7QUFFRCxTQUFPLE1BQU0sU0FBUyxPQUFPLHNCQUFzQjtBQUNuRCxhQUFXLFdBQVc7QUFBQSxJQUNwQjtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsRUFDRixHQUFHO0FBQ0QsV0FBTyxHQUFHLFNBQVMsS0FBSyxTQUFTLE9BQU8sR0FBRyxvQkFBb0IsT0FBTyxFQUFFO0FBQUEsRUFDMUU7QUFDQSxTQUFPLEdBQUcsU0FBUyxLQUFLLFNBQVMsYUFBYSxDQUFDO0FBQy9DLFNBQU8sR0FBRyxTQUFTLEtBQUssU0FBUyxVQUFVLENBQUM7QUFDNUMsU0FBTyxHQUFHLFNBQVMsS0FBSyxTQUFTLDBDQUEwQyxDQUFDO0FBQzlFLENBQUM7QUFFRCxLQUFLLG9FQUFvRSxNQUFNO0FBQzdFLFFBQU0sY0FBOEIsQ0FBQyxRQUFRLE9BQU8sWUFBWSxRQUFRLFFBQVEsT0FBTztBQUV2RixhQUFXLGNBQWMsYUFBYTtBQUNwQyxVQUFNLFdBQVcsZ0JBQWdCLEVBQUUsYUFBYSxRQUFRLFdBQVcsQ0FBQztBQUNwRSxVQUFNLGNBQWMsU0FBUyxLQUFLLE1BQU0sSUFBSSxFQUFFLE9BQU8sQ0FBQyxTQUFTLEtBQUssV0FBVyxTQUFTLENBQUM7QUFDekYsV0FBTyxVQUFVLGFBQWE7QUFBQSxNQUM1QixXQUFXLFVBQVUsUUFBUTtBQUFBLFFBQzNCLE1BQU07QUFBQSxRQUNOLEtBQUs7QUFBQSxRQUNMLFVBQVU7QUFBQSxRQUNWLE1BQU07QUFBQSxRQUNOLE1BQU07QUFBQSxRQUNOLE9BQU87QUFBQSxNQUNULEVBQUUsVUFBVSxDQUFDO0FBQUEsSUFDZixDQUFDO0FBQUEsRUFDSDtBQUNGLENBQUM7QUFFRCxLQUFLLHFFQUFxRSxNQUFNO0FBQzlFLFFBQU0sV0FBVyxnQkFBZ0IsRUFBRSxhQUFhLFFBQVEsWUFBWSxNQUFNLENBQUM7QUFFM0UsU0FBTyxHQUFHLFNBQVMsS0FBSyxTQUFTLGtDQUFrQyxDQUFDO0FBQ3BFLFNBQU8sR0FBRyxTQUFTLEtBQUssU0FBUyxnREFBZ0QsQ0FBQztBQUNsRixTQUFPLEdBQUcsU0FBUyxLQUFLLFNBQVMsK0NBQStDLENBQUM7QUFDakYsU0FBTyxHQUFHLENBQUMsU0FBUyxLQUFLLFNBQVMsNkJBQTZCLENBQUM7QUFDbEUsQ0FBQztBQUVELEtBQUssNERBQTRELE1BQU07QUFDckUsUUFBTSxXQUFXLGdCQUFnQjtBQUFBLElBQy9CLGFBQWE7QUFBQSxJQUNiLFdBQVc7QUFBQSxJQUNYLGFBQWE7QUFBQSxJQUNiLGdCQUFnQjtBQUFBLEVBQ2xCLENBQUM7QUFFRCxTQUFPLE1BQU0sU0FBUyxPQUFPLGtCQUFrQjtBQUMvQyxTQUFPLEdBQUcsU0FBUyxLQUFLLFNBQVMsNkJBQTZCLENBQUM7QUFDL0QsU0FBTyxHQUFHLFNBQVMsS0FBSyxTQUFTLDhDQUE4QyxDQUFDO0FBQ2xGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
