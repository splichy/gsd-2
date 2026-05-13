import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  openDatabase,
  closeDatabase,
  _getAdapter,
  insertGateRow,
  upsertRequirement,
  getAllMilestones
} from "../gsd-db.js";
import { deriveState, invalidateStateCache } from "../state.js";
import { markApprovalGateVerified, markDepthVerified, clearDiscussionFlowState, loadWriteGateSnapshot, setPendingGate } from "../bootstrap/write-gate.js";
import {
  executeCompleteMilestone,
  executePlanMilestone,
  executePlanSlice,
  executeReplanSlice,
  executeReassessRoadmap,
  executeSaveGateResult,
  executeSummarySave,
  executeTaskComplete,
  executeMilestoneStatus,
  executeSliceComplete,
  executeValidateMilestone
} from "../tools/workflow-tool-executors.js";
function makeTmpBase() {
  const base = join(tmpdir(), `gsd-workflow-executors-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}
function cleanup(base) {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
  }
}
function openTestDb(base) {
  openDatabase(join(base, ".gsd", "gsd.db"));
}
async function inProjectDir(dir, fn) {
  const originalCwd = process.cwd();
  try {
    process.chdir(dir);
    return await fn();
  } finally {
    process.chdir(originalCwd);
  }
}
function seedMilestone(milestoneId, title, status = "active") {
  const db = _getAdapter();
  if (!db) throw new Error("DB not open");
  db.prepare(
    "INSERT OR REPLACE INTO milestones (id, title, status, created_at) VALUES (?, ?, ?, ?)"
  ).run(milestoneId, title, status, (/* @__PURE__ */ new Date()).toISOString());
}
function seedSlice(milestoneId, sliceId, status) {
  const db = _getAdapter();
  if (!db) throw new Error("DB not open");
  db.prepare(
    "INSERT OR REPLACE INTO slices (milestone_id, id, title, status, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(milestoneId, sliceId, `Slice ${sliceId}`, status, (/* @__PURE__ */ new Date()).toISOString());
}
function writeRoadmap(base, milestoneId, sliceIds) {
  const milestoneDir = join(base, ".gsd", "milestones", milestoneId);
  mkdirSync(milestoneDir, { recursive: true });
  const lines = [
    `# ${milestoneId}: Workflow MCP planning`,
    "",
    "## Slices",
    "",
    ...sliceIds.map((sliceId) => `- [ ] **${sliceId}: Slice ${sliceId}** \`risk:medium\` \`depends:[]\`
  - After this: demo`),
    ""
  ];
  writeFileSync(join(milestoneDir, `${milestoneId}-ROADMAP.md`), lines.join("\n"));
}
test("executeSummarySave persists artifact and returns computed path", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    const result = await inProjectDir(base, () => executeSummarySave({
      milestone_id: "M001",
      slice_id: "S01",
      artifact_type: "SUMMARY",
      content: "# Summary\n\ncontent"
    }, base));
    assert.equal(result.details.operation, "save_summary");
    assert.equal(result.details.path, "milestones/M001/slices/S01/S01-SUMMARY.md");
    const filePath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md");
    assert.ok(existsSync(filePath), "summary artifact should be written to disk");
    assert.match(readFileSync(filePath, "utf-8"), /# Summary/);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});
test("executeTaskComplete coerces string verificationEvidence entries", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    const planDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, "S01-PLAN.md"), "# S01\n\n- [ ] **T01: Demo** `est:5m`\n");
    const result = await inProjectDir(base, () => executeTaskComplete({
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      oneLiner: "Completed task",
      narrative: "Did the work",
      verification: "npm test",
      verificationEvidence: ["npm test"]
    }, base));
    assert.equal(result.details.operation, "complete_task");
    assert.equal(result.details.taskId, "T01");
    const db = _getAdapter();
    assert.ok(db, "DB should be open");
    const rows = db.prepare(
      "SELECT command, exit_code, verdict, duration_ms FROM verification_evidence WHERE milestone_id = ? AND slice_id = ? AND task_id = ?"
    ).all("M001", "S01", "T01");
    assert.equal(rows.length, 1, "one coerced verification evidence row should be inserted");
    assert.equal(rows[0]["command"], "npm test");
    assert.equal(rows[0]["exit_code"], -1);
    assert.match(String(rows[0]["verdict"]), /coerced from string/);
    const summaryPath = String(result.details.summaryPath);
    assert.ok(existsSync(summaryPath), "task summary should be written to disk");
  } finally {
    closeDatabase();
    cleanup(base);
  }
});
test("executeMilestoneStatus returns milestone metadata and slice counts", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    seedMilestone("M001", "Milestone One");
    seedSlice("M001", "S01", "active");
    const db = _getAdapter();
    db.prepare(
      "INSERT OR REPLACE INTO tasks (milestone_id, slice_id, id, title, status) VALUES (?, ?, ?, ?, ?)"
    ).run("M001", "S01", "T01", "Task T01", "pending");
    const result = await inProjectDir(base, () => executeMilestoneStatus({ milestoneId: "M001" }, base));
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.milestoneId, "M001");
    assert.equal(parsed.title, "Milestone One");
    assert.equal(parsed.sliceCount, 1);
    assert.equal(parsed.slices[0].id, "S01");
    assert.equal(parsed.slices[0].taskCounts.pending, 1);
    assert.equal(result.details.status, "active");
    assert.equal(result.details.title, "Milestone One");
    assert.deepEqual(result.details.slices, parsed.slices);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});
test("executePlanMilestone writes roadmap state and rendered roadmap path", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    const result = await inProjectDir(base, () => executePlanMilestone({
      milestoneId: "M001",
      title: "Workflow MCP planning",
      vision: "Plan milestone over shared executors.",
      slices: [
        {
          sliceId: "S01",
          title: "Bridge planning",
          risk: "medium",
          depends: [],
          demo: "Milestone plan persists through MCP.",
          goal: "Persist roadmap state.",
          successCriteria: "ROADMAP.md renders from DB.",
          proofLevel: "integration",
          integrationClosure: "Prompts and MCP call the same handler.",
          observabilityImpact: "Executor tests cover output paths."
        }
      ]
    }, base));
    assert.equal(result.details.operation, "plan_milestone");
    assert.equal(result.details.milestoneId, "M001");
    const roadmapPath = String(result.details.roadmapPath);
    assert.ok(existsSync(roadmapPath), "roadmap should be rendered to disk");
    assert.match(readFileSync(roadmapPath, "utf-8"), /Workflow MCP planning/);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});
test("executePlanSlice writes task planning state and rendered plan artifacts", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    await inProjectDir(base, () => executePlanMilestone({
      milestoneId: "M001",
      title: "Workflow MCP planning",
      vision: "Plan milestone over shared executors.",
      slices: [
        {
          sliceId: "S01",
          title: "Bridge planning",
          risk: "medium",
          depends: [],
          demo: "Milestone plan persists through MCP.",
          goal: "Persist roadmap state.",
          successCriteria: "ROADMAP.md renders from DB.",
          proofLevel: "integration",
          integrationClosure: "Prompts and MCP call the same handler.",
          observabilityImpact: "Executor tests cover output paths."
        }
      ]
    }, base));
    const result = await inProjectDir(base, () => executePlanSlice({
      milestoneId: "M001",
      sliceId: "S01",
      goal: "Persist slice plan over MCP.",
      tasks: [
        {
          taskId: "T01",
          title: "Add planning bridge",
          description: "Implement the shared executor path.",
          estimate: "15m",
          files: ["src/resources/extensions/gsd/tools/workflow-tool-executors.ts"],
          verify: "node --test",
          inputs: [".gsd/milestones/M001/M001-ROADMAP.md"],
          expectedOutput: ["S01-PLAN.md", "T01-PLAN.md"]
        }
      ]
    }, base));
    assert.equal(result.details.operation, "plan_slice");
    assert.equal(result.details.sliceId, "S01");
    const planPath = String(result.details.planPath);
    assert.ok(existsSync(planPath), "slice plan should be rendered to disk");
    assert.match(readFileSync(planPath, "utf-8"), /Persist slice plan over MCP/);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});
test("executePlanSlice marks validation failures with isError", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    const result = await inProjectDir(base, () => executePlanSlice({
      milestoneId: "M001",
      sliceId: "S01",
      goal: "Trigger validation failure for empty tasks.",
      tasks: []
    }, base));
    assert.equal(result.isError, true);
    assert.equal(result.details.operation, "plan_slice");
    assert.match(String(result.details.error), /validation failed: tasks must be a non-empty array/);
    assert.match(result.content[0].text, /Error planning slice:/);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});
test("executeSliceComplete coerces string enrichment entries and writes summary/UAT artifacts", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    seedMilestone("M001", "Milestone One");
    seedSlice("M001", "S01", "pending");
    writeRoadmap(base, "M001", ["S01"]);
    const db = _getAdapter();
    db.prepare(
      "INSERT OR REPLACE INTO tasks (milestone_id, slice_id, id, title, status) VALUES (?, ?, ?, ?, ?)"
    ).run("M001", "S01", "T01", "Task T01", "complete");
    const rawParams = {
      milestoneId: "M001",
      sliceId: "S01",
      sliceTitle: "Slice S01",
      oneLiner: "Completed slice",
      narrative: "Implemented the slice",
      verification: "node --test",
      uatContent: "## UAT\n\nPASS",
      provides: "shared executor path",
      requirementsAdvanced: ["R001 - added slice completion support"],
      filesModified: ["src/file.ts - updated logic"],
      requires: ["S00 - upstream context"]
    };
    const result = await inProjectDir(base, () => executeSliceComplete(rawParams, base));
    assert.equal(result.details.operation, "complete_slice");
    const summaryPath = String(result.details.summaryPath);
    const uatPath = String(result.details.uatPath);
    assert.ok(existsSync(summaryPath), "slice summary should be written to disk");
    assert.ok(existsSync(uatPath), "slice UAT should be written to disk");
    assert.match(readFileSync(summaryPath, "utf-8"), /shared executor path/);
    assert.match(readFileSync(summaryPath, "utf-8"), /R001/);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});
test("executeValidateMilestone persists validation artifact and gate records", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    seedMilestone("M002", "Milestone Two");
    seedSlice("M002", "S02", "complete");
    const result = await inProjectDir(base, () => executeValidateMilestone({
      milestoneId: "M002",
      verdict: "pass",
      remediationRound: 0,
      successCriteriaChecklist: "- [x] Works",
      sliceDeliveryAudit: "| Slice | Result |\n| --- | --- |\n| S02 | pass |",
      crossSliceIntegration: "No cross-slice issues.",
      requirementCoverage: "All requirements covered.",
      verdictRationale: "Everything passed."
    }, base));
    assert.equal(result.details.operation, "validate_milestone");
    const validationPath = String(result.details.validationPath);
    assert.ok(existsSync(validationPath), "validation file should be written to disk");
    const db = _getAdapter();
    const gates = db.prepare(
      "SELECT gate_id, verdict FROM quality_gates WHERE milestone_id = ? ORDER BY gate_id"
    ).all("M002");
    assert.ok(gates.length > 0, "validation should seed milestone quality gates");
    assert.equal(gates[0]["verdict"], "pass");
  } finally {
    closeDatabase();
    cleanup(base);
  }
});
test("executeCompleteMilestone sanitizes raw params and writes milestone summary", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    seedMilestone("M003", "Milestone Three");
    seedSlice("M003", "S03", "complete");
    writeRoadmap(base, "M003", ["S03"]);
    const db = _getAdapter();
    db.prepare(
      "INSERT OR REPLACE INTO tasks (milestone_id, slice_id, id, title, status) VALUES (?, ?, ?, ?, ?)"
    ).run("M003", "S03", "T03", "Task T03", "complete");
    const rawParams = {
      milestoneId: "M003",
      title: "Milestone Three",
      oneLiner: "Completed milestone",
      narrative: "Everything shipped.",
      verificationPassed: "true",
      keyDecisions: ["shared executor path"],
      lessonsLearned: ["MCP transport stays generic"]
    };
    const result = await inProjectDir(base, () => executeCompleteMilestone(rawParams, base));
    assert.equal(result.details.operation, "complete_milestone");
    const summaryPath = String(result.details.summaryPath);
    assert.ok(existsSync(summaryPath), "milestone summary should be written to disk");
    assert.match(readFileSync(summaryPath, "utf-8"), /shared executor path/);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});
test("executeCompleteMilestone returns success for already-complete milestones without overwriting the existing summary", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    seedMilestone("M003", "Milestone Three", "complete");
    seedSlice("M003", "S03", "complete");
    writeRoadmap(base, "M003", ["S03"]);
    const milestoneDir = join(base, ".gsd", "milestones", "M003");
    mkdirSync(milestoneDir, { recursive: true });
    const summaryPath = join(milestoneDir, "M003-SUMMARY.md");
    writeFileSync(summaryPath, "# Existing Summary\n");
    const result = await inProjectDir(base, () => executeCompleteMilestone({
      milestoneId: "M003",
      title: "Milestone Three",
      oneLiner: "Completed milestone",
      narrative: "Everything shipped.",
      verificationPassed: true
    }, base));
    assert.equal(result.isError, void 0);
    assert.equal(result.details.operation, "complete_milestone");
    assert.equal(result.details.alreadyComplete, true);
    assert.match(result.content[0].text, /already complete/);
    assert.doesNotMatch(result.content[0].text, /Summary written to/);
    assert.equal(readFileSync(summaryPath, "utf-8"), "# Existing Summary\n");
  } finally {
    closeDatabase();
    cleanup(base);
  }
});
test("executeReassessRoadmap writes assessment and updates roadmap projection", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    await inProjectDir(base, () => executePlanMilestone({
      milestoneId: "M004",
      title: "Milestone Four",
      vision: "Exercise roadmap reassessment.",
      slices: [
        {
          sliceId: "S04",
          title: "Completed slice",
          risk: "medium",
          depends: [],
          demo: "Completed slice works",
          goal: "Complete the first slice.",
          successCriteria: "S04 is complete.",
          proofLevel: "integration",
          integrationClosure: "Baseline flow is wired.",
          observabilityImpact: "Executor test covers reassessment."
        },
        {
          sliceId: "S05",
          title: "Follow-up slice",
          risk: "medium",
          depends: ["S04"],
          demo: "Follow-up slice is adjusted",
          goal: "Handle the follow-up work.",
          successCriteria: "Roadmap gets updated.",
          proofLevel: "integration",
          integrationClosure: "Downstream work stays aligned.",
          observabilityImpact: "Assessment artifact is rendered."
        }
      ]
    }, base));
    await inProjectDir(base, () => executePlanSlice({
      milestoneId: "M004",
      sliceId: "S04",
      goal: "Complete the first slice.",
      tasks: [
        {
          taskId: "T04",
          title: "Finish slice",
          description: "Close the completed slice.",
          estimate: "5m",
          files: ["src/file.ts"],
          verify: "node --test",
          inputs: ["M004-ROADMAP.md"],
          expectedOutput: ["S04-SUMMARY.md", "S04-UAT.md"]
        }
      ]
    }, base));
    await inProjectDir(base, () => executeTaskComplete({
      milestoneId: "M004",
      sliceId: "S04",
      taskId: "T04",
      oneLiner: "Completed task",
      narrative: "Task finished.",
      verification: "node --test"
    }, base));
    await inProjectDir(base, () => executeSliceComplete({
      milestoneId: "M004",
      sliceId: "S04",
      sliceTitle: "Completed slice",
      oneLiner: "Completed slice",
      narrative: "Slice finished.",
      verification: "node --test",
      uatContent: "## UAT\n\nPASS"
    }, base));
    const result = await inProjectDir(base, () => executeReassessRoadmap({
      milestoneId: "M004",
      completedSliceId: "S04",
      verdict: "roadmap-adjusted",
      assessment: "Added a remediation slice.",
      sliceChanges: {
        modified: [
          {
            sliceId: "S05",
            title: "Adjusted follow-up slice",
            risk: "high",
            depends: ["S04"],
            demo: "Adjusted follow-up demo"
          }
        ],
        added: [
          {
            sliceId: "S06",
            title: "Remediation slice",
            risk: "medium",
            depends: ["S05"],
            demo: "Remediation slice demo"
          }
        ],
        removed: []
      }
    }, base));
    assert.equal(result.details.operation, "reassess_roadmap");
    const assessmentPath = String(result.details.assessmentPath);
    const roadmapPath = String(result.details.roadmapPath);
    assert.ok(existsSync(assessmentPath), "assessment file should be written");
    assert.ok(existsSync(roadmapPath), "roadmap should be re-rendered");
    assert.match(readFileSync(roadmapPath, "utf-8"), /S06/);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});
