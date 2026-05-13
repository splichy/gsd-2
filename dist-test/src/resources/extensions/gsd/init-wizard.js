import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { showNextAction } from "../shared/tui.js";
import { nativeInit, nativeAddAll, nativeCommit, nativeDetectMainBranch } from "./native-git-bridge.js";
import { ensureGitignore, untrackRuntimeFiles } from "./gitignore.js";
import { gsdRoot } from "./paths.js";
import { assertSafeDirectory } from "./validate-directory.js";
import { runSkillInstallStep } from "./skill-catalog.js";
import { generateCodebaseMap, writeCodebaseMap } from "./codebase-generator.js";
import { handlePrefsWizard, writePreferencesFile } from "./commands-prefs-wizard.js";
function shouldWriteGitFiles(gitEnabled) {
  return gitEnabled;
}
const DEFAULT_PREFS = {
  mode: "solo",
  gitIsolation: "worktree",
  mainBranch: "main",
  verificationCommands: [],
  customInstructions: [],
  tokenProfile: "balanced",
  skipResearch: false,
  autoPush: true
};
async function showProjectInit(ctx, pi, basePath, detection) {
  const signals = detection.projectSignals;
  const prefs = { ...DEFAULT_PREFS };
  const detectionSummary = buildDetectionSummary(signals);
  if (detectionSummary.length > 0) {
    ctx.ui.notify(`Project detected:
${detectionSummary.join("\n")}`, "info");
  }
  let didInitGit = false;
  let gitEnabled = signals.isGitRepo;
  if (!signals.isGitRepo) {
    const gitChoice2 = await showNextAction(ctx, {
      title: "GSD \u2014 Project Setup",
      summary: ["This folder is not a git repository. GSD uses git for version control and isolation."],
      actions: [
        { id: "init_git", label: "Initialize git", description: "Create a git repo in this folder", recommended: true },
        { id: "skip_git", label: "Skip", description: "Continue without git (limited functionality)" }
      ],
      notYetMessage: "Run /gsd init when ready."
    });
    if (gitChoice2 === "not_yet") return { completed: false, bootstrapped: false };
    if (gitChoice2 === "init_git") {
      nativeInit(basePath, prefs.mainBranch);
      didInitGit = true;
      gitEnabled = true;
    }
  } else {
    const detectedBranch = detectMainBranch(basePath);
    if (detectedBranch) prefs.mainBranch = detectedBranch;
  }
  const modeChoice = await showNextAction(ctx, {
    title: "GSD \u2014 Workflow Mode",
    summary: ["How are you working on this project?"],
    actions: [
      {
        id: "solo",
        label: "Solo",
        description: "Just me \u2014 auto-push, squash merge, worktree isolation",
        recommended: true
      },
      {
        id: "team",
        label: "Team",
        description: "Multiple contributors \u2014 branch-based, PR-friendly workflow"
      }
    ],
    notYetMessage: "Run /gsd init when ready."
  });
  if (modeChoice === "not_yet") return { completed: false, bootstrapped: false };
  prefs.mode = modeChoice;
  if (prefs.mode === "team") {
    prefs.autoPush = false;
  }
  prefs.verificationCommands = signals.verificationCommands;
  if (signals.verificationCommands.length > 0) {
    const verifyLines = signals.verificationCommands.map((cmd, i) => `  ${i + 1}. ${cmd}`);
    const verifyChoice = await showNextAction(ctx, {
      title: "GSD \u2014 Verification Commands",
      summary: [
        "Auto-detected verification commands:",
        ...verifyLines,
        "",
        "GSD runs these after each code change to verify nothing is broken."
      ],
      actions: [
        { id: "accept", label: "Use these commands", description: "Accept auto-detected commands", recommended: true },
        { id: "skip", label: "Skip verification", description: "Don't verify after changes" }
      ],
      notYetMessage: "Run /gsd init when ready."
    });
    if (verifyChoice === "not_yet") return { completed: false, bootstrapped: false };
    if (verifyChoice === "skip") prefs.verificationCommands = [];
  }
  const gitSummary = [];
  gitSummary.push(`Git isolation: worktree`);
  gitSummary.push(`Main branch: ${prefs.mainBranch}`);
  const gitChoice = await showNextAction(ctx, {
    title: "GSD \u2014 Git Settings",
    summary: ["Default git settings for this project:", ...gitSummary],
    actions: [
      { id: "accept", label: "Accept defaults", description: "Use standard git settings", recommended: true },
      { id: "customize", label: "Customize", description: "Change git settings" }
    ],
    notYetMessage: "Run /gsd init when ready."
  });
  if (gitChoice === "not_yet") return { completed: false, bootstrapped: false };
  if (gitChoice === "customize") {
    await customizeGitPrefs(ctx, prefs, signals);
  }
  const instructionChoice = await showNextAction(ctx, {
    title: "GSD \u2014 Project Instructions",
    summary: [
      "Any rules GSD should follow for this project?",
      "",
      "Examples:",
      '  - "Use TypeScript strict mode"',
      '  - "Always write tests for new code"',
      '  - "This is a monorepo, only touch packages/api"',
      "",
      "You can always add more later via /gsd prefs project."
    ],
    actions: [
      { id: "skip", label: "Skip for now", description: "No special instructions", recommended: true },
      { id: "add", label: "Add instructions", description: "Enter project-specific rules" }
    ],
    notYetMessage: "Run /gsd init when ready."
  });
  if (instructionChoice === "not_yet") return { completed: false, bootstrapped: false };
  if (instructionChoice === "add") {
    const input = await ctx.ui.input(
      "Enter instructions (one per line, or comma-separated):",
      "e.g., Use Tailwind CSS, Always write tests"
    );
    if (input && input.trim()) {
      prefs.customInstructions = input.split(/[,\n]/).map((s) => s.trim()).filter((s) => s.length > 0);
    }
  }
  const advancedChoice = await showNextAction(ctx, {
    title: "GSD \u2014 Advanced Settings",
    summary: [
      `Token profile: ${prefs.tokenProfile}`,
      `Skip research phase: ${prefs.skipResearch ? "yes" : "no"}`,
      `Auto-push on merge: ${prefs.autoPush ? "yes" : "no"}`
    ],
    actions: [
      { id: "accept", label: "Accept defaults", description: "Use standard settings", recommended: true },
      { id: "customize", label: "Customize", description: "Change advanced settings" }
    ],
    notYetMessage: "Run /gsd init when ready."
  });
  if (advancedChoice === "not_yet") return { completed: false, bootstrapped: false };
  if (advancedChoice === "customize") {
    await customizeAdvancedPrefs(ctx, prefs);
  }
  try {
    await runSkillInstallStep(ctx, signals);
  } catch {
  }
  const reviewChoice = await showNextAction(ctx, {
    title: "GSD \u2014 Review All Preferences (Optional)",
    summary: [
      "Open the full preferences wizard now? It includes models, timeouts,",
      "budget, notifications, and skills \u2014 all pre-filled with your answers.",
      "",
      "Skip if you just want sensible defaults; you can always run /gsd prefs project later."
    ],
    actions: [
      { id: "skip", label: "Skip \u2014 use defaults", description: "Save preferences and continue", recommended: true },
      { id: "review", label: "Open full wizard", description: "Tweak any category before saving" }
    ],
    notYetMessage: "Run /gsd init when ready."
  });
  if (reviewChoice === "not_yet") {
    return { completed: false, bootstrapped: false };
  }
  bootstrapGsdDirectoryStructure(basePath, signals);
  const prefillPrefs = mapInitPrefsToWizardShape(prefs);
  const projectPrefsPath = join(gsdRoot(basePath), "PREFERENCES.md");
  if (reviewChoice === "review") {
    await handlePrefsWizard(ctx, "project", prefillPrefs, { pathOverride: projectPrefsPath });
  } else {
    await writePreferencesFile(projectPrefsPath, prefillPrefs, ctx, {
      scope: "project",
      defaultBody: buildInitPreferencesBody(),
      notifyOnSave: false
    });
  }
  try {
    const { ensureDbOpen } = await import("./bootstrap/dynamic-tools.js");
    await ensureDbOpen(basePath);
  } catch {
  }
  if (shouldWriteGitFiles(gitEnabled)) {
    ensureGitignore(basePath);
    untrackRuntimeFiles(basePath);
  }
  if (didInitGit) {
    try {
      nativeAddAll(basePath);
      nativeCommit(basePath, "chore: init project");
    } catch {
    }
  }
  try {
    const result = generateCodebaseMap(basePath);
    if (result.fileCount > 0) {
      writeCodebaseMap(basePath, result.content);
      ctx.ui.notify(`Codebase map generated: ${result.fileCount} files`, "info");
    }
  } catch {
  }
  try {
    const { deriveState } = await import("./state.js");
    const { buildStateMarkdown } = await import("./doctor.js");
    const { saveFile } = await import("./files.js");
    const { resolveGsdRootFile } = await import("./paths.js");
    const state = await deriveState(basePath);
    await saveFile(resolveGsdRootFile(basePath, "STATE"), buildStateMarkdown(state));
  } catch {
  }
  {
    const { prepareWorkflowMcpForProject } = await import("./workflow-mcp-auto-prep.js");
    prepareWorkflowMcpForProject(ctx, basePath);
  }
  ctx.ui.notify("GSD initialized. Starting your first milestone...", "info");
  return { completed: true, bootstrapped: true, gitEnabled };
}
async function offerMigration(ctx, v1) {
  const summary = [
    "Found .planning/ directory (GSD v1 format)"
  ];
  if (v1.phaseCount > 0) {
    summary.push(`${v1.phaseCount} phase${v1.phaseCount > 1 ? "s" : ""} detected`);
  }
  if (v1.hasRoadmap) {
    summary.push("Has ROADMAP.md");
  }
  const choice = await showNextAction(ctx, {
    title: "GSD \u2014 Legacy Project Detected",
    summary,
    actions: [
      {
        id: "migrate",
        label: "Migrate to GSD v2",
        description: "Convert .planning/ to .gsd/ format",
        recommended: true
      },
      {
        id: "fresh",
        label: "Start fresh",
        description: "Ignore .planning/ and create new .gsd/"
      }
    ],
    notYetMessage: "Run /gsd init when ready."
  });
  if (choice === "not_yet") return "cancel";
  return choice;
}
async function handleReinit(ctx, detection) {
  const summary = ["GSD is already initialized in this project."];
  if (detection.v2) {
    summary.push(`${detection.v2.milestoneCount} milestone(s) found`);
    summary.push(`Preferences: ${detection.v2.hasPreferences ? "configured" : "not set"}`);
  }
  const choice = await showNextAction(ctx, {
    title: "GSD \u2014 Already Initialized",
    summary,
    actions: [
      {
        id: "prefs",
        label: "Re-configure preferences",
        description: "Update project preferences without affecting milestones",
        recommended: true
      },
      {
        id: "cancel",
        label: "Cancel",
        description: "Keep everything as-is"
      }
    ],
    notYetMessage: "Run /gsd init when ready."
  });
  if (choice === "prefs") {
    ctx.ui.notify("Use /gsd prefs project to update project preferences.", "info");
  }
}
async function customizeGitPrefs(ctx, prefs, signals) {
  const hasSubmodules = existsSync(join(process.cwd(), ".gitmodules"));
  const isolationActions = [
    { id: "worktree", label: "Worktree", description: "Isolated git worktree per milestone (recommended)", recommended: !hasSubmodules },
    { id: "branch", label: "Branch", description: "Work on branches in project root (better for submodules)", recommended: hasSubmodules },
    { id: "none", label: "None", description: "No isolation \u2014 commits on current branch" }
  ];
  const isolationSummary = hasSubmodules ? ["Submodules detected \u2014 branch mode recommended over worktree."] : ["Worktree isolation creates a separate copy for each milestone."];
  const isolationChoice = await showNextAction(ctx, {
    title: "Git isolation strategy",
    summary: isolationSummary,
    actions: isolationActions
  });
  if (isolationChoice !== "not_yet") {
    prefs.gitIsolation = isolationChoice;
  }
}
async function customizeAdvancedPrefs(ctx, prefs) {
  const profileChoice = await showNextAction(ctx, {
    title: "Token usage profile",
    summary: [
      "Controls how much context GSD uses per task.",
      "Budget: cheaper, faster. Quality: thorough, more expensive."
    ],
    actions: [
      { id: "balanced", label: "Balanced", description: "Good trade-off (default)", recommended: true },
      { id: "budget", label: "Budget", description: "Minimize token usage" },
      { id: "quality", label: "Quality", description: "Maximize thoroughness" },
      { id: "burn-max", label: "Burn Max", description: "Maximum depth, no phase skips" }
    ]
  });
  if (profileChoice !== "not_yet") {
    prefs.tokenProfile = profileChoice;
  }
  const researchChoice = await showNextAction(ctx, {
    title: "Research phase",
    summary: [
      "GSD can research the codebase before planning each milestone.",
      "Small projects may not need this step."
    ],
    actions: [
      { id: "keep", label: "Keep research", description: "Explore codebase before planning", recommended: true },
      { id: "skip", label: "Skip research", description: "Go straight to planning" }
    ]
  });
  prefs.skipResearch = researchChoice === "skip";
  const pushChoice = await showNextAction(ctx, {
    title: "Auto-push after merge",
    summary: [
      "After merging a milestone branch, auto-push to remote?",
      prefs.mode === "team" ? "Team mode: usually disabled so changes go through PR review." : "Solo mode: usually enabled for convenience."
    ],
    actions: [
      { id: "yes", label: "Yes", description: "Push automatically", recommended: prefs.mode === "solo" },
      { id: "no", label: "No", description: "Manual push only", recommended: prefs.mode === "team" }
    ]
  });
  prefs.autoPush = pushChoice !== "no";
}
function bootstrapGsdDirectoryStructure(basePath, signals) {
  assertSafeDirectory(basePath);
  const gsd = gsdRoot(basePath);
  mkdirSync(join(gsd, "milestones"), { recursive: true });
  mkdirSync(join(gsd, "runtime"), { recursive: true });
  const contextContent = buildContextSeed(signals);
  if (contextContent) {
    writeFileSync(join(gsd, "CONTEXT.md"), contextContent, "utf-8");
  }
}
function mapInitPrefsToWizardShape(prefs) {
  const out = {
    mode: prefs.mode,
    git: {
      isolation: prefs.gitIsolation,
      main_branch: prefs.mainBranch,
      auto_push: prefs.autoPush
    }
  };
  if (prefs.verificationCommands.length > 0) {
    out.verification_commands = prefs.verificationCommands;
  }
  if (prefs.customInstructions.length > 0) {
    out.custom_instructions = prefs.customInstructions;
  }
  if (prefs.tokenProfile !== "balanced") {
    out.token_profile = prefs.tokenProfile;
  }
  if (prefs.skipResearch) {
    out.phases = { skip_research: true };
  }
  return out;
}
function buildInitPreferencesBody() {
  return [
    "",
    "# GSD Project Preferences",
    "",
    "Generated by `/gsd init`. Edit directly or use `/gsd prefs project` to modify.",
    "",
    "See `~/.gsd/agent/extensions/gsd/docs/preferences-reference.md` for full field documentation.",
    ""
  ].join("\n");
}
function buildContextSeed(signals) {
  const lines = [];
  if (signals.detectedFiles.length === 0 && !signals.isGitRepo) {
    return null;
  }
  lines.push("# Project Context");
  lines.push("");
  lines.push("Auto-detected by GSD init wizard. Edit or expand as needed.");
  lines.push("");
  if (signals.primaryLanguage) {
    lines.push(`## Language / Stack`);
    lines.push("");
    lines.push(`Primary: ${signals.primaryLanguage}`);
    if (signals.isMonorepo) {
      lines.push("Structure: monorepo");
    }
    lines.push("");
  }
  if (signals.detectedFiles.length > 0) {
    lines.push("## Project Files");
    lines.push("");
    for (const f of signals.detectedFiles) {
      lines.push(`- ${f}`);
    }
    lines.push("");
  }
  if (signals.hasCI) {
    lines.push("## CI/CD");
    lines.push("");
    lines.push("CI configuration detected.");
    lines.push("");
  }
  if (signals.hasTests) {
    lines.push("## Testing");
    lines.push("");
    lines.push("Test infrastructure detected.");
    if (signals.verificationCommands.length > 0) {
      lines.push("");
      lines.push("Verification commands:");
      for (const cmd of signals.verificationCommands) {
        lines.push(`- \`${cmd}\``);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}
function buildDetectionSummary(signals) {
  const lines = [];
  if (signals.primaryLanguage) {
    const typeStr = signals.isMonorepo ? "monorepo" : "project";
    lines.push(`  ${signals.primaryLanguage} ${typeStr}`);
  }
  if (signals.detectedFiles.length > 0) {
    lines.push(`  Project files: ${signals.detectedFiles.join(", ")}`);
  }
  if (signals.packageManager) {
    lines.push(`  Package manager: ${signals.packageManager}`);
  }
  if (signals.hasCI) lines.push("  CI/CD: detected");
  if (signals.hasTests) lines.push("  Tests: detected");
  if (signals.verificationCommands.length > 0) {
    lines.push(`  Verification: ${signals.verificationCommands.join(", ")}`);
  }
  return lines;
}
function detectMainBranch(basePath) {
  try {
    return nativeDetectMainBranch(basePath);
  } catch {
  }
  return null;
}
export {
  detectMainBranch,
  handleReinit,
  mapInitPrefsToWizardShape,
  offerMigration,
  shouldWriteGitFiles,
  showProjectInit
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9pbml0LXdpemFyZC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBHU0QgSW5pdCBXaXphcmQgXHUyMDE0IFBlci1wcm9qZWN0IG9uYm9hcmRpbmcuXG4gKlxuICogR3VpZGVzIHVzZXJzIHRocm91Z2ggcHJvamVjdCBzZXR1cCB3aGVuIGVudGVyaW5nIGEgZGlyZWN0b3J5IHdpdGhvdXQgLmdzZC8uXG4gKiBEZXRlY3RzIHByb2plY3QgZWNvc3lzdGVtLCBvZmZlcnMgdjEgbWlncmF0aW9uLCBjb25maWd1cmVzIHByb2plY3QgcHJlZmVyZW5jZXMsXG4gKiBib290c3RyYXBzIC5nc2QvIHN0cnVjdHVyZSwgYW5kIHRyYW5zaXRpb25zIHRvIHRoZSBmaXJzdCBtaWxlc3RvbmUgZGlzY3Vzc2lvbi5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEV4dGVuc2lvbkFQSSwgRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMsIG1rZGlyU3luYywgd3JpdGVGaWxlU3luYywgcmVhZEZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBzaG93TmV4dEFjdGlvbiB9IGZyb20gXCIuLi9zaGFyZWQvdHVpLmpzXCI7XG5pbXBvcnQgeyBuYXRpdmVJc1JlcG8sIG5hdGl2ZUluaXQsIG5hdGl2ZUFkZEFsbCwgbmF0aXZlQ29tbWl0LCBuYXRpdmVEZXRlY3RNYWluQnJhbmNoIH0gZnJvbSBcIi4vbmF0aXZlLWdpdC1icmlkZ2UuanNcIjtcbmltcG9ydCB7IGVuc3VyZUdpdGlnbm9yZSwgdW50cmFja1J1bnRpbWVGaWxlcyB9IGZyb20gXCIuL2dpdGlnbm9yZS5qc1wiO1xuaW1wb3J0IHsgZ3NkUm9vdCB9IGZyb20gXCIuL3BhdGhzLmpzXCI7XG5pbXBvcnQgeyBhc3NlcnRTYWZlRGlyZWN0b3J5IH0gZnJvbSBcIi4vdmFsaWRhdGUtZGlyZWN0b3J5LmpzXCI7XG5pbXBvcnQgdHlwZSB7IFByb2plY3REZXRlY3Rpb24sIFByb2plY3RTaWduYWxzIH0gZnJvbSBcIi4vZGV0ZWN0aW9uLmpzXCI7XG5pbXBvcnQgeyBydW5Ta2lsbEluc3RhbGxTdGVwIH0gZnJvbSBcIi4vc2tpbGwtY2F0YWxvZy5qc1wiO1xuaW1wb3J0IHsgZ2VuZXJhdGVDb2RlYmFzZU1hcCwgd3JpdGVDb2RlYmFzZU1hcCB9IGZyb20gXCIuL2NvZGViYXNlLWdlbmVyYXRvci5qc1wiO1xuaW1wb3J0IHsgaGFuZGxlUHJlZnNXaXphcmQsIHdyaXRlUHJlZmVyZW5jZXNGaWxlIH0gZnJvbSBcIi4vY29tbWFuZHMtcHJlZnMtd2l6YXJkLmpzXCI7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUeXBlcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuaW50ZXJmYWNlIEluaXRXaXphcmRSZXN1bHQge1xuICAvKiogV2hldGhlciB0aGUgd2l6YXJkIGNvbXBsZXRlZCAodnMgY2FuY2VsbGVkKSAqL1xuICBjb21wbGV0ZWQ6IGJvb2xlYW47XG4gIC8qKiBXaGV0aGVyIC5nc2QvIHdhcyBjcmVhdGVkICovXG4gIGJvb3RzdHJhcHBlZDogYm9vbGVhbjtcbiAgLyoqIFdoZXRoZXIgZ2l0IGlzIGF2YWlsYWJsZSBvciB3YXMgaW5pdGlhbGl6ZWQgZHVyaW5nIHNldHVwLiAqL1xuICBnaXRFbmFibGVkPzogYm9vbGVhbjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNob3VsZFdyaXRlR2l0RmlsZXMoZ2l0RW5hYmxlZDogYm9vbGVhbik6IGJvb2xlYW4ge1xuICByZXR1cm4gZ2l0RW5hYmxlZDtcbn1cblxuaW50ZXJmYWNlIFByb2plY3RQcmVmZXJlbmNlcyB7XG4gIG1vZGU6IFwic29sb1wiIHwgXCJ0ZWFtXCI7XG4gIGdpdElzb2xhdGlvbjogXCJ3b3JrdHJlZVwiIHwgXCJicmFuY2hcIiB8IFwibm9uZVwiO1xuICBtYWluQnJhbmNoOiBzdHJpbmc7XG4gIHZlcmlmaWNhdGlvbkNvbW1hbmRzOiBzdHJpbmdbXTtcbiAgY3VzdG9tSW5zdHJ1Y3Rpb25zOiBzdHJpbmdbXTtcbiAgdG9rZW5Qcm9maWxlOiBcImJ1ZGdldFwiIHwgXCJiYWxhbmNlZFwiIHwgXCJxdWFsaXR5XCIgfCBcImJ1cm4tbWF4XCI7XG4gIHNraXBSZXNlYXJjaDogYm9vbGVhbjtcbiAgYXV0b1B1c2g6IGJvb2xlYW47XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBEZWZhdWx0cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuY29uc3QgREVGQVVMVF9QUkVGUzogUHJvamVjdFByZWZlcmVuY2VzID0ge1xuICBtb2RlOiBcInNvbG9cIixcbiAgZ2l0SXNvbGF0aW9uOiBcIndvcmt0cmVlXCIsXG4gIG1haW5CcmFuY2g6IFwibWFpblwiLFxuICB2ZXJpZmljYXRpb25Db21tYW5kczogW10sXG4gIGN1c3RvbUluc3RydWN0aW9uczogW10sXG4gIHRva2VuUHJvZmlsZTogXCJiYWxhbmNlZFwiLFxuICBza2lwUmVzZWFyY2g6IGZhbHNlLFxuICBhdXRvUHVzaDogdHJ1ZSxcbn07XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBNYWluIFdpemFyZCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBSdW4gdGhlIHByb2plY3QgaW5pdCB3aXphcmQuXG4gKiBDYWxsZWQgd2hlbiBlbnRlcmluZyBhIGRpcmVjdG9yeSB3aXRob3V0IC5nc2QvIChvciB2aWEgL2dzZCBpbml0KS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNob3dQcm9qZWN0SW5pdChcbiAgY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCxcbiAgcGk6IEV4dGVuc2lvbkFQSSxcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgZGV0ZWN0aW9uOiBQcm9qZWN0RGV0ZWN0aW9uLFxuKTogUHJvbWlzZTxJbml0V2l6YXJkUmVzdWx0PiB7XG4gIGNvbnN0IHNpZ25hbHMgPSBkZXRlY3Rpb24ucHJvamVjdFNpZ25hbHM7XG4gIGNvbnN0IHByZWZzID0geyAuLi5ERUZBVUxUX1BSRUZTIH07XG5cbiAgLy8gXHUyNTAwXHUyNTAwIFN0ZXAgMTogU2hvdyB3aGF0IHdlIGRldGVjdGVkIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBjb25zdCBkZXRlY3Rpb25TdW1tYXJ5ID0gYnVpbGREZXRlY3Rpb25TdW1tYXJ5KHNpZ25hbHMpO1xuICBpZiAoZGV0ZWN0aW9uU3VtbWFyeS5sZW5ndGggPiAwKSB7XG4gICAgY3R4LnVpLm5vdGlmeShgUHJvamVjdCBkZXRlY3RlZDpcXG4ke2RldGVjdGlvblN1bW1hcnkuam9pbihcIlxcblwiKX1gLCBcImluZm9cIik7XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgU3RlcCAyOiBHaXQgc2V0dXAgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGxldCBkaWRJbml0R2l0ID0gZmFsc2U7XG4gIGxldCBnaXRFbmFibGVkID0gc2lnbmFscy5pc0dpdFJlcG87XG4gIGlmICghc2lnbmFscy5pc0dpdFJlcG8pIHtcbiAgICBjb25zdCBnaXRDaG9pY2UgPSBhd2FpdCBzaG93TmV4dEFjdGlvbihjdHgsIHtcbiAgICAgIHRpdGxlOiBcIkdTRCBcdTIwMTQgUHJvamVjdCBTZXR1cFwiLFxuICAgICAgc3VtbWFyeTogW1wiVGhpcyBmb2xkZXIgaXMgbm90IGEgZ2l0IHJlcG9zaXRvcnkuIEdTRCB1c2VzIGdpdCBmb3IgdmVyc2lvbiBjb250cm9sIGFuZCBpc29sYXRpb24uXCJdLFxuICAgICAgYWN0aW9uczogW1xuICAgICAgICB7IGlkOiBcImluaXRfZ2l0XCIsIGxhYmVsOiBcIkluaXRpYWxpemUgZ2l0XCIsIGRlc2NyaXB0aW9uOiBcIkNyZWF0ZSBhIGdpdCByZXBvIGluIHRoaXMgZm9sZGVyXCIsIHJlY29tbWVuZGVkOiB0cnVlIH0sXG4gICAgICAgIHsgaWQ6IFwic2tpcF9naXRcIiwgbGFiZWw6IFwiU2tpcFwiLCBkZXNjcmlwdGlvbjogXCJDb250aW51ZSB3aXRob3V0IGdpdCAobGltaXRlZCBmdW5jdGlvbmFsaXR5KVwiIH0sXG4gICAgICBdLFxuICAgICAgbm90WWV0TWVzc2FnZTogXCJSdW4gL2dzZCBpbml0IHdoZW4gcmVhZHkuXCIsXG4gICAgfSk7XG5cbiAgICBpZiAoZ2l0Q2hvaWNlID09PSBcIm5vdF95ZXRcIikgcmV0dXJuIHsgY29tcGxldGVkOiBmYWxzZSwgYm9vdHN0cmFwcGVkOiBmYWxzZSB9O1xuXG4gICAgaWYgKGdpdENob2ljZSA9PT0gXCJpbml0X2dpdFwiKSB7XG4gICAgICBuYXRpdmVJbml0KGJhc2VQYXRoLCBwcmVmcy5tYWluQnJhbmNoKTtcbiAgICAgIGRpZEluaXRHaXQgPSB0cnVlO1xuICAgICAgZ2l0RW5hYmxlZCA9IHRydWU7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIC8vIEF1dG8tZGV0ZWN0IG1haW4gYnJhbmNoIGZyb20gZXhpc3RpbmcgcmVwb1xuICAgIGNvbnN0IGRldGVjdGVkQnJhbmNoID0gZGV0ZWN0TWFpbkJyYW5jaChiYXNlUGF0aCk7XG4gICAgaWYgKGRldGVjdGVkQnJhbmNoKSBwcmVmcy5tYWluQnJhbmNoID0gZGV0ZWN0ZWRCcmFuY2g7XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgU3RlcCAzOiBNb2RlIHNlbGVjdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgY29uc3QgbW9kZUNob2ljZSA9IGF3YWl0IHNob3dOZXh0QWN0aW9uKGN0eCwge1xuICAgIHRpdGxlOiBcIkdTRCBcdTIwMTQgV29ya2Zsb3cgTW9kZVwiLFxuICAgIHN1bW1hcnk6IFtcIkhvdyBhcmUgeW91IHdvcmtpbmcgb24gdGhpcyBwcm9qZWN0P1wiXSxcbiAgICBhY3Rpb25zOiBbXG4gICAgICB7XG4gICAgICAgIGlkOiBcInNvbG9cIixcbiAgICAgICAgbGFiZWw6IFwiU29sb1wiLFxuICAgICAgICBkZXNjcmlwdGlvbjogXCJKdXN0IG1lIFx1MjAxNCBhdXRvLXB1c2gsIHNxdWFzaCBtZXJnZSwgd29ya3RyZWUgaXNvbGF0aW9uXCIsXG4gICAgICAgIHJlY29tbWVuZGVkOiB0cnVlLFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgaWQ6IFwidGVhbVwiLFxuICAgICAgICBsYWJlbDogXCJUZWFtXCIsXG4gICAgICAgIGRlc2NyaXB0aW9uOiBcIk11bHRpcGxlIGNvbnRyaWJ1dG9ycyBcdTIwMTQgYnJhbmNoLWJhc2VkLCBQUi1mcmllbmRseSB3b3JrZmxvd1wiLFxuICAgICAgfSxcbiAgICBdLFxuICAgIG5vdFlldE1lc3NhZ2U6IFwiUnVuIC9nc2QgaW5pdCB3aGVuIHJlYWR5LlwiLFxuICB9KTtcblxuICBpZiAobW9kZUNob2ljZSA9PT0gXCJub3RfeWV0XCIpIHJldHVybiB7IGNvbXBsZXRlZDogZmFsc2UsIGJvb3RzdHJhcHBlZDogZmFsc2UgfTtcbiAgcHJlZnMubW9kZSA9IG1vZGVDaG9pY2UgYXMgXCJzb2xvXCIgfCBcInRlYW1cIjtcblxuICAvLyBBcHBseSBtb2RlLWRyaXZlbiBkZWZhdWx0c1xuICBpZiAocHJlZnMubW9kZSA9PT0gXCJ0ZWFtXCIpIHtcbiAgICBwcmVmcy5hdXRvUHVzaCA9IGZhbHNlO1xuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwIFN0ZXAgNDogVmVyaWZpY2F0aW9uIGNvbW1hbmRzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBwcmVmcy52ZXJpZmljYXRpb25Db21tYW5kcyA9IHNpZ25hbHMudmVyaWZpY2F0aW9uQ29tbWFuZHM7XG5cbiAgaWYgKHNpZ25hbHMudmVyaWZpY2F0aW9uQ29tbWFuZHMubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IHZlcmlmeUxpbmVzID0gc2lnbmFscy52ZXJpZmljYXRpb25Db21tYW5kcy5tYXAoKGNtZCwgaSkgPT4gYCAgJHtpICsgMX0uICR7Y21kfWApO1xuICAgIGNvbnN0IHZlcmlmeUNob2ljZSA9IGF3YWl0IHNob3dOZXh0QWN0aW9uKGN0eCwge1xuICAgICAgdGl0bGU6IFwiR1NEIFx1MjAxNCBWZXJpZmljYXRpb24gQ29tbWFuZHNcIixcbiAgICAgIHN1bW1hcnk6IFtcbiAgICAgICAgXCJBdXRvLWRldGVjdGVkIHZlcmlmaWNhdGlvbiBjb21tYW5kczpcIixcbiAgICAgICAgLi4udmVyaWZ5TGluZXMsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiR1NEIHJ1bnMgdGhlc2UgYWZ0ZXIgZWFjaCBjb2RlIGNoYW5nZSB0byB2ZXJpZnkgbm90aGluZyBpcyBicm9rZW4uXCIsXG4gICAgICBdLFxuICAgICAgYWN0aW9uczogW1xuICAgICAgICB7IGlkOiBcImFjY2VwdFwiLCBsYWJlbDogXCJVc2UgdGhlc2UgY29tbWFuZHNcIiwgZGVzY3JpcHRpb246IFwiQWNjZXB0IGF1dG8tZGV0ZWN0ZWQgY29tbWFuZHNcIiwgcmVjb21tZW5kZWQ6IHRydWUgfSxcbiAgICAgICAgeyBpZDogXCJza2lwXCIsIGxhYmVsOiBcIlNraXAgdmVyaWZpY2F0aW9uXCIsIGRlc2NyaXB0aW9uOiBcIkRvbid0IHZlcmlmeSBhZnRlciBjaGFuZ2VzXCIgfSxcbiAgICAgIF0sXG4gICAgICBub3RZZXRNZXNzYWdlOiBcIlJ1biAvZ3NkIGluaXQgd2hlbiByZWFkeS5cIixcbiAgICB9KTtcblxuICAgIGlmICh2ZXJpZnlDaG9pY2UgPT09IFwibm90X3lldFwiKSByZXR1cm4geyBjb21wbGV0ZWQ6IGZhbHNlLCBib290c3RyYXBwZWQ6IGZhbHNlIH07XG4gICAgaWYgKHZlcmlmeUNob2ljZSA9PT0gXCJza2lwXCIpIHByZWZzLnZlcmlmaWNhdGlvbkNvbW1hbmRzID0gW107XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgU3RlcCA1OiBHaXQgcHJlZmVyZW5jZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGNvbnN0IGdpdFN1bW1hcnk6IHN0cmluZ1tdID0gW107XG4gIGdpdFN1bW1hcnkucHVzaChgR2l0IGlzb2xhdGlvbjogd29ya3RyZWVgKTtcbiAgZ2l0U3VtbWFyeS5wdXNoKGBNYWluIGJyYW5jaDogJHtwcmVmcy5tYWluQnJhbmNofWApO1xuXG4gIGNvbnN0IGdpdENob2ljZSA9IGF3YWl0IHNob3dOZXh0QWN0aW9uKGN0eCwge1xuICAgIHRpdGxlOiBcIkdTRCBcdTIwMTQgR2l0IFNldHRpbmdzXCIsXG4gICAgc3VtbWFyeTogW1wiRGVmYXVsdCBnaXQgc2V0dGluZ3MgZm9yIHRoaXMgcHJvamVjdDpcIiwgLi4uZ2l0U3VtbWFyeV0sXG4gICAgYWN0aW9uczogW1xuICAgICAgeyBpZDogXCJhY2NlcHRcIiwgbGFiZWw6IFwiQWNjZXB0IGRlZmF1bHRzXCIsIGRlc2NyaXB0aW9uOiBcIlVzZSBzdGFuZGFyZCBnaXQgc2V0dGluZ3NcIiwgcmVjb21tZW5kZWQ6IHRydWUgfSxcbiAgICAgIHsgaWQ6IFwiY3VzdG9taXplXCIsIGxhYmVsOiBcIkN1c3RvbWl6ZVwiLCBkZXNjcmlwdGlvbjogXCJDaGFuZ2UgZ2l0IHNldHRpbmdzXCIgfSxcbiAgICBdLFxuICAgIG5vdFlldE1lc3NhZ2U6IFwiUnVuIC9nc2QgaW5pdCB3aGVuIHJlYWR5LlwiLFxuICB9KTtcblxuICBpZiAoZ2l0Q2hvaWNlID09PSBcIm5vdF95ZXRcIikgcmV0dXJuIHsgY29tcGxldGVkOiBmYWxzZSwgYm9vdHN0cmFwcGVkOiBmYWxzZSB9O1xuXG4gIGlmIChnaXRDaG9pY2UgPT09IFwiY3VzdG9taXplXCIpIHtcbiAgICBhd2FpdCBjdXN0b21pemVHaXRQcmVmcyhjdHgsIHByZWZzLCBzaWduYWxzKTtcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBTdGVwIDY6IEN1c3RvbSBpbnN0cnVjdGlvbnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGNvbnN0IGluc3RydWN0aW9uQ2hvaWNlID0gYXdhaXQgc2hvd05leHRBY3Rpb24oY3R4LCB7XG4gICAgdGl0bGU6IFwiR1NEIFx1MjAxNCBQcm9qZWN0IEluc3RydWN0aW9uc1wiLFxuICAgIHN1bW1hcnk6IFtcbiAgICAgIFwiQW55IHJ1bGVzIEdTRCBzaG91bGQgZm9sbG93IGZvciB0aGlzIHByb2plY3Q/XCIsXG4gICAgICBcIlwiLFxuICAgICAgXCJFeGFtcGxlczpcIixcbiAgICAgICcgIC0gXCJVc2UgVHlwZVNjcmlwdCBzdHJpY3QgbW9kZVwiJyxcbiAgICAgICcgIC0gXCJBbHdheXMgd3JpdGUgdGVzdHMgZm9yIG5ldyBjb2RlXCInLFxuICAgICAgJyAgLSBcIlRoaXMgaXMgYSBtb25vcmVwbywgb25seSB0b3VjaCBwYWNrYWdlcy9hcGlcIicsXG4gICAgICBcIlwiLFxuICAgICAgXCJZb3UgY2FuIGFsd2F5cyBhZGQgbW9yZSBsYXRlciB2aWEgL2dzZCBwcmVmcyBwcm9qZWN0LlwiLFxuICAgIF0sXG4gICAgYWN0aW9uczogW1xuICAgICAgeyBpZDogXCJza2lwXCIsIGxhYmVsOiBcIlNraXAgZm9yIG5vd1wiLCBkZXNjcmlwdGlvbjogXCJObyBzcGVjaWFsIGluc3RydWN0aW9uc1wiLCByZWNvbW1lbmRlZDogdHJ1ZSB9LFxuICAgICAgeyBpZDogXCJhZGRcIiwgbGFiZWw6IFwiQWRkIGluc3RydWN0aW9uc1wiLCBkZXNjcmlwdGlvbjogXCJFbnRlciBwcm9qZWN0LXNwZWNpZmljIHJ1bGVzXCIgfSxcbiAgICBdLFxuICAgIG5vdFlldE1lc3NhZ2U6IFwiUnVuIC9nc2QgaW5pdCB3aGVuIHJlYWR5LlwiLFxuICB9KTtcblxuICBpZiAoaW5zdHJ1Y3Rpb25DaG9pY2UgPT09IFwibm90X3lldFwiKSByZXR1cm4geyBjb21wbGV0ZWQ6IGZhbHNlLCBib290c3RyYXBwZWQ6IGZhbHNlIH07XG5cbiAgaWYgKGluc3RydWN0aW9uQ2hvaWNlID09PSBcImFkZFwiKSB7XG4gICAgY29uc3QgaW5wdXQgPSBhd2FpdCBjdHgudWkuaW5wdXQoXG4gICAgICBcIkVudGVyIGluc3RydWN0aW9ucyAob25lIHBlciBsaW5lLCBvciBjb21tYS1zZXBhcmF0ZWQpOlwiLFxuICAgICAgXCJlLmcuLCBVc2UgVGFpbHdpbmQgQ1NTLCBBbHdheXMgd3JpdGUgdGVzdHNcIixcbiAgICApO1xuICAgIGlmIChpbnB1dCAmJiBpbnB1dC50cmltKCkpIHtcbiAgICAgIC8vIFNwbGl0IG9uIG5ld2xpbmVzIG9yIGNvbW1hc1xuICAgICAgcHJlZnMuY3VzdG9tSW5zdHJ1Y3Rpb25zID0gaW5wdXRcbiAgICAgICAgLnNwbGl0KC9bLFxcbl0vKVxuICAgICAgICAubWFwKHMgPT4gcy50cmltKCkpXG4gICAgICAgIC5maWx0ZXIocyA9PiBzLmxlbmd0aCA+IDApO1xuICAgIH1cbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBTdGVwIDc6IEFkdmFuY2VkIChvcHRpb25hbCkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGNvbnN0IGFkdmFuY2VkQ2hvaWNlID0gYXdhaXQgc2hvd05leHRBY3Rpb24oY3R4LCB7XG4gICAgdGl0bGU6IFwiR1NEIFx1MjAxNCBBZHZhbmNlZCBTZXR0aW5nc1wiLFxuICAgIHN1bW1hcnk6IFtcbiAgICAgIGBUb2tlbiBwcm9maWxlOiAke3ByZWZzLnRva2VuUHJvZmlsZX1gLFxuICAgICAgYFNraXAgcmVzZWFyY2ggcGhhc2U6ICR7cHJlZnMuc2tpcFJlc2VhcmNoID8gXCJ5ZXNcIiA6IFwibm9cIn1gLFxuICAgICAgYEF1dG8tcHVzaCBvbiBtZXJnZTogJHtwcmVmcy5hdXRvUHVzaCA/IFwieWVzXCIgOiBcIm5vXCJ9YCxcbiAgICBdLFxuICAgIGFjdGlvbnM6IFtcbiAgICAgIHsgaWQ6IFwiYWNjZXB0XCIsIGxhYmVsOiBcIkFjY2VwdCBkZWZhdWx0c1wiLCBkZXNjcmlwdGlvbjogXCJVc2Ugc3RhbmRhcmQgc2V0dGluZ3NcIiwgcmVjb21tZW5kZWQ6IHRydWUgfSxcbiAgICAgIHsgaWQ6IFwiY3VzdG9taXplXCIsIGxhYmVsOiBcIkN1c3RvbWl6ZVwiLCBkZXNjcmlwdGlvbjogXCJDaGFuZ2UgYWR2YW5jZWQgc2V0dGluZ3NcIiB9LFxuICAgIF0sXG4gICAgbm90WWV0TWVzc2FnZTogXCJSdW4gL2dzZCBpbml0IHdoZW4gcmVhZHkuXCIsXG4gIH0pO1xuXG4gIGlmIChhZHZhbmNlZENob2ljZSA9PT0gXCJub3RfeWV0XCIpIHJldHVybiB7IGNvbXBsZXRlZDogZmFsc2UsIGJvb3RzdHJhcHBlZDogZmFsc2UgfTtcblxuICBpZiAoYWR2YW5jZWRDaG9pY2UgPT09IFwiY3VzdG9taXplXCIpIHtcbiAgICBhd2FpdCBjdXN0b21pemVBZHZhbmNlZFByZWZzKGN0eCwgcHJlZnMpO1xuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwIFN0ZXAgODogU2tpbGwgSW5zdGFsbGF0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICB0cnkge1xuICAgIGF3YWl0IHJ1blNraWxsSW5zdGFsbFN0ZXAoY3R4LCBzaWduYWxzKTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gTm9uLWZhdGFsIFx1MjAxNCBza2lsbCBpbnN0YWxsYXRpb24gZmFpbHVyZSBzaG91bGQgbmV2ZXIgYmxvY2sgcHJvamVjdCBpbml0XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgU3RlcCA5OiBPcHRpb25hbCBmdWxsLXByZWZzIHJldmlldyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgLy8gQXNrIEJFRk9SRSBib290c3RyYXBwaW5nIHNvIGEgZGVmZXIgKGBub3RfeWV0YCkgbGVhdmVzIHRoZSBwcm9qZWN0IHVudG91Y2hlZC5cbiAgLy8gT25jZSB0aGUgdXNlciBjb21taXRzLCB3ZSBib290c3RyYXAgYW5kIHJvdXRlIHByZWZlcmVuY2VzIHRocm91Z2ggdGhlIHVuaWZpZWRcbiAgLy8gd3JpdGVyIChjb21tYW5kcy1wcmVmcy13aXphcmQud3JpdGVQcmVmZXJlbmNlc0ZpbGUpIHNvIGluaXQgYW5kIHRoZSBwcmVmc1xuICAvLyB3aXphcmQgc2hhcmUgb25lIHNlcmlhbGl6ZXIuIFRoZSBcIk9wZW4gZnVsbCB3aXphcmRcIiBicmFuY2ggc3VyZmFjZXMgZXZlcnlcbiAgLy8gY29uZmlndXJhYmxlIHByZWZlcmVuY2UsIHByZWZpbGxlZCB3aXRoIHRoZSBpbml0IGFuc3dlcnMuXG4gIGNvbnN0IHJldmlld0Nob2ljZSA9IGF3YWl0IHNob3dOZXh0QWN0aW9uKGN0eCwge1xuICAgIHRpdGxlOiBcIkdTRCBcdTIwMTQgUmV2aWV3IEFsbCBQcmVmZXJlbmNlcyAoT3B0aW9uYWwpXCIsXG4gICAgc3VtbWFyeTogW1xuICAgICAgXCJPcGVuIHRoZSBmdWxsIHByZWZlcmVuY2VzIHdpemFyZCBub3c/IEl0IGluY2x1ZGVzIG1vZGVscywgdGltZW91dHMsXCIsXG4gICAgICBcImJ1ZGdldCwgbm90aWZpY2F0aW9ucywgYW5kIHNraWxscyBcdTIwMTQgYWxsIHByZS1maWxsZWQgd2l0aCB5b3VyIGFuc3dlcnMuXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCJTa2lwIGlmIHlvdSBqdXN0IHdhbnQgc2Vuc2libGUgZGVmYXVsdHM7IHlvdSBjYW4gYWx3YXlzIHJ1biAvZ3NkIHByZWZzIHByb2plY3QgbGF0ZXIuXCIsXG4gICAgXSxcbiAgICBhY3Rpb25zOiBbXG4gICAgICB7IGlkOiBcInNraXBcIiwgbGFiZWw6IFwiU2tpcCBcdTIwMTQgdXNlIGRlZmF1bHRzXCIsIGRlc2NyaXB0aW9uOiBcIlNhdmUgcHJlZmVyZW5jZXMgYW5kIGNvbnRpbnVlXCIsIHJlY29tbWVuZGVkOiB0cnVlIH0sXG4gICAgICB7IGlkOiBcInJldmlld1wiLCBsYWJlbDogXCJPcGVuIGZ1bGwgd2l6YXJkXCIsIGRlc2NyaXB0aW9uOiBcIlR3ZWFrIGFueSBjYXRlZ29yeSBiZWZvcmUgc2F2aW5nXCIgfSxcbiAgICBdLFxuICAgIG5vdFlldE1lc3NhZ2U6IFwiUnVuIC9nc2QgaW5pdCB3aGVuIHJlYWR5LlwiLFxuICB9KTtcblxuICBpZiAocmV2aWV3Q2hvaWNlID09PSBcIm5vdF95ZXRcIikge1xuICAgIC8vIFVzZXIgZGVmZXJyZWQgXHUyMDE0IGRvbid0IGNyZWF0ZSAuZ3NkLyBvciBwZXJzaXN0IHByZWZlcmVuY2VzLiBQcmUtc3RlcCBzdGF0ZVxuICAgIC8vIChlLmcuIGdpdCBpbml0IGZyb20gU3RlcCAyKSByZW1haW5zIGFzLWlzLCBtYXRjaGluZyBwcmlvciBzdGVwIHNlbWFudGljcy5cbiAgICByZXR1cm4geyBjb21wbGV0ZWQ6IGZhbHNlLCBib290c3RyYXBwZWQ6IGZhbHNlIH07XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgU3RlcCAxMDogQm9vdHN0cmFwIC5nc2QvICsgd3JpdGUgcHJlZmVyZW5jZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGJvb3RzdHJhcEdzZERpcmVjdG9yeVN0cnVjdHVyZShiYXNlUGF0aCwgc2lnbmFscyk7XG4gIGNvbnN0IHByZWZpbGxQcmVmcyA9IG1hcEluaXRQcmVmc1RvV2l6YXJkU2hhcGUocHJlZnMpO1xuICAvLyBBbHdheXMgZGVyaXZlIHRoZSBwcmVmZXJlbmNlcyBwYXRoIGZyb20gYmFzZVBhdGggc28gaW5pdCB3cml0aW5nIHRoZVxuICAvLyBzdHJ1Y3R1cmUgdG8gb25lIGxvY2F0aW9uIGFuZCBwcmVmZXJlbmNlcyB0byBhbm90aGVyIChjd2QtZGVyaXZlZCkgaXNcbiAgLy8gaW1wb3NzaWJsZSBcdTIwMTQgc2VlICM0NDU3IGNvZGV4IHJldmlldy5cbiAgY29uc3QgcHJvamVjdFByZWZzUGF0aCA9IGpvaW4oZ3NkUm9vdChiYXNlUGF0aCksIFwiUFJFRkVSRU5DRVMubWRcIik7XG5cbiAgaWYgKHJldmlld0Nob2ljZSA9PT0gXCJyZXZpZXdcIikge1xuICAgIC8vIFdpemFyZCB3cml0ZXMgdmlhIHdyaXRlUHJlZmVyZW5jZXNGaWxlIGludGVybmFsbHk7IHBhc3MgcGF0aE92ZXJyaWRlIHNvIGl0XG4gICAgLy8gdGFyZ2V0cyBiYXNlUGF0aCByYXRoZXIgdGhhbiBjd2QuXG4gICAgYXdhaXQgaGFuZGxlUHJlZnNXaXphcmQoY3R4LCBcInByb2plY3RcIiwgcHJlZmlsbFByZWZzLCB7IHBhdGhPdmVycmlkZTogcHJvamVjdFByZWZzUGF0aCB9KTtcbiAgfSBlbHNlIHtcbiAgICAvLyBEaXJlY3QgcGF0aDogd3JpdGUgdGhlIGluaXQtY29sbGVjdGVkIHByZWZzIHRocm91Z2ggdGhlIHVuaWZpZWQgd3JpdGVyLlxuICAgIGF3YWl0IHdyaXRlUHJlZmVyZW5jZXNGaWxlKHByb2plY3RQcmVmc1BhdGgsIHByZWZpbGxQcmVmcywgY3R4LCB7XG4gICAgICBzY29wZTogXCJwcm9qZWN0XCIsXG4gICAgICBkZWZhdWx0Qm9keTogYnVpbGRJbml0UHJlZmVyZW5jZXNCb2R5KCksXG4gICAgICBub3RpZnlPblNhdmU6IGZhbHNlLFxuICAgIH0pO1xuICB9XG5cbiAgLy8gSW5pdGlhbGl6ZSBTUUxpdGUgZGF0YWJhc2Ugc28gR1NEIHN0YXJ0cyBpbiBmdWxsLWNhcGFiaWxpdHkgbW9kZSAoIzM4ODApLlxuICAvLyBXaXRob3V0IHRoaXMsIGlzRGJBdmFpbGFibGUoKSByZXR1cm5zIGZhbHNlIGFuZCBHU0QgZW50ZXJzIGRlZ3JhZGVkXG4gIC8vIG1hcmtkb3duLW9ubHkgbW9kZSB1bnRpbCBhIHRvb2wgaGFuZGxlciBoYXBwZW5zIHRvIGNhbGwgZW5zdXJlRGJPcGVuKCkuXG4gIHRyeSB7XG4gICAgY29uc3QgeyBlbnN1cmVEYk9wZW4gfSA9IGF3YWl0IGltcG9ydChcIi4vYm9vdHN0cmFwL2R5bmFtaWMtdG9vbHMuanNcIik7XG4gICAgYXdhaXQgZW5zdXJlRGJPcGVuKGJhc2VQYXRoKTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gTm9uLWZhdGFsIFx1MjAxNCBEQiBjcmVhdGlvbiBmYWlsdXJlIHNob3VsZCBub3QgYmxvY2sgcHJvamVjdCBpbml0XG4gIH1cblxuICAvLyBFbnN1cmUgLmdpdGlnbm9yZSBvbmx5IHdoZW4gZ2l0IGlzIGFjdGl2ZS4gQSB1c2VyIHdobyBzZWxlY3RlZCBcIlNraXBcIlxuICAvLyBzaG91bGQgbm90IGhhdmUgZ2l0IGluaXRpYWxpemVkIG9yIGdpdC1yZWxhdGVkIGZpbGVzIG11dGF0ZWQgbGF0ZXIuXG4gIGlmIChzaG91bGRXcml0ZUdpdEZpbGVzKGdpdEVuYWJsZWQpKSB7XG4gICAgZW5zdXJlR2l0aWdub3JlKGJhc2VQYXRoKTtcbiAgICB1bnRyYWNrUnVudGltZUZpbGVzKGJhc2VQYXRoKTtcbiAgfVxuXG4gIC8vIENyZWF0ZSBpbml0aWFsIGNvbW1pdCBzbyBnaXQgbG9nIGFuZCBnaXQgd29ya3RyZWUgd29yayBpbW1lZGlhdGVseSAoIzQ1MzApLlxuICAvLyBXaXRob3V0IHRoaXMsIHRoZSBicmFuY2ggaXMgXCJ1bmJvcm5cIiAoemVybyBjb21taXRzKSBhbmQgZG93bnN0cmVhbSBvcGVyYXRpb25zXG4gIC8vIGxpa2UgYGdpdCBsb2dgIGFuZCBgZ2l0IHdvcmt0cmVlIGFkZGAgZmFpbC5cbiAgaWYgKGRpZEluaXRHaXQpIHtcbiAgICB0cnkge1xuICAgICAgbmF0aXZlQWRkQWxsKGJhc2VQYXRoKTtcbiAgICAgIG5hdGl2ZUNvbW1pdChiYXNlUGF0aCwgXCJjaG9yZTogaW5pdCBwcm9qZWN0XCIpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gTm9uLWZhdGFsIFx1MjAxNCB1c2VyIGNhbiBjb21taXQgbWFudWFsbHk7IGRvbid0IGJsb2NrIHByb2plY3QgaW5pdFxuICAgIH1cbiAgfVxuXG4gIC8vIEF1dG8tZ2VuZXJhdGUgY29kZWJhc2UgbWFwIGZvciBpbnN0YW50IGFnZW50IG9yaWVudGF0aW9uXG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0ID0gZ2VuZXJhdGVDb2RlYmFzZU1hcChiYXNlUGF0aCk7XG4gICAgaWYgKHJlc3VsdC5maWxlQ291bnQgPiAwKSB7XG4gICAgICB3cml0ZUNvZGViYXNlTWFwKGJhc2VQYXRoLCByZXN1bHQuY29udGVudCk7XG4gICAgICBjdHgudWkubm90aWZ5KGBDb2RlYmFzZSBtYXAgZ2VuZXJhdGVkOiAke3Jlc3VsdC5maWxlQ291bnR9IGZpbGVzYCwgXCJpbmZvXCIpO1xuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gTm9uLWZhdGFsIFx1MjAxNCBjb2RlYmFzZSBtYXAgZ2VuZXJhdGlvbiBmYWlsdXJlIHNob3VsZCBuZXZlciBibG9jayBwcm9qZWN0IGluaXRcbiAgfVxuXG4gIC8vIFdyaXRlIGluaXRpYWwgU1RBVEUubWQgc28gaXQgZXhpc3RzIGJlZm9yZSB0aGUgZmlyc3QgL2dzZCBpbnZvY2F0aW9uLlxuICAvLyBUaGUgZXhwbGljaXQgL2dzZCBpbml0IHBhdGggKG9wcy50cykgcmV0dXJucyB3aXRob3V0IGVudGVyaW5nIHNob3dTbWFydEVudHJ5KCksXG4gIC8vIHdoaWNoIHdvdWxkIG90aGVyd2lzZSBnZW5lcmF0ZSBTVEFURS5tZCBhdCBndWlkZWQtZmxvdy50czoxMzU4LlxuICB0cnkge1xuICAgIGNvbnN0IHsgZGVyaXZlU3RhdGUgfSA9IGF3YWl0IGltcG9ydChcIi4vc3RhdGUuanNcIik7XG4gICAgY29uc3QgeyBidWlsZFN0YXRlTWFya2Rvd24gfSA9IGF3YWl0IGltcG9ydChcIi4vZG9jdG9yLmpzXCIpO1xuICAgIGNvbnN0IHsgc2F2ZUZpbGUgfSA9IGF3YWl0IGltcG9ydChcIi4vZmlsZXMuanNcIik7XG4gICAgY29uc3QgeyByZXNvbHZlR3NkUm9vdEZpbGUgfSA9IGF3YWl0IGltcG9ydChcIi4vcGF0aHMuanNcIik7XG4gICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlUGF0aCk7XG4gICAgYXdhaXQgc2F2ZUZpbGUocmVzb2x2ZUdzZFJvb3RGaWxlKGJhc2VQYXRoLCBcIlNUQVRFXCIpLCBidWlsZFN0YXRlTWFya2Rvd24oc3RhdGUpKTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gTm9uLWZhdGFsIFx1MjAxNCBTVEFURS5tZCB3aWxsIGJlIHJlZ2VuZXJhdGVkIG9uIG5leHQgL2dzZCBpbnZvY2F0aW9uXG4gIH1cblxuICB7XG4gICAgY29uc3QgeyBwcmVwYXJlV29ya2Zsb3dNY3BGb3JQcm9qZWN0IH0gPSBhd2FpdCBpbXBvcnQoXCIuL3dvcmtmbG93LW1jcC1hdXRvLXByZXAuanNcIik7XG4gICAgcHJlcGFyZVdvcmtmbG93TWNwRm9yUHJvamVjdChjdHgsIGJhc2VQYXRoKTtcbiAgfVxuXG4gIGN0eC51aS5ub3RpZnkoXCJHU0QgaW5pdGlhbGl6ZWQuIFN0YXJ0aW5nIHlvdXIgZmlyc3QgbWlsZXN0b25lLi4uXCIsIFwiaW5mb1wiKTtcblxuICByZXR1cm4geyBjb21wbGV0ZWQ6IHRydWUsIGJvb3RzdHJhcHBlZDogdHJ1ZSwgZ2l0RW5hYmxlZCB9O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVjEgTWlncmF0aW9uIE9mZmVyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFNob3cgbWlncmF0aW9uIG9mZmVyIHdoZW4gLnBsYW5uaW5nLyBpcyBkZXRlY3RlZC5cbiAqIFJldHVybnMgJ21pZ3JhdGUnLCAnZnJlc2gnLCBvciAnY2FuY2VsJy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG9mZmVyTWlncmF0aW9uKFxuICBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LFxuICB2MTogTm9uTnVsbGFibGU8UHJvamVjdERldGVjdGlvbltcInYxXCJdPixcbik6IFByb21pc2U8XCJtaWdyYXRlXCIgfCBcImZyZXNoXCIgfCBcImNhbmNlbFwiPiB7XG4gIGNvbnN0IHN1bW1hcnkgPSBbXG4gICAgXCJGb3VuZCAucGxhbm5pbmcvIGRpcmVjdG9yeSAoR1NEIHYxIGZvcm1hdClcIixcbiAgXTtcbiAgaWYgKHYxLnBoYXNlQ291bnQgPiAwKSB7XG4gICAgc3VtbWFyeS5wdXNoKGAke3YxLnBoYXNlQ291bnR9IHBoYXNlJHt2MS5waGFzZUNvdW50ID4gMSA/IFwic1wiIDogXCJcIn0gZGV0ZWN0ZWRgKTtcbiAgfVxuICBpZiAodjEuaGFzUm9hZG1hcCkge1xuICAgIHN1bW1hcnkucHVzaChcIkhhcyBST0FETUFQLm1kXCIpO1xuICB9XG5cbiAgY29uc3QgY2hvaWNlID0gYXdhaXQgc2hvd05leHRBY3Rpb24oY3R4LCB7XG4gICAgdGl0bGU6IFwiR1NEIFx1MjAxNCBMZWdhY3kgUHJvamVjdCBEZXRlY3RlZFwiLFxuICAgIHN1bW1hcnksXG4gICAgYWN0aW9uczogW1xuICAgICAge1xuICAgICAgICBpZDogXCJtaWdyYXRlXCIsXG4gICAgICAgIGxhYmVsOiBcIk1pZ3JhdGUgdG8gR1NEIHYyXCIsXG4gICAgICAgIGRlc2NyaXB0aW9uOiBcIkNvbnZlcnQgLnBsYW5uaW5nLyB0byAuZ3NkLyBmb3JtYXRcIixcbiAgICAgICAgcmVjb21tZW5kZWQ6IHRydWUsXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBpZDogXCJmcmVzaFwiLFxuICAgICAgICBsYWJlbDogXCJTdGFydCBmcmVzaFwiLFxuICAgICAgICBkZXNjcmlwdGlvbjogXCJJZ25vcmUgLnBsYW5uaW5nLyBhbmQgY3JlYXRlIG5ldyAuZ3NkL1wiLFxuICAgICAgfSxcbiAgICBdLFxuICAgIG5vdFlldE1lc3NhZ2U6IFwiUnVuIC9nc2QgaW5pdCB3aGVuIHJlYWR5LlwiLFxuICB9KTtcblxuICBpZiAoY2hvaWNlID09PSBcIm5vdF95ZXRcIikgcmV0dXJuIFwiY2FuY2VsXCI7XG4gIHJldHVybiBjaG9pY2UgYXMgXCJtaWdyYXRlXCIgfCBcImZyZXNoXCI7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBSZS1pbml0IEhhbmRsZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogSGFuZGxlIC9nc2QgaW5pdCB3aGVuIC5nc2QvIGFscmVhZHkgZXhpc3RzLlxuICogT2ZmZXJzIHByZWZlcmVuY2UgcmVzZXQgd2l0aG91dCBkZXN0cnVjdGl2ZSBtaWxlc3RvbmUgZGVsZXRpb24uXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBoYW5kbGVSZWluaXQoXG4gIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsXG4gIGRldGVjdGlvbjogUHJvamVjdERldGVjdGlvbixcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBzdW1tYXJ5ID0gW1wiR1NEIGlzIGFscmVhZHkgaW5pdGlhbGl6ZWQgaW4gdGhpcyBwcm9qZWN0LlwiXTtcbiAgaWYgKGRldGVjdGlvbi52Mikge1xuICAgIHN1bW1hcnkucHVzaChgJHtkZXRlY3Rpb24udjIubWlsZXN0b25lQ291bnR9IG1pbGVzdG9uZShzKSBmb3VuZGApO1xuICAgIHN1bW1hcnkucHVzaChgUHJlZmVyZW5jZXM6ICR7ZGV0ZWN0aW9uLnYyLmhhc1ByZWZlcmVuY2VzID8gXCJjb25maWd1cmVkXCIgOiBcIm5vdCBzZXRcIn1gKTtcbiAgfVxuXG4gIGNvbnN0IGNob2ljZSA9IGF3YWl0IHNob3dOZXh0QWN0aW9uKGN0eCwge1xuICAgIHRpdGxlOiBcIkdTRCBcdTIwMTQgQWxyZWFkeSBJbml0aWFsaXplZFwiLFxuICAgIHN1bW1hcnksXG4gICAgYWN0aW9uczogW1xuICAgICAge1xuICAgICAgICBpZDogXCJwcmVmc1wiLFxuICAgICAgICBsYWJlbDogXCJSZS1jb25maWd1cmUgcHJlZmVyZW5jZXNcIixcbiAgICAgICAgZGVzY3JpcHRpb246IFwiVXBkYXRlIHByb2plY3QgcHJlZmVyZW5jZXMgd2l0aG91dCBhZmZlY3RpbmcgbWlsZXN0b25lc1wiLFxuICAgICAgICByZWNvbW1lbmRlZDogdHJ1ZSxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIGlkOiBcImNhbmNlbFwiLFxuICAgICAgICBsYWJlbDogXCJDYW5jZWxcIixcbiAgICAgICAgZGVzY3JpcHRpb246IFwiS2VlcCBldmVyeXRoaW5nIGFzLWlzXCIsXG4gICAgICB9LFxuICAgIF0sXG4gICAgbm90WWV0TWVzc2FnZTogXCJSdW4gL2dzZCBpbml0IHdoZW4gcmVhZHkuXCIsXG4gIH0pO1xuXG4gIGlmIChjaG9pY2UgPT09IFwicHJlZnNcIikge1xuICAgIGN0eC51aS5ub3RpZnkoXCJVc2UgL2dzZCBwcmVmcyBwcm9qZWN0IHRvIHVwZGF0ZSBwcm9qZWN0IHByZWZlcmVuY2VzLlwiLCBcImluZm9cIik7XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEdpdCBQcmVmZXJlbmNlcyBDdXN0b21pemF0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5hc3luYyBmdW5jdGlvbiBjdXN0b21pemVHaXRQcmVmcyhcbiAgY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCxcbiAgcHJlZnM6IFByb2plY3RQcmVmZXJlbmNlcyxcbiAgc2lnbmFsczogUHJvamVjdFNpZ25hbHMsXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgLy8gSXNvbGF0aW9uIHN0cmF0ZWd5XG4gIGNvbnN0IGhhc1N1Ym1vZHVsZXMgPSBleGlzdHNTeW5jKGpvaW4ocHJvY2Vzcy5jd2QoKSwgXCIuZ2l0bW9kdWxlc1wiKSk7XG4gIGNvbnN0IGlzb2xhdGlvbkFjdGlvbnMgPSBbXG4gICAgeyBpZDogXCJ3b3JrdHJlZVwiLCBsYWJlbDogXCJXb3JrdHJlZVwiLCBkZXNjcmlwdGlvbjogXCJJc29sYXRlZCBnaXQgd29ya3RyZWUgcGVyIG1pbGVzdG9uZSAocmVjb21tZW5kZWQpXCIsIHJlY29tbWVuZGVkOiAhaGFzU3VibW9kdWxlcyB9LFxuICAgIHsgaWQ6IFwiYnJhbmNoXCIsIGxhYmVsOiBcIkJyYW5jaFwiLCBkZXNjcmlwdGlvbjogXCJXb3JrIG9uIGJyYW5jaGVzIGluIHByb2plY3Qgcm9vdCAoYmV0dGVyIGZvciBzdWJtb2R1bGVzKVwiLCByZWNvbW1lbmRlZDogaGFzU3VibW9kdWxlcyB9LFxuICAgIHsgaWQ6IFwibm9uZVwiLCBsYWJlbDogXCJOb25lXCIsIGRlc2NyaXB0aW9uOiBcIk5vIGlzb2xhdGlvbiBcdTIwMTQgY29tbWl0cyBvbiBjdXJyZW50IGJyYW5jaFwiIH0sXG4gIF07XG5cbiAgY29uc3QgaXNvbGF0aW9uU3VtbWFyeSA9IGhhc1N1Ym1vZHVsZXNcbiAgICA/IFtcIlN1Ym1vZHVsZXMgZGV0ZWN0ZWQgXHUyMDE0IGJyYW5jaCBtb2RlIHJlY29tbWVuZGVkIG92ZXIgd29ya3RyZWUuXCJdXG4gICAgOiBbXCJXb3JrdHJlZSBpc29sYXRpb24gY3JlYXRlcyBhIHNlcGFyYXRlIGNvcHkgZm9yIGVhY2ggbWlsZXN0b25lLlwiXTtcblxuICBjb25zdCBpc29sYXRpb25DaG9pY2UgPSBhd2FpdCBzaG93TmV4dEFjdGlvbihjdHgsIHtcbiAgICB0aXRsZTogXCJHaXQgaXNvbGF0aW9uIHN0cmF0ZWd5XCIsXG4gICAgc3VtbWFyeTogaXNvbGF0aW9uU3VtbWFyeSxcbiAgICBhY3Rpb25zOiBpc29sYXRpb25BY3Rpb25zLFxuICB9KTtcbiAgaWYgKGlzb2xhdGlvbkNob2ljZSAhPT0gXCJub3RfeWV0XCIpIHtcbiAgICBwcmVmcy5naXRJc29sYXRpb24gPSBpc29sYXRpb25DaG9pY2UgYXMgXCJ3b3JrdHJlZVwiIHwgXCJicmFuY2hcIiB8IFwibm9uZVwiO1xuICB9XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBBZHZhbmNlZCBQcmVmZXJlbmNlcyBDdXN0b21pemF0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5hc3luYyBmdW5jdGlvbiBjdXN0b21pemVBZHZhbmNlZFByZWZzKFxuICBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LFxuICBwcmVmczogUHJvamVjdFByZWZlcmVuY2VzLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIC8vIFRva2VuIHByb2ZpbGVcbiAgY29uc3QgcHJvZmlsZUNob2ljZSA9IGF3YWl0IHNob3dOZXh0QWN0aW9uKGN0eCwge1xuICAgIHRpdGxlOiBcIlRva2VuIHVzYWdlIHByb2ZpbGVcIixcbiAgICBzdW1tYXJ5OiBbXG4gICAgICBcIkNvbnRyb2xzIGhvdyBtdWNoIGNvbnRleHQgR1NEIHVzZXMgcGVyIHRhc2suXCIsXG4gICAgICBcIkJ1ZGdldDogY2hlYXBlciwgZmFzdGVyLiBRdWFsaXR5OiB0aG9yb3VnaCwgbW9yZSBleHBlbnNpdmUuXCIsXG4gICAgXSxcbiAgICBhY3Rpb25zOiBbXG4gICAgICB7IGlkOiBcImJhbGFuY2VkXCIsIGxhYmVsOiBcIkJhbGFuY2VkXCIsIGRlc2NyaXB0aW9uOiBcIkdvb2QgdHJhZGUtb2ZmIChkZWZhdWx0KVwiLCByZWNvbW1lbmRlZDogdHJ1ZSB9LFxuICAgICAgeyBpZDogXCJidWRnZXRcIiwgbGFiZWw6IFwiQnVkZ2V0XCIsIGRlc2NyaXB0aW9uOiBcIk1pbmltaXplIHRva2VuIHVzYWdlXCIgfSxcbiAgICAgIHsgaWQ6IFwicXVhbGl0eVwiLCBsYWJlbDogXCJRdWFsaXR5XCIsIGRlc2NyaXB0aW9uOiBcIk1heGltaXplIHRob3JvdWdobmVzc1wiIH0sXG4gICAgICB7IGlkOiBcImJ1cm4tbWF4XCIsIGxhYmVsOiBcIkJ1cm4gTWF4XCIsIGRlc2NyaXB0aW9uOiBcIk1heGltdW0gZGVwdGgsIG5vIHBoYXNlIHNraXBzXCIgfSxcbiAgICBdLFxuICB9KTtcbiAgaWYgKHByb2ZpbGVDaG9pY2UgIT09IFwibm90X3lldFwiKSB7XG4gICAgcHJlZnMudG9rZW5Qcm9maWxlID0gcHJvZmlsZUNob2ljZSBhcyBcImJ1ZGdldFwiIHwgXCJiYWxhbmNlZFwiIHwgXCJxdWFsaXR5XCIgfCBcImJ1cm4tbWF4XCI7XG4gIH1cblxuICAvLyBTa2lwIHJlc2VhcmNoXG4gIGNvbnN0IHJlc2VhcmNoQ2hvaWNlID0gYXdhaXQgc2hvd05leHRBY3Rpb24oY3R4LCB7XG4gICAgdGl0bGU6IFwiUmVzZWFyY2ggcGhhc2VcIixcbiAgICBzdW1tYXJ5OiBbXG4gICAgICBcIkdTRCBjYW4gcmVzZWFyY2ggdGhlIGNvZGViYXNlIGJlZm9yZSBwbGFubmluZyBlYWNoIG1pbGVzdG9uZS5cIixcbiAgICAgIFwiU21hbGwgcHJvamVjdHMgbWF5IG5vdCBuZWVkIHRoaXMgc3RlcC5cIixcbiAgICBdLFxuICAgIGFjdGlvbnM6IFtcbiAgICAgIHsgaWQ6IFwia2VlcFwiLCBsYWJlbDogXCJLZWVwIHJlc2VhcmNoXCIsIGRlc2NyaXB0aW9uOiBcIkV4cGxvcmUgY29kZWJhc2UgYmVmb3JlIHBsYW5uaW5nXCIsIHJlY29tbWVuZGVkOiB0cnVlIH0sXG4gICAgICB7IGlkOiBcInNraXBcIiwgbGFiZWw6IFwiU2tpcCByZXNlYXJjaFwiLCBkZXNjcmlwdGlvbjogXCJHbyBzdHJhaWdodCB0byBwbGFubmluZ1wiIH0sXG4gICAgXSxcbiAgfSk7XG4gIHByZWZzLnNraXBSZXNlYXJjaCA9IHJlc2VhcmNoQ2hvaWNlID09PSBcInNraXBcIjtcblxuICAvLyBBdXRvLXB1c2hcbiAgY29uc3QgcHVzaENob2ljZSA9IGF3YWl0IHNob3dOZXh0QWN0aW9uKGN0eCwge1xuICAgIHRpdGxlOiBcIkF1dG8tcHVzaCBhZnRlciBtZXJnZVwiLFxuICAgIHN1bW1hcnk6IFtcbiAgICAgIFwiQWZ0ZXIgbWVyZ2luZyBhIG1pbGVzdG9uZSBicmFuY2gsIGF1dG8tcHVzaCB0byByZW1vdGU/XCIsXG4gICAgICBwcmVmcy5tb2RlID09PSBcInRlYW1cIlxuICAgICAgICA/IFwiVGVhbSBtb2RlOiB1c3VhbGx5IGRpc2FibGVkIHNvIGNoYW5nZXMgZ28gdGhyb3VnaCBQUiByZXZpZXcuXCJcbiAgICAgICAgOiBcIlNvbG8gbW9kZTogdXN1YWxseSBlbmFibGVkIGZvciBjb252ZW5pZW5jZS5cIixcbiAgICBdLFxuICAgIGFjdGlvbnM6IFtcbiAgICAgIHsgaWQ6IFwieWVzXCIsIGxhYmVsOiBcIlllc1wiLCBkZXNjcmlwdGlvbjogXCJQdXNoIGF1dG9tYXRpY2FsbHlcIiwgcmVjb21tZW5kZWQ6IHByZWZzLm1vZGUgPT09IFwic29sb1wiIH0sXG4gICAgICB7IGlkOiBcIm5vXCIsIGxhYmVsOiBcIk5vXCIsIGRlc2NyaXB0aW9uOiBcIk1hbnVhbCBwdXNoIG9ubHlcIiwgcmVjb21tZW5kZWQ6IHByZWZzLm1vZGUgPT09IFwidGVhbVwiIH0sXG4gICAgXSxcbiAgfSk7XG4gIHByZWZzLmF1dG9QdXNoID0gcHVzaENob2ljZSAhPT0gXCJub1wiO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQm9vdHN0cmFwIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIENyZWF0ZSAuZ3NkLyBkaXJlY3Rvcnkgc3RydWN0dXJlIGFuZCBzZWVkIENPTlRFWFQubWQuXG4gKlxuICogUHJlZmVyZW5jZXMgYXJlIHdyaXR0ZW4gc2VwYXJhdGVseSBieSB0aGUgY2FsbGVyIHZpYSB0aGUgdW5pZmllZFxuICogd3JpdGVQcmVmZXJlbmNlc0ZpbGUgaGVscGVyIHNvIGluaXQgYW5kIHRoZSBwcmVmcyB3aXphcmQgc2hhcmUgb25lIHBhdGguXG4gKi9cbmZ1bmN0aW9uIGJvb3RzdHJhcEdzZERpcmVjdG9yeVN0cnVjdHVyZShiYXNlUGF0aDogc3RyaW5nLCBzaWduYWxzOiBQcm9qZWN0U2lnbmFscyk6IHZvaWQge1xuICAvLyBGaW5hbCBzYWZldHkgY2hlY2sgYmVmb3JlIHdyaXRpbmcgYW55IGZpbGVzXG4gIGFzc2VydFNhZmVEaXJlY3RvcnkoYmFzZVBhdGgpO1xuXG4gIGNvbnN0IGdzZCA9IGdzZFJvb3QoYmFzZVBhdGgpO1xuICBta2RpclN5bmMoam9pbihnc2QsIFwibWlsZXN0b25lc1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIG1rZGlyU3luYyhqb2luKGdzZCwgXCJydW50aW1lXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAvLyBTZWVkIENPTlRFWFQubWQgd2l0aCBkZXRlY3RlZCBwcm9qZWN0IHNpZ25hbHNcbiAgY29uc3QgY29udGV4dENvbnRlbnQgPSBidWlsZENvbnRleHRTZWVkKHNpZ25hbHMpO1xuICBpZiAoY29udGV4dENvbnRlbnQpIHtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZ3NkLCBcIkNPTlRFWFQubWRcIiksIGNvbnRleHRDb250ZW50LCBcInV0Zi04XCIpO1xuICB9XG59XG5cbi8qKlxuICogTWFwIGluaXQgd2l6YXJkJ3MgdHlwZWQgUHJvamVjdFByZWZlcmVuY2VzIHRvIHRoZSBwcmVmcy13aXphcmQnc1xuICogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gc2hhcGUsIG1hdGNoaW5nIHRoZSBrZXlzIHNlcmlhbGl6ZVByZWZlcmVuY2VzVG9Gcm9udG1hdHRlclxuICogZXhwZWN0cyAobW9kZSwgZ2l0Lntpc29sYXRpb24sbWFpbl9icmFuY2gsYXV0b19wdXNofSwgdmVyaWZpY2F0aW9uX2NvbW1hbmRzLCBldGMuKS5cbiAqXG4gKiBFeHBvcnRlZCBmb3IgdGVzdGluZzsgaW5pdC13aXphcmQgdXNlcyBpdCBpbmxpbmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtYXBJbml0UHJlZnNUb1dpemFyZFNoYXBlKHByZWZzOiBQcm9qZWN0UHJlZmVyZW5jZXMpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gIGNvbnN0IG91dDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgbW9kZTogcHJlZnMubW9kZSxcbiAgICBnaXQ6IHtcbiAgICAgIGlzb2xhdGlvbjogcHJlZnMuZ2l0SXNvbGF0aW9uLFxuICAgICAgbWFpbl9icmFuY2g6IHByZWZzLm1haW5CcmFuY2gsXG4gICAgICBhdXRvX3B1c2g6IHByZWZzLmF1dG9QdXNoLFxuICAgIH0sXG4gIH07XG5cbiAgaWYgKHByZWZzLnZlcmlmaWNhdGlvbkNvbW1hbmRzLmxlbmd0aCA+IDApIHtcbiAgICBvdXQudmVyaWZpY2F0aW9uX2NvbW1hbmRzID0gcHJlZnMudmVyaWZpY2F0aW9uQ29tbWFuZHM7XG4gIH1cbiAgaWYgKHByZWZzLmN1c3RvbUluc3RydWN0aW9ucy5sZW5ndGggPiAwKSB7XG4gICAgb3V0LmN1c3RvbV9pbnN0cnVjdGlvbnMgPSBwcmVmcy5jdXN0b21JbnN0cnVjdGlvbnM7XG4gIH1cbiAgaWYgKHByZWZzLnRva2VuUHJvZmlsZSAhPT0gXCJiYWxhbmNlZFwiKSB7XG4gICAgb3V0LnRva2VuX3Byb2ZpbGUgPSBwcmVmcy50b2tlblByb2ZpbGU7XG4gIH1cbiAgaWYgKHByZWZzLnNraXBSZXNlYXJjaCkge1xuICAgIG91dC5waGFzZXMgPSB7IHNraXBfcmVzZWFyY2g6IHRydWUgfTtcbiAgfVxuXG4gIHJldHVybiBvdXQ7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkSW5pdFByZWZlcmVuY2VzQm9keSgpOiBzdHJpbmcge1xuICByZXR1cm4gW1xuICAgIFwiXCIsXG4gICAgXCIjIEdTRCBQcm9qZWN0IFByZWZlcmVuY2VzXCIsXG4gICAgXCJcIixcbiAgICBcIkdlbmVyYXRlZCBieSBgL2dzZCBpbml0YC4gRWRpdCBkaXJlY3RseSBvciB1c2UgYC9nc2QgcHJlZnMgcHJvamVjdGAgdG8gbW9kaWZ5LlwiLFxuICAgIFwiXCIsXG4gICAgXCJTZWUgYH4vLmdzZC9hZ2VudC9leHRlbnNpb25zL2dzZC9kb2NzL3ByZWZlcmVuY2VzLXJlZmVyZW5jZS5tZGAgZm9yIGZ1bGwgZmllbGQgZG9jdW1lbnRhdGlvbi5cIixcbiAgICBcIlwiLFxuICBdLmpvaW4oXCJcXG5cIik7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkQ29udGV4dFNlZWQoc2lnbmFsczogUHJvamVjdFNpZ25hbHMpOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG5cbiAgaWYgKHNpZ25hbHMuZGV0ZWN0ZWRGaWxlcy5sZW5ndGggPT09IDAgJiYgIXNpZ25hbHMuaXNHaXRSZXBvKSB7XG4gICAgcmV0dXJuIG51bGw7IC8vIEVtcHR5IGZvbGRlciwgbm8gY29udGV4dCB0byBzZWVkXG4gIH1cblxuICBsaW5lcy5wdXNoKFwiIyBQcm9qZWN0IENvbnRleHRcIik7XG4gIGxpbmVzLnB1c2goXCJcIik7XG4gIGxpbmVzLnB1c2goXCJBdXRvLWRldGVjdGVkIGJ5IEdTRCBpbml0IHdpemFyZC4gRWRpdCBvciBleHBhbmQgYXMgbmVlZGVkLlwiKTtcbiAgbGluZXMucHVzaChcIlwiKTtcblxuICBpZiAoc2lnbmFscy5wcmltYXJ5TGFuZ3VhZ2UpIHtcbiAgICBsaW5lcy5wdXNoKGAjIyBMYW5ndWFnZSAvIFN0YWNrYCk7XG4gICAgbGluZXMucHVzaChcIlwiKTtcbiAgICBsaW5lcy5wdXNoKGBQcmltYXJ5OiAke3NpZ25hbHMucHJpbWFyeUxhbmd1YWdlfWApO1xuICAgIGlmIChzaWduYWxzLmlzTW9ub3JlcG8pIHtcbiAgICAgIGxpbmVzLnB1c2goXCJTdHJ1Y3R1cmU6IG1vbm9yZXBvXCIpO1xuICAgIH1cbiAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICB9XG5cbiAgaWYgKHNpZ25hbHMuZGV0ZWN0ZWRGaWxlcy5sZW5ndGggPiAwKSB7XG4gICAgbGluZXMucHVzaChcIiMjIFByb2plY3QgRmlsZXNcIik7XG4gICAgbGluZXMucHVzaChcIlwiKTtcbiAgICBmb3IgKGNvbnN0IGYgb2Ygc2lnbmFscy5kZXRlY3RlZEZpbGVzKSB7XG4gICAgICBsaW5lcy5wdXNoKGAtICR7Zn1gKTtcbiAgICB9XG4gICAgbGluZXMucHVzaChcIlwiKTtcbiAgfVxuXG4gIGlmIChzaWduYWxzLmhhc0NJKSB7XG4gICAgbGluZXMucHVzaChcIiMjIENJL0NEXCIpO1xuICAgIGxpbmVzLnB1c2goXCJcIik7XG4gICAgbGluZXMucHVzaChcIkNJIGNvbmZpZ3VyYXRpb24gZGV0ZWN0ZWQuXCIpO1xuICAgIGxpbmVzLnB1c2goXCJcIik7XG4gIH1cblxuICBpZiAoc2lnbmFscy5oYXNUZXN0cykge1xuICAgIGxpbmVzLnB1c2goXCIjIyBUZXN0aW5nXCIpO1xuICAgIGxpbmVzLnB1c2goXCJcIik7XG4gICAgbGluZXMucHVzaChcIlRlc3QgaW5mcmFzdHJ1Y3R1cmUgZGV0ZWN0ZWQuXCIpO1xuICAgIGlmIChzaWduYWxzLnZlcmlmaWNhdGlvbkNvbW1hbmRzLmxlbmd0aCA+IDApIHtcbiAgICAgIGxpbmVzLnB1c2goXCJcIik7XG4gICAgICBsaW5lcy5wdXNoKFwiVmVyaWZpY2F0aW9uIGNvbW1hbmRzOlwiKTtcbiAgICAgIGZvciAoY29uc3QgY21kIG9mIHNpZ25hbHMudmVyaWZpY2F0aW9uQ29tbWFuZHMpIHtcbiAgICAgICAgbGluZXMucHVzaChgLSBcXGAke2NtZH1cXGBgKTtcbiAgICAgIH1cbiAgICB9XG4gICAgbGluZXMucHVzaChcIlwiKTtcbiAgfVxuXG4gIHJldHVybiBsaW5lcy5qb2luKFwiXFxuXCIpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgSGVscGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gYnVpbGREZXRlY3Rpb25TdW1tYXJ5KHNpZ25hbHM6IFByb2plY3RTaWduYWxzKTogc3RyaW5nW10ge1xuICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcblxuICBpZiAoc2lnbmFscy5wcmltYXJ5TGFuZ3VhZ2UpIHtcbiAgICBjb25zdCB0eXBlU3RyID0gc2lnbmFscy5pc01vbm9yZXBvID8gXCJtb25vcmVwb1wiIDogXCJwcm9qZWN0XCI7XG4gICAgbGluZXMucHVzaChgICAke3NpZ25hbHMucHJpbWFyeUxhbmd1YWdlfSAke3R5cGVTdHJ9YCk7XG4gIH1cblxuICBpZiAoc2lnbmFscy5kZXRlY3RlZEZpbGVzLmxlbmd0aCA+IDApIHtcbiAgICBsaW5lcy5wdXNoKGAgIFByb2plY3QgZmlsZXM6ICR7c2lnbmFscy5kZXRlY3RlZEZpbGVzLmpvaW4oXCIsIFwiKX1gKTtcbiAgfVxuXG4gIGlmIChzaWduYWxzLnBhY2thZ2VNYW5hZ2VyKSB7XG4gICAgbGluZXMucHVzaChgICBQYWNrYWdlIG1hbmFnZXI6ICR7c2lnbmFscy5wYWNrYWdlTWFuYWdlcn1gKTtcbiAgfVxuXG4gIGlmIChzaWduYWxzLmhhc0NJKSBsaW5lcy5wdXNoKFwiICBDSS9DRDogZGV0ZWN0ZWRcIik7XG4gIGlmIChzaWduYWxzLmhhc1Rlc3RzKSBsaW5lcy5wdXNoKFwiICBUZXN0czogZGV0ZWN0ZWRcIik7XG5cbiAgaWYgKHNpZ25hbHMudmVyaWZpY2F0aW9uQ29tbWFuZHMubGVuZ3RoID4gMCkge1xuICAgIGxpbmVzLnB1c2goYCAgVmVyaWZpY2F0aW9uOiAke3NpZ25hbHMudmVyaWZpY2F0aW9uQ29tbWFuZHMuam9pbihcIiwgXCIpfWApO1xuICB9XG5cbiAgcmV0dXJuIGxpbmVzO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZGV0ZWN0TWFpbkJyYW5jaChiYXNlUGF0aDogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gIHRyeSB7XG4gICAgLy8gTWF0Y2ggcnVudGltZSBicmFuY2ggcmVzb2x1dGlvbjogb3JpZ2luL0hFQUQgLT4gbWFpbiAtPiBtYXN0ZXIgLT4gY3VycmVudC5cbiAgICAvLyBSZWFkaW5nIC5naXQvSEVBRCBmaXJzdCByZWNvcmRzIHdoaWNoZXZlciBmZWF0dXJlIGJyYW5jaCBoYXBwZW5lZCB0byBiZVxuICAgIC8vIGNoZWNrZWQgb3V0IGR1cmluZyBpbml0IGFuZCBjYW4gcmVkaXJlY3QgZnV0dXJlIG1pbGVzdG9uZSBtZXJnZXMuXG4gICAgcmV0dXJuIG5hdGl2ZURldGVjdE1haW5CcmFuY2goYmFzZVBhdGgpO1xuICB9IGNhdGNoIHtcbiAgICAvLyBGYWxsIHRocm91Z2ggdG8gbnVsbFxuICB9XG4gIHJldHVybiBudWxsO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBU0EsU0FBUyxZQUFZLFdBQVcscUJBQW1DO0FBQ25FLFNBQVMsWUFBWTtBQUNyQixTQUFTLHNCQUFzQjtBQUMvQixTQUF1QixZQUFZLGNBQWMsY0FBYyw4QkFBOEI7QUFDN0YsU0FBUyxpQkFBaUIsMkJBQTJCO0FBQ3JELFNBQVMsZUFBZTtBQUN4QixTQUFTLDJCQUEyQjtBQUVwQyxTQUFTLDJCQUEyQjtBQUNwQyxTQUFTLHFCQUFxQix3QkFBd0I7QUFDdEQsU0FBUyxtQkFBbUIsNEJBQTRCO0FBYWpELFNBQVMsb0JBQW9CLFlBQThCO0FBQ2hFLFNBQU87QUFDVDtBQWVBLE1BQU0sZ0JBQW9DO0FBQUEsRUFDeEMsTUFBTTtBQUFBLEVBQ04sY0FBYztBQUFBLEVBQ2QsWUFBWTtBQUFBLEVBQ1osc0JBQXNCLENBQUM7QUFBQSxFQUN2QixvQkFBb0IsQ0FBQztBQUFBLEVBQ3JCLGNBQWM7QUFBQSxFQUNkLGNBQWM7QUFBQSxFQUNkLFVBQVU7QUFDWjtBQVFBLGVBQXNCLGdCQUNwQixLQUNBLElBQ0EsVUFDQSxXQUMyQjtBQUMzQixRQUFNLFVBQVUsVUFBVTtBQUMxQixRQUFNLFFBQVEsRUFBRSxHQUFHLGNBQWM7QUFHakMsUUFBTSxtQkFBbUIsc0JBQXNCLE9BQU87QUFDdEQsTUFBSSxpQkFBaUIsU0FBUyxHQUFHO0FBQy9CLFFBQUksR0FBRyxPQUFPO0FBQUEsRUFBc0IsaUJBQWlCLEtBQUssSUFBSSxDQUFDLElBQUksTUFBTTtBQUFBLEVBQzNFO0FBR0EsTUFBSSxhQUFh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
