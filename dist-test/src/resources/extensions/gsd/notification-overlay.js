import { truncateToWidth, visibleWidth, matchesKey, Key } from "@gsd/pi-tui";
import {
  readNotifications,
  markAllRead,
  clearNotifications,
  onNotificationStoreChange
} from "./notification-store.js";
import { formattedShortcutPair } from "./shortcut-defs.js";
import {
  padRightVisible,
  renderFrame,
  renderKeyHints,
  rightAlign,
  wrapVisibleText
} from "./tui/render-kit.js";
const FILTER_CYCLE = ["all", "error", "warning", "success", "info"];
const OVERLAY_WIDTH = "58%";
const OVERLAY_MIN_WIDTH = 68;
const OVERLAY_MAX_HEIGHT_PERCENT = 52;
const OVERLAY_MARGIN = { top: 2, right: 2, bottom: 6, left: 2 };
function notificationOverlayOptions() {
  return {
    width: OVERLAY_WIDTH,
    minWidth: OVERLAY_MIN_WIDTH,
    maxHeight: `${OVERLAY_MAX_HEIGHT_PERCENT}%`,
    anchor: "top-center",
    row: "24%",
    margin: OVERLAY_MARGIN,
    backdrop: true
  };
}
function severityIcon(severity) {
  switch (severity) {
    case "error":
      return "\u2717";
    case "warning":
      return "\u26A0";
    case "success":
      return "\u2713";
    case "info":
    default:
      return "\u25CF";
  }
}
function formatTimestamp(ts) {
  try {
    const d = new Date(ts);
    const now = Date.now();
    const diffMs = now - d.getTime();
    if (diffMs < 6e4) return "just now";
    if (diffMs < 36e5) return `${Math.floor(diffMs / 6e4)}m ago`;
    if (diffMs < 864e5) return `${Math.floor(diffMs / 36e5)}h ago`;
    return `${Math.floor(diffMs / 864e5)}d ago`;
  } catch {
    return ts.slice(11, 19);
  }
}
function notificationSignature(entries) {
  return entries.map((entry) => `${entry.ts}|${entry.severity}|${entry.read ? 1 : 0}|${entry.message}`).join("\n");
}
class GSDNotificationOverlay {
  tui;
  theme;
  onClose;
  cachedWidth;
  cachedLines;
  scrollOffset = 0;
  filterIndex = 0;
  entries = [];
  entriesSignature = "";
  refreshTimer;
  disposed = false;
  resizeHandler = null;
  unsubscribeStore = null;
  constructor(tui, theme, onClose) {
    this.tui = tui;
    this.theme = theme;
    this.onClose = onClose;
    markAllRead();
    this.entries = readNotifications();
    this.entriesSignature = notificationSignature(this.entries);
    this.resizeHandler = () => {
      if (this.disposed) return;
      this.invalidate();
      this.tui.requestRender();
    };
    process.stdout.on("resize", this.resizeHandler);
    this.unsubscribeStore = onNotificationStoreChange(() => {
      if (this.disposed) return;
      this._refreshFromDisk();
    });
    this.refreshTimer = setInterval(() => {
      if (this.disposed) return;
      this._refreshFromDisk();
    }, 3e4);
  }
  get filter() {
    return FILTER_CYCLE[this.filterIndex];
  }
  get filteredEntries() {
    if (this.filter === "all") return this.entries;
    return this.entries.filter((e) => e.severity === this.filter);
  }
  handleInput(data) {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.ctrlAlt("n")) || matchesKey(data, Key.ctrlShift("n"))) {
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
    if (data === "f") {
      this.filterIndex = (this.filterIndex + 1) % FILTER_CYCLE.length;
      this.scrollOffset = 0;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (data === "c") {
      clearNotifications();
      this.entries = [];
      this.entriesSignature = notificationSignature(this.entries);
      this.scrollOffset = 0;
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
    const terminalRows = process.stdout.rows || 32;
    const availableRows = Math.max(1, terminalRows - OVERLAY_MARGIN.top - OVERLAY_MARGIN.bottom);
    const overlayRows = Math.min(
      availableRows,
      Math.max(1, Math.floor(terminalRows * OVERLAY_MAX_HEIGHT_PERCENT / 100))
    );
    const maxVisibleRows = Math.max(5, overlayRows - 2);
    const visibleContentRows = Math.min(content.length, maxVisibleRows);
    const maxScroll = Math.max(0, content.length - visibleContentRows);
    this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
    const visibleContent = content.slice(this.scrollOffset, this.scrollOffset + visibleContentRows);
    const lines = renderFrame(this.theme, visibleContent, width);
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
  invalidate() {
    this.cachedLines = void 0;
    this.cachedWidth = void 0;
  }
  dispose() {
    this.disposed = true;
    clearInterval(this.refreshTimer);
    if (this.unsubscribeStore) {
      this.unsubscribeStore();
      this.unsubscribeStore = null;
    }
    if (this.resizeHandler) {
      process.stdout.removeListener("resize", this.resizeHandler);
      this.resizeHandler = null;
    }
  }
  _refreshFromDisk() {
    const fresh = readNotifications();
    const signature = notificationSignature(fresh);
    if (signature !== this.entriesSignature) {
      markAllRead();
      this.entries = readNotifications();
      this.entriesSignature = notificationSignature(this.entries);
      this.invalidate();
      this.tui.requestRender();
    }
  }
  buildContentLines(width) {
    const th = this.theme;
    const shellWidth = Math.max(1, width - 4);
    const contentWidth = shellWidth;
    const lines = [];
    const row = (content = "") => {
      const truncated = truncateToWidth(content, contentWidth);
      return padRightVisible(truncated, contentWidth);
    };
    const blank = () => row("");
    const hr = () => row(th.fg("dim", "\u2500".repeat(contentWidth)));
    const title = th.fg("accent", th.bold("Notifications"));
    const filterLabel = this.filter === "all" ? th.fg("dim", "all") : th.fg(
      this.filter === "error" ? "error" : this.filter === "warning" ? "warning" : this.filter === "success" ? "success" : "dim",
      this.filter
    );
    const count = `${this.filteredEntries.length} entries`;
    lines.push(row(rightAlign(
      `${title}  ${th.fg("dim", "filter:")} ${filterLabel}`,
      th.fg("dim", count),
      contentWidth
    )));
    lines.push(hr());
    const closeShortcut = formattedShortcutPair("notifications");
    lines.push(row(renderKeyHints(th, ["\u2191/\u2193 scroll", "f filter", "c clear", `Esc/${closeShortcut} close`], contentWidth)));
    lines.push(blank());
    const filtered = this.filteredEntries;
    if (filtered.length === 0) {
      lines.push(blank());
      lines.push(row(th.fg("dim", this.entries.length === 0 ? "No notifications yet." : `No ${this.filter} notifications.`)));
      lines.push(blank());
      return lines;
    }
    for (const entry of filtered) {
      const icon = severityIcon(entry.severity);
      const coloredIcon = entry.severity === "error" ? th.fg("error", icon) : entry.severity === "warning" ? th.fg("warning", icon) : entry.severity === "success" ? th.fg("success", icon) : th.fg("dim", icon);
      const time = th.fg("dim", formatTimestamp(entry.ts));
      const source = entry.source === "workflow-logger" ? th.fg("dim", " [engine]") : "";
      const prefix = `${coloredIcon} ${time}${source}  `;
      const prefixWidth = visibleWidth(prefix);
      const msgMaxWidth = Math.max(10, contentWidth - prefixWidth);
      const msgLines = wrapVisibleText(entry.message, msgMaxWidth);
      const indent = " ".repeat(prefixWidth);
      for (let i = 0; i < msgLines.length; i++) {
        if (i === 0) {
          lines.push(row(`${prefix}${msgLines[i]}`));
        } else {
          lines.push(row(`${indent}${msgLines[i]}`));
        }
      }
    }
    return lines;
  }
}
export {
  GSDNotificationOverlay,
  notificationOverlayOptions
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9ub3RpZmljYXRpb24tb3ZlcmxheS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IE5vdGlmaWNhdGlvbiBoaXN0b3J5IG92ZXJsYXkgd2l0aCBzZXZlcml0eSBmaWx0ZXJpbmcgYW5kIHdpZHRoLXNhZmUgVFVJIHJlbmRlcmluZy5cblxuaW1wb3J0IHR5cGUgeyBUaGVtZSB9IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuaW1wb3J0IHsgdHJ1bmNhdGVUb1dpZHRoLCB2aXNpYmxlV2lkdGgsIG1hdGNoZXNLZXksIEtleSB9IGZyb20gXCJAZ3NkL3BpLXR1aVwiO1xuXG5pbXBvcnQge1xuICByZWFkTm90aWZpY2F0aW9ucyxcbiAgbWFya0FsbFJlYWQsXG4gIGNsZWFyTm90aWZpY2F0aW9ucyxcbiAgb25Ob3RpZmljYXRpb25TdG9yZUNoYW5nZSxcbiAgdHlwZSBOb3RpZmljYXRpb25FbnRyeSxcbiAgdHlwZSBOb3RpZnlTZXZlcml0eSxcbn0gZnJvbSBcIi4vbm90aWZpY2F0aW9uLXN0b3JlLmpzXCI7XG5pbXBvcnQgeyBmb3JtYXR0ZWRTaG9ydGN1dFBhaXIgfSBmcm9tIFwiLi9zaG9ydGN1dC1kZWZzLmpzXCI7XG5pbXBvcnQge1xuICBwYWRSaWdodFZpc2libGUsXG4gIHJlbmRlckZyYW1lLFxuICByZW5kZXJLZXlIaW50cyxcbiAgcmlnaHRBbGlnbixcbiAgd3JhcFZpc2libGVUZXh0LFxufSBmcm9tIFwiLi90dWkvcmVuZGVyLWtpdC5qc1wiO1xuXG50eXBlIEZpbHRlck1vZGUgPSBcImFsbFwiIHwgXCJlcnJvclwiIHwgXCJ3YXJuaW5nXCIgfCBcInN1Y2Nlc3NcIiB8IFwiaW5mb1wiO1xuY29uc3QgRklMVEVSX0NZQ0xFOiBGaWx0ZXJNb2RlW10gPSBbXCJhbGxcIiwgXCJlcnJvclwiLCBcIndhcm5pbmdcIiwgXCJzdWNjZXNzXCIsIFwiaW5mb1wiXTtcbmNvbnN0IE9WRVJMQVlfV0lEVEggPSBcIjU4JVwiO1xuY29uc3QgT1ZFUkxBWV9NSU5fV0lEVEggPSA2ODtcbmNvbnN0IE9WRVJMQVlfTUFYX0hFSUdIVF9QRVJDRU5UID0gNTI7XG5jb25zdCBPVkVSTEFZX01BUkdJTiA9IHsgdG9wOiAyLCByaWdodDogMiwgYm90dG9tOiA2LCBsZWZ0OiAyIH0gYXMgY29uc3Q7XG5cbmV4cG9ydCBmdW5jdGlvbiBub3RpZmljYXRpb25PdmVybGF5T3B0aW9ucygpIHtcbiAgcmV0dXJuIHtcbiAgICB3aWR0aDogT1ZFUkxBWV9XSURUSCxcbiAgICBtaW5XaWR0aDogT1ZFUkxBWV9NSU5fV0lEVEgsXG4gICAgbWF4SGVpZ2h0OiBgJHtPVkVSTEFZX01BWF9IRUlHSFRfUEVSQ0VOVH0lYCxcbiAgICBhbmNob3I6IFwidG9wLWNlbnRlclwiLFxuICAgIHJvdzogXCIyNCVcIixcbiAgICBtYXJnaW46IE9WRVJMQVlfTUFSR0lOLFxuICAgIGJhY2tkcm9wOiB0cnVlLFxuICB9IGFzIGNvbnN0O1xufVxuXG5mdW5jdGlvbiBzZXZlcml0eUljb24oc2V2ZXJpdHk6IE5vdGlmeVNldmVyaXR5KTogc3RyaW5nIHtcbiAgc3dpdGNoIChzZXZlcml0eSkge1xuICAgIGNhc2UgXCJlcnJvclwiOiByZXR1cm4gXCJcdTI3MTdcIjtcbiAgICBjYXNlIFwid2FybmluZ1wiOiByZXR1cm4gXCJcdTI2QTBcIjtcbiAgICBjYXNlIFwic3VjY2Vzc1wiOiByZXR1cm4gXCJcdTI3MTNcIjtcbiAgICBjYXNlIFwiaW5mb1wiOlxuICAgIGRlZmF1bHQ6IHJldHVybiBcIlx1MjVDRlwiO1xuICB9XG59XG5cbmZ1bmN0aW9uIGZvcm1hdFRpbWVzdGFtcCh0czogc3RyaW5nKTogc3RyaW5nIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBkID0gbmV3IERhdGUodHMpO1xuICAgIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gICAgY29uc3QgZGlmZk1zID0gbm93IC0gZC5nZXRUaW1lKCk7XG4gICAgaWYgKGRpZmZNcyA8IDYwXzAwMCkgcmV0dXJuIFwianVzdCBub3dcIjtcbiAgICBpZiAoZGlmZk1zIDwgMzYwMF8wMDApIHJldHVybiBgJHtNYXRoLmZsb29yKGRpZmZNcyAvIDYwXzAwMCl9bSBhZ29gO1xuICAgIGlmIChkaWZmTXMgPCA4NjQwMF8wMDApIHJldHVybiBgJHtNYXRoLmZsb29yKGRpZmZNcyAvIDM2MDBfMDAwKX1oIGFnb2A7XG4gICAgcmV0dXJuIGAke01hdGguZmxvb3IoZGlmZk1zIC8gODY0MDBfMDAwKX1kIGFnb2A7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiB0cy5zbGljZSgxMSwgMTkpOyAvLyBmYWxsYmFjazogSEg6TU06U1NcbiAgfVxufVxuXG5mdW5jdGlvbiBub3RpZmljYXRpb25TaWduYXR1cmUoZW50cmllczogcmVhZG9ubHkgTm90aWZpY2F0aW9uRW50cnlbXSk6IHN0cmluZyB7XG4gIHJldHVybiBlbnRyaWVzXG4gICAgLm1hcCgoZW50cnkpID0+IGAke2VudHJ5LnRzfXwke2VudHJ5LnNldmVyaXR5fXwke2VudHJ5LnJlYWQgPyAxIDogMH18JHtlbnRyeS5tZXNzYWdlfWApXG4gICAgLmpvaW4oXCJcXG5cIik7XG59XG5cbmV4cG9ydCBjbGFzcyBHU0ROb3RpZmljYXRpb25PdmVybGF5IHtcbiAgcHJpdmF0ZSB0dWk6IHsgcmVxdWVzdFJlbmRlcjogKCkgPT4gdm9pZCB9O1xuICBwcml2YXRlIHRoZW1lOiBUaGVtZTtcbiAgcHJpdmF0ZSBvbkNsb3NlOiAoKSA9PiB2b2lkO1xuICBwcml2YXRlIGNhY2hlZFdpZHRoPzogbnVtYmVyO1xuICBwcml2YXRlIGNhY2hlZExpbmVzPzogc3RyaW5nW107XG4gIHByaXZhdGUgc2Nyb2xsT2Zmc2V0ID0gMDtcbiAgcHJpdmF0ZSBmaWx0ZXJJbmRleCA9IDA7XG4gIHByaXZhdGUgZW50cmllczogTm90aWZpY2F0aW9uRW50cnlbXSA9IFtdO1xuICBwcml2YXRlIGVudHJpZXNTaWduYXR1cmUgPSBcIlwiO1xuICBwcml2YXRlIHJlZnJlc2hUaW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0SW50ZXJ2YWw+O1xuICBwcml2YXRlIGRpc3Bvc2VkID0gZmFsc2U7XG4gIHByaXZhdGUgcmVzaXplSGFuZGxlcjogKCgpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgdW5zdWJzY3JpYmVTdG9yZTogKCgpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG5cbiAgY29uc3RydWN0b3IoXG4gICAgdHVpOiB7IHJlcXVlc3RSZW5kZXI6ICgpID0+IHZvaWQgfSxcbiAgICB0aGVtZTogVGhlbWUsXG4gICAgb25DbG9zZTogKCkgPT4gdm9pZCxcbiAgKSB7XG4gICAgdGhpcy50dWkgPSB0dWk7XG4gICAgdGhpcy50aGVtZSA9IHRoZW1lO1xuICAgIHRoaXMub25DbG9zZSA9IG9uQ2xvc2U7XG5cbiAgICAvLyBNYXJrIGFsbCBhcyByZWFkIG9uIG9wZW5cbiAgICBtYXJrQWxsUmVhZCgpO1xuICAgIHRoaXMuZW50cmllcyA9IHJlYWROb3RpZmljYXRpb25zKCk7XG4gICAgdGhpcy5lbnRyaWVzU2lnbmF0dXJlID0gbm90aWZpY2F0aW9uU2lnbmF0dXJlKHRoaXMuZW50cmllcyk7XG5cbiAgICAvLyBSZXNpemUgaGFuZGxlclxuICAgIHRoaXMucmVzaXplSGFuZGxlciA9ICgpID0+IHtcbiAgICAgIGlmICh0aGlzLmRpc3Bvc2VkKSByZXR1cm47XG4gICAgICB0aGlzLmludmFsaWRhdGUoKTtcbiAgICAgIHRoaXMudHVpLnJlcXVlc3RSZW5kZXIoKTtcbiAgICB9O1xuICAgIHByb2Nlc3Muc3Rkb3V0Lm9uKFwicmVzaXplXCIsIHRoaXMucmVzaXplSGFuZGxlcik7XG5cbiAgICAvLyBTdWJzY3JpYmUgdG8gc3RvcmUgbXV0YXRpb25zIGZvciBpbW1lZGlhdGUgdXBkYXRlc1xuICAgIHRoaXMudW5zdWJzY3JpYmVTdG9yZSA9IG9uTm90aWZpY2F0aW9uU3RvcmVDaGFuZ2UoKCkgPT4ge1xuICAgICAgaWYgKHRoaXMuZGlzcG9zZWQpIHJldHVybjtcbiAgICAgIHRoaXMuX3JlZnJlc2hGcm9tRGlzaygpO1xuICAgIH0pO1xuXG4gICAgLy8gMzBzIHNhZmV0eS1uZXQgZm9yIGNyb3NzLXByb2Nlc3MgZWRpdHMgKHdlYiBzdWJwcm9jZXNzLCBwYXJhbGxlbCB3b3JrZXJzKVxuICAgIHRoaXMucmVmcmVzaFRpbWVyID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgICAgaWYgKHRoaXMuZGlzcG9zZWQpIHJldHVybjtcbiAgICAgIHRoaXMuX3JlZnJlc2hGcm9tRGlzaygpO1xuICAgIH0sIDMwXzAwMCk7XG4gIH1cblxuICBwcml2YXRlIGdldCBmaWx0ZXIoKTogRmlsdGVyTW9kZSB7XG4gICAgcmV0dXJuIEZJTFRFUl9DWUNMRVt0aGlzLmZpbHRlckluZGV4XSE7XG4gIH1cblxuICBwcml2YXRlIGdldCBmaWx0ZXJlZEVudHJpZXMoKTogTm90aWZpY2F0aW9uRW50cnlbXSB7XG4gICAgaWYgKHRoaXMuZmlsdGVyID09PSBcImFsbFwiKSByZXR1cm4gdGhpcy5lbnRyaWVzO1xuICAgIHJldHVybiB0aGlzLmVudHJpZXMuZmlsdGVyKChlKSA9PiBlLnNldmVyaXR5ID09PSB0aGlzLmZpbHRlcik7XG4gIH1cblxuICBoYW5kbGVJbnB1dChkYXRhOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAoXG4gICAgICBtYXRjaGVzS2V5KGRhdGEsIEtleS5lc2NhcGUpIHx8XG4gICAgICBtYXRjaGVzS2V5KGRhdGEsIEtleS5jdHJsKFwiY1wiKSkgfHxcbiAgICAgIG1hdGNoZXNLZXkoZGF0YSwgS2V5LmN0cmxBbHQoXCJuXCIpKSB8fFxuICAgICAgbWF0Y2hlc0tleShkYXRhLCBLZXkuY3RybFNoaWZ0KFwiblwiKSlcbiAgICApIHtcbiAgICAgIHRoaXMuZGlzcG9zZSgpO1xuICAgICAgdGhpcy5vbkNsb3NlKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gU2Nyb2xsXG4gICAgaWYgKG1hdGNoZXNLZXkoZGF0YSwgS2V5LmRvd24pIHx8IG1hdGNoZXNLZXkoZGF0YSwgXCJqXCIpKSB7XG4gICAgICB0aGlzLnNjcm9sbE9mZnNldCsrO1xuICAgICAgdGhpcy5pbnZhbGlkYXRlKCk7XG4gICAgICB0aGlzLnR1aS5yZXF1ZXN0UmVuZGVyKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChtYXRjaGVzS2V5KGRhdGEsIEtleS51cCkgfHwgbWF0Y2hlc0tleShkYXRhLCBcImtcIikpIHtcbiAgICAgIHRoaXMuc2Nyb2xsT2Zmc2V0ID0gTWF0aC5tYXgoMCwgdGhpcy5zY3JvbGxPZmZzZXQgLSAxKTtcbiAgICAgIHRoaXMuaW52YWxpZGF0ZSgpO1xuICAgICAgdGhpcy50dWkucmVxdWVzdFJlbmRlcigpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAoZGF0YSA9PT0gXCJnXCIpIHtcbiAgICAgIHRoaXMuc2Nyb2xsT2Zmc2V0ID0gMDtcbiAgICAgIHRoaXMuaW52YWxpZGF0ZSgpO1xuICAgICAgdGhpcy50dWkucmVxdWVzdFJlbmRlcigpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAoZGF0YSA9PT0gXCJHXCIpIHtcbiAgICAgIHRoaXMuc2Nyb2xsT2Zmc2V0ID0gOTk5O1xuICAgICAgdGhpcy5pbnZhbGlkYXRlKCk7XG4gICAgICB0aGlzLnR1aS5yZXF1ZXN0UmVuZGVyKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gRmlsdGVyIGN5Y2xlXG4gICAgaWYgKGRhdGEgPT09IFwiZlwiKSB7XG4gICAgICB0aGlzLmZpbHRlckluZGV4ID0gKHRoaXMuZmlsdGVySW5kZXggKyAxKSAlIEZJTFRFUl9DWUNMRS5sZW5ndGg7XG4gICAgICB0aGlzLnNjcm9sbE9mZnNldCA9IDA7XG4gICAgICB0aGlzLmludmFsaWRhdGUoKTtcbiAgICAgIHRoaXMudHVpLnJlcXVlc3RSZW5kZXIoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBDbGVhciBhbGxcbiAgICBpZiAoZGF0YSA9PT0gXCJjXCIpIHtcbiAgICAgIGNsZWFyTm90aWZpY2F0aW9ucygpO1xuICAgICAgdGhpcy5lbnRyaWVzID0gW107XG4gICAgICB0aGlzLmVudHJpZXNTaWduYXR1cmUgPSBub3RpZmljYXRpb25TaWduYXR1cmUodGhpcy5lbnRyaWVzKTtcbiAgICAgIHRoaXMuc2Nyb2xsT2Zmc2V0ID0gMDtcbiAgICAgIHRoaXMuaW52YWxpZGF0ZSgpO1xuICAgICAgdGhpcy50dWkucmVxdWVzdFJlbmRlcigpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgfVxuXG4gIHJlbmRlcih3aWR0aDogbnVtYmVyKTogc3RyaW5nW10ge1xuICAgIGlmICh0aGlzLmNhY2hlZExpbmVzICYmIHRoaXMuY2FjaGVkV2lkdGggPT09IHdpZHRoKSB7XG4gICAgICByZXR1cm4gdGhpcy5jYWNoZWRMaW5lcztcbiAgICB9XG5cbiAgICBjb25zdCBjb250ZW50ID0gdGhpcy5idWlsZENvbnRlbnRMaW5lcyh3aWR0aCk7XG4gICAgY29uc3QgdGVybWluYWxSb3dzID0gcHJvY2Vzcy5zdGRvdXQucm93cyB8fCAzMjtcbiAgICBjb25zdCBhdmFpbGFibGVSb3dzID0gTWF0aC5tYXgoMSwgdGVybWluYWxSb3dzIC0gT1ZFUkxBWV9NQVJHSU4udG9wIC0gT1ZFUkxBWV9NQVJHSU4uYm90dG9tKTtcbiAgICBjb25zdCBvdmVybGF5Um93cyA9IE1hdGgubWluKFxuICAgICAgYXZhaWxhYmxlUm93cyxcbiAgICAgIE1hdGgubWF4KDEsIE1hdGguZmxvb3IoKHRlcm1pbmFsUm93cyAqIE9WRVJMQVlfTUFYX0hFSUdIVF9QRVJDRU5UKSAvIDEwMCkpLFxuICAgICk7XG4gICAgY29uc3QgbWF4VmlzaWJsZVJvd3MgPSBNYXRoLm1heCg1LCBvdmVybGF5Um93cyAtIDIpO1xuICAgIGNvbnN0IHZpc2libGVDb250ZW50Um93cyA9IE1hdGgubWluKGNvbnRlbnQubGVuZ3RoLCBtYXhWaXNpYmxlUm93cyk7XG4gICAgY29uc3QgbWF4U2Nyb2xsID0gTWF0aC5tYXgoMCwgY29udGVudC5sZW5ndGggLSB2aXNpYmxlQ29udGVudFJvd3MpO1xuICAgIHRoaXMuc2Nyb2xsT2Zmc2V0ID0gTWF0aC5taW4odGhpcy5zY3JvbGxPZmZzZXQsIG1heFNjcm9sbCk7XG4gICAgY29uc3QgdmlzaWJsZUNvbnRlbnQgPSBjb250ZW50LnNsaWNlKHRoaXMuc2Nyb2xsT2Zmc2V0LCB0aGlzLnNjcm9sbE9mZnNldCArIHZpc2libGVDb250ZW50Um93cyk7XG5cbiAgICBjb25zdCBsaW5lcyA9IHJlbmRlckZyYW1lKHRoaXMudGhlbWUsIHZpc2libGVDb250ZW50LCB3aWR0aCk7XG5cbiAgICB0aGlzLmNhY2hlZFdpZHRoID0gd2lkdGg7XG4gICAgdGhpcy5jYWNoZWRMaW5lcyA9IGxpbmVzO1xuICAgIHJldHVybiBsaW5lcztcbiAgfVxuXG4gIGludmFsaWRhdGUoKTogdm9pZCB7XG4gICAgdGhpcy5jYWNoZWRMaW5lcyA9IHVuZGVmaW5lZDtcbiAgICB0aGlzLmNhY2hlZFdpZHRoID0gdW5kZWZpbmVkO1xuICB9XG5cbiAgZGlzcG9zZSgpOiB2b2lkIHtcbiAgICB0aGlzLmRpc3Bvc2VkID0gdHJ1ZTtcbiAgICBjbGVhckludGVydmFsKHRoaXMucmVmcmVzaFRpbWVyKTtcbiAgICBpZiAodGhpcy51bnN1YnNjcmliZVN0b3JlKSB7XG4gICAgICB0aGlzLnVuc3Vic2NyaWJlU3RvcmUoKTtcbiAgICAgIHRoaXMudW5zdWJzY3JpYmVTdG9yZSA9IG51bGw7XG4gICAgfVxuICAgIGlmICh0aGlzLnJlc2l6ZUhhbmRsZXIpIHtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LnJlbW92ZUxpc3RlbmVyKFwicmVzaXplXCIsIHRoaXMucmVzaXplSGFuZGxlcik7XG4gICAgICB0aGlzLnJlc2l6ZUhhbmRsZXIgPSBudWxsO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgX3JlZnJlc2hGcm9tRGlzaygpOiB2b2lkIHtcbiAgICBjb25zdCBmcmVzaCA9IHJlYWROb3RpZmljYXRpb25zKCk7XG4gICAgY29uc3Qgc2lnbmF0dXJlID0gbm90aWZpY2F0aW9uU2lnbmF0dXJlKGZyZXNoKTtcbiAgICBpZiAoc2lnbmF0dXJlICE9PSB0aGlzLmVudHJpZXNTaWduYXR1cmUpIHtcbiAgICAgIG1hcmtBbGxSZWFkKCk7XG4gICAgICB0aGlzLmVudHJpZXMgPSByZWFkTm90aWZpY2F0aW9ucygpO1xuICAgICAgdGhpcy5lbnRyaWVzU2lnbmF0dXJlID0gbm90aWZpY2F0aW9uU2lnbmF0dXJlKHRoaXMuZW50cmllcyk7XG4gICAgICB0aGlzLmludmFsaWRhdGUoKTtcbiAgICAgIHRoaXMudHVpLnJlcXVlc3RSZW5kZXIoKTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGJ1aWxkQ29udGVudExpbmVzKHdpZHRoOiBudW1iZXIpOiBzdHJpbmdbXSB7XG4gICAgY29uc3QgdGggPSB0aGlzLnRoZW1lO1xuICAgIGNvbnN0IHNoZWxsV2lkdGggPSBNYXRoLm1heCgxLCB3aWR0aCAtIDQpO1xuICAgIGNvbnN0IGNvbnRlbnRXaWR0aCA9IHNoZWxsV2lkdGg7XG4gICAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG5cbiAgICBjb25zdCByb3cgPSAoY29udGVudCA9IFwiXCIpOiBzdHJpbmcgPT4ge1xuICAgICAgY29uc3QgdHJ1bmNhdGVkID0gdHJ1bmNhdGVUb1dpZHRoKGNvbnRlbnQsIGNvbnRlbnRXaWR0aCk7XG4gICAgICByZXR1cm4gcGFkUmlnaHRWaXNpYmxlKHRydW5jYXRlZCwgY29udGVudFdpZHRoKTtcbiAgICB9O1xuICAgIGNvbnN0IGJsYW5rID0gKCkgPT4gcm93KFwiXCIpO1xuICAgIGNvbnN0IGhyID0gKCkgPT4gcm93KHRoLmZnKFwiZGltXCIsIFwiXHUyNTAwXCIucmVwZWF0KGNvbnRlbnRXaWR0aCkpKTtcblxuICAgIC8vIEhlYWRlclxuICAgIGNvbnN0IHRpdGxlID0gdGguZmcoXCJhY2NlbnRcIiwgdGguYm9sZChcIk5vdGlmaWNhdGlvbnNcIikpO1xuICAgIGNvbnN0IGZpbHRlckxhYmVsID0gdGhpcy5maWx0ZXIgPT09IFwiYWxsXCJcbiAgICAgID8gdGguZmcoXCJkaW1cIiwgXCJhbGxcIilcbiAgICAgIDogdGguZmcoXG4gICAgICAgIHRoaXMuZmlsdGVyID09PSBcImVycm9yXCIgPyBcImVycm9yXCJcbiAgICAgICAgICA6IHRoaXMuZmlsdGVyID09PSBcIndhcm5pbmdcIiA/IFwid2FybmluZ1wiXG4gICAgICAgICAgICA6IHRoaXMuZmlsdGVyID09PSBcInN1Y2Nlc3NcIiA/IFwic3VjY2Vzc1wiXG4gICAgICAgICAgICAgIDogXCJkaW1cIixcbiAgICAgICAgdGhpcy5maWx0ZXIsXG4gICAgICApO1xuICAgIGNvbnN0IGNvdW50ID0gYCR7dGhpcy5maWx0ZXJlZEVudHJpZXMubGVuZ3RofSBlbnRyaWVzYDtcbiAgICBsaW5lcy5wdXNoKHJvdyhyaWdodEFsaWduKFxuICAgICAgYCR7dGl0bGV9ICAke3RoLmZnKFwiZGltXCIsIFwiZmlsdGVyOlwiKX0gJHtmaWx0ZXJMYWJlbH1gLFxuICAgICAgdGguZmcoXCJkaW1cIiwgY291bnQpLFxuICAgICAgY29udGVudFdpZHRoLFxuICAgICkpKTtcbiAgICBsaW5lcy5wdXNoKGhyKCkpO1xuXG4gICAgLy8gQ29udHJvbHNcbiAgICBjb25zdCBjbG9zZVNob3J0Y3V0ID0gZm9ybWF0dGVkU2hvcnRjdXRQYWlyKFwibm90aWZpY2F0aW9uc1wiKTtcbiAgICBsaW5lcy5wdXNoKHJvdyhyZW5kZXJLZXlIaW50cyh0aCwgW1wiXHUyMTkxL1x1MjE5MyBzY3JvbGxcIiwgXCJmIGZpbHRlclwiLCBcImMgY2xlYXJcIiwgYEVzYy8ke2Nsb3NlU2hvcnRjdXR9IGNsb3NlYF0sIGNvbnRlbnRXaWR0aCkpKTtcbiAgICBsaW5lcy5wdXNoKGJsYW5rKCkpO1xuXG4gICAgLy8gRW50cmllc1xuICAgIGNvbnN0IGZpbHRlcmVkID0gdGhpcy5maWx0ZXJlZEVudHJpZXM7XG4gICAgaWYgKGZpbHRlcmVkLmxlbmd0aCA9PT0gMCkge1xuICAgICAgbGluZXMucHVzaChibGFuaygpKTtcbiAgICAgIGxpbmVzLnB1c2gocm93KHRoLmZnKFwiZGltXCIsIHRoaXMuZW50cmllcy5sZW5ndGggPT09IDBcbiAgICAgICAgPyBcIk5vIG5vdGlmaWNhdGlvbnMgeWV0LlwiXG4gICAgICAgIDogYE5vICR7dGhpcy5maWx0ZXJ9IG5vdGlmaWNhdGlvbnMuYCkpKTtcbiAgICAgIGxpbmVzLnB1c2goYmxhbmsoKSk7XG4gICAgICByZXR1cm4gbGluZXM7XG4gICAgfVxuXG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiBmaWx0ZXJlZCkge1xuICAgICAgY29uc3QgaWNvbiA9IHNldmVyaXR5SWNvbihlbnRyeS5zZXZlcml0eSk7XG4gICAgICBjb25zdCBjb2xvcmVkSWNvbiA9IGVudHJ5LnNldmVyaXR5ID09PSBcImVycm9yXCIgPyB0aC5mZyhcImVycm9yXCIsIGljb24pXG4gICAgICAgIDogZW50cnkuc2V2ZXJpdHkgPT09IFwid2FybmluZ1wiID8gdGguZmcoXCJ3YXJuaW5nXCIsIGljb24pXG4gICAgICAgICAgOiBlbnRyeS5zZXZlcml0eSA9PT0gXCJzdWNjZXNzXCIgPyB0aC5mZyhcInN1Y2Nlc3NcIiwgaWNvbilcbiAgICAgICAgICAgIDogdGguZmcoXCJkaW1cIiwgaWNvbik7XG4gICAgICBjb25zdCB0aW1lID0gdGguZmcoXCJkaW1cIiwgZm9ybWF0VGltZXN0YW1wKGVudHJ5LnRzKSk7XG4gICAgICBjb25zdCBzb3VyY2UgPSBlbnRyeS5zb3VyY2UgPT09IFwid29ya2Zsb3ctbG9nZ2VyXCIgPyB0aC5mZyhcImRpbVwiLCBcIiBbZW5naW5lXVwiKSA6IFwiXCI7XG5cbiAgICAgIC8vIE1lYXN1cmUgYWN0dWFsIHByZWZpeCB3aWR0aCBmb3Igd3JhcHBpbmdcbiAgICAgIGNvbnN0IHByZWZpeCA9IGAke2NvbG9yZWRJY29ufSAke3RpbWV9JHtzb3VyY2V9ICBgO1xuICAgICAgY29uc3QgcHJlZml4V2lkdGggPSB2aXNpYmxlV2lkdGgocHJlZml4KTtcbiAgICAgIGNvbnN0IG1zZ01heFdpZHRoID0gTWF0aC5tYXgoMTAsIGNvbnRlbnRXaWR0aCAtIHByZWZpeFdpZHRoKTtcblxuICAgICAgLy8gV3JhcCBsb25nIG1lc3NhZ2VzIG9udG8gY29udGludWF0aW9uIGxpbmVzIGluZGVudGVkIHRvIGFsaWduIHdpdGggbWVzc2FnZSBzdGFydFxuICAgICAgY29uc3QgbXNnTGluZXMgPSB3cmFwVmlzaWJsZVRleHQoZW50cnkubWVzc2FnZSwgbXNnTWF4V2lkdGgpO1xuICAgICAgY29uc3QgaW5kZW50ID0gXCIgXCIucmVwZWF0KHByZWZpeFdpZHRoKTtcbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgbXNnTGluZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgaWYgKGkgPT09IDApIHtcbiAgICAgICAgICBsaW5lcy5wdXNoKHJvdyhgJHtwcmVmaXh9JHttc2dMaW5lc1tpXX1gKSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgbGluZXMucHVzaChyb3coYCR7aW5kZW50fSR7bXNnTGluZXNbaV19YCkpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIGxpbmVzO1xuICB9XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFJQSxTQUFTLGlCQUFpQixjQUFjLFlBQVksV0FBVztBQUUvRDtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUdLO0FBQ1AsU0FBUyw2QkFBNkI7QUFDdEM7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFHUCxNQUFNLGVBQTZCLENBQUMsT0FBTyxTQUFTLFdBQVcsV0FBVyxNQUFNO0FBQ2hGLE1BQU0sZ0JBQWdCO0FBQ3RCLE1BQU0sb0JBQW9CO0FBQzFCLE1BQU0sNkJBQTZCO0FBQ25DLE1BQU0saUJBQWlCLEVBQUUsS0FBSyxHQUFHLE9BQU8sR0FB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
