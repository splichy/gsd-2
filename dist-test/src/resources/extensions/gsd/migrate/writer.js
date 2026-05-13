import { join } from "node:path";
import { saveFile } from "../files.js";
import { gsdRoot } from "../paths.js";
function serializeFrontmatter(data) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(data)) {
    if (value === void 0 || value === null) continue;
    if (typeof value === "boolean") {
      lines.push(`${key}: ${value}`);
    } else if (typeof value === "string" || typeof value === "number") {
      lines.push(`${key}: ${value}`);
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else if (typeof value[0] === "object" && value[0] !== null) {
        lines.push(`${key}:`);
        for (const obj of value) {
          const entries = Object.entries(obj);
          if (entries.length > 0) {
            lines.push(`  - ${entries[0][0]}: ${entries[0][1]}`);
            for (let i = 1; i < entries.length; i++) {
              lines.push(`    ${entries[i][0]}: ${entries[i][1]}`);
            }
          }
        }
      } else {
        lines.push(`${key}:`);
        for (const item of value) {
          lines.push(`  - ${item}`);
        }
      }
    }
  }
  lines.push("---");
  return lines.join("\n");
}
function formatRoadmap(milestone) {
  const lines = [];
  lines.push(`# ${milestone.id}: ${milestone.title}`);
  lines.push("");
  lines.push(`**Vision:** ${milestone.vision || "(migrated project)"}`);
  lines.push("");
  lines.push("## Success Criteria");
  lines.push("");
  if (milestone.successCriteria.length > 0) {
    for (const criterion of milestone.successCriteria) {
      lines.push(`- ${criterion}`);
    }
  }
  lines.push("");
  lines.push("## Slices");
  lines.push("");
  for (const slice of milestone.slices) {
    const check = slice.done ? "x" : " ";
    const depsStr = slice.depends.length > 0 ? slice.depends.join(", ") : "";
    lines.push(`- [${check}] **${slice.id}: ${slice.title}** \`risk:${slice.risk}\` \`depends:[${depsStr}]\``);
    if (slice.demo) {
      lines.push(`  > After this: ${slice.demo}`);
    }
  }
  return lines.join("\n") + "\n";
}
function formatPlan(slice) {
  const lines = [];
  lines.push(`# ${slice.id}: ${slice.title}`);
  lines.push("");
  lines.push(`**Goal:** ${slice.goal || slice.title}`);
  lines.push(`**Demo:** ${slice.demo || slice.title}`);
  lines.push("");
  lines.push("## Must-Haves");
  lines.push("");
  lines.push("");
  lines.push("## Tasks");
  lines.push("");
  for (const task of slice.tasks) {
    const check = task.done ? "x" : " ";
    const estPart = task.estimate ? ` \`est:${task.estimate}\`` : "";
    lines.push(`- [${check}] **${task.id}: ${task.title}**${estPart}`);
    if (task.description) {
      lines.push(`  - ${task.description}`);
    }
  }
  lines.push("");
  lines.push("## Files Likely Touched");
  lines.push("");
  for (const task of slice.tasks) {
    for (const file of task.files) {
      lines.push(`- \`${file}\``);
    }
  }
  return lines.join("\n") + "\n";
}
function formatSliceSummary(slice, milestoneId) {
  if (!slice.summary) return "";
  const s = slice.summary;
  const fm = serializeFrontmatter({
    id: slice.id,
    parent: milestoneId,
    milestone: milestoneId,
    provides: s.provides,
    requires: [],
    affects: [],
    key_files: s.keyFiles,
    key_decisions: s.keyDecisions,
    patterns_established: s.patternsEstablished,
    observability_surfaces: [],
    drill_down_paths: [],
    duration: s.duration || "",
    verification_result: "passed",
    completed_at: s.completedAt || "",
    blocker_discovered: false
  });
  const body = [
    "",
    `# ${slice.id}: ${slice.title}`,
    "",
    `**${s.whatHappened ? s.whatHappened.split("\n")[0] : "Migrated from legacy format"}**`,
    "",
    "## What Happened",
    "",
    s.whatHappened || "Migrated from legacy planning format."
  ];
  return fm + body.join("\n") + "\n";
}
function formatTaskSummary(task, sliceId, milestoneId) {
  if (!task.summary) return "";
  const s = task.summary;
  const fm = serializeFrontmatter({
    id: task.id,
    parent: sliceId,
    milestone: milestoneId,
    provides: s.provides,
    requires: [],
    affects: [],
    key_files: s.keyFiles,
    key_decisions: [],
    patterns_established: [],
    observability_surfaces: [],
    drill_down_paths: [],
    duration: s.duration || "",
    verification_result: "passed",
    completed_at: s.completedAt || "",
    blocker_discovered: false
  });
  const body = [
    "",
    `# ${task.id}: ${task.title}`,
    "",
    `**${s.whatHappened ? s.whatHappened.split("\n")[0] : "Migrated from legacy format"}**`,
    "",
    "## What Happened",
    "",
    s.whatHappened || "Migrated from legacy planning format."
  ];
  return fm + body.join("\n") + "\n";
}
function formatTaskPlan(task, sliceId, milestoneId) {
  const lines = [];
  lines.push(`# ${task.id}: ${task.title}`);
  lines.push("");
  lines.push(`**Slice:** ${sliceId} \u2014 **Milestone:** ${milestoneId}`);
  lines.push("");
  lines.push("## Description");
  lines.push("");
  lines.push(task.description || "Migrated from legacy planning format.");
  lines.push("");
  if (task.mustHaves.length > 0) {
    lines.push("## Must-Haves");
    lines.push("");
    for (const mh of task.mustHaves) {
      lines.push(`- [ ] ${mh}`);
    }
    lines.push("");
  }
  if (task.files.length > 0) {
    lines.push("## Files");
    lines.push("");
    for (const f of task.files) {
      lines.push(`- \`${f}\``);
    }
    lines.push("");
  }
  return lines.join("\n");
}
function formatRequirements(requirements) {
  const lines = [];
  lines.push("# Requirements");
  lines.push("");
  const groups = {
    active: [],
    validated: [],
    deferred: [],
    "out-of-scope": []
  };
  for (const req of requirements) {
    const status = req.status.toLowerCase();
    if (status in groups) {
      groups[status].push(req);
    } else {
      groups.active.push(req);
    }
  }
  const sectionMap = [
    ["active", "Active"],
    ["validated", "Validated"],
    ["deferred", "Deferred"],
    ["out-of-scope", "Out of Scope"]
  ];
  for (const [key, heading] of sectionMap) {
    lines.push(`## ${heading}`);
    lines.push("");
    for (const req of groups[key]) {
      lines.push(`### ${req.id} \u2014 ${req.title}`);
      lines.push("");
      lines.push(`- Status: ${req.status}`);
      lines.push(`- Class: ${req.class}`);
      lines.push(`- Source: ${req.source}`);
      lines.push(`- Primary Slice: ${req.primarySlice}`);
      lines.push("");
      if (req.description) {
        lines.push(req.description);
        lines.push("");
      }
    }
  }
  return lines.join("\n");
}
function formatProject(content) {
  if (!content || !content.trim()) {
    return "# Project\n\n(Migrated project \u2014 no description available.)\n";
  }
  return content.endsWith("\n") ? content : content + "\n";
}
function formatDecisions(content) {
  if (!content || !content.trim()) {
    return [
      "# Decisions Register",
      "",
      "<!-- Append-only. Never edit or remove existing rows.",
      "     To reverse a decision, add a new row that supersedes it.",
      "     Read this file at the start of any planning or research phase. -->",
      "",
      "| # | When | Scope | Decision | Choice | Rationale | Revisable? | Made By |",
      "|---|------|-------|----------|--------|-----------|------------|---------|",
      ""
    ].join("\n");
  }
  return content.endsWith("\n") ? content : content + "\n";
}
function formatContext(milestoneId) {
  return `# ${milestoneId} Context

Migrated milestone \u2014 no upstream dependencies.
`;
}
function formatState(milestones) {
  const lines = [];
  lines.push("# GSD State");
  lines.push("");
  lines.push("<!-- Auto-generated. Updated by deriveState(). -->");
  lines.push("");
  for (const m of milestones) {
    const doneSlices = m.slices.filter((s) => s.done).length;
    const totalSlices = m.slices.length;
    lines.push(`## ${m.id}: ${m.title}`);
    lines.push("");
    lines.push(`- Slices: ${doneSlices}/${totalSlices}`);
    lines.push("");
  }
  return lines.join("\n");
}
async function writeGSDDirectory(project, targetPath) {
  const gsdDir = gsdRoot(targetPath);
  const milestonesBase = join(gsdDir, "milestones");
  const paths = [];
  const counts = {
    roadmaps: 0,
    plans: 0,
    taskPlans: 0,
    taskSummaries: 0,
    sliceSummaries: 0,
    research: 0,
    requirements: 0,
    contexts: 0,
    other: 0
  };
  const projectPath = join(gsdDir, "PROJECT.md");
  await saveFile(projectPath, formatProject(project.projectContent));
  paths.push(projectPath);
  counts.other++;
  const decisionsPath = join(gsdDir, "DECISIONS.md");
  await saveFile(decisionsPath, formatDecisions(project.decisionsContent));
  paths.push(decisionsPath);
  counts.other++;
  const statePath = join(gsdDir, "STATE.md");
  await saveFile(statePath, formatState(project.milestones));
  paths.push(statePath);
  counts.other++;
  if (project.requirements.length > 0) {
    const reqPath = join(gsdDir, "REQUIREMENTS.md");
    await saveFile(reqPath, formatRequirements(project.requirements));
    paths.push(reqPath);
    counts.requirements++;
  }
  for (const milestone of project.milestones) {
    const mDir = join(milestonesBase, milestone.id);
    const roadmapPath = join(mDir, `${milestone.id}-ROADMAP.md`);
    await saveFile(roadmapPath, formatRoadmap(milestone));
    paths.push(roadmapPath);
    counts.roadmaps++;
    const contextPath = join(mDir, `${milestone.id}-CONTEXT.md`);
    await saveFile(contextPath, formatContext(milestone.id));
    paths.push(contextPath);
    counts.contexts++;
    if (milestone.research !== null) {
      const researchPath = join(mDir, `${milestone.id}-RESEARCH.md`);
      await saveFile(researchPath, milestone.research);
      paths.push(researchPath);
      counts.research++;
    }
    const allSlicesDone = milestone.slices.length > 0 && milestone.slices.every((s) => s.done);
    if (allSlicesDone) {
      const validationPath = join(mDir, `${milestone.id}-VALIDATION.md`);
      const validationContent = [
        `---`,
        `verdict: pass`,
        `migrated: true`,
        `---`,
        ``,
        `# ${milestone.id} Validation`,
        ``,
        `Migrated milestone \u2014 all slices were completed in the original project.`,
        ``
      ].join("\n");
      await saveFile(validationPath, validationContent);
      paths.push(validationPath);
      counts.other++;
      const summaryPath = join(mDir, `${milestone.id}-SUMMARY.md`);
      const summaryContent = [
        `---`,
        `status: done`,
        `migrated: true`,
        `---`,
        ``,
        `# ${milestone.id}: ${milestone.title}`,
        ``,
        `Migrated from .planning \u2014 ${milestone.slices.length} slices completed.`,
        ``
      ].join("\n");
      await saveFile(summaryPath, summaryContent);
      paths.push(summaryPath);
      counts.other++;
    }
    for (const slice of milestone.slices) {
      const sDir = join(mDir, "slices", slice.id);
      const tasksDir = join(sDir, "tasks");
      const planPath = join(sDir, `${slice.id}-PLAN.md`);
      await saveFile(planPath, formatPlan(slice));
      paths.push(planPath);
      counts.plans++;
      if (slice.research !== null) {
        const sliceResearchPath = join(sDir, `${slice.id}-RESEARCH.md`);
        await saveFile(sliceResearchPath, slice.research);
        paths.push(sliceResearchPath);
        counts.research++;
      }
      if (slice.summary !== null) {
        const summaryContent = formatSliceSummary(slice, milestone.id);
        if (summaryContent) {
          const summaryPath = join(sDir, `${slice.id}-SUMMARY.md`);
          await saveFile(summaryPath, summaryContent);
          paths.push(summaryPath);
          counts.sliceSummaries++;
        }
      }
      for (const task of slice.tasks) {
        const taskPlanPath = join(tasksDir, `${task.id}-PLAN.md`);
        await saveFile(taskPlanPath, formatTaskPlan(task, slice.id, milestone.id));
        paths.push(taskPlanPath);
        counts.taskPlans++;
        if (task.summary !== null) {
          const taskSummaryContent = formatTaskSummary(task, slice.id, milestone.id);
          if (taskSummaryContent) {
            const taskSummaryPath = join(tasksDir, `${task.id}-SUMMARY.md`);
            await saveFile(taskSummaryPath, taskSummaryContent);
            paths.push(taskSummaryPath);
            counts.taskSummaries++;
          }
        }
      }
    }
  }
  return { paths, counts };
}
export {
  formatContext,
  formatDecisions,
  formatPlan,
  formatProject,
  formatRequirements,
  formatRoadmap,
  formatSliceSummary,
  formatState,
  formatTaskPlan,
  formatTaskSummary,
  writeGSDDirectory
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9taWdyYXRlL3dyaXRlci50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NEIERpcmVjdG9yeSBXcml0ZXIgXHUyMDE0IEZvcm1hdCBGdW5jdGlvbnMgJiBEaXJlY3RvcnkgT3JjaGVzdHJhdG9yXG4vLyBGb3JtYXQgZnVuY3Rpb25zOiBwdXJlIHN0cmluZy1yZXR1cm5pbmcgZnVuY3Rpb25zIHRoYXQgc2VyaWFsaXplIEdTRCB0eXBlcyBpbnRvIHRoZSBleGFjdCBtYXJrZG93blxuLy8gZm9ybWF0IHRoYXQgR1NELTIncyBwYXJzZXJzIGV4cGVjdCAocGFyc2VSb2FkbWFwLCBwYXJzZVBsYW4sIHBhcnNlU3VtbWFyeSwgcGFyc2VSZXF1aXJlbWVudENvdW50cykuXG4vLyB3cml0ZUdTRERpcmVjdG9yeTogb3JjaGVzdHJhdG9yIHRoYXQgd3JpdGVzIGEgY29tcGxldGUgLmdzZCBkaXJlY3RvcnkgdHJlZSBmcm9tIGEgR1NEUHJvamVjdC5cblxuaW1wb3J0IHsgam9pbiB9IGZyb20gJ25vZGU6cGF0aCc7XG5pbXBvcnQgeyBzYXZlRmlsZSB9IGZyb20gJy4uL2ZpbGVzLmpzJztcbmltcG9ydCB7IGdzZFJvb3QgfSBmcm9tICcuLi9wYXRocy5qcyc7XG5cbmltcG9ydCB0eXBlIHtcbiAgR1NETWlsZXN0b25lLFxuICBHU0RTbGljZSxcbiAgR1NEVGFzayxcbiAgR1NEUmVxdWlyZW1lbnQsXG4gIEdTRFByb2plY3QsXG59IGZyb20gJy4vdHlwZXMuanMnO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVHlwZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKiBSZXN1bHQgb2Ygd3JpdGVHU0REaXJlY3RvcnkgXHUyMDE0IGxpc3RzIGFsbCBmaWxlcyB0aGF0IHdlcmUgd3JpdHRlbi4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgV3JpdHRlbkZpbGVzIHtcbiAgLyoqIEFic29sdXRlIHBhdGhzIG9mIGFsbCBmaWxlcyB3cml0dGVuICovXG4gIHBhdGhzOiBzdHJpbmdbXTtcbiAgLyoqIENvdW50IGJ5IGNhdGVnb3J5ICovXG4gIGNvdW50czoge1xuICAgIHJvYWRtYXBzOiBudW1iZXI7XG4gICAgcGxhbnM6IG51bWJlcjtcbiAgICB0YXNrUGxhbnM6IG51bWJlcjtcbiAgICB0YXNrU3VtbWFyaWVzOiBudW1iZXI7XG4gICAgc2xpY2VTdW1tYXJpZXM6IG51bWJlcjtcbiAgICByZXNlYXJjaDogbnVtYmVyO1xuICAgIHJlcXVpcmVtZW50czogbnVtYmVyO1xuICAgIGNvbnRleHRzOiBudW1iZXI7XG4gICAgb3RoZXI6IG51bWJlcjtcbiAgfTtcbn1cblxuLyoqIFByZS13cml0ZSBzdGF0aXN0aWNzIGNvbXB1dGVkIGZyb20gYSBHU0RQcm9qZWN0IHdpdGhvdXQgSS9PLiAqL1xuZXhwb3J0IGludGVyZmFjZSBNaWdyYXRpb25QcmV2aWV3IHtcbiAgZGVjaXNpb25zOiB7XG4gICAgdG90YWw6IG51bWJlcjtcbiAgfTtcbiAgbWlsZXN0b25lQ291bnQ6IG51bWJlcjtcbiAgdG90YWxTbGljZXM6IG51bWJlcjtcbiAgdG90YWxUYXNrczogbnVtYmVyO1xuICBkb25lU2xpY2VzOiBudW1iZXI7XG4gIGRvbmVUYXNrczogbnVtYmVyO1xuICBzbGljZUNvbXBsZXRpb25QY3Q6IG51bWJlcjtcbiAgdGFza0NvbXBsZXRpb25QY3Q6IG51bWJlcjtcbiAgcmVxdWlyZW1lbnRzOiB7XG4gICAgYWN0aXZlOiBudW1iZXI7XG4gICAgdmFsaWRhdGVkOiBudW1iZXI7XG4gICAgZGVmZXJyZWQ6IG51bWJlcjtcbiAgICBvdXRPZlNjb3BlOiBudW1iZXI7XG4gICAgdG90YWw6IG51bWJlcjtcbiAgfTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIExvY2FsIEhlbHBlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogU2VyaWFsaXplIGEgZmxhdCBrZXktdmFsdWUgbWFwIGludG8gWUFNTCBmcm9udG1hdHRlciBibG9jay5cbiAqIE1hdGNoZXMgcGFyc2VGcm9udG1hdHRlck1hcCgpIGV4cGVjdGF0aW9uczpcbiAqIC0gU2NhbGFyczogYGtleTogdmFsdWVgXG4gKiAtIEFycmF5cyBvZiBzdHJpbmdzOiBga2V5OlxcbiAgLSBpdGVtYFxuICogLSBFbXB0eSBhcnJheXM6IGBrZXk6IFtdYFxuICogLSBBcnJheXMgb2Ygb2JqZWN0czogYGtleTpcXG4gIC0gZmllbGQxOiB2YWxcXG4gICAgZmllbGQyOiB2YWxgXG4gKiAtIEJvb2xlYW46IGBrZXk6IHRydWUvZmFsc2VgXG4gKi9cbmZ1bmN0aW9uIHNlcmlhbGl6ZUZyb250bWF0dGVyKGRhdGE6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogc3RyaW5nIHtcbiAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gWyctLS0nXTtcblxuICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhkYXRhKSkge1xuICAgIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkIHx8IHZhbHVlID09PSBudWxsKSBjb250aW51ZTtcblxuICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdib29sZWFuJykge1xuICAgICAgbGluZXMucHVzaChgJHtrZXl9OiAke3ZhbHVlfWApO1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJyB8fCB0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInKSB7XG4gICAgICBsaW5lcy5wdXNoKGAke2tleX06ICR7dmFsdWV9YCk7XG4gICAgfSBlbHNlIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgaWYgKHZhbHVlLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICBsaW5lcy5wdXNoKGAke2tleX06IFtdYCk7XG4gICAgICB9IGVsc2UgaWYgKHR5cGVvZiB2YWx1ZVswXSA9PT0gJ29iamVjdCcgJiYgdmFsdWVbMF0gIT09IG51bGwpIHtcbiAgICAgICAgLy8gQXJyYXkgb2Ygb2JqZWN0c1xuICAgICAgICBsaW5lcy5wdXNoKGAke2tleX06YCk7XG4gICAgICAgIGZvciAoY29uc3Qgb2JqIG9mIHZhbHVlKSB7XG4gICAgICAgICAgY29uc3QgZW50cmllcyA9IE9iamVjdC5lbnRyaWVzKG9iaiBhcyBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+KTtcbiAgICAgICAgICBpZiAoZW50cmllcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBsaW5lcy5wdXNoKGAgIC0gJHtlbnRyaWVzWzBdWzBdfTogJHtlbnRyaWVzWzBdWzFdfWApO1xuICAgICAgICAgICAgZm9yIChsZXQgaSA9IDE7IGkgPCBlbnRyaWVzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgICAgIGxpbmVzLnB1c2goYCAgICAke2VudHJpZXNbaV1bMF19OiAke2VudHJpZXNbaV1bMV19YCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBBcnJheSBvZiBzY2FsYXJzXG4gICAgICAgIGxpbmVzLnB1c2goYCR7a2V5fTpgKTtcbiAgICAgICAgZm9yIChjb25zdCBpdGVtIG9mIHZhbHVlKSB7XG4gICAgICAgICAgbGluZXMucHVzaChgICAtICR7aXRlbX1gKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGxpbmVzLnB1c2goJy0tLScpO1xuICByZXR1cm4gbGluZXMuam9pbignXFxuJyk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBGb3JtYXQgRnVuY3Rpb25zIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIEZvcm1hdCBhIG1pbGVzdG9uZSdzIFJPQURNQVAubWQgY29udGVudC5cbiAqIE91dHB1dCBtdXN0IHBhcnNlIGNvcnJlY3RseSB0aHJvdWdoIHBhcnNlUm9hZG1hcCgpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0Um9hZG1hcChtaWxlc3RvbmU6IEdTRE1pbGVzdG9uZSk6IHN0cmluZyB7XG4gIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuXG4gIGxpbmVzLnB1c2goYCMgJHttaWxlc3RvbmUuaWR9OiAke21pbGVzdG9uZS50aXRsZX1gKTtcbiAgbGluZXMucHVzaCgnJyk7XG4gIGxpbmVzLnB1c2goYCoqVmlzaW9uOioqICR7bWlsZXN0b25lLnZpc2lvbiB8fCAnKG1pZ3JhdGVkIHByb2plY3QpJ31gKTtcbiAgbGluZXMucHVzaCgnJyk7XG5cbiAgbGluZXMucHVzaCgnIyMgU3VjY2VzcyBDcml0ZXJpYScpO1xuICBsaW5lcy5wdXNoKCcnKTtcbiAgaWYgKG1pbGVzdG9uZS5zdWNjZXNzQ3JpdGVyaWEubGVuZ3RoID4gMCkge1xuICAgIGZvciAoY29uc3QgY3JpdGVyaW9uIG9mIG1pbGVzdG9uZS5zdWNjZXNzQ3JpdGVyaWEpIHtcbiAgICAgIGxpbmVzLnB1c2goYC0gJHtjcml0ZXJpb259YCk7XG4gICAgfVxuICB9XG4gIGxpbmVzLnB1c2goJycpO1xuXG4gIGxpbmVzLnB1c2goJyMjIFNsaWNlcycpO1xuICBsaW5lcy5wdXNoKCcnKTtcbiAgZm9yIChjb25zdCBzbGljZSBvZiBtaWxlc3RvbmUuc2xpY2VzKSB7XG4gICAgY29uc3QgY2hlY2sgPSBzbGljZS5kb25lID8gJ3gnIDogJyAnO1xuICAgIGNvbnN0IGRlcHNTdHIgPSBzbGljZS5kZXBlbmRzLmxlbmd0aCA+IDAgPyBzbGljZS5kZXBlbmRzLmpvaW4oJywgJykgOiAnJztcbiAgICBsaW5lcy5wdXNoKGAtIFske2NoZWNrfV0gKioke3NsaWNlLmlkfTogJHtzbGljZS50aXRsZX0qKiBcXGByaXNrOiR7c2xpY2Uucmlza31cXGAgXFxgZGVwZW5kczpbJHtkZXBzU3RyfV1cXGBgKTtcbiAgICBpZiAoc2xpY2UuZGVtbykge1xuICAgICAgbGluZXMucHVzaChgICA+IEFmdGVyIHRoaXM6ICR7c2xpY2UuZGVtb31gKTtcbiAgICB9XG4gIH1cblxuICAvLyBTa2lwIEJvdW5kYXJ5IE1hcCBzZWN0aW9uIGVudGlyZWx5IHBlciBEMDA0XG5cbiAgcmV0dXJuIGxpbmVzLmpvaW4oJ1xcbicpICsgJ1xcbic7XG59XG5cbi8qKlxuICogRm9ybWF0IGEgc2xpY2UncyBQTEFOLm1kIChTMDEtUExBTi5tZCkuXG4gKiBPdXRwdXQgbXVzdCBwYXJzZSBjb3JyZWN0bHkgdGhyb3VnaCBwYXJzZVBsYW4oKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdFBsYW4oc2xpY2U6IEdTRFNsaWNlKTogc3RyaW5nIHtcbiAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG5cbiAgbGluZXMucHVzaChgIyAke3NsaWNlLmlkfTogJHtzbGljZS50aXRsZX1gKTtcbiAgbGluZXMucHVzaCgnJyk7XG4gIGxpbmVzLnB1c2goYCoqR29hbDoqKiAke3NsaWNlLmdvYWwgfHwgc2xpY2UudGl0bGV9YCk7XG4gIGxpbmVzLnB1c2goYCoqRGVtbzoqKiAke3NsaWNlLmRlbW8gfHwgc2xpY2UudGl0bGV9YCk7XG4gIGxpbmVzLnB1c2goJycpO1xuXG4gIGxpbmVzLnB1c2goJyMjIE11c3QtSGF2ZXMnKTtcbiAgbGluZXMucHVzaCgnJyk7XG4gIC8vIE5vIG11c3QtaGF2ZXMgaW4gbWlncmF0ZWQgZGF0YSBcdTIwMTQgZW1wdHkgc2VjdGlvblxuICBsaW5lcy5wdXNoKCcnKTtcblxuICBsaW5lcy5wdXNoKCcjIyBUYXNrcycpO1xuICBsaW5lcy5wdXNoKCcnKTtcbiAgZm9yIChjb25zdCB0YXNrIG9mIHNsaWNlLnRhc2tzKSB7XG4gICAgY29uc3QgY2hlY2sgPSB0YXNrLmRvbmUgPyAneCcgOiAnICc7XG4gICAgY29uc3QgZXN0UGFydCA9IHRhc2suZXN0aW1hdGUgPyBgIFxcYGVzdDoke3Rhc2suZXN0aW1hdGV9XFxgYCA6ICcnO1xuICAgIGxpbmVzLnB1c2goYC0gWyR7Y2hlY2t9XSAqKiR7dGFzay5pZH06ICR7dGFzay50aXRsZX0qKiR7ZXN0UGFydH1gKTtcbiAgICBpZiAodGFzay5kZXNjcmlwdGlvbikge1xuICAgICAgbGluZXMucHVzaChgICAtICR7dGFzay5kZXNjcmlwdGlvbn1gKTtcbiAgICB9XG4gIH1cbiAgbGluZXMucHVzaCgnJyk7XG5cbiAgbGluZXMucHVzaCgnIyMgRmlsZXMgTGlrZWx5IFRvdWNoZWQnKTtcbiAgbGluZXMucHVzaCgnJyk7XG4gIGZvciAoY29uc3QgdGFzayBvZiBzbGljZS50YXNrcykge1xuICAgIGZvciAoY29uc3QgZmlsZSBvZiB0YXNrLmZpbGVzKSB7XG4gICAgICBsaW5lcy5wdXNoKGAtIFxcYCR7ZmlsZX1cXGBgKTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gbGluZXMuam9pbignXFxuJykgKyAnXFxuJztcbn1cblxuLyoqXG4gKiBGb3JtYXQgYSBzbGljZSBzdW1tYXJ5IChTMDEtU1VNTUFSWS5tZCkuXG4gKiBPdXRwdXQgbXVzdCBwYXJzZSBjb3JyZWN0bHkgdGhyb3VnaCBwYXJzZVN1bW1hcnkoKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdFNsaWNlU3VtbWFyeShzbGljZTogR1NEU2xpY2UsIG1pbGVzdG9uZUlkOiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAoIXNsaWNlLnN1bW1hcnkpIHJldHVybiAnJztcblxuICBjb25zdCBzID0gc2xpY2Uuc3VtbWFyeTtcbiAgY29uc3QgZm0gPSBzZXJpYWxpemVGcm9udG1hdHRlcih7XG4gICAgaWQ6IHNsaWNlLmlkLFxuICAgIHBhcmVudDogbWlsZXN0b25lSWQsXG4gICAgbWlsZXN0b25lOiBtaWxlc3RvbmVJZCxcbiAgICBwcm92aWRlczogcy5wcm92aWRlcyxcbiAgICByZXF1aXJlczogW10sXG4gICAgYWZmZWN0czogW10sXG4gICAga2V5X2ZpbGVzOiBzLmtleUZpbGVzLFxuICAgIGtleV9kZWNpc2lvbnM6IHMua2V5RGVjaXNpb25zLFxuICAgIHBhdHRlcm5zX2VzdGFibGlzaGVkOiBzLnBhdHRlcm5zRXN0YWJsaXNoZWQsXG4gICAgb2JzZXJ2YWJpbGl0eV9zdXJmYWNlczogW10sXG4gICAgZHJpbGxfZG93bl9wYXRoczogW10sXG4gICAgZHVyYXRpb246IHMuZHVyYXRpb24gfHwgJycsXG4gICAgdmVyaWZpY2F0aW9uX3Jlc3VsdDogJ3Bhc3NlZCcsXG4gICAgY29tcGxldGVkX2F0OiBzLmNvbXBsZXRlZEF0IHx8ICcnLFxuICAgIGJsb2NrZXJfZGlzY292ZXJlZDogZmFsc2UsXG4gIH0pO1xuXG4gIGNvbnN0IGJvZHkgPSBbXG4gICAgJycsXG4gICAgYCMgJHtzbGljZS5pZH06ICR7c2xpY2UudGl0bGV9YCxcbiAgICAnJyxcbiAgICBgKioke3Mud2hhdEhhcHBlbmVkID8gcy53aGF0SGFwcGVuZWQuc3BsaXQoJ1xcbicpWzBdIDogJ01pZ3JhdGVkIGZyb20gbGVnYWN5IGZvcm1hdCd9KipgLFxuICAgICcnLFxuICAgICcjIyBXaGF0IEhhcHBlbmVkJyxcbiAgICAnJyxcbiAgICBzLndoYXRIYXBwZW5lZCB8fCAnTWlncmF0ZWQgZnJvbSBsZWdhY3kgcGxhbm5pbmcgZm9ybWF0LicsXG4gIF07XG5cbiAgcmV0dXJuIGZtICsgYm9keS5qb2luKCdcXG4nKSArICdcXG4nO1xufVxuXG4vKipcbiAqIEZvcm1hdCBhIHRhc2sgc3VtbWFyeSAoVDAxLVNVTU1BUlkubWQpLlxuICogT3V0cHV0IG11c3QgcGFyc2UgY29ycmVjdGx5IHRocm91Z2ggcGFyc2VTdW1tYXJ5KCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXRUYXNrU3VtbWFyeSh0YXNrOiBHU0RUYXNrLCBzbGljZUlkOiBzdHJpbmcsIG1pbGVzdG9uZUlkOiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAoIXRhc2suc3VtbWFyeSkgcmV0dXJuICcnO1xuXG4gIGNvbnN0IHMgPSB0YXNrLnN1bW1hcnk7XG4gIGNvbnN0IGZtID0gc2VyaWFsaXplRnJvbnRtYXR0ZXIoe1xuICAgIGlkOiB0YXNrLmlkLFxuICAgIHBhcmVudDogc2xpY2VJZCxcbiAgICBtaWxlc3RvbmU6IG1pbGVzdG9uZUlkLFxuICAgIHByb3ZpZGVzOiBzLnByb3ZpZGVzLFxuICAgIHJlcXVpcmVzOiBbXSxcbiAgICBhZmZlY3RzOiBbXSxcbiAgICBrZXlfZmlsZXM6IHMua2V5RmlsZXMsXG4gICAga2V5X2RlY2lzaW9uczogW10sXG4gICAgcGF0dGVybnNfZXN0YWJsaXNoZWQ6IFtdLFxuICAgIG9ic2VydmFiaWxpdHlfc3VyZmFjZXM6IFtdLFxuICAgIGRyaWxsX2Rvd25fcGF0aHM6IFtdLFxuICAgIGR1cmF0aW9uOiBzLmR1cmF0aW9uIHx8ICcnLFxuICAgIHZlcmlmaWNhdGlvbl9yZXN1bHQ6ICdwYXNzZWQnLFxuICAgIGNvbXBsZXRlZF9hdDogcy5jb21wbGV0ZWRBdCB8fCAnJyxcbiAgICBibG9ja2VyX2Rpc2NvdmVyZWQ6IGZhbHNlLFxuICB9KTtcblxuICBjb25zdCBib2R5ID0gW1xuICAgICcnLFxuICAgIGAjICR7dGFzay5pZH06ICR7dGFzay50aXRsZX1gLFxuICAgICcnLFxuICAgIGAqKiR7cy53aGF0SGFwcGVuZWQgPyBzLndoYXRIYXBwZW5lZC5zcGxpdCgnXFxuJylbMF0gOiAnTWlncmF0ZWQgZnJvbSBsZWdhY3kgZm9ybWF0J30qKmAsXG4gICAgJycsXG4gICAgJyMjIFdoYXQgSGFwcGVuZWQnLFxuICAgICcnLFxuICAgIHMud2hhdEhhcHBlbmVkIHx8ICdNaWdyYXRlZCBmcm9tIGxlZ2FjeSBwbGFubmluZyBmb3JtYXQuJyxcbiAgXTtcblxuICByZXR1cm4gZm0gKyBib2R5LmpvaW4oJ1xcbicpICsgJ1xcbic7XG59XG5cbi8qKlxuICogRm9ybWF0IGEgdGFzayBwbGFuIChUMDEtUExBTi5tZCkuXG4gKiBkZXJpdmVTdGF0ZSgpIG9ubHkgY2hlY2tzIGZvciBmaWxlIGV4aXN0ZW5jZSwgbm90IGNvbnRlbnQuXG4gKiBLZWVwIGl0IG1pbmltYWwgYnV0IHZhbGlkIG1hcmtkb3duLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0VGFza1BsYW4odGFzazogR1NEVGFzaywgc2xpY2VJZDogc3RyaW5nLCBtaWxlc3RvbmVJZDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG4gIGxpbmVzLnB1c2goYCMgJHt0YXNrLmlkfTogJHt0YXNrLnRpdGxlfWApO1xuICBsaW5lcy5wdXNoKCcnKTtcbiAgbGluZXMucHVzaChgKipTbGljZToqKiAke3NsaWNlSWR9IFx1MjAxNCAqKk1pbGVzdG9uZToqKiAke21pbGVzdG9uZUlkfWApO1xuICBsaW5lcy5wdXNoKCcnKTtcbiAgbGluZXMucHVzaCgnIyMgRGVzY3JpcHRpb24nKTtcbiAgbGluZXMucHVzaCgnJyk7XG4gIGxpbmVzLnB1c2godGFzay5kZXNjcmlwdGlvbiB8fCAnTWlncmF0ZWQgZnJvbSBsZWdhY3kgcGxhbm5pbmcgZm9ybWF0LicpO1xuICBsaW5lcy5wdXNoKCcnKTtcblxuICBpZiAodGFzay5tdXN0SGF2ZXMubGVuZ3RoID4gMCkge1xuICAgIGxpbmVzLnB1c2goJyMjIE11c3QtSGF2ZXMnKTtcbiAgICBsaW5lcy5wdXNoKCcnKTtcbiAgICBmb3IgKGNvbnN0IG1oIG9mIHRhc2subXVzdEhhdmVzKSB7XG4gICAgICBsaW5lcy5wdXNoKGAtIFsgXSAke21ofWApO1xuICAgIH1cbiAgICBsaW5lcy5wdXNoKCcnKTtcbiAgfVxuXG4gIGlmICh0YXNrLmZpbGVzLmxlbmd0aCA+IDApIHtcbiAgICBsaW5lcy5wdXNoKCcjIyBGaWxlcycpO1xuICAgIGxpbmVzLnB1c2goJycpO1xuICAgIGZvciAoY29uc3QgZiBvZiB0YXNrLmZpbGVzKSB7XG4gICAgICBsaW5lcy5wdXNoKGAtIFxcYCR7Zn1cXGBgKTtcbiAgICB9XG4gICAgbGluZXMucHVzaCgnJyk7XG4gIH1cblxuICByZXR1cm4gbGluZXMuam9pbignXFxuJyk7XG59XG5cbi8qKlxuICogRm9ybWF0IFJFUVVJUkVNRU5UUy5tZCBncm91cGVkIGJ5IHN0YXR1cy5cbiAqIE91dHB1dCBtdXN0IHBhcnNlIGNvcnJlY3RseSB0aHJvdWdoIHBhcnNlUmVxdWlyZW1lbnRDb3VudHMoKS5cbiAqIHBhcnNlUmVxdWlyZW1lbnRDb3VudHMgZXhwZWN0czogIyMgQWN0aXZlLyMjIFZhbGlkYXRlZC8jIyBEZWZlcnJlZC8jIyBPdXQgb2YgU2NvcGUgc2VjdGlvbnNcbiAqIHdpdGggIyMjIFIwMDEgXHUyMDE0IFRpdGxlIGhlYWRpbmdzIHVuZGVyIGVhY2ggc2VjdGlvbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdFJlcXVpcmVtZW50cyhyZXF1aXJlbWVudHM6IEdTRFJlcXVpcmVtZW50W10pOiBzdHJpbmcge1xuICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcbiAgbGluZXMucHVzaCgnIyBSZXF1aXJlbWVudHMnKTtcbiAgbGluZXMucHVzaCgnJyk7XG5cbiAgY29uc3QgZ3JvdXBzOiBSZWNvcmQ8c3RyaW5nLCBHU0RSZXF1aXJlbWVudFtdPiA9IHtcbiAgICBhY3RpdmU6IFtdLFxuICAgIHZhbGlkYXRlZDogW10sXG4gICAgZGVmZXJyZWQ6IFtdLFxuICAgICdvdXQtb2Ytc2NvcGUnOiBbXSxcbiAgfTtcblxuICBmb3IgKGNvbnN0IHJlcSBvZiByZXF1aXJlbWVudHMpIHtcbiAgICBjb25zdCBzdGF0dXMgPSByZXEuc3RhdHVzLnRvTG93ZXJDYXNlKCk7XG4gICAgaWYgKHN0YXR1cyBpbiBncm91cHMpIHtcbiAgICAgIGdyb3Vwc1tzdGF0dXNdLnB1c2gocmVxKTtcbiAgICB9IGVsc2Uge1xuICAgICAgZ3JvdXBzLmFjdGl2ZS5wdXNoKHJlcSk7XG4gICAgfVxuICB9XG5cbiAgY29uc3Qgc2VjdGlvbk1hcDogW3N0cmluZywgc3RyaW5nXVtdID0gW1xuICAgIFsnYWN0aXZlJywgJ0FjdGl2ZSddLFxuICAgIFsndmFsaWRhdGVkJywgJ1ZhbGlkYXRlZCddLFxuICAgIFsnZGVmZXJyZWQnLCAnRGVmZXJyZWQnXSxcbiAgICBbJ291dC1vZi1zY29wZScsICdPdXQgb2YgU2NvcGUnXSxcbiAgXTtcblxuICBmb3IgKGNvbnN0IFtrZXksIGhlYWRpbmddIG9mIHNlY3Rpb25NYXApIHtcbiAgICBsaW5lcy5wdXNoKGAjIyAke2hlYWRpbmd9YCk7XG4gICAgbGluZXMucHVzaCgnJyk7XG4gICAgZm9yIChjb25zdCByZXEgb2YgZ3JvdXBzW2tleV0pIHtcbiAgICAgIGxpbmVzLnB1c2goYCMjIyAke3JlcS5pZH0gXHUyMDE0ICR7cmVxLnRpdGxlfWApO1xuICAgICAgbGluZXMucHVzaCgnJyk7XG4gICAgICBsaW5lcy5wdXNoKGAtIFN0YXR1czogJHtyZXEuc3RhdHVzfWApO1xuICAgICAgbGluZXMucHVzaChgLSBDbGFzczogJHtyZXEuY2xhc3N9YCk7XG4gICAgICBsaW5lcy5wdXNoKGAtIFNvdXJjZTogJHtyZXEuc291cmNlfWApO1xuICAgICAgbGluZXMucHVzaChgLSBQcmltYXJ5IFNsaWNlOiAke3JlcS5wcmltYXJ5U2xpY2V9YCk7XG4gICAgICBsaW5lcy5wdXNoKCcnKTtcbiAgICAgIGlmIChyZXEuZGVzY3JpcHRpb24pIHtcbiAgICAgICAgbGluZXMucHVzaChyZXEuZGVzY3JpcHRpb24pO1xuICAgICAgICBsaW5lcy5wdXNoKCcnKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4gbGluZXMuam9pbignXFxuJyk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBQYXNzdGhyb3VnaCBGb3JtYXQgSGVscGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBGb3JtYXQgUFJPSkVDVC5tZCBjb250ZW50LlxuICogSWYgY29udGVudCBpcyBlbXB0eSwgcHJvZHVjZSBhIG1pbmltYWwgdmFsaWQgc3R1Yi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdFByb2plY3QoY29udGVudDogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKCFjb250ZW50IHx8ICFjb250ZW50LnRyaW0oKSkge1xuICAgIHJldHVybiAnIyBQcm9qZWN0XFxuXFxuKE1pZ3JhdGVkIHByb2plY3QgXHUyMDE0IG5vIGRlc2NyaXB0aW9uIGF2YWlsYWJsZS4pXFxuJztcbiAgfVxuICByZXR1cm4gY29udGVudC5lbmRzV2l0aCgnXFxuJykgPyBjb250ZW50IDogY29udGVudCArICdcXG4nO1xufVxuXG4vKipcbiAqIEZvcm1hdCBERUNJU0lPTlMubWQgY29udGVudC5cbiAqIElmIGNvbnRlbnQgaXMgZW1wdHksIHByb2R1Y2UgdGhlIHN0YW5kYXJkIGhlYWRlci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdERlY2lzaW9ucyhjb250ZW50OiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAoIWNvbnRlbnQgfHwgIWNvbnRlbnQudHJpbSgpKSB7XG4gICAgcmV0dXJuIFtcbiAgICAgICcjIERlY2lzaW9ucyBSZWdpc3RlcicsXG4gICAgICAnJyxcbiAgICAgICc8IS0tIEFwcGVuZC1vbmx5LiBOZXZlciBlZGl0IG9yIHJlbW92ZSBleGlzdGluZyByb3dzLicsXG4gICAgICAnICAgICBUbyByZXZlcnNlIGEgZGVjaXNpb24sIGFkZCBhIG5ldyByb3cgdGhhdCBzdXBlcnNlZGVzIGl0LicsXG4gICAgICAnICAgICBSZWFkIHRoaXMgZmlsZSBhdCB0aGUgc3RhcnQgb2YgYW55IHBsYW5uaW5nIG9yIHJlc2VhcmNoIHBoYXNlLiAtLT4nLFxuICAgICAgJycsXG4gICAgICAnfCAjIHwgV2hlbiB8IFNjb3BlIHwgRGVjaXNpb24gfCBDaG9pY2UgfCBSYXRpb25hbGUgfCBSZXZpc2FibGU/IHwgTWFkZSBCeSB8JyxcbiAgICAgICd8LS0tfC0tLS0tLXwtLS0tLS0tfC0tLS0tLS0tLS18LS0tLS0tLS18LS0tLS0tLS0tLS18LS0tLS0tLS0tLS0tfC0tLS0tLS0tLXwnLFxuICAgICAgJycsXG4gICAgXS5qb2luKCdcXG4nKTtcbiAgfVxuICByZXR1cm4gY29udGVudC5lbmRzV2l0aCgnXFxuJykgPyBjb250ZW50IDogY29udGVudCArICdcXG4nO1xufVxuXG4vKipcbiAqIEZvcm1hdCBhIG1pbGVzdG9uZSBDT05URVhULm1kLlxuICogTWluaW1hbCBjb250ZXh0IHdpdGggbm8gZGVwZW5kcyBcdTIwMTQgbWlncmF0ZWQgbWlsZXN0b25lcyBoYXZlIG5vIHVwc3RyZWFtIGRlcGVuZGVuY2llcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdENvbnRleHQobWlsZXN0b25lSWQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgIyAke21pbGVzdG9uZUlkfSBDb250ZXh0XFxuXFxuTWlncmF0ZWQgbWlsZXN0b25lIFx1MjAxNCBubyB1cHN0cmVhbSBkZXBlbmRlbmNpZXMuXFxuYDtcbn1cblxuLyoqXG4gKiBGb3JtYXQgU1RBVEUubWQuXG4gKiBkZXJpdmVTdGF0ZSgpIGRvZXMgbm90IHJlYWQgU1RBVEUubWQgXHUyMDE0IGl0IHJlY29tcHV0ZXMgZnJvbSBzY3JhdGNoLlxuICogV3JpdGUgYSBtaW5pbWFsIHN0dWIgdGhhdCB3aWxsIGJlIG92ZXJ3cml0dGVuIG9uIGZpcnN0IC9nc2Qgc3RhdHVzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0U3RhdGUobWlsZXN0b25lczogR1NETWlsZXN0b25lW10pOiBzdHJpbmcge1xuICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcbiAgbGluZXMucHVzaCgnIyBHU0QgU3RhdGUnKTtcbiAgbGluZXMucHVzaCgnJyk7XG4gIGxpbmVzLnB1c2goJzwhLS0gQXV0by1nZW5lcmF0ZWQuIFVwZGF0ZWQgYnkgZGVyaXZlU3RhdGUoKS4gLS0+Jyk7XG4gIGxpbmVzLnB1c2goJycpO1xuICBmb3IgKGNvbnN0IG0gb2YgbWlsZXN0b25lcykge1xuICAgIGNvbnN0IGRvbmVTbGljZXMgPSBtLnNsaWNlcy5maWx0ZXIocyA9PiBzLmRvbmUpLmxlbmd0aDtcbiAgICBjb25zdCB0b3RhbFNsaWNlcyA9IG0uc2xpY2VzLmxlbmd0aDtcbiAgICBsaW5lcy5wdXNoKGAjIyAke20uaWR9OiAke20udGl0bGV9YCk7XG4gICAgbGluZXMucHVzaCgnJyk7XG4gICAgbGluZXMucHVzaChgLSBTbGljZXM6ICR7ZG9uZVNsaWNlc30vJHt0b3RhbFNsaWNlc31gKTtcbiAgICBsaW5lcy5wdXNoKCcnKTtcbiAgfVxuICByZXR1cm4gbGluZXMuam9pbignXFxuJyk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBEaXJlY3RvcnkgV3JpdGVyIE9yY2hlc3RyYXRvciBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBXcml0ZSBhIGNvbXBsZXRlIC5nc2QgZGlyZWN0b3J5IHRyZWUgZnJvbSBhIEdTRFByb2plY3QuXG4gKiBJdGVyYXRlcyBtaWxlc3RvbmVzIFx1MjE5MiBzbGljZXMgXHUyMTkyIHRhc2tzLCBjYWxscyBmb3JtYXQgZnVuY3Rpb25zLFxuICogYW5kIHdyaXRlcyBlYWNoIGZpbGUgdmlhIHNhdmVGaWxlKCkuIFJldHVybnMgYSBtYW5pZmVzdCBvZiB3cml0dGVuIHBhdGhzLlxuICpcbiAqIFNraXBzIHJlc2VhcmNoL3N1bW1hcnkgZmlsZXMgd2hlbiBudWxsIChkb2VzIG5vdCB3cml0ZSBlbXB0eSBzdHVicykuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB3cml0ZUdTRERpcmVjdG9yeShcbiAgcHJvamVjdDogR1NEUHJvamVjdCxcbiAgdGFyZ2V0UGF0aDogc3RyaW5nLFxuKTogUHJvbWlzZTxXcml0dGVuRmlsZXM+IHtcbiAgY29uc3QgZ3NkRGlyID0gZ3NkUm9vdCh0YXJnZXRQYXRoKTtcbiAgY29uc3QgbWlsZXN0b25lc0Jhc2UgPSBqb2luKGdzZERpciwgJ21pbGVzdG9uZXMnKTtcbiAgY29uc3QgcGF0aHM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IGNvdW50czogV3JpdHRlbkZpbGVzWydjb3VudHMnXSA9IHtcbiAgICByb2FkbWFwczogMCxcbiAgICBwbGFuczogMCxcbiAgICB0YXNrUGxhbnM6IDAsXG4gICAgdGFza1N1bW1hcmllczogMCxcbiAgICBzbGljZVN1bW1hcmllczogMCxcbiAgICByZXNlYXJjaDogMCxcbiAgICByZXF1aXJlbWVudHM6IDAsXG4gICAgY29udGV4dHM6IDAsXG4gICAgb3RoZXI6IDAsXG4gIH07XG5cbiAgLy8gUm9vdC1sZXZlbCBmaWxlc1xuICBjb25zdCBwcm9qZWN0UGF0aCA9IGpvaW4oZ3NkRGlyLCAnUFJPSkVDVC5tZCcpO1xuICBhd2FpdCBzYXZlRmlsZShwcm9qZWN0UGF0aCwgZm9ybWF0UHJvamVjdChwcm9qZWN0LnByb2plY3RDb250ZW50KSk7XG4gIHBhdGhzLnB1c2gocHJvamVjdFBhdGgpO1xuICBjb3VudHMub3RoZXIrKztcblxuICBjb25zdCBkZWNpc2lvbnNQYXRoID0gam9pbihnc2REaXIsICdERUNJU0lPTlMubWQnKTtcbiAgYXdhaXQgc2F2ZUZpbGUoZGVjaXNpb25zUGF0aCwgZm9ybWF0RGVjaXNpb25zKHByb2plY3QuZGVjaXNpb25zQ29udGVudCkpO1xuICBwYXRocy5wdXNoKGRlY2lzaW9uc1BhdGgpO1xuICBjb3VudHMub3RoZXIrKztcblxuICBjb25zdCBzdGF0ZVBhdGggPSBqb2luKGdzZERpciwgJ1NUQVRFLm1kJyk7XG4gIGF3YWl0IHNhdmVGaWxlKHN0YXRlUGF0aCwgZm9ybWF0U3RhdGUocHJvamVjdC5taWxlc3RvbmVzKSk7XG4gIHBhdGhzLnB1c2goc3RhdGVQYXRoKTtcbiAgY291bnRzLm90aGVyKys7XG5cbiAgaWYgKHByb2plY3QucmVxdWlyZW1lbnRzLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCByZXFQYXRoID0gam9pbihnc2REaXIsICdSRVFVSVJFTUVOVFMubWQnKTtcbiAgICBhd2FpdCBzYXZlRmlsZShyZXFQYXRoLCBmb3JtYXRSZXF1aXJlbWVudHMocHJvamVjdC5yZXF1aXJlbWVudHMpKTtcbiAgICBwYXRocy5wdXNoKHJlcVBhdGgpO1xuICAgIGNvdW50cy5yZXF1aXJlbWVudHMrKztcbiAgfVxuXG4gIC8vIE1pbGVzdG9uZXNcbiAgZm9yIChjb25zdCBtaWxlc3RvbmUgb2YgcHJvamVjdC5taWxlc3RvbmVzKSB7XG4gICAgY29uc3QgbURpciA9IGpvaW4obWlsZXN0b25lc0Jhc2UsIG1pbGVzdG9uZS5pZCk7XG5cbiAgICAvLyBSb2FkbWFwIChhbHdheXMgd3JpdHRlbiwgZXZlbiBmb3IgZW1wdHkgbWlsZXN0b25lcylcbiAgICBjb25zdCByb2FkbWFwUGF0aCA9IGpvaW4obURpciwgYCR7bWlsZXN0b25lLmlkfS1ST0FETUFQLm1kYCk7XG4gICAgYXdhaXQgc2F2ZUZpbGUocm9hZG1hcFBhdGgsIGZvcm1hdFJvYWRtYXAobWlsZXN0b25lKSk7XG4gICAgcGF0aHMucHVzaChyb2FkbWFwUGF0aCk7XG4gICAgY291bnRzLnJvYWRtYXBzKys7XG5cbiAgICAvLyBDb250ZXh0XG4gICAgY29uc3QgY29udGV4dFBhdGggPSBqb2luKG1EaXIsIGAke21pbGVzdG9uZS5pZH0tQ09OVEVYVC5tZGApO1xuICAgIGF3YWl0IHNhdmVGaWxlKGNvbnRleHRQYXRoLCBmb3JtYXRDb250ZXh0KG1pbGVzdG9uZS5pZCkpO1xuICAgIHBhdGhzLnB1c2goY29udGV4dFBhdGgpO1xuICAgIGNvdW50cy5jb250ZXh0cysrO1xuXG4gICAgLy8gUmVzZWFyY2ggKHNraXAgaWYgbnVsbClcbiAgICBpZiAobWlsZXN0b25lLnJlc2VhcmNoICE9PSBudWxsKSB7XG4gICAgICBjb25zdCByZXNlYXJjaFBhdGggPSBqb2luKG1EaXIsIGAke21pbGVzdG9uZS5pZH0tUkVTRUFSQ0gubWRgKTtcbiAgICAgIGF3YWl0IHNhdmVGaWxlKHJlc2VhcmNoUGF0aCwgbWlsZXN0b25lLnJlc2VhcmNoKTtcbiAgICAgIHBhdGhzLnB1c2gocmVzZWFyY2hQYXRoKTtcbiAgICAgIGNvdW50cy5yZXNlYXJjaCsrO1xuICAgIH1cblxuICAgIC8vIEZvciBmdWxseS1jb21wbGV0ZWQgbWlsZXN0b25lcyAoYWxsIHNsaWNlcyBkb25lKSwgd3JpdGUgYSBwYXNzLXRocm91Z2hcbiAgICAvLyB2YWxpZGF0aW9uIGZpbGUgc28gZGVyaXZlU3RhdGUoKSBkb2Vzbid0IGVudGVyIHZhbGlkYXRpbmctbWlsZXN0b25lXG4gICAgLy8gcGhhc2UgZm9yIGhpc3RvcmljYWwgbWlsZXN0b25lcyB0aGF0IHByZWRhdGUgdGhlIHZhbGlkYXRpb24gZ2F0ZSAoIzgxOSkuXG4gICAgY29uc3QgYWxsU2xpY2VzRG9uZSA9IG1pbGVzdG9uZS5zbGljZXMubGVuZ3RoID4gMCAmJiBtaWxlc3RvbmUuc2xpY2VzLmV2ZXJ5KHMgPT4gcy5kb25lKTtcbiAgICBpZiAoYWxsU2xpY2VzRG9uZSkge1xuICAgICAgY29uc3QgdmFsaWRhdGlvblBhdGggPSBqb2luKG1EaXIsIGAke21pbGVzdG9uZS5pZH0tVkFMSURBVElPTi5tZGApO1xuICAgICAgY29uc3QgdmFsaWRhdGlvbkNvbnRlbnQgPSBbXG4gICAgICAgIGAtLS1gLFxuICAgICAgICBgdmVyZGljdDogcGFzc2AsXG4gICAgICAgIGBtaWdyYXRlZDogdHJ1ZWAsXG4gICAgICAgIGAtLS1gLFxuICAgICAgICBgYCxcbiAgICAgICAgYCMgJHttaWxlc3RvbmUuaWR9IFZhbGlkYXRpb25gLFxuICAgICAgICBgYCxcbiAgICAgICAgYE1pZ3JhdGVkIG1pbGVzdG9uZSBcdTIwMTQgYWxsIHNsaWNlcyB3ZXJlIGNvbXBsZXRlZCBpbiB0aGUgb3JpZ2luYWwgcHJvamVjdC5gLFxuICAgICAgICBgYCxcbiAgICAgIF0uam9pbignXFxuJyk7XG4gICAgICBhd2FpdCBzYXZlRmlsZSh2YWxpZGF0aW9uUGF0aCwgdmFsaWRhdGlvbkNvbnRlbnQpO1xuICAgICAgcGF0aHMucHVzaCh2YWxpZGF0aW9uUGF0aCk7XG4gICAgICBjb3VudHMub3RoZXIrKztcblxuICAgICAgLy8gQWxzbyB3cml0ZSBhIG1pbGVzdG9uZSBzdW1tYXJ5IGlmIG9uZSBkb2Vzbid0IGV4aXN0XG4gICAgICBjb25zdCBzdW1tYXJ5UGF0aCA9IGpvaW4obURpciwgYCR7bWlsZXN0b25lLmlkfS1TVU1NQVJZLm1kYCk7XG4gICAgICBjb25zdCBzdW1tYXJ5Q29udGVudCA9IFtcbiAgICAgICAgYC0tLWAsXG4gICAgICAgIGBzdGF0dXM6IGRvbmVgLFxuICAgICAgICBgbWlncmF0ZWQ6IHRydWVgLFxuICAgICAgICBgLS0tYCxcbiAgICAgICAgYGAsXG4gICAgICAgIGAjICR7bWlsZXN0b25lLmlkfTogJHttaWxlc3RvbmUudGl0bGV9YCxcbiAgICAgICAgYGAsXG4gICAgICAgIGBNaWdyYXRlZCBmcm9tIC5wbGFubmluZyBcdTIwMTQgJHttaWxlc3RvbmUuc2xpY2VzLmxlbmd0aH0gc2xpY2VzIGNvbXBsZXRlZC5gLFxuICAgICAgICBgYCxcbiAgICAgIF0uam9pbignXFxuJyk7XG4gICAgICBhd2FpdCBzYXZlRmlsZShzdW1tYXJ5UGF0aCwgc3VtbWFyeUNvbnRlbnQpO1xuICAgICAgcGF0aHMucHVzaChzdW1tYXJ5UGF0aCk7XG4gICAgICBjb3VudHMub3RoZXIrKztcbiAgICB9XG5cbiAgICAvLyBTbGljZXNcbiAgICBmb3IgKGNvbnN0IHNsaWNlIG9mIG1pbGVzdG9uZS5zbGljZXMpIHtcbiAgICAgIGNvbnN0IHNEaXIgPSBqb2luKG1EaXIsICdzbGljZXMnLCBzbGljZS5pZCk7XG4gICAgICBjb25zdCB0YXNrc0RpciA9IGpvaW4oc0RpciwgJ3Rhc2tzJyk7XG5cbiAgICAgIC8vIFNsaWNlIHBsYW5cbiAgICAgIGNvbnN0IHBsYW5QYXRoID0gam9pbihzRGlyLCBgJHtzbGljZS5pZH0tUExBTi5tZGApO1xuICAgICAgYXdhaXQgc2F2ZUZpbGUocGxhblBhdGgsIGZvcm1hdFBsYW4oc2xpY2UpKTtcbiAgICAgIHBhdGhzLnB1c2gocGxhblBhdGgpO1xuICAgICAgY291bnRzLnBsYW5zKys7XG5cbiAgICAgIC8vIFNsaWNlIHJlc2VhcmNoIChza2lwIGlmIG51bGwpXG4gICAgICBpZiAoc2xpY2UucmVzZWFyY2ggIT09IG51bGwpIHtcbiAgICAgICAgY29uc3Qgc2xpY2VSZXNlYXJjaFBhdGggPSBqb2luKHNEaXIsIGAke3NsaWNlLmlkfS1SRVNFQVJDSC5tZGApO1xuICAgICAgICBhd2FpdCBzYXZlRmlsZShzbGljZVJlc2VhcmNoUGF0aCwgc2xpY2UucmVzZWFyY2gpO1xuICAgICAgICBwYXRocy5wdXNoKHNsaWNlUmVzZWFyY2hQYXRoKTtcbiAgICAgICAgY291bnRzLnJlc2VhcmNoKys7XG4gICAgICB9XG5cbiAgICAgIC8vIFNsaWNlIHN1bW1hcnkgKHNraXAgaWYgbnVsbClcbiAgICAgIGlmIChzbGljZS5zdW1tYXJ5ICE9PSBudWxsKSB7XG4gICAgICAgIGNvbnN0IHN1bW1hcnlDb250ZW50ID0gZm9ybWF0U2xpY2VTdW1tYXJ5KHNsaWNlLCBtaWxlc3RvbmUuaWQpO1xuICAgICAgICBpZiAoc3VtbWFyeUNvbnRlbnQpIHtcbiAgICAgICAgICBjb25zdCBzdW1tYXJ5UGF0aCA9IGpvaW4oc0RpciwgYCR7c2xpY2UuaWR9LVNVTU1BUlkubWRgKTtcbiAgICAgICAgICBhd2FpdCBzYXZlRmlsZShzdW1tYXJ5UGF0aCwgc3VtbWFyeUNvbnRlbnQpO1xuICAgICAgICAgIHBhdGhzLnB1c2goc3VtbWFyeVBhdGgpO1xuICAgICAgICAgIGNvdW50cy5zbGljZVN1bW1hcmllcysrO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIFRhc2tzXG4gICAgICBmb3IgKGNvbnN0IHRhc2sgb2Ygc2xpY2UudGFza3MpIHtcbiAgICAgICAgLy8gVGFzayBwbGFuIChhbHdheXMgd3JpdHRlbilcbiAgICAgICAgY29uc3QgdGFza1BsYW5QYXRoID0gam9pbih0YXNrc0RpciwgYCR7dGFzay5pZH0tUExBTi5tZGApO1xuICAgICAgICBhd2FpdCBzYXZlRmlsZSh0YXNrUGxhblBhdGgsIGZvcm1hdFRhc2tQbGFuKHRhc2ssIHNsaWNlLmlkLCBtaWxlc3RvbmUuaWQpKTtcbiAgICAgICAgcGF0aHMucHVzaCh0YXNrUGxhblBhdGgpO1xuICAgICAgICBjb3VudHMudGFza1BsYW5zKys7XG5cbiAgICAgICAgLy8gVGFzayBzdW1tYXJ5IChza2lwIGlmIG51bGwpXG4gICAgICAgIGlmICh0YXNrLnN1bW1hcnkgIT09IG51bGwpIHtcbiAgICAgICAgICBjb25zdCB0YXNrU3VtbWFyeUNvbnRlbnQgPSBmb3JtYXRUYXNrU3VtbWFyeSh0YXNrLCBzbGljZS5pZCwgbWlsZXN0b25lLmlkKTtcbiAgICAgICAgICBpZiAodGFza1N1bW1hcnlDb250ZW50KSB7XG4gICAgICAgICAgICBjb25zdCB0YXNrU3VtbWFyeVBhdGggPSBqb2luKHRhc2tzRGlyLCBgJHt0YXNrLmlkfS1TVU1NQVJZLm1kYCk7XG4gICAgICAgICAgICBhd2FpdCBzYXZlRmlsZSh0YXNrU3VtbWFyeVBhdGgsIHRhc2tTdW1tYXJ5Q29udGVudCk7XG4gICAgICAgICAgICBwYXRocy5wdXNoKHRhc2tTdW1tYXJ5UGF0aCk7XG4gICAgICAgICAgICBjb3VudHMudGFza1N1bW1hcmllcysrO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiB7IHBhdGhzLCBjb3VudHMgfTtcbn1c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
