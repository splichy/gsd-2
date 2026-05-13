import { getEditorKeybindings } from "../keybindings.js";
import { decodeKittyPrintable, matchesKey } from "../keys.js";
import { KillRing } from "../kill-ring.js";
import { CURSOR_MARKER } from "../tui.js";
import { UndoStack } from "../undo-stack.js";
import { getSegmenter, isPunctuationChar, isWhitespaceChar, visibleWidth } from "../utils.js";
import { SelectList } from "./select-list.js";
const segmenter = getSegmenter();
function wordWrapLine(line, maxWidth) {
  if (!line || maxWidth <= 0) {
    return [{ text: "", startIndex: 0, endIndex: 0 }];
  }
  const lineWidth = visibleWidth(line);
  if (lineWidth <= maxWidth) {
    return [{ text: line, startIndex: 0, endIndex: line.length }];
  }
  const chunks = [];
  const segments = [...segmenter.segment(line)];
  let currentWidth = 0;
  let chunkStart = 0;
  let wrapOppIndex = -1;
  let wrapOppWidth = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const grapheme = seg.segment;
    const gWidth = visibleWidth(grapheme);
    const charIndex = seg.index;
    const isWs = isWhitespaceChar(grapheme);
    if (currentWidth + gWidth > maxWidth) {
      if (wrapOppIndex >= 0) {
        chunks.push({ text: line.slice(chunkStart, wrapOppIndex), startIndex: chunkStart, endIndex: wrapOppIndex });
        chunkStart = wrapOppIndex;
        currentWidth -= wrapOppWidth;
      } else if (chunkStart < charIndex) {
        chunks.push({ text: line.slice(chunkStart, charIndex), startIndex: chunkStart, endIndex: charIndex });
        chunkStart = charIndex;
        currentWidth = 0;
      }
      wrapOppIndex = -1;
    }
    currentWidth += gWidth;
    const next = segments[i + 1];
    if (isWs && next && !isWhitespaceChar(next.segment)) {
      wrapOppIndex = next.index;
      wrapOppWidth = currentWidth;
    }
  }
  chunks.push({ text: line.slice(chunkStart), startIndex: chunkStart, endIndex: line.length });
  return chunks;
}
class Editor {
  constructor(tui, theme, options = {}) {
    this.state = {
      lines: [""],
      cursorLine: 0,
      cursorCol: 0
    };
    /** Focusable interface - set by TUI when focus changes */
    this._focused = false;
    this.paddingX = 0;
    // Store last render width for cursor navigation
    this.lastWidth = 80;
    // Vertical scrolling support
    this.scrollOffset = 0;
    this.autocompleteState = null;
    this.autocompletePrefix = "";
    this.autocompleteMaxVisible = 5;
    // Debounce for @ file autocomplete to prevent blocking the event loop
    // with synchronous fuzzyFind calls on every keystroke
    this.autocompleteDebounceTimer = null;
    this.lastAutocompleteLookupPrefix = null;
    // Paste tracking for large pastes
    this.pastes = /* @__PURE__ */ new Map();
    this.pasteCounter = 0;
    // Bracketed paste mode buffering
    this.pasteBuffer = "";
    this.isInPaste = false;
    // Prompt history for up/down navigation
    this.history = [];
    this.historyIndex = -1;
    // -1 = not browsing, 0 = most recent, 1 = older, etc.
    // Kill ring for Emacs-style kill/yank operations
    this.killRing = new KillRing();
    this.lastAction = null;
    // Character jump mode
    this.jumpMode = null;
    // Preferred visual column for vertical cursor movement (sticky column)
    this.preferredVisualCol = null;
    // Undo support
    this.undoStack = new UndoStack();
    this.textVersion = 0;
    this.cachedText = null;
    this.layoutCache = null;
    this.visualLineMapCache = null;
    this.disableSubmit = false;
    this.tui = tui;
    this.theme = theme;
    this.borderColor = theme.borderColor;
    const paddingX = options.paddingX ?? 0;
    this.paddingX = Number.isFinite(paddingX) ? Math.max(0, Math.floor(paddingX)) : 0;
    const maxVisible = options.autocompleteMaxVisible ?? 5;
    this.autocompleteMaxVisible = Number.isFinite(maxVisible) ? Math.max(3, Math.min(20, Math.floor(maxVisible))) : 5;
  }
  get focused() {
    return this._focused;
  }
  set focused(value) {
    this._focused = value;
    if (!value) {
      this.isInPaste = false;
      this.pasteBuffer = "";
    }
  }
  static {
    this.AUTOCOMPLETE_DEBOUNCE_MS = 150;
  }
  getPaddingX() {
    return this.paddingX;
  }
  setPaddingX(padding) {
    const newPadding = Number.isFinite(padding) ? Math.max(0, Math.floor(padding)) : 0;
    if (this.paddingX !== newPadding) {
      this.paddingX = newPadding;
      this.tui.requestRender();
    }
  }
  getAutocompleteMaxVisible() {
    return this.autocompleteMaxVisible;
  }
  setAutocompleteMaxVisible(maxVisible) {
    const newMaxVisible = Number.isFinite(maxVisible) ? Math.max(3, Math.min(20, Math.floor(maxVisible))) : 5;
    if (this.autocompleteMaxVisible !== newMaxVisible) {
      this.autocompleteMaxVisible = newMaxVisible;
      this.tui.requestRender();
    }
  }
  setAutocompleteProvider(provider) {
    this.autocompleteProvider = provider;
  }
  clearLayoutCaches() {
    this.layoutCache = null;
    this.visualLineMapCache = null;
  }
  emitChange() {
    this.textVersion += 1;
    this.cachedText = null;
    this.clearLayoutCaches();
    if (this.onChange) {
      this.onChange(this.getText());
    }
  }
  getLayoutLines(width) {
    const cached = this.layoutCache;
    if (cached && cached.width === width && cached.textVersion === this.textVersion && cached.cursorLine === this.state.cursorLine && cached.cursorCol === this.state.cursorCol) {
      return cached.lines;
    }
    const lines = this.layoutText(width);
    this.layoutCache = {
      width,
      textVersion: this.textVersion,
      lines,
      cursorLine: this.state.cursorLine,
      cursorCol: this.state.cursorCol
    };
    return lines;
  }
  /**
   * Add a prompt to history for up/down arrow navigation.
   * Called after successful submission.
   */
  addToHistory(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.history.length > 0 && this.history[0] === trimmed) return;
    this.history.unshift(trimmed);
    if (this.history.length > 100) {
      this.history.pop();
    }
  }
  isEditorEmpty() {
    return this.state.lines.length === 1 && this.state.lines[0] === "";
  }
  isOnFirstVisualLine() {
    const visualLines = this.buildVisualLineMap(this.lastWidth);
    const currentVisualLine = this.findCurrentVisualLine(visualLines);
    return currentVisualLine === 0;
  }
  isOnLastVisualLine() {
    const visualLines = this.buildVisualLineMap(this.lastWidth);
    const currentVisualLine = this.findCurrentVisualLine(visualLines);
    return currentVisualLine === visualLines.length - 1;
  }
  navigateHistory(direction) {
    this.lastAction = null;
    if (this.history.length === 0) return;
    const newIndex = this.historyIndex - direction;
    if (newIndex < -1 || newIndex >= this.history.length) return;
    if (this.historyIndex === -1 && newIndex >= 0) {
      this.pushUndoSnapshot();
    }
    this.historyIndex = newIndex;
    if (this.historyIndex === -1) {
      this.setTextInternal("");
    } else {
      this.setTextInternal(this.history[this.historyIndex] || "");
    }
  }
  /** Internal setText that doesn't reset history state - used by navigateHistory */
  setTextInternal(text) {
    const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    this.state.lines = lines.length === 0 ? [""] : lines;
    this.state.cursorLine = this.state.lines.length - 1;
    this.setCursorCol(this.state.lines[this.state.cursorLine]?.length || 0);
    this.scrollOffset = 0;
    this.emitChange();
  }
  invalidate() {
    this.clearLayoutCaches();
  }
  render(width) {
    const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
    const paddingX = Math.min(this.paddingX, maxPadding);
    const contentWidth = Math.max(1, width - paddingX * 2);
    const layoutWidth = Math.max(1, contentWidth - (paddingX ? 0 : 1));
    this.lastWidth = layoutWidth;
    const horizontal = this.borderColor("\u2500");
    const layoutLines = this.getLayoutLines(layoutWidth);
    const terminalRows = this.tui.terminal.rows;
    const maxVisibleLines = Math.max(5, Math.floor(terminalRows * 0.3));
    let cursorLineIndex = layoutLines.findIndex((line) => line.hasCursor);
    if (cursorLineIndex === -1) cursorLineIndex = 0;
    if (cursorLineIndex < this.scrollOffset) {
      this.scrollOffset = cursorLineIndex;
    } else if (cursorLineIndex >= this.scrollOffset + maxVisibleLines) {
      this.scrollOffset = cursorLineIndex - maxVisibleLines + 1;
    }
    const maxScrollOffset = Math.max(0, layoutLines.length - maxVisibleLines);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScrollOffset));
    const visibleLines = layoutLines.slice(this.scrollOffset, this.scrollOffset + maxVisibleLines);
    const result = [];
    const leftPadding = " ".repeat(paddingX);
    const rightPadding = leftPadding;
    if (this.scrollOffset > 0) {
      const indicator = `\u2500\u2500\u2500 \u2191 ${this.scrollOffset} more `;
      const remaining = width - visibleWidth(indicator);
      result.push(this.borderColor(indicator + "\u2500".repeat(Math.max(0, remaining))));
    } else {
      result.push(horizontal.repeat(width));
    }
    const emitCursorMarker = this.focused;
    for (const layoutLine of visibleLines) {
      let displayText = layoutLine.text;
      let lineVisibleWidth = visibleWidth(layoutLine.text);
      let cursorInPadding = false;
      if (layoutLine.hasCursor && layoutLine.cursorPos !== void 0) {
        const before = displayText.slice(0, layoutLine.cursorPos);
        const after = displayText.slice(layoutLine.cursorPos);
        const marker = emitCursorMarker ? CURSOR_MARKER : "";
        if (after.length > 0) {
          const afterGraphemes = [...segmenter.segment(after)];
          const firstGrapheme = afterGraphemes[0]?.segment || "";
          const restAfter = after.slice(firstGrapheme.length);
          const cursor = `\x1B[7m${firstGrapheme}\x1B[0m`;
          displayText = before + marker + cursor + restAfter;
        } else {
          const cursor = "\x1B[7m \x1B[0m";
          displayText = before + marker + cursor;
          lineVisibleWidth = lineVisibleWidth + 1;
          if (lineVisibleWidth > contentWidth && paddingX > 0) {
            cursorInPadding = true;
          }
        }
      }
      const padding = " ".repeat(Math.max(0, contentWidth - lineVisibleWidth));
      const lineRightPadding = cursorInPadding ? rightPadding.slice(1) : rightPadding;
      result.push(`${leftPadding}${displayText}${padding}${lineRightPadding}`);
    }
    const linesBelow = layoutLines.length - (this.scrollOffset + visibleLines.length);
    if (linesBelow > 0) {
      const indicator = `\u2500\u2500\u2500 \u2193 ${linesBelow} more `;
      const remaining = width - visibleWidth(indicator);
      result.push(this.borderColor(indicator + "\u2500".repeat(Math.max(0, remaining))));
    } else {
      result.push(horizontal.repeat(width));
    }
    if (this.autocompleteState && this.autocompleteList) {
      const autocompleteResult = this.autocompleteList.render(contentWidth);
      for (const line of autocompleteResult) {
        const lineWidth = visibleWidth(line);
        const linePadding = " ".repeat(Math.max(0, contentWidth - lineWidth));
        result.push(`${leftPadding}${line}${linePadding}${rightPadding}`);
      }
    }
    return result;
  }
  handleInput(data) {
    const kb = getEditorKeybindings();
    if (this.jumpMode !== null) {
      if (kb.matches(data, "jumpForward") || kb.matches(data, "jumpBackward")) {
        this.jumpMode = null;
        return;
      }
      if (data.charCodeAt(0) >= 32) {
        const direction = this.jumpMode;
        this.jumpMode = null;
        this.jumpToChar(data, direction);
        return;
      }
      this.jumpMode = null;
    }
    if (data.includes("\x1B[200~")) {
      this.isInPaste = true;
      this.pasteBuffer = "";
      data = data.replace("\x1B[200~", "");
    }
    if (this.isInPaste) {
      this.pasteBuffer += data;
      const endIndex = this.pasteBuffer.indexOf("\x1B[201~");
      if (endIndex !== -1) {
        const pasteContent = this.pasteBuffer.substring(0, endIndex);
        if (pasteContent.length > 0) {
          this.handlePaste(pasteContent);
        }
        this.isInPaste = false;
        const remaining = this.pasteBuffer.substring(endIndex + 6);
        this.pasteBuffer = "";
        if (remaining.length > 0) {
          this.handleInput(remaining);
        }
        return;
      }
      return;
    }
    if (kb.matches(data, "copy")) {
      return;
    }
    if (kb.matches(data, "undo")) {
      this.undo();
      return;
    }
    if (this.autocompleteState && this.autocompleteList) {
      if (kb.matches(data, "selectCancel")) {
        this.cancelAutocomplete();
        return;
      }
      if (kb.matches(data, "selectUp") || kb.matches(data, "selectDown")) {
        this.autocompleteList.handleInput(data);
        return;
      }
      if (kb.matches(data, "tab")) {
        const selected = this.autocompleteList.getSelectedItem();
        if (selected && this.autocompleteProvider) {
          const shouldChainSlashArgumentAutocomplete = this.shouldChainSlashArgumentAutocompleteOnTabSelection();
          this.pushUndoSnapshot();
          this.lastAction = null;
          const result = this.autocompleteProvider.applyCompletion(
            this.state.lines,
            this.state.cursorLine,
            this.state.cursorCol,
            selected,
            this.autocompletePrefix
          );
          this.state.lines = result.lines;
          this.state.cursorLine = result.cursorLine;
          this.setCursorCol(result.cursorCol);
          this.cancelAutocomplete();
          this.emitChange();
          if (shouldChainSlashArgumentAutocomplete && this.isBareCompletedSlashCommandAtCursor()) {
            this.tryTriggerAutocomplete();
          }
        }
        return;
      }
      if (kb.matches(data, "selectConfirm")) {
        const selected = this.autocompleteList.getSelectedItem();
        if (selected && this.autocompleteProvider) {
          this.pushUndoSnapshot();
          this.lastAction = null;
          const result = this.autocompleteProvider.applyCompletion(
            this.state.lines,
            this.state.cursorLine,
            this.state.cursorCol,
            selected,
            this.autocompletePrefix
          );
          this.state.lines = result.lines;
          this.state.cursorLine = result.cursorLine;
          this.setCursorCol(result.cursorCol);
          if (this.autocompletePrefix.startsWith("/") || this.isInSlashCommandContext(
            (this.state.lines[this.state.cursorLine] || "").slice(0, this.state.cursorCol)
          )) {
            this.cancelAutocomplete();
          } else {
            this.cancelAutocomplete();
            this.emitChange();
            return;
          }
        }
      }
    }
    if (kb.matches(data, "tab") && !this.autocompleteState) {
      this.handleTabCompletion();
      return;
    }
    if (kb.matches(data, "deleteToLineEnd")) {
      this.deleteToEndOfLine();
      return;
    }
    if (kb.matches(data, "deleteToLineStart")) {
      this.deleteToStartOfLine();
      return;
    }
    if (kb.matches(data, "deleteWordBackward")) {
      this.deleteWordBackwards();
      return;
    }
    if (kb.matches(data, "deleteWordForward")) {
      this.deleteWordForward();
      return;
    }
    if (kb.matches(data, "deleteCharBackward") || matchesKey(data, "shift+backspace")) {
      this.handleBackspace();
      return;
    }
    if (kb.matches(data, "deleteCharForward") || matchesKey(data, "shift+delete")) {
      this.handleForwardDelete();
      return;
    }
    if (kb.matches(data, "yank")) {
      this.yank();
      return;
    }
    if (kb.matches(data, "yankPop")) {
      this.yankPop();
      return;
    }
    if (kb.matches(data, "cursorLineStart")) {
      this.moveToLineStart();
      return;
    }
    if (kb.matches(data, "cursorLineEnd")) {
      this.moveToLineEnd();
      return;
    }
    if (kb.matches(data, "cursorWordLeft")) {
      this.moveWordBackwards();
      return;
    }
    if (kb.matches(data, "cursorWordRight")) {
      this.moveWordForwards();
      return;
    }
    if (kb.matches(data, "newLine") || data.charCodeAt(0) === 10 && data.length > 1 || data === "\x1B\r" || data === "\x1B[13;2~" || data.length > 1 && data.includes("\x1B") && data.includes("\r") || data === "\n" && data.length === 1) {
      if (this.shouldSubmitOnBackslashEnter(data, kb)) {
        this.handleBackspace();
        this.submitValue();
        return;
      }
      this.addNewLine();
      return;
    }
    if (kb.matches(data, "submit")) {
      if (this.disableSubmit) return;
      const currentLine = this.state.lines[this.state.cursorLine] || "";
      if (this.state.cursorCol > 0 && currentLine[this.state.cursorCol - 1] === "\\") {
        this.handleBackspace();
        this.addNewLine();
        return;
      }
      this.submitValue();
      return;
    }
    if (kb.matches(data, "cursorUp")) {
      if (this.isEditorEmpty()) {
        this.navigateHistory(-1);
      } else if (this.historyIndex > -1 && this.isOnFirstVisualLine()) {
        this.navigateHistory(-1);
      } else if (this.isOnFirstVisualLine()) {
        this.moveToLineStart();
      } else {
        this.moveCursor(-1, 0);
      }
      return;
    }
    if (kb.matches(data, "cursorDown")) {
      if (this.historyIndex > -1 && this.isOnLastVisualLine()) {
        this.navigateHistory(1);
      } else if (this.isOnLastVisualLine()) {
        this.moveToLineEnd();
      } else {
        this.moveCursor(1, 0);
      }
      return;
    }
    if (kb.matches(data, "cursorRight")) {
      this.moveCursor(0, 1);
      return;
    }
    if (kb.matches(data, "cursorLeft")) {
      this.moveCursor(0, -1);
      return;
    }
    if (kb.matches(data, "pageUp")) {
      this.pageScroll(-1);
      return;
    }
    if (kb.matches(data, "pageDown")) {
      this.pageScroll(1);
      return;
    }
    if (kb.matches(data, "jumpForward")) {
      this.jumpMode = "forward";
      return;
    }
    if (kb.matches(data, "jumpBackward")) {
      this.jumpMode = "backward";
      return;
    }
    if (matchesKey(data, "shift+space")) {
      this.insertCharacter(" ");
      return;
    }
    const kittyPrintable = decodeKittyPrintable(data);
    if (kittyPrintable !== void 0) {
      this.insertCharacter(kittyPrintable);
      return;
    }
    if (data.charCodeAt(0) >= 32) {
      if (data[0] === "[" && data.length >= 2 && data.length <= 8) {
        const last = data[data.length - 1];
        if (/^[A-FHZ]$/.test(last) || last === "~") {
          return;
        }
      }
      this.insertCharacter(data);
    }
  }
  layoutText(contentWidth) {
    const layoutLines = [];
    if (this.state.lines.length === 0 || this.state.lines.length === 1 && this.state.lines[0] === "") {
      layoutLines.push({
        text: "",
        hasCursor: true,
        cursorPos: 0
      });
      return layoutLines;
    }
    for (let i = 0; i < this.state.lines.length; i++) {
      const line = this.state.lines[i] || "";
      const isCurrentLine = i === this.state.cursorLine;
      const lineVisibleWidth = visibleWidth(line);
      if (lineVisibleWidth <= contentWidth) {
        if (isCurrentLine) {
          layoutLines.push({
            text: line,
            hasCursor: true,
            cursorPos: this.state.cursorCol
          });
        } else {
          layoutLines.push({
            text: line,
            hasCursor: false
          });
        }
      } else {
        const chunks = wordWrapLine(line, contentWidth);
        for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
          const chunk = chunks[chunkIndex];
          if (!chunk) continue;
          const cursorPos = this.state.cursorCol;
          const isLastChunk = chunkIndex === chunks.length - 1;
          let hasCursorInChunk = false;
          let adjustedCursorPos = 0;
          if (isCurrentLine) {
            if (isLastChunk) {
              hasCursorInChunk = cursorPos >= chunk.startIndex;
              adjustedCursorPos = cursorPos - chunk.startIndex;
            } else {
              hasCursorInChunk = cursorPos >= chunk.startIndex && cursorPos < chunk.endIndex;
              if (hasCursorInChunk) {
                adjustedCursorPos = cursorPos - chunk.startIndex;
                if (adjustedCursorPos > chunk.text.length) {
                  adjustedCursorPos = chunk.text.length;
                }
              }
            }
          }
          if (hasCursorInChunk) {
            layoutLines.push({
              text: chunk.text,
              hasCursor: true,
              cursorPos: adjustedCursorPos
            });
          } else {
            layoutLines.push({
              text: chunk.text,
              hasCursor: false
            });
          }
        }
      }
    }
    return layoutLines;
  }
  getText() {
    if (this.cachedText === null) {
      this.cachedText = this.state.lines.join("\n");
    }
    return this.cachedText;
  }
  /**
   * Get text with paste markers expanded to their actual content.
   * Use this when you need the full content (e.g., for external editor).
   */
  getExpandedText() {
    let result = this.state.lines.join("\n");
    for (const [pasteId, pasteContent] of this.pastes) {
      const markerRegex = new RegExp(`\\[paste #${pasteId}( (\\+\\d+ lines|\\d+ chars))?\\]`, "g");
      result = result.replace(markerRegex, pasteContent);
    }
    return result;
  }
  getLines() {
    return [...this.state.lines];
  }
  getCursor() {
    return { line: this.state.cursorLine, col: this.state.cursorCol };
  }
  setText(text) {
    this.lastAction = null;
    this.historyIndex = -1;
    if (this.getText() !== text) {
      this.pushUndoSnapshot();
    }
    this.setTextInternal(text);
  }
  /**
   * Insert text at the current cursor position.
   * Used for programmatic insertion (e.g., clipboard image markers).
   * This is atomic for undo - single undo restores entire pre-insert state.
   */
  insertTextAtCursor(text) {
    if (!text) return;
    this.pushUndoSnapshot();
    this.lastAction = null;
    this.historyIndex = -1;
    this.insertTextAtCursorInternal(text);
  }
  /**
   * Internal text insertion at cursor. Handles single and multi-line text.
   * Does not push undo snapshots or trigger autocomplete - caller is responsible.
   * Normalizes line endings and calls onChange once at the end.
   */
  insertTextAtCursorInternal(text) {
    if (!text) return;
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const insertedLines = normalized.split("\n");
    const currentLine = this.state.lines[this.state.cursorLine] || "";
    const beforeCursor = currentLine.slice(0, this.state.cursorCol);
    const afterCursor = currentLine.slice(this.state.cursorCol);
    if (insertedLines.length === 1) {
      this.state.lines[this.state.cursorLine] = beforeCursor + normalized + afterCursor;
      this.setCursorCol(this.state.cursorCol + normalized.length);
    } else {
      this.state.lines = [
        // All lines before current line
        ...this.state.lines.slice(0, this.state.cursorLine),
        // The first inserted line merged with text before cursor
        beforeCursor + insertedLines[0],
        // All middle inserted lines
        ...insertedLines.slice(1, -1),
        // The last inserted line with text after cursor
        insertedLines[insertedLines.length - 1] + afterCursor,
        // All lines after current line
        ...this.state.lines.slice(this.state.cursorLine + 1)
      ];
      this.state.cursorLine += insertedLines.length - 1;
      this.setCursorCol((insertedLines[insertedLines.length - 1] || "").length);
    }
    this.emitChange();
  }
  // All the editor methods from before...
  insertCharacter(char, skipUndoCoalescing) {
    this.historyIndex = -1;
    if (!skipUndoCoalescing) {
      if (isWhitespaceChar(char) || this.lastAction !== "type-word") {
        this.pushUndoSnapshot();
      }
      this.lastAction = "type-word";
    }
    const line = this.state.lines[this.state.cursorLine] || "";
    const before = line.slice(0, this.state.cursorCol);
    const after = line.slice(this.state.cursorCol);
    this.state.lines[this.state.cursorLine] = before + char + after;
    this.setCursorCol(this.state.cursorCol + char.length);
    this.emitChange();
    if (!this.autocompleteState) {
      if (char === "/" && this.isAtStartOfMessage()) {
        this.tryTriggerAutocomplete();
      } else if (char === "@") {
        const currentLine = this.state.lines[this.state.cursorLine] || "";
        const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
        const charBeforeAt = textBeforeCursor[textBeforeCursor.length - 2];
        if (textBeforeCursor.length === 1 || charBeforeAt === " " || charBeforeAt === "	") {
          this.debouncedTriggerAutocomplete();
        }
      } else if (/[a-zA-Z0-9.\-_]/.test(char)) {
        const currentLine = this.state.lines[this.state.cursorLine] || "";
        const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
        if (this.isInSlashCommandContext(textBeforeCursor)) {
          this.tryTriggerAutocomplete();
        } else if (textBeforeCursor.match(/(?:^|[\s])@[^\s]*$/)) {
          this.debouncedTriggerAutocomplete();
        }
      }
    } else {
      this.updateAutocomplete();
    }
  }
  /**
   * Debounced version of tryTriggerAutocomplete for @ file reference context.
   * Prevents synchronous fuzzyFind calls from blocking the event loop on every keystroke.
   */
  debouncedTriggerAutocomplete() {
    if (this.autocompleteDebounceTimer) {
      clearTimeout(this.autocompleteDebounceTimer);
      this.autocompleteDebounceTimer = null;
    }
    this.autocompleteDebounceTimer = setTimeout(() => {
      this.autocompleteDebounceTimer = null;
      this.tryTriggerAutocomplete();
      this.tui.requestRender();
    }, Editor.AUTOCOMPLETE_DEBOUNCE_MS);
  }
  static {
    /**
     * Image file extensions recognized when pasted as a file path.
     *
     * Restricted to formats commonly accepted by AI vision APIs and that have
     * reliable magic-byte signatures for content verification. SVG is excluded
     * (XML/JS-bearing); BMP/TIFF/HEIC/HEIF/AVIF excluded for compatibility and
     * verification simplicity — users can convert before pasting.
     *
     * Detection assumes terminal emulators (iTerm2, Warp, etc.) paste a single
     * absolute file path on drag-drop. Multi-line pastes and bare extensions
     * are intentionally not matched.
     */
    this.IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp)$/i;
  }
  handlePaste(pastedText) {
    this.historyIndex = -1;
    this.lastAction = null;
    const trimmed = pastedText.trim();
    if (this.onPasteImagePath && !trimmed.includes("\n") && Editor.IMAGE_EXTENSIONS.test(trimmed)) {
      this.onPasteImagePath(trimmed);
      return;
    }
    this.pushUndoSnapshot();
    const cleanText = pastedText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const tabExpandedText = cleanText.replace(/\t/g, "    ");
    let filteredText = tabExpandedText.split("").filter((char) => char === "\n" || char.charCodeAt(0) >= 32).join("");
    if (/^[/~.]/.test(filteredText)) {
      const currentLine = this.state.lines[this.state.cursorLine] || "";
      const charBeforeCursor = this.state.cursorCol > 0 ? currentLine[this.state.cursorCol - 1] : "";
      if (charBeforeCursor && /\w/.test(charBeforeCursor)) {
        filteredText = ` ${filteredText}`;
      }
    }
    const pastedLines = filteredText.split("\n");
    const totalChars = filteredText.length;
    if (pastedLines.length > 10 || totalChars > 1e3) {
      this.pasteCounter++;
      const pasteId = this.pasteCounter;
      this.pastes.set(pasteId, filteredText);
      const marker = pastedLines.length > 10 ? `[paste #${pasteId} +${pastedLines.length} lines]` : `[paste #${pasteId} ${totalChars} chars]`;
      this.insertTextAtCursorInternal(marker);
      return;
    }
    if (pastedLines.length === 1) {
      this.insertTextAtCursorInternal(filteredText);
      return;
    }
    this.insertTextAtCursorInternal(filteredText);
  }
  addNewLine() {
    this.historyIndex = -1;
    this.lastAction = null;
    this.pushUndoSnapshot();
    const currentLine = this.state.lines[this.state.cursorLine] || "";
    const before = currentLine.slice(0, this.state.cursorCol);
    const after = currentLine.slice(this.state.cursorCol);
    this.state.lines[this.state.cursorLine] = before;
    this.state.lines.splice(this.state.cursorLine + 1, 0, after);
    this.state.cursorLine++;
    this.setCursorCol(0);
    this.emitChange();
  }
  shouldSubmitOnBackslashEnter(data, kb) {
    if (this.disableSubmit) return false;
    if (!matchesKey(data, "enter")) return false;
    const submitKeys = kb.getKeys("submit");
    const hasShiftEnter = submitKeys.includes("shift+enter") || submitKeys.includes("shift+return");
    if (!hasShiftEnter) return false;
    const currentLine = this.state.lines[this.state.cursorLine] || "";
    return this.state.cursorCol > 0 && currentLine[this.state.cursorCol - 1] === "\\";
  }
  submitValue() {
    let result = this.state.lines.join("\n").trim();
    for (const [pasteId, pasteContent] of this.pastes) {
      const markerRegex = new RegExp(`\\[paste #${pasteId}( (\\+\\d+ lines|\\d+ chars))?\\]`, "g");
      result = result.replace(markerRegex, pasteContent);
    }
    this.state = { lines: [""], cursorLine: 0, cursorCol: 0 };
    this.pastes.clear();
    this.pasteCounter = 0;
    this.historyIndex = -1;
    this.scrollOffset = 0;
    this.undoStack.clear();
    this.lastAction = null;
    this.emitChange();
    if (this.onSubmit) this.onSubmit(result);
  }
  handleBackspace() {
    this.historyIndex = -1;
    this.lastAction = null;
    if (this.state.cursorCol > 0) {
      this.pushUndoSnapshot();
      const line = this.state.lines[this.state.cursorLine] || "";
      const beforeCursor = line.slice(0, this.state.cursorCol);
      const graphemes = [...segmenter.segment(beforeCursor)];
      const lastGrapheme = graphemes[graphemes.length - 1];
      const graphemeLength = lastGrapheme ? lastGrapheme.segment.length : 1;
      const before = line.slice(0, this.state.cursorCol - graphemeLength);
      const after = line.slice(this.state.cursorCol);
      this.state.lines[this.state.cursorLine] = before + after;
      this.setCursorCol(this.state.cursorCol - graphemeLength);
    } else if (this.state.cursorLine > 0) {
      this.pushUndoSnapshot();
      const currentLine = this.state.lines[this.state.cursorLine] || "";
      const previousLine = this.state.lines[this.state.cursorLine - 1] || "";
      this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
      this.state.lines.splice(this.state.cursorLine, 1);
      this.state.cursorLine--;
      this.setCursorCol(previousLine.length);
    }
    this.emitChange();
    if (this.autocompleteState) {
      this.updateAutocomplete();
    } else {
      const currentLine = this.state.lines[this.state.cursorLine] || "";
      const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
      if (this.isInSlashCommandContext(textBeforeCursor)) {
        this.tryTriggerAutocomplete();
      } else if (textBeforeCursor.match(/(?:^|[\s])@[^\s]*$/)) {
        this.debouncedTriggerAutocomplete();
      }
    }
  }
  /**
   * Set cursor column and clear preferredVisualCol.
   * Use this for all non-vertical cursor movements to reset sticky column behavior.
   */
  setCursorCol(col) {
    this.state.cursorCol = col;
    this.preferredVisualCol = null;
  }
  /**
   * Move cursor to a target visual line, applying sticky column logic.
   * Shared by moveCursor() and pageScroll().
   */
  moveToVisualLine(visualLines, currentVisualLine, targetVisualLine) {
    const currentVL = visualLines[currentVisualLine];
    const targetVL = visualLines[targetVisualLine];
    if (currentVL && targetVL) {
      const currentVisualCol = this.state.cursorCol - currentVL.startCol;
      const isLastSourceSegment = currentVisualLine === visualLines.length - 1 || visualLines[currentVisualLine + 1]?.logicalLine !== currentVL.logicalLine;
      const sourceMaxVisualCol = isLastSourceSegment ? currentVL.length : Math.max(0, currentVL.length - 1);
      const isLastTargetSegment = targetVisualLine === visualLines.length - 1 || visualLines[targetVisualLine + 1]?.logicalLine !== targetVL.logicalLine;
      const targetMaxVisualCol = isLastTargetSegment ? targetVL.length : Math.max(0, targetVL.length - 1);
      const moveToVisualCol = this.computeVerticalMoveColumn(
        currentVisualCol,
        sourceMaxVisualCol,
        targetMaxVisualCol
      );
      this.state.cursorLine = targetVL.logicalLine;
      const targetCol = targetVL.startCol + moveToVisualCol;
      const logicalLine = this.state.lines[targetVL.logicalLine] || "";
      this.state.cursorCol = Math.min(targetCol, logicalLine.length);
    }
  }
  /**
   * Compute the target visual column for vertical cursor movement.
   * Implements the sticky column decision table:
   *
   * | P | S | T | U | Scenario                                             | Set Preferred | Move To     |
   * |---|---|---|---| ---------------------------------------------------- |---------------|-------------|
   * | 0 | * | 0 | - | Start nav, target fits                               | null          | current     |
   * | 0 | * | 1 | - | Start nav, target shorter                            | current       | target end  |
   * | 1 | 0 | 0 | 0 | Clamped, target fits preferred                       | null          | preferred   |
   * | 1 | 0 | 0 | 1 | Clamped, target longer but still can't fit preferred | keep          | target end  |
   * | 1 | 0 | 1 | - | Clamped, target even shorter                         | keep          | target end  |
   * | 1 | 1 | 0 | - | Rewrapped, target fits current                       | null          | current     |
   * | 1 | 1 | 1 | - | Rewrapped, target shorter than current               | current       | target end  |
   *
   * Where:
   * - P = preferred col is set
   * - S = cursor in middle of source line (not clamped to end)
   * - T = target line shorter than current visual col
   * - U = target line shorter than preferred col
   */
  computeVerticalMoveColumn(currentVisualCol, sourceMaxVisualCol, targetMaxVisualCol) {
    const hasPreferred = this.preferredVisualCol !== null;
    const cursorInMiddle = currentVisualCol < sourceMaxVisualCol;
    const targetTooShort = targetMaxVisualCol < currentVisualCol;
    if (!hasPreferred || cursorInMiddle) {
      if (targetTooShort) {
        this.preferredVisualCol = currentVisualCol;
        return targetMaxVisualCol;
      }
      this.preferredVisualCol = null;
      return currentVisualCol;
    }
    const targetCantFitPreferred = targetMaxVisualCol < this.preferredVisualCol;
    if (targetTooShort || targetCantFitPreferred) {
      return targetMaxVisualCol;
    }
    const result = this.preferredVisualCol;
    this.preferredVisualCol = null;
    return result;
  }
  moveToLineStart() {
    this.lastAction = null;
    this.setCursorCol(0);
  }
  moveToLineEnd() {
    this.lastAction = null;
    const currentLine = this.state.lines[this.state.cursorLine] || "";
    this.setCursorCol(currentLine.length);
  }
  deleteToStartOfLine() {
    this.historyIndex = -1;
    const currentLine = this.state.lines[this.state.cursorLine] || "";
    if (this.state.cursorCol > 0) {
      this.pushUndoSnapshot();
      const deletedText = currentLine.slice(0, this.state.cursorCol);
      this.killRing.push(deletedText, { prepend: true, accumulate: this.lastAction === "kill" });
      this.lastAction = "kill";
      this.state.lines[this.state.cursorLine] = currentLine.slice(this.state.cursorCol);
      this.setCursorCol(0);
    } else if (this.state.cursorLine > 0) {
      this.pushUndoSnapshot();
      this.killRing.push("\n", { prepend: true, accumulate: this.lastAction === "kill" });
      this.lastAction = "kill";
      const previousLine = this.state.lines[this.state.cursorLine - 1] || "";
      this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
      this.state.lines.splice(this.state.cursorLine, 1);
      this.state.cursorLine--;
      this.setCursorCol(previousLine.length);
    }
    this.emitChange();
  }
  deleteToEndOfLine() {
    this.historyIndex = -1;
    const currentLine = this.state.lines[this.state.cursorLine] || "";
    if (this.state.cursorCol < currentLine.length) {
      this.pushUndoSnapshot();
      const deletedText = currentLine.slice(this.state.cursorCol);
      this.killRing.push(deletedText, { prepend: false, accumulate: this.lastAction === "kill" });
      this.lastAction = "kill";
      this.state.lines[this.state.cursorLine] = currentLine.slice(0, this.state.cursorCol);
    } else if (this.state.cursorLine < this.state.lines.length - 1) {
      this.pushUndoSnapshot();
      this.killRing.push("\n", { prepend: false, accumulate: this.lastAction === "kill" });
      this.lastAction = "kill";
      const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
      this.state.lines[this.state.cursorLine] = currentLine + nextLine;
      this.state.lines.splice(this.state.cursorLine + 1, 1);
    }
    this.emitChange();
  }
  deleteWordBackwards() {
    this.historyIndex = -1;
    const currentLine = this.state.lines[this.state.cursorLine] || "";
    if (this.state.cursorCol === 0) {
      if (this.state.cursorLine > 0) {
        this.pushUndoSnapshot();
        this.killRing.push("\n", { prepend: true, accumulate: this.lastAction === "kill" });
        this.lastAction = "kill";
        const previousLine = this.state.lines[this.state.cursorLine - 1] || "";
        this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
        this.state.lines.splice(this.state.cursorLine, 1);
        this.state.cursorLine--;
        this.setCursorCol(previousLine.length);
      }
    } else {
      this.pushUndoSnapshot();
      const wasKill = this.lastAction === "kill";
      const oldCursorCol = this.state.cursorCol;
      this.moveWordBackwards();
      const deleteFrom = this.state.cursorCol;
      this.setCursorCol(oldCursorCol);
      const deletedText = currentLine.slice(deleteFrom, this.state.cursorCol);
      this.killRing.push(deletedText, { prepend: true, accumulate: wasKill });
      this.lastAction = "kill";
      this.state.lines[this.state.cursorLine] = currentLine.slice(0, deleteFrom) + currentLine.slice(this.state.cursorCol);
      this.setCursorCol(deleteFrom);
    }
    this.emitChange();
  }
  deleteWordForward() {
    this.historyIndex = -1;
    const currentLine = this.state.lines[this.state.cursorLine] || "";
    if (this.state.cursorCol >= currentLine.length) {
      if (this.state.cursorLine < this.state.lines.length - 1) {
        this.pushUndoSnapshot();
        this.killRing.push("\n", { prepend: false, accumulate: this.lastAction === "kill" });
        this.lastAction = "kill";
        const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
        this.state.lines[this.state.cursorLine] = currentLine + nextLine;
        this.state.lines.splice(this.state.cursorLine + 1, 1);
      }
    } else {
      this.pushUndoSnapshot();
      const wasKill = this.lastAction === "kill";
      const oldCursorCol = this.state.cursorCol;
      this.moveWordForwards();
      const deleteTo = this.state.cursorCol;
      this.setCursorCol(oldCursorCol);
      const deletedText = currentLine.slice(this.state.cursorCol, deleteTo);
      this.killRing.push(deletedText, { prepend: false, accumulate: wasKill });
      this.lastAction = "kill";
      this.state.lines[this.state.cursorLine] = currentLine.slice(0, this.state.cursorCol) + currentLine.slice(deleteTo);
    }
    this.emitChange();
  }
  handleForwardDelete() {
    this.historyIndex = -1;
    this.lastAction = null;
    const currentLine = this.state.lines[this.state.cursorLine] || "";
    if (this.state.cursorCol < currentLine.length) {
      this.pushUndoSnapshot();
      const afterCursor = currentLine.slice(this.state.cursorCol);
      const graphemes = [...segmenter.segment(afterCursor)];
      const firstGrapheme = graphemes[0];
      const graphemeLength = firstGrapheme ? firstGrapheme.segment.length : 1;
      const before = currentLine.slice(0, this.state.cursorCol);
      const after = currentLine.slice(this.state.cursorCol + graphemeLength);
      this.state.lines[this.state.cursorLine] = before + after;
    } else if (this.state.cursorLine < this.state.lines.length - 1) {
      this.pushUndoSnapshot();
      const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
      this.state.lines[this.state.cursorLine] = currentLine + nextLine;
      this.state.lines.splice(this.state.cursorLine + 1, 1);
    }
    this.emitChange();
    if (this.autocompleteState) {
      this.updateAutocomplete();
    } else {
      const currentLine2 = this.state.lines[this.state.cursorLine] || "";
      const textBeforeCursor = currentLine2.slice(0, this.state.cursorCol);
      if (this.isInSlashCommandContext(textBeforeCursor)) {
        this.tryTriggerAutocomplete();
      } else if (textBeforeCursor.match(/(?:^|[\s])@[^\s]*$/)) {
        this.debouncedTriggerAutocomplete();
      }
    }
  }
  /**
   * Build a mapping from visual lines to logical positions.
   * Returns an array where each element represents a visual line with:
   * - logicalLine: index into this.state.lines
   * - startCol: starting column in the logical line
   * - length: length of this visual line segment
   */
  buildVisualLineMap(width) {
    const cached = this.visualLineMapCache;
    if (cached && cached.width === width && cached.textVersion === this.textVersion) {
      return cached.lines;
    }
    const visualLines = [];
    for (let i = 0; i < this.state.lines.length; i++) {
      const line = this.state.lines[i] || "";
      const lineVisWidth = visibleWidth(line);
      if (line.length === 0) {
        visualLines.push({ logicalLine: i, startCol: 0, length: 0 });
      } else if (lineVisWidth <= width) {
        visualLines.push({ logicalLine: i, startCol: 0, length: line.length });
      } else {
        const chunks = wordWrapLine(line, width);
        for (const chunk of chunks) {
          visualLines.push({
            logicalLine: i,
            startCol: chunk.startIndex,
            length: chunk.endIndex - chunk.startIndex
          });
        }
      }
    }
    this.visualLineMapCache = {
      width,
      textVersion: this.textVersion,
      lines: visualLines
    };
    return visualLines;
  }
  /**
   * Find the visual line index for the current cursor position.
   */
  findCurrentVisualLine(visualLines) {
    for (let i = 0; i < visualLines.length; i++) {
      const vl = visualLines[i];
      if (!vl) continue;
      if (vl.logicalLine === this.state.cursorLine) {
        const colInSegment = this.state.cursorCol - vl.startCol;
        const isLastSegmentOfLine = i === visualLines.length - 1 || visualLines[i + 1]?.logicalLine !== vl.logicalLine;
        if (colInSegment >= 0 && (colInSegment < vl.length || isLastSegmentOfLine && colInSegment <= vl.length)) {
          return i;
        }
      }
    }
    return visualLines.length - 1;
  }
  moveCursor(deltaLine, deltaCol) {
    this.lastAction = null;
    const visualLines = this.buildVisualLineMap(this.lastWidth);
    const currentVisualLine = this.findCurrentVisualLine(visualLines);
    if (deltaLine !== 0) {
      const targetVisualLine = currentVisualLine + deltaLine;
      if (targetVisualLine >= 0 && targetVisualLine < visualLines.length) {
        this.moveToVisualLine(visualLines, currentVisualLine, targetVisualLine);
      }
    }
    if (deltaCol !== 0) {
      const currentLine = this.state.lines[this.state.cursorLine] || "";
      if (deltaCol > 0) {
        if (this.state.cursorCol < currentLine.length) {
          const afterCursor = currentLine.slice(this.state.cursorCol);
          const graphemes = [...segmenter.segment(afterCursor)];
          const firstGrapheme = graphemes[0];
          this.setCursorCol(this.state.cursorCol + (firstGrapheme ? firstGrapheme.segment.length : 1));
        } else if (this.state.cursorLine < this.state.lines.length - 1) {
          this.state.cursorLine++;
          this.setCursorCol(0);
        } else {
          const currentVL = visualLines[currentVisualLine];
          if (currentVL) {
            this.preferredVisualCol = this.state.cursorCol - currentVL.startCol;
          }
        }
      } else {
        if (this.state.cursorCol > 0) {
          const beforeCursor = currentLine.slice(0, this.state.cursorCol);
          const graphemes = [...segmenter.segment(beforeCursor)];
          const lastGrapheme = graphemes[graphemes.length - 1];
          this.setCursorCol(this.state.cursorCol - (lastGrapheme ? lastGrapheme.segment.length : 1));
        } else if (this.state.cursorLine > 0) {
          this.state.cursorLine--;
          const prevLine = this.state.lines[this.state.cursorLine] || "";
          this.setCursorCol(prevLine.length);
        }
      }
    }
  }
  /**
   * Scroll by a page (direction: -1 for up, 1 for down).
   * Moves cursor by the page size while keeping it in bounds.
   */
  pageScroll(direction) {
    this.lastAction = null;
    const terminalRows = this.tui.terminal.rows;
    const pageSize = Math.max(5, Math.floor(terminalRows * 0.3));
    const visualLines = this.buildVisualLineMap(this.lastWidth);
    const currentVisualLine = this.findCurrentVisualLine(visualLines);
    const targetVisualLine = Math.max(0, Math.min(visualLines.length - 1, currentVisualLine + direction * pageSize));
    this.moveToVisualLine(visualLines, currentVisualLine, targetVisualLine);
  }
  moveWordBackwards() {
    this.lastAction = null;
    const currentLine = this.state.lines[this.state.cursorLine] || "";
    if (this.state.cursorCol === 0) {
      if (this.state.cursorLine > 0) {
        this.state.cursorLine--;
        const prevLine = this.state.lines[this.state.cursorLine] || "";
        this.setCursorCol(prevLine.length);
      }
      return;
    }
    const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
    const graphemes = [...segmenter.segment(textBeforeCursor)];
    let newCol = this.state.cursorCol;
    while (graphemes.length > 0 && isWhitespaceChar(graphemes[graphemes.length - 1]?.segment || "")) {
      newCol -= graphemes.pop()?.segment.length || 0;
    }
    if (graphemes.length > 0) {
      const lastGrapheme = graphemes[graphemes.length - 1]?.segment || "";
      if (isPunctuationChar(lastGrapheme)) {
        while (graphemes.length > 0 && isPunctuationChar(graphemes[graphemes.length - 1]?.segment || "")) {
          newCol -= graphemes.pop()?.segment.length || 0;
        }
      } else {
        while (graphemes.length > 0 && !isWhitespaceChar(graphemes[graphemes.length - 1]?.segment || "") && !isPunctuationChar(graphemes[graphemes.length - 1]?.segment || "")) {
          newCol -= graphemes.pop()?.segment.length || 0;
        }
      }
    }
    this.setCursorCol(newCol);
  }
  /**
   * Yank (paste) the most recent kill ring entry at cursor position.
   */
  yank() {
    if (this.killRing.length === 0) return;
    this.pushUndoSnapshot();
    const text = this.killRing.peek();
    this.insertYankedText(text);
    this.lastAction = "yank";
  }
  /**
   * Cycle through kill ring (only works immediately after yank or yank-pop).
   * Replaces the last yanked text with the previous entry in the ring.
   */
  yankPop() {
    if (this.lastAction !== "yank" || this.killRing.length <= 1) return;
    this.pushUndoSnapshot();
    this.deleteYankedText();
    this.killRing.rotate();
    const text = this.killRing.peek();
    this.insertYankedText(text);
    this.lastAction = "yank";
  }
  /**
   * Insert text at cursor position (used by yank operations).
   */
  insertYankedText(text) {
    this.historyIndex = -1;
    const lines = text.split("\n");
    if (lines.length === 1) {
      const currentLine = this.state.lines[this.state.cursorLine] || "";
      const before = currentLine.slice(0, this.state.cursorCol);
      const after = currentLine.slice(this.state.cursorCol);
      this.state.lines[this.state.cursorLine] = before + text + after;
      this.setCursorCol(this.state.cursorCol + text.length);
    } else {
      const currentLine = this.state.lines[this.state.cursorLine] || "";
      const before = currentLine.slice(0, this.state.cursorCol);
      const after = currentLine.slice(this.state.cursorCol);
      this.state.lines[this.state.cursorLine] = before + (lines[0] || "");
      for (let i = 1; i < lines.length - 1; i++) {
        this.state.lines.splice(this.state.cursorLine + i, 0, lines[i] || "");
      }
      const lastLineIndex = this.state.cursorLine + lines.length - 1;
      this.state.lines.splice(lastLineIndex, 0, (lines[lines.length - 1] || "") + after);
      this.state.cursorLine = lastLineIndex;
      this.setCursorCol((lines[lines.length - 1] || "").length);
    }
    this.emitChange();
  }
  /**
   * Delete the previously yanked text (used by yank-pop).
   * The yanked text is derived from killRing[end] since it hasn't been rotated yet.
   */
  deleteYankedText() {
    const yankedText = this.killRing.peek();
    if (!yankedText) return;
    const yankLines = yankedText.split("\n");
    if (yankLines.length === 1) {
      const currentLine = this.state.lines[this.state.cursorLine] || "";
      const deleteLen = yankedText.length;
      const before = currentLine.slice(0, this.state.cursorCol - deleteLen);
      const after = currentLine.slice(this.state.cursorCol);
      this.state.lines[this.state.cursorLine] = before + after;
      this.setCursorCol(this.state.cursorCol - deleteLen);
    } else {
      const startLine = this.state.cursorLine - (yankLines.length - 1);
      const startCol = (this.state.lines[startLine] || "").length - (yankLines[0] || "").length;
      const afterCursor = (this.state.lines[this.state.cursorLine] || "").slice(this.state.cursorCol);
      const beforeYank = (this.state.lines[startLine] || "").slice(0, startCol);
      this.state.lines.splice(startLine, yankLines.length, beforeYank + afterCursor);
      this.state.cursorLine = startLine;
      this.setCursorCol(startCol);
    }
    this.emitChange();
  }
  pushUndoSnapshot() {
    this.undoStack.push(this.state);
  }
  undo() {
    this.historyIndex = -1;
    const snapshot = this.undoStack.pop();
    if (!snapshot) return;
    Object.assign(this.state, snapshot);
    this.lastAction = null;
    this.preferredVisualCol = null;
    this.emitChange();
  }
  /**
   * Jump to the first occurrence of a character in the specified direction.
   * Multi-line search. Case-sensitive. Skips the current cursor position.
   */
  jumpToChar(char, direction) {
    this.lastAction = null;
    const isForward = direction === "forward";
    const lines = this.state.lines;
    const end = isForward ? lines.length : -1;
    const step = isForward ? 1 : -1;
    for (let lineIdx = this.state.cursorLine; lineIdx !== end; lineIdx += step) {
      const line = lines[lineIdx] || "";
      const isCurrentLine = lineIdx === this.state.cursorLine;
      const searchFrom = isCurrentLine ? isForward ? this.state.cursorCol + 1 : this.state.cursorCol - 1 : void 0;
      const idx = isForward ? line.indexOf(char, searchFrom) : line.lastIndexOf(char, searchFrom);
      if (idx !== -1) {
        this.state.cursorLine = lineIdx;
        this.setCursorCol(idx);
        return;
      }
    }
  }
  moveWordForwards() {
    this.lastAction = null;
    const currentLine = this.state.lines[this.state.cursorLine] || "";
    if (this.state.cursorCol >= currentLine.length) {
      if (this.state.cursorLine < this.state.lines.length - 1) {
        this.state.cursorLine++;
        this.setCursorCol(0);
      }
      return;
    }
    const textAfterCursor = currentLine.slice(this.state.cursorCol);
    const segments = segmenter.segment(textAfterCursor);
    const iterator = segments[Symbol.iterator]();
    let next = iterator.next();
    let newCol = this.state.cursorCol;
    while (!next.done && isWhitespaceChar(next.value.segment)) {
      newCol += next.value.segment.length;
      next = iterator.next();
    }
    if (!next.done) {
      const firstGrapheme = next.value.segment;
      if (isPunctuationChar(firstGrapheme)) {
        while (!next.done && isPunctuationChar(next.value.segment)) {
          newCol += next.value.segment.length;
          next = iterator.next();
        }
      } else {
        while (!next.done && !isWhitespaceChar(next.value.segment) && !isPunctuationChar(next.value.segment)) {
          newCol += next.value.segment.length;
          next = iterator.next();
        }
      }
    }
    this.setCursorCol(newCol);
  }
  // Slash menu only allowed on the first line of the editor
  isSlashMenuAllowed() {
    return this.state.cursorLine === 0;
  }
  // Helper method to check if cursor is at start of message (for slash command detection)
  isAtStartOfMessage() {
    if (!this.isSlashMenuAllowed()) return false;
    const currentLine = this.state.lines[this.state.cursorLine] || "";
    const beforeCursor = currentLine.slice(0, this.state.cursorCol);
    return beforeCursor.trim() === "" || beforeCursor.trim() === "/";
  }
  isInSlashCommandContext(textBeforeCursor) {
    return this.isSlashMenuAllowed() && textBeforeCursor.trimStart().startsWith("/");
  }
  shouldChainSlashArgumentAutocompleteOnTabSelection() {
    if (this.autocompleteState !== "regular") {
      return false;
    }
    const currentLine = this.state.lines[this.state.cursorLine] || "";
    const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
    return this.isInSlashCommandContext(textBeforeCursor) && !textBeforeCursor.trimStart().includes(" ");
  }
  isBareCompletedSlashCommandAtCursor() {
    const currentLine = this.state.lines[this.state.cursorLine] || "";
    if (this.state.cursorCol !== currentLine.length) {
      return false;
    }
    const textBeforeCursor = currentLine.slice(0, this.state.cursorCol).trimStart();
    return /^\/\S+ $/.test(textBeforeCursor);
  }
  // Autocomplete methods
  /**
   * Find the best autocomplete item index for the given prefix.
   * Returns -1 if no match is found.
   *
   * Match priority:
   * 1. Exact match (prefix === item.value) -> always selected
   * 2. Prefix match -> first item whose value starts with prefix
   * 3. No match -> -1 (keep default highlight)
   *
   * Matching is case-sensitive and checks item.value only.
   */
  getBestAutocompleteMatchIndex(items, prefix) {
    if (!prefix) return -1;
    let firstPrefixIndex = -1;
    for (let i = 0; i < items.length; i++) {
      const value = items[i].value;
      if (value === prefix) {
        return i;
      }
      if (firstPrefixIndex === -1 && value.startsWith(prefix)) {
        firstPrefixIndex = i;
      }
    }
    return firstPrefixIndex;
  }
  tryTriggerAutocomplete(explicitTab = false) {
    if (!this.autocompleteProvider) return;
    if (explicitTab) {
      const provider = this.autocompleteProvider;
      const shouldTrigger = !provider.shouldTriggerFileCompletion || provider.shouldTriggerFileCompletion(this.state.lines, this.state.cursorLine, this.state.cursorCol);
      if (!shouldTrigger) {
        return;
      }
    }
    const suggestions = this.autocompleteProvider.getSuggestions(
      this.state.lines,
      this.state.cursorLine,
      this.state.cursorCol
    );
    if (suggestions && suggestions.items.length > 0) {
      this.autocompletePrefix = suggestions.prefix;
      this.autocompleteList = new SelectList(suggestions.items, this.autocompleteMaxVisible, this.theme.selectList);
      const bestMatchIndex = this.getBestAutocompleteMatchIndex(suggestions.items, suggestions.prefix);
      if (bestMatchIndex >= 0) {
        this.autocompleteList.setSelectedIndex(bestMatchIndex);
      }
      this.autocompleteState = "regular";
    } else {
      this.cancelAutocomplete();
    }
  }
  handleTabCompletion() {
    if (!this.autocompleteProvider) return;
    const currentLine = this.state.lines[this.state.cursorLine] || "";
    const beforeCursor = currentLine.slice(0, this.state.cursorCol);
    if (this.isInSlashCommandContext(beforeCursor) && !beforeCursor.trimStart().includes(" ")) {
      this.handleSlashCommandCompletion();
    } else {
      this.forceFileAutocomplete(true);
    }
  }
  handleSlashCommandCompletion() {
    this.tryTriggerAutocomplete(true);
  }
  /*
  https://github.com/EsotericSoftware/spine-runtimes/actions/runs/19536643416/job/559322883
  17 this job fails with https://github.com/EsotericSoftware/spine-runtimes/actions/runs/19
  536643416/job/55932288317 havea  look at .gi
  	 */
  forceFileAutocomplete(explicitTab = false) {
    if (!this.autocompleteProvider) return;
    const provider = this.autocompleteProvider;
    if (typeof provider.getForceFileSuggestions !== "function") {
      this.tryTriggerAutocomplete(true);
      return;
    }
    const suggestions = provider.getForceFileSuggestions(
      this.state.lines,
      this.state.cursorLine,
      this.state.cursorCol
    );
    if (suggestions && suggestions.items.length > 0) {
      if (explicitTab && suggestions.items.length === 1) {
        const item = suggestions.items[0];
        this.pushUndoSnapshot();
        this.lastAction = null;
        const result = this.autocompleteProvider.applyCompletion(
          this.state.lines,
          this.state.cursorLine,
          this.state.cursorCol,
          item,
          suggestions.prefix
        );
        this.state.lines = result.lines;
        this.state.cursorLine = result.cursorLine;
        this.setCursorCol(result.cursorCol);
        this.emitChange();
        return;
      }
      this.autocompletePrefix = suggestions.prefix;
      this.autocompleteList = new SelectList(suggestions.items, this.autocompleteMaxVisible, this.theme.selectList);
      const bestMatchIndex = this.getBestAutocompleteMatchIndex(suggestions.items, suggestions.prefix);
      if (bestMatchIndex >= 0) {
        this.autocompleteList.setSelectedIndex(bestMatchIndex);
      }
      this.autocompleteState = "force";
    } else {
      this.cancelAutocomplete();
    }
  }
  cancelAutocomplete() {
    this.autocompleteState = null;
    this.autocompleteList = void 0;
    this.autocompletePrefix = "";
    this.clearAutocompleteDebounce();
  }
  clearAutocompleteDebounce() {
    if (this.autocompleteDebounceTimer) {
      clearTimeout(this.autocompleteDebounceTimer);
      this.autocompleteDebounceTimer = null;
    }
    this.lastAutocompleteLookupPrefix = null;
  }
  dispose() {
    this.clearAutocompleteDebounce();
  }
  isShowingAutocomplete() {
    return this.autocompleteState !== null;
  }
  updateAutocomplete() {
    if (!this.autocompleteState || !this.autocompleteProvider) return;
    if (this.autocompleteState === "force") {
      this.forceFileAutocomplete();
      return;
    }
    const currentLine = this.state.lines[this.state.cursorLine] || "";
    const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
    if (this.autocompletePrefix.startsWith("@") || textBeforeCursor.match(/(?:^|[\s])@[^\s]*$/)) {
      this.debouncedUpdateAutocompleteSuggestions();
      return;
    }
    this.applyAutocompleteSuggestions();
  }
  debouncedUpdateAutocompleteSuggestions() {
    if (this.autocompleteDebounceTimer) {
      clearTimeout(this.autocompleteDebounceTimer);
      this.autocompleteDebounceTimer = null;
    }
    this.autocompleteDebounceTimer = setTimeout(() => {
      this.autocompleteDebounceTimer = null;
      if (!this.autocompleteState || !this.autocompleteProvider) return;
      this.applyAutocompleteSuggestions();
      this.tui.requestRender();
    }, Editor.AUTOCOMPLETE_DEBOUNCE_MS);
  }
  applyAutocompleteSuggestions() {
    if (!this.autocompleteProvider) return;
    const currentLine = this.state.lines[this.state.cursorLine] || "";
    const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
    if (this.lastAutocompleteLookupPrefix !== null && this.lastAutocompleteLookupPrefix === textBeforeCursor) {
      return;
    }
    this.lastAutocompleteLookupPrefix = textBeforeCursor;
    const suggestions = this.autocompleteProvider.getSuggestions(
      this.state.lines,
      this.state.cursorLine,
      this.state.cursorCol
    );
    if (suggestions && suggestions.items.length > 0) {
      this.autocompletePrefix = suggestions.prefix;
      this.autocompleteList = new SelectList(suggestions.items, this.autocompleteMaxVisible, this.theme.selectList);
      const bestMatchIndex = this.getBestAutocompleteMatchIndex(suggestions.items, suggestions.prefix);
      if (bestMatchIndex >= 0) {
        this.autocompleteList.setSelectedIndex(bestMatchIndex);
      }
    } else {
      this.cancelAutocomplete();
    }
  }
}
export {
  Editor
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktdHVpL3NyYy9jb21wb25lbnRzL2VkaXRvci50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHR5cGUgeyBBdXRvY29tcGxldGVQcm92aWRlciwgQ29tYmluZWRBdXRvY29tcGxldGVQcm92aWRlciB9IGZyb20gXCIuLi9hdXRvY29tcGxldGUuanNcIjtcbmltcG9ydCB7IGdldEVkaXRvcktleWJpbmRpbmdzIH0gZnJvbSBcIi4uL2tleWJpbmRpbmdzLmpzXCI7XG5pbXBvcnQgeyBkZWNvZGVLaXR0eVByaW50YWJsZSwgbWF0Y2hlc0tleSB9IGZyb20gXCIuLi9rZXlzLmpzXCI7XG5pbXBvcnQgeyBLaWxsUmluZyB9IGZyb20gXCIuLi9raWxsLXJpbmcuanNcIjtcbmltcG9ydCB7IHR5cGUgQ29tcG9uZW50LCBDVVJTT1JfTUFSS0VSLCB0eXBlIEZvY3VzYWJsZSwgdHlwZSBUVUkgfSBmcm9tIFwiLi4vdHVpLmpzXCI7XG5pbXBvcnQgeyBVbmRvU3RhY2sgfSBmcm9tIFwiLi4vdW5kby1zdGFjay5qc1wiO1xuaW1wb3J0IHsgZ2V0U2VnbWVudGVyLCBpc1B1bmN0dWF0aW9uQ2hhciwgaXNXaGl0ZXNwYWNlQ2hhciwgdmlzaWJsZVdpZHRoIH0gZnJvbSBcIi4uL3V0aWxzLmpzXCI7XG5pbXBvcnQgeyBTZWxlY3RMaXN0LCB0eXBlIFNlbGVjdExpc3RUaGVtZSB9IGZyb20gXCIuL3NlbGVjdC1saXN0LmpzXCI7XG5cbmNvbnN0IHNlZ21lbnRlciA9IGdldFNlZ21lbnRlcigpO1xuXG4vKipcbiAqIFJlcHJlc2VudHMgYSBjaHVuayBvZiB0ZXh0IGZvciB3b3JkLXdyYXAgbGF5b3V0LlxuICogVHJhY2tzIGJvdGggdGhlIHRleHQgY29udGVudCBhbmQgaXRzIHBvc2l0aW9uIGluIHRoZSBvcmlnaW5hbCBsaW5lLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIFRleHRDaHVuayB7XG5cdHRleHQ6IHN0cmluZztcblx0c3RhcnRJbmRleDogbnVtYmVyO1xuXHRlbmRJbmRleDogbnVtYmVyO1xufVxuXG4vKipcbiAqIFNwbGl0IGEgbGluZSBpbnRvIHdvcmQtd3JhcHBlZCBjaHVua3MuXG4gKiBXcmFwcyBhdCB3b3JkIGJvdW5kYXJpZXMgd2hlbiBwb3NzaWJsZSwgZmFsbGluZyBiYWNrIHRvIGNoYXJhY3Rlci1sZXZlbFxuICogd3JhcHBpbmcgZm9yIHdvcmRzIGxvbmdlciB0aGFuIHRoZSBhdmFpbGFibGUgd2lkdGguXG4gKlxuICogQHBhcmFtIGxpbmUgLSBUaGUgdGV4dCBsaW5lIHRvIHdyYXBcbiAqIEBwYXJhbSBtYXhXaWR0aCAtIE1heGltdW0gdmlzaWJsZSB3aWR0aCBwZXIgY2h1bmtcbiAqIEByZXR1cm5zIEFycmF5IG9mIGNodW5rcyB3aXRoIHRleHQgYW5kIHBvc2l0aW9uIGluZm9ybWF0aW9uXG4gKi9cbmZ1bmN0aW9uIHdvcmRXcmFwTGluZShsaW5lOiBzdHJpbmcsIG1heFdpZHRoOiBudW1iZXIpOiBUZXh0Q2h1bmtbXSB7XG5cdGlmICghbGluZSB8fCBtYXhXaWR0aCA8PSAwKSB7XG5cdFx0cmV0dXJuIFt7IHRleHQ6IFwiXCIsIHN0YXJ0SW5kZXg6IDAsIGVuZEluZGV4OiAwIH1dO1xuXHR9XG5cblx0Y29uc3QgbGluZVdpZHRoID0gdmlzaWJsZVdpZHRoKGxpbmUpO1xuXHRpZiAobGluZVdpZHRoIDw9IG1heFdpZHRoKSB7XG5cdFx0cmV0dXJuIFt7IHRleHQ6IGxpbmUsIHN0YXJ0SW5kZXg6IDAsIGVuZEluZGV4OiBsaW5lLmxlbmd0aCB9XTtcblx0fVxuXG5cdGNvbnN0IGNodW5rczogVGV4dENodW5rW10gPSBbXTtcblx0Y29uc3Qgc2VnbWVudHMgPSBbLi4uc2VnbWVudGVyLnNlZ21lbnQobGluZSldO1xuXG5cdGxldCBjdXJyZW50V2lkdGggPSAwO1xuXHRsZXQgY2h1bmtTdGFydCA9IDA7XG5cblx0Ly8gV3JhcCBvcHBvcnR1bml0eTogdGhlIHBvc2l0aW9uIGFmdGVyIHRoZSBsYXN0IHdoaXRlc3BhY2UgYmVmb3JlIGEgbm9uLXdoaXRlc3BhY2Vcblx0Ly8gZ3JhcGhlbWUsIGkuZS4gd2hlcmUgYSBsaW5lIGJyZWFrIGlzIGFsbG93ZWQuXG5cdGxldCB3cmFwT3BwSW5kZXggPSAtMTtcblx0bGV0IHdyYXBPcHBXaWR0aCA9IDA7XG5cblx0Zm9yIChsZXQgaSA9IDA7IGkgPCBzZWdtZW50cy5sZW5ndGg7IGkrKykge1xuXHRcdGNvbnN0IHNlZyA9IHNlZ21lbnRzW2ldITtcblx0XHRjb25zdCBncmFwaGVtZSA9IHNlZy5zZWdtZW50O1xuXHRcdGNvbnN0IGdXaWR0aCA9IHZpc2libGVXaWR0aChncmFwaGVtZSk7XG5cdFx0Y29uc3QgY2hhckluZGV4ID0gc2VnLmluZGV4O1xuXHRcdGNvbnN0IGlzV3MgPSBpc1doaXRlc3BhY2VDaGFyKGdyYXBoZW1lKTtcblxuXHRcdC8vIE92ZXJmbG93IGNoZWNrIGJlZm9yZSBhZHZhbmNpbmcuXG5cdFx0aWYgKGN1cnJlbnRXaWR0aCArIGdXaWR0aCA+IG1heFdpZHRoKSB7XG5cdFx0XHRpZiAod3JhcE9wcEluZGV4ID49IDApIHtcblx0XHRcdFx0Ly8gQmFja3RyYWNrIHRvIGxhc3Qgd3JhcCBvcHBvcnR1bml0eS5cblx0XHRcdFx0Y2h1bmtzLnB1c2goeyB0ZXh0OiBsaW5lLnNsaWNlKGNodW5rU3RhcnQsIHdyYXBPcHBJbmRleCksIHN0YXJ0SW5kZXg6IGNodW5rU3RhcnQsIGVuZEluZGV4OiB3cmFwT3BwSW5kZXggfSk7XG5cdFx0XHRcdGNodW5rU3RhcnQgPSB3cmFwT3BwSW5kZXg7XG5cdFx0XHRcdGN1cnJlbnRXaWR0aCAtPSB3cmFwT3BwV2lkdGg7XG5cdFx0XHR9IGVsc2UgaWYgKGNodW5rU3RhcnQgPCBjaGFySW5kZXgpIHtcblx0XHRcdFx0Ly8gTm8gd3JhcCBvcHBvcnR1bml0eTogZm9yY2UtYnJlYWsgYXQgY3VycmVudCBwb3NpdGlvbi5cblx0XHRcdFx0Y2h1bmtzLnB1c2goeyB0ZXh0OiBsaW5lLnNsaWNlKGNodW5rU3RhcnQsIGNoYXJJbmRleCksIHN0YXJ0SW5kZXg6IGNodW5rU3RhcnQsIGVuZEluZGV4OiBjaGFySW5kZXggfSk7XG5cdFx0XHRcdGNodW5rU3RhcnQgPSBjaGFySW5kZXg7XG5cdFx0XHRcdGN1cnJlbnRXaWR0aCA9IDA7XG5cdFx0XHR9XG5cdFx0XHR3cmFwT3BwSW5kZXggPSAtMTtcblx0XHR9XG5cblx0XHQvLyBBZHZhbmNlLlxuXHRcdGN1cnJlbnRXaWR0aCArPSBnV2lkdGg7XG5cblx0XHQvLyBSZWNvcmQgd3JhcCBvcHBvcnR1bml0eTogd2hpdGVzcGFjZSBmb2xsb3dlZCBieSBub24td2hpdGVzcGFjZS5cblx0XHQvLyBNdWx0aXBsZSBzcGFjZXMgam9pbiAobm8gYnJlYWsgYmV0d2VlbiB0aGVtKTsgdGhlIGJyZWFrIHBvaW50IGlzXG5cdFx0Ly8gYWZ0ZXIgdGhlIGxhc3Qgc3BhY2UgYmVmb3JlIHRoZSBuZXh0IHdvcmQuXG5cdFx0Y29uc3QgbmV4dCA9IHNlZ21lbnRzW2kgKyAxXTtcblx0XHRpZiAoaXNXcyAmJiBuZXh0ICYmICFpc1doaXRlc3BhY2VDaGFyKG5leHQuc2VnbWVudCkpIHtcblx0XHRcdHdyYXBPcHBJbmRleCA9IG5leHQuaW5kZXg7XG5cdFx0XHR3cmFwT3BwV2lkdGggPSBjdXJyZW50V2lkdGg7XG5cdFx0fVxuXHR9XG5cblx0Ly8gUHVzaCBmaW5hbCBjaHVuay5cblx0Y2h1bmtzLnB1c2goeyB0ZXh0OiBsaW5lLnNsaWNlKGNodW5rU3RhcnQpLCBzdGFydEluZGV4OiBjaHVua1N0YXJ0LCBlbmRJbmRleDogbGluZS5sZW5ndGggfSk7XG5cblx0cmV0dXJuIGNodW5rcztcbn1cblxuLy8gS2l0dHkgQ1NJLXUgc2VxdWVuY2VzIGZvciBwcmludGFibGUga2V5cywgaW5jbHVkaW5nIG9wdGlvbmFsIHNoaWZ0ZWQvYmFzZSBjb2RlcG9pbnRzLlxuaW50ZXJmYWNlIEVkaXRvclN0YXRlIHtcblx0bGluZXM6IHN0cmluZ1tdO1xuXHRjdXJzb3JMaW5lOiBudW1iZXI7XG5cdGN1cnNvckNvbDogbnVtYmVyO1xufVxuXG5pbnRlcmZhY2UgTGF5b3V0TGluZSB7XG5cdHRleHQ6IHN0cmluZztcblx0aGFzQ3Vyc29yOiBib29sZWFuO1xuXHRjdXJzb3JQb3M/OiBudW1iZXI7XG59XG5cbmludGVyZmFjZSBWaXN1YWxMaW5lIHtcblx0bG9naWNhbExpbmU6IG51bWJlcjtcblx0c3RhcnRDb2w6IG51bWJlcjtcblx0bGVuZ3RoOiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRWRpdG9yVGhlbWUge1xuXHRib3JkZXJDb2xvcjogKHN0cjogc3RyaW5nKSA9PiBzdHJpbmc7XG5cdHNlbGVjdExpc3Q6IFNlbGVjdExpc3RUaGVtZTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBFZGl0b3JPcHRpb25zIHtcblx0cGFkZGluZ1g/OiBudW1iZXI7XG5cdGF1dG9jb21wbGV0ZU1heFZpc2libGU/OiBudW1iZXI7XG59XG5cbmV4cG9ydCBjbGFzcyBFZGl0b3IgaW1wbGVtZW50cyBDb21wb25lbnQsIEZvY3VzYWJsZSB7XG5cdHByaXZhdGUgc3RhdGU6IEVkaXRvclN0YXRlID0ge1xuXHRcdGxpbmVzOiBbXCJcIl0sXG5cdFx0Y3Vyc29yTGluZTogMCxcblx0XHRjdXJzb3JDb2w6IDAsXG5cdH07XG5cblx0LyoqIEZvY3VzYWJsZSBpbnRlcmZhY2UgLSBzZXQgYnkgVFVJIHdoZW4gZm9jdXMgY2hhbmdlcyAqL1xuXHRwcml2YXRlIF9mb2N1c2VkOiBib29sZWFuID0gZmFsc2U7XG5cdGdldCBmb2N1c2VkKCk6IGJvb2xlYW4ge1xuXHRcdHJldHVybiB0aGlzLl9mb2N1c2VkO1xuXHR9XG5cdHNldCBmb2N1c2VkKHZhbHVlOiBib29sZWFuKSB7XG5cdFx0dGhpcy5fZm9jdXNlZCA9IHZhbHVlO1xuXHRcdGlmICghdmFsdWUpIHtcblx0XHRcdHRoaXMuaXNJblBhc3RlID0gZmFsc2U7XG5cdFx0XHR0aGlzLnBhc3RlQnVmZmVyID0gXCJcIjtcblx0XHR9XG5cdH1cblxuXHRwcm90ZWN0ZWQgdHVpOiBUVUk7XG5cdHByaXZhdGUgdGhlbWU6IEVkaXRvclRoZW1lO1xuXHRwcml2YXRlIHBhZGRpbmdYOiBudW1iZXIgPSAwO1xuXG5cdC8vIFN0b3JlIGxhc3QgcmVuZGVyIHdpZHRoIGZvciBjdXJzb3IgbmF2aWdhdGlvblxuXHRwcml2YXRlIGxhc3RXaWR0aDogbnVtYmVyID0gODA7XG5cblx0Ly8gVmVydGljYWwgc2Nyb2xsaW5nIHN1cHBvcnRcblx0cHJpdmF0ZSBzY3JvbGxPZmZzZXQ6IG51bWJlciA9IDA7XG5cblx0Ly8gQm9yZGVyIGNvbG9yIChjYW4gYmUgY2hhbmdlZCBkeW5hbWljYWxseSlcblx0cHVibGljIGJvcmRlckNvbG9yOiAoc3RyOiBzdHJpbmcpID0+IHN0cmluZztcblxuXHQvLyBBdXRvY29tcGxldGUgc3VwcG9ydFxuXHRwcml2YXRlIGF1dG9jb21wbGV0ZVByb3ZpZGVyPzogQXV0b2NvbXBsZXRlUHJvdmlkZXI7XG5cdHByaXZhdGUgYXV0b2NvbXBsZXRlTGlzdD86IFNlbGVjdExpc3Q7XG5cdHByaXZhdGUgYXV0b2NvbXBsZXRlU3RhdGU6IFwicmVndWxhclwiIHwgXCJmb3JjZVwiIHwgbnVsbCA9IG51bGw7XG5cdHByaXZhdGUgYXV0b2NvbXBsZXRlUHJlZml4OiBzdHJpbmcgPSBcIlwiO1xuXHRwcml2YXRlIGF1dG9jb21wbGV0ZU1heFZpc2libGU6IG51bWJlciA9IDU7XG5cblx0Ly8gRGVib3VuY2UgZm9yIEAgZmlsZSBhdXRvY29tcGxldGUgdG8gcHJldmVudCBibG9ja2luZyB0aGUgZXZlbnQgbG9vcFxuXHQvLyB3aXRoIHN5bmNocm9ub3VzIGZ1enp5RmluZCBjYWxscyBvbiBldmVyeSBrZXlzdHJva2Vcblx0cHJpdmF0ZSBhdXRvY29tcGxldGVEZWJvdW5jZVRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xuXHRwcml2YXRlIGxhc3RBdXRvY29tcGxldGVMb29rdXBQcmVmaXg6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXHRwcml2YXRlIHN0YXRpYyByZWFkb25seSBBVVRPQ09NUExFVEVfREVCT1VOQ0VfTVMgPSAxNTA7XG5cblx0Ly8gUGFzdGUgdHJhY2tpbmcgZm9yIGxhcmdlIHBhc3Rlc1xuXHRwcml2YXRlIHBhc3RlczogTWFwPG51bWJlciwgc3RyaW5nPiA9IG5ldyBNYXAoKTtcblx0cHJpdmF0ZSBwYXN0ZUNvdW50ZXI6IG51bWJlciA9IDA7XG5cblx0Ly8gQnJhY2tldGVkIHBhc3RlIG1vZGUgYnVmZmVyaW5nXG5cdHByaXZhdGUgcGFzdGVCdWZmZXI6IHN0cmluZyA9IFwiXCI7XG5cdHByaXZhdGUgaXNJblBhc3RlOiBib29sZWFuID0gZmFsc2U7XG5cblx0Ly8gUHJvbXB0IGhpc3RvcnkgZm9yIHVwL2Rvd24gbmF2aWdhdGlvblxuXHRwcml2YXRlIGhpc3Rvcnk6IHN0cmluZ1tdID0gW107XG5cdHByaXZhdGUgaGlzdG9yeUluZGV4OiBudW1iZXIgPSAtMTsgLy8gLTEgPSBub3QgYnJvd3NpbmcsIDAgPSBtb3N0IHJlY2VudCwgMSA9IG9sZGVyLCBldGMuXG5cblx0Ly8gS2lsbCByaW5nIGZvciBFbWFjcy1zdHlsZSBraWxsL3lhbmsgb3BlcmF0aW9uc1xuXHRwcml2YXRlIGtpbGxSaW5nID0gbmV3IEtpbGxSaW5nKCk7XG5cdHByaXZhdGUgbGFzdEFjdGlvbjogXCJraWxsXCIgfCBcInlhbmtcIiB8IFwidHlwZS13b3JkXCIgfCBudWxsID0gbnVsbDtcblxuXHQvLyBDaGFyYWN0ZXIganVtcCBtb2RlXG5cdHByaXZhdGUganVtcE1vZGU6IFwiZm9yd2FyZFwiIHwgXCJiYWNrd2FyZFwiIHwgbnVsbCA9IG51bGw7XG5cblx0Ly8gUHJlZmVycmVkIHZpc3VhbCBjb2x1bW4gZm9yIHZlcnRpY2FsIGN1cnNvciBtb3ZlbWVudCAoc3RpY2t5IGNvbHVtbilcblx0cHJpdmF0ZSBwcmVmZXJyZWRWaXN1YWxDb2w6IG51bWJlciB8IG51bGwgPSBudWxsO1xuXG5cdC8vIFVuZG8gc3VwcG9ydFxuXHRwcml2YXRlIHVuZG9TdGFjayA9IG5ldyBVbmRvU3RhY2s8RWRpdG9yU3RhdGU+KCk7XG5cdHByaXZhdGUgdGV4dFZlcnNpb24gPSAwO1xuXHRwcml2YXRlIGNhY2hlZFRleHQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXHRwcml2YXRlIGxheW91dENhY2hlOiB7IHdpZHRoOiBudW1iZXI7IHRleHRWZXJzaW9uOiBudW1iZXI7IGN1cnNvckxpbmU6IG51bWJlcjsgY3Vyc29yQ29sOiBudW1iZXI7IGxpbmVzOiBMYXlvdXRMaW5lW10gfSB8IG51bGwgPSBudWxsO1xuXHRwcml2YXRlIHZpc3VhbExpbmVNYXBDYWNoZTogeyB3aWR0aDogbnVtYmVyOyB0ZXh0VmVyc2lvbjogbnVtYmVyOyBsaW5lczogVmlzdWFsTGluZVtdIH0gfCBudWxsID0gbnVsbDtcblxuXHRwdWJsaWMgb25TdWJtaXQ/OiAodGV4dDogc3RyaW5nKSA9PiB2b2lkO1xuXHRwdWJsaWMgb25DaGFuZ2U/OiAodGV4dDogc3RyaW5nKSA9PiB2b2lkO1xuXHRwdWJsaWMgb25QYXN0ZUltYWdlUGF0aD86IChmaWxlUGF0aDogc3RyaW5nKSA9PiB2b2lkO1xuXHRwdWJsaWMgZGlzYWJsZVN1Ym1pdDogYm9vbGVhbiA9IGZhbHNlO1xuXG5cdGNvbnN0cnVjdG9yKHR1aTogVFVJLCB0aGVtZTogRWRpdG9yVGhlbWUsIG9wdGlvbnM6IEVkaXRvck9wdGlvbnMgPSB7fSkge1xuXHRcdHRoaXMudHVpID0gdHVpO1xuXHRcdHRoaXMudGhlbWUgPSB0aGVtZTtcblx0XHR0aGlzLmJvcmRlckNvbG9yID0gdGhlbWUuYm9yZGVyQ29sb3I7XG5cdFx0Y29uc3QgcGFkZGluZ1ggPSBvcHRpb25zLnBhZGRpbmdYID8/IDA7XG5cdFx0dGhpcy5wYWRkaW5nWCA9IE51bWJlci5pc0Zpbml0ZShwYWRkaW5nWCkgPyBNYXRoLm1heCgwLCBNYXRoLmZsb29yKHBhZGRpbmdYKSkgOiAwO1xuXHRcdGNvbnN0IG1heFZpc2libGUgPSBvcHRpb25zLmF1dG9jb21wbGV0ZU1heFZpc2libGUgPz8gNTtcblx0XHR0aGlzLmF1dG9jb21wbGV0ZU1heFZpc2libGUgPSBOdW1iZXIuaXNGaW5pdGUobWF4VmlzaWJsZSkgPyBNYXRoLm1heCgzLCBNYXRoLm1pbigyMCwgTWF0aC5mbG9vcihtYXhWaXNpYmxlKSkpIDogNTtcblx0fVxuXG5cdGdldFBhZGRpbmdYKCk6IG51bWJlciB7XG5cdFx0cmV0dXJuIHRoaXMucGFkZGluZ1g7XG5cdH1cblxuXHRzZXRQYWRkaW5nWChwYWRkaW5nOiBudW1iZXIpOiB2b2lkIHtcblx0XHRjb25zdCBuZXdQYWRkaW5nID0gTnVtYmVyLmlzRmluaXRlKHBhZGRpbmcpID8gTWF0aC5tYXgoMCwgTWF0aC5mbG9vcihwYWRkaW5nKSkgOiAwO1xuXHRcdGlmICh0aGlzLnBhZGRpbmdYICE9PSBuZXdQYWRkaW5nKSB7XG5cdFx0XHR0aGlzLnBhZGRpbmdYID0gbmV3UGFkZGluZztcblx0XHRcdHRoaXMudHVpLnJlcXVlc3RSZW5kZXIoKTtcblx0XHR9XG5cdH1cblxuXHRnZXRBdXRvY29tcGxldGVNYXhWaXNpYmxlKCk6IG51bWJlciB7XG5cdFx0cmV0dXJuIHRoaXMuYXV0b2NvbXBsZXRlTWF4VmlzaWJsZTtcblx0fVxuXG5cdHNldEF1dG9jb21wbGV0ZU1heFZpc2libGUobWF4VmlzaWJsZTogbnVtYmVyKTogdm9pZCB7XG5cdFx0Y29uc3QgbmV3TWF4VmlzaWJsZSA9IE51bWJlci5pc0Zpbml0ZShtYXhWaXNpYmxlKSA/IE1hdGgubWF4KDMsIE1hdGgubWluKDIwLCBNYXRoLmZsb29yKG1heFZpc2libGUpKSkgOiA1O1xuXHRcdGlmICh0aGlzLmF1dG9jb21wbGV0ZU1heFZpc2libGUgIT09IG5ld01heFZpc2libGUpIHtcblx0XHRcdHRoaXMuYXV0b2NvbXBsZXRlTWF4VmlzaWJsZSA9IG5ld01heFZpc2libGU7XG5cdFx0XHR0aGlzLnR1aS5yZXF1ZXN0UmVuZGVyKCk7XG5cdFx0fVxuXHR9XG5cblx0c2V0QXV0b2NvbXBsZXRlUHJvdmlkZXIocHJvdmlkZXI6IEF1dG9jb21wbGV0ZVByb3ZpZGVyKTogdm9pZCB7XG5cdFx0dGhpcy5hdXRvY29tcGxldGVQcm92aWRlciA9IHByb3ZpZGVyO1xuXHR9XG5cblx0cHJpdmF0ZSBjbGVhckxheW91dENhY2hlcygpOiB2b2lkIHtcblx0XHR0aGlzLmxheW91dENhY2hlID0gbnVsbDtcblx0XHR0aGlzLnZpc3VhbExpbmVNYXBDYWNoZSA9IG51bGw7XG5cdH1cblxuXHRwcml2YXRlIGVtaXRDaGFuZ2UoKTogdm9pZCB7XG5cdFx0dGhpcy50ZXh0VmVyc2lvbiArPSAxO1xuXHRcdHRoaXMuY2FjaGVkVGV4dCA9IG51bGw7XG5cdFx0dGhpcy5jbGVhckxheW91dENhY2hlcygpO1xuXHRcdGlmICh0aGlzLm9uQ2hhbmdlKSB7XG5cdFx0XHR0aGlzLm9uQ2hhbmdlKHRoaXMuZ2V0VGV4dCgpKTtcblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIGdldExheW91dExpbmVzKHdpZHRoOiBudW1iZXIpOiBMYXlvdXRMaW5lW10ge1xuXHRcdGNvbnN0IGNhY2hlZCA9IHRoaXMubGF5b3V0Q2FjaGU7XG5cdFx0aWYgKGNhY2hlZCAmJiBjYWNoZWQud2lkdGggPT09IHdpZHRoICYmIGNhY2hlZC50ZXh0VmVyc2lvbiA9PT0gdGhpcy50ZXh0VmVyc2lvblxuXHRcdFx0JiYgY2FjaGVkLmN1cnNvckxpbmUgPT09IHRoaXMuc3RhdGUuY3Vyc29yTGluZSAmJiBjYWNoZWQuY3Vyc29yQ29sID09PSB0aGlzLnN0YXRlLmN1cnNvckNvbCkge1xuXHRcdFx0cmV0dXJuIGNhY2hlZC5saW5lcztcblx0XHR9XG5cblx0XHRjb25zdCBsaW5lcyA9IHRoaXMubGF5b3V0VGV4dCh3aWR0aCk7XG5cdFx0dGhpcy5sYXlvdXRDYWNoZSA9IHsgd2lkdGgsIHRleHRWZXJzaW9uOiB0aGlzLnRleHRWZXJzaW9uLCBsaW5lcyxcblx0XHRcdGN1cnNvckxpbmU6IHRoaXMuc3RhdGUuY3Vyc29yTGluZSwgY3Vyc29yQ29sOiB0aGlzLnN0YXRlLmN1cnNvckNvbCB9O1xuXHRcdHJldHVybiBsaW5lcztcblx0fVxuXG5cdC8qKlxuXHQgKiBBZGQgYSBwcm9tcHQgdG8gaGlzdG9yeSBmb3IgdXAvZG93biBhcnJvdyBuYXZpZ2F0aW9uLlxuXHQgKiBDYWxsZWQgYWZ0ZXIgc3VjY2Vzc2Z1bCBzdWJtaXNzaW9uLlxuXHQgKi9cblx0YWRkVG9IaXN0b3J5KHRleHQ6IHN0cmluZyk6IHZvaWQge1xuXHRcdGNvbnN0IHRyaW1tZWQgPSB0ZXh0LnRyaW0oKTtcblx0XHRpZiAoIXRyaW1tZWQpIHJldHVybjtcblx0XHQvLyBEb24ndCBhZGQgY29uc2VjdXRpdmUgZHVwbGljYXRlc1xuXHRcdGlmICh0aGlzLmhpc3RvcnkubGVuZ3RoID4gMCAmJiB0aGlzLmhpc3RvcnlbMF0gPT09IHRyaW1tZWQpIHJldHVybjtcblx0XHR0aGlzLmhpc3RvcnkudW5zaGlmdCh0cmltbWVkKTtcblx0XHQvLyBMaW1pdCBoaXN0b3J5IHNpemVcblx0XHRpZiAodGhpcy5oaXN0b3J5Lmxlbmd0aCA+IDEwMCkge1xuXHRcdFx0dGhpcy5oaXN0b3J5LnBvcCgpO1xuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgaXNFZGl0b3JFbXB0eSgpOiBib29sZWFuIHtcblx0XHRyZXR1cm4gdGhpcy5zdGF0ZS5saW5lcy5sZW5ndGggPT09IDEgJiYgdGhpcy5zdGF0ZS5saW5lc1swXSA9PT0gXCJcIjtcblx0fVxuXG5cdHByaXZhdGUgaXNPbkZpcnN0VmlzdWFsTGluZSgpOiBib29sZWFuIHtcblx0XHRjb25zdCB2aXN1YWxMaW5lcyA9IHRoaXMuYnVpbGRWaXN1YWxMaW5lTWFwKHRoaXMubGFzdFdpZHRoKTtcblx0XHRjb25zdCBjdXJyZW50VmlzdWFsTGluZSA9IHRoaXMuZmluZEN1cnJlbnRWaXN1YWxMaW5lKHZpc3VhbExpbmVzKTtcblx0XHRyZXR1cm4gY3VycmVudFZpc3VhbExpbmUgPT09IDA7XG5cdH1cblxuXHRwcml2YXRlIGlzT25MYXN0VmlzdWFsTGluZSgpOiBib29sZWFuIHtcblx0XHRjb25zdCB2aXN1YWxMaW5lcyA9IHRoaXMuYnVpbGRWaXN1YWxMaW5lTWFwKHRoaXMubGFzdFdpZHRoKTtcblx0XHRjb25zdCBjdXJyZW50VmlzdWFsTGluZSA9IHRoaXMuZmluZEN1cnJlbnRWaXN1YWxMaW5lKHZpc3VhbExpbmVzKTtcblx0XHRyZXR1cm4gY3VycmVudFZpc3VhbExpbmUgPT09IHZpc3VhbExpbmVzLmxlbmd0aCAtIDE7XG5cdH1cblxuXHRwcml2YXRlIG5hdmlnYXRlSGlzdG9yeShkaXJlY3Rpb246IDEgfCAtMSk6IHZvaWQge1xuXHRcdHRoaXMubGFzdEFjdGlvbiA9IG51bGw7XG5cdFx0aWYgKHRoaXMuaGlzdG9yeS5sZW5ndGggPT09IDApIHJldHVybjtcblxuXHRcdGNvbnN0IG5ld0luZGV4ID0gdGhpcy5oaXN0b3J5SW5kZXggLSBkaXJlY3Rpb247IC8vIFVwKC0xKSBpbmNyZWFzZXMgaW5kZXgsIERvd24oMSkgZGVjcmVhc2VzXG5cdFx0aWYgKG5ld0luZGV4IDwgLTEgfHwgbmV3SW5kZXggPj0gdGhpcy5oaXN0b3J5Lmxlbmd0aCkgcmV0dXJuO1xuXG5cdFx0Ly8gQ2FwdHVyZSBzdGF0ZSB3aGVuIGZpcnN0IGVudGVyaW5nIGhpc3RvcnkgYnJvd3NpbmcgbW9kZVxuXHRcdGlmICh0aGlzLmhpc3RvcnlJbmRleCA9PT0gLTEgJiYgbmV3SW5kZXggPj0gMCkge1xuXHRcdFx0dGhpcy5wdXNoVW5kb1NuYXBzaG90KCk7XG5cdFx0fVxuXG5cdFx0dGhpcy5oaXN0b3J5SW5kZXggPSBuZXdJbmRleDtcblxuXHRcdGlmICh0aGlzLmhpc3RvcnlJbmRleCA9PT0gLTEpIHtcblx0XHRcdC8vIFJldHVybmVkIHRvIFwiY3VycmVudFwiIHN0YXRlIC0gY2xlYXIgZWRpdG9yXG5cdFx0XHR0aGlzLnNldFRleHRJbnRlcm5hbChcIlwiKTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0dGhpcy5zZXRUZXh0SW50ZXJuYWwodGhpcy5oaXN0b3J5W3RoaXMuaGlzdG9yeUluZGV4XSB8fCBcIlwiKTtcblx0XHR9XG5cdH1cblxuXHQvKiogSW50ZXJuYWwgc2V0VGV4dCB0aGF0IGRvZXNuJ3QgcmVzZXQgaGlzdG9yeSBzdGF0ZSAtIHVzZWQgYnkgbmF2aWdhdGVIaXN0b3J5ICovXG5cdHByaXZhdGUgc2V0VGV4dEludGVybmFsKHRleHQ6IHN0cmluZyk6IHZvaWQge1xuXHRcdGNvbnN0IGxpbmVzID0gdGV4dC5yZXBsYWNlKC9cXHJcXG4vZywgXCJcXG5cIikucmVwbGFjZSgvXFxyL2csIFwiXFxuXCIpLnNwbGl0KFwiXFxuXCIpO1xuXHRcdHRoaXMuc3RhdGUubGluZXMgPSBsaW5lcy5sZW5ndGggPT09IDAgPyBbXCJcIl0gOiBsaW5lcztcblx0XHR0aGlzLnN0YXRlLmN1cnNvckxpbmUgPSB0aGlzLnN0YXRlLmxpbmVzLmxlbmd0aCAtIDE7XG5cdFx0dGhpcy5zZXRDdXJzb3JDb2wodGhpcy5zdGF0ZS5saW5lc1t0aGlzLnN0YXRlLmN1cnNvckxpbmVdPy5sZW5ndGggfHwgMCk7XG5cdFx0Ly8gUmVzZXQgc2Nyb2xsIC0gcmVuZGVyKCkgd2lsbCBhZGp1c3QgdG8gc2hvdyBjdXJzb3Jcblx0XHR0aGlzLnNjcm9sbE9mZnNldCA9IDA7XG5cdFx0dGhpcy5lbWl0Q2hhbmdlKCk7XG5cdH1cblxuXHRpbnZhbGlkYXRlKCk6IHZvaWQge1xuXHRcdHRoaXMuY2xlYXJMYXlvdXRDYWNoZXMoKTtcblx0fVxuXG5cdHJlbmRlcih3aWR0aDogbnVtYmVyKTogc3RyaW5nW10ge1xuXHRcdGNvbnN0IG1heFBhZGRpbmcgPSBNYXRoLm1heCgwLCBNYXRoLmZsb29yKCh3aWR0aCAtIDEpIC8gMikpO1xuXHRcdGNvbnN0IHBhZGRpbmdYID0gTWF0aC5taW4odGhpcy5wYWRkaW5nWCwgbWF4UGFkZGluZyk7XG5cdFx0Y29uc3QgY29udGVudFdpZHRoID0gTWF0aC5tYXgoMSwgd2lkdGggLSBwYWRkaW5nWCAqIDIpO1xuXG5cdFx0Ly8gTGF5b3V0IHdpZHRoOiB3aXRoIHBhZGRpbmcgdGhlIGN1cnNvciBjYW4gb3ZlcmZsb3cgaW50byBpdCxcblx0XHQvLyB3aXRob3V0IHBhZGRpbmcgd2UgcmVzZXJ2ZSAxIGNvbHVtbiBmb3IgdGhlIGN1cnNvci5cblx0XHRjb25zdCBsYXlvdXRXaWR0aCA9IE1hdGgubWF4KDEsIGNvbnRlbnRXaWR0aCAtIChwYWRkaW5nWCA/IDAgOiAxKSk7XG5cblx0XHQvLyBTdG9yZSBmb3IgY3Vyc29yIG5hdmlnYXRpb24gKG11c3QgbWF0Y2ggd3JhcHBpbmcgd2lkdGgpXG5cdFx0dGhpcy5sYXN0V2lkdGggPSBsYXlvdXRXaWR0aDtcblxuXHRcdGNvbnN0IGhvcml6b250YWwgPSB0aGlzLmJvcmRlckNvbG9yKFwiXHUyNTAwXCIpO1xuXG5cdFx0Ly8gTGF5b3V0IHRoZSB0ZXh0XG5cdFx0Y29uc3QgbGF5b3V0TGluZXMgPSB0aGlzLmdldExheW91dExpbmVzKGxheW91dFdpZHRoKTtcblxuXHRcdC8vIENhbGN1bGF0ZSBtYXggdmlzaWJsZSBsaW5lczogMzAlIG9mIHRlcm1pbmFsIGhlaWdodCwgbWluaW11bSA1IGxpbmVzXG5cdFx0Y29uc3QgdGVybWluYWxSb3dzID0gdGhpcy50dWkudGVybWluYWwucm93cztcblx0XHRjb25zdCBtYXhWaXNpYmxlTGluZXMgPSBNYXRoLm1heCg1LCBNYXRoLmZsb29yKHRlcm1pbmFsUm93cyAqIDAuMykpO1xuXG5cdFx0Ly8gRmluZCB0aGUgY3Vyc29yIGxpbmUgaW5kZXggaW4gbGF5b3V0TGluZXNcblx0XHRsZXQgY3Vyc29yTGluZUluZGV4ID0gbGF5b3V0TGluZXMuZmluZEluZGV4KChsaW5lKSA9PiBsaW5lLmhhc0N1cnNvcik7XG5cdFx0aWYgKGN1cnNvckxpbmVJbmRleCA9PT0gLTEpIGN1cnNvckxpbmVJbmRleCA9IDA7XG5cblx0XHQvLyBBZGp1c3Qgc2Nyb2xsIG9mZnNldCB0byBrZWVwIGN1cnNvciB2aXNpYmxlXG5cdFx0aWYgKGN1cnNvckxpbmVJbmRleCA8IHRoaXMuc2Nyb2xsT2Zmc2V0KSB7XG5cdFx0XHR0aGlzLnNjcm9sbE9mZnNldCA9IGN1cnNvckxpbmVJbmRleDtcblx0XHR9IGVsc2UgaWYgKGN1cnNvckxpbmVJbmRleCA+PSB0aGlzLnNjcm9sbE9mZnNldCArIG1heFZpc2libGVMaW5lcykge1xuXHRcdFx0dGhpcy5zY3JvbGxPZmZzZXQgPSBjdXJzb3JMaW5lSW5kZXggLSBtYXhWaXNpYmxlTGluZXMgKyAxO1xuXHRcdH1cblxuXHRcdC8vIENsYW1wIHNjcm9sbCBvZmZzZXQgdG8gdmFsaWQgcmFuZ2Vcblx0XHRjb25zdCBtYXhTY3JvbGxPZmZzZXQgPSBNYXRoLm1heCgwLCBsYXlvdXRMaW5lcy5sZW5ndGggLSBtYXhWaXNpYmxlTGluZXMpO1xuXHRcdHRoaXMuc2Nyb2xsT2Zmc2V0ID0gTWF0aC5tYXgoMCwgTWF0aC5taW4odGhpcy5zY3JvbGxPZmZzZXQsIG1heFNjcm9sbE9mZnNldCkpO1xuXG5cdFx0Ly8gR2V0IHZpc2libGUgbGluZXMgc2xpY2Vcblx0XHRjb25zdCB2aXNpYmxlTGluZXMgPSBsYXlvdXRMaW5lcy5zbGljZSh0aGlzLnNjcm9sbE9mZnNldCwgdGhpcy5zY3JvbGxPZmZzZXQgKyBtYXhWaXNpYmxlTGluZXMpO1xuXG5cdFx0Y29uc3QgcmVzdWx0OiBzdHJpbmdbXSA9IFtdO1xuXHRcdGNvbnN0IGxlZnRQYWRkaW5nID0gXCIgXCIucmVwZWF0KHBhZGRpbmdYKTtcblx0XHRjb25zdCByaWdodFBhZGRpbmcgPSBsZWZ0UGFkZGluZztcblxuXHRcdC8vIFJlbmRlciB0b3AgYm9yZGVyICh3aXRoIHNjcm9sbCBpbmRpY2F0b3IgaWYgc2Nyb2xsZWQgZG93bilcblx0XHRpZiAodGhpcy5zY3JvbGxPZmZzZXQgPiAwKSB7XG5cdFx0XHRjb25zdCBpbmRpY2F0b3IgPSBgXHUyNTAwXHUyNTAwXHUyNTAwIFx1MjE5MSAke3RoaXMuc2Nyb2xsT2Zmc2V0fSBtb3JlIGA7XG5cdFx0XHRjb25zdCByZW1haW5pbmcgPSB3aWR0aCAtIHZpc2libGVXaWR0aChpbmRpY2F0b3IpO1xuXHRcdFx0cmVzdWx0LnB1c2godGhpcy5ib3JkZXJDb2xvcihpbmRpY2F0b3IgKyBcIlx1MjUwMFwiLnJlcGVhdChNYXRoLm1heCgwLCByZW1haW5pbmcpKSkpO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHRyZXN1bHQucHVzaChob3Jpem9udGFsLnJlcGVhdCh3aWR0aCkpO1xuXHRcdH1cblxuXHRcdC8vIFJlbmRlciBlYWNoIHZpc2libGUgbGF5b3V0IGxpbmVcblx0XHQvLyBLZWVwIHRoZSBoYXJkd2FyZSBjdXJzb3IgYW5jaG9yZWQgd2hpbGUgYXV0b2NvbXBsZXRlIGlzIG9wZW4gc28gSU1FXG5cdFx0Ly8gY2FuZGlkYXRlIHdpbmRvd3Mgc3RpbGwgYXR0YWNoIHRvIHRoZSBlZGl0b3IgY2FyZXQuXG5cdFx0Y29uc3QgZW1pdEN1cnNvck1hcmtlciA9IHRoaXMuZm9jdXNlZDtcblxuXHRcdGZvciAoY29uc3QgbGF5b3V0TGluZSBvZiB2aXNpYmxlTGluZXMpIHtcblx0XHRcdGxldCBkaXNwbGF5VGV4dCA9IGxheW91dExpbmUudGV4dDtcblx0XHRcdGxldCBsaW5lVmlzaWJsZVdpZHRoID0gdmlzaWJsZVdpZHRoKGxheW91dExpbmUudGV4dCk7XG5cdFx0XHRsZXQgY3Vyc29ySW5QYWRkaW5nID0gZmFsc2U7XG5cblx0XHRcdC8vIEFkZCBjdXJzb3IgaWYgdGhpcyBsaW5lIGhhcyBpdFxuXHRcdFx0aWYgKGxheW91dExpbmUuaGFzQ3Vyc29yICYmIGxheW91dExpbmUuY3Vyc29yUG9zICE9PSB1bmRlZmluZWQpIHtcblx0XHRcdFx0Y29uc3QgYmVmb3JlID0gZGlzcGxheVRleHQuc2xpY2UoMCwgbGF5b3V0TGluZS5jdXJzb3JQb3MpO1xuXHRcdFx0XHRjb25zdCBhZnRlciA9IGRpc3BsYXlUZXh0LnNsaWNlKGxheW91dExpbmUuY3Vyc29yUG9zKTtcblxuXHRcdFx0XHQvLyBIYXJkd2FyZSBjdXJzb3IgbWFya2VyICh6ZXJvLXdpZHRoLCBlbWl0dGVkIGJlZm9yZSBmYWtlIGN1cnNvciBmb3IgSU1FIHBvc2l0aW9uaW5nKVxuXHRcdFx0XHRjb25zdCBtYXJrZXIgPSBlbWl0Q3Vyc29yTWFya2VyID8gQ1VSU09SX01BUktFUiA6IFwiXCI7XG5cblx0XHRcdFx0aWYgKGFmdGVyLmxlbmd0aCA+IDApIHtcblx0XHRcdFx0XHQvLyBDdXJzb3IgaXMgb24gYSBjaGFyYWN0ZXIgKGdyYXBoZW1lKSAtIHJlcGxhY2UgaXQgd2l0aCBoaWdobGlnaHRlZCB2ZXJzaW9uXG5cdFx0XHRcdFx0Ly8gR2V0IHRoZSBmaXJzdCBncmFwaGVtZSBmcm9tICdhZnRlcidcblx0XHRcdFx0XHRjb25zdCBhZnRlckdyYXBoZW1lcyA9IFsuLi5zZWdtZW50ZXIuc2VnbWVudChhZnRlcildO1xuXHRcdFx0XHRcdGNvbnN0IGZpcnN0R3JhcGhlbWUgPSBhZnRlckdyYXBoZW1lc1swXT8uc2VnbWVudCB8fCBcIlwiO1xuXHRcdFx0XHRcdGNvbnN0IHJlc3RBZnRlciA9IGFmdGVyLnNsaWNlKGZpcnN0R3JhcGhlbWUubGVuZ3RoKTtcblx0XHRcdFx0XHRjb25zdCBjdXJzb3IgPSBgXFx4MWJbN20ke2ZpcnN0R3JhcGhlbWV9XFx4MWJbMG1gO1xuXHRcdFx0XHRcdGRpc3BsYXlUZXh0ID0gYmVmb3JlICsgbWFya2VyICsgY3Vyc29yICsgcmVzdEFmdGVyO1xuXHRcdFx0XHRcdC8vIGxpbmVWaXNpYmxlV2lkdGggc3RheXMgdGhlIHNhbWUgLSB3ZSdyZSByZXBsYWNpbmcsIG5vdCBhZGRpbmdcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHQvLyBDdXJzb3IgaXMgYXQgdGhlIGVuZCAtIGFkZCBoaWdobGlnaHRlZCBzcGFjZVxuXHRcdFx0XHRcdGNvbnN0IGN1cnNvciA9IFwiXFx4MWJbN20gXFx4MWJbMG1cIjtcblx0XHRcdFx0XHRkaXNwbGF5VGV4dCA9IGJlZm9yZSArIG1hcmtlciArIGN1cnNvcjtcblx0XHRcdFx0XHRsaW5lVmlzaWJsZVdpZHRoID0gbGluZVZpc2libGVXaWR0aCArIDE7XG5cdFx0XHRcdFx0Ly8gSWYgY3Vyc29yIG92ZXJmbG93cyBjb250ZW50IHdpZHRoIGludG8gdGhlIHBhZGRpbmcsIGZsYWcgaXRcblx0XHRcdFx0XHRpZiAobGluZVZpc2libGVXaWR0aCA+IGNvbnRlbnRXaWR0aCAmJiBwYWRkaW5nWCA+IDApIHtcblx0XHRcdFx0XHRcdGN1cnNvckluUGFkZGluZyA9IHRydWU7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdC8vIENhbGN1bGF0ZSBwYWRkaW5nIGJhc2VkIG9uIGFjdHVhbCB2aXNpYmxlIHdpZHRoXG5cdFx0XHRjb25zdCBwYWRkaW5nID0gXCIgXCIucmVwZWF0KE1hdGgubWF4KDAsIGNvbnRlbnRXaWR0aCAtIGxpbmVWaXNpYmxlV2lkdGgpKTtcblx0XHRcdGNvbnN0IGxpbmVSaWdodFBhZGRpbmcgPSBjdXJzb3JJblBhZGRpbmcgPyByaWdodFBhZGRpbmcuc2xpY2UoMSkgOiByaWdodFBhZGRpbmc7XG5cblx0XHRcdC8vIFJlbmRlciB0aGUgbGluZSAobm8gc2lkZSBib3JkZXJzLCBqdXN0IGhvcml6b250YWwgbGluZXMgYWJvdmUgYW5kIGJlbG93KVxuXHRcdFx0cmVzdWx0LnB1c2goYCR7bGVmdFBhZGRpbmd9JHtkaXNwbGF5VGV4dH0ke3BhZGRpbmd9JHtsaW5lUmlnaHRQYWRkaW5nfWApO1xuXHRcdH1cblxuXHRcdC8vIFJlbmRlciBib3R0b20gYm9yZGVyICh3aXRoIHNjcm9sbCBpbmRpY2F0b3IgaWYgbW9yZSBjb250ZW50IGJlbG93KVxuXHRcdGNvbnN0IGxpbmVzQmVsb3cgPSBsYXlvdXRMaW5lcy5sZW5ndGggLSAodGhpcy5zY3JvbGxPZmZzZXQgKyB2aXNpYmxlTGluZXMubGVuZ3RoKTtcblx0XHRpZiAobGluZXNCZWxvdyA+IDApIHtcblx0XHRcdGNvbnN0IGluZGljYXRvciA9IGBcdTI1MDBcdTI1MDBcdTI1MDAgXHUyMTkzICR7bGluZXNCZWxvd30gbW9yZSBgO1xuXHRcdFx0Y29uc3QgcmVtYWluaW5nID0gd2lkdGggLSB2aXNpYmxlV2lkdGgoaW5kaWNhdG9yKTtcblx0XHRcdHJlc3VsdC5wdXNoKHRoaXMuYm9yZGVyQ29sb3IoaW5kaWNhdG9yICsgXCJcdTI1MDBcIi5yZXBlYXQoTWF0aC5tYXgoMCwgcmVtYWluaW5nKSkpKTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0cmVzdWx0LnB1c2goaG9yaXpvbnRhbC5yZXBlYXQod2lkdGgpKTtcblx0XHR9XG5cblx0XHQvLyBBZGQgYXV0b2NvbXBsZXRlIGxpc3QgaWYgYWN0aXZlXG5cdFx0aWYgKHRoaXMuYXV0b2NvbXBsZXRlU3RhdGUgJiYgdGhpcy5hdXRvY29tcGxldGVMaXN0KSB7XG5cdFx0XHRjb25zdCBhdXRvY29tcGxldGVSZXN1bHQgPSB0aGlzLmF1dG9jb21wbGV0ZUxpc3QucmVuZGVyKGNvbnRlbnRXaWR0aCk7XG5cdFx0XHRmb3IgKGNvbnN0IGxpbmUgb2YgYXV0b2NvbXBsZXRlUmVzdWx0KSB7XG5cdFx0XHRcdGNvbnN0IGxpbmVXaWR0aCA9IHZpc2libGVXaWR0aChsaW5lKTtcblx0XHRcdFx0Y29uc3QgbGluZVBhZGRpbmcgPSBcIiBcIi5yZXBlYXQoTWF0aC5tYXgoMCwgY29udGVudFdpZHRoIC0gbGluZVdpZHRoKSk7XG5cdFx0XHRcdHJlc3VsdC5wdXNoKGAke2xlZnRQYWRkaW5nfSR7bGluZX0ke2xpbmVQYWRkaW5nfSR7cmlnaHRQYWRkaW5nfWApO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdHJldHVybiByZXN1bHQ7XG5cdH1cblxuXHRoYW5kbGVJbnB1dChkYXRhOiBzdHJpbmcpOiB2b2lkIHtcblx0XHRjb25zdCBrYiA9IGdldEVkaXRvcktleWJpbmRpbmdzKCk7XG5cblx0XHQvLyBIYW5kbGUgY2hhcmFjdGVyIGp1bXAgbW9kZSAoYXdhaXRpbmcgbmV4dCBjaGFyYWN0ZXIgdG8ganVtcCB0bylcblx0XHRpZiAodGhpcy5qdW1wTW9kZSAhPT0gbnVsbCkge1xuXHRcdFx0Ly8gQ2FuY2VsIGlmIHRoZSBob3RrZXkgaXMgcHJlc3NlZCBhZ2FpblxuXHRcdFx0aWYgKGtiLm1hdGNoZXMoZGF0YSwgXCJqdW1wRm9yd2FyZFwiKSB8fCBrYi5tYXRjaGVzKGRhdGEsIFwianVtcEJhY2t3YXJkXCIpKSB7XG5cdFx0XHRcdHRoaXMuanVtcE1vZGUgPSBudWxsO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cblx0XHRcdGlmIChkYXRhLmNoYXJDb2RlQXQoMCkgPj0gMzIpIHtcblx0XHRcdFx0Ly8gUHJpbnRhYmxlIGNoYXJhY3RlciAtIHBlcmZvcm0gdGhlIGp1bXBcblx0XHRcdFx0Y29uc3QgZGlyZWN0aW9uID0gdGhpcy5qdW1wTW9kZTtcblx0XHRcdFx0dGhpcy5qdW1wTW9kZSA9IG51bGw7XG5cdFx0XHRcdHRoaXMuanVtcFRvQ2hhcihkYXRhLCBkaXJlY3Rpb24pO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cblx0XHRcdC8vIENvbnRyb2wgY2hhcmFjdGVyIC0gY2FuY2VsIGFuZCBmYWxsIHRocm91Z2ggdG8gbm9ybWFsIGhhbmRsaW5nXG5cdFx0XHR0aGlzLmp1bXBNb2RlID0gbnVsbDtcblx0XHR9XG5cblx0XHQvLyBIYW5kbGUgYnJhY2tldGVkIHBhc3RlIG1vZGVcblx0XHRpZiAoZGF0YS5pbmNsdWRlcyhcIlxceDFiWzIwMH5cIikpIHtcblx0XHRcdHRoaXMuaXNJblBhc3RlID0gdHJ1ZTtcblx0XHRcdHRoaXMucGFzdGVCdWZmZXIgPSBcIlwiO1xuXHRcdFx0ZGF0YSA9IGRhdGEucmVwbGFjZShcIlxceDFiWzIwMH5cIiwgXCJcIik7XG5cdFx0fVxuXG5cdFx0aWYgKHRoaXMuaXNJblBhc3RlKSB7XG5cdFx0XHR0aGlzLnBhc3RlQnVmZmVyICs9IGRhdGE7XG5cdFx0XHRjb25zdCBlbmRJbmRleCA9IHRoaXMucGFzdGVCdWZmZXIuaW5kZXhPZihcIlxceDFiWzIwMX5cIik7XG5cdFx0XHRpZiAoZW5kSW5kZXggIT09IC0xKSB7XG5cdFx0XHRcdGNvbnN0IHBhc3RlQ29udGVudCA9IHRoaXMucGFzdGVCdWZmZXIuc3Vic3RyaW5nKDAsIGVuZEluZGV4KTtcblx0XHRcdFx0aWYgKHBhc3RlQ29udGVudC5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdFx0dGhpcy5oYW5kbGVQYXN0ZShwYXN0ZUNvbnRlbnQpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdHRoaXMuaXNJblBhc3RlID0gZmFsc2U7XG5cdFx0XHRcdGNvbnN0IHJlbWFpbmluZyA9IHRoaXMucGFzdGVCdWZmZXIuc3Vic3RyaW5nKGVuZEluZGV4ICsgNik7XG5cdFx0XHRcdHRoaXMucGFzdGVCdWZmZXIgPSBcIlwiO1xuXHRcdFx0XHRpZiAocmVtYWluaW5nLmxlbmd0aCA+IDApIHtcblx0XHRcdFx0XHR0aGlzLmhhbmRsZUlucHV0KHJlbWFpbmluZyk7XG5cdFx0XHRcdH1cblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdC8vIEN0cmwrQyAtIGxldCBwYXJlbnQgaGFuZGxlIChleGl0L2NsZWFyKVxuXHRcdGlmIChrYi5tYXRjaGVzKGRhdGEsIFwiY29weVwiKSkge1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdC8vIFVuZG9cblx0XHRpZiAoa2IubWF0Y2hlcyhkYXRhLCBcInVuZG9cIikpIHtcblx0XHRcdHRoaXMudW5kbygpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdC8vIEhhbmRsZSBhdXRvY29tcGxldGUgbW9kZVxuXHRcdGlmICh0aGlzLmF1dG9jb21wbGV0ZVN0YXRlICYmIHRoaXMuYXV0b2NvbXBsZXRlTGlzdCkge1xuXHRcdFx0aWYgKGtiLm1hdGNoZXMoZGF0YSwgXCJzZWxlY3RDYW5jZWxcIikpIHtcblx0XHRcdFx0dGhpcy5jYW5jZWxBdXRvY29tcGxldGUoKTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXG5cdFx0XHRpZiAoa2IubWF0Y2hlcyhkYXRhLCBcInNlbGVjdFVwXCIpIHx8IGtiLm1hdGNoZXMoZGF0YSwgXCJzZWxlY3REb3duXCIpKSB7XG5cdFx0XHRcdHRoaXMuYXV0b2NvbXBsZXRlTGlzdC5oYW5kbGVJbnB1dChkYXRhKTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXG5cdFx0XHRpZiAoa2IubWF0Y2hlcyhkYXRhLCBcInRhYlwiKSkge1xuXHRcdFx0XHRjb25zdCBzZWxlY3RlZCA9IHRoaXMuYXV0b2NvbXBsZXRlTGlzdC5nZXRTZWxlY3RlZEl0ZW0oKTtcblx0XHRcdFx0aWYgKHNlbGVjdGVkICYmIHRoaXMuYXV0b2NvbXBsZXRlUHJvdmlkZXIpIHtcblx0XHRcdFx0XHRjb25zdCBzaG91bGRDaGFpblNsYXNoQXJndW1lbnRBdXRvY29tcGxldGUgPSB0aGlzLnNob3VsZENoYWluU2xhc2hBcmd1bWVudEF1dG9jb21wbGV0ZU9uVGFiU2VsZWN0aW9uKCk7XG5cblx0XHRcdFx0XHR0aGlzLnB1c2hVbmRvU25hcHNob3QoKTtcblx0XHRcdFx0XHR0aGlzLmxhc3RBY3Rpb24gPSBudWxsO1xuXHRcdFx0XHRcdGNvbnN0IHJlc3VsdCA9IHRoaXMuYXV0b2NvbXBsZXRlUHJvdmlkZXIuYXBwbHlDb21wbGV0aW9uKFxuXHRcdFx0XHRcdFx0dGhpcy5zdGF0ZS5saW5lcyxcblx0XHRcdFx0XHRcdHRoaXMuc3RhdGUuY3Vyc29yTGluZSxcblx0XHRcdFx0XHRcdHRoaXMuc3RhdGUuY3Vyc29yQ29sLFxuXHRcdFx0XHRcdFx0c2VsZWN0ZWQsXG5cdFx0XHRcdFx0XHR0aGlzLmF1dG9jb21wbGV0ZVByZWZpeCxcblx0XHRcdFx0XHQpO1xuXHRcdFx0XHRcdHRoaXMuc3RhdGUubGluZXMgPSByZXN1bHQubGluZXM7XG5cdFx0XHRcdFx0dGhpcy5zdGF0ZS5jdXJzb3JMaW5lID0gcmVzdWx0LmN1cnNvckxpbmU7XG5cdFx0XHRcdFx0dGhpcy5zZXRDdXJzb3JDb2wocmVzdWx0LmN1cnNvckNvbCk7XG5cdFx0XHRcdFx0dGhpcy5jYW5jZWxBdXRvY29tcGxldGUoKTtcblx0XHRcdFx0XHR0aGlzLmVtaXRDaGFuZ2UoKTtcblxuXHRcdFx0XHRcdGlmIChzaG91bGRDaGFpblNsYXNoQXJndW1lbnRBdXRvY29tcGxldGUgJiYgdGhpcy5pc0JhcmVDb21wbGV0ZWRTbGFzaENvbW1hbmRBdEN1cnNvcigpKSB7XG5cdFx0XHRcdFx0XHR0aGlzLnRyeVRyaWdnZXJBdXRvY29tcGxldGUoKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXG5cdFx0XHRpZiAoa2IubWF0Y2hlcyhkYXRhLCBcInNlbGVjdENvbmZpcm1cIikpIHtcblx0XHRcdFx0Y29uc3Qgc2VsZWN0ZWQgPSB0aGlzLmF1dG9jb21wbGV0ZUxpc3QuZ2V0U2VsZWN0ZWRJdGVtKCk7XG5cdFx0XHRcdGlmIChzZWxlY3RlZCAmJiB0aGlzLmF1dG9jb21wbGV0ZVByb3ZpZGVyKSB7XG5cdFx0XHRcdFx0dGhpcy5wdXNoVW5kb1NuYXBzaG90KCk7XG5cdFx0XHRcdFx0dGhpcy5sYXN0QWN0aW9uID0gbnVsbDtcblx0XHRcdFx0XHRjb25zdCByZXN1bHQgPSB0aGlzLmF1dG9jb21wbGV0ZVByb3ZpZGVyLmFwcGx5Q29tcGxldGlvbihcblx0XHRcdFx0XHRcdHRoaXMuc3RhdGUubGluZXMsXG5cdFx0XHRcdFx0XHR0aGlzLnN0YXRlLmN1cnNvckxpbmUsXG5cdFx0XHRcdFx0XHR0aGlzLnN0YXRlLmN1cnNvckNvbCxcblx0XHRcdFx0XHRcdHNlbGVjdGVkLFxuXHRcdFx0XHRcdFx0dGhpcy5hdXRvY29tcGxldGVQcmVmaXgsXG5cdFx0XHRcdFx0KTtcblx0XHRcdFx0XHR0aGlzLnN0YXRlLmxpbmVzID0gcmVzdWx0LmxpbmVzO1xuXHRcdFx0XHRcdHRoaXMuc3RhdGUuY3Vyc29yTGluZSA9IHJlc3VsdC5jdXJzb3JMaW5lO1xuXHRcdFx0XHRcdHRoaXMuc2V0Q3Vyc29yQ29sKHJlc3VsdC5jdXJzb3JDb2wpO1xuXG5cdFx0XHRcdFx0aWYgKHRoaXMuYXV0b2NvbXBsZXRlUHJlZml4LnN0YXJ0c1dpdGgoXCIvXCIpIHx8IHRoaXMuaXNJblNsYXNoQ29tbWFuZENvbnRleHQoXG5cdFx0XHRcdFx0XHQodGhpcy5zdGF0ZS5saW5lc1t0aGlzLnN0YXRlLmN1cnNvckxpbmVdIHx8IFwiXCIpLnNsaWNlKDAsIHRoaXMuc3RhdGUuY3Vyc29yQ29sKSxcblx0XHRcdFx0XHQpKSB7XG5cdFx0XHRcdFx0XHR0aGlzLmNhbmNlbEF1dG9jb21wbGV0ZSgpO1xuXHRcdFx0XHRcdFx0Ly8gRmFsbCB0aHJvdWdoIHRvIHN1Ym1pdFxuXHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHR0aGlzLmNhbmNlbEF1dG9jb21wbGV0ZSgpO1xuXHRcdFx0XHRcdFx0dGhpcy5lbWl0Q2hhbmdlKCk7XG5cdFx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0Ly8gVGFiIC0gdHJpZ2dlciBjb21wbGV0aW9uXG5cdFx0aWYgKGtiLm1hdGNoZXMoZGF0YSwgXCJ0YWJcIikgJiYgIXRoaXMuYXV0b2NvbXBsZXRlU3RhdGUpIHtcblx0XHRcdHRoaXMuaGFuZGxlVGFiQ29tcGxldGlvbigpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdC8vIERlbGV0aW9uIGFjdGlvbnNcblx0XHRpZiAoa2IubWF0Y2hlcyhkYXRhLCBcImRlbGV0ZVRvTGluZUVuZFwiKSkge1xuXHRcdFx0dGhpcy5kZWxldGVUb0VuZE9mTGluZSgpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblx0XHRpZiAoa2IubWF0Y2hlcyhkYXRhLCBcImRlbGV0ZVRvTGluZVN0YXJ0XCIpKSB7XG5cdFx0XHR0aGlzLmRlbGV0ZVRvU3RhcnRPZkxpbmUoKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cdFx0aWYgKGtiLm1hdGNoZXMoZGF0YSwgXCJkZWxldGVXb3JkQmFja3dhcmRcIikpIHtcblx0XHRcdHRoaXMuZGVsZXRlV29yZEJhY2t3YXJkcygpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblx0XHRpZiAoa2IubWF0Y2hlcyhkYXRhLCBcImRlbGV0ZVdvcmRGb3J3YXJkXCIpKSB7XG5cdFx0XHR0aGlzLmRlbGV0ZVdvcmRGb3J3YXJkKCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXHRcdGlmIChrYi5tYXRjaGVzKGRhdGEsIFwiZGVsZXRlQ2hhckJhY2t3YXJkXCIpIHx8IG1hdGNoZXNLZXkoZGF0YSwgXCJzaGlmdCtiYWNrc3BhY2VcIikpIHtcblx0XHRcdHRoaXMuaGFuZGxlQmFja3NwYWNlKCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXHRcdGlmIChrYi5tYXRjaGVzKGRhdGEsIFwiZGVsZXRlQ2hhckZvcndhcmRcIikgfHwgbWF0Y2hlc0tleShkYXRhLCBcInNoaWZ0K2RlbGV0ZVwiKSkge1xuXHRcdFx0dGhpcy5oYW5kbGVGb3J3YXJkRGVsZXRlKCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Ly8gS2lsbCByaW5nIGFjdGlvbnNcblx0XHRpZiAoa2IubWF0Y2hlcyhkYXRhLCBcInlhbmtcIikpIHtcblx0XHRcdHRoaXMueWFuaygpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblx0XHRpZiAoa2IubWF0Y2hlcyhkYXRhLCBcInlhbmtQb3BcIikpIHtcblx0XHRcdHRoaXMueWFua1BvcCgpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdC8vIEN1cnNvciBtb3ZlbWVudCBhY3Rpb25zXG5cdFx0aWYgKGtiLm1hdGNoZXMoZGF0YSwgXCJjdXJzb3JMaW5lU3RhcnRcIikpIHtcblx0XHRcdHRoaXMubW92ZVRvTGluZVN0YXJ0KCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXHRcdGlmIChrYi5tYXRjaGVzKGRhdGEsIFwiY3Vyc29yTGluZUVuZFwiKSkge1xuXHRcdFx0dGhpcy5tb3ZlVG9MaW5lRW5kKCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXHRcdGlmIChrYi5tYXRjaGVzKGRhdGEsIFwiY3Vyc29yV29yZExlZnRcIikpIHtcblx0XHRcdHRoaXMubW92ZVdvcmRCYWNrd2FyZHMoKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cdFx0aWYgKGtiLm1hdGNoZXMoZGF0YSwgXCJjdXJzb3JXb3JkUmlnaHRcIikpIHtcblx0XHRcdHRoaXMubW92ZVdvcmRGb3J3YXJkcygpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdC8vIE5ldyBsaW5lXG5cdFx0aWYgKFxuXHRcdFx0a2IubWF0Y2hlcyhkYXRhLCBcIm5ld0xpbmVcIikgfHxcblx0XHRcdChkYXRhLmNoYXJDb2RlQXQoMCkgPT09IDEwICYmIGRhdGEubGVuZ3RoID4gMSkgfHxcblx0XHRcdGRhdGEgPT09IFwiXFx4MWJcXHJcIiB8fFxuXHRcdFx0ZGF0YSA9PT0gXCJcXHgxYlsxMzsyflwiIHx8XG5cdFx0XHQoZGF0YS5sZW5ndGggPiAxICYmIGRhdGEuaW5jbHVkZXMoXCJcXHgxYlwiKSAmJiBkYXRhLmluY2x1ZGVzKFwiXFxyXCIpKSB8fFxuXHRcdFx0KGRhdGEgPT09IFwiXFxuXCIgJiYgZGF0YS5sZW5ndGggPT09IDEpXG5cdFx0KSB7XG5cdFx0XHRpZiAodGhpcy5zaG91bGRTdWJtaXRPbkJhY2tzbGFzaEVudGVyKGRhdGEsIGtiKSkge1xuXHRcdFx0XHR0aGlzLmhhbmRsZUJhY2tzcGFjZSgpO1xuXHRcdFx0XHR0aGlzLnN1Ym1pdFZhbHVlKCk7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblx0XHRcdHRoaXMuYWRkTmV3TGluZSgpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdC8vIFN1Ym1pdCAoRW50ZXIpXG5cdFx0aWYgKGtiLm1hdGNoZXMoZGF0YSwgXCJzdWJtaXRcIikpIHtcblx0XHRcdGlmICh0aGlzLmRpc2FibGVTdWJtaXQpIHJldHVybjtcblxuXHRcdFx0Ly8gV29ya2Fyb3VuZCBmb3IgdGVybWluYWxzIHdpdGhvdXQgU2hpZnQrRW50ZXIgc3VwcG9ydDpcblx0XHRcdC8vIElmIGNoYXIgYmVmb3JlIGN1cnNvciBpcyBcXCwgZGVsZXRlIGl0IGFuZCBpbnNlcnQgbmV3bGluZSBpbnN0ZWFkIG9mIHN1Ym1pdHRpbmcuXG5cdFx0XHRjb25zdCBjdXJyZW50TGluZSA9IHRoaXMuc3RhdGUubGluZXNbdGhpcy5zdGF0ZS5jdXJzb3JMaW5lXSB8fCBcIlwiO1xuXHRcdFx0aWYgKHRoaXMuc3RhdGUuY3Vyc29yQ29sID4gMCAmJiBjdXJyZW50TGluZVt0aGlzLnN0YXRlLmN1cnNvckNvbCAtIDFdID09PSBcIlxcXFxcIikge1xuXHRcdFx0XHR0aGlzLmhhbmRsZUJhY2tzcGFjZSgpO1xuXHRcdFx0XHR0aGlzLmFkZE5ld0xpbmUoKTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXG5cdFx0XHR0aGlzLnN1Ym1pdFZhbHVlKCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Ly8gQXJyb3cga2V5IG5hdmlnYXRpb24gKHdpdGggaGlzdG9yeSBzdXBwb3J0KVxuXHRcdGlmIChrYi5tYXRjaGVzKGRhdGEsIFwiY3Vyc29yVXBcIikpIHtcblx0XHRcdGlmICh0aGlzLmlzRWRpdG9yRW1wdHkoKSkge1xuXHRcdFx0XHR0aGlzLm5hdmlnYXRlSGlzdG9yeSgtMSk7XG5cdFx0XHR9IGVsc2UgaWYgKHRoaXMuaGlzdG9yeUluZGV4ID4gLTEgJiYgdGhpcy5pc09uRmlyc3RWaXN1YWxMaW5lKCkpIHtcblx0XHRcdFx0dGhpcy5uYXZpZ2F0ZUhpc3RvcnkoLTEpO1xuXHRcdFx0fSBlbHNlIGlmICh0aGlzLmlzT25GaXJzdFZpc3VhbExpbmUoKSkge1xuXHRcdFx0XHQvLyBBbHJlYWR5IGF0IHRvcCAtIGp1bXAgdG8gc3RhcnQgb2YgbGluZVxuXHRcdFx0XHR0aGlzLm1vdmVUb0xpbmVTdGFydCgpO1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0dGhpcy5tb3ZlQ3Vyc29yKC0xLCAwKTtcblx0XHRcdH1cblx0XHRcdHJldHVybjtcblx0XHR9XG5cdFx0aWYgKGtiLm1hdGNoZXMoZGF0YSwgXCJjdXJzb3JEb3duXCIpKSB7XG5cdFx0XHRpZiAodGhpcy5oaXN0b3J5SW5kZXggPiAtMSAmJiB0aGlzLmlzT25MYXN0VmlzdWFsTGluZSgpKSB7XG5cdFx0XHRcdHRoaXMubmF2aWdhdGVIaXN0b3J5KDEpO1xuXHRcdFx0fSBlbHNlIGlmICh0aGlzLmlzT25MYXN0VmlzdWFsTGluZSgpKSB7XG5cdFx0XHRcdC8vIEFscmVhZHkgYXQgYm90dG9tIC0ganVtcCB0byBlbmQgb2YgbGluZVxuXHRcdFx0XHR0aGlzLm1vdmVUb0xpbmVFbmQoKTtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdHRoaXMubW92ZUN1cnNvcigxLCAwKTtcblx0XHRcdH1cblx0XHRcdHJldHVybjtcblx0XHR9XG5cdFx0aWYgKGtiLm1hdGNoZXMoZGF0YSwgXCJjdXJzb3JSaWdodFwiKSkge1xuXHRcdFx0dGhpcy5tb3ZlQ3Vyc29yKDAsIDEpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblx0XHRpZiAoa2IubWF0Y2hlcyhkYXRhLCBcImN1cnNvckxlZnRcIikpIHtcblx0XHRcdHRoaXMubW92ZUN1cnNvcigwLCAtMSk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Ly8gUGFnZSB1cC9kb3duIC0gc2Nyb2xsIGJ5IHBhZ2UgYW5kIG1vdmUgY3Vyc29yXG5cdFx0aWYgKGtiLm1hdGNoZXMoZGF0YSwgXCJwYWdlVXBcIikpIHtcblx0XHRcdHRoaXMucGFnZVNjcm9sbCgtMSk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXHRcdGlmIChrYi5tYXRjaGVzKGRhdGEsIFwicGFnZURvd25cIikpIHtcblx0XHRcdHRoaXMucGFnZVNjcm9sbCgxKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHQvLyBDaGFyYWN0ZXIganVtcCBtb2RlIHRyaWdnZXJzXG5cdFx0aWYgKGtiLm1hdGNoZXMoZGF0YSwgXCJqdW1wRm9yd2FyZFwiKSkge1xuXHRcdFx0dGhpcy5qdW1wTW9kZSA9IFwiZm9yd2FyZFwiO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblx0XHRpZiAoa2IubWF0Y2hlcyhkYXRhLCBcImp1bXBCYWNrd2FyZFwiKSkge1xuXHRcdFx0dGhpcy5qdW1wTW9kZSA9IFwiYmFja3dhcmRcIjtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHQvLyBTaGlmdCtTcGFjZSAtIGluc2VydCByZWd1bGFyIHNwYWNlXG5cdFx0aWYgKG1hdGNoZXNLZXkoZGF0YSwgXCJzaGlmdCtzcGFjZVwiKSkge1xuXHRcdFx0dGhpcy5pbnNlcnRDaGFyYWN0ZXIoXCIgXCIpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGNvbnN0IGtpdHR5UHJpbnRhYmxlID0gZGVjb2RlS2l0dHlQcmludGFibGUoZGF0YSk7XG5cdFx0aWYgKGtpdHR5UHJpbnRhYmxlICE9PSB1bmRlZmluZWQpIHtcblx0XHRcdHRoaXMuaW5zZXJ0Q2hhcmFjdGVyKGtpdHR5UHJpbnRhYmxlKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHQvLyBSZWd1bGFyIGNoYXJhY3RlcnMgXHUyMDE0IHJlamVjdCBwYXJ0aWFsIGVzY2FwZSBzZXF1ZW5jZSByZW1uYW50cyB0aGF0IGNhblxuXHRcdC8vIG9jY3VyIHdoZW4gZXZlbnQgbG9vcCBsYXRlbmN5IGNhdXNlcyB0aGUgU3RkaW5CdWZmZXIgdG8gc3BsaXQgYW4gZXNjYXBlXG5cdFx0Ly8gc2VxdWVuY2UgKGUuZy4gXFx4MWIgZmx1c2hlZCBhcyBFU0MsIHRoZW4gXCJbRFwiIGFycml2ZXMgYXMgdGV4dCkuXG5cdFx0aWYgKGRhdGEuY2hhckNvZGVBdCgwKSA+PSAzMikge1xuXHRcdFx0aWYgKGRhdGFbMF0gPT09IFwiW1wiICYmIGRhdGEubGVuZ3RoID49IDIgJiYgZGF0YS5sZW5ndGggPD0gOCkge1xuXHRcdFx0XHRjb25zdCBsYXN0ID0gZGF0YVtkYXRhLmxlbmd0aCAtIDFdITtcblx0XHRcdFx0Ly8gQ1NJIG5hdmlnYXRpb24gcmVtbmFudHM6IFtBLUYgKGFycm93cy9ob21lL2VuZCksIFtILCBbWiAoc2hpZnQtdGFiKSwgWzxuPn4gKGZ1bmMga2V5cylcblx0XHRcdFx0aWYgKC9eW0EtRkhaXSQvLnRlc3QobGFzdCkgfHwgbGFzdCA9PT0gXCJ+XCIpIHtcblx0XHRcdFx0XHRyZXR1cm47IC8vIERyb3AgQ1NJIHJlbW5hbnQgKGUuZy4gXCJbRFwiLCBcIltDXCIsIFwiWzV+XCIpXG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHRcdHRoaXMuaW5zZXJ0Q2hhcmFjdGVyKGRhdGEpO1xuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgbGF5b3V0VGV4dChjb250ZW50V2lkdGg6IG51bWJlcik6IExheW91dExpbmVbXSB7XG5cdFx0Y29uc3QgbGF5b3V0TGluZXM6IExheW91dExpbmVbXSA9IFtdO1xuXG5cdFx0aWYgKHRoaXMuc3RhdGUubGluZXMubGVuZ3RoID09PSAwIHx8ICh0aGlzLnN0YXRlLmxpbmVzLmxlbmd0aCA9PT0gMSAmJiB0aGlzLnN0YXRlLmxpbmVzWzBdID09PSBcIlwiKSkge1xuXHRcdFx0Ly8gRW1wdHkgZWRpdG9yXG5cdFx0XHRsYXlvdXRMaW5lcy5wdXNoKHtcblx0XHRcdFx0dGV4dDogXCJcIixcblx0XHRcdFx0aGFzQ3Vyc29yOiB0cnVlLFxuXHRcdFx0XHRjdXJzb3JQb3M6IDAsXG5cdFx0XHR9KTtcblx0XHRcdHJldHVybiBsYXlvdXRMaW5lcztcblx0XHR9XG5cblx0XHQvLyBQcm9jZXNzIGVhY2ggbG9naWNhbCBsaW5lXG5cdFx0Zm9yIChsZXQgaSA9IDA7IGkgPCB0aGlzLnN0YXRlLmxpbmVzLmxlbmd0aDsgaSsrKSB7XG5cdFx0XHRjb25zdCBsaW5lID0gdGhpcy5zdGF0ZS5saW5lc1tpXSB8fCBcIlwiO1xuXHRcdFx0Y29uc3QgaXNDdXJyZW50TGluZSA9IGkgPT09IHRoaXMuc3RhdGUuY3Vyc29yTGluZTtcblx0XHRcdGNvbnN0IGxpbmVWaXNpYmxlV2lkdGggPSB2aXNpYmxlV2lkdGgobGluZSk7XG5cblx0XHRcdGlmIChsaW5lVmlzaWJsZVdpZHRoIDw9IGNvbnRlbnRXaWR0aCkge1xuXHRcdFx0XHQvLyBMaW5lIGZpdHMgaW4gb25lIGxheW91dCBsaW5lXG5cdFx0XHRcdGlmIChpc0N1cnJlbnRMaW5lKSB7XG5cdFx0XHRcdFx0bGF5b3V0TGluZXMucHVzaCh7XG5cdFx0XHRcdFx0XHR0ZXh0OiBsaW5lLFxuXHRcdFx0XHRcdFx0aGFzQ3Vyc29yOiB0cnVlLFxuXHRcdFx0XHRcdFx0Y3Vyc29yUG9zOiB0aGlzLnN0YXRlLmN1cnNvckNvbCxcblx0XHRcdFx0XHR9KTtcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRsYXlvdXRMaW5lcy5wdXNoKHtcblx0XHRcdFx0XHRcdHRleHQ6IGxpbmUsXG5cdFx0XHRcdFx0XHRoYXNDdXJzb3I6IGZhbHNlLFxuXHRcdFx0XHRcdH0pO1xuXHRcdFx0XHR9XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHQvLyBMaW5lIG5lZWRzIHdyYXBwaW5nIC0gdXNlIHdvcmQtYXdhcmUgd3JhcHBpbmdcblx0XHRcdFx0Y29uc3QgY2h1bmtzID0gd29yZFdyYXBMaW5lKGxpbmUsIGNvbnRlbnRXaWR0aCk7XG5cblx0XHRcdFx0Zm9yIChsZXQgY2h1bmtJbmRleCA9IDA7IGNodW5rSW5kZXggPCBjaHVua3MubGVuZ3RoOyBjaHVua0luZGV4KyspIHtcblx0XHRcdFx0XHRjb25zdCBjaHVuayA9IGNodW5rc1tjaHVua0luZGV4XTtcblx0XHRcdFx0XHRpZiAoIWNodW5rKSBjb250aW51ZTtcblxuXHRcdFx0XHRcdGNvbnN0IGN1cnNvclBvcyA9IHRoaXMuc3RhdGUuY3Vyc29yQ29sO1xuXHRcdFx0XHRcdGNvbnN0IGlzTGFzdENodW5rID0gY2h1bmtJbmRleCA9PT0gY2h1bmtzLmxlbmd0aCAtIDE7XG5cblx0XHRcdFx0XHQvLyBEZXRlcm1pbmUgaWYgY3Vyc29yIGlzIGluIHRoaXMgY2h1bmtcblx0XHRcdFx0XHQvLyBGb3Igd29yZC13cmFwcGVkIGNodW5rcywgd2UgbmVlZCB0byBoYW5kbGUgdGhlIGNhc2Ugd2hlcmVcblx0XHRcdFx0XHQvLyBjdXJzb3IgbWlnaHQgYmUgaW4gdHJpbW1lZCB3aGl0ZXNwYWNlIGF0IGVuZCBvZiBjaHVua1xuXHRcdFx0XHRcdGxldCBoYXNDdXJzb3JJbkNodW5rID0gZmFsc2U7XG5cdFx0XHRcdFx0bGV0IGFkanVzdGVkQ3Vyc29yUG9zID0gMDtcblxuXHRcdFx0XHRcdGlmIChpc0N1cnJlbnRMaW5lKSB7XG5cdFx0XHRcdFx0XHRpZiAoaXNMYXN0Q2h1bmspIHtcblx0XHRcdFx0XHRcdFx0Ly8gTGFzdCBjaHVuazogY3Vyc29yIGJlbG9uZ3MgaGVyZSBpZiA+PSBzdGFydEluZGV4XG5cdFx0XHRcdFx0XHRcdGhhc0N1cnNvckluQ2h1bmsgPSBjdXJzb3JQb3MgPj0gY2h1bmsuc3RhcnRJbmRleDtcblx0XHRcdFx0XHRcdFx0YWRqdXN0ZWRDdXJzb3JQb3MgPSBjdXJzb3JQb3MgLSBjaHVuay5zdGFydEluZGV4O1xuXHRcdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdFx0Ly8gTm9uLWxhc3QgY2h1bms6IGN1cnNvciBiZWxvbmdzIGhlcmUgaWYgaW4gcmFuZ2UgW3N0YXJ0SW5kZXgsIGVuZEluZGV4KVxuXHRcdFx0XHRcdFx0XHQvLyBCdXQgd2UgbmVlZCB0byBoYW5kbGUgdGhlIHZpc3VhbCBwb3NpdGlvbiBpbiB0aGUgdHJpbW1lZCB0ZXh0XG5cdFx0XHRcdFx0XHRcdGhhc0N1cnNvckluQ2h1bmsgPSBjdXJzb3JQb3MgPj0gY2h1bmsuc3RhcnRJbmRleCAmJiBjdXJzb3JQb3MgPCBjaHVuay5lbmRJbmRleDtcblx0XHRcdFx0XHRcdFx0aWYgKGhhc0N1cnNvckluQ2h1bmspIHtcblx0XHRcdFx0XHRcdFx0XHRhZGp1c3RlZEN1cnNvclBvcyA9IGN1cnNvclBvcyAtIGNodW5rLnN0YXJ0SW5kZXg7XG5cdFx0XHRcdFx0XHRcdFx0Ly8gQ2xhbXAgdG8gdGV4dCBsZW5ndGggKGluIGNhc2UgY3Vyc29yIHdhcyBpbiB0cmltbWVkIHdoaXRlc3BhY2UpXG5cdFx0XHRcdFx0XHRcdFx0aWYgKGFkanVzdGVkQ3Vyc29yUG9zID4gY2h1bmsudGV4dC5sZW5ndGgpIHtcblx0XHRcdFx0XHRcdFx0XHRcdGFkanVzdGVkQ3Vyc29yUG9zID0gY2h1bmsudGV4dC5sZW5ndGg7XG5cdFx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0aWYgKGhhc0N1cnNvckluQ2h1bmspIHtcblx0XHRcdFx0XHRcdGxheW91dExpbmVzLnB1c2goe1xuXHRcdFx0XHRcdFx0XHR0ZXh0OiBjaHVuay50ZXh0LFxuXHRcdFx0XHRcdFx0XHRoYXNDdXJzb3I6IHRydWUsXG5cdFx0XHRcdFx0XHRcdGN1cnNvclBvczogYWRqdXN0ZWRDdXJzb3JQb3MsXG5cdFx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0bGF5b3V0TGluZXMucHVzaCh7XG5cdFx0XHRcdFx0XHRcdHRleHQ6IGNodW5rLnRleHQsXG5cdFx0XHRcdFx0XHRcdGhhc0N1cnNvcjogZmFsc2UsXG5cdFx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9XG5cblx0XHRyZXR1cm4gbGF5b3V0TGluZXM7XG5cdH1cblxuXHRnZXRUZXh0KCk6IHN0cmluZyB7XG5cdFx0aWYgKHRoaXMuY2FjaGVkVGV4dCA9PT0gbnVsbCkge1xuXHRcdFx0dGhpcy5jYWNoZWRUZXh0ID0gdGhpcy5zdGF0ZS5saW5lcy5qb2luKFwiXFxuXCIpO1xuXHRcdH1cblx0XHRyZXR1cm4gdGhpcy5jYWNoZWRUZXh0O1xuXHR9XG5cblx0LyoqXG5cdCAqIEdldCB0ZXh0IHdpdGggcGFzdGUgbWFya2VycyBleHBhbmRlZCB0byB0aGVpciBhY3R1YWwgY29udGVudC5cblx0ICogVXNlIHRoaXMgd2hlbiB5b3UgbmVlZCB0aGUgZnVsbCBjb250ZW50IChlLmcuLCBmb3IgZXh0ZXJuYWwgZWRpdG9yKS5cblx0ICovXG5cdGdldEV4cGFuZGVkVGV4dCgpOiBzdHJpbmcge1xuXHRcdGxldCByZXN1bHQgPSB0aGlzLnN0YXRlLmxpbmVzLmpvaW4oXCJcXG5cIik7XG5cdFx0Zm9yIChjb25zdCBbcGFzdGVJZCwgcGFzdGVDb250ZW50XSBvZiB0aGlzLnBhc3Rlcykge1xuXHRcdFx0Y29uc3QgbWFya2VyUmVnZXggPSBuZXcgUmVnRXhwKGBcXFxcW3Bhc3RlICMke3Bhc3RlSWR9KCAoXFxcXCtcXFxcZCsgbGluZXN8XFxcXGQrIGNoYXJzKSk/XFxcXF1gLCBcImdcIik7XG5cdFx0XHRyZXN1bHQgPSByZXN1bHQucmVwbGFjZShtYXJrZXJSZWdleCwgcGFzdGVDb250ZW50KTtcblx0XHR9XG5cdFx0cmV0dXJuIHJlc3VsdDtcblx0fVxuXG5cdGdldExpbmVzKCk6IHN0cmluZ1tdIHtcblx0XHRyZXR1cm4gWy4uLnRoaXMuc3RhdGUubGluZXNdO1xuXHR9XG5cblx0Z2V0Q3Vyc29yKCk6IHsgbGluZTogbnVtYmVyOyBjb2w6IG51bWJlciB9IHtcblx0XHRyZXR1cm4geyBsaW5lOiB0aGlzLnN0YXRlLmN1cnNvckxpbmUsIGNvbDogdGhpcy5zdGF0ZS5jdXJzb3JDb2wgfTtcblx0fVxuXG5cdHNldFRleHQodGV4dDogc3RyaW5nKTogdm9pZCB7XG5cdFx0dGhpcy5sYXN0QWN0aW9uID0gbnVsbDtcblx0XHR0aGlzLmhpc3RvcnlJbmRleCA9IC0xOyAvLyBFeGl0IGhpc3RvcnkgYnJvd3NpbmcgbW9kZVxuXHRcdC8vIFB1c2ggdW5kbyBzbmFwc2hvdCBpZiBjb250ZW50IGRpZmZlcnMgKG1ha2VzIHByb2dyYW1tYXRpYyBjaGFuZ2VzIHVuZG9hYmxlKVxuXHRcdGlmICh0aGlzLmdldFRleHQoKSAhPT0gdGV4dCkge1xuXHRcdFx0dGhpcy5wdXNoVW5kb1NuYXBzaG90KCk7XG5cdFx0fVxuXHRcdHRoaXMuc2V0VGV4dEludGVybmFsKHRleHQpO1xuXHR9XG5cblx0LyoqXG5cdCAqIEluc2VydCB0ZXh0IGF0IHRoZSBjdXJyZW50IGN1cnNvciBwb3NpdGlvbi5cblx0ICogVXNlZCBmb3IgcHJvZ3JhbW1hdGljIGluc2VydGlvbiAoZS5nLiwgY2xpcGJvYXJkIGltYWdlIG1hcmtlcnMpLlxuXHQgKiBUaGlzIGlzIGF0b21pYyBmb3IgdW5kbyAtIHNpbmdsZSB1bmRvIHJlc3RvcmVzIGVudGlyZSBwcmUtaW5zZXJ0IHN0YXRlLlxuXHQgKi9cblx0aW5zZXJ0VGV4dEF0Q3Vyc29yKHRleHQ6IHN0cmluZyk6IHZvaWQge1xuXHRcdGlmICghdGV4dCkgcmV0dXJuO1xuXHRcdHRoaXMucHVzaFVuZG9TbmFwc2hvdCgpO1xuXHRcdHRoaXMubGFzdEFjdGlvbiA9IG51bGw7XG5cdFx0dGhpcy5oaXN0b3J5SW5kZXggPSAtMTtcblx0XHR0aGlzLmluc2VydFRleHRBdEN1cnNvckludGVybmFsKHRleHQpO1xuXHR9XG5cblx0LyoqXG5cdCAqIEludGVybmFsIHRleHQgaW5zZXJ0aW9uIGF0IGN1cnNvci4gSGFuZGxlcyBzaW5nbGUgYW5kIG11bHRpLWxpbmUgdGV4dC5cblx0ICogRG9lcyBub3QgcHVzaCB1bmRvIHNuYXBzaG90cyBvciB0cmlnZ2VyIGF1dG9jb21wbGV0ZSAtIGNhbGxlciBpcyByZXNwb25zaWJsZS5cblx0ICogTm9ybWFsaXplcyBsaW5lIGVuZGluZ3MgYW5kIGNhbGxzIG9uQ2hhbmdlIG9uY2UgYXQgdGhlIGVuZC5cblx0ICovXG5cdHByaXZhdGUgaW5zZXJ0VGV4dEF0Q3Vyc29ySW50ZXJuYWwodGV4dDogc3RyaW5nKTogdm9pZCB7XG5cdFx0aWYgKCF0ZXh0KSByZXR1cm47XG5cblx0XHQvLyBOb3JtYWxpemUgbGluZSBlbmRpbmdzXG5cdFx0Y29uc3Qgbm9ybWFsaXplZCA9IHRleHQucmVwbGFjZSgvXFxyXFxuL2csIFwiXFxuXCIpLnJlcGxhY2UoL1xcci9nLCBcIlxcblwiKTtcblx0XHRjb25zdCBpbnNlcnRlZExpbmVzID0gbm9ybWFsaXplZC5zcGxpdChcIlxcblwiKTtcblxuXHRcdGNvbnN0IGN1cnJlbnRMaW5lID0gdGhpcy5zdGF0ZS5saW5lc1t0aGlzLnN0YXRlLmN1cnNvckxpbmVdIHx8IFwiXCI7XG5cdFx0Y29uc3QgYmVmb3JlQ3Vyc29yID0gY3VycmVudExpbmUuc2xpY2UoMCwgdGhpcy5zdGF0ZS5jdXJzb3JDb2wpO1xuXHRcdGNvbnN0IGFmdGVyQ3Vyc29yID0gY3VycmVudExpbmUuc2xpY2UodGhpcy5zdGF0ZS5jdXJzb3JDb2wpO1xuXG5cdFx0aWYgKGluc2VydGVkTGluZXMubGVuZ3RoID09PSAxKSB7XG5cdFx0XHQvLyBTaW5nbGUgbGluZSAtIGluc2VydCBhdCBjdXJzb3IgcG9zaXRpb25cblx0XHRcdHRoaXMuc3RhdGUubGluZXNbdGhpcy5zdGF0ZS5jdXJzb3JMaW5lXSA9IGJlZm9yZUN1cnNvciArIG5vcm1hbGl6ZWQgKyBhZnRlckN1cnNvcjtcblx0XHRcdHRoaXMuc2V0Q3Vyc29yQ29sKHRoaXMuc3RhdGUuY3Vyc29yQ29sICsgbm9ybWFsaXplZC5sZW5ndGgpO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHQvLyBNdWx0aS1saW5lIGluc2VydGlvblxuXHRcdFx0dGhpcy5zdGF0ZS5saW5lcyA9IFtcblx0XHRcdFx0Ly8gQWxsIGxpbmVzIGJlZm9yZSBjdXJyZW50IGxpbmVcblx0XHRcdFx0Li4udGhpcy5zdGF0ZS5saW5lcy5zbGljZSgwLCB0aGlzLnN0YXRlLmN1cnNvckxpbmUpLFxuXG5cdFx0XHRcdC8vIFRoZSBmaXJzdCBpbnNlcnRlZCBsaW5lIG1lcmdlZCB3aXRoIHRleHQgYmVmb3JlIGN1cnNvclxuXHRcdFx0XHRiZWZvcmVDdXJzb3IgKyBpbnNlcnRlZExpbmVzWzBdLFxuXG5cdFx0XHRcdC8vIEFsbCBtaWRkbGUgaW5zZXJ0ZWQgbGluZXNcblx0XHRcdFx0Li4uaW5zZXJ0ZWRMaW5lcy5zbGljZSgxLCAtMSksXG5cblx0XHRcdFx0Ly8gVGhlIGxhc3QgaW5zZXJ0ZWQgbGluZSB3aXRoIHRleHQgYWZ0ZXIgY3Vyc29yXG5cdFx0XHRcdGluc2VydGVkTGluZXNbaW5zZXJ0ZWRMaW5lcy5sZW5ndGggLSAxXSArIGFmdGVyQ3Vyc29yLFxuXG5cdFx0XHRcdC8vIEFsbCBsaW5lcyBhZnRlciBjdXJyZW50IGxpbmVcblx0XHRcdFx0Li4udGhpcy5zdGF0ZS5saW5lcy5zbGljZSh0aGlzLnN0YXRlLmN1cnNvckxpbmUgKyAxKSxcblx0XHRcdF07XG5cblx0XHRcdHRoaXMuc3RhdGUuY3Vyc29yTGluZSArPSBpbnNlcnRlZExpbmVzLmxlbmd0aCAtIDE7XG5cdFx0XHR0aGlzLnNldEN1cnNvckNvbCgoaW5zZXJ0ZWRMaW5lc1tpbnNlcnRlZExpbmVzLmxlbmd0aCAtIDFdIHx8IFwiXCIpLmxlbmd0aCk7XG5cdFx0fVxuXG5cdFx0dGhpcy5lbWl0Q2hhbmdlKCk7XG5cdH1cblxuXHQvLyBBbGwgdGhlIGVkaXRvciBtZXRob2RzIGZyb20gYmVmb3JlLi4uXG5cdHByaXZhdGUgaW5zZXJ0Q2hhcmFjdGVyKGNoYXI6IHN0cmluZywgc2tpcFVuZG9Db2FsZXNjaW5nPzogYm9vbGVhbik6IHZvaWQge1xuXHRcdHRoaXMuaGlzdG9yeUluZGV4ID0gLTE7IC8vIEV4aXQgaGlzdG9yeSBicm93c2luZyBtb2RlXG5cblx0XHQvLyBVbmRvIGNvYWxlc2NpbmcgKGZpc2gtc3R5bGUpOlxuXHRcdC8vIC0gQ29uc2VjdXRpdmUgd29yZCBjaGFycyBjb2FsZXNjZSBpbnRvIG9uZSB1bmRvIHVuaXRcblx0XHQvLyAtIFNwYWNlIGNhcHR1cmVzIHN0YXRlIGJlZm9yZSBpdHNlbGYgKHNvIHVuZG8gcmVtb3ZlcyBzcGFjZStmb2xsb3dpbmcgd29yZCB0b2dldGhlcilcblx0XHQvLyAtIEVhY2ggc3BhY2UgaXMgc2VwYXJhdGVseSB1bmRvYWJsZVxuXHRcdC8vIFNraXAgY29hbGVzY2luZyB3aGVuIGNhbGxlZCBmcm9tIGF0b21pYyBvcGVyYXRpb25zIChlLmcuLCBoYW5kbGVQYXN0ZSlcblx0XHRpZiAoIXNraXBVbmRvQ29hbGVzY2luZykge1xuXHRcdFx0aWYgKGlzV2hpdGVzcGFjZUNoYXIoY2hhcikgfHwgdGhpcy5sYXN0QWN0aW9uICE9PSBcInR5cGUtd29yZFwiKSB7XG5cdFx0XHRcdHRoaXMucHVzaFVuZG9TbmFwc2hvdCgpO1xuXHRcdFx0fVxuXHRcdFx0dGhpcy5sYXN0QWN0aW9uID0gXCJ0eXBlLXdvcmRcIjtcblx0XHR9XG5cblx0XHRjb25zdCBsaW5lID0gdGhpcy5zdGF0ZS5saW5lc1t0aGlzLnN0YXRlLmN1cnNvckxpbmVdIHx8IFwiXCI7XG5cblx0XHRjb25zdCBiZWZvcmUgPSBsaW5lLnNsaWNlKDAsIHRoaXMuc3RhdGUuY3Vyc29yQ29sKTtcblx0XHRjb25zdCBhZnRlciA9IGxpbmUuc2xpY2UodGhpcy5zdGF0ZS5jdXJzb3JDb2wpO1xuXG5cdFx0dGhpcy5zdGF0ZS5saW5lc1t0aGlzLnN0YXRlLmN1cnNvckxpbmVdID0gYmVmb3JlICsgY2hhciArIGFmdGVyO1xuXHRcdHRoaXMuc2V0Q3Vyc29yQ29sKHRoaXMuc3RhdGUuY3Vyc29yQ29sICsgY2hhci5sZW5ndGgpO1xuXG5cdFx0dGhpcy5lbWl0Q2hhbmdlKCk7XG5cblx0XHQvLyBDaGVjayBpZiB3ZSBzaG91bGQgdHJpZ2dlciBvciB1cGRhdGUgYXV0b2NvbXBsZXRlXG5cdFx0aWYgKCF0aGlzLmF1dG9jb21wbGV0ZVN0YXRlKSB7XG5cdFx0XHQvLyBBdXRvLXRyaWdnZXIgZm9yIFwiL1wiIGF0IHRoZSBzdGFydCBvZiBhIGxpbmUgKHNsYXNoIGNvbW1hbmRzKVxuXHRcdFx0aWYgKGNoYXIgPT09IFwiL1wiICYmIHRoaXMuaXNBdFN0YXJ0T2ZNZXNzYWdlKCkpIHtcblx0XHRcdFx0dGhpcy50cnlUcmlnZ2VyQXV0b2NvbXBsZXRlKCk7XG5cdFx0XHR9XG5cdFx0XHQvLyBBdXRvLXRyaWdnZXIgZm9yIFwiQFwiIGZpbGUgcmVmZXJlbmNlIChmdXp6eSBzZWFyY2gpXG5cdFx0XHQvLyBEZWJvdW5jZWQ6IHRoZSBiYXJlIFwiQFwiIHRyaWdnZXJzIGEgZnV6enlGaW5kIGNhbGwgdGhhdCBkb2VzIGFcblx0XHRcdC8vIHN5bmNocm9ub3VzIGZpbGVzeXN0ZW0gd2FsayB2aWEgdGhlIG5hdGl2ZSBhZGRvbi4gRmlyaW5nIGl0XG5cdFx0XHQvLyBpbW1lZGlhdGVseSBvbiB0aGUga2V5c3Ryb2tlIGJsb2NrcyB0aGUgZXZlbnQgbG9vcCBhbmQgZnJlZXplc1xuXHRcdFx0Ly8gdGhlIFRVSSBvbiBsYXJnZSByZXBvcy4gRGVib3VuY2luZyBsZXRzIHN1YnNlcXVlbnQga2V5c3Ryb2tlc1xuXHRcdFx0Ly8gY2FuY2VsIHRoZSBwZW5kaW5nIHNlYXJjaCBzbyB0aGUgd2FsayBvbmx5IHJ1bnMgb25jZSB0aGUgdXNlclxuXHRcdFx0Ly8gcGF1c2VzIHR5cGluZy5cblx0XHRcdGVsc2UgaWYgKGNoYXIgPT09IFwiQFwiKSB7XG5cdFx0XHRcdGNvbnN0IGN1cnJlbnRMaW5lID0gdGhpcy5zdGF0ZS5saW5lc1t0aGlzLnN0YXRlLmN1cnNvckxpbmVdIHx8IFwiXCI7XG5cdFx0XHRcdGNvbnN0IHRleHRCZWZvcmVDdXJzb3IgPSBjdXJyZW50TGluZS5zbGljZSgwLCB0aGlzLnN0YXRlLmN1cnNvckNvbCk7XG5cdFx0XHRcdC8vIE9ubHkgdHJpZ2dlciBpZiBAIGlzIGFmdGVyIHdoaXRlc3BhY2Ugb3IgYXQgc3RhcnQgb2YgbGluZVxuXHRcdFx0XHRjb25zdCBjaGFyQmVmb3JlQXQgPSB0ZXh0QmVmb3JlQ3Vyc29yW3RleHRCZWZvcmVDdXJzb3IubGVuZ3RoIC0gMl07XG5cdFx0XHRcdGlmICh0ZXh0QmVmb3JlQ3Vyc29yLmxlbmd0aCA9PT0gMSB8fCBjaGFyQmVmb3JlQXQgPT09IFwiIFwiIHx8IGNoYXJCZWZvcmVBdCA9PT0gXCJcXHRcIikge1xuXHRcdFx0XHRcdHRoaXMuZGVib3VuY2VkVHJpZ2dlckF1dG9jb21wbGV0ZSgpO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0XHQvLyBBbHNvIGF1dG8tdHJpZ2dlciB3aGVuIHR5cGluZyBsZXR0ZXJzIGluIGEgc2xhc2ggY29tbWFuZCBjb250ZXh0XG5cdFx0XHRlbHNlIGlmICgvW2EtekEtWjAtOS5cXC1fXS8udGVzdChjaGFyKSkge1xuXHRcdFx0XHRjb25zdCBjdXJyZW50TGluZSA9IHRoaXMuc3RhdGUubGluZXNbdGhpcy5zdGF0ZS5jdXJzb3JMaW5lXSB8fCBcIlwiO1xuXHRcdFx0XHRjb25zdCB0ZXh0QmVmb3JlQ3Vyc29yID0gY3VycmVudExpbmUuc2xpY2UoMCwgdGhpcy5zdGF0ZS5jdXJzb3JDb2wpO1xuXHRcdFx0XHQvLyBDaGVjayBpZiB3ZSdyZSBpbiBhIHNsYXNoIGNvbW1hbmQgKHdpdGggb3Igd2l0aG91dCBzcGFjZSBmb3IgYXJndW1lbnRzKVxuXHRcdFx0XHRpZiAodGhpcy5pc0luU2xhc2hDb21tYW5kQ29udGV4dCh0ZXh0QmVmb3JlQ3Vyc29yKSkge1xuXHRcdFx0XHRcdHRoaXMudHJ5VHJpZ2dlckF1dG9jb21wbGV0ZSgpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdC8vIENoZWNrIGlmIHdlJ3JlIGluIGFuIEAgZmlsZSByZWZlcmVuY2UgY29udGV4dCAoZGVib3VuY2UgdG8gYXZvaWRcblx0XHRcdFx0Ly8gYmxvY2tpbmcgdGhlIGV2ZW50IGxvb3Agd2l0aCBzeW5jaHJvbm91cyBmdXp6eUZpbmQgb24gZXZlcnkga2V5c3Ryb2tlKVxuXHRcdFx0XHRlbHNlIGlmICh0ZXh0QmVmb3JlQ3Vyc29yLm1hdGNoKC8oPzpefFtcXHNdKUBbXlxcc10qJC8pKSB7XG5cdFx0XHRcdFx0dGhpcy5kZWJvdW5jZWRUcmlnZ2VyQXV0b2NvbXBsZXRlKCk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9IGVsc2Uge1xuXHRcdFx0dGhpcy51cGRhdGVBdXRvY29tcGxldGUoKTtcblx0XHR9XG5cdH1cblxuXHQvKipcblx0ICogRGVib3VuY2VkIHZlcnNpb24gb2YgdHJ5VHJpZ2dlckF1dG9jb21wbGV0ZSBmb3IgQCBmaWxlIHJlZmVyZW5jZSBjb250ZXh0LlxuXHQgKiBQcmV2ZW50cyBzeW5jaHJvbm91cyBmdXp6eUZpbmQgY2FsbHMgZnJvbSBibG9ja2luZyB0aGUgZXZlbnQgbG9vcCBvbiBldmVyeSBrZXlzdHJva2UuXG5cdCAqL1xuXHRwcml2YXRlIGRlYm91bmNlZFRyaWdnZXJBdXRvY29tcGxldGUoKTogdm9pZCB7XG5cdFx0aWYgKHRoaXMuYXV0b2NvbXBsZXRlRGVib3VuY2VUaW1lcikge1xuXHRcdFx0Y2xlYXJUaW1lb3V0KHRoaXMuYXV0b2NvbXBsZXRlRGVib3VuY2VUaW1lcik7XG5cdFx0XHR0aGlzLmF1dG9jb21wbGV0ZURlYm91bmNlVGltZXIgPSBudWxsO1xuXHRcdH1cblxuXHRcdHRoaXMuYXV0b2NvbXBsZXRlRGVib3VuY2VUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuXHRcdFx0dGhpcy5hdXRvY29tcGxldGVEZWJvdW5jZVRpbWVyID0gbnVsbDtcblx0XHRcdHRoaXMudHJ5VHJpZ2dlckF1dG9jb21wbGV0ZSgpO1xuXHRcdFx0dGhpcy50dWkucmVxdWVzdFJlbmRlcigpO1xuXHRcdH0sIEVkaXRvci5BVVRPQ09NUExFVEVfREVCT1VOQ0VfTVMpO1xuXHR9XG5cblx0LyoqXG5cdCAqIEltYWdlIGZpbGUgZXh0ZW5zaW9ucyByZWNvZ25pemVkIHdoZW4gcGFzdGVkIGFzIGEgZmlsZSBwYXRoLlxuXHQgKlxuXHQgKiBSZXN0cmljdGVkIHRvIGZvcm1hdHMgY29tbW9ubHkgYWNjZXB0ZWQgYnkgQUkgdmlzaW9uIEFQSXMgYW5kIHRoYXQgaGF2ZVxuXHQgKiByZWxpYWJsZSBtYWdpYy1ieXRlIHNpZ25hdHVyZXMgZm9yIGNvbnRlbnQgdmVyaWZpY2F0aW9uLiBTVkcgaXMgZXhjbHVkZWRcblx0ICogKFhNTC9KUy1iZWFyaW5nKTsgQk1QL1RJRkYvSEVJQy9IRUlGL0FWSUYgZXhjbHVkZWQgZm9yIGNvbXBhdGliaWxpdHkgYW5kXG5cdCAqIHZlcmlmaWNhdGlvbiBzaW1wbGljaXR5IFx1MjAxNCB1c2VycyBjYW4gY29udmVydCBiZWZvcmUgcGFzdGluZy5cblx0ICpcblx0ICogRGV0ZWN0aW9uIGFzc3VtZXMgdGVybWluYWwgZW11bGF0b3JzIChpVGVybTIsIFdhcnAsIGV0Yy4pIHBhc3RlIGEgc2luZ2xlXG5cdCAqIGFic29sdXRlIGZpbGUgcGF0aCBvbiBkcmFnLWRyb3AuIE11bHRpLWxpbmUgcGFzdGVzIGFuZCBiYXJlIGV4dGVuc2lvbnNcblx0ICogYXJlIGludGVudGlvbmFsbHkgbm90IG1hdGNoZWQuXG5cdCAqL1xuXHRwcml2YXRlIHN0YXRpYyByZWFkb25seSBJTUFHRV9FWFRFTlNJT05TID0gL1xcLihwbmd8anBlP2d8Z2lmfHdlYnApJC9pO1xuXG5cdHByaXZhdGUgaGFuZGxlUGFzdGUocGFzdGVkVGV4dDogc3RyaW5nKTogdm9pZCB7XG5cdFx0dGhpcy5oaXN0b3J5SW5kZXggPSAtMTsgLy8gRXhpdCBoaXN0b3J5IGJyb3dzaW5nIG1vZGVcblx0XHR0aGlzLmxhc3RBY3Rpb24gPSBudWxsO1xuXG5cdFx0Ly8gRGV0ZWN0IHBhc3RlZCBpbWFnZSBmaWxlIHBhdGhzIChmcm9tIHRlcm1pbmFsIGVtdWxhdG9ycyBsaWtlIGlUZXJtMilcblx0XHRjb25zdCB0cmltbWVkID0gcGFzdGVkVGV4dC50cmltKCk7XG5cdFx0aWYgKHRoaXMub25QYXN0ZUltYWdlUGF0aCAmJiAhdHJpbW1lZC5pbmNsdWRlcyhcIlxcblwiKSAmJiBFZGl0b3IuSU1BR0VfRVhURU5TSU9OUy50ZXN0KHRyaW1tZWQpKSB7XG5cdFx0XHR0aGlzLm9uUGFzdGVJbWFnZVBhdGgodHJpbW1lZCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0dGhpcy5wdXNoVW5kb1NuYXBzaG90KCk7XG5cblx0XHQvLyBDbGVhbiB0aGUgcGFzdGVkIHRleHRcblx0XHRjb25zdCBjbGVhblRleHQgPSBwYXN0ZWRUZXh0LnJlcGxhY2UoL1xcclxcbi9nLCBcIlxcblwiKS5yZXBsYWNlKC9cXHIvZywgXCJcXG5cIik7XG5cblx0XHQvLyBDb252ZXJ0IHRhYnMgdG8gc3BhY2VzICg0IHNwYWNlcyBwZXIgdGFiKVxuXHRcdGNvbnN0IHRhYkV4cGFuZGVkVGV4dCA9IGNsZWFuVGV4dC5yZXBsYWNlKC9cXHQvZywgXCIgICAgXCIpO1xuXG5cdFx0Ly8gRmlsdGVyIG91dCBub24tcHJpbnRhYmxlIGNoYXJhY3RlcnMgZXhjZXB0IG5ld2xpbmVzXG5cdFx0bGV0IGZpbHRlcmVkVGV4dCA9IHRhYkV4cGFuZGVkVGV4dFxuXHRcdFx0LnNwbGl0KFwiXCIpXG5cdFx0XHQuZmlsdGVyKChjaGFyKSA9PiBjaGFyID09PSBcIlxcblwiIHx8IGNoYXIuY2hhckNvZGVBdCgwKSA+PSAzMilcblx0XHRcdC5qb2luKFwiXCIpO1xuXG5cdFx0Ly8gSWYgcGFzdGluZyBhIGZpbGUgcGF0aCAoc3RhcnRzIHdpdGggLywgfiwgb3IgLikgYW5kIHRoZSBjaGFyYWN0ZXIgYmVmb3JlXG5cdFx0Ly8gdGhlIGN1cnNvciBpcyBhIHdvcmQgY2hhcmFjdGVyLCBwcmVwZW5kIGEgc3BhY2UgZm9yIGJldHRlciByZWFkYWJpbGl0eVxuXHRcdGlmICgvXlsvfi5dLy50ZXN0KGZpbHRlcmVkVGV4dCkpIHtcblx0XHRcdGNvbnN0IGN1cnJlbnRMaW5lID0gdGhpcy5zdGF0ZS5saW5lc1t0aGlzLnN0YXRlLmN1cnNvckxpbmVdIHx8IFwiXCI7XG5cdFx0XHRjb25zdCBjaGFyQmVmb3JlQ3Vyc29yID0gdGhpcy5zdGF0ZS5jdXJzb3JDb2wgPiAwID8gY3VycmVudExpbmVbdGhpcy5zdGF0ZS5jdXJzb3JDb2wgLSAxXSA6IFwiXCI7XG5cdFx0XHRpZiAoY2hhckJlZm9yZUN1cnNvciAmJiAvXFx3Ly50ZXN0KGNoYXJCZWZvcmVDdXJzb3IpKSB7XG5cdFx0XHRcdGZpbHRlcmVkVGV4dCA9IGAgJHtmaWx0ZXJlZFRleHR9YDtcblx0XHRcdH1cblx0XHR9XG5cblx0XHQvLyBTcGxpdCBpbnRvIGxpbmVzIHRvIGNoZWNrIGZvciBsYXJnZSBwYXN0ZVxuXHRcdGNvbnN0IHBhc3RlZExpbmVzID0gZmlsdGVyZWRUZXh0LnNwbGl0KFwiXFxuXCIpO1xuXG5cdFx0Ly8gQ2hlY2sgaWYgdGhpcyBpcyBhIGxhcmdlIHBhc3RlICg+IDEwIGxpbmVzIG9yID4gMTAwMCBjaGFyYWN0ZXJzKVxuXHRcdGNvbnN0IHRvdGFsQ2hhcnMgPSBmaWx0ZXJlZFRleHQubGVuZ3RoO1xuXHRcdGlmIChwYXN0ZWRMaW5lcy5sZW5ndGggPiAxMCB8fCB0b3RhbENoYXJzID4gMTAwMCkge1xuXHRcdFx0Ly8gU3RvcmUgdGhlIHBhc3RlIGFuZCBpbnNlcnQgYSBtYXJrZXJcblx0XHRcdHRoaXMucGFzdGVDb3VudGVyKys7XG5cdFx0XHRjb25zdCBwYXN0ZUlkID0gdGhpcy5wYXN0ZUNvdW50ZXI7XG5cdFx0XHR0aGlzLnBhc3Rlcy5zZXQocGFzdGVJZCwgZmlsdGVyZWRUZXh0KTtcblxuXHRcdFx0Ly8gSW5zZXJ0IG1hcmtlciBsaWtlIFwiW3Bhc3RlICMxICsxMjMgbGluZXNdXCIgb3IgXCJbcGFzdGUgIzEgMTIzNCBjaGFyc11cIlxuXHRcdFx0Y29uc3QgbWFya2VyID1cblx0XHRcdFx0cGFzdGVkTGluZXMubGVuZ3RoID4gMTBcblx0XHRcdFx0XHQ/IGBbcGFzdGUgIyR7cGFzdGVJZH0gKyR7cGFzdGVkTGluZXMubGVuZ3RofSBsaW5lc11gXG5cdFx0XHRcdFx0OiBgW3Bhc3RlICMke3Bhc3RlSWR9ICR7dG90YWxDaGFyc30gY2hhcnNdYDtcblx0XHRcdHRoaXMuaW5zZXJ0VGV4dEF0Q3Vyc29ySW50ZXJuYWwobWFya2VyKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRpZiAocGFzdGVkTGluZXMubGVuZ3RoID09PSAxKSB7XG5cdFx0XHQvLyBTaW5nbGUgbGluZSAtIGluc2VydCBhdG9taWNhbGx5IChkbyBub3QgdHJpZ2dlciBhdXRvY29tcGxldGUgZHVyaW5nIHBhc3RlKVxuXHRcdFx0dGhpcy5pbnNlcnRUZXh0QXRDdXJzb3JJbnRlcm5hbChmaWx0ZXJlZFRleHQpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdC8vIE11bHRpLWxpbmUgcGFzdGUgLSB1c2UgZGlyZWN0IHN0YXRlIG1hbmlwdWxhdGlvblxuXHRcdHRoaXMuaW5zZXJ0VGV4dEF0Q3Vyc29ySW50ZXJuYWwoZmlsdGVyZWRUZXh0KTtcblx0fVxuXG5cdHByaXZhdGUgYWRkTmV3TGluZSgpOiB2b2lkIHtcblx0XHR0aGlzLmhpc3RvcnlJbmRleCA9IC0xOyAvLyBFeGl0IGhpc3RvcnkgYnJvd3NpbmcgbW9kZVxuXHRcdHRoaXMubGFzdEFjdGlvbiA9IG51bGw7XG5cblx0XHR0aGlzLnB1c2hVbmRvU25hcHNob3QoKTtcblxuXHRcdGNvbnN0IGN1cnJlbnRMaW5lID0gdGhpcy5zdGF0ZS5saW5lc1t0aGlzLnN0YXRlLmN1cnNvckxpbmVdIHx8IFwiXCI7XG5cblx0XHRjb25zdCBiZWZvcmUgPSBjdXJyZW50TGluZS5zbGljZSgwLCB0aGlzLnN0YXRlLmN1cnNvckNvbCk7XG5cdFx0Y29uc3QgYWZ0ZXIgPSBjdXJyZW50TGluZS5zbGljZSh0aGlzLnN0YXRlLmN1cnNvckNvbCk7XG5cblx0XHQvLyBTcGxpdCBjdXJyZW50IGxpbmVcblx0XHR0aGlzLnN0YXRlLmxpbmVzW3RoaXMuc3RhdGUuY3Vyc29yTGluZV0gPSBiZWZvcmU7XG5cdFx0dGhpcy5zdGF0ZS5saW5lcy5zcGxpY2UodGhpcy5zdGF0ZS5jdXJzb3JMaW5lICsgMSwgMCwgYWZ0ZXIpO1xuXG5cdFx0Ly8gTW92ZSBjdXJzb3IgdG8gc3RhcnQgb2YgbmV3IGxpbmVcblx0XHR0aGlzLnN0YXRlLmN1cnNvckxpbmUrKztcblx0XHR0aGlzLnNldEN1cnNvckNvbCgwKTtcblxuXHRcdHRoaXMuZW1pdENoYW5nZSgpO1xuXHR9XG5cblx0cHJpdmF0ZSBzaG91bGRTdWJtaXRPbkJhY2tzbGFzaEVudGVyKGRhdGE6IHN0cmluZywga2I6IFJldHVyblR5cGU8dHlwZW9mIGdldEVkaXRvcktleWJpbmRpbmdzPik6IGJvb2xlYW4ge1xuXHRcdGlmICh0aGlzLmRpc2FibGVTdWJtaXQpIHJldHVybiBmYWxzZTtcblx0XHRpZiAoIW1hdGNoZXNLZXkoZGF0YSwgXCJlbnRlclwiKSkgcmV0dXJuIGZhbHNlO1xuXHRcdGNvbnN0IHN1Ym1pdEtleXMgPSBrYi5nZXRLZXlzKFwic3VibWl0XCIpO1xuXHRcdGNvbnN0IGhhc1NoaWZ0RW50ZXIgPSBzdWJtaXRLZXlzLmluY2x1ZGVzKFwic2hpZnQrZW50ZXJcIikgfHwgc3VibWl0S2V5cy5pbmNsdWRlcyhcInNoaWZ0K3JldHVyblwiKTtcblx0XHRpZiAoIWhhc1NoaWZ0RW50ZXIpIHJldHVybiBmYWxzZTtcblxuXHRcdGNvbnN0IGN1cnJlbnRMaW5lID0gdGhpcy5zdGF0ZS5saW5lc1t0aGlzLnN0YXRlLmN1cnNvckxpbmVdIHx8IFwiXCI7XG5cdFx0cmV0dXJuIHRoaXMuc3RhdGUuY3Vyc29yQ29sID4gMCAmJiBjdXJyZW50TGluZVt0aGlzLnN0YXRlLmN1cnNvckNvbCAtIDFdID09PSBcIlxcXFxcIjtcblx0fVxuXG5cdHByaXZhdGUgc3VibWl0VmFsdWUoKTogdm9pZCB7XG5cdFx0bGV0IHJlc3VsdCA9IHRoaXMuc3RhdGUubGluZXMuam9pbihcIlxcblwiKS50cmltKCk7XG5cdFx0Zm9yIChjb25zdCBbcGFzdGVJZCwgcGFzdGVDb250ZW50XSBvZiB0aGlzLnBhc3Rlcykge1xuXHRcdFx0Y29uc3QgbWFya2VyUmVnZXggPSBuZXcgUmVnRXhwKGBcXFxcW3Bhc3RlICMke3Bhc3RlSWR9KCAoXFxcXCtcXFxcZCsgbGluZXN8XFxcXGQrIGNoYXJzKSk/XFxcXF1gLCBcImdcIik7XG5cdFx0XHRyZXN1bHQgPSByZXN1bHQucmVwbGFjZShtYXJrZXJSZWdleCwgcGFzdGVDb250ZW50KTtcblx0XHR9XG5cblx0XHR0aGlzLnN0YXRlID0geyBsaW5lczogW1wiXCJdLCBjdXJzb3JMaW5lOiAwLCBjdXJzb3JDb2w6IDAgfTtcblx0XHR0aGlzLnBhc3Rlcy5jbGVhcigpO1xuXHRcdHRoaXMucGFzdGVDb3VudGVyID0gMDtcblx0XHR0aGlzLmhpc3RvcnlJbmRleCA9IC0xO1xuXHRcdHRoaXMuc2Nyb2xsT2Zmc2V0ID0gMDtcblx0XHR0aGlzLnVuZG9TdGFjay5jbGVhcigpO1xuXHRcdHRoaXMubGFzdEFjdGlvbiA9IG51bGw7XG5cblx0XHR0aGlzLmVtaXRDaGFuZ2UoKTtcblx0XHRpZiAodGhpcy5vblN1Ym1pdCkgdGhpcy5vblN1Ym1pdChyZXN1bHQpO1xuXHR9XG5cblx0cHJpdmF0ZSBoYW5kbGVCYWNrc3BhY2UoKTogdm9pZCB7XG5cdFx0dGhpcy5oaXN0b3J5SW5kZXggPSAtMTsgLy8gRXhpdCBoaXN0b3J5IGJyb3dzaW5nIG1vZGVcblx0XHR0aGlzLmxhc3RBY3Rpb24gPSBudWxsO1xuXG5cdFx0aWYgKHRoaXMuc3RhdGUuY3Vyc29yQ29sID4gMCkge1xuXHRcdFx0dGhpcy5wdXNoVW5kb1NuYXBzaG90KCk7XG5cblx0XHRcdC8vIERlbGV0ZSBncmFwaGVtZSBiZWZvcmUgY3Vyc29yIChoYW5kbGVzIGVtb2ppcywgY29tYmluaW5nIGNoYXJhY3RlcnMsIGV0Yy4pXG5cdFx0XHRjb25zdCBsaW5lID0gdGhpcy5zdGF0ZS5saW5lc1t0aGlzLnN0YXRlLmN1cnNvckxpbmVdIHx8IFwiXCI7XG5cdFx0XHRjb25zdCBiZWZvcmVDdXJzb3IgPSBsaW5lLnNsaWNlKDAsIHRoaXMuc3RhdGUuY3Vyc29yQ29sKTtcblxuXHRcdFx0Ly8gRmluZCB0aGUgbGFzdCBncmFwaGVtZSBpbiB0aGUgdGV4dCBiZWZvcmUgY3Vyc29yXG5cdFx0XHRjb25zdCBncmFwaGVtZXMgPSBbLi4uc2VnbWVudGVyLnNlZ21lbnQoYmVmb3JlQ3Vyc29yKV07XG5cdFx0XHRjb25zdCBsYXN0R3JhcGhlbWUgPSBncmFwaGVtZXNbZ3JhcGhlbWVzLmxlbmd0aCAtIDFdO1xuXHRcdFx0Y29uc3QgZ3JhcGhlbWVMZW5ndGggPSBsYXN0R3JhcGhlbWUgPyBsYXN0R3JhcGhlbWUuc2VnbWVudC5sZW5ndGggOiAxO1xuXG5cdFx0XHRjb25zdCBiZWZvcmUgPSBsaW5lLnNsaWNlKDAsIHRoaXMuc3RhdGUuY3Vyc29yQ29sIC0gZ3JhcGhlbWVMZW5ndGgpO1xuXHRcdFx0Y29uc3QgYWZ0ZXIgPSBsaW5lLnNsaWNlKHRoaXMuc3RhdGUuY3Vyc29yQ29sKTtcblxuXHRcdFx0dGhpcy5zdGF0ZS5saW5lc1t0aGlzLnN0YXRlLmN1cnNvckxpbmVdID0gYmVmb3JlICsgYWZ0ZXI7XG5cdFx0XHR0aGlzLnNldEN1cnNvckNvbCh0aGlzLnN0YXRlLmN1cnNvckNvbCAtIGdyYXBoZW1lTGVuZ3RoKTtcblx0XHR9IGVsc2UgaWYgKHRoaXMuc3RhdGUuY3Vyc29yTGluZSA+IDApIHtcblx0XHRcdHRoaXMucHVzaFVuZG9TbmFwc2hvdCgpO1xuXG5cdFx0XHQvLyBNZXJnZSB3aXRoIHByZXZpb3VzIGxpbmVcblx0XHRcdGNvbnN0IGN1cnJlbnRMaW5lID0gdGhpcy5zdGF0ZS5saW5lc1t0aGlzLnN0YXRlLmN1cnNvckxpbmVdIHx8IFwiXCI7XG5cdFx0XHRjb25zdCBwcmV2aW91c0xpbmUgPSB0aGlzLnN0YXRlLmxpbmVzW3RoaXMuc3RhdGUuY3Vyc29yTGluZSAtIDFdIHx8IFwiXCI7XG5cblx0XHRcdHRoaXMuc3RhdGUubGluZXNbdGhpcy5zdGF0ZS5jdXJzb3JMaW5lIC0gMV0gPSBwcmV2aW91c0xpbmUgKyBjdXJyZW50TGluZTtcblx0XHRcdHRoaXMuc3RhdGUubGluZXMuc3BsaWNlKHRoaXMuc3RhdGUuY3Vyc29yTGluZSwgMSk7XG5cblx0XHRcdHRoaXMuc3RhdGUuY3Vyc29yTGluZS0tO1xuXHRcdFx0dGhpcy5zZXRDdXJzb3JDb2wocHJldmlvdXNMaW5lLmxlbmd0aCk7XG5cdFx0fVxuXG5cdFx0dGhpcy5lbWl0Q2hhbmdlKCk7XG5cblx0XHQvLyBVcGRhdGUgb3IgcmUtdHJpZ2dlciBhdXRvY29tcGxldGUgYWZ0ZXIgYmFja3NwYWNlXG5cdFx0aWYgKHRoaXMuYXV0b2NvbXBsZXRlU3RhdGUpIHtcblx0XHRcdHRoaXMudXBkYXRlQXV0b2NvbXBsZXRlKCk7XG5cdFx0fSBlbHNlIHtcblx0XHRcdC8vIElmIGF1dG9jb21wbGV0ZSB3YXMgY2FuY2VsbGVkIChubyBtYXRjaGVzKSwgcmUtdHJpZ2dlciBpZiB3ZSdyZSBpbiBhIGNvbXBsZXRhYmxlIGNvbnRleHRcblx0XHRcdGNvbnN0IGN1cnJlbnRMaW5lID0gdGhpcy5zdGF0ZS5saW5lc1t0aGlzLnN0YXRlLmN1cnNvckxpbmVdIHx8IFwiXCI7XG5cdFx0XHRjb25zdCB0ZXh0QmVmb3JlQ3Vyc29yID0gY3VycmVudExpbmUuc2xpY2UoMCwgdGhpcy5zdGF0ZS5jdXJzb3JDb2wpO1xuXHRcdFx0Ly8gU2xhc2ggY29tbWFuZCBjb250ZXh0XG5cdFx0XHRpZiAodGhpcy5pc0luU2xhc2hDb21tYW5kQ29udGV4dCh0ZXh0QmVmb3JlQ3Vyc29yKSkge1xuXHRcdFx0XHR0aGlzLnRyeVRyaWdnZXJBdXRvY29tcGxldGUoKTtcblx0XHRcdH1cblx0XHRcdC8vIEAgZmlsZSByZWZlcmVuY2UgY29udGV4dCAoZGVib3VuY2VkIHRvIGF2b2lkIGJsb2NraW5nIGV2ZW50IGxvb3ApXG5cdFx0XHRlbHNlIGlmICh0ZXh0QmVmb3JlQ3Vyc29yLm1hdGNoKC8oPzpefFtcXHNdKUBbXlxcc10qJC8pKSB7XG5cdFx0XHRcdHRoaXMuZGVib3VuY2VkVHJpZ2dlckF1dG9jb21wbGV0ZSgpO1xuXHRcdFx0fVxuXHRcdH1cblx0fVxuXG5cdC8qKlxuXHQgKiBTZXQgY3Vyc29yIGNvbHVtbiBhbmQgY2xlYXIgcHJlZmVycmVkVmlzdWFsQ29sLlxuXHQgKiBVc2UgdGhpcyBmb3IgYWxsIG5vbi12ZXJ0aWNhbCBjdXJzb3IgbW92ZW1lbnRzIHRvIHJlc2V0IHN0aWNreSBjb2x1bW4gYmVoYXZpb3IuXG5cdCAqL1xuXHRwcml2YXRlIHNldEN1cnNvckNvbChjb2w6IG51bWJlcik6IHZvaWQge1xuXHRcdHRoaXMuc3RhdGUuY3Vyc29yQ29sID0gY29sO1xuXHRcdHRoaXMucHJlZmVycmVkVmlzdWFsQ29sID0gbnVsbDtcblx0fVxuXG5cdC8qKlxuXHQgKiBNb3ZlIGN1cnNvciB0byBhIHRhcmdldCB2aXN1YWwgbGluZSwgYXBwbHlpbmcgc3RpY2t5IGNvbHVtbiBsb2dpYy5cblx0ICogU2hhcmVkIGJ5IG1vdmVDdXJzb3IoKSBhbmQgcGFnZVNjcm9sbCgpLlxuXHQgKi9cblx0cHJpdmF0ZSBtb3ZlVG9WaXN1YWxMaW5lKFxuXHRcdHZpc3VhbExpbmVzOiBBcnJheTx7IGxvZ2ljYWxMaW5lOiBudW1iZXI7IHN0YXJ0Q29sOiBudW1iZXI7IGxlbmd0aDogbnVtYmVyIH0+LFxuXHRcdGN1cnJlbnRWaXN1YWxMaW5lOiBudW1iZXIsXG5cdFx0dGFyZ2V0VmlzdWFsTGluZTogbnVtYmVyLFxuXHQpOiB2b2lkIHtcblx0XHRjb25zdCBjdXJyZW50VkwgPSB2aXN1YWxMaW5lc1tjdXJyZW50VmlzdWFsTGluZV07XG5cdFx0Y29uc3QgdGFyZ2V0VkwgPSB2aXN1YWxMaW5lc1t0YXJnZXRWaXN1YWxMaW5lXTtcblxuXHRcdGlmIChjdXJyZW50VkwgJiYgdGFyZ2V0VkwpIHtcblx0XHRcdGNvbnN0IGN1cnJlbnRWaXN1YWxDb2wgPSB0aGlzLnN0YXRlLmN1cnNvckNvbCAtIGN1cnJlbnRWTC5zdGFydENvbDtcblxuXHRcdFx0Ly8gRm9yIG5vbi1sYXN0IHNlZ21lbnRzLCBjbGFtcCB0byBsZW5ndGgtMSB0byBzdGF5IHdpdGhpbiB0aGUgc2VnbWVudFxuXHRcdFx0Y29uc3QgaXNMYXN0U291cmNlU2VnbWVudCA9XG5cdFx0XHRcdGN1cnJlbnRWaXN1YWxMaW5lID09PSB2aXN1YWxMaW5lcy5sZW5ndGggLSAxIHx8XG5cdFx0XHRcdHZpc3VhbExpbmVzW2N1cnJlbnRWaXN1YWxMaW5lICsgMV0/LmxvZ2ljYWxMaW5lICE9PSBjdXJyZW50VkwubG9naWNhbExpbmU7XG5cdFx0XHRjb25zdCBzb3VyY2VNYXhWaXN1YWxDb2wgPSBpc0xhc3RTb3VyY2VTZWdtZW50ID8gY3VycmVudFZMLmxlbmd0aCA6IE1hdGgubWF4KDAsIGN1cnJlbnRWTC5sZW5ndGggLSAxKTtcblxuXHRcdFx0Y29uc3QgaXNMYXN0VGFyZ2V0U2VnbWVudCA9XG5cdFx0XHRcdHRhcmdldFZpc3VhbExpbmUgPT09IHZpc3VhbExpbmVzLmxlbmd0aCAtIDEgfHxcblx0XHRcdFx0dmlzdWFsTGluZXNbdGFyZ2V0VmlzdWFsTGluZSArIDFdPy5sb2dpY2FsTGluZSAhPT0gdGFyZ2V0VkwubG9naWNhbExpbmU7XG5cdFx0XHRjb25zdCB0YXJnZXRNYXhWaXN1YWxDb2wgPSBpc0xhc3RUYXJnZXRTZWdtZW50ID8gdGFyZ2V0VkwubGVuZ3RoIDogTWF0aC5tYXgoMCwgdGFyZ2V0VkwubGVuZ3RoIC0gMSk7XG5cblx0XHRcdGNvbnN0IG1vdmVUb1Zpc3VhbENvbCA9IHRoaXMuY29tcHV0ZVZlcnRpY2FsTW92ZUNvbHVtbihcblx0XHRcdFx0Y3VycmVudFZpc3VhbENvbCxcblx0XHRcdFx0c291cmNlTWF4VmlzdWFsQ29sLFxuXHRcdFx0XHR0YXJnZXRNYXhWaXN1YWxDb2wsXG5cdFx0XHQpO1xuXG5cdFx0XHQvLyBTZXQgY3Vyc29yIHBvc2l0aW9uXG5cdFx0XHR0aGlzLnN0YXRlLmN1cnNvckxpbmUgPSB0YXJnZXRWTC5sb2dpY2FsTGluZTtcblx0XHRcdGNvbnN0IHRhcmdldENvbCA9IHRhcmdldFZMLnN0YXJ0Q29sICsgbW92ZVRvVmlzdWFsQ29sO1xuXHRcdFx0Y29uc3QgbG9naWNhbExpbmUgPSB0aGlzLnN0YXRlLmxpbmVzW3RhcmdldFZMLmxvZ2ljYWxMaW5lXSB8fCBcIlwiO1xuXHRcdFx0dGhpcy5zdGF0ZS5jdXJzb3JDb2wgPSBNYXRoLm1pbih0YXJnZXRDb2wsIGxvZ2ljYWxMaW5lLmxlbmd0aCk7XG5cdFx0fVxuXHR9XG5cblx0LyoqXG5cdCAqIENvbXB1dGUgdGhlIHRhcmdldCB2aXN1YWwgY29sdW1uIGZvciB2ZXJ0aWNhbCBjdXJzb3IgbW92ZW1lbnQuXG5cdCAqIEltcGxlbWVudHMgdGhlIHN0aWNreSBjb2x1bW4gZGVjaXNpb24gdGFibGU6XG5cdCAqXG5cdCAqIHwgUCB8IFMgfCBUIHwgVSB8IFNjZW5hcmlvICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfCBTZXQgUHJlZmVycmVkIHwgTW92ZSBUbyAgICAgfFxuXHQgKiB8LS0tfC0tLXwtLS18LS0tfCAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIHwtLS0tLS0tLS0tLS0tLS18LS0tLS0tLS0tLS0tLXxcblx0ICogfCAwIHwgKiB8IDAgfCAtIHwgU3RhcnQgbmF2LCB0YXJnZXQgZml0cyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB8IG51bGwgICAgICAgICAgfCBjdXJyZW50ICAgICB8XG5cdCAqIHwgMCB8ICogfCAxIHwgLSB8IFN0YXJ0IG5hdiwgdGFyZ2V0IHNob3J0ZXIgICAgICAgICAgICAgICAgICAgICAgICAgICAgfCBjdXJyZW50ICAgICAgIHwgdGFyZ2V0IGVuZCAgfFxuXHQgKiB8IDEgfCAwIHwgMCB8IDAgfCBDbGFtcGVkLCB0YXJnZXQgZml0cyBwcmVmZXJyZWQgICAgICAgICAgICAgICAgICAgICAgIHwgbnVsbCAgICAgICAgICB8IHByZWZlcnJlZCAgIHxcblx0ICogfCAxIHwgMCB8IDAgfCAxIHwgQ2xhbXBlZCwgdGFyZ2V0IGxvbmdlciBidXQgc3RpbGwgY2FuJ3QgZml0IHByZWZlcnJlZCB8IGtlZXAgICAgICAgICAgfCB0YXJnZXQgZW5kICB8XG5cdCAqIHwgMSB8IDAgfCAxIHwgLSB8IENsYW1wZWQsIHRhcmdldCBldmVuIHNob3J0ZXIgICAgICAgICAgICAgICAgICAgICAgICAgfCBrZWVwICAgICAgICAgIHwgdGFyZ2V0IGVuZCAgfFxuXHQgKiB8IDEgfCAxIHwgMCB8IC0gfCBSZXdyYXBwZWQsIHRhcmdldCBmaXRzIGN1cnJlbnQgICAgICAgICAgICAgICAgICAgICAgIHwgbnVsbCAgICAgICAgICB8IGN1cnJlbnQgICAgIHxcblx0ICogfCAxIHwgMSB8IDEgfCAtIHwgUmV3cmFwcGVkLCB0YXJnZXQgc2hvcnRlciB0aGFuIGN1cnJlbnQgICAgICAgICAgICAgICB8IGN1cnJlbnQgICAgICAgfCB0YXJnZXQgZW5kICB8XG5cdCAqXG5cdCAqIFdoZXJlOlxuXHQgKiAtIFAgPSBwcmVmZXJyZWQgY29sIGlzIHNldFxuXHQgKiAtIFMgPSBjdXJzb3IgaW4gbWlkZGxlIG9mIHNvdXJjZSBsaW5lIChub3QgY2xhbXBlZCB0byBlbmQpXG5cdCAqIC0gVCA9IHRhcmdldCBsaW5lIHNob3J0ZXIgdGhhbiBjdXJyZW50IHZpc3VhbCBjb2xcblx0ICogLSBVID0gdGFyZ2V0IGxpbmUgc2hvcnRlciB0aGFuIHByZWZlcnJlZCBjb2xcblx0ICovXG5cdHByaXZhdGUgY29tcHV0ZVZlcnRpY2FsTW92ZUNvbHVtbihcblx0XHRjdXJyZW50VmlzdWFsQ29sOiBudW1iZXIsXG5cdFx0c291cmNlTWF4VmlzdWFsQ29sOiBudW1iZXIsXG5cdFx0dGFyZ2V0TWF4VmlzdWFsQ29sOiBudW1iZXIsXG5cdCk6IG51bWJlciB7XG5cdFx0Y29uc3QgaGFzUHJlZmVycmVkID0gdGhpcy5wcmVmZXJyZWRWaXN1YWxDb2wgIT09IG51bGw7IC8vIFBcblx0XHRjb25zdCBjdXJzb3JJbk1pZGRsZSA9IGN1cnJlbnRWaXN1YWxDb2wgPCBzb3VyY2VNYXhWaXN1YWxDb2w7IC8vIFNcblx0XHRjb25zdCB0YXJnZXRUb29TaG9ydCA9IHRhcmdldE1heFZpc3VhbENvbCA8IGN1cnJlbnRWaXN1YWxDb2w7IC8vIFRcblxuXHRcdGlmICghaGFzUHJlZmVycmVkIHx8IGN1cnNvckluTWlkZGxlKSB7XG5cdFx0XHRpZiAodGFyZ2V0VG9vU2hvcnQpIHtcblx0XHRcdFx0Ly8gQ2FzZXMgMiBhbmQgN1xuXHRcdFx0XHR0aGlzLnByZWZlcnJlZFZpc3VhbENvbCA9IGN1cnJlbnRWaXN1YWxDb2w7XG5cdFx0XHRcdHJldHVybiB0YXJnZXRNYXhWaXN1YWxDb2w7XG5cdFx0XHR9XG5cblx0XHRcdC8vIENhc2VzIDEgYW5kIDZcblx0XHRcdHRoaXMucHJlZmVycmVkVmlzdWFsQ29sID0gbnVsbDtcblx0XHRcdHJldHVybiBjdXJyZW50VmlzdWFsQ29sO1xuXHRcdH1cblxuXHRcdGNvbnN0IHRhcmdldENhbnRGaXRQcmVmZXJyZWQgPSB0YXJnZXRNYXhWaXN1YWxDb2wgPCB0aGlzLnByZWZlcnJlZFZpc3VhbENvbCE7IC8vIFVcblx0XHRpZiAodGFyZ2V0VG9vU2hvcnQgfHwgdGFyZ2V0Q2FudEZpdFByZWZlcnJlZCkge1xuXHRcdFx0Ly8gQ2FzZXMgNCBhbmQgNVxuXHRcdFx0cmV0dXJuIHRhcmdldE1heFZpc3VhbENvbDtcblx0XHR9XG5cblx0XHQvLyBDYXNlIDNcblx0XHRjb25zdCByZXN1bHQgPSB0aGlzLnByZWZlcnJlZFZpc3VhbENvbCE7XG5cdFx0dGhpcy5wcmVmZXJyZWRWaXN1YWxDb2wgPSBudWxsO1xuXHRcdHJldHVybiByZXN1bHQ7XG5cdH1cblxuXHRwcml2YXRlIG1vdmVUb0xpbmVTdGFydCgpOiB2b2lkIHtcblx0XHR0aGlzLmxhc3RBY3Rpb24gPSBudWxsO1xuXHRcdHRoaXMuc2V0Q3Vyc29yQ29sKDApO1xuXHR9XG5cblx0cHJpdmF0ZSBtb3ZlVG9MaW5lRW5kKCk6IHZvaWQge1xuXHRcdHRoaXMubGFzdEFjdGlvbiA9IG51bGw7XG5cdFx0Y29uc3QgY3VycmVudExpbmUgPSB0aGlzLnN0YXRlLmxpbmVzW3RoaXMuc3RhdGUuY3Vyc29yTGluZV0gfHwgXCJcIjtcblx0XHR0aGlzLnNldEN1cnNvckNvbChjdXJyZW50TGluZS5sZW5ndGgpO1xuXHR9XG5cblx0cHJpdmF0ZSBkZWxldGVUb1N0YXJ0T2ZMaW5lKCk6IHZvaWQge1xuXHRcdHRoaXMuaGlzdG9yeUluZGV4ID0gLTE7IC8vIEV4aXQgaGlzdG9yeSBicm93c2luZyBtb2RlXG5cblx0XHRjb25zdCBjdXJyZW50TGluZSA9IHRoaXMuc3RhdGUubGluZXNbdGhpcy5zdGF0ZS5jdXJzb3JMaW5lXSB8fCBcIlwiO1xuXG5cdFx0aWYgKHRoaXMuc3RhdGUuY3Vyc29yQ29sID4gMCkge1xuXHRcdFx0dGhpcy5wdXNoVW5kb1NuYXBzaG90KCk7XG5cblx0XHRcdC8vIENhbGN1bGF0ZSB0ZXh0IHRvIGJlIGRlbGV0ZWQgYW5kIHNhdmUgdG8ga2lsbCByaW5nIChiYWNrd2FyZCBkZWxldGlvbiA9IHByZXBlbmQpXG5cdFx0XHRjb25zdCBkZWxldGVkVGV4dCA9IGN1cnJlbnRMaW5lLnNsaWNlKDAsIHRoaXMuc3RhdGUuY3Vyc29yQ29sKTtcblx0XHRcdHRoaXMua2lsbFJpbmcucHVzaChkZWxldGVkVGV4dCwgeyBwcmVwZW5kOiB0cnVlLCBhY2N1bXVsYXRlOiB0aGlzLmxhc3RBY3Rpb24gPT09IFwia2lsbFwiIH0pO1xuXHRcdFx0dGhpcy5sYXN0QWN0aW9uID0gXCJraWxsXCI7XG5cblx0XHRcdC8vIERlbGV0ZSBmcm9tIHN0YXJ0IG9mIGxpbmUgdXAgdG8gY3Vyc29yXG5cdFx0XHR0aGlzLnN0YXRlLmxpbmVzW3RoaXMuc3RhdGUuY3Vyc29yTGluZV0gPSBjdXJyZW50TGluZS5zbGljZSh0aGlzLnN0YXRlLmN1cnNvckNvbCk7XG5cdFx0XHR0aGlzLnNldEN1cnNvckNvbCgwKTtcblx0XHR9IGVsc2UgaWYgKHRoaXMuc3RhdGUuY3Vyc29yTGluZSA+IDApIHtcblx0XHRcdHRoaXMucHVzaFVuZG9TbmFwc2hvdCgpO1xuXG5cdFx0XHQvLyBBdCBzdGFydCBvZiBsaW5lIC0gbWVyZ2Ugd2l0aCBwcmV2aW91cyBsaW5lLCB0cmVhdGluZyBuZXdsaW5lIGFzIGRlbGV0ZWQgdGV4dFxuXHRcdFx0dGhpcy5raWxsUmluZy5wdXNoKFwiXFxuXCIsIHsgcHJlcGVuZDogdHJ1ZSwgYWNjdW11bGF0ZTogdGhpcy5sYXN0QWN0aW9uID09PSBcImtpbGxcIiB9KTtcblx0XHRcdHRoaXMubGFzdEFjdGlvbiA9IFwia2lsbFwiO1xuXG5cdFx0XHRjb25zdCBwcmV2aW91c0xpbmUgPSB0aGlzLnN0YXRlLmxpbmVzW3RoaXMuc3RhdGUuY3Vyc29yTGluZSAtIDFdIHx8IFwiXCI7XG5cdFx0XHR0aGlzLnN0YXRlLmxpbmVzW3RoaXMuc3RhdGUuY3Vyc29yTGluZSAtIDFdID0gcHJldmlvdXNMaW5lICsgY3VycmVudExpbmU7XG5cdFx0XHR0aGlzLnN0YXRlLmxpbmVzLnNwbGljZSh0aGlzLnN0YXRlLmN1cnNvckxpbmUsIDEpO1xuXHRcdFx0dGhpcy5zdGF0ZS5jdXJzb3JMaW5lLS07XG5cdFx0XHR0aGlzLnNldEN1cnNvckNvbChwcmV2aW91c0xpbmUubGVuZ3RoKTtcblx0XHR9XG5cblx0XHR0aGlzLmVtaXRDaGFuZ2UoKTtcblx0fVxuXG5cdHByaXZhdGUgZGVsZXRlVG9FbmRPZkxpbmUoKTogdm9pZCB7XG5cdFx0dGhpcy5oaXN0b3J5SW5kZXggPSAtMTsgLy8gRXhpdCBoaXN0b3J5IGJyb3dzaW5nIG1vZGVcblxuXHRcdGNvbnN0IGN1cnJlbnRMaW5lID0gdGhpcy5zdGF0ZS5saW5lc1t0aGlzLnN0YXRlLmN1cnNvckxpbmVdIHx8IFwiXCI7XG5cblx0XHRpZiAodGhpcy5zdGF0ZS5jdXJzb3JDb2wgPCBjdXJyZW50TGluZS5sZW5ndGgpIHtcblx0XHRcdHRoaXMucHVzaFVuZG9TbmFwc2hvdCgpO1xuXG5cdFx0XHQvLyBDYWxjdWxhdGUgdGV4dCB0byBiZSBkZWxldGVkIGFuZCBzYXZlIHRvIGtpbGwgcmluZyAoZm9yd2FyZCBkZWxldGlvbiA9IGFwcGVuZClcblx0XHRcdGNvbnN0IGRlbGV0ZWRUZXh0ID0gY3VycmVudExpbmUuc2xpY2UodGhpcy5zdGF0ZS5jdXJzb3JDb2wpO1xuXHRcdFx0dGhpcy5raWxsUmluZy5wdXNoKGRlbGV0ZWRUZXh0LCB7IHByZXBlbmQ6IGZhbHNlLCBhY2N1bXVsYXRlOiB0aGlzLmxhc3RBY3Rpb24gPT09IFwia2lsbFwiIH0pO1xuXHRcdFx0dGhpcy5sYXN0QWN0aW9uID0gXCJraWxsXCI7XG5cblx0XHRcdC8vIERlbGV0ZSBmcm9tIGN1cnNvciB0byBlbmQgb2YgbGluZVxuXHRcdFx0dGhpcy5zdGF0ZS5saW5lc1t0aGlzLnN0YXRlLmN1cnNvckxpbmVdID0gY3VycmVudExpbmUuc2xpY2UoMCwgdGhpcy5zdGF0ZS5jdXJzb3JDb2wpO1xuXHRcdH0gZWxzZSBpZiAodGhpcy5zdGF0ZS5jdXJzb3JMaW5lIDwgdGhpcy5zdGF0ZS5saW5lcy5sZW5ndGggLSAxKSB7XG5cdFx0XHR0aGlzLnB1c2hVbmRvU25hcHNob3QoKTtcblxuXHRcdFx0Ly8gQXQgZW5kIG9mIGxpbmUgLSBtZXJnZSB3aXRoIG5leHQgbGluZSwgdHJlYXRpbmcgbmV3bGluZSBhcyBkZWxldGVkIHRleHRcblx0XHRcdHRoaXMua2lsbFJpbmcucHVzaChcIlxcblwiLCB7IHByZXBlbmQ6IGZhbHNlLCBhY2N1bXVsYXRlOiB0aGlzLmxhc3RBY3Rpb24gPT09IFwia2lsbFwiIH0pO1xuXHRcdFx0dGhpcy5sYXN0QWN0aW9uID0gXCJraWxsXCI7XG5cblx0XHRcdGNvbnN0IG5leHRMaW5lID0gdGhpcy5zdGF0ZS5saW5lc1t0aGlzLnN0YXRlLmN1cnNvckxpbmUgKyAxXSB8fCBcIlwiO1xuXHRcdFx0dGhpcy5zdGF0ZS5saW5lc1t0aGlzLnN0YXRlLmN1cnNvckxpbmVdID0gY3VycmVudExpbmUgKyBuZXh0TGluZTtcblx0XHRcdHRoaXMuc3RhdGUubGluZXMuc3BsaWNlKHRoaXMuc3RhdGUuY3Vyc29yTGluZSArIDEsIDEpO1xuXHRcdH1cblxuXHRcdHRoaXMuZW1pdENoYW5nZSgpO1xuXHR9XG5cblx0cHJpdmF0ZSBkZWxldGVXb3JkQmFja3dhcmRzKCk6IHZvaWQge1xuXHRcdHRoaXMuaGlzdG9yeUluZGV4ID0gLTE7IC8vIEV4aXQgaGlzdG9yeSBicm93c2luZyBtb2RlXG5cblx0XHRjb25zdCBjdXJyZW50TGluZSA9IHRoaXMuc3RhdGUubGluZXNbdGhpcy5zdGF0ZS5jdXJzb3JMaW5lXSB8fCBcIlwiO1xuXG5cdFx0Ly8gSWYgYXQgc3RhcnQgb2YgbGluZSwgYmVoYXZlIGxpa2UgYmFja3NwYWNlIGF0IGNvbHVtbiAwIChtZXJnZSB3aXRoIHByZXZpb3VzIGxpbmUpXG5cdFx0aWYgKHRoaXMuc3RhdGUuY3Vyc29yQ29sID09PSAwKSB7XG5cdFx0XHRpZiAodGhpcy5zdGF0ZS5jdXJzb3JMaW5lID4gMCkge1xuXHRcdFx0XHR0aGlzLnB1c2hVbmRvU25hcHNob3QoKTtcblxuXHRcdFx0XHQvLyBUcmVhdCBuZXdsaW5lIGFzIGRlbGV0ZWQgdGV4dCAoYmFja3dhcmQgZGVsZXRpb24gPSBwcmVwZW5kKVxuXHRcdFx0XHR0aGlzLmtpbGxSaW5nLnB1c2goXCJcXG5cIiwgeyBwcmVwZW5kOiB0cnVlLCBhY2N1bXVsYXRlOiB0aGlzLmxhc3RBY3Rpb24gPT09IFwia2lsbFwiIH0pO1xuXHRcdFx0XHR0aGlzLmxhc3RBY3Rpb24gPSBcImtpbGxcIjtcblxuXHRcdFx0XHRjb25zdCBwcmV2aW91c0xpbmUgPSB0aGlzLnN0YXRlLmxpbmVzW3RoaXMuc3RhdGUuY3Vyc29yTGluZSAtIDFdIHx8IFwiXCI7XG5cdFx0XHRcdHRoaXMuc3RhdGUubGluZXNbdGhpcy5zdGF0ZS5jdXJzb3JMaW5lIC0gMV0gPSBwcmV2aW91c0xpbmUgKyBjdXJyZW50TGluZTtcblx0XHRcdFx0dGhpcy5zdGF0ZS5saW5lcy5zcGxpY2UodGhpcy5zdGF0ZS5jdXJzb3JMaW5lLCAxKTtcblx0XHRcdFx0dGhpcy5zdGF0ZS5jdXJzb3JMaW5lLS07XG5cdFx0XHRcdHRoaXMuc2V0Q3Vyc29yQ29sKHByZXZpb3VzTGluZS5sZW5ndGgpO1xuXHRcdFx0fVxuXHRcdH0gZWxzZSB7XG5cdFx0XHR0aGlzLnB1c2hVbmRvU25hcHNob3QoKTtcblxuXHRcdFx0Ly8gU2F2ZSBsYXN0QWN0aW9uIGJlZm9yZSBjdXJzb3IgbW92ZW1lbnQgKG1vdmVXb3JkQmFja3dhcmRzIHJlc2V0cyBpdClcblx0XHRcdGNvbnN0IHdhc0tpbGwgPSB0aGlzLmxhc3RBY3Rpb24gPT09IFwia2lsbFwiO1xuXG5cdFx0XHRjb25zdCBvbGRDdXJzb3JDb2wgPSB0aGlzLnN0YXRlLmN1cnNvckNvbDtcblx0XHRcdHRoaXMubW92ZVdvcmRCYWNrd2FyZHMoKTtcblx0XHRcdGNvbnN0IGRlbGV0ZUZyb20gPSB0aGlzLnN0YXRlLmN1cnNvckNvbDtcblx0XHRcdHRoaXMuc2V0Q3Vyc29yQ29sKG9sZEN1cnNvckNvbCk7XG5cblx0XHRcdGNvbnN0IGRlbGV0ZWRUZXh0ID0gY3VycmVudExpbmUuc2xpY2UoZGVsZXRlRnJvbSwgdGhpcy5zdGF0ZS5jdXJzb3JDb2wpO1xuXHRcdFx0dGhpcy5raWxsUmluZy5wdXNoKGRlbGV0ZWRUZXh0LCB7IHByZXBlbmQ6IHRydWUsIGFjY3VtdWxhdGU6IHdhc0tpbGwgfSk7XG5cdFx0XHR0aGlzLmxhc3RBY3Rpb24gPSBcImtpbGxcIjtcblxuXHRcdFx0dGhpcy5zdGF0ZS5saW5lc1t0aGlzLnN0YXRlLmN1cnNvckxpbmVdID1cblx0XHRcdFx0Y3VycmVudExpbmUuc2xpY2UoMCwgZGVsZXRlRnJvbSkgKyBjdXJyZW50TGluZS5zbGljZSh0aGlzLnN0YXRlLmN1cnNvckNvbCk7XG5cdFx0XHR0aGlzLnNldEN1cnNvckNvbChkZWxldGVGcm9tKTtcblx0XHR9XG5cblx0XHR0aGlzLmVtaXRDaGFuZ2UoKTtcblx0fVxuXG5cdHByaXZhdGUgZGVsZXRlV29yZEZvcndhcmQoKTogdm9pZCB7XG5cdFx0dGhpcy5oaXN0b3J5SW5kZXggPSAtMTsgLy8gRXhpdCBoaXN0b3J5IGJyb3dzaW5nIG1vZGVcblxuXHRcdGNvbnN0IGN1cnJlbnRMaW5lID0gdGhpcy5zdGF0ZS5saW5lc1t0aGlzLnN0YXRlLmN1cnNvckxpbmVdIHx8IFwiXCI7XG5cblx0XHQvLyBJZiBhdCBlbmQgb2YgbGluZSwgbWVyZ2Ugd2l0aCBuZXh0IGxpbmUgKGRlbGV0ZSB0aGUgbmV3bGluZSlcblx0XHRpZiAodGhpcy5zdGF0ZS5jdXJzb3JDb2wgPj0gY3VycmVudExpbmUubGVuZ3RoKSB7XG5cdFx0XHRpZiAodGhpcy5zdGF0ZS5jdXJzb3JMaW5lIDwgdGhpcy5zdGF0ZS5saW5lcy5sZW5ndGggLSAxKSB7XG5cdFx0XHRcdHRoaXMucHVzaFVuZG9TbmFwc2hvdCgpO1xuXG5cdFx0XHRcdC8vIFRyZWF0IG5ld2xpbmUgYXMgZGVsZXRlZCB0ZXh0IChmb3J3YXJkIGRlbGV0aW9uID0gYXBwZW5kKVxuXHRcdFx0XHR0aGlzLmtpbGxSaW5nLnB1c2goXCJcXG5cIiwgeyBwcmVwZW5kOiBmYWxzZSwgYWNjdW11bGF0ZTogdGhpcy5sYXN0QWN0aW9uID09PSBcImtpbGxcIiB9KTtcblx0XHRcdFx0dGhpcy5sYXN0QWN0aW9uID0gXCJraWxsXCI7XG5cblx0XHRcdFx0Y29uc3QgbmV4dExpbmUgPSB0aGlzLnN0YXRlLmxpbmVzW3RoaXMuc3RhdGUuY3Vyc29yTGluZSArIDFdIHx8IFwiXCI7XG5cdFx0XHRcdHRoaXMuc3RhdGUubGluZXNbdGhpcy5zdGF0ZS5jdXJzb3JMaW5lXSA9IGN1cnJlbnRMaW5lICsgbmV4dExpbmU7XG5cdFx0XHRcdHRoaXMuc3RhdGUubGluZXMuc3BsaWNlKHRoaXMuc3RhdGUuY3Vyc29yTGluZSArIDEsIDEpO1xuXHRcdFx0fVxuXHRcdH0gZWxzZSB7XG5cdFx0XHR0aGlzLnB1c2hVbmRvU25hcHNob3QoKTtcblxuXHRcdFx0Ly8gU2F2ZSBsYXN0QWN0aW9uIGJlZm9yZSBjdXJzb3IgbW92ZW1lbnQgKG1vdmVXb3JkRm9yd2FyZHMgcmVzZXRzIGl0KVxuXHRcdFx0Y29uc3Qgd2FzS2lsbCA9IHRoaXMubGFzdEFjdGlvbiA9PT0gXCJraWxsXCI7XG5cblx0XHRcdGNvbnN0IG9sZEN1cnNvckNvbCA9IHRoaXMuc3RhdGUuY3Vyc29yQ29sO1xuXHRcdFx0dGhpcy5tb3ZlV29yZEZvcndhcmRzKCk7XG5cdFx0XHRjb25zdCBkZWxldGVUbyA9IHRoaXMuc3RhdGUuY3Vyc29yQ29sO1xuXHRcdFx0dGhpcy5zZXRDdXJzb3JDb2wob2xkQ3Vyc29yQ29sKTtcblxuXHRcdFx0Y29uc3QgZGVsZXRlZFRleHQgPSBjdXJyZW50TGluZS5zbGljZSh0aGlzLnN0YXRlLmN1cnNvckNvbCwgZGVsZXRlVG8pO1xuXHRcdFx0dGhpcy5raWxsUmluZy5wdXNoKGRlbGV0ZWRUZXh0LCB7IHByZXBlbmQ6IGZhbHNlLCBhY2N1bXVsYXRlOiB3YXNLaWxsIH0pO1xuXHRcdFx0dGhpcy5sYXN0QWN0aW9uID0gXCJraWxsXCI7XG5cblx0XHRcdHRoaXMuc3RhdGUubGluZXNbdGhpcy5zdGF0ZS5jdXJzb3JMaW5lXSA9XG5cdFx0XHRcdGN1cnJlbnRMaW5lLnNsaWNlKDAsIHRoaXMuc3RhdGUuY3Vyc29yQ29sKSArIGN1cnJlbnRMaW5lLnNsaWNlKGRlbGV0ZVRvKTtcblx0XHR9XG5cblx0XHR0aGlzLmVtaXRDaGFuZ2UoKTtcblx0fVxuXG5cdHByaXZhdGUgaGFuZGxlRm9yd2FyZERlbGV0ZSgpOiB2b2lkIHtcblx0XHR0aGlzLmhpc3RvcnlJbmRleCA9IC0xOyAvLyBFeGl0IGhpc3RvcnkgYnJvd3NpbmcgbW9kZVxuXHRcdHRoaXMubGFzdEFjdGlvbiA9IG51bGw7XG5cblx0XHRjb25zdCBjdXJyZW50TGluZSA9IHRoaXMuc3RhdGUubGluZXNbdGhpcy5zdGF0ZS5jdXJzb3JMaW5lXSB8fCBcIlwiO1xuXG5cdFx0aWYgKHRoaXMuc3RhdGUuY3Vyc29yQ29sIDwgY3VycmVudExpbmUubGVuZ3RoKSB7XG5cdFx0XHR0aGlzLnB1c2hVbmRvU25hcHNob3QoKTtcblxuXHRcdFx0Ly8gRGVsZXRlIGdyYXBoZW1lIGF0IGN1cnNvciBwb3NpdGlvbiAoaGFuZGxlcyBlbW9qaXMsIGNvbWJpbmluZyBjaGFyYWN0ZXJzLCBldGMuKVxuXHRcdFx0Y29uc3QgYWZ0ZXJDdXJzb3IgPSBjdXJyZW50TGluZS5zbGljZSh0aGlzLnN0YXRlLmN1cnNvckNvbCk7XG5cblx0XHRcdC8vIEZpbmQgdGhlIGZpcnN0IGdyYXBoZW1lIGF0IGN1cnNvclxuXHRcdFx0Y29uc3QgZ3JhcGhlbWVzID0gWy4uLnNlZ21lbnRlci5zZWdtZW50KGFmdGVyQ3Vyc29yKV07XG5cdFx0XHRjb25zdCBmaXJzdEdyYXBoZW1lID0gZ3JhcGhlbWVzWzBdO1xuXHRcdFx0Y29uc3QgZ3JhcGhlbWVMZW5ndGggPSBmaXJzdEdyYXBoZW1lID8gZmlyc3RHcmFwaGVtZS5zZWdtZW50Lmxlbmd0aCA6IDE7XG5cblx0XHRcdGNvbnN0IGJlZm9yZSA9IGN1cnJlbnRMaW5lLnNsaWNlKDAsIHRoaXMuc3RhdGUuY3Vyc29yQ29sKTtcblx0XHRcdGNvbnN0IGFmdGVyID0gY3VycmVudExpbmUuc2xpY2UodGhpcy5zdGF0ZS5jdXJzb3JDb2wgKyBncmFwaGVtZUxlbmd0aCk7XG5cdFx0XHR0aGlzLnN0YXRlLmxpbmVzW3RoaXMuc3RhdGUuY3Vyc29yTGluZV0gPSBiZWZvcmUgKyBhZnRlcjtcblx0XHR9IGVsc2UgaWYgKHRoaXMuc3RhdGUuY3Vyc29yTGluZSA8IHRoaXMuc3RhdGUubGluZXMubGVuZ3RoIC0gMSkge1xuXHRcdFx0dGhpcy5wdXNoVW5kb1NuYXBzaG90KCk7XG5cblx0XHRcdC8vIEF0IGVuZCBvZiBsaW5lIC0gbWVyZ2Ugd2l0aCBuZXh0IGxpbmVcblx0XHRcdGNvbnN0IG5leHRMaW5lID0gdGhpcy5zdGF0ZS5saW5lc1t0aGlzLnN0YXRlLmN1cnNvckxpbmUgKyAxXSB8fCBcIlwiO1xuXHRcdFx0dGhpcy5zdGF0ZS5saW5lc1t0aGlzLnN0YXRlLmN1cnNvckxpbmVdID0gY3VycmVudExpbmUgKyBuZXh0TGluZTtcblx0XHRcdHRoaXMuc3RhdGUubGluZXMuc3BsaWNlKHRoaXMuc3RhdGUuY3Vyc29yTGluZSArIDEsIDEpO1xuXHRcdH1cblxuXHRcdHRoaXMuZW1pdENoYW5nZSgpO1xuXG5cdFx0Ly8gVXBkYXRlIG9yIHJlLXRyaWdnZXIgYXV0b2NvbXBsZXRlIGFmdGVyIGZvcndhcmQgZGVsZXRlXG5cdFx0aWYgKHRoaXMuYXV0b2NvbXBsZXRlU3RhdGUpIHtcblx0XHRcdHRoaXMudXBkYXRlQXV0b2NvbXBsZXRlKCk7XG5cdFx0fSBlbHNlIHtcblx0XHRcdGNvbnN0IGN1cnJlbnRMaW5lID0gdGhpcy5zdGF0ZS5saW5lc1t0aGlzLnN0YXRlLmN1cnNvckxpbmVdIHx8IFwiXCI7XG5cdFx0XHRjb25zdCB0ZXh0QmVmb3JlQ3Vyc29yID0gY3VycmVudExpbmUuc2xpY2UoMCwgdGhpcy5zdGF0ZS5jdXJzb3JDb2wpO1xuXHRcdFx0Ly8gU2xhc2ggY29tbWFuZCBjb250ZXh0XG5cdFx0XHRpZiAodGhpcy5pc0luU2xhc2hDb21tYW5kQ29udGV4dCh0ZXh0QmVmb3JlQ3Vyc29yKSkge1xuXHRcdFx0XHR0aGlzLnRyeVRyaWdnZXJBdXRvY29tcGxldGUoKTtcblx0XHRcdH1cblx0XHRcdC8vIEAgZmlsZSByZWZlcmVuY2UgY29udGV4dCAoZGVib3VuY2VkIHRvIGF2b2lkIGJsb2NraW5nIGV2ZW50IGxvb3ApXG5cdFx0XHRlbHNlIGlmICh0ZXh0QmVmb3JlQ3Vyc29yLm1hdGNoKC8oPzpefFtcXHNdKUBbXlxcc10qJC8pKSB7XG5cdFx0XHRcdHRoaXMuZGVib3VuY2VkVHJpZ2dlckF1dG9jb21wbGV0ZSgpO1xuXHRcdFx0fVxuXHRcdH1cblx0fVxuXG5cdC8qKlxuXHQgKiBCdWlsZCBhIG1hcHBpbmcgZnJvbSB2aXN1YWwgbGluZXMgdG8gbG9naWNhbCBwb3NpdGlvbnMuXG5cdCAqIFJldHVybnMgYW4gYXJyYXkgd2hlcmUgZWFjaCBlbGVtZW50IHJlcHJlc2VudHMgYSB2aXN1YWwgbGluZSB3aXRoOlxuXHQgKiAtIGxvZ2ljYWxMaW5lOiBpbmRleCBpbnRvIHRoaXMuc3RhdGUubGluZXNcblx0ICogLSBzdGFydENvbDogc3RhcnRpbmcgY29sdW1uIGluIHRoZSBsb2dpY2FsIGxpbmVcblx0ICogLSBsZW5ndGg6IGxlbmd0aCBvZiB0aGlzIHZpc3VhbCBsaW5lIHNlZ21lbnRcblx0ICovXG5cdHByaXZhdGUgYnVpbGRWaXN1YWxMaW5lTWFwKHdpZHRoOiBudW1iZXIpOiBWaXN1YWxMaW5lW10ge1xuXHRcdGNvbnN0IGNhY2hlZCA9IHRoaXMudmlzdWFsTGluZU1hcENhY2hlO1xuXHRcdGlmIChjYWNoZWQgJiYgY2FjaGVkLndpZHRoID09PSB3aWR0aCAmJiBjYWNoZWQudGV4dFZlcnNpb24gPT09IHRoaXMudGV4dFZlcnNpb24pIHtcblx0XHRcdHJldHVybiBjYWNoZWQubGluZXM7XG5cdFx0fVxuXG5cdFx0Y29uc3QgdmlzdWFsTGluZXM6IFZpc3VhbExpbmVbXSA9IFtdO1xuXG5cdFx0Zm9yIChsZXQgaSA9IDA7IGkgPCB0aGlzLnN0YXRlLmxpbmVzLmxlbmd0aDsgaSsrKSB7XG5cdFx0XHRjb25zdCBsaW5lID0gdGhpcy5zdGF0ZS5saW5lc1tpXSB8fCBcIlwiO1xuXHRcdFx0Y29uc3QgbGluZVZpc1dpZHRoID0gdmlzaWJsZVdpZHRoKGxpbmUpO1xuXHRcdFx0aWYgKGxpbmUubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRcdC8vIEVtcHR5IGxpbmUgc3RpbGwgdGFrZXMgb25lIHZpc3VhbCBsaW5lXG5cdFx0XHRcdHZpc3VhbExpbmVzLnB1c2goeyBsb2dpY2FsTGluZTogaSwgc3RhcnRDb2w6IDAsIGxlbmd0aDogMCB9KTtcblx0XHRcdH0gZWxzZSBpZiAobGluZVZpc1dpZHRoIDw9IHdpZHRoKSB7XG5cdFx0XHRcdHZpc3VhbExpbmVzLnB1c2goeyBsb2dpY2FsTGluZTogaSwgc3RhcnRDb2w6IDAsIGxlbmd0aDogbGluZS5sZW5ndGggfSk7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHQvLyBMaW5lIG5lZWRzIHdyYXBwaW5nIC0gdXNlIHdvcmQtYXdhcmUgd3JhcHBpbmdcblx0XHRcdFx0Y29uc3QgY2h1bmtzID0gd29yZFdyYXBMaW5lKGxpbmUsIHdpZHRoKTtcblx0XHRcdFx0Zm9yIChjb25zdCBjaHVuayBvZiBjaHVua3MpIHtcblx0XHRcdFx0XHR2aXN1YWxMaW5lcy5wdXNoKHtcblx0XHRcdFx0XHRcdGxvZ2ljYWxMaW5lOiBpLFxuXHRcdFx0XHRcdFx0c3RhcnRDb2w6IGNodW5rLnN0YXJ0SW5kZXgsXG5cdFx0XHRcdFx0XHRsZW5ndGg6IGNodW5rLmVuZEluZGV4IC0gY2h1bmsuc3RhcnRJbmRleCxcblx0XHRcdFx0XHR9KTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH1cblxuXHRcdHRoaXMudmlzdWFsTGluZU1hcENhY2hlID0ge1xuXHRcdFx0d2lkdGgsXG5cdFx0XHR0ZXh0VmVyc2lvbjogdGhpcy50ZXh0VmVyc2lvbixcblx0XHRcdGxpbmVzOiB2aXN1YWxMaW5lcyxcblx0XHR9O1xuXHRcdHJldHVybiB2aXN1YWxMaW5lcztcblx0fVxuXG5cdC8qKlxuXHQgKiBGaW5kIHRoZSB2aXN1YWwgbGluZSBpbmRleCBmb3IgdGhlIGN1cnJlbnQgY3Vyc29yIHBvc2l0aW9uLlxuXHQgKi9cblx0cHJpdmF0ZSBmaW5kQ3VycmVudFZpc3VhbExpbmUoXG5cdFx0dmlzdWFsTGluZXM6IEFycmF5PHsgbG9naWNhbExpbmU6IG51bWJlcjsgc3RhcnRDb2w6IG51bWJlcjsgbGVuZ3RoOiBudW1iZXIgfT4sXG5cdCk6IG51bWJlciB7XG5cdFx0Zm9yIChsZXQgaSA9IDA7IGkgPCB2aXN1YWxMaW5lcy5sZW5ndGg7IGkrKykge1xuXHRcdFx0Y29uc3QgdmwgPSB2aXN1YWxMaW5lc1tpXTtcblx0XHRcdGlmICghdmwpIGNvbnRpbnVlO1xuXHRcdFx0aWYgKHZsLmxvZ2ljYWxMaW5lID09PSB0aGlzLnN0YXRlLmN1cnNvckxpbmUpIHtcblx0XHRcdFx0Y29uc3QgY29sSW5TZWdtZW50ID0gdGhpcy5zdGF0ZS5jdXJzb3JDb2wgLSB2bC5zdGFydENvbDtcblx0XHRcdFx0Ly8gQ3Vyc29yIGlzIGluIHRoaXMgc2VnbWVudCBpZiBpdCdzIHdpdGhpbiByYW5nZVxuXHRcdFx0XHQvLyBGb3IgdGhlIGxhc3Qgc2VnbWVudCBvZiBhIGxvZ2ljYWwgbGluZSwgY3Vyc29yIGNhbiBiZSBhdCBsZW5ndGggKGVuZCBwb3NpdGlvbilcblx0XHRcdFx0Y29uc3QgaXNMYXN0U2VnbWVudE9mTGluZSA9XG5cdFx0XHRcdFx0aSA9PT0gdmlzdWFsTGluZXMubGVuZ3RoIC0gMSB8fCB2aXN1YWxMaW5lc1tpICsgMV0/LmxvZ2ljYWxMaW5lICE9PSB2bC5sb2dpY2FsTGluZTtcblx0XHRcdFx0aWYgKGNvbEluU2VnbWVudCA+PSAwICYmIChjb2xJblNlZ21lbnQgPCB2bC5sZW5ndGggfHwgKGlzTGFzdFNlZ21lbnRPZkxpbmUgJiYgY29sSW5TZWdtZW50IDw9IHZsLmxlbmd0aCkpKSB7XG5cdFx0XHRcdFx0cmV0dXJuIGk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9XG5cdFx0Ly8gRmFsbGJhY2s6IHJldHVybiBsYXN0IHZpc3VhbCBsaW5lXG5cdFx0cmV0dXJuIHZpc3VhbExpbmVzLmxlbmd0aCAtIDE7XG5cdH1cblxuXHRwcml2YXRlIG1vdmVDdXJzb3IoZGVsdGFMaW5lOiBudW1iZXIsIGRlbHRhQ29sOiBudW1iZXIpOiB2b2lkIHtcblx0XHR0aGlzLmxhc3RBY3Rpb24gPSBudWxsO1xuXHRcdGNvbnN0IHZpc3VhbExpbmVzID0gdGhpcy5idWlsZFZpc3VhbExpbmVNYXAodGhpcy5sYXN0V2lkdGgpO1xuXHRcdGNvbnN0IGN1cnJlbnRWaXN1YWxMaW5lID0gdGhpcy5maW5kQ3VycmVudFZpc3VhbExpbmUodmlzdWFsTGluZXMpO1xuXG5cdFx0aWYgKGRlbHRhTGluZSAhPT0gMCkge1xuXHRcdFx0Y29uc3QgdGFyZ2V0VmlzdWFsTGluZSA9IGN1cnJlbnRWaXN1YWxMaW5lICsgZGVsdGFMaW5lO1xuXG5cdFx0XHRpZiAodGFyZ2V0VmlzdWFsTGluZSA+PSAwICYmIHRhcmdldFZpc3VhbExpbmUgPCB2aXN1YWxMaW5lcy5sZW5ndGgpIHtcblx0XHRcdFx0dGhpcy5tb3ZlVG9WaXN1YWxMaW5lKHZpc3VhbExpbmVzLCBjdXJyZW50VmlzdWFsTGluZSwgdGFyZ2V0VmlzdWFsTGluZSk7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0aWYgKGRlbHRhQ29sICE9PSAwKSB7XG5cdFx0XHRjb25zdCBjdXJyZW50TGluZSA9IHRoaXMuc3RhdGUubGluZXNbdGhpcy5zdGF0ZS5jdXJzb3JMaW5lXSB8fCBcIlwiO1xuXG5cdFx0XHRpZiAoZGVsdGFDb2wgPiAwKSB7XG5cdFx0XHRcdC8vIE1vdmluZyByaWdodCAtIG1vdmUgYnkgb25lIGdyYXBoZW1lIChoYW5kbGVzIGVtb2ppcywgY29tYmluaW5nIGNoYXJhY3RlcnMsIGV0Yy4pXG5cdFx0XHRcdGlmICh0aGlzLnN0YXRlLmN1cnNvckNvbCA8IGN1cnJlbnRMaW5lLmxlbmd0aCkge1xuXHRcdFx0XHRcdGNvbnN0IGFmdGVyQ3Vyc29yID0gY3VycmVudExpbmUuc2xpY2UodGhpcy5zdGF0ZS5jdXJzb3JDb2wpO1xuXHRcdFx0XHRcdGNvbnN0IGdyYXBoZW1lcyA9IFsuLi5zZWdtZW50ZXIuc2VnbWVudChhZnRlckN1cnNvcildO1xuXHRcdFx0XHRcdGNvbnN0IGZpcnN0R3JhcGhlbWUgPSBncmFwaGVtZXNbMF07XG5cdFx0XHRcdFx0dGhpcy5zZXRDdXJzb3JDb2wodGhpcy5zdGF0ZS5jdXJzb3JDb2wgKyAoZmlyc3RHcmFwaGVtZSA/IGZpcnN0R3JhcGhlbWUuc2VnbWVudC5sZW5ndGggOiAxKSk7XG5cdFx0XHRcdH0gZWxzZSBpZiAodGhpcy5zdGF0ZS5jdXJzb3JMaW5lIDwgdGhpcy5zdGF0ZS5saW5lcy5sZW5ndGggLSAxKSB7XG5cdFx0XHRcdFx0Ly8gV3JhcCB0byBzdGFydCBvZiBuZXh0IGxvZ2ljYWwgbGluZVxuXHRcdFx0XHRcdHRoaXMuc3RhdGUuY3Vyc29yTGluZSsrO1xuXHRcdFx0XHRcdHRoaXMuc2V0Q3Vyc29yQ29sKDApO1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdC8vIEF0IGVuZCBvZiBsYXN0IGxpbmUgLSBjYW4ndCBtb3ZlLCBidXQgc2V0IHByZWZlcnJlZFZpc3VhbENvbCBmb3IgdXAvZG93biBuYXZpZ2F0aW9uXG5cdFx0XHRcdFx0Y29uc3QgY3VycmVudFZMID0gdmlzdWFsTGluZXNbY3VycmVudFZpc3VhbExpbmVdO1xuXHRcdFx0XHRcdGlmIChjdXJyZW50VkwpIHtcblx0XHRcdFx0XHRcdHRoaXMucHJlZmVycmVkVmlzdWFsQ29sID0gdGhpcy5zdGF0ZS5jdXJzb3JDb2wgLSBjdXJyZW50Vkwuc3RhcnRDb2w7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHQvLyBNb3ZpbmcgbGVmdCAtIG1vdmUgYnkgb25lIGdyYXBoZW1lIChoYW5kbGVzIGVtb2ppcywgY29tYmluaW5nIGNoYXJhY3RlcnMsIGV0Yy4pXG5cdFx0XHRcdGlmICh0aGlzLnN0YXRlLmN1cnNvckNvbCA+IDApIHtcblx0XHRcdFx0XHRjb25zdCBiZWZvcmVDdXJzb3IgPSBjdXJyZW50TGluZS5zbGljZSgwLCB0aGlzLnN0YXRlLmN1cnNvckNvbCk7XG5cdFx0XHRcdFx0Y29uc3QgZ3JhcGhlbWVzID0gWy4uLnNlZ21lbnRlci5zZWdtZW50KGJlZm9yZUN1cnNvcildO1xuXHRcdFx0XHRcdGNvbnN0IGxhc3RHcmFwaGVtZSA9IGdyYXBoZW1lc1tncmFwaGVtZXMubGVuZ3RoIC0gMV07XG5cdFx0XHRcdFx0dGhpcy5zZXRDdXJzb3JDb2wodGhpcy5zdGF0ZS5jdXJzb3JDb2wgLSAobGFzdEdyYXBoZW1lID8gbGFzdEdyYXBoZW1lLnNlZ21lbnQubGVuZ3RoIDogMSkpO1xuXHRcdFx0XHR9IGVsc2UgaWYgKHRoaXMuc3RhdGUuY3Vyc29yTGluZSA+IDApIHtcblx0XHRcdFx0XHQvLyBXcmFwIHRvIGVuZCBvZiBwcmV2aW91cyBsb2dpY2FsIGxpbmVcblx0XHRcdFx0XHR0aGlzLnN0YXRlLmN1cnNvckxpbmUtLTtcblx0XHRcdFx0XHRjb25zdCBwcmV2TGluZSA9IHRoaXMuc3RhdGUubGluZXNbdGhpcy5zdGF0ZS5jdXJzb3JMaW5lXSB8fCBcIlwiO1xuXHRcdFx0XHRcdHRoaXMuc2V0Q3Vyc29yQ29sKHByZXZMaW5lLmxlbmd0aCk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9XG5cdH1cblxuXHQvKipcblx0ICogU2Nyb2xsIGJ5IGEgcGFnZSAoZGlyZWN0aW9uOiAtMSBmb3IgdXAsIDEgZm9yIGRvd24pLlxuXHQgKiBNb3ZlcyBjdXJzb3IgYnkgdGhlIHBhZ2Ugc2l6ZSB3aGlsZSBrZWVwaW5nIGl0IGluIGJvdW5kcy5cblx0ICovXG5cdHByaXZhdGUgcGFnZVNjcm9sbChkaXJlY3Rpb246IC0xIHwgMSk6IHZvaWQge1xuXHRcdHRoaXMubGFzdEFjdGlvbiA9IG51bGw7XG5cdFx0Y29uc3QgdGVybWluYWxSb3dzID0gdGhpcy50dWkudGVybWluYWwucm93cztcblx0XHRjb25zdCBwYWdlU2l6ZSA9IE1hdGgubWF4KDUsIE1hdGguZmxvb3IodGVybWluYWxSb3dzICogMC4zKSk7XG5cblx0XHRjb25zdCB2aXN1YWxMaW5lcyA9IHRoaXMuYnVpbGRWaXN1YWxMaW5lTWFwKHRoaXMubGFzdFdpZHRoKTtcblx0XHRjb25zdCBjdXJyZW50VmlzdWFsTGluZSA9IHRoaXMuZmluZEN1cnJlbnRWaXN1YWxMaW5lKHZpc3VhbExpbmVzKTtcblx0XHRjb25zdCB0YXJnZXRWaXN1YWxMaW5lID0gTWF0aC5tYXgoMCwgTWF0aC5taW4odmlzdWFsTGluZXMubGVuZ3RoIC0gMSwgY3VycmVudFZpc3VhbExpbmUgKyBkaXJlY3Rpb24gKiBwYWdlU2l6ZSkpO1xuXG5cdFx0dGhpcy5tb3ZlVG9WaXN1YWxMaW5lKHZpc3VhbExpbmVzLCBjdXJyZW50VmlzdWFsTGluZSwgdGFyZ2V0VmlzdWFsTGluZSk7XG5cdH1cblxuXHRwcml2YXRlIG1vdmVXb3JkQmFja3dhcmRzKCk6IHZvaWQge1xuXHRcdHRoaXMubGFzdEFjdGlvbiA9IG51bGw7XG5cdFx0Y29uc3QgY3VycmVudExpbmUgPSB0aGlzLnN0YXRlLmxpbmVzW3RoaXMuc3RhdGUuY3Vyc29yTGluZV0gfHwgXCJcIjtcblxuXHRcdC8vIElmIGF0IHN0YXJ0IG9mIGxpbmUsIG1vdmUgdG8gZW5kIG9mIHByZXZpb3VzIGxpbmVcblx0XHRpZiAodGhpcy5zdGF0ZS5jdXJzb3JDb2wgPT09IDApIHtcblx0XHRcdGlmICh0aGlzLnN0YXRlLmN1cnNvckxpbmUgPiAwKSB7XG5cdFx0XHRcdHRoaXMuc3RhdGUuY3Vyc29yTGluZS0tO1xuXHRcdFx0XHRjb25zdCBwcmV2TGluZSA9IHRoaXMuc3RhdGUubGluZXNbdGhpcy5zdGF0ZS5jdXJzb3JMaW5lXSB8fCBcIlwiO1xuXHRcdFx0XHR0aGlzLnNldEN1cnNvckNvbChwcmV2TGluZS5sZW5ndGgpO1xuXHRcdFx0fVxuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGNvbnN0IHRleHRCZWZvcmVDdXJzb3IgPSBjdXJyZW50TGluZS5zbGljZSgwLCB0aGlzLnN0YXRlLmN1cnNvckNvbCk7XG5cdFx0Y29uc3QgZ3JhcGhlbWVzID0gWy4uLnNlZ21lbnRlci5zZWdtZW50KHRleHRCZWZvcmVDdXJzb3IpXTtcblx0XHRsZXQgbmV3Q29sID0gdGhpcy5zdGF0ZS5jdXJzb3JDb2w7XG5cblx0XHQvLyBTa2lwIHRyYWlsaW5nIHdoaXRlc3BhY2Vcblx0XHR3aGlsZSAoZ3JhcGhlbWVzLmxlbmd0aCA+IDAgJiYgaXNXaGl0ZXNwYWNlQ2hhcihncmFwaGVtZXNbZ3JhcGhlbWVzLmxlbmd0aCAtIDFdPy5zZWdtZW50IHx8IFwiXCIpKSB7XG5cdFx0XHRuZXdDb2wgLT0gZ3JhcGhlbWVzLnBvcCgpPy5zZWdtZW50Lmxlbmd0aCB8fCAwO1xuXHRcdH1cblxuXHRcdGlmIChncmFwaGVtZXMubGVuZ3RoID4gMCkge1xuXHRcdFx0Y29uc3QgbGFzdEdyYXBoZW1lID0gZ3JhcGhlbWVzW2dyYXBoZW1lcy5sZW5ndGggLSAxXT8uc2VnbWVudCB8fCBcIlwiO1xuXHRcdFx0aWYgKGlzUHVuY3R1YXRpb25DaGFyKGxhc3RHcmFwaGVtZSkpIHtcblx0XHRcdFx0Ly8gU2tpcCBwdW5jdHVhdGlvbiBydW5cblx0XHRcdFx0d2hpbGUgKGdyYXBoZW1lcy5sZW5ndGggPiAwICYmIGlzUHVuY3R1YXRpb25DaGFyKGdyYXBoZW1lc1tncmFwaGVtZXMubGVuZ3RoIC0gMV0/LnNlZ21lbnQgfHwgXCJcIikpIHtcblx0XHRcdFx0XHRuZXdDb2wgLT0gZ3JhcGhlbWVzLnBvcCgpPy5zZWdtZW50Lmxlbmd0aCB8fCAwO1xuXHRcdFx0XHR9XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHQvLyBTa2lwIHdvcmQgcnVuXG5cdFx0XHRcdHdoaWxlIChcblx0XHRcdFx0XHRncmFwaGVtZXMubGVuZ3RoID4gMCAmJlxuXHRcdFx0XHRcdCFpc1doaXRlc3BhY2VDaGFyKGdyYXBoZW1lc1tncmFwaGVtZXMubGVuZ3RoIC0gMV0/LnNlZ21lbnQgfHwgXCJcIikgJiZcblx0XHRcdFx0XHQhaXNQdW5jdHVhdGlvbkNoYXIoZ3JhcGhlbWVzW2dyYXBoZW1lcy5sZW5ndGggLSAxXT8uc2VnbWVudCB8fCBcIlwiKVxuXHRcdFx0XHQpIHtcblx0XHRcdFx0XHRuZXdDb2wgLT0gZ3JhcGhlbWVzLnBvcCgpPy5zZWdtZW50Lmxlbmd0aCB8fCAwO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0dGhpcy5zZXRDdXJzb3JDb2wobmV3Q29sKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBZYW5rIChwYXN0ZSkgdGhlIG1vc3QgcmVjZW50IGtpbGwgcmluZyBlbnRyeSBhdCBjdXJzb3IgcG9zaXRpb24uXG5cdCAqL1xuXHRwcml2YXRlIHlhbmsoKTogdm9pZCB7XG5cdFx0aWYgKHRoaXMua2lsbFJpbmcubGVuZ3RoID09PSAwKSByZXR1cm47XG5cblx0XHR0aGlzLnB1c2hVbmRvU25hcHNob3QoKTtcblxuXHRcdGNvbnN0IHRleHQgPSB0aGlzLmtpbGxSaW5nLnBlZWsoKSE7XG5cdFx0dGhpcy5pbnNlcnRZYW5rZWRUZXh0KHRleHQpO1xuXG5cdFx0dGhpcy5sYXN0QWN0aW9uID0gXCJ5YW5rXCI7XG5cdH1cblxuXHQvKipcblx0ICogQ3ljbGUgdGhyb3VnaCBraWxsIHJpbmcgKG9ubHkgd29ya3MgaW1tZWRpYXRlbHkgYWZ0ZXIgeWFuayBvciB5YW5rLXBvcCkuXG5cdCAqIFJlcGxhY2VzIHRoZSBsYXN0IHlhbmtlZCB0ZXh0IHdpdGggdGhlIHByZXZpb3VzIGVudHJ5IGluIHRoZSByaW5nLlxuXHQgKi9cblx0cHJpdmF0ZSB5YW5rUG9wKCk6IHZvaWQge1xuXHRcdC8vIE9ubHkgd29ya3MgaWYgd2UganVzdCB5YW5rZWQgYW5kIGhhdmUgbW9yZSB0aGFuIG9uZSBlbnRyeVxuXHRcdGlmICh0aGlzLmxhc3RBY3Rpb24gIT09IFwieWFua1wiIHx8IHRoaXMua2lsbFJpbmcubGVuZ3RoIDw9IDEpIHJldHVybjtcblxuXHRcdHRoaXMucHVzaFVuZG9TbmFwc2hvdCgpO1xuXG5cdFx0Ly8gRGVsZXRlIHRoZSBwcmV2aW91c2x5IHlhbmtlZCB0ZXh0IChzdGlsbCBhdCBlbmQgb2YgcmluZyBiZWZvcmUgcm90YXRpb24pXG5cdFx0dGhpcy5kZWxldGVZYW5rZWRUZXh0KCk7XG5cblx0XHQvLyBSb3RhdGUgdGhlIHJpbmc6IG1vdmUgZW5kIHRvIGZyb250XG5cdFx0dGhpcy5raWxsUmluZy5yb3RhdGUoKTtcblxuXHRcdC8vIEluc2VydCB0aGUgbmV3IG1vc3QgcmVjZW50IGVudHJ5IChub3cgYXQgZW5kIGFmdGVyIHJvdGF0aW9uKVxuXHRcdGNvbnN0IHRleHQgPSB0aGlzLmtpbGxSaW5nLnBlZWsoKSE7XG5cdFx0dGhpcy5pbnNlcnRZYW5rZWRUZXh0KHRleHQpO1xuXG5cdFx0dGhpcy5sYXN0QWN0aW9uID0gXCJ5YW5rXCI7XG5cdH1cblxuXHQvKipcblx0ICogSW5zZXJ0IHRleHQgYXQgY3Vyc29yIHBvc2l0aW9uICh1c2VkIGJ5IHlhbmsgb3BlcmF0aW9ucykuXG5cdCAqL1xuXHRwcml2YXRlIGluc2VydFlhbmtlZFRleHQodGV4dDogc3RyaW5nKTogdm9pZCB7XG5cdFx0dGhpcy5oaXN0b3J5SW5kZXggPSAtMTsgLy8gRXhpdCBoaXN0b3J5IGJyb3dzaW5nIG1vZGVcblx0XHRjb25zdCBsaW5lcyA9IHRleHQuc3BsaXQoXCJcXG5cIik7XG5cblx0XHRpZiAobGluZXMubGVuZ3RoID09PSAxKSB7XG5cdFx0XHQvLyBTaW5nbGUgbGluZSAtIGluc2VydCBhdCBjdXJzb3Jcblx0XHRcdGNvbnN0IGN1cnJlbnRMaW5lID0gdGhpcy5zdGF0ZS5saW5lc1t0aGlzLnN0YXRlLmN1cnNvckxpbmVdIHx8IFwiXCI7XG5cdFx0XHRjb25zdCBiZWZvcmUgPSBjdXJyZW50TGluZS5zbGljZSgwLCB0aGlzLnN0YXRlLmN1cnNvckNvbCk7XG5cdFx0XHRjb25zdCBhZnRlciA9IGN1cnJlbnRMaW5lLnNsaWNlKHRoaXMuc3RhdGUuY3Vyc29yQ29sKTtcblx0XHRcdHRoaXMuc3RhdGUubGluZXNbdGhpcy5zdGF0ZS5jdXJzb3JMaW5lXSA9IGJlZm9yZSArIHRleHQgKyBhZnRlcjtcblx0XHRcdHRoaXMuc2V0Q3Vyc29yQ29sKHRoaXMuc3RhdGUuY3Vyc29yQ29sICsgdGV4dC5sZW5ndGgpO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHQvLyBNdWx0aS1saW5lIGluc2VydFxuXHRcdFx0Y29uc3QgY3VycmVudExpbmUgPSB0aGlzLnN0YXRlLmxpbmVzW3RoaXMuc3RhdGUuY3Vyc29yTGluZV0gfHwgXCJcIjtcblx0XHRcdGNvbnN0IGJlZm9yZSA9IGN1cnJlbnRMaW5lLnNsaWNlKDAsIHRoaXMuc3RhdGUuY3Vyc29yQ29sKTtcblx0XHRcdGNvbnN0IGFmdGVyID0gY3VycmVudExpbmUuc2xpY2UodGhpcy5zdGF0ZS5jdXJzb3JDb2wpO1xuXG5cdFx0XHQvLyBGaXJzdCBsaW5lIG1lcmdlcyB3aXRoIHRleHQgYmVmb3JlIGN1cnNvclxuXHRcdFx0dGhpcy5zdGF0ZS5saW5lc1t0aGlzLnN0YXRlLmN1cnNvckxpbmVdID0gYmVmb3JlICsgKGxpbmVzWzBdIHx8IFwiXCIpO1xuXG5cdFx0XHQvLyBJbnNlcnQgbWlkZGxlIGxpbmVzXG5cdFx0XHRmb3IgKGxldCBpID0gMTsgaSA8IGxpbmVzLmxlbmd0aCAtIDE7IGkrKykge1xuXHRcdFx0XHR0aGlzLnN0YXRlLmxpbmVzLnNwbGljZSh0aGlzLnN0YXRlLmN1cnNvckxpbmUgKyBpLCAwLCBsaW5lc1tpXSB8fCBcIlwiKTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gTGFzdCBsaW5lIG1lcmdlcyB3aXRoIHRleHQgYWZ0ZXIgY3Vyc29yXG5cdFx0XHRjb25zdCBsYXN0TGluZUluZGV4ID0gdGhpcy5zdGF0ZS5jdXJzb3JMaW5lICsgbGluZXMubGVuZ3RoIC0gMTtcblx0XHRcdHRoaXMuc3RhdGUubGluZXMuc3BsaWNlKGxhc3RMaW5lSW5kZXgsIDAsIChsaW5lc1tsaW5lcy5sZW5ndGggLSAxXSB8fCBcIlwiKSArIGFmdGVyKTtcblxuXHRcdFx0Ly8gVXBkYXRlIGN1cnNvciBwb3NpdGlvblxuXHRcdFx0dGhpcy5zdGF0ZS5jdXJzb3JMaW5lID0gbGFzdExpbmVJbmRleDtcblx0XHRcdHRoaXMuc2V0Q3Vyc29yQ29sKChsaW5lc1tsaW5lcy5sZW5ndGggLSAxXSB8fCBcIlwiKS5sZW5ndGgpO1xuXHRcdH1cblxuXHRcdHRoaXMuZW1pdENoYW5nZSgpO1xuXHR9XG5cblx0LyoqXG5cdCAqIERlbGV0ZSB0aGUgcHJldmlvdXNseSB5YW5rZWQgdGV4dCAodXNlZCBieSB5YW5rLXBvcCkuXG5cdCAqIFRoZSB5YW5rZWQgdGV4dCBpcyBkZXJpdmVkIGZyb20ga2lsbFJpbmdbZW5kXSBzaW5jZSBpdCBoYXNuJ3QgYmVlbiByb3RhdGVkIHlldC5cblx0ICovXG5cdHByaXZhdGUgZGVsZXRlWWFua2VkVGV4dCgpOiB2b2lkIHtcblx0XHRjb25zdCB5YW5rZWRUZXh0ID0gdGhpcy5raWxsUmluZy5wZWVrKCk7XG5cdFx0aWYgKCF5YW5rZWRUZXh0KSByZXR1cm47XG5cblx0XHRjb25zdCB5YW5rTGluZXMgPSB5YW5rZWRUZXh0LnNwbGl0KFwiXFxuXCIpO1xuXG5cdFx0aWYgKHlhbmtMaW5lcy5sZW5ndGggPT09IDEpIHtcblx0XHRcdC8vIFNpbmdsZSBsaW5lIC0gZGVsZXRlIGJhY2t3YXJkIGZyb20gY3Vyc29yXG5cdFx0XHRjb25zdCBjdXJyZW50TGluZSA9IHRoaXMuc3RhdGUubGluZXNbdGhpcy5zdGF0ZS5jdXJzb3JMaW5lXSB8fCBcIlwiO1xuXHRcdFx0Y29uc3QgZGVsZXRlTGVuID0geWFua2VkVGV4dC5sZW5ndGg7XG5cdFx0XHRjb25zdCBiZWZvcmUgPSBjdXJyZW50TGluZS5zbGljZSgwLCB0aGlzLnN0YXRlLmN1cnNvckNvbCAtIGRlbGV0ZUxlbik7XG5cdFx0XHRjb25zdCBhZnRlciA9IGN1cnJlbnRMaW5lLnNsaWNlKHRoaXMuc3RhdGUuY3Vyc29yQ29sKTtcblx0XHRcdHRoaXMuc3RhdGUubGluZXNbdGhpcy5zdGF0ZS5jdXJzb3JMaW5lXSA9IGJlZm9yZSArIGFmdGVyO1xuXHRcdFx0dGhpcy5zZXRDdXJzb3JDb2wodGhpcy5zdGF0ZS5jdXJzb3JDb2wgLSBkZWxldGVMZW4pO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHQvLyBNdWx0aS1saW5lIGRlbGV0ZSAtIGN1cnNvciBpcyBhdCBlbmQgb2YgbGFzdCB5YW5rZWQgbGluZVxuXHRcdFx0Y29uc3Qgc3RhcnRMaW5lID0gdGhpcy5zdGF0ZS5jdXJzb3JMaW5lIC0gKHlhbmtMaW5lcy5sZW5ndGggLSAxKTtcblx0XHRcdGNvbnN0IHN0YXJ0Q29sID0gKHRoaXMuc3RhdGUubGluZXNbc3RhcnRMaW5lXSB8fCBcIlwiKS5sZW5ndGggLSAoeWFua0xpbmVzWzBdIHx8IFwiXCIpLmxlbmd0aDtcblxuXHRcdFx0Ly8gR2V0IHRleHQgYWZ0ZXIgY3Vyc29yIG9uIGN1cnJlbnQgbGluZVxuXHRcdFx0Y29uc3QgYWZ0ZXJDdXJzb3IgPSAodGhpcy5zdGF0ZS5saW5lc1t0aGlzLnN0YXRlLmN1cnNvckxpbmVdIHx8IFwiXCIpLnNsaWNlKHRoaXMuc3RhdGUuY3Vyc29yQ29sKTtcblxuXHRcdFx0Ly8gR2V0IHRleHQgYmVmb3JlIHlhbmsgc3RhcnQgcG9zaXRpb25cblx0XHRcdGNvbnN0IGJlZm9yZVlhbmsgPSAodGhpcy5zdGF0ZS5saW5lc1tzdGFydExpbmVdIHx8IFwiXCIpLnNsaWNlKDAsIHN0YXJ0Q29sKTtcblxuXHRcdFx0Ly8gUmVtb3ZlIGFsbCBsaW5lcyBmcm9tIHN0YXJ0TGluZSB0byBjdXJzb3JMaW5lIGFuZCByZXBsYWNlIHdpdGggbWVyZ2VkIGxpbmVcblx0XHRcdHRoaXMuc3RhdGUubGluZXMuc3BsaWNlKHN0YXJ0TGluZSwgeWFua0xpbmVzLmxlbmd0aCwgYmVmb3JlWWFuayArIGFmdGVyQ3Vyc29yKTtcblxuXHRcdFx0Ly8gVXBkYXRlIGN1cnNvclxuXHRcdFx0dGhpcy5zdGF0ZS5jdXJzb3JMaW5lID0gc3RhcnRMaW5lO1xuXHRcdFx0dGhpcy5zZXRDdXJzb3JDb2woc3RhcnRDb2wpO1xuXHRcdH1cblxuXHRcdHRoaXMuZW1pdENoYW5nZSgpO1xuXHR9XG5cblx0cHJpdmF0ZSBwdXNoVW5kb1NuYXBzaG90KCk6IHZvaWQge1xuXHRcdHRoaXMudW5kb1N0YWNrLnB1c2godGhpcy5zdGF0ZSk7XG5cdH1cblxuXHRwcml2YXRlIHVuZG8oKTogdm9pZCB7XG5cdFx0dGhpcy5oaXN0b3J5SW5kZXggPSAtMTsgLy8gRXhpdCBoaXN0b3J5IGJyb3dzaW5nIG1vZGVcblx0XHRjb25zdCBzbmFwc2hvdCA9IHRoaXMudW5kb1N0YWNrLnBvcCgpO1xuXHRcdGlmICghc25hcHNob3QpIHJldHVybjtcblx0XHRPYmplY3QuYXNzaWduKHRoaXMuc3RhdGUsIHNuYXBzaG90KTtcblx0XHR0aGlzLmxhc3RBY3Rpb24gPSBudWxsO1xuXHRcdHRoaXMucHJlZmVycmVkVmlzdWFsQ29sID0gbnVsbDtcblx0XHR0aGlzLmVtaXRDaGFuZ2UoKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBKdW1wIHRvIHRoZSBmaXJzdCBvY2N1cnJlbmNlIG9mIGEgY2hhcmFjdGVyIGluIHRoZSBzcGVjaWZpZWQgZGlyZWN0aW9uLlxuXHQgKiBNdWx0aS1saW5lIHNlYXJjaC4gQ2FzZS1zZW5zaXRpdmUuIFNraXBzIHRoZSBjdXJyZW50IGN1cnNvciBwb3NpdGlvbi5cblx0ICovXG5cdHByaXZhdGUganVtcFRvQ2hhcihjaGFyOiBzdHJpbmcsIGRpcmVjdGlvbjogXCJmb3J3YXJkXCIgfCBcImJhY2t3YXJkXCIpOiB2b2lkIHtcblx0XHR0aGlzLmxhc3RBY3Rpb24gPSBudWxsO1xuXHRcdGNvbnN0IGlzRm9yd2FyZCA9IGRpcmVjdGlvbiA9PT0gXCJmb3J3YXJkXCI7XG5cdFx0Y29uc3QgbGluZXMgPSB0aGlzLnN0YXRlLmxpbmVzO1xuXG5cdFx0Y29uc3QgZW5kID0gaXNGb3J3YXJkID8gbGluZXMubGVuZ3RoIDogLTE7XG5cdFx0Y29uc3Qgc3RlcCA9IGlzRm9yd2FyZCA/IDEgOiAtMTtcblxuXHRcdGZvciAobGV0IGxpbmVJZHggPSB0aGlzLnN0YXRlLmN1cnNvckxpbmU7IGxpbmVJZHggIT09IGVuZDsgbGluZUlkeCArPSBzdGVwKSB7XG5cdFx0XHRjb25zdCBsaW5lID0gbGluZXNbbGluZUlkeF0gfHwgXCJcIjtcblx0XHRcdGNvbnN0IGlzQ3VycmVudExpbmUgPSBsaW5lSWR4ID09PSB0aGlzLnN0YXRlLmN1cnNvckxpbmU7XG5cblx0XHRcdC8vIEN1cnJlbnQgbGluZTogc3RhcnQgYWZ0ZXIvYmVmb3JlIGN1cnNvcjsgb3RoZXIgbGluZXM6IHNlYXJjaCBmdWxsIGxpbmVcblx0XHRcdGNvbnN0IHNlYXJjaEZyb20gPSBpc0N1cnJlbnRMaW5lXG5cdFx0XHRcdD8gaXNGb3J3YXJkXG5cdFx0XHRcdFx0PyB0aGlzLnN0YXRlLmN1cnNvckNvbCArIDFcblx0XHRcdFx0XHQ6IHRoaXMuc3RhdGUuY3Vyc29yQ29sIC0gMVxuXHRcdFx0XHQ6IHVuZGVmaW5lZDtcblxuXHRcdFx0Y29uc3QgaWR4ID0gaXNGb3J3YXJkID8gbGluZS5pbmRleE9mKGNoYXIsIHNlYXJjaEZyb20pIDogbGluZS5sYXN0SW5kZXhPZihjaGFyLCBzZWFyY2hGcm9tKTtcblxuXHRcdFx0aWYgKGlkeCAhPT0gLTEpIHtcblx0XHRcdFx0dGhpcy5zdGF0ZS5jdXJzb3JMaW5lID0gbGluZUlkeDtcblx0XHRcdFx0dGhpcy5zZXRDdXJzb3JDb2woaWR4KTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXHRcdH1cblx0XHQvLyBObyBtYXRjaCBmb3VuZCAtIGN1cnNvciBzdGF5cyBpbiBwbGFjZVxuXHR9XG5cblx0cHJpdmF0ZSBtb3ZlV29yZEZvcndhcmRzKCk6IHZvaWQge1xuXHRcdHRoaXMubGFzdEFjdGlvbiA9IG51bGw7XG5cdFx0Y29uc3QgY3VycmVudExpbmUgPSB0aGlzLnN0YXRlLmxpbmVzW3RoaXMuc3RhdGUuY3Vyc29yTGluZV0gfHwgXCJcIjtcblxuXHRcdC8vIElmIGF0IGVuZCBvZiBsaW5lLCBtb3ZlIHRvIHN0YXJ0IG9mIG5leHQgbGluZVxuXHRcdGlmICh0aGlzLnN0YXRlLmN1cnNvckNvbCA+PSBjdXJyZW50TGluZS5sZW5ndGgpIHtcblx0XHRcdGlmICh0aGlzLnN0YXRlLmN1cnNvckxpbmUgPCB0aGlzLnN0YXRlLmxpbmVzLmxlbmd0aCAtIDEpIHtcblx0XHRcdFx0dGhpcy5zdGF0ZS5jdXJzb3JMaW5lKys7XG5cdFx0XHRcdHRoaXMuc2V0Q3Vyc29yQ29sKDApO1xuXHRcdFx0fVxuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGNvbnN0IHRleHRBZnRlckN1cnNvciA9IGN1cnJlbnRMaW5lLnNsaWNlKHRoaXMuc3RhdGUuY3Vyc29yQ29sKTtcblx0XHRjb25zdCBzZWdtZW50cyA9IHNlZ21lbnRlci5zZWdtZW50KHRleHRBZnRlckN1cnNvcik7XG5cdFx0Y29uc3QgaXRlcmF0b3IgPSBzZWdtZW50c1tTeW1ib2wuaXRlcmF0b3JdKCk7XG5cdFx0bGV0IG5leHQgPSBpdGVyYXRvci5uZXh0KCk7XG5cdFx0bGV0IG5ld0NvbCA9IHRoaXMuc3RhdGUuY3Vyc29yQ29sO1xuXG5cdFx0Ly8gU2tpcCBsZWFkaW5nIHdoaXRlc3BhY2Vcblx0XHR3aGlsZSAoIW5leHQuZG9uZSAmJiBpc1doaXRlc3BhY2VDaGFyKG5leHQudmFsdWUuc2VnbWVudCkpIHtcblx0XHRcdG5ld0NvbCArPSBuZXh0LnZhbHVlLnNlZ21lbnQubGVuZ3RoO1xuXHRcdFx0bmV4dCA9IGl0ZXJhdG9yLm5leHQoKTtcblx0XHR9XG5cblx0XHRpZiAoIW5leHQuZG9uZSkge1xuXHRcdFx0Y29uc3QgZmlyc3RHcmFwaGVtZSA9IG5leHQudmFsdWUuc2VnbWVudDtcblx0XHRcdGlmIChpc1B1bmN0dWF0aW9uQ2hhcihmaXJzdEdyYXBoZW1lKSkge1xuXHRcdFx0XHQvLyBTa2lwIHB1bmN0dWF0aW9uIHJ1blxuXHRcdFx0XHR3aGlsZSAoIW5leHQuZG9uZSAmJiBpc1B1bmN0dWF0aW9uQ2hhcihuZXh0LnZhbHVlLnNlZ21lbnQpKSB7XG5cdFx0XHRcdFx0bmV3Q29sICs9IG5leHQudmFsdWUuc2VnbWVudC5sZW5ndGg7XG5cdFx0XHRcdFx0bmV4dCA9IGl0ZXJhdG9yLm5leHQoKTtcblx0XHRcdFx0fVxuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0Ly8gU2tpcCB3b3JkIHJ1blxuXHRcdFx0XHR3aGlsZSAoIW5leHQuZG9uZSAmJiAhaXNXaGl0ZXNwYWNlQ2hhcihuZXh0LnZhbHVlLnNlZ21lbnQpICYmICFpc1B1bmN0dWF0aW9uQ2hhcihuZXh0LnZhbHVlLnNlZ21lbnQpKSB7XG5cdFx0XHRcdFx0bmV3Q29sICs9IG5leHQudmFsdWUuc2VnbWVudC5sZW5ndGg7XG5cdFx0XHRcdFx0bmV4dCA9IGl0ZXJhdG9yLm5leHQoKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH1cblxuXHRcdHRoaXMuc2V0Q3Vyc29yQ29sKG5ld0NvbCk7XG5cdH1cblxuXHQvLyBTbGFzaCBtZW51IG9ubHkgYWxsb3dlZCBvbiB0aGUgZmlyc3QgbGluZSBvZiB0aGUgZWRpdG9yXG5cdHByaXZhdGUgaXNTbGFzaE1lbnVBbGxvd2VkKCk6IGJvb2xlYW4ge1xuXHRcdHJldHVybiB0aGlzLnN0YXRlLmN1cnNvckxpbmUgPT09IDA7XG5cdH1cblxuXHQvLyBIZWxwZXIgbWV0aG9kIHRvIGNoZWNrIGlmIGN1cnNvciBpcyBhdCBzdGFydCBvZiBtZXNzYWdlIChmb3Igc2xhc2ggY29tbWFuZCBkZXRlY3Rpb24pXG5cdHByaXZhdGUgaXNBdFN0YXJ0T2ZNZXNzYWdlKCk6IGJvb2xlYW4ge1xuXHRcdGlmICghdGhpcy5pc1NsYXNoTWVudUFsbG93ZWQoKSkgcmV0dXJuIGZhbHNlO1xuXHRcdGNvbnN0IGN1cnJlbnRMaW5lID0gdGhpcy5zdGF0ZS5saW5lc1t0aGlzLnN0YXRlLmN1cnNvckxpbmVdIHx8IFwiXCI7XG5cdFx0Y29uc3QgYmVmb3JlQ3Vyc29yID0gY3VycmVudExpbmUuc2xpY2UoMCwgdGhpcy5zdGF0ZS5jdXJzb3JDb2wpO1xuXHRcdHJldHVybiBiZWZvcmVDdXJzb3IudHJpbSgpID09PSBcIlwiIHx8IGJlZm9yZUN1cnNvci50cmltKCkgPT09IFwiL1wiO1xuXHR9XG5cblx0cHJpdmF0ZSBpc0luU2xhc2hDb21tYW5kQ29udGV4dCh0ZXh0QmVmb3JlQ3Vyc29yOiBzdHJpbmcpOiBib29sZWFuIHtcblx0XHRyZXR1cm4gdGhpcy5pc1NsYXNoTWVudUFsbG93ZWQoKSAmJiB0ZXh0QmVmb3JlQ3Vyc29yLnRyaW1TdGFydCgpLnN0YXJ0c1dpdGgoXCIvXCIpO1xuXHR9XG5cblx0cHJpdmF0ZSBzaG91bGRDaGFpblNsYXNoQXJndW1lbnRBdXRvY29tcGxldGVPblRhYlNlbGVjdGlvbigpOiBib29sZWFuIHtcblx0XHRpZiAodGhpcy5hdXRvY29tcGxldGVTdGF0ZSAhPT0gXCJyZWd1bGFyXCIpIHtcblx0XHRcdHJldHVybiBmYWxzZTtcblx0XHR9XG5cblx0XHRjb25zdCBjdXJyZW50TGluZSA9IHRoaXMuc3RhdGUubGluZXNbdGhpcy5zdGF0ZS5jdXJzb3JMaW5lXSB8fCBcIlwiO1xuXHRcdGNvbnN0IHRleHRCZWZvcmVDdXJzb3IgPSBjdXJyZW50TGluZS5zbGljZSgwLCB0aGlzLnN0YXRlLmN1cnNvckNvbCk7XG5cdFx0cmV0dXJuIHRoaXMuaXNJblNsYXNoQ29tbWFuZENvbnRleHQodGV4dEJlZm9yZUN1cnNvcikgJiYgIXRleHRCZWZvcmVDdXJzb3IudHJpbVN0YXJ0KCkuaW5jbHVkZXMoXCIgXCIpO1xuXHR9XG5cblx0cHJpdmF0ZSBpc0JhcmVDb21wbGV0ZWRTbGFzaENvbW1hbmRBdEN1cnNvcigpOiBib29sZWFuIHtcblx0XHRjb25zdCBjdXJyZW50TGluZSA9IHRoaXMuc3RhdGUubGluZXNbdGhpcy5zdGF0ZS5jdXJzb3JMaW5lXSB8fCBcIlwiO1xuXHRcdGlmICh0aGlzLnN0YXRlLmN1cnNvckNvbCAhPT0gY3VycmVudExpbmUubGVuZ3RoKSB7XG5cdFx0XHRyZXR1cm4gZmFsc2U7XG5cdFx0fVxuXG5cdFx0Y29uc3QgdGV4dEJlZm9yZUN1cnNvciA9IGN1cnJlbnRMaW5lLnNsaWNlKDAsIHRoaXMuc3RhdGUuY3Vyc29yQ29sKS50cmltU3RhcnQoKTtcblx0XHRyZXR1cm4gL15cXC9cXFMrICQvLnRlc3QodGV4dEJlZm9yZUN1cnNvcik7XG5cdH1cblxuXHQvLyBBdXRvY29tcGxldGUgbWV0aG9kc1xuXHQvKipcblx0ICogRmluZCB0aGUgYmVzdCBhdXRvY29tcGxldGUgaXRlbSBpbmRleCBmb3IgdGhlIGdpdmVuIHByZWZpeC5cblx0ICogUmV0dXJucyAtMSBpZiBubyBtYXRjaCBpcyBmb3VuZC5cblx0ICpcblx0ICogTWF0Y2ggcHJpb3JpdHk6XG5cdCAqIDEuIEV4YWN0IG1hdGNoIChwcmVmaXggPT09IGl0ZW0udmFsdWUpIC0+IGFsd2F5cyBzZWxlY3RlZFxuXHQgKiAyLiBQcmVmaXggbWF0Y2ggLT4gZmlyc3QgaXRlbSB3aG9zZSB2YWx1ZSBzdGFydHMgd2l0aCBwcmVmaXhcblx0ICogMy4gTm8gbWF0Y2ggLT4gLTEgKGtlZXAgZGVmYXVsdCBoaWdobGlnaHQpXG5cdCAqXG5cdCAqIE1hdGNoaW5nIGlzIGNhc2Utc2Vuc2l0aXZlIGFuZCBjaGVja3MgaXRlbS52YWx1ZSBvbmx5LlxuXHQgKi9cblx0cHJpdmF0ZSBnZXRCZXN0QXV0b2NvbXBsZXRlTWF0Y2hJbmRleChpdGVtczogQXJyYXk8eyB2YWx1ZTogc3RyaW5nOyBsYWJlbDogc3RyaW5nIH0+LCBwcmVmaXg6IHN0cmluZyk6IG51bWJlciB7XG5cdFx0aWYgKCFwcmVmaXgpIHJldHVybiAtMTtcblxuXHRcdGxldCBmaXJzdFByZWZpeEluZGV4ID0gLTE7XG5cblx0XHRmb3IgKGxldCBpID0gMDsgaSA8IGl0ZW1zLmxlbmd0aDsgaSsrKSB7XG5cdFx0XHRjb25zdCB2YWx1ZSA9IGl0ZW1zW2ldIS52YWx1ZTtcblx0XHRcdGlmICh2YWx1ZSA9PT0gcHJlZml4KSB7XG5cdFx0XHRcdHJldHVybiBpOyAvLyBFeGFjdCBtYXRjaCBhbHdheXMgd2luc1xuXHRcdFx0fVxuXHRcdFx0aWYgKGZpcnN0UHJlZml4SW5kZXggPT09IC0xICYmIHZhbHVlLnN0YXJ0c1dpdGgocHJlZml4KSkge1xuXHRcdFx0XHRmaXJzdFByZWZpeEluZGV4ID0gaTtcblx0XHRcdH1cblx0XHR9XG5cblx0XHRyZXR1cm4gZmlyc3RQcmVmaXhJbmRleDtcblx0fVxuXG5cdHByaXZhdGUgdHJ5VHJpZ2dlckF1dG9jb21wbGV0ZShleHBsaWNpdFRhYjogYm9vbGVhbiA9IGZhbHNlKTogdm9pZCB7XG5cdFx0aWYgKCF0aGlzLmF1dG9jb21wbGV0ZVByb3ZpZGVyKSByZXR1cm47XG5cblx0XHQvLyBDaGVjayBpZiB3ZSBzaG91bGQgdHJpZ2dlciBmaWxlIGNvbXBsZXRpb24gb24gVGFiXG5cdFx0aWYgKGV4cGxpY2l0VGFiKSB7XG5cdFx0XHRjb25zdCBwcm92aWRlciA9IHRoaXMuYXV0b2NvbXBsZXRlUHJvdmlkZXIgYXMgQ29tYmluZWRBdXRvY29tcGxldGVQcm92aWRlcjtcblx0XHRcdGNvbnN0IHNob3VsZFRyaWdnZXIgPVxuXHRcdFx0XHQhcHJvdmlkZXIuc2hvdWxkVHJpZ2dlckZpbGVDb21wbGV0aW9uIHx8XG5cdFx0XHRcdHByb3ZpZGVyLnNob3VsZFRyaWdnZXJGaWxlQ29tcGxldGlvbih0aGlzLnN0YXRlLmxpbmVzLCB0aGlzLnN0YXRlLmN1cnNvckxpbmUsIHRoaXMuc3RhdGUuY3Vyc29yQ29sKTtcblx0XHRcdGlmICghc2hvdWxkVHJpZ2dlcikge1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0Y29uc3Qgc3VnZ2VzdGlvbnMgPSB0aGlzLmF1dG9jb21wbGV0ZVByb3ZpZGVyLmdldFN1Z2dlc3Rpb25zKFxuXHRcdFx0dGhpcy5zdGF0ZS5saW5lcyxcblx0XHRcdHRoaXMuc3RhdGUuY3Vyc29yTGluZSxcblx0XHRcdHRoaXMuc3RhdGUuY3Vyc29yQ29sLFxuXHRcdCk7XG5cblx0XHRpZiAoc3VnZ2VzdGlvbnMgJiYgc3VnZ2VzdGlvbnMuaXRlbXMubGVuZ3RoID4gMCkge1xuXHRcdFx0dGhpcy5hdXRvY29tcGxldGVQcmVmaXggPSBzdWdnZXN0aW9ucy5wcmVmaXg7XG5cdFx0XHR0aGlzLmF1dG9jb21wbGV0ZUxpc3QgPSBuZXcgU2VsZWN0TGlzdChzdWdnZXN0aW9ucy5pdGVtcywgdGhpcy5hdXRvY29tcGxldGVNYXhWaXNpYmxlLCB0aGlzLnRoZW1lLnNlbGVjdExpc3QpO1xuXG5cdFx0XHQvLyBJZiB0eXBlZCBwcmVmaXggZXhhY3RseSBtYXRjaGVzIG9uZSBvZiB0aGUgc3VnZ2VzdGlvbnMsIHNlbGVjdCB0aGF0IGl0ZW1cblx0XHRcdGNvbnN0IGJlc3RNYXRjaEluZGV4ID0gdGhpcy5nZXRCZXN0QXV0b2NvbXBsZXRlTWF0Y2hJbmRleChzdWdnZXN0aW9ucy5pdGVtcywgc3VnZ2VzdGlvbnMucHJlZml4KTtcblx0XHRcdGlmIChiZXN0TWF0Y2hJbmRleCA+PSAwKSB7XG5cdFx0XHRcdHRoaXMuYXV0b2NvbXBsZXRlTGlzdC5zZXRTZWxlY3RlZEluZGV4KGJlc3RNYXRjaEluZGV4KTtcblx0XHRcdH1cblxuXHRcdFx0dGhpcy5hdXRvY29tcGxldGVTdGF0ZSA9IFwicmVndWxhclwiO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHR0aGlzLmNhbmNlbEF1dG9jb21wbGV0ZSgpO1xuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgaGFuZGxlVGFiQ29tcGxldGlvbigpOiB2b2lkIHtcblx0XHRpZiAoIXRoaXMuYXV0b2NvbXBsZXRlUHJvdmlkZXIpIHJldHVybjtcblxuXHRcdGNvbnN0IGN1cnJlbnRMaW5lID0gdGhpcy5zdGF0ZS5saW5lc1t0aGlzLnN0YXRlLmN1cnNvckxpbmVdIHx8IFwiXCI7XG5cdFx0Y29uc3QgYmVmb3JlQ3Vyc29yID0gY3VycmVudExpbmUuc2xpY2UoMCwgdGhpcy5zdGF0ZS5jdXJzb3JDb2wpO1xuXG5cdFx0Ly8gQ2hlY2sgaWYgd2UncmUgaW4gYSBzbGFzaCBjb21tYW5kIGNvbnRleHRcblx0XHRpZiAodGhpcy5pc0luU2xhc2hDb21tYW5kQ29udGV4dChiZWZvcmVDdXJzb3IpICYmICFiZWZvcmVDdXJzb3IudHJpbVN0YXJ0KCkuaW5jbHVkZXMoXCIgXCIpKSB7XG5cdFx0XHR0aGlzLmhhbmRsZVNsYXNoQ29tbWFuZENvbXBsZXRpb24oKTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0dGhpcy5mb3JjZUZpbGVBdXRvY29tcGxldGUodHJ1ZSk7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBoYW5kbGVTbGFzaENvbW1hbmRDb21wbGV0aW9uKCk6IHZvaWQge1xuXHRcdHRoaXMudHJ5VHJpZ2dlckF1dG9jb21wbGV0ZSh0cnVlKTtcblx0fVxuXG5cdC8qXG5odHRwczovL2dpdGh1Yi5jb20vRXNvdGVyaWNTb2Z0d2FyZS9zcGluZS1ydW50aW1lcy9hY3Rpb25zL3J1bnMvMTk1MzY2NDM0MTYvam9iLzU1OTMyMjg4M1xuMTcgdGhpcyBqb2IgZmFpbHMgd2l0aCBodHRwczovL2dpdGh1Yi5jb20vRXNvdGVyaWNTb2Z0d2FyZS9zcGluZS1ydW50aW1lcy9hY3Rpb25zL3J1bnMvMTlcbjUzNjY0MzQxNi9qb2IvNTU5MzIyODgzMTcgaGF2ZWEgIGxvb2sgYXQgLmdpXG5cdCAqL1xuXHRwcml2YXRlIGZvcmNlRmlsZUF1dG9jb21wbGV0ZShleHBsaWNpdFRhYjogYm9vbGVhbiA9IGZhbHNlKTogdm9pZCB7XG5cdFx0aWYgKCF0aGlzLmF1dG9jb21wbGV0ZVByb3ZpZGVyKSByZXR1cm47XG5cblx0XHQvLyBDaGVjayBpZiBwcm92aWRlciBzdXBwb3J0cyBmb3JjZSBmaWxlIHN1Z2dlc3Rpb25zIHZpYSBydW50aW1lIGNoZWNrXG5cdFx0Y29uc3QgcHJvdmlkZXIgPSB0aGlzLmF1dG9jb21wbGV0ZVByb3ZpZGVyIGFzIHtcblx0XHRcdGdldEZvcmNlRmlsZVN1Z2dlc3Rpb25zPzogQ29tYmluZWRBdXRvY29tcGxldGVQcm92aWRlcltcImdldEZvcmNlRmlsZVN1Z2dlc3Rpb25zXCJdO1xuXHRcdH07XG5cdFx0aWYgKHR5cGVvZiBwcm92aWRlci5nZXRGb3JjZUZpbGVTdWdnZXN0aW9ucyAhPT0gXCJmdW5jdGlvblwiKSB7XG5cdFx0XHR0aGlzLnRyeVRyaWdnZXJBdXRvY29tcGxldGUodHJ1ZSk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Y29uc3Qgc3VnZ2VzdGlvbnMgPSBwcm92aWRlci5nZXRGb3JjZUZpbGVTdWdnZXN0aW9ucyhcblx0XHRcdHRoaXMuc3RhdGUubGluZXMsXG5cdFx0XHR0aGlzLnN0YXRlLmN1cnNvckxpbmUsXG5cdFx0XHR0aGlzLnN0YXRlLmN1cnNvckNvbCxcblx0XHQpO1xuXG5cdFx0aWYgKHN1Z2dlc3Rpb25zICYmIHN1Z2dlc3Rpb25zLml0ZW1zLmxlbmd0aCA+IDApIHtcblx0XHRcdC8vIElmIHRoZXJlJ3MgZXhhY3RseSBvbmUgc3VnZ2VzdGlvbiwgYXBwbHkgaXQgaW1tZWRpYXRlbHlcblx0XHRcdGlmIChleHBsaWNpdFRhYiAmJiBzdWdnZXN0aW9ucy5pdGVtcy5sZW5ndGggPT09IDEpIHtcblx0XHRcdFx0Y29uc3QgaXRlbSA9IHN1Z2dlc3Rpb25zLml0ZW1zWzBdITtcblx0XHRcdFx0dGhpcy5wdXNoVW5kb1NuYXBzaG90KCk7XG5cdFx0XHRcdHRoaXMubGFzdEFjdGlvbiA9IG51bGw7XG5cdFx0XHRcdGNvbnN0IHJlc3VsdCA9IHRoaXMuYXV0b2NvbXBsZXRlUHJvdmlkZXIuYXBwbHlDb21wbGV0aW9uKFxuXHRcdFx0XHRcdHRoaXMuc3RhdGUubGluZXMsXG5cdFx0XHRcdFx0dGhpcy5zdGF0ZS5jdXJzb3JMaW5lLFxuXHRcdFx0XHRcdHRoaXMuc3RhdGUuY3Vyc29yQ29sLFxuXHRcdFx0XHRcdGl0ZW0sXG5cdFx0XHRcdFx0c3VnZ2VzdGlvbnMucHJlZml4LFxuXHRcdFx0XHQpO1xuXHRcdFx0XHR0aGlzLnN0YXRlLmxpbmVzID0gcmVzdWx0LmxpbmVzO1xuXHRcdFx0XHR0aGlzLnN0YXRlLmN1cnNvckxpbmUgPSByZXN1bHQuY3Vyc29yTGluZTtcblx0XHRcdFx0dGhpcy5zZXRDdXJzb3JDb2wocmVzdWx0LmN1cnNvckNvbCk7XG5cdFx0XHRcdHRoaXMuZW1pdENoYW5nZSgpO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cblx0XHRcdHRoaXMuYXV0b2NvbXBsZXRlUHJlZml4ID0gc3VnZ2VzdGlvbnMucHJlZml4O1xuXHRcdFx0dGhpcy5hdXRvY29tcGxldGVMaXN0ID0gbmV3IFNlbGVjdExpc3Qoc3VnZ2VzdGlvbnMuaXRlbXMsIHRoaXMuYXV0b2NvbXBsZXRlTWF4VmlzaWJsZSwgdGhpcy50aGVtZS5zZWxlY3RMaXN0KTtcblxuXHRcdFx0Ly8gSWYgdHlwZWQgcHJlZml4IGV4YWN0bHkgbWF0Y2hlcyBvbmUgb2YgdGhlIHN1Z2dlc3Rpb25zLCBzZWxlY3QgdGhhdCBpdGVtXG5cdFx0XHRjb25zdCBiZXN0TWF0Y2hJbmRleCA9IHRoaXMuZ2V0QmVzdEF1dG9jb21wbGV0ZU1hdGNoSW5kZXgoc3VnZ2VzdGlvbnMuaXRlbXMsIHN1Z2dlc3Rpb25zLnByZWZpeCk7XG5cdFx0XHRpZiAoYmVzdE1hdGNoSW5kZXggPj0gMCkge1xuXHRcdFx0XHR0aGlzLmF1dG9jb21wbGV0ZUxpc3Quc2V0U2VsZWN0ZWRJbmRleChiZXN0TWF0Y2hJbmRleCk7XG5cdFx0XHR9XG5cblx0XHRcdHRoaXMuYXV0b2NvbXBsZXRlU3RhdGUgPSBcImZvcmNlXCI7XG5cdFx0fSBlbHNlIHtcblx0XHRcdHRoaXMuY2FuY2VsQXV0b2NvbXBsZXRlKCk7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBjYW5jZWxBdXRvY29tcGxldGUoKTogdm9pZCB7XG5cdFx0dGhpcy5hdXRvY29tcGxldGVTdGF0ZSA9IG51bGw7XG5cdFx0dGhpcy5hdXRvY29tcGxldGVMaXN0ID0gdW5kZWZpbmVkO1xuXHRcdHRoaXMuYXV0b2NvbXBsZXRlUHJlZml4ID0gXCJcIjtcblx0XHR0aGlzLmNsZWFyQXV0b2NvbXBsZXRlRGVib3VuY2UoKTtcblx0fVxuXG5cdHByaXZhdGUgY2xlYXJBdXRvY29tcGxldGVEZWJvdW5jZSgpOiB2b2lkIHtcblx0XHRpZiAodGhpcy5hdXRvY29tcGxldGVEZWJvdW5jZVRpbWVyKSB7XG5cdFx0XHRjbGVhclRpbWVvdXQodGhpcy5hdXRvY29tcGxldGVEZWJvdW5jZVRpbWVyKTtcblx0XHRcdHRoaXMuYXV0b2NvbXBsZXRlRGVib3VuY2VUaW1lciA9IG51bGw7XG5cdFx0fVxuXHRcdHRoaXMubGFzdEF1dG9jb21wbGV0ZUxvb2t1cFByZWZpeCA9IG51bGw7XG5cdH1cblxuXHRwdWJsaWMgZGlzcG9zZSgpOiB2b2lkIHtcblx0XHR0aGlzLmNsZWFyQXV0b2NvbXBsZXRlRGVib3VuY2UoKTtcblx0fVxuXG5cdHB1YmxpYyBpc1Nob3dpbmdBdXRvY29tcGxldGUoKTogYm9vbGVhbiB7XG5cdFx0cmV0dXJuIHRoaXMuYXV0b2NvbXBsZXRlU3RhdGUgIT09IG51bGw7XG5cdH1cblxuXHRwcml2YXRlIHVwZGF0ZUF1dG9jb21wbGV0ZSgpOiB2b2lkIHtcblx0XHRpZiAoIXRoaXMuYXV0b2NvbXBsZXRlU3RhdGUgfHwgIXRoaXMuYXV0b2NvbXBsZXRlUHJvdmlkZXIpIHJldHVybjtcblxuXHRcdGlmICh0aGlzLmF1dG9jb21wbGV0ZVN0YXRlID09PSBcImZvcmNlXCIpIHtcblx0XHRcdHRoaXMuZm9yY2VGaWxlQXV0b2NvbXBsZXRlKCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Ly8gQ2hlY2sgaWYgd2UncmUgaW4gYW4gQCBmaWxlIHJlZmVyZW5jZSBjb250ZXh0IFx1MjAxNCB0aGVzZSB0cmlnZ2VyIGV4cGVuc2l2ZVxuXHRcdC8vIHN5bmNocm9ub3VzIGZ1enp5RmluZCBjYWxscyB0aGF0IGJsb2NrIHRoZSBldmVudCBsb29wLiBEZWJvdW5jZSB0aGVtIHNvXG5cdFx0Ly8gcmFwaWQgdHlwaW5nIGRvZXNuJ3QgY2FzY2FkZSBpbnRvIGRvemVucyBvZiBibG9ja2luZyBzZWFyY2hlcy5cblx0XHRjb25zdCBjdXJyZW50TGluZSA9IHRoaXMuc3RhdGUubGluZXNbdGhpcy5zdGF0ZS5jdXJzb3JMaW5lXSB8fCBcIlwiO1xuXHRcdGNvbnN0IHRleHRCZWZvcmVDdXJzb3IgPSBjdXJyZW50TGluZS5zbGljZSgwLCB0aGlzLnN0YXRlLmN1cnNvckNvbCk7XG5cdFx0aWYgKHRoaXMuYXV0b2NvbXBsZXRlUHJlZml4LnN0YXJ0c1dpdGgoXCJAXCIpIHx8IHRleHRCZWZvcmVDdXJzb3IubWF0Y2goLyg/Ol58W1xcc10pQFteXFxzXSokLykpIHtcblx0XHRcdHRoaXMuZGVib3VuY2VkVXBkYXRlQXV0b2NvbXBsZXRlU3VnZ2VzdGlvbnMoKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHR0aGlzLmFwcGx5QXV0b2NvbXBsZXRlU3VnZ2VzdGlvbnMoKTtcblx0fVxuXG5cdHByaXZhdGUgZGVib3VuY2VkVXBkYXRlQXV0b2NvbXBsZXRlU3VnZ2VzdGlvbnMoKTogdm9pZCB7XG5cdFx0Ly8gQ2xlYXIgYW55IHBlbmRpbmcgZGVib3VuY2Vcblx0XHRpZiAodGhpcy5hdXRvY29tcGxldGVEZWJvdW5jZVRpbWVyKSB7XG5cdFx0XHRjbGVhclRpbWVvdXQodGhpcy5hdXRvY29tcGxldGVEZWJvdW5jZVRpbWVyKTtcblx0XHRcdHRoaXMuYXV0b2NvbXBsZXRlRGVib3VuY2VUaW1lciA9IG51bGw7XG5cdFx0fVxuXG5cdFx0dGhpcy5hdXRvY29tcGxldGVEZWJvdW5jZVRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHR0aGlzLmF1dG9jb21wbGV0ZURlYm91bmNlVGltZXIgPSBudWxsO1xuXHRcdFx0Ly8gR3VhcmQ6IGF1dG9jb21wbGV0ZSBtYXkgaGF2ZSBiZWVuIGNhbmNlbGxlZCBkdXJpbmcgZGVib3VuY2Ugd2FpdFxuXHRcdFx0aWYgKCF0aGlzLmF1dG9jb21wbGV0ZVN0YXRlIHx8ICF0aGlzLmF1dG9jb21wbGV0ZVByb3ZpZGVyKSByZXR1cm47XG5cdFx0XHR0aGlzLmFwcGx5QXV0b2NvbXBsZXRlU3VnZ2VzdGlvbnMoKTtcblx0XHRcdHRoaXMudHVpLnJlcXVlc3RSZW5kZXIoKTtcblx0XHR9LCBFZGl0b3IuQVVUT0NPTVBMRVRFX0RFQk9VTkNFX01TKTtcblx0fVxuXG5cdHByaXZhdGUgYXBwbHlBdXRvY29tcGxldGVTdWdnZXN0aW9ucygpOiB2b2lkIHtcblx0XHRpZiAoIXRoaXMuYXV0b2NvbXBsZXRlUHJvdmlkZXIpIHJldHVybjtcblxuXHRcdC8vIERlZHVwbGljYXRlOiBza2lwIHRoZSAocG90ZW50aWFsbHkgZXhwZW5zaXZlIHN5bmNocm9ub3VzKSBsb29rdXBcblx0XHQvLyB3aGVuIHRoZSBwcmVmaXggaGFzbid0IGNoYW5nZWQgc2luY2UgdGhlIGxhc3QgY2FsbC5cblx0XHRjb25zdCBjdXJyZW50TGluZSA9IHRoaXMuc3RhdGUubGluZXNbdGhpcy5zdGF0ZS5jdXJzb3JMaW5lXSB8fCBcIlwiO1xuXHRcdGNvbnN0IHRleHRCZWZvcmVDdXJzb3IgPSBjdXJyZW50TGluZS5zbGljZSgwLCB0aGlzLnN0YXRlLmN1cnNvckNvbCk7XG5cdFx0aWYgKHRoaXMubGFzdEF1dG9jb21wbGV0ZUxvb2t1cFByZWZpeCAhPT0gbnVsbCAmJiB0aGlzLmxhc3RBdXRvY29tcGxldGVMb29rdXBQcmVmaXggPT09IHRleHRCZWZvcmVDdXJzb3IpIHtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cdFx0dGhpcy5sYXN0QXV0b2NvbXBsZXRlTG9va3VwUHJlZml4ID0gdGV4dEJlZm9yZUN1cnNvcjtcblxuXHRcdGNvbnN0IHN1Z2dlc3Rpb25zID0gdGhpcy5hdXRvY29tcGxldGVQcm92aWRlci5nZXRTdWdnZXN0aW9ucyhcblx0XHRcdHRoaXMuc3RhdGUubGluZXMsXG5cdFx0XHR0aGlzLnN0YXRlLmN1cnNvckxpbmUsXG5cdFx0XHR0aGlzLnN0YXRlLmN1cnNvckNvbCxcblx0XHQpO1xuXHRcdGlmIChzdWdnZXN0aW9ucyAmJiBzdWdnZXN0aW9ucy5pdGVtcy5sZW5ndGggPiAwKSB7XG5cdFx0XHR0aGlzLmF1dG9jb21wbGV0ZVByZWZpeCA9IHN1Z2dlc3Rpb25zLnByZWZpeDtcblx0XHRcdC8vIEFsd2F5cyBjcmVhdGUgbmV3IFNlbGVjdExpc3QgdG8gZW5zdXJlIHVwZGF0ZVxuXHRcdFx0dGhpcy5hdXRvY29tcGxldGVMaXN0ID0gbmV3IFNlbGVjdExpc3Qoc3VnZ2VzdGlvbnMuaXRlbXMsIHRoaXMuYXV0b2NvbXBsZXRlTWF4VmlzaWJsZSwgdGhpcy50aGVtZS5zZWxlY3RMaXN0KTtcblxuXHRcdFx0Ly8gSWYgdHlwZWQgcHJlZml4IGV4YWN0bHkgbWF0Y2hlcyBvbmUgb2YgdGhlIHN1Z2dlc3Rpb25zLCBzZWxlY3QgdGhhdCBpdGVtXG5cdFx0XHRjb25zdCBiZXN0TWF0Y2hJbmRleCA9IHRoaXMuZ2V0QmVzdEF1dG9jb21wbGV0ZU1hdGNoSW5kZXgoc3VnZ2VzdGlvbnMuaXRlbXMsIHN1Z2dlc3Rpb25zLnByZWZpeCk7XG5cdFx0XHRpZiAoYmVzdE1hdGNoSW5kZXggPj0gMCkge1xuXHRcdFx0XHR0aGlzLmF1dG9jb21wbGV0ZUxpc3Quc2V0U2VsZWN0ZWRJbmRleChiZXN0TWF0Y2hJbmRleCk7XG5cdFx0XHR9XG5cdFx0fSBlbHNlIHtcblx0XHRcdHRoaXMuY2FuY2VsQXV0b2NvbXBsZXRlKCk7XG5cdFx0fVxuXHR9XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFDQSxTQUFTLDRCQUE0QjtBQUNyQyxTQUFTLHNCQUFzQixrQkFBa0I7QUFDakQsU0FBUyxnQkFBZ0I7QUFDekIsU0FBeUIscUJBQStDO0FBQ3hFLFNBQVMsaUJBQWlCO0FBQzFCLFNBQVMsY0FBYyxtQkFBbUIsa0JBQWtCLG9CQUFvQjtBQUNoRixTQUFTLGtCQUF3QztBQUVqRCxNQUFNLFlBQVksYUFBYTtBQXFCL0IsU0FBUyxhQUFhLE1BQWMsVUFBK0I7QUFDbEUsTUFBSSxDQUFDLFFBQVEsWUFBWSxHQUFHO0FBQzNCLFdBQU8sQ0FBQyxFQUFFLE1BQU0sSUFBSSxZQUFZLEdBQUcsVUFBVSxFQUFFLENBQUM7QUFBQSxFQUNqRDtBQUVBLFFBQU0sWUFBWSxhQUFhLElBQUk7QUFDbkMsTUFBSSxhQUFhLFVBQVU7QUFDMUIsV0FBTyxDQUFDLEVBQUUsTUFBTSxNQUFNLFlBQVksR0FBRyxVQUFVLEtBQUssT0FBTyxDQUFDO0FBQUEsRUFDN0Q7QUFFQSxRQUFNLFNBQXNCLENBQUM7QUFDN0IsUUFBTSxXQUFXLENBQUMsR0FBRyxVQUFVLFFBQVEsSUFBSSxDQUFDO0FBRTVDLE1BQUksZUFBZTtBQUNuQixNQUFJLGFBQWE7QUFJakIsTUFBSSxlQUFlO0FBQ25CLE1BQUksZUFBZTtBQUVuQixXQUFTLElBQUksR0FBRyxJQUFJLFNBQVMsUUFBUSxLQUFLO0FBQ3pDLFVBQU0sTUFBTSxTQUFTLENB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
