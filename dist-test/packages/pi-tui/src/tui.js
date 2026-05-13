import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isKeyRelease, matchesKey } from "./keys.js";
import {
  applyLineResets,
  compositeOverlays,
  extractCursorPosition,
  isOverlayVisible as isOverlayEntryVisible
} from "./overlay-layout.js";
import { getCapabilities, isImageLine, setCellDimensions } from "./terminal-image.js";
import { truncateToWidth, visibleWidth } from "./utils.js";
function isFocusable(component) {
  return component !== null && "focused" in component;
}
const CURSOR_MARKER = "\x1B_pi:c\x07";
class Container {
  constructor() {
    this.children = [];
    this._prevRender = null;
  }
  addChild(component) {
    this.children.push(component);
    this._prevRender = null;
  }
  removeChild(component) {
    const index = this.children.indexOf(component);
    if (index !== -1) {
      const child = this.children[index];
      this.children.splice(index, 1);
      if ("dispose" in child && typeof child.dispose === "function") {
        child.dispose();
      }
      this._prevRender = null;
    }
  }
  clear() {
    for (const child of this.children) {
      if ("dispose" in child && typeof child.dispose === "function") {
        child.dispose();
      }
    }
    this.children = [];
    this._prevRender = null;
  }
  /**
   * Remove all children without calling dispose on them.
   * Use when child lifecycle is owned elsewhere and the container is only a
   * render mount (e.g. extension widget containers in InteractiveMode, where
   * the extensionWidgets* maps own disposal).
   */
  detachChildren() {
    this.children = [];
    this._prevRender = null;
  }
  invalidate() {
    for (const child of this.children) {
      child.invalidate?.();
    }
  }
  render(width) {
    const lines = [];
    for (const child of this.children) {
      const rendered = child.render(width);
      for (let i = 0; i < rendered.length; i++) lines.push(rendered[i]);
    }
    const prev = this._prevRender;
    if (prev && prev.length === lines.length) {
      let same = true;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] !== prev[i]) {
          same = false;
          break;
        }
      }
      if (same) return prev;
    }
    this._prevRender = lines;
    return lines;
  }
}
class TUI extends Container {
  constructor(terminal, showHardwareCursor) {
    super();
    this.previousLines = [];
    this.previousWidth = 0;
    this.previousHeight = 0;
    this.focusedComponent = null;
    this.inputListeners = /* @__PURE__ */ new Set();
    this.renderRequested = false;
    this.cursorRow = 0;
    // Logical cursor row (end of rendered content)
    this.hardwareCursorRow = 0;
    // Logical content row of the terminal cursor; physical screen row = hardwareCursorRow - previousViewportTop
    this.inputBuffer = "";
    // Buffer for parsing terminal responses
    this.cellSizeQueryPending = false;
    this.showHardwareCursor = process.env.PI_HARDWARE_CURSOR === "1" || process.env.TERM_PROGRAM === "WarpTerminal";
    this.clearOnShrink = process.env.PI_CLEAR_ON_SHRINK === "1";
    // Clear empty rows when content shrinks (default: off)
    this._shrinkDebounceActive = false;
    this.maxLinesRendered = 0;
    // Track terminal's working area (max lines ever rendered)
    this.previousViewportTop = 0;
    // Track previous viewport top for resize-aware cursor moves
    this.fullRedrawCount = 0;
    this.stopped = false;
    this._lastRenderedComponents = null;
    // Overlay stack for modal components rendered on top of base content
    this.focusOrderCounter = 0;
    this.overlayStack = [];
    this.terminal = terminal;
    if (showHardwareCursor !== void 0) {
      this.showHardwareCursor = showHardwareCursor;
    }
  }
  get fullRedraws() {
    return this.fullRedrawCount;
  }
  getShowHardwareCursor() {
    return this.showHardwareCursor;
  }
  setShowHardwareCursor(enabled) {
    if (this.showHardwareCursor === enabled) return;
    this.showHardwareCursor = enabled;
    if (!enabled) {
      this.terminal.hideCursor();
    }
    this.requestRender();
  }
  getClearOnShrink() {
    return this.clearOnShrink;
  }
  /**
   * Set whether to trigger full re-render when content shrinks.
   * When true (default), empty rows are cleared when content shrinks.
   * When false, empty rows remain (reduces redraws on slower terminals).
   */
  setClearOnShrink(enabled) {
    this.clearOnShrink = enabled;
  }
  setFocus(component) {
    if (isFocusable(this.focusedComponent)) {
      this.focusedComponent.focused = false;
    }
    this.focusedComponent = component;
    if (isFocusable(component)) {
      component.focused = true;
    }
  }
  /**
   * Show an overlay component with configurable positioning and sizing.
   * Returns a handle to control the overlay's visibility.
   */
  showOverlay(component, options) {
    const entry = {
      component,
      options,
      preFocus: this.focusedComponent,
      hidden: false,
      focusOrder: ++this.focusOrderCounter
    };
    this.overlayStack.push(entry);
    if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
      this.setFocus(component);
    }
    this.terminal.hideCursor();
    this.requestRender();
    return {
      hide: () => {
        const index = this.overlayStack.indexOf(entry);
        if (index !== -1) {
          this.overlayStack.splice(index, 1);
          if (this.focusedComponent === component) {
            const topVisible = this.getTopmostVisibleOverlay();
            this.setFocus(topVisible?.component ?? entry.preFocus);
          }
          if (this.overlayStack.length === 0) this.terminal.hideCursor();
          this.requestRender();
        }
      },
      setHidden: (hidden) => {
        if (entry.hidden === hidden) return;
        entry.hidden = hidden;
        if (hidden) {
          if (this.focusedComponent === component) {
            const topVisible = this.getTopmostVisibleOverlay();
            this.setFocus(topVisible?.component ?? entry.preFocus);
          }
        } else {
          if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
            entry.focusOrder = ++this.focusOrderCounter;
            this.setFocus(component);
          }
        }
        this.requestRender();
      },
      isHidden: () => entry.hidden,
      focus: () => {
        if (!this.overlayStack.includes(entry) || !this.isOverlayVisible(entry)) return;
        if (this.focusedComponent !== component) {
          this.setFocus(component);
        }
        entry.focusOrder = ++this.focusOrderCounter;
        this.requestRender();
      },
      unfocus: () => {
        if (this.focusedComponent !== component) return;
        const topVisible = this.getTopmostVisibleOverlay();
        this.setFocus(topVisible && topVisible !== entry ? topVisible.component : entry.preFocus);
        this.requestRender();
      },
      isFocused: () => this.focusedComponent === component
    };
  }
  /** Hide the topmost overlay and restore previous focus. */
  hideOverlay() {
    const overlay = this.overlayStack.pop();
    if (!overlay) return;
    if (this.focusedComponent === overlay.component) {
      const topVisible = this.getTopmostVisibleOverlay();
      this.setFocus(topVisible?.component ?? overlay.preFocus);
    }
    if (this.overlayStack.length === 0) this.terminal.hideCursor();
    this.requestRender();
  }
  /** Check if there are any visible overlays */
  hasOverlay() {
    return this.overlayStack.some((o) => this.isOverlayVisible(o));
  }
  /** Check if an overlay entry is currently visible */
  isOverlayVisible(entry) {
    return isOverlayEntryVisible(entry, this.terminal.columns, this.terminal.rows);
  }
  /** Find the topmost visible capturing overlay, if any */
  getTopmostVisibleOverlay() {
    for (let i = this.overlayStack.length - 1; i >= 0; i--) {
      if (this.overlayStack[i].options?.nonCapturing) continue;
      if (this.isOverlayVisible(this.overlayStack[i])) {
        return this.overlayStack[i];
      }
    }
    return void 0;
  }
  invalidate() {
    super.invalidate();
    for (const overlay of this.overlayStack) overlay.component.invalidate?.();
  }
  start() {
    this.stopped = false;
    if (!this.terminal.isTTY) {
      return;
    }
    this.terminal.start(
      (data) => this.handleInput(data),
      () => this.requestRender()
    );
    this.terminal.hideCursor();
    this.queryCellSize();
    this.requestRender();
  }
  addInputListener(listener) {
    this.inputListeners.add(listener);
    return () => {
      this.inputListeners.delete(listener);
    };
  }
  removeInputListener(listener) {
    this.inputListeners.delete(listener);
  }
  queryCellSize() {
    if (!getCapabilities().images) {
      return;
    }
    this.cellSizeQueryPending = true;
    this.terminal.write("\x1B[16t");
  }
  stop() {
    this.stopped = true;
    for (const entry of this.overlayStack) {
      if ("dispose" in entry.component && typeof entry.component.dispose === "function") {
        entry.component.dispose();
      }
    }
    this.overlayStack = [];
    if (this.previousLines.length > 0) {
      const targetRow = this.previousLines.length;
      const lineDiff = targetRow - this.hardwareCursorRow;
      if (lineDiff > 0) {
        this.terminal.write(`\x1B[${lineDiff}B`);
      } else if (lineDiff < 0) {
        this.terminal.write(`\x1B[${-lineDiff}A`);
      }
      this.terminal.write("\r\n");
    }
    this.terminal.showCursor();
    this.terminal.stop();
  }
  requestRender(force = false) {
    if (!this.terminal.isTTY) return;
    if (force) {
      this.previousLines = [];
      this.previousWidth = -1;
      this.previousHeight = -1;
      this.cursorRow = 0;
      this.hardwareCursorRow = 0;
      this.maxLinesRendered = 0;
      this.previousViewportTop = 0;
    }
    if (this.renderRequested) return;
    this.renderRequested = true;
    process.nextTick(() => {
      this.renderRequested = false;
      this.doRender();
    });
  }
  handleInput(data) {
    if (this.inputListeners.size > 0) {
      let current = data;
      for (const listener of this.inputListeners) {
        const result = listener(current);
        if (result?.consume) {
          return;
        }
        if (result?.data !== void 0) {
          current = result.data;
        }
      }
      if (current.length === 0) {
        return;
      }
      data = current;
    }
    if (this.cellSizeQueryPending) {
      this.inputBuffer += data;
      const filtered = this.parseCellSizeResponse();
      if (filtered.length === 0) return;
      data = filtered;
    }
    if (matchesKey(data, "shift+ctrl+d") && this.onDebug) {
      this.onDebug();
      return;
    }
    const focusedOverlay = this.overlayStack.find((o) => o.component === this.focusedComponent);
    if (focusedOverlay && !this.isOverlayVisible(focusedOverlay)) {
      const topVisible = this.getTopmostVisibleOverlay();
      if (topVisible) {
        this.setFocus(topVisible.component);
      } else {
        this.setFocus(focusedOverlay.preFocus);
      }
    }
    if (this.focusedComponent?.handleInput) {
      if (isKeyRelease(data) && !this.focusedComponent.wantsKeyRelease) {
        return;
      }
      this.focusedComponent.handleInput(data);
      this.requestRender();
    }
  }
  parseCellSizeResponse() {
    const responsePattern = /\x1b\[6;(\d+);(\d+)t/;
    const match = this.inputBuffer.match(responsePattern);
    if (match) {
      const heightPx = parseInt(match[1], 10);
      const widthPx = parseInt(match[2], 10);
      if (heightPx > 0 && widthPx > 0) {
        setCellDimensions({ widthPx, heightPx });
        this.invalidate();
        this.requestRender();
      }
      this.inputBuffer = this.inputBuffer.replace(responsePattern, "");
      this.cellSizeQueryPending = false;
    }
    if (this.inputBuffer === "\x1B") {
      const result2 = this.inputBuffer;
      this.inputBuffer = "";
      this.cellSizeQueryPending = false;
      return result2;
    }
    const partialCellSizePattern = /\x1b(\[6?;?[\d;]*)?$/;
    if (partialCellSizePattern.test(this.inputBuffer)) {
      const lastChar = this.inputBuffer[this.inputBuffer.length - 1];
      if (!/[a-zA-Z~]/.test(lastChar)) {
        return "";
      }
    }
    const result = this.inputBuffer;
    this.inputBuffer = "";
    this.cellSizeQueryPending = false;
    return result;
  }
  doRender() {
    if (this.stopped) return;
    const width = this.terminal.columns;
    const height = this.terminal.rows;
    const getViewportTop = (lineCount) => lineCount - height;
    let viewportTop = getViewportTop(this.maxLinesRendered);
    let prevViewportTop = this.previousViewportTop;
    let hardwareCursorRow = this.hardwareCursorRow;
    const computeLineDiff = (targetRow) => {
      const currentScreenRow = hardwareCursorRow - prevViewportTop;
      const targetScreenRow = targetRow - viewportTop;
      return targetScreenRow - currentScreenRow;
    };
    let newLines = this.render(width);
    if (newLines === this._lastRenderedComponents && this.overlayStack.length === 0) {
      return;
    }
    this._lastRenderedComponents = newLines;
    if (this.overlayStack.length > 0) {
      newLines = compositeOverlays(newLines, this.overlayStack, width, height, this.maxLinesRendered);
    }
    const cursorPos = extractCursorPosition(newLines, height);
    newLines = applyLineResets(newLines);
    const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;
    const heightChanged = this.previousHeight !== 0 && this.previousHeight !== height;
    const fullRender = (clear) => {
      this.fullRedrawCount += 1;
      let buffer2 = "\x1B[?2026h";
      const startRow = Math.max(1, height - Math.max(1, newLines.length) + 1);
      if (clear) {
        buffer2 += `\x1B[2J\x1B[${startRow};1H`;
      } else if (startRow > 1) {
        buffer2 += `\x1B[${startRow};1H`;
      }
      for (let i = 0; i < newLines.length; i++) {
        if (i > 0) buffer2 += "\r\n";
        let line = newLines[i];
        if (!isImageLine(line) && visibleWidth(line) > width) {
          line = truncateToWidth(line, width);
        }
        buffer2 += line;
      }
      buffer2 += "\x1B[?2026l";
      this.terminal.write(buffer2);
      this.cursorRow = Math.max(0, newLines.length - 1);
      this.hardwareCursorRow = this.cursorRow;
      if (clear) {
        this.maxLinesRendered = newLines.length;
      } else {
        this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
      }
      this.previousViewportTop = getViewportTop(this.maxLinesRendered);
      this.positionHardwareCursor(cursorPos, newLines.length);
      this.previousLines = newLines;
      this.previousWidth = width;
      this.previousHeight = height;
    };
    const debugRedraw = process.env.PI_DEBUG_REDRAW === "1";
    const logRedraw = (reason) => {
      if (!debugRedraw) return;
      const logPath = path.join(os.homedir(), ".pi", "agent", "pi-debug.log");
      const msg = `[${(/* @__PURE__ */ new Date()).toISOString()}] fullRender: ${reason} (prev=${this.previousLines.length}, new=${newLines.length}, height=${height})
`;
      fs.appendFileSync(logPath, msg);
    };
    if (this.previousLines.length === 0 && !widthChanged && !heightChanged) {
      logRedraw("first render");
      fullRender(false);
      return;
    }
    if (widthChanged || heightChanged) {
      logRedraw(`terminal size changed (${this.previousWidth}x${this.previousHeight} -> ${width}x${height})`);
      fullRender(true);
      return;
    }
    if (newLines.length !== this.previousLines.length && (newLines.length <= height || this.previousLines.length <= height)) {
      logRedraw(`bottom-anchored short block resized (${this.previousLines.length} -> ${newLines.length})`);
      fullRender(true);
      return;
    }
    if (newLines.length < this.previousLines.length && newLines.length > height) {
      logRedraw(`bottom-anchored tall block shrunk (${this.previousLines.length} -> ${newLines.length})`);
      fullRender(true);
      return;
    }
    if (this.clearOnShrink && newLines.length < this.maxLinesRendered && this.overlayStack.length === 0) {
      if (!this._shrinkDebounceActive) {
        this._shrinkDebounceActive = true;
        logRedraw(`clearOnShrink deferred (maxLinesRendered=${this.maxLinesRendered})`);
      } else {
        this._shrinkDebounceActive = false;
        logRedraw(`clearOnShrink committed (maxLinesRendered=${this.maxLinesRendered})`);
        fullRender(true);
        return;
      }
    } else {
      this._shrinkDebounceActive = false;
    }
    let firstChanged = -1;
    let lastChanged = -1;
    const maxLines = Math.max(newLines.length, this.previousLines.length);
    for (let i = 0; i < maxLines; i++) {
      const oldLine = i < this.previousLines.length ? this.previousLines[i] : "";
      const newLine = i < newLines.length ? newLines[i] : "";
      if (oldLine !== newLine) {
        if (firstChanged === -1) {
          firstChanged = i;
        }
        lastChanged = i;
      }
    }
    const appendedLines = newLines.length > this.previousLines.length;
    if (appendedLines) {
      if (firstChanged === -1) {
        firstChanged = this.previousLines.length;
      }
      lastChanged = newLines.length - 1;
    }
    const appendStart = appendedLines && firstChanged === this.previousLines.length && firstChanged > 0;
    if (firstChanged === -1) {
      this.positionHardwareCursor(cursorPos, newLines.length);
      this.previousViewportTop = getViewportTop(this.maxLinesRendered);
      this.previousHeight = height;
      return;
    }
    if (firstChanged >= newLines.length) {
      if (this.previousLines.length > newLines.length) {
        let buffer2 = "\x1B[?2026h";
        const targetRow = Math.max(0, newLines.length - 1);
        const lineDiff2 = computeLineDiff(targetRow);
        if (lineDiff2 > 0) buffer2 += `\x1B[${lineDiff2}B`;
        else if (lineDiff2 < 0) buffer2 += `\x1B[${-lineDiff2}A`;
        buffer2 += "\r";
        const extraLines = this.previousLines.length - newLines.length;
        if (extraLines > height) {
          logRedraw(`extraLines > height (${extraLines} > ${height})`);
          fullRender(true);
          return;
        }
        if (extraLines > 0) {
          buffer2 += "\x1B[1B";
        }
        for (let i = 0; i < extraLines; i++) {
          buffer2 += "\r\x1B[2K";
          if (i < extraLines - 1) buffer2 += "\x1B[1B";
        }
        if (extraLines > 0) {
          buffer2 += `\x1B[${extraLines}A`;
        }
        buffer2 += "\x1B[?2026l";
        this.terminal.write(buffer2);
        this.cursorRow = targetRow;
        this.hardwareCursorRow = targetRow;
      }
      this.positionHardwareCursor(cursorPos, newLines.length);
      this.previousLines = newLines;
      this.previousWidth = width;
      this.previousHeight = height;
      this.previousViewportTop = getViewportTop(this.maxLinesRendered);
      return;
    }
    const previousContentViewportTop = getViewportTop(this.previousLines.length);
    if (firstChanged < previousContentViewportTop) {
      logRedraw(`firstChanged < viewportTop (${firstChanged} < ${previousContentViewportTop})`);
      fullRender(true);
      return;
    }
    let buffer = "\x1B[?2026h";
    const prevViewportBottom = prevViewportTop + height - 1;
    const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged;
    if (moveTargetRow > prevViewportBottom) {
      const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - prevViewportTop));
      const moveToBottom = height - 1 - currentScreenRow;
      if (moveToBottom > 0) {
        buffer += `\x1B[${moveToBottom}B`;
      }
      const scroll = moveTargetRow - prevViewportBottom;
      buffer += "\r\n".repeat(scroll);
      prevViewportTop += scroll;
      viewportTop += scroll;
      hardwareCursorRow = moveTargetRow;
    }
    const lineDiff = computeLineDiff(moveTargetRow);
    if (lineDiff > 0) {
      buffer += `\x1B[${lineDiff}B`;
    } else if (lineDiff < 0) {
      buffer += `\x1B[${-lineDiff}A`;
    }
    buffer += appendStart ? "\r\n" : "\r";
    const renderEnd = Math.min(lastChanged, newLines.length - 1);
    for (let i = firstChanged; i <= renderEnd; i++) {
      if (i > firstChanged) buffer += "\r\n";
      buffer += "\x1B[2K";
      let line = newLines[i];
      const isImage = isImageLine(line);
      if (!isImage && visibleWidth(line) > width) {
        line = truncateToWidth(line, width);
      }
      buffer += line;
    }
    let finalCursorRow = renderEnd;
    if (this.previousLines.length > newLines.length) {
      if (renderEnd < newLines.length - 1) {
        const moveDown = newLines.length - 1 - renderEnd;
        buffer += `\x1B[${moveDown}B`;
        finalCursorRow = newLines.length - 1;
      }
      const extraLines = this.previousLines.length - newLines.length;
      for (let i = newLines.length; i < this.previousLines.length; i++) {
        buffer += "\r\n\x1B[2K";
      }
      buffer += `\x1B[${extraLines}A`;
    }
    buffer += "\x1B[?2026l";
    if (process.env.PI_TUI_DEBUG === "1") {
      const debugDir = path.join(os.tmpdir(), "tui");
      fs.mkdirSync(debugDir, { recursive: true });
      const debugPath = path.join(debugDir, `render-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
      const debugData = [
        `firstChanged: ${firstChanged}`,
        `viewportTop: ${viewportTop}`,
        `cursorRow: ${this.cursorRow}`,
        `height: ${height}`,
        `lineDiff: ${lineDiff}`,
        `hardwareCursorRow: ${hardwareCursorRow}`,
        `renderEnd: ${renderEnd}`,
        `finalCursorRow: ${finalCursorRow}`,
        `cursorPos: ${JSON.stringify(cursorPos)}`,
        `newLines.length: ${newLines.length}`,
        `previousLines.length: ${this.previousLines.length}`,
        "",
        "=== newLines ===",
        JSON.stringify(newLines, null, 2),
        "",
        "=== previousLines ===",
        JSON.stringify(this.previousLines, null, 2),
        "",
        "=== buffer ===",
        JSON.stringify(buffer)
      ].join("\n");
      fs.writeFileSync(debugPath, debugData);
    }
    this.terminal.write(buffer);
    this.cursorRow = Math.max(0, newLines.length - 1);
    this.hardwareCursorRow = finalCursorRow;
    this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
    this.previousViewportTop = getViewportTop(this.maxLinesRendered);
    this.positionHardwareCursor(cursorPos, newLines.length);
    this.previousLines = newLines;
    this.previousWidth = width;
    this.previousHeight = height;
  }
  /**
   * Position the hardware cursor for IME candidate window.
   * @param cursorPos The cursor position extracted from rendered output, or null
   * @param totalLines Total number of rendered lines
   */
  positionHardwareCursor(cursorPos, totalLines) {
    if (!cursorPos || totalLines <= 0) {
      this.terminal.hideCursor();
      return;
    }
    const targetRow = Math.max(0, Math.min(cursorPos.row, totalLines - 1));
    const targetCol = Math.max(0, cursorPos.col);
    const rowDelta = targetRow - this.hardwareCursorRow;
    let buffer = "";
    if (rowDelta > 0) {
      buffer += `\x1B[${rowDelta}B`;
    } else if (rowDelta < 0) {
      buffer += `\x1B[${-rowDelta}A`;
    }
    buffer += `\x1B[${targetCol + 1}G`;
    if (buffer) {
      this.terminal.write(buffer);
    }
    this.hardwareCursorRow = targetRow;
    if (this.showHardwareCursor) {
      this.terminal.showCursor();
    } else {
      this.terminal.hideCursor();
    }
  }
}
export {
  CURSOR_MARKER,
  Container,
  TUI,
  isFocusable,
  visibleWidth
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktdHVpL3NyYy90dWkudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRC0yICsgcGFja2FnZXMvcGktdHVpL3NyYy90dWkudHMgLSBUZXJtaW5hbCBVSSByZW5kZXJlciB3aXRoIGRpZmZlcmVudGlhbCByZW5kZXJpbmcuXG4vKipcbiAqIE1pbmltYWwgVFVJIGltcGxlbWVudGF0aW9uIHdpdGggZGlmZmVyZW50aWFsIHJlbmRlcmluZ1xuICovXG5cbmltcG9ydCAqIGFzIGZzIGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgKiBhcyBvcyBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBpc0tleVJlbGVhc2UsIG1hdGNoZXNLZXkgfSBmcm9tIFwiLi9rZXlzLmpzXCI7XG5pbXBvcnQge1xuXHRhcHBseUxpbmVSZXNldHMsXG5cdGNvbXBvc2l0ZU92ZXJsYXlzLFxuXHRleHRyYWN0Q3Vyc29yUG9zaXRpb24sXG5cdGlzT3ZlcmxheVZpc2libGUgYXMgaXNPdmVybGF5RW50cnlWaXNpYmxlLFxufSBmcm9tIFwiLi9vdmVybGF5LWxheW91dC5qc1wiO1xuaW1wb3J0IHR5cGUgeyBUZXJtaW5hbCB9IGZyb20gXCIuL3Rlcm1pbmFsLmpzXCI7XG5pbXBvcnQgeyBnZXRDYXBhYmlsaXRpZXMsIGlzSW1hZ2VMaW5lLCBzZXRDZWxsRGltZW5zaW9ucyB9IGZyb20gXCIuL3Rlcm1pbmFsLWltYWdlLmpzXCI7XG5pbXBvcnQgeyB0cnVuY2F0ZVRvV2lkdGgsIHZpc2libGVXaWR0aCB9IGZyb20gXCIuL3V0aWxzLmpzXCI7XG5cbi8qKlxuICogQ29tcG9uZW50IGludGVyZmFjZSAtIGFsbCBjb21wb25lbnRzIG11c3QgaW1wbGVtZW50IHRoaXNcbiAqL1xuZXhwb3J0IGludGVyZmFjZSBDb21wb25lbnQge1xuXHQvKipcblx0ICogUmVuZGVyIHRoZSBjb21wb25lbnQgdG8gbGluZXMgZm9yIHRoZSBnaXZlbiB2aWV3cG9ydCB3aWR0aFxuXHQgKiBAcGFyYW0gd2lkdGggLSBDdXJyZW50IHZpZXdwb3J0IHdpZHRoXG5cdCAqIEByZXR1cm5zIEFycmF5IG9mIHN0cmluZ3MsIGVhY2ggcmVwcmVzZW50aW5nIGEgbGluZVxuXHQgKi9cblx0cmVuZGVyKHdpZHRoOiBudW1iZXIpOiBzdHJpbmdbXTtcblxuXHQvKipcblx0ICogT3B0aW9uYWwgaGFuZGxlciBmb3Iga2V5Ym9hcmQgaW5wdXQgd2hlbiBjb21wb25lbnQgaGFzIGZvY3VzXG5cdCAqL1xuXHRoYW5kbGVJbnB1dD8oZGF0YTogc3RyaW5nKTogdm9pZDtcblxuXHQvKipcblx0ICogSWYgdHJ1ZSwgY29tcG9uZW50IHJlY2VpdmVzIGtleSByZWxlYXNlIGV2ZW50cyAoS2l0dHkgcHJvdG9jb2wpLlxuXHQgKiBEZWZhdWx0IGlzIGZhbHNlIC0gcmVsZWFzZSBldmVudHMgYXJlIGZpbHRlcmVkIG91dC5cblx0ICovXG5cdHdhbnRzS2V5UmVsZWFzZT86IGJvb2xlYW47XG5cblx0LyoqXG5cdCAqIEludmFsaWRhdGUgYW55IGNhY2hlZCByZW5kZXJpbmcgc3RhdGUuXG5cdCAqIENhbGxlZCB3aGVuIHRoZW1lIGNoYW5nZXMgb3Igd2hlbiBjb21wb25lbnQgbmVlZHMgdG8gcmUtcmVuZGVyIGZyb20gc2NyYXRjaC5cblx0ICovXG5cdGludmFsaWRhdGUoKTogdm9pZDtcbn1cblxudHlwZSBJbnB1dExpc3RlbmVyUmVzdWx0ID0geyBjb25zdW1lPzogYm9vbGVhbjsgZGF0YT86IHN0cmluZyB9IHwgdW5kZWZpbmVkO1xudHlwZSBJbnB1dExpc3RlbmVyID0gKGRhdGE6IHN0cmluZykgPT4gSW5wdXRMaXN0ZW5lclJlc3VsdDtcblxuLyoqXG4gKiBJbnRlcmZhY2UgZm9yIGNvbXBvbmVudHMgdGhhdCBjYW4gcmVjZWl2ZSBmb2N1cyBhbmQgZGlzcGxheSBhIGhhcmR3YXJlIGN1cnNvci5cbiAqIFdoZW4gZm9jdXNlZCwgdGhlIGNvbXBvbmVudCBzaG91bGQgZW1pdCBDVVJTT1JfTUFSS0VSIGF0IHRoZSBjdXJzb3IgcG9zaXRpb25cbiAqIGluIGl0cyByZW5kZXIgb3V0cHV0LiBUVUkgd2lsbCBmaW5kIHRoaXMgbWFya2VyIGFuZCBwb3NpdGlvbiB0aGUgaGFyZHdhcmVcbiAqIGN1cnNvciB0aGVyZSBmb3IgcHJvcGVyIElNRSBjYW5kaWRhdGUgd2luZG93IHBvc2l0aW9uaW5nLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEZvY3VzYWJsZSB7XG5cdC8qKiBTZXQgYnkgVFVJIHdoZW4gZm9jdXMgY2hhbmdlcy4gQ29tcG9uZW50IHNob3VsZCBlbWl0IENVUlNPUl9NQVJLRVIgd2hlbiB0cnVlLiAqL1xuXHRmb2N1c2VkOiBib29sZWFuO1xufVxuXG4vKiogVHlwZSBndWFyZCB0byBjaGVjayBpZiBhIGNvbXBvbmVudCBpbXBsZW1lbnRzIEZvY3VzYWJsZSAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzRm9jdXNhYmxlKGNvbXBvbmVudDogQ29tcG9uZW50IHwgbnVsbCk6IGNvbXBvbmVudCBpcyBDb21wb25lbnQgJiBGb2N1c2FibGUge1xuXHRyZXR1cm4gY29tcG9uZW50ICE9PSBudWxsICYmIFwiZm9jdXNlZFwiIGluIGNvbXBvbmVudDtcbn1cblxuLyoqXG4gKiBDdXJzb3IgcG9zaXRpb24gbWFya2VyIC0gQVBDIChBcHBsaWNhdGlvbiBQcm9ncmFtIENvbW1hbmQpIHNlcXVlbmNlLlxuICogVGhpcyBpcyBhIHplcm8td2lkdGggZXNjYXBlIHNlcXVlbmNlIHRoYXQgdGVybWluYWxzIGlnbm9yZS5cbiAqIENvbXBvbmVudHMgZW1pdCB0aGlzIGF0IHRoZSBjdXJzb3IgcG9zaXRpb24gd2hlbiBmb2N1c2VkLlxuICogVFVJIGZpbmRzIGFuZCBzdHJpcHMgdGhpcyBtYXJrZXIsIHRoZW4gcG9zaXRpb25zIHRoZSBoYXJkd2FyZSBjdXJzb3IgdGhlcmUuXG4gKi9cbmV4cG9ydCBjb25zdCBDVVJTT1JfTUFSS0VSID0gXCJcXHgxYl9waTpjXFx4MDdcIjtcblxuZXhwb3J0IHsgdmlzaWJsZVdpZHRoIH07XG5cbi8qKlxuICogQW5jaG9yIHBvc2l0aW9uIGZvciBvdmVybGF5c1xuICovXG5leHBvcnQgdHlwZSBPdmVybGF5QW5jaG9yID1cblx0fCBcImNlbnRlclwiXG5cdHwgXCJ0b3AtbGVmdFwiXG5cdHwgXCJ0b3AtcmlnaHRcIlxuXHR8IFwiYm90dG9tLWxlZnRcIlxuXHR8IFwiYm90dG9tLXJpZ2h0XCJcblx0fCBcInRvcC1jZW50ZXJcIlxuXHR8IFwiYm90dG9tLWNlbnRlclwiXG5cdHwgXCJsZWZ0LWNlbnRlclwiXG5cdHwgXCJyaWdodC1jZW50ZXJcIjtcblxuLyoqXG4gKiBNYXJnaW4gY29uZmlndXJhdGlvbiBmb3Igb3ZlcmxheXNcbiAqL1xuZXhwb3J0IGludGVyZmFjZSBPdmVybGF5TWFyZ2luIHtcblx0dG9wPzogbnVtYmVyO1xuXHRyaWdodD86IG51bWJlcjtcblx0Ym90dG9tPzogbnVtYmVyO1xuXHRsZWZ0PzogbnVtYmVyO1xufVxuXG4vKiogVmFsdWUgdGhhdCBjYW4gYmUgYWJzb2x1dGUgKG51bWJlcikgb3IgcGVyY2VudGFnZSAoc3RyaW5nIGxpa2UgXCI1MCVcIikgKi9cbmV4cG9ydCB0eXBlIFNpemVWYWx1ZSA9IG51bWJlciB8IGAke251bWJlcn0lYDtcblxuLyoqXG4gKiBPcHRpb25zIGZvciBvdmVybGF5IHBvc2l0aW9uaW5nIGFuZCBzaXppbmcuXG4gKiBWYWx1ZXMgY2FuIGJlIGFic29sdXRlIG51bWJlcnMgb3IgcGVyY2VudGFnZSBzdHJpbmdzIChlLmcuLCBcIjUwJVwiKS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBPdmVybGF5T3B0aW9ucyB7XG5cdC8vID09PSBTaXppbmcgPT09XG5cdC8qKiBXaWR0aCBpbiBjb2x1bW5zLCBvciBwZXJjZW50YWdlIG9mIHRlcm1pbmFsIHdpZHRoIChlLmcuLCBcIjUwJVwiKSAqL1xuXHR3aWR0aD86IFNpemVWYWx1ZTtcblx0LyoqIE1pbmltdW0gd2lkdGggaW4gY29sdW1ucyAqL1xuXHRtaW5XaWR0aD86IG51bWJlcjtcblx0LyoqIE1heGltdW0gaGVpZ2h0IGluIHJvd3MsIG9yIHBlcmNlbnRhZ2Ugb2YgdGVybWluYWwgaGVpZ2h0IChlLmcuLCBcIjUwJVwiKSAqL1xuXHRtYXhIZWlnaHQ/OiBTaXplVmFsdWU7XG5cblx0Ly8gPT09IFBvc2l0aW9uaW5nIC0gYW5jaG9yLWJhc2VkID09PVxuXHQvKiogQW5jaG9yIHBvaW50IGZvciBwb3NpdGlvbmluZyAoZGVmYXVsdDogJ2NlbnRlcicpICovXG5cdGFuY2hvcj86IE92ZXJsYXlBbmNob3I7XG5cdC8qKiBIb3Jpem9udGFsIG9mZnNldCBmcm9tIGFuY2hvciBwb3NpdGlvbiAocG9zaXRpdmUgPSByaWdodCkgKi9cblx0b2Zmc2V0WD86IG51bWJlcjtcblx0LyoqIFZlcnRpY2FsIG9mZnNldCBmcm9tIGFuY2hvciBwb3NpdGlvbiAocG9zaXRpdmUgPSBkb3duKSAqL1xuXHRvZmZzZXRZPzogbnVtYmVyO1xuXG5cdC8vID09PSBQb3NpdGlvbmluZyAtIHBlcmNlbnRhZ2Ugb3IgYWJzb2x1dGUgPT09XG5cdC8qKiBSb3cgcG9zaXRpb246IGFic29sdXRlIG51bWJlciwgb3IgcGVyY2VudGFnZSAoZS5nLiwgXCIyNSVcIiA9IDI1JSBmcm9tIHRvcCkgKi9cblx0cm93PzogU2l6ZVZhbHVlO1xuXHQvKiogQ29sdW1uIHBvc2l0aW9uOiBhYnNvbHV0ZSBudW1iZXIsIG9yIHBlcmNlbnRhZ2UgKGUuZy4sIFwiNTAlXCIgPSBjZW50ZXJlZCBob3Jpem9udGFsbHkpICovXG5cdGNvbD86IFNpemVWYWx1ZTtcblxuXHQvLyA9PT0gTWFyZ2luIGZyb20gdGVybWluYWwgZWRnZXMgPT09XG5cdC8qKiBNYXJnaW4gZnJvbSB0ZXJtaW5hbCBlZGdlcy4gTnVtYmVyIGFwcGxpZXMgdG8gYWxsIHNpZGVzLiAqL1xuXHRtYXJnaW4/OiBPdmVybGF5TWFyZ2luIHwgbnVtYmVyO1xuXG5cdC8vID09PSBWaXNpYmlsaXR5ID09PVxuXHQvKipcblx0ICogQ29udHJvbCBvdmVybGF5IHZpc2liaWxpdHkgYmFzZWQgb24gdGVybWluYWwgZGltZW5zaW9ucy5cblx0ICogSWYgcHJvdmlkZWQsIG92ZXJsYXkgaXMgb25seSByZW5kZXJlZCB3aGVuIHRoaXMgcmV0dXJucyB0cnVlLlxuXHQgKiBDYWxsZWQgZWFjaCByZW5kZXIgY3ljbGUgd2l0aCBjdXJyZW50IHRlcm1pbmFsIGRpbWVuc2lvbnMuXG5cdCAqL1xuXHR2aXNpYmxlPzogKHRlcm1XaWR0aDogbnVtYmVyLCB0ZXJtSGVpZ2h0OiBudW1iZXIpID0+IGJvb2xlYW47XG5cdC8qKiBJZiB0cnVlLCBkb24ndCBjYXB0dXJlIGtleWJvYXJkIGZvY3VzIHdoZW4gc2hvd24gKi9cblx0bm9uQ2FwdHVyaW5nPzogYm9vbGVhbjtcblx0LyoqIElmIHRydWUsIGRpbSB0aGUgYmFja2dyb3VuZCBiZWhpbmQgdGhlIG92ZXJsYXkgKi9cblx0YmFja2Ryb3A/OiBib29sZWFuO1xufVxuXG4vKipcbiAqIEhhbmRsZSByZXR1cm5lZCBieSBzaG93T3ZlcmxheSBmb3IgY29udHJvbGxpbmcgdGhlIG92ZXJsYXlcbiAqL1xuZXhwb3J0IGludGVyZmFjZSBPdmVybGF5SGFuZGxlIHtcblx0LyoqIFBlcm1hbmVudGx5IHJlbW92ZSB0aGUgb3ZlcmxheSAoY2Fubm90IGJlIHNob3duIGFnYWluKSAqL1xuXHRoaWRlKCk6IHZvaWQ7XG5cdC8qKiBUZW1wb3JhcmlseSBoaWRlIG9yIHNob3cgdGhlIG92ZXJsYXkgKi9cblx0c2V0SGlkZGVuKGhpZGRlbjogYm9vbGVhbik6IHZvaWQ7XG5cdC8qKiBDaGVjayBpZiBvdmVybGF5IGlzIHRlbXBvcmFyaWx5IGhpZGRlbiAqL1xuXHRpc0hpZGRlbigpOiBib29sZWFuO1xuXHQvKiogRm9jdXMgdGhpcyBvdmVybGF5IGFuZCBicmluZyBpdCB0byB0aGUgdmlzdWFsIGZyb250ICovXG5cdGZvY3VzKCk6IHZvaWQ7XG5cdC8qKiBSZWxlYXNlIGZvY3VzIHRvIHRoZSBwcmV2aW91cyB0YXJnZXQgKi9cblx0dW5mb2N1cygpOiB2b2lkO1xuXHQvKiogQ2hlY2sgaWYgdGhpcyBvdmVybGF5IGN1cnJlbnRseSBoYXMgZm9jdXMgKi9cblx0aXNGb2N1c2VkKCk6IGJvb2xlYW47XG59XG5cbi8qKlxuICogQ29udGFpbmVyIC0gYSBjb21wb25lbnQgdGhhdCBjb250YWlucyBvdGhlciBjb21wb25lbnRzXG4gKi9cbmV4cG9ydCBjbGFzcyBDb250YWluZXIgaW1wbGVtZW50cyBDb21wb25lbnQge1xuXHRjaGlsZHJlbjogQ29tcG9uZW50W10gPSBbXTtcblx0cHJpdmF0ZSBfcHJldlJlbmRlcjogc3RyaW5nW10gfCBudWxsID0gbnVsbDtcblxuXHRhZGRDaGlsZChjb21wb25lbnQ6IENvbXBvbmVudCk6IHZvaWQge1xuXHRcdHRoaXMuY2hpbGRyZW4ucHVzaChjb21wb25lbnQpO1xuXHRcdHRoaXMuX3ByZXZSZW5kZXIgPSBudWxsO1xuXHR9XG5cblx0cmVtb3ZlQ2hpbGQoY29tcG9uZW50OiBDb21wb25lbnQpOiB2b2lkIHtcblx0XHRjb25zdCBpbmRleCA9IHRoaXMuY2hpbGRyZW4uaW5kZXhPZihjb21wb25lbnQpO1xuXHRcdGlmIChpbmRleCAhPT0gLTEpIHtcblx0XHRcdGNvbnN0IGNoaWxkID0gdGhpcy5jaGlsZHJlbltpbmRleF07XG5cdFx0XHR0aGlzLmNoaWxkcmVuLnNwbGljZShpbmRleCwgMSk7XG5cdFx0XHRpZiAoJ2Rpc3Bvc2UnIGluIGNoaWxkICYmIHR5cGVvZiAoY2hpbGQgYXMgYW55KS5kaXNwb3NlID09PSAnZnVuY3Rpb24nKSB7XG5cdFx0XHRcdChjaGlsZCBhcyBhbnkpLmRpc3Bvc2UoKTtcblx0XHRcdH1cblx0XHRcdHRoaXMuX3ByZXZSZW5kZXIgPSBudWxsO1xuXHRcdH1cblx0fVxuXG5cdGNsZWFyKCk6IHZvaWQge1xuXHRcdGZvciAoY29uc3QgY2hpbGQgb2YgdGhpcy5jaGlsZHJlbikge1xuXHRcdFx0aWYgKCdkaXNwb3NlJyBpbiBjaGlsZCAmJiB0eXBlb2YgKGNoaWxkIGFzIGFueSkuZGlzcG9zZSA9PT0gJ2Z1bmN0aW9uJykge1xuXHRcdFx0XHQoY2hpbGQgYXMgYW55KS5kaXNwb3NlKCk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdHRoaXMuY2hpbGRyZW4gPSBbXTtcblx0XHR0aGlzLl9wcmV2UmVuZGVyID0gbnVsbDtcblx0fVxuXG5cdC8qKlxuXHQgKiBSZW1vdmUgYWxsIGNoaWxkcmVuIHdpdGhvdXQgY2FsbGluZyBkaXNwb3NlIG9uIHRoZW0uXG5cdCAqIFVzZSB3aGVuIGNoaWxkIGxpZmVjeWNsZSBpcyBvd25lZCBlbHNld2hlcmUgYW5kIHRoZSBjb250YWluZXIgaXMgb25seSBhXG5cdCAqIHJlbmRlciBtb3VudCAoZS5nLiBleHRlbnNpb24gd2lkZ2V0IGNvbnRhaW5lcnMgaW4gSW50ZXJhY3RpdmVNb2RlLCB3aGVyZVxuXHQgKiB0aGUgZXh0ZW5zaW9uV2lkZ2V0cyogbWFwcyBvd24gZGlzcG9zYWwpLlxuXHQgKi9cblx0ZGV0YWNoQ2hpbGRyZW4oKTogdm9pZCB7XG5cdFx0dGhpcy5jaGlsZHJlbiA9IFtdO1xuXHRcdHRoaXMuX3ByZXZSZW5kZXIgPSBudWxsO1xuXHR9XG5cblx0aW52YWxpZGF0ZSgpOiB2b2lkIHtcblx0XHRmb3IgKGNvbnN0IGNoaWxkIG9mIHRoaXMuY2hpbGRyZW4pIHtcblx0XHRcdGNoaWxkLmludmFsaWRhdGU/LigpO1xuXHRcdH1cblx0fVxuXG5cdHJlbmRlcih3aWR0aDogbnVtYmVyKTogc3RyaW5nW10ge1xuXHRcdGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuXHRcdGZvciAoY29uc3QgY2hpbGQgb2YgdGhpcy5jaGlsZHJlbikge1xuXHRcdFx0Y29uc3QgcmVuZGVyZWQgPSBjaGlsZC5yZW5kZXIod2lkdGgpO1xuXHRcdFx0Zm9yIChsZXQgaSA9IDA7IGkgPCByZW5kZXJlZC5sZW5ndGg7IGkrKykgbGluZXMucHVzaChyZW5kZXJlZFtpXSk7XG5cdFx0fVxuXHRcdC8vIFJldHVybiBzdGFibGUgcmVmZXJlbmNlIGlmIG91dHB1dCB1bmNoYW5nZWQgXHUyMDE0IGFsbG93cyBkb1JlbmRlcigpXG5cdFx0Ly8gdG8gc2tpcCBBTEwgcG9zdC1wcm9jZXNzaW5nIChpc0ltYWdlTGluZSwgYXBwbHlMaW5lUmVzZXRzLCBkaWZmcylcblx0XHRjb25zdCBwcmV2ID0gdGhpcy5fcHJldlJlbmRlcjtcblx0XHRpZiAocHJldiAmJiBwcmV2Lmxlbmd0aCA9PT0gbGluZXMubGVuZ3RoKSB7XG5cdFx0XHRsZXQgc2FtZSA9IHRydWU7XG5cdFx0XHRmb3IgKGxldCBpID0gMDsgaSA8IGxpbmVzLmxlbmd0aDsgaSsrKSB7XG5cdFx0XHRcdGlmIChsaW5lc1tpXSAhPT0gcHJldltpXSkgeyBzYW1lID0gZmFsc2U7IGJyZWFrOyB9XG5cdFx0XHR9XG5cdFx0XHRpZiAoc2FtZSkgcmV0dXJuIHByZXY7XG5cdFx0fVxuXHRcdHRoaXMuX3ByZXZSZW5kZXIgPSBsaW5lcztcblx0XHRyZXR1cm4gbGluZXM7XG5cdH1cbn1cblxuLyoqXG4gKiBUVUkgLSBNYWluIGNsYXNzIGZvciBtYW5hZ2luZyB0ZXJtaW5hbCBVSSB3aXRoIGRpZmZlcmVudGlhbCByZW5kZXJpbmdcbiAqL1xuZXhwb3J0IGNsYXNzIFRVSSBleHRlbmRzIENvbnRhaW5lciB7XG5cdHB1YmxpYyB0ZXJtaW5hbDogVGVybWluYWw7XG5cdHByaXZhdGUgcHJldmlvdXNMaW5lczogc3RyaW5nW10gPSBbXTtcblx0cHJpdmF0ZSBwcmV2aW91c1dpZHRoID0gMDtcblx0cHJpdmF0ZSBwcmV2aW91c0hlaWdodCA9IDA7XG5cdHByaXZhdGUgZm9jdXNlZENvbXBvbmVudDogQ29tcG9uZW50IHwgbnVsbCA9IG51bGw7XG5cdHByaXZhdGUgaW5wdXRMaXN0ZW5lcnMgPSBuZXcgU2V0PElucHV0TGlzdGVuZXI+KCk7XG5cblx0LyoqIEdsb2JhbCBjYWxsYmFjayBmb3IgZGVidWcga2V5IChTaGlmdCtDdHJsK0QpLiBDYWxsZWQgYmVmb3JlIGlucHV0IGlzIGZvcndhcmRlZCB0byBmb2N1c2VkIGNvbXBvbmVudC4gKi9cblx0cHVibGljIG9uRGVidWc/OiAoKSA9PiB2b2lkO1xuXHRwcml2YXRlIHJlbmRlclJlcXVlc3RlZCA9IGZhbHNlO1xuXHRwcml2YXRlIGN1cnNvclJvdyA9IDA7IC8vIExvZ2ljYWwgY3Vyc29yIHJvdyAoZW5kIG9mIHJlbmRlcmVkIGNvbnRlbnQpXG5cdHByaXZhdGUgaGFyZHdhcmVDdXJzb3JSb3cgPSAwOyAvLyBMb2dpY2FsIGNvbnRlbnQgcm93IG9mIHRoZSB0ZXJtaW5hbCBjdXJzb3I7IHBoeXNpY2FsIHNjcmVlbiByb3cgPSBoYXJkd2FyZUN1cnNvclJvdyAtIHByZXZpb3VzVmlld3BvcnRUb3Bcblx0cHJpdmF0ZSBpbnB1dEJ1ZmZlciA9IFwiXCI7IC8vIEJ1ZmZlciBmb3IgcGFyc2luZyB0ZXJtaW5hbCByZXNwb25zZXNcblx0cHJpdmF0ZSBjZWxsU2l6ZVF1ZXJ5UGVuZGluZyA9IGZhbHNlO1xuXHRwcml2YXRlIHNob3dIYXJkd2FyZUN1cnNvciA9IHByb2Nlc3MuZW52LlBJX0hBUkRXQVJFX0NVUlNPUiA9PT0gXCIxXCIgfHwgcHJvY2Vzcy5lbnYuVEVSTV9QUk9HUkFNID09PSBcIldhcnBUZXJtaW5hbFwiO1xuXHRwcml2YXRlIGNsZWFyT25TaHJpbmsgPSBwcm9jZXNzLmVudi5QSV9DTEVBUl9PTl9TSFJJTksgPT09IFwiMVwiOyAvLyBDbGVhciBlbXB0eSByb3dzIHdoZW4gY29udGVudCBzaHJpbmtzIChkZWZhdWx0OiBvZmYpXG5cdHByaXZhdGUgX3Nocmlua0RlYm91bmNlQWN0aXZlID0gZmFsc2U7XG5cdHByaXZhdGUgbWF4TGluZXNSZW5kZXJlZCA9IDA7IC8vIFRyYWNrIHRlcm1pbmFsJ3Mgd29ya2luZyBhcmVhIChtYXggbGluZXMgZXZlciByZW5kZXJlZClcblx0cHJpdmF0ZSBwcmV2aW91c1ZpZXdwb3J0VG9wID0gMDsgLy8gVHJhY2sgcHJldmlvdXMgdmlld3BvcnQgdG9wIGZvciByZXNpemUtYXdhcmUgY3Vyc29yIG1vdmVzXG5cdHByaXZhdGUgZnVsbFJlZHJhd0NvdW50ID0gMDtcblx0cHJpdmF0ZSBzdG9wcGVkID0gZmFsc2U7XG5cdHByaXZhdGUgX2xhc3RSZW5kZXJlZENvbXBvbmVudHM6IHN0cmluZ1tdIHwgbnVsbCA9IG51bGw7XG5cblx0Ly8gT3ZlcmxheSBzdGFjayBmb3IgbW9kYWwgY29tcG9uZW50cyByZW5kZXJlZCBvbiB0b3Agb2YgYmFzZSBjb250ZW50XG5cdHByaXZhdGUgZm9jdXNPcmRlckNvdW50ZXIgPSAwO1xuXHRwcml2YXRlIG92ZXJsYXlTdGFjazoge1xuXHRcdGNvbXBvbmVudDogQ29tcG9uZW50O1xuXHRcdG9wdGlvbnM/OiBPdmVybGF5T3B0aW9ucztcblx0XHRwcmVGb2N1czogQ29tcG9uZW50IHwgbnVsbDtcblx0XHRoaWRkZW46IGJvb2xlYW47XG5cdFx0Zm9jdXNPcmRlcjogbnVtYmVyO1xuXHR9W10gPSBbXTtcblxuXHRjb25zdHJ1Y3Rvcih0ZXJtaW5hbDogVGVybWluYWwsIHNob3dIYXJkd2FyZUN1cnNvcj86IGJvb2xlYW4pIHtcblx0XHRzdXBlcigpO1xuXHRcdHRoaXMudGVybWluYWwgPSB0ZXJtaW5hbDtcblx0XHRpZiAoc2hvd0hhcmR3YXJlQ3Vyc29yICE9PSB1bmRlZmluZWQpIHtcblx0XHRcdHRoaXMuc2hvd0hhcmR3YXJlQ3Vyc29yID0gc2hvd0hhcmR3YXJlQ3Vyc29yO1xuXHRcdH1cblx0fVxuXG5cdGdldCBmdWxsUmVkcmF3cygpOiBudW1iZXIge1xuXHRcdHJldHVybiB0aGlzLmZ1bGxSZWRyYXdDb3VudDtcblx0fVxuXG5cdGdldFNob3dIYXJkd2FyZUN1cnNvcigpOiBib29sZWFuIHtcblx0XHRyZXR1cm4gdGhpcy5zaG93SGFyZHdhcmVDdXJzb3I7XG5cdH1cblxuXHRzZXRTaG93SGFyZHdhcmVDdXJzb3IoZW5hYmxlZDogYm9vbGVhbik6IHZvaWQge1xuXHRcdGlmICh0aGlzLnNob3dIYXJkd2FyZUN1cnNvciA9PT0gZW5hYmxlZCkgcmV0dXJuO1xuXHRcdHRoaXMuc2hvd0hhcmR3YXJlQ3Vyc29yID0gZW5hYmxlZDtcblx0XHRpZiAoIWVuYWJsZWQpIHtcblx0XHRcdHRoaXMudGVybWluYWwuaGlkZUN1cnNvcigpO1xuXHRcdH1cblx0XHR0aGlzLnJlcXVlc3RSZW5kZXIoKTtcblx0fVxuXG5cdGdldENsZWFyT25TaHJpbmsoKTogYm9vbGVhbiB7XG5cdFx0cmV0dXJuIHRoaXMuY2xlYXJPblNocmluaztcblx0fVxuXG5cdC8qKlxuXHQgKiBTZXQgd2hldGhlciB0byB0cmlnZ2VyIGZ1bGwgcmUtcmVuZGVyIHdoZW4gY29udGVudCBzaHJpbmtzLlxuXHQgKiBXaGVuIHRydWUgKGRlZmF1bHQpLCBlbXB0eSByb3dzIGFyZSBjbGVhcmVkIHdoZW4gY29udGVudCBzaHJpbmtzLlxuXHQgKiBXaGVuIGZhbHNlLCBlbXB0eSByb3dzIHJlbWFpbiAocmVkdWNlcyByZWRyYXdzIG9uIHNsb3dlciB0ZXJtaW5hbHMpLlxuXHQgKi9cblx0c2V0Q2xlYXJPblNocmluayhlbmFibGVkOiBib29sZWFuKTogdm9pZCB7XG5cdFx0dGhpcy5jbGVhck9uU2hyaW5rID0gZW5hYmxlZDtcblx0fVxuXG5cdHNldEZvY3VzKGNvbXBvbmVudDogQ29tcG9uZW50IHwgbnVsbCk6IHZvaWQge1xuXHRcdC8vIENsZWFyIGZvY3VzZWQgZmxhZyBvbiBvbGQgY29tcG9uZW50XG5cdFx0aWYgKGlzRm9jdXNhYmxlKHRoaXMuZm9jdXNlZENvbXBvbmVudCkpIHtcblx0XHRcdHRoaXMuZm9jdXNlZENvbXBvbmVudC5mb2N1c2VkID0gZmFsc2U7XG5cdFx0fVxuXG5cdFx0dGhpcy5mb2N1c2VkQ29tcG9uZW50ID0gY29tcG9uZW50O1xuXG5cdFx0Ly8gU2V0IGZvY3VzZWQgZmxhZyBvbiBuZXcgY29tcG9uZW50XG5cdFx0aWYgKGlzRm9jdXNhYmxlKGNvbXBvbmVudCkpIHtcblx0XHRcdGNvbXBvbmVudC5mb2N1c2VkID0gdHJ1ZTtcblx0XHR9XG5cdH1cblxuXHQvKipcblx0ICogU2hvdyBhbiBvdmVybGF5IGNvbXBvbmVudCB3aXRoIGNvbmZpZ3VyYWJsZSBwb3NpdGlvbmluZyBhbmQgc2l6aW5nLlxuXHQgKiBSZXR1cm5zIGEgaGFuZGxlIHRvIGNvbnRyb2wgdGhlIG92ZXJsYXkncyB2aXNpYmlsaXR5LlxuXHQgKi9cblx0c2hvd092ZXJsYXkoY29tcG9uZW50OiBDb21wb25lbnQsIG9wdGlvbnM/OiBPdmVybGF5T3B0aW9ucyk6IE92ZXJsYXlIYW5kbGUge1xuXHRcdGNvbnN0IGVudHJ5ID0ge1xuXHRcdFx0Y29tcG9uZW50LFxuXHRcdFx0b3B0aW9ucyxcblx0XHRcdHByZUZvY3VzOiB0aGlzLmZvY3VzZWRDb21wb25lbnQsXG5cdFx0XHRoaWRkZW46IGZhbHNlLFxuXHRcdFx0Zm9jdXNPcmRlcjogKyt0aGlzLmZvY3VzT3JkZXJDb3VudGVyLFxuXHRcdH07XG5cdFx0dGhpcy5vdmVybGF5U3RhY2sucHVzaChlbnRyeSk7XG5cdFx0Ly8gT25seSBmb2N1cyBpZiBvdmVybGF5IGlzIGFjdHVhbGx5IHZpc2libGVcblx0XHRpZiAoIW9wdGlvbnM/Lm5vbkNhcHR1cmluZyAmJiB0aGlzLmlzT3ZlcmxheVZpc2libGUoZW50cnkpKSB7XG5cdFx0XHR0aGlzLnNldEZvY3VzKGNvbXBvbmVudCk7XG5cdFx0fVxuXHRcdHRoaXMudGVybWluYWwuaGlkZUN1cnNvcigpO1xuXHRcdHRoaXMucmVxdWVzdFJlbmRlcigpO1xuXG5cdFx0Ly8gUmV0dXJuIGhhbmRsZSBmb3IgY29udHJvbGxpbmcgdGhpcyBvdmVybGF5XG5cdFx0cmV0dXJuIHtcblx0XHRcdGhpZGU6ICgpID0+IHtcblx0XHRcdFx0Y29uc3QgaW5kZXggPSB0aGlzLm92ZXJsYXlTdGFjay5pbmRleE9mKGVudHJ5KTtcblx0XHRcdFx0aWYgKGluZGV4ICE9PSAtMSkge1xuXHRcdFx0XHRcdHRoaXMub3ZlcmxheVN0YWNrLnNwbGljZShpbmRleCwgMSk7XG5cdFx0XHRcdFx0Ly8gUmVzdG9yZSBmb2N1cyBpZiB0aGlzIG92ZXJsYXkgaGFkIGZvY3VzXG5cdFx0XHRcdFx0aWYgKHRoaXMuZm9jdXNlZENvbXBvbmVudCA9PT0gY29tcG9uZW50KSB7XG5cdFx0XHRcdFx0XHRjb25zdCB0b3BWaXNpYmxlID0gdGhpcy5nZXRUb3Btb3N0VmlzaWJsZU92ZXJsYXkoKTtcblx0XHRcdFx0XHRcdHRoaXMuc2V0Rm9jdXModG9wVmlzaWJsZT8uY29tcG9uZW50ID8/IGVudHJ5LnByZUZvY3VzKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0aWYgKHRoaXMub3ZlcmxheVN0YWNrLmxlbmd0aCA9PT0gMCkgdGhpcy50ZXJtaW5hbC5oaWRlQ3Vyc29yKCk7XG5cdFx0XHRcdFx0dGhpcy5yZXF1ZXN0UmVuZGVyKCk7XG5cdFx0XHRcdH1cblx0XHRcdH0sXG5cdFx0XHRzZXRIaWRkZW46IChoaWRkZW46IGJvb2xlYW4pID0+IHtcblx0XHRcdFx0aWYgKGVudHJ5LmhpZGRlbiA9PT0gaGlkZGVuKSByZXR1cm47XG5cdFx0XHRcdGVudHJ5LmhpZGRlbiA9IGhpZGRlbjtcblx0XHRcdFx0Ly8gVXBkYXRlIGZvY3VzIHdoZW4gaGlkaW5nL3Nob3dpbmdcblx0XHRcdFx0aWYgKGhpZGRlbikge1xuXHRcdFx0XHRcdC8vIElmIHRoaXMgb3ZlcmxheSBoYWQgZm9jdXMsIG1vdmUgZm9jdXMgdG8gbmV4dCB2aXNpYmxlIG9yIHByZUZvY3VzXG5cdFx0XHRcdFx0aWYgKHRoaXMuZm9jdXNlZENvbXBvbmVudCA9PT0gY29tcG9uZW50KSB7XG5cdFx0XHRcdFx0XHRjb25zdCB0b3BWaXNpYmxlID0gdGhpcy5nZXRUb3Btb3N0VmlzaWJsZU92ZXJsYXkoKTtcblx0XHRcdFx0XHRcdHRoaXMuc2V0Rm9jdXModG9wVmlzaWJsZT8uY29tcG9uZW50ID8/IGVudHJ5LnByZUZvY3VzKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0Ly8gUmVzdG9yZSBmb2N1cyB0byB0aGlzIG92ZXJsYXkgd2hlbiBzaG93aW5nIChpZiBpdCdzIGFjdHVhbGx5IHZpc2libGUpXG5cdFx0XHRcdFx0aWYgKCFvcHRpb25zPy5ub25DYXB0dXJpbmcgJiYgdGhpcy5pc092ZXJsYXlWaXNpYmxlKGVudHJ5KSkge1xuXHRcdFx0XHRcdFx0ZW50cnkuZm9jdXNPcmRlciA9ICsrdGhpcy5mb2N1c09yZGVyQ291bnRlcjtcblx0XHRcdFx0XHRcdHRoaXMuc2V0Rm9jdXMoY29tcG9uZW50KTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblx0XHRcdFx0dGhpcy5yZXF1ZXN0UmVuZGVyKCk7XG5cdFx0XHR9LFxuXHRcdFx0aXNIaWRkZW46ICgpID0+IGVudHJ5LmhpZGRlbixcblx0XHRcdGZvY3VzOiAoKSA9PiB7XG5cdFx0XHRcdGlmICghdGhpcy5vdmVybGF5U3RhY2suaW5jbHVkZXMoZW50cnkpIHx8ICF0aGlzLmlzT3ZlcmxheVZpc2libGUoZW50cnkpKSByZXR1cm47XG5cdFx0XHRcdGlmICh0aGlzLmZvY3VzZWRDb21wb25lbnQgIT09IGNvbXBvbmVudCkge1xuXHRcdFx0XHRcdHRoaXMuc2V0Rm9jdXMoY29tcG9uZW50KTtcblx0XHRcdFx0fVxuXHRcdFx0XHRlbnRyeS5mb2N1c09yZGVyID0gKyt0aGlzLmZvY3VzT3JkZXJDb3VudGVyO1xuXHRcdFx0XHR0aGlzLnJlcXVlc3RSZW5kZXIoKTtcblx0XHRcdH0sXG5cdFx0XHR1bmZvY3VzOiAoKSA9PiB7XG5cdFx0XHRcdGlmICh0aGlzLmZvY3VzZWRDb21wb25lbnQgIT09IGNvbXBvbmVudCkgcmV0dXJuO1xuXHRcdFx0XHRjb25zdCB0b3BWaXNpYmxlID0gdGhpcy5nZXRUb3Btb3N0VmlzaWJsZU92ZXJsYXkoKTtcblx0XHRcdFx0dGhpcy5zZXRGb2N1cyh0b3BWaXNpYmxlICYmIHRvcFZpc2libGUgIT09IGVudHJ5ID8gdG9wVmlzaWJsZS5jb21wb25lbnQgOiBlbnRyeS5wcmVGb2N1cyk7XG5cdFx0XHRcdHRoaXMucmVxdWVzdFJlbmRlcigpO1xuXHRcdFx0fSxcblx0XHRcdGlzRm9jdXNlZDogKCkgPT4gdGhpcy5mb2N1c2VkQ29tcG9uZW50ID09PSBjb21wb25lbnQsXG5cdFx0fTtcblx0fVxuXG5cdC8qKiBIaWRlIHRoZSB0b3Btb3N0IG92ZXJsYXkgYW5kIHJlc3RvcmUgcHJldmlvdXMgZm9jdXMuICovXG5cdGhpZGVPdmVybGF5KCk6IHZvaWQge1xuXHRcdGNvbnN0IG92ZXJsYXkgPSB0aGlzLm92ZXJsYXlTdGFjay5wb3AoKTtcblx0XHRpZiAoIW92ZXJsYXkpIHJldHVybjtcblx0XHRpZiAodGhpcy5mb2N1c2VkQ29tcG9uZW50ID09PSBvdmVybGF5LmNvbXBvbmVudCkge1xuXHRcdFx0Ly8gRmluZCB0b3Btb3N0IHZpc2libGUgb3ZlcmxheSwgb3IgZmFsbCBiYWNrIHRvIHByZUZvY3VzXG5cdFx0XHRjb25zdCB0b3BWaXNpYmxlID0gdGhpcy5nZXRUb3Btb3N0VmlzaWJsZU92ZXJsYXkoKTtcblx0XHRcdHRoaXMuc2V0Rm9jdXModG9wVmlzaWJsZT8uY29tcG9uZW50ID8/IG92ZXJsYXkucHJlRm9jdXMpO1xuXHRcdH1cblx0XHRpZiAodGhpcy5vdmVybGF5U3RhY2subGVuZ3RoID09PSAwKSB0aGlzLnRlcm1pbmFsLmhpZGVDdXJzb3IoKTtcblx0XHR0aGlzLnJlcXVlc3RSZW5kZXIoKTtcblx0fVxuXG5cdC8qKiBDaGVjayBpZiB0aGVyZSBhcmUgYW55IHZpc2libGUgb3ZlcmxheXMgKi9cblx0aGFzT3ZlcmxheSgpOiBib29sZWFuIHtcblx0XHRyZXR1cm4gdGhpcy5vdmVybGF5U3RhY2suc29tZSgobykgPT4gdGhpcy5pc092ZXJsYXlWaXNpYmxlKG8pKTtcblx0fVxuXG5cdC8qKiBDaGVjayBpZiBhbiBvdmVybGF5IGVudHJ5IGlzIGN1cnJlbnRseSB2aXNpYmxlICovXG5cdHByaXZhdGUgaXNPdmVybGF5VmlzaWJsZShlbnRyeTogKHR5cGVvZiB0aGlzLm92ZXJsYXlTdGFjaylbbnVtYmVyXSk6IGJvb2xlYW4ge1xuXHRcdHJldHVybiBpc092ZXJsYXlFbnRyeVZpc2libGUoZW50cnksIHRoaXMudGVybWluYWwuY29sdW1ucywgdGhpcy50ZXJtaW5hbC5yb3dzKTtcblx0fVxuXG5cdC8qKiBGaW5kIHRoZSB0b3Btb3N0IHZpc2libGUgY2FwdHVyaW5nIG92ZXJsYXksIGlmIGFueSAqL1xuXHRwcml2YXRlIGdldFRvcG1vc3RWaXNpYmxlT3ZlcmxheSgpOiAodHlwZW9mIHRoaXMub3ZlcmxheVN0YWNrKVtudW1iZXJdIHwgdW5kZWZpbmVkIHtcblx0XHRmb3IgKGxldCBpID0gdGhpcy5vdmVybGF5U3RhY2subGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHtcblx0XHRcdGlmICh0aGlzLm92ZXJsYXlTdGFja1tpXS5vcHRpb25zPy5ub25DYXB0dXJpbmcpIGNvbnRpbnVlO1xuXHRcdFx0aWYgKHRoaXMuaXNPdmVybGF5VmlzaWJsZSh0aGlzLm92ZXJsYXlTdGFja1tpXSkpIHtcblx0XHRcdFx0cmV0dXJuIHRoaXMub3ZlcmxheVN0YWNrW2ldO1xuXHRcdFx0fVxuXHRcdH1cblx0XHRyZXR1cm4gdW5kZWZpbmVkO1xuXHR9XG5cblx0b3ZlcnJpZGUgaW52YWxpZGF0ZSgpOiB2b2lkIHtcblx0XHRzdXBlci5pbnZhbGlkYXRlKCk7XG5cdFx0Zm9yIChjb25zdCBvdmVybGF5IG9mIHRoaXMub3ZlcmxheVN0YWNrKSBvdmVybGF5LmNvbXBvbmVudC5pbnZhbGlkYXRlPy4oKTtcblx0fVxuXG5cdHN0YXJ0KCk6IHZvaWQge1xuXHRcdHRoaXMuc3RvcHBlZCA9IGZhbHNlO1xuXHRcdC8vIE5vbi1UVFkgc3Rkb3V0IChwaXBlKSBcdTIwMTQgc2tpcCBUVUkgZW50aXJlbHkgdG8gYXZvaWQgYnVybmluZyBDUFUuXG5cdFx0Ly8gUlBDIGJyaWRnZSBwcm9jZXNzZXMgaGF2ZSBwaXBlZCBzdGRpbzsgcmVuZGVyaW5nIEFOU0kgZXNjYXBlIGNvZGVzXG5cdFx0Ly8gdG8gYSBwaXBlIGlzIHB1cmUgd2FzdGUgYW5kIGNhdXNlcyBhIHJ1bmF3YXkgcmVuZGVyIGxvb3AuIChpc3N1ZSAjMzA5NSlcblx0XHRpZiAoIXRoaXMudGVybWluYWwuaXNUVFkpIHtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cdFx0dGhpcy50ZXJtaW5hbC5zdGFydChcblx0XHRcdChkYXRhKSA9PiB0aGlzLmhhbmRsZUlucHV0KGRhdGEpLFxuXHRcdFx0KCkgPT4gdGhpcy5yZXF1ZXN0UmVuZGVyKCksXG5cdFx0KTtcblx0XHR0aGlzLnRlcm1pbmFsLmhpZGVDdXJzb3IoKTtcblx0XHR0aGlzLnF1ZXJ5Q2VsbFNpemUoKTtcblx0XHR0aGlzLnJlcXVlc3RSZW5kZXIoKTtcblx0fVxuXG5cdGFkZElucHV0TGlzdGVuZXIobGlzdGVuZXI6IElucHV0TGlzdGVuZXIpOiAoKSA9PiB2b2lkIHtcblx0XHR0aGlzLmlucHV0TGlzdGVuZXJzLmFkZChsaXN0ZW5lcik7XG5cdFx0cmV0dXJuICgpID0+IHtcblx0XHRcdHRoaXMuaW5wdXRMaXN0ZW5lcnMuZGVsZXRlKGxpc3RlbmVyKTtcblx0XHR9O1xuXHR9XG5cblx0cmVtb3ZlSW5wdXRMaXN0ZW5lcihsaXN0ZW5lcjogSW5wdXRMaXN0ZW5lcik6IHZvaWQge1xuXHRcdHRoaXMuaW5wdXRMaXN0ZW5lcnMuZGVsZXRlKGxpc3RlbmVyKTtcblx0fVxuXG5cdHByaXZhdGUgcXVlcnlDZWxsU2l6ZSgpOiB2b2lkIHtcblx0XHQvLyBPbmx5IHF1ZXJ5IGlmIHRlcm1pbmFsIHN1cHBvcnRzIGltYWdlcyAoY2VsbCBzaXplIGlzIG9ubHkgdXNlZCBmb3IgaW1hZ2UgcmVuZGVyaW5nKVxuXHRcdGlmICghZ2V0Q2FwYWJpbGl0aWVzKCkuaW1hZ2VzKSB7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXHRcdC8vIFF1ZXJ5IHRlcm1pbmFsIGZvciBjZWxsIHNpemUgaW4gcGl4ZWxzOiBDU0kgMTYgdFxuXHRcdC8vIFJlc3BvbnNlIGZvcm1hdDogQ1NJIDYgOyBoZWlnaHQgOyB3aWR0aCB0XG5cdFx0dGhpcy5jZWxsU2l6ZVF1ZXJ5UGVuZGluZyA9IHRydWU7XG5cdFx0dGhpcy50ZXJtaW5hbC53cml0ZShcIlxceDFiWzE2dFwiKTtcblx0fVxuXG5cdHN0b3AoKTogdm9pZCB7XG5cdFx0dGhpcy5zdG9wcGVkID0gdHJ1ZTtcblxuXHRcdC8vIERpc3Bvc2UgYWxsIG92ZXJsYXlzIHRvIHN0b3AgYW55IHJ1bm5pbmcgdGltZXJzXG5cdFx0Zm9yIChjb25zdCBlbnRyeSBvZiB0aGlzLm92ZXJsYXlTdGFjaykge1xuXHRcdFx0aWYgKFwiZGlzcG9zZVwiIGluIGVudHJ5LmNvbXBvbmVudCAmJiB0eXBlb2YgKGVudHJ5LmNvbXBvbmVudCBhcyBhbnkpLmRpc3Bvc2UgPT09IFwiZnVuY3Rpb25cIikge1xuXHRcdFx0XHQoZW50cnkuY29tcG9uZW50IGFzIGFueSkuZGlzcG9zZSgpO1xuXHRcdFx0fVxuXHRcdH1cblx0XHR0aGlzLm92ZXJsYXlTdGFjayA9IFtdO1xuXG5cdFx0Ly8gTW92ZSBjdXJzb3IgdG8gdGhlIGVuZCBvZiB0aGUgY29udGVudCB0byBwcmV2ZW50IG92ZXJ3cml0aW5nL2FydGlmYWN0cyBvbiBleGl0XG5cdFx0aWYgKHRoaXMucHJldmlvdXNMaW5lcy5sZW5ndGggPiAwKSB7XG5cdFx0XHRjb25zdCB0YXJnZXRSb3cgPSB0aGlzLnByZXZpb3VzTGluZXMubGVuZ3RoOyAvLyBMaW5lIGFmdGVyIHRoZSBsYXN0IGNvbnRlbnRcblx0XHRcdGNvbnN0IGxpbmVEaWZmID0gdGFyZ2V0Um93IC0gdGhpcy5oYXJkd2FyZUN1cnNvclJvdztcblx0XHRcdGlmIChsaW5lRGlmZiA+IDApIHtcblx0XHRcdFx0dGhpcy50ZXJtaW5hbC53cml0ZShgXFx4MWJbJHtsaW5lRGlmZn1CYCk7XG5cdFx0XHR9IGVsc2UgaWYgKGxpbmVEaWZmIDwgMCkge1xuXHRcdFx0XHR0aGlzLnRlcm1pbmFsLndyaXRlKGBcXHgxYlskey1saW5lRGlmZn1BYCk7XG5cdFx0XHR9XG5cdFx0XHR0aGlzLnRlcm1pbmFsLndyaXRlKFwiXFxyXFxuXCIpO1xuXHRcdH1cblxuXHRcdHRoaXMudGVybWluYWwuc2hvd0N1cnNvcigpO1xuXHRcdHRoaXMudGVybWluYWwuc3RvcCgpO1xuXHR9XG5cblx0cmVxdWVzdFJlbmRlcihmb3JjZSA9IGZhbHNlKTogdm9pZCB7XG5cdFx0Ly8gU2tpcCByZW5kZXJpbmcgb24gbm9uLVRUWSBzdGRvdXQgdG8gcHJldmVudCBDUFUgYnVybiAoaXNzdWUgIzMwOTUpXG5cdFx0aWYgKCF0aGlzLnRlcm1pbmFsLmlzVFRZKSByZXR1cm47XG5cdFx0aWYgKGZvcmNlKSB7XG5cdFx0XHR0aGlzLnByZXZpb3VzTGluZXMgPSBbXTtcblx0XHRcdHRoaXMucHJldmlvdXNXaWR0aCA9IC0xOyAvLyAtMSB0cmlnZ2VycyB3aWR0aENoYW5nZWQsIGZvcmNpbmcgYSBmdWxsIGNsZWFyXG5cdFx0XHR0aGlzLnByZXZpb3VzSGVpZ2h0ID0gLTE7IC8vIC0xIHRyaWdnZXJzIGhlaWdodENoYW5nZWQsIGZvcmNpbmcgYSBmdWxsIGNsZWFyXG5cdFx0XHR0aGlzLmN1cnNvclJvdyA9IDA7XG5cdFx0XHR0aGlzLmhhcmR3YXJlQ3Vyc29yUm93ID0gMDtcblx0XHRcdHRoaXMubWF4TGluZXNSZW5kZXJlZCA9IDA7XG5cdFx0XHR0aGlzLnByZXZpb3VzVmlld3BvcnRUb3AgPSAwO1xuXHRcdH1cblx0XHRpZiAodGhpcy5yZW5kZXJSZXF1ZXN0ZWQpIHJldHVybjtcblx0XHR0aGlzLnJlbmRlclJlcXVlc3RlZCA9IHRydWU7XG5cdFx0cHJvY2Vzcy5uZXh0VGljaygoKSA9PiB7XG5cdFx0XHR0aGlzLnJlbmRlclJlcXVlc3RlZCA9IGZhbHNlO1xuXHRcdFx0dGhpcy5kb1JlbmRlcigpO1xuXHRcdH0pO1xuXHR9XG5cblx0cHJpdmF0ZSBoYW5kbGVJbnB1dChkYXRhOiBzdHJpbmcpOiB2b2lkIHtcblx0XHRpZiAodGhpcy5pbnB1dExpc3RlbmVycy5zaXplID4gMCkge1xuXHRcdFx0bGV0IGN1cnJlbnQgPSBkYXRhO1xuXHRcdFx0Zm9yIChjb25zdCBsaXN0ZW5lciBvZiB0aGlzLmlucHV0TGlzdGVuZXJzKSB7XG5cdFx0XHRcdGNvbnN0IHJlc3VsdCA9IGxpc3RlbmVyKGN1cnJlbnQpO1xuXHRcdFx0XHRpZiAocmVzdWx0Py5jb25zdW1lKSB7XG5cdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGlmIChyZXN1bHQ/LmRhdGEgIT09IHVuZGVmaW5lZCkge1xuXHRcdFx0XHRcdGN1cnJlbnQgPSByZXN1bHQuZGF0YTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdFx0aWYgKGN1cnJlbnQubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblx0XHRcdGRhdGEgPSBjdXJyZW50O1xuXHRcdH1cblxuXHRcdC8vIElmIHdlJ3JlIHdhaXRpbmcgZm9yIGNlbGwgc2l6ZSByZXNwb25zZSwgYnVmZmVyIGlucHV0IGFuZCBwYXJzZVxuXHRcdGlmICh0aGlzLmNlbGxTaXplUXVlcnlQZW5kaW5nKSB7XG5cdFx0XHR0aGlzLmlucHV0QnVmZmVyICs9IGRhdGE7XG5cdFx0XHRjb25zdCBmaWx0ZXJlZCA9IHRoaXMucGFyc2VDZWxsU2l6ZVJlc3BvbnNlKCk7XG5cdFx0XHRpZiAoZmlsdGVyZWQubGVuZ3RoID09PSAwKSByZXR1cm47XG5cdFx0XHRkYXRhID0gZmlsdGVyZWQ7XG5cdFx0fVxuXG5cdFx0Ly8gR2xvYmFsIGRlYnVnIGtleSBoYW5kbGVyIChTaGlmdCtDdHJsK0QpXG5cdFx0aWYgKG1hdGNoZXNLZXkoZGF0YSwgXCJzaGlmdCtjdHJsK2RcIikgJiYgdGhpcy5vbkRlYnVnKSB7XG5cdFx0XHR0aGlzLm9uRGVidWcoKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHQvLyBJZiBmb2N1c2VkIGNvbXBvbmVudCBpcyBhbiBvdmVybGF5LCB2ZXJpZnkgaXQncyBzdGlsbCB2aXNpYmxlXG5cdFx0Ly8gKHZpc2liaWxpdHkgY2FuIGNoYW5nZSBkdWUgdG8gdGVybWluYWwgcmVzaXplIG9yIHZpc2libGUoKSBjYWxsYmFjaylcblx0XHRjb25zdCBmb2N1c2VkT3ZlcmxheSA9IHRoaXMub3ZlcmxheVN0YWNrLmZpbmQoKG8pID0+IG8uY29tcG9uZW50ID09PSB0aGlzLmZvY3VzZWRDb21wb25lbnQpO1xuXHRcdGlmIChmb2N1c2VkT3ZlcmxheSAmJiAhdGhpcy5pc092ZXJsYXlWaXNpYmxlKGZvY3VzZWRPdmVybGF5KSkge1xuXHRcdFx0Ly8gRm9jdXNlZCBvdmVybGF5IGlzIG5vIGxvbmdlciB2aXNpYmxlLCByZWRpcmVjdCB0byB0b3Btb3N0IHZpc2libGUgb3ZlcmxheVxuXHRcdFx0Y29uc3QgdG9wVmlzaWJsZSA9IHRoaXMuZ2V0VG9wbW9zdFZpc2libGVPdmVybGF5KCk7XG5cdFx0XHRpZiAodG9wVmlzaWJsZSkge1xuXHRcdFx0XHR0aGlzLnNldEZvY3VzKHRvcFZpc2libGUuY29tcG9uZW50KTtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdC8vIE5vIHZpc2libGUgb3ZlcmxheXMsIHJlc3RvcmUgdG8gcHJlRm9jdXNcblx0XHRcdFx0dGhpcy5zZXRGb2N1cyhmb2N1c2VkT3ZlcmxheS5wcmVGb2N1cyk7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0Ly8gUGFzcyBpbnB1dCB0byBmb2N1c2VkIGNvbXBvbmVudCAoaW5jbHVkaW5nIEN0cmwrQylcblx0XHQvLyBUaGUgZm9jdXNlZCBjb21wb25lbnQgY2FuIGRlY2lkZSBob3cgdG8gaGFuZGxlIEN0cmwrQ1xuXHRcdGlmICh0aGlzLmZvY3VzZWRDb21wb25lbnQ/LmhhbmRsZUlucHV0KSB7XG5cdFx0XHQvLyBGaWx0ZXIgb3V0IGtleSByZWxlYXNlIGV2ZW50cyB1bmxlc3MgY29tcG9uZW50IG9wdHMgaW5cblx0XHRcdGlmIChpc0tleVJlbGVhc2UoZGF0YSkgJiYgIXRoaXMuZm9jdXNlZENvbXBvbmVudC53YW50c0tleVJlbGVhc2UpIHtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXHRcdFx0dGhpcy5mb2N1c2VkQ29tcG9uZW50LmhhbmRsZUlucHV0KGRhdGEpO1xuXHRcdFx0dGhpcy5yZXF1ZXN0UmVuZGVyKCk7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBwYXJzZUNlbGxTaXplUmVzcG9uc2UoKTogc3RyaW5nIHtcblx0XHQvLyBSZXNwb25zZSBmb3JtYXQ6IEVTQyBbIDYgOyBoZWlnaHQgOyB3aWR0aCB0XG5cdFx0Ly8gTWF0Y2ggdGhlIHJlc3BvbnNlIHBhdHRlcm5cblx0XHRjb25zdCByZXNwb25zZVBhdHRlcm4gPSAvXFx4MWJcXFs2OyhcXGQrKTsoXFxkKyl0Lztcblx0XHRjb25zdCBtYXRjaCA9IHRoaXMuaW5wdXRCdWZmZXIubWF0Y2gocmVzcG9uc2VQYXR0ZXJuKTtcblxuXHRcdGlmIChtYXRjaCkge1xuXHRcdFx0Y29uc3QgaGVpZ2h0UHggPSBwYXJzZUludChtYXRjaFsxXSwgMTApO1xuXHRcdFx0Y29uc3Qgd2lkdGhQeCA9IHBhcnNlSW50KG1hdGNoWzJdLCAxMCk7XG5cblx0XHRcdGlmIChoZWlnaHRQeCA+IDAgJiYgd2lkdGhQeCA+IDApIHtcblx0XHRcdFx0c2V0Q2VsbERpbWVuc2lvbnMoeyB3aWR0aFB4LCBoZWlnaHRQeCB9KTtcblx0XHRcdFx0Ly8gSW52YWxpZGF0ZSBhbGwgY29tcG9uZW50cyBzbyBpbWFnZXMgcmUtcmVuZGVyIHdpdGggY29ycmVjdCBkaW1lbnNpb25zXG5cdFx0XHRcdHRoaXMuaW52YWxpZGF0ZSgpO1xuXHRcdFx0XHR0aGlzLnJlcXVlc3RSZW5kZXIoKTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gUmVtb3ZlIHRoZSByZXNwb25zZSBmcm9tIGJ1ZmZlclxuXHRcdFx0dGhpcy5pbnB1dEJ1ZmZlciA9IHRoaXMuaW5wdXRCdWZmZXIucmVwbGFjZShyZXNwb25zZVBhdHRlcm4sIFwiXCIpO1xuXHRcdFx0dGhpcy5jZWxsU2l6ZVF1ZXJ5UGVuZGluZyA9IGZhbHNlO1xuXHRcdH1cblxuXHRcdC8vIERvbid0IGhvbGQgYSBiYXJlIEVzY2FwZSBrZXlwcmVzcyBob3N0YWdlIHdoaWxlIHdhaXRpbmcgZm9yIHRoZVxuXHRcdC8vIG9wdGlvbmFsIGNlbGwtc2l6ZSByZXNwb25zZS4gVGhpcyBpcyB0aGUgbW9zdCBjb21tb24gZWFybHkgaW5wdXQgcmFjZS5cblx0XHRpZiAodGhpcy5pbnB1dEJ1ZmZlciA9PT0gXCJcXHgxYlwiKSB7XG5cdFx0XHRjb25zdCByZXN1bHQgPSB0aGlzLmlucHV0QnVmZmVyO1xuXHRcdFx0dGhpcy5pbnB1dEJ1ZmZlciA9IFwiXCI7XG5cdFx0XHR0aGlzLmNlbGxTaXplUXVlcnlQZW5kaW5nID0gZmFsc2U7XG5cdFx0XHRyZXR1cm4gcmVzdWx0O1xuXHRcdH1cblxuXHRcdC8vIENoZWNrIGlmIHdlIGhhdmUgYSBwYXJ0aWFsIGNlbGwgc2l6ZSByZXNwb25zZSBzdGFydGluZyAod2FpdCBmb3IgbW9yZSBkYXRhKVxuXHRcdC8vIFBhdHRlcm5zIHRoYXQgY291bGQgYmUgaW5jb21wbGV0ZSBjZWxsIHNpemUgcmVzcG9uc2U6IFxceDFiLCBcXHgxYlssIFxceDFiWzYsIFxceDFiWzY7Li4uKG5vIHQgeWV0KVxuXHRcdGNvbnN0IHBhcnRpYWxDZWxsU2l6ZVBhdHRlcm4gPSAvXFx4MWIoXFxbNj87P1tcXGQ7XSopPyQvO1xuXHRcdGlmIChwYXJ0aWFsQ2VsbFNpemVQYXR0ZXJuLnRlc3QodGhpcy5pbnB1dEJ1ZmZlcikpIHtcblx0XHRcdC8vIENoZWNrIGlmIGl0J3MgYWN0dWFsbHkgYSBjb21wbGV0ZSBkaWZmZXJlbnQgZXNjYXBlIHNlcXVlbmNlIChlbmRzIHdpdGggYSBsZXR0ZXIpXG5cdFx0XHQvLyBDZWxsIHNpemUgcmVzcG9uc2UgZW5kcyB3aXRoICd0JywgS2l0dHkga2V5Ym9hcmQgZW5kcyB3aXRoICd1JywgYXJyb3dzIGVuZCB3aXRoIEEtRCwgZXRjLlxuXHRcdFx0Y29uc3QgbGFzdENoYXIgPSB0aGlzLmlucHV0QnVmZmVyW3RoaXMuaW5wdXRCdWZmZXIubGVuZ3RoIC0gMV07XG5cdFx0XHRpZiAoIS9bYS16QS1afl0vLnRlc3QobGFzdENoYXIpKSB7XG5cdFx0XHRcdC8vIERvZXNuJ3QgZW5kIHdpdGggYSB0ZXJtaW5hdG9yLCBtaWdodCBiZSBpbmNvbXBsZXRlIC0gd2FpdCBmb3IgbW9yZVxuXHRcdFx0XHRyZXR1cm4gXCJcIjtcblx0XHRcdH1cblx0XHR9XG5cblx0XHQvLyBObyBjZWxsIHNpemUgcmVzcG9uc2UgZm91bmQsIHJldHVybiBidWZmZXJlZCBkYXRhIGFzIHVzZXIgaW5wdXRcblx0XHRjb25zdCByZXN1bHQgPSB0aGlzLmlucHV0QnVmZmVyO1xuXHRcdHRoaXMuaW5wdXRCdWZmZXIgPSBcIlwiO1xuXHRcdHRoaXMuY2VsbFNpemVRdWVyeVBlbmRpbmcgPSBmYWxzZTsgLy8gR2l2ZSB1cCB3YWl0aW5nXG5cdFx0cmV0dXJuIHJlc3VsdDtcblx0fVxuXG5cdHByaXZhdGUgZG9SZW5kZXIoKTogdm9pZCB7XG5cdFx0aWYgKHRoaXMuc3RvcHBlZCkgcmV0dXJuO1xuXHRcdGNvbnN0IHdpZHRoID0gdGhpcy50ZXJtaW5hbC5jb2x1bW5zO1xuXHRcdGNvbnN0IGhlaWdodCA9IHRoaXMudGVybWluYWwucm93cztcblx0XHRjb25zdCBnZXRWaWV3cG9ydFRvcCA9IChsaW5lQ291bnQ6IG51bWJlcik6IG51bWJlciA9PiBsaW5lQ291bnQgLSBoZWlnaHQ7XG5cdFx0bGV0IHZpZXdwb3J0VG9wID0gZ2V0Vmlld3BvcnRUb3AodGhpcy5tYXhMaW5lc1JlbmRlcmVkKTtcblx0XHRsZXQgcHJldlZpZXdwb3J0VG9wID0gdGhpcy5wcmV2aW91c1ZpZXdwb3J0VG9wO1xuXHRcdGxldCBoYXJkd2FyZUN1cnNvclJvdyA9IHRoaXMuaGFyZHdhcmVDdXJzb3JSb3c7XG5cdFx0Y29uc3QgY29tcHV0ZUxpbmVEaWZmID0gKHRhcmdldFJvdzogbnVtYmVyKTogbnVtYmVyID0+IHtcblx0XHRcdGNvbnN0IGN1cnJlbnRTY3JlZW5Sb3cgPSBoYXJkd2FyZUN1cnNvclJvdyAtIHByZXZWaWV3cG9ydFRvcDtcblx0XHRcdGNvbnN0IHRhcmdldFNjcmVlblJvdyA9IHRhcmdldFJvdyAtIHZpZXdwb3J0VG9wO1xuXHRcdFx0cmV0dXJuIHRhcmdldFNjcmVlblJvdyAtIGN1cnJlbnRTY3JlZW5Sb3c7XG5cdFx0fTtcblxuXHRcdC8vIFJlbmRlciBhbGwgY29tcG9uZW50cyB0byBnZXQgbmV3IGxpbmVzXG5cdFx0bGV0IG5ld0xpbmVzID0gdGhpcy5yZW5kZXIod2lkdGgpO1xuXG5cdFx0Ly8gU2tpcCBBTEwgcG9zdC1wcm9jZXNzaW5nIGlmIGNvbXBvbmVudCBvdXRwdXQgaXMgdW5jaGFuZ2VkLlxuXHRcdC8vIENvbnRhaW5lci5yZW5kZXIoKSByZXR1cm5zIHRoZSBzYW1lIGFycmF5IHJlZmVyZW5jZSB3aGVuIHN0YWJsZS5cblx0XHRpZiAobmV3TGluZXMgPT09IHRoaXMuX2xhc3RSZW5kZXJlZENvbXBvbmVudHMgJiYgdGhpcy5vdmVybGF5U3RhY2subGVuZ3RoID09PSAwKSB7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXHRcdHRoaXMuX2xhc3RSZW5kZXJlZENvbXBvbmVudHMgPSBuZXdMaW5lcztcblxuXHRcdC8vIENvbXBvc2l0ZSBvdmVybGF5cyBpbnRvIHRoZSByZW5kZXJlZCBsaW5lcyAoYmVmb3JlIGRpZmZlcmVudGlhbCBjb21wYXJlKVxuXHRcdGlmICh0aGlzLm92ZXJsYXlTdGFjay5sZW5ndGggPiAwKSB7XG5cdFx0XHRuZXdMaW5lcyA9IGNvbXBvc2l0ZU92ZXJsYXlzKG5ld0xpbmVzLCB0aGlzLm92ZXJsYXlTdGFjaywgd2lkdGgsIGhlaWdodCwgdGhpcy5tYXhMaW5lc1JlbmRlcmVkKTtcblx0XHR9XG5cblx0XHQvLyBFeHRyYWN0IGN1cnNvciBwb3NpdGlvbiBiZWZvcmUgYXBwbHlpbmcgbGluZSByZXNldHMgKG1hcmtlciBtdXN0IGJlIGZvdW5kIGZpcnN0KVxuXHRcdGNvbnN0IGN1cnNvclBvcyA9IGV4dHJhY3RDdXJzb3JQb3NpdGlvbihuZXdMaW5lcywgaGVpZ2h0KTtcblxuXHRcdG5ld0xpbmVzID0gYXBwbHlMaW5lUmVzZXRzKG5ld0xpbmVzKTtcblxuXHRcdC8vIFdpZHRoIG9yIGhlaWdodCBjaGFuZ2VkIC0gbmVlZCBmdWxsIHJlLXJlbmRlclxuXHRcdGNvbnN0IHdpZHRoQ2hhbmdlZCA9IHRoaXMucHJldmlvdXNXaWR0aCAhPT0gMCAmJiB0aGlzLnByZXZpb3VzV2lkdGggIT09IHdpZHRoO1xuXHRcdGNvbnN0IGhlaWdodENoYW5nZWQgPSB0aGlzLnByZXZpb3VzSGVpZ2h0ICE9PSAwICYmIHRoaXMucHJldmlvdXNIZWlnaHQgIT09IGhlaWdodDtcblxuXHRcdC8vIEhlbHBlciB0byBjbGVhciBzY3JvbGxiYWNrIGFuZCB2aWV3cG9ydCBhbmQgcmVuZGVyIGFsbCBuZXcgbGluZXNcblx0XHRjb25zdCBmdWxsUmVuZGVyID0gKGNsZWFyOiBib29sZWFuKTogdm9pZCA9PiB7XG5cdFx0XHR0aGlzLmZ1bGxSZWRyYXdDb3VudCArPSAxO1xuXHRcdFx0bGV0IGJ1ZmZlciA9IFwiXFx4MWJbPzIwMjZoXCI7IC8vIEJlZ2luIHN5bmNocm9uaXplZCBvdXRwdXRcblx0XHRcdGNvbnN0IHN0YXJ0Um93ID0gTWF0aC5tYXgoMSwgaGVpZ2h0IC0gTWF0aC5tYXgoMSwgbmV3TGluZXMubGVuZ3RoKSArIDEpO1xuXHRcdFx0aWYgKGNsZWFyKSB7XG5cdFx0XHRcdC8vIENsZWFyIHZpZXdwb3J0IChzY3JvbGxiYWNrIHByZXNlcnZlZCkgYW5kIGFuY2hvciB0aGUgcmVuZGVyZWRcblx0XHRcdFx0Ly8gYmxvY2sgdG8gdGhlIHRlcm1pbmFsIGJvdHRvbSBzbyB0aGUgZWRpdG9yIC8gYmVsb3dFZGl0b3Jcblx0XHRcdFx0Ly8gd2lkZ2V0cyBkbyBub3QganVtcCB0byByb3cgMSBhZnRlciBhIGNoYXQgY2xlYXIuIFdoZW4gdGhlXG5cdFx0XHRcdC8vIGJsb2NrIGlzIHRhbGxlciB0aGFuIHRoZSB2aWV3cG9ydCwgTWF0aC5tYXgoMSwgXHUyMDI2KSBmYWxscyBiYWNrXG5cdFx0XHRcdC8vIHRvIHJvdyAxIFx1MjAxNCBzYW1lIGFzIHRoZSBwcmlvciBgXFx4MWJbSGAgYmVoYXZpb3IuXG5cdFx0XHRcdGJ1ZmZlciArPSBgXFx4MWJbMkpcXHgxYlske3N0YXJ0Um93fTsxSGA7XG5cdFx0XHR9IGVsc2UgaWYgKHN0YXJ0Um93ID4gMSkge1xuXHRcdFx0XHRidWZmZXIgKz0gYFxceDFiWyR7c3RhcnRSb3d9OzFIYDtcblx0XHRcdH1cblx0XHRcdGZvciAobGV0IGkgPSAwOyBpIDwgbmV3TGluZXMubGVuZ3RoOyBpKyspIHtcblx0XHRcdFx0aWYgKGkgPiAwKSBidWZmZXIgKz0gXCJcXHJcXG5cIjtcblx0XHRcdFx0bGV0IGxpbmUgPSBuZXdMaW5lc1tpXTtcblx0XHRcdFx0aWYgKCFpc0ltYWdlTGluZShsaW5lKSAmJiB2aXNpYmxlV2lkdGgobGluZSkgPiB3aWR0aCkge1xuXHRcdFx0XHRcdGxpbmUgPSB0cnVuY2F0ZVRvV2lkdGgobGluZSwgd2lkdGgpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGJ1ZmZlciArPSBsaW5lO1xuXHRcdFx0fVxuXHRcdFx0YnVmZmVyICs9IFwiXFx4MWJbPzIwMjZsXCI7IC8vIEVuZCBzeW5jaHJvbml6ZWQgb3V0cHV0XG5cdFx0XHR0aGlzLnRlcm1pbmFsLndyaXRlKGJ1ZmZlcik7XG5cdFx0XHR0aGlzLmN1cnNvclJvdyA9IE1hdGgubWF4KDAsIG5ld0xpbmVzLmxlbmd0aCAtIDEpO1xuXHRcdFx0dGhpcy5oYXJkd2FyZUN1cnNvclJvdyA9IHRoaXMuY3Vyc29yUm93O1xuXHRcdFx0Ly8gUmVzZXQgbWF4IGxpbmVzIHdoZW4gY2xlYXJpbmcsIG90aGVyd2lzZSB0cmFjayBncm93dGhcblx0XHRcdGlmIChjbGVhcikge1xuXHRcdFx0XHR0aGlzLm1heExpbmVzUmVuZGVyZWQgPSBuZXdMaW5lcy5sZW5ndGg7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHR0aGlzLm1heExpbmVzUmVuZGVyZWQgPSBNYXRoLm1heCh0aGlzLm1heExpbmVzUmVuZGVyZWQsIG5ld0xpbmVzLmxlbmd0aCk7XG5cdFx0XHR9XG5cdFx0XHR0aGlzLnByZXZpb3VzVmlld3BvcnRUb3AgPSBnZXRWaWV3cG9ydFRvcCh0aGlzLm1heExpbmVzUmVuZGVyZWQpO1xuXHRcdFx0dGhpcy5wb3NpdGlvbkhhcmR3YXJlQ3Vyc29yKGN1cnNvclBvcywgbmV3TGluZXMubGVuZ3RoKTtcblx0XHRcdHRoaXMucHJldmlvdXNMaW5lcyA9IG5ld0xpbmVzO1xuXHRcdFx0dGhpcy5wcmV2aW91c1dpZHRoID0gd2lkdGg7XG5cdFx0XHR0aGlzLnByZXZpb3VzSGVpZ2h0ID0gaGVpZ2h0O1xuXHRcdH07XG5cblx0XHRjb25zdCBkZWJ1Z1JlZHJhdyA9IHByb2Nlc3MuZW52LlBJX0RFQlVHX1JFRFJBVyA9PT0gXCIxXCI7XG5cdFx0Y29uc3QgbG9nUmVkcmF3ID0gKHJlYXNvbjogc3RyaW5nKTogdm9pZCA9PiB7XG5cdFx0XHRpZiAoIWRlYnVnUmVkcmF3KSByZXR1cm47XG5cdFx0XHRjb25zdCBsb2dQYXRoID0gcGF0aC5qb2luKG9zLmhvbWVkaXIoKSwgXCIucGlcIiwgXCJhZ2VudFwiLCBcInBpLWRlYnVnLmxvZ1wiKTtcblx0XHRcdGNvbnN0IG1zZyA9IGBbJHtuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCl9XSBmdWxsUmVuZGVyOiAke3JlYXNvbn0gKHByZXY9JHt0aGlzLnByZXZpb3VzTGluZXMubGVuZ3RofSwgbmV3PSR7bmV3TGluZXMubGVuZ3RofSwgaGVpZ2h0PSR7aGVpZ2h0fSlcXG5gO1xuXHRcdFx0ZnMuYXBwZW5kRmlsZVN5bmMobG9nUGF0aCwgbXNnKTtcblx0XHR9O1xuXG5cdFx0Ly8gRmlyc3QgcmVuZGVyIC0ganVzdCBvdXRwdXQgZXZlcnl0aGluZyB3aXRob3V0IGNsZWFyaW5nIChhc3N1bWVzIGNsZWFuIHNjcmVlbilcblx0XHRpZiAodGhpcy5wcmV2aW91c0xpbmVzLmxlbmd0aCA9PT0gMCAmJiAhd2lkdGhDaGFuZ2VkICYmICFoZWlnaHRDaGFuZ2VkKSB7XG5cdFx0XHRsb2dSZWRyYXcoXCJmaXJzdCByZW5kZXJcIik7XG5cdFx0XHRmdWxsUmVuZGVyKGZhbHNlKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHQvLyBXaWR0aCBvciBoZWlnaHQgY2hhbmdlZCAtIGZ1bGwgcmUtcmVuZGVyXG5cdFx0aWYgKHdpZHRoQ2hhbmdlZCB8fCBoZWlnaHRDaGFuZ2VkKSB7XG5cdFx0XHRsb2dSZWRyYXcoYHRlcm1pbmFsIHNpemUgY2hhbmdlZCAoJHt0aGlzLnByZXZpb3VzV2lkdGh9eCR7dGhpcy5wcmV2aW91c0hlaWdodH0gLT4gJHt3aWR0aH14JHtoZWlnaHR9KWApO1xuXHRcdFx0ZnVsbFJlbmRlcih0cnVlKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRpZiAoXG5cdFx0XHRuZXdMaW5lcy5sZW5ndGggIT09IHRoaXMucHJldmlvdXNMaW5lcy5sZW5ndGggJiZcblx0XHRcdChuZXdMaW5lcy5sZW5ndGggPD0gaGVpZ2h0IHx8IHRoaXMucHJldmlvdXNMaW5lcy5sZW5ndGggPD0gaGVpZ2h0KVxuXHRcdCkge1xuXHRcdFx0bG9nUmVkcmF3KGBib3R0b20tYW5jaG9yZWQgc2hvcnQgYmxvY2sgcmVzaXplZCAoJHt0aGlzLnByZXZpb3VzTGluZXMubGVuZ3RofSAtPiAke25ld0xpbmVzLmxlbmd0aH0pYCk7XG5cdFx0XHRmdWxsUmVuZGVyKHRydWUpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGlmIChuZXdMaW5lcy5sZW5ndGggPCB0aGlzLnByZXZpb3VzTGluZXMubGVuZ3RoICYmIG5ld0xpbmVzLmxlbmd0aCA+IGhlaWdodCkge1xuXHRcdFx0bG9nUmVkcmF3KGBib3R0b20tYW5jaG9yZWQgdGFsbCBibG9jayBzaHJ1bmsgKCR7dGhpcy5wcmV2aW91c0xpbmVzLmxlbmd0aH0gLT4gJHtuZXdMaW5lcy5sZW5ndGh9KWApO1xuXHRcdFx0ZnVsbFJlbmRlcih0cnVlKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHQvLyBDb250ZW50IHNocnVuayBiZWxvdyB0aGUgd29ya2luZyBhcmVhIGFuZCBubyBvdmVybGF5cyAtIHJlLXJlbmRlciB0byBjbGVhciBlbXB0eSByb3dzXG5cdFx0Ly8gKG92ZXJsYXlzIG5lZWQgdGhlIHBhZGRpbmcsIHNvIG9ubHkgZG8gdGhpcyB3aGVuIG5vIG92ZXJsYXlzIGFyZSBhY3RpdmUpXG5cdFx0Ly8gQ29uZmlndXJhYmxlIHZpYSBzZXRDbGVhck9uU2hyaW5rKCkgb3IgUElfQ0xFQVJfT05fU0hSSU5LPTAgZW52IHZhclxuXHRcdGlmICh0aGlzLmNsZWFyT25TaHJpbmsgJiYgbmV3TGluZXMubGVuZ3RoIDwgdGhpcy5tYXhMaW5lc1JlbmRlcmVkICYmIHRoaXMub3ZlcmxheVN0YWNrLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0aWYgKCF0aGlzLl9zaHJpbmtEZWJvdW5jZUFjdGl2ZSkge1xuXHRcdFx0XHQvLyBGaXJzdCBzaHJpbmsgZGV0ZWN0aW9uOiBkZWZlciB0aGUgZnVsbCByZWRyYXcgYnkgb25lIHRpY2suXG5cdFx0XHRcdC8vIElmIGNvbnRlbnQgZ3Jvd3MgYmFjayBpbW1lZGlhdGVseSAocGlubmVkIGNsZWFyIFx1MjE5MiBuZXcgc3RyZWFtaW5nKSxcblx0XHRcdFx0Ly8gdGhlIGZ1bGwgcmVkcmF3IGlzIGF2b2lkZWQuXG5cdFx0XHRcdHRoaXMuX3Nocmlua0RlYm91bmNlQWN0aXZlID0gdHJ1ZTtcblx0XHRcdFx0Ly8gRG8gTk9UIHVwZGF0ZSBtYXhMaW5lc1JlbmRlcmVkIGhlcmUgXHUyMDE0IGtlZXAgdGhlIG9sZCB2YWx1ZSBzbyB0aGVcblx0XHRcdFx0Ly8gY29uZGl0aW9uIGBuZXdMaW5lcy5sZW5ndGggPCBtYXhMaW5lc1JlbmRlcmVkYCBzdGlsbCB0cmlnZ2VycyBvblxuXHRcdFx0XHQvLyB0aGUgbmV4dCByZW5kZXIgaWYgY29udGVudCBzdGF5cyBzaHJ1bmsuXG5cdFx0XHRcdGxvZ1JlZHJhdyhgY2xlYXJPblNocmluayBkZWZlcnJlZCAobWF4TGluZXNSZW5kZXJlZD0ke3RoaXMubWF4TGluZXNSZW5kZXJlZH0pYCk7XG5cdFx0XHRcdC8vIEZhbGwgdGhyb3VnaCB0byBkaWZmZXJlbnRpYWwgcmVuZGVyIGZvciB0aGlzIGZyYW1lXG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHQvLyBTdGlsbCBzaHJ1bmsgb24gc2Vjb25kIHJlbmRlciBcdTIwMTQgY29tbWl0IHRoZSBmdWxsIHJlZHJhd1xuXHRcdFx0XHR0aGlzLl9zaHJpbmtEZWJvdW5jZUFjdGl2ZSA9IGZhbHNlO1xuXHRcdFx0XHRsb2dSZWRyYXcoYGNsZWFyT25TaHJpbmsgY29tbWl0dGVkIChtYXhMaW5lc1JlbmRlcmVkPSR7dGhpcy5tYXhMaW5lc1JlbmRlcmVkfSlgKTtcblx0XHRcdFx0ZnVsbFJlbmRlcih0cnVlKTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXHRcdH0gZWxzZSB7XG5cdFx0XHR0aGlzLl9zaHJpbmtEZWJvdW5jZUFjdGl2ZSA9IGZhbHNlO1xuXHRcdH1cblxuXHRcdC8vIEZpbmQgZmlyc3QgYW5kIGxhc3QgY2hhbmdlZCBsaW5lc1xuXHRcdGxldCBmaXJzdENoYW5nZWQgPSAtMTtcblx0XHRsZXQgbGFzdENoYW5nZWQgPSAtMTtcblx0XHRjb25zdCBtYXhMaW5lcyA9IE1hdGgubWF4KG5ld0xpbmVzLmxlbmd0aCwgdGhpcy5wcmV2aW91c0xpbmVzLmxlbmd0aCk7XG5cdFx0Zm9yIChsZXQgaSA9IDA7IGkgPCBtYXhMaW5lczsgaSsrKSB7XG5cdFx0XHRjb25zdCBvbGRMaW5lID0gaSA8IHRoaXMucHJldmlvdXNMaW5lcy5sZW5ndGggPyB0aGlzLnByZXZpb3VzTGluZXNbaV0gOiBcIlwiO1xuXHRcdFx0Y29uc3QgbmV3TGluZSA9IGkgPCBuZXdMaW5lcy5sZW5ndGggPyBuZXdMaW5lc1tpXSA6IFwiXCI7XG5cblx0XHRcdGlmIChvbGRMaW5lICE9PSBuZXdMaW5lKSB7XG5cdFx0XHRcdGlmIChmaXJzdENoYW5nZWQgPT09IC0xKSB7XG5cdFx0XHRcdFx0Zmlyc3RDaGFuZ2VkID0gaTtcblx0XHRcdFx0fVxuXHRcdFx0XHRsYXN0Q2hhbmdlZCA9IGk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdGNvbnN0IGFwcGVuZGVkTGluZXMgPSBuZXdMaW5lcy5sZW5ndGggPiB0aGlzLnByZXZpb3VzTGluZXMubGVuZ3RoO1xuXHRcdGlmIChhcHBlbmRlZExpbmVzKSB7XG5cdFx0XHRpZiAoZmlyc3RDaGFuZ2VkID09PSAtMSkge1xuXHRcdFx0XHRmaXJzdENoYW5nZWQgPSB0aGlzLnByZXZpb3VzTGluZXMubGVuZ3RoO1xuXHRcdFx0fVxuXHRcdFx0bGFzdENoYW5nZWQgPSBuZXdMaW5lcy5sZW5ndGggLSAxO1xuXHRcdH1cblx0XHRjb25zdCBhcHBlbmRTdGFydCA9IGFwcGVuZGVkTGluZXMgJiYgZmlyc3RDaGFuZ2VkID09PSB0aGlzLnByZXZpb3VzTGluZXMubGVuZ3RoICYmIGZpcnN0Q2hhbmdlZCA+IDA7XG5cblx0XHQvLyBObyBjaGFuZ2VzIC0gYnV0IHN0aWxsIG5lZWQgdG8gdXBkYXRlIGhhcmR3YXJlIGN1cnNvciBwb3NpdGlvbiBpZiBpdCBtb3ZlZFxuXHRcdGlmIChmaXJzdENoYW5nZWQgPT09IC0xKSB7XG5cdFx0XHR0aGlzLnBvc2l0aW9uSGFyZHdhcmVDdXJzb3IoY3Vyc29yUG9zLCBuZXdMaW5lcy5sZW5ndGgpO1xuXHRcdFx0dGhpcy5wcmV2aW91c1ZpZXdwb3J0VG9wID0gZ2V0Vmlld3BvcnRUb3AodGhpcy5tYXhMaW5lc1JlbmRlcmVkKTtcblx0XHRcdHRoaXMucHJldmlvdXNIZWlnaHQgPSBoZWlnaHQ7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Ly8gQWxsIGNoYW5nZXMgYXJlIGluIGRlbGV0ZWQgbGluZXMgKG5vdGhpbmcgdG8gcmVuZGVyLCBqdXN0IGNsZWFyKVxuXHRcdGlmIChmaXJzdENoYW5nZWQgPj0gbmV3TGluZXMubGVuZ3RoKSB7XG5cdFx0XHRpZiAodGhpcy5wcmV2aW91c0xpbmVzLmxlbmd0aCA+IG5ld0xpbmVzLmxlbmd0aCkge1xuXHRcdFx0XHRsZXQgYnVmZmVyID0gXCJcXHgxYls/MjAyNmhcIjtcblx0XHRcdFx0Ly8gTW92ZSB0byBlbmQgb2YgbmV3IGNvbnRlbnQgKGNsYW1wIHRvIDAgZm9yIGVtcHR5IGNvbnRlbnQpXG5cdFx0XHRcdGNvbnN0IHRhcmdldFJvdyA9IE1hdGgubWF4KDAsIG5ld0xpbmVzLmxlbmd0aCAtIDEpO1xuXHRcdFx0XHRjb25zdCBsaW5lRGlmZiA9IGNvbXB1dGVMaW5lRGlmZih0YXJnZXRSb3cpO1xuXHRcdFx0XHRpZiAobGluZURpZmYgPiAwKSBidWZmZXIgKz0gYFxceDFiWyR7bGluZURpZmZ9QmA7XG5cdFx0XHRcdGVsc2UgaWYgKGxpbmVEaWZmIDwgMCkgYnVmZmVyICs9IGBcXHgxYlskey1saW5lRGlmZn1BYDtcblx0XHRcdFx0YnVmZmVyICs9IFwiXFxyXCI7XG5cdFx0XHRcdC8vIENsZWFyIGV4dHJhIGxpbmVzIHdpdGhvdXQgc2Nyb2xsaW5nXG5cdFx0XHRcdGNvbnN0IGV4dHJhTGluZXMgPSB0aGlzLnByZXZpb3VzTGluZXMubGVuZ3RoIC0gbmV3TGluZXMubGVuZ3RoO1xuXHRcdFx0XHRpZiAoZXh0cmFMaW5lcyA+IGhlaWdodCkge1xuXHRcdFx0XHRcdGxvZ1JlZHJhdyhgZXh0cmFMaW5lcyA+IGhlaWdodCAoJHtleHRyYUxpbmVzfSA+ICR7aGVpZ2h0fSlgKTtcblx0XHRcdFx0XHRmdWxsUmVuZGVyKHRydWUpO1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXHRcdFx0XHRpZiAoZXh0cmFMaW5lcyA+IDApIHtcblx0XHRcdFx0XHRidWZmZXIgKz0gXCJcXHgxYlsxQlwiO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGZvciAobGV0IGkgPSAwOyBpIDwgZXh0cmFMaW5lczsgaSsrKSB7XG5cdFx0XHRcdFx0YnVmZmVyICs9IFwiXFxyXFx4MWJbMktcIjtcblx0XHRcdFx0XHRpZiAoaSA8IGV4dHJhTGluZXMgLSAxKSBidWZmZXIgKz0gXCJcXHgxYlsxQlwiO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGlmIChleHRyYUxpbmVzID4gMCkge1xuXHRcdFx0XHRcdGJ1ZmZlciArPSBgXFx4MWJbJHtleHRyYUxpbmVzfUFgO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGJ1ZmZlciArPSBcIlxceDFiWz8yMDI2bFwiO1xuXHRcdFx0XHR0aGlzLnRlcm1pbmFsLndyaXRlKGJ1ZmZlcik7XG5cdFx0XHRcdHRoaXMuY3Vyc29yUm93ID0gdGFyZ2V0Um93O1xuXHRcdFx0XHR0aGlzLmhhcmR3YXJlQ3Vyc29yUm93ID0gdGFyZ2V0Um93O1xuXHRcdFx0fVxuXHRcdFx0dGhpcy5wb3NpdGlvbkhhcmR3YXJlQ3Vyc29yKGN1cnNvclBvcywgbmV3TGluZXMubGVuZ3RoKTtcblx0XHRcdHRoaXMucHJldmlvdXNMaW5lcyA9IG5ld0xpbmVzO1xuXHRcdFx0dGhpcy5wcmV2aW91c1dpZHRoID0gd2lkdGg7XG5cdFx0XHR0aGlzLnByZXZpb3VzSGVpZ2h0ID0gaGVpZ2h0O1xuXHRcdFx0dGhpcy5wcmV2aW91c1ZpZXdwb3J0VG9wID0gZ2V0Vmlld3BvcnRUb3AodGhpcy5tYXhMaW5lc1JlbmRlcmVkKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHQvLyBDaGVjayBpZiBmaXJzdENoYW5nZWQgaXMgYWJvdmUgd2hhdCB3YXMgcHJldmlvdXNseSB2aXNpYmxlXG5cdFx0Ly8gVXNlIHByZXZpb3VzTGluZXMubGVuZ3RoIChub3QgbWF4TGluZXNSZW5kZXJlZCkgdG8gYXZvaWQgZmFsc2UgcG9zaXRpdmVzIGFmdGVyIGNvbnRlbnQgc2hyaW5rc1xuXHRcdGNvbnN0IHByZXZpb3VzQ29udGVudFZpZXdwb3J0VG9wID0gZ2V0Vmlld3BvcnRUb3AodGhpcy5wcmV2aW91c0xpbmVzLmxlbmd0aCk7XG5cdFx0aWYgKGZpcnN0Q2hhbmdlZCA8IHByZXZpb3VzQ29udGVudFZpZXdwb3J0VG9wKSB7XG5cdFx0XHQvLyBGaXJzdCBjaGFuZ2UgaXMgYWJvdmUgcHJldmlvdXMgdmlld3BvcnQgLSBuZWVkIGZ1bGwgcmUtcmVuZGVyXG5cdFx0XHRsb2dSZWRyYXcoYGZpcnN0Q2hhbmdlZCA8IHZpZXdwb3J0VG9wICgke2ZpcnN0Q2hhbmdlZH0gPCAke3ByZXZpb3VzQ29udGVudFZpZXdwb3J0VG9wfSlgKTtcblx0XHRcdGZ1bGxSZW5kZXIodHJ1ZSk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Ly8gUmVuZGVyIGZyb20gZmlyc3QgY2hhbmdlZCBsaW5lIHRvIGVuZFxuXHRcdC8vIEJ1aWxkIGJ1ZmZlciB3aXRoIGFsbCB1cGRhdGVzIHdyYXBwZWQgaW4gc3luY2hyb25pemVkIG91dHB1dFxuXHRcdGxldCBidWZmZXIgPSBcIlxceDFiWz8yMDI2aFwiOyAvLyBCZWdpbiBzeW5jaHJvbml6ZWQgb3V0cHV0XG5cdFx0Y29uc3QgcHJldlZpZXdwb3J0Qm90dG9tID0gcHJldlZpZXdwb3J0VG9wICsgaGVpZ2h0IC0gMTtcblx0XHRjb25zdCBtb3ZlVGFyZ2V0Um93ID0gYXBwZW5kU3RhcnQgPyBmaXJzdENoYW5nZWQgLSAxIDogZmlyc3RDaGFuZ2VkO1xuXHRcdGlmIChtb3ZlVGFyZ2V0Um93ID4gcHJldlZpZXdwb3J0Qm90dG9tKSB7XG5cdFx0XHRjb25zdCBjdXJyZW50U2NyZWVuUm93ID0gTWF0aC5tYXgoMCwgTWF0aC5taW4oaGVpZ2h0IC0gMSwgaGFyZHdhcmVDdXJzb3JSb3cgLSBwcmV2Vmlld3BvcnRUb3ApKTtcblx0XHRcdGNvbnN0IG1vdmVUb0JvdHRvbSA9IGhlaWdodCAtIDEgLSBjdXJyZW50U2NyZWVuUm93O1xuXHRcdFx0aWYgKG1vdmVUb0JvdHRvbSA+IDApIHtcblx0XHRcdFx0YnVmZmVyICs9IGBcXHgxYlske21vdmVUb0JvdHRvbX1CYDtcblx0XHRcdH1cblx0XHRcdGNvbnN0IHNjcm9sbCA9IG1vdmVUYXJnZXRSb3cgLSBwcmV2Vmlld3BvcnRCb3R0b207XG5cdFx0XHRidWZmZXIgKz0gXCJcXHJcXG5cIi5yZXBlYXQoc2Nyb2xsKTtcblx0XHRcdHByZXZWaWV3cG9ydFRvcCArPSBzY3JvbGw7XG5cdFx0XHR2aWV3cG9ydFRvcCArPSBzY3JvbGw7XG5cdFx0XHRoYXJkd2FyZUN1cnNvclJvdyA9IG1vdmVUYXJnZXRSb3c7XG5cdFx0fVxuXG5cdFx0Ly8gTW92ZSBjdXJzb3IgdG8gZmlyc3QgY2hhbmdlZCBsaW5lICh1c2UgaGFyZHdhcmVDdXJzb3JSb3cgZm9yIGFjdHVhbCBwb3NpdGlvbilcblx0XHRjb25zdCBsaW5lRGlmZiA9IGNvbXB1dGVMaW5lRGlmZihtb3ZlVGFyZ2V0Um93KTtcblx0XHRpZiAobGluZURpZmYgPiAwKSB7XG5cdFx0XHRidWZmZXIgKz0gYFxceDFiWyR7bGluZURpZmZ9QmA7IC8vIE1vdmUgZG93blxuXHRcdH0gZWxzZSBpZiAobGluZURpZmYgPCAwKSB7XG5cdFx0XHRidWZmZXIgKz0gYFxceDFiWyR7LWxpbmVEaWZmfUFgOyAvLyBNb3ZlIHVwXG5cdFx0fVxuXG5cdFx0YnVmZmVyICs9IGFwcGVuZFN0YXJ0ID8gXCJcXHJcXG5cIiA6IFwiXFxyXCI7IC8vIE1vdmUgdG8gY29sdW1uIDBcblxuXHRcdC8vIE9ubHkgcmVuZGVyIGNoYW5nZWQgbGluZXMgKGZpcnN0Q2hhbmdlZCB0byBsYXN0Q2hhbmdlZCksIG5vdCBhbGwgbGluZXMgdG8gZW5kXG5cdFx0Ly8gVGhpcyByZWR1Y2VzIGZsaWNrZXIgd2hlbiBvbmx5IGEgc2luZ2xlIGxpbmUgY2hhbmdlcyAoZS5nLiwgc3Bpbm5lciBhbmltYXRpb24pXG5cdFx0Y29uc3QgcmVuZGVyRW5kID0gTWF0aC5taW4obGFzdENoYW5nZWQsIG5ld0xpbmVzLmxlbmd0aCAtIDEpO1xuXHRcdGZvciAobGV0IGkgPSBmaXJzdENoYW5nZWQ7IGkgPD0gcmVuZGVyRW5kOyBpKyspIHtcblx0XHRcdGlmIChpID4gZmlyc3RDaGFuZ2VkKSBidWZmZXIgKz0gXCJcXHJcXG5cIjtcblx0XHRcdGJ1ZmZlciArPSBcIlxceDFiWzJLXCI7IC8vIENsZWFyIGN1cnJlbnQgbGluZVxuXHRcdFx0bGV0IGxpbmUgPSBuZXdMaW5lc1tpXTtcblx0XHRcdGNvbnN0IGlzSW1hZ2UgPSBpc0ltYWdlTGluZShsaW5lKTtcblx0XHRcdGlmICghaXNJbWFnZSAmJiB2aXNpYmxlV2lkdGgobGluZSkgPiB3aWR0aCkge1xuXHRcdFx0XHRsaW5lID0gdHJ1bmNhdGVUb1dpZHRoKGxpbmUsIHdpZHRoKTtcblx0XHRcdH1cblx0XHRcdGJ1ZmZlciArPSBsaW5lO1xuXHRcdH1cblxuXHRcdC8vIFRyYWNrIHdoZXJlIGN1cnNvciBlbmRlZCB1cCBhZnRlciByZW5kZXJpbmdcblx0XHRsZXQgZmluYWxDdXJzb3JSb3cgPSByZW5kZXJFbmQ7XG5cblx0XHQvLyBJZiB3ZSBoYWQgbW9yZSBsaW5lcyBiZWZvcmUsIGNsZWFyIHRoZW0gYW5kIG1vdmUgY3Vyc29yIGJhY2tcblx0XHRpZiAodGhpcy5wcmV2aW91c0xpbmVzLmxlbmd0aCA+IG5ld0xpbmVzLmxlbmd0aCkge1xuXHRcdFx0Ly8gTW92ZSB0byBlbmQgb2YgbmV3IGNvbnRlbnQgZmlyc3QgaWYgd2Ugc3RvcHBlZCBiZWZvcmUgaXRcblx0XHRcdGlmIChyZW5kZXJFbmQgPCBuZXdMaW5lcy5sZW5ndGggLSAxKSB7XG5cdFx0XHRcdGNvbnN0IG1vdmVEb3duID0gbmV3TGluZXMubGVuZ3RoIC0gMSAtIHJlbmRlckVuZDtcblx0XHRcdFx0YnVmZmVyICs9IGBcXHgxYlske21vdmVEb3dufUJgO1xuXHRcdFx0XHRmaW5hbEN1cnNvclJvdyA9IG5ld0xpbmVzLmxlbmd0aCAtIDE7XG5cdFx0XHR9XG5cdFx0XHRjb25zdCBleHRyYUxpbmVzID0gdGhpcy5wcmV2aW91c0xpbmVzLmxlbmd0aCAtIG5ld0xpbmVzLmxlbmd0aDtcblx0XHRcdGZvciAobGV0IGkgPSBuZXdMaW5lcy5sZW5ndGg7IGkgPCB0aGlzLnByZXZpb3VzTGluZXMubGVuZ3RoOyBpKyspIHtcblx0XHRcdFx0YnVmZmVyICs9IFwiXFxyXFxuXFx4MWJbMktcIjtcblx0XHRcdH1cblx0XHRcdC8vIE1vdmUgY3Vyc29yIGJhY2sgdG8gZW5kIG9mIG5ldyBjb250ZW50XG5cdFx0XHRidWZmZXIgKz0gYFxceDFiWyR7ZXh0cmFMaW5lc31BYDtcblx0XHR9XG5cblx0XHRidWZmZXIgKz0gXCJcXHgxYls/MjAyNmxcIjsgLy8gRW5kIHN5bmNocm9uaXplZCBvdXRwdXRcblxuXHRcdGlmIChwcm9jZXNzLmVudi5QSV9UVUlfREVCVUcgPT09IFwiMVwiKSB7XG5cdFx0XHRjb25zdCBkZWJ1Z0RpciA9IHBhdGguam9pbihvcy50bXBkaXIoKSwgXCJ0dWlcIik7XG5cdFx0XHRmcy5ta2RpclN5bmMoZGVidWdEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXHRcdFx0Y29uc3QgZGVidWdQYXRoID0gcGF0aC5qb2luKGRlYnVnRGlyLCBgcmVuZGVyLSR7RGF0ZS5ub3coKX0tJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyKX0ubG9nYCk7XG5cdFx0XHRjb25zdCBkZWJ1Z0RhdGEgPSBbXG5cdFx0XHRcdGBmaXJzdENoYW5nZWQ6ICR7Zmlyc3RDaGFuZ2VkfWAsXG5cdFx0XHRcdGB2aWV3cG9ydFRvcDogJHt2aWV3cG9ydFRvcH1gLFxuXHRcdFx0XHRgY3Vyc29yUm93OiAke3RoaXMuY3Vyc29yUm93fWAsXG5cdFx0XHRcdGBoZWlnaHQ6ICR7aGVpZ2h0fWAsXG5cdFx0XHRcdGBsaW5lRGlmZjogJHtsaW5lRGlmZn1gLFxuXHRcdFx0XHRgaGFyZHdhcmVDdXJzb3JSb3c6ICR7aGFyZHdhcmVDdXJzb3JSb3d9YCxcblx0XHRcdFx0YHJlbmRlckVuZDogJHtyZW5kZXJFbmR9YCxcblx0XHRcdFx0YGZpbmFsQ3Vyc29yUm93OiAke2ZpbmFsQ3Vyc29yUm93fWAsXG5cdFx0XHRcdGBjdXJzb3JQb3M6ICR7SlNPTi5zdHJpbmdpZnkoY3Vyc29yUG9zKX1gLFxuXHRcdFx0XHRgbmV3TGluZXMubGVuZ3RoOiAke25ld0xpbmVzLmxlbmd0aH1gLFxuXHRcdFx0XHRgcHJldmlvdXNMaW5lcy5sZW5ndGg6ICR7dGhpcy5wcmV2aW91c0xpbmVzLmxlbmd0aH1gLFxuXHRcdFx0XHRcIlwiLFxuXHRcdFx0XHRcIj09PSBuZXdMaW5lcyA9PT1cIixcblx0XHRcdFx0SlNPTi5zdHJpbmdpZnkobmV3TGluZXMsIG51bGwsIDIpLFxuXHRcdFx0XHRcIlwiLFxuXHRcdFx0XHRcIj09PSBwcmV2aW91c0xpbmVzID09PVwiLFxuXHRcdFx0XHRKU09OLnN0cmluZ2lmeSh0aGlzLnByZXZpb3VzTGluZXMsIG51bGwsIDIpLFxuXHRcdFx0XHRcIlwiLFxuXHRcdFx0XHRcIj09PSBidWZmZXIgPT09XCIsXG5cdFx0XHRcdEpTT04uc3RyaW5naWZ5KGJ1ZmZlciksXG5cdFx0XHRdLmpvaW4oXCJcXG5cIik7XG5cdFx0XHRmcy53cml0ZUZpbGVTeW5jKGRlYnVnUGF0aCwgZGVidWdEYXRhKTtcblx0XHR9XG5cblx0XHQvLyBXcml0ZSBlbnRpcmUgYnVmZmVyIGF0IG9uY2Vcblx0XHR0aGlzLnRlcm1pbmFsLndyaXRlKGJ1ZmZlcik7XG5cblx0XHQvLyBUcmFjayBjdXJzb3IgcG9zaXRpb24gZm9yIG5leHQgcmVuZGVyXG5cdFx0Ly8gY3Vyc29yUm93IHRyYWNrcyBlbmQgb2YgY29udGVudCAoZm9yIHZpZXdwb3J0IGNhbGN1bGF0aW9uKVxuXHRcdC8vIGhhcmR3YXJlQ3Vyc29yUm93IHRyYWNrcyBhY3R1YWwgdGVybWluYWwgY3Vyc29yIHBvc2l0aW9uIChmb3IgbW92ZW1lbnQpXG5cdFx0dGhpcy5jdXJzb3JSb3cgPSBNYXRoLm1heCgwLCBuZXdMaW5lcy5sZW5ndGggLSAxKTtcblx0XHR0aGlzLmhhcmR3YXJlQ3Vyc29yUm93ID0gZmluYWxDdXJzb3JSb3c7XG5cdFx0Ly8gVHJhY2sgdGVybWluYWwncyB3b3JraW5nIGFyZWEgKGdyb3dzIGJ1dCBkb2Vzbid0IHNocmluayB1bmxlc3MgY2xlYXJlZClcblx0XHR0aGlzLm1heExpbmVzUmVuZGVyZWQgPSBNYXRoLm1heCh0aGlzLm1heExpbmVzUmVuZGVyZWQsIG5ld0xpbmVzLmxlbmd0aCk7XG5cdFx0dGhpcy5wcmV2aW91c1ZpZXdwb3J0VG9wID0gZ2V0Vmlld3BvcnRUb3AodGhpcy5tYXhMaW5lc1JlbmRlcmVkKTtcblxuXHRcdC8vIFBvc2l0aW9uIGhhcmR3YXJlIGN1cnNvciBmb3IgSU1FXG5cdFx0dGhpcy5wb3NpdGlvbkhhcmR3YXJlQ3Vyc29yKGN1cnNvclBvcywgbmV3TGluZXMubGVuZ3RoKTtcblxuXHRcdHRoaXMucHJldmlvdXNMaW5lcyA9IG5ld0xpbmVzO1xuXHRcdHRoaXMucHJldmlvdXNXaWR0aCA9IHdpZHRoO1xuXHRcdHRoaXMucHJldmlvdXNIZWlnaHQgPSBoZWlnaHQ7XG5cdH1cblxuXHQvKipcblx0ICogUG9zaXRpb24gdGhlIGhhcmR3YXJlIGN1cnNvciBmb3IgSU1FIGNhbmRpZGF0ZSB3aW5kb3cuXG5cdCAqIEBwYXJhbSBjdXJzb3JQb3MgVGhlIGN1cnNvciBwb3NpdGlvbiBleHRyYWN0ZWQgZnJvbSByZW5kZXJlZCBvdXRwdXQsIG9yIG51bGxcblx0ICogQHBhcmFtIHRvdGFsTGluZXMgVG90YWwgbnVtYmVyIG9mIHJlbmRlcmVkIGxpbmVzXG5cdCAqL1xuXHRwcml2YXRlIHBvc2l0aW9uSGFyZHdhcmVDdXJzb3IoY3Vyc29yUG9zOiB7IHJvdzogbnVtYmVyOyBjb2w6IG51bWJlciB9IHwgbnVsbCwgdG90YWxMaW5lczogbnVtYmVyKTogdm9pZCB7XG5cdFx0aWYgKCFjdXJzb3JQb3MgfHwgdG90YWxMaW5lcyA8PSAwKSB7XG5cdFx0XHR0aGlzLnRlcm1pbmFsLmhpZGVDdXJzb3IoKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHQvLyBDbGFtcCBjdXJzb3IgcG9zaXRpb24gdG8gdmFsaWQgcmFuZ2Vcblx0XHRjb25zdCB0YXJnZXRSb3cgPSBNYXRoLm1heCgwLCBNYXRoLm1pbihjdXJzb3JQb3Mucm93LCB0b3RhbExpbmVzIC0gMSkpO1xuXHRcdGNvbnN0IHRhcmdldENvbCA9IE1hdGgubWF4KDAsIGN1cnNvclBvcy5jb2wpO1xuXG5cdFx0Ly8gTW92ZSBjdXJzb3IgZnJvbSBjdXJyZW50IHBvc2l0aW9uIHRvIHRhcmdldFxuXHRcdGNvbnN0IHJvd0RlbHRhID0gdGFyZ2V0Um93IC0gdGhpcy5oYXJkd2FyZUN1cnNvclJvdztcblx0XHRsZXQgYnVmZmVyID0gXCJcIjtcblx0XHRpZiAocm93RGVsdGEgPiAwKSB7XG5cdFx0XHRidWZmZXIgKz0gYFxceDFiWyR7cm93RGVsdGF9QmA7IC8vIE1vdmUgZG93blxuXHRcdH0gZWxzZSBpZiAocm93RGVsdGEgPCAwKSB7XG5cdFx0XHRidWZmZXIgKz0gYFxceDFiWyR7LXJvd0RlbHRhfUFgOyAvLyBNb3ZlIHVwXG5cdFx0fVxuXHRcdC8vIE1vdmUgdG8gYWJzb2x1dGUgY29sdW1uICgxLWluZGV4ZWQpXG5cdFx0YnVmZmVyICs9IGBcXHgxYlske3RhcmdldENvbCArIDF9R2A7XG5cblx0XHRpZiAoYnVmZmVyKSB7XG5cdFx0XHR0aGlzLnRlcm1pbmFsLndyaXRlKGJ1ZmZlcik7XG5cdFx0fVxuXG5cdFx0dGhpcy5oYXJkd2FyZUN1cnNvclJvdyA9IHRhcmdldFJvdztcblx0XHRpZiAodGhpcy5zaG93SGFyZHdhcmVDdXJzb3IpIHtcblx0XHRcdHRoaXMudGVybWluYWwuc2hvd0N1cnNvcigpO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHR0aGlzLnRlcm1pbmFsLmhpZGVDdXJzb3IoKTtcblx0XHR9XG5cdH1cbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUtBLFlBQVksUUFBUTtBQUNwQixZQUFZLFFBQVE7QUFDcEIsWUFBWSxVQUFVO0FBQ3RCLFNBQVMsY0FBYyxrQkFBa0I7QUFDekM7QUFBQSxFQUNDO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBLG9CQUFvQjtBQUFBLE9BQ2Q7QUFFUCxTQUFTLGlCQUFpQixhQUFhLHlCQUF5QjtBQUNoRSxTQUFTLGlCQUFpQixvQkFBb0I7QUE4Q3ZDLFNBQVMsWUFBWSxXQUFpRTtBQUM1RixTQUFPLGNBQWMsUUFBUSxhQUFhO0FBQzNDO0FBUU8sTUFBTSxnQkFBZ0I7QUFnR3RCLE1BQU0sVUFBK0I7QUFBQSxFQUFyQztBQUNOLG9CQUF3QixDQUFDO0FBQ3pCLFNBQVEsY0FBK0I7QUFBQTtBQUFBLEVBRXZDLFNBQVMsV0FBNEI7QUFDcEMsU0FBSyxTQUFTLEtBQUssU0FBUztBQUM1QixTQUFLLGNBQWM7QUFBQSxFQUNwQjtBQUFBLEVBRUEsWUFBWSxXQUE0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LEdBQUc7QUFDbEMsV0FBSyxTQUFTLFdBQVc7QUFDekI7QUFBQSxJQUNEO0FBR0EsVUFBTSxZQUFZLEtBQUssSUFBSSxHQUFHLEtBQUssSUFBSSxVQUFVLEtBQUssYUFBYSxDQUFDLENBQUM7QUFDckUsVUFBTSxZQUFZLEtBQUssSUFBSSxHQUFHLFVBQVUsR0FBRztBQUczQyxVQUFNLFdBQVcsWUFBWSxLQUFLO0FBQ2xDLFFBQUksU0FBUztBQUNiLFFBQUksV0FBVyxHQUFHO0FBQ2pCLGdCQUFVLFFBQVEsUUFBUTtBQUFBLElBQzNCLFdBQVcsV0FBVyxHQUFHO0FBQ3hCLGdCQUFVLFFBQVEsQ0FBQyxRQUFRO0FBQUEsSUFDNUI7QUFFQSxjQUFVLFFBQVEsWUFBWSxDQUFDO0FBRS9CLFFBQUksUUFBUTtBQUNYLFdBQUssU0FBUyxNQUFNLE1BQU07QUFBQSxJQUMzQjtBQUVBLFNBQUssb0JBQW9CO0FBQ3pCLFFBQUksS0FBSyxvQkFBb0I7QUFDNUIsV0FBSyxTQUFTLFdBQVc7QUFBQSxJQUMxQixPQUFPO0FBQ04sV0FBSyxTQUFTLFdBQVc7QUFBQSxJQUMxQjtBQUFBLEVBQ0Q7QUFDRDsiLAogICJuYW1lcyI6IFsicmVzdWx0IiwgImJ1ZmZlciIsICJsaW5lRGlmZiJdCn0K
