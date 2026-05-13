import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const promptsDir = join(process.cwd(), "src/resources/extensions/gsd/prompts");
const templatesDir = join(process.cwd(), "src/resources/extensions/gsd/templates");
function readPrompt(name) {
  return readFileSync(join(promptsDir, `${name}.md`), "utf-8");
}
function readTemplate(name) {
  return readFileSync(join(templatesDir, `${name}.md`), "utf-8");
}
test("reactive-execute prompt keeps task summaries with subagents and avoids batch commits", () => {
  const prompt = readPrompt("reactive-execute");
  assert.match(prompt, /subagent-written summary as authoritative/i);
  assert.match(prompt, /Do NOT create a batch commit/i);
  assert.doesNotMatch(prompt, /\*\*Write task summaries\*\*/i);
  assert.doesNotMatch(prompt, /\*\*Commit\*\* all changes/i);
});
test("run-uat prompt branches on dynamic UAT mode and supports runtime evidence", () => {
  const prompt = readPrompt("run-uat");
  assert.match(prompt, /\*\*Detected UAT mode:\*\*\s*`\{\{uatType\}\}`/);
  assert.match(prompt, /uatType:\s*\{\{uatType\}\}/);
  assert.match(prompt, /live-runtime/);
  assert.match(prompt, /browser\/runtime\/network/i);
  assert.match(prompt, /NEEDS-HUMAN/);
  assert.doesNotMatch(prompt, /uatType:\s*artifact-driven/);
});
test("workflow-start prompt defaults to autonomy instead of per-phase confirmation", () => {
  const prompt = readPrompt("workflow-start");
  assert.match(prompt, /Keep moving by default/i);
  assert.match(prompt, /Decision gates, not ceremony/i);
  assert.doesNotMatch(prompt, /confirm with the user before proceeding/i);
  assert.doesNotMatch(prompt, /Gate between phases/i);
});
test("system prompt references CODEBASE.md and /gsd codebase", () => {
  const prompt = readPrompt("system");
  assert.match(prompt, /CODEBASE\.md/);
  assert.match(prompt, /\/gsd codebase \[generate\|update\|stats\]/);
  assert.match(prompt, /auto-refreshes it when tracked files change/i);
});
test("system prompt hard rules forbid fabricating user responses", () => {
  const prompt = readPrompt("system");
  assert.match(prompt, /never fabricate, simulate, or role-play user responses/i);
  assert.match(prompt, /never generate markers like `?\[User\]`?, `?\[Human\]`?, `?User:`?/i);
  assert.match(prompt, /ask one question round \(1-3 questions\), then stop and wait for the user's actual response/i);
  assert.match(prompt, /ask_user_questions.*only valid structured user input/i);
});
test("system prompt requires reading before edit or overwrite", () => {
  const prompt = readPrompt("system");
  assert.match(prompt, /Read before edit or overwrite/i);
  assert.match(prompt, /Before any write that creates or replaces a file/i);
  assert.match(prompt, /confirm whether the path exists; if it does, `read` it first/i);
  assert.match(prompt, /For truly new files, confirm the path does not already exist/i);
});
test("discuss prompt allows implementation questions when they materially matter", () => {
  const prompt = readPrompt("discuss");
  assert.match(prompt, /Lead with experience, but ask implementation when it materially matters/i);
  assert.match(prompt, /Never fabricate, simulate, or role-play user responses/i);
  assert.match(prompt, /Ask one question round \(1-3 questions\) per turn, then stop and wait for the user's actual response/i);
  assert.match(prompt, /one gate, not two/i);
  assert.doesNotMatch(prompt, /Questions must be about the experience, not the implementation/i);
});
test("discuss prompt ends milestone planning with next-step handoff", () => {
  const prompt = readPrompt("discuss");
  assert.match(prompt, /Next steps:/);
  assert.match(prompt, /\/gsd auto/);
  assert.match(prompt, /\/gsd status/);
  assert.match(prompt, /\/gsd visualize/);
  assert.match(prompt, /\/gsd notifications/);
  assert.doesNotMatch(prompt, /nothing else\. Auto-mode will start automatically/);
});
test("guided discussion prompts avoid wrap-up prompts after every round", () => {
  const milestonePrompt = readPrompt("guided-discuss-milestone");
  const slicePrompt = readPrompt("guided-discuss-slice");
  assert.match(milestonePrompt, /Do \*\*not\*\* ask a meta "ready to wrap up\?" question after every round/i);
  assert.match(slicePrompt, /Do \*\*not\*\* ask a meta "ready to wrap up\?" question after every round/i);
  assert.doesNotMatch(milestonePrompt, /I think I have a solid picture of this milestone\. Ready to wrap up/i);
  assert.doesNotMatch(slicePrompt, /I think I have a solid picture of this slice\. Ready to wrap up/i);
  assert.match(milestonePrompt, /Never fabricate or simulate user input/i);
  assert.match(slicePrompt, /Never fabricate or simulate user input/i);
});
test("guided milestone discussion scopes depth verification to the milestone id", () => {
  const prompt = readPrompt("guided-discuss-milestone");
  assert.match(prompt, /depth_verification_\{\{milestoneId\}\}/, "depth verification id should include the milestone id");
  assert.doesNotMatch(prompt, /depth_verification_confirm" — this enables the write-gate downstream/i, "legacy global depth gate wording should be gone");
});
test("guided requirements prompt requires milestone-qualified provisional owners", () => {
  const prompt = readPrompt("guided-discuss-requirements");
  assert.match(prompt, /M###\/none yet/, "unsliced requirements should retain milestone ownership");
  assert.match(prompt, /never bare `none yet`/, "prompt should forbid bare provisional ownership");
  assert.doesNotMatch(prompt, /primary owning slice \(or `none yet`\)/i);
});
test("guided requirements prompt saves requirement records before final summary write", () => {
  const prompt = readPrompt("guided-discuss-requirements");
  const output = prompt.slice(prompt.indexOf("## Output"));
  const requirementSaveIndex = output.indexOf("gsd_requirement_save");
  const summarySaveIndex = output.indexOf("gsd_summary_save");
  assert.ok(requirementSaveIndex >= 0, "output instructions should call gsd_requirement_save");
  assert.ok(summarySaveIndex >= 0, "output instructions should call gsd_summary_save");
  assert.ok(
    requirementSaveIndex < summarySaveIndex,
    "DB-backed requirement records should be saved before writing REQUIREMENTS.md"
  );
});
test("guided requirements prompt uses supported summary artifact types", () => {
  const prompt = readPrompt("guided-discuss-requirements");
  assert.match(prompt, /artifact_type:\s*"REQUIREMENTS-DRAFT"/);
  assert.match(prompt, /artifact_type:\s*"REQUIREMENTS"(?!-)/);
  assert.match(prompt, /omit `milestone_id`/);
  assert.match(prompt, /Do NOT use `artifact_type: "CONTEXT"` and do NOT pass `milestone_id: "REQUIREMENTS"`/);
  assert.match(prompt, /depth_verification_requirements_confirm/);
  assert.doesNotMatch(prompt, /call `gsd_summary_save` with `artifact_type: "CONTEXT"`/);
});
test("workflow preferences prompt writes defaults without interactive questions", () => {
  const prompt = readPrompt("guided-workflow-preferences");
  assert.match(prompt, /default-writing/i);
  assert.match(prompt, /Do NOT call `ask_user_questions`/);
  assert.match(prompt, /commit_policy:\s*per-task/);
  assert.match(prompt, /branch_model:\s*single/);
  assert.match(prompt, /research:\s*skip/);
  assert.match(prompt, /"decision": "skip"/);
  assert.doesNotMatch(prompt, /research:\s*research/);
  assert.doesNotMatch(prompt, /Ask all three questions/i);
  assert.doesNotMatch(prompt, /Ask all four questions/i);
  assert.doesNotMatch(prompt, /Ask all five questions/i);
});
test("project research prompt dispatches scout agents allowed by planning-dispatch", () => {
  const prompt = readPrompt("guided-research-project");
  assert.match(prompt, /agent:\s*"scout"/);
  assert.match(prompt, /Do not use `agent: "researcher"`/);
  assert.match(prompt, /runtime clears the dispatch marker/i);
  assert.doesNotMatch(prompt, /Delete `\.gsd\/runtime\/research-project-inflight`/);
});
test("slice planning prompts name scout for external research dispatch", () => {
  const planSlice = readPrompt("plan-slice");
  const refineSlice = readPrompt("refine-slice");
  assert.match(planSlice, /dispatch the \*\*scout\*\* agent/);
  assert.match(refineSlice, /dispatch the \*\*scout\*\* agent/);
  assert.doesNotMatch(planSlice, /dispatch the \*\*researcher\*\* agent/);
  assert.doesNotMatch(refineSlice, /dispatch the \*\*researcher\*\* agent/);
});
test("guided project prompt writes root PROJECT artifact, not PROJECT milestone", () => {
  const prompt = readPrompt("guided-discuss-project");
  assert.match(prompt, /artifact_type:\s*"PROJECT"/);
  assert.match(prompt, /omit `milestone_id`/);
  assert.match(prompt, /Do NOT use `artifact_type: "CONTEXT"` and do NOT pass `milestone_id: "PROJECT"`/);
  assert.match(prompt, /single freeform question in plain text, not structured/i);
  assert.doesNotMatch(prompt, /project_initial_shape/);
  assert.match(prompt, /depth_verification_project_confirm/);
});
test("guided research decision prompt keeps exact chat confirmation strings", () => {
  const prompt = readPrompt("guided-research-decision");
  assert.match(prompt, /^Research decision: research$/m);
  assert.match(prompt, /^Research decision recorded\.$/m);
  assert.match(prompt, /Skip \(Recommended\)/);
  assert.match(prompt, /"source": "research-decision"/);
  assert.match(prompt, /Do not change the required confirmation strings/i);
  assert.doesNotMatch(prompt, /note the inference in the chat confirmation line/i);
});
test("queue prompt requires waiting for user response between rounds", () => {
  const prompt = readPrompt("queue");
  assert.match(prompt, /Never fabricate or simulate user input during this discussion/i);
  assert.match(prompt, /Ask 1-3 questions per round, then wait for the user's response before asking the next round\./i);
  assert.doesNotMatch(prompt, /treat that as permission to continue/i);
});
test("guided-resume-task prompt preserves recovery state until work is superseded", () => {
  const prompt = readPrompt("guided-resume-task");
  assert.match(prompt, /Do \*\*not\*\* delete the continue file immediately/i);
  assert.match(prompt, /successfully completed or you have written a newer summary\/continue artifact/i);
  assert.doesNotMatch(prompt, /Delete the continue file after reading it/i);
});
test("execute-task prompt references gsd_task_complete tool", () => {
  const prompt = readPrompt("execute-task");
  assert.match(prompt, /gsd_task_complete/);
});
test("execute-task prompt uses gsd_task_complete as canonical summary write path", () => {
  const prompt = readPrompt("execute-task");
  assert.match(prompt, /\{\{taskSummaryPath\}\}/);
  assert.match(prompt, /gsd_task_complete/);
  assert.match(prompt, /DB-backed tool is the canonical write path/i);
  assert.match(prompt, /Do \*\*not\*\* manually write `?\{\{taskSummaryPath\}\}`?/i);
  assert.doesNotMatch(prompt, /^\d+\.\s+Write `?\{\{taskSummaryPath\}\}`?\s*$/m);
});
test("execute-task prompt does not instruct LLM to toggle checkboxes manually", () => {
  const prompt = readPrompt("execute-task");
  assert.doesNotMatch(prompt, /change \[ \] to \[x\]/);
  assert.doesNotMatch(prompt, /Mark \{\{taskId\}\} done in/);
});
test("execute-task prompt still contains template variables for context", () => {
  const prompt = readPrompt("execute-task");
  assert.match(prompt, /\{\{taskSummaryPath\}\}/);
  assert.match(prompt, /\{\{planPath\}\}/);
});
test("complete-slice prompt references gsd_slice_complete tool", () => {
  const prompt = readPrompt("complete-slice");
  assert.match(prompt, /gsd_slice_complete/);
});
test("complete-slice prompt does not instruct LLM to toggle checkboxes manually", () => {
  const prompt = readPrompt("complete-slice");
  assert.doesNotMatch(prompt, /change \[ \] to \[x\]/);
});
test("complete-slice prompt keeps source fixes in execution units", () => {
  const prompt = readPrompt("complete-slice");
  assert.match(prompt, /Do not use direct `bash` for verification commands/i);
  assert.match(prompt, /do \*\*not\*\* edit source files in this unit/i);
  assert.match(prompt, /do \*\*not\*\* call `gsd_slice_complete`/i);
  assert.match(prompt, /gsd_task_reopen/);
  assert.match(prompt, /gsd_replan_slice/);
  assert.match(prompt, /needs execution follow-up/i);
  assert.doesNotMatch(prompt, /Fix failures before marking done/i);
});
test("complete-slice prompt instructs writing summary and UAT files before tool call", () => {
  const prompt = readPrompt("complete-slice");
  assert.match(prompt, /\{\{sliceSummaryPath\}\}/);
  assert.match(prompt, /\{\{sliceUatPath\}\}/);
  assert.match(prompt, /gsd_slice_complete/);
  assert.match(prompt, /DB-backed tool is the canonical write path/i);
  assert.match(prompt, /Do \*\*not\*\* manually write `?\{\{sliceSummaryPath\}\}`?/i);
  assert.match(prompt, /Do \*\*not\*\* manually write `?\{\{sliceUatPath\}\}`?/i);
  assert.doesNotMatch(prompt, /^\d+\.\s+Write `?\{\{sliceSummaryPath\}\}`?.*$/m);
  assert.doesNotMatch(prompt, /^\d+\.\s+Write `?\{\{sliceUatPath\}\}`?.*$/m);
});
test("complete-slice prompt preserves decisions and knowledge review steps", () => {
  const prompt = readPrompt("complete-slice");
  assert.match(prompt, /DECISIONS\.md/);
  assert.match(prompt, /KNOWLEDGE\.md/);
});
test("validate-milestone prompt uses gsd_validate_milestone as canonical validation write path", () => {
  const prompt = readPrompt("validate-milestone");
  assert.match(prompt, /gsd_validate_milestone/);
  assert.match(prompt, /\{\{validationPath\}\}/);
  assert.match(prompt, /DB-backed tool is the canonical write path/i);
  assert.match(prompt, /Do \*\*not\*\* manually write `?\{\{validationPath\}\}`?/i);
  assert.doesNotMatch(prompt, /Write to `?\{\{validationPath\}\}`?:/i);
});
test("complete-slice prompt still contains template variables for context", () => {
  const prompt = readPrompt("complete-slice");
  assert.match(prompt, /\{\{sliceSummaryPath\}\}/);
  assert.match(prompt, /\{\{sliceUatPath\}\}/);
});
test("plan-milestone prompt references DB-backed planning tool and explicitly forbids manual roadmap writes", () => {
  const prompt = readPrompt("plan-milestone");
  assert.match(prompt, /gsd_plan_milestone/);
  assert.match(prompt, /Do \*\*not\*\* write `?\{\{outputPath\}\}`?, `?ROADMAP\.md`?, or other planning artifacts manually/i);
});
test("plan-slice prompt no longer frames direct PLAN writes as the source of truth", () => {
  const prompt = readPrompt("plan-slice");
  assert.match(prompt, /Do \*\*not\*\* rely on direct `PLAN\.md` writes as the source of truth/i);
});
test("plan-slice prompt explicitly names gsd_plan_slice as DB-backed planning tool", () => {
  const prompt = readPrompt("plan-slice");
  assert.match(prompt, /gsd_plan_slice/);
  assert.match(prompt, /gsd_plan_task/);
  assert.match(prompt, /DB-backed tool is the canonical write path/i);
});
test("plan-slice prompt does not instruct direct file writes as a primary step", () => {
  const prompt = readPrompt("plan-slice");
  assert.doesNotMatch(prompt, /^\d+\.\s+Write `?\{\{outputPath\}\}`?\s*$/m);
});
test("plan-slice prompt clarifies gsd_plan_slice handles task persistence", () => {
  const prompt = readPrompt("plan-slice");
  assert.match(prompt, /gsd_plan_task/);
  assert.match(prompt, /gsd_plan_slice` handles task persistence/i);
});
test("replan-slice prompt uses gsd_replan_slice as canonical DB-backed tool", () => {
  const prompt = readPrompt("replan-slice");
  assert.match(prompt, /gsd_replan_slice/);
  assert.doesNotMatch(prompt, /Degraded fallback/i);
});
test("refine-slice prompt names gsd_plan_slice as the DB-backed write path", () => {
  const prompt = readPrompt("refine-slice");
  assert.match(prompt, /gsd_plan_slice/, "refine-slice must call gsd_plan_slice to persist");
});
test("refine-slice prompt does not instruct direct PLAN.md writes", () => {
  const prompt = readPrompt("refine-slice");
  assert.match(
    prompt,
    /do NOT rely on direct `PLAN\.md` writes/i,
    "refine-slice must not frame direct file writes as authoritative"
  );
});
test("refine-slice prompt frames the unit as a transformation, not blank-sheet planning", () => {
  const prompt = readPrompt("refine-slice");
  assert.match(prompt, /expands an approved sketch/i);
  assert.match(prompt, /Sketch Scope/);
});
test("reassess-roadmap prompt references gsd_reassess_roadmap tool", () => {
  const prompt = readPrompt("reassess-roadmap");
  assert.match(prompt, /gsd_reassess_roadmap/);
});
test("validate-milestone prompt dispatches parallel reviewers", () => {
  const prompt = readPrompt("validate-milestone");
  assert.match(prompt, /Reviewer A/);
  assert.match(prompt, /Reviewer B/);
  assert.match(prompt, /Reviewer C/);
  assert.match(prompt, /Requirements Coverage/);
  assert.match(prompt, /Cross-Slice Integration/);
  assert.match(prompt, /Assessment & Acceptance Criteria/);
  assert.match(prompt, /assessment evidence/i);
});
test("replan-slice prompt names gsd_replan_slice as the tool to use", () => {
  const prompt = readPrompt("replan-slice");
  assert.match(prompt, /gsd_replan_slice/);
});
test("reassess-roadmap prompt names gsd_reassess_roadmap as the tool to use", () => {
  const prompt = readPrompt("reassess-roadmap");
  assert.match(prompt, /gsd_reassess_roadmap/);
});
test("execute-task prompt uses camelCase parameter names matching TypeBox schema", () => {
  const prompt = readPrompt("execute-task");
  const toolCallLine = prompt.split("\n").find((l) => /gsd_complete_task/.test(l) || /gsd_task_complete/.test(l));
  assert.ok(toolCallLine, "prompt must contain a gsd_complete_task or gsd_task_complete tool call line");
  assert.doesNotMatch(toolCallLine, /milestone_id/, "must use milestoneId, not milestone_id");
  assert.doesNotMatch(toolCallLine, /slice_id/, "must use sliceId, not slice_id");
  assert.doesNotMatch(toolCallLine, /task_id/, "must use taskId, not task_id");
  assert.match(toolCallLine, /milestoneId/);
  assert.match(toolCallLine, /sliceId/);
  assert.match(toolCallLine, /taskId/);
});
test("complete-slice prompt uses camelCase parameter names matching TypeBox schema", () => {
  const prompt = readPrompt("complete-slice");
  const toolCallLine = prompt.split("\n").find(
    (l) => (/gsd_complete_slice/.test(l) || /gsd_slice_complete/.test(l)) && /milestoneId/.test(l) && /sliceId/.test(l)
  );
  assert.ok(toolCallLine, "prompt must contain a gsd_complete_slice or gsd_slice_complete tool call line");
  assert.doesNotMatch(toolCallLine, /milestone_id/, "must use milestoneId, not milestone_id");
  assert.doesNotMatch(toolCallLine, /slice_id/, "must use sliceId, not slice_id");
  assert.match(toolCallLine, /milestoneId/);
  assert.match(toolCallLine, /sliceId/);
});
test("complete-slice prompt includes filesystem safety guard against EISDIR", () => {
  const prompt = readPrompt("complete-slice");
  assert.match(
    prompt,
    /File system safety/i,
    "complete-slice.md must include a 'File system safety' instruction to prevent EISDIR errors when the LLM passes a directory path to the read tool"
  );
  assert.match(
    prompt,
    /never pass.*directory path.*directly to the.*read.*tool/i,
    "complete-slice.md must warn against passing directory paths to the read tool"
  );
});
test("complete-milestone prompt still has its filesystem safety guard (regression)", () => {
  const prompt = readPrompt("complete-milestone");
  assert.match(
    prompt,
    /File system safety/i,
    "complete-milestone.md must keep its filesystem safety guard"
  );
});
test("reactive-execute prompt references tool calls instead of checkbox updates", () => {
  const prompt = readPrompt("reactive-execute");
  assert.doesNotMatch(prompt, /checkbox updates/);
  assert.doesNotMatch(prompt, /checkbox edits/);
  assert.match(prompt, /completion tool calls/);
});
test("guided-discuss-project classifies project shape and persists the verdict to PROJECT.md", () => {
  const prompt = readPrompt("guided-discuss-project");
  assert.match(prompt, /Classify project shape/i, "must include the classifier section");
  assert.match(prompt, /`simple`/);
  assert.match(prompt, /`complex`/);
  assert.match(prompt, /Default to `complex` when uncertain/i);
  assert.match(prompt, /## Project Shape/, "must reference the persisted PROJECT.md section");
  assert.match(prompt, /\*\*Complexity:\*\*\s*simple/);
  assert.match(prompt, /\*\*Complexity:\*\*\s*complex/);
});
test("guided-discuss prompts require 3-or-4 options plus Other-let-me-discuss in complex mode", () => {
  for (const name of [
    "guided-discuss-project",
    "guided-discuss-milestone",
    "guided-discuss-slice"
  ]) {
    const prompt = readPrompt(name);
    assert.match(
      prompt,
      /3 or 4 concrete, researched options/i,
      `${name} must require 3 or 4 grounded options in complex mode`
    );
    assert.match(
      prompt,
      /"Other — let me discuss"/,
      `${name} must include the "Other \u2014 let me discuss" escape hatch`
    );
    assert.match(
      prompt,
      /grounded in (the |your |)investigation/i,
      `${name} must require options grounded in prior investigation`
    );
  }
});
test("guided-discuss-requirements scopes the 3-or-4-options rule to free-form questions only", () => {
  const prompt = readPrompt("guided-discuss-requirements");
  assert.match(prompt, /3 or 4 concrete, researched options/i);
  assert.match(prompt, /"Other — let me discuss"/);
  assert.match(prompt, /class-assignment.*status.*exempt/i);
});
test("downstream discuss prompts read project shape verdict from PROJECT.md", () => {
  for (const name of [
    "guided-discuss-milestone",
    "guided-discuss-requirements",
    "guided-discuss-slice"
  ]) {
    const prompt = readPrompt(name);
    assert.match(
      prompt,
      /Project Shape/,
      `${name} must reference Project Shape from PROJECT.md`
    );
    assert.match(
      prompt,
      /default to `complex`/i,
      `${name} must default to complex when the verdict is missing`
    );
  }
});
test("project template includes the Project Shape section so the verdict has a home", () => {
  const template = readTemplate("project");
  assert.match(template, /## Project Shape/);
  assert.match(template, /\*\*Complexity:\*\*/);
});
function renderProjectMd(verdict) {
  return readTemplate("project").replace("{{simple | complex}}", verdict).replace("{{one-line rationale citing the signals that decided it}}", "Test fixture rationale.");
}
test("project shape verdict survives the discuss-project \u2192 discuss-milestone round trip", () => {
  for (const verdict of ["simple", "complex"]) {
    const projectMd = renderProjectMd(verdict);
    assert.match(projectMd, /## Project Shape/, `rendered ${verdict} PROJECT.md must keep the section header`);
    const complexityMarker = new RegExp(`\\*\\*Complexity:\\*\\*\\s*${verdict}\\b`);
    assert.match(
      projectMd,
      complexityMarker,
      `rendered ${verdict} PROJECT.md must expose the bolded Complexity marker the downstream regex looks for`
    );
    for (const downstream of ["guided-discuss-milestone", "guided-discuss-requirements", "guided-discuss-slice"]) {
      const prompt = readPrompt(downstream);
      assert.match(
        prompt,
        /## Project Shape/,
        `${downstream} must direct the LLM to the same section header the template writes`
      );
      assert.match(
        prompt,
        /\*\*Complexity:\*\*/,
        `${downstream} must direct the LLM to the same **Complexity:** marker the template writes`
      );
    }
  }
});
test("downstream discuss prompts default to complex when PROJECT.md lacks the verdict", () => {
  for (const downstream of ["guided-discuss-milestone", "guided-discuss-requirements", "guided-discuss-slice"]) {
    const prompt = readPrompt(downstream);
    assert.match(
      prompt,
      /default to `complex`/i,
      `${downstream} must default to complex when the upstream verdict is missing`
    );
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wcm9tcHQtY29udHJhY3RzLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgcmVhZEZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbmNvbnN0IHByb21wdHNEaXIgPSBqb2luKHByb2Nlc3MuY3dkKCksIFwic3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9wcm9tcHRzXCIpO1xuY29uc3QgdGVtcGxhdGVzRGlyID0gam9pbihwcm9jZXNzLmN3ZCgpLCBcInNyYy9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvdGVtcGxhdGVzXCIpO1xuXG5mdW5jdGlvbiByZWFkUHJvbXB0KG5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiByZWFkRmlsZVN5bmMoam9pbihwcm9tcHRzRGlyLCBgJHtuYW1lfS5tZGApLCBcInV0Zi04XCIpO1xufVxuXG5mdW5jdGlvbiByZWFkVGVtcGxhdGUobmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHJlYWRGaWxlU3luYyhqb2luKHRlbXBsYXRlc0RpciwgYCR7bmFtZX0ubWRgKSwgXCJ1dGYtOFwiKTtcbn1cblxudGVzdChcInJlYWN0aXZlLWV4ZWN1dGUgcHJvbXB0IGtlZXBzIHRhc2sgc3VtbWFyaWVzIHdpdGggc3ViYWdlbnRzIGFuZCBhdm9pZHMgYmF0Y2ggY29tbWl0c1wiLCAoKSA9PiB7XG4gIGNvbnN0IHByb21wdCA9IHJlYWRQcm9tcHQoXCJyZWFjdGl2ZS1leGVjdXRlXCIpO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvc3ViYWdlbnQtd3JpdHRlbiBzdW1tYXJ5IGFzIGF1dGhvcml0YXRpdmUvaSk7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9EbyBOT1QgY3JlYXRlIGEgYmF0Y2ggY29tbWl0L2kpO1xuICBhc3NlcnQuZG9lc05vdE1hdGNoKHByb21wdCwgL1xcKlxcKldyaXRlIHRhc2sgc3VtbWFyaWVzXFwqXFwqL2kpO1xuICBhc3NlcnQuZG9lc05vdE1hdGNoKHByb21wdCwgL1xcKlxcKkNvbW1pdFxcKlxcKiBhbGwgY2hhbmdlcy9pKTtcbn0pO1xuXG50ZXN0KFwicnVuLXVhdCBwcm9tcHQgYnJhbmNoZXMgb24gZHluYW1pYyBVQVQgbW9kZSBhbmQgc3VwcG9ydHMgcnVudGltZSBldmlkZW5jZVwiLCAoKSA9PiB7XG4gIGNvbnN0IHByb21wdCA9IHJlYWRQcm9tcHQoXCJydW4tdWF0XCIpO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvXFwqXFwqRGV0ZWN0ZWQgVUFUIG1vZGU6XFwqXFwqXFxzKmBcXHtcXHt1YXRUeXBlXFx9XFx9YC8pO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvdWF0VHlwZTpcXHMqXFx7XFx7dWF0VHlwZVxcfVxcfS8pO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvbGl2ZS1ydW50aW1lLyk7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9icm93c2VyXFwvcnVudGltZVxcL25ldHdvcmsvaSk7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9ORUVEUy1IVU1BTi8pO1xuICBhc3NlcnQuZG9lc05vdE1hdGNoKHByb21wdCwgL3VhdFR5cGU6XFxzKmFydGlmYWN0LWRyaXZlbi8pO1xufSk7XG5cbnRlc3QoXCJ3b3JrZmxvdy1zdGFydCBwcm9tcHQgZGVmYXVsdHMgdG8gYXV0b25vbXkgaW5zdGVhZCBvZiBwZXItcGhhc2UgY29uZmlybWF0aW9uXCIsICgpID0+IHtcbiAgY29uc3QgcHJvbXB0ID0gcmVhZFByb21wdChcIndvcmtmbG93LXN0YXJ0XCIpO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvS2VlcCBtb3ZpbmcgYnkgZGVmYXVsdC9pKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL0RlY2lzaW9uIGdhdGVzLCBub3QgY2VyZW1vbnkvaSk7XG4gIGFzc2VydC5kb2VzTm90TWF0Y2gocHJvbXB0LCAvY29uZmlybSB3aXRoIHRoZSB1c2VyIGJlZm9yZSBwcm9jZWVkaW5nL2kpO1xuICBhc3NlcnQuZG9lc05vdE1hdGNoKHByb21wdCwgL0dhdGUgYmV0d2VlbiBwaGFzZXMvaSk7XG59KTtcblxudGVzdChcInN5c3RlbSBwcm9tcHQgcmVmZXJlbmNlcyBDT0RFQkFTRS5tZCBhbmQgL2dzZCBjb2RlYmFzZVwiLCAoKSA9PiB7XG4gIGNvbnN0IHByb21wdCA9IHJlYWRQcm9tcHQoXCJzeXN0ZW1cIik7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9DT0RFQkFTRVxcLm1kLyk7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9cXC9nc2QgY29kZWJhc2UgXFxbZ2VuZXJhdGVcXHx1cGRhdGVcXHxzdGF0c1xcXS8pO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvYXV0by1yZWZyZXNoZXMgaXQgd2hlbiB0cmFja2VkIGZpbGVzIGNoYW5nZS9pKTtcbn0pO1xuXG50ZXN0KFwic3lzdGVtIHByb21wdCBoYXJkIHJ1bGVzIGZvcmJpZCBmYWJyaWNhdGluZyB1c2VyIHJlc3BvbnNlc1wiLCAoKSA9PiB7XG4gIGNvbnN0IHByb21wdCA9IHJlYWRQcm9tcHQoXCJzeXN0ZW1cIik7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9uZXZlciBmYWJyaWNhdGUsIHNpbXVsYXRlLCBvciByb2xlLXBsYXkgdXNlciByZXNwb25zZXMvaSk7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9uZXZlciBnZW5lcmF0ZSBtYXJrZXJzIGxpa2UgYD9cXFtVc2VyXFxdYD8sIGA/XFxbSHVtYW5cXF1gPywgYD9Vc2VyOmA/L2kpO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvYXNrIG9uZSBxdWVzdGlvbiByb3VuZCBcXCgxLTMgcXVlc3Rpb25zXFwpLCB0aGVuIHN0b3AgYW5kIHdhaXQgZm9yIHRoZSB1c2VyJ3MgYWN0dWFsIHJlc3BvbnNlL2kpO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvYXNrX3VzZXJfcXVlc3Rpb25zLipvbmx5IHZhbGlkIHN0cnVjdHVyZWQgdXNlciBpbnB1dC9pKTtcbn0pO1xuXG50ZXN0KFwic3lzdGVtIHByb21wdCByZXF1aXJlcyByZWFkaW5nIGJlZm9yZSBlZGl0IG9yIG92ZXJ3cml0ZVwiLCAoKSA9PiB7XG4gIGNvbnN0IHByb21wdCA9IHJlYWRQcm9tcHQoXCJzeXN0ZW1cIik7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9SZWFkIGJlZm9yZSBlZGl0IG9yIG92ZXJ3cml0ZS9pKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL0JlZm9yZSBhbnkgd3JpdGUgdGhhdCBjcmVhdGVzIG9yIHJlcGxhY2VzIGEgZmlsZS9pKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL2NvbmZpcm0gd2hldGhlciB0aGUgcGF0aCBleGlzdHM7IGlmIGl0IGRvZXMsIGByZWFkYCBpdCBmaXJzdC9pKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL0ZvciB0cnVseSBuZXcgZmlsZXMsIGNvbmZpcm0gdGhlIHBhdGggZG9lcyBub3QgYWxyZWFkeSBleGlzdC9pKTtcbn0pO1xuXG50ZXN0KFwiZGlzY3VzcyBwcm9tcHQgYWxsb3dzIGltcGxlbWVudGF0aW9uIHF1ZXN0aW9ucyB3aGVuIHRoZXkgbWF0ZXJpYWxseSBtYXR0ZXJcIiwgKCkgPT4ge1xuICBjb25zdCBwcm9tcHQgPSByZWFkUHJvbXB0KFwiZGlzY3Vzc1wiKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL0xlYWQgd2l0aCBleHBlcmllbmNlLCBidXQgYXNrIGltcGxlbWVudGF0aW9uIHdoZW4gaXQgbWF0ZXJpYWxseSBtYXR0ZXJzL2kpO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvTmV2ZXIgZmFicmljYXRlLCBzaW11bGF0ZSwgb3Igcm9sZS1wbGF5IHVzZXIgcmVzcG9uc2VzL2kpO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvQXNrIG9uZSBxdWVzdGlvbiByb3VuZCBcXCgxLTMgcXVlc3Rpb25zXFwpIHBlciB0dXJuLCB0aGVuIHN0b3AgYW5kIHdhaXQgZm9yIHRoZSB1c2VyJ3MgYWN0dWFsIHJlc3BvbnNlL2kpO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvb25lIGdhdGUsIG5vdCB0d28vaSk7XG4gIGFzc2VydC5kb2VzTm90TWF0Y2gocHJvbXB0LCAvUXVlc3Rpb25zIG11c3QgYmUgYWJvdXQgdGhlIGV4cGVyaWVuY2UsIG5vdCB0aGUgaW1wbGVtZW50YXRpb24vaSk7XG59KTtcblxudGVzdChcImRpc2N1c3MgcHJvbXB0IGVuZHMgbWlsZXN0b25lIHBsYW5uaW5nIHdpdGggbmV4dC1zdGVwIGhhbmRvZmZcIiwgKCkgPT4ge1xuICBjb25zdCBwcm9tcHQgPSByZWFkUHJvbXB0KFwiZGlzY3Vzc1wiKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL05leHQgc3RlcHM6Lyk7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9cXC9nc2QgYXV0by8pO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvXFwvZ3NkIHN0YXR1cy8pO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvXFwvZ3NkIHZpc3VhbGl6ZS8pO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvXFwvZ3NkIG5vdGlmaWNhdGlvbnMvKTtcbiAgYXNzZXJ0LmRvZXNOb3RNYXRjaChwcm9tcHQsIC9ub3RoaW5nIGVsc2VcXC4gQXV0by1tb2RlIHdpbGwgc3RhcnQgYXV0b21hdGljYWxseS8pO1xufSk7XG5cbnRlc3QoXCJndWlkZWQgZGlzY3Vzc2lvbiBwcm9tcHRzIGF2b2lkIHdyYXAtdXAgcHJvbXB0cyBhZnRlciBldmVyeSByb3VuZFwiLCAoKSA9PiB7XG4gIGNvbnN0IG1pbGVzdG9uZVByb21wdCA9IHJlYWRQcm9tcHQoXCJndWlkZWQtZGlzY3Vzcy1taWxlc3RvbmVcIik7XG4gIGNvbnN0IHNsaWNlUHJvbXB0ID0gcmVhZFByb21wdChcImd1aWRlZC1kaXNjdXNzLXNsaWNlXCIpO1xuICBhc3NlcnQubWF0Y2gobWlsZXN0b25lUHJvbXB0LCAvRG8gXFwqXFwqbm90XFwqXFwqIGFzayBhIG1ldGEgXCJyZWFkeSB0byB3cmFwIHVwXFw/XCIgcXVlc3Rpb24gYWZ0ZXIgZXZlcnkgcm91bmQvaSk7XG4gIGFzc2VydC5tYXRjaChzbGljZVByb21wdCwgL0RvIFxcKlxcKm5vdFxcKlxcKiBhc2sgYSBtZXRhIFwicmVhZHkgdG8gd3JhcCB1cFxcP1wiIHF1ZXN0aW9uIGFmdGVyIGV2ZXJ5IHJvdW5kL2kpO1xuICBhc3NlcnQuZG9lc05vdE1hdGNoKG1pbGVzdG9uZVByb21wdCwgL0kgdGhpbmsgSSBoYXZlIGEgc29saWQgcGljdHVyZSBvZiB0aGlzIG1pbGVzdG9uZVxcLiBSZWFkeSB0byB3cmFwIHVwL2kpO1xuICBhc3NlcnQuZG9lc05vdE1hdGNoKHNsaWNlUHJvbXB0LCAvSSB0aGluayBJIGhhdmUgYSBzb2xpZCBwaWN0dXJlIG9mIHRoaXMgc2xpY2VcXC4gUmVhZHkgdG8gd3JhcCB1cC9pKTtcbiAgYXNzZXJ0Lm1hdGNoKG1pbGVzdG9uZVByb21wdCwgL05ldmVyIGZhYnJpY2F0ZSBvciBzaW11bGF0ZSB1c2VyIGlucHV0L2kpO1xuICBhc3NlcnQubWF0Y2goc2xpY2VQcm9tcHQsIC9OZXZlciBmYWJyaWNhdGUgb3Igc2ltdWxhdGUgdXNlciBpbnB1dC9pKTtcbn0pO1xuXG50ZXN0KFwiZ3VpZGVkIG1pbGVzdG9uZSBkaXNjdXNzaW9uIHNjb3BlcyBkZXB0aCB2ZXJpZmljYXRpb24gdG8gdGhlIG1pbGVzdG9uZSBpZFwiLCAoKSA9PiB7XG4gIGNvbnN0IHByb21wdCA9IHJlYWRQcm9tcHQoXCJndWlkZWQtZGlzY3Vzcy1taWxlc3RvbmVcIik7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9kZXB0aF92ZXJpZmljYXRpb25fXFx7XFx7bWlsZXN0b25lSWRcXH1cXH0vLCBcImRlcHRoIHZlcmlmaWNhdGlvbiBpZCBzaG91bGQgaW5jbHVkZSB0aGUgbWlsZXN0b25lIGlkXCIpO1xuICBhc3NlcnQuZG9lc05vdE1hdGNoKHByb21wdCwgL2RlcHRoX3ZlcmlmaWNhdGlvbl9jb25maXJtXCIgXHUyMDE0IHRoaXMgZW5hYmxlcyB0aGUgd3JpdGUtZ2F0ZSBkb3duc3RyZWFtL2ksIFwibGVnYWN5IGdsb2JhbCBkZXB0aCBnYXRlIHdvcmRpbmcgc2hvdWxkIGJlIGdvbmVcIik7XG59KTtcblxudGVzdChcImd1aWRlZCByZXF1aXJlbWVudHMgcHJvbXB0IHJlcXVpcmVzIG1pbGVzdG9uZS1xdWFsaWZpZWQgcHJvdmlzaW9uYWwgb3duZXJzXCIsICgpID0+IHtcbiAgY29uc3QgcHJvbXB0ID0gcmVhZFByb21wdChcImd1aWRlZC1kaXNjdXNzLXJlcXVpcmVtZW50c1wiKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL00jIyNcXC9ub25lIHlldC8sIFwidW5zbGljZWQgcmVxdWlyZW1lbnRzIHNob3VsZCByZXRhaW4gbWlsZXN0b25lIG93bmVyc2hpcFwiKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL25ldmVyIGJhcmUgYG5vbmUgeWV0YC8sIFwicHJvbXB0IHNob3VsZCBmb3JiaWQgYmFyZSBwcm92aXNpb25hbCBvd25lcnNoaXBcIik7XG4gIGFzc2VydC5kb2VzTm90TWF0Y2gocHJvbXB0LCAvcHJpbWFyeSBvd25pbmcgc2xpY2UgXFwob3IgYG5vbmUgeWV0YFxcKS9pKTtcbn0pO1xuXG50ZXN0KFwiZ3VpZGVkIHJlcXVpcmVtZW50cyBwcm9tcHQgc2F2ZXMgcmVxdWlyZW1lbnQgcmVjb3JkcyBiZWZvcmUgZmluYWwgc3VtbWFyeSB3cml0ZVwiLCAoKSA9PiB7XG4gIGNvbnN0IHByb21wdCA9IHJlYWRQcm9tcHQoXCJndWlkZWQtZGlzY3Vzcy1yZXF1aXJlbWVudHNcIik7XG4gIGNvbnN0IG91dHB1dCA9IHByb21wdC5zbGljZShwcm9tcHQuaW5kZXhPZihcIiMjIE91dHB1dFwiKSk7XG4gIGNvbnN0IHJlcXVpcmVtZW50U2F2ZUluZGV4ID0gb3V0cHV0LmluZGV4T2YoXCJnc2RfcmVxdWlyZW1lbnRfc2F2ZVwiKTtcbiAgY29uc3Qgc3VtbWFyeVNhdmVJbmRleCA9IG91dHB1dC5pbmRleE9mKFwiZ3NkX3N1bW1hcnlfc2F2ZVwiKTtcblxuICBhc3NlcnQub2socmVxdWlyZW1lbnRTYXZlSW5kZXggPj0gMCwgXCJvdXRwdXQgaW5zdHJ1Y3Rpb25zIHNob3VsZCBjYWxsIGdzZF9yZXF1aXJlbWVudF9zYXZlXCIpO1xuICBhc3NlcnQub2soc3VtbWFyeVNhdmVJbmRleCA+PSAwLCBcIm91dHB1dCBpbnN0cnVjdGlvbnMgc2hvdWxkIGNhbGwgZ3NkX3N1bW1hcnlfc2F2ZVwiKTtcbiAgYXNzZXJ0Lm9rKFxuICAgIHJlcXVpcmVtZW50U2F2ZUluZGV4IDwgc3VtbWFyeVNhdmVJbmRleCxcbiAgICBcIkRCLWJhY2tlZCByZXF1aXJlbWVudCByZWNvcmRzIHNob3VsZCBiZSBzYXZlZCBiZWZvcmUgd3JpdGluZyBSRVFVSVJFTUVOVFMubWRcIixcbiAgKTtcbn0pO1xuXG50ZXN0KFwiZ3VpZGVkIHJlcXVpcmVtZW50cyBwcm9tcHQgdXNlcyBzdXBwb3J0ZWQgc3VtbWFyeSBhcnRpZmFjdCB0eXBlc1wiLCAoKSA9PiB7XG4gIGNvbnN0IHByb21wdCA9IHJlYWRQcm9tcHQoXCJndWlkZWQtZGlzY3Vzcy1yZXF1aXJlbWVudHNcIik7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9hcnRpZmFjdF90eXBlOlxccypcIlJFUVVJUkVNRU5UUy1EUkFGVFwiLyk7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9hcnRpZmFjdF90eXBlOlxccypcIlJFUVVJUkVNRU5UU1wiKD8hLSkvKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL29taXQgYG1pbGVzdG9uZV9pZGAvKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL0RvIE5PVCB1c2UgYGFydGlmYWN0X3R5cGU6IFwiQ09OVEVYVFwiYCBhbmQgZG8gTk9UIHBhc3MgYG1pbGVzdG9uZV9pZDogXCJSRVFVSVJFTUVOVFNcImAvKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL2RlcHRoX3ZlcmlmaWNhdGlvbl9yZXF1aXJlbWVudHNfY29uZmlybS8pO1xuICBhc3NlcnQuZG9lc05vdE1hdGNoKHByb21wdCwgL2NhbGwgYGdzZF9zdW1tYXJ5X3NhdmVgIHdpdGggYGFydGlmYWN0X3R5cGU6IFwiQ09OVEVYVFwiYC8pO1xufSk7XG5cbnRlc3QoXCJ3b3JrZmxvdyBwcmVmZXJlbmNlcyBwcm9tcHQgd3JpdGVzIGRlZmF1bHRzIHdpdGhvdXQgaW50ZXJhY3RpdmUgcXVlc3Rpb25zXCIsICgpID0+IHtcbiAgY29uc3QgcHJvbXB0ID0gcmVhZFByb21wdChcImd1aWRlZC13b3JrZmxvdy1wcmVmZXJlbmNlc1wiKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL2RlZmF1bHQtd3JpdGluZy9pKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL0RvIE5PVCBjYWxsIGBhc2tfdXNlcl9xdWVzdGlvbnNgLyk7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9jb21taXRfcG9saWN5OlxccypwZXItdGFzay8pO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvYnJhbmNoX21vZGVsOlxccypzaW5nbGUvKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL3Jlc2VhcmNoOlxccypza2lwLyk7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9cImRlY2lzaW9uXCI6IFwic2tpcFwiLyk7XG4gIGFzc2VydC5kb2VzTm90TWF0Y2gocHJvbXB0LCAvcmVzZWFyY2g6XFxzKnJlc2VhcmNoLyk7XG4gIGFzc2VydC5kb2VzTm90TWF0Y2gocHJvbXB0LCAvQXNrIGFsbCB0aHJlZSBxdWVzdGlvbnMvaSk7XG4gIGFzc2VydC5kb2VzTm90TWF0Y2gocHJvbXB0LCAvQXNrIGFsbCBmb3VyIHF1ZXN0aW9ucy9pKTtcbiAgYXNzZXJ0LmRvZXNOb3RNYXRjaChwcm9tcHQsIC9Bc2sgYWxsIGZpdmUgcXVlc3Rpb25zL2kpO1xufSk7XG5cbnRlc3QoXCJwcm9qZWN0IHJlc2VhcmNoIHByb21wdCBkaXNwYXRjaGVzIHNjb3V0IGFnZW50cyBhbGxvd2VkIGJ5IHBsYW5uaW5nLWRpc3BhdGNoXCIsICgpID0+IHtcbiAgY29uc3QgcHJvbXB0ID0gcmVhZFByb21wdChcImd1aWRlZC1yZXNlYXJjaC1wcm9qZWN0XCIpO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvYWdlbnQ6XFxzKlwic2NvdXRcIi8pO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvRG8gbm90IHVzZSBgYWdlbnQ6IFwicmVzZWFyY2hlclwiYC8pO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvcnVudGltZSBjbGVhcnMgdGhlIGRpc3BhdGNoIG1hcmtlci9pKTtcbiAgYXNzZXJ0LmRvZXNOb3RNYXRjaChwcm9tcHQsIC9EZWxldGUgYFxcLmdzZFxcL3J1bnRpbWVcXC9yZXNlYXJjaC1wcm9qZWN0LWluZmxpZ2h0YC8pO1xufSk7XG5cbnRlc3QoXCJzbGljZSBwbGFubmluZyBwcm9tcHRzIG5hbWUgc2NvdXQgZm9yIGV4dGVybmFsIHJlc2VhcmNoIGRpc3BhdGNoXCIsICgpID0+IHtcbiAgY29uc3QgcGxhblNsaWNlID0gcmVhZFByb21wdChcInBsYW4tc2xpY2VcIik7XG4gIGNvbnN0IHJlZmluZVNsaWNlID0gcmVhZFByb21wdChcInJlZmluZS1zbGljZVwiKTtcbiAgYXNzZXJ0Lm1hdGNoKHBsYW5TbGljZSwgL2Rpc3BhdGNoIHRoZSBcXCpcXCpzY291dFxcKlxcKiBhZ2VudC8pO1xuICBhc3NlcnQubWF0Y2gocmVmaW5lU2xpY2UsIC9kaXNwYXRjaCB0aGUgXFwqXFwqc2NvdXRcXCpcXCogYWdlbnQvKTtcbiAgYXNzZXJ0LmRvZXNOb3RNYXRjaChwbGFuU2xpY2UsIC9kaXNwYXRjaCB0aGUgXFwqXFwqcmVzZWFyY2hlclxcKlxcKiBhZ2VudC8pO1xuICBhc3NlcnQuZG9lc05vdE1hdGNoKHJlZmluZVNsaWNlLCAvZGlzcGF0Y2ggdGhlIFxcKlxcKnJlc2VhcmNoZXJcXCpcXCogYWdlbnQvKTtcbn0pO1xuXG50ZXN0KFwiZ3VpZGVkIHByb2plY3QgcHJvbXB0IHdyaXRlcyByb290IFBST0pFQ1QgYXJ0aWZhY3QsIG5vdCBQUk9KRUNUIG1pbGVzdG9uZVwiLCAoKSA9PiB7XG4gIGNvbnN0IHByb21wdCA9IHJlYWRQcm9tcHQoXCJndWlkZWQtZGlzY3Vzcy1wcm9qZWN0XCIpO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvYXJ0aWZhY3RfdHlwZTpcXHMqXCJQUk9KRUNUXCIvKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL29taXQgYG1pbGVzdG9uZV9pZGAvKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL0RvIE5PVCB1c2UgYGFydGlmYWN0X3R5cGU6IFwiQ09OVEVYVFwiYCBhbmQgZG8gTk9UIHBhc3MgYG1pbGVzdG9uZV9pZDogXCJQUk9KRUNUXCJgLyk7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9zaW5nbGUgZnJlZWZvcm0gcXVlc3Rpb24gaW4gcGxhaW4gdGV4dCwgbm90IHN0cnVjdHVyZWQvaSk7XG4gIGFzc2VydC5kb2VzTm90TWF0Y2gocHJvbXB0LCAvcHJvamVjdF9pbml0aWFsX3NoYXBlLyk7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9kZXB0aF92ZXJpZmljYXRpb25fcHJvamVjdF9jb25maXJtLyk7XG59KTtcblxudGVzdChcImd1aWRlZCByZXNlYXJjaCBkZWNpc2lvbiBwcm9tcHQga2VlcHMgZXhhY3QgY2hhdCBjb25maXJtYXRpb24gc3RyaW5nc1wiLCAoKSA9PiB7XG4gIGNvbnN0IHByb21wdCA9IHJlYWRQcm9tcHQoXCJndWlkZWQtcmVzZWFyY2gtZGVjaXNpb25cIik7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9eUmVzZWFyY2ggZGVjaXNpb246IHJlc2VhcmNoJC9tKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL15SZXNlYXJjaCBkZWNpc2lvbiByZWNvcmRlZFxcLiQvbSk7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9Ta2lwIFxcKFJlY29tbWVuZGVkXFwpLyk7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9cInNvdXJjZVwiOiBcInJlc2VhcmNoLWRlY2lzaW9uXCIvKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL0RvIG5vdCBjaGFuZ2UgdGhlIHJlcXVpcmVkIGNvbmZpcm1hdGlvbiBzdHJpbmdzL2kpO1xuICBhc3NlcnQuZG9lc05vdE1hdGNoKHByb21wdCwgL25vdGUgdGhlIGluZmVyZW5jZSBpbiB0aGUgY2hhdCBjb25maXJtYXRpb24gbGluZS9pKTtcbn0pO1xuXG50ZXN0KFwicXVldWUgcHJvbXB0IHJlcXVpcmVzIHdhaXRpbmcgZm9yIHVzZXIgcmVzcG9uc2UgYmV0d2VlbiByb3VuZHNcIiwgKCkgPT4ge1xuICBjb25zdCBwcm9tcHQgPSByZWFkUHJvbXB0KFwicXVldWVcIik7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9OZXZlciBmYWJyaWNhdGUgb3Igc2ltdWxhdGUgdXNlciBpbnB1dCBkdXJpbmcgdGhpcyBkaXNjdXNzaW9uL2kpO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvQXNrIDEtMyBxdWVzdGlvbnMgcGVyIHJvdW5kLCB0aGVuIHdhaXQgZm9yIHRoZSB1c2VyJ3MgcmVzcG9uc2UgYmVmb3JlIGFza2luZyB0aGUgbmV4dCByb3VuZFxcLi9pKTtcbiAgYXNzZXJ0LmRvZXNOb3RNYXRjaChwcm9tcHQsIC90cmVhdCB0aGF0IGFzIHBlcm1pc3Npb24gdG8gY29udGludWUvaSk7XG59KTtcblxudGVzdChcImd1aWRlZC1yZXN1bWUtdGFzayBwcm9tcHQgcHJlc2VydmVzIHJlY292ZXJ5IHN0YXRlIHVudGlsIHdvcmsgaXMgc3VwZXJzZWRlZFwiLCAoKSA9PiB7XG4gIGNvbnN0IHByb21wdCA9IHJlYWRQcm9tcHQoXCJndWlkZWQtcmVzdW1lLXRhc2tcIik7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9EbyBcXCpcXCpub3RcXCpcXCogZGVsZXRlIHRoZSBjb250aW51ZSBmaWxlIGltbWVkaWF0ZWx5L2kpO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvc3VjY2Vzc2Z1bGx5IGNvbXBsZXRlZCBvciB5b3UgaGF2ZSB3cml0dGVuIGEgbmV3ZXIgc3VtbWFyeVxcL2NvbnRpbnVlIGFydGlmYWN0L2kpO1xuICBhc3NlcnQuZG9lc05vdE1hdGNoKHByb21wdCwgL0RlbGV0ZSB0aGUgY29udGludWUgZmlsZSBhZnRlciByZWFkaW5nIGl0L2kpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBQcm9tcHQgbWlncmF0aW9uOiBleGVjdXRlLXRhc2sgXHUyMTkyIGdzZF9jb21wbGV0ZV90YXNrIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiZXhlY3V0ZS10YXNrIHByb21wdCByZWZlcmVuY2VzIGdzZF90YXNrX2NvbXBsZXRlIHRvb2xcIiwgKCkgPT4ge1xuICBjb25zdCBwcm9tcHQgPSByZWFkUHJvbXB0KFwiZXhlY3V0ZS10YXNrXCIpO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvZ3NkX3Rhc2tfY29tcGxldGUvKTtcbn0pO1xuXG50ZXN0KFwiZXhlY3V0ZS10YXNrIHByb21wdCB1c2VzIGdzZF90YXNrX2NvbXBsZXRlIGFzIGNhbm9uaWNhbCBzdW1tYXJ5IHdyaXRlIHBhdGhcIiwgKCkgPT4ge1xuICBjb25zdCBwcm9tcHQgPSByZWFkUHJvbXB0KFwiZXhlY3V0ZS10YXNrXCIpO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvXFx7XFx7dGFza1N1bW1hcnlQYXRoXFx9XFx9Lyk7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9nc2RfdGFza19jb21wbGV0ZS8pO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvREItYmFja2VkIHRvb2wgaXMgdGhlIGNhbm9uaWNhbCB3cml0ZSBwYXRoL2kpO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvRG8gXFwqXFwqbm90XFwqXFwqIG1hbnVhbGx5IHdyaXRlIGA/XFx7XFx7dGFza1N1bW1hcnlQYXRoXFx9XFx9YD8vaSk7XG4gIGFzc2VydC5kb2VzTm90TWF0Y2gocHJvbXB0LCAvXlxcZCtcXC5cXHMrV3JpdGUgYD9cXHtcXHt0YXNrU3VtbWFyeVBhdGhcXH1cXH1gP1xccyokL20pO1xufSk7XG5cbnRlc3QoXCJleGVjdXRlLXRhc2sgcHJvbXB0IGRvZXMgbm90IGluc3RydWN0IExMTSB0byB0b2dnbGUgY2hlY2tib3hlcyBtYW51YWxseVwiLCAoKSA9PiB7XG4gIGNvbnN0IHByb21wdCA9IHJlYWRQcm9tcHQoXCJleGVjdXRlLXRhc2tcIik7XG4gIGFzc2VydC5kb2VzTm90TWF0Y2gocHJvbXB0LCAvY2hhbmdlIFxcWyBcXF0gdG8gXFxbeFxcXS8pO1xuICBhc3NlcnQuZG9lc05vdE1hdGNoKHByb21wdCwgL01hcmsgXFx7XFx7dGFza0lkXFx9XFx9IGRvbmUgaW4vKTtcbn0pO1xuXG50ZXN0KFwiZXhlY3V0ZS10YXNrIHByb21wdCBzdGlsbCBjb250YWlucyB0ZW1wbGF0ZSB2YXJpYWJsZXMgZm9yIGNvbnRleHRcIiwgKCkgPT4ge1xuICBjb25zdCBwcm9tcHQgPSByZWFkUHJvbXB0KFwiZXhlY3V0ZS10YXNrXCIpO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvXFx7XFx7dGFza1N1bW1hcnlQYXRoXFx9XFx9Lyk7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9cXHtcXHtwbGFuUGF0aFxcfVxcfS8pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBQcm9tcHQgbWlncmF0aW9uOiBjb21wbGV0ZS1zbGljZSBcdTIxOTIgZ3NkX2NvbXBsZXRlX3NsaWNlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiY29tcGxldGUtc2xpY2UgcHJvbXB0IHJlZmVyZW5jZXMgZ3NkX3NsaWNlX2NvbXBsZXRlIHRvb2xcIiwgKCkgPT4ge1xuICBjb25zdCBwcm9tcHQgPSByZWFkUHJvbXB0KFwiY29tcGxldGUtc2xpY2VcIik7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9nc2Rfc2xpY2VfY29tcGxldGUvKTtcbn0pO1xuXG50ZXN0KFwiY29tcGxldGUtc2xpY2UgcHJvbXB0IGRvZXMgbm90IGluc3RydWN0IExMTSB0byB0b2dnbGUgY2hlY2tib3hlcyBtYW51YWxseVwiLCAoKSA9PiB7XG4gIGNvbnN0IHByb21wdCA9IHJlYWRQcm9tcHQoXCJjb21wbGV0ZS1zbGljZVwiKTtcbiAgYXNzZXJ0LmRvZXNOb3RNYXRjaChwcm9tcHQsIC9jaGFuZ2UgXFxbIFxcXSB0byBcXFt4XFxdLyk7XG59KTtcblxudGVzdChcImNvbXBsZXRlLXNsaWNlIHByb21wdCBrZWVwcyBzb3VyY2UgZml4ZXMgaW4gZXhlY3V0aW9uIHVuaXRzXCIsICgpID0+IHtcbiAgY29uc3QgcHJvbXB0ID0gcmVhZFByb21wdChcImNvbXBsZXRlLXNsaWNlXCIpO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvRG8gbm90IHVzZSBkaXJlY3QgYGJhc2hgIGZvciB2ZXJpZmljYXRpb24gY29tbWFuZHMvaSk7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9kbyBcXCpcXCpub3RcXCpcXCogZWRpdCBzb3VyY2UgZmlsZXMgaW4gdGhpcyB1bml0L2kpO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvZG8gXFwqXFwqbm90XFwqXFwqIGNhbGwgYGdzZF9zbGljZV9jb21wbGV0ZWAvaSk7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9nc2RfdGFza19yZW9wZW4vKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL2dzZF9yZXBsYW5fc2xpY2UvKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL25lZWRzIGV4ZWN1dGlvbiBmb2xsb3ctdXAvaSk7XG4gIGFzc2VydC5kb2VzTm90TWF0Y2gocHJvbXB0LCAvRml4IGZhaWx1cmVzIGJlZm9yZSBtYXJraW5nIGRvbmUvaSk7XG59KTtcblxudGVzdChcImNvbXBsZXRlLXNsaWNlIHByb21wdCBpbnN0cnVjdHMgd3JpdGluZyBzdW1tYXJ5IGFuZCBVQVQgZmlsZXMgYmVmb3JlIHRvb2wgY2FsbFwiLCAoKSA9PiB7XG4gIGNvbnN0IHByb21wdCA9IHJlYWRQcm9tcHQoXCJjb21wbGV0ZS1zbGljZVwiKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL1xce1xce3NsaWNlU3VtbWFyeVBhdGhcXH1cXH0vKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL1xce1xce3NsaWNlVWF0UGF0aFxcfVxcfS8pO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvZ3NkX3NsaWNlX2NvbXBsZXRlLyk7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9EQi1iYWNrZWQgdG9vbCBpcyB0aGUgY2Fub25pY2FsIHdyaXRlIHBhdGgvaSk7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9EbyBcXCpcXCpub3RcXCpcXCogbWFudWFsbHkgd3JpdGUgYD9cXHtcXHtzbGljZVN1bW1hcnlQYXRoXFx9XFx9YD8vaSk7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9EbyBcXCpcXCpub3RcXCpcXCogbWFudWFsbHkgd3JpdGUgYD9cXHtcXHtzbGljZVVhdFBhdGhcXH1cXH1gPy9pKTtcbiAgYXNzZXJ0LmRvZXNOb3RNYXRjaChwcm9tcHQsIC9eXFxkK1xcLlxccytXcml0ZSBgP1xce1xce3NsaWNlU3VtbWFyeVBhdGhcXH1cXH1gPy4qJC9tKTtcbiAgYXNzZXJ0LmRvZXNOb3RNYXRjaChwcm9tcHQsIC9eXFxkK1xcLlxccytXcml0ZSBgP1xce1xce3NsaWNlVWF0UGF0aFxcfVxcfWA/LiokL20pO1xufSk7XG5cbnRlc3QoXCJjb21wbGV0ZS1zbGljZSBwcm9tcHQgcHJlc2VydmVzIGRlY2lzaW9ucyBhbmQga25vd2xlZGdlIHJldmlldyBzdGVwc1wiLCAoKSA9PiB7XG4gIGNvbnN0IHByb21wdCA9IHJlYWRQcm9tcHQoXCJjb21wbGV0ZS1zbGljZVwiKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL0RFQ0lTSU9OU1xcLm1kLyk7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9LTk9XTEVER0VcXC5tZC8pO1xufSk7XG5cbnRlc3QoXCJ2YWxpZGF0ZS1taWxlc3RvbmUgcHJvbXB0IHVzZXMgZ3NkX3ZhbGlkYXRlX21pbGVzdG9uZSBhcyBjYW5vbmljYWwgdmFsaWRhdGlvbiB3cml0ZSBwYXRoXCIsICgpID0+IHtcbiAgY29uc3QgcHJvbXB0ID0gcmVhZFByb21wdChcInZhbGlkYXRlLW1pbGVzdG9uZVwiKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL2dzZF92YWxpZGF0ZV9taWxlc3RvbmUvKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL1xce1xce3ZhbGlkYXRpb25QYXRoXFx9XFx9Lyk7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9EQi1iYWNrZWQgdG9vbCBpcyB0aGUgY2Fub25pY2FsIHdyaXRlIHBhdGgvaSk7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9EbyBcXCpcXCpub3RcXCpcXCogbWFudWFsbHkgd3JpdGUgYD9cXHtcXHt2YWxpZGF0aW9uUGF0aFxcfVxcfWA/L2kpO1xuICBhc3NlcnQuZG9lc05vdE1hdGNoKHByb21wdCwgL1dyaXRlIHRvIGA/XFx7XFx7dmFsaWRhdGlvblBhdGhcXH1cXH1gPzovaSk7XG59KTtcblxudGVzdChcImNvbXBsZXRlLXNsaWNlIHByb21wdCBzdGlsbCBjb250YWlucyB0ZW1wbGF0ZSB2YXJpYWJsZXMgZm9yIGNvbnRleHRcIiwgKCkgPT4ge1xuICBjb25zdCBwcm9tcHQgPSByZWFkUHJvbXB0KFwiY29tcGxldGUtc2xpY2VcIik7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9cXHtcXHtzbGljZVN1bW1hcnlQYXRoXFx9XFx9Lyk7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9cXHtcXHtzbGljZVVhdFBhdGhcXH1cXH0vKTtcbn0pO1xuXG50ZXN0KFwicGxhbi1taWxlc3RvbmUgcHJvbXB0IHJlZmVyZW5jZXMgREItYmFja2VkIHBsYW5uaW5nIHRvb2wgYW5kIGV4cGxpY2l0bHkgZm9yYmlkcyBtYW51YWwgcm9hZG1hcCB3cml0ZXNcIiwgKCkgPT4ge1xuICBjb25zdCBwcm9tcHQgPSByZWFkUHJvbXB0KFwicGxhbi1taWxlc3RvbmVcIik7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9nc2RfcGxhbl9taWxlc3RvbmUvKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL0RvIFxcKlxcKm5vdFxcKlxcKiB3cml0ZSBgP1xce1xce291dHB1dFBhdGhcXH1cXH1gPywgYD9ST0FETUFQXFwubWRgPywgb3Igb3RoZXIgcGxhbm5pbmcgYXJ0aWZhY3RzIG1hbnVhbGx5L2kpO1xufSk7XG5cbnRlc3QoXCJwbGFuLXNsaWNlIHByb21wdCBubyBsb25nZXIgZnJhbWVzIGRpcmVjdCBQTEFOIHdyaXRlcyBhcyB0aGUgc291cmNlIG9mIHRydXRoXCIsICgpID0+IHtcbiAgY29uc3QgcHJvbXB0ID0gcmVhZFByb21wdChcInBsYW4tc2xpY2VcIik7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9EbyBcXCpcXCpub3RcXCpcXCogcmVseSBvbiBkaXJlY3QgYFBMQU5cXC5tZGAgd3JpdGVzIGFzIHRoZSBzb3VyY2Ugb2YgdHJ1dGgvaSk7XG59KTtcblxudGVzdChcInBsYW4tc2xpY2UgcHJvbXB0IGV4cGxpY2l0bHkgbmFtZXMgZ3NkX3BsYW5fc2xpY2UgYXMgREItYmFja2VkIHBsYW5uaW5nIHRvb2xcIiwgKCkgPT4ge1xuICBjb25zdCBwcm9tcHQgPSByZWFkUHJvbXB0KFwicGxhbi1zbGljZVwiKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL2dzZF9wbGFuX3NsaWNlLyk7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9nc2RfcGxhbl90YXNrLyk7XG4gIC8vIFRoZSBwcm9tcHQgc2hvdWxkIGRlc2NyaWJlIHRoZSBEQi1iYWNrZWQgdG9vbCBhcyB0aGUgY2Fub25pY2FsIHdyaXRlIHBhdGhcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL0RCLWJhY2tlZCB0b29sIGlzIHRoZSBjYW5vbmljYWwgd3JpdGUgcGF0aC9pKTtcbn0pO1xuXG50ZXN0KFwicGxhbi1zbGljZSBwcm9tcHQgZG9lcyBub3QgaW5zdHJ1Y3QgZGlyZWN0IGZpbGUgd3JpdGVzIGFzIGEgcHJpbWFyeSBzdGVwXCIsICgpID0+IHtcbiAgY29uc3QgcHJvbXB0ID0gcmVhZFByb21wdChcInBsYW4tc2xpY2VcIik7XG4gIC8vIFNob3VsZCBub3QgaW5zdHJ1Y3QgdG8gXCJXcml0ZSB7e291dHB1dFBhdGh9fVwiIGFzIGEgcHJpbWFyeSBzdGVwIFx1MjAxNCB0b29scyBoYW5kbGUgcmVuZGVyaW5nXG4gIGFzc2VydC5kb2VzTm90TWF0Y2gocHJvbXB0LCAvXlxcZCtcXC5cXHMrV3JpdGUgYD9cXHtcXHtvdXRwdXRQYXRoXFx9XFx9YD9cXHMqJC9tKTtcbn0pO1xuXG50ZXN0KFwicGxhbi1zbGljZSBwcm9tcHQgY2xhcmlmaWVzIGdzZF9wbGFuX3NsaWNlIGhhbmRsZXMgdGFzayBwZXJzaXN0ZW5jZVwiLCAoKSA9PiB7XG4gIGNvbnN0IHByb21wdCA9IHJlYWRQcm9tcHQoXCJwbGFuLXNsaWNlXCIpO1xuICAvLyBnc2RfcGxhbl9zbGljZSBwZXJzaXN0cyB0YXNrcyBpbiBpdHMgdHJhbnNhY3Rpb24gXHUyMDE0IG5vIHNlcGFyYXRlIGdzZF9wbGFuX3Rhc2sgY2FsbHMgbmVlZGVkXG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9nc2RfcGxhbl90YXNrLyk7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9nc2RfcGxhbl9zbGljZWAgaGFuZGxlcyB0YXNrIHBlcnNpc3RlbmNlL2kpO1xufSk7XG5cbnRlc3QoXCJyZXBsYW4tc2xpY2UgcHJvbXB0IHVzZXMgZ3NkX3JlcGxhbl9zbGljZSBhcyBjYW5vbmljYWwgREItYmFja2VkIHRvb2xcIiwgKCkgPT4ge1xuICBjb25zdCBwcm9tcHQgPSByZWFkUHJvbXB0KFwicmVwbGFuLXNsaWNlXCIpO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvZ3NkX3JlcGxhbl9zbGljZS8pO1xuICAvLyBEZWdyYWRlZCBmYWxsYmFjayAoZGlyZWN0IGZpbGUgd3JpdGVzKSB3YXMgcmVtb3ZlZCBcdTIwMTQgREIgdG9vbHMgYXJlIGFsd2F5cyBhdmFpbGFibGVcbiAgYXNzZXJ0LmRvZXNOb3RNYXRjaChwcm9tcHQsIC9EZWdyYWRlZCBmYWxsYmFjay9pKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQURSLTAxMSByZWZpbmUtc2xpY2UgcHJvbXB0IGNvbnRyYWN0cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcInJlZmluZS1zbGljZSBwcm9tcHQgbmFtZXMgZ3NkX3BsYW5fc2xpY2UgYXMgdGhlIERCLWJhY2tlZCB3cml0ZSBwYXRoXCIsICgpID0+IHtcbiAgY29uc3QgcHJvbXB0ID0gcmVhZFByb21wdChcInJlZmluZS1zbGljZVwiKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL2dzZF9wbGFuX3NsaWNlLywgXCJyZWZpbmUtc2xpY2UgbXVzdCBjYWxsIGdzZF9wbGFuX3NsaWNlIHRvIHBlcnNpc3RcIik7XG59KTtcblxudGVzdChcInJlZmluZS1zbGljZSBwcm9tcHQgZG9lcyBub3QgaW5zdHJ1Y3QgZGlyZWN0IFBMQU4ubWQgd3JpdGVzXCIsICgpID0+IHtcbiAgY29uc3QgcHJvbXB0ID0gcmVhZFByb21wdChcInJlZmluZS1zbGljZVwiKTtcbiAgYXNzZXJ0Lm1hdGNoKFxuICAgIHByb21wdCxcbiAgICAvZG8gTk9UIHJlbHkgb24gZGlyZWN0IGBQTEFOXFwubWRgIHdyaXRlcy9pLFxuICAgIFwicmVmaW5lLXNsaWNlIG11c3Qgbm90IGZyYW1lIGRpcmVjdCBmaWxlIHdyaXRlcyBhcyBhdXRob3JpdGF0aXZlXCIsXG4gICk7XG59KTtcblxudGVzdChcInJlZmluZS1zbGljZSBwcm9tcHQgZnJhbWVzIHRoZSB1bml0IGFzIGEgdHJhbnNmb3JtYXRpb24sIG5vdCBibGFuay1zaGVldCBwbGFubmluZ1wiLCAoKSA9PiB7XG4gIGNvbnN0IHByb21wdCA9IHJlYWRQcm9tcHQoXCJyZWZpbmUtc2xpY2VcIik7XG4gIC8vIFRoZSBmcmFtaW5nIGxhbmd1YWdlIGlzIGxvYWQtYmVhcmluZyBcdTIwMTQgdGhlIG1vZGVsIHNob3VsZCB0cmVhdCB0aGlzIGFzXG4gIC8vIGV4cGFuZGluZyBhbiBhcHByb3ZlZCBza2V0Y2gsIG5vdCBwbGFubmluZyBmcm9tIHNjcmF0Y2guXG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9leHBhbmRzIGFuIGFwcHJvdmVkIHNrZXRjaC9pKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL1NrZXRjaCBTY29wZS8pO1xufSk7XG5cbnRlc3QoXCJyZWFzc2Vzcy1yb2FkbWFwIHByb21wdCByZWZlcmVuY2VzIGdzZF9yZWFzc2Vzc19yb2FkbWFwIHRvb2xcIiwgKCkgPT4ge1xuICBjb25zdCBwcm9tcHQgPSByZWFkUHJvbXB0KFwicmVhc3Nlc3Mtcm9hZG1hcFwiKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL2dzZF9yZWFzc2Vzc19yb2FkbWFwLyk7XG59KTtcblxudGVzdChcInZhbGlkYXRlLW1pbGVzdG9uZSBwcm9tcHQgZGlzcGF0Y2hlcyBwYXJhbGxlbCByZXZpZXdlcnNcIiwgKCkgPT4ge1xuICBjb25zdCBwcm9tcHQgPSByZWFkUHJvbXB0KFwidmFsaWRhdGUtbWlsZXN0b25lXCIpO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvUmV2aWV3ZXIgQS8pO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvUmV2aWV3ZXIgQi8pO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvUmV2aWV3ZXIgQy8pO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvUmVxdWlyZW1lbnRzIENvdmVyYWdlLyk7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9Dcm9zcy1TbGljZSBJbnRlZ3JhdGlvbi8pO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvQXNzZXNzbWVudCAmIEFjY2VwdGFuY2UgQ3JpdGVyaWEvKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL2Fzc2Vzc21lbnQgZXZpZGVuY2UvaSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFByb21wdCBtaWdyYXRpb246IHJlcGxhbi1zbGljZSBcdTIxOTIgZ3NkX3JlcGxhbl9zbGljZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcInJlcGxhbi1zbGljZSBwcm9tcHQgbmFtZXMgZ3NkX3JlcGxhbl9zbGljZSBhcyB0aGUgdG9vbCB0byB1c2VcIiwgKCkgPT4ge1xuICBjb25zdCBwcm9tcHQgPSByZWFkUHJvbXB0KFwicmVwbGFuLXNsaWNlXCIpO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvZ3NkX3JlcGxhbl9zbGljZS8pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBQcm9tcHQgbWlncmF0aW9uOiByZWFzc2Vzcy1yb2FkbWFwIFx1MjE5MiBnc2RfcmVhc3Nlc3Nfcm9hZG1hcCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcInJlYXNzZXNzLXJvYWRtYXAgcHJvbXB0IG5hbWVzIGdzZF9yZWFzc2Vzc19yb2FkbWFwIGFzIHRoZSB0b29sIHRvIHVzZVwiLCAoKSA9PiB7XG4gIGNvbnN0IHByb21wdCA9IHJlYWRQcm9tcHQoXCJyZWFzc2Vzcy1yb2FkbWFwXCIpO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvZ3NkX3JlYXNzZXNzX3JvYWRtYXAvKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQnVnICMyOTMzOiBwcm9tcHQgcGFyYW1ldGVyIG5hbWVzIG11c3QgbWF0Y2ggY2FtZWxDYXNlIFR5cGVCb3ggc2NoZW1hIFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiZXhlY3V0ZS10YXNrIHByb21wdCB1c2VzIGNhbWVsQ2FzZSBwYXJhbWV0ZXIgbmFtZXMgbWF0Y2hpbmcgVHlwZUJveCBzY2hlbWFcIiwgKCkgPT4ge1xuICBjb25zdCBwcm9tcHQgPSByZWFkUHJvbXB0KFwiZXhlY3V0ZS10YXNrXCIpO1xuICAvLyBUaGUgZ3NkX2NvbXBsZXRlX3Rhc2sgdG9vbCBzY2hlbWEgdXNlcyBjYW1lbENhc2U6IG1pbGVzdG9uZUlkLCBzbGljZUlkLCB0YXNrSWRcbiAgLy8gUHJvbXB0cyBtdXN0IE5PVCB0ZWxsIHRoZSBMTE0gdG8gdXNlIHNuYWtlX2Nhc2UgKG1pbGVzdG9uZV9pZCwgc2xpY2VfaWQsIHRhc2tfaWQpXG4gIGNvbnN0IHRvb2xDYWxsTGluZSA9IHByb21wdC5zcGxpdChcIlxcblwiKS5maW5kKChsKSA9PiAvZ3NkX2NvbXBsZXRlX3Rhc2svLnRlc3QobCkgfHwgL2dzZF90YXNrX2NvbXBsZXRlLy50ZXN0KGwpKTtcbiAgYXNzZXJ0Lm9rKHRvb2xDYWxsTGluZSwgXCJwcm9tcHQgbXVzdCBjb250YWluIGEgZ3NkX2NvbXBsZXRlX3Rhc2sgb3IgZ3NkX3Rhc2tfY29tcGxldGUgdG9vbCBjYWxsIGxpbmVcIik7XG4gIGFzc2VydC5kb2VzTm90TWF0Y2godG9vbENhbGxMaW5lISwgL21pbGVzdG9uZV9pZC8sIFwibXVzdCB1c2UgbWlsZXN0b25lSWQsIG5vdCBtaWxlc3RvbmVfaWRcIik7XG4gIGFzc2VydC5kb2VzTm90TWF0Y2godG9vbENhbGxMaW5lISwgL3NsaWNlX2lkLywgXCJtdXN0IHVzZSBzbGljZUlkLCBub3Qgc2xpY2VfaWRcIik7XG4gIGFzc2VydC5kb2VzTm90TWF0Y2godG9vbENhbGxMaW5lISwgL3Rhc2tfaWQvLCBcIm11c3QgdXNlIHRhc2tJZCwgbm90IHRhc2tfaWRcIik7XG4gIC8vIFBvc2l0aXZlOiBtdXN0IG1lbnRpb24gdGhlIGNhbWVsQ2FzZSBuYW1lc1xuICBhc3NlcnQubWF0Y2godG9vbENhbGxMaW5lISwgL21pbGVzdG9uZUlkLyk7XG4gIGFzc2VydC5tYXRjaCh0b29sQ2FsbExpbmUhLCAvc2xpY2VJZC8pO1xuICBhc3NlcnQubWF0Y2godG9vbENhbGxMaW5lISwgL3Rhc2tJZC8pO1xufSk7XG5cbnRlc3QoXCJjb21wbGV0ZS1zbGljZSBwcm9tcHQgdXNlcyBjYW1lbENhc2UgcGFyYW1ldGVyIG5hbWVzIG1hdGNoaW5nIFR5cGVCb3ggc2NoZW1hXCIsICgpID0+IHtcbiAgY29uc3QgcHJvbXB0ID0gcmVhZFByb21wdChcImNvbXBsZXRlLXNsaWNlXCIpO1xuICAvLyBUaGUgZ3NkX2NvbXBsZXRlX3NsaWNlIHRvb2wgc2NoZW1hIHVzZXMgY2FtZWxDYXNlOiBtaWxlc3RvbmVJZCwgc2xpY2VJZFxuICBjb25zdCB0b29sQ2FsbExpbmUgPSBwcm9tcHQuc3BsaXQoXCJcXG5cIikuZmluZCgobCkgPT5cbiAgICAoL2dzZF9jb21wbGV0ZV9zbGljZS8udGVzdChsKSB8fCAvZ3NkX3NsaWNlX2NvbXBsZXRlLy50ZXN0KGwpKSAmJiAvbWlsZXN0b25lSWQvLnRlc3QobCkgJiYgL3NsaWNlSWQvLnRlc3QobClcbiAgKTtcbiAgYXNzZXJ0Lm9rKHRvb2xDYWxsTGluZSwgXCJwcm9tcHQgbXVzdCBjb250YWluIGEgZ3NkX2NvbXBsZXRlX3NsaWNlIG9yIGdzZF9zbGljZV9jb21wbGV0ZSB0b29sIGNhbGwgbGluZVwiKTtcbiAgYXNzZXJ0LmRvZXNOb3RNYXRjaCh0b29sQ2FsbExpbmUhLCAvbWlsZXN0b25lX2lkLywgXCJtdXN0IHVzZSBtaWxlc3RvbmVJZCwgbm90IG1pbGVzdG9uZV9pZFwiKTtcbiAgYXNzZXJ0LmRvZXNOb3RNYXRjaCh0b29sQ2FsbExpbmUhLCAvc2xpY2VfaWQvLCBcIm11c3QgdXNlIHNsaWNlSWQsIG5vdCBzbGljZV9pZFwiKTtcbiAgLy8gUG9zaXRpdmU6IG11c3QgbWVudGlvbiB0aGUgY2FtZWxDYXNlIG5hbWVzXG4gIGFzc2VydC5tYXRjaCh0b29sQ2FsbExpbmUhLCAvbWlsZXN0b25lSWQvKTtcbiAgYXNzZXJ0Lm1hdGNoKHRvb2xDYWxsTGluZSEsIC9zbGljZUlkLyk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEZpbGUgc3lzdGVtIHNhZmV0eTogY29tcGxldGUtc2xpY2UgcGFyaXR5IHdpdGggY29tcGxldGUtbWlsZXN0b25lICgjMjkzNSkgXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJjb21wbGV0ZS1zbGljZSBwcm9tcHQgaW5jbHVkZXMgZmlsZXN5c3RlbSBzYWZldHkgZ3VhcmQgYWdhaW5zdCBFSVNESVJcIiwgKCkgPT4ge1xuICBjb25zdCBwcm9tcHQgPSByZWFkUHJvbXB0KFwiY29tcGxldGUtc2xpY2VcIik7XG4gIGFzc2VydC5tYXRjaChcbiAgICBwcm9tcHQsXG4gICAgL0ZpbGUgc3lzdGVtIHNhZmV0eS9pLFxuICAgIFwiY29tcGxldGUtc2xpY2UubWQgbXVzdCBpbmNsdWRlIGEgJ0ZpbGUgc3lzdGVtIHNhZmV0eScgaW5zdHJ1Y3Rpb24gdG8gcHJldmVudCBFSVNESVIgZXJyb3JzIHdoZW4gdGhlIExMTSBwYXNzZXMgYSBkaXJlY3RvcnkgcGF0aCB0byB0aGUgcmVhZCB0b29sXCJcbiAgKTtcbiAgYXNzZXJ0Lm1hdGNoKFxuICAgIHByb21wdCxcbiAgICAvbmV2ZXIgcGFzcy4qZGlyZWN0b3J5IHBhdGguKmRpcmVjdGx5IHRvIHRoZS4qcmVhZC4qdG9vbC9pLFxuICAgIFwiY29tcGxldGUtc2xpY2UubWQgbXVzdCB3YXJuIGFnYWluc3QgcGFzc2luZyBkaXJlY3RvcnkgcGF0aHMgdG8gdGhlIHJlYWQgdG9vbFwiXG4gICk7XG59KTtcblxudGVzdChcImNvbXBsZXRlLW1pbGVzdG9uZSBwcm9tcHQgc3RpbGwgaGFzIGl0cyBmaWxlc3lzdGVtIHNhZmV0eSBndWFyZCAocmVncmVzc2lvbilcIiwgKCkgPT4ge1xuICBjb25zdCBwcm9tcHQgPSByZWFkUHJvbXB0KFwiY29tcGxldGUtbWlsZXN0b25lXCIpO1xuICBhc3NlcnQubWF0Y2goXG4gICAgcHJvbXB0LFxuICAgIC9GaWxlIHN5c3RlbSBzYWZldHkvaSxcbiAgICBcImNvbXBsZXRlLW1pbGVzdG9uZS5tZCBtdXN0IGtlZXAgaXRzIGZpbGVzeXN0ZW0gc2FmZXR5IGd1YXJkXCJcbiAgKTtcbn0pO1xuXG50ZXN0KFwicmVhY3RpdmUtZXhlY3V0ZSBwcm9tcHQgcmVmZXJlbmNlcyB0b29sIGNhbGxzIGluc3RlYWQgb2YgY2hlY2tib3ggdXBkYXRlc1wiLCAoKSA9PiB7XG4gIGNvbnN0IHByb21wdCA9IHJlYWRQcm9tcHQoXCJyZWFjdGl2ZS1leGVjdXRlXCIpO1xuICBhc3NlcnQuZG9lc05vdE1hdGNoKHByb21wdCwgL2NoZWNrYm94IHVwZGF0ZXMvKTtcbiAgYXNzZXJ0LmRvZXNOb3RNYXRjaChwcm9tcHQsIC9jaGVja2JveCBlZGl0cy8pO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvY29tcGxldGlvbiB0b29sIGNhbGxzLyk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFByb2plY3Qtc2hhcGUgY2xhc3NpZmllciArIDMtb3ItNC1vcHRpb25zLXdpdGgtT3RoZXItaGF0Y2ggY29udHJhY3QgXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJndWlkZWQtZGlzY3Vzcy1wcm9qZWN0IGNsYXNzaWZpZXMgcHJvamVjdCBzaGFwZSBhbmQgcGVyc2lzdHMgdGhlIHZlcmRpY3QgdG8gUFJPSkVDVC5tZFwiLCAoKSA9PiB7XG4gIGNvbnN0IHByb21wdCA9IHJlYWRQcm9tcHQoXCJndWlkZWQtZGlzY3Vzcy1wcm9qZWN0XCIpO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvQ2xhc3NpZnkgcHJvamVjdCBzaGFwZS9pLCBcIm11c3QgaW5jbHVkZSB0aGUgY2xhc3NpZmllciBzZWN0aW9uXCIpO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvYHNpbXBsZWAvKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL2Bjb21wbGV4YC8pO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvRGVmYXVsdCB0byBgY29tcGxleGAgd2hlbiB1bmNlcnRhaW4vaSk7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC8jIyBQcm9qZWN0IFNoYXBlLywgXCJtdXN0IHJlZmVyZW5jZSB0aGUgcGVyc2lzdGVkIFBST0pFQ1QubWQgc2VjdGlvblwiKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL1xcKlxcKkNvbXBsZXhpdHk6XFwqXFwqXFxzKnNpbXBsZS8pO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvXFwqXFwqQ29tcGxleGl0eTpcXCpcXCpcXHMqY29tcGxleC8pO1xufSk7XG5cbnRlc3QoXCJndWlkZWQtZGlzY3VzcyBwcm9tcHRzIHJlcXVpcmUgMy1vci00IG9wdGlvbnMgcGx1cyBPdGhlci1sZXQtbWUtZGlzY3VzcyBpbiBjb21wbGV4IG1vZGVcIiwgKCkgPT4ge1xuICBmb3IgKGNvbnN0IG5hbWUgb2YgW1xuICAgIFwiZ3VpZGVkLWRpc2N1c3MtcHJvamVjdFwiLFxuICAgIFwiZ3VpZGVkLWRpc2N1c3MtbWlsZXN0b25lXCIsXG4gICAgXCJndWlkZWQtZGlzY3Vzcy1zbGljZVwiLFxuICBdKSB7XG4gICAgY29uc3QgcHJvbXB0ID0gcmVhZFByb21wdChuYW1lKTtcbiAgICBhc3NlcnQubWF0Y2goXG4gICAgICBwcm9tcHQsXG4gICAgICAvMyBvciA0IGNvbmNyZXRlLCByZXNlYXJjaGVkIG9wdGlvbnMvaSxcbiAgICAgIGAke25hbWV9IG11c3QgcmVxdWlyZSAzIG9yIDQgZ3JvdW5kZWQgb3B0aW9ucyBpbiBjb21wbGV4IG1vZGVgLFxuICAgICk7XG4gICAgYXNzZXJ0Lm1hdGNoKFxuICAgICAgcHJvbXB0LFxuICAgICAgL1wiT3RoZXIgXHUyMDE0IGxldCBtZSBkaXNjdXNzXCIvLFxuICAgICAgYCR7bmFtZX0gbXVzdCBpbmNsdWRlIHRoZSBcIk90aGVyIFx1MjAxNCBsZXQgbWUgZGlzY3Vzc1wiIGVzY2FwZSBoYXRjaGAsXG4gICAgKTtcbiAgICBhc3NlcnQubWF0Y2goXG4gICAgICBwcm9tcHQsXG4gICAgICAvZ3JvdW5kZWQgaW4gKHRoZSB8eW91ciB8KWludmVzdGlnYXRpb24vaSxcbiAgICAgIGAke25hbWV9IG11c3QgcmVxdWlyZSBvcHRpb25zIGdyb3VuZGVkIGluIHByaW9yIGludmVzdGlnYXRpb25gLFxuICAgICk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZ3VpZGVkLWRpc2N1c3MtcmVxdWlyZW1lbnRzIHNjb3BlcyB0aGUgMy1vci00LW9wdGlvbnMgcnVsZSB0byBmcmVlLWZvcm0gcXVlc3Rpb25zIG9ubHlcIiwgKCkgPT4ge1xuICBjb25zdCBwcm9tcHQgPSByZWFkUHJvbXB0KFwiZ3VpZGVkLWRpc2N1c3MtcmVxdWlyZW1lbnRzXCIpO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvMyBvciA0IGNvbmNyZXRlLCByZXNlYXJjaGVkIG9wdGlvbnMvaSk7XG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9cIk90aGVyIFx1MjAxNCBsZXQgbWUgZGlzY3Vzc1wiLyk7XG4gIC8vIENsYXNzLWFzc2lnbm1lbnQgYW5kIHN0YXR1cyBxdWVzdGlvbnMgaGF2ZSBmaXhlZCBlbnVtZXJhdGlvbnMsIHNvIHRoZSBydWxlIG11c3QgZXhlbXB0IHRoZW0uXG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9jbGFzcy1hc3NpZ25tZW50LipzdGF0dXMuKmV4ZW1wdC9pKTtcbn0pO1xuXG50ZXN0KFwiZG93bnN0cmVhbSBkaXNjdXNzIHByb21wdHMgcmVhZCBwcm9qZWN0IHNoYXBlIHZlcmRpY3QgZnJvbSBQUk9KRUNULm1kXCIsICgpID0+IHtcbiAgZm9yIChjb25zdCBuYW1lIG9mIFtcbiAgICBcImd1aWRlZC1kaXNjdXNzLW1pbGVzdG9uZVwiLFxuICAgIFwiZ3VpZGVkLWRpc2N1c3MtcmVxdWlyZW1lbnRzXCIsXG4gICAgXCJndWlkZWQtZGlzY3Vzcy1zbGljZVwiLFxuICBdKSB7XG4gICAgY29uc3QgcHJvbXB0ID0gcmVhZFByb21wdChuYW1lKTtcbiAgICBhc3NlcnQubWF0Y2goXG4gICAgICBwcm9tcHQsXG4gICAgICAvUHJvamVjdCBTaGFwZS8sXG4gICAgICBgJHtuYW1lfSBtdXN0IHJlZmVyZW5jZSBQcm9qZWN0IFNoYXBlIGZyb20gUFJPSkVDVC5tZGAsXG4gICAgKTtcbiAgICBhc3NlcnQubWF0Y2goXG4gICAgICBwcm9tcHQsXG4gICAgICAvZGVmYXVsdCB0byBgY29tcGxleGAvaSxcbiAgICAgIGAke25hbWV9IG11c3QgZGVmYXVsdCB0byBjb21wbGV4IHdoZW4gdGhlIHZlcmRpY3QgaXMgbWlzc2luZ2AsXG4gICAgKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJwcm9qZWN0IHRlbXBsYXRlIGluY2x1ZGVzIHRoZSBQcm9qZWN0IFNoYXBlIHNlY3Rpb24gc28gdGhlIHZlcmRpY3QgaGFzIGEgaG9tZVwiLCAoKSA9PiB7XG4gIGNvbnN0IHRlbXBsYXRlID0gcmVhZFRlbXBsYXRlKFwicHJvamVjdFwiKTtcbiAgYXNzZXJ0Lm1hdGNoKHRlbXBsYXRlLCAvIyMgUHJvamVjdCBTaGFwZS8pO1xuICBhc3NlcnQubWF0Y2godGVtcGxhdGUsIC9cXCpcXCpDb21wbGV4aXR5OlxcKlxcKi8pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBQcm9qZWN0IHNoYXBlIHZlcmRpY3QgXHUyMDE0IGVuZC10by1lbmQgcHJvcGFnYXRpb24gY29udHJhY3QgKEY3IC8gIzUyNjcpIFx1MjUwMFx1MjUwMFxuLy8gVGhlIHZlcmRpY3QgaXMgcHJvcGFnYXRlZCBmcm9tIGRpc2N1c3MtcHJvamVjdCB0byBkb3duc3RyZWFtIHN0YWdlcyB2aWFcbi8vIFBST0pFQ1QubWQgdGV4dCBvbmx5LCB3aXRoIG5vIHBhcnNlci4gVGhlc2UgdGVzdHMgcGluIHRoZSByb3VuZC10cmlwOlxuLy8gdGhlIGZvcm1hdCB0aGUgdXBzdHJlYW0gc3RhZ2UgaXMgdG9sZCB0byB3cml0ZSBtdXN0IGJlIGRpc2NvdmVyYWJsZSBieVxuLy8gdGhlIHJlZ2V4IHBhdHRlcm4gdGhlIGRvd25zdHJlYW0gc3RhZ2UgaXMgdG9sZCB0byBsb29rIGZvci5cblxuLyoqXG4gKiBSZW5kZXIgdGhlIHByb2plY3QubWQgdGVtcGxhdGUgd2l0aCBhIGNvbmNyZXRlIGNvbXBsZXhpdHkgdmVyZGljdCBzbyB3ZVxuICogY2FuIGFzc2VydCBvbiBhIHJlYWxpc3RpYyBQUk9KRUNULm1kICh0aGUgcGxhY2Vob2xkZXIgaXMgZmlsbGVkIHRoZSB3YXlcbiAqIGFuIExMTSBmb2xsb3dpbmcgdGhlIHByb21wdCB3b3VsZCBmaWxsIGl0KS5cbiAqL1xuZnVuY3Rpb24gcmVuZGVyUHJvamVjdE1kKHZlcmRpY3Q6IFwic2ltcGxlXCIgfCBcImNvbXBsZXhcIik6IHN0cmluZyB7XG4gIHJldHVybiByZWFkVGVtcGxhdGUoXCJwcm9qZWN0XCIpXG4gICAgLnJlcGxhY2UoXCJ7e3NpbXBsZSB8IGNvbXBsZXh9fVwiLCB2ZXJkaWN0KVxuICAgIC5yZXBsYWNlKFwie3tvbmUtbGluZSByYXRpb25hbGUgY2l0aW5nIHRoZSBzaWduYWxzIHRoYXQgZGVjaWRlZCBpdH19XCIsIFwiVGVzdCBmaXh0dXJlIHJhdGlvbmFsZS5cIik7XG59XG5cbnRlc3QoXCJwcm9qZWN0IHNoYXBlIHZlcmRpY3Qgc3Vydml2ZXMgdGhlIGRpc2N1c3MtcHJvamVjdCBcdTIxOTIgZGlzY3Vzcy1taWxlc3RvbmUgcm91bmQgdHJpcFwiLCAoKSA9PiB7XG4gIGZvciAoY29uc3QgdmVyZGljdCBvZiBbXCJzaW1wbGVcIiwgXCJjb21wbGV4XCJdIGFzIGNvbnN0KSB7XG4gICAgY29uc3QgcHJvamVjdE1kID0gcmVuZGVyUHJvamVjdE1kKHZlcmRpY3QpO1xuXG4gICAgLy8gVXBzdHJlYW0gY29udHJhY3Q6IHRoZSBQUk9KRUNULm1kIHRoZSBkaXNjdXNzLXByb2plY3QgcHJvbXB0IHdyaXRlc1xuICAgIC8vIG11c3QgY29udGFpbiB0aGUgc2VjdGlvbiBoZWFkZXIgYW5kIHRoZSBib2xkZWQgYCoqQ29tcGxleGl0eToqKiA8dmVyZGljdD5gXG4gICAgLy8gbWFya2VyIHRoYXQgZG93bnN0cmVhbSBzdGFnZXMgYXJlIHRvbGQgdG8gZ3JlcCBmb3IuXG4gICAgYXNzZXJ0Lm1hdGNoKHByb2plY3RNZCwgLyMjIFByb2plY3QgU2hhcGUvLCBgcmVuZGVyZWQgJHt2ZXJkaWN0fSBQUk9KRUNULm1kIG11c3Qga2VlcCB0aGUgc2VjdGlvbiBoZWFkZXJgKTtcbiAgICBjb25zdCBjb21wbGV4aXR5TWFya2VyID0gbmV3IFJlZ0V4cChgXFxcXCpcXFxcKkNvbXBsZXhpdHk6XFxcXCpcXFxcKlxcXFxzKiR7dmVyZGljdH1cXFxcYmApO1xuICAgIGFzc2VydC5tYXRjaChcbiAgICAgIHByb2plY3RNZCxcbiAgICAgIGNvbXBsZXhpdHlNYXJrZXIsXG4gICAgICBgcmVuZGVyZWQgJHt2ZXJkaWN0fSBQUk9KRUNULm1kIG11c3QgZXhwb3NlIHRoZSBib2xkZWQgQ29tcGxleGl0eSBtYXJrZXIgdGhlIGRvd25zdHJlYW0gcmVnZXggbG9va3MgZm9yYCxcbiAgICApO1xuXG4gICAgLy8gRG93bnN0cmVhbSBjb250cmFjdDogZGlzY3Vzcy1taWxlc3RvbmUsIGRpc2N1c3MtcmVxdWlyZW1lbnRzLCBhbmRcbiAgICAvLyBkaXNjdXNzLXNsaWNlIG11c3QgZWFjaCBpbnN0cnVjdCB0aGUgTExNIHRvIGxvb2sgYXQgdGhlIHNhbWUgc2VjdGlvblxuICAgIC8vIGhlYWRlciBBTkQgdGhlIHNhbWUgYCoqQ29tcGxleGl0eToqKmAgbWFya2VyIHRoZSB0ZW1wbGF0ZSB3cml0ZXMuXG4gICAgLy8gV2l0aG91dCB0aGlzLCB0aGUgdXBzdHJlYW0gdmVyZGljdCBpcyBzaWxlbnRseSBkcm9wcGVkLlxuICAgIGZvciAoY29uc3QgZG93bnN0cmVhbSBvZiBbXCJndWlkZWQtZGlzY3Vzcy1taWxlc3RvbmVcIiwgXCJndWlkZWQtZGlzY3Vzcy1yZXF1aXJlbWVudHNcIiwgXCJndWlkZWQtZGlzY3Vzcy1zbGljZVwiXSkge1xuICAgICAgY29uc3QgcHJvbXB0ID0gcmVhZFByb21wdChkb3duc3RyZWFtKTtcbiAgICAgIGFzc2VydC5tYXRjaChcbiAgICAgICAgcHJvbXB0LFxuICAgICAgICAvIyMgUHJvamVjdCBTaGFwZS8sXG4gICAgICAgIGAke2Rvd25zdHJlYW19IG11c3QgZGlyZWN0IHRoZSBMTE0gdG8gdGhlIHNhbWUgc2VjdGlvbiBoZWFkZXIgdGhlIHRlbXBsYXRlIHdyaXRlc2AsXG4gICAgICApO1xuICAgICAgYXNzZXJ0Lm1hdGNoKFxuICAgICAgICBwcm9tcHQsXG4gICAgICAgIC9cXCpcXCpDb21wbGV4aXR5OlxcKlxcKi8sXG4gICAgICAgIGAke2Rvd25zdHJlYW19IG11c3QgZGlyZWN0IHRoZSBMTE0gdG8gdGhlIHNhbWUgKipDb21wbGV4aXR5OioqIG1hcmtlciB0aGUgdGVtcGxhdGUgd3JpdGVzYCxcbiAgICAgICk7XG4gICAgfVxuICB9XG59KTtcblxudGVzdChcImRvd25zdHJlYW0gZGlzY3VzcyBwcm9tcHRzIGRlZmF1bHQgdG8gY29tcGxleCB3aGVuIFBST0pFQ1QubWQgbGFja3MgdGhlIHZlcmRpY3RcIiwgKCkgPT4ge1xuICAvLyBTYWZlLWJ5LWRlZmF1bHQ6IGlmIHVwc3RyZWFtIG9taXRzIHRoZSBzZWN0aW9uIChleGlzdGluZyBwcm9qZWN0cywgTExNXG4gIC8vIGRyaWZ0LCBmdXR1cmUgdGVtcGxhdGUgY2hhbmdlKSwgZWFjaCBkb3duc3RyZWFtIHN0YWdlIG11c3QgZXhwbGljaXRseVxuICAvLyBmYWxsIGJhY2sgdG8gY29tcGxleCBzbyBiZWhhdmlvciBpcyBjb25zZXJ2YXRpdmUgcmF0aGVyIHRoYW4gc3R1Y2suXG4gIGZvciAoY29uc3QgZG93bnN0cmVhbSBvZiBbXCJndWlkZWQtZGlzY3Vzcy1taWxlc3RvbmVcIiwgXCJndWlkZWQtZGlzY3Vzcy1yZXF1aXJlbWVudHNcIiwgXCJndWlkZWQtZGlzY3Vzcy1zbGljZVwiXSkge1xuICAgIGNvbnN0IHByb21wdCA9IHJlYWRQcm9tcHQoZG93bnN0cmVhbSk7XG4gICAgYXNzZXJ0Lm1hdGNoKFxuICAgICAgcHJvbXB0LFxuICAgICAgL2RlZmF1bHQgdG8gYGNvbXBsZXhgL2ksXG4gICAgICBgJHtkb3duc3RyZWFtfSBtdXN0IGRlZmF1bHQgdG8gY29tcGxleCB3aGVuIHRoZSB1cHN0cmVhbSB2ZXJkaWN0IGlzIG1pc3NpbmdgLFxuICAgICk7XG4gIH1cbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUNuQixTQUFTLG9CQUFvQjtBQUM3QixTQUFTLFlBQVk7QUFFckIsTUFBTSxhQUFhLEtBQUssUUFBUSxJQUFJLEdBQUcsc0NBQXNDO0FBQzdFLE1BQU0sZUFBZSxLQUFLLFFBQVEsSUFBSSxHQUFHLHdDQUF3QztBQUVqRixTQUFTLFdBQVcsTUFBc0I7QUFDeEMsU0FBTyxhQUFhLEtBQUssWUFBWSxHQUFHLElBQUksS0FBSyxHQUFHLE9BQU87QUFDN0Q7QUFFQSxTQUFTLGFBQWEsTUFBc0I7QUFDMUMsU0FBTyxhQUFhLEtBQUssY0FBYyxHQUFHLElBQUksS0FBSyxHQUFHLE9BQU87QUFDL0Q7QUFFQSxLQUFLLHdGQUF3RixNQUFNO0FBQ2pHLFFBQU0sU0FBUyxXQUFXLGtCQUFrQjtBQUM1QyxTQUFPLE1BQU0sUUFBUSw0Q0FBNEM7QUFDakUsU0FBTyxNQUFNLFFBQVEsK0JBQStCO0FBQ3BELFNBQU8sYUFBYSxRQUFRLCtCQUErQjtBQUMzRCxTQUFPLGFBQWEsUUFBUSw2QkFBNkI7QUFDM0QsQ0FBQztBQUVELEtBQUssNkVBQTZFLE1BQU07QUFDdEYsUUFBTSxTQUFTLFdBQVcsU0FBUztBQUNuQyxTQUFPLE1BQU0sUUFBUSxnREFBZ0Q7QUFDckUsU0FBTyxNQUFNLFFBQVEsNEJBQTRCO0FBQ2pELFNBQU8sTUFBTSxRQUFRLGNBQWM7QUFDbkMsU0FBTyxNQUFNLFFBQVEsNEJBQTRCO0FBQ2pELFNBQU8sTUFBTSxRQUFRLGFBQWE7QUFDbEMsU0FBTyxhQUFhLFFBQVEsNEJBQTRCO0FBQzFELENBQUM7QUFFRCxLQUFL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