test("executeSaveGateResult validates inputs and persists verdicts", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    seedMilestone("M005", "Milestone Five");
    seedSlice("M005", "S05", "pending");
    insertGateRow({
      milestoneId: "M005",
      sliceId: "S05",
      gateId: "Q3",
      scope: "slice"
    });
    const result = await inProjectDir(base, () => executeSaveGateResult({
      milestoneId: "M005",
      sliceId: "S05",
      gateId: "Q3",
      verdict: "pass",
      rationale: "Looks good.",
      findings: "No issues found."
    }, base));
    assert.equal(result.details.operation, "save_gate_result");
    const db = _getAdapter();
    const row = db.prepare(
      "SELECT status, verdict, rationale FROM quality_gates WHERE milestone_id = ? AND slice_id = ? AND gate_id = ? AND task_id = ''"
    ).get("M005", "S05", "Q3");
    assert.equal(row?.status, "complete");
    assert.equal(row?.verdict, "pass");
    assert.equal(row?.rationale, "Looks good.");
  } finally {
    closeDatabase();
    cleanup(base);
  }
});
test("executeReplanSlice rewrites pending tasks and renders replan artifacts", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    await inProjectDir(base, () => executePlanMilestone({
      milestoneId: "M006",
      title: "Milestone Six",
      vision: "Exercise slice replanning.",
      slices: [
        {
          sliceId: "S06",
          title: "Replan slice",
          risk: "medium",
          depends: [],
          demo: "Slice can be replanned after a blocker task completes.",
          goal: "Prepare replan state.",
          successCriteria: "PLAN and REPLAN artifacts update.",
          proofLevel: "integration",
          integrationClosure: "Replan shares the workflow executor path.",
          observabilityImpact: "Executor test covers replan output files."
        }
      ]
    }, base));
    await inProjectDir(base, () => executePlanSlice({
      milestoneId: "M006",
      sliceId: "S06",
      goal: "Plan a slice that will be replanned.",
      tasks: [
        {
          taskId: "T06",
          title: "Blocker task",
          description: "Finish the blocker-discovery task.",
          estimate: "5m",
          files: ["src/blocker.ts"],
          verify: "node --test",
          inputs: ["M006-ROADMAP.md"],
          expectedOutput: ["T06-SUMMARY.md"]
        },
        {
          taskId: "T07",
          title: "Pending task",
          description: "Original follow-up task.",
          estimate: "10m",
          files: ["src/pending.ts"],
          verify: "node --test",
          inputs: ["S06-PLAN.md"],
          expectedOutput: ["Updated plan"]
        }
      ]
    }, base));
    await inProjectDir(base, () => executeTaskComplete({
      milestoneId: "M006",
      sliceId: "S06",
      taskId: "T06",
      oneLiner: "Completed blocker task",
      narrative: "The blocker was identified and documented.",
      verification: "node --test"
    }, base));
    const result = await inProjectDir(base, () => executeReplanSlice({
      milestoneId: "M006",
      sliceId: "S06",
      blockerTaskId: "T06",
      blockerDescription: "Original approach no longer works.",
      whatChanged: "Adjusted the remaining tasks and added a remediation task.",
      updatedTasks: [
        {
          taskId: "T07",
          title: "Pending task (updated)",
          description: "Updated follow-up task after replanning.",
          estimate: "15m",
          files: ["src/pending.ts", "src/replanned.ts"],
          verify: "node --test",
          inputs: ["S06-PLAN.md"],
          expectedOutput: ["Updated plan"]
        },
        {
          taskId: "T08",
          title: "Remediation task",
          description: "New task introduced by the replan.",
          estimate: "20m",
          files: ["src/remediation.ts"],
          verify: "node --test",
          inputs: ["S06-REPLAN.md"],
          expectedOutput: ["Remediation patch"]
        }
      ],
      removedTaskIds: []
    }, base));
    assert.equal(result.details.operation, "replan_slice");
    const planPath = String(result.details.planPath);
    const replanPath = String(result.details.replanPath);
    assert.ok(existsSync(planPath), "replanned plan should exist on disk");
    assert.ok(existsSync(replanPath), "replan artifact should exist on disk");
    assert.match(readFileSync(planPath, "utf-8"), /T08/);
    assert.match(readFileSync(replanPath, "utf-8"), /Adjusted the remaining tasks/);
    const db = _getAdapter();
    const updatedTask = db.prepare(
      "SELECT title FROM tasks WHERE milestone_id = ? AND slice_id = ? AND id = ?"
    ).get("M006", "S06", "T07");
    const insertedTask = db.prepare(
      "SELECT title FROM tasks WHERE milestone_id = ? AND slice_id = ? AND id = ?"
    ).get("M006", "S06", "T08");
    assert.equal(updatedTask?.title, "Pending task (updated)");
    assert.equal(insertedTask?.title, "Remediation task");
  } finally {
    closeDatabase();
    cleanup(base);
  }
});
test("executeSummarySave removes sibling CONTEXT-DRAFT when writing milestone CONTEXT (#4442)", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    markDepthVerified("M001", base);
    const milestoneDir = join(base, ".gsd", "milestones", "M001");
    mkdirSync(milestoneDir, { recursive: true });
    const draftPath = join(milestoneDir, "M001-CONTEXT-DRAFT.md");
    writeFileSync(draftPath, "# Draft\n\nincremental notes");
    assert.ok(existsSync(draftPath), "precondition: draft exists");
    const result = await inProjectDir(base, () => executeSummarySave({
      milestone_id: "M001",
      artifact_type: "CONTEXT",
      content: "# Context\n\nfinal discussion output"
    }, base));
    assert.equal(result.details.operation, "save_summary");
    assert.equal(result.details.artifact_type, "CONTEXT");
    const contextPath = join(milestoneDir, "M001-CONTEXT.md");
    assert.ok(existsSync(contextPath), "CONTEXT.md should be written");
    assert.equal(
      existsSync(draftPath),
      false,
      "CONTEXT-DRAFT.md should be removed after final CONTEXT.md is written"
    );
  } finally {
    clearDiscussionFlowState(base);
    closeDatabase();
    cleanup(base);
  }
});
test("executeSummarySave supports root-level deep planning artifacts", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    const project = await inProjectDir(base, () => executeSummarySave({
      artifact_type: "PROJECT",
      content: [
        "# Project",
        "",
        "## What This Is",
        "",
        "A root project artifact.",
        "",
        "## Milestone Sequence",
        "",
        "- [ ] M001: Foundation - Establish the first runnable slice.",
        ""
      ].join("\n")
    }, base));
    assert.equal(project.isError, void 0);
    assert.equal(project.details.path, "PROJECT.md");
    assert.ok(existsSync(join(base, ".gsd", "PROJECT.md")));
    upsertRequirement({
      id: "R001",
      class: "primary-user-loop",
      status: "active",
      description: "User can add a task",
      why: "Core loop",
      source: "user",
      primary_owner: "M001/none yet",
      supporting_slices: "none",
      validation: "unmapped",
      notes: "",
      full_content: "",
      superseded_by: null
    });
    const requirements = await inProjectDir(base, () => executeSummarySave({
      artifact_type: "REQUIREMENTS",
      content: "# Requirements\n\n## Active\n\n## Validated\n\n## Deferred\n\n## Out of Scope\n\n## Traceability\n\n## Coverage Summary\n"
    }, base));
    assert.equal(requirements.isError, void 0);
    assert.equal(requirements.details.path, "REQUIREMENTS.md");
    assert.equal(requirements.details.content_source, "requirements_table");
    assert.ok(existsSync(join(base, ".gsd", "REQUIREMENTS.md")));
    const db = _getAdapter();
    const rows = db.prepare(
      "SELECT path, artifact_type, milestone_id FROM artifacts WHERE path IN ('PROJECT.md', 'REQUIREMENTS.md') ORDER BY path"
    ).all();
    assert.deepEqual(
      rows.map((row) => [row.path, row.artifact_type, row.milestone_id]),
      [
        ["PROJECT.md", "PROJECT", null],
        ["REQUIREMENTS.md", "REQUIREMENTS", null]
      ]
    );
  } finally {
    closeDatabase();
    cleanup(base);
  }
});
test("executeSummarySave registers PROJECT milestone sequence for the next run", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    const result = await inProjectDir(base, () => executeSummarySave({
      artifact_type: "PROJECT",
      content: [
        "# Project",
        "",
        "## What This Is",
        "",
        "Deep project setup output.",
        "",
        "## Project Shape",
        "",
        "**Complexity:** complex",
        "**Why:** It spans multiple delivery steps.",
        "",
        "## Capability Contract",
        "",
        "See .gsd/REQUIREMENTS.md.",
        "",
        "## Milestone Sequence",
        "",
        "- [ ] M001: Foundation - Establish the first runnable slice.",
        "- [ ] M002: Polish - Follow-up experience work.",
        ""
      ].join("\n")
    }, base));
    assert.equal(result.isError, void 0);
    assert.deepEqual(result.details.registeredMilestones, ["M001", "M002"]);
    const milestones = getAllMilestones();
    assert.deepEqual(
      milestones.map((m) => [m.id, m.title, m.status]),
      [
        ["M001", "Foundation", "queued"],
        ["M002", "Polish", "queued"]
      ]
    );
    invalidateStateCache();
    const state = await deriveState(base);
    assert.equal(state.activeMilestone?.id, "M001");
    assert.equal(state.phase, "pre-planning");
    assert.equal(state.registry[0]?.status, "active");
    assert.equal(state.registry[1]?.status, "pending");
  } finally {
    closeDatabase();
    cleanup(base);
  }
});
test("executeSummarySave hard-fails when milestone registration throws so silent No-Active-Milestone is impossible", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    const db = _getAdapter();
    assert.ok(db, "DB should be open");
    const originalPrepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      if (sql.includes("INSERT OR IGNORE INTO milestones")) {
        throw new Error("simulated milestone registration failure");
      }
      return originalPrepare(sql);
    };
    const result = await inProjectDir(base, () => executeSummarySave({
      artifact_type: "PROJECT",
      content: [
        "# Project",
        "",
        "## What This Is",
        "",
        "Deep project setup output.",
        "",
        "## Milestone Sequence",
        "",
        "- [ ] M001: Foundation - Establish the first runnable slice.",
        ""
      ].join("\n")
    }, base));
    assert.equal(result.isError, true);
    assert.equal(result.details.path, "PROJECT.md");
    assert.equal(result.details.error, "milestone_registration_threw");
    assert.match(String(result.details.registration_error), /simulated milestone registration failure/);
    assert.match(result.content[0].text, /milestone registration failed/);
    assert.match(result.content[0].text, /idempotent/);
    assert.ok(existsSync(join(base, ".gsd", "PROJECT.md")));
    const artifact = originalPrepare("SELECT path FROM artifacts WHERE path = ?").get("PROJECT.md");
    assert.equal(artifact?.path, "PROJECT.md");
  } finally {
    closeDatabase();
    cleanup(base);
  }
});
test("executeSummarySave blocks final root artifacts while approval gate is pending", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    setPendingGate("depth_verification_requirements_confirm", base);
    const result = await inProjectDir(base, () => executeSummarySave({
      artifact_type: "REQUIREMENTS",
      content: "# Requirements\n\n## Active\n"
    }, base));
    assert.equal(result.isError, true);
    assert.equal(result.details.error, "root_artifact_write_blocked");
    assert.match(result.content[0].text, /has not been confirmed/);
    assert.equal(existsSync(join(base, ".gsd", "REQUIREMENTS.md")), false);
    const draft = await inProjectDir(base, () => executeSummarySave({
      artifact_type: "REQUIREMENTS-DRAFT",
      content: "# Draft Requirements\n"
    }, base));
    assert.equal(draft.isError, void 0);
    assert.ok(existsSync(join(base, ".gsd", "REQUIREMENTS-DRAFT.md")));
  } finally {
    clearDiscussionFlowState(base);
    closeDatabase();
    cleanup(base);
  }
});
test("executeSummarySave requires verified root approval in deep mode", async () => {
  const base = makeTmpBase();
  try {
    writeFileSync(join(base, ".gsd", "PREFERENCES.md"), "---\nplanning_depth: deep\n---\n");
    openTestDb(base);
    const projectFixture = [
      "# Project",
      "",
      "## What This Is",
      "",
      "A root project artifact.",
      "",
      "## Milestone Sequence",
      "",
      "- [ ] M001: Foundation - Establish the first runnable slice.",
      ""
    ].join("\n");
    const blocked = await inProjectDir(base, () => executeSummarySave({
      artifact_type: "PROJECT",
      content: projectFixture
    }, base));
    assert.equal(blocked.isError, true);
    assert.equal(blocked.details.error, "root_artifact_write_blocked");
    assert.match(blocked.content[0].text, /fail-closed/);
    assert.equal(existsSync(join(base, ".gsd", "PROJECT.md")), false);
    markApprovalGateVerified("depth_verification_project_confirm", base);
    const unblocked = await inProjectDir(base, () => executeSummarySave({
      artifact_type: "PROJECT",
      content: projectFixture
    }, base));
    assert.equal(unblocked.isError, void 0);
    assert.equal(unblocked.details.path, "PROJECT.md");
    assert.ok(existsSync(join(base, ".gsd", "PROJECT.md")));
  } finally {
    clearDiscussionFlowState(base);
    closeDatabase();
    cleanup(base);
  }
});
test("executeSummarySave renders final REQUIREMENTS from the DB source of truth", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    markApprovalGateVerified("depth_verification_requirements_confirm", base);
    upsertRequirement({
      id: "R001",
      class: "primary-user-loop",
      status: "active",
      description: "User can add a task",
      why: "Core loop",
      source: "user",
      primary_owner: "M001/none yet",
      supporting_slices: "none",
      validation: "unmapped",
      notes: "saved through requirement tool",
      full_content: "",
      superseded_by: null
    });
    const requirementsPath = join(base, ".gsd", "REQUIREMENTS.md");
    const bloatedMarkdown = [
      "# Requirements",
      "",
      "## Active",
      "",
      ...Array.from({ length: 30 }, (_, i) => [
        `### R${String(i + 100).padStart(3, "0")} \u2014 Duplicate`,
        "- Class: primary-user-loop",
        "- Status: active",
        "- Description: Duplicate retry row",
        "- Why it matters: Retry drift",
        "- Source: test",
        "- Primary owning slice: M001/none yet",
        "- Supporting slices: none",
        "- Validation: unmapped",
        ""
      ].join("\n"))
    ].join("\n");
    writeFileSync(requirementsPath, bloatedMarkdown);
    const result = await inProjectDir(base, () => executeSummarySave({
      artifact_type: "REQUIREMENTS",
      content: "# Requirements\n\n## Active\n\n### R999 \u2014 Wrong markdown source\n\n- Description: This content must not become canonical.\n"
    }, base));
    assert.equal(result.isError, void 0);
    assert.equal(result.details.path, "REQUIREMENTS.md");
    assert.equal(result.details.content_source, "requirements_table");
    const content = readFileSync(requirementsPath, "utf-8");
    assert.match(content, /### R001 — User can add a task/);
    assert.match(content, /## Validated/);
    assert.match(content, /## Deferred/);
    assert.match(content, /## Out of Scope/);
    assert.doesNotMatch(content, /R999|Wrong markdown source|This content must not become canonical/);
    assert.ok(
      Buffer.byteLength(content, "utf-8") < Buffer.byteLength(bloatedMarkdown, "utf-8") * 0.5,
      "test setup proves final DB projection may be much smaller than accumulated retry output"
    );
    const db = _getAdapter();
    const reqRows = db.prepare("SELECT id, description FROM requirements ORDER BY id").all();
    assert.deepEqual(
      reqRows.map((row) => [row.id, row.description]),
      [["R001", "User can add a task"]],
      "summary save must not parse markdown back into requirements rows"
    );
    const artifact = db.prepare("SELECT full_content FROM artifacts WHERE path = ?").get("REQUIREMENTS.md");
    assert.equal(artifact.full_content, content);
  } finally {
    clearDiscussionFlowState(base);
    closeDatabase();
    cleanup(base);
  }
});
test("executeSummarySave rejects final REQUIREMENTS when the DB source is empty", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    const result = await inProjectDir(base, () => executeSummarySave({
      artifact_type: "REQUIREMENTS",
      content: "# Requirements\n\n## Active\n\n"
    }, base));
    assert.equal(result.isError, true);
    assert.equal(result.details.error, "no_active_requirements");
    assert.match(result.content[0].text, /no active requirements found/);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});
test("executeSummarySave rejects milestone-scoped artifacts without milestone_id", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    const result = await inProjectDir(base, () => executeSummarySave({
      artifact_type: "CONTEXT",
      content: "# Context\n"
    }, base));
    assert.equal(result.isError, true);
    assert.equal(result.details.error, "missing_milestone_id");
    assert.match(result.content[0].text, /milestone_id is required/);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});
