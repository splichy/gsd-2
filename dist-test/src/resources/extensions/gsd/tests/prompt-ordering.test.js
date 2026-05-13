import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reorderForCaching, analyzeCacheEfficiency } from "../prompt-ordering.js";
describe("reorderForCaching", () => {
  it("reorders static sections before dynamic sections", () => {
    const prompt = [
      "## Inlined Task Plan",
      "Do the task steps here.",
      "",
      "## Output Template",
      "Use this template.",
      "",
      "## Resume State",
      "Resuming from checkpoint."
    ].join("\n");
    const result = reorderForCaching(prompt);
    const outputIdx = result.indexOf("## Output Template");
    const taskIdx = result.indexOf("## Inlined Task Plan");
    const resumeIdx = result.indexOf("## Resume State");
    assert.ok(outputIdx < taskIdx, "Static 'Output Template' should come before dynamic 'Inlined Task Plan'");
    assert.ok(outputIdx < resumeIdx, "Static 'Output Template' should come before dynamic 'Resume State'");
  });
  it("preserves preamble at the beginning", () => {
    const prompt = [
      "You are executing GSD auto-mode.",
      "",
      "## Output Template",
      "Template content.",
      "",
      "## Inlined Task Plan",
      "Task content."
    ].join("\n");
    const result = reorderForCaching(prompt);
    assert.ok(
      result.startsWith("You are executing GSD auto-mode."),
      "Preamble should remain at the start"
    );
  });
  it("preserves relative order within groups", () => {
    const prompt = [
      "## Decisions",
      "Decision A.",
      "",
      "## Requirements",
      "Requirement B.",
      "",
      "## Overrides",
      "Override C."
    ].join("\n");
    const result = reorderForCaching(prompt);
    const decisionsIdx = result.indexOf("## Decisions");
    const requirementsIdx = result.indexOf("## Requirements");
    const overridesIdx = result.indexOf("## Overrides");
    assert.ok(decisionsIdx < requirementsIdx, "Decisions should come before Requirements (same group order)");
    assert.ok(requirementsIdx < overridesIdx, "Requirements should come before Overrides (same group order)");
  });
  it("handles prompts with no headings (returns unchanged)", () => {
    const prompt = "Just plain text with no markdown headings at all.";
    const result = reorderForCaching(prompt);
    assert.equal(result, prompt);
  });
  it("handles prompts with only static sections", () => {
    const prompt = [
      "## Output Template",
      "Template A.",
      "",
      "## Executor Context Constraints",
      "Constraints B."
    ].join("\n");
    const result = reorderForCaching(prompt);
    assert.ok(result.indexOf("## Output Template") < result.indexOf("## Executor Context Constraints"));
  });
  it("handles prompts with only dynamic sections", () => {
    const prompt = [
      "## Inlined Task Plan",
      "Plan A.",
      "",
      "## Resume State",
      "State B.",
      "",
      "## Verification",
      "Check C."
    ].join("\n");
    const result = reorderForCaching(prompt);
    const planIdx = result.indexOf("## Inlined Task Plan");
    const resumeIdx = result.indexOf("## Resume State");
    const verifyIdx = result.indexOf("## Verification");
    assert.ok(planIdx < resumeIdx);
    assert.ok(resumeIdx < verifyIdx);
  });
  it("unknown headings default to dynamic", () => {
    const prompt = [
      "## Output Template",
      "Static content.",
      "",
      "## Some Unknown Section",
      "Unknown content.",
      "",
      "## Decisions",
      "Semi-static content."
    ].join("\n");
    const result = reorderForCaching(prompt);
    const staticIdx = result.indexOf("## Output Template");
    const semiIdx = result.indexOf("## Decisions");
    const unknownIdx = result.indexOf("## Some Unknown Section");
    assert.ok(staticIdx < semiIdx, "Static before semi-static");
    assert.ok(semiIdx < unknownIdx, "Semi-static before unknown (dynamic)");
  });
  it("sub-headings stay with their parent section", () => {
    const prompt = [
      "## Slice Plan Excerpt",
      "Slice content.",
      "### Task List",
      "- T1.1",
      "- T1.2",
      "",
      "## Inlined Task Plan",
      "Dynamic task content."
    ].join("\n");
    const result = reorderForCaching(prompt);
    const sliceIdx = result.indexOf("## Slice Plan Excerpt");
    const taskListIdx = result.indexOf("### Task List");
    const inlinedIdx = result.indexOf("## Inlined Task Plan");
    assert.ok(sliceIdx < taskListIdx, "Sub-heading stays after its parent");
    assert.ok(taskListIdx < inlinedIdx, "Sub-heading block comes before dynamic section");
  });
});
describe("analyzeCacheEfficiency", () => {
  it("returns correct ratios", () => {
    const prompt = [
      "Preamble text here.",
      "",
      "## Output Template",
      "Static content here.",
      "",
      "## Decisions",
      "Semi-static content.",
      "",
      "## Inlined Task Plan",
      "Dynamic content here."
    ].join("\n");
    const result = analyzeCacheEfficiency(prompt);
    assert.ok(result.totalChars > 0, "totalChars should be positive");
    assert.ok(result.staticChars > 0, "staticChars should be positive (includes preamble)");
    assert.ok(result.semiStaticChars > 0, "semiStaticChars should be positive");
    assert.ok(result.dynamicChars > 0, "dynamicChars should be positive");
    assert.ok(result.cacheEfficiency > 0 && result.cacheEfficiency < 1, "efficiency should be between 0 and 1");
    assert.equal(
      result.totalChars,
      result.staticChars + result.semiStaticChars + result.dynamicChars,
      "chars should sum to total"
    );
  });
  it("returns 1.0 efficiency for all-static prompts", () => {
    const prompt = [
      "## Output Template",
      "All static.",
      "",
      "## Executor Context Constraints",
      "Also static."
    ].join("\n");
    const result = analyzeCacheEfficiency(prompt);
    assert.equal(result.cacheEfficiency, 1);
    assert.equal(result.dynamicChars, 0);
  });
  it("returns 0 efficiency for all-dynamic prompts", () => {
    const prompt = [
      "## Inlined Task Plan",
      "All dynamic.",
      "",
      "## Resume State",
      "Also dynamic."
    ].join("\n");
    const result = analyzeCacheEfficiency(prompt);
    assert.equal(result.cacheEfficiency, 0);
    assert.equal(result.staticChars, 0);
    assert.equal(result.semiStaticChars, 0);
  });
});
describe("real-world prompt reordering", () => {
  it("reorders a realistic execute-task prompt for better cache efficiency", () => {
    const prompt = [
      "You are executing GSD auto-mode.",
      "",
      '## UNIT: Execute Task T1.2 ("Add login") -- Slice S1 ("Auth"), Milestone M1',
      "",
      "## Working Directory",
      "Your working directory is `/project`.",
      "",
      "## Overrides",
      "No overrides.",
      "",
      "## Resume State",
      "Resuming from step 3.",
      "",
      "## Carry-Forward Context",
      "Previous task noted the API uses JWT.",
      "",
      "## Inlined Task Plan",
      "1. Create auth endpoint",
      "2. Add JWT validation",
      "3. Write tests",
      "",
      "## Slice Plan Excerpt",
      "Tasks: T1.1, T1.2, T1.3",
      "Verification: run tests",
      "",
      "## Decisions",
      "Using bcrypt for password hashing.",
      "",
      "## Requirements",
      "Must support OAuth2.",
      "",
      "## Prior Task Summaries",
      "T1.1 completed: scaffolded auth module.",
      "",
      "## Backing Source Artifacts",
      "- Slice plan: `.gsd/slices/S1.md`",
      "",
      "## Output Template",
      "Use standard task summary format.",
      "",
      "## Verification",
      "Run `npm test` and verify all pass."
    ].join("\n");
    const beforeEfficiency = analyzeCacheEfficiency(prompt);
    const reordered = reorderForCaching(prompt);
    const afterEfficiency = analyzeCacheEfficiency(reordered);
    assert.equal(beforeEfficiency.cacheEfficiency, afterEfficiency.cacheEfficiency);
    const outputTemplateIdx = reordered.indexOf("## Output Template");
    const workingDirIdx = reordered.indexOf("## Working Directory");
    const backingIdx = reordered.indexOf("## Backing Source Artifacts");
    const decisionsIdx = reordered.indexOf("## Decisions");
    const requirementsIdx = reordered.indexOf("## Requirements");
    const sliceIdx = reordered.indexOf("## Slice Plan Excerpt");
    const taskPlanIdx = reordered.indexOf("## Inlined Task Plan");
    const resumeIdx = reordered.indexOf("## Resume State");
    const verifyIdx = reordered.indexOf("## Verification");
    assert.ok(outputTemplateIdx < decisionsIdx, "Static before semi-static");
    assert.ok(workingDirIdx < sliceIdx, "Static before semi-static");
    assert.ok(backingIdx < requirementsIdx, "Static before semi-static");
    assert.ok(decisionsIdx < taskPlanIdx, "Semi-static before dynamic");
    assert.ok(requirementsIdx < resumeIdx, "Semi-static before dynamic");
    assert.ok(sliceIdx < verifyIdx, "Semi-static before dynamic");
    assert.ok(
      reordered.startsWith("You are executing GSD auto-mode."),
      "Preamble preserved at start"
    );
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wcm9tcHQtb3JkZXJpbmcudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgZGVzY3JpYmUsIGl0IH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyByZW9yZGVyRm9yQ2FjaGluZywgYW5hbHl6ZUNhY2hlRWZmaWNpZW5jeSB9IGZyb20gXCIuLi9wcm9tcHQtb3JkZXJpbmcuanNcIjtcblxuZGVzY3JpYmUoXCJyZW9yZGVyRm9yQ2FjaGluZ1wiLCAoKSA9PiB7XG4gIGl0KFwicmVvcmRlcnMgc3RhdGljIHNlY3Rpb25zIGJlZm9yZSBkeW5hbWljIHNlY3Rpb25zXCIsICgpID0+IHtcbiAgICBjb25zdCBwcm9tcHQgPSBbXG4gICAgICBcIiMjIElubGluZWQgVGFzayBQbGFuXCIsXG4gICAgICBcIkRvIHRoZSB0YXNrIHN0ZXBzIGhlcmUuXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBPdXRwdXQgVGVtcGxhdGVcIixcbiAgICAgIFwiVXNlIHRoaXMgdGVtcGxhdGUuXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBSZXN1bWUgU3RhdGVcIixcbiAgICAgIFwiUmVzdW1pbmcgZnJvbSBjaGVja3BvaW50LlwiLFxuICAgIF0uam9pbihcIlxcblwiKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IHJlb3JkZXJGb3JDYWNoaW5nKHByb21wdCk7XG4gICAgY29uc3Qgb3V0cHV0SWR4ID0gcmVzdWx0LmluZGV4T2YoXCIjIyBPdXRwdXQgVGVtcGxhdGVcIik7XG4gICAgY29uc3QgdGFza0lkeCA9IHJlc3VsdC5pbmRleE9mKFwiIyMgSW5saW5lZCBUYXNrIFBsYW5cIik7XG4gICAgY29uc3QgcmVzdW1lSWR4ID0gcmVzdWx0LmluZGV4T2YoXCIjIyBSZXN1bWUgU3RhdGVcIik7XG5cbiAgICBhc3NlcnQub2sob3V0cHV0SWR4IDwgdGFza0lkeCwgXCJTdGF0aWMgJ091dHB1dCBUZW1wbGF0ZScgc2hvdWxkIGNvbWUgYmVmb3JlIGR5bmFtaWMgJ0lubGluZWQgVGFzayBQbGFuJ1wiKTtcbiAgICBhc3NlcnQub2sob3V0cHV0SWR4IDwgcmVzdW1lSWR4LCBcIlN0YXRpYyAnT3V0cHV0IFRlbXBsYXRlJyBzaG91bGQgY29tZSBiZWZvcmUgZHluYW1pYyAnUmVzdW1lIFN0YXRlJ1wiKTtcbiAgfSk7XG5cbiAgaXQoXCJwcmVzZXJ2ZXMgcHJlYW1ibGUgYXQgdGhlIGJlZ2lubmluZ1wiLCAoKSA9PiB7XG4gICAgY29uc3QgcHJvbXB0ID0gW1xuICAgICAgXCJZb3UgYXJlIGV4ZWN1dGluZyBHU0QgYXV0by1tb2RlLlwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyMgT3V0cHV0IFRlbXBsYXRlXCIsXG4gICAgICBcIlRlbXBsYXRlIGNvbnRlbnQuXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBJbmxpbmVkIFRhc2sgUGxhblwiLFxuICAgICAgXCJUYXNrIGNvbnRlbnQuXCIsXG4gICAgXS5qb2luKFwiXFxuXCIpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gcmVvcmRlckZvckNhY2hpbmcocHJvbXB0KTtcbiAgICBhc3NlcnQub2soXG4gICAgICByZXN1bHQuc3RhcnRzV2l0aChcIllvdSBhcmUgZXhlY3V0aW5nIEdTRCBhdXRvLW1vZGUuXCIpLFxuICAgICAgXCJQcmVhbWJsZSBzaG91bGQgcmVtYWluIGF0IHRoZSBzdGFydFwiLFxuICAgICk7XG4gIH0pO1xuXG4gIGl0KFwicHJlc2VydmVzIHJlbGF0aXZlIG9yZGVyIHdpdGhpbiBncm91cHNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHByb21wdCA9IFtcbiAgICAgIFwiIyMgRGVjaXNpb25zXCIsXG4gICAgICBcIkRlY2lzaW9uIEEuXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBSZXF1aXJlbWVudHNcIixcbiAgICAgIFwiUmVxdWlyZW1lbnQgQi5cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIE92ZXJyaWRlc1wiLFxuICAgICAgXCJPdmVycmlkZSBDLlwiLFxuICAgIF0uam9pbihcIlxcblwiKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IHJlb3JkZXJGb3JDYWNoaW5nKHByb21wdCk7XG4gICAgY29uc3QgZGVjaXNpb25zSWR4ID0gcmVzdWx0LmluZGV4T2YoXCIjIyBEZWNpc2lvbnNcIik7XG4gICAgY29uc3QgcmVxdWlyZW1lbnRzSWR4ID0gcmVzdWx0LmluZGV4T2YoXCIjIyBSZXF1aXJlbWVudHNcIik7XG4gICAgY29uc3Qgb3ZlcnJpZGVzSWR4ID0gcmVzdWx0LmluZGV4T2YoXCIjIyBPdmVycmlkZXNcIik7XG5cbiAgICBhc3NlcnQub2soZGVjaXNpb25zSWR4IDwgcmVxdWlyZW1lbnRzSWR4LCBcIkRlY2lzaW9ucyBzaG91bGQgY29tZSBiZWZvcmUgUmVxdWlyZW1lbnRzIChzYW1lIGdyb3VwIG9yZGVyKVwiKTtcbiAgICBhc3NlcnQub2socmVxdWlyZW1lbnRzSWR4IDwgb3ZlcnJpZGVzSWR4LCBcIlJlcXVpcmVtZW50cyBzaG91bGQgY29tZSBiZWZvcmUgT3ZlcnJpZGVzIChzYW1lIGdyb3VwIG9yZGVyKVwiKTtcbiAgfSk7XG5cbiAgaXQoXCJoYW5kbGVzIHByb21wdHMgd2l0aCBubyBoZWFkaW5ncyAocmV0dXJucyB1bmNoYW5nZWQpXCIsICgpID0+IHtcbiAgICBjb25zdCBwcm9tcHQgPSBcIkp1c3QgcGxhaW4gdGV4dCB3aXRoIG5vIG1hcmtkb3duIGhlYWRpbmdzIGF0IGFsbC5cIjtcbiAgICBjb25zdCByZXN1bHQgPSByZW9yZGVyRm9yQ2FjaGluZyhwcm9tcHQpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIHByb21wdCk7XG4gIH0pO1xuXG4gIGl0KFwiaGFuZGxlcyBwcm9tcHRzIHdpdGggb25seSBzdGF0aWMgc2VjdGlvbnNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHByb21wdCA9IFtcbiAgICAgIFwiIyMgT3V0cHV0IFRlbXBsYXRlXCIsXG4gICAgICBcIlRlbXBsYXRlIEEuXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBFeGVjdXRvciBDb250ZXh0IENvbnN0cmFpbnRzXCIsXG4gICAgICBcIkNvbnN0cmFpbnRzIEIuXCIsXG4gICAgXS5qb2luKFwiXFxuXCIpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gcmVvcmRlckZvckNhY2hpbmcocHJvbXB0KTtcbiAgICAvLyBCb3RoIGFyZSBzdGF0aWMsIG9yZGVyIHByZXNlcnZlZFxuICAgIGFzc2VydC5vayhyZXN1bHQuaW5kZXhPZihcIiMjIE91dHB1dCBUZW1wbGF0ZVwiKSA8IHJlc3VsdC5pbmRleE9mKFwiIyMgRXhlY3V0b3IgQ29udGV4dCBDb25zdHJhaW50c1wiKSk7XG4gIH0pO1xuXG4gIGl0KFwiaGFuZGxlcyBwcm9tcHRzIHdpdGggb25seSBkeW5hbWljIHNlY3Rpb25zXCIsICgpID0+IHtcbiAgICBjb25zdCBwcm9tcHQgPSBbXG4gICAgICBcIiMjIElubGluZWQgVGFzayBQbGFuXCIsXG4gICAgICBcIlBsYW4gQS5cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIFJlc3VtZSBTdGF0ZVwiLFxuICAgICAgXCJTdGF0ZSBCLlwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyMgVmVyaWZpY2F0aW9uXCIsXG4gICAgICBcIkNoZWNrIEMuXCIsXG4gICAgXS5qb2luKFwiXFxuXCIpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gcmVvcmRlckZvckNhY2hpbmcocHJvbXB0KTtcbiAgICAvLyBBbGwgZHluYW1pYywgb3JkZXIgcHJlc2VydmVkXG4gICAgY29uc3QgcGxhbklkeCA9IHJlc3VsdC5pbmRleE9mKFwiIyMgSW5saW5lZCBUYXNrIFBsYW5cIik7XG4gICAgY29uc3QgcmVzdW1lSWR4ID0gcmVzdWx0LmluZGV4T2YoXCIjIyBSZXN1bWUgU3RhdGVcIik7XG4gICAgY29uc3QgdmVyaWZ5SWR4ID0gcmVzdWx0LmluZGV4T2YoXCIjIyBWZXJpZmljYXRpb25cIik7XG4gICAgYXNzZXJ0Lm9rKHBsYW5JZHggPCByZXN1bWVJZHgpO1xuICAgIGFzc2VydC5vayhyZXN1bWVJZHggPCB2ZXJpZnlJZHgpO1xuICB9KTtcblxuICBpdChcInVua25vd24gaGVhZGluZ3MgZGVmYXVsdCB0byBkeW5hbWljXCIsICgpID0+IHtcbiAgICBjb25zdCBwcm9tcHQgPSBbXG4gICAgICBcIiMjIE91dHB1dCBUZW1wbGF0ZVwiLFxuICAgICAgXCJTdGF0aWMgY29udGVudC5cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIFNvbWUgVW5rbm93biBTZWN0aW9uXCIsXG4gICAgICBcIlVua25vd24gY29udGVudC5cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIERlY2lzaW9uc1wiLFxuICAgICAgXCJTZW1pLXN0YXRpYyBjb250ZW50LlwiLFxuICAgIF0uam9pbihcIlxcblwiKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IHJlb3JkZXJGb3JDYWNoaW5nKHByb21wdCk7XG4gICAgY29uc3Qgc3RhdGljSWR4ID0gcmVzdWx0LmluZGV4T2YoXCIjIyBPdXRwdXQgVGVtcGxhdGVcIik7XG4gICAgY29uc3Qgc2VtaUlkeCA9IHJlc3VsdC5pbmRleE9mKFwiIyMgRGVjaXNpb25zXCIpO1xuICAgIGNvbnN0IHVua25vd25JZHggPSByZXN1bHQuaW5kZXhPZihcIiMjIFNvbWUgVW5rbm93biBTZWN0aW9uXCIpO1xuXG4gICAgYXNzZXJ0Lm9rKHN0YXRpY0lkeCA8IHNlbWlJZHgsIFwiU3RhdGljIGJlZm9yZSBzZW1pLXN0YXRpY1wiKTtcbiAgICBhc3NlcnQub2soc2VtaUlkeCA8IHVua25vd25JZHgsIFwiU2VtaS1zdGF0aWMgYmVmb3JlIHVua25vd24gKGR5bmFtaWMpXCIpO1xuICB9KTtcblxuICBpdChcInN1Yi1oZWFkaW5ncyBzdGF5IHdpdGggdGhlaXIgcGFyZW50IHNlY3Rpb25cIiwgKCkgPT4ge1xuICAgIGNvbnN0IHByb21wdCA9IFtcbiAgICAgIFwiIyMgU2xpY2UgUGxhbiBFeGNlcnB0XCIsXG4gICAgICBcIlNsaWNlIGNvbnRlbnQuXCIsXG4gICAgICBcIiMjIyBUYXNrIExpc3RcIixcbiAgICAgIFwiLSBUMS4xXCIsXG4gICAgICBcIi0gVDEuMlwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyMgSW5saW5lZCBUYXNrIFBsYW5cIixcbiAgICAgIFwiRHluYW1pYyB0YXNrIGNvbnRlbnQuXCIsXG4gICAgXS5qb2luKFwiXFxuXCIpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gcmVvcmRlckZvckNhY2hpbmcocHJvbXB0KTtcbiAgICAvLyBUaGUgIyMjIFRhc2sgTGlzdCBzaG91bGQgc3RheSB3aXRoICMjIFNsaWNlIFBsYW4gRXhjZXJwdFxuICAgIGNvbnN0IHNsaWNlSWR4ID0gcmVzdWx0LmluZGV4T2YoXCIjIyBTbGljZSBQbGFuIEV4Y2VycHRcIik7XG4gICAgY29uc3QgdGFza0xpc3RJZHggPSByZXN1bHQuaW5kZXhPZihcIiMjIyBUYXNrIExpc3RcIik7XG4gICAgY29uc3QgaW5saW5lZElkeCA9IHJlc3VsdC5pbmRleE9mKFwiIyMgSW5saW5lZCBUYXNrIFBsYW5cIik7XG5cbiAgICBhc3NlcnQub2soc2xpY2VJZHggPCB0YXNrTGlzdElkeCwgXCJTdWItaGVhZGluZyBzdGF5cyBhZnRlciBpdHMgcGFyZW50XCIpO1xuICAgIGFzc2VydC5vayh0YXNrTGlzdElkeCA8IGlubGluZWRJZHgsIFwiU3ViLWhlYWRpbmcgYmxvY2sgY29tZXMgYmVmb3JlIGR5bmFtaWMgc2VjdGlvblwiKTtcbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoXCJhbmFseXplQ2FjaGVFZmZpY2llbmN5XCIsICgpID0+IHtcbiAgaXQoXCJyZXR1cm5zIGNvcnJlY3QgcmF0aW9zXCIsICgpID0+IHtcbiAgICBjb25zdCBwcm9tcHQgPSBbXG4gICAgICBcIlByZWFtYmxlIHRleHQgaGVyZS5cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIE91dHB1dCBUZW1wbGF0ZVwiLFxuICAgICAgXCJTdGF0aWMgY29udGVudCBoZXJlLlwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyMgRGVjaXNpb25zXCIsXG4gICAgICBcIlNlbWktc3RhdGljIGNvbnRlbnQuXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBJbmxpbmVkIFRhc2sgUGxhblwiLFxuICAgICAgXCJEeW5hbWljIGNvbnRlbnQgaGVyZS5cIixcbiAgICBdLmpvaW4oXCJcXG5cIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhbmFseXplQ2FjaGVFZmZpY2llbmN5KHByb21wdCk7XG5cbiAgICBhc3NlcnQub2socmVzdWx0LnRvdGFsQ2hhcnMgPiAwLCBcInRvdGFsQ2hhcnMgc2hvdWxkIGJlIHBvc2l0aXZlXCIpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuc3RhdGljQ2hhcnMgPiAwLCBcInN0YXRpY0NoYXJzIHNob3VsZCBiZSBwb3NpdGl2ZSAoaW5jbHVkZXMgcHJlYW1ibGUpXCIpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuc2VtaVN0YXRpY0NoYXJzID4gMCwgXCJzZW1pU3RhdGljQ2hhcnMgc2hvdWxkIGJlIHBvc2l0aXZlXCIpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuZHluYW1pY0NoYXJzID4gMCwgXCJkeW5hbWljQ2hhcnMgc2hvdWxkIGJlIHBvc2l0aXZlXCIpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuY2FjaGVFZmZpY2llbmN5ID4gMCAmJiByZXN1bHQuY2FjaGVFZmZpY2llbmN5IDwgMSwgXCJlZmZpY2llbmN5IHNob3VsZCBiZSBiZXR3ZWVuIDAgYW5kIDFcIik7XG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgcmVzdWx0LnRvdGFsQ2hhcnMsXG4gICAgICByZXN1bHQuc3RhdGljQ2hhcnMgKyByZXN1bHQuc2VtaVN0YXRpY0NoYXJzICsgcmVzdWx0LmR5bmFtaWNDaGFycyxcbiAgICAgIFwiY2hhcnMgc2hvdWxkIHN1bSB0byB0b3RhbFwiLFxuICAgICk7XG4gIH0pO1xuXG4gIGl0KFwicmV0dXJucyAxLjAgZWZmaWNpZW5jeSBmb3IgYWxsLXN0YXRpYyBwcm9tcHRzXCIsICgpID0+IHtcbiAgICBjb25zdCBwcm9tcHQgPSBbXG4gICAgICBcIiMjIE91dHB1dCBUZW1wbGF0ZVwiLFxuICAgICAgXCJBbGwgc3RhdGljLlwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyMgRXhlY3V0b3IgQ29udGV4dCBDb25zdHJhaW50c1wiLFxuICAgICAgXCJBbHNvIHN0YXRpYy5cIixcbiAgICBdLmpvaW4oXCJcXG5cIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhbmFseXplQ2FjaGVFZmZpY2llbmN5KHByb21wdCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5jYWNoZUVmZmljaWVuY3ksIDEuMCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5keW5hbWljQ2hhcnMsIDApO1xuICB9KTtcblxuICBpdChcInJldHVybnMgMCBlZmZpY2llbmN5IGZvciBhbGwtZHluYW1pYyBwcm9tcHRzXCIsICgpID0+IHtcbiAgICBjb25zdCBwcm9tcHQgPSBbXG4gICAgICBcIiMjIElubGluZWQgVGFzayBQbGFuXCIsXG4gICAgICBcIkFsbCBkeW5hbWljLlwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyMgUmVzdW1lIFN0YXRlXCIsXG4gICAgICBcIkFsc28gZHluYW1pYy5cIixcbiAgICBdLmpvaW4oXCJcXG5cIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhbmFseXplQ2FjaGVFZmZpY2llbmN5KHByb21wdCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5jYWNoZUVmZmljaWVuY3ksIDApO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc3RhdGljQ2hhcnMsIDApO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc2VtaVN0YXRpY0NoYXJzLCAwKTtcbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoXCJyZWFsLXdvcmxkIHByb21wdCByZW9yZGVyaW5nXCIsICgpID0+IHtcbiAgaXQoXCJyZW9yZGVycyBhIHJlYWxpc3RpYyBleGVjdXRlLXRhc2sgcHJvbXB0IGZvciBiZXR0ZXIgY2FjaGUgZWZmaWNpZW5jeVwiLCAoKSA9PiB7XG4gICAgLy8gU2ltdWxhdGUgYSBwcm9tcHQgcmVzZW1ibGluZyBidWlsZEV4ZWN1dGVUYXNrUHJvbXB0IG91dHB1dFxuICAgIGNvbnN0IHByb21wdCA9IFtcbiAgICAgIFwiWW91IGFyZSBleGVjdXRpbmcgR1NEIGF1dG8tbW9kZS5cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIFVOSVQ6IEV4ZWN1dGUgVGFzayBUMS4yIChcXFwiQWRkIGxvZ2luXFxcIikgLS0gU2xpY2UgUzEgKFxcXCJBdXRoXFxcIiksIE1pbGVzdG9uZSBNMVwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyMgV29ya2luZyBEaXJlY3RvcnlcIixcbiAgICAgIFwiWW91ciB3b3JraW5nIGRpcmVjdG9yeSBpcyBgL3Byb2plY3RgLlwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyMgT3ZlcnJpZGVzXCIsXG4gICAgICBcIk5vIG92ZXJyaWRlcy5cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIFJlc3VtZSBTdGF0ZVwiLFxuICAgICAgXCJSZXN1bWluZyBmcm9tIHN0ZXAgMy5cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIENhcnJ5LUZvcndhcmQgQ29udGV4dFwiLFxuICAgICAgXCJQcmV2aW91cyB0YXNrIG5vdGVkIHRoZSBBUEkgdXNlcyBKV1QuXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBJbmxpbmVkIFRhc2sgUGxhblwiLFxuICAgICAgXCIxLiBDcmVhdGUgYXV0aCBlbmRwb2ludFwiLFxuICAgICAgXCIyLiBBZGQgSldUIHZhbGlkYXRpb25cIixcbiAgICAgIFwiMy4gV3JpdGUgdGVzdHNcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIFNsaWNlIFBsYW4gRXhjZXJwdFwiLFxuICAgICAgXCJUYXNrczogVDEuMSwgVDEuMiwgVDEuM1wiLFxuICAgICAgXCJWZXJpZmljYXRpb246IHJ1biB0ZXN0c1wiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyMgRGVjaXNpb25zXCIsXG4gICAgICBcIlVzaW5nIGJjcnlwdCBmb3IgcGFzc3dvcmQgaGFzaGluZy5cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIFJlcXVpcmVtZW50c1wiLFxuICAgICAgXCJNdXN0IHN1cHBvcnQgT0F1dGgyLlwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyMgUHJpb3IgVGFzayBTdW1tYXJpZXNcIixcbiAgICAgIFwiVDEuMSBjb21wbGV0ZWQ6IHNjYWZmb2xkZWQgYXV0aCBtb2R1bGUuXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBCYWNraW5nIFNvdXJjZSBBcnRpZmFjdHNcIixcbiAgICAgIFwiLSBTbGljZSBwbGFuOiBgLmdzZC9zbGljZXMvUzEubWRgXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBPdXRwdXQgVGVtcGxhdGVcIixcbiAgICAgIFwiVXNlIHN0YW5kYXJkIHRhc2sgc3VtbWFyeSBmb3JtYXQuXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBWZXJpZmljYXRpb25cIixcbiAgICAgIFwiUnVuIGBucG0gdGVzdGAgYW5kIHZlcmlmeSBhbGwgcGFzcy5cIixcbiAgICBdLmpvaW4oXCJcXG5cIik7XG5cbiAgICBjb25zdCBiZWZvcmVFZmZpY2llbmN5ID0gYW5hbHl6ZUNhY2hlRWZmaWNpZW5jeShwcm9tcHQpO1xuICAgIGNvbnN0IHJlb3JkZXJlZCA9IHJlb3JkZXJGb3JDYWNoaW5nKHByb21wdCk7XG4gICAgY29uc3QgYWZ0ZXJFZmZpY2llbmN5ID0gYW5hbHl6ZUNhY2hlRWZmaWNpZW5jeShyZW9yZGVyZWQpO1xuXG4gICAgLy8gRWZmaWNpZW5jeSBzY29yZSBkb2Vzbid0IGNoYW5nZSAoc2FtZSBjb250ZW50KSwgYnV0IG9yZGVyaW5nIGltcHJvdmVzIGNhY2hlIHByZWZpeFxuICAgIGFzc2VydC5lcXVhbChiZWZvcmVFZmZpY2llbmN5LmNhY2hlRWZmaWNpZW5jeSwgYWZ0ZXJFZmZpY2llbmN5LmNhY2hlRWZmaWNpZW5jeSk7XG5cbiAgICAvLyBWZXJpZnkgc3RhdGljIHNlY3Rpb25zIGNvbWUgZmlyc3QgKGFmdGVyIHByZWFtYmxlICsgVU5JVCBoZWFkaW5nIHdoaWNoIGlzIGR5bmFtaWMpXG4gICAgY29uc3Qgb3V0cHV0VGVtcGxhdGVJZHggPSByZW9yZGVyZWQuaW5kZXhPZihcIiMjIE91dHB1dCBUZW1wbGF0ZVwiKTtcbiAgICBjb25zdCB3b3JraW5nRGlySWR4ID0gcmVvcmRlcmVkLmluZGV4T2YoXCIjIyBXb3JraW5nIERpcmVjdG9yeVwiKTtcbiAgICBjb25zdCBiYWNraW5nSWR4ID0gcmVvcmRlcmVkLmluZGV4T2YoXCIjIyBCYWNraW5nIFNvdXJjZSBBcnRpZmFjdHNcIik7XG5cbiAgICAvLyBTZW1pLXN0YXRpYyBzZWN0aW9ucyBjb21lIGFmdGVyIHN0YXRpY1xuICAgIGNvbnN0IGRlY2lzaW9uc0lkeCA9IHJlb3JkZXJlZC5pbmRleE9mKFwiIyMgRGVjaXNpb25zXCIpO1xuICAgIGNvbnN0IHJlcXVpcmVtZW50c0lkeCA9IHJlb3JkZXJlZC5pbmRleE9mKFwiIyMgUmVxdWlyZW1lbnRzXCIpO1xuICAgIGNvbnN0IHNsaWNlSWR4ID0gcmVvcmRlcmVkLmluZGV4T2YoXCIjIyBTbGljZSBQbGFuIEV4Y2VycHRcIik7XG5cbiAgICAvLyBEeW5hbWljIHNlY3Rpb25zIGNvbWUgbGFzdFxuICAgIGNvbnN0IHRhc2tQbGFuSWR4ID0gcmVvcmRlcmVkLmluZGV4T2YoXCIjIyBJbmxpbmVkIFRhc2sgUGxhblwiKTtcbiAgICBjb25zdCByZXN1bWVJZHggPSByZW9yZGVyZWQuaW5kZXhPZihcIiMjIFJlc3VtZSBTdGF0ZVwiKTtcbiAgICBjb25zdCB2ZXJpZnlJZHggPSByZW9yZGVyZWQuaW5kZXhPZihcIiMjIFZlcmlmaWNhdGlvblwiKTtcblxuICAgIC8vIFN0YXRpYyBiZWZvcmUgc2VtaS1zdGF0aWNcbiAgICBhc3NlcnQub2sob3V0cHV0VGVtcGxhdGVJZHggPCBkZWNpc2lvbnNJZHgsIFwiU3RhdGljIGJlZm9yZSBzZW1pLXN0YXRpY1wiKTtcbiAgICBhc3NlcnQub2sod29ya2luZ0RpcklkeCA8IHNsaWNlSWR4LCBcIlN0YXRpYyBiZWZvcmUgc2VtaS1zdGF0aWNcIik7XG4gICAgYXNzZXJ0Lm9rKGJhY2tpbmdJZHggPCByZXF1aXJlbWVudHNJZHgsIFwiU3RhdGljIGJlZm9yZSBzZW1pLXN0YXRpY1wiKTtcblxuICAgIC8vIFNlbWktc3RhdGljIGJlZm9yZSBkeW5hbWljXG4gICAgYXNzZXJ0Lm9rKGRlY2lzaW9uc0lkeCA8IHRhc2tQbGFuSWR4LCBcIlNlbWktc3RhdGljIGJlZm9yZSBkeW5hbWljXCIpO1xuICAgIGFzc2VydC5vayhyZXF1aXJlbWVudHNJZHggPCByZXN1bWVJZHgsIFwiU2VtaS1zdGF0aWMgYmVmb3JlIGR5bmFtaWNcIik7XG4gICAgYXNzZXJ0Lm9rKHNsaWNlSWR4IDwgdmVyaWZ5SWR4LCBcIlNlbWktc3RhdGljIGJlZm9yZSBkeW5hbWljXCIpO1xuXG4gICAgLy8gUHJlYW1ibGUgc3RpbGwgZmlyc3RcbiAgICBhc3NlcnQub2soXG4gICAgICByZW9yZGVyZWQuc3RhcnRzV2l0aChcIllvdSBhcmUgZXhlY3V0aW5nIEdTRCBhdXRvLW1vZGUuXCIpLFxuICAgICAgXCJQcmVhbWJsZSBwcmVzZXJ2ZWQgYXQgc3RhcnRcIixcbiAgICApO1xuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxVQUFVLFVBQVU7QUFDN0IsT0FBTyxZQUFZO0FBQ25CLFNBQVMsbUJBQW1CLDhCQUE4QjtBQUUxRCxTQUFTLHFCQUFxQixNQUFNO0FBQ2xDLEtBQUcsb0RBQW9ELE1BQU07QUFDM0QsVUFBTSxTQUFTO0FBQUEsTUFDYjtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxJQUNGLEVBQUUsS0FBSyxJQUFJO0FBRVgsVUFBTSxTQUFT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
