import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatMilestoneIssueBody,
  formatSlicePRBody,
  formatTaskIssueBody,
  formatSummaryComment,
  formatSwarmLanePRBody,
  formatSwarmReleaseChecklistBody,
  SWARM_LANE_LABELS
} from "../templates.js";
describe("templates", () => {
  describe("formatMilestoneIssueBody", () => {
    it("includes title and vision", () => {
      const body = formatMilestoneIssueBody({
        id: "M001",
        title: "Build Auth",
        vision: "Secure authentication for all users"
      });
      assert.ok(body.includes("M001: Build Auth"));
      assert.ok(body.includes("Secure authentication"));
    });
    it("renders success criteria as checkboxes", () => {
      const body = formatMilestoneIssueBody({
        id: "M001",
        title: "Auth",
        successCriteria: ["Users can log in", "OAuth works"]
      });
      assert.ok(body.includes("- [ ] Users can log in"));
      assert.ok(body.includes("- [ ] OAuth works"));
    });
    it("renders slice table", () => {
      const body = formatMilestoneIssueBody({
        id: "M001",
        title: "Auth",
        slices: [
          { id: "S01", title: "Core types", taskCount: 3 },
          { id: "S02", title: "OAuth", taskCount: 5 }
        ]
      });
      assert.ok(body.includes("| S01 | Core types | 3 |"));
      assert.ok(body.includes("| S02 | OAuth | 5 |"));
    });
  });
  describe("formatSlicePRBody", () => {
    it("includes goal and must-haves", () => {
      const body = formatSlicePRBody({
        id: "S01",
        title: "Core Auth Types",
        goal: "Define all auth types",
        mustHaves: ["User type", "Session type"]
      });
      assert.ok(body.includes("Define all auth types"));
      assert.ok(body.includes("- User type"));
      assert.ok(body.includes("- Session type"));
      assert.ok(body.includes("## Linked Issue"));
      assert.ok(body.includes("## Tests Run"));
      assert.ok(body.includes("## AI Assistance Disclosure"));
    });
    it("renders task checklist with issue links", () => {
      const body = formatSlicePRBody({
        id: "S01",
        title: "Auth",
        tasks: [
          { id: "T01", title: "Types", issueNumber: 43 },
          { id: "T02", title: "Schema" }
        ]
      });
      assert.ok(body.includes("- [ ] T01: Types (#43)"));
      assert.ok(body.includes("- [ ] T02: Schema"));
      assert.ok(!body.includes("T02: Schema (#"));
      assert.ok(body.includes("Related issues: #43"));
    });
  });
  describe("formatTaskIssueBody", () => {
    it("includes files and verification", () => {
      const body = formatTaskIssueBody({
        id: "T01",
        title: "Add types",
        files: ["src/types.ts"],
        verifyCriteria: ["Types compile"]
      });
      assert.ok(body.includes("`src/types.ts`"));
      assert.ok(body.includes("- [ ] Types compile"));
    });
  });
  describe("formatSummaryComment", () => {
    it("includes one-liner and body", () => {
      const comment = formatSummaryComment({
        oneLiner: "Added retry logic",
        body: "Implemented exponential backoff"
      });
      assert.ok(comment.includes("**Summary:** Added retry logic"));
      assert.ok(comment.includes("Implemented exponential backoff"));
    });
    it("wraps frontmatter in details block", () => {
      const comment = formatSummaryComment({
        frontmatter: { duration: "45m", key_files: ["a.ts"] }
      });
      assert.ok(comment.includes("<details>"));
      assert.ok(comment.includes("duration:"));
    });
    it("handles empty data gracefully \u2014 no debug-artifact output", () => {
      const comment = formatSummaryComment({});
      assert.equal(typeof comment, "string");
      assert.doesNotMatch(
        comment,
        /^undefined$|^\[object Object\]$|^null$/,
        "empty-data comment must not be a debug-style stringified artifact"
      );
      assert.doesNotMatch(
        comment,
        /\{\{\s*\w+\s*\}\}/,
        "empty-data comment must not leak unsubstituted {{placeholders}}"
      );
    });
    it("empty input produces empty comment \u2014 callers gate on truthiness", () => {
      const comment = formatSummaryComment({});
      assert.equal(
        comment,
        "",
        "empty data must return exactly '' so callers can `if (comment)` gate"
      );
    });
  });
  describe("swarm delivery routines", () => {
    it("formats lane PR bodies with impact, risks, rollback, and evidence", () => {
      const body = formatSwarmLanePRBody({
        lane: {
          id: "writer",
          branch: "lane/single-writer",
          owner: "@owner",
          latestCommit: "abc1234",
          changedContracts: ["WriterToken"],
          testEvidence: ["npm run typecheck:extensions"]
        },
        impactArea: "Single-writer UOK metadata.",
        transitionRisks: ["Writer token lifecycle regression"],
        rollbackPlan: ["Disable writer sequence enrichment"],
        linkedIssue: 123
      });
      assert.ok(body.includes("`lane/writer`"));
      assert.ok(body.includes("Single-writer UOK metadata."));
      assert.ok(body.includes("- [ ] Writer token lifecycle regression"));
      assert.ok(body.includes("- Disable writer sequence enrichment"));
      assert.ok(body.includes("- npm run typecheck:extensions"));
      assert.ok(body.includes("Closes #123"));
      assert.ok(body.includes("## AI Assistance Disclosure"));
    });
    it("formats release checklist bodies from lane state", () => {
      const body = formatSwarmReleaseChecklistBody({
        integrationBranch: "integration/uok-swarm",
        lanes: [
          { id: "workflow", branch: "lane/workflow-engine", owner: "@a", latestCommit: "1111111" },
          { id: "state", branch: "lane/state-machine", blockers: ["matrix gap"] }
        ],
        parityReport: "No critical mismatches.",
        rollbackDrill: "Passed fallback drill.",
        requiredChecks: ["unit", "integration"]
      });
      assert.ok(body.includes("`integration/uok-swarm`"));
      assert.ok(body.includes("| `lane/workflow` | `lane/workflow-engine` | @a | `1111111` | ready |"));
      assert.ok(body.includes("| `lane/state` | `lane/state-machine` |  |  | blocked |"));
      assert.ok(body.includes("- [ ] UOK parity report attached or linked"));
      assert.ok(body.includes("- [ ] unit"));
      assert.ok(body.includes("Passed fallback drill."));
    });
    it("declares expected swarm lane labels for generated GitHub routines", () => {
      assert.deepEqual(Object.values(SWARM_LANE_LABELS), [
        "lane/workflow",
        "lane/state",
        "lane/writer",
        "lane/uok",
        "lane/github"
      ]);
    });
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dpdGh1Yi1zeW5jL3Rlc3RzL3RlbXBsYXRlcy50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBQcm9qZWN0L0FwcDogR1NELTJcbi8vIEZpbGUgUHVycG9zZTogVGVzdHMgZm9yIEdpdEh1YiBzeW5jIG1hcmtkb3duIGZvcm1hdHRlcnMuXG5cbmltcG9ydCB7IGRlc2NyaWJlLCBpdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHtcbiAgZm9ybWF0TWlsZXN0b25lSXNzdWVCb2R5LFxuICBmb3JtYXRTbGljZVBSQm9keSxcbiAgZm9ybWF0VGFza0lzc3VlQm9keSxcbiAgZm9ybWF0U3VtbWFyeUNvbW1lbnQsXG4gIGZvcm1hdFN3YXJtTGFuZVBSQm9keSxcbiAgZm9ybWF0U3dhcm1SZWxlYXNlQ2hlY2tsaXN0Qm9keSxcbiAgU1dBUk1fTEFORV9MQUJFTFMsXG59IGZyb20gXCIuLi90ZW1wbGF0ZXMudHNcIjtcblxuZGVzY3JpYmUoXCJ0ZW1wbGF0ZXNcIiwgKCkgPT4ge1xuICBkZXNjcmliZShcImZvcm1hdE1pbGVzdG9uZUlzc3VlQm9keVwiLCAoKSA9PiB7XG4gICAgaXQoXCJpbmNsdWRlcyB0aXRsZSBhbmQgdmlzaW9uXCIsICgpID0+IHtcbiAgICAgIGNvbnN0IGJvZHkgPSBmb3JtYXRNaWxlc3RvbmVJc3N1ZUJvZHkoe1xuICAgICAgICBpZDogXCJNMDAxXCIsXG4gICAgICAgIHRpdGxlOiBcIkJ1aWxkIEF1dGhcIixcbiAgICAgICAgdmlzaW9uOiBcIlNlY3VyZSBhdXRoZW50aWNhdGlvbiBmb3IgYWxsIHVzZXJzXCIsXG4gICAgICB9KTtcbiAgICAgIGFzc2VydC5vayhib2R5LmluY2x1ZGVzKFwiTTAwMTogQnVpbGQgQXV0aFwiKSk7XG4gICAgICBhc3NlcnQub2soYm9keS5pbmNsdWRlcyhcIlNlY3VyZSBhdXRoZW50aWNhdGlvblwiKSk7XG4gICAgfSk7XG5cbiAgICBpdChcInJlbmRlcnMgc3VjY2VzcyBjcml0ZXJpYSBhcyBjaGVja2JveGVzXCIsICgpID0+IHtcbiAgICAgIGNvbnN0IGJvZHkgPSBmb3JtYXRNaWxlc3RvbmVJc3N1ZUJvZHkoe1xuICAgICAgICBpZDogXCJNMDAxXCIsXG4gICAgICAgIHRpdGxlOiBcIkF1dGhcIixcbiAgICAgICAgc3VjY2Vzc0NyaXRlcmlhOiBbXCJVc2VycyBjYW4gbG9nIGluXCIsIFwiT0F1dGggd29ya3NcIl0sXG4gICAgICB9KTtcbiAgICAgIGFzc2VydC5vayhib2R5LmluY2x1ZGVzKFwiLSBbIF0gVXNlcnMgY2FuIGxvZyBpblwiKSk7XG4gICAgICBhc3NlcnQub2soYm9keS5pbmNsdWRlcyhcIi0gWyBdIE9BdXRoIHdvcmtzXCIpKTtcbiAgICB9KTtcblxuICAgIGl0KFwicmVuZGVycyBzbGljZSB0YWJsZVwiLCAoKSA9PiB7XG4gICAgICBjb25zdCBib2R5ID0gZm9ybWF0TWlsZXN0b25lSXNzdWVCb2R5KHtcbiAgICAgICAgaWQ6IFwiTTAwMVwiLFxuICAgICAgICB0aXRsZTogXCJBdXRoXCIsXG4gICAgICAgIHNsaWNlczogW1xuICAgICAgICAgIHsgaWQ6IFwiUzAxXCIsIHRpdGxlOiBcIkNvcmUgdHlwZXNcIiwgdGFza0NvdW50OiAzIH0sXG4gICAgICAgICAgeyBpZDogXCJTMDJcIiwgdGl0bGU6IFwiT0F1dGhcIiwgdGFza0NvdW50OiA1IH0sXG4gICAgICAgIF0sXG4gICAgICB9KTtcbiAgICAgIGFzc2VydC5vayhib2R5LmluY2x1ZGVzKFwifCBTMDEgfCBDb3JlIHR5cGVzIHwgMyB8XCIpKTtcbiAgICAgIGFzc2VydC5vayhib2R5LmluY2x1ZGVzKFwifCBTMDIgfCBPQXV0aCB8IDUgfFwiKSk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKFwiZm9ybWF0U2xpY2VQUkJvZHlcIiwgKCkgPT4ge1xuICAgIGl0KFwiaW5jbHVkZXMgZ29hbCBhbmQgbXVzdC1oYXZlc1wiLCAoKSA9PiB7XG4gICAgICBjb25zdCBib2R5ID0gZm9ybWF0U2xpY2VQUkJvZHkoe1xuICAgICAgICBpZDogXCJTMDFcIixcbiAgICAgICAgdGl0bGU6IFwiQ29yZSBBdXRoIFR5cGVzXCIsXG4gICAgICAgIGdvYWw6IFwiRGVmaW5lIGFsbCBhdXRoIHR5cGVzXCIsXG4gICAgICAgIG11c3RIYXZlczogW1wiVXNlciB0eXBlXCIsIFwiU2Vzc2lvbiB0eXBlXCJdLFxuICAgICAgfSk7XG4gICAgICBhc3NlcnQub2soYm9keS5pbmNsdWRlcyhcIkRlZmluZSBhbGwgYXV0aCB0eXBlc1wiKSk7XG4gICAgICBhc3NlcnQub2soYm9keS5pbmNsdWRlcyhcIi0gVXNlciB0eXBlXCIpKTtcbiAgICAgIGFzc2VydC5vayhib2R5LmluY2x1ZGVzKFwiLSBTZXNzaW9uIHR5cGVcIikpO1xuICAgICAgYXNzZXJ0Lm9rKGJvZHkuaW5jbHVkZXMoXCIjIyBMaW5rZWQgSXNzdWVcIikpO1xuICAgICAgYXNzZXJ0Lm9rKGJvZHkuaW5jbHVkZXMoXCIjIyBUZXN0cyBSdW5cIikpO1xuICAgICAgYXNzZXJ0Lm9rKGJvZHkuaW5jbHVkZXMoXCIjIyBBSSBBc3Npc3RhbmNlIERpc2Nsb3N1cmVcIikpO1xuICAgIH0pO1xuXG4gICAgaXQoXCJyZW5kZXJzIHRhc2sgY2hlY2tsaXN0IHdpdGggaXNzdWUgbGlua3NcIiwgKCkgPT4ge1xuICAgICAgY29uc3QgYm9keSA9IGZvcm1hdFNsaWNlUFJCb2R5KHtcbiAgICAgICAgaWQ6IFwiUzAxXCIsXG4gICAgICAgIHRpdGxlOiBcIkF1dGhcIixcbiAgICAgICAgdGFza3M6IFtcbiAgICAgICAgICB7IGlkOiBcIlQwMVwiLCB0aXRsZTogXCJUeXBlc1wiLCBpc3N1ZU51bWJlcjogNDMgfSxcbiAgICAgICAgICB7IGlkOiBcIlQwMlwiLCB0aXRsZTogXCJTY2hlbWFcIiB9LFxuICAgICAgICBdLFxuICAgICAgfSk7XG4gICAgICBhc3NlcnQub2soYm9keS5pbmNsdWRlcyhcIi0gWyBdIFQwMTogVHlwZXMgKCM0MylcIikpO1xuICAgICAgYXNzZXJ0Lm9rKGJvZHkuaW5jbHVkZXMoXCItIFsgXSBUMDI6IFNjaGVtYVwiKSk7XG4gICAgICBhc3NlcnQub2soIWJvZHkuaW5jbHVkZXMoXCJUMDI6IFNjaGVtYSAoI1wiKSk7XG4gICAgICBhc3NlcnQub2soYm9keS5pbmNsdWRlcyhcIlJlbGF0ZWQgaXNzdWVzOiAjNDNcIikpO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZShcImZvcm1hdFRhc2tJc3N1ZUJvZHlcIiwgKCkgPT4ge1xuICAgIGl0KFwiaW5jbHVkZXMgZmlsZXMgYW5kIHZlcmlmaWNhdGlvblwiLCAoKSA9PiB7XG4gICAgICBjb25zdCBib2R5ID0gZm9ybWF0VGFza0lzc3VlQm9keSh7XG4gICAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgICB0aXRsZTogXCJBZGQgdHlwZXNcIixcbiAgICAgICAgZmlsZXM6IFtcInNyYy90eXBlcy50c1wiXSxcbiAgICAgICAgdmVyaWZ5Q3JpdGVyaWE6IFtcIlR5cGVzIGNvbXBpbGVcIl0sXG4gICAgICB9KTtcbiAgICAgIGFzc2VydC5vayhib2R5LmluY2x1ZGVzKFwiYHNyYy90eXBlcy50c2BcIikpO1xuICAgICAgYXNzZXJ0Lm9rKGJvZHkuaW5jbHVkZXMoXCItIFsgXSBUeXBlcyBjb21waWxlXCIpKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoXCJmb3JtYXRTdW1tYXJ5Q29tbWVudFwiLCAoKSA9PiB7XG4gICAgaXQoXCJpbmNsdWRlcyBvbmUtbGluZXIgYW5kIGJvZHlcIiwgKCkgPT4ge1xuICAgICAgY29uc3QgY29tbWVudCA9IGZvcm1hdFN1bW1hcnlDb21tZW50KHtcbiAgICAgICAgb25lTGluZXI6IFwiQWRkZWQgcmV0cnkgbG9naWNcIixcbiAgICAgICAgYm9keTogXCJJbXBsZW1lbnRlZCBleHBvbmVudGlhbCBiYWNrb2ZmXCIsXG4gICAgICB9KTtcbiAgICAgIGFzc2VydC5vayhjb21tZW50LmluY2x1ZGVzKFwiKipTdW1tYXJ5OioqIEFkZGVkIHJldHJ5IGxvZ2ljXCIpKTtcbiAgICAgIGFzc2VydC5vayhjb21tZW50LmluY2x1ZGVzKFwiSW1wbGVtZW50ZWQgZXhwb25lbnRpYWwgYmFja29mZlwiKSk7XG4gICAgfSk7XG5cbiAgICBpdChcIndyYXBzIGZyb250bWF0dGVyIGluIGRldGFpbHMgYmxvY2tcIiwgKCkgPT4ge1xuICAgICAgY29uc3QgY29tbWVudCA9IGZvcm1hdFN1bW1hcnlDb21tZW50KHtcbiAgICAgICAgZnJvbnRtYXR0ZXI6IHsgZHVyYXRpb246IFwiNDVtXCIsIGtleV9maWxlczogW1wiYS50c1wiXSB9LFxuICAgICAgfSk7XG4gICAgICBhc3NlcnQub2soY29tbWVudC5pbmNsdWRlcyhcIjxkZXRhaWxzPlwiKSk7XG4gICAgICBhc3NlcnQub2soY29tbWVudC5pbmNsdWRlcyhcImR1cmF0aW9uOlwiKSk7XG4gICAgfSk7XG5cbiAgICBpdChcImhhbmRsZXMgZW1wdHkgZGF0YSBncmFjZWZ1bGx5IFx1MjAxNCBubyBkZWJ1Zy1hcnRpZmFjdCBvdXRwdXRcIiwgKCkgPT4ge1xuICAgICAgLy8gUHJldmlvdXMgdmVyc2lvbiBvbmx5IGFzc2VydGVkIGB0eXBlb2YgPT09ICdzdHJpbmcnYCwgd2hpY2ggdGhlXG4gICAgICAvLyBmdW5jdGlvbiBzaWduYXR1cmUgYWxyZWFkeSBndWFyYW50ZWVzICh0YXV0b2xvZ3kpLlxuICAgICAgLy9cbiAgICAgIC8vIFRoZSByZWFsIGludmFyaWFudCBpczogZW1wdHkgaW5wdXQgbXVzdCBwcm9kdWNlIGEgc3RyaW5nIHRoYXRcbiAgICAgIC8vIGlzIHNhZmUgdG8gcG9zdCAob3Igc2tpcCkgd2l0aG91dCBsZWFraW5nIGEgZGVidWctc3RyaW5naWZpZWRcbiAgICAgIC8vIG9iamVjdC4gQW4gZW1wdHkgc3RyaW5nIElTIGFsbG93ZWQgaGVyZSBcdTIwMTQgY2FsbGVycyBhcmUgZXhwZWN0ZWRcbiAgICAgIC8vIHRvIGdhdGUgb24gdHJ1dGhpbmVzcyBiZWZvcmUgcG9zdGluZyAoXCJza2lwIGlmIGVtcHR5XCIpLiBXaGF0XG4gICAgICAvLyBtdXN0IE5PVCBoYXBwZW4gaXMgbGVha2luZyAndW5kZWZpbmVkJywgJ1tvYmplY3QgT2JqZWN0XScsXG4gICAgICAvLyAnbnVsbCcsIG9yIGEgdGVtcGxhdGUtcGxhY2Vob2xkZXIgdGVsbCBsaWtlICd7eycgLyAnfX0nLlxuICAgICAgY29uc3QgY29tbWVudCA9IGZvcm1hdFN1bW1hcnlDb21tZW50KHt9KTtcbiAgICAgIGFzc2VydC5lcXVhbCh0eXBlb2YgY29tbWVudCwgXCJzdHJpbmdcIik7XG4gICAgICBhc3NlcnQuZG9lc05vdE1hdGNoKFxuICAgICAgICBjb21tZW50LFxuICAgICAgICAvXnVuZGVmaW5lZCR8XlxcW29iamVjdCBPYmplY3RcXF0kfF5udWxsJC8sXG4gICAgICAgIFwiZW1wdHktZGF0YSBjb21tZW50IG11c3Qgbm90IGJlIGEgZGVidWctc3R5bGUgc3RyaW5naWZpZWQgYXJ0aWZhY3RcIixcbiAgICAgICk7XG4gICAgICBhc3NlcnQuZG9lc05vdE1hdGNoKFxuICAgICAgICBjb21tZW50LFxuICAgICAgICAvXFx7XFx7XFxzKlxcdytcXHMqXFx9XFx9LyxcbiAgICAgICAgXCJlbXB0eS1kYXRhIGNvbW1lbnQgbXVzdCBub3QgbGVhayB1bnN1YnN0aXR1dGVkIHt7cGxhY2Vob2xkZXJzfX1cIixcbiAgICAgICk7XG4gICAgfSk7XG5cbiAgICBpdChcImVtcHR5IGlucHV0IHByb2R1Y2VzIGVtcHR5IGNvbW1lbnQgXHUyMDE0IGNhbGxlcnMgZ2F0ZSBvbiB0cnV0aGluZXNzXCIsICgpID0+IHtcbiAgICAgIC8vIFNpc3RlciB0byB0aGUgcHJldmlvdXMgdGVzdDogdGhpcyBsb2NrcyBpbiB0aGUgY3VycmVudCBiZWhhdmlvdXJcbiAgICAgIC8vIHRoYXQgZW1wdHkgaW5wdXQgcmV0dXJucyBlbXB0eSBzdHJpbmcsIHNvIGEgcmVncmVzc2lvbiB0aGF0XG4gICAgICAvLyB1bmV4cGVjdGVkbHkgc3RhcnRzIGVtaXR0aW5nIGEgbm9uLWVtcHR5IGRlZmF1bHQgKHdoaWNoIHdvdWxkXG4gICAgICAvLyB0aGVuIHBvc3Qgc3BhbSBjb21tZW50cyBmb3IgZXZlcnkgYmFyZS1kYXRhIG1pbGVzdG9uZSkgZmFpbHMuXG4gICAgICBjb25zdCBjb21tZW50ID0gZm9ybWF0U3VtbWFyeUNvbW1lbnQoe30pO1xuICAgICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgICBjb21tZW50LFxuICAgICAgICBcIlwiLFxuICAgICAgICBcImVtcHR5IGRhdGEgbXVzdCByZXR1cm4gZXhhY3RseSAnJyBzbyBjYWxsZXJzIGNhbiBgaWYgKGNvbW1lbnQpYCBnYXRlXCIsXG4gICAgICApO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZShcInN3YXJtIGRlbGl2ZXJ5IHJvdXRpbmVzXCIsICgpID0+IHtcbiAgICBpdChcImZvcm1hdHMgbGFuZSBQUiBib2RpZXMgd2l0aCBpbXBhY3QsIHJpc2tzLCByb2xsYmFjaywgYW5kIGV2aWRlbmNlXCIsICgpID0+IHtcbiAgICAgIGNvbnN0IGJvZHkgPSBmb3JtYXRTd2FybUxhbmVQUkJvZHkoe1xuICAgICAgICBsYW5lOiB7XG4gICAgICAgICAgaWQ6IFwid3JpdGVyXCIsXG4gICAgICAgICAgYnJhbmNoOiBcImxhbmUvc2luZ2xlLXdyaXRlclwiLFxuICAgICAgICAgIG93bmVyOiBcIkBvd25lclwiLFxuICAgICAgICAgIGxhdGVzdENvbW1pdDogXCJhYmMxMjM0XCIsXG4gICAgICAgICAgY2hhbmdlZENvbnRyYWN0czogW1wiV3JpdGVyVG9rZW5cIl0sXG4gICAgICAgICAgdGVzdEV2aWRlbmNlOiBbXCJucG0gcnVuIHR5cGVjaGVjazpleHRlbnNpb25zXCJdLFxuICAgICAgICB9LFxuICAgICAgICBpbXBhY3RBcmVhOiBcIlNpbmdsZS13cml0ZXIgVU9LIG1ldGFkYXRhLlwiLFxuICAgICAgICB0cmFuc2l0aW9uUmlza3M6IFtcIldyaXRlciB0b2tlbiBsaWZlY3ljbGUgcmVncmVzc2lvblwiXSxcbiAgICAgICAgcm9sbGJhY2tQbGFuOiBbXCJEaXNhYmxlIHdyaXRlciBzZXF1ZW5jZSBlbnJpY2htZW50XCJdLFxuICAgICAgICBsaW5rZWRJc3N1ZTogMTIzLFxuICAgICAgfSk7XG5cbiAgICAgIGFzc2VydC5vayhib2R5LmluY2x1ZGVzKFwiYGxhbmUvd3JpdGVyYFwiKSk7XG4gICAgICBhc3NlcnQub2soYm9keS5pbmNsdWRlcyhcIlNpbmdsZS13cml0ZXIgVU9LIG1ldGFkYXRhLlwiKSk7XG4gICAgICBhc3NlcnQub2soYm9keS5pbmNsdWRlcyhcIi0gWyBdIFdyaXRlciB0b2tlbiBsaWZlY3ljbGUgcmVncmVzc2lvblwiKSk7XG4gICAgICBhc3NlcnQub2soYm9keS5pbmNsdWRlcyhcIi0gRGlzYWJsZSB3cml0ZXIgc2VxdWVuY2UgZW5yaWNobWVudFwiKSk7XG4gICAgICBhc3NlcnQub2soYm9keS5pbmNsdWRlcyhcIi0gbnBtIHJ1biB0eXBlY2hlY2s6ZXh0ZW5zaW9uc1wiKSk7XG4gICAgICBhc3NlcnQub2soYm9keS5pbmNsdWRlcyhcIkNsb3NlcyAjMTIzXCIpKTtcbiAgICAgIGFzc2VydC5vayhib2R5LmluY2x1ZGVzKFwiIyMgQUkgQXNzaXN0YW5jZSBEaXNjbG9zdXJlXCIpKTtcbiAgICB9KTtcblxuICAgIGl0KFwiZm9ybWF0cyByZWxlYXNlIGNoZWNrbGlzdCBib2RpZXMgZnJvbSBsYW5lIHN0YXRlXCIsICgpID0+IHtcbiAgICAgIGNvbnN0IGJvZHkgPSBmb3JtYXRTd2FybVJlbGVhc2VDaGVja2xpc3RCb2R5KHtcbiAgICAgICAgaW50ZWdyYXRpb25CcmFuY2g6IFwiaW50ZWdyYXRpb24vdW9rLXN3YXJtXCIsXG4gICAgICAgIGxhbmVzOiBbXG4gICAgICAgICAgeyBpZDogXCJ3b3JrZmxvd1wiLCBicmFuY2g6IFwibGFuZS93b3JrZmxvdy1lbmdpbmVcIiwgb3duZXI6IFwiQGFcIiwgbGF0ZXN0Q29tbWl0OiBcIjExMTExMTFcIiB9LFxuICAgICAgICAgIHsgaWQ6IFwic3RhdGVcIiwgYnJhbmNoOiBcImxhbmUvc3RhdGUtbWFjaGluZVwiLCBibG9ja2VyczogW1wibWF0cml4IGdhcFwiXSB9LFxuICAgICAgICBdLFxuICAgICAgICBwYXJpdHlSZXBvcnQ6IFwiTm8gY3JpdGljYWwgbWlzbWF0Y2hlcy5cIixcbiAgICAgICAgcm9sbGJhY2tEcmlsbDogXCJQYXNzZWQgZmFsbGJhY2sgZHJpbGwuXCIsXG4gICAgICAgIHJlcXVpcmVkQ2hlY2tzOiBbXCJ1bml0XCIsIFwiaW50ZWdyYXRpb25cIl0sXG4gICAgICB9KTtcblxuICAgICAgYXNzZXJ0Lm9rKGJvZHkuaW5jbHVkZXMoXCJgaW50ZWdyYXRpb24vdW9rLXN3YXJtYFwiKSk7XG4gICAgICBhc3NlcnQub2soYm9keS5pbmNsdWRlcyhcInwgYGxhbmUvd29ya2Zsb3dgIHwgYGxhbmUvd29ya2Zsb3ctZW5naW5lYCB8IEBhIHwgYDExMTExMTFgIHwgcmVhZHkgfFwiKSk7XG4gICAgICBhc3NlcnQub2soYm9keS5pbmNsdWRlcyhcInwgYGxhbmUvc3RhdGVgIHwgYGxhbmUvc3RhdGUtbWFjaGluZWAgfCAgfCAgfCBibG9ja2VkIHxcIikpO1xuICAgICAgYXNzZXJ0Lm9rKGJvZHkuaW5jbHVkZXMoXCItIFsgXSBVT0sgcGFyaXR5IHJlcG9ydCBhdHRhY2hlZCBvciBsaW5rZWRcIikpO1xuICAgICAgYXNzZXJ0Lm9rKGJvZHkuaW5jbHVkZXMoXCItIFsgXSB1bml0XCIpKTtcbiAgICAgIGFzc2VydC5vayhib2R5LmluY2x1ZGVzKFwiUGFzc2VkIGZhbGxiYWNrIGRyaWxsLlwiKSk7XG4gICAgfSk7XG5cbiAgICBpdChcImRlY2xhcmVzIGV4cGVjdGVkIHN3YXJtIGxhbmUgbGFiZWxzIGZvciBnZW5lcmF0ZWQgR2l0SHViIHJvdXRpbmVzXCIsICgpID0+IHtcbiAgICAgIGFzc2VydC5kZWVwRXF1YWwoT2JqZWN0LnZhbHVlcyhTV0FSTV9MQU5FX0xBQkVMUyksIFtcbiAgICAgICAgXCJsYW5lL3dvcmtmbG93XCIsXG4gICAgICAgIFwibGFuZS9zdGF0ZVwiLFxuICAgICAgICBcImxhbmUvd3JpdGVyXCIsXG4gICAgICAgIFwibGFuZS91b2tcIixcbiAgICAgICAgXCJsYW5lL2dpdGh1YlwiLFxuICAgICAgXSk7XG4gICAgfSk7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFHQSxTQUFTLFVBQVUsVUFBVTtBQUM3QixPQUFPLFlBQVk7QUFDbkI7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUVQLFNBQVMsYUFBYSxNQUFNO0FBQzFCLFdBQVMsNEJBQTRCLE1BQU07QUFDekMsT0FBRyw2QkFBNkIsTUFBTTtBQUNwQyxZQUFNLE9BQU8seUJBQXlCO0FBQUEsUUFDcEMsSUFBSTtBQUFBLFFBQ0osT0FBTztBQUFBLFFBQ1AsUUFBUTtBQUFBLE1BQ1YsQ0FBQztBQUNELGFBQU8sR0FBRyxLQUFLLFNBQVMsa0JBQWtCLENBQUM7QUFDM0MsYUFBTyxHQUFHLEtBQUssU0FBUyx1QkFBdUIsQ0FBQztBQUFBLElBQ2xELENBQUM7QUFFRCxPQUFHLDBDQUEwQyxNQUFNO0FBQ2pELFlBQU0sT0FBTyx5QkFBeUI7QUFBQSxRQUNwQyxJQUFJO0FBQUEsUUFDSixPQUFPO0FBQUEsUUFDUCxpQkFBaUIsQ0FBQyxvQkFBb0IsYUFBYTtBQUFBLE1BQ3JELENBQUM7QUFDRCxhQUFPLEdBQUcsS0FBSyxTQUFTLHdCQUF3QixDQUFDO0FBQ2pELGFBQU8sR0FBRyxLQUFLLFNBQVMsbUJBQW1CLENBQUM7QUFBQSxJQUM5QyxDQUFDO0FBRUQsT0FBRyx1QkFBdUIsTUFBTTtBQUM5QixZQUFNLE9BQU8seUJBQXlCO0FBQUEsUUFDcEMsSUFBSTtBQUFBLFFBQ0osT0FBTztBQUFBLFFBQ1AsUUFBUTtBQUFBLFVBQ04sRUFBRSxJ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
