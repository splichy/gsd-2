import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { invalidateAllCaches } from "../cache.js";
import {
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  upsertMilestonePlanning
} from "../gsd-db.js";
function makeBase(prefix) {
  const base = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  return base;
}
function cleanup(base) {
  try {
    closeDatabase();
  } catch {
  }
  invalidateAllCaches();
  rmSync(base, { recursive: true, force: true });
}
async function loadAutoPromptBuilders(t) {
  const previousGsdHome = process.env.GSD_HOME;
  const isolatedHome = mkdtempSync(join(tmpdir(), "gsd-prompt-loader-home-"));
  process.env.GSD_HOME = isolatedHome;
  t.after(() => {
    if (previousGsdHome === void 0) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = previousGsdHome;
    rmSync(isolatedHome, { recursive: true, force: true });
  });
  return import(`../auto-prompts.ts?promptDupCuts=${Date.now()}-${Math.random()}`);
}
function seedDb(base, taskStatus = "complete") {
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Prompt Cuts", status: "active", depends_on: [] });
  upsertMilestonePlanning("M001", {
    title: "Prompt Cuts",
    status: "active",
    vision: "Reduce duplicate prompt reads.",
    successCriteria: ["Prompt builders render compact context."],
    keyRisks: [],
    proofStrategy: [],
    verificationContract: "",
    verificationIntegration: "",
    verificationOperational: "",
    verificationUat: "",
    definitionOfDone: [],
    requirementCoverage: "",
    boundaryMapMarkdown: ""
  });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Prompt Slice",
    status: "active",
    risk: "low",
    depends: [],
    demo: "",
    sequence: 1
  });
  insertTask({
    id: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    title: "Task one",
    status: taskStatus
  });
}
function writeRoadmapAndPlan(base) {
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
    [
      "# M001 Roadmap",
      "## Slices",
      "- [ ] **S01: Prompt Slice** `risk:low` `depends:[]`"
    ].join("\n")
  );
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"),
    [
      "# S01 Plan",
      "",
      "**Goal:** Reduce duplicate prompt reads.",
      "",
      "## Tasks",
      "- [x] **T01: Task one** `est:15m`"
    ].join("\n")
  );
}
function writeTaskSummary(base, options) {
  const narrative = options?.repeatedNarrative ?? "This full implementation narrative should stay out of closer prompts.";
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md"),
    [
      "---",
      "id: T01",
      "parent: S01",
      "milestone: M001",
      "provides:",
      "  - prompt context reduction",
      "key_files:",
      "  - src/resources/extensions/gsd/auto-prompts.ts",
      "key_decisions:",
      "  - use compact excerpts before full reads",
      "patterns_established:",
      "  - excerpt-first complete-slice context",
      "observability_surfaces: []",
      "duration: 15m",
      "verification_result: passed",
      "completed_at: 2026-05-06T12:00:00Z",
      `blocker_discovered: ${options?.blocker ? "true" : "false"}`,
      "---",
      "",
      "# T01: Task one",
      "**One-line result.**",
      "",
      "## What Happened",
      narrative,
      "",
      "## Verification",
      "node:test passed.",
      "",
      "## Diagnostics",
      "Prompt size stayed bounded."
    ].join("\n")
  );
}
test("execute-task rendering makes memory_query and template disk reads fallback-only", async (t) => {
  const base = makeBase("gsd-execute-dup-cuts-");
  t.after(() => cleanup(base));
  invalidateAllCaches();
  seedDb(base, "pending");
  writeRoadmapAndPlan(base);
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-PLAN.md"),
    "# T01 Plan\n\nDo the prompt edit.\n"
  );
  const { buildExecuteTaskPrompt } = await loadAutoPromptBuilders(t);
  const prompt = await buildExecuteTaskPrompt("M001", "S01", "Prompt Slice", "T01", "Task one", base);
  assert.match(prompt, /Call `memory_query`.*only when no injected memory block exists or the inlined memory\/context is insufficient/s);
  assert.doesNotMatch(prompt, /Call `memory_query` with 2-4 keywords from the task title and touched files unless this is purely mechanical/);
  assert.match(prompt, /Use the inlined Task Summary template below/);
  assert.match(prompt, /Read `.*task-summary\.md` only if the inlined template is absent or visibly truncated/);
  assert.doesNotMatch(prompt, /Read the template at `.*task-summary\.md`/);
  assert.match(prompt, /### Output Template: Task Summary/);
});
test("complete-slice renders task summary excerpts without full summary bodies", async (t) => {
  const base = makeBase("gsd-complete-slice-excerpts-");
  t.after(() => cleanup(base));
  invalidateAllCaches();
  seedDb(base);
  writeRoadmapAndPlan(base);
  const repeatedNarrative = "FULL_TASK_BODY_SHOULD_NOT_RENDER ".repeat(40);
  writeTaskSummary(base, { repeatedNarrative });
  const { buildCompleteSlicePrompt } = await loadAutoPromptBuilders(t);
  const prompt = await buildCompleteSlicePrompt("M001", "Prompt Cuts", "S01", "Prompt Slice", base);
  assert.match(prompt, /### Task Summary: T01 \(excerpt\)/);
  assert.match(prompt, /On-demand.*read `\.gsd\/milestones\/M001\/slices\/S01\/tasks\/T01-SUMMARY\.md` only when this excerpt is absent\/truncated/s);
  assert.doesNotMatch(prompt, /FULL_TASK_BODY_SHOULD_NOT_RENDER/);
  assert.match(prompt, /Review the inlined task-summary excerpts/);
});
test("complete-slice caps malformed task summaries instead of inlining full bodies", async (t) => {
  const base = makeBase("gsd-complete-slice-malformed-excerpts-");
  t.after(() => cleanup(base));
  invalidateAllCaches();
  seedDb(base);
  writeRoadmapAndPlan(base);
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md"),
    [
      "# Legacy summary without frontmatter id",
      "LEGACY_FULL_BODY_SHOULD_BE_CAPPED ".repeat(200)
    ].join("\n")
  );
  const { buildCompleteSlicePrompt } = await loadAutoPromptBuilders(t);
  const prompt = await buildCompleteSlicePrompt("M001", "Prompt Cuts", "S01", "Prompt Slice", base);
  assert.match(prompt, /Truncated malformed summary/);
  assert.ok(prompt.length < 2e4);
  assert.ok((prompt.match(/LEGACY_FULL_BODY_SHOULD_BE_CAPPED/g) ?? []).length < 60);
});
test("replan-slice renders blocker summary excerpt and tells the agent to read full only on demand", async (t) => {
  const base = makeBase("gsd-replan-excerpts-");
  t.after(() => cleanup(base));
  invalidateAllCaches();
  seedDb(base);
  writeRoadmapAndPlan(base);
  writeTaskSummary(base, {
    blocker: true,
    repeatedNarrative: "FULL_BLOCKER_BODY_SHOULD_NOT_RENDER ".repeat(40)
  });
  const { buildReplanSlicePrompt } = await loadAutoPromptBuilders(t);
  const prompt = await buildReplanSlicePrompt("M001", "Prompt Cuts", "S01", "Prompt Slice", base);
  assert.match(prompt, /### Blocker Task Summary: T01 \(excerpt\)/);
  assert.match(prompt, /Use the inlined blocker summary excerpt first/);
  assert.match(prompt, /Read the full blocker task summary only if the excerpt is absent, marked truncated, or lacks the specific blocker evidence needed to replan/);
  assert.doesNotMatch(prompt, /FULL_BLOCKER_BODY_SHOULD_NOT_RENDER/);
  assert.doesNotMatch(prompt, /Read the blocker task summary carefully/);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wcm9tcHQtZHVwbGljYXRpb24tY3V0cy50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBQcm9qZWN0L0FwcDogR1NELTJcbi8vIEZpbGUgUHVycG9zZTogVmVyaWZpZXMgbG93LXJpc2sgYXV0by1wcm9tcHQgZHVwbGljYXRpb24gY3V0cyByZW5kZXIgdGhyb3VnaCBwcm9tcHQgYnVpbGRlcnMuXG5cbmltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCB0eXBlIHsgVGVzdENvbnRleHQgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBta2RpclN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcblxuaW1wb3J0IHsgaW52YWxpZGF0ZUFsbENhY2hlcyB9IGZyb20gXCIuLi9jYWNoZS50c1wiO1xuaW1wb3J0IHtcbiAgY2xvc2VEYXRhYmFzZSxcbiAgaW5zZXJ0TWlsZXN0b25lLFxuICBpbnNlcnRTbGljZSxcbiAgaW5zZXJ0VGFzayxcbiAgb3BlbkRhdGFiYXNlLFxuICB1cHNlcnRNaWxlc3RvbmVQbGFubmluZyxcbn0gZnJvbSBcIi4uL2dzZC1kYi50c1wiO1xuXG50eXBlIEF1dG9Qcm9tcHRCdWlsZGVycyA9IHR5cGVvZiBpbXBvcnQoXCIuLi9hdXRvLXByb21wdHMudHNcIik7XG5cbmZ1bmN0aW9uIG1ha2VCYXNlKHByZWZpeDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgYmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIHByZWZpeCkpO1xuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMVwiLCBcInRhc2tzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgcmV0dXJuIGJhc2U7XG59XG5cbmZ1bmN0aW9uIGNsZWFudXAoYmFzZTogc3RyaW5nKTogdm9pZCB7XG4gIHRyeSB7IGNsb3NlRGF0YWJhc2UoKTsgfSBjYXRjaCB7IC8qIG5vb3AgKi8gfVxuICBpbnZhbGlkYXRlQWxsQ2FjaGVzKCk7XG4gIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGxvYWRBdXRvUHJvbXB0QnVpbGRlcnModDogVGVzdENvbnRleHQpOiBQcm9taXNlPEF1dG9Qcm9tcHRCdWlsZGVycz4ge1xuICBjb25zdCBwcmV2aW91c0dzZEhvbWUgPSBwcm9jZXNzLmVudi5HU0RfSE9NRTtcbiAgY29uc3QgaXNvbGF0ZWRIb21lID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtcHJvbXB0LWxvYWRlci1ob21lLVwiKSk7XG4gIHByb2Nlc3MuZW52LkdTRF9IT01FID0gaXNvbGF0ZWRIb21lO1xuICB0LmFmdGVyKCgpID0+IHtcbiAgICBpZiAocHJldmlvdXNHc2RIb21lID09PSB1bmRlZmluZWQpIGRlbGV0ZSBwcm9jZXNzLmVudi5HU0RfSE9NRTtcbiAgICBlbHNlIHByb2Nlc3MuZW52LkdTRF9IT01FID0gcHJldmlvdXNHc2RIb21lO1xuICAgIHJtU3luYyhpc29sYXRlZEhvbWUsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfSk7XG4gIHJldHVybiBpbXBvcnQoYC4uL2F1dG8tcHJvbXB0cy50cz9wcm9tcHREdXBDdXRzPSR7RGF0ZS5ub3coKX0tJHtNYXRoLnJhbmRvbSgpfWApIGFzIFByb21pc2U8QXV0b1Byb21wdEJ1aWxkZXJzPjtcbn1cblxuZnVuY3Rpb24gc2VlZERiKGJhc2U6IHN0cmluZywgdGFza1N0YXR1cyA9IFwiY29tcGxldGVcIik6IHZvaWQge1xuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJnc2QuZGJcIikpO1xuICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlByb21wdCBDdXRzXCIsIHN0YXR1czogXCJhY3RpdmVcIiwgZGVwZW5kc19vbjogW10gfSk7XG4gIHVwc2VydE1pbGVzdG9uZVBsYW5uaW5nKFwiTTAwMVwiLCB7XG4gICAgdGl0bGU6IFwiUHJvbXB0IEN1dHNcIixcbiAgICBzdGF0dXM6IFwiYWN0aXZlXCIsXG4gICAgdmlzaW9uOiBcIlJlZHVjZSBkdXBsaWNhdGUgcHJvbXB0IHJlYWRzLlwiLFxuICAgIHN1Y2Nlc3NDcml0ZXJpYTogW1wiUHJvbXB0IGJ1aWxkZXJzIHJlbmRlciBjb21wYWN0IGNvbnRleHQuXCJdLFxuICAgIGtleVJpc2tzOiBbXSxcbiAgICBwcm9vZlN0cmF0ZWd5OiBbXSxcbiAgICB2ZXJpZmljYXRpb25Db250cmFjdDogXCJcIixcbiAgICB2ZXJpZmljYXRpb25JbnRlZ3JhdGlvbjogXCJcIixcbiAgICB2ZXJpZmljYXRpb25PcGVyYXRpb25hbDogXCJcIixcbiAgICB2ZXJpZmljYXRpb25VYXQ6IFwiXCIsXG4gICAgZGVmaW5pdGlvbk9mRG9uZTogW10sXG4gICAgcmVxdWlyZW1lbnRDb3ZlcmFnZTogXCJcIixcbiAgICBib3VuZGFyeU1hcE1hcmtkb3duOiBcIlwiLFxuICB9KTtcbiAgaW5zZXJ0U2xpY2Uoe1xuICAgIGlkOiBcIlMwMVwiLFxuICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICB0aXRsZTogXCJQcm9tcHQgU2xpY2VcIixcbiAgICBzdGF0dXM6IFwiYWN0aXZlXCIsXG4gICAgcmlzazogXCJsb3dcIixcbiAgICBkZXBlbmRzOiBbXSxcbiAgICBkZW1vOiBcIlwiLFxuICAgIHNlcXVlbmNlOiAxLFxuICB9KTtcbiAgaW5zZXJ0VGFzayh7XG4gICAgaWQ6IFwiVDAxXCIsXG4gICAgc2xpY2VJZDogXCJTMDFcIixcbiAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgdGl0bGU6IFwiVGFzayBvbmVcIixcbiAgICBzdGF0dXM6IHRhc2tTdGF0dXMsXG4gIH0pO1xufVxuXG5mdW5jdGlvbiB3cml0ZVJvYWRtYXBBbmRQbGFuKGJhc2U6IHN0cmluZyk6IHZvaWQge1xuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJNMDAxLVJPQURNQVAubWRcIiksXG4gICAgW1xuICAgICAgXCIjIE0wMDEgUm9hZG1hcFwiLFxuICAgICAgXCIjIyBTbGljZXNcIixcbiAgICAgIFwiLSBbIF0gKipTMDE6IFByb21wdCBTbGljZSoqIGByaXNrOmxvd2AgYGRlcGVuZHM6W11gXCIsXG4gICAgXS5qb2luKFwiXFxuXCIpLFxuICApO1xuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDFcIiwgXCJTMDEtUExBTi5tZFwiKSxcbiAgICBbXG4gICAgICBcIiMgUzAxIFBsYW5cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIioqR29hbDoqKiBSZWR1Y2UgZHVwbGljYXRlIHByb21wdCByZWFkcy5cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIFRhc2tzXCIsXG4gICAgICBcIi0gW3hdICoqVDAxOiBUYXNrIG9uZSoqIGBlc3Q6MTVtYFwiLFxuICAgIF0uam9pbihcIlxcblwiKSxcbiAgKTtcbn1cblxuZnVuY3Rpb24gd3JpdGVUYXNrU3VtbWFyeShiYXNlOiBzdHJpbmcsIG9wdGlvbnM/OiB7IGJsb2NrZXI/OiBib29sZWFuOyByZXBlYXRlZE5hcnJhdGl2ZT86IHN0cmluZyB9KTogdm9pZCB7XG4gIGNvbnN0IG5hcnJhdGl2ZSA9IG9wdGlvbnM/LnJlcGVhdGVkTmFycmF0aXZlID8/IFwiVGhpcyBmdWxsIGltcGxlbWVudGF0aW9uIG5hcnJhdGl2ZSBzaG91bGQgc3RheSBvdXQgb2YgY2xvc2VyIHByb21wdHMuXCI7XG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMVwiLCBcInRhc2tzXCIsIFwiVDAxLVNVTU1BUlkubWRcIiksXG4gICAgW1xuICAgICAgXCItLS1cIixcbiAgICAgIFwiaWQ6IFQwMVwiLFxuICAgICAgXCJwYXJlbnQ6IFMwMVwiLFxuICAgICAgXCJtaWxlc3RvbmU6IE0wMDFcIixcbiAgICAgIFwicHJvdmlkZXM6XCIsXG4gICAgICBcIiAgLSBwcm9tcHQgY29udGV4dCByZWR1Y3Rpb25cIixcbiAgICAgIFwia2V5X2ZpbGVzOlwiLFxuICAgICAgXCIgIC0gc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9hdXRvLXByb21wdHMudHNcIixcbiAgICAgIFwia2V5X2RlY2lzaW9uczpcIixcbiAgICAgIFwiICAtIHVzZSBjb21wYWN0IGV4Y2VycHRzIGJlZm9yZSBmdWxsIHJlYWRzXCIsXG4gICAgICBcInBhdHRlcm5zX2VzdGFibGlzaGVkOlwiLFxuICAgICAgXCIgIC0gZXhjZXJwdC1maXJzdCBjb21wbGV0ZS1zbGljZSBjb250ZXh0XCIsXG4gICAgICBcIm9ic2VydmFiaWxpdHlfc3VyZmFjZXM6IFtdXCIsXG4gICAgICBcImR1cmF0aW9uOiAxNW1cIixcbiAgICAgIFwidmVyaWZpY2F0aW9uX3Jlc3VsdDogcGFzc2VkXCIsXG4gICAgICBcImNvbXBsZXRlZF9hdDogMjAyNi0wNS0wNlQxMjowMDowMFpcIixcbiAgICAgIGBibG9ja2VyX2Rpc2NvdmVyZWQ6ICR7b3B0aW9ucz8uYmxvY2tlciA/IFwidHJ1ZVwiIDogXCJmYWxzZVwifWAsXG4gICAgICBcIi0tLVwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyBUMDE6IFRhc2sgb25lXCIsXG4gICAgICBcIioqT25lLWxpbmUgcmVzdWx0LioqXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBXaGF0IEhhcHBlbmVkXCIsXG4gICAgICBuYXJyYXRpdmUsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBWZXJpZmljYXRpb25cIixcbiAgICAgIFwibm9kZTp0ZXN0IHBhc3NlZC5cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIERpYWdub3N0aWNzXCIsXG4gICAgICBcIlByb21wdCBzaXplIHN0YXllZCBib3VuZGVkLlwiLFxuICAgIF0uam9pbihcIlxcblwiKSxcbiAgKTtcbn1cblxudGVzdChcImV4ZWN1dGUtdGFzayByZW5kZXJpbmcgbWFrZXMgbWVtb3J5X3F1ZXJ5IGFuZCB0ZW1wbGF0ZSBkaXNrIHJlYWRzIGZhbGxiYWNrLW9ubHlcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKFwiZ3NkLWV4ZWN1dGUtZHVwLWN1dHMtXCIpO1xuICB0LmFmdGVyKCgpID0+IGNsZWFudXAoYmFzZSkpO1xuICBpbnZhbGlkYXRlQWxsQ2FjaGVzKCk7XG5cbiAgc2VlZERiKGJhc2UsIFwicGVuZGluZ1wiKTtcbiAgd3JpdGVSb2FkbWFwQW5kUGxhbihiYXNlKTtcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIsIFwidGFza3NcIiwgXCJUMDEtUExBTi5tZFwiKSxcbiAgICBcIiMgVDAxIFBsYW5cXG5cXG5EbyB0aGUgcHJvbXB0IGVkaXQuXFxuXCIsXG4gICk7XG5cbiAgY29uc3QgeyBidWlsZEV4ZWN1dGVUYXNrUHJvbXB0IH0gPSBhd2FpdCBsb2FkQXV0b1Byb21wdEJ1aWxkZXJzKHQpO1xuICBjb25zdCBwcm9tcHQgPSBhd2FpdCBidWlsZEV4ZWN1dGVUYXNrUHJvbXB0KFwiTTAwMVwiLCBcIlMwMVwiLCBcIlByb21wdCBTbGljZVwiLCBcIlQwMVwiLCBcIlRhc2sgb25lXCIsIGJhc2UpO1xuXG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9DYWxsIGBtZW1vcnlfcXVlcnlgLipvbmx5IHdoZW4gbm8gaW5qZWN0ZWQgbWVtb3J5IGJsb2NrIGV4aXN0cyBvciB0aGUgaW5saW5lZCBtZW1vcnlcXC9jb250ZXh0IGlzIGluc3VmZmljaWVudC9zKTtcbiAgYXNzZXJ0LmRvZXNOb3RNYXRjaChwcm9tcHQsIC9DYWxsIGBtZW1vcnlfcXVlcnlgIHdpdGggMi00IGtleXdvcmRzIGZyb20gdGhlIHRhc2sgdGl0bGUgYW5kIHRvdWNoZWQgZmlsZXMgdW5sZXNzIHRoaXMgaXMgcHVyZWx5IG1lY2hhbmljYWwvKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL1VzZSB0aGUgaW5saW5lZCBUYXNrIFN1bW1hcnkgdGVtcGxhdGUgYmVsb3cvKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL1JlYWQgYC4qdGFzay1zdW1tYXJ5XFwubWRgIG9ubHkgaWYgdGhlIGlubGluZWQgdGVtcGxhdGUgaXMgYWJzZW50IG9yIHZpc2libHkgdHJ1bmNhdGVkLyk7XG4gIGFzc2VydC5kb2VzTm90TWF0Y2gocHJvbXB0LCAvUmVhZCB0aGUgdGVtcGxhdGUgYXQgYC4qdGFzay1zdW1tYXJ5XFwubWRgLyk7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC8jIyMgT3V0cHV0IFRlbXBsYXRlOiBUYXNrIFN1bW1hcnkvKTtcbn0pO1xuXG50ZXN0KFwiY29tcGxldGUtc2xpY2UgcmVuZGVycyB0YXNrIHN1bW1hcnkgZXhjZXJwdHMgd2l0aG91dCBmdWxsIHN1bW1hcnkgYm9kaWVzXCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlQmFzZShcImdzZC1jb21wbGV0ZS1zbGljZS1leGNlcnB0cy1cIik7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cChiYXNlKSk7XG4gIGludmFsaWRhdGVBbGxDYWNoZXMoKTtcblxuICBzZWVkRGIoYmFzZSk7XG4gIHdyaXRlUm9hZG1hcEFuZFBsYW4oYmFzZSk7XG4gIGNvbnN0IHJlcGVhdGVkTmFycmF0aXZlID0gXCJGVUxMX1RBU0tfQk9EWV9TSE9VTERfTk9UX1JFTkRFUiBcIi5yZXBlYXQoNDApO1xuICB3cml0ZVRhc2tTdW1tYXJ5KGJhc2UsIHsgcmVwZWF0ZWROYXJyYXRpdmUgfSk7XG5cbiAgY29uc3QgeyBidWlsZENvbXBsZXRlU2xpY2VQcm9tcHQgfSA9IGF3YWl0IGxvYWRBdXRvUHJvbXB0QnVpbGRlcnModCk7XG4gIGNvbnN0IHByb21wdCA9IGF3YWl0IGJ1aWxkQ29tcGxldGVTbGljZVByb21wdChcIk0wMDFcIiwgXCJQcm9tcHQgQ3V0c1wiLCBcIlMwMVwiLCBcIlByb21wdCBTbGljZVwiLCBiYXNlKTtcblxuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvIyMjIFRhc2sgU3VtbWFyeTogVDAxIFxcKGV4Y2VycHRcXCkvKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL09uLWRlbWFuZC4qcmVhZCBgXFwuZ3NkXFwvbWlsZXN0b25lc1xcL00wMDFcXC9zbGljZXNcXC9TMDFcXC90YXNrc1xcL1QwMS1TVU1NQVJZXFwubWRgIG9ubHkgd2hlbiB0aGlzIGV4Y2VycHQgaXMgYWJzZW50XFwvdHJ1bmNhdGVkL3MpO1xuICBhc3NlcnQuZG9lc05vdE1hdGNoKHByb21wdCwgL0ZVTExfVEFTS19CT0RZX1NIT1VMRF9OT1RfUkVOREVSLyk7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9SZXZpZXcgdGhlIGlubGluZWQgdGFzay1zdW1tYXJ5IGV4Y2VycHRzLyk7XG59KTtcblxudGVzdChcImNvbXBsZXRlLXNsaWNlIGNhcHMgbWFsZm9ybWVkIHRhc2sgc3VtbWFyaWVzIGluc3RlYWQgb2YgaW5saW5pbmcgZnVsbCBib2RpZXNcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKFwiZ3NkLWNvbXBsZXRlLXNsaWNlLW1hbGZvcm1lZC1leGNlcnB0cy1cIik7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cChiYXNlKSk7XG4gIGludmFsaWRhdGVBbGxDYWNoZXMoKTtcblxuICBzZWVkRGIoYmFzZSk7XG4gIHdyaXRlUm9hZG1hcEFuZFBsYW4oYmFzZSk7XG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMVwiLCBcInRhc2tzXCIsIFwiVDAxLVNVTU1BUlkubWRcIiksXG4gICAgW1xuICAgICAgXCIjIExlZ2FjeSBzdW1tYXJ5IHdpdGhvdXQgZnJvbnRtYXR0ZXIgaWRcIixcbiAgICAgIFwiTEVHQUNZX0ZVTExfQk9EWV9TSE9VTERfQkVfQ0FQUEVEIFwiLnJlcGVhdCgyMDApLFxuICAgIF0uam9pbihcIlxcblwiKSxcbiAgKTtcblxuICBjb25zdCB7IGJ1aWxkQ29tcGxldGVTbGljZVByb21wdCB9ID0gYXdhaXQgbG9hZEF1dG9Qcm9tcHRCdWlsZGVycyh0KTtcbiAgY29uc3QgcHJvbXB0ID0gYXdhaXQgYnVpbGRDb21wbGV0ZVNsaWNlUHJvbXB0KFwiTTAwMVwiLCBcIlByb21wdCBDdXRzXCIsIFwiUzAxXCIsIFwiUHJvbXB0IFNsaWNlXCIsIGJhc2UpO1xuXG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9UcnVuY2F0ZWQgbWFsZm9ybWVkIHN1bW1hcnkvKTtcbiAgYXNzZXJ0Lm9rKHByb21wdC5sZW5ndGggPCAyMF8wMDApO1xuICBhc3NlcnQub2soKHByb21wdC5tYXRjaCgvTEVHQUNZX0ZVTExfQk9EWV9TSE9VTERfQkVfQ0FQUEVEL2cpID8/IFtdKS5sZW5ndGggPCA2MCk7XG59KTtcblxudGVzdChcInJlcGxhbi1zbGljZSByZW5kZXJzIGJsb2NrZXIgc3VtbWFyeSBleGNlcnB0IGFuZCB0ZWxscyB0aGUgYWdlbnQgdG8gcmVhZCBmdWxsIG9ubHkgb24gZGVtYW5kXCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlQmFzZShcImdzZC1yZXBsYW4tZXhjZXJwdHMtXCIpO1xuICB0LmFmdGVyKCgpID0+IGNsZWFudXAoYmFzZSkpO1xuICBpbnZhbGlkYXRlQWxsQ2FjaGVzKCk7XG5cbiAgc2VlZERiKGJhc2UpO1xuICB3cml0ZVJvYWRtYXBBbmRQbGFuKGJhc2UpO1xuICB3cml0ZVRhc2tTdW1tYXJ5KGJhc2UsIHtcbiAgICBibG9ja2VyOiB0cnVlLFxuICAgIHJlcGVhdGVkTmFycmF0aXZlOiBcIkZVTExfQkxPQ0tFUl9CT0RZX1NIT1VMRF9OT1RfUkVOREVSIFwiLnJlcGVhdCg0MCksXG4gIH0pO1xuXG4gIGNvbnN0IHsgYnVpbGRSZXBsYW5TbGljZVByb21wdCB9ID0gYXdhaXQgbG9hZEF1dG9Qcm9tcHRCdWlsZGVycyh0KTtcbiAgY29uc3QgcHJvbXB0ID0gYXdhaXQgYnVpbGRSZXBsYW5TbGljZVByb21wdChcIk0wMDFcIiwgXCJQcm9tcHQgQ3V0c1wiLCBcIlMwMVwiLCBcIlByb21wdCBTbGljZVwiLCBiYXNlKTtcblxuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvIyMjIEJsb2NrZXIgVGFzayBTdW1tYXJ5OiBUMDEgXFwoZXhjZXJwdFxcKS8pO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvVXNlIHRoZSBpbmxpbmVkIGJsb2NrZXIgc3VtbWFyeSBleGNlcnB0IGZpcnN0Lyk7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9SZWFkIHRoZSBmdWxsIGJsb2NrZXIgdGFzayBzdW1tYXJ5IG9ubHkgaWYgdGhlIGV4Y2VycHQgaXMgYWJzZW50LCBtYXJrZWQgdHJ1bmNhdGVkLCBvciBsYWNrcyB0aGUgc3BlY2lmaWMgYmxvY2tlciBldmlkZW5jZSBuZWVkZWQgdG8gcmVwbGFuLyk7XG4gIGFzc2VydC5kb2VzTm90TWF0Y2gocHJvbXB0LCAvRlVMTF9CTE9DS0VSX0JPRFlfU0hPVUxEX05PVF9SRU5ERVIvKTtcbiAgYXNzZXJ0LmRvZXNOb3RNYXRjaChwcm9tcHQsIC9SZWFkIHRoZSBibG9ja2VyIHRhc2sgc3VtbWFyeSBjYXJlZnVsbHkvKTtcbn0pO1xuIl0sCiAgIm1hcHBp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
