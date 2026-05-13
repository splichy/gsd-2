import {
  Container,
  getEditorKeybindings,
  Input,
  matchesKey,
  Spacer,
  Text,
  TruncatedText,
  truncateToWidth
} from "@gsd/pi-tui";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyHint } from "./keybinding-hints.js";
import {
  applyRowHighlight,
  computeScrollWindow,
  renderCursor,
  renderScrollPosition
} from "./tree-render-utils.js";
class TreeList {
  constructor(tree, currentLeafId, maxVisibleLines, initialSelectedId, initialFilterMode) {
    this.flatNodes = [];
    this.filteredNodes = [];
    this.selectedIndex = 0;
    this.filterMode = "default";
    this.searchQuery = "";
    this.toolCallMap = /* @__PURE__ */ new Map();
    this.multipleRoots = false;
    this.activePathIds = /* @__PURE__ */ new Set();
    this.visibleParentMap = /* @__PURE__ */ new Map();
    this.visibleChildrenMap = /* @__PURE__ */ new Map();
    this.lastSelectedId = null;
    this.foldedNodes = /* @__PURE__ */ new Set();
    this.currentLeafId = currentLeafId;
    this.maxVisibleLines = maxVisibleLines;
    this.filterMode = initialFilterMode ?? "default";
    this.multipleRoots = tree.length > 1;
    this.flatNodes = this.flattenTree(tree);
    this.buildActivePath();
    this.applyFilter();
    const targetId = initialSelectedId ?? currentLeafId;
    this.selectedIndex = this.findNearestVisibleIndex(targetId);
    this.lastSelectedId = this.filteredNodes[this.selectedIndex]?.node.entry.id ?? null;
  }
  /**
   * Find the index of the nearest visible entry, walking up the parent chain if needed.
   * Returns the index in filteredNodes, or the last index as fallback.
   */
  findNearestVisibleIndex(entryId) {
    if (this.filteredNodes.length === 0) return 0;
    const entryMap = /* @__PURE__ */ new Map();
    for (const flatNode of this.flatNodes) {
      entryMap.set(flatNode.node.entry.id, flatNode);
    }
    const visibleIdToIndex = new Map(this.filteredNodes.map((node, i) => [node.node.entry.id, i]));
    let currentId = entryId;
    while (currentId !== null) {
      const index = visibleIdToIndex.get(currentId);
      if (index !== void 0) return index;
      const node = entryMap.get(currentId);
      if (!node) break;
      currentId = node.node.entry.parentId ?? null;
    }
    return this.filteredNodes.length - 1;
  }
  /** Build the set of entry IDs on the path from root to current leaf */
  buildActivePath() {
    this.activePathIds.clear();
    if (!this.currentLeafId) return;
    const entryMap = /* @__PURE__ */ new Map();
    for (const flatNode of this.flatNodes) {
      entryMap.set(flatNode.node.entry.id, flatNode);
    }
    let currentId = this.currentLeafId;
    while (currentId) {
      this.activePathIds.add(currentId);
      const node = entryMap.get(currentId);
      if (!node) break;
      currentId = node.node.entry.parentId ?? null;
    }
  }
  flattenTree(roots) {
    const result = [];
    this.toolCallMap.clear();
    const stack = [];
    const containsActive = /* @__PURE__ */ new Map();
    const leafId = this.currentLeafId;
    {
      const allNodes = [];
      const preOrderStack = [...roots];
      while (preOrderStack.length > 0) {
        const node = preOrderStack.pop();
        allNodes.push(node);
        for (let i = node.children.length - 1; i >= 0; i--) {
          preOrderStack.push(node.children[i]);
        }
      }
      for (let i = allNodes.length - 1; i >= 0; i--) {
        const node = allNodes[i];
        let has = leafId !== null && node.entry.id === leafId;
        for (const child of node.children) {
          if (containsActive.get(child)) {
            has = true;
          }
        }
        containsActive.set(node, has);
      }
    }
    const multipleRoots = roots.length > 1;
    const orderedRoots = [...roots].sort((a, b) => Number(containsActive.get(b)) - Number(containsActive.get(a)));
    for (let i = orderedRoots.length - 1; i >= 0; i--) {
      const isLast = i === orderedRoots.length - 1;
      stack.push([orderedRoots[i], multipleRoots ? 1 : 0, multipleRoots, multipleRoots, isLast, [], multipleRoots]);
    }
    while (stack.length > 0) {
      const [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop();
      const entry = node.entry;
      if (entry.type === "message" && entry.message.role === "assistant") {
        const content = entry.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block === "object" && block !== null && "type" in block && block.type === "toolCall") {
              const tc = block;
              this.toolCallMap.set(tc.id, { name: tc.name, arguments: tc.arguments });
            }
          }
        }
      }
      result.push({ node, indent, showConnector, isLast, gutters, isVirtualRootChild });
      const children = node.children;
      const multipleChildren = children.length > 1;
      const orderedChildren = (() => {
        const prioritized = [];
        const rest = [];
        for (const child of children) {
          if (containsActive.get(child)) {
            prioritized.push(child);
          } else {
            rest.push(child);
          }
        }
        return [...prioritized, ...rest];
      })();
      let childIndent;
      if (multipleChildren) {
        childIndent = indent + 1;
      } else if (justBranched && indent > 0) {
        childIndent = indent + 1;
      } else {
        childIndent = indent;
      }
      const connectorDisplayed = showConnector && !isVirtualRootChild;
      const currentDisplayIndent = this.multipleRoots ? Math.max(0, indent - 1) : indent;
      const connectorPosition = Math.max(0, currentDisplayIndent - 1);
      const childGutters = connectorDisplayed ? [...gutters, { position: connectorPosition, show: !isLast }] : gutters;
      for (let i = orderedChildren.length - 1; i >= 0; i--) {
        const childIsLast = i === orderedChildren.length - 1;
        stack.push([
          orderedChildren[i],
          childIndent,
          multipleChildren,
          multipleChildren,
          childIsLast,
          childGutters,
          false
        ]);
      }
    }
    return result;
  }
  applyFilter() {
    if (this.filteredNodes.length > 0) {
      this.lastSelectedId = this.filteredNodes[this.selectedIndex]?.node.entry.id ?? this.lastSelectedId;
    }
    const searchTokens = this.searchQuery.toLowerCase().split(/\s+/).filter(Boolean);
    this.filteredNodes = this.flatNodes.filter((flatNode) => {
      const entry = flatNode.node.entry;
      const isCurrentLeaf = entry.id === this.currentLeafId;
      if (entry.type === "message" && entry.message.role === "assistant" && !isCurrentLeaf) {
        const msg = entry.message;
        const hasText = this.hasTextContent(msg.content);
        const isErrorOrAborted = msg.stopReason && msg.stopReason !== "stop" && msg.stopReason !== "toolUse";
        if (!hasText && !isErrorOrAborted) {
          return false;
        }
      }
      let passesFilter = true;
      const isSettingsEntry = entry.type === "label" || entry.type === "custom" || entry.type === "model_change" || entry.type === "thinking_level_change";
      switch (this.filterMode) {
        case "user-only":
          passesFilter = entry.type === "message" && entry.message.role === "user";
          break;
        case "no-tools":
          passesFilter = !isSettingsEntry && !(entry.type === "message" && entry.message.role === "toolResult");
          break;
        case "labeled-only":
          passesFilter = flatNode.node.label !== void 0;
          break;
        case "all":
          passesFilter = true;
          break;
        default:
          passesFilter = !isSettingsEntry;
          break;
      }
      if (!passesFilter) return false;
      if (searchTokens.length > 0) {
        const nodeText = this.getSearchableText(flatNode.node).toLowerCase();
        return searchTokens.every((token) => nodeText.includes(token));
      }
      return true;
    });
    if (this.foldedNodes.size > 0) {
      const skipSet = /* @__PURE__ */ new Set();
      for (const flatNode of this.flatNodes) {
        const { id, parentId } = flatNode.node.entry;
        if (parentId != null && (this.foldedNodes.has(parentId) || skipSet.has(parentId))) {
          skipSet.add(id);
        }
      }
      this.filteredNodes = this.filteredNodes.filter((flatNode) => !skipSet.has(flatNode.node.entry.id));
    }
    this.recalculateVisualStructure();
    if (this.lastSelectedId) {
      this.selectedIndex = this.findNearestVisibleIndex(this.lastSelectedId);
    } else if (this.selectedIndex >= this.filteredNodes.length) {
      this.selectedIndex = Math.max(0, this.filteredNodes.length - 1);
    }
    if (this.filteredNodes.length > 0) {
      this.lastSelectedId = this.filteredNodes[this.selectedIndex]?.node.entry.id ?? this.lastSelectedId;
    }
  }
  /**
   * Recompute indentation/connectors for the filtered view
   *
   * Filtering can hide intermediate entries; descendants attach to the nearest visible ancestor.
   * Keep indentation semantics aligned with flattenTree() so single-child chains don't drift right.
   */
  recalculateVisualStructure() {
    if (this.filteredNodes.length === 0) return;
    const visibleIds = new Set(this.filteredNodes.map((n) => n.node.entry.id));
    const entryMap = /* @__PURE__ */ new Map();
    for (const flatNode of this.flatNodes) {
      entryMap.set(flatNode.node.entry.id, flatNode);
    }
    const findVisibleAncestor = (nodeId) => {
      let currentId = entryMap.get(nodeId)?.node.entry.parentId ?? null;
      while (currentId !== null) {
        if (visibleIds.has(currentId)) {
          return currentId;
        }
        currentId = entryMap.get(currentId)?.node.entry.parentId ?? null;
      }
      return null;
    };
    const visibleParent = /* @__PURE__ */ new Map();
    const visibleChildren = /* @__PURE__ */ new Map();
    visibleChildren.set(null, []);
    for (const flatNode of this.filteredNodes) {
      const nodeId = flatNode.node.entry.id;
      const ancestorId = findVisibleAncestor(nodeId);
      visibleParent.set(nodeId, ancestorId);
      if (!visibleChildren.has(ancestorId)) {
        visibleChildren.set(ancestorId, []);
      }
      visibleChildren.get(ancestorId).push(nodeId);
    }
    const visibleRootIds = visibleChildren.get(null);
    this.multipleRoots = visibleRootIds.length > 1;
    const filteredNodeMap = /* @__PURE__ */ new Map();
    for (const flatNode of this.filteredNodes) {
      filteredNodeMap.set(flatNode.node.entry.id, flatNode);
    }
    const stack = [];
    for (let i = visibleRootIds.length - 1; i >= 0; i--) {
      const isLast = i === visibleRootIds.length - 1;
      stack.push([
        visibleRootIds[i],
        this.multipleRoots ? 1 : 0,
        this.multipleRoots,
        this.multipleRoots,
        isLast,
        [],
        this.multipleRoots
      ]);
    }
    while (stack.length > 0) {
      const [nodeId, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop();
      const flatNode = filteredNodeMap.get(nodeId);
      if (!flatNode) continue;
      flatNode.indent = indent;
      flatNode.showConnector = showConnector;
      flatNode.isLast = isLast;
      flatNode.gutters = gutters;
      flatNode.isVirtualRootChild = isVirtualRootChild;
      const children = visibleChildren.get(nodeId) || [];
      const multipleChildren = children.length > 1;
      let childIndent;
      if (multipleChildren) {
        childIndent = indent + 1;
      } else if (justBranched && indent > 0) {
        childIndent = indent + 1;
      } else {
        childIndent = indent;
      }
      const connectorDisplayed = showConnector && !isVirtualRootChild;
      const currentDisplayIndent = this.multipleRoots ? Math.max(0, indent - 1) : indent;
      const connectorPosition = Math.max(0, currentDisplayIndent - 1);
      const childGutters = connectorDisplayed ? [...gutters, { position: connectorPosition, show: !isLast }] : gutters;
      for (let i = children.length - 1; i >= 0; i--) {
        const childIsLast = i === children.length - 1;
        stack.push([
          children[i],
          childIndent,
          multipleChildren,
          multipleChildren,
          childIsLast,
          childGutters,
          false
        ]);
      }
    }
    this.visibleParentMap = visibleParent;
    this.visibleChildrenMap = visibleChildren;
  }
  /** Get searchable text content from a node */
  getSearchableText(node) {
    const entry = node.entry;
    const parts = [];
    if (node.label) {
      parts.push(node.label);
    }
    switch (entry.type) {
      case "message": {
        const msg = entry.message;
        parts.push(msg.role);
        if ("content" in msg && msg.content) {
          parts.push(this.extractContent(msg.content));
        }
        if (msg.role === "bashExecution") {
          const bashMsg = msg;
          if (bashMsg.command) parts.push(bashMsg.command);
        }
        break;
      }
      case "custom_message": {
        parts.push(entry.customType);
        if (typeof entry.content === "string") {
          parts.push(entry.content);
        } else {
          parts.push(this.extractContent(entry.content));
        }
        break;
      }
      case "compaction":
        parts.push("compaction");
        break;
      case "branch_summary":
        parts.push("branch summary", entry.summary);
        break;
      case "model_change":
        parts.push("model", entry.modelId);
        break;
      case "thinking_level_change":
        parts.push("thinking", entry.thinkingLevel);
        break;
      case "custom":
        parts.push("custom", entry.customType);
        break;
      case "label":
        parts.push("label", entry.label ?? "");
        break;
    }
    return parts.join(" ");
  }
  invalidate() {
  }
  getSearchQuery() {
    return this.searchQuery;
  }
  getSelectedNode() {
    return this.filteredNodes[this.selectedIndex]?.node;
  }
  updateNodeLabel(entryId, label) {
    for (const flatNode of this.flatNodes) {
      if (flatNode.node.entry.id === entryId) {
        flatNode.node.label = label;
        break;
      }
    }
  }
  getFilterLabel() {
    switch (this.filterMode) {
      case "no-tools":
        return " [no-tools]";
      case "user-only":
        return " [user]";
      case "labeled-only":
        return " [labeled]";
      case "all":
        return " [all]";
      default:
        return "";
    }
  }
  render(width) {
    const lines = [];
    if (this.filteredNodes.length === 0) {
      lines.push(truncateToWidth(theme.fg("muted", "  No entries found"), width));
      lines.push(truncateToWidth(theme.fg("muted", `  (0/0)${this.getFilterLabel()}`), width));
      return lines;
    }
    const { startIndex, endIndex } = computeScrollWindow(
      this.selectedIndex,
      this.filteredNodes.length,
      this.maxVisibleLines
    );
    for (let i = startIndex; i < endIndex; i++) {
      const flatNode = this.filteredNodes[i];
      const entry = flatNode.node.entry;
      const isSelected = i === this.selectedIndex;
      const cursor = renderCursor(isSelected);
      const displayIndent = this.multipleRoots ? Math.max(0, flatNode.indent - 1) : flatNode.indent;
      const connector = flatNode.showConnector && !flatNode.isVirtualRootChild ? flatNode.isLast ? "\u2514\u2500 " : "\u251C\u2500 " : "";
      const connectorPosition = connector ? displayIndent - 1 : -1;
      const totalChars = displayIndent * 3;
      const prefixChars = [];
      const isFolded = this.foldedNodes.has(entry.id);
      for (let i2 = 0; i2 < totalChars; i2++) {
        const level = Math.floor(i2 / 3);
        const posInLevel = i2 % 3;
        const gutter = flatNode.gutters.find((g) => g.position === level);
        if (gutter) {
          if (posInLevel === 0) {
            prefixChars.push(gutter.show ? "\u2502" : " ");
          } else {
            prefixChars.push(" ");
          }
        } else if (connector && level === connectorPosition) {
          if (posInLevel === 0) {
            prefixChars.push(flatNode.isLast ? "\u2514" : "\u251C");
          } else if (posInLevel === 1) {
            const foldable = this.isFoldable(entry.id);
            prefixChars.push(isFolded ? "\u229E" : foldable ? "\u229F" : "\u2500");
          } else {
            prefixChars.push(" ");
          }
        } else {
          prefixChars.push(" ");
        }
      }
      const prefix = prefixChars.join("");
      const showsFoldInConnector = flatNode.showConnector && !flatNode.isVirtualRootChild;
      const foldMarker = isFolded && !showsFoldInConnector ? theme.fg("accent", "\u229E ") : "";
      const isOnActivePath = this.activePathIds.has(entry.id);
      const pathMarker = isOnActivePath ? theme.fg("accent", "\u2022 ") : "";
      const label = flatNode.node.label ? theme.fg("warning", `[${flatNode.node.label}] `) : "";
      const content = this.getEntryDisplayText(flatNode.node, isSelected);
      const line = cursor + theme.fg("dim", prefix) + foldMarker + pathMarker + label + content;
      lines.push(applyRowHighlight(line, isSelected, width));
    }
    lines.push(renderScrollPosition(this.selectedIndex, this.filteredNodes.length, width, this.getFilterLabel()));
    return lines;
  }
  getEntryDisplayText(node, isSelected) {
    const entry = node.entry;
    let result;
    const normalize = (s) => s.replace(/[\n\t]/g, " ").trim();
    switch (entry.type) {
      case "message": {
        const msg = entry.message;
        const role = msg.role;
        if (role === "user") {
          const msgWithContent = msg;
          const content = normalize(this.extractContent(msgWithContent.content));
          result = theme.fg("accent", "user: ") + content;
        } else if (role === "assistant") {
          const msgWithContent = msg;
          const textContent = normalize(this.extractContent(msgWithContent.content));
          if (textContent) {
            result = theme.fg("success", "assistant: ") + textContent;
          } else if (msgWithContent.stopReason === "aborted") {
            result = theme.fg("success", "assistant: ") + theme.fg("muted", "(aborted)");
          } else if (msgWithContent.errorMessage) {
            const errMsg = normalize(msgWithContent.errorMessage).slice(0, 80);
            result = theme.fg("success", "assistant: ") + theme.fg("error", errMsg);
          } else {
            result = theme.fg("success", "assistant: ") + theme.fg("muted", "(no content)");
          }
        } else if (role === "toolResult") {
          const toolMsg = msg;
          const toolCall = toolMsg.toolCallId ? this.toolCallMap.get(toolMsg.toolCallId) : void 0;
          if (toolCall) {
            result = theme.fg("muted", this.formatToolCall(toolCall.name, toolCall.arguments));
          } else {
            result = theme.fg("muted", `[${toolMsg.toolName ?? "tool"}]`);
          }
        } else if (role === "bashExecution") {
          const bashMsg = msg;
          result = theme.fg("dim", `[bash]: ${normalize(bashMsg.command ?? "")}`);
        } else {
          result = theme.fg("dim", `[${role}]`);
        }
        break;
      }
      case "custom_message": {
        const content = typeof entry.content === "string" ? entry.content : entry.content.filter((c) => c.type === "text").map((c) => c.text).join("");
        result = theme.fg("customMessageLabel", `[${entry.customType}]: `) + normalize(content);
        break;
      }
      case "compaction": {
        const tokens = Math.round(entry.tokensBefore / 1e3);
        result = theme.fg("borderAccent", `[compaction: ${tokens}k tokens]`);
        break;
      }
      case "branch_summary":
        result = theme.fg("warning", `[branch summary]: `) + normalize(entry.summary);
        break;
      case "model_change":
        result = theme.fg("dim", `[model: ${entry.modelId}]`);
        break;
      case "thinking_level_change":
        result = theme.fg("dim", `[thinking: ${entry.thinkingLevel}]`);
        break;
      case "custom":
        result = theme.fg("dim", `[custom: ${entry.customType}]`);
        break;
      case "label":
        result = theme.fg("dim", `[label: ${entry.label ?? "(cleared)"}]`);
        break;
      default:
        result = "";
    }
    return isSelected ? theme.bold(result) : result;
  }
  extractContent(content) {
    const maxLen = 200;
    if (typeof content === "string") return content.slice(0, maxLen);
    if (Array.isArray(content)) {
      let result = "";
      for (const c of content) {
        if (typeof c === "object" && c !== null && "type" in c && c.type === "text") {
          result += c.text;
          if (result.length >= maxLen) return result.slice(0, maxLen);
        }
      }
      return result;
    }
    return "";
  }
  hasTextContent(content) {
    if (typeof content === "string") return content.trim().length > 0;
    if (Array.isArray(content)) {
      for (const c of content) {
        if (typeof c === "object" && c !== null && "type" in c && c.type === "text") {
          const text = c.text;
          if (text && text.trim().length > 0) return true;
        }
      }
    }
    return false;
  }
  formatToolCall(name, args) {
    const shortenPath = (p) => {
      const home = process.env.HOME || process.env.USERPROFILE || "";
      if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
      return p;
    };
    switch (name) {
      case "read": {
        const path = shortenPath(String(args.path || args.file_path || ""));
        const offset = args.offset;
        const limit = args.limit;
        let display = path;
        if (offset !== void 0 || limit !== void 0) {
          const start = offset ?? 1;
          const end = limit !== void 0 ? start + limit - 1 : "";
          display += `:${start}${end ? `-${end}` : ""}`;
        }
        return `[read: ${display}]`;
      }
      case "write": {
        const path = shortenPath(String(args.path || args.file_path || ""));
        return `[write: ${path}]`;
      }
      case "edit": {
        const path = shortenPath(String(args.path || args.file_path || ""));
        return `[edit: ${path}]`;
      }
      case "bash": {
        const rawCmd = String(args.command || "");
        const cmd = rawCmd.replace(/[\n\t]/g, " ").trim().slice(0, 50);
        return `[bash: ${cmd}${rawCmd.length > 50 ? "..." : ""}]`;
      }
      case "grep": {
        const pattern = String(args.pattern || "");
        const path = shortenPath(String(args.path || "."));
        return `[grep: /${pattern}/ in ${path}]`;
      }
      case "find": {
        const pattern = String(args.pattern || "");
        const path = shortenPath(String(args.path || "."));
        return `[find: ${pattern} in ${path}]`;
      }
      case "ls": {
        const path = shortenPath(String(args.path || "."));
        return `[ls: ${path}]`;
      }
      default: {
        const argsStr = JSON.stringify(args).slice(0, 40);
        return `[${name}: ${argsStr}${JSON.stringify(args).length > 40 ? "..." : ""}]`;
      }
    }
  }
  handleInput(keyData) {
    const kb = getEditorKeybindings();
    if (kb.matches(keyData, "selectUp")) {
      this.selectedIndex = this.selectedIndex === 0 ? this.filteredNodes.length - 1 : this.selectedIndex - 1;
    } else if (kb.matches(keyData, "selectDown")) {
      this.selectedIndex = this.selectedIndex === this.filteredNodes.length - 1 ? 0 : this.selectedIndex + 1;
    } else if (kb.matches(keyData, "treeFoldOrUp")) {
      const currentId = this.filteredNodes[this.selectedIndex]?.node.entry.id;
      if (currentId && this.isFoldable(currentId) && !this.foldedNodes.has(currentId)) {
        this.foldedNodes.add(currentId);
        this.applyFilter();
      } else {
        this.selectedIndex = this.findBranchSegmentStart("up");
      }
    } else if (kb.matches(keyData, "treeUnfoldOrDown")) {
      const currentId = this.filteredNodes[this.selectedIndex]?.node.entry.id;
      if (currentId && this.foldedNodes.has(currentId)) {
        this.foldedNodes.delete(currentId);
        this.applyFilter();
      } else {
        this.selectedIndex = this.findBranchSegmentStart("down");
      }
    } else if (kb.matches(keyData, "cursorLeft") || kb.matches(keyData, "selectPageUp")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisibleLines);
    } else if (kb.matches(keyData, "cursorRight") || kb.matches(keyData, "selectPageDown")) {
      this.selectedIndex = Math.min(this.filteredNodes.length - 1, this.selectedIndex + this.maxVisibleLines);
    } else if (kb.matches(keyData, "selectConfirm")) {
      const selected = this.filteredNodes[this.selectedIndex];
      if (selected && this.onSelect) {
        this.onSelect(selected.node.entry.id);
      }
    } else if (kb.matches(keyData, "selectCancel")) {
      if (this.searchQuery) {
        this.searchQuery = "";
        this.foldedNodes.clear();
        this.applyFilter();
      } else {
        this.onCancel?.();
      }
    } else if (matchesKey(keyData, "ctrl+d")) {
      this.filterMode = "default";
      this.foldedNodes.clear();
      this.applyFilter();
    } else if (matchesKey(keyData, "ctrl+t")) {
      this.filterMode = this.filterMode === "no-tools" ? "default" : "no-tools";
      this.foldedNodes.clear();
      this.applyFilter();
    } else if (matchesKey(keyData, "ctrl+u")) {
      this.filterMode = this.filterMode === "user-only" ? "default" : "user-only";
      this.foldedNodes.clear();
      this.applyFilter();
    } else if (matchesKey(keyData, "ctrl+l")) {
      this.filterMode = this.filterMode === "labeled-only" ? "default" : "labeled-only";
      this.foldedNodes.clear();
      this.applyFilter();
    } else if (matchesKey(keyData, "ctrl+a")) {
      this.filterMode = this.filterMode === "all" ? "default" : "all";
      this.foldedNodes.clear();
      this.applyFilter();
    } else if (matchesKey(keyData, "shift+ctrl+o")) {
      const modes = ["default", "no-tools", "user-only", "labeled-only", "all"];
      const currentIndex = modes.indexOf(this.filterMode);
      this.filterMode = modes[(currentIndex - 1 + modes.length) % modes.length];
      this.foldedNodes.clear();
      this.applyFilter();
    } else if (matchesKey(keyData, "ctrl+o")) {
      const modes = ["default", "no-tools", "user-only", "labeled-only", "all"];
      const currentIndex = modes.indexOf(this.filterMode);
      this.filterMode = modes[(currentIndex + 1) % modes.length];
      this.foldedNodes.clear();
      this.applyFilter();
    } else if (kb.matches(keyData, "deleteCharBackward")) {
      if (this.searchQuery.length > 0) {
        this.searchQuery = this.searchQuery.slice(0, -1);
        this.foldedNodes.clear();
        this.applyFilter();
      }
    } else if (matchesKey(keyData, "shift+l")) {
      const selected = this.filteredNodes[this.selectedIndex];
      if (selected && this.onLabelEdit) {
        this.onLabelEdit(selected.node.entry.id, selected.node.label);
      }
    } else {
      const hasControlChars = [...keyData].some((ch) => {
        const code = ch.charCodeAt(0);
        return code < 32 || code === 127 || code >= 128 && code <= 159;
      });
      if (!hasControlChars && keyData.length > 0) {
        this.searchQuery += keyData;
        this.foldedNodes.clear();
        this.applyFilter();
      }
    }
  }
  /**
   * Whether a node can be folded. A node is foldable if it has visible children
   * and is either a root (no visible parent) or a segment start (visible parent
   * has multiple visible children).
   */
  isFoldable(entryId) {
    const children = this.visibleChildrenMap.get(entryId);
    if (!children || children.length === 0) return false;
    const parentId = this.visibleParentMap.get(entryId);
    if (parentId === null || parentId === void 0) return true;
    const siblings = this.visibleChildrenMap.get(parentId);
    return siblings !== void 0 && siblings.length > 1;
  }
  /**
   * Find the index of the next branch segment start in the given direction.
   * A segment start is the first child of a branch point.
   *
   * "up" walks the visible parent chain; "down" walks visible children
   * (always following the first child).
   */
  findBranchSegmentStart(direction) {
    const selectedId = this.filteredNodes[this.selectedIndex]?.node.entry.id;
    if (!selectedId) return this.selectedIndex;
    const indexByEntryId = new Map(this.filteredNodes.map((node, i) => [node.node.entry.id, i]));
    let currentId = selectedId;
    if (direction === "down") {
      while (true) {
        const children = this.visibleChildrenMap.get(currentId) ?? [];
        if (children.length === 0) return indexByEntryId.get(currentId);
        if (children.length > 1) return indexByEntryId.get(children[0]);
        currentId = children[0];
      }
    }
    while (true) {
      const parentId = this.visibleParentMap.get(currentId) ?? null;
      if (parentId === null) return indexByEntryId.get(currentId);
      const children = this.visibleChildrenMap.get(parentId) ?? [];
      if (children.length > 1) {
        const segmentStart = indexByEntryId.get(currentId);
        if (segmentStart < this.selectedIndex) {
          return segmentStart;
        }
      }
      currentId = parentId;
    }
  }
}
class SearchLine {
  constructor(treeList) {
    this.treeList = treeList;
  }
  invalidate() {
  }
  render(width) {
    const query = this.treeList.getSearchQuery();
    if (query) {
      return [truncateToWidth(`  ${theme.fg("muted", "Type to search:")} ${theme.fg("accent", query)}`, width)];
    }
    return [truncateToWidth(`  ${theme.fg("muted", "Type to search:")}`, width)];
  }
  handleInput(_keyData) {
  }
}
class LabelInput {
  constructor(entryId, currentLabel) {
    // Focusable implementation - propagate to input for IME cursor positioning
    this._focused = false;
    this.entryId = entryId;
    this.input = new Input();
    if (currentLabel) {
      this.input.setValue(currentLabel);
    }
  }
  get focused() {
    return this._focused;
  }
  set focused(value) {
    this._focused = value;
    this.input.focused = value;
  }
  invalidate() {
  }
  render(width) {
    const lines = [];
    const indent = "  ";
    const availableWidth = width - indent.length;
    lines.push(truncateToWidth(`${indent}${theme.fg("muted", "Label (empty to remove):")}`, width));
    lines.push(...this.input.render(availableWidth).map((line) => truncateToWidth(`${indent}${line}`, width)));
    lines.push(
      truncateToWidth(`${indent}${keyHint("selectConfirm", "save")}  ${keyHint("selectCancel", "cancel")}`, width)
    );
    return lines;
  }
  handleInput(keyData) {
    const kb = getEditorKeybindings();
    if (kb.matches(keyData, "selectConfirm")) {
      const value = this.input.getValue().trim();
      this.onSubmit?.(this.entryId, value || void 0);
    } else if (kb.matches(keyData, "selectCancel")) {
      this.onCancel?.();
    } else {
      this.input.handleInput(keyData);
    }
  }
}
class TreeSelectorComponent extends Container {
  constructor(tree, currentLeafId, terminalHeight, onSelect, onCancel, onLabelChange, initialSelectedId, initialFilterMode) {
    super();
    this.labelInput = null;
    // Focusable implementation - propagate to labelInput when active for IME cursor positioning
    this._focused = false;
    this.onLabelChangeCallback = onLabelChange;
    const maxVisibleLines = Math.max(5, Math.floor(terminalHeight / 2));
    this.treeList = new TreeList(tree, currentLeafId, maxVisibleLines, initialSelectedId, initialFilterMode);
    this.treeList.onSelect = onSelect;
    this.treeList.onCancel = onCancel;
    this.treeList.onLabelEdit = (entryId, currentLabel) => this.showLabelInput(entryId, currentLabel);
    this.treeContainer = new Container();
    this.treeContainer.addChild(this.treeList);
    this.labelInputContainer = new Container();
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder());
    this.addChild(new Text(theme.bold("  Session Tree"), 1, 0));
    this.addChild(
      new TruncatedText(
        theme.fg("muted", `  \u2191/\u2193: move. \u2190/\u2192: page. ^\u2190/^\u2192 or ${process.platform === "darwin" ? "\u2325\u2190/\u2325\u2192" : "Alt+\u2190/Alt+\u2192"}: fold/branch. Shift+L: label. `) + theme.fg("muted", "^D/^T/^U/^L/^A: filters (^O/\u21E7^O cycle)"),
        0,
        0
      )
    );
    this.addChild(new SearchLine(this.treeList));
    this.addChild(new DynamicBorder());
    this.addChild(new Spacer(1));
    this.addChild(this.treeContainer);
    this.addChild(this.labelInputContainer);
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder());
    if (tree.length === 0) {
      setTimeout(() => onCancel(), 100);
    }
  }
  get focused() {
    return this._focused;
  }
  set focused(value) {
    this._focused = value;
    if (this.labelInput) {
      this.labelInput.focused = value;
    }
  }
  showLabelInput(entryId, currentLabel) {
    this.labelInput = new LabelInput(entryId, currentLabel);
    this.labelInput.onSubmit = (id, label) => {
      this.treeList.updateNodeLabel(id, label);
      this.onLabelChangeCallback?.(id, label);
      this.hideLabelInput();
    };
    this.labelInput.onCancel = () => this.hideLabelInput();
    this.labelInput.focused = this._focused;
    this.treeContainer.clear();
    this.labelInputContainer.clear();
    this.labelInputContainer.addChild(this.labelInput);
  }
  hideLabelInput() {
    this.labelInput = null;
    this.labelInputContainer.clear();
    this.treeContainer.clear();
    this.treeContainer.addChild(this.treeList);
  }
  handleInput(keyData) {
    if (this.labelInput) {
      this.labelInput.handleInput(keyData);
    } else {
      this.treeList.handleInput(keyData);
    }
  }
  getTreeList() {
    return this.treeList;
  }
}
export {
  TreeSelectorComponent
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9tb2Rlcy9pbnRlcmFjdGl2ZS9jb21wb25lbnRzL3RyZWUtc2VsZWN0b3IudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7XG5cdHR5cGUgQ29tcG9uZW50LFxuXHRDb250YWluZXIsXG5cdHR5cGUgRm9jdXNhYmxlLFxuXHRnZXRFZGl0b3JLZXliaW5kaW5ncyxcblx0SW5wdXQsXG5cdG1hdGNoZXNLZXksXG5cdFNwYWNlcixcblx0VGV4dCxcblx0VHJ1bmNhdGVkVGV4dCxcblx0dHJ1bmNhdGVUb1dpZHRoLFxufSBmcm9tIFwiQGdzZC9waS10dWlcIjtcbmltcG9ydCB0eXBlIHsgU2Vzc2lvblRyZWVOb2RlIH0gZnJvbSBcIi4uLy4uLy4uL2NvcmUvc2Vzc2lvbi1tYW5hZ2VyLmpzXCI7XG5pbXBvcnQgeyB0aGVtZSB9IGZyb20gXCIuLi90aGVtZS90aGVtZS5qc1wiO1xuaW1wb3J0IHsgRHluYW1pY0JvcmRlciB9IGZyb20gXCIuL2R5bmFtaWMtYm9yZGVyLmpzXCI7XG5pbXBvcnQgeyBrZXlIaW50IH0gZnJvbSBcIi4va2V5YmluZGluZy1oaW50cy5qc1wiO1xuaW1wb3J0IHtcblx0YXBwbHlSb3dIaWdobGlnaHQsXG5cdGNvbXB1dGVTY3JvbGxXaW5kb3csXG5cdHJlbmRlckN1cnNvcixcblx0cmVuZGVyU2Nyb2xsUG9zaXRpb24sXG59IGZyb20gXCIuL3RyZWUtcmVuZGVyLXV0aWxzLmpzXCI7XG5cbi8qKiBHdXR0ZXIgaW5mbzogcG9zaXRpb24gKGRpc3BsYXlJbmRlbnQgd2hlcmUgY29ubmVjdG9yIHdhcykgYW5kIHdoZXRoZXIgdG8gc2hvdyBcdTI1MDIgKi9cbmludGVyZmFjZSBHdXR0ZXJJbmZvIHtcblx0cG9zaXRpb246IG51bWJlcjsgLy8gZGlzcGxheUluZGVudCBsZXZlbCB3aGVyZSB0aGUgY29ubmVjdG9yIHdhcyBzaG93blxuXHRzaG93OiBib29sZWFuOyAvLyB0cnVlID0gc2hvdyBcdTI1MDIsIGZhbHNlID0gc2hvdyBzcGFjZXNcbn1cblxuLyoqIEZsYXR0ZW5lZCB0cmVlIG5vZGUgZm9yIG5hdmlnYXRpb24gKi9cbmludGVyZmFjZSBGbGF0Tm9kZSB7XG5cdG5vZGU6IFNlc3Npb25UcmVlTm9kZTtcblx0LyoqIEluZGVudGF0aW9uIGxldmVsIChlYWNoIGxldmVsID0gMyBjaGFycykgKi9cblx0aW5kZW50OiBudW1iZXI7XG5cdC8qKiBXaGV0aGVyIHRvIHNob3cgY29ubmVjdG9yIChcdTI1MUNcdTI1MDAgb3IgXHUyNTE0XHUyNTAwKSAtIHRydWUgaWYgcGFyZW50IGhhcyBtdWx0aXBsZSBjaGlsZHJlbiAqL1xuXHRzaG93Q29ubmVjdG9yOiBib29sZWFuO1xuXHQvKiogSWYgc2hvd0Nvbm5lY3RvciwgdHJ1ZSA9IGxhc3Qgc2libGluZyAoXHUyNTE0XHUyNTAwKSwgZmFsc2UgPSBub3QgbGFzdCAoXHUyNTFDXHUyNTAwKSAqL1xuXHRpc0xhc3Q6IGJvb2xlYW47XG5cdC8qKiBHdXR0ZXIgaW5mbyBmb3IgZWFjaCBhbmNlc3RvciBicmFuY2ggcG9pbnQgKi9cblx0Z3V0dGVyczogR3V0dGVySW5mb1tdO1xuXHQvKiogVHJ1ZSBpZiB0aGlzIG5vZGUgaXMgYSByb290IHVuZGVyIGEgdmlydHVhbCBicmFuY2hpbmcgcm9vdCAobXVsdGlwbGUgcm9vdHMpICovXG5cdGlzVmlydHVhbFJvb3RDaGlsZDogYm9vbGVhbjtcbn1cblxuLyoqIEZpbHRlciBtb2RlIGZvciB0cmVlIGRpc3BsYXkgKi9cbmV4cG9ydCB0eXBlIEZpbHRlck1vZGUgPSBcImRlZmF1bHRcIiB8IFwibm8tdG9vbHNcIiB8IFwidXNlci1vbmx5XCIgfCBcImxhYmVsZWQtb25seVwiIHwgXCJhbGxcIjtcblxuLyoqXG4gKiBUcmVlIGxpc3QgY29tcG9uZW50IHdpdGggc2VsZWN0aW9uIGFuZCBBU0NJSSBhcnQgdmlzdWFsaXphdGlvblxuICovXG4vKiogVG9vbCBjYWxsIGluZm8gZm9yIGxvb2t1cCAqL1xuaW50ZXJmYWNlIFRvb2xDYWxsSW5mbyB7XG5cdG5hbWU6IHN0cmluZztcblx0YXJndW1lbnRzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbn1cblxuY2xhc3MgVHJlZUxpc3QgaW1wbGVtZW50cyBDb21wb25lbnQge1xuXHRwcml2YXRlIGZsYXROb2RlczogRmxhdE5vZGVbXSA9IFtdO1xuXHRwcml2YXRlIGZpbHRlcmVkTm9kZXM6IEZsYXROb2RlW10gPSBbXTtcblx0cHJpdmF0ZSBzZWxlY3RlZEluZGV4ID0gMDtcblx0cHJpdmF0ZSBjdXJyZW50TGVhZklkOiBzdHJpbmcgfCBudWxsO1xuXHRwcml2YXRlIG1heFZpc2libGVMaW5lczogbnVtYmVyO1xuXHRwcml2YXRlIGZpbHRlck1vZGU6IEZpbHRlck1vZGUgPSBcImRlZmF1bHRcIjtcblx0cHJpdmF0ZSBzZWFyY2hRdWVyeSA9IFwiXCI7XG5cdHByaXZhdGUgdG9vbENhbGxNYXA6IE1hcDxzdHJpbmcsIFRvb2xDYWxsSW5mbz4gPSBuZXcgTWFwKCk7XG5cdHByaXZhdGUgbXVsdGlwbGVSb290cyA9IGZhbHNlO1xuXHRwcml2YXRlIGFjdGl2ZVBhdGhJZHM6IFNldDxzdHJpbmc+ID0gbmV3IFNldCgpO1xuXHRwcml2YXRlIHZpc2libGVQYXJlbnRNYXA6IE1hcDxzdHJpbmcsIHN0cmluZyB8IG51bGw+ID0gbmV3IE1hcCgpO1xuXHRwcml2YXRlIHZpc2libGVDaGlsZHJlbk1hcDogTWFwPHN0cmluZyB8IG51bGwsIHN0cmluZ1tdPiA9IG5ldyBNYXAoKTtcblx0cHJpdmF0ZSBsYXN0U2VsZWN0ZWRJZDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cdHByaXZhdGUgZm9sZGVkTm9kZXM6IFNldDxzdHJpbmc+ID0gbmV3IFNldCgpO1xuXG5cdHB1YmxpYyBvblNlbGVjdD86IChlbnRyeUlkOiBzdHJpbmcpID0+IHZvaWQ7XG5cdHB1YmxpYyBvbkNhbmNlbD86ICgpID0+IHZvaWQ7XG5cdHB1YmxpYyBvbkxhYmVsRWRpdD86IChlbnRyeUlkOiBzdHJpbmcsIGN1cnJlbnRMYWJlbDogc3RyaW5nIHwgdW5kZWZpbmVkKSA9PiB2b2lkO1xuXG5cdGNvbnN0cnVjdG9yKFxuXHRcdHRyZWU6IFNlc3Npb25UcmVlTm9kZVtdLFxuXHRcdGN1cnJlbnRMZWFmSWQ6IHN0cmluZyB8IG51bGwsXG5cdFx0bWF4VmlzaWJsZUxpbmVzOiBudW1iZXIsXG5cdFx0aW5pdGlhbFNlbGVjdGVkSWQ/OiBzdHJpbmcsXG5cdFx0aW5pdGlhbEZpbHRlck1vZGU/OiBGaWx0ZXJNb2RlLFxuXHQpIHtcblx0XHR0aGlzLmN1cnJlbnRMZWFmSWQgPSBjdXJyZW50TGVhZklkO1xuXHRcdHRoaXMubWF4VmlzaWJsZUxpbmVzID0gbWF4VmlzaWJsZUxpbmVzO1xuXHRcdHRoaXMuZmlsdGVyTW9kZSA9IGluaXRpYWxGaWx0ZXJNb2RlID8/IFwiZGVmYXVsdFwiO1xuXHRcdHRoaXMubXVsdGlwbGVSb290cyA9IHRyZWUubGVuZ3RoID4gMTtcblx0XHR0aGlzLmZsYXROb2RlcyA9IHRoaXMuZmxhdHRlblRyZWUodHJlZSk7XG5cdFx0dGhpcy5idWlsZEFjdGl2ZVBhdGgoKTtcblx0XHR0aGlzLmFwcGx5RmlsdGVyKCk7XG5cblx0XHQvLyBTdGFydCB3aXRoIGluaXRpYWxTZWxlY3RlZElkIGlmIHByb3ZpZGVkLCBvdGhlcndpc2UgY3VycmVudCBsZWFmXG5cdFx0Y29uc3QgdGFyZ2V0SWQgPSBpbml0aWFsU2VsZWN0ZWRJZCA/PyBjdXJyZW50TGVhZklkO1xuXHRcdHRoaXMuc2VsZWN0ZWRJbmRleCA9IHRoaXMuZmluZE5lYXJlc3RWaXNpYmxlSW5kZXgodGFyZ2V0SWQpO1xuXHRcdHRoaXMubGFzdFNlbGVjdGVkSWQgPSB0aGlzLmZpbHRlcmVkTm9kZXNbdGhpcy5zZWxlY3RlZEluZGV4XT8ubm9kZS5lbnRyeS5pZCA/PyBudWxsO1xuXHR9XG5cblx0LyoqXG5cdCAqIEZpbmQgdGhlIGluZGV4IG9mIHRoZSBuZWFyZXN0IHZpc2libGUgZW50cnksIHdhbGtpbmcgdXAgdGhlIHBhcmVudCBjaGFpbiBpZiBuZWVkZWQuXG5cdCAqIFJldHVybnMgdGhlIGluZGV4IGluIGZpbHRlcmVkTm9kZXMsIG9yIHRoZSBsYXN0IGluZGV4IGFzIGZhbGxiYWNrLlxuXHQgKi9cblx0cHJpdmF0ZSBmaW5kTmVhcmVzdFZpc2libGVJbmRleChlbnRyeUlkOiBzdHJpbmcgfCBudWxsKTogbnVtYmVyIHtcblx0XHRpZiAodGhpcy5maWx0ZXJlZE5vZGVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIDA7XG5cblx0XHQvLyBCdWlsZCBhIG1hcCBmb3IgcGFyZW50IGxvb2t1cFxuXHRcdGNvbnN0IGVudHJ5TWFwID0gbmV3IE1hcDxzdHJpbmcsIEZsYXROb2RlPigpO1xuXHRcdGZvciAoY29uc3QgZmxhdE5vZGUgb2YgdGhpcy5mbGF0Tm9kZXMpIHtcblx0XHRcdGVudHJ5TWFwLnNldChmbGF0Tm9kZS5ub2RlLmVudHJ5LmlkLCBmbGF0Tm9kZSk7XG5cdFx0fVxuXG5cdFx0Ly8gQnVpbGQgYSBtYXAgb2YgdmlzaWJsZSBlbnRyeSBJRHMgdG8gdGhlaXIgaW5kaWNlcyBpbiBmaWx0ZXJlZE5vZGVzXG5cdFx0Y29uc3QgdmlzaWJsZUlkVG9JbmRleCA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KHRoaXMuZmlsdGVyZWROb2Rlcy5tYXAoKG5vZGUsIGkpID0+IFtub2RlLm5vZGUuZW50cnkuaWQsIGldKSk7XG5cblx0XHQvLyBXYWxrIGZyb20gZW50cnlJZCB1cCB0byByb290LCBsb29raW5nIGZvciBhIHZpc2libGUgZW50cnlcblx0XHRsZXQgY3VycmVudElkID0gZW50cnlJZDtcblx0XHR3aGlsZSAoY3VycmVudElkICE9PSBudWxsKSB7XG5cdFx0XHRjb25zdCBpbmRleCA9IHZpc2libGVJZFRvSW5kZXguZ2V0KGN1cnJlbnRJZCk7XG5cdFx0XHRpZiAoaW5kZXggIT09IHVuZGVmaW5lZCkgcmV0dXJuIGluZGV4O1xuXHRcdFx0Y29uc3Qgbm9kZSA9IGVudHJ5TWFwLmdldChjdXJyZW50SWQpO1xuXHRcdFx0aWYgKCFub2RlKSBicmVhaztcblx0XHRcdGN1cnJlbnRJZCA9IG5vZGUubm9kZS5lbnRyeS5wYXJlbnRJZCA/PyBudWxsO1xuXHRcdH1cblxuXHRcdC8vIEZhbGxiYWNrOiBsYXN0IHZpc2libGUgZW50cnlcblx0XHRyZXR1cm4gdGhpcy5maWx0ZXJlZE5vZGVzLmxlbmd0aCAtIDE7XG5cdH1cblxuXHQvKiogQnVpbGQgdGhlIHNldCBvZiBlbnRyeSBJRHMgb24gdGhlIHBhdGggZnJvbSByb290IHRvIGN1cnJlbnQgbGVhZiAqL1xuXHRwcml2YXRlIGJ1aWxkQWN0aXZlUGF0aCgpOiB2b2lkIHtcblx0XHR0aGlzLmFjdGl2ZVBhdGhJZHMuY2xlYXIoKTtcblx0XHRpZiAoIXRoaXMuY3VycmVudExlYWZJZCkgcmV0dXJuO1xuXG5cdFx0Ly8gQnVpbGQgYSBtYXAgb2YgaWQgLT4gZW50cnkgZm9yIHBhcmVudCBsb29rdXBcblx0XHRjb25zdCBlbnRyeU1hcCA9IG5ldyBNYXA8c3RyaW5nLCBGbGF0Tm9kZT4oKTtcblx0XHRmb3IgKGNvbnN0IGZsYXROb2RlIG9mIHRoaXMuZmxhdE5vZGVzKSB7XG5cdFx0XHRlbnRyeU1hcC5zZXQoZmxhdE5vZGUubm9kZS5lbnRyeS5pZCwgZmxhdE5vZGUpO1xuXHRcdH1cblxuXHRcdC8vIFdhbGsgZnJvbSBsZWFmIHRvIHJvb3Rcblx0XHRsZXQgY3VycmVudElkOiBzdHJpbmcgfCBudWxsID0gdGhpcy5jdXJyZW50TGVhZklkO1xuXHRcdHdoaWxlIChjdXJyZW50SWQpIHtcblx0XHRcdHRoaXMuYWN0aXZlUGF0aElkcy5hZGQoY3VycmVudElkKTtcblx0XHRcdGNvbnN0IG5vZGUgPSBlbnRyeU1hcC5nZXQoY3VycmVudElkKTtcblx0XHRcdGlmICghbm9kZSkgYnJlYWs7XG5cdFx0XHRjdXJyZW50SWQgPSBub2RlLm5vZGUuZW50cnkucGFyZW50SWQgPz8gbnVsbDtcblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIGZsYXR0ZW5UcmVlKHJvb3RzOiBTZXNzaW9uVHJlZU5vZGVbXSk6IEZsYXROb2RlW10ge1xuXHRcdGNvbnN0IHJlc3VsdDogRmxhdE5vZGVbXSA9IFtdO1xuXHRcdHRoaXMudG9vbENhbGxNYXAuY2xlYXIoKTtcblxuXHRcdC8vIEluZGVudGF0aW9uIHJ1bGVzOlxuXHRcdC8vIC0gQXQgaW5kZW50IDA6IHN0YXkgYXQgMCB1bmxlc3MgcGFyZW50IGhhcyA+MSBjaGlsZHJlbiAodGhlbiArMSlcblx0XHQvLyAtIEF0IGluZGVudCAxOiBjaGlsZHJlbiBhbHdheXMgZ28gdG8gaW5kZW50IDIgKHZpc3VhbCBncm91cGluZyBvZiBzdWJ0cmVlKVxuXHRcdC8vIC0gQXQgaW5kZW50IDIrOiBzdGF5IGZsYXQgZm9yIHNpbmdsZS1jaGlsZCBjaGFpbnMsICsxIG9ubHkgaWYgcGFyZW50IGJyYW5jaGVzXG5cblx0XHQvLyBTdGFjayBpdGVtczogW25vZGUsIGluZGVudCwganVzdEJyYW5jaGVkLCBzaG93Q29ubmVjdG9yLCBpc0xhc3QsIGd1dHRlcnMsIGlzVmlydHVhbFJvb3RDaGlsZF1cblx0XHR0eXBlIFN0YWNrSXRlbSA9IFtTZXNzaW9uVHJlZU5vZGUsIG51bWJlciwgYm9vbGVhbiwgYm9vbGVhbiwgYm9vbGVhbiwgR3V0dGVySW5mb1tdLCBib29sZWFuXTtcblx0XHRjb25zdCBzdGFjazogU3RhY2tJdGVtW10gPSBbXTtcblxuXHRcdC8vIERldGVybWluZSB3aGljaCBzdWJ0cmVlcyBjb250YWluIHRoZSBhY3RpdmUgbGVhZiAodG8gc29ydCBjdXJyZW50IGJyYW5jaCBmaXJzdClcblx0XHQvLyBVc2UgaXRlcmF0aXZlIHBvc3Qtb3JkZXIgdHJhdmVyc2FsIHRvIGF2b2lkIHN0YWNrIG92ZXJmbG93XG5cdFx0Y29uc3QgY29udGFpbnNBY3RpdmUgPSBuZXcgTWFwPFNlc3Npb25UcmVlTm9kZSwgYm9vbGVhbj4oKTtcblx0XHRjb25zdCBsZWFmSWQgPSB0aGlzLmN1cnJlbnRMZWFmSWQ7XG5cdFx0e1xuXHRcdFx0Ly8gQnVpbGQgbGlzdCBpbiBwcmUtb3JkZXIsIHRoZW4gcHJvY2VzcyBpbiByZXZlcnNlIGZvciBwb3N0LW9yZGVyIGVmZmVjdFxuXHRcdFx0Y29uc3QgYWxsTm9kZXM6IFNlc3Npb25UcmVlTm9kZVtdID0gW107XG5cdFx0XHRjb25zdCBwcmVPcmRlclN0YWNrOiBTZXNzaW9uVHJlZU5vZGVbXSA9IFsuLi5yb290c107XG5cdFx0XHR3aGlsZSAocHJlT3JkZXJTdGFjay5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdGNvbnN0IG5vZGUgPSBwcmVPcmRlclN0YWNrLnBvcCgpITtcblx0XHRcdFx0YWxsTm9kZXMucHVzaChub2RlKTtcblx0XHRcdFx0Ly8gUHVzaCBjaGlsZHJlbiBpbiByZXZlcnNlIHNvIHRoZXkncmUgcHJvY2Vzc2VkIGxlZnQtdG8tcmlnaHRcblx0XHRcdFx0Zm9yIChsZXQgaSA9IG5vZGUuY2hpbGRyZW4ubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHtcblx0XHRcdFx0XHRwcmVPcmRlclN0YWNrLnB1c2gobm9kZS5jaGlsZHJlbltpXSk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHRcdC8vIFByb2Nlc3MgaW4gcmV2ZXJzZSAocG9zdC1vcmRlcik6IGNoaWxkcmVuIGJlZm9yZSBwYXJlbnRzXG5cdFx0XHRmb3IgKGxldCBpID0gYWxsTm9kZXMubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHtcblx0XHRcdFx0Y29uc3Qgbm9kZSA9IGFsbE5vZGVzW2ldO1xuXHRcdFx0XHRsZXQgaGFzID0gbGVhZklkICE9PSBudWxsICYmIG5vZGUuZW50cnkuaWQgPT09IGxlYWZJZDtcblx0XHRcdFx0Zm9yIChjb25zdCBjaGlsZCBvZiBub2RlLmNoaWxkcmVuKSB7XG5cdFx0XHRcdFx0aWYgKGNvbnRhaW5zQWN0aXZlLmdldChjaGlsZCkpIHtcblx0XHRcdFx0XHRcdGhhcyA9IHRydWU7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHRcdGNvbnRhaW5zQWN0aXZlLnNldChub2RlLCBoYXMpO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdC8vIEFkZCByb290cyBpbiByZXZlcnNlIG9yZGVyLCBwcmlvcml0aXppbmcgdGhlIG9uZSBjb250YWluaW5nIHRoZSBhY3RpdmUgbGVhZlxuXHRcdC8vIElmIG11bHRpcGxlIHJvb3RzLCB0cmVhdCB0aGVtIGFzIGNoaWxkcmVuIG9mIGEgdmlydHVhbCByb290IHRoYXQgYnJhbmNoZXNcblx0XHRjb25zdCBtdWx0aXBsZVJvb3RzID0gcm9vdHMubGVuZ3RoID4gMTtcblx0XHRjb25zdCBvcmRlcmVkUm9vdHMgPSBbLi4ucm9vdHNdLnNvcnQoKGEsIGIpID0+IE51bWJlcihjb250YWluc0FjdGl2ZS5nZXQoYikpIC0gTnVtYmVyKGNvbnRhaW5zQWN0aXZlLmdldChhKSkpO1xuXHRcdGZvciAobGV0IGkgPSBvcmRlcmVkUm9vdHMubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHtcblx0XHRcdGNvbnN0IGlzTGFzdCA9IGkgPT09IG9yZGVyZWRSb290cy5sZW5ndGggLSAxO1xuXHRcdFx0c3RhY2sucHVzaChbb3JkZXJlZFJvb3RzW2ldLCBtdWx0aXBsZVJvb3RzID8gMSA6IDAsIG11bHRpcGxlUm9vdHMsIG11bHRpcGxlUm9vdHMsIGlzTGFzdCwgW10sIG11bHRpcGxlUm9vdHNdKTtcblx0XHR9XG5cblx0XHR3aGlsZSAoc3RhY2subGVuZ3RoID4gMCkge1xuXHRcdFx0Y29uc3QgW25vZGUsIGluZGVudCwganVzdEJyYW5jaGVkLCBzaG93Q29ubmVjdG9yLCBpc0xhc3QsIGd1dHRlcnMsIGlzVmlydHVhbFJvb3RDaGlsZF0gPSBzdGFjay5wb3AoKSE7XG5cblx0XHRcdC8vIEV4dHJhY3QgdG9vbCBjYWxscyBmcm9tIGFzc2lzdGFudCBtZXNzYWdlcyBmb3IgbGF0ZXIgbG9va3VwXG5cdFx0XHRjb25zdCBlbnRyeSA9IG5vZGUuZW50cnk7XG5cdFx0XHRpZiAoZW50cnkudHlwZSA9PT0gXCJtZXNzYWdlXCIgJiYgZW50cnkubWVzc2FnZS5yb2xlID09PSBcImFzc2lzdGFudFwiKSB7XG5cdFx0XHRcdGNvbnN0IGNvbnRlbnQgPSAoZW50cnkubWVzc2FnZSBhcyB7IGNvbnRlbnQ/OiB1bmtub3duIH0pLmNvbnRlbnQ7XG5cdFx0XHRcdGlmIChBcnJheS5pc0FycmF5KGNvbnRlbnQpKSB7XG5cdFx0XHRcdFx0Zm9yIChjb25zdCBibG9jayBvZiBjb250ZW50KSB7XG5cdFx0XHRcdFx0XHRpZiAodHlwZW9mIGJsb2NrID09PSBcIm9iamVjdFwiICYmIGJsb2NrICE9PSBudWxsICYmIFwidHlwZVwiIGluIGJsb2NrICYmIGJsb2NrLnR5cGUgPT09IFwidG9vbENhbGxcIikge1xuXHRcdFx0XHRcdFx0XHRjb25zdCB0YyA9IGJsb2NrIGFzIHsgaWQ6IHN0cmluZzsgbmFtZTogc3RyaW5nOyBhcmd1bWVudHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IH07XG5cdFx0XHRcdFx0XHRcdHRoaXMudG9vbENhbGxNYXAuc2V0KHRjLmlkLCB7IG5hbWU6IHRjLm5hbWUsIGFyZ3VtZW50czogdGMuYXJndW1lbnRzIH0pO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHRyZXN1bHQucHVzaCh7IG5vZGUsIGluZGVudCwgc2hvd0Nvbm5lY3RvciwgaXNMYXN0LCBndXR0ZXJzLCBpc1ZpcnR1YWxSb290Q2hpbGQgfSk7XG5cblx0XHRcdGNvbnN0IGNoaWxkcmVuID0gbm9kZS5jaGlsZHJlbjtcblx0XHRcdGNvbnN0IG11bHRpcGxlQ2hpbGRyZW4gPSBjaGlsZHJlbi5sZW5ndGggPiAxO1xuXG5cdFx0XHQvLyBPcmRlciBjaGlsZHJlbiBzbyB0aGUgYnJhbmNoIGNvbnRhaW5pbmcgdGhlIGFjdGl2ZSBsZWFmIGNvbWVzIGZpcnN0XG5cdFx0XHRjb25zdCBvcmRlcmVkQ2hpbGRyZW4gPSAoKCkgPT4ge1xuXHRcdFx0XHRjb25zdCBwcmlvcml0aXplZDogU2Vzc2lvblRyZWVOb2RlW10gPSBbXTtcblx0XHRcdFx0Y29uc3QgcmVzdDogU2Vzc2lvblRyZWVOb2RlW10gPSBbXTtcblx0XHRcdFx0Zm9yIChjb25zdCBjaGlsZCBvZiBjaGlsZHJlbikge1xuXHRcdFx0XHRcdGlmIChjb250YWluc0FjdGl2ZS5nZXQoY2hpbGQpKSB7XG5cdFx0XHRcdFx0XHRwcmlvcml0aXplZC5wdXNoKGNoaWxkKTtcblx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0cmVzdC5wdXNoKGNoaWxkKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblx0XHRcdFx0cmV0dXJuIFsuLi5wcmlvcml0aXplZCwgLi4ucmVzdF07XG5cdFx0XHR9KSgpO1xuXG5cdFx0XHQvLyBDYWxjdWxhdGUgY2hpbGQgaW5kZW50XG5cdFx0XHRsZXQgY2hpbGRJbmRlbnQ6IG51bWJlcjtcblx0XHRcdGlmIChtdWx0aXBsZUNoaWxkcmVuKSB7XG5cdFx0XHRcdC8vIFBhcmVudCBicmFuY2hlczogY2hpbGRyZW4gZ2V0ICsxXG5cdFx0XHRcdGNoaWxkSW5kZW50ID0gaW5kZW50ICsgMTtcblx0XHRcdH0gZWxzZSBpZiAoanVzdEJyYW5jaGVkICYmIGluZGVudCA+IDApIHtcblx0XHRcdFx0Ly8gRmlyc3QgZ2VuZXJhdGlvbiBhZnRlciBhIGJyYW5jaDogKzEgZm9yIHZpc3VhbCBncm91cGluZ1xuXHRcdFx0XHRjaGlsZEluZGVudCA9IGluZGVudCArIDE7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHQvLyBTaW5nbGUtY2hpbGQgY2hhaW46IHN0YXkgZmxhdFxuXHRcdFx0XHRjaGlsZEluZGVudCA9IGluZGVudDtcblx0XHRcdH1cblxuXHRcdFx0Ly8gQnVpbGQgZ3V0dGVycyBmb3IgY2hpbGRyZW5cblx0XHRcdC8vIElmIHRoaXMgbm9kZSBzaG93ZWQgYSBjb25uZWN0b3IsIGFkZCBhIGd1dHRlciBlbnRyeSBmb3IgZGVzY2VuZGFudHNcblx0XHRcdC8vIE9ubHkgYWRkIGd1dHRlciBpZiBjb25uZWN0b3IgaXMgYWN0dWFsbHkgZGlzcGxheWVkIChub3Qgc3VwcHJlc3NlZCBmb3IgdmlydHVhbCByb290IGNoaWxkcmVuKVxuXHRcdFx0Y29uc3QgY29ubmVjdG9yRGlzcGxheWVkID0gc2hvd0Nvbm5lY3RvciAmJiAhaXNWaXJ0dWFsUm9vdENoaWxkO1xuXHRcdFx0Ly8gV2hlbiBjb25uZWN0b3IgaXMgZGlzcGxheWVkLCBhZGQgYSBndXR0ZXIgZW50cnkgYXQgdGhlIGNvbm5lY3RvcidzIHBvc2l0aW9uXG5cdFx0XHQvLyBDb25uZWN0b3IgaXMgYXQgcG9zaXRpb24gKGRpc3BsYXlJbmRlbnQgLSAxKSwgc28gZ3V0dGVyIHNob3VsZCBiZSB0aGVyZSB0b29cblx0XHRcdGNvbnN0IGN1cnJlbnREaXNwbGF5SW5kZW50ID0gdGhpcy5tdWx0aXBsZVJvb3RzID8gTWF0aC5tYXgoMCwgaW5kZW50IC0gMSkgOiBpbmRlbnQ7XG5cdFx0XHRjb25zdCBjb25uZWN0b3JQb3NpdGlvbiA9IE1hdGgubWF4KDAsIGN1cnJlbnREaXNwbGF5SW5kZW50IC0gMSk7XG5cdFx0XHRjb25zdCBjaGlsZEd1dHRlcnM6IEd1dHRlckluZm9bXSA9IGNvbm5lY3RvckRpc3BsYXllZFxuXHRcdFx0XHQ/IFsuLi5ndXR0ZXJzLCB7IHBvc2l0aW9uOiBjb25uZWN0b3JQb3NpdGlvbiwgc2hvdzogIWlzTGFzdCB9XVxuXHRcdFx0XHQ6IGd1dHRlcnM7XG5cblx0XHRcdC8vIEFkZCBjaGlsZHJlbiBpbiByZXZlcnNlIG9yZGVyXG5cdFx0XHRmb3IgKGxldCBpID0gb3JkZXJlZENoaWxkcmVuLmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7XG5cdFx0XHRcdGNvbnN0IGNoaWxkSXNMYXN0ID0gaSA9PT0gb3JkZXJlZENoaWxkcmVuLmxlbmd0aCAtIDE7XG5cdFx0XHRcdHN0YWNrLnB1c2goW1xuXHRcdFx0XHRcdG9yZGVyZWRDaGlsZHJlbltpXSxcblx0XHRcdFx0XHRjaGlsZEluZGVudCxcblx0XHRcdFx0XHRtdWx0aXBsZUNoaWxkcmVuLFxuXHRcdFx0XHRcdG11bHRpcGxlQ2hpbGRyZW4sXG5cdFx0XHRcdFx0Y2hpbGRJc0xhc3QsXG5cdFx0XHRcdFx0Y2hpbGRHdXR0ZXJzLFxuXHRcdFx0XHRcdGZhbHNlLFxuXHRcdFx0XHRdKTtcblx0XHRcdH1cblx0XHR9XG5cblx0XHRyZXR1cm4gcmVzdWx0O1xuXHR9XG5cblx0cHJpdmF0ZSBhcHBseUZpbHRlcigpOiB2b2lkIHtcblx0XHQvLyBVcGRhdGUgbGFzdFNlbGVjdGVkSWQgb25seSB3aGVuIHdlIGhhdmUgYSB2YWxpZCBzZWxlY3Rpb24gKG5vbi1lbXB0eSBsaXN0KVxuXHRcdC8vIFRoaXMgcHJlc2VydmVzIHRoZSBzZWxlY3Rpb24gd2hlbiBzd2l0Y2hpbmcgdGhyb3VnaCBlbXB0eSBmaWx0ZXIgcmVzdWx0c1xuXHRcdGlmICh0aGlzLmZpbHRlcmVkTm9kZXMubGVuZ3RoID4gMCkge1xuXHRcdFx0dGhpcy5sYXN0U2VsZWN0ZWRJZCA9IHRoaXMuZmlsdGVyZWROb2Rlc1t0aGlzLnNlbGVjdGVkSW5kZXhdPy5ub2RlLmVudHJ5LmlkID8/IHRoaXMubGFzdFNlbGVjdGVkSWQ7XG5cdFx0fVxuXG5cdFx0Y29uc3Qgc2VhcmNoVG9rZW5zID0gdGhpcy5zZWFyY2hRdWVyeS50b0xvd2VyQ2FzZSgpLnNwbGl0KC9cXHMrLykuZmlsdGVyKEJvb2xlYW4pO1xuXG5cdFx0dGhpcy5maWx0ZXJlZE5vZGVzID0gdGhpcy5mbGF0Tm9kZXMuZmlsdGVyKChmbGF0Tm9kZSkgPT4ge1xuXHRcdFx0Y29uc3QgZW50cnkgPSBmbGF0Tm9kZS5ub2RlLmVudHJ5O1xuXHRcdFx0Y29uc3QgaXNDdXJyZW50TGVhZiA9IGVudHJ5LmlkID09PSB0aGlzLmN1cnJlbnRMZWFmSWQ7XG5cblx0XHRcdC8vIFNraXAgYXNzaXN0YW50IG1lc3NhZ2VzIHdpdGggb25seSB0b29sIGNhbGxzIChubyB0ZXh0KSB1bmxlc3MgZXJyb3IvYWJvcnRlZFxuXHRcdFx0Ly8gQWx3YXlzIHNob3cgY3VycmVudCBsZWFmIHNvIGFjdGl2ZSBwb3NpdGlvbiBpcyB2aXNpYmxlXG5cdFx0XHRpZiAoZW50cnkudHlwZSA9PT0gXCJtZXNzYWdlXCIgJiYgZW50cnkubWVzc2FnZS5yb2xlID09PSBcImFzc2lzdGFudFwiICYmICFpc0N1cnJlbnRMZWFmKSB7XG5cdFx0XHRcdGNvbnN0IG1zZyA9IGVudHJ5Lm1lc3NhZ2UgYXMgeyBzdG9wUmVhc29uPzogc3RyaW5nOyBjb250ZW50PzogdW5rbm93biB9O1xuXHRcdFx0XHRjb25zdCBoYXNUZXh0ID0gdGhpcy5oYXNUZXh0Q29udGVudChtc2cuY29udGVudCk7XG5cdFx0XHRcdGNvbnN0IGlzRXJyb3JPckFib3J0ZWQgPSBtc2cuc3RvcFJlYXNvbiAmJiBtc2cuc3RvcFJlYXNvbiAhPT0gXCJzdG9wXCIgJiYgbXNnLnN0b3BSZWFzb24gIT09IFwidG9vbFVzZVwiO1xuXHRcdFx0XHQvLyBPbmx5IGhpZGUgaWYgbm8gdGV4dCBBTkQgbm90IGFuIGVycm9yL2Fib3J0ZWQgbWVzc2FnZVxuXHRcdFx0XHRpZiAoIWhhc1RleHQgJiYgIWlzRXJyb3JPckFib3J0ZWQpIHtcblx0XHRcdFx0XHRyZXR1cm4gZmFsc2U7XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0Ly8gQXBwbHkgZmlsdGVyIG1vZGVcblx0XHRcdGxldCBwYXNzZXNGaWx0ZXIgPSB0cnVlO1xuXHRcdFx0Ly8gRW50cnkgdHlwZXMgaGlkZGVuIGluIGRlZmF1bHQgdmlldyAoc2V0dGluZ3MvYm9va2tlZXBpbmcpXG5cdFx0XHRjb25zdCBpc1NldHRpbmdzRW50cnkgPVxuXHRcdFx0XHRlbnRyeS50eXBlID09PSBcImxhYmVsXCIgfHxcblx0XHRcdFx0ZW50cnkudHlwZSA9PT0gXCJjdXN0b21cIiB8fFxuXHRcdFx0XHRlbnRyeS50eXBlID09PSBcIm1vZGVsX2NoYW5nZVwiIHx8XG5cdFx0XHRcdGVudHJ5LnR5cGUgPT09IFwidGhpbmtpbmdfbGV2ZWxfY2hhbmdlXCI7XG5cblx0XHRcdHN3aXRjaCAodGhpcy5maWx0ZXJNb2RlKSB7XG5cdFx0XHRcdGNhc2UgXCJ1c2VyLW9ubHlcIjpcblx0XHRcdFx0XHQvLyBKdXN0IHVzZXIgbWVzc2FnZXNcblx0XHRcdFx0XHRwYXNzZXNGaWx0ZXIgPSBlbnRyeS50eXBlID09PSBcIm1lc3NhZ2VcIiAmJiBlbnRyeS5tZXNzYWdlLnJvbGUgPT09IFwidXNlclwiO1xuXHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRjYXNlIFwibm8tdG9vbHNcIjpcblx0XHRcdFx0XHQvLyBEZWZhdWx0IG1pbnVzIHRvb2wgcmVzdWx0c1xuXHRcdFx0XHRcdHBhc3Nlc0ZpbHRlciA9ICFpc1NldHRpbmdzRW50cnkgJiYgIShlbnRyeS50eXBlID09PSBcIm1lc3NhZ2VcIiAmJiBlbnRyeS5tZXNzYWdlLnJvbGUgPT09IFwidG9vbFJlc3VsdFwiKTtcblx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0Y2FzZSBcImxhYmVsZWQtb25seVwiOlxuXHRcdFx0XHRcdC8vIEp1c3QgbGFiZWxlZCBlbnRyaWVzXG5cdFx0XHRcdFx0cGFzc2VzRmlsdGVyID0gZmxhdE5vZGUubm9kZS5sYWJlbCAhPT0gdW5kZWZpbmVkO1xuXHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRjYXNlIFwiYWxsXCI6XG5cdFx0XHRcdFx0Ly8gU2hvdyBldmVyeXRoaW5nXG5cdFx0XHRcdFx0cGFzc2VzRmlsdGVyID0gdHJ1ZTtcblx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0ZGVmYXVsdDpcblx0XHRcdFx0XHQvLyBEZWZhdWx0IG1vZGU6IGhpZGUgc2V0dGluZ3MvYm9va2tlZXBpbmcgZW50cmllc1xuXHRcdFx0XHRcdHBhc3Nlc0ZpbHRlciA9ICFpc1NldHRpbmdzRW50cnk7XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHR9XG5cblx0XHRcdGlmICghcGFzc2VzRmlsdGVyKSByZXR1cm4gZmFsc2U7XG5cblx0XHRcdC8vIEFwcGx5IHNlYXJjaCBmaWx0ZXJcblx0XHRcdGlmIChzZWFyY2hUb2tlbnMubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRjb25zdCBub2RlVGV4dCA9IHRoaXMuZ2V0U2VhcmNoYWJsZVRleHQoZmxhdE5vZGUubm9kZSkudG9Mb3dlckNhc2UoKTtcblx0XHRcdFx0cmV0dXJuIHNlYXJjaFRva2Vucy5ldmVyeSgodG9rZW4pID0+IG5vZGVUZXh0LmluY2x1ZGVzKHRva2VuKSk7XG5cdFx0XHR9XG5cblx0XHRcdHJldHVybiB0cnVlO1xuXHRcdH0pO1xuXG5cdFx0Ly8gRmlsdGVyIG91dCBkZXNjZW5kYW50cyBvZiBmb2xkZWQgbm9kZXMuXG5cdFx0aWYgKHRoaXMuZm9sZGVkTm9kZXMuc2l6ZSA+IDApIHtcblx0XHRcdGNvbnN0IHNraXBTZXQgPSBuZXcgU2V0PHN0cmluZz4oKTtcblx0XHRcdGZvciAoY29uc3QgZmxhdE5vZGUgb2YgdGhpcy5mbGF0Tm9kZXMpIHtcblx0XHRcdFx0Y29uc3QgeyBpZCwgcGFyZW50SWQgfSA9IGZsYXROb2RlLm5vZGUuZW50cnk7XG5cdFx0XHRcdGlmIChwYXJlbnRJZCAhPSBudWxsICYmICh0aGlzLmZvbGRlZE5vZGVzLmhhcyhwYXJlbnRJZCkgfHwgc2tpcFNldC5oYXMocGFyZW50SWQpKSkge1xuXHRcdFx0XHRcdHNraXBTZXQuYWRkKGlkKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdFx0dGhpcy5maWx0ZXJlZE5vZGVzID0gdGhpcy5maWx0ZXJlZE5vZGVzLmZpbHRlcigoZmxhdE5vZGUpID0+ICFza2lwU2V0LmhhcyhmbGF0Tm9kZS5ub2RlLmVudHJ5LmlkKSk7XG5cdFx0fVxuXG5cdFx0Ly8gUmVjYWxjdWxhdGUgdmlzdWFsIHN0cnVjdHVyZSAoaW5kZW50LCBjb25uZWN0b3JzLCBndXR0ZXJzKSBiYXNlZCBvbiB2aXNpYmxlIHRyZWVcblx0XHR0aGlzLnJlY2FsY3VsYXRlVmlzdWFsU3RydWN0dXJlKCk7XG5cblx0XHQvLyBUcnkgdG8gcHJlc2VydmUgY3Vyc29yIG9uIHRoZSBzYW1lIG5vZGUsIG9yIGZpbmQgbmVhcmVzdCB2aXNpYmxlIGFuY2VzdG9yXG5cdFx0aWYgKHRoaXMubGFzdFNlbGVjdGVkSWQpIHtcblx0XHRcdHRoaXMuc2VsZWN0ZWRJbmRleCA9IHRoaXMuZmluZE5lYXJlc3RWaXNpYmxlSW5kZXgodGhpcy5sYXN0U2VsZWN0ZWRJZCk7XG5cdFx0fSBlbHNlIGlmICh0aGlzLnNlbGVjdGVkSW5kZXggPj0gdGhpcy5maWx0ZXJlZE5vZGVzLmxlbmd0aCkge1xuXHRcdFx0Ly8gQ2xhbXAgaW5kZXggaWYgb3V0IG9mIGJvdW5kc1xuXHRcdFx0dGhpcy5zZWxlY3RlZEluZGV4ID0gTWF0aC5tYXgoMCwgdGhpcy5maWx0ZXJlZE5vZGVzLmxlbmd0aCAtIDEpO1xuXHRcdH1cblxuXHRcdC8vIFVwZGF0ZSBsYXN0U2VsZWN0ZWRJZCB0byB0aGUgYWN0dWFsIHNlbGVjdGlvbiAobWF5IGhhdmUgY2hhbmdlZCBkdWUgdG8gcGFyZW50IHdhbGspXG5cdFx0aWYgKHRoaXMuZmlsdGVyZWROb2Rlcy5sZW5ndGggPiAwKSB7XG5cdFx0XHR0aGlzLmxhc3RTZWxlY3RlZElkID0gdGhpcy5maWx0ZXJlZE5vZGVzW3RoaXMuc2VsZWN0ZWRJbmRleF0/Lm5vZGUuZW50cnkuaWQgPz8gdGhpcy5sYXN0U2VsZWN0ZWRJZDtcblx0XHR9XG5cdH1cblxuXHQvKipcblx0ICogUmVjb21wdXRlIGluZGVudGF0aW9uL2Nvbm5lY3RvcnMgZm9yIHRoZSBmaWx0ZXJlZCB2aWV3XG5cdCAqXG5cdCAqIEZpbHRlcmluZyBjYW4gaGlkZSBpbnRlcm1lZGlhdGUgZW50cmllczsgZGVzY2VuZGFudHMgYXR0YWNoIHRvIHRoZSBuZWFyZXN0IHZpc2libGUgYW5jZXN0b3IuXG5cdCAqIEtlZXAgaW5kZW50YXRpb24gc2VtYW50aWNzIGFsaWduZWQgd2l0aCBmbGF0dGVuVHJlZSgpIHNvIHNpbmdsZS1jaGlsZCBjaGFpbnMgZG9uJ3QgZHJpZnQgcmlnaHQuXG5cdCAqL1xuXHRwcml2YXRlIHJlY2FsY3VsYXRlVmlzdWFsU3RydWN0dXJlKCk6IHZvaWQge1xuXHRcdGlmICh0aGlzLmZpbHRlcmVkTm9kZXMubGVuZ3RoID09PSAwKSByZXR1cm47XG5cblx0XHRjb25zdCB2aXNpYmxlSWRzID0gbmV3IFNldCh0aGlzLmZpbHRlcmVkTm9kZXMubWFwKChuKSA9PiBuLm5vZGUuZW50cnkuaWQpKTtcblxuXHRcdC8vIEJ1aWxkIGVudHJ5IG1hcCBmb3IgZWZmaWNpZW50IHBhcmVudCBsb29rdXAgKHVzaW5nIGZ1bGwgdHJlZSlcblx0XHRjb25zdCBlbnRyeU1hcCA9IG5ldyBNYXA8c3RyaW5nLCBGbGF0Tm9kZT4oKTtcblx0XHRmb3IgKGNvbnN0IGZsYXROb2RlIG9mIHRoaXMuZmxhdE5vZGVzKSB7XG5cdFx0XHRlbnRyeU1hcC5zZXQoZmxhdE5vZGUubm9kZS5lbnRyeS5pZCwgZmxhdE5vZGUpO1xuXHRcdH1cblxuXHRcdC8vIEZpbmQgbmVhcmVzdCB2aXNpYmxlIGFuY2VzdG9yIGZvciBhIG5vZGVcblx0XHRjb25zdCBmaW5kVmlzaWJsZUFuY2VzdG9yID0gKG5vZGVJZDogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCA9PiB7XG5cdFx0XHRsZXQgY3VycmVudElkID0gZW50cnlNYXAuZ2V0KG5vZGVJZCk/Lm5vZGUuZW50cnkucGFyZW50SWQgPz8gbnVsbDtcblx0XHRcdHdoaWxlIChjdXJyZW50SWQgIT09IG51bGwpIHtcblx0XHRcdFx0aWYgKHZpc2libGVJZHMuaGFzKGN1cnJlbnRJZCkpIHtcblx0XHRcdFx0XHRyZXR1cm4gY3VycmVudElkO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGN1cnJlbnRJZCA9IGVudHJ5TWFwLmdldChjdXJyZW50SWQpPy5ub2RlLmVudHJ5LnBhcmVudElkID8/IG51bGw7XG5cdFx0XHR9XG5cdFx0XHRyZXR1cm4gbnVsbDtcblx0XHR9O1xuXG5cdFx0Ly8gQnVpbGQgdmlzaWJsZSB0cmVlIHN0cnVjdHVyZTpcblx0XHQvLyAtIHZpc2libGVQYXJlbnQ6IG5vZGVJZCBcdTIxOTIgbmVhcmVzdCB2aXNpYmxlIGFuY2VzdG9yIChvciBudWxsIGZvciByb290cylcblx0XHQvLyAtIHZpc2libGVDaGlsZHJlbjogcGFyZW50SWQgXHUyMTkyIGxpc3Qgb2YgdmlzaWJsZSBjaGlsZHJlbiAoaW4gZmlsdGVyZWROb2RlcyBvcmRlcilcblx0XHRjb25zdCB2aXNpYmxlUGFyZW50ID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZyB8IG51bGw+KCk7XG5cdFx0Y29uc3QgdmlzaWJsZUNoaWxkcmVuID0gbmV3IE1hcDxzdHJpbmcgfCBudWxsLCBzdHJpbmdbXT4oKTtcblx0XHR2aXNpYmxlQ2hpbGRyZW4uc2V0KG51bGwsIFtdKTsgLy8gcm9vdC1sZXZlbCBub2Rlc1xuXG5cdFx0Zm9yIChjb25zdCBmbGF0Tm9kZSBvZiB0aGlzLmZpbHRlcmVkTm9kZXMpIHtcblx0XHRcdGNvbnN0IG5vZGVJZCA9IGZsYXROb2RlLm5vZGUuZW50cnkuaWQ7XG5cdFx0XHRjb25zdCBhbmNlc3RvcklkID0gZmluZFZpc2libGVBbmNlc3Rvcihub2RlSWQpO1xuXHRcdFx0dmlzaWJsZVBhcmVudC5zZXQobm9kZUlkLCBhbmNlc3RvcklkKTtcblxuXHRcdFx0aWYgKCF2aXNpYmxlQ2hpbGRyZW4uaGFzKGFuY2VzdG9ySWQpKSB7XG5cdFx0XHRcdHZpc2libGVDaGlsZHJlbi5zZXQoYW5jZXN0b3JJZCwgW10pO1xuXHRcdFx0fVxuXHRcdFx0dmlzaWJsZUNoaWxkcmVuLmdldChhbmNlc3RvcklkKSEucHVzaChub2RlSWQpO1xuXHRcdH1cblxuXHRcdC8vIFVwZGF0ZSBtdWx0aXBsZVJvb3RzIGJhc2VkIG9uIHZpc2libGUgcm9vdHNcblx0XHRjb25zdCB2aXNpYmxlUm9vdElkcyA9IHZpc2libGVDaGlsZHJlbi5nZXQobnVsbCkhO1xuXHRcdHRoaXMubXVsdGlwbGVSb290cyA9IHZpc2libGVSb290SWRzLmxlbmd0aCA+IDE7XG5cblx0XHQvLyBCdWlsZCBhIG1hcCBmb3IgcXVpY2sgbG9va3VwOiBub2RlSWQgXHUyMTkyIEZsYXROb2RlXG5cdFx0Y29uc3QgZmlsdGVyZWROb2RlTWFwID0gbmV3IE1hcDxzdHJpbmcsIEZsYXROb2RlPigpO1xuXHRcdGZvciAoY29uc3QgZmxhdE5vZGUgb2YgdGhpcy5maWx0ZXJlZE5vZGVzKSB7XG5cdFx0XHRmaWx0ZXJlZE5vZGVNYXAuc2V0KGZsYXROb2RlLm5vZGUuZW50cnkuaWQsIGZsYXROb2RlKTtcblx0XHR9XG5cblx0XHQvLyBERlMgb3ZlciB0aGUgdmlzaWJsZSB0cmVlIHVzaW5nIGZsYXR0ZW5UcmVlKCkgaW5kZW50YXRpb24gc2VtYW50aWNzXG5cdFx0Ly8gU3RhY2sgaXRlbXM6IFtub2RlSWQsIGluZGVudCwganVzdEJyYW5jaGVkLCBzaG93Q29ubmVjdG9yLCBpc0xhc3QsIGd1dHRlcnMsIGlzVmlydHVhbFJvb3RDaGlsZF1cblx0XHR0eXBlIFN0YWNrSXRlbSA9IFtzdHJpbmcsIG51bWJlciwgYm9vbGVhbiwgYm9vbGVhbiwgYm9vbGVhbiwgR3V0dGVySW5mb1tdLCBib29sZWFuXTtcblx0XHRjb25zdCBzdGFjazogU3RhY2tJdGVtW10gPSBbXTtcblxuXHRcdC8vIEFkZCB2aXNpYmxlIHJvb3RzIGluIHJldmVyc2Ugb3JkZXIgKHRvIHByb2Nlc3MgaW4gZm9yd2FyZCBvcmRlciB2aWEgc3RhY2spXG5cdFx0Zm9yIChsZXQgaSA9IHZpc2libGVSb290SWRzLmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7XG5cdFx0XHRjb25zdCBpc0xhc3QgPSBpID09PSB2aXNpYmxlUm9vdElkcy5sZW5ndGggLSAxO1xuXHRcdFx0c3RhY2sucHVzaChbXG5cdFx0XHRcdHZpc2libGVSb290SWRzW2ldLFxuXHRcdFx0XHR0aGlzLm11bHRpcGxlUm9vdHMgPyAxIDogMCxcblx0XHRcdFx0dGhpcy5tdWx0aXBsZVJvb3RzLFxuXHRcdFx0XHR0aGlzLm11bHRpcGxlUm9vdHMsXG5cdFx0XHRcdGlzTGFzdCxcblx0XHRcdFx0W10sXG5cdFx0XHRcdHRoaXMubXVsdGlwbGVSb290cyxcblx0XHRcdF0pO1xuXHRcdH1cblxuXHRcdHdoaWxlIChzdGFjay5sZW5ndGggPiAwKSB7XG5cdFx0XHRjb25zdCBbbm9kZUlkLCBpbmRlbnQsIGp1c3RCcmFuY2hlZCwgc2hvd0Nvbm5lY3RvciwgaXNMYXN0LCBndXR0ZXJzLCBpc1ZpcnR1YWxSb290Q2hpbGRdID0gc3RhY2sucG9wKCkhO1xuXG5cdFx0XHRjb25zdCBmbGF0Tm9kZSA9IGZpbHRlcmVkTm9kZU1hcC5nZXQobm9kZUlkKTtcblx0XHRcdGlmICghZmxhdE5vZGUpIGNvbnRpbnVlO1xuXG5cdFx0XHQvLyBVcGRhdGUgdGhpcyBub2RlJ3MgdmlzdWFsIHByb3BlcnRpZXNcblx0XHRcdGZsYXROb2RlLmluZGVudCA9IGluZGVudDtcblx0XHRcdGZsYXROb2RlLnNob3dDb25uZWN0b3IgPSBzaG93Q29ubmVjdG9yO1xuXHRcdFx0ZmxhdE5vZGUuaXNMYXN0ID0gaXNMYXN0O1xuXHRcdFx0ZmxhdE5vZGUuZ3V0dGVycyA9IGd1dHRlcnM7XG5cdFx0XHRmbGF0Tm9kZS5pc1ZpcnR1YWxSb290Q2hpbGQgPSBpc1ZpcnR1YWxSb290Q2hpbGQ7XG5cblx0XHRcdC8vIEdldCB2aXNpYmxlIGNoaWxkcmVuIG9mIHRoaXMgbm9kZVxuXHRcdFx0Y29uc3QgY2hpbGRyZW4gPSB2aXNpYmxlQ2hpbGRyZW4uZ2V0KG5vZGVJZCkgfHwgW107XG5cdFx0XHRjb25zdCBtdWx0aXBsZUNoaWxkcmVuID0gY2hpbGRyZW4ubGVuZ3RoID4gMTtcblxuXHRcdFx0Ly8gQ2hpbGQgaW5kZW50IGZvbGxvd3MgZmxhdHRlblRyZWUoKTogYnJhbmNoIHBvaW50cyAoYW5kIGZpcnN0IGdlbmVyYXRpb24gYWZ0ZXIgYSBicmFuY2gpIHNoaWZ0ICsxXG5cdFx0XHRsZXQgY2hpbGRJbmRlbnQ6IG51bWJlcjtcblx0XHRcdGlmIChtdWx0aXBsZUNoaWxkcmVuKSB7XG5cdFx0XHRcdGNoaWxkSW5kZW50ID0gaW5kZW50ICsgMTtcblx0XHRcdH0gZWxzZSBpZiAoanVzdEJyYW5jaGVkICYmIGluZGVudCA+IDApIHtcblx0XHRcdFx0Y2hpbGRJbmRlbnQgPSBpbmRlbnQgKyAxO1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0Y2hpbGRJbmRlbnQgPSBpbmRlbnQ7XG5cdFx0XHR9XG5cblx0XHRcdC8vIENoaWxkIGd1dHRlcnMgZm9sbG93IGZsYXR0ZW5UcmVlKCkgY29ubmVjdG9yL2d1dHRlciBydWxlc1xuXHRcdFx0Y29uc3QgY29ubmVjdG9yRGlzcGxheWVkID0gc2hvd0Nvbm5lY3RvciAmJiAhaXNWaXJ0dWFsUm9vdENoaWxkO1xuXHRcdFx0Y29uc3QgY3VycmVudERpc3BsYXlJbmRlbnQgPSB0aGlzLm11bHRpcGxlUm9vdHMgPyBNYXRoLm1heCgwLCBpbmRlbnQgLSAxKSA6IGluZGVudDtcblx0XHRcdGNvbnN0IGNvbm5lY3RvclBvc2l0aW9uID0gTWF0aC5tYXgoMCwgY3VycmVudERpc3BsYXlJbmRlbnQgLSAxKTtcblx0XHRcdGNvbnN0IGNoaWxkR3V0dGVyczogR3V0dGVySW5mb1tdID0gY29ubmVjdG9yRGlzcGxheWVkXG5cdFx0XHRcdD8gWy4uLmd1dHRlcnMsIHsgcG9zaXRpb246IGNvbm5lY3RvclBvc2l0aW9uLCBzaG93OiAhaXNMYXN0IH1dXG5cdFx0XHRcdDogZ3V0dGVycztcblxuXHRcdFx0Ly8gQWRkIGNoaWxkcmVuIGluIHJldmVyc2Ugb3JkZXIgKHRvIHByb2Nlc3MgaW4gZm9yd2FyZCBvcmRlciB2aWEgc3RhY2spXG5cdFx0XHRmb3IgKGxldCBpID0gY2hpbGRyZW4ubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHtcblx0XHRcdFx0Y29uc3QgY2hpbGRJc0xhc3QgPSBpID09PSBjaGlsZHJlbi5sZW5ndGggLSAxO1xuXHRcdFx0XHRzdGFjay5wdXNoKFtcblx0XHRcdFx0XHRjaGlsZHJlbltpXSxcblx0XHRcdFx0XHRjaGlsZEluZGVudCxcblx0XHRcdFx0XHRtdWx0aXBsZUNoaWxkcmVuLFxuXHRcdFx0XHRcdG11bHRpcGxlQ2hpbGRyZW4sXG5cdFx0XHRcdFx0Y2hpbGRJc0xhc3QsXG5cdFx0XHRcdFx0Y2hpbGRHdXR0ZXJzLFxuXHRcdFx0XHRcdGZhbHNlLFxuXHRcdFx0XHRdKTtcblx0XHRcdH1cblx0XHR9XG5cblx0XHQvLyBTdG9yZSB2aXNpYmxlIHRyZWUgbWFwcyBmb3IgYW5jZXN0b3IvZGVzY2VuZGFudCBsb29rdXBzIGluIG5hdmlnYXRpb25cblx0XHR0aGlzLnZpc2libGVQYXJlbnRNYXAgPSB2aXNpYmxlUGFyZW50O1xuXHRcdHRoaXMudmlzaWJsZUNoaWxkcmVuTWFwID0gdmlzaWJsZUNoaWxkcmVuO1xuXHR9XG5cblx0LyoqIEdldCBzZWFyY2hhYmxlIHRleHQgY29udGVudCBmcm9tIGEgbm9kZSAqL1xuXHRwcml2YXRlIGdldFNlYXJjaGFibGVUZXh0KG5vZGU6IFNlc3Npb25UcmVlTm9kZSk6IHN0cmluZyB7XG5cdFx0Y29uc3QgZW50cnkgPSBub2RlLmVudHJ5O1xuXHRcdGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuXG5cdFx0aWYgKG5vZGUubGFiZWwpIHtcblx0XHRcdHBhcnRzLnB1c2gobm9kZS5sYWJlbCk7XG5cdFx0fVxuXG5cdFx0c3dpdGNoIChlbnRyeS50eXBlKSB7XG5cdFx0XHRjYXNlIFwibWVzc2FnZVwiOiB7XG5cdFx0XHRcdGNvbnN0IG1zZyA9IGVudHJ5Lm1lc3NhZ2U7XG5cdFx0XHRcdHBhcnRzLnB1c2gobXNnLnJvbGUpO1xuXHRcdFx0XHRpZiAoXCJjb250ZW50XCIgaW4gbXNnICYmIG1zZy5jb250ZW50KSB7XG5cdFx0XHRcdFx0cGFydHMucHVzaCh0aGlzLmV4dHJhY3RDb250ZW50KG1zZy5jb250ZW50KSk7XG5cdFx0XHRcdH1cblx0XHRcdFx0aWYgKG1zZy5yb2xlID09PSBcImJhc2hFeGVjdXRpb25cIikge1xuXHRcdFx0XHRcdGNvbnN0IGJhc2hNc2cgPSBtc2cgYXMgeyBjb21tYW5kPzogc3RyaW5nIH07XG5cdFx0XHRcdFx0aWYgKGJhc2hNc2cuY29tbWFuZCkgcGFydHMucHVzaChiYXNoTXNnLmNvbW1hbmQpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGJyZWFrO1xuXHRcdFx0fVxuXHRcdFx0Y2FzZSBcImN1c3RvbV9tZXNzYWdlXCI6IHtcblx0XHRcdFx0cGFydHMucHVzaChlbnRyeS5jdXN0b21UeXBlKTtcblx0XHRcdFx0aWYgKHR5cGVvZiBlbnRyeS5jb250ZW50ID09PSBcInN0cmluZ1wiKSB7XG5cdFx0XHRcdFx0cGFydHMucHVzaChlbnRyeS5jb250ZW50KTtcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRwYXJ0cy5wdXNoKHRoaXMuZXh0cmFjdENvbnRlbnQoZW50cnkuY29udGVudCkpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGJyZWFrO1xuXHRcdFx0fVxuXHRcdFx0Y2FzZSBcImNvbXBhY3Rpb25cIjpcblx0XHRcdFx0cGFydHMucHVzaChcImNvbXBhY3Rpb25cIik7XG5cdFx0XHRcdGJyZWFrO1xuXHRcdFx0Y2FzZSBcImJyYW5jaF9zdW1tYXJ5XCI6XG5cdFx0XHRcdHBhcnRzLnB1c2goXCJicmFuY2ggc3VtbWFyeVwiLCBlbnRyeS5zdW1tYXJ5KTtcblx0XHRcdFx0YnJlYWs7XG5cdFx0XHRjYXNlIFwibW9kZWxfY2hhbmdlXCI6XG5cdFx0XHRcdHBhcnRzLnB1c2goXCJtb2RlbFwiLCBlbnRyeS5tb2RlbElkKTtcblx0XHRcdFx0YnJlYWs7XG5cdFx0XHRjYXNlIFwidGhpbmtpbmdfbGV2ZWxfY2hhbmdlXCI6XG5cdFx0XHRcdHBhcnRzLnB1c2goXCJ0aGlua2luZ1wiLCBlbnRyeS50aGlua2luZ0xldmVsKTtcblx0XHRcdFx0YnJlYWs7XG5cdFx0XHRjYXNlIFwiY3VzdG9tXCI6XG5cdFx0XHRcdHBhcnRzLnB1c2goXCJjdXN0b21cIiwgZW50cnkuY3VzdG9tVHlwZSk7XG5cdFx0XHRcdGJyZWFrO1xuXHRcdFx0Y2FzZSBcImxhYmVsXCI6XG5cdFx0XHRcdHBhcnRzLnB1c2goXCJsYWJlbFwiLCBlbnRyeS5sYWJlbCA/PyBcIlwiKTtcblx0XHRcdFx0YnJlYWs7XG5cdFx0fVxuXG5cdFx0cmV0dXJuIHBhcnRzLmpvaW4oXCIgXCIpO1xuXHR9XG5cblx0aW52YWxpZGF0ZSgpOiB2b2lkIHt9XG5cblx0Z2V0U2VhcmNoUXVlcnkoKTogc3RyaW5nIHtcblx0XHRyZXR1cm4gdGhpcy5zZWFyY2hRdWVyeTtcblx0fVxuXG5cdGdldFNlbGVjdGVkTm9kZSgpOiBTZXNzaW9uVHJlZU5vZGUgfCB1bmRlZmluZWQge1xuXHRcdHJldHVybiB0aGlzLmZpbHRlcmVkTm9kZXNbdGhpcy5zZWxlY3RlZEluZGV4XT8ubm9kZTtcblx0fVxuXG5cdHVwZGF0ZU5vZGVMYWJlbChlbnRyeUlkOiBzdHJpbmcsIGxhYmVsOiBzdHJpbmcgfCB1bmRlZmluZWQpOiB2b2lkIHtcblx0XHRmb3IgKGNvbnN0IGZsYXROb2RlIG9mIHRoaXMuZmxhdE5vZGVzKSB7XG5cdFx0XHRpZiAoZmxhdE5vZGUubm9kZS5lbnRyeS5pZCA9PT0gZW50cnlJZCkge1xuXHRcdFx0XHRmbGF0Tm9kZS5ub2RlLmxhYmVsID0gbGFiZWw7XG5cdFx0XHRcdGJyZWFrO1xuXHRcdFx0fVxuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgZ2V0RmlsdGVyTGFiZWwoKTogc3RyaW5nIHtcblx0XHRzd2l0Y2ggKHRoaXMuZmlsdGVyTW9kZSkge1xuXHRcdFx0Y2FzZSBcIm5vLXRvb2xzXCI6XG5cdFx0XHRcdHJldHVybiBcIiBbbm8tdG9vbHNdXCI7XG5cdFx0XHRjYXNlIFwidXNlci1vbmx5XCI6XG5cdFx0XHRcdHJldHVybiBcIiBbdXNlcl1cIjtcblx0XHRcdGNhc2UgXCJsYWJlbGVkLW9ubHlcIjpcblx0XHRcdFx0cmV0dXJuIFwiIFtsYWJlbGVkXVwiO1xuXHRcdFx0Y2FzZSBcImFsbFwiOlxuXHRcdFx0XHRyZXR1cm4gXCIgW2FsbF1cIjtcblx0XHRcdGRlZmF1bHQ6XG5cdFx0XHRcdHJldHVybiBcIlwiO1xuXHRcdH1cblx0fVxuXG5cdHJlbmRlcih3aWR0aDogbnVtYmVyKTogc3RyaW5nW10ge1xuXHRcdGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuXG5cdFx0aWYgKHRoaXMuZmlsdGVyZWROb2Rlcy5sZW5ndGggPT09IDApIHtcblx0XHRcdGxpbmVzLnB1c2godHJ1bmNhdGVUb1dpZHRoKHRoZW1lLmZnKFwibXV0ZWRcIiwgXCIgIE5vIGVudHJpZXMgZm91bmRcIiksIHdpZHRoKSk7XG5cdFx0XHRsaW5lcy5wdXNoKHRydW5jYXRlVG9XaWR0aCh0aGVtZS5mZyhcIm11dGVkXCIsIGAgICgwLzApJHt0aGlzLmdldEZpbHRlckxhYmVsKCl9YCksIHdpZHRoKSk7XG5cdFx0XHRyZXR1cm4gbGluZXM7XG5cdFx0fVxuXG5cdFx0Y29uc3QgeyBzdGFydEluZGV4LCBlbmRJbmRleCB9ID0gY29tcHV0ZVNjcm9sbFdpbmRvdyhcblx0XHRcdHRoaXMuc2VsZWN0ZWRJbmRleCxcblx0XHRcdHRoaXMuZmlsdGVyZWROb2Rlcy5sZW5ndGgsXG5cdFx0XHR0aGlzLm1heFZpc2libGVMaW5lcyxcblx0XHQpO1xuXG5cdFx0Zm9yIChsZXQgaSA9IHN0YXJ0SW5kZXg7IGkgPCBlbmRJbmRleDsgaSsrKSB7XG5cdFx0XHRjb25zdCBmbGF0Tm9kZSA9IHRoaXMuZmlsdGVyZWROb2Rlc1tpXTtcblx0XHRcdGNvbnN0IGVudHJ5ID0gZmxhdE5vZGUubm9kZS5lbnRyeTtcblx0XHRcdGNvbnN0IGlzU2VsZWN0ZWQgPSBpID09PSB0aGlzLnNlbGVjdGVkSW5kZXg7XG5cblx0XHRcdC8vIEJ1aWxkIGxpbmU6IGN1cnNvciArIHByZWZpeCArIHBhdGggbWFya2VyICsgbGFiZWwgKyBjb250ZW50XG5cdFx0XHRjb25zdCBjdXJzb3IgPSByZW5kZXJDdXJzb3IoaXNTZWxlY3RlZCk7XG5cblx0XHRcdC8vIElmIG11bHRpcGxlIHJvb3RzLCBzaGlmdCBkaXNwbGF5IChyb290cyBhdCAwLCBub3QgMSlcblx0XHRcdGNvbnN0IGRpc3BsYXlJbmRlbnQgPSB0aGlzLm11bHRpcGxlUm9vdHMgPyBNYXRoLm1heCgwLCBmbGF0Tm9kZS5pbmRlbnQgLSAxKSA6IGZsYXROb2RlLmluZGVudDtcblxuXHRcdFx0Ly8gQnVpbGQgcHJlZml4IHdpdGggZ3V0dGVycyBhdCB0aGVpciBjb3JyZWN0IHBvc2l0aW9uc1xuXHRcdFx0Ly8gRWFjaCBndXR0ZXIgaGFzIGEgcG9zaXRpb24gKGRpc3BsYXlJbmRlbnQgd2hlcmUgaXRzIGNvbm5lY3RvciB3YXMgc2hvd24pXG5cdFx0XHRjb25zdCBjb25uZWN0b3IgPVxuXHRcdFx0XHRmbGF0Tm9kZS5zaG93Q29ubmVjdG9yICYmICFmbGF0Tm9kZS5pc1ZpcnR1YWxSb290Q2hpbGQgPyAoZmxhdE5vZGUuaXNMYXN0ID8gXCJcdTI1MTRcdTI1MDAgXCIgOiBcIlx1MjUxQ1x1MjUwMCBcIikgOiBcIlwiO1xuXHRcdFx0Y29uc3QgY29ubmVjdG9yUG9zaXRpb24gPSBjb25uZWN0b3IgPyBkaXNwbGF5SW5kZW50IC0gMSA6IC0xO1xuXG5cdFx0XHQvLyBCdWlsZCBwcmVmaXggY2hhciBieSBjaGFyLCBwbGFjaW5nIGd1dHRlcnMgYW5kIGNvbm5lY3RvciBhdCB0aGVpciBwb3NpdGlvbnNcblx0XHRcdGNvbnN0IHRvdGFsQ2hhcnMgPSBkaXNwbGF5SW5kZW50ICogMztcblx0XHRcdGNvbnN0IHByZWZpeENoYXJzOiBzdHJpbmdbXSA9IFtdO1xuXHRcdFx0Y29uc3QgaXNGb2xkZWQgPSB0aGlzLmZvbGRlZE5vZGVzLmhhcyhlbnRyeS5pZCk7XG5cdFx0XHRmb3IgKGxldCBpID0gMDsgaSA8IHRvdGFsQ2hhcnM7IGkrKykge1xuXHRcdFx0XHRjb25zdCBsZXZlbCA9IE1hdGguZmxvb3IoaSAvIDMpO1xuXHRcdFx0XHRjb25zdCBwb3NJbkxldmVsID0gaSAlIDM7XG5cblx0XHRcdFx0Ly8gQ2hlY2sgaWYgdGhlcmUncyBhIGd1dHRlciBhdCB0aGlzIGxldmVsXG5cdFx0XHRcdGNvbnN0IGd1dHRlciA9IGZsYXROb2RlLmd1dHRlcnMuZmluZCgoZykgPT4gZy5wb3NpdGlvbiA9PT0gbGV2ZWwpO1xuXHRcdFx0XHRpZiAoZ3V0dGVyKSB7XG5cdFx0XHRcdFx0aWYgKHBvc0luTGV2ZWwgPT09IDApIHtcblx0XHRcdFx0XHRcdHByZWZpeENoYXJzLnB1c2goZ3V0dGVyLnNob3cgPyBcIlx1MjUwMlwiIDogXCIgXCIpO1xuXHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHRwcmVmaXhDaGFycy5wdXNoKFwiIFwiKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH0gZWxzZSBpZiAoY29ubmVjdG9yICYmIGxldmVsID09PSBjb25uZWN0b3JQb3NpdGlvbikge1xuXHRcdFx0XHRcdC8vIENvbm5lY3RvciBhdCB0aGlzIGxldmVsLCB3aXRoIGZvbGQgaW5kaWNhdG9yXG5cdFx0XHRcdFx0aWYgKHBvc0luTGV2ZWwgPT09IDApIHtcblx0XHRcdFx0XHRcdHByZWZpeENoYXJzLnB1c2goZmxhdE5vZGUuaXNMYXN0ID8gXCJcdTI1MTRcIiA6IFwiXHUyNTFDXCIpO1xuXHRcdFx0XHRcdH0gZWxzZSBpZiAocG9zSW5MZXZlbCA9PT0gMSkge1xuXHRcdFx0XHRcdFx0Y29uc3QgZm9sZGFibGUgPSB0aGlzLmlzRm9sZGFibGUoZW50cnkuaWQpO1xuXHRcdFx0XHRcdFx0cHJlZml4Q2hhcnMucHVzaChpc0ZvbGRlZCA/IFwiXHUyMjlFXCIgOiBmb2xkYWJsZSA/IFwiXHUyMjlGXCIgOiBcIlx1MjUwMFwiKTtcblx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0cHJlZml4Q2hhcnMucHVzaChcIiBcIik7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdHByZWZpeENoYXJzLnB1c2goXCIgXCIpO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0XHRjb25zdCBwcmVmaXggPSBwcmVmaXhDaGFycy5qb2luKFwiXCIpO1xuXG5cdFx0XHQvLyBGb2xkIG1hcmtlciBmb3Igbm9kZXMgd2l0aG91dCBjb25uZWN0b3JzIChyb290cylcblx0XHRcdGNvbnN0IHNob3dzRm9sZEluQ29ubmVjdG9yID0gZmxhdE5vZGUuc2hvd0Nvbm5lY3RvciAmJiAhZmxhdE5vZGUuaXNWaXJ0dWFsUm9vdENoaWxkO1xuXHRcdFx0Y29uc3QgZm9sZE1hcmtlciA9IGlzRm9sZGVkICYmICFzaG93c0ZvbGRJbkNvbm5lY3RvciA/IHRoZW1lLmZnKFwiYWNjZW50XCIsIFwiXHUyMjlFIFwiKSA6IFwiXCI7XG5cblx0XHRcdC8vIEFjdGl2ZSBwYXRoIG1hcmtlciAtIHNob3duIHJpZ2h0IGJlZm9yZSB0aGUgZW50cnkgdGV4dFxuXHRcdFx0Y29uc3QgaXNPbkFjdGl2ZVBhdGggPSB0aGlzLmFjdGl2ZVBhdGhJZHMuaGFzKGVudHJ5LmlkKTtcblx0XHRcdGNvbnN0IHBhdGhNYXJrZXIgPSBpc09uQWN0aXZlUGF0aCA/IHRoZW1lLmZnKFwiYWNjZW50XCIsIFwiXHUyMDIyIFwiKSA6IFwiXCI7XG5cblx0XHRcdGNvbnN0IGxhYmVsID0gZmxhdE5vZGUubm9kZS5sYWJlbCA/IHRoZW1lLmZnKFwid2FybmluZ1wiLCBgWyR7ZmxhdE5vZGUubm9kZS5sYWJlbH1dIGApIDogXCJcIjtcblx0XHRcdGNvbnN0IGNvbnRlbnQgPSB0aGlzLmdldEVudHJ5RGlzcGxheVRleHQoZmxhdE5vZGUubm9kZSwgaXNTZWxlY3RlZCk7XG5cblx0XHRcdGNvbnN0IGxpbmUgPSBjdXJzb3IgKyB0aGVtZS5mZyhcImRpbVwiLCBwcmVmaXgpICsgZm9sZE1hcmtlciArIHBhdGhNYXJrZXIgKyBsYWJlbCArIGNvbnRlbnQ7XG5cdFx0XHRsaW5lcy5wdXNoKGFwcGx5Um93SGlnaGxpZ2h0KGxpbmUsIGlzU2VsZWN0ZWQsIHdpZHRoKSk7XG5cdFx0fVxuXG5cdFx0bGluZXMucHVzaChyZW5kZXJTY3JvbGxQb3NpdGlvbih0aGlzLnNlbGVjdGVkSW5kZXgsIHRoaXMuZmlsdGVyZWROb2Rlcy5sZW5ndGgsIHdpZHRoLCB0aGlzLmdldEZpbHRlckxhYmVsKCkpKTtcblxuXHRcdHJldHVybiBsaW5lcztcblx0fVxuXG5cdHByaXZhdGUgZ2V0RW50cnlEaXNwbGF5VGV4dChub2RlOiBTZXNzaW9uVHJlZU5vZGUsIGlzU2VsZWN0ZWQ6IGJvb2xlYW4pOiBzdHJpbmcge1xuXHRcdGNvbnN0IGVudHJ5ID0gbm9kZS5lbnRyeTtcblx0XHRsZXQgcmVzdWx0OiBzdHJpbmc7XG5cblx0XHRjb25zdCBub3JtYWxpemUgPSAoczogc3RyaW5nKSA9PiBzLnJlcGxhY2UoL1tcXG5cXHRdL2csIFwiIFwiKS50cmltKCk7XG5cblx0XHRzd2l0Y2ggKGVudHJ5LnR5cGUpIHtcblx0XHRcdGNhc2UgXCJtZXNzYWdlXCI6IHtcblx0XHRcdFx0Y29uc3QgbXNnID0gZW50cnkubWVzc2FnZTtcblx0XHRcdFx0Y29uc3Qgcm9sZSA9IG1zZy5yb2xlO1xuXHRcdFx0XHRpZiAocm9sZSA9PT0gXCJ1c2VyXCIpIHtcblx0XHRcdFx0XHRjb25zdCBtc2dXaXRoQ29udGVudCA9IG1zZyBhcyB7IGNvbnRlbnQ/OiB1bmtub3duIH07XG5cdFx0XHRcdFx0Y29uc3QgY29udGVudCA9IG5vcm1hbGl6ZSh0aGlzLmV4dHJhY3RDb250ZW50KG1zZ1dpdGhDb250ZW50LmNvbnRlbnQpKTtcblx0XHRcdFx0XHRyZXN1bHQgPSB0aGVtZS5mZyhcImFjY2VudFwiLCBcInVzZXI6IFwiKSArIGNvbnRlbnQ7XG5cdFx0XHRcdH0gZWxzZSBpZiAocm9sZSA9PT0gXCJhc3Npc3RhbnRcIikge1xuXHRcdFx0XHRcdGNvbnN0IG1zZ1dpdGhDb250ZW50ID0gbXNnIGFzIHsgY29udGVudD86IHVua25vd247IHN0b3BSZWFzb24/OiBzdHJpbmc7IGVycm9yTWVzc2FnZT86IHN0cmluZyB9O1xuXHRcdFx0XHRcdGNvbnN0IHRleHRDb250ZW50ID0gbm9ybWFsaXplKHRoaXMuZXh0cmFjdENvbnRlbnQobXNnV2l0aENvbnRlbnQuY29udGVudCkpO1xuXHRcdFx0XHRcdGlmICh0ZXh0Q29udGVudCkge1xuXHRcdFx0XHRcdFx0cmVzdWx0ID0gdGhlbWUuZmcoXCJzdWNjZXNzXCIsIFwiYXNzaXN0YW50OiBcIikgKyB0ZXh0Q29udGVudDtcblx0XHRcdFx0XHR9IGVsc2UgaWYgKG1zZ1dpdGhDb250ZW50LnN0b3BSZWFzb24gPT09IFwiYWJvcnRlZFwiKSB7XG5cdFx0XHRcdFx0XHRyZXN1bHQgPSB0aGVtZS5mZyhcInN1Y2Nlc3NcIiwgXCJhc3Npc3RhbnQ6IFwiKSArIHRoZW1lLmZnKFwibXV0ZWRcIiwgXCIoYWJvcnRlZClcIik7XG5cdFx0XHRcdFx0fSBlbHNlIGlmIChtc2dXaXRoQ29udGVudC5lcnJvck1lc3NhZ2UpIHtcblx0XHRcdFx0XHRcdGNvbnN0IGVyck1zZyA9IG5vcm1hbGl6ZShtc2dXaXRoQ29udGVudC5lcnJvck1lc3NhZ2UpLnNsaWNlKDAsIDgwKTtcblx0XHRcdFx0XHRcdHJlc3VsdCA9IHRoZW1lLmZnKFwic3VjY2Vzc1wiLCBcImFzc2lzdGFudDogXCIpICsgdGhlbWUuZmcoXCJlcnJvclwiLCBlcnJNc2cpO1xuXHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHRyZXN1bHQgPSB0aGVtZS5mZyhcInN1Y2Nlc3NcIiwgXCJhc3Npc3RhbnQ6IFwiKSArIHRoZW1lLmZnKFwibXV0ZWRcIiwgXCIobm8gY29udGVudClcIik7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9IGVsc2UgaWYgKHJvbGUgPT09IFwidG9vbFJlc3VsdFwiKSB7XG5cdFx0XHRcdFx0Y29uc3QgdG9vbE1zZyA9IG1zZyBhcyB7IHRvb2xDYWxsSWQ/OiBzdHJpbmc7IHRvb2xOYW1lPzogc3RyaW5nIH07XG5cdFx0XHRcdFx0Y29uc3QgdG9vbENhbGwgPSB0b29sTXNnLnRvb2xDYWxsSWQgPyB0aGlzLnRvb2xDYWxsTWFwLmdldCh0b29sTXNnLnRvb2xDYWxsSWQpIDogdW5kZWZpbmVkO1xuXHRcdFx0XHRcdGlmICh0b29sQ2FsbCkge1xuXHRcdFx0XHRcdFx0cmVzdWx0ID0gdGhlbWUuZmcoXCJtdXRlZFwiLCB0aGlzLmZvcm1hdFRvb2xDYWxsKHRvb2xDYWxsLm5hbWUsIHRvb2xDYWxsLmFyZ3VtZW50cykpO1xuXHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHRyZXN1bHQgPSB0aGVtZS5mZyhcIm11dGVkXCIsIGBbJHt0b29sTXNnLnRvb2xOYW1lID8/IFwidG9vbFwifV1gKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH0gZWxzZSBpZiAocm9sZSA9PT0gXCJiYXNoRXhlY3V0aW9uXCIpIHtcblx0XHRcdFx0XHRjb25zdCBiYXNoTXNnID0gbXNnIGFzIHsgY29tbWFuZD86IHN0cmluZyB9O1xuXHRcdFx0XHRcdHJlc3VsdCA9IHRoZW1lLmZnKFwiZGltXCIsIGBbYmFzaF06ICR7bm9ybWFsaXplKGJhc2hNc2cuY29tbWFuZCA/PyBcIlwiKX1gKTtcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRyZXN1bHQgPSB0aGVtZS5mZyhcImRpbVwiLCBgWyR7cm9sZX1dYCk7XG5cdFx0XHRcdH1cblx0XHRcdFx0YnJlYWs7XG5cdFx0XHR9XG5cdFx0XHRjYXNlIFwiY3VzdG9tX21lc3NhZ2VcIjoge1xuXHRcdFx0XHRjb25zdCBjb250ZW50ID1cblx0XHRcdFx0XHR0eXBlb2YgZW50cnkuY29udGVudCA9PT0gXCJzdHJpbmdcIlxuXHRcdFx0XHRcdFx0PyBlbnRyeS5jb250ZW50XG5cdFx0XHRcdFx0XHQ6IGVudHJ5LmNvbnRlbnRcblx0XHRcdFx0XHRcdFx0XHQuZmlsdGVyKChjKTogYyBpcyB7IHR5cGU6IFwidGV4dFwiOyB0ZXh0OiBzdHJpbmcgfSA9PiBjLnR5cGUgPT09IFwidGV4dFwiKVxuXHRcdFx0XHRcdFx0XHRcdC5tYXAoKGMpID0+IGMudGV4dClcblx0XHRcdFx0XHRcdFx0XHQuam9pbihcIlwiKTtcblx0XHRcdFx0cmVzdWx0ID0gdGhlbWUuZmcoXCJjdXN0b21NZXNzYWdlTGFiZWxcIiwgYFske2VudHJ5LmN1c3RvbVR5cGV9XTogYCkgKyBub3JtYWxpemUoY29udGVudCk7XG5cdFx0XHRcdGJyZWFrO1xuXHRcdFx0fVxuXHRcdFx0Y2FzZSBcImNvbXBhY3Rpb25cIjoge1xuXHRcdFx0XHRjb25zdCB0b2tlbnMgPSBNYXRoLnJvdW5kKGVudHJ5LnRva2Vuc0JlZm9yZSAvIDEwMDApO1xuXHRcdFx0XHRyZXN1bHQgPSB0aGVtZS5mZyhcImJvcmRlckFjY2VudFwiLCBgW2NvbXBhY3Rpb246ICR7dG9rZW5zfWsgdG9rZW5zXWApO1xuXHRcdFx0XHRicmVhaztcblx0XHRcdH1cblx0XHRcdGNhc2UgXCJicmFuY2hfc3VtbWFyeVwiOlxuXHRcdFx0XHRyZXN1bHQgPSB0aGVtZS5mZyhcIndhcm5pbmdcIiwgYFticmFuY2ggc3VtbWFyeV06IGApICsgbm9ybWFsaXplKGVudHJ5LnN1bW1hcnkpO1xuXHRcdFx0XHRicmVhaztcblx0XHRcdGNhc2UgXCJtb2RlbF9jaGFuZ2VcIjpcblx0XHRcdFx0cmVzdWx0ID0gdGhlbWUuZmcoXCJkaW1cIiwgYFttb2RlbDogJHtlbnRyeS5tb2RlbElkfV1gKTtcblx0XHRcdFx0YnJlYWs7XG5cdFx0XHRjYXNlIFwidGhpbmtpbmdfbGV2ZWxfY2hhbmdlXCI6XG5cdFx0XHRcdHJlc3VsdCA9IHRoZW1lLmZnKFwiZGltXCIsIGBbdGhpbmtpbmc6ICR7ZW50cnkudGhpbmtpbmdMZXZlbH1dYCk7XG5cdFx0XHRcdGJyZWFrO1xuXHRcdFx0Y2FzZSBcImN1c3RvbVwiOlxuXHRcdFx0XHRyZXN1bHQgPSB0aGVtZS5mZyhcImRpbVwiLCBgW2N1c3RvbTogJHtlbnRyeS5jdXN0b21UeXBlfV1gKTtcblx0XHRcdFx0YnJlYWs7XG5cdFx0XHRjYXNlIFwibGFiZWxcIjpcblx0XHRcdFx0cmVzdWx0ID0gdGhlbWUuZmcoXCJkaW1cIiwgYFtsYWJlbDogJHtlbnRyeS5sYWJlbCA/PyBcIihjbGVhcmVkKVwifV1gKTtcblx0XHRcdFx0YnJlYWs7XG5cdFx0XHRkZWZhdWx0OlxuXHRcdFx0XHRyZXN1bHQgPSBcIlwiO1xuXHRcdH1cblxuXHRcdHJldHVybiBpc1NlbGVjdGVkID8gdGhlbWUuYm9sZChyZXN1bHQpIDogcmVzdWx0O1xuXHR9XG5cblx0cHJpdmF0ZSBleHRyYWN0Q29udGVudChjb250ZW50OiB1bmtub3duKTogc3RyaW5nIHtcblx0XHRjb25zdCBtYXhMZW4gPSAyMDA7XG5cdFx0aWYgKHR5cGVvZiBjb250ZW50ID09PSBcInN0cmluZ1wiKSByZXR1cm4gY29udGVudC5zbGljZSgwLCBtYXhMZW4pO1xuXHRcdGlmIChBcnJheS5pc0FycmF5KGNvbnRlbnQpKSB7XG5cdFx0XHRsZXQgcmVzdWx0ID0gXCJcIjtcblx0XHRcdGZvciAoY29uc3QgYyBvZiBjb250ZW50KSB7XG5cdFx0XHRcdGlmICh0eXBlb2YgYyA9PT0gXCJvYmplY3RcIiAmJiBjICE9PSBudWxsICYmIFwidHlwZVwiIGluIGMgJiYgYy50eXBlID09PSBcInRleHRcIikge1xuXHRcdFx0XHRcdHJlc3VsdCArPSAoYyBhcyB7IHRleHQ6IHN0cmluZyB9KS50ZXh0O1xuXHRcdFx0XHRcdGlmIChyZXN1bHQubGVuZ3RoID49IG1heExlbikgcmV0dXJuIHJlc3VsdC5zbGljZSgwLCBtYXhMZW4pO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0XHRyZXR1cm4gcmVzdWx0O1xuXHRcdH1cblx0XHRyZXR1cm4gXCJcIjtcblx0fVxuXG5cdHByaXZhdGUgaGFzVGV4dENvbnRlbnQoY29udGVudDogdW5rbm93bik6IGJvb2xlYW4ge1xuXHRcdGlmICh0eXBlb2YgY29udGVudCA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIGNvbnRlbnQudHJpbSgpLmxlbmd0aCA+IDA7XG5cdFx0aWYgKEFycmF5LmlzQXJyYXkoY29udGVudCkpIHtcblx0XHRcdGZvciAoY29uc3QgYyBvZiBjb250ZW50KSB7XG5cdFx0XHRcdGlmICh0eXBlb2YgYyA9PT0gXCJvYmplY3RcIiAmJiBjICE9PSBudWxsICYmIFwidHlwZVwiIGluIGMgJiYgYy50eXBlID09PSBcInRleHRcIikge1xuXHRcdFx0XHRcdGNvbnN0IHRleHQgPSAoYyBhcyB7IHRleHQ/OiBzdHJpbmcgfSkudGV4dDtcblx0XHRcdFx0XHRpZiAodGV4dCAmJiB0ZXh0LnRyaW0oKS5sZW5ndGggPiAwKSByZXR1cm4gdHJ1ZTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH1cblx0XHRyZXR1cm4gZmFsc2U7XG5cdH1cblxuXHRwcml2YXRlIGZvcm1hdFRvb2xDYWxsKG5hbWU6IHN0cmluZywgYXJnczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBzdHJpbmcge1xuXHRcdGNvbnN0IHNob3J0ZW5QYXRoID0gKHA6IHN0cmluZyk6IHN0cmluZyA9PiB7XG5cdFx0XHRjb25zdCBob21lID0gcHJvY2Vzcy5lbnYuSE9NRSB8fCBwcm9jZXNzLmVudi5VU0VSUFJPRklMRSB8fCBcIlwiO1xuXHRcdFx0aWYgKGhvbWUgJiYgcC5zdGFydHNXaXRoKGhvbWUpKSByZXR1cm4gYH4ke3Auc2xpY2UoaG9tZS5sZW5ndGgpfWA7XG5cdFx0XHRyZXR1cm4gcDtcblx0XHR9O1xuXG5cdFx0c3dpdGNoIChuYW1lKSB7XG5cdFx0XHRjYXNlIFwicmVhZFwiOiB7XG5cdFx0XHRcdGNvbnN0IHBhdGggPSBzaG9ydGVuUGF0aChTdHJpbmcoYXJncy5wYXRoIHx8IGFyZ3MuZmlsZV9wYXRoIHx8IFwiXCIpKTtcblx0XHRcdFx0Y29uc3Qgb2Zmc2V0ID0gYXJncy5vZmZzZXQgYXMgbnVtYmVyIHwgdW5kZWZpbmVkO1xuXHRcdFx0XHRjb25zdCBsaW1pdCA9IGFyZ3MubGltaXQgYXMgbnVtYmVyIHwgdW5kZWZpbmVkO1xuXHRcdFx0XHRsZXQgZGlzcGxheSA9IHBhdGg7XG5cdFx0XHRcdGlmIChvZmZzZXQgIT09IHVuZGVmaW5lZCB8fCBsaW1pdCAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0XHRcdFx0Y29uc3Qgc3RhcnQgPSBvZmZzZXQgPz8gMTtcblx0XHRcdFx0XHRjb25zdCBlbmQgPSBsaW1pdCAhPT0gdW5kZWZpbmVkID8gc3RhcnQgKyBsaW1pdCAtIDEgOiBcIlwiO1xuXHRcdFx0XHRcdGRpc3BsYXkgKz0gYDoke3N0YXJ0fSR7ZW5kID8gYC0ke2VuZH1gIDogXCJcIn1gO1xuXHRcdFx0XHR9XG5cdFx0XHRcdHJldHVybiBgW3JlYWQ6ICR7ZGlzcGxheX1dYDtcblx0XHRcdH1cblx0XHRcdGNhc2UgXCJ3cml0ZVwiOiB7XG5cdFx0XHRcdGNvbnN0IHBhdGggPSBzaG9ydGVuUGF0aChTdHJpbmcoYXJncy5wYXRoIHx8IGFyZ3MuZmlsZV9wYXRoIHx8IFwiXCIpKTtcblx0XHRcdFx0cmV0dXJuIGBbd3JpdGU6ICR7cGF0aH1dYDtcblx0XHRcdH1cblx0XHRcdGNhc2UgXCJlZGl0XCI6IHtcblx0XHRcdFx0Y29uc3QgcGF0aCA9IHNob3J0ZW5QYXRoKFN0cmluZyhhcmdzLnBhdGggfHwgYXJncy5maWxlX3BhdGggfHwgXCJcIikpO1xuXHRcdFx0XHRyZXR1cm4gYFtlZGl0OiAke3BhdGh9XWA7XG5cdFx0XHR9XG5cdFx0XHRjYXNlIFwiYmFzaFwiOiB7XG5cdFx0XHRcdGNvbnN0IHJhd0NtZCA9IFN0cmluZyhhcmdzLmNvbW1hbmQgfHwgXCJcIik7XG5cdFx0XHRcdGNvbnN0IGNtZCA9IHJhd0NtZFxuXHRcdFx0XHRcdC5yZXBsYWNlKC9bXFxuXFx0XS9nLCBcIiBcIilcblx0XHRcdFx0XHQudHJpbSgpXG5cdFx0XHRcdFx0LnNsaWNlKDAsIDUwKTtcblx0XHRcdFx0cmV0dXJuIGBbYmFzaDogJHtjbWR9JHtyYXdDbWQubGVuZ3RoID4gNTAgPyBcIi4uLlwiIDogXCJcIn1dYDtcblx0XHRcdH1cblx0XHRcdGNhc2UgXCJncmVwXCI6IHtcblx0XHRcdFx0Y29uc3QgcGF0dGVybiA9IFN0cmluZyhhcmdzLnBhdHRlcm4gfHwgXCJcIik7XG5cdFx0XHRcdGNvbnN0IHBhdGggPSBzaG9ydGVuUGF0aChTdHJpbmcoYXJncy5wYXRoIHx8IFwiLlwiKSk7XG5cdFx0XHRcdHJldHVybiBgW2dyZXA6IC8ke3BhdHRlcm59LyBpbiAke3BhdGh9XWA7XG5cdFx0XHR9XG5cdFx0XHRjYXNlIFwiZmluZFwiOiB7XG5cdFx0XHRcdGNvbnN0IHBhdHRlcm4gPSBTdHJpbmcoYXJncy5wYXR0ZXJuIHx8IFwiXCIpO1xuXHRcdFx0XHRjb25zdCBwYXRoID0gc2hvcnRlblBhdGgoU3RyaW5nKGFyZ3MucGF0aCB8fCBcIi5cIikpO1xuXHRcdFx0XHRyZXR1cm4gYFtmaW5kOiAke3BhdHRlcm59IGluICR7cGF0aH1dYDtcblx0XHRcdH1cblx0XHRcdGNhc2UgXCJsc1wiOiB7XG5cdFx0XHRcdGNvbnN0IHBhdGggPSBzaG9ydGVuUGF0aChTdHJpbmcoYXJncy5wYXRoIHx8IFwiLlwiKSk7XG5cdFx0XHRcdHJldHVybiBgW2xzOiAke3BhdGh9XWA7XG5cdFx0XHR9XG5cdFx0XHRkZWZhdWx0OiB7XG5cdFx0XHRcdC8vIEN1c3RvbSB0b29sIC0gc2hvdyBuYW1lIGFuZCB0cnVuY2F0ZWQgSlNPTiBhcmdzXG5cdFx0XHRcdGNvbnN0IGFyZ3NTdHIgPSBKU09OLnN0cmluZ2lmeShhcmdzKS5zbGljZSgwLCA0MCk7XG5cdFx0XHRcdHJldHVybiBgWyR7bmFtZX06ICR7YXJnc1N0cn0ke0pTT04uc3RyaW5naWZ5KGFyZ3MpLmxlbmd0aCA+IDQwID8gXCIuLi5cIiA6IFwiXCJ9XWA7XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG5cblx0aGFuZGxlSW5wdXQoa2V5RGF0YTogc3RyaW5nKTogdm9pZCB7XG5cdFx0Y29uc3Qga2IgPSBnZXRFZGl0b3JLZXliaW5kaW5ncygpO1xuXHRcdGlmIChrYi5tYXRjaGVzKGtleURhdGEsIFwic2VsZWN0VXBcIikpIHtcblx0XHRcdHRoaXMuc2VsZWN0ZWRJbmRleCA9IHRoaXMuc2VsZWN0ZWRJbmRleCA9PT0gMCA/IHRoaXMuZmlsdGVyZWROb2Rlcy5sZW5ndGggLSAxIDogdGhpcy5zZWxlY3RlZEluZGV4IC0gMTtcblx0XHR9IGVsc2UgaWYgKGtiLm1hdGNoZXMoa2V5RGF0YSwgXCJzZWxlY3REb3duXCIpKSB7XG5cdFx0XHR0aGlzLnNlbGVjdGVkSW5kZXggPSB0aGlzLnNlbGVjdGVkSW5kZXggPT09IHRoaXMuZmlsdGVyZWROb2Rlcy5sZW5ndGggLSAxID8gMCA6IHRoaXMuc2VsZWN0ZWRJbmRleCArIDE7XG5cdFx0fSBlbHNlIGlmIChrYi5tYXRjaGVzKGtleURhdGEsIFwidHJlZUZvbGRPclVwXCIpKSB7XG5cdFx0XHRjb25zdCBjdXJyZW50SWQgPSB0aGlzLmZpbHRlcmVkTm9kZXNbdGhpcy5zZWxlY3RlZEluZGV4XT8ubm9kZS5lbnRyeS5pZDtcblx0XHRcdGlmIChjdXJyZW50SWQgJiYgdGhpcy5pc0ZvbGRhYmxlKGN1cnJlbnRJZCkgJiYgIXRoaXMuZm9sZGVkTm9kZXMuaGFzKGN1cnJlbnRJZCkpIHtcblx0XHRcdFx0dGhpcy5mb2xkZWROb2Rlcy5hZGQoY3VycmVudElkKTtcblx0XHRcdFx0dGhpcy5hcHBseUZpbHRlcigpO1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0dGhpcy5zZWxlY3RlZEluZGV4ID0gdGhpcy5maW5kQnJhbmNoU2VnbWVudFN0YXJ0KFwidXBcIik7XG5cdFx0XHR9XG5cdFx0fSBlbHNlIGlmIChrYi5tYXRjaGVzKGtleURhdGEsIFwidHJlZVVuZm9sZE9yRG93blwiKSkge1xuXHRcdFx0Y29uc3QgY3VycmVudElkID0gdGhpcy5maWx0ZXJlZE5vZGVzW3RoaXMuc2VsZWN0ZWRJbmRleF0/Lm5vZGUuZW50cnkuaWQ7XG5cdFx0XHRpZiAoY3VycmVudElkICYmIHRoaXMuZm9sZGVkTm9kZXMuaGFzKGN1cnJlbnRJZCkpIHtcblx0XHRcdFx0dGhpcy5mb2xkZWROb2Rlcy5kZWxldGUoY3VycmVudElkKTtcblx0XHRcdFx0dGhpcy5hcHBseUZpbHRlcigpO1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0dGhpcy5zZWxlY3RlZEluZGV4ID0gdGhpcy5maW5kQnJhbmNoU2VnbWVudFN0YXJ0KFwiZG93blwiKTtcblx0XHRcdH1cblx0XHR9IGVsc2UgaWYgKGtiLm1hdGNoZXMoa2V5RGF0YSwgXCJjdXJzb3JMZWZ0XCIpIHx8IGtiLm1hdGNoZXMoa2V5RGF0YSwgXCJzZWxlY3RQYWdlVXBcIikpIHtcblx0XHRcdC8vIFBhZ2UgdXBcblx0XHRcdHRoaXMuc2VsZWN0ZWRJbmRleCA9IE1hdGgubWF4KDAsIHRoaXMuc2VsZWN0ZWRJbmRleCAtIHRoaXMubWF4VmlzaWJsZUxpbmVzKTtcblx0XHR9IGVsc2UgaWYgKGtiLm1hdGNoZXMoa2V5RGF0YSwgXCJjdXJzb3JSaWdodFwiKSB8fCBrYi5tYXRjaGVzKGtleURhdGEsIFwic2VsZWN0UGFnZURvd25cIikpIHtcblx0XHRcdC8vIFBhZ2UgZG93blxuXHRcdFx0dGhpcy5zZWxlY3RlZEluZGV4ID0gTWF0aC5taW4odGhpcy5maWx0ZXJlZE5vZGVzLmxlbmd0aCAtIDEsIHRoaXMuc2VsZWN0ZWRJbmRleCArIHRoaXMubWF4VmlzaWJsZUxpbmVzKTtcblx0XHR9IGVsc2UgaWYgKGtiLm1hdGNoZXMoa2V5RGF0YSwgXCJzZWxlY3RDb25maXJtXCIpKSB7XG5cdFx0XHRjb25zdCBzZWxlY3RlZCA9IHRoaXMuZmlsdGVyZWROb2Rlc1t0aGlzLnNlbGVjdGVkSW5kZXhdO1xuXHRcdFx0aWYgKHNlbGVjdGVkICYmIHRoaXMub25TZWxlY3QpIHtcblx0XHRcdFx0dGhpcy5vblNlbGVjdChzZWxlY3RlZC5ub2RlLmVudHJ5LmlkKTtcblx0XHRcdH1cblx0XHR9IGVsc2UgaWYgKGtiLm1hdGNoZXMoa2V5RGF0YSwgXCJzZWxlY3RDYW5jZWxcIikpIHtcblx0XHRcdGlmICh0aGlzLnNlYXJjaFF1ZXJ5KSB7XG5cdFx0XHRcdHRoaXMuc2VhcmNoUXVlcnkgPSBcIlwiO1xuXHRcdFx0XHR0aGlzLmZvbGRlZE5vZGVzLmNsZWFyKCk7XG5cdFx0XHRcdHRoaXMuYXBwbHlGaWx0ZXIoKTtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdHRoaXMub25DYW5jZWw/LigpO1xuXHRcdFx0fVxuXHRcdH0gZWxzZSBpZiAobWF0Y2hlc0tleShrZXlEYXRhLCBcImN0cmwrZFwiKSkge1xuXHRcdFx0Ly8gRGlyZWN0IGZpbHRlcjogZGVmYXVsdFxuXHRcdFx0dGhpcy5maWx0ZXJNb2RlID0gXCJkZWZhdWx0XCI7XG5cdFx0XHR0aGlzLmZvbGRlZE5vZGVzLmNsZWFyKCk7XG5cdFx0XHR0aGlzLmFwcGx5RmlsdGVyKCk7XG5cdFx0fSBlbHNlIGlmIChtYXRjaGVzS2V5KGtleURhdGEsIFwiY3RybCt0XCIpKSB7XG5cdFx0XHQvLyBUb2dnbGUgZmlsdGVyOiBuby10b29scyBcdTIxOTQgZGVmYXVsdFxuXHRcdFx0dGhpcy5maWx0ZXJNb2RlID0gdGhpcy5maWx0ZXJNb2RlID09PSBcIm5vLXRvb2xzXCIgPyBcImRlZmF1bHRcIiA6IFwibm8tdG9vbHNcIjtcblx0XHRcdHRoaXMuZm9sZGVkTm9kZXMuY2xlYXIoKTtcblx0XHRcdHRoaXMuYXBwbHlGaWx0ZXIoKTtcblx0XHR9IGVsc2UgaWYgKG1hdGNoZXNLZXkoa2V5RGF0YSwgXCJjdHJsK3VcIikpIHtcblx0XHRcdC8vIFRvZ2dsZSBmaWx0ZXI6IHVzZXItb25seSBcdTIxOTQgZGVmYXVsdFxuXHRcdFx0dGhpcy5maWx0ZXJNb2RlID0gdGhpcy5maWx0ZXJNb2RlID09PSBcInVzZXItb25seVwiID8gXCJkZWZhdWx0XCIgOiBcInVzZXItb25seVwiO1xuXHRcdFx0dGhpcy5mb2xkZWROb2Rlcy5jbGVhcigpO1xuXHRcdFx0dGhpcy5hcHBseUZpbHRlcigpO1xuXHRcdH0gZWxzZSBpZiAobWF0Y2hlc0tleShrZXlEYXRhLCBcImN0cmwrbFwiKSkge1xuXHRcdFx0Ly8gVG9nZ2xlIGZpbHRlcjogbGFiZWxlZC1vbmx5IFx1MjE5NCBkZWZhdWx0XG5cdFx0XHR0aGlzLmZpbHRlck1vZGUgPSB0aGlzLmZpbHRlck1vZGUgPT09IFwibGFiZWxlZC1vbmx5XCIgPyBcImRlZmF1bHRcIiA6IFwibGFiZWxlZC1vbmx5XCI7XG5cdFx0XHR0aGlzLmZvbGRlZE5vZGVzLmNsZWFyKCk7XG5cdFx0XHR0aGlzLmFwcGx5RmlsdGVyKCk7XG5cdFx0fSBlbHNlIGlmIChtYXRjaGVzS2V5KGtleURhdGEsIFwiY3RybCthXCIpKSB7XG5cdFx0XHQvLyBUb2dnbGUgZmlsdGVyOiBhbGwgXHUyMTk0IGRlZmF1bHRcblx0XHRcdHRoaXMuZmlsdGVyTW9kZSA9IHRoaXMuZmlsdGVyTW9kZSA9PT0gXCJhbGxcIiA/IFwiZGVmYXVsdFwiIDogXCJhbGxcIjtcblx0XHRcdHRoaXMuZm9sZGVkTm9kZXMuY2xlYXIoKTtcblx0XHRcdHRoaXMuYXBwbHlGaWx0ZXIoKTtcblx0XHR9IGVsc2UgaWYgKG1hdGNoZXNLZXkoa2V5RGF0YSwgXCJzaGlmdCtjdHJsK29cIikpIHtcblx0XHRcdC8vIEN5Y2xlIGZpbHRlciBiYWNrd2FyZHNcblx0XHRcdGNvbnN0IG1vZGVzOiBGaWx0ZXJNb2RlW10gPSBbXCJkZWZhdWx0XCIsIFwibm8tdG9vbHNcIiwgXCJ1c2VyLW9ubHlcIiwgXCJsYWJlbGVkLW9ubHlcIiwgXCJhbGxcIl07XG5cdFx0XHRjb25zdCBjdXJyZW50SW5kZXggPSBtb2Rlcy5pbmRleE9mKHRoaXMuZmlsdGVyTW9kZSk7XG5cdFx0XHR0aGlzLmZpbHRlck1vZGUgPSBtb2Rlc1soY3VycmVudEluZGV4IC0gMSArIG1vZGVzLmxlbmd0aCkgJSBtb2Rlcy5sZW5ndGhdO1xuXHRcdFx0dGhpcy5mb2xkZWROb2Rlcy5jbGVhcigpO1xuXHRcdFx0dGhpcy5hcHBseUZpbHRlcigpO1xuXHRcdH0gZWxzZSBpZiAobWF0Y2hlc0tleShrZXlEYXRhLCBcImN0cmwrb1wiKSkge1xuXHRcdFx0Ly8gQ3ljbGUgZmlsdGVyIGZvcndhcmRzOiBkZWZhdWx0IFx1MjE5MiBuby10b29scyBcdTIxOTIgdXNlci1vbmx5IFx1MjE5MiBsYWJlbGVkLW9ubHkgXHUyMTkyIGFsbCBcdTIxOTIgZGVmYXVsdFxuXHRcdFx0Y29uc3QgbW9kZXM6IEZpbHRlck1vZGVbXSA9IFtcImRlZmF1bHRcIiwgXCJuby10b29sc1wiLCBcInVzZXItb25seVwiLCBcImxhYmVsZWQtb25seVwiLCBcImFsbFwiXTtcblx0XHRcdGNvbnN0IGN1cnJlbnRJbmRleCA9IG1vZGVzLmluZGV4T2YodGhpcy5maWx0ZXJNb2RlKTtcblx0XHRcdHRoaXMuZmlsdGVyTW9kZSA9IG1vZGVzWyhjdXJyZW50SW5kZXggKyAxKSAlIG1vZGVzLmxlbmd0aF07XG5cdFx0XHR0aGlzLmZvbGRlZE5vZGVzLmNsZWFyKCk7XG5cdFx0XHR0aGlzLmFwcGx5RmlsdGVyKCk7XG5cdFx0fSBlbHNlIGlmIChrYi5tYXRjaGVzKGtleURhdGEsIFwiZGVsZXRlQ2hhckJhY2t3YXJkXCIpKSB7XG5cdFx0XHRpZiAodGhpcy5zZWFyY2hRdWVyeS5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdHRoaXMuc2VhcmNoUXVlcnkgPSB0aGlzLnNlYXJjaFF1ZXJ5LnNsaWNlKDAsIC0xKTtcblx0XHRcdFx0dGhpcy5mb2xkZWROb2Rlcy5jbGVhcigpO1xuXHRcdFx0XHR0aGlzLmFwcGx5RmlsdGVyKCk7XG5cdFx0XHR9XG5cdFx0fSBlbHNlIGlmIChtYXRjaGVzS2V5KGtleURhdGEsIFwic2hpZnQrbFwiKSkge1xuXHRcdFx0Y29uc3Qgc2VsZWN0ZWQgPSB0aGlzLmZpbHRlcmVkTm9kZXNbdGhpcy5zZWxlY3RlZEluZGV4XTtcblx0XHRcdGlmIChzZWxlY3RlZCAmJiB0aGlzLm9uTGFiZWxFZGl0KSB7XG5cdFx0XHRcdHRoaXMub25MYWJlbEVkaXQoc2VsZWN0ZWQubm9kZS5lbnRyeS5pZCwgc2VsZWN0ZWQubm9kZS5sYWJlbCk7XG5cdFx0XHR9XG5cdFx0fSBlbHNlIHtcblx0XHRcdGNvbnN0IGhhc0NvbnRyb2xDaGFycyA9IFsuLi5rZXlEYXRhXS5zb21lKChjaCkgPT4ge1xuXHRcdFx0XHRjb25zdCBjb2RlID0gY2guY2hhckNvZGVBdCgwKTtcblx0XHRcdFx0cmV0dXJuIGNvZGUgPCAzMiB8fCBjb2RlID09PSAweDdmIHx8IChjb2RlID49IDB4ODAgJiYgY29kZSA8PSAweDlmKTtcblx0XHRcdH0pO1xuXHRcdFx0aWYgKCFoYXNDb250cm9sQ2hhcnMgJiYga2V5RGF0YS5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdHRoaXMuc2VhcmNoUXVlcnkgKz0ga2V5RGF0YTtcblx0XHRcdFx0dGhpcy5mb2xkZWROb2Rlcy5jbGVhcigpO1xuXHRcdFx0XHR0aGlzLmFwcGx5RmlsdGVyKCk7XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG5cblx0LyoqXG5cdCAqIFdoZXRoZXIgYSBub2RlIGNhbiBiZSBmb2xkZWQuIEEgbm9kZSBpcyBmb2xkYWJsZSBpZiBpdCBoYXMgdmlzaWJsZSBjaGlsZHJlblxuXHQgKiBhbmQgaXMgZWl0aGVyIGEgcm9vdCAobm8gdmlzaWJsZSBwYXJlbnQpIG9yIGEgc2VnbWVudCBzdGFydCAodmlzaWJsZSBwYXJlbnRcblx0ICogaGFzIG11bHRpcGxlIHZpc2libGUgY2hpbGRyZW4pLlxuXHQgKi9cblx0cHJpdmF0ZSBpc0ZvbGRhYmxlKGVudHJ5SWQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuXHRcdGNvbnN0IGNoaWxkcmVuID0gdGhpcy52aXNpYmxlQ2hpbGRyZW5NYXAuZ2V0KGVudHJ5SWQpO1xuXHRcdGlmICghY2hpbGRyZW4gfHwgY2hpbGRyZW4ubGVuZ3RoID09PSAwKSByZXR1cm4gZmFsc2U7XG5cdFx0Y29uc3QgcGFyZW50SWQgPSB0aGlzLnZpc2libGVQYXJlbnRNYXAuZ2V0KGVudHJ5SWQpO1xuXHRcdGlmIChwYXJlbnRJZCA9PT0gbnVsbCB8fCBwYXJlbnRJZCA9PT0gdW5kZWZpbmVkKSByZXR1cm4gdHJ1ZTtcblx0XHRjb25zdCBzaWJsaW5ncyA9IHRoaXMudmlzaWJsZUNoaWxkcmVuTWFwLmdldChwYXJlbnRJZCk7XG5cdFx0cmV0dXJuIHNpYmxpbmdzICE9PSB1bmRlZmluZWQgJiYgc2libGluZ3MubGVuZ3RoID4gMTtcblx0fVxuXG5cdC8qKlxuXHQgKiBGaW5kIHRoZSBpbmRleCBvZiB0aGUgbmV4dCBicmFuY2ggc2VnbWVudCBzdGFydCBpbiB0aGUgZ2l2ZW4gZGlyZWN0aW9uLlxuXHQgKiBBIHNlZ21lbnQgc3RhcnQgaXMgdGhlIGZpcnN0IGNoaWxkIG9mIGEgYnJhbmNoIHBvaW50LlxuXHQgKlxuXHQgKiBcInVwXCIgd2Fsa3MgdGhlIHZpc2libGUgcGFyZW50IGNoYWluOyBcImRvd25cIiB3YWxrcyB2aXNpYmxlIGNoaWxkcmVuXG5cdCAqIChhbHdheXMgZm9sbG93aW5nIHRoZSBmaXJzdCBjaGlsZCkuXG5cdCAqL1xuXHRwcml2YXRlIGZpbmRCcmFuY2hTZWdtZW50U3RhcnQoZGlyZWN0aW9uOiBcInVwXCIgfCBcImRvd25cIik6IG51bWJlciB7XG5cdFx0Y29uc3Qgc2VsZWN0ZWRJZCA9IHRoaXMuZmlsdGVyZWROb2Rlc1t0aGlzLnNlbGVjdGVkSW5kZXhdPy5ub2RlLmVudHJ5LmlkO1xuXHRcdGlmICghc2VsZWN0ZWRJZCkgcmV0dXJuIHRoaXMuc2VsZWN0ZWRJbmRleDtcblxuXHRcdGNvbnN0IGluZGV4QnlFbnRyeUlkID0gbmV3IE1hcCh0aGlzLmZpbHRlcmVkTm9kZXMubWFwKChub2RlLCBpKSA9PiBbbm9kZS5ub2RlLmVudHJ5LmlkLCBpXSkpO1xuXHRcdGxldCBjdXJyZW50SWQ6IHN0cmluZyA9IHNlbGVjdGVkSWQ7XG5cdFx0aWYgKGRpcmVjdGlvbiA9PT0gXCJkb3duXCIpIHtcblx0XHRcdHdoaWxlICh0cnVlKSB7XG5cdFx0XHRcdGNvbnN0IGNoaWxkcmVuOiBzdHJpbmdbXSA9IHRoaXMudmlzaWJsZUNoaWxkcmVuTWFwLmdldChjdXJyZW50SWQpID8/IFtdO1xuXHRcdFx0XHRpZiAoY2hpbGRyZW4ubGVuZ3RoID09PSAwKSByZXR1cm4gaW5kZXhCeUVudHJ5SWQuZ2V0KGN1cnJlbnRJZCkhO1xuXHRcdFx0XHRpZiAoY2hpbGRyZW4ubGVuZ3RoID4gMSkgcmV0dXJuIGluZGV4QnlFbnRyeUlkLmdldChjaGlsZHJlblswXSkhO1xuXHRcdFx0XHRjdXJyZW50SWQgPSBjaGlsZHJlblswXTtcblx0XHRcdH1cblx0XHR9XG5cblx0XHQvLyBkaXJlY3Rpb24gPT09IFwidXBcIlxuXHRcdHdoaWxlICh0cnVlKSB7XG5cdFx0XHRjb25zdCBwYXJlbnRJZDogc3RyaW5nIHwgbnVsbCA9IHRoaXMudmlzaWJsZVBhcmVudE1hcC5nZXQoY3VycmVudElkKSA/PyBudWxsO1xuXHRcdFx0aWYgKHBhcmVudElkID09PSBudWxsKSByZXR1cm4gaW5kZXhCeUVudHJ5SWQuZ2V0KGN1cnJlbnRJZCkhO1xuXHRcdFx0Y29uc3QgY2hpbGRyZW4gPSB0aGlzLnZpc2libGVDaGlsZHJlbk1hcC5nZXQocGFyZW50SWQpID8/IFtdO1xuXHRcdFx0aWYgKGNoaWxkcmVuLmxlbmd0aCA+IDEpIHtcblx0XHRcdFx0Y29uc3Qgc2VnbWVudFN0YXJ0ID0gaW5kZXhCeUVudHJ5SWQuZ2V0KGN1cnJlbnRJZCkhO1xuXHRcdFx0XHRpZiAoc2VnbWVudFN0YXJ0IDwgdGhpcy5zZWxlY3RlZEluZGV4KSB7XG5cdFx0XHRcdFx0cmV0dXJuIHNlZ21lbnRTdGFydDtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdFx0Y3VycmVudElkID0gcGFyZW50SWQ7XG5cdFx0fVxuXHR9XG59XG5cbi8qKiBDb21wb25lbnQgdGhhdCBkaXNwbGF5cyB0aGUgY3VycmVudCBzZWFyY2ggcXVlcnkgKi9cbmNsYXNzIFNlYXJjaExpbmUgaW1wbGVtZW50cyBDb21wb25lbnQge1xuXHRjb25zdHJ1Y3Rvcihwcml2YXRlIHRyZWVMaXN0OiBUcmVlTGlzdCkge31cblxuXHRpbnZhbGlkYXRlKCk6IHZvaWQge31cblxuXHRyZW5kZXIod2lkdGg6IG51bWJlcik6IHN0cmluZ1tdIHtcblx0XHRjb25zdCBxdWVyeSA9IHRoaXMudHJlZUxpc3QuZ2V0U2VhcmNoUXVlcnkoKTtcblx0XHRpZiAocXVlcnkpIHtcblx0XHRcdHJldHVybiBbdHJ1bmNhdGVUb1dpZHRoKGAgICR7dGhlbWUuZmcoXCJtdXRlZFwiLCBcIlR5cGUgdG8gc2VhcmNoOlwiKX0gJHt0aGVtZS5mZyhcImFjY2VudFwiLCBxdWVyeSl9YCwgd2lkdGgpXTtcblx0XHR9XG5cdFx0cmV0dXJuIFt0cnVuY2F0ZVRvV2lkdGgoYCAgJHt0aGVtZS5mZyhcIm11dGVkXCIsIFwiVHlwZSB0byBzZWFyY2g6XCIpfWAsIHdpZHRoKV07XG5cdH1cblxuXHRoYW5kbGVJbnB1dChfa2V5RGF0YTogc3RyaW5nKTogdm9pZCB7fVxufVxuXG4vKiogTGFiZWwgaW5wdXQgY29tcG9uZW50IHNob3duIHdoZW4gZWRpdGluZyBhIGxhYmVsICovXG5jbGFzcyBMYWJlbElucHV0IGltcGxlbWVudHMgQ29tcG9uZW50LCBGb2N1c2FibGUge1xuXHRwcml2YXRlIGlucHV0OiBJbnB1dDtcblx0cHJpdmF0ZSBlbnRyeUlkOiBzdHJpbmc7XG5cdHB1YmxpYyBvblN1Ym1pdD86IChlbnRyeUlkOiBzdHJpbmcsIGxhYmVsOiBzdHJpbmcgfCB1bmRlZmluZWQpID0+IHZvaWQ7XG5cdHB1YmxpYyBvbkNhbmNlbD86ICgpID0+IHZvaWQ7XG5cblx0Ly8gRm9jdXNhYmxlIGltcGxlbWVudGF0aW9uIC0gcHJvcGFnYXRlIHRvIGlucHV0IGZvciBJTUUgY3Vyc29yIHBvc2l0aW9uaW5nXG5cdHByaXZhdGUgX2ZvY3VzZWQgPSBmYWxzZTtcblx0Z2V0IGZvY3VzZWQoKTogYm9vbGVhbiB7XG5cdFx0cmV0dXJuIHRoaXMuX2ZvY3VzZWQ7XG5cdH1cblx0c2V0IGZvY3VzZWQodmFsdWU6IGJvb2xlYW4pIHtcblx0XHR0aGlzLl9mb2N1c2VkID0gdmFsdWU7XG5cdFx0dGhpcy5pbnB1dC5mb2N1c2VkID0gdmFsdWU7XG5cdH1cblxuXHRjb25zdHJ1Y3RvcihlbnRyeUlkOiBzdHJpbmcsIGN1cnJlbnRMYWJlbDogc3RyaW5nIHwgdW5kZWZpbmVkKSB7XG5cdFx0dGhpcy5lbnRyeUlkID0gZW50cnlJZDtcblx0XHR0aGlzLmlucHV0ID0gbmV3IElucHV0KCk7XG5cdFx0aWYgKGN1cnJlbnRMYWJlbCkge1xuXHRcdFx0dGhpcy5pbnB1dC5zZXRWYWx1ZShjdXJyZW50TGFiZWwpO1xuXHRcdH1cblx0fVxuXG5cdGludmFsaWRhdGUoKTogdm9pZCB7fVxuXG5cdHJlbmRlcih3aWR0aDogbnVtYmVyKTogc3RyaW5nW10ge1xuXHRcdGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuXHRcdGNvbnN0IGluZGVudCA9IFwiICBcIjtcblx0XHRjb25zdCBhdmFpbGFibGVXaWR0aCA9IHdpZHRoIC0gaW5kZW50Lmxlbmd0aDtcblx0XHRsaW5lcy5wdXNoKHRydW5jYXRlVG9XaWR0aChgJHtpbmRlbnR9JHt0aGVtZS5mZyhcIm11dGVkXCIsIFwiTGFiZWwgKGVtcHR5IHRvIHJlbW92ZSk6XCIpfWAsIHdpZHRoKSk7XG5cdFx0bGluZXMucHVzaCguLi50aGlzLmlucHV0LnJlbmRlcihhdmFpbGFibGVXaWR0aCkubWFwKChsaW5lKSA9PiB0cnVuY2F0ZVRvV2lkdGgoYCR7aW5kZW50fSR7bGluZX1gLCB3aWR0aCkpKTtcblx0XHRsaW5lcy5wdXNoKFxuXHRcdFx0dHJ1bmNhdGVUb1dpZHRoKGAke2luZGVudH0ke2tleUhpbnQoXCJzZWxlY3RDb25maXJtXCIsIFwic2F2ZVwiKX0gICR7a2V5SGludChcInNlbGVjdENhbmNlbFwiLCBcImNhbmNlbFwiKX1gLCB3aWR0aCksXG5cdFx0KTtcblx0XHRyZXR1cm4gbGluZXM7XG5cdH1cblxuXHRoYW5kbGVJbnB1dChrZXlEYXRhOiBzdHJpbmcpOiB2b2lkIHtcblx0XHRjb25zdCBrYiA9IGdldEVkaXRvcktleWJpbmRpbmdzKCk7XG5cdFx0aWYgKGtiLm1hdGNoZXMoa2V5RGF0YSwgXCJzZWxlY3RDb25maXJtXCIpKSB7XG5cdFx0XHRjb25zdCB2YWx1ZSA9IHRoaXMuaW5wdXQuZ2V0VmFsdWUoKS50cmltKCk7XG5cdFx0XHR0aGlzLm9uU3VibWl0Py4odGhpcy5lbnRyeUlkLCB2YWx1ZSB8fCB1bmRlZmluZWQpO1xuXHRcdH0gZWxzZSBpZiAoa2IubWF0Y2hlcyhrZXlEYXRhLCBcInNlbGVjdENhbmNlbFwiKSkge1xuXHRcdFx0dGhpcy5vbkNhbmNlbD8uKCk7XG5cdFx0fSBlbHNlIHtcblx0XHRcdHRoaXMuaW5wdXQuaGFuZGxlSW5wdXQoa2V5RGF0YSk7XG5cdFx0fVxuXHR9XG59XG5cbi8qKlxuICogQ29tcG9uZW50IHRoYXQgcmVuZGVycyBhIHNlc3Npb24gdHJlZSBzZWxlY3RvciBmb3IgbmF2aWdhdGlvblxuICovXG5leHBvcnQgY2xhc3MgVHJlZVNlbGVjdG9yQ29tcG9uZW50IGV4dGVuZHMgQ29udGFpbmVyIGltcGxlbWVudHMgRm9jdXNhYmxlIHtcblx0cHJpdmF0ZSB0cmVlTGlzdDogVHJlZUxpc3Q7XG5cdHByaXZhdGUgbGFiZWxJbnB1dDogTGFiZWxJbnB1dCB8IG51bGwgPSBudWxsO1xuXHRwcml2YXRlIGxhYmVsSW5wdXRDb250YWluZXI6IENvbnRhaW5lcjtcblx0cHJpdmF0ZSB0cmVlQ29udGFpbmVyOiBDb250YWluZXI7XG5cdHByaXZhdGUgb25MYWJlbENoYW5nZUNhbGxiYWNrPzogKGVudHJ5SWQ6IHN0cmluZywgbGFiZWw6IHN0cmluZyB8IHVuZGVmaW5lZCkgPT4gdm9pZDtcblxuXHQvLyBGb2N1c2FibGUgaW1wbGVtZW50YXRpb24gLSBwcm9wYWdhdGUgdG8gbGFiZWxJbnB1dCB3aGVuIGFjdGl2ZSBmb3IgSU1FIGN1cnNvciBwb3NpdGlvbmluZ1xuXHRwcml2YXRlIF9mb2N1c2VkID0gZmFsc2U7XG5cdGdldCBmb2N1c2VkKCk6IGJvb2xlYW4ge1xuXHRcdHJldHVybiB0aGlzLl9mb2N1c2VkO1xuXHR9XG5cdHNldCBmb2N1c2VkKHZhbHVlOiBib29sZWFuKSB7XG5cdFx0dGhpcy5fZm9jdXNlZCA9IHZhbHVlO1xuXHRcdC8vIFByb3BhZ2F0ZSB0byBsYWJlbElucHV0IHdoZW4gaXQncyBhY3RpdmVcblx0XHRpZiAodGhpcy5sYWJlbElucHV0KSB7XG5cdFx0XHR0aGlzLmxhYmVsSW5wdXQuZm9jdXNlZCA9IHZhbHVlO1xuXHRcdH1cblx0fVxuXG5cdGNvbnN0cnVjdG9yKFxuXHRcdHRyZWU6IFNlc3Npb25UcmVlTm9kZVtdLFxuXHRcdGN1cnJlbnRMZWFmSWQ6IHN0cmluZyB8IG51bGwsXG5cdFx0dGVybWluYWxIZWlnaHQ6IG51bWJlcixcblx0XHRvblNlbGVjdDogKGVudHJ5SWQ6IHN0cmluZykgPT4gdm9pZCxcblx0XHRvbkNhbmNlbDogKCkgPT4gdm9pZCxcblx0XHRvbkxhYmVsQ2hhbmdlPzogKGVudHJ5SWQ6IHN0cmluZywgbGFiZWw6IHN0cmluZyB8IHVuZGVmaW5lZCkgPT4gdm9pZCxcblx0XHRpbml0aWFsU2VsZWN0ZWRJZD86IHN0cmluZyxcblx0XHRpbml0aWFsRmlsdGVyTW9kZT86IEZpbHRlck1vZGUsXG5cdCkge1xuXHRcdHN1cGVyKCk7XG5cblx0XHR0aGlzLm9uTGFiZWxDaGFuZ2VDYWxsYmFjayA9IG9uTGFiZWxDaGFuZ2U7XG5cdFx0Y29uc3QgbWF4VmlzaWJsZUxpbmVzID0gTWF0aC5tYXgoNSwgTWF0aC5mbG9vcih0ZXJtaW5hbEhlaWdodCAvIDIpKTtcblxuXHRcdHRoaXMudHJlZUxpc3QgPSBuZXcgVHJlZUxpc3QodHJlZSwgY3VycmVudExlYWZJZCwgbWF4VmlzaWJsZUxpbmVzLCBpbml0aWFsU2VsZWN0ZWRJZCwgaW5pdGlhbEZpbHRlck1vZGUpO1xuXHRcdHRoaXMudHJlZUxpc3Qub25TZWxlY3QgPSBvblNlbGVjdDtcblx0XHR0aGlzLnRyZWVMaXN0Lm9uQ2FuY2VsID0gb25DYW5jZWw7XG5cdFx0dGhpcy50cmVlTGlzdC5vbkxhYmVsRWRpdCA9IChlbnRyeUlkLCBjdXJyZW50TGFiZWwpID0+IHRoaXMuc2hvd0xhYmVsSW5wdXQoZW50cnlJZCwgY3VycmVudExhYmVsKTtcblxuXHRcdHRoaXMudHJlZUNvbnRhaW5lciA9IG5ldyBDb250YWluZXIoKTtcblx0XHR0aGlzLnRyZWVDb250YWluZXIuYWRkQ2hpbGQodGhpcy50cmVlTGlzdCk7XG5cblx0XHR0aGlzLmxhYmVsSW5wdXRDb250YWluZXIgPSBuZXcgQ29udGFpbmVyKCk7XG5cblx0XHR0aGlzLmFkZENoaWxkKG5ldyBTcGFjZXIoMSkpO1xuXHRcdHRoaXMuYWRkQ2hpbGQobmV3IER5bmFtaWNCb3JkZXIoKSk7XG5cdFx0dGhpcy5hZGRDaGlsZChuZXcgVGV4dCh0aGVtZS5ib2xkKFwiICBTZXNzaW9uIFRyZWVcIiksIDEsIDApKTtcblx0XHR0aGlzLmFkZENoaWxkKFxuXHRcdFx0bmV3IFRydW5jYXRlZFRleHQoXG5cdFx0XHRcdHRoZW1lLmZnKFwibXV0ZWRcIiwgYCAgXHUyMTkxL1x1MjE5MzogbW92ZS4gXHUyMTkwL1x1MjE5MjogcGFnZS4gXlx1MjE5MC9eXHUyMTkyIG9yICR7cHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJkYXJ3aW5cIiA/IFwiXHUyMzI1XHUyMTkwL1x1MjMyNVx1MjE5MlwiIDogXCJBbHQrXHUyMTkwL0FsdCtcdTIxOTJcIn06IGZvbGQvYnJhbmNoLiBTaGlmdCtMOiBsYWJlbC4gYCkgK1xuXHRcdFx0XHRcdHRoZW1lLmZnKFwibXV0ZWRcIiwgXCJeRC9eVC9eVS9eTC9eQTogZmlsdGVycyAoXk8vXHUyMUU3Xk8gY3ljbGUpXCIpLFxuXHRcdFx0XHQwLFxuXHRcdFx0XHQwLFxuXHRcdFx0KSxcblx0XHQpO1xuXHRcdHRoaXMuYWRkQ2hpbGQobmV3IFNlYXJjaExpbmUodGhpcy50cmVlTGlzdCkpO1xuXHRcdHRoaXMuYWRkQ2hpbGQobmV3IER5bmFtaWNCb3JkZXIoKSk7XG5cdFx0dGhpcy5hZGRDaGlsZChuZXcgU3BhY2VyKDEpKTtcblx0XHR0aGlzLmFkZENoaWxkKHRoaXMudHJlZUNvbnRhaW5lcik7XG5cdFx0dGhpcy5hZGRDaGlsZCh0aGlzLmxhYmVsSW5wdXRDb250YWluZXIpO1xuXHRcdHRoaXMuYWRkQ2hpbGQobmV3IFNwYWNlcigxKSk7XG5cdFx0dGhpcy5hZGRDaGlsZChuZXcgRHluYW1pY0JvcmRlcigpKTtcblxuXHRcdGlmICh0cmVlLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0c2V0VGltZW91dCgoKSA9PiBvbkNhbmNlbCgpLCAxMDApO1xuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgc2hvd0xhYmVsSW5wdXQoZW50cnlJZDogc3RyaW5nLCBjdXJyZW50TGFiZWw6IHN0cmluZyB8IHVuZGVmaW5lZCk6IHZvaWQge1xuXHRcdHRoaXMubGFiZWxJbnB1dCA9IG5ldyBMYWJlbElucHV0KGVudHJ5SWQsIGN1cnJlbnRMYWJlbCk7XG5cdFx0dGhpcy5sYWJlbElucHV0Lm9uU3VibWl0ID0gKGlkLCBsYWJlbCkgPT4ge1xuXHRcdFx0dGhpcy50cmVlTGlzdC51cGRhdGVOb2RlTGFiZWwoaWQsIGxhYmVsKTtcblx0XHRcdHRoaXMub25MYWJlbENoYW5nZUNhbGxiYWNrPy4oaWQsIGxhYmVsKTtcblx0XHRcdHRoaXMuaGlkZUxhYmVsSW5wdXQoKTtcblx0XHR9O1xuXHRcdHRoaXMubGFiZWxJbnB1dC5vbkNhbmNlbCA9ICgpID0+IHRoaXMuaGlkZUxhYmVsSW5wdXQoKTtcblxuXHRcdC8vIFByb3BhZ2F0ZSBjdXJyZW50IGZvY3VzZWQgc3RhdGUgdG8gdGhlIG5ldyBsYWJlbElucHV0XG5cdFx0dGhpcy5sYWJlbElucHV0LmZvY3VzZWQgPSB0aGlzLl9mb2N1c2VkO1xuXG5cdFx0dGhpcy50cmVlQ29udGFpbmVyLmNsZWFyKCk7XG5cdFx0dGhpcy5sYWJlbElucHV0Q29udGFpbmVyLmNsZWFyKCk7XG5cdFx0dGhpcy5sYWJlbElucHV0Q29udGFpbmVyLmFkZENoaWxkKHRoaXMubGFiZWxJbnB1dCk7XG5cdH1cblxuXHRwcml2YXRlIGhpZGVMYWJlbElucHV0KCk6IHZvaWQge1xuXHRcdHRoaXMubGFiZWxJbnB1dCA9IG51bGw7XG5cdFx0dGhpcy5sYWJlbElucHV0Q29udGFpbmVyLmNsZWFyKCk7XG5cdFx0dGhpcy50cmVlQ29udGFpbmVyLmNsZWFyKCk7XG5cdFx0dGhpcy50cmVlQ29udGFpbmVyLmFkZENoaWxkKHRoaXMudHJlZUxpc3QpO1xuXHR9XG5cblx0aGFuZGxlSW5wdXQoa2V5RGF0YTogc3RyaW5nKTogdm9pZCB7XG5cdFx0aWYgKHRoaXMubGFiZWxJbnB1dCkge1xuXHRcdFx0dGhpcy5sYWJlbElucHV0LmhhbmRsZUlucHV0KGtleURhdGEpO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHR0aGlzLnRyZWVMaXN0LmhhbmRsZUlucHV0KGtleURhdGEpO1xuXHRcdH1cblx0fVxuXG5cdGdldFRyZWVMaXN0KCk6IFRyZWVMaXN0IHtcblx0XHRyZXR1cm4gdGhpcy50cmVlTGlzdDtcblx0fVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUE7QUFBQSxFQUVDO0FBQUEsRUFFQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ007QUFFUCxTQUFTLGFBQWE7QUFDdEIsU0FBUyxx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
