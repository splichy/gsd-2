import { readdirSync, statSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import { fuzzyFind } from "@gsd/native/fd";
import { fuzzyFilter } from "./fuzzy.js";
const PATH_DELIMITERS = /* @__PURE__ */ new Set([" ", "	", '"', "'", "="]);
const FUZZY_FILE_MAX_RESULTS = 20;
function findLastDelimiter(text) {
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (PATH_DELIMITERS.has(text[i] ?? "")) {
      return i;
    }
  }
  return -1;
}
function findUnclosedQuoteStart(text) {
  let inQuotes = false;
  let quoteStart = -1;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '"') {
      inQuotes = !inQuotes;
      if (inQuotes) {
        quoteStart = i;
      }
    }
  }
  return inQuotes ? quoteStart : null;
}
function isTokenStart(text, index) {
  return index === 0 || PATH_DELIMITERS.has(text[index - 1] ?? "");
}
function extractQuotedPrefix(text) {
  const quoteStart = findUnclosedQuoteStart(text);
  if (quoteStart === null) {
    return null;
  }
  if (quoteStart > 0 && text[quoteStart - 1] === "@") {
    if (!isTokenStart(text, quoteStart - 1)) {
      return null;
    }
    return text.slice(quoteStart - 1);
  }
  if (!isTokenStart(text, quoteStart)) {
    return null;
  }
  return text.slice(quoteStart);
}
function parsePathPrefix(prefix) {
  if (prefix.startsWith('@"')) {
    return { rawPrefix: prefix.slice(2), isAtPrefix: true, isQuotedPrefix: true };
  }
  if (prefix.startsWith('"')) {
    return { rawPrefix: prefix.slice(1), isAtPrefix: false, isQuotedPrefix: true };
  }
  if (prefix.startsWith("@")) {
    return { rawPrefix: prefix.slice(1), isAtPrefix: true, isQuotedPrefix: false };
  }
  return { rawPrefix: prefix, isAtPrefix: false, isQuotedPrefix: false };
}
function buildCompletionValue(path, options) {
  const needsQuotes = options.isQuotedPrefix || path.includes(" ");
  const prefix = options.isAtPrefix ? "@" : "";
  if (!needsQuotes) {
    return `${prefix}${path}`;
  }
  const openQuote = `${prefix}"`;
  const closeQuote = '"';
  return `${openQuote}${path}${closeQuote}`;
}
class CombinedAutocompleteProvider {
  constructor(commands = [], basePath = process.cwd(), options) {
    this.commands = commands;
    this.basePath = basePath;
    this.respectGitignore = options?.respectGitignore ?? true;
    this.excludeDirs = new Set(options?.excludeDirs ?? []);
  }
  setRespectGitignore(value) {
    this.respectGitignore = value;
  }
  setExcludeDirs(dirs) {
    this.excludeDirs = new Set(dirs.filter(Boolean));
  }
  getSuggestions(lines, cursorLine, cursorCol) {
    const currentLine = lines[cursorLine] || "";
    const textBeforeCursor = currentLine.slice(0, cursorCol);
    const trimmedBeforeCursor = textBeforeCursor.trimStart();
    const atPrefix = this.extractAtPrefix(textBeforeCursor);
    if (atPrefix) {
      const { rawPrefix, isQuotedPrefix } = parsePathPrefix(atPrefix);
      const suggestions = this.getFuzzyFileSuggestions(rawPrefix, { isQuotedPrefix });
      if (suggestions.length === 0) return null;
      return {
        items: suggestions,
        prefix: atPrefix
      };
    }
    if (trimmedBeforeCursor.startsWith("/")) {
      const spaceIndex = trimmedBeforeCursor.indexOf(" ");
      if (spaceIndex === -1) {
        const prefix = trimmedBeforeCursor.slice(1);
        const commandItems = this.commands.map((cmd) => ({
          name: "name" in cmd ? cmd.name : cmd.value,
          label: "name" in cmd ? cmd.name : cmd.label,
          description: cmd.description
        }));
        const filtered = fuzzyFilter(commandItems, prefix, (item) => item.name).map((item) => ({
          value: item.name,
          label: item.label,
          ...item.description && { description: item.description }
        }));
        if (filtered.length === 0) return null;
        return {
          items: filtered,
          prefix: `/${prefix}`
        };
      } else {
        const commandName = trimmedBeforeCursor.slice(1, spaceIndex);
        const argumentText = trimmedBeforeCursor.slice(spaceIndex + 1);
        const command = this.commands.find((cmd) => {
          const name = "name" in cmd ? cmd.name : cmd.value;
          return name === commandName;
        });
        if (!command || !("getArgumentCompletions" in command) || !command.getArgumentCompletions) {
          return null;
        }
        const argumentSuggestions = command.getArgumentCompletions(argumentText);
        if (!argumentSuggestions || argumentSuggestions.length === 0) {
          return null;
        }
        return {
          items: argumentSuggestions,
          prefix: argumentText
        };
      }
    }
    const pathMatch = this.extractPathPrefix(textBeforeCursor, false);
    if (pathMatch !== null) {
      const suggestions = this.getFileSuggestions(pathMatch);
      if (suggestions.length === 0) return null;
      if (suggestions.length === 1 && suggestions[0]?.value === pathMatch && !pathMatch.endsWith("/")) {
        return {
          items: suggestions,
          prefix: pathMatch
        };
      }
      return {
        items: suggestions,
        prefix: pathMatch
      };
    }
    return null;
  }
  applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
    const currentLine = lines[cursorLine] || "";
    const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
    const afterCursor = currentLine.slice(cursorCol);
    const isQuotedPrefix = prefix.startsWith('"') || prefix.startsWith('@"');
    const hasLeadingQuoteAfterCursor = afterCursor.startsWith('"');
    const hasTrailingQuoteInItem = item.value.endsWith('"');
    const adjustedAfterCursor = isQuotedPrefix && hasTrailingQuoteInItem && hasLeadingQuoteAfterCursor ? afterCursor.slice(1) : afterCursor;
    const trimmedPrefix = prefix.trimStart();
    const isSlashCommand = trimmedPrefix.startsWith("/") && beforePrefix.trim() === "" && !trimmedPrefix.slice(1).includes("/");
    if (isSlashCommand) {
      const newLine2 = `${beforePrefix}/${item.value} ${adjustedAfterCursor}`;
      const newLines2 = [...lines];
      newLines2[cursorLine] = newLine2;
      return {
        lines: newLines2,
        cursorLine,
        cursorCol: beforePrefix.length + item.value.length + 2
        // +2 for "/" and space
      };
    }
    if (prefix.startsWith("@")) {
      const isDirectory2 = item.label.endsWith("/");
      const suffix = isDirectory2 ? "" : " ";
      const newLine2 = `${beforePrefix + item.value}${suffix}${adjustedAfterCursor}`;
      const newLines2 = [...lines];
      newLines2[cursorLine] = newLine2;
      const hasTrailingQuote2 = item.value.endsWith('"');
      const cursorOffset2 = isDirectory2 && hasTrailingQuote2 ? item.value.length - 1 : item.value.length;
      return {
        lines: newLines2,
        cursorLine,
        cursorCol: beforePrefix.length + cursorOffset2 + suffix.length
      };
    }
    const textBeforeCursor = currentLine.slice(0, cursorCol);
    if (textBeforeCursor.includes("/") && textBeforeCursor.includes(" ")) {
      const newLine2 = beforePrefix + item.value + adjustedAfterCursor;
      const newLines2 = [...lines];
      newLines2[cursorLine] = newLine2;
      const isDirectory2 = item.label.endsWith("/");
      const hasTrailingQuote2 = item.value.endsWith('"');
      const cursorOffset2 = isDirectory2 && hasTrailingQuote2 ? item.value.length - 1 : item.value.length;
      return {
        lines: newLines2,
        cursorLine,
        cursorCol: beforePrefix.length + cursorOffset2
      };
    }
    const newLine = beforePrefix + item.value + adjustedAfterCursor;
    const newLines = [...lines];
    newLines[cursorLine] = newLine;
    const isDirectory = item.label.endsWith("/");
    const hasTrailingQuote = item.value.endsWith('"');
    const cursorOffset = isDirectory && hasTrailingQuote ? item.value.length - 1 : item.value.length;
    return {
      lines: newLines,
      cursorLine,
      cursorCol: beforePrefix.length + cursorOffset
    };
  }
  // Extract @ prefix for fuzzy file suggestions
  extractAtPrefix(text) {
    const quotedPrefix = extractQuotedPrefix(text);
    if (quotedPrefix?.startsWith('@"')) {
      return quotedPrefix;
    }
    const lastDelimiterIndex = findLastDelimiter(text);
    const tokenStart = lastDelimiterIndex === -1 ? 0 : lastDelimiterIndex + 1;
    if (text[tokenStart] === "@") {
      return text.slice(tokenStart);
    }
    return null;
  }
  // Extract a path-like prefix from the text before cursor
  extractPathPrefix(text, forceExtract = false) {
    const quotedPrefix = extractQuotedPrefix(text);
    if (quotedPrefix) {
      return quotedPrefix;
    }
    const lastDelimiterIndex = findLastDelimiter(text);
    const pathPrefix = lastDelimiterIndex === -1 ? text : text.slice(lastDelimiterIndex + 1);
    if (forceExtract) {
      return pathPrefix;
    }
    if (pathPrefix.includes("/") || pathPrefix.startsWith(".") || pathPrefix.startsWith("~/")) {
      return pathPrefix;
    }
    if (pathPrefix === "" && text.endsWith(" ")) {
      return pathPrefix;
    }
    return null;
  }
  // Expand home directory (~/) to actual home path
  expandHomePath(path) {
    if (path.startsWith("~/")) {
      const expandedPath = join(homedir(), path.slice(2));
      return path.endsWith("/") && !expandedPath.endsWith("/") ? `${expandedPath}/` : expandedPath;
    } else if (path === "~") {
      return homedir();
    }
    return path;
  }
  resolveScopedFuzzyQuery(rawQuery) {
    const slashIndex = rawQuery.lastIndexOf("/");
    if (slashIndex === -1) {
      return null;
    }
    const displayBase = rawQuery.slice(0, slashIndex + 1);
    const query = rawQuery.slice(slashIndex + 1);
    let baseDir;
    if (displayBase.startsWith("~/")) {
      baseDir = this.expandHomePath(displayBase);
    } else if (displayBase.startsWith("/")) {
      baseDir = displayBase;
    } else {
      baseDir = join(this.basePath, displayBase);
    }
    try {
      if (!statSync(baseDir).isDirectory()) {
        return null;
      }
    } catch {
      return null;
    }
    return { baseDir, query, displayBase };
  }
  scopedPathForDisplay(displayBase, relativePath) {
    if (displayBase === "/") {
      return `/${relativePath}`;
    }
    return `${displayBase}${relativePath}`;
  }
  // Get file/directory suggestions for a given path prefix
  getFileSuggestions(prefix) {
    try {
      let searchDir;
      let searchPrefix;
      const { rawPrefix, isAtPrefix, isQuotedPrefix } = parsePathPrefix(prefix);
      let expandedPrefix = rawPrefix;
      if (expandedPrefix.startsWith("~")) {
        expandedPrefix = this.expandHomePath(expandedPrefix);
      }
      const isRootPrefix = rawPrefix === "" || rawPrefix === "./" || rawPrefix === "../" || rawPrefix === "~" || rawPrefix === "~/" || rawPrefix === "/" || isAtPrefix && rawPrefix === "";
      if (isRootPrefix) {
        if (rawPrefix.startsWith("~") || expandedPrefix.startsWith("/")) {
          searchDir = expandedPrefix;
        } else {
          searchDir = join(this.basePath, expandedPrefix);
        }
        searchPrefix = "";
      } else if (rawPrefix.endsWith("/")) {
        if (rawPrefix.startsWith("~") || expandedPrefix.startsWith("/")) {
          searchDir = expandedPrefix;
        } else {
          searchDir = join(this.basePath, expandedPrefix);
        }
        searchPrefix = "";
      } else {
        const dir = dirname(expandedPrefix);
        const file = basename(expandedPrefix);
        if (rawPrefix.startsWith("~") || expandedPrefix.startsWith("/")) {
          searchDir = dir;
        } else {
          searchDir = join(this.basePath, dir);
        }
        searchPrefix = file;
      }
      const entries = readdirSync(searchDir, { withFileTypes: true });
      const suggestions = [];
      for (const entry of entries) {
        if (!entry.name.toLowerCase().startsWith(searchPrefix.toLowerCase())) {
          continue;
        }
        if (this.excludeDirs.has(entry.name)) {
          continue;
        }
        let isDirectory = entry.isDirectory();
        if (!isDirectory && entry.isSymbolicLink()) {
          try {
            const fullPath = join(searchDir, entry.name);
            isDirectory = statSync(fullPath).isDirectory();
          } catch {
          }
        }
        let relativePath;
        const name = entry.name;
        const displayPrefix = rawPrefix;
        if (displayPrefix.endsWith("/")) {
          relativePath = displayPrefix + name;
        } else if (displayPrefix.includes("/")) {
          if (displayPrefix.startsWith("~/")) {
            const homeRelativeDir = displayPrefix.slice(2);
            const dir = dirname(homeRelativeDir);
            relativePath = `~/${dir === "." ? name : join(dir, name)}`;
          } else if (displayPrefix.startsWith("/")) {
            const dir = dirname(displayPrefix);
            if (dir === "/") {
              relativePath = `/${name}`;
            } else {
              relativePath = `${dir}/${name}`;
            }
          } else {
            relativePath = join(dirname(displayPrefix), name);
          }
        } else {
          if (displayPrefix.startsWith("~")) {
            relativePath = `~/${name}`;
          } else {
            relativePath = name;
          }
        }
        const pathValue = isDirectory ? `${relativePath}/` : relativePath;
        const value = buildCompletionValue(pathValue, {
          isDirectory,
          isAtPrefix,
          isQuotedPrefix
        });
        suggestions.push({
          value,
          label: name + (isDirectory ? "/" : "")
        });
      }
      suggestions.sort((a, b) => {
        const aIsDir = a.value.endsWith("/");
        const bIsDir = b.value.endsWith("/");
        if (aIsDir && !bIsDir) return -1;
        if (!aIsDir && bIsDir) return 1;
        return a.label.localeCompare(b.label);
      });
      return suggestions;
    } catch (_e) {
      return [];
    }
  }
  // Fuzzy file search using the native fd module (fast, respects .gitignore)
  getFuzzyFileSuggestions(query, options) {
    try {
      const scopedQuery = this.resolveScopedFuzzyQuery(query);
      const searchQuery = scopedQuery?.query ?? query;
      if (searchQuery.length === 0 && !scopedQuery) {
        return [];
      }
      const searchPath = scopedQuery?.baseDir ?? this.basePath;
      const result = fuzzyFind({
        query: searchQuery,
        path: searchPath,
        hidden: true,
        gitignore: this.respectGitignore,
        maxResults: FUZZY_FILE_MAX_RESULTS
      });
      const suggestions = [];
      for (const { path: entryPath, isDirectory } of result.matches) {
        const pathWithoutSlash = isDirectory ? entryPath.slice(0, -1) : entryPath;
        if (this.excludeDirs.size > 0) {
          const segments = pathWithoutSlash.split("/");
          if (segments.some((seg) => this.excludeDirs.has(seg))) continue;
        }
        const displayPath = scopedQuery ? this.scopedPathForDisplay(scopedQuery.displayBase, pathWithoutSlash) : pathWithoutSlash;
        const entryName = basename(pathWithoutSlash);
        const completionPath = isDirectory ? `${displayPath}/` : displayPath;
        const value = buildCompletionValue(completionPath, {
          isDirectory,
          isAtPrefix: true,
          isQuotedPrefix: options.isQuotedPrefix
        });
        suggestions.push({
          value,
          label: entryName + (isDirectory ? "/" : ""),
          description: displayPath
        });
      }
      return suggestions;
    } catch {
      return [];
    }
  }
  // Force file completion (called on Tab key) - always returns suggestions
  getForceFileSuggestions(lines, cursorLine, cursorCol) {
    const currentLine = lines[cursorLine] || "";
    const textBeforeCursor = currentLine.slice(0, cursorCol);
    if (textBeforeCursor.trim().startsWith("/") && !textBeforeCursor.trim().includes(" ")) {
      return null;
    }
    const pathMatch = this.extractPathPrefix(textBeforeCursor, true);
    if (pathMatch !== null) {
      const suggestions = this.getFileSuggestions(pathMatch);
      if (suggestions.length === 0) return null;
      return {
        items: suggestions,
        prefix: pathMatch
      };
    }
    return null;
  }
  // Check if we should trigger file completion (called on Tab key)
  shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
    const currentLine = lines[cursorLine] || "";
    const textBeforeCursor = currentLine.slice(0, cursorCol);
    if (textBeforeCursor.trim().startsWith("/") && !textBeforeCursor.trim().includes(" ")) {
      return false;
    }
    return true;
  }
}
export {
  CombinedAutocompleteProvider
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktdHVpL3NyYy9hdXRvY29tcGxldGUudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IHJlYWRkaXJTeW5jLCBzdGF0U3luYyB9IGZyb20gXCJmc1wiO1xuaW1wb3J0IHsgaG9tZWRpciB9IGZyb20gXCJvc1wiO1xuaW1wb3J0IHsgYmFzZW5hbWUsIGRpcm5hbWUsIGpvaW4gfSBmcm9tIFwicGF0aFwiO1xuaW1wb3J0IHsgZnV6enlGaW5kIH0gZnJvbSBcIkBnc2QvbmF0aXZlL2ZkXCI7XG5pbXBvcnQgeyBmdXp6eUZpbHRlciB9IGZyb20gXCIuL2Z1enp5LmpzXCI7XG5cbmNvbnN0IFBBVEhfREVMSU1JVEVSUyA9IG5ldyBTZXQoW1wiIFwiLCBcIlxcdFwiLCAnXCInLCBcIidcIiwgXCI9XCJdKTtcbmNvbnN0IEZVWlpZX0ZJTEVfTUFYX1JFU1VMVFMgPSAyMDtcblxuZnVuY3Rpb24gZmluZExhc3REZWxpbWl0ZXIodGV4dDogc3RyaW5nKTogbnVtYmVyIHtcblx0Zm9yIChsZXQgaSA9IHRleHQubGVuZ3RoIC0gMTsgaSA+PSAwOyBpIC09IDEpIHtcblx0XHRpZiAoUEFUSF9ERUxJTUlURVJTLmhhcyh0ZXh0W2ldID8/IFwiXCIpKSB7XG5cdFx0XHRyZXR1cm4gaTtcblx0XHR9XG5cdH1cblx0cmV0dXJuIC0xO1xufVxuXG5mdW5jdGlvbiBmaW5kVW5jbG9zZWRRdW90ZVN0YXJ0KHRleHQ6IHN0cmluZyk6IG51bWJlciB8IG51bGwge1xuXHRsZXQgaW5RdW90ZXMgPSBmYWxzZTtcblx0bGV0IHF1b3RlU3RhcnQgPSAtMTtcblxuXHRmb3IgKGxldCBpID0gMDsgaSA8IHRleHQubGVuZ3RoOyBpICs9IDEpIHtcblx0XHRpZiAodGV4dFtpXSA9PT0gJ1wiJykge1xuXHRcdFx0aW5RdW90ZXMgPSAhaW5RdW90ZXM7XG5cdFx0XHRpZiAoaW5RdW90ZXMpIHtcblx0XHRcdFx0cXVvdGVTdGFydCA9IGk7XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG5cblx0cmV0dXJuIGluUXVvdGVzID8gcXVvdGVTdGFydCA6IG51bGw7XG59XG5cbmZ1bmN0aW9uIGlzVG9rZW5TdGFydCh0ZXh0OiBzdHJpbmcsIGluZGV4OiBudW1iZXIpOiBib29sZWFuIHtcblx0cmV0dXJuIGluZGV4ID09PSAwIHx8IFBBVEhfREVMSU1JVEVSUy5oYXModGV4dFtpbmRleCAtIDFdID8/IFwiXCIpO1xufVxuXG5mdW5jdGlvbiBleHRyYWN0UXVvdGVkUHJlZml4KHRleHQ6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuXHRjb25zdCBxdW90ZVN0YXJ0ID0gZmluZFVuY2xvc2VkUXVvdGVTdGFydCh0ZXh0KTtcblx0aWYgKHF1b3RlU3RhcnQgPT09IG51bGwpIHtcblx0XHRyZXR1cm4gbnVsbDtcblx0fVxuXG5cdGlmIChxdW90ZVN0YXJ0ID4gMCAmJiB0ZXh0W3F1b3RlU3RhcnQgLSAxXSA9PT0gXCJAXCIpIHtcblx0XHRpZiAoIWlzVG9rZW5TdGFydCh0ZXh0LCBxdW90ZVN0YXJ0IC0gMSkpIHtcblx0XHRcdHJldHVybiBudWxsO1xuXHRcdH1cblx0XHRyZXR1cm4gdGV4dC5zbGljZShxdW90ZVN0YXJ0IC0gMSk7XG5cdH1cblxuXHRpZiAoIWlzVG9rZW5TdGFydCh0ZXh0LCBxdW90ZVN0YXJ0KSkge1xuXHRcdHJldHVybiBudWxsO1xuXHR9XG5cblx0cmV0dXJuIHRleHQuc2xpY2UocXVvdGVTdGFydCk7XG59XG5cbmZ1bmN0aW9uIHBhcnNlUGF0aFByZWZpeChwcmVmaXg6IHN0cmluZyk6IHsgcmF3UHJlZml4OiBzdHJpbmc7IGlzQXRQcmVmaXg6IGJvb2xlYW47IGlzUXVvdGVkUHJlZml4OiBib29sZWFuIH0ge1xuXHRpZiAocHJlZml4LnN0YXJ0c1dpdGgoJ0BcIicpKSB7XG5cdFx0cmV0dXJuIHsgcmF3UHJlZml4OiBwcmVmaXguc2xpY2UoMiksIGlzQXRQcmVmaXg6IHRydWUsIGlzUXVvdGVkUHJlZml4OiB0cnVlIH07XG5cdH1cblx0aWYgKHByZWZpeC5zdGFydHNXaXRoKCdcIicpKSB7XG5cdFx0cmV0dXJuIHsgcmF3UHJlZml4OiBwcmVmaXguc2xpY2UoMSksIGlzQXRQcmVmaXg6IGZhbHNlLCBpc1F1b3RlZFByZWZpeDogdHJ1ZSB9O1xuXHR9XG5cdGlmIChwcmVmaXguc3RhcnRzV2l0aChcIkBcIikpIHtcblx0XHRyZXR1cm4geyByYXdQcmVmaXg6IHByZWZpeC5zbGljZSgxKSwgaXNBdFByZWZpeDogdHJ1ZSwgaXNRdW90ZWRQcmVmaXg6IGZhbHNlIH07XG5cdH1cblx0cmV0dXJuIHsgcmF3UHJlZml4OiBwcmVmaXgsIGlzQXRQcmVmaXg6IGZhbHNlLCBpc1F1b3RlZFByZWZpeDogZmFsc2UgfTtcbn1cblxuZnVuY3Rpb24gYnVpbGRDb21wbGV0aW9uVmFsdWUoXG5cdHBhdGg6IHN0cmluZyxcblx0b3B0aW9uczogeyBpc0RpcmVjdG9yeTogYm9vbGVhbjsgaXNBdFByZWZpeDogYm9vbGVhbjsgaXNRdW90ZWRQcmVmaXg6IGJvb2xlYW4gfSxcbik6IHN0cmluZyB7XG5cdGNvbnN0IG5lZWRzUXVvdGVzID0gb3B0aW9ucy5pc1F1b3RlZFByZWZpeCB8fCBwYXRoLmluY2x1ZGVzKFwiIFwiKTtcblx0Y29uc3QgcHJlZml4ID0gb3B0aW9ucy5pc0F0UHJlZml4ID8gXCJAXCIgOiBcIlwiO1xuXG5cdGlmICghbmVlZHNRdW90ZXMpIHtcblx0XHRyZXR1cm4gYCR7cHJlZml4fSR7cGF0aH1gO1xuXHR9XG5cblx0Y29uc3Qgb3BlblF1b3RlID0gYCR7cHJlZml4fVwiYDtcblx0Y29uc3QgY2xvc2VRdW90ZSA9ICdcIic7XG5cdHJldHVybiBgJHtvcGVuUXVvdGV9JHtwYXRofSR7Y2xvc2VRdW90ZX1gO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEF1dG9jb21wbGV0ZUl0ZW0ge1xuXHR2YWx1ZTogc3RyaW5nO1xuXHRsYWJlbDogc3RyaW5nO1xuXHRkZXNjcmlwdGlvbj86IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBTbGFzaENvbW1hbmQge1xuXHRuYW1lOiBzdHJpbmc7XG5cdGRlc2NyaXB0aW9uPzogc3RyaW5nO1xuXHQvLyBGdW5jdGlvbiB0byBnZXQgYXJndW1lbnQgY29tcGxldGlvbnMgZm9yIHRoaXMgY29tbWFuZFxuXHQvLyBSZXR1cm5zIG51bGwgaWYgbm8gYXJndW1lbnQgY29tcGxldGlvbiBpcyBhdmFpbGFibGVcblx0Z2V0QXJndW1lbnRDb21wbGV0aW9ucz8oYXJndW1lbnRQcmVmaXg6IHN0cmluZyk6IEF1dG9jb21wbGV0ZUl0ZW1bXSB8IG51bGw7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXV0b2NvbXBsZXRlUHJvdmlkZXIge1xuXHQvLyBHZXQgYXV0b2NvbXBsZXRlIHN1Z2dlc3Rpb25zIGZvciBjdXJyZW50IHRleHQvY3Vyc29yIHBvc2l0aW9uXG5cdC8vIFJldHVybnMgbnVsbCBpZiBubyBzdWdnZXN0aW9ucyBhdmFpbGFibGVcblx0Z2V0U3VnZ2VzdGlvbnMoXG5cdFx0bGluZXM6IHN0cmluZ1tdLFxuXHRcdGN1cnNvckxpbmU6IG51bWJlcixcblx0XHRjdXJzb3JDb2w6IG51bWJlcixcblx0KToge1xuXHRcdGl0ZW1zOiBBdXRvY29tcGxldGVJdGVtW107XG5cdFx0cHJlZml4OiBzdHJpbmc7IC8vIFdoYXQgd2UncmUgbWF0Y2hpbmcgYWdhaW5zdCAoZS5nLiwgXCIvXCIgb3IgXCJzcmMvXCIpXG5cdH0gfCBudWxsO1xuXG5cdC8vIEFwcGx5IHRoZSBzZWxlY3RlZCBpdGVtXG5cdC8vIFJldHVybnMgdGhlIG5ldyB0ZXh0IGFuZCBjdXJzb3IgcG9zaXRpb25cblx0YXBwbHlDb21wbGV0aW9uKFxuXHRcdGxpbmVzOiBzdHJpbmdbXSxcblx0XHRjdXJzb3JMaW5lOiBudW1iZXIsXG5cdFx0Y3Vyc29yQ29sOiBudW1iZXIsXG5cdFx0aXRlbTogQXV0b2NvbXBsZXRlSXRlbSxcblx0XHRwcmVmaXg6IHN0cmluZyxcblx0KToge1xuXHRcdGxpbmVzOiBzdHJpbmdbXTtcblx0XHRjdXJzb3JMaW5lOiBudW1iZXI7XG5cdFx0Y3Vyc29yQ29sOiBudW1iZXI7XG5cdH07XG59XG5cbi8vIENvbWJpbmVkIHByb3ZpZGVyIHRoYXQgaGFuZGxlcyBib3RoIHNsYXNoIGNvbW1hbmRzIGFuZCBmaWxlIHBhdGhzXG5leHBvcnQgY2xhc3MgQ29tYmluZWRBdXRvY29tcGxldGVQcm92aWRlciBpbXBsZW1lbnRzIEF1dG9jb21wbGV0ZVByb3ZpZGVyIHtcblx0cHJpdmF0ZSBjb21tYW5kczogKFNsYXNoQ29tbWFuZCB8IEF1dG9jb21wbGV0ZUl0ZW0pW107XG5cdHByaXZhdGUgYmFzZVBhdGg6IHN0cmluZztcblx0cHJpdmF0ZSByZXNwZWN0R2l0aWdub3JlOiBib29sZWFuO1xuXHRwcml2YXRlIGV4Y2x1ZGVEaXJzOiBTZXQ8c3RyaW5nPjtcblxuXHRjb25zdHJ1Y3Rvcihcblx0XHRjb21tYW5kczogKFNsYXNoQ29tbWFuZCB8IEF1dG9jb21wbGV0ZUl0ZW0pW10gPSBbXSxcblx0XHRiYXNlUGF0aDogc3RyaW5nID0gcHJvY2Vzcy5jd2QoKSxcblx0XHRvcHRpb25zPzogeyByZXNwZWN0R2l0aWdub3JlPzogYm9vbGVhbjsgZXhjbHVkZURpcnM/OiBzdHJpbmdbXSB9LFxuXHQpIHtcblx0XHR0aGlzLmNvbW1hbmRzID0gY29tbWFuZHM7XG5cdFx0dGhpcy5iYXNlUGF0aCA9IGJhc2VQYXRoO1xuXHRcdHRoaXMucmVzcGVjdEdpdGlnbm9yZSA9IG9wdGlvbnM/LnJlc3BlY3RHaXRpZ25vcmUgPz8gdHJ1ZTtcblx0XHR0aGlzLmV4Y2x1ZGVEaXJzID0gbmV3IFNldChvcHRpb25zPy5leGNsdWRlRGlycyA/PyBbXSk7XG5cdH1cblxuXHRzZXRSZXNwZWN0R2l0aWdub3JlKHZhbHVlOiBib29sZWFuKTogdm9pZCB7XG5cdFx0dGhpcy5yZXNwZWN0R2l0aWdub3JlID0gdmFsdWU7XG5cdH1cblxuXHRzZXRFeGNsdWRlRGlycyhkaXJzOiBzdHJpbmdbXSk6IHZvaWQge1xuXHRcdHRoaXMuZXhjbHVkZURpcnMgPSBuZXcgU2V0KGRpcnMuZmlsdGVyKEJvb2xlYW4pKTtcblx0fVxuXG5cdGdldFN1Z2dlc3Rpb25zKFxuXHRcdGxpbmVzOiBzdHJpbmdbXSxcblx0XHRjdXJzb3JMaW5lOiBudW1iZXIsXG5cdFx0Y3Vyc29yQ29sOiBudW1iZXIsXG5cdCk6IHsgaXRlbXM6IEF1dG9jb21wbGV0ZUl0ZW1bXTsgcHJlZml4OiBzdHJpbmcgfSB8IG51bGwge1xuXHRcdGNvbnN0IGN1cnJlbnRMaW5lID0gbGluZXNbY3Vyc29yTGluZV0gfHwgXCJcIjtcblx0XHRjb25zdCB0ZXh0QmVmb3JlQ3Vyc29yID0gY3VycmVudExpbmUuc2xpY2UoMCwgY3Vyc29yQ29sKTtcblx0XHRjb25zdCB0cmltbWVkQmVmb3JlQ3Vyc29yID0gdGV4dEJlZm9yZUN1cnNvci50cmltU3RhcnQoKTtcblxuXHRcdC8vIENoZWNrIGZvciBAIGZpbGUgcmVmZXJlbmNlIChmdXp6eSBzZWFyY2gpIC0gbXVzdCBiZSBhZnRlciBhIGRlbGltaXRlciBvciBhdCBzdGFydFxuXHRcdGNvbnN0IGF0UHJlZml4ID0gdGhpcy5leHRyYWN0QXRQcmVmaXgodGV4dEJlZm9yZUN1cnNvcik7XG5cdFx0aWYgKGF0UHJlZml4KSB7XG5cdFx0XHRjb25zdCB7IHJhd1ByZWZpeCwgaXNRdW90ZWRQcmVmaXggfSA9IHBhcnNlUGF0aFByZWZpeChhdFByZWZpeCk7XG5cdFx0XHRjb25zdCBzdWdnZXN0aW9ucyA9IHRoaXMuZ2V0RnV6enlGaWxlU3VnZ2VzdGlvbnMocmF3UHJlZml4LCB7IGlzUXVvdGVkUHJlZml4OiBpc1F1b3RlZFByZWZpeCB9KTtcblx0XHRcdGlmIChzdWdnZXN0aW9ucy5sZW5ndGggPT09IDApIHJldHVybiBudWxsO1xuXG5cdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRpdGVtczogc3VnZ2VzdGlvbnMsXG5cdFx0XHRcdHByZWZpeDogYXRQcmVmaXgsXG5cdFx0XHR9O1xuXHRcdH1cblxuXHRcdC8vIENoZWNrIGZvciBzbGFzaCBjb21tYW5kc1xuXHRcdGlmICh0cmltbWVkQmVmb3JlQ3Vyc29yLnN0YXJ0c1dpdGgoXCIvXCIpKSB7XG5cdFx0XHRjb25zdCBzcGFjZUluZGV4ID0gdHJpbW1lZEJlZm9yZUN1cnNvci5pbmRleE9mKFwiIFwiKTtcblxuXHRcdFx0aWYgKHNwYWNlSW5kZXggPT09IC0xKSB7XG5cdFx0XHRcdC8vIE5vIHNwYWNlIHlldCAtIGNvbXBsZXRlIGNvbW1hbmQgbmFtZXMgd2l0aCBmdXp6eSBtYXRjaGluZ1xuXHRcdFx0XHRjb25zdCBwcmVmaXggPSB0cmltbWVkQmVmb3JlQ3Vyc29yLnNsaWNlKDEpOyAvLyBSZW1vdmUgdGhlIFwiL1wiXG5cdFx0XHRcdGNvbnN0IGNvbW1hbmRJdGVtcyA9IHRoaXMuY29tbWFuZHMubWFwKChjbWQpID0+ICh7XG5cdFx0XHRcdFx0bmFtZTogXCJuYW1lXCIgaW4gY21kID8gY21kLm5hbWUgOiBjbWQudmFsdWUsXG5cdFx0XHRcdFx0bGFiZWw6IFwibmFtZVwiIGluIGNtZCA/IGNtZC5uYW1lIDogY21kLmxhYmVsLFxuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOiBjbWQuZGVzY3JpcHRpb24sXG5cdFx0XHRcdH0pKTtcblxuXHRcdFx0XHRjb25zdCBmaWx0ZXJlZCA9IGZ1enp5RmlsdGVyKGNvbW1hbmRJdGVtcywgcHJlZml4LCAoaXRlbSkgPT4gaXRlbS5uYW1lKS5tYXAoKGl0ZW0pID0+ICh7XG5cdFx0XHRcdFx0dmFsdWU6IGl0ZW0ubmFtZSxcblx0XHRcdFx0XHRsYWJlbDogaXRlbS5sYWJlbCxcblx0XHRcdFx0XHQuLi4oaXRlbS5kZXNjcmlwdGlvbiAmJiB7IGRlc2NyaXB0aW9uOiBpdGVtLmRlc2NyaXB0aW9uIH0pLFxuXHRcdFx0XHR9KSk7XG5cblx0XHRcdFx0aWYgKGZpbHRlcmVkLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG5cblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRpdGVtczogZmlsdGVyZWQsXG5cdFx0XHRcdFx0cHJlZml4OiBgLyR7cHJlZml4fWAsXG5cdFx0XHRcdH07XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHQvLyBTcGFjZSBmb3VuZCAtIGNvbXBsZXRlIGNvbW1hbmQgYXJndW1lbnRzXG5cdFx0XHRcdGNvbnN0IGNvbW1hbmROYW1lID0gdHJpbW1lZEJlZm9yZUN1cnNvci5zbGljZSgxLCBzcGFjZUluZGV4KTsgLy8gQ29tbWFuZCB3aXRob3V0IFwiL1wiXG5cdFx0XHRcdGNvbnN0IGFyZ3VtZW50VGV4dCA9IHRyaW1tZWRCZWZvcmVDdXJzb3Iuc2xpY2Uoc3BhY2VJbmRleCArIDEpOyAvLyBUZXh0IGFmdGVyIHNwYWNlXG5cblx0XHRcdFx0Y29uc3QgY29tbWFuZCA9IHRoaXMuY29tbWFuZHMuZmluZCgoY21kKSA9PiB7XG5cdFx0XHRcdFx0Y29uc3QgbmFtZSA9IFwibmFtZVwiIGluIGNtZCA/IGNtZC5uYW1lIDogY21kLnZhbHVlO1xuXHRcdFx0XHRcdHJldHVybiBuYW1lID09PSBjb21tYW5kTmFtZTtcblx0XHRcdFx0fSk7XG5cdFx0XHRcdGlmICghY29tbWFuZCB8fCAhKFwiZ2V0QXJndW1lbnRDb21wbGV0aW9uc1wiIGluIGNvbW1hbmQpIHx8ICFjb21tYW5kLmdldEFyZ3VtZW50Q29tcGxldGlvbnMpIHtcblx0XHRcdFx0XHRyZXR1cm4gbnVsbDsgLy8gTm8gYXJndW1lbnQgY29tcGxldGlvbiBmb3IgdGhpcyBjb21tYW5kXG5cdFx0XHRcdH1cblxuXHRcdFx0XHRjb25zdCBhcmd1bWVudFN1Z2dlc3Rpb25zID0gY29tbWFuZC5nZXRBcmd1bWVudENvbXBsZXRpb25zKGFyZ3VtZW50VGV4dCk7XG5cdFx0XHRcdGlmICghYXJndW1lbnRTdWdnZXN0aW9ucyB8fCBhcmd1bWVudFN1Z2dlc3Rpb25zLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0XHRcdHJldHVybiBudWxsO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRpdGVtczogYXJndW1lbnRTdWdnZXN0aW9ucyxcblx0XHRcdFx0XHRwcmVmaXg6IGFyZ3VtZW50VGV4dCxcblx0XHRcdFx0fTtcblx0XHRcdH1cblx0XHR9XG5cblx0XHQvLyBDaGVjayBmb3IgZmlsZSBwYXRocyAtIHRyaWdnZXJlZCBieSBUYWIgb3IgaWYgd2UgZGV0ZWN0IGEgcGF0aCBwYXR0ZXJuXG5cdFx0Y29uc3QgcGF0aE1hdGNoID0gdGhpcy5leHRyYWN0UGF0aFByZWZpeCh0ZXh0QmVmb3JlQ3Vyc29yLCBmYWxzZSk7XG5cblx0XHRpZiAocGF0aE1hdGNoICE9PSBudWxsKSB7XG5cdFx0XHRjb25zdCBzdWdnZXN0aW9ucyA9IHRoaXMuZ2V0RmlsZVN1Z2dlc3Rpb25zKHBhdGhNYXRjaCk7XG5cdFx0XHRpZiAoc3VnZ2VzdGlvbnMubGVuZ3RoID09PSAwKSByZXR1cm4gbnVsbDtcblxuXHRcdFx0Ly8gQ2hlY2sgaWYgd2UgaGF2ZSBhbiBleGFjdCBtYXRjaCB0aGF0IGlzIGEgZGlyZWN0b3J5XG5cdFx0XHQvLyBJbiB0aGF0IGNhc2UsIHdlIG1pZ2h0IHdhbnQgdG8gcmV0dXJuIHN1Z2dlc3Rpb25zIGZvciB0aGUgZGlyZWN0b3J5IGNvbnRlbnQgaW5zdGVhZFxuXHRcdFx0Ly8gQnV0IG9ubHkgaWYgdGhlIHByZWZpeCBlbmRzIHdpdGggL1xuXHRcdFx0aWYgKHN1Z2dlc3Rpb25zLmxlbmd0aCA9PT0gMSAmJiBzdWdnZXN0aW9uc1swXT8udmFsdWUgPT09IHBhdGhNYXRjaCAmJiAhcGF0aE1hdGNoLmVuZHNXaXRoKFwiL1wiKSkge1xuXHRcdFx0XHQvLyBFeGFjdCBtYXRjaCBmb3VuZCAoZS5nLiB1c2VyIHR5cGVkIFwic3JjXCIgYW5kIFwic3JjL1wiIGlzIHRoZSBvbmx5IG1hdGNoKVxuXHRcdFx0XHQvLyBXZSBzdGlsbCByZXR1cm4gaXQgc28gdXNlciBjYW4gc2VsZWN0IGl0IGFuZCBhZGQgL1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGl0ZW1zOiBzdWdnZXN0aW9ucyxcblx0XHRcdFx0XHRwcmVmaXg6IHBhdGhNYXRjaCxcblx0XHRcdFx0fTtcblx0XHRcdH1cblxuXHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0aXRlbXM6IHN1Z2dlc3Rpb25zLFxuXHRcdFx0XHRwcmVmaXg6IHBhdGhNYXRjaCxcblx0XHRcdH07XG5cdFx0fVxuXG5cdFx0cmV0dXJuIG51bGw7XG5cdH1cblxuXHRhcHBseUNvbXBsZXRpb24oXG5cdFx0bGluZXM6IHN0cmluZ1tdLFxuXHRcdGN1cnNvckxpbmU6IG51bWJlcixcblx0XHRjdXJzb3JDb2w6IG51bWJlcixcblx0XHRpdGVtOiBBdXRvY29tcGxldGVJdGVtLFxuXHRcdHByZWZpeDogc3RyaW5nLFxuXHQpOiB7IGxpbmVzOiBzdHJpbmdbXTsgY3Vyc29yTGluZTogbnVtYmVyOyBjdXJzb3JDb2w6IG51bWJlciB9IHtcblx0XHRjb25zdCBjdXJyZW50TGluZSA9IGxpbmVzW2N1cnNvckxpbmVdIHx8IFwiXCI7XG5cdFx0Y29uc3QgYmVmb3JlUHJlZml4ID0gY3VycmVudExpbmUuc2xpY2UoMCwgY3Vyc29yQ29sIC0gcHJlZml4Lmxlbmd0aCk7XG5cdFx0Y29uc3QgYWZ0ZXJDdXJzb3IgPSBjdXJyZW50TGluZS5zbGljZShjdXJzb3JDb2wpO1xuXHRcdGNvbnN0IGlzUXVvdGVkUHJlZml4ID0gcHJlZml4LnN0YXJ0c1dpdGgoJ1wiJykgfHwgcHJlZml4LnN0YXJ0c1dpdGgoJ0BcIicpO1xuXHRcdGNvbnN0IGhhc0xlYWRpbmdRdW90ZUFmdGVyQ3Vyc29yID0gYWZ0ZXJDdXJzb3Iuc3RhcnRzV2l0aCgnXCInKTtcblx0XHRjb25zdCBoYXNUcmFpbGluZ1F1b3RlSW5JdGVtID0gaXRlbS52YWx1ZS5lbmRzV2l0aCgnXCInKTtcblx0XHRjb25zdCBhZGp1c3RlZEFmdGVyQ3Vyc29yID1cblx0XHRcdGlzUXVvdGVkUHJlZml4ICYmIGhhc1RyYWlsaW5nUXVvdGVJbkl0ZW0gJiYgaGFzTGVhZGluZ1F1b3RlQWZ0ZXJDdXJzb3IgPyBhZnRlckN1cnNvci5zbGljZSgxKSA6IGFmdGVyQ3Vyc29yO1xuXG5cdFx0Ly8gQ2hlY2sgaWYgd2UncmUgY29tcGxldGluZyBhIHNsYXNoIGNvbW1hbmQgKHByZWZpeCBzdGFydHMgd2l0aCBcIi9cIiBidXQgTk9UIGEgZmlsZSBwYXRoKVxuXHRcdC8vIFNsYXNoIGNvbW1hbmRzIGFyZSBhdCB0aGUgc3RhcnQgb2YgdGhlIGxpbmUgYW5kIGRvbid0IGNvbnRhaW4gcGF0aCBzZXBhcmF0b3JzIGFmdGVyIHRoZSBmaXJzdCAvXG5cdFx0Y29uc3QgdHJpbW1lZFByZWZpeCA9IHByZWZpeC50cmltU3RhcnQoKTtcblx0XHRjb25zdCBpc1NsYXNoQ29tbWFuZCA9IHRyaW1tZWRQcmVmaXguc3RhcnRzV2l0aChcIi9cIikgJiYgYmVmb3JlUHJlZml4LnRyaW0oKSA9PT0gXCJcIiAmJiAhdHJpbW1lZFByZWZpeC5zbGljZSgxKS5pbmNsdWRlcyhcIi9cIik7XG5cdFx0aWYgKGlzU2xhc2hDb21tYW5kKSB7XG5cdFx0XHQvLyBUaGlzIGlzIGEgY29tbWFuZCBuYW1lIGNvbXBsZXRpb25cblx0XHRcdGNvbnN0IG5ld0xpbmUgPSBgJHtiZWZvcmVQcmVmaXh9LyR7aXRlbS52YWx1ZX0gJHthZGp1c3RlZEFmdGVyQ3Vyc29yfWA7XG5cdFx0XHRjb25zdCBuZXdMaW5lcyA9IFsuLi5saW5lc107XG5cdFx0XHRuZXdMaW5lc1tjdXJzb3JMaW5lXSA9IG5ld0xpbmU7XG5cblx0XHRcdHJldHVybiB7XG5cdFx0XHRcdGxpbmVzOiBuZXdMaW5lcyxcblx0XHRcdFx0Y3Vyc29yTGluZSxcblx0XHRcdFx0Y3Vyc29yQ29sOiBiZWZvcmVQcmVmaXgubGVuZ3RoICsgaXRlbS52YWx1ZS5sZW5ndGggKyAyLCAvLyArMiBmb3IgXCIvXCIgYW5kIHNwYWNlXG5cdFx0XHR9O1xuXHRcdH1cblxuXHRcdC8vIENoZWNrIGlmIHdlJ3JlIGNvbXBsZXRpbmcgYSBmaWxlIGF0dGFjaG1lbnQgKHByZWZpeCBzdGFydHMgd2l0aCBcIkBcIilcblx0XHRpZiAocHJlZml4LnN0YXJ0c1dpdGgoXCJAXCIpKSB7XG5cdFx0XHQvLyBUaGlzIGlzIGEgZmlsZSBhdHRhY2htZW50IGNvbXBsZXRpb25cblx0XHRcdC8vIERvbid0IGFkZCBzcGFjZSBhZnRlciBkaXJlY3RvcmllcyBzbyB1c2VyIGNhbiBjb250aW51ZSBhdXRvY29tcGxldGluZ1xuXHRcdFx0Y29uc3QgaXNEaXJlY3RvcnkgPSBpdGVtLmxhYmVsLmVuZHNXaXRoKFwiL1wiKTtcblx0XHRcdGNvbnN0IHN1ZmZpeCA9IGlzRGlyZWN0b3J5ID8gXCJcIiA6IFwiIFwiO1xuXHRcdFx0Y29uc3QgbmV3TGluZSA9IGAke2JlZm9yZVByZWZpeCArIGl0ZW0udmFsdWV9JHtzdWZmaXh9JHthZGp1c3RlZEFmdGVyQ3Vyc29yfWA7XG5cdFx0XHRjb25zdCBuZXdMaW5lcyA9IFsuLi5saW5lc107XG5cdFx0XHRuZXdMaW5lc1tjdXJzb3JMaW5lXSA9IG5ld0xpbmU7XG5cblx0XHRcdGNvbnN0IGhhc1RyYWlsaW5nUXVvdGUgPSBpdGVtLnZhbHVlLmVuZHNXaXRoKCdcIicpO1xuXHRcdFx0Y29uc3QgY3Vyc29yT2Zmc2V0ID0gaXNEaXJlY3RvcnkgJiYgaGFzVHJhaWxpbmdRdW90ZSA/IGl0ZW0udmFsdWUubGVuZ3RoIC0gMSA6IGl0ZW0udmFsdWUubGVuZ3RoO1xuXG5cdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRsaW5lczogbmV3TGluZXMsXG5cdFx0XHRcdGN1cnNvckxpbmUsXG5cdFx0XHRcdGN1cnNvckNvbDogYmVmb3JlUHJlZml4Lmxlbmd0aCArIGN1cnNvck9mZnNldCArIHN1ZmZpeC5sZW5ndGgsXG5cdFx0XHR9O1xuXHRcdH1cblxuXHRcdC8vIENoZWNrIGlmIHdlJ3JlIGluIGEgc2xhc2ggY29tbWFuZCBjb250ZXh0IChiZWZvcmVQcmVmaXggY29udGFpbnMgXCIvY29tbWFuZCBcIilcblx0XHRjb25zdCB0ZXh0QmVmb3JlQ3Vyc29yID0gY3VycmVudExpbmUuc2xpY2UoMCwgY3Vyc29yQ29sKTtcblx0XHRpZiAodGV4dEJlZm9yZUN1cnNvci5pbmNsdWRlcyhcIi9cIikgJiYgdGV4dEJlZm9yZUN1cnNvci5pbmNsdWRlcyhcIiBcIikpIHtcblx0XHRcdC8vIFRoaXMgaXMgbGlrZWx5IGEgY29tbWFuZCBhcmd1bWVudCBjb21wbGV0aW9uXG5cdFx0XHRjb25zdCBuZXdMaW5lID0gYmVmb3JlUHJlZml4ICsgaXRlbS52YWx1ZSArIGFkanVzdGVkQWZ0ZXJDdXJzb3I7XG5cdFx0XHRjb25zdCBuZXdMaW5lcyA9IFsuLi5saW5lc107XG5cdFx0XHRuZXdMaW5lc1tjdXJzb3JMaW5lXSA9IG5ld0xpbmU7XG5cblx0XHRcdGNvbnN0IGlzRGlyZWN0b3J5ID0gaXRlbS5sYWJlbC5lbmRzV2l0aChcIi9cIik7XG5cdFx0XHRjb25zdCBoYXNUcmFpbGluZ1F1b3RlID0gaXRlbS52YWx1ZS5lbmRzV2l0aCgnXCInKTtcblx0XHRcdGNvbnN0IGN1cnNvck9mZnNldCA9IGlzRGlyZWN0b3J5ICYmIGhhc1RyYWlsaW5nUXVvdGUgPyBpdGVtLnZhbHVlLmxlbmd0aCAtIDEgOiBpdGVtLnZhbHVlLmxlbmd0aDtcblxuXHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0bGluZXM6IG5ld0xpbmVzLFxuXHRcdFx0XHRjdXJzb3JMaW5lLFxuXHRcdFx0XHRjdXJzb3JDb2w6IGJlZm9yZVByZWZpeC5sZW5ndGggKyBjdXJzb3JPZmZzZXQsXG5cdFx0XHR9O1xuXHRcdH1cblxuXHRcdC8vIEZvciBmaWxlIHBhdGhzLCBjb21wbGV0ZSB0aGUgcGF0aFxuXHRcdGNvbnN0IG5ld0xpbmUgPSBiZWZvcmVQcmVmaXggKyBpdGVtLnZhbHVlICsgYWRqdXN0ZWRBZnRlckN1cnNvcjtcblx0XHRjb25zdCBuZXdMaW5lcyA9IFsuLi5saW5lc107XG5cdFx0bmV3TGluZXNbY3Vyc29yTGluZV0gPSBuZXdMaW5lO1xuXG5cdFx0Y29uc3QgaXNEaXJlY3RvcnkgPSBpdGVtLmxhYmVsLmVuZHNXaXRoKFwiL1wiKTtcblx0XHRjb25zdCBoYXNUcmFpbGluZ1F1b3RlID0gaXRlbS52YWx1ZS5lbmRzV2l0aCgnXCInKTtcblx0XHRjb25zdCBjdXJzb3JPZmZzZXQgPSBpc0RpcmVjdG9yeSAmJiBoYXNUcmFpbGluZ1F1b3RlID8gaXRlbS52YWx1ZS5sZW5ndGggLSAxIDogaXRlbS52YWx1ZS5sZW5ndGg7XG5cblx0XHRyZXR1cm4ge1xuXHRcdFx0bGluZXM6IG5ld0xpbmVzLFxuXHRcdFx0Y3Vyc29yTGluZSxcblx0XHRcdGN1cnNvckNvbDogYmVmb3JlUHJlZml4Lmxlbmd0aCArIGN1cnNvck9mZnNldCxcblx0XHR9O1xuXHR9XG5cblx0Ly8gRXh0cmFjdCBAIHByZWZpeCBmb3IgZnV6enkgZmlsZSBzdWdnZXN0aW9uc1xuXHRwcml2YXRlIGV4dHJhY3RBdFByZWZpeCh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcblx0XHRjb25zdCBxdW90ZWRQcmVmaXggPSBleHRyYWN0UXVvdGVkUHJlZml4KHRleHQpO1xuXHRcdGlmIChxdW90ZWRQcmVmaXg/LnN0YXJ0c1dpdGgoJ0BcIicpKSB7XG5cdFx0XHRyZXR1cm4gcXVvdGVkUHJlZml4O1xuXHRcdH1cblxuXHRcdGNvbnN0IGxhc3REZWxpbWl0ZXJJbmRleCA9IGZpbmRMYXN0RGVsaW1pdGVyKHRleHQpO1xuXHRcdGNvbnN0IHRva2VuU3RhcnQgPSBsYXN0RGVsaW1pdGVySW5kZXggPT09IC0xID8gMCA6IGxhc3REZWxpbWl0ZXJJbmRleCArIDE7XG5cblx0XHRpZiAodGV4dFt0b2tlblN0YXJ0XSA9PT0gXCJAXCIpIHtcblx0XHRcdHJldHVybiB0ZXh0LnNsaWNlKHRva2VuU3RhcnQpO1xuXHRcdH1cblxuXHRcdHJldHVybiBudWxsO1xuXHR9XG5cblx0Ly8gRXh0cmFjdCBhIHBhdGgtbGlrZSBwcmVmaXggZnJvbSB0aGUgdGV4dCBiZWZvcmUgY3Vyc29yXG5cdHByaXZhdGUgZXh0cmFjdFBhdGhQcmVmaXgodGV4dDogc3RyaW5nLCBmb3JjZUV4dHJhY3Q6IGJvb2xlYW4gPSBmYWxzZSk6IHN0cmluZyB8IG51bGwge1xuXHRcdGNvbnN0IHF1b3RlZFByZWZpeCA9IGV4dHJhY3RRdW90ZWRQcmVmaXgodGV4dCk7XG5cdFx0aWYgKHF1b3RlZFByZWZpeCkge1xuXHRcdFx0cmV0dXJuIHF1b3RlZFByZWZpeDtcblx0XHR9XG5cblx0XHRjb25zdCBsYXN0RGVsaW1pdGVySW5kZXggPSBmaW5kTGFzdERlbGltaXRlcih0ZXh0KTtcblx0XHRjb25zdCBwYXRoUHJlZml4ID0gbGFzdERlbGltaXRlckluZGV4ID09PSAtMSA/IHRleHQgOiB0ZXh0LnNsaWNlKGxhc3REZWxpbWl0ZXJJbmRleCArIDEpO1xuXG5cdFx0Ly8gRm9yIGZvcmNlZCBleHRyYWN0aW9uIChUYWIga2V5KSwgYWx3YXlzIHJldHVybiBzb21ldGhpbmdcblx0XHRpZiAoZm9yY2VFeHRyYWN0KSB7XG5cdFx0XHRyZXR1cm4gcGF0aFByZWZpeDtcblx0XHR9XG5cblx0XHQvLyBGb3IgbmF0dXJhbCB0cmlnZ2VycywgcmV0dXJuIGlmIGl0IGxvb2tzIGxpa2UgYSBwYXRoLCBlbmRzIHdpdGggLywgc3RhcnRzIHdpdGggfi8sIC5cblx0XHQvLyBPbmx5IHJldHVybiBlbXB0eSBzdHJpbmcgaWYgdGhlIHRleHQgbG9va3MgbGlrZSBpdCdzIHN0YXJ0aW5nIGEgcGF0aCBjb250ZXh0XG5cdFx0aWYgKHBhdGhQcmVmaXguaW5jbHVkZXMoXCIvXCIpIHx8IHBhdGhQcmVmaXguc3RhcnRzV2l0aChcIi5cIikgfHwgcGF0aFByZWZpeC5zdGFydHNXaXRoKFwifi9cIikpIHtcblx0XHRcdHJldHVybiBwYXRoUHJlZml4O1xuXHRcdH1cblxuXHRcdC8vIFJldHVybiBlbXB0eSBzdHJpbmcgb25seSBhZnRlciBhIHNwYWNlIChub3QgZm9yIGNvbXBsZXRlbHkgZW1wdHkgdGV4dClcblx0XHQvLyBFbXB0eSB0ZXh0IHNob3VsZCBub3QgdHJpZ2dlciBmaWxlIHN1Z2dlc3Rpb25zIC0gdGhhdCdzIGZvciBmb3JjZWQgVGFiIGNvbXBsZXRpb25cblx0XHRpZiAocGF0aFByZWZpeCA9PT0gXCJcIiAmJiB0ZXh0LmVuZHNXaXRoKFwiIFwiKSkge1xuXHRcdFx0cmV0dXJuIHBhdGhQcmVmaXg7XG5cdFx0fVxuXG5cdFx0cmV0dXJuIG51bGw7XG5cdH1cblxuXHQvLyBFeHBhbmQgaG9tZSBkaXJlY3RvcnkgKH4vKSB0byBhY3R1YWwgaG9tZSBwYXRoXG5cdHByaXZhdGUgZXhwYW5kSG9tZVBhdGgocGF0aDogc3RyaW5nKTogc3RyaW5nIHtcblx0XHRpZiAocGF0aC5zdGFydHNXaXRoKFwifi9cIikpIHtcblx0XHRcdGNvbnN0IGV4cGFuZGVkUGF0aCA9IGpvaW4oaG9tZWRpcigpLCBwYXRoLnNsaWNlKDIpKTtcblx0XHRcdC8vIFByZXNlcnZlIHRyYWlsaW5nIHNsYXNoIGlmIG9yaWdpbmFsIHBhdGggaGFkIG9uZVxuXHRcdFx0cmV0dXJuIHBhdGguZW5kc1dpdGgoXCIvXCIpICYmICFleHBhbmRlZFBhdGguZW5kc1dpdGgoXCIvXCIpID8gYCR7ZXhwYW5kZWRQYXRofS9gIDogZXhwYW5kZWRQYXRoO1xuXHRcdH0gZWxzZSBpZiAocGF0aCA9PT0gXCJ+XCIpIHtcblx0XHRcdHJldHVybiBob21lZGlyKCk7XG5cdFx0fVxuXHRcdHJldHVybiBwYXRoO1xuXHR9XG5cblx0cHJpdmF0ZSByZXNvbHZlU2NvcGVkRnV6enlRdWVyeShyYXdRdWVyeTogc3RyaW5nKTogeyBiYXNlRGlyOiBzdHJpbmc7IHF1ZXJ5OiBzdHJpbmc7IGRpc3BsYXlCYXNlOiBzdHJpbmcgfSB8IG51bGwge1xuXHRcdGNvbnN0IHNsYXNoSW5kZXggPSByYXdRdWVyeS5sYXN0SW5kZXhPZihcIi9cIik7XG5cdFx0aWYgKHNsYXNoSW5kZXggPT09IC0xKSB7XG5cdFx0XHRyZXR1cm4gbnVsbDtcblx0XHR9XG5cblx0XHRjb25zdCBkaXNwbGF5QmFzZSA9IHJhd1F1ZXJ5LnNsaWNlKDAsIHNsYXNoSW5kZXggKyAxKTtcblx0XHRjb25zdCBxdWVyeSA9IHJhd1F1ZXJ5LnNsaWNlKHNsYXNoSW5kZXggKyAxKTtcblxuXHRcdGxldCBiYXNlRGlyOiBzdHJpbmc7XG5cdFx0aWYgKGRpc3BsYXlCYXNlLnN0YXJ0c1dpdGgoXCJ+L1wiKSkge1xuXHRcdFx0YmFzZURpciA9IHRoaXMuZXhwYW5kSG9tZVBhdGgoZGlzcGxheUJhc2UpO1xuXHRcdH0gZWxzZSBpZiAoZGlzcGxheUJhc2Uuc3RhcnRzV2l0aChcIi9cIikpIHtcblx0XHRcdGJhc2VEaXIgPSBkaXNwbGF5QmFzZTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0YmFzZURpciA9IGpvaW4odGhpcy5iYXNlUGF0aCwgZGlzcGxheUJhc2UpO1xuXHRcdH1cblxuXHRcdHRyeSB7XG5cdFx0XHRpZiAoIXN0YXRTeW5jKGJhc2VEaXIpLmlzRGlyZWN0b3J5KCkpIHtcblx0XHRcdFx0cmV0dXJuIG51bGw7XG5cdFx0XHR9XG5cdFx0fSBjYXRjaCB7XG5cdFx0XHRyZXR1cm4gbnVsbDtcblx0XHR9XG5cblx0XHRyZXR1cm4geyBiYXNlRGlyLCBxdWVyeSwgZGlzcGxheUJhc2UgfTtcblx0fVxuXG5cdHByaXZhdGUgc2NvcGVkUGF0aEZvckRpc3BsYXkoZGlzcGxheUJhc2U6IHN0cmluZywgcmVsYXRpdmVQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuXHRcdGlmIChkaXNwbGF5QmFzZSA9PT0gXCIvXCIpIHtcblx0XHRcdHJldHVybiBgLyR7cmVsYXRpdmVQYXRofWA7XG5cdFx0fVxuXHRcdHJldHVybiBgJHtkaXNwbGF5QmFzZX0ke3JlbGF0aXZlUGF0aH1gO1xuXHR9XG5cblx0Ly8gR2V0IGZpbGUvZGlyZWN0b3J5IHN1Z2dlc3Rpb25zIGZvciBhIGdpdmVuIHBhdGggcHJlZml4XG5cdHByaXZhdGUgZ2V0RmlsZVN1Z2dlc3Rpb25zKHByZWZpeDogc3RyaW5nKTogQXV0b2NvbXBsZXRlSXRlbVtdIHtcblx0XHR0cnkge1xuXHRcdFx0bGV0IHNlYXJjaERpcjogc3RyaW5nO1xuXHRcdFx0bGV0IHNlYXJjaFByZWZpeDogc3RyaW5nO1xuXHRcdFx0Y29uc3QgeyByYXdQcmVmaXgsIGlzQXRQcmVmaXgsIGlzUXVvdGVkUHJlZml4IH0gPSBwYXJzZVBhdGhQcmVmaXgocHJlZml4KTtcblx0XHRcdGxldCBleHBhbmRlZFByZWZpeCA9IHJhd1ByZWZpeDtcblxuXHRcdFx0Ly8gSGFuZGxlIGhvbWUgZGlyZWN0b3J5IGV4cGFuc2lvblxuXHRcdFx0aWYgKGV4cGFuZGVkUHJlZml4LnN0YXJ0c1dpdGgoXCJ+XCIpKSB7XG5cdFx0XHRcdGV4cGFuZGVkUHJlZml4ID0gdGhpcy5leHBhbmRIb21lUGF0aChleHBhbmRlZFByZWZpeCk7XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IGlzUm9vdFByZWZpeCA9XG5cdFx0XHRcdHJhd1ByZWZpeCA9PT0gXCJcIiB8fFxuXHRcdFx0XHRyYXdQcmVmaXggPT09IFwiLi9cIiB8fFxuXHRcdFx0XHRyYXdQcmVmaXggPT09IFwiLi4vXCIgfHxcblx0XHRcdFx0cmF3UHJlZml4ID09PSBcIn5cIiB8fFxuXHRcdFx0XHRyYXdQcmVmaXggPT09IFwifi9cIiB8fFxuXHRcdFx0XHRyYXdQcmVmaXggPT09IFwiL1wiIHx8XG5cdFx0XHRcdChpc0F0UHJlZml4ICYmIHJhd1ByZWZpeCA9PT0gXCJcIik7XG5cblx0XHRcdGlmIChpc1Jvb3RQcmVmaXgpIHtcblx0XHRcdFx0Ly8gQ29tcGxldGUgZnJvbSBzcGVjaWZpZWQgcG9zaXRpb25cblx0XHRcdFx0aWYgKHJhd1ByZWZpeC5zdGFydHNXaXRoKFwiflwiKSB8fCBleHBhbmRlZFByZWZpeC5zdGFydHNXaXRoKFwiL1wiKSkge1xuXHRcdFx0XHRcdHNlYXJjaERpciA9IGV4cGFuZGVkUHJlZml4O1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdHNlYXJjaERpciA9IGpvaW4odGhpcy5iYXNlUGF0aCwgZXhwYW5kZWRQcmVmaXgpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdHNlYXJjaFByZWZpeCA9IFwiXCI7XG5cdFx0XHR9IGVsc2UgaWYgKHJhd1ByZWZpeC5lbmRzV2l0aChcIi9cIikpIHtcblx0XHRcdFx0Ly8gSWYgcHJlZml4IGVuZHMgd2l0aCAvLCBzaG93IGNvbnRlbnRzIG9mIHRoYXQgZGlyZWN0b3J5XG5cdFx0XHRcdGlmIChyYXdQcmVmaXguc3RhcnRzV2l0aChcIn5cIikgfHwgZXhwYW5kZWRQcmVmaXguc3RhcnRzV2l0aChcIi9cIikpIHtcblx0XHRcdFx0XHRzZWFyY2hEaXIgPSBleHBhbmRlZFByZWZpeDtcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRzZWFyY2hEaXIgPSBqb2luKHRoaXMuYmFzZVBhdGgsIGV4cGFuZGVkUHJlZml4KTtcblx0XHRcdFx0fVxuXHRcdFx0XHRzZWFyY2hQcmVmaXggPSBcIlwiO1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0Ly8gU3BsaXQgaW50byBkaXJlY3RvcnkgYW5kIGZpbGUgcHJlZml4XG5cdFx0XHRcdGNvbnN0IGRpciA9IGRpcm5hbWUoZXhwYW5kZWRQcmVmaXgpO1xuXHRcdFx0XHRjb25zdCBmaWxlID0gYmFzZW5hbWUoZXhwYW5kZWRQcmVmaXgpO1xuXHRcdFx0XHRpZiAocmF3UHJlZml4LnN0YXJ0c1dpdGgoXCJ+XCIpIHx8IGV4cGFuZGVkUHJlZml4LnN0YXJ0c1dpdGgoXCIvXCIpKSB7XG5cdFx0XHRcdFx0c2VhcmNoRGlyID0gZGlyO1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdHNlYXJjaERpciA9IGpvaW4odGhpcy5iYXNlUGF0aCwgZGlyKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRzZWFyY2hQcmVmaXggPSBmaWxlO1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCBlbnRyaWVzID0gcmVhZGRpclN5bmMoc2VhcmNoRGlyLCB7IHdpdGhGaWxlVHlwZXM6IHRydWUgfSk7XG5cdFx0XHRjb25zdCBzdWdnZXN0aW9uczogQXV0b2NvbXBsZXRlSXRlbVtdID0gW107XG5cblx0XHRcdGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xuXHRcdFx0XHRpZiAoIWVudHJ5Lm5hbWUudG9Mb3dlckNhc2UoKS5zdGFydHNXaXRoKHNlYXJjaFByZWZpeC50b0xvd2VyQ2FzZSgpKSkge1xuXHRcdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Ly8gU2tpcCBleGNsdWRlZCBkaXJlY3Rvcmllc1xuXHRcdFx0XHRpZiAodGhpcy5leGNsdWRlRGlycy5oYXMoZW50cnkubmFtZSkpIHtcblx0XHRcdFx0XHRjb250aW51ZTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdC8vIENoZWNrIGlmIGVudHJ5IGlzIGEgZGlyZWN0b3J5IChvciBhIHN5bWxpbmsgcG9pbnRpbmcgdG8gYSBkaXJlY3RvcnkpXG5cdFx0XHRcdGxldCBpc0RpcmVjdG9yeSA9IGVudHJ5LmlzRGlyZWN0b3J5KCk7XG5cdFx0XHRcdGlmICghaXNEaXJlY3RvcnkgJiYgZW50cnkuaXNTeW1ib2xpY0xpbmsoKSkge1xuXHRcdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0XHRjb25zdCBmdWxsUGF0aCA9IGpvaW4oc2VhcmNoRGlyLCBlbnRyeS5uYW1lKTtcblx0XHRcdFx0XHRcdGlzRGlyZWN0b3J5ID0gc3RhdFN5bmMoZnVsbFBhdGgpLmlzRGlyZWN0b3J5KCk7XG5cdFx0XHRcdFx0fSBjYXRjaCB7XG5cdFx0XHRcdFx0XHQvLyBCcm9rZW4gc3ltbGluayBvciBwZXJtaXNzaW9uIGVycm9yIC0gdHJlYXQgYXMgZmlsZVxuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXG5cdFx0XHRcdGxldCByZWxhdGl2ZVBhdGg6IHN0cmluZztcblx0XHRcdFx0Y29uc3QgbmFtZSA9IGVudHJ5Lm5hbWU7XG5cdFx0XHRcdGNvbnN0IGRpc3BsYXlQcmVmaXggPSByYXdQcmVmaXg7XG5cblx0XHRcdFx0aWYgKGRpc3BsYXlQcmVmaXguZW5kc1dpdGgoXCIvXCIpKSB7XG5cdFx0XHRcdFx0Ly8gSWYgcHJlZml4IGVuZHMgd2l0aCAvLCBhcHBlbmQgZW50cnkgdG8gdGhlIHByZWZpeFxuXHRcdFx0XHRcdHJlbGF0aXZlUGF0aCA9IGRpc3BsYXlQcmVmaXggKyBuYW1lO1xuXHRcdFx0XHR9IGVsc2UgaWYgKGRpc3BsYXlQcmVmaXguaW5jbHVkZXMoXCIvXCIpKSB7XG5cdFx0XHRcdFx0Ly8gUHJlc2VydmUgfi8gZm9ybWF0IGZvciBob21lIGRpcmVjdG9yeSBwYXRoc1xuXHRcdFx0XHRcdGlmIChkaXNwbGF5UHJlZml4LnN0YXJ0c1dpdGgoXCJ+L1wiKSkge1xuXHRcdFx0XHRcdFx0Y29uc3QgaG9tZVJlbGF0aXZlRGlyID0gZGlzcGxheVByZWZpeC5zbGljZSgyKTsgLy8gUmVtb3ZlIH4vXG5cdFx0XHRcdFx0XHRjb25zdCBkaXIgPSBkaXJuYW1lKGhvbWVSZWxhdGl2ZURpcik7XG5cdFx0XHRcdFx0XHRyZWxhdGl2ZVBhdGggPSBgfi8ke2RpciA9PT0gXCIuXCIgPyBuYW1lIDogam9pbihkaXIsIG5hbWUpfWA7XG5cdFx0XHRcdFx0fSBlbHNlIGlmIChkaXNwbGF5UHJlZml4LnN0YXJ0c1dpdGgoXCIvXCIpKSB7XG5cdFx0XHRcdFx0XHQvLyBBYnNvbHV0ZSBwYXRoIC0gY29uc3RydWN0IHByb3Blcmx5XG5cdFx0XHRcdFx0XHRjb25zdCBkaXIgPSBkaXJuYW1lKGRpc3BsYXlQcmVmaXgpO1xuXHRcdFx0XHRcdFx0aWYgKGRpciA9PT0gXCIvXCIpIHtcblx0XHRcdFx0XHRcdFx0cmVsYXRpdmVQYXRoID0gYC8ke25hbWV9YDtcblx0XHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHRcdHJlbGF0aXZlUGF0aCA9IGAke2Rpcn0vJHtuYW1lfWA7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdHJlbGF0aXZlUGF0aCA9IGpvaW4oZGlybmFtZShkaXNwbGF5UHJlZml4KSwgbmFtZSk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdC8vIEZvciBzdGFuZGFsb25lIGVudHJpZXMsIHByZXNlcnZlIH4vIGlmIG9yaWdpbmFsIHByZWZpeCB3YXMgfi9cblx0XHRcdFx0XHRpZiAoZGlzcGxheVByZWZpeC5zdGFydHNXaXRoKFwiflwiKSkge1xuXHRcdFx0XHRcdFx0cmVsYXRpdmVQYXRoID0gYH4vJHtuYW1lfWA7XG5cdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdHJlbGF0aXZlUGF0aCA9IG5hbWU7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cblx0XHRcdFx0Y29uc3QgcGF0aFZhbHVlID0gaXNEaXJlY3RvcnkgPyBgJHtyZWxhdGl2ZVBhdGh9L2AgOiByZWxhdGl2ZVBhdGg7XG5cdFx0XHRcdGNvbnN0IHZhbHVlID0gYnVpbGRDb21wbGV0aW9uVmFsdWUocGF0aFZhbHVlLCB7XG5cdFx0XHRcdFx0aXNEaXJlY3RvcnksXG5cdFx0XHRcdFx0aXNBdFByZWZpeCxcblx0XHRcdFx0XHRpc1F1b3RlZFByZWZpeCxcblx0XHRcdFx0fSk7XG5cblx0XHRcdFx0c3VnZ2VzdGlvbnMucHVzaCh7XG5cdFx0XHRcdFx0dmFsdWUsXG5cdFx0XHRcdFx0bGFiZWw6IG5hbWUgKyAoaXNEaXJlY3RvcnkgPyBcIi9cIiA6IFwiXCIpLFxuXHRcdFx0XHR9KTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gU29ydCBkaXJlY3RvcmllcyBmaXJzdCwgdGhlbiBhbHBoYWJldGljYWxseVxuXHRcdFx0c3VnZ2VzdGlvbnMuc29ydCgoYSwgYikgPT4ge1xuXHRcdFx0XHRjb25zdCBhSXNEaXIgPSBhLnZhbHVlLmVuZHNXaXRoKFwiL1wiKTtcblx0XHRcdFx0Y29uc3QgYklzRGlyID0gYi52YWx1ZS5lbmRzV2l0aChcIi9cIik7XG5cdFx0XHRcdGlmIChhSXNEaXIgJiYgIWJJc0RpcikgcmV0dXJuIC0xO1xuXHRcdFx0XHRpZiAoIWFJc0RpciAmJiBiSXNEaXIpIHJldHVybiAxO1xuXHRcdFx0XHRyZXR1cm4gYS5sYWJlbC5sb2NhbGVDb21wYXJlKGIubGFiZWwpO1xuXHRcdFx0fSk7XG5cblx0XHRcdHJldHVybiBzdWdnZXN0aW9ucztcblx0XHR9IGNhdGNoIChfZSkge1xuXHRcdFx0Ly8gRGlyZWN0b3J5IGRvZXNuJ3QgZXhpc3Qgb3Igbm90IGFjY2Vzc2libGVcblx0XHRcdHJldHVybiBbXTtcblx0XHR9XG5cdH1cblxuXHQvLyBGdXp6eSBmaWxlIHNlYXJjaCB1c2luZyB0aGUgbmF0aXZlIGZkIG1vZHVsZSAoZmFzdCwgcmVzcGVjdHMgLmdpdGlnbm9yZSlcblx0cHJpdmF0ZSBnZXRGdXp6eUZpbGVTdWdnZXN0aW9ucyhxdWVyeTogc3RyaW5nLCBvcHRpb25zOiB7IGlzUXVvdGVkUHJlZml4OiBib29sZWFuIH0pOiBBdXRvY29tcGxldGVJdGVtW10ge1xuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBzY29wZWRRdWVyeSA9IHRoaXMucmVzb2x2ZVNjb3BlZEZ1enp5UXVlcnkocXVlcnkpO1xuXHRcdFx0Y29uc3Qgc2VhcmNoUXVlcnkgPSBzY29wZWRRdWVyeT8ucXVlcnkgPz8gcXVlcnk7XG5cblx0XHRcdC8vIFNraXAgdGhlIGV4cGVuc2l2ZSBmaWxlc3lzdGVtIHdhbGsgd2hlbiB0aGUgcXVlcnkgaXMgZW1wdHkuXG5cdFx0XHQvLyBBbiBlbXB0eSBxdWVyeSAoYmFyZSBcIkBcIiB3aXRoIG5vdGhpbmcgdHlwZWQgeWV0KSB3b3VsZCB3YWxrIHRoZVxuXHRcdFx0Ly8gZW50aXJlIGRpcmVjdG9yeSB0cmVlIHZpYSB0aGUgbmF0aXZlIGZ1enp5RmluZCBjYWxsLCBibG9ja2luZ1xuXHRcdFx0Ly8gdGhlIGV2ZW50IGxvb3AgYW5kIGZyZWV6aW5nIHRoZSBUVUkgb24gbGFyZ2UgcmVwb3MuXG5cdFx0XHRpZiAoc2VhcmNoUXVlcnkubGVuZ3RoID09PSAwICYmICFzY29wZWRRdWVyeSkge1xuXHRcdFx0XHRyZXR1cm4gW107XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IHNlYXJjaFBhdGggPSBzY29wZWRRdWVyeT8uYmFzZURpciA/PyB0aGlzLmJhc2VQYXRoO1xuXG5cdFx0XHRjb25zdCByZXN1bHQgPSBmdXp6eUZpbmQoe1xuXHRcdFx0XHRxdWVyeTogc2VhcmNoUXVlcnksXG5cdFx0XHRcdHBhdGg6IHNlYXJjaFBhdGgsXG5cdFx0XHRcdGhpZGRlbjogdHJ1ZSxcblx0XHRcdFx0Z2l0aWdub3JlOiB0aGlzLnJlc3BlY3RHaXRpZ25vcmUsXG5cdFx0XHRcdG1heFJlc3VsdHM6IEZVWlpZX0ZJTEVfTUFYX1JFU1VMVFMsXG5cdFx0XHR9KTtcblxuXHRcdFx0Ly8gQnVpbGQgc3VnZ2VzdGlvbnNcblx0XHRcdGNvbnN0IHN1Z2dlc3Rpb25zOiBBdXRvY29tcGxldGVJdGVtW10gPSBbXTtcblx0XHRcdGZvciAoY29uc3QgeyBwYXRoOiBlbnRyeVBhdGgsIGlzRGlyZWN0b3J5IH0gb2YgcmVzdWx0Lm1hdGNoZXMpIHtcblx0XHRcdFx0Ly8gTmF0aXZlIG1vZHVsZSBpbmNsdWRlcyB0cmFpbGluZyAvIGZvciBkaXJlY3Rvcmllc1xuXHRcdFx0XHRjb25zdCBwYXRoV2l0aG91dFNsYXNoID0gaXNEaXJlY3RvcnkgPyBlbnRyeVBhdGguc2xpY2UoMCwgLTEpIDogZW50cnlQYXRoO1xuXG5cdFx0XHRcdC8vIFNraXAgcGF0aHMgdGhhdCBzdGFydCB3aXRoIG9yIGNvbnRhaW4gYW4gZXhjbHVkZWQgZGlyZWN0b3J5XG5cdFx0XHRcdGlmICh0aGlzLmV4Y2x1ZGVEaXJzLnNpemUgPiAwKSB7XG5cdFx0XHRcdFx0Y29uc3Qgc2VnbWVudHMgPSBwYXRoV2l0aG91dFNsYXNoLnNwbGl0KFwiL1wiKTtcblx0XHRcdFx0XHRpZiAoc2VnbWVudHMuc29tZShzZWcgPT4gdGhpcy5leGNsdWRlRGlycy5oYXMoc2VnKSkpIGNvbnRpbnVlO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Y29uc3QgZGlzcGxheVBhdGggPSBzY29wZWRRdWVyeVxuXHRcdFx0XHRcdD8gdGhpcy5zY29wZWRQYXRoRm9yRGlzcGxheShzY29wZWRRdWVyeS5kaXNwbGF5QmFzZSwgcGF0aFdpdGhvdXRTbGFzaClcblx0XHRcdFx0XHQ6IHBhdGhXaXRob3V0U2xhc2g7XG5cdFx0XHRcdGNvbnN0IGVudHJ5TmFtZSA9IGJhc2VuYW1lKHBhdGhXaXRob3V0U2xhc2gpO1xuXHRcdFx0XHRjb25zdCBjb21wbGV0aW9uUGF0aCA9IGlzRGlyZWN0b3J5ID8gYCR7ZGlzcGxheVBhdGh9L2AgOiBkaXNwbGF5UGF0aDtcblx0XHRcdFx0Y29uc3QgdmFsdWUgPSBidWlsZENvbXBsZXRpb25WYWx1ZShjb21wbGV0aW9uUGF0aCwge1xuXHRcdFx0XHRcdGlzRGlyZWN0b3J5LFxuXHRcdFx0XHRcdGlzQXRQcmVmaXg6IHRydWUsXG5cdFx0XHRcdFx0aXNRdW90ZWRQcmVmaXg6IG9wdGlvbnMuaXNRdW90ZWRQcmVmaXgsXG5cdFx0XHRcdH0pO1xuXG5cdFx0XHRcdHN1Z2dlc3Rpb25zLnB1c2goe1xuXHRcdFx0XHRcdHZhbHVlLFxuXHRcdFx0XHRcdGxhYmVsOiBlbnRyeU5hbWUgKyAoaXNEaXJlY3RvcnkgPyBcIi9cIiA6IFwiXCIpLFxuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOiBkaXNwbGF5UGF0aCxcblx0XHRcdFx0fSk7XG5cdFx0XHR9XG5cblx0XHRcdHJldHVybiBzdWdnZXN0aW9ucztcblx0XHR9IGNhdGNoIHtcblx0XHRcdHJldHVybiBbXTtcblx0XHR9XG5cdH1cblxuXHQvLyBGb3JjZSBmaWxlIGNvbXBsZXRpb24gKGNhbGxlZCBvbiBUYWIga2V5KSAtIGFsd2F5cyByZXR1cm5zIHN1Z2dlc3Rpb25zXG5cdGdldEZvcmNlRmlsZVN1Z2dlc3Rpb25zKFxuXHRcdGxpbmVzOiBzdHJpbmdbXSxcblx0XHRjdXJzb3JMaW5lOiBudW1iZXIsXG5cdFx0Y3Vyc29yQ29sOiBudW1iZXIsXG5cdCk6IHsgaXRlbXM6IEF1dG9jb21wbGV0ZUl0ZW1bXTsgcHJlZml4OiBzdHJpbmcgfSB8IG51bGwge1xuXHRcdGNvbnN0IGN1cnJlbnRMaW5lID0gbGluZXNbY3Vyc29yTGluZV0gfHwgXCJcIjtcblx0XHRjb25zdCB0ZXh0QmVmb3JlQ3Vyc29yID0gY3VycmVudExpbmUuc2xpY2UoMCwgY3Vyc29yQ29sKTtcblxuXHRcdC8vIERvbid0IHRyaWdnZXIgaWYgd2UncmUgdHlwaW5nIGEgc2xhc2ggY29tbWFuZCBhdCB0aGUgc3RhcnQgb2YgdGhlIGxpbmVcblx0XHRpZiAodGV4dEJlZm9yZUN1cnNvci50cmltKCkuc3RhcnRzV2l0aChcIi9cIikgJiYgIXRleHRCZWZvcmVDdXJzb3IudHJpbSgpLmluY2x1ZGVzKFwiIFwiKSkge1xuXHRcdFx0cmV0dXJuIG51bGw7XG5cdFx0fVxuXG5cdFx0Ly8gRm9yY2UgZXh0cmFjdCBwYXRoIHByZWZpeCAtIHRoaXMgd2lsbCBhbHdheXMgcmV0dXJuIHNvbWV0aGluZ1xuXHRcdGNvbnN0IHBhdGhNYXRjaCA9IHRoaXMuZXh0cmFjdFBhdGhQcmVmaXgodGV4dEJlZm9yZUN1cnNvciwgdHJ1ZSk7XG5cdFx0aWYgKHBhdGhNYXRjaCAhPT0gbnVsbCkge1xuXHRcdFx0Y29uc3Qgc3VnZ2VzdGlvbnMgPSB0aGlzLmdldEZpbGVTdWdnZXN0aW9ucyhwYXRoTWF0Y2gpO1xuXHRcdFx0aWYgKHN1Z2dlc3Rpb25zLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG5cblx0XHRcdHJldHVybiB7XG5cdFx0XHRcdGl0ZW1zOiBzdWdnZXN0aW9ucyxcblx0XHRcdFx0cHJlZml4OiBwYXRoTWF0Y2gsXG5cdFx0XHR9O1xuXHRcdH1cblxuXHRcdHJldHVybiBudWxsO1xuXHR9XG5cblx0Ly8gQ2hlY2sgaWYgd2Ugc2hvdWxkIHRyaWdnZXIgZmlsZSBjb21wbGV0aW9uIChjYWxsZWQgb24gVGFiIGtleSlcblx0c2hvdWxkVHJpZ2dlckZpbGVDb21wbGV0aW9uKGxpbmVzOiBzdHJpbmdbXSwgY3Vyc29yTGluZTogbnVtYmVyLCBjdXJzb3JDb2w6IG51bWJlcik6IGJvb2xlYW4ge1xuXHRcdGNvbnN0IGN1cnJlbnRMaW5lID0gbGluZXNbY3Vyc29yTGluZV0gfHwgXCJcIjtcblx0XHRjb25zdCB0ZXh0QmVmb3JlQ3Vyc29yID0gY3VycmVudExpbmUuc2xpY2UoMCwgY3Vyc29yQ29sKTtcblxuXHRcdC8vIERvbid0IHRyaWdnZXIgaWYgd2UncmUgdHlwaW5nIGEgc2xhc2ggY29tbWFuZCBhdCB0aGUgc3RhcnQgb2YgdGhlIGxpbmVcblx0XHRpZiAodGV4dEJlZm9yZUN1cnNvci50cmltKCkuc3RhcnRzV2l0aChcIi9cIikgJiYgIXRleHRCZWZvcmVDdXJzb3IudHJpbSgpLmluY2x1ZGVzKFwiIFwiKSkge1xuXHRcdFx0cmV0dXJuIGZhbHNlO1xuXHRcdH1cblxuXHRcdHJldHVybiB0cnVlO1xuXHR9XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxTQUFTLGFBQWEsZ0JBQWdCO0FBQ3RDLFNBQVMsZUFBZTtBQUN4QixTQUFTLFVBQVUsU0FBUyxZQUFZO0FBQ3hDLFNBQVMsaUJBQWlCO0FBQzFCLFNBQVMsbUJBQW1CO0FBRTVCLE1BQU0sa0JBQWtCLG9CQUFJLElBQUksQ0FBQyxLQUFLLEtBQU0sS0FBSyxLQUFLLEdBQUcsQ0FBQztBQUMxRCxNQUFNLHlCQUF5QjtBQUUvQixTQUFTLGtCQUFrQixNQUFzQjtBQUNoRCxXQUFTLElBQUksS0FBSyxTQUFTLEdBQUcsS0FBSyxHQUFHLEtBQUssR0FBRztBQUM3QyxRQUFJLGdCQUFnQixJQUFJLEtBQUssQ0FBQyxLQUFLLEVBQUUsR0FBRztBQUN2QyxhQUFPO0FBQUEsSUFDUjtBQUFBLEVBQ0Q7QUFDQSxTQUFPO0FBQ1I7QUFFQSxTQUFTLHVCQUF1QixNQUE2QjtBQUM1RCxNQUFJLFdBQVc7QUFDZixNQUFJLGFBQWE7QUFFakIsV0FBUyxJQUFJLEdBQUcsSUFBSSxLQUFLLFFBQVEsS0FBSyxHQUFHO0FBQ3hDLFFBQUksS0FBSyxDQUFDLE1BQU0sS0FBSztBQUNwQixpQkFBVyxDQUFDO0FBQ1osVUFBSSxVQUFVO0FBQ2IscUJBQWE7QUFBQSxNQUNkO0FBQUEsSUFDRDtBQUFBLEVBQ0Q7QUFFQSxTQUFPLFdBQVcsYUFBYTtBQUNoQztBQUVBLFNBQVMsYUFBYSxNQUFjLE9BQXdCO0FBQzNELFNBQU8sVUFBVSxLQUFLLGdCQUFnQixJQUFJLEtBQUssUUFBUSxDQUFDLEtBQUssRUFBRTtBQUNoRTtBQUVBLFNBQVMsb0JBQW9CLE1BQTZCO0FBQ3pELFFBQU0sYUFBYSx1QkFBdUIsSUFBSTtBQUM5QyxNQUFJLGVBQWUsTUFBTTtBQUN4QixXQUFPO0FBQUEsRUFDUjtBQUVBLE1BQUksYUFBYSxLQUFLLEtB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QUFJLFNBQVMsS0FBSyxTQUFPLEtBQUssWUFBWSxJQUFJLEdBQUcsQ0FBQyxFQUFHO0FBQUEsUUFDdEQ7QUFFQSxjQUFNLGNBQWMsY0FDakIsS0FBSyxxQkFBcUIsWUFBWSxhQUFhLGdCQUFnQixJQUNuRTtBQUNILGNBQU0sWUFBWSxTQUFTLGdCQUFnQjtBQUMzQyxjQUFNLGlCQUFpQixjQUFjLEdBQUcsV0FBVyxNQUFNO0FBQ3pELGNBQU0sUUFBUSxxQkFBcUIsZ0JBQWdCO0FBQUEsVUFDbEQ7QUFBQSxVQUNBLFlBQVk7QUFBQSxVQUNaLGdCQUFnQixRQUFRO0FBQUEsUUFDekIsQ0FBQztBQUVELG9CQUFZLEtBQUs7QUFBQSxVQUNoQjtBQUFBLFVBQ0EsT0FBTyxhQUFhLGNBQWMsTUFBTTtBQUFBLFVBQ3hDLGFBQWE7QUFBQSxRQUNkLENBQUM7QUFBQSxNQUNGO0FBRUEsYUFBTztBQUFBLElBQ1IsUUFBUTtBQUNQLGFBQU8sQ0FBQztBQUFBLElBQ1Q7QUFBQSxFQUNEO0FBQUE7QUFBQSxFQUdBLHdCQUNDLE9BQ0EsWUFDQSxXQUN1RDtBQUN2RCxVQUFNLGNBQWMsTUFBTSxVQUFVLEtBQUs7QUFDekMsVUFBTSxtQkFBbUIsWUFBWSxNQUFNLEdBQUcsU0FBUztBQUd2RCxRQUFJLGlCQUFpQixLQUFLLEVBQUUsV0FBVyxHQUFHLEtBQUssQ0FBQyxpQkFBaUIsS0FBSyxFQUFFLFNBQVMsR0FBRyxHQUFHO0FBQ3RGLGFBQU87QUFBQSxJQUNSO0FBR0EsVUFBTSxZQUFZLEtBQUssa0JBQWtCLGtCQUFrQixJQUFJO0FBQy9ELFFBQUksY0FBYyxNQUFNO0FBQ3ZCLFlBQU0sY0FBYyxLQUFLLG1CQUFtQixTQUFTO0FBQ3JELFVBQUksWUFBWSxXQUFXLEVBQUcsUUFBTztBQUVyQyxhQUFPO0FBQUEsUUFDTixPQUFPO0FBQUEsUUFDUCxRQUFRO0FBQUEsTUFDVDtBQUFBLElBQ0Q7QUFFQSxXQUFPO0FBQUEsRUFDUjtBQUFBO0FBQUEsRUFHQSw0QkFBNEIsT0FBaUIsWUFBb0IsV0FBNEI7QUFDNUYsVUFBTSxjQUFjLE1BQU0sVUFBVSxLQUFLO0FBQ3pDLFVBQU0sbUJBQW1CLFlBQVksTUFBTSxHQUFHLFNBQVM7QUFHdkQsUUFBSSxpQkFBaUIsS0FBSyxFQUFFLFdBQVcsR0FBRyxLQUFLLENBQUMsaUJBQWlCLEtBQUssRUFBRSxTQUFTLEdBQUcsR0FBRztBQUN0RixhQUFPO0FBQUEsSUFDUjtBQUVBLFdBQU87QUFBQSxFQUNSO0FBQ0Q7IiwKICAibmFtZXMiOiBbIm5ld0xpbmUiLCAibmV3TGluZXMiLCAiaXNEaXJlY3RvcnkiLCAiaGFzVHJhaWxpbmdRdW90ZSIsICJjdXJzb3JPZmZzZXQiXQp9Cg==
