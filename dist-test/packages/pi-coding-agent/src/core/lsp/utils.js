import * as fsPromises from "node:fs/promises";
import path from "node:path";
import { glob } from "glob";
import { isEnoent } from "./helpers.js";
const LANGUAGE_MAP = {
  // TypeScript/JavaScript
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".mts": "typescript",
  ".cts": "typescript",
  // Systems languages
  ".rs": "rust",
  ".go": "go",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
  ".zig": "zig",
  // Scripting languages
  ".py": "python",
  ".rb": "ruby",
  ".lua": "lua",
  ".sh": "shellscript",
  ".bash": "shellscript",
  ".zsh": "shellscript",
  ".fish": "fish",
  ".pl": "perl",
  ".php": "php",
  // JVM languages
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".scala": "scala",
  ".groovy": "groovy",
  ".clj": "clojure",
  // .NET languages
  ".cs": "csharp",
  ".fs": "fsharp",
  ".vb": "vb",
  // Web
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "scss",
  ".sass": "sass",
  ".less": "less",
  ".vue": "vue",
  ".svelte": "svelte",
  // Data formats
  ".json": "json",
  ".jsonc": "jsonc",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".xml": "xml",
  ".ini": "ini",
  // Documentation
  ".md": "markdown",
  ".markdown": "markdown",
  ".rst": "restructuredtext",
  ".adoc": "asciidoc",
  ".tex": "latex",
  // Other
  ".sql": "sql",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".proto": "protobuf",
  ".dockerfile": "dockerfile",
  ".tf": "terraform",
  ".hcl": "hcl",
  ".nix": "nix",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".hrl": "erlang",
  ".hs": "haskell",
  ".ml": "ocaml",
  ".mli": "ocaml",
  ".swift": "swift",
  ".r": "r",
  ".R": "r",
  ".jl": "julia",
  ".dart": "dart",
  ".elm": "elm",
  ".v": "v",
  ".nim": "nim",
  ".cr": "crystal",
  ".d": "d",
  ".pas": "pascal",
  ".pp": "pascal",
  ".lisp": "lisp",
  ".lsp": "lisp",
  ".rkt": "racket",
  ".scm": "scheme",
  ".ps1": "powershell",
  ".psm1": "powershell",
  ".bat": "bat",
  ".cmd": "bat"
};
function detectLanguageId(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath).toLowerCase();
  if (basename === "dockerfile" || basename.startsWith("dockerfile.")) {
    return "dockerfile";
  }
  if (basename === "makefile" || basename === "gnumakefile") {
    return "makefile";
  }
  if (basename === "cmakelists.txt" || ext === ".cmake") {
    return "cmake";
  }
  return LANGUAGE_MAP[ext] ?? "plaintext";
}
function fileToUri(filePath) {
  const resolved = path.resolve(filePath);
  if (process.platform === "win32") {
    return `file:///${resolved.replace(/\\/g, "/")}`;
  }
  return `file://${resolved}`;
}
function uriToFile(uri) {
  if (!uri.startsWith("file://")) {
    return uri;
  }
  let filePath = decodeURIComponent(uri.slice(7));
  if (process.platform === "win32" && filePath.startsWith("/") && /^[A-Za-z]:/.test(filePath.slice(1))) {
    filePath = filePath.slice(1);
  }
  return filePath;
}
const SEVERITY_NAMES = {
  1: "error",
  2: "warning",
  3: "info",
  4: "hint"
};
function severityToString(severity) {
  return SEVERITY_NAMES[severity ?? 1] ?? "unknown";
}
function sortDiagnostics(diagnostics) {
  return diagnostics.sort((a, b) => {
    const aSeverity = a.severity ?? 1;
    const bSeverity = b.severity ?? 1;
    if (aSeverity !== bSeverity) return aSeverity - bSeverity;
    const aLine = a.range.start.line;
    const bLine = b.range.start.line;
    if (aLine !== bLine) return aLine - bLine;
    const aCol = a.range.start.character;
    const bCol = b.range.start.character;
    if (aCol !== bCol) return aCol - bCol;
    return a.message.localeCompare(b.message);
  });
}
function stripDiagnosticNoise(message) {
  return message.split("\n").filter((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("for further information visit")) return false;
    if (/^https?:\/\//.test(trimmed)) return false;
    return true;
  }).join("\n").trim();
}
function formatDiagnostic(diagnostic, filePath) {
  const severity = severityToString(diagnostic.severity);
  const line = diagnostic.range.start.line + 1;
  const col = diagnostic.range.start.character + 1;
  const source = diagnostic.source ? `[${diagnostic.source}] ` : "";
  const code = diagnostic.code !== void 0 ? ` (${diagnostic.code})` : "";
  const message = stripDiagnosticNoise(diagnostic.message);
  return `${filePath}:${line}:${col} [${severity}] ${source}${message}${code}`;
}
const DIAG_PATH_RE = /^(.+?):(\d+:\d+\s+.*)$/;
function formatGroupedDiagnosticMessages(messages) {
  const diagnosticsByFile = /* @__PURE__ */ new Map();
  const fileOrder = [];
  const ungrouped = [];
  for (const msg of messages) {
    const match = DIAG_PATH_RE.exec(msg);
    if (!match) {
      ungrouped.push(msg);
      continue;
    }
    const [, rawFilePath, rest] = match;
    const filePath = rawFilePath.replace(/\\/g, "/");
    if (!diagnosticsByFile.has(filePath)) {
      diagnosticsByFile.set(filePath, []);
      fileOrder.push(filePath);
    }
    diagnosticsByFile.get(filePath)?.push(rest);
  }
  if (diagnosticsByFile.size === 0) {
    return ungrouped.join("\n");
  }
  const filesByDirectory = /* @__PURE__ */ new Map();
  for (const filePath of fileOrder) {
    const directory = path.dirname(filePath).replace(/\\/g, "/");
    if (!filesByDirectory.has(directory)) {
      filesByDirectory.set(directory, []);
    }
    filesByDirectory.get(directory)?.push(filePath);
  }
  const lines = [];
  for (const [directory, directoryFiles] of filesByDirectory) {
    if (directory === ".") {
      for (const filePath of directoryFiles) {
        if (lines.length > 0) {
          lines.push("");
        }
        lines.push(`# ${path.basename(filePath)}`);
        for (const diagnostic of diagnosticsByFile.get(filePath) ?? []) {
          lines.push(`  ${diagnostic}`);
        }
      }
      continue;
    }
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(`# ${directory}`);
    for (const filePath of directoryFiles) {
      lines.push(`## \u2514\u2500 ${path.basename(filePath)}`);
      for (const diagnostic of diagnosticsByFile.get(filePath) ?? []) {
        lines.push(`  ${diagnostic}`);
      }
    }
  }
  if (ungrouped.length > 0) {
    lines.push("");
    for (const msg of ungrouped) {
      lines.push(msg);
    }
  }
  return lines.join("\n");
}
function formatDiagnosticsSummary(diagnostics) {
  const counts = { error: 0, warning: 0, info: 0, hint: 0 };
  for (const d of diagnostics) {
    const sev = severityToString(d.severity);
    if (sev in counts) {
      counts[sev]++;
    }
  }
  const parts = [];
  if (counts.error > 0) parts.push(`${counts.error} error(s)`);
  if (counts.warning > 0) parts.push(`${counts.warning} warning(s)`);
  if (counts.info > 0) parts.push(`${counts.info} info(s)`);
  if (counts.hint > 0) parts.push(`${counts.hint} hint(s)`);
  return parts.length > 0 ? parts.join(", ") : "no issues";
}
function formatLocation(location, cwd) {
  const file = path.relative(cwd, uriToFile(location.uri));
  const line = location.range.start.line + 1;
  const col = location.range.start.character + 1;
  return `${file}:${line}:${col}`;
}
function formatWorkspaceEdit(edit, cwd) {
  const results = [];
  if (edit.changes) {
    for (const [uri, textEdits] of Object.entries(edit.changes)) {
      const file = path.relative(cwd, uriToFile(uri));
      results.push(`${file}: ${textEdits.length} edit${textEdits.length > 1 ? "s" : ""}`);
    }
  }
  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if ("edits" in change && change.textDocument) {
        const file = path.relative(cwd, uriToFile(change.textDocument.uri));
        results.push(`${file}: ${change.edits.length} edit${change.edits.length > 1 ? "s" : ""}`);
      } else if ("kind" in change) {
        switch (change.kind) {
          case "create":
            results.push(`CREATE: ${path.relative(cwd, uriToFile(change.uri))}`);
            break;
          case "rename":
            results.push(
              `RENAME: ${path.relative(cwd, uriToFile(change.oldUri))} -> ${path.relative(cwd, uriToFile(change.newUri))}`
            );
            break;
          case "delete":
            results.push(`DELETE: ${path.relative(cwd, uriToFile(change.uri))}`);
            break;
        }
      }
    }
  }
  return results;
}
const SYMBOL_KIND_LABELS = {
  1: "File",
  2: "Module",
  3: "Namespace",
  4: "Package",
  5: "Class",
  6: "Method",
  7: "Property",
  8: "Field",
  9: "Constructor",
  10: "Enum",
  11: "Interface",
  12: "Function",
  13: "Variable",
  14: "Constant",
  15: "String",
  16: "Number",
  17: "Boolean",
  18: "Array",
  19: "Object",
  20: "Key",
  21: "Null",
  22: "EnumMember",
  23: "Struct",
  24: "Event",
  25: "Operator",
  26: "TypeParameter"
};
function symbolKindToIcon(kind) {
  return `[${SYMBOL_KIND_LABELS[kind] ?? "?"}]`;
}
function formatDocumentSymbol(symbol, indent = 0) {
  const prefix = "  ".repeat(indent);
  const icon = symbolKindToIcon(symbol.kind);
  const line = symbol.range.start.line + 1;
  const detail = symbol.detail ? ` ${symbol.detail}` : "";
  const results = [`${prefix}${icon} ${symbol.name}${detail} @ line ${line}`];
  if (symbol.children) {
    for (const child of symbol.children) {
      results.push(...formatDocumentSymbol(child, indent + 1));
    }
  }
  return results;
}
function formatSymbolInformation(symbol, cwd) {
  const icon = symbolKindToIcon(symbol.kind);
  const location = formatLocation(symbol.location, cwd);
  const container = symbol.containerName ? ` (${symbol.containerName})` : "";
  return `${icon} ${symbol.name}${container} @ ${location}`;
}
function filterWorkspaceSymbols(symbols, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return symbols;
  return symbols.filter((symbol) => {
    const fields = [symbol.name, symbol.containerName ?? "", uriToFile(symbol.location.uri)];
    return fields.some((field) => field.toLowerCase().includes(needle));
  });
}
function dedupeWorkspaceSymbols(symbols) {
  const seen = /* @__PURE__ */ new Set();
  const unique = [];
  for (const symbol of symbols) {
    const key = [
      symbol.name,
      symbol.containerName ?? "",
      symbol.kind,
      symbol.location.uri,
      symbol.location.range.start.line,
      symbol.location.range.start.character
    ].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(symbol);
  }
  return unique;
}
function formatCodeAction(action, index) {
  const kind = "kind" in action && action.kind ? action.kind : "action";
  const preferred = "isPreferred" in action && action.isPreferred ? " (preferred)" : "";
  const disabled = "disabled" in action && action.disabled ? ` (disabled: ${action.disabled.reason})` : "";
  return `${index}: [${kind}] ${action.title}${preferred}${disabled}`;
}
function isCommandItem(action) {
  return typeof action.command === "string";
}
async function applyCodeAction(action, dependencies) {
  if (isCommandItem(action)) {
    await dependencies.executeCommand(action);
    return { title: action.title, edits: [], executedCommands: [action.command] };
  }
  let resolvedAction = action;
  if (!resolvedAction.edit && dependencies.resolveCodeAction) {
    try {
      resolvedAction = await dependencies.resolveCodeAction(resolvedAction);
    } catch {
    }
  }
  const edits = resolvedAction.edit ? await dependencies.applyWorkspaceEdit(resolvedAction.edit) : [];
  const executedCommands = [];
  if (resolvedAction.command) {
    await dependencies.executeCommand(resolvedAction.command);
    executedCommands.push(resolvedAction.command.command);
  }
  if (edits.length === 0 && executedCommands.length === 0) {
    return null;
  }
  return { title: resolvedAction.title, edits, executedCommands };
}
const GLOB_PATTERN_CHARS = /[*?[{]/;
function hasGlobPattern(value) {
  return GLOB_PATTERN_CHARS.test(value);
}
async function collectGlobMatches(pattern, cwd, maxMatches) {
  const normalizedLimit = Number.isFinite(maxMatches) ? Math.max(1, Math.trunc(maxMatches)) : 1;
  const allMatches = await glob(pattern, { cwd });
  if (allMatches.length > normalizedLimit) {
    return { matches: allMatches.slice(0, normalizedLimit), truncated: true };
  }
  return { matches: allMatches, truncated: false };
}
function extractHoverText(contents) {
  if (typeof contents === "string") {
    return contents;
  }
  if (Array.isArray(contents)) {
    return contents.map((c) => extractHoverText(c)).join("\n\n");
  }
  if (typeof contents === "object" && contents !== null) {
    if ("value" in contents && typeof contents.value === "string") {
      return contents.value;
    }
  }
  return String(contents);
}
function firstNonWhitespaceColumn(lineText) {
  const match = lineText.match(/\S/);
  return match ? match.index ?? 0 : 0;
}
function findSymbolMatchIndexes(lineText, symbol, caseInsensitive = false) {
  if (symbol.length === 0) return [];
  const haystack = caseInsensitive ? lineText.toLowerCase() : lineText;
  const needle = caseInsensitive ? symbol.toLowerCase() : symbol;
  const indexes = [];
  let fromIndex = 0;
  while (fromIndex <= haystack.length - needle.length) {
    const matchIndex = haystack.indexOf(needle, fromIndex);
    if (matchIndex === -1) break;
    indexes.push(matchIndex);
    fromIndex = matchIndex + needle.length;
  }
  return indexes;
}
function normalizeOccurrence(occurrence) {
  if (occurrence === void 0 || !Number.isFinite(occurrence)) return 1;
  return Math.max(1, Math.trunc(occurrence));
}
async function resolveSymbolColumn(filePath, line, symbol, occurrence) {
  const lineNumber = Math.max(1, line);
  const matchOccurrence = normalizeOccurrence(occurrence);
  try {
    const fileText = await fsPromises.readFile(filePath, "utf-8");
    const lines = fileText.split("\n");
    const targetLine = lines[lineNumber - 1] ?? "";
    if (!symbol) {
      return firstNonWhitespaceColumn(targetLine);
    }
    const exactIndexes = findSymbolMatchIndexes(targetLine, symbol);
    const fallbackIndexes = exactIndexes.length > 0 ? exactIndexes : findSymbolMatchIndexes(targetLine, symbol, true);
    if (fallbackIndexes.length === 0) {
      throw new Error(`Symbol "${symbol}" not found on line ${lineNumber}`);
    }
    if (matchOccurrence > fallbackIndexes.length) {
      throw new Error(
        `Symbol "${symbol}" occurrence ${matchOccurrence} is out of bounds on line ${lineNumber} (found ${fallbackIndexes.length})`
      );
    }
    return fallbackIndexes[matchOccurrence - 1];
  } catch (error) {
    if (isEnoent(error)) {
      throw new Error(`File not found: ${filePath}`);
    }
    throw error;
  }
}
async function readLocationContext(filePath, line, contextLines = 1) {
  const targetLine = Math.max(1, line);
  const surrounding = Math.max(0, contextLines);
  try {
    const fileText = await fsPromises.readFile(filePath, "utf-8");
    const lines = fileText.split("\n");
    if (lines.length === 0) return [];
    const startLine = Math.max(1, targetLine - surrounding);
    const endLine = Math.min(lines.length, targetLine + surrounding);
    const context = [];
    for (let currentLine = startLine; currentLine <= endLine; currentLine++) {
      const content = lines[currentLine - 1] ?? "";
      context.push(`${currentLine}: ${content}`);
    }
    return context;
  } catch (error) {
    if (isEnoent(error)) {
      return [];
    }
    throw error;
  }
}
function formatCallHierarchyItem(item, cwd) {
  const icon = symbolKindToIcon(item.kind);
  const detail = item.detail ? ` ${item.detail}` : "";
  const relPath = path.relative(cwd, uriToFile(item.uri));
  const line = item.selectionRange.start.line + 1;
  return `${icon} ${item.name}${detail} @ ${relPath}:${line}`;
}
function extractDocText(doc) {
  if (!doc) return "";
  if (typeof doc === "string") return doc;
  return doc.value;
}
function formatSignatureHelp(result) {
  if (!result.signatures || result.signatures.length === 0) {
    return "No signature information";
  }
  const activeIdx = result.activeSignature ?? 0;
  const sig = result.signatures[activeIdx] ?? result.signatures[0];
  const activeParam = result.activeParameter ?? sig.activeParameter;
  const lines = [sig.label];
  const sigDoc = extractDocText(sig.documentation);
  if (sigDoc) {
    lines.push("", sigDoc);
  }
  if (sig.parameters && sig.parameters.length > 0) {
    lines.push("", "Parameters:");
    for (let i = 0; i < sig.parameters.length; i++) {
      const p = sig.parameters[i];
      const label = typeof p.label === "string" ? p.label : sig.label.slice(p.label[0], p.label[1]);
      const active = i === activeParam ? " <-- active" : "";
      const doc = extractDocText(p.documentation);
      const docSuffix = doc ? ` \u2014 ${doc}` : "";
      lines.push(`  ${label}${docSuffix}${active}`);
    }
  }
  return lines.join("\n");
}
export {
  applyCodeAction,
  collectGlobMatches,
  dedupeWorkspaceSymbols,
  detectLanguageId,
  extractHoverText,
  fileToUri,
  filterWorkspaceSymbols,
  formatCallHierarchyItem,
  formatCodeAction,
  formatDiagnostic,
  formatDiagnosticsSummary,
  formatDocumentSymbol,
  formatGroupedDiagnosticMessages,
  formatLocation,
  formatSignatureHelp,
  formatSymbolInformation,
  formatWorkspaceEdit,
  hasGlobPattern,
  readLocationContext,
  resolveSymbolColumn,
  sortDiagnostics,
  symbolKindToIcon,
  uriToFile
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL2xzcC91dGlscy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0ICogYXMgZnNQcm9taXNlcyBmcm9tIFwibm9kZTpmcy9wcm9taXNlc1wiO1xuaW1wb3J0IHBhdGggZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZ2xvYiB9IGZyb20gXCJnbG9iXCI7XG5pbXBvcnQgeyBpc0Vub2VudCB9IGZyb20gXCIuL2hlbHBlcnMuanNcIjtcbmltcG9ydCB0eXBlIHtcblx0Q2FsbEhpZXJhcmNoeUl0ZW0sXG5cdENvZGVBY3Rpb24sXG5cdENvbW1hbmQsXG5cdERpYWdub3N0aWMsXG5cdERpYWdub3N0aWNTZXZlcml0eSxcblx0RG9jdW1lbnRTeW1ib2wsXG5cdExvY2F0aW9uLFxuXHRNYXJrdXBDb250ZW50LFxuXHRTaWduYXR1cmVIZWxwLFxuXHRTeW1ib2xJbmZvcm1hdGlvbixcblx0U3ltYm9sS2luZCxcblx0VGV4dEVkaXQsXG5cdFdvcmtzcGFjZUVkaXQsXG59IGZyb20gXCIuL3R5cGVzLmpzXCI7XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBMYW5ndWFnZSBEZXRlY3Rpb25cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmNvbnN0IExBTkdVQUdFX01BUDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcblx0Ly8gVHlwZVNjcmlwdC9KYXZhU2NyaXB0XG5cdFwiLnRzXCI6IFwidHlwZXNjcmlwdFwiLFxuXHRcIi50c3hcIjogXCJ0eXBlc2NyaXB0cmVhY3RcIixcblx0XCIuanNcIjogXCJqYXZhc2NyaXB0XCIsXG5cdFwiLmpzeFwiOiBcImphdmFzY3JpcHRyZWFjdFwiLFxuXHRcIi5tanNcIjogXCJqYXZhc2NyaXB0XCIsXG5cdFwiLmNqc1wiOiBcImphdmFzY3JpcHRcIixcblx0XCIubXRzXCI6IFwidHlwZXNjcmlwdFwiLFxuXHRcIi5jdHNcIjogXCJ0eXBlc2NyaXB0XCIsXG5cblx0Ly8gU3lzdGVtcyBsYW5ndWFnZXNcblx0XCIucnNcIjogXCJydXN0XCIsXG5cdFwiLmdvXCI6IFwiZ29cIixcblx0XCIuY1wiOiBcImNcIixcblx0XCIuaFwiOiBcImNcIixcblx0XCIuY3BwXCI6IFwiY3BwXCIsXG5cdFwiLmNjXCI6IFwiY3BwXCIsXG5cdFwiLmN4eFwiOiBcImNwcFwiLFxuXHRcIi5ocHBcIjogXCJjcHBcIixcblx0XCIuaHh4XCI6IFwiY3BwXCIsXG5cdFwiLnppZ1wiOiBcInppZ1wiLFxuXG5cdC8vIFNjcmlwdGluZyBsYW5ndWFnZXNcblx0XCIucHlcIjogXCJweXRob25cIixcblx0XCIucmJcIjogXCJydWJ5XCIsXG5cdFwiLmx1YVwiOiBcImx1YVwiLFxuXHRcIi5zaFwiOiBcInNoZWxsc2NyaXB0XCIsXG5cdFwiLmJhc2hcIjogXCJzaGVsbHNjcmlwdFwiLFxuXHRcIi56c2hcIjogXCJzaGVsbHNjcmlwdFwiLFxuXHRcIi5maXNoXCI6IFwiZmlzaFwiLFxuXHRcIi5wbFwiOiBcInBlcmxcIixcblx0XCIucGhwXCI6IFwicGhwXCIsXG5cblx0Ly8gSlZNIGxhbmd1YWdlc1xuXHRcIi5qYXZhXCI6IFwiamF2YVwiLFxuXHRcIi5rdFwiOiBcImtvdGxpblwiLFxuXHRcIi5rdHNcIjogXCJrb3RsaW5cIixcblx0XCIuc2NhbGFcIjogXCJzY2FsYVwiLFxuXHRcIi5ncm9vdnlcIjogXCJncm9vdnlcIixcblx0XCIuY2xqXCI6IFwiY2xvanVyZVwiLFxuXG5cdC8vIC5ORVQgbGFuZ3VhZ2VzXG5cdFwiLmNzXCI6IFwiY3NoYXJwXCIsXG5cdFwiLmZzXCI6IFwiZnNoYXJwXCIsXG5cdFwiLnZiXCI6IFwidmJcIixcblxuXHQvLyBXZWJcblx0XCIuaHRtbFwiOiBcImh0bWxcIixcblx0XCIuaHRtXCI6IFwiaHRtbFwiLFxuXHRcIi5jc3NcIjogXCJjc3NcIixcblx0XCIuc2Nzc1wiOiBcInNjc3NcIixcblx0XCIuc2Fzc1wiOiBcInNhc3NcIixcblx0XCIubGVzc1wiOiBcImxlc3NcIixcblx0XCIudnVlXCI6IFwidnVlXCIsXG5cdFwiLnN2ZWx0ZVwiOiBcInN2ZWx0ZVwiLFxuXG5cdC8vIERhdGEgZm9ybWF0c1xuXHRcIi5qc29uXCI6IFwianNvblwiLFxuXHRcIi5qc29uY1wiOiBcImpzb25jXCIsXG5cdFwiLnlhbWxcIjogXCJ5YW1sXCIsXG5cdFwiLnltbFwiOiBcInlhbWxcIixcblx0XCIudG9tbFwiOiBcInRvbWxcIixcblx0XCIueG1sXCI6IFwieG1sXCIsXG5cdFwiLmluaVwiOiBcImluaVwiLFxuXG5cdC8vIERvY3VtZW50YXRpb25cblx0XCIubWRcIjogXCJtYXJrZG93blwiLFxuXHRcIi5tYXJrZG93blwiOiBcIm1hcmtkb3duXCIsXG5cdFwiLnJzdFwiOiBcInJlc3RydWN0dXJlZHRleHRcIixcblx0XCIuYWRvY1wiOiBcImFzY2lpZG9jXCIsXG5cdFwiLnRleFwiOiBcImxhdGV4XCIsXG5cblx0Ly8gT3RoZXJcblx0XCIuc3FsXCI6IFwic3FsXCIsXG5cdFwiLmdyYXBocWxcIjogXCJncmFwaHFsXCIsXG5cdFwiLmdxbFwiOiBcImdyYXBocWxcIixcblx0XCIucHJvdG9cIjogXCJwcm90b2J1ZlwiLFxuXHRcIi5kb2NrZXJmaWxlXCI6IFwiZG9ja2VyZmlsZVwiLFxuXHRcIi50ZlwiOiBcInRlcnJhZm9ybVwiLFxuXHRcIi5oY2xcIjogXCJoY2xcIixcblx0XCIubml4XCI6IFwibml4XCIsXG5cdFwiLmV4XCI6IFwiZWxpeGlyXCIsXG5cdFwiLmV4c1wiOiBcImVsaXhpclwiLFxuXHRcIi5lcmxcIjogXCJlcmxhbmdcIixcblx0XCIuaHJsXCI6IFwiZXJsYW5nXCIsXG5cdFwiLmhzXCI6IFwiaGFza2VsbFwiLFxuXHRcIi5tbFwiOiBcIm9jYW1sXCIsXG5cdFwiLm1saVwiOiBcIm9jYW1sXCIsXG5cdFwiLnN3aWZ0XCI6IFwic3dpZnRcIixcblx0XCIuclwiOiBcInJcIixcblx0XCIuUlwiOiBcInJcIixcblx0XCIuamxcIjogXCJqdWxpYVwiLFxuXHRcIi5kYXJ0XCI6IFwiZGFydFwiLFxuXHRcIi5lbG1cIjogXCJlbG1cIixcblx0XCIudlwiOiBcInZcIixcblx0XCIubmltXCI6IFwibmltXCIsXG5cdFwiLmNyXCI6IFwiY3J5c3RhbFwiLFxuXHRcIi5kXCI6IFwiZFwiLFxuXHRcIi5wYXNcIjogXCJwYXNjYWxcIixcblx0XCIucHBcIjogXCJwYXNjYWxcIixcblx0XCIubGlzcFwiOiBcImxpc3BcIixcblx0XCIubHNwXCI6IFwibGlzcFwiLFxuXHRcIi5ya3RcIjogXCJyYWNrZXRcIixcblx0XCIuc2NtXCI6IFwic2NoZW1lXCIsXG5cdFwiLnBzMVwiOiBcInBvd2Vyc2hlbGxcIixcblx0XCIucHNtMVwiOiBcInBvd2Vyc2hlbGxcIixcblx0XCIuYmF0XCI6IFwiYmF0XCIsXG5cdFwiLmNtZFwiOiBcImJhdFwiLFxufTtcblxuLyoqXG4gKiBEZXRlY3QgbGFuZ3VhZ2UgSUQgZnJvbSBmaWxlIHBhdGguXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkZXRlY3RMYW5ndWFnZUlkKGZpbGVQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuXHRjb25zdCBleHQgPSBwYXRoLmV4dG5hbWUoZmlsZVBhdGgpLnRvTG93ZXJDYXNlKCk7XG5cdGNvbnN0IGJhc2VuYW1lID0gcGF0aC5iYXNlbmFtZShmaWxlUGF0aCkudG9Mb3dlckNhc2UoKTtcblxuXHRpZiAoYmFzZW5hbWUgPT09IFwiZG9ja2VyZmlsZVwiIHx8IGJhc2VuYW1lLnN0YXJ0c1dpdGgoXCJkb2NrZXJmaWxlLlwiKSkge1xuXHRcdHJldHVybiBcImRvY2tlcmZpbGVcIjtcblx0fVxuXHRpZiAoYmFzZW5hbWUgPT09IFwibWFrZWZpbGVcIiB8fCBiYXNlbmFtZSA9PT0gXCJnbnVtYWtlZmlsZVwiKSB7XG5cdFx0cmV0dXJuIFwibWFrZWZpbGVcIjtcblx0fVxuXHRpZiAoYmFzZW5hbWUgPT09IFwiY21ha2VsaXN0cy50eHRcIiB8fCBleHQgPT09IFwiLmNtYWtlXCIpIHtcblx0XHRyZXR1cm4gXCJjbWFrZVwiO1xuXHR9XG5cblx0cmV0dXJuIExBTkdVQUdFX01BUFtleHRdID8/IFwicGxhaW50ZXh0XCI7XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBVUkkgSGFuZGxpbmcgKENyb3NzLVBsYXRmb3JtKVxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuZXhwb3J0IGZ1bmN0aW9uIGZpbGVUb1VyaShmaWxlUGF0aDogc3RyaW5nKTogc3RyaW5nIHtcblx0Y29uc3QgcmVzb2x2ZWQgPSBwYXRoLnJlc29sdmUoZmlsZVBhdGgpO1xuXG5cdGlmIChwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIpIHtcblx0XHRyZXR1cm4gYGZpbGU6Ly8vJHtyZXNvbHZlZC5yZXBsYWNlKC9cXFxcL2csIFwiL1wiKX1gO1xuXHR9XG5cblx0cmV0dXJuIGBmaWxlOi8vJHtyZXNvbHZlZH1gO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdXJpVG9GaWxlKHVyaTogc3RyaW5nKTogc3RyaW5nIHtcblx0aWYgKCF1cmkuc3RhcnRzV2l0aChcImZpbGU6Ly9cIikpIHtcblx0XHRyZXR1cm4gdXJpO1xuXHR9XG5cblx0bGV0IGZpbGVQYXRoID0gZGVjb2RlVVJJQ29tcG9uZW50KHVyaS5zbGljZSg3KSk7XG5cblx0aWYgKHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIiAmJiBmaWxlUGF0aC5zdGFydHNXaXRoKFwiL1wiKSAmJiAvXltBLVphLXpdOi8udGVzdChmaWxlUGF0aC5zbGljZSgxKSkpIHtcblx0XHRmaWxlUGF0aCA9IGZpbGVQYXRoLnNsaWNlKDEpO1xuXHR9XG5cblx0cmV0dXJuIGZpbGVQYXRoO1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gRGlhZ25vc3RpYyBGb3JtYXR0aW5nXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5jb25zdCBTRVZFUklUWV9OQU1FUzogUmVjb3JkPERpYWdub3N0aWNTZXZlcml0eSwgc3RyaW5nPiA9IHtcblx0MTogXCJlcnJvclwiLFxuXHQyOiBcIndhcm5pbmdcIixcblx0MzogXCJpbmZvXCIsXG5cdDQ6IFwiaGludFwiLFxufTtcblxuZnVuY3Rpb24gc2V2ZXJpdHlUb1N0cmluZyhzZXZlcml0eT86IERpYWdub3N0aWNTZXZlcml0eSk6IHN0cmluZyB7XG5cdHJldHVybiBTRVZFUklUWV9OQU1FU1tzZXZlcml0eSA/PyAxXSA/PyBcInVua25vd25cIjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNvcnREaWFnbm9zdGljcyhkaWFnbm9zdGljczogRGlhZ25vc3RpY1tdKTogRGlhZ25vc3RpY1tdIHtcblx0cmV0dXJuIGRpYWdub3N0aWNzLnNvcnQoKGEsIGIpID0+IHtcblx0XHRjb25zdCBhU2V2ZXJpdHkgPSBhLnNldmVyaXR5ID8/IDE7XG5cdFx0Y29uc3QgYlNldmVyaXR5ID0gYi5zZXZlcml0eSA/PyAxO1xuXHRcdGlmIChhU2V2ZXJpdHkgIT09IGJTZXZlcml0eSkgcmV0dXJuIGFTZXZlcml0eSAtIGJTZXZlcml0eTtcblx0XHRjb25zdCBhTGluZSA9IGEucmFuZ2Uuc3RhcnQubGluZTtcblx0XHRjb25zdCBiTGluZSA9IGIucmFuZ2Uuc3RhcnQubGluZTtcblx0XHRpZiAoYUxpbmUgIT09IGJMaW5lKSByZXR1cm4gYUxpbmUgLSBiTGluZTtcblx0XHRjb25zdCBhQ29sID0gYS5yYW5nZS5zdGFydC5jaGFyYWN0ZXI7XG5cdFx0Y29uc3QgYkNvbCA9IGIucmFuZ2Uuc3RhcnQuY2hhcmFjdGVyO1xuXHRcdGlmIChhQ29sICE9PSBiQ29sKSByZXR1cm4gYUNvbCAtIGJDb2w7XG5cdFx0cmV0dXJuIGEubWVzc2FnZS5sb2NhbGVDb21wYXJlKGIubWVzc2FnZSk7XG5cdH0pO1xufVxuXG5mdW5jdGlvbiBzdHJpcERpYWdub3N0aWNOb2lzZShtZXNzYWdlOiBzdHJpbmcpOiBzdHJpbmcge1xuXHRyZXR1cm4gbWVzc2FnZVxuXHRcdC5zcGxpdChcIlxcblwiKVxuXHRcdC5maWx0ZXIobGluZSA9PiB7XG5cdFx0XHRjb25zdCB0cmltbWVkID0gbGluZS50cmltKCk7XG5cdFx0XHRpZiAodHJpbW1lZC5zdGFydHNXaXRoKFwiZm9yIGZ1cnRoZXIgaW5mb3JtYXRpb24gdmlzaXRcIikpIHJldHVybiBmYWxzZTtcblx0XHRcdGlmICgvXmh0dHBzPzpcXC9cXC8vLnRlc3QodHJpbW1lZCkpIHJldHVybiBmYWxzZTtcblx0XHRcdHJldHVybiB0cnVlO1xuXHRcdH0pXG5cdFx0LmpvaW4oXCJcXG5cIilcblx0XHQudHJpbSgpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0RGlhZ25vc3RpYyhkaWFnbm9zdGljOiBEaWFnbm9zdGljLCBmaWxlUGF0aDogc3RyaW5nKTogc3RyaW5nIHtcblx0Y29uc3Qgc2V2ZXJpdHkgPSBzZXZlcml0eVRvU3RyaW5nKGRpYWdub3N0aWMuc2V2ZXJpdHkpO1xuXHRjb25zdCBsaW5lID0gZGlhZ25vc3RpYy5yYW5nZS5zdGFydC5saW5lICsgMTtcblx0Y29uc3QgY29sID0gZGlhZ25vc3RpYy5yYW5nZS5zdGFydC5jaGFyYWN0ZXIgKyAxO1xuXHRjb25zdCBzb3VyY2UgPSBkaWFnbm9zdGljLnNvdXJjZSA/IGBbJHtkaWFnbm9zdGljLnNvdXJjZX1dIGAgOiBcIlwiO1xuXHRjb25zdCBjb2RlID0gZGlhZ25vc3RpYy5jb2RlICE9PSB1bmRlZmluZWQgPyBgICgke2RpYWdub3N0aWMuY29kZX0pYCA6IFwiXCI7XG5cdGNvbnN0IG1lc3NhZ2UgPSBzdHJpcERpYWdub3N0aWNOb2lzZShkaWFnbm9zdGljLm1lc3NhZ2UpO1xuXG5cdHJldHVybiBgJHtmaWxlUGF0aH06JHtsaW5lfToke2NvbH0gWyR7c2V2ZXJpdHl9XSAke3NvdXJjZX0ke21lc3NhZ2V9JHtjb2RlfWA7XG59XG5cbmNvbnN0IERJQUdfUEFUSF9SRSA9IC9eKC4rPyk6KFxcZCs6XFxkK1xccysuKikkLztcblxuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdEdyb3VwZWREaWFnbm9zdGljTWVzc2FnZXMobWVzc2FnZXM6IHN0cmluZ1tdKTogc3RyaW5nIHtcblx0Y29uc3QgZGlhZ25vc3RpY3NCeUZpbGUgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nW10+KCk7XG5cdGNvbnN0IGZpbGVPcmRlcjogc3RyaW5nW10gPSBbXTtcblx0Y29uc3QgdW5ncm91cGVkOiBzdHJpbmdbXSA9IFtdO1xuXG5cdGZvciAoY29uc3QgbXNnIG9mIG1lc3NhZ2VzKSB7XG5cdFx0Y29uc3QgbWF0Y2ggPSBESUFHX1BBVEhfUkUuZXhlYyhtc2cpO1xuXHRcdGlmICghbWF0Y2gpIHtcblx0XHRcdHVuZ3JvdXBlZC5wdXNoKG1zZyk7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cblx0XHRjb25zdCBbLCByYXdGaWxlUGF0aCwgcmVzdF0gPSBtYXRjaDtcblx0XHRjb25zdCBmaWxlUGF0aCA9IHJhd0ZpbGVQYXRoLnJlcGxhY2UoL1xcXFwvZywgXCIvXCIpO1xuXHRcdGlmICghZGlhZ25vc3RpY3NCeUZpbGUuaGFzKGZpbGVQYXRoKSkge1xuXHRcdFx0ZGlhZ25vc3RpY3NCeUZpbGUuc2V0KGZpbGVQYXRoLCBbXSk7XG5cdFx0XHRmaWxlT3JkZXIucHVzaChmaWxlUGF0aCk7XG5cdFx0fVxuXHRcdGRpYWdub3N0aWNzQnlGaWxlLmdldChmaWxlUGF0aCk/LnB1c2gocmVzdCk7XG5cdH1cblxuXHRpZiAoZGlhZ25vc3RpY3NCeUZpbGUuc2l6ZSA9PT0gMCkge1xuXHRcdHJldHVybiB1bmdyb3VwZWQuam9pbihcIlxcblwiKTtcblx0fVxuXG5cdGNvbnN0IGZpbGVzQnlEaXJlY3RvcnkgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nW10+KCk7XG5cdGZvciAoY29uc3QgZmlsZVBhdGggb2YgZmlsZU9yZGVyKSB7XG5cdFx0Y29uc3QgZGlyZWN0b3J5ID0gcGF0aC5kaXJuYW1lKGZpbGVQYXRoKS5yZXBsYWNlKC9cXFxcL2csIFwiL1wiKTtcblx0XHRpZiAoIWZpbGVzQnlEaXJlY3RvcnkuaGFzKGRpcmVjdG9yeSkpIHtcblx0XHRcdGZpbGVzQnlEaXJlY3Rvcnkuc2V0KGRpcmVjdG9yeSwgW10pO1xuXHRcdH1cblx0XHRmaWxlc0J5RGlyZWN0b3J5LmdldChkaXJlY3RvcnkpPy5wdXNoKGZpbGVQYXRoKTtcblx0fVxuXG5cdGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuXHRmb3IgKGNvbnN0IFtkaXJlY3RvcnksIGRpcmVjdG9yeUZpbGVzXSBvZiBmaWxlc0J5RGlyZWN0b3J5KSB7XG5cdFx0aWYgKGRpcmVjdG9yeSA9PT0gXCIuXCIpIHtcblx0XHRcdGZvciAoY29uc3QgZmlsZVBhdGggb2YgZGlyZWN0b3J5RmlsZXMpIHtcblx0XHRcdFx0aWYgKGxpbmVzLmxlbmd0aCA+IDApIHtcblx0XHRcdFx0XHRsaW5lcy5wdXNoKFwiXCIpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGxpbmVzLnB1c2goYCMgJHtwYXRoLmJhc2VuYW1lKGZpbGVQYXRoKX1gKTtcblx0XHRcdFx0Zm9yIChjb25zdCBkaWFnbm9zdGljIG9mIGRpYWdub3N0aWNzQnlGaWxlLmdldChmaWxlUGF0aCkgPz8gW10pIHtcblx0XHRcdFx0XHRsaW5lcy5wdXNoKGAgICR7ZGlhZ25vc3RpY31gKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0aWYgKGxpbmVzLmxlbmd0aCA+IDApIHtcblx0XHRcdGxpbmVzLnB1c2goXCJcIik7XG5cdFx0fVxuXHRcdGxpbmVzLnB1c2goYCMgJHtkaXJlY3Rvcnl9YCk7XG5cdFx0Zm9yIChjb25zdCBmaWxlUGF0aCBvZiBkaXJlY3RvcnlGaWxlcykge1xuXHRcdFx0bGluZXMucHVzaChgIyMgXHUyNTE0XHUyNTAwICR7cGF0aC5iYXNlbmFtZShmaWxlUGF0aCl9YCk7XG5cdFx0XHRmb3IgKGNvbnN0IGRpYWdub3N0aWMgb2YgZGlhZ25vc3RpY3NCeUZpbGUuZ2V0KGZpbGVQYXRoKSA/PyBbXSkge1xuXHRcdFx0XHRsaW5lcy5wdXNoKGAgICR7ZGlhZ25vc3RpY31gKTtcblx0XHRcdH1cblx0XHR9XG5cdH1cblxuXHRpZiAodW5ncm91cGVkLmxlbmd0aCA+IDApIHtcblx0XHRsaW5lcy5wdXNoKFwiXCIpO1xuXHRcdGZvciAoY29uc3QgbXNnIG9mIHVuZ3JvdXBlZCkge1xuXHRcdFx0bGluZXMucHVzaChtc2cpO1xuXHRcdH1cblx0fVxuXG5cdHJldHVybiBsaW5lcy5qb2luKFwiXFxuXCIpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0RGlhZ25vc3RpY3NTdW1tYXJ5KGRpYWdub3N0aWNzOiBEaWFnbm9zdGljW10pOiBzdHJpbmcge1xuXHRjb25zdCBjb3VudHMgPSB7IGVycm9yOiAwLCB3YXJuaW5nOiAwLCBpbmZvOiAwLCBoaW50OiAwIH07XG5cblx0Zm9yIChjb25zdCBkIG9mIGRpYWdub3N0aWNzKSB7XG5cdFx0Y29uc3Qgc2V2ID0gc2V2ZXJpdHlUb1N0cmluZyhkLnNldmVyaXR5KTtcblx0XHRpZiAoc2V2IGluIGNvdW50cykge1xuXHRcdFx0Y291bnRzW3NldiBhcyBrZXlvZiB0eXBlb2YgY291bnRzXSsrO1xuXHRcdH1cblx0fVxuXG5cdGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuXHRpZiAoY291bnRzLmVycm9yID4gMCkgcGFydHMucHVzaChgJHtjb3VudHMuZXJyb3J9IGVycm9yKHMpYCk7XG5cdGlmIChjb3VudHMud2FybmluZyA+IDApIHBhcnRzLnB1c2goYCR7Y291bnRzLndhcm5pbmd9IHdhcm5pbmcocylgKTtcblx0aWYgKGNvdW50cy5pbmZvID4gMCkgcGFydHMucHVzaChgJHtjb3VudHMuaW5mb30gaW5mbyhzKWApO1xuXHRpZiAoY291bnRzLmhpbnQgPiAwKSBwYXJ0cy5wdXNoKGAke2NvdW50cy5oaW50fSBoaW50KHMpYCk7XG5cblx0cmV0dXJuIHBhcnRzLmxlbmd0aCA+IDAgPyBwYXJ0cy5qb2luKFwiLCBcIikgOiBcIm5vIGlzc3Vlc1wiO1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gTG9jYXRpb24gRm9ybWF0dGluZ1xuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdExvY2F0aW9uKGxvY2F0aW9uOiBMb2NhdGlvbiwgY3dkOiBzdHJpbmcpOiBzdHJpbmcge1xuXHRjb25zdCBmaWxlID0gcGF0aC5yZWxhdGl2ZShjd2QsIHVyaVRvRmlsZShsb2NhdGlvbi51cmkpKTtcblx0Y29uc3QgbGluZSA9IGxvY2F0aW9uLnJhbmdlLnN0YXJ0LmxpbmUgKyAxO1xuXHRjb25zdCBjb2wgPSBsb2NhdGlvbi5yYW5nZS5zdGFydC5jaGFyYWN0ZXIgKyAxO1xuXHRyZXR1cm4gYCR7ZmlsZX06JHtsaW5lfToke2NvbH1gO1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gV29ya3NwYWNlRWRpdCBGb3JtYXR0aW5nXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0V29ya3NwYWNlRWRpdChlZGl0OiBXb3Jrc3BhY2VFZGl0LCBjd2Q6IHN0cmluZyk6IHN0cmluZ1tdIHtcblx0Y29uc3QgcmVzdWx0czogc3RyaW5nW10gPSBbXTtcblxuXHRpZiAoZWRpdC5jaGFuZ2VzKSB7XG5cdFx0Zm9yIChjb25zdCBbdXJpLCB0ZXh0RWRpdHNdIG9mIE9iamVjdC5lbnRyaWVzKGVkaXQuY2hhbmdlcykpIHtcblx0XHRcdGNvbnN0IGZpbGUgPSBwYXRoLnJlbGF0aXZlKGN3ZCwgdXJpVG9GaWxlKHVyaSkpO1xuXHRcdFx0cmVzdWx0cy5wdXNoKGAke2ZpbGV9OiAke3RleHRFZGl0cy5sZW5ndGh9IGVkaXQke3RleHRFZGl0cy5sZW5ndGggPiAxID8gXCJzXCIgOiBcIlwifWApO1xuXHRcdH1cblx0fVxuXG5cdGlmIChlZGl0LmRvY3VtZW50Q2hhbmdlcykge1xuXHRcdGZvciAoY29uc3QgY2hhbmdlIG9mIGVkaXQuZG9jdW1lbnRDaGFuZ2VzKSB7XG5cdFx0XHRpZiAoXCJlZGl0c1wiIGluIGNoYW5nZSAmJiBjaGFuZ2UudGV4dERvY3VtZW50KSB7XG5cdFx0XHRcdGNvbnN0IGZpbGUgPSBwYXRoLnJlbGF0aXZlKGN3ZCwgdXJpVG9GaWxlKGNoYW5nZS50ZXh0RG9jdW1lbnQudXJpKSk7XG5cdFx0XHRcdHJlc3VsdHMucHVzaChgJHtmaWxlfTogJHtjaGFuZ2UuZWRpdHMubGVuZ3RofSBlZGl0JHtjaGFuZ2UuZWRpdHMubGVuZ3RoID4gMSA/IFwic1wiIDogXCJcIn1gKTtcblx0XHRcdH0gZWxzZSBpZiAoXCJraW5kXCIgaW4gY2hhbmdlKSB7XG5cdFx0XHRcdHN3aXRjaCAoY2hhbmdlLmtpbmQpIHtcblx0XHRcdFx0XHRjYXNlIFwiY3JlYXRlXCI6XG5cdFx0XHRcdFx0XHRyZXN1bHRzLnB1c2goYENSRUFURTogJHtwYXRoLnJlbGF0aXZlKGN3ZCwgdXJpVG9GaWxlKGNoYW5nZS51cmkpKX1gKTtcblx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRcdGNhc2UgXCJyZW5hbWVcIjpcblx0XHRcdFx0XHRcdHJlc3VsdHMucHVzaChcblx0XHRcdFx0XHRcdFx0YFJFTkFNRTogJHtwYXRoLnJlbGF0aXZlKGN3ZCwgdXJpVG9GaWxlKGNoYW5nZS5vbGRVcmkpKX0gLT4gJHtwYXRoLnJlbGF0aXZlKGN3ZCwgdXJpVG9GaWxlKGNoYW5nZS5uZXdVcmkpKX1gLFxuXHRcdFx0XHRcdFx0KTtcblx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRcdGNhc2UgXCJkZWxldGVcIjpcblx0XHRcdFx0XHRcdHJlc3VsdHMucHVzaChgREVMRVRFOiAke3BhdGgucmVsYXRpdmUoY3dkLCB1cmlUb0ZpbGUoY2hhbmdlLnVyaSkpfWApO1xuXHRcdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9XG5cdH1cblxuXHRyZXR1cm4gcmVzdWx0cztcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFN5bWJvbCBGb3JtYXR0aW5nXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5jb25zdCBTWU1CT0xfS0lORF9MQUJFTFM6IFJlY29yZDxudW1iZXIsIHN0cmluZz4gPSB7XG5cdDE6IFwiRmlsZVwiLFxuXHQyOiBcIk1vZHVsZVwiLFxuXHQzOiBcIk5hbWVzcGFjZVwiLFxuXHQ0OiBcIlBhY2thZ2VcIixcblx0NTogXCJDbGFzc1wiLFxuXHQ2OiBcIk1ldGhvZFwiLFxuXHQ3OiBcIlByb3BlcnR5XCIsXG5cdDg6IFwiRmllbGRcIixcblx0OTogXCJDb25zdHJ1Y3RvclwiLFxuXHQxMDogXCJFbnVtXCIsXG5cdDExOiBcIkludGVyZmFjZVwiLFxuXHQxMjogXCJGdW5jdGlvblwiLFxuXHQxMzogXCJWYXJpYWJsZVwiLFxuXHQxNDogXCJDb25zdGFudFwiLFxuXHQxNTogXCJTdHJpbmdcIixcblx0MTY6IFwiTnVtYmVyXCIsXG5cdDE3OiBcIkJvb2xlYW5cIixcblx0MTg6IFwiQXJyYXlcIixcblx0MTk6IFwiT2JqZWN0XCIsXG5cdDIwOiBcIktleVwiLFxuXHQyMTogXCJOdWxsXCIsXG5cdDIyOiBcIkVudW1NZW1iZXJcIixcblx0MjM6IFwiU3RydWN0XCIsXG5cdDI0OiBcIkV2ZW50XCIsXG5cdDI1OiBcIk9wZXJhdG9yXCIsXG5cdDI2OiBcIlR5cGVQYXJhbWV0ZXJcIixcbn07XG5cbmV4cG9ydCBmdW5jdGlvbiBzeW1ib2xLaW5kVG9JY29uKGtpbmQ6IFN5bWJvbEtpbmQpOiBzdHJpbmcge1xuXHRyZXR1cm4gYFske1NZTUJPTF9LSU5EX0xBQkVMU1traW5kXSA/PyBcIj9cIn1dYDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdERvY3VtZW50U3ltYm9sKHN5bWJvbDogRG9jdW1lbnRTeW1ib2wsIGluZGVudCA9IDApOiBzdHJpbmdbXSB7XG5cdGNvbnN0IHByZWZpeCA9IFwiICBcIi5yZXBlYXQoaW5kZW50KTtcblx0Y29uc3QgaWNvbiA9IHN5bWJvbEtpbmRUb0ljb24oc3ltYm9sLmtpbmQpO1xuXHRjb25zdCBsaW5lID0gc3ltYm9sLnJhbmdlLnN0YXJ0LmxpbmUgKyAxO1xuXHRjb25zdCBkZXRhaWwgPSBzeW1ib2wuZGV0YWlsID8gYCAke3N5bWJvbC5kZXRhaWx9YCA6IFwiXCI7XG5cdGNvbnN0IHJlc3VsdHMgPSBbYCR7cHJlZml4fSR7aWNvbn0gJHtzeW1ib2wubmFtZX0ke2RldGFpbH0gQCBsaW5lICR7bGluZX1gXTtcblxuXHRpZiAoc3ltYm9sLmNoaWxkcmVuKSB7XG5cdFx0Zm9yIChjb25zdCBjaGlsZCBvZiBzeW1ib2wuY2hpbGRyZW4pIHtcblx0XHRcdHJlc3VsdHMucHVzaCguLi5mb3JtYXREb2N1bWVudFN5bWJvbChjaGlsZCwgaW5kZW50ICsgMSkpO1xuXHRcdH1cblx0fVxuXG5cdHJldHVybiByZXN1bHRzO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0U3ltYm9sSW5mb3JtYXRpb24oc3ltYm9sOiBTeW1ib2xJbmZvcm1hdGlvbiwgY3dkOiBzdHJpbmcpOiBzdHJpbmcge1xuXHRjb25zdCBpY29uID0gc3ltYm9sS2luZFRvSWNvbihzeW1ib2wua2luZCk7XG5cdGNvbnN0IGxvY2F0aW9uID0gZm9ybWF0TG9jYXRpb24oc3ltYm9sLmxvY2F0aW9uLCBjd2QpO1xuXHRjb25zdCBjb250YWluZXIgPSBzeW1ib2wuY29udGFpbmVyTmFtZSA/IGAgKCR7c3ltYm9sLmNvbnRhaW5lck5hbWV9KWAgOiBcIlwiO1xuXHRyZXR1cm4gYCR7aWNvbn0gJHtzeW1ib2wubmFtZX0ke2NvbnRhaW5lcn0gQCAke2xvY2F0aW9ufWA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBmaWx0ZXJXb3Jrc3BhY2VTeW1ib2xzKHN5bWJvbHM6IFN5bWJvbEluZm9ybWF0aW9uW10sIHF1ZXJ5OiBzdHJpbmcpOiBTeW1ib2xJbmZvcm1hdGlvbltdIHtcblx0Y29uc3QgbmVlZGxlID0gcXVlcnkudHJpbSgpLnRvTG93ZXJDYXNlKCk7XG5cdGlmICghbmVlZGxlKSByZXR1cm4gc3ltYm9scztcblx0cmV0dXJuIHN5bWJvbHMuZmlsdGVyKHN5bWJvbCA9PiB7XG5cdFx0Y29uc3QgZmllbGRzID0gW3N5bWJvbC5uYW1lLCBzeW1ib2wuY29udGFpbmVyTmFtZSA/PyBcIlwiLCB1cmlUb0ZpbGUoc3ltYm9sLmxvY2F0aW9uLnVyaSldO1xuXHRcdHJldHVybiBmaWVsZHMuc29tZShmaWVsZCA9PiBmaWVsZC50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKG5lZWRsZSkpO1xuXHR9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGRlZHVwZVdvcmtzcGFjZVN5bWJvbHMoc3ltYm9sczogU3ltYm9sSW5mb3JtYXRpb25bXSk6IFN5bWJvbEluZm9ybWF0aW9uW10ge1xuXHRjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cdGNvbnN0IHVuaXF1ZTogU3ltYm9sSW5mb3JtYXRpb25bXSA9IFtdO1xuXHRmb3IgKGNvbnN0IHN5bWJvbCBvZiBzeW1ib2xzKSB7XG5cdFx0Y29uc3Qga2V5ID0gW1xuXHRcdFx0c3ltYm9sLm5hbWUsXG5cdFx0XHRzeW1ib2wuY29udGFpbmVyTmFtZSA/PyBcIlwiLFxuXHRcdFx0c3ltYm9sLmtpbmQsXG5cdFx0XHRzeW1ib2wubG9jYXRpb24udXJpLFxuXHRcdFx0c3ltYm9sLmxvY2F0aW9uLnJhbmdlLnN0YXJ0LmxpbmUsXG5cdFx0XHRzeW1ib2wubG9jYXRpb24ucmFuZ2Uuc3RhcnQuY2hhcmFjdGVyLFxuXHRcdF0uam9pbihcIjpcIik7XG5cdFx0aWYgKHNlZW4uaGFzKGtleSkpIGNvbnRpbnVlO1xuXHRcdHNlZW4uYWRkKGtleSk7XG5cdFx0dW5pcXVlLnB1c2goc3ltYm9sKTtcblx0fVxuXHRyZXR1cm4gdW5pcXVlO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0Q29kZUFjdGlvbihhY3Rpb246IENvZGVBY3Rpb24gfCBDb21tYW5kLCBpbmRleDogbnVtYmVyKTogc3RyaW5nIHtcblx0Y29uc3Qga2luZCA9IFwia2luZFwiIGluIGFjdGlvbiAmJiBhY3Rpb24ua2luZCA/IGFjdGlvbi5raW5kIDogXCJhY3Rpb25cIjtcblx0Y29uc3QgcHJlZmVycmVkID0gXCJpc1ByZWZlcnJlZFwiIGluIGFjdGlvbiAmJiBhY3Rpb24uaXNQcmVmZXJyZWQgPyBcIiAocHJlZmVycmVkKVwiIDogXCJcIjtcblx0Y29uc3QgZGlzYWJsZWQgPSBcImRpc2FibGVkXCIgaW4gYWN0aW9uICYmIGFjdGlvbi5kaXNhYmxlZCA/IGAgKGRpc2FibGVkOiAke2FjdGlvbi5kaXNhYmxlZC5yZWFzb259KWAgOiBcIlwiO1xuXHRyZXR1cm4gYCR7aW5kZXh9OiBbJHtraW5kfV0gJHthY3Rpb24udGl0bGV9JHtwcmVmZXJyZWR9JHtkaXNhYmxlZH1gO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIENvZGVBY3Rpb25BcHBseURlcGVuZGVuY2llcyB7XG5cdHJlc29sdmVDb2RlQWN0aW9uPzogKGFjdGlvbjogQ29kZUFjdGlvbikgPT4gUHJvbWlzZTxDb2RlQWN0aW9uPjtcblx0YXBwbHlXb3Jrc3BhY2VFZGl0OiAoZWRpdDogV29ya3NwYWNlRWRpdCkgPT4gUHJvbWlzZTxzdHJpbmdbXT47XG5cdGV4ZWN1dGVDb21tYW5kOiAoY29tbWFuZDogQ29tbWFuZCkgPT4gUHJvbWlzZTx2b2lkPjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBcHBsaWVkQ29kZUFjdGlvblJlc3VsdCB7XG5cdHRpdGxlOiBzdHJpbmc7XG5cdGVkaXRzOiBzdHJpbmdbXTtcblx0ZXhlY3V0ZWRDb21tYW5kczogc3RyaW5nW107XG59XG5cbmZ1bmN0aW9uIGlzQ29tbWFuZEl0ZW0oYWN0aW9uOiBDb2RlQWN0aW9uIHwgQ29tbWFuZCk6IGFjdGlvbiBpcyBDb21tYW5kIHtcblx0cmV0dXJuIHR5cGVvZiBhY3Rpb24uY29tbWFuZCA9PT0gXCJzdHJpbmdcIjtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGFwcGx5Q29kZUFjdGlvbihcblx0YWN0aW9uOiBDb2RlQWN0aW9uIHwgQ29tbWFuZCxcblx0ZGVwZW5kZW5jaWVzOiBDb2RlQWN0aW9uQXBwbHlEZXBlbmRlbmNpZXMsXG4pOiBQcm9taXNlPEFwcGxpZWRDb2RlQWN0aW9uUmVzdWx0IHwgbnVsbD4ge1xuXHRpZiAoaXNDb21tYW5kSXRlbShhY3Rpb24pKSB7XG5cdFx0YXdhaXQgZGVwZW5kZW5jaWVzLmV4ZWN1dGVDb21tYW5kKGFjdGlvbik7XG5cdFx0cmV0dXJuIHsgdGl0bGU6IGFjdGlvbi50aXRsZSwgZWRpdHM6IFtdLCBleGVjdXRlZENvbW1hbmRzOiBbYWN0aW9uLmNvbW1hbmRdIH07XG5cdH1cblxuXHRsZXQgcmVzb2x2ZWRBY3Rpb24gPSBhY3Rpb247XG5cdGlmICghcmVzb2x2ZWRBY3Rpb24uZWRpdCAmJiBkZXBlbmRlbmNpZXMucmVzb2x2ZUNvZGVBY3Rpb24pIHtcblx0XHR0cnkge1xuXHRcdFx0cmVzb2x2ZWRBY3Rpb24gPSBhd2FpdCBkZXBlbmRlbmNpZXMucmVzb2x2ZUNvZGVBY3Rpb24ocmVzb2x2ZWRBY3Rpb24pO1xuXHRcdH0gY2F0Y2gge1xuXHRcdFx0Ly8gUmVzb2x2ZSBpcyBvcHRpb25hbDsgY29udGludWUgd2l0aCB1bnJlc29sdmVkIGFjdGlvbi5cblx0XHR9XG5cdH1cblxuXHRjb25zdCBlZGl0cyA9IHJlc29sdmVkQWN0aW9uLmVkaXQgPyBhd2FpdCBkZXBlbmRlbmNpZXMuYXBwbHlXb3Jrc3BhY2VFZGl0KHJlc29sdmVkQWN0aW9uLmVkaXQpIDogW107XG5cdGNvbnN0IGV4ZWN1dGVkQ29tbWFuZHM6IHN0cmluZ1tdID0gW107XG5cdGlmIChyZXNvbHZlZEFjdGlvbi5jb21tYW5kKSB7XG5cdFx0YXdhaXQgZGVwZW5kZW5jaWVzLmV4ZWN1dGVDb21tYW5kKHJlc29sdmVkQWN0aW9uLmNvbW1hbmQpO1xuXHRcdGV4ZWN1dGVkQ29tbWFuZHMucHVzaChyZXNvbHZlZEFjdGlvbi5jb21tYW5kLmNvbW1hbmQpO1xuXHR9XG5cblx0aWYgKGVkaXRzLmxlbmd0aCA9PT0gMCAmJiBleGVjdXRlZENvbW1hbmRzLmxlbmd0aCA9PT0gMCkge1xuXHRcdHJldHVybiBudWxsO1xuXHR9XG5cblx0cmV0dXJuIHsgdGl0bGU6IHJlc29sdmVkQWN0aW9uLnRpdGxlLCBlZGl0cywgZXhlY3V0ZWRDb21tYW5kcyB9O1xufVxuXG5jb25zdCBHTE9CX1BBVFRFUk5fQ0hBUlMgPSAvWyo/W3tdLztcblxuZXhwb3J0IGZ1bmN0aW9uIGhhc0dsb2JQYXR0ZXJuKHZhbHVlOiBzdHJpbmcpOiBib29sZWFuIHtcblx0cmV0dXJuIEdMT0JfUEFUVEVSTl9DSEFSUy50ZXN0KHZhbHVlKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNvbGxlY3RHbG9iTWF0Y2hlcyhcblx0cGF0dGVybjogc3RyaW5nLFxuXHRjd2Q6IHN0cmluZyxcblx0bWF4TWF0Y2hlczogbnVtYmVyLFxuKTogUHJvbWlzZTx7IG1hdGNoZXM6IHN0cmluZ1tdOyB0cnVuY2F0ZWQ6IGJvb2xlYW4gfT4ge1xuXHRjb25zdCBub3JtYWxpemVkTGltaXQgPSBOdW1iZXIuaXNGaW5pdGUobWF4TWF0Y2hlcykgPyBNYXRoLm1heCgxLCBNYXRoLnRydW5jKG1heE1hdGNoZXMpKSA6IDE7XG5cdGNvbnN0IGFsbE1hdGNoZXMgPSBhd2FpdCBnbG9iKHBhdHRlcm4sIHsgY3dkIH0pO1xuXHRpZiAoYWxsTWF0Y2hlcy5sZW5ndGggPiBub3JtYWxpemVkTGltaXQpIHtcblx0XHRyZXR1cm4geyBtYXRjaGVzOiBhbGxNYXRjaGVzLnNsaWNlKDAsIG5vcm1hbGl6ZWRMaW1pdCksIHRydW5jYXRlZDogdHJ1ZSB9O1xuXHR9XG5cdHJldHVybiB7IG1hdGNoZXM6IGFsbE1hdGNoZXMsIHRydW5jYXRlZDogZmFsc2UgfTtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIEhvdmVyIENvbnRlbnQgRXh0cmFjdGlvblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuZXhwb3J0IGZ1bmN0aW9uIGV4dHJhY3RIb3ZlclRleHQoXG5cdGNvbnRlbnRzOiBzdHJpbmcgfCB7IGtpbmQ6IHN0cmluZzsgdmFsdWU6IHN0cmluZyB9IHwgeyBsYW5ndWFnZTogc3RyaW5nOyB2YWx1ZTogc3RyaW5nIH0gfCB1bmtub3duW10sXG4pOiBzdHJpbmcge1xuXHRpZiAodHlwZW9mIGNvbnRlbnRzID09PSBcInN0cmluZ1wiKSB7XG5cdFx0cmV0dXJuIGNvbnRlbnRzO1xuXHR9XG5cblx0aWYgKEFycmF5LmlzQXJyYXkoY29udGVudHMpKSB7XG5cdFx0cmV0dXJuIGNvbnRlbnRzLm1hcChjID0+IGV4dHJhY3RIb3ZlclRleHQoYyBhcyBzdHJpbmcgfCB7IGtpbmQ6IHN0cmluZzsgdmFsdWU6IHN0cmluZyB9KSkuam9pbihcIlxcblxcblwiKTtcblx0fVxuXG5cdGlmICh0eXBlb2YgY29udGVudHMgPT09IFwib2JqZWN0XCIgJiYgY29udGVudHMgIT09IG51bGwpIHtcblx0XHRpZiAoXCJ2YWx1ZVwiIGluIGNvbnRlbnRzICYmIHR5cGVvZiBjb250ZW50cy52YWx1ZSA9PT0gXCJzdHJpbmdcIikge1xuXHRcdFx0cmV0dXJuIGNvbnRlbnRzLnZhbHVlO1xuXHRcdH1cblx0fVxuXG5cdHJldHVybiBTdHJpbmcoY29udGVudHMpO1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gR2VuZXJhbCBVdGlsaXRpZXNcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmZ1bmN0aW9uIGZpcnN0Tm9uV2hpdGVzcGFjZUNvbHVtbihsaW5lVGV4dDogc3RyaW5nKTogbnVtYmVyIHtcblx0Y29uc3QgbWF0Y2ggPSBsaW5lVGV4dC5tYXRjaCgvXFxTLyk7XG5cdHJldHVybiBtYXRjaCA/IChtYXRjaC5pbmRleCA/PyAwKSA6IDA7XG59XG5cbmZ1bmN0aW9uIGZpbmRTeW1ib2xNYXRjaEluZGV4ZXMobGluZVRleHQ6IHN0cmluZywgc3ltYm9sOiBzdHJpbmcsIGNhc2VJbnNlbnNpdGl2ZSA9IGZhbHNlKTogbnVtYmVyW10ge1xuXHRpZiAoc3ltYm9sLmxlbmd0aCA9PT0gMCkgcmV0dXJuIFtdO1xuXHRjb25zdCBoYXlzdGFjayA9IGNhc2VJbnNlbnNpdGl2ZSA/IGxpbmVUZXh0LnRvTG93ZXJDYXNlKCkgOiBsaW5lVGV4dDtcblx0Y29uc3QgbmVlZGxlID0gY2FzZUluc2Vuc2l0aXZlID8gc3ltYm9sLnRvTG93ZXJDYXNlKCkgOiBzeW1ib2w7XG5cdGNvbnN0IGluZGV4ZXM6IG51bWJlcltdID0gW107XG5cdGxldCBmcm9tSW5kZXggPSAwO1xuXHR3aGlsZSAoZnJvbUluZGV4IDw9IGhheXN0YWNrLmxlbmd0aCAtIG5lZWRsZS5sZW5ndGgpIHtcblx0XHRjb25zdCBtYXRjaEluZGV4ID0gaGF5c3RhY2suaW5kZXhPZihuZWVkbGUsIGZyb21JbmRleCk7XG5cdFx0aWYgKG1hdGNoSW5kZXggPT09IC0xKSBicmVhaztcblx0XHRpbmRleGVzLnB1c2gobWF0Y2hJbmRleCk7XG5cdFx0ZnJvbUluZGV4ID0gbWF0Y2hJbmRleCArIG5lZWRsZS5sZW5ndGg7XG5cdH1cblx0cmV0dXJuIGluZGV4ZXM7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZU9jY3VycmVuY2Uob2NjdXJyZW5jZT86IG51bWJlcik6IG51bWJlciB7XG5cdGlmIChvY2N1cnJlbmNlID09PSB1bmRlZmluZWQgfHwgIU51bWJlci5pc0Zpbml0ZShvY2N1cnJlbmNlKSkgcmV0dXJuIDE7XG5cdHJldHVybiBNYXRoLm1heCgxLCBNYXRoLnRydW5jKG9jY3VycmVuY2UpKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlc29sdmVTeW1ib2xDb2x1bW4oXG5cdGZpbGVQYXRoOiBzdHJpbmcsXG5cdGxpbmU6IG51bWJlcixcblx0c3ltYm9sPzogc3RyaW5nLFxuXHRvY2N1cnJlbmNlPzogbnVtYmVyLFxuKTogUHJvbWlzZTxudW1iZXI+IHtcblx0Y29uc3QgbGluZU51bWJlciA9IE1hdGgubWF4KDEsIGxpbmUpO1xuXHRjb25zdCBtYXRjaE9jY3VycmVuY2UgPSBub3JtYWxpemVPY2N1cnJlbmNlKG9jY3VycmVuY2UpO1xuXHR0cnkge1xuXHRcdGNvbnN0IGZpbGVUZXh0ID0gYXdhaXQgZnNQcm9taXNlcy5yZWFkRmlsZShmaWxlUGF0aCwgXCJ1dGYtOFwiKTtcblx0XHRjb25zdCBsaW5lcyA9IGZpbGVUZXh0LnNwbGl0KFwiXFxuXCIpO1xuXHRcdGNvbnN0IHRhcmdldExpbmUgPSBsaW5lc1tsaW5lTnVtYmVyIC0gMV0gPz8gXCJcIjtcblx0XHRpZiAoIXN5bWJvbCkge1xuXHRcdFx0cmV0dXJuIGZpcnN0Tm9uV2hpdGVzcGFjZUNvbHVtbih0YXJnZXRMaW5lKTtcblx0XHR9XG5cblx0XHRjb25zdCBleGFjdEluZGV4ZXMgPSBmaW5kU3ltYm9sTWF0Y2hJbmRleGVzKHRhcmdldExpbmUsIHN5bWJvbCk7XG5cdFx0Y29uc3QgZmFsbGJhY2tJbmRleGVzID0gZXhhY3RJbmRleGVzLmxlbmd0aCA+IDAgPyBleGFjdEluZGV4ZXMgOiBmaW5kU3ltYm9sTWF0Y2hJbmRleGVzKHRhcmdldExpbmUsIHN5bWJvbCwgdHJ1ZSk7XG5cdFx0aWYgKGZhbGxiYWNrSW5kZXhlcy5sZW5ndGggPT09IDApIHtcblx0XHRcdHRocm93IG5ldyBFcnJvcihgU3ltYm9sIFwiJHtzeW1ib2x9XCIgbm90IGZvdW5kIG9uIGxpbmUgJHtsaW5lTnVtYmVyfWApO1xuXHRcdH1cblx0XHRpZiAobWF0Y2hPY2N1cnJlbmNlID4gZmFsbGJhY2tJbmRleGVzLmxlbmd0aCkge1xuXHRcdFx0dGhyb3cgbmV3IEVycm9yKFxuXHRcdFx0XHRgU3ltYm9sIFwiJHtzeW1ib2x9XCIgb2NjdXJyZW5jZSAke21hdGNoT2NjdXJyZW5jZX0gaXMgb3V0IG9mIGJvdW5kcyBvbiBsaW5lICR7bGluZU51bWJlcn0gKGZvdW5kICR7ZmFsbGJhY2tJbmRleGVzLmxlbmd0aH0pYCxcblx0XHRcdCk7XG5cdFx0fVxuXHRcdHJldHVybiBmYWxsYmFja0luZGV4ZXNbbWF0Y2hPY2N1cnJlbmNlIC0gMV07XG5cdH0gY2F0Y2ggKGVycm9yOiB1bmtub3duKSB7XG5cdFx0aWYgKGlzRW5vZW50KGVycm9yKSkge1xuXHRcdFx0dGhyb3cgbmV3IEVycm9yKGBGaWxlIG5vdCBmb3VuZDogJHtmaWxlUGF0aH1gKTtcblx0XHR9XG5cdFx0dGhyb3cgZXJyb3I7XG5cdH1cbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlYWRMb2NhdGlvbkNvbnRleHQoZmlsZVBhdGg6IHN0cmluZywgbGluZTogbnVtYmVyLCBjb250ZXh0TGluZXMgPSAxKTogUHJvbWlzZTxzdHJpbmdbXT4ge1xuXHRjb25zdCB0YXJnZXRMaW5lID0gTWF0aC5tYXgoMSwgbGluZSk7XG5cdGNvbnN0IHN1cnJvdW5kaW5nID0gTWF0aC5tYXgoMCwgY29udGV4dExpbmVzKTtcblx0dHJ5IHtcblx0XHRjb25zdCBmaWxlVGV4dCA9IGF3YWl0IGZzUHJvbWlzZXMucmVhZEZpbGUoZmlsZVBhdGgsIFwidXRmLThcIik7XG5cdFx0Y29uc3QgbGluZXMgPSBmaWxlVGV4dC5zcGxpdChcIlxcblwiKTtcblx0XHRpZiAobGluZXMubGVuZ3RoID09PSAwKSByZXR1cm4gW107XG5cblx0XHRjb25zdCBzdGFydExpbmUgPSBNYXRoLm1heCgxLCB0YXJnZXRMaW5lIC0gc3Vycm91bmRpbmcpO1xuXHRcdGNvbnN0IGVuZExpbmUgPSBNYXRoLm1pbihsaW5lcy5sZW5ndGgsIHRhcmdldExpbmUgKyBzdXJyb3VuZGluZyk7XG5cdFx0Y29uc3QgY29udGV4dDogc3RyaW5nW10gPSBbXTtcblx0XHRmb3IgKGxldCBjdXJyZW50TGluZSA9IHN0YXJ0TGluZTsgY3VycmVudExpbmUgPD0gZW5kTGluZTsgY3VycmVudExpbmUrKykge1xuXHRcdFx0Y29uc3QgY29udGVudCA9IGxpbmVzW2N1cnJlbnRMaW5lIC0gMV0gPz8gXCJcIjtcblx0XHRcdGNvbnRleHQucHVzaChgJHtjdXJyZW50TGluZX06ICR7Y29udGVudH1gKTtcblx0XHR9XG5cdFx0cmV0dXJuIGNvbnRleHQ7XG5cdH0gY2F0Y2ggKGVycm9yOiB1bmtub3duKSB7XG5cdFx0aWYgKGlzRW5vZW50KGVycm9yKSkge1xuXHRcdFx0cmV0dXJuIFtdO1xuXHRcdH1cblx0XHR0aHJvdyBlcnJvcjtcblx0fVxufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gQ2FsbCBIaWVyYXJjaHkgRm9ybWF0dGluZ1xuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdENhbGxIaWVyYXJjaHlJdGVtKGl0ZW06IENhbGxIaWVyYXJjaHlJdGVtLCBjd2Q6IHN0cmluZyk6IHN0cmluZyB7XG5cdGNvbnN0IGljb24gPSBzeW1ib2xLaW5kVG9JY29uKGl0ZW0ua2luZCk7XG5cdGNvbnN0IGRldGFpbCA9IGl0ZW0uZGV0YWlsID8gYCAke2l0ZW0uZGV0YWlsfWAgOiBcIlwiO1xuXHRjb25zdCByZWxQYXRoID0gcGF0aC5yZWxhdGl2ZShjd2QsIHVyaVRvRmlsZShpdGVtLnVyaSkpO1xuXHRjb25zdCBsaW5lID0gaXRlbS5zZWxlY3Rpb25SYW5nZS5zdGFydC5saW5lICsgMTtcblx0cmV0dXJuIGAke2ljb259ICR7aXRlbS5uYW1lfSR7ZGV0YWlsfSBAICR7cmVsUGF0aH06JHtsaW5lfWA7XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBTaWduYXR1cmUgSGVscCBGb3JtYXR0aW5nXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5mdW5jdGlvbiBleHRyYWN0RG9jVGV4dChkb2M6IHN0cmluZyB8IE1hcmt1cENvbnRlbnQgfCB1bmRlZmluZWQpOiBzdHJpbmcge1xuXHRpZiAoIWRvYykgcmV0dXJuIFwiXCI7XG5cdGlmICh0eXBlb2YgZG9jID09PSBcInN0cmluZ1wiKSByZXR1cm4gZG9jO1xuXHRyZXR1cm4gZG9jLnZhbHVlO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0U2lnbmF0dXJlSGVscChyZXN1bHQ6IFNpZ25hdHVyZUhlbHApOiBzdHJpbmcge1xuXHRpZiAoIXJlc3VsdC5zaWduYXR1cmVzIHx8IHJlc3VsdC5zaWduYXR1cmVzLmxlbmd0aCA9PT0gMCkge1xuXHRcdHJldHVybiBcIk5vIHNpZ25hdHVyZSBpbmZvcm1hdGlvblwiO1xuXHR9XG5cblx0Y29uc3QgYWN0aXZlSWR4ID0gcmVzdWx0LmFjdGl2ZVNpZ25hdHVyZSA/PyAwO1xuXHRjb25zdCBzaWcgPSByZXN1bHQuc2lnbmF0dXJlc1thY3RpdmVJZHhdID8/IHJlc3VsdC5zaWduYXR1cmVzWzBdO1xuXHRjb25zdCBhY3RpdmVQYXJhbSA9IHJlc3VsdC5hY3RpdmVQYXJhbWV0ZXIgPz8gc2lnLmFjdGl2ZVBhcmFtZXRlcjtcblxuXHRjb25zdCBsaW5lczogc3RyaW5nW10gPSBbc2lnLmxhYmVsXTtcblxuXHRjb25zdCBzaWdEb2MgPSBleHRyYWN0RG9jVGV4dChzaWcuZG9jdW1lbnRhdGlvbik7XG5cdGlmIChzaWdEb2MpIHtcblx0XHRsaW5lcy5wdXNoKFwiXCIsIHNpZ0RvYyk7XG5cdH1cblxuXHRpZiAoc2lnLnBhcmFtZXRlcnMgJiYgc2lnLnBhcmFtZXRlcnMubGVuZ3RoID4gMCkge1xuXHRcdGxpbmVzLnB1c2goXCJcIiwgXCJQYXJhbWV0ZXJzOlwiKTtcblx0XHRmb3IgKGxldCBpID0gMDsgaSA8IHNpZy5wYXJhbWV0ZXJzLmxlbmd0aDsgaSsrKSB7XG5cdFx0XHRjb25zdCBwID0gc2lnLnBhcmFtZXRlcnNbaV07XG5cdFx0XHRjb25zdCBsYWJlbCA9IHR5cGVvZiBwLmxhYmVsID09PSBcInN0cmluZ1wiID8gcC5sYWJlbCA6IHNpZy5sYWJlbC5zbGljZShwLmxhYmVsWzBdLCBwLmxhYmVsWzFdKTtcblx0XHRcdGNvbnN0IGFjdGl2ZSA9IGkgPT09IGFjdGl2ZVBhcmFtID8gXCIgPC0tIGFjdGl2ZVwiIDogXCJcIjtcblx0XHRcdGNvbnN0IGRvYyA9IGV4dHJhY3REb2NUZXh0KHAuZG9jdW1lbnRhdGlvbik7XG5cdFx0XHRjb25zdCBkb2NTdWZmaXggPSBkb2MgPyBgIFx1MjAxNCAke2RvY31gIDogXCJcIjtcblx0XHRcdGxpbmVzLnB1c2goYCAgJHtsYWJlbH0ke2RvY1N1ZmZpeH0ke2FjdGl2ZX1gKTtcblx0XHR9XG5cdH1cblxuXHRyZXR1cm4gbGluZXMuam9pbihcIlxcblwiKTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFlBQVksZ0JBQWdCO0FBQzVCLE9BQU8sVUFBVTtBQUNqQixTQUFTLFlBQVk7QUFDckIsU0FBUyxnQkFBZ0I7QUFxQnpCLE1BQU0sZUFBdUM7QUFBQTtBQUFBLEVBRTVDLE9BQU87QUFBQSxFQUNQLFFBQVE7QUFBQSxFQUNSLE9BQU87QUFBQSxFQUNQLFFBQVE7QUFBQSxFQUNSLFFBQVE7QUFBQSxFQUNSLFFBQVE7QUFBQSxFQUNSLFFBQVE7QUFBQSxFQUNSLFFBQVE7QUFBQTtBQUFBLEVBR1IsT0FBTztBQUFBLEVBQ1AsT0FBTztBQUFBLEVBQ1AsTUFBTTtBQUFBLEVBQ04sTUFBTTtBQUFBLEVBQ04sUUFBUTtBQUFBLEVBQ1IsT0FBTztBQUFBLEVBQ1AsUUFBUTtBQUFBLEVBQ1IsUUFBUTtBQUFBLEVBQ1IsUUFBUTtBQUFBLEVBQ1IsUUFBUTtBQUFBO0FBQUEsRUFHUixPQUFPO0FBQUEsRUFDUCxPQUFPO0FBQUEsRUFDUCxRQUFRO0FBQUEsRUFDUixPQUFPO0FBQUEsRUFDUCxTQUFTO0FBQUEsRUFDVCxRQUFRO0FBQUEsRUFDUixTQUFTO0FBQUEsRUFDVCxPQUFPO0FBQUEsRUFDUCxRQUFRO0FBQUE7QUFBQSxFQUdSLFNBQVM7QUFBQSxFQUNULE9BQU87QUFBQSxFQUNQLFFBQVE7QUFBQSxFQUNSLFVBQVU7QUFBQSxFQUNWLFdBQVc7QUFBQSxFQUNYLFFBQVE7QUFBQTtBQUFBLEVBR1IsT0FBTztBQUFBLEVBQ1AsT0FBTztBQUFBLEVBQ1AsT0FBTztBQUFBO0FBQUEsRUFHUCxTQUFTO0FBQUEsRUFDVCxRQUFRO0FBQUEsRUFDUixRQUFRO0FB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
