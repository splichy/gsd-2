import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  insertArtifact,
  getArtifact,
  getAllMilestones,
  getMilestoneSlices,
  _getAdapter
} from "../gsd-db.js";
import {
  renderRoadmapCheckboxes,
  renderPlanCheckboxes,
  renderTaskSummary,
  renderSliceSummary,
  renderAllFromDb,
  renderPlanFromDb,
  renderTaskPlanFromDb,
  detectStaleRenders
} from "../markdown-renderer.js";
import { repairStaleRenders } from "../state-reconciliation/drift/stale-render.js";
import {
  parseRoadmap,
  parsePlan
} from "../parsers-legacy.js";
import {
  parseSummary,
  parseTaskPlanFile,
  clearParseCache
} from "../files.js";
import { clearPathCache, _clearGsdRootCache } from "../paths.js";
import { invalidateStateCache } from "../state.js";
import { test } from "node:test";
import assert from "node:assert/strict";
function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-renderer-"));
  fs.mkdirSync(path.join(dir, ".gsd"), { recursive: true });
  return dir;
}
function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
  }
}
function clearAllCaches() {
  clearParseCache();
  clearPathCache();
  _clearGsdRootCache();
  invalidateStateCache();
}
function scaffoldDirs(tmpDir, mid, sliceIds) {
  const msDir = path.join(tmpDir, ".gsd", "milestones", mid);
  fs.mkdirSync(msDir, { recursive: true });
  for (const sid of sliceIds) {
    const sliceDir = path.join(msDir, "slices", sid);
    fs.mkdirSync(path.join(sliceDir, "tasks"), { recursive: true });
  }
}
function makeRoadmapContent(slices) {
  const lines = [];
  lines.push("# M001 Roadmap");
  lines.push("");
  lines.push("**Vision:** Test milestone");
  lines.push("");
  lines.push("## Slices");
  lines.push("");
  for (const s of slices) {
    const checkbox = s.done ? "[x]" : "[ ]";
    lines.push(`- ${checkbox} **${s.id}: ${s.title}** \`risk:medium\` \`depends:[]\``);
  }
  lines.push("");
  return lines.join("\n");
}
function makePlanContent(sliceId, tasks) {
  const lines = [];
  lines.push(`# ${sliceId}: Test Slice`);
  lines.push("");
  lines.push("**Goal:** Test slice goal");
  lines.push("**Demo:** Test demo");
  lines.push("");
  lines.push("## Must-Haves");
  lines.push("");
  lines.push("- Everything works");
  lines.push("");
  lines.push("## Tasks");
  lines.push("");
  for (const t of tasks) {
    const checkbox = t.done ? "[x]" : "[ ]";
    lines.push(`- ${checkbox} **${t.id}: ${t.title}** \`est:1h\``);
  }
  lines.push("");
  return lines.join("\n");
}
function makeTaskSummaryContent(taskId) {
  return [
    "---",
    `id: ${taskId}`,
    "parent: S01",
    "milestone: M001",
    "duration: 45m",
    "verification_result: all-pass",
    `completed_at: ${(/* @__PURE__ */ new Date()).toISOString()}`,
    "blocker_discovered: false",
    "provides: []",
    "requires: []",
    "affects: []",
    "key_files:",
    "  - src/test.ts",
    "key_decisions: []",
    "patterns_established: []",
    "drill_down_paths: []",
    "observability_surfaces: []",
    "---",
    "",
    `# ${taskId}: Test Task Summary`,
    "",
    "**Implemented test functionality**",
    "",
    "## What Happened",
    "",
    "Built the test feature.",
    "",
    "## Deviations",
    "",
    "None.",
    "",
    "## Files Created/Modified",
    "",
    "- `src/test.ts` \u2014 main implementation",
    "",
    "## Verification Evidence",
    "",
    "| Command | Exit | Verdict | Duration |",
    "|---------|------|---------|----------|",
    "| `npm test` | 0 | \u2705 pass | 2.1s |",
    ""
  ].join("\n");
}
test("\u2500\u2500 markdown-renderer: DB accessor basics \u2500\u2500", () => {
  openDatabase(":memory:");
  const empty = getAllMilestones();
  assert.deepStrictEqual(empty.length, 0, "getAllMilestones returns empty when no milestones");
  insertMilestone({ id: "M001", title: "Test MS", status: "active" });
  insertMilestone({ id: "M002", title: "Second MS", status: "active" });
  const all = getAllMilestones();
  assert.deepStrictEqual(all.length, 2, "getAllMilestones returns 2 milestones");
  assert.deepStrictEqual(all[0].id, "M001", "first milestone is M001");
  assert.deepStrictEqual(all[1].id, "M002", "second milestone is M002");
  assert.deepStrictEqual(all[0].title, "Test MS", "milestone title correct");
  assert.deepStrictEqual(all[0].status, "active", "milestone status correct");
  const noSlices = getMilestoneSlices("M001");
  assert.deepStrictEqual(noSlices.length, 0, "getMilestoneSlices returns empty when no slices");
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice 1", status: "complete" });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Slice 2", status: "pending" });
  insertSlice({ id: "S01", milestoneId: "M002", title: "M2 Slice", status: "pending" });
  const m1Slices = getMilestoneSlices("M001");
  assert.deepStrictEqual(m1Slices.length, 2, "M001 has 2 slices");
  assert.deepStrictEqual(m1Slices[0].id, "S01", "first slice is S01");
  assert.deepStrictEqual(m1Slices[0].status, "complete", "S01 status is complete");
  assert.deepStrictEqual(m1Slices[1].id, "S02", "second slice is S02");
  assert.deepStrictEqual(m1Slices[1].status, "pending", "S02 status is pending");
  const m2Slices = getMilestoneSlices("M002");
  assert.deepStrictEqual(m2Slices.length, 1, "M002 has 1 slice");
  closeDatabase();
});
test("\u2500\u2500 markdown-renderer: getArtifact accessor \u2500\u2500", () => {
  openDatabase(":memory:");
  const missing = getArtifact("nonexistent/path");
  assert.deepStrictEqual(missing, null, "getArtifact returns null for missing path");
  insertArtifact({
    path: "milestones/M001/M001-ROADMAP.md",
    artifact_type: "ROADMAP",
    milestone_id: "M001",
    slice_id: null,
    task_id: null,
    full_content: "# Roadmap content"
  });
  const found = getArtifact("milestones/M001/M001-ROADMAP.md");
  assert.ok(found !== null, "getArtifact returns non-null for existing path");
  assert.deepStrictEqual(found.artifact_type, "ROADMAP", "artifact type correct");
  assert.deepStrictEqual(found.milestone_id, "M001", "milestone_id correct");
  assert.deepStrictEqual(found.full_content, "# Roadmap content", "content correct");
  closeDatabase();
});
test("\u2500\u2500 markdown-renderer: renderRoadmapCheckboxes round-trip \u2500\u2500", async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, ".gsd", "gsd.db");
  openDatabase(dbPath);
  clearAllCaches();
  try {
    scaffoldDirs(tmpDir, "M001", ["S01", "S02"]);
    insertMilestone({ id: "M001", title: "Test", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Core setup", status: "complete" });
    insertSlice({ id: "S02", milestoneId: "M001", title: "Rendering", status: "pending" });
    const roadmapContent = makeRoadmapContent([
      { id: "S01", title: "Core setup", done: false },
      { id: "S02", title: "Rendering", done: false }
    ]);
    const roadmapPath = path.join(tmpDir, ".gsd", "milestones", "M001", "M001-ROADMAP.md");
    fs.writeFileSync(roadmapPath, roadmapContent);
    clearAllCaches();
    const ok = await renderRoadmapCheckboxes(tmpDir, "M001");
    assert.ok(ok, "renderRoadmapCheckboxes returns true");
    const rendered = fs.readFileSync(roadmapPath, "utf-8");
    clearAllCaches();
    const parsed = parseRoadmap(rendered);
    assert.deepStrictEqual(parsed.slices.length, 2, "roadmap has 2 slices after render");
    const s01 = parsed.slices.find((s) => s.id === "S01");
    const s02 = parsed.slices.find((s) => s.id === "S02");
    assert.ok(!!s01, "S01 found in parsed roadmap");
    assert.ok(!!s02, "S02 found in parsed roadmap");
    assert.ok(s01.done, "S01 is checked (done) after render");
    assert.ok(!s02.done, "S02 is unchecked (pending) after render");
    const artifact = getArtifact("milestones/M001/M001-ROADMAP.md");
    assert.ok(artifact !== null, "roadmap artifact stored in DB after render");
    assert.ok(artifact.full_content.includes("[x] **S01:"), "DB artifact has S01 checked");
    assert.ok(artifact.full_content.includes("[ ] **S02:"), "DB artifact has S02 unchecked");
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});
test("\u2500\u2500 markdown-renderer: renderRoadmapCheckboxes bidirectional \u2500\u2500", async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, ".gsd", "gsd.db");
  openDatabase(dbPath);
  clearAllCaches();
  try {
    scaffoldDirs(tmpDir, "M001", ["S01", "S02"]);
    insertMilestone({ id: "M001", title: "Test", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Core setup", status: "pending" });
    insertSlice({ id: "S02", milestoneId: "M001", title: "Rendering", status: "complete" });
    const roadmapContent = makeRoadmapContent([
      { id: "S01", title: "Core setup", done: true },
      { id: "S02", title: "Rendering", done: false }
    ]);
    const roadmapPath = path.join(tmpDir, ".gsd", "milestones", "M001", "M001-ROADMAP.md");
    fs.writeFileSync(roadmapPath, roadmapContent);
    clearAllCaches();
    const ok = await renderRoadmapCheckboxes(tmpDir, "M001");
    assert.ok(ok, "bidirectional render returns true");
    const rendered = fs.readFileSync(roadmapPath, "utf-8");
    clearAllCaches();
    const parsed = parseRoadmap(rendered);
    const s01 = parsed.slices.find((s) => s.id === "S01");
    const s02 = parsed.slices.find((s) => s.id === "S02");
    assert.ok(!s01.done, "S01 unchecked (DB says pending, was checked on disk)");
    assert.ok(s02.done, "S02 checked (DB says complete, was unchecked on disk)");
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});
test("\u2500\u2500 markdown-renderer: renderPlanCheckboxes round-trip \u2500\u2500", async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, ".gsd", "gsd.db");
  openDatabase(dbPath);
  clearAllCaches();
  try {
    scaffoldDirs(tmpDir, "M001", ["S01"]);
    insertMilestone({ id: "M001", title: "Test", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "First task", status: "done" });
    insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Second task", status: "done" });
    insertTask({ id: "T03", sliceId: "S01", milestoneId: "M001", title: "Third task", status: "pending" });
    const planContent = makePlanContent("S01", [
      { id: "T01", title: "First task", done: false },
      { id: "T02", title: "Second task", done: false },
      { id: "T03", title: "Third task", done: false }
    ]);
    const planPath = path.join(tmpDir, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md");
    fs.writeFileSync(planPath, planContent);
    clearAllCaches();
    const ok = await renderPlanCheckboxes(tmpDir, "M001", "S01");
    assert.ok(ok, "renderPlanCheckboxes returns true");
    const rendered = fs.readFileSync(planPath, "utf-8");
    clearAllCaches();
    const parsed = parsePlan(rendered);
    assert.deepStrictEqual(parsed.tasks.length, 3, "plan has 3 tasks after render");
    const t01 = parsed.tasks.find((t) => t.id === "T01");
    const t02 = parsed.tasks.find((t) => t.id === "T02");
    const t03 = parsed.tasks.find((t) => t.id === "T03");
    assert.ok(t01.done, "T01 checked (done in DB)");
    assert.ok(t02.done, "T02 checked (done in DB)");
    assert.ok(!t03.done, "T03 unchecked (pending in DB)");
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});
test("\u2500\u2500 markdown-renderer: renderPlanCheckboxes bidirectional \u2500\u2500", async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, ".gsd", "gsd.db");
  openDatabase(dbPath);
  clearAllCaches();
  try {
    scaffoldDirs(tmpDir, "M001", ["S01"]);
    insertMilestone({ id: "M001", title: "Test", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "First task", status: "pending" });
    insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Second task", status: "done" });
    const planContent = makePlanContent("S01", [
      { id: "T01", title: "First task", done: true },
      // checked but DB says pending
      { id: "T02", title: "Second task", done: false }
      // unchecked but DB says done
    ]);
    const planPath = path.join(tmpDir, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md");
    fs.writeFileSync(planPath, planContent);
    clearAllCaches();
    const ok = await renderPlanCheckboxes(tmpDir, "M001", "S01");
    assert.ok(ok, "bidirectional plan render returns true");
    const rendered = fs.readFileSync(planPath, "utf-8");
    clearAllCaches();
    const parsed = parsePlan(rendered);
    const t01 = parsed.tasks.find((t) => t.id === "T01");
    const t02 = parsed.tasks.find((t) => t.id === "T02");
    assert.ok(!t01.done, "T01 unchecked (DB says pending, was checked)");
    assert.ok(t02.done, "T02 checked (DB says done, was unchecked)");
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});
test("\u2500\u2500 markdown-renderer: renderPlanFromDb creates parse-compatible slice plan + task plan files \u2500\u2500", async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, ".gsd", "gsd.db");
  openDatabase(dbPath);
  clearAllCaches();
  try {
    scaffoldDirs(tmpDir, "M001", ["S02"]);
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    insertSlice({
      id: "S02",
      milestoneId: "M001",
      title: "DB-backed planning",
      status: "pending",
      demo: "Rendered plans exist on disk.",
      planning: {
        goal: "Render slice plans from DB state.",
        successCriteria: "- Slice plan stays parse-compatible\n- Task plan files are regenerated",
        proofLevel: "integration",
        integrationClosure: "Wires DB planning rows to markdown artifacts.",
        observabilityImpact: "- Run renderer contract tests\n- Inspect stale-render diagnostics on mismatch"
      }
    });
    insertTask({
      id: "T01",
      sliceId: "S02",
      milestoneId: "M001",
      title: "Render slice plan",
      status: "pending",
      planning: {
        description: "Implement the DB-backed slice plan renderer.",
        estimate: "45m",
        files: ["src/resources/extensions/gsd/markdown-renderer.ts"],
        verify: "node --test markdown-renderer.test.ts",
        inputs: ["src/resources/extensions/gsd/markdown-renderer.ts"],
        expectedOutput: ["src/resources/extensions/gsd/tests/markdown-renderer.test.ts"],
        observabilityImpact: "Renderer tests cover stale render failure paths."
      }
    });
    insertTask({
      id: "T02",
      sliceId: "S02",
      milestoneId: "M001",
      title: "Render task plan",
      status: "pending",
      planning: {
        description: "Emit the task plan file with conservative frontmatter.",
        estimate: "30m",
        files: ["src/resources/extensions/gsd/files.ts"],
        verify: "node --test auto-recovery.test.ts",
        inputs: ["src/resources/extensions/gsd/files.ts"],
        expectedOutput: ["src/resources/extensions/gsd/tests/auto-recovery.test.ts"],
        observabilityImpact: "Missing task-plan files fail recovery verification."
      }
    });
    const rendered = await renderPlanFromDb(tmpDir, "M001", "S02");
    assert.ok(fs.existsSync(rendered.planPath), "slice plan written to disk");
    assert.strictEqual(rendered.taskPlanPaths.length, 2, "task plan paths returned for each task");
    assert.ok(rendered.taskPlanPaths.every((p) => fs.existsSync(p)), "all task plan files written to disk");
    const planContent = fs.readFileSync(rendered.planPath, "utf-8");
    clearAllCaches();
    const parsedPlan = parsePlan(planContent);
    assert.strictEqual(parsedPlan.id, "S02", "rendered slice plan parses with correct slice id");
    assert.strictEqual(parsedPlan.goal, "Render slice plans from DB state.", "rendered slice plan preserves goal");
    assert.strictEqual(parsedPlan.demo, "Rendered plans exist on disk.", "rendered slice plan preserves demo");
    assert.strictEqual(parsedPlan.mustHaves.length, 2, "rendered slice plan exposes must-haves");
    assert.strictEqual(parsedPlan.tasks.length, 2, "rendered slice plan exposes all tasks");
    assert.strictEqual(parsedPlan.tasks[0].id, "T01", "first task parses correctly");
    assert.ok(parsedPlan.tasks[0].description.includes("DB-backed slice plan renderer"), "task description preserved in slice plan");
    assert.strictEqual(parsedPlan.tasks[0].files?.[0], "src/resources/extensions/gsd/markdown-renderer.ts", "files list preserved in slice plan");
    assert.strictEqual(parsedPlan.tasks[0].verify, "node --test markdown-renderer.test.ts", "verify line preserved in slice plan");
    const planArtifact = getArtifact("milestones/M001/slices/S02/S02-PLAN.md");
    assert.ok(planArtifact !== null, "slice plan artifact stored in DB");
    assert.ok(planArtifact.full_content.includes("## Tasks"), "stored plan artifact contains task section");
    const taskPlanPath = path.join(tmpDir, ".gsd", "milestones", "M001", "slices", "S02", "tasks", "T01-PLAN.md");
    const taskPlanContent = fs.readFileSync(taskPlanPath, "utf-8");
    const taskPlanFile = parseTaskPlanFile(taskPlanContent);
    assert.strictEqual(taskPlanFile.frontmatter.estimated_steps, 1, "task plan frontmatter exposes estimated_steps");
    assert.strictEqual(taskPlanFile.frontmatter.estimated_files, 1, "task plan frontmatter exposes estimated_files");
    assert.strictEqual(taskPlanFile.frontmatter.skills_used.length, 0, "task plan frontmatter uses conservative empty skills list");
    assert.match(taskPlanContent, /^# T01: Render slice plan/m, "task plan renders task heading");
    assert.match(taskPlanContent, /^## Inputs$/m, "task plan renders Inputs section");
    assert.match(taskPlanContent, /^## Expected Output$/m, "task plan renders Expected Output section");
    assert.match(taskPlanContent, /^## Verification$/m, "task plan renders Verification section");
    const taskArtifact = getArtifact("milestones/M001/slices/S02/tasks/T01-PLAN.md");
    assert.ok(taskArtifact !== null, "task plan artifact stored in DB");
    assert.ok(taskArtifact.full_content.includes("skills_used: []"), "stored task plan artifact preserves conservative skills_used");
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});
test("\u2500\u2500 markdown-renderer: slice plan summarizes task descriptions without leaking nested headings \u2500\u2500", async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, ".gsd", "gsd.db");
  openDatabase(dbPath);
  clearAllCaches();
  try {
    scaffoldDirs(tmpDir, "M001", ["S01"]);
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      title: "Working app",
      status: "pending",
      demo: "The app works.",
      planning: {
        goal: "Build a small app.",
        successCriteria: "Not provided.",
        proofLevel: "Not provided.",
        integrationClosure: "N/A",
        observabilityImpact: "None"
      }
    });
    insertTask({
      id: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      title: "Build app",
      status: "pending",
      planning: {
        description: [
          "Create the static app files.",
          "",
          "## Steps",
          "",
          "- Create the HTML shell.",
          "- Wire browser storage.",
          "",
          "## Must-Haves",
          "",
          "- Adding an item updates the list."
        ].join("\n"),
        estimate: "30m",
        files: ["index.html", "app.js", "style.css"],
        verify: "open index.html",
        inputs: [".gitignore"],
        expectedOutput: ["index.html", "app.js", "style.css"]
      }
    });
    const rendered = await renderPlanFromDb(tmpDir, "M001", "S01");
    const planContent = fs.readFileSync(rendered.planPath, "utf-8");
    clearAllCaches();
    const parsedPlan = parsePlan(planContent);
    assert.doesNotMatch(planContent, /Not provided/i, "placeholder values should not render");
    assert.doesNotMatch(planContent, /^## Steps$/m, "task detail headings must not escape into the slice plan");
    assert.strictEqual((planContent.match(/^## Must-Haves$/gm) ?? []).length, 1, "slice plan has only its own Must-Haves heading");
    assert.strictEqual(parsedPlan.tasks[0].description.trim(), "Create the static app files.");
    const taskPlanContent = fs.readFileSync(path.join(tmpDir, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-PLAN.md"), "utf-8");
    assert.match(taskPlanContent, /^## Steps$/m, "task plan keeps detailed headings for executors");
    assert.match(taskPlanContent, /^## Must-Haves$/m, "task plan keeps detailed task must-haves");
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});
test("\u2500\u2500 markdown-renderer: renderTaskPlanFromDb throws for missing task \u2500\u2500", async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, ".gsd", "gsd.db");
  openDatabase(dbPath);
  clearAllCaches();
  try {
    scaffoldDirs(tmpDir, "M001", ["S02"]);
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    insertSlice({ id: "S02", milestoneId: "M001", title: "Slice", status: "pending" });
    let threw = false;
    try {
      await renderTaskPlanFromDb(tmpDir, "M001", "S02", "T99");
    } catch (error) {
      threw = true;
      assert.match(String(error.message), /task M001\/S02\/T99 not found/, "renderTaskPlanFromDb should fail clearly when task row is missing");
    }
    assert.ok(threw, "renderTaskPlanFromDb throws when the task row is missing");
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});
test("\u2500\u2500 markdown-renderer: renderTaskSummary round-trip \u2500\u2500", async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, ".gsd", "gsd.db");
  openDatabase(dbPath);
  clearAllCaches();
  try {
    scaffoldDirs(tmpDir, "M001", ["S01"]);
    insertMilestone({ id: "M001", title: "Test", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
    const summaryContent = makeTaskSummaryContent("T01");
    insertTask({
      id: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      title: "Test Task",
      status: "done",
      fullSummaryMd: summaryContent
    });
    const ok = await renderTaskSummary(tmpDir, "M001", "S01", "T01");
    assert.ok(ok, "renderTaskSummary returns true");
    const summaryPath = path.join(
      tmpDir,
      ".gsd",
      "milestones",
      "M001",
      "slices",
      "S01",
      "tasks",
      "T01-SUMMARY.md"
    );
    assert.ok(fs.existsSync(summaryPath), "T01-SUMMARY.md written to disk");
    const rendered = fs.readFileSync(summaryPath, "utf-8");
    clearAllCaches();
    const parsed = parseSummary(rendered);
    assert.deepStrictEqual(parsed.frontmatter.id, "T01", "parsed summary has correct id");
    assert.deepStrictEqual(parsed.frontmatter.parent, "S01", "parsed summary has correct parent");
    assert.deepStrictEqual(parsed.frontmatter.milestone, "M001", "parsed summary has correct milestone");
    assert.deepStrictEqual(parsed.frontmatter.duration, "45m", "parsed summary has correct duration");
    assert.ok(parsed.title.includes("T01"), "parsed summary title contains task ID");
    assert.ok(parsed.whatHappened.includes("Built the test feature"), "whatHappened content preserved");
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});
test("\u2500\u2500 markdown-renderer: renderTaskSummary skips empty \u2500\u2500", async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, ".gsd", "gsd.db");
  openDatabase(dbPath);
  clearAllCaches();
  try {
    scaffoldDirs(tmpDir, "M001", ["S01"]);
    insertMilestone({ id: "M001", title: "Test", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
    insertTask({
      id: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      title: "Task without summary",
      status: "pending",
      fullSummaryMd: ""
      // empty summary
    });
    const ok = await renderTaskSummary(tmpDir, "M001", "S01", "T01");
    assert.ok(!ok, "renderTaskSummary returns false for empty summary");
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});
test("\u2500\u2500 markdown-renderer: renderSliceSummary round-trip \u2500\u2500", async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, ".gsd", "gsd.db");
  openDatabase(dbPath);
  clearAllCaches();
  try {
    scaffoldDirs(tmpDir, "M001", ["S01"]);
    insertMilestone({ id: "M001", title: "Test", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "complete" });
    const db = await import("../gsd-db.js");
    const adapter = db._getAdapter();
    adapter.prepare(
      `UPDATE slices SET full_summary_md = :sm, full_uat_md = :um WHERE milestone_id = 'M001' AND id = 'S01'`
    ).run({
      ":sm": "---\nid: S01\nparent: M001\nmilestone: M001\nduration: 2h\nverification_result: all-pass\ncompleted_at: 2025-01-01\nblocker_discovered: false\nprovides: []\nrequires: []\naffects: []\nkey_files:\n  - src/index.ts\nkey_decisions: []\npatterns_established: []\ndrill_down_paths: []\nobservability_surfaces: []\n---\n\n# S01: Test Slice Summary\n\n**Completed core functionality**\n\n## What Happened\n\nBuilt the slice.\n\n## Deviations\n\nNone.\n",
      ":um": "# S01 UAT\n\n## UAT Type\n\n- UAT mode: artifact-driven\n\n## Checks\n\n- All tests pass\n"
    });
    const ok = await renderSliceSummary(tmpDir, "M001", "S01");
    assert.ok(ok, "renderSliceSummary returns true");
    const summaryPath = path.join(
      tmpDir,
      ".gsd",
      "milestones",
      "M001",
      "slices",
      "S01",
      "S01-SUMMARY.md"
    );
    assert.ok(fs.existsSync(summaryPath), "S01-SUMMARY.md written to disk");
    const summaryContent = fs.readFileSync(summaryPath, "utf-8");
    assert.ok(summaryContent.includes("Test Slice Summary"), "summary content correct");
    const uatPath = path.join(
      tmpDir,
      ".gsd",
      "milestones",
      "M001",
      "slices",
      "S01",
      "S01-UAT.md"
    );
    assert.ok(fs.existsSync(uatPath), "S01-UAT.md written to disk");
    const uatContent = fs.readFileSync(uatPath, "utf-8");
    assert.ok(uatContent.includes("artifact-driven"), "UAT content correct");
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});
test("\u2500\u2500 markdown-renderer: renderAllFromDb produces all files \u2500\u2500", async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, ".gsd", "gsd.db");
  openDatabase(dbPath);
  clearAllCaches();
  try {
    scaffoldDirs(tmpDir, "M001", ["S01", "S02"]);
    scaffoldDirs(tmpDir, "M002", ["S01"]);
    insertMilestone({ id: "M001", title: "First", status: "active" });
    insertMilestone({ id: "M002", title: "Second", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Core", status: "complete" });
    insertSlice({ id: "S02", milestoneId: "M001", title: "Render", status: "pending" });
    insertSlice({ id: "S01", milestoneId: "M002", title: "Future", status: "pending" });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "DB", status: "done", fullSummaryMd: makeTaskSummaryContent("T01") });
    insertTask({ id: "T01", sliceId: "S02", milestoneId: "M001", title: "Renderer", status: "pending" });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M002", title: "Future task", status: "pending" });
    const roadmap1 = makeRoadmapContent([
      { id: "S01", title: "Core", done: false },
      { id: "S02", title: "Render", done: false }
    ]);
    fs.writeFileSync(
      path.join(tmpDir, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
      roadmap1
    );
    const roadmap2 = makeRoadmapContent([
      { id: "S01", title: "Future", done: false }
    ]);
    fs.writeFileSync(
      path.join(tmpDir, ".gsd", "milestones", "M002", "M002-ROADMAP.md"),
      roadmap2
    );
    const plan1 = makePlanContent("S01", [
      { id: "T01", title: "DB", done: false }
    ]);
    fs.writeFileSync(
      path.join(tmpDir, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"),
      plan1
    );
    const plan2 = makePlanContent("S02", [
      { id: "T01", title: "Renderer", done: false }
    ]);
    fs.writeFileSync(
      path.join(tmpDir, ".gsd", "milestones", "M001", "slices", "S02", "S02-PLAN.md"),
      plan2
    );
    const plan3 = makePlanContent("S01", [
      { id: "T01", title: "Future task", done: false }
    ]);
    fs.writeFileSync(
      path.join(tmpDir, ".gsd", "milestones", "M002", "slices", "S01", "S01-PLAN.md"),
      plan3
    );
    clearAllCaches();
    const result = await renderAllFromDb(tmpDir);
    assert.ok(result.rendered > 0, "renderAllFromDb rendered some files");
    assert.deepStrictEqual(result.errors.length, 0, "renderAllFromDb had no errors");
    const m1Roadmap = fs.readFileSync(
      path.join(tmpDir, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
      "utf-8"
    );
    clearAllCaches();
    const parsed1 = parseRoadmap(m1Roadmap);
    const s01 = parsed1.slices.find((s) => s.id === "S01");
    assert.ok(s01.done, "M001 S01 checked after renderAll");
    const m1s1Plan = fs.readFileSync(
      path.join(tmpDir, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"),
      "utf-8"
    );
    clearAllCaches();
    const parsedPlan = parsePlan(m1s1Plan);
    assert.ok(parsedPlan.tasks[0].done, "M001/S01 T01 checked after renderAll");
    const taskSummaryPath = path.join(
      tmpDir,
      ".gsd",
      "milestones",
      "M001",
      "slices",
      "S01",
      "tasks",
      "T01-SUMMARY.md"
    );
    assert.ok(fs.existsSync(taskSummaryPath), "T01 summary written by renderAll");
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});
test("\u2500\u2500 markdown-renderer: missing artifact regenerates from DB without importing disk projection \u2500\u2500", async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, ".gsd", "gsd.db");
  openDatabase(dbPath);
  clearAllCaches();
  try {
    scaffoldDirs(tmpDir, "M001", ["S01"]);
    insertMilestone({ id: "M001", title: "Test", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Core", status: "complete" });
    const roadmapContent = makeRoadmapContent([
      { id: "S01", title: "Core", done: false }
    ]) + "\n\nDISK_ONLY_SENTINEL";
    const roadmapPath = path.join(tmpDir, ".gsd", "milestones", "M001", "M001-ROADMAP.md");
    fs.writeFileSync(roadmapPath, roadmapContent);
    clearAllCaches();
    const before = getArtifact("milestones/M001/M001-ROADMAP.md");
    assert.deepStrictEqual(before, null, "artifact not in DB before render");
    const ok = await renderRoadmapCheckboxes(tmpDir, "M001");
    assert.ok(ok, "render succeeds by regenerating from DB");
    const after = getArtifact("milestones/M001/M001-ROADMAP.md");
    assert.ok(after !== null, "artifact regenerated in DB");
    assert.ok(!after.full_content.includes("DISK_ONLY_SENTINEL"), "disk projection content was not imported");
    assert.ok(after.full_content.includes("S01"), "DB artifact reflects DB slice state");
    assert.ok(fs.existsSync(roadmapPath), "roadmap projection regenerated on disk");
    const diskAfter = fs.readFileSync(roadmapPath, "utf-8");
    assert.ok(!diskAfter.includes("DISK_ONLY_SENTINEL"), "disk projection was rewritten from DB");
    assert.ok(diskAfter.includes("S01"), "disk projection reflects DB slice state");
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});
test("\u2500\u2500 markdown-renderer: stderr warning on missing content \u2500\u2500", async () => {
  openDatabase(":memory:");
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  const ok = await renderRoadmapCheckboxes("/nonexistent/path", "M001");
  assert.ok(!ok, "returns false when no slices in DB");
  closeDatabase();
});
test("\u2500\u2500 markdown-renderer: detectStaleRenders finds plan checkbox mismatch \u2500\u2500", () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, ".gsd", "gsd.db");
  openDatabase(dbPath);
  clearAllCaches();
  try {
    scaffoldDirs(tmpDir, "M001", ["S01"]);
    insertMilestone({ id: "M001", title: "Test", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "First task", status: "done" });
    insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Second task", status: "done" });
    const planContent = makePlanContent("S01", [
      { id: "T01", title: "First task", done: true },
      { id: "T02", title: "Second task", done: false }
    ]);
    const planPath = path.join(tmpDir, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md");
    fs.writeFileSync(planPath, planContent);
    clearAllCaches();
    const stale = detectStaleRenders(tmpDir);
    assert.ok(stale.length > 0, "detectStaleRenders should find stale entries");
    const t02Stale = stale.find((s) => s.reason.includes("T02"));
    assert.ok(!!t02Stale, "should detect T02 as stale (done in DB, unchecked in plan)");
    assert.ok(t02Stale.reason.includes("done in DB but unchecked"), "reason should explain the mismatch");
    const t01Stale = stale.find((s) => s.reason.includes("T01"));
    assert.deepStrictEqual(t01Stale, void 0, "T01 should not be stale (done and checked)");
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});
test("\u2500\u2500 markdown-renderer: repairStaleRenders fixes plan and second detect returns empty \u2500\u2500", async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, ".gsd", "gsd.db");
  openDatabase(dbPath);
  clearAllCaches();
  try {
    scaffoldDirs(tmpDir, "M001", ["S01"]);
    insertMilestone({ id: "M001", title: "Test", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "First task", status: "done" });
    insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Second task", status: "done" });
    const planContent = makePlanContent("S01", [
      { id: "T01", title: "First task", done: false },
      { id: "T02", title: "Second task", done: false }
    ]);
    const planPath = path.join(tmpDir, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md");
    fs.writeFileSync(planPath, planContent);
    clearAllCaches();
    const staleBefore = detectStaleRenders(tmpDir);
    assert.ok(staleBefore.length > 0, "should have stale entries before repair");
    const repaired = await repairStaleRenders(tmpDir);
    assert.ok(repaired > 0, "repairStaleRenders should repair at least 1 file");
    clearAllCaches();
    const staleAfter = detectStaleRenders(tmpDir);
    assert.deepStrictEqual(staleAfter.length, 0, "detectStaleRenders should return empty after repair");
    const repairedContent = fs.readFileSync(planPath, "utf-8");
    assert.ok(repairedContent.includes("[x] **T01:"), "T01 should be checked after repair");
    assert.ok(repairedContent.includes("[x] **T02:"), "T02 should be checked after repair");
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});
test("\u2500\u2500 markdown-renderer: detectStaleRenders finds roadmap checkbox mismatch \u2500\u2500", () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, ".gsd", "gsd.db");
  openDatabase(dbPath);
  clearAllCaches();
  try {
    scaffoldDirs(tmpDir, "M001", ["S01", "S02"]);
    insertMilestone({ id: "M001", title: "Test", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Core", status: "complete" });
    insertSlice({ id: "S02", milestoneId: "M001", title: "Render", status: "pending" });
    const roadmapContent = makeRoadmapContent([
      { id: "S01", title: "Core", done: false },
      { id: "S02", title: "Render", done: false }
    ]);
    const roadmapPath = path.join(tmpDir, ".gsd", "milestones", "M001", "M001-ROADMAP.md");
    fs.writeFileSync(roadmapPath, roadmapContent);
    clearAllCaches();
    const stale = detectStaleRenders(tmpDir);
    const s01Stale = stale.find((s) => s.reason.includes("S01"));
    assert.ok(!!s01Stale, "should detect S01 as stale (complete in DB, unchecked in roadmap)");
    const s02Stale = stale.find((s) => s.reason.includes("S02"));
    assert.deepStrictEqual(s02Stale, void 0, "S02 should not be stale (pending and unchecked \u2014 matches)");
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});
test("\u2500\u2500 markdown-renderer: detectStaleRenders finds missing task summary \u2500\u2500", () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, ".gsd", "gsd.db");
  openDatabase(dbPath);
  clearAllCaches();
  try {
    scaffoldDirs(tmpDir, "M001", ["S01"]);
    insertMilestone({ id: "M001", title: "Test", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
    const summaryContent = makeTaskSummaryContent("T01");
    insertTask({
      id: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      title: "Task",
      status: "done",
      fullSummaryMd: summaryContent
    });
    const planContent = makePlanContent("S01", [
      { id: "T01", title: "Task", done: true }
    ]);
    const planPath = path.join(tmpDir, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md");
    fs.writeFileSync(planPath, planContent);
    clearAllCaches();
    const stale = detectStaleRenders(tmpDir);
    const summaryStale = stale.find((s) => s.reason.includes("SUMMARY.md missing"));
    assert.ok(!!summaryStale, "should detect missing T01-SUMMARY.md");
    assert.ok(summaryStale.reason.includes("T01"), "reason should mention T01");
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});
test("\u2500\u2500 markdown-renderer: repairStaleRenders writes missing task summary \u2500\u2500", async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, ".gsd", "gsd.db");
  openDatabase(dbPath);
  clearAllCaches();
  try {
    scaffoldDirs(tmpDir, "M001", ["S01"]);
    insertMilestone({ id: "M001", title: "Test", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
    const summaryContent = makeTaskSummaryContent("T01");
    insertTask({
      id: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      title: "Task",
      status: "done",
      fullSummaryMd: summaryContent
    });
    const planContent = makePlanContent("S01", [
      { id: "T01", title: "Task", done: true }
    ]);
    const planPath = path.join(tmpDir, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md");
    fs.writeFileSync(planPath, planContent);
    clearAllCaches();
    const repaired = await repairStaleRenders(tmpDir);
    assert.ok(repaired > 0, "should repair missing summary");
    const summaryPath = path.join(
      tmpDir,
      ".gsd",
      "milestones",
      "M001",
      "slices",
      "S01",
      "tasks",
      "T01-SUMMARY.md"
    );
    assert.ok(fs.existsSync(summaryPath), "T01-SUMMARY.md should exist after repair");
    clearAllCaches();
    const staleAfter = detectStaleRenders(tmpDir);
    const summaryStale = staleAfter.find((s) => s.reason.includes("SUMMARY.md missing") && s.reason.includes("T01"));
    assert.deepStrictEqual(summaryStale, void 0, "missing summary should be fixed after repair");
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});
test("\u2500\u2500 markdown-renderer: repairStaleRenders idempotency \u2014 fully synced returns 0 \u2500\u2500", async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, ".gsd", "gsd.db");
  openDatabase(dbPath);
  clearAllCaches();
  try {
    scaffoldDirs(tmpDir, "M001", ["S01"]);
    insertMilestone({ id: "M001", title: "Test", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: "done" });
    const planContent = makePlanContent("S01", [
      { id: "T01", title: "Task", done: true }
    ]);
    const planPath = path.join(tmpDir, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md");
    fs.writeFileSync(planPath, planContent);
    clearAllCaches();
    const repaired = await repairStaleRenders(tmpDir);
    assert.deepStrictEqual(repaired, 0, "repairStaleRenders should return 0 on fully synced project");
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});
test("\u2500\u2500 markdown-renderer: detectStaleRenders finds missing slice summary and UAT \u2500\u2500", () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, ".gsd", "gsd.db");
  openDatabase(dbPath);
  clearAllCaches();
  try {
    scaffoldDirs(tmpDir, "M001", ["S01"]);
    insertMilestone({ id: "M001", title: "Test", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
    const adapter = _getAdapter();
    adapter.prepare(
      `UPDATE slices SET status = 'complete', full_summary_md = :sm, full_uat_md = :um WHERE milestone_id = 'M001' AND id = 'S01'`
    ).run({
      ":sm": "---\nid: S01\nparent: M001\nmilestone: M001\n---\n\n# S01: Summary\n\nDone.\n",
      ":um": "# S01 UAT\n\nAll pass.\n"
    });
    clearAllCaches();
    const stale = detectStaleRenders(tmpDir);
    const summaryStale = stale.find((s) => s.reason.includes("SUMMARY.md missing") && s.reason.includes("S01"));
    const uatStale = stale.find((s) => s.reason.includes("UAT.md missing") && s.reason.includes("S01"));
    assert.ok(!!summaryStale, "should detect missing S01-SUMMARY.md");
    assert.ok(!!uatStale, "should detect missing S01-UAT.md");
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9tYXJrZG93bi1yZW5kZXJlci50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgKiBhcyBwYXRoIGZyb20gJ25vZGU6cGF0aCc7XG5pbXBvcnQgKiBhcyBvcyBmcm9tICdub2RlOm9zJztcbmltcG9ydCAqIGFzIGZzIGZyb20gJ25vZGU6ZnMnO1xuaW1wb3J0IHtcbiAgb3BlbkRhdGFiYXNlLFxuICBjbG9zZURhdGFiYXNlLFxuICBpbnNlcnRNaWxlc3RvbmUsXG4gIGluc2VydFNsaWNlLFxuICBpbnNlcnRUYXNrLFxuICBpbnNlcnRBcnRpZmFjdCxcbiAgZ2V0QXJ0aWZhY3QsXG4gIGdldEFsbE1pbGVzdG9uZXMsXG4gIGdldE1pbGVzdG9uZVNsaWNlcyxcbiAgZ2V0U2xpY2VUYXNrcyxcbiAgdXBkYXRlU2xpY2VTdGF0dXMsXG4gIF9nZXRBZGFwdGVyLFxufSBmcm9tICcuLi9nc2QtZGIudHMnO1xuaW1wb3J0IHtcbiAgcmVuZGVyUm9hZG1hcENoZWNrYm94ZXMsXG4gIHJlbmRlclBsYW5DaGVja2JveGVzLFxuICByZW5kZXJUYXNrU3VtbWFyeSxcbiAgcmVuZGVyU2xpY2VTdW1tYXJ5LFxuICByZW5kZXJBbGxGcm9tRGIsXG4gIHJlbmRlclBsYW5Gcm9tRGIsXG4gIHJlbmRlclRhc2tQbGFuRnJvbURiLFxuICBkZXRlY3RTdGFsZVJlbmRlcnMsXG59IGZyb20gJy4uL21hcmtkb3duLXJlbmRlcmVyLnRzJztcbmltcG9ydCB7IHJlcGFpclN0YWxlUmVuZGVycyB9IGZyb20gJy4uL3N0YXRlLXJlY29uY2lsaWF0aW9uL2RyaWZ0L3N0YWxlLXJlbmRlci50cyc7XG5pbXBvcnQge1xuICBwYXJzZVJvYWRtYXAsXG4gIHBhcnNlUGxhbixcbn0gZnJvbSAnLi4vcGFyc2Vycy1sZWdhY3kudHMnO1xuaW1wb3J0IHtcbiAgcGFyc2VTdW1tYXJ5LFxuICBwYXJzZVRhc2tQbGFuRmlsZSxcbiAgY2xlYXJQYXJzZUNhY2hlLFxufSBmcm9tICcuLi9maWxlcy50cyc7XG5pbXBvcnQgeyBjbGVhclBhdGhDYWNoZSwgX2NsZWFyR3NkUm9vdENhY2hlIH0gZnJvbSAnLi4vcGF0aHMudHMnO1xuaW1wb3J0IHsgaW52YWxpZGF0ZVN0YXRlQ2FjaGUgfSBmcm9tICcuLi9zdGF0ZS50cyc7XG5pbXBvcnQgeyBkZXNjcmliZSwgdGVzdCwgYmVmb3JlRWFjaCwgYWZ0ZXJFYWNoIH0gZnJvbSAnbm9kZTp0ZXN0JztcbmltcG9ydCBhc3NlcnQgZnJvbSAnbm9kZTphc3NlcnQvc3RyaWN0JztcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBIZWxwZXJzXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuZnVuY3Rpb24gbWFrZVRtcERpcigpOiBzdHJpbmcge1xuICBjb25zdCBkaXIgPSBmcy5ta2R0ZW1wU3luYyhwYXRoLmpvaW4ob3MudG1wZGlyKCksICdnc2QtcmVuZGVyZXItJykpO1xuICBmcy5ta2RpclN5bmMocGF0aC5qb2luKGRpciwgJy5nc2QnKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHJldHVybiBkaXI7XG59XG5cbmZ1bmN0aW9uIGNsZWFudXBEaXIoZGlyOiBzdHJpbmcpOiB2b2lkIHtcbiAgdHJ5IHtcbiAgICBmcy5ybVN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH0gY2F0Y2ggeyAvKiBzd2FsbG93ICovIH1cbn1cblxuZnVuY3Rpb24gY2xlYXJBbGxDYWNoZXMoKTogdm9pZCB7XG4gIGNsZWFyUGFyc2VDYWNoZSgpO1xuICBjbGVhclBhdGhDYWNoZSgpO1xuICBfY2xlYXJHc2RSb290Q2FjaGUoKTtcbiAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbn1cblxuLyoqXG4gKiBDcmVhdGUgb24tZGlzayBkaXJlY3Rvcnkgc3RydWN0dXJlIGZvciBhIG1pbGVzdG9uZS9zbGljZS90YXNrIHRyZWVcbiAqIHNvIHRoYXQgcGF0aCByZXNvbHZlcnMgd29yayBjb3JyZWN0bHkuXG4gKi9cbmZ1bmN0aW9uIHNjYWZmb2xkRGlycyh0bXBEaXI6IHN0cmluZywgbWlkOiBzdHJpbmcsIHNsaWNlSWRzOiBzdHJpbmdbXSk6IHZvaWQge1xuICBjb25zdCBtc0RpciA9IHBhdGguam9pbih0bXBEaXIsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCBtaWQpO1xuICBmcy5ta2RpclN5bmMobXNEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gIGZvciAoY29uc3Qgc2lkIG9mIHNsaWNlSWRzKSB7XG4gICAgY29uc3Qgc2xpY2VEaXIgPSBwYXRoLmpvaW4obXNEaXIsICdzbGljZXMnLCBzaWQpO1xuICAgIGZzLm1rZGlyU3luYyhwYXRoLmpvaW4oc2xpY2VEaXIsICd0YXNrcycpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRml4dHVyZTogUm9hZG1hcCBUZW1wbGF0ZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gbWFrZVJvYWRtYXBDb250ZW50KHNsaWNlczogQXJyYXk8eyBpZDogc3RyaW5nOyB0aXRsZTogc3RyaW5nOyBkb25lOiBib29sZWFuIH0+KTogc3RyaW5nIHtcbiAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG4gIGxpbmVzLnB1c2goJyMgTTAwMSBSb2FkbWFwJyk7XG4gIGxpbmVzLnB1c2goJycpO1xuICBsaW5lcy5wdXNoKCcqKlZpc2lvbjoqKiBUZXN0IG1pbGVzdG9uZScpO1xuICBsaW5lcy5wdXNoKCcnKTtcbiAgbGluZXMucHVzaCgnIyMgU2xpY2VzJyk7XG4gIGxpbmVzLnB1c2goJycpO1xuICBmb3IgKGNvbnN0IHMgb2Ygc2xpY2VzKSB7XG4gICAgY29uc3QgY2hlY2tib3ggPSBzLmRvbmUgPyAnW3hdJyA6ICdbIF0nO1xuICAgIGxpbmVzLnB1c2goYC0gJHtjaGVja2JveH0gKioke3MuaWR9OiAke3MudGl0bGV9KiogXFxgcmlzazptZWRpdW1cXGAgXFxgZGVwZW5kczpbXVxcYGApO1xuICB9XG4gIGxpbmVzLnB1c2goJycpO1xuICByZXR1cm4gbGluZXMuam9pbignXFxuJyk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBGaXh0dXJlOiBQbGFuIFRlbXBsYXRlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBtYWtlUGxhbkNvbnRlbnQoXG4gIHNsaWNlSWQ6IHN0cmluZyxcbiAgdGFza3M6IEFycmF5PHsgaWQ6IHN0cmluZzsgdGl0bGU6IHN0cmluZzsgZG9uZTogYm9vbGVhbiB9Pixcbik6IHN0cmluZyB7XG4gIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICBsaW5lcy5wdXNoKGAjICR7c2xpY2VJZH06IFRlc3QgU2xpY2VgKTtcbiAgbGluZXMucHVzaCgnJyk7XG4gIGxpbmVzLnB1c2goJyoqR29hbDoqKiBUZXN0IHNsaWNlIGdvYWwnKTtcbiAgbGluZXMucHVzaCgnKipEZW1vOioqIFRlc3QgZGVtbycpO1xuICBsaW5lcy5wdXNoKCcnKTtcbiAgbGluZXMucHVzaCgnIyMgTXVzdC1IYXZlcycpO1xuICBsaW5lcy5wdXNoKCcnKTtcbiAgbGluZXMucHVzaCgnLSBFdmVyeXRoaW5nIHdvcmtzJyk7XG4gIGxpbmVzLnB1c2goJycpO1xuICBsaW5lcy5wdXNoKCcjIyBUYXNrcycpO1xuICBsaW5lcy5wdXNoKCcnKTtcbiAgZm9yIChjb25zdCB0IG9mIHRhc2tzKSB7XG4gICAgY29uc3QgY2hlY2tib3ggPSB0LmRvbmUgPyAnW3hdJyA6ICdbIF0nO1xuICAgIGxpbmVzLnB1c2goYC0gJHtjaGVja2JveH0gKioke3QuaWR9OiAke3QudGl0bGV9KiogXFxgZXN0OjFoXFxgYCk7XG4gIH1cbiAgbGluZXMucHVzaCgnJyk7XG4gIHJldHVybiBsaW5lcy5qb2luKCdcXG4nKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEZpeHR1cmU6IFRhc2sgU3VtbWFyeSBUZW1wbGF0ZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gbWFrZVRhc2tTdW1tYXJ5Q29udGVudCh0YXNrSWQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBbXG4gICAgJy0tLScsXG4gICAgYGlkOiAke3Rhc2tJZH1gLFxuICAgICdwYXJlbnQ6IFMwMScsXG4gICAgJ21pbGVzdG9uZTogTTAwMScsXG4gICAgJ2R1cmF0aW9uOiA0NW0nLFxuICAgICd2ZXJpZmljYXRpb25fcmVzdWx0OiBhbGwtcGFzcycsXG4gICAgYGNvbXBsZXRlZF9hdDogJHtuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCl9YCxcbiAgICAnYmxvY2tlcl9kaXNjb3ZlcmVkOiBmYWxzZScsXG4gICAgJ3Byb3ZpZGVzOiBbXScsXG4gICAgJ3JlcXVpcmVzOiBbXScsXG4gICAgJ2FmZmVjdHM6IFtdJyxcbiAgICAna2V5X2ZpbGVzOicsXG4gICAgJyAgLSBzcmMvdGVzdC50cycsXG4gICAgJ2tleV9kZWNpc2lvbnM6IFtdJyxcbiAgICAncGF0dGVybnNfZXN0YWJsaXNoZWQ6IFtdJyxcbiAgICAnZHJpbGxfZG93bl9wYXRoczogW10nLFxuICAgICdvYnNlcnZhYmlsaXR5X3N1cmZhY2VzOiBbXScsXG4gICAgJy0tLScsXG4gICAgJycsXG4gICAgYCMgJHt0YXNrSWR9OiBUZXN0IFRhc2sgU3VtbWFyeWAsXG4gICAgJycsXG4gICAgJyoqSW1wbGVtZW50ZWQgdGVzdCBmdW5jdGlvbmFsaXR5KionLFxuICAgICcnLFxuICAgICcjIyBXaGF0IEhhcHBlbmVkJyxcbiAgICAnJyxcbiAgICAnQnVpbHQgdGhlIHRlc3QgZmVhdHVyZS4nLFxuICAgICcnLFxuICAgICcjIyBEZXZpYXRpb25zJyxcbiAgICAnJyxcbiAgICAnTm9uZS4nLFxuICAgICcnLFxuICAgICcjIyBGaWxlcyBDcmVhdGVkL01vZGlmaWVkJyxcbiAgICAnJyxcbiAgICAnLSBgc3JjL3Rlc3QudHNgIFx1MjAxNCBtYWluIGltcGxlbWVudGF0aW9uJyxcbiAgICAnJyxcbiAgICAnIyMgVmVyaWZpY2F0aW9uIEV2aWRlbmNlJyxcbiAgICAnJyxcbiAgICAnfCBDb21tYW5kIHwgRXhpdCB8IFZlcmRpY3QgfCBEdXJhdGlvbiB8JyxcbiAgICAnfC0tLS0tLS0tLXwtLS0tLS18LS0tLS0tLS0tfC0tLS0tLS0tLS18JyxcbiAgICAnfCBgbnBtIHRlc3RgIHwgMCB8IFx1MjcwNSBwYXNzIHwgMi4xcyB8JyxcbiAgICAnJyxcbiAgXS5qb2luKCdcXG4nKTtcbn1cblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBEQiBBY2Nlc3NvciBUZXN0c1xuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbnRlc3QoJ1x1MjUwMFx1MjUwMCBtYXJrZG93bi1yZW5kZXJlcjogREIgYWNjZXNzb3IgYmFzaWNzIFx1MjUwMFx1MjUwMCcsICgpID0+IHtcbiAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuXG4gIC8vIGdldEFsbE1pbGVzdG9uZXMgXHUyMDE0IGVtcHR5XG4gIGNvbnN0IGVtcHR5ID0gZ2V0QWxsTWlsZXN0b25lcygpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGVtcHR5Lmxlbmd0aCwgMCwgJ2dldEFsbE1pbGVzdG9uZXMgcmV0dXJucyBlbXB0eSB3aGVuIG5vIG1pbGVzdG9uZXMnKTtcblxuICAvLyBJbnNlcnQgYW5kIHJldHJpZXZlXG4gIGluc2VydE1pbGVzdG9uZSh7IGlkOiAnTTAwMScsIHRpdGxlOiAnVGVzdCBNUycsIHN0YXR1czogJ2FjdGl2ZScgfSk7XG4gIGluc2VydE1pbGVzdG9uZSh7IGlkOiAnTTAwMicsIHRpdGxlOiAnU2Vjb25kIE1TJywgc3RhdHVzOiAnYWN0aXZlJyB9KTtcblxuICBjb25zdCBhbGwgPSBnZXRBbGxNaWxlc3RvbmVzKCk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoYWxsLmxlbmd0aCwgMiwgJ2dldEFsbE1pbGVzdG9uZXMgcmV0dXJucyAyIG1pbGVzdG9uZXMnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChhbGxbMF0uaWQsICdNMDAxJywgJ2ZpcnN0IG1pbGVzdG9uZSBpcyBNMDAxJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoYWxsWzFdLmlkLCAnTTAwMicsICdzZWNvbmQgbWlsZXN0b25lIGlzIE0wMDInKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChhbGxbMF0udGl0bGUsICdUZXN0IE1TJywgJ21pbGVzdG9uZSB0aXRsZSBjb3JyZWN0Jyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoYWxsWzBdLnN0YXR1cywgJ2FjdGl2ZScsICdtaWxlc3RvbmUgc3RhdHVzIGNvcnJlY3QnKTtcblxuICAvLyBnZXRNaWxlc3RvbmVTbGljZXMgXHUyMDE0IGVtcHR5XG4gIGNvbnN0IG5vU2xpY2VzID0gZ2V0TWlsZXN0b25lU2xpY2VzKCdNMDAxJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwobm9TbGljZXMubGVuZ3RoLCAwLCAnZ2V0TWlsZXN0b25lU2xpY2VzIHJldHVybnMgZW1wdHkgd2hlbiBubyBzbGljZXMnKTtcblxuICAvLyBJbnNlcnQgc2xpY2VzIGFuZCByZXRyaWV2ZVxuICBpbnNlcnRTbGljZSh7IGlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdTbGljZSAxJywgc3RhdHVzOiAnY29tcGxldGUnIH0pO1xuICBpbnNlcnRTbGljZSh7IGlkOiAnUzAyJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdTbGljZSAyJywgc3RhdHVzOiAncGVuZGluZycgfSk7XG4gIGluc2VydFNsaWNlKHsgaWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDInLCB0aXRsZTogJ00yIFNsaWNlJywgc3RhdHVzOiAncGVuZGluZycgfSk7XG5cbiAgY29uc3QgbTFTbGljZXMgPSBnZXRNaWxlc3RvbmVTbGljZXMoJ00wMDEnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChtMVNsaWNlcy5sZW5ndGgsIDIsICdNMDAxIGhhcyAyIHNsaWNlcycpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKG0xU2xpY2VzWzBdLmlkLCAnUzAxJywgJ2ZpcnN0IHNsaWNlIGlzIFMwMScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKG0xU2xpY2VzWzBdLnN0YXR1cywgJ2NvbXBsZXRlJywgJ1MwMSBzdGF0dXMgaXMgY29tcGxldGUnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChtMVNsaWNlc1sxXS5pZCwgJ1MwMicsICdzZWNvbmQgc2xpY2UgaXMgUzAyJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwobTFTbGljZXNbMV0uc3RhdHVzLCAncGVuZGluZycsICdTMDIgc3RhdHVzIGlzIHBlbmRpbmcnKTtcblxuICBjb25zdCBtMlNsaWNlcyA9IGdldE1pbGVzdG9uZVNsaWNlcygnTTAwMicpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKG0yU2xpY2VzLmxlbmd0aCwgMSwgJ00wMDIgaGFzIDEgc2xpY2UnKTtcblxuICBjbG9zZURhdGFiYXNlKCk7XG59KTtcblxudGVzdCgnXHUyNTAwXHUyNTAwIG1hcmtkb3duLXJlbmRlcmVyOiBnZXRBcnRpZmFjdCBhY2Nlc3NvciBcdTI1MDBcdTI1MDAnLCAoKSA9PiB7XG4gIG9wZW5EYXRhYmFzZSgnOm1lbW9yeTonKTtcblxuICAvLyBOb3QgZm91bmRcbiAgY29uc3QgbWlzc2luZyA9IGdldEFydGlmYWN0KCdub25leGlzdGVudC9wYXRoJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwobWlzc2luZywgbnVsbCwgJ2dldEFydGlmYWN0IHJldHVybnMgbnVsbCBmb3IgbWlzc2luZyBwYXRoJyk7XG5cbiAgLy8gSW5zZXJ0IGFuZCByZXRyaWV2ZVxuICBpbnNlcnRBcnRpZmFjdCh7XG4gICAgcGF0aDogJ21pbGVzdG9uZXMvTTAwMS9NMDAxLVJPQURNQVAubWQnLFxuICAgIGFydGlmYWN0X3R5cGU6ICdST0FETUFQJyxcbiAgICBtaWxlc3RvbmVfaWQ6ICdNMDAxJyxcbiAgICBzbGljZV9pZDogbnVsbCxcbiAgICB0YXNrX2lkOiBudWxsLFxuICAgIGZ1bGxfY29udGVudDogJyMgUm9hZG1hcCBjb250ZW50JyxcbiAgfSk7XG5cbiAgY29uc3QgZm91bmQgPSBnZXRBcnRpZmFjdCgnbWlsZXN0b25lcy9NMDAxL00wMDEtUk9BRE1BUC5tZCcpO1xuICBhc3NlcnQub2soZm91bmQgIT09IG51bGwsICdnZXRBcnRpZmFjdCByZXR1cm5zIG5vbi1udWxsIGZvciBleGlzdGluZyBwYXRoJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZm91bmQhLmFydGlmYWN0X3R5cGUsICdST0FETUFQJywgJ2FydGlmYWN0IHR5cGUgY29ycmVjdCcpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGZvdW5kIS5taWxlc3RvbmVfaWQsICdNMDAxJywgJ21pbGVzdG9uZV9pZCBjb3JyZWN0Jyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZm91bmQhLmZ1bGxfY29udGVudCwgJyMgUm9hZG1hcCBjb250ZW50JywgJ2NvbnRlbnQgY29ycmVjdCcpO1xuXG4gIGNsb3NlRGF0YWJhc2UoKTtcbn0pO1xuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIFJvYWRtYXAgQ2hlY2tib3ggUm91bmQtVHJpcFxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbnRlc3QoJ1x1MjUwMFx1MjUwMCBtYXJrZG93bi1yZW5kZXJlcjogcmVuZGVyUm9hZG1hcENoZWNrYm94ZXMgcm91bmQtdHJpcCBcdTI1MDBcdTI1MDAnLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHRtcERpciA9IG1ha2VUbXBEaXIoKTtcbiAgY29uc3QgZGJQYXRoID0gcGF0aC5qb2luKHRtcERpciwgJy5nc2QnLCAnZ3NkLmRiJyk7XG4gIG9wZW5EYXRhYmFzZShkYlBhdGgpO1xuICBjbGVhckFsbENhY2hlcygpO1xuXG4gIHRyeSB7XG4gICAgc2NhZmZvbGREaXJzKHRtcERpciwgJ00wMDEnLCBbJ1MwMScsICdTMDInXSk7XG5cbiAgICAvLyBTZWVkIERCIHdpdGggbWlsZXN0b25lIGFuZCBzbGljZXNcbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogJ00wMDEnLCB0aXRsZTogJ1Rlc3QnLCBzdGF0dXM6ICdhY3RpdmUnIH0pO1xuICAgIGluc2VydFNsaWNlKHsgaWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ0NvcmUgc2V0dXAnLCBzdGF0dXM6ICdjb21wbGV0ZScgfSk7XG4gICAgaW5zZXJ0U2xpY2UoeyBpZDogJ1MwMicsIG1pbGVzdG9uZUlkOiAnTTAwMScsIHRpdGxlOiAnUmVuZGVyaW5nJywgc3RhdHVzOiAncGVuZGluZycgfSk7XG5cbiAgICAvLyBXcml0ZSBhIHJvYWRtYXAgZmlsZSBvbiBkaXNrIHdpdGggQk9USCBzbGljZXMgdW5jaGVja2VkXG4gICAgY29uc3Qgcm9hZG1hcENvbnRlbnQgPSBtYWtlUm9hZG1hcENvbnRlbnQoW1xuICAgICAgeyBpZDogJ1MwMScsIHRpdGxlOiAnQ29yZSBzZXR1cCcsIGRvbmU6IGZhbHNlIH0sXG4gICAgICB7IGlkOiAnUzAyJywgdGl0bGU6ICdSZW5kZXJpbmcnLCBkb25lOiBmYWxzZSB9LFxuICAgIF0pO1xuICAgIGNvbnN0IHJvYWRtYXBQYXRoID0gcGF0aC5qb2luKHRtcERpciwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAxJywgJ00wMDEtUk9BRE1BUC5tZCcpO1xuICAgIGZzLndyaXRlRmlsZVN5bmMocm9hZG1hcFBhdGgsIHJvYWRtYXBDb250ZW50KTtcbiAgICBjbGVhckFsbENhY2hlcygpO1xuXG4gICAgLy8gUmVuZGVyIFx1MjAxNCBzaG91bGQgc2V0IFMwMSBbeF0gYW5kIGxlYXZlIFMwMiBbIF1cbiAgICBjb25zdCBvayA9IGF3YWl0IHJlbmRlclJvYWRtYXBDaGVja2JveGVzKHRtcERpciwgJ00wMDEnKTtcbiAgICBhc3NlcnQub2sob2ssICdyZW5kZXJSb2FkbWFwQ2hlY2tib3hlcyByZXR1cm5zIHRydWUnKTtcblxuICAgIC8vIFJlYWQgcmVuZGVyZWQgZmlsZSBhbmQgcGFyc2VcbiAgICBjb25zdCByZW5kZXJlZCA9IGZzLnJlYWRGaWxlU3luYyhyb2FkbWFwUGF0aCwgJ3V0Zi04Jyk7XG4gICAgY2xlYXJBbGxDYWNoZXMoKTtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVJvYWRtYXAocmVuZGVyZWQpO1xuXG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwYXJzZWQuc2xpY2VzLmxlbmd0aCwgMiwgJ3JvYWRtYXAgaGFzIDIgc2xpY2VzIGFmdGVyIHJlbmRlcicpO1xuXG4gICAgY29uc3QgczAxID0gcGFyc2VkLnNsaWNlcy5maW5kKHMgPT4gcy5pZCA9PT0gJ1MwMScpO1xuICAgIGNvbnN0IHMwMiA9IHBhcnNlZC5zbGljZXMuZmluZChzID0+IHMuaWQgPT09ICdTMDInKTtcbiAgICBhc3NlcnQub2soISFzMDEsICdTMDEgZm91bmQgaW4gcGFyc2VkIHJvYWRtYXAnKTtcbiAgICBhc3NlcnQub2soISFzMDIsICdTMDIgZm91bmQgaW4gcGFyc2VkIHJvYWRtYXAnKTtcbiAgICBhc3NlcnQub2soczAxIS5kb25lLCAnUzAxIGlzIGNoZWNrZWQgKGRvbmUpIGFmdGVyIHJlbmRlcicpO1xuICAgIGFzc2VydC5vayghczAyIS5kb25lLCAnUzAyIGlzIHVuY2hlY2tlZCAocGVuZGluZykgYWZ0ZXIgcmVuZGVyJyk7XG5cbiAgICAvLyBWZXJpZnkgYXJ0aWZhY3Qgc3RvcmVkIGluIERCXG4gICAgY29uc3QgYXJ0aWZhY3QgPSBnZXRBcnRpZmFjdCgnbWlsZXN0b25lcy9NMDAxL00wMDEtUk9BRE1BUC5tZCcpO1xuICAgIGFzc2VydC5vayhhcnRpZmFjdCAhPT0gbnVsbCwgJ3JvYWRtYXAgYXJ0aWZhY3Qgc3RvcmVkIGluIERCIGFmdGVyIHJlbmRlcicpO1xuICAgIGFzc2VydC5vayhhcnRpZmFjdCEuZnVsbF9jb250ZW50LmluY2x1ZGVzKCdbeF0gKipTMDE6JyksICdEQiBhcnRpZmFjdCBoYXMgUzAxIGNoZWNrZWQnKTtcbiAgICBhc3NlcnQub2soYXJ0aWZhY3QhLmZ1bGxfY29udGVudC5pbmNsdWRlcygnWyBdICoqUzAyOicpLCAnREIgYXJ0aWZhY3QgaGFzIFMwMiB1bmNoZWNrZWQnKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgY2xlYW51cERpcih0bXBEaXIpO1xuICB9XG59KTtcblxudGVzdCgnXHUyNTAwXHUyNTAwIG1hcmtkb3duLXJlbmRlcmVyOiByZW5kZXJSb2FkbWFwQ2hlY2tib3hlcyBiaWRpcmVjdGlvbmFsIFx1MjUwMFx1MjUwMCcsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgdG1wRGlyID0gbWFrZVRtcERpcigpO1xuICBjb25zdCBkYlBhdGggPSBwYXRoLmpvaW4odG1wRGlyLCAnLmdzZCcsICdnc2QuZGInKTtcbiAgb3BlbkRhdGFiYXNlKGRiUGF0aCk7XG4gIGNsZWFyQWxsQ2FjaGVzKCk7XG5cbiAgdHJ5IHtcbiAgICBzY2FmZm9sZERpcnModG1wRGlyLCAnTTAwMScsIFsnUzAxJywgJ1MwMiddKTtcblxuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiAnTTAwMScsIHRpdGxlOiAnVGVzdCcsIHN0YXR1czogJ2FjdGl2ZScgfSk7XG4gICAgLy8gUzAxIGlzIFBFTkRJTkcgaW4gREIsIGJ1dCBjaGVja2VkIG9uIGRpc2sgXHUyMDE0IHNob3VsZCBiZSB1bmNoZWNrZWRcbiAgICBpbnNlcnRTbGljZSh7IGlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdDb3JlIHNldHVwJywgc3RhdHVzOiAncGVuZGluZycgfSk7XG4gICAgaW5zZXJ0U2xpY2UoeyBpZDogJ1MwMicsIG1pbGVzdG9uZUlkOiAnTTAwMScsIHRpdGxlOiAnUmVuZGVyaW5nJywgc3RhdHVzOiAnY29tcGxldGUnIH0pO1xuXG4gICAgLy8gV3JpdGUgcm9hZG1hcCB3aXRoIFMwMSBjaGVja2VkIGFuZCBTMDIgdW5jaGVja2VkIChvcHBvc2l0ZSBvZiBEQiBzdGF0ZSlcbiAgICBjb25zdCByb2FkbWFwQ29udGVudCA9IG1ha2VSb2FkbWFwQ29udGVudChbXG4gICAgICB7IGlkOiAnUzAxJywgdGl0bGU6ICdDb3JlIHNldHVwJywgZG9uZTogdHJ1ZSB9LFxuICAgICAgeyBpZDogJ1MwMicsIHRpdGxlOiAnUmVuZGVyaW5nJywgZG9uZTogZmFsc2UgfSxcbiAgICBdKTtcbiAgICBjb25zdCByb2FkbWFwUGF0aCA9IHBhdGguam9pbih0bXBEaXIsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScsICdNMDAxLVJPQURNQVAubWQnKTtcbiAgICBmcy53cml0ZUZpbGVTeW5jKHJvYWRtYXBQYXRoLCByb2FkbWFwQ29udGVudCk7XG4gICAgY2xlYXJBbGxDYWNoZXMoKTtcblxuICAgIGNvbnN0IG9rID0gYXdhaXQgcmVuZGVyUm9hZG1hcENoZWNrYm94ZXModG1wRGlyLCAnTTAwMScpO1xuICAgIGFzc2VydC5vayhvaywgJ2JpZGlyZWN0aW9uYWwgcmVuZGVyIHJldHVybnMgdHJ1ZScpO1xuXG4gICAgY29uc3QgcmVuZGVyZWQgPSBmcy5yZWFkRmlsZVN5bmMocm9hZG1hcFBhdGgsICd1dGYtOCcpO1xuICAgIGNsZWFyQWxsQ2FjaGVzKCk7XG4gICAgY29uc3QgcGFyc2VkID0gcGFyc2VSb2FkbWFwKHJlbmRlcmVkKTtcblxuICAgIGNvbnN0IHMwMSA9IHBhcnNlZC5zbGljZXMuZmluZChzID0+IHMuaWQgPT09ICdTMDEnKTtcbiAgICBjb25zdCBzMDIgPSBwYXJzZWQuc2xpY2VzLmZpbmQocyA9PiBzLmlkID09PSAnUzAyJyk7XG4gICAgYXNzZXJ0Lm9rKCFzMDEhLmRvbmUsICdTMDEgdW5jaGVja2VkIChEQiBzYXlzIHBlbmRpbmcsIHdhcyBjaGVja2VkIG9uIGRpc2spJyk7XG4gICAgYXNzZXJ0Lm9rKHMwMiEuZG9uZSwgJ1MwMiBjaGVja2VkIChEQiBzYXlzIGNvbXBsZXRlLCB3YXMgdW5jaGVja2VkIG9uIGRpc2spJyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIGNsZWFudXBEaXIodG1wRGlyKTtcbiAgfVxufSk7XG5cbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuLy8gUGxhbiBDaGVja2JveCBSb3VuZC1UcmlwXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxudGVzdCgnXHUyNTAwXHUyNTAwIG1hcmtkb3duLXJlbmRlcmVyOiByZW5kZXJQbGFuQ2hlY2tib3hlcyByb3VuZC10cmlwIFx1MjUwMFx1MjUwMCcsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgdG1wRGlyID0gbWFrZVRtcERpcigpO1xuICBjb25zdCBkYlBhdGggPSBwYXRoLmpvaW4odG1wRGlyLCAnLmdzZCcsICdnc2QuZGInKTtcbiAgb3BlbkRhdGFiYXNlKGRiUGF0aCk7XG4gIGNsZWFyQWxsQ2FjaGVzKCk7XG5cbiAgdHJ5IHtcbiAgICBzY2FmZm9sZERpcnModG1wRGlyLCAnTTAwMScsIFsnUzAxJ10pO1xuXG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgdGl0bGU6ICdUZXN0Jywgc3RhdHVzOiAnYWN0aXZlJyB9KTtcbiAgICBpbnNlcnRTbGljZSh7IGlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdTbGljZScsIHN0YXR1czogJ3BlbmRpbmcnIH0pO1xuICAgIGluc2VydFRhc2soeyBpZDogJ1QwMScsIHNsaWNlSWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ0ZpcnN0IHRhc2snLCBzdGF0dXM6ICdkb25lJyB9KTtcbiAgICBpbnNlcnRUYXNrKHsgaWQ6ICdUMDInLCBzbGljZUlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdTZWNvbmQgdGFzaycsIHN0YXR1czogJ2RvbmUnIH0pO1xuICAgIGluc2VydFRhc2soeyBpZDogJ1QwMycsIHNsaWNlSWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ1RoaXJkIHRhc2snLCBzdGF0dXM6ICdwZW5kaW5nJyB9KTtcblxuICAgIC8vIFdyaXRlIHBsYW4gd2l0aCBhbGwgdGFza3MgdW5jaGVja2VkXG4gICAgY29uc3QgcGxhbkNvbnRlbnQgPSBtYWtlUGxhbkNvbnRlbnQoJ1MwMScsIFtcbiAgICAgIHsgaWQ6ICdUMDEnLCB0aXRsZTogJ0ZpcnN0IHRhc2snLCBkb25lOiBmYWxzZSB9LFxuICAgICAgeyBpZDogJ1QwMicsIHRpdGxlOiAnU2Vjb25kIHRhc2snLCBkb25lOiBmYWxzZSB9LFxuICAgICAgeyBpZDogJ1QwMycsIHRpdGxlOiAnVGhpcmQgdGFzaycsIGRvbmU6IGZhbHNlIH0sXG4gICAgXSk7XG4gICAgY29uc3QgcGxhblBhdGggPSBwYXRoLmpvaW4odG1wRGlyLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgJ00wMDEnLCAnc2xpY2VzJywgJ1MwMScsICdTMDEtUExBTi5tZCcpO1xuICAgIGZzLndyaXRlRmlsZVN5bmMocGxhblBhdGgsIHBsYW5Db250ZW50KTtcbiAgICBjbGVhckFsbENhY2hlcygpO1xuXG4gICAgY29uc3Qgb2sgPSBhd2FpdCByZW5kZXJQbGFuQ2hlY2tib3hlcyh0bXBEaXIsICdNMDAxJywgJ1MwMScpO1xuICAgIGFzc2VydC5vayhvaywgJ3JlbmRlclBsYW5DaGVja2JveGVzIHJldHVybnMgdHJ1ZScpO1xuXG4gICAgY29uc3QgcmVuZGVyZWQgPSBmcy5yZWFkRmlsZVN5bmMocGxhblBhdGgsICd1dGYtOCcpO1xuICAgIGNsZWFyQWxsQ2FjaGVzKCk7XG4gICAgY29uc3QgcGFyc2VkID0gcGFyc2VQbGFuKHJlbmRlcmVkKTtcblxuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGFyc2VkLnRhc2tzLmxlbmd0aCwgMywgJ3BsYW4gaGFzIDMgdGFza3MgYWZ0ZXIgcmVuZGVyJyk7XG5cbiAgICBjb25zdCB0MDEgPSBwYXJzZWQudGFza3MuZmluZCh0ID0+IHQuaWQgPT09ICdUMDEnKTtcbiAgICBjb25zdCB0MDIgPSBwYXJzZWQudGFza3MuZmluZCh0ID0+IHQuaWQgPT09ICdUMDInKTtcbiAgICBjb25zdCB0MDMgPSBwYXJzZWQudGFza3MuZmluZCh0ID0+IHQuaWQgPT09ICdUMDMnKTtcbiAgICBhc3NlcnQub2sodDAxIS5kb25lLCAnVDAxIGNoZWNrZWQgKGRvbmUgaW4gREIpJyk7XG4gICAgYXNzZXJ0Lm9rKHQwMiEuZG9uZSwgJ1QwMiBjaGVja2VkIChkb25lIGluIERCKScpO1xuICAgIGFzc2VydC5vayghdDAzIS5kb25lLCAnVDAzIHVuY2hlY2tlZCAocGVuZGluZyBpbiBEQiknKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgY2xlYW51cERpcih0bXBEaXIpO1xuICB9XG59KTtcblxudGVzdCgnXHUyNTAwXHUyNTAwIG1hcmtkb3duLXJlbmRlcmVyOiByZW5kZXJQbGFuQ2hlY2tib3hlcyBiaWRpcmVjdGlvbmFsIFx1MjUwMFx1MjUwMCcsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgdG1wRGlyID0gbWFrZVRtcERpcigpO1xuICBjb25zdCBkYlBhdGggPSBwYXRoLmpvaW4odG1wRGlyLCAnLmdzZCcsICdnc2QuZGInKTtcbiAgb3BlbkRhdGFiYXNlKGRiUGF0aCk7XG4gIGNsZWFyQWxsQ2FjaGVzKCk7XG5cbiAgdHJ5IHtcbiAgICBzY2FmZm9sZERpcnModG1wRGlyLCAnTTAwMScsIFsnUzAxJ10pO1xuXG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgdGl0bGU6ICdUZXN0Jywgc3RhdHVzOiAnYWN0aXZlJyB9KTtcbiAgICBpbnNlcnRTbGljZSh7IGlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdTbGljZScsIHN0YXR1czogJ3BlbmRpbmcnIH0pO1xuICAgIC8vIFQwMSBwZW5kaW5nIGluIERCIGJ1dCBjaGVja2VkIG9uIGRpc2tcbiAgICBpbnNlcnRUYXNrKHsgaWQ6ICdUMDEnLCBzbGljZUlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdGaXJzdCB0YXNrJywgc3RhdHVzOiAncGVuZGluZycgfSk7XG4gICAgaW5zZXJ0VGFzayh7IGlkOiAnVDAyJywgc2xpY2VJZDogJ1MwMScsIG1pbGVzdG9uZUlkOiAnTTAwMScsIHRpdGxlOiAnU2Vjb25kIHRhc2snLCBzdGF0dXM6ICdkb25lJyB9KTtcblxuICAgIGNvbnN0IHBsYW5Db250ZW50ID0gbWFrZVBsYW5Db250ZW50KCdTMDEnLCBbXG4gICAgICB7IGlkOiAnVDAxJywgdGl0bGU6ICdGaXJzdCB0YXNrJywgZG9uZTogdHJ1ZSB9LCAgIC8vIGNoZWNrZWQgYnV0IERCIHNheXMgcGVuZGluZ1xuICAgICAgeyBpZDogJ1QwMicsIHRpdGxlOiAnU2Vjb25kIHRhc2snLCBkb25lOiBmYWxzZSB9LCAgLy8gdW5jaGVja2VkIGJ1dCBEQiBzYXlzIGRvbmVcbiAgICBdKTtcbiAgICBjb25zdCBwbGFuUGF0aCA9IHBhdGguam9pbih0bXBEaXIsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScsICdzbGljZXMnLCAnUzAxJywgJ1MwMS1QTEFOLm1kJyk7XG4gICAgZnMud3JpdGVGaWxlU3luYyhwbGFuUGF0aCwgcGxhbkNvbnRlbnQpO1xuICAgIGNsZWFyQWxsQ2FjaGVzKCk7XG5cbiAgICBjb25zdCBvayA9IGF3YWl0IHJlbmRlclBsYW5DaGVja2JveGVzKHRtcERpciwgJ00wMDEnLCAnUzAxJyk7XG4gICAgYXNzZXJ0Lm9rKG9rLCAnYmlkaXJlY3Rpb25hbCBwbGFuIHJlbmRlciByZXR1cm5zIHRydWUnKTtcblxuICAgIGNvbnN0IHJlbmRlcmVkID0gZnMucmVhZEZpbGVTeW5jKHBsYW5QYXRoLCAndXRmLTgnKTtcbiAgICBjbGVhckFsbENhY2hlcygpO1xuICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlUGxhbihyZW5kZXJlZCk7XG5cbiAgICBjb25zdCB0MDEgPSBwYXJzZWQudGFza3MuZmluZCh0ID0+IHQuaWQgPT09ICdUMDEnKTtcbiAgICBjb25zdCB0MDIgPSBwYXJzZWQudGFza3MuZmluZCh0ID0+IHQuaWQgPT09ICdUMDInKTtcbiAgICBhc3NlcnQub2soIXQwMSEuZG9uZSwgJ1QwMSB1bmNoZWNrZWQgKERCIHNheXMgcGVuZGluZywgd2FzIGNoZWNrZWQpJyk7XG4gICAgYXNzZXJ0Lm9rKHQwMiEuZG9uZSwgJ1QwMiBjaGVja2VkIChEQiBzYXlzIGRvbmUsIHdhcyB1bmNoZWNrZWQpJyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIGNsZWFudXBEaXIodG1wRGlyKTtcbiAgfVxufSk7XG5cbnRlc3QoJ1x1MjUwMFx1MjUwMCBtYXJrZG93bi1yZW5kZXJlcjogcmVuZGVyUGxhbkZyb21EYiBjcmVhdGVzIHBhcnNlLWNvbXBhdGlibGUgc2xpY2UgcGxhbiArIHRhc2sgcGxhbiBmaWxlcyBcdTI1MDBcdTI1MDAnLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHRtcERpciA9IG1ha2VUbXBEaXIoKTtcbiAgY29uc3QgZGJQYXRoID0gcGF0aC5qb2luKHRtcERpciwgJy5nc2QnLCAnZ3NkLmRiJyk7XG4gIG9wZW5EYXRhYmFzZShkYlBhdGgpO1xuICBjbGVhckFsbENhY2hlcygpO1xuXG4gIHRyeSB7XG4gICAgc2NhZmZvbGREaXJzKHRtcERpciwgJ00wMDEnLCBbJ1MwMiddKTtcblxuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiAnTTAwMScsIHRpdGxlOiAnTWlsZXN0b25lJywgc3RhdHVzOiAnYWN0aXZlJyB9KTtcbiAgICBpbnNlcnRTbGljZSh7XG4gICAgICBpZDogJ1MwMicsXG4gICAgICBtaWxlc3RvbmVJZDogJ00wMDEnLFxuICAgICAgdGl0bGU6ICdEQi1iYWNrZWQgcGxhbm5pbmcnLFxuICAgICAgc3RhdHVzOiAncGVuZGluZycsXG4gICAgICBkZW1vOiAnUmVuZGVyZWQgcGxhbnMgZXhpc3Qgb24gZGlzay4nLFxuICAgICAgcGxhbm5pbmc6IHtcbiAgICAgICAgZ29hbDogJ1JlbmRlciBzbGljZSBwbGFucyBmcm9tIERCIHN0YXRlLicsXG4gICAgICAgIHN1Y2Nlc3NDcml0ZXJpYTogJy0gU2xpY2UgcGxhbiBzdGF5cyBwYXJzZS1jb21wYXRpYmxlXFxuLSBUYXNrIHBsYW4gZmlsZXMgYXJlIHJlZ2VuZXJhdGVkJyxcbiAgICAgICAgcHJvb2ZMZXZlbDogJ2ludGVncmF0aW9uJyxcbiAgICAgICAgaW50ZWdyYXRpb25DbG9zdXJlOiAnV2lyZXMgREIgcGxhbm5pbmcgcm93cyB0byBtYXJrZG93biBhcnRpZmFjdHMuJyxcbiAgICAgICAgb2JzZXJ2YWJpbGl0eUltcGFjdDogJy0gUnVuIHJlbmRlcmVyIGNvbnRyYWN0IHRlc3RzXFxuLSBJbnNwZWN0IHN0YWxlLXJlbmRlciBkaWFnbm9zdGljcyBvbiBtaXNtYXRjaCcsXG4gICAgICB9LFxuICAgIH0pO1xuICAgIGluc2VydFRhc2soe1xuICAgICAgaWQ6ICdUMDEnLFxuICAgICAgc2xpY2VJZDogJ1MwMicsXG4gICAgICBtaWxlc3RvbmVJZDogJ00wMDEnLFxuICAgICAgdGl0bGU6ICdSZW5kZXIgc2xpY2UgcGxhbicsXG4gICAgICBzdGF0dXM6ICdwZW5kaW5nJyxcbiAgICAgIHBsYW5uaW5nOiB7XG4gICAgICAgIGRlc2NyaXB0aW9uOiAnSW1wbGVtZW50IHRoZSBEQi1iYWNrZWQgc2xpY2UgcGxhbiByZW5kZXJlci4nLFxuICAgICAgICBlc3RpbWF0ZTogJzQ1bScsXG4gICAgICAgIGZpbGVzOiBbJ3NyYy9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvbWFya2Rvd24tcmVuZGVyZXIudHMnXSxcbiAgICAgICAgdmVyaWZ5OiAnbm9kZSAtLXRlc3QgbWFya2Rvd24tcmVuZGVyZXIudGVzdC50cycsXG4gICAgICAgIGlucHV0czogWydzcmMvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL21hcmtkb3duLXJlbmRlcmVyLnRzJ10sXG4gICAgICAgIGV4cGVjdGVkT3V0cHV0OiBbJ3NyYy9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvdGVzdHMvbWFya2Rvd24tcmVuZGVyZXIudGVzdC50cyddLFxuICAgICAgICBvYnNlcnZhYmlsaXR5SW1wYWN0OiAnUmVuZGVyZXIgdGVzdHMgY292ZXIgc3RhbGUgcmVuZGVyIGZhaWx1cmUgcGF0aHMuJyxcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgaW5zZXJ0VGFzayh7XG4gICAgICBpZDogJ1QwMicsXG4gICAgICBzbGljZUlkOiAnUzAyJyxcbiAgICAgIG1pbGVzdG9uZUlkOiAnTTAwMScsXG4gICAgICB0aXRsZTogJ1JlbmRlciB0YXNrIHBsYW4nLFxuICAgICAgc3RhdHVzOiAncGVuZGluZycsXG4gICAgICBwbGFubmluZzoge1xuICAgICAgICBkZXNjcmlwdGlvbjogJ0VtaXQgdGhlIHRhc2sgcGxhbiBmaWxlIHdpdGggY29uc2VydmF0aXZlIGZyb250bWF0dGVyLicsXG4gICAgICAgIGVzdGltYXRlOiAnMzBtJyxcbiAgICAgICAgZmlsZXM6IFsnc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9maWxlcy50cyddLFxuICAgICAgICB2ZXJpZnk6ICdub2RlIC0tdGVzdCBhdXRvLXJlY292ZXJ5LnRlc3QudHMnLFxuICAgICAgICBpbnB1dHM6IFsnc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9maWxlcy50cyddLFxuICAgICAgICBleHBlY3RlZE91dHB1dDogWydzcmMvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL3Rlc3RzL2F1dG8tcmVjb3ZlcnkudGVzdC50cyddLFxuICAgICAgICBvYnNlcnZhYmlsaXR5SW1wYWN0OiAnTWlzc2luZyB0YXNrLXBsYW4gZmlsZXMgZmFpbCByZWNvdmVyeSB2ZXJpZmljYXRpb24uJyxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBjb25zdCByZW5kZXJlZCA9IGF3YWl0IHJlbmRlclBsYW5Gcm9tRGIodG1wRGlyLCAnTTAwMScsICdTMDInKTtcbiAgICBhc3NlcnQub2soZnMuZXhpc3RzU3luYyhyZW5kZXJlZC5wbGFuUGF0aCksICdzbGljZSBwbGFuIHdyaXR0ZW4gdG8gZGlzaycpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChyZW5kZXJlZC50YXNrUGxhblBhdGhzLmxlbmd0aCwgMiwgJ3Rhc2sgcGxhbiBwYXRocyByZXR1cm5lZCBmb3IgZWFjaCB0YXNrJyk7XG4gICAgYXNzZXJ0Lm9rKHJlbmRlcmVkLnRhc2tQbGFuUGF0aHMuZXZlcnkoKHApID0+IGZzLmV4aXN0c1N5bmMocCkpLCAnYWxsIHRhc2sgcGxhbiBmaWxlcyB3cml0dGVuIHRvIGRpc2snKTtcblxuICAgIGNvbnN0IHBsYW5Db250ZW50ID0gZnMucmVhZEZpbGVTeW5jKHJlbmRlcmVkLnBsYW5QYXRoLCAndXRmLTgnKTtcbiAgICBjbGVhckFsbENhY2hlcygpO1xuICAgIGNvbnN0IHBhcnNlZFBsYW4gPSBwYXJzZVBsYW4ocGxhbkNvbnRlbnQpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChwYXJzZWRQbGFuLmlkLCAnUzAyJywgJ3JlbmRlcmVkIHNsaWNlIHBsYW4gcGFyc2VzIHdpdGggY29ycmVjdCBzbGljZSBpZCcpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChwYXJzZWRQbGFuLmdvYWwsICdSZW5kZXIgc2xpY2UgcGxhbnMgZnJvbSBEQiBzdGF0ZS4nLCAncmVuZGVyZWQgc2xpY2UgcGxhbiBwcmVzZXJ2ZXMgZ29hbCcpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChwYXJzZWRQbGFuLmRlbW8sICdSZW5kZXJlZCBwbGFucyBleGlzdCBvbiBkaXNrLicsICdyZW5kZXJlZCBzbGljZSBwbGFuIHByZXNlcnZlcyBkZW1vJyk7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHBhcnNlZFBsYW4ubXVzdEhhdmVzLmxlbmd0aCwgMiwgJ3JlbmRlcmVkIHNsaWNlIHBsYW4gZXhwb3NlcyBtdXN0LWhhdmVzJyk7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHBhcnNlZFBsYW4udGFza3MubGVuZ3RoLCAyLCAncmVuZGVyZWQgc2xpY2UgcGxhbiBleHBvc2VzIGFsbCB0YXNrcycpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChwYXJzZWRQbGFuLnRhc2tzWzBdLmlkLCAnVDAxJywgJ2ZpcnN0IHRhc2sgcGFyc2VzIGNvcnJlY3RseScpO1xuICAgIGFzc2VydC5vayhwYXJzZWRQbGFuLnRhc2tzWzBdLmRlc2NyaXB0aW9uLmluY2x1ZGVzKCdEQi1iYWNrZWQgc2xpY2UgcGxhbiByZW5kZXJlcicpLCAndGFzayBkZXNjcmlwdGlvbiBwcmVzZXJ2ZWQgaW4gc2xpY2UgcGxhbicpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChwYXJzZWRQbGFuLnRhc2tzWzBdLmZpbGVzPy5bMF0sICdzcmMvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL21hcmtkb3duLXJlbmRlcmVyLnRzJywgJ2ZpbGVzIGxpc3QgcHJlc2VydmVkIGluIHNsaWNlIHBsYW4nKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwocGFyc2VkUGxhbi50YXNrc1swXS52ZXJpZnksICdub2RlIC0tdGVzdCBtYXJrZG93bi1yZW5kZXJlci50ZXN0LnRzJywgJ3ZlcmlmeSBsaW5lIHByZXNlcnZlZCBpbiBzbGljZSBwbGFuJyk7XG5cbiAgICBjb25zdCBwbGFuQXJ0aWZhY3QgPSBnZXRBcnRpZmFjdCgnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDIvUzAyLVBMQU4ubWQnKTtcbiAgICBhc3NlcnQub2socGxhbkFydGlmYWN0ICE9PSBudWxsLCAnc2xpY2UgcGxhbiBhcnRpZmFjdCBzdG9yZWQgaW4gREInKTtcbiAgICBhc3NlcnQub2socGxhbkFydGlmYWN0IS5mdWxsX2NvbnRlbnQuaW5jbHVkZXMoJyMjIFRhc2tzJyksICdzdG9yZWQgcGxhbiBhcnRpZmFjdCBjb250YWlucyB0YXNrIHNlY3Rpb24nKTtcblxuICAgIGNvbnN0IHRhc2tQbGFuUGF0aCA9IHBhdGguam9pbih0bXBEaXIsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScsICdzbGljZXMnLCAnUzAyJywgJ3Rhc2tzJywgJ1QwMS1QTEFOLm1kJyk7XG4gICAgY29uc3QgdGFza1BsYW5Db250ZW50ID0gZnMucmVhZEZpbGVTeW5jKHRhc2tQbGFuUGF0aCwgJ3V0Zi04Jyk7XG4gICAgY29uc3QgdGFza1BsYW5GaWxlID0gcGFyc2VUYXNrUGxhbkZpbGUodGFza1BsYW5Db250ZW50KTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwodGFza1BsYW5GaWxlLmZyb250bWF0dGVyLmVzdGltYXRlZF9zdGVwcywgMSwgJ3Rhc2sgcGxhbiBmcm9udG1hdHRlciBleHBvc2VzIGVzdGltYXRlZF9zdGVwcycpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbCh0YXNrUGxhbkZpbGUuZnJvbnRtYXR0ZXIuZXN0aW1hdGVkX2ZpbGVzLCAxLCAndGFzayBwbGFuIGZyb250bWF0dGVyIGV4cG9zZXMgZXN0aW1hdGVkX2ZpbGVzJyk7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHRhc2tQbGFuRmlsZS5mcm9udG1hdHRlci5za2lsbHNfdXNlZC5sZW5ndGgsIDAsICd0YXNrIHBsYW4gZnJvbnRtYXR0ZXIgdXNlcyBjb25zZXJ2YXRpdmUgZW1wdHkgc2tpbGxzIGxpc3QnKTtcbiAgICBhc3NlcnQubWF0Y2godGFza1BsYW5Db250ZW50LCAvXiMgVDAxOiBSZW5kZXIgc2xpY2UgcGxhbi9tLCAndGFzayBwbGFuIHJlbmRlcnMgdGFzayBoZWFkaW5nJyk7XG4gICAgYXNzZXJ0Lm1hdGNoKHRhc2tQbGFuQ29udGVudCwgL14jIyBJbnB1dHMkL20sICd0YXNrIHBsYW4gcmVuZGVycyBJbnB1dHMgc2VjdGlvbicpO1xuICAgIGFzc2VydC5tYXRjaCh0YXNrUGxhbkNvbnRlbnQsIC9eIyMgRXhwZWN0ZWQgT3V0cHV0JC9tLCAndGFzayBwbGFuIHJlbmRlcnMgRXhwZWN0ZWQgT3V0cHV0IHNlY3Rpb24nKTtcbiAgICBhc3NlcnQubWF0Y2godGFza1BsYW5Db250ZW50LCAvXiMjIFZlcmlmaWNhdGlvbiQvbSwgJ3Rhc2sgcGxhbiByZW5kZXJzIFZlcmlmaWNhdGlvbiBzZWN0aW9uJyk7XG5cbiAgICBjb25zdCB0YXNrQXJ0aWZhY3QgPSBnZXRBcnRpZmFjdCgnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDIvdGFza3MvVDAxLVBMQU4ubWQnKTtcbiAgICBhc3NlcnQub2sodGFza0FydGlmYWN0ICE9PSBudWxsLCAndGFzayBwbGFuIGFydGlmYWN0IHN0b3JlZCBpbiBEQicpO1xuICAgIGFzc2VydC5vayh0YXNrQXJ0aWZhY3QhLmZ1bGxfY29udGVudC5pbmNsdWRlcygnc2tpbGxzX3VzZWQ6IFtdJyksICdzdG9yZWQgdGFzayBwbGFuIGFydGlmYWN0IHByZXNlcnZlcyBjb25zZXJ2YXRpdmUgc2tpbGxzX3VzZWQnKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgY2xlYW51cERpcih0bXBEaXIpO1xuICB9XG59KTtcblxudGVzdCgnXHUyNTAwXHUyNTAwIG1hcmtkb3duLXJlbmRlcmVyOiBzbGljZSBwbGFuIHN1bW1hcml6ZXMgdGFzayBkZXNjcmlwdGlvbnMgd2l0aG91dCBsZWFraW5nIG5lc3RlZCBoZWFkaW5ncyBcdTI1MDBcdTI1MDAnLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHRtcERpciA9IG1ha2VUbXBEaXIoKTtcbiAgY29uc3QgZGJQYXRoID0gcGF0aC5qb2luKHRtcERpciwgJy5nc2QnLCAnZ3NkLmRiJyk7XG4gIG9wZW5EYXRhYmFzZShkYlBhdGgpO1xuICBjbGVhckFsbENhY2hlcygpO1xuXG4gIHRyeSB7XG4gICAgc2NhZmZvbGREaXJzKHRtcERpciwgJ00wMDEnLCBbJ1MwMSddKTtcblxuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiAnTTAwMScsIHRpdGxlOiAnTWlsZXN0b25lJywgc3RhdHVzOiAnYWN0aXZlJyB9KTtcbiAgICBpbnNlcnRTbGljZSh7XG4gICAgICBpZDogJ1MwMScsXG4gICAgICBtaWxlc3RvbmVJZDogJ00wMDEnLFxuICAgICAgdGl0bGU6ICdXb3JraW5nIGFwcCcsXG4gICAgICBzdGF0dXM6ICdwZW5kaW5nJyxcbiAgICAgIGRlbW86ICdUaGUgYXBwIHdvcmtzLicsXG4gICAgICBwbGFubmluZzoge1xuICAgICAgICBnb2FsOiAnQnVpbGQgYSBzbWFsbCBhcHAuJyxcbiAgICAgICAgc3VjY2Vzc0NyaXRlcmlhOiAnTm90IHByb3ZpZGVkLicsXG4gICAgICAgIHByb29mTGV2ZWw6ICdOb3QgcHJvdmlkZWQuJyxcbiAgICAgICAgaW50ZWdyYXRpb25DbG9zdXJlOiAnTi9BJyxcbiAgICAgICAgb2JzZXJ2YWJpbGl0eUltcGFjdDogJ05vbmUnLFxuICAgICAgfSxcbiAgICB9KTtcbiAgICBpbnNlcnRUYXNrKHtcbiAgICAgIGlkOiAnVDAxJyxcbiAgICAgIHNsaWNlSWQ6ICdTMDEnLFxuICAgICAgbWlsZXN0b25lSWQ6ICdNMDAxJyxcbiAgICAgIHRpdGxlOiAnQnVpbGQgYXBwJyxcbiAgICAgIHN0YXR1czogJ3BlbmRpbmcnLFxuICAgICAgcGxhbm5pbmc6IHtcbiAgICAgICAgZGVzY3JpcHRpb246IFtcbiAgICAgICAgICAnQ3JlYXRlIHRoZSBzdGF0aWMgYXBwIGZpbGVzLicsXG4gICAgICAgICAgJycsXG4gICAgICAgICAgJyMjIFN0ZXBzJyxcbiAgICAgICAgICAnJyxcbiAgICAgICAgICAnLSBDcmVhdGUgdGhlIEhUTUwgc2hlbGwuJyxcbiAgICAgICAgICAnLSBXaXJlIGJyb3dzZXIgc3RvcmFnZS4nLFxuICAgICAgICAgICcnLFxuICAgICAgICAgICcjIyBNdXN0LUhhdmVzJyxcbiAgICAgICAgICAnJyxcbiAgICAgICAgICAnLSBBZGRpbmcgYW4gaXRlbSB1cGRhdGVzIHRoZSBsaXN0LicsXG4gICAgICAgIF0uam9pbignXFxuJyksXG4gICAgICAgIGVzdGltYXRlOiAnMzBtJyxcbiAgICAgICAgZmlsZXM6IFsnaW5kZXguaHRtbCcsICdhcHAuanMnLCAnc3R5bGUuY3NzJ10sXG4gICAgICAgIHZlcmlmeTogJ29wZW4gaW5kZXguaHRtbCcsXG4gICAgICAgIGlucHV0czogWycuZ2l0aWdub3JlJ10sXG4gICAgICAgIGV4cGVjdGVkT3V0cHV0OiBbJ2luZGV4Lmh0bWwnLCAnYXBwLmpzJywgJ3N0eWxlLmNzcyddLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHJlbmRlcmVkID0gYXdhaXQgcmVuZGVyUGxhbkZyb21EYih0bXBEaXIsICdNMDAxJywgJ1MwMScpO1xuICAgIGNvbnN0IHBsYW5Db250ZW50ID0gZnMucmVhZEZpbGVTeW5jKHJlbmRlcmVkLnBsYW5QYXRoLCAndXRmLTgnKTtcbiAgICBjbGVhckFsbENhY2hlcygpO1xuICAgIGNvbnN0IHBhcnNlZFBsYW4gPSBwYXJzZVBsYW4ocGxhbkNvbnRlbnQpO1xuXG4gICAgYXNzZXJ0LmRvZXNOb3RNYXRjaChwbGFuQ29udGVudCwgL05vdCBwcm92aWRlZC9pLCAncGxhY2Vob2xkZXIgdmFsdWVzIHNob3VsZCBub3QgcmVuZGVyJyk7XG4gICAgYXNzZXJ0LmRvZXNOb3RNYXRjaChwbGFuQ29udGVudCwgL14jIyBTdGVwcyQvbSwgJ3Rhc2sgZGV0YWlsIGhlYWRpbmdzIG11c3Qgbm90IGVzY2FwZSBpbnRvIHRoZSBzbGljZSBwbGFuJyk7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKChwbGFuQ29udGVudC5tYXRjaCgvXiMjIE11c3QtSGF2ZXMkL2dtKSA/PyBbXSkubGVuZ3RoLCAxLCAnc2xpY2UgcGxhbiBoYXMgb25seSBpdHMgb3duIE11c3QtSGF2ZXMgaGVhZGluZycpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChwYXJzZWRQbGFuLnRhc2tzWzBdLmRlc2NyaXB0aW9uLnRyaW0oKSwgJ0NyZWF0ZSB0aGUgc3RhdGljIGFwcCBmaWxlcy4nKTtcblxuICAgIGNvbnN0IHRhc2tQbGFuQ29udGVudCA9IGZzLnJlYWRGaWxlU3luYyhwYXRoLmpvaW4odG1wRGlyLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgJ00wMDEnLCAnc2xpY2VzJywgJ1MwMScsICd0YXNrcycsICdUMDEtUExBTi5tZCcpLCAndXRmLTgnKTtcbiAgICBhc3NlcnQubWF0Y2godGFza1BsYW5Db250ZW50LCAvXiMjIFN0ZXBzJC9tLCAndGFzayBwbGFuIGtlZXBzIGRldGFpbGVkIGhlYWRpbmdzIGZvciBleGVjdXRvcnMnKTtcbiAgICBhc3NlcnQubWF0Y2godGFza1BsYW5Db250ZW50LCAvXiMjIE11c3QtSGF2ZXMkL20sICd0YXNrIHBsYW4ga2VlcHMgZGV0YWlsZWQgdGFzayBtdXN0LWhhdmVzJyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIGNsZWFudXBEaXIodG1wRGlyKTtcbiAgfVxufSk7XG5cbnRlc3QoJ1x1MjUwMFx1MjUwMCBtYXJrZG93bi1yZW5kZXJlcjogcmVuZGVyVGFza1BsYW5Gcm9tRGIgdGhyb3dzIGZvciBtaXNzaW5nIHRhc2sgXHUyNTAwXHUyNTAwJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB0bXBEaXIgPSBtYWtlVG1wRGlyKCk7XG4gIGNvbnN0IGRiUGF0aCA9IHBhdGguam9pbih0bXBEaXIsICcuZ3NkJywgJ2dzZC5kYicpO1xuICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcbiAgY2xlYXJBbGxDYWNoZXMoKTtcblxuICB0cnkge1xuICAgIHNjYWZmb2xkRGlycyh0bXBEaXIsICdNMDAxJywgWydTMDInXSk7XG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgdGl0bGU6ICdNaWxlc3RvbmUnLCBzdGF0dXM6ICdhY3RpdmUnIH0pO1xuICAgIGluc2VydFNsaWNlKHsgaWQ6ICdTMDInLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ1NsaWNlJywgc3RhdHVzOiAncGVuZGluZycgfSk7XG5cbiAgICBsZXQgdGhyZXcgPSBmYWxzZTtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgcmVuZGVyVGFza1BsYW5Gcm9tRGIodG1wRGlyLCAnTTAwMScsICdTMDInLCAnVDk5Jyk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIHRocmV3ID0gdHJ1ZTtcbiAgICAgIGFzc2VydC5tYXRjaChTdHJpbmcoKGVycm9yIGFzIEVycm9yKS5tZXNzYWdlKSwgL3Rhc2sgTTAwMVxcL1MwMlxcL1Q5OSBub3QgZm91bmQvLCAncmVuZGVyVGFza1BsYW5Gcm9tRGIgc2hvdWxkIGZhaWwgY2xlYXJseSB3aGVuIHRhc2sgcm93IGlzIG1pc3NpbmcnKTtcbiAgICB9XG4gICAgYXNzZXJ0Lm9rKHRocmV3LCAncmVuZGVyVGFza1BsYW5Gcm9tRGIgdGhyb3dzIHdoZW4gdGhlIHRhc2sgcm93IGlzIG1pc3NpbmcnKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgY2xlYW51cERpcih0bXBEaXIpO1xuICB9XG59KTtcblxuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIFRhc2sgU3VtbWFyeSBSZW5kZXJpbmdcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG50ZXN0KCdcdTI1MDBcdTI1MDAgbWFya2Rvd24tcmVuZGVyZXI6IHJlbmRlclRhc2tTdW1tYXJ5IHJvdW5kLXRyaXAgXHUyNTAwXHUyNTAwJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB0bXBEaXIgPSBtYWtlVG1wRGlyKCk7XG4gIGNvbnN0IGRiUGF0aCA9IHBhdGguam9pbih0bXBEaXIsICcuZ3NkJywgJ2dzZC5kYicpO1xuICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcbiAgY2xlYXJBbGxDYWNoZXMoKTtcblxuICB0cnkge1xuICAgIHNjYWZmb2xkRGlycyh0bXBEaXIsICdNMDAxJywgWydTMDEnXSk7XG5cbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogJ00wMDEnLCB0aXRsZTogJ1Rlc3QnLCBzdGF0dXM6ICdhY3RpdmUnIH0pO1xuICAgIGluc2VydFNsaWNlKHsgaWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ1NsaWNlJywgc3RhdHVzOiAncGVuZGluZycgfSk7XG5cbiAgICBjb25zdCBzdW1tYXJ5Q29udGVudCA9IG1ha2VUYXNrU3VtbWFyeUNvbnRlbnQoJ1QwMScpO1xuICAgIGluc2VydFRhc2soe1xuICAgICAgaWQ6ICdUMDEnLFxuICAgICAgc2xpY2VJZDogJ1MwMScsXG4gICAgICBtaWxlc3RvbmVJZDogJ00wMDEnLFxuICAgICAgdGl0bGU6ICdUZXN0IFRhc2snLFxuICAgICAgc3RhdHVzOiAnZG9uZScsXG4gICAgICBmdWxsU3VtbWFyeU1kOiBzdW1tYXJ5Q29udGVudCxcbiAgICB9KTtcblxuICAgIGNvbnN0IG9rID0gYXdhaXQgcmVuZGVyVGFza1N1bW1hcnkodG1wRGlyLCAnTTAwMScsICdTMDEnLCAnVDAxJyk7XG4gICAgYXNzZXJ0Lm9rKG9rLCAncmVuZGVyVGFza1N1bW1hcnkgcmV0dXJucyB0cnVlJyk7XG5cbiAgICAvLyBWZXJpZnkgZmlsZSBleGlzdHMgb24gZGlza1xuICAgIGNvbnN0IHN1bW1hcnlQYXRoID0gcGF0aC5qb2luKFxuICAgICAgdG1wRGlyLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgJ00wMDEnLCAnc2xpY2VzJywgJ1MwMScsICd0YXNrcycsICdUMDEtU1VNTUFSWS5tZCcsXG4gICAgKTtcbiAgICBhc3NlcnQub2soZnMuZXhpc3RzU3luYyhzdW1tYXJ5UGF0aCksICdUMDEtU1VNTUFSWS5tZCB3cml0dGVuIHRvIGRpc2snKTtcblxuICAgIC8vIFBhcnNlIGFuZCB2ZXJpZnlcbiAgICBjb25zdCByZW5kZXJlZCA9IGZzLnJlYWRGaWxlU3luYyhzdW1tYXJ5UGF0aCwgJ3V0Zi04Jyk7XG4gICAgY2xlYXJBbGxDYWNoZXMoKTtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVN1bW1hcnkocmVuZGVyZWQpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGFyc2VkLmZyb250bWF0dGVyLmlkLCAnVDAxJywgJ3BhcnNlZCBzdW1tYXJ5IGhhcyBjb3JyZWN0IGlkJyk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwYXJzZWQuZnJvbnRtYXR0ZXIucGFyZW50LCAnUzAxJywgJ3BhcnNlZCBzdW1tYXJ5IGhhcyBjb3JyZWN0IHBhcmVudCcpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGFyc2VkLmZyb250bWF0dGVyLm1pbGVzdG9uZSwgJ00wMDEnLCAncGFyc2VkIHN1bW1hcnkgaGFzIGNvcnJlY3QgbWlsZXN0b25lJyk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwYXJzZWQuZnJvbnRtYXR0ZXIuZHVyYXRpb24sICc0NW0nLCAncGFyc2VkIHN1bW1hcnkgaGFzIGNvcnJlY3QgZHVyYXRpb24nKTtcbiAgICBhc3NlcnQub2socGFyc2VkLnRpdGxlLmluY2x1ZGVzKCdUMDEnKSwgJ3BhcnNlZCBzdW1tYXJ5IHRpdGxlIGNvbnRhaW5zIHRhc2sgSUQnKTtcbiAgICBhc3NlcnQub2socGFyc2VkLndoYXRIYXBwZW5lZC5pbmNsdWRlcygnQnVpbHQgdGhlIHRlc3QgZmVhdHVyZScpLCAnd2hhdEhhcHBlbmVkIGNvbnRlbnQgcHJlc2VydmVkJyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIGNsZWFudXBEaXIodG1wRGlyKTtcbiAgfVxufSk7XG5cbnRlc3QoJ1x1MjUwMFx1MjUwMCBtYXJrZG93bi1yZW5kZXJlcjogcmVuZGVyVGFza1N1bW1hcnkgc2tpcHMgZW1wdHkgXHUyNTAwXHUyNTAwJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB0bXBEaXIgPSBtYWtlVG1wRGlyKCk7XG4gIGNvbnN0IGRiUGF0aCA9IHBhdGguam9pbih0bXBEaXIsICcuZ3NkJywgJ2dzZC5kYicpO1xuICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcbiAgY2xlYXJBbGxDYWNoZXMoKTtcblxuICB0cnkge1xuICAgIHNjYWZmb2xkRGlycyh0bXBEaXIsICdNMDAxJywgWydTMDEnXSk7XG5cbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogJ00wMDEnLCB0aXRsZTogJ1Rlc3QnLCBzdGF0dXM6ICdhY3RpdmUnIH0pO1xuICAgIGluc2VydFNsaWNlKHsgaWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ1NsaWNlJywgc3RhdHVzOiAncGVuZGluZycgfSk7XG4gICAgaW5zZXJ0VGFzayh7XG4gICAgICBpZDogJ1QwMScsXG4gICAgICBzbGljZUlkOiAnUzAxJyxcbiAgICAgIG1pbGVzdG9uZUlkOiAnTTAwMScsXG4gICAgICB0aXRsZTogJ1Rhc2sgd2l0aG91dCBzdW1tYXJ5JyxcbiAgICAgIHN0YXR1czogJ3BlbmRpbmcnLFxuICAgICAgZnVsbFN1bW1hcnlNZDogJycsIC8vIGVtcHR5IHN1bW1hcnlcbiAgICB9KTtcblxuICAgIGNvbnN0IG9rID0gYXdhaXQgcmVuZGVyVGFza1N1bW1hcnkodG1wRGlyLCAnTTAwMScsICdTMDEnLCAnVDAxJyk7XG4gICAgYXNzZXJ0Lm9rKCFvaywgJ3JlbmRlclRhc2tTdW1tYXJ5IHJldHVybnMgZmFsc2UgZm9yIGVtcHR5IHN1bW1hcnknKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgY2xlYW51cERpcih0bXBEaXIpO1xuICB9XG59KTtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBTbGljZSBTdW1tYXJ5IFJlbmRlcmluZ1xuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbnRlc3QoJ1x1MjUwMFx1MjUwMCBtYXJrZG93bi1yZW5kZXJlcjogcmVuZGVyU2xpY2VTdW1tYXJ5IHJvdW5kLXRyaXAgXHUyNTAwXHUyNTAwJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB0bXBEaXIgPSBtYWtlVG1wRGlyKCk7XG4gIGNvbnN0IGRiUGF0aCA9IHBhdGguam9pbih0bXBEaXIsICcuZ3NkJywgJ2dzZC5kYicpO1xuICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcbiAgY2xlYXJBbGxDYWNoZXMoKTtcblxuICB0cnkge1xuICAgIHNjYWZmb2xkRGlycyh0bXBEaXIsICdNMDAxJywgWydTMDEnXSk7XG5cbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogJ00wMDEnLCB0aXRsZTogJ1Rlc3QnLCBzdGF0dXM6ICdhY3RpdmUnIH0pO1xuICAgIGluc2VydFNsaWNlKHsgaWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ1NsaWNlJywgc3RhdHVzOiAnY29tcGxldGUnIH0pO1xuXG4gICAgLy8gVXBkYXRlIHNsaWNlIHdpdGggc3VtbWFyeSBhbmQgVUFUIGNvbnRlbnRcbiAgICAvLyBTaW5jZSBpbnNlcnRTbGljZSB1c2VzIElOU0VSVCBPUiBJR05PUkUsIHdlIG5lZWQgdG8gc2V0IHRoZSBjb250ZW50IHZpYSByYXcgYWRhcHRlclxuICAgIGNvbnN0IGRiID0gYXdhaXQgaW1wb3J0KCcuLi9nc2QtZGIudHMnKTtcbiAgICBjb25zdCBhZGFwdGVyID0gZGIuX2dldEFkYXB0ZXIoKSE7XG4gICAgYWRhcHRlci5wcmVwYXJlKFxuICAgICAgYFVQREFURSBzbGljZXMgU0VUIGZ1bGxfc3VtbWFyeV9tZCA9IDpzbSwgZnVsbF91YXRfbWQgPSA6dW0gV0hFUkUgbWlsZXN0b25lX2lkID0gJ00wMDEnIEFORCBpZCA9ICdTMDEnYCxcbiAgICApLnJ1bih7XG4gICAgICAnOnNtJzogJy0tLVxcbmlkOiBTMDFcXG5wYXJlbnQ6IE0wMDFcXG5taWxlc3RvbmU6IE0wMDFcXG5kdXJhdGlvbjogMmhcXG52ZXJpZmljYXRpb25fcmVzdWx0OiBhbGwtcGFzc1xcbmNvbXBsZXRlZF9hdDogMjAyNS0wMS0wMVxcbmJsb2NrZXJfZGlzY292ZXJlZDogZmFsc2VcXG5wcm92aWRlczogW11cXG5yZXF1aXJlczogW11cXG5hZmZlY3RzOiBbXVxcbmtleV9maWxlczpcXG4gIC0gc3JjL2luZGV4LnRzXFxua2V5X2RlY2lzaW9uczogW11cXG5wYXR0ZXJuc19lc3RhYmxpc2hlZDogW11cXG5kcmlsbF9kb3duX3BhdGhzOiBbXVxcbm9ic2VydmFiaWxpdHlfc3VyZmFjZXM6IFtdXFxuLS0tXFxuXFxuIyBTMDE6IFRlc3QgU2xpY2UgU3VtbWFyeVxcblxcbioqQ29tcGxldGVkIGNvcmUgZnVuY3Rpb25hbGl0eSoqXFxuXFxuIyMgV2hhdCBIYXBwZW5lZFxcblxcbkJ1aWx0IHRoZSBzbGljZS5cXG5cXG4jIyBEZXZpYXRpb25zXFxuXFxuTm9uZS5cXG4nLFxuICAgICAgJzp1bSc6ICcjIFMwMSBVQVRcXG5cXG4jIyBVQVQgVHlwZVxcblxcbi0gVUFUIG1vZGU6IGFydGlmYWN0LWRyaXZlblxcblxcbiMjIENoZWNrc1xcblxcbi0gQWxsIHRlc3RzIHBhc3NcXG4nLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgb2sgPSBhd2FpdCByZW5kZXJTbGljZVN1bW1hcnkodG1wRGlyLCAnTTAwMScsICdTMDEnKTtcbiAgICBhc3NlcnQub2sob2ssICdyZW5kZXJTbGljZVN1bW1hcnkgcmV0dXJucyB0cnVlJyk7XG5cbiAgICAvLyBWZXJpZnkgU1VNTUFSWSBmaWxlXG4gICAgY29uc3Qgc3VtbWFyeVBhdGggPSBwYXRoLmpvaW4oXG4gICAgICB0bXBEaXIsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScsICdzbGljZXMnLCAnUzAxJywgJ1MwMS1TVU1NQVJZLm1kJyxcbiAgICApO1xuICAgIGFzc2VydC5vayhmcy5leGlzdHNTeW5jKHN1bW1hcnlQYXRoKSwgJ1MwMS1TVU1NQVJZLm1kIHdyaXR0ZW4gdG8gZGlzaycpO1xuXG4gICAgY29uc3Qgc3VtbWFyeUNvbnRlbnQgPSBmcy5yZWFkRmlsZVN5bmMoc3VtbWFyeVBhdGgsICd1dGYtOCcpO1xuICAgIGFzc2VydC5vayhzdW1tYXJ5Q29udGVudC5pbmNsdWRlcygnVGVzdCBTbGljZSBTdW1tYXJ5JyksICdzdW1tYXJ5IGNvbnRlbnQgY29ycmVjdCcpO1xuXG4gICAgLy8gVmVyaWZ5IFVBVCBmaWxlXG4gICAgY29uc3QgdWF0UGF0aCA9IHBhdGguam9pbihcbiAgICAgIHRtcERpciwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAxJywgJ3NsaWNlcycsICdTMDEnLCAnUzAxLVVBVC5tZCcsXG4gICAgKTtcbiAgICBhc3NlcnQub2soZnMuZXhpc3RzU3luYyh1YXRQYXRoKSwgJ1MwMS1VQVQubWQgd3JpdHRlbiB0byBkaXNrJyk7XG5cbiAgICBjb25zdCB1YXRDb250ZW50ID0gZnMucmVhZEZpbGVTeW5jKHVhdFBhdGgsICd1dGYtOCcpO1xuICAgIGFzc2VydC5vayh1YXRDb250ZW50LmluY2x1ZGVzKCdhcnRpZmFjdC1kcml2ZW4nKSwgJ1VBVCBjb250ZW50IGNvcnJlY3QnKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgY2xlYW51cERpcih0bXBEaXIpO1xuICB9XG59KTtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyByZW5kZXJBbGxGcm9tRGJcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG50ZXN0KCdcdTI1MDBcdTI1MDAgbWFya2Rvd24tcmVuZGVyZXI6IHJlbmRlckFsbEZyb21EYiBwcm9kdWNlcyBhbGwgZmlsZXMgXHUyNTAwXHUyNTAwJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB0bXBEaXIgPSBtYWtlVG1wRGlyKCk7XG4gIGNvbnN0IGRiUGF0aCA9IHBhdGguam9pbih0bXBEaXIsICcuZ3NkJywgJ2dzZC5kYicpO1xuICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcbiAgY2xlYXJBbGxDYWNoZXMoKTtcblxuICB0cnkge1xuICAgIC8vIFNldHVwOiAyIG1pbGVzdG9uZXMsIE0wMDEgaGFzIDIgc2xpY2VzIHdpdGggdGFza3MsIE0wMDIgaGFzIDEgc2xpY2VcbiAgICBzY2FmZm9sZERpcnModG1wRGlyLCAnTTAwMScsIFsnUzAxJywgJ1MwMiddKTtcbiAgICBzY2FmZm9sZERpcnModG1wRGlyLCAnTTAwMicsIFsnUzAxJ10pO1xuXG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgdGl0bGU6ICdGaXJzdCcsIHN0YXR1czogJ2FjdGl2ZScgfSk7XG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAyJywgdGl0bGU6ICdTZWNvbmQnLCBzdGF0dXM6ICdhY3RpdmUnIH0pO1xuXG4gICAgaW5zZXJ0U2xpY2UoeyBpZDogJ1MwMScsIG1pbGVzdG9uZUlkOiAnTTAwMScsIHRpdGxlOiAnQ29yZScsIHN0YXR1czogJ2NvbXBsZXRlJyB9KTtcbiAgICBpbnNlcnRTbGljZSh7IGlkOiAnUzAyJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdSZW5kZXInLCBzdGF0dXM6ICdwZW5kaW5nJyB9KTtcbiAgICBpbnNlcnRTbGljZSh7IGlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAyJywgdGl0bGU6ICdGdXR1cmUnLCBzdGF0dXM6ICdwZW5kaW5nJyB9KTtcblxuICAgIGluc2VydFRhc2soeyBpZDogJ1QwMScsIHNsaWNlSWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ0RCJywgc3RhdHVzOiAnZG9uZScsIGZ1bGxTdW1tYXJ5TWQ6IG1ha2VUYXNrU3VtbWFyeUNvbnRlbnQoJ1QwMScpIH0pO1xuICAgIGluc2VydFRhc2soeyBpZDogJ1QwMScsIHNsaWNlSWQ6ICdTMDInLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ1JlbmRlcmVyJywgc3RhdHVzOiAncGVuZGluZycgfSk7XG4gICAgaW5zZXJ0VGFzayh7IGlkOiAnVDAxJywgc2xpY2VJZDogJ1MwMScsIG1pbGVzdG9uZUlkOiAnTTAwMicsIHRpdGxlOiAnRnV0dXJlIHRhc2snLCBzdGF0dXM6ICdwZW5kaW5nJyB9KTtcblxuICAgIC8vIFdyaXRlIHJvYWRtYXAgYW5kIHBsYW4gZmlsZXMgb24gZGlza1xuICAgIGNvbnN0IHJvYWRtYXAxID0gbWFrZVJvYWRtYXBDb250ZW50KFtcbiAgICAgIHsgaWQ6ICdTMDEnLCB0aXRsZTogJ0NvcmUnLCBkb25lOiBmYWxzZSB9LFxuICAgICAgeyBpZDogJ1MwMicsIHRpdGxlOiAnUmVuZGVyJywgZG9uZTogZmFsc2UgfSxcbiAgICBdKTtcbiAgICBmcy53cml0ZUZpbGVTeW5jKFxuICAgICAgcGF0aC5qb2luKHRtcERpciwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAxJywgJ00wMDEtUk9BRE1BUC5tZCcpLFxuICAgICAgcm9hZG1hcDEsXG4gICAgKTtcblxuICAgIGNvbnN0IHJvYWRtYXAyID0gbWFrZVJvYWRtYXBDb250ZW50KFtcbiAgICAgIHsgaWQ6ICdTMDEnLCB0aXRsZTogJ0Z1dHVyZScsIGRvbmU6IGZhbHNlIH0sXG4gICAgXSk7XG4gICAgZnMud3JpdGVGaWxlU3luYyhcbiAgICAgIHBhdGguam9pbih0bXBEaXIsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMicsICdNMDAyLVJPQURNQVAubWQnKSxcbiAgICAgIHJvYWRtYXAyLFxuICAgICk7XG5cbiAgICBjb25zdCBwbGFuMSA9IG1ha2VQbGFuQ29udGVudCgnUzAxJywgW1xuICAgICAgeyBpZDogJ1QwMScsIHRpdGxlOiAnREInLCBkb25lOiBmYWxzZSB9LFxuICAgIF0pO1xuICAgIGZzLndyaXRlRmlsZVN5bmMoXG4gICAgICBwYXRoLmpvaW4odG1wRGlyLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgJ00wMDEnLCAnc2xpY2VzJywgJ1MwMScsICdTMDEtUExBTi5tZCcpLFxuICAgICAgcGxhbjEsXG4gICAgKTtcblxuICAgIGNvbnN0IHBsYW4yID0gbWFrZVBsYW5Db250ZW50KCdTMDInLCBbXG4gICAgICB7IGlkOiAnVDAxJywgdGl0bGU6ICdSZW5kZXJlcicsIGRvbmU6IGZhbHNlIH0sXG4gICAgXSk7XG4gICAgZnMud3JpdGVGaWxlU3luYyhcbiAgICAgIHBhdGguam9pbih0bXBEaXIsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScsICdzbGljZXMnLCAnUzAyJywgJ1MwMi1QTEFOLm1kJyksXG4gICAgICBwbGFuMixcbiAgICApO1xuXG4gICAgY29uc3QgcGxhbjMgPSBtYWtlUGxhbkNvbnRlbnQoJ1MwMScsIFtcbiAgICAgIHsgaWQ6ICdUMDEnLCB0aXRsZTogJ0Z1dHVyZSB0YXNrJywgZG9uZTogZmFsc2UgfSxcbiAgICBdKTtcbiAgICBmcy53cml0ZUZpbGVTeW5jKFxuICAgICAgcGF0aC5qb2luKHRtcERpciwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAyJywgJ3NsaWNlcycsICdTMDEnLCAnUzAxLVBMQU4ubWQnKSxcbiAgICAgIHBsYW4zLFxuICAgICk7XG5cbiAgICBjbGVhckFsbENhY2hlcygpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVuZGVyQWxsRnJvbURiKHRtcERpcik7XG5cbiAgICBhc3NlcnQub2socmVzdWx0LnJlbmRlcmVkID4gMCwgJ3JlbmRlckFsbEZyb21EYiByZW5kZXJlZCBzb21lIGZpbGVzJyk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQuZXJyb3JzLmxlbmd0aCwgMCwgJ3JlbmRlckFsbEZyb21EYiBoYWQgbm8gZXJyb3JzJyk7XG5cbiAgICAvLyBWZXJpZnkgTTAwMSByb2FkbWFwIGhhcyBTMDEgY2hlY2tlZFxuICAgIGNvbnN0IG0xUm9hZG1hcCA9IGZzLnJlYWRGaWxlU3luYyhcbiAgICAgIHBhdGguam9pbih0bXBEaXIsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScsICdNMDAxLVJPQURNQVAubWQnKSwgJ3V0Zi04JyxcbiAgICApO1xuICAgIGNsZWFyQWxsQ2FjaGVzKCk7XG4gICAgY29uc3QgcGFyc2VkMSA9IHBhcnNlUm9hZG1hcChtMVJvYWRtYXApO1xuICAgIGNvbnN0IHMwMSA9IHBhcnNlZDEuc2xpY2VzLmZpbmQocyA9PiBzLmlkID09PSAnUzAxJyk7XG4gICAgYXNzZXJ0Lm9rKHMwMSEuZG9uZSwgJ00wMDEgUzAxIGNoZWNrZWQgYWZ0ZXIgcmVuZGVyQWxsJyk7XG5cbiAgICAvLyBWZXJpZnkgTTAwMS9TMDEgcGxhbiBoYXMgVDAxIGNoZWNrZWRcbiAgICBjb25zdCBtMXMxUGxhbiA9IGZzLnJlYWRGaWxlU3luYyhcbiAgICAgIHBhdGguam9pbih0bXBEaXIsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScsICdzbGljZXMnLCAnUzAxJywgJ1MwMS1QTEFOLm1kJyksICd1dGYtOCcsXG4gICAgKTtcbiAgICBjbGVhckFsbENhY2hlcygpO1xuICAgIGNvbnN0IHBhcnNlZFBsYW4gPSBwYXJzZVBsYW4obTFzMVBsYW4pO1xuICAgIGFzc2VydC5vayhwYXJzZWRQbGFuLnRhc2tzWzBdLmRvbmUsICdNMDAxL1MwMSBUMDEgY2hlY2tlZCBhZnRlciByZW5kZXJBbGwnKTtcblxuICAgIC8vIFZlcmlmeSB0YXNrIHN1bW1hcnkgd3JpdHRlblxuICAgIGNvbnN0IHRhc2tTdW1tYXJ5UGF0aCA9IHBhdGguam9pbihcbiAgICAgIHRtcERpciwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAxJywgJ3NsaWNlcycsICdTMDEnLCAndGFza3MnLCAnVDAxLVNVTU1BUlkubWQnLFxuICAgICk7XG4gICAgYXNzZXJ0Lm9rKGZzLmV4aXN0c1N5bmModGFza1N1bW1hcnlQYXRoKSwgJ1QwMSBzdW1tYXJ5IHdyaXR0ZW4gYnkgcmVuZGVyQWxsJyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIGNsZWFudXBEaXIodG1wRGlyKTtcbiAgfVxufSk7XG5cbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuLy8gREItYXV0aG9yaXRhdGl2ZSByZWdlbmVyYXRpb25cbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG50ZXN0KCdcdTI1MDBcdTI1MDAgbWFya2Rvd24tcmVuZGVyZXI6IG1pc3NpbmcgYXJ0aWZhY3QgcmVnZW5lcmF0ZXMgZnJvbSBEQiB3aXRob3V0IGltcG9ydGluZyBkaXNrIHByb2plY3Rpb24gXHUyNTAwXHUyNTAwJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB0bXBEaXIgPSBtYWtlVG1wRGlyKCk7XG4gIGNvbnN0IGRiUGF0aCA9IHBhdGguam9pbih0bXBEaXIsICcuZ3NkJywgJ2dzZC5kYicpO1xuICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcbiAgY2xlYXJBbGxDYWNoZXMoKTtcblxuICB0cnkge1xuICAgIHNjYWZmb2xkRGlycyh0bXBEaXIsICdNMDAxJywgWydTMDEnXSk7XG5cbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogJ00wMDEnLCB0aXRsZTogJ1Rlc3QnLCBzdGF0dXM6ICdhY3RpdmUnIH0pO1xuICAgIGluc2VydFNsaWNlKHsgaWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ0NvcmUnLCBzdGF0dXM6ICdjb21wbGV0ZScgfSk7XG5cbiAgICAvLyBXcml0ZSByb2FkbWFwIHRvIGRpc2sgYnV0IE5PVCBpbiBhcnRpZmFjdHMgREJcbiAgICBjb25zdCByb2FkbWFwQ29udGVudCA9IG1ha2VSb2FkbWFwQ29udGVudChbXG4gICAgICB7IGlkOiAnUzAxJywgdGl0bGU6ICdDb3JlJywgZG9uZTogZmFsc2UgfSxcbiAgICBdKSArICdcXG5cXG5ESVNLX09OTFlfU0VOVElORUwnO1xuICAgIGNvbnN0IHJvYWRtYXBQYXRoID0gcGF0aC5qb2luKHRtcERpciwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAxJywgJ00wMDEtUk9BRE1BUC5tZCcpO1xuICAgIGZzLndyaXRlRmlsZVN5bmMocm9hZG1hcFBhdGgsIHJvYWRtYXBDb250ZW50KTtcbiAgICBjbGVhckFsbENhY2hlcygpO1xuXG4gICAgLy8gVmVyaWZ5IG5vIGFydGlmYWN0IGluIERCXG4gICAgY29uc3QgYmVmb3JlID0gZ2V0QXJ0aWZhY3QoJ21pbGVzdG9uZXMvTTAwMS9NMDAxLVJPQURNQVAubWQnKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGJlZm9yZSwgbnVsbCwgJ2FydGlmYWN0IG5vdCBpbiBEQiBiZWZvcmUgcmVuZGVyJyk7XG5cbiAgICAvLyBSZW5kZXIgXHUyMDE0IHNob3VsZCByZWdlbmVyYXRlIGZyb20gREIgcm93cywgbm90IGltcG9ydC9wYXRjaCBkaXNrIGNvbnRlbnQuXG4gICAgY29uc3Qgb2sgPSBhd2FpdCByZW5kZXJSb2FkbWFwQ2hlY2tib3hlcyh0bXBEaXIsICdNMDAxJyk7XG4gICAgYXNzZXJ0Lm9rKG9rLCAncmVuZGVyIHN1Y2NlZWRzIGJ5IHJlZ2VuZXJhdGluZyBmcm9tIERCJyk7XG5cbiAgICAvLyBWZXJpZnkgYXJ0aWZhY3Qgbm93IGV4aXN0cyBpbiBEQiBidXQgZG9lcyBub3QgY29udGFpbiBkaXNrLW9ubHkgY29udGVudC5cbiAgICBjb25zdCBhZnRlciA9IGdldEFydGlmYWN0KCdtaWxlc3RvbmVzL00wMDEvTTAwMS1ST0FETUFQLm1kJyk7XG4gICAgYXNzZXJ0Lm9rKGFmdGVyICE9PSBudWxsLCAnYXJ0aWZhY3QgcmVnZW5lcmF0ZWQgaW4gREInKTtcbiAgICBhc3NlcnQub2soIWFmdGVyIS5mdWxsX2NvbnRlbnQuaW5jbHVkZXMoJ0RJU0tfT05MWV9TRU5USU5FTCcpLCAnZGlzayBwcm9qZWN0aW9uIGNvbnRlbnQgd2FzIG5vdCBpbXBvcnRlZCcpO1xuICAgIGFzc2VydC5vayhhZnRlciEuZnVsbF9jb250ZW50LmluY2x1ZGVzKCdTMDEnKSwgJ0RCIGFydGlmYWN0IHJlZmxlY3RzIERCIHNsaWNlIHN0YXRlJyk7XG5cbiAgICBhc3NlcnQub2soZnMuZXhpc3RzU3luYyhyb2FkbWFwUGF0aCksICdyb2FkbWFwIHByb2plY3Rpb24gcmVnZW5lcmF0ZWQgb24gZGlzaycpO1xuICAgIGNvbnN0IGRpc2tBZnRlciA9IGZzLnJlYWRGaWxlU3luYyhyb2FkbWFwUGF0aCwgJ3V0Zi04Jyk7XG4gICAgYXNzZXJ0Lm9rKCFkaXNrQWZ0ZXIuaW5jbHVkZXMoJ0RJU0tfT05MWV9TRU5USU5FTCcpLCAnZGlzayBwcm9qZWN0aW9uIHdhcyByZXdyaXR0ZW4gZnJvbSBEQicpO1xuICAgIGFzc2VydC5vayhkaXNrQWZ0ZXIuaW5jbHVkZXMoJ1MwMScpLCAnZGlzayBwcm9qZWN0aW9uIHJlZmxlY3RzIERCIHNsaWNlIHN0YXRlJyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIGNsZWFudXBEaXIodG1wRGlyKTtcbiAgfVxufSk7XG5cbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuLy8gc3RkZXJyIHdhcm5pbmdzIChncmFjZWZ1bCBkZWdyYWRhdGlvbiBkaWFnbm9zdGljcylcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG50ZXN0KCdcdTI1MDBcdTI1MDAgbWFya2Rvd24tcmVuZGVyZXI6IHN0ZGVyciB3YXJuaW5nIG9uIG1pc3NpbmcgY29udGVudCBcdTI1MDBcdTI1MDAnLCBhc3luYyAoKSA9PiB7XG4gIG9wZW5EYXRhYmFzZSgnOm1lbW9yeTonKTtcblxuICAvLyBObyBtaWxlc3RvbmUvc2xpY2VzIGluIERCLCBubyBmaWxlcyBvbiBkaXNrIFx1MjAxNCBzaG91bGQgcmV0dXJuIGZhbHNlIGFuZCBlbWl0IHN0ZGVyclxuICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogJ00wMDEnLCB0aXRsZTogJ1Rlc3QnLCBzdGF0dXM6ICdhY3RpdmUnIH0pO1xuICAvLyBObyBzbGljZXMgaW5zZXJ0ZWQgXHUyMDE0IHNob3VsZCB3YXJuIGFib3V0IG5vIHNsaWNlc1xuXG4gIGNvbnN0IG9rID0gYXdhaXQgcmVuZGVyUm9hZG1hcENoZWNrYm94ZXMoJy9ub25leGlzdGVudC9wYXRoJywgJ00wMDEnKTtcbiAgYXNzZXJ0Lm9rKCFvaywgJ3JldHVybnMgZmFsc2Ugd2hlbiBubyBzbGljZXMgaW4gREInKTtcblxuICBjbG9zZURhdGFiYXNlKCk7XG59KTtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBTdGFsZSBEZXRlY3Rpb24gXHUyMDE0IFBsYW4gQ2hlY2tib3ggTWlzbWF0Y2hcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG50ZXN0KCdcdTI1MDBcdTI1MDAgbWFya2Rvd24tcmVuZGVyZXI6IGRldGVjdFN0YWxlUmVuZGVycyBmaW5kcyBwbGFuIGNoZWNrYm94IG1pc21hdGNoIFx1MjUwMFx1MjUwMCcsICgpID0+IHtcbiAgY29uc3QgdG1wRGlyID0gbWFrZVRtcERpcigpO1xuICBjb25zdCBkYlBhdGggPSBwYXRoLmpvaW4odG1wRGlyLCAnLmdzZCcsICdnc2QuZGInKTtcbiAgb3BlbkRhdGFiYXNlKGRiUGF0aCk7XG4gIGNsZWFyQWxsQ2FjaGVzKCk7XG5cbiAgdHJ5IHtcbiAgICBzY2FmZm9sZERpcnModG1wRGlyLCAnTTAwMScsIFsnUzAxJ10pO1xuXG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgdGl0bGU6ICdUZXN0Jywgc3RhdHVzOiAnYWN0aXZlJyB9KTtcbiAgICBpbnNlcnRTbGljZSh7IGlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdTbGljZScsIHN0YXR1czogJ3BlbmRpbmcnIH0pO1xuXG4gICAgLy8gVDAxIGlzIGRvbmUsIFQwMiBpcyBhbHNvIGRvbmUgaW4gREJcbiAgICBpbnNlcnRUYXNrKHsgaWQ6ICdUMDEnLCBzbGljZUlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdGaXJzdCB0YXNrJywgc3RhdHVzOiAnZG9uZScgfSk7XG4gICAgaW5zZXJ0VGFzayh7IGlkOiAnVDAyJywgc2xpY2VJZDogJ1MwMScsIG1pbGVzdG9uZUlkOiAnTTAwMScsIHRpdGxlOiAnU2Vjb25kIHRhc2snLCBzdGF0dXM6ICdkb25lJyB9KTtcblxuICAgIC8vIFdyaXRlIHBsYW4gd2l0aCBUMDEgY2hlY2tlZCBidXQgVDAyIHVuY2hlY2tlZFxuICAgIC8vIFQwMSBtYXRjaGVzIERCIChkb25lICsgY2hlY2tlZCkgYnV0IFQwMiBpcyBzdGFsZSAoZG9uZSBidXQgdW5jaGVja2VkKVxuICAgIGNvbnN0IHBsYW5Db250ZW50ID0gbWFrZVBsYW5Db250ZW50KCdTMDEnLCBbXG4gICAgICB7IGlkOiAnVDAxJywgdGl0bGU6ICdGaXJzdCB0YXNrJywgZG9uZTogdHJ1ZSB9LFxuICAgICAgeyBpZDogJ1QwMicsIHRpdGxlOiAnU2Vjb25kIHRhc2snLCBkb25lOiBmYWxzZSB9LFxuICAgIF0pO1xuICAgIGNvbnN0IHBsYW5QYXRoID0gcGF0aC5qb2luKHRtcERpciwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAxJywgJ3NsaWNlcycsICdTMDEnLCAnUzAxLVBMQU4ubWQnKTtcbiAgICBmcy53cml0ZUZpbGVTeW5jKHBsYW5QYXRoLCBwbGFuQ29udGVudCk7XG4gICAgY2xlYXJBbGxDYWNoZXMoKTtcblxuICAgIC8vIFJlbmRlciBUMDEgdG8gc3luYyBpdCwgYnV0IGxlYXZlIFQwMiBvdXQgb2Ygc3luY1xuICAgIC8vIEFjdHVhbGx5LCB0aGUgcGxhbiB3YXMgd3JpdHRlbiB3aXRoIFQwMSBhbHJlYWR5IGNoZWNrZWQuIFxuICAgIC8vIFRoZSBzdGFsZSBkZXRlY3Rpb24gc2hvdWxkIGZpbmQgVDAyIGFzIHN0YWxlLlxuICAgIGNvbnN0IHN0YWxlID0gZGV0ZWN0U3RhbGVSZW5kZXJzKHRtcERpcik7XG5cbiAgICBhc3NlcnQub2soc3RhbGUubGVuZ3RoID4gMCwgJ2RldGVjdFN0YWxlUmVuZGVycyBzaG91bGQgZmluZCBzdGFsZSBlbnRyaWVzJyk7XG4gICAgY29uc3QgdDAyU3RhbGUgPSBzdGFsZS5maW5kKHMgPT4gcy5yZWFzb24uaW5jbHVkZXMoJ1QwMicpKTtcbiAgICBhc3NlcnQub2soISF0MDJTdGFsZSwgJ3Nob3VsZCBkZXRlY3QgVDAyIGFzIHN0YWxlIChkb25lIGluIERCLCB1bmNoZWNrZWQgaW4gcGxhbiknKTtcbiAgICBhc3NlcnQub2sodDAyU3RhbGUhLnJlYXNvbi5pbmNsdWRlcygnZG9uZSBpbiBEQiBidXQgdW5jaGVja2VkJyksICdyZWFzb24gc2hvdWxkIGV4cGxhaW4gdGhlIG1pc21hdGNoJyk7XG5cbiAgICAvLyBUMDEgc2hvdWxkIE5PVCBiZSBzdGFsZSBcdTIwMTQgaXQncyBjaGVja2VkIGFuZCBkb25lXG4gICAgY29uc3QgdDAxU3RhbGUgPSBzdGFsZS5maW5kKHMgPT4gcy5yZWFzb24uaW5jbHVkZXMoJ1QwMScpKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHQwMVN0YWxlLCB1bmRlZmluZWQsICdUMDEgc2hvdWxkIG5vdCBiZSBzdGFsZSAoZG9uZSBhbmQgY2hlY2tlZCknKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgY2xlYW51cERpcih0bXBEaXIpO1xuICB9XG59KTtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBTdGFsZSBSZXBhaXIgXHUyMDE0IFBsYW4gQ2hlY2tib3hcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG50ZXN0KCdcdTI1MDBcdTI1MDAgbWFya2Rvd24tcmVuZGVyZXI6IHJlcGFpclN0YWxlUmVuZGVycyBmaXhlcyBwbGFuIGFuZCBzZWNvbmQgZGV0ZWN0IHJldHVybnMgZW1wdHkgXHUyNTAwXHUyNTAwJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB0bXBEaXIgPSBtYWtlVG1wRGlyKCk7XG4gIGNvbnN0IGRiUGF0aCA9IHBhdGguam9pbih0bXBEaXIsICcuZ3NkJywgJ2dzZC5kYicpO1xuICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcbiAgY2xlYXJBbGxDYWNoZXMoKTtcblxuICB0cnkge1xuICAgIHNjYWZmb2xkRGlycyh0bXBEaXIsICdNMDAxJywgWydTMDEnXSk7XG5cbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogJ00wMDEnLCB0aXRsZTogJ1Rlc3QnLCBzdGF0dXM6ICdhY3RpdmUnIH0pO1xuICAgIGluc2VydFNsaWNlKHsgaWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ1NsaWNlJywgc3RhdHVzOiAncGVuZGluZycgfSk7XG5cbiAgICBpbnNlcnRUYXNrKHsgaWQ6ICdUMDEnLCBzbGljZUlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdGaXJzdCB0YXNrJywgc3RhdHVzOiAnZG9uZScgfSk7XG4gICAgaW5zZXJ0VGFzayh7IGlkOiAnVDAyJywgc2xpY2VJZDogJ1MwMScsIG1pbGVzdG9uZUlkOiAnTTAwMScsIHRpdGxlOiAnU2Vjb25kIHRhc2snLCBzdGF0dXM6ICdkb25lJyB9KTtcblxuICAgIC8vIFdyaXRlIHBsYW4gd2l0aCBib3RoIHRhc2tzIHVuY2hlY2tlZCAoYm90aCBhcmUgc3RhbGUgc2luY2UgREIgc2F5cyBkb25lKVxuICAgIGNvbnN0IHBsYW5Db250ZW50ID0gbWFrZVBsYW5Db250ZW50KCdTMDEnLCBbXG4gICAgICB7IGlkOiAnVDAxJywgdGl0bGU6ICdGaXJzdCB0YXNrJywgZG9uZTogZmFsc2UgfSxcbiAgICAgIHsgaWQ6ICdUMDInLCB0aXRsZTogJ1NlY29uZCB0YXNrJywgZG9uZTogZmFsc2UgfSxcbiAgICBdKTtcbiAgICBjb25zdCBwbGFuUGF0aCA9IHBhdGguam9pbih0bXBEaXIsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScsICdzbGljZXMnLCAnUzAxJywgJ1MwMS1QTEFOLm1kJyk7XG4gICAgZnMud3JpdGVGaWxlU3luYyhwbGFuUGF0aCwgcGxhbkNvbnRlbnQpO1xuICAgIGNsZWFyQWxsQ2FjaGVzKCk7XG5cbiAgICAvLyBWZXJpZnkgc3RhbGUgYmVmb3JlIHJlcGFpclxuICAgIGNvbnN0IHN0YWxlQmVmb3JlID0gZGV0ZWN0U3RhbGVSZW5kZXJzKHRtcERpcik7XG4gICAgYXNzZXJ0Lm9rKHN0YWxlQmVmb3JlLmxlbmd0aCA+IDAsICdzaG91bGQgaGF2ZSBzdGFsZSBlbnRyaWVzIGJlZm9yZSByZXBhaXInKTtcblxuICAgIC8vIFJlcGFpclxuICAgIGNvbnN0IHJlcGFpcmVkID0gYXdhaXQgcmVwYWlyU3RhbGVSZW5kZXJzKHRtcERpcik7XG4gICAgYXNzZXJ0Lm9rKHJlcGFpcmVkID4gMCwgJ3JlcGFpclN0YWxlUmVuZGVycyBzaG91bGQgcmVwYWlyIGF0IGxlYXN0IDEgZmlsZScpO1xuXG4gICAgLy8gQWZ0ZXIgcmVwYWlyLCBkZXRlY3QgYWdhaW4gXHUyMDE0IHNob3VsZCBiZSBlbXB0eVxuICAgIGNsZWFyQWxsQ2FjaGVzKCk7XG4gICAgY29uc3Qgc3RhbGVBZnRlciA9IGRldGVjdFN0YWxlUmVuZGVycyh0bXBEaXIpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhbGVBZnRlci5sZW5ndGgsIDAsICdkZXRlY3RTdGFsZVJlbmRlcnMgc2hvdWxkIHJldHVybiBlbXB0eSBhZnRlciByZXBhaXInKTtcblxuICAgIC8vIFZlcmlmeSB0aGUgcGxhbiBmaWxlIHdhcyBhY3R1YWxseSB1cGRhdGVkXG4gICAgY29uc3QgcmVwYWlyZWRDb250ZW50ID0gZnMucmVhZEZpbGVTeW5jKHBsYW5QYXRoLCAndXRmLTgnKTtcbiAgICBhc3NlcnQub2socmVwYWlyZWRDb250ZW50LmluY2x1ZGVzKCdbeF0gKipUMDE6JyksICdUMDEgc2hvdWxkIGJlIGNoZWNrZWQgYWZ0ZXIgcmVwYWlyJyk7XG4gICAgYXNzZXJ0Lm9rKHJlcGFpcmVkQ29udGVudC5pbmNsdWRlcygnW3hdICoqVDAyOicpLCAnVDAyIHNob3VsZCBiZSBjaGVja2VkIGFmdGVyIHJlcGFpcicpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICBjbGVhbnVwRGlyKHRtcERpcik7XG4gIH1cbn0pO1xuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIFN0YWxlIERldGVjdGlvbiBcdTIwMTQgUm9hZG1hcCBDaGVja2JveCBNaXNtYXRjaFxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbnRlc3QoJ1x1MjUwMFx1MjUwMCBtYXJrZG93bi1yZW5kZXJlcjogZGV0ZWN0U3RhbGVSZW5kZXJzIGZpbmRzIHJvYWRtYXAgY2hlY2tib3ggbWlzbWF0Y2ggXHUyNTAwXHUyNTAwJywgKCkgPT4ge1xuICBjb25zdCB0bXBEaXIgPSBtYWtlVG1wRGlyKCk7XG4gIGNvbnN0IGRiUGF0aCA9IHBhdGguam9pbih0bXBEaXIsICcuZ3NkJywgJ2dzZC5kYicpO1xuICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcbiAgY2xlYXJBbGxDYWNoZXMoKTtcblxuICB0cnkge1xuICAgIHNjYWZmb2xkRGlycyh0bXBEaXIsICdNMDAxJywgWydTMDEnLCAnUzAyJ10pO1xuXG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgdGl0bGU6ICdUZXN0Jywgc3RhdHVzOiAnYWN0aXZlJyB9KTtcbiAgICBpbnNlcnRTbGljZSh7IGlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdDb3JlJywgc3RhdHVzOiAnY29tcGxldGUnIH0pO1xuICAgIGluc2VydFNsaWNlKHsgaWQ6ICdTMDInLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ1JlbmRlcicsIHN0YXR1czogJ3BlbmRpbmcnIH0pO1xuXG4gICAgLy8gV3JpdGUgcm9hZG1hcCB3aXRoIGJvdGggc2xpY2VzIHVuY2hlY2tlZCAoUzAxIGlzIHN0YWxlIFx1MjAxNCBjb21wbGV0ZSBpbiBEQiBidXQgdW5jaGVja2VkKVxuICAgIGNvbnN0IHJvYWRtYXBDb250ZW50ID0gbWFrZVJvYWRtYXBDb250ZW50KFtcbiAgICAgIHsgaWQ6ICdTMDEnLCB0aXRsZTogJ0NvcmUnLCBkb25lOiBmYWxzZSB9LFxuICAgICAgeyBpZDogJ1MwMicsIHRpdGxlOiAnUmVuZGVyJywgZG9uZTogZmFsc2UgfSxcbiAgICBdKTtcbiAgICBjb25zdCByb2FkbWFwUGF0aCA9IHBhdGguam9pbih0bXBEaXIsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScsICdNMDAxLVJPQURNQVAubWQnKTtcbiAgICBmcy53cml0ZUZpbGVTeW5jKHJvYWRtYXBQYXRoLCByb2FkbWFwQ29udGVudCk7XG4gICAgY2xlYXJBbGxDYWNoZXMoKTtcblxuICAgIGNvbnN0IHN0YWxlID0gZGV0ZWN0U3RhbGVSZW5kZXJzKHRtcERpcik7XG4gICAgY29uc3QgczAxU3RhbGUgPSBzdGFsZS5maW5kKHMgPT4gcy5yZWFzb24uaW5jbHVkZXMoJ1MwMScpKTtcbiAgICBhc3NlcnQub2soISFzMDFTdGFsZSwgJ3Nob3VsZCBkZXRlY3QgUzAxIGFzIHN0YWxlIChjb21wbGV0ZSBpbiBEQiwgdW5jaGVja2VkIGluIHJvYWRtYXApJyk7XG5cbiAgICBjb25zdCBzMDJTdGFsZSA9IHN0YWxlLmZpbmQocyA9PiBzLnJlYXNvbi5pbmNsdWRlcygnUzAyJykpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoczAyU3RhbGUsIHVuZGVmaW5lZCwgJ1MwMiBzaG91bGQgbm90IGJlIHN0YWxlIChwZW5kaW5nIGFuZCB1bmNoZWNrZWQgXHUyMDE0IG1hdGNoZXMpJyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIGNsZWFudXBEaXIodG1wRGlyKTtcbiAgfVxufSk7XG5cbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuLy8gU3RhbGUgRGV0ZWN0aW9uIFx1MjAxNCBNaXNzaW5nIFRhc2sgU3VtbWFyeVxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbnRlc3QoJ1x1MjUwMFx1MjUwMCBtYXJrZG93bi1yZW5kZXJlcjogZGV0ZWN0U3RhbGVSZW5kZXJzIGZpbmRzIG1pc3NpbmcgdGFzayBzdW1tYXJ5IFx1MjUwMFx1MjUwMCcsICgpID0+IHtcbiAgY29uc3QgdG1wRGlyID0gbWFrZVRtcERpcigpO1xuICBjb25zdCBkYlBhdGggPSBwYXRoLmpvaW4odG1wRGlyLCAnLmdzZCcsICdnc2QuZGInKTtcbiAgb3BlbkRhdGFiYXNlKGRiUGF0aCk7XG4gIGNsZWFyQWxsQ2FjaGVzKCk7XG5cbiAgdHJ5IHtcbiAgICBzY2FmZm9sZERpcnModG1wRGlyLCAnTTAwMScsIFsnUzAxJ10pO1xuXG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgdGl0bGU6ICdUZXN0Jywgc3RhdHVzOiAnYWN0aXZlJyB9KTtcbiAgICBpbnNlcnRTbGljZSh7IGlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdTbGljZScsIHN0YXR1czogJ3BlbmRpbmcnIH0pO1xuXG4gICAgLy8gVGFzayBpcyBkb25lIHdpdGggZnVsbF9zdW1tYXJ5X21kLCBidXQgbm8gU1VNTUFSWS5tZCBvbiBkaXNrXG4gICAgY29uc3Qgc3VtbWFyeUNvbnRlbnQgPSBtYWtlVGFza1N1bW1hcnlDb250ZW50KCdUMDEnKTtcbiAgICBpbnNlcnRUYXNrKHtcbiAgICAgIGlkOiAnVDAxJyxcbiAgICAgIHNsaWNlSWQ6ICdTMDEnLFxuICAgICAgbWlsZXN0b25lSWQ6ICdNMDAxJyxcbiAgICAgIHRpdGxlOiAnVGFzaycsXG4gICAgICBzdGF0dXM6ICdkb25lJyxcbiAgICAgIGZ1bGxTdW1tYXJ5TWQ6IHN1bW1hcnlDb250ZW50LFxuICAgIH0pO1xuXG4gICAgLy8gQWxzbyB3cml0ZSBhIHBsYW4gc28gcGxhbiBkZXRlY3Rpb24gZG9lc24ndCB0cmlnZ2VyIChUMDEgaXMgZG9uZSBidXQgbm90IGNoZWNrZWQpXG4gICAgLy8gV2UgbmVlZCBhIHBsYW4gZmlsZSBzbyB0YXNrIHBsYW4gZGV0ZWN0aW9uIHdvcmtzIFx1MjAxNCBidXQgd2Ugc3BlY2lmaWNhbGx5IHdhbnQgdG8gdGVzdFxuICAgIC8vIHRoZSBtaXNzaW5nIHN1bW1hcnkgY2FzZSwgc28gd3JpdGUgcGxhbiB3aXRoIFQwMSBjaGVja2VkXG4gICAgY29uc3QgcGxhbkNvbnRlbnQgPSBtYWtlUGxhbkNvbnRlbnQoJ1MwMScsIFtcbiAgICAgIHsgaWQ6ICdUMDEnLCB0aXRsZTogJ1Rhc2snLCBkb25lOiB0cnVlIH0sXG4gICAgXSk7XG4gICAgY29uc3QgcGxhblBhdGggPSBwYXRoLmpvaW4odG1wRGlyLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgJ00wMDEnLCAnc2xpY2VzJywgJ1MwMScsICdTMDEtUExBTi5tZCcpO1xuICAgIGZzLndyaXRlRmlsZVN5bmMocGxhblBhdGgsIHBsYW5Db250ZW50KTtcbiAgICBjbGVhckFsbENhY2hlcygpO1xuXG4gICAgY29uc3Qgc3RhbGUgPSBkZXRlY3RTdGFsZVJlbmRlcnModG1wRGlyKTtcbiAgICBjb25zdCBzdW1tYXJ5U3RhbGUgPSBzdGFsZS5maW5kKHMgPT4gcy5yZWFzb24uaW5jbHVkZXMoJ1NVTU1BUlkubWQgbWlzc2luZycpKTtcbiAgICBhc3NlcnQub2soISFzdW1tYXJ5U3RhbGUsICdzaG91bGQgZGV0ZWN0IG1pc3NpbmcgVDAxLVNVTU1BUlkubWQnKTtcbiAgICBhc3NlcnQub2soc3VtbWFyeVN0YWxlIS5yZWFzb24uaW5jbHVkZXMoJ1QwMScpLCAncmVhc29uIHNob3VsZCBtZW50aW9uIFQwMScpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICBjbGVhbnVwRGlyKHRtcERpcik7XG4gIH1cbn0pO1xuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIFN0YWxlIFJlcGFpciBcdTIwMTQgTWlzc2luZyBUYXNrIFN1bW1hcnlcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG50ZXN0KCdcdTI1MDBcdTI1MDAgbWFya2Rvd24tcmVuZGVyZXI6IHJlcGFpclN0YWxlUmVuZGVycyB3cml0ZXMgbWlzc2luZyB0YXNrIHN1bW1hcnkgXHUyNTAwXHUyNTAwJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB0bXBEaXIgPSBtYWtlVG1wRGlyKCk7XG4gIGNvbnN0IGRiUGF0aCA9IHBhdGguam9pbih0bXBEaXIsICcuZ3NkJywgJ2dzZC5kYicpO1xuICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcbiAgY2xlYXJBbGxDYWNoZXMoKTtcblxuICB0cnkge1xuICAgIHNjYWZmb2xkRGlycyh0bXBEaXIsICdNMDAxJywgWydTMDEnXSk7XG5cbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogJ00wMDEnLCB0aXRsZTogJ1Rlc3QnLCBzdGF0dXM6ICdhY3RpdmUnIH0pO1xuICAgIGluc2VydFNsaWNlKHsgaWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ1NsaWNlJywgc3RhdHVzOiAncGVuZGluZycgfSk7XG5cbiAgICBjb25zdCBzdW1tYXJ5Q29udGVudCA9IG1ha2VUYXNrU3VtbWFyeUNvbnRlbnQoJ1QwMScpO1xuICAgIGluc2VydFRhc2soe1xuICAgICAgaWQ6ICdUMDEnLFxuICAgICAgc2xpY2VJZDogJ1MwMScsXG4gICAgICBtaWxlc3RvbmVJZDogJ00wMDEnLFxuICAgICAgdGl0bGU6ICdUYXNrJyxcbiAgICAgIHN0YXR1czogJ2RvbmUnLFxuICAgICAgZnVsbFN1bW1hcnlNZDogc3VtbWFyeUNvbnRlbnQsXG4gICAgfSk7XG5cbiAgICAvLyBXcml0ZSBwbGFuIHdpdGggVDAxIGNoZWNrZWQgc28gcGxhbiBkZXRlY3Rpb24gZG9lc24ndCB0cmlnZ2VyXG4gICAgY29uc3QgcGxhbkNvbnRlbnQgPSBtYWtlUGxhbkNvbnRlbnQoJ1MwMScsIFtcbiAgICAgIHsgaWQ6ICdUMDEnLCB0aXRsZTogJ1Rhc2snLCBkb25lOiB0cnVlIH0sXG4gICAgXSk7XG4gICAgY29uc3QgcGxhblBhdGggPSBwYXRoLmpvaW4odG1wRGlyLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgJ00wMDEnLCAnc2xpY2VzJywgJ1MwMScsICdTMDEtUExBTi5tZCcpO1xuICAgIGZzLndyaXRlRmlsZVN5bmMocGxhblBhdGgsIHBsYW5Db250ZW50KTtcbiAgICBjbGVhckFsbENhY2hlcygpO1xuXG4gICAgLy8gUmVwYWlyXG4gICAgY29uc3QgcmVwYWlyZWQgPSBhd2FpdCByZXBhaXJTdGFsZVJlbmRlcnModG1wRGlyKTtcbiAgICBhc3NlcnQub2socmVwYWlyZWQgPiAwLCAnc2hvdWxkIHJlcGFpciBtaXNzaW5nIHN1bW1hcnknKTtcblxuICAgIC8vIFZlcmlmeSBmaWxlIHdyaXR0ZW5cbiAgICBjb25zdCBzdW1tYXJ5UGF0aCA9IHBhdGguam9pbihcbiAgICAgIHRtcERpciwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAxJywgJ3NsaWNlcycsICdTMDEnLCAndGFza3MnLCAnVDAxLVNVTU1BUlkubWQnLFxuICAgICk7XG4gICAgYXNzZXJ0Lm9rKGZzLmV4aXN0c1N5bmMoc3VtbWFyeVBhdGgpLCAnVDAxLVNVTU1BUlkubWQgc2hvdWxkIGV4aXN0IGFmdGVyIHJlcGFpcicpO1xuXG4gICAgLy8gU2Vjb25kIGRldGVjdCBzaG91bGQgYmUgZW1wdHlcbiAgICBjbGVhckFsbENhY2hlcygpO1xuICAgIGNvbnN0IHN0YWxlQWZ0ZXIgPSBkZXRlY3RTdGFsZVJlbmRlcnModG1wRGlyKTtcbiAgICBjb25zdCBzdW1tYXJ5U3RhbGUgPSBzdGFsZUFmdGVyLmZpbmQocyA9PiBzLnJlYXNvbi5pbmNsdWRlcygnU1VNTUFSWS5tZCBtaXNzaW5nJykgJiYgcy5yZWFzb24uaW5jbHVkZXMoJ1QwMScpKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN1bW1hcnlTdGFsZSwgdW5kZWZpbmVkLCAnbWlzc2luZyBzdW1tYXJ5IHNob3VsZCBiZSBmaXhlZCBhZnRlciByZXBhaXInKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgY2xlYW51cERpcih0bXBEaXIpO1xuICB9XG59KTtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBTdGFsZSBSZXBhaXIgXHUyMDE0IElkZW1wb3RlbmN5XG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxudGVzdCgnXHUyNTAwXHUyNTAwIG1hcmtkb3duLXJlbmRlcmVyOiByZXBhaXJTdGFsZVJlbmRlcnMgaWRlbXBvdGVuY3kgXHUyMDE0IGZ1bGx5IHN5bmNlZCByZXR1cm5zIDAgXHUyNTAwXHUyNTAwJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB0bXBEaXIgPSBtYWtlVG1wRGlyKCk7XG4gIGNvbnN0IGRiUGF0aCA9IHBhdGguam9pbih0bXBEaXIsICcuZ3NkJywgJ2dzZC5kYicpO1xuICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcbiAgY2xlYXJBbGxDYWNoZXMoKTtcblxuICB0cnkge1xuICAgIHNjYWZmb2xkRGlycyh0bXBEaXIsICdNMDAxJywgWydTMDEnXSk7XG5cbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogJ00wMDEnLCB0aXRsZTogJ1Rlc3QnLCBzdGF0dXM6ICdhY3RpdmUnIH0pO1xuICAgIGluc2VydFNsaWNlKHsgaWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ1NsaWNlJywgc3RhdHVzOiAncGVuZGluZycgfSk7XG4gICAgaW5zZXJ0VGFzayh7IGlkOiAnVDAxJywgc2xpY2VJZDogJ1MwMScsIG1pbGVzdG9uZUlkOiAnTTAwMScsIHRpdGxlOiAnVGFzaycsIHN0YXR1czogJ2RvbmUnIH0pO1xuXG4gICAgLy8gV3JpdGUgcGxhbiB3aXRoIFQwMSBjaGVja2VkIFx1MjAxNCBtYXRjaGVzIERCXG4gICAgY29uc3QgcGxhbkNvbnRlbnQgPSBtYWtlUGxhbkNvbnRlbnQoJ1MwMScsIFtcbiAgICAgIHsgaWQ6ICdUMDEnLCB0aXRsZTogJ1Rhc2snLCBkb25lOiB0cnVlIH0sXG4gICAgXSk7XG4gICAgY29uc3QgcGxhblBhdGggPSBwYXRoLmpvaW4odG1wRGlyLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgJ00wMDEnLCAnc2xpY2VzJywgJ1MwMScsICdTMDEtUExBTi5tZCcpO1xuICAgIGZzLndyaXRlRmlsZVN5bmMocGxhblBhdGgsIHBsYW5Db250ZW50KTtcbiAgICBjbGVhckFsbENhY2hlcygpO1xuXG4gICAgLy8gTm8gc3RhbGUgZW50cmllcyB3aGVuIGV2ZXJ5dGhpbmcgaXMgaW4gc3luYyAobm8gc3VtbWFyeSB0byBjaGVjayBzaW5jZSBubyBmdWxsU3VtbWFyeU1kKVxuICAgIGNvbnN0IHJlcGFpcmVkID0gYXdhaXQgcmVwYWlyU3RhbGVSZW5kZXJzKHRtcERpcik7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXBhaXJlZCwgMCwgJ3JlcGFpclN0YWxlUmVuZGVycyBzaG91bGQgcmV0dXJuIDAgb24gZnVsbHkgc3luY2VkIHByb2plY3QnKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgY2xlYW51cERpcih0bXBEaXIpO1xuICB9XG59KTtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBTdGFsZSBEZXRlY3Rpb24gXHUyMDE0IE1pc3NpbmcgU2xpY2UgU3VtbWFyeSArIFVBVFxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbnRlc3QoJ1x1MjUwMFx1MjUwMCBtYXJrZG93bi1yZW5kZXJlcjogZGV0ZWN0U3RhbGVSZW5kZXJzIGZpbmRzIG1pc3Npbmcgc2xpY2Ugc3VtbWFyeSBhbmQgVUFUIFx1MjUwMFx1MjUwMCcsICgpID0+IHtcbiAgY29uc3QgdG1wRGlyID0gbWFrZVRtcERpcigpO1xuICBjb25zdCBkYlBhdGggPSBwYXRoLmpvaW4odG1wRGlyLCAnLmdzZCcsICdnc2QuZGInKTtcbiAgb3BlbkRhdGFiYXNlKGRiUGF0aCk7XG4gIGNsZWFyQWxsQ2FjaGVzKCk7XG5cbiAgdHJ5IHtcbiAgICBzY2FmZm9sZERpcnModG1wRGlyLCAnTTAwMScsIFsnUzAxJ10pO1xuXG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgdGl0bGU6ICdUZXN0Jywgc3RhdHVzOiAnYWN0aXZlJyB9KTtcbiAgICBpbnNlcnRTbGljZSh7IGlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdTbGljZScsIHN0YXR1czogJ3BlbmRpbmcnIH0pO1xuXG4gICAgLy8gVXBkYXRlIHNsaWNlIHRvIGNvbXBsZXRlIHdpdGggY29udGVudCB2aWEgcmF3IGFkYXB0ZXJcbiAgICBjb25zdCBhZGFwdGVyID0gX2dldEFkYXB0ZXIoKSE7XG4gICAgYWRhcHRlci5wcmVwYXJlKFxuICAgICAgYFVQREFURSBzbGljZXMgU0VUIHN0YXR1cyA9ICdjb21wbGV0ZScsIGZ1bGxfc3VtbWFyeV9tZCA9IDpzbSwgZnVsbF91YXRfbWQgPSA6dW0gV0hFUkUgbWlsZXN0b25lX2lkID0gJ00wMDEnIEFORCBpZCA9ICdTMDEnYCxcbiAgICApLnJ1bih7XG4gICAgICAnOnNtJzogJy0tLVxcbmlkOiBTMDFcXG5wYXJlbnQ6IE0wMDFcXG5taWxlc3RvbmU6IE0wMDFcXG4tLS1cXG5cXG4jIFMwMTogU3VtbWFyeVxcblxcbkRvbmUuXFxuJyxcbiAgICAgICc6dW0nOiAnIyBTMDEgVUFUXFxuXFxuQWxsIHBhc3MuXFxuJyxcbiAgICB9KTtcblxuICAgIGNsZWFyQWxsQ2FjaGVzKCk7XG5cbiAgICBjb25zdCBzdGFsZSA9IGRldGVjdFN0YWxlUmVuZGVycyh0bXBEaXIpO1xuICAgIGNvbnN0IHN1bW1hcnlTdGFsZSA9IHN0YWxlLmZpbmQocyA9PiBzLnJlYXNvbi5pbmNsdWRlcygnU1VNTUFSWS5tZCBtaXNzaW5nJykgJiYgcy5yZWFzb24uaW5jbHVkZXMoJ1MwMScpKTtcbiAgICBjb25zdCB1YXRTdGFsZSA9IHN0YWxlLmZpbmQocyA9PiBzLnJlYXNvbi5pbmNsdWRlcygnVUFULm1kIG1pc3NpbmcnKSAmJiBzLnJlYXNvbi5pbmNsdWRlcygnUzAxJykpO1xuXG4gICAgYXNzZXJ0Lm9rKCEhc3VtbWFyeVN0YWxlLCAnc2hvdWxkIGRldGVjdCBtaXNzaW5nIFMwMS1TVU1NQVJZLm1kJyk7XG4gICAgYXNzZXJ0Lm9rKCEhdWF0U3RhbGUsICdzaG91bGQgZGV0ZWN0IG1pc3NpbmcgUzAxLVVBVC5tZCcpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICBjbGVhbnVwRGlyKHRtcERpcik7XG4gIH1cbn0pO1xuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFlBQVksVUFBVTtBQUN0QixZQUFZLFFBQVE7QUFDcEIsWUFBWSxRQUFRO0FBQ3BCO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFHQTtBQUFBLE9BQ0s7QUFDUDtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUNQLFNBQVMsMEJBQTBCO0FBQ25DO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1A7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1AsU0FBUyxnQkFBZ0IsMEJBQTBCO0FBQ25ELFNBQVMsNEJBQTRCO0FBQ3JDLFNBQW1CLFlBQW1DO0FBQ3RELE9BQU8sWUFBWTtBQU1uQixTQUFTLGFBQXFCO0FBQzVCLFFBQU0sTUFBTSxHQUFHLFlBQVksS0FBSyxLQUFLLEdBQUcsT0FBTyxHQUFHLGVBQWUsQ0FBQztBQUNsRSxLQUFHLFVBQVUsS0FBSyxLQUFLLEtBQUssTUFBTSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDeEQsU0FBTztBQUNUO0FBRUEsU0FBUyxXQUFXLEtBQW1CO0FBQ3JDLE1BQUk7QUFDRixPQUFHLE9BQU8sS0FBSyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLEVBQ2pELFFBQVE7QUFBQSxFQUFnQjtBQUMxQjtBQUVBLFNBQVMsaUJBQXVCO0FBQzlCLGtCQUFnQjtBQUNoQixpQkFBZTtBQUNmLHFCQUFtQjtBQUNuQix1QkFBcUI7QUFDdkI7QUFNQSxTQUFTLGFBQWEsUUFBZ0IsS0FBYSxVQUEwQjtBQUMzRSxRQUFNLFFBQVEsS0FBSyxLQUFLLFFBQVEsUUFBUSxjQUFjLEdBQUc7QUFDekQsS0FBRyxVQUFVLE9BQU8sRUFBRSxXQUFXLEtBQUssQ0FBQztBQUV2QyxhQUFXLE9BQU8sVUFBVTtBQUMxQixVQUFNLFdBQVcsS0FBSyxLQUFLLE9BQU8sVUFBVSxHQUFHO0FBQy9DLE9BQUcsVUFBVSxLQUFLLEtBQUssVUFBVSxPQUFPLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUFBLEVBQ2hFO0FBQ0Y7QUFJQSxTQUFTLG1CQUFtQixRQUFxRTtBQUMvRixRQUFNLFFBQWtCLENBQUM7QUFDekIsUUFBTSxLQUFLLGdCQUFnQjtBQUMzQixRQUFNLEtBQUssRUFBRTtBQUNiLFFBQU0sS0FBSyw0QkFBNEI7QUFDdkMsUUFBTSxLQUFLLEVBQUU7QUFDYixRQUFNLEtBQUssV0FBVztBQUN0QixRQUFNLEtBQUssRUFBRTtBQUNiLGFBQVcsS0FBSyxRQUFRO0FBQ3RCLFVBQU0sV0FBVyxFQUFFLE9BQU8sUUFBUTtBQUNsQyxVQUFNLEtBQUssS0FBSyxRQUFRLE1BQU0sRUFBRSxFQUFFLEtBQUssRUFBRSxLQUFLLG1DQUFtQztBQUFBLEVBQ25GO0FBQ0EsUUFBTSxLQUFLLEVBQUU7QUFDYixTQUFPLE1BQU0sS0FBSyxJQUFJO0FBQ3hCO0FBSUEsU0FBUyxnQkFDUCxTQUNBLE9BQ1E7QUFDUixRQUFNLFFBQWtCLENBQUM7QUFDekIsUUFBTSxLQUFLLEtBQUssT0FBTyxjQUFjO0FBQ3JDLFFBQU0sS0FBSyxFQUFFO0FBQ2IsUUFBTSxLQUFLLDJCQUEyQjtBQUN0QyxRQUFNLEtBQUsscUJBQXFCO0FBQ2hDLFFBQU0sS0FBSyxFQUFFO0FBQ2IsUUFBTSxLQUFLLGVBQWU7QUFDMUIsUUFBTSxLQUFLLEVBQUU7QUFDYixRQUFNLEtBQUssb0JBQW9CO0FBQy9CLFFBQU0sS0FBSyxFQUFFO0FBQ2IsUUFBTSxLQUFLLFVBQVU7QUFDckIsUUFBTSxLQUFLLEVBQUU7QUFDYixhQUFXLEtBQUssT0FBTztBQUNyQixVQUFNLFdBQVcsRUFBRSxPQUFPLFFBQVE7QUFDbEMsVUFBTSxLQUFLLEtBQUssUUFBUSxNQUFNLEVBQUUsRUFBRSxLQUFLLEVBQUUsS0FBSyxlQUFlO0FBQUEsRUFDL0Q7QUFDQSxRQUFNLEtBQUssRUFBRTtBQUNiLFNBQU8sTUFBTSxLQUFLLElBQUk7QUFDeEI7QUFJQSxTQUFTLHVCQUF1QixRQUF3QjtBQUN0RCxTQUFPO0FBQUEsSUFDTDtBQUFBLElBQ0EsT0FBTyxNQUFNO0FBQUEsSUFDYjtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0Esa0JBQWlCLG9CQUFJLEtBQUssR0FBRSxZQUFZLENBQUM7QUFBQSxJQUN6QztBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQSxLQUFLLE1BQU07QUFBQSxJQUNYO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxFQUNGLEVBQUUsS0FBSyxJQUFJO0FBQ2I7QUFNQSxLQUFLLG1FQUErQyxNQUFNO0FBQ3hELGVBQWEsVUFBVTtBQUd2QixRQUFNLFFBQVEsaUJBQWlCO0FBQy9CLFNBQU8sZ0JBQWdCLE1BQU0sUUFBUSxHQUFHLG1EQUFtRDtBQUczRixrQkFBZ0IsRUFBRSxJQUFJLFFBQVEsT0FBTyxXQUFXLFFBQVEsU0FBUyxDQUFDO0FBQ2xFLGtCQUFnQixFQUFFLElBQUksUUFBUSxPQUFPLGFBQWEsUUFBUSxTQUFTLENBQUM7QUFFcEUsUUFBTSxNQUFNLGlCQUFpQjtBQUM3QixTQUFPLGdCQUFnQixJQUFJLFFBQVEsR0FBRyx1Q0FBdUM7QUFDN0UsU0FBTyxnQkFBZ0IsSUFBSSxDQUFDLEVBQUUsSUFBSSxRQUFRLHlCQUF5QjtBQUNuRSxTQUFPLGdCQUFnQixJQUFJLENBQUMsRUFBRSxJQUFJLFFBQVEsMEJBQTBCO0FBQ3BFLFNBQU8sZ0JBQWdCLElBQUksQ0FBQyxFQUFFLE9BQU8sV0FBVyx5QkFBeUI7QUFDekUsU0FBTyxnQkFBZ0IsSUFBSSxDQUFDLEVBQUUsUUFBUSxVQUFVLDBCQUEwQjtBQUcxRSxRQUFNLFdBQVcsbUJBQW1CLE1BQU07QUFDMUMsU0FBTyxnQkFBZ0IsU0FBUyxRQUFRLEdBQUcsaURBQWlEO0FBRzVGLGNBQVksRUFBRSxJQUFJLE9BQU8sYUFBYSxRQUFRLE9BQU8sV0FBVyxRQUFRLFdBQVcsQ0FBQztBQUNwRixjQUFZLEVBQUUsSUFBSSxPQUFPLGFBQWEsUUFBUSxPQUFPLFdBQVcsUUFBUSxVQUFVLENBQUM7QUFDbkYsY0FBWSxFQUFFLElBQUksT0FBTyxhQUFhLFFBQVEsT0FBTyxZQUFZLFFBQVEsVUFBVSxDQUFDO0FBRXBGLFFBQU0sV0FBVyxtQkFBbUIsTUFBTTtBQUMxQyxTQUFPLGdCQUFnQixTQUFTLFFBQVEsR0FBRyxtQkFBbUI7QUFDOUQsU0FBTyxnQkFBZ0IsU0FBUyxDQUFDLEVBQUUsSUFBSSxPQUFPLG9CQUFvQjtBQUNsRSxTQUFPLGdCQUFnQixTQUFTLENBQUMsRUFBRSxRQUFRLFlBQVksd0JBQXdCO0FBQy9FLFNBQU8sZ0JBQWdCLFNBQVMsQ0FBQyxFQUFFLElBQUksT0FBTyxxQkFBcUI7QUFDbkUsU0FBTyxnQkFBZ0IsU0FBUyxDQUFDLEVBQUUsUUFBUSxXQUFXLHVCQUF1QjtBQUU3RSxRQUFNLFdBQVcsbUJBQW1CLE1BQU07QUFDMUMsU0FBTyxnQkFBZ0IsU0FBUyxRQUFRLEdBQUcsa0JBQWtCO0FBRTdELGdCQUFjO0FBQ2hCLENBQUM7QUFFRCxLQUFLLHFFQUFpRCxNQUFNO0FBQzFELGVBQWEsVUFBVTtBQUd2QixRQUFNLFVBQVUsWUFBWSxrQkFBa0I7QUFDOUMsU0FBTyxnQkFBZ0IsU0FBUyxNQUFNLDJDQUEyQztBQUdqRixpQkFBZTtBQUFBLElBQ2IsTUFBTTtBQUFBLElBQ04sZUFBZTtBQUFBLElBQ2YsY0FBYztBQUFBLElBQ2QsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLElBQ1QsY0FBYztBQUFBLEVBQ2hCLENBQUM7QUFFRCxRQUFNLFFBQVEsWUFBWSxpQ0FBaUM7QUFDM0QsU0FBTyxHQUFHLFVBQVUsTUFBTSxnREFBZ0Q7QUFDMUUsU0FBTyxnQkFBZ0IsTUFBTyxlQUFlLFdBQVcsdUJBQXVCO0FBQy9FLFNBQU8sZ0JBQWdCLE1BQU8sY0FBYyxRQUFRLHNCQUFzQjtBQUMxRSxTQUFPLGdCQUFnQixNQUFPLGNBQWMscUJBQXFCLGlCQUFpQjtBQUVsRixnQkFBYztBQUNoQixDQUFDO0FBTUQsS0FBSyxtRkFBK0QsWUFBWTtBQUM5RSxRQUFNLFNBQVMsV0FBVztBQUMxQixRQUFNLFNBQVMsS0FBSyxLQUFLLFFBQVEsUUFBUSxRQUFRO0FBQ2pELGVBQWEsTUFBTTtBQUNuQixpQkFBZTtBQUVmLE1BQUk7QUFDRixpQkFBYSxRQUFRLFFBQVEsQ0FBQyxPQUFPLEtBQUssQ0FBQztBQUczQyxvQkFBZ0IsRUFBRSxJQUFJLFFBQVEsT0FBTyxRQUFRLFFBQVEsU0FBUyxDQUFDO0FBQy9ELGdCQUFZLEVBQUUsSUFBSSxPQUFPLGFBQWEsUUFBUSxPQUFPLGNBQWMsUUFBUSxXQUFXLENBQUM7QUFDdkYsZ0JBQVksRUFBRSxJQUFJLE9BQU8sYUFBYSxRQUFRLE9BQU8sYUFBYSxRQUFRLFVBQVUsQ0FBQztBQUdyRixVQUFNLGlCQUFpQixtQkFBbUI7QUFBQSxNQUN4QyxFQUFFLElBQUksT0FBTyxPQUFPLGNBQWMsTUFBTSxNQUFNO0FBQUEsTUFDOUMsRUFBRSxJQUFJLE9BQU8sT0FBTyxhQUFhLE1BQU0sTUFBTTtBQUFBLElBQy9DLENBQUM7QUFDRCxVQUFNLGNBQWMsS0FBSyxLQUFLLFFBQVEsUUFBUSxjQUFjLFFBQVEsaUJBQWlCO0FBQ3JGLE9BQUcsY0FBYyxhQUFhLGNBQWM7QUFDNUMsbUJBQWU7QUFHZixVQUFNLEtBQUssTUFBTSx3QkFBd0IsUUFBUSxNQUFNO0FBQ3ZELFdBQU8sR0FBRyxJQUFJLHNDQUFzQztBQUdwRCxVQUFNLFdBQVcsR0FBRyxhQUFhLGFBQWEsT0FBTztBQUNyRCxtQkFBZTtBQUNmLFVBQU0sU0FBUyxhQUFhLFFBQVE7QUFFcEMsV0FBTyxnQkFBZ0IsT0FBTyxPQUFPLFFBQVEsR0FBRyxtQ0FBbUM7QUFFbkYsVUFBTSxNQUFNLE9BQU8sT0FBTyxLQUFLLE9BQUssRUFBRSxPQUFPLEtBQUs7QUFDbEQsVUFBTSxNQUFNLE9BQU8sT0FBTyxLQUFLLE9BQUssRUFBRSxPQUFPLEtBQUs7QUFDbEQsV0FBTyxHQUFHLENBQUMsQ0FBQyxLQUFLLDZCQUE2QjtBQUM5QyxXQUFPLEdBQUcsQ0FBQyxDQUFDLEtBQUssNkJBQTZCO0FBQzlDLFdBQU8sR0FBRyxJQUFLLE1BQU0sb0NBQW9DO0FBQ3pELFdBQU8sR0FBRyxDQUFDLElBQUssTUFBTSx5Q0FBeUM7QUFHL0QsVUFBTSxXQUFXLFlBQVksaUNBQWlDO0FBQzlELFdBQU8sR0FBRyxhQUFhLE1BQU0sNENBQTRDO0FBQ3pFLFdBQU8sR0FBRyxTQUFVLGFBQWEsU0FBUyxZQUFZLEdBQUcsNkJBQTZCO0FBQ3RGLFdBQU8sR0FBRyxTQUFVLGFBQWEsU0FBUyxZQUFZLEdBQUcsK0JBQStCO0FBQUEsRUFDMUYsVUFBRTtBQUNBLGtCQUFjO0FBQ2QsZUFBVyxNQUFNO0FBQUEsRUFDbkI7QUFDRixDQUFDO0FBRUQsS0FBSyxzRkFBa0UsWUFBWTtBQUNqRixRQUFNLFNBQVMsV0FBVztBQUMxQixRQUFNLFNBQVMsS0FBSyxLQUFLLFFBQVEsUUFBUSxRQUFRO0FBQ2pELGVBQWEsTUFBTTtBQUNuQixpQkFBZTtBQUVmLE1BQUk7QUFDRixpQkFBYSxRQUFRLFFBQVEsQ0FBQyxPQUFPLEtBQUssQ0FBQztBQUUzQyxvQkFBZ0IsRUFBRSxJQUFJLFFBQVEsT0FBTyxRQUFRLFFBQVEsU0FBUyxDQUFDO0FBRS9ELGdCQUFZLEVBQUUsSUFBSSxPQUFPLGFBQWEsUUFBUSxPQUFPLGNBQWMsUUFBUSxVQUFVLENBQUM7QUFDdEYsZ0JBQVksRUFBRSxJQUFJLE9BQU8sYUFBYSxRQUFRLE9BQU8sYUFBYSxRQUFRLFdBQVcsQ0FBQztBQUd0RixVQUFNLGlCQUFpQixtQkFBbUI7QUFBQSxNQUN4QyxFQUFFLElBQUksT0FBTyxPQUFPLGNBQWMsTUFBTSxLQUFLO0FBQUEsTUFDN0MsRUFBRSxJQUFJLE9BQU8sT0FBTyxhQUFhLE1BQU0sTUFBTTtBQUFBLElBQy9DLENBQUM7QUFDRCxVQUFNLGNBQWMsS0FBSyxLQUFLLFFBQVEsUUFBUSxjQUFjLFFBQVEsaUJBQWlCO0FBQ3JGLE9BQUcsY0FBYyxhQUFhLGNBQWM7QUFDNUMsbUJBQWU7QUFFZixVQUFNLEtBQUssTUFBTSx3QkFBd0IsUUFBUSxNQUFNO0FBQ3ZELFdBQU8sR0FBRyxJQUFJLG1DQUFtQztBQUVqRCxVQUFNLFdBQVcsR0FBRyxhQUFhLGFBQWEsT0FBTztBQUNyRCxtQkFBZTtBQUNmLFVBQU0sU0FBUyxhQUFhLFFBQVE7QUFFcEMsVUFBTSxNQUFNLE9BQU8sT0FBTyxLQUFLLE9BQUssRUFBRSxPQUFPLEtBQUs7QUFDbEQsVUFBTSxNQUFNLE9BQU8sT0FBTyxLQUFLLE9BQUssRUFBRSxPQUFPLEtBQUs7QUFDbEQsV0FBTyxHQUFHLENBQUMsSUFBSyxNQUFNLHNEQUFzRDtBQUM1RSxXQUFPLEdBQUcsSUFBSyxNQUFNLHVEQUF1RDtBQUFBLEVBQzlFLFVBQUU7QUFDQSxrQkFBYztBQUNkLGVBQVcsTUFBTTtBQUFBLEVBQ25CO0FBQ0YsQ0FBQztBQU1ELEtBQUssZ0ZBQTRELFlBQVk7QUFDM0UsUUFBTSxTQUFTLFdBQVc7QUFDMUIsUUFBTSxTQUFTLEtBQUssS0FBSyxRQUFRLFFBQVEsUUFBUTtBQUNqRCxlQUFhLE1BQU07QUFDbkIsaUJBQWU7QUFFZixNQUFJO0FBQ0YsaUJBQWEsUUFBUSxRQUFRLENBQUMsS0FBSyxDQUFDO0FBRXBDLG9CQUFnQixFQUFFLElBQUksUUFBUSxPQUFPLFFBQVEsUUFBUSxTQUFTLENBQUM7QUFDL0QsZ0JBQVksRUFBRSxJQUFJLE9BQU8sYUFBYSxRQUFRLE9BQU8sU0FBUyxRQUFRLFVBQVUsQ0FBQztBQUNqRixlQUFXLEVBQUUsSUFBSSxPQUFPLFNBQVMsT0FBTyxhQUFhLFFBQVEsT0FBTyxjQUFjLFFBQVEsT0FBTyxDQUFDO0FBQ2xHLGVBQVcsRUFBRSxJQUFJLE9BQU8sU0FBUyxPQUFPLGFBQWEsUUFBUSxPQUFPLGVBQWUsUUFBUSxPQUFPLENBQUM7QUFDbkcsZUFBVyxFQUFFLElBQUksT0FBTyxTQUFTLE9BQU8sYUFBYSxRQUFRLE9BQU8sY0FBYyxRQUFRLFVBQVUsQ0FBQztBQUdyRyxVQUFNLGNBQWMsZ0JBQWdCLE9BQU87QUFBQSxNQUN6QyxFQUFFLElBQUksT0FBTyxPQUFPLGNBQWMsTUFBTSxNQUFNO0FBQUEsTUFDOUMsRUFBRSxJQUFJLE9BQU8sT0FBTyxlQUFlLE1BQU0sTUFBTTtBQUFBLE1BQy9DLEVBQUUsSUFBSSxPQUFPLE9BQU8sY0FBYyxNQUFNLE1BQU07QUFBQSxJQUNoRCxDQUFDO0FBQ0QsVUFBTSxXQUFXLEtBQUssS0FBSyxRQUFRLFFBQVEsY0FBYyxRQUFRLFVBQVUsT0FBTyxhQUFhO0FBQy9GLE9BQUcsY0FBYyxVQUFVLFdBQVc7QUFDdEMsbUJBQWU7QUFFZixVQUFNLEtBQUssTUFBTSxxQkFBcUIsUUFBUSxRQUFRLEtBQUs7QUFDM0QsV0FBTyxHQUFHLElBQUksbUNBQW1DO0FBRWpELFVBQU0sV0FBVyxHQUFHLGFBQWEsVUFBVSxPQUFPO0FBQ2xELG1CQUFlO0FBQ2YsVUFBTSxTQUFTLFVBQVUsUUFBUTtBQUVqQyxXQUFPLGdCQUFnQixPQUFPLE1BQU0sUUFBUSxHQUFHLCtCQUErQjtBQUU5RSxVQUFNLE1BQU0sT0FBTyxNQUFNLEtBQUssT0FBSyxFQUFFLE9BQU8sS0FBSztBQUNqRCxVQUFNLE1BQU0sT0FBTyxNQUFNLEtBQUssT0FBSyxFQUFFLE9BQU8sS0FBSztBQUNqRCxVQUFNLE1BQU0sT0FBTyxNQUFNLEtBQUssT0FBSyxFQUFFLE9BQU8sS0FBSztBQUNqRCxXQUFPLEdBQUcsSUFBSyxNQUFNLDBCQUEwQjtBQUMvQyxXQUFPLEdBQUcsSUFBSyxNQUFNLDBCQUEwQjtBQUMvQyxXQUFPLEdBQUcsQ0FBQyxJQUFLLE1BQU0sK0JBQStCO0FBQUEsRUFDdkQsVUFBRTtBQUNBLGtCQUFjO0FBQ2QsZUFBVyxNQUFNO0FBQUEsRUFDbkI7QUFDRixDQUFDO0FBRUQsS0FBSyxtRkFBK0QsWUFBWTtBQUM5RSxRQUFNLFNBQVMsV0FBVztBQUMxQixRQUFNLFNBQVMsS0FBSyxLQUFLLFFBQVEsUUFBUSxRQUFRO0FBQ2pELGVBQWEsTUFBTTtBQUNuQixpQkFBZTtBQUVmLE1BQUk7QUFDRixpQkFBYSxRQUFRLFFBQVEsQ0FBQyxLQUFLLENBQUM7QUFFcEMsb0JBQWdCLEVBQUUsSUFBSSxRQUFRLE9BQU8sUUFBUSxRQUFRLFNBQVMsQ0FBQztBQUMvRCxnQkFBWSxFQUFFLElBQUksT0FBTyxhQUFhLFFBQVEsT0FBTyxTQUFTLFFBQVEsVUFBVSxDQUFDO0FBRWpGLGVBQVcsRUFBRSxJQUFJLE9BQU8sU0FBUyxPQUFPLGFBQWEsUUFBUSxPQUFPLGNBQWMsUUFBUSxVQUFVLENBQUM7QUFDckcsZUFBVyxFQUFFLElBQUksT0FBTyxTQUFTLE9BQU8sYUFBYSxRQUFRLE9BQU8sZUFBZSxRQUFRLE9BQU8sQ0FBQztBQUVuRyxVQUFNLGNBQWMsZ0JBQWdCLE9BQU87QUFBQSxNQUN6QyxFQUFFLElBQUksT0FBTyxPQUFPLGNBQWMsTUFBTSxLQUFLO0FBQUE7QUFBQSxNQUM3QyxFQUFFLElBQUksT0FBTyxPQUFPLGVBQWUsTUFBTSxNQUFNO0FBQUE7QUFBQSxJQUNqRCxDQUFDO0FBQ0QsVUFBTSxXQUFXLEtBQUssS0FBSyxRQUFRLFFBQVEsY0FBYyxRQUFRLFVBQVUsT0FBTyxhQUFhO0FBQy9GLE9BQUcsY0FBYyxVQUFVLFdBQVc7QUFDdEMsbUJBQWU7QUFFZixVQUFNLEtBQUssTUFBTSxxQkFBcUIsUUFBUSxRQUFRLEtBQUs7QUFDM0QsV0FBTyxHQUFHLElBQUksd0NBQXdDO0FBRXRELFVBQU0sV0FBVyxHQUFHLGFBQWEsVUFBVSxPQUFPO0FBQ2xELG1CQUFlO0FBQ2YsVUFBTSxTQUFTLFVBQVUsUUFBUTtBQUVqQyxVQUFNLE1BQU0sT0FBTyxNQUFNLEtBQUssT0FBSyxFQUFFLE9BQU8sS0FBSztBQUNqRCxVQUFNLE1BQU0sT0FBTyxNQUFNLEtBQUssT0FBSyxFQUFFLE9BQU8sS0FBSztBQUNqRCxXQUFPLEdBQUcsQ0FBQyxJQUFLLE1BQU0sOENBQThDO0FBQ3BFLFdBQU8sR0FBRyxJQUFLLE1BQU0sMkNBQTJDO0FBQUEsRUFDbEUsVUFBRTtBQUNBLGtCQUFjO0FBQ2QsZUFBVyxNQUFNO0FBQUEsRUFDbkI7QUFDRixDQUFDO0FBRUQsS0FBSyx1SEFBbUcsWUFBWTtBQUNsSCxRQUFNLFNBQVMsV0FBVztBQUMxQixRQUFNLFNBQVMsS0FBSyxLQUFLLFFBQVEsUUFBUSxRQUFRO0FBQ2pELGVBQWEsTUFBTTtBQUNuQixpQkFBZTtBQUVmLE1BQUk7QUFDRixpQkFBYSxRQUFRLFFBQVEsQ0FBQyxLQUFLLENBQUM7QUFFcEMsb0JBQWdCLEVBQUUsSUFBSSxRQUFRLE9BQU8sYUFBYSxRQUFRLFNBQVMsQ0FBQztBQUNwRSxnQkFBWTtBQUFBLE1BQ1YsSUFBSTtBQUFBLE1BQ0osYUFBYTtBQUFBLE1BQ2IsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsTUFBTTtBQUFBLE1BQ04sVUFBVTtBQUFBLFFBQ1IsTUFBTTtBQUFBLFFBQ04saUJBQWlCO0FBQUEsUUFDakIsWUFBWTtBQUFBLFFBQ1osb0JBQW9CO0FBQUEsUUFDcEIscUJBQXFCO0FBQUEsTUFDdkI7QUFBQSxJQUNGLENBQUM7QUFDRCxlQUFXO0FBQUEsTUFDVCxJQUFJO0FBQUEsTUFDSixTQUFTO0FBQUEsTUFDVCxhQUFhO0FBQUEsTUFDYixPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixVQUFVO0FBQUEsUUFDUixhQUFhO0FBQUEsUUFDYixVQUFVO0FBQUEsUUFDVixPQUFPLENBQUMsbURBQW1EO0FBQUEsUUFDM0QsUUFBUTtBQUFBLFFBQ1IsUUFBUSxDQUFDLG1EQUFtRDtBQUFBLFFBQzVELGdCQUFnQixDQUFDLDhEQUE4RDtBQUFBLFFBQy9FLHFCQUFxQjtBQUFBLE1BQ3ZCO0FBQUEsSUFDRixDQUFDO0FBQ0QsZUFBVztBQUFBLE1BQ1QsSUFBSTtBQUFBLE1BQ0osU0FBUztBQUFBLE1BQ1QsYUFBYTtBQUFBLE1BQ2IsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsVUFBVTtBQUFBLFFBQ1IsYUFBYTtBQUFBLFFBQ2IsVUFBVTtBQUFBLFFBQ1YsT0FBTyxDQUFDLHVDQUF1QztBQUFBLFFBQy9DLFFBQVE7QUFBQSxRQUNSLFFBQVEsQ0FBQyx1Q0FBdUM7QUFBQSxRQUNoRCxnQkFBZ0IsQ0FBQywwREFBMEQ7QUFBQSxRQUMzRSxxQkFBcUI7QUFBQSxNQUN2QjtBQUFBLElBQ0YsQ0FBQztBQUVELFVBQU0sV0FBVyxNQUFNLGlCQUFpQixRQUFRLFFBQVEsS0FBSztBQUM3RCxXQUFPLEdBQUcsR0FBRyxXQUFXLFNBQVMsUUFBUSxHQUFHLDRCQUE0QjtBQUN4RSxXQUFPLFlBQVksU0FBUyxjQUFjLFFBQVEsR0FBRyx3Q0FBd0M7QUFDN0YsV0FBTyxHQUFHLFNBQVMsY0FBYyxNQUFNLENBQUMsTUFBTSxHQUFHLFdBQVcsQ0FBQyxDQUFDLEdBQUcscUNBQXFDO0FBRXRHLFVBQU0sY0FBYyxHQUFHLGFBQWEsU0FBUyxVQUFVLE9BQU87QUFDOUQsbUJBQWU7QUFDZixVQUFNLGFBQWEsVUFBVSxXQUFXO0FBQ3hDLFdBQU8sWUFBWSxXQUFXLElBQUksT0FBTyxrREFBa0Q7QUFDM0YsV0FBTyxZQUFZLFdBQVcsTUFBTSxxQ0FBcUMsb0NBQW9DO0FBQzdHLFdBQU8sWUFBWSxXQUFXLE1BQU0saUNBQWlDLG9DQUFvQztBQUN6RyxXQUFPLFlBQVksV0FBVyxVQUFVLFFBQVEsR0FBRyx3Q0FBd0M7QUFDM0YsV0FBTyxZQUFZLFdBQVcsTUFBTSxRQUFRLEdBQUcsdUNBQXVDO0FBQ3RGLFdBQU8sWUFBWSxXQUFXLE1BQU0sQ0FBQyxFQUFFLElBQUksT0FBTyw2QkFBNkI7QUFDL0UsV0FBTyxHQUFHLFdBQVcsTUFBTSxDQUFDLEVBQUUsWUFBWSxTQUFTLCtCQUErQixHQUFHLDBDQUEwQztBQUMvSCxXQUFPLFlBQVksV0FBVyxNQUFNLENBQUMsRUFBRSxRQUFRLENBQUMsR0FBRyxxREFBcUQsb0NBQW9DO0FBQzVJLFdBQU8sWUFBWSxXQUFXLE1BQU0sQ0FBQyxFQUFFLFFBQVEseUNBQXlDLHFDQUFxQztBQUU3SCxVQUFNLGVBQWUsWUFBWSx3Q0FBd0M7QUFDekUsV0FBTyxHQUFHLGlCQUFpQixNQUFNLGtDQUFrQztBQUNuRSxXQUFPLEdBQUcsYUFBYyxhQUFhLFNBQVMsVUFBVSxHQUFHLDRDQUE0QztBQUV2RyxVQUFNLGVBQWUsS0FBSyxLQUFLLFFBQVEsUUFBUSxjQUFjLFFBQVEsVUFBVSxPQUFPLFNBQVMsYUFBYTtBQUM1RyxVQUFNLGtCQUFrQixHQUFHLGFBQWEsY0FBYyxPQUFPO0FBQzdELFVBQU0sZUFBZSxrQkFBa0IsZUFBZTtBQUN0RCxXQUFPLFlBQVksYUFBYSxZQUFZLGlCQUFpQixHQUFHLCtDQUErQztBQUMvRyxXQUFPLFlBQVksYUFBYSxZQUFZLGlCQUFpQixHQUFHLCtDQUErQztBQUMvRyxXQUFPLFlBQVksYUFBYSxZQUFZLFlBQVksUUFBUSxHQUFHLDJEQUEyRDtBQUM5SCxXQUFPLE1BQU0saUJBQWlCLDhCQUE4QixnQ0FBZ0M7QUFDNUYsV0FBTyxNQUFNLGlCQUFpQixnQkFBZ0Isa0NBQWtDO0FBQ2hGLFdBQU8sTUFBTSxpQkFBaUIseUJBQXlCLDJDQUEyQztBQUNsRyxXQUFPLE1BQU0saUJBQWlCLHNCQUFzQix3Q0FBd0M7QUFFNUYsVUFBTSxlQUFlLFlBQVksOENBQThDO0FBQy9FLFdBQU8sR0FBRyxpQkFBaUIsTUFBTSxpQ0FBaUM7QUFDbEUsV0FBTyxHQUFHLGFBQWMsYUFBYSxTQUFTLGlCQUFpQixHQUFHLDhEQUE4RDtBQUFBLEVBQ2xJLFVBQUU7QUFDQSxrQkFBYztBQUNkLGVBQVcsTUFBTTtBQUFBLEVBQ25CO0FBQ0YsQ0FBQztBQUVELEtBQUssd0hBQW9HLFlBQVk7QUFDbkgsUUFBTSxTQUFTLFdBQVc7QUFDMUIsUUFBTSxTQUFTLEtBQUssS0FBSyxRQUFRLFFBQVEsUUFBUTtBQUNqRCxlQUFhLE1BQU07QUFDbkIsaUJBQWU7QUFFZixNQUFJO0FBQ0YsaUJBQWEsUUFBUSxRQUFRLENBQUMsS0FBSyxDQUFDO0FBRXBDLG9CQUFnQixFQUFFLElBQUksUUFBUSxPQUFPLGFBQWEsUUFBUSxTQUFTLENBQUM7QUFDcEUsZ0JBQVk7QUFBQSxNQUNWLElBQUk7QUFBQSxNQUNKLGFBQWE7QUFBQSxNQUNiLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLE1BQU07QUFBQSxNQUNOLFVBQVU7QUFBQSxRQUNSLE1BQU07QUFBQSxRQUNOLGlCQUFpQjtBQUFBLFFBQ2pCLFlBQVk7QUFBQSxRQUNaLG9CQUFvQjtBQUFBLFFBQ3BCLHFCQUFxQjtBQUFBLE1BQ3ZCO0FBQUEsSUFDRixDQUFDO0FBQ0QsZUFBVztBQUFBLE1BQ1QsSUFBSTtBQUFBLE1BQ0osU0FBUztBQUFBLE1BQ1QsYUFBYTtBQUFBLE1BQ2IsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsVUFBVTtBQUFBLFFBQ1IsYUFBYTtBQUFBLFVBQ1g7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxRQUNGLEVBQUUsS0FBSyxJQUFJO0FBQUEsUUFDWCxVQUFVO0FBQUEsUUFDVixPQUFPLENBQUMsY0FBYyxVQUFVLFdBQVc7QUFBQSxRQUMzQyxRQUFRO0FBQUEsUUFDUixRQUFRLENBQUMsWUFBWTtBQUFBLFFBQ3JCLGdCQUFnQixDQUFDLGNBQWMsVUFBVSxXQUFXO0FBQUEsTUFDdEQ7QUFBQSxJQUNGLENBQUM7QUFFRCxVQUFNLFdBQVcsTUFBTSxpQkFBaUIsUUFBUSxRQUFRLEtBQUs7QUFDN0QsVUFBTSxjQUFjLEdBQUcsYUFBYSxTQUFTLFVBQVUsT0FBTztBQUM5RCxtQkFBZTtBQUNmLFVBQU0sYUFBYSxVQUFVLFdBQVc7QUFFeEMsV0FBTyxhQUFhLGFBQWEsaUJBQWlCLHNDQUFzQztBQUN4RixXQUFPLGFBQWEsYUFBYSxlQUFlLDBEQUEwRDtBQUMxRyxXQUFPLGFBQWEsWUFBWSxNQUFNLG1CQUFtQixLQUFLLENBQUMsR0FBRyxRQUFRLEdBQUcsZ0RBQWdEO0FBQzdILFdBQU8sWUFBWSxXQUFXLE1BQU0sQ0FBQyxFQUFFLFlBQVksS0FBSyxHQUFHLDhCQUE4QjtBQUV6RixVQUFNLGtCQUFrQixHQUFHLGFBQWEsS0FBSyxLQUFLLFFBQVEsUUFBUSxjQUFjLFFBQVEsVUFBVSxPQUFPLFNBQVMsYUFBYSxHQUFHLE9BQU87QUFDekksV0FBTyxNQUFNLGlCQUFpQixlQUFlLGlEQUFpRDtBQUM5RixXQUFPLE1BQU0saUJBQWlCLG9CQUFvQiwwQ0FBMEM7QUFBQSxFQUM5RixVQUFFO0FBQ0Esa0JBQWM7QUFDZCxlQUFXLE1BQU07QUFBQSxFQUNuQjtBQUNGLENBQUM7QUFFRCxLQUFLLDZGQUF5RSxZQUFZO0FBQ3hGLFFBQU0sU0FBUyxXQUFXO0FBQzFCLFFBQU0sU0FBUyxLQUFLLEtBQUssUUFBUSxRQUFRLFFBQVE7QUFDakQsZUFBYSxNQUFNO0FBQ25CLGlCQUFlO0FBRWYsTUFBSTtBQUNGLGlCQUFhLFFBQVEsUUFBUSxDQUFDLEtBQUssQ0FBQztBQUNwQyxvQkFBZ0IsRUFBRSxJQUFJLFFBQVEsT0FBTyxhQUFhLFFBQVEsU0FBUyxDQUFDO0FBQ3BFLGdCQUFZLEVBQUUsSUFBSSxPQUFPLGFBQWEsUUFBUSxPQUFPLFNBQVMsUUFBUSxVQUFVLENBQUM7QUFFakYsUUFBSSxRQUFRO0FBQ1osUUFBSTtBQUNGLFlBQU0scUJBQXFCLFFBQVEsUUFBUSxPQUFPLEtBQUs7QUFBQSxJQUN6RCxTQUFTLE9BQU87QUFDZCxjQUFRO0FBQ1IsYUFBTyxNQUFNLE9BQVEsTUFBZ0IsT0FBTyxHQUFHLGlDQUFpQyxtRUFBbUU7QUFBQSxJQUNySjtBQUNBLFdBQU8sR0FBRyxPQUFPLDBEQUEwRDtBQUFBLEVBQzdFLFVBQUU7QUFDQSxrQkFBYztBQUNkLGVBQVcsTUFBTTtBQUFBLEVBQ25CO0FBQ0YsQ0FBQztBQU9ELEtBQUssNkVBQXlELFlBQVk7QUFDeEUsUUFBTSxTQUFTLFdBQVc7QUFDMUIsUUFBTSxTQUFTLEtBQUssS0FBSyxRQUFRLFFBQVEsUUFBUTtBQUNqRCxlQUFhLE1BQU07QUFDbkIsaUJBQWU7QUFFZixNQUFJO0FBQ0YsaUJBQWEsUUFBUSxRQUFRLENBQUMsS0FBSyxDQUFDO0FBRXBDLG9CQUFnQixFQUFFLElBQUksUUFBUSxPQUFPLFFBQVEsUUFBUSxTQUFTLENBQUM7QUFDL0QsZ0JBQVksRUFBRSxJQUFJLE9BQU8sYUFBYSxRQUFRLE9BQU8sU0FBUyxRQUFRLFVBQVUsQ0FBQztBQUVqRixVQUFNLGlCQUFpQix1QkFBdUIsS0FBSztBQUNuRCxlQUFXO0FBQUEsTUFDVCxJQUFJO0FBQUEsTUFDSixTQUFTO0FBQUEsTUFDVCxhQUFhO0FBQUEsTUFDYixPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixlQUFlO0FBQUEsSUFDakIsQ0FBQztBQUVELFVBQU0sS0FBSyxNQUFNLGtCQUFrQixRQUFRLFFBQVEsT0FBTyxLQUFLO0FBQy9ELFdBQU8sR0FBRyxJQUFJLGdDQUFnQztBQUc5QyxVQUFNLGNBQWMsS0FBSztBQUFBLE1BQ3ZCO0FBQUEsTUFBUTtBQUFBLE1BQVE7QUFBQSxNQUFjO0FBQUEsTUFBUTtBQUFBLE1BQVU7QUFBQSxNQUFPO0FBQUEsTUFBUztBQUFBLElBQ2xFO0FBQ0EsV0FBTyxHQUFHLEdBQUcsV0FBVyxXQUFXLEdBQUcsZ0NBQWdDO0FBR3RFLFVBQU0sV0FBVyxHQUFHLGFBQWEsYUFBYSxPQUFPO0FBQ3JELG1CQUFlO0FBQ2YsVUFBTSxTQUFTLGFBQWEsUUFBUTtBQUNwQyxXQUFPLGdCQUFnQixPQUFPLFlBQVksSUFBSSxPQUFPLCtCQUErQjtBQUNwRixXQUFPLGdCQUFnQixPQUFPLFlBQVksUUFBUSxPQUFPLG1DQUFtQztBQUM1RixXQUFPLGdCQUFnQixPQUFPLFlBQVksV0FBVyxRQUFRLHNDQUFzQztBQUNuRyxXQUFPLGdCQUFnQixPQUFPLFlBQVksVUFBVSxPQUFPLHFDQUFxQztBQUNoRyxXQUFPLEdBQUcsT0FBTyxNQUFNLFNBQVMsS0FBSyxHQUFHLHVDQUF1QztBQUMvRSxXQUFPLEdBQUcsT0FBTyxhQUFhLFNBQVMsd0JBQXdCLEdBQUcsZ0NBQWdDO0FBQUEsRUFDcEcsVUFBRTtBQUNBLGtCQUFjO0FBQ2QsZUFBVyxNQUFNO0FBQUEsRUFDbkI7QUFDRixDQUFDO0FBRUQsS0FBSyw4RUFBMEQsWUFBWTtBQUN6RSxRQUFNLFNBQVMsV0FBVztBQUMxQixRQUFNLFNBQVMsS0FBSyxLQUFLLFFBQVEsUUFBUSxRQUFRO0FBQ2pELGVBQWEsTUFBTTtBQUNuQixpQkFBZTtBQUVmLE1BQUk7QUFDRixpQkFBYSxRQUFRLFFBQVEsQ0FBQyxLQUFLLENBQUM7QUFFcEMsb0JBQWdCLEVBQUUsSUFBSSxRQUFRLE9BQU8sUUFBUSxRQUFRLFNBQVMsQ0FBQztBQUMvRCxnQkFBWSxFQUFFLElBQUksT0FBTyxhQUFhLFFBQVEsT0FBTyxTQUFTLFFBQVEsVUFBVSxDQUFDO0FBQ2pGLGVBQVc7QUFBQSxNQUNULElBQUk7QUFBQSxNQUNKLFNBQVM7QUFBQSxNQUNULGFBQWE7QUFBQSxNQUNiLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLGVBQWU7QUFBQTtBQUFBLElBQ2pCLENBQUM7QUFFRCxVQUFNLEtBQUssTUFBTSxrQkFBa0IsUUFBUSxRQUFRLE9BQU8sS0FBSztBQUMvRCxXQUFPLEdBQUcsQ0FBQyxJQUFJLG1EQUFtRDtBQUFBLEVBQ3BFLFVBQUU7QUFDQSxrQkFBYztBQUNkLGVBQVcsTUFBTTtBQUFBLEVBQ25CO0FBQ0YsQ0FBQztBQU1ELEtBQUssOEVBQTBELFlBQVk7QUFDekUsUUFBTSxTQUFTLFdBQVc7QUFDMUIsUUFBTSxTQUFTLEtBQUssS0FBSyxRQUFRLFFBQVEsUUFBUTtBQUNqRCxlQUFhLE1BQU07QUFDbkIsaUJBQWU7QUFFZixNQUFJO0FBQ0YsaUJBQWEsUUFBUSxRQUFRLENBQUMsS0FBSyxDQUFDO0FBRXBDLG9CQUFnQixFQUFFLElBQUksUUFBUSxPQUFPLFFBQVEsUUFBUSxTQUFTLENBQUM7QUFDL0QsZ0JBQVksRUFBRSxJQUFJLE9BQU8sYUFBYSxRQUFRLE9BQU8sU0FBUyxRQUFRLFdBQVcsQ0FBQztBQUlsRixVQUFNLEtBQUssTUFBTSxPQUFPLGNBQWM7QUFDdEMsVUFBTSxVQUFVLEdBQUcsWUFBWTtBQUMvQixZQUFRO0FBQUEsTUFDTjtBQUFBLElBQ0YsRUFBRSxJQUFJO0FBQUEsTUFDSixPQUFPO0FBQUEsTUFDUCxPQUFPO0FBQUEsSUFDVCxDQUFDO0FBRUQsVUFBTSxLQUFLLE1BQU0sbUJBQW1CLFFBQVEsUUFBUSxLQUFLO0FBQ3pELFdBQU8sR0FBRyxJQUFJLGlDQUFpQztBQUcvQyxVQUFNLGNBQWMsS0FBSztBQUFBLE1BQ3ZCO0FBQUEsTUFBUTtBQUFBLE1BQVE7QUFBQSxNQUFjO0FBQUEsTUFBUTtBQUFBLE1BQVU7QUFBQSxNQUFPO0FBQUEsSUFDekQ7QUFDQSxXQUFPLEdBQUcsR0FBRyxXQUFXLFdBQVcsR0FBRyxnQ0FBZ0M7QUFFdEUsVUFBTSxpQkFBaUIsR0FBRyxhQUFhLGFBQWEsT0FBTztBQUMzRCxXQUFPLEdBQUcsZUFBZSxTQUFTLG9CQUFvQixHQUFHLHlCQUF5QjtBQUdsRixVQUFNLFVBQVUsS0FBSztBQUFBLE1BQ25CO0FBQUEsTUFBUTtBQUFBLE1BQVE7QUFBQSxNQUFjO0FBQUEsTUFBUTtBQUFBLE1BQVU7QUFBQSxNQUFPO0FBQUEsSUFDekQ7QUFDQSxXQUFPLEdBQUcsR0FBRyxXQUFXLE9BQU8sR0FBRyw0QkFBNEI7QUFFOUQsVUFBTSxhQUFhLEdBQUcsYUFBYSxTQUFTLE9BQU87QUFDbkQsV0FBTyxHQUFHLFdBQVcsU0FBUyxpQkFBaUIsR0FBRyxxQkFBcUI7QUFBQSxFQUN6RSxVQUFFO0FBQ0Esa0JBQWM7QUFDZCxlQUFXLE1BQU07QUFBQSxFQUNuQjtBQUNGLENBQUM7QUFNRCxLQUFLLG1GQUErRCxZQUFZO0FBQzlFLFFBQU0sU0FBUyxXQUFXO0FBQzFCLFFBQU0sU0FBUyxLQUFLLEtBQUssUUFBUSxRQUFRLFFBQVE7QUFDakQsZUFBYSxNQUFNO0FBQ25CLGlCQUFlO0FBRWYsTUFBSTtBQUVGLGlCQUFhLFFBQVEsUUFBUSxDQUFDLE9BQU8sS0FBSyxDQUFDO0FBQzNDLGlCQUFhLFFBQVEsUUFBUSxDQUFDLEtBQUssQ0FBQztBQUVwQyxvQkFBZ0IsRUFBRSxJQUFJLFFBQVEsT0FBTyxTQUFTLFFBQVEsU0FBUyxDQUFDO0FBQ2hFLG9CQUFnQixFQUFFLElBQUksUUFBUSxPQUFPLFVBQVUsUUFBUSxTQUFTLENBQUM7QUFFakUsZ0JBQVksRUFBRSxJQUFJLE9BQU8sYUFBYSxRQUFRLE9BQU8sUUFBUSxRQUFRLFdBQVcsQ0FBQztBQUNqRixnQkFBWSxFQUFFLElBQUksT0FBTyxhQUFhLFFBQVEsT0FBTyxVQUFVLFFBQVEsVUFBVSxDQUFDO0FBQ2xGLGdCQUFZLEVBQUUsSUFBSSxPQUFPLGFBQWEsUUFBUSxPQUFPLFVBQVUsUUFBUSxVQUFVLENBQUM7QUFFbEYsZUFBVyxFQUFFLElBQUksT0FBTyxTQUFTLE9BQU8sYUFBYSxRQUFRLE9BQU8sTUFBTSxRQUFRLFFBQVEsZUFBZSx1QkFBdUIsS0FBSyxFQUFFLENBQUM7QUFDeEksZUFBVyxFQUFFLElBQUksT0FBTyxTQUFTLE9BQU8sYUFBYSxRQUFRLE9BQU8sWUFBWSxRQUFRLFVBQVUsQ0FBQztBQUNuRyxlQUFXLEVBQUUsSUFBSSxPQUFPLFNBQVMsT0FBTyxhQUFhLFFBQVEsT0FBTyxlQUFlLFFBQVEsVUFBVSxDQUFDO0FBR3RHLFVBQU0sV0FBVyxtQkFBbUI7QUFBQSxNQUNsQyxFQUFFLElBQUksT0FBTyxPQUFPLFFBQVEsTUFBTSxNQUFNO0FBQUEsTUFDeEMsRUFBRSxJQUFJLE9BQU8sT0FBTyxVQUFVLE1BQU0sTUFBTTtBQUFBLElBQzVDLENBQUM7QUFDRCxPQUFHO0FBQUEsTUFDRCxLQUFLLEtBQUssUUFBUSxRQUFRLGNBQWMsUUFBUSxpQkFBaUI7QUFBQSxNQUNqRTtBQUFBLElBQ0Y7QUFFQSxVQUFNLFdBQVcsbUJBQW1CO0FBQUEsTUFDbEMsRUFBRSxJQUFJLE9BQU8sT0FBTyxVQUFVLE1BQU0sTUFBTTtBQUFBLElBQzVDLENBQUM7QUFDRCxPQUFHO0FBQUEsTUFDRCxLQUFLLEtBQUssUUFBUSxRQUFRLGNBQWMsUUFBUSxpQkFBaUI7QUFBQSxNQUNqRTtBQUFBLElBQ0Y7QUFFQSxVQUFNLFFBQVEsZ0JBQWdCLE9BQU87QUFBQSxNQUNuQyxFQUFFLElBQUksT0FBTyxPQUFPLE1BQU0sTUFBTSxNQUFNO0FBQUEsSUFDeEMsQ0FBQztBQUNELE9BQUc7QUFBQSxNQUNELEtBQUssS0FBSyxRQUFRLFFBQVEsY0FBYyxRQUFRLFVBQVUsT0FBTyxhQUFhO0FBQUEsTUFDOUU7QUFBQSxJQUNGO0FBRUEsVUFBTSxRQUFRLGdCQUFnQixPQUFPO0FBQUEsTUFDbkMsRUFBRSxJQUFJLE9BQU8sT0FBTyxZQUFZLE1BQU0sTUFBTTtBQUFBLElBQzlDLENBQUM7QUFDRCxPQUFHO0FBQUEsTUFDRCxLQUFLLEtBQUssUUFBUSxRQUFRLGNBQWMsUUFBUSxVQUFVLE9BQU8sYUFBYTtBQUFBLE1BQzlFO0FBQUEsSUFDRjtBQUVBLFVBQU0sUUFBUSxnQkFBZ0IsT0FBTztBQUFBLE1BQ25DLEVBQUUsSUFBSSxPQUFPLE9BQU8sZUFBZSxNQUFNLE1BQU07QUFBQSxJQUNqRCxDQUFDO0FBQ0QsT0FBRztBQUFBLE1BQ0QsS0FBSyxLQUFLLFFBQVEsUUFBUSxjQUFjLFFBQVEsVUFBVSxPQUFPLGFBQWE7QUFBQSxNQUM5RTtBQUFBLElBQ0Y7QUFFQSxtQkFBZTtBQUVmLFVBQU0sU0FBUyxNQUFNLGdCQUFnQixNQUFNO0FBRTNDLFdBQU8sR0FBRyxPQUFPLFdBQVcsR0FBRyxxQ0FBcUM7QUFDcEUsV0FBTyxnQkFBZ0IsT0FBTyxPQUFPLFFBQVEsR0FBRywrQkFBK0I7QUFHL0UsVUFBTSxZQUFZLEdBQUc7QUFBQSxNQUNuQixLQUFLLEtBQUssUUFBUSxRQUFRLGNBQWMsUUFBUSxpQkFBaUI7QUFBQSxNQUFHO0FBQUEsSUFDdEU7QUFDQSxtQkFBZTtBQUNmLFVBQU0sVUFBVSxhQUFhLFNBQVM7QUFDdEMsVUFBTSxNQUFNLFFBQVEsT0FBTyxLQUFLLE9BQUssRUFBRSxPQUFPLEtBQUs7QUFDbkQsV0FBTyxHQUFHLElBQUssTUFBTSxrQ0FBa0M7QUFHdkQsVUFBTSxXQUFXLEdBQUc7QUFBQSxNQUNsQixLQUFLLEtBQUssUUFBUSxRQUFRLGNBQWMsUUFBUSxVQUFVLE9BQU8sYUFBYTtBQUFBLE1BQUc7QUFBQSxJQUNuRjtBQUNBLG1CQUFlO0FBQ2YsVUFBTSxhQUFhLFVBQVUsUUFBUTtBQUNyQyxXQUFPLEdBQUcsV0FBVyxNQUFNLENBQUMsRUFBRSxNQUFNLHNDQUFzQztBQUcxRSxVQUFNLGtCQUFrQixLQUFLO0FBQUEsTUFDM0I7QUFBQSxNQUFRO0FBQUEsTUFBUTtBQUFBLE1BQWM7QUFBQSxNQUFRO0FBQUEsTUFBVTtBQUFBLE1BQU87QUFBQSxNQUFTO0FBQUEsSUFDbEU7QUFDQSxXQUFPLEdBQUcsR0FBRyxXQUFXLGVBQWUsR0FBRyxrQ0FBa0M7QUFBQSxFQUM5RSxVQUFFO0FBQ0Esa0JBQWM7QUFDZCxlQUFXLE1BQU07QUFBQSxFQUNuQjtBQUNGLENBQUM7QUFNRCxLQUFLLHVIQUFtRyxZQUFZO0FBQ2xILFFBQU0sU0FBUyxXQUFXO0FBQzFCLFFBQU0sU0FBUyxLQUFLLEtBQUssUUFBUSxRQUFRLFFBQVE7QUFDakQsZUFBYSxNQUFNO0FBQ25CLGlCQUFlO0FBRWYsTUFBSTtBQUNGLGlCQUFhLFFBQVEsUUFBUSxDQUFDLEtBQUssQ0FBQztBQUVwQyxvQkFBZ0IsRUFBRSxJQUFJLFFBQVEsT0FBTyxRQUFRLFFBQVEsU0FBUyxDQUFDO0FBQy9ELGdCQUFZLEVBQUUsSUFBSSxPQUFPLGFBQWEsUUFBUSxPQUFPLFFBQVEsUUFBUSxXQUFXLENBQUM7QUFHakYsVUFBTSxpQkFBaUIsbUJBQW1CO0FBQUEsTUFDeEMsRUFBRSxJQUFJLE9BQU8sT0FBTyxRQUFRLE1BQU0sTUFBTTtBQUFBLElBQzFDLENBQUMsSUFBSTtBQUNMLFVBQU0sY0FBYyxLQUFLLEtBQUssUUFBUSxRQUFRLGNBQWMsUUFBUSxpQkFBaUI7QUFDckYsT0FBRyxjQUFjLGFBQWEsY0FBYztBQUM1QyxtQkFBZTtBQUdmLFVBQU0sU0FBUyxZQUFZLGlDQUFpQztBQUM1RCxXQUFPLGdCQUFnQixRQUFRLE1BQU0sa0NBQWtDO0FBR3ZFLFVBQU0sS0FBSyxNQUFNLHdCQUF3QixRQUFRLE1BQU07QUFDdkQsV0FBTyxHQUFHLElBQUkseUNBQXlDO0FBR3ZELFVBQU0sUUFBUSxZQUFZLGlDQUFpQztBQUMzRCxXQUFPLEdBQUcsVUFBVSxNQUFNLDRCQUE0QjtBQUN0RCxXQUFPLEdBQUcsQ0FBQyxNQUFPLGFBQWEsU0FBUyxvQkFBb0IsR0FBRywwQ0FBMEM7QUFDekcsV0FBTyxHQUFHLE1BQU8sYUFBYSxTQUFTLEtBQUssR0FBRyxxQ0FBcUM7QUFFcEYsV0FBTyxHQUFHLEdBQUcsV0FBVyxXQUFXLEdBQUcsd0NBQXdDO0FBQzlFLFVBQU0sWUFBWSxHQUFHLGFBQWEsYUFBYSxPQUFPO0FBQ3RELFdBQU8sR0FBRyxDQUFDLFVBQVUsU0FBUyxvQkFBb0IsR0FBRyx1Q0FBdUM7QUFDNUYsV0FBTyxHQUFHLFVBQVUsU0FBUyxLQUFLLEdBQUcseUNBQXlDO0FBQUEsRUFDaEYsVUFBRTtBQUNBLGtCQUFjO0FBQ2QsZUFBVyxNQUFNO0FBQUEsRUFDbkI7QUFDRixDQUFDO0FBTUQsS0FBSyxrRkFBOEQsWUFBWTtBQUM3RSxlQUFhLFVBQVU7QUFHdkIsa0JBQWdCLEVBQUUsSUFBSSxRQUFRLE9BQU8sUUFBUSxRQUFRLFNBQVMsQ0FBQztBQUcvRCxRQUFNLEtBQUssTUFBTSx3QkFBd0IscUJBQXFCLE1BQU07QUFDcEUsU0FBTyxHQUFHLENBQUMsSUFBSSxvQ0FBb0M7QUFFbkQsZ0JBQWM7QUFDaEIsQ0FBQztBQU1ELEtBQUssZ0dBQTRFLE1BQU07QUFDckYsUUFBTSxTQUFTLFdBQVc7QUFDMUIsUUFBTSxTQUFTLEtBQUssS0FBSyxRQUFRLFFBQVEsUUFBUTtBQUNqRCxlQUFhLE1BQU07QUFDbkIsaUJBQWU7QUFFZixNQUFJO0FBQ0YsaUJBQWEsUUFBUSxRQUFRLENBQUMsS0FBSyxDQUFDO0FBRXBDLG9CQUFnQixFQUFFLElBQUksUUFBUSxPQUFPLFFBQVEsUUFBUSxTQUFTLENBQUM7QUFDL0QsZ0JBQVksRUFBRSxJQUFJLE9BQU8sYUFBYSxRQUFRLE9BQU8sU0FBUyxRQUFRLFVBQVUsQ0FBQztBQUdqRixlQUFXLEVBQUUsSUFBSSxPQUFPLFNBQVMsT0FBTyxhQUFhLFFBQVEsT0FBTyxjQUFjLFFBQVEsT0FBTyxDQUFDO0FBQ2xHLGVBQVcsRUFBRSxJQUFJLE9BQU8sU0FBUyxPQUFPLGFBQWEsUUFBUSxPQUFPLGVBQWUsUUFBUSxPQUFPLENBQUM7QUFJbkcsVUFBTSxjQUFjLGdCQUFnQixPQUFPO0FBQUEsTUFDekMsRUFBRSxJQUFJLE9BQU8sT0FBTyxjQUFjLE1BQU0sS0FBSztBQUFBLE1BQzdDLEVBQUUsSUFBSSxPQUFPLE9BQU8sZUFBZSxNQUFNLE1BQU07QUFBQSxJQUNqRCxDQUFDO0FBQ0QsVUFBTSxXQUFXLEtBQUssS0FBSyxRQUFRLFFBQVEsY0FBYyxRQUFRLFVBQVUsT0FBTyxhQUFhO0FBQy9GLE9BQUcsY0FBYyxVQUFVLFdBQVc7QUFDdEMsbUJBQWU7QUFLZixVQUFNLFFBQVEsbUJBQW1CLE1BQU07QUFFdkMsV0FBTyxHQUFHLE1BQU0sU0FBUyxHQUFHLDhDQUE4QztBQUMxRSxVQUFNLFdBQVcsTUFBTSxLQUFLLE9BQUssRUFBRSxPQUFPLFNBQVMsS0FBSyxDQUFDO0FBQ3pELFdBQU8sR0FBRyxDQUFDLENBQUMsVUFBVSw0REFBNEQ7QUFDbEYsV0FBTyxHQUFHLFNBQVUsT0FBTyxTQUFTLDBCQUEwQixHQUFHLG9DQUFvQztBQUdyRyxVQUFNLFdBQVcsTUFBTSxLQUFLLE9BQUssRUFBRSxPQUFPLFNBQVMsS0FBSyxDQUFDO0FBQ3pELFdBQU8sZ0JBQWdCLFVBQVUsUUFBVyw0Q0FBNEM7QUFBQSxFQUMxRixVQUFFO0FBQ0Esa0JBQWM7QUFDZCxlQUFXLE1BQU07QUFBQSxFQUNuQjtBQUNGLENBQUM7QUFNRCxLQUFLLDhHQUEwRixZQUFZO0FBQ3pHLFFBQU0sU0FBUyxXQUFXO0FBQzFCLFFBQU0sU0FBUyxLQUFLLEtBQUssUUFBUSxRQUFRLFFBQVE7QUFDakQsZUFBYSxNQUFNO0FBQ25CLGlCQUFlO0FBRWYsTUFBSTtBQUNGLGlCQUFhLFFBQVEsUUFBUSxDQUFDLEtBQUssQ0FBQztBQUVwQyxvQkFBZ0IsRUFBRSxJQUFJLFFBQVEsT0FBTyxRQUFRLFFBQVEsU0FBUyxDQUFDO0FBQy9ELGdCQUFZLEVBQUUsSUFBSSxPQUFPLGFBQWEsUUFBUSxPQUFPLFNBQVMsUUFBUSxVQUFVLENBQUM7QUFFakYsZUFBVyxFQUFFLElBQUksT0FBTyxTQUFTLE9BQU8sYUFBYSxRQUFRLE9BQU8sY0FBYyxRQUFRLE9BQU8sQ0FBQztBQUNsRyxlQUFXLEVBQUUsSUFBSSxPQUFPLFNBQVMsT0FBTyxhQUFhLFFBQVEsT0FBTyxlQUFlLFFBQVEsT0FBTyxDQUFDO0FBR25HLFVBQU0sY0FBYyxnQkFBZ0IsT0FBTztBQUFBLE1BQ3pDLEVBQUUsSUFBSSxPQUFPLE9BQU8sY0FBYyxNQUFNLE1BQU07QUFBQSxNQUM5QyxFQUFFLElBQUksT0FBTyxPQUFPLGVBQWUsTUFBTSxNQUFNO0FBQUEsSUFDakQsQ0FBQztBQUNELFVBQU0sV0FBVyxLQUFLLEtBQUssUUFBUSxRQUFRLGNBQWMsUUFBUSxVQUFVLE9BQU8sYUFBYTtBQUMvRixPQUFHLGNBQWMsVUFBVSxXQUFXO0FBQ3RDLG1CQUFlO0FBR2YsVUFBTSxjQUFjLG1CQUFtQixNQUFNO0FBQzdDLFdBQU8sR0FBRyxZQUFZLFNBQVMsR0FBRyx5Q0FBeUM7QUFHM0UsVUFBTSxXQUFXLE1BQU0sbUJBQW1CLE1BQU07QUFDaEQsV0FBTyxHQUFHLFdBQVcsR0FBRyxrREFBa0Q7QUFHMUUsbUJBQWU7QUFDZixVQUFNLGFBQWEsbUJBQW1CLE1BQU07QUFDNUMsV0FBTyxnQkFBZ0IsV0FBVyxRQUFRLEdBQUcscURBQXFEO0FBR2xHLFVBQU0sa0JBQWtCLEdBQUcsYUFBYSxVQUFVLE9BQU87QUFDekQsV0FBTyxHQUFHLGdCQUFnQixTQUFTLFlBQVksR0FBRyxvQ0FBb0M7QUFDdEYsV0FBTyxHQUFHLGdCQUFnQixTQUFTLFlBQVksR0FBRyxvQ0FBb0M7QUFBQSxFQUN4RixVQUFFO0FBQ0Esa0JBQWM7QUFDZCxlQUFXLE1BQU07QUFBQSxFQUNuQjtBQUNGLENBQUM7QUFNRCxLQUFLLG1HQUErRSxNQUFNO0FBQ3hGLFFBQU0sU0FBUyxXQUFXO0FBQzFCLFFBQU0sU0FBUyxLQUFLLEtBQUssUUFBUSxRQUFRLFFBQVE7QUFDakQsZUFBYSxNQUFNO0FBQ25CLGlCQUFlO0FBRWYsTUFBSTtBQUNGLGlCQUFhLFFBQVEsUUFBUSxDQUFDLE9BQU8sS0FBSyxDQUFDO0FBRTNDLG9CQUFnQixFQUFFLElBQUksUUFBUSxPQUFPLFFBQVEsUUFBUSxTQUFTLENBQUM7QUFDL0QsZ0JBQVksRUFBRSxJQUFJLE9BQU8sYUFBYSxRQUFRLE9BQU8sUUFBUSxRQUFRLFdBQVcsQ0FBQztBQUNqRixnQkFBWSxFQUFFLElBQUksT0FBTyxhQUFhLFFBQVEsT0FBTyxVQUFVLFFBQVEsVUFBVSxDQUFDO0FBR2xGLFVBQU0saUJBQWlCLG1CQUFtQjtBQUFBLE1BQ3hDLEVBQUUsSUFBSSxPQUFPLE9BQU8sUUFBUSxNQUFNLE1BQU07QUFBQSxNQUN4QyxFQUFFLElBQUksT0FBTyxPQUFPLFVBQVUsTUFBTSxNQUFNO0FBQUEsSUFDNUMsQ0FBQztBQUNELFVBQU0sY0FBYyxLQUFLLEtBQUssUUFBUSxRQUFRLGNBQWMsUUFBUSxpQkFBaUI7QUFDckYsT0FBRyxjQUFjLGFBQWEsY0FBYztBQUM1QyxtQkFBZTtBQUVmLFVBQU0sUUFBUSxtQkFBbUIsTUFBTTtBQUN2QyxVQUFNLFdBQVcsTUFBTSxLQUFLLE9BQUssRUFBRSxPQUFPLFNBQVMsS0FBSyxDQUFDO0FBQ3pELFdBQU8sR0FBRyxDQUFDLENBQUMsVUFBVSxtRUFBbUU7QUFFekYsVUFBTSxXQUFXLE1BQU0sS0FBSyxPQUFLLEVBQUUsT0FBTyxTQUFTLEtBQUssQ0FBQztBQUN6RCxXQUFPLGdCQUFnQixVQUFVLFFBQVcsZ0VBQTJEO0FBQUEsRUFDekcsVUFBRTtBQUNBLGtCQUFjO0FBQ2QsZUFBVyxNQUFNO0FBQUEsRUFDbkI7QUFDRixDQUFDO0FBTUQsS0FBSyw4RkFBMEUsTUFBTTtBQUNuRixRQUFNLFNBQVMsV0FBVztBQUMxQixRQUFNLFNBQVMsS0FBSyxLQUFLLFFBQVEsUUFBUSxRQUFRO0FBQ2pELGVBQWEsTUFBTTtBQUNuQixpQkFBZTtBQUVmLE1BQUk7QUFDRixpQkFBYSxRQUFRLFFBQVEsQ0FBQyxLQUFLLENBQUM7QUFFcEMsb0JBQWdCLEVBQUUsSUFBSSxRQUFRLE9BQU8sUUFBUSxRQUFRLFNBQVMsQ0FBQztBQUMvRCxnQkFBWSxFQUFFLElBQUksT0FBTyxhQUFhLFFBQVEsT0FBTyxTQUFTLFFBQVEsVUFBVSxDQUFDO0FBR2pGLFVBQU0saUJBQWlCLHVCQUF1QixLQUFLO0FBQ25ELGVBQVc7QUFBQSxNQUNULElBQUk7QUFBQSxNQUNKLFNBQVM7QUFBQSxNQUNULGFBQWE7QUFBQSxNQUNiLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLGVBQWU7QUFBQSxJQUNqQixDQUFDO0FBS0QsVUFBTSxjQUFjLGdCQUFnQixPQUFPO0FBQUEsTUFDekMsRUFBRSxJQUFJLE9BQU8sT0FBTyxRQUFRLE1BQU0sS0FBSztBQUFBLElBQ3pDLENBQUM7QUFDRCxVQUFNLFdBQVcsS0FBSyxLQUFLLFFBQVEsUUFBUSxjQUFjLFFBQVEsVUFBVSxPQUFPLGFBQWE7QUFDL0YsT0FBRyxjQUFjLFVBQVUsV0FBVztBQUN0QyxtQkFBZTtBQUVmLFVBQU0sUUFBUSxtQkFBbUIsTUFBTTtBQUN2QyxVQUFNLGVBQWUsTUFBTSxLQUFLLE9BQUssRUFBRSxPQUFPLFNBQVMsb0JBQW9CLENBQUM7QUFDNUUsV0FBTyxHQUFHLENBQUMsQ0FBQyxjQUFjLHNDQUFzQztBQUNoRSxXQUFPLEdBQUcsYUFBYyxPQUFPLFNBQVMsS0FBSyxHQUFHLDJCQUEyQjtBQUFBLEVBQzdFLFVBQUU7QUFDQSxrQkFBYztBQUNkLGVBQVcsTUFBTTtBQUFBLEVBQ25CO0FBQ0YsQ0FBQztBQU1ELEtBQUssK0ZBQTJFLFlBQVk7QUFDMUYsUUFBTSxTQUFTLFdBQVc7QUFDMUIsUUFBTSxTQUFTLEtBQUssS0FBSyxRQUFRLFFBQVEsUUFBUTtBQUNqRCxlQUFhLE1BQU07QUFDbkIsaUJBQWU7QUFFZixNQUFJO0FBQ0YsaUJBQWEsUUFBUSxRQUFRLENBQUMsS0FBSyxDQUFDO0FBRXBDLG9CQUFnQixFQUFFLElBQUksUUFBUSxPQUFPLFFBQVEsUUFBUSxTQUFTLENBQUM7QUFDL0QsZ0JBQVksRUFBRSxJQUFJLE9BQU8sYUFBYSxRQUFRLE9BQU8sU0FBUyxRQUFRLFVBQVUsQ0FBQztBQUVqRixVQUFNLGlCQUFpQix1QkFBdUIsS0FBSztBQUNuRCxlQUFXO0FBQUEsTUFDVCxJQUFJO0FBQUEsTUFDSixTQUFTO0FBQUEsTUFDVCxhQUFhO0FBQUEsTUFDYixPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixlQUFlO0FBQUEsSUFDakIsQ0FBQztBQUdELFVBQU0sY0FBYyxnQkFBZ0IsT0FBTztBQUFBLE1BQ3pDLEVBQUUsSUFBSSxPQUFPLE9BQU8sUUFBUSxNQUFNLEtBQUs7QUFBQSxJQUN6QyxDQUFDO0FBQ0QsVUFBTSxXQUFXLEtBQUssS0FBSyxRQUFRLFFBQVEsY0FBYyxRQUFRLFVBQVUsT0FBTyxhQUFhO0FBQy9GLE9BQUcsY0FBYyxVQUFVLFdBQVc7QUFDdEMsbUJBQWU7QUFHZixVQUFNLFdBQVcsTUFBTSxtQkFBbUIsTUFBTTtBQUNoRCxXQUFPLEdBQUcsV0FBVyxHQUFHLCtCQUErQjtBQUd2RCxVQUFNLGNBQWMsS0FBSztBQUFBLE1BQ3ZCO0FBQUEsTUFBUTtBQUFBLE1BQVE7QUFBQSxNQUFjO0FBQUEsTUFBUTtBQUFBLE1BQVU7QUFBQSxNQUFPO0FBQUEsTUFBUztBQUFBLElBQ2xFO0FBQ0EsV0FBTyxHQUFHLEdBQUcsV0FBVyxXQUFXLEdBQUcsMENBQTBDO0FBR2hGLG1CQUFlO0FBQ2YsVUFBTSxhQUFhLG1CQUFtQixNQUFNO0FBQzVDLFVBQU0sZUFBZSxXQUFXLEtBQUssT0FBSyxFQUFFLE9BQU8sU0FBUyxvQkFBb0IsS0FBSyxFQUFFLE9BQU8sU0FBUyxLQUFLLENBQUM7QUFDN0csV0FBTyxnQkFBZ0IsY0FBYyxRQUFXLDhDQUE4QztBQUFBLEVBQ2hHLFVBQUU7QUFDQSxrQkFBYztBQUNkLGVBQVcsTUFBTTtBQUFBLEVBQ25CO0FBQ0YsQ0FBQztBQU1ELEtBQUssNkdBQW9GLFlBQVk7QUFDbkcsUUFBTSxTQUFTLFdBQVc7QUFDMUIsUUFBTSxTQUFTLEtBQUssS0FBSyxRQUFRLFFBQVEsUUFBUTtBQUNqRCxlQUFhLE1BQU07QUFDbkIsaUJBQWU7QUFFZixNQUFJO0FBQ0YsaUJBQWEsUUFBUSxRQUFRLENBQUMsS0FBSyxDQUFDO0FBRXBDLG9CQUFnQixFQUFFLElBQUksUUFBUSxPQUFPLFFBQVEsUUFBUSxTQUFTLENBQUM7QUFDL0QsZ0JBQVksRUFBRSxJQUFJLE9BQU8sYUFBYSxRQUFRLE9BQU8sU0FBUyxRQUFRLFVBQVUsQ0FBQztBQUNqRixlQUFXLEVBQUUsSUFBSSxPQUFPLFNBQVMsT0FBTyxhQUFhLFFBQVEsT0FBTyxRQUFRLFFBQVEsT0FBTyxDQUFDO0FBRzVGLFVBQU0sY0FBYyxnQkFBZ0IsT0FBTztBQUFBLE1BQ3pDLEVBQUUsSUFBSSxPQUFPLE9BQU8sUUFBUSxNQUFNLEtBQUs7QUFBQSxJQUN6QyxDQUFDO0FBQ0QsVUFBTSxXQUFXLEtBQUssS0FBSyxRQUFRLFFBQVEsY0FBYyxRQUFRLFVBQVUsT0FBTyxhQUFhO0FBQy9GLE9BQUcsY0FBYyxVQUFVLFdBQVc7QUFDdEMsbUJBQWU7QUFHZixVQUFNLFdBQVcsTUFBTSxtQkFBbUIsTUFBTTtBQUNoRCxXQUFPLGdCQUFnQixVQUFVLEdBQUcsNERBQTREO0FBQUEsRUFDbEcsVUFBRTtBQUNBLGtCQUFjO0FBQ2QsZUFBVyxNQUFNO0FBQUEsRUFDbkI7QUFDRixDQUFDO0FBTUQsS0FBSyx1R0FBbUYsTUFBTTtBQUM1RixRQUFNLFNBQVMsV0FBVztBQUMxQixRQUFNLFNBQVMsS0FBSyxLQUFLLFFBQVEsUUFBUSxRQUFRO0FBQ2pELGVBQWEsTUFBTTtBQUNuQixpQkFBZTtBQUVmLE1BQUk7QUFDRixpQkFBYSxRQUFRLFFBQVEsQ0FBQyxLQUFLLENBQUM7QUFFcEMsb0JBQWdCLEVBQUUsSUFBSSxRQUFRLE9BQU8sUUFBUSxRQUFRLFNBQVMsQ0FBQztBQUMvRCxnQkFBWSxFQUFFLElBQUksT0FBTyxhQUFhLFFBQVEsT0FBTyxTQUFTLFFBQVEsVUFBVSxDQUFDO0FBR2pGLFVBQU0sVUFBVSxZQUFZO0FBQzVCLFlBQVE7QUFBQSxNQUNOO0FBQUEsSUFDRixFQUFFLElBQUk7QUFBQSxNQUNKLE9BQU87QUFBQSxNQUNQLE9BQU87QUFBQSxJQUNULENBQUM7QUFFRCxtQkFBZTtBQUVmLFVBQU0sUUFBUSxtQkFBbUIsTUFBTTtBQUN2QyxVQUFNLGVBQWUsTUFBTSxLQUFLLE9BQUssRUFBRSxPQUFPLFNBQVMsb0JBQW9CLEtBQUssRUFBRSxPQUFPLFNBQVMsS0FBSyxDQUFDO0FBQ3hHLFVBQU0sV0FBVyxNQUFNLEtBQUssT0FBSyxFQUFFLE9BQU8sU0FBUyxnQkFBZ0IsS0FBSyxFQUFFLE9BQU8sU0FBUyxLQUFLLENBQUM7QUFFaEcsV0FBTyxHQUFHLENBQUMsQ0FBQyxjQUFjLHNDQUFzQztBQUNoRSxXQUFPLEdBQUcsQ0FBQyxDQUFDLFVBQVUsa0NBQWtDO0FBQUEsRUFDMUQsVUFBRTtBQUNBLGtCQUFjO0FBQ2QsZUFBVyxNQUFNO0FBQUEsRUFDbkI7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
