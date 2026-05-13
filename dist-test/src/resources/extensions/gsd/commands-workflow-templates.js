import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveByName,
  autoDetect,
  listTemplates,
  getTemplateInfo,
  loadWorkflowTemplate,
  loadRegistry,
  isLegacyWorkflowMode
} from "./workflow-templates.js";
import { loadPrompt } from "./prompt-loader.js";
import { gsdRoot } from "./paths.js";
import { createGitService, runGit } from "./git-service.js";
import { isAutoActive, isAutoPaused } from "./auto.js";
import { getErrorMessage } from "./error-utils.js";
import { resolvePlugin } from "./workflow-plugins.js";
import { currentDirectoryRoot } from "./commands/context.js";
import { formatRecommendedProcessPaths } from "./process-task-path.js";
import { incrementLegacyTelemetry } from "./legacy-telemetry.js";
function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40).replace(/-$/, "");
}
function getNextWorkflowNum(workflowDir) {
  if (!existsSync(workflowDir)) return 1;
  try {
    const entries = readdirSync(workflowDir, { withFileTypes: true });
    let max = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const match = entry.name.match(/^(\d{6})-(\d+)-/);
      if (match) {
        const num = parseInt(match[2], 10);
        if (num > max) max = num;
      }
    }
    return max + 1;
  } catch {
    return 1;
  }
}
function datePrefix() {
  const d = /* @__PURE__ */ new Date();
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}
function writeWorkflowState(artifactDir, templateId, templateName, phases, description, branch) {
  const statePath = join(artifactDir, "STATE.json");
  const state = {
    template: templateId,
    templateName,
    description,
    branch,
    phases: phases.map((p, i) => ({
      name: p,
      index: i,
      status: i === 0 ? "active" : "pending"
    })),
    currentPhase: 0,
    startedAt: (/* @__PURE__ */ new Date()).toISOString(),
    updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    artifactDir
  };
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
}
function findInProgressWorkflows(basePath) {
  const workflowsRoot = join(gsdRoot(basePath), "workflows");
  if (!existsSync(workflowsRoot)) return [];
  const results = [];
  try {
    for (const category of readdirSync(workflowsRoot, { withFileTypes: true })) {
      if (!category.isDirectory()) continue;
      const categoryDir = join(workflowsRoot, category.name);
      for (const workflow of readdirSync(categoryDir, { withFileTypes: true })) {
        if (!workflow.isDirectory()) continue;
        const statePath = join(categoryDir, workflow.name, "STATE.json");
        if (!existsSync(statePath)) continue;
        try {
          const raw = readFileSync(statePath, "utf-8");
          const state = JSON.parse(raw);
          if (!state.completedAt) {
            results.push(state);
          }
        } catch {
        }
      }
    }
  } catch {
  }
  results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return results;
}
async function handleStart(args, ctx, pi) {
  const trimmed = args.trim();
  if (trimmed === "--list" || trimmed === "list") {
    ctx.ui.notify(listTemplates(), "info");
    return;
  }
  if (isAutoActive()) {
    ctx.ui.notify(
      "Cannot start a workflow template while auto-mode is running.\nRun /gsd pause first, then /gsd start.",
      "warning"
    );
    return;
  }
  if (isAutoPaused()) {
    ctx.ui.notify(
      "Auto-mode is paused. Starting a workflow template will run independently.\nThe paused auto-mode session can be resumed later with /gsd auto.",
      "info"
    );
  }
  if (trimmed === "--resume" || trimmed === "resume") {
    const basePath2 = currentDirectoryRoot();
    const inProgress = findInProgressWorkflows(basePath2);
    if (inProgress.length === 0) {
      ctx.ui.notify("No in-progress workflows found.", "info");
      return;
    }
    const wf = inProgress[0];
    const activePhase = wf.phases.find((p) => p.status === "active");
    const completedCount = wf.phases.filter((p) => p.status === "completed").length;
    ctx.ui.notify(
      `Resuming: ${wf.templateName}
Description: ${wf.description}
Progress: ${completedCount}/${wf.phases.length} phases completed
Current phase: ${activePhase?.name ?? "unknown"}
Branch: ${wf.branch}
Artifacts: ${wf.artifactDir}`,
      "info"
    );
    const workflowContent2 = loadWorkflowTemplate(wf.template);
    if (!workflowContent2) {
      ctx.ui.notify(`Template "${wf.template}" workflow file not found.`, "warning");
      return;
    }
    const prompt2 = loadPrompt("workflow-start", {
      templateId: wf.template,
      templateName: wf.templateName,
      templateDescription: `RESUMING \u2014 pick up from phase "${activePhase?.name ?? "unknown"}" (${completedCount}/${wf.phases.length} phases done)`,
      phases: wf.phases.map((p) => `${p.name}${p.status === "completed" ? " \u2713" : p.status === "active" ? " \u2190" : ""}`).join(" \u2192 "),
      complexity: "resume",
      artifactDir: wf.artifactDir,
      branch: wf.branch,
      description: wf.description,
      issueRef: "(none)",
      date: (/* @__PURE__ */ new Date()).toISOString().split("T")[0],
      workflowContent: workflowContent2
    });
    pi.sendMessage(
      { customType: "gsd-workflow-template", content: prompt2, display: false },
      { triggerTurn: true }
    );
    return;
  }
  if (!trimmed) {
    const basePath2 = currentDirectoryRoot();
    const inProgress = findInProgressWorkflows(basePath2);
    if (inProgress.length > 0) {
      const wf = inProgress[0];
      const activePhase = wf.phases.find((p) => p.status === "active");
      const completedCount = wf.phases.filter((p) => p.status === "completed").length;
      ctx.ui.notify(
        `In-progress workflow found:
  ${wf.templateName}: "${wf.description}"
  Phase ${completedCount + 1}/${wf.phases.length}: ${activePhase?.name ?? "unknown"}

Run /gsd start resume to continue it.
`,
        "info"
      );
    }
  }
  const dryRun = trimmed.includes("--dry-run");
  const cleanedArgs = trimmed.replace(/--dry-run\s*/, "").trim();
  const parts = cleanedArgs.split(/\s+/);
  const firstWord = parts[0] ?? "";
  const issueMatch = cleanedArgs.match(/--issue\s+(\S+)/);
  const issueRef = issueMatch ? issueMatch[1] : null;
  let match = null;
  let description = "";
  if (firstWord) {
    match = resolveByName(firstWord);
    if (match) {
      description = parts.slice(1).join(" ").replace(/--issue\s+\S+/, "").trim();
    }
  }
  if (!match && cleanedArgs) {
    const detected = autoDetect(cleanedArgs);
    if (detected.length === 1 || detected.length > 0 && detected[0].confidence === "high") {
      match = detected[0];
      description = cleanedArgs;
      ctx.ui.notify(
        `Auto-detected template: ${match.template.name} (matched: "${match.matchedTrigger}")`,
        "info"
      );
    } else if (detected.length > 1) {
      const choices = detected.slice(0, 4).map(
        (m) => `  /gsd start ${m.id} ${cleanedArgs}`
      );
      ctx.ui.notify(
        `Multiple templates could match. Pick one:

${choices.join("\n")}

Or specify explicitly: /gsd start <template> <description>`,
        "info"
      );
      return;
    }
  }
  if (!match) {
    if (!trimmed) {
      ctx.ui.notify(
        "Usage: /gsd start <template> [description]\n\nTemplates:\n  bugfix          Triage \u2192 fix \u2192 verify \u2192 ship\n  small-feature   Scope \u2192 plan \u2192 implement \u2192 verify\n  spike           Scope \u2192 research \u2192 synthesize\n  hotfix          Fix \u2192 ship (minimal ceremony)\n  refactor        Inventory \u2192 plan \u2192 migrate \u2192 verify\n  security-audit  Scan \u2192 triage \u2192 remediate \u2192 re-scan\n  dep-upgrade     Assess \u2192 upgrade \u2192 fix \u2192 verify\n  full-project    Complete GSD with full ceremony\n\nExamples:\n  /gsd start bugfix fix login button not responding\n  /gsd start spike evaluate auth libraries\n  /gsd start hotfix critical: API returns 500\n\nRecommended task paths:\n" + formatRecommendedProcessPaths() + "\n\nFlags:\n  --dry-run       Preview what would happen without executing\n  --issue <ref>   Link to a GitHub issue\n\nRun /gsd templates for detailed template info.",
        "info"
      );
    } else {
      ctx.ui.notify(
        `No template matched "${firstWord}". Run /gsd start to see available templates.`,
        "warning"
      );
    }
    return;
  }
  const templateId = match.id;
  const template = match.template;
  const basePath = currentDirectoryRoot();
  const date = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
  let workflowContent = null;
  const pluginOverride = resolvePlugin(basePath, templateId);
  if (pluginOverride && pluginOverride.source !== "bundled" && pluginOverride.format === "md") {
    try {
      workflowContent = readFileSync(pluginOverride.path, "utf-8");
    } catch {
    }
  }
  if (workflowContent == null) {
    workflowContent = loadWorkflowTemplate(templateId);
  }
  if (!workflowContent) {
    ctx.ui.notify(
      `Template "${templateId}" is registered but its workflow file (${template.file}) hasn't been created yet.`,
      "warning"
    );
    return;
  }
  if (dryRun) {
    const slug2 = slugify(description || templateId);
    const lines = [
      `DRY RUN \u2014 ${template.name} (${templateId})
`,
      `Description: ${description || "(none)"}`,
      `Complexity:  ${template.estimated_complexity}`,
      `Phases:      ${template.phases.join(" \u2192 ")}`,
      ""
    ];
    if (template.artifact_dir) {
      const prefix = datePrefix();
      const num = getNextWorkflowNum(join(basePath, template.artifact_dir));
      lines.push(`Artifact dir: ${template.artifact_dir}${prefix}-${num}-${slug2}`);
    } else {
      lines.push("Artifact dir: (none \u2014 hotfix mode)");
    }
    lines.push(`Branch:       gsd/${templateId}/${slug2}`);
    if (issueRef) lines.push(`Issue:        ${issueRef}`);
    lines.push("", "No changes made. Remove --dry-run to execute.");
    ctx.ui.notify(lines.join("\n"), "info");
    return;
  }
  if (templateId === "full-project") {
    const root = gsdRoot(basePath);
    if (!existsSync(root)) {
      ctx.ui.notify(
        "Routing to /gsd init for full project setup...",
        "info"
      );
      pi.sendMessage(
        {
          customType: "gsd-workflow-template",
          content: "The user wants to start a full GSD project. Run `/gsd init` to bootstrap the project, then `/gsd auto` to begin execution.",
          display: false
        },
        { triggerTurn: true }
      );
    } else {
      ctx.ui.notify(
        "Project already initialized. Use `/gsd auto` to continue or `/gsd discuss` to start a new milestone.",
        "info"
      );
    }
    return;
  }
  let artifactDir = "";
  if (template.artifact_dir) {
    const slug2 = slugify(description || templateId);
    const prefix = datePrefix();
    const num = getNextWorkflowNum(join(basePath, template.artifact_dir));
    artifactDir = `${template.artifact_dir}${prefix}-${num}-${slug2}`;
    mkdirSync(join(basePath, artifactDir), { recursive: true });
  }
  const git = createGitService(basePath);
  const skipBranch = git.prefs.isolation === "none";
  const slug = slugify(description || templateId);
  const branchName = `gsd/${templateId}/${slug}`;
  let branchCreated = false;
  if (!skipBranch) {
    try {
      const current = git.getCurrentBranch();
      if (current !== branchName) {
        try {
          git.autoCommit("workflow-template", templateId, []);
        } catch {
        }
        runGit(basePath, ["checkout", "-b", branchName]);
        branchCreated = true;
      }
    } catch (err) {
      const message = getErrorMessage(err);
      ctx.ui.notify(
        `Could not create branch ${branchName}: ${message}. Working on current branch.`,
        "warning"
      );
    }
  }
  const actualBranch = branchCreated ? branchName : git.getCurrentBranch();
  if (artifactDir) {
    writeWorkflowState(
      join(basePath, artifactDir),
      templateId,
      template.name,
      template.phases,
      description,
      actualBranch
    );
  }
  const infoLines = [
    `Starting workflow: ${template.name}`,
    `Phases: ${template.phases.join(" \u2192 ")}`
  ];
  if (artifactDir) infoLines.push(`Artifacts: ${artifactDir}`);
  infoLines.push(`Branch: ${actualBranch}`);
  ctx.ui.notify(infoLines.join("\n"), "info");
  if (isLegacyWorkflowMode(template.mode)) {
    incrementLegacyTelemetry("legacy.workflowEngineUsed");
  }
  const prompt = loadPrompt("workflow-start", {
    templateId,
    templateName: template.name,
    templateDescription: template.description,
    phases: template.phases.join(" \u2192 "),
    complexity: template.estimated_complexity,
    artifactDir: artifactDir || "(none)",
    branch: actualBranch,
    description: description || "(none provided)",
    issueRef: issueRef || "(none)",
    date,
    workflowContent
  });
  pi.sendMessage(
    {
      customType: "gsd-workflow-template",
      content: prompt,
      display: false
    },
    { triggerTurn: true }
  );
}
async function handleTemplates(args, ctx) {
  const trimmed = args.trim();
  if (trimmed.startsWith("info ")) {
    const name = trimmed.replace(/^info\s+/, "").trim();
    const info = getTemplateInfo(name);
    if (info) {
      ctx.ui.notify(info, "info");
    } else {
      ctx.ui.notify(
        `Unknown template "${name}". Run /gsd templates to see available templates.`,
        "warning"
      );
    }
    return;
  }
  ctx.ui.notify(listTemplates(), "info");
}
function getTemplateCompletions(prefix) {
  try {
    const registry = loadRegistry();
    return Object.entries(registry.templates).filter(([id]) => id.startsWith(prefix)).map(([id, entry]) => ({
      value: `info ${id}`,
      label: id,
      description: entry.description
    }));
  } catch {
    return [];
  }
}
function dispatchMarkdownPhasePlugin(plugin, description, ctx, pi) {
  if (plugin.meta.mode !== "markdown-phase") return;
  if (isAutoActive()) {
    ctx.ui.notify(
      "Cannot start a markdown-phase workflow while auto-mode is running.\nRun /gsd pause first.",
      "warning"
    );
    return;
  }
  const templateId = plugin.name;
  const basePath = currentDirectoryRoot();
  const date = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
  let workflowContent;
  try {
    workflowContent = readFileSync(plugin.path, "utf-8");
  } catch (err) {
    ctx.ui.notify(
      `Failed to read template: ${err instanceof Error ? err.message : String(err)}`,
      "error"
    );
    return;
  }
  let artifactDir = "";
  if (plugin.meta.artifactDir) {
    const slug2 = slugify(description || templateId);
    const prefix = datePrefix();
    const num = getNextWorkflowNum(join(basePath, plugin.meta.artifactDir));
    artifactDir = `${plugin.meta.artifactDir}${prefix}-${num}-${slug2}`;
    mkdirSync(join(basePath, artifactDir), { recursive: true });
  }
  const git = createGitService(basePath);
  const skipBranch = git.prefs.isolation === "none";
  const slug = slugify(description || templateId);
  const branchName = `gsd/${templateId}/${slug}`;
  let branchCreated = false;
  if (!skipBranch) {
    try {
      const current = git.getCurrentBranch();
      if (current !== branchName) {
        try {
          git.autoCommit("workflow-template", templateId, []);
        } catch {
        }
        runGit(basePath, ["checkout", "-b", branchName]);
        branchCreated = true;
      }
    } catch (err) {
      ctx.ui.notify(
        `Could not create branch ${branchName}: ${getErrorMessage(err)}. Working on current branch.`,
        "warning"
      );
    }
  }
  const actualBranch = branchCreated ? branchName : git.getCurrentBranch();
  if (artifactDir && plugin.meta.phases && plugin.meta.phases.length > 0) {
    writeWorkflowState(
      join(basePath, artifactDir),
      templateId,
      plugin.meta.displayName,
      plugin.meta.phases,
      description,
      actualBranch
    );
  }
  const infoLines = [
    `Starting workflow: ${plugin.meta.displayName}`,
    `Phases: ${(plugin.meta.phases ?? []).join(" \u2192 ")}`
  ];
  if (artifactDir) infoLines.push(`Artifacts: ${artifactDir}`);
  infoLines.push(`Branch: ${actualBranch}`);
  ctx.ui.notify(infoLines.join("\n"), "info");
  incrementLegacyTelemetry("legacy.workflowEngineUsed");
  const prompt = loadPrompt("workflow-start", {
    templateId,
    templateName: plugin.meta.displayName,
    templateDescription: plugin.meta.description ?? "",
    phases: (plugin.meta.phases ?? []).join(" \u2192 "),
    complexity: plugin.meta.complexity ?? "medium",
    artifactDir: artifactDir || "(none)",
    branch: actualBranch,
    description: description || "(none provided)",
    issueRef: "(none)",
    date,
    workflowContent
  });
  pi.sendMessage(
    { customType: "gsd-workflow-template", content: prompt, display: false },
    { triggerTurn: true }
  );
}
export {
  dispatchMarkdownPhasePlugin,
  getTemplateCompletions,
  handleStart,
  handleTemplates
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9jb21tYW5kcy13b3JrZmxvdy10ZW1wbGF0ZXMudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFByb2plY3QvQXBwOiBHU0QtMlxuLy8gRmlsZSBQdXJwb3NlOiBXb3JrZmxvdyB0ZW1wbGF0ZSBjb21tYW5kcyBmb3Igc3RhcnRpbmcsIGxpc3RpbmcsIGFuZCBkaXNwYXRjaGluZyB3b3JrZmxvd3MuXG5cbi8qKlxuICogR1NEIFdvcmtmbG93IFRlbXBsYXRlIENvbW1hbmRzIFx1MjAxNCAvZ3NkIHN0YXJ0LCAvZ3NkIHRlbXBsYXRlc1xuICpcbiAqIEhhbmRsZXMgdGhlIGAvZ3NkIHN0YXJ0IFt0ZW1wbGF0ZV0gW2Rlc2NyaXB0aW9uXWAgYW5kIGAvZ3NkIHRlbXBsYXRlc2AgY29tbWFuZHMuXG4gKiBSZXNvbHZlcyB0ZW1wbGF0ZXMgYnkgbmFtZSBvciBhdXRvLWRldGVjdGlvbiwgdGhlbiBkaXNwYXRjaGVzIHRoZSB3b3JrZmxvdyBwcm9tcHQuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBFeHRlbnNpb25BUEksIEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0IH0gZnJvbSBcIkBnc2QvcGktY29kaW5nLWFnZW50XCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCBta2RpclN5bmMsIHJlYWRkaXJTeW5jLCByZWFkRmlsZVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7XG4gIHJlc29sdmVCeU5hbWUsXG4gIGF1dG9EZXRlY3QsXG4gIGxpc3RUZW1wbGF0ZXMsXG4gIGdldFRlbXBsYXRlSW5mbyxcbiAgbG9hZFdvcmtmbG93VGVtcGxhdGUsXG4gIGxvYWRSZWdpc3RyeSxcbiAgaXNMZWdhY3lXb3JrZmxvd01vZGUsXG4gIHR5cGUgVGVtcGxhdGVNYXRjaCxcbn0gZnJvbSBcIi4vd29ya2Zsb3ctdGVtcGxhdGVzLmpzXCI7XG5pbXBvcnQgeyBsb2FkUHJvbXB0IH0gZnJvbSBcIi4vcHJvbXB0LWxvYWRlci5qc1wiO1xuaW1wb3J0IHsgZ3NkUm9vdCB9IGZyb20gXCIuL3BhdGhzLmpzXCI7XG5pbXBvcnQgeyBjcmVhdGVHaXRTZXJ2aWNlLCBydW5HaXQgfSBmcm9tIFwiLi9naXQtc2VydmljZS5qc1wiO1xuaW1wb3J0IHsgaXNBdXRvQWN0aXZlLCBpc0F1dG9QYXVzZWQgfSBmcm9tIFwiLi9hdXRvLmpzXCI7XG5pbXBvcnQgeyBnZXRFcnJvck1lc3NhZ2UgfSBmcm9tIFwiLi9lcnJvci11dGlscy5qc1wiO1xuaW1wb3J0IHsgcmVzb2x2ZVBsdWdpbiwgdHlwZSBXb3JrZmxvd1BsdWdpbiB9IGZyb20gXCIuL3dvcmtmbG93LXBsdWdpbnMuanNcIjtcbmltcG9ydCB7IGN1cnJlbnREaXJlY3RvcnlSb290IH0gZnJvbSBcIi4vY29tbWFuZHMvY29udGV4dC5qc1wiO1xuaW1wb3J0IHsgZm9ybWF0UmVjb21tZW5kZWRQcm9jZXNzUGF0aHMgfSBmcm9tIFwiLi9wcm9jZXNzLXRhc2stcGF0aC5qc1wiO1xuaW1wb3J0IHsgaW5jcmVtZW50TGVnYWN5VGVsZW1ldHJ5IH0gZnJvbSBcIi4vbGVnYWN5LXRlbGVtZXRyeS5qc1wiO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgSGVscGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBHZW5lcmF0ZSBhIFVSTC1mcmllbmRseSBzbHVnIGZyb20gdGV4dC5cbiAqL1xuZnVuY3Rpb24gc2x1Z2lmeSh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdGV4dFxuICAgIC50b0xvd2VyQ2FzZSgpXG4gICAgLnJlcGxhY2UoL1teYS16MC05XSsvZywgXCItXCIpXG4gICAgLnJlcGxhY2UoL14tfC0kL2csIFwiXCIpXG4gICAgLnNsaWNlKDAsIDQwKVxuICAgIC5yZXBsYWNlKC8tJC8sIFwiXCIpO1xufVxuXG4vKipcbiAqIEdldCB0aGUgbmV4dCB3b3JrZmxvdyB0YXNrIG51bWJlciBieSBzY2FubmluZyBleGlzdGluZyBkaXJlY3Rvcmllcy5cbiAqL1xuZnVuY3Rpb24gZ2V0TmV4dFdvcmtmbG93TnVtKHdvcmtmbG93RGlyOiBzdHJpbmcpOiBudW1iZXIge1xuICBpZiAoIWV4aXN0c1N5bmMod29ya2Zsb3dEaXIpKSByZXR1cm4gMTtcbiAgdHJ5IHtcbiAgICBjb25zdCBlbnRyaWVzID0gcmVhZGRpclN5bmMod29ya2Zsb3dEaXIsIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KTtcbiAgICBsZXQgbWF4ID0gMDtcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGVudHJpZXMpIHtcbiAgICAgIGlmICghZW50cnkuaXNEaXJlY3RvcnkoKSkgY29udGludWU7XG4gICAgICBjb25zdCBtYXRjaCA9IGVudHJ5Lm5hbWUubWF0Y2goL14oXFxkezZ9KS0oXFxkKyktLyk7XG4gICAgICBpZiAobWF0Y2gpIHtcbiAgICAgICAgY29uc3QgbnVtID0gcGFyc2VJbnQobWF0Y2hbMl0sIDEwKTtcbiAgICAgICAgaWYgKG51bSA+IG1heCkgbWF4ID0gbnVtO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gbWF4ICsgMTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIDE7XG4gIH1cbn1cblxuLyoqXG4gKiBGb3JtYXQgdGhlIGRhdGUgYXMgWVlNTUREIGZvciBkaXJlY3RvcnkgbmFtaW5nLlxuICovXG5mdW5jdGlvbiBkYXRlUHJlZml4KCk6IHN0cmluZyB7XG4gIGNvbnN0IGQgPSBuZXcgRGF0ZSgpO1xuICBjb25zdCB5eSA9IFN0cmluZyhkLmdldEZ1bGxZZWFyKCkpLnNsaWNlKDIpO1xuICBjb25zdCBtbSA9IFN0cmluZyhkLmdldE1vbnRoKCkgKyAxKS5wYWRTdGFydCgyLCBcIjBcIik7XG4gIGNvbnN0IGRkID0gU3RyaW5nKGQuZ2V0RGF0ZSgpKS5wYWRTdGFydCgyLCBcIjBcIik7XG4gIHJldHVybiBgJHt5eX0ke21tfSR7ZGR9YDtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFN0YXRlIFR5cGVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5pbnRlcmZhY2UgV29ya2Zsb3dQaGFzZVN0YXRlIHtcbiAgbmFtZTogc3RyaW5nO1xuICBpbmRleDogbnVtYmVyO1xuICBzdGF0dXM6IFwicGVuZGluZ1wiIHwgXCJhY3RpdmVcIiB8IFwiY29tcGxldGVkXCI7XG59XG5cbmludGVyZmFjZSBXb3JrZmxvd1N0YXRlIHtcbiAgdGVtcGxhdGU6IHN0cmluZztcbiAgdGVtcGxhdGVOYW1lOiBzdHJpbmc7XG4gIGRlc2NyaXB0aW9uOiBzdHJpbmc7XG4gIGJyYW5jaDogc3RyaW5nO1xuICBwaGFzZXM6IFdvcmtmbG93UGhhc2VTdGF0ZVtdO1xuICBjdXJyZW50UGhhc2U6IG51bWJlcjtcbiAgc3RhcnRlZEF0OiBzdHJpbmc7XG4gIHVwZGF0ZWRBdDogc3RyaW5nO1xuICBjb21wbGV0ZWRBdD86IHN0cmluZztcbiAgYXJ0aWZhY3REaXI6IHN0cmluZztcbn1cblxuLyoqXG4gKiBXcml0ZSBhIFNUQVRFLmpzb24gZmlsZSB0byB0cmFjayB3b3JrZmxvdyBleGVjdXRpb24gc3RhdGUuXG4gKi9cbmZ1bmN0aW9uIHdyaXRlV29ya2Zsb3dTdGF0ZShcbiAgYXJ0aWZhY3REaXI6IHN0cmluZyxcbiAgdGVtcGxhdGVJZDogc3RyaW5nLFxuICB0ZW1wbGF0ZU5hbWU6IHN0cmluZyxcbiAgcGhhc2VzOiBzdHJpbmdbXSxcbiAgZGVzY3JpcHRpb246IHN0cmluZyxcbiAgYnJhbmNoOiBzdHJpbmcsXG4pOiB2b2lkIHtcbiAgY29uc3Qgc3RhdGVQYXRoID0gam9pbihhcnRpZmFjdERpciwgXCJTVEFURS5qc29uXCIpO1xuICBjb25zdCBzdGF0ZTogV29ya2Zsb3dTdGF0ZSA9IHtcbiAgICB0ZW1wbGF0ZTogdGVtcGxhdGVJZCxcbiAgICB0ZW1wbGF0ZU5hbWUsXG4gICAgZGVzY3JpcHRpb24sXG4gICAgYnJhbmNoLFxuICAgIHBoYXNlczogcGhhc2VzLm1hcCgocCwgaSkgPT4gKHtcbiAgICAgIG5hbWU6IHAsXG4gICAgICBpbmRleDogaSxcbiAgICAgIHN0YXR1czogaSA9PT0gMCA/IFwiYWN0aXZlXCIgYXMgY29uc3QgOiBcInBlbmRpbmdcIiBhcyBjb25zdCxcbiAgICB9KSksXG4gICAgY3VycmVudFBoYXNlOiAwLFxuICAgIHN0YXJ0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgIHVwZGF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgIGFydGlmYWN0RGlyLFxuICB9O1xuICB3cml0ZUZpbGVTeW5jKHN0YXRlUGF0aCwgSlNPTi5zdHJpbmdpZnkoc3RhdGUsIG51bGwsIDIpICsgXCJcXG5cIik7XG59XG5cbi8qKlxuICogU2NhbiBhbGwgd29ya2Zsb3cgYXJ0aWZhY3QgZGlyZWN0b3JpZXMgZm9yIGluLXByb2dyZXNzIFNUQVRFLmpzb24gZmlsZXMuXG4gKiBSZXR1cm5zIHdvcmtmbG93cyB0aGF0IHdlcmUgc3RhcnRlZCBidXQgbm90IGNvbXBsZXRlZC5cbiAqL1xuZnVuY3Rpb24gZmluZEluUHJvZ3Jlc3NXb3JrZmxvd3MoYmFzZVBhdGg6IHN0cmluZyk6IFdvcmtmbG93U3RhdGVbXSB7XG4gIGNvbnN0IHdvcmtmbG93c1Jvb3QgPSBqb2luKGdzZFJvb3QoYmFzZVBhdGgpLCBcIndvcmtmbG93c1wiKTtcbiAgaWYgKCFleGlzdHNTeW5jKHdvcmtmbG93c1Jvb3QpKSByZXR1cm4gW107XG5cbiAgY29uc3QgcmVzdWx0czogV29ya2Zsb3dTdGF0ZVtdID0gW107XG4gIHRyeSB7XG4gICAgLy8gU2NhbiBlYWNoIGNhdGVnb3J5IGRpciAoYnVnZml4ZXMvLCBmZWF0dXJlcy8sIHNwaWtlcy8sIGV0Yy4pXG4gICAgZm9yIChjb25zdCBjYXRlZ29yeSBvZiByZWFkZGlyU3luYyh3b3JrZmxvd3NSb290LCB7IHdpdGhGaWxlVHlwZXM6IHRydWUgfSkpIHtcbiAgICAgIGlmICghY2F0ZWdvcnkuaXNEaXJlY3RvcnkoKSkgY29udGludWU7XG4gICAgICBjb25zdCBjYXRlZ29yeURpciA9IGpvaW4od29ya2Zsb3dzUm9vdCwgY2F0ZWdvcnkubmFtZSk7XG5cbiAgICAgIGZvciAoY29uc3Qgd29ya2Zsb3cgb2YgcmVhZGRpclN5bmMoY2F0ZWdvcnlEaXIsIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KSkge1xuICAgICAgICBpZiAoIXdvcmtmbG93LmlzRGlyZWN0b3J5KCkpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCBzdGF0ZVBhdGggPSBqb2luKGNhdGVnb3J5RGlyLCB3b3JrZmxvdy5uYW1lLCBcIlNUQVRFLmpzb25cIik7XG4gICAgICAgIGlmICghZXhpc3RzU3luYyhzdGF0ZVBhdGgpKSBjb250aW51ZTtcblxuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IHJhdyA9IHJlYWRGaWxlU3luYyhzdGF0ZVBhdGgsIFwidXRmLThcIik7XG4gICAgICAgICAgY29uc3Qgc3RhdGUgPSBKU09OLnBhcnNlKHJhdykgYXMgV29ya2Zsb3dTdGF0ZTtcbiAgICAgICAgICBpZiAoIXN0YXRlLmNvbXBsZXRlZEF0KSB7XG4gICAgICAgICAgICByZXN1bHRzLnB1c2goc3RhdGUpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBjYXRjaCB7IC8qIGNvcnJ1cHRlZCBzdGF0ZSBmaWxlIFx1MjAxNCBza2lwICovIH1cbiAgICAgIH1cbiAgICB9XG4gIH0gY2F0Y2ggeyAvKiB3b3JrZmxvd3MgZGlyIHVucmVhZGFibGUgXHUyMDE0IHNraXAgKi8gfVxuXG4gIC8vIFNvcnQgYnkgbW9zdCByZWNlbnRseSB1cGRhdGVkXG4gIHJlc3VsdHMuc29ydCgoYSwgYikgPT4gYi51cGRhdGVkQXQubG9jYWxlQ29tcGFyZShhLnVwZGF0ZWRBdCkpO1xuICByZXR1cm4gcmVzdWx0cztcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIC9nc2Qgc3RhcnQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBoYW5kbGVTdGFydChcbiAgYXJnczogc3RyaW5nLFxuICBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LFxuICBwaTogRXh0ZW5zaW9uQVBJLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHRyaW1tZWQgPSBhcmdzLnRyaW0oKTtcblxuICAvLyAvZ3NkIHN0YXJ0IC0tbGlzdCBcdTIxOTIgc2FtZSBhcyAvZ3NkIHRlbXBsYXRlc1xuICBpZiAodHJpbW1lZCA9PT0gXCItLWxpc3RcIiB8fCB0cmltbWVkID09PSBcImxpc3RcIikge1xuICAgIGN0eC51aS5ub3RpZnkobGlzdFRlbXBsYXRlcygpLCBcImluZm9cIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEF1dG8tbW9kZSBjb25mbGljdCBndWFyZCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgLy8gV29ya2Zsb3cgdGVtcGxhdGVzIGRpc3BhdGNoIHRoZWlyIG93biBtZXNzYWdlcyBhbmQgc3dpdGNoIGdpdCBicmFuY2hlcyxcbiAgLy8gd2hpY2ggd291bGQgY29uZmxpY3Qgd2l0aCBhbiBhY3RpdmUgYXV0by1tb2RlIGRpc3BhdGNoIGxvb3AuXG4gIGlmIChpc0F1dG9BY3RpdmUoKSkge1xuICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICBcIkNhbm5vdCBzdGFydCBhIHdvcmtmbG93IHRlbXBsYXRlIHdoaWxlIGF1dG8tbW9kZSBpcyBydW5uaW5nLlxcblwiICtcbiAgICAgIFwiUnVuIC9nc2QgcGF1c2UgZmlyc3QsIHRoZW4gL2dzZCBzdGFydC5cIixcbiAgICAgIFwid2FybmluZ1wiLFxuICAgICk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKGlzQXV0b1BhdXNlZCgpKSB7XG4gICAgY3R4LnVpLm5vdGlmeShcbiAgICAgIFwiQXV0by1tb2RlIGlzIHBhdXNlZC4gU3RhcnRpbmcgYSB3b3JrZmxvdyB0ZW1wbGF0ZSB3aWxsIHJ1biBpbmRlcGVuZGVudGx5LlxcblwiICtcbiAgICAgIFwiVGhlIHBhdXNlZCBhdXRvLW1vZGUgc2Vzc2lvbiBjYW4gYmUgcmVzdW1lZCBsYXRlciB3aXRoIC9nc2QgYXV0by5cIixcbiAgICAgIFwiaW5mb1wiLFxuICAgICk7XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgUmVzdW1lIGRldGVjdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgLy8gL2dzZCBzdGFydCAtLXJlc3VtZSBvciAvZ3NkIHN0YXJ0IHJlc3VtZSBcdTIxOTIgcmVzdW1lIGluLXByb2dyZXNzIHdvcmtmbG93XG4gIGlmICh0cmltbWVkID09PSBcIi0tcmVzdW1lXCIgfHwgdHJpbW1lZCA9PT0gXCJyZXN1bWVcIikge1xuICAgIGNvbnN0IGJhc2VQYXRoID0gY3VycmVudERpcmVjdG9yeVJvb3QoKTtcbiAgICBjb25zdCBpblByb2dyZXNzID0gZmluZEluUHJvZ3Jlc3NXb3JrZmxvd3MoYmFzZVBhdGgpO1xuICAgIGlmIChpblByb2dyZXNzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgY3R4LnVpLm5vdGlmeShcIk5vIGluLXByb2dyZXNzIHdvcmtmbG93cyBmb3VuZC5cIiwgXCJpbmZvXCIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIFJlc3VtZSB0aGUgbW9zdCByZWNlbnQgb25lXG4gICAgY29uc3Qgd2YgPSBpblByb2dyZXNzWzBdO1xuICAgIGNvbnN0IGFjdGl2ZVBoYXNlID0gd2YucGhhc2VzLmZpbmQocCA9PiBwLnN0YXR1cyA9PT0gXCJhY3RpdmVcIik7XG4gICAgY29uc3QgY29tcGxldGVkQ291bnQgPSB3Zi5waGFzZXMuZmlsdGVyKHAgPT4gcC5zdGF0dXMgPT09IFwiY29tcGxldGVkXCIpLmxlbmd0aDtcblxuICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICBgUmVzdW1pbmc6ICR7d2YudGVtcGxhdGVOYW1lfVxcbmAgK1xuICAgICAgYERlc2NyaXB0aW9uOiAke3dmLmRlc2NyaXB0aW9ufVxcbmAgK1xuICAgICAgYFByb2dyZXNzOiAke2NvbXBsZXRlZENvdW50fS8ke3dmLnBoYXNlcy5sZW5ndGh9IHBoYXNlcyBjb21wbGV0ZWRcXG5gICtcbiAgICAgIGBDdXJyZW50IHBoYXNlOiAke2FjdGl2ZVBoYXNlPy5uYW1lID8/IFwidW5rbm93blwifVxcbmAgK1xuICAgICAgYEJyYW5jaDogJHt3Zi5icmFuY2h9XFxuYCArXG4gICAgICBgQXJ0aWZhY3RzOiAke3dmLmFydGlmYWN0RGlyfWAsXG4gICAgICBcImluZm9cIixcbiAgICApO1xuXG4gICAgY29uc3Qgd29ya2Zsb3dDb250ZW50ID0gbG9hZFdvcmtmbG93VGVtcGxhdGUod2YudGVtcGxhdGUpO1xuICAgIGlmICghd29ya2Zsb3dDb250ZW50KSB7XG4gICAgICBjdHgudWkubm90aWZ5KGBUZW1wbGF0ZSBcIiR7d2YudGVtcGxhdGV9XCIgd29ya2Zsb3cgZmlsZSBub3QgZm91bmQuYCwgXCJ3YXJuaW5nXCIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IHByb21wdCA9IGxvYWRQcm9tcHQoXCJ3b3JrZmxvdy1zdGFydFwiLCB7XG4gICAgICB0ZW1wbGF0ZUlkOiB3Zi50ZW1wbGF0ZSxcbiAgICAgIHRlbXBsYXRlTmFtZTogd2YudGVtcGxhdGVOYW1lLFxuICAgICAgdGVtcGxhdGVEZXNjcmlwdGlvbjogYFJFU1VNSU5HIFx1MjAxNCBwaWNrIHVwIGZyb20gcGhhc2UgXCIke2FjdGl2ZVBoYXNlPy5uYW1lID8/IFwidW5rbm93blwifVwiICgke2NvbXBsZXRlZENvdW50fS8ke3dmLnBoYXNlcy5sZW5ndGh9IHBoYXNlcyBkb25lKWAsXG4gICAgICBwaGFzZXM6IHdmLnBoYXNlcy5tYXAocCA9PiBgJHtwLm5hbWV9JHtwLnN0YXR1cyA9PT0gXCJjb21wbGV0ZWRcIiA/IFwiIFx1MjcxM1wiIDogcC5zdGF0dXMgPT09IFwiYWN0aXZlXCIgPyBcIiBcdTIxOTBcIiA6IFwiXCJ9YCkuam9pbihcIiBcdTIxOTIgXCIpLFxuICAgICAgY29tcGxleGl0eTogXCJyZXN1bWVcIixcbiAgICAgIGFydGlmYWN0RGlyOiB3Zi5hcnRpZmFjdERpcixcbiAgICAgIGJyYW5jaDogd2YuYnJhbmNoLFxuICAgICAgZGVzY3JpcHRpb246IHdmLmRlc2NyaXB0aW9uLFxuICAgICAgaXNzdWVSZWY6IFwiKG5vbmUpXCIsXG4gICAgICBkYXRlOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkuc3BsaXQoXCJUXCIpWzBdLFxuICAgICAgd29ya2Zsb3dDb250ZW50LFxuICAgIH0pO1xuXG4gICAgcGkuc2VuZE1lc3NhZ2UoXG4gICAgICB7IGN1c3RvbVR5cGU6IFwiZ3NkLXdvcmtmbG93LXRlbXBsYXRlXCIsIGNvbnRlbnQ6IHByb21wdCwgZGlzcGxheTogZmFsc2UgfSxcbiAgICAgIHsgdHJpZ2dlclR1cm46IHRydWUgfSxcbiAgICApO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFNob3cgaW4tcHJvZ3Jlc3Mgd29ya2Zsb3dzIHdoZW4gL2dzZCBzdGFydCBpcyBjYWxsZWQgd2l0aCBubyBhcmdzXG4gIGlmICghdHJpbW1lZCkge1xuICAgIGNvbnN0IGJhc2VQYXRoID0gY3VycmVudERpcmVjdG9yeVJvb3QoKTtcbiAgICBjb25zdCBpblByb2dyZXNzID0gZmluZEluUHJvZ3Jlc3NXb3JrZmxvd3MoYmFzZVBhdGgpO1xuICAgIGlmIChpblByb2dyZXNzLmxlbmd0aCA+IDApIHtcbiAgICAgIGNvbnN0IHdmID0gaW5Qcm9ncmVzc1swXTtcbiAgICAgIGNvbnN0IGFjdGl2ZVBoYXNlID0gd2YucGhhc2VzLmZpbmQocCA9PiBwLnN0YXR1cyA9PT0gXCJhY3RpdmVcIik7XG4gICAgICBjb25zdCBjb21wbGV0ZWRDb3VudCA9IHdmLnBoYXNlcy5maWx0ZXIocCA9PiBwLnN0YXR1cyA9PT0gXCJjb21wbGV0ZWRcIikubGVuZ3RoO1xuICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgYEluLXByb2dyZXNzIHdvcmtmbG93IGZvdW5kOlxcbmAgK1xuICAgICAgICBgICAke3dmLnRlbXBsYXRlTmFtZX06IFwiJHt3Zi5kZXNjcmlwdGlvbn1cIlxcbmAgK1xuICAgICAgICBgICBQaGFzZSAke2NvbXBsZXRlZENvdW50ICsgMX0vJHt3Zi5waGFzZXMubGVuZ3RofTogJHthY3RpdmVQaGFzZT8ubmFtZSA/PyBcInVua25vd25cIn1cXG5cXG5gICtcbiAgICAgICAgYFJ1biAvZ3NkIHN0YXJ0IHJlc3VtZSB0byBjb250aW51ZSBpdC5cXG5gLFxuICAgICAgICBcImluZm9cIixcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgLy8gL2dzZCBzdGFydCAtLWRyeS1ydW4gPHRlbXBsYXRlPiBcdTIxOTIgcHJldmlldyB3aXRob3V0IGV4ZWN1dGluZ1xuICBjb25zdCBkcnlSdW4gPSB0cmltbWVkLmluY2x1ZGVzKFwiLS1kcnktcnVuXCIpO1xuICBjb25zdCBjbGVhbmVkQXJncyA9IHRyaW1tZWQucmVwbGFjZSgvLS1kcnktcnVuXFxzKi8sIFwiXCIpLnRyaW0oKTtcblxuICAvLyBQYXJzZTogZmlyc3Qgd29yZCBtaWdodCBiZSBhIHRlbXBsYXRlIG5hbWUsIHJlc3QgaXMgZGVzY3JpcHRpb25cbiAgY29uc3QgcGFydHMgPSBjbGVhbmVkQXJncy5zcGxpdCgvXFxzKy8pO1xuICBjb25zdCBmaXJzdFdvcmQgPSBwYXJ0c1swXSA/PyBcIlwiO1xuXG4gIC8vIENoZWNrIGZvciAtLWlzc3VlIGZsYWcgKGJ1Z2ZpeCBzaG9ydGN1dClcbiAgY29uc3QgaXNzdWVNYXRjaCA9IGNsZWFuZWRBcmdzLm1hdGNoKC8tLWlzc3VlXFxzKyhcXFMrKS8pO1xuICBjb25zdCBpc3N1ZVJlZiA9IGlzc3VlTWF0Y2ggPyBpc3N1ZU1hdGNoWzFdIDogbnVsbDtcblxuICAvLyBUcnkgcmVzb2x2aW5nIGZpcnN0IHdvcmQgYXMgYSB0ZW1wbGF0ZSBuYW1lXG4gIGxldCBtYXRjaDogVGVtcGxhdGVNYXRjaCB8IG51bGwgPSBudWxsO1xuICBsZXQgZGVzY3JpcHRpb24gPSBcIlwiO1xuXG4gIGlmIChmaXJzdFdvcmQpIHtcbiAgICBtYXRjaCA9IHJlc29sdmVCeU5hbWUoZmlyc3RXb3JkKTtcbiAgICBpZiAobWF0Y2gpIHtcbiAgICAgIC8vIEZpcnN0IHdvcmQgd2FzIGEgdGVtcGxhdGUgbmFtZTsgcmVzdCBpcyBkZXNjcmlwdGlvblxuICAgICAgZGVzY3JpcHRpb24gPSBwYXJ0cy5zbGljZSgxKS5qb2luKFwiIFwiKS5yZXBsYWNlKC8tLWlzc3VlXFxzK1xcUysvLCBcIlwiKS50cmltKCk7XG4gICAgfVxuICB9XG5cbiAgLy8gSWYgbm8gZXhwbGljaXQgdGVtcGxhdGUsIHRyeSBhdXRvLWRldGVjdGlvbiBmcm9tIHRoZSBmdWxsIGlucHV0XG4gIGlmICghbWF0Y2ggJiYgY2xlYW5lZEFyZ3MpIHtcbiAgICBjb25zdCBkZXRlY3RlZCA9IGF1dG9EZXRlY3QoY2xlYW5lZEFyZ3MpO1xuICAgIGlmIChkZXRlY3RlZC5sZW5ndGggPT09IDEgfHwgKGRldGVjdGVkLmxlbmd0aCA+IDAgJiYgZGV0ZWN0ZWRbMF0uY29uZmlkZW5jZSA9PT0gXCJoaWdoXCIpKSB7XG4gICAgICBtYXRjaCA9IGRldGVjdGVkWzBdO1xuICAgICAgZGVzY3JpcHRpb24gPSBjbGVhbmVkQXJncztcbiAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgIGBBdXRvLWRldGVjdGVkIHRlbXBsYXRlOiAke21hdGNoLnRlbXBsYXRlLm5hbWV9IChtYXRjaGVkOiBcIiR7bWF0Y2gubWF0Y2hlZFRyaWdnZXJ9XCIpYCxcbiAgICAgICAgXCJpbmZvXCIsXG4gICAgICApO1xuICAgIH0gZWxzZSBpZiAoZGV0ZWN0ZWQubGVuZ3RoID4gMSkge1xuICAgICAgY29uc3QgY2hvaWNlcyA9IGRldGVjdGVkLnNsaWNlKDAsIDQpLm1hcChcbiAgICAgICAgKG0pID0+IGAgIC9nc2Qgc3RhcnQgJHttLmlkfSAke2NsZWFuZWRBcmdzfWBcbiAgICAgICk7XG4gICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICBgTXVsdGlwbGUgdGVtcGxhdGVzIGNvdWxkIG1hdGNoLiBQaWNrIG9uZTpcXG5cXG4ke2Nob2ljZXMuam9pbihcIlxcblwiKX1cXG5cXG5PciBzcGVjaWZ5IGV4cGxpY2l0bHk6IC9nc2Qgc3RhcnQgPHRlbXBsYXRlPiA8ZGVzY3JpcHRpb24+YCxcbiAgICAgICAgXCJpbmZvXCIsXG4gICAgICApO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgfVxuXG4gIC8vIE5vIHRlbXBsYXRlIHJlc29sdmVkIGF0IGFsbFxuICBpZiAoIW1hdGNoKSB7XG4gICAgaWYgKCF0cmltbWVkKSB7XG4gICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICBcIlVzYWdlOiAvZ3NkIHN0YXJ0IDx0ZW1wbGF0ZT4gW2Rlc2NyaXB0aW9uXVxcblxcblwiICtcbiAgICAgICAgXCJUZW1wbGF0ZXM6XFxuXCIgK1xuICAgICAgICBcIiAgYnVnZml4ICAgICAgICAgIFRyaWFnZSBcdTIxOTIgZml4IFx1MjE5MiB2ZXJpZnkgXHUyMTkyIHNoaXBcXG5cIiArXG4gICAgICAgIFwiICBzbWFsbC1mZWF0dXJlICAgU2NvcGUgXHUyMTkyIHBsYW4gXHUyMTkyIGltcGxlbWVudCBcdTIxOTIgdmVyaWZ5XFxuXCIgK1xuICAgICAgICBcIiAgc3Bpa2UgICAgICAgICAgIFNjb3BlIFx1MjE5MiByZXNlYXJjaCBcdTIxOTIgc3ludGhlc2l6ZVxcblwiICtcbiAgICAgICAgXCIgIGhvdGZpeCAgICAgICAgICBGaXggXHUyMTkyIHNoaXAgKG1pbmltYWwgY2VyZW1vbnkpXFxuXCIgK1xuICAgICAgICBcIiAgcmVmYWN0b3IgICAgICAgIEludmVudG9yeSBcdTIxOTIgcGxhbiBcdTIxOTIgbWlncmF0ZSBcdTIxOTIgdmVyaWZ5XFxuXCIgK1xuICAgICAgICBcIiAgc2VjdXJpdHktYXVkaXQgIFNjYW4gXHUyMTkyIHRyaWFnZSBcdTIxOTIgcmVtZWRpYXRlIFx1MjE5MiByZS1zY2FuXFxuXCIgK1xuICAgICAgICBcIiAgZGVwLXVwZ3JhZGUgICAgIEFzc2VzcyBcdTIxOTIgdXBncmFkZSBcdTIxOTIgZml4IFx1MjE5MiB2ZXJpZnlcXG5cIiArXG4gICAgICAgIFwiICBmdWxsLXByb2plY3QgICAgQ29tcGxldGUgR1NEIHdpdGggZnVsbCBjZXJlbW9ueVxcblxcblwiICtcbiAgICAgICAgXCJFeGFtcGxlczpcXG5cIiArXG4gICAgICAgIFwiICAvZ3NkIHN0YXJ0IGJ1Z2ZpeCBmaXggbG9naW4gYnV0dG9uIG5vdCByZXNwb25kaW5nXFxuXCIgK1xuICAgICAgICBcIiAgL2dzZCBzdGFydCBzcGlrZSBldmFsdWF0ZSBhdXRoIGxpYnJhcmllc1xcblwiICtcbiAgICAgICAgXCIgIC9nc2Qgc3RhcnQgaG90Zml4IGNyaXRpY2FsOiBBUEkgcmV0dXJucyA1MDBcXG5cXG5cIiArXG4gICAgICAgIFwiUmVjb21tZW5kZWQgdGFzayBwYXRoczpcXG5cIiArXG4gICAgICAgIGZvcm1hdFJlY29tbWVuZGVkUHJvY2Vzc1BhdGhzKCkgK1xuICAgICAgICBcIlxcblxcblwiICtcbiAgICAgICAgXCJGbGFnczpcXG5cIiArXG4gICAgICAgIFwiICAtLWRyeS1ydW4gICAgICAgUHJldmlldyB3aGF0IHdvdWxkIGhhcHBlbiB3aXRob3V0IGV4ZWN1dGluZ1xcblwiICtcbiAgICAgICAgXCIgIC0taXNzdWUgPHJlZj4gICBMaW5rIHRvIGEgR2l0SHViIGlzc3VlXFxuXFxuXCIgK1xuICAgICAgICBcIlJ1biAvZ3NkIHRlbXBsYXRlcyBmb3IgZGV0YWlsZWQgdGVtcGxhdGUgaW5mby5cIixcbiAgICAgICAgXCJpbmZvXCIsXG4gICAgICApO1xuICAgIH0gZWxzZSB7XG4gICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICBgTm8gdGVtcGxhdGUgbWF0Y2hlZCBcIiR7Zmlyc3RXb3JkfVwiLiBSdW4gL2dzZCBzdGFydCB0byBzZWUgYXZhaWxhYmxlIHRlbXBsYXRlcy5gLFxuICAgICAgICBcIndhcm5pbmdcIixcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBSZXNvbHZlZCB0ZW1wbGF0ZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuICBjb25zdCB0ZW1wbGF0ZUlkID0gbWF0Y2guaWQ7XG4gIGNvbnN0IHRlbXBsYXRlID0gbWF0Y2gudGVtcGxhdGU7XG4gIGNvbnN0IGJhc2VQYXRoID0gY3VycmVudERpcmVjdG9yeVJvb3QoKTtcbiAgY29uc3QgZGF0ZSA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKS5zcGxpdChcIlRcIilbMF07XG5cbiAgLy8gTG9hZCB0aGUgd29ya2Zsb3cgdGVtcGxhdGUgY29udGVudCBcdTIwMTQgcHJlZmVyIGEgcHJvamVjdC9nbG9iYWwgcGx1Z2luXG4gIC8vIG92ZXJyaWRlIGlmIG9uZSBleGlzdHMgKHNhbWUgbmFtZSwgLm1kIGZvcm1hdCkuXG4gIGxldCB3b3JrZmxvd0NvbnRlbnQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBjb25zdCBwbHVnaW5PdmVycmlkZSA9IHJlc29sdmVQbHVnaW4oYmFzZVBhdGgsIHRlbXBsYXRlSWQpO1xuICBpZiAocGx1Z2luT3ZlcnJpZGUgJiYgcGx1Z2luT3ZlcnJpZGUuc291cmNlICE9PSBcImJ1bmRsZWRcIiAmJiBwbHVnaW5PdmVycmlkZS5mb3JtYXQgPT09IFwibWRcIikge1xuICAgIHRyeSB7XG4gICAgICB3b3JrZmxvd0NvbnRlbnQgPSByZWFkRmlsZVN5bmMocGx1Z2luT3ZlcnJpZGUucGF0aCwgXCJ1dGYtOFwiKTtcbiAgICB9IGNhdGNoIHsgLyogZmFsbCB0aHJvdWdoIHRvIGJ1bmRsZWQgKi8gfVxuICB9XG4gIGlmICh3b3JrZmxvd0NvbnRlbnQgPT0gbnVsbCkge1xuICAgIHdvcmtmbG93Q29udGVudCA9IGxvYWRXb3JrZmxvd1RlbXBsYXRlKHRlbXBsYXRlSWQpO1xuICB9XG4gIGlmICghd29ya2Zsb3dDb250ZW50KSB7XG4gICAgY3R4LnVpLm5vdGlmeShcbiAgICAgIGBUZW1wbGF0ZSBcIiR7dGVtcGxhdGVJZH1cIiBpcyByZWdpc3RlcmVkIGJ1dCBpdHMgd29ya2Zsb3cgZmlsZSAoJHt0ZW1wbGF0ZS5maWxlfSkgaGFzbid0IGJlZW4gY3JlYXRlZCB5ZXQuYCxcbiAgICAgIFwid2FybmluZ1wiLFxuICAgICk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIERyeS1ydW4gbW9kZTogcHJldmlldyB3aXRob3V0IGV4ZWN1dGluZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuICBpZiAoZHJ5UnVuKSB7XG4gICAgY29uc3Qgc2x1ZyA9IHNsdWdpZnkoZGVzY3JpcHRpb24gfHwgdGVtcGxhdGVJZCk7XG4gICAgY29uc3QgbGluZXMgPSBbXG4gICAgICBgRFJZIFJVTiBcdTIwMTQgJHt0ZW1wbGF0ZS5uYW1lfSAoJHt0ZW1wbGF0ZUlkfSlcXG5gLFxuICAgICAgYERlc2NyaXB0aW9uOiAke2Rlc2NyaXB0aW9uIHx8IFwiKG5vbmUpXCJ9YCxcbiAgICAgIGBDb21wbGV4aXR5OiAgJHt0ZW1wbGF0ZS5lc3RpbWF0ZWRfY29tcGxleGl0eX1gLFxuICAgICAgYFBoYXNlczogICAgICAke3RlbXBsYXRlLnBoYXNlcy5qb2luKFwiIFx1MjE5MiBcIil9YCxcbiAgICAgIFwiXCIsXG4gICAgXTtcbiAgICBpZiAodGVtcGxhdGUuYXJ0aWZhY3RfZGlyKSB7XG4gICAgICBjb25zdCBwcmVmaXggPSBkYXRlUHJlZml4KCk7XG4gICAgICBjb25zdCBudW0gPSBnZXROZXh0V29ya2Zsb3dOdW0oam9pbihiYXNlUGF0aCwgdGVtcGxhdGUuYXJ0aWZhY3RfZGlyKSk7XG4gICAgICBsaW5lcy5wdXNoKGBBcnRpZmFjdCBkaXI6ICR7dGVtcGxhdGUuYXJ0aWZhY3RfZGlyfSR7cHJlZml4fS0ke251bX0tJHtzbHVnfWApO1xuICAgIH0gZWxzZSB7XG4gICAgICBsaW5lcy5wdXNoKFwiQXJ0aWZhY3QgZGlyOiAobm9uZSBcdTIwMTQgaG90Zml4IG1vZGUpXCIpO1xuICAgIH1cbiAgICBsaW5lcy5wdXNoKGBCcmFuY2g6ICAgICAgIGdzZC8ke3RlbXBsYXRlSWR9LyR7c2x1Z31gKTtcbiAgICBpZiAoaXNzdWVSZWYpIGxpbmVzLnB1c2goYElzc3VlOiAgICAgICAgJHtpc3N1ZVJlZn1gKTtcbiAgICBsaW5lcy5wdXNoKFwiXCIsIFwiTm8gY2hhbmdlcyBtYWRlLiBSZW1vdmUgLS1kcnktcnVuIHRvIGV4ZWN1dGUuXCIpO1xuICAgIGN0eC51aS5ub3RpZnkobGluZXMuam9pbihcIlxcblwiKSwgXCJpbmZvXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBSb3V0ZSBmdWxsLXByb2plY3QgdG8gc3RhbmRhcmQgR1NEIHdvcmtmbG93IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4gIGlmICh0ZW1wbGF0ZUlkID09PSBcImZ1bGwtcHJvamVjdFwiKSB7XG4gICAgY29uc3Qgcm9vdCA9IGdzZFJvb3QoYmFzZVBhdGgpO1xuICAgIGlmICghZXhpc3RzU3luYyhyb290KSkge1xuICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgXCJSb3V0aW5nIHRvIC9nc2QgaW5pdCBmb3IgZnVsbCBwcm9qZWN0IHNldHVwLi4uXCIsXG4gICAgICAgIFwiaW5mb1wiLFxuICAgICAgKTtcbiAgICAgIC8vIFRyaWdnZXIgL2dzZCBpbml0IGJ5IGRpc3BhdGNoaW5nIHRvIHRoZSBoYW5kbGVyXG4gICAgICBwaS5zZW5kTWVzc2FnZShcbiAgICAgICAge1xuICAgICAgICAgIGN1c3RvbVR5cGU6IFwiZ3NkLXdvcmtmbG93LXRlbXBsYXRlXCIsXG4gICAgICAgICAgY29udGVudDogXCJUaGUgdXNlciB3YW50cyB0byBzdGFydCBhIGZ1bGwgR1NEIHByb2plY3QuIFJ1biBgL2dzZCBpbml0YCB0byBib290c3RyYXAgdGhlIHByb2plY3QsIHRoZW4gYC9nc2QgYXV0b2AgdG8gYmVnaW4gZXhlY3V0aW9uLlwiLFxuICAgICAgICAgIGRpc3BsYXk6IGZhbHNlLFxuICAgICAgICB9LFxuICAgICAgICB7IHRyaWdnZXJUdXJuOiB0cnVlIH0sXG4gICAgICApO1xuICAgIH0gZWxzZSB7XG4gICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICBcIlByb2plY3QgYWxyZWFkeSBpbml0aWFsaXplZC4gVXNlIGAvZ3NkIGF1dG9gIHRvIGNvbnRpbnVlIG9yIGAvZ3NkIGRpc2N1c3NgIHRvIHN0YXJ0IGEgbmV3IG1pbGVzdG9uZS5cIixcbiAgICAgICAgXCJpbmZvXCIsXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgQ3JlYXRlIGFydGlmYWN0IGRpcmVjdG9yeSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuICBsZXQgYXJ0aWZhY3REaXIgPSBcIlwiO1xuICBpZiAodGVtcGxhdGUuYXJ0aWZhY3RfZGlyKSB7XG4gICAgY29uc3Qgc2x1ZyA9IHNsdWdpZnkoZGVzY3JpcHRpb24gfHwgdGVtcGxhdGVJZCk7XG4gICAgY29uc3QgcHJlZml4ID0gZGF0ZVByZWZpeCgpO1xuICAgIGNvbnN0IG51bSA9IGdldE5leHRXb3JrZmxvd051bShqb2luKGJhc2VQYXRoLCB0ZW1wbGF0ZS5hcnRpZmFjdF9kaXIpKTtcbiAgICBhcnRpZmFjdERpciA9IGAke3RlbXBsYXRlLmFydGlmYWN0X2Rpcn0ke3ByZWZpeH0tJHtudW19LSR7c2x1Z31gO1xuICAgIG1rZGlyU3luYyhqb2luKGJhc2VQYXRoLCBhcnRpZmFjdERpciksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIENyZWF0ZSBnaXQgYnJhbmNoICh1bmxlc3MgaXNvbGF0aW9uOiBub25lKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuICBjb25zdCBnaXQgPSBjcmVhdGVHaXRTZXJ2aWNlKGJhc2VQYXRoKTtcbiAgY29uc3Qgc2tpcEJyYW5jaCA9IGdpdC5wcmVmcy5pc29sYXRpb24gPT09IFwibm9uZVwiO1xuICBjb25zdCBzbHVnID0gc2x1Z2lmeShkZXNjcmlwdGlvbiB8fCB0ZW1wbGF0ZUlkKTtcbiAgY29uc3QgYnJhbmNoTmFtZSA9IGBnc2QvJHt0ZW1wbGF0ZUlkfS8ke3NsdWd9YDtcbiAgbGV0IGJyYW5jaENyZWF0ZWQgPSBmYWxzZTtcblxuICBpZiAoIXNraXBCcmFuY2gpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgY3VycmVudCA9IGdpdC5nZXRDdXJyZW50QnJhbmNoKCk7XG4gICAgICBpZiAoY3VycmVudCAhPT0gYnJhbmNoTmFtZSkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGdpdC5hdXRvQ29tbWl0KFwid29ya2Zsb3ctdGVtcGxhdGVcIiwgdGVtcGxhdGVJZCwgW10pO1xuICAgICAgICB9IGNhdGNoIHsgLyogbm90aGluZyB0byBjb21taXQgKi8gfVxuICAgICAgICBydW5HaXQoYmFzZVBhdGgsIFtcImNoZWNrb3V0XCIsIFwiLWJcIiwgYnJhbmNoTmFtZV0pO1xuICAgICAgICBicmFuY2hDcmVhdGVkID0gdHJ1ZTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGNvbnN0IG1lc3NhZ2UgPSBnZXRFcnJvck1lc3NhZ2UoZXJyKTtcbiAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgIGBDb3VsZCBub3QgY3JlYXRlIGJyYW5jaCAke2JyYW5jaE5hbWV9OiAke21lc3NhZ2V9LiBXb3JraW5nIG9uIGN1cnJlbnQgYnJhbmNoLmAsXG4gICAgICAgIFwid2FybmluZ1wiLFxuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICBjb25zdCBhY3R1YWxCcmFuY2ggPSBicmFuY2hDcmVhdGVkID8gYnJhbmNoTmFtZSA6IGdpdC5nZXRDdXJyZW50QnJhbmNoKCk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFdyaXRlIHdvcmtmbG93IHN0YXRlIGZvciByZXN1bWUgc3VwcG9ydCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuICBpZiAoYXJ0aWZhY3REaXIpIHtcbiAgICB3cml0ZVdvcmtmbG93U3RhdGUoXG4gICAgICBqb2luKGJhc2VQYXRoLCBhcnRpZmFjdERpciksXG4gICAgICB0ZW1wbGF0ZUlkLFxuICAgICAgdGVtcGxhdGUubmFtZSxcbiAgICAgIHRlbXBsYXRlLnBoYXNlcyxcbiAgICAgIGRlc2NyaXB0aW9uLFxuICAgICAgYWN0dWFsQnJhbmNoLFxuICAgICk7XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgTm90aWZ5IGFuZCBkaXNwYXRjaCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuICBjb25zdCBpbmZvTGluZXMgPSBbXG4gICAgYFN0YXJ0aW5nIHdvcmtmbG93OiAke3RlbXBsYXRlLm5hbWV9YCxcbiAgICBgUGhhc2VzOiAke3RlbXBsYXRlLnBoYXNlcy5qb2luKFwiIFx1MjE5MiBcIil9YCxcbiAgXTtcbiAgaWYgKGFydGlmYWN0RGlyKSBpbmZvTGluZXMucHVzaChgQXJ0aWZhY3RzOiAke2FydGlmYWN0RGlyfWApO1xuICBpbmZvTGluZXMucHVzaChgQnJhbmNoOiAke2FjdHVhbEJyYW5jaH1gKTtcbiAgY3R4LnVpLm5vdGlmeShpbmZvTGluZXMuam9pbihcIlxcblwiKSwgXCJpbmZvXCIpO1xuICBpZiAoaXNMZWdhY3lXb3JrZmxvd01vZGUodGVtcGxhdGUubW9kZSkpIHtcbiAgICBpbmNyZW1lbnRMZWdhY3lUZWxlbWV0cnkoXCJsZWdhY3kud29ya2Zsb3dFbmdpbmVVc2VkXCIpO1xuICB9XG5cbiAgY29uc3QgcHJvbXB0ID0gbG9hZFByb21wdChcIndvcmtmbG93LXN0YXJ0XCIsIHtcbiAgICB0ZW1wbGF0ZUlkLFxuICAgIHRlbXBsYXRlTmFtZTogdGVtcGxhdGUubmFtZSxcbiAgICB0ZW1wbGF0ZURlc2NyaXB0aW9uOiB0ZW1wbGF0ZS5kZXNjcmlwdGlvbixcbiAgICBwaGFzZXM6IHRlbXBsYXRlLnBoYXNlcy5qb2luKFwiIFx1MjE5MiBcIiksXG4gICAgY29tcGxleGl0eTogdGVtcGxhdGUuZXN0aW1hdGVkX2NvbXBsZXhpdHksXG4gICAgYXJ0aWZhY3REaXI6IGFydGlmYWN0RGlyIHx8IFwiKG5vbmUpXCIsXG4gICAgYnJhbmNoOiBhY3R1YWxCcmFuY2gsXG4gICAgZGVzY3JpcHRpb246IGRlc2NyaXB0aW9uIHx8IFwiKG5vbmUgcHJvdmlkZWQpXCIsXG4gICAgaXNzdWVSZWY6IGlzc3VlUmVmIHx8IFwiKG5vbmUpXCIsXG4gICAgZGF0ZSxcbiAgICB3b3JrZmxvd0NvbnRlbnQsXG4gIH0pO1xuXG4gIHBpLnNlbmRNZXNzYWdlKFxuICAgIHtcbiAgICAgIGN1c3RvbVR5cGU6IFwiZ3NkLXdvcmtmbG93LXRlbXBsYXRlXCIsXG4gICAgICBjb250ZW50OiBwcm9tcHQsXG4gICAgICBkaXNwbGF5OiBmYWxzZSxcbiAgICB9LFxuICAgIHsgdHJpZ2dlclR1cm46IHRydWUgfSxcbiAgKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIC9nc2QgdGVtcGxhdGVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlVGVtcGxhdGVzKFxuICBhcmdzOiBzdHJpbmcsXG4gIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgdHJpbW1lZCA9IGFyZ3MudHJpbSgpO1xuXG4gIC8vIC9nc2QgdGVtcGxhdGVzIGluZm8gPG5hbWU+XG4gIGlmICh0cmltbWVkLnN0YXJ0c1dpdGgoXCJpbmZvIFwiKSkge1xuICAgIGNvbnN0IG5hbWUgPSB0cmltbWVkLnJlcGxhY2UoL15pbmZvXFxzKy8sIFwiXCIpLnRyaW0oKTtcbiAgICBjb25zdCBpbmZvID0gZ2V0VGVtcGxhdGVJbmZvKG5hbWUpO1xuICAgIGlmIChpbmZvKSB7XG4gICAgICBjdHgudWkubm90aWZ5KGluZm8sIFwiaW5mb1wiKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgYFVua25vd24gdGVtcGxhdGUgXCIke25hbWV9XCIuIFJ1biAvZ3NkIHRlbXBsYXRlcyB0byBzZWUgYXZhaWxhYmxlIHRlbXBsYXRlcy5gLFxuICAgICAgICBcIndhcm5pbmdcIixcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIC9nc2QgdGVtcGxhdGVzIFx1MjAxNCBsaXN0IGFsbFxuICBjdHgudWkubm90aWZ5KGxpc3RUZW1wbGF0ZXMoKSwgXCJpbmZvXCIpO1xufVxuXG4vKipcbiAqIFJldHVybiB0ZW1wbGF0ZSBJRHMgZm9yIGF1dG9jb21wbGV0ZSBpbiAvZ3NkIHRlbXBsYXRlcyBpbmZvIDxuYW1lPi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldFRlbXBsYXRlQ29tcGxldGlvbnMocHJlZml4OiBzdHJpbmcpOiBBcnJheTx7IHZhbHVlOiBzdHJpbmc7IGxhYmVsOiBzdHJpbmc7IGRlc2NyaXB0aW9uOiBzdHJpbmcgfT4ge1xuICB0cnkge1xuICAgIGNvbnN0IHJlZ2lzdHJ5ID0gbG9hZFJlZ2lzdHJ5KCk7XG4gICAgcmV0dXJuIE9iamVjdC5lbnRyaWVzKHJlZ2lzdHJ5LnRlbXBsYXRlcylcbiAgICAgIC5maWx0ZXIoKFtpZF0pID0+IGlkLnN0YXJ0c1dpdGgocHJlZml4KSlcbiAgICAgIC5tYXAoKFtpZCwgZW50cnldKSA9PiAoe1xuICAgICAgICB2YWx1ZTogYGluZm8gJHtpZH1gLFxuICAgICAgICBsYWJlbDogaWQsXG4gICAgICAgIGRlc2NyaXB0aW9uOiBlbnRyeS5kZXNjcmlwdGlvbixcbiAgICAgIH0pKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTaGFyZWQgbWFya2Rvd24tcGhhc2UgZGlzcGF0Y2hlciAodXNlZCBieSAvZ3NkIHdvcmtmbG93IDxuYW1lPikgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogRGlzcGF0Y2ggYSBtYXJrZG93bi1waGFzZSB3b3JrZmxvdyBwbHVnaW4uIE1pcnJvcnMgYGhhbmRsZVN0YXJ0YCdzIGV4ZWN1dGlvblxuICogYnJhbmNoIGZvciByZXNvbHZlZCB0ZW1wbGF0ZXMsIGJ1dCBhY2NlcHRzIGEgcHJlLXJlc29sdmVkIHBsdWdpbiAoZnJvbSB0aGVcbiAqIHVuaWZpZWQgcGx1Z2luIHJlc29sdmVyKS5cbiAqXG4gKiBXcml0ZXMgU1RBVEUuanNvbiBpbnRvIGFuIGFydGlmYWN0IGRpciwgY3JlYXRlcyBhIGdpdCBicmFuY2gsIGFuZCBkaXNwYXRjaGVzXG4gKiB0aGUgYHdvcmtmbG93LXN0YXJ0YCBwcm9tcHQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkaXNwYXRjaE1hcmtkb3duUGhhc2VQbHVnaW4oXG4gIHBsdWdpbjogV29ya2Zsb3dQbHVnaW4sXG4gIGRlc2NyaXB0aW9uOiBzdHJpbmcsXG4gIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsXG4gIHBpOiBFeHRlbnNpb25BUEksXG4pOiB2b2lkIHtcbiAgaWYgKHBsdWdpbi5tZXRhLm1vZGUgIT09IFwibWFya2Rvd24tcGhhc2VcIikgcmV0dXJuO1xuXG4gIGlmIChpc0F1dG9BY3RpdmUoKSkge1xuICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICBcIkNhbm5vdCBzdGFydCBhIG1hcmtkb3duLXBoYXNlIHdvcmtmbG93IHdoaWxlIGF1dG8tbW9kZSBpcyBydW5uaW5nLlxcblwiICtcbiAgICAgIFwiUnVuIC9nc2QgcGF1c2UgZmlyc3QuXCIsXG4gICAgICBcIndhcm5pbmdcIixcbiAgICApO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHRlbXBsYXRlSWQgPSBwbHVnaW4ubmFtZTtcbiAgY29uc3QgYmFzZVBhdGggPSBjdXJyZW50RGlyZWN0b3J5Um9vdCgpO1xuICBjb25zdCBkYXRlID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpLnNwbGl0KFwiVFwiKVswXTtcbiAgbGV0IHdvcmtmbG93Q29udGVudDogc3RyaW5nO1xuICB0cnkge1xuICAgIHdvcmtmbG93Q29udGVudCA9IHJlYWRGaWxlU3luYyhwbHVnaW4ucGF0aCwgXCJ1dGYtOFwiKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY3R4LnVpLm5vdGlmeShcbiAgICAgIGBGYWlsZWQgdG8gcmVhZCB0ZW1wbGF0ZTogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCxcbiAgICAgIFwiZXJyb3JcIixcbiAgICApO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIENyZWF0ZSBhcnRpZmFjdCBkaXJlY3RvcnkuXG4gIGxldCBhcnRpZmFjdERpciA9IFwiXCI7XG4gIGlmIChwbHVnaW4ubWV0YS5hcnRpZmFjdERpcikge1xuICAgIGNvbnN0IHNsdWcgPSBzbHVnaWZ5KGRlc2NyaXB0aW9uIHx8IHRlbXBsYXRlSWQpO1xuICAgIGNvbnN0IHByZWZpeCA9IGRhdGVQcmVmaXgoKTtcbiAgICBjb25zdCBudW0gPSBnZXROZXh0V29ya2Zsb3dOdW0oam9pbihiYXNlUGF0aCwgcGx1Z2luLm1ldGEuYXJ0aWZhY3REaXIpKTtcbiAgICBhcnRpZmFjdERpciA9IGAke3BsdWdpbi5tZXRhLmFydGlmYWN0RGlyfSR7cHJlZml4fS0ke251bX0tJHtzbHVnfWA7XG4gICAgbWtkaXJTeW5jKGpvaW4oYmFzZVBhdGgsIGFydGlmYWN0RGlyKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIH1cblxuICAvLyBDcmVhdGUgZ2l0IGJyYW5jaCB1bmxlc3MgaXNvbGF0aW9uOiBub25lLlxuICBjb25zdCBnaXQgPSBjcmVhdGVHaXRTZXJ2aWNlKGJhc2VQYXRoKTtcbiAgY29uc3Qgc2tpcEJyYW5jaCA9IGdpdC5wcmVmcy5pc29sYXRpb24gPT09IFwibm9uZVwiO1xuICBjb25zdCBzbHVnID0gc2x1Z2lmeShkZXNjcmlwdGlvbiB8fCB0ZW1wbGF0ZUlkKTtcbiAgY29uc3QgYnJhbmNoTmFtZSA9IGBnc2QvJHt0ZW1wbGF0ZUlkfS8ke3NsdWd9YDtcbiAgbGV0IGJyYW5jaENyZWF0ZWQgPSBmYWxzZTtcblxuICBpZiAoIXNraXBCcmFuY2gpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgY3VycmVudCA9IGdpdC5nZXRDdXJyZW50QnJhbmNoKCk7XG4gICAgICBpZiAoY3VycmVudCAhPT0gYnJhbmNoTmFtZSkge1xuICAgICAgICB0cnkgeyBnaXQuYXV0b0NvbW1pdChcIndvcmtmbG93LXRlbXBsYXRlXCIsIHRlbXBsYXRlSWQsIFtdKTsgfSBjYXRjaCB7IC8qIG5vdGhpbmcgdG8gY29tbWl0ICovIH1cbiAgICAgICAgcnVuR2l0KGJhc2VQYXRoLCBbXCJjaGVja291dFwiLCBcIi1iXCIsIGJyYW5jaE5hbWVdKTtcbiAgICAgICAgYnJhbmNoQ3JlYXRlZCA9IHRydWU7XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICBgQ291bGQgbm90IGNyZWF0ZSBicmFuY2ggJHticmFuY2hOYW1lfTogJHtnZXRFcnJvck1lc3NhZ2UoZXJyKX0uIFdvcmtpbmcgb24gY3VycmVudCBicmFuY2guYCxcbiAgICAgICAgXCJ3YXJuaW5nXCIsXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IGFjdHVhbEJyYW5jaCA9IGJyYW5jaENyZWF0ZWQgPyBicmFuY2hOYW1lIDogZ2l0LmdldEN1cnJlbnRCcmFuY2goKTtcblxuICAvLyBXcml0ZSBTVEFURS5qc29uLlxuICBpZiAoYXJ0aWZhY3REaXIgJiYgcGx1Z2luLm1ldGEucGhhc2VzICYmIHBsdWdpbi5tZXRhLnBoYXNlcy5sZW5ndGggPiAwKSB7XG4gICAgd3JpdGVXb3JrZmxvd1N0YXRlKFxuICAgICAgam9pbihiYXNlUGF0aCwgYXJ0aWZhY3REaXIpLFxuICAgICAgdGVtcGxhdGVJZCxcbiAgICAgIHBsdWdpbi5tZXRhLmRpc3BsYXlOYW1lLFxuICAgICAgcGx1Z2luLm1ldGEucGhhc2VzLFxuICAgICAgZGVzY3JpcHRpb24sXG4gICAgICBhY3R1YWxCcmFuY2gsXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IGluZm9MaW5lcyA9IFtcbiAgICBgU3RhcnRpbmcgd29ya2Zsb3c6ICR7cGx1Z2luLm1ldGEuZGlzcGxheU5hbWV9YCxcbiAgICBgUGhhc2VzOiAkeyhwbHVnaW4ubWV0YS5waGFzZXMgPz8gW10pLmpvaW4oXCIgXHUyMTkyIFwiKX1gLFxuICBdO1xuICBpZiAoYXJ0aWZhY3REaXIpIGluZm9MaW5lcy5wdXNoKGBBcnRpZmFjdHM6ICR7YXJ0aWZhY3REaXJ9YCk7XG4gIGluZm9MaW5lcy5wdXNoKGBCcmFuY2g6ICR7YWN0dWFsQnJhbmNofWApO1xuICBjdHgudWkubm90aWZ5KGluZm9MaW5lcy5qb2luKFwiXFxuXCIpLCBcImluZm9cIik7XG4gIGluY3JlbWVudExlZ2FjeVRlbGVtZXRyeShcImxlZ2FjeS53b3JrZmxvd0VuZ2luZVVzZWRcIik7XG5cbiAgY29uc3QgcHJvbXB0ID0gbG9hZFByb21wdChcIndvcmtmbG93LXN0YXJ0XCIsIHtcbiAgICB0ZW1wbGF0ZUlkLFxuICAgIHRlbXBsYXRlTmFtZTogcGx1Z2luLm1ldGEuZGlzcGxheU5hbWUsXG4gICAgdGVtcGxhdGVEZXNjcmlwdGlvbjogcGx1Z2luLm1ldGEuZGVzY3JpcHRpb24gPz8gXCJcIixcbiAgICBwaGFzZXM6IChwbHVnaW4ubWV0YS5waGFzZXMgPz8gW10pLmpvaW4oXCIgXHUyMTkyIFwiKSxcbiAgICBjb21wbGV4aXR5OiBwbHVnaW4ubWV0YS5jb21wbGV4aXR5ID8/IFwibWVkaXVtXCIsXG4gICAgYXJ0aWZhY3REaXI6IGFydGlmYWN0RGlyIHx8IFwiKG5vbmUpXCIsXG4gICAgYnJhbmNoOiBhY3R1YWxCcmFuY2gsXG4gICAgZGVzY3JpcHRpb246IGRlc2NyaXB0aW9uIHx8IFwiKG5vbmUgcHJvdmlkZWQpXCIsXG4gICAgaXNzdWVSZWY6IFwiKG5vbmUpXCIsXG4gICAgZGF0ZSxcbiAgICB3b3JrZmxvd0NvbnRlbnQsXG4gIH0pO1xuXG4gIHBpLnNlbmRNZXNzYWdlKFxuICAgIHsgY3VzdG9tVHlwZTogXCJnc2Qtd29ya2Zsb3ctdGVtcGxhdGVcIiwgY29udGVudDogcHJvbXB0LCBkaXNwbGF5OiBmYWxzZSB9LFxuICAgIHsgdHJpZ2dlclR1cm46IHRydWUgfSxcbiAgKTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQVdBLFNBQVMsWUFBWSxXQUFXLGFBQWEsY0FBYyxxQkFBcUI7QUFDaEYsU0FBUyxZQUFZO0FBQ3JCO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BRUs7QUFDUCxTQUFTLGtCQUFrQjtBQUMzQixTQUFTLGVBQWU7QUFDeEIsU0FBUyxrQkFBa0IsY0FBYztBQUN6QyxTQUFTLGNBQWMsb0JBQW9CO0FBQzNDLFNBQVMsdUJBQXVCO0FBQ2hDLFNBQVMscUJBQTBDO0FBQ25ELFNBQVMsNEJBQTRCO0FBQ3JDLFNBQVMscUNBQXFDO0FBQzlDLFNBQVMsZ0NBQWdDO0FBT3pDLFNBQVMsUUFBUSxNQUFzQjtBQUNyQyxTQUFPLEtBQ0osWUFBWSxFQUNaLFFBQVEsZUFB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QUFJLFlBQWEsV0FBVSxLQUFLLGNBQWMsV0FBVyxFQUFFO0FBQzNELFlBQVUsS0FBSyxXQUFXLFlBQVksRUFBRTtBQUN4QyxNQUFJLEdBQUcsT0FBTyxVQUFVLEtBQUssSUFBSSxHQUFHLE1BQU07QUFDMUMsMkJBQXlCLDJCQUEyQjtBQUVwRCxRQUFNLFNBQVMsV0FBVyxrQkFBa0I7QUFBQSxJQUMxQztBQUFBLElBQ0EsY0FBYyxPQUFPLEtBQUs7QUFBQSxJQUMxQixxQkFBcUIsT0FBTyxLQUFLLGVBQWU7QUFBQSxJQUNoRCxTQUFTLE9BQU8sS0FBSyxVQUFVLENBQUMsR0FBRyxLQUFLLFVBQUs7QUFBQSxJQUM3QyxZQUFZLE9BQU8sS0FBSyxjQUFjO0FBQUEsSUFDdEMsYUFBYSxlQUFlO0FBQUEsSUFDNUIsUUFBUTtBQUFBLElBQ1IsYUFBYSxlQUFlO0FBQUEsSUFDNUIsVUFBVTtBQUFBLElBQ1Y7QUFBQSxJQUNBO0FBQUEsRUFDRixDQUFDO0FBRUQsS0FBRztBQUFBLElBQ0QsRUFBRSxZQUFZLHlCQUF5QixTQUFTLFFBQVEsU0FBUyxNQUFNO0FBQUEsSUFDdkUsRUFBRSxhQUFhLEtBQUs7QUFBQSxFQUN0QjtBQUNGOyIsCiAgIm5hbWVzIjogWyJiYXNlUGF0aCIsICJ3b3JrZmxvd0NvbnRlbnQiLCAicHJvbXB0IiwgInNsdWciXQp9Cg==
