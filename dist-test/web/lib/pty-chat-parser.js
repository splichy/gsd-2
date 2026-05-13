function stripAnsi(s) {
  s = s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
  s = s.replace(/\x1b[P^_][^\x1b]*\x1b\\/g, "");
  s = s.replace(/\x1b\[[0-9;:<=>?]*[ -/]*[@-~]/g, "");
  s = s.replace(/\x1b[NO]./g, "");
  s = s.replace(/\x1b./g, "");
  s = s.replace(/\x1b/g, "");
  s = s.replace(/[^\n]*\r([^\n])/g, "$1");
  s = s.replace(/\r/g, "");
  return s;
}
const PROMPT_MARKERS = [
  /^❯\s*/,
  // Pi default primary prompt
  /^›\s*/,
  // Pi alternate prompt
  /^>(\s+|$)/,
  // Simple > prompt (some themes) — bare ">" or "> text"
  /^\$(\s+|$)/
  // Shell prompt fallback — bare "$" or "$ text"
];
const SYSTEM_LINE_PATTERNS = [
  /^\[connecting[.\u2026]*/i,
  /^\[connected\]/i,
  /^\[disconnected\]/i,
  /^\[auto\s+mode/i,
  /^\[auto-mode/i,
  /^\[thinking[.\u2026]*/i,
  /^\[done\]/i,
  /^\[error/i,
  /^gsd\s+v[\d.]+/i,
  // version banner
  /^✓\s/,
  // short success lines
  /^✗\s/
  // short failure lines
];
function isPromptLine(line) {
  const trimmed = line.trim();
  return PROMPT_MARKERS.some((r) => r.test(trimmed));
}
function isSystemLine(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  if (/^\[.*\]$/.test(trimmed) && trimmed.length < 80) return true;
  return SYSTEM_LINE_PATTERNS.some((r) => r.test(trimmed));
}
const SELECT_OPTION_SELECTED_RE = /^\s{0,4}›\s+(\d+)\.\s+(.+)/;
const SELECT_OPTION_UNSELECTED_RE = /^\s{3,6}(\d+)\.\s+(.+)/;
const CHECKBOX_SELECTED_RE = /^\s{0,4}›\s+\[([x ])\]\s+(.+)/i;
const BAR_LINE_RE = /^[─━─\-─]+$/;
const CLACK_PASSWORD_RE = /^[◆▲?]\s{1,3}(.+(?:API\s*key|password|token|secret)[^:]*):?\s*$/i;
const CLACK_TEXT_RE = /^[◆▲?]\s{1,3}(.+[?:])\s*$/;
const HINTS_RE = /↑|↓|arrow|enter to select|space to toggle/i;
const MIN_SELECT_OPTIONS = 2;
const SELECT_WINDOW_MS = 300;
const COMPLETION_DEBOUNCE_MS = 2e3;
function newId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === "x" ? r : r & 3 | 8).toString(16);
  });
}
class PtyChatParser {
  constructor(source = "default") {
    /** Raw byte buffer — accumulates across chunks until a boundary is found */
    this._buffer = "";
    /** Stable ordered message list */
    this._messages = [];
    /** Subscribers for message events */
    this._subscribers = /* @__PURE__ */ new Set();
    /** Subscribers for completion signals */
    this._completionSubscribers = /* @__PURE__ */ new Set();
    /** The message currently being built (not yet complete) */
    this._activeMessage = null;
    // ── TUI state ────────────────────────────────────────────────────────────────
    /**
     * Pending select block accumulator.
     * Lives until either: enough options arrive and the window closes,
     * or the window timer fires with too few options.
     */
    this._pendingSelect = null;
    /**
     * The last "question / header" line text seen before option lines start.
     * Reset when a new bar line appears.
     */
    this._lastHeaderText = "";
    /**
     * Timestamp of the last PTY input received — used for completion debounce.
     */
    this._lastInputAt = 0;
    /**
     * Set to true when main prompt line appears; cleared if more output arrives
     * before COMPLETION_DEBOUNCE_MS expires. Timer fires the signal.
     */
    this._completionTimer = null;
    /**
     * Whether we have already emitted a completion signal since the last
     * non-trivial output — guards against double-fire.
     */
    this._completionEmitted = false;
    /**
     * True when the parser has seen a prompt boundary and is waiting for user
     * input.  The next non-system, non-prompt, non-TUI content line after the
     * prompt is classified as role="user" instead of "assistant".
     * Reset to false once that user line arrives (or when a new assistant
     * message explicitly starts via a different signal).
     */
    this._awaitingInput = false;
    this._source = source;
  }
  // ── Public API ──────────────────────────────────────────────────────────────
  /**
   * Feed a raw PTY chunk (may contain ANSI codes, partial lines, etc.)
   */
  feed(chunk) {
    this._lastInputAt = Date.now();
    if (this._completionTimer) {
      clearTimeout(this._completionTimer);
      this._completionTimer = null;
    }
    this._buffer += chunk;
    this._process();
  }
  /** Return a shallow copy of the current message list */
  getMessages() {
    return [...this._messages];
  }
  /**
   * Returns true when the parser has detected a prompt boundary and is
   * waiting for user input.  Chat UIs can use this to show an "awaiting
   * input" indicator so the session does not appear stuck.
   */
  isAwaitingInput() {
    return this._awaitingInput;
  }
  /**
   * Flush any trailing partial buffer even if it does not end with a newline.
   * Useful for terminal UIs that leave the final status line unterminated.
   */
  flush() {
    if (this._buffer.length === 0) return;
    const stripped = stripAnsi(this._buffer);
    this._buffer = "";
    for (const rawLine of stripped.split("\n")) {
      const line = rawLine.trimEnd();
      if (line.length === 0) continue;
      this._handleLine(line);
    }
  }
  /**
   * Subscribe to message events (new message or content appended).
   * Returns an unsubscribe function.
   */
  onMessage(cb) {
    this._subscribers.add(cb);
    return () => this._subscribers.delete(cb);
  }
  /**
   * Subscribe to completion signals (GSD returned to idle prompt after ≥2s silence).
   * Returns an unsubscribe function.
   */
  onCompletionSignal(cb) {
    this._completionSubscribers.add(cb);
    return () => this._completionSubscribers.delete(cb);
  }
  /** Reset all state — useful when a new session starts */
  reset() {
    this._buffer = "";
    this._messages = [];
    this._activeMessage = null;
    this._pendingSelect = null;
    this._lastHeaderText = "";
    this._lastInputAt = 0;
    this._completionEmitted = false;
    this._awaitingInput = false;
    if (this._completionTimer) {
      clearTimeout(this._completionTimer);
      this._completionTimer = null;
    }
    console.debug("[pty-chat-parser] reset source=%s", this._source);
  }
  // ── Internal Processing ─────────────────────────────────────────────────────
  _process() {
    const lastNewline = this._buffer.lastIndexOf("\n");
    if (lastNewline === -1) return;
    const toProcess = this._buffer.slice(0, lastNewline + 1);
    this._buffer = this._buffer.slice(lastNewline + 1);
    const stripped = stripAnsi(toProcess);
    const lines = stripped.split("\n");
    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      this._handleLine(line);
    }
  }
  _handleLine(line) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      if (this._activeMessage?.role === "assistant") {
        this._appendToActive("\n");
      }
      return;
    }
    if (BAR_LINE_RE.test(trimmed)) {
      this._commitSelectBlock();
      this._lastHeaderText = "";
      if (this._activeMessage && !this._activeMessage.complete && this._activeMessage.role === "assistant") {
        this._appendToActive(line + "\n");
      }
      return;
    }
    const checkboxMatch = CHECKBOX_SELECTED_RE.exec(line);
    if (checkboxMatch) {
      this._handleCheckboxOption(checkboxMatch[1], checkboxMatch[2]);
      return;
    }
    const selectedMatch = SELECT_OPTION_SELECTED_RE.exec(line);
    if (selectedMatch) {
      this._handleSelectOption(parseInt(selectedMatch[1], 10), selectedMatch[2], true);
      return;
    }
    const unselectedMatch = SELECT_OPTION_UNSELECTED_RE.exec(line);
    if (unselectedMatch && !SELECT_OPTION_SELECTED_RE.test(line)) {
      this._handleSelectOption(parseInt(unselectedMatch[1], 10), unselectedMatch[2], false);
      return;
    }
    if (HINTS_RE.test(trimmed)) {
      this._commitSelectBlock();
      if (this._activeMessage && !this._activeMessage.complete && this._activeMessage.role === "assistant") {
        this._appendToActive(line + "\n");
      }
      return;
    }
    if (isPromptLine(trimmed)) {
      this._commitSelectBlock();
      if (this._activeMessage) {
        this._completeActive();
        console.debug(
          "[pty-chat-parser] boundary: prompt detected, completed msg=%s role=%s source=%s",
          this._activeMessage?.id ?? "(none)",
          this._activeMessage?.role ?? "(none)",
          this._source
        );
      }
      this._scheduleCompletionSignal();
      const userText = trimmed.replace(PROMPT_MARKERS[0], "").replace(PROMPT_MARKERS[1], "").replace(PROMPT_MARKERS[2], "").replace(PROMPT_MARKERS[3], "").trim();
      if (userText.length > 0) {
        const msg = this._startMessage("user", userText);
        this._completeMessage(msg);
        this._awaitingInput = false;
      } else {
        this._awaitingInput = true;
      }
      return;
    }
    if (isSystemLine(trimmed)) {
      if (this._activeMessage && this._activeMessage.role !== "system") {
        this._completeActive();
      }
      const msg = this._startMessage("system", trimmed);
      this._completeMessage(msg);
      console.debug(
        "[pty-chat-parser] system line detected id=%s source=%s",
        msg.id,
        this._source
      );
      return;
    }
    const passwordMatch = CLACK_PASSWORD_RE.exec(trimmed);
    if (passwordMatch) {
      this._handlePasswordPrompt(passwordMatch[1]);
      return;
    }
    const textMatch = CLACK_TEXT_RE.exec(trimmed);
    if (textMatch) {
      this._handleTextPrompt(textMatch[1]);
      return;
    }
    if (this._looksLikeQuestionHeader(line)) {
      this._lastHeaderText = trimmed;
    }
    if (this._awaitingInput) {
      this._awaitingInput = false;
      const msg = this._startMessage("user", trimmed);
      this._completeMessage(msg);
      console.debug(
        "[pty-chat-parser] user input detected (post-prompt echo) id=%s source=%s",
        msg.id,
        this._source
      );
      return;
    }
    if (this._activeMessage === null || this._activeMessage.complete || this._activeMessage.role !== "assistant") {
      this._activeMessage = this._startMessage("assistant", "");
      console.debug(
        "[pty-chat-parser] role boundary: started assistant msg=%s source=%s",
        this._activeMessage.id,
        this._source
      );
    }
    this._appendToActive(line + "\n");
  }
  // ── TUI Prompt Handlers ─────────────────────────────────────────────────────
  _handleSelectOption(num, label, isSelected) {
    const cleanLabel = label.trim();
    if (!this._pendingSelect) {
      this._pendingSelect = {
        label: this._lastHeaderText,
        options: [],
        windowTimer: null,
        firstLineAt: Date.now()
      };
      this._pendingSelect.windowTimer = setTimeout(() => {
        this._commitSelectBlock();
      }, SELECT_WINDOW_MS);
    }
    const block = this._pendingSelect;
    const existing = block.options.find((o) => o.index === num);
    if (existing) {
      existing.label = cleanLabel;
      existing.selected = isSelected;
    } else {
      block.options.push({ index: num, label: cleanLabel, selected: isSelected });
    }
  }
  _handleCheckboxOption(checked, label) {
    const isSelected = checked.toLowerCase() === "x";
    this._handleSelectOption(this._pendingSelect?.options.length ?? 0 + 1, label, isSelected);
  }
  _handlePasswordPrompt(label) {
    if (!this._activeMessage || this._activeMessage.complete || this._activeMessage.role !== "assistant") {
      this._activeMessage = this._startMessage("assistant", "");
    }
    const prompt = {
      kind: "password",
      label: label.trim(),
      options: [],
      selectedIndex: 0
    };
    this._activeMessage.prompt = prompt;
    this._notify(this._activeMessage);
    console.debug(
      "[pty-chat-parser] tui prompt detected kind=password source=%s",
      this._source
    );
  }
  _handleTextPrompt(label) {
    if (!this._activeMessage || this._activeMessage.complete || this._activeMessage.role !== "assistant") {
      this._activeMessage = this._startMessage("assistant", "");
    }
    const prompt = {
      kind: "text",
      label: label.trim(),
      options: [],
      selectedIndex: 0
    };
    this._activeMessage.prompt = prompt;
    this._notify(this._activeMessage);
    console.debug(
      "[pty-chat-parser] tui prompt detected kind=text label=%s source=%s",
      label.trim(),
      this._source
    );
  }
  _commitSelectBlock() {
    if (!this._pendingSelect) return;
    const block = this._pendingSelect;
    this._pendingSelect = null;
    if (block.windowTimer) {
      clearTimeout(block.windowTimer);
    }
    if (block.options.length < MIN_SELECT_OPTIONS) {
      return;
    }
    block.options.sort((a, b) => a.index - b.index);
    const selectedOpt = block.options.find((o) => o.selected);
    const selectedIndex = selectedOpt ? block.options.indexOf(selectedOpt) : 0;
    const prompt = {
      kind: "select",
      label: block.label,
      options: block.options.map((o) => o.label),
      selectedIndex
    };
    if (!this._activeMessage || this._activeMessage.complete || this._activeMessage.role !== "assistant") {
      this._activeMessage = this._startMessage("assistant", "");
    }
    this._activeMessage.prompt = prompt;
    this._notify(this._activeMessage);
    console.debug(
      "[pty-chat-parser] tui prompt detected kind=select options=%d selectedIndex=%d source=%s",
      prompt.options.length,
      selectedIndex,
      this._source
    );
  }
  /**
   * Returns true if a stripped line looks like a question/header text that
   * precedes a select list. Criteria: non-empty, not a system line, not an
   * option line, and appeared after a bar separator.
   */
  _looksLikeQuestionHeader(line) {
    const trimmed = line.trim();
    if (trimmed.length === 0) return false;
    if (BAR_LINE_RE.test(trimmed)) return false;
    if (isSystemLine(trimmed)) return false;
    if (SELECT_OPTION_SELECTED_RE.test(line)) return false;
    if (SELECT_OPTION_UNSELECTED_RE.test(line)) return false;
    if (CHECKBOX_SELECTED_RE.test(line)) return false;
    return this._lastHeaderText === "" || this._pendingSelect !== null;
  }
  // ── Completion Signal ────────────────────────────────────────────────────────
  /**
   * Schedule a CompletionSignal to fire after COMPLETION_DEBOUNCE_MS of silence.
   * Any subsequent PTY input in feed() cancels and resets the timer (see feed()).
   */
  _scheduleCompletionSignal() {
    if (this._completionTimer) {
      clearTimeout(this._completionTimer);
    }
    this._completionEmitted = false;
    const scheduledAt = Date.now();
    this._completionTimer = setTimeout(() => {
      this._completionTimer = null;
      if (this._completionEmitted) return;
      const elapsed = Date.now() - scheduledAt;
      this._completionEmitted = true;
      const signal = {
        source: this._source,
        timestamp: Date.now()
      };
      console.debug(
        "[pty-chat-parser] completion signal emitted source=%s debounce=%dms",
        this._source,
        elapsed
      );
      for (const cb of this._completionSubscribers) {
        try {
          cb(signal);
        } catch {
        }
      }
    }, COMPLETION_DEBOUNCE_MS);
    console.debug(
      "[pty-chat-parser] completion signal scheduled (debounce=%dms) source=%s",
      COMPLETION_DEBOUNCE_MS,
      this._source
    );
  }
  // ── Message Lifecycle ───────────────────────────────────────────────────────
  _startMessage(role, content) {
    const msg = {
      id: newId(),
      role,
      content,
      complete: false,
      timestamp: Date.now()
    };
    this._messages.push(msg);
    this._activeMessage = msg;
    this._notify(msg);
    return msg;
  }
  _appendToActive(text) {
    if (!this._activeMessage || this._activeMessage.complete) return;
    this._activeMessage.content += text;
    this._notify(this._activeMessage);
  }
  _completeActive() {
    if (!this._activeMessage || this._activeMessage.complete) return;
    this._completeMessage(this._activeMessage);
  }
  _completeMessage(msg) {
    msg.content = msg.content.trimEnd();
    msg.complete = true;
    if (this._activeMessage === msg) this._activeMessage = null;
    this._notify(msg);
    console.debug(
      "[pty-chat-parser] message complete id=%s role=%s source=%s",
      msg.id,
      msg.role,
      this._source
    );
  }
  _notify(msg) {
    for (const cb of this._subscribers) {
      try {
        cb(msg);
      } catch {
      }
    }
  }
}
export {
  PtyChatParser,
  stripAnsi
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vd2ViL2xpYi9wdHktY2hhdC1wYXJzZXIudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogUHR5Q2hhdFBhcnNlciBcdTIwMTQgQU5TSSBzdHJpcHBlciwgbWVzc2FnZSBzZWdtZW50ZXIsIHJvbGUgY2xhc3NpZmllcixcbiAqIFRVSSBwcm9tcHQgZGV0ZWN0b3IsIGFuZCBjb21wbGV0aW9uIHNpZ25hbCBlbWl0dGVyLlxuICpcbiAqIEFjY2VwdHMgcmF3IFBUWSBieXRlIGNodW5rcyBmcm9tIHRoZSAvYXBpL3Rlcm1pbmFsL3N0cmVhbSBTU0UgZmVlZFxuICogKHsgdHlwZTogXCJvdXRwdXRcIiwgZGF0YTogc3RyaW5nIH0gcGF5bG9hZHMpIGFuZCBwcm9kdWNlcyBhIHN0cnVjdHVyZWRcbiAqIENoYXRNZXNzYWdlW10gdGhhdCBkb3duc3RyZWFtIGNoYXQgcmVuZGVyaW5nIGNvbXBvbmVudHMgY2FuIGNvbnN1bWUuXG4gKlxuICogRGVzaWduIHByaW5jaXBsZXM6XG4gKiAtIE5vIHh0ZXJtLmpzIGRlcGVuZGVuY3kgXHUyMDE0IHB1cmUgc3RyaW5nIHByb2Nlc3NpbmdcbiAqIC0gRGV0ZXJtaW5pc3RpYyBnaXZlbiB0aGUgc2FtZSBpbnB1dCBzZXF1ZW5jZVxuICogLSBMb2dzIHN0cnVjdHVyYWwgc2lnbmFscyBvbmx5IFx1MjAxNCBuZXZlciByYXcgUFRZIGNvbnRlbnQgKG1heSBjb250YWluIHNlY3JldHMpXG4gKiAtIERlYnVnLWxldmVsIGNvbnNvbGUuZGVidWcgdW5kZXIgW3B0eS1jaGF0LXBhcnNlcl0gcHJlZml4XG4gKlxuICogVFVJIGRldGVjdGlvbiBwYXR0ZXJucyAoYWZ0ZXIgQU5TSSBzdHJpcHBpbmcpOlxuICogLSBTZWxlY3QgbGlzdDogbGluZXMgc3RhcnRpbmcgd2l0aCBcIiAgXHUyMDNBIE4uXCIgKHNlbGVjdGVkKSBvciBcIiAgICBOLlwiICh1bnNlbGVjdGVkKVxuICogICBVc2VzIEdTRCdzIHNoYXJlZCBVSSBjdXJzb3IgZ2x5cGggXCJcdTIwM0FcIlxuICogLSBDaGVja2JveDogbGluZXMgc3RhcnRpbmcgd2l0aCBcIiAgXHUyMDNBIFt4XVwiIG9yIFwiICBcdTIwM0EgWyBdXCIgKG11bHRpLXNlbGVjdClcbiAqIC0gUGFzc3dvcmQvdGV4dDogQGNsYWNrL3Byb21wdHMgXCJcdTI1QzYgIFwiIG9yIFwiP1wiIHByZWZpeCArIGxhYmVsIGVuZGluZyB3aXRoIFwiOlwiXG4gKiAtIENvbXBsZXRpb246IG1haW4gcHJvbXB0IChcdTI3NkYgLyBcdTIwM0EgLyA+IC8gJCkgcmVhcHBlYXJzIGFmdGVyIFx1MjI2NTJzIG9mIG5vIG91dHB1dFxuICovXG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBQdWJsaWMgVHlwZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCB0eXBlIE1lc3NhZ2VSb2xlID0gXCJ1c2VyXCIgfCBcImFzc2lzdGFudFwiIHwgXCJzeXN0ZW1cIlxuXG5leHBvcnQgaW50ZXJmYWNlIFR1aVByb21wdCB7XG4gIGtpbmQ6IFwic2VsZWN0XCIgfCBcInRleHRcIiB8IFwicGFzc3dvcmRcIlxuICAvKiogVGhlIHByb21wdCBsYWJlbCAvIHF1ZXN0aW9uIHRleHQgKi9cbiAgbGFiZWw6IHN0cmluZ1xuICAvKiogRm9yIHNlbGVjdCBwcm9tcHRzOiB0aGUgbGlzdCBvZiBvcHRpb24gbGFiZWxzICovXG4gIG9wdGlvbnM6IHN0cmluZ1tdXG4gIC8qKiBGb3Igc2VsZWN0IHByb21wdHM6IG9wdGlvbmFsIHBlci1vcHRpb24gZGVzY3JpcHRpb25zICovXG4gIGRlc2NyaXB0aW9ucz86IHN0cmluZ1tdXG4gIC8qKiBGb3Igc2VsZWN0IHByb21wdHM6IHRoZSBjdXJyZW50bHkgaGlnaGxpZ2h0ZWQgb3B0aW9uIGluZGV4ICgwLWJhc2VkKSAqL1xuICBzZWxlY3RlZEluZGV4OiBudW1iZXJcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDb21wbGV0aW9uU2lnbmFsIHtcbiAgLyoqIFRoZSBzZXNzaW9uIG9yIGNvbnRleHQgc291cmNlIHRoaXMgc2lnbmFsIGNhbWUgZnJvbSAqL1xuICBzb3VyY2U6IHN0cmluZ1xuICAvKiogVW5peCB0aW1lc3RhbXAgKG1zKSB3aGVuIHRoZSBzaWduYWwgd2FzIGVtaXR0ZWQgKi9cbiAgdGltZXN0YW1wOiBudW1iZXJcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDaGF0TWVzc2FnZSB7XG4gIC8qKiBTdGFibGUgVVVJRCBcdTIwMTQgc2FtZSBvYmplY3QgbXV0YXRlZCBpbiBwbGFjZSB3aGlsZSBzdHJlYW1pbmcgKi9cbiAgaWQ6IHN0cmluZ1xuICByb2xlOiBNZXNzYWdlUm9sZVxuICAvKiogQU5TSS1zdHJpcHBlZCBjb250ZW50ICovXG4gIGNvbnRlbnQ6IHN0cmluZ1xuICAvKiogZmFsc2Ugd2hpbGUgc3RyZWFtaW5nLCB0cnVlIHdoZW4gYSBib3VuZGFyeSBoYXMgYmVlbiBkZXRlY3RlZCAqL1xuICBjb21wbGV0ZTogYm9vbGVhblxuICAvKiogU2V0IHdoZW4gYSBUVUkgcHJvbXB0IGlzIGRldGVjdGVkIGluc2lkZSB0aGlzIG1lc3NhZ2UgKi9cbiAgcHJvbXB0PzogVHVpUHJvbXB0XG4gIC8qKiBVbml4IHRpbWVzdGFtcCAobXMpIG9mIGZpcnN0IGNvbnRlbnQgKi9cbiAgdGltZXN0YW1wOiBudW1iZXJcbiAgLyoqIE9wdGlvbmFsIGltYWdlcyBhdHRhY2hlZCBieSB0aGUgdXNlciAoY2hhdCBtb2RlIG9ubHkgXHUyMDE0IFBUWSBwYXJzZXIgbmV2ZXIgc2V0cyB0aGlzKSAqL1xuICBpbWFnZXM/OiB7IGRhdGE6IHN0cmluZzsgbWltZVR5cGU6IHN0cmluZyB9W11cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFN1YnNjcmliZXIgVHlwZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnR5cGUgTWVzc2FnZUNhbGxiYWNrID0gKG1lc3NhZ2U6IENoYXRNZXNzYWdlKSA9PiB2b2lkXG50eXBlIENvbXBsZXRpb25DYWxsYmFjayA9IChzaWduYWw6IENvbXBsZXRpb25TaWduYWwpID0+IHZvaWRcbnR5cGUgVW5zdWJzY3JpYmUgPSAoKSA9PiB2b2lkXG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBBTlNJIFN0cmlwcGVyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIHN0cmlwQW5zaSBcdTIwMTQgcmVtb3ZlIGFsbCBBTlNJL1ZUMTAwIGVzY2FwZSBzZXF1ZW5jZXMgZnJvbSBhIHN0cmluZy5cbiAqXG4gKiBIYW5kbGVzOlxuICogLSBDU0kgc2VxdWVuY2VzOiBcXHgxYlsgLi4uIGZpbmFsLWJ5dGUgKHBhcmFtcyArIG9wdGlvbmFsIGludGVybWVkaWF0ZXMpXG4gKiAtIE9TQyBzZXF1ZW5jZXM6IFxceDFiXSAuLi4gXFx4MDcgb3IgXFx4MWJcXFxcXG4gKiAtIFNTMi9TUzM6IFxceDFiTiwgXFx4MWJPICsgb25lIGNoYXJcbiAqIC0gRENTL1BNL0FQQzogXFx4MWJQL1xceDFiXi9cXHgxYl8gLi4uIFxceDFiXFxcXFxuICogLSBTaW1wbGUgRVNDICsgb25lIGNoYXIgKGUuZy4gXFx4MWJNIHJldmVyc2UgaW5kZXgpXG4gKiAtIEJhcmUgXFxyIGF0IGxpbmUgc3RhcnQgKG92ZXJ3cml0ZSBwYXR0ZXJuKSBcdTIxOTIgbm9ybWFsaXNlZCB0byBcXG5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN0cmlwQW5zaShzOiBzdHJpbmcpOiBzdHJpbmcge1xuICAvLyBPU0M6IFxceDFiXSAuLi4gKFxceDA3IG9yIFxceDFiXFwpXG4gICBcbiAgcyA9IHMucmVwbGFjZSgvXFx4MWJcXF1bXlxceDA3XFx4MWJdKig/OlxceDA3fFxceDFiXFxcXCkvZywgXCJcIilcbiAgLy8gRENTIC8gUE0gLyBBUEM6IFxceDFiUCwgXFx4MWJeLCBcXHgxYl8gLi4uIFxceDFiXFxcbiAgIFxuICBzID0gcy5yZXBsYWNlKC9cXHgxYltQXl9dW15cXHgxYl0qXFx4MWJcXFxcL2csIFwiXCIpXG4gIC8vIENTSTogXFx4MWJbIC4uLiBmaW5hbCBieXRlICgweDQwXHUyMDEzMHg3ZSlcbiAgIFxuICBzID0gcy5yZXBsYWNlKC9cXHgxYlxcW1swLTk7Ojw9Pj9dKlsgLS9dKltALX5dL2csIFwiXCIpXG4gIC8vIFNTMiAvIFNTMzogXFx4MWIoTnxPKSArIG9uZSBjaGFyXG4gICBcbiAgcyA9IHMucmVwbGFjZSgvXFx4MWJbTk9dLi9nLCBcIlwiKVxuICAvLyBBbGwgcmVtYWluaW5nIEVTQyArIG9uZSBjaGFyIChlLmcuIFxceDFiTSwgXFx4MWI3LCBcXHgxYjgsIFxceDFiPSwgZXRjLilcbiAgIFxuICBzID0gcy5yZXBsYWNlKC9cXHgxYi4vZywgXCJcIilcbiAgLy8gU3RyYXkgbG9uZSBcXHgxYiB3aXRoIG5vIGZvbGxvd2luZyBjaGFyXG4gICBcbiAgcyA9IHMucmVwbGFjZSgvXFx4MWIvZywgXCJcIilcbiAgLy8gXFxyIGZvbGxvd2VkIGJ5IGNvbnRlbnQgb3ZlcndyaXRlcyB0aGUgY3VycmVudCBsaW5lIFx1MjAxNCBrZWVwIHRoZSB0YWlsIG9ubHlcbiAgLy8gZS5nLiBcIm9sZCBjb250ZW50XFxybmV3IGNvbnRlbnRcIiBcdTIxOTIgXCJuZXcgY29udGVudFwiXG4gIHMgPSBzLnJlcGxhY2UoL1teXFxuXSpcXHIoW15cXG5dKS9nLCBcIiQxXCIpXG4gIC8vIFJlbWFpbmluZyBiYXJlIFxcciBcdTIxOTIgc3RyaXBcbiAgcyA9IHMucmVwbGFjZSgvXFxyL2csIFwiXCIpXG4gIHJldHVybiBzXG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBSb2xlIC8gQm91bmRhcnkgSGV1cmlzdGljcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBHU0QgcHJvbXB0IG1hcmtlcnMgdGhhdCBzaWduYWwgdGhlIGJvdW5kYXJ5IGJldHdlZW4gdHVybnMuXG4gKiBBZnRlciBBTlNJIHN0cmlwcGluZywgR1NEJ3MgUGkgYWdlbnQgc2hvd3Mgb25lIG9mIHRoZXNlIGF0IHRoZSBzdGFydFxuICogb2YgYSBsaW5lIHdoZW4gd2FpdGluZyBmb3IgdXNlciBpbnB1dC5cbiAqL1xuY29uc3QgUFJPTVBUX01BUktFUlMgPSBbXG4gIC9eXHUyNzZGXFxzKi8sICAgICAvLyBQaSBkZWZhdWx0IHByaW1hcnkgcHJvbXB0XG4gIC9eXHUyMDNBXFxzKi8sICAgICAvLyBQaSBhbHRlcm5hdGUgcHJvbXB0XG4gIC9ePihcXHMrfCQpLywgIC8vIFNpbXBsZSA+IHByb21wdCAoc29tZSB0aGVtZXMpIFx1MjAxNCBiYXJlIFwiPlwiIG9yIFwiPiB0ZXh0XCJcbiAgL15cXCQoXFxzK3wkKS8sIC8vIFNoZWxsIHByb21wdCBmYWxsYmFjayBcdTIwMTQgYmFyZSBcIiRcIiBvciBcIiQgdGV4dFwiXG5dXG5cbi8qKlxuICogU3lzdGVtL3N0YXR1cyBsaW5lczogc2hvcnQsIGJyYWNrZXQtd3JhcHBlZCBtZXNzYWdlcyB0aGF0IEdTRCBlbWl0c1xuICogYXQgd2VsbC1rbm93biBsaWZlY3ljbGUgcG9pbnRzLlxuICovXG5jb25zdCBTWVNURU1fTElORV9QQVRURVJOUyA9IFtcbiAgL15cXFtjb25uZWN0aW5nWy5cXHUyMDI2XSovaSxcbiAgL15cXFtjb25uZWN0ZWRcXF0vaSxcbiAgL15cXFtkaXNjb25uZWN0ZWRcXF0vaSxcbiAgL15cXFthdXRvXFxzK21vZGUvaSxcbiAgL15cXFthdXRvLW1vZGUvaSxcbiAgL15cXFt0aGlua2luZ1suXFx1MjAyNl0qL2ksXG4gIC9eXFxbZG9uZVxcXS9pLFxuICAvXlxcW2Vycm9yL2ksXG4gIC9eZ3NkXFxzK3ZbXFxkLl0rL2ksICAgICAgIC8vIHZlcnNpb24gYmFubmVyXG4gIC9eXHUyNzEzXFxzLywgICAgICAgICAgICAgICAgICAgLy8gc2hvcnQgc3VjY2VzcyBsaW5lc1xuICAvXlx1MjcxN1xccy8sICAgICAgICAgICAgICAgICAgIC8vIHNob3J0IGZhaWx1cmUgbGluZXNcbl1cblxuLyoqIFJldHVybnMgdHJ1ZSBpZiB0aGUgKHN0cmlwcGVkKSBsaW5lIGxvb2tzIGxpa2UgYSBHU0QgaW5wdXQgcHJvbXB0ICovXG5mdW5jdGlvbiBpc1Byb21wdExpbmUobGluZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IHRyaW1tZWQgPSBsaW5lLnRyaW0oKVxuICByZXR1cm4gUFJPTVBUX01BUktFUlMuc29tZSgocikgPT4gci50ZXN0KHRyaW1tZWQpKVxufVxuXG4vKiogUmV0dXJucyB0cnVlIGlmIHRoZSAoc3RyaXBwZWQpIGxpbmUgbG9va3MgbGlrZSBhIHN5c3RlbSBzdGF0dXMgbWVzc2FnZSAqL1xuZnVuY3Rpb24gaXNTeXN0ZW1MaW5lKGxpbmU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCB0cmltbWVkID0gbGluZS50cmltKClcbiAgaWYgKHRyaW1tZWQubGVuZ3RoID09PSAwKSByZXR1cm4gZmFsc2VcbiAgLy8gU2hvcnQgYnJhY2tldC13cmFwcGVkIGxpbmVzXG4gIGlmICgvXlxcWy4qXFxdJC8udGVzdCh0cmltbWVkKSAmJiB0cmltbWVkLmxlbmd0aCA8IDgwKSByZXR1cm4gdHJ1ZVxuICByZXR1cm4gU1lTVEVNX0xJTkVfUEFUVEVSTlMuc29tZSgocikgPT4gci50ZXN0KHRyaW1tZWQpKVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVFVJIFByb21wdCBEZXRlY3Rpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogR1NEJ3Mgc2hhcmVkIFVJIHVzZXMgXCJcdTIwM0FcIiBhcyBjdXJzb3IgZ2x5cGggKEdMWVBILmN1cnNvciA9IFwiXHUyMDNBXCIpXG4gKiBBZnRlciBBTlNJIHN0cmlwcGluZywgYSBzZWxlY3RlZCBvcHRpb24gcmVuZGVycyBhczpcbiAqICAgXCIgIFx1MjAzQSBOLiBMYWJlbFwiICAod2l0aCBsZWFkaW5nIHNwYWNlcyBmcm9tIElOREVOVC5vcHRpb24pXG4gKiBBbiB1bnNlbGVjdGVkIG9wdGlvbiByZW5kZXJzIGFzOlxuICogICBcIiAgICBOLiBMYWJlbFwiICAoNCBzcGFjZXMgaW5zdGVhZCBvZiBjdXJzb3IpXG4gKiBEZXNjcmlwdGlvbiBsaW5lcyByZW5kZXIgaW5kZW50ZWQgKDUgc3BhY2VzKTogXCIgICAgIFNvbWUgZGVzY3JpcHRpb25cIlxuICpcbiAqIENoZWNrYm94IHNlbGVjdGVkOiAgXCIgIFx1MjAzQSBbeF0gTGFiZWxcIlxuICogQ2hlY2tib3ggdW5zZWxlY3RlZDogXCIgIFx1MjAzQSBbIF0gTGFiZWxcIiBvciBcIiAgICBbIF0gTGFiZWxcIlxuICpcbiAqIEEgc2VsZWN0IGJsb2NrIHN0YXJ0cyB3aXRoIGEgYmFyIGxpbmUgKFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMCkgb3IgaGVhZGVyIGxpbmUgYW5kXG4gKiBjb250YWlucyBcdTIyNjUyIG51bWJlcmVkIG9wdGlvbiBsaW5lcyB3aXRoaW4gYSBzaG9ydCB0aW1lIHdpbmRvdy5cbiAqL1xuXG4vKiogTWF0Y2hlcyBhIEdTRCBzZWxlY3RlZCBvcHRpb24gbGluZTogXCIgIFx1MjAzQSBOLiBMYWJlbFwiICovXG5jb25zdCBTRUxFQ1RfT1BUSU9OX1NFTEVDVEVEX1JFID0gL15cXHN7MCw0fVx1MjAzQVxccysoXFxkKylcXC5cXHMrKC4rKS9cblxuLyoqIE1hdGNoZXMgYSBHU0QgdW5zZWxlY3RlZCBvcHRpb24gbGluZTogXCIgICAgTi4gTGFiZWxcIiAqL1xuY29uc3QgU0VMRUNUX09QVElPTl9VTlNFTEVDVEVEX1JFID0gL15cXHN7Myw2fShcXGQrKVxcLlxccysoLispL1xuXG4vKiogTWF0Y2hlcyBhIEdTRCBjaGVja2JveCBvcHRpb246IFwiICBcdTIwM0EgW3hdIExhYmVsXCIgb3IgXCIgIFx1MjAzQSBbIF0gTGFiZWxcIiAqL1xuY29uc3QgQ0hFQ0tCT1hfU0VMRUNURURfUkUgPSAvXlxcc3swLDR9XHUyMDNBXFxzK1xcWyhbeCBdKVxcXVxccysoLispL2lcblxuLyoqIE1hdGNoZXMgYSBHU0Qgc2VwYXJhdG9yIGJhciBsaW5lOiBhbGwgXHUyNTAwIGNoYXJhY3RlcnMgKi9cbmNvbnN0IEJBUl9MSU5FX1JFID0gL15bXHUyNTAwXHUyNTAxXHUyNTAwXFwtXHUyNTAwXSskL1xuXG4vKipcbiAqIE1hdGNoZXMgQGNsYWNrL3Byb21wdHMgcGFzc3dvcmQgcHJvbXB0IGxpbmVzOlxuICogLSBcIlx1MjVDNiAgU29tZSBsYWJlbDpcIiAoY2xhY2sgdXNlcyBcdTI1QzYgYXMgcXVlc3Rpb24gbWFya2VyKVxuICogLSBcIj8gIFNvbWUgbGFiZWw6XCIgKGFsdGVybmF0aXZlIGNsYWNrIHN0eWxlKVxuICogLSBcIlx1MjVCMiAgU29tZSBsYWJlbDpcIiAoYW5vdGhlciBjbGFjayB2YXJpYW50KVxuICovXG5jb25zdCBDTEFDS19QQVNTV09SRF9SRSA9IC9eW1x1MjVDNlx1MjVCMj9dXFxzezEsM30oLisoPzpBUElcXHMqa2V5fHBhc3N3b3JkfHRva2VufHNlY3JldClbXjpdKik6P1xccyokL2lcblxuLyoqXG4gKiBNYXRjaGVzIEdTRCB0ZXh0IGlucHV0IHByb21wdHMgXHUyMDE0IEBjbGFjayBzdHlsZSBvciBiYXJlIGxhYmVsZWQgcHJvbXB0czpcbiAqIC0gXCJcdTI1QzYgIEVudGVyIHByb2plY3QgbmFtZTpcIlxuICogLSBcIj8gIFdoYXQgaXMgeW91ciBuYW1lP1wiXG4gKi9cbmNvbnN0IENMQUNLX1RFWFRfUkUgPSAvXltcdTI1QzZcdTI1QjI/XVxcc3sxLDN9KC4rWz86XSlcXHMqJC9cblxuLyoqXG4gKiBNYXRjaGVzIGhpbnRzIGxpbmUgcmVuZGVyZWQgYnkgR1NEJ3Mgc2hhcmVkIFVJOlxuICogXCIgIFx1MjE5MS9cdTIxOTMgdG8gbW92ZSAgfCAgZW50ZXIgdG8gc2VsZWN0XCJcbiAqIFRoZXNlIGFwcGVhciBiZWxvdyBzZWxlY3QgbGlzdHMgYW5kIGhlbHAgY29uZmlybSBhIHNlbGVjdCBibG9jayBpcyBhY3RpdmUuXG4gKi9cbmNvbnN0IEhJTlRTX1JFID0gL1x1MjE5MXxcdTIxOTN8YXJyb3d8ZW50ZXIgdG8gc2VsZWN0fHNwYWNlIHRvIHRvZ2dsZS9pXG5cbi8qKiBNaW5pbXVtIG9wdGlvbiBsaW5lcyBuZWVkZWQgdG8gcmVjb2duaXNlIGEgc2VsZWN0IGJsb2NrICovXG5jb25zdCBNSU5fU0VMRUNUX09QVElPTlMgPSAyXG5cbi8qKiBNYXggbXMgdG8gYWNjdW11bGF0ZSBzZWxlY3Qgb3B0aW9uIGxpbmVzIGJlZm9yZSBjb21taXR0aW5nIHRoZSBibG9jayAqL1xuY29uc3QgU0VMRUNUX1dJTkRPV19NUyA9IDMwMFxuXG4vKipcbiAqIE1pbmltdW0gbWlsbGlzZWNvbmRzIG9mIHNpbGVuY2UgKG5vIFBUWSBvdXRwdXQpIGFmdGVyIHRoZSBtYWluIHByb21wdFxuICogcmUtYXBwZWFycyBiZWZvcmUgYSBDb21wbGV0aW9uU2lnbmFsIGlzIGVtaXR0ZWQuXG4gKiBDb25zZXJ2YXRpdmU6IGZhbHNlIHBvc2l0aXZlcyAocHJlbWF0dXJlIGNsb3NlKSBhcmUgd29yc2UgdGhhbiBuZWdhdGl2ZXMuXG4gKi9cbmNvbnN0IENPTVBMRVRJT05fREVCT1VOQ0VfTVMgPSAyMDAwXG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBVVUlEIFV0aWxpdHkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIG5ld0lkKCk6IHN0cmluZyB7XG4gIGlmICh0eXBlb2YgY3J5cHRvICE9PSBcInVuZGVmaW5lZFwiICYmIGNyeXB0by5yYW5kb21VVUlEKSB7XG4gICAgcmV0dXJuIGNyeXB0by5yYW5kb21VVUlEKClcbiAgfVxuICAvLyBGYWxsYmFjayBmb3IgZW52aXJvbm1lbnRzIHdpdGhvdXQgY3J5cHRvLnJhbmRvbVVVSURcbiAgcmV0dXJuIFwieHh4eHh4eHgteHh4eC00eHh4LXl4eHgteHh4eHh4eHh4eHh4XCIucmVwbGFjZSgvW3h5XS9nLCAoYykgPT4ge1xuICAgIGNvbnN0IHIgPSAoTWF0aC5yYW5kb20oKSAqIDE2KSB8IDBcbiAgICByZXR1cm4gKGMgPT09IFwieFwiID8gciA6IChyICYgMHgzKSB8IDB4OCkudG9TdHJpbmcoMTYpXG4gIH0pXG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTZWxlY3QgQmxvY2sgQWNjdW11bGF0b3IgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmludGVyZmFjZSBTZWxlY3RPcHRpb24ge1xuICBpbmRleDogbnVtYmVyICAgIC8vIDEtYmFzZWQgYXMgcmVuZGVyZWQgYnkgR1NEXG4gIGxhYmVsOiBzdHJpbmdcbiAgc2VsZWN0ZWQ6IGJvb2xlYW5cbn1cblxuaW50ZXJmYWNlIFNlbGVjdEJsb2NrIHtcbiAgbGFiZWw6IHN0cmluZyAgICAgICAgICAgLy8gcXVlc3Rpb24vaGVhZGVyIHRleHQgYWJvdmUgdGhlIG9wdGlvbnNcbiAgb3B0aW9uczogU2VsZWN0T3B0aW9uW11cbiAgd2luZG93VGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbFxuICBmaXJzdExpbmVBdDogbnVtYmVyXG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBQdHlDaGF0UGFyc2VyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFB0eUNoYXRQYXJzZXIgXHUyMDE0IHN0YXRlZnVsIHBhcnNlciBmb3IgcmF3IFBUWSBvdXRwdXQuXG4gKlxuICogVXNhZ2U6XG4gKiAgIGNvbnN0IHBhcnNlciA9IG5ldyBQdHlDaGF0UGFyc2VyKClcbiAqICAgcGFyc2VyLm9uTWVzc2FnZSgobXNnKSA9PiBjb25zb2xlLmxvZyhtc2cpKVxuICogICAvLyBGZWVkIFNTRSBvdXRwdXQgY2h1bmtzOlxuICogICBlcy5vbm1lc3NhZ2UgPSAoZSkgPT4ge1xuICogICAgIGNvbnN0IHsgdHlwZSwgZGF0YSB9ID0gSlNPTi5wYXJzZShlLmRhdGEpXG4gKiAgICAgaWYgKHR5cGUgPT09ICdvdXRwdXQnKSBwYXJzZXIuZmVlZChkYXRhKVxuICogICB9XG4gKi9cbmV4cG9ydCBjbGFzcyBQdHlDaGF0UGFyc2VyIHtcbiAgLyoqIFJhdyBieXRlIGJ1ZmZlciBcdTIwMTQgYWNjdW11bGF0ZXMgYWNyb3NzIGNodW5rcyB1bnRpbCBhIGJvdW5kYXJ5IGlzIGZvdW5kICovXG4gIHByaXZhdGUgX2J1ZmZlciA9IFwiXCJcbiAgLyoqIFN0YWJsZSBvcmRlcmVkIG1lc3NhZ2UgbGlzdCAqL1xuICBwcml2YXRlIF9tZXNzYWdlczogQ2hhdE1lc3NhZ2VbXSA9IFtdXG4gIC8qKiBTdWJzY3JpYmVycyBmb3IgbWVzc2FnZSBldmVudHMgKi9cbiAgcHJpdmF0ZSBfc3Vic2NyaWJlcnMgPSBuZXcgU2V0PE1lc3NhZ2VDYWxsYmFjaz4oKVxuICAvKiogU3Vic2NyaWJlcnMgZm9yIGNvbXBsZXRpb24gc2lnbmFscyAqL1xuICBwcml2YXRlIF9jb21wbGV0aW9uU3Vic2NyaWJlcnMgPSBuZXcgU2V0PENvbXBsZXRpb25DYWxsYmFjaz4oKVxuICAvKiogU291cmNlIGxhYmVsIGZvciBDb21wbGV0aW9uU2lnbmFsICovXG4gIHByaXZhdGUgX3NvdXJjZTogc3RyaW5nXG4gIC8qKiBUaGUgbWVzc2FnZSBjdXJyZW50bHkgYmVpbmcgYnVpbHQgKG5vdCB5ZXQgY29tcGxldGUpICovXG4gIHByaXZhdGUgX2FjdGl2ZU1lc3NhZ2U6IENoYXRNZXNzYWdlIHwgbnVsbCA9IG51bGxcblxuICAvLyBcdTI1MDBcdTI1MDAgVFVJIHN0YXRlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4gIC8qKlxuICAgKiBQZW5kaW5nIHNlbGVjdCBibG9jayBhY2N1bXVsYXRvci5cbiAgICogTGl2ZXMgdW50aWwgZWl0aGVyOiBlbm91Z2ggb3B0aW9ucyBhcnJpdmUgYW5kIHRoZSB3aW5kb3cgY2xvc2VzLFxuICAgKiBvciB0aGUgd2luZG93IHRpbWVyIGZpcmVzIHdpdGggdG9vIGZldyBvcHRpb25zLlxuICAgKi9cbiAgcHJpdmF0ZSBfcGVuZGluZ1NlbGVjdDogU2VsZWN0QmxvY2sgfCBudWxsID0gbnVsbFxuXG4gIC8qKlxuICAgKiBUaGUgbGFzdCBcInF1ZXN0aW9uIC8gaGVhZGVyXCIgbGluZSB0ZXh0IHNlZW4gYmVmb3JlIG9wdGlvbiBsaW5lcyBzdGFydC5cbiAgICogUmVzZXQgd2hlbiBhIG5ldyBiYXIgbGluZSBhcHBlYXJzLlxuICAgKi9cbiAgcHJpdmF0ZSBfbGFzdEhlYWRlclRleHQgPSBcIlwiXG5cbiAgLyoqXG4gICAqIFRpbWVzdGFtcCBvZiB0aGUgbGFzdCBQVFkgaW5wdXQgcmVjZWl2ZWQgXHUyMDE0IHVzZWQgZm9yIGNvbXBsZXRpb24gZGVib3VuY2UuXG4gICAqL1xuICBwcml2YXRlIF9sYXN0SW5wdXRBdCA9IDBcblxuICAvKipcbiAgICogU2V0IHRvIHRydWUgd2hlbiBtYWluIHByb21wdCBsaW5lIGFwcGVhcnM7IGNsZWFyZWQgaWYgbW9yZSBvdXRwdXQgYXJyaXZlc1xuICAgKiBiZWZvcmUgQ09NUExFVElPTl9ERUJPVU5DRV9NUyBleHBpcmVzLiBUaW1lciBmaXJlcyB0aGUgc2lnbmFsLlxuICAgKi9cbiAgcHJpdmF0ZSBfY29tcGxldGlvblRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsXG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgd2UgaGF2ZSBhbHJlYWR5IGVtaXR0ZWQgYSBjb21wbGV0aW9uIHNpZ25hbCBzaW5jZSB0aGUgbGFzdFxuICAgKiBub24tdHJpdmlhbCBvdXRwdXQgXHUyMDE0IGd1YXJkcyBhZ2FpbnN0IGRvdWJsZS1maXJlLlxuICAgKi9cbiAgcHJpdmF0ZSBfY29tcGxldGlvbkVtaXR0ZWQgPSBmYWxzZVxuXG4gIC8qKlxuICAgKiBUcnVlIHdoZW4gdGhlIHBhcnNlciBoYXMgc2VlbiBhIHByb21wdCBib3VuZGFyeSBhbmQgaXMgd2FpdGluZyBmb3IgdXNlclxuICAgKiBpbnB1dC4gIFRoZSBuZXh0IG5vbi1zeXN0ZW0sIG5vbi1wcm9tcHQsIG5vbi1UVUkgY29udGVudCBsaW5lIGFmdGVyIHRoZVxuICAgKiBwcm9tcHQgaXMgY2xhc3NpZmllZCBhcyByb2xlPVwidXNlclwiIGluc3RlYWQgb2YgXCJhc3Npc3RhbnRcIi5cbiAgICogUmVzZXQgdG8gZmFsc2Ugb25jZSB0aGF0IHVzZXIgbGluZSBhcnJpdmVzIChvciB3aGVuIGEgbmV3IGFzc2lzdGFudFxuICAgKiBtZXNzYWdlIGV4cGxpY2l0bHkgc3RhcnRzIHZpYSBhIGRpZmZlcmVudCBzaWduYWwpLlxuICAgKi9cbiAgcHJpdmF0ZSBfYXdhaXRpbmdJbnB1dCA9IGZhbHNlXG5cbiAgY29uc3RydWN0b3Ioc291cmNlID0gXCJkZWZhdWx0XCIpIHtcbiAgICB0aGlzLl9zb3VyY2UgPSBzb3VyY2VcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBQdWJsaWMgQVBJIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4gIC8qKlxuICAgKiBGZWVkIGEgcmF3IFBUWSBjaHVuayAobWF5IGNvbnRhaW4gQU5TSSBjb2RlcywgcGFydGlhbCBsaW5lcywgZXRjLilcbiAgICovXG4gIGZlZWQoY2h1bms6IHN0cmluZyk6IHZvaWQge1xuICAgIHRoaXMuX2xhc3RJbnB1dEF0ID0gRGF0ZS5ub3coKVxuICAgIC8vIEFueSBuZXcgY29udGVudCByZXNldHMgcGVuZGluZyBjb21wbGV0aW9uIFx1MjAxNCB3ZSdyZSBzdGlsbCByZWNlaXZpbmcgb3V0cHV0XG4gICAgaWYgKHRoaXMuX2NvbXBsZXRpb25UaW1lcikge1xuICAgICAgY2xlYXJUaW1lb3V0KHRoaXMuX2NvbXBsZXRpb25UaW1lcilcbiAgICAgIHRoaXMuX2NvbXBsZXRpb25UaW1lciA9IG51bGxcbiAgICB9XG4gICAgdGhpcy5fYnVmZmVyICs9IGNodW5rXG4gICAgdGhpcy5fcHJvY2VzcygpXG4gIH1cblxuICAvKiogUmV0dXJuIGEgc2hhbGxvdyBjb3B5IG9mIHRoZSBjdXJyZW50IG1lc3NhZ2UgbGlzdCAqL1xuICBnZXRNZXNzYWdlcygpOiBDaGF0TWVzc2FnZVtdIHtcbiAgICByZXR1cm4gWy4uLnRoaXMuX21lc3NhZ2VzXVxuICB9XG5cbiAgLyoqXG4gICAqIFJldHVybnMgdHJ1ZSB3aGVuIHRoZSBwYXJzZXIgaGFzIGRldGVjdGVkIGEgcHJvbXB0IGJvdW5kYXJ5IGFuZCBpc1xuICAgKiB3YWl0aW5nIGZvciB1c2VyIGlucHV0LiAgQ2hhdCBVSXMgY2FuIHVzZSB0aGlzIHRvIHNob3cgYW4gXCJhd2FpdGluZ1xuICAgKiBpbnB1dFwiIGluZGljYXRvciBzbyB0aGUgc2Vzc2lvbiBkb2VzIG5vdCBhcHBlYXIgc3R1Y2suXG4gICAqL1xuICBpc0F3YWl0aW5nSW5wdXQoKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMuX2F3YWl0aW5nSW5wdXRcbiAgfVxuXG4gIC8qKlxuICAgKiBGbHVzaCBhbnkgdHJhaWxpbmcgcGFydGlhbCBidWZmZXIgZXZlbiBpZiBpdCBkb2VzIG5vdCBlbmQgd2l0aCBhIG5ld2xpbmUuXG4gICAqIFVzZWZ1bCBmb3IgdGVybWluYWwgVUlzIHRoYXQgbGVhdmUgdGhlIGZpbmFsIHN0YXR1cyBsaW5lIHVudGVybWluYXRlZC5cbiAgICovXG4gIGZsdXNoKCk6IHZvaWQge1xuICAgIGlmICh0aGlzLl9idWZmZXIubGVuZ3RoID09PSAwKSByZXR1cm5cblxuICAgIGNvbnN0IHN0cmlwcGVkID0gc3RyaXBBbnNpKHRoaXMuX2J1ZmZlcilcbiAgICB0aGlzLl9idWZmZXIgPSBcIlwiXG5cbiAgICBmb3IgKGNvbnN0IHJhd0xpbmUgb2Ygc3RyaXBwZWQuc3BsaXQoXCJcXG5cIikpIHtcbiAgICAgIGNvbnN0IGxpbmUgPSByYXdMaW5lLnRyaW1FbmQoKVxuICAgICAgaWYgKGxpbmUubGVuZ3RoID09PSAwKSBjb250aW51ZVxuICAgICAgdGhpcy5faGFuZGxlTGluZShsaW5lKVxuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBTdWJzY3JpYmUgdG8gbWVzc2FnZSBldmVudHMgKG5ldyBtZXNzYWdlIG9yIGNvbnRlbnQgYXBwZW5kZWQpLlxuICAgKiBSZXR1cm5zIGFuIHVuc3Vic2NyaWJlIGZ1bmN0aW9uLlxuICAgKi9cbiAgb25NZXNzYWdlKGNiOiBNZXNzYWdlQ2FsbGJhY2spOiBVbnN1YnNjcmliZSB7XG4gICAgdGhpcy5fc3Vic2NyaWJlcnMuYWRkKGNiKVxuICAgIHJldHVybiAoKSA9PiB0aGlzLl9zdWJzY3JpYmVycy5kZWxldGUoY2IpXG4gIH1cblxuICAvKipcbiAgICogU3Vic2NyaWJlIHRvIGNvbXBsZXRpb24gc2lnbmFscyAoR1NEIHJldHVybmVkIHRvIGlkbGUgcHJvbXB0IGFmdGVyIFx1MjI2NTJzIHNpbGVuY2UpLlxuICAgKiBSZXR1cm5zIGFuIHVuc3Vic2NyaWJlIGZ1bmN0aW9uLlxuICAgKi9cbiAgb25Db21wbGV0aW9uU2lnbmFsKGNiOiBDb21wbGV0aW9uQ2FsbGJhY2spOiBVbnN1YnNjcmliZSB7XG4gICAgdGhpcy5fY29tcGxldGlvblN1YnNjcmliZXJzLmFkZChjYilcbiAgICByZXR1cm4gKCkgPT4gdGhpcy5fY29tcGxldGlvblN1YnNjcmliZXJzLmRlbGV0ZShjYilcbiAgfVxuXG4gIC8qKiBSZXNldCBhbGwgc3RhdGUgXHUyMDE0IHVzZWZ1bCB3aGVuIGEgbmV3IHNlc3Npb24gc3RhcnRzICovXG4gIHJlc2V0KCk6IHZvaWQge1xuICAgIHRoaXMuX2J1ZmZlciA9IFwiXCJcbiAgICB0aGlzLl9tZXNzYWdlcyA9IFtdXG4gICAgdGhpcy5fYWN0aXZlTWVzc2FnZSA9IG51bGxcbiAgICB0aGlzLl9wZW5kaW5nU2VsZWN0ID0gbnVsbFxuICAgIHRoaXMuX2xhc3RIZWFkZXJUZXh0ID0gXCJcIlxuICAgIHRoaXMuX2xhc3RJbnB1dEF0ID0gMFxuICAgIHRoaXMuX2NvbXBsZXRpb25FbWl0dGVkID0gZmFsc2VcbiAgICB0aGlzLl9hd2FpdGluZ0lucHV0ID0gZmFsc2VcbiAgICBpZiAodGhpcy5fY29tcGxldGlvblRpbWVyKSB7XG4gICAgICBjbGVhclRpbWVvdXQodGhpcy5fY29tcGxldGlvblRpbWVyKVxuICAgICAgdGhpcy5fY29tcGxldGlvblRpbWVyID0gbnVsbFxuICAgIH1cbiAgICBjb25zb2xlLmRlYnVnKFwiW3B0eS1jaGF0LXBhcnNlcl0gcmVzZXQgc291cmNlPSVzXCIsIHRoaXMuX3NvdXJjZSlcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBJbnRlcm5hbCBQcm9jZXNzaW5nIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4gIHByaXZhdGUgX3Byb2Nlc3MoKTogdm9pZCB7XG4gICAgLy8gQWNjdW11bGF0ZSB1bnRpbCB3ZSBoYXZlIGF0IGxlYXN0IG9uZSBjb21wbGV0ZSBsaW5lXG4gICAgLy8gUHJvY2VzcyBhbGwgY29tcGxldGUgbGluZXM7IGxlYXZlIHRoZSBsYXN0IHBhcnRpYWwgbGluZSBpbiB0aGUgYnVmZmVyXG4gICAgY29uc3QgbGFzdE5ld2xpbmUgPSB0aGlzLl9idWZmZXIubGFzdEluZGV4T2YoXCJcXG5cIilcbiAgICBpZiAobGFzdE5ld2xpbmUgPT09IC0xKSByZXR1cm4gLy8gbm8gY29tcGxldGUgbGluZSB5ZXRcblxuICAgIGNvbnN0IHRvUHJvY2VzcyA9IHRoaXMuX2J1ZmZlci5zbGljZSgwLCBsYXN0TmV3bGluZSArIDEpXG4gICAgdGhpcy5fYnVmZmVyID0gdGhpcy5fYnVmZmVyLnNsaWNlKGxhc3ROZXdsaW5lICsgMSlcblxuICAgIGNvbnN0IHN0cmlwcGVkID0gc3RyaXBBbnNpKHRvUHJvY2VzcylcbiAgICBjb25zdCBsaW5lcyA9IHN0cmlwcGVkLnNwbGl0KFwiXFxuXCIpXG5cbiAgICBmb3IgKGNvbnN0IHJhd0xpbmUgb2YgbGluZXMpIHtcbiAgICAgIGNvbnN0IGxpbmUgPSByYXdMaW5lLnRyaW1FbmQoKVxuICAgICAgdGhpcy5faGFuZGxlTGluZShsaW5lKVxuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgX2hhbmRsZUxpbmUobGluZTogc3RyaW5nKTogdm9pZCB7XG4gICAgY29uc3QgdHJpbW1lZCA9IGxpbmUudHJpbSgpXG5cbiAgICAvLyBCbGFuayBsaW5lcyBcdTIwMTQgYXBwZW5kIHRvIGFjdGl2ZSBhc3Npc3RhbnQgbWVzc2FnZSBhcyBzcGFjaW5nXG4gICAgaWYgKHRyaW1tZWQubGVuZ3RoID09PSAwKSB7XG4gICAgICBpZiAodGhpcy5fYWN0aXZlTWVzc2FnZT8ucm9sZSA9PT0gXCJhc3Npc3RhbnRcIikge1xuICAgICAgICB0aGlzLl9hcHBlbmRUb0FjdGl2ZShcIlxcblwiKVxuICAgICAgfVxuICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgLy8gXHUyNTAwXHUyNTAwIFNlcGFyYXRvciBiYXIgKFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMCkgXHUyMDE0IHNpZ25hbHMgVUkgYmxvY2sgYm91bmRhcnkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gICAgaWYgKEJBUl9MSU5FX1JFLnRlc3QodHJpbW1lZCkpIHtcbiAgICAgIC8vIENvbW1pdCBhbnkgcGVuZGluZyBzZWxlY3QgYmxvY2tcbiAgICAgIHRoaXMuX2NvbW1pdFNlbGVjdEJsb2NrKClcbiAgICAgIC8vIFJlc2V0IGhlYWRlciB0ZXh0IFx1MjAxNCBuZXh0IG5vbi1iYXIgbGluZSBtYXkgYmUgYSBuZXcgcXVlc3Rpb25cbiAgICAgIHRoaXMuX2xhc3RIZWFkZXJUZXh0ID0gXCJcIlxuICAgICAgLy8gQXBwZW5kIHRvIGFjdGl2ZSBhc3Npc3RhbnQgY29udGVudFxuICAgICAgaWYgKHRoaXMuX2FjdGl2ZU1lc3NhZ2UgJiYgIXRoaXMuX2FjdGl2ZU1lc3NhZ2UuY29tcGxldGUgJiYgdGhpcy5fYWN0aXZlTWVzc2FnZS5yb2xlID09PSBcImFzc2lzdGFudFwiKSB7XG4gICAgICAgIHRoaXMuX2FwcGVuZFRvQWN0aXZlKGxpbmUgKyBcIlxcblwiKVxuICAgICAgfVxuICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgLy8gXHUyNTAwXHUyNTAwIFRVSSBvcHRpb24gbGluZXMgXHUyMDE0IG11c3QgYmUgY2hlY2tlZCBCRUZPUkUgaXNQcm9tcHRMaW5lIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgIC8vIFJlYXNvbjogdGhlIEdTRCBVSSBjdXJzb3IgZ2x5cGggXCJcdTIwM0FcIiBpcyBhbHNvIGEgUFJPTVBUX01BUktFUiwgc28gYVxuICAgIC8vIHNlbGVjdGVkLW9wdGlvbiBsaW5lIGxpa2UgXCIgIFx1MjAzQSAxLiBEZXNjcmliZSBpdCBub3dcIiB3b3VsZCBiZSBtaXN0YWtlbmx5XG4gICAgLy8gaGFuZGxlZCBhcyBhIHByb21wdCBib3VuZGFyeSBpZiBpc1Byb21wdExpbmUgcmFuIGZpcnN0LlxuXG4gICAgLy8gQ2hlY2tib3ggb3B0aW9uIGxpbmU6IFwiICBcdTIwM0EgW3hdIExhYmVsXCIgLyBcIiAgXHUyMDNBIFsgXSBMYWJlbFwiXG4gICAgY29uc3QgY2hlY2tib3hNYXRjaCA9IENIRUNLQk9YX1NFTEVDVEVEX1JFLmV4ZWMobGluZSlcbiAgICBpZiAoY2hlY2tib3hNYXRjaCkge1xuICAgICAgdGhpcy5faGFuZGxlQ2hlY2tib3hPcHRpb24oY2hlY2tib3hNYXRjaFsxXSwgY2hlY2tib3hNYXRjaFsyXSlcbiAgICAgIHJldHVyblxuICAgIH1cblxuICAgIC8vIFNlbGVjdGVkIG9wdGlvbiBsaW5lOiBcIiAgXHUyMDNBIE4uIExhYmVsXCJcbiAgICBjb25zdCBzZWxlY3RlZE1hdGNoID0gU0VMRUNUX09QVElPTl9TRUxFQ1RFRF9SRS5leGVjKGxpbmUpXG4gICAgaWYgKHNlbGVjdGVkTWF0Y2gpIHtcbiAgICAgIHRoaXMuX2hhbmRsZVNlbGVjdE9wdGlvbihwYXJzZUludChzZWxlY3RlZE1hdGNoWzFdLCAxMCksIHNlbGVjdGVkTWF0Y2hbMl0sIHRydWUpXG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICAvLyBVbnNlbGVjdGVkIG9wdGlvbiBsaW5lOiBcIiAgICBOLiBMYWJlbFwiICgzXHUyMDEzNiBsZWFkaW5nIHNwYWNlcywgbm8gXHUyMDNBKVxuICAgIC8vIEd1YXJkOiBtdXN0IGxvb2sgbGlrZSBhIG51bWJlcmVkIG9wdGlvbiBcdTIwMTQgbm90IGEgZGVzY3JpcHRpb24gaW5kZW50IGxpbmVcbiAgICBjb25zdCB1bnNlbGVjdGVkTWF0Y2ggPSBTRUxFQ1RfT1BUSU9OX1VOU0VMRUNURURfUkUuZXhlYyhsaW5lKVxuICAgIGlmICh1bnNlbGVjdGVkTWF0Y2ggJiYgIVNFTEVDVF9PUFRJT05fU0VMRUNURURfUkUudGVzdChsaW5lKSkge1xuICAgICAgdGhpcy5faGFuZGxlU2VsZWN0T3B0aW9uKHBhcnNlSW50KHVuc2VsZWN0ZWRNYXRjaFsxXSwgMTApLCB1bnNlbGVjdGVkTWF0Y2hbMl0sIGZhbHNlKVxuICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgLy8gSGludHMgbGluZSAoXHUyMTkxL1x1MjE5MyBuYXZpZ2F0aW9uIGhpbnRzKSBcdTIwMTQgZW5kIG9mIGEgc2VsZWN0IGJsb2NrXG4gICAgaWYgKEhJTlRTX1JFLnRlc3QodHJpbW1lZCkpIHtcbiAgICAgIHRoaXMuX2NvbW1pdFNlbGVjdEJsb2NrKClcbiAgICAgIGlmICh0aGlzLl9hY3RpdmVNZXNzYWdlICYmICF0aGlzLl9hY3RpdmVNZXNzYWdlLmNvbXBsZXRlICYmIHRoaXMuX2FjdGl2ZU1lc3NhZ2Uucm9sZSA9PT0gXCJhc3Npc3RhbnRcIikge1xuICAgICAgICB0aGlzLl9hcHBlbmRUb0FjdGl2ZShsaW5lICsgXCJcXG5cIilcbiAgICAgIH1cbiAgICAgIHJldHVyblxuICAgIH1cblxuICAgIC8vIFx1MjUwMFx1MjUwMCBQcm9tcHQgbGluZSBcdTIxOTIgYm91bmRhcnkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gICAgaWYgKGlzUHJvbXB0TGluZSh0cmltbWVkKSkge1xuICAgICAgLy8gQ29tbWl0IGFueSBwZW5kaW5nIHNlbGVjdCBibG9jayBiZWZvcmUgY2xvc2luZyB0aGlzIHR1cm5cbiAgICAgIHRoaXMuX2NvbW1pdFNlbGVjdEJsb2NrKClcblxuICAgICAgLy8gQ29tcGxldGUgYW55IGFjdGl2ZSBtZXNzYWdlXG4gICAgICBpZiAodGhpcy5fYWN0aXZlTWVzc2FnZSkge1xuICAgICAgICB0aGlzLl9jb21wbGV0ZUFjdGl2ZSgpXG4gICAgICAgIGNvbnNvbGUuZGVidWcoXG4gICAgICAgICAgXCJbcHR5LWNoYXQtcGFyc2VyXSBib3VuZGFyeTogcHJvbXB0IGRldGVjdGVkLCBjb21wbGV0ZWQgbXNnPSVzIHJvbGU9JXMgc291cmNlPSVzXCIsXG4gICAgICAgICAgdGhpcy5fYWN0aXZlTWVzc2FnZT8uaWQgPz8gXCIobm9uZSlcIixcbiAgICAgICAgICB0aGlzLl9hY3RpdmVNZXNzYWdlPy5yb2xlID8/IFwiKG5vbmUpXCIsXG4gICAgICAgICAgdGhpcy5fc291cmNlLFxuICAgICAgICApXG4gICAgICB9XG5cbiAgICAgIC8vIFNjaGVkdWxlIGNvbXBsZXRpb24gc2lnbmFsIHdpdGggZGVib3VuY2VcbiAgICAgIHRoaXMuX3NjaGVkdWxlQ29tcGxldGlvblNpZ25hbCgpXG5cbiAgICAgIC8vIFN0YXJ0IGEgbmV3IHVzZXIgbWVzc2FnZSAodGhlIHRleHQgYWZ0ZXIgdGhlIHByb21wdCBtYXJrZXIgaXMgdXNlciBpbnB1dClcbiAgICAgIGNvbnN0IHVzZXJUZXh0ID0gdHJpbW1lZC5yZXBsYWNlKFBST01QVF9NQVJLRVJTWzBdLCBcIlwiKVxuICAgICAgICAucmVwbGFjZShQUk9NUFRfTUFSS0VSU1sxXSwgXCJcIilcbiAgICAgICAgLnJlcGxhY2UoUFJPTVBUX01BUktFUlNbMl0sIFwiXCIpXG4gICAgICAgIC5yZXBsYWNlKFBST01QVF9NQVJLRVJTWzNdLCBcIlwiKVxuICAgICAgICAudHJpbSgpXG5cbiAgICAgIGlmICh1c2VyVGV4dC5sZW5ndGggPiAwKSB7XG4gICAgICAgIGNvbnN0IG1zZyA9IHRoaXMuX3N0YXJ0TWVzc2FnZShcInVzZXJcIiwgdXNlclRleHQpXG4gICAgICAgIHRoaXMuX2NvbXBsZXRlTWVzc2FnZShtc2cpIC8vIHVzZXIgbGluZXMgYXJlIHR5cGljYWxseSBzaW5nbGUtbGluZVxuICAgICAgICB0aGlzLl9hd2FpdGluZ0lucHV0ID0gZmFsc2VcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIEJhcmUgcHJvbXB0IHdpdGggbm8gaW5saW5lIHVzZXIgdGV4dCBcdTIwMTQgbWFyayBhcyBhd2FpdGluZyBpbnB1dFxuICAgICAgICAvLyBzbyB0aGUgbmV4dCBjb250ZW50IGxpbmUgaXMgY2xhc3NpZmllZCBhcyB1c2VyIGlucHV0LlxuICAgICAgICB0aGlzLl9hd2FpdGluZ0lucHV0ID0gdHJ1ZVxuICAgICAgfVxuICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgLy8gXHUyNTAwXHUyNTAwIFN5c3RlbSAvIHN0YXR1cyBsaW5lIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgIGlmIChpc1N5c3RlbUxpbmUodHJpbW1lZCkpIHtcbiAgICAgIC8vIENvbXBsZXRlIGFueSBhY3RpdmUgbm9uLXN5c3RlbSBtZXNzYWdlIGZpcnN0XG4gICAgICBpZiAodGhpcy5fYWN0aXZlTWVzc2FnZSAmJiB0aGlzLl9hY3RpdmVNZXNzYWdlLnJvbGUgIT09IFwic3lzdGVtXCIpIHtcbiAgICAgICAgdGhpcy5fY29tcGxldGVBY3RpdmUoKVxuICAgICAgfVxuICAgICAgLy8gU3lzdGVtIG1lc3NhZ2VzIGFyZSBhbHdheXMgc2VsZi1jb250YWluZWQgc2luZ2xlIGxpbmVzXG4gICAgICBjb25zdCBtc2cgPSB0aGlzLl9zdGFydE1lc3NhZ2UoXCJzeXN0ZW1cIiwgdHJpbW1lZClcbiAgICAgIHRoaXMuX2NvbXBsZXRlTWVzc2FnZShtc2cpXG4gICAgICBjb25zb2xlLmRlYnVnKFxuICAgICAgICBcIltwdHktY2hhdC1wYXJzZXJdIHN5c3RlbSBsaW5lIGRldGVjdGVkIGlkPSVzIHNvdXJjZT0lc1wiLFxuICAgICAgICBtc2cuaWQsXG4gICAgICAgIHRoaXMuX3NvdXJjZSxcbiAgICAgIClcbiAgICAgIHJldHVyblxuICAgIH1cblxuICAgIC8vIFx1MjUwMFx1MjUwMCBAY2xhY2svcHJvbXB0cyBUVUkgcHJvbXB0cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuICAgIC8vIFBhc3N3b3JkIHByb21wdDogQGNsYWNrL3Byb21wdHMgXCJcdTI1QzYgIFBhc3RlIHlvdXIgQW50aHJvcGljIEFQSSBrZXk6XCJcbiAgICBjb25zdCBwYXNzd29yZE1hdGNoID0gQ0xBQ0tfUEFTU1dPUkRfUkUuZXhlYyh0cmltbWVkKVxuICAgIGlmIChwYXNzd29yZE1hdGNoKSB7XG4gICAgICB0aGlzLl9oYW5kbGVQYXNzd29yZFByb21wdChwYXNzd29yZE1hdGNoWzFdKVxuICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgLy8gVGV4dCBwcm9tcHQ6IEBjbGFjay9wcm9tcHRzIFwiXHUyNUM2ICBFbnRlciBwcm9qZWN0IG5hbWU6XCJcbiAgICBjb25zdCB0ZXh0TWF0Y2ggPSBDTEFDS19URVhUX1JFLmV4ZWModHJpbW1lZClcbiAgICBpZiAodGV4dE1hdGNoKSB7XG4gICAgICB0aGlzLl9oYW5kbGVUZXh0UHJvbXB0KHRleHRNYXRjaFsxXSlcbiAgICAgIHJldHVyblxuICAgIH1cblxuICAgIC8vIFx1MjUwMFx1MjUwMCBRdWVzdGlvbi9oZWFkZXIgbGluZSAoYmVmb3JlIG9wdGlvbnMpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgIC8vIEdTRCByZW5kZXJzIGEgaGVhZGVyIGxpbmUgb3IgcXVlc3Rpb24gdGV4dCBhYm92ZSBzZWxlY3Qgb3B0aW9ucy5cbiAgICAvLyBDYXB0dXJlIGl0IHNvIHdlIGNhbiB1c2UgaXQgYXMgdGhlIFR1aVByb21wdC5sYWJlbCB3aGVuIG9wdGlvbnMgYXJyaXZlLlxuICAgIGlmICh0aGlzLl9sb29rc0xpa2VRdWVzdGlvbkhlYWRlcihsaW5lKSkge1xuICAgICAgdGhpcy5fbGFzdEhlYWRlclRleHQgPSB0cmltbWVkXG4gICAgfVxuXG4gICAgLy8gXHUyNTAwXHUyNTAwIEF3YWl0aW5nIGlucHV0IFx1MjE5MiBjbGFzc2lmeSBhcyB1c2VyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgIC8vIEFmdGVyIGEgYmFyZSBwcm9tcHQgbGluZSAoZS5nLiBcIlx1Mjc2RiBcXG5cIiksIHRoZSBuZXh0IGNvbnRlbnQgbGluZSBpc1xuICAgIC8vIHRoZSB1c2VyJ3MgdHlwZWQgaW5wdXQgZWNob2VkIGJhY2sgYnkgdGhlIFBUWSAod2l0aG91dCBwcm9tcHQgcHJlZml4KS5cbiAgICBpZiAodGhpcy5fYXdhaXRpbmdJbnB1dCkge1xuICAgICAgdGhpcy5fYXdhaXRpbmdJbnB1dCA9IGZhbHNlXG4gICAgICBjb25zdCBtc2cgPSB0aGlzLl9zdGFydE1lc3NhZ2UoXCJ1c2VyXCIsIHRyaW1tZWQpXG4gICAgICB0aGlzLl9jb21wbGV0ZU1lc3NhZ2UobXNnKVxuICAgICAgY29uc29sZS5kZWJ1ZyhcbiAgICAgICAgXCJbcHR5LWNoYXQtcGFyc2VyXSB1c2VyIGlucHV0IGRldGVjdGVkIChwb3N0LXByb21wdCBlY2hvKSBpZD0lcyBzb3VyY2U9JXNcIixcbiAgICAgICAgbXNnLmlkLFxuICAgICAgICB0aGlzLl9zb3VyY2UsXG4gICAgICApXG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICAvLyBcdTI1MDBcdTI1MDAgUmVndWxhciBjb250ZW50IGxpbmUgXHUyMTkyIGFzc2lzdGFudCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgICBpZiAoXG4gICAgICB0aGlzLl9hY3RpdmVNZXNzYWdlID09PSBudWxsIHx8XG4gICAgICB0aGlzLl9hY3RpdmVNZXNzYWdlLmNvbXBsZXRlIHx8XG4gICAgICB0aGlzLl9hY3RpdmVNZXNzYWdlLnJvbGUgIT09IFwiYXNzaXN0YW50XCJcbiAgICApIHtcbiAgICAgIC8vIFN0YXJ0IGEgbmV3IGFzc2lzdGFudCBtZXNzYWdlXG4gICAgICB0aGlzLl9hY3RpdmVNZXNzYWdlID0gdGhpcy5fc3RhcnRNZXNzYWdlKFwiYXNzaXN0YW50XCIsIFwiXCIpXG4gICAgICBjb25zb2xlLmRlYnVnKFxuICAgICAgICBcIltwdHktY2hhdC1wYXJzZXJdIHJvbGUgYm91bmRhcnk6IHN0YXJ0ZWQgYXNzaXN0YW50IG1zZz0lcyBzb3VyY2U9JXNcIixcbiAgICAgICAgdGhpcy5fYWN0aXZlTWVzc2FnZS5pZCxcbiAgICAgICAgdGhpcy5fc291cmNlLFxuICAgICAgKVxuICAgIH1cbiAgICB0aGlzLl9hcHBlbmRUb0FjdGl2ZShsaW5lICsgXCJcXG5cIilcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBUVUkgUHJvbXB0IEhhbmRsZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4gIHByaXZhdGUgX2hhbmRsZVNlbGVjdE9wdGlvbihudW06IG51bWJlciwgbGFiZWw6IHN0cmluZywgaXNTZWxlY3RlZDogYm9vbGVhbik6IHZvaWQge1xuICAgIGNvbnN0IGNsZWFuTGFiZWwgPSBsYWJlbC50cmltKClcblxuICAgIGlmICghdGhpcy5fcGVuZGluZ1NlbGVjdCkge1xuICAgICAgLy8gU3RhcnQgYSBuZXcgYWNjdW11bGF0aW9uIGJsb2NrXG4gICAgICB0aGlzLl9wZW5kaW5nU2VsZWN0ID0ge1xuICAgICAgICBsYWJlbDogdGhpcy5fbGFzdEhlYWRlclRleHQsXG4gICAgICAgIG9wdGlvbnM6IFtdLFxuICAgICAgICB3aW5kb3dUaW1lcjogbnVsbCxcbiAgICAgICAgZmlyc3RMaW5lQXQ6IERhdGUubm93KCksXG4gICAgICB9XG4gICAgICAvLyBTZXQgd2luZG93IHRpbWVyIFx1MjAxNCBpZiBub3QgZW5vdWdoIG9wdGlvbnMgYXJyaXZlLCBkaXNjYXJkXG4gICAgICB0aGlzLl9wZW5kaW5nU2VsZWN0LndpbmRvd1RpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgIHRoaXMuX2NvbW1pdFNlbGVjdEJsb2NrKClcbiAgICAgIH0sIFNFTEVDVF9XSU5ET1dfTVMpXG4gICAgfVxuXG4gICAgLy8gVXBzZXJ0IG9wdGlvbiBieSBpdHMgMS1iYXNlZCBpbmRleFxuICAgIGNvbnN0IGJsb2NrID0gdGhpcy5fcGVuZGluZ1NlbGVjdFxuICAgIGNvbnN0IGV4aXN0aW5nID0gYmxvY2sub3B0aW9ucy5maW5kKChvKSA9PiBvLmluZGV4ID09PSBudW0pXG4gICAgaWYgKGV4aXN0aW5nKSB7XG4gICAgICBleGlzdGluZy5sYWJlbCA9IGNsZWFuTGFiZWxcbiAgICAgIGV4aXN0aW5nLnNlbGVjdGVkID0gaXNTZWxlY3RlZFxuICAgIH0gZWxzZSB7XG4gICAgICBibG9jay5vcHRpb25zLnB1c2goeyBpbmRleDogbnVtLCBsYWJlbDogY2xlYW5MYWJlbCwgc2VsZWN0ZWQ6IGlzU2VsZWN0ZWQgfSlcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIF9oYW5kbGVDaGVja2JveE9wdGlvbihjaGVja2VkOiBzdHJpbmcsIGxhYmVsOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBpc1NlbGVjdGVkID0gY2hlY2tlZC50b0xvd2VyQ2FzZSgpID09PSBcInhcIlxuICAgIC8vIFJldXNlIHNlbGVjdCBvcHRpb24gbG9naWMgXHUyMDE0IGNoZWNrYm94ZXMgbWFwIHRvIHNlbGVjdCB3aXRoIG11bHRpcGxlIHNlbGVjdGlvblxuICAgIC8vIEZvciBzaW1wbGljaXR5LCB3ZSBkZXRlY3QgY2hlY2tib3ggYXMgYSB2YXJpYW50IG9mIHNlbGVjdFxuICAgIHRoaXMuX2hhbmRsZVNlbGVjdE9wdGlvbih0aGlzLl9wZW5kaW5nU2VsZWN0Py5vcHRpb25zLmxlbmd0aCA/PyAwICsgMSwgbGFiZWwsIGlzU2VsZWN0ZWQpXG4gIH1cblxuICBwcml2YXRlIF9oYW5kbGVQYXNzd29yZFByb21wdChsYWJlbDogc3RyaW5nKTogdm9pZCB7XG4gICAgLy8gRW5zdXJlIHRoZXJlJ3MgYW4gYWN0aXZlIGFzc2lzdGFudCBtZXNzYWdlIHRvIGF0dGFjaCB0aGUgcHJvbXB0IHRvXG4gICAgaWYgKCF0aGlzLl9hY3RpdmVNZXNzYWdlIHx8IHRoaXMuX2FjdGl2ZU1lc3NhZ2UuY29tcGxldGUgfHwgdGhpcy5fYWN0aXZlTWVzc2FnZS5yb2xlICE9PSBcImFzc2lzdGFudFwiKSB7XG4gICAgICB0aGlzLl9hY3RpdmVNZXNzYWdlID0gdGhpcy5fc3RhcnRNZXNzYWdlKFwiYXNzaXN0YW50XCIsIFwiXCIpXG4gICAgfVxuICAgIGNvbnN0IHByb21wdDogVHVpUHJvbXB0ID0ge1xuICAgICAga2luZDogXCJwYXNzd29yZFwiLFxuICAgICAgbGFiZWw6IGxhYmVsLnRyaW0oKSxcbiAgICAgIG9wdGlvbnM6IFtdLFxuICAgICAgc2VsZWN0ZWRJbmRleDogMCxcbiAgICB9XG4gICAgdGhpcy5fYWN0aXZlTWVzc2FnZS5wcm9tcHQgPSBwcm9tcHRcbiAgICB0aGlzLl9ub3RpZnkodGhpcy5fYWN0aXZlTWVzc2FnZSlcbiAgICBjb25zb2xlLmRlYnVnKFxuICAgICAgXCJbcHR5LWNoYXQtcGFyc2VyXSB0dWkgcHJvbXB0IGRldGVjdGVkIGtpbmQ9cGFzc3dvcmQgc291cmNlPSVzXCIsXG4gICAgICB0aGlzLl9zb3VyY2UsXG4gICAgKVxuICB9XG5cbiAgcHJpdmF0ZSBfaGFuZGxlVGV4dFByb21wdChsYWJlbDogc3RyaW5nKTogdm9pZCB7XG4gICAgLy8gRW5zdXJlIHRoZXJlJ3MgYW4gYWN0aXZlIGFzc2lzdGFudCBtZXNzYWdlIHRvIGF0dGFjaCB0aGUgcHJvbXB0IHRvXG4gICAgaWYgKCF0aGlzLl9hY3RpdmVNZXNzYWdlIHx8IHRoaXMuX2FjdGl2ZU1lc3NhZ2UuY29tcGxldGUgfHwgdGhpcy5fYWN0aXZlTWVzc2FnZS5yb2xlICE9PSBcImFzc2lzdGFudFwiKSB7XG4gICAgICB0aGlzLl9hY3RpdmVNZXNzYWdlID0gdGhpcy5fc3RhcnRNZXNzYWdlKFwiYXNzaXN0YW50XCIsIFwiXCIpXG4gICAgfVxuICAgIGNvbnN0IHByb21wdDogVHVpUHJvbXB0ID0ge1xuICAgICAga2luZDogXCJ0ZXh0XCIsXG4gICAgICBsYWJlbDogbGFiZWwudHJpbSgpLFxuICAgICAgb3B0aW9uczogW10sXG4gICAgICBzZWxlY3RlZEluZGV4OiAwLFxuICAgIH1cbiAgICB0aGlzLl9hY3RpdmVNZXNzYWdlLnByb21wdCA9IHByb21wdFxuICAgIHRoaXMuX25vdGlmeSh0aGlzLl9hY3RpdmVNZXNzYWdlKVxuICAgIGNvbnNvbGUuZGVidWcoXG4gICAgICBcIltwdHktY2hhdC1wYXJzZXJdIHR1aSBwcm9tcHQgZGV0ZWN0ZWQga2luZD10ZXh0IGxhYmVsPSVzIHNvdXJjZT0lc1wiLFxuICAgICAgbGFiZWwudHJpbSgpLFxuICAgICAgdGhpcy5fc291cmNlLFxuICAgIClcbiAgfVxuXG4gIHByaXZhdGUgX2NvbW1pdFNlbGVjdEJsb2NrKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5fcGVuZGluZ1NlbGVjdCkgcmV0dXJuXG5cbiAgICBjb25zdCBibG9jayA9IHRoaXMuX3BlbmRpbmdTZWxlY3RcbiAgICB0aGlzLl9wZW5kaW5nU2VsZWN0ID0gbnVsbFxuXG4gICAgaWYgKGJsb2NrLndpbmRvd1RpbWVyKSB7XG4gICAgICBjbGVhclRpbWVvdXQoYmxvY2sud2luZG93VGltZXIpXG4gICAgfVxuXG4gICAgaWYgKGJsb2NrLm9wdGlvbnMubGVuZ3RoIDwgTUlOX1NFTEVDVF9PUFRJT05TKSB7XG4gICAgICAvLyBOb3QgZW5vdWdoIG9wdGlvbnMgXHUyMDE0IHRyZWF0IGFzIHJlZ3VsYXIgY29udGVudCwgbm90IGEgc2VsZWN0IHByb21wdFxuICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgLy8gU29ydCBvcHRpb25zIGJ5IHRoZWlyIDEtYmFzZWQgaW5kZXhcbiAgICBibG9jay5vcHRpb25zLnNvcnQoKGEsIGIpID0+IGEuaW5kZXggLSBiLmluZGV4KVxuXG4gICAgY29uc3Qgc2VsZWN0ZWRPcHQgPSBibG9jay5vcHRpb25zLmZpbmQoKG8pID0+IG8uc2VsZWN0ZWQpXG4gICAgY29uc3Qgc2VsZWN0ZWRJbmRleCA9IHNlbGVjdGVkT3B0XG4gICAgICA/IGJsb2NrLm9wdGlvbnMuaW5kZXhPZihzZWxlY3RlZE9wdClcbiAgICAgIDogMFxuXG4gICAgY29uc3QgcHJvbXB0OiBUdWlQcm9tcHQgPSB7XG4gICAgICBraW5kOiBcInNlbGVjdFwiLFxuICAgICAgbGFiZWw6IGJsb2NrLmxhYmVsLFxuICAgICAgb3B0aW9uczogYmxvY2sub3B0aW9ucy5tYXAoKG8pID0+IG8ubGFiZWwpLFxuICAgICAgc2VsZWN0ZWRJbmRleCxcbiAgICB9XG5cbiAgICAvLyBFbnN1cmUgdGhlcmUncyBhbiBhY3RpdmUgYXNzaXN0YW50IG1lc3NhZ2UgdG8gYXR0YWNoIHRoZSBwcm9tcHQgdG9cbiAgICBpZiAoIXRoaXMuX2FjdGl2ZU1lc3NhZ2UgfHwgdGhpcy5fYWN0aXZlTWVzc2FnZS5jb21wbGV0ZSB8fCB0aGlzLl9hY3RpdmVNZXNzYWdlLnJvbGUgIT09IFwiYXNzaXN0YW50XCIpIHtcbiAgICAgIHRoaXMuX2FjdGl2ZU1lc3NhZ2UgPSB0aGlzLl9zdGFydE1lc3NhZ2UoXCJhc3Npc3RhbnRcIiwgXCJcIilcbiAgICB9XG4gICAgdGhpcy5fYWN0aXZlTWVzc2FnZS5wcm9tcHQgPSBwcm9tcHRcbiAgICB0aGlzLl9ub3RpZnkodGhpcy5fYWN0aXZlTWVzc2FnZSlcblxuICAgIGNvbnNvbGUuZGVidWcoXG4gICAgICBcIltwdHktY2hhdC1wYXJzZXJdIHR1aSBwcm9tcHQgZGV0ZWN0ZWQga2luZD1zZWxlY3Qgb3B0aW9ucz0lZCBzZWxlY3RlZEluZGV4PSVkIHNvdXJjZT0lc1wiLFxuICAgICAgcHJvbXB0Lm9wdGlvbnMubGVuZ3RoLFxuICAgICAgc2VsZWN0ZWRJbmRleCxcbiAgICAgIHRoaXMuX3NvdXJjZSxcbiAgICApXG4gIH1cblxuICAvKipcbiAgICogUmV0dXJucyB0cnVlIGlmIGEgc3RyaXBwZWQgbGluZSBsb29rcyBsaWtlIGEgcXVlc3Rpb24vaGVhZGVyIHRleHQgdGhhdFxuICAgKiBwcmVjZWRlcyBhIHNlbGVjdCBsaXN0LiBDcml0ZXJpYTogbm9uLWVtcHR5LCBub3QgYSBzeXN0ZW0gbGluZSwgbm90IGFuXG4gICAqIG9wdGlvbiBsaW5lLCBhbmQgYXBwZWFyZWQgYWZ0ZXIgYSBiYXIgc2VwYXJhdG9yLlxuICAgKi9cbiAgcHJpdmF0ZSBfbG9va3NMaWtlUXVlc3Rpb25IZWFkZXIobGluZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgY29uc3QgdHJpbW1lZCA9IGxpbmUudHJpbSgpXG4gICAgaWYgKHRyaW1tZWQubGVuZ3RoID09PSAwKSByZXR1cm4gZmFsc2VcbiAgICBpZiAoQkFSX0xJTkVfUkUudGVzdCh0cmltbWVkKSkgcmV0dXJuIGZhbHNlXG4gICAgaWYgKGlzU3lzdGVtTGluZSh0cmltbWVkKSkgcmV0dXJuIGZhbHNlXG4gICAgaWYgKFNFTEVDVF9PUFRJT05fU0VMRUNURURfUkUudGVzdChsaW5lKSkgcmV0dXJuIGZhbHNlXG4gICAgaWYgKFNFTEVDVF9PUFRJT05fVU5TRUxFQ1RFRF9SRS50ZXN0KGxpbmUpKSByZXR1cm4gZmFsc2VcbiAgICBpZiAoQ0hFQ0tCT1hfU0VMRUNURURfUkUudGVzdChsaW5lKSkgcmV0dXJuIGZhbHNlXG4gICAgLy8gT25seSBjYXB0dXJlIGFzIGhlYWRlciBpZiB3ZSBqdXN0IHNhdyBhIGJhciAoaGVhZGVyIHRleHQgaXMgZnJlc2gpXG4gICAgLy8gXHUyMDE0IG90aGVyd2lzZSB0aGlzIHJ1bGUgd291bGQgY2FwdHVyZSBhbnkgYXNzaXN0YW50IGNvbnRlbnRcbiAgICByZXR1cm4gdGhpcy5fbGFzdEhlYWRlclRleHQgPT09IFwiXCIgfHwgdGhpcy5fcGVuZGluZ1NlbGVjdCAhPT0gbnVsbFxuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwIENvbXBsZXRpb24gU2lnbmFsIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4gIC8qKlxuICAgKiBTY2hlZHVsZSBhIENvbXBsZXRpb25TaWduYWwgdG8gZmlyZSBhZnRlciBDT01QTEVUSU9OX0RFQk9VTkNFX01TIG9mIHNpbGVuY2UuXG4gICAqIEFueSBzdWJzZXF1ZW50IFBUWSBpbnB1dCBpbiBmZWVkKCkgY2FuY2VscyBhbmQgcmVzZXRzIHRoZSB0aW1lciAoc2VlIGZlZWQoKSkuXG4gICAqL1xuICBwcml2YXRlIF9zY2hlZHVsZUNvbXBsZXRpb25TaWduYWwoKTogdm9pZCB7XG4gICAgaWYgKHRoaXMuX2NvbXBsZXRpb25UaW1lcikge1xuICAgICAgY2xlYXJUaW1lb3V0KHRoaXMuX2NvbXBsZXRpb25UaW1lcilcbiAgICB9XG4gICAgdGhpcy5fY29tcGxldGlvbkVtaXR0ZWQgPSBmYWxzZVxuXG4gICAgY29uc3Qgc2NoZWR1bGVkQXQgPSBEYXRlLm5vdygpXG4gICAgdGhpcy5fY29tcGxldGlvblRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICB0aGlzLl9jb21wbGV0aW9uVGltZXIgPSBudWxsXG4gICAgICBpZiAodGhpcy5fY29tcGxldGlvbkVtaXR0ZWQpIHJldHVyblxuXG4gICAgICBjb25zdCBlbGFwc2VkID0gRGF0ZS5ub3coKSAtIHNjaGVkdWxlZEF0XG4gICAgICB0aGlzLl9jb21wbGV0aW9uRW1pdHRlZCA9IHRydWVcblxuICAgICAgY29uc3Qgc2lnbmFsOiBDb21wbGV0aW9uU2lnbmFsID0ge1xuICAgICAgICBzb3VyY2U6IHRoaXMuX3NvdXJjZSxcbiAgICAgICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLFxuICAgICAgfVxuICAgICAgY29uc29sZS5kZWJ1ZyhcbiAgICAgICAgXCJbcHR5LWNoYXQtcGFyc2VyXSBjb21wbGV0aW9uIHNpZ25hbCBlbWl0dGVkIHNvdXJjZT0lcyBkZWJvdW5jZT0lZG1zXCIsXG4gICAgICAgIHRoaXMuX3NvdXJjZSxcbiAgICAgICAgZWxhcHNlZCxcbiAgICAgIClcbiAgICAgIGZvciAoY29uc3QgY2Igb2YgdGhpcy5fY29tcGxldGlvblN1YnNjcmliZXJzKSB7XG4gICAgICAgIHRyeSB7IGNiKHNpZ25hbCkgfSBjYXRjaCB7IC8qIHN1YnNjcmliZXIgZXJyb3IgKi8gfVxuICAgICAgfVxuICAgIH0sIENPTVBMRVRJT05fREVCT1VOQ0VfTVMpXG5cbiAgICBjb25zb2xlLmRlYnVnKFxuICAgICAgXCJbcHR5LWNoYXQtcGFyc2VyXSBjb21wbGV0aW9uIHNpZ25hbCBzY2hlZHVsZWQgKGRlYm91bmNlPSVkbXMpIHNvdXJjZT0lc1wiLFxuICAgICAgQ09NUExFVElPTl9ERUJPVU5DRV9NUyxcbiAgICAgIHRoaXMuX3NvdXJjZSxcbiAgICApXG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgTWVzc2FnZSBMaWZlY3ljbGUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbiAgcHJpdmF0ZSBfc3RhcnRNZXNzYWdlKHJvbGU6IE1lc3NhZ2VSb2xlLCBjb250ZW50OiBzdHJpbmcpOiBDaGF0TWVzc2FnZSB7XG4gICAgY29uc3QgbXNnOiBDaGF0TWVzc2FnZSA9IHtcbiAgICAgIGlkOiBuZXdJZCgpLFxuICAgICAgcm9sZSxcbiAgICAgIGNvbnRlbnQsXG4gICAgICBjb21wbGV0ZTogZmFsc2UsXG4gICAgICB0aW1lc3RhbXA6IERhdGUubm93KCksXG4gICAgfVxuICAgIHRoaXMuX21lc3NhZ2VzLnB1c2gobXNnKVxuICAgIHRoaXMuX2FjdGl2ZU1lc3NhZ2UgPSBtc2dcbiAgICB0aGlzLl9ub3RpZnkobXNnKVxuICAgIHJldHVybiBtc2dcbiAgfVxuXG4gIHByaXZhdGUgX2FwcGVuZFRvQWN0aXZlKHRleHQ6IHN0cmluZyk6IHZvaWQge1xuICAgIGlmICghdGhpcy5fYWN0aXZlTWVzc2FnZSB8fCB0aGlzLl9hY3RpdmVNZXNzYWdlLmNvbXBsZXRlKSByZXR1cm5cbiAgICB0aGlzLl9hY3RpdmVNZXNzYWdlLmNvbnRlbnQgKz0gdGV4dFxuICAgIHRoaXMuX25vdGlmeSh0aGlzLl9hY3RpdmVNZXNzYWdlKVxuICB9XG5cbiAgcHJpdmF0ZSBfY29tcGxldGVBY3RpdmUoKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLl9hY3RpdmVNZXNzYWdlIHx8IHRoaXMuX2FjdGl2ZU1lc3NhZ2UuY29tcGxldGUpIHJldHVyblxuICAgIHRoaXMuX2NvbXBsZXRlTWVzc2FnZSh0aGlzLl9hY3RpdmVNZXNzYWdlKVxuICB9XG5cbiAgcHJpdmF0ZSBfY29tcGxldGVNZXNzYWdlKG1zZzogQ2hhdE1lc3NhZ2UpOiB2b2lkIHtcbiAgICAvLyBUcmltIHRyYWlsaW5nIHdoaXRlc3BhY2UgZnJvbSBjb21wbGV0ZWQgbWVzc2FnZXNcbiAgICBtc2cuY29udGVudCA9IG1zZy5jb250ZW50LnRyaW1FbmQoKVxuICAgIG1zZy5jb21wbGV0ZSA9IHRydWVcbiAgICBpZiAodGhpcy5fYWN0aXZlTWVzc2FnZSA9PT0gbXNnKSB0aGlzLl9hY3RpdmVNZXNzYWdlID0gbnVsbFxuICAgIHRoaXMuX25vdGlmeShtc2cpXG4gICAgY29uc29sZS5kZWJ1ZyhcbiAgICAgIFwiW3B0eS1jaGF0LXBhcnNlcl0gbWVzc2FnZSBjb21wbGV0ZSBpZD0lcyByb2xlPSVzIHNvdXJjZT0lc1wiLFxuICAgICAgbXNnLmlkLFxuICAgICAgbXNnLnJvbGUsXG4gICAgICB0aGlzLl9zb3VyY2UsXG4gICAgKVxuICB9XG5cbiAgcHJpdmF0ZSBfbm90aWZ5KG1zZzogQ2hhdE1lc3NhZ2UpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IGNiIG9mIHRoaXMuX3N1YnNjcmliZXJzKSB7XG4gICAgICB0cnkgeyBjYihtc2cpIH0gY2F0Y2ggeyAvKiBzdWJzY3JpYmVyIGVycm9yICovIH1cbiAgICB9XG4gIH1cbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQWdGTyxTQUFTLFVBQVUsR0FBbUI7QUFHM0MsTUFBSSxFQUFFLFFBQVEsc0NBQXNDLEVBQUU7QUFHdEQsTUFBSSxFQUFFLFFBQVEsNEJBQTRCLEVBQUU7QUFHNUMsTUFBSSxFQUFFLFFBQVEsa0NBQWtDLEVBQUU7QUFHbEQsTUFBSSxFQUFFLFFB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
