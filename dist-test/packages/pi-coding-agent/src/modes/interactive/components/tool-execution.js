import {
  Box,
  Container,
  getCapabilities,
  Image,
  imageFallback,
  Spacer,
  style,
  Text,
  truncateToWidth,
  visibleWidth
} from "@gsd/pi-tui";
import stripAnsi from "strip-ansi";
import { computeEditDiff } from "../../../core/tools/edit-diff.js";
import { allTools } from "../../../core/tools/index.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "../../../core/tools/truncate.js";
import { convertToPng } from "../../../utils/image-convert.js";
import { sanitizeBinaryOutput } from "../../../utils/shell.js";
import { getLanguageFromPath, highlightCode, theme } from "../theme/theme.js";
import { shortenPath } from "../utils/shorten-path.js";
import { renderDiff } from "./diff.js";
import { keyHint } from "./keybinding-hints.js";
import { renderCommandCard, renderToolLineCard, renderTranscriptCard } from "./transcript-design.js";
import { truncateToVisualLines } from "./visual-truncate.js";
const BASH_PREVIEW_LINES = 5;
const WRITE_PARTIAL_FULL_HIGHLIGHT_LINES = 50;
function replaceTabs(text) {
  return text.replace(/\t/g, "    ");
}
function normalizeDisplayText(text) {
  return text.replace(/\r/g, "");
}
function str(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return null;
}
function parseMcpToolName(name) {
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice("mcp__".length);
  const delim = rest.indexOf("__");
  if (delim <= 0 || delim === rest.length - 2) return null;
  return { server: rest.slice(0, delim), tool: rest.slice(delim + 2) };
}
function prettifyToolName(name, label) {
  if (label && label.trim().length > 0) return label;
  const stripped = name.replace(/^gsd_/, "");
  if (stripped.length === 0) return name;
  return stripped.split("_").map((word) => word.length === 0 ? word : word[0].toUpperCase() + word.slice(1)).join(" ");
}
const COMPACT_ARG_VALUE_LIMIT = 60;
const GENERIC_OUTPUT_PREVIEW_LINES = 10;
const GENERIC_ARGS_JSON_PREVIEW_LINES = 10;
function formatElapsed(ms) {
  if (ms < 1e3) return `${ms}ms`;
  return `${Math.max(1, Math.round(ms / 1e3))}s`;
}
function formatCommandPreview(command) {
  return truncateToWidth(command.replace(/\s+/g, " ").trim(), 64, "");
}
function appendLineOrRange(displayPath, target) {
  if (!displayPath) return void 0;
  if (typeof target.line === "number" && Number.isFinite(target.line)) {
    return `${displayPath}:${target.line}`;
  }
  const start = target.range?.start;
  if (typeof start === "number" && Number.isFinite(start)) {
    const end = target.range?.end;
    const suffix = typeof end === "number" && Number.isFinite(end) && end !== start ? `${start}-${end}` : `${start}`;
    return `${displayPath}:${suffix}`;
  }
  return displayPath;
}
function formatToolTarget(target) {
  const path = target.resolvedPath || target.inputPath;
  const displayPath = path ? shortenPath(path) : void 0;
  if (target.kind === "search") {
    const searchTarget = displayPath ?? target.inputPath ?? ".";
    const label = target.pattern ? `${target.pattern} in ${searchTarget}` : searchTarget;
    return target.glob ? `${label} (${target.glob})` : label;
  }
  return appendLineOrRange(displayPath, target);
}
function directDetailsTarget(details, action) {
  if (!details || typeof details !== "object") return void 0;
  const record = details;
  const rawPath = record.resolvedPath ?? record.inputPath ?? record.file_path ?? record.path;
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) return void 0;
  const target = {
    kind: "file",
    action,
    resolvedPath: typeof record.resolvedPath === "string" ? record.resolvedPath : rawPath,
    inputPath: typeof record.inputPath === "string" ? record.inputPath : rawPath
  };
  if (typeof record.line === "number") {
    target.line = record.line;
  }
  const range = record.range;
  if (range && typeof range === "object") {
    const rangeRecord = range;
    target.range = {
      start: typeof rangeRecord.start === "number" ? rangeRecord.start : void 0,
      end: typeof rangeRecord.end === "number" ? rangeRecord.end : void 0
    };
  }
  return target;
}
function firstStringArg(args, keys) {
  for (const key of keys) {
    const value = str(args[key]);
    if (value === null) continue;
    if (value) return value;
  }
  return "";
}
function formatArgsPathTarget(path, args) {
  if (!path) return void 0;
  const start = typeof args.offset === "number" ? args.offset : void 0;
  const limit = typeof args.limit === "number" ? args.limit : void 0;
  const range = start !== void 0 || limit !== void 0 ? {
    start: start ?? 1,
    end: limit !== void 0 ? (start ?? 1) + Math.max(0, limit - 1) : void 0
  } : void 0;
  return appendLineOrRange(shortenPath(path), { range });
}
function stripLineSuffix(target) {
  return target.replace(/:\d+(?:-\d+)?$/, "");
}
function uniqueTargets(targets) {
  const seen = /* @__PURE__ */ new Set();
  const unique = [];
  for (const target of targets ?? []) {
    if (!target || seen.has(target)) continue;
    seen.add(target);
    unique.push(target);
  }
  return unique;
}
function summarizePhaseLabel(phase) {
  const phaseTargets = uniqueTargets(phase.targets);
  const baseTargets = uniqueTargets(phaseTargets.map(stripLineSuffix));
  if (phase.label === "File changes" && baseTargets.length > 0) {
    const fileWord = baseTargets.length === 1 ? "file" : "files";
    const actionWord = phase.actionLabel === "write" ? phase.count === 1 ? "write" : "writes" : phase.actionLabel === void 0 ? phase.count === 1 ? "action" : "actions" : phase.count === 1 ? "edit" : "edits";
    return `${phase.label} \xB7 ${baseTargets.length} ${fileWord}, ${phase.count} ${actionWord}`;
  }
  if (phase.label === "Context reads" && baseTargets.length > 0) {
    const fileWord = baseTargets.length === 1 ? "file" : "files";
    return `${phase.label} \xB7 ${baseTargets.length} ${fileWord}`;
  }
  if (phase.label === "Setup / shell" && phaseTargets.length > 0) {
    return `${phase.label} \xB7 ${phase.count} ${phase.count === 1 ? "command" : "commands"}`;
  }
  return `${phase.label} ${phase.count} ${phase.count === 1 ? "action" : "actions"}`;
}
function summarizePhaseTargets(phase, width) {
  const phaseTargets = uniqueTargets(phase.targets);
  if (phaseTargets.length === 0) return void 0;
  const shown = phaseTargets.slice(0, 3);
  const suffix = phaseTargets.length > shown.length ? ` +${phaseTargets.length - shown.length} more` : "";
  return truncateToWidth(shown.join(" \xB7 ") + suffix, width, "");
}
function formatCompactArgs(args, expanded) {
  if (args == null) return "";
  if (typeof args !== "object") return String(args);
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  const allPrimitive = entries.every(([, value]) => {
    const t = typeof value;
    return t === "number" || t === "boolean" || t === "string" || value == null;
  });
  if (allPrimitive) {
    return entries.map(([key, value]) => {
      if (typeof value === "string") {
        const truncated = !expanded && value.length > COMPACT_ARG_VALUE_LIMIT ? `${value.slice(0, COMPACT_ARG_VALUE_LIMIT - 1)}\u2026` : value;
        return `${key}=${JSON.stringify(truncated)}`;
      }
      if (value == null) return `${key}=null`;
      return `${key}=${String(value)}`;
    }).join(", ");
  }
  const lines = JSON.stringify(args, null, 2).split("\n");
  const maxLines = expanded ? lines.length : GENERIC_ARGS_JSON_PREVIEW_LINES;
  if (lines.length <= maxLines) return lines.join("\n");
  return lines.slice(0, maxLines).join("\n") + "\n...";
}
class ToolExecutionComponent extends Container {
  constructor(toolName, args, options = {}, toolDefinition, ui, cwd = process.cwd()) {
    super();
    // For built-in tools (with its own padding/bg)
    this.imageComponents = [];
    this.imageSpacers = [];
    this.expanded = false;
    this.isPartial = true;
    this.startedAt = Date.now();
    // Track which args the preview is for
    // Cached converted images for Kitty protocol (which requires PNG), keyed by index
    this.convertedImages = /* @__PURE__ */ new Map();
    // Cached resolved image dimensions to avoid re-triggering async parsing
    // when updateDisplay() recreates Image components (#3455).
    this.resolvedImageDimensions = /* @__PURE__ */ new Map();
    // When true, this component intentionally renders no lines
    this.hideComponent = false;
    this.toolName = toolName;
    this.args = args;
    this.showImages = options.showImages ?? true;
    this.toolDefinition = toolDefinition;
    this.ui = ui;
    this.cwd = cwd;
    this.addChild(new Spacer(1));
    this.contentBox = new Box(1, 1, (text) => theme.bg("toolPendingBg", text));
    this.contentText = new Text("", 1, 1, (text) => theme.bg("toolPendingBg", text));
    if (this.normalizedToolName === "bash" || toolDefinition && !this.shouldUseBuiltInRenderer()) {
      this.addChild(this.contentBox);
    } else {
      this.addChild(this.contentText);
    }
    this.updateDisplay();
  }
  get normalizedToolName() {
    return typeof this.toolName === "string" ? this.toolName.toLowerCase() : "";
  }
  /**
   * Check if we should use built-in rendering for this tool.
   * Returns true if the tool name is a built-in AND either there's no toolDefinition
   * or the toolDefinition doesn't provide custom renderers.
   */
  shouldUseBuiltInRenderer() {
    const normalizedToolName = this.normalizedToolName;
    const isBuiltInName = normalizedToolName in allTools;
    const hasCustomRenderers = this.toolDefinition?.renderCall || this.toolDefinition?.renderResult;
    return isBuiltInName && !hasCustomRenderers;
  }
  dispose() {
    this.convertedImages.clear();
    this.imageComponents = [];
    this.imageSpacers = [];
    this.editDiffPreview = void 0;
    this.writeHighlightCache = void 0;
    this.result = void 0;
  }
  updateArgs(args) {
    this.args = args;
    if (this.normalizedToolName === "write" && this.isPartial) {
      this.updateWriteHighlightCacheIncremental();
    }
    this.updateDisplay();
  }
  highlightSingleLine(line, lang) {
    const highlighted = highlightCode(line, lang);
    return highlighted[0] ?? "";
  }
  refreshWriteHighlightPrefix(cache) {
    const prefixCount = Math.min(WRITE_PARTIAL_FULL_HIGHLIGHT_LINES, cache.normalizedLines.length);
    if (prefixCount === 0) return;
    const prefixSource = cache.normalizedLines.slice(0, prefixCount).join("\n");
    const prefixHighlighted = highlightCode(prefixSource, cache.lang);
    for (let i = 0; i < prefixCount; i++) {
      cache.highlightedLines[i] = prefixHighlighted[i] ?? this.highlightSingleLine(cache.normalizedLines[i] ?? "", cache.lang);
    }
  }
  rebuildWriteHighlightCacheFull(rawPath, fileContent) {
    const lang = rawPath ? getLanguageFromPath(rawPath) : void 0;
    if (!lang) {
      this.writeHighlightCache = void 0;
      return;
    }
    const displayContent = normalizeDisplayText(fileContent);
    const normalized = replaceTabs(displayContent);
    this.writeHighlightCache = {
      rawPath,
      lang,
      rawContent: fileContent,
      normalizedLines: normalized.split("\n"),
      highlightedLines: highlightCode(normalized, lang)
    };
  }
  updateWriteHighlightCacheIncremental() {
    const rawPath = str(this.args?.file_path ?? this.args?.path);
    const fileContent = str(this.args?.content);
    if (rawPath === null || fileContent === null) {
      this.writeHighlightCache = void 0;
      return;
    }
    const lang = rawPath ? getLanguageFromPath(rawPath) : void 0;
    if (!lang) {
      this.writeHighlightCache = void 0;
      return;
    }
    if (!this.writeHighlightCache) {
      this.rebuildWriteHighlightCacheFull(rawPath, fileContent);
      return;
    }
    const cache = this.writeHighlightCache;
    if (cache.lang !== lang || cache.rawPath !== rawPath) {
      this.rebuildWriteHighlightCacheFull(rawPath, fileContent);
      return;
    }
    if (!fileContent.startsWith(cache.rawContent)) {
      this.rebuildWriteHighlightCacheFull(rawPath, fileContent);
      return;
    }
    if (fileContent.length === cache.rawContent.length) {
      return;
    }
    const deltaRaw = fileContent.slice(cache.rawContent.length);
    const deltaDisplay = normalizeDisplayText(deltaRaw);
    const deltaNormalized = replaceTabs(deltaDisplay);
    cache.rawContent = fileContent;
    if (cache.normalizedLines.length === 0) {
      cache.normalizedLines.push("");
      cache.highlightedLines.push("");
    }
    const segments = deltaNormalized.split("\n");
    const lastIndex = cache.normalizedLines.length - 1;
    cache.normalizedLines[lastIndex] += segments[0];
    cache.highlightedLines[lastIndex] = this.highlightSingleLine(cache.normalizedLines[lastIndex], cache.lang);
    for (let i = 1; i < segments.length; i++) {
      cache.normalizedLines.push(segments[i]);
      cache.highlightedLines.push(this.highlightSingleLine(segments[i], cache.lang));
    }
    this.refreshWriteHighlightPrefix(cache);
  }
  /**
   * Signal that args are complete (tool is about to execute).
   * This triggers diff computation for edit tool.
   */
  setArgsComplete() {
    if (this.toolName === "write") {
      const rawPath = str(this.args?.file_path ?? this.args?.path);
      const fileContent = str(this.args?.content);
      if (rawPath !== null && fileContent !== null) {
        this.rebuildWriteHighlightCacheFull(rawPath, fileContent);
      }
    }
    this.maybeComputeEditDiff();
  }
  /**
   * Compute edit diff preview when we have complete args.
   * This runs async and updates display when done.
   */
  maybeComputeEditDiff() {
    if (this.toolName !== "edit") return;
    const path = this.args?.path;
    const oldText = this.args?.oldText;
    const newText = this.args?.newText;
    if (!path || oldText === void 0 || newText === void 0) return;
    const argsKey = JSON.stringify({ path, oldText, newText });
    if (this.editDiffArgsKey === argsKey) return;
    this.editDiffArgsKey = argsKey;
    computeEditDiff(path, oldText, newText, this.cwd).then((result) => {
      if (this.editDiffArgsKey === argsKey) {
        this.editDiffPreview = result;
        this.updateDisplay();
        this.ui.requestRender();
      }
    });
  }
  updateResult(result, isPartial = false) {
    this.result = result;
    this.isPartial = isPartial;
    if (!isPartial) {
      this.endedAt = this.endedAt ?? Date.now();
    }
    if (this.normalizedToolName === "write" && !isPartial) {
      const rawPath = str(this.args?.file_path ?? this.args?.path);
      const fileContent = str(this.args?.content);
      if (rawPath !== null && fileContent !== null) {
        this.rebuildWriteHighlightCacheFull(rawPath, fileContent);
      }
    }
    this.updateDisplay();
    this.maybeConvertImagesForKitty();
  }
  /**
   * Mark a tool call as historical when replaying from session context and
   * no matching tool result is available. Happens after compaction squashes
   * tool_result messages out of history — the tool call block survives but
   * the result is gone. Without this, the component stays in "Running" state
   * forever even though the tool completed long ago.
   */
  markHistoricalNoResult() {
    if (this.result) return;
    this.isPartial = false;
    this.endedAt = this.endedAt ?? Date.now();
    this.result = {
      content: [],
      isError: false
    };
    this.updateDisplay();
  }
  /**
   * Finalize a pending tool call as failed/interrupted while preserving any streamed partial output.
   */
  completeWithError(message) {
    this.isPartial = false;
    this.endedAt = this.endedAt ?? Date.now();
    if (this.result) {
      let content = this.result.content;
      if (message) {
        const alreadyHasMessage = content.some((block) => block.type === "text" && block.text === message);
        if (!alreadyHasMessage) {
          content = [...content, { type: "text", text: message }];
        }
      }
      this.result = { ...this.result, content, isError: true };
    } else {
      this.result = {
        content: message ? [{ type: "text", text: message }] : [],
        isError: true
      };
    }
    this.updateDisplay();
  }
  /**
   * Convert non-PNG images to PNG for Kitty graphics protocol.
   * Kitty requires PNG format (f=100), so JPEG/GIF/WebP won't display.
   */
  maybeConvertImagesForKitty() {
    const caps = getCapabilities();
    if (caps.images !== "kitty") return;
    if (!this.result) return;
    const imageBlocks = this.result.content?.filter((c) => c.type === "image") || [];
    for (let i = 0; i < imageBlocks.length; i++) {
      const img = imageBlocks[i];
      if (!img.data || !img.mimeType) continue;
      if (img.mimeType === "image/png") continue;
      if (this.convertedImages.has(i)) continue;
      const index = i;
      convertToPng(img.data, img.mimeType).then((converted) => {
        if (converted) {
          this.convertedImages.set(index, converted);
          this.updateDisplay();
          this.ui.requestRender();
        }
      });
    }
  }
  setExpanded(expanded) {
    this.expanded = expanded;
    this.updateDisplay();
  }
  setShowImages(show) {
    this.showImages = show;
    this.updateDisplay();
  }
  invalidate() {
    super.invalidate();
    this.updateDisplay();
  }
  render(width) {
    if (this.hideComponent) {
      return [];
    }
    const frameWidth = Math.max(20, width);
    const contentWidth = Math.max(1, frameWidth - 4);
    const frameTone = this.result?.isError ? "error" : this.isPartial || !this.result ? "pending" : "success";
    const elapsed = formatElapsed((this.endedAt ?? Date.now()) - this.startedAt);
    const statusWord = this.isPartial || !this.result ? "running" : this.result.isError ? "failed" : "success";
    const frameStatus = `${statusWord} \xB7 ${elapsed}`;
    const parsed = parseMcpToolName(this.toolName);
    const frameLabel = parsed ? `${parsed.server}\xB7${parsed.tool}` : prettifyToolName(this.toolName, this.toolDefinition?.label) || "unknown";
    const recommendedTone = frameTone === "pending" ? "running" : frameTone === "error" ? "error" : "success";
    if (this.normalizedToolName === "bash" && !this.expanded && !this.result?.isError) {
      const command = str(this.args?.command);
      return [
        "",
        ...renderCommandCard(command && command.length > 0 ? formatCommandPreview(command) : frameLabel, frameWidth, {
          status: frameStatus,
          tone: recommendedTone
        })
      ];
    }
    const hasImages = this.result?.content?.some((block) => block.type === "image") ?? false;
    if (!this.expanded && !this.result?.isError && !hasImages) {
      const compactTarget = this.getCompactTarget();
      return [
        "",
        ...renderToolLineCard(frameLabel, compactTarget, frameWidth, {
          status: frameStatus,
          tone: recommendedTone,
          hidden: !this.isPartial && !!this.result
        })
      ];
    }
    const lines = super.render(contentWidth);
    const framed = renderTranscriptCard(lines, frameWidth, {
      title: frameLabel,
      right: frameStatus,
      tone: recommendedTone,
      footerLeft: this.expanded ? "output expanded" : void 0,
      footerRight: this.expanded ? "ctrl+o collapse" : void 0
    });
    return framed.length > 0 ? ["", ...framed] : framed;
  }
  shouldRenderCompactSuccess() {
    if (this.expanded || this.isPartial || !this.result || this.result.isError) return false;
    const hasImages = this.result.content?.some((block) => block.type === "image") ?? false;
    return !hasImages;
  }
  getRollupPhase() {
    if (!this.shouldRenderCompactSuccess()) return null;
    const label = this.getPhaseLabel();
    const endedAt = this.endedAt ?? Date.now();
    const target = this.getCompactTarget();
    return {
      label,
      count: 1,
      durationMs: Math.max(0, endedAt - this.startedAt),
      targets: target ? [target] : void 0,
      actionLabel: this.getCompactAction()
    };
  }
  getPhaseLabel() {
    const name = this.normalizedToolName;
    const displayName = prettifyToolName(this.toolName, this.toolDefinition?.label);
    if (name === "bash") return "Setup / shell";
    if (name === "read" || name === "ls" || name === "find" || name === "grep") return "Context reads";
    if (name === "write" || name === "edit") return "File changes";
    if (name === "web_search" || displayName === "ToolSearch") return "Discovery";
    if (displayName === "Memory Query" || displayName === "Memory Capture" || displayName === "Gsd Graph") {
      return "Memory lookups";
    }
    if (displayName === "Update Requirement" || displayName === "Save Requirement") return "Requirement writes";
    if (displayName.startsWith("Complete ")) return "Finalization";
    return "Other tool actions";
  }
  getCompactAction() {
    const target = this.getTargetMetadata();
    if (target?.action) return target.action === "list" ? "ls" : target.action;
    return this.normalizedToolName;
  }
  getTargetMetadata() {
    const target = this.result?.details?.target;
    if (target && typeof target === "object") return target;
    return directDetailsTarget(this.result?.details, this.normalizedToolName);
  }
  getCompactTarget() {
    const metadata = this.getTargetMetadata();
    const metadataTarget = metadata ? formatToolTarget(metadata) : void 0;
    if (metadataTarget) return metadataTarget;
    const path = firstStringArg(this.args ?? {}, ["file_path", "path", "notebook_path"]);
    if (path === null) return void 0;
    if (this.normalizedToolName === "read" || this.normalizedToolName === "hashline_read") {
      return formatArgsPathTarget(path, this.args);
    }
    if (this.normalizedToolName === "write" || this.normalizedToolName === "edit") {
      return path ? shortenPath(path) : void 0;
    }
    if (this.normalizedToolName === "ls") {
      return path ? shortenPath(path) : void 0;
    }
    if (this.normalizedToolName === "find") {
      const pattern = str(this.args?.pattern);
      if (pattern) return path ? `${pattern} in ${shortenPath(path)}` : pattern;
      return path ? shortenPath(path) : void 0;
    }
    if (this.normalizedToolName === "grep") {
      const pattern = str(this.args?.pattern);
      const glob = str(this.args?.glob);
      const label = pattern ? path ? `${pattern} in ${shortenPath(path)}` : pattern : path ? shortenPath(path) : void 0;
      if (!label) return glob || void 0;
      return glob ? `${label} (${glob})` : label;
    }
    return void 0;
  }
  updateDisplay() {
    const bgFn = (text) => text;
    const useBuiltInRenderer = this.shouldUseBuiltInRenderer();
    let customRendererHasContent = false;
    this.hideComponent = false;
    if (useBuiltInRenderer) {
      if (this.normalizedToolName === "bash") {
        this.contentBox.setBgFn(bgFn);
        this.contentBox.clear();
        this.renderBashContent();
      } else {
        this.contentText.setCustomBgFn(bgFn);
        this.contentText.setText(this.formatToolExecution());
      }
    } else if (this.toolDefinition) {
      this.contentBox.setBgFn(bgFn);
      this.contentBox.clear();
      if (this.toolDefinition.renderCall) {
        try {
          const callComponent = this.toolDefinition.renderCall(this.args, theme);
          if (callComponent !== void 0) {
            this.contentBox.addChild(callComponent);
            customRendererHasContent = true;
          }
        } catch {
          this.contentBox.addChild(
            new Text(
              theme.fg(
                "toolTitle",
                theme.bold(prettifyToolName(this.toolName, this.toolDefinition?.label))
              ),
              0,
              0
            )
          );
          customRendererHasContent = true;
        }
      } else {
        this.contentBox.addChild(
          new Text(
            theme.fg(
              "toolTitle",
              theme.bold(prettifyToolName(this.toolName, this.toolDefinition?.label))
            ),
            0,
            0
          )
        );
        customRendererHasContent = true;
      }
      if (this.result && this.toolDefinition.renderResult) {
        try {
          const rendererResult = {
            content: this.result.content,
            details: this.result.details,
            isError: this.result.isError
          };
          const resultComponent = this.toolDefinition.renderResult(
            rendererResult,
            { expanded: this.expanded, isPartial: this.isPartial },
            theme
          );
          if (resultComponent !== void 0) {
            this.contentBox.addChild(resultComponent);
            customRendererHasContent = true;
          }
        } catch {
          const output = this.getTextOutput();
          if (output) {
            this.contentBox.addChild(new Text(theme.fg("toolOutput", output), 0, 0));
            customRendererHasContent = true;
          }
        }
      } else if (this.result) {
        const output = this.getTextOutput();
        if (output) {
          this.contentBox.addChild(new Text(theme.fg("toolOutput", output), 0, 0));
          customRendererHasContent = true;
        }
      }
    } else {
      this.contentText.setCustomBgFn(bgFn);
      this.contentText.setText(this.formatToolExecution());
    }
    for (const img of this.imageComponents) {
      this.removeChild(img);
    }
    this.imageComponents = [];
    for (const spacer of this.imageSpacers) {
      this.removeChild(spacer);
    }
    this.imageSpacers = [];
    if (this.result) {
      const imageBlocks = this.result.content?.filter((c) => c.type === "image") || [];
      const caps = getCapabilities();
      for (let i = 0; i < imageBlocks.length; i++) {
        const img = imageBlocks[i];
        if (caps.images && this.showImages && img.data && img.mimeType) {
          const converted = this.convertedImages.get(i);
          const imageData = converted?.data ?? img.data;
          const imageMimeType = converted?.mimeType ?? img.mimeType;
          if (caps.images === "kitty" && imageMimeType !== "image/png") {
            continue;
          }
          const spacer = new Spacer(1);
          this.addChild(spacer);
          this.imageSpacers.push(spacer);
          const cachedDims = this.resolvedImageDimensions.get(i);
          const imageComponent = new Image(
            imageData,
            imageMimeType,
            { fallbackColor: (s) => theme.fg("toolOutput", s) },
            { maxWidthCells: 60 },
            cachedDims
          );
          if (!cachedDims) {
            const imgIdx = i;
            imageComponent.setOnDimensionsResolved(() => {
              const dims = imageComponent.getDimensions?.();
              if (dims) this.resolvedImageDimensions.set(imgIdx, dims);
              this.ui.requestRender();
            });
          }
          this.imageComponents.push(imageComponent);
          this.addChild(imageComponent);
        }
      }
    }
    if (!useBuiltInRenderer && this.toolDefinition) {
      this.hideComponent = !customRendererHasContent && this.imageComponents.length === 0;
    }
  }
  /**
   * Render bash content using visual line truncation (like bash-execution.ts)
   */
  renderBashContent() {
    const command = str(this.args?.command);
    const timeout = this.args?.timeout;
    const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
    const commandDisplay = command === null ? theme.fg("error", "[invalid arg]") : command ? command : theme.fg("toolOutput", "...");
    this.contentBox.addChild(
      new Text(theme.fg("toolTitle", theme.bold(`$ ${commandDisplay}`)) + timeoutSuffix, 0, 0)
    );
    if (this.result) {
      const output = this.getTextOutput().trim();
      if (output) {
        const styledOutput = output.split("\n").map((line) => theme.fg("toolOutput", line)).join("\n");
        if (this.expanded) {
          this.contentBox.addChild(new Text(`
${styledOutput}`, 0, 0));
        } else {
          let cachedWidth;
          let cachedLines;
          let cachedSkipped;
          this.contentBox.addChild({
            render: (width) => {
              if (cachedLines === void 0 || cachedWidth !== width) {
                const result = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, width);
                cachedLines = result.visualLines;
                cachedSkipped = result.skippedCount;
                cachedWidth = width;
              }
              if (cachedSkipped && cachedSkipped > 0) {
                const hint = theme.fg("muted", `... (${cachedSkipped} earlier lines,`) + ` ${keyHint("expandTools", "to expand")})`;
                return ["", truncateToWidth(hint, width, "..."), ...cachedLines];
              }
              return ["", ...cachedLines];
            },
            invalidate: () => {
              cachedWidth = void 0;
              cachedLines = void 0;
              cachedSkipped = void 0;
            }
          });
        }
      }
      const truncation = this.result.details?.truncation;
      const fullOutputPath = this.result.details?.fullOutputPath;
      const cwd = this.result.details?.cwd;
      if (this.expanded && typeof cwd === "string" && cwd.length > 0) {
        this.contentBox.addChild(new Text(`
${theme.fg("muted", `cwd ${shortenPath(cwd)}`)}`, 0, 0));
      }
      if (truncation?.truncated || fullOutputPath) {
        const warnings = [];
        if (fullOutputPath) {
          warnings.push(`Full output: ${fullOutputPath}`);
        }
        if (truncation?.truncated) {
          if (truncation.truncatedBy === "lines") {
            warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
          } else {
            warnings.push(
              `Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`
            );
          }
        }
        this.contentBox.addChild(new Text(`
${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
      }
    }
  }
  getTextOutput() {
    if (!this.result) return "";
    const textBlocks = this.result.content?.filter((c) => c.type === "text") || [];
    const imageBlocks = this.result.content?.filter((c) => c.type === "image") || [];
    let output = textBlocks.map((c) => {
      return sanitizeBinaryOutput(stripAnsi(c.text || "")).replace(/\r/g, "");
    }).join("\n");
    const caps = getCapabilities();
    if (imageBlocks.length > 0 && (!caps.images || !this.showImages)) {
      const imageIndicators = imageBlocks.map((img) => {
        return imageFallback(img.mimeType);
      }).join("\n");
      output = output ? `${output}
${imageIndicators}` : imageIndicators;
    }
    return output;
  }
  formatToolExecution() {
    let text = "";
    const invalidArg = theme.fg("error", "[invalid arg]");
    const normalizedToolName = this.normalizedToolName;
    if (normalizedToolName === "read") {
      const rawPath = str(this.args?.file_path ?? this.args?.path);
      const path = rawPath !== null ? shortenPath(rawPath) : null;
      const offset = this.args?.offset;
      const limit = this.args?.limit;
      let pathDisplay = path === null ? invalidArg : path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
      if (offset !== void 0 || limit !== void 0) {
        const startLine = offset ?? 1;
        const endLine = limit !== void 0 ? startLine + limit - 1 : "";
        pathDisplay += theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
      }
      text = `${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}`;
      if (this.result) {
        if (this.result.isError) {
          const errorText = this.getTextOutput().trim() || "read failed";
          text += `

${theme.fg("error", errorText)}`;
          return text;
        }
        const rawOutput = this.getTextOutput();
        const output = rawOutput.replace(/^(\s*)\d+#[ZPMQVRWSNKTXJBYH]{2}:/gm, "$1");
        const rawPath2 = str(this.args?.file_path ?? this.args?.path);
        const lang = rawPath2 ? getLanguageFromPath(rawPath2) : void 0;
        const lines = lang ? highlightCode(replaceTabs(output), lang) : output.split("\n");
        const maxLines = this.expanded ? lines.length : 10;
        const displayLines = lines.slice(0, maxLines);
        const remaining = lines.length - maxLines;
        text += "\n\n" + displayLines.map((line) => lang ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line))).join("\n");
        if (remaining > 0) {
          text += `${theme.fg("muted", `
... (${remaining} more lines,`)} ${keyHint("expandTools", "to expand")})`;
        }
        const truncation = this.result.details?.truncation;
        if (truncation?.truncated) {
          if (truncation.firstLineExceedsLimit) {
            text += "\n" + theme.fg(
              "warning",
              `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`
            );
          } else if (truncation.truncatedBy === "lines") {
            text += "\n" + theme.fg(
              "warning",
              `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`
            );
          } else {
            text += "\n" + theme.fg(
              "warning",
              `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`
            );
          }
        }
      }
    } else if (normalizedToolName === "write") {
      const rawPath = str(this.args?.file_path ?? this.args?.path);
      const fileContent = str(this.args?.content);
      const path = rawPath !== null ? shortenPath(rawPath) : null;
      text = theme.fg("toolTitle", theme.bold("write")) + " " + (path === null ? invalidArg : path ? theme.fg("accent", path) : theme.fg("toolOutput", "..."));
      if (fileContent === null) {
        text += `

${theme.fg("error", "[invalid content arg - expected string]")}`;
      } else if (fileContent) {
        const lang = rawPath ? getLanguageFromPath(rawPath) : void 0;
        let lines;
        if (lang) {
          const cache = this.writeHighlightCache;
          if (cache && cache.lang === lang && cache.rawPath === rawPath && cache.rawContent === fileContent) {
            lines = cache.highlightedLines;
          } else {
            const displayContent = normalizeDisplayText(fileContent);
            const normalized = replaceTabs(displayContent);
            lines = highlightCode(normalized, lang);
            this.writeHighlightCache = {
              rawPath,
              lang,
              rawContent: fileContent,
              normalizedLines: normalized.split("\n"),
              highlightedLines: lines
            };
          }
        } else {
          lines = normalizeDisplayText(fileContent).split("\n");
          this.writeHighlightCache = void 0;
        }
        const totalLines = lines.length;
        const maxLines = this.expanded ? lines.length : 10;
        const displayLines = lines.slice(0, maxLines);
        const remaining = lines.length - maxLines;
        text += "\n\n" + displayLines.map((line) => lang ? line : theme.fg("toolOutput", replaceTabs(line))).join("\n");
        if (remaining > 0) {
          text += theme.fg("muted", `
... (${remaining} more lines, ${totalLines} total,`) + ` ${keyHint("expandTools", "to expand")})`;
        }
      }
      if (this.result?.isError) {
        const errorText = this.getTextOutput();
        if (errorText) {
          text += `

${theme.fg("error", errorText)}`;
        }
      }
    } else if (normalizedToolName === "edit") {
      const rawPath = str(this.args?.file_path ?? this.args?.path);
      const path = rawPath !== null ? shortenPath(rawPath) : null;
      let pathDisplay = path === null ? invalidArg : path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
      const firstChangedLine = (this.editDiffPreview && "firstChangedLine" in this.editDiffPreview ? this.editDiffPreview.firstChangedLine : void 0) || (this.result && !this.result.isError ? this.result.details?.firstChangedLine : void 0);
      if (firstChangedLine) {
        pathDisplay += theme.fg("warning", `:${firstChangedLine}`);
      }
      text = `${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`;
      if (this.result?.isError) {
        const errorText = this.getTextOutput();
        if (errorText) {
          text += `

${theme.fg("error", errorText)}`;
        }
      } else if (this.result?.details?.diff) {
        text += `

${renderDiff(this.result.details.diff, { filePath: rawPath ?? void 0 })}`;
      } else if (this.editDiffPreview) {
        if ("error" in this.editDiffPreview) {
          text += `

${theme.fg("error", this.editDiffPreview.error)}`;
        } else if (this.editDiffPreview.diff) {
          text += `

${renderDiff(this.editDiffPreview.diff, { filePath: rawPath ?? void 0 })}`;
        }
      }
    } else if (normalizedToolName === "ls") {
      const rawPath = str(this.args?.path);
      const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
      const limit = this.args?.limit;
      text = `${theme.fg("toolTitle", theme.bold("ls"))} ${path === null ? invalidArg : theme.fg("accent", path)}`;
      if (limit !== void 0) {
        text += theme.fg("toolOutput", ` (limit ${limit})`);
      }
      if (this.result) {
        if (this.result.isError) {
          const errorText = this.getTextOutput().trim() || "ls failed";
          text += `

${theme.fg("error", errorText)}`;
          return text;
        }
        const output = this.getTextOutput().trim();
        if (output) {
          const lines = output.split("\n");
          const maxLines = this.expanded ? lines.length : 20;
          const displayLines = lines.slice(0, maxLines);
          const remaining = lines.length - maxLines;
          text += `

${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
          if (remaining > 0) {
            text += `${theme.fg("muted", `
... (${remaining} more lines,`)} ${keyHint("expandTools", "to expand")})`;
          }
        }
        const entryLimit = this.result.details?.entryLimitReached;
        const truncation = this.result.details?.truncation;
        if (entryLimit || truncation?.truncated) {
          const warnings = [];
          if (entryLimit) {
            warnings.push(`${entryLimit} entries limit`);
          }
          if (truncation?.truncated) {
            warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
          }
          text += `
${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
        }
      }
    } else if (normalizedToolName === "find") {
      const pattern = str(this.args?.pattern);
      const rawPath = str(this.args?.path);
      const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
      const limit = this.args?.limit;
      text = theme.fg("toolTitle", theme.bold("find")) + " " + (pattern === null ? invalidArg : theme.fg("accent", pattern || "")) + theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
      if (limit !== void 0) {
        text += theme.fg("toolOutput", ` (limit ${limit})`);
      }
      if (this.result) {
        if (this.result.isError) {
          const errorText = this.getTextOutput().trim() || "find failed";
          text += `

${theme.fg("error", errorText)}`;
          return text;
        }
        const output = this.getTextOutput().trim();
        if (output) {
          const lines = output.split("\n");
          const maxLines = this.expanded ? lines.length : 20;
          const displayLines = lines.slice(0, maxLines);
          const remaining = lines.length - maxLines;
          text += `

${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
          if (remaining > 0) {
            text += `${theme.fg("muted", `
... (${remaining} more lines,`)} ${keyHint("expandTools", "to expand")})`;
          }
        }
        const resultLimit = this.result.details?.resultLimitReached;
        const truncation = this.result.details?.truncation;
        if (resultLimit || truncation?.truncated) {
          const warnings = [];
          if (resultLimit) {
            warnings.push(`${resultLimit} results limit`);
          }
          if (truncation?.truncated) {
            warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
          }
          text += `
${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
        }
      }
    } else if (normalizedToolName === "grep") {
      const pattern = str(this.args?.pattern);
      const rawPath = str(this.args?.path);
      const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
      const glob = str(this.args?.glob);
      const limit = this.args?.limit;
      text = theme.fg("toolTitle", theme.bold("grep")) + " " + (pattern === null ? invalidArg : theme.fg("accent", `/${pattern || ""}/`)) + theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
      if (glob) {
        text += theme.fg("toolOutput", ` (${glob})`);
      }
      if (limit !== void 0) {
        text += theme.fg("toolOutput", ` limit ${limit}`);
      }
      if (this.result) {
        if (this.result.isError) {
          const errorText = this.getTextOutput().trim() || "grep failed";
          text += `

${theme.fg("error", errorText)}`;
          return text;
        }
        const output = this.getTextOutput().trim();
        if (output) {
          const lines = output.split("\n");
          const maxLines = this.expanded ? lines.length : 15;
          const displayLines = lines.slice(0, maxLines);
          const remaining = lines.length - maxLines;
          text += `

${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
          if (remaining > 0) {
            text += `${theme.fg("muted", `
... (${remaining} more lines,`)} ${keyHint("expandTools", "to expand")})`;
          }
        }
        const matchLimit = this.result.details?.matchLimitReached;
        const truncation = this.result.details?.truncation;
        const linesTruncated = this.result.details?.linesTruncated;
        if (matchLimit || truncation?.truncated || linesTruncated) {
          const warnings = [];
          if (matchLimit) {
            warnings.push(`${matchLimit} matches limit`);
          }
          if (truncation?.truncated) {
            warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
          }
          if (linesTruncated) {
            warnings.push("some lines truncated");
          }
          text += `
${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
        }
      }
    } else if (normalizedToolName === "web_search") {
      text = theme.fg("toolTitle", theme.bold("web search"));
      if (process.env.PI_OFFLINE === "1") {
        text += "\n\n" + theme.fg("muted", "\u{1F50C} Offline \u2014 web search unavailable");
      } else if (this.result) {
        const output = this.getTextOutput().trim();
        if (output) {
          const lines = output.split("\n");
          const maxLines = this.expanded ? lines.length : 10;
          const displayLines = lines.slice(0, maxLines);
          const remaining = lines.length - maxLines;
          text += `

${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
          if (remaining > 0) {
            text += `${theme.fg("muted", `
... (${remaining} more lines,`)} ${keyHint("expandTools", "to expand")})`;
          }
        }
      }
    } else {
      const argsText = formatCompactArgs(this.args, this.expanded);
      if (argsText) {
        if (argsText.includes("\n")) {
          text = theme.fg("toolOutput", argsText);
        } else {
          text = theme.fg("toolOutput", argsText);
        }
      }
      if (this.result) {
        const output = this.getTextOutput().trim();
        if (output) {
          const lines = output.split("\n");
          const maxLines = this.expanded ? lines.length : GENERIC_OUTPUT_PREVIEW_LINES;
          const displayLines = lines.slice(0, maxLines);
          const remaining = lines.length - maxLines;
          const outputText = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
          text += `${text ? "\n\n" : ""}${outputText}`;
          if (remaining > 0) {
            text += `${theme.fg("muted", `
... (${remaining} more lines,`)} ${keyHint("expandTools", "to expand")})`;
          }
        }
      }
    }
    return text;
  }
}
class ToolPhaseSummaryComponent extends Container {
  constructor(phases) {
    super();
    this.phases = phases;
  }
  getPhases() {
    return this.phases.map((phase) => ({ ...phase, targets: phase.targets ? [...phase.targets] : void 0 }));
  }
  render(width) {
    const frameWidth = Math.max(20, width);
    const rows = this.phases.flatMap((phase) => {
      const left = summarizePhaseLabel(phase);
      const right = `success \xB7 ${formatElapsed(phase.durationMs)}`;
      const contentWidth = Math.max(1, frameWidth - 2);
      const leftWidth = Math.max(1, contentWidth - visibleWidth(right) - 1);
      const leftText = truncateToWidth(left, leftWidth, "");
      const gap = Math.max(1, contentWidth - visibleWidth(leftText) - visibleWidth(right));
      const summaryRow = `${theme.fg("toolSuccess", leftText)}${" ".repeat(gap)}${theme.fg("toolSuccess", right)}`;
      const targetRow = summarizePhaseTargets(phase, contentWidth);
      return targetRow ? [summaryRow, theme.fg("muted", targetRow)] : [summaryRow];
    });
    return ["", ...style().border("minimal").borderColor((text) => theme.fg("toolSuccess", text)).render(rows, frameWidth)];
  }
}
export {
  ToolExecutionComponent,
  ToolPhaseSummaryComponent
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9tb2Rlcy9pbnRlcmFjdGl2ZS9jb21wb25lbnRzL3Rvb2wtZXhlY3V0aW9uLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBQcm9qZWN0L0FwcDogR1NELTJcbi8vIEZpbGUgUHVycG9zZTogSW50ZXJhY3RpdmUgdGVybWluYWwgdG9vbCBleGVjdXRpb24gcmVuZGVyZXIgZm9yIGNvbW1hbmRzLCB0b29sIGNhbGxzLCBkaWZmcywgaW1hZ2VzLCBhbmQgc3VtbWFyaWVzLlxuaW1wb3J0IHtcblx0Qm94LFxuXHRDb250YWluZXIsXG5cdGdldENhcGFiaWxpdGllcyxcblx0SW1hZ2UsXG5cdHR5cGUgSW1hZ2VEaW1lbnNpb25zLFxuXHRpbWFnZUZhbGxiYWNrLFxuXHRTcGFjZXIsXG5cdHN0eWxlLFxuXHRUZXh0LFxuXHR0eXBlIFRVSSxcblx0dHJ1bmNhdGVUb1dpZHRoLFxuXHR2aXNpYmxlV2lkdGgsXG59IGZyb20gXCJAZ3NkL3BpLXR1aVwiO1xuaW1wb3J0IHN0cmlwQW5zaSBmcm9tIFwic3RyaXAtYW5zaVwiO1xuaW1wb3J0IHR5cGUgeyBUb29sRGVmaW5pdGlvbiB9IGZyb20gXCIuLi8uLi8uLi9jb3JlL2V4dGVuc2lvbnMvdHlwZXMuanNcIjtcbmltcG9ydCB7IGNvbXB1dGVFZGl0RGlmZiwgdHlwZSBFZGl0RGlmZkVycm9yLCB0eXBlIEVkaXREaWZmUmVzdWx0IH0gZnJvbSBcIi4uLy4uLy4uL2NvcmUvdG9vbHMvZWRpdC1kaWZmLmpzXCI7XG5pbXBvcnQgeyBhbGxUb29scyB9IGZyb20gXCIuLi8uLi8uLi9jb3JlL3Rvb2xzL2luZGV4LmpzXCI7XG5pbXBvcnQgeyBERUZBVUxUX01BWF9CWVRFUywgREVGQVVMVF9NQVhfTElORVMsIGZvcm1hdFNpemUgfSBmcm9tIFwiLi4vLi4vLi4vY29yZS90b29scy90cnVuY2F0ZS5qc1wiO1xuaW1wb3J0IHsgY29udmVydFRvUG5nIH0gZnJvbSBcIi4uLy4uLy4uL3V0aWxzL2ltYWdlLWNvbnZlcnQuanNcIjtcbmltcG9ydCB7IHNhbml0aXplQmluYXJ5T3V0cHV0IH0gZnJvbSBcIi4uLy4uLy4uL3V0aWxzL3NoZWxsLmpzXCI7XG5pbXBvcnQgeyBnZXRMYW5ndWFnZUZyb21QYXRoLCBoaWdobGlnaHRDb2RlLCB0aGVtZSB9IGZyb20gXCIuLi90aGVtZS90aGVtZS5qc1wiO1xuaW1wb3J0IHsgc2hvcnRlblBhdGggfSBmcm9tIFwiLi4vdXRpbHMvc2hvcnRlbi1wYXRoLmpzXCI7XG5pbXBvcnQgeyByZW5kZXJEaWZmIH0gZnJvbSBcIi4vZGlmZi5qc1wiO1xuaW1wb3J0IHsga2V5SGludCB9IGZyb20gXCIuL2tleWJpbmRpbmctaGludHMuanNcIjtcbmltcG9ydCB7IHJlbmRlckNvbW1hbmRDYXJkLCByZW5kZXJUb29sTGluZUNhcmQsIHJlbmRlclRyYW5zY3JpcHRDYXJkLCB0eXBlIFN0YXR1c1RvbmUgfSBmcm9tIFwiLi90cmFuc2NyaXB0LWRlc2lnbi5qc1wiO1xuaW1wb3J0IHsgdHJ1bmNhdGVUb1Zpc3VhbExpbmVzIH0gZnJvbSBcIi4vdmlzdWFsLXRydW5jYXRlLmpzXCI7XG5cbi8vIFByZXZpZXcgbGluZSBsaW1pdCBmb3IgYmFzaCB3aGVuIG5vdCBleHBhbmRlZFxuY29uc3QgQkFTSF9QUkVWSUVXX0xJTkVTID0gNTtcbi8vIER1cmluZyBwYXJ0aWFsIHdyaXRlIHRvb2wtY2FsbCBzdHJlYW1pbmcsIHJlLWhpZ2hsaWdodCB0aGUgZmlyc3QgTiBsaW5lcyBmdWxseVxuLy8gdG8ga2VlcCBtdWx0aWxpbmUgdG9rZW5pemF0aW9uIG1vc3RseSBjb3JyZWN0IHdpdGhvdXQgcmUtaGlnaGxpZ2h0aW5nIHRoZSBmdWxsIGZpbGUuXG5jb25zdCBXUklURV9QQVJUSUFMX0ZVTExfSElHSExJR0hUX0xJTkVTID0gNTA7XG5cbi8qKlxuICogUmVwbGFjZSB0YWJzIHdpdGggc3BhY2VzIGZvciBjb25zaXN0ZW50IHJlbmRlcmluZ1xuICovXG5mdW5jdGlvbiByZXBsYWNlVGFicyh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRyZXR1cm4gdGV4dC5yZXBsYWNlKC9cXHQvZywgXCIgICAgXCIpO1xufVxuXG4vKipcbiAqIE5vcm1hbGl6ZSBjb250cm9sIGNoYXJhY3RlcnMgZm9yIHRlcm1pbmFsIHByZXZpZXcgcmVuZGVyaW5nLlxuICogS2VlcCB0b29sIGFyZ3VtZW50cyB1bmNoYW5nZWQsIHNhbml0aXplIG9ubHkgZGlzcGxheSB0ZXh0LlxuICovXG5mdW5jdGlvbiBub3JtYWxpemVEaXNwbGF5VGV4dCh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRyZXR1cm4gdGV4dC5yZXBsYWNlKC9cXHIvZywgXCJcIik7XG59XG5cbi8qKiBTYWZlbHkgY29lcmNlIHZhbHVlIHRvIHN0cmluZyBmb3IgZGlzcGxheS4gUmV0dXJucyBudWxsIGlmIGludmFsaWQgdHlwZS4gKi9cbmZ1bmN0aW9uIHN0cih2YWx1ZTogdW5rbm93bik6IHN0cmluZyB8IG51bGwge1xuXHRpZiAodHlwZW9mIHZhbHVlID09PSBcInN0cmluZ1wiKSByZXR1cm4gdmFsdWU7XG5cdGlmICh2YWx1ZSA9PSBudWxsKSByZXR1cm4gXCJcIjtcblx0cmV0dXJuIG51bGw7IC8vIEludmFsaWQgdHlwZVxufVxuXG4vKipcbiAqIFNwbGl0IGEgQ2xhdWRlIENvZGUgTUNQIHRvb2wgbmFtZSAoYG1jcF9fPHNlcnZlcj5fXzx0b29sPmApIGludG8gaXRzIHBhcnRzLlxuICogUmV0dXJucyBudWxsIGZvciBub24tcHJlZml4ZWQgbmFtZXMuIER1cGxpY2F0ZWQgZnJvbSB0aGUgY2xhdWRlLWNvZGUtY2xpXG4gKiBleHRlbnNpb24gKHBhcnNlTWNwVG9vbE5hbWUpIHNvIHRoaXMgcGFja2FnZSBkb2Vzbid0IGhhdmUgdG8gaW1wb3J0IGFjcm9zc1xuICogdGhlIHJlc291cmNlcy9leHRlbnNpb25zIGJvdW5kYXJ5LlxuICovXG5mdW5jdGlvbiBwYXJzZU1jcFRvb2xOYW1lKG5hbWU6IHN0cmluZyk6IHsgc2VydmVyOiBzdHJpbmc7IHRvb2w6IHN0cmluZyB9IHwgbnVsbCB7XG5cdGlmICghbmFtZS5zdGFydHNXaXRoKFwibWNwX19cIikpIHJldHVybiBudWxsO1xuXHRjb25zdCByZXN0ID0gbmFtZS5zbGljZShcIm1jcF9fXCIubGVuZ3RoKTtcblx0Y29uc3QgZGVsaW0gPSByZXN0LmluZGV4T2YoXCJfX1wiKTtcblx0aWYgKGRlbGltIDw9IDAgfHwgZGVsaW0gPT09IHJlc3QubGVuZ3RoIC0gMikgcmV0dXJuIG51bGw7XG5cdHJldHVybiB7IHNlcnZlcjogcmVzdC5zbGljZSgwLCBkZWxpbSksIHRvb2w6IHJlc3Quc2xpY2UoZGVsaW0gKyAyKSB9O1xufVxuXG4vKipcbiAqIFByZXR0aWZ5IGEgcmF3IHRvb2wgbmFtZSBmb3IgZGlzcGxheS4gUHJlZmVycyB0aGUgcmVnaXN0ZXJlZCBgbGFiZWxgXG4gKiAoXCJDb21wbGV0ZSBTbGljZVwiKSB3aGVuIGF2YWlsYWJsZTsgb3RoZXJ3aXNlIHN0cmlwcyBhIGxlYWRpbmcgYGdzZF9gXG4gKiBwcmVmaXggYW5kIGNvbnZlcnRzIHNuYWtlX2Nhc2UgdG8gVGl0bGUgQ2FzZS5cbiAqL1xuZnVuY3Rpb24gcHJldHRpZnlUb29sTmFtZShuYW1lOiBzdHJpbmcsIGxhYmVsPzogc3RyaW5nKTogc3RyaW5nIHtcblx0aWYgKGxhYmVsICYmIGxhYmVsLnRyaW0oKS5sZW5ndGggPiAwKSByZXR1cm4gbGFiZWw7XG5cdGNvbnN0IHN0cmlwcGVkID0gbmFtZS5yZXBsYWNlKC9eZ3NkXy8sIFwiXCIpO1xuXHRpZiAoc3RyaXBwZWQubGVuZ3RoID09PSAwKSByZXR1cm4gbmFtZTtcblx0cmV0dXJuIHN0cmlwcGVkXG5cdFx0LnNwbGl0KFwiX1wiKVxuXHRcdC5tYXAoKHdvcmQpID0+ICh3b3JkLmxlbmd0aCA9PT0gMCA/IHdvcmQgOiB3b3JkWzBdLnRvVXBwZXJDYXNlKCkgKyB3b3JkLnNsaWNlKDEpKSlcblx0XHQuam9pbihcIiBcIik7XG59XG5cbmNvbnN0IENPTVBBQ1RfQVJHX1ZBTFVFX0xJTUlUID0gNjA7XG5jb25zdCBHRU5FUklDX09VVFBVVF9QUkVWSUVXX0xJTkVTID0gMTA7XG5jb25zdCBHRU5FUklDX0FSR1NfSlNPTl9QUkVWSUVXX0xJTkVTID0gMTA7XG5cbmV4cG9ydCB0eXBlIFRvb2xFeGVjdXRpb25QaGFzZSA9IHtcblx0bGFiZWw6IHN0cmluZztcblx0Y291bnQ6IG51bWJlcjtcblx0ZHVyYXRpb25NczogbnVtYmVyO1xuXHR0YXJnZXRzPzogc3RyaW5nW107XG5cdGFjdGlvbkxhYmVsPzogc3RyaW5nO1xufTtcblxudHlwZSBUb29sVGFyZ2V0TWV0YWRhdGEgPSB7XG5cdGtpbmQ/OiBzdHJpbmc7XG5cdGFjdGlvbj86IHN0cmluZztcblx0aW5wdXRQYXRoPzogc3RyaW5nO1xuXHRyZXNvbHZlZFBhdGg/OiBzdHJpbmc7XG5cdHBhdHRlcm4/OiBzdHJpbmc7XG5cdGdsb2I/OiBzdHJpbmc7XG5cdGxpbmU/OiBudW1iZXI7XG5cdHJhbmdlPzoge1xuXHRcdHN0YXJ0PzogbnVtYmVyO1xuXHRcdGVuZD86IG51bWJlcjtcblx0fTtcbn07XG5cbmZ1bmN0aW9uIGZvcm1hdEVsYXBzZWQobXM6IG51bWJlcik6IHN0cmluZyB7XG5cdGlmIChtcyA8IDEwMDApIHJldHVybiBgJHttc31tc2A7XG5cdHJldHVybiBgJHtNYXRoLm1heCgxLCBNYXRoLnJvdW5kKG1zIC8gMTAwMCkpfXNgO1xufVxuXG5mdW5jdGlvbiBmb3JtYXRDb21tYW5kUHJldmlldyhjb21tYW5kOiBzdHJpbmcpOiBzdHJpbmcge1xuXHRyZXR1cm4gdHJ1bmNhdGVUb1dpZHRoKGNvbW1hbmQucmVwbGFjZSgvXFxzKy9nLCBcIiBcIikudHJpbSgpLCA2NCwgXCJcIik7XG59XG5cbmZ1bmN0aW9uIGFwcGVuZExpbmVPclJhbmdlKGRpc3BsYXlQYXRoOiBzdHJpbmcgfCB1bmRlZmluZWQsIHRhcmdldDogVG9vbFRhcmdldE1ldGFkYXRhKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcblx0aWYgKCFkaXNwbGF5UGF0aCkgcmV0dXJuIHVuZGVmaW5lZDtcblx0aWYgKHR5cGVvZiB0YXJnZXQubGluZSA9PT0gXCJudW1iZXJcIiAmJiBOdW1iZXIuaXNGaW5pdGUodGFyZ2V0LmxpbmUpKSB7XG5cdFx0cmV0dXJuIGAke2Rpc3BsYXlQYXRofToke3RhcmdldC5saW5lfWA7XG5cdH1cblx0Y29uc3Qgc3RhcnQgPSB0YXJnZXQucmFuZ2U/LnN0YXJ0O1xuXHRpZiAodHlwZW9mIHN0YXJ0ID09PSBcIm51bWJlclwiICYmIE51bWJlci5pc0Zpbml0ZShzdGFydCkpIHtcblx0XHRjb25zdCBlbmQgPSB0YXJnZXQucmFuZ2U/LmVuZDtcblx0XHRjb25zdCBzdWZmaXggPVxuXHRcdFx0dHlwZW9mIGVuZCA9PT0gXCJudW1iZXJcIiAmJiBOdW1iZXIuaXNGaW5pdGUoZW5kKSAmJiBlbmQgIT09IHN0YXJ0XG5cdFx0XHRcdD8gYCR7c3RhcnR9LSR7ZW5kfWBcblx0XHRcdFx0OiBgJHtzdGFydH1gO1xuXHRcdHJldHVybiBgJHtkaXNwbGF5UGF0aH06JHtzdWZmaXh9YDtcblx0fVxuXHRyZXR1cm4gZGlzcGxheVBhdGg7XG59XG5cbmZ1bmN0aW9uIGZvcm1hdFRvb2xUYXJnZXQodGFyZ2V0OiBUb29sVGFyZ2V0TWV0YWRhdGEpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuXHRjb25zdCBwYXRoID0gdGFyZ2V0LnJlc29sdmVkUGF0aCB8fCB0YXJnZXQuaW5wdXRQYXRoO1xuXHRjb25zdCBkaXNwbGF5UGF0aCA9IHBhdGggPyBzaG9ydGVuUGF0aChwYXRoKSA6IHVuZGVmaW5lZDtcblx0aWYgKHRhcmdldC5raW5kID09PSBcInNlYXJjaFwiKSB7XG5cdFx0Y29uc3Qgc2VhcmNoVGFyZ2V0ID0gZGlzcGxheVBhdGggPz8gdGFyZ2V0LmlucHV0UGF0aCA/PyBcIi5cIjtcblx0XHRjb25zdCBsYWJlbCA9IHRhcmdldC5wYXR0ZXJuID8gYCR7dGFyZ2V0LnBhdHRlcm59IGluICR7c2VhcmNoVGFyZ2V0fWAgOiBzZWFyY2hUYXJnZXQ7XG5cdFx0cmV0dXJuIHRhcmdldC5nbG9iID8gYCR7bGFiZWx9ICgke3RhcmdldC5nbG9ifSlgIDogbGFiZWw7XG5cdH1cblx0cmV0dXJuIGFwcGVuZExpbmVPclJhbmdlKGRpc3BsYXlQYXRoLCB0YXJnZXQpO1xufVxuXG5mdW5jdGlvbiBkaXJlY3REZXRhaWxzVGFyZ2V0KGRldGFpbHM6IHVua25vd24sIGFjdGlvbjogc3RyaW5nKTogVG9vbFRhcmdldE1ldGFkYXRhIHwgdW5kZWZpbmVkIHtcblx0aWYgKCFkZXRhaWxzIHx8IHR5cGVvZiBkZXRhaWxzICE9PSBcIm9iamVjdFwiKSByZXR1cm4gdW5kZWZpbmVkO1xuXHRjb25zdCByZWNvcmQgPSBkZXRhaWxzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuXHRjb25zdCByYXdQYXRoID0gcmVjb3JkLnJlc29sdmVkUGF0aCA/PyByZWNvcmQuaW5wdXRQYXRoID8/IHJlY29yZC5maWxlX3BhdGggPz8gcmVjb3JkLnBhdGg7XG5cdGlmICh0eXBlb2YgcmF3UGF0aCAhPT0gXCJzdHJpbmdcIiB8fCByYXdQYXRoLnRyaW0oKS5sZW5ndGggPT09IDApIHJldHVybiB1bmRlZmluZWQ7XG5cdGNvbnN0IHRhcmdldDogVG9vbFRhcmdldE1ldGFkYXRhID0ge1xuXHRcdGtpbmQ6IFwiZmlsZVwiLFxuXHRcdGFjdGlvbixcblx0XHRyZXNvbHZlZFBhdGg6IHR5cGVvZiByZWNvcmQucmVzb2x2ZWRQYXRoID09PSBcInN0cmluZ1wiID8gcmVjb3JkLnJlc29sdmVkUGF0aCA6IHJhd1BhdGgsXG5cdFx0aW5wdXRQYXRoOiB0eXBlb2YgcmVjb3JkLmlucHV0UGF0aCA9PT0gXCJzdHJpbmdcIiA/IHJlY29yZC5pbnB1dFBhdGggOiByYXdQYXRoLFxuXHR9O1xuXHRpZiAodHlwZW9mIHJlY29yZC5saW5lID09PSBcIm51bWJlclwiKSB7XG5cdFx0dGFyZ2V0LmxpbmUgPSByZWNvcmQubGluZTtcblx0fVxuXHRjb25zdCByYW5nZSA9IHJlY29yZC5yYW5nZTtcblx0aWYgKHJhbmdlICYmIHR5cGVvZiByYW5nZSA9PT0gXCJvYmplY3RcIikge1xuXHRcdGNvbnN0IHJhbmdlUmVjb3JkID0gcmFuZ2UgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG5cdFx0dGFyZ2V0LnJhbmdlID0ge1xuXHRcdFx0c3RhcnQ6IHR5cGVvZiByYW5nZVJlY29yZC5zdGFydCA9PT0gXCJudW1iZXJcIiA/IHJhbmdlUmVjb3JkLnN0YXJ0IDogdW5kZWZpbmVkLFxuXHRcdFx0ZW5kOiB0eXBlb2YgcmFuZ2VSZWNvcmQuZW5kID09PSBcIm51bWJlclwiID8gcmFuZ2VSZWNvcmQuZW5kIDogdW5kZWZpbmVkLFxuXHRcdH07XG5cdH1cblx0cmV0dXJuIHRhcmdldDtcbn1cblxuZnVuY3Rpb24gZmlyc3RTdHJpbmdBcmcoYXJnczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sIGtleXM6IHN0cmluZ1tdKTogc3RyaW5nIHwgbnVsbCB7XG5cdGZvciAoY29uc3Qga2V5IG9mIGtleXMpIHtcblx0XHRjb25zdCB2YWx1ZSA9IHN0cihhcmdzW2tleV0pO1xuXHRcdGlmICh2YWx1ZSA9PT0gbnVsbCkgY29udGludWU7XG5cdFx0aWYgKHZhbHVlKSByZXR1cm4gdmFsdWU7XG5cdH1cblx0cmV0dXJuIFwiXCI7XG59XG5cbmZ1bmN0aW9uIGZvcm1hdEFyZ3NQYXRoVGFyZ2V0KHBhdGg6IHN0cmluZyB8IG51bGwsIGFyZ3M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcblx0aWYgKCFwYXRoKSByZXR1cm4gdW5kZWZpbmVkO1xuXHRjb25zdCBzdGFydCA9IHR5cGVvZiBhcmdzLm9mZnNldCA9PT0gXCJudW1iZXJcIiA/IGFyZ3Mub2Zmc2V0IDogdW5kZWZpbmVkO1xuXHRjb25zdCBsaW1pdCA9IHR5cGVvZiBhcmdzLmxpbWl0ID09PSBcIm51bWJlclwiID8gYXJncy5saW1pdCA6IHVuZGVmaW5lZDtcblx0Y29uc3QgcmFuZ2UgPVxuXHRcdHN0YXJ0ICE9PSB1bmRlZmluZWQgfHwgbGltaXQgIT09IHVuZGVmaW5lZFxuXHRcdFx0PyB7XG5cdFx0XHRcdFx0c3RhcnQ6IHN0YXJ0ID8/IDEsXG5cdFx0XHRcdFx0ZW5kOiBsaW1pdCAhPT0gdW5kZWZpbmVkID8gKHN0YXJ0ID8/IDEpICsgTWF0aC5tYXgoMCwgbGltaXQgLSAxKSA6IHVuZGVmaW5lZCxcblx0XHRcdFx0fVxuXHRcdFx0OiB1bmRlZmluZWQ7XG5cdHJldHVybiBhcHBlbmRMaW5lT3JSYW5nZShzaG9ydGVuUGF0aChwYXRoKSwgeyByYW5nZSB9KTtcbn1cblxuZnVuY3Rpb24gc3RyaXBMaW5lU3VmZml4KHRhcmdldDogc3RyaW5nKTogc3RyaW5nIHtcblx0cmV0dXJuIHRhcmdldC5yZXBsYWNlKC86XFxkKyg/Oi1cXGQrKT8kLywgXCJcIik7XG59XG5cbmZ1bmN0aW9uIHVuaXF1ZVRhcmdldHModGFyZ2V0czogc3RyaW5nW10gfCB1bmRlZmluZWQpOiBzdHJpbmdbXSB7XG5cdGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcblx0Y29uc3QgdW5pcXVlOiBzdHJpbmdbXSA9IFtdO1xuXHRmb3IgKGNvbnN0IHRhcmdldCBvZiB0YXJnZXRzID8/IFtdKSB7XG5cdFx0aWYgKCF0YXJnZXQgfHwgc2Vlbi5oYXModGFyZ2V0KSkgY29udGludWU7XG5cdFx0c2Vlbi5hZGQodGFyZ2V0KTtcblx0XHR1bmlxdWUucHVzaCh0YXJnZXQpO1xuXHR9XG5cdHJldHVybiB1bmlxdWU7XG59XG5cbmZ1bmN0aW9uIHN1bW1hcml6ZVBoYXNlTGFiZWwocGhhc2U6IFRvb2xFeGVjdXRpb25QaGFzZSk6IHN0cmluZyB7XG5cdGNvbnN0IHBoYXNlVGFyZ2V0cyA9IHVuaXF1ZVRhcmdldHMocGhhc2UudGFyZ2V0cyk7XG5cdGNvbnN0IGJhc2VUYXJnZXRzID0gdW5pcXVlVGFyZ2V0cyhwaGFzZVRhcmdldHMubWFwKHN0cmlwTGluZVN1ZmZpeCkpO1xuXHRpZiAocGhhc2UubGFiZWwgPT09IFwiRmlsZSBjaGFuZ2VzXCIgJiYgYmFzZVRhcmdldHMubGVuZ3RoID4gMCkge1xuXHRcdGNvbnN0IGZpbGVXb3JkID0gYmFzZVRhcmdldHMubGVuZ3RoID09PSAxID8gXCJmaWxlXCIgOiBcImZpbGVzXCI7XG5cdFx0Y29uc3QgYWN0aW9uV29yZCA9XG5cdFx0XHRwaGFzZS5hY3Rpb25MYWJlbCA9PT0gXCJ3cml0ZVwiXG5cdFx0XHRcdD8gcGhhc2UuY291bnQgPT09IDFcblx0XHRcdFx0XHQ/IFwid3JpdGVcIlxuXHRcdFx0XHRcdDogXCJ3cml0ZXNcIlxuXHRcdFx0XHQ6IHBoYXNlLmFjdGlvbkxhYmVsID09PSB1bmRlZmluZWRcblx0XHRcdFx0XHQ/IHBoYXNlLmNvdW50ID09PSAxXG5cdFx0XHRcdFx0XHQ/IFwiYWN0aW9uXCJcblx0XHRcdFx0XHRcdDogXCJhY3Rpb25zXCJcblx0XHRcdFx0XHQ6IHBoYXNlLmNvdW50ID09PSAxXG5cdFx0XHRcdFx0XHQ/IFwiZWRpdFwiXG5cdFx0XHRcdFx0XHQ6IFwiZWRpdHNcIjtcblx0XHRyZXR1cm4gYCR7cGhhc2UubGFiZWx9IFx1MDBCNyAke2Jhc2VUYXJnZXRzLmxlbmd0aH0gJHtmaWxlV29yZH0sICR7cGhhc2UuY291bnR9ICR7YWN0aW9uV29yZH1gO1xuXHR9XG5cdGlmIChwaGFzZS5sYWJlbCA9PT0gXCJDb250ZXh0IHJlYWRzXCIgJiYgYmFzZVRhcmdldHMubGVuZ3RoID4gMCkge1xuXHRcdGNvbnN0IGZpbGVXb3JkID0gYmFzZVRhcmdldHMubGVuZ3RoID09PSAxID8gXCJmaWxlXCIgOiBcImZpbGVzXCI7XG5cdFx0cmV0dXJuIGAke3BoYXNlLmxhYmVsfSBcdTAwQjcgJHtiYXNlVGFyZ2V0cy5sZW5ndGh9ICR7ZmlsZVdvcmR9YDtcblx0fVxuXHRpZiAocGhhc2UubGFiZWwgPT09IFwiU2V0dXAgLyBzaGVsbFwiICYmIHBoYXNlVGFyZ2V0cy5sZW5ndGggPiAwKSB7XG5cdFx0cmV0dXJuIGAke3BoYXNlLmxhYmVsfSBcdTAwQjcgJHtwaGFzZS5jb3VudH0gJHtwaGFzZS5jb3VudCA9PT0gMSA/IFwiY29tbWFuZFwiIDogXCJjb21tYW5kc1wifWA7XG5cdH1cblx0cmV0dXJuIGAke3BoYXNlLmxhYmVsfSAke3BoYXNlLmNvdW50fSAke3BoYXNlLmNvdW50ID09PSAxID8gXCJhY3Rpb25cIiA6IFwiYWN0aW9uc1wifWA7XG59XG5cbmZ1bmN0aW9uIHN1bW1hcml6ZVBoYXNlVGFyZ2V0cyhwaGFzZTogVG9vbEV4ZWN1dGlvblBoYXNlLCB3aWR0aDogbnVtYmVyKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcblx0Y29uc3QgcGhhc2VUYXJnZXRzID0gdW5pcXVlVGFyZ2V0cyhwaGFzZS50YXJnZXRzKTtcblx0aWYgKHBoYXNlVGFyZ2V0cy5sZW5ndGggPT09IDApIHJldHVybiB1bmRlZmluZWQ7XG5cdGNvbnN0IHNob3duID0gcGhhc2VUYXJnZXRzLnNsaWNlKDAsIDMpO1xuXHRjb25zdCBzdWZmaXggPSBwaGFzZVRhcmdldHMubGVuZ3RoID4gc2hvd24ubGVuZ3RoID8gYCArJHtwaGFzZVRhcmdldHMubGVuZ3RoIC0gc2hvd24ubGVuZ3RofSBtb3JlYCA6IFwiXCI7XG5cdHJldHVybiB0cnVuY2F0ZVRvV2lkdGgoc2hvd24uam9pbihcIiBcdTAwQjcgXCIpICsgc3VmZml4LCB3aWR0aCwgXCJcIik7XG59XG5cbi8qKlxuICogRm9ybWF0IHRvb2wgYXJncyBmb3IgdGhlIGdlbmVyaWMtcmVuZGVyZXIgZmFsbGJhY2suIFByb2R1Y2VzIGEgb25lLWxpbmVcbiAqIGBrPXYsIGs9dmAgc3VtbWFyeSB3aGVuIGV2ZXJ5IHZhbHVlIGlzIGEgcHJpbWl0aXZlIHRoYXQgZml0cyBpbmxpbmU7IGZhbGxzXG4gKiBiYWNrIHRvIGEgdHJ1bmNhdGVkIEpTT04gZHVtcCBmb3Igc3RydWN0dXJhbGx5IGNvbXBsZXggYXJncy5cbiAqL1xuZnVuY3Rpb24gZm9ybWF0Q29tcGFjdEFyZ3MoYXJnczogdW5rbm93biwgZXhwYW5kZWQ6IGJvb2xlYW4pOiBzdHJpbmcge1xuXHRpZiAoYXJncyA9PSBudWxsKSByZXR1cm4gXCJcIjtcblx0aWYgKHR5cGVvZiBhcmdzICE9PSBcIm9iamVjdFwiKSByZXR1cm4gU3RyaW5nKGFyZ3MpO1xuXG5cdGNvbnN0IGVudHJpZXMgPSBPYmplY3QuZW50cmllcyhhcmdzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KTtcblx0aWYgKGVudHJpZXMubGVuZ3RoID09PSAwKSByZXR1cm4gXCJcIjtcblxuXHRjb25zdCBhbGxQcmltaXRpdmUgPSBlbnRyaWVzLmV2ZXJ5KChbLCB2YWx1ZV0pID0+IHtcblx0XHRjb25zdCB0ID0gdHlwZW9mIHZhbHVlO1xuXHRcdHJldHVybiB0ID09PSBcIm51bWJlclwiIHx8IHQgPT09IFwiYm9vbGVhblwiIHx8IHQgPT09IFwic3RyaW5nXCIgfHwgdmFsdWUgPT0gbnVsbDtcblx0fSk7XG5cblx0aWYgKGFsbFByaW1pdGl2ZSkge1xuXHRcdHJldHVybiBlbnRyaWVzXG5cdFx0XHQubWFwKChba2V5LCB2YWx1ZV0pID0+IHtcblx0XHRcdFx0aWYgKHR5cGVvZiB2YWx1ZSA9PT0gXCJzdHJpbmdcIikge1xuXHRcdFx0XHRcdGNvbnN0IHRydW5jYXRlZCA9XG5cdFx0XHRcdFx0XHQhZXhwYW5kZWQgJiYgdmFsdWUubGVuZ3RoID4gQ09NUEFDVF9BUkdfVkFMVUVfTElNSVRcblx0XHRcdFx0XHRcdFx0PyBgJHt2YWx1ZS5zbGljZSgwLCBDT01QQUNUX0FSR19WQUxVRV9MSU1JVCAtIDEpfVx1MjAyNmBcblx0XHRcdFx0XHRcdFx0OiB2YWx1ZTtcblx0XHRcdFx0XHRyZXR1cm4gYCR7a2V5fT0ke0pTT04uc3RyaW5naWZ5KHRydW5jYXRlZCl9YDtcblx0XHRcdFx0fVxuXHRcdFx0XHRpZiAodmFsdWUgPT0gbnVsbCkgcmV0dXJuIGAke2tleX09bnVsbGA7XG5cdFx0XHRcdHJldHVybiBgJHtrZXl9PSR7U3RyaW5nKHZhbHVlKX1gO1xuXHRcdFx0fSlcblx0XHRcdC5qb2luKFwiLCBcIik7XG5cdH1cblxuXHQvLyBDb21wbGV4IGFyZ3M6IHNob3cgdHJ1bmNhdGVkIEpTT04uXG5cdGNvbnN0IGxpbmVzID0gSlNPTi5zdHJpbmdpZnkoYXJncywgbnVsbCwgMikuc3BsaXQoXCJcXG5cIik7XG5cdGNvbnN0IG1heExpbmVzID0gZXhwYW5kZWQgPyBsaW5lcy5sZW5ndGggOiBHRU5FUklDX0FSR1NfSlNPTl9QUkVWSUVXX0xJTkVTO1xuXHRpZiAobGluZXMubGVuZ3RoIDw9IG1heExpbmVzKSByZXR1cm4gbGluZXMuam9pbihcIlxcblwiKTtcblx0cmV0dXJuIGxpbmVzLnNsaWNlKDAsIG1heExpbmVzKS5qb2luKFwiXFxuXCIpICsgXCJcXG4uLi5cIjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBUb29sRXhlY3V0aW9uT3B0aW9ucyB7XG5cdHNob3dJbWFnZXM/OiBib29sZWFuOyAvLyBkZWZhdWx0OiB0cnVlIChvbmx5IHVzZWQgaWYgdGVybWluYWwgc3VwcG9ydHMgaW1hZ2VzKVxufVxuXG50eXBlIFdyaXRlSGlnaGxpZ2h0Q2FjaGUgPSB7XG5cdHJhd1BhdGg6IHN0cmluZyB8IG51bGw7XG5cdGxhbmc6IHN0cmluZztcblx0cmF3Q29udGVudDogc3RyaW5nO1xuXHRub3JtYWxpemVkTGluZXM6IHN0cmluZ1tdO1xuXHRoaWdobGlnaHRlZExpbmVzOiBzdHJpbmdbXTtcbn07XG5cbi8qKlxuICogQ29tcG9uZW50IHRoYXQgcmVuZGVycyBhIHRvb2wgY2FsbCB3aXRoIGl0cyByZXN1bHQgKHVwZGF0ZWFibGUpXG4gKi9cbmV4cG9ydCBjbGFzcyBUb29sRXhlY3V0aW9uQ29tcG9uZW50IGV4dGVuZHMgQ29udGFpbmVyIHtcblx0cHJpdmF0ZSBjb250ZW50Qm94OiBCb3g7IC8vIFVzZWQgZm9yIGN1c3RvbSB0b29scyBhbmQgYmFzaCB2aXN1YWwgdHJ1bmNhdGlvblxuXHRwcml2YXRlIGNvbnRlbnRUZXh0OiBUZXh0OyAvLyBGb3IgYnVpbHQtaW4gdG9vbHMgKHdpdGggaXRzIG93biBwYWRkaW5nL2JnKVxuXHRwcml2YXRlIGltYWdlQ29tcG9uZW50czogSW1hZ2VbXSA9IFtdO1xuXHRwcml2YXRlIGltYWdlU3BhY2VyczogU3BhY2VyW10gPSBbXTtcblx0cHJpdmF0ZSB0b29sTmFtZTogc3RyaW5nO1xuXHRwcml2YXRlIGFyZ3M6IGFueTtcblx0cHJpdmF0ZSBleHBhbmRlZCA9IGZhbHNlO1xuXHRwcml2YXRlIHNob3dJbWFnZXM6IGJvb2xlYW47XG5cdHByaXZhdGUgaXNQYXJ0aWFsID0gdHJ1ZTtcblx0cHJpdmF0ZSB0b29sRGVmaW5pdGlvbj86IFRvb2xEZWZpbml0aW9uO1xuXHRwcml2YXRlIHVpOiBUVUk7XG5cdHByaXZhdGUgY3dkOiBzdHJpbmc7XG5cdHByaXZhdGUgcmVhZG9ubHkgc3RhcnRlZEF0ID0gRGF0ZS5ub3coKTtcblx0cHJpdmF0ZSBlbmRlZEF0OiBudW1iZXIgfCB1bmRlZmluZWQ7XG5cdHByaXZhdGUgcmVzdWx0Pzoge1xuXHRcdGNvbnRlbnQ6IEFycmF5PHsgdHlwZTogc3RyaW5nOyB0ZXh0Pzogc3RyaW5nOyBkYXRhPzogc3RyaW5nOyBtaW1lVHlwZT86IHN0cmluZyB9Pjtcblx0XHRpc0Vycm9yOiBib29sZWFuO1xuXHRcdGRldGFpbHM/OiBhbnk7XG5cdH07XG5cdC8vIENhY2hlZCBlZGl0IGRpZmYgcHJldmlldyAoY29tcHV0ZWQgd2hlbiBhcmdzIGFycml2ZSwgYmVmb3JlIHRvb2wgZXhlY3V0ZXMpXG5cdHByaXZhdGUgZWRpdERpZmZQcmV2aWV3PzogRWRpdERpZmZSZXN1bHQgfCBFZGl0RGlmZkVycm9yO1xuXHRwcml2YXRlIGVkaXREaWZmQXJnc0tleT86IHN0cmluZzsgLy8gVHJhY2sgd2hpY2ggYXJncyB0aGUgcHJldmlldyBpcyBmb3Jcblx0Ly8gQ2FjaGVkIGNvbnZlcnRlZCBpbWFnZXMgZm9yIEtpdHR5IHByb3RvY29sICh3aGljaCByZXF1aXJlcyBQTkcpLCBrZXllZCBieSBpbmRleFxuXHRwcml2YXRlIGNvbnZlcnRlZEltYWdlczogTWFwPG51bWJlciwgeyBkYXRhOiBzdHJpbmc7IG1pbWVUeXBlOiBzdHJpbmcgfT4gPSBuZXcgTWFwKCk7XG5cdC8vIENhY2hlZCByZXNvbHZlZCBpbWFnZSBkaW1lbnNpb25zIHRvIGF2b2lkIHJlLXRyaWdnZXJpbmcgYXN5bmMgcGFyc2luZ1xuXHQvLyB3aGVuIHVwZGF0ZURpc3BsYXkoKSByZWNyZWF0ZXMgSW1hZ2UgY29tcG9uZW50cyAoIzM0NTUpLlxuXHRwcml2YXRlIHJlc29sdmVkSW1hZ2VEaW1lbnNpb25zOiBNYXA8bnVtYmVyLCBJbWFnZURpbWVuc2lvbnM+ID0gbmV3IE1hcCgpO1xuXHQvLyBJbmNyZW1lbnRhbCBzeW50YXggaGlnaGxpZ2h0aW5nIGNhY2hlIGZvciB3cml0ZSB0b29sIGNhbGwgYXJnc1xuXHRwcml2YXRlIHdyaXRlSGlnaGxpZ2h0Q2FjaGU/OiBXcml0ZUhpZ2hsaWdodENhY2hlO1xuXHQvLyBXaGVuIHRydWUsIHRoaXMgY29tcG9uZW50IGludGVudGlvbmFsbHkgcmVuZGVycyBubyBsaW5lc1xuXHRwcml2YXRlIGhpZGVDb21wb25lbnQgPSBmYWxzZTtcblxuXHRwcml2YXRlIGdldCBub3JtYWxpemVkVG9vbE5hbWUoKTogc3RyaW5nIHtcblx0XHRyZXR1cm4gdHlwZW9mIHRoaXMudG9vbE5hbWUgPT09IFwic3RyaW5nXCIgPyB0aGlzLnRvb2xOYW1lLnRvTG93ZXJDYXNlKCkgOiBcIlwiO1xuXHR9XG5cblx0Y29uc3RydWN0b3IoXG5cdFx0dG9vbE5hbWU6IHN0cmluZyxcblx0XHRhcmdzOiBhbnksXG5cdFx0b3B0aW9uczogVG9vbEV4ZWN1dGlvbk9wdGlvbnMgPSB7fSxcblx0XHR0b29sRGVmaW5pdGlvbjogVG9vbERlZmluaXRpb24gfCB1bmRlZmluZWQsXG5cdFx0dWk6IFRVSSxcblx0XHRjd2Q6IHN0cmluZyA9IHByb2Nlc3MuY3dkKCksXG5cdCkge1xuXHRcdHN1cGVyKCk7XG5cdFx0dGhpcy50b29sTmFtZSA9IHRvb2xOYW1lO1xuXHRcdHRoaXMuYXJncyA9IGFyZ3M7XG5cdFx0dGhpcy5zaG93SW1hZ2VzID0gb3B0aW9ucy5zaG93SW1hZ2VzID8/IHRydWU7XG5cdFx0dGhpcy50b29sRGVmaW5pdGlvbiA9IHRvb2xEZWZpbml0aW9uO1xuXHRcdHRoaXMudWkgPSB1aTtcblx0XHR0aGlzLmN3ZCA9IGN3ZDtcblxuXHRcdHRoaXMuYWRkQ2hpbGQobmV3IFNwYWNlcigxKSk7XG5cblx0XHQvLyBBbHdheXMgY3JlYXRlIGJvdGggLSBjb250ZW50Qm94IGZvciBjdXN0b20gdG9vbHMvYmFzaCwgY29udGVudFRleHQgZm9yIG90aGVyIGJ1aWx0LWluc1xuXHRcdHRoaXMuY29udGVudEJveCA9IG5ldyBCb3goMSwgMSwgKHRleHQ6IHN0cmluZykgPT4gdGhlbWUuYmcoXCJ0b29sUGVuZGluZ0JnXCIsIHRleHQpKTtcblx0XHR0aGlzLmNvbnRlbnRUZXh0ID0gbmV3IFRleHQoXCJcIiwgMSwgMSwgKHRleHQ6IHN0cmluZykgPT4gdGhlbWUuYmcoXCJ0b29sUGVuZGluZ0JnXCIsIHRleHQpKTtcblxuXHRcdC8vIFVzZSBjb250ZW50Qm94IGZvciBiYXNoICh2aXN1YWwgdHJ1bmNhdGlvbikgb3IgY3VzdG9tIHRvb2xzIHdpdGggY3VzdG9tIHJlbmRlcmVyc1xuXHRcdC8vIFVzZSBjb250ZW50VGV4dCBmb3IgYnVpbHQtaW4gdG9vbHMgKGluY2x1ZGluZyBvdmVycmlkZXMgd2l0aG91dCBjdXN0b20gcmVuZGVyZXJzKVxuXHRcdGlmICh0aGlzLm5vcm1hbGl6ZWRUb29sTmFtZSA9PT0gXCJiYXNoXCIgfHwgKHRvb2xEZWZpbml0aW9uICYmICF0aGlzLnNob3VsZFVzZUJ1aWx0SW5SZW5kZXJlcigpKSkge1xuXHRcdFx0dGhpcy5hZGRDaGlsZCh0aGlzLmNvbnRlbnRCb3gpO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHR0aGlzLmFkZENoaWxkKHRoaXMuY29udGVudFRleHQpO1xuXHRcdH1cblxuXHRcdHRoaXMudXBkYXRlRGlzcGxheSgpO1xuXHR9XG5cblx0LyoqXG5cdCAqIENoZWNrIGlmIHdlIHNob3VsZCB1c2UgYnVpbHQtaW4gcmVuZGVyaW5nIGZvciB0aGlzIHRvb2wuXG5cdCAqIFJldHVybnMgdHJ1ZSBpZiB0aGUgdG9vbCBuYW1lIGlzIGEgYnVpbHQtaW4gQU5EIGVpdGhlciB0aGVyZSdzIG5vIHRvb2xEZWZpbml0aW9uXG5cdCAqIG9yIHRoZSB0b29sRGVmaW5pdGlvbiBkb2Vzbid0IHByb3ZpZGUgY3VzdG9tIHJlbmRlcmVycy5cblx0ICovXG5cdHByaXZhdGUgc2hvdWxkVXNlQnVpbHRJblJlbmRlcmVyKCk6IGJvb2xlYW4ge1xuXHRcdGNvbnN0IG5vcm1hbGl6ZWRUb29sTmFtZSA9IHRoaXMubm9ybWFsaXplZFRvb2xOYW1lO1xuXHRcdGNvbnN0IGlzQnVpbHRJbk5hbWUgPSBub3JtYWxpemVkVG9vbE5hbWUgaW4gYWxsVG9vbHM7XG5cdFx0Y29uc3QgaGFzQ3VzdG9tUmVuZGVyZXJzID0gdGhpcy50b29sRGVmaW5pdGlvbj8ucmVuZGVyQ2FsbCB8fCB0aGlzLnRvb2xEZWZpbml0aW9uPy5yZW5kZXJSZXN1bHQ7XG5cdFx0cmV0dXJuIGlzQnVpbHRJbk5hbWUgJiYgIWhhc0N1c3RvbVJlbmRlcmVycztcblx0fVxuXG5cdGRpc3Bvc2UoKTogdm9pZCB7XG5cdFx0dGhpcy5jb252ZXJ0ZWRJbWFnZXMuY2xlYXIoKTtcblx0XHR0aGlzLmltYWdlQ29tcG9uZW50cyA9IFtdO1xuXHRcdHRoaXMuaW1hZ2VTcGFjZXJzID0gW107XG5cdFx0dGhpcy5lZGl0RGlmZlByZXZpZXcgPSB1bmRlZmluZWQ7XG5cdFx0dGhpcy53cml0ZUhpZ2hsaWdodENhY2hlID0gdW5kZWZpbmVkO1xuXHRcdHRoaXMucmVzdWx0ID0gdW5kZWZpbmVkO1xuXHR9XG5cblx0dXBkYXRlQXJncyhhcmdzOiBhbnkpOiB2b2lkIHtcblx0XHR0aGlzLmFyZ3MgPSBhcmdzO1xuXHRcdGlmICh0aGlzLm5vcm1hbGl6ZWRUb29sTmFtZSA9PT0gXCJ3cml0ZVwiICYmIHRoaXMuaXNQYXJ0aWFsKSB7XG5cdFx0XHR0aGlzLnVwZGF0ZVdyaXRlSGlnaGxpZ2h0Q2FjaGVJbmNyZW1lbnRhbCgpO1xuXHRcdH1cblx0XHR0aGlzLnVwZGF0ZURpc3BsYXkoKTtcblx0fVxuXG5cdHByaXZhdGUgaGlnaGxpZ2h0U2luZ2xlTGluZShsaW5lOiBzdHJpbmcsIGxhbmc6IHN0cmluZyk6IHN0cmluZyB7XG5cdFx0Y29uc3QgaGlnaGxpZ2h0ZWQgPSBoaWdobGlnaHRDb2RlKGxpbmUsIGxhbmcpO1xuXHRcdHJldHVybiBoaWdobGlnaHRlZFswXSA/PyBcIlwiO1xuXHR9XG5cblx0cHJpdmF0ZSByZWZyZXNoV3JpdGVIaWdobGlnaHRQcmVmaXgoY2FjaGU6IFdyaXRlSGlnaGxpZ2h0Q2FjaGUpOiB2b2lkIHtcblx0XHRjb25zdCBwcmVmaXhDb3VudCA9IE1hdGgubWluKFdSSVRFX1BBUlRJQUxfRlVMTF9ISUdITElHSFRfTElORVMsIGNhY2hlLm5vcm1hbGl6ZWRMaW5lcy5sZW5ndGgpO1xuXHRcdGlmIChwcmVmaXhDb3VudCA9PT0gMCkgcmV0dXJuO1xuXG5cdFx0Y29uc3QgcHJlZml4U291cmNlID0gY2FjaGUubm9ybWFsaXplZExpbmVzLnNsaWNlKDAsIHByZWZpeENvdW50KS5qb2luKFwiXFxuXCIpO1xuXHRcdGNvbnN0IHByZWZpeEhpZ2hsaWdodGVkID0gaGlnaGxpZ2h0Q29kZShwcmVmaXhTb3VyY2UsIGNhY2hlLmxhbmcpO1xuXHRcdGZvciAobGV0IGkgPSAwOyBpIDwgcHJlZml4Q291bnQ7IGkrKykge1xuXHRcdFx0Y2FjaGUuaGlnaGxpZ2h0ZWRMaW5lc1tpXSA9XG5cdFx0XHRcdHByZWZpeEhpZ2hsaWdodGVkW2ldID8/IHRoaXMuaGlnaGxpZ2h0U2luZ2xlTGluZShjYWNoZS5ub3JtYWxpemVkTGluZXNbaV0gPz8gXCJcIiwgY2FjaGUubGFuZyk7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSByZWJ1aWxkV3JpdGVIaWdobGlnaHRDYWNoZUZ1bGwocmF3UGF0aDogc3RyaW5nIHwgbnVsbCwgZmlsZUNvbnRlbnQ6IHN0cmluZyk6IHZvaWQge1xuXHRcdGNvbnN0IGxhbmcgPSByYXdQYXRoID8gZ2V0TGFuZ3VhZ2VGcm9tUGF0aChyYXdQYXRoKSA6IHVuZGVmaW5lZDtcblx0XHRpZiAoIWxhbmcpIHtcblx0XHRcdHRoaXMud3JpdGVIaWdobGlnaHRDYWNoZSA9IHVuZGVmaW5lZDtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRjb25zdCBkaXNwbGF5Q29udGVudCA9IG5vcm1hbGl6ZURpc3BsYXlUZXh0KGZpbGVDb250ZW50KTtcblx0XHRjb25zdCBub3JtYWxpemVkID0gcmVwbGFjZVRhYnMoZGlzcGxheUNvbnRlbnQpO1xuXHRcdHRoaXMud3JpdGVIaWdobGlnaHRDYWNoZSA9IHtcblx0XHRcdHJhd1BhdGgsXG5cdFx0XHRsYW5nLFxuXHRcdFx0cmF3Q29udGVudDogZmlsZUNvbnRlbnQsXG5cdFx0XHRub3JtYWxpemVkTGluZXM6IG5vcm1hbGl6ZWQuc3BsaXQoXCJcXG5cIiksXG5cdFx0XHRoaWdobGlnaHRlZExpbmVzOiBoaWdobGlnaHRDb2RlKG5vcm1hbGl6ZWQsIGxhbmcpLFxuXHRcdH07XG5cdH1cblxuXHRwcml2YXRlIHVwZGF0ZVdyaXRlSGlnaGxpZ2h0Q2FjaGVJbmNyZW1lbnRhbCgpOiB2b2lkIHtcblx0XHRjb25zdCByYXdQYXRoID0gc3RyKHRoaXMuYXJncz8uZmlsZV9wYXRoID8/IHRoaXMuYXJncz8ucGF0aCk7XG5cdFx0Y29uc3QgZmlsZUNvbnRlbnQgPSBzdHIodGhpcy5hcmdzPy5jb250ZW50KTtcblx0XHRpZiAocmF3UGF0aCA9PT0gbnVsbCB8fCBmaWxlQ29udGVudCA9PT0gbnVsbCkge1xuXHRcdFx0dGhpcy53cml0ZUhpZ2hsaWdodENhY2hlID0gdW5kZWZpbmVkO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGNvbnN0IGxhbmcgPSByYXdQYXRoID8gZ2V0TGFuZ3VhZ2VGcm9tUGF0aChyYXdQYXRoKSA6IHVuZGVmaW5lZDtcblx0XHRpZiAoIWxhbmcpIHtcblx0XHRcdHRoaXMud3JpdGVIaWdobGlnaHRDYWNoZSA9IHVuZGVmaW5lZDtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRpZiAoIXRoaXMud3JpdGVIaWdobGlnaHRDYWNoZSkge1xuXHRcdFx0dGhpcy5yZWJ1aWxkV3JpdGVIaWdobGlnaHRDYWNoZUZ1bGwocmF3UGF0aCwgZmlsZUNvbnRlbnQpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGNvbnN0IGNhY2hlID0gdGhpcy53cml0ZUhpZ2hsaWdodENhY2hlO1xuXHRcdGlmIChjYWNoZS5sYW5nICE9PSBsYW5nIHx8IGNhY2hlLnJhd1BhdGggIT09IHJhd1BhdGgpIHtcblx0XHRcdHRoaXMucmVidWlsZFdyaXRlSGlnaGxpZ2h0Q2FjaGVGdWxsKHJhd1BhdGgsIGZpbGVDb250ZW50KTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRpZiAoIWZpbGVDb250ZW50LnN0YXJ0c1dpdGgoY2FjaGUucmF3Q29udGVudCkpIHtcblx0XHRcdHRoaXMucmVidWlsZFdyaXRlSGlnaGxpZ2h0Q2FjaGVGdWxsKHJhd1BhdGgsIGZpbGVDb250ZW50KTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRpZiAoZmlsZUNvbnRlbnQubGVuZ3RoID09PSBjYWNoZS5yYXdDb250ZW50Lmxlbmd0aCkge1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGNvbnN0IGRlbHRhUmF3ID0gZmlsZUNvbnRlbnQuc2xpY2UoY2FjaGUucmF3Q29udGVudC5sZW5ndGgpO1xuXHRcdGNvbnN0IGRlbHRhRGlzcGxheSA9IG5vcm1hbGl6ZURpc3BsYXlUZXh0KGRlbHRhUmF3KTtcblx0XHRjb25zdCBkZWx0YU5vcm1hbGl6ZWQgPSByZXBsYWNlVGFicyhkZWx0YURpc3BsYXkpO1xuXHRcdGNhY2hlLnJhd0NvbnRlbnQgPSBmaWxlQ29udGVudDtcblxuXHRcdGlmIChjYWNoZS5ub3JtYWxpemVkTGluZXMubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRjYWNoZS5ub3JtYWxpemVkTGluZXMucHVzaChcIlwiKTtcblx0XHRcdGNhY2hlLmhpZ2hsaWdodGVkTGluZXMucHVzaChcIlwiKTtcblx0XHR9XG5cblx0XHRjb25zdCBzZWdtZW50cyA9IGRlbHRhTm9ybWFsaXplZC5zcGxpdChcIlxcblwiKTtcblx0XHRjb25zdCBsYXN0SW5kZXggPSBjYWNoZS5ub3JtYWxpemVkTGluZXMubGVuZ3RoIC0gMTtcblx0XHRjYWNoZS5ub3JtYWxpemVkTGluZXNbbGFzdEluZGV4XSArPSBzZWdtZW50c1swXTtcblx0XHRjYWNoZS5oaWdobGlnaHRlZExpbmVzW2xhc3RJbmRleF0gPSB0aGlzLmhpZ2hsaWdodFNpbmdsZUxpbmUoY2FjaGUubm9ybWFsaXplZExpbmVzW2xhc3RJbmRleF0sIGNhY2hlLmxhbmcpO1xuXG5cdFx0Zm9yIChsZXQgaSA9IDE7IGkgPCBzZWdtZW50cy5sZW5ndGg7IGkrKykge1xuXHRcdFx0Y2FjaGUubm9ybWFsaXplZExpbmVzLnB1c2goc2VnbWVudHNbaV0pO1xuXHRcdFx0Y2FjaGUuaGlnaGxpZ2h0ZWRMaW5lcy5wdXNoKHRoaXMuaGlnaGxpZ2h0U2luZ2xlTGluZShzZWdtZW50c1tpXSwgY2FjaGUubGFuZykpO1xuXHRcdH1cblxuXHRcdHRoaXMucmVmcmVzaFdyaXRlSGlnaGxpZ2h0UHJlZml4KGNhY2hlKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBTaWduYWwgdGhhdCBhcmdzIGFyZSBjb21wbGV0ZSAodG9vbCBpcyBhYm91dCB0byBleGVjdXRlKS5cblx0ICogVGhpcyB0cmlnZ2VycyBkaWZmIGNvbXB1dGF0aW9uIGZvciBlZGl0IHRvb2wuXG5cdCAqL1xuXHRzZXRBcmdzQ29tcGxldGUoKTogdm9pZCB7XG5cdFx0aWYgKHRoaXMudG9vbE5hbWUgPT09IFwid3JpdGVcIikge1xuXHRcdFx0Y29uc3QgcmF3UGF0aCA9IHN0cih0aGlzLmFyZ3M/LmZpbGVfcGF0aCA/PyB0aGlzLmFyZ3M/LnBhdGgpO1xuXHRcdFx0Y29uc3QgZmlsZUNvbnRlbnQgPSBzdHIodGhpcy5hcmdzPy5jb250ZW50KTtcblx0XHRcdGlmIChyYXdQYXRoICE9PSBudWxsICYmIGZpbGVDb250ZW50ICE9PSBudWxsKSB7XG5cdFx0XHRcdHRoaXMucmVidWlsZFdyaXRlSGlnaGxpZ2h0Q2FjaGVGdWxsKHJhd1BhdGgsIGZpbGVDb250ZW50KTtcblx0XHRcdH1cblx0XHR9XG5cdFx0dGhpcy5tYXliZUNvbXB1dGVFZGl0RGlmZigpO1xuXHR9XG5cblx0LyoqXG5cdCAqIENvbXB1dGUgZWRpdCBkaWZmIHByZXZpZXcgd2hlbiB3ZSBoYXZlIGNvbXBsZXRlIGFyZ3MuXG5cdCAqIFRoaXMgcnVucyBhc3luYyBhbmQgdXBkYXRlcyBkaXNwbGF5IHdoZW4gZG9uZS5cblx0ICovXG5cdHByaXZhdGUgbWF5YmVDb21wdXRlRWRpdERpZmYoKTogdm9pZCB7XG5cdFx0aWYgKHRoaXMudG9vbE5hbWUgIT09IFwiZWRpdFwiKSByZXR1cm47XG5cblx0XHRjb25zdCBwYXRoID0gdGhpcy5hcmdzPy5wYXRoO1xuXHRcdGNvbnN0IG9sZFRleHQgPSB0aGlzLmFyZ3M/Lm9sZFRleHQ7XG5cdFx0Y29uc3QgbmV3VGV4dCA9IHRoaXMuYXJncz8ubmV3VGV4dDtcblxuXHRcdC8vIE5lZWQgYWxsIHRocmVlIHBhcmFtcyB0byBjb21wdXRlIGRpZmZcblx0XHRpZiAoIXBhdGggfHwgb2xkVGV4dCA9PT0gdW5kZWZpbmVkIHx8IG5ld1RleHQgPT09IHVuZGVmaW5lZCkgcmV0dXJuO1xuXG5cdFx0Ly8gQ3JlYXRlIGEga2V5IHRvIHRyYWNrIHdoaWNoIGFyZ3MgdGhpcyBjb21wdXRhdGlvbiBpcyBmb3Jcblx0XHRjb25zdCBhcmdzS2V5ID0gSlNPTi5zdHJpbmdpZnkoeyBwYXRoLCBvbGRUZXh0LCBuZXdUZXh0IH0pO1xuXG5cdFx0Ly8gU2tpcCBpZiB3ZSBhbHJlYWR5IGNvbXB1dGVkIGZvciB0aGVzZSBleGFjdCBhcmdzXG5cdFx0aWYgKHRoaXMuZWRpdERpZmZBcmdzS2V5ID09PSBhcmdzS2V5KSByZXR1cm47XG5cblx0XHR0aGlzLmVkaXREaWZmQXJnc0tleSA9IGFyZ3NLZXk7XG5cblx0XHQvLyBDb21wdXRlIGRpZmYgYXN5bmNcblx0XHRjb21wdXRlRWRpdERpZmYocGF0aCwgb2xkVGV4dCwgbmV3VGV4dCwgdGhpcy5jd2QpLnRoZW4oKHJlc3VsdCkgPT4ge1xuXHRcdFx0Ly8gT25seSB1cGRhdGUgaWYgYXJncyBoYXZlbid0IGNoYW5nZWQgc2luY2Ugd2Ugc3RhcnRlZFxuXHRcdFx0aWYgKHRoaXMuZWRpdERpZmZBcmdzS2V5ID09PSBhcmdzS2V5KSB7XG5cdFx0XHRcdHRoaXMuZWRpdERpZmZQcmV2aWV3ID0gcmVzdWx0O1xuXHRcdFx0XHR0aGlzLnVwZGF0ZURpc3BsYXkoKTtcblx0XHRcdFx0dGhpcy51aS5yZXF1ZXN0UmVuZGVyKCk7XG5cdFx0XHR9XG5cdFx0fSk7XG5cdH1cblxuXHR1cGRhdGVSZXN1bHQoXG5cdFx0cmVzdWx0OiB7XG5cdFx0XHRjb250ZW50OiBBcnJheTx7IHR5cGU6IHN0cmluZzsgdGV4dD86IHN0cmluZzsgZGF0YT86IHN0cmluZzsgbWltZVR5cGU/OiBzdHJpbmcgfT47XG5cdFx0XHRkZXRhaWxzPzogYW55O1xuXHRcdFx0aXNFcnJvcjogYm9vbGVhbjtcblx0XHR9LFxuXHRcdGlzUGFydGlhbCA9IGZhbHNlLFxuXHQpOiB2b2lkIHtcblx0XHR0aGlzLnJlc3VsdCA9IHJlc3VsdDtcblx0XHR0aGlzLmlzUGFydGlhbCA9IGlzUGFydGlhbDtcblx0XHRpZiAoIWlzUGFydGlhbCkge1xuXHRcdFx0dGhpcy5lbmRlZEF0ID0gdGhpcy5lbmRlZEF0ID8/IERhdGUubm93KCk7XG5cdFx0fVxuXHRcdGlmICh0aGlzLm5vcm1hbGl6ZWRUb29sTmFtZSA9PT0gXCJ3cml0ZVwiICYmICFpc1BhcnRpYWwpIHtcblx0XHRcdGNvbnN0IHJhd1BhdGggPSBzdHIodGhpcy5hcmdzPy5maWxlX3BhdGggPz8gdGhpcy5hcmdzPy5wYXRoKTtcblx0XHRcdGNvbnN0IGZpbGVDb250ZW50ID0gc3RyKHRoaXMuYXJncz8uY29udGVudCk7XG5cdFx0XHRpZiAocmF3UGF0aCAhPT0gbnVsbCAmJiBmaWxlQ29udGVudCAhPT0gbnVsbCkge1xuXHRcdFx0XHR0aGlzLnJlYnVpbGRXcml0ZUhpZ2hsaWdodENhY2hlRnVsbChyYXdQYXRoLCBmaWxlQ29udGVudCk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdHRoaXMudXBkYXRlRGlzcGxheSgpO1xuXHRcdC8vIENvbnZlcnQgbm9uLVBORyBpbWFnZXMgdG8gUE5HIGZvciBLaXR0eSBwcm90b2NvbCAoYXN5bmMpXG5cdFx0dGhpcy5tYXliZUNvbnZlcnRJbWFnZXNGb3JLaXR0eSgpO1xuXHR9XG5cblx0LyoqXG5cdCAqIE1hcmsgYSB0b29sIGNhbGwgYXMgaGlzdG9yaWNhbCB3aGVuIHJlcGxheWluZyBmcm9tIHNlc3Npb24gY29udGV4dCBhbmRcblx0ICogbm8gbWF0Y2hpbmcgdG9vbCByZXN1bHQgaXMgYXZhaWxhYmxlLiBIYXBwZW5zIGFmdGVyIGNvbXBhY3Rpb24gc3F1YXNoZXNcblx0ICogdG9vbF9yZXN1bHQgbWVzc2FnZXMgb3V0IG9mIGhpc3RvcnkgXHUyMDE0IHRoZSB0b29sIGNhbGwgYmxvY2sgc3Vydml2ZXMgYnV0XG5cdCAqIHRoZSByZXN1bHQgaXMgZ29uZS4gV2l0aG91dCB0aGlzLCB0aGUgY29tcG9uZW50IHN0YXlzIGluIFwiUnVubmluZ1wiIHN0YXRlXG5cdCAqIGZvcmV2ZXIgZXZlbiB0aG91Z2ggdGhlIHRvb2wgY29tcGxldGVkIGxvbmcgYWdvLlxuXHQgKi9cblx0bWFya0hpc3RvcmljYWxOb1Jlc3VsdCgpOiB2b2lkIHtcblx0XHRpZiAodGhpcy5yZXN1bHQpIHJldHVybjsgLy8gcmVhbCByZXN1bHQgYWxyZWFkeSBzZXQsIG5vdGhpbmcgdG8gZG9cblx0XHR0aGlzLmlzUGFydGlhbCA9IGZhbHNlO1xuXHRcdHRoaXMuZW5kZWRBdCA9IHRoaXMuZW5kZWRBdCA/PyBEYXRlLm5vdygpO1xuXHRcdHRoaXMucmVzdWx0ID0ge1xuXHRcdFx0Y29udGVudDogW10sXG5cdFx0XHRpc0Vycm9yOiBmYWxzZSxcblx0XHR9O1xuXHRcdHRoaXMudXBkYXRlRGlzcGxheSgpO1xuXHR9XG5cblx0LyoqXG5cdCAqIEZpbmFsaXplIGEgcGVuZGluZyB0b29sIGNhbGwgYXMgZmFpbGVkL2ludGVycnVwdGVkIHdoaWxlIHByZXNlcnZpbmcgYW55IHN0cmVhbWVkIHBhcnRpYWwgb3V0cHV0LlxuXHQgKi9cblx0Y29tcGxldGVXaXRoRXJyb3IobWVzc2FnZT86IHN0cmluZyk6IHZvaWQge1xuXHRcdHRoaXMuaXNQYXJ0aWFsID0gZmFsc2U7XG5cdFx0dGhpcy5lbmRlZEF0ID0gdGhpcy5lbmRlZEF0ID8/IERhdGUubm93KCk7XG5cdFx0aWYgKHRoaXMucmVzdWx0KSB7XG5cdFx0XHRsZXQgY29udGVudCA9IHRoaXMucmVzdWx0LmNvbnRlbnQ7XG5cdFx0XHRpZiAobWVzc2FnZSkge1xuXHRcdFx0XHRjb25zdCBhbHJlYWR5SGFzTWVzc2FnZSA9IGNvbnRlbnQuc29tZSgoYmxvY2spID0+IGJsb2NrLnR5cGUgPT09IFwidGV4dFwiICYmIGJsb2NrLnRleHQgPT09IG1lc3NhZ2UpO1xuXHRcdFx0XHRpZiAoIWFscmVhZHlIYXNNZXNzYWdlKSB7XG5cdFx0XHRcdFx0Y29udGVudCA9IFsuLi5jb250ZW50LCB7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBtZXNzYWdlIH1dO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0XHR0aGlzLnJlc3VsdCA9IHsgLi4udGhpcy5yZXN1bHQsIGNvbnRlbnQsIGlzRXJyb3I6IHRydWUgfTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0dGhpcy5yZXN1bHQgPSB7XG5cdFx0XHRcdGNvbnRlbnQ6IG1lc3NhZ2UgPyBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogbWVzc2FnZSB9XSA6IFtdLFxuXHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0fTtcblx0XHR9XG5cdFx0dGhpcy51cGRhdGVEaXNwbGF5KCk7XG5cdH1cblxuXHQvKipcblx0ICogQ29udmVydCBub24tUE5HIGltYWdlcyB0byBQTkcgZm9yIEtpdHR5IGdyYXBoaWNzIHByb3RvY29sLlxuXHQgKiBLaXR0eSByZXF1aXJlcyBQTkcgZm9ybWF0IChmPTEwMCksIHNvIEpQRUcvR0lGL1dlYlAgd29uJ3QgZGlzcGxheS5cblx0ICovXG5cdHByaXZhdGUgbWF5YmVDb252ZXJ0SW1hZ2VzRm9yS2l0dHkoKTogdm9pZCB7XG5cdFx0Y29uc3QgY2FwcyA9IGdldENhcGFiaWxpdGllcygpO1xuXHRcdC8vIE9ubHkgbmVlZGVkIGZvciBLaXR0eSBwcm90b2NvbFxuXHRcdGlmIChjYXBzLmltYWdlcyAhPT0gXCJraXR0eVwiKSByZXR1cm47XG5cdFx0aWYgKCF0aGlzLnJlc3VsdCkgcmV0dXJuO1xuXG5cdFx0Y29uc3QgaW1hZ2VCbG9ja3MgPSB0aGlzLnJlc3VsdC5jb250ZW50Py5maWx0ZXIoKGM6IGFueSkgPT4gYy50eXBlID09PSBcImltYWdlXCIpIHx8IFtdO1xuXG5cdFx0Zm9yIChsZXQgaSA9IDA7IGkgPCBpbWFnZUJsb2Nrcy5sZW5ndGg7IGkrKykge1xuXHRcdFx0Y29uc3QgaW1nID0gaW1hZ2VCbG9ja3NbaV07XG5cdFx0XHRpZiAoIWltZy5kYXRhIHx8ICFpbWcubWltZVR5cGUpIGNvbnRpbnVlO1xuXHRcdFx0Ly8gU2tpcCBpZiBhbHJlYWR5IFBORyBvciBhbHJlYWR5IGNvbnZlcnRlZFxuXHRcdFx0aWYgKGltZy5taW1lVHlwZSA9PT0gXCJpbWFnZS9wbmdcIikgY29udGludWU7XG5cdFx0XHRpZiAodGhpcy5jb252ZXJ0ZWRJbWFnZXMuaGFzKGkpKSBjb250aW51ZTtcblxuXHRcdFx0Ly8gQ29udmVydCBhc3luY1xuXHRcdFx0Y29uc3QgaW5kZXggPSBpO1xuXHRcdFx0Y29udmVydFRvUG5nKGltZy5kYXRhLCBpbWcubWltZVR5cGUpLnRoZW4oKGNvbnZlcnRlZCkgPT4ge1xuXHRcdFx0XHRpZiAoY29udmVydGVkKSB7XG5cdFx0XHRcdFx0dGhpcy5jb252ZXJ0ZWRJbWFnZXMuc2V0KGluZGV4LCBjb252ZXJ0ZWQpO1xuXHRcdFx0XHRcdHRoaXMudXBkYXRlRGlzcGxheSgpO1xuXHRcdFx0XHRcdHRoaXMudWkucmVxdWVzdFJlbmRlcigpO1xuXHRcdFx0XHR9XG5cdFx0XHR9KTtcblx0XHR9XG5cdH1cblxuXHRzZXRFeHBhbmRlZChleHBhbmRlZDogYm9vbGVhbik6IHZvaWQge1xuXHRcdHRoaXMuZXhwYW5kZWQgPSBleHBhbmRlZDtcblx0XHR0aGlzLnVwZGF0ZURpc3BsYXkoKTtcblx0fVxuXG5cdHNldFNob3dJbWFnZXMoc2hvdzogYm9vbGVhbik6IHZvaWQge1xuXHRcdHRoaXMuc2hvd0ltYWdlcyA9IHNob3c7XG5cdFx0dGhpcy51cGRhdGVEaXNwbGF5KCk7XG5cdH1cblxuXHRvdmVycmlkZSBpbnZhbGlkYXRlKCk6IHZvaWQge1xuXHRcdHN1cGVyLmludmFsaWRhdGUoKTtcblx0XHR0aGlzLnVwZGF0ZURpc3BsYXkoKTtcblx0fVxuXG5cdG92ZXJyaWRlIHJlbmRlcih3aWR0aDogbnVtYmVyKTogc3RyaW5nW10ge1xuXHRcdGlmICh0aGlzLmhpZGVDb21wb25lbnQpIHtcblx0XHRcdHJldHVybiBbXTtcblx0XHR9XG5cdFx0Y29uc3QgZnJhbWVXaWR0aCA9IE1hdGgubWF4KDIwLCB3aWR0aCk7XG5cdFx0Y29uc3QgY29udGVudFdpZHRoID0gTWF0aC5tYXgoMSwgZnJhbWVXaWR0aCAtIDQpO1xuXHRcdGNvbnN0IGZyYW1lVG9uZTogXCJwZW5kaW5nXCIgfCBcInN1Y2Nlc3NcIiB8IFwiZXJyb3JcIiA9XG5cdFx0XHR0aGlzLnJlc3VsdD8uaXNFcnJvciA/IFwiZXJyb3JcIiA6IHRoaXMuaXNQYXJ0aWFsIHx8ICF0aGlzLnJlc3VsdCA/IFwicGVuZGluZ1wiIDogXCJzdWNjZXNzXCI7XG5cdFx0Y29uc3QgZWxhcHNlZCA9IGZvcm1hdEVsYXBzZWQoKHRoaXMuZW5kZWRBdCA/PyBEYXRlLm5vdygpKSAtIHRoaXMuc3RhcnRlZEF0KTtcblx0XHRjb25zdCBzdGF0dXNXb3JkID0gdGhpcy5pc1BhcnRpYWwgfHwgIXRoaXMucmVzdWx0ID8gXCJydW5uaW5nXCIgOiB0aGlzLnJlc3VsdC5pc0Vycm9yID8gXCJmYWlsZWRcIiA6IFwic3VjY2Vzc1wiO1xuXHRcdGNvbnN0IGZyYW1lU3RhdHVzID0gYCR7c3RhdHVzV29yZH0gXHUwMEI3ICR7ZWxhcHNlZH1gO1xuXHRcdGNvbnN0IHBhcnNlZCA9IHBhcnNlTWNwVG9vbE5hbWUodGhpcy50b29sTmFtZSk7XG5cdFx0Y29uc3QgZnJhbWVMYWJlbCA9IHBhcnNlZFxuXHRcdFx0PyBgJHtwYXJzZWQuc2VydmVyfVx1MDBCNyR7cGFyc2VkLnRvb2x9YFxuXHRcdFx0OiBwcmV0dGlmeVRvb2xOYW1lKHRoaXMudG9vbE5hbWUsIHRoaXMudG9vbERlZmluaXRpb24/LmxhYmVsKSB8fCBcInVua25vd25cIjtcblx0XHRjb25zdCByZWNvbW1lbmRlZFRvbmU6IFN0YXR1c1RvbmUgPVxuXHRcdFx0ZnJhbWVUb25lID09PSBcInBlbmRpbmdcIiA/IFwicnVubmluZ1wiIDogZnJhbWVUb25lID09PSBcImVycm9yXCIgPyBcImVycm9yXCIgOiBcInN1Y2Nlc3NcIjtcblxuXHRcdGlmICh0aGlzLm5vcm1hbGl6ZWRUb29sTmFtZSA9PT0gXCJiYXNoXCIgJiYgIXRoaXMuZXhwYW5kZWQgJiYgIXRoaXMucmVzdWx0Py5pc0Vycm9yKSB7XG5cdFx0XHRjb25zdCBjb21tYW5kID0gc3RyKHRoaXMuYXJncz8uY29tbWFuZCk7XG5cdFx0XHRyZXR1cm4gW1xuXHRcdFx0XHRcIlwiLFxuXHRcdFx0XHQuLi5yZW5kZXJDb21tYW5kQ2FyZChjb21tYW5kICYmIGNvbW1hbmQubGVuZ3RoID4gMCA/IGZvcm1hdENvbW1hbmRQcmV2aWV3KGNvbW1hbmQpIDogZnJhbWVMYWJlbCwgZnJhbWVXaWR0aCwge1xuXHRcdFx0XHRcdHN0YXR1czogZnJhbWVTdGF0dXMsXG5cdFx0XHRcdFx0dG9uZTogcmVjb21tZW5kZWRUb25lLFxuXHRcdFx0XHR9KSxcblx0XHRcdF07XG5cdFx0fVxuXHRcdGNvbnN0IGhhc0ltYWdlcyA9IHRoaXMucmVzdWx0Py5jb250ZW50Py5zb21lKChibG9jaykgPT4gYmxvY2sudHlwZSA9PT0gXCJpbWFnZVwiKSA/PyBmYWxzZTtcblx0XHRpZiAoIXRoaXMuZXhwYW5kZWQgJiYgIXRoaXMucmVzdWx0Py5pc0Vycm9yICYmICFoYXNJbWFnZXMpIHtcblx0XHRcdGNvbnN0IGNvbXBhY3RUYXJnZXQgPSB0aGlzLmdldENvbXBhY3RUYXJnZXQoKTtcblx0XHRcdHJldHVybiBbXG5cdFx0XHRcdFwiXCIsXG5cdFx0XHRcdC4uLnJlbmRlclRvb2xMaW5lQ2FyZChmcmFtZUxhYmVsLCBjb21wYWN0VGFyZ2V0LCBmcmFtZVdpZHRoLCB7XG5cdFx0XHRcdFx0c3RhdHVzOiBmcmFtZVN0YXR1cyxcblx0XHRcdFx0XHR0b25lOiByZWNvbW1lbmRlZFRvbmUsXG5cdFx0XHRcdFx0aGlkZGVuOiAhdGhpcy5pc1BhcnRpYWwgJiYgISF0aGlzLnJlc3VsdCxcblx0XHRcdFx0fSksXG5cdFx0XHRdO1xuXHRcdH1cblx0XHRjb25zdCBsaW5lcyA9IHN1cGVyLnJlbmRlcihjb250ZW50V2lkdGgpO1xuXHRcdGNvbnN0IGZyYW1lZCA9IHJlbmRlclRyYW5zY3JpcHRDYXJkKGxpbmVzLCBmcmFtZVdpZHRoLCB7XG5cdFx0XHR0aXRsZTogZnJhbWVMYWJlbCxcblx0XHRcdHJpZ2h0OiBmcmFtZVN0YXR1cyxcblx0XHRcdHRvbmU6IHJlY29tbWVuZGVkVG9uZSxcblx0XHRcdGZvb3RlckxlZnQ6IHRoaXMuZXhwYW5kZWQgPyBcIm91dHB1dCBleHBhbmRlZFwiIDogdW5kZWZpbmVkLFxuXHRcdFx0Zm9vdGVyUmlnaHQ6IHRoaXMuZXhwYW5kZWQgPyBcImN0cmwrbyBjb2xsYXBzZVwiIDogdW5kZWZpbmVkLFxuXHRcdH0pO1xuXHRcdHJldHVybiBmcmFtZWQubGVuZ3RoID4gMCA/IFtcIlwiLCAuLi5mcmFtZWRdIDogZnJhbWVkO1xuXHR9XG5cblx0cHJpdmF0ZSBzaG91bGRSZW5kZXJDb21wYWN0U3VjY2VzcygpOiBib29sZWFuIHtcblx0XHRpZiAodGhpcy5leHBhbmRlZCB8fCB0aGlzLmlzUGFydGlhbCB8fCAhdGhpcy5yZXN1bHQgfHwgdGhpcy5yZXN1bHQuaXNFcnJvcikgcmV0dXJuIGZhbHNlO1xuXHRcdGNvbnN0IGhhc0ltYWdlcyA9IHRoaXMucmVzdWx0LmNvbnRlbnQ/LnNvbWUoKGJsb2NrKSA9PiBibG9jay50eXBlID09PSBcImltYWdlXCIpID8/IGZhbHNlO1xuXHRcdHJldHVybiAhaGFzSW1hZ2VzO1xuXHR9XG5cblx0Z2V0Um9sbHVwUGhhc2UoKTogVG9vbEV4ZWN1dGlvblBoYXNlIHwgbnVsbCB7XG5cdFx0aWYgKCF0aGlzLnNob3VsZFJlbmRlckNvbXBhY3RTdWNjZXNzKCkpIHJldHVybiBudWxsO1xuXHRcdGNvbnN0IGxhYmVsID0gdGhpcy5nZXRQaGFzZUxhYmVsKCk7XG5cdFx0Y29uc3QgZW5kZWRBdCA9IHRoaXMuZW5kZWRBdCA/PyBEYXRlLm5vdygpO1xuXHRcdGNvbnN0IHRhcmdldCA9IHRoaXMuZ2V0Q29tcGFjdFRhcmdldCgpO1xuXHRcdHJldHVybiB7XG5cdFx0XHRsYWJlbCxcblx0XHRcdGNvdW50OiAxLFxuXHRcdFx0ZHVyYXRpb25NczogTWF0aC5tYXgoMCwgZW5kZWRBdCAtIHRoaXMuc3RhcnRlZEF0KSxcblx0XHRcdHRhcmdldHM6IHRhcmdldCA/IFt0YXJnZXRdIDogdW5kZWZpbmVkLFxuXHRcdFx0YWN0aW9uTGFiZWw6IHRoaXMuZ2V0Q29tcGFjdEFjdGlvbigpLFxuXHRcdH07XG5cdH1cblxuXHRwcml2YXRlIGdldFBoYXNlTGFiZWwoKTogc3RyaW5nIHtcblx0XHRjb25zdCBuYW1lID0gdGhpcy5ub3JtYWxpemVkVG9vbE5hbWU7XG5cdFx0Y29uc3QgZGlzcGxheU5hbWUgPSBwcmV0dGlmeVRvb2xOYW1lKHRoaXMudG9vbE5hbWUsIHRoaXMudG9vbERlZmluaXRpb24/LmxhYmVsKTtcblxuXHRcdGlmIChuYW1lID09PSBcImJhc2hcIikgcmV0dXJuIFwiU2V0dXAgLyBzaGVsbFwiO1xuXHRcdGlmIChuYW1lID09PSBcInJlYWRcIiB8fCBuYW1lID09PSBcImxzXCIgfHwgbmFtZSA9PT0gXCJmaW5kXCIgfHwgbmFtZSA9PT0gXCJncmVwXCIpIHJldHVybiBcIkNvbnRleHQgcmVhZHNcIjtcblx0XHRpZiAobmFtZSA9PT0gXCJ3cml0ZVwiIHx8IG5hbWUgPT09IFwiZWRpdFwiKSByZXR1cm4gXCJGaWxlIGNoYW5nZXNcIjtcblx0XHRpZiAobmFtZSA9PT0gXCJ3ZWJfc2VhcmNoXCIgfHwgZGlzcGxheU5hbWUgPT09IFwiVG9vbFNlYXJjaFwiKSByZXR1cm4gXCJEaXNjb3ZlcnlcIjtcblx0XHRpZiAoZGlzcGxheU5hbWUgPT09IFwiTWVtb3J5IFF1ZXJ5XCIgfHwgZGlzcGxheU5hbWUgPT09IFwiTWVtb3J5IENhcHR1cmVcIiB8fCBkaXNwbGF5TmFtZSA9PT0gXCJHc2QgR3JhcGhcIikge1xuXHRcdFx0cmV0dXJuIFwiTWVtb3J5IGxvb2t1cHNcIjtcblx0XHR9XG5cdFx0aWYgKGRpc3BsYXlOYW1lID09PSBcIlVwZGF0ZSBSZXF1aXJlbWVudFwiIHx8IGRpc3BsYXlOYW1lID09PSBcIlNhdmUgUmVxdWlyZW1lbnRcIikgcmV0dXJuIFwiUmVxdWlyZW1lbnQgd3JpdGVzXCI7XG5cdFx0aWYgKGRpc3BsYXlOYW1lLnN0YXJ0c1dpdGgoXCJDb21wbGV0ZSBcIikpIHJldHVybiBcIkZpbmFsaXphdGlvblwiO1xuXHRcdHJldHVybiBcIk90aGVyIHRvb2wgYWN0aW9uc1wiO1xuXHR9XG5cblx0cHJpdmF0ZSBnZXRDb21wYWN0QWN0aW9uKCk6IHN0cmluZyB7XG5cdFx0Y29uc3QgdGFyZ2V0ID0gdGhpcy5nZXRUYXJnZXRNZXRhZGF0YSgpO1xuXHRcdGlmICh0YXJnZXQ/LmFjdGlvbikgcmV0dXJuIHRhcmdldC5hY3Rpb24gPT09IFwibGlzdFwiID8gXCJsc1wiIDogdGFyZ2V0LmFjdGlvbjtcblx0XHRyZXR1cm4gdGhpcy5ub3JtYWxpemVkVG9vbE5hbWU7XG5cdH1cblxuXHRwcml2YXRlIGdldFRhcmdldE1ldGFkYXRhKCk6IFRvb2xUYXJnZXRNZXRhZGF0YSB8IHVuZGVmaW5lZCB7XG5cdFx0Y29uc3QgdGFyZ2V0ID0gdGhpcy5yZXN1bHQ/LmRldGFpbHM/LnRhcmdldDtcblx0XHRpZiAodGFyZ2V0ICYmIHR5cGVvZiB0YXJnZXQgPT09IFwib2JqZWN0XCIpIHJldHVybiB0YXJnZXQ7XG5cdFx0cmV0dXJuIGRpcmVjdERldGFpbHNUYXJnZXQodGhpcy5yZXN1bHQ/LmRldGFpbHMsIHRoaXMubm9ybWFsaXplZFRvb2xOYW1lKTtcblx0fVxuXG5cdHByaXZhdGUgZ2V0Q29tcGFjdFRhcmdldCgpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuXHRcdGNvbnN0IG1ldGFkYXRhID0gdGhpcy5nZXRUYXJnZXRNZXRhZGF0YSgpO1xuXHRcdGNvbnN0IG1ldGFkYXRhVGFyZ2V0ID0gbWV0YWRhdGEgPyBmb3JtYXRUb29sVGFyZ2V0KG1ldGFkYXRhKSA6IHVuZGVmaW5lZDtcblx0XHRpZiAobWV0YWRhdGFUYXJnZXQpIHJldHVybiBtZXRhZGF0YVRhcmdldDtcblxuXHRcdGNvbnN0IHBhdGggPSBmaXJzdFN0cmluZ0FyZyh0aGlzLmFyZ3MgPz8ge30sIFtcImZpbGVfcGF0aFwiLCBcInBhdGhcIiwgXCJub3RlYm9va19wYXRoXCJdKTtcblx0XHRpZiAocGF0aCA9PT0gbnVsbCkgcmV0dXJuIHVuZGVmaW5lZDtcblx0XHRpZiAodGhpcy5ub3JtYWxpemVkVG9vbE5hbWUgPT09IFwicmVhZFwiIHx8IHRoaXMubm9ybWFsaXplZFRvb2xOYW1lID09PSBcImhhc2hsaW5lX3JlYWRcIikge1xuXHRcdFx0cmV0dXJuIGZvcm1hdEFyZ3NQYXRoVGFyZ2V0KHBhdGgsIHRoaXMuYXJncyk7XG5cdFx0fVxuXHRcdGlmICh0aGlzLm5vcm1hbGl6ZWRUb29sTmFtZSA9PT0gXCJ3cml0ZVwiIHx8IHRoaXMubm9ybWFsaXplZFRvb2xOYW1lID09PSBcImVkaXRcIikge1xuXHRcdFx0cmV0dXJuIHBhdGggPyBzaG9ydGVuUGF0aChwYXRoKSA6IHVuZGVmaW5lZDtcblx0XHR9XG5cdFx0aWYgKHRoaXMubm9ybWFsaXplZFRvb2xOYW1lID09PSBcImxzXCIpIHtcblx0XHRcdHJldHVybiBwYXRoID8gc2hvcnRlblBhdGgocGF0aCkgOiB1bmRlZmluZWQ7XG5cdFx0fVxuXHRcdGlmICh0aGlzLm5vcm1hbGl6ZWRUb29sTmFtZSA9PT0gXCJmaW5kXCIpIHtcblx0XHRcdGNvbnN0IHBhdHRlcm4gPSBzdHIodGhpcy5hcmdzPy5wYXR0ZXJuKTtcblx0XHRcdGlmIChwYXR0ZXJuKSByZXR1cm4gcGF0aCA/IGAke3BhdHRlcm59IGluICR7c2hvcnRlblBhdGgocGF0aCl9YCA6IHBhdHRlcm47XG5cdFx0XHRyZXR1cm4gcGF0aCA/IHNob3J0ZW5QYXRoKHBhdGgpIDogdW5kZWZpbmVkO1xuXHRcdH1cblx0XHRpZiAodGhpcy5ub3JtYWxpemVkVG9vbE5hbWUgPT09IFwiZ3JlcFwiKSB7XG5cdFx0XHRjb25zdCBwYXR0ZXJuID0gc3RyKHRoaXMuYXJncz8ucGF0dGVybik7XG5cdFx0XHRjb25zdCBnbG9iID0gc3RyKHRoaXMuYXJncz8uZ2xvYik7XG5cdFx0XHRjb25zdCBsYWJlbCA9IHBhdHRlcm4gPyAocGF0aCA/IGAke3BhdHRlcm59IGluICR7c2hvcnRlblBhdGgocGF0aCl9YCA6IHBhdHRlcm4pIDogcGF0aCA/IHNob3J0ZW5QYXRoKHBhdGgpIDogdW5kZWZpbmVkO1xuXHRcdFx0aWYgKCFsYWJlbCkgcmV0dXJuIGdsb2IgfHwgdW5kZWZpbmVkO1xuXHRcdFx0cmV0dXJuIGdsb2IgPyBgJHtsYWJlbH0gKCR7Z2xvYn0pYCA6IGxhYmVsO1xuXHRcdH1cblx0XHRyZXR1cm4gdW5kZWZpbmVkO1xuXHR9XG5cblx0cHJpdmF0ZSB1cGRhdGVEaXNwbGF5KCk6IHZvaWQge1xuXHRcdC8vIFRvb2wgYm9keSBub3cgdXNlcyB0cmFuc3BhcmVudCBiYWNrZ3JvdW5kOyBzdGF0dXMgaXMgY29udmV5ZWQgaW4gdGhlIGZyYW1lIGhlYWRlci5cblx0XHRjb25zdCBiZ0ZuID0gKHRleHQ6IHN0cmluZykgPT4gdGV4dDtcblxuXHRcdGNvbnN0IHVzZUJ1aWx0SW5SZW5kZXJlciA9IHRoaXMuc2hvdWxkVXNlQnVpbHRJblJlbmRlcmVyKCk7XG5cdFx0bGV0IGN1c3RvbVJlbmRlcmVySGFzQ29udGVudCA9IGZhbHNlO1xuXHRcdHRoaXMuaGlkZUNvbXBvbmVudCA9IGZhbHNlO1xuXG5cdFx0Ly8gVXNlIGJ1aWx0LWluIHJlbmRlcmluZyBmb3IgYnVpbHQtaW4gdG9vbHMgKG9yIG92ZXJyaWRlcyB3aXRob3V0IGN1c3RvbSByZW5kZXJlcnMpXG5cdFx0aWYgKHVzZUJ1aWx0SW5SZW5kZXJlcikge1xuXHRcdFx0aWYgKHRoaXMubm9ybWFsaXplZFRvb2xOYW1lID09PSBcImJhc2hcIikge1xuXHRcdFx0XHQvLyBCYXNoIHVzZXMgQm94IHdpdGggdmlzdWFsIGxpbmUgdHJ1bmNhdGlvblxuXHRcdFx0XHR0aGlzLmNvbnRlbnRCb3guc2V0QmdGbihiZ0ZuKTtcblx0XHRcdFx0dGhpcy5jb250ZW50Qm94LmNsZWFyKCk7XG5cdFx0XHRcdHRoaXMucmVuZGVyQmFzaENvbnRlbnQoKTtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdC8vIE90aGVyIGJ1aWx0LWluIHRvb2xzOiB1c2UgVGV4dCBkaXJlY3RseSB3aXRoIGNhY2hpbmdcblx0XHRcdFx0dGhpcy5jb250ZW50VGV4dC5zZXRDdXN0b21CZ0ZuKGJnRm4pO1xuXHRcdFx0XHR0aGlzLmNvbnRlbnRUZXh0LnNldFRleHQodGhpcy5mb3JtYXRUb29sRXhlY3V0aW9uKCkpO1xuXHRcdFx0fVxuXHRcdH0gZWxzZSBpZiAodGhpcy50b29sRGVmaW5pdGlvbikge1xuXHRcdFx0Ly8gQ3VzdG9tIHRvb2xzIHVzZSBCb3ggZm9yIGZsZXhpYmxlIGNvbXBvbmVudCByZW5kZXJpbmdcblx0XHRcdHRoaXMuY29udGVudEJveC5zZXRCZ0ZuKGJnRm4pO1xuXHRcdFx0dGhpcy5jb250ZW50Qm94LmNsZWFyKCk7XG5cblx0XHRcdC8vIFJlbmRlciBjYWxsIGNvbXBvbmVudFxuXHRcdFx0aWYgKHRoaXMudG9vbERlZmluaXRpb24ucmVuZGVyQ2FsbCkge1xuXHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdGNvbnN0IGNhbGxDb21wb25lbnQgPSB0aGlzLnRvb2xEZWZpbml0aW9uLnJlbmRlckNhbGwodGhpcy5hcmdzLCB0aGVtZSk7XG5cdFx0XHRcdFx0aWYgKGNhbGxDb21wb25lbnQgIT09IHVuZGVmaW5lZCkge1xuXHRcdFx0XHRcdFx0dGhpcy5jb250ZW50Qm94LmFkZENoaWxkKGNhbGxDb21wb25lbnQpO1xuXHRcdFx0XHRcdFx0Y3VzdG9tUmVuZGVyZXJIYXNDb250ZW50ID0gdHJ1ZTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH0gY2F0Y2gge1xuXHRcdFx0XHRcdC8vIEZhbGwgYmFjayB0byBkZWZhdWx0IG9uIGVycm9yXG5cdFx0XHRcdFx0dGhpcy5jb250ZW50Qm94LmFkZENoaWxkKFxuXHRcdFx0XHRcdFx0bmV3IFRleHQoXG5cdFx0XHRcdFx0XHRcdHRoZW1lLmZnKFxuXHRcdFx0XHRcdFx0XHRcdFwidG9vbFRpdGxlXCIsXG5cdFx0XHRcdFx0XHRcdFx0dGhlbWUuYm9sZChwcmV0dGlmeVRvb2xOYW1lKHRoaXMudG9vbE5hbWUsIHRoaXMudG9vbERlZmluaXRpb24/LmxhYmVsKSksXG5cdFx0XHRcdFx0XHRcdCksXG5cdFx0XHRcdFx0XHRcdDAsXG5cdFx0XHRcdFx0XHRcdDAsXG5cdFx0XHRcdFx0XHQpLFxuXHRcdFx0XHRcdCk7XG5cdFx0XHRcdFx0Y3VzdG9tUmVuZGVyZXJIYXNDb250ZW50ID0gdHJ1ZTtcblx0XHRcdFx0fVxuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0Ly8gTm8gY3VzdG9tIHJlbmRlckNhbGwsIHNob3cgcHJldHRpZmllZCB0b29sIG5hbWVcblx0XHRcdFx0dGhpcy5jb250ZW50Qm94LmFkZENoaWxkKFxuXHRcdFx0XHRcdG5ldyBUZXh0KFxuXHRcdFx0XHRcdFx0dGhlbWUuZmcoXG5cdFx0XHRcdFx0XHRcdFwidG9vbFRpdGxlXCIsXG5cdFx0XHRcdFx0XHRcdHRoZW1lLmJvbGQocHJldHRpZnlUb29sTmFtZSh0aGlzLnRvb2xOYW1lLCB0aGlzLnRvb2xEZWZpbml0aW9uPy5sYWJlbCkpLFxuXHRcdFx0XHRcdFx0KSxcblx0XHRcdFx0XHRcdDAsXG5cdFx0XHRcdFx0XHQwLFxuXHRcdFx0XHRcdCksXG5cdFx0XHRcdCk7XG5cdFx0XHRcdGN1c3RvbVJlbmRlcmVySGFzQ29udGVudCA9IHRydWU7XG5cdFx0XHR9XG5cblx0XHRcdC8vIFJlbmRlciByZXN1bHQgY29tcG9uZW50IGlmIHdlIGhhdmUgYSByZXN1bHRcblx0XHRcdGlmICh0aGlzLnJlc3VsdCAmJiB0aGlzLnRvb2xEZWZpbml0aW9uLnJlbmRlclJlc3VsdCkge1xuXHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdGNvbnN0IHJlbmRlcmVyUmVzdWx0ID0ge1xuXHRcdFx0XHRcdFx0Y29udGVudDogdGhpcy5yZXN1bHQuY29udGVudCBhcyBhbnksXG5cdFx0XHRcdFx0XHRkZXRhaWxzOiB0aGlzLnJlc3VsdC5kZXRhaWxzLFxuXHRcdFx0XHRcdFx0aXNFcnJvcjogdGhpcy5yZXN1bHQuaXNFcnJvcixcblx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdGNvbnN0IHJlc3VsdENvbXBvbmVudCA9IHRoaXMudG9vbERlZmluaXRpb24ucmVuZGVyUmVzdWx0KFxuXHRcdFx0XHRcdFx0cmVuZGVyZXJSZXN1bHQsXG5cdFx0XHRcdFx0XHR7IGV4cGFuZGVkOiB0aGlzLmV4cGFuZGVkLCBpc1BhcnRpYWw6IHRoaXMuaXNQYXJ0aWFsIH0sXG5cdFx0XHRcdFx0XHR0aGVtZSxcblx0XHRcdFx0XHQpO1xuXHRcdFx0XHRcdGlmIChyZXN1bHRDb21wb25lbnQgIT09IHVuZGVmaW5lZCkge1xuXHRcdFx0XHRcdFx0dGhpcy5jb250ZW50Qm94LmFkZENoaWxkKHJlc3VsdENvbXBvbmVudCk7XG5cdFx0XHRcdFx0XHRjdXN0b21SZW5kZXJlckhhc0NvbnRlbnQgPSB0cnVlO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fSBjYXRjaCB7XG5cdFx0XHRcdFx0Ly8gRmFsbCBiYWNrIHRvIHNob3dpbmcgcmF3IG91dHB1dCBvbiBlcnJvclxuXHRcdFx0XHRcdGNvbnN0IG91dHB1dCA9IHRoaXMuZ2V0VGV4dE91dHB1dCgpO1xuXHRcdFx0XHRcdGlmIChvdXRwdXQpIHtcblx0XHRcdFx0XHRcdHRoaXMuY29udGVudEJveC5hZGRDaGlsZChuZXcgVGV4dCh0aGVtZS5mZyhcInRvb2xPdXRwdXRcIiwgb3V0cHV0KSwgMCwgMCkpO1xuXHRcdFx0XHRcdFx0Y3VzdG9tUmVuZGVyZXJIYXNDb250ZW50ID0gdHJ1ZTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblx0XHRcdH0gZWxzZSBpZiAodGhpcy5yZXN1bHQpIHtcblx0XHRcdFx0Ly8gSGFzIHJlc3VsdCBidXQgbm8gY3VzdG9tIHJlbmRlclJlc3VsdFxuXHRcdFx0XHRjb25zdCBvdXRwdXQgPSB0aGlzLmdldFRleHRPdXRwdXQoKTtcblx0XHRcdFx0aWYgKG91dHB1dCkge1xuXHRcdFx0XHRcdHRoaXMuY29udGVudEJveC5hZGRDaGlsZChuZXcgVGV4dCh0aGVtZS5mZyhcInRvb2xPdXRwdXRcIiwgb3V0cHV0KSwgMCwgMCkpO1xuXHRcdFx0XHRcdGN1c3RvbVJlbmRlcmVySGFzQ29udGVudCA9IHRydWU7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9IGVsc2Uge1xuXHRcdFx0Ly8gVW5rbm93biB0b29sIHdpdGggbm8gcmVnaXN0ZXJlZCBkZWZpbml0aW9uIC0gc2hvdyBnZW5lcmljIGZhbGxiYWNrXG5cdFx0XHR0aGlzLmNvbnRlbnRUZXh0LnNldEN1c3RvbUJnRm4oYmdGbik7XG5cdFx0XHR0aGlzLmNvbnRlbnRUZXh0LnNldFRleHQodGhpcy5mb3JtYXRUb29sRXhlY3V0aW9uKCkpO1xuXHRcdH1cblxuXHRcdC8vIEhhbmRsZSBpbWFnZXMgKHNhbWUgZm9yIGJvdGggY3VzdG9tIGFuZCBidWlsdC1pbilcblx0XHRmb3IgKGNvbnN0IGltZyBvZiB0aGlzLmltYWdlQ29tcG9uZW50cykge1xuXHRcdFx0dGhpcy5yZW1vdmVDaGlsZChpbWcpO1xuXHRcdH1cblx0XHR0aGlzLmltYWdlQ29tcG9uZW50cyA9IFtdO1xuXHRcdGZvciAoY29uc3Qgc3BhY2VyIG9mIHRoaXMuaW1hZ2VTcGFjZXJzKSB7XG5cdFx0XHR0aGlzLnJlbW92ZUNoaWxkKHNwYWNlcik7XG5cdFx0fVxuXHRcdHRoaXMuaW1hZ2VTcGFjZXJzID0gW107XG5cblx0XHRpZiAodGhpcy5yZXN1bHQpIHtcblx0XHRcdGNvbnN0IGltYWdlQmxvY2tzID0gdGhpcy5yZXN1bHQuY29udGVudD8uZmlsdGVyKChjOiBhbnkpID0+IGMudHlwZSA9PT0gXCJpbWFnZVwiKSB8fCBbXTtcblx0XHRcdGNvbnN0IGNhcHMgPSBnZXRDYXBhYmlsaXRpZXMoKTtcblxuXHRcdFx0Zm9yIChsZXQgaSA9IDA7IGkgPCBpbWFnZUJsb2Nrcy5sZW5ndGg7IGkrKykge1xuXHRcdFx0XHRjb25zdCBpbWcgPSBpbWFnZUJsb2Nrc1tpXTtcblx0XHRcdFx0aWYgKGNhcHMuaW1hZ2VzICYmIHRoaXMuc2hvd0ltYWdlcyAmJiBpbWcuZGF0YSAmJiBpbWcubWltZVR5cGUpIHtcblx0XHRcdFx0XHQvLyBVc2UgY29udmVydGVkIFBORyBmb3IgS2l0dHkgcHJvdG9jb2wgaWYgYXZhaWxhYmxlXG5cdFx0XHRcdFx0Y29uc3QgY29udmVydGVkID0gdGhpcy5jb252ZXJ0ZWRJbWFnZXMuZ2V0KGkpO1xuXHRcdFx0XHRcdGNvbnN0IGltYWdlRGF0YSA9IGNvbnZlcnRlZD8uZGF0YSA/PyBpbWcuZGF0YTtcblx0XHRcdFx0XHRjb25zdCBpbWFnZU1pbWVUeXBlID0gY29udmVydGVkPy5taW1lVHlwZSA/PyBpbWcubWltZVR5cGU7XG5cblx0XHRcdFx0XHQvLyBGb3IgS2l0dHksIHNraXAgbm9uLVBORyBpbWFnZXMgdGhhdCBoYXZlbid0IGJlZW4gY29udmVydGVkIHlldFxuXHRcdFx0XHRcdGlmIChjYXBzLmltYWdlcyA9PT0gXCJraXR0eVwiICYmIGltYWdlTWltZVR5cGUgIT09IFwiaW1hZ2UvcG5nXCIpIHtcblx0XHRcdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdGNvbnN0IHNwYWNlciA9IG5ldyBTcGFjZXIoMSk7XG5cdFx0XHRcdFx0dGhpcy5hZGRDaGlsZChzcGFjZXIpO1xuXHRcdFx0XHRcdHRoaXMuaW1hZ2VTcGFjZXJzLnB1c2goc3BhY2VyKTtcblx0XHRcdFx0XHQvLyBQYXNzIGNhY2hlZCBkaW1lbnNpb25zIHRvIGF2b2lkIHJlLXRyaWdnZXJpbmcgYXN5bmMgcGFyc2luZ1xuXHRcdFx0XHRcdC8vIHdoZW4gdXBkYXRlRGlzcGxheSgpIHJlY3JlYXRlcyBJbWFnZSBjb21wb25lbnRzICgjMzQ1NSkuXG5cdFx0XHRcdFx0Y29uc3QgY2FjaGVkRGltcyA9IHRoaXMucmVzb2x2ZWRJbWFnZURpbWVuc2lvbnMuZ2V0KGkpO1xuXHRcdFx0XHRcdGNvbnN0IGltYWdlQ29tcG9uZW50ID0gbmV3IEltYWdlKFxuXHRcdFx0XHRcdFx0aW1hZ2VEYXRhLFxuXHRcdFx0XHRcdFx0aW1hZ2VNaW1lVHlwZSxcblx0XHRcdFx0XHRcdHsgZmFsbGJhY2tDb2xvcjogKHM6IHN0cmluZykgPT4gdGhlbWUuZmcoXCJ0b29sT3V0cHV0XCIsIHMpIH0sXG5cdFx0XHRcdFx0XHR7IG1heFdpZHRoQ2VsbHM6IDYwIH0sXG5cdFx0XHRcdFx0XHRjYWNoZWREaW1zLFxuXHRcdFx0XHRcdCk7XG5cdFx0XHRcdFx0aWYgKCFjYWNoZWREaW1zKSB7XG5cdFx0XHRcdFx0XHRjb25zdCBpbWdJZHggPSBpO1xuXHRcdFx0XHRcdFx0aW1hZ2VDb21wb25lbnQuc2V0T25EaW1lbnNpb25zUmVzb2x2ZWQoKCkgPT4ge1xuXHRcdFx0XHRcdFx0XHQvLyBDYWNoZSByZXNvbHZlZCBkaW1lbnNpb25zIHNvIGZ1dHVyZSB1cGRhdGVEaXNwbGF5KCkgY2FsbHNcblx0XHRcdFx0XHRcdFx0Ly8gZG9uJ3QgcmUtdHJpZ2dlciBhc3luYyBwYXJzaW5nIFx1MjE5MiBpbmZpbml0ZSBsb29wICgjMzQ1NSkuXG5cdFx0XHRcdFx0XHRcdGNvbnN0IGRpbXMgPSBpbWFnZUNvbXBvbmVudC5nZXREaW1lbnNpb25zPy4oKTtcblx0XHRcdFx0XHRcdFx0aWYgKGRpbXMpIHRoaXMucmVzb2x2ZWRJbWFnZURpbWVuc2lvbnMuc2V0KGltZ0lkeCwgZGltcyk7XG5cdFx0XHRcdFx0XHRcdC8vIEp1c3QgcmUtcmVuZGVyIFx1MjAxNCBkb24ndCBjYWxsIHVwZGF0ZURpc3BsYXkoKSB3aGljaCB3b3VsZFxuXHRcdFx0XHRcdFx0XHQvLyBkZXN0cm95IGFuZCByZWNyZWF0ZSBhbGwgSW1hZ2UgY29tcG9uZW50cy5cblx0XHRcdFx0XHRcdFx0dGhpcy51aS5yZXF1ZXN0UmVuZGVyKCk7XG5cdFx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0dGhpcy5pbWFnZUNvbXBvbmVudHMucHVzaChpbWFnZUNvbXBvbmVudCk7XG5cdFx0XHRcdFx0dGhpcy5hZGRDaGlsZChpbWFnZUNvbXBvbmVudCk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9XG5cblx0XHRpZiAoIXVzZUJ1aWx0SW5SZW5kZXJlciAmJiB0aGlzLnRvb2xEZWZpbml0aW9uKSB7XG5cdFx0XHR0aGlzLmhpZGVDb21wb25lbnQgPSAhY3VzdG9tUmVuZGVyZXJIYXNDb250ZW50ICYmIHRoaXMuaW1hZ2VDb21wb25lbnRzLmxlbmd0aCA9PT0gMDtcblx0XHR9XG5cdH1cblxuXHQvKipcblx0ICogUmVuZGVyIGJhc2ggY29udGVudCB1c2luZyB2aXN1YWwgbGluZSB0cnVuY2F0aW9uIChsaWtlIGJhc2gtZXhlY3V0aW9uLnRzKVxuXHQgKi9cblx0cHJpdmF0ZSByZW5kZXJCYXNoQ29udGVudCgpOiB2b2lkIHtcblx0XHRjb25zdCBjb21tYW5kID0gc3RyKHRoaXMuYXJncz8uY29tbWFuZCk7XG5cdFx0Y29uc3QgdGltZW91dCA9IHRoaXMuYXJncz8udGltZW91dCBhcyBudW1iZXIgfCB1bmRlZmluZWQ7XG5cblx0XHQvLyBIZWFkZXJcblx0XHRjb25zdCB0aW1lb3V0U3VmZml4ID0gdGltZW91dCA/IHRoZW1lLmZnKFwibXV0ZWRcIiwgYCAodGltZW91dCAke3RpbWVvdXR9cylgKSA6IFwiXCI7XG5cdFx0Y29uc3QgY29tbWFuZERpc3BsYXkgPVxuXHRcdFx0Y29tbWFuZCA9PT0gbnVsbCA/IHRoZW1lLmZnKFwiZXJyb3JcIiwgXCJbaW52YWxpZCBhcmddXCIpIDogY29tbWFuZCA/IGNvbW1hbmQgOiB0aGVtZS5mZyhcInRvb2xPdXRwdXRcIiwgXCIuLi5cIik7XG5cdFx0dGhpcy5jb250ZW50Qm94LmFkZENoaWxkKFxuXHRcdFx0bmV3IFRleHQodGhlbWUuZmcoXCJ0b29sVGl0bGVcIiwgdGhlbWUuYm9sZChgJCAke2NvbW1hbmREaXNwbGF5fWApKSArIHRpbWVvdXRTdWZmaXgsIDAsIDApLFxuXHRcdCk7XG5cblx0XHRpZiAodGhpcy5yZXN1bHQpIHtcblx0XHRcdGNvbnN0IG91dHB1dCA9IHRoaXMuZ2V0VGV4dE91dHB1dCgpLnRyaW0oKTtcblxuXHRcdFx0aWYgKG91dHB1dCkge1xuXHRcdFx0XHQvLyBTdHlsZSBlYWNoIGxpbmUgZm9yIHRoZSBvdXRwdXRcblx0XHRcdFx0Y29uc3Qgc3R5bGVkT3V0cHV0ID0gb3V0cHV0XG5cdFx0XHRcdFx0LnNwbGl0KFwiXFxuXCIpXG5cdFx0XHRcdFx0Lm1hcCgobGluZSkgPT4gdGhlbWUuZmcoXCJ0b29sT3V0cHV0XCIsIGxpbmUpKVxuXHRcdFx0XHRcdC5qb2luKFwiXFxuXCIpO1xuXG5cdFx0XHRcdGlmICh0aGlzLmV4cGFuZGVkKSB7XG5cdFx0XHRcdFx0Ly8gU2hvdyBhbGwgbGluZXMgd2hlbiBleHBhbmRlZFxuXHRcdFx0XHRcdHRoaXMuY29udGVudEJveC5hZGRDaGlsZChuZXcgVGV4dChgXFxuJHtzdHlsZWRPdXRwdXR9YCwgMCwgMCkpO1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdC8vIFVzZSB2aXN1YWwgbGluZSB0cnVuY2F0aW9uIHdoZW4gY29sbGFwc2VkIHdpdGggd2lkdGgtYXdhcmUgY2FjaGluZ1xuXHRcdFx0XHRcdGxldCBjYWNoZWRXaWR0aDogbnVtYmVyIHwgdW5kZWZpbmVkO1xuXHRcdFx0XHRcdGxldCBjYWNoZWRMaW5lczogc3RyaW5nW10gfCB1bmRlZmluZWQ7XG5cdFx0XHRcdFx0bGV0IGNhY2hlZFNraXBwZWQ6IG51bWJlciB8IHVuZGVmaW5lZDtcblxuXHRcdFx0XHRcdHRoaXMuY29udGVudEJveC5hZGRDaGlsZCh7XG5cdFx0XHRcdFx0XHRyZW5kZXI6ICh3aWR0aDogbnVtYmVyKSA9PiB7XG5cdFx0XHRcdFx0XHRcdGlmIChjYWNoZWRMaW5lcyA9PT0gdW5kZWZpbmVkIHx8IGNhY2hlZFdpZHRoICE9PSB3aWR0aCkge1xuXHRcdFx0XHRcdFx0XHRcdGNvbnN0IHJlc3VsdCA9IHRydW5jYXRlVG9WaXN1YWxMaW5lcyhzdHlsZWRPdXRwdXQsIEJBU0hfUFJFVklFV19MSU5FUywgd2lkdGgpO1xuXHRcdFx0XHRcdFx0XHRcdGNhY2hlZExpbmVzID0gcmVzdWx0LnZpc3VhbExpbmVzO1xuXHRcdFx0XHRcdFx0XHRcdGNhY2hlZFNraXBwZWQgPSByZXN1bHQuc2tpcHBlZENvdW50O1xuXHRcdFx0XHRcdFx0XHRcdGNhY2hlZFdpZHRoID0gd2lkdGg7XG5cdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0aWYgKGNhY2hlZFNraXBwZWQgJiYgY2FjaGVkU2tpcHBlZCA+IDApIHtcblx0XHRcdFx0XHRcdFx0XHRjb25zdCBoaW50ID1cblx0XHRcdFx0XHRcdFx0XHRcdHRoZW1lLmZnKFwibXV0ZWRcIiwgYC4uLiAoJHtjYWNoZWRTa2lwcGVkfSBlYXJsaWVyIGxpbmVzLGApICtcblx0XHRcdFx0XHRcdFx0XHRcdGAgJHtrZXlIaW50KFwiZXhwYW5kVG9vbHNcIiwgXCJ0byBleHBhbmRcIil9KWA7XG5cdFx0XHRcdFx0XHRcdFx0cmV0dXJuIFtcIlwiLCB0cnVuY2F0ZVRvV2lkdGgoaGludCwgd2lkdGgsIFwiLi4uXCIpLCAuLi5jYWNoZWRMaW5lc107XG5cdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0Ly8gQWRkIGJsYW5rIGxpbmUgZm9yIHNwYWNpbmcgKG1hdGNoZXMgZXhwYW5kZWQgY2FzZSlcblx0XHRcdFx0XHRcdFx0cmV0dXJuIFtcIlwiLCAuLi5jYWNoZWRMaW5lc107XG5cdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdFx0aW52YWxpZGF0ZTogKCkgPT4ge1xuXHRcdFx0XHRcdFx0XHRjYWNoZWRXaWR0aCA9IHVuZGVmaW5lZDtcblx0XHRcdFx0XHRcdFx0Y2FjaGVkTGluZXMgPSB1bmRlZmluZWQ7XG5cdFx0XHRcdFx0XHRcdGNhY2hlZFNraXBwZWQgPSB1bmRlZmluZWQ7XG5cdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdH0pO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdC8vIFRydW5jYXRpb24gd2FybmluZ3Ncblx0XHRcdGNvbnN0IHRydW5jYXRpb24gPSB0aGlzLnJlc3VsdC5kZXRhaWxzPy50cnVuY2F0aW9uO1xuXHRcdFx0Y29uc3QgZnVsbE91dHB1dFBhdGggPSB0aGlzLnJlc3VsdC5kZXRhaWxzPy5mdWxsT3V0cHV0UGF0aDtcblx0XHRcdGNvbnN0IGN3ZCA9IHRoaXMucmVzdWx0LmRldGFpbHM/LmN3ZDtcblx0XHRcdGlmICh0aGlzLmV4cGFuZGVkICYmIHR5cGVvZiBjd2QgPT09IFwic3RyaW5nXCIgJiYgY3dkLmxlbmd0aCA+IDApIHtcblx0XHRcdFx0dGhpcy5jb250ZW50Qm94LmFkZENoaWxkKG5ldyBUZXh0KGBcXG4ke3RoZW1lLmZnKFwibXV0ZWRcIiwgYGN3ZCAke3Nob3J0ZW5QYXRoKGN3ZCl9YCl9YCwgMCwgMCkpO1xuXHRcdFx0fVxuXHRcdFx0aWYgKHRydW5jYXRpb24/LnRydW5jYXRlZCB8fCBmdWxsT3V0cHV0UGF0aCkge1xuXHRcdFx0XHRjb25zdCB3YXJuaW5nczogc3RyaW5nW10gPSBbXTtcblx0XHRcdFx0aWYgKGZ1bGxPdXRwdXRQYXRoKSB7XG5cdFx0XHRcdFx0d2FybmluZ3MucHVzaChgRnVsbCBvdXRwdXQ6ICR7ZnVsbE91dHB1dFBhdGh9YCk7XG5cdFx0XHRcdH1cblx0XHRcdFx0aWYgKHRydW5jYXRpb24/LnRydW5jYXRlZCkge1xuXHRcdFx0XHRcdGlmICh0cnVuY2F0aW9uLnRydW5jYXRlZEJ5ID09PSBcImxpbmVzXCIpIHtcblx0XHRcdFx0XHRcdHdhcm5pbmdzLnB1c2goYFRydW5jYXRlZDogc2hvd2luZyAke3RydW5jYXRpb24ub3V0cHV0TGluZXN9IG9mICR7dHJ1bmNhdGlvbi50b3RhbExpbmVzfSBsaW5lc2ApO1xuXHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHR3YXJuaW5ncy5wdXNoKFxuXHRcdFx0XHRcdFx0XHRgVHJ1bmNhdGVkOiAke3RydW5jYXRpb24ub3V0cHV0TGluZXN9IGxpbmVzIHNob3duICgke2Zvcm1hdFNpemUodHJ1bmNhdGlvbi5tYXhCeXRlcyA/PyBERUZBVUxUX01BWF9CWVRFUyl9IGxpbWl0KWAsXG5cdFx0XHRcdFx0XHQpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXHRcdFx0XHR0aGlzLmNvbnRlbnRCb3guYWRkQ2hpbGQobmV3IFRleHQoYFxcbiR7dGhlbWUuZmcoXCJ3YXJuaW5nXCIsIGBbJHt3YXJuaW5ncy5qb2luKFwiLiBcIil9XWApfWAsIDAsIDApKTtcblx0XHRcdH1cblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIGdldFRleHRPdXRwdXQoKTogc3RyaW5nIHtcblx0XHRpZiAoIXRoaXMucmVzdWx0KSByZXR1cm4gXCJcIjtcblxuXHRcdGNvbnN0IHRleHRCbG9ja3MgPSB0aGlzLnJlc3VsdC5jb250ZW50Py5maWx0ZXIoKGM6IGFueSkgPT4gYy50eXBlID09PSBcInRleHRcIikgfHwgW107XG5cdFx0Y29uc3QgaW1hZ2VCbG9ja3MgPSB0aGlzLnJlc3VsdC5jb250ZW50Py5maWx0ZXIoKGM6IGFueSkgPT4gYy50eXBlID09PSBcImltYWdlXCIpIHx8IFtdO1xuXG5cdFx0bGV0IG91dHB1dCA9IHRleHRCbG9ja3Ncblx0XHRcdC5tYXAoKGM6IGFueSkgPT4ge1xuXHRcdFx0XHQvLyBVc2Ugc2FuaXRpemVCaW5hcnlPdXRwdXQgdG8gaGFuZGxlIGJpbmFyeSBkYXRhIHRoYXQgY3Jhc2hlcyBzdHJpbmctd2lkdGhcblx0XHRcdFx0cmV0dXJuIHNhbml0aXplQmluYXJ5T3V0cHV0KHN0cmlwQW5zaShjLnRleHQgfHwgXCJcIikpLnJlcGxhY2UoL1xcci9nLCBcIlwiKTtcblx0XHRcdH0pXG5cdFx0XHQuam9pbihcIlxcblwiKTtcblxuXHRcdGNvbnN0IGNhcHMgPSBnZXRDYXBhYmlsaXRpZXMoKTtcblx0XHRpZiAoaW1hZ2VCbG9ja3MubGVuZ3RoID4gMCAmJiAoIWNhcHMuaW1hZ2VzIHx8ICF0aGlzLnNob3dJbWFnZXMpKSB7XG5cdFx0XHRjb25zdCBpbWFnZUluZGljYXRvcnMgPSBpbWFnZUJsb2Nrc1xuXHRcdFx0XHQubWFwKChpbWc6IGFueSkgPT4ge1xuXHRcdFx0XHRcdHJldHVybiBpbWFnZUZhbGxiYWNrKGltZy5taW1lVHlwZSk7XG5cdFx0XHRcdH0pXG5cdFx0XHRcdC5qb2luKFwiXFxuXCIpO1xuXHRcdFx0b3V0cHV0ID0gb3V0cHV0ID8gYCR7b3V0cHV0fVxcbiR7aW1hZ2VJbmRpY2F0b3JzfWAgOiBpbWFnZUluZGljYXRvcnM7XG5cdFx0fVxuXG5cdFx0cmV0dXJuIG91dHB1dDtcblx0fVxuXG5cdHByaXZhdGUgZm9ybWF0VG9vbEV4ZWN1dGlvbigpOiBzdHJpbmcge1xuXHRcdGxldCB0ZXh0ID0gXCJcIjtcblx0XHRjb25zdCBpbnZhbGlkQXJnID0gdGhlbWUuZmcoXCJlcnJvclwiLCBcIltpbnZhbGlkIGFyZ11cIik7XG5cdFx0Y29uc3Qgbm9ybWFsaXplZFRvb2xOYW1lID0gdGhpcy5ub3JtYWxpemVkVG9vbE5hbWU7XG5cblx0XHRpZiAobm9ybWFsaXplZFRvb2xOYW1lID09PSBcInJlYWRcIikge1xuXHRcdFx0Y29uc3QgcmF3UGF0aCA9IHN0cih0aGlzLmFyZ3M/LmZpbGVfcGF0aCA/PyB0aGlzLmFyZ3M/LnBhdGgpO1xuXHRcdFx0Y29uc3QgcGF0aCA9IHJhd1BhdGggIT09IG51bGwgPyBzaG9ydGVuUGF0aChyYXdQYXRoKSA6IG51bGw7XG5cdFx0XHRjb25zdCBvZmZzZXQgPSB0aGlzLmFyZ3M/Lm9mZnNldDtcblx0XHRcdGNvbnN0IGxpbWl0ID0gdGhpcy5hcmdzPy5saW1pdDtcblxuXHRcdFx0bGV0IHBhdGhEaXNwbGF5ID0gcGF0aCA9PT0gbnVsbCA/IGludmFsaWRBcmcgOiBwYXRoID8gdGhlbWUuZmcoXCJhY2NlbnRcIiwgcGF0aCkgOiB0aGVtZS5mZyhcInRvb2xPdXRwdXRcIiwgXCIuLi5cIik7XG5cdFx0XHRpZiAob2Zmc2V0ICE9PSB1bmRlZmluZWQgfHwgbGltaXQgIT09IHVuZGVmaW5lZCkge1xuXHRcdFx0XHRjb25zdCBzdGFydExpbmUgPSBvZmZzZXQgPz8gMTtcblx0XHRcdFx0Y29uc3QgZW5kTGluZSA9IGxpbWl0ICE9PSB1bmRlZmluZWQgPyBzdGFydExpbmUgKyBsaW1pdCAtIDEgOiBcIlwiO1xuXHRcdFx0XHRwYXRoRGlzcGxheSArPSB0aGVtZS5mZyhcIndhcm5pbmdcIiwgYDoke3N0YXJ0TGluZX0ke2VuZExpbmUgPyBgLSR7ZW5kTGluZX1gIDogXCJcIn1gKTtcblx0XHRcdH1cblxuXHRcdFx0dGV4dCA9IGAke3RoZW1lLmZnKFwidG9vbFRpdGxlXCIsIHRoZW1lLmJvbGQoXCJyZWFkXCIpKX0gJHtwYXRoRGlzcGxheX1gO1xuXG5cdFx0XHRpZiAodGhpcy5yZXN1bHQpIHtcblx0XHRcdFx0aWYgKHRoaXMucmVzdWx0LmlzRXJyb3IpIHtcblx0XHRcdFx0XHRjb25zdCBlcnJvclRleHQgPSB0aGlzLmdldFRleHRPdXRwdXQoKS50cmltKCkgfHwgXCJyZWFkIGZhaWxlZFwiO1xuXHRcdFx0XHRcdHRleHQgKz0gYFxcblxcbiR7dGhlbWUuZmcoXCJlcnJvclwiLCBlcnJvclRleHQpfWA7XG5cdFx0XHRcdFx0cmV0dXJuIHRleHQ7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRjb25zdCByYXdPdXRwdXQgPSB0aGlzLmdldFRleHRPdXRwdXQoKTtcblx0XHRcdFx0Ly8gU3RyaXAgaGFzaGxpbmUgcHJlZml4ZXMgKGUuZy4gXCIxI0JROmNvbnRlbnRcIikgZm9yIFRVSSBkaXNwbGF5XG5cdFx0XHRcdGNvbnN0IG91dHB1dCA9IHJhd091dHB1dC5yZXBsYWNlKC9eKFxccyopXFxkKyNbWlBNUVZSV1NOS1RYSkJZSF17Mn06L2dtLCBcIiQxXCIpO1xuXHRcdFx0XHRjb25zdCByYXdQYXRoID0gc3RyKHRoaXMuYXJncz8uZmlsZV9wYXRoID8/IHRoaXMuYXJncz8ucGF0aCk7XG5cdFx0XHRcdGNvbnN0IGxhbmcgPSByYXdQYXRoID8gZ2V0TGFuZ3VhZ2VGcm9tUGF0aChyYXdQYXRoKSA6IHVuZGVmaW5lZDtcblx0XHRcdFx0Y29uc3QgbGluZXMgPSBsYW5nID8gaGlnaGxpZ2h0Q29kZShyZXBsYWNlVGFicyhvdXRwdXQpLCBsYW5nKSA6IG91dHB1dC5zcGxpdChcIlxcblwiKTtcblxuXHRcdFx0XHRjb25zdCBtYXhMaW5lcyA9IHRoaXMuZXhwYW5kZWQgPyBsaW5lcy5sZW5ndGggOiAxMDtcblx0XHRcdFx0Y29uc3QgZGlzcGxheUxpbmVzID0gbGluZXMuc2xpY2UoMCwgbWF4TGluZXMpO1xuXHRcdFx0XHRjb25zdCByZW1haW5pbmcgPSBsaW5lcy5sZW5ndGggLSBtYXhMaW5lcztcblxuXHRcdFx0XHR0ZXh0ICs9XG5cdFx0XHRcdFx0XCJcXG5cXG5cIiArXG5cdFx0XHRcdFx0ZGlzcGxheUxpbmVzXG5cdFx0XHRcdFx0XHQubWFwKChsaW5lOiBzdHJpbmcpID0+IChsYW5nID8gcmVwbGFjZVRhYnMobGluZSkgOiB0aGVtZS5mZyhcInRvb2xPdXRwdXRcIiwgcmVwbGFjZVRhYnMobGluZSkpKSlcblx0XHRcdFx0XHRcdC5qb2luKFwiXFxuXCIpO1xuXHRcdFx0XHRpZiAocmVtYWluaW5nID4gMCkge1xuXHRcdFx0XHRcdHRleHQgKz0gYCR7dGhlbWUuZmcoXCJtdXRlZFwiLCBgXFxuLi4uICgke3JlbWFpbmluZ30gbW9yZSBsaW5lcyxgKX0gJHtrZXlIaW50KFwiZXhwYW5kVG9vbHNcIiwgXCJ0byBleHBhbmRcIil9KWA7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRjb25zdCB0cnVuY2F0aW9uID0gdGhpcy5yZXN1bHQuZGV0YWlscz8udHJ1bmNhdGlvbjtcblx0XHRcdFx0aWYgKHRydW5jYXRpb24/LnRydW5jYXRlZCkge1xuXHRcdFx0XHRcdGlmICh0cnVuY2F0aW9uLmZpcnN0TGluZUV4Y2VlZHNMaW1pdCkge1xuXHRcdFx0XHRcdFx0dGV4dCArPVxuXHRcdFx0XHRcdFx0XHRcIlxcblwiICtcblx0XHRcdFx0XHRcdFx0dGhlbWUuZmcoXG5cdFx0XHRcdFx0XHRcdFx0XCJ3YXJuaW5nXCIsXG5cdFx0XHRcdFx0XHRcdFx0YFtGaXJzdCBsaW5lIGV4Y2VlZHMgJHtmb3JtYXRTaXplKHRydW5jYXRpb24ubWF4Qnl0ZXMgPz8gREVGQVVMVF9NQVhfQllURVMpfSBsaW1pdF1gLFxuXHRcdFx0XHRcdFx0XHQpO1xuXHRcdFx0XHRcdH0gZWxzZSBpZiAodHJ1bmNhdGlvbi50cnVuY2F0ZWRCeSA9PT0gXCJsaW5lc1wiKSB7XG5cdFx0XHRcdFx0XHR0ZXh0ICs9XG5cdFx0XHRcdFx0XHRcdFwiXFxuXCIgK1xuXHRcdFx0XHRcdFx0XHR0aGVtZS5mZyhcblx0XHRcdFx0XHRcdFx0XHRcIndhcm5pbmdcIixcblx0XHRcdFx0XHRcdFx0XHRgW1RydW5jYXRlZDogc2hvd2luZyAke3RydW5jYXRpb24ub3V0cHV0TGluZXN9IG9mICR7dHJ1bmNhdGlvbi50b3RhbExpbmVzfSBsaW5lcyAoJHt0cnVuY2F0aW9uLm1heExpbmVzID8/IERFRkFVTFRfTUFYX0xJTkVTfSBsaW5lIGxpbWl0KV1gLFxuXHRcdFx0XHRcdFx0XHQpO1xuXHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHR0ZXh0ICs9XG5cdFx0XHRcdFx0XHRcdFwiXFxuXCIgK1xuXHRcdFx0XHRcdFx0XHR0aGVtZS5mZyhcblx0XHRcdFx0XHRcdFx0XHRcIndhcm5pbmdcIixcblx0XHRcdFx0XHRcdFx0XHRgW1RydW5jYXRlZDogJHt0cnVuY2F0aW9uLm91dHB1dExpbmVzfSBsaW5lcyBzaG93biAoJHtmb3JtYXRTaXplKHRydW5jYXRpb24ubWF4Qnl0ZXMgPz8gREVGQVVMVF9NQVhfQllURVMpfSBsaW1pdCldYCxcblx0XHRcdFx0XHRcdFx0KTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9IGVsc2UgaWYgKG5vcm1hbGl6ZWRUb29sTmFtZSA9PT0gXCJ3cml0ZVwiKSB7XG5cdFx0XHRjb25zdCByYXdQYXRoID0gc3RyKHRoaXMuYXJncz8uZmlsZV9wYXRoID8/IHRoaXMuYXJncz8ucGF0aCk7XG5cdFx0XHRjb25zdCBmaWxlQ29udGVudCA9IHN0cih0aGlzLmFyZ3M/LmNvbnRlbnQpO1xuXHRcdFx0Y29uc3QgcGF0aCA9IHJhd1BhdGggIT09IG51bGwgPyBzaG9ydGVuUGF0aChyYXdQYXRoKSA6IG51bGw7XG5cblx0XHRcdHRleHQgPVxuXHRcdFx0XHR0aGVtZS5mZyhcInRvb2xUaXRsZVwiLCB0aGVtZS5ib2xkKFwid3JpdGVcIikpICtcblx0XHRcdFx0XCIgXCIgK1xuXHRcdFx0XHQocGF0aCA9PT0gbnVsbCA/IGludmFsaWRBcmcgOiBwYXRoID8gdGhlbWUuZmcoXCJhY2NlbnRcIiwgcGF0aCkgOiB0aGVtZS5mZyhcInRvb2xPdXRwdXRcIiwgXCIuLi5cIikpO1xuXG5cdFx0XHRpZiAoZmlsZUNvbnRlbnQgPT09IG51bGwpIHtcblx0XHRcdFx0dGV4dCArPSBgXFxuXFxuJHt0aGVtZS5mZyhcImVycm9yXCIsIFwiW2ludmFsaWQgY29udGVudCBhcmcgLSBleHBlY3RlZCBzdHJpbmddXCIpfWA7XG5cdFx0XHR9IGVsc2UgaWYgKGZpbGVDb250ZW50KSB7XG5cdFx0XHRcdGNvbnN0IGxhbmcgPSByYXdQYXRoID8gZ2V0TGFuZ3VhZ2VGcm9tUGF0aChyYXdQYXRoKSA6IHVuZGVmaW5lZDtcblxuXHRcdFx0XHRsZXQgbGluZXM6IHN0cmluZ1tdO1xuXHRcdFx0XHRpZiAobGFuZykge1xuXHRcdFx0XHRcdGNvbnN0IGNhY2hlID0gdGhpcy53cml0ZUhpZ2hsaWdodENhY2hlO1xuXHRcdFx0XHRcdGlmIChjYWNoZSAmJiBjYWNoZS5sYW5nID09PSBsYW5nICYmIGNhY2hlLnJhd1BhdGggPT09IHJhd1BhdGggJiYgY2FjaGUucmF3Q29udGVudCA9PT0gZmlsZUNvbnRlbnQpIHtcblx0XHRcdFx0XHRcdGxpbmVzID0gY2FjaGUuaGlnaGxpZ2h0ZWRMaW5lcztcblx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0Y29uc3QgZGlzcGxheUNvbnRlbnQgPSBub3JtYWxpemVEaXNwbGF5VGV4dChmaWxlQ29udGVudCk7XG5cdFx0XHRcdFx0XHRjb25zdCBub3JtYWxpemVkID0gcmVwbGFjZVRhYnMoZGlzcGxheUNvbnRlbnQpO1xuXHRcdFx0XHRcdFx0bGluZXMgPSBoaWdobGlnaHRDb2RlKG5vcm1hbGl6ZWQsIGxhbmcpO1xuXHRcdFx0XHRcdFx0dGhpcy53cml0ZUhpZ2hsaWdodENhY2hlID0ge1xuXHRcdFx0XHRcdFx0XHRyYXdQYXRoLFxuXHRcdFx0XHRcdFx0XHRsYW5nLFxuXHRcdFx0XHRcdFx0XHRyYXdDb250ZW50OiBmaWxlQ29udGVudCxcblx0XHRcdFx0XHRcdFx0bm9ybWFsaXplZExpbmVzOiBub3JtYWxpemVkLnNwbGl0KFwiXFxuXCIpLFxuXHRcdFx0XHRcdFx0XHRoaWdobGlnaHRlZExpbmVzOiBsaW5lcyxcblx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdGxpbmVzID0gbm9ybWFsaXplRGlzcGxheVRleHQoZmlsZUNvbnRlbnQpLnNwbGl0KFwiXFxuXCIpO1xuXHRcdFx0XHRcdHRoaXMud3JpdGVIaWdobGlnaHRDYWNoZSA9IHVuZGVmaW5lZDtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGNvbnN0IHRvdGFsTGluZXMgPSBsaW5lcy5sZW5ndGg7XG5cdFx0XHRcdGNvbnN0IG1heExpbmVzID0gdGhpcy5leHBhbmRlZCA/IGxpbmVzLmxlbmd0aCA6IDEwO1xuXHRcdFx0XHRjb25zdCBkaXNwbGF5TGluZXMgPSBsaW5lcy5zbGljZSgwLCBtYXhMaW5lcyk7XG5cdFx0XHRcdGNvbnN0IHJlbWFpbmluZyA9IGxpbmVzLmxlbmd0aCAtIG1heExpbmVzO1xuXG5cdFx0XHRcdHRleHQgKz1cblx0XHRcdFx0XHRcIlxcblxcblwiICtcblx0XHRcdFx0XHRkaXNwbGF5TGluZXMubWFwKChsaW5lOiBzdHJpbmcpID0+IChsYW5nID8gbGluZSA6IHRoZW1lLmZnKFwidG9vbE91dHB1dFwiLCByZXBsYWNlVGFicyhsaW5lKSkpKS5qb2luKFwiXFxuXCIpO1xuXHRcdFx0XHRpZiAocmVtYWluaW5nID4gMCkge1xuXHRcdFx0XHRcdHRleHQgKz1cblx0XHRcdFx0XHRcdHRoZW1lLmZnKFwibXV0ZWRcIiwgYFxcbi4uLiAoJHtyZW1haW5pbmd9IG1vcmUgbGluZXMsICR7dG90YWxMaW5lc30gdG90YWwsYCkgK1xuXHRcdFx0XHRcdFx0YCAke2tleUhpbnQoXCJleHBhbmRUb29sc1wiLCBcInRvIGV4cGFuZFwiKX0pYDtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHQvLyBTaG93IGVycm9yIGlmIHRvb2wgZXhlY3V0aW9uIGZhaWxlZFxuXHRcdFx0aWYgKHRoaXMucmVzdWx0Py5pc0Vycm9yKSB7XG5cdFx0XHRcdGNvbnN0IGVycm9yVGV4dCA9IHRoaXMuZ2V0VGV4dE91dHB1dCgpO1xuXHRcdFx0XHRpZiAoZXJyb3JUZXh0KSB7XG5cdFx0XHRcdFx0dGV4dCArPSBgXFxuXFxuJHt0aGVtZS5mZyhcImVycm9yXCIsIGVycm9yVGV4dCl9YDtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH0gZWxzZSBpZiAobm9ybWFsaXplZFRvb2xOYW1lID09PSBcImVkaXRcIikge1xuXHRcdFx0Y29uc3QgcmF3UGF0aCA9IHN0cih0aGlzLmFyZ3M/LmZpbGVfcGF0aCA/PyB0aGlzLmFyZ3M/LnBhdGgpO1xuXHRcdFx0Y29uc3QgcGF0aCA9IHJhd1BhdGggIT09IG51bGwgPyBzaG9ydGVuUGF0aChyYXdQYXRoKSA6IG51bGw7XG5cblx0XHRcdC8vIEJ1aWxkIHBhdGggZGlzcGxheSwgYXBwZW5kaW5nIDpsaW5lIGlmIHdlIGhhdmUgZGlmZiBpbmZvXG5cdFx0XHRsZXQgcGF0aERpc3BsYXkgPSBwYXRoID09PSBudWxsID8gaW52YWxpZEFyZyA6IHBhdGggPyB0aGVtZS5mZyhcImFjY2VudFwiLCBwYXRoKSA6IHRoZW1lLmZnKFwidG9vbE91dHB1dFwiLCBcIi4uLlwiKTtcblx0XHRcdGNvbnN0IGZpcnN0Q2hhbmdlZExpbmUgPVxuXHRcdFx0XHQodGhpcy5lZGl0RGlmZlByZXZpZXcgJiYgXCJmaXJzdENoYW5nZWRMaW5lXCIgaW4gdGhpcy5lZGl0RGlmZlByZXZpZXdcblx0XHRcdFx0XHQ/IHRoaXMuZWRpdERpZmZQcmV2aWV3LmZpcnN0Q2hhbmdlZExpbmVcblx0XHRcdFx0XHQ6IHVuZGVmaW5lZCkgfHxcblx0XHRcdFx0KHRoaXMucmVzdWx0ICYmICF0aGlzLnJlc3VsdC5pc0Vycm9yID8gdGhpcy5yZXN1bHQuZGV0YWlscz8uZmlyc3RDaGFuZ2VkTGluZSA6IHVuZGVmaW5lZCk7XG5cdFx0XHRpZiAoZmlyc3RDaGFuZ2VkTGluZSkge1xuXHRcdFx0XHRwYXRoRGlzcGxheSArPSB0aGVtZS5mZyhcIndhcm5pbmdcIiwgYDoke2ZpcnN0Q2hhbmdlZExpbmV9YCk7XG5cdFx0XHR9XG5cblx0XHRcdHRleHQgPSBgJHt0aGVtZS5mZyhcInRvb2xUaXRsZVwiLCB0aGVtZS5ib2xkKFwiZWRpdFwiKSl9ICR7cGF0aERpc3BsYXl9YDtcblxuXHRcdFx0aWYgKHRoaXMucmVzdWx0Py5pc0Vycm9yKSB7XG5cdFx0XHRcdC8vIFNob3cgZXJyb3IgZnJvbSByZXN1bHRcblx0XHRcdFx0Y29uc3QgZXJyb3JUZXh0ID0gdGhpcy5nZXRUZXh0T3V0cHV0KCk7XG5cdFx0XHRcdGlmIChlcnJvclRleHQpIHtcblx0XHRcdFx0XHR0ZXh0ICs9IGBcXG5cXG4ke3RoZW1lLmZnKFwiZXJyb3JcIiwgZXJyb3JUZXh0KX1gO1xuXHRcdFx0XHR9XG5cdFx0XHR9IGVsc2UgaWYgKHRoaXMucmVzdWx0Py5kZXRhaWxzPy5kaWZmKSB7XG5cdFx0XHRcdC8vIFRvb2wgZXhlY3V0ZWQgc3VjY2Vzc2Z1bGx5IC0gdXNlIHRoZSBkaWZmIGZyb20gcmVzdWx0XG5cdFx0XHRcdC8vIFRoaXMgdGFrZXMgcHJpb3JpdHkgb3ZlciBlZGl0RGlmZlByZXZpZXcgd2hpY2ggbWF5IGhhdmUgYSBzdGFsZSBlcnJvclxuXHRcdFx0XHQvLyBkdWUgdG8gcmFjZSBjb25kaXRpb24gKGFzeW5jIHByZXZpZXcgY29tcHV0ZWQgYWZ0ZXIgZmlsZSB3YXMgbW9kaWZpZWQpXG5cdFx0XHRcdHRleHQgKz0gYFxcblxcbiR7cmVuZGVyRGlmZih0aGlzLnJlc3VsdC5kZXRhaWxzLmRpZmYsIHsgZmlsZVBhdGg6IHJhd1BhdGggPz8gdW5kZWZpbmVkIH0pfWA7XG5cdFx0XHR9IGVsc2UgaWYgKHRoaXMuZWRpdERpZmZQcmV2aWV3KSB7XG5cdFx0XHRcdC8vIFVzZSBjYWNoZWQgZGlmZiBwcmV2aWV3IChiZWZvcmUgdG9vbCBleGVjdXRlcylcblx0XHRcdFx0aWYgKFwiZXJyb3JcIiBpbiB0aGlzLmVkaXREaWZmUHJldmlldykge1xuXHRcdFx0XHRcdHRleHQgKz0gYFxcblxcbiR7dGhlbWUuZmcoXCJlcnJvclwiLCB0aGlzLmVkaXREaWZmUHJldmlldy5lcnJvcil9YDtcblx0XHRcdFx0fSBlbHNlIGlmICh0aGlzLmVkaXREaWZmUHJldmlldy5kaWZmKSB7XG5cdFx0XHRcdFx0dGV4dCArPSBgXFxuXFxuJHtyZW5kZXJEaWZmKHRoaXMuZWRpdERpZmZQcmV2aWV3LmRpZmYsIHsgZmlsZVBhdGg6IHJhd1BhdGggPz8gdW5kZWZpbmVkIH0pfWA7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9IGVsc2UgaWYgKG5vcm1hbGl6ZWRUb29sTmFtZSA9PT0gXCJsc1wiKSB7XG5cdFx0XHRjb25zdCByYXdQYXRoID0gc3RyKHRoaXMuYXJncz8ucGF0aCk7XG5cdFx0XHRjb25zdCBwYXRoID0gcmF3UGF0aCAhPT0gbnVsbCA/IHNob3J0ZW5QYXRoKHJhd1BhdGggfHwgXCIuXCIpIDogbnVsbDtcblx0XHRcdGNvbnN0IGxpbWl0ID0gdGhpcy5hcmdzPy5saW1pdDtcblxuXHRcdFx0dGV4dCA9IGAke3RoZW1lLmZnKFwidG9vbFRpdGxlXCIsIHRoZW1lLmJvbGQoXCJsc1wiKSl9ICR7cGF0aCA9PT0gbnVsbCA/IGludmFsaWRBcmcgOiB0aGVtZS5mZyhcImFjY2VudFwiLCBwYXRoKX1gO1xuXHRcdFx0aWYgKGxpbWl0ICE9PSB1bmRlZmluZWQpIHtcblx0XHRcdFx0dGV4dCArPSB0aGVtZS5mZyhcInRvb2xPdXRwdXRcIiwgYCAobGltaXQgJHtsaW1pdH0pYCk7XG5cdFx0XHR9XG5cblx0XHRcdGlmICh0aGlzLnJlc3VsdCkge1xuXHRcdFx0XHRpZiAodGhpcy5yZXN1bHQuaXNFcnJvcikge1xuXHRcdFx0XHRcdGNvbnN0IGVycm9yVGV4dCA9IHRoaXMuZ2V0VGV4dE91dHB1dCgpLnRyaW0oKSB8fCBcImxzIGZhaWxlZFwiO1xuXHRcdFx0XHRcdHRleHQgKz0gYFxcblxcbiR7dGhlbWUuZmcoXCJlcnJvclwiLCBlcnJvclRleHQpfWA7XG5cdFx0XHRcdFx0cmV0dXJuIHRleHQ7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRjb25zdCBvdXRwdXQgPSB0aGlzLmdldFRleHRPdXRwdXQoKS50cmltKCk7XG5cdFx0XHRcdGlmIChvdXRwdXQpIHtcblx0XHRcdFx0XHRjb25zdCBsaW5lcyA9IG91dHB1dC5zcGxpdChcIlxcblwiKTtcblx0XHRcdFx0XHRjb25zdCBtYXhMaW5lcyA9IHRoaXMuZXhwYW5kZWQgPyBsaW5lcy5sZW5ndGggOiAyMDtcblx0XHRcdFx0XHRjb25zdCBkaXNwbGF5TGluZXMgPSBsaW5lcy5zbGljZSgwLCBtYXhMaW5lcyk7XG5cdFx0XHRcdFx0Y29uc3QgcmVtYWluaW5nID0gbGluZXMubGVuZ3RoIC0gbWF4TGluZXM7XG5cblx0XHRcdFx0XHR0ZXh0ICs9IGBcXG5cXG4ke2Rpc3BsYXlMaW5lcy5tYXAoKGxpbmU6IHN0cmluZykgPT4gdGhlbWUuZmcoXCJ0b29sT3V0cHV0XCIsIGxpbmUpKS5qb2luKFwiXFxuXCIpfWA7XG5cdFx0XHRcdFx0aWYgKHJlbWFpbmluZyA+IDApIHtcblx0XHRcdFx0XHRcdHRleHQgKz0gYCR7dGhlbWUuZmcoXCJtdXRlZFwiLCBgXFxuLi4uICgke3JlbWFpbmluZ30gbW9yZSBsaW5lcyxgKX0gJHtrZXlIaW50KFwiZXhwYW5kVG9vbHNcIiwgXCJ0byBleHBhbmRcIil9KWA7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cblx0XHRcdFx0Y29uc3QgZW50cnlMaW1pdCA9IHRoaXMucmVzdWx0LmRldGFpbHM/LmVudHJ5TGltaXRSZWFjaGVkO1xuXHRcdFx0XHRjb25zdCB0cnVuY2F0aW9uID0gdGhpcy5yZXN1bHQuZGV0YWlscz8udHJ1bmNhdGlvbjtcblx0XHRcdFx0aWYgKGVudHJ5TGltaXQgfHwgdHJ1bmNhdGlvbj8udHJ1bmNhdGVkKSB7XG5cdFx0XHRcdFx0Y29uc3Qgd2FybmluZ3M6IHN0cmluZ1tdID0gW107XG5cdFx0XHRcdFx0aWYgKGVudHJ5TGltaXQpIHtcblx0XHRcdFx0XHRcdHdhcm5pbmdzLnB1c2goYCR7ZW50cnlMaW1pdH0gZW50cmllcyBsaW1pdGApO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRpZiAodHJ1bmNhdGlvbj8udHJ1bmNhdGVkKSB7XG5cdFx0XHRcdFx0XHR3YXJuaW5ncy5wdXNoKGAke2Zvcm1hdFNpemUodHJ1bmNhdGlvbi5tYXhCeXRlcyA/PyBERUZBVUxUX01BWF9CWVRFUyl9IGxpbWl0YCk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdHRleHQgKz0gYFxcbiR7dGhlbWUuZmcoXCJ3YXJuaW5nXCIsIGBbVHJ1bmNhdGVkOiAke3dhcm5pbmdzLmpvaW4oXCIsIFwiKX1dYCl9YDtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH0gZWxzZSBpZiAobm9ybWFsaXplZFRvb2xOYW1lID09PSBcImZpbmRcIikge1xuXHRcdFx0Y29uc3QgcGF0dGVybiA9IHN0cih0aGlzLmFyZ3M/LnBhdHRlcm4pO1xuXHRcdFx0Y29uc3QgcmF3UGF0aCA9IHN0cih0aGlzLmFyZ3M/LnBhdGgpO1xuXHRcdFx0Y29uc3QgcGF0aCA9IHJhd1BhdGggIT09IG51bGwgPyBzaG9ydGVuUGF0aChyYXdQYXRoIHx8IFwiLlwiKSA6IG51bGw7XG5cdFx0XHRjb25zdCBsaW1pdCA9IHRoaXMuYXJncz8ubGltaXQ7XG5cblx0XHRcdHRleHQgPVxuXHRcdFx0XHR0aGVtZS5mZyhcInRvb2xUaXRsZVwiLCB0aGVtZS5ib2xkKFwiZmluZFwiKSkgK1xuXHRcdFx0XHRcIiBcIiArXG5cdFx0XHRcdChwYXR0ZXJuID09PSBudWxsID8gaW52YWxpZEFyZyA6IHRoZW1lLmZnKFwiYWNjZW50XCIsIHBhdHRlcm4gfHwgXCJcIikpICtcblx0XHRcdFx0dGhlbWUuZmcoXCJ0b29sT3V0cHV0XCIsIGAgaW4gJHtwYXRoID09PSBudWxsID8gaW52YWxpZEFyZyA6IHBhdGh9YCk7XG5cdFx0XHRpZiAobGltaXQgIT09IHVuZGVmaW5lZCkge1xuXHRcdFx0XHR0ZXh0ICs9IHRoZW1lLmZnKFwidG9vbE91dHB1dFwiLCBgIChsaW1pdCAke2xpbWl0fSlgKTtcblx0XHRcdH1cblxuXHRcdFx0aWYgKHRoaXMucmVzdWx0KSB7XG5cdFx0XHRcdGlmICh0aGlzLnJlc3VsdC5pc0Vycm9yKSB7XG5cdFx0XHRcdFx0Y29uc3QgZXJyb3JUZXh0ID0gdGhpcy5nZXRUZXh0T3V0cHV0KCkudHJpbSgpIHx8IFwiZmluZCBmYWlsZWRcIjtcblx0XHRcdFx0XHR0ZXh0ICs9IGBcXG5cXG4ke3RoZW1lLmZnKFwiZXJyb3JcIiwgZXJyb3JUZXh0KX1gO1xuXHRcdFx0XHRcdHJldHVybiB0ZXh0O1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Y29uc3Qgb3V0cHV0ID0gdGhpcy5nZXRUZXh0T3V0cHV0KCkudHJpbSgpO1xuXHRcdFx0XHRpZiAob3V0cHV0KSB7XG5cdFx0XHRcdFx0Y29uc3QgbGluZXMgPSBvdXRwdXQuc3BsaXQoXCJcXG5cIik7XG5cdFx0XHRcdFx0Y29uc3QgbWF4TGluZXMgPSB0aGlzLmV4cGFuZGVkID8gbGluZXMubGVuZ3RoIDogMjA7XG5cdFx0XHRcdFx0Y29uc3QgZGlzcGxheUxpbmVzID0gbGluZXMuc2xpY2UoMCwgbWF4TGluZXMpO1xuXHRcdFx0XHRcdGNvbnN0IHJlbWFpbmluZyA9IGxpbmVzLmxlbmd0aCAtIG1heExpbmVzO1xuXG5cdFx0XHRcdFx0dGV4dCArPSBgXFxuXFxuJHtkaXNwbGF5TGluZXMubWFwKChsaW5lOiBzdHJpbmcpID0+IHRoZW1lLmZnKFwidG9vbE91dHB1dFwiLCBsaW5lKSkuam9pbihcIlxcblwiKX1gO1xuXHRcdFx0XHRcdGlmIChyZW1haW5pbmcgPiAwKSB7XG5cdFx0XHRcdFx0XHR0ZXh0ICs9IGAke3RoZW1lLmZnKFwibXV0ZWRcIiwgYFxcbi4uLiAoJHtyZW1haW5pbmd9IG1vcmUgbGluZXMsYCl9ICR7a2V5SGludChcImV4cGFuZFRvb2xzXCIsIFwidG8gZXhwYW5kXCIpfSlgO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXG5cdFx0XHRcdGNvbnN0IHJlc3VsdExpbWl0ID0gdGhpcy5yZXN1bHQuZGV0YWlscz8ucmVzdWx0TGltaXRSZWFjaGVkO1xuXHRcdFx0XHRjb25zdCB0cnVuY2F0aW9uID0gdGhpcy5yZXN1bHQuZGV0YWlscz8udHJ1bmNhdGlvbjtcblx0XHRcdFx0aWYgKHJlc3VsdExpbWl0IHx8IHRydW5jYXRpb24/LnRydW5jYXRlZCkge1xuXHRcdFx0XHRcdGNvbnN0IHdhcm5pbmdzOiBzdHJpbmdbXSA9IFtdO1xuXHRcdFx0XHRcdGlmIChyZXN1bHRMaW1pdCkge1xuXHRcdFx0XHRcdFx0d2FybmluZ3MucHVzaChgJHtyZXN1bHRMaW1pdH0gcmVzdWx0cyBsaW1pdGApO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRpZiAodHJ1bmNhdGlvbj8udHJ1bmNhdGVkKSB7XG5cdFx0XHRcdFx0XHR3YXJuaW5ncy5wdXNoKGAke2Zvcm1hdFNpemUodHJ1bmNhdGlvbi5tYXhCeXRlcyA/PyBERUZBVUxUX01BWF9CWVRFUyl9IGxpbWl0YCk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdHRleHQgKz0gYFxcbiR7dGhlbWUuZmcoXCJ3YXJuaW5nXCIsIGBbVHJ1bmNhdGVkOiAke3dhcm5pbmdzLmpvaW4oXCIsIFwiKX1dYCl9YDtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH0gZWxzZSBpZiAobm9ybWFsaXplZFRvb2xOYW1lID09PSBcImdyZXBcIikge1xuXHRcdFx0Y29uc3QgcGF0dGVybiA9IHN0cih0aGlzLmFyZ3M/LnBhdHRlcm4pO1xuXHRcdFx0Y29uc3QgcmF3UGF0aCA9IHN0cih0aGlzLmFyZ3M/LnBhdGgpO1xuXHRcdFx0Y29uc3QgcGF0aCA9IHJhd1BhdGggIT09IG51bGwgPyBzaG9ydGVuUGF0aChyYXdQYXRoIHx8IFwiLlwiKSA6IG51bGw7XG5cdFx0XHRjb25zdCBnbG9iID0gc3RyKHRoaXMuYXJncz8uZ2xvYik7XG5cdFx0XHRjb25zdCBsaW1pdCA9IHRoaXMuYXJncz8ubGltaXQ7XG5cblx0XHRcdHRleHQgPVxuXHRcdFx0XHR0aGVtZS5mZyhcInRvb2xUaXRsZVwiLCB0aGVtZS5ib2xkKFwiZ3JlcFwiKSkgK1xuXHRcdFx0XHRcIiBcIiArXG5cdFx0XHRcdChwYXR0ZXJuID09PSBudWxsID8gaW52YWxpZEFyZyA6IHRoZW1lLmZnKFwiYWNjZW50XCIsIGAvJHtwYXR0ZXJuIHx8IFwiXCJ9L2ApKSArXG5cdFx0XHRcdHRoZW1lLmZnKFwidG9vbE91dHB1dFwiLCBgIGluICR7cGF0aCA9PT0gbnVsbCA/IGludmFsaWRBcmcgOiBwYXRofWApO1xuXHRcdFx0aWYgKGdsb2IpIHtcblx0XHRcdFx0dGV4dCArPSB0aGVtZS5mZyhcInRvb2xPdXRwdXRcIiwgYCAoJHtnbG9ifSlgKTtcblx0XHRcdH1cblx0XHRcdGlmIChsaW1pdCAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0XHRcdHRleHQgKz0gdGhlbWUuZmcoXCJ0b29sT3V0cHV0XCIsIGAgbGltaXQgJHtsaW1pdH1gKTtcblx0XHRcdH1cblxuXHRcdFx0aWYgKHRoaXMucmVzdWx0KSB7XG5cdFx0XHRcdGlmICh0aGlzLnJlc3VsdC5pc0Vycm9yKSB7XG5cdFx0XHRcdFx0Y29uc3QgZXJyb3JUZXh0ID0gdGhpcy5nZXRUZXh0T3V0cHV0KCkudHJpbSgpIHx8IFwiZ3JlcCBmYWlsZWRcIjtcblx0XHRcdFx0XHR0ZXh0ICs9IGBcXG5cXG4ke3RoZW1lLmZnKFwiZXJyb3JcIiwgZXJyb3JUZXh0KX1gO1xuXHRcdFx0XHRcdHJldHVybiB0ZXh0O1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Y29uc3Qgb3V0cHV0ID0gdGhpcy5nZXRUZXh0T3V0cHV0KCkudHJpbSgpO1xuXHRcdFx0XHRpZiAob3V0cHV0KSB7XG5cdFx0XHRcdFx0Y29uc3QgbGluZXMgPSBvdXRwdXQuc3BsaXQoXCJcXG5cIik7XG5cdFx0XHRcdFx0Y29uc3QgbWF4TGluZXMgPSB0aGlzLmV4cGFuZGVkID8gbGluZXMubGVuZ3RoIDogMTU7XG5cdFx0XHRcdFx0Y29uc3QgZGlzcGxheUxpbmVzID0gbGluZXMuc2xpY2UoMCwgbWF4TGluZXMpO1xuXHRcdFx0XHRcdGNvbnN0IHJlbWFpbmluZyA9IGxpbmVzLmxlbmd0aCAtIG1heExpbmVzO1xuXG5cdFx0XHRcdFx0dGV4dCArPSBgXFxuXFxuJHtkaXNwbGF5TGluZXMubWFwKChsaW5lOiBzdHJpbmcpID0+IHRoZW1lLmZnKFwidG9vbE91dHB1dFwiLCBsaW5lKSkuam9pbihcIlxcblwiKX1gO1xuXHRcdFx0XHRcdGlmIChyZW1haW5pbmcgPiAwKSB7XG5cdFx0XHRcdFx0XHR0ZXh0ICs9IGAke3RoZW1lLmZnKFwibXV0ZWRcIiwgYFxcbi4uLiAoJHtyZW1haW5pbmd9IG1vcmUgbGluZXMsYCl9ICR7a2V5SGludChcImV4cGFuZFRvb2xzXCIsIFwidG8gZXhwYW5kXCIpfSlgO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXG5cdFx0XHRcdGNvbnN0IG1hdGNoTGltaXQgPSB0aGlzLnJlc3VsdC5kZXRhaWxzPy5tYXRjaExpbWl0UmVhY2hlZDtcblx0XHRcdFx0Y29uc3QgdHJ1bmNhdGlvbiA9IHRoaXMucmVzdWx0LmRldGFpbHM/LnRydW5jYXRpb247XG5cdFx0XHRcdGNvbnN0IGxpbmVzVHJ1bmNhdGVkID0gdGhpcy5yZXN1bHQuZGV0YWlscz8ubGluZXNUcnVuY2F0ZWQ7XG5cdFx0XHRcdGlmIChtYXRjaExpbWl0IHx8IHRydW5jYXRpb24/LnRydW5jYXRlZCB8fCBsaW5lc1RydW5jYXRlZCkge1xuXHRcdFx0XHRcdGNvbnN0IHdhcm5pbmdzOiBzdHJpbmdbXSA9IFtdO1xuXHRcdFx0XHRcdGlmIChtYXRjaExpbWl0KSB7XG5cdFx0XHRcdFx0XHR3YXJuaW5ncy5wdXNoKGAke21hdGNoTGltaXR9IG1hdGNoZXMgbGltaXRgKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0aWYgKHRydW5jYXRpb24/LnRydW5jYXRlZCkge1xuXHRcdFx0XHRcdFx0d2FybmluZ3MucHVzaChgJHtmb3JtYXRTaXplKHRydW5jYXRpb24ubWF4Qnl0ZXMgPz8gREVGQVVMVF9NQVhfQllURVMpfSBsaW1pdGApO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRpZiAobGluZXNUcnVuY2F0ZWQpIHtcblx0XHRcdFx0XHRcdHdhcm5pbmdzLnB1c2goXCJzb21lIGxpbmVzIHRydW5jYXRlZFwiKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0dGV4dCArPSBgXFxuJHt0aGVtZS5mZyhcIndhcm5pbmdcIiwgYFtUcnVuY2F0ZWQ6ICR7d2FybmluZ3Muam9pbihcIiwgXCIpfV1gKX1gO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0fSBlbHNlIGlmIChub3JtYWxpemVkVG9vbE5hbWUgPT09IFwid2ViX3NlYXJjaFwiKSB7XG5cdFx0XHQvLyBTZXJ2ZXItc2lkZSBBbnRocm9waWMgd2ViIHNlYXJjaFxuXHRcdFx0dGV4dCA9IHRoZW1lLmZnKFwidG9vbFRpdGxlXCIsIHRoZW1lLmJvbGQoXCJ3ZWIgc2VhcmNoXCIpKTtcblxuXHRcdFx0aWYgKHByb2Nlc3MuZW52LlBJX09GRkxJTkUgPT09IFwiMVwiKSB7XG5cdFx0XHRcdHRleHQgKz0gXCJcXG5cXG5cIiArIHRoZW1lLmZnKFwibXV0ZWRcIiwgXCJcXHV7MUY1MEN9IE9mZmxpbmUgXFx1ezIwMTR9IHdlYiBzZWFyY2ggdW5hdmFpbGFibGVcIik7XG5cdFx0XHR9IGVsc2UgaWYgKHRoaXMucmVzdWx0KSB7XG5cdFx0XHRcdGNvbnN0IG91dHB1dCA9IHRoaXMuZ2V0VGV4dE91dHB1dCgpLnRyaW0oKTtcblx0XHRcdFx0aWYgKG91dHB1dCkge1xuXHRcdFx0XHRcdGNvbnN0IGxpbmVzID0gb3V0cHV0LnNwbGl0KFwiXFxuXCIpO1xuXHRcdFx0XHRcdGNvbnN0IG1heExpbmVzID0gdGhpcy5leHBhbmRlZCA/IGxpbmVzLmxlbmd0aCA6IDEwO1xuXHRcdFx0XHRcdGNvbnN0IGRpc3BsYXlMaW5lcyA9IGxpbmVzLnNsaWNlKDAsIG1heExpbmVzKTtcblx0XHRcdFx0XHRjb25zdCByZW1haW5pbmcgPSBsaW5lcy5sZW5ndGggLSBtYXhMaW5lcztcblxuXHRcdFx0XHRcdHRleHQgKz0gYFxcblxcbiR7ZGlzcGxheUxpbmVzLm1hcCgobGluZTogc3RyaW5nKSA9PiB0aGVtZS5mZyhcInRvb2xPdXRwdXRcIiwgbGluZSkpLmpvaW4oXCJcXG5cIil9YDtcblx0XHRcdFx0XHRpZiAocmVtYWluaW5nID4gMCkge1xuXHRcdFx0XHRcdFx0dGV4dCArPSBgJHt0aGVtZS5mZyhcIm11dGVkXCIsIGBcXG4uLi4gKCR7cmVtYWluaW5nfSBtb3JlIGxpbmVzLGApfSAke2tleUhpbnQoXCJleHBhbmRUb29sc1wiLCBcInRvIGV4cGFuZFwiKX0pYDtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9IGVsc2Uge1xuXHRcdFx0Ly8gR2VuZXJpYyB0b29sIC8gTUNQIHRvb2wgd2l0aG91dCBhIHJlZ2lzdGVyZWQgcmVuZGVyZXIuXG5cdFx0XHQvLyBUaGUgZnJhbWUgaGVhZGVyIGFscmVhZHkgY29udGFpbnMgdGhlIHRvb2wgaWRlbnRpdHksIHNvIHRoZSBib2R5XG5cdFx0XHQvLyBzaG91bGQgc2hvdyBvbmx5IGFyZ3VtZW50cyBhbmQgb3V0cHV0LlxuXHRcdFx0Y29uc3QgYXJnc1RleHQgPSBmb3JtYXRDb21wYWN0QXJncyh0aGlzLmFyZ3MsIHRoaXMuZXhwYW5kZWQpO1xuXHRcdFx0aWYgKGFyZ3NUZXh0KSB7XG5cdFx0XHRcdGlmIChhcmdzVGV4dC5pbmNsdWRlcyhcIlxcblwiKSkge1xuXHRcdFx0XHRcdHRleHQgPSB0aGVtZS5mZyhcInRvb2xPdXRwdXRcIiwgYXJnc1RleHQpO1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdHRleHQgPSB0aGVtZS5mZyhcInRvb2xPdXRwdXRcIiwgYXJnc1RleHQpO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdGlmICh0aGlzLnJlc3VsdCkge1xuXHRcdFx0XHRjb25zdCBvdXRwdXQgPSB0aGlzLmdldFRleHRPdXRwdXQoKS50cmltKCk7XG5cdFx0XHRcdGlmIChvdXRwdXQpIHtcblx0XHRcdFx0XHRjb25zdCBsaW5lcyA9IG91dHB1dC5zcGxpdChcIlxcblwiKTtcblx0XHRcdFx0XHRjb25zdCBtYXhMaW5lcyA9IHRoaXMuZXhwYW5kZWQgPyBsaW5lcy5sZW5ndGggOiBHRU5FUklDX09VVFBVVF9QUkVWSUVXX0xJTkVTO1xuXHRcdFx0XHRcdGNvbnN0IGRpc3BsYXlMaW5lcyA9IGxpbmVzLnNsaWNlKDAsIG1heExpbmVzKTtcblx0XHRcdFx0XHRjb25zdCByZW1haW5pbmcgPSBsaW5lcy5sZW5ndGggLSBtYXhMaW5lcztcblx0XHRcdFx0XHRjb25zdCBvdXRwdXRUZXh0ID0gZGlzcGxheUxpbmVzLm1hcCgobGluZTogc3RyaW5nKSA9PiB0aGVtZS5mZyhcInRvb2xPdXRwdXRcIiwgbGluZSkpLmpvaW4oXCJcXG5cIik7XG5cdFx0XHRcdFx0dGV4dCArPSBgJHt0ZXh0ID8gXCJcXG5cXG5cIiA6IFwiXCJ9JHtvdXRwdXRUZXh0fWA7XG5cdFx0XHRcdFx0aWYgKHJlbWFpbmluZyA+IDApIHtcblx0XHRcdFx0XHRcdHRleHQgKz0gYCR7dGhlbWUuZmcoXCJtdXRlZFwiLCBgXFxuLi4uICgke3JlbWFpbmluZ30gbW9yZSBsaW5lcyxgKX0gJHtrZXlIaW50KFwiZXhwYW5kVG9vbHNcIiwgXCJ0byBleHBhbmRcIil9KWA7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0cmV0dXJuIHRleHQ7XG5cdH1cbn1cblxuZXhwb3J0IGNsYXNzIFRvb2xQaGFzZVN1bW1hcnlDb21wb25lbnQgZXh0ZW5kcyBDb250YWluZXIge1xuXHRjb25zdHJ1Y3Rvcihwcml2YXRlIHJlYWRvbmx5IHBoYXNlczogVG9vbEV4ZWN1dGlvblBoYXNlW10pIHtcblx0XHRzdXBlcigpO1xuXHR9XG5cblx0Z2V0UGhhc2VzKCk6IFRvb2xFeGVjdXRpb25QaGFzZVtdIHtcblx0XHRyZXR1cm4gdGhpcy5waGFzZXMubWFwKChwaGFzZSkgPT4gKHsgLi4ucGhhc2UsIHRhcmdldHM6IHBoYXNlLnRhcmdldHMgPyBbLi4ucGhhc2UudGFyZ2V0c10gOiB1bmRlZmluZWQgfSkpO1xuXHR9XG5cblx0b3ZlcnJpZGUgcmVuZGVyKHdpZHRoOiBudW1iZXIpOiBzdHJpbmdbXSB7XG5cdFx0Y29uc3QgZnJhbWVXaWR0aCA9IE1hdGgubWF4KDIwLCB3aWR0aCk7XG5cdFx0Y29uc3Qgcm93cyA9IHRoaXMucGhhc2VzLmZsYXRNYXAoKHBoYXNlKSA9PiB7XG5cdFx0XHRjb25zdCBsZWZ0ID0gc3VtbWFyaXplUGhhc2VMYWJlbChwaGFzZSk7XG5cdFx0XHRjb25zdCByaWdodCA9IGBzdWNjZXNzIFx1MDBCNyAke2Zvcm1hdEVsYXBzZWQocGhhc2UuZHVyYXRpb25Ncyl9YDtcblx0XHRcdGNvbnN0IGNvbnRlbnRXaWR0aCA9IE1hdGgubWF4KDEsIGZyYW1lV2lkdGggLSAyKTtcblx0XHRcdGNvbnN0IGxlZnRXaWR0aCA9IE1hdGgubWF4KDEsIGNvbnRlbnRXaWR0aCAtIHZpc2libGVXaWR0aChyaWdodCkgLSAxKTtcblx0XHRcdGNvbnN0IGxlZnRUZXh0ID0gdHJ1bmNhdGVUb1dpZHRoKGxlZnQsIGxlZnRXaWR0aCwgXCJcIik7XG5cdFx0XHRjb25zdCBnYXAgPSBNYXRoLm1heCgxLCBjb250ZW50V2lkdGggLSB2aXNpYmxlV2lkdGgobGVmdFRleHQpIC0gdmlzaWJsZVdpZHRoKHJpZ2h0KSk7XG5cdFx0XHRjb25zdCBzdW1tYXJ5Um93ID0gYCR7dGhlbWUuZmcoXCJ0b29sU3VjY2Vzc1wiLCBsZWZ0VGV4dCl9JHtcIiBcIi5yZXBlYXQoZ2FwKX0ke3RoZW1lLmZnKFwidG9vbFN1Y2Nlc3NcIiwgcmlnaHQpfWA7XG5cdFx0XHRjb25zdCB0YXJnZXRSb3cgPSBzdW1tYXJpemVQaGFzZVRhcmdldHMocGhhc2UsIGNvbnRlbnRXaWR0aCk7XG5cdFx0XHRyZXR1cm4gdGFyZ2V0Um93ID8gW3N1bW1hcnlSb3csIHRoZW1lLmZnKFwibXV0ZWRcIiwgdGFyZ2V0Um93KV0gOiBbc3VtbWFyeVJvd107XG5cdFx0fSk7XG5cblx0XHRyZXR1cm4gW1wiXCIsIC4uLnN0eWxlKCkuYm9yZGVyKFwibWluaW1hbFwiKS5ib3JkZXJDb2xvcigodGV4dCkgPT4gdGhlbWUuZmcoXCJ0b29sU3VjY2Vzc1wiLCB0ZXh0KSkucmVuZGVyKHJvd3MsIGZyYW1lV2lkdGgpXTtcblx0fVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBRUE7QUFBQSxFQUNDO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFFQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBRUE7QUFBQSxFQUNBO0FB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LGFBQWEsSUFBSSxDQUFDLFNBQWlCLE1BQU0sR0FBRyxjQUFjLElBQUksQ0FBQyxFQUFFLEtBQUssSUFBSTtBQUM3RixrQkFBUSxHQUFHLE9BQU8sU0FBUyxFQUFFLEdBQUcsVUFBVTtBQUMxQyxjQUFJLFlBQVksR0FBRztBQUNsQixvQkFBUSxHQUFHLE1BQU0sR0FBRyxTQUFTO0FBQUEsT0FBVSxTQUFTLGNBQWMsQ0FBQyxJQUFJLFFBQVEsZUFBZSxXQUFXLENBQUM7QUFBQSxVQUN2RztBQUFBLFFBQ0Q7QUFBQSxNQUNEO0FBQUEsSUFDRDtBQUVBLFdBQU87QUFBQSxFQUNSO0FBQ0Q7QUFFTyxNQUFNLGtDQUFrQyxVQUFVO0FBQUEsRUFDeEQsWUFBNkIsUUFBOEI7QUFDMUQsVUFBTTtBQURzQjtBQUFBLEVBRTdCO0FBQUEsRUFFQSxZQUFrQztBQUNqQyxXQUFPLEtBQUssT0FBTyxJQUFJLENBQUMsV0FBVyxFQUFFLEdBQUcsT0FBTyxTQUFTLE1BQU0sVUFBVSxDQUFDLEdBQUcsTUFBTSxPQUFPLElBQUksT0FBVSxFQUFFO0FBQUEsRUFDMUc7QUFBQSxFQUVTLE9BQU8sT0FBeUI7QUFDeEMsVUFBTSxhQUFhLEtBQUssSUFBSSxJQUFJLEtBQUs7QUFDckMsVUFBTSxPQUFPLEtBQUssT0FBTyxRQUFRLENBQUMsVUFBVTtBQUMzQyxZQUFNLE9BQU8sb0JBQW9CLEtBQUs7QUFDdEMsWUFBTSxRQUFRLGdCQUFhLGNBQWMsTUFBTSxVQUFVLENBQUM7QUFDMUQsWUFBTSxlQUFlLEtBQUssSUFBSSxHQUFHLGFBQWEsQ0FBQztBQUMvQyxZQUFNLFlBQVksS0FBSyxJQUFJLEdBQUcsZUFBZSxhQUFhLEtBQUssSUFBSSxDQUFDO0FBQ3BFLFlBQU0sV0FBVyxnQkFBZ0IsTUFBTSxXQUFXLEVBQUU7QUFDcEQsWUFBTSxNQUFNLEtBQUssSUFBSSxHQUFHLGVBQWUsYUFBYSxRQUFRLElBQUksYUFBYSxLQUFLLENBQUM7QUFDbkYsWUFBTSxhQUFhLEdBQUcsTUFBTSxHQUFHLGVBQWUsUUFBUSxDQUFDLEdBQUcsSUFBSSxPQUFPLEdBQUcsQ0FBQyxHQUFHLE1BQU0sR0FBRyxlQUFlLEtBQUssQ0FBQztBQUMxRyxZQUFNLFlBQVksc0JBQXNCLE9BQU8sWUFBWTtBQUMzRCxhQUFPLFlBQVksQ0FBQyxZQUFZLE1BQU0sR0FBRyxTQUFTLFNBQVMsQ0FBQyxJQUFJLENBQUMsVUFBVTtBQUFBLElBQzVFLENBQUM7QUFFRCxXQUFPLENBQUMsSUFBSSxHQUFHLE1BQU0sRUFBRSxPQUFPLFNBQVMsRUFBRSxZQUFZLENBQUMsU0FBUyxNQUFNLEdBQUcsZUFBZSxJQUFJLENBQUMsRUFBRSxPQUFPLE1BQU0sVUFBVSxDQUFDO0FBQUEsRUFDdkg7QUFDRDsiLAogICJuYW1lcyI6IFsicmF3UGF0aCJdCn0K
