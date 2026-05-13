import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve as resolvePath, sep } from "node:path";
import { homedir } from "node:os";
import { deriveState } from "./state.js";
import { gsdRoot } from "./paths.js";
import { gsdHome } from "./gsd-home.js";
import { appendCapture, hasPendingCaptures, loadPendingCaptures } from "./captures.js";
import { appendOverride, appendKnowledge } from "./files.js";
import {
  formatDoctorIssuesForPrompt,
  formatDoctorReport,
  formatDoctorReportJson,
  runGSDDoctor,
  selectDoctorScope,
  filterDoctorIssues
} from "./doctor.js";
import { isAutoActive, checkRemoteAutoSession } from "./auto.js";
import { getAutoWorktreePath } from "./auto-worktree.js";
import { currentDirectoryRoot, projectRoot } from "./commands/context.js";
import { loadPrompt } from "./prompt-loader.js";
import {
  buildDoctorHealIssuePayload,
  buildDoctorHealSummary,
  buildWorkflowDispatchContent
} from "./workflow-protocol.js";
import {
  restoreGsdWorkflowTools,
  scopeGsdWorkflowToolsForDispatch
} from "./bootstrap/register-hooks.js";
const UPDATE_REGISTRY_URL = "https://registry.npmjs.org/gsd-pi/latest";
const UPDATE_FETCH_TIMEOUT_MS = 5e3;
function isBunInstall(argv1 = process.argv[1]) {
  if ("bun" in process.versions) return true;
  if (!argv1) return false;
  const bunBinDirs = [];
  if (process.env.BUN_INSTALL) bunBinDirs.push(join(process.env.BUN_INSTALL, "bin"));
  bunBinDirs.push(join(homedir(), ".bun", "bin"));
  const resolved = resolvePath(argv1);
  return bunBinDirs.some((dir) => resolved.startsWith(resolvePath(dir) + sep));
}
function resolveInstallCommand(pkg) {
  if (isBunInstall()) return `bun add -g ${pkg}`;
  return `npm install -g ${pkg}`;
}
async function fetchLatestVersionForCommand() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPDATE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(UPDATE_REGISTRY_URL, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    const latest = typeof data.version === "string" ? data.version.trim().replace(/^v/, "") : "";
    return latest.length > 0 ? latest : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
function dispatchDoctorHeal(pi, scope, reportText, structuredIssues) {
  const workflowPath = process.env.GSD_WORKFLOW_PATH ?? join(gsdHome(), "agent", "GSD-WORKFLOW.md");
  const workflow = readFileSync(workflowPath, "utf-8");
  const prompt = loadPrompt("doctor-heal", {
    doctorSummary: buildDoctorHealSummary(reportText),
    structuredIssues: buildDoctorHealIssuePayload(structuredIssues),
    scopeLabel: scope ?? "active milestone / blocking scope",
    doctorCommandSuffix: scope ? ` ${scope}` : ""
  });
  const content = buildWorkflowDispatchContent({ workflow, workflowPath, task: prompt });
  const savedTools = scopeGsdWorkflowToolsForDispatch(pi);
  try {
    pi.sendMessage(
      { customType: "gsd-doctor-heal", content, display: false },
      { triggerTurn: true }
    );
  } finally {
    restoreGsdWorkflowTools(pi, savedTools);
  }
}
function parseDoctorArgs(args) {
  const trimmed = args.trim();
  const jsonMode = trimmed.includes("--json");
  const dryRun = trimmed.includes("--dry-run");
  const fixFlag = trimmed.includes("--fix");
  const includeBuild = trimmed.includes("--build");
  const includeTests = trimmed.includes("--test");
  const stripped = trimmed.replace(/--json|--dry-run|--build|--test|--fix/g, "").trim();
  const parts = stripped ? stripped.split(/\s+/) : [];
  const mode = parts[0] === "fix" || parts[0] === "heal" || parts[0] === "audit" ? parts[0] : "doctor";
  const requestedScope = mode === "doctor" ? parts[0] : parts[1];
  return { jsonMode, dryRun, fixFlag, includeBuild, includeTests, mode, requestedScope };
}
function isDoctorHealActionable(issue) {
  return issue.fixable && issue.severity !== "info";
}
async function handleDoctor(args, ctx, pi) {
  const { jsonMode, dryRun, fixFlag, includeBuild, includeTests, mode, requestedScope } = parseDoctorArgs(args);
  const scope = await selectDoctorScope(projectRoot(), requestedScope);
  const effectiveScope = mode === "audit" ? requestedScope : scope;
  const report = await runGSDDoctor(projectRoot(), {
    fix: mode === "fix" || mode === "heal" || dryRun || fixFlag,
    dryRun,
    scope: effectiveScope,
    includeBuild,
    includeTests
  });
  if (jsonMode) {
    ctx.ui.notify(formatDoctorReportJson(report), "info");
    return;
  }
  const reportText = formatDoctorReport(report, {
    scope: effectiveScope,
    includeWarnings: mode === "audit",
    maxIssues: mode === "audit" ? 50 : 12,
    title: mode === "audit" ? "GSD doctor audit." : mode === "heal" ? "GSD doctor heal prep." : void 0
  });
  ctx.ui.notify(reportText, report.ok ? "info" : "warning");
  if (mode === "heal") {
    const unresolved = filterDoctorIssues(report.issues, {
      scope: effectiveScope,
      includeWarnings: true
    });
    const actionable = unresolved.filter(isDoctorHealActionable);
    if (actionable.length === 0) {
      ctx.ui.notify("Doctor heal found nothing actionable to hand off to the LLM.", "info");
      return;
    }
    const structuredIssues = formatDoctorIssuesForPrompt(actionable);
    dispatchDoctorHeal(pi, effectiveScope, reportText, structuredIssues);
    ctx.ui.notify(`Doctor heal dispatched ${actionable.length} issue(s) to the LLM.`, "info");
  }
}
async function handleSkillHealth(args, ctx) {
  const {
    generateSkillHealthReport,
    formatSkillHealthReport,
    formatSkillDetail
  } = await import("./skill-health.js");
  const basePath = projectRoot();
  if (args && !args.startsWith("--")) {
    const detail = formatSkillDetail(basePath, args);
    ctx.ui.notify(detail, "info");
    return;
  }
  const staleMatch = args.match(/--stale\s+(\d+)/);
  const staleDays = staleMatch ? parseInt(staleMatch[1], 10) : void 0;
  const decliningOnly = args.includes("--declining");
  const report = generateSkillHealthReport(basePath, staleDays);
  if (decliningOnly) {
    if (report.decliningSkills.length === 0) {
      ctx.ui.notify("No skills flagged for declining performance.", "info");
      return;
    }
    const filtered = {
      ...report,
      skills: report.skills.filter((s) => s.flagged)
    };
    ctx.ui.notify(formatSkillHealthReport(filtered), "info");
    return;
  }
  ctx.ui.notify(formatSkillHealthReport(report), "info");
}
async function handleCapture(args, ctx) {
  let text = args.trim();
  if (!text) {
    ctx.ui.notify('Usage: /gsd capture "your thought here"', "warning");
    return;
  }
  if (text.startsWith('"') && text.endsWith('"') || text.startsWith("'") && text.endsWith("'")) {
    text = text.slice(1, -1);
  }
  if (!text) {
    ctx.ui.notify('Usage: /gsd capture "your thought here"', "warning");
    return;
  }
  const basePath = currentDirectoryRoot();
  const gsdDir = gsdRoot(basePath);
  if (!existsSync(gsdDir)) {
    mkdirSync(gsdDir, { recursive: true });
  }
  const id = appendCapture(basePath, text);
  ctx.ui.notify(`Captured: ${id} \u2014 "${text.length > 60 ? text.slice(0, 57) + "..." : text}"`, "info");
}
async function handleTriage(ctx, pi, basePath) {
  if (!hasPendingCaptures(basePath)) {
    ctx.ui.notify("No pending captures to triage.", "info");
    return;
  }
  const pending = loadPendingCaptures(basePath);
  ctx.ui.notify(`Triaging ${pending.length} pending capture${pending.length === 1 ? "" : "s"}...`, "info");
  const state = await deriveState(basePath);
  let currentPlan = "";
  let roadmapContext = "";
  if (state.activeMilestone && state.activeSlice) {
    const { resolveSliceFile, resolveMilestoneFile } = await import("./paths.js");
    const planFile = resolveSliceFile(basePath, state.activeMilestone.id, state.activeSlice.id, "PLAN");
    if (planFile) {
      const { loadFile: load } = await import("./files.js");
      currentPlan = await load(planFile) ?? "";
    }
    const roadmapFile = resolveMilestoneFile(basePath, state.activeMilestone.id, "ROADMAP");
    if (roadmapFile) {
      const { loadFile: load } = await import("./files.js");
      roadmapContext = await load(roadmapFile) ?? "";
    }
  }
  const capturesList = pending.map(
    (c) => `- **${c.id}**: "${c.text}" (captured: ${c.timestamp})`
  ).join("\n");
  const { loadPrompt: loadTriagePrompt } = await import("./prompt-loader.js");
  const prompt = loadTriagePrompt("triage-captures", {
    pendingCaptures: capturesList,
    currentPlan: currentPlan || "(no active slice plan)",
    roadmapContext: roadmapContext || "(no active roadmap)"
  });
  const workflowPath = process.env.GSD_WORKFLOW_PATH ?? join(gsdHome(), "agent", "GSD-WORKFLOW.md");
  const workflow = readFileSync(workflowPath, "utf-8");
  const savedTools = scopeGsdWorkflowToolsForDispatch(pi);
  try {
    pi.sendMessage(
      {
        customType: "gsd-triage",
        content: buildWorkflowDispatchContent({ workflow, workflowPath, task: prompt }),
        display: false
      },
      { triggerTurn: true }
    );
  } finally {
    restoreGsdWorkflowTools(pi, savedTools);
  }
}
async function handleSteer(change, ctx, pi) {
  const basePath = currentDirectoryRoot();
  const state = await deriveState(basePath);
  const mid = state.activeMilestone?.id ?? "none";
  const sid = state.activeSlice?.id ?? "none";
  const tid = state.activeTask?.id ?? "none";
  const appliedAt = `${mid}/${sid}/${tid}`;
  const autoRunning = isAutoActive() || checkRemoteAutoSession(basePath).running;
  const wtPath = autoRunning && mid !== "none" ? getAutoWorktreePath(basePath, mid) : null;
  const targetPath = wtPath ?? basePath;
  await appendOverride(targetPath, change, appliedAt);
  const overrideLoc = wtPath ? "worktree `.gsd/OVERRIDES.md`" : "`.gsd/OVERRIDES.md`";
  if (isAutoActive()) {
    pi.sendMessage({
      customType: "gsd-hard-steer",
      content: [
        "HARD STEER \u2014 User override registered.",
        "",
        `**Override:** ${change}`,
        "",
        `This override has been saved to ${overrideLoc} and will be injected into all future task prompts.`,
        "A document rewrite unit will run before the next task to propagate this change across all active plan documents.",
        "",
        "If you are mid-task, finish your current work respecting this override. The next dispatched unit will be a document rewrite."
      ].join("\n"),
      display: false
    }, { triggerTurn: true });
    ctx.ui.notify(`Override registered (${overrideLoc}): "${change}". Will be applied before next task dispatch.`, "info");
  } else {
    pi.sendMessage({
      customType: "gsd-hard-steer",
      content: [
        "HARD STEER \u2014 User override registered.",
        "",
        `**Override:** ${change}`,
        "",
        `This override has been saved to ${overrideLoc}.`,
        `Before continuing, read ${overrideLoc} and update the current plan documents to reflect this change.`,
        "Focus on: active slice plan, incomplete task plans, and DECISIONS.md."
      ].join("\n"),
      display: false
    }, { triggerTurn: true });
    ctx.ui.notify(`Override registered (${overrideLoc}): "${change}". Update plan documents to reflect this change.`, "info");
  }
}
async function handleKnowledge(args, ctx) {
  const parts = args.split(/\s+/);
  const typeArg = parts[0]?.toLowerCase();
  if (!typeArg || !["rule", "pattern", "lesson"].includes(typeArg)) {
    ctx.ui.notify(
      "Usage: /gsd knowledge <rule|pattern|lesson> <description>\nExample: /gsd knowledge rule Use real DB for integration tests",
      "warning"
    );
    return;
  }
  const entryText = parts.slice(1).join(" ").trim();
  if (!entryText) {
    ctx.ui.notify(`Usage: /gsd knowledge ${typeArg} <description>`, "warning");
    return;
  }
  const type = typeArg;
  const basePath = currentDirectoryRoot();
  const state = await deriveState(basePath);
  const scope = state.activeMilestone?.id ? `${state.activeMilestone.id}${state.activeSlice ? `/${state.activeSlice.id}` : ""}` : "global";
  if (type === "rule") {
    await appendKnowledge(basePath, type, entryText, scope);
    ctx.ui.notify(`Added rule to KNOWLEDGE.md: "${entryText}"`, "success");
    return;
  }
  const { captureKnowledgeEntry } = await import("./knowledge-capture.js");
  const { id, written } = captureKnowledgeEntry(basePath, type, entryText, scope);
  if (!written) {
    ctx.ui.notify(`Could not persist ${type} \u2014 see logs for details.`, "error");
    return;
  }
  ctx.ui.notify(
    `Captured ${type} ${id} to memories; KNOWLEDGE.md will render it on next session start.`,
    "success"
  );
}
async function handleRunHook(args, ctx, pi) {
  const parts = args.trim().split(/\s+/);
  if (parts.length < 3) {
    ctx.ui.notify(`Usage: /gsd run-hook <hook-name> <unit-type> <unit-id>

Unit types:
  execute-task   - Task execution (unit-id: M001/S01/T01)
  plan-slice     - Slice planning (unit-id: M001/S01)
  research-milestone - Milestone research (unit-id: M001)
  complete-slice - Slice completion (unit-id: M001/S01)
  complete-milestone - Milestone completion (unit-id: M001)

Examples:
  /gsd run-hook code-review execute-task M001/S01/T01
  /gsd run-hook lint-check plan-slice M001/S01`, "warning");
    return;
  }
  const [hookName, unitType, unitId] = parts;
  const basePath = currentDirectoryRoot();
  const { triggerHookManually, formatHookStatus, getHookStatus } = await import("./post-unit-hooks.js");
  const { dispatchHookUnit } = await import("./auto.js");
  const hooks = getHookStatus();
  const hookExists = hooks.some((h) => h.name === hookName);
  if (!hookExists) {
    ctx.ui.notify(`Hook "${hookName}" not found. Configured hooks:
${formatHookStatus()}`, "error");
    return;
  }
  const unitIdPattern = /^M\d{3}\/S\d{2,3}\/T\d{2,3}$/;
  if (!unitIdPattern.test(unitId)) {
    ctx.ui.notify(`Invalid unit ID format: "${unitId}". Expected format: M004/S04/T03`, "warning");
    return;
  }
  const hookUnit = triggerHookManually(hookName, unitType, unitId, basePath);
  if (!hookUnit) {
    ctx.ui.notify(`Failed to trigger hook "${hookName}". The hook may be disabled or not configured for unit type "${unitType}".`, "error");
    return;
  }
  ctx.ui.notify(`Manually triggering hook: ${hookName} for ${unitType} ${unitId}`, "info");
  const success = await dispatchHookUnit(
    ctx,
    pi,
    hookName,
    unitType,
    unitId,
    hookUnit.prompt,
    hookUnit.model,
    basePath
  );
  if (!success) {
    ctx.ui.notify("Failed to dispatch hook. Auto-mode may have been cancelled.", "error");
  }
}
function compareSemverLocal(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}
async function handleUpdate(ctx) {
  const { execSync } = await import("node:child_process");
  const NPM_PACKAGE = "gsd-pi";
  const current = process.env.GSD_VERSION || "0.0.0";
  ctx.ui.notify(`Current version: v${current}
Checking npm registry...`, "info");
  const latest = await fetchLatestVersionForCommand();
  if (!latest) {
    ctx.ui.notify("Failed to reach npm registry. Check your network connection.", "error");
    return;
  }
  if (compareSemverLocal(latest, current) <= 0) {
    ctx.ui.notify(`Already up to date (v${current}).`, "info");
    return;
  }
  ctx.ui.notify(`Updating: v${current} \u2192 v${latest}...`, "info");
  const installCmd = resolveInstallCommand(`${NPM_PACKAGE}@latest`);
  try {
    execSync(installCmd, {
      stdio: ["ignore", "pipe", "ignore"]
    });
    ctx.ui.notify(
      `Updated to v${latest}. Restart your GSD session to use the new version.`,
      "info"
    );
  } catch {
    ctx.ui.notify(
      `Update failed. Try manually: ${installCmd}`,
      "error"
    );
  }
}
export {
  dispatchDoctorHeal,
  handleCapture,
  handleDoctor,
  handleKnowledge,
  handleRunHook,
  handleSkillHealth,
  handleSteer,
  handleTriage,
  handleUpdate,
  isDoctorHealActionable,
  parseDoctorArgs
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9jb21tYW5kcy1oYW5kbGVycy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBHU0QgQ29tbWFuZCBIYW5kbGVycyBcdTIwMTQgZmlyZS1hbmQtZm9yZ2V0IGhhbmRsZXJzIHRoYXQgZGVsZWdhdGUgdG8gb3RoZXIgbW9kdWxlcy5cbiAqXG4gKiBDb250YWluczogaGFuZGxlRG9jdG9yLCBoYW5kbGVTdGVlciwgaGFuZGxlQ2FwdHVyZSwgaGFuZGxlVHJpYWdlLCBoYW5kbGVLbm93bGVkZ2UsXG4gKiBoYW5kbGVSdW5Ib29rLCBoYW5kbGVVcGRhdGUsIGhhbmRsZVNraWxsSGVhbHRoXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBFeHRlbnNpb25BUEksIEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0IH0gZnJvbSBcIkBnc2QvcGktY29kaW5nLWFnZW50XCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkRmlsZVN5bmMsIG1rZGlyU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luLCByZXNvbHZlIGFzIHJlc29sdmVQYXRoLCBzZXAgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBob21lZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGRlcml2ZVN0YXRlIH0gZnJvbSBcIi4vc3RhdGUuanNcIjtcbmltcG9ydCB7IGdzZFJvb3QgfSBmcm9tIFwiLi9wYXRocy5qc1wiO1xuaW1wb3J0IHsgZ3NkSG9tZSB9IGZyb20gXCIuL2dzZC1ob21lLmpzXCI7XG5pbXBvcnQgeyBhcHBlbmRDYXB0dXJlLCBoYXNQZW5kaW5nQ2FwdHVyZXMsIGxvYWRQZW5kaW5nQ2FwdHVyZXMgfSBmcm9tIFwiLi9jYXB0dXJlcy5qc1wiO1xuaW1wb3J0IHsgYXBwZW5kT3ZlcnJpZGUsIGFwcGVuZEtub3dsZWRnZSB9IGZyb20gXCIuL2ZpbGVzLmpzXCI7XG5pbXBvcnQge1xuICBmb3JtYXREb2N0b3JJc3N1ZXNGb3JQcm9tcHQsXG4gIGZvcm1hdERvY3RvclJlcG9ydCxcbiAgZm9ybWF0RG9jdG9yUmVwb3J0SnNvbixcbiAgcnVuR1NERG9jdG9yLFxuICBzZWxlY3REb2N0b3JTY29wZSxcbiAgZmlsdGVyRG9jdG9ySXNzdWVzLFxufSBmcm9tIFwiLi9kb2N0b3IuanNcIjtcbmltcG9ydCB7IGlzQXV0b0FjdGl2ZSwgY2hlY2tSZW1vdGVBdXRvU2Vzc2lvbiB9IGZyb20gXCIuL2F1dG8uanNcIjtcbmltcG9ydCB7IGdldEF1dG9Xb3JrdHJlZVBhdGggfSBmcm9tIFwiLi9hdXRvLXdvcmt0cmVlLmpzXCI7XG5pbXBvcnQgeyBjdXJyZW50RGlyZWN0b3J5Um9vdCwgcHJvamVjdFJvb3QgfSBmcm9tIFwiLi9jb21tYW5kcy9jb250ZXh0LmpzXCI7XG5pbXBvcnQgeyBsb2FkUHJvbXB0IH0gZnJvbSBcIi4vcHJvbXB0LWxvYWRlci5qc1wiO1xuaW1wb3J0IHtcbiAgYnVpbGREb2N0b3JIZWFsSXNzdWVQYXlsb2FkLFxuICBidWlsZERvY3RvckhlYWxTdW1tYXJ5LFxuICBidWlsZFdvcmtmbG93RGlzcGF0Y2hDb250ZW50LFxufSBmcm9tIFwiLi93b3JrZmxvdy1wcm90b2NvbC5qc1wiO1xuaW1wb3J0IHtcbiAgcmVzdG9yZUdzZFdvcmtmbG93VG9vbHMsXG4gIHNjb3BlR3NkV29ya2Zsb3dUb29sc0ZvckRpc3BhdGNoLFxufSBmcm9tIFwiLi9ib290c3RyYXAvcmVnaXN0ZXItaG9va3MuanNcIjtcblxuY29uc3QgVVBEQVRFX1JFR0lTVFJZX1VSTCA9IFwiaHR0cHM6Ly9yZWdpc3RyeS5ucG1qcy5vcmcvZ3NkLXBpL2xhdGVzdFwiO1xuY29uc3QgVVBEQVRFX0ZFVENIX1RJTUVPVVRfTVMgPSA1MDAwO1xuXG4vLyBEZXRlY3RzIGEgYnVuLWluc3RhbGxlZCBnc2QgdmlhIGBwcm9jZXNzLmFyZ3ZbMV1gLiBNaXJyb3JzIGlzQnVuSW5zdGFsbCBpblxuLy8gc3JjL3VwZGF0ZS1jaGVjay50cyBcdTIwMTQgZHVwbGljYXRlZCBiZWNhdXNlIHRzY29uZmlnLnJlc291cmNlcy5qc29uIHJvb3REaXJcbi8vIHByZXZlbnRzIGltcG9ydGluZyBmcm9tIHNyYy8uIFNlZSAjNDE0NSBmb3Igd2h5IHRoZSBydW50aW1lLW9ubHkgY2hlY2tcbi8vIChwcm9jZXNzLnZlcnNpb25zLmJ1bikgaXMgaW5zdWZmaWNpZW50OiBidW4ncyBnbG9iYWwgYmluIHNoaW1zIGFyZSBwbGFpblxuLy8gc3ltbGlua3MsIHNvIHRoZSB0YXJnZXQncyAjIS91c3IvYmluL2VudiBub2RlIHNoZWJhbmcgcnVucyB0aGUgc2NyaXB0IHVuZGVyXG4vLyBOb2RlIGV2ZW4gd2hlbiBpdCB3YXMgaW5zdGFsbGVkIGJ5IGJ1bi5cbmZ1bmN0aW9uIGlzQnVuSW5zdGFsbChhcmd2MTogc3RyaW5nIHwgdW5kZWZpbmVkID0gcHJvY2Vzcy5hcmd2WzFdKTogYm9vbGVhbiB7XG4gIGlmICgnYnVuJyBpbiBwcm9jZXNzLnZlcnNpb25zKSByZXR1cm4gdHJ1ZTtcbiAgaWYgKCFhcmd2MSkgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBidW5CaW5EaXJzOiBzdHJpbmdbXSA9IFtdO1xuICBpZiAocHJvY2Vzcy5lbnYuQlVOX0lOU1RBTEwpIGJ1bkJpbkRpcnMucHVzaChqb2luKHByb2Nlc3MuZW52LkJVTl9JTlNUQUxMLCBcImJpblwiKSk7XG4gIGJ1bkJpbkRpcnMucHVzaChqb2luKGhvbWVkaXIoKSwgXCIuYnVuXCIsIFwiYmluXCIpKTtcbiAgY29uc3QgcmVzb2x2ZWQgPSByZXNvbHZlUGF0aChhcmd2MSk7XG4gIHJldHVybiBidW5CaW5EaXJzLnNvbWUoKGRpcikgPT4gcmVzb2x2ZWQuc3RhcnRzV2l0aChyZXNvbHZlUGF0aChkaXIpICsgc2VwKSk7XG59XG5cbmZ1bmN0aW9uIHJlc29sdmVJbnN0YWxsQ29tbWFuZChwa2c6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmIChpc0J1bkluc3RhbGwoKSkgcmV0dXJuIGBidW4gYWRkIC1nICR7cGtnfWA7XG4gIHJldHVybiBgbnBtIGluc3RhbGwgLWcgJHtwa2d9YDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZmV0Y2hMYXRlc3RWZXJzaW9uRm9yQ29tbWFuZCgpOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgY29uc3QgY29udHJvbGxlciA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgY29uc3QgdGltZW91dCA9IHNldFRpbWVvdXQoKCkgPT4gY29udHJvbGxlci5hYm9ydCgpLCBVUERBVEVfRkVUQ0hfVElNRU9VVF9NUyk7XG5cbiAgdHJ5IHtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChVUERBVEVfUkVHSVNUUllfVVJMLCB7IHNpZ25hbDogY29udHJvbGxlci5zaWduYWwgfSk7XG4gICAgaWYgKCFyZXMub2spIHJldHVybiBudWxsO1xuICAgIGNvbnN0IGRhdGEgPSAoYXdhaXQgcmVzLmpzb24oKSkgYXMgeyB2ZXJzaW9uPzogc3RyaW5nIH07XG4gICAgY29uc3QgbGF0ZXN0ID0gdHlwZW9mIGRhdGEudmVyc2lvbiA9PT0gXCJzdHJpbmdcIiA/IGRhdGEudmVyc2lvbi50cmltKCkucmVwbGFjZSgvXnYvLCBcIlwiKSA6IFwiXCI7XG4gICAgcmV0dXJuIGxhdGVzdC5sZW5ndGggPiAwID8gbGF0ZXN0IDogbnVsbDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYXJUaW1lb3V0KHRpbWVvdXQpO1xuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBkaXNwYXRjaERvY3RvckhlYWwocGk6IEV4dGVuc2lvbkFQSSwgc2NvcGU6IHN0cmluZyB8IHVuZGVmaW5lZCwgcmVwb3J0VGV4dDogc3RyaW5nLCBzdHJ1Y3R1cmVkSXNzdWVzOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3Qgd29ya2Zsb3dQYXRoID0gcHJvY2Vzcy5lbnYuR1NEX1dPUktGTE9XX1BBVEggPz8gam9pbihnc2RIb21lKCksIFwiYWdlbnRcIiwgXCJHU0QtV09SS0ZMT1cubWRcIik7XG4gIGNvbnN0IHdvcmtmbG93ID0gcmVhZEZpbGVTeW5jKHdvcmtmbG93UGF0aCwgXCJ1dGYtOFwiKTtcbiAgY29uc3QgcHJvbXB0ID0gbG9hZFByb21wdChcImRvY3Rvci1oZWFsXCIsIHtcbiAgICBkb2N0b3JTdW1tYXJ5OiBidWlsZERvY3RvckhlYWxTdW1tYXJ5KHJlcG9ydFRleHQpLFxuICAgIHN0cnVjdHVyZWRJc3N1ZXM6IGJ1aWxkRG9jdG9ySGVhbElzc3VlUGF5bG9hZChzdHJ1Y3R1cmVkSXNzdWVzKSxcbiAgICBzY29wZUxhYmVsOiBzY29wZSA/PyBcImFjdGl2ZSBtaWxlc3RvbmUgLyBibG9ja2luZyBzY29wZVwiLFxuICAgIGRvY3RvckNvbW1hbmRTdWZmaXg6IHNjb3BlID8gYCAke3Njb3BlfWAgOiBcIlwiLFxuICB9KTtcblxuICBjb25zdCBjb250ZW50ID0gYnVpbGRXb3JrZmxvd0Rpc3BhdGNoQ29udGVudCh7IHdvcmtmbG93LCB3b3JrZmxvd1BhdGgsIHRhc2s6IHByb21wdCB9KTtcbiAgY29uc3Qgc2F2ZWRUb29scyA9IHNjb3BlR3NkV29ya2Zsb3dUb29sc0ZvckRpc3BhdGNoKHBpKTtcblxuICB0cnkge1xuICAgIHBpLnNlbmRNZXNzYWdlKFxuICAgICAgeyBjdXN0b21UeXBlOiBcImdzZC1kb2N0b3ItaGVhbFwiLCBjb250ZW50LCBkaXNwbGF5OiBmYWxzZSB9LFxuICAgICAgeyB0cmlnZ2VyVHVybjogdHJ1ZSB9LFxuICAgICk7XG4gIH0gZmluYWxseSB7XG4gICAgcmVzdG9yZUdzZFdvcmtmbG93VG9vbHMocGksIHNhdmVkVG9vbHMpO1xuICB9XG59XG5cbi8qKiBQYXJzZSBkb2N0b3IgY29tbWFuZCBhcmdzIGludG8gc3RydWN0dXJlZCBmbGFncyBhbmQgcG9zaXRpb25hbHMgKHB1cmUsIG5vIEkvTykuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VEb2N0b3JBcmdzKGFyZ3M6IHN0cmluZykge1xuICBjb25zdCB0cmltbWVkID0gYXJncy50cmltKCk7XG4gIGNvbnN0IGpzb25Nb2RlID0gdHJpbW1lZC5pbmNsdWRlcyhcIi0tanNvblwiKTtcbiAgY29uc3QgZHJ5UnVuID0gdHJpbW1lZC5pbmNsdWRlcyhcIi0tZHJ5LXJ1blwiKTtcbiAgY29uc3QgZml4RmxhZyA9IHRyaW1tZWQuaW5jbHVkZXMoXCItLWZpeFwiKTtcbiAgY29uc3QgaW5jbHVkZUJ1aWxkID0gdHJpbW1lZC5pbmNsdWRlcyhcIi0tYnVpbGRcIik7XG4gIGNvbnN0IGluY2x1ZGVUZXN0cyA9IHRyaW1tZWQuaW5jbHVkZXMoXCItLXRlc3RcIik7XG4gIGNvbnN0IHN0cmlwcGVkID0gdHJpbW1lZC5yZXBsYWNlKC8tLWpzb258LS1kcnktcnVufC0tYnVpbGR8LS10ZXN0fC0tZml4L2csIFwiXCIpLnRyaW0oKTtcbiAgY29uc3QgcGFydHMgPSBzdHJpcHBlZCA/IHN0cmlwcGVkLnNwbGl0KC9cXHMrLykgOiBbXTtcbiAgY29uc3QgbW9kZSA9IHBhcnRzWzBdID09PSBcImZpeFwiIHx8IHBhcnRzWzBdID09PSBcImhlYWxcIiB8fCBwYXJ0c1swXSA9PT0gXCJhdWRpdFwiID8gcGFydHNbMF0gOiBcImRvY3RvclwiO1xuICBjb25zdCByZXF1ZXN0ZWRTY29wZSA9IG1vZGUgPT09IFwiZG9jdG9yXCIgPyBwYXJ0c1swXSA6IHBhcnRzWzFdO1xuICByZXR1cm4geyBqc29uTW9kZSwgZHJ5UnVuLCBmaXhGbGFnLCBpbmNsdWRlQnVpbGQsIGluY2x1ZGVUZXN0cywgbW9kZSwgcmVxdWVzdGVkU2NvcGUgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzRG9jdG9ySGVhbEFjdGlvbmFibGUoaXNzdWU6IHsgZml4YWJsZTogYm9vbGVhbjsgc2V2ZXJpdHk6IHN0cmluZyB9KTogYm9vbGVhbiB7XG4gIHJldHVybiBpc3N1ZS5maXhhYmxlICYmIGlzc3VlLnNldmVyaXR5ICE9PSBcImluZm9cIjtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZURvY3RvcihhcmdzOiBzdHJpbmcsIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsIHBpOiBFeHRlbnNpb25BUEkpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgeyBqc29uTW9kZSwgZHJ5UnVuLCBmaXhGbGFnLCBpbmNsdWRlQnVpbGQsIGluY2x1ZGVUZXN0cywgbW9kZSwgcmVxdWVzdGVkU2NvcGUgfSA9IHBhcnNlRG9jdG9yQXJncyhhcmdzKTtcbiAgY29uc3Qgc2NvcGUgPSBhd2FpdCBzZWxlY3REb2N0b3JTY29wZShwcm9qZWN0Um9vdCgpLCByZXF1ZXN0ZWRTY29wZSk7XG4gIGNvbnN0IGVmZmVjdGl2ZVNjb3BlID0gbW9kZSA9PT0gXCJhdWRpdFwiID8gcmVxdWVzdGVkU2NvcGUgOiBzY29wZTtcbiAgY29uc3QgcmVwb3J0ID0gYXdhaXQgcnVuR1NERG9jdG9yKHByb2plY3RSb290KCksIHtcbiAgICBmaXg6IG1vZGUgPT09IFwiZml4XCIgfHwgbW9kZSA9PT0gXCJoZWFsXCIgfHwgZHJ5UnVuIHx8IGZpeEZsYWcsXG4gICAgZHJ5UnVuLFxuICAgIHNjb3BlOiBlZmZlY3RpdmVTY29wZSxcbiAgICBpbmNsdWRlQnVpbGQsXG4gICAgaW5jbHVkZVRlc3RzLFxuICB9KTtcblxuICBpZiAoanNvbk1vZGUpIHtcbiAgICBjdHgudWkubm90aWZ5KGZvcm1hdERvY3RvclJlcG9ydEpzb24ocmVwb3J0KSwgXCJpbmZvXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHJlcG9ydFRleHQgPSBmb3JtYXREb2N0b3JSZXBvcnQocmVwb3J0LCB7XG4gICAgc2NvcGU6IGVmZmVjdGl2ZVNjb3BlLFxuICAgIGluY2x1ZGVXYXJuaW5nczogbW9kZSA9PT0gXCJhdWRpdFwiLFxuICAgIG1heElzc3VlczogbW9kZSA9PT0gXCJhdWRpdFwiID8gNTAgOiAxMixcbiAgICB0aXRsZTogbW9kZSA9PT0gXCJhdWRpdFwiID8gXCJHU0QgZG9jdG9yIGF1ZGl0LlwiIDogbW9kZSA9PT0gXCJoZWFsXCIgPyBcIkdTRCBkb2N0b3IgaGVhbCBwcmVwLlwiIDogdW5kZWZpbmVkLFxuICB9KTtcblxuICBjdHgudWkubm90aWZ5KHJlcG9ydFRleHQsIHJlcG9ydC5vayA/IFwiaW5mb1wiIDogXCJ3YXJuaW5nXCIpO1xuXG4gIGlmIChtb2RlID09PSBcImhlYWxcIikge1xuICAgIGNvbnN0IHVucmVzb2x2ZWQgPSBmaWx0ZXJEb2N0b3JJc3N1ZXMocmVwb3J0Lmlzc3Vlcywge1xuICAgICAgc2NvcGU6IGVmZmVjdGl2ZVNjb3BlLFxuICAgICAgaW5jbHVkZVdhcm5pbmdzOiB0cnVlLFxuICAgIH0pO1xuICAgIGNvbnN0IGFjdGlvbmFibGUgPSB1bnJlc29sdmVkLmZpbHRlcihpc0RvY3RvckhlYWxBY3Rpb25hYmxlKTtcbiAgICBpZiAoYWN0aW9uYWJsZS5sZW5ndGggPT09IDApIHtcbiAgICAgIGN0eC51aS5ub3RpZnkoXCJEb2N0b3IgaGVhbCBmb3VuZCBub3RoaW5nIGFjdGlvbmFibGUgdG8gaGFuZCBvZmYgdG8gdGhlIExMTS5cIiwgXCJpbmZvXCIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IHN0cnVjdHVyZWRJc3N1ZXMgPSBmb3JtYXREb2N0b3JJc3N1ZXNGb3JQcm9tcHQoYWN0aW9uYWJsZSk7XG4gICAgZGlzcGF0Y2hEb2N0b3JIZWFsKHBpLCBlZmZlY3RpdmVTY29wZSwgcmVwb3J0VGV4dCwgc3RydWN0dXJlZElzc3Vlcyk7XG4gICAgY3R4LnVpLm5vdGlmeShgRG9jdG9yIGhlYWwgZGlzcGF0Y2hlZCAke2FjdGlvbmFibGUubGVuZ3RofSBpc3N1ZShzKSB0byB0aGUgTExNLmAsIFwiaW5mb1wiKTtcbiAgfVxufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlU2tpbGxIZWFsdGgoYXJnczogc3RyaW5nLCBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHtcbiAgICBnZW5lcmF0ZVNraWxsSGVhbHRoUmVwb3J0LFxuICAgIGZvcm1hdFNraWxsSGVhbHRoUmVwb3J0LFxuICAgIGZvcm1hdFNraWxsRGV0YWlsLFxuICB9ID0gYXdhaXQgaW1wb3J0KFwiLi9za2lsbC1oZWFsdGguanNcIik7XG5cbiAgY29uc3QgYmFzZVBhdGggPSBwcm9qZWN0Um9vdCgpO1xuXG4gIC8vIC9nc2Qgc2tpbGwtaGVhbHRoIDxza2lsbC1uYW1lPiBcdTIwMTQgZGV0YWlsIHZpZXdcbiAgaWYgKGFyZ3MgJiYgIWFyZ3Muc3RhcnRzV2l0aChcIi0tXCIpKSB7XG4gICAgY29uc3QgZGV0YWlsID0gZm9ybWF0U2tpbGxEZXRhaWwoYmFzZVBhdGgsIGFyZ3MpO1xuICAgIGN0eC51aS5ub3RpZnkoZGV0YWlsLCBcImluZm9cIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gUGFyc2UgZmxhZ3NcbiAgY29uc3Qgc3RhbGVNYXRjaCA9IGFyZ3MubWF0Y2goLy0tc3RhbGVcXHMrKFxcZCspLyk7XG4gIGNvbnN0IHN0YWxlRGF5cyA9IHN0YWxlTWF0Y2ggPyBwYXJzZUludChzdGFsZU1hdGNoWzFdLCAxMCkgOiB1bmRlZmluZWQ7XG4gIGNvbnN0IGRlY2xpbmluZ09ubHkgPSBhcmdzLmluY2x1ZGVzKFwiLS1kZWNsaW5pbmdcIik7XG5cbiAgY29uc3QgcmVwb3J0ID0gZ2VuZXJhdGVTa2lsbEhlYWx0aFJlcG9ydChiYXNlUGF0aCwgc3RhbGVEYXlzKTtcblxuICBpZiAoZGVjbGluaW5nT25seSkge1xuICAgIGlmIChyZXBvcnQuZGVjbGluaW5nU2tpbGxzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgY3R4LnVpLm5vdGlmeShcIk5vIHNraWxscyBmbGFnZ2VkIGZvciBkZWNsaW5pbmcgcGVyZm9ybWFuY2UuXCIsIFwiaW5mb1wiKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgZmlsdGVyZWQgPSB7XG4gICAgICAuLi5yZXBvcnQsXG4gICAgICBza2lsbHM6IHJlcG9ydC5za2lsbHMuZmlsdGVyKHMgPT4gcy5mbGFnZ2VkKSxcbiAgICB9O1xuICAgIGN0eC51aS5ub3RpZnkoZm9ybWF0U2tpbGxIZWFsdGhSZXBvcnQoZmlsdGVyZWQpLCBcImluZm9cIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY3R4LnVpLm5vdGlmeShmb3JtYXRTa2lsbEhlYWx0aFJlcG9ydChyZXBvcnQpLCBcImluZm9cIik7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBoYW5kbGVDYXB0dXJlKGFyZ3M6IHN0cmluZywgY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCk6IFByb21pc2U8dm9pZD4ge1xuICAvLyBTdHJpcCBzdXJyb3VuZGluZyBxdW90ZXMgZnJvbSB0aGUgYXJndW1lbnRcbiAgbGV0IHRleHQgPSBhcmdzLnRyaW0oKTtcbiAgaWYgKCF0ZXh0KSB7XG4gICAgY3R4LnVpLm5vdGlmeSgnVXNhZ2U6IC9nc2QgY2FwdHVyZSBcInlvdXIgdGhvdWdodCBoZXJlXCInLCBcIndhcm5pbmdcIik7XG4gICAgcmV0dXJuO1xuICB9XG4gIC8vIFJlbW92ZSB3cmFwcGluZyBxdW90ZXMgKHNpbmdsZSBvciBkb3VibGUpXG4gIGlmICgodGV4dC5zdGFydHNXaXRoKCdcIicpICYmIHRleHQuZW5kc1dpdGgoJ1wiJykpIHx8ICh0ZXh0LnN0YXJ0c1dpdGgoXCInXCIpICYmIHRleHQuZW5kc1dpdGgoXCInXCIpKSkge1xuICAgIHRleHQgPSB0ZXh0LnNsaWNlKDEsIC0xKTtcbiAgfVxuICBpZiAoIXRleHQpIHtcbiAgICBjdHgudWkubm90aWZ5KCdVc2FnZTogL2dzZCBjYXB0dXJlIFwieW91ciB0aG91Z2h0IGhlcmVcIicsIFwid2FybmluZ1wiKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBiYXNlUGF0aCA9IGN1cnJlbnREaXJlY3RvcnlSb290KCk7XG5cbiAgLy8gRW5zdXJlIC5nc2QvIGV4aXN0cyBcdTIwMTQgY2FwdHVyZSBzaG91bGQgd29yayBldmVuIHdpdGhvdXQgYSBtaWxlc3RvbmVcbiAgY29uc3QgZ3NkRGlyID0gZ3NkUm9vdChiYXNlUGF0aCk7XG4gIGlmICghZXhpc3RzU3luYyhnc2REaXIpKSB7XG4gICAgbWtkaXJTeW5jKGdzZERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIH1cblxuICBjb25zdCBpZCA9IGFwcGVuZENhcHR1cmUoYmFzZVBhdGgsIHRleHQpO1xuICBjdHgudWkubm90aWZ5KGBDYXB0dXJlZDogJHtpZH0gXHUyMDE0IFwiJHt0ZXh0Lmxlbmd0aCA+IDYwID8gdGV4dC5zbGljZSgwLCA1NykgKyBcIi4uLlwiIDogdGV4dH1cImAsIFwiaW5mb1wiKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZVRyaWFnZShjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LCBwaTogRXh0ZW5zaW9uQVBJLCBiYXNlUGF0aDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGlmICghaGFzUGVuZGluZ0NhcHR1cmVzKGJhc2VQYXRoKSkge1xuICAgIGN0eC51aS5ub3RpZnkoXCJObyBwZW5kaW5nIGNhcHR1cmVzIHRvIHRyaWFnZS5cIiwgXCJpbmZvXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHBlbmRpbmcgPSBsb2FkUGVuZGluZ0NhcHR1cmVzKGJhc2VQYXRoKTtcbiAgY3R4LnVpLm5vdGlmeShgVHJpYWdpbmcgJHtwZW5kaW5nLmxlbmd0aH0gcGVuZGluZyBjYXB0dXJlJHtwZW5kaW5nLmxlbmd0aCA9PT0gMSA/IFwiXCIgOiBcInNcIn0uLi5gLCBcImluZm9cIik7XG5cbiAgLy8gQnVpbGQgY29udGV4dCBmb3IgdGhlIHRyaWFnZSBwcm9tcHRcbiAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlUGF0aCk7XG4gIGxldCBjdXJyZW50UGxhbiA9IFwiXCI7XG4gIGxldCByb2FkbWFwQ29udGV4dCA9IFwiXCI7XG5cbiAgaWYgKHN0YXRlLmFjdGl2ZU1pbGVzdG9uZSAmJiBzdGF0ZS5hY3RpdmVTbGljZSkge1xuICAgIGNvbnN0IHsgcmVzb2x2ZVNsaWNlRmlsZSwgcmVzb2x2ZU1pbGVzdG9uZUZpbGUgfSA9IGF3YWl0IGltcG9ydChcIi4vcGF0aHMuanNcIik7XG4gICAgY29uc3QgcGxhbkZpbGUgPSByZXNvbHZlU2xpY2VGaWxlKGJhc2VQYXRoLCBzdGF0ZS5hY3RpdmVNaWxlc3RvbmUuaWQsIHN0YXRlLmFjdGl2ZVNsaWNlLmlkLCBcIlBMQU5cIik7XG4gICAgaWYgKHBsYW5GaWxlKSB7XG4gICAgICBjb25zdCB7IGxvYWRGaWxlOiBsb2FkIH0gPSBhd2FpdCBpbXBvcnQoXCIuL2ZpbGVzLmpzXCIpO1xuICAgICAgY3VycmVudFBsYW4gPSAoYXdhaXQgbG9hZChwbGFuRmlsZSkpID8/IFwiXCI7XG4gICAgfVxuICAgIGNvbnN0IHJvYWRtYXBGaWxlID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZVBhdGgsIHN0YXRlLmFjdGl2ZU1pbGVzdG9uZS5pZCwgXCJST0FETUFQXCIpO1xuICAgIGlmIChyb2FkbWFwRmlsZSkge1xuICAgICAgY29uc3QgeyBsb2FkRmlsZTogbG9hZCB9ID0gYXdhaXQgaW1wb3J0KFwiLi9maWxlcy5qc1wiKTtcbiAgICAgIHJvYWRtYXBDb250ZXh0ID0gKGF3YWl0IGxvYWQocm9hZG1hcEZpbGUpKSA/PyBcIlwiO1xuICAgIH1cbiAgfVxuXG4gIC8vIEZvcm1hdCBwZW5kaW5nIGNhcHR1cmVzIGZvciB0aGUgcHJvbXB0XG4gIGNvbnN0IGNhcHR1cmVzTGlzdCA9IHBlbmRpbmcubWFwKGMgPT5cbiAgICBgLSAqKiR7Yy5pZH0qKjogXCIke2MudGV4dH1cIiAoY2FwdHVyZWQ6ICR7Yy50aW1lc3RhbXB9KWBcbiAgKS5qb2luKFwiXFxuXCIpO1xuXG4gIC8vIERpc3BhdGNoIHRyaWFnZSBwcm9tcHRcbiAgY29uc3QgeyBsb2FkUHJvbXB0OiBsb2FkVHJpYWdlUHJvbXB0IH0gPSBhd2FpdCBpbXBvcnQoXCIuL3Byb21wdC1sb2FkZXIuanNcIik7XG4gIGNvbnN0IHByb21wdCA9IGxvYWRUcmlhZ2VQcm9tcHQoXCJ0cmlhZ2UtY2FwdHVyZXNcIiwge1xuICAgIHBlbmRpbmdDYXB0dXJlczogY2FwdHVyZXNMaXN0LFxuICAgIGN1cnJlbnRQbGFuOiBjdXJyZW50UGxhbiB8fCBcIihubyBhY3RpdmUgc2xpY2UgcGxhbilcIixcbiAgICByb2FkbWFwQ29udGV4dDogcm9hZG1hcENvbnRleHQgfHwgXCIobm8gYWN0aXZlIHJvYWRtYXApXCIsXG4gIH0pO1xuXG4gIGNvbnN0IHdvcmtmbG93UGF0aCA9IHByb2Nlc3MuZW52LkdTRF9XT1JLRkxPV19QQVRIID8/IGpvaW4oZ3NkSG9tZSgpLCBcImFnZW50XCIsIFwiR1NELVdPUktGTE9XLm1kXCIpO1xuICBjb25zdCB3b3JrZmxvdyA9IHJlYWRGaWxlU3luYyh3b3JrZmxvd1BhdGgsIFwidXRmLThcIik7XG4gIGNvbnN0IHNhdmVkVG9vbHMgPSBzY29wZUdzZFdvcmtmbG93VG9vbHNGb3JEaXNwYXRjaChwaSk7XG5cbiAgdHJ5IHtcbiAgICBwaS5zZW5kTWVzc2FnZShcbiAgICAgIHtcbiAgICAgICAgY3VzdG9tVHlwZTogXCJnc2QtdHJpYWdlXCIsXG4gICAgICAgIGNvbnRlbnQ6IGJ1aWxkV29ya2Zsb3dEaXNwYXRjaENvbnRlbnQoeyB3b3JrZmxvdywgd29ya2Zsb3dQYXRoLCB0YXNrOiBwcm9tcHQgfSksXG4gICAgICAgIGRpc3BsYXk6IGZhbHNlLFxuICAgICAgfSxcbiAgICAgIHsgdHJpZ2dlclR1cm46IHRydWUgfSxcbiAgICApO1xuICB9IGZpbmFsbHkge1xuICAgIHJlc3RvcmVHc2RXb3JrZmxvd1Rvb2xzKHBpLCBzYXZlZFRvb2xzKTtcbiAgfVxufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlU3RlZXIoY2hhbmdlOiBzdHJpbmcsIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsIHBpOiBFeHRlbnNpb25BUEkpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgYmFzZVBhdGggPSBjdXJyZW50RGlyZWN0b3J5Um9vdCgpO1xuICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2VQYXRoKTtcbiAgY29uc3QgbWlkID0gc3RhdGUuYWN0aXZlTWlsZXN0b25lPy5pZCA/PyBcIm5vbmVcIjtcbiAgY29uc3Qgc2lkID0gc3RhdGUuYWN0aXZlU2xpY2U/LmlkID8/IFwibm9uZVwiO1xuICBjb25zdCB0aWQgPSBzdGF0ZS5hY3RpdmVUYXNrPy5pZCA/PyBcIm5vbmVcIjtcbiAgY29uc3QgYXBwbGllZEF0ID0gYCR7bWlkfS8ke3NpZH0vJHt0aWR9YDtcblxuICAvLyBSZXNvbHZlIHRoZSBjb3JyZWN0IHRhcmdldCBwYXRoOiBvbmx5IHJvdXRlIHRvIGEgd29ya3RyZWUgd2hlbiBhdXRvLW1vZGVcbiAgLy8gaXMgYWN0aXZlbHkgcnVubmluZyB0aGVyZSAoaW4tcHJvY2VzcyBvciByZW1vdGUpLiBBIHdvcmt0cmVlIGRpcmVjdG9yeSBtYXlcbiAgLy8gZXhpc3QgZnJvbSBhIHByZXZpb3VzIHNlc3Npb24gd2l0aG91dCBiZWluZyB0aGUgYWN0aXZlIHJ1bnRpbWUgcGF0aCBcdTIwMTRcbiAgLy8gd3JpdGluZyB0aGVyZSB3aXRob3V0IGEgbGl2ZSBzZXNzaW9uIHdvdWxkIHNpbGVudGx5IGRyb3AgdGhlIG92ZXJyaWRlLlxuICBjb25zdCBhdXRvUnVubmluZyA9IGlzQXV0b0FjdGl2ZSgpIHx8IGNoZWNrUmVtb3RlQXV0b1Nlc3Npb24oYmFzZVBhdGgpLnJ1bm5pbmc7XG4gIGNvbnN0IHd0UGF0aCA9IGF1dG9SdW5uaW5nICYmIG1pZCAhPT0gXCJub25lXCJcbiAgICA/IGdldEF1dG9Xb3JrdHJlZVBhdGgoYmFzZVBhdGgsIG1pZClcbiAgICA6IG51bGw7XG4gIGNvbnN0IHRhcmdldFBhdGggPSB3dFBhdGggPz8gYmFzZVBhdGg7XG4gIGF3YWl0IGFwcGVuZE92ZXJyaWRlKHRhcmdldFBhdGgsIGNoYW5nZSwgYXBwbGllZEF0KTtcblxuICBjb25zdCBvdmVycmlkZUxvYyA9IHd0UGF0aCA/IFwid29ya3RyZWUgYC5nc2QvT1ZFUlJJREVTLm1kYFwiIDogXCJgLmdzZC9PVkVSUklERVMubWRgXCI7XG5cbiAgaWYgKGlzQXV0b0FjdGl2ZSgpKSB7XG4gICAgcGkuc2VuZE1lc3NhZ2Uoe1xuICAgICAgY3VzdG9tVHlwZTogXCJnc2QtaGFyZC1zdGVlclwiLFxuICAgICAgY29udGVudDogW1xuICAgICAgICBcIkhBUkQgU1RFRVIgXHUyMDE0IFVzZXIgb3ZlcnJpZGUgcmVnaXN0ZXJlZC5cIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgYCoqT3ZlcnJpZGU6KiogJHtjaGFuZ2V9YCxcbiAgICAgICAgXCJcIixcbiAgICAgICAgYFRoaXMgb3ZlcnJpZGUgaGFzIGJlZW4gc2F2ZWQgdG8gJHtvdmVycmlkZUxvY30gYW5kIHdpbGwgYmUgaW5qZWN0ZWQgaW50byBhbGwgZnV0dXJlIHRhc2sgcHJvbXB0cy5gLFxuICAgICAgICBcIkEgZG9jdW1lbnQgcmV3cml0ZSB1bml0IHdpbGwgcnVuIGJlZm9yZSB0aGUgbmV4dCB0YXNrIHRvIHByb3BhZ2F0ZSB0aGlzIGNoYW5nZSBhY3Jvc3MgYWxsIGFjdGl2ZSBwbGFuIGRvY3VtZW50cy5cIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCJJZiB5b3UgYXJlIG1pZC10YXNrLCBmaW5pc2ggeW91ciBjdXJyZW50IHdvcmsgcmVzcGVjdGluZyB0aGlzIG92ZXJyaWRlLiBUaGUgbmV4dCBkaXNwYXRjaGVkIHVuaXQgd2lsbCBiZSBhIGRvY3VtZW50IHJld3JpdGUuXCIsXG4gICAgICBdLmpvaW4oXCJcXG5cIiksXG4gICAgICBkaXNwbGF5OiBmYWxzZSxcbiAgICB9LCB7IHRyaWdnZXJUdXJuOiB0cnVlIH0pO1xuICAgIGN0eC51aS5ub3RpZnkoYE92ZXJyaWRlIHJlZ2lzdGVyZWQgKCR7b3ZlcnJpZGVMb2N9KTogXCIke2NoYW5nZX1cIi4gV2lsbCBiZSBhcHBsaWVkIGJlZm9yZSBuZXh0IHRhc2sgZGlzcGF0Y2guYCwgXCJpbmZvXCIpO1xuICB9IGVsc2Uge1xuICAgIHBpLnNlbmRNZXNzYWdlKHtcbiAgICAgIGN1c3RvbVR5cGU6IFwiZ3NkLWhhcmQtc3RlZXJcIixcbiAgICAgIGNvbnRlbnQ6IFtcbiAgICAgICAgXCJIQVJEIFNURUVSIFx1MjAxNCBVc2VyIG92ZXJyaWRlIHJlZ2lzdGVyZWQuXCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIGAqKk92ZXJyaWRlOioqICR7Y2hhbmdlfWAsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIGBUaGlzIG92ZXJyaWRlIGhhcyBiZWVuIHNhdmVkIHRvICR7b3ZlcnJpZGVMb2N9LmAsXG4gICAgICAgIGBCZWZvcmUgY29udGludWluZywgcmVhZCAke292ZXJyaWRlTG9jfSBhbmQgdXBkYXRlIHRoZSBjdXJyZW50IHBsYW4gZG9jdW1lbnRzIHRvIHJlZmxlY3QgdGhpcyBjaGFuZ2UuYCxcbiAgICAgICAgXCJGb2N1cyBvbjogYWN0aXZlIHNsaWNlIHBsYW4sIGluY29tcGxldGUgdGFzayBwbGFucywgYW5kIERFQ0lTSU9OUy5tZC5cIixcbiAgICAgIF0uam9pbihcIlxcblwiKSxcbiAgICAgIGRpc3BsYXk6IGZhbHNlLFxuICAgIH0sIHsgdHJpZ2dlclR1cm46IHRydWUgfSk7XG4gICAgY3R4LnVpLm5vdGlmeShgT3ZlcnJpZGUgcmVnaXN0ZXJlZCAoJHtvdmVycmlkZUxvY30pOiBcIiR7Y2hhbmdlfVwiLiBVcGRhdGUgcGxhbiBkb2N1bWVudHMgdG8gcmVmbGVjdCB0aGlzIGNoYW5nZS5gLCBcImluZm9cIik7XG4gIH1cbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZUtub3dsZWRnZShhcmdzOiBzdHJpbmcsIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgcGFydHMgPSBhcmdzLnNwbGl0KC9cXHMrLyk7XG4gIGNvbnN0IHR5cGVBcmcgPSBwYXJ0c1swXT8udG9Mb3dlckNhc2UoKTtcblxuICBpZiAoIXR5cGVBcmcgfHwgIVtcInJ1bGVcIiwgXCJwYXR0ZXJuXCIsIFwibGVzc29uXCJdLmluY2x1ZGVzKHR5cGVBcmcpKSB7XG4gICAgY3R4LnVpLm5vdGlmeShcbiAgICAgIFwiVXNhZ2U6IC9nc2Qga25vd2xlZGdlIDxydWxlfHBhdHRlcm58bGVzc29uPiA8ZGVzY3JpcHRpb24+XFxuRXhhbXBsZTogL2dzZCBrbm93bGVkZ2UgcnVsZSBVc2UgcmVhbCBEQiBmb3IgaW50ZWdyYXRpb24gdGVzdHNcIixcbiAgICAgIFwid2FybmluZ1wiLFxuICAgICk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgZW50cnlUZXh0ID0gcGFydHMuc2xpY2UoMSkuam9pbihcIiBcIikudHJpbSgpO1xuICBpZiAoIWVudHJ5VGV4dCkge1xuICAgIGN0eC51aS5ub3RpZnkoYFVzYWdlOiAvZ3NkIGtub3dsZWRnZSAke3R5cGVBcmd9IDxkZXNjcmlwdGlvbj5gLCBcIndhcm5pbmdcIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgdHlwZSA9IHR5cGVBcmcgYXMgXCJydWxlXCIgfCBcInBhdHRlcm5cIiB8IFwibGVzc29uXCI7XG4gIGNvbnN0IGJhc2VQYXRoID0gY3VycmVudERpcmVjdG9yeVJvb3QoKTtcbiAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlUGF0aCk7XG4gIGNvbnN0IHNjb3BlID0gc3RhdGUuYWN0aXZlTWlsZXN0b25lPy5pZFxuICAgID8gYCR7c3RhdGUuYWN0aXZlTWlsZXN0b25lLmlkfSR7c3RhdGUuYWN0aXZlU2xpY2UgPyBgLyR7c3RhdGUuYWN0aXZlU2xpY2UuaWR9YCA6IFwiXCJ9YFxuICAgIDogXCJnbG9iYWxcIjtcblxuICAvLyBBRFItMDEzIFN0YWdlIDJjOiBQYXR0ZXJucyBhbmQgTGVzc29ucyBsYW5kIGluIHRoZSBtZW1vcmllcyB0YWJsZTsgdGhlXG4gIC8vIG5leHQgc2Vzc2lvbi1zdGFydCBwcm9qZWN0aW9uIHJlbmRlciBlbWl0cyB0aGVtIGJhY2sgaW50byBLTk9XTEVER0UubWQuXG4gIC8vIFJ1bGVzIHN0YXkgZmlsZS1jYW5vbmljYWwgcGVyIEFEUi0wMTMgbGluZSAzOSBcdTIwMTQgUnVsZXMgYXJlIG5vdCBtaWdyYXRlZC5cbiAgaWYgKHR5cGUgPT09IFwicnVsZVwiKSB7XG4gICAgYXdhaXQgYXBwZW5kS25vd2xlZGdlKGJhc2VQYXRoLCB0eXBlLCBlbnRyeVRleHQsIHNjb3BlKTtcbiAgICBjdHgudWkubm90aWZ5KGBBZGRlZCBydWxlIHRvIEtOT1dMRURHRS5tZDogXCIke2VudHJ5VGV4dH1cImAsIFwic3VjY2Vzc1wiKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCB7IGNhcHR1cmVLbm93bGVkZ2VFbnRyeSB9ID0gYXdhaXQgaW1wb3J0KFwiLi9rbm93bGVkZ2UtY2FwdHVyZS5qc1wiKTtcbiAgY29uc3QgeyBpZCwgd3JpdHRlbiB9ID0gY2FwdHVyZUtub3dsZWRnZUVudHJ5KGJhc2VQYXRoLCB0eXBlLCBlbnRyeVRleHQsIHNjb3BlKTtcbiAgaWYgKCF3cml0dGVuKSB7XG4gICAgY3R4LnVpLm5vdGlmeShgQ291bGQgbm90IHBlcnNpc3QgJHt0eXBlfSBcdTIwMTQgc2VlIGxvZ3MgZm9yIGRldGFpbHMuYCwgXCJlcnJvclwiKTtcbiAgICByZXR1cm47XG4gIH1cbiAgY3R4LnVpLm5vdGlmeShcbiAgICBgQ2FwdHVyZWQgJHt0eXBlfSAke2lkfSB0byBtZW1vcmllczsgS05PV0xFREdFLm1kIHdpbGwgcmVuZGVyIGl0IG9uIG5leHQgc2Vzc2lvbiBzdGFydC5gLFxuICAgIFwic3VjY2Vzc1wiLFxuICApO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlUnVuSG9vayhhcmdzOiBzdHJpbmcsIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsIHBpOiBFeHRlbnNpb25BUEkpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgcGFydHMgPSBhcmdzLnRyaW0oKS5zcGxpdCgvXFxzKy8pO1xuICBpZiAocGFydHMubGVuZ3RoIDwgMykge1xuICAgIGN0eC51aS5ub3RpZnkoYFVzYWdlOiAvZ3NkIHJ1bi1ob29rIDxob29rLW5hbWU+IDx1bml0LXR5cGU+IDx1bml0LWlkPlxuXG5Vbml0IHR5cGVzOlxuICBleGVjdXRlLXRhc2sgICAtIFRhc2sgZXhlY3V0aW9uICh1bml0LWlkOiBNMDAxL1MwMS9UMDEpXG4gIHBsYW4tc2xpY2UgICAgIC0gU2xpY2UgcGxhbm5pbmcgKHVuaXQtaWQ6IE0wMDEvUzAxKVxuICByZXNlYXJjaC1taWxlc3RvbmUgLSBNaWxlc3RvbmUgcmVzZWFyY2ggKHVuaXQtaWQ6IE0wMDEpXG4gIGNvbXBsZXRlLXNsaWNlIC0gU2xpY2UgY29tcGxldGlvbiAodW5pdC1pZDogTTAwMS9TMDEpXG4gIGNvbXBsZXRlLW1pbGVzdG9uZSAtIE1pbGVzdG9uZSBjb21wbGV0aW9uICh1bml0LWlkOiBNMDAxKVxuXG5FeGFtcGxlczpcbiAgL2dzZCBydW4taG9vayBjb2RlLXJldmlldyBleGVjdXRlLXRhc2sgTTAwMS9TMDEvVDAxXG4gIC9nc2QgcnVuLWhvb2sgbGludC1jaGVjayBwbGFuLXNsaWNlIE0wMDEvUzAxYCwgXCJ3YXJuaW5nXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IFtob29rTmFtZSwgdW5pdFR5cGUsIHVuaXRJZF0gPSBwYXJ0cztcbiAgY29uc3QgYmFzZVBhdGggPSBjdXJyZW50RGlyZWN0b3J5Um9vdCgpO1xuXG4gIC8vIEltcG9ydCB0aGUgaG9vayB0cmlnZ2VyIGZ1bmN0aW9uXG4gIGNvbnN0IHsgdHJpZ2dlckhvb2tNYW51YWxseSwgZm9ybWF0SG9va1N0YXR1cywgZ2V0SG9va1N0YXR1cyB9ID0gYXdhaXQgaW1wb3J0KFwiLi9wb3N0LXVuaXQtaG9va3MuanNcIik7XG4gIGNvbnN0IHsgZGlzcGF0Y2hIb29rVW5pdCB9ID0gYXdhaXQgaW1wb3J0KFwiLi9hdXRvLmpzXCIpO1xuXG4gIC8vIENoZWNrIGlmIHRoZSBob29rIGV4aXN0c1xuICBjb25zdCBob29rcyA9IGdldEhvb2tTdGF0dXMoKTtcbiAgY29uc3QgaG9va0V4aXN0cyA9IGhvb2tzLnNvbWUoaCA9PiBoLm5hbWUgPT09IGhvb2tOYW1lKTtcbiAgaWYgKCFob29rRXhpc3RzKSB7XG4gICAgY3R4LnVpLm5vdGlmeShgSG9vayBcIiR7aG9va05hbWV9XCIgbm90IGZvdW5kLiBDb25maWd1cmVkIGhvb2tzOlxcbiR7Zm9ybWF0SG9va1N0YXR1cygpfWAsIFwiZXJyb3JcIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gVmFsaWRhdGUgdW5pdCBJRCBmb3JtYXRcbiAgY29uc3QgdW5pdElkUGF0dGVybiA9IC9eTVxcZHszfVxcL1NcXGR7MiwzfVxcL1RcXGR7MiwzfSQvO1xuICBpZiAoIXVuaXRJZFBhdHRlcm4udGVzdCh1bml0SWQpKSB7XG4gICAgY3R4LnVpLm5vdGlmeShgSW52YWxpZCB1bml0IElEIGZvcm1hdDogXCIke3VuaXRJZH1cIi4gRXhwZWN0ZWQgZm9ybWF0OiBNMDA0L1MwNC9UMDNgLCBcIndhcm5pbmdcIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gVHJpZ2dlciB0aGUgaG9vayBtYW51YWxseVxuICBjb25zdCBob29rVW5pdCA9IHRyaWdnZXJIb29rTWFudWFsbHkoaG9va05hbWUsIHVuaXRUeXBlLCB1bml0SWQsIGJhc2VQYXRoKTtcbiAgaWYgKCFob29rVW5pdCkge1xuICAgIGN0eC51aS5ub3RpZnkoYEZhaWxlZCB0byB0cmlnZ2VyIGhvb2sgXCIke2hvb2tOYW1lfVwiLiBUaGUgaG9vayBtYXkgYmUgZGlzYWJsZWQgb3Igbm90IGNvbmZpZ3VyZWQgZm9yIHVuaXQgdHlwZSBcIiR7dW5pdFR5cGV9XCIuYCwgXCJlcnJvclwiKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjdHgudWkubm90aWZ5KGBNYW51YWxseSB0cmlnZ2VyaW5nIGhvb2s6ICR7aG9va05hbWV9IGZvciAke3VuaXRUeXBlfSAke3VuaXRJZH1gLCBcImluZm9cIik7XG5cbiAgLy8gRGlzcGF0Y2ggdGhlIGhvb2sgdW5pdCBkaXJlY3RseSwgYnlwYXNzaW5nIG5vcm1hbCBwcmUtZGlzcGF0Y2ggaG9va3NcbiAgY29uc3Qgc3VjY2VzcyA9IGF3YWl0IGRpc3BhdGNoSG9va1VuaXQoXG4gICAgY3R4LFxuICAgIHBpLFxuICAgIGhvb2tOYW1lLFxuICAgIHVuaXRUeXBlLFxuICAgIHVuaXRJZCxcbiAgICBob29rVW5pdC5wcm9tcHQsXG4gICAgaG9va1VuaXQubW9kZWwsXG4gICAgYmFzZVBhdGgsXG4gICk7XG5cbiAgaWYgKCFzdWNjZXNzKSB7XG4gICAgY3R4LnVpLm5vdGlmeShcIkZhaWxlZCB0byBkaXNwYXRjaCBob29rLiBBdXRvLW1vZGUgbWF5IGhhdmUgYmVlbiBjYW5jZWxsZWQuXCIsIFwiZXJyb3JcIik7XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFNlbGYtdXBkYXRlIGhhbmRsZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIGNvbXBhcmVTZW12ZXJMb2NhbChhOiBzdHJpbmcsIGI6IHN0cmluZyk6IG51bWJlciB7XG4gIGNvbnN0IHBhID0gYS5zcGxpdCgnLicpLm1hcChOdW1iZXIpXG4gIGNvbnN0IHBiID0gYi5zcGxpdCgnLicpLm1hcChOdW1iZXIpXG4gIGZvciAobGV0IGkgPSAwOyBpIDwgTWF0aC5tYXgocGEubGVuZ3RoLCBwYi5sZW5ndGgpOyBpKyspIHtcbiAgICBjb25zdCB2YSA9IHBhW2ldIHx8IDBcbiAgICBjb25zdCB2YiA9IHBiW2ldIHx8IDBcbiAgICBpZiAodmEgPiB2YikgcmV0dXJuIDFcbiAgICBpZiAodmEgPCB2YikgcmV0dXJuIC0xXG4gIH1cbiAgcmV0dXJuIDBcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZVVwZGF0ZShjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHsgZXhlY1N5bmMgfSA9IGF3YWl0IGltcG9ydChcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiKTtcblxuICBjb25zdCBOUE1fUEFDS0FHRSA9IFwiZ3NkLXBpXCI7XG4gIGNvbnN0IGN1cnJlbnQgPSBwcm9jZXNzLmVudi5HU0RfVkVSU0lPTiB8fCBcIjAuMC4wXCI7XG5cbiAgY3R4LnVpLm5vdGlmeShgQ3VycmVudCB2ZXJzaW9uOiB2JHtjdXJyZW50fVxcbkNoZWNraW5nIG5wbSByZWdpc3RyeS4uLmAsIFwiaW5mb1wiKTtcblxuICBjb25zdCBsYXRlc3QgPSBhd2FpdCBmZXRjaExhdGVzdFZlcnNpb25Gb3JDb21tYW5kKCk7XG4gIGlmICghbGF0ZXN0KSB7XG4gICAgY3R4LnVpLm5vdGlmeShcIkZhaWxlZCB0byByZWFjaCBucG0gcmVnaXN0cnkuIENoZWNrIHlvdXIgbmV0d29yayBjb25uZWN0aW9uLlwiLCBcImVycm9yXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmIChjb21wYXJlU2VtdmVyTG9jYWwobGF0ZXN0LCBjdXJyZW50KSA8PSAwKSB7XG4gICAgY3R4LnVpLm5vdGlmeShgQWxyZWFkeSB1cCB0byBkYXRlICh2JHtjdXJyZW50fSkuYCwgXCJpbmZvXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGN0eC51aS5ub3RpZnkoYFVwZGF0aW5nOiB2JHtjdXJyZW50fSBcdTIxOTIgdiR7bGF0ZXN0fS4uLmAsIFwiaW5mb1wiKTtcblxuICBjb25zdCBpbnN0YWxsQ21kID0gcmVzb2x2ZUluc3RhbGxDb21tYW5kKGAke05QTV9QQUNLQUdFfUBsYXRlc3RgKTtcbiAgdHJ5IHtcbiAgICBleGVjU3luYyhpbnN0YWxsQ21kLCB7XG4gICAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcImlnbm9yZVwiXSxcbiAgICB9KTtcbiAgICBjdHgudWkubm90aWZ5KFxuICAgICAgYFVwZGF0ZWQgdG8gdiR7bGF0ZXN0fS4gUmVzdGFydCB5b3VyIEdTRCBzZXNzaW9uIHRvIHVzZSB0aGUgbmV3IHZlcnNpb24uYCxcbiAgICAgIFwiaW5mb1wiLFxuICAgICk7XG4gIH0gY2F0Y2gge1xuICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICBgVXBkYXRlIGZhaWxlZC4gVHJ5IG1hbnVhbGx5OiAke2luc3RhbGxDbWR9YCxcbiAgICAgIFwiZXJyb3JcIixcbiAgICApO1xuICB9XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFRQSxTQUFTLFlBQVksY0FBYyxpQkFBaUI7QUFDcEQsU0FBUyxNQUFNLFdBQVcsYUFBYSxXQUFXO0FBQ2xELFNBQVMsZUFBZTtBQUN4QixTQUFTLG1CQUFtQjtBQUM1QixTQUFTLGVBQWU7QUFDeEIsU0FBUyxlQUFlO0FBQ3hCLFNBQVMsZUFBZSxvQkFBb0IsMkJBQTJCO0FBQ3ZFLFNBQVMsZ0JBQWdCLHVCQUF1QjtBQUNoRDtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFDUCxTQUFTLGNBQWMsOEJBQThCO0FBQ3JELFNBQVMsMkJBQTJCO0FBQ3BDLFNBQVMsc0JBQXNCLG1CQUFtQjtBQUNsRCxTQUFTLGtCQUFrQjtBQUMzQjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFDUDtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUVQLE1BQU0sc0JBQXNCO0FBQzVCLE1BQU0sMEJBQTBCO0FBUWhDLFNBQVMsYUFBYSxRQUE0QixRQUFRLEtBQUssQ0FBQyxHQUFZO0FBQzFFLE1BQUksU0FBUyxRQUFRLFNBQVUsUUFBTztBQUN0QyxNQUFJLENBQUMsTUFBTyxRQUFPO0FBQ25CLFFBQU0sYUFBdUIsQ0FBQztBQUM5QixN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
