import { truncateToWidth, visibleWidth, matchesKey, Key } from "@gsd/pi-tui";
import { loadVisualizerData } from "./visualizer-data.js";
import {
  renderProgressView,
  renderDepsView,
  renderMetricsView,
  renderTimelineView,
  renderAgentView,
  renderChangelogView,
  renderExportView,
  renderKnowledgeView,
  renderCapturesView,
  renderHealthView
} from "./visualizer-views.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeExportFile } from "./export.js";
import { gsdRoot } from "./paths.js";
import { stripAnsi } from "../shared/mod.js";
const TAB_COUNT = 10;
const TAB_LABELS = [
  "1 Progress",
  "2 Timeline",
  "3 Deps",
  "4 Metrics",
  "5 Health",
  "6 Agent",
  "7 Changes",
  "8 Knowledge",
  "9 Captures",
  "0 Export"
];
function buildTabBarEntries(activeTab, filterText, capturesPendingCount) {
  return TAB_LABELS.map((label, i) => {
    let displayLabel = label;
    if (i === activeTab && filterText) {
      displayLabel += " \u2731";
    }
    if (i === 8 && capturesPendingCount) {
      displayLabel += ` (${capturesPendingCount})`;
    }
    return {
      label: displayLabel,
      width: visibleWidth(displayLabel) + 2
    };
  });
}
class GSDVisualizerOverlay {
  tui;
  theme;
  onClose;
  activeTab = 0;
  scrollOffsets = new Array(TAB_COUNT).fill(0);
  loading = true;
  disposed = false;
  cachedWidth;
  cachedLines;
  refreshTimer;
  data = null;
  basePath;
  // Filter state
  filterMode = false;
  filterText = "";
  filterField = "all";
  // Export state
  lastExportPath;
  exportStatus;
  // New state
  lastVisibleRows = 20;
  collapsedMilestones = /* @__PURE__ */ new Set();
  showHelp = false;
  resizeHandler = null;
  constructor(tui, theme, onClose) {
    this.tui = tui;
    this.theme = theme;
    this.onClose = onClose;
    this.basePath = process.cwd();
    process.stdout.write("\x1B[?1003h\x1B[?1006h");
    this.resizeHandler = () => {
      if (this.disposed) return;
      this.invalidate();
      this.tui.requestRender();
    };
    process.stdout.on("resize", this.resizeHandler);
    loadVisualizerData(this.basePath).then((d) => {
      this.data = d;
      this.loading = false;
      this.tui.requestRender();
    }).catch(() => {
      this.loading = false;
      this.tui.requestRender();
    });
    this.refreshTimer = setInterval(() => {
      loadVisualizerData(this.basePath).then((d) => {
        if (this.disposed) return;
        this.data = d;
        this.invalidate();
        this.tui.requestRender();
      }).catch(() => {
      });
    }, 5e3);
  }
  parseSGRMouse(data) {
    const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
    if (!match) return null;
    return {
      button: parseInt(match[1], 10),
      x: parseInt(match[2], 10),
      y: parseInt(match[3], 10),
      press: match[4] === "M"
    };
  }
  handleInput(data) {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.dispose();
      this.onClose();
      return;
    }
    if (this.filterMode) {
      if (matchesKey(data, Key.enter)) {
        this.filterMode = false;
        this.invalidate();
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.backspace)) {
        this.filterText = this.filterText.slice(0, -1);
        this.invalidate();
        this.tui.requestRender();
        return;
      }
      if (data.length === 1 && data.charCodeAt(0) >= 32) {
        this.filterText += data;
        this.invalidate();
        this.tui.requestRender();
        return;
      }
      return;
    }
    if (this.showHelp) {
      if (matchesKey(data, Key.escape) || data === "?") {
        this.showHelp = false;
        this.invalidate();
        this.tui.requestRender();
        return;
      }
      return;
    }
    const mouse = this.parseSGRMouse(data);
    if (mouse) {
      if (mouse.button === 64) {
        this.scrollOffsets[this.activeTab] = Math.max(0, this.scrollOffsets[this.activeTab] - 3);
        this.invalidate();
        this.tui.requestRender();
        return;
      }
      if (mouse.button === 65) {
        this.scrollOffsets[this.activeTab] += 3;
        this.invalidate();
        this.tui.requestRender();
        return;
      }
      if (mouse.button === 0 && mouse.press) {
        if (mouse.y === 2) {
          let xPos = 3;
          const tabs = buildTabBarEntries(this.activeTab, this.filterText, this.data?.captures?.pendingCount);
          for (let i = 0; i < tabs.length; i++) {
            const tabWidth = tabs[i].width;
            if (mouse.x >= xPos && mouse.x < xPos + tabWidth) {
              this.activeTab = i;
              this.invalidate();
              this.tui.requestRender();
              return;
            }
            xPos += tabWidth + 1;
          }
        }
      }
      return;
    }
    if (matchesKey(data, Key.shift("tab"))) {
      this.activeTab = (this.activeTab - 1 + TAB_COUNT) % TAB_COUNT;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.activeTab = (this.activeTab + 1) % TAB_COUNT;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if ("1234567890".includes(data) && data.length === 1) {
      const idx = data === "0" ? 9 : parseInt(data, 10) - 1;
      this.activeTab = idx;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (data === "/") {
      this.filterMode = true;
      this.filterText = "";
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (data === "f") {
      if (this.activeTab === 0) {
        const fields = ["all", "status", "risk", "keyword"];
        const idx = fields.indexOf(this.filterField);
        this.filterField = fields[(idx + 1) % fields.length];
      } else {
        this.filterField = this.filterField === "all" ? "keyword" : "all";
      }
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (data === "?") {
      this.showHelp = true;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if ((matchesKey(data, Key.enter) || data === " ") && this.activeTab === 0 && this.data) {
      const viewLines = this.renderTabContent(0, 80);
      const offset = this.scrollOffsets[0];
      for (const ms of this.data.milestones) {
        const lineIdx = viewLines.findIndex((l) => stripAnsi(l).includes(`${ms.id}:`));
        if (lineIdx >= offset && lineIdx < offset + this.lastVisibleRows) {
          if (this.collapsedMilestones.has(ms.id)) {
            this.collapsedMilestones.delete(ms.id);
          } else {
            this.collapsedMilestones.add(ms.id);
          }
          this.invalidate();
          this.tui.requestRender();
          return;
        }
      }
      return;
    }
    if (this.activeTab === 9 && this.data) {
      if (data === "m" || data === "j" || data === "s") {
        this.handleExportKey(data);
        return;
      }
    }
    if (matchesKey(data, Key.pageUp)) {
      const amount = Math.max(1, this.lastVisibleRows - 2);
      this.scrollOffsets[this.activeTab] = Math.max(0, this.scrollOffsets[this.activeTab] - amount);
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      const amount = Math.max(1, this.lastVisibleRows - 2);
      this.scrollOffsets[this.activeTab] += amount;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.ctrl("u"))) {
      const amount = Math.max(1, Math.floor(this.lastVisibleRows / 2));
      this.scrollOffsets[this.activeTab] = Math.max(0, this.scrollOffsets[this.activeTab] - amount);
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.ctrl("d"))) {
      const amount = Math.max(1, Math.floor(this.lastVisibleRows / 2));
      this.scrollOffsets[this.activeTab] += amount;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      this.scrollOffsets[this.activeTab]++;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.scrollOffsets[this.activeTab] = Math.max(0, this.scrollOffsets[this.activeTab] - 1);
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (data === "g") {
      this.scrollOffsets[this.activeTab] = 0;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (data === "G") {
      this.scrollOffsets[this.activeTab] = 999;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
  }
  handleExportKey(key) {
    if (!this.data) return;
    const format = key === "m" ? "markdown" : key === "j" ? "json" : "snapshot";
    if (format === "snapshot") {
      const snapshotLines = this.renderTabContent(this.activeTab, 80);
      const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const exportDir = gsdRoot(this.basePath);
      mkdirSync(exportDir, { recursive: true });
      const outPath = join(exportDir, `snapshot-${timestamp}.txt`);
      writeFileSync(outPath, snapshotLines.join("\n") + "\n", "utf-8");
      this.lastExportPath = outPath;
      this.exportStatus = "Snapshot saved";
    } else {
      const result = writeExportFile(this.basePath, format, this.data);
      if (result) {
        this.lastExportPath = result;
        this.exportStatus = `${format} export saved`;
      }
    }
    this.invalidate();
    this.tui.requestRender();
  }
  renderTabContent(tab, width) {
    if (!this.data) return [];
    const th = this.theme;
    switch (tab) {
      case 0: {
        const filter = this.filterText ? { text: this.filterText, field: this.filterField } : void 0;
        return renderProgressView(this.data, th, width, filter, this.collapsedMilestones);
      }
      case 1:
        return renderTimelineView(this.data, th, width);
      case 2:
        return renderDepsView(this.data, th, width);
      case 3:
        return renderMetricsView(this.data, th, width);
      case 4:
        return renderHealthView(this.data, th, width);
      case 5:
        return renderAgentView(this.data, th, width);
      case 6:
        return renderChangelogView(this.data, th, width);
      case 7:
        return renderKnowledgeView(this.data, th, width);
      case 8:
        return renderCapturesView(this.data, th, width);
      case 9:
        return renderExportView(this.data, th, width, this.lastExportPath);
      default:
        return [];
    }
  }
  renderHelpContent(width) {
    const th = this.theme;
    const lines = [];
    lines.push(th.fg("accent", th.bold("Keyboard Shortcuts")));
    lines.push("");
    const bindings = [
      ["Tab/Shift+Tab", "Next/Previous tab"],
      ["1-9, 0", "Jump to tab"],
      ["j/k, Up/Down", "Scroll line"],
      ["PgUp/PgDn", "Scroll page"],
      ["Ctrl+U/Ctrl+D", "Scroll half-page"],
      ["g/G", "Top/Bottom"],
      ["/", "Search/filter"],
      ["f", "Cycle filter field"],
      ["Enter/Space", "Toggle collapse (Progress)"],
      ["Mouse wheel", "Scroll"],
      ["Click tab", "Switch tab"],
      ["?", "Toggle help"],
      ["Esc", "Close"]
    ];
    for (const [key, desc] of bindings) {
      const keyStr = th.fg("accent", key.padEnd(20));
      lines.push(`  ${keyStr} ${desc}`);
    }
    lines.push("");
    lines.push(th.fg("dim", "Press ? or Esc to dismiss"));
    return lines;
  }
  render(width) {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }
    const th = this.theme;
    const innerWidth = width - 4;
    const content = [];
    const tabEntries = buildTabBarEntries(this.activeTab, this.filterText, this.data?.captures?.pendingCount);
    const tabs = tabEntries.map((entry, i) => {
      if (i === this.activeTab) {
        return th.fg("accent", `[${entry.label}]`);
      }
      return th.fg("dim", `[${entry.label}]`);
    });
    content.push(" " + tabs.join(" "));
    content.push("");
    if (this.filterMode) {
      content.push(
        th.fg("accent", `Filter (${this.filterField}): ${this.filterText}\u2588`)
      );
      content.push("");
    }
    if (this.showHelp) {
      content.push(...this.renderHelpContent(innerWidth));
    } else if (this.loading) {
      const loadingText = "Loading\u2026";
      const vis = visibleWidth(loadingText);
      const leftPad = Math.max(0, Math.floor((innerWidth - vis) / 2));
      content.push(" ".repeat(leftPad) + loadingText);
    } else if (this.data) {
      let viewLines = this.renderTabContent(this.activeTab, innerWidth);
      if (this.exportStatus && this.activeTab === 9) {
        content.push(th.fg("success", this.exportStatus));
        content.push("");
        this.exportStatus = void 0;
      }
      if (this.filterText && this.activeTab !== 0) {
        const lowerFilter = this.filterText.toLowerCase();
        viewLines = viewLines.filter((line) => stripAnsi(line).toLowerCase().includes(lowerFilter));
      }
      content.push(...viewLines);
    }
    const viewportHeight = Math.max(5, process.stdout.rows ? process.stdout.rows - 8 : 24);
    const chromeHeight = 2;
    const visibleContentRows = Math.max(1, viewportHeight - chromeHeight);
    this.lastVisibleRows = visibleContentRows;
    const totalLines = content.length;
    const maxScroll = Math.max(0, content.length - visibleContentRows);
    this.scrollOffsets[this.activeTab] = Math.min(this.scrollOffsets[this.activeTab], maxScroll);
    const offset = this.scrollOffsets[this.activeTab];
    const visibleContent = content.slice(offset, offset + visibleContentRows);
    const lines = this.wrapInBox(visibleContent, width, offset, visibleContentRows, totalLines);
    const hint = th.fg("dim", "Tab/Shift+Tab/1-9,0 switch \xB7 / filter \xB7 PgUp/PgDn scroll \xB7 ? help \xB7 esc close");
    const hintVis = visibleWidth(hint);
    const hintPad = Math.max(0, Math.floor((width - hintVis) / 2));
    lines.push(" ".repeat(hintPad) + hint);
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
  wrapInBox(inner, width, offset, visibleRows, totalLines) {
    const th = this.theme;
    const border = (s) => th.fg("borderAccent", s);
    const innerWidth = width - 4;
    const lines = [];
    lines.push(border("\u256D" + "\u2500".repeat(width - 2) + "\u256E"));
    const scrollable = totalLines !== void 0 && visibleRows !== void 0 && totalLines > visibleRows;
    let thumbStart = -1;
    let thumbLen = 0;
    const innerRows = inner.length;
    if (scrollable && innerRows > 0 && totalLines > 0) {
      thumbStart = Math.round((offset ?? 0) / totalLines * innerRows);
      thumbLen = Math.max(1, Math.round(visibleRows / totalLines * innerRows));
    }
    for (let i = 0; i < inner.length; i++) {
      const line = inner[i];
      const truncated = truncateToWidth(line, innerWidth);
      const padWidth = Math.max(0, innerWidth - visibleWidth(truncated));
      const rightBorder = scrollable && i >= thumbStart && i < thumbStart + thumbLen ? border("\u2503") : border("\u2502");
      lines.push(border("\u2502") + " " + truncated + " ".repeat(padWidth) + " " + rightBorder);
    }
    lines.push(border("\u2570" + "\u2500".repeat(width - 2) + "\u256F"));
    return lines;
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
    process.stdout.write("\x1B[?1003l\x1B[?1006l");
  }
}
export {
  GSDVisualizerOverlay,
  TAB_COUNT
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC92aXN1YWxpemVyLW92ZXJsYXkudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0eXBlIHsgVGhlbWUgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB7IHRydW5jYXRlVG9XaWR0aCwgdmlzaWJsZVdpZHRoLCBtYXRjaGVzS2V5LCBLZXkgfSBmcm9tIFwiQGdzZC9waS10dWlcIjtcbmltcG9ydCB7IGxvYWRWaXN1YWxpemVyRGF0YSwgdHlwZSBWaXN1YWxpemVyRGF0YSB9IGZyb20gXCIuL3Zpc3VhbGl6ZXItZGF0YS5qc1wiO1xuaW1wb3J0IHtcbiAgcmVuZGVyUHJvZ3Jlc3NWaWV3LFxuICByZW5kZXJEZXBzVmlldyxcbiAgcmVuZGVyTWV0cmljc1ZpZXcsXG4gIHJlbmRlclRpbWVsaW5lVmlldyxcbiAgcmVuZGVyQWdlbnRWaWV3LFxuICByZW5kZXJDaGFuZ2Vsb2dWaWV3LFxuICByZW5kZXJFeHBvcnRWaWV3LFxuICByZW5kZXJLbm93bGVkZ2VWaWV3LFxuICByZW5kZXJDYXB0dXJlc1ZpZXcsXG4gIHJlbmRlckhlYWx0aFZpZXcsXG4gIHR5cGUgUHJvZ3Jlc3NGaWx0ZXIsXG59IGZyb20gXCIuL3Zpc3VhbGl6ZXItdmlld3MuanNcIjtcbmltcG9ydCB7IHdyaXRlRmlsZVN5bmMsIG1rZGlyU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgd3JpdGVFeHBvcnRGaWxlIH0gZnJvbSBcIi4vZXhwb3J0LmpzXCI7XG5pbXBvcnQgeyBnc2RSb290IH0gZnJvbSBcIi4vcGF0aHMuanNcIjtcbmltcG9ydCB7IHN0cmlwQW5zaSB9IGZyb20gXCIuLi9zaGFyZWQvbW9kLmpzXCI7XG5cbmV4cG9ydCBjb25zdCBUQUJfQ09VTlQgPSAxMDtcbmNvbnN0IFRBQl9MQUJFTFMgPSBbXG4gIFwiMSBQcm9ncmVzc1wiLFxuICBcIjIgVGltZWxpbmVcIixcbiAgXCIzIERlcHNcIixcbiAgXCI0IE1ldHJpY3NcIixcbiAgXCI1IEhlYWx0aFwiLFxuICBcIjYgQWdlbnRcIixcbiAgXCI3IENoYW5nZXNcIixcbiAgXCI4IEtub3dsZWRnZVwiLFxuICBcIjkgQ2FwdHVyZXNcIixcbiAgXCIwIEV4cG9ydFwiLFxuXTtcblxudHlwZSBUYWJCYXJFbnRyeSA9IHsgbGFiZWw6IHN0cmluZzsgd2lkdGg6IG51bWJlciB9O1xuXG5mdW5jdGlvbiBidWlsZFRhYkJhckVudHJpZXMoYWN0aXZlVGFiOiBudW1iZXIsIGZpbHRlclRleHQ6IHN0cmluZywgY2FwdHVyZXNQZW5kaW5nQ291bnQ/OiBudW1iZXIpOiBUYWJCYXJFbnRyeVtdIHtcbiAgcmV0dXJuIFRBQl9MQUJFTFMubWFwKChsYWJlbCwgaSkgPT4ge1xuICAgIGxldCBkaXNwbGF5TGFiZWwgPSBsYWJlbDtcbiAgICBpZiAoaSA9PT0gYWN0aXZlVGFiICYmIGZpbHRlclRleHQpIHtcbiAgICAgIGRpc3BsYXlMYWJlbCArPSBcIiBcXHUyNzMxXCI7XG4gICAgfVxuICAgIGlmIChpID09PSA4ICYmIGNhcHR1cmVzUGVuZGluZ0NvdW50KSB7XG4gICAgICBkaXNwbGF5TGFiZWwgKz0gYCAoJHtjYXB0dXJlc1BlbmRpbmdDb3VudH0pYDtcbiAgICB9XG4gICAgcmV0dXJuIHtcbiAgICAgIGxhYmVsOiBkaXNwbGF5TGFiZWwsXG4gICAgICB3aWR0aDogdmlzaWJsZVdpZHRoKGRpc3BsYXlMYWJlbCkgKyAyLFxuICAgIH07XG4gIH0pO1xufVxuXG5leHBvcnQgY2xhc3MgR1NEVmlzdWFsaXplck92ZXJsYXkge1xuICBwcml2YXRlIHR1aTogeyByZXF1ZXN0UmVuZGVyOiAoKSA9PiB2b2lkIH07XG4gIHByaXZhdGUgdGhlbWU6IFRoZW1lO1xuICBwcml2YXRlIG9uQ2xvc2U6ICgpID0+IHZvaWQ7XG5cbiAgYWN0aXZlVGFiID0gMDtcbiAgc2Nyb2xsT2Zmc2V0czogbnVtYmVyW10gPSBuZXcgQXJyYXkoVEFCX0NPVU5UKS5maWxsKDApO1xuICBsb2FkaW5nID0gdHJ1ZTtcbiAgZGlzcG9zZWQgPSBmYWxzZTtcbiAgY2FjaGVkV2lkdGg/OiBudW1iZXI7XG4gIGNhY2hlZExpbmVzPzogc3RyaW5nW107XG4gIHJlZnJlc2hUaW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0SW50ZXJ2YWw+O1xuICBkYXRhOiBWaXN1YWxpemVyRGF0YSB8IG51bGwgPSBudWxsO1xuICBiYXNlUGF0aDogc3RyaW5nO1xuXG4gIC8vIEZpbHRlciBzdGF0ZVxuICBmaWx0ZXJNb2RlID0gZmFsc2U7XG4gIGZpbHRlclRleHQgPSBcIlwiO1xuICBmaWx0ZXJGaWVsZDogXCJhbGxcIiB8IFwic3RhdHVzXCIgfCBcInJpc2tcIiB8IFwia2V5d29yZFwiID0gXCJhbGxcIjtcblxuICAvLyBFeHBvcnQgc3RhdGVcbiAgbGFzdEV4cG9ydFBhdGg/OiBzdHJpbmc7XG4gIGV4cG9ydFN0YXR1cz86IHN0cmluZztcblxuICAvLyBOZXcgc3RhdGVcbiAgcHJpdmF0ZSBsYXN0VmlzaWJsZVJvd3MgPSAyMDtcbiAgY29sbGFwc2VkTWlsZXN0b25lcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBzaG93SGVscCA9IGZhbHNlO1xuICBwcml2YXRlIHJlc2l6ZUhhbmRsZXI6ICgoKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuXG4gIGNvbnN0cnVjdG9yKFxuICAgIHR1aTogeyByZXF1ZXN0UmVuZGVyOiAoKSA9PiB2b2lkIH0sXG4gICAgdGhlbWU6IFRoZW1lLFxuICAgIG9uQ2xvc2U6ICgpID0+IHZvaWQsXG4gICkge1xuICAgIHRoaXMudHVpID0gdHVpO1xuICAgIHRoaXMudGhlbWUgPSB0aGVtZTtcbiAgICB0aGlzLm9uQ2xvc2UgPSBvbkNsb3NlO1xuICAgIHRoaXMuYmFzZVBhdGggPSBwcm9jZXNzLmN3ZCgpO1xuXG4gICAgLy8gRW5hYmxlIFNHUiBtb3VzZSB0cmFja2luZ1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKFwiXFx4MWJbPzEwMDNoXFx4MWJbPzEwMDZoXCIpO1xuXG4gICAgLy8gSW52YWxpZGF0ZSBjYWNoZSBvbiB0ZXJtaW5hbCByZXNpemVcbiAgICB0aGlzLnJlc2l6ZUhhbmRsZXIgPSAoKSA9PiB7XG4gICAgICBpZiAodGhpcy5kaXNwb3NlZCkgcmV0dXJuO1xuICAgICAgdGhpcy5pbnZhbGlkYXRlKCk7XG4gICAgICB0aGlzLnR1aS5yZXF1ZXN0UmVuZGVyKCk7XG4gICAgfTtcbiAgICBwcm9jZXNzLnN0ZG91dC5vbihcInJlc2l6ZVwiLCB0aGlzLnJlc2l6ZUhhbmRsZXIpO1xuXG4gICAgbG9hZFZpc3VhbGl6ZXJEYXRhKHRoaXMuYmFzZVBhdGgpLnRoZW4oKGQpID0+IHtcbiAgICAgIHRoaXMuZGF0YSA9IGQ7XG4gICAgICB0aGlzLmxvYWRpbmcgPSBmYWxzZTtcbiAgICAgIHRoaXMudHVpLnJlcXVlc3RSZW5kZXIoKTtcbiAgICB9KS5jYXRjaCgoKSA9PiB7XG4gICAgICB0aGlzLmxvYWRpbmcgPSBmYWxzZTtcbiAgICAgIHRoaXMudHVpLnJlcXVlc3RSZW5kZXIoKTtcbiAgICB9KTtcblxuICAgIHRoaXMucmVmcmVzaFRpbWVyID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgICAgbG9hZFZpc3VhbGl6ZXJEYXRhKHRoaXMuYmFzZVBhdGgpLnRoZW4oKGQpID0+IHtcbiAgICAgICAgaWYgKHRoaXMuZGlzcG9zZWQpIHJldHVybjtcbiAgICAgICAgdGhpcy5kYXRhID0gZDtcbiAgICAgICAgdGhpcy5pbnZhbGlkYXRlKCk7XG4gICAgICAgIHRoaXMudHVpLnJlcXVlc3RSZW5kZXIoKTtcbiAgICAgIH0pLmNhdGNoKCgpID0+IHt9KTsgLy8gcmV0cnkgb24gbmV4dCBpbnRlcnZhbFxuICAgIH0sIDUwMDApO1xuICB9XG5cbiAgcHJpdmF0ZSBwYXJzZVNHUk1vdXNlKGRhdGE6IHN0cmluZyk6IHsgYnV0dG9uOiBudW1iZXI7IHg6IG51bWJlcjsgeTogbnVtYmVyOyBwcmVzczogYm9vbGVhbiB9IHwgbnVsbCB7XG4gICAgY29uc3QgbWF0Y2ggPSBkYXRhLm1hdGNoKC9eXFx4MWJcXFs8KFxcZCspOyhcXGQrKTsoXFxkKykoW01tXSkkLyk7XG4gICAgaWYgKCFtYXRjaCkgcmV0dXJuIG51bGw7XG4gICAgcmV0dXJuIHtcbiAgICAgIGJ1dHRvbjogcGFyc2VJbnQobWF0Y2hbMV0sIDEwKSxcbiAgICAgIHg6IHBhcnNlSW50KG1hdGNoWzJdLCAxMCksXG4gICAgICB5OiBwYXJzZUludChtYXRjaFszXSwgMTApLFxuICAgICAgcHJlc3M6IG1hdGNoWzRdID09PSBcIk1cIixcbiAgICB9O1xuICB9XG5cbiAgaGFuZGxlSW5wdXQoZGF0YTogc3RyaW5nKTogdm9pZCB7XG4gICAgaWYgKG1hdGNoZXNLZXkoZGF0YSwgS2V5LmVzY2FwZSkgfHwgbWF0Y2hlc0tleShkYXRhLCBLZXkuY3RybChcImNcIikpKSB7XG4gICAgICB0aGlzLmRpc3Bvc2UoKTtcbiAgICAgIHRoaXMub25DbG9zZSgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIEZpbHRlciBtb2RlIGlucHV0IHJvdXRpbmdcbiAgICBpZiAodGhpcy5maWx0ZXJNb2RlKSB7XG4gICAgICBpZiAobWF0Y2hlc0tleShkYXRhLCBLZXkuZW50ZXIpKSB7XG4gICAgICAgIHRoaXMuZmlsdGVyTW9kZSA9IGZhbHNlO1xuICAgICAgICB0aGlzLmludmFsaWRhdGUoKTtcbiAgICAgICAgdGhpcy50dWkucmVxdWVzdFJlbmRlcigpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBpZiAobWF0Y2hlc0tleShkYXRhLCBLZXkuYmFja3NwYWNlKSkge1xuICAgICAgICB0aGlzLmZpbHRlclRleHQgPSB0aGlzLmZpbHRlclRleHQuc2xpY2UoMCwgLTEpO1xuICAgICAgICB0aGlzLmludmFsaWRhdGUoKTtcbiAgICAgICAgdGhpcy50dWkucmVxdWVzdFJlbmRlcigpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICAvLyBBcHBlbmQgcHJpbnRhYmxlIGNoYXJhY3RlcnNcbiAgICAgIGlmIChkYXRhLmxlbmd0aCA9PT0gMSAmJiBkYXRhLmNoYXJDb2RlQXQoMCkgPj0gMzIpIHtcbiAgICAgICAgdGhpcy5maWx0ZXJUZXh0ICs9IGRhdGE7XG4gICAgICAgIHRoaXMuaW52YWxpZGF0ZSgpO1xuICAgICAgICB0aGlzLnR1aS5yZXF1ZXN0UmVuZGVyKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBIZWxwIG92ZXJsYXkgZGlzbWlzc2FsXG4gICAgaWYgKHRoaXMuc2hvd0hlbHApIHtcbiAgICAgIGlmIChtYXRjaGVzS2V5KGRhdGEsIEtleS5lc2NhcGUpIHx8IGRhdGEgPT09IFwiP1wiKSB7XG4gICAgICAgIHRoaXMuc2hvd0hlbHAgPSBmYWxzZTtcbiAgICAgICAgdGhpcy5pbnZhbGlkYXRlKCk7XG4gICAgICAgIHRoaXMudHVpLnJlcXVlc3RSZW5kZXIoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIE1vdXNlIGhhbmRsaW5nIChiZWZvcmUga2V5Ym9hcmQgY2hlY2tzKVxuICAgIGNvbnN0IG1vdXNlID0gdGhpcy5wYXJzZVNHUk1vdXNlKGRhdGEpO1xuICAgIGlmIChtb3VzZSkge1xuICAgICAgaWYgKG1vdXNlLmJ1dHRvbiA9PT0gNjQpIHtcbiAgICAgICAgLy8gV2hlZWwgdXBcbiAgICAgICAgdGhpcy5zY3JvbGxPZmZzZXRzW3RoaXMuYWN0aXZlVGFiXSA9IE1hdGgubWF4KDAsIHRoaXMuc2Nyb2xsT2Zmc2V0c1t0aGlzLmFjdGl2ZVRhYl0gLSAzKTtcbiAgICAgICAgdGhpcy5pbnZhbGlkYXRlKCk7XG4gICAgICAgIHRoaXMudHVpLnJlcXVlc3RSZW5kZXIoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgaWYgKG1vdXNlLmJ1dHRvbiA9PT0gNjUpIHtcbiAgICAgICAgLy8gV2hlZWwgZG93blxuICAgICAgICB0aGlzLnNjcm9sbE9mZnNldHNbdGhpcy5hY3RpdmVUYWJdICs9IDM7XG4gICAgICAgIHRoaXMuaW52YWxpZGF0ZSgpO1xuICAgICAgICB0aGlzLnR1aS5yZXF1ZXN0UmVuZGVyKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGlmIChtb3VzZS5idXR0b24gPT09IDAgJiYgbW91c2UucHJlc3MpIHtcbiAgICAgICAgLy8gTGVmdCBjbGljayBcdTIwMTQgY2hlY2sgaWYgb24gdGFiIGJhciByb3dcbiAgICAgICAgaWYgKG1vdXNlLnkgPT09IDIpIHtcbiAgICAgICAgICBsZXQgeFBvcyA9IDM7XG4gICAgICAgICAgY29uc3QgdGFicyA9IGJ1aWxkVGFiQmFyRW50cmllcyh0aGlzLmFjdGl2ZVRhYiwgdGhpcy5maWx0ZXJUZXh0LCB0aGlzLmRhdGE/LmNhcHR1cmVzPy5wZW5kaW5nQ291bnQpO1xuICAgICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgdGFicy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgY29uc3QgdGFiV2lkdGggPSB0YWJzW2ldIS53aWR0aDtcbiAgICAgICAgICAgIGlmIChtb3VzZS54ID49IHhQb3MgJiYgbW91c2UueCA8IHhQb3MgKyB0YWJXaWR0aCkge1xuICAgICAgICAgICAgICB0aGlzLmFjdGl2ZVRhYiA9IGk7XG4gICAgICAgICAgICAgIHRoaXMuaW52YWxpZGF0ZSgpO1xuICAgICAgICAgICAgICB0aGlzLnR1aS5yZXF1ZXN0UmVuZGVyKCk7XG4gICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHhQb3MgKz0gdGFiV2lkdGggKyAxO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmIChtYXRjaGVzS2V5KGRhdGEsIEtleS5zaGlmdChcInRhYlwiKSkpIHtcbiAgICAgIHRoaXMuYWN0aXZlVGFiID0gKHRoaXMuYWN0aXZlVGFiIC0gMSArIFRBQl9DT1VOVCkgJSBUQUJfQ09VTlQ7XG4gICAgICB0aGlzLmludmFsaWRhdGUoKTtcbiAgICAgIHRoaXMudHVpLnJlcXVlc3RSZW5kZXIoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAobWF0Y2hlc0tleShkYXRhLCBLZXkudGFiKSkge1xuICAgICAgdGhpcy5hY3RpdmVUYWIgPSAodGhpcy5hY3RpdmVUYWIgKyAxKSAlIFRBQl9DT1VOVDtcbiAgICAgIHRoaXMuaW52YWxpZGF0ZSgpO1xuICAgICAgdGhpcy50dWkucmVxdWVzdFJlbmRlcigpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmIChcIjEyMzQ1Njc4OTBcIi5pbmNsdWRlcyhkYXRhKSAmJiBkYXRhLmxlbmd0aCA9PT0gMSkge1xuICAgICAgY29uc3QgaWR4ID0gZGF0YSA9PT0gXCIwXCIgPyA5IDogcGFyc2VJbnQoZGF0YSwgMTApIC0gMTtcbiAgICAgIHRoaXMuYWN0aXZlVGFiID0gaWR4O1xuICAgICAgdGhpcy5pbnZhbGlkYXRlKCk7XG4gICAgICB0aGlzLnR1aS5yZXF1ZXN0UmVuZGVyKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gXCIvXCIgZW50ZXJzIGZpbHRlciBtb2RlIG9uIGFueSB0YWJcbiAgICBpZiAoZGF0YSA9PT0gXCIvXCIpIHtcbiAgICAgIHRoaXMuZmlsdGVyTW9kZSA9IHRydWU7XG4gICAgICB0aGlzLmZpbHRlclRleHQgPSBcIlwiO1xuICAgICAgdGhpcy5pbnZhbGlkYXRlKCk7XG4gICAgICB0aGlzLnR1aS5yZXF1ZXN0UmVuZGVyKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gXCJmXCIgY3ljbGVzIGZpbHRlciBmaWVsZCAobGltaXQgdG8gYWxsL2tleXdvcmQgb24gbm9uLVByb2dyZXNzIHRhYnMpXG4gICAgaWYgKGRhdGEgPT09IFwiZlwiKSB7XG4gICAgICBpZiAodGhpcy5hY3RpdmVUYWIgPT09IDApIHtcbiAgICAgICAgY29uc3QgZmllbGRzOiBBcnJheTxcImFsbFwiIHwgXCJzdGF0dXNcIiB8IFwicmlza1wiIHwgXCJrZXl3b3JkXCI+ID0gW1wiYWxsXCIsIFwic3RhdHVzXCIsIFwicmlza1wiLCBcImtleXdvcmRcIl07XG4gICAgICAgIGNvbnN0IGlkeCA9IGZpZWxkcy5pbmRleE9mKHRoaXMuZmlsdGVyRmllbGQpO1xuICAgICAgICB0aGlzLmZpbHRlckZpZWxkID0gZmllbGRzWyhpZHggKyAxKSAlIGZpZWxkcy5sZW5ndGhdO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy5maWx0ZXJGaWVsZCA9IHRoaXMuZmlsdGVyRmllbGQgPT09IFwiYWxsXCIgPyBcImtleXdvcmRcIiA6IFwiYWxsXCI7XG4gICAgICB9XG4gICAgICB0aGlzLmludmFsaWRhdGUoKTtcbiAgICAgIHRoaXMudHVpLnJlcXVlc3RSZW5kZXIoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBcIj9cIiB0b2dnbGVzIGhlbHAgb3ZlcmxheVxuICAgIGlmIChkYXRhID09PSBcIj9cIikge1xuICAgICAgdGhpcy5zaG93SGVscCA9IHRydWU7XG4gICAgICB0aGlzLmludmFsaWRhdGUoKTtcbiAgICAgIHRoaXMudHVpLnJlcXVlc3RSZW5kZXIoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBFbnRlci9TcGFjZSB0b2dnbGVzIGNvbGxhcHNlIG9uIFByb2dyZXNzIHRhYlxuICAgIGlmICgobWF0Y2hlc0tleShkYXRhLCBLZXkuZW50ZXIpIHx8IGRhdGEgPT09IFwiIFwiKSAmJiB0aGlzLmFjdGl2ZVRhYiA9PT0gMCAmJiB0aGlzLmRhdGEpIHtcbiAgICAgIGNvbnN0IHZpZXdMaW5lcyA9IHRoaXMucmVuZGVyVGFiQ29udGVudCgwLCA4MCk7XG4gICAgICBjb25zdCBvZmZzZXQgPSB0aGlzLnNjcm9sbE9mZnNldHNbMF07XG4gICAgICBmb3IgKGNvbnN0IG1zIG9mIHRoaXMuZGF0YS5taWxlc3RvbmVzKSB7XG4gICAgICAgIGNvbnN0IGxpbmVJZHggPSB2aWV3TGluZXMuZmluZEluZGV4KGwgPT4gc3RyaXBBbnNpKGwpLmluY2x1ZGVzKGAke21zLmlkfTpgKSk7XG4gICAgICAgIGlmIChsaW5lSWR4ID49IG9mZnNldCAmJiBsaW5lSWR4IDwgb2Zmc2V0ICsgdGhpcy5sYXN0VmlzaWJsZVJvd3MpIHtcbiAgICAgICAgICBpZiAodGhpcy5jb2xsYXBzZWRNaWxlc3RvbmVzLmhhcyhtcy5pZCkpIHtcbiAgICAgICAgICAgIHRoaXMuY29sbGFwc2VkTWlsZXN0b25lcy5kZWxldGUobXMuaWQpO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aGlzLmNvbGxhcHNlZE1pbGVzdG9uZXMuYWRkKG1zLmlkKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgdGhpcy5pbnZhbGlkYXRlKCk7XG4gICAgICAgICAgdGhpcy50dWkucmVxdWVzdFJlbmRlcigpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIEV4cG9ydCB0YWIga2V5IGhhbmRsaW5nXG4gICAgaWYgKHRoaXMuYWN0aXZlVGFiID09PSA5ICYmIHRoaXMuZGF0YSkge1xuICAgICAgaWYgKGRhdGEgPT09IFwibVwiIHx8IGRhdGEgPT09IFwialwiIHx8IGRhdGEgPT09IFwic1wiKSB7XG4gICAgICAgIHRoaXMuaGFuZGxlRXhwb3J0S2V5KGRhdGEpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gUGFnZSBVcC9Eb3duXG4gICAgaWYgKG1hdGNoZXNLZXkoZGF0YSwgS2V5LnBhZ2VVcCkpIHtcbiAgICAgIGNvbnN0IGFtb3VudCA9IE1hdGgubWF4KDEsIHRoaXMubGFzdFZpc2libGVSb3dzIC0gMik7XG4gICAgICB0aGlzLnNjcm9sbE9mZnNldHNbdGhpcy5hY3RpdmVUYWJdID0gTWF0aC5tYXgoMCwgdGhpcy5zY3JvbGxPZmZzZXRzW3RoaXMuYWN0aXZlVGFiXSAtIGFtb3VudCk7XG4gICAgICB0aGlzLmludmFsaWRhdGUoKTtcbiAgICAgIHRoaXMudHVpLnJlcXVlc3RSZW5kZXIoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAobWF0Y2hlc0tleShkYXRhLCBLZXkucGFnZURvd24pKSB7XG4gICAgICBjb25zdCBhbW91bnQgPSBNYXRoLm1heCgxLCB0aGlzLmxhc3RWaXNpYmxlUm93cyAtIDIpO1xuICAgICAgdGhpcy5zY3JvbGxPZmZzZXRzW3RoaXMuYWN0aXZlVGFiXSArPSBhbW91bnQ7XG4gICAgICB0aGlzLmludmFsaWRhdGUoKTtcbiAgICAgIHRoaXMudHVpLnJlcXVlc3RSZW5kZXIoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBIYWxmLXBhZ2Ugc2Nyb2xsOiBDdHJsK1UgLyBDdHJsK0RcbiAgICBpZiAobWF0Y2hlc0tleShkYXRhLCBLZXkuY3RybChcInVcIikpKSB7XG4gICAgICBjb25zdCBhbW91bnQgPSBNYXRoLm1heCgxLCBNYXRoLmZsb29yKHRoaXMubGFzdFZpc2libGVSb3dzIC8gMikpO1xuICAgICAgdGhpcy5zY3JvbGxPZmZzZXRzW3RoaXMuYWN0aXZlVGFiXSA9IE1hdGgubWF4KDAsIHRoaXMuc2Nyb2xsT2Zmc2V0c1t0aGlzLmFjdGl2ZVRhYl0gLSBhbW91bnQpO1xuICAgICAgdGhpcy5pbnZhbGlkYXRlKCk7XG4gICAgICB0aGlzLnR1aS5yZXF1ZXN0UmVuZGVyKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKG1hdGNoZXNLZXkoZGF0YSwgS2V5LmN0cmwoXCJkXCIpKSkge1xuICAgICAgY29uc3QgYW1vdW50ID0gTWF0aC5tYXgoMSwgTWF0aC5mbG9vcih0aGlzLmxhc3RWaXNpYmxlUm93cyAvIDIpKTtcbiAgICAgIHRoaXMuc2Nyb2xsT2Zmc2V0c1t0aGlzLmFjdGl2ZVRhYl0gKz0gYW1vdW50O1xuICAgICAgdGhpcy5pbnZhbGlkYXRlKCk7XG4gICAgICB0aGlzLnR1aS5yZXF1ZXN0UmVuZGVyKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKG1hdGNoZXNLZXkoZGF0YSwgS2V5LmRvd24pIHx8IG1hdGNoZXNLZXkoZGF0YSwgXCJqXCIpKSB7XG4gICAgICB0aGlzLnNjcm9sbE9mZnNldHNbdGhpcy5hY3RpdmVUYWJdKys7XG4gICAgICB0aGlzLmludmFsaWRhdGUoKTtcbiAgICAgIHRoaXMudHVpLnJlcXVlc3RSZW5kZXIoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAobWF0Y2hlc0tleShkYXRhLCBLZXkudXApIHx8IG1hdGNoZXNLZXkoZGF0YSwgXCJrXCIpKSB7XG4gICAgICB0aGlzLnNjcm9sbE9mZnNldHNbdGhpcy5hY3RpdmVUYWJdID0gTWF0aC5tYXgoMCwgdGhpcy5zY3JvbGxPZmZzZXRzW3RoaXMuYWN0aXZlVGFiXSAtIDEpO1xuICAgICAgdGhpcy5pbnZhbGlkYXRlKCk7XG4gICAgICB0aGlzLnR1aS5yZXF1ZXN0UmVuZGVyKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKGRhdGEgPT09IFwiZ1wiKSB7XG4gICAgICB0aGlzLnNjcm9sbE9mZnNldHNbdGhpcy5hY3RpdmVUYWJdID0gMDtcbiAgICAgIHRoaXMuaW52YWxpZGF0ZSgpO1xuICAgICAgdGhpcy50dWkucmVxdWVzdFJlbmRlcigpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmIChkYXRhID09PSBcIkdcIikge1xuICAgICAgdGhpcy5zY3JvbGxPZmZzZXRzW3RoaXMuYWN0aXZlVGFiXSA9IDk5OTtcbiAgICAgIHRoaXMuaW52YWxpZGF0ZSgpO1xuICAgICAgdGhpcy50dWkucmVxdWVzdFJlbmRlcigpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgaGFuZGxlRXhwb3J0S2V5KGtleTogXCJtXCIgfCBcImpcIiB8IFwic1wiKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmRhdGEpIHJldHVybjtcblxuICAgIGNvbnN0IGZvcm1hdCA9IGtleSA9PT0gXCJtXCIgPyBcIm1hcmtkb3duXCIgOiBrZXkgPT09IFwialwiID8gXCJqc29uXCIgOiBcInNuYXBzaG90XCI7XG5cbiAgICBpZiAoZm9ybWF0ID09PSBcInNuYXBzaG90XCIpIHtcbiAgICAgIC8vIENhcHR1cmUgY3VycmVudCBhY3RpdmUgdGFiJ3MgcmVuZGVyZWQgbGluZXMgYXMgc25hcHNob3RcbiAgICAgIGNvbnN0IHNuYXBzaG90TGluZXMgPSB0aGlzLnJlbmRlclRhYkNvbnRlbnQodGhpcy5hY3RpdmVUYWIsIDgwKTtcbiAgICAgIGNvbnN0IHRpbWVzdGFtcCA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKS5yZXBsYWNlKC9bOi5dL2csIFwiLVwiKS5zbGljZSgwLCAxOSk7XG4gICAgICBjb25zdCBleHBvcnREaXIgPSBnc2RSb290KHRoaXMuYmFzZVBhdGgpO1xuICAgICAgbWtkaXJTeW5jKGV4cG9ydERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICBjb25zdCBvdXRQYXRoID0gam9pbihleHBvcnREaXIsIGBzbmFwc2hvdC0ke3RpbWVzdGFtcH0udHh0YCk7XG4gICAgICB3cml0ZUZpbGVTeW5jKG91dFBhdGgsIHNuYXBzaG90TGluZXMuam9pbihcIlxcblwiKSArIFwiXFxuXCIsIFwidXRmLThcIik7XG4gICAgICB0aGlzLmxhc3RFeHBvcnRQYXRoID0gb3V0UGF0aDtcbiAgICAgIHRoaXMuZXhwb3J0U3RhdHVzID0gXCJTbmFwc2hvdCBzYXZlZFwiO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCByZXN1bHQgPSB3cml0ZUV4cG9ydEZpbGUodGhpcy5iYXNlUGF0aCwgZm9ybWF0LCB0aGlzLmRhdGEpO1xuICAgICAgaWYgKHJlc3VsdCkge1xuICAgICAgICB0aGlzLmxhc3RFeHBvcnRQYXRoID0gcmVzdWx0O1xuICAgICAgICB0aGlzLmV4cG9ydFN0YXR1cyA9IGAke2Zvcm1hdH0gZXhwb3J0IHNhdmVkYDtcbiAgICAgIH1cbiAgICB9XG5cbiAgICB0aGlzLmludmFsaWRhdGUoKTtcbiAgICB0aGlzLnR1aS5yZXF1ZXN0UmVuZGVyKCk7XG4gIH1cblxuICBwcml2YXRlIHJlbmRlclRhYkNvbnRlbnQodGFiOiBudW1iZXIsIHdpZHRoOiBudW1iZXIpOiBzdHJpbmdbXSB7XG4gICAgaWYgKCF0aGlzLmRhdGEpIHJldHVybiBbXTtcbiAgICBjb25zdCB0aCA9IHRoaXMudGhlbWU7XG4gICAgc3dpdGNoICh0YWIpIHtcbiAgICAgIGNhc2UgMDoge1xuICAgICAgICBjb25zdCBmaWx0ZXI6IFByb2dyZXNzRmlsdGVyIHwgdW5kZWZpbmVkID1cbiAgICAgICAgICB0aGlzLmZpbHRlclRleHQgPyB7IHRleHQ6IHRoaXMuZmlsdGVyVGV4dCwgZmllbGQ6IHRoaXMuZmlsdGVyRmllbGQgfSA6IHVuZGVmaW5lZDtcbiAgICAgICAgcmV0dXJuIHJlbmRlclByb2dyZXNzVmlldyh0aGlzLmRhdGEsIHRoLCB3aWR0aCwgZmlsdGVyLCB0aGlzLmNvbGxhcHNlZE1pbGVzdG9uZXMpO1xuICAgICAgfVxuICAgICAgY2FzZSAxOlxuICAgICAgICByZXR1cm4gcmVuZGVyVGltZWxpbmVWaWV3KHRoaXMuZGF0YSwgdGgsIHdpZHRoKTtcbiAgICAgIGNhc2UgMjpcbiAgICAgICAgcmV0dXJuIHJlbmRlckRlcHNWaWV3KHRoaXMuZGF0YSwgdGgsIHdpZHRoKTtcbiAgICAgIGNhc2UgMzpcbiAgICAgICAgcmV0dXJuIHJlbmRlck1ldHJpY3NWaWV3KHRoaXMuZGF0YSwgdGgsIHdpZHRoKTtcbiAgICAgIGNhc2UgNDpcbiAgICAgICAgcmV0dXJuIHJlbmRlckhlYWx0aFZpZXcodGhpcy5kYXRhLCB0aCwgd2lkdGgpO1xuICAgICAgY2FzZSA1OlxuICAgICAgICByZXR1cm4gcmVuZGVyQWdlbnRWaWV3KHRoaXMuZGF0YSwgdGgsIHdpZHRoKTtcbiAgICAgIGNhc2UgNjpcbiAgICAgICAgcmV0dXJuIHJlbmRlckNoYW5nZWxvZ1ZpZXcodGhpcy5kYXRhLCB0aCwgd2lkdGgpO1xuICAgICAgY2FzZSA3OlxuICAgICAgICByZXR1cm4gcmVuZGVyS25vd2xlZGdlVmlldyh0aGlzLmRhdGEsIHRoLCB3aWR0aCk7XG4gICAgICBjYXNlIDg6XG4gICAgICAgIHJldHVybiByZW5kZXJDYXB0dXJlc1ZpZXcodGhpcy5kYXRhLCB0aCwgd2lkdGgpO1xuICAgICAgY2FzZSA5OlxuICAgICAgICByZXR1cm4gcmVuZGVyRXhwb3J0Vmlldyh0aGlzLmRhdGEsIHRoLCB3aWR0aCwgdGhpcy5sYXN0RXhwb3J0UGF0aCk7XG4gICAgICBkZWZhdWx0OlxuICAgICAgICByZXR1cm4gW107XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSByZW5kZXJIZWxwQ29udGVudCh3aWR0aDogbnVtYmVyKTogc3RyaW5nW10ge1xuICAgIGNvbnN0IHRoID0gdGhpcy50aGVtZTtcbiAgICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcbiAgICBsaW5lcy5wdXNoKHRoLmZnKFwiYWNjZW50XCIsIHRoLmJvbGQoXCJLZXlib2FyZCBTaG9ydGN1dHNcIikpKTtcbiAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICAgIGNvbnN0IGJpbmRpbmdzOiBbc3RyaW5nLCBzdHJpbmddW10gPSBbXG4gICAgICBbXCJUYWIvU2hpZnQrVGFiXCIsIFwiTmV4dC9QcmV2aW91cyB0YWJcIl0sXG4gICAgICBbXCIxLTksIDBcIiwgXCJKdW1wIHRvIHRhYlwiXSxcbiAgICAgIFtcImovaywgVXAvRG93blwiLCBcIlNjcm9sbCBsaW5lXCJdLFxuICAgICAgW1wiUGdVcC9QZ0RuXCIsIFwiU2Nyb2xsIHBhZ2VcIl0sXG4gICAgICBbXCJDdHJsK1UvQ3RybCtEXCIsIFwiU2Nyb2xsIGhhbGYtcGFnZVwiXSxcbiAgICAgIFtcImcvR1wiLCBcIlRvcC9Cb3R0b21cIl0sXG4gICAgICBbXCIvXCIsIFwiU2VhcmNoL2ZpbHRlclwiXSxcbiAgICAgIFtcImZcIiwgXCJDeWNsZSBmaWx0ZXIgZmllbGRcIl0sXG4gICAgICBbXCJFbnRlci9TcGFjZVwiLCBcIlRvZ2dsZSBjb2xsYXBzZSAoUHJvZ3Jlc3MpXCJdLFxuICAgICAgW1wiTW91c2Ugd2hlZWxcIiwgXCJTY3JvbGxcIl0sXG4gICAgICBbXCJDbGljayB0YWJcIiwgXCJTd2l0Y2ggdGFiXCJdLFxuICAgICAgW1wiP1wiLCBcIlRvZ2dsZSBoZWxwXCJdLFxuICAgICAgW1wiRXNjXCIsIFwiQ2xvc2VcIl0sXG4gICAgXTtcbiAgICBmb3IgKGNvbnN0IFtrZXksIGRlc2NdIG9mIGJpbmRpbmdzKSB7XG4gICAgICBjb25zdCBrZXlTdHIgPSB0aC5mZyhcImFjY2VudFwiLCBrZXkucGFkRW5kKDIwKSk7XG4gICAgICBsaW5lcy5wdXNoKGAgICR7a2V5U3RyfSAke2Rlc2N9YCk7XG4gICAgfVxuICAgIGxpbmVzLnB1c2goXCJcIik7XG4gICAgbGluZXMucHVzaCh0aC5mZyhcImRpbVwiLCBcIlByZXNzID8gb3IgRXNjIHRvIGRpc21pc3NcIikpO1xuICAgIHJldHVybiBsaW5lcztcbiAgfVxuXG4gIHJlbmRlcih3aWR0aDogbnVtYmVyKTogc3RyaW5nW10ge1xuICAgIGlmICh0aGlzLmNhY2hlZExpbmVzICYmIHRoaXMuY2FjaGVkV2lkdGggPT09IHdpZHRoKSB7XG4gICAgICByZXR1cm4gdGhpcy5jYWNoZWRMaW5lcztcbiAgICB9XG5cbiAgICBjb25zdCB0aCA9IHRoaXMudGhlbWU7XG4gICAgY29uc3QgaW5uZXJXaWR0aCA9IHdpZHRoIC0gNDtcbiAgICBjb25zdCBjb250ZW50OiBzdHJpbmdbXSA9IFtdO1xuXG4gICAgLy8gVGFiIGJhclxuICAgIGNvbnN0IHRhYkVudHJpZXMgPSBidWlsZFRhYkJhckVudHJpZXModGhpcy5hY3RpdmVUYWIsIHRoaXMuZmlsdGVyVGV4dCwgdGhpcy5kYXRhPy5jYXB0dXJlcz8ucGVuZGluZ0NvdW50KTtcbiAgICBjb25zdCB0YWJzID0gdGFiRW50cmllcy5tYXAoKGVudHJ5LCBpKSA9PiB7XG4gICAgICBpZiAoaSA9PT0gdGhpcy5hY3RpdmVUYWIpIHtcbiAgICAgICAgcmV0dXJuIHRoLmZnKFwiYWNjZW50XCIsIGBbJHtlbnRyeS5sYWJlbH1dYCk7XG4gICAgICB9XG4gICAgICByZXR1cm4gdGguZmcoXCJkaW1cIiwgYFske2VudHJ5LmxhYmVsfV1gKTtcbiAgICB9KTtcbiAgICBjb250ZW50LnB1c2goXCIgXCIgKyB0YWJzLmpvaW4oXCIgXCIpKTtcbiAgICBjb250ZW50LnB1c2goXCJcIik7XG5cbiAgICAvLyBGaWx0ZXIgYmFyICh3aGVuIGluIGZpbHRlciBtb2RlIG9uIGFueSB0YWIpXG4gICAgaWYgKHRoaXMuZmlsdGVyTW9kZSkge1xuICAgICAgY29udGVudC5wdXNoKFxuICAgICAgICB0aC5mZyhcImFjY2VudFwiLCBgRmlsdGVyICgke3RoaXMuZmlsdGVyRmllbGR9KTogJHt0aGlzLmZpbHRlclRleHR9XFx1MjU4OGApLFxuICAgICAgKTtcbiAgICAgIGNvbnRlbnQucHVzaChcIlwiKTtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5zaG93SGVscCkge1xuICAgICAgY29udGVudC5wdXNoKC4uLnRoaXMucmVuZGVySGVscENvbnRlbnQoaW5uZXJXaWR0aCkpO1xuICAgIH0gZWxzZSBpZiAodGhpcy5sb2FkaW5nKSB7XG4gICAgICBjb25zdCBsb2FkaW5nVGV4dCA9IFwiTG9hZGluZ1xcdTIwMjZcIjtcbiAgICAgIGNvbnN0IHZpcyA9IHZpc2libGVXaWR0aChsb2FkaW5nVGV4dCk7XG4gICAgICBjb25zdCBsZWZ0UGFkID0gTWF0aC5tYXgoMCwgTWF0aC5mbG9vcigoaW5uZXJXaWR0aCAtIHZpcykgLyAyKSk7XG4gICAgICBjb250ZW50LnB1c2goXCIgXCIucmVwZWF0KGxlZnRQYWQpICsgbG9hZGluZ1RleHQpO1xuICAgIH0gZWxzZSBpZiAodGhpcy5kYXRhKSB7XG4gICAgICBsZXQgdmlld0xpbmVzID0gdGhpcy5yZW5kZXJUYWJDb250ZW50KHRoaXMuYWN0aXZlVGFiLCBpbm5lcldpZHRoKTtcblxuICAgICAgLy8gU2hvdyBleHBvcnQgc3RhdHVzIG1lc3NhZ2UgaWYgcHJlc2VudFxuICAgICAgaWYgKHRoaXMuZXhwb3J0U3RhdHVzICYmIHRoaXMuYWN0aXZlVGFiID09PSA5KSB7XG4gICAgICAgIGNvbnRlbnQucHVzaCh0aC5mZyhcInN1Y2Nlc3NcIiwgdGhpcy5leHBvcnRTdGF0dXMpKTtcbiAgICAgICAgY29udGVudC5wdXNoKFwiXCIpO1xuICAgICAgICB0aGlzLmV4cG9ydFN0YXR1cyA9IHVuZGVmaW5lZDtcbiAgICAgIH1cblxuICAgICAgLy8gQXBwbHkgY3Jvc3MtdGFiIGZpbHRlciBmb3Igbm9uLVByb2dyZXNzIHRhYnNcbiAgICAgIGlmICh0aGlzLmZpbHRlclRleHQgJiYgdGhpcy5hY3RpdmVUYWIgIT09IDApIHtcbiAgICAgICAgY29uc3QgbG93ZXJGaWx0ZXIgPSB0aGlzLmZpbHRlclRleHQudG9Mb3dlckNhc2UoKTtcbiAgICAgICAgdmlld0xpbmVzID0gdmlld0xpbmVzLmZpbHRlcihsaW5lID0+IHN0cmlwQW5zaShsaW5lKS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKGxvd2VyRmlsdGVyKSk7XG4gICAgICB9XG5cbiAgICAgIGNvbnRlbnQucHVzaCguLi52aWV3TGluZXMpO1xuICAgIH1cblxuICAgIC8vIEFwcGx5IHNjcm9sbFxuICAgIGNvbnN0IHZpZXdwb3J0SGVpZ2h0ID0gTWF0aC5tYXgoNSwgcHJvY2Vzcy5zdGRvdXQucm93cyA/IHByb2Nlc3Muc3Rkb3V0LnJvd3MgLSA4IDogMjQpO1xuICAgIGNvbnN0IGNocm9tZUhlaWdodCA9IDI7XG4gICAgY29uc3QgdmlzaWJsZUNvbnRlbnRSb3dzID0gTWF0aC5tYXgoMSwgdmlld3BvcnRIZWlnaHQgLSBjaHJvbWVIZWlnaHQpO1xuICAgIHRoaXMubGFzdFZpc2libGVSb3dzID0gdmlzaWJsZUNvbnRlbnRSb3dzO1xuICAgIGNvbnN0IHRvdGFsTGluZXMgPSBjb250ZW50Lmxlbmd0aDtcbiAgICBjb25zdCBtYXhTY3JvbGwgPSBNYXRoLm1heCgwLCBjb250ZW50Lmxlbmd0aCAtIHZpc2libGVDb250ZW50Um93cyk7XG4gICAgdGhpcy5zY3JvbGxPZmZzZXRzW3RoaXMuYWN0aXZlVGFiXSA9IE1hdGgubWluKHRoaXMuc2Nyb2xsT2Zmc2V0c1t0aGlzLmFjdGl2ZVRhYl0sIG1heFNjcm9sbCk7XG4gICAgY29uc3Qgb2Zmc2V0ID0gdGhpcy5zY3JvbGxPZmZzZXRzW3RoaXMuYWN0aXZlVGFiXTtcbiAgICBjb25zdCB2aXNpYmxlQ29udGVudCA9IGNvbnRlbnQuc2xpY2Uob2Zmc2V0LCBvZmZzZXQgKyB2aXNpYmxlQ29udGVudFJvd3MpO1xuXG4gICAgY29uc3QgbGluZXMgPSB0aGlzLndyYXBJbkJveCh2aXNpYmxlQ29udGVudCwgd2lkdGgsIG9mZnNldCwgdmlzaWJsZUNvbnRlbnRSb3dzLCB0b3RhbExpbmVzKTtcblxuICAgIC8vIEZvb3RlciBoaW50XG4gICAgY29uc3QgaGludCA9IHRoLmZnKFwiZGltXCIsIFwiVGFiL1NoaWZ0K1RhYi8xLTksMCBzd2l0Y2ggXFx1MDBiNyAvIGZpbHRlciBcXHUwMGI3IFBnVXAvUGdEbiBzY3JvbGwgXFx1MDBiNyA/IGhlbHAgXFx1MDBiNyBlc2MgY2xvc2VcIik7XG4gICAgY29uc3QgaGludFZpcyA9IHZpc2libGVXaWR0aChoaW50KTtcbiAgICBjb25zdCBoaW50UGFkID0gTWF0aC5tYXgoMCwgTWF0aC5mbG9vcigod2lkdGggLSBoaW50VmlzKSAvIDIpKTtcbiAgICBsaW5lcy5wdXNoKFwiIFwiLnJlcGVhdChoaW50UGFkKSArIGhpbnQpO1xuXG4gICAgdGhpcy5jYWNoZWRXaWR0aCA9IHdpZHRoO1xuICAgIHRoaXMuY2FjaGVkTGluZXMgPSBsaW5lcztcbiAgICByZXR1cm4gbGluZXM7XG4gIH1cblxuICBwcml2YXRlIHdyYXBJbkJveChpbm5lcjogc3RyaW5nW10sIHdpZHRoOiBudW1iZXIsIG9mZnNldD86IG51bWJlciwgdmlzaWJsZVJvd3M/OiBudW1iZXIsIHRvdGFsTGluZXM/OiBudW1iZXIpOiBzdHJpbmdbXSB7XG4gICAgY29uc3QgdGggPSB0aGlzLnRoZW1lO1xuICAgIGNvbnN0IGJvcmRlciA9IChzOiBzdHJpbmcpID0+IHRoLmZnKFwiYm9yZGVyQWNjZW50XCIsIHMpO1xuICAgIGNvbnN0IGlubmVyV2lkdGggPSB3aWR0aCAtIDQ7XG4gICAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG4gICAgbGluZXMucHVzaChib3JkZXIoXCJcXHUyNTZkXCIgKyBcIlxcdTI1MDBcIi5yZXBlYXQod2lkdGggLSAyKSArIFwiXFx1MjU2ZVwiKSk7XG5cbiAgICAvLyBDb21wdXRlIHNjcm9sbCBpbmRpY2F0b3IgcG9zaXRpb25zXG4gICAgY29uc3Qgc2Nyb2xsYWJsZSA9IHRvdGFsTGluZXMgIT09IHVuZGVmaW5lZCAmJiB2aXNpYmxlUm93cyAhPT0gdW5kZWZpbmVkICYmIHRvdGFsTGluZXMgPiB2aXNpYmxlUm93cztcbiAgICBsZXQgdGh1bWJTdGFydCA9IC0xO1xuICAgIGxldCB0aHVtYkxlbiA9IDA7XG4gICAgY29uc3QgaW5uZXJSb3dzID0gaW5uZXIubGVuZ3RoO1xuICAgIGlmIChzY3JvbGxhYmxlICYmIGlubmVyUm93cyA+IDAgJiYgdG90YWxMaW5lcyEgPiAwKSB7XG4gICAgICB0aHVtYlN0YXJ0ID0gTWF0aC5yb3VuZCgoKG9mZnNldCA/PyAwKSAvIHRvdGFsTGluZXMhKSAqIGlubmVyUm93cyk7XG4gICAgICB0aHVtYkxlbiA9IE1hdGgubWF4KDEsIE1hdGgucm91bmQoKHZpc2libGVSb3dzISAvIHRvdGFsTGluZXMhKSAqIGlubmVyUm93cykpO1xuICAgIH1cblxuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgaW5uZXIubGVuZ3RoOyBpKyspIHtcbiAgICAgIGNvbnN0IGxpbmUgPSBpbm5lcltpXTtcbiAgICAgIGNvbnN0IHRydW5jYXRlZCA9IHRydW5jYXRlVG9XaWR0aChsaW5lLCBpbm5lcldpZHRoKTtcbiAgICAgIGNvbnN0IHBhZFdpZHRoID0gTWF0aC5tYXgoMCwgaW5uZXJXaWR0aCAtIHZpc2libGVXaWR0aCh0cnVuY2F0ZWQpKTtcbiAgICAgIGNvbnN0IHJpZ2h0Qm9yZGVyID0gc2Nyb2xsYWJsZSAmJiBpID49IHRodW1iU3RhcnQgJiYgaSA8IHRodW1iU3RhcnQgKyB0aHVtYkxlblxuICAgICAgICA/IGJvcmRlcihcIlxcdTI1MDNcIilcbiAgICAgICAgOiBib3JkZXIoXCJcXHUyNTAyXCIpO1xuICAgICAgbGluZXMucHVzaChib3JkZXIoXCJcXHUyNTAyXCIpICsgXCIgXCIgKyB0cnVuY2F0ZWQgKyBcIiBcIi5yZXBlYXQocGFkV2lkdGgpICsgXCIgXCIgKyByaWdodEJvcmRlcik7XG4gICAgfVxuICAgIGxpbmVzLnB1c2goYm9yZGVyKFwiXFx1MjU3MFwiICsgXCJcXHUyNTAwXCIucmVwZWF0KHdpZHRoIC0gMikgKyBcIlxcdTI1NmZcIikpO1xuICAgIHJldHVybiBsaW5lcztcbiAgfVxuXG4gIGludmFsaWRhdGUoKTogdm9pZCB7XG4gICAgdGhpcy5jYWNoZWRXaWR0aCA9IHVuZGVmaW5lZDtcbiAgICB0aGlzLmNhY2hlZExpbmVzID0gdW5kZWZpbmVkO1xuICB9XG5cbiAgZGlzcG9zZSgpOiB2b2lkIHtcbiAgICB0aGlzLmRpc3Bvc2VkID0gdHJ1ZTtcbiAgICBjbGVhckludGVydmFsKHRoaXMucmVmcmVzaFRpbWVyKTtcbiAgICBpZiAodGhpcy5yZXNpemVIYW5kbGVyKSB7XG4gICAgICBwcm9jZXNzLnN0ZG91dC5yZW1vdmVMaXN0ZW5lcihcInJlc2l6ZVwiLCB0aGlzLnJlc2l6ZUhhbmRsZXIpO1xuICAgICAgdGhpcy5yZXNpemVIYW5kbGVyID0gbnVsbDtcbiAgICB9XG4gICAgLy8gRGlzYWJsZSBTR1IgbW91c2UgdHJhY2tpbmdcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShcIlxceDFiWz8xMDAzbFxceDFiWz8xMDA2bFwiKTtcbiAgfVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBQ0EsU0FBUyxpQkFBaUIsY0FBYyxZQUFZLFdBQVc7QUFD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
