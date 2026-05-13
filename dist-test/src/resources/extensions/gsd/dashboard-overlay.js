import { truncateToWidth, visibleWidth, matchesKey, Key } from "@gsd/pi-tui";
import { deriveState } from "./state.js";
import { loadFile } from "./files.js";
import { isDbAvailable, getMilestoneSlices, getSliceTasks } from "./gsd-db.js";
import { resolveMilestoneFile } from "./paths.js";
import { getAutoDashboardData } from "./auto.js";
import {
  getLedger,
  getProjectTotals,
  aggregateByPhase,
  aggregateBySlice,
  aggregateByModel,
  aggregateCacheHitRate,
  formatCost,
  formatTokenCount,
  formatCostProjection
} from "./metrics.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { getActiveWorktreeName } from "./worktree-session-state.js";
import { getWorkerBatches, hasActiveWorkers } from "../subagent/worker-registry.js";
import { formatDuration, padRight, joinColumns, centerLine, fitColumns, STATUS_GLYPH, STATUS_COLOR } from "../shared/mod.js";
import { estimateTimeRemaining } from "./auto-dashboard.js";
import { computeProgressScore } from "./progress-score.js";
import { runEnvironmentChecks } from "./doctor-environment.js";
import { formattedShortcutPair } from "./shortcut-defs.js";
function unitLabel(type) {
  switch (type) {
    case "discuss-milestone":
    case "discuss-slice":
      return "Discuss";
    case "research-milestone":
      return "Research";
    case "plan-milestone":
      return "Plan";
    case "research-slice":
      return "Research";
    case "plan-slice":
      return "Plan";
    case "execute-task":
      return "Execute";
    case "complete-slice":
      return "Complete";
    case "reassess-roadmap":
      return "Reassess";
    case "triage-captures":
      return "Triage";
    case "quick-task":
      return "Quick Task";
    case "replan-slice":
      return "Replan";
    case "custom-step":
      return "Workflow Step";
    default:
      return type;
  }
}
class GSDDashboardOverlay {
  tui;
  theme;
  onClose;
  cachedWidth;
  cachedLines;
  refreshTimer;
  scrollOffset = 0;
  dashData;
  milestoneData = null;
  loading = true;
  loadedDashboardIdentity;
  refreshInFlight = null;
  disposed = false;
  resizeHandler = null;
  constructor(tui, theme, onClose) {
    this.tui = tui;
    this.theme = theme;
    this.onClose = onClose;
    this.dashData = getAutoDashboardData();
    this.resizeHandler = () => {
      if (this.disposed) return;
      this.invalidate();
      this.tui.requestRender();
    };
    process.stdout.on("resize", this.resizeHandler);
    this.scheduleRefresh(true);
    this.refreshTimer = setInterval(() => {
      this.scheduleRefresh();
    }, 2e3);
  }
  scheduleRefresh(initial = false) {
    if (this.refreshInFlight || this.disposed) return;
    this.refreshInFlight = this.refreshDashboard(initial).finally(() => {
      this.refreshInFlight = null;
    });
  }
  computeDashboardIdentity(dashData) {
    const base = dashData.basePath || process.cwd();
    const currentUnit = dashData.currentUnit ? `${dashData.currentUnit.type}:${dashData.currentUnit.id}:${dashData.currentUnit.startedAt}` : "-";
    return [
      base,
      dashData.active ? "1" : "0",
      dashData.paused ? "1" : "0",
      currentUnit
    ].join("|");
  }
  async refreshDashboard(initial = false) {
    if (this.disposed) return;
    this.dashData = getAutoDashboardData();
    const nextIdentity = this.computeDashboardIdentity(this.dashData);
    if (initial || nextIdentity !== this.loadedDashboardIdentity) {
      const loaded = await this.loadData();
      if (this.disposed) return;
      if (loaded) {
        this.loadedDashboardIdentity = nextIdentity;
      }
    }
    if (initial) {
      this.loading = false;
    }
    this.invalidate();
    this.tui.requestRender();
  }
  async loadData() {
    const base = this.dashData.basePath || process.cwd();
    try {
      const state = await deriveState(base);
      if (!state.activeMilestone) {
        this.milestoneData = null;
        return true;
      }
      const mid = state.activeMilestone.id;
      const view = {
        id: mid,
        title: state.activeMilestone.title,
        slices: [],
        phase: state.phase,
        progress: {
          milestones: {
            total: state.progress?.milestones.total ?? state.registry.length,
            done: state.progress?.milestones.done ?? state.registry.filter((entry) => entry.status === "complete").length
          }
        }
      };
      const roadmapFile = resolveMilestoneFile(base, mid, "ROADMAP");
      const roadmapContent = roadmapFile ? await loadFile(roadmapFile) : null;
      let normSlices = [];
      if (isDbAvailable()) {
        normSlices = getMilestoneSlices(mid).map((s) => ({ id: s.id, done: s.status === "complete", title: s.title, risk: s.risk || "medium" }));
      }
      for (const s of normSlices) {
        const sliceView = {
          id: s.id,
          title: s.title,
          done: s.done,
          risk: s.risk,
          active: state.activeSlice?.id === s.id,
          tasks: []
        };
        if (sliceView.active) {
          if (isDbAvailable()) {
            const dbTasks = getSliceTasks(mid, s.id);
            sliceView.taskProgress = {
              done: dbTasks.filter((t) => t.status === "complete" || t.status === "done").length,
              total: dbTasks.length
            };
            for (const t of dbTasks) {
              sliceView.tasks.push({
                id: t.id,
                title: t.title,
                done: t.status === "complete" || t.status === "done",
                active: state.activeTask?.id === t.id
              });
            }
          }
        }
        view.slices.push(sliceView);
      }
      this.milestoneData = view;
      return true;
    } catch {
      return false;
    }
  }
  handleInput(data) {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.ctrlAlt("g")) || matchesKey(data, Key.ctrlShift("g"))) {
      this.dispose();
      this.onClose();
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      this.scrollOffset++;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (data === "g") {
      this.scrollOffset = 0;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (data === "G") {
      this.scrollOffset = 999;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
  }
  render(width) {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }
    const content = this.buildContentLines(width);
    const viewportHeight = Math.max(5, process.stdout.rows ? process.stdout.rows - 8 : 24);
    const chromeHeight = 2;
    const visibleContentRows = Math.max(1, viewportHeight - chromeHeight);
    const maxScroll = Math.max(0, content.length - visibleContentRows);
    this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
    const visibleContent = content.slice(this.scrollOffset, this.scrollOffset + visibleContentRows);
    const lines = this.wrapInBox(visibleContent, width);
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
  wrapInBox(inner, width) {
    const th = this.theme;
    const border = (s) => th.fg("borderAccent", s);
    const innerWidth = width - 4;
    const lines = [];
    lines.push(border("\u256D" + "\u2500".repeat(width - 2) + "\u256E"));
    for (const line of inner) {
      const truncated = truncateToWidth(line, innerWidth);
      const padWidth = Math.max(0, innerWidth - visibleWidth(truncated));
      lines.push(border("\u2502") + " " + truncated + " ".repeat(padWidth) + " " + border("\u2502"));
    }
    lines.push(border("\u2570" + "\u2500".repeat(width - 2) + "\u256F"));
    return lines;
  }
  buildContentLines(width) {
    const th = this.theme;
    const shellWidth = width - 4;
    const contentWidth = Math.min(shellWidth, 128);
    const sidePad = Math.max(0, Math.floor((shellWidth - contentWidth) / 2));
    const leftMargin = " ".repeat(sidePad);
    const lines = [];
    const row = (content = "") => {
      const truncated = truncateToWidth(content, contentWidth);
      return leftMargin + padRight(truncated, contentWidth);
    };
    const blank = () => row("");
    const hr = () => row(th.fg("dim", "\u2500".repeat(contentWidth)));
    const centered = (content) => row(centerLine(content, contentWidth));
    const title = th.fg("accent", th.bold("GSD Dashboard"));
    const isRemote = !!this.dashData.remoteSession;
    const status = this.dashData.active ? `${Date.now() % 2e3 < 1e3 ? th.fg("success", "\u25CF") : th.fg("dim", "\u25CB")} ${th.fg("success", "AUTO")}` : this.dashData.paused ? th.fg("warning", "\u23F8 PAUSED") : isRemote ? `${Date.now() % 2e3 < 1e3 ? th.fg("success", "\u25CF") : th.fg("dim", "\u25CB")} ${th.fg("success", "AUTO")} ${th.fg("dim", `(PID ${this.dashData.remoteSession.pid})`)}` : th.fg("dim", "idle");
    const worktreeName = getActiveWorktreeName();
    const worktreeTag = worktreeName ? `  ${th.fg("warning", `\u2387 ${worktreeName}`)}` : "";
    let elapsedParts = "";
    if (this.dashData.active || this.dashData.paused) {
      const elapsed = this.dashData.elapsed;
      elapsedParts = elapsed > 0 && elapsed < 30 * 24 * 36e5 ? th.fg("dim", formatDuration(elapsed)) : "";
      const eta = estimateTimeRemaining();
      if (eta) elapsedParts += th.fg("dim", `  \xB7  ${eta}`);
    } else if (isRemote) {
      elapsedParts = th.fg("dim", `since ${this.dashData.remoteSession.startedAt.replace("T", " ").slice(0, 19)}`);
    }
    lines.push(row(joinColumns(`${title}  ${status}${worktreeTag}`, elapsedParts, contentWidth)));
    if (this.dashData.active || this.dashData.paused) {
      const progressScore = computeProgressScore();
      const progressIcon = progressScore.level === "green" ? th.fg("success", "\u25CF") : progressScore.level === "yellow" ? th.fg("warning", "\u25CF") : th.fg("error", "\u25CF");
      lines.push(row(`${progressIcon} ${th.fg("text", progressScore.summary)}`));
      if (progressScore.level !== "green" && progressScore.signals.length > 0) {
        for (const signal of progressScore.signals) {
          const prefix = signal.kind === "positive" ? th.fg("success", "  \u2713") : signal.kind === "negative" ? th.fg("error", "  \u2717") : th.fg("dim", "  \xB7");
          lines.push(row(`${prefix} ${th.fg("dim", signal.label)}`));
        }
      }
    }
    lines.push(blank());
    if (this.dashData.currentUnit) {
      const cu = this.dashData.currentUnit;
      const currentElapsed = th.fg("dim", formatDuration(Date.now() - cu.startedAt));
      lines.push(row(joinColumns(
        `${th.fg("text", "Now")}: ${th.fg("accent", unitLabel(cu.type))} ${th.fg("text", cu.id)}`,
        currentElapsed,
        contentWidth
      )));
      lines.push(blank());
    } else if (this.dashData.paused) {
      lines.push(row(th.fg("dim", "/gsd auto to resume")));
      lines.push(blank());
    } else if (isRemote) {
      const rs = this.dashData.remoteSession;
      const unitDisplay = rs.unitType === "starting" || rs.unitType === "resuming" ? rs.unitType : `${unitLabel(rs.unitType)} ${rs.unitId}`;
      lines.push(row(th.fg("text", `Remote session: ${unitDisplay}`)));
      lines.push(blank());
    } else {
      lines.push(row(th.fg("dim", "No unit running \xB7 /gsd auto to start")));
      lines.push(blank());
    }
    if (hasActiveWorkers()) {
      lines.push(hr());
      lines.push(row(th.fg("text", th.bold("Parallel Workers"))));
      lines.push(blank());
      const batches = getWorkerBatches();
      for (const [batchId, workers] of batches) {
        const running = workers.filter((w) => w.status === "running").length;
        const done = workers.filter((w) => w.status === "completed").length;
        const failed = workers.filter((w) => w.status === "failed").length;
        const total = workers[0]?.batchSize ?? workers.length;
        lines.push(row(joinColumns(
          `  ${th.fg("accent", "\u27D0")} ${th.fg("text", `Batch ${batchId.slice(0, 8)}`)}`,
          th.fg("dim", `${done + failed}/${total} done`),
          contentWidth
        )));
        for (const w of workers) {
          const icon = w.status === "running" ? th.fg("accent", "\u25B8") : w.status === "completed" ? th.fg("success", "\u2713") : th.fg("error", "\u2717");
          const elapsed = th.fg("dim", formatDuration(Date.now() - w.startedAt));
          const taskPreview = truncateToWidth(w.task, Math.max(20, contentWidth - 30));
          lines.push(row(joinColumns(
            `    ${icon} ${th.fg("text", w.agent)} ${th.fg("dim", taskPreview)}`,
            elapsed,
            contentWidth
          )));
        }
      }
      lines.push(blank());
    }
    if (this.dashData.pendingCaptureCount > 0) {
      const count = this.dashData.pendingCaptureCount;
      lines.push(row(th.fg("warning", `\u{1F4CC} ${count} pending capture${count === 1 ? "" : "s"} awaiting triage`)));
      lines.push(blank());
    }
    if (this.loading) {
      lines.push(centered(th.fg("dim", "Loading dashboard\u2026")));
      return lines;
    }
    if (this.milestoneData) {
      const mv = this.milestoneData;
      lines.push(row(th.fg("text", th.bold(`${mv.id}: ${mv.title}`))));
      lines.push(blank());
      const totalSlices = mv.slices.length;
      const doneSlices = mv.slices.filter((s) => s.done).length;
      const totalMilestones = mv.progress.milestones.total;
      const doneMilestones = mv.progress.milestones.done;
      const activeSlice = mv.slices.find((s) => s.active);
      lines.push(blank());
      if (activeSlice?.taskProgress) {
        lines.push(row(this.renderProgressRow("Tasks", activeSlice.taskProgress.done, activeSlice.taskProgress.total, "accent", contentWidth)));
      }
      lines.push(row(this.renderProgressRow("Slices", doneSlices, totalSlices, "success", contentWidth)));
      lines.push(row(this.renderProgressRow("Milestones", doneMilestones, totalMilestones, "warning", contentWidth)));
      lines.push(blank());
      for (const s of mv.slices) {
        const sliceStatus = s.done ? "done" : s.active ? "active" : "pending";
        const icon = th.fg(STATUS_COLOR[sliceStatus], STATUS_GLYPH[sliceStatus]);
        const titleColor = s.active ? "accent" : s.done ? "muted" : "dim";
        const titleText = th.fg(titleColor, `${s.id}: ${s.title}`);
        const risk = th.fg("dim", s.risk);
        lines.push(row(joinColumns(`  ${icon} ${titleText}`, risk, contentWidth)));
        if (s.active && s.tasks.length > 0) {
          for (const t of s.tasks) {
            const taskStatus = t.done ? "done" : t.active ? "active" : "pending";
            const tIcon = th.fg(STATUS_COLOR[taskStatus], STATUS_GLYPH[taskStatus]);
            const tColor = t.active ? "warning" : t.done ? "muted" : "dim";
            const tTitle = th.fg(tColor, `${t.id}: ${t.title}`);
            lines.push(row(`      ${tIcon} ${truncateToWidth(tTitle, contentWidth - 6)}`));
          }
        }
      }
    } else {
      lines.push(centered(th.fg("dim", "No active milestone.")));
    }
    const ledger = getLedger();
    if (ledger && ledger.units.length > 0) {
      const totals = getProjectTotals(ledger.units);
      lines.push(blank());
      lines.push(hr());
      lines.push(row(th.fg("text", th.bold("Cost & Usage"))));
      lines.push(blank());
      const costOrReqs = totals.cost > 0 ? `${th.fg("warning", formatCost(totals.cost))} total` : `${th.fg("text", String(totals.apiRequests))} requests`;
      lines.push(row(fitColumns([
        costOrReqs,
        `${th.fg("text", formatTokenCount(totals.tokens.total))} tokens`,
        `${th.fg("text", String(totals.toolCalls))} tools`,
        `${th.fg("text", String(totals.units))} units`
      ], contentWidth, `  ${th.fg("dim", "\xB7")}  `)));
      lines.push(row(fitColumns([
        `${th.fg("dim", "in:")} ${th.fg("text", formatTokenCount(totals.tokens.input))}`,
        `${th.fg("dim", "out:")} ${th.fg("text", formatTokenCount(totals.tokens.output))}`,
        `${th.fg("dim", "cache-r:")} ${th.fg("text", formatTokenCount(totals.tokens.cacheRead))}`,
        `${th.fg("dim", "cache-w:")} ${th.fg("text", formatTokenCount(totals.tokens.cacheWrite))}`
      ], contentWidth, "  ")));
      if (totals.totalTruncationSections > 0 || totals.continueHereFiredCount > 0) {
        const budgetParts = [];
        if (totals.totalTruncationSections > 0) {
          budgetParts.push(th.fg("warning", `${totals.totalTruncationSections} sections truncated`));
        }
        if (totals.continueHereFiredCount > 0) {
          budgetParts.push(th.fg("error", `${totals.continueHereFiredCount} continue-here fired`));
        }
        lines.push(row(budgetParts.join(`  ${th.fg("dim", "\xB7")}  `)));
      }
      const phases = aggregateByPhase(ledger.units);
      if (phases.length > 0) {
        lines.push(blank());
        lines.push(row(th.fg("dim", "By Phase")));
        for (const p of phases) {
          const pct = totals.cost > 0 ? Math.round(p.cost / totals.cost * 100) : 0;
          const left = `  ${th.fg("text", p.phase.padEnd(14))}${th.fg("warning", formatCost(p.cost).padStart(8))}`;
          const right = th.fg("dim", `${String(pct).padStart(3)}%  ${formatTokenCount(p.tokens.total)} tok  ${p.units} units`);
          lines.push(row(joinColumns(left, right, contentWidth)));
        }
      }
      const slices = aggregateBySlice(ledger.units);
      if (slices.length > 0) {
        lines.push(blank());
        lines.push(row(th.fg("dim", "By Slice")));
        for (const s of slices) {
          const pct = totals.cost > 0 ? Math.round(s.cost / totals.cost * 100) : 0;
          const left = `  ${th.fg("text", s.sliceId.padEnd(14))}${th.fg("warning", formatCost(s.cost).padStart(8))}`;
          const right = th.fg("dim", `${String(pct).padStart(3)}%  ${formatTokenCount(s.tokens.total)} tok  ${formatDuration(s.duration)}`);
          lines.push(row(joinColumns(left, right, contentWidth)));
        }
      }
      if (this.milestoneData) {
        const mv = this.milestoneData;
        const msTotalSlices = mv.slices.length;
        const msDoneSlices = mv.slices.filter((s) => s.done).length;
        const remainingCount = msTotalSlices - msDoneSlices;
        const overlayPrefs = loadEffectiveGSDPreferences()?.preferences;
        const projLines = formatCostProjection(slices, remainingCount, overlayPrefs?.budget_ceiling);
        if (projLines.length > 0) {
          lines.push(blank());
          for (const line of projLines) {
            const colored = line.toLowerCase().includes("ceiling") ? th.fg("warning", line) : th.fg("dim", line);
            lines.push(row(colored));
          }
        }
      }
      const models = aggregateByModel(ledger.units);
      if (models.length >= 1) {
        lines.push(blank());
        lines.push(row(th.fg("dim", "By Model")));
        for (const m of models) {
          const pct = totals.cost > 0 ? Math.round(m.cost / totals.cost * 100) : 0;
          const modelName = truncateToWidth(m.model, 38);
          const ctxWindow = m.contextWindowTokens !== void 0 ? th.fg("dim", ` [${formatTokenCount(m.contextWindowTokens)}]`) : "";
          const left = `  ${th.fg("text", modelName.padEnd(38))}${th.fg("warning", formatCost(m.cost).padStart(8))}`;
          const right = th.fg("dim", `${String(pct).padStart(3)}%  ${m.units} units`) + ctxWindow;
          lines.push(row(joinColumns(left, right, contentWidth)));
        }
      }
      lines.push(blank());
      lines.push(row(`${th.fg("dim", "avg/unit:")} ${th.fg("text", formatCost(totals.cost / totals.units))}  ${th.fg("dim", "\xB7")}  ${th.fg("text", formatTokenCount(Math.round(totals.tokens.total / totals.units)))} tokens`));
      const cacheRate = aggregateCacheHitRate();
      if (cacheRate > 0) {
        lines.push(row(`${th.fg("dim", "cache hit rate:")} ${th.fg("text", `${cacheRate}%`)}`));
      }
      if (this.dashData.rtkEnabled && this.dashData.rtkSavings && this.dashData.rtkSavings.commands > 0) {
        const rtk = this.dashData.rtkSavings;
        lines.push(row(
          `${th.fg("dim", "rtk saved:")} ${th.fg("text", formatTokenCount(rtk.savedTokens))} ${th.fg("dim", `(${Math.round(rtk.savingsPct)}% \xB7 ${rtk.commands} cmd${rtk.commands === 1 ? "" : "s"})`)}`
        ));
      }
    }
    const envResults = runEnvironmentChecks(this.dashData.basePath || process.cwd());
    const envIssues = envResults.filter((r) => r.status !== "ok");
    if (envIssues.length > 0) {
      lines.push(blank());
      lines.push(hr());
      lines.push(row(th.fg("text", th.bold("Environment"))));
      lines.push(blank());
      for (const r of envIssues) {
        const icon = r.status === "error" ? th.fg("error", "\u2717") : th.fg("warning", "\u26A0");
        lines.push(row(`  ${icon} ${th.fg("text", r.message)}`));
        if (r.detail) {
          lines.push(row(th.fg("dim", `     ${r.detail}`)));
        }
      }
    }
    lines.push(blank());
    lines.push(hr());
    lines.push(centered(th.fg("dim", `\u2191\u2193 scroll \xB7 g/G top/end \xB7 Esc/${formattedShortcutPair("dashboard")} close`)));
    return lines;
  }
  renderProgressRow(label, done, total, color, width) {
    const th = this.theme;
    const pct = total > 0 ? Math.round(done / total * 100) : 0;
    const labelWidth = 12;
    const rightWidth = 14;
    const gap = 2;
    const labelText = truncateToWidth(label, labelWidth, "").padEnd(labelWidth);
    const ratioText = `${done}/${total}`;
    const rightText = `${String(pct).padStart(3)}%  ${ratioText.padStart(rightWidth - 5)}`;
    const barWidth = Math.max(12, width - labelWidth - rightWidth - gap * 2);
    const filled = total > 0 ? Math.round(done / total * barWidth) : 0;
    const bar = th.fg(color, "\u2588".repeat(filled)) + th.fg("dim", "\u2591".repeat(Math.max(0, barWidth - filled)));
    return `${th.fg("dim", labelText)}${" ".repeat(gap)}${bar}${" ".repeat(gap)}${th.fg("dim", rightText)}`;
  }
  invalidate() {
    this.cachedWidth = void 0;
    this.cachedLines = void 0;
  }
  dispose() {
    this.disposed = true;
    clearInterval(this.refreshTimer);
    if (this.resizeHandler) {
      process.stdout.removeListener("resize", this.resizeHandler);
      this.resizeHandler = null;
    }
  }
}
export {
  GSDDashboardOverlay,
  unitLabel
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9kYXNoYm9hcmQtb3ZlcmxheS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBHU0QgRGFzaGJvYXJkIE92ZXJsYXlcbiAqXG4gKiBGdWxsLXNjcmVlbiBvdmVybGF5IHNob3dpbmcgYXV0by1tb2RlIHByb2dyZXNzOiBtaWxlc3RvbmUvc2xpY2UvdGFza1xuICogYnJlYWtkb3duLCBjdXJyZW50IHVuaXQsIGNvbXBsZXRlZCB1bml0cywgdGltaW5nLCBhbmQgYWN0aXZpdHkgbG9nLlxuICogVG9nZ2xlZCB3aXRoIEN0cmwrQWx0K0cgKFx1MjMwM1x1MjMyNUcgb24gbWFjT1MpLCBDdHJsK1NoaWZ0K0cgZmFsbGJhY2ssXG4gKiBvciBvcGVuZWQgZnJvbSAvZ3NkIHN0YXR1cy5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFRoZW1lIH0gZnJvbSBcIkBnc2QvcGktY29kaW5nLWFnZW50XCI7XG5pbXBvcnQgeyB0cnVuY2F0ZVRvV2lkdGgsIHZpc2libGVXaWR0aCwgbWF0Y2hlc0tleSwgS2V5IH0gZnJvbSBcIkBnc2QvcGktdHVpXCI7XG5pbXBvcnQgeyBkZXJpdmVTdGF0ZSB9IGZyb20gXCIuL3N0YXRlLmpzXCI7XG5pbXBvcnQgeyBsb2FkRmlsZSB9IGZyb20gXCIuL2ZpbGVzLmpzXCI7XG5pbXBvcnQgeyBpc0RiQXZhaWxhYmxlLCBnZXRNaWxlc3RvbmVTbGljZXMsIGdldFNsaWNlVGFza3MgfSBmcm9tIFwiLi9nc2QtZGIuanNcIjtcbmltcG9ydCB7IHJlc29sdmVNaWxlc3RvbmVGaWxlLCByZXNvbHZlU2xpY2VGaWxlIH0gZnJvbSBcIi4vcGF0aHMuanNcIjtcbmltcG9ydCB7IGdldEF1dG9EYXNoYm9hcmREYXRhIH0gZnJvbSBcIi4vYXV0by5qc1wiO1xuaW1wb3J0IHR5cGUgeyBBdXRvRGFzaGJvYXJkRGF0YSB9IGZyb20gXCIuL2F1dG8tZGFzaGJvYXJkLmpzXCI7XG5pbXBvcnQge1xuICBnZXRMZWRnZXIsIGdldFByb2plY3RUb3RhbHMsIGFnZ3JlZ2F0ZUJ5UGhhc2UsIGFnZ3JlZ2F0ZUJ5U2xpY2UsXG4gIGFnZ3JlZ2F0ZUJ5TW9kZWwsIGFnZ3JlZ2F0ZUNhY2hlSGl0UmF0ZSwgZm9ybWF0Q29zdCwgZm9ybWF0VG9rZW5Db3VudCwgZm9ybWF0Q29zdFByb2plY3Rpb24sXG4gIHR5cGUgVW5pdE1ldHJpY3MsXG59IGZyb20gXCIuL21ldHJpY3MuanNcIjtcbmltcG9ydCB7IGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcyB9IGZyb20gXCIuL3ByZWZlcmVuY2VzLmpzXCI7XG5pbXBvcnQgeyBnZXRBY3RpdmVXb3JrdHJlZU5hbWUgfSBmcm9tIFwiLi93b3JrdHJlZS1zZXNzaW9uLXN0YXRlLmpzXCI7XG5pbXBvcnQgeyBnZXRXb3JrZXJCYXRjaGVzLCBoYXNBY3RpdmVXb3JrZXJzLCB0eXBlIFdvcmtlckVudHJ5IH0gZnJvbSBcIi4uL3N1YmFnZW50L3dvcmtlci1yZWdpc3RyeS5qc1wiO1xuaW1wb3J0IHsgZm9ybWF0RHVyYXRpb24sIHBhZFJpZ2h0LCBqb2luQ29sdW1ucywgY2VudGVyTGluZSwgZml0Q29sdW1ucywgU1RBVFVTX0dMWVBILCBTVEFUVVNfQ09MT1IgfSBmcm9tIFwiLi4vc2hhcmVkL21vZC5qc1wiO1xuaW1wb3J0IHsgZXN0aW1hdGVUaW1lUmVtYWluaW5nIH0gZnJvbSBcIi4vYXV0by1kYXNoYm9hcmQuanNcIjtcbmltcG9ydCB7IGNvbXB1dGVQcm9ncmVzc1Njb3JlLCBmb3JtYXRQcm9ncmVzc0xpbmUgfSBmcm9tIFwiLi9wcm9ncmVzcy1zY29yZS5qc1wiO1xuaW1wb3J0IHsgcnVuRW52aXJvbm1lbnRDaGVja3MsIHR5cGUgRW52aXJvbm1lbnRDaGVja1Jlc3VsdCB9IGZyb20gXCIuL2RvY3Rvci1lbnZpcm9ubWVudC5qc1wiO1xuaW1wb3J0IHsgZm9ybWF0dGVkU2hvcnRjdXRQYWlyIH0gZnJvbSBcIi4vc2hvcnRjdXQtZGVmcy5qc1wiO1xuXG5leHBvcnQgZnVuY3Rpb24gdW5pdExhYmVsKHR5cGU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHN3aXRjaCAodHlwZSkge1xuICAgIGNhc2UgXCJkaXNjdXNzLW1pbGVzdG9uZVwiOlxuICAgIGNhc2UgXCJkaXNjdXNzLXNsaWNlXCI6IHJldHVybiBcIkRpc2N1c3NcIjtcbiAgICBjYXNlIFwicmVzZWFyY2gtbWlsZXN0b25lXCI6IHJldHVybiBcIlJlc2VhcmNoXCI7XG4gICAgY2FzZSBcInBsYW4tbWlsZXN0b25lXCI6IHJldHVybiBcIlBsYW5cIjtcbiAgICBjYXNlIFwicmVzZWFyY2gtc2xpY2VcIjogcmV0dXJuIFwiUmVzZWFyY2hcIjtcbiAgICBjYXNlIFwicGxhbi1zbGljZVwiOiByZXR1cm4gXCJQbGFuXCI7XG4gICAgY2FzZSBcImV4ZWN1dGUtdGFza1wiOiByZXR1cm4gXCJFeGVjdXRlXCI7XG4gICAgY2FzZSBcImNvbXBsZXRlLXNsaWNlXCI6IHJldHVybiBcIkNvbXBsZXRlXCI7XG4gICAgY2FzZSBcInJlYXNzZXNzLXJvYWRtYXBcIjogcmV0dXJuIFwiUmVhc3Nlc3NcIjtcbiAgICBjYXNlIFwidHJpYWdlLWNhcHR1cmVzXCI6IHJldHVybiBcIlRyaWFnZVwiO1xuICAgIGNhc2UgXCJxdWljay10YXNrXCI6IHJldHVybiBcIlF1aWNrIFRhc2tcIjtcbiAgICBjYXNlIFwicmVwbGFuLXNsaWNlXCI6IHJldHVybiBcIlJlcGxhblwiO1xuICAgIGNhc2UgXCJjdXN0b20tc3RlcFwiOiByZXR1cm4gXCJXb3JrZmxvdyBTdGVwXCI7XG4gICAgZGVmYXVsdDogcmV0dXJuIHR5cGU7XG4gIH1cbn1cblxuXG5leHBvcnQgY2xhc3MgR1NERGFzaGJvYXJkT3ZlcmxheSB7XG4gIHByaXZhdGUgdHVpOiB7IHJlcXVlc3RSZW5kZXI6ICgpID0+IHZvaWQgfTtcbiAgcHJpdmF0ZSB0aGVtZTogVGhlbWU7XG4gIHByaXZhdGUgb25DbG9zZTogKCkgPT4gdm9pZDtcbiAgcHJpdmF0ZSBjYWNoZWRXaWR0aD86IG51bWJlcjtcbiAgcHJpdmF0ZSBjYWNoZWRMaW5lcz86IHN0cmluZ1tdO1xuICBwcml2YXRlIHJlZnJlc2hUaW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0SW50ZXJ2YWw+O1xuICBwcml2YXRlIHNjcm9sbE9mZnNldCA9IDA7XG4gIHByaXZhdGUgZGFzaERhdGE6IEF1dG9EYXNoYm9hcmREYXRhO1xuICBwcml2YXRlIG1pbGVzdG9uZURhdGE6IE1pbGVzdG9uZVZpZXcgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBsb2FkaW5nID0gdHJ1ZTtcbiAgcHJpdmF0ZSBsb2FkZWREYXNoYm9hcmRJZGVudGl0eT86IHN0cmluZztcbiAgcHJpdmF0ZSByZWZyZXNoSW5GbGlnaHQ6IFByb21pc2U8dm9pZD4gfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBkaXNwb3NlZCA9IGZhbHNlO1xuICBwcml2YXRlIHJlc2l6ZUhhbmRsZXI6ICgoKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuXG4gIGNvbnN0cnVjdG9yKFxuICAgIHR1aTogeyByZXF1ZXN0UmVuZGVyOiAoKSA9PiB2b2lkIH0sXG4gICAgdGhlbWU6IFRoZW1lLFxuICAgIG9uQ2xvc2U6ICgpID0+IHZvaWQsXG4gICkge1xuICAgIHRoaXMudHVpID0gdHVpO1xuICAgIHRoaXMudGhlbWUgPSB0aGVtZTtcbiAgICB0aGlzLm9uQ2xvc2UgPSBvbkNsb3NlO1xuICAgIHRoaXMuZGFzaERhdGEgPSBnZXRBdXRvRGFzaGJvYXJkRGF0YSgpO1xuXG4gICAgLy8gSW52YWxpZGF0ZSBjYWNoZSBvbiB0ZXJtaW5hbCByZXNpemVcbiAgICB0aGlzLnJlc2l6ZUhhbmRsZXIgPSAoKSA9PiB7XG4gICAgICBpZiAodGhpcy5kaXNwb3NlZCkgcmV0dXJuO1xuICAgICAgdGhpcy5pbnZhbGlkYXRlKCk7XG4gICAgICB0aGlzLnR1aS5yZXF1ZXN0UmVuZGVyKCk7XG4gICAgfTtcbiAgICBwcm9jZXNzLnN0ZG91dC5vbihcInJlc2l6ZVwiLCB0aGlzLnJlc2l6ZUhhbmRsZXIpO1xuXG4gICAgdGhpcy5zY2hlZHVsZVJlZnJlc2godHJ1ZSk7XG5cbiAgICB0aGlzLnJlZnJlc2hUaW1lciA9IHNldEludGVydmFsKCgpID0+IHtcbiAgICAgIHRoaXMuc2NoZWR1bGVSZWZyZXNoKCk7XG4gICAgfSwgMjAwMCk7XG4gIH1cblxuICBwcml2YXRlIHNjaGVkdWxlUmVmcmVzaChpbml0aWFsID0gZmFsc2UpOiB2b2lkIHtcbiAgICBpZiAodGhpcy5yZWZyZXNoSW5GbGlnaHQgfHwgdGhpcy5kaXNwb3NlZCkgcmV0dXJuO1xuICAgIHRoaXMucmVmcmVzaEluRmxpZ2h0ID0gdGhpcy5yZWZyZXNoRGFzaGJvYXJkKGluaXRpYWwpXG4gICAgICAuZmluYWxseSgoKSA9PiB7XG4gICAgICAgIHRoaXMucmVmcmVzaEluRmxpZ2h0ID0gbnVsbDtcbiAgICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBjb21wdXRlRGFzaGJvYXJkSWRlbnRpdHkoZGFzaERhdGE6IEF1dG9EYXNoYm9hcmREYXRhKTogc3RyaW5nIHtcbiAgICBjb25zdCBiYXNlID0gZGFzaERhdGEuYmFzZVBhdGggfHwgcHJvY2Vzcy5jd2QoKTtcbiAgICBjb25zdCBjdXJyZW50VW5pdCA9IGRhc2hEYXRhLmN1cnJlbnRVbml0XG4gICAgICA/IGAke2Rhc2hEYXRhLmN1cnJlbnRVbml0LnR5cGV9OiR7ZGFzaERhdGEuY3VycmVudFVuaXQuaWR9OiR7ZGFzaERhdGEuY3VycmVudFVuaXQuc3RhcnRlZEF0fWBcbiAgICAgIDogXCItXCI7XG4gICAgcmV0dXJuIFtcbiAgICAgIGJhc2UsXG4gICAgICBkYXNoRGF0YS5hY3RpdmUgPyBcIjFcIiA6IFwiMFwiLFxuICAgICAgZGFzaERhdGEucGF1c2VkID8gXCIxXCIgOiBcIjBcIixcbiAgICAgIGN1cnJlbnRVbml0LFxuICAgIF0uam9pbihcInxcIik7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHJlZnJlc2hEYXNoYm9hcmQoaW5pdGlhbCA9IGZhbHNlKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKHRoaXMuZGlzcG9zZWQpIHJldHVybjtcbiAgICB0aGlzLmRhc2hEYXRhID0gZ2V0QXV0b0Rhc2hib2FyZERhdGEoKTtcbiAgICBjb25zdCBuZXh0SWRlbnRpdHkgPSB0aGlzLmNvbXB1dGVEYXNoYm9hcmRJZGVudGl0eSh0aGlzLmRhc2hEYXRhKTtcblxuICAgIGlmIChpbml0aWFsIHx8IG5leHRJZGVudGl0eSAhPT0gdGhpcy5sb2FkZWREYXNoYm9hcmRJZGVudGl0eSkge1xuICAgICAgY29uc3QgbG9hZGVkID0gYXdhaXQgdGhpcy5sb2FkRGF0YSgpO1xuICAgICAgaWYgKHRoaXMuZGlzcG9zZWQpIHJldHVybjtcbiAgICAgIGlmIChsb2FkZWQpIHtcbiAgICAgICAgdGhpcy5sb2FkZWREYXNoYm9hcmRJZGVudGl0eSA9IG5leHRJZGVudGl0eTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoaW5pdGlhbCkge1xuICAgICAgdGhpcy5sb2FkaW5nID0gZmFsc2U7XG4gICAgfVxuXG4gICAgdGhpcy5pbnZhbGlkYXRlKCk7XG4gICAgdGhpcy50dWkucmVxdWVzdFJlbmRlcigpO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBsb2FkRGF0YSgpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgICBjb25zdCBiYXNlID0gdGhpcy5kYXNoRGF0YS5iYXNlUGF0aCB8fCBwcm9jZXNzLmN3ZCgpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuICAgICAgaWYgKCFzdGF0ZS5hY3RpdmVNaWxlc3RvbmUpIHtcbiAgICAgICAgdGhpcy5taWxlc3RvbmVEYXRhID0gbnVsbDtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IG1pZCA9IHN0YXRlLmFjdGl2ZU1pbGVzdG9uZS5pZDtcbiAgICAgIGNvbnN0IHZpZXc6IE1pbGVzdG9uZVZpZXcgPSB7XG4gICAgICAgIGlkOiBtaWQsXG4gICAgICAgIHRpdGxlOiBzdGF0ZS5hY3RpdmVNaWxlc3RvbmUudGl0bGUsXG4gICAgICAgIHNsaWNlczogW10sXG4gICAgICAgIHBoYXNlOiBzdGF0ZS5waGFzZSxcbiAgICAgICAgcHJvZ3Jlc3M6IHtcbiAgICAgICAgICBtaWxlc3RvbmVzOiB7XG4gICAgICAgICAgICB0b3RhbDogc3RhdGUucHJvZ3Jlc3M/Lm1pbGVzdG9uZXMudG90YWwgPz8gc3RhdGUucmVnaXN0cnkubGVuZ3RoLFxuICAgICAgICAgICAgZG9uZTogc3RhdGUucHJvZ3Jlc3M/Lm1pbGVzdG9uZXMuZG9uZSA/PyBzdGF0ZS5yZWdpc3RyeS5maWx0ZXIoZW50cnkgPT4gZW50cnkuc3RhdHVzID09PSBcImNvbXBsZXRlXCIpLmxlbmd0aCxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgfTtcblxuICAgICAgY29uc3Qgcm9hZG1hcEZpbGUgPSByZXNvbHZlTWlsZXN0b25lRmlsZShiYXNlLCBtaWQsIFwiUk9BRE1BUFwiKTtcbiAgICAgIGNvbnN0IHJvYWRtYXBDb250ZW50ID0gcm9hZG1hcEZpbGUgPyBhd2FpdCBsb2FkRmlsZShyb2FkbWFwRmlsZSkgOiBudWxsO1xuICAgICAgLy8gTm9ybWFsaXplIHNsaWNlcyBmcm9tIERCXG4gICAgICB0eXBlIE5vcm1TbGljZSA9IHsgaWQ6IHN0cmluZzsgZG9uZTogYm9vbGVhbjsgdGl0bGU6IHN0cmluZzsgcmlzazogc3RyaW5nIH07XG4gICAgICBsZXQgbm9ybVNsaWNlczogTm9ybVNsaWNlW10gPSBbXTtcbiAgICAgIGlmIChpc0RiQXZhaWxhYmxlKCkpIHtcbiAgICAgICAgbm9ybVNsaWNlcyA9IGdldE1pbGVzdG9uZVNsaWNlcyhtaWQpLm1hcChzID0+ICh7IGlkOiBzLmlkLCBkb25lOiBzLnN0YXR1cyA9PT0gXCJjb21wbGV0ZVwiLCB0aXRsZTogcy50aXRsZSwgcmlzazogcy5yaXNrIHx8IFwibWVkaXVtXCIgfSkpO1xuICAgICAgfVxuXG4gICAgICBmb3IgKGNvbnN0IHMgb2Ygbm9ybVNsaWNlcykge1xuICAgICAgICAgIGNvbnN0IHNsaWNlVmlldzogU2xpY2VWaWV3ID0ge1xuICAgICAgICAgICAgaWQ6IHMuaWQsXG4gICAgICAgICAgICB0aXRsZTogcy50aXRsZSxcbiAgICAgICAgICAgIGRvbmU6IHMuZG9uZSxcbiAgICAgICAgICAgIHJpc2s6IHMucmlzayxcbiAgICAgICAgICAgIGFjdGl2ZTogc3RhdGUuYWN0aXZlU2xpY2U/LmlkID09PSBzLmlkLFxuICAgICAgICAgICAgdGFza3M6IFtdLFxuICAgICAgICAgIH07XG5cbiAgICAgICAgICBpZiAoc2xpY2VWaWV3LmFjdGl2ZSkge1xuICAgICAgICAgICAgLy8gTm9ybWFsaXplIHRhc2tzIGZyb20gREJcbiAgICAgICAgICAgIGlmIChpc0RiQXZhaWxhYmxlKCkpIHtcbiAgICAgICAgICAgICAgY29uc3QgZGJUYXNrcyA9IGdldFNsaWNlVGFza3MobWlkLCBzLmlkKTtcbiAgICAgICAgICAgICAgc2xpY2VWaWV3LnRhc2tQcm9ncmVzcyA9IHtcbiAgICAgICAgICAgICAgICBkb25lOiBkYlRhc2tzLmZpbHRlcih0ID0+IHQuc3RhdHVzID09PSBcImNvbXBsZXRlXCIgfHwgdC5zdGF0dXMgPT09IFwiZG9uZVwiKS5sZW5ndGgsXG4gICAgICAgICAgICAgICAgdG90YWw6IGRiVGFza3MubGVuZ3RoLFxuICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICBmb3IgKGNvbnN0IHQgb2YgZGJUYXNrcykge1xuICAgICAgICAgICAgICAgIHNsaWNlVmlldy50YXNrcy5wdXNoKHtcbiAgICAgICAgICAgICAgICAgIGlkOiB0LmlkLFxuICAgICAgICAgICAgICAgICAgdGl0bGU6IHQudGl0bGUsXG4gICAgICAgICAgICAgICAgICBkb25lOiB0LnN0YXR1cyA9PT0gXCJjb21wbGV0ZVwiIHx8IHQuc3RhdHVzID09PSBcImRvbmVcIixcbiAgICAgICAgICAgICAgICAgIGFjdGl2ZTogc3RhdGUuYWN0aXZlVGFzaz8uaWQgPT09IHQuaWQsXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG5cbiAgICAgICAgICB2aWV3LnNsaWNlcy5wdXNoKHNsaWNlVmlldyk7XG4gICAgICB9XG5cbiAgICAgIHRoaXMubWlsZXN0b25lRGF0YSA9IHZpZXc7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIERvbid0IGNyYXNoIHRoZSBvdmVybGF5XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICB9XG5cbiAgaGFuZGxlSW5wdXQoZGF0YTogc3RyaW5nKTogdm9pZCB7XG4gICAgaWYgKFxuICAgICAgbWF0Y2hlc0tleShkYXRhLCBLZXkuZXNjYXBlKSB8fFxuICAgICAgbWF0Y2hlc0tleShkYXRhLCBLZXkuY3RybChcImNcIikpIHx8XG4gICAgICBtYXRjaGVzS2V5KGRhdGEsIEtleS5jdHJsQWx0KFwiZ1wiKSkgfHxcbiAgICAgIG1hdGNoZXNLZXkoZGF0YSwgS2V5LmN0cmxTaGlmdChcImdcIikpXG4gICAgKSB7XG4gICAgICB0aGlzLmRpc3Bvc2UoKTtcbiAgICAgIHRoaXMub25DbG9zZSgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmIChtYXRjaGVzS2V5KGRhdGEsIEtleS5kb3duKSB8fCBtYXRjaGVzS2V5KGRhdGEsIFwialwiKSkge1xuICAgICAgdGhpcy5zY3JvbGxPZmZzZXQrKztcbiAgICAgIHRoaXMuaW52YWxpZGF0ZSgpO1xuICAgICAgdGhpcy50dWkucmVxdWVzdFJlbmRlcigpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmIChtYXRjaGVzS2V5KGRhdGEsIEtleS51cCkgfHwgbWF0Y2hlc0tleShkYXRhLCBcImtcIikpIHtcbiAgICAgIHRoaXMuc2Nyb2xsT2Zmc2V0ID0gTWF0aC5tYXgoMCwgdGhpcy5zY3JvbGxPZmZzZXQgLSAxKTtcbiAgICAgIHRoaXMuaW52YWxpZGF0ZSgpO1xuICAgICAgdGhpcy50dWkucmVxdWVzdFJlbmRlcigpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmIChkYXRhID09PSBcImdcIikge1xuICAgICAgdGhpcy5zY3JvbGxPZmZzZXQgPSAwO1xuICAgICAgdGhpcy5pbnZhbGlkYXRlKCk7XG4gICAgICB0aGlzLnR1aS5yZXF1ZXN0UmVuZGVyKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKGRhdGEgPT09IFwiR1wiKSB7XG4gICAgICB0aGlzLnNjcm9sbE9mZnNldCA9IDk5OTtcbiAgICAgIHRoaXMuaW52YWxpZGF0ZSgpO1xuICAgICAgdGhpcy50dWkucmVxdWVzdFJlbmRlcigpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgfVxuXG4gIHJlbmRlcih3aWR0aDogbnVtYmVyKTogc3RyaW5nW10ge1xuICAgIGlmICh0aGlzLmNhY2hlZExpbmVzICYmIHRoaXMuY2FjaGVkV2lkdGggPT09IHdpZHRoKSB7XG4gICAgICByZXR1cm4gdGhpcy5jYWNoZWRMaW5lcztcbiAgICB9XG5cbiAgICBjb25zdCBjb250ZW50ID0gdGhpcy5idWlsZENvbnRlbnRMaW5lcyh3aWR0aCk7XG4gICAgY29uc3Qgdmlld3BvcnRIZWlnaHQgPSBNYXRoLm1heCg1LCBwcm9jZXNzLnN0ZG91dC5yb3dzID8gcHJvY2Vzcy5zdGRvdXQucm93cyAtIDggOiAyNCk7XG4gICAgY29uc3QgY2hyb21lSGVpZ2h0ID0gMjtcbiAgICBjb25zdCB2aXNpYmxlQ29udGVudFJvd3MgPSBNYXRoLm1heCgxLCB2aWV3cG9ydEhlaWdodCAtIGNocm9tZUhlaWdodCk7XG4gICAgY29uc3QgbWF4U2Nyb2xsID0gTWF0aC5tYXgoMCwgY29udGVudC5sZW5ndGggLSB2aXNpYmxlQ29udGVudFJvd3MpO1xuICAgIHRoaXMuc2Nyb2xsT2Zmc2V0ID0gTWF0aC5taW4odGhpcy5zY3JvbGxPZmZzZXQsIG1heFNjcm9sbCk7XG4gICAgY29uc3QgdmlzaWJsZUNvbnRlbnQgPSBjb250ZW50LnNsaWNlKHRoaXMuc2Nyb2xsT2Zmc2V0LCB0aGlzLnNjcm9sbE9mZnNldCArIHZpc2libGVDb250ZW50Um93cyk7XG5cbiAgICBjb25zdCBsaW5lcyA9IHRoaXMud3JhcEluQm94KHZpc2libGVDb250ZW50LCB3aWR0aCk7XG5cbiAgICB0aGlzLmNhY2hlZFdpZHRoID0gd2lkdGg7XG4gICAgdGhpcy5jYWNoZWRMaW5lcyA9IGxpbmVzO1xuICAgIHJldHVybiBsaW5lcztcbiAgfVxuXG4gIHByaXZhdGUgd3JhcEluQm94KGlubmVyOiBzdHJpbmdbXSwgd2lkdGg6IG51bWJlcik6IHN0cmluZ1tdIHtcbiAgICBjb25zdCB0aCA9IHRoaXMudGhlbWU7XG4gICAgY29uc3QgYm9yZGVyID0gKHM6IHN0cmluZykgPT4gdGguZmcoXCJib3JkZXJBY2NlbnRcIiwgcyk7XG4gICAgY29uc3QgaW5uZXJXaWR0aCA9IHdpZHRoIC0gNDtcbiAgICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcblxuICAgIGxpbmVzLnB1c2goYm9yZGVyKFwiXHUyNTZEXCIgKyBcIlx1MjUwMFwiLnJlcGVhdCh3aWR0aCAtIDIpICsgXCJcdTI1NkVcIikpO1xuICAgIGZvciAoY29uc3QgbGluZSBvZiBpbm5lcikge1xuICAgICAgY29uc3QgdHJ1bmNhdGVkID0gdHJ1bmNhdGVUb1dpZHRoKGxpbmUsIGlubmVyV2lkdGgpO1xuICAgICAgY29uc3QgcGFkV2lkdGggPSBNYXRoLm1heCgwLCBpbm5lcldpZHRoIC0gdmlzaWJsZVdpZHRoKHRydW5jYXRlZCkpO1xuICAgICAgbGluZXMucHVzaChib3JkZXIoXCJcdTI1MDJcIikgKyBcIiBcIiArIHRydW5jYXRlZCArIFwiIFwiLnJlcGVhdChwYWRXaWR0aCkgKyBcIiBcIiArIGJvcmRlcihcIlx1MjUwMlwiKSk7XG4gICAgfVxuICAgIGxpbmVzLnB1c2goYm9yZGVyKFwiXHUyNTcwXCIgKyBcIlx1MjUwMFwiLnJlcGVhdCh3aWR0aCAtIDIpICsgXCJcdTI1NkZcIikpO1xuICAgIHJldHVybiBsaW5lcztcbiAgfVxuXG4gIHByaXZhdGUgYnVpbGRDb250ZW50TGluZXMod2lkdGg6IG51bWJlcik6IHN0cmluZ1tdIHtcbiAgICBjb25zdCB0aCA9IHRoaXMudGhlbWU7XG4gICAgY29uc3Qgc2hlbGxXaWR0aCA9IHdpZHRoIC0gNDtcbiAgICBjb25zdCBjb250ZW50V2lkdGggPSBNYXRoLm1pbihzaGVsbFdpZHRoLCAxMjgpO1xuICAgIGNvbnN0IHNpZGVQYWQgPSBNYXRoLm1heCgwLCBNYXRoLmZsb29yKChzaGVsbFdpZHRoIC0gY29udGVudFdpZHRoKSAvIDIpKTtcbiAgICBjb25zdCBsZWZ0TWFyZ2luID0gXCIgXCIucmVwZWF0KHNpZGVQYWQpO1xuICAgIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuXG4gICAgY29uc3Qgcm93ID0gKGNvbnRlbnQgPSBcIlwiKTogc3RyaW5nID0+IHtcbiAgICAgIGNvbnN0IHRydW5jYXRlZCA9IHRydW5jYXRlVG9XaWR0aChjb250ZW50LCBjb250ZW50V2lkdGgpO1xuICAgICAgcmV0dXJuIGxlZnRNYXJnaW4gKyBwYWRSaWdodCh0cnVuY2F0ZWQsIGNvbnRlbnRXaWR0aCk7XG4gICAgfTtcbiAgICBjb25zdCBibGFuayA9ICgpID0+IHJvdyhcIlwiKTtcbiAgICBjb25zdCBociA9ICgpID0+IHJvdyh0aC5mZyhcImRpbVwiLCBcIlx1MjUwMFwiLnJlcGVhdChjb250ZW50V2lkdGgpKSk7XG4gICAgY29uc3QgY2VudGVyZWQgPSAoY29udGVudDogc3RyaW5nKSA9PiByb3coY2VudGVyTGluZShjb250ZW50LCBjb250ZW50V2lkdGgpKTtcblxuICAgIGNvbnN0IHRpdGxlID0gdGguZmcoXCJhY2NlbnRcIiwgdGguYm9sZChcIkdTRCBEYXNoYm9hcmRcIikpO1xuICAgIGNvbnN0IGlzUmVtb3RlID0gISF0aGlzLmRhc2hEYXRhLnJlbW90ZVNlc3Npb247XG4gICAgY29uc3Qgc3RhdHVzID0gdGhpcy5kYXNoRGF0YS5hY3RpdmVcbiAgICAgID8gYCR7RGF0ZS5ub3coKSAlIDIwMDAgPCAxMDAwID8gdGguZmcoXCJzdWNjZXNzXCIsIFwiXHUyNUNGXCIpIDogdGguZmcoXCJkaW1cIiwgXCJcdTI1Q0JcIil9ICR7dGguZmcoXCJzdWNjZXNzXCIsIFwiQVVUT1wiKX1gXG4gICAgICA6IHRoaXMuZGFzaERhdGEucGF1c2VkXG4gICAgICAgID8gdGguZmcoXCJ3YXJuaW5nXCIsIFwiXHUyM0Y4IFBBVVNFRFwiKVxuICAgICAgICA6IGlzUmVtb3RlXG4gICAgICAgICAgPyBgJHtEYXRlLm5vdygpICUgMjAwMCA8IDEwMDAgPyB0aC5mZyhcInN1Y2Nlc3NcIiwgXCJcdTI1Q0ZcIikgOiB0aC5mZyhcImRpbVwiLCBcIlx1MjVDQlwiKX0gJHt0aC5mZyhcInN1Y2Nlc3NcIiwgXCJBVVRPXCIpfSAke3RoLmZnKFwiZGltXCIsIGAoUElEICR7dGhpcy5kYXNoRGF0YS5yZW1vdGVTZXNzaW9uIS5waWR9KWApfWBcbiAgICAgICAgICA6IHRoLmZnKFwiZGltXCIsIFwiaWRsZVwiKTtcbiAgICBjb25zdCB3b3JrdHJlZU5hbWUgPSBnZXRBY3RpdmVXb3JrdHJlZU5hbWUoKTtcbiAgICBjb25zdCB3b3JrdHJlZVRhZyA9IHdvcmt0cmVlTmFtZVxuICAgICAgPyBgICAke3RoLmZnKFwid2FybmluZ1wiLCBgXHUyMzg3ICR7d29ya3RyZWVOYW1lfWApfWBcbiAgICAgIDogXCJcIjtcbiAgICBsZXQgZWxhcHNlZFBhcnRzID0gXCJcIjtcbiAgICBpZiAodGhpcy5kYXNoRGF0YS5hY3RpdmUgfHwgdGhpcy5kYXNoRGF0YS5wYXVzZWQpIHtcbiAgICAgIC8vIEd1YXJkOiBza2lwIGRpc3BsYXkgd2hlbiBlbGFwc2VkIGlzIHplcm8gb3IgdW5yZWFzb25hYmx5IGxhcmdlICg+MzAgZGF5cylcbiAgICAgIGNvbnN0IGVsYXBzZWQgPSB0aGlzLmRhc2hEYXRhLmVsYXBzZWQ7XG4gICAgICBlbGFwc2VkUGFydHMgPSBlbGFwc2VkID4gMCAmJiBlbGFwc2VkIDwgMzAgKiAyNCAqIDM2MDBfMDAwXG4gICAgICAgID8gdGguZmcoXCJkaW1cIiwgZm9ybWF0RHVyYXRpb24oZWxhcHNlZCkpXG4gICAgICAgIDogXCJcIjtcbiAgICAgIGNvbnN0IGV0YSA9IGVzdGltYXRlVGltZVJlbWFpbmluZygpO1xuICAgICAgaWYgKGV0YSkgZWxhcHNlZFBhcnRzICs9IHRoLmZnKFwiZGltXCIsIGAgIFx1MDBCNyAgJHtldGF9YCk7XG4gICAgfSBlbHNlIGlmIChpc1JlbW90ZSkge1xuICAgICAgZWxhcHNlZFBhcnRzID0gdGguZmcoXCJkaW1cIiwgYHNpbmNlICR7dGhpcy5kYXNoRGF0YS5yZW1vdGVTZXNzaW9uIS5zdGFydGVkQXQucmVwbGFjZShcIlRcIiwgXCIgXCIpLnNsaWNlKDAsIDE5KX1gKTtcbiAgICB9XG4gICAgbGluZXMucHVzaChyb3coam9pbkNvbHVtbnMoYCR7dGl0bGV9ICAke3N0YXR1c30ke3dvcmt0cmVlVGFnfWAsIGVsYXBzZWRQYXJ0cywgY29udGVudFdpZHRoKSkpO1xuXG4gICAgLy8gUHJvZ3Jlc3Mgc2NvcmUgXHUyMDE0IHRyYWZmaWMgbGlnaHQgaW5kaWNhdG9yICgjMTIyMSlcbiAgICBpZiAodGhpcy5kYXNoRGF0YS5hY3RpdmUgfHwgdGhpcy5kYXNoRGF0YS5wYXVzZWQpIHtcbiAgICAgIGNvbnN0IHByb2dyZXNzU2NvcmUgPSBjb21wdXRlUHJvZ3Jlc3NTY29yZSgpO1xuICAgICAgY29uc3QgcHJvZ3Jlc3NJY29uID0gcHJvZ3Jlc3NTY29yZS5sZXZlbCA9PT0gXCJncmVlblwiID8gdGguZmcoXCJzdWNjZXNzXCIsIFwiXHUyNUNGXCIpXG4gICAgICAgIDogcHJvZ3Jlc3NTY29yZS5sZXZlbCA9PT0gXCJ5ZWxsb3dcIiA/IHRoLmZnKFwid2FybmluZ1wiLCBcIlx1MjVDRlwiKVxuICAgICAgICAgIDogdGguZmcoXCJlcnJvclwiLCBcIlx1MjVDRlwiKTtcbiAgICAgIGxpbmVzLnB1c2gocm93KGAke3Byb2dyZXNzSWNvbn0gJHt0aC5mZyhcInRleHRcIiwgcHJvZ3Jlc3NTY29yZS5zdW1tYXJ5KX1gKSk7XG5cbiAgICAgIC8vIFNob3cgc2lnbmFsIGRldGFpbHMgd2hlbiBkZWdyYWRlZCBcdTIwMTQgcmVhbC10aW1lIHZpc2liaWxpdHkgaW50byB3aGF0IGRvY3RvciBmb3VuZFxuICAgICAgaWYgKHByb2dyZXNzU2NvcmUubGV2ZWwgIT09IFwiZ3JlZW5cIiAmJiBwcm9ncmVzc1Njb3JlLnNpZ25hbHMubGVuZ3RoID4gMCkge1xuICAgICAgICBmb3IgKGNvbnN0IHNpZ25hbCBvZiBwcm9ncmVzc1Njb3JlLnNpZ25hbHMpIHtcbiAgICAgICAgICBjb25zdCBwcmVmaXggPSBzaWduYWwua2luZCA9PT0gXCJwb3NpdGl2ZVwiID8gdGguZmcoXCJzdWNjZXNzXCIsIFwiICBcdTI3MTNcIilcbiAgICAgICAgICAgIDogc2lnbmFsLmtpbmQgPT09IFwibmVnYXRpdmVcIiA/IHRoLmZnKFwiZXJyb3JcIiwgXCIgIFx1MjcxN1wiKVxuICAgICAgICAgICAgICA6IHRoLmZnKFwiZGltXCIsIFwiICBcdTAwQjdcIik7XG4gICAgICAgICAgbGluZXMucHVzaChyb3coYCR7cHJlZml4fSAke3RoLmZnKFwiZGltXCIsIHNpZ25hbC5sYWJlbCl9YCkpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIGxpbmVzLnB1c2goYmxhbmsoKSk7XG5cbiAgICBpZiAodGhpcy5kYXNoRGF0YS5jdXJyZW50VW5pdCkge1xuICAgICAgY29uc3QgY3UgPSB0aGlzLmRhc2hEYXRhLmN1cnJlbnRVbml0O1xuICAgICAgY29uc3QgY3VycmVudEVsYXBzZWQgPSB0aC5mZyhcImRpbVwiLCBmb3JtYXREdXJhdGlvbihEYXRlLm5vdygpIC0gY3Uuc3RhcnRlZEF0KSk7XG4gICAgICBsaW5lcy5wdXNoKHJvdyhqb2luQ29sdW1ucyhcbiAgICAgICAgYCR7dGguZmcoXCJ0ZXh0XCIsIFwiTm93XCIpfTogJHt0aC5mZyhcImFjY2VudFwiLCB1bml0TGFiZWwoY3UudHlwZSkpfSAke3RoLmZnKFwidGV4dFwiLCBjdS5pZCl9YCxcbiAgICAgICAgY3VycmVudEVsYXBzZWQsXG4gICAgICAgIGNvbnRlbnRXaWR0aCxcbiAgICAgICkpKTtcbiAgICAgIGxpbmVzLnB1c2goYmxhbmsoKSk7XG4gICAgfSBlbHNlIGlmICh0aGlzLmRhc2hEYXRhLnBhdXNlZCkge1xuICAgICAgbGluZXMucHVzaChyb3codGguZmcoXCJkaW1cIiwgXCIvZ3NkIGF1dG8gdG8gcmVzdW1lXCIpKSk7XG4gICAgICBsaW5lcy5wdXNoKGJsYW5rKCkpO1xuICAgIH0gZWxzZSBpZiAoaXNSZW1vdGUpIHtcbiAgICAgIGNvbnN0IHJzID0gdGhpcy5kYXNoRGF0YS5yZW1vdGVTZXNzaW9uITtcbiAgICAgIGNvbnN0IHVuaXREaXNwbGF5ID0gcnMudW5pdFR5cGUgPT09IFwic3RhcnRpbmdcIiB8fCBycy51bml0VHlwZSA9PT0gXCJyZXN1bWluZ1wiXG4gICAgICAgID8gcnMudW5pdFR5cGVcbiAgICAgICAgOiBgJHt1bml0TGFiZWwocnMudW5pdFR5cGUpfSAke3JzLnVuaXRJZH1gO1xuICAgICAgbGluZXMucHVzaChyb3codGguZmcoXCJ0ZXh0XCIsIGBSZW1vdGUgc2Vzc2lvbjogJHt1bml0RGlzcGxheX1gKSkpO1xuICAgICAgbGluZXMucHVzaChibGFuaygpKTtcbiAgICB9IGVsc2Uge1xuICAgICAgbGluZXMucHVzaChyb3codGguZmcoXCJkaW1cIiwgXCJObyB1bml0IHJ1bm5pbmcgXHUwMEI3IC9nc2QgYXV0byB0byBzdGFydFwiKSkpO1xuICAgICAgbGluZXMucHVzaChibGFuaygpKTtcbiAgICB9XG5cbiAgICAvLyBQYXJhbGxlbCB3b3JrZXJzIHNlY3Rpb24gXHUyMDE0IHNob3dzIGFjdGl2ZSBzdWJhZ2VudCBzZXNzaW9uc1xuICAgIGlmIChoYXNBY3RpdmVXb3JrZXJzKCkpIHtcbiAgICAgIGxpbmVzLnB1c2goaHIoKSk7XG4gICAgICBsaW5lcy5wdXNoKHJvdyh0aC5mZyhcInRleHRcIiwgdGguYm9sZChcIlBhcmFsbGVsIFdvcmtlcnNcIikpKSk7XG4gICAgICBsaW5lcy5wdXNoKGJsYW5rKCkpO1xuXG4gICAgICBjb25zdCBiYXRjaGVzID0gZ2V0V29ya2VyQmF0Y2hlcygpO1xuICAgICAgZm9yIChjb25zdCBbYmF0Y2hJZCwgd29ya2Vyc10gb2YgYmF0Y2hlcykge1xuICAgICAgICBjb25zdCBydW5uaW5nID0gd29ya2Vycy5maWx0ZXIodyA9PiB3LnN0YXR1cyA9PT0gXCJydW5uaW5nXCIpLmxlbmd0aDtcbiAgICAgICAgY29uc3QgZG9uZSA9IHdvcmtlcnMuZmlsdGVyKHcgPT4gdy5zdGF0dXMgPT09IFwiY29tcGxldGVkXCIpLmxlbmd0aDtcbiAgICAgICAgY29uc3QgZmFpbGVkID0gd29ya2Vycy5maWx0ZXIodyA9PiB3LnN0YXR1cyA9PT0gXCJmYWlsZWRcIikubGVuZ3RoO1xuICAgICAgICBjb25zdCB0b3RhbCA9IHdvcmtlcnNbMF0/LmJhdGNoU2l6ZSA/PyB3b3JrZXJzLmxlbmd0aDtcblxuICAgICAgICBsaW5lcy5wdXNoKHJvdyhqb2luQ29sdW1ucyhcbiAgICAgICAgICBgICAke3RoLmZnKFwiYWNjZW50XCIsIFwiXHUyN0QwXCIpfSAke3RoLmZnKFwidGV4dFwiLCBgQmF0Y2ggJHtiYXRjaElkLnNsaWNlKDAsIDgpfWApfWAsXG4gICAgICAgICAgdGguZmcoXCJkaW1cIiwgYCR7ZG9uZSArIGZhaWxlZH0vJHt0b3RhbH0gZG9uZWApLFxuICAgICAgICAgIGNvbnRlbnRXaWR0aCxcbiAgICAgICAgKSkpO1xuXG4gICAgICAgIGZvciAoY29uc3QgdyBvZiB3b3JrZXJzKSB7XG4gICAgICAgICAgY29uc3QgaWNvbiA9IHcuc3RhdHVzID09PSBcInJ1bm5pbmdcIlxuICAgICAgICAgICAgPyB0aC5mZyhcImFjY2VudFwiLCBcIlx1MjVCOFwiKVxuICAgICAgICAgICAgOiB3LnN0YXR1cyA9PT0gXCJjb21wbGV0ZWRcIlxuICAgICAgICAgICAgICA/IHRoLmZnKFwic3VjY2Vzc1wiLCBcIlx1MjcxM1wiKVxuICAgICAgICAgICAgICA6IHRoLmZnKFwiZXJyb3JcIiwgXCJcdTI3MTdcIik7XG4gICAgICAgICAgY29uc3QgZWxhcHNlZCA9IHRoLmZnKFwiZGltXCIsIGZvcm1hdER1cmF0aW9uKERhdGUubm93KCkgLSB3LnN0YXJ0ZWRBdCkpO1xuICAgICAgICAgIGNvbnN0IHRhc2tQcmV2aWV3ID0gdHJ1bmNhdGVUb1dpZHRoKHcudGFzaywgTWF0aC5tYXgoMjAsIGNvbnRlbnRXaWR0aCAtIDMwKSk7XG4gICAgICAgICAgbGluZXMucHVzaChyb3coam9pbkNvbHVtbnMoXG4gICAgICAgICAgICBgICAgICR7aWNvbn0gJHt0aC5mZyhcInRleHRcIiwgdy5hZ2VudCl9ICR7dGguZmcoXCJkaW1cIiwgdGFza1ByZXZpZXcpfWAsXG4gICAgICAgICAgICBlbGFwc2VkLFxuICAgICAgICAgICAgY29udGVudFdpZHRoLFxuICAgICAgICAgICkpKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgbGluZXMucHVzaChibGFuaygpKTtcbiAgICB9XG5cbiAgICAvLyBQZW5kaW5nIGNhcHR1cmVzIGJhZGdlIFx1MjAxNCBvbmx5IHNob3duIHdoZW4gY2FwdHVyZXMgYXJlIHdhaXRpbmcgZm9yIHRyaWFnZVxuICAgIGlmICh0aGlzLmRhc2hEYXRhLnBlbmRpbmdDYXB0dXJlQ291bnQgPiAwKSB7XG4gICAgICBjb25zdCBjb3VudCA9IHRoaXMuZGFzaERhdGEucGVuZGluZ0NhcHR1cmVDb3VudDtcbiAgICAgIGxpbmVzLnB1c2gocm93KHRoLmZnKFwid2FybmluZ1wiLCBgXHVEODNEXHVEQ0NDICR7Y291bnR9IHBlbmRpbmcgY2FwdHVyZSR7Y291bnQgPT09IDEgPyBcIlwiIDogXCJzXCJ9IGF3YWl0aW5nIHRyaWFnZWApKSk7XG4gICAgICBsaW5lcy5wdXNoKGJsYW5rKCkpO1xuICAgIH1cblxuICAgIGlmICh0aGlzLmxvYWRpbmcpIHtcbiAgICAgIGxpbmVzLnB1c2goY2VudGVyZWQodGguZmcoXCJkaW1cIiwgXCJMb2FkaW5nIGRhc2hib2FyZFx1MjAyNlwiKSkpO1xuICAgICAgcmV0dXJuIGxpbmVzO1xuICAgIH1cblxuICAgIGlmICh0aGlzLm1pbGVzdG9uZURhdGEpIHtcbiAgICAgIGNvbnN0IG12ID0gdGhpcy5taWxlc3RvbmVEYXRhO1xuICAgICAgbGluZXMucHVzaChyb3codGguZmcoXCJ0ZXh0XCIsIHRoLmJvbGQoYCR7bXYuaWR9OiAke212LnRpdGxlfWApKSkpO1xuICAgICAgbGluZXMucHVzaChibGFuaygpKTtcblxuICAgICAgY29uc3QgdG90YWxTbGljZXMgPSBtdi5zbGljZXMubGVuZ3RoO1xuICAgICAgY29uc3QgZG9uZVNsaWNlcyA9IG12LnNsaWNlcy5maWx0ZXIocyA9PiBzLmRvbmUpLmxlbmd0aDtcbiAgICAgIGNvbnN0IHRvdGFsTWlsZXN0b25lcyA9IG12LnByb2dyZXNzLm1pbGVzdG9uZXMudG90YWw7XG4gICAgICBjb25zdCBkb25lTWlsZXN0b25lcyA9IG12LnByb2dyZXNzLm1pbGVzdG9uZXMuZG9uZTtcbiAgICAgIGNvbnN0IGFjdGl2ZVNsaWNlID0gbXYuc2xpY2VzLmZpbmQocyA9PiBzLmFjdGl2ZSk7XG5cbiAgICAgIGxpbmVzLnB1c2goYmxhbmsoKSk7XG5cbiAgICAgIGlmIChhY3RpdmVTbGljZT8udGFza1Byb2dyZXNzKSB7XG4gICAgICAgIGxpbmVzLnB1c2gocm93KHRoaXMucmVuZGVyUHJvZ3Jlc3NSb3coXCJUYXNrc1wiLCBhY3RpdmVTbGljZS50YXNrUHJvZ3Jlc3MuZG9uZSwgYWN0aXZlU2xpY2UudGFza1Byb2dyZXNzLnRvdGFsLCBcImFjY2VudFwiLCBjb250ZW50V2lkdGgpKSk7XG4gICAgICB9XG4gICAgICBsaW5lcy5wdXNoKHJvdyh0aGlzLnJlbmRlclByb2dyZXNzUm93KFwiU2xpY2VzXCIsIGRvbmVTbGljZXMsIHRvdGFsU2xpY2VzLCBcInN1Y2Nlc3NcIiwgY29udGVudFdpZHRoKSkpO1xuICAgICAgbGluZXMucHVzaChyb3codGhpcy5yZW5kZXJQcm9ncmVzc1JvdyhcIk1pbGVzdG9uZXNcIiwgZG9uZU1pbGVzdG9uZXMsIHRvdGFsTWlsZXN0b25lcywgXCJ3YXJuaW5nXCIsIGNvbnRlbnRXaWR0aCkpKTtcblxuICAgICAgbGluZXMucHVzaChibGFuaygpKTtcblxuICAgICAgZm9yIChjb25zdCBzIG9mIG12LnNsaWNlcykge1xuICAgICAgICBjb25zdCBzbGljZVN0YXR1cyA9IHMuZG9uZSA/IFwiZG9uZVwiIDogcy5hY3RpdmUgPyBcImFjdGl2ZVwiIDogXCJwZW5kaW5nXCI7XG4gICAgICAgIGNvbnN0IGljb24gPSB0aC5mZyhTVEFUVVNfQ09MT1Jbc2xpY2VTdGF0dXNdLCBTVEFUVVNfR0xZUEhbc2xpY2VTdGF0dXNdKTtcbiAgICAgICAgY29uc3QgdGl0bGVDb2xvciA9IHMuYWN0aXZlID8gXCJhY2NlbnRcIiA6IHMuZG9uZSA/IFwibXV0ZWRcIiA6IFwiZGltXCI7XG4gICAgICAgIGNvbnN0IHRpdGxlVGV4dCA9IHRoLmZnKHRpdGxlQ29sb3IsIGAke3MuaWR9OiAke3MudGl0bGV9YCk7XG4gICAgICAgIGNvbnN0IHJpc2sgPSB0aC5mZyhcImRpbVwiLCBzLnJpc2spO1xuICAgICAgICBsaW5lcy5wdXNoKHJvdyhqb2luQ29sdW1ucyhgICAke2ljb259ICR7dGl0bGVUZXh0fWAsIHJpc2ssIGNvbnRlbnRXaWR0aCkpKTtcblxuICAgICAgICBpZiAocy5hY3RpdmUgJiYgcy50YXNrcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgZm9yIChjb25zdCB0IG9mIHMudGFza3MpIHtcbiAgICAgICAgICAgIGNvbnN0IHRhc2tTdGF0dXMgPSB0LmRvbmUgPyBcImRvbmVcIiA6IHQuYWN0aXZlID8gXCJhY3RpdmVcIiA6IFwicGVuZGluZ1wiO1xuICAgICAgICAgICAgY29uc3QgdEljb24gPSB0aC5mZyhTVEFUVVNfQ09MT1JbdGFza1N0YXR1c10sIFNUQVRVU19HTFlQSFt0YXNrU3RhdHVzXSk7XG4gICAgICAgICAgICBjb25zdCB0Q29sb3IgPSB0LmFjdGl2ZSA/IFwid2FybmluZ1wiIDogdC5kb25lID8gXCJtdXRlZFwiIDogXCJkaW1cIjtcbiAgICAgICAgICAgIGNvbnN0IHRUaXRsZSA9IHRoLmZnKHRDb2xvciwgYCR7dC5pZH06ICR7dC50aXRsZX1gKTtcbiAgICAgICAgICAgIGxpbmVzLnB1c2gocm93KGAgICAgICAke3RJY29ufSAke3RydW5jYXRlVG9XaWR0aCh0VGl0bGUsIGNvbnRlbnRXaWR0aCAtIDYpfWApKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgbGluZXMucHVzaChjZW50ZXJlZCh0aC5mZyhcImRpbVwiLCBcIk5vIGFjdGl2ZSBtaWxlc3RvbmUuXCIpKSk7XG4gICAgfVxuXG4gICAgY29uc3QgbGVkZ2VyID0gZ2V0TGVkZ2VyKCk7XG4gICAgaWYgKGxlZGdlciAmJiBsZWRnZXIudW5pdHMubGVuZ3RoID4gMCkge1xuICAgICAgY29uc3QgdG90YWxzID0gZ2V0UHJvamVjdFRvdGFscyhsZWRnZXIudW5pdHMpO1xuXG4gICAgICBsaW5lcy5wdXNoKGJsYW5rKCkpO1xuICAgICAgbGluZXMucHVzaChocigpKTtcbiAgICAgIGxpbmVzLnB1c2gocm93KHRoLmZnKFwidGV4dFwiLCB0aC5ib2xkKFwiQ29zdCAmIFVzYWdlXCIpKSkpO1xuICAgICAgbGluZXMucHVzaChibGFuaygpKTtcblxuICAgICAgLy8gU2hvdyBjb3N0IG9yIHJlcXVlc3QgY291bnQgKGZvciBjb3BpbG90L3N1YnNjcmlwdGlvbiB1c2VycyB3aGVyZSBjb3N0IGlzIDApXG4gICAgICBjb25zdCBjb3N0T3JSZXFzID0gdG90YWxzLmNvc3QgPiAwXG4gICAgICAgID8gYCR7dGguZmcoXCJ3YXJuaW5nXCIsIGZvcm1hdENvc3QodG90YWxzLmNvc3QpKX0gdG90YWxgXG4gICAgICAgIDogYCR7dGguZmcoXCJ0ZXh0XCIsIFN0cmluZyh0b3RhbHMuYXBpUmVxdWVzdHMpKX0gcmVxdWVzdHNgO1xuICAgICAgbGluZXMucHVzaChyb3coZml0Q29sdW1ucyhbXG4gICAgICAgIGNvc3RPclJlcXMsXG4gICAgICAgIGAke3RoLmZnKFwidGV4dFwiLCBmb3JtYXRUb2tlbkNvdW50KHRvdGFscy50b2tlbnMudG90YWwpKX0gdG9rZW5zYCxcbiAgICAgICAgYCR7dGguZmcoXCJ0ZXh0XCIsIFN0cmluZyh0b3RhbHMudG9vbENhbGxzKSl9IHRvb2xzYCxcbiAgICAgICAgYCR7dGguZmcoXCJ0ZXh0XCIsIFN0cmluZyh0b3RhbHMudW5pdHMpKX0gdW5pdHNgLFxuICAgICAgXSwgY29udGVudFdpZHRoLCBgICAke3RoLmZnKFwiZGltXCIsIFwiXHUwMEI3XCIpfSAgYCkpKTtcblxuICAgICAgbGluZXMucHVzaChyb3coZml0Q29sdW1ucyhbXG4gICAgICAgIGAke3RoLmZnKFwiZGltXCIsIFwiaW46XCIpfSAke3RoLmZnKFwidGV4dFwiLCBmb3JtYXRUb2tlbkNvdW50KHRvdGFscy50b2tlbnMuaW5wdXQpKX1gLFxuICAgICAgICBgJHt0aC5mZyhcImRpbVwiLCBcIm91dDpcIil9ICR7dGguZmcoXCJ0ZXh0XCIsIGZvcm1hdFRva2VuQ291bnQodG90YWxzLnRva2Vucy5vdXRwdXQpKX1gLFxuICAgICAgICBgJHt0aC5mZyhcImRpbVwiLCBcImNhY2hlLXI6XCIpfSAke3RoLmZnKFwidGV4dFwiLCBmb3JtYXRUb2tlbkNvdW50KHRvdGFscy50b2tlbnMuY2FjaGVSZWFkKSl9YCxcbiAgICAgICAgYCR7dGguZmcoXCJkaW1cIiwgXCJjYWNoZS13OlwiKX0gJHt0aC5mZyhcInRleHRcIiwgZm9ybWF0VG9rZW5Db3VudCh0b3RhbHMudG9rZW5zLmNhY2hlV3JpdGUpKX1gLFxuICAgICAgXSwgY29udGVudFdpZHRoLCBcIiAgXCIpKSk7XG5cbiAgICAgIC8vIEJ1ZGdldCBhZ2dyZWdhdGUgbGluZSBcdTIwMTQgb25seSB3aGVuIGRhdGEgZXhpc3RzXG4gICAgICBpZiAodG90YWxzLnRvdGFsVHJ1bmNhdGlvblNlY3Rpb25zID4gMCB8fCB0b3RhbHMuY29udGludWVIZXJlRmlyZWRDb3VudCA+IDApIHtcbiAgICAgICAgY29uc3QgYnVkZ2V0UGFydHM6IHN0cmluZ1tdID0gW107XG4gICAgICAgIGlmICh0b3RhbHMudG90YWxUcnVuY2F0aW9uU2VjdGlvbnMgPiAwKSB7XG4gICAgICAgICAgYnVkZ2V0UGFydHMucHVzaCh0aC5mZyhcIndhcm5pbmdcIiwgYCR7dG90YWxzLnRvdGFsVHJ1bmNhdGlvblNlY3Rpb25zfSBzZWN0aW9ucyB0cnVuY2F0ZWRgKSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHRvdGFscy5jb250aW51ZUhlcmVGaXJlZENvdW50ID4gMCkge1xuICAgICAgICAgIGJ1ZGdldFBhcnRzLnB1c2godGguZmcoXCJlcnJvclwiLCBgJHt0b3RhbHMuY29udGludWVIZXJlRmlyZWRDb3VudH0gY29udGludWUtaGVyZSBmaXJlZGApKTtcbiAgICAgICAgfVxuICAgICAgICBsaW5lcy5wdXNoKHJvdyhidWRnZXRQYXJ0cy5qb2luKGAgICR7dGguZmcoXCJkaW1cIiwgXCJcdTAwQjdcIil9ICBgKSkpO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBwaGFzZXMgPSBhZ2dyZWdhdGVCeVBoYXNlKGxlZGdlci51bml0cyk7XG4gICAgICBpZiAocGhhc2VzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgbGluZXMucHVzaChibGFuaygpKTtcbiAgICAgICAgbGluZXMucHVzaChyb3codGguZmcoXCJkaW1cIiwgXCJCeSBQaGFzZVwiKSkpO1xuICAgICAgICBmb3IgKGNvbnN0IHAgb2YgcGhhc2VzKSB7XG4gICAgICAgICAgY29uc3QgcGN0ID0gdG90YWxzLmNvc3QgPiAwID8gTWF0aC5yb3VuZCgocC5jb3N0IC8gdG90YWxzLmNvc3QpICogMTAwKSA6IDA7XG4gICAgICAgICAgY29uc3QgbGVmdCA9IGAgICR7dGguZmcoXCJ0ZXh0XCIsIHAucGhhc2UucGFkRW5kKDE0KSl9JHt0aC5mZyhcIndhcm5pbmdcIiwgZm9ybWF0Q29zdChwLmNvc3QpLnBhZFN0YXJ0KDgpKX1gO1xuICAgICAgICAgIGNvbnN0IHJpZ2h0ID0gdGguZmcoXCJkaW1cIiwgYCR7U3RyaW5nKHBjdCkucGFkU3RhcnQoMyl9JSAgJHtmb3JtYXRUb2tlbkNvdW50KHAudG9rZW5zLnRvdGFsKX0gdG9rICAke3AudW5pdHN9IHVuaXRzYCk7XG4gICAgICAgICAgbGluZXMucHVzaChyb3coam9pbkNvbHVtbnMobGVmdCwgcmlnaHQsIGNvbnRlbnRXaWR0aCkpKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBjb25zdCBzbGljZXMgPSBhZ2dyZWdhdGVCeVNsaWNlKGxlZGdlci51bml0cyk7XG4gICAgICBpZiAoc2xpY2VzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgbGluZXMucHVzaChibGFuaygpKTtcbiAgICAgICAgbGluZXMucHVzaChyb3codGguZmcoXCJkaW1cIiwgXCJCeSBTbGljZVwiKSkpO1xuICAgICAgICBmb3IgKGNvbnN0IHMgb2Ygc2xpY2VzKSB7XG4gICAgICAgICAgY29uc3QgcGN0ID0gdG90YWxzLmNvc3QgPiAwID8gTWF0aC5yb3VuZCgocy5jb3N0IC8gdG90YWxzLmNvc3QpICogMTAwKSA6IDA7XG4gICAgICAgICAgY29uc3QgbGVmdCA9IGAgICR7dGguZmcoXCJ0ZXh0XCIsIHMuc2xpY2VJZC5wYWRFbmQoMTQpKX0ke3RoLmZnKFwid2FybmluZ1wiLCBmb3JtYXRDb3N0KHMuY29zdCkucGFkU3RhcnQoOCkpfWA7XG4gICAgICAgICAgY29uc3QgcmlnaHQgPSB0aC5mZyhcImRpbVwiLCBgJHtTdHJpbmcocGN0KS5wYWRTdGFydCgzKX0lICAke2Zvcm1hdFRva2VuQ291bnQocy50b2tlbnMudG90YWwpfSB0b2sgICR7Zm9ybWF0RHVyYXRpb24ocy5kdXJhdGlvbil9YCk7XG4gICAgICAgICAgbGluZXMucHVzaChyb3coam9pbkNvbHVtbnMobGVmdCwgcmlnaHQsIGNvbnRlbnRXaWR0aCkpKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBDb3N0IHByb2plY3Rpb24gXHUyMDE0IG9ubHkgd2hlbiBhY3RpdmUgbWlsZXN0b25lIGRhdGEgaXMgYXZhaWxhYmxlXG4gICAgICBpZiAodGhpcy5taWxlc3RvbmVEYXRhKSB7XG4gICAgICAgIGNvbnN0IG12ID0gdGhpcy5taWxlc3RvbmVEYXRhO1xuICAgICAgICBjb25zdCBtc1RvdGFsU2xpY2VzID0gbXYuc2xpY2VzLmxlbmd0aDtcbiAgICAgICAgY29uc3QgbXNEb25lU2xpY2VzID0gbXYuc2xpY2VzLmZpbHRlcihzID0+IHMuZG9uZSkubGVuZ3RoO1xuICAgICAgICBjb25zdCByZW1haW5pbmdDb3VudCA9IG1zVG90YWxTbGljZXMgLSBtc0RvbmVTbGljZXM7XG4gICAgICAgIGNvbnN0IG92ZXJsYXlQcmVmcyA9IGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcygpPy5wcmVmZXJlbmNlcztcbiAgICAgICAgY29uc3QgcHJvakxpbmVzID0gZm9ybWF0Q29zdFByb2plY3Rpb24oc2xpY2VzLCByZW1haW5pbmdDb3VudCwgb3ZlcmxheVByZWZzPy5idWRnZXRfY2VpbGluZyk7XG4gICAgICAgIGlmIChwcm9qTGluZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgIGxpbmVzLnB1c2goYmxhbmsoKSk7XG4gICAgICAgICAgZm9yIChjb25zdCBsaW5lIG9mIHByb2pMaW5lcykge1xuICAgICAgICAgICAgY29uc3QgY29sb3JlZCA9IGxpbmUudG9Mb3dlckNhc2UoKS5pbmNsdWRlcygnY2VpbGluZycpXG4gICAgICAgICAgICAgID8gdGguZmcoXCJ3YXJuaW5nXCIsIGxpbmUpXG4gICAgICAgICAgICAgIDogdGguZmcoXCJkaW1cIiwgbGluZSk7XG4gICAgICAgICAgICBsaW5lcy5wdXNoKHJvdyhjb2xvcmVkKSk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IG1vZGVscyA9IGFnZ3JlZ2F0ZUJ5TW9kZWwobGVkZ2VyLnVuaXRzKTtcbiAgICAgIGlmIChtb2RlbHMubGVuZ3RoID49IDEpIHtcbiAgICAgICAgbGluZXMucHVzaChibGFuaygpKTtcbiAgICAgICAgbGluZXMucHVzaChyb3codGguZmcoXCJkaW1cIiwgXCJCeSBNb2RlbFwiKSkpO1xuICAgICAgICBmb3IgKGNvbnN0IG0gb2YgbW9kZWxzKSB7XG4gICAgICAgICAgY29uc3QgcGN0ID0gdG90YWxzLmNvc3QgPiAwID8gTWF0aC5yb3VuZCgobS5jb3N0IC8gdG90YWxzLmNvc3QpICogMTAwKSA6IDA7XG4gICAgICAgICAgY29uc3QgbW9kZWxOYW1lID0gdHJ1bmNhdGVUb1dpZHRoKG0ubW9kZWwsIDM4KTtcbiAgICAgICAgICBjb25zdCBjdHhXaW5kb3cgPSBtLmNvbnRleHRXaW5kb3dUb2tlbnMgIT09IHVuZGVmaW5lZFxuICAgICAgICAgICAgPyB0aC5mZyhcImRpbVwiLCBgIFske2Zvcm1hdFRva2VuQ291bnQobS5jb250ZXh0V2luZG93VG9rZW5zKX1dYClcbiAgICAgICAgICAgIDogXCJcIjtcbiAgICAgICAgICBjb25zdCBsZWZ0ID0gYCAgJHt0aC5mZyhcInRleHRcIiwgbW9kZWxOYW1lLnBhZEVuZCgzOCkpfSR7dGguZmcoXCJ3YXJuaW5nXCIsIGZvcm1hdENvc3QobS5jb3N0KS5wYWRTdGFydCg4KSl9YDtcbiAgICAgICAgICBjb25zdCByaWdodCA9IHRoLmZnKFwiZGltXCIsIGAke1N0cmluZyhwY3QpLnBhZFN0YXJ0KDMpfSUgICR7bS51bml0c30gdW5pdHNgKSArIGN0eFdpbmRvdztcbiAgICAgICAgICBsaW5lcy5wdXNoKHJvdyhqb2luQ29sdW1ucyhsZWZ0LCByaWdodCwgY29udGVudFdpZHRoKSkpO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGxpbmVzLnB1c2goYmxhbmsoKSk7XG4gICAgICBsaW5lcy5wdXNoKHJvdyhgJHt0aC5mZyhcImRpbVwiLCBcImF2Zy91bml0OlwiKX0gJHt0aC5mZyhcInRleHRcIiwgZm9ybWF0Q29zdCh0b3RhbHMuY29zdCAvIHRvdGFscy51bml0cykpfSAgJHt0aC5mZyhcImRpbVwiLCBcIlx1MDBCN1wiKX0gICR7dGguZmcoXCJ0ZXh0XCIsIGZvcm1hdFRva2VuQ291bnQoTWF0aC5yb3VuZCh0b3RhbHMudG9rZW5zLnRvdGFsIC8gdG90YWxzLnVuaXRzKSkpfSB0b2tlbnNgKSk7XG5cbiAgICAgIC8vIENhY2hlIGhpdCByYXRlXG4gICAgICBjb25zdCBjYWNoZVJhdGUgPSBhZ2dyZWdhdGVDYWNoZUhpdFJhdGUoKTtcbiAgICAgIGlmIChjYWNoZVJhdGUgPiAwKSB7XG4gICAgICAgIGxpbmVzLnB1c2gocm93KGAke3RoLmZnKFwiZGltXCIsIFwiY2FjaGUgaGl0IHJhdGU6XCIpfSAke3RoLmZnKFwidGV4dFwiLCBgJHtjYWNoZVJhdGV9JWApfWApKTtcbiAgICAgIH1cblxuICAgICAgaWYgKHRoaXMuZGFzaERhdGEucnRrRW5hYmxlZCAmJiB0aGlzLmRhc2hEYXRhLnJ0a1NhdmluZ3MgJiYgdGhpcy5kYXNoRGF0YS5ydGtTYXZpbmdzLmNvbW1hbmRzID4gMCkge1xuICAgICAgICBjb25zdCBydGsgPSB0aGlzLmRhc2hEYXRhLnJ0a1NhdmluZ3M7XG4gICAgICAgIGxpbmVzLnB1c2gocm93KFxuICAgICAgICAgIGAke3RoLmZnKFwiZGltXCIsIFwicnRrIHNhdmVkOlwiKX0gJHt0aC5mZyhcInRleHRcIiwgZm9ybWF0VG9rZW5Db3VudChydGsuc2F2ZWRUb2tlbnMpKX0gJHt0aC5mZyhcImRpbVwiLCBgKCR7TWF0aC5yb3VuZChydGsuc2F2aW5nc1BjdCl9JSBcdTAwQjcgJHtydGsuY29tbWFuZHN9IGNtZCR7cnRrLmNvbW1hbmRzID09PSAxID8gXCJcIiA6IFwic1wifSlgKX1gLFxuICAgICAgICApKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBFbnZpcm9ubWVudCBoZWFsdGggc2VjdGlvbiAoIzEyMjEpIFx1MjAxNCBvbmx5IHNob3cgaXNzdWVzXG4gICAgY29uc3QgZW52UmVzdWx0cyA9IHJ1bkVudmlyb25tZW50Q2hlY2tzKHRoaXMuZGFzaERhdGEuYmFzZVBhdGggfHwgcHJvY2Vzcy5jd2QoKSk7XG4gICAgY29uc3QgZW52SXNzdWVzID0gZW52UmVzdWx0cy5maWx0ZXIociA9PiByLnN0YXR1cyAhPT0gXCJva1wiKTtcbiAgICBpZiAoZW52SXNzdWVzLmxlbmd0aCA+IDApIHtcbiAgICAgIGxpbmVzLnB1c2goYmxhbmsoKSk7XG4gICAgICBsaW5lcy5wdXNoKGhyKCkpO1xuICAgICAgbGluZXMucHVzaChyb3codGguZmcoXCJ0ZXh0XCIsIHRoLmJvbGQoXCJFbnZpcm9ubWVudFwiKSkpKTtcbiAgICAgIGxpbmVzLnB1c2goYmxhbmsoKSk7XG4gICAgICBmb3IgKGNvbnN0IHIgb2YgZW52SXNzdWVzKSB7XG4gICAgICAgIGNvbnN0IGljb24gPSByLnN0YXR1cyA9PT0gXCJlcnJvclwiID8gdGguZmcoXCJlcnJvclwiLCBcIlx1MjcxN1wiKSA6IHRoLmZnKFwid2FybmluZ1wiLCBcIlx1MjZBMFwiKTtcbiAgICAgICAgbGluZXMucHVzaChyb3coYCAgJHtpY29ufSAke3RoLmZnKFwidGV4dFwiLCByLm1lc3NhZ2UpfWApKTtcbiAgICAgICAgaWYgKHIuZGV0YWlsKSB7XG4gICAgICAgICAgbGluZXMucHVzaChyb3codGguZmcoXCJkaW1cIiwgYCAgICAgJHtyLmRldGFpbH1gKSkpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgbGluZXMucHVzaChibGFuaygpKTtcbiAgICBsaW5lcy5wdXNoKGhyKCkpO1xuICAgIGxpbmVzLnB1c2goY2VudGVyZWQodGguZmcoXCJkaW1cIiwgYFx1MjE5MVx1MjE5MyBzY3JvbGwgXHUwMEI3IGcvRyB0b3AvZW5kIFx1MDBCNyBFc2MvJHtmb3JtYXR0ZWRTaG9ydGN1dFBhaXIoXCJkYXNoYm9hcmRcIil9IGNsb3NlYCkpKTtcblxuICAgIHJldHVybiBsaW5lcztcbiAgfVxuXG4gIHByaXZhdGUgcmVuZGVyUHJvZ3Jlc3NSb3coXG4gICAgbGFiZWw6IHN0cmluZyxcbiAgICBkb25lOiBudW1iZXIsXG4gICAgdG90YWw6IG51bWJlcixcbiAgICBjb2xvcjogXCJzdWNjZXNzXCIgfCBcImFjY2VudFwiIHwgXCJ3YXJuaW5nXCIsXG4gICAgd2lkdGg6IG51bWJlcixcbiAgKTogc3RyaW5nIHtcbiAgICBjb25zdCB0aCA9IHRoaXMudGhlbWU7XG4gICAgY29uc3QgcGN0ID0gdG90YWwgPiAwID8gTWF0aC5yb3VuZCgoZG9uZSAvIHRvdGFsKSAqIDEwMCkgOiAwO1xuICAgIGNvbnN0IGxhYmVsV2lkdGggPSAxMjtcbiAgICBjb25zdCByaWdodFdpZHRoID0gMTQ7XG4gICAgY29uc3QgZ2FwID0gMjtcbiAgICBjb25zdCBsYWJlbFRleHQgPSB0cnVuY2F0ZVRvV2lkdGgobGFiZWwsIGxhYmVsV2lkdGgsIFwiXCIpLnBhZEVuZChsYWJlbFdpZHRoKTtcbiAgICBjb25zdCByYXRpb1RleHQgPSBgJHtkb25lfS8ke3RvdGFsfWA7XG4gICAgY29uc3QgcmlnaHRUZXh0ID0gYCR7U3RyaW5nKHBjdCkucGFkU3RhcnQoMyl9JSAgJHtyYXRpb1RleHQucGFkU3RhcnQocmlnaHRXaWR0aCAtIDUpfWA7XG4gICAgY29uc3QgYmFyV2lkdGggPSBNYXRoLm1heCgxMiwgd2lkdGggLSBsYWJlbFdpZHRoIC0gcmlnaHRXaWR0aCAtIGdhcCAqIDIpO1xuICAgIGNvbnN0IGZpbGxlZCA9IHRvdGFsID4gMCA/IE1hdGgucm91bmQoKGRvbmUgLyB0b3RhbCkgKiBiYXJXaWR0aCkgOiAwO1xuICAgIGNvbnN0IGJhciA9IHRoLmZnKGNvbG9yLCBcIlx1MjU4OFwiLnJlcGVhdChmaWxsZWQpKSArIHRoLmZnKFwiZGltXCIsIFwiXHUyNTkxXCIucmVwZWF0KE1hdGgubWF4KDAsIGJhcldpZHRoIC0gZmlsbGVkKSkpO1xuICAgIHJldHVybiBgJHt0aC5mZyhcImRpbVwiLCBsYWJlbFRleHQpfSR7XCIgXCIucmVwZWF0KGdhcCl9JHtiYXJ9JHtcIiBcIi5yZXBlYXQoZ2FwKX0ke3RoLmZnKFwiZGltXCIsIHJpZ2h0VGV4dCl9YDtcbiAgfVxuXG4gIGludmFsaWRhdGUoKTogdm9pZCB7XG4gICAgdGhpcy5jYWNoZWRXaWR0aCA9IHVuZGVmaW5lZDtcbiAgICB0aGlzLmNhY2hlZExpbmVzID0gdW5kZWZpbmVkO1xuICB9XG5cbiAgZGlzcG9zZSgpOiB2b2lkIHtcbiAgICB0aGlzLmRpc3Bvc2VkID0gdHJ1ZTtcbiAgICBjbGVhckludGVydmFsKHRoaXMucmVmcmVzaFRpbWVyKTtcbiAgICBpZiAodGhpcy5yZXNpemVIYW5kbGVyKSB7XG4gICAgICBwcm9jZXNzLnN0ZG91dC5yZW1vdmVMaXN0ZW5lcihcInJlc2l6ZVwiLCB0aGlzLnJlc2l6ZUhhbmRsZXIpO1xuICAgICAgdGhpcy5yZXNpemVIYW5kbGVyID0gbnVsbDtcbiAgICB9XG4gIH1cbn1cblxuaW50ZXJmYWNlIE1pbGVzdG9uZVZpZXcge1xuICBpZDogc3RyaW5nO1xuICB0aXRsZTogc3RyaW5nO1xuICBzbGljZXM6IFNsaWNlVmlld1tdO1xuICBwaGFzZTogc3RyaW5nO1xuICBwcm9ncmVzczoge1xuICAgIG1pbGVzdG9uZXM6IHtcbiAgICAgIHRvdGFsOiBudW1iZXI7XG4gICAgICBkb25lOiBudW1iZXI7XG4gICAgfTtcbiAgfTtcbn1cblxuaW50ZXJmYWNlIFNsaWNlVmlldyB7XG4gIGlkOiBzdHJpbmc7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIGRvbmU6IGJvb2xlYW47XG4gIHJpc2s6IHN0cmluZztcbiAgYWN0aXZlOiBib29sZWFuO1xuICB0YXNrczogVGFza1ZpZXdbXTtcbiAgdGFza1Byb2dyZXNzPzogeyBkb25lOiBudW1iZXI7IHRvdGFsOiBudW1iZXIgfTtcbn1cblxuaW50ZXJmYWNlIFRhc2tWaWV3IHtcbiAgaWQ6IHN0cmluZztcbiAgdGl0bGU6IHN0cmluZztcbiAgZG9uZTogYm9vbGVhbjtcbiAgYWN0aXZlOiBib29sZWFuO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBVUEsU0FBUyxpQkFBaUIsY0FBYyxZQUFZLFdBQVc7QUFDL0QsU0FBUyxtQkFBbUI7QUFDNUIsU0FBUyxnQkFBZ0I7QUFDekIsU0FBUyxlQUFlLG9CQUFvQixxQkFBcUI7QUFDakUsU0FBUyw0QkFBOEM7QUFDdkQsU0FBUyw0QkFBNEI7QUFFckM7QUFBQSxFQUNFO0FBQUEsRUFBVztBQUFBLEVBQWtCO0FBQUEsRUFBa0I7QUFBQSxFQUMvQztBQUFBLEVBQWtCO0FBQUEsRUFBdUI7QUFBQSxFQUFZO0FBQUEsRUFBa0I7QUFBQSxPQUVsRTtBQUNQLFNBQVMsbUNBQW1DO0FBQzVDLFNBQVMsNkJBQTZCO0FBQ3RDLFNBQVMsa0JBQWtCLHdCQUEwQztBQUNyRSxTQUFTLGdCQUFnQixVQUFVLGFBQWEsWUFBWSxZQUFZLGNBQWMsb0JBQW9CO0FBQzFHLFNBQVMsNkJBQTZCO0FBQ3RDLFNBQVMsNEJBQWdEO0FBQ3pELFNBQVMsNEJBQXlEO0FBQ2xFLFNBQVMsNkJBQTZCO0FBRS9CLFNBQVMsVUFBVSxNQUFzQjtBQUM5QyxVQUFRLE1BQU07QUFBQSxJQUNaLEtBQUs7QUFBQSxJQUNMLEtBQUs7QUFBaUIsYUFBTztBQUFBLElBQzdCLEtBQUs7QUFBc0IsYUFBTztBQUFBLElBQ2xDLEtBQUs7QUFBa0IsYUFBTztBQUFBLElBQzlCLEtBQUs7QUFBa0IsYUFBTztBQUFBLElBQzlCLEtBQUs7QUFBYyxhQUFPO0FBQUEsSUFDMUIsS0FBSztBQUFnQixhQUFPO0FBQUEsSUFDNUIsS0FBSztBQUFrQixhQUFPO0FBQUEsSUFDOUIsS0FBSztBQUFvQixhQUFPO0FBQUEsSUFDaEMsS0FBSztBQUFtQixhQUFPO0FBQUEsSUFDL0IsS0FBSztBQUFjLGFBQU87QUFBQSxJQUMxQixLQUFLO0FBQWdCLGFBQU87QUFBQSxJQUM1QixLQUFLO0FBQWUsYUFBTztBQUFBLElBQzNCO0FBQVMsYUFBTztBQUFBLEVBQ2xCO0FBQ0Y7QUFHTyxNQUFNLG9CQUFvQjtBQUFBLEVBQ3ZCO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBLGVBQWU7QUFBQSxFQUNmO0FBQUEsRUFDQSxnQkFBc0M7QUFBQSxFQUN0QyxVQUFVO0FBQUEsRUFDVjtBQUFBLEVBQ0Esa0JBQXdDO0FBQUEsRUFDeEMsV0FBVztBQUFBLEVBQ1gsZ0JBQXFDO0FBQUEsRUFFN0MsWUFDRSxLQUNBLE9BQ0EsU0FDQTtBQUNBLFNBQUssTUFBTTtBQUNYLFNBQUssUUFBUTtBQUNiLFNBQUssVUFBVTtBQUNmLFNBQUssV0FBVyxxQkFBcUI7QUFHckMsU0FBSyxnQkFBZ0IsTUFBTTtBQUN6QixVQUFJLEtBQUssU0FBVTtBQUNuQixXQUFLLFdBQVc7QUFDaEIsV0FBSyxJQUFJLGNBQWM7QUFBQSxJQUN6QjtBQUNBLFlBQVEsT0FBTyxHQUFHLFVBQVUsS0FBSyxhQUFhO0FBRTlDLFNBQUssZ0JBQWdCLElBQUk7QUFFekIsU0FBSyxlQUFlLFlBQVksTUFBTTtBQUNwQyxXQUFLLGdCQUFnQjtBQUFBLElBQ3ZCLEdBQUcsR0FBSTtBQUFBLEVBQ1Q7QUFBQSxFQUVRLGdCQUFnQixVQUFVLE9BQWE7QUFDN0MsUUFBSSxLQUFLLG1CQUFtQixLQUFLLFNBQVU7QUFDM0MsU0FBSyxrQkFBa0IsS0FBSyxpQkFBaUIsT0FBTyxFQUNqRCxRQUFRLE1BQU07QUFDYixXQUFLLGtCQUFrQjtBQUFBLElBQ3pCLENBQUM7QUFBQSxFQUNMO0FBQUEsRUFFUSx5QkFBeUIsVUFBcUM7QUFDcEUsVUFBTSxPQUFPLFNBQVMsWUFBWSxRQUFRLElBQUk7QUFDOUMsVUFBTSxjQUFjLFNBQVMsY0FDekIsR0FBRyxTQUFTLFlBQVksSUFBSSxJQUFJLFNBQVMsWUFBWSxFQUFFLElBQUksU0FBUyxZQUFZLFNBQVMsS0FDekY7QUFDSixXQUFPO0FBQUEsTUFDTDtBQUFBLE1BQ0EsU0FBUyxTQUFTLE1BQU07QUFBQSxNQUN4QixTQUFTLFNBQVMsTUFBTTtBQUFBLE1BQ3hCO0FBQUEsSUFDRixFQUFFLEtBQUssR0FBRztBQUFBLEVBQ1o7QUFBQSxFQUVBLE1BQWMsaUJBQWlCLFVBQVUsT0FBc0I7QUFDN0QsUUFBSSxLQUFLLFNBQVU7QUFDbkIsU0FBSyxXQUFXLHFCQUFxQjtBQUNyQyxVQUFNLGVBQWUsS0FBSyx5QkFBeUIsS0FBSyxRQUFRO0FBRWhFLFFBQUksV0FBVyxpQkFBaUIsS0FBSyx5QkFBeUI7QUFDNUQsWUFBTSxTQUFTLE1BQU0sS0FBSyxTQUFTO0FBQ25DLFVBQUksS0FBSyxTQUFVO0FBQ25CLFVBQUksUUFBUTtBQUNWLGFBQUssMEJBQTBCO0FBQUEsTUFDakM7QUFBQSxJQUNGO0FBRUEsUUFBSSxTQUFTO0FBQ1gsV0FBSyxVQUFVO0FBQUEsSUFDakI7QUFFQSxTQUFLLFdBQVc7QUFDaEIsU0FBSyxJQUFJLGNBQWM7QUFBQSxFQUN6QjtBQUFBLEVBRUEsTUFBYyxXQUE2QjtBQUN6QyxVQUFNLE9BQU8sS0FBSyxTQUFTLFlBQVksUUFBUSxJQUFJO0FBQ25ELFFBQUk7QUFDRixZQUFNLFFBQVEsTUFBTSxZQUFZLElBQUk7QUFDcEMsVUFBSSxDQUFDLE1BQU0saUJBQWlCO0FBQzFCLGFBQUssZ0JBQWdCO0FBQ3JCLGVBQU87QUFBQSxNQUNUO0FBRUEsWUFBTSxNQUFNLE1BQU0sZ0JBQWdCO0FBQ2xDLFlBQU0sT0FBc0I7QUFBQSxRQUMxQixJQUFJO0FBQUEsUUFDSixPQUFPLE1BQU0sZ0JBQWdCO0FBQUEsUUFDN0IsUUFBUSxDQUFDO0FBQUEsUUFDVCxPQUFPLE1BQU07QUFBQSxRQUNiLFVBQVU7QUFBQSxVQUNSLFlBQVk7QUFBQSxZQUNWLE9BQU8sTUFBTSxVQUFVLFdBQVcsU0FBUyxNQUFNLFNBQVM7QUFBQSxZQUMxRCxNQUFNLE1BQU0sVUFBVSxXQUFXLFFBQVEsTUFBTSxTQUFTLE9BQU8sV0FBUyxNQUFNLFdBQVcsVUFBVSxFQUFFO0FBQUEsVUFDdkc7QUFBQSxRQUNGO0FBQUEsTUFDRjtBQUVBLFlBQU0sY0FBYyxxQkFBcUIsTUFBTSxLQUFLLFNBQVM7QUFDN0QsWUFBTSxpQkFBaUIsY0FBYyxNQUFNLFNBQVMsV0FBVyxJQUFJO0FBR25FLFVBQUksYUFBMEIsQ0FBQztBQUMvQixVQUFJLGNBQWMsR0FBRztBQUNuQixxQkFBYSxtQkFBbUIsR0FBRyxFQUFFLElBQUksUUFBTSxFQUFFLElBQUksRUFBRSxJQUFJLE1BQU0sRUFBRSxXQUFXLFlBQVksT0FBTyxFQUFFLE9BQU8sTUFBTSxFQUFFLFFBQVEsU0FBUyxFQUFFO0FBQUEsTUFDdkk7QUFFQSxpQkFBVyxLQUFLLFlBQVk7QUFDeEIsY0FBTSxZQUF1QjtBQUFBLFVBQzNCLElBQUksRUFBRTtBQUFBLFVBQ04sT0FBTyxFQUFFO0FBQUEsVUFDVCxNQUFNLEVBQUU7QUFBQSxVQUNSLE1BQU0sRUFBRTtBQUFBLFVBQ1IsUUFBUSxNQUFNLGFBQWEsT0FBTyxFQUFFO0FBQUEsVUFDcEMsT0FBTyxDQUFDO0FBQUEsUUFDVjtBQUVBLFlBQUksVUFBVSxRQUFRO0FBRXBCLGNBQUksY0FBYyxHQUFHO0FBQ25CLGtCQUFNLFVBQVUsY0FBYyxLQUFLLEVBQUUsRUFBRTtBQUN2QyxzQkFBVSxlQUFlO0FBQUEsY0FDdkIsTUFBTSxRQUFRLE9BQU8sT0FBSyxFQUFFLFdBQVcsY0FBYyxFQUFFLFdBQVcsTUFBTSxFQUFFO0FBQUEsY0FDMUUsT0FBTyxRQUFRO0FBQUEsWUFDakI7QUFDQSx1QkFBVyxLQUFLLFNBQVM7QUFDdkIsd0JBQVUsTUFBTSxLQUFLO0FBQUEsZ0JBQ25CLElBQUksRUFBRTtBQUFBLGdCQUNOLE9BQU8sRUFBRTtBQUFBLGdCQUNULE1BQU0sRUFBRSxXQUFXLGNBQWMsRUFBRSxXQUFXO0FBQUEsZ0JBQzlDLFFBQVEsTUFBTSxZQUFZLE9BQU8sRUFBRTtBQUFBLGNBQ3JDLENBQUM7QUFBQSxZQUNIO0FBQUEsVUFDRjtBQUFBLFFBQ0Y7QUFFQSxhQUFLLE9BQU8sS0FBSyxTQUFTO0FBQUEsTUFDOUI7QUFFQSxXQUFLLGdCQUFnQjtBQUNyQixhQUFPO0FBQUEsSUFDVCxRQUFRO0FBRU4sYUFBTztBQUFBLElBQ1Q7QUFBQSxFQUNGO0FBQUEsRUFFQSxZQUFZLE1BQW9CO0FBQzlCLFFBQ0UsV0FBVyxNQUFNLElBQUksTUFBTSxLQUMzQixXQUFXLE1BQU0sSUFBSSxLQUFLLEdBQUcsQ0FBQyxLQUM5QixXQUFXLE1BQU0sSUFBSSxRQUFRLEdBQUcsQ0FBQyxLQUNqQyxXQUFXLE1BQU0sSUFBSSxVQUFVLEdBQUcsQ0FBQyxHQUNuQztBQUNBLFdBQUssUUFBUTtBQUNiLFdBQUssUUFBUTtBQUNiO0FBQUEsSUFDRjtBQUVBLFFBQUksV0FBVyxNQUFNLElBQUksSUFBSSxLQUFLLFdBQVcsTUFBTSxHQUFHLEdBQUc7QUFDdkQsV0FBSztBQUNMLFdBQUssV0FBVztBQUNoQixXQUFLLElBQUksY0FBYztBQUN2QjtBQUFBLElBQ0Y7QUFFQSxRQUFJLFdBQVcsTUFBTSxJQUFJLEVBQUUsS0FBSyxXQUFXLE1BQU0sR0FBRyxHQUFHO0FBQ3JELFdBQUssZUFBZSxLQUFLLElBQUksR0FBRyxLQUFLLGVBQWUsQ0FBQztBQUNyRCxXQUFLLFdBQVc7QUFDaEIsV0FBSyxJQUFJLGNBQWM7QUFDdkI7QUFBQSxJQUNGO0FBRUEsUUFBSSxTQUFTLEtBQUs7QUFDaEIsV0FBSyxlQUFlO0FBQ3BCLFdBQUssV0FBVztBQUNoQixXQUFLLElBQUksY0FBYztBQUN2QjtBQUFBLElBQ0Y7QUFFQSxRQUFJLFNBQVMsS0FBSztBQUNoQixXQUFLLGVBQWU7QUFDcEIsV0FBSyxXQUFXO0FBQ2hCLFdBQUssSUFBSSxjQUFjO0FBQ3ZCO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFBQSxFQUVBLE9BQU8sT0FBeUI7QUFDOUIsUUFBSSxLQUFLLGVBQWUsS0FBSyxnQkFBZ0IsT0FBTztBQUNsRCxhQUFPLEtBQUs7QUFBQSxJQUNkO0FBRUEsVUFBTSxVQUFVLEtBQUssa0JBQWtCLEtBQUs7QUFDNUMsVUFBTSxpQkFBaUIsS0FBSyxJQUFJLEdBQUcsUUFBUSxPQUFPLE9BQU8sUUFBUSxPQUFPLE9BQU8sSUFBSSxFQUFFO0FBQ3JGLFVBQU0sZUFBZTtBQUNyQixVQUFNLHFCQUFxQixLQUFLLElBQUksR0FBRyxpQkFBaUIsWUFBWTtBQUNwRSxVQUFNLFlBQVksS0FBSyxJQUFJLEdBQUcsUUFBUSxTQUFTLGtCQUFrQjtBQUNqRSxTQUFLLGVBQWUsS0FBSyxJQUFJLEtBQUssY0FBYyxTQUFTO0FBQ3pELFVBQU0saUJBQWlCLFFBQVEsTUFBTSxLQUFLLGNBQWMsS0FBSyxlQUFlLGtCQUFrQjtBQUU5RixVQUFNLFFBQVEsS0FBSyxVQUFVLGdCQUFnQixLQUFLO0FBRWxELFNBQUssY0FBYztBQUNuQixTQUFLLGNBQWM7QUFDbkIsV0FBTztBQUFBLEVBQ1Q7QUFBQSxFQUVRLFVBQVUsT0FBaUIsT0FBeUI7QUFDMUQsVUFBTSxLQUFLLEtBQUs7QUFDaEIsVUFBTSxTQUFTLENBQUMsTUFBYyxHQUFHLEdBQUcsZ0JBQWdCLENBQUM7QUFDckQsVUFBTSxhQUFhLFFBQVE7QUFDM0IsVUFBTSxRQUFrQixDQUFDO0FBRXpCLFVBQU0sS0FBSyxPQUFPLFdBQU0sU0FBSSxPQUFPLFFBQVEsQ0FBQyxJQUFJLFFBQUcsQ0FBQztBQUNwRCxlQUFXLFFBQVEsT0FBTztBQUN4QixZQUFNLFlBQVksZ0JBQWdCLE1BQU0sVUFBVTtBQUNsRCxZQUFNLFdBQVcsS0FBSyxJQUFJLEdBQUcsYUFBYSxhQUFhLFNBQVMsQ0FBQztBQUNqRSxZQUFNLEtBQUssT0FBTyxRQUFHLElBQUksTUFBTSxZQUFZLElBQUksT0FBTyxRQUFRLElBQUksTUFBTSxPQUFPLFFBQUcsQ0FBQztBQUFBLElBQ3JGO0FBQ0EsVUFBTSxLQUFLLE9BQU8sV0FBTSxTQUFJLE9BQU8sUUFBUSxDQUFDLElBQUksUUFBRyxDQUFDO0FBQ3BELFdBQU87QUFBQSxFQUNUO0FBQUEsRUFFUSxrQkFBa0IsT0FBeUI7QUFDakQsVUFBTSxLQUFLLEtBQUs7QUFDaEIsVUFBTSxhQUFhLFFBQVE7QUFDM0IsVUFBTSxlQUFlLEtBQUssSUFBSSxZQUFZLEdBQUc7QUFDN0MsVUFBTSxVQUFVLEtBQUssSUFBSSxHQUFHLEtBQUssT0FBTyxhQUFhLGdCQUFnQixDQUFDLENBQUM7QUFDdkUsVUFBTSxhQUFhLElBQUksT0FBTyxPQUFPO0FBQ3JDLFVBQU0sUUFBa0IsQ0FBQztBQUV6QixVQUFNLE1BQU0sQ0FBQyxVQUFVLE9BQWU7QUFDcEMsWUFBTSxZQUFZLGdCQUFnQixTQUFTLFlBQVk7QUFDdkQsYUFBTyxhQUFhLFNBQVMsV0FBVyxZQUFZO0FBQUEsSUFDdEQ7QUFDQSxVQUFNLFFBQVEsTUFBTSxJQUFJLEVBQUU7QUFDMUIsVUFBTSxLQUFLLE1BQU0sSUFBSSxHQUFHLEdBQUcsT0FBTyxTQUFJLE9BQU8sWUFBWSxDQUFDLENBQUM7QUFDM0QsVUFBTSxXQUFXLENBQUMsWUFBb0IsSUFBSSxXQUFXLFNBQVMsWUFBWSxDQUFDO0FBRTNFLFVBQU0sUUFBUSxHQUFHLEdBQUcsVUFBVSxHQUFHLEtBQUssZUFBZSxDQUFDO0FBQ3RELFVBQU0sV0FBVyxDQUFDLENBQUMsS0FBSyxTQUFTO0FBQ2pDLFVBQU0sU0FBUyxLQUFLLFNBQVMsU0FDekIsR0FBRyxLQUFLLElBQUksSUFBSSxNQUFPLE1BQU8sR0FBRyxHQUFHLFdBQVcsUUFBRyxJQUFJLEdBQUcsR0FBRyxPQUFPLFFBQUcsQ0FBQyxJQUFJLEdBQUcsR0FBRyxXQUFXLE1BQU0sQ0FBQyxLQUNuRyxLQUFLLFNBQVMsU0FDWixHQUFHLEdBQUcsV0FBVyxlQUFVLElBQzNCLFdBQ0UsR0FBRyxLQUFLLElBQUksSUFBSSxNQUFPLE1BQU8sR0FBRyxHQUFHLFdBQVcsUUFBRyxJQUFJLEdBQUcsR0FBRyxPQUFPLFFBQUcsQ0FBQyxJQUFJLEdBQUcsR0FBRyxXQUFXLE1BQU0sQ0FBQyxJQUFJLEdBQUcsR0FBRyxPQUFPLFFBQVEsS0FBSyxTQUFTLGNBQWUsR0FBRyxHQUFHLENBQUMsS0FDaEssR0FBRyxHQUFHLE9BQU8sTUFBTTtBQUMzQixVQUFNLGVBQWUsc0JBQXNCO0FBQzNDLFVBQU0sY0FBYyxlQUNoQixLQUFLLEdBQUcsR0FBRyxXQUFXLFVBQUssWUFBWSxFQUFFLENBQUMsS0FDMUM7QUFDSixRQUFJLGVBQWU7QUFDbkIsUUFBSSxLQUFLLFNBQVMsVUFBVSxLQUFLLFNBQVMsUUFBUTtBQUVoRCxZQUFNLFVBQVUsS0FBSyxTQUFTO0FBQzlCLHFCQUFlLFVBQVUsS0FBSyxVQUFVLEtBQUssS0FBSyxPQUM5QyxHQUFHLEdBQUcsT0FBTyxlQUFlLE9BQU8sQ0FBQyxJQUNwQztBQUNKLFlBQU0sTUFBTSxzQkFBc0I7QUFDbEMsVUFBSSxJQUFLLGlCQUFnQixHQUFHLEdBQUcsT0FBTyxXQUFRLEdBQUcsRUFBRTtBQUFBLElBQ3JELFdBQVcsVUFBVTtBQUNuQixxQkFBZSxHQUFHLEdBQUcsT0FBTyxTQUFTLEtBQUssU0FBUyxjQUFlLFVBQVUsUUFBUSxLQUFLLEdBQUcsRUFBRSxNQUFNLEdBQUcsRUFBRSxDQUFDLEVBQUU7QUFBQSxJQUM5RztBQUNBLFVBQU0sS0FBSyxJQUFJLFlBQVksR0FBRyxLQUFLLEtBQUssTUFBTSxHQUFHLFdBQVcsSUFBSSxjQUFjLFlBQVksQ0FBQyxDQUFDO0FBRzVGLFFBQUksS0FBSyxTQUFTLFVBQVUsS0FBSyxTQUFTLFFBQVE7QUFDaEQsWUFBTSxnQkFBZ0IscUJBQXFCO0FBQzNDLFlBQU0sZUFBZSxjQUFjLFVBQVUsVUFBVSxHQUFHLEdBQUcsV0FBVyxRQUFHLElBQ3ZFLGNBQWMsVUFBVSxXQUFXLEdBQUcsR0FBRyxXQUFXLFFBQUcsSUFDckQsR0FBRyxHQUFHLFNBQVMsUUFBRztBQUN4QixZQUFNLEtBQUssSUFBSSxHQUFHLFlBQVksSUFBSSxHQUFHLEdBQUcsUUFBUSxjQUFjLE9BQU8sQ0FBQyxFQUFFLENBQUM7QUFHekUsVUFBSSxjQUFjLFVBQVUsV0FBVyxjQUFjLFFBQVEsU0FBUyxHQUFHO0FBQ3ZFLG1CQUFXLFVBQVUsY0FBYyxTQUFTO0FBQzFDLGdCQUFNLFNBQVMsT0FBTyxTQUFTLGFBQWEsR0FBRyxHQUFHLFdBQVcsVUFBSyxJQUM5RCxPQUFPLFNBQVMsYUFBYSxHQUFHLEdBQUcsU0FBUyxVQUFLLElBQy9DLEdBQUcsR0FBRyxPQUFPLFFBQUs7QUFDeEIsZ0JBQU0sS0FBSyxJQUFJLEdBQUcsTUFBTSxJQUFJLEdBQUcsR0FBRyxPQUFPLE9BQU8sS0FBSyxDQUFDLEVBQUUsQ0FBQztBQUFBLFFBQzNEO0FBQUEsTUFDRjtBQUFBLElBQ0Y7QUFDQSxVQUFNLEtBQUssTUFBTSxDQUFDO0FBRWxCLFFBQUksS0FBSyxTQUFTLGFBQWE7QUFDN0IsWUFBTSxLQUFLLEtBQUssU0FBUztBQUN6QixZQUFNLGlCQUFpQixHQUFHLEdBQUcsT0FBTyxlQUFlLEtBQUssSUFBSSxJQUFJLEdBQUcsU0FBUyxDQUFDO0FBQzdFLFlBQU0sS0FBSyxJQUFJO0FBQUEsUUFDYixHQUFHLEdBQUcsR0FBRyxRQUFRLEtBQUssQ0FBQyxLQUFLLEdBQUcsR0FBRyxVQUFVLFVBQVUsR0FBRyxJQUFJLENBQUMsQ0FBQyxJQUFJLEdBQUcsR0FBRyxRQUFRLEdBQUcsRUFBRSxDQUFDO0FBQUEsUUFDdkY7QUFBQSxRQUNBO0FBQUEsTUFDRixDQUFDLENBQUM7QUFDRixZQUFNLEtBQUssTUFBTSxDQUFDO0FBQUEsSUFDcEIsV0FBVyxLQUFLLFNBQVMsUUFBUTtBQUMvQixZQUFNLEtBQUssSUFBSSxHQUFHLEdBQUcsT0FBTyxxQkFBcUIsQ0FBQyxDQUFDO0FBQ25ELFlBQU0sS0FBSyxNQUFNLENBQUM7QUFBQSxJQUNwQixXQUFXLFVBQVU7QUFDbkIsWUFBTSxLQUFLLEtBQUssU0FBUztBQUN6QixZQUFNLGNBQWMsR0FBRyxhQUFhLGNBQWMsR0FBRyxhQUFhLGFBQzlELEdBQUcsV0FDSCxHQUFHLFVBQVUsR0FBRyxRQUFRLENBQUMsSUFBSSxHQUFHLE1BQU07QUFDMUMsWUFBTSxLQUFLLElBQUksR0FBRyxHQUFHLFFBQVEsbUJBQW1CLFdBQVcsRUFBRSxDQUFDLENBQUM7QUFDL0QsWUFBTSxLQUFLLE1BQU0sQ0FBQztBQUFBLElBQ3BCLE9BQU87QUFDTCxZQUFNLEtBQUssSUFBSSxHQUFHLEdBQUcsT0FBTyx5Q0FBc0MsQ0FBQyxDQUFDO0FBQ3BFLFlBQU0sS0FBSyxNQUFNLENBQUM7QUFBQSxJQUNwQjtBQUdBLFFBQUksaUJBQWlCLEdBQUc7QUFDdEIsWUFBTSxLQUFLLEdBQUcsQ0FBQztBQUNmLFlBQU0sS0FBSyxJQUFJLEdBQUcsR0FBRyxRQUFRLEdBQUcsS0FBSyxrQkFBa0IsQ0FBQyxDQUFDLENBQUM7QUFDMUQsWUFBTSxLQUFLLE1BQU0sQ0FBQztBQUVsQixZQUFNLFVBQVUsaUJBQWlCO0FBQ2pDLGlCQUFXLENBQUMsU0FBUyxPQUFPLEtBQUssU0FBUztBQUN4QyxjQUFNLFVBQVUsUUFBUSxPQUFPLE9BQUssRUFBRSxXQUFXLFNBQVMsRUFBRTtBQUM1RCxjQUFNLE9BQU8sUUFBUSxPQUFPLE9BQUssRUFBRSxXQUFXLFdBQVcsRUFBRTtBQUMzRCxjQUFNLFNBQVMsUUFBUSxPQUFPLE9BQUssRUFBRSxXQUFXLFFBQVEsRUFBRTtBQUMxRCxjQUFNLFFBQVEsUUFBUSxDQUFDLEdBQUcsYUFBYSxRQUFRO0FBRS9DLGNBQU0sS0FBSyxJQUFJO0FBQUEsVUFDYixLQUFLLEdBQUcsR0FBRyxVQUFVLFFBQUcsQ0FBQyxJQUFJLEdBQUcsR0FBRyxRQUFRLFNBQVMsUUFBUSxNQUFNLEdBQUcsQ0FBQyxDQUFDLEVBQUUsQ0FBQztBQUFBLFVBQzFFLEdBQUcsR0FBRyxPQUFPLEdBQUcsT0FBTyxNQUFNLElBQUksS0FBSyxPQUFPO0FBQUEsVUFDN0M7QUFBQSxRQUNGLENBQUMsQ0FBQztBQUVGLG1CQUFXLEtBQUssU0FBUztBQUN2QixnQkFBTSxPQUFPLEVBQUUsV0FBVyxZQUN0QixHQUFHLEdBQUcsVUFBVSxRQUFHLElBQ25CLEVBQUUsV0FBVyxjQUNYLEdBQUcsR0FBRyxXQUFXLFFBQUcsSUFDcEIsR0FBRyxHQUFHLFNBQVMsUUFBRztBQUN4QixnQkFBTSxVQUFVLEdBQUcsR0FBRyxPQUFPLGVBQWUsS0FBSyxJQUFJLElBQUksRUFBRSxTQUFTLENBQUM7QUFDckUsZ0JBQU0sY0FBYyxnQkFBZ0IsRUFBRSxNQUFNLEtBQUssSUFBSSxJQUFJLGVBQWUsRUFBRSxDQUFDO0FBQzNFLGdCQUFNLEtBQUssSUFBSTtBQUFBLFlBQ2IsT0FBTyxJQUFJLElBQUksR0FBRyxHQUFHLFFBQVEsRUFBRSxLQUFLLENBQUMsSUFBSSxHQUFHLEdBQUcsT0FBTyxXQUFXLENBQUM7QUFBQSxZQUNsRTtBQUFBLFlBQ0E7QUFBQSxVQUNGLENBQUMsQ0FBQztBQUFBLFFBQ0o7QUFBQSxNQUNGO0FBQ0EsWUFBTSxLQUFLLE1BQU0sQ0FBQztBQUFBLElBQ3BCO0FBR0EsUUFBSSxLQUFLLFNBQVMsc0JBQXNCLEdBQUc7QUFDekMsWUFBTSxRQUFRLEtBQUssU0FBUztBQUM1QixZQUFNLEtBQUssSUFBSSxHQUFHLEdBQUcsV0FBVyxhQUFNLEtBQUssbUJBQW1CLFVBQVUsSUFBSSxLQUFLLEdBQUcsa0JBQWtCLENBQUMsQ0FBQztBQUN4RyxZQUFNLEtBQUssTUFBTSxDQUFDO0FBQUEsSUFDcEI7QUFFQSxRQUFJLEtBQUssU0FBUztBQUNoQixZQUFNLEtBQUssU0FBUyxHQUFHLEdBQUcsT0FBTyx5QkFBb0IsQ0FBQyxDQUFDO0FBQ3ZELGFBQU87QUFBQSxJQUNUO0FBRUEsUUFBSSxLQUFLLGVBQWU7QUFDdEIsWUFBTSxLQUFLLEtBQUs7QUFDaEIsWUFBTSxLQUFLLElBQUksR0FBRyxHQUFHLFFBQVEsR0FBRyxLQUFLLEdBQUcsR0FBRyxFQUFFLEtBQUssR0FBRyxLQUFLLEVBQUUsQ0FBQyxDQUFDLENBQUM7QUFDL0QsWUFBTSxLQUFLLE1BQU0sQ0FBQztBQUVsQixZQUFNLGNBQWMsR0FBRyxPQUFPO0FBQzlCLFlBQU0sYUFBYSxHQUFHLE9BQU8sT0FBTyxPQUFLLEVBQUUsSUFBSSxFQUFFO0FBQ2pELFlBQU0sa0JBQWtCLEdBQUcsU0FBUyxXQUFXO0FBQy9DLFlBQU0saUJBQWlCLEdBQUcsU0FBUyxXQUFXO0FBQzlDLFlBQU0sY0FBYyxHQUFHLE9BQU8sS0FBSyxPQUFLLEVBQUUsTUFBTTtBQUVoRCxZQUFNLEtBQUssTUFBTSxDQUFDO0FBRWxCLFVBQUksYUFBYSxjQUFjO0FBQzdCLGNBQU0sS0FBSyxJQUFJLEtBQUssa0JBQWtCLFNBQVMsWUFBWSxhQUFhLE1BQU0sWUFBWSxhQUFhLE9BQU8sVUFBVSxZQUFZLENBQUMsQ0FBQztBQUFBLE1BQ3hJO0FBQ0EsWUFBTSxLQUFLLElBQUksS0FBSyxrQkFBa0IsVUFBVSxZQUFZLGFBQWEsV0FBVyxZQUFZLENBQUMsQ0FBQztBQUNsRyxZQUFNLEtBQUssSUFBSSxLQUFLLGtCQUFrQixjQUFjLGdCQUFnQixpQkFBaUIsV0FBVyxZQUFZLENBQUMsQ0FBQztBQUU5RyxZQUFNLEtBQUssTUFBTSxDQUFDO0FBRWxCLGlCQUFXLEtBQUssR0FBRyxRQUFRO0FBQ3pCLGNBQU0sY0FBYyxFQUFFLE9BQU8sU0FBUyxFQUFFLFNBQVMsV0FBVztBQUM1RCxjQUFNLE9BQU8sR0FBRyxHQUFHLGFBQWEsV0FBVyxHQUFHLGFBQWEsV0FBVyxDQUFDO0FBQ3ZFLGNBQU0sYUFBYSxFQUFFLFNBQVMsV0FBVyxFQUFFLE9BQU8sVUFBVTtBQUM1RCxjQUFNLFlBQVksR0FBRyxHQUFHLFlBQVksR0FBRyxFQUFFLEVBQUUsS0FBSyxFQUFFLEtBQUssRUFBRTtBQUN6RCxjQUFNLE9BQU8sR0FBRyxHQUFHLE9BQU8sRUFBRSxJQUFJO0FBQ2hDLGNBQU0sS0FBSyxJQUFJLFlBQVksS0FBSyxJQUFJLElBQUksU0FBUyxJQUFJLE1BQU0sWUFBWSxDQUFDLENBQUM7QUFFekUsWUFBSSxFQUFFLFVBQVUsRUFBRSxNQUFNLFNBQVMsR0FBRztBQUNsQyxxQkFBVyxLQUFLLEVBQUUsT0FBTztBQUN2QixrQkFBTSxhQUFhLEVBQUUsT0FBTyxTQUFTLEVBQUUsU0FBUyxXQUFXO0FBQzNELGtCQUFNLFFBQVEsR0FBRyxHQUFHLGFBQWEsVUFBVSxHQUFHLGFBQWEsVUFBVSxDQUFDO0FBQ3RFLGtCQUFNLFNBQVMsRUFBRSxTQUFTLFlBQVksRUFBRSxPQUFPLFVBQVU7QUFDekQsa0JBQU0sU0FBUyxHQUFHLEdBQUcsUUFBUSxHQUFHLEVBQUUsRUFBRSxLQUFLLEVBQUUsS0FBSyxFQUFFO0FBQ2xELGtCQUFNLEtBQUssSUFBSSxTQUFTLEtBQUssSUFBSSxnQkFBZ0IsUUFBUSxlQUFlLENBQUMsQ0FBQyxFQUFFLENBQUM7QUFBQSxVQUMvRTtBQUFBLFFBQ0Y7QUFBQSxNQUNGO0FBQUEsSUFDRixPQUFPO0FBQ0wsWUFBTSxLQUFLLFNBQVMsR0FBRyxHQUFHLE9BQU8sc0JBQXNCLENBQUMsQ0FBQztBQUFBLElBQzNEO0FBRUEsVUFBTSxTQUFTLFVBQVU7QUFDekIsUUFBSSxVQUFVLE9BQU8sTUFBTSxTQUFTLEdBQUc7QUFDckMsWUFBTSxTQUFTLGlCQUFpQixPQUFPLEtBQUs7QUFFNUMsWUFBTSxLQUFLLE1BQU0sQ0FBQztBQUNsQixZQUFNLEtBQUssR0FBRyxDQUFDO0FBQ2YsWUFBTSxLQUFLLElBQUksR0FBRyxHQUFHLFFBQVEsR0FBRyxLQUFLLGNBQWMsQ0FBQyxDQUFDLENBQUM7QUFDdEQsWUFBTSxLQUFLLE1BQU0sQ0FBQztBQUdsQixZQUFNLGFBQWEsT0FBTyxPQUFPLElBQzdCLEdBQUcsR0FBRyxHQUFHLFdBQVcsV0FBVyxPQUFPLElBQUksQ0FBQyxDQUFDLFdBQzVDLEdBQUcsR0FBRyxHQUFHLFFBQVEsT0FBTyxPQUFPLFdBQVcsQ0FBQyxDQUFDO0FBQ2hELFlBQU0sS0FBSyxJQUFJLFdBQVc7QUFBQSxRQUN4QjtBQUFBLFFBQ0EsR0FBRyxHQUFHLEdBQUcsUUFBUSxpQkFBaUIsT0FBTyxPQUFPLEtBQUssQ0FBQyxDQUFDO0FBQUEsUUFDdkQsR0FBRyxHQUFHLEdBQUcsUUFBUSxPQUFPLE9BQU8sU0FBUyxDQUFDLENBQUM7QUFBQSxRQUMxQyxHQUFHLEdBQUcsR0FBRyxRQUFRLE9BQU8sT0FBTyxLQUFLLENBQUMsQ0FBQztBQUFBLE1BQ3hDLEdBQUcsY0FBYyxLQUFLLEdBQUcsR0FBRyxPQUFPLE1BQUcsQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUU3QyxZQUFNLEtBQUssSUFBSSxXQUFXO0FBQUEsUUFDeEIsR0FBRyxHQUFHLEdBQUcsT0FBTyxLQUFLLENBQUMsSUFBSSxHQUFHLEdBQUcsUUFBUSxpQkFBaUIsT0FBTyxPQUFPLEtBQUssQ0FBQyxDQUFDO0FBQUEsUUFDOUUsR0FBRyxHQUFHLEdBQUcsT0FBTyxNQUFNLENBQUMsSUFBSSxHQUFHLEdBQUcsUUFBUSxpQkFBaUIsT0FBTyxPQUFPLE1BQU0sQ0FBQyxDQUFDO0FBQUEsUUFDaEYsR0FBRyxHQUFHLEdBQUcsT0FBTyxVQUFVLENBQUMsSUFBSSxHQUFHLEdBQUcsUUFBUSxpQkFBaUIsT0FBTyxPQUFPLFNBQVMsQ0FBQyxDQUFDO0FBQUEsUUFDdkYsR0FBRyxHQUFHLEdBQUcsT0FBTyxVQUFVLENBQUMsSUFBSSxHQUFHLEdBQUcsUUFBUSxpQkFBaUIsT0FBTyxPQUFPLFVBQVUsQ0FBQyxDQUFDO0FBQUEsTUFDMUYsR0FBRyxjQUFjLElBQUksQ0FBQyxDQUFDO0FBR3ZCLFVBQUksT0FBTywwQkFBMEIsS0FBSyxPQUFPLHlCQUF5QixHQUFHO0FBQzNFLGNBQU0sY0FBd0IsQ0FBQztBQUMvQixZQUFJLE9BQU8sMEJBQTBCLEdBQUc7QUFDdEMsc0JBQVksS0FBSyxHQUFHLEdBQUcsV0FBVyxHQUFHLE9BQU8sdUJBQXVCLHFCQUFxQixDQUFDO0FBQUEsUUFDM0Y7QUFDQSxZQUFJLE9BQU8seUJBQXlCLEdBQUc7QUFDckMsc0JBQVksS0FBSyxHQUFHLEdBQUcsU0FBUyxHQUFHLE9BQU8sc0JBQXNCLHNCQUFzQixDQUFDO0FBQUEsUUFDekY7QUFDQSxjQUFNLEtBQUssSUFBSSxZQUFZLEtBQUssS0FBSyxHQUFHLEdBQUcsT0FBTyxNQUFHLENBQUMsSUFBSSxDQUFDLENBQUM7QUFBQSxNQUM5RDtBQUVBLFlBQU0sU0FBUyxpQkFBaUIsT0FBTyxLQUFLO0FBQzVDLFVBQUksT0FBTyxTQUFTLEdBQUc7QUFDckIsY0FBTSxLQUFLLE1BQU0sQ0FBQztBQUNsQixjQUFNLEtBQUssSUFBSSxHQUFHLEdBQUcsT0FBTyxVQUFVLENBQUMsQ0FBQztBQUN4QyxtQkFBVyxLQUFLLFFBQVE7QUFDdEIsZ0JBQU0sTUFBTSxPQUFPLE9BQU8sSUFBSSxLQUFLLE1BQU8sRUFBRSxPQUFPLE9BQU8sT0FBUSxHQUFHLElBQUk7QUFDekUsZ0JBQU0sT0FBTyxLQUFLLEdBQUcsR0FBRyxRQUFRLEVBQUUsTUFBTSxPQUFPLEVBQUUsQ0FBQyxDQUFDLEdBQUcsR0FBRyxHQUFHLFdBQVcsV0FBVyxFQUFFLElBQUksRUFBRSxTQUFTLENBQUMsQ0FBQyxDQUFDO0FBQ3RHLGdCQUFNLFFBQVEsR0FBRyxHQUFHLE9BQU8sR0FBRyxPQUFPLEdBQUcsRUFBRSxTQUFTLENBQUMsQ0FBQyxNQUFNLGlCQUFpQixFQUFFLE9BQU8sS0FBSyxDQUFDLFNBQVMsRUFBRSxLQUFLLFFBQVE7QUFDbkgsZ0JBQU0sS0FBSyxJQUFJLFlBQVksTUFBTSxPQUFPLFlBQVksQ0FBQyxDQUFDO0FBQUEsUUFDeEQ7QUFBQSxNQUNGO0FBRUEsWUFBTSxTQUFTLGlCQUFpQixPQUFPLEtBQUs7QUFDNUMsVUFBSSxPQUFPLFNBQVMsR0FBRztBQUNyQixjQUFNLEtBQUssTUFBTSxDQUFDO0FBQ2xCLGNBQU0sS0FBSyxJQUFJLEdBQUcsR0FBRyxPQUFPLFVBQVUsQ0FBQyxDQUFDO0FBQ3hDLG1CQUFXLEtBQUssUUFBUTtBQUN0QixnQkFBTSxNQUFNLE9BQU8sT0FBTyxJQUFJLEtBQUssTUFBTyxFQUFFLE9BQU8sT0FBTyxPQUFRLEdBQUcsSUFBSTtBQUN6RSxnQkFBTSxPQUFPLEtBQUssR0FBRyxHQUFHLFFBQVEsRUFBRSxRQUFRLE9BQU8sRUFBRSxDQUFDLENBQUMsR0FBRyxHQUFHLEdBQUcsV0FBVyxXQUFXLEVBQUUsSUFBSSxFQUFFLFNBQVMsQ0FBQyxDQUFDLENBQUM7QUFDeEcsZ0JBQU0sUUFBUSxHQUFHLEdBQUcsT0FBTyxHQUFHLE9BQU8sR0FBRyxFQUFFLFNBQVMsQ0FBQyxDQUFDLE1BQU0saUJBQWlCLEVBQUUsT0FBTyxLQUFLLENBQUMsU0FBUyxlQUFlLEVBQUUsUUFBUSxDQUFDLEVBQUU7QUFDaEksZ0JBQU0sS0FBSyxJQUFJLFlBQVksTUFBTSxPQUFPLFlBQVksQ0FBQyxDQUFDO0FBQUEsUUFDeEQ7QUFBQSxNQUNGO0FBR0EsVUFBSSxLQUFLLGVBQWU7QUFDdEIsY0FBTSxLQUFLLEtBQUs7QUFDaEIsY0FBTSxnQkFBZ0IsR0FBRyxPQUFPO0FBQ2hDLGNBQU0sZUFBZSxHQUFHLE9BQU8sT0FBTyxPQUFLLEVBQUUsSUFBSSxFQUFFO0FBQ25ELGNBQU0saUJBQWlCLGdCQUFnQjtBQUN2QyxjQUFNLGVBQWUsNEJBQTRCLEdBQUc7QUFDcEQsY0FBTSxZQUFZLHFCQUFxQixRQUFRLGdCQUFnQixjQUFjLGNBQWM7QUFDM0YsWUFBSSxVQUFVLFNBQVMsR0FBRztBQUN4QixnQkFBTSxLQUFLLE1BQU0sQ0FBQztBQUNsQixxQkFBVyxRQUFRLFdBQVc7QUFDNUIsa0JBQU0sVUFBVSxLQUFLLFlBQVksRUFBRSxTQUFTLFNBQVMsSUFDakQsR0FBRyxHQUFHLFdBQVcsSUFBSSxJQUNyQixHQUFHLEdBQUcsT0FBTyxJQUFJO0FBQ3JCLGtCQUFNLEtBQUssSUFBSSxPQUFPLENBQUM7QUFBQSxVQUN6QjtBQUFBLFFBQ0Y7QUFBQSxNQUNGO0FBRUEsWUFBTSxTQUFTLGlCQUFpQixPQUFPLEtBQUs7QUFDNUMsVUFBSSxPQUFPLFVBQVUsR0FBRztBQUN0QixjQUFNLEtBQUssTUFBTSxDQUFDO0FBQ2xCLGNBQU0sS0FBSyxJQUFJLEdBQUcsR0FBRyxPQUFPLFVBQVUsQ0FBQyxDQUFDO0FBQ3hDLG1CQUFXLEtBQUssUUFBUTtBQUN0QixnQkFBTSxNQUFNLE9BQU8sT0FBTyxJQUFJLEtBQUssTUFBTyxFQUFFLE9BQU8sT0FBTyxPQUFRLEdBQUcsSUFBSTtBQUN6RSxnQkFBTSxZQUFZLGdCQUFnQixFQUFFLE9BQU8sRUFBRTtBQUM3QyxnQkFBTSxZQUFZLEVBQUUsd0JBQXdCLFNBQ3hDLEdBQUcsR0FBRyxPQUFPLEtBQUssaUJBQWlCLEVBQUUsbUJBQW1CLENBQUMsR0FBRyxJQUM1RDtBQUNKLGdCQUFNLE9BQU8sS0FBSyxHQUFHLEdBQUcsUUFBUSxVQUFVLE9BQU8sRUFBRSxDQUFDLENBQUMsR0FBRyxHQUFHLEdBQUcsV0FBVyxXQUFXLEVBQUUsSUFBSSxFQUFFLFNBQVMsQ0FBQyxDQUFDLENBQUM7QUFDeEcsZ0JBQU0sUUFBUSxHQUFHLEdBQUcsT0FBTyxHQUFHLE9BQU8sR0FBRyxFQUFFLFNBQVMsQ0FBQyxDQUFDLE1BQU0sRUFBRSxLQUFLLFFBQVEsSUFBSTtBQUM5RSxnQkFBTSxLQUFLLElBQUksWUFBWSxNQUFNLE9BQU8sWUFBWSxDQUFDLENBQUM7QUFBQSxRQUN4RDtBQUFBLE1BQ0Y7QUFFQSxZQUFNLEtBQUssTUFBTSxDQUFDO0FBQ2xCLFlBQU0sS0FBSyxJQUFJLEdBQUcsR0FBRyxHQUFHLE9BQU8sV0FBVyxDQUFDLElBQUksR0FBRyxHQUFHLFFBQVEsV0FBVyxPQUFPLE9BQU8sT0FBTyxLQUFLLENBQUMsQ0FBQyxLQUFLLEdBQUcsR0FBRyxPQUFPLE1BQUcsQ0FBQyxLQUFLLEdBQUcsR0FBRyxRQUFRLGlCQUFpQixLQUFLLE1BQU0sT0FBTyxPQUFPLFFBQVEsT0FBTyxLQUFLLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQztBQUd4TixZQUFNLFlBQVksc0JBQXNCO0FBQ3hDLFVBQUksWUFBWSxHQUFHO0FBQ2pCLGNBQU0sS0FBSyxJQUFJLEdBQUcsR0FBRyxHQUFHLE9BQU8saUJBQWlCLENBQUMsSUFBSSxHQUFHLEdBQUcsUUFBUSxHQUFHLFNBQVMsR0FBRyxDQUFDLEVBQUUsQ0FBQztBQUFBLE1BQ3hGO0FBRUEsVUFBSSxLQUFLLFNBQVMsY0FBYyxLQUFLLFNBQVMsY0FBYyxLQUFLLFNBQVMsV0FBVyxXQUFXLEdBQUc7QUFDakcsY0FBTSxNQUFNLEtBQUssU0FBUztBQUMxQixjQUFNLEtBQUs7QUFBQSxVQUNULEdBQUcsR0FBRyxHQUFHLE9BQU8sWUFBWSxDQUFDLElBQUksR0FBRyxHQUFHLFFBQVEsaUJBQWlCLElBQUksV0FBVyxDQUFDLENBQUMsSUFBSSxHQUFHLEdBQUcsT0FBTyxJQUFJLEtBQUssTUFBTSxJQUFJLFVBQVUsQ0FBQyxVQUFPLElBQUksUUFBUSxPQUFPLElBQUksYUFBYSxJQUFJLEtBQUssR0FBRyxHQUFHLENBQUM7QUFBQSxRQUM3TCxDQUFDO0FBQUEsTUFDSDtBQUFBLElBQ0Y7QUFHQSxVQUFNLGFBQWEscUJBQXFCLEtBQUssU0FBUyxZQUFZLFFBQVEsSUFBSSxDQUFDO0FBQy9FLFVBQU0sWUFBWSxXQUFXLE9BQU8sT0FBSyxFQUFFLFdBQVcsSUFBSTtBQUMxRCxRQUFJLFVBQVUsU0FBUyxHQUFHO0FBQ3hCLFlBQU0sS0FBSyxNQUFNLENBQUM7QUFDbEIsWUFBTSxLQUFLLEdBQUcsQ0FBQztBQUNmLFlBQU0sS0FBSyxJQUFJLEdBQUcsR0FBRyxRQUFRLEdBQUcsS0FBSyxhQUFhLENBQUMsQ0FBQyxDQUFDO0FBQ3JELFlBQU0sS0FBSyxNQUFNLENBQUM7QUFDbEIsaUJBQVcsS0FBSyxXQUFXO0FBQ3pCLGNBQU0sT0FBTyxFQUFFLFdBQVcsVUFBVSxHQUFHLEdBQUcsU0FBUyxRQUFHLElBQUksR0FBRyxHQUFHLFdBQVcsUUFBRztBQUM5RSxjQUFNLEtBQUssSUFBSSxLQUFLLElBQUksSUFBSSxHQUFHLEdBQUcsUUFBUSxFQUFFLE9BQU8sQ0FBQyxFQUFFLENBQUM7QUFDdkQsWUFBSSxFQUFFLFFBQVE7QUFDWixnQkFBTSxLQUFLLElBQUksR0FBRyxHQUFHLE9BQU8sUUFBUSxFQUFFLE1BQU0sRUFBRSxDQUFDLENBQUM7QUFBQSxRQUNsRDtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBRUEsVUFBTSxLQUFLLE1BQU0sQ0FBQztBQUNsQixVQUFNLEtBQUssR0FBRyxDQUFDO0FBQ2YsVUFBTSxLQUFLLFNBQVMsR0FBRyxHQUFHLE9BQU8saURBQWlDLHNCQUFzQixXQUFXLENBQUMsUUFBUSxDQUFDLENBQUM7QUFFOUcsV0FBTztBQUFBLEVBQ1Q7QUFBQSxFQUVRLGtCQUNOLE9BQ0EsTUFDQSxPQUNBLE9BQ0EsT0FDUTtBQUNSLFVBQU0sS0FBSyxLQUFLO0FBQ2hCLFVBQU0sTUFBTSxRQUFRLElBQUksS0FBSyxNQUFPLE9BQU8sUUFBUyxHQUFHLElBQUk7QUFDM0QsVUFBTSxhQUFhO0FBQ25CLFVBQU0sYUFBYTtBQUNuQixVQUFNLE1BQU07QUFDWixVQUFNLFlBQVksZ0JBQWdCLE9BQU8sWUFBWSxFQUFFLEVBQUUsT0FBTyxVQUFVO0FBQzFFLFVBQU0sWUFBWSxHQUFHLElBQUksSUFBSSxLQUFLO0FBQ2xDLFVBQU0sWUFBWSxHQUFHLE9BQU8sR0FBRyxFQUFFLFNBQVMsQ0FBQyxDQUFDLE1BQU0sVUFBVSxTQUFTLGFBQWEsQ0FBQyxDQUFDO0FBQ3BGLFVBQU0sV0FBVyxLQUFLLElBQUksSUFBSSxRQUFRLGFBQWEsYUFBYSxNQUFNLENBQUM7QUFDdkUsVUFBTSxTQUFTLFFBQVEsSUFBSSxLQUFLLE1BQU8sT0FBTyxRQUFTLFFBQVEsSUFBSTtBQUNuRSxVQUFNLE1BQU0sR0FBRyxHQUFHLE9BQU8sU0FBSSxPQUFPLE1BQU0sQ0FBQyxJQUFJLEdBQUcsR0FBRyxPQUFPLFNBQUksT0FBTyxLQUFLLElBQUksR0FBRyxXQUFXLE1BQU0sQ0FBQyxDQUFDO0FBQ3RHLFdBQU8sR0FBRyxHQUFHLEdBQUcsT0FBTyxTQUFTLENBQUMsR0FBRyxJQUFJLE9BQU8sR0FBRyxDQUFDLEdBQUcsR0FBRyxHQUFHLElBQUksT0FBTyxHQUFHLENBQUMsR0FBRyxHQUFHLEdBQUcsT0FBTyxTQUFTLENBQUM7QUFBQSxFQUN2RztBQUFBLEVBRUEsYUFBbUI7QUFDakIsU0FBSyxjQUFjO0FBQ25CLFNBQUssY0FBYztBQUFBLEVBQ3JCO0FBQUEsRUFFQSxVQUFnQjtBQUNkLFNBQUssV0FBVztBQUNoQixrQkFBYyxLQUFLLFlBQVk7QUFDL0IsUUFBSSxLQUFLLGVBQWU7QUFDdEIsY0FBUSxPQUFPLGVBQWUsVUFBVSxLQUFLLGFBQWE7QUFDMUQsV0FBSyxnQkFBZ0I7QUFBQSxJQUN2QjtBQUFBLEVBQ0Y7QUFDRjsiLAogICJuYW1lcyI6IFtdCn0K
