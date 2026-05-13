import { getEditorKeybindings } from "../keybindings.js";
import { decodeKittyPrintable } from "../keys.js";
import { KillRing } from "../kill-ring.js";
import { CURSOR_MARKER } from "../tui.js";
import { UndoStack } from "../undo-stack.js";
import { getSegmenter, isPunctuationChar, isWhitespaceChar, visibleWidth } from "../utils.js";
const segmenter = getSegmenter();
class Input {
  constructor() {
    this.value = "";
    this.cursor = 0;
    this.placeholder = "";
    /** When true, render obscured characters instead of the actual value. */
    this.secure = false;
    /** Focusable interface - set by TUI when focus changes */
    this._focused = false;
    // Bracketed paste mode buffering
    this.pasteBuffer = "";
    this.isInPaste = false;
    // Kill ring for Emacs-style kill/yank operations
    this.killRing = new KillRing();
    this.lastAction = null;
    // Undo support
    this.undoStack = new UndoStack();
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
  getValue() {
    return this.value;
  }
  setValue(value) {
    this.value = value;
    this.cursor = Math.min(this.cursor, value.length);
  }
  handleInput(data) {
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
        this.handlePaste(pasteContent);
        this.isInPaste = false;
        const remaining = this.pasteBuffer.substring(endIndex + 6);
        this.pasteBuffer = "";
        if (remaining) {
          this.handleInput(remaining);
        }
      }
      return;
    }
    const kb = getEditorKeybindings();
    if (kb.matches(data, "selectCancel")) {
      if (this.onEscape) this.onEscape();
      return;
    }
    if (kb.matches(data, "undo")) {
      this.undo();
      return;
    }
    if (kb.matches(data, "submit") || data === "\n") {
      if (this.onSubmit) this.onSubmit(this.value);
      return;
    }
    if (kb.matches(data, "deleteCharBackward")) {
      this.handleBackspace();
      return;
    }
    if (kb.matches(data, "deleteCharForward")) {
      this.handleForwardDelete();
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
    if (kb.matches(data, "deleteToLineStart")) {
      this.deleteToLineStart();
      return;
    }
    if (kb.matches(data, "deleteToLineEnd")) {
      this.deleteToLineEnd();
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
    if (kb.matches(data, "cursorLeft")) {
      this.lastAction = null;
      if (this.cursor > 0) {
        const beforeCursor = this.value.slice(0, this.cursor);
        const graphemes = [...segmenter.segment(beforeCursor)];
        const lastGrapheme = graphemes[graphemes.length - 1];
        this.cursor -= lastGrapheme ? lastGrapheme.segment.length : 1;
      }
      return;
    }
    if (kb.matches(data, "cursorRight")) {
      this.lastAction = null;
      if (this.cursor < this.value.length) {
        const afterCursor = this.value.slice(this.cursor);
        const graphemes = [...segmenter.segment(afterCursor)];
        const firstGrapheme = graphemes[0];
        this.cursor += firstGrapheme ? firstGrapheme.segment.length : 1;
      }
      return;
    }
    if (kb.matches(data, "cursorLineStart")) {
      this.lastAction = null;
      this.cursor = 0;
      return;
    }
    if (kb.matches(data, "cursorLineEnd")) {
      this.lastAction = null;
      this.cursor = this.value.length;
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
    const kittyPrintable = decodeKittyPrintable(data);
    if (kittyPrintable !== void 0) {
      this.insertCharacter(kittyPrintable);
      return;
    }
    const hasControlChars = [...data].some((ch) => {
      const code = ch.charCodeAt(0);
      return code < 32 || code === 127 || code >= 128 && code <= 159;
    });
    if (!hasControlChars) {
      this.insertCharacter(data);
    }
  }
  insertCharacter(char) {
    if (isWhitespaceChar(char) || this.lastAction !== "type-word") {
      this.pushUndo();
    }
    this.lastAction = "type-word";
    this.value = this.value.slice(0, this.cursor) + char + this.value.slice(this.cursor);
    this.cursor += char.length;
  }
  handleBackspace() {
    this.lastAction = null;
    if (this.cursor > 0) {
      this.pushUndo();
      const beforeCursor = this.value.slice(0, this.cursor);
      const graphemes = [...segmenter.segment(beforeCursor)];
      const lastGrapheme = graphemes[graphemes.length - 1];
      const graphemeLength = lastGrapheme ? lastGrapheme.segment.length : 1;
      this.value = this.value.slice(0, this.cursor - graphemeLength) + this.value.slice(this.cursor);
      this.cursor -= graphemeLength;
    }
  }
  handleForwardDelete() {
    this.lastAction = null;
    if (this.cursor < this.value.length) {
      this.pushUndo();
      const afterCursor = this.value.slice(this.cursor);
      const graphemes = [...segmenter.segment(afterCursor)];
      const firstGrapheme = graphemes[0];
      const graphemeLength = firstGrapheme ? firstGrapheme.segment.length : 1;
      this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + graphemeLength);
    }
  }
  deleteToLineStart() {
    if (this.cursor === 0) return;
    this.pushUndo();
    const deletedText = this.value.slice(0, this.cursor);
    this.killRing.push(deletedText, { prepend: true, accumulate: this.lastAction === "kill" });
    this.lastAction = "kill";
    this.value = this.value.slice(this.cursor);
    this.cursor = 0;
  }
  deleteToLineEnd() {
    if (this.cursor >= this.value.length) return;
    this.pushUndo();
    const deletedText = this.value.slice(this.cursor);
    this.killRing.push(deletedText, { prepend: false, accumulate: this.lastAction === "kill" });
    this.lastAction = "kill";
    this.value = this.value.slice(0, this.cursor);
  }
  deleteWordBackwards() {
    if (this.cursor === 0) return;
    const wasKill = this.lastAction === "kill";
    this.pushUndo();
    const oldCursor = this.cursor;
    this.moveWordBackwards();
    const deleteFrom = this.cursor;
    this.cursor = oldCursor;
    const deletedText = this.value.slice(deleteFrom, this.cursor);
    this.killRing.push(deletedText, { prepend: true, accumulate: wasKill });
    this.lastAction = "kill";
    this.value = this.value.slice(0, deleteFrom) + this.value.slice(this.cursor);
    this.cursor = deleteFrom;
  }
  deleteWordForward() {
    if (this.cursor >= this.value.length) return;
    const wasKill = this.lastAction === "kill";
    this.pushUndo();
    const oldCursor = this.cursor;
    this.moveWordForwards();
    const deleteTo = this.cursor;
    this.cursor = oldCursor;
    const deletedText = this.value.slice(this.cursor, deleteTo);
    this.killRing.push(deletedText, { prepend: false, accumulate: wasKill });
    this.lastAction = "kill";
    this.value = this.value.slice(0, this.cursor) + this.value.slice(deleteTo);
  }
  yank() {
    const text = this.killRing.peek();
    if (!text) return;
    this.pushUndo();
    this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
    this.cursor += text.length;
    this.lastAction = "yank";
  }
  yankPop() {
    if (this.lastAction !== "yank" || this.killRing.length <= 1) return;
    this.pushUndo();
    const prevText = this.killRing.peek() || "";
    this.value = this.value.slice(0, this.cursor - prevText.length) + this.value.slice(this.cursor);
    this.cursor -= prevText.length;
    this.killRing.rotate();
    const text = this.killRing.peek() || "";
    this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
    this.cursor += text.length;
    this.lastAction = "yank";
  }
  pushUndo() {
    this.undoStack.push({ value: this.value, cursor: this.cursor });
  }
  undo() {
    const snapshot = this.undoStack.pop();
    if (!snapshot) return;
    this.value = snapshot.value;
    this.cursor = snapshot.cursor;
    this.lastAction = null;
  }
  moveWordBackwards() {
    if (this.cursor === 0) {
      return;
    }
    this.lastAction = null;
    const textBeforeCursor = this.value.slice(0, this.cursor);
    const graphemes = [...segmenter.segment(textBeforeCursor)];
    while (graphemes.length > 0 && isWhitespaceChar(graphemes[graphemes.length - 1]?.segment || "")) {
      this.cursor -= graphemes.pop()?.segment.length || 0;
    }
    if (graphemes.length > 0) {
      const lastGrapheme = graphemes[graphemes.length - 1]?.segment || "";
      if (isPunctuationChar(lastGrapheme)) {
        while (graphemes.length > 0 && isPunctuationChar(graphemes[graphemes.length - 1]?.segment || "")) {
          this.cursor -= graphemes.pop()?.segment.length || 0;
        }
      } else {
        while (graphemes.length > 0 && !isWhitespaceChar(graphemes[graphemes.length - 1]?.segment || "") && !isPunctuationChar(graphemes[graphemes.length - 1]?.segment || "")) {
          this.cursor -= graphemes.pop()?.segment.length || 0;
        }
      }
    }
  }
  moveWordForwards() {
    if (this.cursor >= this.value.length) {
      return;
    }
    this.lastAction = null;
    const textAfterCursor = this.value.slice(this.cursor);
    const segments = segmenter.segment(textAfterCursor);
    const iterator = segments[Symbol.iterator]();
    let next = iterator.next();
    while (!next.done && isWhitespaceChar(next.value.segment)) {
      this.cursor += next.value.segment.length;
      next = iterator.next();
    }
    if (!next.done) {
      const firstGrapheme = next.value.segment;
      if (isPunctuationChar(firstGrapheme)) {
        while (!next.done && isPunctuationChar(next.value.segment)) {
          this.cursor += next.value.segment.length;
          next = iterator.next();
        }
      } else {
        while (!next.done && !isWhitespaceChar(next.value.segment) && !isPunctuationChar(next.value.segment)) {
          this.cursor += next.value.segment.length;
          next = iterator.next();
        }
      }
    }
  }
  handlePaste(pastedText) {
    this.lastAction = null;
    this.pushUndo();
    const cleanText = pastedText.replace(/\r\n/g, "").replace(/\r/g, "").replace(/\n/g, "");
    this.value = this.value.slice(0, this.cursor) + cleanText + this.value.slice(this.cursor);
    this.cursor += cleanText.length;
  }
  invalidate() {
  }
  render(width) {
    const prompt = "> ";
    const availableWidth = width - prompt.length;
    const renderValue = this.secure ? "*".repeat(this.value.length) : this.value;
    if (availableWidth <= 0) {
      return [prompt];
    }
    if (this.value === "" && this.placeholder) {
      const placeholderText = this.placeholder.slice(0, availableWidth - 1);
      const marker2 = this.focused ? CURSOR_MARKER : "";
      const cursorChar2 = "\x1B[7m \x1B[27m";
      const dimPlaceholder = `\x1B[2m${placeholderText}\x1B[22m`;
      const padding2 = " ".repeat(Math.max(0, availableWidth - visibleWidth(placeholderText) - 1));
      return [prompt + marker2 + cursorChar2 + dimPlaceholder + padding2];
    }
    let visibleText = "";
    let cursorDisplay = this.cursor;
    if (this.value.length < availableWidth) {
      visibleText = renderValue;
    } else {
      const scrollWidth = this.cursor === this.value.length ? availableWidth - 1 : availableWidth;
      const halfWidth = Math.floor(scrollWidth / 2);
      const findValidStart = (start) => {
        while (start < this.value.length) {
          const charCode = this.value.charCodeAt(start);
          if (charCode >= 56320 && charCode < 57344) {
            start++;
            continue;
          }
          break;
        }
        return start;
      };
      const findValidEnd = (end) => {
        while (end > 0) {
          const charCode = this.value.charCodeAt(end - 1);
          if (charCode >= 55296 && charCode < 56320) {
            end--;
            continue;
          }
          break;
        }
        return end;
      };
      if (this.cursor < halfWidth) {
        visibleText = renderValue.slice(0, findValidEnd(scrollWidth));
        cursorDisplay = this.cursor;
      } else if (this.cursor > this.value.length - halfWidth) {
        const start = findValidStart(this.value.length - scrollWidth);
        visibleText = renderValue.slice(start);
        cursorDisplay = this.cursor - start;
      } else {
        const start = findValidStart(this.cursor - halfWidth);
        visibleText = renderValue.slice(start, findValidEnd(start + scrollWidth));
        cursorDisplay = halfWidth;
      }
    }
    const graphemes = [...segmenter.segment(visibleText.slice(cursorDisplay))];
    const cursorGrapheme = graphemes[0];
    const beforeCursor = visibleText.slice(0, cursorDisplay);
    const atCursor = cursorGrapheme?.segment ?? " ";
    const afterCursor = visibleText.slice(cursorDisplay + atCursor.length);
    const marker = this.focused ? CURSOR_MARKER : "";
    const cursorChar = `\x1B[7m${atCursor}\x1B[27m`;
    const textWithCursor = beforeCursor + marker + cursorChar + afterCursor;
    const visualLength = visibleWidth(textWithCursor);
    const padding = " ".repeat(Math.max(0, availableWidth - visualLength));
    const line = prompt + textWithCursor + padding;
    return [line];
  }
}
export {
  Input
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktdHVpL3NyYy9jb21wb25lbnRzL2lucHV0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyBnZXRFZGl0b3JLZXliaW5kaW5ncyB9IGZyb20gXCIuLi9rZXliaW5kaW5ncy5qc1wiO1xuaW1wb3J0IHsgZGVjb2RlS2l0dHlQcmludGFibGUgfSBmcm9tIFwiLi4va2V5cy5qc1wiO1xuaW1wb3J0IHsgS2lsbFJpbmcgfSBmcm9tIFwiLi4va2lsbC1yaW5nLmpzXCI7XG5pbXBvcnQgeyB0eXBlIENvbXBvbmVudCwgQ1VSU09SX01BUktFUiwgdHlwZSBGb2N1c2FibGUgfSBmcm9tIFwiLi4vdHVpLmpzXCI7XG5pbXBvcnQgeyBVbmRvU3RhY2sgfSBmcm9tIFwiLi4vdW5kby1zdGFjay5qc1wiO1xuaW1wb3J0IHsgZ2V0U2VnbWVudGVyLCBpc1B1bmN0dWF0aW9uQ2hhciwgaXNXaGl0ZXNwYWNlQ2hhciwgdmlzaWJsZVdpZHRoIH0gZnJvbSBcIi4uL3V0aWxzLmpzXCI7XG5cbmNvbnN0IHNlZ21lbnRlciA9IGdldFNlZ21lbnRlcigpO1xuXG5pbnRlcmZhY2UgSW5wdXRTdGF0ZSB7XG5cdHZhbHVlOiBzdHJpbmc7XG5cdGN1cnNvcjogbnVtYmVyO1xufVxuXG4vKipcbiAqIElucHV0IGNvbXBvbmVudCAtIHNpbmdsZS1saW5lIHRleHQgaW5wdXQgd2l0aCBob3Jpem9udGFsIHNjcm9sbGluZ1xuICovXG5leHBvcnQgY2xhc3MgSW5wdXQgaW1wbGVtZW50cyBDb21wb25lbnQsIEZvY3VzYWJsZSB7XG5cdHByaXZhdGUgdmFsdWU6IHN0cmluZyA9IFwiXCI7XG5cdHByaXZhdGUgY3Vyc29yOiBudW1iZXIgPSAwOyAvLyBDdXJzb3IgcG9zaXRpb24gaW4gdGhlIHZhbHVlXG5cdHB1YmxpYyBvblN1Ym1pdD86ICh2YWx1ZTogc3RyaW5nKSA9PiB2b2lkO1xuXHRwdWJsaWMgb25Fc2NhcGU/OiAoKSA9PiB2b2lkO1xuXHRwdWJsaWMgcGxhY2Vob2xkZXI6IHN0cmluZyA9IFwiXCI7XG5cdC8qKiBXaGVuIHRydWUsIHJlbmRlciBvYnNjdXJlZCBjaGFyYWN0ZXJzIGluc3RlYWQgb2YgdGhlIGFjdHVhbCB2YWx1ZS4gKi9cblx0cHVibGljIHNlY3VyZTogYm9vbGVhbiA9IGZhbHNlO1xuXG5cdC8qKiBGb2N1c2FibGUgaW50ZXJmYWNlIC0gc2V0IGJ5IFRVSSB3aGVuIGZvY3VzIGNoYW5nZXMgKi9cblx0cHJpdmF0ZSBfZm9jdXNlZDogYm9vbGVhbiA9IGZhbHNlO1xuXHRnZXQgZm9jdXNlZCgpOiBib29sZWFuIHtcblx0XHRyZXR1cm4gdGhpcy5fZm9jdXNlZDtcblx0fVxuXHRzZXQgZm9jdXNlZCh2YWx1ZTogYm9vbGVhbikge1xuXHRcdHRoaXMuX2ZvY3VzZWQgPSB2YWx1ZTtcblx0XHRpZiAoIXZhbHVlKSB7XG5cdFx0XHR0aGlzLmlzSW5QYXN0ZSA9IGZhbHNlO1xuXHRcdFx0dGhpcy5wYXN0ZUJ1ZmZlciA9IFwiXCI7XG5cdFx0fVxuXHR9XG5cblx0Ly8gQnJhY2tldGVkIHBhc3RlIG1vZGUgYnVmZmVyaW5nXG5cdHByaXZhdGUgcGFzdGVCdWZmZXI6IHN0cmluZyA9IFwiXCI7XG5cdHByaXZhdGUgaXNJblBhc3RlOiBib29sZWFuID0gZmFsc2U7XG5cblx0Ly8gS2lsbCByaW5nIGZvciBFbWFjcy1zdHlsZSBraWxsL3lhbmsgb3BlcmF0aW9uc1xuXHRwcml2YXRlIGtpbGxSaW5nID0gbmV3IEtpbGxSaW5nKCk7XG5cdHByaXZhdGUgbGFzdEFjdGlvbjogXCJraWxsXCIgfCBcInlhbmtcIiB8IFwidHlwZS13b3JkXCIgfCBudWxsID0gbnVsbDtcblxuXHQvLyBVbmRvIHN1cHBvcnRcblx0cHJpdmF0ZSB1bmRvU3RhY2sgPSBuZXcgVW5kb1N0YWNrPElucHV0U3RhdGU+KCk7XG5cblx0Z2V0VmFsdWUoKTogc3RyaW5nIHtcblx0XHRyZXR1cm4gdGhpcy52YWx1ZTtcblx0fVxuXG5cdHNldFZhbHVlKHZhbHVlOiBzdHJpbmcpOiB2b2lkIHtcblx0XHR0aGlzLnZhbHVlID0gdmFsdWU7XG5cdFx0dGhpcy5jdXJzb3IgPSBNYXRoLm1pbih0aGlzLmN1cnNvciwgdmFsdWUubGVuZ3RoKTtcblx0fVxuXG5cdGhhbmRsZUlucHV0KGRhdGE6IHN0cmluZyk6IHZvaWQge1xuXHRcdC8vIEhhbmRsZSBicmFja2V0ZWQgcGFzdGUgbW9kZVxuXHRcdC8vIFN0YXJ0IG9mIHBhc3RlOiBcXHgxYlsyMDB+XG5cdFx0Ly8gRW5kIG9mIHBhc3RlOiBcXHgxYlsyMDF+XG5cblx0XHQvLyBDaGVjayBpZiB3ZSdyZSBzdGFydGluZyBhIGJyYWNrZXRlZCBwYXN0ZVxuXHRcdGlmIChkYXRhLmluY2x1ZGVzKFwiXFx4MWJbMjAwflwiKSkge1xuXHRcdFx0dGhpcy5pc0luUGFzdGUgPSB0cnVlO1xuXHRcdFx0dGhpcy5wYXN0ZUJ1ZmZlciA9IFwiXCI7XG5cdFx0XHRkYXRhID0gZGF0YS5yZXBsYWNlKFwiXFx4MWJbMjAwflwiLCBcIlwiKTtcblx0XHR9XG5cblx0XHQvLyBJZiB3ZSdyZSBpbiBhIHBhc3RlLCBidWZmZXIgdGhlIGRhdGFcblx0XHRpZiAodGhpcy5pc0luUGFzdGUpIHtcblx0XHRcdC8vIENoZWNrIGlmIHRoaXMgY2h1bmsgY29udGFpbnMgdGhlIGVuZCBtYXJrZXJcblx0XHRcdHRoaXMucGFzdGVCdWZmZXIgKz0gZGF0YTtcblxuXHRcdFx0Y29uc3QgZW5kSW5kZXggPSB0aGlzLnBhc3RlQnVmZmVyLmluZGV4T2YoXCJcXHgxYlsyMDF+XCIpO1xuXHRcdFx0aWYgKGVuZEluZGV4ICE9PSAtMSkge1xuXHRcdFx0XHQvLyBFeHRyYWN0IHRoZSBwYXN0ZWQgY29udGVudFxuXHRcdFx0XHRjb25zdCBwYXN0ZUNvbnRlbnQgPSB0aGlzLnBhc3RlQnVmZmVyLnN1YnN0cmluZygwLCBlbmRJbmRleCk7XG5cblx0XHRcdFx0Ly8gUHJvY2VzcyB0aGUgY29tcGxldGUgcGFzdGVcblx0XHRcdFx0dGhpcy5oYW5kbGVQYXN0ZShwYXN0ZUNvbnRlbnQpO1xuXG5cdFx0XHRcdC8vIFJlc2V0IHBhc3RlIHN0YXRlXG5cdFx0XHRcdHRoaXMuaXNJblBhc3RlID0gZmFsc2U7XG5cblx0XHRcdFx0Ly8gSGFuZGxlIGFueSByZW1haW5pbmcgaW5wdXQgYWZ0ZXIgdGhlIHBhc3RlIG1hcmtlclxuXHRcdFx0XHRjb25zdCByZW1haW5pbmcgPSB0aGlzLnBhc3RlQnVmZmVyLnN1YnN0cmluZyhlbmRJbmRleCArIDYpOyAvLyA2ID0gbGVuZ3RoIG9mIFxceDFiWzIwMX5cblx0XHRcdFx0dGhpcy5wYXN0ZUJ1ZmZlciA9IFwiXCI7XG5cdFx0XHRcdGlmIChyZW1haW5pbmcpIHtcblx0XHRcdFx0XHR0aGlzLmhhbmRsZUlucHV0KHJlbWFpbmluZyk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRjb25zdCBrYiA9IGdldEVkaXRvcktleWJpbmRpbmdzKCk7XG5cblx0XHQvLyBFc2NhcGUvQ2FuY2VsXG5cdFx0aWYgKGtiLm1hdGNoZXMoZGF0YSwgXCJzZWxlY3RDYW5jZWxcIikpIHtcblx0XHRcdGlmICh0aGlzLm9uRXNjYXBlKSB0aGlzLm9uRXNjYXBlKCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Ly8gVW5kb1xuXHRcdGlmIChrYi5tYXRjaGVzKGRhdGEsIFwidW5kb1wiKSkge1xuXHRcdFx0dGhpcy51bmRvKCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Ly8gU3VibWl0XG5cdFx0aWYgKGtiLm1hdGNoZXMoZGF0YSwgXCJzdWJtaXRcIikgfHwgZGF0YSA9PT0gXCJcXG5cIikge1xuXHRcdFx0aWYgKHRoaXMub25TdWJtaXQpIHRoaXMub25TdWJtaXQodGhpcy52YWx1ZSk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Ly8gRGVsZXRpb25cblx0XHRpZiAoa2IubWF0Y2hlcyhkYXRhLCBcImRlbGV0ZUNoYXJCYWNrd2FyZFwiKSkge1xuXHRcdFx0dGhpcy5oYW5kbGVCYWNrc3BhY2UoKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRpZiAoa2IubWF0Y2hlcyhkYXRhLCBcImRlbGV0ZUNoYXJGb3J3YXJkXCIpKSB7XG5cdFx0XHR0aGlzLmhhbmRsZUZvcndhcmREZWxldGUoKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRpZiAoa2IubWF0Y2hlcyhkYXRhLCBcImRlbGV0ZVdvcmRCYWNrd2FyZFwiKSkge1xuXHRcdFx0dGhpcy5kZWxldGVXb3JkQmFja3dhcmRzKCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0aWYgKGtiLm1hdGNoZXMoZGF0YSwgXCJkZWxldGVXb3JkRm9yd2FyZFwiKSkge1xuXHRcdFx0dGhpcy5kZWxldGVXb3JkRm9yd2FyZCgpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGlmIChrYi5tYXRjaGVzKGRhdGEsIFwiZGVsZXRlVG9MaW5lU3RhcnRcIikpIHtcblx0XHRcdHRoaXMuZGVsZXRlVG9MaW5lU3RhcnQoKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRpZiAoa2IubWF0Y2hlcyhkYXRhLCBcImRlbGV0ZVRvTGluZUVuZFwiKSkge1xuXHRcdFx0dGhpcy5kZWxldGVUb0xpbmVFbmQoKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHQvLyBLaWxsIHJpbmcgYWN0aW9uc1xuXHRcdGlmIChrYi5tYXRjaGVzKGRhdGEsIFwieWFua1wiKSkge1xuXHRcdFx0dGhpcy55YW5rKCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXHRcdGlmIChrYi5tYXRjaGVzKGRhdGEsIFwieWFua1BvcFwiKSkge1xuXHRcdFx0dGhpcy55YW5rUG9wKCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Ly8gQ3Vyc29yIG1vdmVtZW50XG5cdFx0aWYgKGtiLm1hdGNoZXMoZGF0YSwgXCJjdXJzb3JMZWZ0XCIpKSB7XG5cdFx0XHR0aGlzLmxhc3RBY3Rpb24gPSBudWxsO1xuXHRcdFx0aWYgKHRoaXMuY3Vyc29yID4gMCkge1xuXHRcdFx0XHRjb25zdCBiZWZvcmVDdXJzb3IgPSB0aGlzLnZhbHVlLnNsaWNlKDAsIHRoaXMuY3Vyc29yKTtcblx0XHRcdFx0Y29uc3QgZ3JhcGhlbWVzID0gWy4uLnNlZ21lbnRlci5zZWdtZW50KGJlZm9yZUN1cnNvcildO1xuXHRcdFx0XHRjb25zdCBsYXN0R3JhcGhlbWUgPSBncmFwaGVtZXNbZ3JhcGhlbWVzLmxlbmd0aCAtIDFdO1xuXHRcdFx0XHR0aGlzLmN1cnNvciAtPSBsYXN0R3JhcGhlbWUgPyBsYXN0R3JhcGhlbWUuc2VnbWVudC5sZW5ndGggOiAxO1xuXHRcdFx0fVxuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGlmIChrYi5tYXRjaGVzKGRhdGEsIFwiY3Vyc29yUmlnaHRcIikpIHtcblx0XHRcdHRoaXMubGFzdEFjdGlvbiA9IG51bGw7XG5cdFx0XHRpZiAodGhpcy5jdXJzb3IgPCB0aGlzLnZhbHVlLmxlbmd0aCkge1xuXHRcdFx0XHRjb25zdCBhZnRlckN1cnNvciA9IHRoaXMudmFsdWUuc2xpY2UodGhpcy5jdXJzb3IpO1xuXHRcdFx0XHRjb25zdCBncmFwaGVtZXMgPSBbLi4uc2VnbWVudGVyLnNlZ21lbnQoYWZ0ZXJDdXJzb3IpXTtcblx0XHRcdFx0Y29uc3QgZmlyc3RHcmFwaGVtZSA9IGdyYXBoZW1lc1swXTtcblx0XHRcdFx0dGhpcy5jdXJzb3IgKz0gZmlyc3RHcmFwaGVtZSA/IGZpcnN0R3JhcGhlbWUuc2VnbWVudC5sZW5ndGggOiAxO1xuXHRcdFx0fVxuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGlmIChrYi5tYXRjaGVzKGRhdGEsIFwiY3Vyc29yTGluZVN0YXJ0XCIpKSB7XG5cdFx0XHR0aGlzLmxhc3RBY3Rpb24gPSBudWxsO1xuXHRcdFx0dGhpcy5jdXJzb3IgPSAwO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGlmIChrYi5tYXRjaGVzKGRhdGEsIFwiY3Vyc29yTGluZUVuZFwiKSkge1xuXHRcdFx0dGhpcy5sYXN0QWN0aW9uID0gbnVsbDtcblx0XHRcdHRoaXMuY3Vyc29yID0gdGhpcy52YWx1ZS5sZW5ndGg7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0aWYgKGtiLm1hdGNoZXMoZGF0YSwgXCJjdXJzb3JXb3JkTGVmdFwiKSkge1xuXHRcdFx0dGhpcy5tb3ZlV29yZEJhY2t3YXJkcygpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGlmIChrYi5tYXRjaGVzKGRhdGEsIFwiY3Vyc29yV29yZFJpZ2h0XCIpKSB7XG5cdFx0XHR0aGlzLm1vdmVXb3JkRm9yd2FyZHMoKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHQvLyBLaXR0eSBDU0ktdSBwcmludGFibGUgY2hhcmFjdGVyIChlLmcuIFxceDFiWzk3dSBmb3IgJ2EnKS5cblx0XHQvLyBUZXJtaW5hbHMgd2l0aCBLaXR0eSBwcm90b2NvbCBmbGFnIDEgKGRpc2FtYmlndWF0ZSkgc2VuZCBDU0ktdSBmb3IgYWxsIGtleXMsXG5cdFx0Ly8gaW5jbHVkaW5nIHBsYWluIHByaW50YWJsZSBjaGFyYWN0ZXJzLiBEZWNvZGUgYmVmb3JlIHRoZSBjb250cm9sLWNoYXIgY2hlY2tcblx0XHQvLyBzaW5jZSBDU0ktdSBzZXF1ZW5jZXMgY29udGFpbiBcXHgxYiB3aGljaCB3b3VsZCBiZSByZWplY3RlZC5cblx0XHRjb25zdCBraXR0eVByaW50YWJsZSA9IGRlY29kZUtpdHR5UHJpbnRhYmxlKGRhdGEpO1xuXHRcdGlmIChraXR0eVByaW50YWJsZSAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0XHR0aGlzLmluc2VydENoYXJhY3RlcihraXR0eVByaW50YWJsZSk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Ly8gUmVndWxhciBjaGFyYWN0ZXIgaW5wdXQgLSBhY2NlcHQgcHJpbnRhYmxlIGNoYXJhY3RlcnMgaW5jbHVkaW5nIFVuaWNvZGUsXG5cdFx0Ly8gYnV0IHJlamVjdCBjb250cm9sIGNoYXJhY3RlcnMgKEMwOiAweDAwLTB4MUYsIERFTDogMHg3RiwgQzE6IDB4ODAtMHg5Rilcblx0XHRjb25zdCBoYXNDb250cm9sQ2hhcnMgPSBbLi4uZGF0YV0uc29tZSgoY2gpID0+IHtcblx0XHRcdGNvbnN0IGNvZGUgPSBjaC5jaGFyQ29kZUF0KDApO1xuXHRcdFx0cmV0dXJuIGNvZGUgPCAzMiB8fCBjb2RlID09PSAweDdmIHx8IChjb2RlID49IDB4ODAgJiYgY29kZSA8PSAweDlmKTtcblx0XHR9KTtcblx0XHRpZiAoIWhhc0NvbnRyb2xDaGFycykge1xuXHRcdFx0dGhpcy5pbnNlcnRDaGFyYWN0ZXIoZGF0YSk7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBpbnNlcnRDaGFyYWN0ZXIoY2hhcjogc3RyaW5nKTogdm9pZCB7XG5cdFx0Ly8gVW5kbyBjb2FsZXNjaW5nOiBjb25zZWN1dGl2ZSB3b3JkIGNoYXJzIGNvYWxlc2NlIGludG8gb25lIHVuZG8gdW5pdFxuXHRcdGlmIChpc1doaXRlc3BhY2VDaGFyKGNoYXIpIHx8IHRoaXMubGFzdEFjdGlvbiAhPT0gXCJ0eXBlLXdvcmRcIikge1xuXHRcdFx0dGhpcy5wdXNoVW5kbygpO1xuXHRcdH1cblx0XHR0aGlzLmxhc3RBY3Rpb24gPSBcInR5cGUtd29yZFwiO1xuXG5cdFx0dGhpcy52YWx1ZSA9IHRoaXMudmFsdWUuc2xpY2UoMCwgdGhpcy5jdXJzb3IpICsgY2hhciArIHRoaXMudmFsdWUuc2xpY2UodGhpcy5jdXJzb3IpO1xuXHRcdHRoaXMuY3Vyc29yICs9IGNoYXIubGVuZ3RoO1xuXHR9XG5cblx0cHJpdmF0ZSBoYW5kbGVCYWNrc3BhY2UoKTogdm9pZCB7XG5cdFx0dGhpcy5sYXN0QWN0aW9uID0gbnVsbDtcblx0XHRpZiAodGhpcy5jdXJzb3IgPiAwKSB7XG5cdFx0XHR0aGlzLnB1c2hVbmRvKCk7XG5cdFx0XHRjb25zdCBiZWZvcmVDdXJzb3IgPSB0aGlzLnZhbHVlLnNsaWNlKDAsIHRoaXMuY3Vyc29yKTtcblx0XHRcdGNvbnN0IGdyYXBoZW1lcyA9IFsuLi5zZWdtZW50ZXIuc2VnbWVudChiZWZvcmVDdXJzb3IpXTtcblx0XHRcdGNvbnN0IGxhc3RHcmFwaGVtZSA9IGdyYXBoZW1lc1tncmFwaGVtZXMubGVuZ3RoIC0gMV07XG5cdFx0XHRjb25zdCBncmFwaGVtZUxlbmd0aCA9IGxhc3RHcmFwaGVtZSA/IGxhc3RHcmFwaGVtZS5zZWdtZW50Lmxlbmd0aCA6IDE7XG5cdFx0XHR0aGlzLnZhbHVlID0gdGhpcy52YWx1ZS5zbGljZSgwLCB0aGlzLmN1cnNvciAtIGdyYXBoZW1lTGVuZ3RoKSArIHRoaXMudmFsdWUuc2xpY2UodGhpcy5jdXJzb3IpO1xuXHRcdFx0dGhpcy5jdXJzb3IgLT0gZ3JhcGhlbWVMZW5ndGg7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBoYW5kbGVGb3J3YXJkRGVsZXRlKCk6IHZvaWQge1xuXHRcdHRoaXMubGFzdEFjdGlvbiA9IG51bGw7XG5cdFx0aWYgKHRoaXMuY3Vyc29yIDwgdGhpcy52YWx1ZS5sZW5ndGgpIHtcblx0XHRcdHRoaXMucHVzaFVuZG8oKTtcblx0XHRcdGNvbnN0IGFmdGVyQ3Vyc29yID0gdGhpcy52YWx1ZS5zbGljZSh0aGlzLmN1cnNvcik7XG5cdFx0XHRjb25zdCBncmFwaGVtZXMgPSBbLi4uc2VnbWVudGVyLnNlZ21lbnQoYWZ0ZXJDdXJzb3IpXTtcblx0XHRcdGNvbnN0IGZpcnN0R3JhcGhlbWUgPSBncmFwaGVtZXNbMF07XG5cdFx0XHRjb25zdCBncmFwaGVtZUxlbmd0aCA9IGZpcnN0R3JhcGhlbWUgPyBmaXJzdEdyYXBoZW1lLnNlZ21lbnQubGVuZ3RoIDogMTtcblx0XHRcdHRoaXMudmFsdWUgPSB0aGlzLnZhbHVlLnNsaWNlKDAsIHRoaXMuY3Vyc29yKSArIHRoaXMudmFsdWUuc2xpY2UodGhpcy5jdXJzb3IgKyBncmFwaGVtZUxlbmd0aCk7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBkZWxldGVUb0xpbmVTdGFydCgpOiB2b2lkIHtcblx0XHRpZiAodGhpcy5jdXJzb3IgPT09IDApIHJldHVybjtcblx0XHR0aGlzLnB1c2hVbmRvKCk7XG5cdFx0Y29uc3QgZGVsZXRlZFRleHQgPSB0aGlzLnZhbHVlLnNsaWNlKDAsIHRoaXMuY3Vyc29yKTtcblx0XHR0aGlzLmtpbGxSaW5nLnB1c2goZGVsZXRlZFRleHQsIHsgcHJlcGVuZDogdHJ1ZSwgYWNjdW11bGF0ZTogdGhpcy5sYXN0QWN0aW9uID09PSBcImtpbGxcIiB9KTtcblx0XHR0aGlzLmxhc3RBY3Rpb24gPSBcImtpbGxcIjtcblx0XHR0aGlzLnZhbHVlID0gdGhpcy52YWx1ZS5zbGljZSh0aGlzLmN1cnNvcik7XG5cdFx0dGhpcy5jdXJzb3IgPSAwO1xuXHR9XG5cblx0cHJpdmF0ZSBkZWxldGVUb0xpbmVFbmQoKTogdm9pZCB7XG5cdFx0aWYgKHRoaXMuY3Vyc29yID49IHRoaXMudmFsdWUubGVuZ3RoKSByZXR1cm47XG5cdFx0dGhpcy5wdXNoVW5kbygpO1xuXHRcdGNvbnN0IGRlbGV0ZWRUZXh0ID0gdGhpcy52YWx1ZS5zbGljZSh0aGlzLmN1cnNvcik7XG5cdFx0dGhpcy5raWxsUmluZy5wdXNoKGRlbGV0ZWRUZXh0LCB7IHByZXBlbmQ6IGZhbHNlLCBhY2N1bXVsYXRlOiB0aGlzLmxhc3RBY3Rpb24gPT09IFwia2lsbFwiIH0pO1xuXHRcdHRoaXMubGFzdEFjdGlvbiA9IFwia2lsbFwiO1xuXHRcdHRoaXMudmFsdWUgPSB0aGlzLnZhbHVlLnNsaWNlKDAsIHRoaXMuY3Vyc29yKTtcblx0fVxuXG5cdHByaXZhdGUgZGVsZXRlV29yZEJhY2t3YXJkcygpOiB2b2lkIHtcblx0XHRpZiAodGhpcy5jdXJzb3IgPT09IDApIHJldHVybjtcblxuXHRcdC8vIFNhdmUgbGFzdEFjdGlvbiBiZWZvcmUgY3Vyc29yIG1vdmVtZW50IChtb3ZlV29yZEJhY2t3YXJkcyByZXNldHMgaXQpXG5cdFx0Y29uc3Qgd2FzS2lsbCA9IHRoaXMubGFzdEFjdGlvbiA9PT0gXCJraWxsXCI7XG5cblx0XHR0aGlzLnB1c2hVbmRvKCk7XG5cblx0XHRjb25zdCBvbGRDdXJzb3IgPSB0aGlzLmN1cnNvcjtcblx0XHR0aGlzLm1vdmVXb3JkQmFja3dhcmRzKCk7XG5cdFx0Y29uc3QgZGVsZXRlRnJvbSA9IHRoaXMuY3Vyc29yO1xuXHRcdHRoaXMuY3Vyc29yID0gb2xkQ3Vyc29yO1xuXG5cdFx0Y29uc3QgZGVsZXRlZFRleHQgPSB0aGlzLnZhbHVlLnNsaWNlKGRlbGV0ZUZyb20sIHRoaXMuY3Vyc29yKTtcblx0XHR0aGlzLmtpbGxSaW5nLnB1c2goZGVsZXRlZFRleHQsIHsgcHJlcGVuZDogdHJ1ZSwgYWNjdW11bGF0ZTogd2FzS2lsbCB9KTtcblx0XHR0aGlzLmxhc3RBY3Rpb24gPSBcImtpbGxcIjtcblxuXHRcdHRoaXMudmFsdWUgPSB0aGlzLnZhbHVlLnNsaWNlKDAsIGRlbGV0ZUZyb20pICsgdGhpcy52YWx1ZS5zbGljZSh0aGlzLmN1cnNvcik7XG5cdFx0dGhpcy5jdXJzb3IgPSBkZWxldGVGcm9tO1xuXHR9XG5cblx0cHJpdmF0ZSBkZWxldGVXb3JkRm9yd2FyZCgpOiB2b2lkIHtcblx0XHRpZiAodGhpcy5jdXJzb3IgPj0gdGhpcy52YWx1ZS5sZW5ndGgpIHJldHVybjtcblxuXHRcdC8vIFNhdmUgbGFzdEFjdGlvbiBiZWZvcmUgY3Vyc29yIG1vdmVtZW50IChtb3ZlV29yZEZvcndhcmRzIHJlc2V0cyBpdClcblx0XHRjb25zdCB3YXNLaWxsID0gdGhpcy5sYXN0QWN0aW9uID09PSBcImtpbGxcIjtcblxuXHRcdHRoaXMucHVzaFVuZG8oKTtcblxuXHRcdGNvbnN0IG9sZEN1cnNvciA9IHRoaXMuY3Vyc29yO1xuXHRcdHRoaXMubW92ZVdvcmRGb3J3YXJkcygpO1xuXHRcdGNvbnN0IGRlbGV0ZVRvID0gdGhpcy5jdXJzb3I7XG5cdFx0dGhpcy5jdXJzb3IgPSBvbGRDdXJzb3I7XG5cblx0XHRjb25zdCBkZWxldGVkVGV4dCA9IHRoaXMudmFsdWUuc2xpY2UodGhpcy5jdXJzb3IsIGRlbGV0ZVRvKTtcblx0XHR0aGlzLmtpbGxSaW5nLnB1c2goZGVsZXRlZFRleHQsIHsgcHJlcGVuZDogZmFsc2UsIGFjY3VtdWxhdGU6IHdhc0tpbGwgfSk7XG5cdFx0dGhpcy5sYXN0QWN0aW9uID0gXCJraWxsXCI7XG5cblx0XHR0aGlzLnZhbHVlID0gdGhpcy52YWx1ZS5zbGljZSgwLCB0aGlzLmN1cnNvcikgKyB0aGlzLnZhbHVlLnNsaWNlKGRlbGV0ZVRvKTtcblx0fVxuXG5cdHByaXZhdGUgeWFuaygpOiB2b2lkIHtcblx0XHRjb25zdCB0ZXh0ID0gdGhpcy5raWxsUmluZy5wZWVrKCk7XG5cdFx0aWYgKCF0ZXh0KSByZXR1cm47XG5cblx0XHR0aGlzLnB1c2hVbmRvKCk7XG5cblx0XHR0aGlzLnZhbHVlID0gdGhpcy52YWx1ZS5zbGljZSgwLCB0aGlzLmN1cnNvcikgKyB0ZXh0ICsgdGhpcy52YWx1ZS5zbGljZSh0aGlzLmN1cnNvcik7XG5cdFx0dGhpcy5jdXJzb3IgKz0gdGV4dC5sZW5ndGg7XG5cdFx0dGhpcy5sYXN0QWN0aW9uID0gXCJ5YW5rXCI7XG5cdH1cblxuXHRwcml2YXRlIHlhbmtQb3AoKTogdm9pZCB7XG5cdFx0aWYgKHRoaXMubGFzdEFjdGlvbiAhPT0gXCJ5YW5rXCIgfHwgdGhpcy5raWxsUmluZy5sZW5ndGggPD0gMSkgcmV0dXJuO1xuXG5cdFx0dGhpcy5wdXNoVW5kbygpO1xuXG5cdFx0Ly8gRGVsZXRlIHRoZSBwcmV2aW91c2x5IHlhbmtlZCB0ZXh0IChzdGlsbCBhdCBlbmQgb2YgcmluZyBiZWZvcmUgcm90YXRpb24pXG5cdFx0Y29uc3QgcHJldlRleHQgPSB0aGlzLmtpbGxSaW5nLnBlZWsoKSB8fCBcIlwiO1xuXHRcdHRoaXMudmFsdWUgPSB0aGlzLnZhbHVlLnNsaWNlKDAsIHRoaXMuY3Vyc29yIC0gcHJldlRleHQubGVuZ3RoKSArIHRoaXMudmFsdWUuc2xpY2UodGhpcy5jdXJzb3IpO1xuXHRcdHRoaXMuY3Vyc29yIC09IHByZXZUZXh0Lmxlbmd0aDtcblxuXHRcdC8vIFJvdGF0ZSBhbmQgaW5zZXJ0IG5ldyBlbnRyeVxuXHRcdHRoaXMua2lsbFJpbmcucm90YXRlKCk7XG5cdFx0Y29uc3QgdGV4dCA9IHRoaXMua2lsbFJpbmcucGVlaygpIHx8IFwiXCI7XG5cdFx0dGhpcy52YWx1ZSA9IHRoaXMudmFsdWUuc2xpY2UoMCwgdGhpcy5jdXJzb3IpICsgdGV4dCArIHRoaXMudmFsdWUuc2xpY2UodGhpcy5jdXJzb3IpO1xuXHRcdHRoaXMuY3Vyc29yICs9IHRleHQubGVuZ3RoO1xuXHRcdHRoaXMubGFzdEFjdGlvbiA9IFwieWFua1wiO1xuXHR9XG5cblx0cHJpdmF0ZSBwdXNoVW5kbygpOiB2b2lkIHtcblx0XHR0aGlzLnVuZG9TdGFjay5wdXNoKHsgdmFsdWU6IHRoaXMudmFsdWUsIGN1cnNvcjogdGhpcy5jdXJzb3IgfSk7XG5cdH1cblxuXHRwcml2YXRlIHVuZG8oKTogdm9pZCB7XG5cdFx0Y29uc3Qgc25hcHNob3QgPSB0aGlzLnVuZG9TdGFjay5wb3AoKTtcblx0XHRpZiAoIXNuYXBzaG90KSByZXR1cm47XG5cdFx0dGhpcy52YWx1ZSA9IHNuYXBzaG90LnZhbHVlO1xuXHRcdHRoaXMuY3Vyc29yID0gc25hcHNob3QuY3Vyc29yO1xuXHRcdHRoaXMubGFzdEFjdGlvbiA9IG51bGw7XG5cdH1cblxuXHRwcml2YXRlIG1vdmVXb3JkQmFja3dhcmRzKCk6IHZvaWQge1xuXHRcdGlmICh0aGlzLmN1cnNvciA9PT0gMCkge1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdHRoaXMubGFzdEFjdGlvbiA9IG51bGw7XG5cdFx0Y29uc3QgdGV4dEJlZm9yZUN1cnNvciA9IHRoaXMudmFsdWUuc2xpY2UoMCwgdGhpcy5jdXJzb3IpO1xuXHRcdGNvbnN0IGdyYXBoZW1lcyA9IFsuLi5zZWdtZW50ZXIuc2VnbWVudCh0ZXh0QmVmb3JlQ3Vyc29yKV07XG5cblx0XHQvLyBTa2lwIHRyYWlsaW5nIHdoaXRlc3BhY2Vcblx0XHR3aGlsZSAoZ3JhcGhlbWVzLmxlbmd0aCA+IDAgJiYgaXNXaGl0ZXNwYWNlQ2hhcihncmFwaGVtZXNbZ3JhcGhlbWVzLmxlbmd0aCAtIDFdPy5zZWdtZW50IHx8IFwiXCIpKSB7XG5cdFx0XHR0aGlzLmN1cnNvciAtPSBncmFwaGVtZXMucG9wKCk/LnNlZ21lbnQubGVuZ3RoIHx8IDA7XG5cdFx0fVxuXG5cdFx0aWYgKGdyYXBoZW1lcy5sZW5ndGggPiAwKSB7XG5cdFx0XHRjb25zdCBsYXN0R3JhcGhlbWUgPSBncmFwaGVtZXNbZ3JhcGhlbWVzLmxlbmd0aCAtIDFdPy5zZWdtZW50IHx8IFwiXCI7XG5cdFx0XHRpZiAoaXNQdW5jdHVhdGlvbkNoYXIobGFzdEdyYXBoZW1lKSkge1xuXHRcdFx0XHQvLyBTa2lwIHB1bmN0dWF0aW9uIHJ1blxuXHRcdFx0XHR3aGlsZSAoZ3JhcGhlbWVzLmxlbmd0aCA+IDAgJiYgaXNQdW5jdHVhdGlvbkNoYXIoZ3JhcGhlbWVzW2dyYXBoZW1lcy5sZW5ndGggLSAxXT8uc2VnbWVudCB8fCBcIlwiKSkge1xuXHRcdFx0XHRcdHRoaXMuY3Vyc29yIC09IGdyYXBoZW1lcy5wb3AoKT8uc2VnbWVudC5sZW5ndGggfHwgMDtcblx0XHRcdFx0fVxuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0Ly8gU2tpcCB3b3JkIHJ1blxuXHRcdFx0XHR3aGlsZSAoXG5cdFx0XHRcdFx0Z3JhcGhlbWVzLmxlbmd0aCA+IDAgJiZcblx0XHRcdFx0XHQhaXNXaGl0ZXNwYWNlQ2hhcihncmFwaGVtZXNbZ3JhcGhlbWVzLmxlbmd0aCAtIDFdPy5zZWdtZW50IHx8IFwiXCIpICYmXG5cdFx0XHRcdFx0IWlzUHVuY3R1YXRpb25DaGFyKGdyYXBoZW1lc1tncmFwaGVtZXMubGVuZ3RoIC0gMV0/LnNlZ21lbnQgfHwgXCJcIilcblx0XHRcdFx0KSB7XG5cdFx0XHRcdFx0dGhpcy5jdXJzb3IgLT0gZ3JhcGhlbWVzLnBvcCgpPy5zZWdtZW50Lmxlbmd0aCB8fCAwO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBtb3ZlV29yZEZvcndhcmRzKCk6IHZvaWQge1xuXHRcdGlmICh0aGlzLmN1cnNvciA+PSB0aGlzLnZhbHVlLmxlbmd0aCkge1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdHRoaXMubGFzdEFjdGlvbiA9IG51bGw7XG5cdFx0Y29uc3QgdGV4dEFmdGVyQ3Vyc29yID0gdGhpcy52YWx1ZS5zbGljZSh0aGlzLmN1cnNvcik7XG5cdFx0Y29uc3Qgc2VnbWVudHMgPSBzZWdtZW50ZXIuc2VnbWVudCh0ZXh0QWZ0ZXJDdXJzb3IpO1xuXHRcdGNvbnN0IGl0ZXJhdG9yID0gc2VnbWVudHNbU3ltYm9sLml0ZXJhdG9yXSgpO1xuXHRcdGxldCBuZXh0ID0gaXRlcmF0b3IubmV4dCgpO1xuXG5cdFx0Ly8gU2tpcCBsZWFkaW5nIHdoaXRlc3BhY2Vcblx0XHR3aGlsZSAoIW5leHQuZG9uZSAmJiBpc1doaXRlc3BhY2VDaGFyKG5leHQudmFsdWUuc2VnbWVudCkpIHtcblx0XHRcdHRoaXMuY3Vyc29yICs9IG5leHQudmFsdWUuc2VnbWVudC5sZW5ndGg7XG5cdFx0XHRuZXh0ID0gaXRlcmF0b3IubmV4dCgpO1xuXHRcdH1cblxuXHRcdGlmICghbmV4dC5kb25lKSB7XG5cdFx0XHRjb25zdCBmaXJzdEdyYXBoZW1lID0gbmV4dC52YWx1ZS5zZWdtZW50O1xuXHRcdFx0aWYgKGlzUHVuY3R1YXRpb25DaGFyKGZpcnN0R3JhcGhlbWUpKSB7XG5cdFx0XHRcdC8vIFNraXAgcHVuY3R1YXRpb24gcnVuXG5cdFx0XHRcdHdoaWxlICghbmV4dC5kb25lICYmIGlzUHVuY3R1YXRpb25DaGFyKG5leHQudmFsdWUuc2VnbWVudCkpIHtcblx0XHRcdFx0XHR0aGlzLmN1cnNvciArPSBuZXh0LnZhbHVlLnNlZ21lbnQubGVuZ3RoO1xuXHRcdFx0XHRcdG5leHQgPSBpdGVyYXRvci5uZXh0KCk7XG5cdFx0XHRcdH1cblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdC8vIFNraXAgd29yZCBydW5cblx0XHRcdFx0d2hpbGUgKCFuZXh0LmRvbmUgJiYgIWlzV2hpdGVzcGFjZUNoYXIobmV4dC52YWx1ZS5zZWdtZW50KSAmJiAhaXNQdW5jdHVhdGlvbkNoYXIobmV4dC52YWx1ZS5zZWdtZW50KSkge1xuXHRcdFx0XHRcdHRoaXMuY3Vyc29yICs9IG5leHQudmFsdWUuc2VnbWVudC5sZW5ndGg7XG5cdFx0XHRcdFx0bmV4dCA9IGl0ZXJhdG9yLm5leHQoKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgaGFuZGxlUGFzdGUocGFzdGVkVGV4dDogc3RyaW5nKTogdm9pZCB7XG5cdFx0dGhpcy5sYXN0QWN0aW9uID0gbnVsbDtcblx0XHR0aGlzLnB1c2hVbmRvKCk7XG5cblx0XHQvLyBDbGVhbiB0aGUgcGFzdGVkIHRleHQgLSByZW1vdmUgbmV3bGluZXMgYW5kIGNhcnJpYWdlIHJldHVybnNcblx0XHRjb25zdCBjbGVhblRleHQgPSBwYXN0ZWRUZXh0LnJlcGxhY2UoL1xcclxcbi9nLCBcIlwiKS5yZXBsYWNlKC9cXHIvZywgXCJcIikucmVwbGFjZSgvXFxuL2csIFwiXCIpO1xuXG5cdFx0Ly8gSW5zZXJ0IGF0IGN1cnNvciBwb3NpdGlvblxuXHRcdHRoaXMudmFsdWUgPSB0aGlzLnZhbHVlLnNsaWNlKDAsIHRoaXMuY3Vyc29yKSArIGNsZWFuVGV4dCArIHRoaXMudmFsdWUuc2xpY2UodGhpcy5jdXJzb3IpO1xuXHRcdHRoaXMuY3Vyc29yICs9IGNsZWFuVGV4dC5sZW5ndGg7XG5cdH1cblxuXHRpbnZhbGlkYXRlKCk6IHZvaWQge1xuXHRcdC8vIE5vIGNhY2hlZCBzdGF0ZSB0byBpbnZhbGlkYXRlIGN1cnJlbnRseVxuXHR9XG5cblx0cmVuZGVyKHdpZHRoOiBudW1iZXIpOiBzdHJpbmdbXSB7XG5cdFx0Ly8gQ2FsY3VsYXRlIHZpc2libGUgd2luZG93XG5cdFx0Y29uc3QgcHJvbXB0ID0gXCI+IFwiO1xuXHRcdGNvbnN0IGF2YWlsYWJsZVdpZHRoID0gd2lkdGggLSBwcm9tcHQubGVuZ3RoO1xuXHRcdGNvbnN0IHJlbmRlclZhbHVlID0gdGhpcy5zZWN1cmUgPyBcIipcIi5yZXBlYXQodGhpcy52YWx1ZS5sZW5ndGgpIDogdGhpcy52YWx1ZTtcblxuXHRcdGlmIChhdmFpbGFibGVXaWR0aCA8PSAwKSB7XG5cdFx0XHRyZXR1cm4gW3Byb21wdF07XG5cdFx0fVxuXG5cdFx0Ly8gU2hvdyBwbGFjZWhvbGRlciB3aGVuIHZhbHVlIGlzIGVtcHR5XG5cdFx0aWYgKHRoaXMudmFsdWUgPT09IFwiXCIgJiYgdGhpcy5wbGFjZWhvbGRlcikge1xuXHRcdFx0Y29uc3QgcGxhY2Vob2xkZXJUZXh0ID0gdGhpcy5wbGFjZWhvbGRlci5zbGljZSgwLCBhdmFpbGFibGVXaWR0aCAtIDEpO1xuXHRcdFx0Y29uc3QgbWFya2VyID0gdGhpcy5mb2N1c2VkID8gQ1VSU09SX01BUktFUiA6IFwiXCI7XG5cdFx0XHRjb25zdCBjdXJzb3JDaGFyID0gXCJcXHgxYls3bSBcXHgxYlsyN21cIjsgLy8gaW52ZXJzZSBzcGFjZSBmb3IgY3Vyc29yXG5cdFx0XHRjb25zdCBkaW1QbGFjZWhvbGRlciA9IGBcXHgxYlsybSR7cGxhY2Vob2xkZXJUZXh0fVxceDFiWzIybWA7IC8vIGRpbSB0ZXh0XG5cdFx0XHRjb25zdCBwYWRkaW5nID0gXCIgXCIucmVwZWF0KE1hdGgubWF4KDAsIGF2YWlsYWJsZVdpZHRoIC0gdmlzaWJsZVdpZHRoKHBsYWNlaG9sZGVyVGV4dCkgLSAxKSk7XG5cdFx0XHRyZXR1cm4gW3Byb21wdCArIG1hcmtlciArIGN1cnNvckNoYXIgKyBkaW1QbGFjZWhvbGRlciArIHBhZGRpbmddO1xuXHRcdH1cblxuXHRcdGxldCB2aXNpYmxlVGV4dCA9IFwiXCI7XG5cdFx0bGV0IGN1cnNvckRpc3BsYXkgPSB0aGlzLmN1cnNvcjtcblxuXHRcdGlmICh0aGlzLnZhbHVlLmxlbmd0aCA8IGF2YWlsYWJsZVdpZHRoKSB7XG5cdFx0XHQvLyBFdmVyeXRoaW5nIGZpdHMgKGxlYXZlIHJvb20gZm9yIGN1cnNvciBhdCBlbmQpXG5cdFx0XHR2aXNpYmxlVGV4dCA9IHJlbmRlclZhbHVlO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHQvLyBOZWVkIGhvcml6b250YWwgc2Nyb2xsaW5nXG5cdFx0XHQvLyBSZXNlcnZlIG9uZSBjaGFyYWN0ZXIgZm9yIGN1cnNvciBpZiBpdCdzIGF0IHRoZSBlbmRcblx0XHRcdGNvbnN0IHNjcm9sbFdpZHRoID0gdGhpcy5jdXJzb3IgPT09IHRoaXMudmFsdWUubGVuZ3RoID8gYXZhaWxhYmxlV2lkdGggLSAxIDogYXZhaWxhYmxlV2lkdGg7XG5cdFx0XHRjb25zdCBoYWxmV2lkdGggPSBNYXRoLmZsb29yKHNjcm9sbFdpZHRoIC8gMik7XG5cblx0XHRcdGNvbnN0IGZpbmRWYWxpZFN0YXJ0ID0gKHN0YXJ0OiBudW1iZXIpID0+IHtcblx0XHRcdFx0d2hpbGUgKHN0YXJ0IDwgdGhpcy52YWx1ZS5sZW5ndGgpIHtcblx0XHRcdFx0XHRjb25zdCBjaGFyQ29kZSA9IHRoaXMudmFsdWUuY2hhckNvZGVBdChzdGFydCk7XG5cdFx0XHRcdFx0Ly8gdGhpcyBpcyBsb3cgc3Vycm9nYXRlLCBub3QgYSB2YWxpZCBzdGFydFxuXHRcdFx0XHRcdGlmIChjaGFyQ29kZSA+PSAweGRjMDAgJiYgY2hhckNvZGUgPCAweGUwMDApIHtcblx0XHRcdFx0XHRcdHN0YXJ0Kys7XG5cdFx0XHRcdFx0XHRjb250aW51ZTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdH1cblx0XHRcdFx0cmV0dXJuIHN0YXJ0O1xuXHRcdFx0fTtcblxuXHRcdFx0Y29uc3QgZmluZFZhbGlkRW5kID0gKGVuZDogbnVtYmVyKSA9PiB7XG5cdFx0XHRcdHdoaWxlIChlbmQgPiAwKSB7XG5cdFx0XHRcdFx0Y29uc3QgY2hhckNvZGUgPSB0aGlzLnZhbHVlLmNoYXJDb2RlQXQoZW5kIC0gMSk7XG5cdFx0XHRcdFx0Ly8gdGhpcyBpcyBoaWdoIHN1cnJvZ2F0ZSwgbWlnaHQgYmUgc3BsaXQuXG5cdFx0XHRcdFx0aWYgKGNoYXJDb2RlID49IDB4ZDgwMCAmJiBjaGFyQ29kZSA8IDB4ZGMwMCkge1xuXHRcdFx0XHRcdFx0ZW5kLS07XG5cdFx0XHRcdFx0XHRjb250aW51ZTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdH1cblx0XHRcdFx0cmV0dXJuIGVuZDtcblx0XHRcdH07XG5cblx0XHRcdGlmICh0aGlzLmN1cnNvciA8IGhhbGZXaWR0aCkge1xuXHRcdFx0XHQvLyBDdXJzb3IgbmVhciBzdGFydFxuXHRcdFx0XHR2aXNpYmxlVGV4dCA9IHJlbmRlclZhbHVlLnNsaWNlKDAsIGZpbmRWYWxpZEVuZChzY3JvbGxXaWR0aCkpO1xuXHRcdFx0XHRjdXJzb3JEaXNwbGF5ID0gdGhpcy5jdXJzb3I7XG5cdFx0XHR9IGVsc2UgaWYgKHRoaXMuY3Vyc29yID4gdGhpcy52YWx1ZS5sZW5ndGggLSBoYWxmV2lkdGgpIHtcblx0XHRcdFx0Ly8gQ3Vyc29yIG5lYXIgZW5kXG5cdFx0XHRcdGNvbnN0IHN0YXJ0ID0gZmluZFZhbGlkU3RhcnQodGhpcy52YWx1ZS5sZW5ndGggLSBzY3JvbGxXaWR0aCk7XG5cdFx0XHRcdHZpc2libGVUZXh0ID0gcmVuZGVyVmFsdWUuc2xpY2Uoc3RhcnQpO1xuXHRcdFx0XHRjdXJzb3JEaXNwbGF5ID0gdGhpcy5jdXJzb3IgLSBzdGFydDtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdC8vIEN1cnNvciBpbiBtaWRkbGVcblx0XHRcdFx0Y29uc3Qgc3RhcnQgPSBmaW5kVmFsaWRTdGFydCh0aGlzLmN1cnNvciAtIGhhbGZXaWR0aCk7XG5cdFx0XHRcdHZpc2libGVUZXh0ID0gcmVuZGVyVmFsdWUuc2xpY2Uoc3RhcnQsIGZpbmRWYWxpZEVuZChzdGFydCArIHNjcm9sbFdpZHRoKSk7XG5cdFx0XHRcdGN1cnNvckRpc3BsYXkgPSBoYWxmV2lkdGg7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0Ly8gQnVpbGQgbGluZSB3aXRoIGZha2UgY3Vyc29yXG5cdFx0Ly8gSW5zZXJ0IGN1cnNvciBjaGFyYWN0ZXIgYXQgY3Vyc29yIHBvc2l0aW9uXG5cdFx0Y29uc3QgZ3JhcGhlbWVzID0gWy4uLnNlZ21lbnRlci5zZWdtZW50KHZpc2libGVUZXh0LnNsaWNlKGN1cnNvckRpc3BsYXkpKV07XG5cdFx0Y29uc3QgY3Vyc29yR3JhcGhlbWUgPSBncmFwaGVtZXNbMF07XG5cblx0XHRjb25zdCBiZWZvcmVDdXJzb3IgPSB2aXNpYmxlVGV4dC5zbGljZSgwLCBjdXJzb3JEaXNwbGF5KTtcblx0XHRjb25zdCBhdEN1cnNvciA9IGN1cnNvckdyYXBoZW1lPy5zZWdtZW50ID8/IFwiIFwiOyAvLyBDaGFyYWN0ZXIgYXQgY3Vyc29yLCBvciBzcGFjZSBpZiBhdCBlbmRcblx0XHRjb25zdCBhZnRlckN1cnNvciA9IHZpc2libGVUZXh0LnNsaWNlKGN1cnNvckRpc3BsYXkgKyBhdEN1cnNvci5sZW5ndGgpO1xuXG5cdFx0Ly8gSGFyZHdhcmUgY3Vyc29yIG1hcmtlciAoemVyby13aWR0aCwgZW1pdHRlZCBiZWZvcmUgZmFrZSBjdXJzb3IgZm9yIElNRSBwb3NpdGlvbmluZylcblx0XHRjb25zdCBtYXJrZXIgPSB0aGlzLmZvY3VzZWQgPyBDVVJTT1JfTUFSS0VSIDogXCJcIjtcblxuXHRcdC8vIFVzZSBpbnZlcnNlIHZpZGVvIHRvIHNob3cgY3Vyc29yXG5cdFx0Y29uc3QgY3Vyc29yQ2hhciA9IGBcXHgxYls3bSR7YXRDdXJzb3J9XFx4MWJbMjdtYDsgLy8gRVNDWzdtID0gcmV2ZXJzZSB2aWRlbywgRVNDWzI3bSA9IG5vcm1hbFxuXHRcdGNvbnN0IHRleHRXaXRoQ3Vyc29yID0gYmVmb3JlQ3Vyc29yICsgbWFya2VyICsgY3Vyc29yQ2hhciArIGFmdGVyQ3Vyc29yO1xuXG5cdFx0Ly8gQ2FsY3VsYXRlIHZpc3VhbCB3aWR0aFxuXHRcdGNvbnN0IHZpc3VhbExlbmd0aCA9IHZpc2libGVXaWR0aCh0ZXh0V2l0aEN1cnNvcik7XG5cdFx0Y29uc3QgcGFkZGluZyA9IFwiIFwiLnJlcGVhdChNYXRoLm1heCgwLCBhdmFpbGFibGVXaWR0aCAtIHZpc3VhbExlbmd0aCkpO1xuXHRcdGNvbnN0IGxpbmUgPSBwcm9tcHQgKyB0ZXh0V2l0aEN1cnNvciArIHBhZGRpbmc7XG5cblx0XHRyZXR1cm4gW2xpbmVdO1xuXHR9XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxTQUFTLDRCQUE0QjtBQUNyQyxTQUFTLDRCQUE0QjtBQUNyQyxTQUFTLGdCQUFnQjtBQUN6QixTQUF5QixxQkFBcUM7QUFDOUQsU0FBUyxpQkFBaUI7QUFDMUIsU0FBUyxjQUFjLG1CQUFtQixrQkFBa0Isb0JBQW9CO0FBRWhGLE1BQU0sWUFBWSxhQUFhO0FBVXhCLE1BQU0sTUFBc0M7QUFBQSxFQUE1QztBQUNOLFNBQVEsUUFBZ0I7QUFDeEIsU0FBUSxTQUFpQjtBQUd6QixTQUFPLGNBQXNCO0FBRTdCO0FBQUEsU0FBTyxTQUFrQjtBQUd6QjtBQUFBLFNBQVEsV0FBb0I7QUFhNUI7QUFBQSxTQUFRLGNBQXNCO0FBQzlCLFNBQVEsWUFBcUI7QUFHN0I7QUFBQSxTQUFRLFdBQVcsSUFBSSxTQUFTO0FBQ2hDLFNBQVEsYUFBbUQ7QUFHM0Q7QUFBQSxTQUFRLFlBQVksSUFBSSxVQUFzQjtBQUFBO0FBQUEsRUFwQjlDLElBQUksVUFBbUI7QUFDdEIsV0FBTyxLQUFLO0FBQUEsRUFDYjtBQUFBLEVBQ0EsSUFBSSxRQUFRLE9BQWdCO0FBQzNCLFNBQUssV0FBVztBQUNoQixRQUFJLENBQUMsT0FBTztBQUNYLFdBQUssWUFBWTtBQUNqQixXQUFLLGNBQWM7QUFBQSxJQUNwQjtBQUFBLEVBQ0Q7QUFBQSxFQWFBLFdBQW1CO0FBQ2xCLFdBQU8sS0FBSztBQUFBLEVBQ2I7QUFBQSxFQUVBLFNBQVMsT0FBcUI7QUFDN0IsU0FBSyxRQUFRO0FBQ2IsU0FBSyxTQUFTLEtBQUssSUFBSSxLQUFLLFFBQVEsTUFBTSxNQUFNO0FBQUEsRUFDakQ7QUFBQSxFQUVBLFlBQVksTUFBb0I7QUFNL0IsUUFBSSxLQUFLLFNBQVMsV0FBVyxHQUFHO0FBQy9CLFdBQUssWUFBWTtBQUNqQixXQUFLLGNBQWM7QUFDbkIsYUFBTyxLQUFLLFFBQVEsYUFBYSxFQUFFO0FBQUEsSUFDcEM7QUFH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
