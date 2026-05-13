import { truncateToWidth, visibleWidth, matchesKey, Key } from "@gsd/pi-tui";
import { ERROR_PATTERNS, WARNING_PATTERNS } from "./types.js";
import { formatUptime, formatTimeAgo } from "./utilities.js";
import {
  processes,
  killProcess,
  cleanupAll,
  restartProcess
} from "./process-manager.js";
class BgManagerOverlay {
  tui;
  theme;
  onClose;
  selected = 0;
  mode = "list";
  viewingProcess = null;
  scrollOffset = 0;
  cachedWidth;
  cachedLines;
  refreshTimer;
  constructor(tui, theme, onClose) {
    this.tui = tui;
    this.theme = theme;
    this.onClose = onClose;
    this.refreshTimer = setInterval(() => {
      this.invalidate();
      this.tui.requestRender();
    }, 1e3);
  }
  getProcessList() {
    return Array.from(processes.values());
  }
  selectAndView(index) {
    const procs = this.getProcessList();
    if (index >= 0 && index < procs.length) {
      this.selected = index;
      this.viewingProcess = procs[index];
      this.mode = "output";
      this.scrollOffset = Math.max(0, procs[index].output.length - 20);
    }
  }
  handleInput(data) {
    if (this.mode === "output") {
      this.handleOutputInput(data);
      return;
    }
    if (this.mode === "events") {
      this.handleEventsInput(data);
      return;
    }
    this.handleListInput(data);
  }
  handleListInput(data) {
    const procs = this.getProcessList();
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.ctrlAlt("b"))) {
      clearInterval(this.refreshTimer);
      this.onClose();
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      if (this.selected > 0) {
        this.selected--;
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      if (this.selected < procs.length - 1) {
        this.selected++;
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const proc = procs[this.selected];
      if (proc) {
        this.viewingProcess = proc;
        this.mode = "output";
        this.scrollOffset = Math.max(0, proc.output.length - 20);
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }
    if (data === "e") {
      const proc = procs[this.selected];
      if (proc) {
        this.viewingProcess = proc;
        this.mode = "events";
        this.scrollOffset = Math.max(0, proc.events.length - 15);
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }
    if (data === "r") {
      const proc = procs[this.selected];
      if (proc) {
        restartProcess(proc.id).then(() => {
          this.invalidate();
          this.tui.requestRender();
        }).catch((err) => {
          if (process.env.GSD_DEBUG) console.error("[bg-shell] restart failed:", err);
          this.invalidate();
          this.tui.requestRender();
        });
      }
      return;
    }
    if (data === "x" || data === "d") {
      const proc = procs[this.selected];
      if (proc && proc.alive) {
        killProcess(proc.id, "SIGTERM");
        setTimeout(() => {
          if (proc.alive) killProcess(proc.id, "SIGKILL");
          this.invalidate();
          this.tui.requestRender();
        }, 300);
      }
      return;
    }
    if (data === "X" || data === "D") {
      cleanupAll();
      this.selected = 0;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
  }
  handleOutputInput(data) {
    if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
      this.mode = "list";
      this.viewingProcess = null;
      this.scrollOffset = 0;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.mode = "events";
      if (this.viewingProcess) {
        this.scrollOffset = Math.max(0, this.viewingProcess.events.length - 15);
      }
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      if (this.viewingProcess) {
        const total = this.viewingProcess.output.length;
        this.scrollOffset = Math.min(this.scrollOffset + 5, Math.max(0, total - 20));
      }
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 5);
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (data === "G") {
      if (this.viewingProcess) {
        const total = this.viewingProcess.output.length;
        this.scrollOffset = Math.max(0, total - 20);
      }
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
  }
  handleEventsInput(data) {
    if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
      this.mode = "list";
      this.viewingProcess = null;
      this.scrollOffset = 0;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.mode = "output";
      if (this.viewingProcess) {
        this.scrollOffset = Math.max(0, this.viewingProcess.output.length - 20);
      }
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      if (this.viewingProcess) {
        this.scrollOffset = Math.min(this.scrollOffset + 3, Math.max(0, this.viewingProcess.events.length - 10));
      }
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 3);
      this.invalidate();
      this.tui.requestRender();
      return;
    }
  }
  render(width) {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }
    let lines;
    if (this.mode === "events") {
      lines = this.renderEvents(width);
    } else if (this.mode === "output") {
      lines = this.renderOutput(width);
    } else {
      lines = this.renderList(width);
    }
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
  box(inner, width) {
    const th = this.theme;
    const bdr = (s) => th.fg("borderMuted", s);
    const iw = width - 4;
    const lines = [];
    lines.push(bdr("\u256D" + "\u2500".repeat(width - 2) + "\u256E"));
    for (const line of inner) {
      const truncated = truncateToWidth(line, iw);
      const pad = Math.max(0, iw - visibleWidth(truncated));
      lines.push(bdr("\u2502") + " " + truncated + " ".repeat(pad) + " " + bdr("\u2502"));
    }
    lines.push(bdr("\u2570" + "\u2500".repeat(width - 2) + "\u256F"));
    return lines;
  }
  renderList(width) {
    const th = this.theme;
    const procs = this.getProcessList();
    const inner = [];
    if (procs.length === 0) {
      inner.push(th.fg("dim", "No background processes."));
      inner.push("");
      inner.push(th.fg("dim", "esc close"));
      return this.box(inner, width);
    }
    inner.push(th.fg("dim", "Background Processes"));
    inner.push("");
    for (let i = 0; i < procs.length; i++) {
      const p = procs[i];
      const sel = i === this.selected;
      const pointer = sel ? th.fg("accent", "\u25B8 ") : "  ";
      const statusIcon = p.alive ? p.status === "ready" ? th.fg("success", "\u25CF") : p.status === "error" ? th.fg("error", "\u25CF") : th.fg("warning", "\u25CF") : th.fg("dim", "\u25CB");
      const uptime = th.fg("dim", formatUptime(Date.now() - p.startedAt));
      const name = sel ? th.fg("text", p.label) : th.fg("muted", p.label);
      const typeTag = th.fg("dim", `[${p.processType}]`);
      const portInfo = p.ports.length > 0 ? th.fg("dim", ` :${p.ports.join(",")}`) : "";
      const errBadge = p.recentErrors.length > 0 ? th.fg("error", ` \u26A0${p.recentErrors.length}`) : "";
      const groupTag = p.group ? th.fg("dim", ` {${p.group}}`) : "";
      const restartBadge = p.restartCount > 0 ? th.fg("warning", ` \u21BB${p.restartCount}`) : "";
      const status = p.alive ? "" : "  " + th.fg("dim", `exit ${p.exitCode}`);
      inner.push(`${pointer}${statusIcon} ${name} ${typeTag} ${uptime}${portInfo}${errBadge}${groupTag}${restartBadge}${status}`);
    }
    inner.push("");
    inner.push(th.fg("dim", "\u2191\u2193 select \xB7 enter output \xB7 e events \xB7 r restart \xB7 x kill \xB7 esc close"));
    return this.box(inner, width);
  }
  processStatusHeader(p, activeTab) {
    const th = this.theme;
    if (!p) return { statusIcon: "", headerLine: "" };
    const statusIcon = p.alive ? p.status === "ready" ? th.fg("success", "\u25CF") : p.status === "error" ? th.fg("error", "\u25CF") : th.fg("warning", "\u25CF") : th.fg("dim", "\u25CB");
    const name = th.fg("muted", p.label);
    const uptime = th.fg("dim", formatUptime(Date.now() - p.startedAt));
    const typeTag = th.fg("dim", `[${p.processType}]`);
    const portInfo = p.ports.length > 0 ? th.fg("dim", ` :${p.ports.join(",")}`) : "";
    const tabIndicator = activeTab === "output" ? th.fg("accent", "[Output]") + " " + th.fg("dim", "Events") : th.fg("dim", "Output") + " " + th.fg("accent", "[Events]");
    const headerLine = `${statusIcon} ${name} ${typeTag} ${uptime}${portInfo}  ${tabIndicator}`;
    return { statusIcon, headerLine };
  }
  renderOutput(width) {
    const th = this.theme;
    const p = this.viewingProcess;
    if (!p) return [""];
    const inner = [];
    const { headerLine } = this.processStatusHeader(p, "output");
    inner.push(headerLine);
    inner.push("");
    const allOutput = p.output;
    const maxVisible = 18;
    const visible = allOutput.slice(this.scrollOffset, this.scrollOffset + maxVisible);
    if (allOutput.length === 0) {
      inner.push(th.fg("dim", "(no output)"));
    } else {
      for (const entry of visible) {
        const isError = ERROR_PATTERNS.some((pat) => pat.test(entry.line));
        const isWarning = !isError && WARNING_PATTERNS.some((pat) => pat.test(entry.line));
        const prefix = entry.stream === "stderr" ? th.fg("error", "\u26A0 ") : "";
        const color = isError ? "error" : isWarning ? "warning" : "dim";
        inner.push(prefix + th.fg(color, entry.line));
      }
      if (allOutput.length > maxVisible) {
        inner.push("");
        const pos = `${this.scrollOffset + 1}\u2013${Math.min(this.scrollOffset + maxVisible, allOutput.length)} of ${allOutput.length}`;
        inner.push(th.fg("dim", pos));
      }
    }
    inner.push("");
    inner.push(th.fg("dim", "\u2191\u2193 scroll \xB7 g/G top/end \xB7 tab events \xB7 q back"));
    return this.box(inner, width);
  }
  renderEvents(width) {
    const th = this.theme;
    const p = this.viewingProcess;
    if (!p) return [""];
    const inner = [];
    const { headerLine } = this.processStatusHeader(p, "events");
    inner.push(headerLine);
    inner.push("");
    if (p.events.length === 0) {
      inner.push(th.fg("dim", "(no events)"));
    } else {
      const maxVisible = 15;
      const visible = p.events.slice(this.scrollOffset, this.scrollOffset + maxVisible);
      for (const ev of visible) {
        const time = th.fg("dim", formatTimeAgo(ev.timestamp));
        const typeColor = ev.type === "crashed" || ev.type === "error_detected" ? "error" : ev.type === "ready" || ev.type === "recovered" ? "success" : ev.type === "port_open" ? "accent" : "dim";
        const typeLabel = th.fg(typeColor, ev.type);
        inner.push(`${time}  ${typeLabel}`);
        inner.push(`  ${th.fg("dim", ev.detail.slice(0, 80))}`);
      }
      if (p.events.length > maxVisible) {
        inner.push("");
        inner.push(th.fg("dim", `${this.scrollOffset + 1}\u2013${Math.min(this.scrollOffset + maxVisible, p.events.length)} of ${p.events.length} events`));
      }
    }
    inner.push("");
    inner.push(th.fg("dim", "\u2191\u2193 scroll \xB7 tab output \xB7 q back"));
    return this.box(inner, width);
  }
  dispose() {
    clearInterval(this.refreshTimer);
  }
  invalidate() {
    this.cachedWidth = void 0;
    this.cachedLines = void 0;
  }
}
export {
  BgManagerOverlay
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2JnLXNoZWxsL292ZXJsYXkudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogVFVJOiBCYWNrZ3JvdW5kIFByb2Nlc3MgTWFuYWdlciBPdmVybGF5LlxuICovXG5cbmltcG9ydCB0eXBlIHsgVGhlbWUgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB7IHRydW5jYXRlVG9XaWR0aCwgdmlzaWJsZVdpZHRoLCBtYXRjaGVzS2V5LCBLZXkgfSBmcm9tIFwiQGdzZC9waS10dWlcIjtcbmltcG9ydCB0eXBlIHsgQmdQcm9jZXNzLCBQcm9jZXNzU3RhdHVzIH0gZnJvbSBcIi4vdHlwZXMuanNcIjtcbmltcG9ydCB7IEVSUk9SX1BBVFRFUk5TLCBXQVJOSU5HX1BBVFRFUk5TIH0gZnJvbSBcIi4vdHlwZXMuanNcIjtcbmltcG9ydCB7IGZvcm1hdFVwdGltZSwgZm9ybWF0VGltZUFnbyB9IGZyb20gXCIuL3V0aWxpdGllcy5qc1wiO1xuaW1wb3J0IHtcblx0cHJvY2Vzc2VzLFxuXHRraWxsUHJvY2Vzcyxcblx0Y2xlYW51cEFsbCxcblx0cmVzdGFydFByb2Nlc3MsXG59IGZyb20gXCIuL3Byb2Nlc3MtbWFuYWdlci5qc1wiO1xuXG5leHBvcnQgY2xhc3MgQmdNYW5hZ2VyT3ZlcmxheSB7XG5cdHByaXZhdGUgdHVpOiB7IHJlcXVlc3RSZW5kZXI6ICgpID0+IHZvaWQgfTtcblx0cHJpdmF0ZSB0aGVtZTogVGhlbWU7XG5cdHByaXZhdGUgb25DbG9zZTogKCkgPT4gdm9pZDtcblx0cHJpdmF0ZSBzZWxlY3RlZCA9IDA7XG5cdHByaXZhdGUgbW9kZTogXCJsaXN0XCIgfCBcIm91dHB1dFwiIHwgXCJldmVudHNcIiA9IFwibGlzdFwiO1xuXHRwcml2YXRlIHZpZXdpbmdQcm9jZXNzOiBCZ1Byb2Nlc3MgfCBudWxsID0gbnVsbDtcblx0cHJpdmF0ZSBzY3JvbGxPZmZzZXQgPSAwO1xuXHRwcml2YXRlIGNhY2hlZFdpZHRoPzogbnVtYmVyO1xuXHRwcml2YXRlIGNhY2hlZExpbmVzPzogc3RyaW5nW107XG5cdHByaXZhdGUgcmVmcmVzaFRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRJbnRlcnZhbD47XG5cblx0Y29uc3RydWN0b3IoXG5cdFx0dHVpOiB7IHJlcXVlc3RSZW5kZXI6ICgpID0+IHZvaWQgfSxcblx0XHR0aGVtZTogVGhlbWUsXG5cdFx0b25DbG9zZTogKCkgPT4gdm9pZCxcblx0KSB7XG5cdFx0dGhpcy50dWkgPSB0dWk7XG5cdFx0dGhpcy50aGVtZSA9IHRoZW1lO1xuXHRcdHRoaXMub25DbG9zZSA9IG9uQ2xvc2U7XG5cdFx0dGhpcy5yZWZyZXNoVGltZXIgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG5cdFx0XHR0aGlzLmludmFsaWRhdGUoKTtcblx0XHRcdHRoaXMudHVpLnJlcXVlc3RSZW5kZXIoKTtcblx0XHR9LCAxMDAwKTtcblx0fVxuXG5cdHByaXZhdGUgZ2V0UHJvY2Vzc0xpc3QoKTogQmdQcm9jZXNzW10ge1xuXHRcdHJldHVybiBBcnJheS5mcm9tKHByb2Nlc3Nlcy52YWx1ZXMoKSk7XG5cdH1cblxuXHRzZWxlY3RBbmRWaWV3KGluZGV4OiBudW1iZXIpOiB2b2lkIHtcblx0XHRjb25zdCBwcm9jcyA9IHRoaXMuZ2V0UHJvY2Vzc0xpc3QoKTtcblx0XHRpZiAoaW5kZXggPj0gMCAmJiBpbmRleCA8IHByb2NzLmxlbmd0aCkge1xuXHRcdFx0dGhpcy5zZWxlY3RlZCA9IGluZGV4O1xuXHRcdFx0dGhpcy52aWV3aW5nUHJvY2VzcyA9IHByb2NzW2luZGV4XTtcblx0XHRcdHRoaXMubW9kZSA9IFwib3V0cHV0XCI7XG5cdFx0XHR0aGlzLnNjcm9sbE9mZnNldCA9IE1hdGgubWF4KDAsIHByb2NzW2luZGV4XS5vdXRwdXQubGVuZ3RoIC0gMjApO1xuXHRcdH1cblx0fVxuXG5cdGhhbmRsZUlucHV0KGRhdGE6IHN0cmluZyk6IHZvaWQge1xuXHRcdGlmICh0aGlzLm1vZGUgPT09IFwib3V0cHV0XCIpIHtcblx0XHRcdHRoaXMuaGFuZGxlT3V0cHV0SW5wdXQoZGF0YSk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXHRcdGlmICh0aGlzLm1vZGUgPT09IFwiZXZlbnRzXCIpIHtcblx0XHRcdHRoaXMuaGFuZGxlRXZlbnRzSW5wdXQoZGF0YSk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXHRcdHRoaXMuaGFuZGxlTGlzdElucHV0KGRhdGEpO1xuXHR9XG5cblx0cHJpdmF0ZSBoYW5kbGVMaXN0SW5wdXQoZGF0YTogc3RyaW5nKTogdm9pZCB7XG5cdFx0Y29uc3QgcHJvY3MgPSB0aGlzLmdldFByb2Nlc3NMaXN0KCk7XG5cblx0XHRpZiAobWF0Y2hlc0tleShkYXRhLCBLZXkuZXNjYXBlKSB8fCBtYXRjaGVzS2V5KGRhdGEsIEtleS5jdHJsKFwiY1wiKSkgfHwgbWF0Y2hlc0tleShkYXRhLCBLZXkuY3RybEFsdChcImJcIikpKSB7XG5cdFx0XHRjbGVhckludGVydmFsKHRoaXMucmVmcmVzaFRpbWVyKTtcblx0XHRcdHRoaXMub25DbG9zZSgpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGlmIChtYXRjaGVzS2V5KGRhdGEsIEtleS51cCkgfHwgbWF0Y2hlc0tleShkYXRhLCBcImtcIikpIHtcblx0XHRcdGlmICh0aGlzLnNlbGVjdGVkID4gMCkge1xuXHRcdFx0XHR0aGlzLnNlbGVjdGVkLS07XG5cdFx0XHRcdHRoaXMuaW52YWxpZGF0ZSgpO1xuXHRcdFx0XHR0aGlzLnR1aS5yZXF1ZXN0UmVuZGVyKCk7XG5cdFx0XHR9XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0aWYgKG1hdGNoZXNLZXkoZGF0YSwgS2V5LmRvd24pIHx8IG1hdGNoZXNLZXkoZGF0YSwgXCJqXCIpKSB7XG5cdFx0XHRpZiAodGhpcy5zZWxlY3RlZCA8IHByb2NzLmxlbmd0aCAtIDEpIHtcblx0XHRcdFx0dGhpcy5zZWxlY3RlZCsrO1xuXHRcdFx0XHR0aGlzLmludmFsaWRhdGUoKTtcblx0XHRcdFx0dGhpcy50dWkucmVxdWVzdFJlbmRlcigpO1xuXHRcdFx0fVxuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGlmIChtYXRjaGVzS2V5KGRhdGEsIEtleS5lbnRlcikpIHtcblx0XHRcdGNvbnN0IHByb2MgPSBwcm9jc1t0aGlzLnNlbGVjdGVkXTtcblx0XHRcdGlmIChwcm9jKSB7XG5cdFx0XHRcdHRoaXMudmlld2luZ1Byb2Nlc3MgPSBwcm9jO1xuXHRcdFx0XHR0aGlzLm1vZGUgPSBcIm91dHB1dFwiO1xuXHRcdFx0XHR0aGlzLnNjcm9sbE9mZnNldCA9IE1hdGgubWF4KDAsIHByb2Mub3V0cHV0Lmxlbmd0aCAtIDIwKTtcblx0XHRcdFx0dGhpcy5pbnZhbGlkYXRlKCk7XG5cdFx0XHRcdHRoaXMudHVpLnJlcXVlc3RSZW5kZXIoKTtcblx0XHRcdH1cblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHQvLyBlID0gdmlldyBldmVudHNcblx0XHRpZiAoZGF0YSA9PT0gXCJlXCIpIHtcblx0XHRcdGNvbnN0IHByb2MgPSBwcm9jc1t0aGlzLnNlbGVjdGVkXTtcblx0XHRcdGlmIChwcm9jKSB7XG5cdFx0XHRcdHRoaXMudmlld2luZ1Byb2Nlc3MgPSBwcm9jO1xuXHRcdFx0XHR0aGlzLm1vZGUgPSBcImV2ZW50c1wiO1xuXHRcdFx0XHR0aGlzLnNjcm9sbE9mZnNldCA9IE1hdGgubWF4KDAsIHByb2MuZXZlbnRzLmxlbmd0aCAtIDE1KTtcblx0XHRcdFx0dGhpcy5pbnZhbGlkYXRlKCk7XG5cdFx0XHRcdHRoaXMudHVpLnJlcXVlc3RSZW5kZXIoKTtcblx0XHRcdH1cblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHQvLyByID0gcmVzdGFydFxuXHRcdGlmIChkYXRhID09PSBcInJcIikge1xuXHRcdFx0Y29uc3QgcHJvYyA9IHByb2NzW3RoaXMuc2VsZWN0ZWRdO1xuXHRcdFx0aWYgKHByb2MpIHtcblx0XHRcdFx0cmVzdGFydFByb2Nlc3MocHJvYy5pZCkudGhlbigoKSA9PiB7XG5cdFx0XHRcdFx0dGhpcy5pbnZhbGlkYXRlKCk7XG5cdFx0XHRcdFx0dGhpcy50dWkucmVxdWVzdFJlbmRlcigpO1xuXHRcdFx0XHR9KS5jYXRjaCgoZXJyKSA9PiB7XG5cdFx0XHRcdFx0aWYgKHByb2Nlc3MuZW52LkdTRF9ERUJVRykgY29uc29sZS5lcnJvcignW2JnLXNoZWxsXSByZXN0YXJ0IGZhaWxlZDonLCBlcnIpO1xuXHRcdFx0XHRcdHRoaXMuaW52YWxpZGF0ZSgpO1xuXHRcdFx0XHRcdHRoaXMudHVpLnJlcXVlc3RSZW5kZXIoKTtcblx0XHRcdFx0fSk7XG5cdFx0XHR9XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Ly8geCBvciBkID0ga2lsbCBzZWxlY3RlZFxuXHRcdGlmIChkYXRhID09PSBcInhcIiB8fCBkYXRhID09PSBcImRcIikge1xuXHRcdFx0Y29uc3QgcHJvYyA9IHByb2NzW3RoaXMuc2VsZWN0ZWRdO1xuXHRcdFx0aWYgKHByb2MgJiYgcHJvYy5hbGl2ZSkge1xuXHRcdFx0XHRraWxsUHJvY2Vzcyhwcm9jLmlkLCBcIlNJR1RFUk1cIik7XG5cdFx0XHRcdHNldFRpbWVvdXQoKCkgPT4ge1xuXHRcdFx0XHRcdGlmIChwcm9jLmFsaXZlKSBraWxsUHJvY2Vzcyhwcm9jLmlkLCBcIlNJR0tJTExcIik7XG5cdFx0XHRcdFx0dGhpcy5pbnZhbGlkYXRlKCk7XG5cdFx0XHRcdFx0dGhpcy50dWkucmVxdWVzdFJlbmRlcigpO1xuXHRcdFx0XHR9LCAzMDApO1xuXHRcdFx0fVxuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdC8vIFggb3IgRCA9IGtpbGwgYWxsXG5cdFx0aWYgKGRhdGEgPT09IFwiWFwiIHx8IGRhdGEgPT09IFwiRFwiKSB7XG5cdFx0XHRjbGVhbnVwQWxsKCk7XG5cdFx0XHR0aGlzLnNlbGVjdGVkID0gMDtcblx0XHRcdHRoaXMuaW52YWxpZGF0ZSgpO1xuXHRcdFx0dGhpcy50dWkucmVxdWVzdFJlbmRlcigpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgaGFuZGxlT3V0cHV0SW5wdXQoZGF0YTogc3RyaW5nKTogdm9pZCB7XG5cdFx0aWYgKG1hdGNoZXNLZXkoZGF0YSwgS2V5LmVzY2FwZSkgfHwgbWF0Y2hlc0tleShkYXRhLCBcInFcIikpIHtcblx0XHRcdHRoaXMubW9kZSA9IFwibGlzdFwiO1xuXHRcdFx0dGhpcy52aWV3aW5nUHJvY2VzcyA9IG51bGw7XG5cdFx0XHR0aGlzLnNjcm9sbE9mZnNldCA9IDA7XG5cdFx0XHR0aGlzLmludmFsaWRhdGUoKTtcblx0XHRcdHRoaXMudHVpLnJlcXVlc3RSZW5kZXIoKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHQvLyBUYWIgdG8gc3dpdGNoIHRvIGV2ZW50cyB2aWV3XG5cdFx0aWYgKG1hdGNoZXNLZXkoZGF0YSwgS2V5LnRhYikpIHtcblx0XHRcdHRoaXMubW9kZSA9IFwiZXZlbnRzXCI7XG5cdFx0XHRpZiAodGhpcy52aWV3aW5nUHJvY2Vzcykge1xuXHRcdFx0XHR0aGlzLnNjcm9sbE9mZnNldCA9IE1hdGgubWF4KDAsIHRoaXMudmlld2luZ1Byb2Nlc3MuZXZlbnRzLmxlbmd0aCAtIDE1KTtcblx0XHRcdH1cblx0XHRcdHRoaXMuaW52YWxpZGF0ZSgpO1xuXHRcdFx0dGhpcy50dWkucmVxdWVzdFJlbmRlcigpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGlmIChtYXRjaGVzS2V5KGRhdGEsIEtleS5kb3duKSB8fCBtYXRjaGVzS2V5KGRhdGEsIFwialwiKSkge1xuXHRcdFx0aWYgKHRoaXMudmlld2luZ1Byb2Nlc3MpIHtcblx0XHRcdFx0Y29uc3QgdG90YWwgPSB0aGlzLnZpZXdpbmdQcm9jZXNzLm91dHB1dC5sZW5ndGg7XG5cdFx0XHRcdHRoaXMuc2Nyb2xsT2Zmc2V0ID0gTWF0aC5taW4odGhpcy5zY3JvbGxPZmZzZXQgKyA1LCBNYXRoLm1heCgwLCB0b3RhbCAtIDIwKSk7XG5cdFx0XHR9XG5cdFx0XHR0aGlzLmludmFsaWRhdGUoKTtcblx0XHRcdHRoaXMudHVpLnJlcXVlc3RSZW5kZXIoKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRpZiAobWF0Y2hlc0tleShkYXRhLCBLZXkudXApIHx8IG1hdGNoZXNLZXkoZGF0YSwgXCJrXCIpKSB7XG5cdFx0XHR0aGlzLnNjcm9sbE9mZnNldCA9IE1hdGgubWF4KDAsIHRoaXMuc2Nyb2xsT2Zmc2V0IC0gNSk7XG5cdFx0XHR0aGlzLmludmFsaWRhdGUoKTtcblx0XHRcdHRoaXMudHVpLnJlcXVlc3RSZW5kZXIoKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRpZiAoZGF0YSA9PT0gXCJHXCIpIHtcblx0XHRcdGlmICh0aGlzLnZpZXdpbmdQcm9jZXNzKSB7XG5cdFx0XHRcdGNvbnN0IHRvdGFsID0gdGhpcy52aWV3aW5nUHJvY2Vzcy5vdXRwdXQubGVuZ3RoO1xuXHRcdFx0XHR0aGlzLnNjcm9sbE9mZnNldCA9IE1hdGgubWF4KDAsIHRvdGFsIC0gMjApO1xuXHRcdFx0fVxuXHRcdFx0dGhpcy5pbnZhbGlkYXRlKCk7XG5cdFx0XHR0aGlzLnR1aS5yZXF1ZXN0UmVuZGVyKCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0aWYgKGRhdGEgPT09IFwiZ1wiKSB7XG5cdFx0XHR0aGlzLnNjcm9sbE9mZnNldCA9IDA7XG5cdFx0XHR0aGlzLmludmFsaWRhdGUoKTtcblx0XHRcdHRoaXMudHVpLnJlcXVlc3RSZW5kZXIoKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIGhhbmRsZUV2ZW50c0lucHV0KGRhdGE6IHN0cmluZyk6IHZvaWQge1xuXHRcdGlmIChtYXRjaGVzS2V5KGRhdGEsIEtleS5lc2NhcGUpIHx8IG1hdGNoZXNLZXkoZGF0YSwgXCJxXCIpKSB7XG5cdFx0XHR0aGlzLm1vZGUgPSBcImxpc3RcIjtcblx0XHRcdHRoaXMudmlld2luZ1Byb2Nlc3MgPSBudWxsO1xuXHRcdFx0dGhpcy5zY3JvbGxPZmZzZXQgPSAwO1xuXHRcdFx0dGhpcy5pbnZhbGlkYXRlKCk7XG5cdFx0XHR0aGlzLnR1aS5yZXF1ZXN0UmVuZGVyKCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Ly8gVGFiIHRvIHN3aXRjaCBiYWNrIHRvIG91dHB1dCB2aWV3XG5cdFx0aWYgKG1hdGNoZXNLZXkoZGF0YSwgS2V5LnRhYikpIHtcblx0XHRcdHRoaXMubW9kZSA9IFwib3V0cHV0XCI7XG5cdFx0XHRpZiAodGhpcy52aWV3aW5nUHJvY2Vzcykge1xuXHRcdFx0XHR0aGlzLnNjcm9sbE9mZnNldCA9IE1hdGgubWF4KDAsIHRoaXMudmlld2luZ1Byb2Nlc3Mub3V0cHV0Lmxlbmd0aCAtIDIwKTtcblx0XHRcdH1cblx0XHRcdHRoaXMuaW52YWxpZGF0ZSgpO1xuXHRcdFx0dGhpcy50dWkucmVxdWVzdFJlbmRlcigpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGlmIChtYXRjaGVzS2V5KGRhdGEsIEtleS5kb3duKSB8fCBtYXRjaGVzS2V5KGRhdGEsIFwialwiKSkge1xuXHRcdFx0aWYgKHRoaXMudmlld2luZ1Byb2Nlc3MpIHtcblx0XHRcdFx0dGhpcy5zY3JvbGxPZmZzZXQgPSBNYXRoLm1pbih0aGlzLnNjcm9sbE9mZnNldCArIDMsIE1hdGgubWF4KDAsIHRoaXMudmlld2luZ1Byb2Nlc3MuZXZlbnRzLmxlbmd0aCAtIDEwKSk7XG5cdFx0XHR9XG5cdFx0XHR0aGlzLmludmFsaWRhdGUoKTtcblx0XHRcdHRoaXMudHVpLnJlcXVlc3RSZW5kZXIoKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRpZiAobWF0Y2hlc0tleShkYXRhLCBLZXkudXApIHx8IG1hdGNoZXNLZXkoZGF0YSwgXCJrXCIpKSB7XG5cdFx0XHR0aGlzLnNjcm9sbE9mZnNldCA9IE1hdGgubWF4KDAsIHRoaXMuc2Nyb2xsT2Zmc2V0IC0gMyk7XG5cdFx0XHR0aGlzLmludmFsaWRhdGUoKTtcblx0XHRcdHRoaXMudHVpLnJlcXVlc3RSZW5kZXIoKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cdH1cblxuXHRyZW5kZXIod2lkdGg6IG51bWJlcik6IHN0cmluZ1tdIHtcblx0XHRpZiAodGhpcy5jYWNoZWRMaW5lcyAmJiB0aGlzLmNhY2hlZFdpZHRoID09PSB3aWR0aCkge1xuXHRcdFx0cmV0dXJuIHRoaXMuY2FjaGVkTGluZXM7XG5cdFx0fVxuXG5cdFx0bGV0IGxpbmVzOiBzdHJpbmdbXTtcblx0XHRpZiAodGhpcy5tb2RlID09PSBcImV2ZW50c1wiKSB7XG5cdFx0XHRsaW5lcyA9IHRoaXMucmVuZGVyRXZlbnRzKHdpZHRoKTtcblx0XHR9IGVsc2UgaWYgKHRoaXMubW9kZSA9PT0gXCJvdXRwdXRcIikge1xuXHRcdFx0bGluZXMgPSB0aGlzLnJlbmRlck91dHB1dCh3aWR0aCk7XG5cdFx0fSBlbHNlIHtcblx0XHRcdGxpbmVzID0gdGhpcy5yZW5kZXJMaXN0KHdpZHRoKTtcblx0XHR9XG5cblx0XHR0aGlzLmNhY2hlZFdpZHRoID0gd2lkdGg7XG5cdFx0dGhpcy5jYWNoZWRMaW5lcyA9IGxpbmVzO1xuXHRcdHJldHVybiBsaW5lcztcblx0fVxuXG5cdHByaXZhdGUgYm94KGlubmVyOiBzdHJpbmdbXSwgd2lkdGg6IG51bWJlcik6IHN0cmluZ1tdIHtcblx0XHRjb25zdCB0aCA9IHRoaXMudGhlbWU7XG5cdFx0Y29uc3QgYmRyID0gKHM6IHN0cmluZykgPT4gdGguZmcoXCJib3JkZXJNdXRlZFwiLCBzKTtcblx0XHRjb25zdCBpdyA9IHdpZHRoIC0gNDtcblx0XHRjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcblxuXHRcdGxpbmVzLnB1c2goYmRyKFwiXHUyNTZEXCIgKyBcIlx1MjUwMFwiLnJlcGVhdCh3aWR0aCAtIDIpICsgXCJcdTI1NkVcIikpO1xuXHRcdGZvciAoY29uc3QgbGluZSBvZiBpbm5lcikge1xuXHRcdFx0Y29uc3QgdHJ1bmNhdGVkID0gdHJ1bmNhdGVUb1dpZHRoKGxpbmUsIGl3KTtcblx0XHRcdGNvbnN0IHBhZCA9IE1hdGgubWF4KDAsIGl3IC0gdmlzaWJsZVdpZHRoKHRydW5jYXRlZCkpO1xuXHRcdFx0bGluZXMucHVzaChiZHIoXCJcdTI1MDJcIikgKyBcIiBcIiArIHRydW5jYXRlZCArIFwiIFwiLnJlcGVhdChwYWQpICsgXCIgXCIgKyBiZHIoXCJcdTI1MDJcIikpO1xuXHRcdH1cblx0XHRsaW5lcy5wdXNoKGJkcihcIlx1MjU3MFwiICsgXCJcdTI1MDBcIi5yZXBlYXQod2lkdGggLSAyKSArIFwiXHUyNTZGXCIpKTtcblx0XHRyZXR1cm4gbGluZXM7XG5cdH1cblxuXHRwcml2YXRlIHJlbmRlckxpc3Qod2lkdGg6IG51bWJlcik6IHN0cmluZ1tdIHtcblx0XHRjb25zdCB0aCA9IHRoaXMudGhlbWU7XG5cdFx0Y29uc3QgcHJvY3MgPSB0aGlzLmdldFByb2Nlc3NMaXN0KCk7XG5cdFx0Y29uc3QgaW5uZXI6IHN0cmluZ1tdID0gW107XG5cblx0XHRpZiAocHJvY3MubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRpbm5lci5wdXNoKHRoLmZnKFwiZGltXCIsIFwiTm8gYmFja2dyb3VuZCBwcm9jZXNzZXMuXCIpKTtcblx0XHRcdGlubmVyLnB1c2goXCJcIik7XG5cdFx0XHRpbm5lci5wdXNoKHRoLmZnKFwiZGltXCIsIFwiZXNjIGNsb3NlXCIpKTtcblx0XHRcdHJldHVybiB0aGlzLmJveChpbm5lciwgd2lkdGgpO1xuXHRcdH1cblxuXHRcdGlubmVyLnB1c2godGguZmcoXCJkaW1cIiwgXCJCYWNrZ3JvdW5kIFByb2Nlc3Nlc1wiKSk7XG5cdFx0aW5uZXIucHVzaChcIlwiKTtcblxuXHRcdGZvciAobGV0IGkgPSAwOyBpIDwgcHJvY3MubGVuZ3RoOyBpKyspIHtcblx0XHRcdGNvbnN0IHAgPSBwcm9jc1tpXTtcblx0XHRcdGNvbnN0IHNlbCA9IGkgPT09IHRoaXMuc2VsZWN0ZWQ7XG5cdFx0XHRjb25zdCBwb2ludGVyID0gc2VsID8gdGguZmcoXCJhY2NlbnRcIiwgXCJcdTI1QjggXCIpIDogXCIgIFwiO1xuXG5cdFx0XHRjb25zdCBzdGF0dXNJY29uID0gcC5hbGl2ZVxuXHRcdFx0XHQ/IChwLnN0YXR1cyA9PT0gXCJyZWFkeVwiID8gdGguZmcoXCJzdWNjZXNzXCIsIFwiXHUyNUNGXCIpXG5cdFx0XHRcdFx0OiBwLnN0YXR1cyA9PT0gXCJlcnJvclwiID8gdGguZmcoXCJlcnJvclwiLCBcIlx1MjVDRlwiKVxuXHRcdFx0XHRcdDogdGguZmcoXCJ3YXJuaW5nXCIsIFwiXHUyNUNGXCIpKVxuXHRcdFx0XHQ6IHRoLmZnKFwiZGltXCIsIFwiXHUyNUNCXCIpO1xuXG5cdFx0XHRjb25zdCB1cHRpbWUgPSB0aC5mZyhcImRpbVwiLCBmb3JtYXRVcHRpbWUoRGF0ZS5ub3coKSAtIHAuc3RhcnRlZEF0KSk7XG5cdFx0XHRjb25zdCBuYW1lID0gc2VsID8gdGguZmcoXCJ0ZXh0XCIsIHAubGFiZWwpIDogdGguZmcoXCJtdXRlZFwiLCBwLmxhYmVsKTtcblx0XHRcdGNvbnN0IHR5cGVUYWcgPSB0aC5mZyhcImRpbVwiLCBgWyR7cC5wcm9jZXNzVHlwZX1dYCk7XG5cdFx0XHRjb25zdCBwb3J0SW5mbyA9IHAucG9ydHMubGVuZ3RoID4gMCA/IHRoLmZnKFwiZGltXCIsIGAgOiR7cC5wb3J0cy5qb2luKFwiLFwiKX1gKSA6IFwiXCI7XG5cdFx0XHRjb25zdCBlcnJCYWRnZSA9IHAucmVjZW50RXJyb3JzLmxlbmd0aCA+IDAgPyB0aC5mZyhcImVycm9yXCIsIGAgXHUyNkEwJHtwLnJlY2VudEVycm9ycy5sZW5ndGh9YCkgOiBcIlwiO1xuXHRcdFx0Y29uc3QgZ3JvdXBUYWcgPSBwLmdyb3VwID8gdGguZmcoXCJkaW1cIiwgYCB7JHtwLmdyb3VwfX1gKSA6IFwiXCI7XG5cdFx0XHRjb25zdCByZXN0YXJ0QmFkZ2UgPSBwLnJlc3RhcnRDb3VudCA+IDAgPyB0aC5mZyhcIndhcm5pbmdcIiwgYCBcdTIxQkIke3AucmVzdGFydENvdW50fWApIDogXCJcIjtcblxuXHRcdFx0Y29uc3Qgc3RhdHVzID0gcC5hbGl2ZSA/IFwiXCIgOiBcIiAgXCIgKyB0aC5mZyhcImRpbVwiLCBgZXhpdCAke3AuZXhpdENvZGV9YCk7XG5cblx0XHRcdGlubmVyLnB1c2goYCR7cG9pbnRlcn0ke3N0YXR1c0ljb259ICR7bmFtZX0gJHt0eXBlVGFnfSAke3VwdGltZX0ke3BvcnRJbmZvfSR7ZXJyQmFkZ2V9JHtncm91cFRhZ30ke3Jlc3RhcnRCYWRnZX0ke3N0YXR1c31gKTtcblx0XHR9XG5cblx0XHRpbm5lci5wdXNoKFwiXCIpO1xuXHRcdGlubmVyLnB1c2godGguZmcoXCJkaW1cIiwgXCJcdTIxOTFcdTIxOTMgc2VsZWN0IFx1MDBCNyBlbnRlciBvdXRwdXQgXHUwMEI3IGUgZXZlbnRzIFx1MDBCNyByIHJlc3RhcnQgXHUwMEI3IHgga2lsbCBcdTAwQjcgZXNjIGNsb3NlXCIpKTtcblxuXHRcdHJldHVybiB0aGlzLmJveChpbm5lciwgd2lkdGgpO1xuXHR9XG5cblx0cHJpdmF0ZSBwcm9jZXNzU3RhdHVzSGVhZGVyKHA6IHR5cGVvZiB0aGlzLnZpZXdpbmdQcm9jZXNzLCBhY3RpdmVUYWI6IFwib3V0cHV0XCIgfCBcImV2ZW50c1wiKTogeyBzdGF0dXNJY29uOiBzdHJpbmc7IGhlYWRlckxpbmU6IHN0cmluZyB9IHtcblx0XHRjb25zdCB0aCA9IHRoaXMudGhlbWU7XG5cdFx0aWYgKCFwKSByZXR1cm4geyBzdGF0dXNJY29uOiBcIlwiLCBoZWFkZXJMaW5lOiBcIlwiIH07XG5cdFx0Y29uc3Qgc3RhdHVzSWNvbiA9IHAuYWxpdmVcblx0XHRcdD8gKHAuc3RhdHVzID09PSBcInJlYWR5XCIgPyB0aC5mZyhcInN1Y2Nlc3NcIiwgXCJcdTI1Q0ZcIilcblx0XHRcdFx0OiBwLnN0YXR1cyA9PT0gXCJlcnJvclwiID8gdGguZmcoXCJlcnJvclwiLCBcIlx1MjVDRlwiKVxuXHRcdFx0XHQ6IHRoLmZnKFwid2FybmluZ1wiLCBcIlx1MjVDRlwiKSlcblx0XHRcdDogdGguZmcoXCJkaW1cIiwgXCJcdTI1Q0JcIik7XG5cdFx0Y29uc3QgbmFtZSA9IHRoLmZnKFwibXV0ZWRcIiwgcC5sYWJlbCk7XG5cdFx0Y29uc3QgdXB0aW1lID0gdGguZmcoXCJkaW1cIiwgZm9ybWF0VXB0aW1lKERhdGUubm93KCkgLSBwLnN0YXJ0ZWRBdCkpO1xuXHRcdGNvbnN0IHR5cGVUYWcgPSB0aC5mZyhcImRpbVwiLCBgWyR7cC5wcm9jZXNzVHlwZX1dYCk7XG5cdFx0Y29uc3QgcG9ydEluZm8gPSBwLnBvcnRzLmxlbmd0aCA+IDAgPyB0aC5mZyhcImRpbVwiLCBgIDoke3AucG9ydHMuam9pbihcIixcIil9YCkgOiBcIlwiO1xuXHRcdGNvbnN0IHRhYkluZGljYXRvciA9IGFjdGl2ZVRhYiA9PT0gXCJvdXRwdXRcIlxuXHRcdFx0PyB0aC5mZyhcImFjY2VudFwiLCBcIltPdXRwdXRdXCIpICsgXCIgXCIgKyB0aC5mZyhcImRpbVwiLCBcIkV2ZW50c1wiKVxuXHRcdFx0OiB0aC5mZyhcImRpbVwiLCBcIk91dHB1dFwiKSArIFwiIFwiICsgdGguZmcoXCJhY2NlbnRcIiwgXCJbRXZlbnRzXVwiKTtcblx0XHRjb25zdCBoZWFkZXJMaW5lID0gYCR7c3RhdHVzSWNvbn0gJHtuYW1lfSAke3R5cGVUYWd9ICR7dXB0aW1lfSR7cG9ydEluZm99ICAke3RhYkluZGljYXRvcn1gO1xuXHRcdHJldHVybiB7IHN0YXR1c0ljb24sIGhlYWRlckxpbmUgfTtcblx0fVxuXG5cdHByaXZhdGUgcmVuZGVyT3V0cHV0KHdpZHRoOiBudW1iZXIpOiBzdHJpbmdbXSB7XG5cdFx0Y29uc3QgdGggPSB0aGlzLnRoZW1lO1xuXHRcdGNvbnN0IHAgPSB0aGlzLnZpZXdpbmdQcm9jZXNzO1xuXHRcdGlmICghcCkgcmV0dXJuIFtcIlwiXTtcblx0XHRjb25zdCBpbm5lcjogc3RyaW5nW10gPSBbXTtcblxuXHRcdGNvbnN0IHsgaGVhZGVyTGluZSB9ID0gdGhpcy5wcm9jZXNzU3RhdHVzSGVhZGVyKHAsIFwib3V0cHV0XCIpO1xuXHRcdGlubmVyLnB1c2goaGVhZGVyTGluZSk7XG5cdFx0aW5uZXIucHVzaChcIlwiKTtcblxuXHRcdC8vIFVuaWZpZWQgYnVmZmVyIGlzIGFscmVhZHkgY2hyb25vbG9naWNhbGx5IGludGVybGVhdmVkXG5cdFx0Y29uc3QgYWxsT3V0cHV0ID0gcC5vdXRwdXQ7XG5cblx0XHRjb25zdCBtYXhWaXNpYmxlID0gMTg7XG5cdFx0Y29uc3QgdmlzaWJsZSA9IGFsbE91dHB1dC5zbGljZSh0aGlzLnNjcm9sbE9mZnNldCwgdGhpcy5zY3JvbGxPZmZzZXQgKyBtYXhWaXNpYmxlKTtcblxuXHRcdGlmIChhbGxPdXRwdXQubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRpbm5lci5wdXNoKHRoLmZnKFwiZGltXCIsIFwiKG5vIG91dHB1dClcIikpO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHRmb3IgKGNvbnN0IGVudHJ5IG9mIHZpc2libGUpIHtcblx0XHRcdFx0Y29uc3QgaXNFcnJvciA9IEVSUk9SX1BBVFRFUk5TLnNvbWUocGF0ID0+IHBhdC50ZXN0KGVudHJ5LmxpbmUpKTtcblx0XHRcdFx0Y29uc3QgaXNXYXJuaW5nID0gIWlzRXJyb3IgJiYgV0FSTklOR19QQVRURVJOUy5zb21lKHBhdCA9PiBwYXQudGVzdChlbnRyeS5saW5lKSk7XG5cdFx0XHRcdGNvbnN0IHByZWZpeCA9IGVudHJ5LnN0cmVhbSA9PT0gXCJzdGRlcnJcIiA/IHRoLmZnKFwiZXJyb3JcIiwgXCJcdTI2QTAgXCIpIDogXCJcIjtcblx0XHRcdFx0Y29uc3QgY29sb3IgPSBpc0Vycm9yID8gXCJlcnJvclwiIDogaXNXYXJuaW5nID8gXCJ3YXJuaW5nXCIgOiBcImRpbVwiO1xuXHRcdFx0XHRpbm5lci5wdXNoKHByZWZpeCArIHRoLmZnKGNvbG9yLCBlbnRyeS5saW5lKSk7XG5cdFx0XHR9XG5cblx0XHRcdGlmIChhbGxPdXRwdXQubGVuZ3RoID4gbWF4VmlzaWJsZSkge1xuXHRcdFx0XHRpbm5lci5wdXNoKFwiXCIpO1xuXHRcdFx0XHRjb25zdCBwb3MgPSBgJHt0aGlzLnNjcm9sbE9mZnNldCArIDF9XHUyMDEzJHtNYXRoLm1pbih0aGlzLnNjcm9sbE9mZnNldCArIG1heFZpc2libGUsIGFsbE91dHB1dC5sZW5ndGgpfSBvZiAke2FsbE91dHB1dC5sZW5ndGh9YDtcblx0XHRcdFx0aW5uZXIucHVzaCh0aC5mZyhcImRpbVwiLCBwb3MpKTtcblx0XHRcdH1cblx0XHR9XG5cblx0XHRpbm5lci5wdXNoKFwiXCIpO1xuXHRcdGlubmVyLnB1c2godGguZmcoXCJkaW1cIiwgXCJcdTIxOTFcdTIxOTMgc2Nyb2xsIFx1MDBCNyBnL0cgdG9wL2VuZCBcdTAwQjcgdGFiIGV2ZW50cyBcdTAwQjcgcSBiYWNrXCIpKTtcblxuXHRcdHJldHVybiB0aGlzLmJveChpbm5lciwgd2lkdGgpO1xuXHR9XG5cblx0cHJpdmF0ZSByZW5kZXJFdmVudHMod2lkdGg6IG51bWJlcik6IHN0cmluZ1tdIHtcblx0XHRjb25zdCB0aCA9IHRoaXMudGhlbWU7XG5cdFx0Y29uc3QgcCA9IHRoaXMudmlld2luZ1Byb2Nlc3M7XG5cdFx0aWYgKCFwKSByZXR1cm4gW1wiXCJdO1xuXHRcdGNvbnN0IGlubmVyOiBzdHJpbmdbXSA9IFtdO1xuXG5cdFx0Y29uc3QgeyBoZWFkZXJMaW5lIH0gPSB0aGlzLnByb2Nlc3NTdGF0dXNIZWFkZXIocCwgXCJldmVudHNcIik7XG5cdFx0aW5uZXIucHVzaChoZWFkZXJMaW5lKTtcblx0XHRpbm5lci5wdXNoKFwiXCIpO1xuXG5cdFx0aWYgKHAuZXZlbnRzLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0aW5uZXIucHVzaCh0aC5mZyhcImRpbVwiLCBcIihubyBldmVudHMpXCIpKTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0Y29uc3QgbWF4VmlzaWJsZSA9IDE1O1xuXHRcdFx0Y29uc3QgdmlzaWJsZSA9IHAuZXZlbnRzLnNsaWNlKHRoaXMuc2Nyb2xsT2Zmc2V0LCB0aGlzLnNjcm9sbE9mZnNldCArIG1heFZpc2libGUpO1xuXG5cdFx0XHRmb3IgKGNvbnN0IGV2IG9mIHZpc2libGUpIHtcblx0XHRcdFx0Y29uc3QgdGltZSA9IHRoLmZnKFwiZGltXCIsIGZvcm1hdFRpbWVBZ28oZXYudGltZXN0YW1wKSk7XG5cdFx0XHRcdGNvbnN0IHR5cGVDb2xvciA9IGV2LnR5cGUgPT09IFwiY3Jhc2hlZFwiIHx8IGV2LnR5cGUgPT09IFwiZXJyb3JfZGV0ZWN0ZWRcIiA/IFwiZXJyb3JcIlxuXHRcdFx0XHRcdDogZXYudHlwZSA9PT0gXCJyZWFkeVwiIHx8IGV2LnR5cGUgPT09IFwicmVjb3ZlcmVkXCIgPyBcInN1Y2Nlc3NcIlxuXHRcdFx0XHRcdDogZXYudHlwZSA9PT0gXCJwb3J0X29wZW5cIiA/IFwiYWNjZW50XCJcblx0XHRcdFx0XHQ6IFwiZGltXCI7XG5cdFx0XHRcdGNvbnN0IHR5cGVMYWJlbCA9IHRoLmZnKHR5cGVDb2xvciwgZXYudHlwZSk7XG5cdFx0XHRcdGlubmVyLnB1c2goYCR7dGltZX0gICR7dHlwZUxhYmVsfWApO1xuXHRcdFx0XHRpbm5lci5wdXNoKGAgICR7dGguZmcoXCJkaW1cIiwgZXYuZGV0YWlsLnNsaWNlKDAsIDgwKSl9YCk7XG5cdFx0XHR9XG5cblx0XHRcdGlmIChwLmV2ZW50cy5sZW5ndGggPiBtYXhWaXNpYmxlKSB7XG5cdFx0XHRcdGlubmVyLnB1c2goXCJcIik7XG5cdFx0XHRcdGlubmVyLnB1c2godGguZmcoXCJkaW1cIiwgYCR7dGhpcy5zY3JvbGxPZmZzZXQgKyAxfVx1MjAxMyR7TWF0aC5taW4odGhpcy5zY3JvbGxPZmZzZXQgKyBtYXhWaXNpYmxlLCBwLmV2ZW50cy5sZW5ndGgpfSBvZiAke3AuZXZlbnRzLmxlbmd0aH0gZXZlbnRzYCkpO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdGlubmVyLnB1c2goXCJcIik7XG5cdFx0aW5uZXIucHVzaCh0aC5mZyhcImRpbVwiLCBcIlx1MjE5MVx1MjE5MyBzY3JvbGwgXHUwMEI3IHRhYiBvdXRwdXQgXHUwMEI3IHEgYmFja1wiKSk7XG5cblx0XHRyZXR1cm4gdGhpcy5ib3goaW5uZXIsIHdpZHRoKTtcblx0fVxuXG5cdGRpc3Bvc2UoKTogdm9pZCB7XG5cdFx0Y2xlYXJJbnRlcnZhbCh0aGlzLnJlZnJlc2hUaW1lcik7XG5cdH1cblxuXHRpbnZhbGlkYXRlKCk6IHZvaWQge1xuXHRcdHRoaXMuY2FjaGVkV2lkdGggPSB1bmRlZmluZWQ7XG5cdFx0dGhpcy5jYWNoZWRMaW5lcyA9IHVuZGVmaW5lZDtcblx0fVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBS0EsU0FBUyxpQkFBaUIsY0FBYyxZQUFZLFdBQVc7QUFFL0QsU0FBUyxnQkFBZ0Isd0JBQXdCO0FBQ2pELFNBQVMsY0FBYyxxQkFBcUI7QUFDNUM7QUFBQSxFQUNDO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDTTtBQUVBLE1BQU0saUJBQWlCO0FBQUEsRUFDckI7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0EsV0FBVztBQUFBLEVBQ1gsT0FBcUM7QUFBQSxFQUNyQyxpQkFBbUM7QUFBQSxFQUNuQyxlQUFlO0FBQUEsRUFDZjtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFFUixZQUNDLEtBQ0EsT0FDQSxTQUNDO0FBQ0QsU0FBSyxNQUFNO0FBQ1gsU0FBSyxRQUFRO0FBQ2IsU0FBSyxVQUFVO0FBQ2YsU0FBSyxlQUFlLFlBQVksTUFBTTtBQUNyQyxXQUFLLFdBQVc7QUFDaEIsV0FBSyxJQUFJLGNBQWM7QUFBQSxJQUN4QixHQUFHLEdBQUk7QUFBQSxFQUNSO0FBQUEsRUFFUSxpQkFBOEI7QUFDckMsV0FBTyxNQUFNLEtBQUssVUFBVSxPQUFPLENBQUM7QUFBQSxFQUNyQztBQUFBLEVBRUEsY0FBYyxPQUFxQjtBQUNsQyxVQUFNLFFBQVEsS0FBSyxlQUFlO0FBQ2xDLFFBQUksU0FBUyxLQUFLLFFBQVEsTUFBTSxRQUFRO0FBQ3ZDLFdBQUssV0FBVztBQUNoQixXQUFLLGlCQUFpQixNQUFNLEtBQUs7QUFDakMsV0FBSyxPQUFPO0FBQ1osV0FBSyxlQUFlLEtBQUssSUFBSSxHQUFHLE1BQU0sS0FBSyxFQUFFLE9BQU8sU0FBUyxFQUFFO0FBQUEsSUFDaEU7QUFBQSxFQUNEO0FBQUEsRUFF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