test("executeSummarySave removes sibling CONTEXT-DRAFT when writing slice CONTEXT (#4442)", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    mkdirSync(sliceDir, { recursive: true });
    const draftPath = join(sliceDir, "S01-CONTEXT-DRAFT.md");
    writeFileSync(draftPath, "# Slice Draft\n\nincremental slice notes");
    assert.ok(existsSync(draftPath), "precondition: slice draft exists");
    const result = await inProjectDir(base, () => executeSummarySave({
      milestone_id: "M001",
      slice_id: "S01",
      artifact_type: "CONTEXT",
      content: "# Slice Context\n\nfinal slice output"
    }, base));
    assert.equal(result.details.operation, "save_summary");
    assert.equal(result.details.artifact_type, "CONTEXT");
    const contextPath = join(sliceDir, "S01-CONTEXT.md");
    assert.ok(existsSync(contextPath), "slice CONTEXT.md should be written");
    assert.equal(
      existsSync(draftPath),
      false,
      "slice CONTEXT-DRAFT.md should be removed after final CONTEXT.md is written"
    );
  } finally {
    closeDatabase();
    cleanup(base);
  }
});
test("executeSummarySave leaves sibling CONTEXT-DRAFT intact for non-CONTEXT artifacts (#4442)", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    const milestoneDir = join(base, ".gsd", "milestones", "M001");
    mkdirSync(milestoneDir, { recursive: true });
    const draftPath = join(milestoneDir, "M001-CONTEXT-DRAFT.md");
    writeFileSync(draftPath, "# Draft\n\nstill in progress");
    const result = await inProjectDir(base, () => executeSummarySave({
      milestone_id: "M001",
      artifact_type: "RESEARCH",
      content: "# Research\n\nresearch notes"
    }, base));
    assert.equal(result.details.artifact_type, "RESEARCH");
    assert.ok(
      existsSync(draftPath),
      "CONTEXT-DRAFT.md must survive RESEARCH/SUMMARY/ASSESSMENT writes"
    );
  } finally {
    closeDatabase();
    cleanup(base);
  }
});
test("executeSummarySave CONTEXT HARD BLOCK clears after write-gate state file is deleted (#4343)", async () => {
  const base = makeTmpBase();
  const originalEnv = process.env.GSD_PERSIST_WRITE_GATE_STATE;
  process.env.GSD_PERSIST_WRITE_GATE_STATE = "1";
  try {
    openTestDb(base);
    clearDiscussionFlowState(base);
    const blocked = await inProjectDir(base, () => executeSummarySave({
      milestone_id: "M001",
      artifact_type: "CONTEXT",
      content: "# Context\n\ncontent"
    }, base));
    assert.equal(blocked.isError, true, "should be blocked without depth verification");
    assert.match(
      blocked.content[0].text,
      /HARD BLOCK/,
      "blocked result should mention HARD BLOCK"
    );
    const stateFilePath = join(base, ".gsd", "runtime", "write-gate-state.json");
    mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
    writeFileSync(stateFilePath, JSON.stringify({
      verifiedDepthMilestones: [],
      activeQueuePhase: false,
      pendingGateId: "depth_verification_M001"
    }));
    unlinkSync(stateFilePath);
    assert.ok(!existsSync(stateFilePath), "state file deleted");
    const snapshot = loadWriteGateSnapshot(base);
    assert.equal(snapshot.pendingGateId, null, "pendingGateId should be null after file deletion");
    assert.deepEqual(snapshot.verifiedDepthMilestones, [], "verifiedDepthMilestones should be empty after file deletion");
    markDepthVerified("M001", base);
    const unblocked = await inProjectDir(base, () => executeSummarySave({
      milestone_id: "M001",
      artifact_type: "CONTEXT",
      content: "# Context\n\nfinal content"
    }, base));
    assert.equal(unblocked.isError, void 0, "should not be blocked after depth verification");
    assert.equal(unblocked.details.operation, "save_summary");
  } finally {
    if (originalEnv === void 0) {
      delete process.env.GSD_PERSIST_WRITE_GATE_STATE;
    } else {
      process.env.GSD_PERSIST_WRITE_GATE_STATE = originalEnv;
    }
    clearDiscussionFlowState(base);
    closeDatabase();
    cleanup(base);
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy93b3JrZmxvdy10b29sLWV4ZWN1dG9ycy50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZGlyU3luYywgcm1TeW5jLCByZWFkRmlsZVN5bmMsIGV4aXN0c1N5bmMsIHdyaXRlRmlsZVN5bmMsIHVubGlua1N5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSBcIm5vZGU6Y3J5cHRvXCI7XG5cbmltcG9ydCB7XG4gIG9wZW5EYXRhYmFzZSxcbiAgY2xvc2VEYXRhYmFzZSxcbiAgX2dldEFkYXB0ZXIsXG4gIGluc2VydEdhdGVSb3csXG4gIHVwc2VydFJlcXVpcmVtZW50LFxuICBnZXRBbGxNaWxlc3RvbmVzLFxufSBmcm9tIFwiLi4vZ3NkLWRiLnRzXCI7XG5pbXBvcnQgeyBkZXJpdmVTdGF0ZSwgaW52YWxpZGF0ZVN0YXRlQ2FjaGUgfSBmcm9tIFwiLi4vc3RhdGUudHNcIjtcbmltcG9ydCB7IG1hcmtBcHByb3ZhbEdhdGVWZXJpZmllZCwgbWFya0RlcHRoVmVyaWZpZWQsIGNsZWFyRGlzY3Vzc2lvbkZsb3dTdGF0ZSwgbG9hZFdyaXRlR2F0ZVNuYXBzaG90LCBzZXRQZW5kaW5nR2F0ZSB9IGZyb20gXCIuLi9ib290c3RyYXAvd3JpdGUtZ2F0ZS50c1wiO1xuaW1wb3J0IHtcbiAgZXhlY3V0ZUNvbXBsZXRlTWlsZXN0b25lLFxuICBleGVjdXRlUGxhbk1pbGVzdG9uZSxcbiAgZXhlY3V0ZVBsYW5TbGljZSxcbiAgZXhlY3V0ZVJlcGxhblNsaWNlLFxuICBleGVjdXRlUmVhc3Nlc3NSb2FkbWFwLFxuICBleGVjdXRlU2F2ZUdhdGVSZXN1bHQsXG4gIGV4ZWN1dGVTdW1tYXJ5U2F2ZSxcbiAgZXhlY3V0ZVRhc2tDb21wbGV0ZSxcbiAgZXhlY3V0ZU1pbGVzdG9uZVN0YXR1cyxcbiAgZXhlY3V0ZVNsaWNlQ29tcGxldGUsXG4gIGV4ZWN1dGVWYWxpZGF0ZU1pbGVzdG9uZSxcbn0gZnJvbSBcIi4uL3Rvb2xzL3dvcmtmbG93LXRvb2wtZXhlY3V0b3JzLnRzXCI7XG5cbmZ1bmN0aW9uIG1ha2VUbXBCYXNlKCk6IHN0cmluZyB7XG4gIGNvbnN0IGJhc2UgPSBqb2luKHRtcGRpcigpLCBgZ3NkLXdvcmtmbG93LWV4ZWN1dG9ycy0ke3JhbmRvbVVVSUQoKX1gKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgcmV0dXJuIGJhc2U7XG59XG5cbmZ1bmN0aW9uIGNsZWFudXAoYmFzZTogc3RyaW5nKTogdm9pZCB7XG4gIHRyeSB7IHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7IH0gY2F0Y2ggeyAvKiBzd2FsbG93ICovIH1cbn1cblxuZnVuY3Rpb24gb3BlblRlc3REYihiYXNlOiBzdHJpbmcpOiB2b2lkIHtcbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiZ3NkLmRiXCIpKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gaW5Qcm9qZWN0RGlyPFQ+KGRpcjogc3RyaW5nLCBmbjogKCkgPT4gUHJvbWlzZTxUPik6IFByb21pc2U8VD4ge1xuICBjb25zdCBvcmlnaW5hbEN3ZCA9IHByb2Nlc3MuY3dkKCk7XG4gIHRyeSB7XG4gICAgcHJvY2Vzcy5jaGRpcihkaXIpO1xuICAgIHJldHVybiBhd2FpdCBmbigpO1xuICB9IGZpbmFsbHkge1xuICAgIHByb2Nlc3MuY2hkaXIob3JpZ2luYWxDd2QpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHNlZWRNaWxlc3RvbmUobWlsZXN0b25lSWQ6IHN0cmluZywgdGl0bGU6IHN0cmluZywgc3RhdHVzID0gXCJhY3RpdmVcIik6IHZvaWQge1xuICBjb25zdCBkYiA9IF9nZXRBZGFwdGVyKCk7XG4gIGlmICghZGIpIHRocm93IG5ldyBFcnJvcihcIkRCIG5vdCBvcGVuXCIpO1xuICBkYi5wcmVwYXJlKFxuICAgIFwiSU5TRVJUIE9SIFJFUExBQ0UgSU5UTyBtaWxlc3RvbmVzIChpZCwgdGl0bGUsIHN0YXR1cywgY3JlYXRlZF9hdCkgVkFMVUVTICg/LCA/LCA/LCA/KVwiLFxuICApLnJ1bihtaWxlc3RvbmVJZCwgdGl0bGUsIHN0YXR1cywgbmV3IERhdGUoKS50b0lTT1N0cmluZygpKTtcbn1cblxuZnVuY3Rpb24gc2VlZFNsaWNlKG1pbGVzdG9uZUlkOiBzdHJpbmcsIHNsaWNlSWQ6IHN0cmluZywgc3RhdHVzOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgZGIgPSBfZ2V0QWRhcHRlcigpO1xuICBpZiAoIWRiKSB0aHJvdyBuZXcgRXJyb3IoXCJEQiBub3Qgb3BlblwiKTtcbiAgZGIucHJlcGFyZShcbiAgICBcIklOU0VSVCBPUiBSRVBMQUNFIElOVE8gc2xpY2VzIChtaWxlc3RvbmVfaWQsIGlkLCB0aXRsZSwgc3RhdHVzLCBjcmVhdGVkX2F0KSBWQUxVRVMgKD8sID8sID8sID8sID8pXCIsXG4gICkucnVuKG1pbGVzdG9uZUlkLCBzbGljZUlkLCBgU2xpY2UgJHtzbGljZUlkfWAsIHN0YXR1cywgbmV3IERhdGUoKS50b0lTT1N0cmluZygpKTtcbn1cblxuZnVuY3Rpb24gd3JpdGVSb2FkbWFwKGJhc2U6IHN0cmluZywgbWlsZXN0b25lSWQ6IHN0cmluZywgc2xpY2VJZHM6IHN0cmluZ1tdKTogdm9pZCB7XG4gIGNvbnN0IG1pbGVzdG9uZURpciA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBtaWxlc3RvbmVJZCk7XG4gIG1rZGlyU3luYyhtaWxlc3RvbmVEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBjb25zdCBsaW5lcyA9IFtcbiAgICBgIyAke21pbGVzdG9uZUlkfTogV29ya2Zsb3cgTUNQIHBsYW5uaW5nYCxcbiAgICBcIlwiLFxuICAgIFwiIyMgU2xpY2VzXCIsXG4gICAgXCJcIixcbiAgICAuLi5zbGljZUlkcy5tYXAoKHNsaWNlSWQpID0+IGAtIFsgXSAqKiR7c2xpY2VJZH06IFNsaWNlICR7c2xpY2VJZH0qKiBcXGByaXNrOm1lZGl1bVxcYCBcXGBkZXBlbmRzOltdXFxgXFxuICAtIEFmdGVyIHRoaXM6IGRlbW9gKSxcbiAgICBcIlwiLFxuICBdO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4obWlsZXN0b25lRGlyLCBgJHttaWxlc3RvbmVJZH0tUk9BRE1BUC5tZGApLCBsaW5lcy5qb2luKFwiXFxuXCIpKTtcbn1cblxudGVzdChcImV4ZWN1dGVTdW1tYXJ5U2F2ZSBwZXJzaXN0cyBhcnRpZmFjdCBhbmQgcmV0dXJucyBjb21wdXRlZCBwYXRoXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgb3BlblRlc3REYihiYXNlKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBpblByb2plY3REaXIoYmFzZSwgKCkgPT4gZXhlY3V0ZVN1bW1hcnlTYXZlKHtcbiAgICAgIG1pbGVzdG9uZV9pZDogXCJNMDAxXCIsXG4gICAgICBzbGljZV9pZDogXCJTMDFcIixcbiAgICAgIGFydGlmYWN0X3R5cGU6IFwiU1VNTUFSWVwiLFxuICAgICAgY29udGVudDogXCIjIFN1bW1hcnlcXG5cXG5jb250ZW50XCIsXG4gICAgfSwgYmFzZSkpO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5kZXRhaWxzLm9wZXJhdGlvbiwgXCJzYXZlX3N1bW1hcnlcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5kZXRhaWxzLnBhdGgsIFwibWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvUzAxLVNVTU1BUlkubWRcIik7XG5cbiAgICBjb25zdCBmaWxlUGF0aCA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDFcIiwgXCJTMDEtU1VNTUFSWS5tZFwiKTtcbiAgICBhc3NlcnQub2soZXhpc3RzU3luYyhmaWxlUGF0aCksIFwic3VtbWFyeSBhcnRpZmFjdCBzaG91bGQgYmUgd3JpdHRlbiB0byBkaXNrXCIpO1xuICAgIGFzc2VydC5tYXRjaChyZWFkRmlsZVN5bmMoZmlsZVBhdGgsIFwidXRmLThcIiksIC8jIFN1bW1hcnkvKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJleGVjdXRlVGFza0NvbXBsZXRlIGNvZXJjZXMgc3RyaW5nIHZlcmlmaWNhdGlvbkV2aWRlbmNlIGVudHJpZXNcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICBvcGVuVGVzdERiKGJhc2UpO1xuICAgIGNvbnN0IHBsYW5EaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIpO1xuICAgIG1rZGlyU3luYyhwbGFuRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4ocGxhbkRpciwgXCJTMDEtUExBTi5tZFwiKSwgXCIjIFMwMVxcblxcbi0gWyBdICoqVDAxOiBEZW1vKiogYGVzdDo1bWBcXG5cIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBpblByb2plY3REaXIoYmFzZSwgKCkgPT4gZXhlY3V0ZVRhc2tDb21wbGV0ZSh7XG4gICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICBzbGljZUlkOiBcIlMwMVwiLFxuICAgICAgdGFza0lkOiBcIlQwMVwiLFxuICAgICAgb25lTGluZXI6IFwiQ29tcGxldGVkIHRhc2tcIixcbiAgICAgIG5hcnJhdGl2ZTogXCJEaWQgdGhlIHdvcmtcIixcbiAgICAgIHZlcmlmaWNhdGlvbjogXCJucG0gdGVzdFwiLFxuICAgICAgdmVyaWZpY2F0aW9uRXZpZGVuY2U6IFtcIm5wbSB0ZXN0XCJdLFxuICAgIH0sIGJhc2UpKTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuZGV0YWlscy5vcGVyYXRpb24sIFwiY29tcGxldGVfdGFza1wiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmRldGFpbHMudGFza0lkLCBcIlQwMVwiKTtcblxuICAgIGNvbnN0IGRiID0gX2dldEFkYXB0ZXIoKTtcbiAgICBhc3NlcnQub2soZGIsIFwiREIgc2hvdWxkIGJlIG9wZW5cIik7XG4gICAgY29uc3Qgcm93cyA9IGRiIS5wcmVwYXJlKFxuICAgICAgXCJTRUxFQ1QgY29tbWFuZCwgZXhpdF9jb2RlLCB2ZXJkaWN0LCBkdXJhdGlvbl9tcyBGUk9NIHZlcmlmaWNhdGlvbl9ldmlkZW5jZSBXSEVSRSBtaWxlc3RvbmVfaWQgPSA/IEFORCBzbGljZV9pZCA9ID8gQU5EIHRhc2tfaWQgPSA/XCIsXG4gICAgKS5hbGwoXCJNMDAxXCIsIFwiUzAxXCIsIFwiVDAxXCIpIGFzIEFycmF5PFJlY29yZDxzdHJpbmcsIHVua25vd24+PjtcblxuICAgIGFzc2VydC5lcXVhbChyb3dzLmxlbmd0aCwgMSwgXCJvbmUgY29lcmNlZCB2ZXJpZmljYXRpb24gZXZpZGVuY2Ugcm93IHNob3VsZCBiZSBpbnNlcnRlZFwiKTtcbiAgICBhc3NlcnQuZXF1YWwocm93c1swXVtcImNvbW1hbmRcIl0sIFwibnBtIHRlc3RcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJvd3NbMF1bXCJleGl0X2NvZGVcIl0sIC0xKTtcbiAgICBhc3NlcnQubWF0Y2goU3RyaW5nKHJvd3NbMF1bXCJ2ZXJkaWN0XCJdKSwgL2NvZXJjZWQgZnJvbSBzdHJpbmcvKTtcblxuICAgIGNvbnN0IHN1bW1hcnlQYXRoID0gU3RyaW5nKHJlc3VsdC5kZXRhaWxzLnN1bW1hcnlQYXRoKTtcbiAgICBhc3NlcnQub2soZXhpc3RzU3luYyhzdW1tYXJ5UGF0aCksIFwidGFzayBzdW1tYXJ5IHNob3VsZCBiZSB3cml0dGVuIHRvIGRpc2tcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZXhlY3V0ZU1pbGVzdG9uZVN0YXR1cyByZXR1cm5zIG1pbGVzdG9uZSBtZXRhZGF0YSBhbmQgc2xpY2UgY291bnRzXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgb3BlblRlc3REYihiYXNlKTtcbiAgICBzZWVkTWlsZXN0b25lKFwiTTAwMVwiLCBcIk1pbGVzdG9uZSBPbmVcIik7XG4gICAgc2VlZFNsaWNlKFwiTTAwMVwiLCBcIlMwMVwiLCBcImFjdGl2ZVwiKTtcbiAgICBjb25zdCBkYiA9IF9nZXRBZGFwdGVyKCk7XG4gICAgZGIhLnByZXBhcmUoXG4gICAgICBcIklOU0VSVCBPUiBSRVBMQUNFIElOVE8gdGFza3MgKG1pbGVzdG9uZV9pZCwgc2xpY2VfaWQsIGlkLCB0aXRsZSwgc3RhdHVzKSBWQUxVRVMgKD8sID8sID8sID8sID8pXCIsXG4gICAgKS5ydW4oXCJNMDAxXCIsIFwiUzAxXCIsIFwiVDAxXCIsIFwiVGFzayBUMDFcIiwgXCJwZW5kaW5nXCIpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaW5Qcm9qZWN0RGlyKGJhc2UsICgpID0+IGV4ZWN1dGVNaWxlc3RvbmVTdGF0dXMoeyBtaWxlc3RvbmVJZDogXCJNMDAxXCIgfSwgYmFzZSkpO1xuICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocmVzdWx0LmNvbnRlbnRbMF0udGV4dCk7XG5cbiAgICBhc3NlcnQuZXF1YWwocGFyc2VkLm1pbGVzdG9uZUlkLCBcIk0wMDFcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHBhcnNlZC50aXRsZSwgXCJNaWxlc3RvbmUgT25lXCIpO1xuICAgIGFzc2VydC5lcXVhbChwYXJzZWQuc2xpY2VDb3VudCwgMSk7XG4gICAgYXNzZXJ0LmVxdWFsKHBhcnNlZC5zbGljZXNbMF0uaWQsIFwiUzAxXCIpO1xuICAgIGFzc2VydC5lcXVhbChwYXJzZWQuc2xpY2VzWzBdLnRhc2tDb3VudHMucGVuZGluZywgMSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5kZXRhaWxzLnN0YXR1cywgXCJhY3RpdmVcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5kZXRhaWxzLnRpdGxlLCBcIk1pbGVzdG9uZSBPbmVcIik7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQuZGV0YWlscy5zbGljZXMsIHBhcnNlZC5zbGljZXMpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcImV4ZWN1dGVQbGFuTWlsZXN0b25lIHdyaXRlcyByb2FkbWFwIHN0YXRlIGFuZCByZW5kZXJlZCByb2FkbWFwIHBhdGhcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICBvcGVuVGVzdERiKGJhc2UpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaW5Qcm9qZWN0RGlyKGJhc2UsICgpID0+IGV4ZWN1dGVQbGFuTWlsZXN0b25lKHtcbiAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICAgIHRpdGxlOiBcIldvcmtmbG93IE1DUCBwbGFubmluZ1wiLFxuICAgICAgdmlzaW9uOiBcIlBsYW4gbWlsZXN0b25lIG92ZXIgc2hhcmVkIGV4ZWN1dG9ycy5cIixcbiAgICAgIHNsaWNlczogW1xuICAgICAgICB7XG4gICAgICAgICAgc2xpY2VJZDogXCJTMDFcIixcbiAgICAgICAgICB0aXRsZTogXCJCcmlkZ2UgcGxhbm5pbmdcIixcbiAgICAgICAgICByaXNrOiBcIm1lZGl1bVwiLFxuICAgICAgICAgIGRlcGVuZHM6IFtdLFxuICAgICAgICAgIGRlbW86IFwiTWlsZXN0b25lIHBsYW4gcGVyc2lzdHMgdGhyb3VnaCBNQ1AuXCIsXG4gICAgICAgICAgZ29hbDogXCJQZXJzaXN0IHJvYWRtYXAgc3RhdGUuXCIsXG4gICAgICAgICAgc3VjY2Vzc0NyaXRlcmlhOiBcIlJPQURNQVAubWQgcmVuZGVycyBmcm9tIERCLlwiLFxuICAgICAgICAgIHByb29mTGV2ZWw6IFwiaW50ZWdyYXRpb25cIixcbiAgICAgICAgICBpbnRlZ3JhdGlvbkNsb3N1cmU6IFwiUHJvbXB0cyBhbmQgTUNQIGNhbGwgdGhlIHNhbWUgaGFuZGxlci5cIixcbiAgICAgICAgICBvYnNlcnZhYmlsaXR5SW1wYWN0OiBcIkV4ZWN1dG9yIHRlc3RzIGNvdmVyIG91dHB1dCBwYXRocy5cIixcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgfSwgYmFzZSkpO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5kZXRhaWxzLm9wZXJhdGlvbiwgXCJwbGFuX21pbGVzdG9uZVwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmRldGFpbHMubWlsZXN0b25lSWQsIFwiTTAwMVwiKTtcbiAgICBjb25zdCByb2FkbWFwUGF0aCA9IFN0cmluZyhyZXN1bHQuZGV0YWlscy5yb2FkbWFwUGF0aCk7XG4gICAgYXNzZXJ0Lm9rKGV4aXN0c1N5bmMocm9hZG1hcFBhdGgpLCBcInJvYWRtYXAgc2hvdWxkIGJlIHJlbmRlcmVkIHRvIGRpc2tcIik7XG4gICAgYXNzZXJ0Lm1hdGNoKHJlYWRGaWxlU3luYyhyb2FkbWFwUGF0aCwgXCJ1dGYtOFwiKSwgL1dvcmtmbG93IE1DUCBwbGFubmluZy8pO1xuICB9IGZpbmFsbHkge1xuICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcImV4ZWN1dGVQbGFuU2xpY2Ugd3JpdGVzIHRhc2sgcGxhbm5pbmcgc3RhdGUgYW5kIHJlbmRlcmVkIHBsYW4gYXJ0aWZhY3RzXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgb3BlblRlc3REYihiYXNlKTtcbiAgICBhd2FpdCBpblByb2plY3REaXIoYmFzZSwgKCkgPT4gZXhlY3V0ZVBsYW5NaWxlc3RvbmUoe1xuICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgdGl0bGU6IFwiV29ya2Zsb3cgTUNQIHBsYW5uaW5nXCIsXG4gICAgICB2aXNpb246IFwiUGxhbiBtaWxlc3RvbmUgb3ZlciBzaGFyZWQgZXhlY3V0b3JzLlwiLFxuICAgICAgc2xpY2VzOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBzbGljZUlkOiBcIlMwMVwiLFxuICAgICAgICAgIHRpdGxlOiBcIkJyaWRnZSBwbGFubmluZ1wiLFxuICAgICAgICAgIHJpc2s6IFwibWVkaXVtXCIsXG4gICAgICAgICAgZGVwZW5kczogW10sXG4gICAgICAgICAgZGVtbzogXCJNaWxlc3RvbmUgcGxhbiBwZXJzaXN0cyB0aHJvdWdoIE1DUC5cIixcbiAgICAgICAgICBnb2FsOiBcIlBlcnNpc3Qgcm9hZG1hcCBzdGF0ZS5cIixcbiAgICAgICAgICBzdWNjZXNzQ3JpdGVyaWE6IFwiUk9BRE1BUC5tZCByZW5kZXJzIGZyb20gREIuXCIsXG4gICAgICAgICAgcHJvb2ZMZXZlbDogXCJpbnRlZ3JhdGlvblwiLFxuICAgICAgICAgIGludGVncmF0aW9uQ2xvc3VyZTogXCJQcm9tcHRzIGFuZCBNQ1AgY2FsbCB0aGUgc2FtZSBoYW5kbGVyLlwiLFxuICAgICAgICAgIG9ic2VydmFiaWxpdHlJbXBhY3Q6IFwiRXhlY3V0b3IgdGVzdHMgY292ZXIgb3V0cHV0IHBhdGhzLlwiLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9LCBiYXNlKSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBpblByb2plY3REaXIoYmFzZSwgKCkgPT4gZXhlY3V0ZVBsYW5TbGljZSh7XG4gICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICBzbGljZUlkOiBcIlMwMVwiLFxuICAgICAgZ29hbDogXCJQZXJzaXN0IHNsaWNlIHBsYW4gb3ZlciBNQ1AuXCIsXG4gICAgICB0YXNrczogW1xuICAgICAgICB7XG4gICAgICAgICAgdGFza0lkOiBcIlQwMVwiLFxuICAgICAgICAgIHRpdGxlOiBcIkFkZCBwbGFubmluZyBicmlkZ2VcIixcbiAgICAgICAgICBkZXNjcmlwdGlvbjogXCJJbXBsZW1lbnQgdGhlIHNoYXJlZCBleGVjdXRvciBwYXRoLlwiLFxuICAgICAgICAgIGVzdGltYXRlOiBcIjE1bVwiLFxuICAgICAgICAgIGZpbGVzOiBbXCJzcmMvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL3Rvb2xzL3dvcmtmbG93LXRvb2wtZXhlY3V0b3JzLnRzXCJdLFxuICAgICAgICAgIHZlcmlmeTogXCJub2RlIC0tdGVzdFwiLFxuICAgICAgICAgIGlucHV0czogW1wiLmdzZC9taWxlc3RvbmVzL00wMDEvTTAwMS1ST0FETUFQLm1kXCJdLFxuICAgICAgICAgIGV4cGVjdGVkT3V0cHV0OiBbXCJTMDEtUExBTi5tZFwiLCBcIlQwMS1QTEFOLm1kXCJdLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9LCBiYXNlKSk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmRldGFpbHMub3BlcmF0aW9uLCBcInBsYW5fc2xpY2VcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5kZXRhaWxzLnNsaWNlSWQsIFwiUzAxXCIpO1xuICAgIGNvbnN0IHBsYW5QYXRoID0gU3RyaW5nKHJlc3VsdC5kZXRhaWxzLnBsYW5QYXRoKTtcbiAgICBhc3NlcnQub2soZXhpc3RzU3luYyhwbGFuUGF0aCksIFwic2xpY2UgcGxhbiBzaG91bGQgYmUgcmVuZGVyZWQgdG8gZGlza1wiKTtcbiAgICBhc3NlcnQubWF0Y2gocmVhZEZpbGVTeW5jKHBsYW5QYXRoLCBcInV0Zi04XCIpLCAvUGVyc2lzdCBzbGljZSBwbGFuIG92ZXIgTUNQLyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZXhlY3V0ZVBsYW5TbGljZSBtYXJrcyB2YWxpZGF0aW9uIGZhaWx1cmVzIHdpdGggaXNFcnJvclwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIG9wZW5UZXN0RGIoYmFzZSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBpblByb2plY3REaXIoYmFzZSwgKCkgPT4gZXhlY3V0ZVBsYW5TbGljZSh7XG4gICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICBzbGljZUlkOiBcIlMwMVwiLFxuICAgICAgZ29hbDogXCJUcmlnZ2VyIHZhbGlkYXRpb24gZmFpbHVyZSBmb3IgZW1wdHkgdGFza3MuXCIsXG4gICAgICB0YXNrczogW10sXG4gICAgfSwgYmFzZSkpO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5pc0Vycm9yLCB0cnVlKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmRldGFpbHMub3BlcmF0aW9uLCBcInBsYW5fc2xpY2VcIik7XG4gICAgYXNzZXJ0Lm1hdGNoKFN0cmluZyhyZXN1bHQuZGV0YWlscy5lcnJvciksIC92YWxpZGF0aW9uIGZhaWxlZDogdGFza3MgbXVzdCBiZSBhIG5vbi1lbXB0eSBhcnJheS8pO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQuY29udGVudFswXS50ZXh0LCAvRXJyb3IgcGxhbm5pbmcgc2xpY2U6Lyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZXhlY3V0ZVNsaWNlQ29tcGxldGUgY29lcmNlcyBzdHJpbmcgZW5yaWNobWVudCBlbnRyaWVzIGFuZCB3cml0ZXMgc3VtbWFyeS9VQVQgYXJ0aWZhY3RzXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgb3BlblRlc3REYihiYXNlKTtcbiAgICBzZWVkTWlsZXN0b25lKFwiTTAwMVwiLCBcIk1pbGVzdG9uZSBPbmVcIik7XG4gICAgc2VlZFNsaWNlKFwiTTAwMVwiLCBcIlMwMVwiLCBcInBlbmRpbmdcIik7XG4gICAgd3JpdGVSb2FkbWFwKGJhc2UsIFwiTTAwMVwiLCBbXCJTMDFcIl0pO1xuICAgIGNvbnN0IGRiID0gX2dldEFkYXB0ZXIoKTtcbiAgICBkYiEucHJlcGFyZShcbiAgICAgIFwiSU5TRVJUIE9SIFJFUExBQ0UgSU5UTyB0YXNrcyAobWlsZXN0b25lX2lkLCBzbGljZV9pZCwgaWQsIHRpdGxlLCBzdGF0dXMpIFZBTFVFUyAoPywgPywgPywgPywgPylcIixcbiAgICApLnJ1bihcIk0wMDFcIiwgXCJTMDFcIiwgXCJUMDFcIiwgXCJUYXNrIFQwMVwiLCBcImNvbXBsZXRlXCIpO1xuXG4gICAgY29uc3QgcmF3UGFyYW1zID0ge1xuICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgc2xpY2VJZDogXCJTMDFcIixcbiAgICAgIHNsaWNlVGl0bGU6IFwiU2xpY2UgUzAxXCIsXG4gICAgICBvbmVMaW5lcjogXCJDb21wbGV0ZWQgc2xpY2VcIixcbiAgICAgIG5hcnJhdGl2ZTogXCJJbXBsZW1lbnRlZCB0aGUgc2xpY2VcIixcbiAgICAgIHZlcmlmaWNhdGlvbjogXCJub2RlIC0tdGVzdFwiLFxuICAgICAgdWF0Q29udGVudDogXCIjIyBVQVRcXG5cXG5QQVNTXCIsXG4gICAgICBwcm92aWRlczogXCJzaGFyZWQgZXhlY3V0b3IgcGF0aFwiLFxuICAgICAgcmVxdWlyZW1lbnRzQWR2YW5jZWQ6IFtcIlIwMDEgLSBhZGRlZCBzbGljZSBjb21wbGV0aW9uIHN1cHBvcnRcIl0sXG4gICAgICBmaWxlc01vZGlmaWVkOiBbXCJzcmMvZmlsZS50cyAtIHVwZGF0ZWQgbG9naWNcIl0sXG4gICAgICByZXF1aXJlczogW1wiUzAwIC0gdXBzdHJlYW0gY29udGV4dFwiXSxcbiAgICB9IGFzIHVua25vd24gYXMgUGFyYW1ldGVyczx0eXBlb2YgZXhlY3V0ZVNsaWNlQ29tcGxldGU+WzBdO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaW5Qcm9qZWN0RGlyKGJhc2UsICgpID0+IGV4ZWN1dGVTbGljZUNvbXBsZXRlKHJhd1BhcmFtcywgYmFzZSkpO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5kZXRhaWxzLm9wZXJhdGlvbiwgXCJjb21wbGV0ZV9zbGljZVwiKTtcbiAgICBjb25zdCBzdW1tYXJ5UGF0aCA9IFN0cmluZyhyZXN1bHQuZGV0YWlscy5zdW1tYXJ5UGF0aCk7XG4gICAgY29uc3QgdWF0UGF0aCA9IFN0cmluZyhyZXN1bHQuZGV0YWlscy51YXRQYXRoKTtcbiAgICBhc3NlcnQub2soZXhpc3RzU3luYyhzdW1tYXJ5UGF0aCksIFwic2xpY2Ugc3VtbWFyeSBzaG91bGQgYmUgd3JpdHRlbiB0byBkaXNrXCIpO1xuICAgIGFzc2VydC5vayhleGlzdHNTeW5jKHVhdFBhdGgpLCBcInNsaWNlIFVBVCBzaG91bGQgYmUgd3JpdHRlbiB0byBkaXNrXCIpO1xuICAgIGFzc2VydC5tYXRjaChyZWFkRmlsZVN5bmMoc3VtbWFyeVBhdGgsIFwidXRmLThcIiksIC9zaGFyZWQgZXhlY3V0b3IgcGF0aC8pO1xuICAgIGFzc2VydC5tYXRjaChyZWFkRmlsZVN5bmMoc3VtbWFyeVBhdGgsIFwidXRmLThcIiksIC9SMDAxLyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZXhlY3V0ZVZhbGlkYXRlTWlsZXN0b25lIHBlcnNpc3RzIHZhbGlkYXRpb24gYXJ0aWZhY3QgYW5kIGdhdGUgcmVjb3Jkc1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIG9wZW5UZXN0RGIoYmFzZSk7XG4gICAgc2VlZE1pbGVzdG9uZShcIk0wMDJcIiwgXCJNaWxlc3RvbmUgVHdvXCIpO1xuICAgIHNlZWRTbGljZShcIk0wMDJcIiwgXCJTMDJcIiwgXCJjb21wbGV0ZVwiKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGluUHJvamVjdERpcihiYXNlLCAoKSA9PiBleGVjdXRlVmFsaWRhdGVNaWxlc3RvbmUoe1xuICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMlwiLFxuICAgICAgdmVyZGljdDogXCJwYXNzXCIsXG4gICAgICByZW1lZGlhdGlvblJvdW5kOiAwLFxuICAgICAgc3VjY2Vzc0NyaXRlcmlhQ2hlY2tsaXN0OiBcIi0gW3hdIFdvcmtzXCIsXG4gICAgICBzbGljZURlbGl2ZXJ5QXVkaXQ6IFwifCBTbGljZSB8IFJlc3VsdCB8XFxufCAtLS0gfCAtLS0gfFxcbnwgUzAyIHwgcGFzcyB8XCIsXG4gICAgICBjcm9zc1NsaWNlSW50ZWdyYXRpb246IFwiTm8gY3Jvc3Mtc2xpY2UgaXNzdWVzLlwiLFxuICAgICAgcmVxdWlyZW1lbnRDb3ZlcmFnZTogXCJBbGwgcmVxdWlyZW1lbnRzIGNvdmVyZWQuXCIsXG4gICAgICB2ZXJkaWN0UmF0aW9uYWxlOiBcIkV2ZXJ5dGhpbmcgcGFzc2VkLlwiLFxuICAgIH0sIGJhc2UpKTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuZGV0YWlscy5vcGVyYXRpb24sIFwidmFsaWRhdGVfbWlsZXN0b25lXCIpO1xuICAgIGNvbnN0IHZhbGlkYXRpb25QYXRoID0gU3RyaW5nKHJlc3VsdC5kZXRhaWxzLnZhbGlkYXRpb25QYXRoKTtcbiAgICBhc3NlcnQub2soZXhpc3RzU3luYyh2YWxpZGF0aW9uUGF0aCksIFwidmFsaWRhdGlvbiBmaWxlIHNob3VsZCBiZSB3cml0dGVuIHRvIGRpc2tcIik7XG5cbiAgICBjb25zdCBkYiA9IF9nZXRBZGFwdGVyKCk7XG4gICAgY29uc3QgZ2F0ZXMgPSBkYiEucHJlcGFyZShcbiAgICAgIFwiU0VMRUNUIGdhdGVfaWQsIHZlcmRpY3QgRlJPTSBxdWFsaXR5X2dhdGVzIFdIRVJFIG1pbGVzdG9uZV9pZCA9ID8gT1JERVIgQlkgZ2F0ZV9pZFwiLFxuICAgICkuYWxsKFwiTTAwMlwiKSBhcyBBcnJheTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj47XG4gICAgYXNzZXJ0Lm9rKGdhdGVzLmxlbmd0aCA+IDAsIFwidmFsaWRhdGlvbiBzaG91bGQgc2VlZCBtaWxlc3RvbmUgcXVhbGl0eSBnYXRlc1wiKTtcbiAgICBhc3NlcnQuZXF1YWwoZ2F0ZXNbMF1bXCJ2ZXJkaWN0XCJdLCBcInBhc3NcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZXhlY3V0ZUNvbXBsZXRlTWlsZXN0b25lIHNhbml0aXplcyByYXcgcGFyYW1zIGFuZCB3cml0ZXMgbWlsZXN0b25lIHN1bW1hcnlcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICBvcGVuVGVzdERiKGJhc2UpO1xuICAgIHNlZWRNaWxlc3RvbmUoXCJNMDAzXCIsIFwiTWlsZXN0b25lIFRocmVlXCIpO1xuICAgIHNlZWRTbGljZShcIk0wMDNcIiwgXCJTMDNcIiwgXCJjb21wbGV0ZVwiKTtcbiAgICB3cml0ZVJvYWRtYXAoYmFzZSwgXCJNMDAzXCIsIFtcIlMwM1wiXSk7XG4gICAgY29uc3QgZGIgPSBfZ2V0QWRhcHRlcigpO1xuICAgIGRiIS5wcmVwYXJlKFxuICAgICAgXCJJTlNFUlQgT1IgUkVQTEFDRSBJTlRPIHRhc2tzIChtaWxlc3RvbmVfaWQsIHNsaWNlX2lkLCBpZCwgdGl0bGUsIHN0YXR1cykgVkFMVUVTICg/LCA/LCA/LCA/LCA/KVwiLFxuICAgICkucnVuKFwiTTAwM1wiLCBcIlMwM1wiLCBcIlQwM1wiLCBcIlRhc2sgVDAzXCIsIFwiY29tcGxldGVcIik7XG5cbiAgICBjb25zdCByYXdQYXJhbXMgPSB7XG4gICAgICBtaWxlc3RvbmVJZDogXCJNMDAzXCIsXG4gICAgICB0aXRsZTogXCJNaWxlc3RvbmUgVGhyZWVcIixcbiAgICAgIG9uZUxpbmVyOiBcIkNvbXBsZXRlZCBtaWxlc3RvbmVcIixcbiAgICAgIG5hcnJhdGl2ZTogXCJFdmVyeXRoaW5nIHNoaXBwZWQuXCIsXG4gICAgICB2ZXJpZmljYXRpb25QYXNzZWQ6IFwidHJ1ZVwiLFxuICAgICAga2V5RGVjaXNpb25zOiBbXCJzaGFyZWQgZXhlY3V0b3IgcGF0aFwiXSxcbiAgICAgIGxlc3NvbnNMZWFybmVkOiBbXCJNQ1AgdHJhbnNwb3J0IHN0YXlzIGdlbmVyaWNcIl0sXG4gICAgfSBhcyB1bmtub3duIGFzIFBhcmFtZXRlcnM8dHlwZW9mIGV4ZWN1dGVDb21wbGV0ZU1pbGVzdG9uZT5bMF07XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBpblByb2plY3REaXIoYmFzZSwgKCkgPT4gZXhlY3V0ZUNvbXBsZXRlTWlsZXN0b25lKHJhd1BhcmFtcywgYmFzZSkpO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5kZXRhaWxzLm9wZXJhdGlvbiwgXCJjb21wbGV0ZV9taWxlc3RvbmVcIik7XG4gICAgY29uc3Qgc3VtbWFyeVBhdGggPSBTdHJpbmcocmVzdWx0LmRldGFpbHMuc3VtbWFyeVBhdGgpO1xuICAgIGFzc2VydC5vayhleGlzdHNTeW5jKHN1bW1hcnlQYXRoKSwgXCJtaWxlc3RvbmUgc3VtbWFyeSBzaG91bGQgYmUgd3JpdHRlbiB0byBkaXNrXCIpO1xuICAgIGFzc2VydC5tYXRjaChyZWFkRmlsZVN5bmMoc3VtbWFyeVBhdGgsIFwidXRmLThcIiksIC9zaGFyZWQgZXhlY3V0b3IgcGF0aC8pO1xuICB9IGZpbmFsbHkge1xuICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcImV4ZWN1dGVDb21wbGV0ZU1pbGVzdG9uZSByZXR1cm5zIHN1Y2Nlc3MgZm9yIGFscmVhZHktY29tcGxldGUgbWlsZXN0b25lcyB3aXRob3V0IG92ZXJ3cml0aW5nIHRoZSBleGlzdGluZyBzdW1tYXJ5XCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgb3BlblRlc3REYihiYXNlKTtcbiAgICBzZWVkTWlsZXN0b25lKFwiTTAwM1wiLCBcIk1pbGVzdG9uZSBUaHJlZVwiLCBcImNvbXBsZXRlXCIpO1xuICAgIHNlZWRTbGljZShcIk0wMDNcIiwgXCJTMDNcIiwgXCJjb21wbGV0ZVwiKTtcbiAgICB3cml0ZVJvYWRtYXAoYmFzZSwgXCJNMDAzXCIsIFtcIlMwM1wiXSk7XG4gICAgY29uc3QgbWlsZXN0b25lRGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwM1wiKTtcbiAgICBta2RpclN5bmMobWlsZXN0b25lRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBjb25zdCBzdW1tYXJ5UGF0aCA9IGpvaW4obWlsZXN0b25lRGlyLCBcIk0wMDMtU1VNTUFSWS5tZFwiKTtcbiAgICB3cml0ZUZpbGVTeW5jKHN1bW1hcnlQYXRoLCBcIiMgRXhpc3RpbmcgU3VtbWFyeVxcblwiKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGluUHJvamVjdERpcihiYXNlLCAoKSA9PiBleGVjdXRlQ29tcGxldGVNaWxlc3RvbmUoe1xuICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwM1wiLFxuICAgICAgdGl0bGU6IFwiTWlsZXN0b25lIFRocmVlXCIsXG4gICAgICBvbmVMaW5lcjogXCJDb21wbGV0ZWQgbWlsZXN0b25lXCIsXG4gICAgICBuYXJyYXRpdmU6IFwiRXZlcnl0aGluZyBzaGlwcGVkLlwiLFxuICAgICAgdmVyaWZpY2F0aW9uUGFzc2VkOiB0cnVlLFxuICAgIH0sIGJhc2UpKTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuaXNFcnJvciwgdW5kZWZpbmVkKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmRldGFpbHMub3BlcmF0aW9uLCBcImNvbXBsZXRlX21pbGVzdG9uZVwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmRldGFpbHMuYWxyZWFkeUNvbXBsZXRlLCB0cnVlKTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LmNvbnRlbnRbMF0udGV4dCwgL2FscmVhZHkgY29tcGxldGUvKTtcbiAgICBhc3NlcnQuZG9lc05vdE1hdGNoKHJlc3VsdC5jb250ZW50WzBdLnRleHQsIC9TdW1tYXJ5IHdyaXR0ZW4gdG8vKTtcbiAgICBhc3NlcnQuZXF1YWwocmVhZEZpbGVTeW5jKHN1bW1hcnlQYXRoLCBcInV0Zi04XCIpLCBcIiMgRXhpc3RpbmcgU3VtbWFyeVxcblwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJleGVjdXRlUmVhc3Nlc3NSb2FkbWFwIHdyaXRlcyBhc3Nlc3NtZW50IGFuZCB1cGRhdGVzIHJvYWRtYXAgcHJvamVjdGlvblwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIG9wZW5UZXN0RGIoYmFzZSk7XG4gICAgYXdhaXQgaW5Qcm9qZWN0RGlyKGJhc2UsICgpID0+IGV4ZWN1dGVQbGFuTWlsZXN0b25lKHtcbiAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDRcIixcbiAgICAgIHRpdGxlOiBcIk1pbGVzdG9uZSBGb3VyXCIsXG4gICAgICB2aXNpb246IFwiRXhlcmNpc2Ugcm9hZG1hcCByZWFzc2Vzc21lbnQuXCIsXG4gICAgICBzbGljZXM6IFtcbiAgICAgICAge1xuICAgICAgICAgIHNsaWNlSWQ6IFwiUzA0XCIsXG4gICAgICAgICAgdGl0bGU6IFwiQ29tcGxldGVkIHNsaWNlXCIsXG4gICAgICAgICAgcmlzazogXCJtZWRpdW1cIixcbiAgICAgICAgICBkZXBlbmRzOiBbXSxcbiAgICAgICAgICBkZW1vOiBcIkNvbXBsZXRlZCBzbGljZSB3b3Jrc1wiLFxuICAgICAgICAgIGdvYWw6IFwiQ29tcGxldGUgdGhlIGZpcnN0IHNsaWNlLlwiLFxuICAgICAgICAgIHN1Y2Nlc3NDcml0ZXJpYTogXCJTMDQgaXMgY29tcGxldGUuXCIsXG4gICAgICAgICAgcHJvb2ZMZXZlbDogXCJpbnRlZ3JhdGlvblwiLFxuICAgICAgICAgIGludGVncmF0aW9uQ2xvc3VyZTogXCJCYXNlbGluZSBmbG93IGlzIHdpcmVkLlwiLFxuICAgICAgICAgIG9ic2VydmFiaWxpdHlJbXBhY3Q6IFwiRXhlY3V0b3IgdGVzdCBjb3ZlcnMgcmVhc3Nlc3NtZW50LlwiLFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgc2xpY2VJZDogXCJTMDVcIixcbiAgICAgICAgICB0aXRsZTogXCJGb2xsb3ctdXAgc2xpY2VcIixcbiAgICAgICAgICByaXNrOiBcIm1lZGl1bVwiLFxuICAgICAgICAgIGRlcGVuZHM6IFtcIlMwNFwiXSxcbiAgICAgICAgICBkZW1vOiBcIkZvbGxvdy11cCBzbGljZSBpcyBhZGp1c3RlZFwiLFxuICAgICAgICAgIGdvYWw6IFwiSGFuZGxlIHRoZSBmb2xsb3ctdXAgd29yay5cIixcbiAgICAgICAgICBzdWNjZXNzQ3JpdGVyaWE6IFwiUm9hZG1hcCBnZXRzIHVwZGF0ZWQuXCIsXG4gICAgICAgICAgcHJvb2ZMZXZlbDogXCJpbnRlZ3JhdGlvblwiLFxuICAgICAgICAgIGludGVncmF0aW9uQ2xvc3VyZTogXCJEb3duc3RyZWFtIHdvcmsgc3RheXMgYWxpZ25lZC5cIixcbiAgICAgICAgICBvYnNlcnZhYmlsaXR5SW1wYWN0OiBcIkFzc2Vzc21lbnQgYXJ0aWZhY3QgaXMgcmVuZGVyZWQuXCIsXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgIH0sIGJhc2UpKTtcbiAgICBhd2FpdCBpblByb2plY3REaXIoYmFzZSwgKCkgPT4gZXhlY3V0ZVBsYW5TbGljZSh7XG4gICAgICBtaWxlc3RvbmVJZDogXCJNMDA0XCIsXG4gICAgICBzbGljZUlkOiBcIlMwNFwiLFxuICAgICAgZ29hbDogXCJDb21wbGV0ZSB0aGUgZmlyc3Qgc2xpY2UuXCIsXG4gICAgICB0YXNrczogW1xuICAgICAgICB7XG4gICAgICAgICAgdGFza0lkOiBcIlQwNFwiLFxuICAgICAgICAgIHRpdGxlOiBcIkZpbmlzaCBzbGljZVwiLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiBcIkNsb3NlIHRoZSBjb21wbGV0ZWQgc2xpY2UuXCIsXG4gICAgICAgICAgZXN0aW1hdGU6IFwiNW1cIixcbiAgICAgICAgICBmaWxlczogW1wic3JjL2ZpbGUudHNcIl0sXG4gICAgICAgICAgdmVyaWZ5OiBcIm5vZGUgLS10ZXN0XCIsXG4gICAgICAgICAgaW5wdXRzOiBbXCJNMDA0LVJPQURNQVAubWRcIl0sXG4gICAgICAgICAgZXhwZWN0ZWRPdXRwdXQ6IFtcIlMwNC1TVU1NQVJZLm1kXCIsIFwiUzA0LVVBVC5tZFwiXSxcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgfSwgYmFzZSkpO1xuICAgIGF3YWl0IGluUHJvamVjdERpcihiYXNlLCAoKSA9PiBleGVjdXRlVGFza0NvbXBsZXRlKHtcbiAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDRcIixcbiAgICAgIHNsaWNlSWQ6IFwiUzA0XCIsXG4gICAgICB0YXNrSWQ6IFwiVDA0XCIsXG4gICAgICBvbmVMaW5lcjogXCJDb21wbGV0ZWQgdGFza1wiLFxuICAgICAgbmFycmF0aXZlOiBcIlRhc2sgZmluaXNoZWQuXCIsXG4gICAgICB2ZXJpZmljYXRpb246IFwibm9kZSAtLXRlc3RcIixcbiAgICB9LCBiYXNlKSk7XG4gICAgYXdhaXQgaW5Qcm9qZWN0RGlyKGJhc2UsICgpID0+IGV4ZWN1dGVTbGljZUNvbXBsZXRlKHtcbiAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDRcIixcbiAgICAgIHNsaWNlSWQ6IFwiUzA0XCIsXG4gICAgICBzbGljZVRpdGxlOiBcIkNvbXBsZXRlZCBzbGljZVwiLFxuICAgICAgb25lTGluZXI6IFwiQ29tcGxldGVkIHNsaWNlXCIsXG4gICAgICBuYXJyYXRpdmU6IFwiU2xpY2UgZmluaXNoZWQuXCIsXG4gICAgICB2ZXJpZmljYXRpb246IFwibm9kZSAtLXRlc3RcIixcbiAgICAgIHVhdENvbnRlbnQ6IFwiIyMgVUFUXFxuXFxuUEFTU1wiLFxuICAgIH0sIGJhc2UpKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGluUHJvamVjdERpcihiYXNlLCAoKSA9PiBleGVjdXRlUmVhc3Nlc3NSb2FkbWFwKHtcbiAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDRcIixcbiAgICAgIGNvbXBsZXRlZFNsaWNlSWQ6IFwiUzA0XCIsXG4gICAgICB2ZXJkaWN0OiBcInJvYWRtYXAtYWRqdXN0ZWRcIixcbiAgICAgIGFzc2Vzc21lbnQ6IFwiQWRkZWQgYSByZW1lZGlhdGlvbiBzbGljZS5cIixcbiAgICAgIHNsaWNlQ2hhbmdlczoge1xuICAgICAgICBtb2RpZmllZDogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIHNsaWNlSWQ6IFwiUzA1XCIsXG4gICAgICAgICAgICB0aXRsZTogXCJBZGp1c3RlZCBmb2xsb3ctdXAgc2xpY2VcIixcbiAgICAgICAgICAgIHJpc2s6IFwiaGlnaFwiLFxuICAgICAgICAgICAgZGVwZW5kczogW1wiUzA0XCJdLFxuICAgICAgICAgICAgZGVtbzogXCJBZGp1c3RlZCBmb2xsb3ctdXAgZGVtb1wiLFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICAgIGFkZGVkOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgc2xpY2VJZDogXCJTMDZcIixcbiAgICAgICAgICAgIHRpdGxlOiBcIlJlbWVkaWF0aW9uIHNsaWNlXCIsXG4gICAgICAgICAgICByaXNrOiBcIm1lZGl1bVwiLFxuICAgICAgICAgICAgZGVwZW5kczogW1wiUzA1XCJdLFxuICAgICAgICAgICAgZGVtbzogXCJSZW1lZGlhdGlvbiBzbGljZSBkZW1vXCIsXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgICAgcmVtb3ZlZDogW10sXG4gICAgICB9LFxuICAgIH0sIGJhc2UpKTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuZGV0YWlscy5vcGVyYXRpb24sIFwicmVhc3Nlc3Nfcm9hZG1hcFwiKTtcbiAgICBjb25zdCBhc3Nlc3NtZW50UGF0aCA9IFN0cmluZyhyZXN1bHQuZGV0YWlscy5hc3Nlc3NtZW50UGF0aCk7XG4gICAgY29uc3Qgcm9hZG1hcFBhdGggPSBTdHJpbmcocmVzdWx0LmRldGFpbHMucm9hZG1hcFBhdGgpO1xuICAgIGFzc2VydC5vayhleGlzdHNTeW5jKGFzc2Vzc21lbnRQYXRoKSwgXCJhc3Nlc3NtZW50IGZpbGUgc2hvdWxkIGJlIHdyaXR0ZW5cIik7XG4gICAgYXNzZXJ0Lm9rKGV4aXN0c1N5bmMocm9hZG1hcFBhdGgpLCBcInJvYWRtYXAgc2hvdWxkIGJlIHJlLXJlbmRlcmVkXCIpO1xuICAgIGFzc2VydC5tYXRjaChyZWFkRmlsZVN5bmMocm9hZG1hcFBhdGgsIFwidXRmLThcIiksIC9TMDYvKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJleGVjdXRlU2F2ZUdhdGVSZXN1bHQgdmFsaWRhdGVzIGlucHV0cyBhbmQgcGVyc2lzdHMgdmVyZGljdHNcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICBvcGVuVGVzdERiKGJhc2UpO1xuICAgIHNlZWRNaWxlc3RvbmUoXCJNMDA1XCIsIFwiTWlsZXN0b25lIEZpdmVcIik7XG4gICAgc2VlZFNsaWNlKFwiTTAwNVwiLCBcIlMwNVwiLCBcInBlbmRpbmdcIik7XG4gICAgaW5zZXJ0R2F0ZVJvdyh7XG4gICAgICBtaWxlc3RvbmVJZDogXCJNMDA1XCIsXG4gICAgICBzbGljZUlkOiBcIlMwNVwiLFxuICAgICAgZ2F0ZUlkOiBcIlEzXCIsXG4gICAgICBzY29wZTogXCJzbGljZVwiLFxuICAgIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaW5Qcm9qZWN0RGlyKGJhc2UsICgpID0+IGV4ZWN1dGVTYXZlR2F0ZVJlc3VsdCh7XG4gICAgICBtaWxlc3RvbmVJZDogXCJNMDA1XCIsXG4gICAgICBzbGljZUlkOiBcIlMwNVwiLFxuICAgICAgZ2F0ZUlkOiBcIlEzXCIsXG4gICAgICB2ZXJkaWN0OiBcInBhc3NcIixcbiAgICAgIHJhdGlvbmFsZTogXCJMb29rcyBnb29kLlwiLFxuICAgICAgZmluZGluZ3M6IFwiTm8gaXNzdWVzIGZvdW5kLlwiLFxuICAgIH0sIGJhc2UpKTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuZGV0YWlscy5vcGVyYXRpb24sIFwic2F2ZV9nYXRlX3Jlc3VsdFwiKTtcbiAgICBjb25zdCBkYiA9IF9nZXRBZGFwdGVyKCk7XG4gICAgY29uc3Qgcm93ID0gZGIhLnByZXBhcmUoXG4gICAgICBcIlNFTEVDVCBzdGF0dXMsIHZlcmRpY3QsIHJhdGlvbmFsZSBGUk9NIHF1YWxpdHlfZ2F0ZXMgV0hFUkUgbWlsZXN0b25lX2lkID0gPyBBTkQgc2xpY2VfaWQgPSA/IEFORCBnYXRlX2lkID0gPyBBTkQgdGFza19pZCA9ICcnXCIsXG4gICAgKS5nZXQoXCJNMDA1XCIsIFwiUzA1XCIsIFwiUTNcIikgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQ7XG4gICAgYXNzZXJ0LmVxdWFsKHJvdz8uc3RhdHVzLCBcImNvbXBsZXRlXCIpO1xuICAgIGFzc2VydC5lcXVhbChyb3c/LnZlcmRpY3QsIFwicGFzc1wiKTtcbiAgICBhc3NlcnQuZXF1YWwocm93Py5yYXRpb25hbGUsIFwiTG9va3MgZ29vZC5cIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZXhlY3V0ZVJlcGxhblNsaWNlIHJld3JpdGVzIHBlbmRpbmcgdGFza3MgYW5kIHJlbmRlcnMgcmVwbGFuIGFydGlmYWN0c1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIG9wZW5UZXN0RGIoYmFzZSk7XG4gICAgYXdhaXQgaW5Qcm9qZWN0RGlyKGJhc2UsICgpID0+IGV4ZWN1dGVQbGFuTWlsZXN0b25lKHtcbiAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDZcIixcbiAgICAgIHRpdGxlOiBcIk1pbGVzdG9uZSBTaXhcIixcbiAgICAgIHZpc2lvbjogXCJFeGVyY2lzZSBzbGljZSByZXBsYW5uaW5nLlwiLFxuICAgICAgc2xpY2VzOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBzbGljZUlkOiBcIlMwNlwiLFxuICAgICAgICAgIHRpdGxlOiBcIlJlcGxhbiBzbGljZVwiLFxuICAgICAgICAgIHJpc2s6IFwibWVkaXVtXCIsXG4gICAgICAgICAgZGVwZW5kczogW10sXG4gICAgICAgICAgZGVtbzogXCJTbGljZSBjYW4gYmUgcmVwbGFubmVkIGFmdGVyIGEgYmxvY2tlciB0YXNrIGNvbXBsZXRlcy5cIixcbiAgICAgICAgICBnb2FsOiBcIlByZXBhcmUgcmVwbGFuIHN0YXRlLlwiLFxuICAgICAgICAgIHN1Y2Nlc3NDcml0ZXJpYTogXCJQTEFOIGFuZCBSRVBMQU4gYXJ0aWZhY3RzIHVwZGF0ZS5cIixcbiAgICAgICAgICBwcm9vZkxldmVsOiBcImludGVncmF0aW9uXCIsXG4gICAgICAgICAgaW50ZWdyYXRpb25DbG9zdXJlOiBcIlJlcGxhbiBzaGFyZXMgdGhlIHdvcmtmbG93IGV4ZWN1dG9yIHBhdGguXCIsXG4gICAgICAgICAgb2JzZXJ2YWJpbGl0eUltcGFjdDogXCJFeGVjdXRvciB0ZXN0IGNvdmVycyByZXBsYW4gb3V0cHV0IGZpbGVzLlwiLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9LCBiYXNlKSk7XG4gICAgYXdhaXQgaW5Qcm9qZWN0RGlyKGJhc2UsICgpID0+IGV4ZWN1dGVQbGFuU2xpY2Uoe1xuICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwNlwiLFxuICAgICAgc2xpY2VJZDogXCJTMDZcIixcbiAgICAgIGdvYWw6IFwiUGxhbiBhIHNsaWNlIHRoYXQgd2lsbCBiZSByZXBsYW5uZWQuXCIsXG4gICAgICB0YXNrczogW1xuICAgICAgICB7XG4gICAgICAgICAgdGFza0lkOiBcIlQwNlwiLFxuICAgICAgICAgIHRpdGxlOiBcIkJsb2NrZXIgdGFza1wiLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiBcIkZpbmlzaCB0aGUgYmxvY2tlci1kaXNjb3ZlcnkgdGFzay5cIixcbiAgICAgICAgICBlc3RpbWF0ZTogXCI1bVwiLFxuICAgICAgICAgIGZpbGVzOiBbXCJzcmMvYmxvY2tlci50c1wiXSxcbiAgICAgICAgICB2ZXJpZnk6IFwibm9kZSAtLXRlc3RcIixcbiAgICAgICAgICBpbnB1dHM6IFtcIk0wMDYtUk9BRE1BUC5tZFwiXSxcbiAgICAgICAgICBleHBlY3RlZE91dHB1dDogW1wiVDA2LVNVTU1BUlkubWRcIl0sXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICB0YXNrSWQ6IFwiVDA3XCIsXG4gICAgICAgICAgdGl0bGU6IFwiUGVuZGluZyB0YXNrXCIsXG4gICAgICAgICAgZGVzY3JpcHRpb246IFwiT3JpZ2luYWwgZm9sbG93LXVwIHRhc2suXCIsXG4gICAgICAgICAgZXN0aW1hdGU6IFwiMTBtXCIsXG4gICAgICAgICAgZmlsZXM6IFtcInNyYy9wZW5kaW5nLnRzXCJdLFxuICAgICAgICAgIHZlcmlmeTogXCJub2RlIC0tdGVzdFwiLFxuICAgICAgICAgIGlucHV0czogW1wiUzA2LVBMQU4ubWRcIl0sXG4gICAgICAgICAgZXhwZWN0ZWRPdXRwdXQ6IFtcIlVwZGF0ZWQgcGxhblwiXSxcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgfSwgYmFzZSkpO1xuICAgIGF3YWl0IGluUHJvamVjdERpcihiYXNlLCAoKSA9PiBleGVjdXRlVGFza0NvbXBsZXRlKHtcbiAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDZcIixcbiAgICAgIHNsaWNlSWQ6IFwiUzA2XCIsXG4gICAgICB0YXNrSWQ6IFwiVDA2XCIsXG4gICAgICBvbmVMaW5lcjogXCJDb21wbGV0ZWQgYmxvY2tlciB0YXNrXCIsXG4gICAgICBuYXJyYXRpdmU6IFwiVGhlIGJsb2NrZXIgd2FzIGlkZW50aWZpZWQgYW5kIGRvY3VtZW50ZWQuXCIsXG4gICAgICB2ZXJpZmljYXRpb246IFwibm9kZSAtLXRlc3RcIixcbiAgICB9LCBiYXNlKSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBpblByb2plY3REaXIoYmFzZSwgKCkgPT4gZXhlY3V0ZVJlcGxhblNsaWNlKHtcbiAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDZcIixcbiAgICAgIHNsaWNlSWQ6IFwiUzA2XCIsXG4gICAgICBibG9ja2VyVGFza0lkOiBcIlQwNlwiLFxuICAgICAgYmxvY2tlckRlc2NyaXB0aW9uOiBcIk9yaWdpbmFsIGFwcHJvYWNoIG5vIGxvbmdlciB3b3Jrcy5cIixcbiAgICAgIHdoYXRDaGFuZ2VkOiBcIkFkanVzdGVkIHRoZSByZW1haW5pbmcgdGFza3MgYW5kIGFkZGVkIGEgcmVtZWRpYXRpb24gdGFzay5cIixcbiAgICAgIHVwZGF0ZWRUYXNrczogW1xuICAgICAgICB7XG4gICAgICAgICAgdGFza0lkOiBcIlQwN1wiLFxuICAgICAgICAgIHRpdGxlOiBcIlBlbmRpbmcgdGFzayAodXBkYXRlZClcIixcbiAgICAgICAgICBkZXNjcmlwdGlvbjogXCJVcGRhdGVkIGZvbGxvdy11cCB0YXNrIGFmdGVyIHJlcGxhbm5pbmcuXCIsXG4gICAgICAgICAgZXN0aW1hdGU6IFwiMTVtXCIsXG4gICAgICAgICAgZmlsZXM6IFtcInNyYy9wZW5kaW5nLnRzXCIsIFwic3JjL3JlcGxhbm5lZC50c1wiXSxcbiAgICAgICAgICB2ZXJpZnk6IFwibm9kZSAtLXRlc3RcIixcbiAgICAgICAgICBpbnB1dHM6IFtcIlMwNi1QTEFOLm1kXCJdLFxuICAgICAgICAgIGV4cGVjdGVkT3V0cHV0OiBbXCJVcGRhdGVkIHBsYW5cIl0sXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICB0YXNrSWQ6IFwiVDA4XCIsXG4gICAgICAgICAgdGl0bGU6IFwiUmVtZWRpYXRpb24gdGFza1wiLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiBcIk5ldyB0YXNrIGludHJvZHVjZWQgYnkgdGhlIHJlcGxhbi5cIixcbiAgICAgICAgICBlc3RpbWF0ZTogXCIyMG1cIixcbiAgICAgICAgICBmaWxlczogW1wic3JjL3JlbWVkaWF0aW9uLnRzXCJdLFxuICAgICAgICAgIHZlcmlmeTogXCJub2RlIC0tdGVzdFwiLFxuICAgICAgICAgIGlucHV0czogW1wiUzA2LVJFUExBTi5tZFwiXSxcbiAgICAgICAgICBleHBlY3RlZE91dHB1dDogW1wiUmVtZWRpYXRpb24gcGF0Y2hcIl0sXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgICAgcmVtb3ZlZFRhc2tJZHM6IFtdLFxuICAgIH0sIGJhc2UpKTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuZGV0YWlscy5vcGVyYXRpb24sIFwicmVwbGFuX3NsaWNlXCIpO1xuICAgIGNvbnN0IHBsYW5QYXRoID0gU3RyaW5nKHJlc3VsdC5kZXRhaWxzLnBsYW5QYXRoKTtcbiAgICBjb25zdCByZXBsYW5QYXRoID0gU3RyaW5nKHJlc3VsdC5kZXRhaWxzLnJlcGxhblBhdGgpO1xuICAgIGFzc2VydC5vayhleGlzdHNTeW5jKHBsYW5QYXRoKSwgXCJyZXBsYW5uZWQgcGxhbiBzaG91bGQgZXhpc3Qgb24gZGlza1wiKTtcbiAgICBhc3NlcnQub2soZXhpc3RzU3luYyhyZXBsYW5QYXRoKSwgXCJyZXBsYW4gYXJ0aWZhY3Qgc2hvdWxkIGV4aXN0IG9uIGRpc2tcIik7XG4gICAgYXNzZXJ0Lm1hdGNoKHJlYWRGaWxlU3luYyhwbGFuUGF0aCwgXCJ1dGYtOFwiKSwgL1QwOC8pO1xuICAgIGFzc2VydC5tYXRjaChyZWFkRmlsZVN5bmMocmVwbGFuUGF0aCwgXCJ1dGYtOFwiKSwgL0FkanVzdGVkIHRoZSByZW1haW5pbmcgdGFza3MvKTtcblxuICAgIGNvbnN0IGRiID0gX2dldEFkYXB0ZXIoKTtcbiAgICBjb25zdCB1cGRhdGVkVGFzayA9IGRiIS5wcmVwYXJlKFxuICAgICAgXCJTRUxFQ1QgdGl0bGUgRlJPTSB0YXNrcyBXSEVSRSBtaWxlc3RvbmVfaWQgPSA/IEFORCBzbGljZV9pZCA9ID8gQU5EIGlkID0gP1wiLFxuICAgICkuZ2V0KFwiTTAwNlwiLCBcIlMwNlwiLCBcIlQwN1wiKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZDtcbiAgICBjb25zdCBpbnNlcnRlZFRhc2sgPSBkYiEucHJlcGFyZShcbiAgICAgIFwiU0VMRUNUIHRpdGxlIEZST00gdGFza3MgV0hFUkUgbWlsZXN0b25lX2lkID0gPyBBTkQgc2xpY2VfaWQgPSA/IEFORCBpZCA9ID9cIixcbiAgICApLmdldChcIk0wMDZcIiwgXCJTMDZcIiwgXCJUMDhcIikgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQ7XG4gICAgYXNzZXJ0LmVxdWFsKHVwZGF0ZWRUYXNrPy50aXRsZSwgXCJQZW5kaW5nIHRhc2sgKHVwZGF0ZWQpXCIpO1xuICAgIGFzc2VydC5lcXVhbChpbnNlcnRlZFRhc2s/LnRpdGxlLCBcIlJlbWVkaWF0aW9uIHRhc2tcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZXhlY3V0ZVN1bW1hcnlTYXZlIHJlbW92ZXMgc2libGluZyBDT05URVhULURSQUZUIHdoZW4gd3JpdGluZyBtaWxlc3RvbmUgQ09OVEVYVCAoIzQ0NDIpXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgb3BlblRlc3REYihiYXNlKTtcbiAgICBtYXJrRGVwdGhWZXJpZmllZChcIk0wMDFcIiwgYmFzZSk7XG5cbiAgICBjb25zdCBtaWxlc3RvbmVEaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIpO1xuICAgIG1rZGlyU3luYyhtaWxlc3RvbmVEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIGNvbnN0IGRyYWZ0UGF0aCA9IGpvaW4obWlsZXN0b25lRGlyLCBcIk0wMDEtQ09OVEVYVC1EUkFGVC5tZFwiKTtcbiAgICB3cml0ZUZpbGVTeW5jKGRyYWZ0UGF0aCwgXCIjIERyYWZ0XFxuXFxuaW5jcmVtZW50YWwgbm90ZXNcIik7XG4gICAgYXNzZXJ0Lm9rKGV4aXN0c1N5bmMoZHJhZnRQYXRoKSwgXCJwcmVjb25kaXRpb246IGRyYWZ0IGV4aXN0c1wiKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGluUHJvamVjdERpcihiYXNlLCAoKSA9PiBleGVjdXRlU3VtbWFyeVNhdmUoe1xuICAgICAgbWlsZXN0b25lX2lkOiBcIk0wMDFcIixcbiAgICAgIGFydGlmYWN0X3R5cGU6IFwiQ09OVEVYVFwiLFxuICAgICAgY29udGVudDogXCIjIENvbnRleHRcXG5cXG5maW5hbCBkaXNjdXNzaW9uIG91dHB1dFwiLFxuICAgIH0sIGJhc2UpKTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuZGV0YWlscy5vcGVyYXRpb24sIFwic2F2ZV9zdW1tYXJ5XCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuZGV0YWlscy5hcnRpZmFjdF90eXBlLCBcIkNPTlRFWFRcIik7XG5cbiAgICBjb25zdCBjb250ZXh0UGF0aCA9IGpvaW4obWlsZXN0b25lRGlyLCBcIk0wMDEtQ09OVEVYVC5tZFwiKTtcbiAgICBhc3NlcnQub2soZXhpc3RzU3luYyhjb250ZXh0UGF0aCksIFwiQ09OVEVYVC5tZCBzaG91bGQgYmUgd3JpdHRlblwiKTtcbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICBleGlzdHNTeW5jKGRyYWZ0UGF0aCksXG4gICAgICBmYWxzZSxcbiAgICAgIFwiQ09OVEVYVC1EUkFGVC5tZCBzaG91bGQgYmUgcmVtb3ZlZCBhZnRlciBmaW5hbCBDT05URVhULm1kIGlzIHdyaXR0ZW5cIixcbiAgICApO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFyRGlzY3Vzc2lvbkZsb3dTdGF0ZShiYXNlKTtcbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJleGVjdXRlU3VtbWFyeVNhdmUgc3VwcG9ydHMgcm9vdC1sZXZlbCBkZWVwIHBsYW5uaW5nIGFydGlmYWN0c1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIG9wZW5UZXN0RGIoYmFzZSk7XG5cbiAgICBjb25zdCBwcm9qZWN0ID0gYXdhaXQgaW5Qcm9qZWN0RGlyKGJhc2UsICgpID0+IGV4ZWN1dGVTdW1tYXJ5U2F2ZSh7XG4gICAgICBhcnRpZmFjdF90eXBlOiBcIlBST0pFQ1RcIixcbiAgICAgIGNvbnRlbnQ6IFtcbiAgICAgICAgXCIjIFByb2plY3RcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCIjIyBXaGF0IFRoaXMgSXNcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCJBIHJvb3QgcHJvamVjdCBhcnRpZmFjdC5cIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCIjIyBNaWxlc3RvbmUgU2VxdWVuY2VcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCItIFsgXSBNMDAxOiBGb3VuZGF0aW9uIC0gRXN0YWJsaXNoIHRoZSBmaXJzdCBydW5uYWJsZSBzbGljZS5cIixcbiAgICAgICAgXCJcIixcbiAgICAgIF0uam9pbihcIlxcblwiKSxcbiAgICB9LCBiYXNlKSk7XG4gICAgYXNzZXJ0LmVxdWFsKHByb2plY3QuaXNFcnJvciwgdW5kZWZpbmVkKTtcbiAgICBhc3NlcnQuZXF1YWwocHJvamVjdC5kZXRhaWxzLnBhdGgsIFwiUFJPSkVDVC5tZFwiKTtcbiAgICBhc3NlcnQub2soZXhpc3RzU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIlBST0pFQ1QubWRcIikpKTtcblxuICAgIHVwc2VydFJlcXVpcmVtZW50KHtcbiAgICAgIGlkOiBcIlIwMDFcIixcbiAgICAgIGNsYXNzOiBcInByaW1hcnktdXNlci1sb29wXCIsXG4gICAgICBzdGF0dXM6IFwiYWN0aXZlXCIsXG4gICAgICBkZXNjcmlwdGlvbjogXCJVc2VyIGNhbiBhZGQgYSB0YXNrXCIsXG4gICAgICB3aHk6IFwiQ29yZSBsb29wXCIsXG4gICAgICBzb3VyY2U6IFwidXNlclwiLFxuICAgICAgcHJpbWFyeV9vd25lcjogXCJNMDAxL25vbmUgeWV0XCIsXG4gICAgICBzdXBwb3J0aW5nX3NsaWNlczogXCJub25lXCIsXG4gICAgICB2YWxpZGF0aW9uOiBcInVubWFwcGVkXCIsXG4gICAgICBub3RlczogXCJcIixcbiAgICAgIGZ1bGxfY29udGVudDogXCJcIixcbiAgICAgIHN1cGVyc2VkZWRfYnk6IG51bGwsXG4gICAgfSk7XG5cbiAgICBjb25zdCByZXF1aXJlbWVudHMgPSBhd2FpdCBpblByb2plY3REaXIoYmFzZSwgKCkgPT4gZXhlY3V0ZVN1bW1hcnlTYXZlKHtcbiAgICAgIGFydGlmYWN0X3R5cGU6IFwiUkVRVUlSRU1FTlRTXCIsXG4gICAgICBjb250ZW50OiBcIiMgUmVxdWlyZW1lbnRzXFxuXFxuIyMgQWN0aXZlXFxuXFxuIyMgVmFsaWRhdGVkXFxuXFxuIyMgRGVmZXJyZWRcXG5cXG4jIyBPdXQgb2YgU2NvcGVcXG5cXG4jIyBUcmFjZWFiaWxpdHlcXG5cXG4jIyBDb3ZlcmFnZSBTdW1tYXJ5XFxuXCIsXG4gICAgfSwgYmFzZSkpO1xuICAgIGFzc2VydC5lcXVhbChyZXF1aXJlbWVudHMuaXNFcnJvciwgdW5kZWZpbmVkKTtcbiAgICBhc3NlcnQuZXF1YWwocmVxdWlyZW1lbnRzLmRldGFpbHMucGF0aCwgXCJSRVFVSVJFTUVOVFMubWRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlcXVpcmVtZW50cy5kZXRhaWxzLmNvbnRlbnRfc291cmNlLCBcInJlcXVpcmVtZW50c190YWJsZVwiKTtcbiAgICBhc3NlcnQub2soZXhpc3RzU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIlJFUVVJUkVNRU5UUy5tZFwiKSkpO1xuXG4gICAgY29uc3QgZGIgPSBfZ2V0QWRhcHRlcigpO1xuICAgIGNvbnN0IHJvd3MgPSBkYiEucHJlcGFyZShcbiAgICAgIFwiU0VMRUNUIHBhdGgsIGFydGlmYWN0X3R5cGUsIG1pbGVzdG9uZV9pZCBGUk9NIGFydGlmYWN0cyBXSEVSRSBwYXRoIElOICgnUFJPSkVDVC5tZCcsICdSRVFVSVJFTUVOVFMubWQnKSBPUkRFUiBCWSBwYXRoXCIsXG4gICAgKS5hbGwoKSBhcyBBcnJheTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj47XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICAgIHJvd3MubWFwKChyb3cpID0+IFtyb3cucGF0aCwgcm93LmFydGlmYWN0X3R5cGUsIHJvdy5taWxlc3RvbmVfaWRdKSxcbiAgICAgIFtcbiAgICAgICAgW1wiUFJPSkVDVC5tZFwiLCBcIlBST0pFQ1RcIiwgbnVsbF0sXG4gICAgICAgIFtcIlJFUVVJUkVNRU5UUy5tZFwiLCBcIlJFUVVJUkVNRU5UU1wiLCBudWxsXSxcbiAgICAgIF0sXG4gICAgKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJleGVjdXRlU3VtbWFyeVNhdmUgcmVnaXN0ZXJzIFBST0pFQ1QgbWlsZXN0b25lIHNlcXVlbmNlIGZvciB0aGUgbmV4dCBydW5cIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICBvcGVuVGVzdERiKGJhc2UpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaW5Qcm9qZWN0RGlyKGJhc2UsICgpID0+IGV4ZWN1dGVTdW1tYXJ5U2F2ZSh7XG4gICAgICBhcnRpZmFjdF90eXBlOiBcIlBST0pFQ1RcIixcbiAgICAgIGNvbnRlbnQ6IFtcbiAgICAgICAgXCIjIFByb2plY3RcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCIjIyBXaGF0IFRoaXMgSXNcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCJEZWVwIHByb2plY3Qgc2V0dXAgb3V0cHV0LlwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIiMjIFByb2plY3QgU2hhcGVcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCIqKkNvbXBsZXhpdHk6KiogY29tcGxleFwiLFxuICAgICAgICBcIioqV2h5OioqIEl0IHNwYW5zIG11bHRpcGxlIGRlbGl2ZXJ5IHN0ZXBzLlwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIiMjIENhcGFiaWxpdHkgQ29udHJhY3RcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCJTZWUgLmdzZC9SRVFVSVJFTUVOVFMubWQuXCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiIyMgTWlsZXN0b25lIFNlcXVlbmNlXCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiLSBbIF0gTTAwMTogRm91bmRhdGlvbiAtIEVzdGFibGlzaCB0aGUgZmlyc3QgcnVubmFibGUgc2xpY2UuXCIsXG4gICAgICAgIFwiLSBbIF0gTTAwMjogUG9saXNoIC0gRm9sbG93LXVwIGV4cGVyaWVuY2Ugd29yay5cIixcbiAgICAgICAgXCJcIixcbiAgICAgIF0uam9pbihcIlxcblwiKSxcbiAgICB9LCBiYXNlKSk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmlzRXJyb3IsIHVuZGVmaW5lZCk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQuZGV0YWlscy5yZWdpc3RlcmVkTWlsZXN0b25lcywgW1wiTTAwMVwiLCBcIk0wMDJcIl0pO1xuXG4gICAgY29uc3QgbWlsZXN0b25lcyA9IGdldEFsbE1pbGVzdG9uZXMoKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKFxuICAgICAgbWlsZXN0b25lcy5tYXAoKG0pID0+IFttLmlkLCBtLnRpdGxlLCBtLnN0YXR1c10pLFxuICAgICAgW1xuICAgICAgICBbXCJNMDAxXCIsIFwiRm91bmRhdGlvblwiLCBcInF1ZXVlZFwiXSxcbiAgICAgICAgW1wiTTAwMlwiLCBcIlBvbGlzaFwiLCBcInF1ZXVlZFwiXSxcbiAgICAgIF0sXG4gICAgKTtcblxuICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcbiAgICBhc3NlcnQuZXF1YWwoc3RhdGUuYWN0aXZlTWlsZXN0b25lPy5pZCwgXCJNMDAxXCIpO1xuICAgIGFzc2VydC5lcXVhbChzdGF0ZS5waGFzZSwgXCJwcmUtcGxhbm5pbmdcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHN0YXRlLnJlZ2lzdHJ5WzBdPy5zdGF0dXMsIFwiYWN0aXZlXCIpO1xuICAgIGFzc2VydC5lcXVhbChzdGF0ZS5yZWdpc3RyeVsxXT8uc3RhdHVzLCBcInBlbmRpbmdcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZXhlY3V0ZVN1bW1hcnlTYXZlIGhhcmQtZmFpbHMgd2hlbiBtaWxlc3RvbmUgcmVnaXN0cmF0aW9uIHRocm93cyBzbyBzaWxlbnQgTm8tQWN0aXZlLU1pbGVzdG9uZSBpcyBpbXBvc3NpYmxlXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgb3BlblRlc3REYihiYXNlKTtcbiAgICBjb25zdCBkYiA9IF9nZXRBZGFwdGVyKCk7XG4gICAgYXNzZXJ0Lm9rKGRiLCBcIkRCIHNob3VsZCBiZSBvcGVuXCIpO1xuICAgIGNvbnN0IG9yaWdpbmFsUHJlcGFyZSA9IGRiLnByZXBhcmUuYmluZChkYik7XG4gICAgKGRiIGFzIGFueSkucHJlcGFyZSA9IChzcWw6IHN0cmluZykgPT4ge1xuICAgICAgaWYgKHNxbC5pbmNsdWRlcyhcIklOU0VSVCBPUiBJR05PUkUgSU5UTyBtaWxlc3RvbmVzXCIpKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcInNpbXVsYXRlZCBtaWxlc3RvbmUgcmVnaXN0cmF0aW9uIGZhaWx1cmVcIik7XG4gICAgICB9XG4gICAgICByZXR1cm4gb3JpZ2luYWxQcmVwYXJlKHNxbCk7XG4gICAgfTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGluUHJvamVjdERpcihiYXNlLCAoKSA9PiBleGVjdXRlU3VtbWFyeVNhdmUoe1xuICAgICAgYXJ0aWZhY3RfdHlwZTogXCJQUk9KRUNUXCIsXG4gICAgICBjb250ZW50OiBbXG4gICAgICAgIFwiIyBQcm9qZWN0XCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiIyMgV2hhdCBUaGlzIElzXCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiRGVlcCBwcm9qZWN0IHNldHVwIG91dHB1dC5cIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCIjIyBNaWxlc3RvbmUgU2VxdWVuY2VcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCItIFsgXSBNMDAxOiBGb3VuZGF0aW9uIC0gRXN0YWJsaXNoIHRoZSBmaXJzdCBydW5uYWJsZSBzbGljZS5cIixcbiAgICAgICAgXCJcIixcbiAgICAgIF0uam9pbihcIlxcblwiKSxcbiAgICB9LCBiYXNlKSk7XG5cbiAgICAvLyBUaGUgYXJ0aWZhY3QgaXMgcGVyc2lzdGVkIGJlZm9yZSByZWdpc3RyYXRpb24gcnVucywgYnV0IHJlZ2lzdHJhdGlvbiBtdXN0XG4gICAgLy8gc3VyZmFjZSBhcyBpc0Vycm9yIHNvIHRoZSBMTE0gcmV0cmllcyAoSU5TRVJUIE9SIElHTk9SRSBtYWtlcyBpdCBpZGVtcG90ZW50KVxuICAgIC8vIGluc3RlYWQgb2YgYW5ub3VuY2luZyBcInJlYWR5XCIgd2hpbGUgdGhlIERCIGhhcyB6ZXJvIG1pbGVzdG9uZSByb3dzLlxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuaXNFcnJvciwgdHJ1ZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5kZXRhaWxzLnBhdGgsIFwiUFJPSkVDVC5tZFwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmRldGFpbHMuZXJyb3IsIFwibWlsZXN0b25lX3JlZ2lzdHJhdGlvbl90aHJld1wiKTtcbiAgICBhc3NlcnQubWF0Y2goU3RyaW5nKHJlc3VsdC5kZXRhaWxzLnJlZ2lzdHJhdGlvbl9lcnJvciksIC9zaW11bGF0ZWQgbWlsZXN0b25lIHJlZ2lzdHJhdGlvbiBmYWlsdXJlLyk7XG4gICAgYXNzZXJ0Lm1hdGNoKHJlc3VsdC5jb250ZW50WzBdLnRleHQsIC9taWxlc3RvbmUgcmVnaXN0cmF0aW9uIGZhaWxlZC8pO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQuY29udGVudFswXS50ZXh0LCAvaWRlbXBvdGVudC8pO1xuICAgIGFzc2VydC5vayhleGlzdHNTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiUFJPSkVDVC5tZFwiKSkpO1xuICAgIGNvbnN0IGFydGlmYWN0ID0gb3JpZ2luYWxQcmVwYXJlKFwiU0VMRUNUIHBhdGggRlJPTSBhcnRpZmFjdHMgV0hFUkUgcGF0aCA9ID9cIikuZ2V0KFwiUFJPSkVDVC5tZFwiKTtcbiAgICBhc3NlcnQuZXF1YWwoYXJ0aWZhY3Q/LnBhdGgsIFwiUFJPSkVDVC5tZFwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJleGVjdXRlU3VtbWFyeVNhdmUgYmxvY2tzIGZpbmFsIHJvb3QgYXJ0aWZhY3RzIHdoaWxlIGFwcHJvdmFsIGdhdGUgaXMgcGVuZGluZ1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIG9wZW5UZXN0RGIoYmFzZSk7XG4gICAgc2V0UGVuZGluZ0dhdGUoXCJkZXB0aF92ZXJpZmljYXRpb25fcmVxdWlyZW1lbnRzX2NvbmZpcm1cIiwgYmFzZSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBpblByb2plY3REaXIoYmFzZSwgKCkgPT4gZXhlY3V0ZVN1bW1hcnlTYXZlKHtcbiAgICAgIGFydGlmYWN0X3R5cGU6IFwiUkVRVUlSRU1FTlRTXCIsXG4gICAgICBjb250ZW50OiBcIiMgUmVxdWlyZW1lbnRzXFxuXFxuIyMgQWN0aXZlXFxuXCIsXG4gICAgfSwgYmFzZSkpO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5pc0Vycm9yLCB0cnVlKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmRldGFpbHMuZXJyb3IsIFwicm9vdF9hcnRpZmFjdF93cml0ZV9ibG9ja2VkXCIpO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQuY29udGVudFswXS50ZXh0LCAvaGFzIG5vdCBiZWVuIGNvbmZpcm1lZC8pO1xuICAgIGFzc2VydC5lcXVhbChleGlzdHNTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiUkVRVUlSRU1FTlRTLm1kXCIpKSwgZmFsc2UpO1xuXG4gICAgY29uc3QgZHJhZnQgPSBhd2FpdCBpblByb2plY3REaXIoYmFzZSwgKCkgPT4gZXhlY3V0ZVN1bW1hcnlTYXZlKHtcbiAgICAgIGFydGlmYWN0X3R5cGU6IFwiUkVRVUlSRU1FTlRTLURSQUZUXCIsXG4gICAgICBjb250ZW50OiBcIiMgRHJhZnQgUmVxdWlyZW1lbnRzXFxuXCIsXG4gICAgfSwgYmFzZSkpO1xuICAgIGFzc2VydC5lcXVhbChkcmFmdC5pc0Vycm9yLCB1bmRlZmluZWQpO1xuICAgIGFzc2VydC5vayhleGlzdHNTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiUkVRVUlSRU1FTlRTLURSQUZULm1kXCIpKSk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYXJEaXNjdXNzaW9uRmxvd1N0YXRlKGJhc2UpO1xuICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcImV4ZWN1dGVTdW1tYXJ5U2F2ZSByZXF1aXJlcyB2ZXJpZmllZCByb290IGFwcHJvdmFsIGluIGRlZXAgbW9kZVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJQUkVGRVJFTkNFUy5tZFwiKSwgXCItLS1cXG5wbGFubmluZ19kZXB0aDogZGVlcFxcbi0tLVxcblwiKTtcbiAgICBvcGVuVGVzdERiKGJhc2UpO1xuXG4gICAgY29uc3QgcHJvamVjdEZpeHR1cmUgPSBbXG4gICAgICBcIiMgUHJvamVjdFwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyMgV2hhdCBUaGlzIElzXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCJBIHJvb3QgcHJvamVjdCBhcnRpZmFjdC5cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIE1pbGVzdG9uZSBTZXF1ZW5jZVwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiLSBbIF0gTTAwMTogRm91bmRhdGlvbiAtIEVzdGFibGlzaCB0aGUgZmlyc3QgcnVubmFibGUgc2xpY2UuXCIsXG4gICAgICBcIlwiLFxuICAgIF0uam9pbihcIlxcblwiKTtcblxuICAgIGNvbnN0IGJsb2NrZWQgPSBhd2FpdCBpblByb2plY3REaXIoYmFzZSwgKCkgPT4gZXhlY3V0ZVN1bW1hcnlTYXZlKHtcbiAgICAgIGFydGlmYWN0X3R5cGU6IFwiUFJPSkVDVFwiLFxuICAgICAgY29udGVudDogcHJvamVjdEZpeHR1cmUsXG4gICAgfSwgYmFzZSkpO1xuXG4gICAgYXNzZXJ0LmVxdWFsKGJsb2NrZWQuaXNFcnJvciwgdHJ1ZSk7XG4gICAgYXNzZXJ0LmVxdWFsKGJsb2NrZWQuZGV0YWlscy5lcnJvciwgXCJyb290X2FydGlmYWN0X3dyaXRlX2Jsb2NrZWRcIik7XG4gICAgYXNzZXJ0Lm1hdGNoKGJsb2NrZWQuY29udGVudFswXS50ZXh0LCAvZmFpbC1jbG9zZWQvKTtcbiAgICBhc3NlcnQuZXF1YWwoZXhpc3RzU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIlBST0pFQ1QubWRcIikpLCBmYWxzZSk7XG5cbiAgICBtYXJrQXBwcm92YWxHYXRlVmVyaWZpZWQoXCJkZXB0aF92ZXJpZmljYXRpb25fcHJvamVjdF9jb25maXJtXCIsIGJhc2UpO1xuXG4gICAgY29uc3QgdW5ibG9ja2VkID0gYXdhaXQgaW5Qcm9qZWN0RGlyKGJhc2UsICgpID0+IGV4ZWN1dGVTdW1tYXJ5U2F2ZSh7XG4gICAgICBhcnRpZmFjdF90eXBlOiBcIlBST0pFQ1RcIixcbiAgICAgIGNvbnRlbnQ6IHByb2plY3RGaXh0dXJlLFxuICAgIH0sIGJhc2UpKTtcblxuICAgIGFzc2VydC5lcXVhbCh1bmJsb2NrZWQuaXNFcnJvciwgdW5kZWZpbmVkKTtcbiAgICBhc3NlcnQuZXF1YWwodW5ibG9ja2VkLmRldGFpbHMucGF0aCwgXCJQUk9KRUNULm1kXCIpO1xuICAgIGFzc2VydC5vayhleGlzdHNTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiUFJPSkVDVC5tZFwiKSkpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFyRGlzY3Vzc2lvbkZsb3dTdGF0ZShiYXNlKTtcbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJleGVjdXRlU3VtbWFyeVNhdmUgcmVuZGVycyBmaW5hbCBSRVFVSVJFTUVOVFMgZnJvbSB0aGUgREIgc291cmNlIG9mIHRydXRoXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgb3BlblRlc3REYihiYXNlKTtcbiAgICBtYXJrQXBwcm92YWxHYXRlVmVyaWZpZWQoXCJkZXB0aF92ZXJpZmljYXRpb25fcmVxdWlyZW1lbnRzX2NvbmZpcm1cIiwgYmFzZSk7XG5cbiAgICB1cHNlcnRSZXF1aXJlbWVudCh7XG4gICAgICBpZDogXCJSMDAxXCIsXG4gICAgICBjbGFzczogXCJwcmltYXJ5LXVzZXItbG9vcFwiLFxuICAgICAgc3RhdHVzOiBcImFjdGl2ZVwiLFxuICAgICAgZGVzY3JpcHRpb246IFwiVXNlciBjYW4gYWRkIGEgdGFza1wiLFxuICAgICAgd2h5OiBcIkNvcmUgbG9vcFwiLFxuICAgICAgc291cmNlOiBcInVzZXJcIixcbiAgICAgIHByaW1hcnlfb3duZXI6IFwiTTAwMS9ub25lIHlldFwiLFxuICAgICAgc3VwcG9ydGluZ19zbGljZXM6IFwibm9uZVwiLFxuICAgICAgdmFsaWRhdGlvbjogXCJ1bm1hcHBlZFwiLFxuICAgICAgbm90ZXM6IFwic2F2ZWQgdGhyb3VnaCByZXF1aXJlbWVudCB0b29sXCIsXG4gICAgICBmdWxsX2NvbnRlbnQ6IFwiXCIsXG4gICAgICBzdXBlcnNlZGVkX2J5OiBudWxsLFxuICAgIH0pO1xuXG4gICAgY29uc3QgcmVxdWlyZW1lbnRzUGF0aCA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiUkVRVUlSRU1FTlRTLm1kXCIpO1xuICAgIGNvbnN0IGJsb2F0ZWRNYXJrZG93biA9IFtcbiAgICAgIFwiIyBSZXF1aXJlbWVudHNcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIEFjdGl2ZVwiLFxuICAgICAgXCJcIixcbiAgICAgIC4uLkFycmF5LmZyb20oeyBsZW5ndGg6IDMwIH0sIChfLCBpKSA9PiBbXG4gICAgICAgIGAjIyMgUiR7U3RyaW5nKGkgKyAxMDApLnBhZFN0YXJ0KDMsIFwiMFwiKX0gXHUyMDE0IER1cGxpY2F0ZWAsXG4gICAgICAgIFwiLSBDbGFzczogcHJpbWFyeS11c2VyLWxvb3BcIixcbiAgICAgICAgXCItIFN0YXR1czogYWN0aXZlXCIsXG4gICAgICAgIFwiLSBEZXNjcmlwdGlvbjogRHVwbGljYXRlIHJldHJ5IHJvd1wiLFxuICAgICAgICBcIi0gV2h5IGl0IG1hdHRlcnM6IFJldHJ5IGRyaWZ0XCIsXG4gICAgICAgIFwiLSBTb3VyY2U6IHRlc3RcIixcbiAgICAgICAgXCItIFByaW1hcnkgb3duaW5nIHNsaWNlOiBNMDAxL25vbmUgeWV0XCIsXG4gICAgICAgIFwiLSBTdXBwb3J0aW5nIHNsaWNlczogbm9uZVwiLFxuICAgICAgICBcIi0gVmFsaWRhdGlvbjogdW5tYXBwZWRcIixcbiAgICAgICAgXCJcIixcbiAgICAgIF0uam9pbihcIlxcblwiKSksXG4gICAgXS5qb2luKFwiXFxuXCIpO1xuICAgIHdyaXRlRmlsZVN5bmMocmVxdWlyZW1lbnRzUGF0aCwgYmxvYXRlZE1hcmtkb3duKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGluUHJvamVjdERpcihiYXNlLCAoKSA9PiBleGVjdXRlU3VtbWFyeVNhdmUoe1xuICAgICAgYXJ0aWZhY3RfdHlwZTogXCJSRVFVSVJFTUVOVFNcIixcbiAgICAgIGNvbnRlbnQ6IFwiIyBSZXF1aXJlbWVudHNcXG5cXG4jIyBBY3RpdmVcXG5cXG4jIyMgUjk5OSBcdTIwMTQgV3JvbmcgbWFya2Rvd24gc291cmNlXFxuXFxuLSBEZXNjcmlwdGlvbjogVGhpcyBjb250ZW50IG11c3Qgbm90IGJlY29tZSBjYW5vbmljYWwuXFxuXCIsXG4gICAgfSwgYmFzZSkpO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5pc0Vycm9yLCB1bmRlZmluZWQpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuZGV0YWlscy5wYXRoLCBcIlJFUVVJUkVNRU5UUy5tZFwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmRldGFpbHMuY29udGVudF9zb3VyY2UsIFwicmVxdWlyZW1lbnRzX3RhYmxlXCIpO1xuXG4gICAgY29uc3QgY29udGVudCA9IHJlYWRGaWxlU3luYyhyZXF1aXJlbWVudHNQYXRoLCBcInV0Zi04XCIpO1xuICAgIGFzc2VydC5tYXRjaChjb250ZW50LCAvIyMjIFIwMDEgXHUyMDE0IFVzZXIgY2FuIGFkZCBhIHRhc2svKTtcbiAgICBhc3NlcnQubWF0Y2goY29udGVudCwgLyMjIFZhbGlkYXRlZC8pO1xuICAgIGFzc2VydC5tYXRjaChjb250ZW50LCAvIyMgRGVmZXJyZWQvKTtcbiAgICBhc3NlcnQubWF0Y2goY29udGVudCwgLyMjIE91dCBvZiBTY29wZS8pO1xuICAgIGFzc2VydC5kb2VzTm90TWF0Y2goY29udGVudCwgL1I5OTl8V3JvbmcgbWFya2Rvd24gc291cmNlfFRoaXMgY29udGVudCBtdXN0IG5vdCBiZWNvbWUgY2Fub25pY2FsLyk7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgQnVmZmVyLmJ5dGVMZW5ndGgoY29udGVudCwgXCJ1dGYtOFwiKSA8IEJ1ZmZlci5ieXRlTGVuZ3RoKGJsb2F0ZWRNYXJrZG93biwgXCJ1dGYtOFwiKSAqIDAuNSxcbiAgICAgIFwidGVzdCBzZXR1cCBwcm92ZXMgZmluYWwgREIgcHJvamVjdGlvbiBtYXkgYmUgbXVjaCBzbWFsbGVyIHRoYW4gYWNjdW11bGF0ZWQgcmV0cnkgb3V0cHV0XCIsXG4gICAgKTtcblxuICAgIGNvbnN0IGRiID0gX2dldEFkYXB0ZXIoKTtcbiAgICBjb25zdCByZXFSb3dzID0gZGIhXG4gICAgICAucHJlcGFyZShcIlNFTEVDVCBpZCwgZGVzY3JpcHRpb24gRlJPTSByZXF1aXJlbWVudHMgT1JERVIgQlkgaWRcIilcbiAgICAgIC5hbGwoKSBhcyBBcnJheTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj47XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICAgIHJlcVJvd3MubWFwKChyb3cpID0+IFtyb3cuaWQsIHJvdy5kZXNjcmlwdGlvbl0pLFxuICAgICAgW1tcIlIwMDFcIiwgXCJVc2VyIGNhbiBhZGQgYSB0YXNrXCJdXSxcbiAgICAgIFwic3VtbWFyeSBzYXZlIG11c3Qgbm90IHBhcnNlIG1hcmtkb3duIGJhY2sgaW50byByZXF1aXJlbWVudHMgcm93c1wiLFxuICAgICk7XG5cbiAgICBjb25zdCBhcnRpZmFjdCA9IGRiIVxuICAgICAgLnByZXBhcmUoXCJTRUxFQ1QgZnVsbF9jb250ZW50IEZST00gYXJ0aWZhY3RzIFdIRVJFIHBhdGggPSA/XCIpXG4gICAgICAuZ2V0KFwiUkVRVUlSRU1FTlRTLm1kXCIpIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIGFzc2VydC5lcXVhbChhcnRpZmFjdC5mdWxsX2NvbnRlbnQsIGNvbnRlbnQpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFyRGlzY3Vzc2lvbkZsb3dTdGF0ZShiYXNlKTtcbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJleGVjdXRlU3VtbWFyeVNhdmUgcmVqZWN0cyBmaW5hbCBSRVFVSVJFTUVOVFMgd2hlbiB0aGUgREIgc291cmNlIGlzIGVtcHR5XCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgb3BlblRlc3REYihiYXNlKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGluUHJvamVjdERpcihiYXNlLCAoKSA9PiBleGVjdXRlU3VtbWFyeVNhdmUoe1xuICAgICAgYXJ0aWZhY3RfdHlwZTogXCJSRVFVSVJFTUVOVFNcIixcbiAgICAgIGNvbnRlbnQ6IFwiIyBSZXF1aXJlbWVudHNcXG5cXG4jIyBBY3RpdmVcXG5cXG5cIixcbiAgICB9LCBiYXNlKSk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmlzRXJyb3IsIHRydWUpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuZGV0YWlscy5lcnJvciwgXCJub19hY3RpdmVfcmVxdWlyZW1lbnRzXCIpO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQuY29udGVudFswXS50ZXh0LCAvbm8gYWN0aXZlIHJlcXVpcmVtZW50cyBmb3VuZC8pO1xuICB9IGZpbmFsbHkge1xuICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcImV4ZWN1dGVTdW1tYXJ5U2F2ZSByZWplY3RzIG1pbGVzdG9uZS1zY29wZWQgYXJ0aWZhY3RzIHdpdGhvdXQgbWlsZXN0b25lX2lkXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgb3BlblRlc3REYihiYXNlKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGluUHJvamVjdERpcihiYXNlLCAoKSA9PiBleGVjdXRlU3VtbWFyeVNhdmUoe1xuICAgICAgYXJ0aWZhY3RfdHlwZTogXCJDT05URVhUXCIsXG4gICAgICBjb250ZW50OiBcIiMgQ29udGV4dFxcblwiLFxuICAgIH0sIGJhc2UpKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmlzRXJyb3IsIHRydWUpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuZGV0YWlscy5lcnJvciwgXCJtaXNzaW5nX21pbGVzdG9uZV9pZFwiKTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LmNvbnRlbnRbMF0udGV4dCwgL21pbGVzdG9uZV9pZCBpcyByZXF1aXJlZC8pO1xuICB9IGZpbmFsbHkge1xuICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcImV4ZWN1dGVTdW1tYXJ5U2F2ZSByZW1vdmVzIHNpYmxpbmcgQ09OVEVYVC1EUkFGVCB3aGVuIHdyaXRpbmcgc2xpY2UgQ09OVEVYVCAoIzQ0NDIpXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgb3BlblRlc3REYihiYXNlKTtcblxuICAgIGNvbnN0IHNsaWNlRGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMVwiKTtcbiAgICBta2RpclN5bmMoc2xpY2VEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIGNvbnN0IGRyYWZ0UGF0aCA9IGpvaW4oc2xpY2VEaXIsIFwiUzAxLUNPTlRFWFQtRFJBRlQubWRcIik7XG4gICAgd3JpdGVGaWxlU3luYyhkcmFmdFBhdGgsIFwiIyBTbGljZSBEcmFmdFxcblxcbmluY3JlbWVudGFsIHNsaWNlIG5vdGVzXCIpO1xuICAgIGFzc2VydC5vayhleGlzdHNTeW5jKGRyYWZ0UGF0aCksIFwicHJlY29uZGl0aW9uOiBzbGljZSBkcmFmdCBleGlzdHNcIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBpblByb2plY3REaXIoYmFzZSwgKCkgPT4gZXhlY3V0ZVN1bW1hcnlTYXZlKHtcbiAgICAgIG1pbGVzdG9uZV9pZDogXCJNMDAxXCIsXG4gICAgICBzbGljZV9pZDogXCJTMDFcIixcbiAgICAgIGFydGlmYWN0X3R5cGU6IFwiQ09OVEVYVFwiLFxuICAgICAgY29udGVudDogXCIjIFNsaWNlIENvbnRleHRcXG5cXG5maW5hbCBzbGljZSBvdXRwdXRcIixcbiAgICB9LCBiYXNlKSk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmRldGFpbHMub3BlcmF0aW9uLCBcInNhdmVfc3VtbWFyeVwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmRldGFpbHMuYXJ0aWZhY3RfdHlwZSwgXCJDT05URVhUXCIpO1xuXG4gICAgY29uc3QgY29udGV4dFBhdGggPSBqb2luKHNsaWNlRGlyLCBcIlMwMS1DT05URVhULm1kXCIpO1xuICAgIGFzc2VydC5vayhleGlzdHNTeW5jKGNvbnRleHRQYXRoKSwgXCJzbGljZSBDT05URVhULm1kIHNob3VsZCBiZSB3cml0dGVuXCIpO1xuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIGV4aXN0c1N5bmMoZHJhZnRQYXRoKSxcbiAgICAgIGZhbHNlLFxuICAgICAgXCJzbGljZSBDT05URVhULURSQUZULm1kIHNob3VsZCBiZSByZW1vdmVkIGFmdGVyIGZpbmFsIENPTlRFWFQubWQgaXMgd3JpdHRlblwiLFxuICAgICk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZXhlY3V0ZVN1bW1hcnlTYXZlIGxlYXZlcyBzaWJsaW5nIENPTlRFWFQtRFJBRlQgaW50YWN0IGZvciBub24tQ09OVEVYVCBhcnRpZmFjdHMgKCM0NDQyKVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIG9wZW5UZXN0RGIoYmFzZSk7XG5cbiAgICBjb25zdCBtaWxlc3RvbmVEaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIpO1xuICAgIG1rZGlyU3luYyhtaWxlc3RvbmVEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIGNvbnN0IGRyYWZ0UGF0aCA9IGpvaW4obWlsZXN0b25lRGlyLCBcIk0wMDEtQ09OVEVYVC1EUkFGVC5tZFwiKTtcbiAgICB3cml0ZUZpbGVTeW5jKGRyYWZ0UGF0aCwgXCIjIERyYWZ0XFxuXFxuc3RpbGwgaW4gcHJvZ3Jlc3NcIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBpblByb2plY3REaXIoYmFzZSwgKCkgPT4gZXhlY3V0ZVN1bW1hcnlTYXZlKHtcbiAgICAgIG1pbGVzdG9uZV9pZDogXCJNMDAxXCIsXG4gICAgICBhcnRpZmFjdF90eXBlOiBcIlJFU0VBUkNIXCIsXG4gICAgICBjb250ZW50OiBcIiMgUmVzZWFyY2hcXG5cXG5yZXNlYXJjaCBub3Rlc1wiLFxuICAgIH0sIGJhc2UpKTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuZGV0YWlscy5hcnRpZmFjdF90eXBlLCBcIlJFU0VBUkNIXCIpO1xuICAgIGFzc2VydC5vayhcbiAgICAgIGV4aXN0c1N5bmMoZHJhZnRQYXRoKSxcbiAgICAgIFwiQ09OVEVYVC1EUkFGVC5tZCBtdXN0IHN1cnZpdmUgUkVTRUFSQ0gvU1VNTUFSWS9BU1NFU1NNRU5UIHdyaXRlc1wiLFxuICAgICk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZXhlY3V0ZVN1bW1hcnlTYXZlIENPTlRFWFQgSEFSRCBCTE9DSyBjbGVhcnMgYWZ0ZXIgd3JpdGUtZ2F0ZSBzdGF0ZSBmaWxlIGlzIGRlbGV0ZWQgKCM0MzQzKVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICBjb25zdCBvcmlnaW5hbEVudiA9IHByb2Nlc3MuZW52LkdTRF9QRVJTSVNUX1dSSVRFX0dBVEVfU1RBVEU7XG4gIHByb2Nlc3MuZW52LkdTRF9QRVJTSVNUX1dSSVRFX0dBVEVfU1RBVEUgPSBcIjFcIjtcbiAgdHJ5IHtcbiAgICBvcGVuVGVzdERiKGJhc2UpO1xuICAgIGNsZWFyRGlzY3Vzc2lvbkZsb3dTdGF0ZShiYXNlKTtcblxuICAgIC8vIEZpcnN0IGNhbGw6IENPTlRFWFQgYXJ0aWZhY3Qgd2l0aG91dCBkZXB0aCB2ZXJpZmljYXRpb24gXHUyMTkyIEhBUkQgQkxPQ0tcbiAgICBjb25zdCBibG9ja2VkID0gYXdhaXQgaW5Qcm9qZWN0RGlyKGJhc2UsICgpID0+IGV4ZWN1dGVTdW1tYXJ5U2F2ZSh7XG4gICAgICBtaWxlc3RvbmVfaWQ6IFwiTTAwMVwiLFxuICAgICAgYXJ0aWZhY3RfdHlwZTogXCJDT05URVhUXCIsXG4gICAgICBjb250ZW50OiBcIiMgQ29udGV4dFxcblxcbmNvbnRlbnRcIixcbiAgICB9LCBiYXNlKSk7XG4gICAgYXNzZXJ0LmVxdWFsKGJsb2NrZWQuaXNFcnJvciwgdHJ1ZSwgXCJzaG91bGQgYmUgYmxvY2tlZCB3aXRob3V0IGRlcHRoIHZlcmlmaWNhdGlvblwiKTtcbiAgICBhc3NlcnQubWF0Y2goXG4gICAgICBibG9ja2VkLmNvbnRlbnRbMF0udGV4dCxcbiAgICAgIC9IQVJEIEJMT0NLLyxcbiAgICAgIFwiYmxvY2tlZCByZXN1bHQgc2hvdWxkIG1lbnRpb24gSEFSRCBCTE9DS1wiLFxuICAgICk7XG5cbiAgICAvLyBWZXJpZnkgdGhlIHN0YXRlIGZpbGUgd2FzIHdyaXR0ZW4gKHBlcnNpc3QgbW9kZSBpcyBhY3RpdmUpXG4gICAgY29uc3Qgc3RhdGVGaWxlUGF0aCA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwicnVudGltZVwiLCBcIndyaXRlLWdhdGUtc3RhdGUuanNvblwiKTtcbiAgICAvLyBUaGUgc3RhdGUgZmlsZSBtYXkgb3IgbWF5IG5vdCBleGlzdCBhdCB0aGlzIHBvaW50IChibG9jayBkb2Vzbid0IHdyaXRlIHN0YXRlKS5cbiAgICAvLyBXcml0ZSBhIGZha2Ugc3RhdGUgZmlsZSBzaW11bGF0aW5nIHN0YWxlIHBlcnNpc3RlZCBibG9jayBzdGF0ZS5cbiAgICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJydW50aW1lXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKHN0YXRlRmlsZVBhdGgsIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgIHZlcmlmaWVkRGVwdGhNaWxlc3RvbmVzOiBbXSxcbiAgICAgIGFjdGl2ZVF1ZXVlUGhhc2U6IGZhbHNlLFxuICAgICAgcGVuZGluZ0dhdGVJZDogXCJkZXB0aF92ZXJpZmljYXRpb25fTTAwMVwiLFxuICAgIH0pKTtcblxuICAgIC8vIFVzZXIgZGVsZXRlcyB0aGUgc3RhdGUgZmlsZSB0byByZXNldCB0aGUgYmxvY2tcbiAgICB1bmxpbmtTeW5jKHN0YXRlRmlsZVBhdGgpO1xuICAgIGFzc2VydC5vayghZXhpc3RzU3luYyhzdGF0ZUZpbGVQYXRoKSwgXCJzdGF0ZSBmaWxlIGRlbGV0ZWRcIik7XG5cbiAgICAvLyBUaGUgc25hcHNob3QgbG9hZGVkIGFmdGVyIGRlbGV0aW9uIHNob3VsZCBiZSBjbGVhbiAobm8gcGVuZGluZyBnYXRlLCBubyBibG9jaylcbiAgICBjb25zdCBzbmFwc2hvdCA9IGxvYWRXcml0ZUdhdGVTbmFwc2hvdChiYXNlKTtcbiAgICBhc3NlcnQuZXF1YWwoc25hcHNob3QucGVuZGluZ0dhdGVJZCwgbnVsbCwgXCJwZW5kaW5nR2F0ZUlkIHNob3VsZCBiZSBudWxsIGFmdGVyIGZpbGUgZGVsZXRpb25cIik7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChzbmFwc2hvdC52ZXJpZmllZERlcHRoTWlsZXN0b25lcywgW10sIFwidmVyaWZpZWREZXB0aE1pbGVzdG9uZXMgc2hvdWxkIGJlIGVtcHR5IGFmdGVyIGZpbGUgZGVsZXRpb25cIik7XG5cbiAgICAvLyBEZXB0aC12ZXJpZnkgYW5kIHJlLWF0dGVtcHQ6IHNob3VsZCBzdWNjZWVkIGFmdGVyIGRlbGV0aW9uIGNsZWFycyBzdGFsZSBzdGF0ZVxuICAgIG1hcmtEZXB0aFZlcmlmaWVkKFwiTTAwMVwiLCBiYXNlKTtcblxuICAgIGNvbnN0IHVuYmxvY2tlZCA9IGF3YWl0IGluUHJvamVjdERpcihiYXNlLCAoKSA9PiBleGVjdXRlU3VtbWFyeVNhdmUoe1xuICAgICAgbWlsZXN0b25lX2lkOiBcIk0wMDFcIixcbiAgICAgIGFydGlmYWN0X3R5cGU6IFwiQ09OVEVYVFwiLFxuICAgICAgY29udGVudDogXCIjIENvbnRleHRcXG5cXG5maW5hbCBjb250ZW50XCIsXG4gICAgfSwgYmFzZSkpO1xuICAgIGFzc2VydC5lcXVhbCh1bmJsb2NrZWQuaXNFcnJvciwgdW5kZWZpbmVkLCBcInNob3VsZCBub3QgYmUgYmxvY2tlZCBhZnRlciBkZXB0aCB2ZXJpZmljYXRpb25cIik7XG4gICAgYXNzZXJ0LmVxdWFsKHVuYmxvY2tlZC5kZXRhaWxzLm9wZXJhdGlvbiwgXCJzYXZlX3N1bW1hcnlcIik7XG4gIH0gZmluYWxseSB7XG4gICAgaWYgKG9yaWdpbmFsRW52ID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGRlbGV0ZSBwcm9jZXNzLmVudi5HU0RfUEVSU0lTVF9XUklURV9HQVRFX1NUQVRFO1xuICAgIH0gZWxzZSB7XG4gICAgICBwcm9jZXNzLmVudi5HU0RfUEVSU0lTVF9XUklURV9HQVRFX1NUQVRFID0gb3JpZ2luYWxFbnY7XG4gICAgfVxuICAgIGNsZWFyRGlzY3Vzc2lvbkZsb3dTdGF0ZShiYXNlKTtcbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxPQUFPLFVBQVU7QUFDakIs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
