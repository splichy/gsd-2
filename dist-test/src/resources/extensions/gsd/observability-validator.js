import { loadFile } from "./files.js";
import { resolveSliceFile, resolveTaskFile, resolveTasksDir, resolveTaskFiles } from "./paths.js";
function getSection(content, heading, level = 2) {
  const prefix = "#".repeat(level) + " ";
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${prefix}${escaped}\\s*$`, "m");
  const match = regex.exec(content);
  if (!match) return null;
  const start = match.index + match[0].length;
  const rest = content.slice(start);
  const nextHeading = rest.match(new RegExp(`^#{1,${level}} `, "m"));
  const end = nextHeading ? nextHeading.index : rest.length;
  return rest.slice(0, end).trim();
}
function getFrontmatter(content) {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return null;
  const afterFirst = trimmed.indexOf("\n");
  if (afterFirst === -1) return null;
  const rest = trimmed.slice(afterFirst + 1);
  const endIdx = rest.indexOf("\n---");
  if (endIdx === -1) return null;
  return rest.slice(0, endIdx);
}
function hasFrontmatterKey(content, key) {
  const fm = getFrontmatter(content);
  if (!fm) return false;
  return new RegExp(`^${key}:`, "m").test(fm);
}
function normalizeMeaningfulLines(text) {
  return text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0).filter((line) => !line.startsWith("<!--")).filter((line) => !line.endsWith("-->")).filter((line) => !/^[-*]\s*\{\{.+\}\}$/.test(line)).filter((line) => !/^\{\{.+\}\}$/.test(line));
}
function sectionLooksPlaceholderOnly(text) {
  if (!text) return true;
  const lines = normalizeMeaningfulLines(text).map((line) => line.replace(/^[-*]\s+/, "").trim()).filter((line) => line.length > 0);
  if (lines.length === 0) return true;
  return lines.every((line) => {
    const lower = line.toLowerCase();
    return lower === "none" || lower.endsWith(": none") || lower.includes("{{") || lower.includes("}}") || lower.startsWith("required for non-trivial") || lower.startsWith("describe how a future agent") || lower.startsWith("prefer:") || lower.startsWith("keep this section concise");
  });
}
function textSuggestsObservabilityRelevant(content) {
  const lower = content.toLowerCase();
  const needles = [
    " api",
    "route",
    "server",
    "worker",
    "queue",
    "job",
    "sync",
    "import",
    "webhook",
    "auth",
    "db",
    "database",
    "migration",
    "cache",
    "background",
    "polling",
    "realtime",
    "socket",
    "stateful",
    "integration",
    "ui",
    "form",
    "submit",
    "status",
    "service",
    "pipeline",
    "health endpoint",
    "error path"
  ];
  return needles.some((needle) => lower.includes(needle));
}
function verificationMentionsDiagnostics(section) {
  if (!section) return false;
  const lower = section.toLowerCase();
  const needles = [
    "error",
    "failure",
    "diagnostic",
    "status",
    "health",
    "inspect",
    "log",
    "network",
    "console",
    "retry",
    "last error",
    "correlation",
    "readiness"
  ];
  return needles.some((needle) => lower.includes(needle));
}
function validateSlicePlanContent(file, content) {
  const issues = [];
  const tasksSection = getSection(content, "Tasks", 2);
  if (tasksSection) {
    const lines = tasksSection.split("\n");
    const taskLinePattern = /^- \[[ x]\] \*\*T\d+:/;
    const taskLineIndices = [];
    for (let i = 0; i < lines.length; i++) {
      if (taskLinePattern.test(lines[i])) taskLineIndices.push(i);
    }
    for (let t = 0; t < taskLineIndices.length; t++) {
      const start = taskLineIndices[t];
      const end = t + 1 < taskLineIndices.length ? taskLineIndices[t + 1] : lines.length;
      const bodyLines = lines.slice(start + 1, end);
      const meaningful = bodyLines.filter((l) => l.trim().length > 0);
      if (meaningful.length === 0) {
        issues.push({
          severity: "warning",
          scope: "slice-plan",
          file,
          ruleId: "empty_task_entry",
          message: "Inline task entry has no description content beneath the checkbox line.",
          suggestion: "Add at least a Why/Files/Do/Verify summary so the task is self-describing."
        });
      }
    }
  }
  const relevant = textSuggestsObservabilityRelevant(content);
  if (!relevant) return issues;
  const obs = getSection(content, "Observability / Diagnostics", 2);
  const verification = getSection(content, "Verification", 2);
  if (!obs) {
    issues.push({
      severity: "warning",
      scope: "slice-plan",
      file,
      ruleId: "missing_observability_section",
      message: "Slice plan appears non-trivial but is missing `## Observability / Diagnostics`.",
      suggestion: "Add runtime signals, inspection surfaces, failure visibility, and redaction constraints."
    });
  } else if (sectionLooksPlaceholderOnly(obs)) {
    issues.push({
      severity: "warning",
      scope: "slice-plan",
      file,
      ruleId: "observability_section_placeholder_only",
      message: "Slice plan has `## Observability / Diagnostics` but it still looks like placeholder text.",
      suggestion: "Replace placeholders with concrete signals and inspection surfaces a future agent should trust."
    });
  }
  if (!verificationMentionsDiagnostics(verification)) {
    issues.push({
      severity: "warning",
      scope: "slice-plan",
      file,
      ruleId: "verification_missing_diagnostic_check",
      message: "Slice verification does not appear to include any diagnostic or failure-path check.",
      suggestion: "Add at least one verification step for inspectable failure state, structured error output, status surface, or equivalent."
    });
  }
  return issues;
}
function validateTaskPlanContent(file, content) {
  const issues = [];
  const stepsSection = getSection(content, "Steps", 2);
  if (stepsSection === null || sectionLooksPlaceholderOnly(stepsSection)) {
    issues.push({
      severity: "warning",
      scope: "task-plan",
      file,
      ruleId: "empty_steps_section",
      message: "Task plan has an empty or missing `## Steps` section.",
      suggestion: "Add concrete numbered implementation steps so execution has a clear sequence."
    });
  }
  const verificationSection = getSection(content, "Verification", 2);
  if (verificationSection !== null && sectionLooksPlaceholderOnly(verificationSection)) {
    issues.push({
      severity: "warning",
      scope: "task-plan",
      file,
      ruleId: "placeholder_verification",
      message: "Task plan has `## Verification` but it still looks like placeholder text.",
      suggestion: "Replace placeholders with concrete verification commands, test runs, or observable checks."
    });
  }
  const fm = getFrontmatter(content);
  if (fm) {
    const stepsMatch = fm.match(/^estimated_steps:\s*(\d+)/m);
    const filesMatch = fm.match(/^estimated_files:\s*(\d+)/m);
    if (stepsMatch) {
      const estimatedSteps = parseInt(stepsMatch[1], 10);
      if (estimatedSteps >= 10) {
        issues.push({
          severity: "warning",
          scope: "task-plan",
          file,
          ruleId: "scope_estimate_steps_high",
          message: `Task plan estimates ${estimatedSteps} steps (threshold: 10). Consider splitting into smaller tasks.`,
          suggestion: "Break the task into sub-tasks or reduce scope so each task stays focused and completable in one pass."
        });
      }
    }
    if (filesMatch) {
      const estimatedFiles = parseInt(filesMatch[1], 10);
      if (estimatedFiles >= 12) {
        issues.push({
          severity: "warning",
          scope: "task-plan",
          file,
          ruleId: "scope_estimate_files_high",
          message: `Task plan estimates ${estimatedFiles} files (threshold: 12). Consider splitting into smaller tasks.`,
          suggestion: "Break the task into sub-tasks or reduce scope to keep the change footprint manageable."
        });
      }
    }
  }
  const inputsSection = getSection(content, "Inputs", 2);
  const outputSection = getSection(content, "Expected Output", 2);
  const backtickPathPattern = /`[^`]*[./][^`]*`/;
  if (outputSection === null || !backtickPathPattern.test(outputSection)) {
    issues.push({
      severity: "warning",
      scope: "task-plan",
      file,
      ruleId: "missing_output_file_paths",
      message: "Task plan `## Expected Output` is missing or has no backtick-wrapped file paths.",
      suggestion: "List concrete output file paths in backticks (e.g. `src/types.ts`). These are machine-parsed to derive task dependencies."
    });
  }
  if (inputsSection !== null && inputsSection.trim().length > 0 && !backtickPathPattern.test(inputsSection)) {
    issues.push({
      severity: "info",
      scope: "task-plan",
      file,
      ruleId: "missing_input_file_paths",
      message: "Task plan `## Inputs` has content but no backtick-wrapped file paths.",
      suggestion: "List input file paths in backticks (e.g. `src/config.json`). These are machine-parsed to derive task dependencies."
    });
  }
  const relevant = textSuggestsObservabilityRelevant(content);
  if (!relevant) return issues;
  const obs = getSection(content, "Observability Impact", 2);
  if (!obs) {
    issues.push({
      severity: "warning",
      scope: "task-plan",
      file,
      ruleId: "missing_observability_impact",
      message: "Task plan appears runtime-relevant but is missing `## Observability Impact`.",
      suggestion: "Explain what signals change, how a future agent inspects this task, and what failure state becomes visible."
    });
  } else if (sectionLooksPlaceholderOnly(obs)) {
    issues.push({
      severity: "warning",
      scope: "task-plan",
      file,
      ruleId: "observability_impact_placeholder_only",
      message: "Task plan has `## Observability Impact` but it still looks empty or placeholder-only.",
      suggestion: "Fill in concrete inspection surfaces or explicitly justify why observability is not applicable."
    });
  }
  return issues;
}
function validateTaskSummaryContent(file, content) {
  const issues = [];
  if (!hasFrontmatterKey(content, "observability_surfaces")) {
    issues.push({
      severity: "warning",
      scope: "task-summary",
      file,
      ruleId: "missing_observability_frontmatter",
      message: "Task summary is missing `observability_surfaces` in frontmatter.",
      suggestion: "List the durable status/log/error surfaces a future agent should use."
    });
  }
  const diagnostics = getSection(content, "Diagnostics", 2);
  if (!diagnostics) {
    issues.push({
      severity: "warning",
      scope: "task-summary",
      file,
      ruleId: "missing_diagnostics_section",
      message: "Task summary is missing `## Diagnostics`.",
      suggestion: "Document how to inspect what this task built later."
    });
  } else if (sectionLooksPlaceholderOnly(diagnostics)) {
    issues.push({
      severity: "warning",
      scope: "task-summary",
      file,
      ruleId: "diagnostics_placeholder_only",
      message: "Task summary diagnostics section still looks like placeholder text.",
      suggestion: "Replace placeholders with concrete commands, endpoints, logs, error shapes, or failure artifacts."
    });
  }
  const evidence = getSection(content, "Verification Evidence", 2);
  if (!evidence) {
    issues.push({
      severity: "warning",
      scope: "task-summary",
      file,
      ruleId: "evidence_block_missing",
      message: "Task summary is missing `## Verification Evidence`.",
      suggestion: "Add a verification evidence table showing gate check results (command, exit code, verdict, duration)."
    });
  } else if (sectionLooksPlaceholderOnly(evidence)) {
    issues.push({
      severity: "warning",
      scope: "task-summary",
      file,
      ruleId: "evidence_block_placeholder",
      message: "Task summary verification evidence section still looks like placeholder text.",
      suggestion: "Replace placeholders with actual gate results or note that no verification commands were discovered."
    });
  }
  return issues;
}
function validateSliceSummaryContent(file, content) {
  const issues = [];
  if (!hasFrontmatterKey(content, "observability_surfaces")) {
    issues.push({
      severity: "warning",
      scope: "slice-summary",
      file,
      ruleId: "missing_observability_frontmatter",
      message: "Slice summary is missing `observability_surfaces` in frontmatter.",
      suggestion: "List the authoritative diagnostics and durable inspection surfaces for this slice."
    });
  }
  const diagnostics = getSection(content, "Authoritative diagnostics", 3);
  if (!diagnostics) {
    issues.push({
      severity: "warning",
      scope: "slice-summary",
      file,
      ruleId: "missing_authoritative_diagnostics",
      message: "Slice summary is missing `### Authoritative diagnostics` in Forward Intelligence.",
      suggestion: "Tell future agents where to look first and why that signal is trustworthy."
    });
  } else if (sectionLooksPlaceholderOnly(diagnostics)) {
    issues.push({
      severity: "warning",
      scope: "slice-summary",
      file,
      ruleId: "authoritative_diagnostics_placeholder_only",
      message: "Slice summary includes authoritative diagnostics but it still looks like placeholder text.",
      suggestion: "Replace placeholders with the real first-stop diagnostic surface for this slice."
    });
  }
  return issues;
}
async function validatePlanBoundary(basePath, milestoneId, sliceId) {
  const issues = [];
  const slicePlan = resolveSliceFile(basePath, milestoneId, sliceId, "PLAN");
  if (slicePlan) {
    const content = await loadFile(slicePlan);
    if (content) issues.push(...validateSlicePlanContent(slicePlan, content));
  }
  const tasksDir = resolveTasksDir(basePath, milestoneId, sliceId);
  const taskPlans = tasksDir ? resolveTaskFiles(tasksDir, "PLAN") : [];
  for (const file of taskPlans) {
    const taskId = file.split("-")[0];
    const taskPlan = resolveTaskFile(basePath, milestoneId, sliceId, taskId, "PLAN");
    if (!taskPlan) continue;
    const content = await loadFile(taskPlan);
    if (content) issues.push(...validateTaskPlanContent(taskPlan, content));
  }
  return issues;
}
async function validateExecuteBoundary(basePath, milestoneId, sliceId, taskId) {
  const issues = [];
  const slicePlan = resolveSliceFile(basePath, milestoneId, sliceId, "PLAN");
  if (slicePlan) {
    const content = await loadFile(slicePlan);
    if (content) issues.push(...validateSlicePlanContent(slicePlan, content));
  }
  const taskPlan = resolveTaskFile(basePath, milestoneId, sliceId, taskId, "PLAN");
  if (taskPlan) {
    const content = await loadFile(taskPlan);
    if (content) issues.push(...validateTaskPlanContent(taskPlan, content));
  }
  return issues;
}
async function validateCompleteBoundary(basePath, milestoneId, sliceId) {
  const issues = [];
  const tasksDir = resolveTasksDir(basePath, milestoneId, sliceId);
  const taskSummaries = tasksDir ? resolveTaskFiles(tasksDir, "SUMMARY") : [];
  for (const file of taskSummaries) {
    const taskId = file.split("-")[0];
    const taskSummary = resolveTaskFile(basePath, milestoneId, sliceId, taskId, "SUMMARY");
    if (!taskSummary) continue;
    const content = await loadFile(taskSummary);
    if (content) issues.push(...validateTaskSummaryContent(taskSummary, content));
  }
  const sliceSummary = resolveSliceFile(basePath, milestoneId, sliceId, "SUMMARY");
  if (sliceSummary) {
    const content = await loadFile(sliceSummary);
    if (content) issues.push(...validateSliceSummaryContent(sliceSummary, content));
  }
  return issues;
}
function formatValidationIssues(issues, limit = 4) {
  if (issues.length === 0) return "";
  const lines = issues.slice(0, limit).map((issue) => {
    const fileName = issue.file.split("/").pop() || issue.file;
    return `- ${fileName}: ${issue.message}`;
  });
  if (issues.length > limit) lines.push(`- ...and ${issues.length - limit} more`);
  return lines.join("\n");
}
export {
  formatValidationIssues,
  validateCompleteBoundary,
  validateExecuteBoundary,
  validatePlanBoundary,
  validateSlicePlanContent,
  validateSliceSummaryContent,
  validateTaskPlanContent,
  validateTaskSummaryContent
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9vYnNlcnZhYmlsaXR5LXZhbGlkYXRvci50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgbG9hZEZpbGUgfSBmcm9tIFwiLi9maWxlcy5qc1wiO1xuaW1wb3J0IHsgcmVzb2x2ZVNsaWNlRmlsZSwgcmVzb2x2ZVRhc2tGaWxlLCByZXNvbHZlVGFza3NEaXIsIHJlc29sdmVUYXNrRmlsZXMgfSBmcm9tIFwiLi9wYXRocy5qc1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIFZhbGlkYXRpb25Jc3N1ZSB7XG4gIHNldmVyaXR5OiBcImluZm9cIiB8IFwid2FybmluZ1wiIHwgXCJlcnJvclwiO1xuICBzY29wZTogXCJzbGljZS1wbGFuXCIgfCBcInRhc2stcGxhblwiIHwgXCJ0YXNrLXN1bW1hcnlcIiB8IFwic2xpY2Utc3VtbWFyeVwiO1xuICBmaWxlOiBzdHJpbmc7XG4gIHJ1bGVJZDogc3RyaW5nO1xuICBtZXNzYWdlOiBzdHJpbmc7XG4gIHN1Z2dlc3Rpb24/OiBzdHJpbmc7XG59XG5cbmZ1bmN0aW9uIGdldFNlY3Rpb24oY29udGVudDogc3RyaW5nLCBoZWFkaW5nOiBzdHJpbmcsIGxldmVsOiBudW1iZXIgPSAyKTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IHByZWZpeCA9IFwiI1wiLnJlcGVhdChsZXZlbCkgKyBcIiBcIjtcbiAgY29uc3QgZXNjYXBlZCA9IGhlYWRpbmcucmVwbGFjZSgvWy4qKz9eJHt9KCl8W1xcXVxcXFxdL2csIFwiXFxcXCQmXCIpO1xuICBjb25zdCByZWdleCA9IG5ldyBSZWdFeHAoYF4ke3ByZWZpeH0ke2VzY2FwZWR9XFxcXHMqJGAsIFwibVwiKTtcbiAgY29uc3QgbWF0Y2ggPSByZWdleC5leGVjKGNvbnRlbnQpO1xuICBpZiAoIW1hdGNoKSByZXR1cm4gbnVsbDtcblxuICBjb25zdCBzdGFydCA9IG1hdGNoLmluZGV4ICsgbWF0Y2hbMF0ubGVuZ3RoO1xuICBjb25zdCByZXN0ID0gY29udGVudC5zbGljZShzdGFydCk7XG4gIGNvbnN0IG5leHRIZWFkaW5nID0gcmVzdC5tYXRjaChuZXcgUmVnRXhwKGBeI3sxLCR7bGV2ZWx9fSBgLCBcIm1cIikpO1xuICBjb25zdCBlbmQgPSBuZXh0SGVhZGluZyA/IG5leHRIZWFkaW5nLmluZGV4ISA6IHJlc3QubGVuZ3RoO1xuICByZXR1cm4gcmVzdC5zbGljZSgwLCBlbmQpLnRyaW0oKTtcbn1cblxuZnVuY3Rpb24gZ2V0RnJvbnRtYXR0ZXIoY29udGVudDogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IHRyaW1tZWQgPSBjb250ZW50LnRyaW1TdGFydCgpO1xuICBpZiAoIXRyaW1tZWQuc3RhcnRzV2l0aChcIi0tLVwiKSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGFmdGVyRmlyc3QgPSB0cmltbWVkLmluZGV4T2YoXCJcXG5cIik7XG4gIGlmIChhZnRlckZpcnN0ID09PSAtMSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHJlc3QgPSB0cmltbWVkLnNsaWNlKGFmdGVyRmlyc3QgKyAxKTtcbiAgY29uc3QgZW5kSWR4ID0gcmVzdC5pbmRleE9mKFwiXFxuLS0tXCIpO1xuICBpZiAoZW5kSWR4ID09PSAtMSkgcmV0dXJuIG51bGw7XG4gIHJldHVybiByZXN0LnNsaWNlKDAsIGVuZElkeCk7XG59XG5cbmZ1bmN0aW9uIGhhc0Zyb250bWF0dGVyS2V5KGNvbnRlbnQ6IHN0cmluZywga2V5OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgZm0gPSBnZXRGcm9udG1hdHRlcihjb250ZW50KTtcbiAgaWYgKCFmbSkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gbmV3IFJlZ0V4cChgXiR7a2V5fTpgLCBcIm1cIikudGVzdChmbSk7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZU1lYW5pbmdmdWxMaW5lcyh0ZXh0OiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIHJldHVybiB0ZXh0XG4gICAgLnNwbGl0KFwiXFxuXCIpXG4gICAgLm1hcChsaW5lID0+IGxpbmUudHJpbSgpKVxuICAgIC5maWx0ZXIobGluZSA9PiBsaW5lLmxlbmd0aCA+IDApXG4gICAgLmZpbHRlcihsaW5lID0+ICFsaW5lLnN0YXJ0c1dpdGgoXCI8IS0tXCIpKVxuICAgIC5maWx0ZXIobGluZSA9PiAhbGluZS5lbmRzV2l0aChcIi0tPlwiKSlcbiAgICAuZmlsdGVyKGxpbmUgPT4gIS9eWy0qXVxccypcXHtcXHsuK1xcfVxcfSQvLnRlc3QobGluZSkpXG4gICAgLmZpbHRlcihsaW5lID0+ICEvXlxce1xcey4rXFx9XFx9JC8udGVzdChsaW5lKSk7XG59XG5cbmZ1bmN0aW9uIHNlY3Rpb25Mb29rc1BsYWNlaG9sZGVyT25seSh0ZXh0OiBzdHJpbmcgfCBudWxsKTogYm9vbGVhbiB7XG4gIGlmICghdGV4dCkgcmV0dXJuIHRydWU7XG4gIGNvbnN0IGxpbmVzID0gbm9ybWFsaXplTWVhbmluZ2Z1bExpbmVzKHRleHQpXG4gICAgLm1hcChsaW5lID0+IGxpbmUucmVwbGFjZSgvXlstKl1cXHMrLywgXCJcIikudHJpbSgpKVxuICAgIC5maWx0ZXIobGluZSA9PiBsaW5lLmxlbmd0aCA+IDApO1xuXG4gIGlmIChsaW5lcy5sZW5ndGggPT09IDApIHJldHVybiB0cnVlO1xuXG4gIHJldHVybiBsaW5lcy5ldmVyeShsaW5lID0+IHtcbiAgICBjb25zdCBsb3dlciA9IGxpbmUudG9Mb3dlckNhc2UoKTtcbiAgICByZXR1cm4gbG93ZXIgPT09IFwibm9uZVwiIHx8XG4gICAgICBsb3dlci5lbmRzV2l0aChcIjogbm9uZVwiKSB8fFxuICAgICAgbG93ZXIuaW5jbHVkZXMoXCJ7e1wiKSB8fFxuICAgICAgbG93ZXIuaW5jbHVkZXMoXCJ9fVwiKSB8fFxuICAgICAgbG93ZXIuc3RhcnRzV2l0aChcInJlcXVpcmVkIGZvciBub24tdHJpdmlhbFwiKSB8fFxuICAgICAgbG93ZXIuc3RhcnRzV2l0aChcImRlc2NyaWJlIGhvdyBhIGZ1dHVyZSBhZ2VudFwiKSB8fFxuICAgICAgbG93ZXIuc3RhcnRzV2l0aChcInByZWZlcjpcIikgfHxcbiAgICAgIGxvd2VyLnN0YXJ0c1dpdGgoXCJrZWVwIHRoaXMgc2VjdGlvbiBjb25jaXNlXCIpO1xuICB9KTtcbn1cblxuZnVuY3Rpb24gdGV4dFN1Z2dlc3RzT2JzZXJ2YWJpbGl0eVJlbGV2YW50KGNvbnRlbnQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBsb3dlciA9IGNvbnRlbnQudG9Mb3dlckNhc2UoKTtcbiAgY29uc3QgbmVlZGxlcyA9IFtcbiAgICBcIiBhcGlcIiwgXCJyb3V0ZVwiLCBcInNlcnZlclwiLCBcIndvcmtlclwiLCBcInF1ZXVlXCIsIFwiam9iXCIsIFwic3luY1wiLCBcImltcG9ydFwiLFxuICAgIFwid2ViaG9va1wiLCBcImF1dGhcIiwgXCJkYlwiLCBcImRhdGFiYXNlXCIsIFwibWlncmF0aW9uXCIsIFwiY2FjaGVcIiwgXCJiYWNrZ3JvdW5kXCIsXG4gICAgXCJwb2xsaW5nXCIsIFwicmVhbHRpbWVcIiwgXCJzb2NrZXRcIiwgXCJzdGF0ZWZ1bFwiLCBcImludGVncmF0aW9uXCIsIFwidWlcIiwgXCJmb3JtXCIsXG4gICAgXCJzdWJtaXRcIiwgXCJzdGF0dXNcIiwgXCJzZXJ2aWNlXCIsIFwicGlwZWxpbmVcIiwgXCJoZWFsdGggZW5kcG9pbnRcIiwgXCJlcnJvciBwYXRoXCJcbiAgXTtcbiAgcmV0dXJuIG5lZWRsZXMuc29tZShuZWVkbGUgPT4gbG93ZXIuaW5jbHVkZXMobmVlZGxlKSk7XG59XG5cbmZ1bmN0aW9uIHZlcmlmaWNhdGlvbk1lbnRpb25zRGlhZ25vc3RpY3Moc2VjdGlvbjogc3RyaW5nIHwgbnVsbCk6IGJvb2xlYW4ge1xuICBpZiAoIXNlY3Rpb24pIHJldHVybiBmYWxzZTtcbiAgY29uc3QgbG93ZXIgPSBzZWN0aW9uLnRvTG93ZXJDYXNlKCk7XG4gIGNvbnN0IG5lZWRsZXMgPSBbXG4gICAgXCJlcnJvclwiLCBcImZhaWx1cmVcIiwgXCJkaWFnbm9zdGljXCIsIFwic3RhdHVzXCIsIFwiaGVhbHRoXCIsIFwiaW5zcGVjdFwiLCBcImxvZ1wiLFxuICAgIFwibmV0d29ya1wiLCBcImNvbnNvbGVcIiwgXCJyZXRyeVwiLCBcImxhc3QgZXJyb3JcIiwgXCJjb3JyZWxhdGlvblwiLCBcInJlYWRpbmVzc1wiXG4gIF07XG4gIHJldHVybiBuZWVkbGVzLnNvbWUobmVlZGxlID0+IGxvd2VyLmluY2x1ZGVzKG5lZWRsZSkpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdmFsaWRhdGVTbGljZVBsYW5Db250ZW50KGZpbGU6IHN0cmluZywgY29udGVudDogc3RyaW5nKTogVmFsaWRhdGlvbklzc3VlW10ge1xuICBjb25zdCBpc3N1ZXM6IFZhbGlkYXRpb25Jc3N1ZVtdID0gW107XG5cbiAgLy8gXHUyNTAwXHUyNTAwIFBsYW4gcXVhbGl0eSBydWxlcyAoYWx3YXlzIHJ1biwgbm90IGdhdGVkIGJ5IHJ1bnRpbWUgcmVsZXZhbmNlKSBcdTI1MDBcdTI1MDBcblxuICBjb25zdCB0YXNrc1NlY3Rpb24gPSBnZXRTZWN0aW9uKGNvbnRlbnQsIFwiVGFza3NcIiwgMik7XG4gIGlmICh0YXNrc1NlY3Rpb24pIHtcbiAgICBjb25zdCBsaW5lcyA9IHRhc2tzU2VjdGlvbi5zcGxpdChcIlxcblwiKTtcbiAgICBjb25zdCB0YXNrTGluZVBhdHRlcm4gPSAvXi0gXFxbWyB4XVxcXSBcXCpcXCpUXFxkKzovO1xuICAgIGNvbnN0IHRhc2tMaW5lSW5kaWNlczogbnVtYmVyW10gPSBbXTtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGxpbmVzLmxlbmd0aDsgaSsrKSB7XG4gICAgICBpZiAodGFza0xpbmVQYXR0ZXJuLnRlc3QobGluZXNbaV0pKSB0YXNrTGluZUluZGljZXMucHVzaChpKTtcbiAgICB9XG5cbiAgICBmb3IgKGxldCB0ID0gMDsgdCA8IHRhc2tMaW5lSW5kaWNlcy5sZW5ndGg7IHQrKykge1xuICAgICAgY29uc3Qgc3RhcnQgPSB0YXNrTGluZUluZGljZXNbdF07XG4gICAgICBjb25zdCBlbmQgPSB0ICsgMSA8IHRhc2tMaW5lSW5kaWNlcy5sZW5ndGggPyB0YXNrTGluZUluZGljZXNbdCArIDFdIDogbGluZXMubGVuZ3RoO1xuICAgICAgLy8gQ2hlY2sgbGluZXMgYmV0d2VlbiB0aGlzIHRhc2sgaGVhZGVyIGFuZCB0aGUgbmV4dCAob3Igc2VjdGlvbiBlbmQpXG4gICAgICBjb25zdCBib2R5TGluZXMgPSBsaW5lcy5zbGljZShzdGFydCArIDEsIGVuZCk7XG4gICAgICBjb25zdCBtZWFuaW5nZnVsID0gYm9keUxpbmVzLmZpbHRlcihsID0+IGwudHJpbSgpLmxlbmd0aCA+IDApO1xuICAgICAgaWYgKG1lYW5pbmdmdWwubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIGlzc3Vlcy5wdXNoKHtcbiAgICAgICAgICBzZXZlcml0eTogXCJ3YXJuaW5nXCIsXG4gICAgICAgICAgc2NvcGU6IFwic2xpY2UtcGxhblwiLFxuICAgICAgICAgIGZpbGUsXG4gICAgICAgICAgcnVsZUlkOiBcImVtcHR5X3Rhc2tfZW50cnlcIixcbiAgICAgICAgICBtZXNzYWdlOiBcIklubGluZSB0YXNrIGVudHJ5IGhhcyBubyBkZXNjcmlwdGlvbiBjb250ZW50IGJlbmVhdGggdGhlIGNoZWNrYm94IGxpbmUuXCIsXG4gICAgICAgICAgc3VnZ2VzdGlvbjogXCJBZGQgYXQgbGVhc3QgYSBXaHkvRmlsZXMvRG8vVmVyaWZ5IHN1bW1hcnkgc28gdGhlIHRhc2sgaXMgc2VsZi1kZXNjcmliaW5nLlwiLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgT2JzZXJ2YWJpbGl0eSBydWxlcyAoZ2F0ZWQgYnkgcnVudGltZSByZWxldmFuY2UpIFx1MjUwMFx1MjUwMFxuXG4gIGNvbnN0IHJlbGV2YW50ID0gdGV4dFN1Z2dlc3RzT2JzZXJ2YWJpbGl0eVJlbGV2YW50KGNvbnRlbnQpO1xuICBpZiAoIXJlbGV2YW50KSByZXR1cm4gaXNzdWVzO1xuXG4gIGNvbnN0IG9icyA9IGdldFNlY3Rpb24oY29udGVudCwgXCJPYnNlcnZhYmlsaXR5IC8gRGlhZ25vc3RpY3NcIiwgMik7XG4gIGNvbnN0IHZlcmlmaWNhdGlvbiA9IGdldFNlY3Rpb24oY29udGVudCwgXCJWZXJpZmljYXRpb25cIiwgMik7XG5cbiAgaWYgKCFvYnMpIHtcbiAgICBpc3N1ZXMucHVzaCh7XG4gICAgICBzZXZlcml0eTogXCJ3YXJuaW5nXCIsXG4gICAgICBzY29wZTogXCJzbGljZS1wbGFuXCIsXG4gICAgICBmaWxlLFxuICAgICAgcnVsZUlkOiBcIm1pc3Npbmdfb2JzZXJ2YWJpbGl0eV9zZWN0aW9uXCIsXG4gICAgICBtZXNzYWdlOiBcIlNsaWNlIHBsYW4gYXBwZWFycyBub24tdHJpdmlhbCBidXQgaXMgbWlzc2luZyBgIyMgT2JzZXJ2YWJpbGl0eSAvIERpYWdub3N0aWNzYC5cIixcbiAgICAgIHN1Z2dlc3Rpb246IFwiQWRkIHJ1bnRpbWUgc2lnbmFscywgaW5zcGVjdGlvbiBzdXJmYWNlcywgZmFpbHVyZSB2aXNpYmlsaXR5LCBhbmQgcmVkYWN0aW9uIGNvbnN0cmFpbnRzLlwiLFxuICAgIH0pO1xuICB9IGVsc2UgaWYgKHNlY3Rpb25Mb29rc1BsYWNlaG9sZGVyT25seShvYnMpKSB7XG4gICAgaXNzdWVzLnB1c2goe1xuICAgICAgc2V2ZXJpdHk6IFwid2FybmluZ1wiLFxuICAgICAgc2NvcGU6IFwic2xpY2UtcGxhblwiLFxuICAgICAgZmlsZSxcbiAgICAgIHJ1bGVJZDogXCJvYnNlcnZhYmlsaXR5X3NlY3Rpb25fcGxhY2Vob2xkZXJfb25seVwiLFxuICAgICAgbWVzc2FnZTogXCJTbGljZSBwbGFuIGhhcyBgIyMgT2JzZXJ2YWJpbGl0eSAvIERpYWdub3N0aWNzYCBidXQgaXQgc3RpbGwgbG9va3MgbGlrZSBwbGFjZWhvbGRlciB0ZXh0LlwiLFxuICAgICAgc3VnZ2VzdGlvbjogXCJSZXBsYWNlIHBsYWNlaG9sZGVycyB3aXRoIGNvbmNyZXRlIHNpZ25hbHMgYW5kIGluc3BlY3Rpb24gc3VyZmFjZXMgYSBmdXR1cmUgYWdlbnQgc2hvdWxkIHRydXN0LlwiLFxuICAgIH0pO1xuICB9XG5cbiAgaWYgKCF2ZXJpZmljYXRpb25NZW50aW9uc0RpYWdub3N0aWNzKHZlcmlmaWNhdGlvbikpIHtcbiAgICBpc3N1ZXMucHVzaCh7XG4gICAgICBzZXZlcml0eTogXCJ3YXJuaW5nXCIsXG4gICAgICBzY29wZTogXCJzbGljZS1wbGFuXCIsXG4gICAgICBmaWxlLFxuICAgICAgcnVsZUlkOiBcInZlcmlmaWNhdGlvbl9taXNzaW5nX2RpYWdub3N0aWNfY2hlY2tcIixcbiAgICAgIG1lc3NhZ2U6IFwiU2xpY2UgdmVyaWZpY2F0aW9uIGRvZXMgbm90IGFwcGVhciB0byBpbmNsdWRlIGFueSBkaWFnbm9zdGljIG9yIGZhaWx1cmUtcGF0aCBjaGVjay5cIixcbiAgICAgIHN1Z2dlc3Rpb246IFwiQWRkIGF0IGxlYXN0IG9uZSB2ZXJpZmljYXRpb24gc3RlcCBmb3IgaW5zcGVjdGFibGUgZmFpbHVyZSBzdGF0ZSwgc3RydWN0dXJlZCBlcnJvciBvdXRwdXQsIHN0YXR1cyBzdXJmYWNlLCBvciBlcXVpdmFsZW50LlwiLFxuICAgIH0pO1xuICB9XG5cbiAgcmV0dXJuIGlzc3Vlcztcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHZhbGlkYXRlVGFza1BsYW5Db250ZW50KGZpbGU6IHN0cmluZywgY29udGVudDogc3RyaW5nKTogVmFsaWRhdGlvbklzc3VlW10ge1xuICBjb25zdCBpc3N1ZXM6IFZhbGlkYXRpb25Jc3N1ZVtdID0gW107XG5cbiAgLy8gXHUyNTAwXHUyNTAwIFBsYW4gcXVhbGl0eSBydWxlcyAoYWx3YXlzIHJ1biwgbm90IGdhdGVkIGJ5IHJ1bnRpbWUgcmVsZXZhbmNlKSBcdTI1MDBcdTI1MDBcblxuICAvLyBSdWxlOiBlbXB0eSBvciBtaXNzaW5nIFN0ZXBzIHNlY3Rpb25cbiAgY29uc3Qgc3RlcHNTZWN0aW9uID0gZ2V0U2VjdGlvbihjb250ZW50LCBcIlN0ZXBzXCIsIDIpO1xuICBpZiAoc3RlcHNTZWN0aW9uID09PSBudWxsIHx8IHNlY3Rpb25Mb29rc1BsYWNlaG9sZGVyT25seShzdGVwc1NlY3Rpb24pKSB7XG4gICAgaXNzdWVzLnB1c2goe1xuICAgICAgc2V2ZXJpdHk6IFwid2FybmluZ1wiLFxuICAgICAgc2NvcGU6IFwidGFzay1wbGFuXCIsXG4gICAgICBmaWxlLFxuICAgICAgcnVsZUlkOiBcImVtcHR5X3N0ZXBzX3NlY3Rpb25cIixcbiAgICAgIG1lc3NhZ2U6IFwiVGFzayBwbGFuIGhhcyBhbiBlbXB0eSBvciBtaXNzaW5nIGAjIyBTdGVwc2Agc2VjdGlvbi5cIixcbiAgICAgIHN1Z2dlc3Rpb246IFwiQWRkIGNvbmNyZXRlIG51bWJlcmVkIGltcGxlbWVudGF0aW9uIHN0ZXBzIHNvIGV4ZWN1dGlvbiBoYXMgYSBjbGVhciBzZXF1ZW5jZS5cIixcbiAgICB9KTtcbiAgfVxuXG4gIC8vIFJ1bGU6IHBsYWNlaG9sZGVyLW9ubHkgVmVyaWZpY2F0aW9uIHNlY3Rpb25cbiAgY29uc3QgdmVyaWZpY2F0aW9uU2VjdGlvbiA9IGdldFNlY3Rpb24oY29udGVudCwgXCJWZXJpZmljYXRpb25cIiwgMik7XG4gIGlmICh2ZXJpZmljYXRpb25TZWN0aW9uICE9PSBudWxsICYmIHNlY3Rpb25Mb29rc1BsYWNlaG9sZGVyT25seSh2ZXJpZmljYXRpb25TZWN0aW9uKSkge1xuICAgIGlzc3Vlcy5wdXNoKHtcbiAgICAgIHNldmVyaXR5OiBcIndhcm5pbmdcIixcbiAgICAgIHNjb3BlOiBcInRhc2stcGxhblwiLFxuICAgICAgZmlsZSxcbiAgICAgIHJ1bGVJZDogXCJwbGFjZWhvbGRlcl92ZXJpZmljYXRpb25cIixcbiAgICAgIG1lc3NhZ2U6IFwiVGFzayBwbGFuIGhhcyBgIyMgVmVyaWZpY2F0aW9uYCBidXQgaXQgc3RpbGwgbG9va3MgbGlrZSBwbGFjZWhvbGRlciB0ZXh0LlwiLFxuICAgICAgc3VnZ2VzdGlvbjogXCJSZXBsYWNlIHBsYWNlaG9sZGVycyB3aXRoIGNvbmNyZXRlIHZlcmlmaWNhdGlvbiBjb21tYW5kcywgdGVzdCBydW5zLCBvciBvYnNlcnZhYmxlIGNoZWNrcy5cIixcbiAgICB9KTtcbiAgfVxuXG4gIC8vIFJ1bGU6IHNjb3BlIGVzdGltYXRlIHRocmVzaG9sZHNcbiAgY29uc3QgZm0gPSBnZXRGcm9udG1hdHRlcihjb250ZW50KTtcbiAgaWYgKGZtKSB7XG4gICAgY29uc3Qgc3RlcHNNYXRjaCA9IGZtLm1hdGNoKC9eZXN0aW1hdGVkX3N0ZXBzOlxccyooXFxkKykvbSk7XG4gICAgY29uc3QgZmlsZXNNYXRjaCA9IGZtLm1hdGNoKC9eZXN0aW1hdGVkX2ZpbGVzOlxccyooXFxkKykvbSk7XG5cbiAgICBpZiAoc3RlcHNNYXRjaCkge1xuICAgICAgY29uc3QgZXN0aW1hdGVkU3RlcHMgPSBwYXJzZUludChzdGVwc01hdGNoWzFdLCAxMCk7XG4gICAgICBpZiAoZXN0aW1hdGVkU3RlcHMgPj0gMTApIHtcbiAgICAgICAgaXNzdWVzLnB1c2goe1xuICAgICAgICAgIHNldmVyaXR5OiBcIndhcm5pbmdcIixcbiAgICAgICAgICBzY29wZTogXCJ0YXNrLXBsYW5cIixcbiAgICAgICAgICBmaWxlLFxuICAgICAgICAgIHJ1bGVJZDogXCJzY29wZV9lc3RpbWF0ZV9zdGVwc19oaWdoXCIsXG4gICAgICAgICAgbWVzc2FnZTogYFRhc2sgcGxhbiBlc3RpbWF0ZXMgJHtlc3RpbWF0ZWRTdGVwc30gc3RlcHMgKHRocmVzaG9sZDogMTApLiBDb25zaWRlciBzcGxpdHRpbmcgaW50byBzbWFsbGVyIHRhc2tzLmAsXG4gICAgICAgICAgc3VnZ2VzdGlvbjogXCJCcmVhayB0aGUgdGFzayBpbnRvIHN1Yi10YXNrcyBvciByZWR1Y2Ugc2NvcGUgc28gZWFjaCB0YXNrIHN0YXlzIGZvY3VzZWQgYW5kIGNvbXBsZXRhYmxlIGluIG9uZSBwYXNzLlwiLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoZmlsZXNNYXRjaCkge1xuICAgICAgY29uc3QgZXN0aW1hdGVkRmlsZXMgPSBwYXJzZUludChmaWxlc01hdGNoWzFdLCAxMCk7XG4gICAgICBpZiAoZXN0aW1hdGVkRmlsZXMgPj0gMTIpIHtcbiAgICAgICAgaXNzdWVzLnB1c2goe1xuICAgICAgICAgIHNldmVyaXR5OiBcIndhcm5pbmdcIixcbiAgICAgICAgICBzY29wZTogXCJ0YXNrLXBsYW5cIixcbiAgICAgICAgICBmaWxlLFxuICAgICAgICAgIHJ1bGVJZDogXCJzY29wZV9lc3RpbWF0ZV9maWxlc19oaWdoXCIsXG4gICAgICAgICAgbWVzc2FnZTogYFRhc2sgcGxhbiBlc3RpbWF0ZXMgJHtlc3RpbWF0ZWRGaWxlc30gZmlsZXMgKHRocmVzaG9sZDogMTIpLiBDb25zaWRlciBzcGxpdHRpbmcgaW50byBzbWFsbGVyIHRhc2tzLmAsXG4gICAgICAgICAgc3VnZ2VzdGlvbjogXCJCcmVhayB0aGUgdGFzayBpbnRvIHN1Yi10YXNrcyBvciByZWR1Y2Ugc2NvcGUgdG8ga2VlcCB0aGUgY2hhbmdlIGZvb3RwcmludCBtYW5hZ2VhYmxlLlwiLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyBSdWxlOiBJbnB1dHMgYW5kIEV4cGVjdGVkIE91dHB1dCBzaG91bGQgY29udGFpbiBiYWNrdGljay13cmFwcGVkIGZpbGUgcGF0aHNcbiAgY29uc3QgaW5wdXRzU2VjdGlvbiA9IGdldFNlY3Rpb24oY29udGVudCwgXCJJbnB1dHNcIiwgMik7XG4gIGNvbnN0IG91dHB1dFNlY3Rpb24gPSBnZXRTZWN0aW9uKGNvbnRlbnQsIFwiRXhwZWN0ZWQgT3V0cHV0XCIsIDIpO1xuICBjb25zdCBiYWNrdGlja1BhdGhQYXR0ZXJuID0gL2BbXmBdKlsuL11bXmBdKmAvO1xuXG4gIGlmIChvdXRwdXRTZWN0aW9uID09PSBudWxsIHx8ICFiYWNrdGlja1BhdGhQYXR0ZXJuLnRlc3Qob3V0cHV0U2VjdGlvbikpIHtcbiAgICBpc3N1ZXMucHVzaCh7XG4gICAgICBzZXZlcml0eTogXCJ3YXJuaW5nXCIsXG4gICAgICBzY29wZTogXCJ0YXNrLXBsYW5cIixcbiAgICAgIGZpbGUsXG4gICAgICBydWxlSWQ6IFwibWlzc2luZ19vdXRwdXRfZmlsZV9wYXRoc1wiLFxuICAgICAgbWVzc2FnZTogXCJUYXNrIHBsYW4gYCMjIEV4cGVjdGVkIE91dHB1dGAgaXMgbWlzc2luZyBvciBoYXMgbm8gYmFja3RpY2std3JhcHBlZCBmaWxlIHBhdGhzLlwiLFxuICAgICAgc3VnZ2VzdGlvbjogXCJMaXN0IGNvbmNyZXRlIG91dHB1dCBmaWxlIHBhdGhzIGluIGJhY2t0aWNrcyAoZS5nLiBgc3JjL3R5cGVzLnRzYCkuIFRoZXNlIGFyZSBtYWNoaW5lLXBhcnNlZCB0byBkZXJpdmUgdGFzayBkZXBlbmRlbmNpZXMuXCIsXG4gICAgfSk7XG4gIH1cblxuICBpZiAoaW5wdXRzU2VjdGlvbiAhPT0gbnVsbCAmJiBpbnB1dHNTZWN0aW9uLnRyaW0oKS5sZW5ndGggPiAwICYmICFiYWNrdGlja1BhdGhQYXR0ZXJuLnRlc3QoaW5wdXRzU2VjdGlvbikpIHtcbiAgICBpc3N1ZXMucHVzaCh7XG4gICAgICBzZXZlcml0eTogXCJpbmZvXCIsXG4gICAgICBzY29wZTogXCJ0YXNrLXBsYW5cIixcbiAgICAgIGZpbGUsXG4gICAgICBydWxlSWQ6IFwibWlzc2luZ19pbnB1dF9maWxlX3BhdGhzXCIsXG4gICAgICBtZXNzYWdlOiBcIlRhc2sgcGxhbiBgIyMgSW5wdXRzYCBoYXMgY29udGVudCBidXQgbm8gYmFja3RpY2std3JhcHBlZCBmaWxlIHBhdGhzLlwiLFxuICAgICAgc3VnZ2VzdGlvbjogXCJMaXN0IGlucHV0IGZpbGUgcGF0aHMgaW4gYmFja3RpY2tzIChlLmcuIGBzcmMvY29uZmlnLmpzb25gKS4gVGhlc2UgYXJlIG1hY2hpbmUtcGFyc2VkIHRvIGRlcml2ZSB0YXNrIGRlcGVuZGVuY2llcy5cIixcbiAgICB9KTtcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBPYnNlcnZhYmlsaXR5IHJ1bGVzIChnYXRlZCBieSBydW50aW1lIHJlbGV2YW5jZSkgXHUyNTAwXHUyNTAwXG5cbiAgY29uc3QgcmVsZXZhbnQgPSB0ZXh0U3VnZ2VzdHNPYnNlcnZhYmlsaXR5UmVsZXZhbnQoY29udGVudCk7XG4gIGlmICghcmVsZXZhbnQpIHJldHVybiBpc3N1ZXM7XG5cbiAgY29uc3Qgb2JzID0gZ2V0U2VjdGlvbihjb250ZW50LCBcIk9ic2VydmFiaWxpdHkgSW1wYWN0XCIsIDIpO1xuICBpZiAoIW9icykge1xuICAgIGlzc3Vlcy5wdXNoKHtcbiAgICAgIHNldmVyaXR5OiBcIndhcm5pbmdcIixcbiAgICAgIHNjb3BlOiBcInRhc2stcGxhblwiLFxuICAgICAgZmlsZSxcbiAgICAgIHJ1bGVJZDogXCJtaXNzaW5nX29ic2VydmFiaWxpdHlfaW1wYWN0XCIsXG4gICAgICBtZXNzYWdlOiBcIlRhc2sgcGxhbiBhcHBlYXJzIHJ1bnRpbWUtcmVsZXZhbnQgYnV0IGlzIG1pc3NpbmcgYCMjIE9ic2VydmFiaWxpdHkgSW1wYWN0YC5cIixcbiAgICAgIHN1Z2dlc3Rpb246IFwiRXhwbGFpbiB3aGF0IHNpZ25hbHMgY2hhbmdlLCBob3cgYSBmdXR1cmUgYWdlbnQgaW5zcGVjdHMgdGhpcyB0YXNrLCBhbmQgd2hhdCBmYWlsdXJlIHN0YXRlIGJlY29tZXMgdmlzaWJsZS5cIixcbiAgICB9KTtcbiAgfSBlbHNlIGlmIChzZWN0aW9uTG9va3NQbGFjZWhvbGRlck9ubHkob2JzKSkge1xuICAgIGlzc3Vlcy5wdXNoKHtcbiAgICAgIHNldmVyaXR5OiBcIndhcm5pbmdcIixcbiAgICAgIHNjb3BlOiBcInRhc2stcGxhblwiLFxuICAgICAgZmlsZSxcbiAgICAgIHJ1bGVJZDogXCJvYnNlcnZhYmlsaXR5X2ltcGFjdF9wbGFjZWhvbGRlcl9vbmx5XCIsXG4gICAgICBtZXNzYWdlOiBcIlRhc2sgcGxhbiBoYXMgYCMjIE9ic2VydmFiaWxpdHkgSW1wYWN0YCBidXQgaXQgc3RpbGwgbG9va3MgZW1wdHkgb3IgcGxhY2Vob2xkZXItb25seS5cIixcbiAgICAgIHN1Z2dlc3Rpb246IFwiRmlsbCBpbiBjb25jcmV0ZSBpbnNwZWN0aW9uIHN1cmZhY2VzIG9yIGV4cGxpY2l0bHkganVzdGlmeSB3aHkgb2JzZXJ2YWJpbGl0eSBpcyBub3QgYXBwbGljYWJsZS5cIixcbiAgICB9KTtcbiAgfVxuXG4gIHJldHVybiBpc3N1ZXM7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB2YWxpZGF0ZVRhc2tTdW1tYXJ5Q29udGVudChmaWxlOiBzdHJpbmcsIGNvbnRlbnQ6IHN0cmluZyk6IFZhbGlkYXRpb25Jc3N1ZVtdIHtcbiAgY29uc3QgaXNzdWVzOiBWYWxpZGF0aW9uSXNzdWVbXSA9IFtdO1xuICBpZiAoIWhhc0Zyb250bWF0dGVyS2V5KGNvbnRlbnQsIFwib2JzZXJ2YWJpbGl0eV9zdXJmYWNlc1wiKSkge1xuICAgIGlzc3Vlcy5wdXNoKHtcbiAgICAgIHNldmVyaXR5OiBcIndhcm5pbmdcIixcbiAgICAgIHNjb3BlOiBcInRhc2stc3VtbWFyeVwiLFxuICAgICAgZmlsZSxcbiAgICAgIHJ1bGVJZDogXCJtaXNzaW5nX29ic2VydmFiaWxpdHlfZnJvbnRtYXR0ZXJcIixcbiAgICAgIG1lc3NhZ2U6IFwiVGFzayBzdW1tYXJ5IGlzIG1pc3NpbmcgYG9ic2VydmFiaWxpdHlfc3VyZmFjZXNgIGluIGZyb250bWF0dGVyLlwiLFxuICAgICAgc3VnZ2VzdGlvbjogXCJMaXN0IHRoZSBkdXJhYmxlIHN0YXR1cy9sb2cvZXJyb3Igc3VyZmFjZXMgYSBmdXR1cmUgYWdlbnQgc2hvdWxkIHVzZS5cIixcbiAgICB9KTtcbiAgfVxuXG4gIGNvbnN0IGRpYWdub3N0aWNzID0gZ2V0U2VjdGlvbihjb250ZW50LCBcIkRpYWdub3N0aWNzXCIsIDIpO1xuICBpZiAoIWRpYWdub3N0aWNzKSB7XG4gICAgaXNzdWVzLnB1c2goe1xuICAgICAgc2V2ZXJpdHk6IFwid2FybmluZ1wiLFxuICAgICAgc2NvcGU6IFwidGFzay1zdW1tYXJ5XCIsXG4gICAgICBmaWxlLFxuICAgICAgcnVsZUlkOiBcIm1pc3NpbmdfZGlhZ25vc3RpY3Nfc2VjdGlvblwiLFxuICAgICAgbWVzc2FnZTogXCJUYXNrIHN1bW1hcnkgaXMgbWlzc2luZyBgIyMgRGlhZ25vc3RpY3NgLlwiLFxuICAgICAgc3VnZ2VzdGlvbjogXCJEb2N1bWVudCBob3cgdG8gaW5zcGVjdCB3aGF0IHRoaXMgdGFzayBidWlsdCBsYXRlci5cIixcbiAgICB9KTtcbiAgfSBlbHNlIGlmIChzZWN0aW9uTG9va3NQbGFjZWhvbGRlck9ubHkoZGlhZ25vc3RpY3MpKSB7XG4gICAgaXNzdWVzLnB1c2goe1xuICAgICAgc2V2ZXJpdHk6IFwid2FybmluZ1wiLFxuICAgICAgc2NvcGU6IFwidGFzay1zdW1tYXJ5XCIsXG4gICAgICBmaWxlLFxuICAgICAgcnVsZUlkOiBcImRpYWdub3N0aWNzX3BsYWNlaG9sZGVyX29ubHlcIixcbiAgICAgIG1lc3NhZ2U6IFwiVGFzayBzdW1tYXJ5IGRpYWdub3N0aWNzIHNlY3Rpb24gc3RpbGwgbG9va3MgbGlrZSBwbGFjZWhvbGRlciB0ZXh0LlwiLFxuICAgICAgc3VnZ2VzdGlvbjogXCJSZXBsYWNlIHBsYWNlaG9sZGVycyB3aXRoIGNvbmNyZXRlIGNvbW1hbmRzLCBlbmRwb2ludHMsIGxvZ3MsIGVycm9yIHNoYXBlcywgb3IgZmFpbHVyZSBhcnRpZmFjdHMuXCIsXG4gICAgfSk7XG4gIH1cblxuICBjb25zdCBldmlkZW5jZSA9IGdldFNlY3Rpb24oY29udGVudCwgXCJWZXJpZmljYXRpb24gRXZpZGVuY2VcIiwgMik7XG4gIGlmICghZXZpZGVuY2UpIHtcbiAgICBpc3N1ZXMucHVzaCh7XG4gICAgICBzZXZlcml0eTogXCJ3YXJuaW5nXCIsXG4gICAgICBzY29wZTogXCJ0YXNrLXN1bW1hcnlcIixcbiAgICAgIGZpbGUsXG4gICAgICBydWxlSWQ6IFwiZXZpZGVuY2VfYmxvY2tfbWlzc2luZ1wiLFxuICAgICAgbWVzc2FnZTogXCJUYXNrIHN1bW1hcnkgaXMgbWlzc2luZyBgIyMgVmVyaWZpY2F0aW9uIEV2aWRlbmNlYC5cIixcbiAgICAgIHN1Z2dlc3Rpb246IFwiQWRkIGEgdmVyaWZpY2F0aW9uIGV2aWRlbmNlIHRhYmxlIHNob3dpbmcgZ2F0ZSBjaGVjayByZXN1bHRzIChjb21tYW5kLCBleGl0IGNvZGUsIHZlcmRpY3QsIGR1cmF0aW9uKS5cIixcbiAgICB9KTtcbiAgfSBlbHNlIGlmIChzZWN0aW9uTG9va3NQbGFjZWhvbGRlck9ubHkoZXZpZGVuY2UpKSB7XG4gICAgaXNzdWVzLnB1c2goe1xuICAgICAgc2V2ZXJpdHk6IFwid2FybmluZ1wiLFxuICAgICAgc2NvcGU6IFwidGFzay1zdW1tYXJ5XCIsXG4gICAgICBmaWxlLFxuICAgICAgcnVsZUlkOiBcImV2aWRlbmNlX2Jsb2NrX3BsYWNlaG9sZGVyXCIsXG4gICAgICBtZXNzYWdlOiBcIlRhc2sgc3VtbWFyeSB2ZXJpZmljYXRpb24gZXZpZGVuY2Ugc2VjdGlvbiBzdGlsbCBsb29rcyBsaWtlIHBsYWNlaG9sZGVyIHRleHQuXCIsXG4gICAgICBzdWdnZXN0aW9uOiBcIlJlcGxhY2UgcGxhY2Vob2xkZXJzIHdpdGggYWN0dWFsIGdhdGUgcmVzdWx0cyBvciBub3RlIHRoYXQgbm8gdmVyaWZpY2F0aW9uIGNvbW1hbmRzIHdlcmUgZGlzY292ZXJlZC5cIixcbiAgICB9KTtcbiAgfVxuXG4gIHJldHVybiBpc3N1ZXM7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB2YWxpZGF0ZVNsaWNlU3VtbWFyeUNvbnRlbnQoZmlsZTogc3RyaW5nLCBjb250ZW50OiBzdHJpbmcpOiBWYWxpZGF0aW9uSXNzdWVbXSB7XG4gIGNvbnN0IGlzc3VlczogVmFsaWRhdGlvbklzc3VlW10gPSBbXTtcbiAgaWYgKCFoYXNGcm9udG1hdHRlcktleShjb250ZW50LCBcIm9ic2VydmFiaWxpdHlfc3VyZmFjZXNcIikpIHtcbiAgICBpc3N1ZXMucHVzaCh7XG4gICAgICBzZXZlcml0eTogXCJ3YXJuaW5nXCIsXG4gICAgICBzY29wZTogXCJzbGljZS1zdW1tYXJ5XCIsXG4gICAgICBmaWxlLFxuICAgICAgcnVsZUlkOiBcIm1pc3Npbmdfb2JzZXJ2YWJpbGl0eV9mcm9udG1hdHRlclwiLFxuICAgICAgbWVzc2FnZTogXCJTbGljZSBzdW1tYXJ5IGlzIG1pc3NpbmcgYG9ic2VydmFiaWxpdHlfc3VyZmFjZXNgIGluIGZyb250bWF0dGVyLlwiLFxuICAgICAgc3VnZ2VzdGlvbjogXCJMaXN0IHRoZSBhdXRob3JpdGF0aXZlIGRpYWdub3N0aWNzIGFuZCBkdXJhYmxlIGluc3BlY3Rpb24gc3VyZmFjZXMgZm9yIHRoaXMgc2xpY2UuXCIsXG4gICAgfSk7XG4gIH1cblxuICBjb25zdCBkaWFnbm9zdGljcyA9IGdldFNlY3Rpb24oY29udGVudCwgXCJBdXRob3JpdGF0aXZlIGRpYWdub3N0aWNzXCIsIDMpO1xuICBpZiAoIWRpYWdub3N0aWNzKSB7XG4gICAgaXNzdWVzLnB1c2goe1xuICAgICAgc2V2ZXJpdHk6IFwid2FybmluZ1wiLFxuICAgICAgc2NvcGU6IFwic2xpY2Utc3VtbWFyeVwiLFxuICAgICAgZmlsZSxcbiAgICAgIHJ1bGVJZDogXCJtaXNzaW5nX2F1dGhvcml0YXRpdmVfZGlhZ25vc3RpY3NcIixcbiAgICAgIG1lc3NhZ2U6IFwiU2xpY2Ugc3VtbWFyeSBpcyBtaXNzaW5nIGAjIyMgQXV0aG9yaXRhdGl2ZSBkaWFnbm9zdGljc2AgaW4gRm9yd2FyZCBJbnRlbGxpZ2VuY2UuXCIsXG4gICAgICBzdWdnZXN0aW9uOiBcIlRlbGwgZnV0dXJlIGFnZW50cyB3aGVyZSB0byBsb29rIGZpcnN0IGFuZCB3aHkgdGhhdCBzaWduYWwgaXMgdHJ1c3R3b3J0aHkuXCIsXG4gICAgfSk7XG4gIH0gZWxzZSBpZiAoc2VjdGlvbkxvb2tzUGxhY2Vob2xkZXJPbmx5KGRpYWdub3N0aWNzKSkge1xuICAgIGlzc3Vlcy5wdXNoKHtcbiAgICAgIHNldmVyaXR5OiBcIndhcm5pbmdcIixcbiAgICAgIHNjb3BlOiBcInNsaWNlLXN1bW1hcnlcIixcbiAgICAgIGZpbGUsXG4gICAgICBydWxlSWQ6IFwiYXV0aG9yaXRhdGl2ZV9kaWFnbm9zdGljc19wbGFjZWhvbGRlcl9vbmx5XCIsXG4gICAgICBtZXNzYWdlOiBcIlNsaWNlIHN1bW1hcnkgaW5jbHVkZXMgYXV0aG9yaXRhdGl2ZSBkaWFnbm9zdGljcyBidXQgaXQgc3RpbGwgbG9va3MgbGlrZSBwbGFjZWhvbGRlciB0ZXh0LlwiLFxuICAgICAgc3VnZ2VzdGlvbjogXCJSZXBsYWNlIHBsYWNlaG9sZGVycyB3aXRoIHRoZSByZWFsIGZpcnN0LXN0b3AgZGlhZ25vc3RpYyBzdXJmYWNlIGZvciB0aGlzIHNsaWNlLlwiLFxuICAgIH0pO1xuICB9XG5cbiAgcmV0dXJuIGlzc3Vlcztcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHZhbGlkYXRlUGxhbkJvdW5kYXJ5KGJhc2VQYXRoOiBzdHJpbmcsIG1pbGVzdG9uZUlkOiBzdHJpbmcsIHNsaWNlSWQ6IHN0cmluZyk6IFByb21pc2U8VmFsaWRhdGlvbklzc3VlW10+IHtcbiAgY29uc3QgaXNzdWVzOiBWYWxpZGF0aW9uSXNzdWVbXSA9IFtdO1xuICBjb25zdCBzbGljZVBsYW4gPSByZXNvbHZlU2xpY2VGaWxlKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgc2xpY2VJZCwgXCJQTEFOXCIpO1xuICBpZiAoc2xpY2VQbGFuKSB7XG4gICAgY29uc3QgY29udGVudCA9IGF3YWl0IGxvYWRGaWxlKHNsaWNlUGxhbik7XG4gICAgaWYgKGNvbnRlbnQpIGlzc3Vlcy5wdXNoKC4uLnZhbGlkYXRlU2xpY2VQbGFuQ29udGVudChzbGljZVBsYW4sIGNvbnRlbnQpKTtcbiAgfVxuXG4gIGNvbnN0IHRhc2tzRGlyID0gcmVzb2x2ZVRhc2tzRGlyKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgc2xpY2VJZCk7XG4gIGNvbnN0IHRhc2tQbGFucyA9IHRhc2tzRGlyID8gcmVzb2x2ZVRhc2tGaWxlcyh0YXNrc0RpciwgXCJQTEFOXCIpIDogW107XG4gIGZvciAoY29uc3QgZmlsZSBvZiB0YXNrUGxhbnMpIHtcbiAgICBjb25zdCB0YXNrSWQgPSBmaWxlLnNwbGl0KFwiLVwiKVswXTtcbiAgICBjb25zdCB0YXNrUGxhbiA9IHJlc29sdmVUYXNrRmlsZShiYXNlUGF0aCwgbWlsZXN0b25lSWQsIHNsaWNlSWQsIHRhc2tJZCwgXCJQTEFOXCIpO1xuICAgIGlmICghdGFza1BsYW4pIGNvbnRpbnVlO1xuICAgIGNvbnN0IGNvbnRlbnQgPSBhd2FpdCBsb2FkRmlsZSh0YXNrUGxhbik7XG4gICAgaWYgKGNvbnRlbnQpIGlzc3Vlcy5wdXNoKC4uLnZhbGlkYXRlVGFza1BsYW5Db250ZW50KHRhc2tQbGFuLCBjb250ZW50KSk7XG4gIH1cblxuICByZXR1cm4gaXNzdWVzO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdmFsaWRhdGVFeGVjdXRlQm91bmRhcnkoYmFzZVBhdGg6IHN0cmluZywgbWlsZXN0b25lSWQ6IHN0cmluZywgc2xpY2VJZDogc3RyaW5nLCB0YXNrSWQ6IHN0cmluZyk6IFByb21pc2U8VmFsaWRhdGlvbklzc3VlW10+IHtcbiAgY29uc3QgaXNzdWVzOiBWYWxpZGF0aW9uSXNzdWVbXSA9IFtdO1xuICBjb25zdCBzbGljZVBsYW4gPSByZXNvbHZlU2xpY2VGaWxlKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgc2xpY2VJZCwgXCJQTEFOXCIpO1xuICBpZiAoc2xpY2VQbGFuKSB7XG4gICAgY29uc3QgY29udGVudCA9IGF3YWl0IGxvYWRGaWxlKHNsaWNlUGxhbik7XG4gICAgaWYgKGNvbnRlbnQpIGlzc3Vlcy5wdXNoKC4uLnZhbGlkYXRlU2xpY2VQbGFuQ29udGVudChzbGljZVBsYW4sIGNvbnRlbnQpKTtcbiAgfVxuXG4gIGNvbnN0IHRhc2tQbGFuID0gcmVzb2x2ZVRhc2tGaWxlKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgc2xpY2VJZCwgdGFza0lkLCBcIlBMQU5cIik7XG4gIGlmICh0YXNrUGxhbikge1xuICAgIGNvbnN0IGNvbnRlbnQgPSBhd2FpdCBsb2FkRmlsZSh0YXNrUGxhbik7XG4gICAgaWYgKGNvbnRlbnQpIGlzc3Vlcy5wdXNoKC4uLnZhbGlkYXRlVGFza1BsYW5Db250ZW50KHRhc2tQbGFuLCBjb250ZW50KSk7XG4gIH1cblxuICByZXR1cm4gaXNzdWVzO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdmFsaWRhdGVDb21wbGV0ZUJvdW5kYXJ5KGJhc2VQYXRoOiBzdHJpbmcsIG1pbGVzdG9uZUlkOiBzdHJpbmcsIHNsaWNlSWQ6IHN0cmluZyk6IFByb21pc2U8VmFsaWRhdGlvbklzc3VlW10+IHtcbiAgY29uc3QgaXNzdWVzOiBWYWxpZGF0aW9uSXNzdWVbXSA9IFtdO1xuICBjb25zdCB0YXNrc0RpciA9IHJlc29sdmVUYXNrc0RpcihiYXNlUGF0aCwgbWlsZXN0b25lSWQsIHNsaWNlSWQpO1xuICBjb25zdCB0YXNrU3VtbWFyaWVzID0gdGFza3NEaXIgPyByZXNvbHZlVGFza0ZpbGVzKHRhc2tzRGlyLCBcIlNVTU1BUllcIikgOiBbXTtcbiAgZm9yIChjb25zdCBmaWxlIG9mIHRhc2tTdW1tYXJpZXMpIHtcbiAgICBjb25zdCB0YXNrSWQgPSBmaWxlLnNwbGl0KFwiLVwiKVswXTtcbiAgICBjb25zdCB0YXNrU3VtbWFyeSA9IHJlc29sdmVUYXNrRmlsZShiYXNlUGF0aCwgbWlsZXN0b25lSWQsIHNsaWNlSWQsIHRhc2tJZCwgXCJTVU1NQVJZXCIpO1xuICAgIGlmICghdGFza1N1bW1hcnkpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGNvbnRlbnQgPSBhd2FpdCBsb2FkRmlsZSh0YXNrU3VtbWFyeSk7XG4gICAgaWYgKGNvbnRlbnQpIGlzc3Vlcy5wdXNoKC4uLnZhbGlkYXRlVGFza1N1bW1hcnlDb250ZW50KHRhc2tTdW1tYXJ5LCBjb250ZW50KSk7XG4gIH1cblxuICBjb25zdCBzbGljZVN1bW1hcnkgPSByZXNvbHZlU2xpY2VGaWxlKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgc2xpY2VJZCwgXCJTVU1NQVJZXCIpO1xuICBpZiAoc2xpY2VTdW1tYXJ5KSB7XG4gICAgY29uc3QgY29udGVudCA9IGF3YWl0IGxvYWRGaWxlKHNsaWNlU3VtbWFyeSk7XG4gICAgaWYgKGNvbnRlbnQpIGlzc3Vlcy5wdXNoKC4uLnZhbGlkYXRlU2xpY2VTdW1tYXJ5Q29udGVudChzbGljZVN1bW1hcnksIGNvbnRlbnQpKTtcbiAgfVxuXG4gIHJldHVybiBpc3N1ZXM7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXRWYWxpZGF0aW9uSXNzdWVzKGlzc3VlczogVmFsaWRhdGlvbklzc3VlW10sIGxpbWl0OiBudW1iZXIgPSA0KTogc3RyaW5nIHtcbiAgaWYgKGlzc3Vlcy5sZW5ndGggPT09IDApIHJldHVybiBcIlwiO1xuICBjb25zdCBsaW5lcyA9IGlzc3Vlcy5zbGljZSgwLCBsaW1pdCkubWFwKGlzc3VlID0+IHtcbiAgICBjb25zdCBmaWxlTmFtZSA9IGlzc3VlLmZpbGUuc3BsaXQoXCIvXCIpLnBvcCgpIHx8IGlzc3VlLmZpbGU7XG4gICAgcmV0dXJuIGAtICR7ZmlsZU5hbWV9OiAke2lzc3VlLm1lc3NhZ2V9YDtcbiAgfSk7XG4gIGlmIChpc3N1ZXMubGVuZ3RoID4gbGltaXQpIGxpbmVzLnB1c2goYC0gLi4uYW5kICR7aXNzdWVzLmxlbmd0aCAtIGxpbWl0fSBtb3JlYCk7XG4gIHJldHVybiBsaW5lcy5qb2luKFwiXFxuXCIpO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxnQkFBZ0I7QUFDekIsU0FBUyxrQkFBa0IsaUJBQWlCLGlCQUFpQix3QkFBd0I7QUFXckYsU0FBUyxXQUFXLFNBQWlCLFNBQWlCLFFBQWdCLEdBQWtCO0FBQ3RGLFFBQU0sU0FBUyxJQUFJLE9BQU8sS0FBSyxJQUFJO0FBQ25DLFFBQU0sVUFBVSxRQUFRLFFBQVEsdUJBQXVCLE1BQU07QUFDN0QsUUFBTSxRQUFRLElBQUksT0FBTyxJQUFJLE1BQU0sR0FBRyxPQUFPLFNBQVMsR0FBRztBQUN6RCxRQUFNLFFBQVEsTUFBTSxLQUFLLE9BQU87QUFDaEMsTUFBSSxDQUFDLE1BQU8sUUFBTztBQUVuQixRQUFNLFFBQVEsTUFBTSxRQUFRLE1BQU0sQ0FB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
