import { getActiveHook } from "./post-unit-hooks.js";
import { getLedger } from "./metrics.js";
import { getErrorMessage } from "./error-utils.js";
import { nativeIsRepo } from "./native-git-bridge.js";
import { isDbAvailable, getMilestoneSlices, getSliceTasks } from "./gsd-db.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { truncateToWidth, visibleWidth } from "@gsd/pi-tui";
import { makeUI } from "../shared/tui.js";
import { GLYPH, INDENT } from "../shared/mod.js";
import { padRightVisible, renderFrame, renderProgressBar, rightAlign, wrapVisibleText } from "./tui/render-kit.js";
import { computeProgressScore } from "./progress-score.js";
import {
  getGlobalGSDPreferencesPath,
  getProjectGSDPreferencesPath,
  parsePreferencesMarkdown
} from "./preferences.js";
import { parseUnitId } from "./unit-id.js";
import { logWarning } from "./workflow-logger.js";
import { formattedShortcutPair } from "./shortcut-defs.js";
import { readUnitRuntimeRecord } from "./unit-runtime.js";
function extractUatSliceId(unitId) {
  const { slice } = parseUnitId(unitId);
  if (slice?.startsWith("S")) return slice;
  return null;
}
function unitVerb(unitType) {
  if (unitType.startsWith("hook/")) return `hook: ${unitType.slice(5)}`;
  switch (unitType) {
    case "discuss-milestone":
    case "discuss-slice":
      return "discussing";
    case "research-milestone":
    case "research-slice":
      return "researching";
    case "plan-milestone":
    case "plan-slice":
      return "planning";
    case "refine-slice":
      return "refining";
    case "execute-task":
      return "executing";
    case "complete-slice":
      return "completing";
    case "replan-slice":
      return "replanning";
    case "rewrite-docs":
      return "rewriting";
    case "reassess-roadmap":
      return "reassessing";
    case "run-uat":
      return "running UAT";
    case "custom-step":
      return "executing workflow step";
    default:
      return unitType;
  }
}
function unitPhaseLabel(unitType) {
  if (unitType.startsWith("hook/")) return "HOOK";
  switch (unitType) {
    case "discuss-milestone":
    case "discuss-slice":
      return "DISCUSS";
    case "research-milestone":
      return "RESEARCH";
    case "research-slice":
      return "RESEARCH";
    case "plan-milestone":
      return "PLAN";
    case "plan-slice":
      return "PLAN";
    case "refine-slice":
      return "REFINE";
    case "execute-task":
      return "EXECUTE";
    case "complete-slice":
      return "COMPLETE";
    case "replan-slice":
      return "REPLAN";
    case "rewrite-docs":
      return "REWRITE";
    case "reassess-roadmap":
      return "REASSESS";
    case "run-uat":
      return "UAT";
    case "custom-step":
      return "WORKFLOW";
    default:
      return unitType.toUpperCase();
  }
}
function peekNext(unitType, state) {
  const activeHookState = getActiveHook();
  if (activeHookState) {
    return `hook: ${activeHookState.hookName} (cycle ${activeHookState.cycle})`;
  }
  const sid = state.activeSlice?.id ?? "";
  if (unitType.startsWith("hook/")) return `continue ${sid}`;
  switch (unitType) {
    case "discuss-milestone":
      return "research or plan milestone";
    case "discuss-slice":
      return "plan slice";
    case "research-milestone":
      return "plan milestone roadmap";
    case "plan-milestone":
      return "plan or execute first slice";
    case "research-slice":
      return `plan ${sid}`;
    case "plan-slice":
      return "execute first task";
    case "refine-slice":
      return "execute first task";
    case "execute-task":
      return `continue ${sid}`;
    case "complete-slice":
      return "reassess roadmap";
    case "replan-slice":
      return `re-execute ${sid}`;
    case "rewrite-docs":
      return "continue execution";
    case "reassess-roadmap":
      return "advance to next slice";
    case "run-uat":
      return "reassess roadmap";
    default:
      return "";
  }
}
function describeNextUnit(state) {
  const sid = state.activeSlice?.id;
  const sTitle = state.activeSlice?.title;
  const tid = state.activeTask?.id;
  const tTitle = state.activeTask?.title;
  switch (state.phase) {
    case "needs-discussion":
      return { label: "Discuss milestone draft", description: "Milestone has a draft context \u2014 needs discussion before planning." };
    case "pre-planning":
      return { label: "Research & plan milestone", description: "Scout the landscape and create the roadmap." };
    case "planning":
      return { label: `Plan ${sid}: ${sTitle}`, description: "Research and decompose into tasks." };
    case "executing":
      return { label: `Execute ${tid}: ${tTitle}`, description: "Run the next task in a fresh session." };
    case "summarizing":
      return { label: `Complete ${sid}: ${sTitle}`, description: "Write summary, UAT, and merge to main." };
    case "replanning-slice":
      return { label: `Replan ${sid}: ${sTitle}`, description: "Blocker found \u2014 replan the slice." };
    case "completing-milestone":
      return { label: "Complete milestone", description: "Write milestone summary." };
    case "evaluating-gates":
      return { label: `Evaluate gates for ${sid}: ${sTitle}`, description: "Parallel quality gate assessment before execution." };
    default:
      return { label: "Continue", description: "Execute the next step." };
  }
}
function formatAutoElapsed(autoStartTime) {
  if (!autoStartTime || autoStartTime <= 0 || !Number.isFinite(autoStartTime)) return "";
  const ms = Date.now() - autoStartTime;
  if (ms < 0 || ms > 30 * 24 * 36e5) return "";
  const s = Math.floor(ms / 1e3);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${rs > 0 ? ` ${rs}s` : ""}`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}
function formatWidgetTokens(count) {
  if (count < 1e3) return count.toString();
  if (count < 1e4) return `${(count / 1e3).toFixed(1)}k`;
  if (count < 1e6) return `${Math.round(count / 1e3)}k`;
  if (count < 1e7) return `${(count / 1e6).toFixed(1)}M`;
  return `${Math.round(count / 1e6)}M`;
}
function formatRuntimeHealthSignal(record, now = Date.now()) {
  if (!record) return null;
  const idleMs = Math.max(0, now - record.lastProgressAt);
  const idleMinutes = Math.floor(idleMs / 6e4);
  if ((record.recoveryAttempts ?? 0) > 0 || record.phase === "recovered" || record.lastProgressKind.includes("recovery")) {
    return {
      level: "yellow",
      summary: "Recovering",
      detail: `retry ${record.recoveryAttempts ?? 1} after ${record.lastRecoveryReason ?? "idle"} stall`
    };
  }
  if (record.progressCount === 0 && idleMs >= 6e4) {
    return {
      level: "yellow",
      summary: "Waiting on provider",
      detail: `no output for ${idleMinutes}m`
    };
  }
  return null;
}
function shouldRenderRoadmapProgress(progress) {
  return !!progress && progress.total > 0;
}
function estimateTimeRemaining() {
  const ledger = getLedger();
  if (!ledger || ledger.units.length < 2) return null;
  const sliceProgress = getRoadmapSlicesSync();
  if (!sliceProgress || sliceProgress.total === 0) return null;
  const remainingSlices = sliceProgress.total - sliceProgress.done;
  if (remainingSlices <= 0) return null;
  const completedSliceUnits = ledger.units.filter(
    (u) => u.finishedAt > 0 && u.startedAt > 0
  );
  if (completedSliceUnits.length < 2) return null;
  const totalDuration = completedSliceUnits.reduce(
    (sum, u) => sum + (u.finishedAt - u.startedAt),
    0
  );
  const avgDuration = totalDuration / completedSliceUnits.length;
  const completedSlices = sliceProgress.done || 1;
  const unitsPerSlice = completedSliceUnits.length / completedSlices;
  const estimatedMs = remainingSlices * unitsPerSlice * avgDuration;
  if (estimatedMs < 5e3) return null;
  const s = Math.floor(estimatedMs / 1e3);
  if (s < 60) return `~${s}s remaining`;
  const m = Math.floor(s / 60);
  if (m < 60) return `~${m}m remaining`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `~${h}h ${rm}m remaining` : `~${h}h remaining`;
}
let cachedSliceProgress = null;
function updateSliceProgressCache(base, mid, activeSid) {
  try {
    let normSlices;
    if (isDbAvailable()) {
      normSlices = getMilestoneSlices(mid).map((s) => ({ id: s.id, done: s.status === "complete", title: s.title }));
    } else {
      normSlices = [];
    }
    let activeSliceTasks = null;
    let taskDetails = null;
    if (activeSid) {
      try {
        if (isDbAvailable()) {
          const dbTasks = getSliceTasks(mid, activeSid);
          if (dbTasks.length > 0) {
            activeSliceTasks = {
              done: dbTasks.filter((t) => t.status === "complete" || t.status === "done").length,
              total: dbTasks.length
            };
            taskDetails = dbTasks.map((t) => ({ id: t.id, title: t.title, done: t.status === "complete" || t.status === "done" }));
          }
        }
      } catch (err) {
        logWarning("dashboard", `operation failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    cachedSliceProgress = {
      done: normSlices.filter((s) => s.done).length,
      total: normSlices.length,
      milestoneId: mid,
      activeSliceTasks,
      taskDetails
    };
  } catch (err) {
    logWarning("dashboard", `operation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
function getRoadmapSlicesSync() {
  return cachedSliceProgress;
}
function clearSliceProgressCache() {
  cachedSliceProgress = null;
}
let cachedLastCommit = null;
let lastCommitFetchedAt = 0;
function refreshLastCommit(basePath) {
  try {
    if (!nativeIsRepo(basePath)) {
      cachedLastCommit = null;
      return;
    }
    try {
      execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
        cwd: basePath,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 3e3
      });
    } catch {
      cachedLastCommit = null;
      return;
    }
    const raw = execFileSync("git", ["log", "-1", "--format=%cr|%s"], {
      cwd: basePath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 3e3
    }).trim();
    const sep = raw.indexOf("|");
    if (sep > 0) {
      cachedLastCommit = {
        timeAgo: raw.slice(0, sep).replace(/ ago$/, ""),
        message: raw.slice(sep + 1)
      };
    }
  } catch (err) {
    cachedLastCommit = null;
    logWarning("dashboard", `operation failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    lastCommitFetchedAt = Date.now();
  }
}
function getLastCommit(basePath) {
  if (Date.now() - lastCommitFetchedAt > 15e3) {
    refreshLastCommit(basePath);
  }
  return cachedLastCommit;
}
function _resetLastCommitCacheForTests() {
  cachedLastCommit = null;
  lastCommitFetchedAt = 0;
}
function _refreshLastCommitForTests(basePath) {
  refreshLastCommit(basePath);
}
function _getLastCommitForTests(basePath) {
  return getLastCommit(basePath);
}
function _getLastCommitFetchedAtForTests() {
  return lastCommitFetchedAt;
}
function sanitizeFooterStatus(text) {
  return text.replace(/\s+/g, " ").trim();
}
const hideFooter = (_tui, theme, footerData) => ({
  render(width) {
    const extensionStatuses = footerData.getExtensionStatuses();
    if (extensionStatuses.size === 0) return [];
    const statusLine = Array.from(extensionStatuses.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => sanitizeFooterStatus(text)).join(" ");
    return [truncateToWidth(theme.fg("dim", statusLine), width, theme.fg("dim", "..."))];
  },
  invalidate() {
  },
  dispose() {
  }
});
const WIDGET_MODES = ["full", "small", "min", "off"];
let widgetMode = "full";
let widgetModeInitialized = false;
let widgetModePreferencePath = null;
function safeReadTextFile(path) {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}
function readWidgetModeFromFile(path) {
  const raw = safeReadTextFile(path);
  if (!raw) return void 0;
  const prefs = parsePreferencesMarkdown(raw);
  const saved = prefs?.widget_mode;
  if (saved && WIDGET_MODES.includes(saved)) {
    return saved;
  }
  return void 0;
}
function resolveWidgetModePreferencePath(projectPath = getProjectGSDPreferencesPath(), globalPath = getGlobalGSDPreferencesPath()) {
  if (readWidgetModeFromFile(projectPath)) {
    return projectPath;
  }
  if (readWidgetModeFromFile(globalPath)) {
    return globalPath;
  }
  if (safeReadTextFile(projectPath) !== null) return projectPath;
  if (safeReadTextFile(globalPath) !== null) return globalPath;
  return getGlobalGSDPreferencesPath();
}
function ensureWidgetModeLoaded(projectPath, globalPath) {
  if (widgetModeInitialized) return;
  widgetModeInitialized = true;
  try {
    const resolvedProjectPath = projectPath ?? getProjectGSDPreferencesPath();
    const resolvedGlobalPath = globalPath ?? getGlobalGSDPreferencesPath();
    const saved = readWidgetModeFromFile(resolvedProjectPath) ?? readWidgetModeFromFile(resolvedGlobalPath);
    if (saved && WIDGET_MODES.includes(saved)) {
      widgetMode = saved;
    }
    widgetModePreferencePath = resolveWidgetModePreferencePath(resolvedProjectPath, resolvedGlobalPath);
  } catch (err) {
    logWarning("dashboard", `operation failed: ${getErrorMessage(err)}`);
    widgetModePreferencePath = getGlobalGSDPreferencesPath();
  }
}
function persistWidgetMode(mode, prefsPath = widgetModePreferencePath ?? resolveWidgetModePreferencePath()) {
  try {
    let content = "";
    if (existsSync(prefsPath)) {
      content = readFileSync(prefsPath, "utf-8");
    }
    const line = `widget_mode: ${mode}`;
    const re = /^widget_mode:\s*\S+/m;
    if (re.test(content)) {
      content = content.replace(re, line);
    } else {
      content = content.trimEnd() + "\n" + line + "\n";
    }
    writeFileSync(prefsPath, content, "utf-8");
  } catch (err) {
    logWarning("dashboard", `file write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
function cycleWidgetMode(projectPath, globalPath) {
  ensureWidgetModeLoaded(projectPath, globalPath);
  const idx = WIDGET_MODES.indexOf(widgetMode);
  widgetMode = WIDGET_MODES[(idx + 1) % WIDGET_MODES.length];
  persistWidgetMode(widgetMode, widgetModePreferencePath ?? resolveWidgetModePreferencePath(projectPath, globalPath));
  return widgetMode;
}
function setWidgetMode(mode, projectPath, globalPath) {
  ensureWidgetModeLoaded(projectPath, globalPath);
  widgetMode = mode;
  persistWidgetMode(widgetMode, widgetModePreferencePath ?? resolveWidgetModePreferencePath(projectPath, globalPath));
}
function getWidgetMode(projectPath, globalPath) {
  ensureWidgetModeLoaded(projectPath, globalPath);
  return widgetMode;
}
function _resetWidgetModeForTests() {
  widgetMode = "full";
  widgetModeInitialized = false;
  widgetModePreferencePath = null;
}
function updateProgressWidget(ctx, unitType, unitId, state, accessors, tierBadge) {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget("gsd-outcome", void 0);
  if (typeof ctx.ui?.setHeader === "function") {
    ctx.ui.setHeader(() => ({
      render() {
        return [];
      },
      invalidate() {
      }
    }));
  }
  if (typeof ctx.ui?.setStatus === "function") {
    ctx.ui.setStatus("gsd-step", void 0);
  }
  const verb = unitVerb(unitType);
  const phaseLabel = unitPhaseLabel(unitType);
  const mid = state.activeMilestone;
  const isHook = unitType.startsWith("hook/");
  const uatTargetSliceId = unitType === "run-uat" ? extractUatSliceId(unitId) : null;
  const slice = uatTargetSliceId ? { id: uatTargetSliceId, title: state.activeSlice?.title ?? "" } : state.activeSlice;
  const task = state.activeTask;
  if (mid) {
    updateSliceProgressCache(accessors.getBasePath(), mid.id, slice?.id);
  }
  ctx.ui.setWidget("gsd-progress", (tui, theme) => {
    let pulseBright = true;
    let cachedLines;
    let cachedWidth;
    let cachedRuntimeRecord = null;
    const refreshRuntimeRecord = () => {
      try {
        cachedRuntimeRecord = readUnitRuntimeRecord(accessors.getBasePath(), unitType, unitId);
      } catch {
        cachedRuntimeRecord = null;
      }
    };
    refreshRuntimeRecord();
    const pulseTimer = setInterval(() => {
      pulseBright = !pulseBright;
      cachedLines = void 0;
      tui.requestRender();
    }, 800);
    const progressRefreshTimer = setInterval(() => {
      try {
        if (mid) {
          updateSliceProgressCache(accessors.getBasePath(), mid.id, slice?.id);
        }
        refreshRuntimeRecord();
        cachedLines = void 0;
      } catch (err) {
        logWarning("dashboard", `DB status update failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, 15e3);
    return {
      render(width) {
        if (cachedLines && cachedWidth === width) return cachedLines;
        if (accessors.isSessionSwitching()) {
          return cachedLines ?? [];
        }
        const ui = makeUI(theme, width);
        const lines = [];
        const pad = INDENT.base;
        lines.push(...ui.bar());
        const dot = pulseBright ? theme.fg("accent", GLYPH.statusActive) : theme.fg("dim", GLYPH.statusPending);
        const elapsed = formatAutoElapsed(accessors.getAutoStartTime());
        const modeTag = accessors.isStepMode() ? "NEXT" : "AUTO";
        const score = computeProgressScore();
        const runtimeSignal = formatRuntimeHealthSignal(cachedRuntimeRecord);
        const healthLevel = runtimeSignal?.level ?? score.level;
        const healthSummary = runtimeSignal?.summary ?? score.summary;
        const healthColor = healthLevel === "green" ? "success" : healthLevel === "yellow" ? "warning" : "error";
        const healthIcon = healthLevel === "green" ? GLYPH.statusActive : healthLevel === "yellow" ? "!" : "x";
        const healthStr = `  ${theme.fg(healthColor, healthIcon)} ${theme.fg(healthColor, healthSummary)}`;
        const headerLeft = `${pad}${dot} ${theme.fg("accent", theme.bold("GSD"))}  ${theme.fg("success", modeTag)}${healthStr}`;
        const eta = estimateTimeRemaining();
        const etaShort = eta ? eta.replace(" remaining", " left") : null;
        const headerRight = elapsed ? etaShort ? `${theme.fg("dim", elapsed)} ${theme.fg("dim", "\xB7")} ${theme.fg("dim", etaShort)}` : theme.fg("dim", elapsed) : "";
        lines.push(rightAlign(headerLeft, headerRight, width));
        if (runtimeSignal?.detail && widgetMode !== "min") {
          lines.push(`${pad}  ${theme.fg("dim", runtimeSignal.detail)}`);
        } else if (score.level !== "green" && score.signals.length > 0 && widgetMode !== "min") {
          const topSignals = score.signals.filter((s) => s.kind === "negative").slice(0, 3);
          if (topSignals.length > 0) {
            const signalStr = topSignals.map((s) => theme.fg("dim", s.label)).join(theme.fg("dim", " \xB7 "));
            lines.push(`${pad}  ${signalStr}`);
          }
        }
        if (widgetMode === "off") {
          cachedLines = [];
          cachedWidth = width;
          return [];
        }
        if (widgetMode === "min") {
          lines.push(...ui.bar());
          cachedLines = lines;
          cachedWidth = width;
          return lines;
        }
        if (widgetMode === "small") {
          lines.push("");
          const target2 = task ? `${task.id}: ${task.title}` : unitId;
          const actionLeft2 = `${pad}${theme.fg("accent", "\u25B8")} ${theme.fg("accent", verb)}  ${theme.fg("text", target2)}`;
          lines.push(rightAlign(actionLeft2, theme.fg("dim", phaseLabel), width));
          const roadmapSlices2 = mid ? getRoadmapSlicesSync() : null;
          if (shouldRenderRoadmapProgress(roadmapSlices2)) {
            const { done, total, activeSliceTasks } = roadmapSlices2;
            const barWidth = Math.max(6, Math.min(18, Math.floor(width * 0.25)));
            const bar = renderProgressBar(theme, done, total, barWidth);
            let meta = `${theme.fg("text", `${done}`)}${theme.fg("dim", `/${total} slices`)}`;
            if (activeSliceTasks && activeSliceTasks.total > 0) {
              const tn = Math.min(activeSliceTasks.done + 1, activeSliceTasks.total);
              meta += `${theme.fg("dim", " \xB7 task ")}${theme.fg("accent", `${tn}`)}${theme.fg("dim", `/${activeSliceTasks.total}`)}`;
            }
            lines.push(`${pad}${bar} ${meta}`);
          }
          lines.push(...ui.bar());
          cachedLines = lines;
          cachedWidth = width;
          return lines;
        }
        lines.push("");
        const hasContext = !!(mid || slice && unitType !== "research-milestone" && unitType !== "plan-milestone");
        if (mid) {
          lines.push(truncateToWidth(`${pad}${theme.fg("dim", mid.title)}`, width, "\u2026"));
        }
        if (slice && unitType !== "research-milestone" && unitType !== "plan-milestone") {
          lines.push(truncateToWidth(
            `${pad}${theme.fg("text", theme.bold(`${slice.id}: ${slice.title}`))}`,
            width,
            "\u2026"
          ));
        }
        if (hasContext) lines.push("");
        const target = task ? `${task.id}: ${task.title}` : unitId;
        const actionLeft = `${pad}${theme.fg("accent", "\u25B8")} ${theme.fg("accent", verb)}  ${theme.fg("text", target)}`;
        const tierTag = tierBadge ? theme.fg("dim", `[${tierBadge}] `) : "";
        const phaseBadge = `${tierTag}${theme.fg("dim", phaseLabel)}`;
        lines.push(rightAlign(actionLeft, phaseBadge, width));
        lines.push("");
        const minTwoColWidth = 76;
        const roadmapSlices = mid ? getRoadmapSlicesSync() : null;
        const taskDetailsCol = roadmapSlices?.taskDetails ?? null;
        const useTwoCol = width >= minTwoColWidth && taskDetailsCol !== null && taskDetailsCol.length > 0;
        const leftColWidth = useTwoCol ? Math.floor(width * (width >= 100 ? 0.45 : 0.5)) : width;
        const leftLines = [];
        if (shouldRenderRoadmapProgress(roadmapSlices)) {
          const { done, total, activeSliceTasks } = roadmapSlices;
          const barWidth = Math.max(6, Math.min(18, Math.floor(leftColWidth * 0.4)));
          const bar = renderProgressBar(theme, done, total, barWidth);
          let meta = `${theme.fg("text", `${done}`)}${theme.fg("dim", `/${total} slices`)}`;
          if (activeSliceTasks && activeSliceTasks.total > 0) {
            const taskNum = isHook ? Math.max(activeSliceTasks.done, 1) : Math.min(activeSliceTasks.done + 1, activeSliceTasks.total);
            meta += `${theme.fg("dim", " \xB7 task ")}${theme.fg("accent", `${taskNum}`)}${theme.fg("dim", `/${activeSliceTasks.total}`)}`;
          }
          leftLines.push(`${pad}${bar} ${meta}`);
        }
        const rightLines = [];
        const maxVisibleTasks = 8;
        const maxTaskTitleLen = 45;
        function truncTitle(s) {
          return s.length > maxTaskTitleLen ? s.slice(0, maxTaskTitleLen - 1) + "\u2026" : s;
        }
        function formatTaskLine(t, isCurrent) {
          const glyph = t.done ? theme.fg("success", "*") : isCurrent ? theme.fg("accent", ">") : theme.fg("dim", ".");
          const id = isCurrent ? theme.fg("accent", t.id) : t.done ? theme.fg("muted", t.id) : theme.fg("dim", t.id);
          const short = truncTitle(t.title);
          const title = isCurrent ? theme.fg("text", short) : t.done ? theme.fg("muted", short) : theme.fg("text", short);
          return `${glyph} ${id}: ${title}`;
        }
        if (useTwoCol && taskDetailsCol) {
          for (const t of taskDetailsCol.slice(0, maxVisibleTasks)) {
            rightLines.push(formatTaskLine(t, !!(task && t.id === task.id)));
          }
          if (taskDetailsCol.length > maxVisibleTasks) {
            rightLines.push(theme.fg("dim", `  +${taskDetailsCol.length - maxVisibleTasks} more`));
          }
        } else if (!useTwoCol && taskDetailsCol && taskDetailsCol.length > 0) {
          for (const t of taskDetailsCol.slice(0, maxVisibleTasks)) {
            leftLines.push(`${pad}${formatTaskLine(t, !!(task && t.id === task.id))}`);
          }
        }
        if (useTwoCol) {
          const maxRows = Math.max(leftLines.length, rightLines.length);
          if (maxRows > 0) {
            lines.push("");
            for (let i = 0; i < maxRows; i++) {
              const left = padRightVisible(truncateToWidth(leftLines[i] ?? "", leftColWidth, "\u2026"), leftColWidth);
              const right = rightLines[i] ?? "";
              lines.push(`${left}${right}`);
            }
          }
        } else {
          if (leftLines.length > 0) {
            lines.push("");
            for (const l of leftLines) lines.push(truncateToWidth(l, width, "\u2026"));
          }
        }
        lines.push("");
        if (accessors.isStepMode()) {
          lines.push(`${pad}${theme.fg("accent", "\u2192")} ${theme.fg("dim", "Ctrl+N to advance to next step  \xB7  /gsd status for overview")}`);
        }
        const hintParts = [];
        hintParts.push("esc pause");
        hintParts.push(`${formattedShortcutPair("dashboard")} dashboard`);
        hintParts.push(`${formattedShortcutPair("parallel")} parallel`);
        const hintStr = theme.fg("dim", hintParts.join(" | "));
        lines.push(rightAlign("", hintStr, width));
        lines.push(...ui.bar());
        cachedLines = lines;
        cachedWidth = width;
        return lines;
      },
      invalidate() {
        cachedLines = void 0;
        cachedWidth = void 0;
      },
      dispose() {
        clearInterval(pulseTimer);
        if (progressRefreshTimer) clearInterval(progressRefreshTimer);
      }
    };
  });
}
function setCompletionProgressWidget(ctx, snapshot) {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget("gsd-outcome", void 0);
  if (typeof ctx.ui?.setHeader === "function") {
    ctx.ui.setHeader(() => ({
      render() {
        return [];
      },
      invalidate() {
      }
    }));
  }
  if (typeof ctx.ui?.setStatus === "function") {
    ctx.ui.setStatus("gsd-step", void 0);
  }
  ctx.ui.setWidget("gsd-progress", (_tui, theme) => ({
    render(width) {
      const ui = makeUI(theme, width);
      const pad = INDENT.base;
      const lines = [];
      const contentWidth = Math.max(20, width - visibleWidth(pad));
      const add = (line = "") => {
        lines.push(line ? truncateToWidth(`${pad}${line}`, width, "\u2026") : "");
      };
      const addSection = (label, value, indent = "") => {
        const clean = normalizeRollupText(value);
        if (!clean) return;
        add(`${indent}${theme.fg("accent", label)} ${theme.fg("text", truncateToWidth(clean, contentWidth - indent.length - label.length - 1, "\u2026"))}`);
      };
      const addList = (label, values, limit, indent = "") => {
        const clean = (values ?? []).map(normalizeRollupText).filter((v) => !!v);
        if (clean.length === 0) return;
        const shown = clean.slice(0, limit);
        const more = clean.length > shown.length ? ` (+${clean.length - shown.length} more)` : "";
        add(`${indent}${theme.fg("accent", label)} ${theme.fg("text", truncateToWidth(shown.join("; ") + more, contentWidth - indent.length - label.length - 1, "\u2026"))}`);
      };
      lines.push(...ui.bar());
      const elapsed = formatAutoElapsed(snapshot.startedAt);
      const heading = snapshot.allMilestonesComplete ? "All milestones complete" : snapshot.milestoneId ? `Milestone ${snapshot.milestoneId} roll-up` : "Milestone roll-up";
      lines.push(rightAlign(`${pad}${theme.fg("accent", theme.bold(heading))}`, elapsed ? theme.fg("dim", elapsed) : "", width));
      if (snapshot.milestoneTitle) {
        add(theme.fg("text", snapshot.milestoneTitle));
      }
      lines.push("");
      add(theme.fg("accent", "Outcome"));
      addSection("", snapshot.oneLiner, "  ");
      const changed = [
        ...snapshot.successCriteriaResults ? [snapshot.successCriteriaResults] : [],
        ...snapshot.requirementOutcomes ? [snapshot.requirementOutcomes] : [],
        ...snapshot.keyDecisions ?? []
      ].map(normalizeRollupText).filter((v) => !!v).slice(0, 4);
      if (changed.length > 0) {
        lines.push("");
        add(theme.fg("accent", "What changed"));
        for (const item of changed) add(`  - ${theme.fg("text", item)}`);
      }
      const verification = [
        snapshot.definitionOfDoneResults,
        snapshot.deviations ? `Deviations: ${snapshot.deviations}` : null,
        snapshot.followUps ? `Follow-ups: ${snapshot.followUps}` : null
      ].map(normalizeRollupText).filter((v) => !!v);
      if (verification.length > 0 || (snapshot.keyFiles?.length ?? 0) > 0) {
        lines.push("");
        add(theme.fg("accent", "Verification"));
        for (const item of verification.slice(0, 3)) add(`  - ${theme.fg("text", item)}`);
        addList("Files:", snapshot.keyFiles, 4, "  ");
      }
      if ((snapshot.lessonsLearned?.length ?? 0) > 0) {
        lines.push("");
        addList("Lessons:", snapshot.lessonsLearned, 2);
      }
      const hasSliceTotals = typeof snapshot.completedSlices === "number" && typeof snapshot.totalSlices === "number" && snapshot.totalSlices > 0;
      lines.push("");
      const stats = [];
      if (hasSliceTotals) stats.push(theme.fg("success", `${snapshot.completedSlices}/${snapshot.totalSlices} slices`));
      if (snapshot.unitCount > 0) stats.push(theme.fg("dim", `${snapshot.unitCount} units`));
      if (snapshot.totalTokens > 0) stats.push(theme.fg("dim", `${formatWidgetTokens(snapshot.totalTokens)} tokens`));
      if (snapshot.totalCost > 0) stats.push(theme.fg("warning", `$${snapshot.totalCost.toFixed(2)}`));
      if (typeof snapshot.cacheHitRate === "number") {
        const hitColor = snapshot.cacheHitRate >= 70 ? "success" : snapshot.cacheHitRate >= 40 ? "warning" : "error";
        stats.push(theme.fg(hitColor, `${Math.round(snapshot.cacheHitRate)}% cache hit`));
      }
      if (stats.length > 0) {
        add(`${theme.fg("accent", "Run totals")} ${stats.join(theme.fg("dim", " \xB7 "))}`);
      }
      lines.push("");
      const nextAction = snapshot.allMilestonesComplete ? "Review the roll-up, then start a new milestone when ready." : "Review the roll-up, inspect status, or continue to the next milestone.";
      const commands = snapshot.allMilestonesComplete ? ["/gsd status for overview", "/gsd visualize to inspect", "/gsd notifications for history", "/gsd start for new work"] : ["/gsd status for overview", "/gsd visualize to inspect", "/gsd notifications for history", "/gsd auto for next milestone"];
      add(`${theme.fg("success", "Next")} ${theme.fg("text", nextAction)}`);
      add(theme.fg("dim", commands.join("  \xB7  ")));
      const location = snapshot.basePath ? theme.fg("dim", snapshot.basePath) : "";
      const reason = theme.fg("dim", snapshot.reason);
      lines.push(rightAlign(`${pad}${truncateToWidth(location, Math.max(0, width - 32), "\u2026")}`, reason, width));
      lines.push(...ui.bar());
      return lines;
    },
    invalidate() {
    },
    dispose() {
    }
  }));
}
function setAutoOutcomeWidget(ctx, snapshot) {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget("gsd-outcome", (_tui, theme) => ({
    render(width) {
      const color = snapshot.status === "failed" || snapshot.status === "blocked" ? "warning" : snapshot.status === "complete" ? "success" : "borderAccent";
      const icon = snapshot.status === "complete" ? "\u2713" : snapshot.status === "failed" ? "x" : snapshot.status === "blocked" ? "!" : snapshot.status === "paused" ? "||" : "\u25CF";
      const innerWidth = Math.max(8, width - 4);
      const maxLines = 7;
      const lines = [];
      const elapsed = snapshot.startedAt ? formatAutoElapsed(snapshot.startedAt) : "";
      const heading = `${theme.fg(color, icon)} ${theme.fg("accent", theme.bold("GSD"))} ${theme.fg("text", snapshot.title)}`;
      lines.push(rightAlign(heading, elapsed ? theme.fg("dim", elapsed) : "", innerWidth));
      const commands = snapshot.commands?.filter(Boolean) ?? [];
      const commandLine = commands.length > 0 ? theme.fg("dim", commands.join("  \xB7  ")) : null;
      const addWrapped = (text, prefix = "") => {
        const reserve = commandLine ? 1 : 0;
        const remaining = Math.max(0, maxLines - reserve - lines.length);
        if (remaining === 0) return;
        const available = Math.max(8, innerWidth - visibleWidth(prefix));
        for (const [idx, line] of wrapVisibleText(text, available).slice(0, remaining).entries()) {
          lines.push(`${idx === 0 ? prefix : " ".repeat(visibleWidth(prefix))}${line}`);
        }
      };
      if (snapshot.detail) {
        addWrapped(snapshot.detail, `${theme.fg("dim", "Reason")} `);
      }
      if (snapshot.unitLabel) {
        addWrapped(snapshot.unitLabel, `${theme.fg("dim", "Last")}   `);
      }
      addWrapped(snapshot.nextAction, `${theme.fg("success", "Next")}   `);
      if (commandLine && lines.length < maxLines) {
        lines.push(commandLine);
      }
      return renderFrame(theme, lines, width, { borderColor: color, paddingX: 1 });
    },
    invalidate() {
    },
    dispose() {
    }
  }));
}
function normalizeRollupText(value) {
  const clean = value?.replace(/\s+/g, " ").replace(/^[-*]\s+/, "").trim();
  if (!clean || clean === "(none)" || clean === "None." || clean === "Not provided.") return null;
  return clean;
}
export {
  _getLastCommitFetchedAtForTests,
  _getLastCommitForTests,
  _refreshLastCommitForTests,
  _resetLastCommitCacheForTests,
  _resetWidgetModeForTests,
  clearSliceProgressCache,
  cycleWidgetMode,
  describeNextUnit,
  estimateTimeRemaining,
  extractUatSliceId,
  formatAutoElapsed,
  formatRuntimeHealthSignal,
  formatWidgetTokens,
  getRoadmapSlicesSync,
  getWidgetMode,
  hideFooter,
  setAutoOutcomeWidget,
  setCompletionProgressWidget,
  setWidgetMode,
  shouldRenderRoadmapProgress,
  unitPhaseLabel,
  unitVerb,
  updateProgressWidget,
  updateSliceProgressCache
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9hdXRvLWRhc2hib2FyZC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NELTIgKyBzcmMvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL2F1dG8tZGFzaGJvYXJkLnRzIC0gQXV0by1tb2RlIHByb2dyZXNzIHdpZGdldCByZW5kZXJpbmcgYW5kIGRhc2hib2FyZCBoZWxwZXJzLlxuXG4vKipcbiAqIEF1dG8tbW9kZSBEYXNoYm9hcmQgXHUyMDE0IHByb2dyZXNzIHdpZGdldCByZW5kZXJpbmcsIGVsYXBzZWQgdGltZSBmb3JtYXR0aW5nLFxuICogdW5pdCBkZXNjcmlwdGlvbiBoZWxwZXJzLCBhbmQgc2xpY2UgcHJvZ3Jlc3MgY2FjaGluZy5cbiAqXG4gKiBQdXJlIGZ1bmN0aW9ucyB0aGF0IGFjY2VwdCBzcGVjaWZpYyBwYXJhbWV0ZXJzIFx1MjAxNCBubyBtb2R1bGUtbGV2ZWwgZ2xvYmFsc1xuICogb3IgQXV0b0NvbnRleHQgZGVwZW5kZW5jeS4gU3RhdGUgYWNjZXNzb3JzIGFyZSBwYXNzZWQgYXMgY2FsbGJhY2tzLlxuICovXG5cbmltcG9ydCB0eXBlIHtcbiAgRXh0ZW5zaW9uQ29udGV4dCxcbiAgRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsXG4gIFJlYWRvbmx5Rm9vdGVyRGF0YVByb3ZpZGVyLFxuICBUaGVtZSxcbn0gZnJvbSBcIkBnc2QvcGktY29kaW5nLWFnZW50XCI7XG5pbXBvcnQgdHlwZSB7IEdTRFN0YXRlIH0gZnJvbSBcIi4vdHlwZXMuanNcIjtcbmltcG9ydCB7IGdldEFjdGl2ZUhvb2sgfSBmcm9tIFwiLi9wb3N0LXVuaXQtaG9va3MuanNcIjtcbmltcG9ydCB7IGdldExlZGdlciB9IGZyb20gXCIuL21ldHJpY3MuanNcIjtcbmltcG9ydCB7IGdldEVycm9yTWVzc2FnZSB9IGZyb20gXCIuL2Vycm9yLXV0aWxzLmpzXCI7XG5pbXBvcnQgeyBuYXRpdmVJc1JlcG8gfSBmcm9tIFwiLi9uYXRpdmUtZ2l0LWJyaWRnZS5qc1wiO1xuaW1wb3J0IHtcbiAgcmVzb2x2ZU1pbGVzdG9uZUZpbGUsXG4gIHJlc29sdmVTbGljZUZpbGUsXG59IGZyb20gXCIuL3BhdGhzLmpzXCI7XG5pbXBvcnQgeyBpc0RiQXZhaWxhYmxlLCBnZXRNaWxlc3RvbmVTbGljZXMsIGdldFNsaWNlVGFza3MgfSBmcm9tIFwiLi9nc2QtZGIuanNcIjtcbmltcG9ydCB7IHJlYWRGaWxlU3luYywgd3JpdGVGaWxlU3luYywgZXhpc3RzU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBleGVjRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgeyB0cnVuY2F0ZVRvV2lkdGgsIHZpc2libGVXaWR0aCB9IGZyb20gXCJAZ3NkL3BpLXR1aVwiO1xuaW1wb3J0IHsgbWFrZVVJIH0gZnJvbSBcIi4uL3NoYXJlZC90dWkuanNcIjtcbmltcG9ydCB7IEdMWVBILCBJTkRFTlQgfSBmcm9tIFwiLi4vc2hhcmVkL21vZC5qc1wiO1xuaW1wb3J0IHsgcGFkUmlnaHRWaXNpYmxlLCByZW5kZXJGcmFtZSwgcmVuZGVyUHJvZ3Jlc3NCYXIsIHJpZ2h0QWxpZ24sIHdyYXBWaXNpYmxlVGV4dCB9IGZyb20gXCIuL3R1aS9yZW5kZXIta2l0LmpzXCI7XG5pbXBvcnQgeyBjb21wdXRlUHJvZ3Jlc3NTY29yZSB9IGZyb20gXCIuL3Byb2dyZXNzLXNjb3JlLmpzXCI7XG5pbXBvcnQge1xuICBnZXRHbG9iYWxHU0RQcmVmZXJlbmNlc1BhdGgsXG4gIGdldFByb2plY3RHU0RQcmVmZXJlbmNlc1BhdGgsXG4gIHBhcnNlUHJlZmVyZW5jZXNNYXJrZG93bixcbn0gZnJvbSBcIi4vcHJlZmVyZW5jZXMuanNcIjtcbmltcG9ydCB7IHBhcnNlVW5pdElkIH0gZnJvbSBcIi4vdW5pdC1pZC5qc1wiO1xuaW1wb3J0IHtcbiAgdHlwZSBSdGtTZXNzaW9uU2F2aW5ncyxcbn0gZnJvbSBcIi4uL3NoYXJlZC9ydGstc2Vzc2lvbi1zdGF0cy5qc1wiO1xuaW1wb3J0IHsgbG9nV2FybmluZyB9IGZyb20gXCIuL3dvcmtmbG93LWxvZ2dlci5qc1wiO1xuaW1wb3J0IHsgZm9ybWF0dGVkU2hvcnRjdXRQYWlyIH0gZnJvbSBcIi4vc2hvcnRjdXQtZGVmcy5qc1wiO1xuaW1wb3J0IHsgcmVhZFVuaXRSdW50aW1lUmVjb3JkLCB0eXBlIEF1dG9Vbml0UnVudGltZVJlY29yZCB9IGZyb20gXCIuL3VuaXQtcnVudGltZS5qc1wiO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVUFUIFNsaWNlIEV4dHJhY3Rpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogRXh0cmFjdCB0aGUgdGFyZ2V0IHNsaWNlIElEIGZyb20gYSBydW4tdWF0IHVuaXQgSUQgKGUuZy4gXCJNMDAxL1MwMVwiIFx1MjE5MiBcIlMwMVwiKS5cbiAqIFJldHVybnMgbnVsbCBpZiB0aGUgZm9ybWF0IGRvZXNuJ3QgbWF0Y2guXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBleHRyYWN0VWF0U2xpY2VJZCh1bml0SWQ6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCB7IHNsaWNlIH0gPSBwYXJzZVVuaXRJZCh1bml0SWQpO1xuICBpZiAoc2xpY2U/LnN0YXJ0c1dpdGgoXCJTXCIpKSByZXR1cm4gc2xpY2U7XG4gIHJldHVybiBudWxsO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRGFzaGJvYXJkIERhdGEgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKiBEYXNoYm9hcmQgZGF0YSBmb3IgdGhlIG92ZXJsYXkgKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXV0b0Rhc2hib2FyZERhdGEge1xuICBhY3RpdmU6IGJvb2xlYW47XG4gIHBhdXNlZDogYm9vbGVhbjtcbiAgc3RlcE1vZGU6IGJvb2xlYW47XG4gIHN0YXJ0VGltZTogbnVtYmVyO1xuICBlbGFwc2VkOiBudW1iZXI7XG4gIGN1cnJlbnRVbml0OiB7IHR5cGU6IHN0cmluZzsgaWQ6IHN0cmluZzsgc3RhcnRlZEF0OiBudW1iZXIgfSB8IG51bGw7XG4gIGJhc2VQYXRoOiBzdHJpbmc7XG4gIC8qKiBSdW5uaW5nIGNvc3QgYW5kIHRva2VuIHRvdGFscyBmcm9tIG1ldHJpY3MgbGVkZ2VyICovXG4gIHRvdGFsQ29zdDogbnVtYmVyO1xuICB0b3RhbFRva2VuczogbnVtYmVyO1xuICAvKiogUHJvamVjdGVkIHJlbWFpbmluZyBjb3N0IGJhc2VkIG9uIHVuaXQtdHlwZSBhdmVyYWdlcyAodW5kZWZpbmVkIGlmIGluc3VmZmljaWVudCBkYXRhKSAqL1xuICBwcm9qZWN0ZWRSZW1haW5pbmdDb3N0PzogbnVtYmVyO1xuICAvKiogV2hldGhlciB0b2tlbiBwcm9maWxlIGhhcyBiZWVuIGF1dG8tZG93bmdyYWRlZCBkdWUgdG8gYnVkZ2V0IHByZWRpY3Rpb24gKi9cbiAgcHJvZmlsZURvd25ncmFkZWQ/OiBib29sZWFuO1xuICAvKiogTnVtYmVyIG9mIHBlbmRpbmcgY2FwdHVyZXMgYXdhaXRpbmcgdHJpYWdlICgwIGlmIG5vbmUgb3IgZmlsZSBtaXNzaW5nKSAqL1xuICBwZW5kaW5nQ2FwdHVyZUNvdW50OiBudW1iZXI7XG4gIC8qKiBSVEsgdG9rZW4gc2F2aW5ncyBmb3IgdGhlIGN1cnJlbnQgc2Vzc2lvbiwgb3IgbnVsbCB3aGVuIHVuYXZhaWxhYmxlLiAqL1xuICBydGtTYXZpbmdzPzogUnRrU2Vzc2lvblNhdmluZ3MgfCBudWxsO1xuICAvKiogV2hldGhlciBSVEsgaXMgZW5hYmxlZCB2aWEgZXhwZXJpbWVudGFsLnJ0ayBwcmVmZXJlbmNlLiBGYWxzZSB3aGVuIG5vdCBvcHRlZCBpbi4gKi9cbiAgcnRrRW5hYmxlZD86IGJvb2xlYW47XG4gIC8qKiBDcm9zcy1wcm9jZXNzOiBhbm90aGVyIGF1dG8tbW9kZSBzZXNzaW9uIGRldGVjdGVkIHZpYSBhdXRvLmxvY2sgKFBJRCwgc3RhcnRlZEF0KSAqL1xuICByZW1vdGVTZXNzaW9uPzogeyBwaWQ6IG51bWJlcjsgc3RhcnRlZEF0OiBzdHJpbmc7IHVuaXRUeXBlOiBzdHJpbmc7IHVuaXRJZDogc3RyaW5nIH07XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ29tcGxldGlvbkRhc2hib2FyZFNuYXBzaG90IHtcbiAgbWlsZXN0b25lSWQ/OiBzdHJpbmcgfCBudWxsO1xuICBtaWxlc3RvbmVUaXRsZT86IHN0cmluZyB8IG51bGw7XG4gIG9uZUxpbmVyPzogc3RyaW5nIHwgbnVsbDtcbiAgc3VjY2Vzc0NyaXRlcmlhUmVzdWx0cz86IHN0cmluZyB8IG51bGw7XG4gIGRlZmluaXRpb25PZkRvbmVSZXN1bHRzPzogc3RyaW5nIHwgbnVsbDtcbiAgcmVxdWlyZW1lbnRPdXRjb21lcz86IHN0cmluZyB8IG51bGw7XG4gIGRldmlhdGlvbnM/OiBzdHJpbmcgfCBudWxsO1xuICBmb2xsb3dVcHM/OiBzdHJpbmcgfCBudWxsO1xuICBrZXlEZWNpc2lvbnM/OiBzdHJpbmdbXTtcbiAga2V5RmlsZXM/OiBzdHJpbmdbXTtcbiAgbGVzc29uc0xlYXJuZWQ/OiBzdHJpbmdbXTtcbiAgcmVhc29uOiBzdHJpbmc7XG4gIHN0YXJ0ZWRBdDogbnVtYmVyO1xuICB0b3RhbENvc3Q6IG51bWJlcjtcbiAgdG90YWxUb2tlbnM6IG51bWJlcjtcbiAgdW5pdENvdW50OiBudW1iZXI7XG4gIGNhY2hlSGl0UmF0ZT86IG51bWJlciB8IG51bGw7XG4gIGNvbnRleHRQZXJjZW50PzogbnVtYmVyIHwgbnVsbDtcbiAgY29udGV4dFdpbmRvdz86IG51bWJlciB8IG51bGw7XG4gIGNvbXBsZXRlZFNsaWNlcz86IG51bWJlciB8IG51bGw7XG4gIHRvdGFsU2xpY2VzPzogbnVtYmVyIHwgbnVsbDtcbiAgYWxsTWlsZXN0b25lc0NvbXBsZXRlPzogYm9vbGVhbjtcbiAgYmFzZVBhdGg/OiBzdHJpbmcgfCBudWxsO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEF1dG9PdXRjb21lU3VyZmFjZVNuYXBzaG90IHtcbiAgc3RhdHVzOiBcInBhdXNlZFwiIHwgXCJzdG9wcGVkXCIgfCBcImJsb2NrZWRcIiB8IFwiZmFpbGVkXCIgfCBcImNvbXBsZXRlXCIgfCBcIndhaXRpbmdcIiB8IFwic3RlcFwiO1xuICB0aXRsZTogc3RyaW5nO1xuICBkZXRhaWw/OiBzdHJpbmcgfCBudWxsO1xuICB1bml0TGFiZWw/OiBzdHJpbmcgfCBudWxsO1xuICBuZXh0QWN0aW9uOiBzdHJpbmc7XG4gIGNvbW1hbmRzPzogc3RyaW5nW107XG4gIHN0YXJ0ZWRBdD86IG51bWJlcjtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFVuaXQgRGVzY3JpcHRpb24gSGVscGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGZ1bmN0aW9uIHVuaXRWZXJiKHVuaXRUeXBlOiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAodW5pdFR5cGUuc3RhcnRzV2l0aChcImhvb2svXCIpKSByZXR1cm4gYGhvb2s6ICR7dW5pdFR5cGUuc2xpY2UoNSl9YDtcbiAgc3dpdGNoICh1bml0VHlwZSkge1xuICAgIGNhc2UgXCJkaXNjdXNzLW1pbGVzdG9uZVwiOlxuICAgIGNhc2UgXCJkaXNjdXNzLXNsaWNlXCI6IHJldHVybiBcImRpc2N1c3NpbmdcIjtcbiAgICBjYXNlIFwicmVzZWFyY2gtbWlsZXN0b25lXCI6XG4gICAgY2FzZSBcInJlc2VhcmNoLXNsaWNlXCI6IHJldHVybiBcInJlc2VhcmNoaW5nXCI7XG4gICAgY2FzZSBcInBsYW4tbWlsZXN0b25lXCI6XG4gICAgY2FzZSBcInBsYW4tc2xpY2VcIjogcmV0dXJuIFwicGxhbm5pbmdcIjtcbiAgICBjYXNlIFwicmVmaW5lLXNsaWNlXCI6IHJldHVybiBcInJlZmluaW5nXCI7XG4gICAgY2FzZSBcImV4ZWN1dGUtdGFza1wiOiByZXR1cm4gXCJleGVjdXRpbmdcIjtcbiAgICBjYXNlIFwiY29tcGxldGUtc2xpY2VcIjogcmV0dXJuIFwiY29tcGxldGluZ1wiO1xuICAgIGNhc2UgXCJyZXBsYW4tc2xpY2VcIjogcmV0dXJuIFwicmVwbGFubmluZ1wiO1xuICAgIGNhc2UgXCJyZXdyaXRlLWRvY3NcIjogcmV0dXJuIFwicmV3cml0aW5nXCI7XG4gICAgY2FzZSBcInJlYXNzZXNzLXJvYWRtYXBcIjogcmV0dXJuIFwicmVhc3Nlc3NpbmdcIjtcbiAgICBjYXNlIFwicnVuLXVhdFwiOiByZXR1cm4gXCJydW5uaW5nIFVBVFwiO1xuICAgIGNhc2UgXCJjdXN0b20tc3RlcFwiOiByZXR1cm4gXCJleGVjdXRpbmcgd29ya2Zsb3cgc3RlcFwiO1xuICAgIGRlZmF1bHQ6IHJldHVybiB1bml0VHlwZTtcbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gdW5pdFBoYXNlTGFiZWwodW5pdFR5cGU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmICh1bml0VHlwZS5zdGFydHNXaXRoKFwiaG9vay9cIikpIHJldHVybiBcIkhPT0tcIjtcbiAgc3dpdGNoICh1bml0VHlwZSkge1xuICAgIGNhc2UgXCJkaXNjdXNzLW1pbGVzdG9uZVwiOlxuICAgIGNhc2UgXCJkaXNjdXNzLXNsaWNlXCI6IHJldHVybiBcIkRJU0NVU1NcIjtcbiAgICBjYXNlIFwicmVzZWFyY2gtbWlsZXN0b25lXCI6IHJldHVybiBcIlJFU0VBUkNIXCI7XG4gICAgY2FzZSBcInJlc2VhcmNoLXNsaWNlXCI6IHJldHVybiBcIlJFU0VBUkNIXCI7XG4gICAgY2FzZSBcInBsYW4tbWlsZXN0b25lXCI6IHJldHVybiBcIlBMQU5cIjtcbiAgICBjYXNlIFwicGxhbi1zbGljZVwiOiByZXR1cm4gXCJQTEFOXCI7XG4gICAgY2FzZSBcInJlZmluZS1zbGljZVwiOiByZXR1cm4gXCJSRUZJTkVcIjtcbiAgICBjYXNlIFwiZXhlY3V0ZS10YXNrXCI6IHJldHVybiBcIkVYRUNVVEVcIjtcbiAgICBjYXNlIFwiY29tcGxldGUtc2xpY2VcIjogcmV0dXJuIFwiQ09NUExFVEVcIjtcbiAgICBjYXNlIFwicmVwbGFuLXNsaWNlXCI6IHJldHVybiBcIlJFUExBTlwiO1xuICAgIGNhc2UgXCJyZXdyaXRlLWRvY3NcIjogcmV0dXJuIFwiUkVXUklURVwiO1xuICAgIGNhc2UgXCJyZWFzc2Vzcy1yb2FkbWFwXCI6IHJldHVybiBcIlJFQVNTRVNTXCI7XG4gICAgY2FzZSBcInJ1bi11YXRcIjogcmV0dXJuIFwiVUFUXCI7XG4gICAgY2FzZSBcImN1c3RvbS1zdGVwXCI6IHJldHVybiBcIldPUktGTE9XXCI7XG4gICAgZGVmYXVsdDogcmV0dXJuIHVuaXRUeXBlLnRvVXBwZXJDYXNlKCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gcGVla05leHQodW5pdFR5cGU6IHN0cmluZywgc3RhdGU6IEdTRFN0YXRlKTogc3RyaW5nIHtcbiAgLy8gU2hvdyBhY3RpdmUgaG9vayBpbmZvIGluIHByb2dyZXNzIGRpc3BsYXlcbiAgY29uc3QgYWN0aXZlSG9va1N0YXRlID0gZ2V0QWN0aXZlSG9vaygpO1xuICBpZiAoYWN0aXZlSG9va1N0YXRlKSB7XG4gICAgcmV0dXJuIGBob29rOiAke2FjdGl2ZUhvb2tTdGF0ZS5ob29rTmFtZX0gKGN5Y2xlICR7YWN0aXZlSG9va1N0YXRlLmN5Y2xlfSlgO1xuICB9XG5cbiAgY29uc3Qgc2lkID0gc3RhdGUuYWN0aXZlU2xpY2U/LmlkID8/IFwiXCI7XG4gIGlmICh1bml0VHlwZS5zdGFydHNXaXRoKFwiaG9vay9cIikpIHJldHVybiBgY29udGludWUgJHtzaWR9YDtcbiAgc3dpdGNoICh1bml0VHlwZSkge1xuICAgIGNhc2UgXCJkaXNjdXNzLW1pbGVzdG9uZVwiOiByZXR1cm4gXCJyZXNlYXJjaCBvciBwbGFuIG1pbGVzdG9uZVwiO1xuICAgIGNhc2UgXCJkaXNjdXNzLXNsaWNlXCI6IHJldHVybiBcInBsYW4gc2xpY2VcIjtcbiAgICBjYXNlIFwicmVzZWFyY2gtbWlsZXN0b25lXCI6IHJldHVybiBcInBsYW4gbWlsZXN0b25lIHJvYWRtYXBcIjtcbiAgICBjYXNlIFwicGxhbi1taWxlc3RvbmVcIjogcmV0dXJuIFwicGxhbiBvciBleGVjdXRlIGZpcnN0IHNsaWNlXCI7XG4gICAgY2FzZSBcInJlc2VhcmNoLXNsaWNlXCI6IHJldHVybiBgcGxhbiAke3NpZH1gO1xuICAgIGNhc2UgXCJwbGFuLXNsaWNlXCI6IHJldHVybiBcImV4ZWN1dGUgZmlyc3QgdGFza1wiO1xuICAgIGNhc2UgXCJyZWZpbmUtc2xpY2VcIjogcmV0dXJuIFwiZXhlY3V0ZSBmaXJzdCB0YXNrXCI7XG4gICAgY2FzZSBcImV4ZWN1dGUtdGFza1wiOiByZXR1cm4gYGNvbnRpbnVlICR7c2lkfWA7XG4gICAgY2FzZSBcImNvbXBsZXRlLXNsaWNlXCI6IHJldHVybiBcInJlYXNzZXNzIHJvYWRtYXBcIjtcbiAgICBjYXNlIFwicmVwbGFuLXNsaWNlXCI6IHJldHVybiBgcmUtZXhlY3V0ZSAke3NpZH1gO1xuICAgIGNhc2UgXCJyZXdyaXRlLWRvY3NcIjogcmV0dXJuIFwiY29udGludWUgZXhlY3V0aW9uXCI7XG4gICAgY2FzZSBcInJlYXNzZXNzLXJvYWRtYXBcIjogcmV0dXJuIFwiYWR2YW5jZSB0byBuZXh0IHNsaWNlXCI7XG4gICAgY2FzZSBcInJ1bi11YXRcIjogcmV0dXJuIFwicmVhc3Nlc3Mgcm9hZG1hcFwiO1xuICAgIGRlZmF1bHQ6IHJldHVybiBcIlwiO1xuICB9XG59XG5cbi8qKlxuICogRGVzY3JpYmUgd2hhdCB0aGUgbmV4dCB1bml0IHdpbGwgYmUsIGJhc2VkIG9uIGN1cnJlbnQgc3RhdGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkZXNjcmliZU5leHRVbml0KHN0YXRlOiBHU0RTdGF0ZSk6IHsgbGFiZWw6IHN0cmluZzsgZGVzY3JpcHRpb246IHN0cmluZyB9IHtcbiAgY29uc3Qgc2lkID0gc3RhdGUuYWN0aXZlU2xpY2U/LmlkO1xuICBjb25zdCBzVGl0bGUgPSBzdGF0ZS5hY3RpdmVTbGljZT8udGl0bGU7XG4gIGNvbnN0IHRpZCA9IHN0YXRlLmFjdGl2ZVRhc2s/LmlkO1xuICBjb25zdCB0VGl0bGUgPSBzdGF0ZS5hY3RpdmVUYXNrPy50aXRsZTtcblxuICBzd2l0Y2ggKHN0YXRlLnBoYXNlKSB7XG4gICAgY2FzZSBcIm5lZWRzLWRpc2N1c3Npb25cIjpcbiAgICAgIHJldHVybiB7IGxhYmVsOiBcIkRpc2N1c3MgbWlsZXN0b25lIGRyYWZ0XCIsIGRlc2NyaXB0aW9uOiBcIk1pbGVzdG9uZSBoYXMgYSBkcmFmdCBjb250ZXh0IFx1MjAxNCBuZWVkcyBkaXNjdXNzaW9uIGJlZm9yZSBwbGFubmluZy5cIiB9O1xuICAgIGNhc2UgXCJwcmUtcGxhbm5pbmdcIjpcbiAgICAgIHJldHVybiB7IGxhYmVsOiBcIlJlc2VhcmNoICYgcGxhbiBtaWxlc3RvbmVcIiwgZGVzY3JpcHRpb246IFwiU2NvdXQgdGhlIGxhbmRzY2FwZSBhbmQgY3JlYXRlIHRoZSByb2FkbWFwLlwiIH07XG4gICAgY2FzZSBcInBsYW5uaW5nXCI6XG4gICAgICByZXR1cm4geyBsYWJlbDogYFBsYW4gJHtzaWR9OiAke3NUaXRsZX1gLCBkZXNjcmlwdGlvbjogXCJSZXNlYXJjaCBhbmQgZGVjb21wb3NlIGludG8gdGFza3MuXCIgfTtcbiAgICBjYXNlIFwiZXhlY3V0aW5nXCI6XG4gICAgICByZXR1cm4geyBsYWJlbDogYEV4ZWN1dGUgJHt0aWR9OiAke3RUaXRsZX1gLCBkZXNjcmlwdGlvbjogXCJSdW4gdGhlIG5leHQgdGFzayBpbiBhIGZyZXNoIHNlc3Npb24uXCIgfTtcbiAgICBjYXNlIFwic3VtbWFyaXppbmdcIjpcbiAgICAgIHJldHVybiB7IGxhYmVsOiBgQ29tcGxldGUgJHtzaWR9OiAke3NUaXRsZX1gLCBkZXNjcmlwdGlvbjogXCJXcml0ZSBzdW1tYXJ5LCBVQVQsIGFuZCBtZXJnZSB0byBtYWluLlwiIH07XG4gICAgY2FzZSBcInJlcGxhbm5pbmctc2xpY2VcIjpcbiAgICAgIHJldHVybiB7IGxhYmVsOiBgUmVwbGFuICR7c2lkfTogJHtzVGl0bGV9YCwgZGVzY3JpcHRpb246IFwiQmxvY2tlciBmb3VuZCBcdTIwMTQgcmVwbGFuIHRoZSBzbGljZS5cIiB9O1xuICAgIGNhc2UgXCJjb21wbGV0aW5nLW1pbGVzdG9uZVwiOlxuICAgICAgcmV0dXJuIHsgbGFiZWw6IFwiQ29tcGxldGUgbWlsZXN0b25lXCIsIGRlc2NyaXB0aW9uOiBcIldyaXRlIG1pbGVzdG9uZSBzdW1tYXJ5LlwiIH07XG4gICAgY2FzZSBcImV2YWx1YXRpbmctZ2F0ZXNcIjpcbiAgICAgIHJldHVybiB7IGxhYmVsOiBgRXZhbHVhdGUgZ2F0ZXMgZm9yICR7c2lkfTogJHtzVGl0bGV9YCwgZGVzY3JpcHRpb246IFwiUGFyYWxsZWwgcXVhbGl0eSBnYXRlIGFzc2Vzc21lbnQgYmVmb3JlIGV4ZWN1dGlvbi5cIiB9O1xuICAgIGRlZmF1bHQ6XG4gICAgICByZXR1cm4geyBsYWJlbDogXCJDb250aW51ZVwiLCBkZXNjcmlwdGlvbjogXCJFeGVjdXRlIHRoZSBuZXh0IHN0ZXAuXCIgfTtcbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRWxhcHNlZCBUaW1lIEZvcm1hdHRpbmcgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKiBGb3JtYXQgZWxhcHNlZCB0aW1lIHNpbmNlIGF1dG8tbW9kZSBzdGFydGVkICovXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0QXV0b0VsYXBzZWQoYXV0b1N0YXJ0VGltZTogbnVtYmVyKTogc3RyaW5nIHtcbiAgaWYgKCFhdXRvU3RhcnRUaW1lIHx8IGF1dG9TdGFydFRpbWUgPD0gMCB8fCAhTnVtYmVyLmlzRmluaXRlKGF1dG9TdGFydFRpbWUpKSByZXR1cm4gXCJcIjtcbiAgY29uc3QgbXMgPSBEYXRlLm5vdygpIC0gYXV0b1N0YXJ0VGltZTtcbiAgaWYgKG1zIDwgMCB8fCBtcyA+IDMwICogMjQgKiAzNjAwXzAwMCkgcmV0dXJuIFwiXCI7IC8vIG5lZ2F0aXZlIG9yID4zMCBkYXlzID0gaW52YWxpZFxuICBjb25zdCBzID0gTWF0aC5mbG9vcihtcyAvIDEwMDApO1xuICBpZiAocyA8IDYwKSByZXR1cm4gYCR7c31zYDtcbiAgY29uc3QgbSA9IE1hdGguZmxvb3IocyAvIDYwKTtcbiAgY29uc3QgcnMgPSBzICUgNjA7XG4gIGlmIChtIDwgNjApIHJldHVybiBgJHttfW0ke3JzID4gMCA/IGAgJHtyc31zYCA6IFwiXCJ9YDtcbiAgY29uc3QgaCA9IE1hdGguZmxvb3IobSAvIDYwKTtcbiAgY29uc3Qgcm0gPSBtICUgNjA7XG4gIHJldHVybiBgJHtofWggJHtybX1tYDtcbn1cblxuLyoqIEZvcm1hdCB0b2tlbiBjb3VudHMgZm9yIGNvbXBhY3QgZGlzcGxheSAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdFdpZGdldFRva2Vucyhjb3VudDogbnVtYmVyKTogc3RyaW5nIHtcbiAgaWYgKGNvdW50IDwgMTAwMCkgcmV0dXJuIGNvdW50LnRvU3RyaW5nKCk7XG4gIGlmIChjb3VudCA8IDEwMDAwKSByZXR1cm4gYCR7KGNvdW50IC8gMTAwMCkudG9GaXhlZCgxKX1rYDtcbiAgaWYgKGNvdW50IDwgMTAwMDAwMCkgcmV0dXJuIGAke01hdGgucm91bmQoY291bnQgLyAxMDAwKX1rYDtcbiAgaWYgKGNvdW50IDwgMTAwMDAwMDApIHJldHVybiBgJHsoY291bnQgLyAxMDAwMDAwKS50b0ZpeGVkKDEpfU1gO1xuICByZXR1cm4gYCR7TWF0aC5yb3VuZChjb3VudCAvIDEwMDAwMDApfU1gO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0UnVudGltZUhlYWx0aFNpZ25hbChcbiAgcmVjb3JkOiBBdXRvVW5pdFJ1bnRpbWVSZWNvcmQgfCBudWxsLFxuICBub3cgPSBEYXRlLm5vdygpLFxuKTogeyBsZXZlbDogXCJncmVlblwiIHwgXCJ5ZWxsb3dcIjsgc3VtbWFyeTogc3RyaW5nOyBkZXRhaWw/OiBzdHJpbmcgfSB8IG51bGwge1xuICBpZiAoIXJlY29yZCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGlkbGVNcyA9IE1hdGgubWF4KDAsIG5vdyAtIHJlY29yZC5sYXN0UHJvZ3Jlc3NBdCk7XG4gIGNvbnN0IGlkbGVNaW51dGVzID0gTWF0aC5mbG9vcihpZGxlTXMgLyA2MF8wMDApO1xuICBpZiAoKHJlY29yZC5yZWNvdmVyeUF0dGVtcHRzID8/IDApID4gMCB8fCByZWNvcmQucGhhc2UgPT09IFwicmVjb3ZlcmVkXCIgfHwgcmVjb3JkLmxhc3RQcm9ncmVzc0tpbmQuaW5jbHVkZXMoXCJyZWNvdmVyeVwiKSkge1xuICAgIHJldHVybiB7XG4gICAgICBsZXZlbDogXCJ5ZWxsb3dcIixcbiAgICAgIHN1bW1hcnk6IFwiUmVjb3ZlcmluZ1wiLFxuICAgICAgZGV0YWlsOiBgcmV0cnkgJHtyZWNvcmQucmVjb3ZlcnlBdHRlbXB0cyA/PyAxfSBhZnRlciAke3JlY29yZC5sYXN0UmVjb3ZlcnlSZWFzb24gPz8gXCJpZGxlXCJ9IHN0YWxsYCxcbiAgICB9O1xuICB9XG4gIGlmIChyZWNvcmQucHJvZ3Jlc3NDb3VudCA9PT0gMCAmJiBpZGxlTXMgPj0gNjBfMDAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGxldmVsOiBcInllbGxvd1wiLFxuICAgICAgc3VtbWFyeTogXCJXYWl0aW5nIG9uIHByb3ZpZGVyXCIsXG4gICAgICBkZXRhaWw6IGBubyBvdXRwdXQgZm9yICR7aWRsZU1pbnV0ZXN9bWAsXG4gICAgfTtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNob3VsZFJlbmRlclJvYWRtYXBQcm9ncmVzcyhcbiAgcHJvZ3Jlc3M6IHsgdG90YWw6IG51bWJlcjsgYWN0aXZlU2xpY2VUYXNrcz86IHsgdG90YWw6IG51bWJlciB9IHwgbnVsbCB9IHwgbnVsbCxcbik6IHByb2dyZXNzIGlzIHsgdG90YWw6IG51bWJlcjsgYWN0aXZlU2xpY2VUYXNrcz86IHsgdG90YWw6IG51bWJlciB9IHwgbnVsbCB9IHtcbiAgcmV0dXJuICEhcHJvZ3Jlc3MgJiYgcHJvZ3Jlc3MudG90YWwgPiAwO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRVRBIEVzdGltYXRpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogRXN0aW1hdGUgcmVtYWluaW5nIHRpbWUgYmFzZWQgb24gYXZlcmFnZSB1bml0IGR1cmF0aW9uIGZyb20gdGhlIG1ldHJpY3MgbGVkZ2VyLlxuICogUmV0dXJucyBhIGZvcm1hdHRlZCBzdHJpbmcgbGlrZSBcIn4xMm0gcmVtYWluaW5nXCIgb3IgbnVsbCBpZiBpbnN1ZmZpY2llbnQgZGF0YS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVzdGltYXRlVGltZVJlbWFpbmluZygpOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3QgbGVkZ2VyID0gZ2V0TGVkZ2VyKCk7XG4gIGlmICghbGVkZ2VyIHx8IGxlZGdlci51bml0cy5sZW5ndGggPCAyKSByZXR1cm4gbnVsbDtcblxuICBjb25zdCBzbGljZVByb2dyZXNzID0gZ2V0Um9hZG1hcFNsaWNlc1N5bmMoKTtcbiAgaWYgKCFzbGljZVByb2dyZXNzIHx8IHNsaWNlUHJvZ3Jlc3MudG90YWwgPT09IDApIHJldHVybiBudWxsO1xuXG4gIGNvbnN0IHJlbWFpbmluZ1NsaWNlcyA9IHNsaWNlUHJvZ3Jlc3MudG90YWwgLSBzbGljZVByb2dyZXNzLmRvbmU7XG4gIGlmIChyZW1haW5pbmdTbGljZXMgPD0gMCkgcmV0dXJuIG51bGw7XG5cbiAgLy8gQ29tcHV0ZSBhdmVyYWdlIGR1cmF0aW9uIHBlciBjb21wbGV0ZWQgc2xpY2UgZnJvbSB0aGUgbGVkZ2VyXG4gIGNvbnN0IGNvbXBsZXRlZFNsaWNlVW5pdHMgPSBsZWRnZXIudW5pdHMuZmlsdGVyKFxuICAgIHUgPT4gdS5maW5pc2hlZEF0ID4gMCAmJiB1LnN0YXJ0ZWRBdCA+IDAsXG4gICk7XG4gIGlmIChjb21wbGV0ZWRTbGljZVVuaXRzLmxlbmd0aCA8IDIpIHJldHVybiBudWxsO1xuXG4gIGNvbnN0IHRvdGFsRHVyYXRpb24gPSBjb21wbGV0ZWRTbGljZVVuaXRzLnJlZHVjZShcbiAgICAoc3VtLCB1KSA9PiBzdW0gKyAodS5maW5pc2hlZEF0IC0gdS5zdGFydGVkQXQpLCAwLFxuICApO1xuICBjb25zdCBhdmdEdXJhdGlvbiA9IHRvdGFsRHVyYXRpb24gLyBjb21wbGV0ZWRTbGljZVVuaXRzLmxlbmd0aDtcblxuICAvLyBSb3VnaCBlc3RpbWF0ZTogcmVtYWluaW5nIHNsaWNlcyBcdTAwRDcgYXZlcmFnZSB1bml0cyBwZXIgc2xpY2UgXHUwMEQ3IGF2ZyBkdXJhdGlvblxuICBjb25zdCBjb21wbGV0ZWRTbGljZXMgPSBzbGljZVByb2dyZXNzLmRvbmUgfHwgMTtcbiAgY29uc3QgdW5pdHNQZXJTbGljZSA9IGNvbXBsZXRlZFNsaWNlVW5pdHMubGVuZ3RoIC8gY29tcGxldGVkU2xpY2VzO1xuICBjb25zdCBlc3RpbWF0ZWRNcyA9IHJlbWFpbmluZ1NsaWNlcyAqIHVuaXRzUGVyU2xpY2UgKiBhdmdEdXJhdGlvbjtcblxuICBpZiAoZXN0aW1hdGVkTXMgPCA1XzAwMCkgcmV0dXJuIG51bGw7IC8vIFRvbyBzbWFsbCB0byBkaXNwbGF5XG5cbiAgY29uc3QgcyA9IE1hdGguZmxvb3IoZXN0aW1hdGVkTXMgLyAxMDAwKTtcbiAgaWYgKHMgPCA2MCkgcmV0dXJuIGB+JHtzfXMgcmVtYWluaW5nYDtcbiAgY29uc3QgbSA9IE1hdGguZmxvb3IocyAvIDYwKTtcbiAgaWYgKG0gPCA2MCkgcmV0dXJuIGB+JHttfW0gcmVtYWluaW5nYDtcbiAgY29uc3QgaCA9IE1hdGguZmxvb3IobSAvIDYwKTtcbiAgY29uc3Qgcm0gPSBtICUgNjA7XG4gIHJldHVybiBybSA+IDAgPyBgfiR7aH1oICR7cm19bSByZW1haW5pbmdgIDogYH4ke2h9aCByZW1haW5pbmdgO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU2xpY2UgUHJvZ3Jlc3MgQ2FjaGUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKiBDYWNoZWQgdGFzayBkZXRhaWwgZm9yIHRoZSB3aWRnZXQgdGFzayBjaGVja2xpc3QgKi9cbmludGVyZmFjZSBDYWNoZWRUYXNrRGV0YWlsIHtcbiAgaWQ6IHN0cmluZztcbiAgdGl0bGU6IHN0cmluZztcbiAgZG9uZTogYm9vbGVhbjtcbn1cblxuLyoqIENhY2hlZCBzbGljZSBwcm9ncmVzcyBmb3IgdGhlIHdpZGdldCBcdTIwMTQgYXZvaWQgYXN5bmMgaW4gcmVuZGVyICovXG5sZXQgY2FjaGVkU2xpY2VQcm9ncmVzczoge1xuICBkb25lOiBudW1iZXI7XG4gIHRvdGFsOiBudW1iZXI7XG4gIG1pbGVzdG9uZUlkOiBzdHJpbmc7XG4gIC8qKiBSZWFsIHRhc2sgcHJvZ3Jlc3MgZm9yIHRoZSBhY3RpdmUgc2xpY2UsIGlmIGl0cyBwbGFuIGZpbGUgZXhpc3RzICovXG4gIGFjdGl2ZVNsaWNlVGFza3M6IHsgZG9uZTogbnVtYmVyOyB0b3RhbDogbnVtYmVyIH0gfCBudWxsO1xuICAvKiogRnVsbCB0YXNrIGxpc3QgZm9yIHRoZSBhY3RpdmUgc2xpY2UgY2hlY2tsaXN0ICovXG4gIHRhc2tEZXRhaWxzOiBDYWNoZWRUYXNrRGV0YWlsW10gfCBudWxsO1xufSB8IG51bGwgPSBudWxsO1xuXG5leHBvcnQgZnVuY3Rpb24gdXBkYXRlU2xpY2VQcm9ncmVzc0NhY2hlKGJhc2U6IHN0cmluZywgbWlkOiBzdHJpbmcsIGFjdGl2ZVNpZD86IHN0cmluZyk6IHZvaWQge1xuICB0cnkge1xuICAgIC8vIE5vcm1hbGl6ZSBzbGljZXM6IHByZWZlciBEQiwgZmFsbCBiYWNrIHRvIHBhcnNlclxuICAgIHR5cGUgTm9ybVNsaWNlID0geyBpZDogc3RyaW5nOyBkb25lOiBib29sZWFuOyB0aXRsZTogc3RyaW5nIH07XG4gICAgbGV0IG5vcm1TbGljZXM6IE5vcm1TbGljZVtdO1xuICAgIGlmIChpc0RiQXZhaWxhYmxlKCkpIHtcbiAgICAgIG5vcm1TbGljZXMgPSBnZXRNaWxlc3RvbmVTbGljZXMobWlkKS5tYXAocyA9PiAoeyBpZDogcy5pZCwgZG9uZTogcy5zdGF0dXMgPT09IFwiY29tcGxldGVcIiwgdGl0bGU6IHMudGl0bGUgfSkpO1xuICAgIH0gZWxzZSB7XG4gICAgICBub3JtU2xpY2VzID0gW107XG4gICAgfVxuXG4gICAgbGV0IGFjdGl2ZVNsaWNlVGFza3M6IHsgZG9uZTogbnVtYmVyOyB0b3RhbDogbnVtYmVyIH0gfCBudWxsID0gbnVsbDtcbiAgICBsZXQgdGFza0RldGFpbHM6IENhY2hlZFRhc2tEZXRhaWxbXSB8IG51bGwgPSBudWxsO1xuICAgIGlmIChhY3RpdmVTaWQpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGlmIChpc0RiQXZhaWxhYmxlKCkpIHtcbiAgICAgICAgICBjb25zdCBkYlRhc2tzID0gZ2V0U2xpY2VUYXNrcyhtaWQsIGFjdGl2ZVNpZCk7XG4gICAgICAgICAgaWYgKGRiVGFza3MubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgYWN0aXZlU2xpY2VUYXNrcyA9IHtcbiAgICAgICAgICAgICAgZG9uZTogZGJUYXNrcy5maWx0ZXIodCA9PiB0LnN0YXR1cyA9PT0gXCJjb21wbGV0ZVwiIHx8IHQuc3RhdHVzID09PSBcImRvbmVcIikubGVuZ3RoLFxuICAgICAgICAgICAgICB0b3RhbDogZGJUYXNrcy5sZW5ndGgsXG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgdGFza0RldGFpbHMgPSBkYlRhc2tzLm1hcCh0ID0+ICh7IGlkOiB0LmlkLCB0aXRsZTogdC50aXRsZSwgZG9uZTogdC5zdGF0dXMgPT09IFwiY29tcGxldGVcIiB8fCB0LnN0YXR1cyA9PT0gXCJkb25lXCIgfSkpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIC8vIE5vbi1mYXRhbCBcdTIwMTQganVzdCBvbWl0IHRhc2sgY291bnRcbiAgICAgICAgbG9nV2FybmluZyhcImRhc2hib2FyZFwiLCBgb3BlcmF0aW9uIGZhaWxlZDogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgY2FjaGVkU2xpY2VQcm9ncmVzcyA9IHtcbiAgICAgIGRvbmU6IG5vcm1TbGljZXMuZmlsdGVyKHMgPT4gcy5kb25lKS5sZW5ndGgsXG4gICAgICB0b3RhbDogbm9ybVNsaWNlcy5sZW5ndGgsXG4gICAgICBtaWxlc3RvbmVJZDogbWlkLFxuICAgICAgYWN0aXZlU2xpY2VUYXNrcyxcbiAgICAgIHRhc2tEZXRhaWxzLFxuICAgIH07XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIC8vIE5vbi1mYXRhbCBcdTIwMTQgd2lkZ2V0IGp1c3Qgd29uJ3Qgc2hvdyBwcm9ncmVzcyBiYXJcbiAgICBsb2dXYXJuaW5nKFwiZGFzaGJvYXJkXCIsIGBvcGVyYXRpb24gZmFpbGVkOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gKTtcbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0Um9hZG1hcFNsaWNlc1N5bmMoKTogeyBkb25lOiBudW1iZXI7IHRvdGFsOiBudW1iZXI7IGFjdGl2ZVNsaWNlVGFza3M6IHsgZG9uZTogbnVtYmVyOyB0b3RhbDogbnVtYmVyIH0gfCBudWxsOyB0YXNrRGV0YWlsczogQ2FjaGVkVGFza0RldGFpbFtdIHwgbnVsbCB9IHwgbnVsbCB7XG4gIHJldHVybiBjYWNoZWRTbGljZVByb2dyZXNzO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY2xlYXJTbGljZVByb2dyZXNzQ2FjaGUoKTogdm9pZCB7XG4gIGNhY2hlZFNsaWNlUHJvZ3Jlc3MgPSBudWxsO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgTGFzdCBDb21taXQgQ2FjaGUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKiBDYWNoZWQgbGFzdCBjb21taXQgaW5mbyBcdTIwMTQgcmVmcmVzaGVkIG9uIHRoZSAxNXMgdGltZXIsIG5vdCBldmVyeSByZW5kZXIgKi9cbmxldCBjYWNoZWRMYXN0Q29tbWl0OiB7IHRpbWVBZ286IHN0cmluZzsgbWVzc2FnZTogc3RyaW5nIH0gfCBudWxsID0gbnVsbDtcbmxldCBsYXN0Q29tbWl0RmV0Y2hlZEF0ID0gMDtcblxuZnVuY3Rpb24gcmVmcmVzaExhc3RDb21taXQoYmFzZVBhdGg6IHN0cmluZyk6IHZvaWQge1xuICB0cnkge1xuICAgIGlmICghbmF0aXZlSXNSZXBvKGJhc2VQYXRoKSkge1xuICAgICAgY2FjaGVkTGFzdENvbW1pdCA9IG51bGw7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRyeSB7XG4gICAgICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wicmV2LXBhcnNlXCIsIFwiLS12ZXJpZnlcIiwgXCJIRUFEXCJdLCB7XG4gICAgICAgIGN3ZDogYmFzZVBhdGgsXG4gICAgICAgIHN0ZGlvOiBbXCJwaXBlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0sXG4gICAgICAgIHRpbWVvdXQ6IDMwMDAsXG4gICAgICB9KTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIGNhY2hlZExhc3RDb21taXQgPSBudWxsO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCByYXcgPSBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wibG9nXCIsIFwiLTFcIiwgXCItLWZvcm1hdD0lY3J8JXNcIl0sIHtcbiAgICAgIGN3ZDogYmFzZVBhdGgsXG4gICAgICBlbmNvZGluZzogXCJ1dGYtOFwiLFxuICAgICAgc3RkaW86IFtcInBpcGVcIiwgXCJwaXBlXCIsIFwicGlwZVwiXSxcbiAgICAgIHRpbWVvdXQ6IDMwMDAsXG4gICAgfSkudHJpbSgpO1xuICAgIGNvbnN0IHNlcCA9IHJhdy5pbmRleE9mKFwifFwiKTtcbiAgICBpZiAoc2VwID4gMCkge1xuICAgICAgY2FjaGVkTGFzdENvbW1pdCA9IHtcbiAgICAgICAgdGltZUFnbzogcmF3LnNsaWNlKDAsIHNlcCkucmVwbGFjZSgvIGFnbyQvLCBcIlwiKSxcbiAgICAgICAgbWVzc2FnZTogcmF3LnNsaWNlKHNlcCArIDEpLFxuICAgICAgfTtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIC8vIE5vbi1mYXRhbCBcdTIwMTQganVzdCBza2lwIGxhc3QgY29tbWl0IGRpc3BsYXlcbiAgICBjYWNoZWRMYXN0Q29tbWl0ID0gbnVsbDtcbiAgICBsb2dXYXJuaW5nKFwiZGFzaGJvYXJkXCIsIGBvcGVyYXRpb24gZmFpbGVkOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBsYXN0Q29tbWl0RmV0Y2hlZEF0ID0gRGF0ZS5ub3coKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBnZXRMYXN0Q29tbWl0KGJhc2VQYXRoOiBzdHJpbmcpOiB7IHRpbWVBZ286IHN0cmluZzsgbWVzc2FnZTogc3RyaW5nIH0gfCBudWxsIHtcbiAgLy8gUmVmcmVzaCBhdCBtb3N0IGV2ZXJ5IDE1IHNlY29uZHNcbiAgaWYgKERhdGUubm93KCkgLSBsYXN0Q29tbWl0RmV0Y2hlZEF0ID4gMTVfMDAwKSB7XG4gICAgcmVmcmVzaExhc3RDb21taXQoYmFzZVBhdGgpO1xuICB9XG4gIHJldHVybiBjYWNoZWRMYXN0Q29tbWl0O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gX3Jlc2V0TGFzdENvbW1pdENhY2hlRm9yVGVzdHMoKTogdm9pZCB7XG4gIGNhY2hlZExhc3RDb21taXQgPSBudWxsO1xuICBsYXN0Q29tbWl0RmV0Y2hlZEF0ID0gMDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIF9yZWZyZXNoTGFzdENvbW1pdEZvclRlc3RzKGJhc2VQYXRoOiBzdHJpbmcpOiB2b2lkIHtcbiAgcmVmcmVzaExhc3RDb21taXQoYmFzZVBhdGgpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gX2dldExhc3RDb21taXRGb3JUZXN0cyhiYXNlUGF0aDogc3RyaW5nKTogeyB0aW1lQWdvOiBzdHJpbmc7IG1lc3NhZ2U6IHN0cmluZyB9IHwgbnVsbCB7XG4gIHJldHVybiBnZXRMYXN0Q29tbWl0KGJhc2VQYXRoKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIF9nZXRMYXN0Q29tbWl0RmV0Y2hlZEF0Rm9yVGVzdHMoKTogbnVtYmVyIHtcbiAgcmV0dXJuIGxhc3RDb21taXRGZXRjaGVkQXQ7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBGb290ZXIgRmFjdG9yeSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBGb290ZXIgZmFjdG9yeSB1c2VkIGJ5IGF1dG8tbW9kZS5cbiAqIEtlZXAgZm9vdGVyIG1pbmltYWwgYnV0IHByZXNlcnZlIGV4dGVuc2lvbiBzdGF0dXMgY29udGV4dCBmcm9tIHNldFN0YXR1cygpLlxuICovXG5mdW5jdGlvbiBzYW5pdGl6ZUZvb3RlclN0YXR1cyh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdGV4dC5yZXBsYWNlKC9cXHMrL2csIFwiIFwiKS50cmltKCk7XG59XG5cbmV4cG9ydCBjb25zdCBoaWRlRm9vdGVyID0gKF90dWk6IHVua25vd24sIHRoZW1lOiBUaGVtZSwgZm9vdGVyRGF0YTogUmVhZG9ubHlGb290ZXJEYXRhUHJvdmlkZXIpID0+ICh7XG4gIHJlbmRlcih3aWR0aDogbnVtYmVyKTogc3RyaW5nW10ge1xuICAgIGNvbnN0IGV4dGVuc2lvblN0YXR1c2VzID0gZm9vdGVyRGF0YS5nZXRFeHRlbnNpb25TdGF0dXNlcygpO1xuICAgIGlmIChleHRlbnNpb25TdGF0dXNlcy5zaXplID09PSAwKSByZXR1cm4gW107XG4gICAgY29uc3Qgc3RhdHVzTGluZSA9IEFycmF5LmZyb20oZXh0ZW5zaW9uU3RhdHVzZXMuZW50cmllcygpKVxuICAgICAgLnNvcnQoKFthXSwgW2JdKSA9PiBhLmxvY2FsZUNvbXBhcmUoYikpXG4gICAgICAubWFwKChbLCB0ZXh0XSkgPT4gc2FuaXRpemVGb290ZXJTdGF0dXModGV4dCkpXG4gICAgICAuam9pbihcIiBcIik7XG4gICAgcmV0dXJuIFt0cnVuY2F0ZVRvV2lkdGgodGhlbWUuZmcoXCJkaW1cIiwgc3RhdHVzTGluZSksIHdpZHRoLCB0aGVtZS5mZyhcImRpbVwiLCBcIi4uLlwiKSldO1xuICB9LFxuICBpbnZhbGlkYXRlKCkge30sXG4gIGRpc3Bvc2UoKSB7fSxcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgV2lkZ2V0IERpc3BsYXkgTW9kZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqIFdpZGdldCBkaXNwbGF5IG1vZGVzOiBmdWxsIFx1MjE5MiBzbWFsbCBcdTIxOTIgbWluIFx1MjE5MiBvZmYgXHUyMTkyIGZ1bGwgKi9cbmV4cG9ydCB0eXBlIFdpZGdldE1vZGUgPSBcImZ1bGxcIiB8IFwic21hbGxcIiB8IFwibWluXCIgfCBcIm9mZlwiO1xuY29uc3QgV0lER0VUX01PREVTOiBXaWRnZXRNb2RlW10gPSBbXCJmdWxsXCIsIFwic21hbGxcIiwgXCJtaW5cIiwgXCJvZmZcIl07XG5sZXQgd2lkZ2V0TW9kZTogV2lkZ2V0TW9kZSA9IFwiZnVsbFwiO1xubGV0IHdpZGdldE1vZGVJbml0aWFsaXplZCA9IGZhbHNlO1xubGV0IHdpZGdldE1vZGVQcmVmZXJlbmNlUGF0aDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cbmZ1bmN0aW9uIHNhZmVSZWFkVGV4dEZpbGUocGF0aDogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gIHRyeSB7XG4gICAgaWYgKCFleGlzdHNTeW5jKHBhdGgpKSByZXR1cm4gbnVsbDtcbiAgICByZXR1cm4gcmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmLThcIik7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlYWRXaWRnZXRNb2RlRnJvbUZpbGUocGF0aDogc3RyaW5nKTogV2lkZ2V0TW9kZSB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IHJhdyA9IHNhZmVSZWFkVGV4dEZpbGUocGF0aCk7XG4gIGlmICghcmF3KSByZXR1cm4gdW5kZWZpbmVkO1xuICBjb25zdCBwcmVmcyA9IHBhcnNlUHJlZmVyZW5jZXNNYXJrZG93bihyYXcpO1xuICBjb25zdCBzYXZlZCA9IHByZWZzPy53aWRnZXRfbW9kZTtcbiAgaWYgKHNhdmVkICYmIFdJREdFVF9NT0RFUy5pbmNsdWRlcyhzYXZlZCBhcyBXaWRnZXRNb2RlKSkge1xuICAgIHJldHVybiBzYXZlZCBhcyBXaWRnZXRNb2RlO1xuICB9XG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmZ1bmN0aW9uIHJlc29sdmVXaWRnZXRNb2RlUHJlZmVyZW5jZVBhdGgoXG4gIHByb2plY3RQYXRoID0gZ2V0UHJvamVjdEdTRFByZWZlcmVuY2VzUGF0aCgpLFxuICBnbG9iYWxQYXRoID0gZ2V0R2xvYmFsR1NEUHJlZmVyZW5jZXNQYXRoKCksXG4pOiBzdHJpbmcge1xuICBpZiAocmVhZFdpZGdldE1vZGVGcm9tRmlsZShwcm9qZWN0UGF0aCkpIHtcbiAgICByZXR1cm4gcHJvamVjdFBhdGg7XG4gIH1cblxuICBpZiAocmVhZFdpZGdldE1vZGVGcm9tRmlsZShnbG9iYWxQYXRoKSkge1xuICAgIHJldHVybiBnbG9iYWxQYXRoO1xuICB9XG5cbiAgaWYgKHNhZmVSZWFkVGV4dEZpbGUocHJvamVjdFBhdGgpICE9PSBudWxsKSByZXR1cm4gcHJvamVjdFBhdGg7XG4gIGlmIChzYWZlUmVhZFRleHRGaWxlKGdsb2JhbFBhdGgpICE9PSBudWxsKSByZXR1cm4gZ2xvYmFsUGF0aDtcbiAgcmV0dXJuIGdldEdsb2JhbEdTRFByZWZlcmVuY2VzUGF0aCgpO1xufVxuXG4vKiogTG9hZCB3aWRnZXQgbW9kZSBmcm9tIHByZWZlcmVuY2VzIChvbmNlKS4gKi9cbmZ1bmN0aW9uIGVuc3VyZVdpZGdldE1vZGVMb2FkZWQocHJvamVjdFBhdGg/OiBzdHJpbmcsIGdsb2JhbFBhdGg/OiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKHdpZGdldE1vZGVJbml0aWFsaXplZCkgcmV0dXJuO1xuICB3aWRnZXRNb2RlSW5pdGlhbGl6ZWQgPSB0cnVlO1xuICB0cnkge1xuICAgIGNvbnN0IHJlc29sdmVkUHJvamVjdFBhdGggPSBwcm9qZWN0UGF0aCA/PyBnZXRQcm9qZWN0R1NEUHJlZmVyZW5jZXNQYXRoKCk7XG4gICAgY29uc3QgcmVzb2x2ZWRHbG9iYWxQYXRoID0gZ2xvYmFsUGF0aCA/PyBnZXRHbG9iYWxHU0RQcmVmZXJlbmNlc1BhdGgoKTtcbiAgICBjb25zdCBzYXZlZCA9IHJlYWRXaWRnZXRNb2RlRnJvbUZpbGUocmVzb2x2ZWRQcm9qZWN0UGF0aCkgPz8gcmVhZFdpZGdldE1vZGVGcm9tRmlsZShyZXNvbHZlZEdsb2JhbFBhdGgpO1xuICAgIGlmIChzYXZlZCAmJiBXSURHRVRfTU9ERVMuaW5jbHVkZXMoc2F2ZWQgYXMgV2lkZ2V0TW9kZSkpIHtcbiAgICAgIHdpZGdldE1vZGUgPSBzYXZlZCBhcyBXaWRnZXRNb2RlO1xuICAgIH1cbiAgICB3aWRnZXRNb2RlUHJlZmVyZW5jZVBhdGggPSByZXNvbHZlV2lkZ2V0TW9kZVByZWZlcmVuY2VQYXRoKHJlc29sdmVkUHJvamVjdFBhdGgsIHJlc29sdmVkR2xvYmFsUGF0aCk7XG4gIH0gY2F0Y2ggKGVycikgeyAvKiBub24tZmF0YWwgXHUyMDE0IHVzZSBkZWZhdWx0ICovXG4gICAgbG9nV2FybmluZyhcImRhc2hib2FyZFwiLCBgb3BlcmF0aW9uIGZhaWxlZDogJHtnZXRFcnJvck1lc3NhZ2UoZXJyKX1gKTtcbiAgICB3aWRnZXRNb2RlUHJlZmVyZW5jZVBhdGggPSBnZXRHbG9iYWxHU0RQcmVmZXJlbmNlc1BhdGgoKTtcbiAgfVxufVxuXG4vKipcbiAqIFBlcnNpc3Qgd2lkZ2V0IG1vZGUgdG8gdGhlIHByZWZlcmVuY2UgZmlsZSB0aGF0IG93bnMgdGhlIGVmZmVjdGl2ZSB2YWx1ZS5cbiAqIFByb2plY3Qtc2NvcGVkIHdpZGdldF9tb2RlIHdpbnMgb3ZlciBnbG9iYWw7IGlmIG5laXRoZXIgc2NvcGUgZGVmaW5lcyBpdCxcbiAqIHdlIHByZWZlciBhbiBleGlzdGluZyBwcm9qZWN0IHByZWZlcmVuY2VzIGZpbGUgYW5kIG90aGVyd2lzZSBmYWxsIGJhY2sgdG9cbiAqIHRoZSBnbG9iYWwgcHJlZmVyZW5jZXMgZmlsZS5cbiAqL1xuZnVuY3Rpb24gcGVyc2lzdFdpZGdldE1vZGUoXG4gIG1vZGU6IFdpZGdldE1vZGUsXG4gIHByZWZzUGF0aCA9IHdpZGdldE1vZGVQcmVmZXJlbmNlUGF0aCA/PyByZXNvbHZlV2lkZ2V0TW9kZVByZWZlcmVuY2VQYXRoKCksXG4pOiB2b2lkIHtcbiAgdHJ5IHtcbiAgICBsZXQgY29udGVudCA9IFwiXCI7XG4gICAgaWYgKGV4aXN0c1N5bmMocHJlZnNQYXRoKSkge1xuICAgICAgY29udGVudCA9IHJlYWRGaWxlU3luYyhwcmVmc1BhdGgsIFwidXRmLThcIik7XG4gICAgfVxuICAgIGNvbnN0IGxpbmUgPSBgd2lkZ2V0X21vZGU6ICR7bW9kZX1gO1xuICAgIGNvbnN0IHJlID0gL153aWRnZXRfbW9kZTpcXHMqXFxTKy9tO1xuICAgIGlmIChyZS50ZXN0KGNvbnRlbnQpKSB7XG4gICAgICBjb250ZW50ID0gY29udGVudC5yZXBsYWNlKHJlLCBsaW5lKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29udGVudCA9IGNvbnRlbnQudHJpbUVuZCgpICsgXCJcXG5cIiArIGxpbmUgKyBcIlxcblwiO1xuICAgIH1cbiAgICB3cml0ZUZpbGVTeW5jKHByZWZzUGF0aCwgY29udGVudCwgXCJ1dGYtOFwiKTtcbiAgfSBjYXRjaCAoZXJyKSB7IC8qIG5vbi1mYXRhbCBcdTIwMTQgbW9kZSBzdGlsbCBzZXQgaW4gbWVtb3J5ICovXG4gICAgbG9nV2FybmluZyhcImRhc2hib2FyZFwiLCBgZmlsZSB3cml0ZSBmYWlsZWQ6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWApO1xuICB9XG59XG5cbi8qKiBDeWNsZSB0byB0aGUgbmV4dCB3aWRnZXQgbW9kZS4gUmV0dXJucyB0aGUgbmV3IG1vZGUuICovXG5leHBvcnQgZnVuY3Rpb24gY3ljbGVXaWRnZXRNb2RlKHByb2plY3RQYXRoPzogc3RyaW5nLCBnbG9iYWxQYXRoPzogc3RyaW5nKTogV2lkZ2V0TW9kZSB7XG4gIGVuc3VyZVdpZGdldE1vZGVMb2FkZWQocHJvamVjdFBhdGgsIGdsb2JhbFBhdGgpO1xuICBjb25zdCBpZHggPSBXSURHRVRfTU9ERVMuaW5kZXhPZih3aWRnZXRNb2RlKTtcbiAgd2lkZ2V0TW9kZSA9IFdJREdFVF9NT0RFU1soaWR4ICsgMSkgJSBXSURHRVRfTU9ERVMubGVuZ3RoXTtcbiAgcGVyc2lzdFdpZGdldE1vZGUod2lkZ2V0TW9kZSwgd2lkZ2V0TW9kZVByZWZlcmVuY2VQYXRoID8/IHJlc29sdmVXaWRnZXRNb2RlUHJlZmVyZW5jZVBhdGgocHJvamVjdFBhdGgsIGdsb2JhbFBhdGgpKTtcbiAgcmV0dXJuIHdpZGdldE1vZGU7XG59XG5cbi8qKiBTZXQgd2lkZ2V0IG1vZGUgZGlyZWN0bHkuICovXG5leHBvcnQgZnVuY3Rpb24gc2V0V2lkZ2V0TW9kZShtb2RlOiBXaWRnZXRNb2RlLCBwcm9qZWN0UGF0aD86IHN0cmluZywgZ2xvYmFsUGF0aD86IHN0cmluZyk6IHZvaWQge1xuICBlbnN1cmVXaWRnZXRNb2RlTG9hZGVkKHByb2plY3RQYXRoLCBnbG9iYWxQYXRoKTtcbiAgd2lkZ2V0TW9kZSA9IG1vZGU7XG4gIHBlcnNpc3RXaWRnZXRNb2RlKHdpZGdldE1vZGUsIHdpZGdldE1vZGVQcmVmZXJlbmNlUGF0aCA/PyByZXNvbHZlV2lkZ2V0TW9kZVByZWZlcmVuY2VQYXRoKHByb2plY3RQYXRoLCBnbG9iYWxQYXRoKSk7XG59XG5cbi8qKiBHZXQgY3VycmVudCB3aWRnZXQgbW9kZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRXaWRnZXRNb2RlKHByb2plY3RQYXRoPzogc3RyaW5nLCBnbG9iYWxQYXRoPzogc3RyaW5nKTogV2lkZ2V0TW9kZSB7XG4gIGVuc3VyZVdpZGdldE1vZGVMb2FkZWQocHJvamVjdFBhdGgsIGdsb2JhbFBhdGgpO1xuICByZXR1cm4gd2lkZ2V0TW9kZTtcbn1cblxuLyoqIFRlc3Qtb25seSByZXNldCBmb3Igd2lkZ2V0IG1vZGUgY2FjaGluZy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBfcmVzZXRXaWRnZXRNb2RlRm9yVGVzdHMoKTogdm9pZCB7XG4gIHdpZGdldE1vZGUgPSBcImZ1bGxcIjtcbiAgd2lkZ2V0TW9kZUluaXRpYWxpemVkID0gZmFsc2U7XG4gIHdpZGdldE1vZGVQcmVmZXJlbmNlUGF0aCA9IG51bGw7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBQcm9ncmVzcyBXaWRnZXQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKiBTdGF0ZSBhY2Nlc3NvcnMgcGFzc2VkIHRvIHVwZGF0ZVByb2dyZXNzV2lkZ2V0IHRvIGF2b2lkIGRpcmVjdCBnbG9iYWwgYWNjZXNzICovXG5leHBvcnQgaW50ZXJmYWNlIFdpZGdldFN0YXRlQWNjZXNzb3JzIHtcbiAgZ2V0QXV0b1N0YXJ0VGltZSgpOiBudW1iZXI7XG4gIGlzU3RlcE1vZGUoKTogYm9vbGVhbjtcbiAgZ2V0Q21kQ3R4KCk6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0IHwgbnVsbDtcbiAgZ2V0QmFzZVBhdGgoKTogc3RyaW5nO1xuICBpc1ZlcmJvc2UoKTogYm9vbGVhbjtcbiAgLyoqIFRydWUgd2hpbGUgbmV3U2Vzc2lvbigpIGlzIGluLWZsaWdodCBcdTIwMTQgcmVuZGVyIG11c3Qgbm90IGFjY2VzcyBzZXNzaW9uIHN0YXRlLiAqL1xuICBpc1Nlc3Npb25Td2l0Y2hpbmcoKTogYm9vbGVhbjtcbiAgLyoqIEZ1bGx5LXF1YWxpZmllZCBkaXNwYXRjaGVkIG1vZGVsIElEIChwcm92aWRlci9pZCkgc2V0IGFmdGVyIG1vZGVsIHNlbGVjdGlvbiArIGhvb2sgb3ZlcnJpZGVzICgjMjg5OSkuICovXG4gIGdldEN1cnJlbnREaXNwYXRjaGVkTW9kZWxJZCgpOiBzdHJpbmcgfCBudWxsO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdXBkYXRlUHJvZ3Jlc3NXaWRnZXQoXG4gIGN0eDogRXh0ZW5zaW9uQ29udGV4dCxcbiAgdW5pdFR5cGU6IHN0cmluZyxcbiAgdW5pdElkOiBzdHJpbmcsXG4gIHN0YXRlOiBHU0RTdGF0ZSxcbiAgYWNjZXNzb3JzOiBXaWRnZXRTdGF0ZUFjY2Vzc29ycyxcbiAgdGllckJhZGdlPzogc3RyaW5nLFxuKTogdm9pZCB7XG4gIGlmICghY3R4Lmhhc1VJKSByZXR1cm47XG4gIGN0eC51aS5zZXRXaWRnZXQoXCJnc2Qtb3V0Y29tZVwiLCB1bmRlZmluZWQpO1xuXG4gIC8vIFdlbGNvbWUgaGVhZGVyIGlzIGEgc3RhcnR1cC1vbmx5IGJhbm5lciBcdTIwMTQgcGVybWFuZW50bHkgc3VwcHJlc3MgaXQgb25jZVxuICAvLyBhdXRvLW1vZGUgYWN0aXZhdGVzLiBUaGUgZGFzaGJvYXJkIHdpZGdldCBvd25zIGFsbCBzdGF0dXMgZnJvbSBoZXJlLlxuICAvLyBOb3RlOiBzZXRIZWFkZXIodW5kZWZpbmVkKSByZXN0b3JlcyB0aGUgYnVpbHQtaW4gaGVhZGVyIChsb2dvICtcbiAgLy8gaW5zdHJ1Y3Rpb25zKS4gVG8gYWN0dWFsbHkgcmVuZGVyIHplcm8gbGluZXMsIGluc3RhbGwgYW4gZW1wdHkgaGVhZGVyLlxuICBpZiAodHlwZW9mIGN0eC51aT8uc2V0SGVhZGVyID09PSBcImZ1bmN0aW9uXCIpIHtcbiAgICBjdHgudWkuc2V0SGVhZGVyKCgpID0+ICh7XG4gICAgICByZW5kZXIoKTogc3RyaW5nW10geyByZXR1cm4gW107IH0sXG4gICAgICBpbnZhbGlkYXRlKCk6IHZvaWQge30sXG4gICAgfSkpO1xuICB9XG4gIC8vIENsZWFyIHdpemFyZCBzdGVwIGJhZGdlIFx1MjAxNCBhdXRvLW1vZGUgb3ducyB0aGUgVUkgZnJvbSB0aGlzIHBvaW50XG4gIGlmICh0eXBlb2YgY3R4LnVpPy5zZXRTdGF0dXMgPT09IFwiZnVuY3Rpb25cIikge1xuICAgIGN0eC51aS5zZXRTdGF0dXMoXCJnc2Qtc3RlcFwiLCB1bmRlZmluZWQpO1xuICB9XG5cbiAgY29uc3QgdmVyYiA9IHVuaXRWZXJiKHVuaXRUeXBlKTtcbiAgY29uc3QgcGhhc2VMYWJlbCA9IHVuaXRQaGFzZUxhYmVsKHVuaXRUeXBlKTtcbiAgY29uc3QgbWlkID0gc3RhdGUuYWN0aXZlTWlsZXN0b25lO1xuICBjb25zdCBpc0hvb2sgPSB1bml0VHlwZS5zdGFydHNXaXRoKFwiaG9vay9cIik7XG5cbiAgLy8gV2hlbiBydW4tdWF0IGlzIGV4ZWN1dGluZyBmb3IgYSBqdXN0LWNvbXBsZXRlZCBzbGljZSAoZS5nLiBTMDEpLFxuICAvLyBkZXJpdmVTdGF0ZSgpIGhhcyBhbHJlYWR5IGFkdmFuY2VkIGFjdGl2ZVNsaWNlIHRvIHRoZSBuZXh0IG9uZSAoUzAyKS5cbiAgLy8gT3ZlcnJpZGUgdGhlIGRpc3BsYXllZCBzbGljZSB0byBtYXRjaCB0aGUgVUFUIHRhcmdldCBmcm9tIHRoZSB1bml0IElELlxuICBjb25zdCB1YXRUYXJnZXRTbGljZUlkID0gdW5pdFR5cGUgPT09IFwicnVuLXVhdFwiID8gZXh0cmFjdFVhdFNsaWNlSWQodW5pdElkKSA6IG51bGw7XG4gIGNvbnN0IHNsaWNlID0gdWF0VGFyZ2V0U2xpY2VJZFxuICAgID8geyBpZDogdWF0VGFyZ2V0U2xpY2VJZCwgdGl0bGU6IHN0YXRlLmFjdGl2ZVNsaWNlPy50aXRsZSA/PyBcIlwiIH1cbiAgICA6IHN0YXRlLmFjdGl2ZVNsaWNlO1xuICBjb25zdCB0YXNrID0gc3RhdGUuYWN0aXZlVGFzaztcblxuICBpZiAobWlkKSB7XG4gICAgdXBkYXRlU2xpY2VQcm9ncmVzc0NhY2hlKGFjY2Vzc29ycy5nZXRCYXNlUGF0aCgpLCBtaWQuaWQsIHNsaWNlPy5pZCk7XG4gIH1cblxuICBjdHgudWkuc2V0V2lkZ2V0KFwiZ3NkLXByb2dyZXNzXCIsICh0dWksIHRoZW1lKSA9PiB7XG4gICAgbGV0IHB1bHNlQnJpZ2h0ID0gdHJ1ZTtcbiAgICBsZXQgY2FjaGVkTGluZXM6IHN0cmluZ1tdIHwgdW5kZWZpbmVkO1xuICAgIGxldCBjYWNoZWRXaWR0aDogbnVtYmVyIHwgdW5kZWZpbmVkO1xuICAgIGxldCBjYWNoZWRSdW50aW1lUmVjb3JkOiBBdXRvVW5pdFJ1bnRpbWVSZWNvcmQgfCBudWxsID0gbnVsbDtcblxuICAgIGNvbnN0IHJlZnJlc2hSdW50aW1lUmVjb3JkID0gKCk6IHZvaWQgPT4ge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY2FjaGVkUnVudGltZVJlY29yZCA9IHJlYWRVbml0UnVudGltZVJlY29yZChhY2Nlc3NvcnMuZ2V0QmFzZVBhdGgoKSwgdW5pdFR5cGUsIHVuaXRJZCk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgY2FjaGVkUnVudGltZVJlY29yZCA9IG51bGw7XG4gICAgICB9XG4gICAgfTtcblxuICAgIHJlZnJlc2hSdW50aW1lUmVjb3JkKCk7XG5cbiAgICBjb25zdCBwdWxzZVRpbWVyID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgICAgcHVsc2VCcmlnaHQgPSAhcHVsc2VCcmlnaHQ7XG4gICAgICBjYWNoZWRMaW5lcyA9IHVuZGVmaW5lZDtcbiAgICAgIHR1aS5yZXF1ZXN0UmVuZGVyKCk7XG4gICAgfSwgODAwKTtcblxuICAgIC8vIFJlZnJlc2ggcHJvZ3Jlc3MgY2FjaGUgZnJvbSBkaXNrIGV2ZXJ5IDE1cyBzbyB0aGUgd2lkZ2V0IHJlZmxlY3RzXG4gICAgLy8gdGFzay9zbGljZSBjb21wbGV0aW9uIG1pZC11bml0LiBXaXRob3V0IHRoaXMsIHRoZSBwcm9ncmVzcyBiYXIgb25seVxuICAgIC8vIHVwZGF0ZXMgYXQgZGlzcGF0Y2ggdGltZSwgYXBwZWFyaW5nIGZyb3plbiBkdXJpbmcgbG9uZy1ydW5uaW5nIHVuaXRzLlxuICAgIC8vIDE1cyAodnMgNXMpIHJlZHVjZXMgc3luY2hyb25vdXMgZmlsZSBJL08gb24gdGhlIGhvdCBwYXRoLlxuICAgIGNvbnN0IHByb2dyZXNzUmVmcmVzaFRpbWVyID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgICAgdHJ5IHtcbiAgICAgICAgaWYgKG1pZCkge1xuICAgICAgICAgIHVwZGF0ZVNsaWNlUHJvZ3Jlc3NDYWNoZShhY2Nlc3NvcnMuZ2V0QmFzZVBhdGgoKSwgbWlkLmlkLCBzbGljZT8uaWQpO1xuICAgICAgICB9XG4gICAgICAgIHJlZnJlc2hSdW50aW1lUmVjb3JkKCk7XG4gICAgICAgIGNhY2hlZExpbmVzID0gdW5kZWZpbmVkO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7IC8qIG5vbi1mYXRhbCAqL1xuICAgICAgICBsb2dXYXJuaW5nKFwiZGFzaGJvYXJkXCIsIGBEQiBzdGF0dXMgdXBkYXRlIGZhaWxlZDogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCk7XG4gICAgICB9XG4gICAgfSwgMTVfMDAwKTtcblxuICAgIHJldHVybiB7XG4gICAgICByZW5kZXIod2lkdGg6IG51bWJlcik6IHN0cmluZ1tdIHtcbiAgICAgICAgaWYgKGNhY2hlZExpbmVzICYmIGNhY2hlZFdpZHRoID09PSB3aWR0aCkgcmV0dXJuIGNhY2hlZExpbmVzO1xuXG4gICAgICAgIC8vIFdoaWxlIG5ld1Nlc3Npb24oKSBpcyBpbi1mbGlnaHQsIHNlc3Npb24gc3RhdGUgaXMgbWlkLW11dGF0aW9uLlxuICAgICAgICAvLyBBY2Nlc3NpbmcgY21kQ3R4LnNlc3Npb25NYW5hZ2VyIG9yIGNtZEN0eC5nZXRDb250ZXh0VXNhZ2UoKSBjYW5cbiAgICAgICAgLy8gYmxvY2sgdGhlIHJlbmRlciBsb29wIGFuZCBmcmVlemUgdGhlIFRVSS4gUmV0dXJuIHRoZSBsYXN0IGNhY2hlZFxuICAgICAgICAvLyBmcmFtZSAob3IgYW4gZW1wdHkgZnJhbWUgb24gZmlyc3QgcmVuZGVyKSB1bnRpbCB0aGUgc3dpdGNoIHNldHRsZXMuXG4gICAgICAgIGlmIChhY2Nlc3NvcnMuaXNTZXNzaW9uU3dpdGNoaW5nKCkpIHtcbiAgICAgICAgICByZXR1cm4gY2FjaGVkTGluZXMgPz8gW107XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCB1aSA9IG1ha2VVSSh0aGVtZSwgd2lkdGgpO1xuICAgICAgICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcbiAgICAgICAgY29uc3QgcGFkID0gSU5ERU5ULmJhc2U7XG5cbiAgICAgICAgLy8gXHUyNTAwXHUyNTAwIExpbmUgMTogVG9wIGJhciBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgICAgICAgbGluZXMucHVzaCguLi51aS5iYXIoKSk7XG5cbiAgICAgICAgY29uc3QgZG90ID0gcHVsc2VCcmlnaHRcbiAgICAgICAgICA/IHRoZW1lLmZnKFwiYWNjZW50XCIsIEdMWVBILnN0YXR1c0FjdGl2ZSlcbiAgICAgICAgICA6IHRoZW1lLmZnKFwiZGltXCIsIEdMWVBILnN0YXR1c1BlbmRpbmcpO1xuICAgICAgICBjb25zdCBlbGFwc2VkID0gZm9ybWF0QXV0b0VsYXBzZWQoYWNjZXNzb3JzLmdldEF1dG9TdGFydFRpbWUoKSk7XG4gICAgICAgIGNvbnN0IG1vZGVUYWcgPSBhY2Nlc3NvcnMuaXNTdGVwTW9kZSgpID8gXCJORVhUXCIgOiBcIkFVVE9cIjtcblxuICAgICAgICAvLyBIZWFsdGggaW5kaWNhdG9yIGluIGhlYWRlclxuICAgICAgICBjb25zdCBzY29yZSA9IGNvbXB1dGVQcm9ncmVzc1Njb3JlKCk7XG4gICAgICAgIGNvbnN0IHJ1bnRpbWVTaWduYWwgPSBmb3JtYXRSdW50aW1lSGVhbHRoU2lnbmFsKGNhY2hlZFJ1bnRpbWVSZWNvcmQpO1xuICAgICAgICBjb25zdCBoZWFsdGhMZXZlbCA9IHJ1bnRpbWVTaWduYWw/LmxldmVsID8/IHNjb3JlLmxldmVsO1xuICAgICAgICBjb25zdCBoZWFsdGhTdW1tYXJ5ID0gcnVudGltZVNpZ25hbD8uc3VtbWFyeSA/PyBzY29yZS5zdW1tYXJ5O1xuICAgICAgICBjb25zdCBoZWFsdGhDb2xvciA9IGhlYWx0aExldmVsID09PSBcImdyZWVuXCIgPyBcInN1Y2Nlc3NcIlxuICAgICAgICAgIDogaGVhbHRoTGV2ZWwgPT09IFwieWVsbG93XCIgPyBcIndhcm5pbmdcIlxuICAgICAgICAgICAgOiBcImVycm9yXCI7XG4gICAgICAgIGNvbnN0IGhlYWx0aEljb24gPSBoZWFsdGhMZXZlbCA9PT0gXCJncmVlblwiID8gR0xZUEguc3RhdHVzQWN0aXZlXG4gICAgICAgICAgOiBoZWFsdGhMZXZlbCA9PT0gXCJ5ZWxsb3dcIiA/IFwiIVwiXG4gICAgICAgICAgICA6IFwieFwiO1xuICAgICAgICBjb25zdCBoZWFsdGhTdHIgPSBgICAke3RoZW1lLmZnKGhlYWx0aENvbG9yLCBoZWFsdGhJY29uKX0gJHt0aGVtZS5mZyhoZWFsdGhDb2xvciwgaGVhbHRoU3VtbWFyeSl9YDtcblxuICAgICAgICBjb25zdCBoZWFkZXJMZWZ0ID0gYCR7cGFkfSR7ZG90fSAke3RoZW1lLmZnKFwiYWNjZW50XCIsIHRoZW1lLmJvbGQoXCJHU0RcIikpfSAgJHt0aGVtZS5mZyhcInN1Y2Nlc3NcIiwgbW9kZVRhZyl9JHtoZWFsdGhTdHJ9YDtcblxuICAgICAgICAvLyBFVEEgaW4gaGVhZGVyIHJpZ2h0LCBhZnRlciBlbGFwc2VkXG4gICAgICAgIGNvbnN0IGV0YSA9IGVzdGltYXRlVGltZVJlbWFpbmluZygpO1xuICAgICAgICBjb25zdCBldGFTaG9ydCA9IGV0YSA/IGV0YS5yZXBsYWNlKFwiIHJlbWFpbmluZ1wiLCBcIiBsZWZ0XCIpIDogbnVsbDtcbiAgICAgICAgY29uc3QgaGVhZGVyUmlnaHQgPSBlbGFwc2VkXG4gICAgICAgICAgPyAoZXRhU2hvcnRcbiAgICAgICAgICAgID8gYCR7dGhlbWUuZmcoXCJkaW1cIiwgZWxhcHNlZCl9ICR7dGhlbWUuZmcoXCJkaW1cIiwgXCJcdTAwQjdcIil9ICR7dGhlbWUuZmcoXCJkaW1cIiwgZXRhU2hvcnQpfWBcbiAgICAgICAgICAgIDogdGhlbWUuZmcoXCJkaW1cIiwgZWxhcHNlZCkpXG4gICAgICAgICAgOiBcIlwiO1xuICAgICAgICBsaW5lcy5wdXNoKHJpZ2h0QWxpZ24oaGVhZGVyTGVmdCwgaGVhZGVyUmlnaHQsIHdpZHRoKSk7XG5cbiAgICAgICAgLy8gU2hvdyBoZWFsdGggc2lnbmFsIGRldGFpbHMgd2hlbiBkZWdyYWRlZCAoeWVsbG93L3JlZClcbiAgICAgICAgaWYgKHJ1bnRpbWVTaWduYWw/LmRldGFpbCAmJiB3aWRnZXRNb2RlICE9PSBcIm1pblwiKSB7XG4gICAgICAgICAgbGluZXMucHVzaChgJHtwYWR9ICAke3RoZW1lLmZnKFwiZGltXCIsIHJ1bnRpbWVTaWduYWwuZGV0YWlsKX1gKTtcbiAgICAgICAgfSBlbHNlIGlmIChzY29yZS5sZXZlbCAhPT0gXCJncmVlblwiICYmIHNjb3JlLnNpZ25hbHMubGVuZ3RoID4gMCAmJiB3aWRnZXRNb2RlICE9PSBcIm1pblwiKSB7XG4gICAgICAgICAgLy8gU2hvdyB1cCB0byAzIG1vc3QgcmVsZXZhbnQgc2lnbmFscyBpbiBjb21wYWN0IGZvcm1cbiAgICAgICAgICBjb25zdCB0b3BTaWduYWxzID0gc2NvcmUuc2lnbmFsc1xuICAgICAgICAgICAgLmZpbHRlcihzID0+IHMua2luZCA9PT0gXCJuZWdhdGl2ZVwiKVxuICAgICAgICAgICAgLnNsaWNlKDAsIDMpO1xuICAgICAgICAgIGlmICh0b3BTaWduYWxzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIGNvbnN0IHNpZ25hbFN0ciA9IHRvcFNpZ25hbHNcbiAgICAgICAgICAgICAgLm1hcChzID0+IHRoZW1lLmZnKFwiZGltXCIsIHMubGFiZWwpKVxuICAgICAgICAgICAgICAuam9pbih0aGVtZS5mZyhcImRpbVwiLCBcIiBcdTAwQjcgXCIpKTtcbiAgICAgICAgICAgIGxpbmVzLnB1c2goYCR7cGFkfSAgJHtzaWduYWxTdHJ9YCk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gXHUyNTAwXHUyNTAwIE1vZGU6IG9mZiBcdTIwMTQgcmV0dXJuIGVtcHR5IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgICAgICBpZiAod2lkZ2V0TW9kZSA9PT0gXCJvZmZcIikge1xuICAgICAgICAgIGNhY2hlZExpbmVzID0gW107XG4gICAgICAgICAgY2FjaGVkV2lkdGggPSB3aWR0aDtcbiAgICAgICAgICByZXR1cm4gW107XG4gICAgICAgIH1cblxuICAgICAgICAvLyBcdTI1MDBcdTI1MDAgTW9kZTogbWluIFx1MjAxNCBoZWFkZXIgbGluZSBvbmx5IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgICAgICBpZiAod2lkZ2V0TW9kZSA9PT0gXCJtaW5cIikge1xuICAgICAgICAgIGxpbmVzLnB1c2goLi4udWkuYmFyKCkpO1xuICAgICAgICAgIGNhY2hlZExpbmVzID0gbGluZXM7XG4gICAgICAgICAgY2FjaGVkV2lkdGggPSB3aWR0aDtcbiAgICAgICAgICByZXR1cm4gbGluZXM7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBcdTI1MDBcdTI1MDAgTW9kZTogc21hbGwgXHUyMDE0IGhlYWRlciArIGFjdGl2ZSB3b3JrIHByb2dyZXNzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgICAgICBpZiAod2lkZ2V0TW9kZSA9PT0gXCJzbWFsbFwiKSB7XG4gICAgICAgICAgbGluZXMucHVzaChcIlwiKTtcblxuICAgICAgICAgIC8vIEFjdGlvbiBsaW5lXG4gICAgICAgICAgY29uc3QgdGFyZ2V0ID0gdGFzayA/IGAke3Rhc2suaWR9OiAke3Rhc2sudGl0bGV9YCA6IHVuaXRJZDtcbiAgICAgICAgICBjb25zdCBhY3Rpb25MZWZ0ID0gYCR7cGFkfSR7dGhlbWUuZmcoXCJhY2NlbnRcIiwgXCJcdTI1QjhcIil9ICR7dGhlbWUuZmcoXCJhY2NlbnRcIiwgdmVyYil9ICAke3RoZW1lLmZnKFwidGV4dFwiLCB0YXJnZXQpfWA7XG4gICAgICAgICAgbGluZXMucHVzaChyaWdodEFsaWduKGFjdGlvbkxlZnQsIHRoZW1lLmZnKFwiZGltXCIsIHBoYXNlTGFiZWwpLCB3aWR0aCkpO1xuXG4gICAgICAgICAgLy8gUHJvZ3Jlc3MgYmFyXG4gICAgICAgICAgY29uc3Qgcm9hZG1hcFNsaWNlcyA9IG1pZCA/IGdldFJvYWRtYXBTbGljZXNTeW5jKCkgOiBudWxsO1xuICAgICAgICAgIGlmIChzaG91bGRSZW5kZXJSb2FkbWFwUHJvZ3Jlc3Mocm9hZG1hcFNsaWNlcykpIHtcbiAgICAgICAgICAgIGNvbnN0IHsgZG9uZSwgdG90YWwsIGFjdGl2ZVNsaWNlVGFza3MgfSA9IHJvYWRtYXBTbGljZXM7XG4gICAgICAgICAgICBjb25zdCBiYXJXaWR0aCA9IE1hdGgubWF4KDYsIE1hdGgubWluKDE4LCBNYXRoLmZsb29yKHdpZHRoICogMC4yNSkpKTtcbiAgICAgICAgICAgIGNvbnN0IGJhciA9IHJlbmRlclByb2dyZXNzQmFyKHRoZW1lLCBkb25lLCB0b3RhbCwgYmFyV2lkdGgpO1xuICAgICAgICAgICAgbGV0IG1ldGEgPSBgJHt0aGVtZS5mZyhcInRleHRcIiwgYCR7ZG9uZX1gKX0ke3RoZW1lLmZnKFwiZGltXCIsIGAvJHt0b3RhbH0gc2xpY2VzYCl9YDtcbiAgICAgICAgICAgIGlmIChhY3RpdmVTbGljZVRhc2tzICYmIGFjdGl2ZVNsaWNlVGFza3MudG90YWwgPiAwKSB7XG4gICAgICAgICAgICAgIGNvbnN0IHRuID0gTWF0aC5taW4oYWN0aXZlU2xpY2VUYXNrcy5kb25lICsgMSwgYWN0aXZlU2xpY2VUYXNrcy50b3RhbCk7XG4gICAgICAgICAgICAgIG1ldGEgKz0gYCR7dGhlbWUuZmcoXCJkaW1cIiwgXCIgXHUwMEI3IHRhc2sgXCIpfSR7dGhlbWUuZmcoXCJhY2NlbnRcIiwgYCR7dG59YCl9JHt0aGVtZS5mZyhcImRpbVwiLCBgLyR7YWN0aXZlU2xpY2VUYXNrcy50b3RhbH1gKX1gO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgbGluZXMucHVzaChgJHtwYWR9JHtiYXJ9ICR7bWV0YX1gKTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBsaW5lcy5wdXNoKC4uLnVpLmJhcigpKTtcbiAgICAgICAgICBjYWNoZWRMaW5lcyA9IGxpbmVzO1xuICAgICAgICAgIGNhY2hlZFdpZHRoID0gd2lkdGg7XG4gICAgICAgICAgcmV0dXJuIGxpbmVzO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gXHUyNTAwXHUyNTAwIE1vZGU6IGZ1bGwgXHUyMDE0IGNvbXBsZXRlIHR3by1jb2x1bW4gbGF5b3V0IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgICAgICBsaW5lcy5wdXNoKFwiXCIpO1xuXG4gICAgICAgIC8vIENvbnRleHQgc2VjdGlvbjogbWlsZXN0b25lICsgc2xpY2UuIEZvb3RlciBvd25zIG1vZGVsL2Nvc3QvY29udGV4dC5cbiAgICAgICAgY29uc3QgaGFzQ29udGV4dCA9ICEhKG1pZCB8fCAoc2xpY2UgJiYgdW5pdFR5cGUgIT09IFwicmVzZWFyY2gtbWlsZXN0b25lXCIgJiYgdW5pdFR5cGUgIT09IFwicGxhbi1taWxlc3RvbmVcIikpO1xuICAgICAgICBpZiAobWlkKSB7XG4gICAgICAgICAgbGluZXMucHVzaCh0cnVuY2F0ZVRvV2lkdGgoYCR7cGFkfSR7dGhlbWUuZmcoXCJkaW1cIiwgbWlkLnRpdGxlKX1gLCB3aWR0aCwgXCJcdTIwMjZcIikpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChzbGljZSAmJiB1bml0VHlwZSAhPT0gXCJyZXNlYXJjaC1taWxlc3RvbmVcIiAmJiB1bml0VHlwZSAhPT0gXCJwbGFuLW1pbGVzdG9uZVwiKSB7XG4gICAgICAgICAgbGluZXMucHVzaCh0cnVuY2F0ZVRvV2lkdGgoXG4gICAgICAgICAgICBgJHtwYWR9JHt0aGVtZS5mZyhcInRleHRcIiwgdGhlbWUuYm9sZChgJHtzbGljZS5pZH06ICR7c2xpY2UudGl0bGV9YCkpfWAsXG4gICAgICAgICAgICB3aWR0aCwgXCJcdTIwMjZcIixcbiAgICAgICAgICApKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoaGFzQ29udGV4dCkgbGluZXMucHVzaChcIlwiKTtcblxuICAgICAgICBjb25zdCB0YXJnZXQgPSB0YXNrID8gYCR7dGFzay5pZH06ICR7dGFzay50aXRsZX1gIDogdW5pdElkO1xuICAgICAgICBjb25zdCBhY3Rpb25MZWZ0ID0gYCR7cGFkfSR7dGhlbWUuZmcoXCJhY2NlbnRcIiwgXCJcdTI1QjhcIil9ICR7dGhlbWUuZmcoXCJhY2NlbnRcIiwgdmVyYil9ICAke3RoZW1lLmZnKFwidGV4dFwiLCB0YXJnZXQpfWA7XG4gICAgICAgIGNvbnN0IHRpZXJUYWcgPSB0aWVyQmFkZ2UgPyB0aGVtZS5mZyhcImRpbVwiLCBgWyR7dGllckJhZGdlfV0gYCkgOiBcIlwiO1xuICAgICAgICBjb25zdCBwaGFzZUJhZGdlID0gYCR7dGllclRhZ30ke3RoZW1lLmZnKFwiZGltXCIsIHBoYXNlTGFiZWwpfWA7XG4gICAgICAgIGxpbmVzLnB1c2gocmlnaHRBbGlnbihhY3Rpb25MZWZ0LCBwaGFzZUJhZGdlLCB3aWR0aCkpO1xuXG4gICAgICAgIGxpbmVzLnB1c2goXCJcIik7XG5cbiAgICAgICAgLy8gVHdvLWNvbHVtbiBib2R5XG4gICAgICAgIGNvbnN0IG1pblR3b0NvbFdpZHRoID0gNzY7XG4gICAgICAgIGNvbnN0IHJvYWRtYXBTbGljZXMgPSBtaWQgPyBnZXRSb2FkbWFwU2xpY2VzU3luYygpIDogbnVsbDtcbiAgICAgICAgY29uc3QgdGFza0RldGFpbHNDb2wgPSByb2FkbWFwU2xpY2VzPy50YXNrRGV0YWlscyA/PyBudWxsO1xuICAgICAgICBjb25zdCB1c2VUd29Db2wgPSB3aWR0aCA+PSBtaW5Ud29Db2xXaWR0aCAmJiB0YXNrRGV0YWlsc0NvbCAhPT0gbnVsbCAmJiB0YXNrRGV0YWlsc0NvbC5sZW5ndGggPiAwO1xuICAgICAgICBjb25zdCBsZWZ0Q29sV2lkdGggPSB1c2VUd29Db2xcbiAgICAgICAgICA/IE1hdGguZmxvb3Iod2lkdGggKiAod2lkdGggPj0gMTAwID8gMC40NSA6IDAuNTApKVxuICAgICAgICAgIDogd2lkdGg7XG5cbiAgICAgICAgY29uc3QgbGVmdExpbmVzOiBzdHJpbmdbXSA9IFtdO1xuXG4gICAgICAgIGlmIChzaG91bGRSZW5kZXJSb2FkbWFwUHJvZ3Jlc3Mocm9hZG1hcFNsaWNlcykpIHtcbiAgICAgICAgICBjb25zdCB7IGRvbmUsIHRvdGFsLCBhY3RpdmVTbGljZVRhc2tzIH0gPSByb2FkbWFwU2xpY2VzO1xuICAgICAgICAgIGNvbnN0IGJhcldpZHRoID0gTWF0aC5tYXgoNiwgTWF0aC5taW4oMTgsIE1hdGguZmxvb3IobGVmdENvbFdpZHRoICogMC40KSkpO1xuICAgICAgICAgIGNvbnN0IGJhciA9IHJlbmRlclByb2dyZXNzQmFyKHRoZW1lLCBkb25lLCB0b3RhbCwgYmFyV2lkdGgpO1xuXG4gICAgICAgICAgbGV0IG1ldGEgPSBgJHt0aGVtZS5mZyhcInRleHRcIiwgYCR7ZG9uZX1gKX0ke3RoZW1lLmZnKFwiZGltXCIsIGAvJHt0b3RhbH0gc2xpY2VzYCl9YDtcbiAgICAgICAgICBpZiAoYWN0aXZlU2xpY2VUYXNrcyAmJiBhY3RpdmVTbGljZVRhc2tzLnRvdGFsID4gMCkge1xuICAgICAgICAgICAgY29uc3QgdGFza051bSA9IGlzSG9va1xuICAgICAgICAgICAgICA/IE1hdGgubWF4KGFjdGl2ZVNsaWNlVGFza3MuZG9uZSwgMSlcbiAgICAgICAgICAgICAgOiBNYXRoLm1pbihhY3RpdmVTbGljZVRhc2tzLmRvbmUgKyAxLCBhY3RpdmVTbGljZVRhc2tzLnRvdGFsKTtcbiAgICAgICAgICAgIG1ldGEgKz0gYCR7dGhlbWUuZmcoXCJkaW1cIiwgXCIgXHUwMEI3IHRhc2sgXCIpfSR7dGhlbWUuZmcoXCJhY2NlbnRcIiwgYCR7dGFza051bX1gKX0ke3RoZW1lLmZnKFwiZGltXCIsIGAvJHthY3RpdmVTbGljZVRhc2tzLnRvdGFsfWApfWA7XG4gICAgICAgICAgfVxuICAgICAgICAgIGxlZnRMaW5lcy5wdXNoKGAke3BhZH0ke2Jhcn0gJHttZXRhfWApO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gQnVpbGQgcmlnaHQgY29sdW1uOiB0YXNrIGNoZWNrbGlzdFxuICAgICAgICBjb25zdCByaWdodExpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgICBjb25zdCBtYXhWaXNpYmxlVGFza3MgPSA4O1xuXG4gICAgICAgIC8vIE1heCB2aXNpYmxlIGNoYXJzIGZvciB0YXNrIHRpdGxlIHRleHQgKGJlZm9yZSBBTlNJIHRoZW1pbmcpXG4gICAgICAgIGNvbnN0IG1heFRhc2tUaXRsZUxlbiA9IDQ1O1xuICAgICAgICBmdW5jdGlvbiB0cnVuY1RpdGxlKHM6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgICAgICAgcmV0dXJuIHMubGVuZ3RoID4gbWF4VGFza1RpdGxlTGVuID8gcy5zbGljZSgwLCBtYXhUYXNrVGl0bGVMZW4gLSAxKSArIFwiXHUyMDI2XCIgOiBzO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gZm9ybWF0VGFza0xpbmUodDogeyBpZDogc3RyaW5nOyB0aXRsZTogc3RyaW5nOyBkb25lOiBib29sZWFuIH0sIGlzQ3VycmVudDogYm9vbGVhbik6IHN0cmluZyB7XG4gICAgICAgICAgY29uc3QgZ2x5cGggPSB0LmRvbmVcbiAgICAgICAgICAgID8gdGhlbWUuZmcoXCJzdWNjZXNzXCIsIFwiKlwiKVxuICAgICAgICAgICAgOiBpc0N1cnJlbnRcbiAgICAgICAgICAgICAgPyB0aGVtZS5mZyhcImFjY2VudFwiLCBcIj5cIilcbiAgICAgICAgICAgICAgOiB0aGVtZS5mZyhcImRpbVwiLCBcIi5cIik7XG4gICAgICAgICAgY29uc3QgaWQgPSBpc0N1cnJlbnRcbiAgICAgICAgICAgID8gdGhlbWUuZmcoXCJhY2NlbnRcIiwgdC5pZClcbiAgICAgICAgICAgIDogdC5kb25lXG4gICAgICAgICAgICAgID8gdGhlbWUuZmcoXCJtdXRlZFwiLCB0LmlkKVxuICAgICAgICAgICAgICA6IHRoZW1lLmZnKFwiZGltXCIsIHQuaWQpO1xuICAgICAgICAgIGNvbnN0IHNob3J0ID0gdHJ1bmNUaXRsZSh0LnRpdGxlKTtcbiAgICAgICAgICBjb25zdCB0aXRsZSA9IGlzQ3VycmVudFxuICAgICAgICAgICAgPyB0aGVtZS5mZyhcInRleHRcIiwgc2hvcnQpXG4gICAgICAgICAgICA6IHQuZG9uZVxuICAgICAgICAgICAgICA/IHRoZW1lLmZnKFwibXV0ZWRcIiwgc2hvcnQpXG4gICAgICAgICAgICAgIDogdGhlbWUuZmcoXCJ0ZXh0XCIsIHNob3J0KTtcbiAgICAgICAgICByZXR1cm4gYCR7Z2x5cGh9ICR7aWR9OiAke3RpdGxlfWA7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodXNlVHdvQ29sICYmIHRhc2tEZXRhaWxzQ29sKSB7XG4gICAgICAgICAgZm9yIChjb25zdCB0IG9mIHRhc2tEZXRhaWxzQ29sLnNsaWNlKDAsIG1heFZpc2libGVUYXNrcykpIHtcbiAgICAgICAgICAgIHJpZ2h0TGluZXMucHVzaChmb3JtYXRUYXNrTGluZSh0LCAhISh0YXNrICYmIHQuaWQgPT09IHRhc2suaWQpKSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmICh0YXNrRGV0YWlsc0NvbC5sZW5ndGggPiBtYXhWaXNpYmxlVGFza3MpIHtcbiAgICAgICAgICAgIHJpZ2h0TGluZXMucHVzaCh0aGVtZS5mZyhcImRpbVwiLCBgICArJHt0YXNrRGV0YWlsc0NvbC5sZW5ndGggLSBtYXhWaXNpYmxlVGFza3N9IG1vcmVgKSk7XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2UgaWYgKCF1c2VUd29Db2wgJiYgdGFza0RldGFpbHNDb2wgJiYgdGFza0RldGFpbHNDb2wubGVuZ3RoID4gMCkge1xuICAgICAgICAgIGZvciAoY29uc3QgdCBvZiB0YXNrRGV0YWlsc0NvbC5zbGljZSgwLCBtYXhWaXNpYmxlVGFza3MpKSB7XG4gICAgICAgICAgICBsZWZ0TGluZXMucHVzaChgJHtwYWR9JHtmb3JtYXRUYXNrTGluZSh0LCAhISh0YXNrICYmIHQuaWQgPT09IHRhc2suaWQpKX1gKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvLyBDb21wb3NlIGNvbHVtbnNcbiAgICAgICAgaWYgKHVzZVR3b0NvbCkge1xuICAgICAgICAgIGNvbnN0IG1heFJvd3MgPSBNYXRoLm1heChsZWZ0TGluZXMubGVuZ3RoLCByaWdodExpbmVzLmxlbmd0aCk7XG4gICAgICAgICAgaWYgKG1heFJvd3MgPiAwKSB7XG4gICAgICAgICAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICAgICAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBtYXhSb3dzOyBpKyspIHtcbiAgICAgICAgICAgICAgY29uc3QgbGVmdCA9IHBhZFJpZ2h0VmlzaWJsZSh0cnVuY2F0ZVRvV2lkdGgobGVmdExpbmVzW2ldID8/IFwiXCIsIGxlZnRDb2xXaWR0aCwgXCJcdTIwMjZcIiksIGxlZnRDb2xXaWR0aCk7XG4gICAgICAgICAgICAgIGNvbnN0IHJpZ2h0ID0gcmlnaHRMaW5lc1tpXSA/PyBcIlwiO1xuICAgICAgICAgICAgICBsaW5lcy5wdXNoKGAke2xlZnR9JHtyaWdodH1gKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgaWYgKGxlZnRMaW5lcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICAgICAgICAgICAgZm9yIChjb25zdCBsIG9mIGxlZnRMaW5lcykgbGluZXMucHVzaCh0cnVuY2F0ZVRvV2lkdGgobCwgd2lkdGgsIFwiXHUyMDI2XCIpKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvLyBcdTI1MDBcdTI1MDAgQXV0byBjb250cm9scy4gRm9vdGVyIG93bnMgY3dkL2JyYW5jaC9tb2RlbC9jb3N0L2NvbnRleHQuIFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgICAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICAgICAgICAvLyBTdGVwLW1vZGUgZ3VpZGFuY2UgXHUyMDE0IHNob3duIGFib3ZlIGtleWJvYXJkIGhpbnRzIHdoZW4gYXV0byBpcyBwYXVzZWRcbiAgICAgICAgaWYgKGFjY2Vzc29ycy5pc1N0ZXBNb2RlKCkpIHtcbiAgICAgICAgICBsaW5lcy5wdXNoKGAke3BhZH0ke3RoZW1lLmZnKFwiYWNjZW50XCIsIFwiXHUyMTkyXCIpfSAke3RoZW1lLmZnKFwiZGltXCIsIFwiQ3RybCtOIHRvIGFkdmFuY2UgdG8gbmV4dCBzdGVwICBcdTAwQjcgIC9nc2Qgc3RhdHVzIGZvciBvdmVydmlld1wiKX1gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEhpbnRzIGxpbmVcbiAgICAgICAgY29uc3QgaGludFBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgICBoaW50UGFydHMucHVzaChcImVzYyBwYXVzZVwiKTtcbiAgICAgICAgaGludFBhcnRzLnB1c2goYCR7Zm9ybWF0dGVkU2hvcnRjdXRQYWlyKFwiZGFzaGJvYXJkXCIpfSBkYXNoYm9hcmRgKTtcbiAgICAgICAgaGludFBhcnRzLnB1c2goYCR7Zm9ybWF0dGVkU2hvcnRjdXRQYWlyKFwicGFyYWxsZWxcIil9IHBhcmFsbGVsYCk7XG4gICAgICAgIGNvbnN0IGhpbnRTdHIgPSB0aGVtZS5mZyhcImRpbVwiLCBoaW50UGFydHMuam9pbihcIiB8IFwiKSk7XG4gICAgICAgIGxpbmVzLnB1c2gocmlnaHRBbGlnbihcIlwiLCBoaW50U3RyLCB3aWR0aCkpO1xuXG4gICAgICAgIGxpbmVzLnB1c2goLi4udWkuYmFyKCkpO1xuXG4gICAgICAgIGNhY2hlZExpbmVzID0gbGluZXM7XG4gICAgICAgIGNhY2hlZFdpZHRoID0gd2lkdGg7XG4gICAgICAgIHJldHVybiBsaW5lcztcbiAgICAgIH0sXG4gICAgICBpbnZhbGlkYXRlKCkge1xuICAgICAgICBjYWNoZWRMaW5lcyA9IHVuZGVmaW5lZDtcbiAgICAgICAgY2FjaGVkV2lkdGggPSB1bmRlZmluZWQ7XG4gICAgICB9LFxuICAgICAgZGlzcG9zZSgpIHtcbiAgICAgICAgY2xlYXJJbnRlcnZhbChwdWxzZVRpbWVyKTtcbiAgICAgICAgaWYgKHByb2dyZXNzUmVmcmVzaFRpbWVyKSBjbGVhckludGVydmFsKHByb2dyZXNzUmVmcmVzaFRpbWVyKTtcbiAgICAgIH0sXG4gICAgfTtcbiAgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRDb21wbGV0aW9uUHJvZ3Jlc3NXaWRnZXQoXG4gIGN0eDogRXh0ZW5zaW9uQ29udGV4dCxcbiAgc25hcHNob3Q6IENvbXBsZXRpb25EYXNoYm9hcmRTbmFwc2hvdCxcbik6IHZvaWQge1xuICBpZiAoIWN0eC5oYXNVSSkgcmV0dXJuO1xuICBjdHgudWkuc2V0V2lkZ2V0KFwiZ3NkLW91dGNvbWVcIiwgdW5kZWZpbmVkKTtcblxuICBpZiAodHlwZW9mIGN0eC51aT8uc2V0SGVhZGVyID09PSBcImZ1bmN0aW9uXCIpIHtcbiAgICBjdHgudWkuc2V0SGVhZGVyKCgpID0+ICh7XG4gICAgICByZW5kZXIoKTogc3RyaW5nW10geyByZXR1cm4gW107IH0sXG4gICAgICBpbnZhbGlkYXRlKCk6IHZvaWQge30sXG4gICAgfSkpO1xuICB9XG4gIGlmICh0eXBlb2YgY3R4LnVpPy5zZXRTdGF0dXMgPT09IFwiZnVuY3Rpb25cIikge1xuICAgIGN0eC51aS5zZXRTdGF0dXMoXCJnc2Qtc3RlcFwiLCB1bmRlZmluZWQpO1xuICB9XG5cbiAgY3R4LnVpLnNldFdpZGdldChcImdzZC1wcm9ncmVzc1wiLCAoX3R1aSwgdGhlbWUpID0+ICh7XG4gICAgcmVuZGVyKHdpZHRoOiBudW1iZXIpOiBzdHJpbmdbXSB7XG4gICAgICBjb25zdCB1aSA9IG1ha2VVSSh0aGVtZSwgd2lkdGgpO1xuICAgICAgY29uc3QgcGFkID0gSU5ERU5ULmJhc2U7XG4gICAgICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcbiAgICAgIGNvbnN0IGNvbnRlbnRXaWR0aCA9IE1hdGgubWF4KDIwLCB3aWR0aCAtIHZpc2libGVXaWR0aChwYWQpKTtcbiAgICAgIGNvbnN0IGFkZCA9IChsaW5lID0gXCJcIik6IHZvaWQgPT4ge1xuICAgICAgICBsaW5lcy5wdXNoKGxpbmUgPyB0cnVuY2F0ZVRvV2lkdGgoYCR7cGFkfSR7bGluZX1gLCB3aWR0aCwgXCJcdTIwMjZcIikgOiBcIlwiKTtcbiAgICAgIH07XG4gICAgICBjb25zdCBhZGRTZWN0aW9uID0gKGxhYmVsOiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkLCBpbmRlbnQgPSBcIlwiKTogdm9pZCA9PiB7XG4gICAgICAgIGNvbnN0IGNsZWFuID0gbm9ybWFsaXplUm9sbHVwVGV4dCh2YWx1ZSk7XG4gICAgICAgIGlmICghY2xlYW4pIHJldHVybjtcbiAgICAgICAgYWRkKGAke2luZGVudH0ke3RoZW1lLmZnKFwiYWNjZW50XCIsIGxhYmVsKX0gJHt0aGVtZS5mZyhcInRleHRcIiwgdHJ1bmNhdGVUb1dpZHRoKGNsZWFuLCBjb250ZW50V2lkdGggLSBpbmRlbnQubGVuZ3RoIC0gbGFiZWwubGVuZ3RoIC0gMSwgXCJcdTIwMjZcIikpfWApO1xuICAgICAgfTtcbiAgICAgIGNvbnN0IGFkZExpc3QgPSAobGFiZWw6IHN0cmluZywgdmFsdWVzOiBzdHJpbmdbXSB8IHVuZGVmaW5lZCwgbGltaXQ6IG51bWJlciwgaW5kZW50ID0gXCJcIik6IHZvaWQgPT4ge1xuICAgICAgICBjb25zdCBjbGVhbiA9ICh2YWx1ZXMgPz8gW10pLm1hcChub3JtYWxpemVSb2xsdXBUZXh0KS5maWx0ZXIoKHYpOiB2IGlzIHN0cmluZyA9PiAhIXYpO1xuICAgICAgICBpZiAoY2xlYW4ubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgICAgIGNvbnN0IHNob3duID0gY2xlYW4uc2xpY2UoMCwgbGltaXQpO1xuICAgICAgICBjb25zdCBtb3JlID0gY2xlYW4ubGVuZ3RoID4gc2hvd24ubGVuZ3RoID8gYCAoKyR7Y2xlYW4ubGVuZ3RoIC0gc2hvd24ubGVuZ3RofSBtb3JlKWAgOiBcIlwiO1xuICAgICAgICBhZGQoYCR7aW5kZW50fSR7dGhlbWUuZmcoXCJhY2NlbnRcIiwgbGFiZWwpfSAke3RoZW1lLmZnKFwidGV4dFwiLCB0cnVuY2F0ZVRvV2lkdGgoc2hvd24uam9pbihcIjsgXCIpICsgbW9yZSwgY29udGVudFdpZHRoIC0gaW5kZW50Lmxlbmd0aCAtIGxhYmVsLmxlbmd0aCAtIDEsIFwiXHUyMDI2XCIpKX1gKTtcbiAgICAgIH07XG5cbiAgICAgIGxpbmVzLnB1c2goLi4udWkuYmFyKCkpO1xuXG4gICAgICBjb25zdCBlbGFwc2VkID0gZm9ybWF0QXV0b0VsYXBzZWQoc25hcHNob3Quc3RhcnRlZEF0KTtcbiAgICAgIGNvbnN0IGhlYWRpbmcgPSBzbmFwc2hvdC5hbGxNaWxlc3RvbmVzQ29tcGxldGVcbiAgICAgICAgPyBcIkFsbCBtaWxlc3RvbmVzIGNvbXBsZXRlXCJcbiAgICAgICAgOiBzbmFwc2hvdC5taWxlc3RvbmVJZFxuICAgICAgICAgID8gYE1pbGVzdG9uZSAke3NuYXBzaG90Lm1pbGVzdG9uZUlkfSByb2xsLXVwYFxuICAgICAgICAgIDogXCJNaWxlc3RvbmUgcm9sbC11cFwiO1xuICAgICAgbGluZXMucHVzaChyaWdodEFsaWduKGAke3BhZH0ke3RoZW1lLmZnKFwiYWNjZW50XCIsIHRoZW1lLmJvbGQoaGVhZGluZykpfWAsIGVsYXBzZWQgPyB0aGVtZS5mZyhcImRpbVwiLCBlbGFwc2VkKSA6IFwiXCIsIHdpZHRoKSk7XG5cbiAgICAgIGlmIChzbmFwc2hvdC5taWxlc3RvbmVUaXRsZSkge1xuICAgICAgICBhZGQodGhlbWUuZmcoXCJ0ZXh0XCIsIHNuYXBzaG90Lm1pbGVzdG9uZVRpdGxlKSk7XG4gICAgICB9XG5cbiAgICAgIGxpbmVzLnB1c2goXCJcIik7XG4gICAgICBhZGQodGhlbWUuZmcoXCJhY2NlbnRcIiwgXCJPdXRjb21lXCIpKTtcbiAgICAgIGFkZFNlY3Rpb24oXCJcIiwgc25hcHNob3Qub25lTGluZXIsIFwiICBcIik7XG5cbiAgICAgIGNvbnN0IGNoYW5nZWQgPSBbXG4gICAgICAgIC4uLihzbmFwc2hvdC5zdWNjZXNzQ3JpdGVyaWFSZXN1bHRzID8gW3NuYXBzaG90LnN1Y2Nlc3NDcml0ZXJpYVJlc3VsdHNdIDogW10pLFxuICAgICAgICAuLi4oc25hcHNob3QucmVxdWlyZW1lbnRPdXRjb21lcyA/IFtzbmFwc2hvdC5yZXF1aXJlbWVudE91dGNvbWVzXSA6IFtdKSxcbiAgICAgICAgLi4uKHNuYXBzaG90LmtleURlY2lzaW9ucyA/PyBbXSksXG4gICAgICBdLm1hcChub3JtYWxpemVSb2xsdXBUZXh0KS5maWx0ZXIoKHYpOiB2IGlzIHN0cmluZyA9PiAhIXYpLnNsaWNlKDAsIDQpO1xuICAgICAgaWYgKGNoYW5nZWQubGVuZ3RoID4gMCkge1xuICAgICAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICAgICAgICBhZGQodGhlbWUuZmcoXCJhY2NlbnRcIiwgXCJXaGF0IGNoYW5nZWRcIikpO1xuICAgICAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgY2hhbmdlZCkgYWRkKGAgIC0gJHt0aGVtZS5mZyhcInRleHRcIiwgaXRlbSl9YCk7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHZlcmlmaWNhdGlvbiA9IFtcbiAgICAgICAgc25hcHNob3QuZGVmaW5pdGlvbk9mRG9uZVJlc3VsdHMsXG4gICAgICAgIHNuYXBzaG90LmRldmlhdGlvbnMgPyBgRGV2aWF0aW9uczogJHtzbmFwc2hvdC5kZXZpYXRpb25zfWAgOiBudWxsLFxuICAgICAgICBzbmFwc2hvdC5mb2xsb3dVcHMgPyBgRm9sbG93LXVwczogJHtzbmFwc2hvdC5mb2xsb3dVcHN9YCA6IG51bGwsXG4gICAgICBdLm1hcChub3JtYWxpemVSb2xsdXBUZXh0KS5maWx0ZXIoKHYpOiB2IGlzIHN0cmluZyA9PiAhIXYpO1xuICAgICAgaWYgKHZlcmlmaWNhdGlvbi5sZW5ndGggPiAwIHx8IChzbmFwc2hvdC5rZXlGaWxlcz8ubGVuZ3RoID8/IDApID4gMCkge1xuICAgICAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICAgICAgICBhZGQodGhlbWUuZmcoXCJhY2NlbnRcIiwgXCJWZXJpZmljYXRpb25cIikpO1xuICAgICAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgdmVyaWZpY2F0aW9uLnNsaWNlKDAsIDMpKSBhZGQoYCAgLSAke3RoZW1lLmZnKFwidGV4dFwiLCBpdGVtKX1gKTtcbiAgICAgICAgYWRkTGlzdChcIkZpbGVzOlwiLCBzbmFwc2hvdC5rZXlGaWxlcywgNCwgXCIgIFwiKTtcbiAgICAgIH1cblxuICAgICAgaWYgKChzbmFwc2hvdC5sZXNzb25zTGVhcm5lZD8ubGVuZ3RoID8/IDApID4gMCkge1xuICAgICAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICAgICAgICBhZGRMaXN0KFwiTGVzc29uczpcIiwgc25hcHNob3QubGVzc29uc0xlYXJuZWQsIDIpO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBoYXNTbGljZVRvdGFscyA9IHR5cGVvZiBzbmFwc2hvdC5jb21wbGV0ZWRTbGljZXMgPT09IFwibnVtYmVyXCIgJiYgdHlwZW9mIHNuYXBzaG90LnRvdGFsU2xpY2VzID09PSBcIm51bWJlclwiICYmIHNuYXBzaG90LnRvdGFsU2xpY2VzID4gMDtcblxuICAgICAgbGluZXMucHVzaChcIlwiKTtcbiAgICAgIGNvbnN0IHN0YXRzOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgaWYgKGhhc1NsaWNlVG90YWxzKSBzdGF0cy5wdXNoKHRoZW1lLmZnKFwic3VjY2Vzc1wiLCBgJHtzbmFwc2hvdC5jb21wbGV0ZWRTbGljZXN9LyR7c25hcHNob3QudG90YWxTbGljZXN9IHNsaWNlc2ApKTtcbiAgICAgIGlmIChzbmFwc2hvdC51bml0Q291bnQgPiAwKSBzdGF0cy5wdXNoKHRoZW1lLmZnKFwiZGltXCIsIGAke3NuYXBzaG90LnVuaXRDb3VudH0gdW5pdHNgKSk7XG4gICAgICBpZiAoc25hcHNob3QudG90YWxUb2tlbnMgPiAwKSBzdGF0cy5wdXNoKHRoZW1lLmZnKFwiZGltXCIsIGAke2Zvcm1hdFdpZGdldFRva2VucyhzbmFwc2hvdC50b3RhbFRva2Vucyl9IHRva2Vuc2ApKTtcbiAgICAgIGlmIChzbmFwc2hvdC50b3RhbENvc3QgPiAwKSBzdGF0cy5wdXNoKHRoZW1lLmZnKFwid2FybmluZ1wiLCBgJCR7c25hcHNob3QudG90YWxDb3N0LnRvRml4ZWQoMil9YCkpO1xuICAgICAgaWYgKHR5cGVvZiBzbmFwc2hvdC5jYWNoZUhpdFJhdGUgPT09IFwibnVtYmVyXCIpIHtcbiAgICAgICAgY29uc3QgaGl0Q29sb3IgPSBzbmFwc2hvdC5jYWNoZUhpdFJhdGUgPj0gNzAgPyBcInN1Y2Nlc3NcIiA6IHNuYXBzaG90LmNhY2hlSGl0UmF0ZSA+PSA0MCA/IFwid2FybmluZ1wiIDogXCJlcnJvclwiO1xuICAgICAgICBzdGF0cy5wdXNoKHRoZW1lLmZnKGhpdENvbG9yLCBgJHtNYXRoLnJvdW5kKHNuYXBzaG90LmNhY2hlSGl0UmF0ZSl9JSBjYWNoZSBoaXRgKSk7XG4gICAgICB9XG4gICAgICBpZiAoc3RhdHMubGVuZ3RoID4gMCkge1xuICAgICAgICBhZGQoYCR7dGhlbWUuZmcoXCJhY2NlbnRcIiwgXCJSdW4gdG90YWxzXCIpfSAke3N0YXRzLmpvaW4odGhlbWUuZmcoXCJkaW1cIiwgXCIgXHUwMEI3IFwiKSl9YCk7XG4gICAgICB9XG5cbiAgICAgIGxpbmVzLnB1c2goXCJcIik7XG4gICAgICBjb25zdCBuZXh0QWN0aW9uID0gc25hcHNob3QuYWxsTWlsZXN0b25lc0NvbXBsZXRlXG4gICAgICAgID8gXCJSZXZpZXcgdGhlIHJvbGwtdXAsIHRoZW4gc3RhcnQgYSBuZXcgbWlsZXN0b25lIHdoZW4gcmVhZHkuXCJcbiAgICAgICAgOiBcIlJldmlldyB0aGUgcm9sbC11cCwgaW5zcGVjdCBzdGF0dXMsIG9yIGNvbnRpbnVlIHRvIHRoZSBuZXh0IG1pbGVzdG9uZS5cIjtcbiAgICAgIGNvbnN0IGNvbW1hbmRzID0gc25hcHNob3QuYWxsTWlsZXN0b25lc0NvbXBsZXRlXG4gICAgICAgID8gW1wiL2dzZCBzdGF0dXMgZm9yIG92ZXJ2aWV3XCIsIFwiL2dzZCB2aXN1YWxpemUgdG8gaW5zcGVjdFwiLCBcIi9nc2Qgbm90aWZpY2F0aW9ucyBmb3IgaGlzdG9yeVwiLCBcIi9nc2Qgc3RhcnQgZm9yIG5ldyB3b3JrXCJdXG4gICAgICAgIDogW1wiL2dzZCBzdGF0dXMgZm9yIG92ZXJ2aWV3XCIsIFwiL2dzZCB2aXN1YWxpemUgdG8gaW5zcGVjdFwiLCBcIi9nc2Qgbm90aWZpY2F0aW9ucyBmb3IgaGlzdG9yeVwiLCBcIi9nc2QgYXV0byBmb3IgbmV4dCBtaWxlc3RvbmVcIl07XG4gICAgICBhZGQoYCR7dGhlbWUuZmcoXCJzdWNjZXNzXCIsIFwiTmV4dFwiKX0gJHt0aGVtZS5mZyhcInRleHRcIiwgbmV4dEFjdGlvbil9YCk7XG4gICAgICBhZGQodGhlbWUuZmcoXCJkaW1cIiwgY29tbWFuZHMuam9pbihcIiAgXHUwMEI3ICBcIikpKTtcblxuICAgICAgY29uc3QgbG9jYXRpb24gPSBzbmFwc2hvdC5iYXNlUGF0aCA/IHRoZW1lLmZnKFwiZGltXCIsIHNuYXBzaG90LmJhc2VQYXRoKSA6IFwiXCI7XG4gICAgICBjb25zdCByZWFzb24gPSB0aGVtZS5mZyhcImRpbVwiLCBzbmFwc2hvdC5yZWFzb24pO1xuICAgICAgbGluZXMucHVzaChyaWdodEFsaWduKGAke3BhZH0ke3RydW5jYXRlVG9XaWR0aChsb2NhdGlvbiwgTWF0aC5tYXgoMCwgd2lkdGggLSAzMiksIFwiXHUyMDI2XCIpfWAsIHJlYXNvbiwgd2lkdGgpKTtcbiAgICAgIGxpbmVzLnB1c2goLi4udWkuYmFyKCkpO1xuXG4gICAgICByZXR1cm4gbGluZXM7XG4gICAgfSxcbiAgICBpbnZhbGlkYXRlKCk6IHZvaWQge30sXG4gICAgZGlzcG9zZSgpOiB2b2lkIHt9LFxuICB9KSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRBdXRvT3V0Y29tZVdpZGdldChcbiAgY3R4OiBFeHRlbnNpb25Db250ZXh0LFxuICBzbmFwc2hvdDogQXV0b091dGNvbWVTdXJmYWNlU25hcHNob3QsXG4pOiB2b2lkIHtcbiAgaWYgKCFjdHguaGFzVUkpIHJldHVybjtcblxuICBjdHgudWkuc2V0V2lkZ2V0KFwiZ3NkLW91dGNvbWVcIiwgKF90dWksIHRoZW1lKSA9PiAoe1xuICAgIHJlbmRlcih3aWR0aDogbnVtYmVyKTogc3RyaW5nW10ge1xuICAgICAgY29uc3QgY29sb3IgPSBzbmFwc2hvdC5zdGF0dXMgPT09IFwiZmFpbGVkXCIgfHwgc25hcHNob3Quc3RhdHVzID09PSBcImJsb2NrZWRcIlxuICAgICAgICA/IFwid2FybmluZ1wiXG4gICAgICAgIDogc25hcHNob3Quc3RhdHVzID09PSBcImNvbXBsZXRlXCJcbiAgICAgICAgICA/IFwic3VjY2Vzc1wiXG4gICAgICAgICAgOiBcImJvcmRlckFjY2VudFwiO1xuICAgICAgY29uc3QgaWNvbiA9IHNuYXBzaG90LnN0YXR1cyA9PT0gXCJjb21wbGV0ZVwiID8gXCJcdTI3MTNcIlxuICAgICAgICA6IHNuYXBzaG90LnN0YXR1cyA9PT0gXCJmYWlsZWRcIiA/IFwieFwiXG4gICAgICAgICAgOiBzbmFwc2hvdC5zdGF0dXMgPT09IFwiYmxvY2tlZFwiID8gXCIhXCJcbiAgICAgICAgICAgIDogc25hcHNob3Quc3RhdHVzID09PSBcInBhdXNlZFwiID8gXCJ8fFwiXG4gICAgICAgICAgICAgIDogXCJcdTI1Q0ZcIjtcbiAgICAgIGNvbnN0IGlubmVyV2lkdGggPSBNYXRoLm1heCg4LCB3aWR0aCAtIDQpO1xuICAgICAgY29uc3QgbWF4TGluZXMgPSA3O1xuICAgICAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG4gICAgICBjb25zdCBlbGFwc2VkID0gc25hcHNob3Quc3RhcnRlZEF0ID8gZm9ybWF0QXV0b0VsYXBzZWQoc25hcHNob3Quc3RhcnRlZEF0KSA6IFwiXCI7XG4gICAgICBjb25zdCBoZWFkaW5nID0gYCR7dGhlbWUuZmcoY29sb3IsIGljb24pfSAke3RoZW1lLmZnKFwiYWNjZW50XCIsIHRoZW1lLmJvbGQoXCJHU0RcIikpfSAke3RoZW1lLmZnKFwidGV4dFwiLCBzbmFwc2hvdC50aXRsZSl9YDtcbiAgICAgIGxpbmVzLnB1c2gocmlnaHRBbGlnbihoZWFkaW5nLCBlbGFwc2VkID8gdGhlbWUuZmcoXCJkaW1cIiwgZWxhcHNlZCkgOiBcIlwiLCBpbm5lcldpZHRoKSk7XG4gICAgICBjb25zdCBjb21tYW5kcyA9IHNuYXBzaG90LmNvbW1hbmRzPy5maWx0ZXIoQm9vbGVhbikgPz8gW107XG4gICAgICBjb25zdCBjb21tYW5kTGluZSA9IGNvbW1hbmRzLmxlbmd0aCA+IDAgPyB0aGVtZS5mZyhcImRpbVwiLCBjb21tYW5kcy5qb2luKFwiICBcdTAwQjcgIFwiKSkgOiBudWxsO1xuXG4gICAgICBjb25zdCBhZGRXcmFwcGVkID0gKHRleHQ6IHN0cmluZywgcHJlZml4ID0gXCJcIik6IHZvaWQgPT4ge1xuICAgICAgICBjb25zdCByZXNlcnZlID0gY29tbWFuZExpbmUgPyAxIDogMDtcbiAgICAgICAgY29uc3QgcmVtYWluaW5nID0gTWF0aC5tYXgoMCwgbWF4TGluZXMgLSByZXNlcnZlIC0gbGluZXMubGVuZ3RoKTtcbiAgICAgICAgaWYgKHJlbWFpbmluZyA9PT0gMCkgcmV0dXJuO1xuICAgICAgICBjb25zdCBhdmFpbGFibGUgPSBNYXRoLm1heCg4LCBpbm5lcldpZHRoIC0gdmlzaWJsZVdpZHRoKHByZWZpeCkpO1xuICAgICAgICBmb3IgKGNvbnN0IFtpZHgsIGxpbmVdIG9mIHdyYXBWaXNpYmxlVGV4dCh0ZXh0LCBhdmFpbGFibGUpLnNsaWNlKDAsIHJlbWFpbmluZykuZW50cmllcygpKSB7XG4gICAgICAgICAgbGluZXMucHVzaChgJHtpZHggPT09IDAgPyBwcmVmaXggOiBcIiBcIi5yZXBlYXQodmlzaWJsZVdpZHRoKHByZWZpeCkpfSR7bGluZX1gKTtcbiAgICAgICAgfVxuICAgICAgfTtcblxuICAgICAgaWYgKHNuYXBzaG90LmRldGFpbCkge1xuICAgICAgICBhZGRXcmFwcGVkKHNuYXBzaG90LmRldGFpbCwgYCR7dGhlbWUuZmcoXCJkaW1cIiwgXCJSZWFzb25cIil9IGApO1xuICAgICAgfVxuICAgICAgaWYgKHNuYXBzaG90LnVuaXRMYWJlbCkge1xuICAgICAgICBhZGRXcmFwcGVkKHNuYXBzaG90LnVuaXRMYWJlbCwgYCR7dGhlbWUuZmcoXCJkaW1cIiwgXCJMYXN0XCIpfSAgIGApO1xuICAgICAgfVxuICAgICAgYWRkV3JhcHBlZChzbmFwc2hvdC5uZXh0QWN0aW9uLCBgJHt0aGVtZS5mZyhcInN1Y2Nlc3NcIiwgXCJOZXh0XCIpfSAgIGApO1xuXG4gICAgICBpZiAoY29tbWFuZExpbmUgJiYgbGluZXMubGVuZ3RoIDwgbWF4TGluZXMpIHtcbiAgICAgICAgbGluZXMucHVzaChjb21tYW5kTGluZSk7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiByZW5kZXJGcmFtZSh0aGVtZSwgbGluZXMsIHdpZHRoLCB7IGJvcmRlckNvbG9yOiBjb2xvciwgcGFkZGluZ1g6IDEgfSk7XG4gICAgfSxcbiAgICBpbnZhbGlkYXRlKCk6IHZvaWQge30sXG4gICAgZGlzcG9zZSgpOiB2b2lkIHt9LFxuICB9KSk7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVJvbGx1cFRleHQodmFsdWU6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQpOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3QgY2xlYW4gPSB2YWx1ZVxuICAgID8ucmVwbGFjZSgvXFxzKy9nLCBcIiBcIilcbiAgICAucmVwbGFjZSgvXlstKl1cXHMrLywgXCJcIilcbiAgICAudHJpbSgpO1xuICBpZiAoIWNsZWFuIHx8IGNsZWFuID09PSBcIihub25lKVwiIHx8IGNsZWFuID09PSBcIk5vbmUuXCIgfHwgY2xlYW4gPT09IFwiTm90IHByb3ZpZGVkLlwiKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIGNsZWFuO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBaUJBLFNBQVMscUJBQXFCO0FBQzlCLFNBQVMsaUJBQWlCO0FBQzFCLFNBQVMsdUJBQXVCO0FBQ2hDLFNBQVMsb0JBQW9CO0FBSzdCLFNBQVMsZUFBZSxvQkFBb0IscUJBQXFCO0FBQ2pFLFNBQVMsY0FBYyxlQUFlLGtCQUFrQjtBQUN4RCxTQUFTLG9CQUFvQjtBQUM3QixTQUFTLGlCQUFpQixvQkFBb0I7QUFDOUMsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsT0FBTyxjQUFjO0FBQzlCLFNBQVMsaUJBQWlCLGFBQWEsbUJBQW1CLFlBQVksdUJBQXVCO0FBQzdG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
