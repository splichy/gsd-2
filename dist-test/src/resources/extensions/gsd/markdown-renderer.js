import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { logWarning } from "./workflow-logger.js";
import { isClosedStatus } from "./status-guards.js";
import { join, relative } from "node:path";
import { createRequire } from "node:module";
import {
  getAllMilestones,
  getMilestone,
  getMilestoneSlices,
  getSliceTasks,
  getTask,
  getSlice,
  getArtifact,
  insertArtifact,
  getGateResults
} from "./gsd-db.js";
import {
  resolveMilestoneFile,
  resolveSliceFile,
  resolveSlicePath,
  resolveTasksDir,
  gsdRoot,
  buildTaskFileName,
  buildSliceFileName
} from "./paths.js";
import { saveFile, clearParseCache } from "./files.js";
import { invalidateStateCache } from "./state.js";
import { clearPathCache } from "./paths.js";
function toArtifactPath(absPath, basePath) {
  const root = gsdRoot(basePath);
  const rel = relative(root, absPath);
  return rel.replace(/\\/g, "/");
}
function invalidateCaches() {
  invalidateStateCache();
  clearPathCache();
  clearParseCache();
}
function meaningfulSection(value) {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "";
  if (/^(not provided\.?|none\.?|n\/a)$/i.test(trimmed)) return "";
  if (/^\{\{[^}]+\}\}$/.test(trimmed)) return "";
  return trimmed;
}
function pushIndented(lines, value, indent = "  ") {
  for (const line of value.split("\n")) {
    lines.push(`${indent}${line}`);
  }
}
function taskSummaryForSlicePlan(description) {
  const meaningful = meaningfulSection(description);
  if (!meaningful) return "";
  const beforeHeading = meaningful.split(/\n#{1,6}\s+/)[0]?.trim() ?? "";
  const firstBlock = beforeHeading.split(/\n\s*\n/)[0]?.trim() ?? "";
  return firstBlock || beforeHeading;
}
function loadArtifactContent(artifactPath) {
  const artifact = getArtifact(artifactPath);
  if (artifact && artifact.full_content) {
    return artifact.full_content;
  }
  return null;
}
async function writeAndStore(absPath, artifactPath, content, opts) {
  await saveFile(absPath, content);
  try {
    insertArtifact({
      path: artifactPath,
      artifact_type: opts.artifact_type,
      milestone_id: opts.milestone_id,
      slice_id: opts.slice_id ?? null,
      task_id: opts.task_id ?? null,
      full_content: content
    });
  } catch {
    logWarning("renderer", `failed to update artifact in DB: ${artifactPath}`);
  }
  invalidateCaches();
}
function renderRoadmapMarkdown(milestone, slices) {
  const lines = [];
  lines.push(`# ${milestone.id}: ${milestone.title || milestone.id}`);
  lines.push("");
  lines.push(`**Vision:** ${milestone.vision}`);
  lines.push("");
  if (milestone.success_criteria.length > 0) {
    lines.push("## Success Criteria");
    lines.push("");
    for (const criterion of milestone.success_criteria) {
      lines.push(`- ${criterion}`);
    }
    lines.push("");
  }
  lines.push("## Slices");
  lines.push("");
  for (const slice of slices) {
    const done = isClosedStatus(slice.status) ? "x" : " ";
    const depends = `[${(slice.depends ?? []).join(",")}]`;
    const sketchBadge = slice.is_sketch === 1 ? "`[sketch]` " : "";
    lines.push(`- [${done}] **${slice.id}: ${slice.title}** ${sketchBadge}\`risk:${slice.risk}\` \`depends:${depends}\``);
    lines.push(`  > After this: ${slice.demo}`);
    lines.push("");
  }
  if (milestone.boundary_map_markdown.trim()) {
    lines.push("## Boundary Map");
    lines.push("");
    lines.push(milestone.boundary_map_markdown.trim());
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}
`;
}
function renderTaskPlanMarkdown(task, taskGates = []) {
  const description = meaningfulSection(task.description);
  const observabilityImpact = meaningfulSection(task.observability_impact);
  const estimatedSteps = Math.max(1, description.split(/\n+/).filter(Boolean).length || 1);
  const estimatedFiles = task.files.length > 0 ? task.files.length : task.expected_output.length > 0 ? task.expected_output.length : task.inputs.length > 0 ? task.inputs.length : 1;
  const lines = [];
  lines.push("---");
  lines.push(`estimated_steps: ${estimatedSteps}`);
  lines.push(`estimated_files: ${estimatedFiles}`);
  lines.push("skills_used: []");
  lines.push("---");
  lines.push("");
  lines.push(`# ${task.id}: ${task.title || task.id}`);
  lines.push("");
  if (description) {
    lines.push(description);
    lines.push("");
  }
  lines.push("## Inputs");
  lines.push("");
  if (task.inputs.length > 0) {
    for (const input of task.inputs) {
      lines.push(`- \`${input}\``);
    }
  } else {
    lines.push("- None specified.");
  }
  lines.push("");
  lines.push("## Expected Output");
  lines.push("");
  if (task.expected_output.length > 0) {
    for (const output of task.expected_output) {
      lines.push(`- \`${output}\``);
    }
  } else if (task.files.length > 0) {
    for (const file of task.files) {
      lines.push(`- \`${file}\``);
    }
  } else {
    lines.push("- Update the implementation and proof artifacts needed for this task.");
  }
  lines.push("");
  lines.push("## Verification");
  lines.push("");
  lines.push(task.verify.trim() || "- Verify the task outcome with the slice-level checks.");
  lines.push("");
  if (observabilityImpact) {
    lines.push("## Observability Impact");
    lines.push("");
    lines.push(observabilityImpact);
    lines.push("");
  }
  const gateLabels = { Q5: "Failure Modes", Q6: "Load Profile", Q7: "Negative Tests" };
  for (const [gid, label] of Object.entries(gateLabels)) {
    const gate = taskGates.find((g) => g.gate_id === gid && g.status === "complete");
    if (gate && gate.verdict !== "omitted") {
      lines.push(`## ${label}`);
      lines.push("");
      lines.push(gate.findings.trim() || `- **Verdict:** ${gate.verdict}
- **Rationale:** ${gate.rationale}`);
      lines.push("");
    }
  }
  return `${lines.join("\n").trimEnd()}
`;
}
function renderSlicePlanMarkdown(slice, tasks, gates = []) {
  const lines = [];
  lines.push(`# ${slice.id}: ${slice.title || slice.id}`);
  lines.push("");
  lines.push(`**Goal:** ${slice.goal}`);
  lines.push(`**Demo:** ${slice.demo}`);
  lines.push("");
  lines.push("## Must-Haves");
  lines.push("");
  const successCriteria = meaningfulSection(slice.success_criteria);
  if (successCriteria) {
    for (const line of successCriteria.split(/\n+/).map((entry) => entry.trim()).filter(Boolean)) {
      lines.push(line.startsWith("-") ? line : `- ${line}`);
    }
  } else {
    lines.push("- Complete the planned slice outcomes.");
  }
  lines.push("");
  const q3 = gates.find((g) => g.gate_id === "Q3" && g.status === "complete");
  if (q3 && q3.verdict !== "omitted") {
    lines.push("## Threat Surface");
    lines.push("");
    lines.push(q3.findings.trim() || `- **Verdict:** ${q3.verdict}
- **Rationale:** ${q3.rationale}`);
    lines.push("");
  }
  const q4 = gates.find((g) => g.gate_id === "Q4" && g.status === "complete");
  if (q4 && q4.verdict !== "omitted") {
    lines.push("## Requirement Impact");
    lines.push("");
    lines.push(q4.findings.trim() || `- **Verdict:** ${q4.verdict}
- **Rationale:** ${q4.rationale}`);
    lines.push("");
  }
  const proofLevel = meaningfulSection(slice.proof_level);
  if (proofLevel) {
    lines.push("## Proof Level");
    lines.push("");
    lines.push(`- This slice proves: ${proofLevel}`);
    lines.push("");
  }
  const integrationClosure = meaningfulSection(slice.integration_closure);
  if (integrationClosure) {
    lines.push("## Integration Closure");
    lines.push("");
    lines.push(integrationClosure);
    lines.push("");
  }
  lines.push("## Verification");
  lines.push("");
  const verification = meaningfulSection(slice.observability_impact);
  if (verification) {
    const verificationLines = verification.split(/\n+/).map((entry) => entry.trim()).filter(Boolean);
    for (const line of verificationLines) {
      lines.push(line.startsWith("-") ? line : `- ${line}`);
    }
  } else {
    lines.push("- Run the task and slice verification checks for this slice.");
  }
  lines.push("");
  lines.push("## Tasks");
  lines.push("");
  for (const task of tasks) {
    const done = isClosedStatus(task.status) ? "x" : " ";
    const estimate = task.estimate.trim() ? ` \`est:${task.estimate.trim()}\`` : "";
    lines.push(`- [${done}] **${task.id}: ${task.title || task.id}**${estimate}`);
    const summary = taskSummaryForSlicePlan(task.description);
    if (summary) {
      pushIndented(lines, summary);
    }
    if (task.files.length > 0) {
      lines.push(`  - Files: ${task.files.map((file) => `\`${file}\``).join(", ")}`);
    }
    if (task.verify.trim()) {
      lines.push(`  - Verify: ${task.verify.trim()}`);
    }
    lines.push("");
  }
  const filesLikelyTouched = Array.from(new Set(tasks.flatMap((task) => task.files)));
  if (filesLikelyTouched.length > 0) {
    lines.push("## Files Likely Touched");
    lines.push("");
    for (const file of filesLikelyTouched) {
      lines.push(`- ${file}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}
`;
}
async function renderPlanFromDb(basePath, milestoneId, sliceId) {
  const slice = getSlice(milestoneId, sliceId);
  if (!slice) {
    throw new Error(`slice ${milestoneId}/${sliceId} not found`);
  }
  const tasks = getSliceTasks(milestoneId, sliceId);
  if (tasks.length === 0) {
    throw new Error(`no tasks found for ${milestoneId}/${sliceId}`);
  }
  const slicePath = resolveSlicePath(basePath, milestoneId, sliceId) ?? join(gsdRoot(basePath), "milestones", milestoneId, "slices", sliceId);
  const absPath = resolveSliceFile(basePath, milestoneId, sliceId, "PLAN") ?? join(slicePath, `${sliceId}-PLAN.md`);
  const artifactPath = toArtifactPath(absPath, basePath);
  const sliceGates = getGateResults(milestoneId, sliceId, "slice");
  const content = renderSlicePlanMarkdown(slice, tasks, sliceGates);
  await writeAndStore(absPath, artifactPath, content, {
    artifact_type: "PLAN",
    milestone_id: milestoneId,
    slice_id: sliceId
  });
  const taskPlanPaths = [];
  for (const task of tasks) {
    const rendered = await renderTaskPlanFromDb(basePath, milestoneId, sliceId, task.id);
    taskPlanPaths.push(rendered.taskPlanPath);
  }
  return { planPath: absPath, taskPlanPaths, content };
}
async function renderTaskPlanFromDb(basePath, milestoneId, sliceId, taskId) {
  const task = getTask(milestoneId, sliceId, taskId);
  if (!task) {
    throw new Error(`task ${milestoneId}/${sliceId}/${taskId} not found`);
  }
  const tasksDir = resolveTasksDir(basePath, milestoneId, sliceId) ?? join(gsdRoot(basePath), "milestones", milestoneId, "slices", sliceId, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  const absPath = join(tasksDir, buildTaskFileName(taskId, "PLAN"));
  const artifactPath = toArtifactPath(absPath, basePath);
  const taskGates = getGateResults(milestoneId, sliceId, "task").filter((g) => g.task_id === taskId);
  const content = task.full_plan_md.trim() ? task.full_plan_md : renderTaskPlanMarkdown(task, taskGates);
  await writeAndStore(absPath, artifactPath, content, {
    artifact_type: "PLAN",
    milestone_id: milestoneId,
    slice_id: sliceId,
    task_id: taskId
  });
  return { taskPlanPath: absPath, content };
}
async function renderRoadmapFromDb(basePath, milestoneId) {
  const milestone = getMilestone(milestoneId);
  if (!milestone) {
    throw new Error(`milestone ${milestoneId} not found`);
  }
  const slices = getMilestoneSlices(milestoneId);
  const absPath = resolveMilestoneFile(basePath, milestoneId, "ROADMAP") ?? join(gsdRoot(basePath), "milestones", milestoneId, `${milestoneId}-ROADMAP.md`);
  const artifactPath = toArtifactPath(absPath, basePath);
  const content = renderRoadmapMarkdown(milestone, slices);
  await writeAndStore(absPath, artifactPath, content, {
    artifact_type: "ROADMAP",
    milestone_id: milestoneId
  });
  return { roadmapPath: absPath, content };
}
async function renderRoadmapCheckboxes(basePath, milestoneId) {
  const slices = getMilestoneSlices(milestoneId);
  if (slices.length === 0) {
    process.stderr.write(
      `markdown-renderer: no slices found for milestone ${milestoneId}
`
    );
    return false;
  }
  const absPath = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
  const artifactPath = absPath ? toArtifactPath(absPath, basePath) : null;
  let content = null;
  if (artifactPath) {
    content = loadArtifactContent(artifactPath);
  }
  if (!content) {
    await renderRoadmapFromDb(basePath, milestoneId);
    return true;
  }
  let updated = content;
  for (const slice of slices) {
    const isDone = isClosedStatus(slice.status);
    const sid = slice.id;
    if (isDone) {
      updated = updated.replace(
        new RegExp(`^(\\s*-\\s+)\\[ \\]\\s+\\*\\*${sid}:`, "m"),
        `$1[x] **${sid}:`
      );
    } else {
      updated = updated.replace(
        new RegExp(`^(\\s*-\\s+)\\[x\\]\\s+\\*\\*${sid}:`, "mi"),
        `$1[ ] **${sid}:`
      );
    }
  }
  if (!absPath) return false;
  await writeAndStore(absPath, artifactPath, updated, {
    artifact_type: "ROADMAP",
    milestone_id: milestoneId
  });
  return true;
}
async function renderPlanCheckboxes(basePath, milestoneId, sliceId) {
  const tasks = getSliceTasks(milestoneId, sliceId);
  if (tasks.length === 0) {
    process.stderr.write(
      `markdown-renderer: no tasks found for ${milestoneId}/${sliceId}
`
    );
    return false;
  }
  const absPath = resolveSliceFile(basePath, milestoneId, sliceId, "PLAN");
  const artifactPath = absPath ? toArtifactPath(absPath, basePath) : null;
  let content = null;
  if (artifactPath) {
    content = loadArtifactContent(artifactPath);
  }
  if (!content) {
    await renderPlanFromDb(basePath, milestoneId, sliceId);
    return true;
  }
  let updated = content;
  for (const task of tasks) {
    const isDone = isClosedStatus(task.status);
    const tid = task.id;
    if (isDone) {
      updated = updated.replace(
        new RegExp(`^(\\s*-\\s+)\\[ \\]\\s+\\*\\*${tid}:`, "m"),
        `$1[x] **${tid}:`
      );
    } else {
      updated = updated.replace(
        new RegExp(`^(\\s*-\\s+)\\[x\\]\\s+\\*\\*${tid}:`, "mi"),
        `$1[ ] **${tid}:`
      );
    }
  }
  if (!absPath) return false;
  await writeAndStore(absPath, artifactPath, updated, {
    artifact_type: "PLAN",
    milestone_id: milestoneId,
    slice_id: sliceId
  });
  return true;
}
async function renderTaskSummary(basePath, milestoneId, sliceId, taskId) {
  const task = getTask(milestoneId, sliceId, taskId);
  if (!task || !task.full_summary_md) {
    return false;
  }
  const slicePath = resolveSlicePath(basePath, milestoneId, sliceId);
  if (!slicePath) {
    process.stderr.write(
      `markdown-renderer: cannot resolve slice path for ${milestoneId}/${sliceId}
`
    );
    return false;
  }
  const tasksDir = join(slicePath, "tasks");
  const fileName = buildTaskFileName(taskId, "SUMMARY");
  const absPath = join(tasksDir, fileName);
  const artifactPath = toArtifactPath(absPath, basePath);
  await writeAndStore(absPath, artifactPath, task.full_summary_md, {
    artifact_type: "SUMMARY",
    milestone_id: milestoneId,
    slice_id: sliceId,
    task_id: taskId
  });
  return true;
}
async function renderSliceSummary(basePath, milestoneId, sliceId) {
  const slice = getSlice(milestoneId, sliceId);
  if (!slice) {
    return false;
  }
  const slicePath = resolveSlicePath(basePath, milestoneId, sliceId);
  if (!slicePath) {
    process.stderr.write(
      `markdown-renderer: cannot resolve slice path for ${milestoneId}/${sliceId}
`
    );
    return false;
  }
  let wrote = false;
  if (slice.full_summary_md) {
    const summaryName = buildSliceFileName(sliceId, "SUMMARY");
    const summaryAbs = join(slicePath, summaryName);
    const summaryArtifact = toArtifactPath(summaryAbs, basePath);
    await writeAndStore(summaryAbs, summaryArtifact, slice.full_summary_md, {
      artifact_type: "SUMMARY",
      milestone_id: milestoneId,
      slice_id: sliceId
    });
    wrote = true;
  }
  if (slice.full_uat_md) {
    const uatName = buildSliceFileName(sliceId, "UAT");
    const uatAbs = join(slicePath, uatName);
    const uatArtifact = toArtifactPath(uatAbs, basePath);
    await writeAndStore(uatAbs, uatArtifact, slice.full_uat_md, {
      artifact_type: "UAT",
      milestone_id: milestoneId,
      slice_id: sliceId
    });
    wrote = true;
  }
  return wrote;
}
async function renderAllFromDb(basePath) {
  const result = { rendered: 0, skipped: 0, errors: [] };
  const milestones = getAllMilestones();
  for (const milestone of milestones) {
    try {
      const ok = await renderRoadmapCheckboxes(basePath, milestone.id);
      if (ok) result.rendered++;
      else result.skipped++;
    } catch (err) {
      result.errors.push(`roadmap ${milestone.id}: ${err.message}`);
    }
    const slices = getMilestoneSlices(milestone.id);
    for (const slice of slices) {
      try {
        const ok = await renderPlanCheckboxes(basePath, milestone.id, slice.id);
        if (ok) result.rendered++;
        else result.skipped++;
      } catch (err) {
        result.errors.push(
          `plan ${milestone.id}/${slice.id}: ${err.message}`
        );
      }
      try {
        const ok = await renderSliceSummary(basePath, milestone.id, slice.id);
        if (ok) result.rendered++;
        else result.skipped++;
      } catch (err) {
        result.errors.push(
          `slice summary ${milestone.id}/${slice.id}: ${err.message}`
        );
      }
      const tasks = getSliceTasks(milestone.id, slice.id);
      for (const task of tasks) {
        try {
          const ok = await renderTaskSummary(
            basePath,
            milestone.id,
            slice.id,
            task.id
          );
          if (ok) result.rendered++;
          else result.skipped++;
        } catch (err) {
          result.errors.push(
            `task summary ${milestone.id}/${slice.id}/${task.id}: ${err.message}`
          );
        }
      }
    }
  }
  return result;
}
function detectStaleRenders(basePath) {
  const _require = createRequire(import.meta.url);
  let parseRoadmap, parsePlan;
  try {
    const m = _require("./parsers-legacy.ts");
    parseRoadmap = m.parseRoadmap;
    parsePlan = m.parsePlan;
  } catch (e) {
    logWarning("renderer", `parsers-legacy.ts require failed, falling back to .js: ${e.message}`);
    const m = _require("./parsers-legacy.js");
    parseRoadmap = m.parseRoadmap;
    parsePlan = m.parsePlan;
  }
  const stale = [];
  const milestones = getAllMilestones();
  for (const milestone of milestones) {
    const slices = getMilestoneSlices(milestone.id);
    const roadmapPath = resolveMilestoneFile(basePath, milestone.id, "ROADMAP");
    if (roadmapPath && existsSync(roadmapPath)) {
      try {
        const content = readFileSync(roadmapPath, "utf-8");
        const parsed = parseRoadmap(content);
        for (const slice of slices) {
          const isCompleteInDb = isClosedStatus(slice.status);
          const roadmapSlice = parsed.slices.find((s) => s.id === slice.id);
          if (!roadmapSlice) continue;
          if (isCompleteInDb && !roadmapSlice.done) {
            stale.push({
              path: roadmapPath,
              reason: `${slice.id} is closed in DB but unchecked in roadmap`
            });
          } else if (!isCompleteInDb && roadmapSlice.done) {
            stale.push({
              path: roadmapPath,
              reason: `${slice.id} is not closed in DB but checked in roadmap`
            });
          }
        }
      } catch (e) {
        logWarning("renderer", `roadmap parse failed: ${e.message}`);
      }
    }
    for (const slice of slices) {
      const tasks = getSliceTasks(milestone.id, slice.id);
      const planPath = resolveSliceFile(basePath, milestone.id, slice.id, "PLAN");
      if (planPath && existsSync(planPath)) {
        try {
          const content = readFileSync(planPath, "utf-8");
          const parsed = parsePlan(content);
          for (const task of tasks) {
            const isDoneInDb = isClosedStatus(task.status);
            const planTask = parsed.tasks.find((t) => t.id === task.id);
            if (!planTask) continue;
            if (isDoneInDb && !planTask.done) {
              stale.push({
                path: planPath,
                reason: `${task.id} is done in DB but unchecked in plan`
              });
            } else if (!isDoneInDb && planTask.done) {
              stale.push({
                path: planPath,
                reason: `${task.id} is not done in DB but checked in plan`
              });
            }
          }
        } catch (e) {
          logWarning("renderer", `plan parse failed: ${e.message}`);
        }
      }
      for (const task of tasks) {
        if (isClosedStatus(task.status) && task.full_summary_md) {
          const slicePath = resolveSlicePath(basePath, milestone.id, slice.id);
          if (slicePath) {
            const tasksDir = join(slicePath, "tasks");
            const fileName = buildTaskFileName(task.id, "SUMMARY");
            const summaryAbsPath = join(tasksDir, fileName);
            if (!existsSync(summaryAbsPath)) {
              stale.push({
                path: summaryAbsPath,
                reason: `${task.id} is complete with summary in DB but SUMMARY.md missing on disk`
              });
            }
          }
        }
      }
      const sliceRow = getSlice(milestone.id, slice.id);
      if (sliceRow && sliceRow.status === "complete") {
        const slicePath = resolveSlicePath(basePath, milestone.id, slice.id);
        if (slicePath) {
          if (sliceRow.full_summary_md) {
            const summaryName = buildSliceFileName(slice.id, "SUMMARY");
            const summaryAbsPath = join(slicePath, summaryName);
            if (!existsSync(summaryAbsPath)) {
              stale.push({
                path: summaryAbsPath,
                reason: `${slice.id} is complete with summary in DB but SUMMARY.md missing on disk`
              });
            }
          }
          if (sliceRow.full_uat_md) {
            const uatName = buildSliceFileName(slice.id, "UAT");
            const uatAbsPath = join(slicePath, uatName);
            if (!existsSync(uatAbsPath)) {
              stale.push({
                path: uatAbsPath,
                reason: `${slice.id} is complete with UAT in DB but UAT.md missing on disk`
              });
            }
          }
        }
      }
    }
  }
  if (stale.length > 0) {
    process.stderr.write(
      `markdown-renderer: detected ${stale.length} stale render(s):
`
    );
    for (const entry of stale) {
      process.stderr.write(`  - ${entry.path}: ${entry.reason}
`);
    }
  }
  return stale;
}
async function renderReplanFromDb(basePath, milestoneId, sliceId, replanData) {
  const slicePath = resolveSlicePath(basePath, milestoneId, sliceId) ?? join(gsdRoot(basePath), "milestones", milestoneId, "slices", sliceId);
  const absPath = join(slicePath, `${sliceId}-REPLAN.md`);
  const artifactPath = toArtifactPath(absPath, basePath);
  const lines = [];
  lines.push(`# ${sliceId} Replan`);
  lines.push("");
  lines.push(`**Milestone:** ${milestoneId}`);
  lines.push(`**Slice:** ${sliceId}`);
  lines.push(`**Blocker Task:** ${replanData.blockerTaskId}`);
  lines.push(`**Created:** ${(/* @__PURE__ */ new Date()).toISOString()}`);
  lines.push("");
  lines.push("## Blocker Description");
  lines.push("");
  lines.push(replanData.blockerDescription);
  lines.push("");
  lines.push("## What Changed");
  lines.push("");
  lines.push(replanData.whatChanged);
  lines.push("");
  const content = `${lines.join("\n").trimEnd()}
`;
  await writeAndStore(absPath, artifactPath, content, {
    artifact_type: "REPLAN",
    milestone_id: milestoneId,
    slice_id: sliceId
  });
  return { replanPath: absPath, content };
}
async function renderAssessmentFromDb(basePath, milestoneId, sliceId, assessmentData) {
  const slicePath = resolveSlicePath(basePath, milestoneId, sliceId) ?? join(gsdRoot(basePath), "milestones", milestoneId, "slices", sliceId);
  const absPath = join(slicePath, `${sliceId}-ASSESSMENT.md`);
  const artifactPath = toArtifactPath(absPath, basePath);
  const lines = [];
  lines.push(`# ${sliceId} Assessment`);
  lines.push("");
  lines.push(`**Milestone:** ${milestoneId}`);
  lines.push(`**Slice:** ${sliceId}`);
  if (assessmentData.completedSliceId) {
    lines.push(`**Completed Slice:** ${assessmentData.completedSliceId}`);
  }
  lines.push(`**Verdict:** ${assessmentData.verdict}`);
  lines.push(`**Created:** ${(/* @__PURE__ */ new Date()).toISOString()}`);
  lines.push("");
  lines.push("## Assessment");
  lines.push("");
  lines.push(assessmentData.assessment);
  lines.push("");
  const content = `${lines.join("\n").trimEnd()}
`;
  await writeAndStore(absPath, artifactPath, content, {
    artifact_type: "ASSESSMENT",
    milestone_id: milestoneId,
    slice_id: sliceId
  });
  return { assessmentPath: absPath, content };
}
export {
  detectStaleRenders,
  renderAllFromDb,
  renderAssessmentFromDb,
  renderPlanCheckboxes,
  renderPlanFromDb,
  renderReplanFromDb,
  renderRoadmapCheckboxes,
  renderRoadmapFromDb,
  renderSliceSummary,
  renderTaskPlanFromDb,
  renderTaskSummary
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9tYXJrZG93bi1yZW5kZXJlci50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IE1hcmtkb3duIHByb2plY3Rpb24gcmVuZGVyZXIgZm9yIEdTRCB3b3JrZmxvdyBkYXRhYmFzZSByb3dzLlxuLy8gR1NEIE1hcmtkb3duIFJlbmRlcmVyIFx1MjAxNCBEQiBcdTIxOTIgTWFya2Rvd24gZmlsZSBnZW5lcmF0aW9uXG4vL1xuLy8gVHJhbnNmb3JtcyBEQiBzdGF0ZSBpbnRvIGNvcnJlY3QgbWFya2Rvd24gZmlsZXMgb24gZGlzay5cbi8vIEVhY2ggcmVuZGVyIGZ1bmN0aW9uIHJlYWRzIGZyb20gREIsIHdyaXRlcyBhIG1hcmtkb3duIHByb2plY3Rpb24gdG8gZGlzayxcbi8vIHN0b3JlcyBnZW5lcmF0ZWQgY29udGVudCBpbiB0aGUgYXJ0aWZhY3RzIHRhYmxlLCBhbmQgaW52YWxpZGF0ZXMgY2FjaGVzLlxuLy9cbi8vIENyaXRpY2FsIGludmFyaWFudDogcmVuZGVyZWQgbWFya2Rvd24gbXVzdCByb3VuZC10cmlwIHRocm91Z2hcbi8vIHBhcnNlUm9hZG1hcCgpLCBwYXJzZVBsYW4oKSwgcGFyc2VTdW1tYXJ5KCkgaW4gZmlsZXMudHMuXG5cbmltcG9ydCB7IHJlYWRGaWxlU3luYywgZXhpc3RzU3luYywgbWtkaXJTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGxvZ1dhcm5pbmcgfSBmcm9tIFwiLi93b3JrZmxvdy1sb2dnZXIuanNcIjtcbmltcG9ydCB7IGlzQ2xvc2VkU3RhdHVzIH0gZnJvbSBcIi4vc3RhdHVzLWd1YXJkcy5qc1wiO1xuaW1wb3J0IHsgam9pbiwgcmVsYXRpdmUgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBjcmVhdGVSZXF1aXJlIH0gZnJvbSBcIm5vZGU6bW9kdWxlXCI7XG5pbXBvcnQge1xuICBnZXRBbGxNaWxlc3RvbmVzLFxuICBnZXRNaWxlc3RvbmUsXG4gIGdldE1pbGVzdG9uZVNsaWNlcyxcbiAgZ2V0U2xpY2VUYXNrcyxcbiAgZ2V0VGFzayxcbiAgZ2V0U2xpY2UsXG4gIGdldEFydGlmYWN0LFxuICBpbnNlcnRBcnRpZmFjdCxcbiAgZ2V0R2F0ZVJlc3VsdHMsXG59IGZyb20gXCIuL2dzZC1kYi5qc1wiO1xuaW1wb3J0IHR5cGUgeyBNaWxlc3RvbmVSb3csIEFydGlmYWN0Um93IH0gZnJvbSBcIi4vZGItbWlsZXN0b25lLWFydGlmYWN0LXJvd3MuanNcIjtcbmltcG9ydCB0eXBlIHsgU2xpY2VSb3csIFRhc2tSb3cgfSBmcm9tIFwiLi9kYi10YXNrLXNsaWNlLXJvd3MuanNcIjtcbmltcG9ydCB0eXBlIHsgR2F0ZVJvdyB9IGZyb20gXCIuL3R5cGVzLmpzXCI7XG5pbXBvcnQge1xuICByZXNvbHZlTWlsZXN0b25lRmlsZSxcbiAgcmVzb2x2ZVNsaWNlRmlsZSxcbiAgcmVzb2x2ZVNsaWNlUGF0aCxcbiAgcmVzb2x2ZVRhc2tzRGlyLFxuICBnc2RSb290LFxuICBidWlsZFRhc2tGaWxlTmFtZSxcbiAgYnVpbGRTbGljZUZpbGVOYW1lLFxufSBmcm9tIFwiLi9wYXRocy5qc1wiO1xuaW1wb3J0IHsgc2F2ZUZpbGUsIGNsZWFyUGFyc2VDYWNoZSB9IGZyb20gXCIuL2ZpbGVzLmpzXCI7XG5pbXBvcnQgeyBpbnZhbGlkYXRlU3RhdGVDYWNoZSB9IGZyb20gXCIuL3N0YXRlLmpzXCI7XG5pbXBvcnQgeyBjbGVhclBhdGhDYWNoZSB9IGZyb20gXCIuL3BhdGhzLmpzXCI7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBIZWxwZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIENvbnZlcnQgYW4gYWJzb2x1dGUgZmlsZSBwYXRoIHRvIGEgLmdzZC1yZWxhdGl2ZSBhcnRpZmFjdCBwYXRoLlxuICogRS5nLiBcIi9wcm9qZWN0Ly5nc2QvbWlsZXN0b25lcy9NMDAxL00wMDEtUk9BRE1BUC5tZFwiIFx1MjE5MiBcIm1pbGVzdG9uZXMvTTAwMS9NMDAxLVJPQURNQVAubWRcIlxuICovXG5mdW5jdGlvbiB0b0FydGlmYWN0UGF0aChhYnNQYXRoOiBzdHJpbmcsIGJhc2VQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCByb290ID0gZ3NkUm9vdChiYXNlUGF0aCk7XG4gIGNvbnN0IHJlbCA9IHJlbGF0aXZlKHJvb3QsIGFic1BhdGgpO1xuICAvLyBOb3JtYWxpemUgdG8gZm9yd2FyZCBzbGFzaGVzIGZvciBjb25zaXN0ZW50IERCIGtleXNcbiAgcmV0dXJuIHJlbC5yZXBsYWNlKC9cXFxcL2csIFwiL1wiKTtcbn1cblxuLyoqXG4gKiBJbnZhbGlkYXRlIGFsbCBjYWNoZXMgYWZ0ZXIgYSBkaXNrIHdyaXRlLlxuICovXG5mdW5jdGlvbiBpbnZhbGlkYXRlQ2FjaGVzKCk6IHZvaWQge1xuICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICBjbGVhclBhdGhDYWNoZSgpO1xuICBjbGVhclBhcnNlQ2FjaGUoKTtcbn1cblxuZnVuY3Rpb24gbWVhbmluZ2Z1bFNlY3Rpb24odmFsdWU6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQpOiBzdHJpbmcge1xuICBjb25zdCB0cmltbWVkID0gKHZhbHVlID8/IFwiXCIpLnRyaW0oKTtcbiAgaWYgKCF0cmltbWVkKSByZXR1cm4gXCJcIjtcbiAgaWYgKC9eKG5vdCBwcm92aWRlZFxcLj98bm9uZVxcLj98blxcL2EpJC9pLnRlc3QodHJpbW1lZCkpIHJldHVybiBcIlwiO1xuICBpZiAoL15cXHtcXHtbXn1dK1xcfVxcfSQvLnRlc3QodHJpbW1lZCkpIHJldHVybiBcIlwiO1xuICByZXR1cm4gdHJpbW1lZDtcbn1cblxuZnVuY3Rpb24gcHVzaEluZGVudGVkKGxpbmVzOiBzdHJpbmdbXSwgdmFsdWU6IHN0cmluZywgaW5kZW50ID0gXCIgIFwiKTogdm9pZCB7XG4gIGZvciAoY29uc3QgbGluZSBvZiB2YWx1ZS5zcGxpdChcIlxcblwiKSkge1xuICAgIGxpbmVzLnB1c2goYCR7aW5kZW50fSR7bGluZX1gKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB0YXNrU3VtbWFyeUZvclNsaWNlUGxhbihkZXNjcmlwdGlvbjogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgbWVhbmluZ2Z1bCA9IG1lYW5pbmdmdWxTZWN0aW9uKGRlc2NyaXB0aW9uKTtcbiAgaWYgKCFtZWFuaW5nZnVsKSByZXR1cm4gXCJcIjtcblxuICBjb25zdCBiZWZvcmVIZWFkaW5nID0gbWVhbmluZ2Z1bC5zcGxpdCgvXFxuI3sxLDZ9XFxzKy8pWzBdPy50cmltKCkgPz8gXCJcIjtcbiAgY29uc3QgZmlyc3RCbG9jayA9IGJlZm9yZUhlYWRpbmcuc3BsaXQoL1xcblxccypcXG4vKVswXT8udHJpbSgpID8/IFwiXCI7XG4gIHJldHVybiBmaXJzdEJsb2NrIHx8IGJlZm9yZUhlYWRpbmc7XG59XG5cbi8qKlxuICogTG9hZCBhcnRpZmFjdCBjb250ZW50IGZyb20gdGhlIERCLiBNYXJrZG93biBwcm9qZWN0aW9ucyBhcmUgbm90IGF1dGhvcml0YXRpdmVcbiAqIGR1cmluZyBydW50aW1lOyB3aGVuIHRoZSBhcnRpZmFjdCByb3cgaXMgbWlzc2luZywgY2FsbGVycyByZWdlbmVyYXRlIGZyb20gREJcbiAqIHJvd3MgaW5zdGVhZCBvZiBwYXRjaGluZyBkaXNrIGZhbGxiYWNrIGNvbnRlbnQgYW5kIHN0b3JpbmcgaXQgYmFjay5cbiAqL1xuZnVuY3Rpb24gbG9hZEFydGlmYWN0Q29udGVudChcbiAgYXJ0aWZhY3RQYXRoOiBzdHJpbmcsXG4pOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3QgYXJ0aWZhY3QgPSBnZXRBcnRpZmFjdChhcnRpZmFjdFBhdGgpO1xuICBpZiAoYXJ0aWZhY3QgJiYgYXJ0aWZhY3QuZnVsbF9jb250ZW50KSB7XG4gICAgcmV0dXJuIGFydGlmYWN0LmZ1bGxfY29udGVudDtcbiAgfVxuXG4gIHJldHVybiBudWxsO1xufVxuXG4vKipcbiAqIFdyaXRlIHJlbmRlcmVkIGNvbnRlbnQgdG8gZGlzayBhbmQgdXBkYXRlIHRoZSBhcnRpZmFjdHMgdGFibGUuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHdyaXRlQW5kU3RvcmUoXG4gIGFic1BhdGg6IHN0cmluZyxcbiAgYXJ0aWZhY3RQYXRoOiBzdHJpbmcsXG4gIGNvbnRlbnQ6IHN0cmluZyxcbiAgb3B0czoge1xuICAgIGFydGlmYWN0X3R5cGU6IHN0cmluZztcbiAgICBtaWxlc3RvbmVfaWQ6IHN0cmluZztcbiAgICBzbGljZV9pZD86IHN0cmluZztcbiAgICB0YXNrX2lkPzogc3RyaW5nO1xuICB9LFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGF3YWl0IHNhdmVGaWxlKGFic1BhdGgsIGNvbnRlbnQpO1xuXG4gIHRyeSB7XG4gICAgaW5zZXJ0QXJ0aWZhY3Qoe1xuICAgICAgcGF0aDogYXJ0aWZhY3RQYXRoLFxuICAgICAgYXJ0aWZhY3RfdHlwZTogb3B0cy5hcnRpZmFjdF90eXBlLFxuICAgICAgbWlsZXN0b25lX2lkOiBvcHRzLm1pbGVzdG9uZV9pZCxcbiAgICAgIHNsaWNlX2lkOiBvcHRzLnNsaWNlX2lkID8/IG51bGwsXG4gICAgICB0YXNrX2lkOiBvcHRzLnRhc2tfaWQgPz8gbnVsbCxcbiAgICAgIGZ1bGxfY29udGVudDogY29udGVudCxcbiAgICB9KTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gTm9uLWZhdGFsOiBmaWxlIGlzIG9uIGRpc2ssIERCIGlzIGJlc3QtZWZmb3J0XG4gICAgbG9nV2FybmluZyhcInJlbmRlcmVyXCIsIGBmYWlsZWQgdG8gdXBkYXRlIGFydGlmYWN0IGluIERCOiAke2FydGlmYWN0UGF0aH1gKTtcbiAgfVxuXG4gIGludmFsaWRhdGVDYWNoZXMoKTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyUm9hZG1hcE1hcmtkb3duKG1pbGVzdG9uZTogTWlsZXN0b25lUm93LCBzbGljZXM6IFNsaWNlUm93W10pOiBzdHJpbmcge1xuICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcblxuICBsaW5lcy5wdXNoKGAjICR7bWlsZXN0b25lLmlkfTogJHttaWxlc3RvbmUudGl0bGUgfHwgbWlsZXN0b25lLmlkfWApO1xuICBsaW5lcy5wdXNoKFwiXCIpO1xuICBsaW5lcy5wdXNoKGAqKlZpc2lvbjoqKiAke21pbGVzdG9uZS52aXNpb259YCk7XG4gIGxpbmVzLnB1c2goXCJcIik7XG5cbiAgaWYgKG1pbGVzdG9uZS5zdWNjZXNzX2NyaXRlcmlhLmxlbmd0aCA+IDApIHtcbiAgICBsaW5lcy5wdXNoKFwiIyMgU3VjY2VzcyBDcml0ZXJpYVwiKTtcbiAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICAgIGZvciAoY29uc3QgY3JpdGVyaW9uIG9mIG1pbGVzdG9uZS5zdWNjZXNzX2NyaXRlcmlhKSB7XG4gICAgICBsaW5lcy5wdXNoKGAtICR7Y3JpdGVyaW9ufWApO1xuICAgIH1cbiAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICB9XG5cbiAgbGluZXMucHVzaChcIiMjIFNsaWNlc1wiKTtcbiAgbGluZXMucHVzaChcIlwiKTtcbiAgZm9yIChjb25zdCBzbGljZSBvZiBzbGljZXMpIHtcbiAgICBjb25zdCBkb25lID0gaXNDbG9zZWRTdGF0dXMoc2xpY2Uuc3RhdHVzKSA/IFwieFwiIDogXCIgXCI7XG4gICAgY29uc3QgZGVwZW5kcyA9IGBbJHsoc2xpY2UuZGVwZW5kcyA/PyBbXSkuam9pbihcIixcIil9XWA7XG4gICAgLy8gQURSLTAxMTogc2tldGNoIHNsaWNlcyBnZXQgYSBgW3NrZXRjaF1gIGJhZGdlIHNvIHRoZSByb2FkbWFwIHNob3dzIGF0IGFcbiAgICAvLyBnbGFuY2Ugd2hpY2ggc2xpY2VzIGFyZSBzdGlsbCBwZW5kaW5nIHJlZmluZS1zbGljZSBleHBhbnNpb24uIFRoZSBiYWRnZVxuICAgIC8vIHNpdHMgaW4gZnJvbnQgb2YgYHJpc2s6YCBzbyBpdCdzIHZpc2libGUgaW4gbmFycm93IHRlcm1pbmFscyB0aGF0IG1heVxuICAgIC8vIHRydW5jYXRlIHRoZSBsaW5lLlxuICAgIGNvbnN0IHNrZXRjaEJhZGdlID0gc2xpY2UuaXNfc2tldGNoID09PSAxID8gXCJgW3NrZXRjaF1gIFwiIDogXCJcIjtcbiAgICBsaW5lcy5wdXNoKGAtIFske2RvbmV9XSAqKiR7c2xpY2UuaWR9OiAke3NsaWNlLnRpdGxlfSoqICR7c2tldGNoQmFkZ2V9XFxgcmlzazoke3NsaWNlLnJpc2t9XFxgIFxcYGRlcGVuZHM6JHtkZXBlbmRzfVxcYGApO1xuICAgIGxpbmVzLnB1c2goYCAgPiBBZnRlciB0aGlzOiAke3NsaWNlLmRlbW99YCk7XG4gICAgbGluZXMucHVzaChcIlwiKTtcbiAgfVxuXG4gIGlmIChtaWxlc3RvbmUuYm91bmRhcnlfbWFwX21hcmtkb3duLnRyaW0oKSkge1xuICAgIGxpbmVzLnB1c2goXCIjIyBCb3VuZGFyeSBNYXBcIik7XG4gICAgbGluZXMucHVzaChcIlwiKTtcbiAgICBsaW5lcy5wdXNoKG1pbGVzdG9uZS5ib3VuZGFyeV9tYXBfbWFya2Rvd24udHJpbSgpKTtcbiAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICB9XG5cbiAgcmV0dXJuIGAke2xpbmVzLmpvaW4oXCJcXG5cIikudHJpbUVuZCgpfVxcbmA7XG59XG5cbmZ1bmN0aW9uIHJlbmRlclRhc2tQbGFuTWFya2Rvd24odGFzazogVGFza1JvdywgdGFza0dhdGVzOiBHYXRlUm93W10gPSBbXSk6IHN0cmluZyB7XG4gIGNvbnN0IGRlc2NyaXB0aW9uID0gbWVhbmluZ2Z1bFNlY3Rpb24odGFzay5kZXNjcmlwdGlvbik7XG4gIGNvbnN0IG9ic2VydmFiaWxpdHlJbXBhY3QgPSBtZWFuaW5nZnVsU2VjdGlvbih0YXNrLm9ic2VydmFiaWxpdHlfaW1wYWN0KTtcbiAgY29uc3QgZXN0aW1hdGVkU3RlcHMgPSBNYXRoLm1heCgxLCBkZXNjcmlwdGlvbi5zcGxpdCgvXFxuKy8pLmZpbHRlcihCb29sZWFuKS5sZW5ndGggfHwgMSk7XG4gIGNvbnN0IGVzdGltYXRlZEZpbGVzID0gdGFzay5maWxlcy5sZW5ndGggPiAwXG4gICAgPyB0YXNrLmZpbGVzLmxlbmd0aFxuICAgIDogdGFzay5leHBlY3RlZF9vdXRwdXQubGVuZ3RoID4gMFxuICAgICAgPyB0YXNrLmV4cGVjdGVkX291dHB1dC5sZW5ndGhcbiAgICAgIDogdGFzay5pbnB1dHMubGVuZ3RoID4gMFxuICAgICAgICA/IHRhc2suaW5wdXRzLmxlbmd0aFxuICAgICAgICA6IDE7XG5cbiAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG4gIGxpbmVzLnB1c2goXCItLS1cIik7XG4gIGxpbmVzLnB1c2goYGVzdGltYXRlZF9zdGVwczogJHtlc3RpbWF0ZWRTdGVwc31gKTtcbiAgbGluZXMucHVzaChgZXN0aW1hdGVkX2ZpbGVzOiAke2VzdGltYXRlZEZpbGVzfWApO1xuICBsaW5lcy5wdXNoKFwic2tpbGxzX3VzZWQ6IFtdXCIpO1xuICBsaW5lcy5wdXNoKFwiLS0tXCIpO1xuICBsaW5lcy5wdXNoKFwiXCIpO1xuICBsaW5lcy5wdXNoKGAjICR7dGFzay5pZH06ICR7dGFzay50aXRsZSB8fCB0YXNrLmlkfWApO1xuICBsaW5lcy5wdXNoKFwiXCIpO1xuXG4gIGlmIChkZXNjcmlwdGlvbikge1xuICAgIGxpbmVzLnB1c2goZGVzY3JpcHRpb24pO1xuICAgIGxpbmVzLnB1c2goXCJcIik7XG4gIH1cblxuICBsaW5lcy5wdXNoKFwiIyMgSW5wdXRzXCIpO1xuICBsaW5lcy5wdXNoKFwiXCIpO1xuICBpZiAodGFzay5pbnB1dHMubGVuZ3RoID4gMCkge1xuICAgIGZvciAoY29uc3QgaW5wdXQgb2YgdGFzay5pbnB1dHMpIHtcbiAgICAgIGxpbmVzLnB1c2goYC0gXFxgJHtpbnB1dH1cXGBgKTtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgbGluZXMucHVzaChcIi0gTm9uZSBzcGVjaWZpZWQuXCIpO1xuICB9XG4gIGxpbmVzLnB1c2goXCJcIik7XG5cbiAgbGluZXMucHVzaChcIiMjIEV4cGVjdGVkIE91dHB1dFwiKTtcbiAgbGluZXMucHVzaChcIlwiKTtcbiAgaWYgKHRhc2suZXhwZWN0ZWRfb3V0cHV0Lmxlbmd0aCA+IDApIHtcbiAgICBmb3IgKGNvbnN0IG91dHB1dCBvZiB0YXNrLmV4cGVjdGVkX291dHB1dCkge1xuICAgICAgbGluZXMucHVzaChgLSBcXGAke291dHB1dH1cXGBgKTtcbiAgICB9XG4gIH0gZWxzZSBpZiAodGFzay5maWxlcy5sZW5ndGggPiAwKSB7XG4gICAgZm9yIChjb25zdCBmaWxlIG9mIHRhc2suZmlsZXMpIHtcbiAgICAgIGxpbmVzLnB1c2goYC0gXFxgJHtmaWxlfVxcYGApO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICBsaW5lcy5wdXNoKFwiLSBVcGRhdGUgdGhlIGltcGxlbWVudGF0aW9uIGFuZCBwcm9vZiBhcnRpZmFjdHMgbmVlZGVkIGZvciB0aGlzIHRhc2suXCIpO1xuICB9XG4gIGxpbmVzLnB1c2goXCJcIik7XG5cbiAgbGluZXMucHVzaChcIiMjIFZlcmlmaWNhdGlvblwiKTtcbiAgbGluZXMucHVzaChcIlwiKTtcbiAgbGluZXMucHVzaCh0YXNrLnZlcmlmeS50cmltKCkgfHwgXCItIFZlcmlmeSB0aGUgdGFzayBvdXRjb21lIHdpdGggdGhlIHNsaWNlLWxldmVsIGNoZWNrcy5cIik7XG4gIGxpbmVzLnB1c2goXCJcIik7XG5cbiAgaWYgKG9ic2VydmFiaWxpdHlJbXBhY3QpIHtcbiAgICBsaW5lcy5wdXNoKFwiIyMgT2JzZXJ2YWJpbGl0eSBJbXBhY3RcIik7XG4gICAgbGluZXMucHVzaChcIlwiKTtcbiAgICBsaW5lcy5wdXNoKG9ic2VydmFiaWxpdHlJbXBhY3QpO1xuICAgIGxpbmVzLnB1c2goXCJcIik7XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgUXVhbGl0eSBHYXRlIFNlY3Rpb25zIChRNS9RNi9RNykgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGNvbnN0IGdhdGVMYWJlbHM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7IFE1OiBcIkZhaWx1cmUgTW9kZXNcIiwgUTY6IFwiTG9hZCBQcm9maWxlXCIsIFE3OiBcIk5lZ2F0aXZlIFRlc3RzXCIgfTtcbiAgZm9yIChjb25zdCBbZ2lkLCBsYWJlbF0gb2YgT2JqZWN0LmVudHJpZXMoZ2F0ZUxhYmVscykpIHtcbiAgICBjb25zdCBnYXRlID0gdGFza0dhdGVzLmZpbmQoZyA9PiBnLmdhdGVfaWQgPT09IGdpZCAmJiBnLnN0YXR1cyA9PT0gXCJjb21wbGV0ZVwiKTtcbiAgICBpZiAoZ2F0ZSAmJiBnYXRlLnZlcmRpY3QgIT09IFwib21pdHRlZFwiKSB7XG4gICAgICBsaW5lcy5wdXNoKGAjIyAke2xhYmVsfWApO1xuICAgICAgbGluZXMucHVzaChcIlwiKTtcbiAgICAgIGxpbmVzLnB1c2goZ2F0ZS5maW5kaW5ncy50cmltKCkgfHwgYC0gKipWZXJkaWN0OioqICR7Z2F0ZS52ZXJkaWN0fVxcbi0gKipSYXRpb25hbGU6KiogJHtnYXRlLnJhdGlvbmFsZX1gKTtcbiAgICAgIGxpbmVzLnB1c2goXCJcIik7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGAke2xpbmVzLmpvaW4oXCJcXG5cIikudHJpbUVuZCgpfVxcbmA7XG59XG5cbmZ1bmN0aW9uIHJlbmRlclNsaWNlUGxhbk1hcmtkb3duKHNsaWNlOiBTbGljZVJvdywgdGFza3M6IFRhc2tSb3dbXSwgZ2F0ZXM6IEdhdGVSb3dbXSA9IFtdKTogc3RyaW5nIHtcbiAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG5cbiAgbGluZXMucHVzaChgIyAke3NsaWNlLmlkfTogJHtzbGljZS50aXRsZSB8fCBzbGljZS5pZH1gKTtcbiAgbGluZXMucHVzaChcIlwiKTtcbiAgbGluZXMucHVzaChgKipHb2FsOioqICR7c2xpY2UuZ29hbH1gKTtcbiAgbGluZXMucHVzaChgKipEZW1vOioqICR7c2xpY2UuZGVtb31gKTtcbiAgbGluZXMucHVzaChcIlwiKTtcblxuICBsaW5lcy5wdXNoKFwiIyMgTXVzdC1IYXZlc1wiKTtcbiAgbGluZXMucHVzaChcIlwiKTtcbiAgY29uc3Qgc3VjY2Vzc0NyaXRlcmlhID0gbWVhbmluZ2Z1bFNlY3Rpb24oc2xpY2Uuc3VjY2Vzc19jcml0ZXJpYSk7XG4gIGlmIChzdWNjZXNzQ3JpdGVyaWEpIHtcbiAgICBmb3IgKGNvbnN0IGxpbmUgb2Ygc3VjY2Vzc0NyaXRlcmlhLnNwbGl0KC9cXG4rLykubWFwKChlbnRyeSkgPT4gZW50cnkudHJpbSgpKS5maWx0ZXIoQm9vbGVhbikpIHtcbiAgICAgIGxpbmVzLnB1c2gobGluZS5zdGFydHNXaXRoKFwiLVwiKSA/IGxpbmUgOiBgLSAke2xpbmV9YCk7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIGxpbmVzLnB1c2goXCItIENvbXBsZXRlIHRoZSBwbGFubmVkIHNsaWNlIG91dGNvbWVzLlwiKTtcbiAgfVxuICBsaW5lcy5wdXNoKFwiXCIpO1xuXG4gIC8vIFx1MjUwMFx1MjUwMCBRdWFsaXR5IEdhdGUgU2VjdGlvbnMgKFEzL1E0KSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgY29uc3QgcTMgPSBnYXRlcy5maW5kKGcgPT4gZy5nYXRlX2lkID09PSBcIlEzXCIgJiYgZy5zdGF0dXMgPT09IFwiY29tcGxldGVcIik7XG4gIGlmIChxMyAmJiBxMy52ZXJkaWN0ICE9PSBcIm9taXR0ZWRcIikge1xuICAgIGxpbmVzLnB1c2goXCIjIyBUaHJlYXQgU3VyZmFjZVwiKTtcbiAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICAgIGxpbmVzLnB1c2gocTMuZmluZGluZ3MudHJpbSgpIHx8IGAtICoqVmVyZGljdDoqKiAke3EzLnZlcmRpY3R9XFxuLSAqKlJhdGlvbmFsZToqKiAke3EzLnJhdGlvbmFsZX1gKTtcbiAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICB9XG5cbiAgY29uc3QgcTQgPSBnYXRlcy5maW5kKGcgPT4gZy5nYXRlX2lkID09PSBcIlE0XCIgJiYgZy5zdGF0dXMgPT09IFwiY29tcGxldGVcIik7XG4gIGlmIChxNCAmJiBxNC52ZXJkaWN0ICE9PSBcIm9taXR0ZWRcIikge1xuICAgIGxpbmVzLnB1c2goXCIjIyBSZXF1aXJlbWVudCBJbXBhY3RcIik7XG4gICAgbGluZXMucHVzaChcIlwiKTtcbiAgICBsaW5lcy5wdXNoKHE0LmZpbmRpbmdzLnRyaW0oKSB8fCBgLSAqKlZlcmRpY3Q6KiogJHtxNC52ZXJkaWN0fVxcbi0gKipSYXRpb25hbGU6KiogJHtxNC5yYXRpb25hbGV9YCk7XG4gICAgbGluZXMucHVzaChcIlwiKTtcbiAgfVxuXG4gIGNvbnN0IHByb29mTGV2ZWwgPSBtZWFuaW5nZnVsU2VjdGlvbihzbGljZS5wcm9vZl9sZXZlbCk7XG4gIGlmIChwcm9vZkxldmVsKSB7XG4gICAgbGluZXMucHVzaChcIiMjIFByb29mIExldmVsXCIpO1xuICAgIGxpbmVzLnB1c2goXCJcIik7XG4gICAgbGluZXMucHVzaChgLSBUaGlzIHNsaWNlIHByb3ZlczogJHtwcm9vZkxldmVsfWApO1xuICAgIGxpbmVzLnB1c2goXCJcIik7XG4gIH1cblxuICBjb25zdCBpbnRlZ3JhdGlvbkNsb3N1cmUgPSBtZWFuaW5nZnVsU2VjdGlvbihzbGljZS5pbnRlZ3JhdGlvbl9jbG9zdXJlKTtcbiAgaWYgKGludGVncmF0aW9uQ2xvc3VyZSkge1xuICAgIGxpbmVzLnB1c2goXCIjIyBJbnRlZ3JhdGlvbiBDbG9zdXJlXCIpO1xuICAgIGxpbmVzLnB1c2goXCJcIik7XG4gICAgbGluZXMucHVzaChpbnRlZ3JhdGlvbkNsb3N1cmUpO1xuICAgIGxpbmVzLnB1c2goXCJcIik7XG4gIH1cblxuICBsaW5lcy5wdXNoKFwiIyMgVmVyaWZpY2F0aW9uXCIpO1xuICBsaW5lcy5wdXNoKFwiXCIpO1xuICBjb25zdCB2ZXJpZmljYXRpb24gPSBtZWFuaW5nZnVsU2VjdGlvbihzbGljZS5vYnNlcnZhYmlsaXR5X2ltcGFjdCk7XG4gIGlmICh2ZXJpZmljYXRpb24pIHtcbiAgICBjb25zdCB2ZXJpZmljYXRpb25MaW5lcyA9IHZlcmlmaWNhdGlvblxuICAgICAgLnNwbGl0KC9cXG4rLylcbiAgICAgIC5tYXAoKGVudHJ5KSA9PiBlbnRyeS50cmltKCkpXG4gICAgICAuZmlsdGVyKEJvb2xlYW4pO1xuICAgIGZvciAoY29uc3QgbGluZSBvZiB2ZXJpZmljYXRpb25MaW5lcykge1xuICAgICAgbGluZXMucHVzaChsaW5lLnN0YXJ0c1dpdGgoXCItXCIpID8gbGluZSA6IGAtICR7bGluZX1gKTtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgbGluZXMucHVzaChcIi0gUnVuIHRoZSB0YXNrIGFuZCBzbGljZSB2ZXJpZmljYXRpb24gY2hlY2tzIGZvciB0aGlzIHNsaWNlLlwiKTtcbiAgfVxuICBsaW5lcy5wdXNoKFwiXCIpO1xuXG4gIGxpbmVzLnB1c2goXCIjIyBUYXNrc1wiKTtcbiAgbGluZXMucHVzaChcIlwiKTtcbiAgZm9yIChjb25zdCB0YXNrIG9mIHRhc2tzKSB7XG4gICAgY29uc3QgZG9uZSA9IGlzQ2xvc2VkU3RhdHVzKHRhc2suc3RhdHVzKSA/IFwieFwiIDogXCIgXCI7XG4gICAgY29uc3QgZXN0aW1hdGUgPSB0YXNrLmVzdGltYXRlLnRyaW0oKSA/IGAgXFxgZXN0OiR7dGFzay5lc3RpbWF0ZS50cmltKCl9XFxgYCA6IFwiXCI7XG4gICAgbGluZXMucHVzaChgLSBbJHtkb25lfV0gKioke3Rhc2suaWR9OiAke3Rhc2sudGl0bGUgfHwgdGFzay5pZH0qKiR7ZXN0aW1hdGV9YCk7XG4gICAgY29uc3Qgc3VtbWFyeSA9IHRhc2tTdW1tYXJ5Rm9yU2xpY2VQbGFuKHRhc2suZGVzY3JpcHRpb24pO1xuICAgIGlmIChzdW1tYXJ5KSB7XG4gICAgICBwdXNoSW5kZW50ZWQobGluZXMsIHN1bW1hcnkpO1xuICAgIH1cbiAgICBpZiAodGFzay5maWxlcy5sZW5ndGggPiAwKSB7XG4gICAgICBsaW5lcy5wdXNoKGAgIC0gRmlsZXM6ICR7dGFzay5maWxlcy5tYXAoKGZpbGUpID0+IGBcXGAke2ZpbGV9XFxgYCkuam9pbihcIiwgXCIpfWApO1xuICAgIH1cbiAgICBpZiAodGFzay52ZXJpZnkudHJpbSgpKSB7XG4gICAgICBsaW5lcy5wdXNoKGAgIC0gVmVyaWZ5OiAke3Rhc2sudmVyaWZ5LnRyaW0oKX1gKTtcbiAgICB9XG4gICAgbGluZXMucHVzaChcIlwiKTtcbiAgfVxuXG4gIGNvbnN0IGZpbGVzTGlrZWx5VG91Y2hlZCA9IEFycmF5LmZyb20obmV3IFNldCh0YXNrcy5mbGF0TWFwKCh0YXNrKSA9PiB0YXNrLmZpbGVzKSkpO1xuICBpZiAoZmlsZXNMaWtlbHlUb3VjaGVkLmxlbmd0aCA+IDApIHtcbiAgICBsaW5lcy5wdXNoKFwiIyMgRmlsZXMgTGlrZWx5IFRvdWNoZWRcIik7XG4gICAgbGluZXMucHVzaChcIlwiKTtcbiAgICBmb3IgKGNvbnN0IGZpbGUgb2YgZmlsZXNMaWtlbHlUb3VjaGVkKSB7XG4gICAgICBsaW5lcy5wdXNoKGAtICR7ZmlsZX1gKTtcbiAgICB9XG4gICAgbGluZXMucHVzaChcIlwiKTtcbiAgfVxuXG4gIHJldHVybiBgJHtsaW5lcy5qb2luKFwiXFxuXCIpLnRyaW1FbmQoKX1cXG5gO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVuZGVyUGxhbkZyb21EYihcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgbWlsZXN0b25lSWQ6IHN0cmluZyxcbiAgc2xpY2VJZDogc3RyaW5nLFxuKTogUHJvbWlzZTx7IHBsYW5QYXRoOiBzdHJpbmc7IHRhc2tQbGFuUGF0aHM6IHN0cmluZ1tdOyBjb250ZW50OiBzdHJpbmcgfT4ge1xuICBjb25zdCBzbGljZSA9IGdldFNsaWNlKG1pbGVzdG9uZUlkLCBzbGljZUlkKTtcbiAgaWYgKCFzbGljZSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgc2xpY2UgJHttaWxlc3RvbmVJZH0vJHtzbGljZUlkfSBub3QgZm91bmRgKTtcbiAgfVxuXG4gIGNvbnN0IHRhc2tzID0gZ2V0U2xpY2VUYXNrcyhtaWxlc3RvbmVJZCwgc2xpY2VJZCk7XG4gIGlmICh0YXNrcy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYG5vIHRhc2tzIGZvdW5kIGZvciAke21pbGVzdG9uZUlkfS8ke3NsaWNlSWR9YCk7XG4gIH1cblxuICBjb25zdCBzbGljZVBhdGggPSByZXNvbHZlU2xpY2VQYXRoKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgc2xpY2VJZClcbiAgICA/PyBqb2luKGdzZFJvb3QoYmFzZVBhdGgpLCBcIm1pbGVzdG9uZXNcIiwgbWlsZXN0b25lSWQsIFwic2xpY2VzXCIsIHNsaWNlSWQpO1xuICBjb25zdCBhYnNQYXRoID0gcmVzb2x2ZVNsaWNlRmlsZShiYXNlUGF0aCwgbWlsZXN0b25lSWQsIHNsaWNlSWQsIFwiUExBTlwiKVxuICAgID8/IGpvaW4oc2xpY2VQYXRoLCBgJHtzbGljZUlkfS1QTEFOLm1kYCk7XG4gIGNvbnN0IGFydGlmYWN0UGF0aCA9IHRvQXJ0aWZhY3RQYXRoKGFic1BhdGgsIGJhc2VQYXRoKTtcbiAgY29uc3Qgc2xpY2VHYXRlcyA9IGdldEdhdGVSZXN1bHRzKG1pbGVzdG9uZUlkLCBzbGljZUlkLCBcInNsaWNlXCIpO1xuICBjb25zdCBjb250ZW50ID0gcmVuZGVyU2xpY2VQbGFuTWFya2Rvd24oc2xpY2UsIHRhc2tzLCBzbGljZUdhdGVzKTtcblxuICBhd2FpdCB3cml0ZUFuZFN0b3JlKGFic1BhdGgsIGFydGlmYWN0UGF0aCwgY29udGVudCwge1xuICAgIGFydGlmYWN0X3R5cGU6IFwiUExBTlwiLFxuICAgIG1pbGVzdG9uZV9pZDogbWlsZXN0b25lSWQsXG4gICAgc2xpY2VfaWQ6IHNsaWNlSWQsXG4gIH0pO1xuXG4gIGNvbnN0IHRhc2tQbGFuUGF0aHM6IHN0cmluZ1tdID0gW107XG4gIGZvciAoY29uc3QgdGFzayBvZiB0YXNrcykge1xuICAgIGNvbnN0IHJlbmRlcmVkID0gYXdhaXQgcmVuZGVyVGFza1BsYW5Gcm9tRGIoYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBzbGljZUlkLCB0YXNrLmlkKTtcbiAgICB0YXNrUGxhblBhdGhzLnB1c2gocmVuZGVyZWQudGFza1BsYW5QYXRoKTtcbiAgfVxuXG4gIHJldHVybiB7IHBsYW5QYXRoOiBhYnNQYXRoLCB0YXNrUGxhblBhdGhzLCBjb250ZW50IH07XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZW5kZXJUYXNrUGxhbkZyb21EYihcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgbWlsZXN0b25lSWQ6IHN0cmluZyxcbiAgc2xpY2VJZDogc3RyaW5nLFxuICB0YXNrSWQ6IHN0cmluZyxcbik6IFByb21pc2U8eyB0YXNrUGxhblBhdGg6IHN0cmluZzsgY29udGVudDogc3RyaW5nIH0+IHtcbiAgY29uc3QgdGFzayA9IGdldFRhc2sobWlsZXN0b25lSWQsIHNsaWNlSWQsIHRhc2tJZCk7XG4gIGlmICghdGFzaykge1xuICAgIHRocm93IG5ldyBFcnJvcihgdGFzayAke21pbGVzdG9uZUlkfS8ke3NsaWNlSWR9LyR7dGFza0lkfSBub3QgZm91bmRgKTtcbiAgfVxuXG4gIGNvbnN0IHRhc2tzRGlyID0gcmVzb2x2ZVRhc2tzRGlyKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgc2xpY2VJZClcbiAgICA/PyBqb2luKGdzZFJvb3QoYmFzZVBhdGgpLCBcIm1pbGVzdG9uZXNcIiwgbWlsZXN0b25lSWQsIFwic2xpY2VzXCIsIHNsaWNlSWQsIFwidGFza3NcIik7XG4gIG1rZGlyU3luYyh0YXNrc0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGNvbnN0IGFic1BhdGggPSBqb2luKHRhc2tzRGlyLCBidWlsZFRhc2tGaWxlTmFtZSh0YXNrSWQsIFwiUExBTlwiKSk7XG4gIGNvbnN0IGFydGlmYWN0UGF0aCA9IHRvQXJ0aWZhY3RQYXRoKGFic1BhdGgsIGJhc2VQYXRoKTtcbiAgY29uc3QgdGFza0dhdGVzID0gZ2V0R2F0ZVJlc3VsdHMobWlsZXN0b25lSWQsIHNsaWNlSWQsIFwidGFza1wiKS5maWx0ZXIoZyA9PiBnLnRhc2tfaWQgPT09IHRhc2tJZCk7XG4gIGNvbnN0IGNvbnRlbnQgPSB0YXNrLmZ1bGxfcGxhbl9tZC50cmltKCkgPyB0YXNrLmZ1bGxfcGxhbl9tZCA6IHJlbmRlclRhc2tQbGFuTWFya2Rvd24odGFzaywgdGFza0dhdGVzKTtcblxuICBhd2FpdCB3cml0ZUFuZFN0b3JlKGFic1BhdGgsIGFydGlmYWN0UGF0aCwgY29udGVudCwge1xuICAgIGFydGlmYWN0X3R5cGU6IFwiUExBTlwiLFxuICAgIG1pbGVzdG9uZV9pZDogbWlsZXN0b25lSWQsXG4gICAgc2xpY2VfaWQ6IHNsaWNlSWQsXG4gICAgdGFza19pZDogdGFza0lkLFxuICB9KTtcblxuICByZXR1cm4geyB0YXNrUGxhblBhdGg6IGFic1BhdGgsIGNvbnRlbnQgfTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlbmRlclJvYWRtYXBGcm9tRGIoXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIG1pbGVzdG9uZUlkOiBzdHJpbmcsXG4pOiBQcm9taXNlPHsgcm9hZG1hcFBhdGg6IHN0cmluZzsgY29udGVudDogc3RyaW5nIH0+IHtcbiAgY29uc3QgbWlsZXN0b25lID0gZ2V0TWlsZXN0b25lKG1pbGVzdG9uZUlkKTtcbiAgaWYgKCFtaWxlc3RvbmUpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYG1pbGVzdG9uZSAke21pbGVzdG9uZUlkfSBub3QgZm91bmRgKTtcbiAgfVxuXG4gIGNvbnN0IHNsaWNlcyA9IGdldE1pbGVzdG9uZVNsaWNlcyhtaWxlc3RvbmVJZCk7XG4gIGNvbnN0IGFic1BhdGggPSByZXNvbHZlTWlsZXN0b25lRmlsZShiYXNlUGF0aCwgbWlsZXN0b25lSWQsIFwiUk9BRE1BUFwiKSA/P1xuICAgIGpvaW4oZ3NkUm9vdChiYXNlUGF0aCksIFwibWlsZXN0b25lc1wiLCBtaWxlc3RvbmVJZCwgYCR7bWlsZXN0b25lSWR9LVJPQURNQVAubWRgKTtcbiAgY29uc3QgYXJ0aWZhY3RQYXRoID0gdG9BcnRpZmFjdFBhdGgoYWJzUGF0aCwgYmFzZVBhdGgpO1xuICBjb25zdCBjb250ZW50ID0gcmVuZGVyUm9hZG1hcE1hcmtkb3duKG1pbGVzdG9uZSwgc2xpY2VzKTtcblxuICBhd2FpdCB3cml0ZUFuZFN0b3JlKGFic1BhdGgsIGFydGlmYWN0UGF0aCwgY29udGVudCwge1xuICAgIGFydGlmYWN0X3R5cGU6IFwiUk9BRE1BUFwiLFxuICAgIG1pbGVzdG9uZV9pZDogbWlsZXN0b25lSWQsXG4gIH0pO1xuXG4gIHJldHVybiB7IHJvYWRtYXBQYXRoOiBhYnNQYXRoLCBjb250ZW50IH07XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBSb2FkbWFwIENoZWNrYm94IFJlbmRlcmluZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBSZW5kZXIgcm9hZG1hcCBjaGVja2JveCBzdGF0ZXMgZnJvbSBEQi5cbiAqXG4gKiBGb3IgZWFjaCBzbGljZSBpbiB0aGUgbWlsZXN0b25lLCBzZXRzIFt4XSBpZiBzdGF0dXMgPT09ICdjb21wbGV0ZScsXG4gKiBbIF0gb3RoZXJ3aXNlLiBIYW5kbGVzIGJpZGlyZWN0aW9uYWwgdXBkYXRlcyAoY2FuIHVuY2hlY2sgcHJldmlvdXNseVxuICogY2hlY2tlZCBzbGljZXMgaWYgREIgc2F5cyBwZW5kaW5nKS5cbiAqXG4gKiBAcmV0dXJucyB0cnVlIGlmIHRoZSByb2FkbWFwIHdhcyB3cml0dGVuLCBmYWxzZSBvbiBza2lwL2Vycm9yXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZW5kZXJSb2FkbWFwQ2hlY2tib3hlcyhcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgbWlsZXN0b25lSWQ6IHN0cmluZyxcbik6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBjb25zdCBzbGljZXMgPSBnZXRNaWxlc3RvbmVTbGljZXMobWlsZXN0b25lSWQpO1xuICBpZiAoc2xpY2VzLmxlbmd0aCA9PT0gMCkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgYG1hcmtkb3duLXJlbmRlcmVyOiBubyBzbGljZXMgZm91bmQgZm9yIG1pbGVzdG9uZSAke21pbGVzdG9uZUlkfVxcbmAsXG4gICAgKTtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICBjb25zdCBhYnNQYXRoID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBcIlJPQURNQVBcIik7XG4gIGNvbnN0IGFydGlmYWN0UGF0aCA9IGFic1BhdGggPyB0b0FydGlmYWN0UGF0aChhYnNQYXRoLCBiYXNlUGF0aCkgOiBudWxsO1xuXG4gIC8vIExvYWQgY29udGVudCBmcm9tIERCOyByZWdlbmVyYXRlIGZyb20gREIgcm93cyB3aGVuIHRoZSBhcnRpZmFjdCBpcyBhYnNlbnQuXG4gIGxldCBjb250ZW50OiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgaWYgKGFydGlmYWN0UGF0aCkge1xuICAgIGNvbnRlbnQgPSBsb2FkQXJ0aWZhY3RDb250ZW50KGFydGlmYWN0UGF0aCk7XG4gIH1cblxuICBpZiAoIWNvbnRlbnQpIHtcbiAgICBhd2FpdCByZW5kZXJSb2FkbWFwRnJvbURiKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICAvLyBBcHBseSBjaGVja2JveCBwYXRjaGVzIGZvciBlYWNoIHNsaWNlXG4gIGxldCB1cGRhdGVkID0gY29udGVudDtcbiAgZm9yIChjb25zdCBzbGljZSBvZiBzbGljZXMpIHtcbiAgICBjb25zdCBpc0RvbmUgPSBpc0Nsb3NlZFN0YXR1cyhzbGljZS5zdGF0dXMpO1xuICAgIGNvbnN0IHNpZCA9IHNsaWNlLmlkO1xuXG4gICAgaWYgKGlzRG9uZSkge1xuICAgICAgLy8gU2V0IFt4XTogcmVwbGFjZSBcIi0gWyBdICoqUzAxOlwiIHdpdGggXCItIFt4XSAqKlMwMTpcIlxuICAgICAgdXBkYXRlZCA9IHVwZGF0ZWQucmVwbGFjZShcbiAgICAgICAgbmV3IFJlZ0V4cChgXihcXFxccyotXFxcXHMrKVxcXFxbIFxcXFxdXFxcXHMrXFxcXCpcXFxcKiR7c2lkfTpgLCBcIm1cIiksXG4gICAgICAgIGAkMVt4XSAqKiR7c2lkfTpgLFxuICAgICAgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gU2V0IFsgXTogcmVwbGFjZSBcIi0gW3hdICoqUzAxOlwiIHdpdGggXCItIFsgXSAqKlMwMTpcIlxuICAgICAgdXBkYXRlZCA9IHVwZGF0ZWQucmVwbGFjZShcbiAgICAgICAgbmV3IFJlZ0V4cChgXihcXFxccyotXFxcXHMrKVxcXFxbeFxcXFxdXFxcXHMrXFxcXCpcXFxcKiR7c2lkfTpgLCBcIm1pXCIpLFxuICAgICAgICBgJDFbIF0gKioke3NpZH06YCxcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgaWYgKCFhYnNQYXRoKSByZXR1cm4gZmFsc2U7XG5cbiAgYXdhaXQgd3JpdGVBbmRTdG9yZShhYnNQYXRoLCBhcnRpZmFjdFBhdGghLCB1cGRhdGVkLCB7XG4gICAgYXJ0aWZhY3RfdHlwZTogXCJST0FETUFQXCIsXG4gICAgbWlsZXN0b25lX2lkOiBtaWxlc3RvbmVJZCxcbiAgfSk7XG5cbiAgcmV0dXJuIHRydWU7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBQbGFuIENoZWNrYm94IFJlbmRlcmluZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBSZW5kZXIgcGxhbiBjaGVja2JveCBzdGF0ZXMgZnJvbSBEQi5cbiAqXG4gKiBGb3IgZWFjaCB0YXNrIGluIHRoZSBzbGljZSwgc2V0cyBbeF0gaWYgc3RhdHVzID09PSAnZG9uZScsXG4gKiBbIF0gb3RoZXJ3aXNlLiBCaWRpcmVjdGlvbmFsLlxuICpcbiAqIEByZXR1cm5zIHRydWUgaWYgdGhlIHBsYW4gd2FzIHdyaXR0ZW4sIGZhbHNlIG9uIHNraXAvZXJyb3JcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlbmRlclBsYW5DaGVja2JveGVzKFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICBtaWxlc3RvbmVJZDogc3RyaW5nLFxuICBzbGljZUlkOiBzdHJpbmcsXG4pOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgY29uc3QgdGFza3MgPSBnZXRTbGljZVRhc2tzKG1pbGVzdG9uZUlkLCBzbGljZUlkKTtcbiAgaWYgKHRhc2tzLmxlbmd0aCA9PT0gMCkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgYG1hcmtkb3duLXJlbmRlcmVyOiBubyB0YXNrcyBmb3VuZCBmb3IgJHttaWxlc3RvbmVJZH0vJHtzbGljZUlkfVxcbmAsXG4gICAgKTtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICBjb25zdCBhYnNQYXRoID0gcmVzb2x2ZVNsaWNlRmlsZShiYXNlUGF0aCwgbWlsZXN0b25lSWQsIHNsaWNlSWQsIFwiUExBTlwiKTtcbiAgY29uc3QgYXJ0aWZhY3RQYXRoID0gYWJzUGF0aCA/IHRvQXJ0aWZhY3RQYXRoKGFic1BhdGgsIGJhc2VQYXRoKSA6IG51bGw7XG5cbiAgbGV0IGNvbnRlbnQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBpZiAoYXJ0aWZhY3RQYXRoKSB7XG4gICAgY29udGVudCA9IGxvYWRBcnRpZmFjdENvbnRlbnQoYXJ0aWZhY3RQYXRoKTtcbiAgfVxuXG4gIGlmICghY29udGVudCkge1xuICAgIGF3YWl0IHJlbmRlclBsYW5Gcm9tRGIoYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBzbGljZUlkKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIC8vIEFwcGx5IGNoZWNrYm94IHBhdGNoZXMgZm9yIGVhY2ggdGFza1xuICBsZXQgdXBkYXRlZCA9IGNvbnRlbnQ7XG4gIGZvciAoY29uc3QgdGFzayBvZiB0YXNrcykge1xuICAgIGNvbnN0IGlzRG9uZSA9IGlzQ2xvc2VkU3RhdHVzKHRhc2suc3RhdHVzKTtcbiAgICBjb25zdCB0aWQgPSB0YXNrLmlkO1xuXG4gICAgaWYgKGlzRG9uZSkge1xuICAgICAgLy8gU2V0IFt4XVxuICAgICAgdXBkYXRlZCA9IHVwZGF0ZWQucmVwbGFjZShcbiAgICAgICAgbmV3IFJlZ0V4cChgXihcXFxccyotXFxcXHMrKVxcXFxbIFxcXFxdXFxcXHMrXFxcXCpcXFxcKiR7dGlkfTpgLCBcIm1cIiksXG4gICAgICAgIGAkMVt4XSAqKiR7dGlkfTpgLFxuICAgICAgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gU2V0IFsgXVxuICAgICAgdXBkYXRlZCA9IHVwZGF0ZWQucmVwbGFjZShcbiAgICAgICAgbmV3IFJlZ0V4cChgXihcXFxccyotXFxcXHMrKVxcXFxbeFxcXFxdXFxcXHMrXFxcXCpcXFxcKiR7dGlkfTpgLCBcIm1pXCIpLFxuICAgICAgICBgJDFbIF0gKioke3RpZH06YCxcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgaWYgKCFhYnNQYXRoKSByZXR1cm4gZmFsc2U7XG5cbiAgYXdhaXQgd3JpdGVBbmRTdG9yZShhYnNQYXRoLCBhcnRpZmFjdFBhdGghLCB1cGRhdGVkLCB7XG4gICAgYXJ0aWZhY3RfdHlwZTogXCJQTEFOXCIsXG4gICAgbWlsZXN0b25lX2lkOiBtaWxlc3RvbmVJZCxcbiAgICBzbGljZV9pZDogc2xpY2VJZCxcbiAgfSk7XG5cbiAgcmV0dXJuIHRydWU7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUYXNrIFN1bW1hcnkgUmVuZGVyaW5nIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFJlbmRlciBhIHRhc2sgc3VtbWFyeSBmcm9tIERCIHRvIGRpc2suXG4gKiBSZWFkcyBmdWxsX3N1bW1hcnlfbWQgZnJvbSB0aGUgdGFza3MgdGFibGUgYW5kIHdyaXRlcyBpdCB0byB0aGUgYXBwcm9wcmlhdGUgZmlsZS5cbiAqXG4gKiBAcmV0dXJucyB0cnVlIGlmIHRoZSBzdW1tYXJ5IHdhcyB3cml0dGVuLCBmYWxzZSBvbiBza2lwL2Vycm9yXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZW5kZXJUYXNrU3VtbWFyeShcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgbWlsZXN0b25lSWQ6IHN0cmluZyxcbiAgc2xpY2VJZDogc3RyaW5nLFxuICB0YXNrSWQ6IHN0cmluZyxcbik6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBjb25zdCB0YXNrID0gZ2V0VGFzayhtaWxlc3RvbmVJZCwgc2xpY2VJZCwgdGFza0lkKTtcbiAgaWYgKCF0YXNrIHx8ICF0YXNrLmZ1bGxfc3VtbWFyeV9tZCkge1xuICAgIHJldHVybiBmYWxzZTsgLy8gTm8gc3VtbWFyeSB0byByZW5kZXIgXHUyMDE0IHNraXAgc2lsZW50bHlcbiAgfVxuXG4gIC8vIFJlc29sdmUgdGhlIHRhc2tzIGRpcmVjdG9yeSwgY3JlYXRpbmcgcGF0aCBpZiBuZWVkZWRcbiAgY29uc3Qgc2xpY2VQYXRoID0gcmVzb2x2ZVNsaWNlUGF0aChiYXNlUGF0aCwgbWlsZXN0b25lSWQsIHNsaWNlSWQpO1xuICBpZiAoIXNsaWNlUGF0aCkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgYG1hcmtkb3duLXJlbmRlcmVyOiBjYW5ub3QgcmVzb2x2ZSBzbGljZSBwYXRoIGZvciAke21pbGVzdG9uZUlkfS8ke3NsaWNlSWR9XFxuYCxcbiAgICApO1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIGNvbnN0IHRhc2tzRGlyID0gam9pbihzbGljZVBhdGgsIFwidGFza3NcIik7XG4gIGNvbnN0IGZpbGVOYW1lID0gYnVpbGRUYXNrRmlsZU5hbWUodGFza0lkLCBcIlNVTU1BUllcIik7XG4gIGNvbnN0IGFic1BhdGggPSBqb2luKHRhc2tzRGlyLCBmaWxlTmFtZSk7XG4gIGNvbnN0IGFydGlmYWN0UGF0aCA9IHRvQXJ0aWZhY3RQYXRoKGFic1BhdGgsIGJhc2VQYXRoKTtcblxuICBhd2FpdCB3cml0ZUFuZFN0b3JlKGFic1BhdGgsIGFydGlmYWN0UGF0aCwgdGFzay5mdWxsX3N1bW1hcnlfbWQsIHtcbiAgICBhcnRpZmFjdF90eXBlOiBcIlNVTU1BUllcIixcbiAgICBtaWxlc3RvbmVfaWQ6IG1pbGVzdG9uZUlkLFxuICAgIHNsaWNlX2lkOiBzbGljZUlkLFxuICAgIHRhc2tfaWQ6IHRhc2tJZCxcbiAgfSk7XG5cbiAgcmV0dXJuIHRydWU7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTbGljZSBTdW1tYXJ5IFJlbmRlcmluZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBSZW5kZXIgc2xpY2Ugc3VtbWFyeSBhbmQgVUFUIGZpbGVzIGZyb20gREIgdG8gZGlzay5cbiAqIFJlYWRzIGZ1bGxfc3VtbWFyeV9tZCBhbmQgZnVsbF91YXRfbWQgZnJvbSB0aGUgc2xpY2VzIHRhYmxlLlxuICpcbiAqIEByZXR1cm5zIHRydWUgaWYgYXQgbGVhc3Qgb25lIGZpbGUgd2FzIHdyaXR0ZW4sIGZhbHNlIG9uIHNraXAvZXJyb3JcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlbmRlclNsaWNlU3VtbWFyeShcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgbWlsZXN0b25lSWQ6IHN0cmluZyxcbiAgc2xpY2VJZDogc3RyaW5nLFxuKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGNvbnN0IHNsaWNlID0gZ2V0U2xpY2UobWlsZXN0b25lSWQsIHNsaWNlSWQpO1xuICBpZiAoIXNsaWNlKSB7XG4gICAgcmV0dXJuIGZhbHNlOyAvLyBObyBzbGljZSBkYXRhIFx1MjAxNCBza2lwIHNpbGVudGx5XG4gIH1cblxuICBjb25zdCBzbGljZVBhdGggPSByZXNvbHZlU2xpY2VQYXRoKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgc2xpY2VJZCk7XG4gIGlmICghc2xpY2VQYXRoKSB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICBgbWFya2Rvd24tcmVuZGVyZXI6IGNhbm5vdCByZXNvbHZlIHNsaWNlIHBhdGggZm9yICR7bWlsZXN0b25lSWR9LyR7c2xpY2VJZH1cXG5gLFxuICAgICk7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgbGV0IHdyb3RlID0gZmFsc2U7XG5cbiAgLy8gV3JpdGUgU1VNTUFSWVxuICBpZiAoc2xpY2UuZnVsbF9zdW1tYXJ5X21kKSB7XG4gICAgY29uc3Qgc3VtbWFyeU5hbWUgPSBidWlsZFNsaWNlRmlsZU5hbWUoc2xpY2VJZCwgXCJTVU1NQVJZXCIpO1xuICAgIGNvbnN0IHN1bW1hcnlBYnMgPSBqb2luKHNsaWNlUGF0aCwgc3VtbWFyeU5hbWUpO1xuICAgIGNvbnN0IHN1bW1hcnlBcnRpZmFjdCA9IHRvQXJ0aWZhY3RQYXRoKHN1bW1hcnlBYnMsIGJhc2VQYXRoKTtcblxuICAgIGF3YWl0IHdyaXRlQW5kU3RvcmUoc3VtbWFyeUFicywgc3VtbWFyeUFydGlmYWN0LCBzbGljZS5mdWxsX3N1bW1hcnlfbWQsIHtcbiAgICAgIGFydGlmYWN0X3R5cGU6IFwiU1VNTUFSWVwiLFxuICAgICAgbWlsZXN0b25lX2lkOiBtaWxlc3RvbmVJZCxcbiAgICAgIHNsaWNlX2lkOiBzbGljZUlkLFxuICAgIH0pO1xuICAgIHdyb3RlID0gdHJ1ZTtcbiAgfVxuXG4gIC8vIFdyaXRlIFVBVFxuICBpZiAoc2xpY2UuZnVsbF91YXRfbWQpIHtcbiAgICBjb25zdCB1YXROYW1lID0gYnVpbGRTbGljZUZpbGVOYW1lKHNsaWNlSWQsIFwiVUFUXCIpO1xuICAgIGNvbnN0IHVhdEFicyA9IGpvaW4oc2xpY2VQYXRoLCB1YXROYW1lKTtcbiAgICBjb25zdCB1YXRBcnRpZmFjdCA9IHRvQXJ0aWZhY3RQYXRoKHVhdEFicywgYmFzZVBhdGgpO1xuXG4gICAgYXdhaXQgd3JpdGVBbmRTdG9yZSh1YXRBYnMsIHVhdEFydGlmYWN0LCBzbGljZS5mdWxsX3VhdF9tZCwge1xuICAgICAgYXJ0aWZhY3RfdHlwZTogXCJVQVRcIixcbiAgICAgIG1pbGVzdG9uZV9pZDogbWlsZXN0b25lSWQsXG4gICAgICBzbGljZV9pZDogc2xpY2VJZCxcbiAgICB9KTtcbiAgICB3cm90ZSA9IHRydWU7XG4gIH1cblxuICByZXR1cm4gd3JvdGU7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBSZW5kZXIgQWxsIEZyb20gREIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBpbnRlcmZhY2UgUmVuZGVyQWxsUmVzdWx0IHtcbiAgcmVuZGVyZWQ6IG51bWJlcjtcbiAgc2tpcHBlZDogbnVtYmVyO1xuICBlcnJvcnM6IHN0cmluZ1tdO1xufVxuXG4vKipcbiAqIEl0ZXJhdGUgYWxsIG1pbGVzdG9uZXMsIHNsaWNlcywgYW5kIHRhc2tzIGluIHRoZSBEQiBhbmQgcmVuZGVyIGVhY2ggYXJ0aWZhY3QgdG8gZGlzay5cbiAqIFJldHVybnMgc3RydWN0dXJlZCByZXN1bHQgZm9yIGluc3BlY3Rpb24uXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZW5kZXJBbGxGcm9tRGIoYmFzZVBhdGg6IHN0cmluZyk6IFByb21pc2U8UmVuZGVyQWxsUmVzdWx0PiB7XG4gIGNvbnN0IHJlc3VsdDogUmVuZGVyQWxsUmVzdWx0ID0geyByZW5kZXJlZDogMCwgc2tpcHBlZDogMCwgZXJyb3JzOiBbXSB9O1xuICBjb25zdCBtaWxlc3RvbmVzID0gZ2V0QWxsTWlsZXN0b25lcygpO1xuXG4gIGZvciAoY29uc3QgbWlsZXN0b25lIG9mIG1pbGVzdG9uZXMpIHtcbiAgICAvLyBSZW5kZXIgcm9hZG1hcCBjaGVja2JveGVzXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IG9rID0gYXdhaXQgcmVuZGVyUm9hZG1hcENoZWNrYm94ZXMoYmFzZVBhdGgsIG1pbGVzdG9uZS5pZCk7XG4gICAgICBpZiAob2spIHJlc3VsdC5yZW5kZXJlZCsrO1xuICAgICAgZWxzZSByZXN1bHQuc2tpcHBlZCsrO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgcmVzdWx0LmVycm9ycy5wdXNoKGByb2FkbWFwICR7bWlsZXN0b25lLmlkfTogJHsoZXJyIGFzIEVycm9yKS5tZXNzYWdlfWApO1xuICAgIH1cblxuICAgIC8vIEl0ZXJhdGUgc2xpY2VzXG4gICAgY29uc3Qgc2xpY2VzID0gZ2V0TWlsZXN0b25lU2xpY2VzKG1pbGVzdG9uZS5pZCk7XG4gICAgZm9yIChjb25zdCBzbGljZSBvZiBzbGljZXMpIHtcbiAgICAgIC8vIFJlbmRlciBwbGFuIGNoZWNrYm94ZXNcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IG9rID0gYXdhaXQgcmVuZGVyUGxhbkNoZWNrYm94ZXMoYmFzZVBhdGgsIG1pbGVzdG9uZS5pZCwgc2xpY2UuaWQpO1xuICAgICAgICBpZiAob2spIHJlc3VsdC5yZW5kZXJlZCsrO1xuICAgICAgICBlbHNlIHJlc3VsdC5za2lwcGVkKys7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgcmVzdWx0LmVycm9ycy5wdXNoKFxuICAgICAgICAgIGBwbGFuICR7bWlsZXN0b25lLmlkfS8ke3NsaWNlLmlkfTogJHsoZXJyIGFzIEVycm9yKS5tZXNzYWdlfWAsXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIC8vIFJlbmRlciBzbGljZSBzdW1tYXJ5XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBvayA9IGF3YWl0IHJlbmRlclNsaWNlU3VtbWFyeShiYXNlUGF0aCwgbWlsZXN0b25lLmlkLCBzbGljZS5pZCk7XG4gICAgICAgIGlmIChvaykgcmVzdWx0LnJlbmRlcmVkKys7XG4gICAgICAgIGVsc2UgcmVzdWx0LnNraXBwZWQrKztcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICByZXN1bHQuZXJyb3JzLnB1c2goXG4gICAgICAgICAgYHNsaWNlIHN1bW1hcnkgJHttaWxlc3RvbmUuaWR9LyR7c2xpY2UuaWR9OiAkeyhlcnIgYXMgRXJyb3IpLm1lc3NhZ2V9YCxcbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgLy8gSXRlcmF0ZSB0YXNrc1xuICAgICAgY29uc3QgdGFza3MgPSBnZXRTbGljZVRhc2tzKG1pbGVzdG9uZS5pZCwgc2xpY2UuaWQpO1xuICAgICAgZm9yIChjb25zdCB0YXNrIG9mIHRhc2tzKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3Qgb2sgPSBhd2FpdCByZW5kZXJUYXNrU3VtbWFyeShcbiAgICAgICAgICAgIGJhc2VQYXRoLFxuICAgICAgICAgICAgbWlsZXN0b25lLmlkLFxuICAgICAgICAgICAgc2xpY2UuaWQsXG4gICAgICAgICAgICB0YXNrLmlkLFxuICAgICAgICAgICk7XG4gICAgICAgICAgaWYgKG9rKSByZXN1bHQucmVuZGVyZWQrKztcbiAgICAgICAgICBlbHNlIHJlc3VsdC5za2lwcGVkKys7XG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgIHJlc3VsdC5lcnJvcnMucHVzaChcbiAgICAgICAgICAgIGB0YXNrIHN1bW1hcnkgJHttaWxlc3RvbmUuaWR9LyR7c2xpY2UuaWR9LyR7dGFzay5pZH06ICR7KGVyciBhcyBFcnJvcikubWVzc2FnZX1gLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4gcmVzdWx0O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU3RhbGUgRGV0ZWN0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgaW50ZXJmYWNlIFN0YWxlRW50cnkge1xuICBwYXRoOiBzdHJpbmc7XG4gIHJlYXNvbjogc3RyaW5nO1xufVxuXG4vKipcbiAqIERldGVjdCBzdGFsZSByZW5kZXJzIGJ5IGNvbXBhcmluZyBEQiBzdGF0ZSBhZ2FpbnN0IGZpbGUgY29udGVudC5cbiAqXG4gKiBDaGVja3M6XG4gKiAxLiBSb2FkbWFwIGNoZWNrYm94IHN0YXRlcyB2cyBEQiBzbGljZSBzdGF0dXNlc1xuICogMi4gUGxhbiBjaGVja2JveCBzdGF0ZXMgdnMgREIgdGFzayBzdGF0dXNlc1xuICogMy4gTWlzc2luZyBTVU1NQVJZLm1kIGZpbGVzIGZvciBjb21wbGV0ZSB0YXNrcyB3aXRoIGZ1bGxfc3VtbWFyeV9tZFxuICogNC4gTWlzc2luZyBTVU1NQVJZLm1kL1VBVC5tZCBmaWxlcyBmb3IgY29tcGxldGUgc2xpY2VzIHdpdGggY29udGVudFxuICpcbiAqIFJldHVybnMgYSBsaXN0IG9mIHN0YWxlIGVudHJpZXMgd2l0aCBmaWxlIHBhdGggYW5kIHJlYXNvbi5cbiAqIExvZ3MgdG8gc3RkZXJyIHdoZW4gc3RhbGUgZmlsZXMgYXJlIGRldGVjdGVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZGV0ZWN0U3RhbGVSZW5kZXJzKGJhc2VQYXRoOiBzdHJpbmcpOiBTdGFsZUVudHJ5W10ge1xuICAvLyBMYXp5LWxvYWQgcGFyc2VycyBcdTIwMTQgaW50ZW50aW9uYWwgZGlzay12cy1EQiBjb21wYXJpc29uIHJlcXVpcmVzIHBhcnNlcnNcbiAgY29uc3QgX3JlcXVpcmUgPSBjcmVhdGVSZXF1aXJlKGltcG9ydC5tZXRhLnVybCk7XG4gIGxldCBwYXJzZVJvYWRtYXA6IEZ1bmN0aW9uLCBwYXJzZVBsYW46IEZ1bmN0aW9uO1xuICB0cnkge1xuICAgIGNvbnN0IG0gPSBfcmVxdWlyZShcIi4vcGFyc2Vycy1sZWdhY3kudHNcIik7XG4gICAgcGFyc2VSb2FkbWFwID0gbS5wYXJzZVJvYWRtYXA7IHBhcnNlUGxhbiA9IG0ucGFyc2VQbGFuO1xuICB9IGNhdGNoIChlKSB7XG4gICAgbG9nV2FybmluZyhcInJlbmRlcmVyXCIsIGBwYXJzZXJzLWxlZ2FjeS50cyByZXF1aXJlIGZhaWxlZCwgZmFsbGluZyBiYWNrIHRvIC5qczogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICBjb25zdCBtID0gX3JlcXVpcmUoXCIuL3BhcnNlcnMtbGVnYWN5LmpzXCIpO1xuICAgIHBhcnNlUm9hZG1hcCA9IG0ucGFyc2VSb2FkbWFwOyBwYXJzZVBsYW4gPSBtLnBhcnNlUGxhbjtcbiAgfVxuXG4gIGNvbnN0IHN0YWxlOiBTdGFsZUVudHJ5W10gPSBbXTtcbiAgY29uc3QgbWlsZXN0b25lcyA9IGdldEFsbE1pbGVzdG9uZXMoKTtcblxuICBmb3IgKGNvbnN0IG1pbGVzdG9uZSBvZiBtaWxlc3RvbmVzKSB7XG4gICAgY29uc3Qgc2xpY2VzID0gZ2V0TWlsZXN0b25lU2xpY2VzKG1pbGVzdG9uZS5pZCk7XG5cbiAgICAvLyBcdTI1MDBcdTI1MDAgQ2hlY2sgcm9hZG1hcCBjaGVja2JveCBzdGF0ZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgICBjb25zdCByb2FkbWFwUGF0aCA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2VQYXRoLCBtaWxlc3RvbmUuaWQsIFwiUk9BRE1BUFwiKTtcbiAgICBpZiAocm9hZG1hcFBhdGggJiYgZXhpc3RzU3luYyhyb2FkbWFwUGF0aCkpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGNvbnRlbnQgPSByZWFkRmlsZVN5bmMocm9hZG1hcFBhdGgsIFwidXRmLThcIik7XG4gICAgICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlUm9hZG1hcChjb250ZW50KTtcblxuICAgICAgICBmb3IgKGNvbnN0IHNsaWNlIG9mIHNsaWNlcykge1xuICAgICAgICAgIGNvbnN0IGlzQ29tcGxldGVJbkRiID0gaXNDbG9zZWRTdGF0dXMoc2xpY2Uuc3RhdHVzKTtcbiAgICAgICAgICBjb25zdCByb2FkbWFwU2xpY2UgPSBwYXJzZWQuc2xpY2VzLmZpbmQoKHM6IHsgaWQ6IHN0cmluZyB9KSA9PiBzLmlkID09PSBzbGljZS5pZCk7XG4gICAgICAgICAgaWYgKCFyb2FkbWFwU2xpY2UpIGNvbnRpbnVlO1xuXG4gICAgICAgICAgaWYgKGlzQ29tcGxldGVJbkRiICYmICFyb2FkbWFwU2xpY2UuZG9uZSkge1xuICAgICAgICAgICAgc3RhbGUucHVzaCh7XG4gICAgICAgICAgICAgIHBhdGg6IHJvYWRtYXBQYXRoLFxuICAgICAgICAgICAgICByZWFzb246IGAke3NsaWNlLmlkfSBpcyBjbG9zZWQgaW4gREIgYnV0IHVuY2hlY2tlZCBpbiByb2FkbWFwYCxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH0gZWxzZSBpZiAoIWlzQ29tcGxldGVJbkRiICYmIHJvYWRtYXBTbGljZS5kb25lKSB7XG4gICAgICAgICAgICBzdGFsZS5wdXNoKHtcbiAgICAgICAgICAgICAgcGF0aDogcm9hZG1hcFBhdGgsXG4gICAgICAgICAgICAgIHJlYXNvbjogYCR7c2xpY2UuaWR9IGlzIG5vdCBjbG9zZWQgaW4gREIgYnV0IGNoZWNrZWQgaW4gcm9hZG1hcGAsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgbG9nV2FybmluZyhcInJlbmRlcmVyXCIsIGByb2FkbWFwIHBhcnNlIGZhaWxlZDogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBcdTI1MDBcdTI1MDAgQ2hlY2sgcGxhbiBjaGVja2JveCBzdGF0ZSBhbmQgc3VtbWFyaWVzIGZvciBlYWNoIHNsaWNlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgIGZvciAoY29uc3Qgc2xpY2Ugb2Ygc2xpY2VzKSB7XG4gICAgICBjb25zdCB0YXNrcyA9IGdldFNsaWNlVGFza3MobWlsZXN0b25lLmlkLCBzbGljZS5pZCk7XG5cbiAgICAgIC8vIENoZWNrIHBsYW4gY2hlY2tib3hlc1xuICAgICAgY29uc3QgcGxhblBhdGggPSByZXNvbHZlU2xpY2VGaWxlKGJhc2VQYXRoLCBtaWxlc3RvbmUuaWQsIHNsaWNlLmlkLCBcIlBMQU5cIik7XG4gICAgICBpZiAocGxhblBhdGggJiYgZXhpc3RzU3luYyhwbGFuUGF0aCkpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBjb250ZW50ID0gcmVhZEZpbGVTeW5jKHBsYW5QYXRoLCBcInV0Zi04XCIpO1xuICAgICAgICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlUGxhbihjb250ZW50KTtcblxuICAgICAgICAgIGZvciAoY29uc3QgdGFzayBvZiB0YXNrcykge1xuICAgICAgICAgICAgY29uc3QgaXNEb25lSW5EYiA9IGlzQ2xvc2VkU3RhdHVzKHRhc2suc3RhdHVzKTtcbiAgICAgICAgICAgIGNvbnN0IHBsYW5UYXNrID0gcGFyc2VkLnRhc2tzLmZpbmQoKHQ6IHsgaWQ6IHN0cmluZyB9KSA9PiB0LmlkID09PSB0YXNrLmlkKTtcbiAgICAgICAgICAgIGlmICghcGxhblRhc2spIGNvbnRpbnVlO1xuXG4gICAgICAgICAgICBpZiAoaXNEb25lSW5EYiAmJiAhcGxhblRhc2suZG9uZSkge1xuICAgICAgICAgICAgICBzdGFsZS5wdXNoKHtcbiAgICAgICAgICAgICAgICBwYXRoOiBwbGFuUGF0aCxcbiAgICAgICAgICAgICAgICByZWFzb246IGAke3Rhc2suaWR9IGlzIGRvbmUgaW4gREIgYnV0IHVuY2hlY2tlZCBpbiBwbGFuYCxcbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKCFpc0RvbmVJbkRiICYmIHBsYW5UYXNrLmRvbmUpIHtcbiAgICAgICAgICAgICAgc3RhbGUucHVzaCh7XG4gICAgICAgICAgICAgICAgcGF0aDogcGxhblBhdGgsXG4gICAgICAgICAgICAgICAgcmVhc29uOiBgJHt0YXNrLmlkfSBpcyBub3QgZG9uZSBpbiBEQiBidXQgY2hlY2tlZCBpbiBwbGFuYCxcbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgbG9nV2FybmluZyhcInJlbmRlcmVyXCIsIGBwbGFuIHBhcnNlIGZhaWxlZDogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBDaGVjayBtaXNzaW5nIHRhc2sgc3VtbWFyeSBmaWxlc1xuICAgICAgZm9yIChjb25zdCB0YXNrIG9mIHRhc2tzKSB7XG4gICAgICAgIGlmIChpc0Nsb3NlZFN0YXR1cyh0YXNrLnN0YXR1cykgJiYgdGFzay5mdWxsX3N1bW1hcnlfbWQpIHtcbiAgICAgICAgICBjb25zdCBzbGljZVBhdGggPSByZXNvbHZlU2xpY2VQYXRoKGJhc2VQYXRoLCBtaWxlc3RvbmUuaWQsIHNsaWNlLmlkKTtcbiAgICAgICAgICBpZiAoc2xpY2VQYXRoKSB7XG4gICAgICAgICAgICBjb25zdCB0YXNrc0RpciA9IGpvaW4oc2xpY2VQYXRoLCBcInRhc2tzXCIpO1xuICAgICAgICAgICAgY29uc3QgZmlsZU5hbWUgPSBidWlsZFRhc2tGaWxlTmFtZSh0YXNrLmlkLCBcIlNVTU1BUllcIik7XG4gICAgICAgICAgICBjb25zdCBzdW1tYXJ5QWJzUGF0aCA9IGpvaW4odGFza3NEaXIsIGZpbGVOYW1lKTtcblxuICAgICAgICAgICAgaWYgKCFleGlzdHNTeW5jKHN1bW1hcnlBYnNQYXRoKSkge1xuICAgICAgICAgICAgICBzdGFsZS5wdXNoKHtcbiAgICAgICAgICAgICAgICBwYXRoOiBzdW1tYXJ5QWJzUGF0aCxcbiAgICAgICAgICAgICAgICByZWFzb246IGAke3Rhc2suaWR9IGlzIGNvbXBsZXRlIHdpdGggc3VtbWFyeSBpbiBEQiBidXQgU1VNTUFSWS5tZCBtaXNzaW5nIG9uIGRpc2tgLFxuICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gQ2hlY2sgbWlzc2luZyBzbGljZSBzdW1tYXJ5L1VBVCBmaWxlc1xuICAgICAgY29uc3Qgc2xpY2VSb3cgPSBnZXRTbGljZShtaWxlc3RvbmUuaWQsIHNsaWNlLmlkKTtcbiAgICAgIGlmIChzbGljZVJvdyAmJiBzbGljZVJvdy5zdGF0dXMgPT09IFwiY29tcGxldGVcIikge1xuICAgICAgICBjb25zdCBzbGljZVBhdGggPSByZXNvbHZlU2xpY2VQYXRoKGJhc2VQYXRoLCBtaWxlc3RvbmUuaWQsIHNsaWNlLmlkKTtcbiAgICAgICAgaWYgKHNsaWNlUGF0aCkge1xuICAgICAgICAgIGlmIChzbGljZVJvdy5mdWxsX3N1bW1hcnlfbWQpIHtcbiAgICAgICAgICAgIGNvbnN0IHN1bW1hcnlOYW1lID0gYnVpbGRTbGljZUZpbGVOYW1lKHNsaWNlLmlkLCBcIlNVTU1BUllcIik7XG4gICAgICAgICAgICBjb25zdCBzdW1tYXJ5QWJzUGF0aCA9IGpvaW4oc2xpY2VQYXRoLCBzdW1tYXJ5TmFtZSk7XG4gICAgICAgICAgICBpZiAoIWV4aXN0c1N5bmMoc3VtbWFyeUFic1BhdGgpKSB7XG4gICAgICAgICAgICAgIHN0YWxlLnB1c2goe1xuICAgICAgICAgICAgICAgIHBhdGg6IHN1bW1hcnlBYnNQYXRoLFxuICAgICAgICAgICAgICAgIHJlYXNvbjogYCR7c2xpY2UuaWR9IGlzIGNvbXBsZXRlIHdpdGggc3VtbWFyeSBpbiBEQiBidXQgU1VNTUFSWS5tZCBtaXNzaW5nIG9uIGRpc2tgLFxuICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG5cbiAgICAgICAgICBpZiAoc2xpY2VSb3cuZnVsbF91YXRfbWQpIHtcbiAgICAgICAgICAgIGNvbnN0IHVhdE5hbWUgPSBidWlsZFNsaWNlRmlsZU5hbWUoc2xpY2UuaWQsIFwiVUFUXCIpO1xuICAgICAgICAgICAgY29uc3QgdWF0QWJzUGF0aCA9IGpvaW4oc2xpY2VQYXRoLCB1YXROYW1lKTtcbiAgICAgICAgICAgIGlmICghZXhpc3RzU3luYyh1YXRBYnNQYXRoKSkge1xuICAgICAgICAgICAgICBzdGFsZS5wdXNoKHtcbiAgICAgICAgICAgICAgICBwYXRoOiB1YXRBYnNQYXRoLFxuICAgICAgICAgICAgICAgIHJlYXNvbjogYCR7c2xpY2UuaWR9IGlzIGNvbXBsZXRlIHdpdGggVUFUIGluIERCIGJ1dCBVQVQubWQgbWlzc2luZyBvbiBkaXNrYCxcbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgaWYgKHN0YWxlLmxlbmd0aCA+IDApIHtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgIGBtYXJrZG93bi1yZW5kZXJlcjogZGV0ZWN0ZWQgJHtzdGFsZS5sZW5ndGh9IHN0YWxlIHJlbmRlcihzKTpcXG5gLFxuICAgICk7XG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiBzdGFsZSkge1xuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYCAgLSAke2VudHJ5LnBhdGh9OiAke2VudHJ5LnJlYXNvbn1cXG5gKTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gc3RhbGU7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTdGFsZSBSZXBhaXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4vLyBCb2R5IHJlbG9jYXRlZCB0byBzdGF0ZS1yZWNvbmNpbGlhdGlvbi9kcmlmdC9zdGFsZS1yZW5kZXIudHMgKEFEUi0wMTcgIzU3MDIpLlxuLy8gZGV0ZWN0U3RhbGVSZW5kZXJzIGFib3ZlIHN0YXlzIGFzIGEgdXNlZnVsIGRpYWdub3N0aWMgcHJpbWl0aXZlOyB0aGVcbi8vIGRyaWZ0IGhhbmRsZXIgY29tcG9zZXMgaXQgd2l0aCB0aGUgcGVyLXJlYXNvbiByZW5kZXJlciBkaXNwYXRjaCBhbmQgdGhlXG4vLyByZWNvbmNpbGVCZWZvcmVEaXNwYXRjaCBsaWZlY3ljbGUuXG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBSZXBsYW4gJiBBc3Nlc3NtZW50IFJlbmRlcmVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGludGVyZmFjZSBSZXBsYW5EYXRhIHtcbiAgYmxvY2tlclRhc2tJZDogc3RyaW5nO1xuICBibG9ja2VyRGVzY3JpcHRpb246IHN0cmluZztcbiAgd2hhdENoYW5nZWQ6IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBc3Nlc3NtZW50RGF0YSB7XG4gIHZlcmRpY3Q6IHN0cmluZztcbiAgYXNzZXNzbWVudDogc3RyaW5nO1xuICBjb21wbGV0ZWRTbGljZUlkPzogc3RyaW5nO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVuZGVyUmVwbGFuRnJvbURiKFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICBtaWxlc3RvbmVJZDogc3RyaW5nLFxuICBzbGljZUlkOiBzdHJpbmcsXG4gIHJlcGxhbkRhdGE6IFJlcGxhbkRhdGEsXG4pOiBQcm9taXNlPHsgcmVwbGFuUGF0aDogc3RyaW5nOyBjb250ZW50OiBzdHJpbmcgfT4ge1xuICBjb25zdCBzbGljZVBhdGggPSByZXNvbHZlU2xpY2VQYXRoKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgc2xpY2VJZClcbiAgICA/PyBqb2luKGdzZFJvb3QoYmFzZVBhdGgpLCBcIm1pbGVzdG9uZXNcIiwgbWlsZXN0b25lSWQsIFwic2xpY2VzXCIsIHNsaWNlSWQpO1xuICBjb25zdCBhYnNQYXRoID0gam9pbihzbGljZVBhdGgsIGAke3NsaWNlSWR9LVJFUExBTi5tZGApO1xuICBjb25zdCBhcnRpZmFjdFBhdGggPSB0b0FydGlmYWN0UGF0aChhYnNQYXRoLCBiYXNlUGF0aCk7XG5cbiAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG4gIGxpbmVzLnB1c2goYCMgJHtzbGljZUlkfSBSZXBsYW5gKTtcbiAgbGluZXMucHVzaChcIlwiKTtcbiAgbGluZXMucHVzaChgKipNaWxlc3RvbmU6KiogJHttaWxlc3RvbmVJZH1gKTtcbiAgbGluZXMucHVzaChgKipTbGljZToqKiAke3NsaWNlSWR9YCk7XG4gIGxpbmVzLnB1c2goYCoqQmxvY2tlciBUYXNrOioqICR7cmVwbGFuRGF0YS5ibG9ja2VyVGFza0lkfWApO1xuICBsaW5lcy5wdXNoKGAqKkNyZWF0ZWQ6KiogJHtuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCl9YCk7XG4gIGxpbmVzLnB1c2goXCJcIik7XG4gIGxpbmVzLnB1c2goXCIjIyBCbG9ja2VyIERlc2NyaXB0aW9uXCIpO1xuICBsaW5lcy5wdXNoKFwiXCIpO1xuICBsaW5lcy5wdXNoKHJlcGxhbkRhdGEuYmxvY2tlckRlc2NyaXB0aW9uKTtcbiAgbGluZXMucHVzaChcIlwiKTtcbiAgbGluZXMucHVzaChcIiMjIFdoYXQgQ2hhbmdlZFwiKTtcbiAgbGluZXMucHVzaChcIlwiKTtcbiAgbGluZXMucHVzaChyZXBsYW5EYXRhLndoYXRDaGFuZ2VkKTtcbiAgbGluZXMucHVzaChcIlwiKTtcblxuICBjb25zdCBjb250ZW50ID0gYCR7bGluZXMuam9pbihcIlxcblwiKS50cmltRW5kKCl9XFxuYDtcblxuICBhd2FpdCB3cml0ZUFuZFN0b3JlKGFic1BhdGgsIGFydGlmYWN0UGF0aCwgY29udGVudCwge1xuICAgIGFydGlmYWN0X3R5cGU6IFwiUkVQTEFOXCIsXG4gICAgbWlsZXN0b25lX2lkOiBtaWxlc3RvbmVJZCxcbiAgICBzbGljZV9pZDogc2xpY2VJZCxcbiAgfSk7XG5cbiAgcmV0dXJuIHsgcmVwbGFuUGF0aDogYWJzUGF0aCwgY29udGVudCB9O1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVuZGVyQXNzZXNzbWVudEZyb21EYihcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgbWlsZXN0b25lSWQ6IHN0cmluZyxcbiAgc2xpY2VJZDogc3RyaW5nLFxuICBhc3Nlc3NtZW50RGF0YTogQXNzZXNzbWVudERhdGEsXG4pOiBQcm9taXNlPHsgYXNzZXNzbWVudFBhdGg6IHN0cmluZzsgY29udGVudDogc3RyaW5nIH0+IHtcbiAgY29uc3Qgc2xpY2VQYXRoID0gcmVzb2x2ZVNsaWNlUGF0aChiYXNlUGF0aCwgbWlsZXN0b25lSWQsIHNsaWNlSWQpXG4gICAgPz8gam9pbihnc2RSb290KGJhc2VQYXRoKSwgXCJtaWxlc3RvbmVzXCIsIG1pbGVzdG9uZUlkLCBcInNsaWNlc1wiLCBzbGljZUlkKTtcbiAgY29uc3QgYWJzUGF0aCA9IGpvaW4oc2xpY2VQYXRoLCBgJHtzbGljZUlkfS1BU1NFU1NNRU5ULm1kYCk7XG4gIGNvbnN0IGFydGlmYWN0UGF0aCA9IHRvQXJ0aWZhY3RQYXRoKGFic1BhdGgsIGJhc2VQYXRoKTtcblxuICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcbiAgbGluZXMucHVzaChgIyAke3NsaWNlSWR9IEFzc2Vzc21lbnRgKTtcbiAgbGluZXMucHVzaChcIlwiKTtcbiAgbGluZXMucHVzaChgKipNaWxlc3RvbmU6KiogJHttaWxlc3RvbmVJZH1gKTtcbiAgbGluZXMucHVzaChgKipTbGljZToqKiAke3NsaWNlSWR9YCk7XG4gIGlmIChhc3Nlc3NtZW50RGF0YS5jb21wbGV0ZWRTbGljZUlkKSB7XG4gICAgbGluZXMucHVzaChgKipDb21wbGV0ZWQgU2xpY2U6KiogJHthc3Nlc3NtZW50RGF0YS5jb21wbGV0ZWRTbGljZUlkfWApO1xuICB9XG4gIGxpbmVzLnB1c2goYCoqVmVyZGljdDoqKiAke2Fzc2Vzc21lbnREYXRhLnZlcmRpY3R9YCk7XG4gIGxpbmVzLnB1c2goYCoqQ3JlYXRlZDoqKiAke25ldyBEYXRlKCkudG9JU09TdHJpbmcoKX1gKTtcbiAgbGluZXMucHVzaChcIlwiKTtcbiAgbGluZXMucHVzaChcIiMjIEFzc2Vzc21lbnRcIik7XG4gIGxpbmVzLnB1c2goXCJcIik7XG4gIGxpbmVzLnB1c2goYXNzZXNzbWVudERhdGEuYXNzZXNzbWVudCk7XG4gIGxpbmVzLnB1c2goXCJcIik7XG5cbiAgY29uc3QgY29udGVudCA9IGAke2xpbmVzLmpvaW4oXCJcXG5cIikudHJpbUVuZCgpfVxcbmA7XG5cbiAgYXdhaXQgd3JpdGVBbmRTdG9yZShhYnNQYXRoLCBhcnRpZmFjdFBhdGgsIGNvbnRlbnQsIHtcbiAgICBhcnRpZmFjdF90eXBlOiBcIkFTU0VTU01FTlRcIixcbiAgICBtaWxlc3RvbmVfaWQ6IG1pbGVzdG9uZUlkLFxuICAgIHNsaWNlX2lkOiBzbGljZUlkLFxuICB9KTtcblxuICByZXR1cm4geyBhc3Nlc3NtZW50UGF0aDogYWJzUGF0aCwgY29udGVudCB9O1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBV0EsU0FBUyxjQUFjLFlBQVksaUJBQWlCO0FBQ3BELFNBQVMsa0JBQWtCO0FBQzNCLFNBQVMs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
