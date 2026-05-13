import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { handleQuick } from "../../quick.js";
import { showDiscuss, showHeadlessMilestoneCreation, showQueue } from "../../guided-flow.js";
import { handleStart, handleTemplates, dispatchMarkdownPhasePlugin } from "../../commands-workflow-templates.js";
import { gsdRoot } from "../../paths.js";
import { deriveState } from "../../state.js";
import { isParked, parkMilestone, unparkMilestone } from "../../milestone-actions.js";
import { loadEffectiveGSDPreferences } from "../../preferences.js";
import { setPlanningDepth } from "../../planning-depth.js";
import { nextMilestoneId } from "../../milestone-ids.js";
import { findMilestoneIds } from "../../guided-flow.js";
import { currentDirectoryRoot, projectRoot } from "../context.js";
import { createRun, listRuns } from "../../run-manager.js";
import {
  setActiveEngineId,
  setActiveRunDir,
  startAutoDetached,
  pauseAuto,
  isAutoActive,
  getActiveEngineId
} from "../../auto.js";
import { validateDefinition } from "../../definition-loader.js";
import {
  formatPluginInfo,
  listPluginsFormatted,
  resolvePlugin
} from "../../workflow-plugins.js";
import { dispatchOneshot } from "../../workflow-dispatch.js";
import {
  fetchWorkflowSource,
  globalInstallDir,
  inferPluginName,
  installPlugin,
  previewContent,
  projectInstallDir,
  resolveSourceUrl,
  uninstallPlugin,
  validateFetchedContent
} from "../../workflow-install.js";
function requireNotAutoActive(commandName, ctx) {
  if (!isAutoActive()) return false;
  ctx.ui.notify(
    `${commandName} cannot run while auto-mode is active.
Stop auto-mode first with /gsd stop, then run ${commandName}.`,
    "error"
  );
  return true;
}
const RESERVED_SUBCOMMANDS = /* @__PURE__ */ new Set([
  "new",
  "run",
  "list",
  "validate",
  "pause",
  "resume",
  "info",
  "install",
  "uninstall"
]);
const WORKFLOW_USAGE = [
  "Usage: /gsd workflow [<name> | <subcommand>]",
  "",
  "  <name> [args]     \u2014 Run a plugin directly (resolves project/global/bundled)",
  "  new               \u2014 Create a new workflow definition (via skill)",
  "  run <name> [k=v]  \u2014 Explicit YAML run (creates a new run dir)",
  "  list [name]       \u2014 List workflow runs (optionally filtered by name)",
  "  info <name>       \u2014 Show plugin details (source, mode, phases)",
  "  install <source>  \u2014 Install a plugin from a URL / gist: / gh:",
  "  uninstall <name>  \u2014 Remove an installed plugin",
  "  validate <name>   \u2014 Validate a workflow definition YAML",
  "  pause             \u2014 Pause custom workflow auto-mode",
  "  resume            \u2014 Resume paused custom workflow auto-mode"
].join("\n");
function splitWorkflowRunArgs(input) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escapeNext = false;
  for (const ch of input) {
    if (escapeNext) {
      current += ch;
      escapeNext = false;
      continue;
    }
    if (ch === "\\") {
      escapeNext = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (escapeNext) current += "\\";
  if (current) tokens.push(current);
  return tokens;
}
function parseWorkflowRunArgs(args) {
  const parts = splitWorkflowRunArgs(args);
  const defName = parts[0] ?? "";
  const overrides = {};
  for (let i = 1; i < parts.length; i++) {
    const eqIdx = parts[i].indexOf("=");
    if (eqIdx > 0) {
      overrides[parts[i].slice(0, eqIdx)] = parts[i].slice(eqIdx + 1);
    }
  }
  return { defName, overrides };
}
function parseWorkflowOverridesOnly(args) {
  const parts = splitWorkflowRunArgs(args);
  const overrides = {};
  for (const part of parts) {
    const eqIdx = part.indexOf("=");
    if (eqIdx > 0) {
      overrides[part.slice(0, eqIdx)] = part.slice(eqIdx + 1);
    }
  }
  return overrides;
}
function dispatchPluginByMode(plugin, args, ctx, pi) {
  switch (plugin.meta.mode) {
    case "oneshot": {
      dispatchOneshot(plugin, pi, args.trim());
      ctx.ui.notify(`Running oneshot workflow: ${plugin.meta.displayName}`, "info");
      return;
    }
    case "yaml-step": {
      const overrides = parseWorkflowOverridesOnly(args);
      try {
        const base = projectRoot();
        const runDir = createRun(base, plugin.name, Object.keys(overrides).length > 0 ? overrides : void 0);
        setActiveEngineId("custom");
        setActiveRunDir(runDir);
        ctx.ui.notify(`Created workflow run: ${plugin.name}
Run dir: ${runDir}`, "info");
        startAutoDetached(ctx, pi, base, false);
      } catch (err) {
        setActiveEngineId(null);
        setActiveRunDir(null);
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Failed to run workflow "${plugin.name}": ${msg}`, "error");
      }
      return;
    }
    case "markdown-phase": {
      if (isAutoActive()) {
        ctx.ui.notify(
          "Cannot start a markdown-phase workflow while auto-mode is running.\nRun /gsd pause first.",
          "warning"
        );
        return;
      }
      dispatchMarkdownPhasePlugin(plugin, args.trim(), ctx, pi);
      return;
    }
    case "auto-milestone": {
      ctx.ui.notify(
        `'${plugin.name}' runs via the full milestone pipeline.
Use /gsd auto or /gsd start ${plugin.name}.`,
        "info"
      );
      return;
    }
  }
}
async function handleCustomWorkflow(sub, ctx, pi) {
  if (!sub) {
    const base = projectRoot();
    const listing = listPluginsFormatted(base);
    ctx.ui.notify(listing, "info");
    return true;
  }
  const spaceIdx = sub.indexOf(" ");
  const head = (spaceIdx === -1 ? sub : sub.slice(0, spaceIdx)).trim();
  const rest = spaceIdx === -1 ? "" : sub.slice(spaceIdx + 1).trim();
  if (head === "new") {
    ctx.ui.notify("Use the create-workflow skill: /skill create-workflow", "info");
    return true;
  }
  if (head === "run") {
    if (!rest) {
      ctx.ui.notify("Usage: /gsd workflow run <name> [param=value ...]", "warning");
      return true;
    }
    const { defName, overrides } = parseWorkflowRunArgs(rest);
    try {
      const base = projectRoot();
      const runDir = createRun(base, defName, Object.keys(overrides).length > 0 ? overrides : void 0);
      setActiveEngineId("custom");
      setActiveRunDir(runDir);
      ctx.ui.notify(`Created workflow run: ${defName}
Run dir: ${runDir}`, "info");
      startAutoDetached(ctx, pi, base, false);
    } catch (err) {
      setActiveEngineId(null);
      setActiveRunDir(null);
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Failed to run workflow "${defName}": ${msg}`, "error");
    }
    return true;
  }
  if (head === "list") {
    const base = projectRoot();
    const runs = listRuns(base, rest || void 0);
    if (runs.length === 0) {
      ctx.ui.notify("No workflow runs found.", "info");
      return true;
    }
    const lines = runs.map((r) => {
      const stepInfo = `${r.steps.completed}/${r.steps.total} steps`;
      return `\u2022 ${r.name} [${r.timestamp}] \u2014 ${r.status} (${stepInfo})`;
    });
    ctx.ui.notify(lines.join("\n"), "info");
    return true;
  }
  if (head === "info") {
    if (!rest) {
      ctx.ui.notify("Usage: /gsd workflow info <name>", "warning");
      return true;
    }
    const base = projectRoot();
    const plugin = resolvePlugin(base, rest);
    if (!plugin) {
      ctx.ui.notify(`Plugin not found: ${rest}
Run /gsd workflow to list plugins.`, "warning");
      return true;
    }
    ctx.ui.notify(formatPluginInfo(plugin), "info");
    return true;
  }
  if (head === "install") {
    if (!rest) {
      ctx.ui.notify(
        "Usage: /gsd workflow install <source> [--project] [--name <n>]\n\nSources:\n  https://\u2026/path/workflow.yaml\n  gist:<id>\n  gh:owner/repo/path[@ref]",
        "warning"
      );
      return true;
    }
    const tokens = rest.split(/\s+/);
    let source = "";
    let scope = "global";
    let nameOverride;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === "--project") scope = "project";
      else if (t === "--name") nameOverride = tokens[++i];
      else if (t && !source) source = t;
    }
    const base = projectRoot();
    try {
      const url = resolveSourceUrl(source);
      ctx.ui.notify(`Fetching ${url}\u2026`, "info");
      const fetched = await fetchWorkflowSource(url);
      validateFetchedContent(fetched);
      const name = nameOverride ? nameOverride.trim().toLowerCase() : inferPluginName(fetched);
      if (!name) throw new Error("Could not infer plugin name. Use --name <n>.");
      const target = scope === "global" ? { scope: "global", dir: globalInstallDir() } : { scope: "project", dir: projectInstallDir(base) };
      const preview = previewContent(fetched.content, 20);
      const summary = [
        `Install workflow plugin:`,
        `  Source:    ${fetched.url}`,
        `  Name:      ${name}`,
        `  Format:    ${fetched.ext.slice(1)}`,
        `  Target:    ${join(target.dir, `${name}${fetched.ext}`)}`,
        `  Scope:     ${target.scope}`,
        "",
        `Preview (first 20 lines):`,
        "  " + preview.split("\n").join("\n  "),
        "",
        `Proceeding with install. Run /gsd workflow uninstall ${name} to revert.`
      ].join("\n");
      ctx.ui.notify(summary, "info");
      const result = installPlugin(target, fetched, name);
      ctx.ui.notify(
        `\u2713 Installed plugin "${result.name}" (${result.ext.slice(1)}) to ${result.path}`,
        "info"
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Failed to install: ${msg}`, "error");
    }
    return true;
  }
  if (head === "uninstall") {
    if (!rest) {
      ctx.ui.notify("Usage: /gsd workflow uninstall <name>", "warning");
      return true;
    }
    const base = projectRoot();
    const result = uninstallPlugin(base, rest.trim());
    if (!result.removed) {
      ctx.ui.notify(
        `No installed plugin named "${rest}" found in ${globalInstallDir()} or ${projectInstallDir(base)}.`,
        "warning"
      );
      return true;
    }
    const warning = result.warnedNotInProvenance ? " (no provenance record \u2014 was this hand-authored?)" : "";
    ctx.ui.notify(`\u2713 Removed ${result.path}${warning}`, "info");
    return true;
  }
  if (head === "validate") {
    if (!rest) {
      ctx.ui.notify("Usage: /gsd workflow validate <name>", "warning");
      return true;
    }
    const base = projectRoot();
    const plugin = resolvePlugin(base, rest);
    let raw;
    let sourceLabel;
    if (plugin && plugin.format === "yaml") {
      try {
        raw = readFileSync(plugin.path, "utf-8");
        sourceLabel = plugin.path;
      } catch (err) {
        ctx.ui.notify(
          `Failed to read definition: ${err instanceof Error ? err.message : String(err)}`,
          "error"
        );
        return true;
      }
    } else {
      const defPath = join(base, ".gsd", "workflow-defs", `${rest}.yaml`);
      if (!existsSync(defPath)) {
        ctx.ui.notify(`Definition not found: ${defPath}`, "error");
        return true;
      }
      try {
        raw = readFileSync(defPath, "utf-8");
        sourceLabel = defPath;
      } catch (err) {
        ctx.ui.notify(
          `Failed to read definition: ${err instanceof Error ? err.message : String(err)}`,
          "error"
        );
        return true;
      }
    }
    try {
      const parsed = parseYaml(raw);
      const result = validateDefinition(parsed);
      if (result.valid) {
        ctx.ui.notify(`\u2713 "${rest}" is a valid workflow definition (${sourceLabel}).`, "info");
      } else {
        ctx.ui.notify(`\u2717 "${rest}" has errors:
  - ${result.errors.join("\n  - ")}`, "error");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Failed to validate "${rest}": ${msg}`, "error");
    }
    return true;
  }
  if (head === "pause" && !rest) {
    const engineId = getActiveEngineId();
    if (engineId === "dev" || engineId === null) {
      ctx.ui.notify("No custom workflow is running. Use /gsd pause for dev workflow.", "warning");
      return true;
    }
    if (!isAutoActive()) {
      ctx.ui.notify("Auto-mode is not active.", "warning");
      return true;
    }
    await pauseAuto(ctx, pi);
    ctx.ui.notify("Custom workflow paused.", "info");
    return true;
  }
  if (head === "resume" && !rest) {
    const engineId = getActiveEngineId();
    if (engineId === "dev" || engineId === null) {
      ctx.ui.notify("No custom workflow to resume. Use /gsd auto for dev workflow.", "warning");
      return true;
    }
    startAutoDetached(ctx, pi, projectRoot(), false);
    ctx.ui.notify("Custom workflow resumed.", "info");
    return true;
  }
  if (!RESERVED_SUBCOMMANDS.has(head)) {
    const base = projectRoot();
    const plugin = resolvePlugin(base, head);
    if (plugin) {
      dispatchPluginByMode(plugin, rest, ctx, pi);
      return true;
    }
  }
  ctx.ui.notify(`Unknown workflow subcommand or plugin: "${head}"

${WORKFLOW_USAGE}`, "warning");
  return true;
}
async function handleWorkflowCommand(trimmed, ctx, pi) {
  if (trimmed === "do" || trimmed.startsWith("do ")) {
    if (requireNotAutoActive("/gsd do", ctx)) return true;
    const { handleDo } = await import("../../commands-do.js");
    await handleDo(trimmed.replace(/^do\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "backlog" || trimmed.startsWith("backlog ")) {
    if (requireNotAutoActive("/gsd backlog", ctx)) return true;
    const { handleBacklog } = await import("../../commands-backlog.js");
    await handleBacklog(trimmed.replace(/^backlog\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "workflow" || trimmed.startsWith("workflow ")) {
    const sub = trimmed.slice("workflow".length).trim();
    return handleCustomWorkflow(sub, ctx, pi);
  }
  if (trimmed === "queue") {
    if (requireNotAutoActive("/gsd queue", ctx)) return true;
    await showQueue(ctx, pi, projectRoot());
    return true;
  }
  if (trimmed === "discuss") {
    if (requireNotAutoActive("/gsd discuss", ctx)) return true;
    await showDiscuss(ctx, pi, projectRoot());
    return true;
  }
  if (trimmed === "quick" || trimmed.startsWith("quick ")) {
    if (requireNotAutoActive("/gsd quick", ctx)) return true;
    await handleQuick(trimmed.replace(/^quick\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "new-milestone" || trimmed.startsWith("new-milestone ")) {
    if (requireNotAutoActive("/gsd new-milestone", ctx)) return true;
    const basePath = projectRoot();
    const args = trimmed.replace(/^new-milestone\s*/, "").trim();
    if (/(^|\s)--deep(\s|$)/.test(args)) {
      setPlanningDepth(basePath, "deep");
      ctx.ui.notify("Deep planning mode enabled (.gsd/PREFERENCES.md updated).", "info");
    }
    const headlessContextPath = join(gsdRoot(basePath), "runtime", "headless-context.md");
    if (existsSync(headlessContextPath)) {
      const seedContext = readFileSync(headlessContextPath, "utf-8");
      try {
        unlinkSync(headlessContextPath);
      } catch {
      }
      await showHeadlessMilestoneCreation(ctx, pi, basePath, seedContext);
    } else {
      const { showSmartEntry } = await import("../../guided-flow.js");
      await showSmartEntry(ctx, pi, basePath);
    }
    return true;
  }
  if (trimmed === "new-project" || trimmed.startsWith("new-project ")) {
    if (requireNotAutoActive("/gsd new-project", ctx)) return true;
    const basePath = currentDirectoryRoot();
    const args = trimmed.replace(/^new-project\s*/, "").trim();
    if (/(^|\s)--deep(\s|$)/.test(args)) {
      setPlanningDepth(basePath, "deep");
      ctx.ui.notify("Deep planning mode enabled (.gsd/PREFERENCES.md updated).", "info");
    }
    const { showSmartEntry } = await import("../../guided-flow.js");
    await showSmartEntry(ctx, pi, basePath);
    return true;
  }
  if (trimmed === "start" || trimmed.startsWith("start ")) {
    await handleStart(trimmed.replace(/^start\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "templates" || trimmed.startsWith("templates ")) {
    await handleTemplates(trimmed.replace(/^templates\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "park" || trimmed.startsWith("park ")) {
    if (requireNotAutoActive("/gsd park", ctx)) return true;
    const basePath = projectRoot();
    const arg = trimmed.replace(/^park\s*/, "").trim();
    let targetId = arg;
    if (!targetId) {
      const state = await deriveState(basePath);
      if (!state.activeMilestone) {
        ctx.ui.notify("No active milestone to park.", "warning");
        return true;
      }
      targetId = state.activeMilestone.id;
    }
    if (isParked(basePath, targetId)) {
      ctx.ui.notify(`${targetId} is already parked. Use /gsd unpark ${targetId} to reactivate.`, "info");
      return true;
    }
    const reasonParts = arg.replace(targetId, "").trim().replace(/^["']|["']$/g, "");
    const reason = reasonParts || "Parked via /gsd park";
    const success = parkMilestone(basePath, targetId, reason);
    ctx.ui.notify(
      success ? `Parked ${targetId}. Run /gsd unpark ${targetId} to reactivate.` : `Could not park ${targetId} \u2014 milestone not found.`,
      success ? "info" : "warning"
    );
    return true;
  }
  if (trimmed === "unpark" || trimmed.startsWith("unpark ")) {
    if (requireNotAutoActive("/gsd unpark", ctx)) return true;
    const basePath = projectRoot();
    const arg = trimmed.replace(/^unpark\s*/, "").trim();
    let targetId = arg;
    if (!targetId) {
      const state = await deriveState(basePath);
      const parkedEntries = state.registry.filter((entry) => entry.status === "parked");
      if (parkedEntries.length === 0) {
        ctx.ui.notify("No parked milestones.", "info");
        return true;
      }
      if (parkedEntries.length === 1) {
        targetId = parkedEntries[0].id;
      } else {
        ctx.ui.notify(`Parked milestones: ${parkedEntries.map((entry) => entry.id).join(", ")}. Specify which to unpark: /gsd unpark <id>`, "info");
        return true;
      }
    }
    const success = unparkMilestone(basePath, targetId);
    ctx.ui.notify(
      success ? `Unparked ${targetId}. It will resume its normal position in the queue.` : `Could not unpark ${targetId} \u2014 milestone not found or not parked.`,
      success ? "info" : "warning"
    );
    return true;
  }
  return false;
}
function getNextMilestoneId(basePath) {
  const milestoneIds = findMilestoneIds(basePath);
  const uniqueIds = !!loadEffectiveGSDPreferences()?.preferences?.unique_milestone_ids;
  return nextMilestoneId(milestoneIds, uniqueIds);
}
export {
  getNextMilestoneId,
  handleWorkflowCommand,
  parseWorkflowOverridesOnly,
  parseWorkflowRunArgs
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9jb21tYW5kcy9oYW5kbGVycy93b3JrZmxvdy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHR5cGUgeyBFeHRlbnNpb25BUEksIEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0IH0gZnJvbSBcIkBnc2QvcGktY29kaW5nLWFnZW50XCI7XG5cbmltcG9ydCB7IGV4aXN0c1N5bmMsIHJlYWRGaWxlU3luYywgdW5saW5rU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgcGFyc2UgYXMgcGFyc2VZYW1sIH0gZnJvbSBcInlhbWxcIjtcblxuaW1wb3J0IHsgaGFuZGxlUXVpY2sgfSBmcm9tIFwiLi4vLi4vcXVpY2suanNcIjtcbmltcG9ydCB7IHNob3dEaXNjdXNzLCBzaG93SGVhZGxlc3NNaWxlc3RvbmVDcmVhdGlvbiwgc2hvd1F1ZXVlIH0gZnJvbSBcIi4uLy4uL2d1aWRlZC1mbG93LmpzXCI7XG5pbXBvcnQgeyBoYW5kbGVTdGFydCwgaGFuZGxlVGVtcGxhdGVzLCBkaXNwYXRjaE1hcmtkb3duUGhhc2VQbHVnaW4gfSBmcm9tIFwiLi4vLi4vY29tbWFuZHMtd29ya2Zsb3ctdGVtcGxhdGVzLmpzXCI7XG5pbXBvcnQgeyBnc2RSb290IH0gZnJvbSBcIi4uLy4uL3BhdGhzLmpzXCI7XG5pbXBvcnQgeyBkZXJpdmVTdGF0ZSB9IGZyb20gXCIuLi8uLi9zdGF0ZS5qc1wiO1xuaW1wb3J0IHsgaXNQYXJrZWQsIHBhcmtNaWxlc3RvbmUsIHVucGFya01pbGVzdG9uZSB9IGZyb20gXCIuLi8uLi9taWxlc3RvbmUtYWN0aW9ucy5qc1wiO1xuaW1wb3J0IHsgbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzIH0gZnJvbSBcIi4uLy4uL3ByZWZlcmVuY2VzLmpzXCI7XG5pbXBvcnQgeyBzZXRQbGFubmluZ0RlcHRoIH0gZnJvbSBcIi4uLy4uL3BsYW5uaW5nLWRlcHRoLmpzXCI7XG5pbXBvcnQgeyBuZXh0TWlsZXN0b25lSWQgfSBmcm9tIFwiLi4vLi4vbWlsZXN0b25lLWlkcy5qc1wiO1xuaW1wb3J0IHsgZmluZE1pbGVzdG9uZUlkcyB9IGZyb20gXCIuLi8uLi9ndWlkZWQtZmxvdy5qc1wiO1xuaW1wb3J0IHsgY3VycmVudERpcmVjdG9yeVJvb3QsIHByb2plY3RSb290IH0gZnJvbSBcIi4uL2NvbnRleHQuanNcIjtcbmltcG9ydCB7IGNyZWF0ZVJ1biwgbGlzdFJ1bnMgfSBmcm9tIFwiLi4vLi4vcnVuLW1hbmFnZXIuanNcIjtcbmltcG9ydCB7XG4gIHNldEFjdGl2ZUVuZ2luZUlkLFxuICBzZXRBY3RpdmVSdW5EaXIsXG4gIHN0YXJ0QXV0b0RldGFjaGVkLFxuICBwYXVzZUF1dG8sXG4gIGlzQXV0b0FjdGl2ZSxcbiAgZ2V0QWN0aXZlRW5naW5lSWQsXG59IGZyb20gXCIuLi8uLi9hdXRvLmpzXCI7XG5pbXBvcnQgeyB2YWxpZGF0ZURlZmluaXRpb24gfSBmcm9tIFwiLi4vLi4vZGVmaW5pdGlvbi1sb2FkZXIuanNcIjtcbmltcG9ydCB7XG4gIGZvcm1hdFBsdWdpbkluZm8sXG4gIGxpc3RQbHVnaW5zRm9ybWF0dGVkLFxuICByZXNvbHZlUGx1Z2luLFxuICB0eXBlIFdvcmtmbG93UGx1Z2luLFxufSBmcm9tIFwiLi4vLi4vd29ya2Zsb3ctcGx1Z2lucy5qc1wiO1xuaW1wb3J0IHsgZGlzcGF0Y2hPbmVzaG90IH0gZnJvbSBcIi4uLy4uL3dvcmtmbG93LWRpc3BhdGNoLmpzXCI7XG5pbXBvcnQge1xuICBmZXRjaFdvcmtmbG93U291cmNlLFxuICBnbG9iYWxJbnN0YWxsRGlyLFxuICBpbmZlclBsdWdpbk5hbWUsXG4gIGluc3RhbGxQbHVnaW4sXG4gIHByZXZpZXdDb250ZW50LFxuICBwcm9qZWN0SW5zdGFsbERpcixcbiAgcmVzb2x2ZVNvdXJjZVVybCxcbiAgdW5pbnN0YWxsUGx1Z2luLFxuICB2YWxpZGF0ZUZldGNoZWRDb250ZW50LFxufSBmcm9tIFwiLi4vLi4vd29ya2Zsb3ctaW5zdGFsbC5qc1wiO1xuXG4vKipcbiAqIFJlZnVzZXMgaW50ZXJhY3RpdmUgY29tbWFuZHMgdGhhdCBtdXRhdGUgZHVyYWJsZSAuZ3NkLyBwbGFubmluZyBzdGF0ZSB3aGlsZVxuICogYXV0by1tb2RlIGhvbGRzIHRoZSB3b3JrdHJlZS4gUmV0dXJucyB0cnVlIGlmIHRoZSBjb21tYW5kIHdhcyBibG9ja2VkIGFuZFxuICogdGhlIGNhbGxlciBzaG91bGQgcmV0dXJuIGltbWVkaWF0ZWx5OyBmYWxzZSBpZiBpdCBpcyBzYWZlIHRvIHByb2NlZWQuXG4gKlxuICogQXV0by1tb2RlJ3Mgc3F1YXNoIG1lcmdlIHBlcmZvcm1zIGEgcHJlLW1lcmdlIGRpcnR5LXRyZWUgY2hlY2s7IGNvbmN1cnJlbnRcbiAqIHdyaXRlcyBieSBpbnRlcmFjdGl2ZSBjb21tYW5kcyBiZXR3ZWVuIHRoYXQgY2hlY2sgYW5kIHRoZSBtZXJnZSBpdHNlbGZcbiAqIGNhdXNlIF9fZGlydHlfd29ya2luZ190cmVlX18gZmFpbHVyZXMgKCM0NzA0KS5cbiAqL1xuZnVuY3Rpb24gcmVxdWlyZU5vdEF1dG9BY3RpdmUoY29tbWFuZE5hbWU6IHN0cmluZywgY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCk6IGJvb2xlYW4ge1xuICBpZiAoIWlzQXV0b0FjdGl2ZSgpKSByZXR1cm4gZmFsc2U7XG4gIGN0eC51aS5ub3RpZnkoXG4gICAgYCR7Y29tbWFuZE5hbWV9IGNhbm5vdCBydW4gd2hpbGUgYXV0by1tb2RlIGlzIGFjdGl2ZS5cXG5gICtcbiAgICBgU3RvcCBhdXRvLW1vZGUgZmlyc3Qgd2l0aCAvZ3NkIHN0b3AsIHRoZW4gcnVuICR7Y29tbWFuZE5hbWV9LmAsXG4gICAgXCJlcnJvclwiLFxuICApO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEN1c3RvbSBXb3JrZmxvdyBTdWJjb21tYW5kcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuY29uc3QgUkVTRVJWRURfU1VCQ09NTUFORFMgPSBuZXcgU2V0KFtcbiAgXCJuZXdcIiwgXCJydW5cIiwgXCJsaXN0XCIsIFwidmFsaWRhdGVcIiwgXCJwYXVzZVwiLCBcInJlc3VtZVwiLFxuICBcImluZm9cIiwgXCJpbnN0YWxsXCIsIFwidW5pbnN0YWxsXCIsXG5dKTtcblxuY29uc3QgV09SS0ZMT1dfVVNBR0UgPSBbXG4gIFwiVXNhZ2U6IC9nc2Qgd29ya2Zsb3cgWzxuYW1lPiB8IDxzdWJjb21tYW5kPl1cIixcbiAgXCJcIixcbiAgXCIgIDxuYW1lPiBbYXJnc10gICAgIFx1MjAxNCBSdW4gYSBwbHVnaW4gZGlyZWN0bHkgKHJlc29sdmVzIHByb2plY3QvZ2xvYmFsL2J1bmRsZWQpXCIsXG4gIFwiICBuZXcgICAgICAgICAgICAgICBcdTIwMTQgQ3JlYXRlIGEgbmV3IHdvcmtmbG93IGRlZmluaXRpb24gKHZpYSBza2lsbClcIixcbiAgXCIgIHJ1biA8bmFtZT4gW2s9dl0gIFx1MjAxNCBFeHBsaWNpdCBZQU1MIHJ1biAoY3JlYXRlcyBhIG5ldyBydW4gZGlyKVwiLFxuICBcIiAgbGlzdCBbbmFtZV0gICAgICAgXHUyMDE0IExpc3Qgd29ya2Zsb3cgcnVucyAob3B0aW9uYWxseSBmaWx0ZXJlZCBieSBuYW1lKVwiLFxuICBcIiAgaW5mbyA8bmFtZT4gICAgICAgXHUyMDE0IFNob3cgcGx1Z2luIGRldGFpbHMgKHNvdXJjZSwgbW9kZSwgcGhhc2VzKVwiLFxuICBcIiAgaW5zdGFsbCA8c291cmNlPiAgXHUyMDE0IEluc3RhbGwgYSBwbHVnaW4gZnJvbSBhIFVSTCAvIGdpc3Q6IC8gZ2g6XCIsXG4gIFwiICB1bmluc3RhbGwgPG5hbWU+ICBcdTIwMTQgUmVtb3ZlIGFuIGluc3RhbGxlZCBwbHVnaW5cIixcbiAgXCIgIHZhbGlkYXRlIDxuYW1lPiAgIFx1MjAxNCBWYWxpZGF0ZSBhIHdvcmtmbG93IGRlZmluaXRpb24gWUFNTFwiLFxuICBcIiAgcGF1c2UgICAgICAgICAgICAgXHUyMDE0IFBhdXNlIGN1c3RvbSB3b3JrZmxvdyBhdXRvLW1vZGVcIixcbiAgXCIgIHJlc3VtZSAgICAgICAgICAgIFx1MjAxNCBSZXN1bWUgcGF1c2VkIGN1c3RvbSB3b3JrZmxvdyBhdXRvLW1vZGVcIixcbl0uam9pbihcIlxcblwiKTtcblxuZnVuY3Rpb24gc3BsaXRXb3JrZmxvd1J1bkFyZ3MoaW5wdXQ6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgY29uc3QgdG9rZW5zOiBzdHJpbmdbXSA9IFtdO1xuICBsZXQgY3VycmVudCA9IFwiXCI7XG4gIGxldCBxdW90ZTogJ1wiJyB8IFwiJ1wiIHwgbnVsbCA9IG51bGw7XG4gIGxldCBlc2NhcGVOZXh0ID0gZmFsc2U7XG5cbiAgZm9yIChjb25zdCBjaCBvZiBpbnB1dCkge1xuICAgIGlmIChlc2NhcGVOZXh0KSB7XG4gICAgICBjdXJyZW50ICs9IGNoO1xuICAgICAgZXNjYXBlTmV4dCA9IGZhbHNlO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgaWYgKGNoID09PSBcIlxcXFxcIikge1xuICAgICAgZXNjYXBlTmV4dCA9IHRydWU7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBpZiAocXVvdGUpIHtcbiAgICAgIGlmIChjaCA9PT0gcXVvdGUpIHtcbiAgICAgICAgcXVvdGUgPSBudWxsO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY3VycmVudCArPSBjaDtcbiAgICAgIH1cbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGlmIChjaCA9PT0gJ1wiJyB8fCBjaCA9PT0gXCInXCIpIHtcbiAgICAgIHF1b3RlID0gY2g7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBpZiAoL1xccy8udGVzdChjaCkpIHtcbiAgICAgIGlmIChjdXJyZW50KSB7XG4gICAgICAgIHRva2Vucy5wdXNoKGN1cnJlbnQpO1xuICAgICAgICBjdXJyZW50ID0gXCJcIjtcbiAgICAgIH1cbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGN1cnJlbnQgKz0gY2g7XG4gIH1cblxuICBpZiAoZXNjYXBlTmV4dCkgY3VycmVudCArPSBcIlxcXFxcIjtcbiAgaWYgKGN1cnJlbnQpIHRva2Vucy5wdXNoKGN1cnJlbnQpO1xuICByZXR1cm4gdG9rZW5zO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VXb3JrZmxvd1J1bkFyZ3MoYXJnczogc3RyaW5nKTogeyBkZWZOYW1lOiBzdHJpbmc7IG92ZXJyaWRlczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB9IHtcbiAgY29uc3QgcGFydHMgPSBzcGxpdFdvcmtmbG93UnVuQXJncyhhcmdzKTtcbiAgY29uc3QgZGVmTmFtZSA9IHBhcnRzWzBdID8/IFwiXCI7XG4gIGNvbnN0IG92ZXJyaWRlczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICBmb3IgKGxldCBpID0gMTsgaSA8IHBhcnRzLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgZXFJZHggPSBwYXJ0c1tpXS5pbmRleE9mKFwiPVwiKTtcbiAgICBpZiAoZXFJZHggPiAwKSB7XG4gICAgICBvdmVycmlkZXNbcGFydHNbaV0uc2xpY2UoMCwgZXFJZHgpXSA9IHBhcnRzW2ldLnNsaWNlKGVxSWR4ICsgMSk7XG4gICAgfVxuICB9XG4gIHJldHVybiB7IGRlZk5hbWUsIG92ZXJyaWRlcyB9O1xufVxuXG4vKipcbiAqIFBhcnNlIGV2ZXJ5IHRva2VuIGFzIGFuIG9wdGlvbmFsIGBrPXZgIG92ZXJyaWRlLiBVc2Ugd2hlbiB0aGUgd29ya2Zsb3cgbmFtZVxuICogaXMgYWxyZWFkeSBrbm93biAoZS5nLiwgZGlyZWN0IGAvZ3NkIHdvcmtmbG93IDxuYW1lPiAuLi5gIGRpc3BhdGNoKSBzbyB0aGVcbiAqIGZpcnN0IHRva2VuIGlzbid0IGVhdGVuIGFzIGEgZGVmIG5hbWUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVdvcmtmbG93T3ZlcnJpZGVzT25seShhcmdzOiBzdHJpbmcpOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IHtcbiAgY29uc3QgcGFydHMgPSBzcGxpdFdvcmtmbG93UnVuQXJncyhhcmdzKTtcbiAgY29uc3Qgb3ZlcnJpZGVzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XG4gIGZvciAoY29uc3QgcGFydCBvZiBwYXJ0cykge1xuICAgIGNvbnN0IGVxSWR4ID0gcGFydC5pbmRleE9mKFwiPVwiKTtcbiAgICBpZiAoZXFJZHggPiAwKSB7XG4gICAgICBvdmVycmlkZXNbcGFydC5zbGljZSgwLCBlcUlkeCldID0gcGFydC5zbGljZShlcUlkeCArIDEpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gb3ZlcnJpZGVzO1xufVxuXG4vKipcbiAqIERpc3BhdGNoIGEgcmVzb2x2ZWQgcGx1Z2luIGFjY29yZGluZyB0byBpdHMgZGVjbGFyZWQgbW9kZS5cbiAqL1xuZnVuY3Rpb24gZGlzcGF0Y2hQbHVnaW5CeU1vZGUoXG4gIHBsdWdpbjogV29ya2Zsb3dQbHVnaW4sXG4gIGFyZ3M6IHN0cmluZyxcbiAgY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCxcbiAgcGk6IEV4dGVuc2lvbkFQSSxcbik6IHZvaWQge1xuICBzd2l0Y2ggKHBsdWdpbi5tZXRhLm1vZGUpIHtcbiAgICBjYXNlIFwib25lc2hvdFwiOiB7XG4gICAgICBkaXNwYXRjaE9uZXNob3QocGx1Z2luLCBwaSwgYXJncy50cmltKCkpO1xuICAgICAgY3R4LnVpLm5vdGlmeShgUnVubmluZyBvbmVzaG90IHdvcmtmbG93OiAke3BsdWdpbi5tZXRhLmRpc3BsYXlOYW1lfWAsIFwiaW5mb1wiKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjYXNlIFwieWFtbC1zdGVwXCI6IHtcbiAgICAgIGNvbnN0IG92ZXJyaWRlcyA9IHBhcnNlV29ya2Zsb3dPdmVycmlkZXNPbmx5KGFyZ3MpO1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgYmFzZSA9IHByb2plY3RSb290KCk7XG4gICAgICAgIGNvbnN0IHJ1bkRpciA9IGNyZWF0ZVJ1bihiYXNlLCBwbHVnaW4ubmFtZSwgT2JqZWN0LmtleXMob3ZlcnJpZGVzKS5sZW5ndGggPiAwID8gb3ZlcnJpZGVzIDogdW5kZWZpbmVkKTtcbiAgICAgICAgc2V0QWN0aXZlRW5naW5lSWQoXCJjdXN0b21cIik7XG4gICAgICAgIHNldEFjdGl2ZVJ1bkRpcihydW5EaXIpO1xuICAgICAgICBjdHgudWkubm90aWZ5KGBDcmVhdGVkIHdvcmtmbG93IHJ1bjogJHtwbHVnaW4ubmFtZX1cXG5SdW4gZGlyOiAke3J1bkRpcn1gLCBcImluZm9cIik7XG4gICAgICAgIHN0YXJ0QXV0b0RldGFjaGVkKGN0eCwgcGksIGJhc2UsIGZhbHNlKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBzZXRBY3RpdmVFbmdpbmVJZChudWxsKTtcbiAgICAgICAgc2V0QWN0aXZlUnVuRGlyKG51bGwpO1xuICAgICAgICBjb25zdCBtc2cgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgICAgIGN0eC51aS5ub3RpZnkoYEZhaWxlZCB0byBydW4gd29ya2Zsb3cgXCIke3BsdWdpbi5uYW1lfVwiOiAke21zZ31gLCBcImVycm9yXCIpO1xuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNhc2UgXCJtYXJrZG93bi1waGFzZVwiOiB7XG4gICAgICBpZiAoaXNBdXRvQWN0aXZlKCkpIHtcbiAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICBcIkNhbm5vdCBzdGFydCBhIG1hcmtkb3duLXBoYXNlIHdvcmtmbG93IHdoaWxlIGF1dG8tbW9kZSBpcyBydW5uaW5nLlxcblwiICtcbiAgICAgICAgICBcIlJ1biAvZ3NkIHBhdXNlIGZpcnN0LlwiLFxuICAgICAgICAgIFwid2FybmluZ1wiLFxuICAgICAgICApO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICAvLyBEZWxlZ2F0ZSB0byBjb21tYW5kcy13b3JrZmxvdy10ZW1wbGF0ZXMgd2hpY2ggaGFuZGxlcyBicmFuY2ggKyBzdGF0ZSBmaWxlLlxuICAgICAgZGlzcGF0Y2hNYXJrZG93blBoYXNlUGx1Z2luKHBsdWdpbiwgYXJncy50cmltKCksIGN0eCwgcGkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNhc2UgXCJhdXRvLW1pbGVzdG9uZVwiOiB7XG4gICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICBgJyR7cGx1Z2luLm5hbWV9JyBydW5zIHZpYSB0aGUgZnVsbCBtaWxlc3RvbmUgcGlwZWxpbmUuXFxuYCArXG4gICAgICAgIGBVc2UgL2dzZCBhdXRvIG9yIC9nc2Qgc3RhcnQgJHtwbHVnaW4ubmFtZX0uYCxcbiAgICAgICAgXCJpbmZvXCIsXG4gICAgICApO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVDdXN0b21Xb3JrZmxvdyhcbiAgc3ViOiBzdHJpbmcsXG4gIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsXG4gIHBpOiBFeHRlbnNpb25BUEksXG4pOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgLy8gQmFyZSBgL2dzZCB3b3JrZmxvd2AgXHUyMDE0IGxpc3QgcGx1Z2luc1xuICBpZiAoIXN1Yikge1xuICAgIGNvbnN0IGJhc2UgPSBwcm9qZWN0Um9vdCgpO1xuICAgIGNvbnN0IGxpc3RpbmcgPSBsaXN0UGx1Z2luc0Zvcm1hdHRlZChiYXNlKTtcbiAgICBjdHgudWkubm90aWZ5KGxpc3RpbmcsIFwiaW5mb1wiKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIC8vIFNwbGl0IGludG8gaGVhZCArIHJlc3QgZm9yIHN1YmNvbW1hbmQgZGV0ZWN0aW9uLlxuICBjb25zdCBzcGFjZUlkeCA9IHN1Yi5pbmRleE9mKFwiIFwiKTtcbiAgY29uc3QgaGVhZCA9IChzcGFjZUlkeCA9PT0gLTEgPyBzdWIgOiBzdWIuc2xpY2UoMCwgc3BhY2VJZHgpKS50cmltKCk7XG4gIGNvbnN0IHJlc3QgPSBzcGFjZUlkeCA9PT0gLTEgPyBcIlwiIDogc3ViLnNsaWNlKHNwYWNlSWR4ICsgMSkudHJpbSgpO1xuXG4gIC8vIFx1MjUwMFx1MjUwMCBuZXcgXHUyNTAwXHUyNTAwXG4gIGlmIChoZWFkID09PSBcIm5ld1wiKSB7XG4gICAgY3R4LnVpLm5vdGlmeShcIlVzZSB0aGUgY3JlYXRlLXdvcmtmbG93IHNraWxsOiAvc2tpbGwgY3JlYXRlLXdvcmtmbG93XCIsIFwiaW5mb1wiKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBydW4gPG5hbWU+IFtwYXJhbT12YWx1ZSAuLi5dIFx1MjUwMFx1MjUwMFxuICBpZiAoaGVhZCA9PT0gXCJydW5cIikge1xuICAgIGlmICghcmVzdCkge1xuICAgICAgY3R4LnVpLm5vdGlmeShcIlVzYWdlOiAvZ3NkIHdvcmtmbG93IHJ1biA8bmFtZT4gW3BhcmFtPXZhbHVlIC4uLl1cIiwgXCJ3YXJuaW5nXCIpO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGNvbnN0IHsgZGVmTmFtZSwgb3ZlcnJpZGVzIH0gPSBwYXJzZVdvcmtmbG93UnVuQXJncyhyZXN0KTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgYmFzZSA9IHByb2plY3RSb290KCk7XG4gICAgICBjb25zdCBydW5EaXIgPSBjcmVhdGVSdW4oYmFzZSwgZGVmTmFtZSwgT2JqZWN0LmtleXMob3ZlcnJpZGVzKS5sZW5ndGggPiAwID8gb3ZlcnJpZGVzIDogdW5kZWZpbmVkKTtcbiAgICAgIHNldEFjdGl2ZUVuZ2luZUlkKFwiY3VzdG9tXCIpO1xuICAgICAgc2V0QWN0aXZlUnVuRGlyKHJ1bkRpcik7XG4gICAgICBjdHgudWkubm90aWZ5KGBDcmVhdGVkIHdvcmtmbG93IHJ1bjogJHtkZWZOYW1lfVxcblJ1biBkaXI6ICR7cnVuRGlyfWAsIFwiaW5mb1wiKTtcbiAgICAgIHN0YXJ0QXV0b0RldGFjaGVkKGN0eCwgcGksIGJhc2UsIGZhbHNlKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHNldEFjdGl2ZUVuZ2luZUlkKG51bGwpO1xuICAgICAgc2V0QWN0aXZlUnVuRGlyKG51bGwpO1xuICAgICAgY29uc3QgbXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICAgICAgY3R4LnVpLm5vdGlmeShgRmFpbGVkIHRvIHJ1biB3b3JrZmxvdyBcIiR7ZGVmTmFtZX1cIjogJHttc2d9YCwgXCJlcnJvclwiKTtcbiAgICB9XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgbGlzdCBbbmFtZV0gXHUyMDE0IGxpc3QgWUFNTCBydW5zIFx1MjUwMFx1MjUwMFxuICBpZiAoaGVhZCA9PT0gXCJsaXN0XCIpIHtcbiAgICBjb25zdCBiYXNlID0gcHJvamVjdFJvb3QoKTtcbiAgICBjb25zdCBydW5zID0gbGlzdFJ1bnMoYmFzZSwgcmVzdCB8fCB1bmRlZmluZWQpO1xuICAgIGlmIChydW5zLmxlbmd0aCA9PT0gMCkge1xuICAgICAgY3R4LnVpLm5vdGlmeShcIk5vIHdvcmtmbG93IHJ1bnMgZm91bmQuXCIsIFwiaW5mb1wiKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBjb25zdCBsaW5lcyA9IHJ1bnMubWFwKChyKSA9PiB7XG4gICAgICBjb25zdCBzdGVwSW5mbyA9IGAke3Iuc3RlcHMuY29tcGxldGVkfS8ke3Iuc3RlcHMudG90YWx9IHN0ZXBzYDtcbiAgICAgIHJldHVybiBgXHUyMDIyICR7ci5uYW1lfSBbJHtyLnRpbWVzdGFtcH1dIFx1MjAxNCAke3Iuc3RhdHVzfSAoJHtzdGVwSW5mb30pYDtcbiAgICB9KTtcbiAgICBjdHgudWkubm90aWZ5KGxpbmVzLmpvaW4oXCJcXG5cIiksIFwiaW5mb1wiKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBpbmZvIDxuYW1lPiBcdTI1MDBcdTI1MDBcbiAgaWYgKGhlYWQgPT09IFwiaW5mb1wiKSB7XG4gICAgaWYgKCFyZXN0KSB7XG4gICAgICBjdHgudWkubm90aWZ5KFwiVXNhZ2U6IC9nc2Qgd29ya2Zsb3cgaW5mbyA8bmFtZT5cIiwgXCJ3YXJuaW5nXCIpO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGNvbnN0IGJhc2UgPSBwcm9qZWN0Um9vdCgpO1xuICAgIGNvbnN0IHBsdWdpbiA9IHJlc29sdmVQbHVnaW4oYmFzZSwgcmVzdCk7XG4gICAgaWYgKCFwbHVnaW4pIHtcbiAgICAgIGN0eC51aS5ub3RpZnkoYFBsdWdpbiBub3QgZm91bmQ6ICR7cmVzdH1cXG5SdW4gL2dzZCB3b3JrZmxvdyB0byBsaXN0IHBsdWdpbnMuYCwgXCJ3YXJuaW5nXCIpO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGN0eC51aS5ub3RpZnkoZm9ybWF0UGx1Z2luSW5mbyhwbHVnaW4pLCBcImluZm9cIik7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgaW5zdGFsbCA8c291cmNlPiBbLS1wcm9qZWN0XSBbLS1uYW1lIDxvdmVycmlkZT5dIFx1MjUwMFx1MjUwMFxuICBpZiAoaGVhZCA9PT0gXCJpbnN0YWxsXCIpIHtcbiAgICBpZiAoIXJlc3QpIHtcbiAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgIFwiVXNhZ2U6IC9nc2Qgd29ya2Zsb3cgaW5zdGFsbCA8c291cmNlPiBbLS1wcm9qZWN0XSBbLS1uYW1lIDxuPl1cXG5cXG5cIiArXG4gICAgICAgIFwiU291cmNlczpcXG5cIiArXG4gICAgICAgIFwiICBodHRwczovL1x1MjAyNi9wYXRoL3dvcmtmbG93LnlhbWxcXG5cIiArXG4gICAgICAgIFwiICBnaXN0OjxpZD5cXG5cIiArXG4gICAgICAgIFwiICBnaDpvd25lci9yZXBvL3BhdGhbQHJlZl1cIixcbiAgICAgICAgXCJ3YXJuaW5nXCIsXG4gICAgICApO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgY29uc3QgdG9rZW5zID0gcmVzdC5zcGxpdCgvXFxzKy8pO1xuICAgIGxldCBzb3VyY2UgPSBcIlwiO1xuICAgIGxldCBzY29wZTogXCJnbG9iYWxcIiB8IFwicHJvamVjdFwiID0gXCJnbG9iYWxcIjtcbiAgICBsZXQgbmFtZU92ZXJyaWRlOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCB0b2tlbnMubGVuZ3RoOyBpKyspIHtcbiAgICAgIGNvbnN0IHQgPSB0b2tlbnNbaV07XG4gICAgICBpZiAodCA9PT0gXCItLXByb2plY3RcIikgc2NvcGUgPSBcInByb2plY3RcIjtcbiAgICAgIGVsc2UgaWYgKHQgPT09IFwiLS1uYW1lXCIpIG5hbWVPdmVycmlkZSA9IHRva2Vuc1srK2ldO1xuICAgICAgZWxzZSBpZiAodCAmJiAhc291cmNlKSBzb3VyY2UgPSB0O1xuICAgIH1cblxuICAgIGNvbnN0IGJhc2UgPSBwcm9qZWN0Um9vdCgpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCB1cmwgPSByZXNvbHZlU291cmNlVXJsKHNvdXJjZSk7XG4gICAgICBjdHgudWkubm90aWZ5KGBGZXRjaGluZyAke3VybH1cdTIwMjZgLCBcImluZm9cIik7XG4gICAgICBjb25zdCBmZXRjaGVkID0gYXdhaXQgZmV0Y2hXb3JrZmxvd1NvdXJjZSh1cmwpO1xuICAgICAgdmFsaWRhdGVGZXRjaGVkQ29udGVudChmZXRjaGVkKTtcbiAgICAgIGNvbnN0IG5hbWUgPSBuYW1lT3ZlcnJpZGUgPyBuYW1lT3ZlcnJpZGUudHJpbSgpLnRvTG93ZXJDYXNlKCkgOiBpbmZlclBsdWdpbk5hbWUoZmV0Y2hlZCk7XG4gICAgICBpZiAoIW5hbWUpIHRocm93IG5ldyBFcnJvcihcIkNvdWxkIG5vdCBpbmZlciBwbHVnaW4gbmFtZS4gVXNlIC0tbmFtZSA8bj4uXCIpO1xuXG4gICAgICBjb25zdCB0YXJnZXQgPSBzY29wZSA9PT0gXCJnbG9iYWxcIlxuICAgICAgICA/IHsgc2NvcGU6IFwiZ2xvYmFsXCIgYXMgY29uc3QsIGRpcjogZ2xvYmFsSW5zdGFsbERpcigpIH1cbiAgICAgICAgOiB7IHNjb3BlOiBcInByb2plY3RcIiBhcyBjb25zdCwgZGlyOiBwcm9qZWN0SW5zdGFsbERpcihiYXNlKSB9O1xuXG4gICAgICBjb25zdCBwcmV2aWV3ID0gcHJldmlld0NvbnRlbnQoZmV0Y2hlZC5jb250ZW50LCAyMCk7XG4gICAgICBjb25zdCBzdW1tYXJ5ID0gW1xuICAgICAgICBgSW5zdGFsbCB3b3JrZmxvdyBwbHVnaW46YCxcbiAgICAgICAgYCAgU291cmNlOiAgICAke2ZldGNoZWQudXJsfWAsXG4gICAgICAgIGAgIE5hbWU6ICAgICAgJHtuYW1lfWAsXG4gICAgICAgIGAgIEZvcm1hdDogICAgJHtmZXRjaGVkLmV4dC5zbGljZSgxKX1gLFxuICAgICAgICBgICBUYXJnZXQ6ICAgICR7am9pbih0YXJnZXQuZGlyLCBgJHtuYW1lfSR7ZmV0Y2hlZC5leHR9YCl9YCxcbiAgICAgICAgYCAgU2NvcGU6ICAgICAke3RhcmdldC5zY29wZX1gLFxuICAgICAgICBcIlwiLFxuICAgICAgICBgUHJldmlldyAoZmlyc3QgMjAgbGluZXMpOmAsXG4gICAgICAgIFwiICBcIiArIHByZXZpZXcuc3BsaXQoXCJcXG5cIikuam9pbihcIlxcbiAgXCIpLFxuICAgICAgICBcIlwiLFxuICAgICAgICBgUHJvY2VlZGluZyB3aXRoIGluc3RhbGwuIFJ1biAvZ3NkIHdvcmtmbG93IHVuaW5zdGFsbCAke25hbWV9IHRvIHJldmVydC5gLFxuICAgICAgXS5qb2luKFwiXFxuXCIpO1xuICAgICAgY3R4LnVpLm5vdGlmeShzdW1tYXJ5LCBcImluZm9cIik7XG5cbiAgICAgIGNvbnN0IHJlc3VsdCA9IGluc3RhbGxQbHVnaW4odGFyZ2V0LCBmZXRjaGVkLCBuYW1lKTtcbiAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgIGBcdTI3MTMgSW5zdGFsbGVkIHBsdWdpbiBcIiR7cmVzdWx0Lm5hbWV9XCIgKCR7cmVzdWx0LmV4dC5zbGljZSgxKX0pIHRvICR7cmVzdWx0LnBhdGh9YCxcbiAgICAgICAgXCJpbmZvXCIsXG4gICAgICApO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgY29uc3QgbXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICAgICAgY3R4LnVpLm5vdGlmeShgRmFpbGVkIHRvIGluc3RhbGw6ICR7bXNnfWAsIFwiZXJyb3JcIik7XG4gICAgfVxuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwIHVuaW5zdGFsbCA8bmFtZT4gXHUyNTAwXHUyNTAwXG4gIGlmIChoZWFkID09PSBcInVuaW5zdGFsbFwiKSB7XG4gICAgaWYgKCFyZXN0KSB7XG4gICAgICBjdHgudWkubm90aWZ5KFwiVXNhZ2U6IC9nc2Qgd29ya2Zsb3cgdW5pbnN0YWxsIDxuYW1lPlwiLCBcIndhcm5pbmdcIik7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgY29uc3QgYmFzZSA9IHByb2plY3RSb290KCk7XG4gICAgY29uc3QgcmVzdWx0ID0gdW5pbnN0YWxsUGx1Z2luKGJhc2UsIHJlc3QudHJpbSgpKTtcbiAgICBpZiAoIXJlc3VsdC5yZW1vdmVkKSB7XG4gICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICBgTm8gaW5zdGFsbGVkIHBsdWdpbiBuYW1lZCBcIiR7cmVzdH1cIiBmb3VuZCBpbiAke2dsb2JhbEluc3RhbGxEaXIoKX0gb3IgJHtwcm9qZWN0SW5zdGFsbERpcihiYXNlKX0uYCxcbiAgICAgICAgXCJ3YXJuaW5nXCIsXG4gICAgICApO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGNvbnN0IHdhcm5pbmcgPSByZXN1bHQud2FybmVkTm90SW5Qcm92ZW5hbmNlXG4gICAgICA/IFwiIChubyBwcm92ZW5hbmNlIHJlY29yZCBcdTIwMTQgd2FzIHRoaXMgaGFuZC1hdXRob3JlZD8pXCJcbiAgICAgIDogXCJcIjtcbiAgICBjdHgudWkubm90aWZ5KGBcdTI3MTMgUmVtb3ZlZCAke3Jlc3VsdC5wYXRofSR7d2FybmluZ31gLCBcImluZm9cIik7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgdmFsaWRhdGUgPG5hbWU+IFx1MjUwMFx1MjUwMFxuICBpZiAoaGVhZCA9PT0gXCJ2YWxpZGF0ZVwiKSB7XG4gICAgaWYgKCFyZXN0KSB7XG4gICAgICBjdHgudWkubm90aWZ5KFwiVXNhZ2U6IC9nc2Qgd29ya2Zsb3cgdmFsaWRhdGUgPG5hbWU+XCIsIFwid2FybmluZ1wiKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBjb25zdCBiYXNlID0gcHJvamVjdFJvb3QoKTtcbiAgICBjb25zdCBwbHVnaW4gPSByZXNvbHZlUGx1Z2luKGJhc2UsIHJlc3QpO1xuXG4gICAgbGV0IHJhdzogc3RyaW5nO1xuICAgIGxldCBzb3VyY2VMYWJlbDogc3RyaW5nO1xuXG4gICAgaWYgKHBsdWdpbiAmJiBwbHVnaW4uZm9ybWF0ID09PSBcInlhbWxcIikge1xuICAgICAgdHJ5IHtcbiAgICAgICAgcmF3ID0gcmVhZEZpbGVTeW5jKHBsdWdpbi5wYXRoLCBcInV0Zi04XCIpO1xuICAgICAgICBzb3VyY2VMYWJlbCA9IHBsdWdpbi5wYXRoO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgICAgYEZhaWxlZCB0byByZWFkIGRlZmluaXRpb246ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWAsXG4gICAgICAgICAgXCJlcnJvclwiLFxuICAgICAgICApO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgLy8gTGVnYWN5IGZhbGxiYWNrIHBhdGggZm9yIG5hbWVzIHRoYXQgZG9uJ3QgcmVzb2x2ZSB2aWEgcGx1Z2lucy5cbiAgICAgIGNvbnN0IGRlZlBhdGggPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIndvcmtmbG93LWRlZnNcIiwgYCR7cmVzdH0ueWFtbGApO1xuICAgICAgaWYgKCFleGlzdHNTeW5jKGRlZlBhdGgpKSB7XG4gICAgICAgIGN0eC51aS5ub3RpZnkoYERlZmluaXRpb24gbm90IGZvdW5kOiAke2RlZlBhdGh9YCwgXCJlcnJvclwiKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9XG4gICAgICB0cnkge1xuICAgICAgICByYXcgPSByZWFkRmlsZVN5bmMoZGVmUGF0aCwgXCJ1dGYtOFwiKTtcbiAgICAgICAgc291cmNlTGFiZWwgPSBkZWZQYXRoO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgICAgYEZhaWxlZCB0byByZWFkIGRlZmluaXRpb246ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWAsXG4gICAgICAgICAgXCJlcnJvclwiLFxuICAgICAgICApO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgcGFyc2VkID0gcGFyc2VZYW1sKHJhdyk7XG4gICAgICBjb25zdCByZXN1bHQgPSB2YWxpZGF0ZURlZmluaXRpb24ocGFyc2VkKTtcbiAgICAgIGlmIChyZXN1bHQudmFsaWQpIHtcbiAgICAgICAgY3R4LnVpLm5vdGlmeShgXHUyNzEzIFwiJHtyZXN0fVwiIGlzIGEgdmFsaWQgd29ya2Zsb3cgZGVmaW5pdGlvbiAoJHtzb3VyY2VMYWJlbH0pLmAsIFwiaW5mb1wiKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGN0eC51aS5ub3RpZnkoYFx1MjcxNyBcIiR7cmVzdH1cIiBoYXMgZXJyb3JzOlxcbiAgLSAke3Jlc3VsdC5lcnJvcnMuam9pbihcIlxcbiAgLSBcIil9YCwgXCJlcnJvclwiKTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGNvbnN0IG1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICAgIGN0eC51aS5ub3RpZnkoYEZhaWxlZCB0byB2YWxpZGF0ZSBcIiR7cmVzdH1cIjogJHttc2d9YCwgXCJlcnJvclwiKTtcbiAgICB9XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgcGF1c2UgXHUyNTAwXHUyNTAwXG4gIGlmIChoZWFkID09PSBcInBhdXNlXCIgJiYgIXJlc3QpIHtcbiAgICBjb25zdCBlbmdpbmVJZCA9IGdldEFjdGl2ZUVuZ2luZUlkKCk7XG4gICAgaWYgKGVuZ2luZUlkID09PSBcImRldlwiIHx8IGVuZ2luZUlkID09PSBudWxsKSB7XG4gICAgICBjdHgudWkubm90aWZ5KFwiTm8gY3VzdG9tIHdvcmtmbG93IGlzIHJ1bm5pbmcuIFVzZSAvZ3NkIHBhdXNlIGZvciBkZXYgd29ya2Zsb3cuXCIsIFwid2FybmluZ1wiKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBpZiAoIWlzQXV0b0FjdGl2ZSgpKSB7XG4gICAgICBjdHgudWkubm90aWZ5KFwiQXV0by1tb2RlIGlzIG5vdCBhY3RpdmUuXCIsIFwid2FybmluZ1wiKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBhd2FpdCBwYXVzZUF1dG8oY3R4LCBwaSk7XG4gICAgY3R4LnVpLm5vdGlmeShcIkN1c3RvbSB3b3JrZmxvdyBwYXVzZWQuXCIsIFwiaW5mb1wiKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCByZXN1bWUgXHUyNTAwXHUyNTAwXG4gIGlmIChoZWFkID09PSBcInJlc3VtZVwiICYmICFyZXN0KSB7XG4gICAgY29uc3QgZW5naW5lSWQgPSBnZXRBY3RpdmVFbmdpbmVJZCgpO1xuICAgIGlmIChlbmdpbmVJZCA9PT0gXCJkZXZcIiB8fCBlbmdpbmVJZCA9PT0gbnVsbCkge1xuICAgICAgY3R4LnVpLm5vdGlmeShcIk5vIGN1c3RvbSB3b3JrZmxvdyB0byByZXN1bWUuIFVzZSAvZ3NkIGF1dG8gZm9yIGRldiB3b3JrZmxvdy5cIiwgXCJ3YXJuaW5nXCIpO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIHN0YXJ0QXV0b0RldGFjaGVkKGN0eCwgcGksIHByb2plY3RSb290KCksIGZhbHNlKTtcbiAgICBjdHgudWkubm90aWZ5KFwiQ3VzdG9tIHdvcmtmbG93IHJlc3VtZWQuXCIsIFwiaW5mb1wiKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBEaXJlY3QgZGlzcGF0Y2g6IC9nc2Qgd29ya2Zsb3cgPG5hbWU+IFthcmdzXSBcdTI1MDBcdTI1MDBcbiAgLy8gSWYgdGhlIGZpcnN0IHRva2VuIGlzbid0IGEgcmVzZXJ2ZWQgc3ViY29tbWFuZCwgcmVzb2x2ZSBpdCBhcyBhIHBsdWdpbi5cbiAgaWYgKCFSRVNFUlZFRF9TVUJDT01NQU5EUy5oYXMoaGVhZCkpIHtcbiAgICBjb25zdCBiYXNlID0gcHJvamVjdFJvb3QoKTtcbiAgICBjb25zdCBwbHVnaW4gPSByZXNvbHZlUGx1Z2luKGJhc2UsIGhlYWQpO1xuICAgIGlmIChwbHVnaW4pIHtcbiAgICAgIGRpc3BhdGNoUGx1Z2luQnlNb2RlKHBsdWdpbiwgcmVzdCwgY3R4LCBwaSk7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gIH1cblxuICAvLyBVbmtub3duIHN1YmNvbW1hbmQgXHUyMDE0IHNob3cgdXNhZ2VcbiAgY3R4LnVpLm5vdGlmeShgVW5rbm93biB3b3JrZmxvdyBzdWJjb21tYW5kIG9yIHBsdWdpbjogXCIke2hlYWR9XCJcXG5cXG4ke1dPUktGTE9XX1VTQUdFfWAsIFwid2FybmluZ1wiKTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBoYW5kbGVXb3JrZmxvd0NvbW1hbmQodHJpbW1lZDogc3RyaW5nLCBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LCBwaTogRXh0ZW5zaW9uQVBJKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIC8vIFx1MjUwMFx1MjUwMCAvZ3NkIGRvIFx1MjAxNCBuYXR1cmFsIGxhbmd1YWdlIHJvdXRpbmcgKG11c3QgYmUgZWFybHkgdG8gcm91dGUgdG8gb3RoZXIgY29tbWFuZHMpIFx1MjUwMFx1MjUwMFxuICBpZiAodHJpbW1lZCA9PT0gXCJkb1wiIHx8IHRyaW1tZWQuc3RhcnRzV2l0aChcImRvIFwiKSkge1xuICAgIGlmIChyZXF1aXJlTm90QXV0b0FjdGl2ZShcIi9nc2QgZG9cIiwgY3R4KSkgcmV0dXJuIHRydWU7XG4gICAgY29uc3QgeyBoYW5kbGVEbyB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vLi4vY29tbWFuZHMtZG8uanNcIik7XG4gICAgYXdhaXQgaGFuZGxlRG8odHJpbW1lZC5yZXBsYWNlKC9eZG9cXHMqLywgXCJcIikudHJpbSgpLCBjdHgsIHBpKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICAvLyBcdTI1MDBcdTI1MDAgQmFja2xvZyBtYW5hZ2VtZW50IFx1MjUwMFx1MjUwMFxuICBpZiAodHJpbW1lZCA9PT0gXCJiYWNrbG9nXCIgfHwgdHJpbW1lZC5zdGFydHNXaXRoKFwiYmFja2xvZyBcIikpIHtcbiAgICBpZiAocmVxdWlyZU5vdEF1dG9BY3RpdmUoXCIvZ3NkIGJhY2tsb2dcIiwgY3R4KSkgcmV0dXJuIHRydWU7XG4gICAgY29uc3QgeyBoYW5kbGVCYWNrbG9nIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi8uLi9jb21tYW5kcy1iYWNrbG9nLmpzXCIpO1xuICAgIGF3YWl0IGhhbmRsZUJhY2tsb2codHJpbW1lZC5yZXBsYWNlKC9eYmFja2xvZ1xccyovLCBcIlwiKS50cmltKCksIGN0eCwgcGkpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIC8vIFx1MjUwMFx1MjUwMCBDdXN0b20gd29ya2Zsb3cgY29tbWFuZHMgKGAvZ3NkIHdvcmtmbG93IC4uLmApIFx1MjUwMFx1MjUwMFxuICBpZiAodHJpbW1lZCA9PT0gXCJ3b3JrZmxvd1wiIHx8IHRyaW1tZWQuc3RhcnRzV2l0aChcIndvcmtmbG93IFwiKSkge1xuICAgIGNvbnN0IHN1YiA9IHRyaW1tZWQuc2xpY2UoXCJ3b3JrZmxvd1wiLmxlbmd0aCkudHJpbSgpO1xuICAgIHJldHVybiBoYW5kbGVDdXN0b21Xb3JrZmxvdyhzdWIsIGN0eCwgcGkpO1xuICB9XG5cbiAgaWYgKHRyaW1tZWQgPT09IFwicXVldWVcIikge1xuICAgIGlmIChyZXF1aXJlTm90QXV0b0FjdGl2ZShcIi9nc2QgcXVldWVcIiwgY3R4KSkgcmV0dXJuIHRydWU7XG4gICAgYXdhaXQgc2hvd1F1ZXVlKGN0eCwgcGksIHByb2plY3RSb290KCkpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGlmICh0cmltbWVkID09PSBcImRpc2N1c3NcIikge1xuICAgIGlmIChyZXF1aXJlTm90QXV0b0FjdGl2ZShcIi9nc2QgZGlzY3Vzc1wiLCBjdHgpKSByZXR1cm4gdHJ1ZTtcbiAgICBhd2FpdCBzaG93RGlzY3VzcyhjdHgsIHBpLCBwcm9qZWN0Um9vdCgpKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICBpZiAodHJpbW1lZCA9PT0gXCJxdWlja1wiIHx8IHRyaW1tZWQuc3RhcnRzV2l0aChcInF1aWNrIFwiKSkge1xuICAgIGlmIChyZXF1aXJlTm90QXV0b0FjdGl2ZShcIi9nc2QgcXVpY2tcIiwgY3R4KSkgcmV0dXJuIHRydWU7XG4gICAgYXdhaXQgaGFuZGxlUXVpY2sodHJpbW1lZC5yZXBsYWNlKC9ecXVpY2tcXHMqLywgXCJcIikudHJpbSgpLCBjdHgsIHBpKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICBpZiAodHJpbW1lZCA9PT0gXCJuZXctbWlsZXN0b25lXCIgfHwgdHJpbW1lZC5zdGFydHNXaXRoKFwibmV3LW1pbGVzdG9uZSBcIikpIHtcbiAgICBpZiAocmVxdWlyZU5vdEF1dG9BY3RpdmUoXCIvZ3NkIG5ldy1taWxlc3RvbmVcIiwgY3R4KSkgcmV0dXJuIHRydWU7XG4gICAgY29uc3QgYmFzZVBhdGggPSBwcm9qZWN0Um9vdCgpO1xuICAgIGNvbnN0IGFyZ3MgPSB0cmltbWVkLnJlcGxhY2UoL15uZXctbWlsZXN0b25lXFxzKi8sIFwiXCIpLnRyaW0oKTtcbiAgICBpZiAoLyhefFxccyktLWRlZXAoXFxzfCQpLy50ZXN0KGFyZ3MpKSB7XG4gICAgICBzZXRQbGFubmluZ0RlcHRoKGJhc2VQYXRoLCBcImRlZXBcIik7XG4gICAgICBjdHgudWkubm90aWZ5KFwiRGVlcCBwbGFubmluZyBtb2RlIGVuYWJsZWQgKC5nc2QvUFJFRkVSRU5DRVMubWQgdXBkYXRlZCkuXCIsIFwiaW5mb1wiKTtcbiAgICB9XG4gICAgY29uc3QgaGVhZGxlc3NDb250ZXh0UGF0aCA9IGpvaW4oZ3NkUm9vdChiYXNlUGF0aCksIFwicnVudGltZVwiLCBcImhlYWRsZXNzLWNvbnRleHQubWRcIik7XG4gICAgaWYgKGV4aXN0c1N5bmMoaGVhZGxlc3NDb250ZXh0UGF0aCkpIHtcbiAgICAgIGNvbnN0IHNlZWRDb250ZXh0ID0gcmVhZEZpbGVTeW5jKGhlYWRsZXNzQ29udGV4dFBhdGgsIFwidXRmLThcIik7XG4gICAgICB0cnkgeyB1bmxpbmtTeW5jKGhlYWRsZXNzQ29udGV4dFBhdGgpOyB9IGNhdGNoIHsgLyogbm9uLWZhdGFsICovIH1cbiAgICAgIGF3YWl0IHNob3dIZWFkbGVzc01pbGVzdG9uZUNyZWF0aW9uKGN0eCwgcGksIGJhc2VQYXRoLCBzZWVkQ29udGV4dCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IHsgc2hvd1NtYXJ0RW50cnkgfSA9IGF3YWl0IGltcG9ydChcIi4uLy4uL2d1aWRlZC1mbG93LmpzXCIpO1xuICAgICAgYXdhaXQgc2hvd1NtYXJ0RW50cnkoY3R4LCBwaSwgYmFzZVBhdGgpO1xuICAgIH1cbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICBpZiAodHJpbW1lZCA9PT0gXCJuZXctcHJvamVjdFwiIHx8IHRyaW1tZWQuc3RhcnRzV2l0aChcIm5ldy1wcm9qZWN0IFwiKSkge1xuICAgIC8vIERpcmVjdCBlbnRyeXBvaW50IGZvciBuZXctcHJvamVjdCBib290c3RyYXAuXG4gICAgLy8gUm91dGVzIHRocm91Z2ggc2hvd1NtYXJ0RW50cnkgKHNhbWUgYXMgbmV3LW1pbGVzdG9uZSBmb3IgZmlyc3QgcHJvamVjdCksXG4gICAgLy8gYnV0IGFjY2VwdHMgLS1kZWVwIHRvIG9wdCBpbnRvIHN0YWdlZCBwcm9qZWN0LWxldmVsIGRpc2NvdmVyeSAoZGVlcCBtb2RlKS5cbiAgICBpZiAocmVxdWlyZU5vdEF1dG9BY3RpdmUoXCIvZ3NkIG5ldy1wcm9qZWN0XCIsIGN0eCkpIHJldHVybiB0cnVlO1xuICAgIGNvbnN0IGJhc2VQYXRoID0gY3VycmVudERpcmVjdG9yeVJvb3QoKTtcbiAgICBjb25zdCBhcmdzID0gdHJpbW1lZC5yZXBsYWNlKC9ebmV3LXByb2plY3RcXHMqLywgXCJcIikudHJpbSgpO1xuICAgIGlmICgvKF58XFxzKS0tZGVlcChcXHN8JCkvLnRlc3QoYXJncykpIHtcbiAgICAgIHNldFBsYW5uaW5nRGVwdGgoYmFzZVBhdGgsIFwiZGVlcFwiKTtcbiAgICAgIGN0eC51aS5ub3RpZnkoXCJEZWVwIHBsYW5uaW5nIG1vZGUgZW5hYmxlZCAoLmdzZC9QUkVGRVJFTkNFUy5tZCB1cGRhdGVkKS5cIiwgXCJpbmZvXCIpO1xuICAgIH1cbiAgICBjb25zdCB7IHNob3dTbWFydEVudHJ5IH0gPSBhd2FpdCBpbXBvcnQoXCIuLi8uLi9ndWlkZWQtZmxvdy5qc1wiKTtcbiAgICBhd2FpdCBzaG93U21hcnRFbnRyeShjdHgsIHBpLCBiYXNlUGF0aCk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgaWYgKHRyaW1tZWQgPT09IFwic3RhcnRcIiB8fCB0cmltbWVkLnN0YXJ0c1dpdGgoXCJzdGFydCBcIikpIHtcbiAgICBhd2FpdCBoYW5kbGVTdGFydCh0cmltbWVkLnJlcGxhY2UoL15zdGFydFxccyovLCBcIlwiKS50cmltKCksIGN0eCwgcGkpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGlmICh0cmltbWVkID09PSBcInRlbXBsYXRlc1wiIHx8IHRyaW1tZWQuc3RhcnRzV2l0aChcInRlbXBsYXRlcyBcIikpIHtcbiAgICBhd2FpdCBoYW5kbGVUZW1wbGF0ZXModHJpbW1lZC5yZXBsYWNlKC9edGVtcGxhdGVzXFxzKi8sIFwiXCIpLnRyaW0oKSwgY3R4KTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICBpZiAodHJpbW1lZCA9PT0gXCJwYXJrXCIgfHwgdHJpbW1lZC5zdGFydHNXaXRoKFwicGFyayBcIikpIHtcbiAgICBpZiAocmVxdWlyZU5vdEF1dG9BY3RpdmUoXCIvZ3NkIHBhcmtcIiwgY3R4KSkgcmV0dXJuIHRydWU7XG4gICAgY29uc3QgYmFzZVBhdGggPSBwcm9qZWN0Um9vdCgpO1xuICAgIGNvbnN0IGFyZyA9IHRyaW1tZWQucmVwbGFjZSgvXnBhcmtcXHMqLywgXCJcIikudHJpbSgpO1xuICAgIGxldCB0YXJnZXRJZCA9IGFyZztcbiAgICBpZiAoIXRhcmdldElkKSB7XG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2VQYXRoKTtcbiAgICAgIGlmICghc3RhdGUuYWN0aXZlTWlsZXN0b25lKSB7XG4gICAgICAgIGN0eC51aS5ub3RpZnkoXCJObyBhY3RpdmUgbWlsZXN0b25lIHRvIHBhcmsuXCIsIFwid2FybmluZ1wiKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9XG4gICAgICB0YXJnZXRJZCA9IHN0YXRlLmFjdGl2ZU1pbGVzdG9uZS5pZDtcbiAgICB9XG4gICAgaWYgKGlzUGFya2VkKGJhc2VQYXRoLCB0YXJnZXRJZCkpIHtcbiAgICAgIGN0eC51aS5ub3RpZnkoYCR7dGFyZ2V0SWR9IGlzIGFscmVhZHkgcGFya2VkLiBVc2UgL2dzZCB1bnBhcmsgJHt0YXJnZXRJZH0gdG8gcmVhY3RpdmF0ZS5gLCBcImluZm9cIik7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgY29uc3QgcmVhc29uUGFydHMgPSBhcmcucmVwbGFjZSh0YXJnZXRJZCwgXCJcIikudHJpbSgpLnJlcGxhY2UoL15bXCInXXxbXCInXSQvZywgXCJcIik7XG4gICAgY29uc3QgcmVhc29uID0gcmVhc29uUGFydHMgfHwgXCJQYXJrZWQgdmlhIC9nc2QgcGFya1wiO1xuICAgIGNvbnN0IHN1Y2Nlc3MgPSBwYXJrTWlsZXN0b25lKGJhc2VQYXRoLCB0YXJnZXRJZCwgcmVhc29uKTtcbiAgICBjdHgudWkubm90aWZ5KFxuICAgICAgc3VjY2VzcyA/IGBQYXJrZWQgJHt0YXJnZXRJZH0uIFJ1biAvZ3NkIHVucGFyayAke3RhcmdldElkfSB0byByZWFjdGl2YXRlLmAgOiBgQ291bGQgbm90IHBhcmsgJHt0YXJnZXRJZH0gXHUyMDE0IG1pbGVzdG9uZSBub3QgZm91bmQuYCxcbiAgICAgIHN1Y2Nlc3MgPyBcImluZm9cIiA6IFwid2FybmluZ1wiLFxuICAgICk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgaWYgKHRyaW1tZWQgPT09IFwidW5wYXJrXCIgfHwgdHJpbW1lZC5zdGFydHNXaXRoKFwidW5wYXJrIFwiKSkge1xuICAgIGlmIChyZXF1aXJlTm90QXV0b0FjdGl2ZShcIi9nc2QgdW5wYXJrXCIsIGN0eCkpIHJldHVybiB0cnVlO1xuICAgIGNvbnN0IGJhc2VQYXRoID0gcHJvamVjdFJvb3QoKTtcbiAgICBjb25zdCBhcmcgPSB0cmltbWVkLnJlcGxhY2UoL151bnBhcmtcXHMqLywgXCJcIikudHJpbSgpO1xuICAgIGxldCB0YXJnZXRJZCA9IGFyZztcbiAgICBpZiAoIXRhcmdldElkKSB7XG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2VQYXRoKTtcbiAgICAgIGNvbnN0IHBhcmtlZEVudHJpZXMgPSBzdGF0ZS5yZWdpc3RyeS5maWx0ZXIoKGVudHJ5KSA9PiBlbnRyeS5zdGF0dXMgPT09IFwicGFya2VkXCIpO1xuICAgICAgaWYgKHBhcmtlZEVudHJpZXMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIGN0eC51aS5ub3RpZnkoXCJObyBwYXJrZWQgbWlsZXN0b25lcy5cIiwgXCJpbmZvXCIpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICAgIGlmIChwYXJrZWRFbnRyaWVzLmxlbmd0aCA9PT0gMSkge1xuICAgICAgICB0YXJnZXRJZCA9IHBhcmtlZEVudHJpZXNbMF0uaWQ7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjdHgudWkubm90aWZ5KGBQYXJrZWQgbWlsZXN0b25lczogJHtwYXJrZWRFbnRyaWVzLm1hcCgoZW50cnkpID0+IGVudHJ5LmlkKS5qb2luKFwiLCBcIil9LiBTcGVjaWZ5IHdoaWNoIHRvIHVucGFyazogL2dzZCB1bnBhcmsgPGlkPmAsIFwiaW5mb1wiKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IHN1Y2Nlc3MgPSB1bnBhcmtNaWxlc3RvbmUoYmFzZVBhdGgsIHRhcmdldElkKTtcbiAgICBjdHgudWkubm90aWZ5KFxuICAgICAgc3VjY2VzcyA/IGBVbnBhcmtlZCAke3RhcmdldElkfS4gSXQgd2lsbCByZXN1bWUgaXRzIG5vcm1hbCBwb3NpdGlvbiBpbiB0aGUgcXVldWUuYCA6IGBDb3VsZCBub3QgdW5wYXJrICR7dGFyZ2V0SWR9IFx1MjAxNCBtaWxlc3RvbmUgbm90IGZvdW5kIG9yIG5vdCBwYXJrZWQuYCxcbiAgICAgIHN1Y2Nlc3MgPyBcImluZm9cIiA6IFwid2FybmluZ1wiLFxuICAgICk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgcmV0dXJuIGZhbHNlO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0TmV4dE1pbGVzdG9uZUlkKGJhc2VQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBtaWxlc3RvbmVJZHMgPSBmaW5kTWlsZXN0b25lSWRzKGJhc2VQYXRoKTtcbiAgY29uc3QgdW5pcXVlSWRzID0gISFsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMoKT8ucHJlZmVyZW5jZXM/LnVuaXF1ZV9taWxlc3RvbmVfaWRzO1xuICByZXR1cm4gbmV4dE1pbGVzdG9uZUlkKG1pbGVzdG9uZUlkcywgdW5pcXVlSWRzKTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUVBLFNBQVMsWUFBWSxjQUFjLGtCQUFrQjtBQUNyRCxTQUFTLFlBQVk7QUFDckIsU0FBUyxTQUFTLGlCQUFpQjtBQUVuQyxTQUFTLG1CQUFtQjtBQUM1QixTQUFTLGFBQWEsK0JBQStCLGlCQUFpQjtBQUN0RSxTQUFTLGFBQWEsaUJBQWlCLG1DQUFtQztBQUMxRSxTQUFTLGVBQWU7QUFDeEIsU0FBUyxtQkFBbUI7QUFDNUIsU0FBUyxVQUFVLGVBQWUsdUJBQXVCO0FBQ3pELFNBQVMsbUNBQW1DO0FBQzVDLFNBQVMsd0JBQXdCO0FBQ2pDLFNBQVMsdUJBQXVCO0FBQ2hDLFNBQVMsd0JBQXdCO0FBQ2pDLFNBQVMsc0JBQXNCLG1CQUFtQjtBQUNsRCxTQUFTLFdBQVcsZ0JBQWdCO0FBQ3BDO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUNQLFNBQVMsMEJBQTBCO0FBQ25DO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FFSztBQUNQLFNBQVMsdUJBQXVCO0FBQ2hDO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQVdQLFNBQVMscUJBQXFCLGFBQXFCLEtBQXVDO0FBQ3hGLE1BQUksQ0FBQyxhQUFhLEVB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
