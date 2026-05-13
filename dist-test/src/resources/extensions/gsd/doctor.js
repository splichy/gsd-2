import { existsSync, mkdirSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadFile, parseSummary, saveFile, parseTaskPlanMustHaves, countMustHavesMentionedInSummary } from "./files.js";
import { parseRoadmap as parseLegacyRoadmap, parsePlan as parseLegacyPlan } from "./parsers-legacy.js";
import { isDbAvailable, openDatabase, getMilestoneSlices, getSliceTasks } from "./gsd-db.js";
import { resolveMilestoneFile, resolveMilestonePath, resolveSliceFile, resolveSlicePath, resolveTaskFile, resolveTasksDir, milestonesDir, gsdRoot, relMilestoneFile, relSliceFile, relTaskFile, relSlicePath, relGsdRootFile, resolveGsdRootFile, relMilestonePath, resolveGsdPathContract } from "./paths.js";
import { deriveState, isMilestoneComplete } from "./state.js";
import { invalidateAllCaches } from "./cache.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { isClosedStatus } from "./status-guards.js";
import { GLOBAL_STATE_CODES } from "./doctor-types.js";
import { checkGitHealth, checkRuntimeHealth, checkGlobalHealth, checkEngineHealth } from "./doctor-checks.js";
import { checkEnvironmentHealth } from "./doctor-environment.js";
import { runProviderChecks } from "./doctor-providers.js";
import { validateTitle } from "./validation.js";
import { summarizeDoctorIssues, filterDoctorIssues, formatDoctorReport, formatDoctorIssuesForPrompt, formatDoctorReportJson } from "./doctor-format.js";
import { runEnvironmentChecks, runFullEnvironmentChecks, formatEnvironmentReport } from "./doctor-environment.js";
import { computeProgressScore, computeProgressScoreWithContext, formatProgressLine, formatProgressReport } from "./progress-score.js";
import { validateTitle as validateTitle2 } from "./validation.js";
function validatePreferenceShape(preferences) {
  const issues = [];
  const listFields = ["always_use_skills", "prefer_skills", "avoid_skills", "custom_instructions"];
  for (const field of listFields) {
    const value = preferences[field];
    if (value !== void 0 && !Array.isArray(value)) {
      issues.push(`${field} must be a list`);
    }
  }
  if (preferences.skill_rules !== void 0) {
    if (!Array.isArray(preferences.skill_rules)) {
      issues.push("skill_rules must be a list");
    } else {
      for (const [index, rule] of preferences.skill_rules.entries()) {
        if (!rule || typeof rule !== "object") {
          issues.push(`skill_rules[${index}] must be an object`);
          continue;
        }
        if (typeof rule.when !== "string") {
          issues.push(`skill_rules[${index}].when must be a string`);
        }
        for (const key of ["use", "prefer", "avoid"]) {
          const value = rule[key];
          if (value !== void 0 && !Array.isArray(value)) {
            issues.push(`skill_rules[${index}].${key} must be a list`);
          }
        }
      }
    }
  }
  return issues;
}
function buildStateMarkdown(state) {
  const lines = [];
  lines.push("# GSD State", "");
  const activeMilestone = state.activeMilestone ? `${state.activeMilestone.id}: ${state.activeMilestone.title}` : "None";
  const activeSlice = state.activeSlice ? `${state.activeSlice.id}: ${state.activeSlice.title}` : "None";
  lines.push(`**Active Milestone:** ${activeMilestone}`);
  lines.push(`**Active Slice:** ${activeSlice}`);
  lines.push(`**Phase:** ${state.phase}`);
  if (state.requirements) {
    lines.push(`**Requirements Status:** ${state.requirements.active} active \xB7 ${state.requirements.validated} validated \xB7 ${state.requirements.deferred} deferred \xB7 ${state.requirements.outOfScope} out of scope`);
  }
  lines.push("");
  lines.push("## Milestone Registry");
  for (const entry of state.registry) {
    const glyph = entry.status === "complete" ? "\u2705" : entry.status === "active" ? "\u{1F504}" : entry.status === "parked" ? "\u23F8\uFE0F" : "\u2B1C";
    lines.push(`- ${glyph} **${entry.id}:** ${entry.title}`);
  }
  lines.push("");
  lines.push("## Recent Decisions");
  if (state.recentDecisions.length > 0) {
    for (const decision of state.recentDecisions) lines.push(`- ${decision}`);
  } else {
    lines.push("- None recorded");
  }
  lines.push("");
  lines.push("## Blockers");
  if (state.blockers.length > 0) {
    for (const blocker of state.blockers) lines.push(`- ${blocker}`);
  } else {
    lines.push("- None");
  }
  lines.push("");
  lines.push("## Next Action");
  lines.push(state.nextAction || "None");
  lines.push("");
  return lines.join("\n");
}
async function updateStateFile(basePath, fixesApplied) {
  const state = await deriveState(basePath);
  const path = resolveGsdRootFile(basePath, "STATE");
  await saveFile(path, buildStateMarkdown(state));
  fixesApplied.push(`updated ${path}`);
}
async function rebuildState(basePath) {
  invalidateAllCaches();
  const state = await deriveState(basePath);
  const path = resolveGsdRootFile(basePath, "STATE");
  await saveFile(path, buildStateMarkdown(state));
}
function matchesScope(unitId, scope) {
  if (!scope) return true;
  return unitId === scope || unitId.startsWith(`${scope}/`);
}
function auditRequirements(content) {
  if (!content) return [];
  const issues = [];
  const blocks = content.split(/^###\s+/m).slice(1);
  for (const block of blocks) {
    const idMatch = block.match(/^(R\d+)/);
    if (!idMatch) continue;
    const requirementId = idMatch[1];
    const status = block.match(/^-\s+Status:\s+(.+)$/m)?.[1]?.trim().toLowerCase() ?? "";
    const owner = block.match(/^-\s+Primary owning slice:\s+(.+)$/m)?.[1]?.trim().toLowerCase() ?? "";
    const notes = block.match(/^-\s+Notes:\s+(.+)$/m)?.[1]?.trim().toLowerCase() ?? "";
    if (status === "active" && (!owner || owner === "none" || owner === "none yet")) {
      issues.push({
        severity: "warning",
        code: "active_requirement_missing_owner",
        scope: "project",
        unitId: requirementId,
        message: `${requirementId} is Active but has no primary owning slice`,
        file: relGsdRootFile("REQUIREMENTS"),
        fixable: false
      });
    }
    if (status === "blocked" && !notes) {
      issues.push({
        severity: "warning",
        code: "blocked_requirement_missing_reason",
        scope: "project",
        unitId: requirementId,
        message: `${requirementId} is Blocked but has no reason in Notes`,
        file: relGsdRootFile("REQUIREMENTS"),
        fixable: false
      });
    }
  }
  return issues;
}
async function selectDoctorScope(basePath, requestedScope) {
  if (requestedScope) return requestedScope;
  const state = await deriveState(basePath);
  if (state.activeMilestone?.id && state.activeSlice?.id) {
    return `${state.activeMilestone.id}/${state.activeSlice.id}`;
  }
  if (state.activeMilestone?.id) {
    return state.activeMilestone.id;
  }
  const milestonesPath = milestonesDir(basePath);
  if (!existsSync(milestonesPath)) return void 0;
  for (const milestone of state.registry) {
    const roadmapPath = resolveMilestoneFile(basePath, milestone.id, "ROADMAP");
    const roadmapContent = roadmapPath ? await loadFile(roadmapPath) : null;
    if (!roadmapContent) continue;
    if (isDbAvailable()) {
      const dbSlices = getMilestoneSlices(milestone.id);
      const allDone = dbSlices.length > 0 && dbSlices.every((s) => s.status === "complete");
      if (!allDone) return milestone.id;
    } else {
      const roadmap = parseLegacyRoadmap(roadmapContent);
      if (!isMilestoneComplete(roadmap)) return milestone.id;
    }
  }
  return state.registry[0]?.id;
}
function detectCircularDependencies(slices) {
  const known = new Set(slices.map((s) => s.id));
  const adj = /* @__PURE__ */ new Map();
  for (const s of slices) adj.set(s.id, s.depends.filter((d) => known.has(d)));
  const state = /* @__PURE__ */ new Map();
  for (const s of slices) state.set(s.id, "unvisited");
  const cycles = [];
  function dfs(id, path) {
    const st = state.get(id);
    if (st === "done") return;
    if (st === "visiting") {
      cycles.push([...path.slice(path.indexOf(id)), id]);
      return;
    }
    state.set(id, "visiting");
    for (const dep of adj.get(id) ?? []) dfs(dep, [...path, id]);
    state.set(id, "done");
  }
  for (const s of slices) if (state.get(s.id) === "unvisited") dfs(s.id, []);
  return cycles;
}
async function appendDoctorHistory(basePath, report) {
  try {
    const historyPath = join(gsdRoot(basePath), "doctor-history.jsonl");
    const errorCount = report.issues.filter((i) => i.severity === "error").length;
    const warningCount = report.issues.filter((i) => i.severity === "warning").length;
    const issueDetails = report.issues.filter((i) => i.severity === "error" || i.severity === "warning").slice(0, 10).map((i) => ({ severity: i.severity, code: i.code, message: i.message, unitId: i.unitId }));
    const summaryParts = [];
    if (report.ok) {
      summaryParts.push("Clean");
    } else {
      const counts = [];
      if (errorCount > 0) counts.push(`${errorCount} error${errorCount > 1 ? "s" : ""}`);
      if (warningCount > 0) counts.push(`${warningCount} warning${warningCount > 1 ? "s" : ""}`);
      summaryParts.push(counts.join(", "));
    }
    if (report.fixesApplied.length > 0) {
      summaryParts.push(`${report.fixesApplied.length} fixed`);
    }
    if (issueDetails.length > 0) {
      const topIssue = issueDetails.find((i) => i.severity === "error") ?? issueDetails[0];
      summaryParts.push(topIssue.message);
    }
    const entry = JSON.stringify({
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      ok: report.ok,
      errors: errorCount,
      warnings: warningCount,
      fixes: report.fixesApplied.length,
      codes: [...new Set(report.issues.map((i) => i.code))],
      issues: issueDetails.length > 0 ? issueDetails : void 0,
      fixDescriptions: report.fixesApplied.length > 0 ? report.fixesApplied : void 0,
      scope: report.scope,
      summary: summaryParts.join(" \xB7 ")
    });
    const existing = existsSync(historyPath) ? readFileSync(historyPath, "utf-8") : "";
    await saveFile(historyPath, existing + entry + "\n");
  } catch {
  }
}
async function readDoctorHistory(basePath, lastN = 50) {
  try {
    const historyPath = join(gsdRoot(basePath), "doctor-history.jsonl");
    if (!existsSync(historyPath)) return [];
    const lines = readFileSync(historyPath, "utf-8").split("\n").filter((l) => l.trim());
    return lines.slice(-lastN).reverse().map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
async function runGSDDoctor(basePath, options) {
  const issues = [];
  const fixesApplied = [];
  const fix = options?.fix === true;
  const dryRun = options?.dryRun === true;
  const fixLevel = options?.fixLevel ?? "all";
  const dbPath = resolveGsdPathContract(basePath).projectDb;
  if (existsSync(dbPath)) {
    try {
      openDatabase(dbPath);
    } catch {
    }
  }
  const shouldFix = (code) => {
    if (!fix || dryRun) return false;
    if (fixLevel === "task" && GLOBAL_STATE_CODES.has(code)) return false;
    return true;
  };
  const prefs = loadEffectiveGSDPreferences();
  if (prefs) {
    const prefIssues = validatePreferenceShape(prefs.preferences);
    for (const issue of prefIssues) {
      issues.push({
        severity: "warning",
        code: "invalid_preferences",
        scope: "project",
        unitId: "project",
        message: `GSD preferences invalid: ${issue}`,
        file: prefs.path,
        fixable: false
      });
    }
  }
  const t0git = Date.now();
  const isolationMode = options?.isolationMode ?? (prefs?.preferences?.git?.isolation === "worktree" ? "worktree" : prefs?.preferences?.git?.isolation === "branch" ? "branch" : "none");
  await checkGitHealth(basePath, issues, fixesApplied, shouldFix, isolationMode);
  const gitMs = Date.now() - t0git;
  const t0runtime = Date.now();
  await checkRuntimeHealth(basePath, issues, fixesApplied, shouldFix);
  const runtimeMs = Date.now() - t0runtime;
  await checkGlobalHealth(issues, fixesApplied, shouldFix);
  const t0env = Date.now();
  await checkEnvironmentHealth(basePath, issues, {
    includeRemote: !options?.scope,
    includeBuild: options?.includeBuild,
    includeTests: options?.includeTests
  });
  const envMs = Date.now() - t0env;
  await checkEngineHealth(basePath, issues, fixesApplied);
  const milestonesPath = milestonesDir(basePath);
  if (!existsSync(milestonesPath)) {
    const report2 = { ok: issues.every((i) => i.severity !== "error"), basePath, issues, fixesApplied, timing: { git: gitMs, runtime: runtimeMs, environment: envMs, gsdState: 0 } };
    await appendDoctorHistory(basePath, report2);
    return report2;
  }
  const requirementsPath = resolveGsdRootFile(basePath, "REQUIREMENTS");
  const requirementsContent = await loadFile(requirementsPath);
  issues.push(...auditRequirements(requirementsContent));
  const state = await deriveState(basePath);
  if (state.activeMilestone) {
    try {
      const providerResults = runProviderChecks();
      for (const result of providerResults) {
        if (!result.required) continue;
        if (result.status === "error") {
          issues.push({
            severity: "warning",
            code: "provider_key_missing",
            scope: "project",
            unitId: "project",
            message: result.message + (result.detail ? ` \u2014 ${result.detail}` : ""),
            fixable: false
          });
        } else if (result.status === "warning") {
          issues.push({
            severity: "warning",
            code: "provider_key_backedoff",
            scope: "project",
            unitId: "project",
            message: result.message + (result.detail ? ` \u2014 ${result.detail}` : ""),
            fixable: false
          });
        }
      }
    } catch {
    }
  }
  for (const milestone of state.registry) {
    const milestoneId = milestone.id;
    const milestonePath = resolveMilestonePath(basePath, milestoneId);
    if (!milestonePath) continue;
    const milestoneTitleIssue = validateTitle(milestone.title);
    if (milestoneTitleIssue) {
      const roadmapFile = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
      let wasFixed = false;
      if (shouldFix("delimiter_in_title") && roadmapFile) {
        try {
          const raw = readFileSync(roadmapFile, "utf-8");
          const sanitized = raw.replace(
            /^(# .*)$/m,
            (line) => line.replace(/[\u2014\u2013]/g, "-")
          );
          if (sanitized !== raw) {
            await saveFile(roadmapFile, sanitized);
            fixesApplied.push(`sanitized delimiter characters in ${milestoneId} title`);
            wasFixed = true;
          }
        } catch {
        }
      }
      if (!wasFixed) {
        issues.push({
          severity: "warning",
          code: "delimiter_in_title",
          scope: "milestone",
          unitId: milestoneId,
          message: `Milestone ${milestoneId} ${milestoneTitleIssue}. Rename the milestone to remove these characters to prevent state corruption.`,
          file: relMilestoneFile(basePath, milestoneId, "ROADMAP"),
          fixable: true
        });
      }
    }
    const roadmapPath = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
    const roadmapContent = roadmapPath ? await loadFile(roadmapPath) : null;
    if (!roadmapContent) continue;
    let slices;
    if (isDbAvailable()) {
      const dbSlices = getMilestoneSlices(milestoneId);
      slices = dbSlices.map((s) => ({
        id: s.id,
        title: s.title,
        done: isClosedStatus(s.status),
        pending: s.status === "pending",
        skipped: s.status === "skipped",
        risk: s.risk || "medium",
        depends: s.depends,
        demo: s.demo
      }));
    } else {
      const activeMilestoneId = state.activeMilestone?.id;
      const activeSliceId = state.activeSlice?.id;
      slices = parseLegacyRoadmap(roadmapContent).slices.map((s) => ({
        ...s,
        // Legacy roadmaps only encode done vs not-done. For doctor's
        // missing-directory checks, treat every undone slice except the
        // current active slice as effectively pending/unstarted.
        pending: !s.done && (milestoneId !== activeMilestoneId || s.id !== activeSliceId)
      }));
    }
    const roadmap = { slices };
    for (const cycle of detectCircularDependencies(roadmap.slices)) {
      issues.push({
        severity: "error",
        code: "circular_slice_dependency",
        scope: "milestone",
        unitId: milestoneId,
        message: `Circular dependency detected: ${cycle.join(" \u2192 ")}`,
        file: relMilestoneFile(basePath, milestoneId, "ROADMAP"),
        fixable: false
      });
    }
    try {
      const slicesDir = join(milestonePath, "slices");
      if (existsSync(slicesDir)) {
        const knownSliceIds = new Set(roadmap.slices.map((s) => s.id));
        for (const entry of readdirSync(slicesDir)) {
          try {
            if (!lstatSync(join(slicesDir, entry)).isDirectory()) continue;
          } catch {
            continue;
          }
          if (!knownSliceIds.has(entry)) {
            issues.push({
              severity: "warning",
              code: "orphaned_slice_directory",
              scope: "milestone",
              unitId: milestoneId,
              message: `Directory "${entry}" exists in ${milestoneId}/slices/ but is not referenced in the roadmap`,
              file: `${relMilestonePath(basePath, milestoneId)}/slices/${entry}`,
              fixable: false
            });
          }
        }
      }
    } catch {
    }
    for (const slice of roadmap.slices) {
      const unitId = `${milestoneId}/${slice.id}`;
      if (options?.scope && !matchesScope(unitId, options.scope) && options.scope !== milestoneId) continue;
      const sliceTitleIssue = validateTitle(slice.title);
      if (sliceTitleIssue) {
        issues.push({
          severity: "warning",
          code: "delimiter_in_title",
          scope: "slice",
          unitId,
          message: `Slice ${unitId} ${sliceTitleIssue}. Rename the slice to remove these characters to prevent state corruption.`,
          file: relMilestoneFile(basePath, milestoneId, "ROADMAP"),
          fixable: false
        });
      }
      const knownSliceIds = new Set(roadmap.slices.map((s) => s.id));
      for (const dep of slice.depends) {
        if (!knownSliceIds.has(dep)) {
          issues.push({
            severity: "warning",
            code: "unresolvable_dependency",
            scope: "slice",
            unitId,
            message: `Slice ${unitId} depends on "${dep}" which is not a slice ID in this roadmap. This permanently blocks the slice. Use comma-separated IDs: \`depends:[S01,S02]\``,
            file: relMilestoneFile(basePath, milestoneId, "ROADMAP"),
            fixable: false
          });
        }
      }
      const slicePath = resolveSlicePath(basePath, milestoneId, slice.id);
      if (!slicePath) {
        if (slice.pending || slice.skipped) continue;
        const expectedPath = relSlicePath(basePath, milestoneId, slice.id);
        issues.push({
          severity: slice.done ? "warning" : "error",
          code: "missing_slice_dir",
          scope: "slice",
          unitId,
          message: slice.done ? `Missing slice directory for ${unitId} (slice is complete \u2014 cosmetic only)` : `Missing slice directory for ${unitId}`,
          file: expectedPath,
          fixable: true
        });
        if (fix) {
          const absoluteSliceDir = join(milestonePath, "slices", slice.id);
          mkdirSync(absoluteSliceDir, { recursive: true });
          fixesApplied.push(`created ${absoluteSliceDir}`);
        }
        continue;
      }
      const tasksDir = resolveTasksDir(basePath, milestoneId, slice.id);
      if (!tasksDir) {
        if (slice.pending || slice.skipped) continue;
        issues.push({
          severity: slice.done ? "warning" : "error",
          code: "missing_tasks_dir",
          scope: "slice",
          unitId,
          message: slice.done ? `Missing tasks directory for ${unitId} (slice is complete \u2014 cosmetic only)` : `Missing tasks directory for ${unitId}`,
          file: relSlicePath(basePath, milestoneId, slice.id),
          fixable: true
        });
        if (fix) {
          mkdirSync(join(slicePath, "tasks"), { recursive: true });
          fixesApplied.push(`created ${join(slicePath, "tasks")}`);
        }
      }
      const planPath = resolveSliceFile(basePath, milestoneId, slice.id, "PLAN");
      const planContent = planPath ? await loadFile(planPath) : null;
      let plan = null;
      if (isDbAvailable()) {
        const dbTasks = getSliceTasks(milestoneId, slice.id);
        if (dbTasks.length > 0) {
          plan = { tasks: dbTasks.map((t) => ({ id: t.id, done: t.status === "complete" || t.status === "done", title: t.title, estimate: t.estimate || void 0 })) };
        }
      }
      if (!plan && planContent) {
        plan = parseLegacyPlan(planContent);
      }
      if (!plan) {
        if (!slice.done) {
          issues.push({
            severity: "warning",
            code: "missing_slice_plan",
            scope: "slice",
            unitId,
            message: `Slice ${unitId} has no plan file`,
            file: relSliceFile(basePath, milestoneId, slice.id, "PLAN"),
            fixable: false
          });
        }
        continue;
      }
      const taskIdCounts = /* @__PURE__ */ new Map();
      for (const task of plan.tasks) taskIdCounts.set(task.id, (taskIdCounts.get(task.id) ?? 0) + 1);
      for (const [taskId, count] of taskIdCounts) {
        if (count > 1) {
          issues.push({
            severity: "error",
            code: "duplicate_task_id",
            scope: "slice",
            unitId,
            message: `Task ID "${taskId}" appears ${count} times in ${slice.id}-PLAN.md \u2014 duplicate IDs cause dispatch failures`,
            file: relSliceFile(basePath, milestoneId, slice.id, "PLAN"),
            fixable: false
          });
        }
      }
      try {
        if (tasksDir) {
          const planTaskIds = new Set(plan.tasks.map((t) => t.id));
          for (const f of readdirSync(tasksDir)) {
            if (!f.endsWith("-SUMMARY.md")) continue;
            const diskTaskId = f.replace(/-SUMMARY\.md$/, "");
            if (!planTaskIds.has(diskTaskId)) {
              issues.push({
                severity: "info",
                code: "task_file_not_in_plan",
                scope: "slice",
                unitId,
                message: `Task summary "${f}" exists on disk but "${diskTaskId}" is not in ${slice.id}-PLAN.md`,
                file: relTaskFile(basePath, milestoneId, slice.id, diskTaskId, "SUMMARY"),
                fixable: false
              });
            }
          }
        }
      } catch {
      }
      let allTasksDone = plan.tasks.length > 0;
      for (const task of plan.tasks) {
        const taskUnitId = `${unitId}/${task.id}`;
        const summaryPath = resolveTaskFile(basePath, milestoneId, slice.id, task.id, "SUMMARY");
        const hasSummary = !!(summaryPath && await loadFile(summaryPath));
        if (task.done && hasSummary) {
          const taskPlanPath = resolveTaskFile(basePath, milestoneId, slice.id, task.id, "PLAN");
          if (taskPlanPath) {
            const taskPlanContent = await loadFile(taskPlanPath);
            if (taskPlanContent) {
              const mustHaves = parseTaskPlanMustHaves(taskPlanContent);
              if (mustHaves.length > 0) {
                const summaryContent = await loadFile(summaryPath);
                const mentionedCount = summaryContent ? countMustHavesMentionedInSummary(mustHaves, summaryContent) : 0;
                if (mentionedCount < mustHaves.length) {
                  issues.push({
                    severity: "warning",
                    code: "task_done_must_haves_not_verified",
                    scope: "task",
                    unitId: taskUnitId,
                    message: `Task ${task.id} has ${mustHaves.length} must-haves but summary addresses only ${mentionedCount}`,
                    file: relTaskFile(basePath, milestoneId, slice.id, task.id, "SUMMARY"),
                    fixable: false
                  });
                }
              }
            }
          }
        }
        if (task.done && hasSummary && summaryPath) {
          try {
            const rawSummary = await loadFile(summaryPath);
            const m = rawSummary?.match(/^completed_at:\s*(.+)$/m);
            if (m) {
              const ts = new Date(m[1].trim());
              if (!isNaN(ts.getTime()) && ts.getTime() > Date.now() + 24 * 60 * 60 * 1e3) {
                issues.push({
                  severity: "warning",
                  code: "future_timestamp",
                  scope: "task",
                  unitId: taskUnitId,
                  message: `Task ${task.id} has completed_at "${m[1].trim()}" which is more than 24h in the future`,
                  file: relTaskFile(basePath, milestoneId, slice.id, task.id, "SUMMARY"),
                  fixable: false
                });
              }
            }
          } catch {
          }
        }
        allTasksDone = allTasksDone && task.done;
      }
      const replanPath = resolveSliceFile(basePath, milestoneId, slice.id, "REPLAN");
      if (!replanPath && !allTasksDone) {
        for (const task of plan.tasks) {
          if (!task.done) continue;
          const summaryPath = resolveTaskFile(basePath, milestoneId, slice.id, task.id, "SUMMARY");
          if (!summaryPath) continue;
          const summaryContent = await loadFile(summaryPath);
          if (!summaryContent) continue;
          const summary = parseSummary(summaryContent);
          if (summary.frontmatter.blocker_discovered) {
            issues.push({
              severity: "warning",
              code: "blocker_discovered_no_replan",
              scope: "slice",
              unitId,
              message: `Task ${task.id} reported blocker_discovered but no REPLAN.md exists for ${slice.id} \u2014 slice may be stuck`,
              file: relSliceFile(basePath, milestoneId, slice.id, "REPLAN"),
              fixable: false
            });
            break;
          }
        }
      }
      if (replanPath && allTasksDone) {
        issues.push({
          severity: "info",
          code: "stale_replan_file",
          scope: "slice",
          unitId,
          message: `${slice.id} has a REPLAN.md but all tasks are done \u2014 REPLAN.md may be stale`,
          file: relSliceFile(basePath, milestoneId, slice.id, "REPLAN"),
          fixable: false
        });
      }
    }
    const milestoneComplete = roadmap.slices.length > 0 && roadmap.slices.every((s) => s.done);
    if (milestoneComplete && !resolveMilestoneFile(basePath, milestoneId, "VALIDATION") && !resolveMilestoneFile(basePath, milestoneId, "SUMMARY")) {
      issues.push({
        severity: "info",
        code: "all_slices_done_missing_milestone_validation",
        scope: "milestone",
        unitId: milestoneId,
        message: `All slices are done but ${milestoneId}-VALIDATION.md is missing \u2014 milestone is in validating-milestone phase`,
        file: relMilestoneFile(basePath, milestoneId, "VALIDATION"),
        fixable: false
      });
    }
    if (milestoneComplete && !resolveMilestoneFile(basePath, milestoneId, "SUMMARY")) {
      issues.push({
        severity: "warning",
        code: "all_slices_done_missing_milestone_summary",
        scope: "milestone",
        unitId: milestoneId,
        message: `All slices are done but ${milestoneId}-SUMMARY.md is missing \u2014 milestone is stuck in completing-milestone phase`,
        file: relMilestoneFile(basePath, milestoneId, "SUMMARY"),
        fixable: false
      });
    }
  }
  if (fix && !dryRun && fixesApplied.length > 0) {
    await updateStateFile(basePath, fixesApplied);
  }
  const report = {
    ok: issues.every((issue) => issue.severity !== "error"),
    basePath,
    issues,
    fixesApplied,
    timing: { git: gitMs, runtime: runtimeMs, environment: envMs, gsdState: Math.max(0, Date.now() - t0env - envMs) }
  };
  await appendDoctorHistory(basePath, report);
  return report;
}
export {
  buildStateMarkdown,
  computeProgressScore,
  computeProgressScoreWithContext,
  filterDoctorIssues,
  formatDoctorIssuesForPrompt,
  formatDoctorReport,
  formatDoctorReportJson,
  formatEnvironmentReport,
  formatProgressLine,
  formatProgressReport,
  readDoctorHistory,
  rebuildState,
  runEnvironmentChecks,
  runFullEnvironmentChecks,
  runGSDDoctor,
  selectDoctorScope,
  summarizeDoctorIssues,
  validateTitle2 as validateTitle
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9kb2N0b3IudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IGV4aXN0c1N5bmMsIG1rZGlyU3luYywgbHN0YXRTeW5jLCByZWFkZGlyU3luYywgcmVhZEZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbmltcG9ydCB7IGxvYWRGaWxlLCBwYXJzZVN1bW1hcnksIHNhdmVGaWxlLCBwYXJzZVRhc2tQbGFuTXVzdEhhdmVzLCBjb3VudE11c3RIYXZlc01lbnRpb25lZEluU3VtbWFyeSB9IGZyb20gXCIuL2ZpbGVzLmpzXCI7XG5pbXBvcnQgeyBwYXJzZVJvYWRtYXAgYXMgcGFyc2VMZWdhY3lSb2FkbWFwLCBwYXJzZVBsYW4gYXMgcGFyc2VMZWdhY3lQbGFuIH0gZnJvbSBcIi4vcGFyc2Vycy1sZWdhY3kuanNcIjtcbmltcG9ydCB7IGlzRGJBdmFpbGFibGUsIG9wZW5EYXRhYmFzZSwgZ2V0TWlsZXN0b25lU2xpY2VzLCBnZXRTbGljZVRhc2tzIH0gZnJvbSBcIi4vZ3NkLWRiLmpzXCI7XG5pbXBvcnQgeyByZXNvbHZlTWlsZXN0b25lRmlsZSwgcmVzb2x2ZU1pbGVzdG9uZVBhdGgsIHJlc29sdmVTbGljZUZpbGUsIHJlc29sdmVTbGljZVBhdGgsIHJlc29sdmVUYXNrRmlsZSwgcmVzb2x2ZVRhc2tzRGlyLCBtaWxlc3RvbmVzRGlyLCBnc2RSb290LCByZWxNaWxlc3RvbmVGaWxlLCByZWxTbGljZUZpbGUsIHJlbFRhc2tGaWxlLCByZWxTbGljZVBhdGgsIHJlbEdzZFJvb3RGaWxlLCByZXNvbHZlR3NkUm9vdEZpbGUsIHJlbE1pbGVzdG9uZVBhdGgsIHJlc29sdmVHc2RQYXRoQ29udHJhY3QgfSBmcm9tIFwiLi9wYXRocy5qc1wiO1xuaW1wb3J0IHsgZGVyaXZlU3RhdGUsIGlzTWlsZXN0b25lQ29tcGxldGUgfSBmcm9tIFwiLi9zdGF0ZS5qc1wiO1xuaW1wb3J0IHsgaW52YWxpZGF0ZUFsbENhY2hlcyB9IGZyb20gXCIuL2NhY2hlLmpzXCI7XG5pbXBvcnQgeyBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMsIHR5cGUgR1NEUHJlZmVyZW5jZXMgfSBmcm9tIFwiLi9wcmVmZXJlbmNlcy5qc1wiO1xuaW1wb3J0IHsgaXNDbG9zZWRTdGF0dXMgfSBmcm9tIFwiLi9zdGF0dXMtZ3VhcmRzLmpzXCI7XG5cbmltcG9ydCB0eXBlIHsgRG9jdG9ySXNzdWUsIERvY3Rvcklzc3VlQ29kZSwgRG9jdG9yUmVwb3J0IH0gZnJvbSBcIi4vZG9jdG9yLXR5cGVzLmpzXCI7XG5pbXBvcnQgeyBHTE9CQUxfU1RBVEVfQ09ERVMgfSBmcm9tIFwiLi9kb2N0b3ItdHlwZXMuanNcIjtcbmltcG9ydCB0eXBlIHsgUm9hZG1hcFNsaWNlRW50cnkgfSBmcm9tIFwiLi90eXBlcy5qc1wiO1xuaW1wb3J0IHsgY2hlY2tHaXRIZWFsdGgsIGNoZWNrUnVudGltZUhlYWx0aCwgY2hlY2tHbG9iYWxIZWFsdGgsIGNoZWNrRW5naW5lSGVhbHRoIH0gZnJvbSBcIi4vZG9jdG9yLWNoZWNrcy5qc1wiO1xuaW1wb3J0IHsgY2hlY2tFbnZpcm9ubWVudEhlYWx0aCB9IGZyb20gXCIuL2RvY3Rvci1lbnZpcm9ubWVudC5qc1wiO1xuaW1wb3J0IHsgcnVuUHJvdmlkZXJDaGVja3MgfSBmcm9tIFwiLi9kb2N0b3ItcHJvdmlkZXJzLmpzXCI7XG5pbXBvcnQgeyB2YWxpZGF0ZVRpdGxlIH0gZnJvbSBcIi4vdmFsaWRhdGlvbi5qc1wiO1xuXG4vLyBcdTI1MDBcdTI1MDAgUmUtZXhwb3J0cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbi8vIEFsbCBwdWJsaWMgdHlwZXMgYW5kIGZ1bmN0aW9ucyBmcm9tIGV4dHJhY3RlZCBtb2R1bGVzIGFyZSByZS1leHBvcnRlZCBoZXJlXG4vLyBzbyB0aGF0IGV4aXN0aW5nIGltcG9ydHMgZnJvbSBcIi4vZG9jdG9yLmpzXCIgY29udGludWUgdG8gd29yayB1bmNoYW5nZWQuXG5leHBvcnQgdHlwZSB7IERvY3RvclNldmVyaXR5LCBEb2N0b3JJc3N1ZUNvZGUsIERvY3Rvcklzc3VlLCBEb2N0b3JSZXBvcnQsIERvY3RvclN1bW1hcnkgfSBmcm9tIFwiLi9kb2N0b3ItdHlwZXMuanNcIjtcbmV4cG9ydCB7IHN1bW1hcml6ZURvY3Rvcklzc3VlcywgZmlsdGVyRG9jdG9ySXNzdWVzLCBmb3JtYXREb2N0b3JSZXBvcnQsIGZvcm1hdERvY3Rvcklzc3Vlc0ZvclByb21wdCwgZm9ybWF0RG9jdG9yUmVwb3J0SnNvbiB9IGZyb20gXCIuL2RvY3Rvci1mb3JtYXQuanNcIjtcbmV4cG9ydCB7IHJ1bkVudmlyb25tZW50Q2hlY2tzLCBydW5GdWxsRW52aXJvbm1lbnRDaGVja3MsIGZvcm1hdEVudmlyb25tZW50UmVwb3J0LCB0eXBlIEVudmlyb25tZW50Q2hlY2tSZXN1bHQgfSBmcm9tIFwiLi9kb2N0b3ItZW52aXJvbm1lbnQuanNcIjtcbmV4cG9ydCB7IGNvbXB1dGVQcm9ncmVzc1Njb3JlLCBjb21wdXRlUHJvZ3Jlc3NTY29yZVdpdGhDb250ZXh0LCBmb3JtYXRQcm9ncmVzc0xpbmUsIGZvcm1hdFByb2dyZXNzUmVwb3J0LCB0eXBlIFByb2dyZXNzU2NvcmUsIHR5cGUgUHJvZ3Jlc3NMZXZlbCB9IGZyb20gXCIuL3Byb2dyZXNzLXNjb3JlLmpzXCI7XG5cbmV4cG9ydCB7IHZhbGlkYXRlVGl0bGUgfSBmcm9tIFwiLi92YWxpZGF0aW9uLmpzXCI7XG5cbmZ1bmN0aW9uIHZhbGlkYXRlUHJlZmVyZW5jZVNoYXBlKHByZWZlcmVuY2VzOiBHU0RQcmVmZXJlbmNlcyk6IHN0cmluZ1tdIHtcbiAgY29uc3QgaXNzdWVzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBsaXN0RmllbGRzID0gW1wiYWx3YXlzX3VzZV9za2lsbHNcIiwgXCJwcmVmZXJfc2tpbGxzXCIsIFwiYXZvaWRfc2tpbGxzXCIsIFwiY3VzdG9tX2luc3RydWN0aW9uc1wiXSBhcyBjb25zdDtcbiAgZm9yIChjb25zdCBmaWVsZCBvZiBsaXN0RmllbGRzKSB7XG4gICAgY29uc3QgdmFsdWUgPSBwcmVmZXJlbmNlc1tmaWVsZF07XG4gICAgaWYgKHZhbHVlICE9PSB1bmRlZmluZWQgJiYgIUFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICBpc3N1ZXMucHVzaChgJHtmaWVsZH0gbXVzdCBiZSBhIGxpc3RgKTtcbiAgICB9XG4gIH1cblxuICBpZiAocHJlZmVyZW5jZXMuc2tpbGxfcnVsZXMgIT09IHVuZGVmaW5lZCkge1xuICAgIGlmICghQXJyYXkuaXNBcnJheShwcmVmZXJlbmNlcy5za2lsbF9ydWxlcykpIHtcbiAgICAgIGlzc3Vlcy5wdXNoKFwic2tpbGxfcnVsZXMgbXVzdCBiZSBhIGxpc3RcIik7XG4gICAgfSBlbHNlIHtcbiAgICAgIGZvciAoY29uc3QgW2luZGV4LCBydWxlXSBvZiBwcmVmZXJlbmNlcy5za2lsbF9ydWxlcy5lbnRyaWVzKCkpIHtcbiAgICAgICAgaWYgKCFydWxlIHx8IHR5cGVvZiBydWxlICE9PSBcIm9iamVjdFwiKSB7XG4gICAgICAgICAgaXNzdWVzLnB1c2goYHNraWxsX3J1bGVzWyR7aW5kZXh9XSBtdXN0IGJlIGFuIG9iamVjdGApO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmICh0eXBlb2YgcnVsZS53aGVuICE9PSBcInN0cmluZ1wiKSB7XG4gICAgICAgICAgaXNzdWVzLnB1c2goYHNraWxsX3J1bGVzWyR7aW5kZXh9XS53aGVuIG11c3QgYmUgYSBzdHJpbmdgKTtcbiAgICAgICAgfVxuICAgICAgICBmb3IgKGNvbnN0IGtleSBvZiBbXCJ1c2VcIiwgXCJwcmVmZXJcIiwgXCJhdm9pZFwiXSBhcyBjb25zdCkge1xuICAgICAgICAgIGNvbnN0IHZhbHVlID0gKHJ1bGUgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPilba2V5XTtcbiAgICAgICAgICBpZiAodmFsdWUgIT09IHVuZGVmaW5lZCAmJiAhQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGlzc3Vlcy5wdXNoKGBza2lsbF9ydWxlc1ske2luZGV4fV0uJHtrZXl9IG11c3QgYmUgYSBsaXN0YCk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGlzc3Vlcztcbn1cblxuLyoqIEJ1aWxkIFNUQVRFLm1kIGNvbnRlbnQgZnJvbSBkZXJpdmVkIHN0YXRlLiBFeHBvcnRlZCBmb3IgZ3VpZGVkLWZsb3cgcHJlLWRpc3BhdGNoIHJlYnVpbGQgKCMzNDc1KS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZFN0YXRlTWFya2Rvd24oc3RhdGU6IEF3YWl0ZWQ8UmV0dXJuVHlwZTx0eXBlb2YgZGVyaXZlU3RhdGU+Pik6IHN0cmluZyB7XG4gIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICBsaW5lcy5wdXNoKFwiIyBHU0QgU3RhdGVcIiwgXCJcIik7XG5cbiAgY29uc3QgYWN0aXZlTWlsZXN0b25lID0gc3RhdGUuYWN0aXZlTWlsZXN0b25lXG4gICAgPyBgJHtzdGF0ZS5hY3RpdmVNaWxlc3RvbmUuaWR9OiAke3N0YXRlLmFjdGl2ZU1pbGVzdG9uZS50aXRsZX1gXG4gICAgOiBcIk5vbmVcIjtcbiAgY29uc3QgYWN0aXZlU2xpY2UgPSBzdGF0ZS5hY3RpdmVTbGljZVxuICAgID8gYCR7c3RhdGUuYWN0aXZlU2xpY2UuaWR9OiAke3N0YXRlLmFjdGl2ZVNsaWNlLnRpdGxlfWBcbiAgICA6IFwiTm9uZVwiO1xuXG4gIGxpbmVzLnB1c2goYCoqQWN0aXZlIE1pbGVzdG9uZToqKiAke2FjdGl2ZU1pbGVzdG9uZX1gKTtcbiAgbGluZXMucHVzaChgKipBY3RpdmUgU2xpY2U6KiogJHthY3RpdmVTbGljZX1gKTtcbiAgbGluZXMucHVzaChgKipQaGFzZToqKiAke3N0YXRlLnBoYXNlfWApO1xuICBpZiAoc3RhdGUucmVxdWlyZW1lbnRzKSB7XG4gICAgbGluZXMucHVzaChgKipSZXF1aXJlbWVudHMgU3RhdHVzOioqICR7c3RhdGUucmVxdWlyZW1lbnRzLmFjdGl2ZX0gYWN0aXZlIFxcdTAwYjcgJHtzdGF0ZS5yZXF1aXJlbWVudHMudmFsaWRhdGVkfSB2YWxpZGF0ZWQgXFx1MDBiNyAke3N0YXRlLnJlcXVpcmVtZW50cy5kZWZlcnJlZH0gZGVmZXJyZWQgXFx1MDBiNyAke3N0YXRlLnJlcXVpcmVtZW50cy5vdXRPZlNjb3BlfSBvdXQgb2Ygc2NvcGVgKTtcbiAgfVxuICBsaW5lcy5wdXNoKFwiXCIpO1xuICBsaW5lcy5wdXNoKFwiIyMgTWlsZXN0b25lIFJlZ2lzdHJ5XCIpO1xuXG4gIGZvciAoY29uc3QgZW50cnkgb2Ygc3RhdGUucmVnaXN0cnkpIHtcbiAgICBjb25zdCBnbHlwaCA9IGVudHJ5LnN0YXR1cyA9PT0gXCJjb21wbGV0ZVwiID8gXCJcXHUyNzA1XCIgOiBlbnRyeS5zdGF0dXMgPT09IFwiYWN0aXZlXCIgPyBcIlxcdUQ4M0RcXHVERDA0XCIgOiBlbnRyeS5zdGF0dXMgPT09IFwicGFya2VkXCIgPyBcIlxcdTIzRjhcXHVGRTBGXCIgOiBcIlxcdTJCMUNcIjtcbiAgICBsaW5lcy5wdXNoKGAtICR7Z2x5cGh9ICoqJHtlbnRyeS5pZH06KiogJHtlbnRyeS50aXRsZX1gKTtcbiAgfVxuXG4gIGxpbmVzLnB1c2goXCJcIik7XG4gIGxpbmVzLnB1c2goXCIjIyBSZWNlbnQgRGVjaXNpb25zXCIpO1xuICBpZiAoc3RhdGUucmVjZW50RGVjaXNpb25zLmxlbmd0aCA+IDApIHtcbiAgICBmb3IgKGNvbnN0IGRlY2lzaW9uIG9mIHN0YXRlLnJlY2VudERlY2lzaW9ucykgbGluZXMucHVzaChgLSAke2RlY2lzaW9ufWApO1xuICB9IGVsc2Uge1xuICAgIGxpbmVzLnB1c2goXCItIE5vbmUgcmVjb3JkZWRcIik7XG4gIH1cblxuICBsaW5lcy5wdXNoKFwiXCIpO1xuICBsaW5lcy5wdXNoKFwiIyMgQmxvY2tlcnNcIik7XG4gIGlmIChzdGF0ZS5ibG9ja2Vycy5sZW5ndGggPiAwKSB7XG4gICAgZm9yIChjb25zdCBibG9ja2VyIG9mIHN0YXRlLmJsb2NrZXJzKSBsaW5lcy5wdXNoKGAtICR7YmxvY2tlcn1gKTtcbiAgfSBlbHNlIHtcbiAgICBsaW5lcy5wdXNoKFwiLSBOb25lXCIpO1xuICB9XG5cbiAgbGluZXMucHVzaChcIlwiKTtcbiAgbGluZXMucHVzaChcIiMjIE5leHQgQWN0aW9uXCIpO1xuICBsaW5lcy5wdXNoKHN0YXRlLm5leHRBY3Rpb24gfHwgXCJOb25lXCIpO1xuICBsaW5lcy5wdXNoKFwiXCIpO1xuXG4gIHJldHVybiBsaW5lcy5qb2luKFwiXFxuXCIpO1xufVxuXG5hc3luYyBmdW5jdGlvbiB1cGRhdGVTdGF0ZUZpbGUoYmFzZVBhdGg6IHN0cmluZywgZml4ZXNBcHBsaWVkOiBzdHJpbmdbXSk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2VQYXRoKTtcbiAgY29uc3QgcGF0aCA9IHJlc29sdmVHc2RSb290RmlsZShiYXNlUGF0aCwgXCJTVEFURVwiKTtcbiAgYXdhaXQgc2F2ZUZpbGUocGF0aCwgYnVpbGRTdGF0ZU1hcmtkb3duKHN0YXRlKSk7XG4gIGZpeGVzQXBwbGllZC5wdXNoKGB1cGRhdGVkICR7cGF0aH1gKTtcbn1cblxuLyoqIFJlYnVpbGQgU1RBVEUubWQgZnJvbSBjdXJyZW50IGRpc2sgc3RhdGUuIEV4cG9ydGVkIGZvciBhdXRvLW1vZGUgcG9zdC1ob29rcy4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWJ1aWxkU3RhdGUoYmFzZVBhdGg6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBpbnZhbGlkYXRlQWxsQ2FjaGVzKCk7XG4gIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZVBhdGgpO1xuICBjb25zdCBwYXRoID0gcmVzb2x2ZUdzZFJvb3RGaWxlKGJhc2VQYXRoLCBcIlNUQVRFXCIpO1xuICBhd2FpdCBzYXZlRmlsZShwYXRoLCBidWlsZFN0YXRlTWFya2Rvd24oc3RhdGUpKTtcbn1cblxuZnVuY3Rpb24gbWF0Y2hlc1Njb3BlKHVuaXRJZDogc3RyaW5nLCBzY29wZT86IHN0cmluZyk6IGJvb2xlYW4ge1xuICBpZiAoIXNjb3BlKSByZXR1cm4gdHJ1ZTtcbiAgcmV0dXJuIHVuaXRJZCA9PT0gc2NvcGUgfHwgdW5pdElkLnN0YXJ0c1dpdGgoYCR7c2NvcGV9L2ApO1xufVxuXG5mdW5jdGlvbiBhdWRpdFJlcXVpcmVtZW50cyhjb250ZW50OiBzdHJpbmcgfCBudWxsKTogRG9jdG9ySXNzdWVbXSB7XG4gIGlmICghY29udGVudCkgcmV0dXJuIFtdO1xuICBjb25zdCBpc3N1ZXM6IERvY3Rvcklzc3VlW10gPSBbXTtcbiAgY29uc3QgYmxvY2tzID0gY29udGVudC5zcGxpdCgvXiMjI1xccysvbSkuc2xpY2UoMSk7XG5cbiAgZm9yIChjb25zdCBibG9jayBvZiBibG9ja3MpIHtcbiAgICBjb25zdCBpZE1hdGNoID0gYmxvY2subWF0Y2goL14oUlxcZCspLyk7XG4gICAgaWYgKCFpZE1hdGNoKSBjb250aW51ZTtcbiAgICBjb25zdCByZXF1aXJlbWVudElkID0gaWRNYXRjaFsxXTtcbiAgICBjb25zdCBzdGF0dXMgPSBibG9jay5tYXRjaCgvXi1cXHMrU3RhdHVzOlxccysoLispJC9tKT8uWzFdPy50cmltKCkudG9Mb3dlckNhc2UoKSA/PyBcIlwiO1xuICAgIGNvbnN0IG93bmVyID0gYmxvY2subWF0Y2goL14tXFxzK1ByaW1hcnkgb3duaW5nIHNsaWNlOlxccysoLispJC9tKT8uWzFdPy50cmltKCkudG9Mb3dlckNhc2UoKSA/PyBcIlwiO1xuICAgIGNvbnN0IG5vdGVzID0gYmxvY2subWF0Y2goL14tXFxzK05vdGVzOlxccysoLispJC9tKT8uWzFdPy50cmltKCkudG9Mb3dlckNhc2UoKSA/PyBcIlwiO1xuXG4gICAgaWYgKHN0YXR1cyA9PT0gXCJhY3RpdmVcIiAmJiAoIW93bmVyIHx8IG93bmVyID09PSBcIm5vbmVcIiB8fCBvd25lciA9PT0gXCJub25lIHlldFwiKSkge1xuICAgICAgLy8gIzQ0MTQ6IERvd25ncmFkZSB0byB3YXJuaW5nLiBBIG5ld2x5LWNyZWF0ZWQgcmVxdWlyZW1lbnQgaGFzXG4gICAgICAvLyBwcmltYXJ5X293bmVyPScnIGJ5IGRlZmF1bHQgdW50aWwgdGhlIHBsYW5uaW5nIGFnZW50IHdpcmVzIGl0IHRvXG4gICAgICAvLyBhIHNsaWNlIHZpYSBnc2RfcmVxdWlyZW1lbnRfdXBkYXRlLiBGbGFnZ2luZyB0aGlzIGFzIGFuIGVycm9yXG4gICAgICAvLyBkdXJpbmcgbm9ybWFsIHBsYW5uaW5nIGlzIG5vaXN5IFx1MjAxNCB0aGUgcmVhbCBmYWlsdXJlIG1vZGUgaXMgd2hlblxuICAgICAgLy8gaXQgcGVyc2lzdHMgcGFzdCBtaWxlc3RvbmUgY29tcGxldGlvbiwgd2hpY2ggaXMgY292ZXJlZCBieSBvdGhlclxuICAgICAgLy8gYXVkaXRzLiBLZWVwIHRoZSBzaWduYWwgYnV0IGRvbid0IHRyZWF0IGl0IGFzIGEgYmxvY2tlci5cbiAgICAgIGlzc3Vlcy5wdXNoKHtcbiAgICAgICAgc2V2ZXJpdHk6IFwid2FybmluZ1wiLFxuICAgICAgICBjb2RlOiBcImFjdGl2ZV9yZXF1aXJlbWVudF9taXNzaW5nX293bmVyXCIsXG4gICAgICAgIHNjb3BlOiBcInByb2plY3RcIixcbiAgICAgICAgdW5pdElkOiByZXF1aXJlbWVudElkLFxuICAgICAgICBtZXNzYWdlOiBgJHtyZXF1aXJlbWVudElkfSBpcyBBY3RpdmUgYnV0IGhhcyBubyBwcmltYXJ5IG93bmluZyBzbGljZWAsXG4gICAgICAgIGZpbGU6IHJlbEdzZFJvb3RGaWxlKFwiUkVRVUlSRU1FTlRTXCIpLFxuICAgICAgICBmaXhhYmxlOiBmYWxzZSxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGlmIChzdGF0dXMgPT09IFwiYmxvY2tlZFwiICYmICFub3Rlcykge1xuICAgICAgaXNzdWVzLnB1c2goe1xuICAgICAgICBzZXZlcml0eTogXCJ3YXJuaW5nXCIsXG4gICAgICAgIGNvZGU6IFwiYmxvY2tlZF9yZXF1aXJlbWVudF9taXNzaW5nX3JlYXNvblwiLFxuICAgICAgICBzY29wZTogXCJwcm9qZWN0XCIsXG4gICAgICAgIHVuaXRJZDogcmVxdWlyZW1lbnRJZCxcbiAgICAgICAgbWVzc2FnZTogYCR7cmVxdWlyZW1lbnRJZH0gaXMgQmxvY2tlZCBidXQgaGFzIG5vIHJlYXNvbiBpbiBOb3Rlc2AsXG4gICAgICAgIGZpbGU6IHJlbEdzZFJvb3RGaWxlKFwiUkVRVUlSRU1FTlRTXCIpLFxuICAgICAgICBmaXhhYmxlOiBmYWxzZSxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiBpc3N1ZXM7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzZWxlY3REb2N0b3JTY29wZShiYXNlUGF0aDogc3RyaW5nLCByZXF1ZXN0ZWRTY29wZT86IHN0cmluZyk6IFByb21pc2U8c3RyaW5nIHwgdW5kZWZpbmVkPiB7XG4gIGlmIChyZXF1ZXN0ZWRTY29wZSkgcmV0dXJuIHJlcXVlc3RlZFNjb3BlO1xuXG4gIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZVBhdGgpO1xuICBpZiAoc3RhdGUuYWN0aXZlTWlsZXN0b25lPy5pZCAmJiBzdGF0ZS5hY3RpdmVTbGljZT8uaWQpIHtcbiAgICByZXR1cm4gYCR7c3RhdGUuYWN0aXZlTWlsZXN0b25lLmlkfS8ke3N0YXRlLmFjdGl2ZVNsaWNlLmlkfWA7XG4gIH1cbiAgaWYgKHN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQpIHtcbiAgICByZXR1cm4gc3RhdGUuYWN0aXZlTWlsZXN0b25lLmlkO1xuICB9XG5cbiAgY29uc3QgbWlsZXN0b25lc1BhdGggPSBtaWxlc3RvbmVzRGlyKGJhc2VQYXRoKTtcbiAgaWYgKCFleGlzdHNTeW5jKG1pbGVzdG9uZXNQYXRoKSkgcmV0dXJuIHVuZGVmaW5lZDtcblxuICBmb3IgKGNvbnN0IG1pbGVzdG9uZSBvZiBzdGF0ZS5yZWdpc3RyeSkge1xuICAgIGNvbnN0IHJvYWRtYXBQYXRoID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZVBhdGgsIG1pbGVzdG9uZS5pZCwgXCJST0FETUFQXCIpO1xuICAgIGNvbnN0IHJvYWRtYXBDb250ZW50ID0gcm9hZG1hcFBhdGggPyBhd2FpdCBsb2FkRmlsZShyb2FkbWFwUGF0aCkgOiBudWxsO1xuICAgIGlmICghcm9hZG1hcENvbnRlbnQpIGNvbnRpbnVlO1xuICAgIGlmIChpc0RiQXZhaWxhYmxlKCkpIHtcbiAgICAgIGNvbnN0IGRiU2xpY2VzID0gZ2V0TWlsZXN0b25lU2xpY2VzKG1pbGVzdG9uZS5pZCk7XG4gICAgICBjb25zdCBhbGxEb25lID0gZGJTbGljZXMubGVuZ3RoID4gMCAmJiBkYlNsaWNlcy5ldmVyeShzID0+IHMuc3RhdHVzID09PSBcImNvbXBsZXRlXCIpO1xuICAgICAgaWYgKCFhbGxEb25lKSByZXR1cm4gbWlsZXN0b25lLmlkO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCByb2FkbWFwID0gcGFyc2VMZWdhY3lSb2FkbWFwKHJvYWRtYXBDb250ZW50KTtcbiAgICAgIGlmICghaXNNaWxlc3RvbmVDb21wbGV0ZShyb2FkbWFwKSkgcmV0dXJuIG1pbGVzdG9uZS5pZDtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gc3RhdGUucmVnaXN0cnlbMF0/LmlkO1xufVxuXG4vLyBcdTI1MDBcdTI1MDAgSGVscGVyOiBjaXJjdWxhciBkZXBlbmRlbmN5IGRldGVjdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbmZ1bmN0aW9uIGRldGVjdENpcmN1bGFyRGVwZW5kZW5jaWVzKHNsaWNlczogUm9hZG1hcFNsaWNlRW50cnlbXSk6IHN0cmluZ1tdW10ge1xuICBjb25zdCBrbm93biA9IG5ldyBTZXQoc2xpY2VzLm1hcChzID0+IHMuaWQpKTtcbiAgY29uc3QgYWRqID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZ1tdPigpO1xuICBmb3IgKGNvbnN0IHMgb2Ygc2xpY2VzKSBhZGouc2V0KHMuaWQsIHMuZGVwZW5kcy5maWx0ZXIoZCA9PiBrbm93bi5oYXMoZCkpKTtcbiAgY29uc3Qgc3RhdGUgPSBuZXcgTWFwPHN0cmluZywgXCJ1bnZpc2l0ZWRcIiB8IFwidmlzaXRpbmdcIiB8IFwiZG9uZVwiPigpO1xuICBmb3IgKGNvbnN0IHMgb2Ygc2xpY2VzKSBzdGF0ZS5zZXQocy5pZCwgXCJ1bnZpc2l0ZWRcIik7XG4gIGNvbnN0IGN5Y2xlczogc3RyaW5nW11bXSA9IFtdO1xuICBmdW5jdGlvbiBkZnMoaWQ6IHN0cmluZywgcGF0aDogc3RyaW5nW10pOiB2b2lkIHtcbiAgICBjb25zdCBzdCA9IHN0YXRlLmdldChpZCk7XG4gICAgaWYgKHN0ID09PSBcImRvbmVcIikgcmV0dXJuO1xuICAgIGlmIChzdCA9PT0gXCJ2aXNpdGluZ1wiKSB7IGN5Y2xlcy5wdXNoKFsuLi5wYXRoLnNsaWNlKHBhdGguaW5kZXhPZihpZCkpLCBpZF0pOyByZXR1cm47IH1cbiAgICBzdGF0ZS5zZXQoaWQsIFwidmlzaXRpbmdcIik7XG4gICAgZm9yIChjb25zdCBkZXAgb2YgYWRqLmdldChpZCkgPz8gW10pIGRmcyhkZXAsIFsuLi5wYXRoLCBpZF0pO1xuICAgIHN0YXRlLnNldChpZCwgXCJkb25lXCIpO1xuICB9XG4gIGZvciAoY29uc3QgcyBvZiBzbGljZXMpIGlmIChzdGF0ZS5nZXQocy5pZCkgPT09IFwidW52aXNpdGVkXCIpIGRmcyhzLmlkLCBbXSk7XG4gIHJldHVybiBjeWNsZXM7XG59XG5cbi8vIFx1MjUwMFx1MjUwMCBIZWxwZXI6IGRvY3RvciBydW4gaGlzdG9yeSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbmV4cG9ydCBpbnRlcmZhY2UgRG9jdG9ySGlzdG9yeUVudHJ5IHtcbiAgdHM6IHN0cmluZztcbiAgb2s6IGJvb2xlYW47XG4gIGVycm9yczogbnVtYmVyO1xuICB3YXJuaW5nczogbnVtYmVyO1xuICBmaXhlczogbnVtYmVyO1xuICBjb2Rlczogc3RyaW5nW107XG4gIC8qKiBJc3N1ZSBtZXNzYWdlcyB3aXRoIHNldmVyaXR5IGFuZCBzY29wZSAoYWRkZWQgaW4gUGhhc2UgMikuICovXG4gIGlzc3Vlcz86IEFycmF5PHsgc2V2ZXJpdHk6IHN0cmluZzsgY29kZTogc3RyaW5nOyBtZXNzYWdlOiBzdHJpbmc7IHVuaXRJZDogc3RyaW5nIH0+O1xuICAvKiogRml4IGRlc2NyaXB0aW9ucyBhcHBsaWVkIGR1cmluZyB0aGlzIHJ1biAoYWRkZWQgaW4gUGhhc2UgMikuICovXG4gIGZpeERlc2NyaXB0aW9ucz86IHN0cmluZ1tdO1xuICAvKiogTWlsZXN0b25lL3NsaWNlIHNjb3BlIHRoaXMgZG9jdG9yIHJ1biB3YXMgc2NvcGVkIHRvIChlLmcuIFwiTTAwMS9TMDJcIikuICovXG4gIHNjb3BlPzogc3RyaW5nO1xuICAvKiogSHVtYW4tcmVhZGFibGUgb25lLWxpbmUgc3VtbWFyeSBvZiB0aGlzIGRvY3RvciBydW4uICovXG4gIHN1bW1hcnk/OiBzdHJpbmc7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGFwcGVuZERvY3Rvckhpc3RvcnkoYmFzZVBhdGg6IHN0cmluZywgcmVwb3J0OiBEb2N0b3JSZXBvcnQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBoaXN0b3J5UGF0aCA9IGpvaW4oZ3NkUm9vdChiYXNlUGF0aCksIFwiZG9jdG9yLWhpc3RvcnkuanNvbmxcIik7XG4gICAgY29uc3QgZXJyb3JDb3VudCA9IHJlcG9ydC5pc3N1ZXMuZmlsdGVyKGkgPT4gaS5zZXZlcml0eSA9PT0gXCJlcnJvclwiKS5sZW5ndGg7XG4gICAgY29uc3Qgd2FybmluZ0NvdW50ID0gcmVwb3J0Lmlzc3Vlcy5maWx0ZXIoaSA9PiBpLnNldmVyaXR5ID09PSBcIndhcm5pbmdcIikubGVuZ3RoO1xuICAgIGNvbnN0IGlzc3VlRGV0YWlscyA9IHJlcG9ydC5pc3N1ZXNcbiAgICAgIC5maWx0ZXIoaSA9PiBpLnNldmVyaXR5ID09PSBcImVycm9yXCIgfHwgaS5zZXZlcml0eSA9PT0gXCJ3YXJuaW5nXCIpXG4gICAgICAuc2xpY2UoMCwgMTApIC8vIGNhcCB0byBrZWVwIEpTT05MIGxpbmVzIGJvdW5kZWRcbiAgICAgIC5tYXAoaSA9PiAoeyBzZXZlcml0eTogaS5zZXZlcml0eSwgY29kZTogaS5jb2RlLCBtZXNzYWdlOiBpLm1lc3NhZ2UsIHVuaXRJZDogaS51bml0SWQgfSkpO1xuXG4gICAgLy8gSHVtYW4tcmVhZGFibGUgb25lLWxpbmUgc3VtbWFyeVxuICAgIGNvbnN0IHN1bW1hcnlQYXJ0czogc3RyaW5nW10gPSBbXTtcbiAgICBpZiAocmVwb3J0Lm9rKSB7XG4gICAgICBzdW1tYXJ5UGFydHMucHVzaChcIkNsZWFuXCIpO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBjb3VudHM6IHN0cmluZ1tdID0gW107XG4gICAgICBpZiAoZXJyb3JDb3VudCA+IDApIGNvdW50cy5wdXNoKGAke2Vycm9yQ291bnR9IGVycm9yJHtlcnJvckNvdW50ID4gMSA/IFwic1wiIDogXCJcIn1gKTtcbiAgICAgIGlmICh3YXJuaW5nQ291bnQgPiAwKSBjb3VudHMucHVzaChgJHt3YXJuaW5nQ291bnR9IHdhcm5pbmcke3dhcm5pbmdDb3VudCA+IDEgPyBcInNcIiA6IFwiXCJ9YCk7XG4gICAgICBzdW1tYXJ5UGFydHMucHVzaChjb3VudHMuam9pbihcIiwgXCIpKTtcbiAgICB9XG4gICAgaWYgKHJlcG9ydC5maXhlc0FwcGxpZWQubGVuZ3RoID4gMCkge1xuICAgICAgc3VtbWFyeVBhcnRzLnB1c2goYCR7cmVwb3J0LmZpeGVzQXBwbGllZC5sZW5ndGh9IGZpeGVkYCk7XG4gICAgfVxuICAgIGlmIChpc3N1ZURldGFpbHMubGVuZ3RoID4gMCkge1xuICAgICAgY29uc3QgdG9wSXNzdWUgPSBpc3N1ZURldGFpbHMuZmluZChpID0+IGkuc2V2ZXJpdHkgPT09IFwiZXJyb3JcIikgPz8gaXNzdWVEZXRhaWxzWzBdITtcbiAgICAgIHN1bW1hcnlQYXJ0cy5wdXNoKHRvcElzc3VlLm1lc3NhZ2UpO1xuICAgIH1cblxuICAgIGNvbnN0IGVudHJ5ID0gSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgdHM6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgIG9rOiByZXBvcnQub2ssXG4gICAgICBlcnJvcnM6IGVycm9yQ291bnQsXG4gICAgICB3YXJuaW5nczogd2FybmluZ0NvdW50LFxuICAgICAgZml4ZXM6IHJlcG9ydC5maXhlc0FwcGxpZWQubGVuZ3RoLFxuICAgICAgY29kZXM6IFsuLi5uZXcgU2V0KHJlcG9ydC5pc3N1ZXMubWFwKGkgPT4gaS5jb2RlKSldLFxuICAgICAgaXNzdWVzOiBpc3N1ZURldGFpbHMubGVuZ3RoID4gMCA/IGlzc3VlRGV0YWlscyA6IHVuZGVmaW5lZCxcbiAgICAgIGZpeERlc2NyaXB0aW9uczogcmVwb3J0LmZpeGVzQXBwbGllZC5sZW5ndGggPiAwID8gcmVwb3J0LmZpeGVzQXBwbGllZCA6IHVuZGVmaW5lZCxcbiAgICAgIHNjb3BlOiAocmVwb3J0IGFzIGFueSkuc2NvcGUgYXMgc3RyaW5nIHwgdW5kZWZpbmVkLFxuICAgICAgc3VtbWFyeTogc3VtbWFyeVBhcnRzLmpvaW4oXCIgXHUwMEI3IFwiKSxcbiAgICB9IHNhdGlzZmllcyBEb2N0b3JIaXN0b3J5RW50cnkpO1xuICAgIGNvbnN0IGV4aXN0aW5nID0gZXhpc3RzU3luYyhoaXN0b3J5UGF0aCkgPyByZWFkRmlsZVN5bmMoaGlzdG9yeVBhdGgsIFwidXRmLThcIikgOiBcIlwiO1xuICAgIGF3YWl0IHNhdmVGaWxlKGhpc3RvcnlQYXRoLCBleGlzdGluZyArIGVudHJ5ICsgXCJcXG5cIik7XG4gIH0gY2F0Y2ggeyAvKiBub24tZmF0YWwgKi8gfVxufVxuXG4vKiogUmVhZCB0aGUgbGFzdCBOIGRvY3RvciBoaXN0b3J5IGVudHJpZXMuIFJldHVybnMgbW9zdC1yZWNlbnQtZmlyc3QuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVhZERvY3Rvckhpc3RvcnkoYmFzZVBhdGg6IHN0cmluZywgbGFzdE4gPSA1MCk6IFByb21pc2U8RG9jdG9ySGlzdG9yeUVudHJ5W10+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBoaXN0b3J5UGF0aCA9IGpvaW4oZ3NkUm9vdChiYXNlUGF0aCksIFwiZG9jdG9yLWhpc3RvcnkuanNvbmxcIik7XG4gICAgaWYgKCFleGlzdHNTeW5jKGhpc3RvcnlQYXRoKSkgcmV0dXJuIFtdO1xuICAgIGNvbnN0IGxpbmVzID0gcmVhZEZpbGVTeW5jKGhpc3RvcnlQYXRoLCBcInV0Zi04XCIpLnNwbGl0KFwiXFxuXCIpLmZpbHRlcihsID0+IGwudHJpbSgpKTtcbiAgICByZXR1cm4gbGluZXMuc2xpY2UoLWxhc3ROKS5yZXZlcnNlKCkubWFwKGwgPT4gSlNPTi5wYXJzZShsKSBhcyBEb2N0b3JIaXN0b3J5RW50cnkpO1xuICB9IGNhdGNoIHsgcmV0dXJuIFtdOyB9XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5HU0REb2N0b3IoYmFzZVBhdGg6IHN0cmluZywgb3B0aW9ucz86IHsgZml4PzogYm9vbGVhbjsgZHJ5UnVuPzogYm9vbGVhbjsgc2NvcGU/OiBzdHJpbmc7IGZpeExldmVsPzogXCJ0YXNrXCIgfCBcImFsbFwiOyBpc29sYXRpb25Nb2RlPzogXCJub25lXCIgfCBcIndvcmt0cmVlXCIgfCBcImJyYW5jaFwiOyBpbmNsdWRlQnVpbGQ/OiBib29sZWFuOyBpbmNsdWRlVGVzdHM/OiBib29sZWFuIH0pOiBQcm9taXNlPERvY3RvclJlcG9ydD4ge1xuICBjb25zdCBpc3N1ZXM6IERvY3Rvcklzc3VlW10gPSBbXTtcbiAgY29uc3QgZml4ZXNBcHBsaWVkOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBmaXggPSBvcHRpb25zPy5maXggPT09IHRydWU7XG4gIGNvbnN0IGRyeVJ1biA9IG9wdGlvbnM/LmRyeVJ1biA9PT0gdHJ1ZTtcbiAgY29uc3QgZml4TGV2ZWwgPSBvcHRpb25zPy5maXhMZXZlbCA/PyBcImFsbFwiO1xuXG4gIC8vIENMSSBkb2N0b3IgY2FuIHJ1biBiZWZvcmUgYW55IHRvb2wgaGFuZGxlciBoYXMgb3BlbmVkIHRoZSBEQi4gUnVudGltZVxuICAvLyBoZWFsdGggY2hlY2tzIG5lZWQgdGhlIGV4aXN0aW5nIHByb2plY3QgREIgdG8gc3VyZmFjZSBEQi1iYWNrZWQgY3Jhc2hcbiAgLy8gbG9ja3MsIHBhdXNlZCBzZXNzaW9ucywgYW5kIGNvb3JkaW5hdGlvbiByb3dzLlxuICBjb25zdCBkYlBhdGggPSByZXNvbHZlR3NkUGF0aENvbnRyYWN0KGJhc2VQYXRoKS5wcm9qZWN0RGI7XG4gIGlmIChleGlzdHNTeW5jKGRiUGF0aCkpIHtcbiAgICB0cnkgeyBvcGVuRGF0YWJhc2UoZGJQYXRoKTsgfSBjYXRjaCB7IC8qIHN1cmZhY2VkIGxhdGVyIGFzIGRiX3VuYXZhaWxhYmxlICovIH1cbiAgfVxuXG4gIC8vIElzc3VlIGNvZGVzIHRoYXQgcmVwcmVzZW50IGNvbXBsZXRpb24gc3RhdGUgdHJhbnNpdGlvbnMgXHUyMDE0IGNyZWF0aW5nIHN1bW1hcnlcbiAgLy8gc3R1YnMsIG1hcmtpbmcgc2xpY2VzL21pbGVzdG9uZXMgZG9uZSBpbiB0aGUgcm9hZG1hcC4gVGhlc2UgYmVsb25nIHRvIHRoZVxuICAvLyBkaXNwYXRjaCBsaWZlY3ljbGUgKGNvbXBsZXRlLXNsaWNlLCBjb21wbGV0ZS1taWxlc3RvbmUgdW5pdHMpLCBub3QgdG9cbiAgLy8gbWVjaGFuaWNhbCBwb3N0LWhvb2sgYm9va2tlZXBpbmcuIFdoZW4gZml4TGV2ZWwgaXMgXCJ0YXNrXCIsIHRoZXNlIGFyZVxuICAvLyBkZXRlY3RlZCBhbmQgcmVwb3J0ZWQgYnV0IG5ldmVyIGF1dG8tZml4ZWQuXG5cbiAgLyoqIFdoZXRoZXIgYSBnaXZlbiBpc3N1ZSBjb2RlIHNob3VsZCBiZSBhdXRvLWZpeGVkIGF0IHRoZSBjdXJyZW50IGZpeExldmVsLiAqL1xuICBjb25zdCBzaG91bGRGaXggPSAoY29kZTogRG9jdG9ySXNzdWVDb2RlKTogYm9vbGVhbiA9PiB7XG4gICAgaWYgKCFmaXggfHwgZHJ5UnVuKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKGZpeExldmVsID09PSBcInRhc2tcIiAmJiBHTE9CQUxfU1RBVEVfQ09ERVMuaGFzKGNvZGUpKSByZXR1cm4gZmFsc2U7XG4gICAgcmV0dXJuIHRydWU7XG4gIH07XG5cbiAgY29uc3QgcHJlZnMgPSBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMoKTtcbiAgaWYgKHByZWZzKSB7XG4gICAgY29uc3QgcHJlZklzc3VlcyA9IHZhbGlkYXRlUHJlZmVyZW5jZVNoYXBlKHByZWZzLnByZWZlcmVuY2VzKTtcbiAgICBmb3IgKGNvbnN0IGlzc3VlIG9mIHByZWZJc3N1ZXMpIHtcbiAgICAgIGlzc3Vlcy5wdXNoKHtcbiAgICAgICAgc2V2ZXJpdHk6IFwid2FybmluZ1wiLFxuICAgICAgICBjb2RlOiBcImludmFsaWRfcHJlZmVyZW5jZXNcIixcbiAgICAgICAgc2NvcGU6IFwicHJvamVjdFwiLFxuICAgICAgICB1bml0SWQ6IFwicHJvamVjdFwiLFxuICAgICAgICBtZXNzYWdlOiBgR1NEIHByZWZlcmVuY2VzIGludmFsaWQ6ICR7aXNzdWV9YCxcbiAgICAgICAgZmlsZTogcHJlZnMucGF0aCxcbiAgICAgICAgZml4YWJsZTogZmFsc2UsXG4gICAgICB9KTtcbiAgICB9XG4gIH1cblxuICAvLyBHaXQgaGVhbHRoIGNoZWNrcyBcdTIwMTQgdGltZWRcbiAgY29uc3QgdDBnaXQgPSBEYXRlLm5vdygpO1xuICBjb25zdCBpc29sYXRpb25Nb2RlOiBcIm5vbmVcIiB8IFwid29ya3RyZWVcIiB8IFwiYnJhbmNoXCIgPSBvcHRpb25zPy5pc29sYXRpb25Nb2RlID8/XG4gICAgKHByZWZzPy5wcmVmZXJlbmNlcz8uZ2l0Py5pc29sYXRpb24gPT09IFwid29ya3RyZWVcIiA/IFwid29ya3RyZWVcIiA6XG4gICAgcHJlZnM/LnByZWZlcmVuY2VzPy5naXQ/Lmlzb2xhdGlvbiA9PT0gXCJicmFuY2hcIiA/IFwiYnJhbmNoXCIgOiBcIm5vbmVcIik7XG4gIGF3YWl0IGNoZWNrR2l0SGVhbHRoKGJhc2VQYXRoLCBpc3N1ZXMsIGZpeGVzQXBwbGllZCwgc2hvdWxkRml4LCBpc29sYXRpb25Nb2RlKTtcbiAgY29uc3QgZ2l0TXMgPSBEYXRlLm5vdygpIC0gdDBnaXQ7XG5cbiAgLy8gUnVudGltZSBoZWFsdGggY2hlY2tzIFx1MjAxNCB0aW1lZFxuICBjb25zdCB0MHJ1bnRpbWUgPSBEYXRlLm5vdygpO1xuICBhd2FpdCBjaGVja1J1bnRpbWVIZWFsdGgoYmFzZVBhdGgsIGlzc3VlcywgZml4ZXNBcHBsaWVkLCBzaG91bGRGaXgpO1xuICBjb25zdCBydW50aW1lTXMgPSBEYXRlLm5vdygpIC0gdDBydW50aW1lO1xuXG4gIC8vIEdsb2JhbCBoZWFsdGggY2hlY2tzIFx1MjAxNCBjcm9zcy1wcm9qZWN0IHN0YXRlIChlLmcuIG9ycGhhbmVkIHByb2plY3Qgc3RhdGUgZGlycylcbiAgYXdhaXQgY2hlY2tHbG9iYWxIZWFsdGgoaXNzdWVzLCBmaXhlc0FwcGxpZWQsIHNob3VsZEZpeCk7XG5cbiAgLy8gRW52aXJvbm1lbnQgaGVhbHRoIGNoZWNrcyBcdTIwMTQgdGltZWRcbiAgY29uc3QgdDBlbnYgPSBEYXRlLm5vdygpO1xuICBhd2FpdCBjaGVja0Vudmlyb25tZW50SGVhbHRoKGJhc2VQYXRoLCBpc3N1ZXMsIHtcbiAgICBpbmNsdWRlUmVtb3RlOiAhb3B0aW9ucz8uc2NvcGUsXG4gICAgaW5jbHVkZUJ1aWxkOiBvcHRpb25zPy5pbmNsdWRlQnVpbGQsXG4gICAgaW5jbHVkZVRlc3RzOiBvcHRpb25zPy5pbmNsdWRlVGVzdHMsXG4gIH0pO1xuICBjb25zdCBlbnZNcyA9IERhdGUubm93KCkgLSB0MGVudjtcblxuICAvLyBFbmdpbmUgaGVhbHRoIGNoZWNrcyBcdTIwMTQgREIgY29uc3RyYWludHMgYW5kIHByb2plY3Rpb24gZHJpZnRcbiAgYXdhaXQgY2hlY2tFbmdpbmVIZWFsdGgoYmFzZVBhdGgsIGlzc3VlcywgZml4ZXNBcHBsaWVkKTtcblxuICBjb25zdCBtaWxlc3RvbmVzUGF0aCA9IG1pbGVzdG9uZXNEaXIoYmFzZVBhdGgpO1xuICBpZiAoIWV4aXN0c1N5bmMobWlsZXN0b25lc1BhdGgpKSB7XG4gICAgY29uc3QgcmVwb3J0OiBEb2N0b3JSZXBvcnQgPSB7IG9rOiBpc3N1ZXMuZXZlcnkoaSA9PiBpLnNldmVyaXR5ICE9PSBcImVycm9yXCIpLCBiYXNlUGF0aCwgaXNzdWVzLCBmaXhlc0FwcGxpZWQsIHRpbWluZzogeyBnaXQ6IGdpdE1zLCBydW50aW1lOiBydW50aW1lTXMsIGVudmlyb25tZW50OiBlbnZNcywgZ3NkU3RhdGU6IDAgfSB9O1xuICAgIGF3YWl0IGFwcGVuZERvY3Rvckhpc3RvcnkoYmFzZVBhdGgsIHJlcG9ydCk7XG4gICAgcmV0dXJuIHJlcG9ydDtcbiAgfVxuXG4gIGNvbnN0IHJlcXVpcmVtZW50c1BhdGggPSByZXNvbHZlR3NkUm9vdEZpbGUoYmFzZVBhdGgsIFwiUkVRVUlSRU1FTlRTXCIpO1xuICBjb25zdCByZXF1aXJlbWVudHNDb250ZW50ID0gYXdhaXQgbG9hZEZpbGUocmVxdWlyZW1lbnRzUGF0aCk7XG4gIGlzc3Vlcy5wdXNoKC4uLmF1ZGl0UmVxdWlyZW1lbnRzKHJlcXVpcmVtZW50c0NvbnRlbnQpKTtcblxuICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2VQYXRoKTtcblxuICAvLyBQcm92aWRlciAvIGF1dGggaGVhbHRoIGNoZWNrcyBcdTIwMTQgb25seSByZWxldmFudCB3aGVuIHRoZXJlIGlzIGFjdGl2ZSB3b3JrIHRvIGRpc3BhdGNoLlxuICAvLyBTa2lwcGVkIGZvciBpZGxlIHByb2plY3RzIChubyBhY3RpdmUgbWlsZXN0b25lKSB0byBhdm9pZCBub2lzZSBpbiBlbnZpcm9ubWVudHNcbiAgLy8gd2hlcmUgQ0kvdGVzdCBydW5uZXJzIGhhdmUgbm8gQVBJIGtleSBjb25maWd1cmVkLlxuICBpZiAoc3RhdGUuYWN0aXZlTWlsZXN0b25lKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHByb3ZpZGVyUmVzdWx0cyA9IHJ1blByb3ZpZGVyQ2hlY2tzKCk7XG4gICAgICBmb3IgKGNvbnN0IHJlc3VsdCBvZiBwcm92aWRlclJlc3VsdHMpIHtcbiAgICAgICAgaWYgKCFyZXN1bHQucmVxdWlyZWQpIGNvbnRpbnVlO1xuICAgICAgICBpZiAocmVzdWx0LnN0YXR1cyA9PT0gXCJlcnJvclwiKSB7XG4gICAgICAgICAgaXNzdWVzLnB1c2goe1xuICAgICAgICAgICAgc2V2ZXJpdHk6IFwid2FybmluZ1wiLFxuICAgICAgICAgICAgY29kZTogXCJwcm92aWRlcl9rZXlfbWlzc2luZ1wiLFxuICAgICAgICAgICAgc2NvcGU6IFwicHJvamVjdFwiLFxuICAgICAgICAgICAgdW5pdElkOiBcInByb2plY3RcIixcbiAgICAgICAgICAgIG1lc3NhZ2U6IHJlc3VsdC5tZXNzYWdlICsgKHJlc3VsdC5kZXRhaWwgPyBgIFx1MjAxNCAke3Jlc3VsdC5kZXRhaWx9YCA6IFwiXCIpLFxuICAgICAgICAgICAgZml4YWJsZTogZmFsc2UsXG4gICAgICAgICAgfSk7XG4gICAgICAgIH0gZWxzZSBpZiAocmVzdWx0LnN0YXR1cyA9PT0gXCJ3YXJuaW5nXCIpIHtcbiAgICAgICAgICBpc3N1ZXMucHVzaCh7XG4gICAgICAgICAgICBzZXZlcml0eTogXCJ3YXJuaW5nXCIsXG4gICAgICAgICAgICBjb2RlOiBcInByb3ZpZGVyX2tleV9iYWNrZWRvZmZcIixcbiAgICAgICAgICAgIHNjb3BlOiBcInByb2plY3RcIixcbiAgICAgICAgICAgIHVuaXRJZDogXCJwcm9qZWN0XCIsXG4gICAgICAgICAgICBtZXNzYWdlOiByZXN1bHQubWVzc2FnZSArIChyZXN1bHQuZGV0YWlsID8gYCBcdTIwMTQgJHtyZXN1bHQuZGV0YWlsfWAgOiBcIlwiKSxcbiAgICAgICAgICAgIGZpeGFibGU6IGZhbHNlLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBOb24tZmF0YWwgXHUyMDE0IHByb3ZpZGVyIGNoZWNrIGZhaWx1cmUgc2hvdWxkIG5vdCBibG9jayBvdGhlciBjaGVja3NcbiAgICB9XG4gIH1cblxuICBmb3IgKGNvbnN0IG1pbGVzdG9uZSBvZiBzdGF0ZS5yZWdpc3RyeSkge1xuICAgIGNvbnN0IG1pbGVzdG9uZUlkID0gbWlsZXN0b25lLmlkO1xuICAgIGNvbnN0IG1pbGVzdG9uZVBhdGggPSByZXNvbHZlTWlsZXN0b25lUGF0aChiYXNlUGF0aCwgbWlsZXN0b25lSWQpO1xuICAgIGlmICghbWlsZXN0b25lUGF0aCkgY29udGludWU7XG5cbiAgICAvLyBWYWxpZGF0ZSBtaWxlc3RvbmUgdGl0bGUgZm9yIGRlbGltaXRlciBjaGFyYWN0ZXJzIHRoYXQgYnJlYWsgc3RhdGUgZG9jdW1lbnRzLlxuICAgIGNvbnN0IG1pbGVzdG9uZVRpdGxlSXNzdWUgPSB2YWxpZGF0ZVRpdGxlKG1pbGVzdG9uZS50aXRsZSk7XG4gICAgaWYgKG1pbGVzdG9uZVRpdGxlSXNzdWUpIHtcbiAgICAgIGNvbnN0IHJvYWRtYXBGaWxlID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBcIlJPQURNQVBcIik7XG4gICAgICBsZXQgd2FzRml4ZWQgPSBmYWxzZTtcbiAgICAgIGlmIChzaG91bGRGaXgoXCJkZWxpbWl0ZXJfaW5fdGl0bGVcIikgJiYgcm9hZG1hcEZpbGUpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCByYXcgPSByZWFkRmlsZVN5bmMocm9hZG1hcEZpbGUsIFwidXRmLThcIik7XG4gICAgICAgICAgLy8gUmVwbGFjZSBlbS9lbiBkYXNoZXMgd2l0aCBcIiAtIFwiIGluIHRoZSBIMSB0aXRsZSBsaW5lIG9ubHlcbiAgICAgICAgICBjb25zdCBzYW5pdGl6ZWQgPSByYXcucmVwbGFjZSgvXigjIC4qKSQvbSwgKGxpbmUpID0+XG4gICAgICAgICAgICBsaW5lLnJlcGxhY2UoL1tcXHUyMDE0XFx1MjAxM10vZywgXCItXCIpLFxuICAgICAgICAgICk7XG4gICAgICAgICAgaWYgKHNhbml0aXplZCAhPT0gcmF3KSB7XG4gICAgICAgICAgICBhd2FpdCBzYXZlRmlsZShyb2FkbWFwRmlsZSwgc2FuaXRpemVkKTtcbiAgICAgICAgICAgIGZpeGVzQXBwbGllZC5wdXNoKGBzYW5pdGl6ZWQgZGVsaW1pdGVyIGNoYXJhY3RlcnMgaW4gJHttaWxlc3RvbmVJZH0gdGl0bGVgKTtcbiAgICAgICAgICAgIHdhc0ZpeGVkID0gdHJ1ZTtcbiAgICAgICAgICB9XG4gICAgICAgIH0gY2F0Y2ggeyAvKiBub24tZmF0YWwgXHUyMDE0IHJlcG9ydCB0aGUgd2FybmluZyBiZWxvdyAqLyB9XG4gICAgICB9XG4gICAgICBpZiAoIXdhc0ZpeGVkKSB7XG4gICAgICAgIGlzc3Vlcy5wdXNoKHtcbiAgICAgICAgICBzZXZlcml0eTogXCJ3YXJuaW5nXCIsXG4gICAgICAgICAgY29kZTogXCJkZWxpbWl0ZXJfaW5fdGl0bGVcIixcbiAgICAgICAgICBzY29wZTogXCJtaWxlc3RvbmVcIixcbiAgICAgICAgICB1bml0SWQ6IG1pbGVzdG9uZUlkLFxuICAgICAgICAgIG1lc3NhZ2U6IGBNaWxlc3RvbmUgJHttaWxlc3RvbmVJZH0gJHttaWxlc3RvbmVUaXRsZUlzc3VlfS4gUmVuYW1lIHRoZSBtaWxlc3RvbmUgdG8gcmVtb3ZlIHRoZXNlIGNoYXJhY3RlcnMgdG8gcHJldmVudCBzdGF0ZSBjb3JydXB0aW9uLmAsXG4gICAgICAgICAgZmlsZTogcmVsTWlsZXN0b25lRmlsZShiYXNlUGF0aCwgbWlsZXN0b25lSWQsIFwiUk9BRE1BUFwiKSxcbiAgICAgICAgICBmaXhhYmxlOiB0cnVlLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCByb2FkbWFwUGF0aCA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgXCJST0FETUFQXCIpO1xuICAgIGNvbnN0IHJvYWRtYXBDb250ZW50ID0gcm9hZG1hcFBhdGggPyBhd2FpdCBsb2FkRmlsZShyb2FkbWFwUGF0aCkgOiBudWxsO1xuICAgIGlmICghcm9hZG1hcENvbnRlbnQpIGNvbnRpbnVlO1xuXG4gICAgLy8gTm9ybWFsaXplIHNsaWNlczogcHJlZmVyIERCLCBmYWxsIGJhY2sgdG8gcGFyc2VyXG4gICAgdHlwZSBOb3JtU2xpY2UgPSBSb2FkbWFwU2xpY2VFbnRyeSAmIHsgcGVuZGluZz86IGJvb2xlYW47IHNraXBwZWQ/OiBib29sZWFuIH07XG4gICAgbGV0IHNsaWNlczogTm9ybVNsaWNlW107XG4gICAgaWYgKGlzRGJBdmFpbGFibGUoKSkge1xuICAgICAgY29uc3QgZGJTbGljZXMgPSBnZXRNaWxlc3RvbmVTbGljZXMobWlsZXN0b25lSWQpO1xuICAgICAgc2xpY2VzID0gZGJTbGljZXMubWFwKHMgPT4gKHtcbiAgICAgICAgaWQ6IHMuaWQsXG4gICAgICAgIHRpdGxlOiBzLnRpdGxlLFxuICAgICAgICBkb25lOiBpc0Nsb3NlZFN0YXR1cyhzLnN0YXR1cyksXG4gICAgICAgIHBlbmRpbmc6IHMuc3RhdHVzID09PSBcInBlbmRpbmdcIixcbiAgICAgICAgc2tpcHBlZDogcy5zdGF0dXMgPT09IFwic2tpcHBlZFwiLFxuICAgICAgICByaXNrOiAocy5yaXNrIHx8IFwibWVkaXVtXCIpIGFzIFJvYWRtYXBTbGljZUVudHJ5W1wicmlza1wiXSxcbiAgICAgICAgZGVwZW5kczogcy5kZXBlbmRzLFxuICAgICAgICBkZW1vOiBzLmRlbW8sXG4gICAgICB9KSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IGFjdGl2ZU1pbGVzdG9uZUlkID0gc3RhdGUuYWN0aXZlTWlsZXN0b25lPy5pZDtcbiAgICAgIGNvbnN0IGFjdGl2ZVNsaWNlSWQgPSBzdGF0ZS5hY3RpdmVTbGljZT8uaWQ7XG4gICAgICBzbGljZXMgPSBwYXJzZUxlZ2FjeVJvYWRtYXAocm9hZG1hcENvbnRlbnQpLnNsaWNlcy5tYXAocyA9PiAoe1xuICAgICAgICAuLi5zLFxuICAgICAgICAvLyBMZWdhY3kgcm9hZG1hcHMgb25seSBlbmNvZGUgZG9uZSB2cyBub3QtZG9uZS4gRm9yIGRvY3RvcidzXG4gICAgICAgIC8vIG1pc3NpbmctZGlyZWN0b3J5IGNoZWNrcywgdHJlYXQgZXZlcnkgdW5kb25lIHNsaWNlIGV4Y2VwdCB0aGVcbiAgICAgICAgLy8gY3VycmVudCBhY3RpdmUgc2xpY2UgYXMgZWZmZWN0aXZlbHkgcGVuZGluZy91bnN0YXJ0ZWQuXG4gICAgICAgIHBlbmRpbmc6ICFzLmRvbmUgJiYgKG1pbGVzdG9uZUlkICE9PSBhY3RpdmVNaWxlc3RvbmVJZCB8fCBzLmlkICE9PSBhY3RpdmVTbGljZUlkKSxcbiAgICAgIH0pKTtcbiAgICB9XG4gICAgLy8gV3JhcCBpbiBSb2FkbWFwLWNvbXBhdGlibGUgc2hhcGUgZm9yIGRldGVjdENpcmN1bGFyRGVwZW5kZW5jaWVzXG4gICAgY29uc3Qgcm9hZG1hcCA9IHsgc2xpY2VzIH07XG5cbiAgICAvLyBcdTI1MDBcdTI1MDAgQ2lyY3VsYXIgZGVwZW5kZW5jeSBkZXRlY3Rpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gICAgZm9yIChjb25zdCBjeWNsZSBvZiBkZXRlY3RDaXJjdWxhckRlcGVuZGVuY2llcyhyb2FkbWFwLnNsaWNlcykpIHtcbiAgICAgIGlzc3Vlcy5wdXNoKHtcbiAgICAgICAgc2V2ZXJpdHk6IFwiZXJyb3JcIixcbiAgICAgICAgY29kZTogXCJjaXJjdWxhcl9zbGljZV9kZXBlbmRlbmN5XCIsXG4gICAgICAgIHNjb3BlOiBcIm1pbGVzdG9uZVwiLFxuICAgICAgICB1bml0SWQ6IG1pbGVzdG9uZUlkLFxuICAgICAgICBtZXNzYWdlOiBgQ2lyY3VsYXIgZGVwZW5kZW5jeSBkZXRlY3RlZDogJHtjeWNsZS5qb2luKFwiIFx1MjE5MiBcIil9YCxcbiAgICAgICAgZmlsZTogcmVsTWlsZXN0b25lRmlsZShiYXNlUGF0aCwgbWlsZXN0b25lSWQsIFwiUk9BRE1BUFwiKSxcbiAgICAgICAgZml4YWJsZTogZmFsc2UsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyBcdTI1MDBcdTI1MDAgT3JwaGFuZWQgc2xpY2UgZGlyZWN0b3JpZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHNsaWNlc0RpciA9IGpvaW4obWlsZXN0b25lUGF0aCwgXCJzbGljZXNcIik7XG4gICAgICBpZiAoZXhpc3RzU3luYyhzbGljZXNEaXIpKSB7XG4gICAgICAgIGNvbnN0IGtub3duU2xpY2VJZHMgPSBuZXcgU2V0KHJvYWRtYXAuc2xpY2VzLm1hcChzID0+IHMuaWQpKTtcbiAgICAgICAgZm9yIChjb25zdCBlbnRyeSBvZiByZWFkZGlyU3luYyhzbGljZXNEaXIpKSB7XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGlmICghbHN0YXRTeW5jKGpvaW4oc2xpY2VzRGlyLCBlbnRyeSkpLmlzRGlyZWN0b3J5KCkpIGNvbnRpbnVlO1xuICAgICAgICAgIH0gY2F0Y2ggeyBjb250aW51ZTsgfVxuICAgICAgICAgIGlmICgha25vd25TbGljZUlkcy5oYXMoZW50cnkpKSB7XG4gICAgICAgICAgICBpc3N1ZXMucHVzaCh7XG4gICAgICAgICAgICAgIHNldmVyaXR5OiBcIndhcm5pbmdcIixcbiAgICAgICAgICAgICAgY29kZTogXCJvcnBoYW5lZF9zbGljZV9kaXJlY3RvcnlcIixcbiAgICAgICAgICAgICAgc2NvcGU6IFwibWlsZXN0b25lXCIsXG4gICAgICAgICAgICAgIHVuaXRJZDogbWlsZXN0b25lSWQsXG4gICAgICAgICAgICAgIG1lc3NhZ2U6IGBEaXJlY3RvcnkgXCIke2VudHJ5fVwiIGV4aXN0cyBpbiAke21pbGVzdG9uZUlkfS9zbGljZXMvIGJ1dCBpcyBub3QgcmVmZXJlbmNlZCBpbiB0aGUgcm9hZG1hcGAsXG4gICAgICAgICAgICAgIGZpbGU6IGAke3JlbE1pbGVzdG9uZVBhdGgoYmFzZVBhdGgsIG1pbGVzdG9uZUlkKX0vc2xpY2VzLyR7ZW50cnl9YCxcbiAgICAgICAgICAgICAgZml4YWJsZTogZmFsc2UsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGNhdGNoIHsgLyogbm9uLWZhdGFsICovIH1cblxuICAgIGZvciAoY29uc3Qgc2xpY2Ugb2Ygcm9hZG1hcC5zbGljZXMpIHtcbiAgICAgIGNvbnN0IHVuaXRJZCA9IGAke21pbGVzdG9uZUlkfS8ke3NsaWNlLmlkfWA7XG4gICAgICBpZiAob3B0aW9ucz8uc2NvcGUgJiYgIW1hdGNoZXNTY29wZSh1bml0SWQsIG9wdGlvbnMuc2NvcGUpICYmIG9wdGlvbnMuc2NvcGUgIT09IG1pbGVzdG9uZUlkKSBjb250aW51ZTtcblxuICAgICAgLy8gVmFsaWRhdGUgc2xpY2UgdGl0bGUgZm9yIGRlbGltaXRlciBjaGFyYWN0ZXJzLlxuICAgICAgY29uc3Qgc2xpY2VUaXRsZUlzc3VlID0gdmFsaWRhdGVUaXRsZShzbGljZS50aXRsZSk7XG4gICAgICBpZiAoc2xpY2VUaXRsZUlzc3VlKSB7XG4gICAgICAgIC8vIFNsaWNlIHRpdGxlcyBsaXZlIGluc2lkZSB0aGUgcm9hZG1hcCBIMS9jaGVja2JveCBsaW5lcyBcdTIwMTQgdGhlIG1pbGVzdG9uZS1sZXZlbFxuICAgICAgICAvLyBmaXggYWJvdmUgYWxyZWFkeSBzYW5pdGl6ZXMgdGhlIHJvYWRtYXAgZmlsZS4gRm9yIHNsaWNlcyB3ZSBvbmx5IHJlcG9ydCwgYmVjYXVzZVxuICAgICAgICAvLyB0aGUgdGl0bGUgY29tZXMgZnJvbSB0aGUgY2hlY2tib3ggdGV4dCBhbmQgcmVxdWlyZXMgY2FyZWZ1bCByZWdleCB0byBmaXggc2FmZWx5LlxuICAgICAgICBpc3N1ZXMucHVzaCh7XG4gICAgICAgICAgc2V2ZXJpdHk6IFwid2FybmluZ1wiLFxuICAgICAgICAgIGNvZGU6IFwiZGVsaW1pdGVyX2luX3RpdGxlXCIsXG4gICAgICAgICAgc2NvcGU6IFwic2xpY2VcIixcbiAgICAgICAgICB1bml0SWQsXG4gICAgICAgICAgbWVzc2FnZTogYFNsaWNlICR7dW5pdElkfSAke3NsaWNlVGl0bGVJc3N1ZX0uIFJlbmFtZSB0aGUgc2xpY2UgdG8gcmVtb3ZlIHRoZXNlIGNoYXJhY3RlcnMgdG8gcHJldmVudCBzdGF0ZSBjb3JydXB0aW9uLmAsXG4gICAgICAgICAgZmlsZTogcmVsTWlsZXN0b25lRmlsZShiYXNlUGF0aCwgbWlsZXN0b25lSWQsIFwiUk9BRE1BUFwiKSxcbiAgICAgICAgICBmaXhhYmxlOiBmYWxzZSxcbiAgICAgICAgfSk7XG4gICAgICB9XG5cbiAgICAgIC8vIENoZWNrIGZvciB1bnJlc29sdmFibGUgZGVwZW5kZW5jeSBJRHNcbiAgICAgIGNvbnN0IGtub3duU2xpY2VJZHMgPSBuZXcgU2V0KHJvYWRtYXAuc2xpY2VzLm1hcChzID0+IHMuaWQpKTtcbiAgICAgIGZvciAoY29uc3QgZGVwIG9mIHNsaWNlLmRlcGVuZHMpIHtcbiAgICAgICAgaWYgKCFrbm93blNsaWNlSWRzLmhhcyhkZXApKSB7XG4gICAgICAgICAgaXNzdWVzLnB1c2goe1xuICAgICAgICAgICAgc2V2ZXJpdHk6IFwid2FybmluZ1wiLFxuICAgICAgICAgICAgY29kZTogXCJ1bnJlc29sdmFibGVfZGVwZW5kZW5jeVwiLFxuICAgICAgICAgICAgc2NvcGU6IFwic2xpY2VcIixcbiAgICAgICAgICAgIHVuaXRJZCxcbiAgICAgICAgICAgIG1lc3NhZ2U6IGBTbGljZSAke3VuaXRJZH0gZGVwZW5kcyBvbiBcIiR7ZGVwfVwiIHdoaWNoIGlzIG5vdCBhIHNsaWNlIElEIGluIHRoaXMgcm9hZG1hcC4gVGhpcyBwZXJtYW5lbnRseSBibG9ja3MgdGhlIHNsaWNlLiBVc2UgY29tbWEtc2VwYXJhdGVkIElEczogXFxgZGVwZW5kczpbUzAxLFMwMl1cXGBgLFxuICAgICAgICAgICAgZmlsZTogcmVsTWlsZXN0b25lRmlsZShiYXNlUGF0aCwgbWlsZXN0b25lSWQsIFwiUk9BRE1BUFwiKSxcbiAgICAgICAgICAgIGZpeGFibGU6IGZhbHNlLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHNsaWNlUGF0aCA9IHJlc29sdmVTbGljZVBhdGgoYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBzbGljZS5pZCk7XG4gICAgICBpZiAoIXNsaWNlUGF0aCkge1xuICAgICAgICAvLyBQZW5kaW5nIHNsaWNlcyBoYXZlbid0IGJlZW4gcGxhbm5lZCB5ZXQgXHUyMDE0IGRpcmVjdG9yaWVzIGFyZSBjcmVhdGVkXG4gICAgICAgIC8vIGxhemlseSBieSBlbnN1cmVQcmVjb25kaXRpb25zKCkgYXQgZGlzcGF0Y2ggdGltZS4gU2tpcHBlZCBzbGljZXMgYXJlXG4gICAgICAgIC8vIGludGVudGlvbmFsbHkgYWxsb3dlZCB0byByZW1haW4gc3VtbWFyeS1sZXNzIGFuZCBkaXJlY3RvcnktbGVzcy5cbiAgICAgICAgaWYgKHNsaWNlLnBlbmRpbmcgfHwgc2xpY2Uuc2tpcHBlZCkgY29udGludWU7XG4gICAgICAgIGNvbnN0IGV4cGVjdGVkUGF0aCA9IHJlbFNsaWNlUGF0aChiYXNlUGF0aCwgbWlsZXN0b25lSWQsIHNsaWNlLmlkKTtcbiAgICAgICAgaXNzdWVzLnB1c2goe1xuICAgICAgICAgIHNldmVyaXR5OiBzbGljZS5kb25lID8gXCJ3YXJuaW5nXCIgOiBcImVycm9yXCIsXG4gICAgICAgICAgY29kZTogXCJtaXNzaW5nX3NsaWNlX2RpclwiLFxuICAgICAgICAgIHNjb3BlOiBcInNsaWNlXCIsXG4gICAgICAgICAgdW5pdElkLFxuICAgICAgICAgIG1lc3NhZ2U6IHNsaWNlLmRvbmVcbiAgICAgICAgICAgID8gYE1pc3Npbmcgc2xpY2UgZGlyZWN0b3J5IGZvciAke3VuaXRJZH0gKHNsaWNlIGlzIGNvbXBsZXRlIFx1MjAxNCBjb3NtZXRpYyBvbmx5KWBcbiAgICAgICAgICAgIDogYE1pc3Npbmcgc2xpY2UgZGlyZWN0b3J5IGZvciAke3VuaXRJZH1gLFxuICAgICAgICAgIGZpbGU6IGV4cGVjdGVkUGF0aCxcbiAgICAgICAgICBmaXhhYmxlOiB0cnVlLFxuICAgICAgICB9KTtcbiAgICAgICAgaWYgKGZpeCkge1xuICAgICAgICAgIGNvbnN0IGFic29sdXRlU2xpY2VEaXIgPSBqb2luKG1pbGVzdG9uZVBhdGgsIFwic2xpY2VzXCIsIHNsaWNlLmlkKTtcbiAgICAgICAgICBta2RpclN5bmMoYWJzb2x1dGVTbGljZURpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICAgICAgZml4ZXNBcHBsaWVkLnB1c2goYGNyZWF0ZWQgJHthYnNvbHV0ZVNsaWNlRGlyfWApO1xuICAgICAgICB9XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICBjb25zdCB0YXNrc0RpciA9IHJlc29sdmVUYXNrc0RpcihiYXNlUGF0aCwgbWlsZXN0b25lSWQsIHNsaWNlLmlkKTtcbiAgICAgIGlmICghdGFza3NEaXIpIHtcbiAgICAgICAgLy8gUGVuZGluZyBzbGljZXMgaGF2ZW4ndCBiZWVuIHBsYW5uZWQgeWV0IFx1MjAxNCB0YXNrcy8gaXMgY3JlYXRlZCBvbiBkZW1hbmQuXG4gICAgICAgIC8vIFNraXBwZWQgc2xpY2VzIG1heSBsZWdpdGltYXRlbHkgbmV2ZXIgY3JlYXRlIHRhc2tzLy5cbiAgICAgICAgaWYgKHNsaWNlLnBlbmRpbmcgfHwgc2xpY2Uuc2tpcHBlZCkgY29udGludWU7XG4gICAgICAgIGlzc3Vlcy5wdXNoKHtcbiAgICAgICAgICBzZXZlcml0eTogc2xpY2UuZG9uZSA/IFwid2FybmluZ1wiIDogXCJlcnJvclwiLFxuICAgICAgICAgIGNvZGU6IFwibWlzc2luZ190YXNrc19kaXJcIixcbiAgICAgICAgICBzY29wZTogXCJzbGljZVwiLFxuICAgICAgICAgIHVuaXRJZCxcbiAgICAgICAgICBtZXNzYWdlOiBzbGljZS5kb25lXG4gICAgICAgICAgICA/IGBNaXNzaW5nIHRhc2tzIGRpcmVjdG9yeSBmb3IgJHt1bml0SWR9IChzbGljZSBpcyBjb21wbGV0ZSBcXHUyMDE0IGNvc21ldGljIG9ubHkpYFxuICAgICAgICAgICAgOiBgTWlzc2luZyB0YXNrcyBkaXJlY3RvcnkgZm9yICR7dW5pdElkfWAsXG4gICAgICAgICAgZmlsZTogcmVsU2xpY2VQYXRoKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgc2xpY2UuaWQpLFxuICAgICAgICAgIGZpeGFibGU6IHRydWUsXG4gICAgICAgIH0pO1xuICAgICAgICBpZiAoZml4KSB7XG4gICAgICAgICAgbWtkaXJTeW5jKGpvaW4oc2xpY2VQYXRoLCBcInRhc2tzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgICAgICBmaXhlc0FwcGxpZWQucHVzaChgY3JlYXRlZCAke2pvaW4oc2xpY2VQYXRoLCBcInRhc2tzXCIpfWApO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHBsYW5QYXRoID0gcmVzb2x2ZVNsaWNlRmlsZShiYXNlUGF0aCwgbWlsZXN0b25lSWQsIHNsaWNlLmlkLCBcIlBMQU5cIik7XG4gICAgICBjb25zdCBwbGFuQ29udGVudCA9IHBsYW5QYXRoID8gYXdhaXQgbG9hZEZpbGUocGxhblBhdGgpIDogbnVsbDtcbiAgICAgIC8vIE5vcm1hbGl6ZSBwbGFuIHRhc2tzOiBwcmVmZXIgREIsIGZhbGwgYmFjayB0byBwYXJzZXJzLWxlZ2FjeVxuICAgICAgbGV0IHBsYW46IHsgdGFza3M6IEFycmF5PHsgaWQ6IHN0cmluZzsgZG9uZTogYm9vbGVhbjsgdGl0bGU6IHN0cmluZzsgZXN0aW1hdGU/OiBzdHJpbmcgfT4gfSB8IG51bGwgPSBudWxsO1xuICAgICAgaWYgKGlzRGJBdmFpbGFibGUoKSkge1xuICAgICAgICBjb25zdCBkYlRhc2tzID0gZ2V0U2xpY2VUYXNrcyhtaWxlc3RvbmVJZCwgc2xpY2UuaWQpO1xuICAgICAgICBpZiAoZGJUYXNrcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgcGxhbiA9IHsgdGFza3M6IGRiVGFza3MubWFwKHQgPT4gKHsgaWQ6IHQuaWQsIGRvbmU6IHQuc3RhdHVzID09PSBcImNvbXBsZXRlXCIgfHwgdC5zdGF0dXMgPT09IFwiZG9uZVwiLCB0aXRsZTogdC50aXRsZSwgZXN0aW1hdGU6IHQuZXN0aW1hdGUgfHwgdW5kZWZpbmVkIH0pKSB9O1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBpZiAoIXBsYW4gJiYgcGxhbkNvbnRlbnQpIHtcbiAgICAgICAgcGxhbiA9IHBhcnNlTGVnYWN5UGxhbihwbGFuQ29udGVudCk7XG4gICAgICB9XG4gICAgICBpZiAoIXBsYW4pIHtcbiAgICAgICAgaWYgKCFzbGljZS5kb25lKSB7XG4gICAgICAgICAgaXNzdWVzLnB1c2goe1xuICAgICAgICAgICAgc2V2ZXJpdHk6IFwid2FybmluZ1wiLFxuICAgICAgICAgICAgY29kZTogXCJtaXNzaW5nX3NsaWNlX3BsYW5cIixcbiAgICAgICAgICAgIHNjb3BlOiBcInNsaWNlXCIsXG4gICAgICAgICAgICB1bml0SWQsXG4gICAgICAgICAgICBtZXNzYWdlOiBgU2xpY2UgJHt1bml0SWR9IGhhcyBubyBwbGFuIGZpbGVgLFxuICAgICAgICAgICAgZmlsZTogcmVsU2xpY2VGaWxlKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgc2xpY2UuaWQsIFwiUExBTlwiKSxcbiAgICAgICAgICAgIGZpeGFibGU6IGZhbHNlLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICAvLyBcdTI1MDBcdTI1MDAgRHVwbGljYXRlIHRhc2sgSURzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgICAgY29uc3QgdGFza0lkQ291bnRzID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgICAgIGZvciAoY29uc3QgdGFzayBvZiBwbGFuLnRhc2tzKSB0YXNrSWRDb3VudHMuc2V0KHRhc2suaWQsICh0YXNrSWRDb3VudHMuZ2V0KHRhc2suaWQpID8/IDApICsgMSk7XG4gICAgICBmb3IgKGNvbnN0IFt0YXNrSWQsIGNvdW50XSBvZiB0YXNrSWRDb3VudHMpIHtcbiAgICAgICAgaWYgKGNvdW50ID4gMSkge1xuICAgICAgICAgIGlzc3Vlcy5wdXNoKHsgc2V2ZXJpdHk6IFwiZXJyb3JcIiwgY29kZTogXCJkdXBsaWNhdGVfdGFza19pZFwiLCBzY29wZTogXCJzbGljZVwiLCB1bml0SWQsXG4gICAgICAgICAgICBtZXNzYWdlOiBgVGFzayBJRCBcIiR7dGFza0lkfVwiIGFwcGVhcnMgJHtjb3VudH0gdGltZXMgaW4gJHtzbGljZS5pZH0tUExBTi5tZCBcdTIwMTQgZHVwbGljYXRlIElEcyBjYXVzZSBkaXNwYXRjaCBmYWlsdXJlc2AsXG4gICAgICAgICAgICBmaWxlOiByZWxTbGljZUZpbGUoYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBzbGljZS5pZCwgXCJQTEFOXCIpLCBmaXhhYmxlOiBmYWxzZSB9KTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBcdTI1MDBcdTI1MDAgVGFzayBmaWxlcyBvbiBkaXNrIG5vdCBpbiBwbGFuIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgICAgdHJ5IHtcbiAgICAgICAgaWYgKHRhc2tzRGlyKSB7XG4gICAgICAgICAgY29uc3QgcGxhblRhc2tJZHMgPSBuZXcgU2V0KHBsYW4udGFza3MubWFwKHQgPT4gdC5pZCkpO1xuICAgICAgICAgIGZvciAoY29uc3QgZiBvZiByZWFkZGlyU3luYyh0YXNrc0RpcikpIHtcbiAgICAgICAgICAgIGlmICghZi5lbmRzV2l0aChcIi1TVU1NQVJZLm1kXCIpKSBjb250aW51ZTtcbiAgICAgICAgICAgIGNvbnN0IGRpc2tUYXNrSWQgPSBmLnJlcGxhY2UoLy1TVU1NQVJZXFwubWQkLywgXCJcIik7XG4gICAgICAgICAgICBpZiAoIXBsYW5UYXNrSWRzLmhhcyhkaXNrVGFza0lkKSkge1xuICAgICAgICAgICAgICBpc3N1ZXMucHVzaCh7IHNldmVyaXR5OiBcImluZm9cIiwgY29kZTogXCJ0YXNrX2ZpbGVfbm90X2luX3BsYW5cIiwgc2NvcGU6IFwic2xpY2VcIiwgdW5pdElkLFxuICAgICAgICAgICAgICAgIG1lc3NhZ2U6IGBUYXNrIHN1bW1hcnkgXCIke2Z9XCIgZXhpc3RzIG9uIGRpc2sgYnV0IFwiJHtkaXNrVGFza0lkfVwiIGlzIG5vdCBpbiAke3NsaWNlLmlkfS1QTEFOLm1kYCxcbiAgICAgICAgICAgICAgICBmaWxlOiByZWxUYXNrRmlsZShiYXNlUGF0aCwgbWlsZXN0b25lSWQsIHNsaWNlLmlkLCBkaXNrVGFza0lkLCBcIlNVTU1BUllcIiksIGZpeGFibGU6IGZhbHNlIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCB7IC8qIG5vbi1mYXRhbCAqLyB9XG5cbiAgICAgIGxldCBhbGxUYXNrc0RvbmUgPSBwbGFuLnRhc2tzLmxlbmd0aCA+IDA7XG4gICAgICBmb3IgKGNvbnN0IHRhc2sgb2YgcGxhbi50YXNrcykge1xuICAgICAgICBjb25zdCB0YXNrVW5pdElkID0gYCR7dW5pdElkfS8ke3Rhc2suaWR9YDtcbiAgICAgICAgY29uc3Qgc3VtbWFyeVBhdGggPSByZXNvbHZlVGFza0ZpbGUoYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBzbGljZS5pZCwgdGFzay5pZCwgXCJTVU1NQVJZXCIpO1xuICAgICAgICBjb25zdCBoYXNTdW1tYXJ5ID0gISEoc3VtbWFyeVBhdGggJiYgYXdhaXQgbG9hZEZpbGUoc3VtbWFyeVBhdGgpKTtcblxuICAgICAgICAvLyBNdXN0LWhhdmUgdmVyaWZpY2F0aW9uXG4gICAgICAgIGlmICh0YXNrLmRvbmUgJiYgaGFzU3VtbWFyeSkge1xuICAgICAgICAgIGNvbnN0IHRhc2tQbGFuUGF0aCA9IHJlc29sdmVUYXNrRmlsZShiYXNlUGF0aCwgbWlsZXN0b25lSWQsIHNsaWNlLmlkLCB0YXNrLmlkLCBcIlBMQU5cIik7XG4gICAgICAgICAgaWYgKHRhc2tQbGFuUGF0aCkge1xuICAgICAgICAgICAgY29uc3QgdGFza1BsYW5Db250ZW50ID0gYXdhaXQgbG9hZEZpbGUodGFza1BsYW5QYXRoKTtcbiAgICAgICAgICAgIGlmICh0YXNrUGxhbkNvbnRlbnQpIHtcbiAgICAgICAgICAgICAgY29uc3QgbXVzdEhhdmVzID0gcGFyc2VUYXNrUGxhbk11c3RIYXZlcyh0YXNrUGxhbkNvbnRlbnQpO1xuICAgICAgICAgICAgICBpZiAobXVzdEhhdmVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICBjb25zdCBzdW1tYXJ5Q29udGVudCA9IGF3YWl0IGxvYWRGaWxlKHN1bW1hcnlQYXRoISk7XG4gICAgICAgICAgICAgICAgY29uc3QgbWVudGlvbmVkQ291bnQgPSBzdW1tYXJ5Q29udGVudFxuICAgICAgICAgICAgICAgICAgPyBjb3VudE11c3RIYXZlc01lbnRpb25lZEluU3VtbWFyeShtdXN0SGF2ZXMsIHN1bW1hcnlDb250ZW50KVxuICAgICAgICAgICAgICAgICAgOiAwO1xuICAgICAgICAgICAgICAgIGlmIChtZW50aW9uZWRDb3VudCA8IG11c3RIYXZlcy5sZW5ndGgpIHtcbiAgICAgICAgICAgICAgICAgIGlzc3Vlcy5wdXNoKHtcbiAgICAgICAgICAgICAgICAgICAgc2V2ZXJpdHk6IFwid2FybmluZ1wiLFxuICAgICAgICAgICAgICAgICAgICBjb2RlOiBcInRhc2tfZG9uZV9tdXN0X2hhdmVzX25vdF92ZXJpZmllZFwiLFxuICAgICAgICAgICAgICAgICAgICBzY29wZTogXCJ0YXNrXCIsXG4gICAgICAgICAgICAgICAgICAgIHVuaXRJZDogdGFza1VuaXRJZCxcbiAgICAgICAgICAgICAgICAgICAgbWVzc2FnZTogYFRhc2sgJHt0YXNrLmlkfSBoYXMgJHttdXN0SGF2ZXMubGVuZ3RofSBtdXN0LWhhdmVzIGJ1dCBzdW1tYXJ5IGFkZHJlc3NlcyBvbmx5ICR7bWVudGlvbmVkQ291bnR9YCxcbiAgICAgICAgICAgICAgICAgICAgZmlsZTogcmVsVGFza0ZpbGUoYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBzbGljZS5pZCwgdGFzay5pZCwgXCJTVU1NQVJZXCIpLFxuICAgICAgICAgICAgICAgICAgICBmaXhhYmxlOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vIFx1MjUwMFx1MjUwMCBGdXR1cmUgdGltZXN0YW1wIGNoZWNrIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgICAgICBpZiAodGFzay5kb25lICYmIGhhc1N1bW1hcnkgJiYgc3VtbWFyeVBhdGgpIHtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgcmF3U3VtbWFyeSA9IGF3YWl0IGxvYWRGaWxlKHN1bW1hcnlQYXRoKTtcbiAgICAgICAgICAgIGNvbnN0IG0gPSByYXdTdW1tYXJ5Py5tYXRjaCgvXmNvbXBsZXRlZF9hdDpcXHMqKC4rKSQvbSk7XG4gICAgICAgICAgICBpZiAobSkge1xuICAgICAgICAgICAgICBjb25zdCB0cyA9IG5ldyBEYXRlKG1bMV0udHJpbSgpKTtcbiAgICAgICAgICAgICAgaWYgKCFpc05hTih0cy5nZXRUaW1lKCkpICYmIHRzLmdldFRpbWUoKSA+IERhdGUubm93KCkgKyAyNCAqIDYwICogNjAgKiAxMDAwKSB7XG4gICAgICAgICAgICAgICAgaXNzdWVzLnB1c2goeyBzZXZlcml0eTogXCJ3YXJuaW5nXCIsIGNvZGU6IFwiZnV0dXJlX3RpbWVzdGFtcFwiLCBzY29wZTogXCJ0YXNrXCIsIHVuaXRJZDogdGFza1VuaXRJZCxcbiAgICAgICAgICAgICAgICAgIG1lc3NhZ2U6IGBUYXNrICR7dGFzay5pZH0gaGFzIGNvbXBsZXRlZF9hdCBcIiR7bVsxXS50cmltKCl9XCIgd2hpY2ggaXMgbW9yZSB0aGFuIDI0aCBpbiB0aGUgZnV0dXJlYCxcbiAgICAgICAgICAgICAgICAgIGZpbGU6IHJlbFRhc2tGaWxlKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgc2xpY2UuaWQsIHRhc2suaWQsIFwiU1VNTUFSWVwiKSwgZml4YWJsZTogZmFsc2UgfSk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGNhdGNoIHsgLyogbm9uLWZhdGFsICovIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGFsbFRhc2tzRG9uZSA9IGFsbFRhc2tzRG9uZSAmJiB0YXNrLmRvbmU7XG4gICAgICB9XG5cbiAgICAgIC8vIEJsb2NrZXItd2l0aG91dC1yZXBsYW4gZGV0ZWN0aW9uXG4gICAgICAvLyBTa2lwIHdoZW4gYWxsIHRhc2tzIGFyZSBkb25lIFx1MjAxNCB0aGUgYmxvY2tlciB3YXMgaW1wbGljaXRseSByZXNvbHZlZFxuICAgICAgLy8gd2l0aGluIHRoZSB0YXNrIGFuZCB0aGUgc2xpY2UgaXMgbm90IHN0dWNrICgjMzEwNSBCdWcgMikuXG4gICAgICBjb25zdCByZXBsYW5QYXRoID0gcmVzb2x2ZVNsaWNlRmlsZShiYXNlUGF0aCwgbWlsZXN0b25lSWQsIHNsaWNlLmlkLCBcIlJFUExBTlwiKTtcbiAgICAgIGlmICghcmVwbGFuUGF0aCAmJiAhYWxsVGFza3NEb25lKSB7XG4gICAgICAgIGZvciAoY29uc3QgdGFzayBvZiBwbGFuLnRhc2tzKSB7XG4gICAgICAgICAgaWYgKCF0YXNrLmRvbmUpIGNvbnRpbnVlO1xuICAgICAgICAgIGNvbnN0IHN1bW1hcnlQYXRoID0gcmVzb2x2ZVRhc2tGaWxlKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgc2xpY2UuaWQsIHRhc2suaWQsIFwiU1VNTUFSWVwiKTtcbiAgICAgICAgICBpZiAoIXN1bW1hcnlQYXRoKSBjb250aW51ZTtcbiAgICAgICAgICBjb25zdCBzdW1tYXJ5Q29udGVudCA9IGF3YWl0IGxvYWRGaWxlKHN1bW1hcnlQYXRoKTtcbiAgICAgICAgICBpZiAoIXN1bW1hcnlDb250ZW50KSBjb250aW51ZTtcbiAgICAgICAgICBjb25zdCBzdW1tYXJ5ID0gcGFyc2VTdW1tYXJ5KHN1bW1hcnlDb250ZW50KTtcbiAgICAgICAgICBpZiAoc3VtbWFyeS5mcm9udG1hdHRlci5ibG9ja2VyX2Rpc2NvdmVyZWQpIHtcbiAgICAgICAgICAgIGlzc3Vlcy5wdXNoKHtcbiAgICAgICAgICAgICAgc2V2ZXJpdHk6IFwid2FybmluZ1wiLFxuICAgICAgICAgICAgICBjb2RlOiBcImJsb2NrZXJfZGlzY292ZXJlZF9ub19yZXBsYW5cIixcbiAgICAgICAgICAgICAgc2NvcGU6IFwic2xpY2VcIixcbiAgICAgICAgICAgICAgdW5pdElkLFxuICAgICAgICAgICAgICBtZXNzYWdlOiBgVGFzayAke3Rhc2suaWR9IHJlcG9ydGVkIGJsb2NrZXJfZGlzY292ZXJlZCBidXQgbm8gUkVQTEFOLm1kIGV4aXN0cyBmb3IgJHtzbGljZS5pZH0gXFx1MjAxNCBzbGljZSBtYXkgYmUgc3R1Y2tgLFxuICAgICAgICAgICAgICBmaWxlOiByZWxTbGljZUZpbGUoYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBzbGljZS5pZCwgXCJSRVBMQU5cIiksXG4gICAgICAgICAgICAgIGZpeGFibGU6IGZhbHNlLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gXHUyNTAwXHUyNTAwIFN0YWxlIFJFUExBTjogZXhpc3RzIGJ1dCBhbGwgdGFza3MgZG9uZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgICAgIGlmIChyZXBsYW5QYXRoICYmIGFsbFRhc2tzRG9uZSkge1xuICAgICAgICBpc3N1ZXMucHVzaCh7IHNldmVyaXR5OiBcImluZm9cIiwgY29kZTogXCJzdGFsZV9yZXBsYW5fZmlsZVwiLCBzY29wZTogXCJzbGljZVwiLCB1bml0SWQsXG4gICAgICAgICAgbWVzc2FnZTogYCR7c2xpY2UuaWR9IGhhcyBhIFJFUExBTi5tZCBidXQgYWxsIHRhc2tzIGFyZSBkb25lIFx1MjAxNCBSRVBMQU4ubWQgbWF5IGJlIHN0YWxlYCxcbiAgICAgICAgICBmaWxlOiByZWxTbGljZUZpbGUoYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBzbGljZS5pZCwgXCJSRVBMQU5cIiksIGZpeGFibGU6IGZhbHNlIH0pO1xuICAgICAgfVxuXG4gICAgfVxuXG4gICAgLy8gTWlsZXN0b25lLWxldmVsIGNoZWNrOiBhbGwgc2xpY2VzIGRvbmUgYnV0IG5vIHZhbGlkYXRpb24gZmlsZVxuICAgIGNvbnN0IG1pbGVzdG9uZUNvbXBsZXRlID0gcm9hZG1hcC5zbGljZXMubGVuZ3RoID4gMCAmJiByb2FkbWFwLnNsaWNlcy5ldmVyeShzID0+IHMuZG9uZSk7XG4gICAgaWYgKG1pbGVzdG9uZUNvbXBsZXRlICYmICFyZXNvbHZlTWlsZXN0b25lRmlsZShiYXNlUGF0aCwgbWlsZXN0b25lSWQsIFwiVkFMSURBVElPTlwiKSAmJiAhcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBcIlNVTU1BUllcIikpIHtcbiAgICAgIGlzc3Vlcy5wdXNoKHtcbiAgICAgICAgc2V2ZXJpdHk6IFwiaW5mb1wiLFxuICAgICAgICBjb2RlOiBcImFsbF9zbGljZXNfZG9uZV9taXNzaW5nX21pbGVzdG9uZV92YWxpZGF0aW9uXCIsXG4gICAgICAgIHNjb3BlOiBcIm1pbGVzdG9uZVwiLFxuICAgICAgICB1bml0SWQ6IG1pbGVzdG9uZUlkLFxuICAgICAgICBtZXNzYWdlOiBgQWxsIHNsaWNlcyBhcmUgZG9uZSBidXQgJHttaWxlc3RvbmVJZH0tVkFMSURBVElPTi5tZCBpcyBtaXNzaW5nIFxcdTIwMTQgbWlsZXN0b25lIGlzIGluIHZhbGlkYXRpbmctbWlsZXN0b25lIHBoYXNlYCxcbiAgICAgICAgZmlsZTogcmVsTWlsZXN0b25lRmlsZShiYXNlUGF0aCwgbWlsZXN0b25lSWQsIFwiVkFMSURBVElPTlwiKSxcbiAgICAgICAgZml4YWJsZTogZmFsc2UsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyBNaWxlc3RvbmUtbGV2ZWwgY2hlY2s6IGFsbCBzbGljZXMgZG9uZSBidXQgbm8gbWlsZXN0b25lIHN1bW1hcnlcbiAgICBpZiAobWlsZXN0b25lQ29tcGxldGUgJiYgIXJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgXCJTVU1NQVJZXCIpKSB7XG4gICAgICBpc3N1ZXMucHVzaCh7XG4gICAgICAgIHNldmVyaXR5OiBcIndhcm5pbmdcIixcbiAgICAgICAgY29kZTogXCJhbGxfc2xpY2VzX2RvbmVfbWlzc2luZ19taWxlc3RvbmVfc3VtbWFyeVwiLFxuICAgICAgICBzY29wZTogXCJtaWxlc3RvbmVcIixcbiAgICAgICAgdW5pdElkOiBtaWxlc3RvbmVJZCxcbiAgICAgICAgbWVzc2FnZTogYEFsbCBzbGljZXMgYXJlIGRvbmUgYnV0ICR7bWlsZXN0b25lSWR9LVNVTU1BUlkubWQgaXMgbWlzc2luZyBcXHUyMDE0IG1pbGVzdG9uZSBpcyBzdHVjayBpbiBjb21wbGV0aW5nLW1pbGVzdG9uZSBwaGFzZWAsXG4gICAgICAgIGZpbGU6IHJlbE1pbGVzdG9uZUZpbGUoYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBcIlNVTU1BUllcIiksXG4gICAgICAgIGZpeGFibGU6IGZhbHNlLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgaWYgKGZpeCAmJiAhZHJ5UnVuICYmIGZpeGVzQXBwbGllZC5sZW5ndGggPiAwKSB7XG4gICAgYXdhaXQgdXBkYXRlU3RhdGVGaWxlKGJhc2VQYXRoLCBmaXhlc0FwcGxpZWQpO1xuICB9XG5cbiAgY29uc3QgcmVwb3J0OiBEb2N0b3JSZXBvcnQgPSB7XG4gICAgb2s6IGlzc3Vlcy5ldmVyeShpc3N1ZSA9PiBpc3N1ZS5zZXZlcml0eSAhPT0gXCJlcnJvclwiKSxcbiAgICBiYXNlUGF0aCxcbiAgICBpc3N1ZXMsXG4gICAgZml4ZXNBcHBsaWVkLFxuICAgIHRpbWluZzogeyBnaXQ6IGdpdE1zLCBydW50aW1lOiBydW50aW1lTXMsIGVudmlyb25tZW50OiBlbnZNcywgZ3NkU3RhdGU6IE1hdGgubWF4KDAsIERhdGUubm93KCkgLSB0MGVudiAtIGVudk1zKSB9LFxuICB9O1xuICBhd2FpdCBhcHBlbmREb2N0b3JIaXN0b3J5KGJhc2VQYXRoLCByZXBvcnQpO1xuICByZXR1cm4gcmVwb3J0O1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxZQUFZLFdBQVcsV0FBVyxhQUFhLG9CQUFvQjtBQUM1RSxTQUFTLFlBQVk7QUFFckIsU0FBUyxVQUFVLGNBQWMsVUFBVSx3QkFBd0Isd0NBQXdDO0FBQzNHLFNBQVMsZ0JBQWdCLG9CQUFvQixhQUFhLHVCQUF1QjtBQUNqRixTQUFTLGVBQWUsY0FBYyxvQkFBb0IscUJBQXFCO0FBQy9FLFNBQVMsc0JBQXNCLHNCQUFzQixrQkFBa0Isa0JBQWtCLGlCQUFpQixpQkFBaUIsZUFBZSxTQUFTLGtCQUFrQixjQUFjLGFBQWEsY0FBYyxnQkFBZ0Isb0JBQW9CLGtCQUFrQiw4QkFBOEI7QUFDbFMsU0FBUyxhQUFhLDJCQUEyQjtBQUNqRCxTQUFTLDJCQUEyQjtBQUNwQyxTQUFTLG1DQUF3RDtBQUNqRSxTQUFTLHNCQUFzQjtBQUcvQixTQUFTLDBCQUEwQjtBQUVuQyxTQUFTLGdCQUFnQixvQkFBb0IsbUJBQW1CLHlCQUF5QjtBQUN6RixTQUFTLDhCQUE4QjtBQUN2QyxTQUFTLHlCQUF5QjtBQUNsQyxTQUFTLHFCQUFxQjtBQU05QixTQUFTLHVCQUF1QixvQkFBb0Isb0JBQW9CLDZCQUE2Qiw4QkFBOEI7QUFDbkksU0FBUyxzQkFBc0IsMEJBQTBCLCtCQUE0RDtBQUNySCxTQUFTLHNCQUFzQixpQ0FBaUMsb0JBQW9CLDRCQUFvRTtBQUV4SixTQUFTLGlCQUFBQSxzQkFBcUI7QUFFOUIsU0FBUyx3QkFBd0IsYUFBdUM7QUFDdEUsUUFBTSxTQUFtQixDQUFDO0FBQzFCLFFBQU0sYUFBYSxDQUFDLHFCQUFxQixpQkFBaUIsZ0JBQWdCLHFCQUFxQjtBQUMvRixhQUFXLFNBQVMs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
