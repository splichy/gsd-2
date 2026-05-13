import { createRequire } from "node:module";
import { computeProgressScore, formatProgressLine } from "../../progress-score.js";
import { getGlobalGSDPreferencesPath, getProjectGSDPreferencesPath } from "../../preferences.js";
import { ensurePreferencesFile, handlePrefs, handlePrefsMode, handlePrefsWizard, handleLanguage } from "../../commands-prefs-wizard.js";
import { runEnvironmentChecks } from "../../doctor-environment.js";
import { deriveState } from "../../state.js";
import { handleCmux } from "../../commands-cmux.js";
import { setSessionModelOverride } from "../../session-model-override.js";
import { projectRoot } from "../context.js";
import { formattedShortcutPair } from "../../shortcut-defs.js";
import { getVisualBriefOutputDir } from "../../../visual-brief/artifact-policy.js";
import { buildVisualBriefPrompt, parseVisualBriefArgs, VISUAL_BRIEF_USAGE } from "../../../visual-brief/prompts.js";
function showHelp(ctx, args = "") {
  const summaryLines = [
    "GSD \u2014 Get Shit Done\n",
    "QUICK START",
    "  /gsd start <tpl>   Start a workflow template",
    "  /gsd               Run next unit (same as /gsd next)",
    "  /gsd auto          Run all queued units continuously",
    "  /gsd pause         Pause auto-mode",
    "  /gsd stop          Stop auto-mode gracefully",
    "",
    "VISIBILITY",
    `  /gsd status         Dashboard  (${formattedShortcutPair("dashboard")})`,
    `  /gsd parallel watch Parallel monitor  (${formattedShortcutPair("parallel")})`,
    `  /gsd notifications  Notification history  (${formattedShortcutPair("notifications")})`,
    "  /gsd visualize      Interactive 10-tab TUI",
    "  /gsd brief <mode>   Visual HTML brief (diagram, plan, diff, recap, table, slides)",
    "  /gsd queue          Show queued/dispatched units",
    "",
    "COURSE CORRECTION",
    "  /gsd steer <desc>   Apply user override to active work",
    "  /gsd capture <text> Quick-capture a thought to CAPTURES.md",
    "  /gsd triage         Classify and route pending captures",
    "  /gsd undo           Revert last completed unit  [--force]",
    "  /gsd rethink        Conversational project reorganization",
    "",
    "OBSERVABILITY",
    "  /gsd logs           Browse activity and debug logs",
    "  /gsd debug          Create/list/continue persistent debug sessions",
    "",
    "SETUP",
    "  /gsd onboarding     Re-run setup wizard  [--resume|--reset|--step <name>]",
    "  /gsd setup          Configuration hub  [llm|model|search|remote|keys|prefs|onboarding]",
    "  /gsd init           Project init wizard",
    "  /gsd model          Switch active session model",
    "  /gsd prefs          Manage preferences (alias for /gsd setup prefs)",
    "  /gsd keys           API key manager (LLM + tool keys)",
    "  /gsd doctor         Diagnose and repair .gsd/ state",
    "",
    "Use /gsd help full for the complete command reference."
  ];
  const fullLines = [
    "GSD \u2014 Get Shit Done\n",
    "WORKFLOW",
    "  /gsd start <tpl>   Start a workflow template (bugfix, spike, feature, hotfix, etc.)",
    "  /gsd templates     List available workflow templates  [info <name>]",
    "  /gsd               Run next unit in step mode (same as /gsd next)",
    "  /gsd next           Execute next task, then pause  [--dry-run] [--verbose]",
    "  /gsd auto           Run all queued units continuously  [--verbose]",
    "  /gsd stop           Stop auto-mode gracefully",
    "  /gsd pause          Pause auto-mode (preserves state, /gsd auto to resume)",
    "  /gsd discuss        Start guided milestone/slice discussion",
    "  /gsd new-milestone  Create milestone from headless context (used by gsd headless)",
    "  /gsd new-project    Bootstrap a new project (use --deep for staged project-level discovery)",
    "  /gsd quick          Execute a quick task without full planning overhead",
    "  /gsd dispatch       Dispatch a specific phase directly  [research|plan|execute|complete|uat|replan]",
    "  /gsd parallel       Parallel milestone orchestration  [start|status|stop|pause|resume|merge|watch]",
    "  /gsd workflow       Custom workflow lifecycle  [new|run|list|validate|pause|resume]",
    "",
    "VISIBILITY",
    `  /gsd status         Show progress dashboard  (${formattedShortcutPair("dashboard")})`,
    `  /gsd parallel watch Open parallel worker monitor  (${formattedShortcutPair("parallel")})`,
    "  /gsd widget         Cycle status widget  [full|small|min|off]",
    "  /gsd visualize      Interactive 10-tab TUI (progress, timeline, deps, metrics, health, agent, changes, knowledge, captures, export)",
    "  /gsd brief <mode>   Generate a visual HTML brief  [diagram|plan|diff|recap|table|slides] [topic] [--slides]",
    "  /gsd queue          Show queued/dispatched units and execution order",
    "  /gsd history        View execution history  [--cost] [--phase] [--model] [N]",
    "  /gsd changelog      Show categorized release notes  [version]",
    `  /gsd notifications  View persistent notification history  [clear|tail|filter]  (${formattedShortcutPair("notifications")})`,
    "  /gsd logs           Browse activity logs, debug logs, and metrics  [debug|tail|clear]",
    "  /gsd debug          Create/list/continue persistent debug sessions",
    "",
    "COURSE CORRECTION",
    "  /gsd steer <desc>   Apply user override to active work",
    "  /gsd capture <text> Quick-capture a thought to CAPTURES.md",
    "  /gsd triage         Classify and route pending captures",
    "  /gsd skip <unit>    Prevent a unit from auto-mode dispatch",
    "  /gsd undo           Revert last completed unit  [--force]",
    "  /gsd undo-task      Reset a specific task's completion state  [DB + markdown]",
    "  /gsd reset-slice    Reset a slice and all its tasks  [DB + markdown]",
    "  /gsd rate           Rate last unit's model tier  [over|ok|under]",
    "  /gsd rethink        Conversational project reorganization \u2014 reorder, park, discard, add milestones",
    "  /gsd park [id]      Park a milestone \u2014 skip without deleting  [reason]",
    "  /gsd unpark [id]    Reactivate a parked milestone",
    "",
    "PROJECT KNOWLEDGE",
    "  /gsd knowledge <type> <text>   Add a rule to KNOWLEDGE.md or capture a pattern/lesson to memories",
    "  /gsd codebase [generate|update|stats]   Manage the CODEBASE.md cache used in prompt context",
    "",
    "SHIPPING & BACKLOG",
    "  /gsd ship           Create a PR from milestone artifacts  [--dry-run|--draft|--base|--force]",
    "  /gsd do <text>      Route freeform text to the right GSD command",
    "  /gsd session-report Show session cost, tokens, and work summary  [--json|--save]",
    "  /gsd backlog        Manage backlog items  [add|promote|remove|list]",
    "  /gsd pr-branch      Create a clean PR branch filtering .gsd/ commits  [--dry-run|--name]",
    "  /gsd add-tests      Generate tests for completed slices",
    "  /gsd eval-review <sliceId>  Audit a slice's AI evaluation strategy  [--force|--show]",
    "  /gsd scan           Rapid codebase assessment  [--focus tech|arch|quality|concerns|tech+arch]",
    "",
    "SETUP & CONFIGURATION",
    "  /gsd onboarding     Re-run setup wizard  [--resume|--reset|--step <name>]",
    "  /gsd setup          Configuration hub  [llm|model|search|remote|keys|prefs|onboarding]",
    "  /gsd init           Project init wizard \u2014 detect, configure, bootstrap .gsd/",
    "  /gsd model          Switch active session model  [provider/model|model-id]",
    "  /gsd mode           Set workflow mode (solo/team)  [global|project]",
    "  /gsd prefs          Manage preferences  [global|project|status|wizard|setup|import-claude]  (alias for /gsd setup prefs)",
    "  /gsd cmux           Manage cmux integration  [status|on|off|notifications|sidebar|splits|browser]",
    "  /gsd keys           API key manager (LLM + tool keys)  [list|add|remove|test|rotate|doctor]",
    "  /gsd config         (deprecated) Set tool API keys \u2014 use /gsd keys instead",
    "  /gsd show-config    Show effective configuration (models, routing, toggles)",
    "  /gsd hooks          Show post-unit hook configuration",
    "  /gsd run-hook       Manually trigger a specific hook",
    "  /gsd skill-health   Skill lifecycle dashboard",
    "  /gsd extensions     Manage extensions  [list|enable|disable|info]",
    "  /gsd fast           Toggle OpenAI service tier  [on|off|flex|status]",
    "  /gsd mcp            MCP server status and connectivity  [status|check <server>|init [dir]]",
    "",
    "MAINTENANCE",
    "  /gsd doctor         Diagnose and repair .gsd/ state  [audit|fix|heal] [scope]",
    "  /gsd forensics      Examine execution logs and post-mortem analysis",
    "  /gsd export         Export milestone/slice results  [--json|--markdown|--html] [--all]",
    "  /gsd cleanup        Remove merged branches or snapshots  [branches|snapshots]",
    "  /gsd worktree       Manage worktrees from the TUI  [list|merge|clean|remove]",
    "  /gsd migrate        Migrate .planning/ (v1) to .gsd/ (v2) format",
    "  /gsd remote         Control remote auto-mode  [slack|discord|status|disconnect]",
    "  /gsd inspect        Show SQLite DB diagnostics (schema, row counts, recent entries)",
    "  /gsd update         Update GSD to the latest version via npm",
    "  /gsd language       Set or clear the global response language  [off|clear|<language>]"
  ];
  const full = ["full", "--full", "all"].includes(args.trim().toLowerCase());
  ctx.ui.notify((full ? fullLines : summaryLines).join("\n"), "info");
}
async function handleStatus(ctx) {
  const basePath = projectRoot();
  const { ensureDbOpen } = await import("../../bootstrap/dynamic-tools.js");
  await ensureDbOpen();
  const state = await deriveState(basePath);
  if (state.registry.length === 0) {
    ctx.ui.notify("No GSD milestones found. Run /gsd to start.", "info");
    return;
  }
  const { GSDDashboardOverlay } = await import("../../dashboard-overlay.js");
  const result = await ctx.ui.custom(
    (tui, theme, _kb, done) => new GSDDashboardOverlay(tui, theme, () => done(true)),
    {
      overlay: true,
      overlayOptions: {
        width: "90%",
        minWidth: 80,
        maxHeight: "92%",
        anchor: "center"
      }
    }
  );
  if (result === void 0) {
    ctx.ui.notify(formatTextStatus(state), "info");
  }
}
async function fireStatusViaCommand(ctx) {
  await handleStatus(ctx);
}
async function handleVisualize(ctx) {
  if (!ctx.hasUI) {
    ctx.ui.notify("Visualizer requires an interactive terminal.", "warning");
    return;
  }
  const { GSDVisualizerOverlay } = await import("../../visualizer-overlay.js");
  const result = await ctx.ui.custom(
    (tui, theme, _kb, done) => new GSDVisualizerOverlay(tui, theme, () => done(true)),
    {
      overlay: true,
      overlayOptions: {
        width: "80%",
        minWidth: 80,
        maxHeight: "90%",
        anchor: "center"
      }
    }
  );
  if (result === void 0) {
    ctx.ui.notify("Visualizer requires an interactive terminal. Use /gsd status for a text-based overview.", "warning");
  }
}
async function handleBrief(args, ctx, pi) {
  const request = parseVisualBriefArgs(args);
  if (!request) {
    ctx.ui.notify(VISUAL_BRIEF_USAGE, "info");
    return;
  }
  if (!pi?.sendUserMessage) {
    ctx.ui.notify("Visual brief generation is unavailable in this context.", "warning");
    return;
  }
  const outputDir = getVisualBriefOutputDir();
  const version = resolveGsdVersion();
  pi.sendUserMessage(buildVisualBriefPrompt(request, { outputDir, version }));
}
const briefRequire = createRequire(import.meta.url);
function resolveGsdVersion() {
  const envVersion = process.env.GSD_VERSION?.trim();
  if (envVersion) return envVersion;
  try {
    const pkg = briefRequire("../../../../../../package.json");
    const fromPkg = typeof pkg.version === "string" ? pkg.version.trim() : "";
    return fromPkg || void 0;
  } catch {
    return void 0;
  }
}
async function handleSetup(args, ctx, pi) {
  const { detectProjectState, hasGlobalSetup } = await import("../../detection.js");
  const { isOnboardingComplete, readOnboardingRecord } = await import("../../onboarding-state.js");
  if (args === "onboarding" || args === "wizard") {
    const { handleOnboarding } = await import("./onboarding.js");
    await handleOnboarding("", ctx);
    return;
  }
  if (args === "llm" || args === "auth") {
    const { handleOnboarding } = await import("./onboarding.js");
    await handleOnboarding("--step llm", ctx);
    return;
  }
  if (args === "search") {
    const { handleOnboarding } = await import("./onboarding.js");
    await handleOnboarding("--step search", ctx);
    return;
  }
  if (args === "remote") {
    const { handleOnboarding } = await import("./onboarding.js");
    await handleOnboarding("--step remote", ctx);
    return;
  }
  if (args === "model") {
    await handleModel("", ctx, pi);
    return;
  }
  if (args === "keys") {
    ctx.ui.notify("Tip: /gsd keys is the canonical command for API key management.", "info");
    const { handleKeys } = await import("../../key-manager.js");
    await handleKeys("", ctx);
    return;
  }
  if (args === "prefs") {
    await ensurePreferencesFile(getGlobalGSDPreferencesPath(), ctx, "global");
    await handlePrefsWizard(ctx, "global");
    return;
  }
  const globalConfigured = hasGlobalSetup();
  const detection = detectProjectState(projectRoot());
  const onboardingDone = isOnboardingComplete();
  const record = readOnboardingRecord();
  const statusLines = ["GSD Setup\n"];
  statusLines.push(
    onboardingDone ? `  Onboarding:         \u2713 complete${record.completedAt ? ` (${record.completedAt.slice(0, 10)})` : ""}` : `  Onboarding:         \u25CB not complete  \u2014  /gsd onboarding to start`
  );
  statusLines.push(`  Global preferences: ${globalConfigured ? "configured" : "not set"}`);
  statusLines.push(`  Project state:      ${detection.state}`);
  if (detection.projectSignals.primaryLanguage) {
    statusLines.push(`  Detected:           ${detection.projectSignals.primaryLanguage}`);
  }
  ctx.ui.notify(statusLines.join("\n"), "info");
  ctx.ui.notify(
    "Configuration hub:\n  /gsd setup llm        \u2014 LLM provider & auth\n  /gsd setup model      \u2014 Default model picker\n  /gsd setup search     \u2014 Web search provider\n  /gsd setup remote     \u2014 Remote questions (Discord/Slack/Telegram)\n  /gsd setup keys       \u2014 API keys (alias for /gsd keys)\n  /gsd setup prefs      \u2014 Global preferences (alias for /gsd prefs)\n  /gsd setup onboarding \u2014 Full wizard (alias for /gsd onboarding)\n\nTip: /gsd onboarding --resume to continue an incomplete setup.",
    "info"
  );
}
function sortModelsForSelection(models, currentModel) {
  return [...models].sort((a, b) => {
    const aCurrent = currentModel && a.provider === currentModel.provider && a.id === currentModel.id;
    const bCurrent = currentModel && b.provider === currentModel.provider && b.id === currentModel.id;
    if (aCurrent && !bCurrent) return -1;
    if (!aCurrent && bCurrent) return 1;
    const providerCmp = a.provider.localeCompare(b.provider);
    if (providerCmp !== 0) return providerCmp;
    return a.id.localeCompare(b.id);
  });
}
function buildProviderModelGroups(models, currentModel) {
  const byProvider = /* @__PURE__ */ new Map();
  for (const model of sortModelsForSelection(models, currentModel)) {
    let group = byProvider.get(model.provider);
    if (!group) {
      group = [];
      byProvider.set(model.provider, group);
    }
    group.push(model);
  }
  return byProvider;
}
async function selectModelByProvider(title, models, ctx, currentModel) {
  const byProvider = buildProviderModelGroups(models, currentModel);
  const providerOptions = Array.from(byProvider.entries()).map(
    ([provider, group]) => `${provider} (${group.length} model${group.length === 1 ? "" : "s"})`
  );
  providerOptions.push("(cancel)");
  const providerChoice = await ctx.ui.select(`${title} \u2014 choose provider:`, providerOptions);
  if (!providerChoice || typeof providerChoice !== "string" || providerChoice === "(cancel)") return void 0;
  const providerName = providerChoice.replace(/ \(\d+ models?\)$/, "");
  const providerModels = byProvider.get(providerName);
  if (!providerModels || providerModels.length === 0) return void 0;
  const optionToModel = /* @__PURE__ */ new Map();
  const modelOptions = providerModels.map((model) => {
    const isCurrent = currentModel && model.provider === currentModel.provider && model.id === currentModel.id;
    const label = `${isCurrent ? "* " : ""}${model.id}`;
    optionToModel.set(label, model);
    return label;
  });
  modelOptions.push("(cancel)");
  const modelChoice = await ctx.ui.select(`${title} \u2014 ${providerName}:`, modelOptions);
  if (!modelChoice || typeof modelChoice !== "string" || modelChoice === "(cancel)") return void 0;
  return optionToModel.get(modelChoice);
}
async function resolveRequestedModel(query, ctx) {
  const { resolveModelId } = await import("../../auto-model-selection.js");
  const models = ctx.modelRegistry.getAvailable();
  const exact = resolveModelId(query, models, ctx.model?.provider);
  if (exact) return exact;
  const lowerQuery = query.toLowerCase();
  const partialMatches = models.filter(
    (model) => model.id.toLowerCase().includes(lowerQuery) || `${model.provider}/${model.id}`.toLowerCase().includes(lowerQuery)
  );
  if (partialMatches.length === 1) return partialMatches[0];
  if (partialMatches.length === 0 || !ctx.hasUI) return void 0;
  return selectModelByProvider(`Multiple models match "${query}"`, partialMatches, ctx, ctx.model);
}
async function handleModel(trimmedArgs, ctx, pi) {
  const availableModels = ctx.modelRegistry.getAvailable();
  if (availableModels.length === 0) {
    ctx.ui.notify("No available models found. Check provider auth and model discovery.", "warning");
    return;
  }
  if (!pi) {
    ctx.ui.notify("Model switching is unavailable in this context.", "warning");
    return;
  }
  const trimmed = trimmedArgs.trim();
  let targetModel;
  if (!trimmed) {
    if (!ctx.hasUI) {
      const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(none)";
      ctx.ui.notify(`Current model: ${current}
Usage: /gsd model <provider/model|model-id>`, "info");
      return;
    }
    targetModel = await selectModelByProvider("Select session model:", availableModels, ctx, ctx.model);
  } else {
    targetModel = await resolveRequestedModel(trimmed, ctx);
  }
  if (!targetModel) {
    ctx.ui.notify(`Model "${trimmed}" not found. Use /gsd model with an exact provider/model or a unique model ID.`, "warning");
    return;
  }
  const ok = await pi.setModel(targetModel);
  if (!ok) {
    ctx.ui.notify(`No API key for ${targetModel.provider}/${targetModel.id}`, "warning");
    return;
  }
  const sessionId = ctx.sessionManager?.getSessionId?.();
  if (sessionId) {
    setSessionModelOverride(sessionId, {
      provider: targetModel.provider,
      id: targetModel.id
    });
  }
  ctx.ui.notify(`Model: ${targetModel.provider}/${targetModel.id}`, "info");
}
async function handleCoreCommand(trimmed, ctx, pi) {
  if (trimmed === "help" || trimmed === "h" || trimmed === "?" || trimmed.startsWith("help ")) {
    showHelp(ctx, trimmed.startsWith("help ") ? trimmed.slice(5).trim() : "");
    return true;
  }
  if (trimmed === "status") {
    await handleStatus(ctx);
    return true;
  }
  if (trimmed === "visualize") {
    await handleVisualize(ctx);
    return true;
  }
  if (trimmed === "brief" || trimmed.startsWith("brief ")) {
    await handleBrief(trimmed.replace(/^brief\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "widget" || trimmed.startsWith("widget ")) {
    const { cycleWidgetMode, setWidgetMode, getWidgetMode } = await import("../../auto-dashboard.js");
    const arg = trimmed.replace(/^widget\s*/, "").trim();
    if (arg === "full" || arg === "small" || arg === "min" || arg === "off") {
      setWidgetMode(arg);
    } else {
      cycleWidgetMode();
    }
    ctx.ui.notify(`Widget: ${getWidgetMode()}`, "info");
    return true;
  }
  if (trimmed === "model" || trimmed.startsWith("model ")) {
    await handleModel(trimmed.replace(/^model\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "mode" || trimmed.startsWith("mode ")) {
    const modeArgs = trimmed.replace(/^mode\s*/, "").trim();
    const scope = modeArgs === "project" ? "project" : "global";
    const path = scope === "project" ? getProjectGSDPreferencesPath() : getGlobalGSDPreferencesPath();
    await ensurePreferencesFile(path, ctx, scope);
    await handlePrefsMode(ctx, scope);
    return true;
  }
  if (trimmed === "prefs" || trimmed.startsWith("prefs ")) {
    await handlePrefs(trimmed.replace(/^prefs\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "language" || trimmed.startsWith("language ")) {
    await handleLanguage(trimmed.replace(/^language\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "cmux" || trimmed.startsWith("cmux ")) {
    await handleCmux(trimmed.replace(/^cmux\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "show-config") {
    const { GSDConfigOverlay, formatConfigText } = await import("../../config-overlay.js");
    const result = await ctx.ui.custom(
      (tui, theme, _kb, done) => new GSDConfigOverlay(tui, theme, () => done(true)),
      {
        overlay: true,
        overlayOptions: {
          width: "65%",
          minWidth: 55,
          maxHeight: "85%",
          anchor: "center"
        }
      }
    );
    if (result === void 0) {
      ctx.ui.notify(formatConfigText(), "info");
    }
    return true;
  }
  if (trimmed === "setup" || trimmed.startsWith("setup ")) {
    await handleSetup(trimmed.replace(/^setup\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "onboarding" || trimmed.startsWith("onboarding ")) {
    const { handleOnboarding } = await import("./onboarding.js");
    await handleOnboarding(trimmed.replace(/^onboarding\s*/, "").trim(), ctx);
    return true;
  }
  return false;
}
function formatTextStatus(state) {
  const lines = ["GSD Status\n"];
  lines.push(formatProgressLine(computeProgressScore()));
  lines.push("");
  lines.push(`Phase: ${state.phase}`);
  if (state.activeMilestone) {
    lines.push(`Active milestone: ${state.activeMilestone.id} \u2014 ${state.activeMilestone.title}`);
  }
  if (state.activeSlice) {
    lines.push(`Active slice: ${state.activeSlice.id} \u2014 ${state.activeSlice.title}`);
  }
  if (state.activeTask) {
    lines.push(`Active task: ${state.activeTask.id} \u2014 ${state.activeTask.title}`);
  }
  if (state.progress) {
    const { milestones, slices, tasks } = state.progress;
    const parts = [`milestones ${milestones.done}/${milestones.total}`];
    if (slices) parts.push(`slices ${slices.done}/${slices.total}`);
    if (tasks) parts.push(`tasks ${tasks.done}/${tasks.total}`);
    lines.push(`Progress: ${parts.join(", ")}`);
  }
  if (state.nextAction) {
    lines.push(`Next: ${state.nextAction}`);
  }
  if (state.blockers.length > 0) {
    lines.push(`Blockers: ${state.blockers.join("; ")}`);
  }
  if (state.registry.length > 0) {
    lines.push("");
    lines.push("Milestones:");
    for (const milestone of state.registry) {
      const icon = milestone.status === "complete" ? "\u2713" : milestone.status === "active" ? "\u25B6" : milestone.status === "parked" ? "\u23F8" : "\u25CB";
      lines.push(`  ${icon} ${milestone.id}: ${milestone.title} (${milestone.status})`);
    }
  }
  const envResults = runEnvironmentChecks(projectRoot());
  const envIssues = envResults.filter((result) => result.status !== "ok");
  if (envIssues.length > 0) {
    lines.push("");
    lines.push("Environment:");
    for (const issue of envIssues) {
      lines.push(`  ${issue.status === "error" ? "\u2717" : "\u26A0"} ${issue.message}`);
    }
  }
  return lines.join("\n");
}
export {
  fireStatusViaCommand,
  formatTextStatus,
  handleBrief,
  handleCoreCommand,
  handleSetup,
  handleStatus,
  handleVisualize,
  showHelp
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9jb21tYW5kcy9oYW5kbGVycy9jb3JlLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdHlwZSB7IEV4dGVuc2lvbkFQSSwgRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsIEV4dGVuc2lvbkNvbnRleHQgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB0eXBlIHsgTW9kZWwgfSBmcm9tIFwiQGdzZC9waS1haVwiO1xuaW1wb3J0IHR5cGUgeyBHU0RTdGF0ZSB9IGZyb20gXCIuLi8uLi90eXBlcy5qc1wiO1xuaW1wb3J0IHsgY3JlYXRlUmVxdWlyZSB9IGZyb20gXCJub2RlOm1vZHVsZVwiO1xuXG5pbXBvcnQgeyBjb21wdXRlUHJvZ3Jlc3NTY29yZSwgZm9ybWF0UHJvZ3Jlc3NMaW5lIH0gZnJvbSBcIi4uLy4uL3Byb2dyZXNzLXNjb3JlLmpzXCI7XG5pbXBvcnQgeyBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMsIGdldEdsb2JhbEdTRFByZWZlcmVuY2VzUGF0aCwgZ2V0UHJvamVjdEdTRFByZWZlcmVuY2VzUGF0aCB9IGZyb20gXCIuLi8uLi9wcmVmZXJlbmNlcy5qc1wiO1xuaW1wb3J0IHsgZW5zdXJlUHJlZmVyZW5jZXNGaWxlLCBoYW5kbGVQcmVmcywgaGFuZGxlUHJlZnNNb2RlLCBoYW5kbGVQcmVmc1dpemFyZCwgaGFuZGxlTGFuZ3VhZ2UgfSBmcm9tIFwiLi4vLi4vY29tbWFuZHMtcHJlZnMtd2l6YXJkLmpzXCI7XG5pbXBvcnQgeyBydW5FbnZpcm9ubWVudENoZWNrcyB9IGZyb20gXCIuLi8uLi9kb2N0b3ItZW52aXJvbm1lbnQuanNcIjtcbmltcG9ydCB7IGRlcml2ZVN0YXRlIH0gZnJvbSBcIi4uLy4uL3N0YXRlLmpzXCI7XG5pbXBvcnQgeyBoYW5kbGVDbXV4IH0gZnJvbSBcIi4uLy4uL2NvbW1hbmRzLWNtdXguanNcIjtcbmltcG9ydCB7IHNldFNlc3Npb25Nb2RlbE92ZXJyaWRlIH0gZnJvbSBcIi4uLy4uL3Nlc3Npb24tbW9kZWwtb3ZlcnJpZGUuanNcIjtcbmltcG9ydCB7IHByb2plY3RSb290IH0gZnJvbSBcIi4uL2NvbnRleHQuanNcIjtcbmltcG9ydCB7IGZvcm1hdHRlZFNob3J0Y3V0UGFpciB9IGZyb20gXCIuLi8uLi9zaG9ydGN1dC1kZWZzLmpzXCI7XG5pbXBvcnQgeyBnZXRWaXN1YWxCcmllZk91dHB1dERpciB9IGZyb20gXCIuLi8uLi8uLi92aXN1YWwtYnJpZWYvYXJ0aWZhY3QtcG9saWN5LmpzXCI7XG5pbXBvcnQgeyBidWlsZFZpc3VhbEJyaWVmUHJvbXB0LCBwYXJzZVZpc3VhbEJyaWVmQXJncywgVklTVUFMX0JSSUVGX1VTQUdFIH0gZnJvbSBcIi4uLy4uLy4uL3Zpc3VhbC1icmllZi9wcm9tcHRzLmpzXCI7XG5cbmV4cG9ydCBmdW5jdGlvbiBzaG93SGVscChjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LCBhcmdzID0gXCJcIik6IHZvaWQge1xuICBjb25zdCBzdW1tYXJ5TGluZXMgPSBbXG4gICAgXCJHU0QgXHUyMDE0IEdldCBTaGl0IERvbmVcXG5cIixcbiAgICBcIlFVSUNLIFNUQVJUXCIsXG4gICAgXCIgIC9nc2Qgc3RhcnQgPHRwbD4gICBTdGFydCBhIHdvcmtmbG93IHRlbXBsYXRlXCIsXG4gICAgXCIgIC9nc2QgICAgICAgICAgICAgICBSdW4gbmV4dCB1bml0IChzYW1lIGFzIC9nc2QgbmV4dClcIixcbiAgICBcIiAgL2dzZCBhdXRvICAgICAgICAgIFJ1biBhbGwgcXVldWVkIHVuaXRzIGNvbnRpbnVvdXNseVwiLFxuICAgIFwiICAvZ3NkIHBhdXNlICAgICAgICAgUGF1c2UgYXV0by1tb2RlXCIsXG4gICAgXCIgIC9nc2Qgc3RvcCAgICAgICAgICBTdG9wIGF1dG8tbW9kZSBncmFjZWZ1bGx5XCIsXG4gICAgXCJcIixcbiAgICBcIlZJU0lCSUxJVFlcIixcbiAgICBgICAvZ3NkIHN0YXR1cyAgICAgICAgIERhc2hib2FyZCAgKCR7Zm9ybWF0dGVkU2hvcnRjdXRQYWlyKFwiZGFzaGJvYXJkXCIpfSlgLFxuICAgIGAgIC9nc2QgcGFyYWxsZWwgd2F0Y2ggUGFyYWxsZWwgbW9uaXRvciAgKCR7Zm9ybWF0dGVkU2hvcnRjdXRQYWlyKFwicGFyYWxsZWxcIil9KWAsXG4gICAgYCAgL2dzZCBub3RpZmljYXRpb25zICBOb3RpZmljYXRpb24gaGlzdG9yeSAgKCR7Zm9ybWF0dGVkU2hvcnRjdXRQYWlyKFwibm90aWZpY2F0aW9uc1wiKX0pYCxcbiAgICBcIiAgL2dzZCB2aXN1YWxpemUgICAgICBJbnRlcmFjdGl2ZSAxMC10YWIgVFVJXCIsXG4gICAgXCIgIC9nc2QgYnJpZWYgPG1vZGU+ICAgVmlzdWFsIEhUTUwgYnJpZWYgKGRpYWdyYW0sIHBsYW4sIGRpZmYsIHJlY2FwLCB0YWJsZSwgc2xpZGVzKVwiLFxuICAgIFwiICAvZ3NkIHF1ZXVlICAgICAgICAgIFNob3cgcXVldWVkL2Rpc3BhdGNoZWQgdW5pdHNcIixcbiAgICBcIlwiLFxuICAgIFwiQ09VUlNFIENPUlJFQ1RJT05cIixcbiAgICBcIiAgL2dzZCBzdGVlciA8ZGVzYz4gICBBcHBseSB1c2VyIG92ZXJyaWRlIHRvIGFjdGl2ZSB3b3JrXCIsXG4gICAgXCIgIC9nc2QgY2FwdHVyZSA8dGV4dD4gUXVpY2stY2FwdHVyZSBhIHRob3VnaHQgdG8gQ0FQVFVSRVMubWRcIixcbiAgICBcIiAgL2dzZCB0cmlhZ2UgICAgICAgICBDbGFzc2lmeSBhbmQgcm91dGUgcGVuZGluZyBjYXB0dXJlc1wiLFxuICAgIFwiICAvZ3NkIHVuZG8gICAgICAgICAgIFJldmVydCBsYXN0IGNvbXBsZXRlZCB1bml0ICBbLS1mb3JjZV1cIixcbiAgICBcIiAgL2dzZCByZXRoaW5rICAgICAgICBDb252ZXJzYXRpb25hbCBwcm9qZWN0IHJlb3JnYW5pemF0aW9uXCIsXG4gICAgXCJcIixcbiAgICBcIk9CU0VSVkFCSUxJVFlcIixcbiAgICBcIiAgL2dzZCBsb2dzICAgICAgICAgICBCcm93c2UgYWN0aXZpdHkgYW5kIGRlYnVnIGxvZ3NcIixcbiAgICBcIiAgL2dzZCBkZWJ1ZyAgICAgICAgICBDcmVhdGUvbGlzdC9jb250aW51ZSBwZXJzaXN0ZW50IGRlYnVnIHNlc3Npb25zXCIsXG4gICAgXCJcIixcbiAgICBcIlNFVFVQXCIsXG4gICAgXCIgIC9nc2Qgb25ib2FyZGluZyAgICAgUmUtcnVuIHNldHVwIHdpemFyZCAgWy0tcmVzdW1lfC0tcmVzZXR8LS1zdGVwIDxuYW1lPl1cIixcbiAgICBcIiAgL2dzZCBzZXR1cCAgICAgICAgICBDb25maWd1cmF0aW9uIGh1YiAgW2xsbXxtb2RlbHxzZWFyY2h8cmVtb3RlfGtleXN8cHJlZnN8b25ib2FyZGluZ11cIixcbiAgICBcIiAgL2dzZCBpbml0ICAgICAgICAgICBQcm9qZWN0IGluaXQgd2l6YXJkXCIsXG4gICAgXCIgIC9nc2QgbW9kZWwgICAgICAgICAgU3dpdGNoIGFjdGl2ZSBzZXNzaW9uIG1vZGVsXCIsXG4gICAgXCIgIC9nc2QgcHJlZnMgICAgICAgICAgTWFuYWdlIHByZWZlcmVuY2VzIChhbGlhcyBmb3IgL2dzZCBzZXR1cCBwcmVmcylcIixcbiAgICBcIiAgL2dzZCBrZXlzICAgICAgICAgICBBUEkga2V5IG1hbmFnZXIgKExMTSArIHRvb2wga2V5cylcIixcbiAgICBcIiAgL2dzZCBkb2N0b3IgICAgICAgICBEaWFnbm9zZSBhbmQgcmVwYWlyIC5nc2QvIHN0YXRlXCIsXG4gICAgXCJcIixcbiAgICBcIlVzZSAvZ3NkIGhlbHAgZnVsbCBmb3IgdGhlIGNvbXBsZXRlIGNvbW1hbmQgcmVmZXJlbmNlLlwiLFxuICBdO1xuXG4gIGNvbnN0IGZ1bGxMaW5lcyA9IFtcbiAgICBcIkdTRCBcdTIwMTQgR2V0IFNoaXQgRG9uZVxcblwiLFxuICAgIFwiV09SS0ZMT1dcIixcbiAgICBcIiAgL2dzZCBzdGFydCA8dHBsPiAgIFN0YXJ0IGEgd29ya2Zsb3cgdGVtcGxhdGUgKGJ1Z2ZpeCwgc3Bpa2UsIGZlYXR1cmUsIGhvdGZpeCwgZXRjLilcIixcbiAgICBcIiAgL2dzZCB0ZW1wbGF0ZXMgICAgIExpc3QgYXZhaWxhYmxlIHdvcmtmbG93IHRlbXBsYXRlcyAgW2luZm8gPG5hbWU+XVwiLFxuICAgIFwiICAvZ3NkICAgICAgICAgICAgICAgUnVuIG5leHQgdW5pdCBpbiBzdGVwIG1vZGUgKHNhbWUgYXMgL2dzZCBuZXh0KVwiLFxuICAgIFwiICAvZ3NkIG5leHQgICAgICAgICAgIEV4ZWN1dGUgbmV4dCB0YXNrLCB0aGVuIHBhdXNlICBbLS1kcnktcnVuXSBbLS12ZXJib3NlXVwiLFxuICAgIFwiICAvZ3NkIGF1dG8gICAgICAgICAgIFJ1biBhbGwgcXVldWVkIHVuaXRzIGNvbnRpbnVvdXNseSAgWy0tdmVyYm9zZV1cIixcbiAgICBcIiAgL2dzZCBzdG9wICAgICAgICAgICBTdG9wIGF1dG8tbW9kZSBncmFjZWZ1bGx5XCIsXG4gICAgXCIgIC9nc2QgcGF1c2UgICAgICAgICAgUGF1c2UgYXV0by1tb2RlIChwcmVzZXJ2ZXMgc3RhdGUsIC9nc2QgYXV0byB0byByZXN1bWUpXCIsXG4gICAgXCIgIC9nc2QgZGlzY3VzcyAgICAgICAgU3RhcnQgZ3VpZGVkIG1pbGVzdG9uZS9zbGljZSBkaXNjdXNzaW9uXCIsXG4gICAgXCIgIC9nc2QgbmV3LW1pbGVzdG9uZSAgQ3JlYXRlIG1pbGVzdG9uZSBmcm9tIGhlYWRsZXNzIGNvbnRleHQgKHVzZWQgYnkgZ3NkIGhlYWRsZXNzKVwiLFxuICAgIFwiICAvZ3NkIG5ldy1wcm9qZWN0ICAgIEJvb3RzdHJhcCBhIG5ldyBwcm9qZWN0ICh1c2UgLS1kZWVwIGZvciBzdGFnZWQgcHJvamVjdC1sZXZlbCBkaXNjb3ZlcnkpXCIsXG4gICAgXCIgIC9nc2QgcXVpY2sgICAgICAgICAgRXhlY3V0ZSBhIHF1aWNrIHRhc2sgd2l0aG91dCBmdWxsIHBsYW5uaW5nIG92ZXJoZWFkXCIsXG4gICAgXCIgIC9nc2QgZGlzcGF0Y2ggICAgICAgRGlzcGF0Y2ggYSBzcGVjaWZpYyBwaGFzZSBkaXJlY3RseSAgW3Jlc2VhcmNofHBsYW58ZXhlY3V0ZXxjb21wbGV0ZXx1YXR8cmVwbGFuXVwiLFxuICAgIFwiICAvZ3NkIHBhcmFsbGVsICAgICAgIFBhcmFsbGVsIG1pbGVzdG9uZSBvcmNoZXN0cmF0aW9uICBbc3RhcnR8c3RhdHVzfHN0b3B8cGF1c2V8cmVzdW1lfG1lcmdlfHdhdGNoXVwiLFxuICAgIFwiICAvZ3NkIHdvcmtmbG93ICAgICAgIEN1c3RvbSB3b3JrZmxvdyBsaWZlY3ljbGUgIFtuZXd8cnVufGxpc3R8dmFsaWRhdGV8cGF1c2V8cmVzdW1lXVwiLFxuICAgIFwiXCIsXG4gICAgXCJWSVNJQklMSVRZXCIsXG4gICAgYCAgL2dzZCBzdGF0dXMgICAgICAgICBTaG93IHByb2dyZXNzIGRhc2hib2FyZCAgKCR7Zm9ybWF0dGVkU2hvcnRjdXRQYWlyKFwiZGFzaGJvYXJkXCIpfSlgLFxuICAgIGAgIC9nc2QgcGFyYWxsZWwgd2F0Y2ggT3BlbiBwYXJhbGxlbCB3b3JrZXIgbW9uaXRvciAgKCR7Zm9ybWF0dGVkU2hvcnRjdXRQYWlyKFwicGFyYWxsZWxcIil9KWAsXG4gICAgXCIgIC9nc2Qgd2lkZ2V0ICAgICAgICAgQ3ljbGUgc3RhdHVzIHdpZGdldCAgW2Z1bGx8c21hbGx8bWlufG9mZl1cIixcbiAgICBcIiAgL2dzZCB2aXN1YWxpemUgICAgICBJbnRlcmFjdGl2ZSAxMC10YWIgVFVJIChwcm9ncmVzcywgdGltZWxpbmUsIGRlcHMsIG1ldHJpY3MsIGhlYWx0aCwgYWdlbnQsIGNoYW5nZXMsIGtub3dsZWRnZSwgY2FwdHVyZXMsIGV4cG9ydClcIixcbiAgICBcIiAgL2dzZCBicmllZiA8bW9kZT4gICBHZW5lcmF0ZSBhIHZpc3VhbCBIVE1MIGJyaWVmICBbZGlhZ3JhbXxwbGFufGRpZmZ8cmVjYXB8dGFibGV8c2xpZGVzXSBbdG9waWNdIFstLXNsaWRlc11cIixcbiAgICBcIiAgL2dzZCBxdWV1ZSAgICAgICAgICBTaG93IHF1ZXVlZC9kaXNwYXRjaGVkIHVuaXRzIGFuZCBleGVjdXRpb24gb3JkZXJcIixcbiAgICBcIiAgL2dzZCBoaXN0b3J5ICAgICAgICBWaWV3IGV4ZWN1dGlvbiBoaXN0b3J5ICBbLS1jb3N0XSBbLS1waGFzZV0gWy0tbW9kZWxdIFtOXVwiLFxuICAgIFwiICAvZ3NkIGNoYW5nZWxvZyAgICAgIFNob3cgY2F0ZWdvcml6ZWQgcmVsZWFzZSBub3RlcyAgW3ZlcnNpb25dXCIsXG4gICAgYCAgL2dzZCBub3RpZmljYXRpb25zICBWaWV3IHBlcnNpc3RlbnQgbm90aWZpY2F0aW9uIGhpc3RvcnkgIFtjbGVhcnx0YWlsfGZpbHRlcl0gICgke2Zvcm1hdHRlZFNob3J0Y3V0UGFpcihcIm5vdGlmaWNhdGlvbnNcIil9KWAsXG4gICAgXCIgIC9nc2QgbG9ncyAgICAgICAgICAgQnJvd3NlIGFjdGl2aXR5IGxvZ3MsIGRlYnVnIGxvZ3MsIGFuZCBtZXRyaWNzICBbZGVidWd8dGFpbHxjbGVhcl1cIixcbiAgICBcIiAgL2dzZCBkZWJ1ZyAgICAgICAgICBDcmVhdGUvbGlzdC9jb250aW51ZSBwZXJzaXN0ZW50IGRlYnVnIHNlc3Npb25zXCIsXG4gICAgXCJcIixcbiAgICBcIkNPVVJTRSBDT1JSRUNUSU9OXCIsXG4gICAgXCIgIC9nc2Qgc3RlZXIgPGRlc2M+ICAgQXBwbHkgdXNlciBvdmVycmlkZSB0byBhY3RpdmUgd29ya1wiLFxuICAgIFwiICAvZ3NkIGNhcHR1cmUgPHRleHQ+IFF1aWNrLWNhcHR1cmUgYSB0aG91Z2h0IHRvIENBUFRVUkVTLm1kXCIsXG4gICAgXCIgIC9nc2QgdHJpYWdlICAgICAgICAgQ2xhc3NpZnkgYW5kIHJvdXRlIHBlbmRpbmcgY2FwdHVyZXNcIixcbiAgICBcIiAgL2dzZCBza2lwIDx1bml0PiAgICBQcmV2ZW50IGEgdW5pdCBmcm9tIGF1dG8tbW9kZSBkaXNwYXRjaFwiLFxuICAgIFwiICAvZ3NkIHVuZG8gICAgICAgICAgIFJldmVydCBsYXN0IGNvbXBsZXRlZCB1bml0ICBbLS1mb3JjZV1cIixcbiAgICBcIiAgL2dzZCB1bmRvLXRhc2sgICAgICBSZXNldCBhIHNwZWNpZmljIHRhc2sncyBjb21wbGV0aW9uIHN0YXRlICBbREIgKyBtYXJrZG93bl1cIixcbiAgICBcIiAgL2dzZCByZXNldC1zbGljZSAgICBSZXNldCBhIHNsaWNlIGFuZCBhbGwgaXRzIHRhc2tzICBbREIgKyBtYXJrZG93bl1cIixcbiAgICBcIiAgL2dzZCByYXRlICAgICAgICAgICBSYXRlIGxhc3QgdW5pdCdzIG1vZGVsIHRpZXIgIFtvdmVyfG9rfHVuZGVyXVwiLFxuICAgIFwiICAvZ3NkIHJldGhpbmsgICAgICAgIENvbnZlcnNhdGlvbmFsIHByb2plY3QgcmVvcmdhbml6YXRpb24gXHUyMDE0IHJlb3JkZXIsIHBhcmssIGRpc2NhcmQsIGFkZCBtaWxlc3RvbmVzXCIsXG4gICAgXCIgIC9nc2QgcGFyayBbaWRdICAgICAgUGFyayBhIG1pbGVzdG9uZSBcdTIwMTQgc2tpcCB3aXRob3V0IGRlbGV0aW5nICBbcmVhc29uXVwiLFxuICAgIFwiICAvZ3NkIHVucGFyayBbaWRdICAgIFJlYWN0aXZhdGUgYSBwYXJrZWQgbWlsZXN0b25lXCIsXG4gICAgXCJcIixcbiAgICBcIlBST0pFQ1QgS05PV0xFREdFXCIsXG4gICAgXCIgIC9nc2Qga25vd2xlZGdlIDx0eXBlPiA8dGV4dD4gICBBZGQgYSBydWxlIHRvIEtOT1dMRURHRS5tZCBvciBjYXB0dXJlIGEgcGF0dGVybi9sZXNzb24gdG8gbWVtb3JpZXNcIixcbiAgICBcIiAgL2dzZCBjb2RlYmFzZSBbZ2VuZXJhdGV8dXBkYXRlfHN0YXRzXSAgIE1hbmFnZSB0aGUgQ09ERUJBU0UubWQgY2FjaGUgdXNlZCBpbiBwcm9tcHQgY29udGV4dFwiLFxuICAgIFwiXCIsXG4gICAgXCJTSElQUElORyAmIEJBQ0tMT0dcIixcbiAgICBcIiAgL2dzZCBzaGlwICAgICAgICAgICBDcmVhdGUgYSBQUiBmcm9tIG1pbGVzdG9uZSBhcnRpZmFjdHMgIFstLWRyeS1ydW58LS1kcmFmdHwtLWJhc2V8LS1mb3JjZV1cIixcbiAgICBcIiAgL2dzZCBkbyA8dGV4dD4gICAgICBSb3V0ZSBmcmVlZm9ybSB0ZXh0IHRvIHRoZSByaWdodCBHU0QgY29tbWFuZFwiLFxuICAgIFwiICAvZ3NkIHNlc3Npb24tcmVwb3J0IFNob3cgc2Vzc2lvbiBjb3N0LCB0b2tlbnMsIGFuZCB3b3JrIHN1bW1hcnkgIFstLWpzb258LS1zYXZlXVwiLFxuICAgIFwiICAvZ3NkIGJhY2tsb2cgICAgICAgIE1hbmFnZSBiYWNrbG9nIGl0ZW1zICBbYWRkfHByb21vdGV8cmVtb3ZlfGxpc3RdXCIsXG4gICAgXCIgIC9nc2QgcHItYnJhbmNoICAgICAgQ3JlYXRlIGEgY2xlYW4gUFIgYnJhbmNoIGZpbHRlcmluZyAuZ3NkLyBjb21taXRzICBbLS1kcnktcnVufC0tbmFtZV1cIixcbiAgICBcIiAgL2dzZCBhZGQtdGVzdHMgICAgICBHZW5lcmF0ZSB0ZXN0cyBmb3IgY29tcGxldGVkIHNsaWNlc1wiLFxuICAgIFwiICAvZ3NkIGV2YWwtcmV2aWV3IDxzbGljZUlkPiAgQXVkaXQgYSBzbGljZSdzIEFJIGV2YWx1YXRpb24gc3RyYXRlZ3kgIFstLWZvcmNlfC0tc2hvd11cIixcbiAgICBcIiAgL2dzZCBzY2FuICAgICAgICAgICBSYXBpZCBjb2RlYmFzZSBhc3Nlc3NtZW50ICBbLS1mb2N1cyB0ZWNofGFyY2h8cXVhbGl0eXxjb25jZXJuc3x0ZWNoK2FyY2hdXCIsXG4gICAgXCJcIixcbiAgICBcIlNFVFVQICYgQ09ORklHVVJBVElPTlwiLFxuICAgIFwiICAvZ3NkIG9uYm9hcmRpbmcgICAgIFJlLXJ1biBzZXR1cCB3aXphcmQgIFstLXJlc3VtZXwtLXJlc2V0fC0tc3RlcCA8bmFtZT5dXCIsXG4gICAgXCIgIC9nc2Qgc2V0dXAgICAgICAgICAgQ29uZmlndXJhdGlvbiBodWIgIFtsbG18bW9kZWx8c2VhcmNofHJlbW90ZXxrZXlzfHByZWZzfG9uYm9hcmRpbmddXCIsXG4gICAgXCIgIC9nc2QgaW5pdCAgICAgICAgICAgUHJvamVjdCBpbml0IHdpemFyZCBcdTIwMTQgZGV0ZWN0LCBjb25maWd1cmUsIGJvb3RzdHJhcCAuZ3NkL1wiLFxuICAgIFwiICAvZ3NkIG1vZGVsICAgICAgICAgIFN3aXRjaCBhY3RpdmUgc2Vzc2lvbiBtb2RlbCAgW3Byb3ZpZGVyL21vZGVsfG1vZGVsLWlkXVwiLFxuICAgIFwiICAvZ3NkIG1vZGUgICAgICAgICAgIFNldCB3b3JrZmxvdyBtb2RlIChzb2xvL3RlYW0pICBbZ2xvYmFsfHByb2plY3RdXCIsXG4gICAgXCIgIC9nc2QgcHJlZnMgICAgICAgICAgTWFuYWdlIHByZWZlcmVuY2VzICBbZ2xvYmFsfHByb2plY3R8c3RhdHVzfHdpemFyZHxzZXR1cHxpbXBvcnQtY2xhdWRlXSAgKGFsaWFzIGZvciAvZ3NkIHNldHVwIHByZWZzKVwiLFxuICAgIFwiICAvZ3NkIGNtdXggICAgICAgICAgIE1hbmFnZSBjbXV4IGludGVncmF0aW9uICBbc3RhdHVzfG9ufG9mZnxub3RpZmljYXRpb25zfHNpZGViYXJ8c3BsaXRzfGJyb3dzZXJdXCIsXG4gICAgXCIgIC9nc2Qga2V5cyAgICAgICAgICAgQVBJIGtleSBtYW5hZ2VyIChMTE0gKyB0b29sIGtleXMpICBbbGlzdHxhZGR8cmVtb3ZlfHRlc3R8cm90YXRlfGRvY3Rvcl1cIixcbiAgICBcIiAgL2dzZCBjb25maWcgICAgICAgICAoZGVwcmVjYXRlZCkgU2V0IHRvb2wgQVBJIGtleXMgXHUyMDE0IHVzZSAvZ3NkIGtleXMgaW5zdGVhZFwiLFxuICAgIFwiICAvZ3NkIHNob3ctY29uZmlnICAgIFNob3cgZWZmZWN0aXZlIGNvbmZpZ3VyYXRpb24gKG1vZGVscywgcm91dGluZywgdG9nZ2xlcylcIixcbiAgICBcIiAgL2dzZCBob29rcyAgICAgICAgICBTaG93IHBvc3QtdW5pdCBob29rIGNvbmZpZ3VyYXRpb25cIixcbiAgICBcIiAgL2dzZCBydW4taG9vayAgICAgICBNYW51YWxseSB0cmlnZ2VyIGEgc3BlY2lmaWMgaG9va1wiLFxuICAgIFwiICAvZ3NkIHNraWxsLWhlYWx0aCAgIFNraWxsIGxpZmVjeWNsZSBkYXNoYm9hcmRcIixcbiAgICBcIiAgL2dzZCBleHRlbnNpb25zICAgICBNYW5hZ2UgZXh0ZW5zaW9ucyAgW2xpc3R8ZW5hYmxlfGRpc2FibGV8aW5mb11cIixcbiAgICBcIiAgL2dzZCBmYXN0ICAgICAgICAgICBUb2dnbGUgT3BlbkFJIHNlcnZpY2UgdGllciAgW29ufG9mZnxmbGV4fHN0YXR1c11cIixcbiAgICBcIiAgL2dzZCBtY3AgICAgICAgICAgICBNQ1Agc2VydmVyIHN0YXR1cyBhbmQgY29ubmVjdGl2aXR5ICBbc3RhdHVzfGNoZWNrIDxzZXJ2ZXI+fGluaXQgW2Rpcl1dXCIsXG4gICAgXCJcIixcbiAgICBcIk1BSU5URU5BTkNFXCIsXG4gICAgXCIgIC9nc2QgZG9jdG9yICAgICAgICAgRGlhZ25vc2UgYW5kIHJlcGFpciAuZ3NkLyBzdGF0ZSAgW2F1ZGl0fGZpeHxoZWFsXSBbc2NvcGVdXCIsXG4gICAgXCIgIC9nc2QgZm9yZW5zaWNzICAgICAgRXhhbWluZSBleGVjdXRpb24gbG9ncyBhbmQgcG9zdC1tb3J0ZW0gYW5hbHlzaXNcIixcbiAgICBcIiAgL2dzZCBleHBvcnQgICAgICAgICBFeHBvcnQgbWlsZXN0b25lL3NsaWNlIHJlc3VsdHMgIFstLWpzb258LS1tYXJrZG93bnwtLWh0bWxdIFstLWFsbF1cIixcbiAgICBcIiAgL2dzZCBjbGVhbnVwICAgICAgICBSZW1vdmUgbWVyZ2VkIGJyYW5jaGVzIG9yIHNuYXBzaG90cyAgW2JyYW5jaGVzfHNuYXBzaG90c11cIixcbiAgICBcIiAgL2dzZCB3b3JrdHJlZSAgICAgICBNYW5hZ2Ugd29ya3RyZWVzIGZyb20gdGhlIFRVSSAgW2xpc3R8bWVyZ2V8Y2xlYW58cmVtb3ZlXVwiLFxuICAgIFwiICAvZ3NkIG1pZ3JhdGUgICAgICAgIE1pZ3JhdGUgLnBsYW5uaW5nLyAodjEpIHRvIC5nc2QvICh2MikgZm9ybWF0XCIsXG4gICAgXCIgIC9nc2QgcmVtb3RlICAgICAgICAgQ29udHJvbCByZW1vdGUgYXV0by1tb2RlICBbc2xhY2t8ZGlzY29yZHxzdGF0dXN8ZGlzY29ubmVjdF1cIixcbiAgICBcIiAgL2dzZCBpbnNwZWN0ICAgICAgICBTaG93IFNRTGl0ZSBEQiBkaWFnbm9zdGljcyAoc2NoZW1hLCByb3cgY291bnRzLCByZWNlbnQgZW50cmllcylcIixcbiAgICBcIiAgL2dzZCB1cGRhdGUgICAgICAgICBVcGRhdGUgR1NEIHRvIHRoZSBsYXRlc3QgdmVyc2lvbiB2aWEgbnBtXCIsXG4gICAgXCIgIC9nc2QgbGFuZ3VhZ2UgICAgICAgU2V0IG9yIGNsZWFyIHRoZSBnbG9iYWwgcmVzcG9uc2UgbGFuZ3VhZ2UgIFtvZmZ8Y2xlYXJ8PGxhbmd1YWdlPl1cIixcbiAgXTtcbiAgY29uc3QgZnVsbCA9IFtcImZ1bGxcIiwgXCItLWZ1bGxcIiwgXCJhbGxcIl0uaW5jbHVkZXMoYXJncy50cmltKCkudG9Mb3dlckNhc2UoKSk7XG4gIGN0eC51aS5ub3RpZnkoKGZ1bGwgPyBmdWxsTGluZXMgOiBzdW1tYXJ5TGluZXMpLmpvaW4oXCJcXG5cIiksIFwiaW5mb1wiKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZVN0YXR1cyhjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGJhc2VQYXRoID0gcHJvamVjdFJvb3QoKTtcbiAgLy8gT3BlbiBEQiBpbiBjb2xkIHNlc3Npb25zIHNvIHN0YXR1cyB1c2VzIERCLWJhY2tlZCBzdGF0ZSwgbm90IGZpbGVzeXN0ZW0gZmFsbGJhY2sgKCMzMzg1KVxuICBjb25zdCB7IGVuc3VyZURiT3BlbiB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vLi4vYm9vdHN0cmFwL2R5bmFtaWMtdG9vbHMuanNcIik7XG4gIGF3YWl0IGVuc3VyZURiT3BlbigpO1xuICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2VQYXRoKTtcblxuICBpZiAoc3RhdGUucmVnaXN0cnkubGVuZ3RoID09PSAwKSB7XG4gICAgY3R4LnVpLm5vdGlmeShcIk5vIEdTRCBtaWxlc3RvbmVzIGZvdW5kLiBSdW4gL2dzZCB0byBzdGFydC5cIiwgXCJpbmZvXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHsgR1NERGFzaGJvYXJkT3ZlcmxheSB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vLi4vZGFzaGJvYXJkLW92ZXJsYXkuanNcIik7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGN0eC51aS5jdXN0b208Ym9vbGVhbj4oXG4gICAgKHR1aSwgdGhlbWUsIF9rYiwgZG9uZSkgPT4gbmV3IEdTRERhc2hib2FyZE92ZXJsYXkodHVpLCB0aGVtZSwgKCkgPT4gZG9uZSh0cnVlKSksXG4gICAge1xuICAgICAgb3ZlcmxheTogdHJ1ZSxcbiAgICAgIG92ZXJsYXlPcHRpb25zOiB7XG4gICAgICAgIHdpZHRoOiBcIjkwJVwiLFxuICAgICAgICBtaW5XaWR0aDogODAsXG4gICAgICAgIG1heEhlaWdodDogXCI5MiVcIixcbiAgICAgICAgYW5jaG9yOiBcImNlbnRlclwiLFxuICAgICAgfSxcbiAgICB9LFxuICApO1xuXG4gIGlmIChyZXN1bHQgPT09IHVuZGVmaW5lZCkge1xuICAgIGN0eC51aS5ub3RpZnkoZm9ybWF0VGV4dFN0YXR1cyhzdGF0ZSksIFwiaW5mb1wiKTtcbiAgfVxufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmlyZVN0YXR1c1ZpYUNvbW1hbmQoY3R4OiBFeHRlbnNpb25Db250ZXh0KTogUHJvbWlzZTx2b2lkPiB7XG4gIGF3YWl0IGhhbmRsZVN0YXR1cyhjdHggYXMgRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQpO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlVmlzdWFsaXplKGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgaWYgKCFjdHguaGFzVUkpIHtcbiAgICBjdHgudWkubm90aWZ5KFwiVmlzdWFsaXplciByZXF1aXJlcyBhbiBpbnRlcmFjdGl2ZSB0ZXJtaW5hbC5cIiwgXCJ3YXJuaW5nXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHsgR1NEVmlzdWFsaXplck92ZXJsYXkgfSA9IGF3YWl0IGltcG9ydChcIi4uLy4uL3Zpc3VhbGl6ZXItb3ZlcmxheS5qc1wiKTtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY3R4LnVpLmN1c3RvbTxib29sZWFuPihcbiAgICAodHVpLCB0aGVtZSwgX2tiLCBkb25lKSA9PiBuZXcgR1NEVmlzdWFsaXplck92ZXJsYXkodHVpLCB0aGVtZSwgKCkgPT4gZG9uZSh0cnVlKSksXG4gICAge1xuICAgICAgb3ZlcmxheTogdHJ1ZSxcbiAgICAgIG92ZXJsYXlPcHRpb25zOiB7XG4gICAgICAgIHdpZHRoOiBcIjgwJVwiLFxuICAgICAgICBtaW5XaWR0aDogODAsXG4gICAgICAgIG1heEhlaWdodDogXCI5MCVcIixcbiAgICAgICAgYW5jaG9yOiBcImNlbnRlclwiLFxuICAgICAgfSxcbiAgICB9LFxuICApO1xuXG4gIGlmIChyZXN1bHQgPT09IHVuZGVmaW5lZCkge1xuICAgIGN0eC51aS5ub3RpZnkoXCJWaXN1YWxpemVyIHJlcXVpcmVzIGFuIGludGVyYWN0aXZlIHRlcm1pbmFsLiBVc2UgL2dzZCBzdGF0dXMgZm9yIGEgdGV4dC1iYXNlZCBvdmVydmlldy5cIiwgXCJ3YXJuaW5nXCIpO1xuICB9XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBoYW5kbGVCcmllZihhcmdzOiBzdHJpbmcsIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsIHBpPzogRXh0ZW5zaW9uQVBJKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHJlcXVlc3QgPSBwYXJzZVZpc3VhbEJyaWVmQXJncyhhcmdzKTtcbiAgaWYgKCFyZXF1ZXN0KSB7XG4gICAgY3R4LnVpLm5vdGlmeShWSVNVQUxfQlJJRUZfVVNBR0UsIFwiaW5mb1wiKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAoIXBpPy5zZW5kVXNlck1lc3NhZ2UpIHtcbiAgICBjdHgudWkubm90aWZ5KFwiVmlzdWFsIGJyaWVmIGdlbmVyYXRpb24gaXMgdW5hdmFpbGFibGUgaW4gdGhpcyBjb250ZXh0LlwiLCBcIndhcm5pbmdcIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3Qgb3V0cHV0RGlyID0gZ2V0VmlzdWFsQnJpZWZPdXRwdXREaXIoKTtcbiAgY29uc3QgdmVyc2lvbiA9IHJlc29sdmVHc2RWZXJzaW9uKCk7XG4gIHBpLnNlbmRVc2VyTWVzc2FnZShidWlsZFZpc3VhbEJyaWVmUHJvbXB0KHJlcXVlc3QsIHsgb3V0cHV0RGlyLCB2ZXJzaW9uIH0pKTtcbn1cblxuY29uc3QgYnJpZWZSZXF1aXJlID0gY3JlYXRlUmVxdWlyZShpbXBvcnQubWV0YS51cmwpO1xuXG5mdW5jdGlvbiByZXNvbHZlR3NkVmVyc2lvbigpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBjb25zdCBlbnZWZXJzaW9uID0gcHJvY2Vzcy5lbnYuR1NEX1ZFUlNJT04/LnRyaW0oKTtcbiAgaWYgKGVudlZlcnNpb24pIHJldHVybiBlbnZWZXJzaW9uO1xuICB0cnkge1xuICAgIGNvbnN0IHBrZyA9IGJyaWVmUmVxdWlyZShcIi4uLy4uLy4uLy4uLy4uLy4uL3BhY2thZ2UuanNvblwiKSBhcyB7IHZlcnNpb24/OiB1bmtub3duIH07XG4gICAgY29uc3QgZnJvbVBrZyA9IHR5cGVvZiBwa2cudmVyc2lvbiA9PT0gXCJzdHJpbmdcIiA/IHBrZy52ZXJzaW9uLnRyaW0oKSA6IFwiXCI7XG4gICAgcmV0dXJuIGZyb21Qa2cgfHwgdW5kZWZpbmVkO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBoYW5kbGVTZXR1cChhcmdzOiBzdHJpbmcsIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsIHBpPzogRXh0ZW5zaW9uQVBJKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHsgZGV0ZWN0UHJvamVjdFN0YXRlLCBoYXNHbG9iYWxTZXR1cCB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vLi4vZGV0ZWN0aW9uLmpzXCIpO1xuICBjb25zdCB7IGlzT25ib2FyZGluZ0NvbXBsZXRlLCByZWFkT25ib2FyZGluZ1JlY29yZCB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vLi4vb25ib2FyZGluZy1zdGF0ZS5qc1wiKTtcblxuICAvLyBTdWItcm91dGUgZGlzcGF0Y2ggXHUyMDE0IGtlZXAgcmVkaXJlY3RzIGJ1dCByb3V0ZSB0aGUgY2Fub25pY2FsIHdvcmsgdG8gL2dzZFxuICAvLyBvbmJvYXJkaW5nIChzaW5nbGUgc291cmNlIGZvciB3aXphcmQgc3RlcHMpIGFuZCAvZ3NkIGtleXMgKHNpbmdsZSBzb3VyY2VcbiAgLy8gZm9yIGNyZWRlbnRpYWxzKS5cbiAgaWYgKGFyZ3MgPT09IFwib25ib2FyZGluZ1wiIHx8IGFyZ3MgPT09IFwid2l6YXJkXCIpIHtcbiAgICBjb25zdCB7IGhhbmRsZU9uYm9hcmRpbmcgfSA9IGF3YWl0IGltcG9ydChcIi4vb25ib2FyZGluZy5qc1wiKTtcbiAgICBhd2FpdCBoYW5kbGVPbmJvYXJkaW5nKFwiXCIsIGN0eCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmIChhcmdzID09PSBcImxsbVwiIHx8IGFyZ3MgPT09IFwiYXV0aFwiKSB7XG4gICAgY29uc3QgeyBoYW5kbGVPbmJvYXJkaW5nIH0gPSBhd2FpdCBpbXBvcnQoXCIuL29uYm9hcmRpbmcuanNcIik7XG4gICAgYXdhaXQgaGFuZGxlT25ib2FyZGluZyhcIi0tc3RlcCBsbG1cIiwgY3R4KTtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKGFyZ3MgPT09IFwic2VhcmNoXCIpIHtcbiAgICBjb25zdCB7IGhhbmRsZU9uYm9hcmRpbmcgfSA9IGF3YWl0IGltcG9ydChcIi4vb25ib2FyZGluZy5qc1wiKTtcbiAgICBhd2FpdCBoYW5kbGVPbmJvYXJkaW5nKFwiLS1zdGVwIHNlYXJjaFwiLCBjdHgpO1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAoYXJncyA9PT0gXCJyZW1vdGVcIikge1xuICAgIGNvbnN0IHsgaGFuZGxlT25ib2FyZGluZyB9ID0gYXdhaXQgaW1wb3J0KFwiLi9vbmJvYXJkaW5nLmpzXCIpO1xuICAgIGF3YWl0IGhhbmRsZU9uYm9hcmRpbmcoXCItLXN0ZXAgcmVtb3RlXCIsIGN0eCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmIChhcmdzID09PSBcIm1vZGVsXCIpIHtcbiAgICBhd2FpdCBoYW5kbGVNb2RlbChcIlwiLCBjdHgsIHBpKTtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKGFyZ3MgPT09IFwia2V5c1wiKSB7XG4gICAgY3R4LnVpLm5vdGlmeShcIlRpcDogL2dzZCBrZXlzIGlzIHRoZSBjYW5vbmljYWwgY29tbWFuZCBmb3IgQVBJIGtleSBtYW5hZ2VtZW50LlwiLCBcImluZm9cIik7XG4gICAgY29uc3QgeyBoYW5kbGVLZXlzIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi8uLi9rZXktbWFuYWdlci5qc1wiKTtcbiAgICBhd2FpdCBoYW5kbGVLZXlzKFwiXCIsIGN0eCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmIChhcmdzID09PSBcInByZWZzXCIpIHtcbiAgICBhd2FpdCBlbnN1cmVQcmVmZXJlbmNlc0ZpbGUoZ2V0R2xvYmFsR1NEUHJlZmVyZW5jZXNQYXRoKCksIGN0eCwgXCJnbG9iYWxcIik7XG4gICAgYXdhaXQgaGFuZGxlUHJlZnNXaXphcmQoY3R4LCBcImdsb2JhbFwiKTtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBCYXJlIC9nc2Qgc2V0dXAgXHUyMDE0IHJlbmRlciB0aGUgaHViOiBzdGF0dXMgKyBhY3Rpb25zXG4gIGNvbnN0IGdsb2JhbENvbmZpZ3VyZWQgPSBoYXNHbG9iYWxTZXR1cCgpO1xuICBjb25zdCBkZXRlY3Rpb24gPSBkZXRlY3RQcm9qZWN0U3RhdGUocHJvamVjdFJvb3QoKSk7XG4gIGNvbnN0IG9uYm9hcmRpbmdEb25lID0gaXNPbmJvYXJkaW5nQ29tcGxldGUoKTtcbiAgY29uc3QgcmVjb3JkID0gcmVhZE9uYm9hcmRpbmdSZWNvcmQoKTtcblxuICBjb25zdCBzdGF0dXNMaW5lczogc3RyaW5nW10gPSBbXCJHU0QgU2V0dXBcXG5cIl07XG4gIHN0YXR1c0xpbmVzLnB1c2goXG4gICAgb25ib2FyZGluZ0RvbmVcbiAgICAgID8gYCAgT25ib2FyZGluZzogICAgICAgICBcdTI3MTMgY29tcGxldGUke3JlY29yZC5jb21wbGV0ZWRBdCA/IGAgKCR7cmVjb3JkLmNvbXBsZXRlZEF0LnNsaWNlKDAsIDEwKX0pYCA6IFwiXCJ9YFxuICAgICAgOiBgICBPbmJvYXJkaW5nOiAgICAgICAgIFx1MjVDQiBub3QgY29tcGxldGUgIFx1MjAxNCAgL2dzZCBvbmJvYXJkaW5nIHRvIHN0YXJ0YCxcbiAgKTtcbiAgc3RhdHVzTGluZXMucHVzaChgICBHbG9iYWwgcHJlZmVyZW5jZXM6ICR7Z2xvYmFsQ29uZmlndXJlZCA/IFwiY29uZmlndXJlZFwiIDogXCJub3Qgc2V0XCJ9YCk7XG4gIHN0YXR1c0xpbmVzLnB1c2goYCAgUHJvamVjdCBzdGF0ZTogICAgICAke2RldGVjdGlvbi5zdGF0ZX1gKTtcbiAgaWYgKGRldGVjdGlvbi5wcm9qZWN0U2lnbmFscy5wcmltYXJ5TGFuZ3VhZ2UpIHtcbiAgICBzdGF0dXNMaW5lcy5wdXNoKGAgIERldGVjdGVkOiAgICAgICAgICAgJHtkZXRlY3Rpb24ucHJvamVjdFNpZ25hbHMucHJpbWFyeUxhbmd1YWdlfWApO1xuICB9XG5cbiAgY3R4LnVpLm5vdGlmeShzdGF0dXNMaW5lcy5qb2luKFwiXFxuXCIpLCBcImluZm9cIik7XG4gIGN0eC51aS5ub3RpZnkoXG4gICAgXCJDb25maWd1cmF0aW9uIGh1YjpcXG5cIiArXG4gICAgXCIgIC9nc2Qgc2V0dXAgbGxtICAgICAgICBcdTIwMTQgTExNIHByb3ZpZGVyICYgYXV0aFxcblwiICtcbiAgICBcIiAgL2dzZCBzZXR1cCBtb2RlbCAgICAgIFx1MjAxNCBEZWZhdWx0IG1vZGVsIHBpY2tlclxcblwiICtcbiAgICBcIiAgL2dzZCBzZXR1cCBzZWFyY2ggICAgIFx1MjAxNCBXZWIgc2VhcmNoIHByb3ZpZGVyXFxuXCIgK1xuICAgIFwiICAvZ3NkIHNldHVwIHJlbW90ZSAgICAgXHUyMDE0IFJlbW90ZSBxdWVzdGlvbnMgKERpc2NvcmQvU2xhY2svVGVsZWdyYW0pXFxuXCIgK1xuICAgIFwiICAvZ3NkIHNldHVwIGtleXMgICAgICAgXHUyMDE0IEFQSSBrZXlzIChhbGlhcyBmb3IgL2dzZCBrZXlzKVxcblwiICtcbiAgICBcIiAgL2dzZCBzZXR1cCBwcmVmcyAgICAgIFx1MjAxNCBHbG9iYWwgcHJlZmVyZW5jZXMgKGFsaWFzIGZvciAvZ3NkIHByZWZzKVxcblwiICtcbiAgICBcIiAgL2dzZCBzZXR1cCBvbmJvYXJkaW5nIFx1MjAxNCBGdWxsIHdpemFyZCAoYWxpYXMgZm9yIC9nc2Qgb25ib2FyZGluZylcXG5cXG5cIiArXG4gICAgXCJUaXA6IC9nc2Qgb25ib2FyZGluZyAtLXJlc3VtZSB0byBjb250aW51ZSBhbiBpbmNvbXBsZXRlIHNldHVwLlwiLFxuICAgIFwiaW5mb1wiLFxuICApO1xufVxuXG5mdW5jdGlvbiBzb3J0TW9kZWxzRm9yU2VsZWN0aW9uKG1vZGVsczogTW9kZWw8YW55PltdLCBjdXJyZW50TW9kZWw6IE1vZGVsPGFueT4gfCB1bmRlZmluZWQpOiBNb2RlbDxhbnk+W10ge1xuICByZXR1cm4gWy4uLm1vZGVsc10uc29ydCgoYSwgYikgPT4ge1xuICAgIGNvbnN0IGFDdXJyZW50ID0gY3VycmVudE1vZGVsICYmIGEucHJvdmlkZXIgPT09IGN1cnJlbnRNb2RlbC5wcm92aWRlciAmJiBhLmlkID09PSBjdXJyZW50TW9kZWwuaWQ7XG4gICAgY29uc3QgYkN1cnJlbnQgPSBjdXJyZW50TW9kZWwgJiYgYi5wcm92aWRlciA9PT0gY3VycmVudE1vZGVsLnByb3ZpZGVyICYmIGIuaWQgPT09IGN1cnJlbnRNb2RlbC5pZDtcbiAgICBpZiAoYUN1cnJlbnQgJiYgIWJDdXJyZW50KSByZXR1cm4gLTE7XG4gICAgaWYgKCFhQ3VycmVudCAmJiBiQ3VycmVudCkgcmV0dXJuIDE7XG4gICAgY29uc3QgcHJvdmlkZXJDbXAgPSBhLnByb3ZpZGVyLmxvY2FsZUNvbXBhcmUoYi5wcm92aWRlcik7XG4gICAgaWYgKHByb3ZpZGVyQ21wICE9PSAwKSByZXR1cm4gcHJvdmlkZXJDbXA7XG4gICAgcmV0dXJuIGEuaWQubG9jYWxlQ29tcGFyZShiLmlkKTtcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkUHJvdmlkZXJNb2RlbEdyb3VwcyhcbiAgbW9kZWxzOiBNb2RlbDxhbnk+W10sXG4gIGN1cnJlbnRNb2RlbDogTW9kZWw8YW55PiB8IHVuZGVmaW5lZCxcbik6IE1hcDxzdHJpbmcsIE1vZGVsPGFueT5bXT4ge1xuICBjb25zdCBieVByb3ZpZGVyID0gbmV3IE1hcDxzdHJpbmcsIE1vZGVsPGFueT5bXT4oKTtcblxuICBmb3IgKGNvbnN0IG1vZGVsIG9mIHNvcnRNb2RlbHNGb3JTZWxlY3Rpb24obW9kZWxzLCBjdXJyZW50TW9kZWwpKSB7XG4gICAgbGV0IGdyb3VwID0gYnlQcm92aWRlci5nZXQobW9kZWwucHJvdmlkZXIpO1xuICAgIGlmICghZ3JvdXApIHtcbiAgICAgIGdyb3VwID0gW107XG4gICAgICBieVByb3ZpZGVyLnNldChtb2RlbC5wcm92aWRlciwgZ3JvdXApO1xuICAgIH1cbiAgICBncm91cC5wdXNoKG1vZGVsKTtcbiAgfVxuICByZXR1cm4gYnlQcm92aWRlcjtcbn1cblxuYXN5bmMgZnVuY3Rpb24gc2VsZWN0TW9kZWxCeVByb3ZpZGVyKFxuICB0aXRsZTogc3RyaW5nLFxuICBtb2RlbHM6IE1vZGVsPGFueT5bXSxcbiAgY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCxcbiAgY3VycmVudE1vZGVsOiBNb2RlbDxhbnk+IHwgdW5kZWZpbmVkLFxuKTogUHJvbWlzZTxNb2RlbDxhbnk+IHwgdW5kZWZpbmVkPiB7XG4gIGNvbnN0IGJ5UHJvdmlkZXIgPSBidWlsZFByb3ZpZGVyTW9kZWxHcm91cHMobW9kZWxzLCBjdXJyZW50TW9kZWwpO1xuICBjb25zdCBwcm92aWRlck9wdGlvbnMgPSBBcnJheS5mcm9tKGJ5UHJvdmlkZXIuZW50cmllcygpKS5tYXAoKFtwcm92aWRlciwgZ3JvdXBdKSA9PlxuICAgIGAke3Byb3ZpZGVyfSAoJHtncm91cC5sZW5ndGh9IG1vZGVsJHtncm91cC5sZW5ndGggPT09IDEgPyBcIlwiIDogXCJzXCJ9KWAsXG4gICk7XG4gIHByb3ZpZGVyT3B0aW9ucy5wdXNoKFwiKGNhbmNlbClcIik7XG5cbiAgY29uc3QgcHJvdmlkZXJDaG9pY2UgPSBhd2FpdCBjdHgudWkuc2VsZWN0KGAke3RpdGxlfSBcdTIwMTQgY2hvb3NlIHByb3ZpZGVyOmAsIHByb3ZpZGVyT3B0aW9ucyk7XG4gIGlmICghcHJvdmlkZXJDaG9pY2UgfHwgdHlwZW9mIHByb3ZpZGVyQ2hvaWNlICE9PSBcInN0cmluZ1wiIHx8IHByb3ZpZGVyQ2hvaWNlID09PSBcIihjYW5jZWwpXCIpIHJldHVybiB1bmRlZmluZWQ7XG5cbiAgY29uc3QgcHJvdmlkZXJOYW1lID0gcHJvdmlkZXJDaG9pY2UucmVwbGFjZSgvIFxcKFxcZCsgbW9kZWxzP1xcKSQvLCBcIlwiKTtcbiAgY29uc3QgcHJvdmlkZXJNb2RlbHMgPSBieVByb3ZpZGVyLmdldChwcm92aWRlck5hbWUpO1xuICBpZiAoIXByb3ZpZGVyTW9kZWxzIHx8IHByb3ZpZGVyTW9kZWxzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHVuZGVmaW5lZDtcblxuICBjb25zdCBvcHRpb25Ub01vZGVsID0gbmV3IE1hcDxzdHJpbmcsIE1vZGVsPGFueT4+KCk7XG4gIGNvbnN0IG1vZGVsT3B0aW9ucyA9IHByb3ZpZGVyTW9kZWxzLm1hcCgobW9kZWwpID0+IHtcbiAgICBjb25zdCBpc0N1cnJlbnQgPSBjdXJyZW50TW9kZWwgJiYgbW9kZWwucHJvdmlkZXIgPT09IGN1cnJlbnRNb2RlbC5wcm92aWRlciAmJiBtb2RlbC5pZCA9PT0gY3VycmVudE1vZGVsLmlkO1xuICAgIGNvbnN0IGxhYmVsID0gYCR7aXNDdXJyZW50ID8gXCIqIFwiIDogXCJcIn0ke21vZGVsLmlkfWA7XG4gICAgb3B0aW9uVG9Nb2RlbC5zZXQobGFiZWwsIG1vZGVsKTtcbiAgICByZXR1cm4gbGFiZWw7XG4gIH0pO1xuICBtb2RlbE9wdGlvbnMucHVzaChcIihjYW5jZWwpXCIpO1xuXG4gIGNvbnN0IG1vZGVsQ2hvaWNlID0gYXdhaXQgY3R4LnVpLnNlbGVjdChgJHt0aXRsZX0gXHUyMDE0ICR7cHJvdmlkZXJOYW1lfTpgLCBtb2RlbE9wdGlvbnMpO1xuICBpZiAoIW1vZGVsQ2hvaWNlIHx8IHR5cGVvZiBtb2RlbENob2ljZSAhPT0gXCJzdHJpbmdcIiB8fCBtb2RlbENob2ljZSA9PT0gXCIoY2FuY2VsKVwiKSByZXR1cm4gdW5kZWZpbmVkO1xuICByZXR1cm4gb3B0aW9uVG9Nb2RlbC5nZXQobW9kZWxDaG9pY2UpO1xufVxuXG5hc3luYyBmdW5jdGlvbiByZXNvbHZlUmVxdWVzdGVkTW9kZWwoXG4gIHF1ZXJ5OiBzdHJpbmcsXG4gIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsXG4pOiBQcm9taXNlPE1vZGVsPGFueT4gfCB1bmRlZmluZWQ+IHtcbiAgY29uc3QgeyByZXNvbHZlTW9kZWxJZCB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vLi4vYXV0by1tb2RlbC1zZWxlY3Rpb24uanNcIik7XG4gIGNvbnN0IG1vZGVscyA9IGN0eC5tb2RlbFJlZ2lzdHJ5LmdldEF2YWlsYWJsZSgpO1xuICBjb25zdCBleGFjdCA9IHJlc29sdmVNb2RlbElkKHF1ZXJ5LCBtb2RlbHMsIGN0eC5tb2RlbD8ucHJvdmlkZXIpO1xuICBpZiAoZXhhY3QpIHJldHVybiBleGFjdDtcblxuICBjb25zdCBsb3dlclF1ZXJ5ID0gcXVlcnkudG9Mb3dlckNhc2UoKTtcbiAgY29uc3QgcGFydGlhbE1hdGNoZXMgPSBtb2RlbHMuZmlsdGVyKChtb2RlbCkgPT5cbiAgICBtb2RlbC5pZC50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKGxvd2VyUXVlcnkpXG4gICAgICB8fCBgJHttb2RlbC5wcm92aWRlcn0vJHttb2RlbC5pZH1gLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMobG93ZXJRdWVyeSksXG4gICk7XG5cbiAgaWYgKHBhcnRpYWxNYXRjaGVzLmxlbmd0aCA9PT0gMSkgcmV0dXJuIHBhcnRpYWxNYXRjaGVzWzBdO1xuICBpZiAocGFydGlhbE1hdGNoZXMubGVuZ3RoID09PSAwIHx8ICFjdHguaGFzVUkpIHJldHVybiB1bmRlZmluZWQ7XG4gIHJldHVybiBzZWxlY3RNb2RlbEJ5UHJvdmlkZXIoYE11bHRpcGxlIG1vZGVscyBtYXRjaCBcIiR7cXVlcnl9XCJgLCBwYXJ0aWFsTWF0Y2hlcywgY3R4LCBjdHgubW9kZWwpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVNb2RlbCh0cmltbWVkQXJnczogc3RyaW5nLCBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LCBwaTogRXh0ZW5zaW9uQVBJIHwgdW5kZWZpbmVkKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGF2YWlsYWJsZU1vZGVscyA9IGN0eC5tb2RlbFJlZ2lzdHJ5LmdldEF2YWlsYWJsZSgpO1xuICBpZiAoYXZhaWxhYmxlTW9kZWxzLmxlbmd0aCA9PT0gMCkge1xuICAgIGN0eC51aS5ub3RpZnkoXCJObyBhdmFpbGFibGUgbW9kZWxzIGZvdW5kLiBDaGVjayBwcm92aWRlciBhdXRoIGFuZCBtb2RlbCBkaXNjb3ZlcnkuXCIsIFwid2FybmluZ1wiKTtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKCFwaSkge1xuICAgIGN0eC51aS5ub3RpZnkoXCJNb2RlbCBzd2l0Y2hpbmcgaXMgdW5hdmFpbGFibGUgaW4gdGhpcyBjb250ZXh0LlwiLCBcIndhcm5pbmdcIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgdHJpbW1lZCA9IHRyaW1tZWRBcmdzLnRyaW0oKTtcbiAgbGV0IHRhcmdldE1vZGVsOiBNb2RlbDxhbnk+IHwgdW5kZWZpbmVkO1xuXG4gIGlmICghdHJpbW1lZCkge1xuICAgIGlmICghY3R4Lmhhc1VJKSB7XG4gICAgICBjb25zdCBjdXJyZW50ID0gY3R4Lm1vZGVsID8gYCR7Y3R4Lm1vZGVsLnByb3ZpZGVyfS8ke2N0eC5tb2RlbC5pZH1gIDogXCIobm9uZSlcIjtcbiAgICAgIGN0eC51aS5ub3RpZnkoYEN1cnJlbnQgbW9kZWw6ICR7Y3VycmVudH1cXG5Vc2FnZTogL2dzZCBtb2RlbCA8cHJvdmlkZXIvbW9kZWx8bW9kZWwtaWQ+YCwgXCJpbmZvXCIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIHRhcmdldE1vZGVsID0gYXdhaXQgc2VsZWN0TW9kZWxCeVByb3ZpZGVyKFwiU2VsZWN0IHNlc3Npb24gbW9kZWw6XCIsIGF2YWlsYWJsZU1vZGVscywgY3R4LCBjdHgubW9kZWwpO1xuICB9IGVsc2Uge1xuICAgIHRhcmdldE1vZGVsID0gYXdhaXQgcmVzb2x2ZVJlcXVlc3RlZE1vZGVsKHRyaW1tZWQsIGN0eCk7XG4gIH1cblxuICBpZiAoIXRhcmdldE1vZGVsKSB7XG4gICAgY3R4LnVpLm5vdGlmeShgTW9kZWwgXCIke3RyaW1tZWR9XCIgbm90IGZvdW5kLiBVc2UgL2dzZCBtb2RlbCB3aXRoIGFuIGV4YWN0IHByb3ZpZGVyL21vZGVsIG9yIGEgdW5pcXVlIG1vZGVsIElELmAsIFwid2FybmluZ1wiKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBvayA9IGF3YWl0IHBpLnNldE1vZGVsKHRhcmdldE1vZGVsKTtcbiAgaWYgKCFvaykge1xuICAgIGN0eC51aS5ub3RpZnkoYE5vIEFQSSBrZXkgZm9yICR7dGFyZ2V0TW9kZWwucHJvdmlkZXJ9LyR7dGFyZ2V0TW9kZWwuaWR9YCwgXCJ3YXJuaW5nXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIC9nc2QgbW9kZWwgaXMgYW4gZXhwbGljaXQgcGVyLXNlc3Npb24gcGluIGZvciBHU0QgZGlzcGF0Y2hlcy5cbiAgLy8gVGhpcyBpcyBjYXB0dXJlZCBhdCBhdXRvIGJvb3RzdHJhcCBzbyBpdCBzdXJ2aXZlcyBpbnRlcm5hbCBzZXNzaW9uXG4gIC8vIHN3aXRjaGVzIGR1cmluZyAvZ3NkIGF1dG8gYW5kIC9nc2QgbmV4dCBydW5zLlxuICBjb25zdCBzZXNzaW9uSWQgPSBjdHguc2Vzc2lvbk1hbmFnZXI/LmdldFNlc3Npb25JZD8uKCk7XG4gIGlmIChzZXNzaW9uSWQpIHtcbiAgICBzZXRTZXNzaW9uTW9kZWxPdmVycmlkZShzZXNzaW9uSWQsIHtcbiAgICAgIHByb3ZpZGVyOiB0YXJnZXRNb2RlbC5wcm92aWRlcixcbiAgICAgIGlkOiB0YXJnZXRNb2RlbC5pZCxcbiAgICB9KTtcbiAgfVxuXG4gIGN0eC51aS5ub3RpZnkoYE1vZGVsOiAke3RhcmdldE1vZGVsLnByb3ZpZGVyfS8ke3RhcmdldE1vZGVsLmlkfWAsIFwiaW5mb1wiKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZUNvcmVDb21tYW5kKFxuICB0cmltbWVkOiBzdHJpbmcsXG4gIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsXG4gIHBpPzogRXh0ZW5zaW9uQVBJLFxuKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGlmICh0cmltbWVkID09PSBcImhlbHBcIiB8fCB0cmltbWVkID09PSBcImhcIiB8fCB0cmltbWVkID09PSBcIj9cIiB8fCB0cmltbWVkLnN0YXJ0c1dpdGgoXCJoZWxwIFwiKSkge1xuICAgIHNob3dIZWxwKGN0eCwgdHJpbW1lZC5zdGFydHNXaXRoKFwiaGVscCBcIikgPyB0cmltbWVkLnNsaWNlKDUpLnRyaW0oKSA6IFwiXCIpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGlmICh0cmltbWVkID09PSBcInN0YXR1c1wiKSB7XG4gICAgYXdhaXQgaGFuZGxlU3RhdHVzKGN0eCk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgaWYgKHRyaW1tZWQgPT09IFwidmlzdWFsaXplXCIpIHtcbiAgICBhd2FpdCBoYW5kbGVWaXN1YWxpemUoY3R4KTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICBpZiAodHJpbW1lZCA9PT0gXCJicmllZlwiIHx8IHRyaW1tZWQuc3RhcnRzV2l0aChcImJyaWVmIFwiKSkge1xuICAgIGF3YWl0IGhhbmRsZUJyaWVmKHRyaW1tZWQucmVwbGFjZSgvXmJyaWVmXFxzKi8sIFwiXCIpLnRyaW0oKSwgY3R4LCBwaSk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgaWYgKHRyaW1tZWQgPT09IFwid2lkZ2V0XCIgfHwgdHJpbW1lZC5zdGFydHNXaXRoKFwid2lkZ2V0IFwiKSkge1xuICAgIGNvbnN0IHsgY3ljbGVXaWRnZXRNb2RlLCBzZXRXaWRnZXRNb2RlLCBnZXRXaWRnZXRNb2RlIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi8uLi9hdXRvLWRhc2hib2FyZC5qc1wiKTtcbiAgICBjb25zdCBhcmcgPSB0cmltbWVkLnJlcGxhY2UoL153aWRnZXRcXHMqLywgXCJcIikudHJpbSgpO1xuICAgIGlmIChhcmcgPT09IFwiZnVsbFwiIHx8IGFyZyA9PT0gXCJzbWFsbFwiIHx8IGFyZyA9PT0gXCJtaW5cIiB8fCBhcmcgPT09IFwib2ZmXCIpIHtcbiAgICAgIHNldFdpZGdldE1vZGUoYXJnKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY3ljbGVXaWRnZXRNb2RlKCk7XG4gICAgfVxuICAgIGN0eC51aS5ub3RpZnkoYFdpZGdldDogJHtnZXRXaWRnZXRNb2RlKCl9YCwgXCJpbmZvXCIpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGlmICh0cmltbWVkID09PSBcIm1vZGVsXCIgfHwgdHJpbW1lZC5zdGFydHNXaXRoKFwibW9kZWwgXCIpKSB7XG4gICAgYXdhaXQgaGFuZGxlTW9kZWwodHJpbW1lZC5yZXBsYWNlKC9ebW9kZWxcXHMqLywgXCJcIikudHJpbSgpLCBjdHgsIHBpKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICBpZiAodHJpbW1lZCA9PT0gXCJtb2RlXCIgfHwgdHJpbW1lZC5zdGFydHNXaXRoKFwibW9kZSBcIikpIHtcbiAgICBjb25zdCBtb2RlQXJncyA9IHRyaW1tZWQucmVwbGFjZSgvXm1vZGVcXHMqLywgXCJcIikudHJpbSgpO1xuICAgIGNvbnN0IHNjb3BlID0gbW9kZUFyZ3MgPT09IFwicHJvamVjdFwiID8gXCJwcm9qZWN0XCIgOiBcImdsb2JhbFwiO1xuICAgIGNvbnN0IHBhdGggPSBzY29wZSA9PT0gXCJwcm9qZWN0XCIgPyBnZXRQcm9qZWN0R1NEUHJlZmVyZW5jZXNQYXRoKCkgOiBnZXRHbG9iYWxHU0RQcmVmZXJlbmNlc1BhdGgoKTtcbiAgICBhd2FpdCBlbnN1cmVQcmVmZXJlbmNlc0ZpbGUocGF0aCwgY3R4LCBzY29wZSk7XG4gICAgYXdhaXQgaGFuZGxlUHJlZnNNb2RlKGN0eCwgc2NvcGUpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGlmICh0cmltbWVkID09PSBcInByZWZzXCIgfHwgdHJpbW1lZC5zdGFydHNXaXRoKFwicHJlZnMgXCIpKSB7XG4gICAgYXdhaXQgaGFuZGxlUHJlZnModHJpbW1lZC5yZXBsYWNlKC9ecHJlZnNcXHMqLywgXCJcIikudHJpbSgpLCBjdHgpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGlmICh0cmltbWVkID09PSBcImxhbmd1YWdlXCIgfHwgdHJpbW1lZC5zdGFydHNXaXRoKFwibGFuZ3VhZ2UgXCIpKSB7XG4gICAgYXdhaXQgaGFuZGxlTGFuZ3VhZ2UodHJpbW1lZC5yZXBsYWNlKC9ebGFuZ3VhZ2VcXHMqLywgXCJcIikudHJpbSgpLCBjdHgpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGlmICh0cmltbWVkID09PSBcImNtdXhcIiB8fCB0cmltbWVkLnN0YXJ0c1dpdGgoXCJjbXV4IFwiKSkge1xuICAgIGF3YWl0IGhhbmRsZUNtdXgodHJpbW1lZC5yZXBsYWNlKC9eY211eFxccyovLCBcIlwiKS50cmltKCksIGN0eCk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgaWYgKHRyaW1tZWQgPT09IFwic2hvdy1jb25maWdcIikge1xuICAgIGNvbnN0IHsgR1NEQ29uZmlnT3ZlcmxheSwgZm9ybWF0Q29uZmlnVGV4dCB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vLi4vY29uZmlnLW92ZXJsYXkuanNcIik7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY3R4LnVpLmN1c3RvbTxib29sZWFuPihcbiAgICAgICh0dWksIHRoZW1lLCBfa2IsIGRvbmUpID0+IG5ldyBHU0RDb25maWdPdmVybGF5KHR1aSwgdGhlbWUsICgpID0+IGRvbmUodHJ1ZSkpLFxuICAgICAge1xuICAgICAgICBvdmVybGF5OiB0cnVlLFxuICAgICAgICBvdmVybGF5T3B0aW9uczoge1xuICAgICAgICAgIHdpZHRoOiBcIjY1JVwiLFxuICAgICAgICAgIG1pbldpZHRoOiA1NSxcbiAgICAgICAgICBtYXhIZWlnaHQ6IFwiODUlXCIsXG4gICAgICAgICAgYW5jaG9yOiBcImNlbnRlclwiLFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICApO1xuICAgIGlmIChyZXN1bHQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgY3R4LnVpLm5vdGlmeShmb3JtYXRDb25maWdUZXh0KCksIFwiaW5mb1wiKTtcbiAgICB9XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgaWYgKHRyaW1tZWQgPT09IFwic2V0dXBcIiB8fCB0cmltbWVkLnN0YXJ0c1dpdGgoXCJzZXR1cCBcIikpIHtcbiAgICBhd2FpdCBoYW5kbGVTZXR1cCh0cmltbWVkLnJlcGxhY2UoL15zZXR1cFxccyovLCBcIlwiKS50cmltKCksIGN0eCwgcGkpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGlmICh0cmltbWVkID09PSBcIm9uYm9hcmRpbmdcIiB8fCB0cmltbWVkLnN0YXJ0c1dpdGgoXCJvbmJvYXJkaW5nIFwiKSkge1xuICAgIGNvbnN0IHsgaGFuZGxlT25ib2FyZGluZyB9ID0gYXdhaXQgaW1wb3J0KFwiLi9vbmJvYXJkaW5nLmpzXCIpO1xuICAgIGF3YWl0IGhhbmRsZU9uYm9hcmRpbmcodHJpbW1lZC5yZXBsYWNlKC9eb25ib2FyZGluZ1xccyovLCBcIlwiKS50cmltKCksIGN0eCk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgcmV0dXJuIGZhbHNlO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0VGV4dFN0YXR1cyhzdGF0ZTogR1NEU3RhdGUpOiBzdHJpbmcge1xuICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXCJHU0QgU3RhdHVzXFxuXCJdO1xuICBsaW5lcy5wdXNoKGZvcm1hdFByb2dyZXNzTGluZShjb21wdXRlUHJvZ3Jlc3NTY29yZSgpKSk7XG4gIGxpbmVzLnB1c2goXCJcIik7XG4gIGxpbmVzLnB1c2goYFBoYXNlOiAke3N0YXRlLnBoYXNlfWApO1xuXG4gIGlmIChzdGF0ZS5hY3RpdmVNaWxlc3RvbmUpIHtcbiAgICBsaW5lcy5wdXNoKGBBY3RpdmUgbWlsZXN0b25lOiAke3N0YXRlLmFjdGl2ZU1pbGVzdG9uZS5pZH0gXHUyMDE0ICR7c3RhdGUuYWN0aXZlTWlsZXN0b25lLnRpdGxlfWApO1xuICB9XG4gIGlmIChzdGF0ZS5hY3RpdmVTbGljZSkge1xuICAgIGxpbmVzLnB1c2goYEFjdGl2ZSBzbGljZTogJHtzdGF0ZS5hY3RpdmVTbGljZS5pZH0gXHUyMDE0ICR7c3RhdGUuYWN0aXZlU2xpY2UudGl0bGV9YCk7XG4gIH1cbiAgaWYgKHN0YXRlLmFjdGl2ZVRhc2spIHtcbiAgICBsaW5lcy5wdXNoKGBBY3RpdmUgdGFzazogJHtzdGF0ZS5hY3RpdmVUYXNrLmlkfSBcdTIwMTQgJHtzdGF0ZS5hY3RpdmVUYXNrLnRpdGxlfWApO1xuICB9XG4gIGlmIChzdGF0ZS5wcm9ncmVzcykge1xuICAgIGNvbnN0IHsgbWlsZXN0b25lcywgc2xpY2VzLCB0YXNrcyB9ID0gc3RhdGUucHJvZ3Jlc3M7XG4gICAgY29uc3QgcGFydHM6IHN0cmluZ1tdID0gW2BtaWxlc3RvbmVzICR7bWlsZXN0b25lcy5kb25lfS8ke21pbGVzdG9uZXMudG90YWx9YF07XG4gICAgaWYgKHNsaWNlcykgcGFydHMucHVzaChgc2xpY2VzICR7c2xpY2VzLmRvbmV9LyR7c2xpY2VzLnRvdGFsfWApO1xuICAgIGlmICh0YXNrcykgcGFydHMucHVzaChgdGFza3MgJHt0YXNrcy5kb25lfS8ke3Rhc2tzLnRvdGFsfWApO1xuICAgIGxpbmVzLnB1c2goYFByb2dyZXNzOiAke3BhcnRzLmpvaW4oXCIsIFwiKX1gKTtcbiAgfVxuICBpZiAoc3RhdGUubmV4dEFjdGlvbikge1xuICAgIGxpbmVzLnB1c2goYE5leHQ6ICR7c3RhdGUubmV4dEFjdGlvbn1gKTtcbiAgfVxuICBpZiAoc3RhdGUuYmxvY2tlcnMubGVuZ3RoID4gMCkge1xuICAgIGxpbmVzLnB1c2goYEJsb2NrZXJzOiAke3N0YXRlLmJsb2NrZXJzLmpvaW4oXCI7IFwiKX1gKTtcbiAgfVxuICBpZiAoc3RhdGUucmVnaXN0cnkubGVuZ3RoID4gMCkge1xuICAgIGxpbmVzLnB1c2goXCJcIik7XG4gICAgbGluZXMucHVzaChcIk1pbGVzdG9uZXM6XCIpO1xuICAgIGZvciAoY29uc3QgbWlsZXN0b25lIG9mIHN0YXRlLnJlZ2lzdHJ5KSB7XG4gICAgICBjb25zdCBpY29uID0gbWlsZXN0b25lLnN0YXR1cyA9PT0gXCJjb21wbGV0ZVwiXG4gICAgICAgID8gXCJcdTI3MTNcIlxuICAgICAgICA6IG1pbGVzdG9uZS5zdGF0dXMgPT09IFwiYWN0aXZlXCJcbiAgICAgICAgICA/IFwiXHUyNUI2XCJcbiAgICAgICAgICA6IG1pbGVzdG9uZS5zdGF0dXMgPT09IFwicGFya2VkXCJcbiAgICAgICAgICAgID8gXCJcdTIzRjhcIlxuICAgICAgICAgICAgOiBcIlx1MjVDQlwiO1xuICAgICAgbGluZXMucHVzaChgICAke2ljb259ICR7bWlsZXN0b25lLmlkfTogJHttaWxlc3RvbmUudGl0bGV9ICgke21pbGVzdG9uZS5zdGF0dXN9KWApO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IGVudlJlc3VsdHMgPSBydW5FbnZpcm9ubWVudENoZWNrcyhwcm9qZWN0Um9vdCgpKTtcbiAgY29uc3QgZW52SXNzdWVzID0gZW52UmVzdWx0cy5maWx0ZXIoKHJlc3VsdCkgPT4gcmVzdWx0LnN0YXR1cyAhPT0gXCJva1wiKTtcbiAgaWYgKGVudklzc3Vlcy5sZW5ndGggPiAwKSB7XG4gICAgbGluZXMucHVzaChcIlwiKTtcbiAgICBsaW5lcy5wdXNoKFwiRW52aXJvbm1lbnQ6XCIpO1xuICAgIGZvciAoY29uc3QgaXNzdWUgb2YgZW52SXNzdWVzKSB7XG4gICAgICBsaW5lcy5wdXNoKGAgICR7aXNzdWUuc3RhdHVzID09PSBcImVycm9yXCIgPyBcIlx1MjcxN1wiIDogXCJcdTI2QTBcIn0gJHtpc3N1ZS5tZXNzYWdlfWApO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiBsaW5lcy5qb2luKFwiXFxuXCIpO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBR0EsU0FBUyxxQkFBcUI7QUFFOUIsU0FBUyxzQkFBc0IsMEJBQTBCO0FBQ3pELFNBQXNDLDZCQUE2QixvQ0FBb0M7QUFDdkcsU0FBUyx1QkFBdUIsYUFBYSxpQkFBaUIsbUJBQW1CLHNCQUFzQjtBQUN2RyxTQUFTLDRCQUE0QjtBQUNyQyxTQUFTLG1CQUFtQjtBQUM1QixTQUFTLGtCQUFrQjtBQUMzQixTQUFTLCtCQUErQjtBQUN4QyxTQUFTLG1CQUFtQjtBQUM1QixTQUFTLDZCQUE2QjtBQUN0QyxTQUFTLCtCQUErQjtBQUN4QyxTQUFTLHdCQUF3QixzQkFBc0IsMEJBQTBCO0FBRTFFLFNBQVMsU0FBUyxLQUE4QixPQUFPLElBQVU7QUFDdEUsUUFBTSxlQUFlO0FBQUEsSUFDbkI7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0EscUNBQXFDLHNCQUFzQixXQUFXLENBQUM7QUFBQSxJQUN2RSw0Q0FBNEMsc0JBQXNCLFVBQVUsQ0FBQztBQUFBLElBQzdFLGdEQUFnRCxzQkFBc0IsZUFBZSxDQUFDO0FBQUEsSUFDdEY7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEs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
