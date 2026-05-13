import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import {
  Container,
  getEditorKeybindings,
  Input,
  matchesKey,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth
} from "@gsd/pi-tui";
import { KeybindingsManager } from "../../../core/keybindings.js";
import { theme } from "../theme/theme.js";
import { shortenPath } from "../utils/shorten-path.js";
import { DynamicBorder } from "./dynamic-border.js";
import { appKey, appKeyHint, keyHint } from "./keybinding-hints.js";
import { filterAndSortSessions, hasSessionName } from "./session-selector-search.js";
import {
  applyRowHighlight,
  buildTreePrefix,
  computeScrollWindow,
  renderCursor
} from "./tree-render-utils.js";
function formatSessionDate(date) {
  const now = /* @__PURE__ */ new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 6e4);
  const diffHours = Math.floor(diffMs / 36e5);
  const diffDays = Math.floor(diffMs / 864e5);
  if (diffMins < 1) return "now";
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
  return `${Math.floor(diffDays / 365)}y`;
}
class SessionSelectorHeader {
  constructor(scope, sortMode, nameFilter, keybindings, requestRender) {
    this.loading = false;
    this.loadProgress = null;
    this.showPath = false;
    this.confirmingDeletePath = null;
    this.statusMessage = null;
    this.statusTimeout = null;
    this.showRenameHint = false;
    this.scope = scope;
    this.sortMode = sortMode;
    this.nameFilter = nameFilter;
    this.keybindings = keybindings;
    this.requestRender = requestRender;
  }
  setScope(scope) {
    this.scope = scope;
  }
  setSortMode(sortMode) {
    this.sortMode = sortMode;
  }
  setNameFilter(nameFilter) {
    this.nameFilter = nameFilter;
  }
  setLoading(loading) {
    this.loading = loading;
    this.loadProgress = null;
  }
  setProgress(loaded, total) {
    this.loadProgress = { loaded, total };
  }
  setShowPath(showPath) {
    this.showPath = showPath;
  }
  setShowRenameHint(show) {
    this.showRenameHint = show;
  }
  setConfirmingDeletePath(path) {
    this.confirmingDeletePath = path;
  }
  clearStatusTimeout() {
    if (!this.statusTimeout) return;
    clearTimeout(this.statusTimeout);
    this.statusTimeout = null;
  }
  setStatusMessage(msg, autoHideMs) {
    this.clearStatusTimeout();
    this.statusMessage = msg;
    if (!msg || !autoHideMs) return;
    this.statusTimeout = setTimeout(() => {
      this.statusMessage = null;
      this.statusTimeout = null;
      this.requestRender();
    }, autoHideMs);
  }
  invalidate() {
  }
  render(width) {
    const title = this.scope === "current" ? "Resume Session (Current Folder)" : "Resume Session (All)";
    const leftText = theme.bold(title);
    const sortLabel = this.sortMode === "threaded" ? "Threaded" : this.sortMode === "recent" ? "Recent" : "Fuzzy";
    const sortText = theme.fg("muted", "Sort: ") + theme.fg("accent", sortLabel);
    const nameLabel = this.nameFilter === "all" ? "All" : "Named";
    const nameText = theme.fg("muted", "Name: ") + theme.fg("accent", nameLabel);
    let scopeText;
    if (this.loading) {
      const progressText = this.loadProgress ? `${this.loadProgress.loaded}/${this.loadProgress.total}` : "...";
      scopeText = `${theme.fg("muted", "\u25CB Current Folder | ")}${theme.fg("accent", `Loading ${progressText}`)}`;
    } else if (this.scope === "current") {
      scopeText = `${theme.fg("accent", "\u25C9 Current Folder")}${theme.fg("muted", " | \u25CB All")}`;
    } else {
      scopeText = `${theme.fg("muted", "\u25CB Current Folder | ")}${theme.fg("accent", "\u25C9 All")}`;
    }
    const rightText = truncateToWidth(`${scopeText}  ${nameText}  ${sortText}`, width, "");
    const availableLeft = Math.max(0, width - visibleWidth(rightText) - 1);
    const left = truncateToWidth(leftText, availableLeft, "");
    const spacing = Math.max(0, width - visibleWidth(left) - visibleWidth(rightText));
    let hintLine1;
    let hintLine2;
    if (this.confirmingDeletePath !== null) {
      const confirmHint = "Delete session? [Enter] confirm \xB7 [Esc/Ctrl+C] cancel";
      hintLine1 = theme.fg("error", truncateToWidth(confirmHint, width, "\u2026"));
      hintLine2 = "";
    } else if (this.statusMessage) {
      const color = this.statusMessage.type === "error" ? "error" : "accent";
      hintLine1 = theme.fg(color, truncateToWidth(this.statusMessage.message, width, "\u2026"));
      hintLine2 = "";
    } else {
      const pathState = this.showPath ? "(on)" : "(off)";
      const sep = theme.fg("muted", " \xB7 ");
      const hint1 = keyHint("tab", "scope") + sep + theme.fg("muted", 're:<pattern> regex \xB7 "phrase" exact');
      const hint2Parts = [
        keyHint("toggleSessionSort", "sort"),
        appKeyHint(this.keybindings, "toggleSessionNamedFilter", "named"),
        keyHint("deleteSession", "delete"),
        keyHint("toggleSessionPath", `path ${pathState}`)
      ];
      if (this.showRenameHint) {
        hint2Parts.push(keyHint("renameSession", "rename"));
      }
      const hint2 = hint2Parts.join(sep);
      hintLine1 = truncateToWidth(hint1, width, "\u2026");
      hintLine2 = truncateToWidth(hint2, width, "\u2026");
    }
    return [`${left}${" ".repeat(spacing)}${rightText}`, hintLine1, hintLine2];
  }
}
function buildSessionTree(sessions) {
  const byPath = /* @__PURE__ */ new Map();
  for (const session of sessions) {
    byPath.set(session.path, { session, children: [] });
  }
  const roots = [];
  for (const session of sessions) {
    const node = byPath.get(session.path);
    const parentPath = session.parentSessionPath;
    if (parentPath && byPath.has(parentPath)) {
      byPath.get(parentPath).children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortNodes = (nodes) => {
    nodes.sort((a, b) => b.session.modified.getTime() - a.session.modified.getTime());
    for (const node of nodes) {
      sortNodes(node.children);
    }
  };
  sortNodes(roots);
  return roots;
}
function flattenSessionTree(roots) {
  const result = [];
  const walk = (node, depth, ancestorContinues, isLast) => {
    result.push({ session: node.session, depth, isLast, ancestorContinues });
    for (let i = 0; i < node.children.length; i++) {
      const childIsLast = i === node.children.length - 1;
      const continues = depth > 0 ? !isLast : false;
      walk(node.children[i], depth + 1, [...ancestorContinues, continues], childIsLast);
    }
  };
  for (let i = 0; i < roots.length; i++) {
    walk(roots[i], 0, [], i === roots.length - 1);
  }
  return result;
}
class SessionList {
  constructor(sessions, showCwd, sortMode, nameFilter, keybindings, currentSessionFilePath) {
    this.allSessions = [];
    this.filteredSessions = [];
    this.selectedIndex = 0;
    this.showCwd = false;
    this.sortMode = "threaded";
    this.nameFilter = "all";
    this.showPath = false;
    this.confirmingDeletePath = null;
    this.onExit = () => {
    };
    this.maxVisible = 10;
    // Max sessions visible (one line each)
    // Focusable implementation - propagate to searchInput for IME cursor positioning
    this._focused = false;
    this.allSessions = sessions;
    this.filteredSessions = [];
    this.searchInput = new Input();
    this.showCwd = showCwd;
    this.sortMode = sortMode;
    this.nameFilter = nameFilter;
    this.keybindings = keybindings;
    this.currentSessionFilePath = currentSessionFilePath;
    this.filterSessions("");
    this.searchInput.onSubmit = () => {
      if (this.filteredSessions[this.selectedIndex]) {
        const selected = this.filteredSessions[this.selectedIndex];
        if (this.onSelect) {
          this.onSelect(selected.session.path);
        }
      }
    };
  }
  getSelectedSessionPath() {
    const selected = this.filteredSessions[this.selectedIndex];
    return selected?.session.path;
  }
  get focused() {
    return this._focused;
  }
  set focused(value) {
    this._focused = value;
    this.searchInput.focused = value;
  }
  setSortMode(sortMode) {
    this.sortMode = sortMode;
    this.filterSessions(this.searchInput.getValue());
  }
  setNameFilter(nameFilter) {
    this.nameFilter = nameFilter;
    this.filterSessions(this.searchInput.getValue());
  }
  setSessions(sessions, showCwd) {
    this.allSessions = sessions;
    this.showCwd = showCwd;
    this.filterSessions(this.searchInput.getValue());
  }
  filterSessions(query) {
    const trimmed = query.trim();
    const nameFiltered = this.nameFilter === "all" ? this.allSessions : this.allSessions.filter((session) => hasSessionName(session));
    if (this.sortMode === "threaded" && !trimmed) {
      const roots = buildSessionTree(nameFiltered);
      this.filteredSessions = flattenSessionTree(roots);
    } else {
      const filtered = filterAndSortSessions(nameFiltered, query, this.sortMode, "all");
      this.filteredSessions = filtered.map((session) => ({
        session,
        depth: 0,
        isLast: true,
        ancestorContinues: []
      }));
    }
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredSessions.length - 1));
  }
  setConfirmingDeletePath(path) {
    this.confirmingDeletePath = path;
    this.onDeleteConfirmationChange?.(path);
  }
  startDeleteConfirmationForSelectedSession() {
    const selected = this.filteredSessions[this.selectedIndex];
    if (!selected) return;
    if (this.currentSessionFilePath && selected.session.path === this.currentSessionFilePath) {
      this.onError?.("Cannot delete the currently active session");
      return;
    }
    this.setConfirmingDeletePath(selected.session.path);
  }
  invalidate() {
  }
  render(width) {
    const lines = [];
    lines.push(...this.searchInput.render(width));
    lines.push("");
    if (this.filteredSessions.length === 0) {
      let emptyMessage;
      if (this.nameFilter === "named") {
        const toggleKey = appKey(this.keybindings, "toggleSessionNamedFilter");
        if (this.showCwd) {
          emptyMessage = `  No named sessions found. Press ${toggleKey} to show all.`;
        } else {
          emptyMessage = `  No named sessions in current folder. Press ${toggleKey} to show all, or Tab to view all.`;
        }
      } else if (this.showCwd) {
        emptyMessage = "  No sessions found";
      } else {
        emptyMessage = "  No sessions in current folder. Press Tab to view all.";
      }
      lines.push(theme.fg("muted", truncateToWidth(emptyMessage, width, "\u2026")));
      return lines;
    }
    const { startIndex, endIndex } = computeScrollWindow(
      this.selectedIndex,
      this.filteredSessions.length,
      this.maxVisible
    );
    for (let i = startIndex; i < endIndex; i++) {
      const node = this.filteredSessions[i];
      const session = node.session;
      const isSelected = i === this.selectedIndex;
      const isConfirmingDelete = session.path === this.confirmingDeletePath;
      const isCurrent = this.currentSessionFilePath === session.path;
      const prefix = this.buildNodeTreePrefix(node);
      const hasName = !!session.name;
      const displayText = session.name ?? session.firstMessage;
      const normalizedMessage = displayText.replace(/[\x00-\x1f\x7f]/g, " ").trim();
      const age = formatSessionDate(session.modified);
      const msgCount = String(session.messageCount);
      let rightPart = `${msgCount} ${age}`;
      if (this.showCwd && session.cwd) {
        rightPart = `${shortenPath(session.cwd)} ${rightPart}`;
      }
      if (this.showPath) {
        rightPart = `${shortenPath(session.path)} ${rightPart}`;
      }
      const cursor = renderCursor(isSelected);
      const prefixWidth = visibleWidth(prefix);
      const rightWidth = visibleWidth(rightPart) + 2;
      const availableForMsg = width - 2 - prefixWidth - rightWidth;
      const truncatedMsg = truncateToWidth(normalizedMessage, Math.max(10, availableForMsg), "\u2026");
      let messageColor = null;
      if (isConfirmingDelete) {
        messageColor = "error";
      } else if (isCurrent) {
        messageColor = "accent";
      } else if (hasName) {
        messageColor = "warning";
      }
      let styledMsg = messageColor ? theme.fg(messageColor, truncatedMsg) : truncatedMsg;
      if (isSelected) {
        styledMsg = theme.bold(styledMsg);
      }
      const leftPart = cursor + theme.fg("dim", prefix) + styledMsg;
      const leftWidth = visibleWidth(leftPart);
      const spacing = Math.max(1, width - leftWidth - visibleWidth(rightPart));
      const styledRight = theme.fg(isConfirmingDelete ? "error" : "dim", rightPart);
      const line = leftPart + " ".repeat(spacing) + styledRight;
      lines.push(applyRowHighlight(line, isSelected, width));
    }
    if (startIndex > 0 || endIndex < this.filteredSessions.length) {
      const scrollText = `  (${this.selectedIndex + 1}/${this.filteredSessions.length})`;
      const scrollInfo = theme.fg("muted", truncateToWidth(scrollText, width, ""));
      lines.push(scrollInfo);
    }
    return lines;
  }
  buildNodeTreePrefix(node) {
    return buildTreePrefix(node.ancestorContinues, node.isLast, node.depth);
  }
  handleInput(keyData) {
    const kb = getEditorKeybindings();
    if (this.confirmingDeletePath !== null) {
      if (kb.matches(keyData, "selectConfirm")) {
        const pathToDelete = this.confirmingDeletePath;
        this.setConfirmingDeletePath(null);
        void this.onDeleteSession?.(pathToDelete);
        return;
      }
      if (kb.matches(keyData, "selectCancel") || matchesKey(keyData, "ctrl+c")) {
        this.setConfirmingDeletePath(null);
        return;
      }
      return;
    }
    if (kb.matches(keyData, "tab")) {
      if (this.onToggleScope) {
        this.onToggleScope();
      }
      return;
    }
    if (kb.matches(keyData, "toggleSessionSort")) {
      this.onToggleSort?.();
      return;
    }
    if (this.keybindings.matches(keyData, "toggleSessionNamedFilter")) {
      this.onToggleNameFilter?.();
      return;
    }
    if (kb.matches(keyData, "toggleSessionPath")) {
      this.showPath = !this.showPath;
      this.onTogglePath?.(this.showPath);
      return;
    }
    if (kb.matches(keyData, "deleteSession")) {
      this.startDeleteConfirmationForSelectedSession();
      return;
    }
    if (matchesKey(keyData, "ctrl+r")) {
      const selected = this.filteredSessions[this.selectedIndex];
      if (selected) {
        this.onRenameSession?.(selected.session.path);
      }
      return;
    }
    if (kb.matches(keyData, "deleteSessionNoninvasive")) {
      if (this.searchInput.getValue().length > 0) {
        this.searchInput.handleInput(keyData);
        this.filterSessions(this.searchInput.getValue());
        return;
      }
      this.startDeleteConfirmationForSelectedSession();
      return;
    }
    if (kb.matches(keyData, "selectUp")) {
      this.selectedIndex = this.selectedIndex === 0 ? this.filteredSessions.length - 1 : this.selectedIndex - 1;
    } else if (kb.matches(keyData, "selectDown")) {
      this.selectedIndex = this.selectedIndex === this.filteredSessions.length - 1 ? 0 : this.selectedIndex + 1;
    } else if (kb.matches(keyData, "selectPageUp")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
    } else if (kb.matches(keyData, "selectPageDown")) {
      this.selectedIndex = Math.min(this.filteredSessions.length - 1, this.selectedIndex + this.maxVisible);
    } else if (kb.matches(keyData, "selectConfirm")) {
      const selected = this.filteredSessions[this.selectedIndex];
      if (selected && this.onSelect) {
        this.onSelect(selected.session.path);
      }
    } else if (kb.matches(keyData, "selectCancel")) {
      if (this.onCancel) {
        this.onCancel();
      }
    } else {
      this.searchInput.handleInput(keyData);
      this.filterSessions(this.searchInput.getValue());
    }
  }
}
async function deleteSessionFile(sessionPath) {
  const trashArgs = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
  const trashResult = spawnSync("trash", trashArgs, { encoding: "utf-8" });
  const getTrashErrorHint = () => {
    const parts = [];
    if (trashResult.error) {
      parts.push(trashResult.error.message);
    }
    const stderr = trashResult.stderr?.trim();
    if (stderr) {
      parts.push(stderr.split("\n")[0] ?? stderr);
    }
    if (parts.length === 0) return null;
    return `trash: ${parts.join(" \xB7 ").slice(0, 200)}`;
  };
  if (trashResult.status === 0 || !existsSync(sessionPath)) {
    return { ok: true, method: "trash" };
  }
  try {
    await unlink(sessionPath);
    return { ok: true, method: "unlink" };
  } catch (err) {
    const unlinkError = err instanceof Error ? err.message : String(err);
    const trashErrorHint = getTrashErrorHint();
    const error = trashErrorHint ? `${unlinkError} (${trashErrorHint})` : unlinkError;
    return { ok: false, method: "unlink", error };
  }
}
class SessionSelectorComponent extends Container {
  constructor(currentSessionsLoader, allSessionsLoader, onSelect, onCancel, onExit, requestRender, options, currentSessionFilePath) {
    super();
    this.canRename = true;
    this.scope = "current";
    this.sortMode = "threaded";
    this.nameFilter = "all";
    this.currentSessions = null;
    this.allSessions = null;
    this.currentLoading = false;
    this.allLoading = false;
    this.allLoadSeq = 0;
    this.mode = "list";
    this.renameInput = new Input();
    this.renameTargetPath = null;
    // Focusable implementation - propagate to sessionList for IME cursor positioning
    this._focused = false;
    this.keybindings = options?.keybindings ?? KeybindingsManager.create();
    this.currentSessionsLoader = currentSessionsLoader;
    this.allSessionsLoader = allSessionsLoader;
    this.onCancel = onCancel;
    this.requestRender = requestRender;
    this.header = new SessionSelectorHeader(
      this.scope,
      this.sortMode,
      this.nameFilter,
      this.keybindings,
      this.requestRender
    );
    const renameSession = options?.renameSession;
    this.renameSession = renameSession;
    this.canRename = !!renameSession;
    this.header.setShowRenameHint(options?.showRenameHint ?? this.canRename);
    this.sessionList = new SessionList(
      [],
      false,
      this.sortMode,
      this.nameFilter,
      this.keybindings,
      currentSessionFilePath
    );
    this.buildBaseLayout(this.sessionList);
    this.renameInput.onSubmit = (value) => {
      void this.confirmRename(value);
    };
    const clearStatusMessage = () => this.header.setStatusMessage(null);
    this.sessionList.onSelect = (sessionPath) => {
      clearStatusMessage();
      onSelect(sessionPath);
    };
    this.sessionList.onCancel = () => {
      clearStatusMessage();
      onCancel();
    };
    this.sessionList.onExit = () => {
      clearStatusMessage();
      onExit();
    };
    this.sessionList.onToggleScope = () => this.toggleScope();
    this.sessionList.onToggleSort = () => this.toggleSortMode();
    this.sessionList.onToggleNameFilter = () => this.toggleNameFilter();
    this.sessionList.onRenameSession = (sessionPath) => {
      if (!renameSession) return;
      if (this.scope === "current" && this.currentLoading) return;
      if (this.scope === "all" && this.allLoading) return;
      const sessions = this.scope === "all" ? this.allSessions ?? [] : this.currentSessions ?? [];
      const session = sessions.find((s) => s.path === sessionPath);
      this.enterRenameMode(sessionPath, session?.name);
    };
    this.sessionList.onTogglePath = (showPath) => {
      this.header.setShowPath(showPath);
      this.requestRender();
    };
    this.sessionList.onDeleteConfirmationChange = (path) => {
      this.header.setConfirmingDeletePath(path);
      this.requestRender();
    };
    this.sessionList.onError = (msg) => {
      this.header.setStatusMessage({ type: "error", message: msg }, 3e3);
      this.requestRender();
    };
    this.sessionList.onDeleteSession = async (sessionPath) => {
      const result = await deleteSessionFile(sessionPath);
      if (result.ok) {
        if (this.currentSessions) {
          this.currentSessions = this.currentSessions.filter((s) => s.path !== sessionPath);
        }
        if (this.allSessions) {
          this.allSessions = this.allSessions.filter((s) => s.path !== sessionPath);
        }
        const sessions = this.scope === "all" ? this.allSessions ?? [] : this.currentSessions ?? [];
        const showCwd = this.scope === "all";
        this.sessionList.setSessions(sessions, showCwd);
        const msg = result.method === "trash" ? "Session moved to trash" : "Session deleted";
        this.header.setStatusMessage({ type: "info", message: msg }, 2e3);
        await this.refreshSessionsAfterMutation();
      } else {
        const errorMessage = result.error ?? "Unknown error";
        this.header.setStatusMessage({ type: "error", message: `Failed to delete: ${errorMessage}` }, 3e3);
      }
      this.requestRender();
    };
    this.loadCurrentSessions();
  }
  handleInput(data) {
    if (this.mode === "rename") {
      const kb = getEditorKeybindings();
      if (kb.matches(data, "selectCancel") || matchesKey(data, "ctrl+c")) {
        this.exitRenameMode();
        return;
      }
      this.renameInput.handleInput(data);
      return;
    }
    this.sessionList.handleInput(data);
  }
  get focused() {
    return this._focused;
  }
  set focused(value) {
    this._focused = value;
    this.sessionList.focused = value;
    this.renameInput.focused = value;
    if (value && this.mode === "rename") {
      this.renameInput.focused = true;
    }
  }
  buildBaseLayout(content, options) {
    this.clear();
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
    this.addChild(new Spacer(1));
    if (options?.showHeader ?? true) {
      this.addChild(this.header);
      this.addChild(new Spacer(1));
    }
    this.addChild(content);
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
  }
  loadCurrentSessions() {
    void this.loadScope("current", "initial");
  }
  enterRenameMode(sessionPath, currentName) {
    this.mode = "rename";
    this.renameTargetPath = sessionPath;
    this.renameInput.setValue(currentName ?? "");
    this.renameInput.focused = true;
    const panel = new Container();
    panel.addChild(new Text(theme.bold("Rename Session"), 1, 0));
    panel.addChild(new Spacer(1));
    panel.addChild(this.renameInput);
    panel.addChild(new Spacer(1));
    panel.addChild(new Text(theme.fg("muted", "Enter to save \xB7 Esc/Ctrl+C to cancel"), 1, 0));
    this.buildBaseLayout(panel, { showHeader: false });
    this.requestRender();
  }
  exitRenameMode() {
    this.mode = "list";
    this.renameTargetPath = null;
    this.buildBaseLayout(this.sessionList);
    this.requestRender();
  }
  async confirmRename(value) {
    const next = value.trim();
    if (!next) return;
    const target = this.renameTargetPath;
    if (!target) {
      this.exitRenameMode();
      return;
    }
    const renameSession = this.renameSession;
    if (!renameSession) {
      this.exitRenameMode();
      return;
    }
    try {
      await renameSession(target, next);
      await this.refreshSessionsAfterMutation();
    } finally {
      this.exitRenameMode();
    }
  }
  async loadScope(scope, reason) {
    const showCwd = scope === "all";
    if (scope === "current") {
      this.currentLoading = true;
    } else {
      this.allLoading = true;
    }
    const seq = scope === "all" ? ++this.allLoadSeq : void 0;
    this.header.setScope(scope);
    this.header.setLoading(true);
    this.requestRender();
    const onProgress = (loaded, total) => {
      if (scope !== this.scope) return;
      if (seq !== void 0 && seq !== this.allLoadSeq) return;
      this.header.setProgress(loaded, total);
      this.requestRender();
    };
    try {
      const sessions = await (scope === "current" ? this.currentSessionsLoader(onProgress) : this.allSessionsLoader(onProgress));
      if (scope === "current") {
        this.currentSessions = sessions;
        this.currentLoading = false;
      } else {
        this.allSessions = sessions;
        this.allLoading = false;
      }
      if (scope !== this.scope) return;
      if (seq !== void 0 && seq !== this.allLoadSeq) return;
      this.header.setLoading(false);
      this.sessionList.setSessions(sessions, showCwd);
      this.requestRender();
      if (scope === "all" && sessions.length === 0 && (this.currentSessions?.length ?? 0) === 0) {
        this.onCancel();
      }
    } catch (err) {
      if (scope === "current") {
        this.currentLoading = false;
      } else {
        this.allLoading = false;
      }
      if (scope !== this.scope) return;
      if (seq !== void 0 && seq !== this.allLoadSeq) return;
      const message = err instanceof Error ? err.message : String(err);
      this.header.setLoading(false);
      this.header.setStatusMessage({ type: "error", message: `Failed to load sessions: ${message}` }, 4e3);
      if (reason === "initial") {
        this.sessionList.setSessions([], showCwd);
      }
      this.requestRender();
    }
  }
  toggleSortMode() {
    this.sortMode = this.sortMode === "threaded" ? "recent" : this.sortMode === "recent" ? "relevance" : "threaded";
    this.header.setSortMode(this.sortMode);
    this.sessionList.setSortMode(this.sortMode);
    this.requestRender();
  }
  toggleNameFilter() {
    this.nameFilter = this.nameFilter === "all" ? "named" : "all";
    this.header.setNameFilter(this.nameFilter);
    this.sessionList.setNameFilter(this.nameFilter);
    this.requestRender();
  }
  async refreshSessionsAfterMutation() {
    await this.loadScope(this.scope, "refresh");
  }
  toggleScope() {
    if (this.scope === "current") {
      this.scope = "all";
      this.header.setScope(this.scope);
      if (this.allSessions !== null) {
        this.header.setLoading(false);
        this.sessionList.setSessions(this.allSessions, true);
        this.requestRender();
        return;
      }
      if (!this.allLoading) {
        void this.loadScope("all", "toggle");
      }
      return;
    }
    this.scope = "current";
    this.header.setScope(this.scope);
    this.header.setLoading(this.currentLoading);
    this.sessionList.setSessions(this.currentSessions ?? [], false);
    this.requestRender();
  }
  getSessionList() {
    return this.sessionList;
  }
}
export {
  SessionSelectorComponent
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9tb2Rlcy9pbnRlcmFjdGl2ZS9jb21wb25lbnRzL3Nlc3Npb24tc2VsZWN0b3IudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IHNwYXduU3luYyB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgdW5saW5rIH0gZnJvbSBcIm5vZGU6ZnMvcHJvbWlzZXNcIjtcbmltcG9ydCB7XG5cdHR5cGUgQ29tcG9uZW50LFxuXHRDb250YWluZXIsXG5cdHR5cGUgRm9jdXNhYmxlLFxuXHRnZXRFZGl0b3JLZXliaW5kaW5ncyxcblx0SW5wdXQsXG5cdG1hdGNoZXNLZXksXG5cdFNwYWNlcixcblx0VGV4dCxcblx0dHJ1bmNhdGVUb1dpZHRoLFxuXHR2aXNpYmxlV2lkdGgsXG59IGZyb20gXCJAZ3NkL3BpLXR1aVwiO1xuaW1wb3J0IHsgS2V5YmluZGluZ3NNYW5hZ2VyIH0gZnJvbSBcIi4uLy4uLy4uL2NvcmUva2V5YmluZGluZ3MuanNcIjtcbmltcG9ydCB0eXBlIHsgU2Vzc2lvbkluZm8sIFNlc3Npb25MaXN0UHJvZ3Jlc3MgfSBmcm9tIFwiLi4vLi4vLi4vY29yZS9zZXNzaW9uLW1hbmFnZXIuanNcIjtcbmltcG9ydCB7IHRoZW1lIH0gZnJvbSBcIi4uL3RoZW1lL3RoZW1lLmpzXCI7XG5pbXBvcnQgeyBzaG9ydGVuUGF0aCB9IGZyb20gXCIuLi91dGlscy9zaG9ydGVuLXBhdGguanNcIjtcbmltcG9ydCB7IER5bmFtaWNCb3JkZXIgfSBmcm9tIFwiLi9keW5hbWljLWJvcmRlci5qc1wiO1xuaW1wb3J0IHsgYXBwS2V5LCBhcHBLZXlIaW50LCBrZXlIaW50IH0gZnJvbSBcIi4va2V5YmluZGluZy1oaW50cy5qc1wiO1xuaW1wb3J0IHsgZmlsdGVyQW5kU29ydFNlc3Npb25zLCBoYXNTZXNzaW9uTmFtZSwgdHlwZSBOYW1lRmlsdGVyLCB0eXBlIFNvcnRNb2RlIH0gZnJvbSBcIi4vc2Vzc2lvbi1zZWxlY3Rvci1zZWFyY2guanNcIjtcbmltcG9ydCB7XG5cdGFwcGx5Um93SGlnaGxpZ2h0LFxuXHRidWlsZFRyZWVQcmVmaXgsXG5cdGNvbXB1dGVTY3JvbGxXaW5kb3csXG5cdHJlbmRlckN1cnNvcixcbn0gZnJvbSBcIi4vdHJlZS1yZW5kZXItdXRpbHMuanNcIjtcblxudHlwZSBTZXNzaW9uU2NvcGUgPSBcImN1cnJlbnRcIiB8IFwiYWxsXCI7XG5cbmZ1bmN0aW9uIGZvcm1hdFNlc3Npb25EYXRlKGRhdGU6IERhdGUpOiBzdHJpbmcge1xuXHRjb25zdCBub3cgPSBuZXcgRGF0ZSgpO1xuXHRjb25zdCBkaWZmTXMgPSBub3cuZ2V0VGltZSgpIC0gZGF0ZS5nZXRUaW1lKCk7XG5cdGNvbnN0IGRpZmZNaW5zID0gTWF0aC5mbG9vcihkaWZmTXMgLyA2MDAwMCk7XG5cdGNvbnN0IGRpZmZIb3VycyA9IE1hdGguZmxvb3IoZGlmZk1zIC8gMzYwMDAwMCk7XG5cdGNvbnN0IGRpZmZEYXlzID0gTWF0aC5mbG9vcihkaWZmTXMgLyA4NjQwMDAwMCk7XG5cblx0aWYgKGRpZmZNaW5zIDwgMSkgcmV0dXJuIFwibm93XCI7XG5cdGlmIChkaWZmTWlucyA8IDYwKSByZXR1cm4gYCR7ZGlmZk1pbnN9bWA7XG5cdGlmIChkaWZmSG91cnMgPCAyNCkgcmV0dXJuIGAke2RpZmZIb3Vyc31oYDtcblx0aWYgKGRpZmZEYXlzIDwgNykgcmV0dXJuIGAke2RpZmZEYXlzfWRgO1xuXHRpZiAoZGlmZkRheXMgPCAzMCkgcmV0dXJuIGAke01hdGguZmxvb3IoZGlmZkRheXMgLyA3KX13YDtcblx0aWYgKGRpZmZEYXlzIDwgMzY1KSByZXR1cm4gYCR7TWF0aC5mbG9vcihkaWZmRGF5cyAvIDMwKX1tb2A7XG5cdHJldHVybiBgJHtNYXRoLmZsb29yKGRpZmZEYXlzIC8gMzY1KX15YDtcbn1cblxuY2xhc3MgU2Vzc2lvblNlbGVjdG9ySGVhZGVyIGltcGxlbWVudHMgQ29tcG9uZW50IHtcblx0cHJpdmF0ZSBzY29wZTogU2Vzc2lvblNjb3BlO1xuXHRwcml2YXRlIHNvcnRNb2RlOiBTb3J0TW9kZTtcblx0cHJpdmF0ZSBuYW1lRmlsdGVyOiBOYW1lRmlsdGVyO1xuXHRwcml2YXRlIGtleWJpbmRpbmdzOiBLZXliaW5kaW5nc01hbmFnZXI7XG5cdHByaXZhdGUgcmVxdWVzdFJlbmRlcjogKCkgPT4gdm9pZDtcblx0cHJpdmF0ZSBsb2FkaW5nID0gZmFsc2U7XG5cdHByaXZhdGUgbG9hZFByb2dyZXNzOiB7IGxvYWRlZDogbnVtYmVyOyB0b3RhbDogbnVtYmVyIH0gfCBudWxsID0gbnVsbDtcblx0cHJpdmF0ZSBzaG93UGF0aCA9IGZhbHNlO1xuXHRwcml2YXRlIGNvbmZpcm1pbmdEZWxldGVQYXRoOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblx0cHJpdmF0ZSBzdGF0dXNNZXNzYWdlOiB7IHR5cGU6IFwiaW5mb1wiIHwgXCJlcnJvclwiOyBtZXNzYWdlOiBzdHJpbmcgfSB8IG51bGwgPSBudWxsO1xuXHRwcml2YXRlIHN0YXR1c1RpbWVvdXQ6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XG5cdHByaXZhdGUgc2hvd1JlbmFtZUhpbnQgPSBmYWxzZTtcblxuXHRjb25zdHJ1Y3Rvcihcblx0XHRzY29wZTogU2Vzc2lvblNjb3BlLFxuXHRcdHNvcnRNb2RlOiBTb3J0TW9kZSxcblx0XHRuYW1lRmlsdGVyOiBOYW1lRmlsdGVyLFxuXHRcdGtleWJpbmRpbmdzOiBLZXliaW5kaW5nc01hbmFnZXIsXG5cdFx0cmVxdWVzdFJlbmRlcjogKCkgPT4gdm9pZCxcblx0KSB7XG5cdFx0dGhpcy5zY29wZSA9IHNjb3BlO1xuXHRcdHRoaXMuc29ydE1vZGUgPSBzb3J0TW9kZTtcblx0XHR0aGlzLm5hbWVGaWx0ZXIgPSBuYW1lRmlsdGVyO1xuXHRcdHRoaXMua2V5YmluZGluZ3MgPSBrZXliaW5kaW5ncztcblx0XHR0aGlzLnJlcXVlc3RSZW5kZXIgPSByZXF1ZXN0UmVuZGVyO1xuXHR9XG5cblx0c2V0U2NvcGUoc2NvcGU6IFNlc3Npb25TY29wZSk6IHZvaWQge1xuXHRcdHRoaXMuc2NvcGUgPSBzY29wZTtcblx0fVxuXG5cdHNldFNvcnRNb2RlKHNvcnRNb2RlOiBTb3J0TW9kZSk6IHZvaWQge1xuXHRcdHRoaXMuc29ydE1vZGUgPSBzb3J0TW9kZTtcblx0fVxuXG5cdHNldE5hbWVGaWx0ZXIobmFtZUZpbHRlcjogTmFtZUZpbHRlcik6IHZvaWQge1xuXHRcdHRoaXMubmFtZUZpbHRlciA9IG5hbWVGaWx0ZXI7XG5cdH1cblxuXHRzZXRMb2FkaW5nKGxvYWRpbmc6IGJvb2xlYW4pOiB2b2lkIHtcblx0XHR0aGlzLmxvYWRpbmcgPSBsb2FkaW5nO1xuXHRcdC8vIFByb2dyZXNzIGlzIHNjb3BlZCB0byB0aGUgY3VycmVudCBsb2FkOyBjbGVhciB3aGVuZXZlciB0aGUgbG9hZGluZyBzdGF0ZSBpcyBzZXRcblx0XHR0aGlzLmxvYWRQcm9ncmVzcyA9IG51bGw7XG5cdH1cblxuXHRzZXRQcm9ncmVzcyhsb2FkZWQ6IG51bWJlciwgdG90YWw6IG51bWJlcik6IHZvaWQge1xuXHRcdHRoaXMubG9hZFByb2dyZXNzID0geyBsb2FkZWQsIHRvdGFsIH07XG5cdH1cblxuXHRzZXRTaG93UGF0aChzaG93UGF0aDogYm9vbGVhbik6IHZvaWQge1xuXHRcdHRoaXMuc2hvd1BhdGggPSBzaG93UGF0aDtcblx0fVxuXG5cdHNldFNob3dSZW5hbWVIaW50KHNob3c6IGJvb2xlYW4pOiB2b2lkIHtcblx0XHR0aGlzLnNob3dSZW5hbWVIaW50ID0gc2hvdztcblx0fVxuXG5cdHNldENvbmZpcm1pbmdEZWxldGVQYXRoKHBhdGg6IHN0cmluZyB8IG51bGwpOiB2b2lkIHtcblx0XHR0aGlzLmNvbmZpcm1pbmdEZWxldGVQYXRoID0gcGF0aDtcblx0fVxuXG5cdHByaXZhdGUgY2xlYXJTdGF0dXNUaW1lb3V0KCk6IHZvaWQge1xuXHRcdGlmICghdGhpcy5zdGF0dXNUaW1lb3V0KSByZXR1cm47XG5cdFx0Y2xlYXJUaW1lb3V0KHRoaXMuc3RhdHVzVGltZW91dCk7XG5cdFx0dGhpcy5zdGF0dXNUaW1lb3V0ID0gbnVsbDtcblx0fVxuXG5cdHNldFN0YXR1c01lc3NhZ2UobXNnOiB7IHR5cGU6IFwiaW5mb1wiIHwgXCJlcnJvclwiOyBtZXNzYWdlOiBzdHJpbmcgfSB8IG51bGwsIGF1dG9IaWRlTXM/OiBudW1iZXIpOiB2b2lkIHtcblx0XHR0aGlzLmNsZWFyU3RhdHVzVGltZW91dCgpO1xuXHRcdHRoaXMuc3RhdHVzTWVzc2FnZSA9IG1zZztcblx0XHRpZiAoIW1zZyB8fCAhYXV0b0hpZGVNcykgcmV0dXJuO1xuXG5cdFx0dGhpcy5zdGF0dXNUaW1lb3V0ID0gc2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHR0aGlzLnN0YXR1c01lc3NhZ2UgPSBudWxsO1xuXHRcdFx0dGhpcy5zdGF0dXNUaW1lb3V0ID0gbnVsbDtcblx0XHRcdHRoaXMucmVxdWVzdFJlbmRlcigpO1xuXHRcdH0sIGF1dG9IaWRlTXMpO1xuXHR9XG5cblx0aW52YWxpZGF0ZSgpOiB2b2lkIHt9XG5cblx0cmVuZGVyKHdpZHRoOiBudW1iZXIpOiBzdHJpbmdbXSB7XG5cdFx0Y29uc3QgdGl0bGUgPSB0aGlzLnNjb3BlID09PSBcImN1cnJlbnRcIiA/IFwiUmVzdW1lIFNlc3Npb24gKEN1cnJlbnQgRm9sZGVyKVwiIDogXCJSZXN1bWUgU2Vzc2lvbiAoQWxsKVwiO1xuXHRcdGNvbnN0IGxlZnRUZXh0ID0gdGhlbWUuYm9sZCh0aXRsZSk7XG5cblx0XHRjb25zdCBzb3J0TGFiZWwgPSB0aGlzLnNvcnRNb2RlID09PSBcInRocmVhZGVkXCIgPyBcIlRocmVhZGVkXCIgOiB0aGlzLnNvcnRNb2RlID09PSBcInJlY2VudFwiID8gXCJSZWNlbnRcIiA6IFwiRnV6enlcIjtcblx0XHRjb25zdCBzb3J0VGV4dCA9IHRoZW1lLmZnKFwibXV0ZWRcIiwgXCJTb3J0OiBcIikgKyB0aGVtZS5mZyhcImFjY2VudFwiLCBzb3J0TGFiZWwpO1xuXG5cdFx0Y29uc3QgbmFtZUxhYmVsID0gdGhpcy5uYW1lRmlsdGVyID09PSBcImFsbFwiID8gXCJBbGxcIiA6IFwiTmFtZWRcIjtcblx0XHRjb25zdCBuYW1lVGV4dCA9IHRoZW1lLmZnKFwibXV0ZWRcIiwgXCJOYW1lOiBcIikgKyB0aGVtZS5mZyhcImFjY2VudFwiLCBuYW1lTGFiZWwpO1xuXG5cdFx0bGV0IHNjb3BlVGV4dDogc3RyaW5nO1xuXHRcdGlmICh0aGlzLmxvYWRpbmcpIHtcblx0XHRcdGNvbnN0IHByb2dyZXNzVGV4dCA9IHRoaXMubG9hZFByb2dyZXNzID8gYCR7dGhpcy5sb2FkUHJvZ3Jlc3MubG9hZGVkfS8ke3RoaXMubG9hZFByb2dyZXNzLnRvdGFsfWAgOiBcIi4uLlwiO1xuXHRcdFx0c2NvcGVUZXh0ID0gYCR7dGhlbWUuZmcoXCJtdXRlZFwiLCBcIlx1MjVDQiBDdXJyZW50IEZvbGRlciB8IFwiKX0ke3RoZW1lLmZnKFwiYWNjZW50XCIsIGBMb2FkaW5nICR7cHJvZ3Jlc3NUZXh0fWApfWA7XG5cdFx0fSBlbHNlIGlmICh0aGlzLnNjb3BlID09PSBcImN1cnJlbnRcIikge1xuXHRcdFx0c2NvcGVUZXh0ID0gYCR7dGhlbWUuZmcoXCJhY2NlbnRcIiwgXCJcdTI1QzkgQ3VycmVudCBGb2xkZXJcIil9JHt0aGVtZS5mZyhcIm11dGVkXCIsIFwiIHwgXHUyNUNCIEFsbFwiKX1gO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHRzY29wZVRleHQgPSBgJHt0aGVtZS5mZyhcIm11dGVkXCIsIFwiXHUyNUNCIEN1cnJlbnQgRm9sZGVyIHwgXCIpfSR7dGhlbWUuZmcoXCJhY2NlbnRcIiwgXCJcdTI1QzkgQWxsXCIpfWA7XG5cdFx0fVxuXG5cdFx0Y29uc3QgcmlnaHRUZXh0ID0gdHJ1bmNhdGVUb1dpZHRoKGAke3Njb3BlVGV4dH0gICR7bmFtZVRleHR9ICAke3NvcnRUZXh0fWAsIHdpZHRoLCBcIlwiKTtcblx0XHRjb25zdCBhdmFpbGFibGVMZWZ0ID0gTWF0aC5tYXgoMCwgd2lkdGggLSB2aXNpYmxlV2lkdGgocmlnaHRUZXh0KSAtIDEpO1xuXHRcdGNvbnN0IGxlZnQgPSB0cnVuY2F0ZVRvV2lkdGgobGVmdFRleHQsIGF2YWlsYWJsZUxlZnQsIFwiXCIpO1xuXHRcdGNvbnN0IHNwYWNpbmcgPSBNYXRoLm1heCgwLCB3aWR0aCAtIHZpc2libGVXaWR0aChsZWZ0KSAtIHZpc2libGVXaWR0aChyaWdodFRleHQpKTtcblxuXHRcdC8vIEJ1aWxkIGhpbnQgbGluZXMgLSBjaGFuZ2VzIGJhc2VkIG9uIHN0YXRlIChhbGwgYnJhbmNoZXMgdHJ1bmNhdGUgdG8gd2lkdGgpXG5cdFx0bGV0IGhpbnRMaW5lMTogc3RyaW5nO1xuXHRcdGxldCBoaW50TGluZTI6IHN0cmluZztcblx0XHRpZiAodGhpcy5jb25maXJtaW5nRGVsZXRlUGF0aCAhPT0gbnVsbCkge1xuXHRcdFx0Y29uc3QgY29uZmlybUhpbnQgPSBcIkRlbGV0ZSBzZXNzaW9uPyBbRW50ZXJdIGNvbmZpcm0gXHUwMEI3IFtFc2MvQ3RybCtDXSBjYW5jZWxcIjtcblx0XHRcdGhpbnRMaW5lMSA9IHRoZW1lLmZnKFwiZXJyb3JcIiwgdHJ1bmNhdGVUb1dpZHRoKGNvbmZpcm1IaW50LCB3aWR0aCwgXCJcdTIwMjZcIikpO1xuXHRcdFx0aGludExpbmUyID0gXCJcIjtcblx0XHR9IGVsc2UgaWYgKHRoaXMuc3RhdHVzTWVzc2FnZSkge1xuXHRcdFx0Y29uc3QgY29sb3IgPSB0aGlzLnN0YXR1c01lc3NhZ2UudHlwZSA9PT0gXCJlcnJvclwiID8gXCJlcnJvclwiIDogXCJhY2NlbnRcIjtcblx0XHRcdGhpbnRMaW5lMSA9IHRoZW1lLmZnKGNvbG9yLCB0cnVuY2F0ZVRvV2lkdGgodGhpcy5zdGF0dXNNZXNzYWdlLm1lc3NhZ2UsIHdpZHRoLCBcIlx1MjAyNlwiKSk7XG5cdFx0XHRoaW50TGluZTIgPSBcIlwiO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHRjb25zdCBwYXRoU3RhdGUgPSB0aGlzLnNob3dQYXRoID8gXCIob24pXCIgOiBcIihvZmYpXCI7XG5cdFx0XHRjb25zdCBzZXAgPSB0aGVtZS5mZyhcIm11dGVkXCIsIFwiIFx1MDBCNyBcIik7XG5cdFx0XHRjb25zdCBoaW50MSA9IGtleUhpbnQoXCJ0YWJcIiwgXCJzY29wZVwiKSArIHNlcCArIHRoZW1lLmZnKFwibXV0ZWRcIiwgJ3JlOjxwYXR0ZXJuPiByZWdleCBcdTAwQjcgXCJwaHJhc2VcIiBleGFjdCcpO1xuXHRcdFx0Y29uc3QgaGludDJQYXJ0cyA9IFtcblx0XHRcdFx0a2V5SGludChcInRvZ2dsZVNlc3Npb25Tb3J0XCIsIFwic29ydFwiKSxcblx0XHRcdFx0YXBwS2V5SGludCh0aGlzLmtleWJpbmRpbmdzLCBcInRvZ2dsZVNlc3Npb25OYW1lZEZpbHRlclwiLCBcIm5hbWVkXCIpLFxuXHRcdFx0XHRrZXlIaW50KFwiZGVsZXRlU2Vzc2lvblwiLCBcImRlbGV0ZVwiKSxcblx0XHRcdFx0a2V5SGludChcInRvZ2dsZVNlc3Npb25QYXRoXCIsIGBwYXRoICR7cGF0aFN0YXRlfWApLFxuXHRcdFx0XTtcblx0XHRcdGlmICh0aGlzLnNob3dSZW5hbWVIaW50KSB7XG5cdFx0XHRcdGhpbnQyUGFydHMucHVzaChrZXlIaW50KFwicmVuYW1lU2Vzc2lvblwiLCBcInJlbmFtZVwiKSk7XG5cdFx0XHR9XG5cdFx0XHRjb25zdCBoaW50MiA9IGhpbnQyUGFydHMuam9pbihzZXApO1xuXHRcdFx0aGludExpbmUxID0gdHJ1bmNhdGVUb1dpZHRoKGhpbnQxLCB3aWR0aCwgXCJcdTIwMjZcIik7XG5cdFx0XHRoaW50TGluZTIgPSB0cnVuY2F0ZVRvV2lkdGgoaGludDIsIHdpZHRoLCBcIlx1MjAyNlwiKTtcblx0XHR9XG5cblx0XHRyZXR1cm4gW2Ake2xlZnR9JHtcIiBcIi5yZXBlYXQoc3BhY2luZyl9JHtyaWdodFRleHR9YCwgaGludExpbmUxLCBoaW50TGluZTJdO1xuXHR9XG59XG5cbi8qKiBBIHNlc3Npb24gdHJlZSBub2RlIGZvciBoaWVyYXJjaGljYWwgZGlzcGxheSAqL1xuaW50ZXJmYWNlIFNlc3Npb25UcmVlTm9kZSB7XG5cdHNlc3Npb246IFNlc3Npb25JbmZvO1xuXHRjaGlsZHJlbjogU2Vzc2lvblRyZWVOb2RlW107XG59XG5cbi8qKiBGbGF0dGVuZWQgbm9kZSBmb3IgZGlzcGxheSB3aXRoIHRyZWUgc3RydWN0dXJlIGluZm8gKi9cbmludGVyZmFjZSBGbGF0U2Vzc2lvbk5vZGUge1xuXHRzZXNzaW9uOiBTZXNzaW9uSW5mbztcblx0ZGVwdGg6IG51bWJlcjtcblx0aXNMYXN0OiBib29sZWFuO1xuXHQvKiogRm9yIGVhY2ggYW5jZXN0b3IgbGV2ZWwsIHdoZXRoZXIgdGhlcmUgYXJlIG1vcmUgc2libGluZ3MgYWZ0ZXIgaXQgKi9cblx0YW5jZXN0b3JDb250aW51ZXM6IGJvb2xlYW5bXTtcbn1cblxuLyoqXG4gKiBCdWlsZCBhIHRyZWUgc3RydWN0dXJlIGZyb20gc2Vzc2lvbnMgYmFzZWQgb24gcGFyZW50U2Vzc2lvblBhdGguXG4gKiBSZXR1cm5zIHJvb3Qgbm9kZXMgc29ydGVkIGJ5IG1vZGlmaWVkIGRhdGUgKGRlc2NlbmRpbmcpLlxuICovXG5mdW5jdGlvbiBidWlsZFNlc3Npb25UcmVlKHNlc3Npb25zOiBTZXNzaW9uSW5mb1tdKTogU2Vzc2lvblRyZWVOb2RlW10ge1xuXHRjb25zdCBieVBhdGggPSBuZXcgTWFwPHN0cmluZywgU2Vzc2lvblRyZWVOb2RlPigpO1xuXG5cdGZvciAoY29uc3Qgc2Vzc2lvbiBvZiBzZXNzaW9ucykge1xuXHRcdGJ5UGF0aC5zZXQoc2Vzc2lvbi5wYXRoLCB7IHNlc3Npb24sIGNoaWxkcmVuOiBbXSB9KTtcblx0fVxuXG5cdGNvbnN0IHJvb3RzOiBTZXNzaW9uVHJlZU5vZGVbXSA9IFtdO1xuXG5cdGZvciAoY29uc3Qgc2Vzc2lvbiBvZiBzZXNzaW9ucykge1xuXHRcdGNvbnN0IG5vZGUgPSBieVBhdGguZ2V0KHNlc3Npb24ucGF0aCkhO1xuXHRcdGNvbnN0IHBhcmVudFBhdGggPSBzZXNzaW9uLnBhcmVudFNlc3Npb25QYXRoO1xuXG5cdFx0aWYgKHBhcmVudFBhdGggJiYgYnlQYXRoLmhhcyhwYXJlbnRQYXRoKSkge1xuXHRcdFx0YnlQYXRoLmdldChwYXJlbnRQYXRoKSEuY2hpbGRyZW4ucHVzaChub2RlKTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0cm9vdHMucHVzaChub2RlKTtcblx0XHR9XG5cdH1cblxuXHQvLyBTb3J0IGNoaWxkcmVuIGFuZCByb290cyBieSBtb2RpZmllZCBkYXRlIChkZXNjZW5kaW5nKVxuXHRjb25zdCBzb3J0Tm9kZXMgPSAobm9kZXM6IFNlc3Npb25UcmVlTm9kZVtdKTogdm9pZCA9PiB7XG5cdFx0bm9kZXMuc29ydCgoYSwgYikgPT4gYi5zZXNzaW9uLm1vZGlmaWVkLmdldFRpbWUoKSAtIGEuc2Vzc2lvbi5tb2RpZmllZC5nZXRUaW1lKCkpO1xuXHRcdGZvciAoY29uc3Qgbm9kZSBvZiBub2Rlcykge1xuXHRcdFx0c29ydE5vZGVzKG5vZGUuY2hpbGRyZW4pO1xuXHRcdH1cblx0fTtcblx0c29ydE5vZGVzKHJvb3RzKTtcblxuXHRyZXR1cm4gcm9vdHM7XG59XG5cbi8qKlxuICogRmxhdHRlbiB0cmVlIGludG8gZGlzcGxheSBsaXN0IHdpdGggdHJlZSBzdHJ1Y3R1cmUgbWV0YWRhdGEuXG4gKi9cbmZ1bmN0aW9uIGZsYXR0ZW5TZXNzaW9uVHJlZShyb290czogU2Vzc2lvblRyZWVOb2RlW10pOiBGbGF0U2Vzc2lvbk5vZGVbXSB7XG5cdGNvbnN0IHJlc3VsdDogRmxhdFNlc3Npb25Ob2RlW10gPSBbXTtcblxuXHRjb25zdCB3YWxrID0gKG5vZGU6IFNlc3Npb25UcmVlTm9kZSwgZGVwdGg6IG51bWJlciwgYW5jZXN0b3JDb250aW51ZXM6IGJvb2xlYW5bXSwgaXNMYXN0OiBib29sZWFuKTogdm9pZCA9PiB7XG5cdFx0cmVzdWx0LnB1c2goeyBzZXNzaW9uOiBub2RlLnNlc3Npb24sIGRlcHRoLCBpc0xhc3QsIGFuY2VzdG9yQ29udGludWVzIH0pO1xuXG5cdFx0Zm9yIChsZXQgaSA9IDA7IGkgPCBub2RlLmNoaWxkcmVuLmxlbmd0aDsgaSsrKSB7XG5cdFx0XHRjb25zdCBjaGlsZElzTGFzdCA9IGkgPT09IG5vZGUuY2hpbGRyZW4ubGVuZ3RoIC0gMTtcblx0XHRcdC8vIE9ubHkgc2hvdyBjb250aW51YXRpb24gbGluZSBmb3Igbm9uLXJvb3QgYW5jZXN0b3JzXG5cdFx0XHRjb25zdCBjb250aW51ZXMgPSBkZXB0aCA+IDAgPyAhaXNMYXN0IDogZmFsc2U7XG5cdFx0XHR3YWxrKG5vZGUuY2hpbGRyZW5baV0hLCBkZXB0aCArIDEsIFsuLi5hbmNlc3RvckNvbnRpbnVlcywgY29udGludWVzXSwgY2hpbGRJc0xhc3QpO1xuXHRcdH1cblx0fTtcblxuXHRmb3IgKGxldCBpID0gMDsgaSA8IHJvb3RzLmxlbmd0aDsgaSsrKSB7XG5cdFx0d2Fsayhyb290c1tpXSEsIDAsIFtdLCBpID09PSByb290cy5sZW5ndGggLSAxKTtcblx0fVxuXG5cdHJldHVybiByZXN1bHQ7XG59XG5cbi8qKlxuICogQ3VzdG9tIHNlc3Npb24gbGlzdCBjb21wb25lbnQgd2l0aCBtdWx0aS1saW5lIGl0ZW1zIGFuZCBzZWFyY2hcbiAqL1xuY2xhc3MgU2Vzc2lvbkxpc3QgaW1wbGVtZW50cyBDb21wb25lbnQsIEZvY3VzYWJsZSB7XG5cdHB1YmxpYyBnZXRTZWxlY3RlZFNlc3Npb25QYXRoKCk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG5cdFx0Y29uc3Qgc2VsZWN0ZWQgPSB0aGlzLmZpbHRlcmVkU2Vzc2lvbnNbdGhpcy5zZWxlY3RlZEluZGV4XTtcblx0XHRyZXR1cm4gc2VsZWN0ZWQ/LnNlc3Npb24ucGF0aDtcblx0fVxuXHRwcml2YXRlIGFsbFNlc3Npb25zOiBTZXNzaW9uSW5mb1tdID0gW107XG5cdHByaXZhdGUgZmlsdGVyZWRTZXNzaW9uczogRmxhdFNlc3Npb25Ob2RlW10gPSBbXTtcblx0cHJpdmF0ZSBzZWxlY3RlZEluZGV4OiBudW1iZXIgPSAwO1xuXHRwcml2YXRlIHNlYXJjaElucHV0OiBJbnB1dDtcblx0cHJpdmF0ZSBzaG93Q3dkID0gZmFsc2U7XG5cdHByaXZhdGUgc29ydE1vZGU6IFNvcnRNb2RlID0gXCJ0aHJlYWRlZFwiO1xuXHRwcml2YXRlIG5hbWVGaWx0ZXI6IE5hbWVGaWx0ZXIgPSBcImFsbFwiO1xuXHRwcml2YXRlIGtleWJpbmRpbmdzOiBLZXliaW5kaW5nc01hbmFnZXI7XG5cdHByaXZhdGUgc2hvd1BhdGggPSBmYWxzZTtcblx0cHJpdmF0ZSBjb25maXJtaW5nRGVsZXRlUGF0aDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cdHByaXZhdGUgY3VycmVudFNlc3Npb25GaWxlUGF0aD86IHN0cmluZztcblx0cHVibGljIG9uU2VsZWN0PzogKHNlc3Npb25QYXRoOiBzdHJpbmcpID0+IHZvaWQ7XG5cdHB1YmxpYyBvbkNhbmNlbD86ICgpID0+IHZvaWQ7XG5cdHB1YmxpYyBvbkV4aXQ6ICgpID0+IHZvaWQgPSAoKSA9PiB7fTtcblx0cHVibGljIG9uVG9nZ2xlU2NvcGU/OiAoKSA9PiB2b2lkO1xuXHRwdWJsaWMgb25Ub2dnbGVTb3J0PzogKCkgPT4gdm9pZDtcblx0cHVibGljIG9uVG9nZ2xlTmFtZUZpbHRlcj86ICgpID0+IHZvaWQ7XG5cdHB1YmxpYyBvblRvZ2dsZVBhdGg/OiAoc2hvd1BhdGg6IGJvb2xlYW4pID0+IHZvaWQ7XG5cdHB1YmxpYyBvbkRlbGV0ZUNvbmZpcm1hdGlvbkNoYW5nZT86IChwYXRoOiBzdHJpbmcgfCBudWxsKSA9PiB2b2lkO1xuXHRwdWJsaWMgb25EZWxldGVTZXNzaW9uPzogKHNlc3Npb25QYXRoOiBzdHJpbmcpID0+IFByb21pc2U8dm9pZD47XG5cdHB1YmxpYyBvblJlbmFtZVNlc3Npb24/OiAoc2Vzc2lvblBhdGg6IHN0cmluZykgPT4gdm9pZDtcblx0cHVibGljIG9uRXJyb3I/OiAobWVzc2FnZTogc3RyaW5nKSA9PiB2b2lkO1xuXHRwcml2YXRlIG1heFZpc2libGU6IG51bWJlciA9IDEwOyAvLyBNYXggc2Vzc2lvbnMgdmlzaWJsZSAob25lIGxpbmUgZWFjaClcblxuXHQvLyBGb2N1c2FibGUgaW1wbGVtZW50YXRpb24gLSBwcm9wYWdhdGUgdG8gc2VhcmNoSW5wdXQgZm9yIElNRSBjdXJzb3IgcG9zaXRpb25pbmdcblx0cHJpdmF0ZSBfZm9jdXNlZCA9IGZhbHNlO1xuXHRnZXQgZm9jdXNlZCgpOiBib29sZWFuIHtcblx0XHRyZXR1cm4gdGhpcy5fZm9jdXNlZDtcblx0fVxuXHRzZXQgZm9jdXNlZCh2YWx1ZTogYm9vbGVhbikge1xuXHRcdHRoaXMuX2ZvY3VzZWQgPSB2YWx1ZTtcblx0XHR0aGlzLnNlYXJjaElucHV0LmZvY3VzZWQgPSB2YWx1ZTtcblx0fVxuXG5cdGNvbnN0cnVjdG9yKFxuXHRcdHNlc3Npb25zOiBTZXNzaW9uSW5mb1tdLFxuXHRcdHNob3dDd2Q6IGJvb2xlYW4sXG5cdFx0c29ydE1vZGU6IFNvcnRNb2RlLFxuXHRcdG5hbWVGaWx0ZXI6IE5hbWVGaWx0ZXIsXG5cdFx0a2V5YmluZGluZ3M6IEtleWJpbmRpbmdzTWFuYWdlcixcblx0XHRjdXJyZW50U2Vzc2lvbkZpbGVQYXRoPzogc3RyaW5nLFxuXHQpIHtcblx0XHR0aGlzLmFsbFNlc3Npb25zID0gc2Vzc2lvbnM7XG5cdFx0dGhpcy5maWx0ZXJlZFNlc3Npb25zID0gW107XG5cdFx0dGhpcy5zZWFyY2hJbnB1dCA9IG5ldyBJbnB1dCgpO1xuXHRcdHRoaXMuc2hvd0N3ZCA9IHNob3dDd2Q7XG5cdFx0dGhpcy5zb3J0TW9kZSA9IHNvcnRNb2RlO1xuXHRcdHRoaXMubmFtZUZpbHRlciA9IG5hbWVGaWx0ZXI7XG5cdFx0dGhpcy5rZXliaW5kaW5ncyA9IGtleWJpbmRpbmdzO1xuXHRcdHRoaXMuY3VycmVudFNlc3Npb25GaWxlUGF0aCA9IGN1cnJlbnRTZXNzaW9uRmlsZVBhdGg7XG5cdFx0dGhpcy5maWx0ZXJTZXNzaW9ucyhcIlwiKTtcblxuXHRcdC8vIEhhbmRsZSBFbnRlciBpbiBzZWFyY2ggaW5wdXQgLSBzZWxlY3QgY3VycmVudCBpdGVtXG5cdFx0dGhpcy5zZWFyY2hJbnB1dC5vblN1Ym1pdCA9ICgpID0+IHtcblx0XHRcdGlmICh0aGlzLmZpbHRlcmVkU2Vzc2lvbnNbdGhpcy5zZWxlY3RlZEluZGV4XSkge1xuXHRcdFx0XHRjb25zdCBzZWxlY3RlZCA9IHRoaXMuZmlsdGVyZWRTZXNzaW9uc1t0aGlzLnNlbGVjdGVkSW5kZXhdO1xuXHRcdFx0XHRpZiAodGhpcy5vblNlbGVjdCkge1xuXHRcdFx0XHRcdHRoaXMub25TZWxlY3Qoc2VsZWN0ZWQuc2Vzc2lvbi5wYXRoKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH07XG5cdH1cblxuXHRzZXRTb3J0TW9kZShzb3J0TW9kZTogU29ydE1vZGUpOiB2b2lkIHtcblx0XHR0aGlzLnNvcnRNb2RlID0gc29ydE1vZGU7XG5cdFx0dGhpcy5maWx0ZXJTZXNzaW9ucyh0aGlzLnNlYXJjaElucHV0LmdldFZhbHVlKCkpO1xuXHR9XG5cblx0c2V0TmFtZUZpbHRlcihuYW1lRmlsdGVyOiBOYW1lRmlsdGVyKTogdm9pZCB7XG5cdFx0dGhpcy5uYW1lRmlsdGVyID0gbmFtZUZpbHRlcjtcblx0XHR0aGlzLmZpbHRlclNlc3Npb25zKHRoaXMuc2VhcmNoSW5wdXQuZ2V0VmFsdWUoKSk7XG5cdH1cblxuXHRzZXRTZXNzaW9ucyhzZXNzaW9uczogU2Vzc2lvbkluZm9bXSwgc2hvd0N3ZDogYm9vbGVhbik6IHZvaWQge1xuXHRcdHRoaXMuYWxsU2Vzc2lvbnMgPSBzZXNzaW9ucztcblx0XHR0aGlzLnNob3dDd2QgPSBzaG93Q3dkO1xuXHRcdHRoaXMuZmlsdGVyU2Vzc2lvbnModGhpcy5zZWFyY2hJbnB1dC5nZXRWYWx1ZSgpKTtcblx0fVxuXG5cdHByaXZhdGUgZmlsdGVyU2Vzc2lvbnMocXVlcnk6IHN0cmluZyk6IHZvaWQge1xuXHRcdGNvbnN0IHRyaW1tZWQgPSBxdWVyeS50cmltKCk7XG5cdFx0Y29uc3QgbmFtZUZpbHRlcmVkID1cblx0XHRcdHRoaXMubmFtZUZpbHRlciA9PT0gXCJhbGxcIiA/IHRoaXMuYWxsU2Vzc2lvbnMgOiB0aGlzLmFsbFNlc3Npb25zLmZpbHRlcigoc2Vzc2lvbikgPT4gaGFzU2Vzc2lvbk5hbWUoc2Vzc2lvbikpO1xuXG5cdFx0aWYgKHRoaXMuc29ydE1vZGUgPT09IFwidGhyZWFkZWRcIiAmJiAhdHJpbW1lZCkge1xuXHRcdFx0Ly8gVGhyZWFkZWQgbW9kZSB3aXRob3V0IHNlYXJjaDogc2hvdyB0cmVlIHN0cnVjdHVyZVxuXHRcdFx0Y29uc3Qgcm9vdHMgPSBidWlsZFNlc3Npb25UcmVlKG5hbWVGaWx0ZXJlZCk7XG5cdFx0XHR0aGlzLmZpbHRlcmVkU2Vzc2lvbnMgPSBmbGF0dGVuU2Vzc2lvblRyZWUocm9vdHMpO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHQvLyBPdGhlciBtb2RlcyBvciB3aXRoIHNlYXJjaDogZmxhdCBsaXN0XG5cdFx0XHRjb25zdCBmaWx0ZXJlZCA9IGZpbHRlckFuZFNvcnRTZXNzaW9ucyhuYW1lRmlsdGVyZWQsIHF1ZXJ5LCB0aGlzLnNvcnRNb2RlLCBcImFsbFwiKTtcblx0XHRcdHRoaXMuZmlsdGVyZWRTZXNzaW9ucyA9IGZpbHRlcmVkLm1hcCgoc2Vzc2lvbikgPT4gKHtcblx0XHRcdFx0c2Vzc2lvbixcblx0XHRcdFx0ZGVwdGg6IDAsXG5cdFx0XHRcdGlzTGFzdDogdHJ1ZSxcblx0XHRcdFx0YW5jZXN0b3JDb250aW51ZXM6IFtdLFxuXHRcdFx0fSkpO1xuXHRcdH1cblx0XHR0aGlzLnNlbGVjdGVkSW5kZXggPSBNYXRoLm1pbih0aGlzLnNlbGVjdGVkSW5kZXgsIE1hdGgubWF4KDAsIHRoaXMuZmlsdGVyZWRTZXNzaW9ucy5sZW5ndGggLSAxKSk7XG5cdH1cblxuXHRwcml2YXRlIHNldENvbmZpcm1pbmdEZWxldGVQYXRoKHBhdGg6IHN0cmluZyB8IG51bGwpOiB2b2lkIHtcblx0XHR0aGlzLmNvbmZpcm1pbmdEZWxldGVQYXRoID0gcGF0aDtcblx0XHR0aGlzLm9uRGVsZXRlQ29uZmlybWF0aW9uQ2hhbmdlPy4ocGF0aCk7XG5cdH1cblxuXHRwcml2YXRlIHN0YXJ0RGVsZXRlQ29uZmlybWF0aW9uRm9yU2VsZWN0ZWRTZXNzaW9uKCk6IHZvaWQge1xuXHRcdGNvbnN0IHNlbGVjdGVkID0gdGhpcy5maWx0ZXJlZFNlc3Npb25zW3RoaXMuc2VsZWN0ZWRJbmRleF07XG5cdFx0aWYgKCFzZWxlY3RlZCkgcmV0dXJuO1xuXG5cdFx0Ly8gUHJldmVudCBkZWxldGluZyBjdXJyZW50IHNlc3Npb25cblx0XHRpZiAodGhpcy5jdXJyZW50U2Vzc2lvbkZpbGVQYXRoICYmIHNlbGVjdGVkLnNlc3Npb24ucGF0aCA9PT0gdGhpcy5jdXJyZW50U2Vzc2lvbkZpbGVQYXRoKSB7XG5cdFx0XHR0aGlzLm9uRXJyb3I/LihcIkNhbm5vdCBkZWxldGUgdGhlIGN1cnJlbnRseSBhY3RpdmUgc2Vzc2lvblwiKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHR0aGlzLnNldENvbmZpcm1pbmdEZWxldGVQYXRoKHNlbGVjdGVkLnNlc3Npb24ucGF0aCk7XG5cdH1cblxuXHRpbnZhbGlkYXRlKCk6IHZvaWQge31cblxuXHRyZW5kZXIod2lkdGg6IG51bWJlcik6IHN0cmluZ1tdIHtcblx0XHRjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcblxuXHRcdC8vIFJlbmRlciBzZWFyY2ggaW5wdXRcblx0XHRsaW5lcy5wdXNoKC4uLnRoaXMuc2VhcmNoSW5wdXQucmVuZGVyKHdpZHRoKSk7XG5cdFx0bGluZXMucHVzaChcIlwiKTsgLy8gQmxhbmsgbGluZSBhZnRlciBzZWFyY2hcblxuXHRcdGlmICh0aGlzLmZpbHRlcmVkU2Vzc2lvbnMubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRsZXQgZW1wdHlNZXNzYWdlOiBzdHJpbmc7XG5cdFx0XHRpZiAodGhpcy5uYW1lRmlsdGVyID09PSBcIm5hbWVkXCIpIHtcblx0XHRcdFx0Y29uc3QgdG9nZ2xlS2V5ID0gYXBwS2V5KHRoaXMua2V5YmluZGluZ3MsIFwidG9nZ2xlU2Vzc2lvbk5hbWVkRmlsdGVyXCIpO1xuXHRcdFx0XHRpZiAodGhpcy5zaG93Q3dkKSB7XG5cdFx0XHRcdFx0ZW1wdHlNZXNzYWdlID0gYCAgTm8gbmFtZWQgc2Vzc2lvbnMgZm91bmQuIFByZXNzICR7dG9nZ2xlS2V5fSB0byBzaG93IGFsbC5gO1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdGVtcHR5TWVzc2FnZSA9IGAgIE5vIG5hbWVkIHNlc3Npb25zIGluIGN1cnJlbnQgZm9sZGVyLiBQcmVzcyAke3RvZ2dsZUtleX0gdG8gc2hvdyBhbGwsIG9yIFRhYiB0byB2aWV3IGFsbC5gO1xuXHRcdFx0XHR9XG5cdFx0XHR9IGVsc2UgaWYgKHRoaXMuc2hvd0N3ZCkge1xuXHRcdFx0XHQvLyBcIkFsbFwiIHNjb3BlIC0gbm8gc2Vzc2lvbnMgYW55d2hlcmUgdGhhdCBtYXRjaCBmaWx0ZXJcblx0XHRcdFx0ZW1wdHlNZXNzYWdlID0gXCIgIE5vIHNlc3Npb25zIGZvdW5kXCI7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHQvLyBcIkN1cnJlbnQgZm9sZGVyXCIgc2NvcGUgLSBoaW50IHRvIHRyeSBcImFsbFwiXG5cdFx0XHRcdGVtcHR5TWVzc2FnZSA9IFwiICBObyBzZXNzaW9ucyBpbiBjdXJyZW50IGZvbGRlci4gUHJlc3MgVGFiIHRvIHZpZXcgYWxsLlwiO1xuXHRcdFx0fVxuXHRcdFx0bGluZXMucHVzaCh0aGVtZS5mZyhcIm11dGVkXCIsIHRydW5jYXRlVG9XaWR0aChlbXB0eU1lc3NhZ2UsIHdpZHRoLCBcIlx1MjAyNlwiKSkpO1xuXHRcdFx0cmV0dXJuIGxpbmVzO1xuXHRcdH1cblxuXHRcdC8vIENhbGN1bGF0ZSB2aXNpYmxlIHJhbmdlIHdpdGggc2Nyb2xsaW5nXG5cdFx0Y29uc3QgeyBzdGFydEluZGV4LCBlbmRJbmRleCB9ID0gY29tcHV0ZVNjcm9sbFdpbmRvdyhcblx0XHRcdHRoaXMuc2VsZWN0ZWRJbmRleCxcblx0XHRcdHRoaXMuZmlsdGVyZWRTZXNzaW9ucy5sZW5ndGgsXG5cdFx0XHR0aGlzLm1heFZpc2libGUsXG5cdFx0KTtcblxuXHRcdC8vIFJlbmRlciB2aXNpYmxlIHNlc3Npb25zIChvbmUgbGluZSBlYWNoIHdpdGggdHJlZSBzdHJ1Y3R1cmUpXG5cdFx0Zm9yIChsZXQgaSA9IHN0YXJ0SW5kZXg7IGkgPCBlbmRJbmRleDsgaSsrKSB7XG5cdFx0XHRjb25zdCBub2RlID0gdGhpcy5maWx0ZXJlZFNlc3Npb25zW2ldITtcblx0XHRcdGNvbnN0IHNlc3Npb24gPSBub2RlLnNlc3Npb247XG5cdFx0XHRjb25zdCBpc1NlbGVjdGVkID0gaSA9PT0gdGhpcy5zZWxlY3RlZEluZGV4O1xuXHRcdFx0Y29uc3QgaXNDb25maXJtaW5nRGVsZXRlID0gc2Vzc2lvbi5wYXRoID09PSB0aGlzLmNvbmZpcm1pbmdEZWxldGVQYXRoO1xuXHRcdFx0Y29uc3QgaXNDdXJyZW50ID0gdGhpcy5jdXJyZW50U2Vzc2lvbkZpbGVQYXRoID09PSBzZXNzaW9uLnBhdGg7XG5cblx0XHRcdC8vIEJ1aWxkIHRyZWUgcHJlZml4XG5cdFx0XHRjb25zdCBwcmVmaXggPSB0aGlzLmJ1aWxkTm9kZVRyZWVQcmVmaXgobm9kZSk7XG5cblx0XHRcdC8vIFNlc3Npb24gZGlzcGxheSB0ZXh0IChuYW1lIG9yIGZpcnN0IG1lc3NhZ2UpXG5cdFx0XHRjb25zdCBoYXNOYW1lID0gISFzZXNzaW9uLm5hbWU7XG5cdFx0XHRjb25zdCBkaXNwbGF5VGV4dCA9IHNlc3Npb24ubmFtZSA/PyBzZXNzaW9uLmZpcnN0TWVzc2FnZTtcblx0XHRcdGNvbnN0IG5vcm1hbGl6ZWRNZXNzYWdlID0gZGlzcGxheVRleHQucmVwbGFjZSgvW1xceDAwLVxceDFmXFx4N2ZdL2csIFwiIFwiKS50cmltKCk7XG5cblx0XHRcdC8vIFJpZ2h0IHNpZGU6IG1lc3NhZ2UgY291bnQgYW5kIGFnZVxuXHRcdFx0Y29uc3QgYWdlID0gZm9ybWF0U2Vzc2lvbkRhdGUoc2Vzc2lvbi5tb2RpZmllZCk7XG5cdFx0XHRjb25zdCBtc2dDb3VudCA9IFN0cmluZyhzZXNzaW9uLm1lc3NhZ2VDb3VudCk7XG5cdFx0XHRsZXQgcmlnaHRQYXJ0ID0gYCR7bXNnQ291bnR9ICR7YWdlfWA7XG5cdFx0XHRpZiAodGhpcy5zaG93Q3dkICYmIHNlc3Npb24uY3dkKSB7XG5cdFx0XHRcdHJpZ2h0UGFydCA9IGAke3Nob3J0ZW5QYXRoKHNlc3Npb24uY3dkKX0gJHtyaWdodFBhcnR9YDtcblx0XHRcdH1cblx0XHRcdGlmICh0aGlzLnNob3dQYXRoKSB7XG5cdFx0XHRcdHJpZ2h0UGFydCA9IGAke3Nob3J0ZW5QYXRoKHNlc3Npb24ucGF0aCl9ICR7cmlnaHRQYXJ0fWA7XG5cdFx0XHR9XG5cblx0XHRcdC8vIEN1cnNvclxuXHRcdFx0Y29uc3QgY3Vyc29yID0gcmVuZGVyQ3Vyc29yKGlzU2VsZWN0ZWQpO1xuXG5cdFx0XHQvLyBDYWxjdWxhdGUgYXZhaWxhYmxlIHdpZHRoIGZvciBtZXNzYWdlXG5cdFx0XHRjb25zdCBwcmVmaXhXaWR0aCA9IHZpc2libGVXaWR0aChwcmVmaXgpO1xuXHRcdFx0Y29uc3QgcmlnaHRXaWR0aCA9IHZpc2libGVXaWR0aChyaWdodFBhcnQpICsgMjsgLy8gKzIgZm9yIHNwYWNpbmdcblx0XHRcdGNvbnN0IGF2YWlsYWJsZUZvck1zZyA9IHdpZHRoIC0gMiAtIHByZWZpeFdpZHRoIC0gcmlnaHRXaWR0aDsgLy8gLTIgZm9yIGN1cnNvclxuXG5cdFx0XHRjb25zdCB0cnVuY2F0ZWRNc2cgPSB0cnVuY2F0ZVRvV2lkdGgobm9ybWFsaXplZE1lc3NhZ2UsIE1hdGgubWF4KDEwLCBhdmFpbGFibGVGb3JNc2cpLCBcIlx1MjAyNlwiKTtcblxuXHRcdFx0Ly8gU3R5bGUgbWVzc2FnZVxuXHRcdFx0bGV0IG1lc3NhZ2VDb2xvcjogXCJlcnJvclwiIHwgXCJ3YXJuaW5nXCIgfCBcImFjY2VudFwiIHwgbnVsbCA9IG51bGw7XG5cdFx0XHRpZiAoaXNDb25maXJtaW5nRGVsZXRlKSB7XG5cdFx0XHRcdG1lc3NhZ2VDb2xvciA9IFwiZXJyb3JcIjtcblx0XHRcdH0gZWxzZSBpZiAoaXNDdXJyZW50KSB7XG5cdFx0XHRcdG1lc3NhZ2VDb2xvciA9IFwiYWNjZW50XCI7XG5cdFx0XHR9IGVsc2UgaWYgKGhhc05hbWUpIHtcblx0XHRcdFx0bWVzc2FnZUNvbG9yID0gXCJ3YXJuaW5nXCI7XG5cdFx0XHR9XG5cdFx0XHRsZXQgc3R5bGVkTXNnID0gbWVzc2FnZUNvbG9yID8gdGhlbWUuZmcobWVzc2FnZUNvbG9yLCB0cnVuY2F0ZWRNc2cpIDogdHJ1bmNhdGVkTXNnO1xuXHRcdFx0aWYgKGlzU2VsZWN0ZWQpIHtcblx0XHRcdFx0c3R5bGVkTXNnID0gdGhlbWUuYm9sZChzdHlsZWRNc2cpO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBCdWlsZCBsaW5lXG5cdFx0XHRjb25zdCBsZWZ0UGFydCA9IGN1cnNvciArIHRoZW1lLmZnKFwiZGltXCIsIHByZWZpeCkgKyBzdHlsZWRNc2c7XG5cdFx0XHRjb25zdCBsZWZ0V2lkdGggPSB2aXNpYmxlV2lkdGgobGVmdFBhcnQpO1xuXHRcdFx0Y29uc3Qgc3BhY2luZyA9IE1hdGgubWF4KDEsIHdpZHRoIC0gbGVmdFdpZHRoIC0gdmlzaWJsZVdpZHRoKHJpZ2h0UGFydCkpO1xuXHRcdFx0Y29uc3Qgc3R5bGVkUmlnaHQgPSB0aGVtZS5mZyhpc0NvbmZpcm1pbmdEZWxldGUgPyBcImVycm9yXCIgOiBcImRpbVwiLCByaWdodFBhcnQpO1xuXG5cdFx0XHRjb25zdCBsaW5lID0gbGVmdFBhcnQgKyBcIiBcIi5yZXBlYXQoc3BhY2luZykgKyBzdHlsZWRSaWdodDtcblx0XHRcdGxpbmVzLnB1c2goYXBwbHlSb3dIaWdobGlnaHQobGluZSwgaXNTZWxlY3RlZCwgd2lkdGgpKTtcblx0XHR9XG5cblx0XHQvLyBBZGQgc2Nyb2xsIGluZGljYXRvciBpZiBuZWVkZWRcblx0XHRpZiAoc3RhcnRJbmRleCA+IDAgfHwgZW5kSW5kZXggPCB0aGlzLmZpbHRlcmVkU2Vzc2lvbnMubGVuZ3RoKSB7XG5cdFx0XHRjb25zdCBzY3JvbGxUZXh0ID0gYCAgKCR7dGhpcy5zZWxlY3RlZEluZGV4ICsgMX0vJHt0aGlzLmZpbHRlcmVkU2Vzc2lvbnMubGVuZ3RofSlgO1xuXHRcdFx0Y29uc3Qgc2Nyb2xsSW5mbyA9IHRoZW1lLmZnKFwibXV0ZWRcIiwgdHJ1bmNhdGVUb1dpZHRoKHNjcm9sbFRleHQsIHdpZHRoLCBcIlwiKSk7XG5cdFx0XHRsaW5lcy5wdXNoKHNjcm9sbEluZm8pO1xuXHRcdH1cblxuXHRcdHJldHVybiBsaW5lcztcblx0fVxuXG5cdHByaXZhdGUgYnVpbGROb2RlVHJlZVByZWZpeChub2RlOiBGbGF0U2Vzc2lvbk5vZGUpOiBzdHJpbmcge1xuXHRcdHJldHVybiBidWlsZFRyZWVQcmVmaXgobm9kZS5hbmNlc3RvckNvbnRpbnVlcywgbm9kZS5pc0xhc3QsIG5vZGUuZGVwdGgpO1xuXHR9XG5cblx0aGFuZGxlSW5wdXQoa2V5RGF0YTogc3RyaW5nKTogdm9pZCB7XG5cdFx0Y29uc3Qga2IgPSBnZXRFZGl0b3JLZXliaW5kaW5ncygpO1xuXG5cdFx0Ly8gSGFuZGxlIGRlbGV0ZSBjb25maXJtYXRpb24gc3RhdGUgZmlyc3QgLSBpbnRlcmNlcHQgYWxsIGtleXNcblx0XHRpZiAodGhpcy5jb25maXJtaW5nRGVsZXRlUGF0aCAhPT0gbnVsbCkge1xuXHRcdFx0aWYgKGtiLm1hdGNoZXMoa2V5RGF0YSwgXCJzZWxlY3RDb25maXJtXCIpKSB7XG5cdFx0XHRcdGNvbnN0IHBhdGhUb0RlbGV0ZSA9IHRoaXMuY29uZmlybWluZ0RlbGV0ZVBhdGg7XG5cdFx0XHRcdHRoaXMuc2V0Q29uZmlybWluZ0RlbGV0ZVBhdGgobnVsbCk7XG5cdFx0XHRcdHZvaWQgdGhpcy5vbkRlbGV0ZVNlc3Npb24/LihwYXRoVG9EZWxldGUpO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cdFx0XHQvLyBBbGxvdyBib3RoIEVzY2FwZSBhbmQgQ3RybCtDIHRvIGNhbmNlbCAoY29uc2lzdGVudCB3aXRoIHBpIFVYKVxuXHRcdFx0aWYgKGtiLm1hdGNoZXMoa2V5RGF0YSwgXCJzZWxlY3RDYW5jZWxcIikgfHwgbWF0Y2hlc0tleShrZXlEYXRhLCBcImN0cmwrY1wiKSkge1xuXHRcdFx0XHR0aGlzLnNldENvbmZpcm1pbmdEZWxldGVQYXRoKG51bGwpO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cdFx0XHQvLyBJZ25vcmUgYWxsIG90aGVyIGtleXMgd2hpbGUgY29uZmlybWluZ1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGlmIChrYi5tYXRjaGVzKGtleURhdGEsIFwidGFiXCIpKSB7XG5cdFx0XHRpZiAodGhpcy5vblRvZ2dsZVNjb3BlKSB7XG5cdFx0XHRcdHRoaXMub25Ub2dnbGVTY29wZSgpO1xuXHRcdFx0fVxuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGlmIChrYi5tYXRjaGVzKGtleURhdGEsIFwidG9nZ2xlU2Vzc2lvblNvcnRcIikpIHtcblx0XHRcdHRoaXMub25Ub2dnbGVTb3J0Py4oKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRpZiAodGhpcy5rZXliaW5kaW5ncy5tYXRjaGVzKGtleURhdGEsIFwidG9nZ2xlU2Vzc2lvbk5hbWVkRmlsdGVyXCIpKSB7XG5cdFx0XHR0aGlzLm9uVG9nZ2xlTmFtZUZpbHRlcj8uKCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Ly8gQ3RybCtQOiB0b2dnbGUgcGF0aCBkaXNwbGF5XG5cdFx0aWYgKGtiLm1hdGNoZXMoa2V5RGF0YSwgXCJ0b2dnbGVTZXNzaW9uUGF0aFwiKSkge1xuXHRcdFx0dGhpcy5zaG93UGF0aCA9ICF0aGlzLnNob3dQYXRoO1xuXHRcdFx0dGhpcy5vblRvZ2dsZVBhdGg/Lih0aGlzLnNob3dQYXRoKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHQvLyBDdHJsK0Q6IGluaXRpYXRlIGRlbGV0ZSBjb25maXJtYXRpb24gKHVzZWZ1bCBvbiB0ZXJtaW5hbHMgdGhhdCBkb24ndCBkaXN0aW5ndWlzaCBDdHJsK0JhY2tzcGFjZSBmcm9tIEJhY2tzcGFjZSlcblx0XHRpZiAoa2IubWF0Y2hlcyhrZXlEYXRhLCBcImRlbGV0ZVNlc3Npb25cIikpIHtcblx0XHRcdHRoaXMuc3RhcnREZWxldGVDb25maXJtYXRpb25Gb3JTZWxlY3RlZFNlc3Npb24oKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHQvLyBDdHJsK1I6IHJlbmFtZSBzZWxlY3RlZCBzZXNzaW9uXG5cdFx0aWYgKG1hdGNoZXNLZXkoa2V5RGF0YSwgXCJjdHJsK3JcIikpIHtcblx0XHRcdGNvbnN0IHNlbGVjdGVkID0gdGhpcy5maWx0ZXJlZFNlc3Npb25zW3RoaXMuc2VsZWN0ZWRJbmRleF07XG5cdFx0XHRpZiAoc2VsZWN0ZWQpIHtcblx0XHRcdFx0dGhpcy5vblJlbmFtZVNlc3Npb24/LihzZWxlY3RlZC5zZXNzaW9uLnBhdGgpO1xuXHRcdFx0fVxuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdC8vIEN0cmwrQmFja3NwYWNlOiBub24taW52YXNpdmUgY29udmVuaWVuY2UgYWxpYXMgZm9yIGRlbGV0ZVxuXHRcdC8vIE9ubHkgdHJpZ2dlcnMgZGVsZXRpb24gd2hlbiB0aGUgcXVlcnkgaXMgZW1wdHk7IG90aGVyd2lzZSBpdCBpcyBmb3J3YXJkZWQgdG8gdGhlIGlucHV0XG5cdFx0aWYgKGtiLm1hdGNoZXMoa2V5RGF0YSwgXCJkZWxldGVTZXNzaW9uTm9uaW52YXNpdmVcIikpIHtcblx0XHRcdGlmICh0aGlzLnNlYXJjaElucHV0LmdldFZhbHVlKCkubGVuZ3RoID4gMCkge1xuXHRcdFx0XHR0aGlzLnNlYXJjaElucHV0LmhhbmRsZUlucHV0KGtleURhdGEpO1xuXHRcdFx0XHR0aGlzLmZpbHRlclNlc3Npb25zKHRoaXMuc2VhcmNoSW5wdXQuZ2V0VmFsdWUoKSk7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblxuXHRcdFx0dGhpcy5zdGFydERlbGV0ZUNvbmZpcm1hdGlvbkZvclNlbGVjdGVkU2Vzc2lvbigpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdC8vIFVwIGFycm93ICh3cmFwKVxuXHRcdGlmIChrYi5tYXRjaGVzKGtleURhdGEsIFwic2VsZWN0VXBcIikpIHtcblx0XHRcdHRoaXMuc2VsZWN0ZWRJbmRleCA9IHRoaXMuc2VsZWN0ZWRJbmRleCA9PT0gMCA/IHRoaXMuZmlsdGVyZWRTZXNzaW9ucy5sZW5ndGggLSAxIDogdGhpcy5zZWxlY3RlZEluZGV4IC0gMTtcblx0XHR9XG5cdFx0Ly8gRG93biBhcnJvdyAod3JhcClcblx0XHRlbHNlIGlmIChrYi5tYXRjaGVzKGtleURhdGEsIFwic2VsZWN0RG93blwiKSkge1xuXHRcdFx0dGhpcy5zZWxlY3RlZEluZGV4ID0gdGhpcy5zZWxlY3RlZEluZGV4ID09PSB0aGlzLmZpbHRlcmVkU2Vzc2lvbnMubGVuZ3RoIC0gMSA/IDAgOiB0aGlzLnNlbGVjdGVkSW5kZXggKyAxO1xuXHRcdH1cblx0XHQvLyBQYWdlIHVwIC0ganVtcCB1cCBieSBtYXhWaXNpYmxlIGl0ZW1zXG5cdFx0ZWxzZSBpZiAoa2IubWF0Y2hlcyhrZXlEYXRhLCBcInNlbGVjdFBhZ2VVcFwiKSkge1xuXHRcdFx0dGhpcy5zZWxlY3RlZEluZGV4ID0gTWF0aC5tYXgoMCwgdGhpcy5zZWxlY3RlZEluZGV4IC0gdGhpcy5tYXhWaXNpYmxlKTtcblx0XHR9XG5cdFx0Ly8gUGFnZSBkb3duIC0ganVtcCBkb3duIGJ5IG1heFZpc2libGUgaXRlbXNcblx0XHRlbHNlIGlmIChrYi5tYXRjaGVzKGtleURhdGEsIFwic2VsZWN0UGFnZURvd25cIikpIHtcblx0XHRcdHRoaXMuc2VsZWN0ZWRJbmRleCA9IE1hdGgubWluKHRoaXMuZmlsdGVyZWRTZXNzaW9ucy5sZW5ndGggLSAxLCB0aGlzLnNlbGVjdGVkSW5kZXggKyB0aGlzLm1heFZpc2libGUpO1xuXHRcdH1cblx0XHQvLyBFbnRlclxuXHRcdGVsc2UgaWYgKGtiLm1hdGNoZXMoa2V5RGF0YSwgXCJzZWxlY3RDb25maXJtXCIpKSB7XG5cdFx0XHRjb25zdCBzZWxlY3RlZCA9IHRoaXMuZmlsdGVyZWRTZXNzaW9uc1t0aGlzLnNlbGVjdGVkSW5kZXhdO1xuXHRcdFx0aWYgKHNlbGVjdGVkICYmIHRoaXMub25TZWxlY3QpIHtcblx0XHRcdFx0dGhpcy5vblNlbGVjdChzZWxlY3RlZC5zZXNzaW9uLnBhdGgpO1xuXHRcdFx0fVxuXHRcdH1cblx0XHQvLyBFc2NhcGUgLSBjYW5jZWxcblx0XHRlbHNlIGlmIChrYi5tYXRjaGVzKGtleURhdGEsIFwic2VsZWN0Q2FuY2VsXCIpKSB7XG5cdFx0XHRpZiAodGhpcy5vbkNhbmNlbCkge1xuXHRcdFx0XHR0aGlzLm9uQ2FuY2VsKCk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdC8vIFBhc3MgZXZlcnl0aGluZyBlbHNlIHRvIHNlYXJjaCBpbnB1dFxuXHRcdGVsc2Uge1xuXHRcdFx0dGhpcy5zZWFyY2hJbnB1dC5oYW5kbGVJbnB1dChrZXlEYXRhKTtcblx0XHRcdHRoaXMuZmlsdGVyU2Vzc2lvbnModGhpcy5zZWFyY2hJbnB1dC5nZXRWYWx1ZSgpKTtcblx0XHR9XG5cdH1cbn1cblxudHlwZSBTZXNzaW9uc0xvYWRlciA9IChvblByb2dyZXNzPzogU2Vzc2lvbkxpc3RQcm9ncmVzcykgPT4gUHJvbWlzZTxTZXNzaW9uSW5mb1tdPjtcblxuLyoqXG4gKiBEZWxldGUgYSBzZXNzaW9uIGZpbGUsIHRyeWluZyB0aGUgYHRyYXNoYCBDTEkgZmlyc3QsIHRoZW4gZmFsbGluZyBiYWNrIHRvIHVubGlua1xuICovXG5hc3luYyBmdW5jdGlvbiBkZWxldGVTZXNzaW9uRmlsZShcblx0c2Vzc2lvblBhdGg6IHN0cmluZyxcbik6IFByb21pc2U8eyBvazogYm9vbGVhbjsgbWV0aG9kOiBcInRyYXNoXCIgfCBcInVubGlua1wiOyBlcnJvcj86IHN0cmluZyB9PiB7XG5cdC8vIFRyeSBgdHJhc2hgIGZpcnN0IChpZiBpbnN0YWxsZWQpXG5cdGNvbnN0IHRyYXNoQXJncyA9IHNlc3Npb25QYXRoLnN0YXJ0c1dpdGgoXCItXCIpID8gW1wiLS1cIiwgc2Vzc2lvblBhdGhdIDogW3Nlc3Npb25QYXRoXTtcblx0Y29uc3QgdHJhc2hSZXN1bHQgPSBzcGF3blN5bmMoXCJ0cmFzaFwiLCB0cmFzaEFyZ3MsIHsgZW5jb2Rpbmc6IFwidXRmLThcIiB9KTtcblxuXHRjb25zdCBnZXRUcmFzaEVycm9ySGludCA9ICgpOiBzdHJpbmcgfCBudWxsID0+IHtcblx0XHRjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcblx0XHRpZiAodHJhc2hSZXN1bHQuZXJyb3IpIHtcblx0XHRcdHBhcnRzLnB1c2godHJhc2hSZXN1bHQuZXJyb3IubWVzc2FnZSk7XG5cdFx0fVxuXHRcdGNvbnN0IHN0ZGVyciA9IHRyYXNoUmVzdWx0LnN0ZGVycj8udHJpbSgpO1xuXHRcdGlmIChzdGRlcnIpIHtcblx0XHRcdHBhcnRzLnB1c2goc3RkZXJyLnNwbGl0KFwiXFxuXCIpWzBdID8/IHN0ZGVycik7XG5cdFx0fVxuXHRcdGlmIChwYXJ0cy5sZW5ndGggPT09IDApIHJldHVybiBudWxsO1xuXHRcdHJldHVybiBgdHJhc2g6ICR7cGFydHMuam9pbihcIiBcdTAwQjcgXCIpLnNsaWNlKDAsIDIwMCl9YDtcblx0fTtcblxuXHQvLyBJZiB0cmFzaCByZXBvcnRzIHN1Y2Nlc3MsIG9yIHRoZSBmaWxlIGlzIGdvbmUgYWZ0ZXJ3YXJkcywgdHJlYXQgaXQgYXMgc3VjY2Vzc2Z1bFxuXHRpZiAodHJhc2hSZXN1bHQuc3RhdHVzID09PSAwIHx8ICFleGlzdHNTeW5jKHNlc3Npb25QYXRoKSkge1xuXHRcdHJldHVybiB7IG9rOiB0cnVlLCBtZXRob2Q6IFwidHJhc2hcIiB9O1xuXHR9XG5cblx0Ly8gRmFsbGJhY2sgdG8gcGVybWFuZW50IGRlbGV0aW9uXG5cdHRyeSB7XG5cdFx0YXdhaXQgdW5saW5rKHNlc3Npb25QYXRoKTtcblx0XHRyZXR1cm4geyBvazogdHJ1ZSwgbWV0aG9kOiBcInVubGlua1wiIH07XG5cdH0gY2F0Y2ggKGVycikge1xuXHRcdGNvbnN0IHVubGlua0Vycm9yID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuXHRcdGNvbnN0IHRyYXNoRXJyb3JIaW50ID0gZ2V0VHJhc2hFcnJvckhpbnQoKTtcblx0XHRjb25zdCBlcnJvciA9IHRyYXNoRXJyb3JIaW50ID8gYCR7dW5saW5rRXJyb3J9ICgke3RyYXNoRXJyb3JIaW50fSlgIDogdW5saW5rRXJyb3I7XG5cdFx0cmV0dXJuIHsgb2s6IGZhbHNlLCBtZXRob2Q6IFwidW5saW5rXCIsIGVycm9yIH07XG5cdH1cbn1cblxuLyoqXG4gKiBDb21wb25lbnQgdGhhdCByZW5kZXJzIGEgc2Vzc2lvbiBzZWxlY3RvclxuICovXG5leHBvcnQgY2xhc3MgU2Vzc2lvblNlbGVjdG9yQ29tcG9uZW50IGV4dGVuZHMgQ29udGFpbmVyIGltcGxlbWVudHMgRm9jdXNhYmxlIHtcblx0aGFuZGxlSW5wdXQoZGF0YTogc3RyaW5nKTogdm9pZCB7XG5cdFx0aWYgKHRoaXMubW9kZSA9PT0gXCJyZW5hbWVcIikge1xuXHRcdFx0Y29uc3Qga2IgPSBnZXRFZGl0b3JLZXliaW5kaW5ncygpO1xuXHRcdFx0aWYgKGtiLm1hdGNoZXMoZGF0YSwgXCJzZWxlY3RDYW5jZWxcIikgfHwgbWF0Y2hlc0tleShkYXRhLCBcImN0cmwrY1wiKSkge1xuXHRcdFx0XHR0aGlzLmV4aXRSZW5hbWVNb2RlKCk7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblx0XHRcdHRoaXMucmVuYW1lSW5wdXQuaGFuZGxlSW5wdXQoZGF0YSk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0dGhpcy5zZXNzaW9uTGlzdC5oYW5kbGVJbnB1dChkYXRhKTtcblx0fVxuXG5cdHByaXZhdGUgY2FuUmVuYW1lID0gdHJ1ZTtcblx0cHJpdmF0ZSBzZXNzaW9uTGlzdDogU2Vzc2lvbkxpc3Q7XG5cdHByaXZhdGUgaGVhZGVyOiBTZXNzaW9uU2VsZWN0b3JIZWFkZXI7XG5cdHByaXZhdGUga2V5YmluZGluZ3M6IEtleWJpbmRpbmdzTWFuYWdlcjtcblx0cHJpdmF0ZSBzY29wZTogU2Vzc2lvblNjb3BlID0gXCJjdXJyZW50XCI7XG5cdHByaXZhdGUgc29ydE1vZGU6IFNvcnRNb2RlID0gXCJ0aHJlYWRlZFwiO1xuXHRwcml2YXRlIG5hbWVGaWx0ZXI6IE5hbWVGaWx0ZXIgPSBcImFsbFwiO1xuXHRwcml2YXRlIGN1cnJlbnRTZXNzaW9uczogU2Vzc2lvbkluZm9bXSB8IG51bGwgPSBudWxsO1xuXHRwcml2YXRlIGFsbFNlc3Npb25zOiBTZXNzaW9uSW5mb1tdIHwgbnVsbCA9IG51bGw7XG5cdHByaXZhdGUgY3VycmVudFNlc3Npb25zTG9hZGVyOiBTZXNzaW9uc0xvYWRlcjtcblx0cHJpdmF0ZSBhbGxTZXNzaW9uc0xvYWRlcjogU2Vzc2lvbnNMb2FkZXI7XG5cdHByaXZhdGUgb25DYW5jZWw6ICgpID0+IHZvaWQ7XG5cdHByaXZhdGUgcmVxdWVzdFJlbmRlcjogKCkgPT4gdm9pZDtcblx0cHJpdmF0ZSByZW5hbWVTZXNzaW9uPzogKHNlc3Npb25QYXRoOiBzdHJpbmcsIGN1cnJlbnROYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQpID0+IFByb21pc2U8dm9pZD47XG5cdHByaXZhdGUgY3VycmVudExvYWRpbmcgPSBmYWxzZTtcblx0cHJpdmF0ZSBhbGxMb2FkaW5nID0gZmFsc2U7XG5cdHByaXZhdGUgYWxsTG9hZFNlcSA9IDA7XG5cblx0cHJpdmF0ZSBtb2RlOiBcImxpc3RcIiB8IFwicmVuYW1lXCIgPSBcImxpc3RcIjtcblx0cHJpdmF0ZSByZW5hbWVJbnB1dCA9IG5ldyBJbnB1dCgpO1xuXHRwcml2YXRlIHJlbmFtZVRhcmdldFBhdGg6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG5cdC8vIEZvY3VzYWJsZSBpbXBsZW1lbnRhdGlvbiAtIHByb3BhZ2F0ZSB0byBzZXNzaW9uTGlzdCBmb3IgSU1FIGN1cnNvciBwb3NpdGlvbmluZ1xuXHRwcml2YXRlIF9mb2N1c2VkID0gZmFsc2U7XG5cdGdldCBmb2N1c2VkKCk6IGJvb2xlYW4ge1xuXHRcdHJldHVybiB0aGlzLl9mb2N1c2VkO1xuXHR9XG5cdHNldCBmb2N1c2VkKHZhbHVlOiBib29sZWFuKSB7XG5cdFx0dGhpcy5fZm9jdXNlZCA9IHZhbHVlO1xuXHRcdHRoaXMuc2Vzc2lvbkxpc3QuZm9jdXNlZCA9IHZhbHVlO1xuXHRcdHRoaXMucmVuYW1lSW5wdXQuZm9jdXNlZCA9IHZhbHVlO1xuXHRcdGlmICh2YWx1ZSAmJiB0aGlzLm1vZGUgPT09IFwicmVuYW1lXCIpIHtcblx0XHRcdHRoaXMucmVuYW1lSW5wdXQuZm9jdXNlZCA9IHRydWU7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBidWlsZEJhc2VMYXlvdXQoY29udGVudDogQ29tcG9uZW50LCBvcHRpb25zPzogeyBzaG93SGVhZGVyPzogYm9vbGVhbiB9KTogdm9pZCB7XG5cdFx0dGhpcy5jbGVhcigpO1xuXHRcdHRoaXMuYWRkQ2hpbGQobmV3IFNwYWNlcigxKSk7XG5cdFx0dGhpcy5hZGRDaGlsZChuZXcgRHluYW1pY0JvcmRlcigocykgPT4gdGhlbWUuZmcoXCJhY2NlbnRcIiwgcykpKTtcblx0XHR0aGlzLmFkZENoaWxkKG5ldyBTcGFjZXIoMSkpO1xuXHRcdGlmIChvcHRpb25zPy5zaG93SGVhZGVyID8/IHRydWUpIHtcblx0XHRcdHRoaXMuYWRkQ2hpbGQodGhpcy5oZWFkZXIpO1xuXHRcdFx0dGhpcy5hZGRDaGlsZChuZXcgU3BhY2VyKDEpKTtcblx0XHR9XG5cdFx0dGhpcy5hZGRDaGlsZChjb250ZW50KTtcblx0XHR0aGlzLmFkZENoaWxkKG5ldyBTcGFjZXIoMSkpO1xuXHRcdHRoaXMuYWRkQ2hpbGQobmV3IER5bmFtaWNCb3JkZXIoKHMpID0+IHRoZW1lLmZnKFwiYWNjZW50XCIsIHMpKSk7XG5cdH1cblxuXHRjb25zdHJ1Y3Rvcihcblx0XHRjdXJyZW50U2Vzc2lvbnNMb2FkZXI6IFNlc3Npb25zTG9hZGVyLFxuXHRcdGFsbFNlc3Npb25zTG9hZGVyOiBTZXNzaW9uc0xvYWRlcixcblx0XHRvblNlbGVjdDogKHNlc3Npb25QYXRoOiBzdHJpbmcpID0+IHZvaWQsXG5cdFx0b25DYW5jZWw6ICgpID0+IHZvaWQsXG5cdFx0b25FeGl0OiAoKSA9PiB2b2lkLFxuXHRcdHJlcXVlc3RSZW5kZXI6ICgpID0+IHZvaWQsXG5cdFx0b3B0aW9ucz86IHtcblx0XHRcdHJlbmFtZVNlc3Npb24/OiAoc2Vzc2lvblBhdGg6IHN0cmluZywgY3VycmVudE5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCkgPT4gUHJvbWlzZTx2b2lkPjtcblx0XHRcdHNob3dSZW5hbWVIaW50PzogYm9vbGVhbjtcblx0XHRcdGtleWJpbmRpbmdzPzogS2V5YmluZGluZ3NNYW5hZ2VyO1xuXHRcdH0sXG5cdFx0Y3VycmVudFNlc3Npb25GaWxlUGF0aD86IHN0cmluZyxcblx0KSB7XG5cdFx0c3VwZXIoKTtcblx0XHR0aGlzLmtleWJpbmRpbmdzID0gb3B0aW9ucz8ua2V5YmluZGluZ3MgPz8gS2V5YmluZGluZ3NNYW5hZ2VyLmNyZWF0ZSgpO1xuXHRcdHRoaXMuY3VycmVudFNlc3Npb25zTG9hZGVyID0gY3VycmVudFNlc3Npb25zTG9hZGVyO1xuXHRcdHRoaXMuYWxsU2Vzc2lvbnNMb2FkZXIgPSBhbGxTZXNzaW9uc0xvYWRlcjtcblx0XHR0aGlzLm9uQ2FuY2VsID0gb25DYW5jZWw7XG5cdFx0dGhpcy5yZXF1ZXN0UmVuZGVyID0gcmVxdWVzdFJlbmRlcjtcblx0XHR0aGlzLmhlYWRlciA9IG5ldyBTZXNzaW9uU2VsZWN0b3JIZWFkZXIoXG5cdFx0XHR0aGlzLnNjb3BlLFxuXHRcdFx0dGhpcy5zb3J0TW9kZSxcblx0XHRcdHRoaXMubmFtZUZpbHRlcixcblx0XHRcdHRoaXMua2V5YmluZGluZ3MsXG5cdFx0XHR0aGlzLnJlcXVlc3RSZW5kZXIsXG5cdFx0KTtcblx0XHRjb25zdCByZW5hbWVTZXNzaW9uID0gb3B0aW9ucz8ucmVuYW1lU2Vzc2lvbjtcblx0XHR0aGlzLnJlbmFtZVNlc3Npb24gPSByZW5hbWVTZXNzaW9uO1xuXHRcdHRoaXMuY2FuUmVuYW1lID0gISFyZW5hbWVTZXNzaW9uO1xuXHRcdHRoaXMuaGVhZGVyLnNldFNob3dSZW5hbWVIaW50KG9wdGlvbnM/LnNob3dSZW5hbWVIaW50ID8/IHRoaXMuY2FuUmVuYW1lKTtcblxuXHRcdC8vIENyZWF0ZSBzZXNzaW9uIGxpc3QgKHN0YXJ0cyBlbXB0eSwgd2lsbCBiZSBwb3B1bGF0ZWQgYWZ0ZXIgbG9hZClcblx0XHR0aGlzLnNlc3Npb25MaXN0ID0gbmV3IFNlc3Npb25MaXN0KFxuXHRcdFx0W10sXG5cdFx0XHRmYWxzZSxcblx0XHRcdHRoaXMuc29ydE1vZGUsXG5cdFx0XHR0aGlzLm5hbWVGaWx0ZXIsXG5cdFx0XHR0aGlzLmtleWJpbmRpbmdzLFxuXHRcdFx0Y3VycmVudFNlc3Npb25GaWxlUGF0aCxcblx0XHQpO1xuXG5cdFx0dGhpcy5idWlsZEJhc2VMYXlvdXQodGhpcy5zZXNzaW9uTGlzdCk7XG5cblx0XHR0aGlzLnJlbmFtZUlucHV0Lm9uU3VibWl0ID0gKHZhbHVlKSA9PiB7XG5cdFx0XHR2b2lkIHRoaXMuY29uZmlybVJlbmFtZSh2YWx1ZSk7XG5cdFx0fTtcblxuXHRcdC8vIEVuc3VyZSBoZWFkZXIgc3RhdHVzIHRpbWVvdXRzIGFyZSBjbGVhcmVkIHdoZW4gbGVhdmluZyB0aGUgc2VsZWN0b3Jcblx0XHRjb25zdCBjbGVhclN0YXR1c01lc3NhZ2UgPSAoKSA9PiB0aGlzLmhlYWRlci5zZXRTdGF0dXNNZXNzYWdlKG51bGwpO1xuXHRcdHRoaXMuc2Vzc2lvbkxpc3Qub25TZWxlY3QgPSAoc2Vzc2lvblBhdGgpID0+IHtcblx0XHRcdGNsZWFyU3RhdHVzTWVzc2FnZSgpO1xuXHRcdFx0b25TZWxlY3Qoc2Vzc2lvblBhdGgpO1xuXHRcdH07XG5cdFx0dGhpcy5zZXNzaW9uTGlzdC5vbkNhbmNlbCA9ICgpID0+IHtcblx0XHRcdGNsZWFyU3RhdHVzTWVzc2FnZSgpO1xuXHRcdFx0b25DYW5jZWwoKTtcblx0XHR9O1xuXHRcdHRoaXMuc2Vzc2lvbkxpc3Qub25FeGl0ID0gKCkgPT4ge1xuXHRcdFx0Y2xlYXJTdGF0dXNNZXNzYWdlKCk7XG5cdFx0XHRvbkV4aXQoKTtcblx0XHR9O1xuXHRcdHRoaXMuc2Vzc2lvbkxpc3Qub25Ub2dnbGVTY29wZSA9ICgpID0+IHRoaXMudG9nZ2xlU2NvcGUoKTtcblx0XHR0aGlzLnNlc3Npb25MaXN0Lm9uVG9nZ2xlU29ydCA9ICgpID0+IHRoaXMudG9nZ2xlU29ydE1vZGUoKTtcblx0XHR0aGlzLnNlc3Npb25MaXN0Lm9uVG9nZ2xlTmFtZUZpbHRlciA9ICgpID0+IHRoaXMudG9nZ2xlTmFtZUZpbHRlcigpO1xuXHRcdHRoaXMuc2Vzc2lvbkxpc3Qub25SZW5hbWVTZXNzaW9uID0gKHNlc3Npb25QYXRoKSA9PiB7XG5cdFx0XHRpZiAoIXJlbmFtZVNlc3Npb24pIHJldHVybjtcblx0XHRcdGlmICh0aGlzLnNjb3BlID09PSBcImN1cnJlbnRcIiAmJiB0aGlzLmN1cnJlbnRMb2FkaW5nKSByZXR1cm47XG5cdFx0XHRpZiAodGhpcy5zY29wZSA9PT0gXCJhbGxcIiAmJiB0aGlzLmFsbExvYWRpbmcpIHJldHVybjtcblxuXHRcdFx0Y29uc3Qgc2Vzc2lvbnMgPSB0aGlzLnNjb3BlID09PSBcImFsbFwiID8gKHRoaXMuYWxsU2Vzc2lvbnMgPz8gW10pIDogKHRoaXMuY3VycmVudFNlc3Npb25zID8/IFtdKTtcblx0XHRcdGNvbnN0IHNlc3Npb24gPSBzZXNzaW9ucy5maW5kKChzKSA9PiBzLnBhdGggPT09IHNlc3Npb25QYXRoKTtcblx0XHRcdHRoaXMuZW50ZXJSZW5hbWVNb2RlKHNlc3Npb25QYXRoLCBzZXNzaW9uPy5uYW1lKTtcblx0XHR9O1xuXG5cdFx0Ly8gU3luYyBsaXN0IGV2ZW50cyB0byBoZWFkZXJcblx0XHR0aGlzLnNlc3Npb25MaXN0Lm9uVG9nZ2xlUGF0aCA9IChzaG93UGF0aCkgPT4ge1xuXHRcdFx0dGhpcy5oZWFkZXIuc2V0U2hvd1BhdGgoc2hvd1BhdGgpO1xuXHRcdFx0dGhpcy5yZXF1ZXN0UmVuZGVyKCk7XG5cdFx0fTtcblx0XHR0aGlzLnNlc3Npb25MaXN0Lm9uRGVsZXRlQ29uZmlybWF0aW9uQ2hhbmdlID0gKHBhdGgpID0+IHtcblx0XHRcdHRoaXMuaGVhZGVyLnNldENvbmZpcm1pbmdEZWxldGVQYXRoKHBhdGgpO1xuXHRcdFx0dGhpcy5yZXF1ZXN0UmVuZGVyKCk7XG5cdFx0fTtcblx0XHR0aGlzLnNlc3Npb25MaXN0Lm9uRXJyb3IgPSAobXNnKSA9PiB7XG5cdFx0XHR0aGlzLmhlYWRlci5zZXRTdGF0dXNNZXNzYWdlKHsgdHlwZTogXCJlcnJvclwiLCBtZXNzYWdlOiBtc2cgfSwgMzAwMCk7XG5cdFx0XHR0aGlzLnJlcXVlc3RSZW5kZXIoKTtcblx0XHR9O1xuXG5cdFx0Ly8gSGFuZGxlIHNlc3Npb24gZGVsZXRpb25cblx0XHR0aGlzLnNlc3Npb25MaXN0Lm9uRGVsZXRlU2Vzc2lvbiA9IGFzeW5jIChzZXNzaW9uUGF0aDogc3RyaW5nKSA9PiB7XG5cdFx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCBkZWxldGVTZXNzaW9uRmlsZShzZXNzaW9uUGF0aCk7XG5cblx0XHRcdGlmIChyZXN1bHQub2spIHtcblx0XHRcdFx0aWYgKHRoaXMuY3VycmVudFNlc3Npb25zKSB7XG5cdFx0XHRcdFx0dGhpcy5jdXJyZW50U2Vzc2lvbnMgPSB0aGlzLmN1cnJlbnRTZXNzaW9ucy5maWx0ZXIoKHMpID0+IHMucGF0aCAhPT0gc2Vzc2lvblBhdGgpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGlmICh0aGlzLmFsbFNlc3Npb25zKSB7XG5cdFx0XHRcdFx0dGhpcy5hbGxTZXNzaW9ucyA9IHRoaXMuYWxsU2Vzc2lvbnMuZmlsdGVyKChzKSA9PiBzLnBhdGggIT09IHNlc3Npb25QYXRoKTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGNvbnN0IHNlc3Npb25zID0gdGhpcy5zY29wZSA9PT0gXCJhbGxcIiA/ICh0aGlzLmFsbFNlc3Npb25zID8/IFtdKSA6ICh0aGlzLmN1cnJlbnRTZXNzaW9ucyA/PyBbXSk7XG5cdFx0XHRcdGNvbnN0IHNob3dDd2QgPSB0aGlzLnNjb3BlID09PSBcImFsbFwiO1xuXHRcdFx0XHR0aGlzLnNlc3Npb25MaXN0LnNldFNlc3Npb25zKHNlc3Npb25zLCBzaG93Q3dkKTtcblxuXHRcdFx0XHRjb25zdCBtc2cgPSByZXN1bHQubWV0aG9kID09PSBcInRyYXNoXCIgPyBcIlNlc3Npb24gbW92ZWQgdG8gdHJhc2hcIiA6IFwiU2Vzc2lvbiBkZWxldGVkXCI7XG5cdFx0XHRcdHRoaXMuaGVhZGVyLnNldFN0YXR1c01lc3NhZ2UoeyB0eXBlOiBcImluZm9cIiwgbWVzc2FnZTogbXNnIH0sIDIwMDApO1xuXHRcdFx0XHRhd2FpdCB0aGlzLnJlZnJlc2hTZXNzaW9uc0FmdGVyTXV0YXRpb24oKTtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdGNvbnN0IGVycm9yTWVzc2FnZSA9IHJlc3VsdC5lcnJvciA/PyBcIlVua25vd24gZXJyb3JcIjtcblx0XHRcdFx0dGhpcy5oZWFkZXIuc2V0U3RhdHVzTWVzc2FnZSh7IHR5cGU6IFwiZXJyb3JcIiwgbWVzc2FnZTogYEZhaWxlZCB0byBkZWxldGU6ICR7ZXJyb3JNZXNzYWdlfWAgfSwgMzAwMCk7XG5cdFx0XHR9XG5cblx0XHRcdHRoaXMucmVxdWVzdFJlbmRlcigpO1xuXHRcdH07XG5cblx0XHQvLyBTdGFydCBsb2FkaW5nIGN1cnJlbnQgc2Vzc2lvbnMgaW1tZWRpYXRlbHlcblx0XHR0aGlzLmxvYWRDdXJyZW50U2Vzc2lvbnMoKTtcblx0fVxuXG5cdHByaXZhdGUgbG9hZEN1cnJlbnRTZXNzaW9ucygpOiB2b2lkIHtcblx0XHR2b2lkIHRoaXMubG9hZFNjb3BlKFwiY3VycmVudFwiLCBcImluaXRpYWxcIik7XG5cdH1cblxuXHRwcml2YXRlIGVudGVyUmVuYW1lTW9kZShzZXNzaW9uUGF0aDogc3RyaW5nLCBjdXJyZW50TmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkKTogdm9pZCB7XG5cdFx0dGhpcy5tb2RlID0gXCJyZW5hbWVcIjtcblx0XHR0aGlzLnJlbmFtZVRhcmdldFBhdGggPSBzZXNzaW9uUGF0aDtcblx0XHR0aGlzLnJlbmFtZUlucHV0LnNldFZhbHVlKGN1cnJlbnROYW1lID8/IFwiXCIpO1xuXHRcdHRoaXMucmVuYW1lSW5wdXQuZm9jdXNlZCA9IHRydWU7XG5cblx0XHRjb25zdCBwYW5lbCA9IG5ldyBDb250YWluZXIoKTtcblx0XHRwYW5lbC5hZGRDaGlsZChuZXcgVGV4dCh0aGVtZS5ib2xkKFwiUmVuYW1lIFNlc3Npb25cIiksIDEsIDApKTtcblx0XHRwYW5lbC5hZGRDaGlsZChuZXcgU3BhY2VyKDEpKTtcblx0XHRwYW5lbC5hZGRDaGlsZCh0aGlzLnJlbmFtZUlucHV0KTtcblx0XHRwYW5lbC5hZGRDaGlsZChuZXcgU3BhY2VyKDEpKTtcblx0XHRwYW5lbC5hZGRDaGlsZChuZXcgVGV4dCh0aGVtZS5mZyhcIm11dGVkXCIsIFwiRW50ZXIgdG8gc2F2ZSBcdTAwQjcgRXNjL0N0cmwrQyB0byBjYW5jZWxcIiksIDEsIDApKTtcblxuXHRcdHRoaXMuYnVpbGRCYXNlTGF5b3V0KHBhbmVsLCB7IHNob3dIZWFkZXI6IGZhbHNlIH0pO1xuXHRcdHRoaXMucmVxdWVzdFJlbmRlcigpO1xuXHR9XG5cblx0cHJpdmF0ZSBleGl0UmVuYW1lTW9kZSgpOiB2b2lkIHtcblx0XHR0aGlzLm1vZGUgPSBcImxpc3RcIjtcblx0XHR0aGlzLnJlbmFtZVRhcmdldFBhdGggPSBudWxsO1xuXG5cdFx0dGhpcy5idWlsZEJhc2VMYXlvdXQodGhpcy5zZXNzaW9uTGlzdCk7XG5cblx0XHR0aGlzLnJlcXVlc3RSZW5kZXIoKTtcblx0fVxuXG5cdHByaXZhdGUgYXN5bmMgY29uZmlybVJlbmFtZSh2YWx1ZTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0Y29uc3QgbmV4dCA9IHZhbHVlLnRyaW0oKTtcblx0XHRpZiAoIW5leHQpIHJldHVybjtcblx0XHRjb25zdCB0YXJnZXQgPSB0aGlzLnJlbmFtZVRhcmdldFBhdGg7XG5cdFx0aWYgKCF0YXJnZXQpIHtcblx0XHRcdHRoaXMuZXhpdFJlbmFtZU1vZGUoKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHQvLyBGaW5kIGN1cnJlbnQgbmFtZSBmb3IgY2FsbGJhY2tcblx0XHRjb25zdCByZW5hbWVTZXNzaW9uID0gdGhpcy5yZW5hbWVTZXNzaW9uO1xuXHRcdGlmICghcmVuYW1lU2Vzc2lvbikge1xuXHRcdFx0dGhpcy5leGl0UmVuYW1lTW9kZSgpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdHRyeSB7XG5cdFx0XHRhd2FpdCByZW5hbWVTZXNzaW9uKHRhcmdldCwgbmV4dCk7XG5cdFx0XHRhd2FpdCB0aGlzLnJlZnJlc2hTZXNzaW9uc0FmdGVyTXV0YXRpb24oKTtcblx0XHR9IGZpbmFsbHkge1xuXHRcdFx0dGhpcy5leGl0UmVuYW1lTW9kZSgpO1xuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgYXN5bmMgbG9hZFNjb3BlKHNjb3BlOiBTZXNzaW9uU2NvcGUsIHJlYXNvbjogXCJpbml0aWFsXCIgfCBcInJlZnJlc2hcIiB8IFwidG9nZ2xlXCIpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRjb25zdCBzaG93Q3dkID0gc2NvcGUgPT09IFwiYWxsXCI7XG5cblx0XHQvLyBNYXJrIGxvYWRpbmdcblx0XHRpZiAoc2NvcGUgPT09IFwiY3VycmVudFwiKSB7XG5cdFx0XHR0aGlzLmN1cnJlbnRMb2FkaW5nID0gdHJ1ZTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0dGhpcy5hbGxMb2FkaW5nID0gdHJ1ZTtcblx0XHR9XG5cblx0XHRjb25zdCBzZXEgPSBzY29wZSA9PT0gXCJhbGxcIiA/ICsrdGhpcy5hbGxMb2FkU2VxIDogdW5kZWZpbmVkO1xuXHRcdHRoaXMuaGVhZGVyLnNldFNjb3BlKHNjb3BlKTtcblx0XHR0aGlzLmhlYWRlci5zZXRMb2FkaW5nKHRydWUpO1xuXHRcdHRoaXMucmVxdWVzdFJlbmRlcigpO1xuXG5cdFx0Y29uc3Qgb25Qcm9ncmVzcyA9IChsb2FkZWQ6IG51bWJlciwgdG90YWw6IG51bWJlcikgPT4ge1xuXHRcdFx0aWYgKHNjb3BlICE9PSB0aGlzLnNjb3BlKSByZXR1cm47XG5cdFx0XHRpZiAoc2VxICE9PSB1bmRlZmluZWQgJiYgc2VxICE9PSB0aGlzLmFsbExvYWRTZXEpIHJldHVybjtcblx0XHRcdHRoaXMuaGVhZGVyLnNldFByb2dyZXNzKGxvYWRlZCwgdG90YWwpO1xuXHRcdFx0dGhpcy5yZXF1ZXN0UmVuZGVyKCk7XG5cdFx0fTtcblxuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBzZXNzaW9ucyA9IGF3YWl0IChzY29wZSA9PT0gXCJjdXJyZW50XCJcblx0XHRcdFx0PyB0aGlzLmN1cnJlbnRTZXNzaW9uc0xvYWRlcihvblByb2dyZXNzKVxuXHRcdFx0XHQ6IHRoaXMuYWxsU2Vzc2lvbnNMb2FkZXIob25Qcm9ncmVzcykpO1xuXG5cdFx0XHRpZiAoc2NvcGUgPT09IFwiY3VycmVudFwiKSB7XG5cdFx0XHRcdHRoaXMuY3VycmVudFNlc3Npb25zID0gc2Vzc2lvbnM7XG5cdFx0XHRcdHRoaXMuY3VycmVudExvYWRpbmcgPSBmYWxzZTtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdHRoaXMuYWxsU2Vzc2lvbnMgPSBzZXNzaW9ucztcblx0XHRcdFx0dGhpcy5hbGxMb2FkaW5nID0gZmFsc2U7XG5cdFx0XHR9XG5cblx0XHRcdGlmIChzY29wZSAhPT0gdGhpcy5zY29wZSkgcmV0dXJuO1xuXHRcdFx0aWYgKHNlcSAhPT0gdW5kZWZpbmVkICYmIHNlcSAhPT0gdGhpcy5hbGxMb2FkU2VxKSByZXR1cm47XG5cblx0XHRcdHRoaXMuaGVhZGVyLnNldExvYWRpbmcoZmFsc2UpO1xuXHRcdFx0dGhpcy5zZXNzaW9uTGlzdC5zZXRTZXNzaW9ucyhzZXNzaW9ucywgc2hvd0N3ZCk7XG5cdFx0XHR0aGlzLnJlcXVlc3RSZW5kZXIoKTtcblxuXHRcdFx0aWYgKHNjb3BlID09PSBcImFsbFwiICYmIHNlc3Npb25zLmxlbmd0aCA9PT0gMCAmJiAodGhpcy5jdXJyZW50U2Vzc2lvbnM/Lmxlbmd0aCA/PyAwKSA9PT0gMCkge1xuXHRcdFx0XHR0aGlzLm9uQ2FuY2VsKCk7XG5cdFx0XHR9XG5cdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHRpZiAoc2NvcGUgPT09IFwiY3VycmVudFwiKSB7XG5cdFx0XHRcdHRoaXMuY3VycmVudExvYWRpbmcgPSBmYWxzZTtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdHRoaXMuYWxsTG9hZGluZyA9IGZhbHNlO1xuXHRcdFx0fVxuXG5cdFx0XHRpZiAoc2NvcGUgIT09IHRoaXMuc2NvcGUpIHJldHVybjtcblx0XHRcdGlmIChzZXEgIT09IHVuZGVmaW5lZCAmJiBzZXEgIT09IHRoaXMuYWxsTG9hZFNlcSkgcmV0dXJuO1xuXG5cdFx0XHRjb25zdCBtZXNzYWdlID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuXHRcdFx0dGhpcy5oZWFkZXIuc2V0TG9hZGluZyhmYWxzZSk7XG5cdFx0XHR0aGlzLmhlYWRlci5zZXRTdGF0dXNNZXNzYWdlKHsgdHlwZTogXCJlcnJvclwiLCBtZXNzYWdlOiBgRmFpbGVkIHRvIGxvYWQgc2Vzc2lvbnM6ICR7bWVzc2FnZX1gIH0sIDQwMDApO1xuXG5cdFx0XHRpZiAocmVhc29uID09PSBcImluaXRpYWxcIikge1xuXHRcdFx0XHR0aGlzLnNlc3Npb25MaXN0LnNldFNlc3Npb25zKFtdLCBzaG93Q3dkKTtcblx0XHRcdH1cblx0XHRcdHRoaXMucmVxdWVzdFJlbmRlcigpO1xuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgdG9nZ2xlU29ydE1vZGUoKTogdm9pZCB7XG5cdFx0Ly8gQ3ljbGU6IHRocmVhZGVkIC0+IHJlY2VudCAtPiByZWxldmFuY2UgLT4gdGhyZWFkZWRcblx0XHR0aGlzLnNvcnRNb2RlID0gdGhpcy5zb3J0TW9kZSA9PT0gXCJ0aHJlYWRlZFwiID8gXCJyZWNlbnRcIiA6IHRoaXMuc29ydE1vZGUgPT09IFwicmVjZW50XCIgPyBcInJlbGV2YW5jZVwiIDogXCJ0aHJlYWRlZFwiO1xuXHRcdHRoaXMuaGVhZGVyLnNldFNvcnRNb2RlKHRoaXMuc29ydE1vZGUpO1xuXHRcdHRoaXMuc2Vzc2lvbkxpc3Quc2V0U29ydE1vZGUodGhpcy5zb3J0TW9kZSk7XG5cdFx0dGhpcy5yZXF1ZXN0UmVuZGVyKCk7XG5cdH1cblxuXHRwcml2YXRlIHRvZ2dsZU5hbWVGaWx0ZXIoKTogdm9pZCB7XG5cdFx0dGhpcy5uYW1lRmlsdGVyID0gdGhpcy5uYW1lRmlsdGVyID09PSBcImFsbFwiID8gXCJuYW1lZFwiIDogXCJhbGxcIjtcblx0XHR0aGlzLmhlYWRlci5zZXROYW1lRmlsdGVyKHRoaXMubmFtZUZpbHRlcik7XG5cdFx0dGhpcy5zZXNzaW9uTGlzdC5zZXROYW1lRmlsdGVyKHRoaXMubmFtZUZpbHRlcik7XG5cdFx0dGhpcy5yZXF1ZXN0UmVuZGVyKCk7XG5cdH1cblxuXHRwcml2YXRlIGFzeW5jIHJlZnJlc2hTZXNzaW9uc0FmdGVyTXV0YXRpb24oKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0YXdhaXQgdGhpcy5sb2FkU2NvcGUodGhpcy5zY29wZSwgXCJyZWZyZXNoXCIpO1xuXHR9XG5cblx0cHJpdmF0ZSB0b2dnbGVTY29wZSgpOiB2b2lkIHtcblx0XHRpZiAodGhpcy5zY29wZSA9PT0gXCJjdXJyZW50XCIpIHtcblx0XHRcdHRoaXMuc2NvcGUgPSBcImFsbFwiO1xuXHRcdFx0dGhpcy5oZWFkZXIuc2V0U2NvcGUodGhpcy5zY29wZSk7XG5cblx0XHRcdGlmICh0aGlzLmFsbFNlc3Npb25zICE9PSBudWxsKSB7XG5cdFx0XHRcdHRoaXMuaGVhZGVyLnNldExvYWRpbmcoZmFsc2UpO1xuXHRcdFx0XHR0aGlzLnNlc3Npb25MaXN0LnNldFNlc3Npb25zKHRoaXMuYWxsU2Vzc2lvbnMsIHRydWUpO1xuXHRcdFx0XHR0aGlzLnJlcXVlc3RSZW5kZXIoKTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXG5cdFx0XHRpZiAoIXRoaXMuYWxsTG9hZGluZykge1xuXHRcdFx0XHR2b2lkIHRoaXMubG9hZFNjb3BlKFwiYWxsXCIsIFwidG9nZ2xlXCIpO1xuXHRcdFx0fVxuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdHRoaXMuc2NvcGUgPSBcImN1cnJlbnRcIjtcblx0XHR0aGlzLmhlYWRlci5zZXRTY29wZSh0aGlzLnNjb3BlKTtcblx0XHR0aGlzLmhlYWRlci5zZXRMb2FkaW5nKHRoaXMuY3VycmVudExvYWRpbmcpO1xuXHRcdHRoaXMuc2Vzc2lvbkxpc3Quc2V0U2Vzc2lvbnModGhpcy5jdXJyZW50U2Vzc2lvbnMgPz8gW10sIGZhbHNlKTtcblx0XHR0aGlzLnJlcXVlc3RSZW5kZXIoKTtcblx0fVxuXG5cdGdldFNlc3Npb25MaXN0KCk6IFNlc3Npb25MaXN0IHtcblx0XHRyZXR1cm4gdGhpcy5zZXNzaW9uTGlzdDtcblx0fVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxpQkFBaUI7QUFDMUIsU0FBUyxrQkFBa0I7QUFDM0IsU0FBUyxjQUFjO0FBQ3ZCO0FBQUEsRUFFQztBQUFBLEVBRUE7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNNO0FBQ1AsU0FBUywwQkFBMEI7QUFFbkMsU0FBUyxhQUFhO0FBQ3RCLFNBQVMsbUJBQW1CO0FBQzVCLFNBQVMscUJBQXFCO0FBQzlCLFNBQVMsUUFBUSxZQUFZLGVBQWU7QUFDNUMsU0FBUyx1QkFBdUIsc0JBQXNEO0FBQ3RGO0FBQUEsRUFDQztBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ007QUFJUCxTQUFTLGtCQUFrQixNQUFvQjtBQUM5QyxRQUFNLE1BQU0sb0JBQUksS0FBSztBQUNyQixRQUFNLFNBQVMsSUFBSSxRQUFRLElBQUksS0FBSyxRQUFRO0FBQzVDLFFBQU0sV0FBVyxLQUFLLE1BQU0sU0FBUyxHQUFLO0FBQzFDLFFBQU0sWUFBWSxLQUFLLE1BQU0sU0FBUyxJQUFPO0FBQzdDLFFBQU0sV0FBVyxLQUFLLE1BQU0sU0FBUyxLQUFRO0FBRTdDLE1BQUksV0FBVyxFQUFHLFFBQU87QUFD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
