import { existsSync, statSync, readFileSync, openSync, readSync, closeSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { matchesKey, Key } from "@gsd/pi-tui";
import { formatDuration } from "../shared/mod.js";
import { formattedShortcutPair } from "./shortcut-defs.js";
import { resolveGsdPathContract } from "./paths.js";
import {
  renderBar,
  renderKeyHints,
  renderProgressBar,
  safeLine,
  statusGlyph
} from "./tui/render-kit.js";
function readJsonSafe(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function tailRead(filePath, maxBytes) {
  try {
    const stat = statSync(filePath);
    const readSize = Math.min(stat.size, maxBytes);
    const fd = openSync(filePath, "r");
    const buf = Buffer.alloc(readSize);
    readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
    closeSync(fd);
    return buf.toString("utf-8");
  } catch {
    return "";
  }
}
function discoverWorkers(basePath) {
  const parallelDir = join(basePath, ".gsd", "parallel");
  const worktreeDir = join(basePath, ".gsd", "worktrees");
  const mids = /* @__PURE__ */ new Set();
  if (existsSync(parallelDir)) {
    try {
      for (const f of readdirSync(parallelDir)) {
        if (f.endsWith(".status.json")) mids.add(f.replace(".status.json", ""));
        const m = f.match(/^(M\d+)\.(stderr|stdout)\.log$/);
        if (m) mids.add(m[1]);
      }
    } catch {
    }
  }
  if (existsSync(worktreeDir)) {
    try {
      for (const d of readdirSync(worktreeDir)) {
        if (d.startsWith("M") && existsSync(join(worktreeDir, d, ".gsd", "auto.lock"))) {
          mids.add(d);
        }
      }
    } catch {
    }
  }
  return [...mids].sort();
}
function querySliceProgress(basePath, mid) {
  const workRoot = join(basePath, ".gsd", "worktrees", mid);
  const dbPath = resolveGsdPathContract(workRoot, basePath).projectDb;
  if (!existsSync(dbPath)) return [];
  try {
    const sql = `SELECT s.id, s.status, COUNT(t.id), SUM(CASE WHEN t.status='complete' THEN 1 ELSE 0 END) FROM slices s LEFT JOIN tasks t ON s.milestone_id=t.milestone_id AND s.id=t.slice_id WHERE s.milestone_id='${mid}' GROUP BY s.id ORDER BY s.id`;
    const result = spawnSync("sqlite3", [dbPath, sql], { timeout: 3e3, encoding: "utf-8" });
    const out = (result.stdout || "").trim();
    if (!out || result.status !== 0) return [];
    return out.split("\n").map((line) => {
      const [id, status, total, done] = line.split("|");
      return { id, status, total: parseInt(total, 10), done: parseInt(done || "0", 10) };
    });
  } catch {
    return [];
  }
}
function extractCostFromNdjson(basePath, mid) {
  const stdoutPath = join(basePath, ".gsd", "parallel", `${mid}.stdout.log`);
  if (!existsSync(stdoutPath)) return 0;
  try {
    const content = readFileSync(stdoutPath, "utf-8");
    let total = 0;
    for (const line of content.split("\n")) {
      if (!line.includes("message_end")) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === "message_end") {
          const cost = obj.message?.usage?.cost?.total;
          if (typeof cost === "number") total += cost;
        }
      } catch {
      }
    }
    return total;
  } catch {
    return 0;
  }
}
function queryRecentCompletions(basePath, mid) {
  const workRoot = join(basePath, ".gsd", "worktrees", mid);
  const dbPath = resolveGsdPathContract(workRoot, basePath).projectDb;
  if (!existsSync(dbPath)) return [];
  try {
    const sql = `SELECT id, slice_id, one_liner FROM tasks WHERE milestone_id='${mid}' AND status='complete' AND completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 5`;
    const result = spawnSync("sqlite3", [dbPath, sql], { timeout: 3e3, encoding: "utf-8" });
    const out = (result.stdout || "").trim();
    if (!out || result.status !== 0) return [];
    return out.split("\n").map((line) => {
      const [taskId, sliceId, oneLiner] = line.split("|");
      return `\u2713 ${mid}/${sliceId}/${taskId}${oneLiner ? ": " + oneLiner : ""}`;
    });
  } catch {
    return [];
  }
}
function collectWorkerData(basePath) {
  const mids = discoverWorkers(basePath);
  const parallelDir = join(basePath, ".gsd", "parallel");
  const workers = [];
  for (const mid of mids) {
    const status = readJsonSafe(join(parallelDir, `${mid}.status.json`));
    const lock = readJsonSafe(join(basePath, ".gsd", "worktrees", mid, ".gsd", "auto.lock"));
    const slices = querySliceProgress(basePath, mid);
    const pid = lock?.pid || status?.pid || 0;
    const alive = pid ? isPidAlive(pid) : false;
    let heartbeatAge = Infinity;
    const statusPidMatches = status?.pid === pid && status?.lastHeartbeat;
    if (statusPidMatches) {
      heartbeatAge = Date.now() - status.lastHeartbeat;
    } else {
      const mtimes = [];
      const stdoutLog = join(parallelDir, `${mid}.stdout.log`);
      const stderrLog2 = join(parallelDir, `${mid}.stderr.log`);
      if (existsSync(stdoutLog)) mtimes.push(statSync(stdoutLog).mtimeMs);
      if (existsSync(stderrLog2)) mtimes.push(statSync(stderrLog2).mtimeMs);
      if (lock?.unitStartedAt) mtimes.push(new Date(lock.unitStartedAt).getTime());
      if (mtimes.length > 0) heartbeatAge = Date.now() - Math.max(...mtimes);
    }
    let cost = status?.cost || 0;
    if (cost === 0) cost = extractCostFromNdjson(basePath, mid);
    const totalTasks = slices.reduce((sum, s) => sum + s.total, 0);
    const doneTasks = slices.reduce((sum, s) => sum + s.done, 0);
    const doneSlices = slices.filter((s) => s.status === "complete").length;
    const elapsed = status?.startedAt ? Date.now() - status.startedAt : lock?.startedAt ? Date.now() - new Date(lock.startedAt).getTime() : 0;
    const errors = [];
    const stderrLog = join(parallelDir, `${mid}.stderr.log`);
    if (existsSync(stderrLog)) {
      const content = tailRead(stderrLog, 4096);
      for (const line of content.trim().split("\n").slice(-5)) {
        if (line.includes("error") || line.includes("Error") || line.includes("exited")) {
          errors.push(line.trim());
        }
      }
    }
    workers.push({
      mid,
      pid,
      alive,
      state: alive ? "running" : status?.state || "dead",
      cost,
      heartbeatAge,
      currentUnit: lock?.unitId || null,
      unitType: lock?.unitType || null,
      unitElapsed: lock?.unitStartedAt ? Date.now() - new Date(lock.unitStartedAt).getTime() : 0,
      elapsed,
      totalTasks,
      doneTasks,
      totalSlices: slices.length,
      doneSlices,
      slices,
      errors
    });
  }
  return workers;
}
function unitTypeLabel(unitType) {
  const labels = {
    "execute-task": "EXEC",
    "research-slice": "RSRCH",
    "plan-slice": "PLAN",
    "complete-slice": "DONE",
    "complete-task": "DONE",
    "reassess": "ASSESS",
    "validate": "VALID",
    "reassess-roadmap": "ASSESS"
  };
  return labels[unitType || ""] || (unitType || "---").toUpperCase().slice(0, 5);
}
class ParallelMonitorOverlay {
  tui;
  theme;
  onClose;
  basePath;
  refreshTimer;
  workers = [];
  events = [];
  cachedLines;
  cachedWidth;
  scrollOffset = 0;
  disposed = false;
  resizeHandler = null;
  constructor(tui, theme, onClose, basePath) {
    this.tui = tui;
    this.theme = theme;
    this.onClose = onClose;
    this.basePath = basePath || process.cwd();
    this.resizeHandler = () => {
      if (this.disposed) return;
      this.invalidate();
      this.tui.requestRender();
    };
    process.stdout.on("resize", this.resizeHandler);
    this.refresh();
    this.refreshTimer = setInterval(() => this.refresh(), 5e3);
  }
  refresh() {
    if (this.disposed) return;
    this.workers = collectWorkerData(this.basePath);
    for (const wk of this.workers) {
      const completions = queryRecentCompletions(this.basePath, wk.mid);
      for (const evt of completions) {
        if (!this.events.includes(evt)) this.events.push(evt);
      }
    }
    this.events = this.events.slice(-10);
    this.cachedLines = void 0;
    this.cachedWidth = void 0;
    this.tui.requestRender();
  }
  dispose() {
    this.disposed = true;
    clearInterval(this.refreshTimer);
    if (this.resizeHandler) {
      process.stdout.removeListener("resize", this.resizeHandler);
      this.resizeHandler = null;
    }
  }
  handleInput(data) {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrlAlt("p")) || matchesKey(data, Key.ctrlShift("p")) || data === "q") {
      this.dispose();
      this.onClose();
      return;
    }
    if (matchesKey(data, Key.down) || data === "j") {
      this.scrollOffset++;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.up) || data === "k") {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.invalidate();
      this.tui.requestRender();
      return;
    }
  }
  invalidate() {
    this.cachedLines = void 0;
    this.cachedWidth = void 0;
  }
  render(width) {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const t = this.theme;
    const lines = [];
    const w = Math.max(1, width);
    const totalCost = this.workers.reduce((s, wk) => s + wk.cost, 0);
    const aliveCount = this.workers.filter((wk) => wk.alive).length;
    const now = (/* @__PURE__ */ new Date()).toLocaleTimeString();
    lines.push(t.bold(t.fg("accent", " GSD Parallel Monitor ")));
    lines.push(
      t.fg("muted", `  ${now}  \u2502  ${aliveCount}/${this.workers.length} alive  \u2502  Total: `) + t.bold(`$${totalCost.toFixed(2)}`) + t.fg("muted", "  \u2502  5s refresh")
    );
    lines.push(renderBar(t, w));
    if (this.workers.length === 0) {
      lines.push("");
      lines.push(t.fg("warning", "  No parallel workers found."));
      lines.push(t.fg("muted", "  Run /gsd parallel start to begin."));
    } else {
      for (const wk of this.workers) {
        lines.push("");
        const healthColor = wk.alive ? "success" : "error";
        const glyph = statusGlyph(t, wk.alive ? "active" : "idle");
        const stateText = wk.alive ? t.fg("success", "RUNNING") : t.fg("error", t.bold("DEAD"));
        const heartbeatText = wk.heartbeatAge === Infinity ? "never" : formatDuration(wk.heartbeatAge) + " ago";
        lines.push(
          `  ${t.fg(healthColor, glyph)}  ${t.bold(wk.mid)}  ${stateText}  ` + t.fg("muted", `PID ${wk.pid}  \u2502  elapsed ${formatDuration(wk.elapsed)}  \u2502  `) + `cost ${t.bold("$" + wk.cost.toFixed(2))}  ` + t.fg("muted", "\u2502  heartbeat ") + t.fg(healthColor, heartbeatText)
        );
        if (wk.currentUnit) {
          const phaseColor = wk.unitType === "execute-task" ? "accent" : wk.unitType === "research-slice" ? "warning" : wk.unitType?.includes("complete") ? "success" : "text";
          lines.push(
            `     ${t.fg("muted", "\u25B8")} ${t.fg(phaseColor, unitTypeLabel(wk.unitType))}  ${wk.currentUnit}  ` + t.fg("muted", `(${formatDuration(wk.unitElapsed)})`)
          );
        } else if (!wk.alive) {
          lines.push(`     ${t.fg("muted", "\u25B8")} ${t.fg("error", "stopped")}`);
        } else {
          lines.push(`     ${t.fg("muted", "\u25B8 idle / between units")}`);
        }
        if (wk.slices.length > 0) {
          const chips = wk.slices.map((s) => {
            const pct2 = s.total > 0 ? s.done / s.total : 0;
            const color = s.status === "complete" ? "success" : pct2 > 0 ? "warning" : "muted";
            return t.fg(color, `${s.id}:${s.done}/${s.total}`);
          });
          lines.push(`     ${t.fg("muted", "slices")}  ${chips.join("  ")}`);
          const barWidth = Math.max(6, Math.min(25, w - 32));
          const bar = renderProgressBar(t, wk.doneTasks, wk.totalTasks, barWidth, {
            filledChar: "\u2588",
            emptyChar: "\u2591",
            emptyColor: "dim"
          });
          const pct = wk.totalTasks > 0 ? Math.round(wk.doneTasks / wk.totalTasks * 100) : 0;
          lines.push(
            `     ${t.fg("muted", "tasks")}   ${bar}  ${wk.doneTasks}/${wk.totalTasks} ` + t.fg("muted", `(${pct}%)  \u2502  slices done ${wk.doneSlices}/${wk.totalSlices}`)
          );
        }
        for (const err of wk.errors.slice(-2)) {
          lines.push(`     ${t.fg("error", "! " + err)}`);
        }
      }
    }
    lines.push("");
    lines.push(renderBar(t, w));
    lines.push(`  ${t.bold("Recent Events")}`);
    if (this.events.length === 0) {
      lines.push(t.fg("muted", "  No events yet..."));
    } else {
      for (const evt of this.events.slice(-8)) {
        const mid = evt.match(/^✓ (M\d+)\//)?.[1] || "";
        lines.push(`  ${t.fg("muted", "\u2502")} ${t.fg("accent", mid)} ${evt.replace(/^✓ M\d+\//, "")}`);
      }
    }
    lines.push("");
    const allDone = this.workers.length > 0 && this.workers.every((wk) => !wk.alive);
    if (allDone) {
      lines.push(t.bold(t.fg("success", "  ALL WORKERS COMPLETE")));
      for (const wk of this.workers) {
        lines.push(
          `  ${wk.mid}  $${wk.cost.toFixed(2)}  \u2502  ${wk.doneSlices}/${wk.totalSlices} slices  ${wk.doneTasks}/${wk.totalTasks} tasks  \u2502  ${formatDuration(wk.elapsed)}`
        );
      }
      lines.push(`  ${t.bold("Total: $" + this.workers.reduce((s, wk) => s + wk.cost, 0).toFixed(2))}`);
    }
    lines.push(renderKeyHints(t, [`ESC/q/${formattedShortcutPair("parallel")} close`, "\u2191\u2193 scroll"], w));
    const termHeight = process.stdout.rows || 40;
    const maxScroll = Math.max(0, lines.length - termHeight);
    this.scrollOffset = Math.min(Math.max(this.scrollOffset, 0), maxScroll);
    const visible = lines.slice(this.scrollOffset, this.scrollOffset + termHeight).map((line) => safeLine(line, w));
    this.cachedLines = visible;
    this.cachedWidth = width;
    return visible;
  }
}
export {
  ParallelMonitorOverlay
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9wYXJhbGxlbC1tb25pdG9yLW92ZXJsYXkudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFByb2plY3QvQXBwOiBHU0QtMlxuLy8gRmlsZSBQdXJwb3NlOiBQYXJhbGxlbCB3b3JrZXIgbW9uaXRvciBvdmVybGF5IHdpdGggd2lkdGgtc2FmZSBvcGVyYXRpb25zLWNvbnNvbGUgcmVuZGVyaW5nLlxuXG5pbXBvcnQgeyBleGlzdHNTeW5jLCBzdGF0U3luYywgcmVhZEZpbGVTeW5jLCBvcGVuU3luYywgcmVhZFN5bmMsIGNsb3NlU3luYywgcmVhZGRpclN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHNwYXduU3luYyB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcblxuaW1wb3J0IHR5cGUgeyBUaGVtZSB9IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuaW1wb3J0IHsgbWF0Y2hlc0tleSwgS2V5IH0gZnJvbSBcIkBnc2QvcGktdHVpXCI7XG5cbmltcG9ydCB7IGZvcm1hdER1cmF0aW9uIH0gZnJvbSBcIi4uL3NoYXJlZC9tb2QuanNcIjtcbmltcG9ydCB7IGZvcm1hdHRlZFNob3J0Y3V0UGFpciB9IGZyb20gXCIuL3Nob3J0Y3V0LWRlZnMuanNcIjtcbmltcG9ydCB7IHJlc29sdmVHc2RQYXRoQ29udHJhY3QgfSBmcm9tIFwiLi9wYXRocy5qc1wiO1xuaW1wb3J0IHtcbiAgcmVuZGVyQmFyLFxuICByZW5kZXJLZXlIaW50cyxcbiAgcmVuZGVyUHJvZ3Jlc3NCYXIsXG4gIHNhZmVMaW5lLFxuICBzdGF0dXNHbHlwaCxcbn0gZnJvbSBcIi4vdHVpL3JlbmRlci1raXQuanNcIjtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFR5cGVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5pbnRlcmZhY2UgU3RhdHVzSnNvbiB7XG4gIG1pbGVzdG9uZUlkOiBzdHJpbmc7XG4gIHBpZDogbnVtYmVyO1xuICBzdGF0ZTogc3RyaW5nO1xuICBjb3N0OiBudW1iZXI7XG4gIGxhc3RIZWFydGJlYXQ6IG51bWJlcjtcbiAgc3RhcnRlZEF0OiBudW1iZXI7XG4gIHdvcmt0cmVlUGF0aDogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgQXV0b0xvY2sge1xuICBwaWQ6IG51bWJlcjtcbiAgc3RhcnRlZEF0OiBzdHJpbmc7XG4gIHVuaXRUeXBlOiBzdHJpbmc7XG4gIHVuaXRJZDogc3RyaW5nO1xuICB1bml0U3RhcnRlZEF0OiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBTbGljZVByb2dyZXNzIHtcbiAgaWQ6IHN0cmluZztcbiAgc3RhdHVzOiBzdHJpbmc7XG4gIHRvdGFsOiBudW1iZXI7XG4gIGRvbmU6IG51bWJlcjtcbn1cblxuaW50ZXJmYWNlIFdvcmtlclZpZXcge1xuICBtaWQ6IHN0cmluZztcbiAgcGlkOiBudW1iZXI7XG4gIGFsaXZlOiBib29sZWFuO1xuICBzdGF0ZTogc3RyaW5nO1xuICBjb3N0OiBudW1iZXI7XG4gIGhlYXJ0YmVhdEFnZTogbnVtYmVyO1xuICBjdXJyZW50VW5pdDogc3RyaW5nIHwgbnVsbDtcbiAgdW5pdFR5cGU6IHN0cmluZyB8IG51bGw7XG4gIHVuaXRFbGFwc2VkOiBudW1iZXI7XG4gIGVsYXBzZWQ6IG51bWJlcjtcbiAgdG90YWxUYXNrczogbnVtYmVyO1xuICBkb25lVGFza3M6IG51bWJlcjtcbiAgdG90YWxTbGljZXM6IG51bWJlcjtcbiAgZG9uZVNsaWNlczogbnVtYmVyO1xuICBzbGljZXM6IFNsaWNlUHJvZ3Jlc3NbXTtcbiAgZXJyb3JzOiBzdHJpbmdbXTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIERhdGEgSGVscGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gcmVhZEpzb25TYWZlPFQ+KGZpbGVQYXRoOiBzdHJpbmcpOiBUIHwgbnVsbCB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGZpbGVQYXRoLCBcInV0Zi04XCIpKSBhcyBUO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5mdW5jdGlvbiBpc1BpZEFsaXZlKHBpZDogbnVtYmVyKTogYm9vbGVhbiB7XG4gIHRyeSB7XG4gICAgcHJvY2Vzcy5raWxsKHBpZCwgMCk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuXG5mdW5jdGlvbiB0YWlsUmVhZChmaWxlUGF0aDogc3RyaW5nLCBtYXhCeXRlczogbnVtYmVyKTogc3RyaW5nIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBzdGF0ID0gc3RhdFN5bmMoZmlsZVBhdGgpO1xuICAgIGNvbnN0IHJlYWRTaXplID0gTWF0aC5taW4oc3RhdC5zaXplLCBtYXhCeXRlcyk7XG4gICAgY29uc3QgZmQgPSBvcGVuU3luYyhmaWxlUGF0aCwgXCJyXCIpO1xuICAgIGNvbnN0IGJ1ZiA9IEJ1ZmZlci5hbGxvYyhyZWFkU2l6ZSk7XG4gICAgcmVhZFN5bmMoZmQsIGJ1ZiwgMCwgcmVhZFNpemUsIE1hdGgubWF4KDAsIHN0YXQuc2l6ZSAtIHJlYWRTaXplKSk7XG4gICAgY2xvc2VTeW5jKGZkKTtcbiAgICByZXR1cm4gYnVmLnRvU3RyaW5nKFwidXRmLThcIik7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBcIlwiO1xuICB9XG59XG5cbmZ1bmN0aW9uIGRpc2NvdmVyV29ya2VycyhiYXNlUGF0aDogc3RyaW5nKTogc3RyaW5nW10ge1xuICBjb25zdCBwYXJhbGxlbERpciA9IGpvaW4oYmFzZVBhdGgsIFwiLmdzZFwiLCBcInBhcmFsbGVsXCIpO1xuICBjb25zdCB3b3JrdHJlZURpciA9IGpvaW4oYmFzZVBhdGgsIFwiLmdzZFwiLCBcIndvcmt0cmVlc1wiKTtcbiAgY29uc3QgbWlkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4gIGlmIChleGlzdHNTeW5jKHBhcmFsbGVsRGlyKSkge1xuICAgIHRyeSB7XG4gICAgICBmb3IgKGNvbnN0IGYgb2YgcmVhZGRpclN5bmMocGFyYWxsZWxEaXIpKSB7XG4gICAgICAgIGlmIChmLmVuZHNXaXRoKFwiLnN0YXR1cy5qc29uXCIpKSBtaWRzLmFkZChmLnJlcGxhY2UoXCIuc3RhdHVzLmpzb25cIiwgXCJcIikpO1xuICAgICAgICBjb25zdCBtID0gZi5tYXRjaCgvXihNXFxkKylcXC4oc3RkZXJyfHN0ZG91dClcXC5sb2ckLyk7XG4gICAgICAgIGlmIChtKSBtaWRzLmFkZChtWzFdKTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIHsgLyogc2tpcCAqLyB9XG4gIH1cblxuICBpZiAoZXhpc3RzU3luYyh3b3JrdHJlZURpcikpIHtcbiAgICB0cnkge1xuICAgICAgZm9yIChjb25zdCBkIG9mIHJlYWRkaXJTeW5jKHdvcmt0cmVlRGlyKSkge1xuICAgICAgICBpZiAoZC5zdGFydHNXaXRoKFwiTVwiKSAmJiBleGlzdHNTeW5jKGpvaW4od29ya3RyZWVEaXIsIGQsIFwiLmdzZFwiLCBcImF1dG8ubG9ja1wiKSkpIHtcbiAgICAgICAgICBtaWRzLmFkZChkKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0gY2F0Y2ggeyAvKiBza2lwICovIH1cbiAgfVxuXG4gIHJldHVybiBbLi4ubWlkc10uc29ydCgpO1xufVxuXG5mdW5jdGlvbiBxdWVyeVNsaWNlUHJvZ3Jlc3MoYmFzZVBhdGg6IHN0cmluZywgbWlkOiBzdHJpbmcpOiBTbGljZVByb2dyZXNzW10ge1xuICBjb25zdCB3b3JrUm9vdCA9IGpvaW4oYmFzZVBhdGgsIFwiLmdzZFwiLCBcIndvcmt0cmVlc1wiLCBtaWQpO1xuICBjb25zdCBkYlBhdGggPSByZXNvbHZlR3NkUGF0aENvbnRyYWN0KHdvcmtSb290LCBiYXNlUGF0aCkucHJvamVjdERiO1xuICBpZiAoIWV4aXN0c1N5bmMoZGJQYXRoKSkgcmV0dXJuIFtdO1xuXG4gIHRyeSB7XG4gICAgY29uc3Qgc3FsID0gYFNFTEVDVCBzLmlkLCBzLnN0YXR1cywgQ09VTlQodC5pZCksIFNVTShDQVNFIFdIRU4gdC5zdGF0dXM9J2NvbXBsZXRlJyBUSEVOIDEgRUxTRSAwIEVORCkgRlJPTSBzbGljZXMgcyBMRUZUIEpPSU4gdGFza3MgdCBPTiBzLm1pbGVzdG9uZV9pZD10Lm1pbGVzdG9uZV9pZCBBTkQgcy5pZD10LnNsaWNlX2lkIFdIRVJFIHMubWlsZXN0b25lX2lkPScke21pZH0nIEdST1VQIEJZIHMuaWQgT1JERVIgQlkgcy5pZGA7XG4gICAgY29uc3QgcmVzdWx0ID0gc3Bhd25TeW5jKFwic3FsaXRlM1wiLCBbZGJQYXRoLCBzcWxdLCB7IHRpbWVvdXQ6IDMwMDAsIGVuY29kaW5nOiBcInV0Zi04XCIgfSk7XG4gICAgY29uc3Qgb3V0ID0gKHJlc3VsdC5zdGRvdXQgfHwgXCJcIikudHJpbSgpO1xuICAgIGlmICghb3V0IHx8IHJlc3VsdC5zdGF0dXMgIT09IDApIHJldHVybiBbXTtcbiAgICByZXR1cm4gb3V0LnNwbGl0KFwiXFxuXCIpLm1hcCgobGluZSkgPT4ge1xuICAgICAgY29uc3QgW2lkLCBzdGF0dXMsIHRvdGFsLCBkb25lXSA9IGxpbmUuc3BsaXQoXCJ8XCIpO1xuICAgICAgcmV0dXJuIHsgaWQsIHN0YXR1cywgdG90YWw6IHBhcnNlSW50KHRvdGFsLCAxMCksIGRvbmU6IHBhcnNlSW50KGRvbmUgfHwgXCIwXCIsIDEwKSB9O1xuICAgIH0pO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gW107XG4gIH1cbn1cblxuZnVuY3Rpb24gZXh0cmFjdENvc3RGcm9tTmRqc29uKGJhc2VQYXRoOiBzdHJpbmcsIG1pZDogc3RyaW5nKTogbnVtYmVyIHtcbiAgY29uc3Qgc3Rkb3V0UGF0aCA9IGpvaW4oYmFzZVBhdGgsIFwiLmdzZFwiLCBcInBhcmFsbGVsXCIsIGAke21pZH0uc3Rkb3V0LmxvZ2ApO1xuICBpZiAoIWV4aXN0c1N5bmMoc3Rkb3V0UGF0aCkpIHJldHVybiAwO1xuICB0cnkge1xuICAgIGNvbnN0IGNvbnRlbnQgPSByZWFkRmlsZVN5bmMoc3Rkb3V0UGF0aCwgXCJ1dGYtOFwiKTtcbiAgICBsZXQgdG90YWwgPSAwO1xuICAgIGZvciAoY29uc3QgbGluZSBvZiBjb250ZW50LnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgICBpZiAoIWxpbmUuaW5jbHVkZXMoXCJtZXNzYWdlX2VuZFwiKSkgY29udGludWU7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBvYmogPSBKU09OLnBhcnNlKGxpbmUpO1xuICAgICAgICBpZiAob2JqLnR5cGUgPT09IFwibWVzc2FnZV9lbmRcIikge1xuICAgICAgICAgIGNvbnN0IGNvc3QgPSBvYmoubWVzc2FnZT8udXNhZ2U/LmNvc3Q/LnRvdGFsO1xuICAgICAgICAgIGlmICh0eXBlb2YgY29zdCA9PT0gXCJudW1iZXJcIikgdG90YWwgKz0gY29zdDtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCB7IC8qIHNraXAgKi8gfVxuICAgIH1cbiAgICByZXR1cm4gdG90YWw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiAwO1xuICB9XG59XG5cbmZ1bmN0aW9uIHF1ZXJ5UmVjZW50Q29tcGxldGlvbnMoYmFzZVBhdGg6IHN0cmluZywgbWlkOiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IHdvcmtSb290ID0gam9pbihiYXNlUGF0aCwgXCIuZ3NkXCIsIFwid29ya3RyZWVzXCIsIG1pZCk7XG4gIGNvbnN0IGRiUGF0aCA9IHJlc29sdmVHc2RQYXRoQ29udHJhY3Qod29ya1Jvb3QsIGJhc2VQYXRoKS5wcm9qZWN0RGI7XG4gIGlmICghZXhpc3RzU3luYyhkYlBhdGgpKSByZXR1cm4gW107XG4gIHRyeSB7XG4gICAgY29uc3Qgc3FsID0gYFNFTEVDVCBpZCwgc2xpY2VfaWQsIG9uZV9saW5lciBGUk9NIHRhc2tzIFdIRVJFIG1pbGVzdG9uZV9pZD0nJHttaWR9JyBBTkQgc3RhdHVzPSdjb21wbGV0ZScgQU5EIGNvbXBsZXRlZF9hdCBJUyBOT1QgTlVMTCBPUkRFUiBCWSBjb21wbGV0ZWRfYXQgREVTQyBMSU1JVCA1YDtcbiAgICBjb25zdCByZXN1bHQgPSBzcGF3blN5bmMoXCJzcWxpdGUzXCIsIFtkYlBhdGgsIHNxbF0sIHsgdGltZW91dDogMzAwMCwgZW5jb2Rpbmc6IFwidXRmLThcIiB9KTtcbiAgICBjb25zdCBvdXQgPSAocmVzdWx0LnN0ZG91dCB8fCBcIlwiKS50cmltKCk7XG4gICAgaWYgKCFvdXQgfHwgcmVzdWx0LnN0YXR1cyAhPT0gMCkgcmV0dXJuIFtdO1xuICAgIHJldHVybiBvdXQuc3BsaXQoXCJcXG5cIikubWFwKChsaW5lKSA9PiB7XG4gICAgICBjb25zdCBbdGFza0lkLCBzbGljZUlkLCBvbmVMaW5lcl0gPSBsaW5lLnNwbGl0KFwifFwiKTtcbiAgICAgIHJldHVybiBgXHUyNzEzICR7bWlkfS8ke3NsaWNlSWR9LyR7dGFza0lkfSR7b25lTGluZXIgPyBcIjogXCIgKyBvbmVMaW5lciA6IFwiXCJ9YDtcbiAgICB9KTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG59XG5cbmZ1bmN0aW9uIGNvbGxlY3RXb3JrZXJEYXRhKGJhc2VQYXRoOiBzdHJpbmcpOiBXb3JrZXJWaWV3W10ge1xuICBjb25zdCBtaWRzID0gZGlzY292ZXJXb3JrZXJzKGJhc2VQYXRoKTtcbiAgY29uc3QgcGFyYWxsZWxEaXIgPSBqb2luKGJhc2VQYXRoLCBcIi5nc2RcIiwgXCJwYXJhbGxlbFwiKTtcbiAgY29uc3Qgd29ya2VyczogV29ya2VyVmlld1tdID0gW107XG5cbiAgZm9yIChjb25zdCBtaWQgb2YgbWlkcykge1xuICAgIGNvbnN0IHN0YXR1cyA9IHJlYWRKc29uU2FmZTxTdGF0dXNKc29uPihqb2luKHBhcmFsbGVsRGlyLCBgJHttaWR9LnN0YXR1cy5qc29uYCkpO1xuICAgIGNvbnN0IGxvY2sgPSByZWFkSnNvblNhZmU8QXV0b0xvY2s+KGpvaW4oYmFzZVBhdGgsIFwiLmdzZFwiLCBcIndvcmt0cmVlc1wiLCBtaWQsIFwiLmdzZFwiLCBcImF1dG8ubG9ja1wiKSk7XG4gICAgY29uc3Qgc2xpY2VzID0gcXVlcnlTbGljZVByb2dyZXNzKGJhc2VQYXRoLCBtaWQpO1xuXG4gICAgY29uc3QgcGlkID0gbG9jaz8ucGlkIHx8IHN0YXR1cz8ucGlkIHx8IDA7XG4gICAgY29uc3QgYWxpdmUgPSBwaWQgPyBpc1BpZEFsaXZlKHBpZCkgOiBmYWxzZTtcblxuICAgIC8vIEhlYXJ0YmVhdDogcHJlZmVyIHN0YXR1cy5qc29uIGlmIFBJRCBtYXRjaGVzLCBlbHNlIHVzZSBmaWxlIG10aW1lXG4gICAgbGV0IGhlYXJ0YmVhdEFnZSA9IEluZmluaXR5O1xuICAgIGNvbnN0IHN0YXR1c1BpZE1hdGNoZXMgPSBzdGF0dXM/LnBpZCA9PT0gcGlkICYmIHN0YXR1cz8ubGFzdEhlYXJ0YmVhdDtcbiAgICBpZiAoc3RhdHVzUGlkTWF0Y2hlcykge1xuICAgICAgaGVhcnRiZWF0QWdlID0gRGF0ZS5ub3coKSAtIHN0YXR1cyEubGFzdEhlYXJ0YmVhdDtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgbXRpbWVzOiBudW1iZXJbXSA9IFtdO1xuICAgICAgY29uc3Qgc3Rkb3V0TG9nID0gam9pbihwYXJhbGxlbERpciwgYCR7bWlkfS5zdGRvdXQubG9nYCk7XG4gICAgICBjb25zdCBzdGRlcnJMb2cgPSBqb2luKHBhcmFsbGVsRGlyLCBgJHttaWR9LnN0ZGVyci5sb2dgKTtcbiAgICAgIGlmIChleGlzdHNTeW5jKHN0ZG91dExvZykpIG10aW1lcy5wdXNoKHN0YXRTeW5jKHN0ZG91dExvZykubXRpbWVNcyk7XG4gICAgICBpZiAoZXhpc3RzU3luYyhzdGRlcnJMb2cpKSBtdGltZXMucHVzaChzdGF0U3luYyhzdGRlcnJMb2cpLm10aW1lTXMpO1xuICAgICAgaWYgKGxvY2s/LnVuaXRTdGFydGVkQXQpIG10aW1lcy5wdXNoKG5ldyBEYXRlKGxvY2sudW5pdFN0YXJ0ZWRBdCkuZ2V0VGltZSgpKTtcbiAgICAgIGlmIChtdGltZXMubGVuZ3RoID4gMCkgaGVhcnRiZWF0QWdlID0gRGF0ZS5ub3coKSAtIE1hdGgubWF4KC4uLm10aW1lcyk7XG4gICAgfVxuXG4gICAgbGV0IGNvc3QgPSBzdGF0dXM/LmNvc3QgfHwgMDtcbiAgICBpZiAoY29zdCA9PT0gMCkgY29zdCA9IGV4dHJhY3RDb3N0RnJvbU5kanNvbihiYXNlUGF0aCwgbWlkKTtcblxuICAgIGNvbnN0IHRvdGFsVGFza3MgPSBzbGljZXMucmVkdWNlKChzdW0sIHMpID0+IHN1bSArIHMudG90YWwsIDApO1xuICAgIGNvbnN0IGRvbmVUYXNrcyA9IHNsaWNlcy5yZWR1Y2UoKHN1bSwgcykgPT4gc3VtICsgcy5kb25lLCAwKTtcbiAgICBjb25zdCBkb25lU2xpY2VzID0gc2xpY2VzLmZpbHRlcigocykgPT4gcy5zdGF0dXMgPT09IFwiY29tcGxldGVcIikubGVuZ3RoO1xuXG4gICAgY29uc3QgZWxhcHNlZCA9IHN0YXR1cz8uc3RhcnRlZEF0XG4gICAgICA/IERhdGUubm93KCkgLSBzdGF0dXMuc3RhcnRlZEF0XG4gICAgICA6IGxvY2s/LnN0YXJ0ZWRBdFxuICAgICAgICA/IERhdGUubm93KCkgLSBuZXcgRGF0ZShsb2NrLnN0YXJ0ZWRBdCkuZ2V0VGltZSgpXG4gICAgICAgIDogMDtcblxuICAgIC8vIEVycm9ycyBmcm9tIHN0ZGVyciAobGFzdCA0S0IsIG9ubHkgbmV3IGNvbnRlbnQpXG4gICAgY29uc3QgZXJyb3JzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGNvbnN0IHN0ZGVyckxvZyA9IGpvaW4ocGFyYWxsZWxEaXIsIGAke21pZH0uc3RkZXJyLmxvZ2ApO1xuICAgIGlmIChleGlzdHNTeW5jKHN0ZGVyckxvZykpIHtcbiAgICAgIGNvbnN0IGNvbnRlbnQgPSB0YWlsUmVhZChzdGRlcnJMb2csIDQwOTYpO1xuICAgICAgZm9yIChjb25zdCBsaW5lIG9mIGNvbnRlbnQudHJpbSgpLnNwbGl0KFwiXFxuXCIpLnNsaWNlKC01KSkge1xuICAgICAgICBpZiAobGluZS5pbmNsdWRlcyhcImVycm9yXCIpIHx8IGxpbmUuaW5jbHVkZXMoXCJFcnJvclwiKSB8fCBsaW5lLmluY2x1ZGVzKFwiZXhpdGVkXCIpKSB7XG4gICAgICAgICAgZXJyb3JzLnB1c2gobGluZS50cmltKCkpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgd29ya2Vycy5wdXNoKHtcbiAgICAgIG1pZCxcbiAgICAgIHBpZCxcbiAgICAgIGFsaXZlLFxuICAgICAgc3RhdGU6IGFsaXZlID8gXCJydW5uaW5nXCIgOiAoc3RhdHVzPy5zdGF0ZSB8fCBcImRlYWRcIiksXG4gICAgICBjb3N0LFxuICAgICAgaGVhcnRiZWF0QWdlLFxuICAgICAgY3VycmVudFVuaXQ6IGxvY2s/LnVuaXRJZCB8fCBudWxsLFxuICAgICAgdW5pdFR5cGU6IGxvY2s/LnVuaXRUeXBlIHx8IG51bGwsXG4gICAgICB1bml0RWxhcHNlZDogbG9jaz8udW5pdFN0YXJ0ZWRBdCA/IERhdGUubm93KCkgLSBuZXcgRGF0ZShsb2NrLnVuaXRTdGFydGVkQXQpLmdldFRpbWUoKSA6IDAsXG4gICAgICBlbGFwc2VkLFxuICAgICAgdG90YWxUYXNrcyxcbiAgICAgIGRvbmVUYXNrcyxcbiAgICAgIHRvdGFsU2xpY2VzOiBzbGljZXMubGVuZ3RoLFxuICAgICAgZG9uZVNsaWNlcyxcbiAgICAgIHNsaWNlcyxcbiAgICAgIGVycm9ycyxcbiAgICB9KTtcbiAgfVxuXG4gIHJldHVybiB3b3JrZXJzO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUmVuZGVyaW5nIEhlbHBlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIHVuaXRUeXBlTGFiZWwodW5pdFR5cGU6IHN0cmluZyB8IG51bGwpOiBzdHJpbmcge1xuICBjb25zdCBsYWJlbHM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gICAgXCJleGVjdXRlLXRhc2tcIjogXCJFWEVDXCIsXG4gICAgXCJyZXNlYXJjaC1zbGljZVwiOiBcIlJTUkNIXCIsXG4gICAgXCJwbGFuLXNsaWNlXCI6IFwiUExBTlwiLFxuICAgIFwiY29tcGxldGUtc2xpY2VcIjogXCJET05FXCIsXG4gICAgXCJjb21wbGV0ZS10YXNrXCI6IFwiRE9ORVwiLFxuICAgIFwicmVhc3Nlc3NcIjogXCJBU1NFU1NcIixcbiAgICBcInZhbGlkYXRlXCI6IFwiVkFMSURcIixcbiAgICBcInJlYXNzZXNzLXJvYWRtYXBcIjogXCJBU1NFU1NcIixcbiAgfTtcbiAgcmV0dXJuIGxhYmVsc1t1bml0VHlwZSB8fCBcIlwiXSB8fCAodW5pdFR5cGUgfHwgXCItLS1cIikudG9VcHBlckNhc2UoKS5zbGljZSgwLCA1KTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIE92ZXJsYXkgQ2xhc3MgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBjbGFzcyBQYXJhbGxlbE1vbml0b3JPdmVybGF5IHtcbiAgcHJpdmF0ZSB0dWk6IHsgcmVxdWVzdFJlbmRlcjogKCkgPT4gdm9pZCB9O1xuICBwcml2YXRlIHRoZW1lOiBUaGVtZTtcbiAgcHJpdmF0ZSBvbkNsb3NlOiAoKSA9PiB2b2lkO1xuICBwcml2YXRlIGJhc2VQYXRoOiBzdHJpbmc7XG4gIHByaXZhdGUgcmVmcmVzaFRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRJbnRlcnZhbD47XG4gIHByaXZhdGUgd29ya2VyczogV29ya2VyVmlld1tdID0gW107XG4gIHByaXZhdGUgZXZlbnRzOiBzdHJpbmdbXSA9IFtdO1xuICBwcml2YXRlIGNhY2hlZExpbmVzPzogc3RyaW5nW107XG4gIHByaXZhdGUgY2FjaGVkV2lkdGg/OiBudW1iZXI7XG4gIHByaXZhdGUgc2Nyb2xsT2Zmc2V0ID0gMDtcbiAgcHJpdmF0ZSBkaXNwb3NlZCA9IGZhbHNlO1xuICBwcml2YXRlIHJlc2l6ZUhhbmRsZXI6ICgoKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuXG4gIGNvbnN0cnVjdG9yKFxuICAgIHR1aTogeyByZXF1ZXN0UmVuZGVyOiAoKSA9PiB2b2lkIH0sXG4gICAgdGhlbWU6IFRoZW1lLFxuICAgIG9uQ2xvc2U6ICgpID0+IHZvaWQsXG4gICAgYmFzZVBhdGg/OiBzdHJpbmcsXG4gICkge1xuICAgIHRoaXMudHVpID0gdHVpO1xuICAgIHRoaXMudGhlbWUgPSB0aGVtZTtcbiAgICB0aGlzLm9uQ2xvc2UgPSBvbkNsb3NlO1xuICAgIHRoaXMuYmFzZVBhdGggPSBiYXNlUGF0aCB8fCBwcm9jZXNzLmN3ZCgpO1xuXG4gICAgdGhpcy5yZXNpemVIYW5kbGVyID0gKCkgPT4ge1xuICAgICAgaWYgKHRoaXMuZGlzcG9zZWQpIHJldHVybjtcbiAgICAgIHRoaXMuaW52YWxpZGF0ZSgpO1xuICAgICAgdGhpcy50dWkucmVxdWVzdFJlbmRlcigpO1xuICAgIH07XG4gICAgcHJvY2Vzcy5zdGRvdXQub24oXCJyZXNpemVcIiwgdGhpcy5yZXNpemVIYW5kbGVyKTtcblxuICAgIHRoaXMucmVmcmVzaCgpO1xuICAgIHRoaXMucmVmcmVzaFRpbWVyID0gc2V0SW50ZXJ2YWwoKCkgPT4gdGhpcy5yZWZyZXNoKCksIDUwMDApO1xuICB9XG5cbiAgcHJpdmF0ZSByZWZyZXNoKCk6IHZvaWQge1xuICAgIGlmICh0aGlzLmRpc3Bvc2VkKSByZXR1cm47XG4gICAgdGhpcy53b3JrZXJzID0gY29sbGVjdFdvcmtlckRhdGEodGhpcy5iYXNlUGF0aCk7XG5cbiAgICAvLyBDb2xsZWN0IGNvbXBsZXRpb24gZXZlbnRzXG4gICAgZm9yIChjb25zdCB3ayBvZiB0aGlzLndvcmtlcnMpIHtcbiAgICAgIGNvbnN0IGNvbXBsZXRpb25zID0gcXVlcnlSZWNlbnRDb21wbGV0aW9ucyh0aGlzLmJhc2VQYXRoLCB3ay5taWQpO1xuICAgICAgZm9yIChjb25zdCBldnQgb2YgY29tcGxldGlvbnMpIHtcbiAgICAgICAgaWYgKCF0aGlzLmV2ZW50cy5pbmNsdWRlcyhldnQpKSB0aGlzLmV2ZW50cy5wdXNoKGV2dCk7XG4gICAgICB9XG4gICAgfVxuICAgIHRoaXMuZXZlbnRzID0gdGhpcy5ldmVudHMuc2xpY2UoLTEwKTtcblxuICAgIHRoaXMuY2FjaGVkTGluZXMgPSB1bmRlZmluZWQ7XG4gICAgdGhpcy5jYWNoZWRXaWR0aCA9IHVuZGVmaW5lZDtcbiAgICB0aGlzLnR1aS5yZXF1ZXN0UmVuZGVyKCk7XG4gIH1cblxuICBkaXNwb3NlKCk6IHZvaWQge1xuICAgIHRoaXMuZGlzcG9zZWQgPSB0cnVlO1xuICAgIGNsZWFySW50ZXJ2YWwodGhpcy5yZWZyZXNoVGltZXIpO1xuICAgIGlmICh0aGlzLnJlc2l6ZUhhbmRsZXIpIHtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LnJlbW92ZUxpc3RlbmVyKFwicmVzaXplXCIsIHRoaXMucmVzaXplSGFuZGxlcik7XG4gICAgICB0aGlzLnJlc2l6ZUhhbmRsZXIgPSBudWxsO1xuICAgIH1cbiAgfVxuXG4gIGhhbmRsZUlucHV0KGRhdGE6IHN0cmluZyk6IHZvaWQge1xuICAgIGlmIChcbiAgICAgIG1hdGNoZXNLZXkoZGF0YSwgS2V5LmVzY2FwZSkgfHxcbiAgICAgIG1hdGNoZXNLZXkoZGF0YSwgS2V5LmN0cmxBbHQoXCJwXCIpKSB8fFxuICAgICAgbWF0Y2hlc0tleShkYXRhLCBLZXkuY3RybFNoaWZ0KFwicFwiKSkgfHxcbiAgICAgIGRhdGEgPT09IFwicVwiXG4gICAgKSB7XG4gICAgICB0aGlzLmRpc3Bvc2UoKTtcbiAgICAgIHRoaXMub25DbG9zZSgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAobWF0Y2hlc0tleShkYXRhLCBLZXkuZG93bikgfHwgZGF0YSA9PT0gXCJqXCIpIHtcbiAgICAgIHRoaXMuc2Nyb2xsT2Zmc2V0Kys7XG4gICAgICB0aGlzLmludmFsaWRhdGUoKTtcbiAgICAgIHRoaXMudHVpLnJlcXVlc3RSZW5kZXIoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKG1hdGNoZXNLZXkoZGF0YSwgS2V5LnVwKSB8fCBkYXRhID09PSBcImtcIikge1xuICAgICAgdGhpcy5zY3JvbGxPZmZzZXQgPSBNYXRoLm1heCgwLCB0aGlzLnNjcm9sbE9mZnNldCAtIDEpO1xuICAgICAgdGhpcy5pbnZhbGlkYXRlKCk7XG4gICAgICB0aGlzLnR1aS5yZXF1ZXN0UmVuZGVyKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICB9XG5cbiAgaW52YWxpZGF0ZSgpOiB2b2lkIHtcbiAgICB0aGlzLmNhY2hlZExpbmVzID0gdW5kZWZpbmVkO1xuICAgIHRoaXMuY2FjaGVkV2lkdGggPSB1bmRlZmluZWQ7XG4gIH1cblxuICByZW5kZXIod2lkdGg6IG51bWJlcik6IHN0cmluZ1tdIHtcbiAgICBpZiAodGhpcy5jYWNoZWRMaW5lcyAmJiB0aGlzLmNhY2hlZFdpZHRoID09PSB3aWR0aCkgcmV0dXJuIHRoaXMuY2FjaGVkTGluZXM7XG5cbiAgICBjb25zdCB0ID0gdGhpcy50aGVtZTtcbiAgICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcbiAgICBjb25zdCB3ID0gTWF0aC5tYXgoMSwgd2lkdGgpO1xuXG4gICAgLy8gSGVhZGVyXG4gICAgY29uc3QgdG90YWxDb3N0ID0gdGhpcy53b3JrZXJzLnJlZHVjZSgocywgd2spID0+IHMgKyB3ay5jb3N0LCAwKTtcbiAgICBjb25zdCBhbGl2ZUNvdW50ID0gdGhpcy53b3JrZXJzLmZpbHRlcigod2spID0+IHdrLmFsaXZlKS5sZW5ndGg7XG4gICAgY29uc3Qgbm93ID0gbmV3IERhdGUoKS50b0xvY2FsZVRpbWVTdHJpbmcoKTtcblxuICAgIGxpbmVzLnB1c2godC5ib2xkKHQuZmcoXCJhY2NlbnRcIiwgXCIgR1NEIFBhcmFsbGVsIE1vbml0b3IgXCIpKSk7XG4gICAgbGluZXMucHVzaChcbiAgICAgIHQuZmcoXCJtdXRlZFwiLCBgICAke25vd30gIFx1MjUwMiAgJHthbGl2ZUNvdW50fS8ke3RoaXMud29ya2Vycy5sZW5ndGh9IGFsaXZlICBcdTI1MDIgIFRvdGFsOiBgKSArXG4gICAgICB0LmJvbGQoYCQke3RvdGFsQ29zdC50b0ZpeGVkKDIpfWApICtcbiAgICAgIHQuZmcoXCJtdXRlZFwiLCBcIiAgXHUyNTAyICA1cyByZWZyZXNoXCIpLFxuICAgICk7XG4gICAgbGluZXMucHVzaChyZW5kZXJCYXIodCwgdykpO1xuXG4gICAgaWYgKHRoaXMud29ya2Vycy5sZW5ndGggPT09IDApIHtcbiAgICAgIGxpbmVzLnB1c2goXCJcIik7XG4gICAgICBsaW5lcy5wdXNoKHQuZmcoXCJ3YXJuaW5nXCIsIFwiICBObyBwYXJhbGxlbCB3b3JrZXJzIGZvdW5kLlwiKSk7XG4gICAgICBsaW5lcy5wdXNoKHQuZmcoXCJtdXRlZFwiLCBcIiAgUnVuIC9nc2QgcGFyYWxsZWwgc3RhcnQgdG8gYmVnaW4uXCIpKTtcbiAgICB9IGVsc2Uge1xuICAgICAgZm9yIChjb25zdCB3ayBvZiB0aGlzLndvcmtlcnMpIHtcbiAgICAgICAgbGluZXMucHVzaChcIlwiKTtcblxuICAgICAgICAvLyBIZWFsdGggKyBJRCArIHN0YXRlXG4gICAgICAgIGNvbnN0IGhlYWx0aENvbG9yID0gd2suYWxpdmUgPyBcInN1Y2Nlc3NcIiA6IFwiZXJyb3JcIjtcbiAgICAgICAgY29uc3QgZ2x5cGggPSBzdGF0dXNHbHlwaCh0LCB3ay5hbGl2ZSA/IFwiYWN0aXZlXCIgOiBcImlkbGVcIik7XG4gICAgICAgIGNvbnN0IHN0YXRlVGV4dCA9IHdrLmFsaXZlXG4gICAgICAgICAgPyB0LmZnKFwic3VjY2Vzc1wiLCBcIlJVTk5JTkdcIilcbiAgICAgICAgICA6IHQuZmcoXCJlcnJvclwiLCB0LmJvbGQoXCJERUFEXCIpKTtcbiAgICAgICAgY29uc3QgaGVhcnRiZWF0VGV4dCA9IHdrLmhlYXJ0YmVhdEFnZSA9PT0gSW5maW5pdHlcbiAgICAgICAgICA/IFwibmV2ZXJcIlxuICAgICAgICAgIDogZm9ybWF0RHVyYXRpb24od2suaGVhcnRiZWF0QWdlKSArIFwiIGFnb1wiO1xuXG4gICAgICAgIGxpbmVzLnB1c2goXG4gICAgICAgICAgYCAgJHt0LmZnKGhlYWx0aENvbG9yLCBnbHlwaCl9ICAke3QuYm9sZCh3ay5taWQpfSAgJHtzdGF0ZVRleHR9ICBgICtcbiAgICAgICAgICB0LmZnKFwibXV0ZWRcIiwgYFBJRCAke3drLnBpZH0gIFx1MjUwMiAgZWxhcHNlZCAke2Zvcm1hdER1cmF0aW9uKHdrLmVsYXBzZWQpfSAgXHUyNTAyICBgKSArXG4gICAgICAgICAgYGNvc3QgJHt0LmJvbGQoXCIkXCIgKyB3ay5jb3N0LnRvRml4ZWQoMikpfSAgYCArXG4gICAgICAgICAgdC5mZyhcIm11dGVkXCIsIFwiXHUyNTAyICBoZWFydGJlYXQgXCIpICsgdC5mZyhoZWFsdGhDb2xvciwgaGVhcnRiZWF0VGV4dCksXG4gICAgICAgICk7XG5cbiAgICAgICAgLy8gQ3VycmVudCB1bml0XG4gICAgICAgIGlmICh3ay5jdXJyZW50VW5pdCkge1xuICAgICAgICAgIGNvbnN0IHBoYXNlQ29sb3IgPVxuICAgICAgICAgICAgd2sudW5pdFR5cGUgPT09IFwiZXhlY3V0ZS10YXNrXCIgPyBcImFjY2VudFwiXG4gICAgICAgICAgICA6IHdrLnVuaXRUeXBlID09PSBcInJlc2VhcmNoLXNsaWNlXCIgPyBcIndhcm5pbmdcIlxuICAgICAgICAgICAgOiB3ay51bml0VHlwZT8uaW5jbHVkZXMoXCJjb21wbGV0ZVwiKSA/IFwic3VjY2Vzc1wiXG4gICAgICAgICAgICA6IFwidGV4dFwiO1xuICAgICAgICAgIGxpbmVzLnB1c2goXG4gICAgICAgICAgICBgICAgICAke3QuZmcoXCJtdXRlZFwiLCBcIlx1MjVCOFwiKX0gJHt0LmZnKHBoYXNlQ29sb3IsIHVuaXRUeXBlTGFiZWwod2sudW5pdFR5cGUpKX0gICR7d2suY3VycmVudFVuaXR9ICBgICtcbiAgICAgICAgICAgIHQuZmcoXCJtdXRlZFwiLCBgKCR7Zm9ybWF0RHVyYXRpb24od2sudW5pdEVsYXBzZWQpfSlgKSxcbiAgICAgICAgICApO1xuICAgICAgICB9IGVsc2UgaWYgKCF3ay5hbGl2ZSkge1xuICAgICAgICAgIGxpbmVzLnB1c2goYCAgICAgJHt0LmZnKFwibXV0ZWRcIiwgXCJcdTI1QjhcIil9ICR7dC5mZyhcImVycm9yXCIsIFwic3RvcHBlZFwiKX1gKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBsaW5lcy5wdXNoKGAgICAgICR7dC5mZyhcIm11dGVkXCIsIFwiXHUyNUI4IGlkbGUgLyBiZXR3ZWVuIHVuaXRzXCIpfWApO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gU2xpY2UgcHJvZ3Jlc3MgY2hpcHNcbiAgICAgICAgaWYgKHdrLnNsaWNlcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgY29uc3QgY2hpcHMgPSB3ay5zbGljZXMubWFwKChzKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBwY3QgPSBzLnRvdGFsID4gMCA/IHMuZG9uZSAvIHMudG90YWwgOiAwO1xuICAgICAgICAgICAgY29uc3QgY29sb3IgPSBzLnN0YXR1cyA9PT0gXCJjb21wbGV0ZVwiID8gXCJzdWNjZXNzXCIgOiBwY3QgPiAwID8gXCJ3YXJuaW5nXCIgOiBcIm11dGVkXCI7XG4gICAgICAgICAgICByZXR1cm4gdC5mZyhjb2xvciwgYCR7cy5pZH06JHtzLmRvbmV9LyR7cy50b3RhbH1gKTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBsaW5lcy5wdXNoKGAgICAgICR7dC5mZyhcIm11dGVkXCIsIFwic2xpY2VzXCIpfSAgJHtjaGlwcy5qb2luKFwiICBcIil9YCk7XG5cbiAgICAgICAgICAvLyBUYXNrIHByb2dyZXNzIGJhclxuICAgICAgICAgIGNvbnN0IGJhcldpZHRoID0gTWF0aC5tYXgoNiwgTWF0aC5taW4oMjUsIHcgLSAzMikpO1xuICAgICAgICAgIGNvbnN0IGJhciA9IHJlbmRlclByb2dyZXNzQmFyKHQsIHdrLmRvbmVUYXNrcywgd2sudG90YWxUYXNrcywgYmFyV2lkdGgsIHtcbiAgICAgICAgICAgIGZpbGxlZENoYXI6IFwiXHUyNTg4XCIsXG4gICAgICAgICAgICBlbXB0eUNoYXI6IFwiXHUyNTkxXCIsXG4gICAgICAgICAgICBlbXB0eUNvbG9yOiBcImRpbVwiLFxuICAgICAgICAgIH0pO1xuICAgICAgICAgIGNvbnN0IHBjdCA9IHdrLnRvdGFsVGFza3MgPiAwID8gTWF0aC5yb3VuZCgod2suZG9uZVRhc2tzIC8gd2sudG90YWxUYXNrcykgKiAxMDApIDogMDtcbiAgICAgICAgICBsaW5lcy5wdXNoKFxuICAgICAgICAgICAgYCAgICAgJHt0LmZnKFwibXV0ZWRcIiwgXCJ0YXNrc1wiKX0gICAke2Jhcn0gICR7d2suZG9uZVRhc2tzfS8ke3drLnRvdGFsVGFza3N9IGAgK1xuICAgICAgICAgICAgdC5mZyhcIm11dGVkXCIsIGAoJHtwY3R9JSkgIFx1MjUwMiAgc2xpY2VzIGRvbmUgJHt3ay5kb25lU2xpY2VzfS8ke3drLnRvdGFsU2xpY2VzfWApLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBFcnJvcnNcbiAgICAgICAgZm9yIChjb25zdCBlcnIgb2Ygd2suZXJyb3JzLnNsaWNlKC0yKSkge1xuICAgICAgICAgIGxpbmVzLnB1c2goYCAgICAgJHt0LmZnKFwiZXJyb3JcIiwgXCIhIFwiICsgZXJyKX1gKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIC8vIEV2ZW50IGZlZWRcbiAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICAgIGxpbmVzLnB1c2gocmVuZGVyQmFyKHQsIHcpKTtcbiAgICBsaW5lcy5wdXNoKGAgICR7dC5ib2xkKFwiUmVjZW50IEV2ZW50c1wiKX1gKTtcblxuICAgIGlmICh0aGlzLmV2ZW50cy5sZW5ndGggPT09IDApIHtcbiAgICAgIGxpbmVzLnB1c2godC5mZyhcIm11dGVkXCIsIFwiICBObyBldmVudHMgeWV0Li4uXCIpKTtcbiAgICB9IGVsc2Uge1xuICAgICAgZm9yIChjb25zdCBldnQgb2YgdGhpcy5ldmVudHMuc2xpY2UoLTgpKSB7XG4gICAgICAgIGNvbnN0IG1pZCA9IGV2dC5tYXRjaCgvXlx1MjcxMyAoTVxcZCspXFwvLyk/LlsxXSB8fCBcIlwiO1xuICAgICAgICBsaW5lcy5wdXNoKGAgICR7dC5mZyhcIm11dGVkXCIsIFwiXHUyNTAyXCIpfSAke3QuZmcoXCJhY2NlbnRcIiwgbWlkKX0gJHtldnQucmVwbGFjZSgvXlx1MjcxMyBNXFxkK1xcLy8sIFwiXCIpfWApO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIEZvb3RlclxuICAgIGxpbmVzLnB1c2goXCJcIik7XG4gICAgY29uc3QgYWxsRG9uZSA9IHRoaXMud29ya2Vycy5sZW5ndGggPiAwICYmIHRoaXMud29ya2Vycy5ldmVyeSgod2spID0+ICF3ay5hbGl2ZSk7XG4gICAgaWYgKGFsbERvbmUpIHtcbiAgICAgIGxpbmVzLnB1c2godC5ib2xkKHQuZmcoXCJzdWNjZXNzXCIsIFwiICBBTEwgV09SS0VSUyBDT01QTEVURVwiKSkpO1xuICAgICAgZm9yIChjb25zdCB3ayBvZiB0aGlzLndvcmtlcnMpIHtcbiAgICAgICAgbGluZXMucHVzaChcbiAgICAgICAgICBgICAke3drLm1pZH0gICQke3drLmNvc3QudG9GaXhlZCgyKX0gIFx1MjUwMiAgJHt3ay5kb25lU2xpY2VzfS8ke3drLnRvdGFsU2xpY2VzfSBzbGljZXMgIGAgK1xuICAgICAgICAgIGAke3drLmRvbmVUYXNrc30vJHt3ay50b3RhbFRhc2tzfSB0YXNrcyAgXHUyNTAyICAke2Zvcm1hdER1cmF0aW9uKHdrLmVsYXBzZWQpfWAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBsaW5lcy5wdXNoKGAgICR7dC5ib2xkKFwiVG90YWw6ICRcIiArIHRoaXMud29ya2Vycy5yZWR1Y2UoKHMsIHdrKSA9PiBzICsgd2suY29zdCwgMCkudG9GaXhlZCgyKSl9YCk7XG4gICAgfVxuICAgIGxpbmVzLnB1c2gocmVuZGVyS2V5SGludHModCwgW2BFU0MvcS8ke2Zvcm1hdHRlZFNob3J0Y3V0UGFpcihcInBhcmFsbGVsXCIpfSBjbG9zZWAsIFwiXHUyMTkxXHUyMTkzIHNjcm9sbFwiXSwgdykpO1xuXG4gICAgLy8gQXBwbHkgc2Nyb2xsIFx1MjAxNCB1c2UgdGVybWluYWwgcm93cyBhcyBoZWlnaHQgZXN0aW1hdGVcbiAgICBjb25zdCB0ZXJtSGVpZ2h0ID0gcHJvY2Vzcy5zdGRvdXQucm93cyB8fCA0MDtcbiAgICBjb25zdCBtYXhTY3JvbGwgPSBNYXRoLm1heCgwLCBsaW5lcy5sZW5ndGggLSB0ZXJtSGVpZ2h0KTtcbiAgICB0aGlzLnNjcm9sbE9mZnNldCA9IE1hdGgubWluKE1hdGgubWF4KHRoaXMuc2Nyb2xsT2Zmc2V0LCAwKSwgbWF4U2Nyb2xsKTtcbiAgICBjb25zdCB2aXNpYmxlID0gbGluZXNcbiAgICAgIC5zbGljZSh0aGlzLnNjcm9sbE9mZnNldCwgdGhpcy5zY3JvbGxPZmZzZXQgKyB0ZXJtSGVpZ2h0KVxuICAgICAgLm1hcCgobGluZSkgPT4gc2FmZUxpbmUobGluZSwgdykpO1xuICAgIHRoaXMuY2FjaGVkTGluZXMgPSB2aXNpYmxlO1xuICAgIHRoaXMuY2FjaGVkV2lkdGggPSB3aWR0aDtcbiAgICByZXR1cm4gdmlzaWJsZTtcbiAgfVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBR0EsU0FBUyxZQUFZLFVBQVUsY0FBYyxVQUFVLFVBQVUsV0FBVyxtQkFBbUI7QUFDL0YsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsaUJBQWlCO0FBRzFCLFNBQVMs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
