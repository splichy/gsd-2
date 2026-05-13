import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  Markdown,
  Spacer,
  Text
} from "@gsd/pi-tui";
import { spawn, spawnSync } from "child_process";
import {
  getShareViewerUrl
} from "../../config.js";
import { copyToClipboard } from "../../utils/clipboard.js";
import { getChangelogPath, parseChangelog } from "../../utils/changelog.js";
import { ArminComponent } from "./components/armin.js";
import { BorderedLoader } from "./components/bordered-loader.js";
import { DynamicBorder } from "./components/dynamic-border.js";
import { appKey, editorKey, formatKeyForDisplay } from "./components/keybinding-hints.js";
import { SelectSubmenu, THINKING_DESCRIPTIONS } from "./components/settings-selector.js";
import { theme } from "./theme/theme.js";
async function dispatchSlashCommand(text, ctx) {
  if (text === "/settings") {
    ctx.showSettingsSelector();
    return true;
  }
  if (text === "/scoped-models") {
    await ctx.showModelsSelector();
    return true;
  }
  if (text === "/model" || text.startsWith("/model ")) {
    const searchTerm = text.startsWith("/model ") ? text.slice(7).trim() : void 0;
    await ctx.handleModelCommand(searchTerm);
    return true;
  }
  if (text === "/export" || text.startsWith("/export ")) {
    await handleExportCommand(text, ctx);
    return true;
  }
  if (text === "/share") {
    await handleShareCommand(ctx);
    return true;
  }
  if (text === "/copy") {
    handleCopyCommand(ctx);
    return true;
  }
  if (text === "/name" || text.startsWith("/name ")) {
    handleNameCommand(text, ctx);
    return true;
  }
  if (text === "/session") {
    handleSessionCommand(ctx);
    return true;
  }
  if (text === "/changelog") {
    handleChangelogCommand(ctx);
    return true;
  }
  if (text === "/hotkeys") {
    handleHotkeysCommand(ctx);
    return true;
  }
  if (text === "/fork") {
    ctx.showUserMessageSelector();
    return true;
  }
  if (text === "/tree") {
    ctx.showTreeSelector();
    return true;
  }
  if (text === "/provider") {
    ctx.showProviderManager();
    return true;
  }
  if (text === "/login") {
    await ctx.showOAuthSelector("login");
    return true;
  }
  if (text === "/logout") {
    await ctx.showOAuthSelector("logout");
    return true;
  }
  if (text === "/new") {
    await ctx.handleClearCommand();
    return true;
  }
  if (text === "/compact" || text.startsWith("/compact ")) {
    const customInstructions = text.startsWith("/compact ") ? text.slice(9).trim() : void 0;
    await handleCompactCommand(customInstructions, ctx);
    return true;
  }
  if (text === "/reload") {
    await ctx.handleReloadCommand();
    return true;
  }
  if (text === "/thinking" || text.startsWith("/thinking ")) {
    const arg = text.startsWith("/thinking ") ? text.slice(10).trim() : void 0;
    handleThinkingCommand(arg, ctx);
    return true;
  }
  if (text === "/edit-mode" || text.startsWith("/edit-mode ")) {
    const arg = text.startsWith("/edit-mode ") ? text.slice(11).trim() : void 0;
    handleEditModeCommand(arg, ctx);
    return true;
  }
  if (text === "/debug") {
    ctx.handleDebugCommand();
    return true;
  }
  if (text === "/arminsayshi") {
    handleArminSaysHi(ctx);
    return true;
  }
  if (text === "/resume") {
    ctx.showSessionSelector();
    return true;
  }
  if (text === "/quit") {
    await ctx.shutdown();
    return true;
  }
  if (text === "/terminal" || text.startsWith("/terminal ")) {
    const command = text.startsWith("/terminal ") ? text.slice(10).trim() : "";
    if (!command) {
      ctx.showWarning("Usage: /terminal <command>  (e.g. /terminal ping -c3 1.1.1.1)");
      return true;
    }
    await ctx.handleBashCommand(command, { loginShell: true });
    return true;
  }
  if (text === "/tui" || text.startsWith("/tui ")) {
    handleTuiCommand(text, ctx);
    return true;
  }
  return false;
}
async function handleExportCommand(text, ctx) {
  const parts = text.split(/\s+/);
  const outputPath = parts.length > 1 ? parts[1] : void 0;
  try {
    const filePath = await ctx.session.exportToHtml(outputPath);
    ctx.showStatus(`Session exported to: ${filePath}`);
  } catch (error) {
    ctx.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}
async function handleShareCommand(ctx) {
  try {
    const authResult = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
    if (authResult.status !== 0) {
      ctx.showError("GitHub CLI is not logged in. Run 'gh auth login' first.");
      return;
    }
  } catch {
    ctx.showError("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/");
    return;
  }
  const tmpFile = path.join(os.tmpdir(), "session.html");
  try {
    await ctx.session.exportToHtml(tmpFile);
  } catch (error) {
    ctx.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
    return;
  }
  const loader = new BorderedLoader(ctx.ui, theme, "Creating gist...");
  ctx.editorContainer.clear();
  ctx.editorContainer.addChild(loader);
  ctx.ui.setFocus(loader);
  ctx.requestRender();
  const restoreEditor = () => {
    loader.dispose();
    ctx.editorContainer.clear();
    ctx.editorContainer.addChild(ctx.editor);
    ctx.ui.setFocus(ctx.editor);
    try {
      fs.unlinkSync(tmpFile);
    } catch {
    }
  };
  let proc = null;
  loader.onAbort = () => {
    proc?.kill();
    restoreEditor();
    ctx.showStatus("Share cancelled");
  };
  try {
    const result = await new Promise((resolve) => {
      proc = spawn("gh", ["gist", "create", "--public=false", tmpFile], {
        shell: process.platform === "win32"
      });
      let stdout = "";
      let stderr = "";
      proc.stdout?.on("data", (data) => {
        stdout += data.toString();
      });
      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
      });
      proc.on("close", (code) => resolve({ stdout, stderr, code }));
    });
    if (loader.signal.aborted) return;
    restoreEditor();
    if (result.code !== 0) {
      const errorMsg = result.stderr?.trim() || "Unknown error";
      ctx.showError(`Failed to create gist: ${errorMsg}`);
      return;
    }
    const gistUrl = result.stdout?.trim();
    const gistId = gistUrl?.split("/").pop();
    if (!gistId) {
      ctx.showError("Failed to parse gist ID from gh output");
      return;
    }
    const previewUrl = getShareViewerUrl(gistId);
    ctx.showStatus(`Share URL: ${previewUrl}
Gist: ${gistUrl}`);
  } catch (error) {
    if (!loader.signal.aborted) {
      restoreEditor();
      ctx.showError(`Failed to create gist: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }
}
function handleCopyCommand(ctx) {
  const text = ctx.session.getLastAssistantText();
  if (!text) {
    ctx.showError("No agent messages to copy yet.");
    return;
  }
  try {
    copyToClipboard(text);
    ctx.showStatus("Copied last agent message to clipboard");
  } catch (error) {
    ctx.showError(error instanceof Error ? error.message : String(error));
  }
}
function handleNameCommand(text, ctx) {
  const name = text.replace(/^\/name\s*/, "").trim();
  if (!name) {
    const currentName = ctx.sessionManager.getSessionName();
    if (currentName) {
      ctx.chatContainer.addChild(new Spacer(1));
      ctx.chatContainer.addChild(new Text(theme.fg("dim", `Session name: ${currentName}`), 1, 0));
    } else {
      ctx.showWarning("Usage: /name <name>");
    }
    ctx.requestRender();
    return;
  }
  ctx.sessionManager.appendSessionInfo(name);
  ctx.updateTerminalTitle();
  ctx.chatContainer.addChild(new Spacer(1));
  ctx.chatContainer.addChild(new Text(theme.fg("dim", `Session name set: ${name}`), 1, 0));
  ctx.requestRender();
}
function handleSessionCommand(ctx) {
  const stats = ctx.session.getSessionStats();
  const sessionName = ctx.sessionManager.getSessionName();
  let info = `${theme.bold("Session Info")}

`;
  if (sessionName) {
    info += `${theme.fg("dim", "Name:")} ${sessionName}
`;
  }
  info += `${theme.fg("dim", "File:")} ${stats.sessionFile ?? "In-memory"}
`;
  info += `${theme.fg("dim", "ID:")} ${stats.sessionId}

`;
  info += `${theme.bold("Messages")}
`;
  info += `${theme.fg("dim", "User:")} ${stats.userMessages}
`;
  info += `${theme.fg("dim", "Assistant:")} ${stats.assistantMessages}
`;
  info += `${theme.fg("dim", "Tool Calls:")} ${stats.toolCalls}
`;
  info += `${theme.fg("dim", "Tool Results:")} ${stats.toolResults}
`;
  info += `${theme.fg("dim", "Total:")} ${stats.totalMessages}

`;
  info += `${theme.bold("Tokens")}
`;
  info += `${theme.fg("dim", "Input:")} ${stats.tokens.input.toLocaleString()}
`;
  info += `${theme.fg("dim", "Output:")} ${stats.tokens.output.toLocaleString()}
`;
  if (stats.tokens.cacheRead > 0) {
    info += `${theme.fg("dim", "Cache Read:")} ${stats.tokens.cacheRead.toLocaleString()}
`;
  }
  if (stats.tokens.cacheWrite > 0) {
    info += `${theme.fg("dim", "Cache Write:")} ${stats.tokens.cacheWrite.toLocaleString()}
`;
  }
  info += `${theme.fg("dim", "Total:")} ${stats.tokens.total.toLocaleString()}
`;
  if (stats.cost > 0) {
    info += `
${theme.bold("Cost")}
`;
    info += `${theme.fg("dim", "Total:")} ${stats.cost.toFixed(4)}`;
  }
  ctx.chatContainer.addChild(new Spacer(1));
  ctx.chatContainer.addChild(new Text(info, 1, 0));
  ctx.requestRender();
}
function handleChangelogCommand(ctx) {
  const changelogPath = getChangelogPath();
  const allEntries = parseChangelog(changelogPath);
  const changelogMarkdown = allEntries.length > 0 ? allEntries.reverse().map((e) => e.content).join("\n\n") : "No changelog entries found.";
  ctx.chatContainer.addChild(new Spacer(1));
  ctx.chatContainer.addChild(new DynamicBorder());
  ctx.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
  ctx.chatContainer.addChild(new Spacer(1));
  ctx.chatContainer.addChild(new Markdown(changelogMarkdown, 1, 1, ctx.getMarkdownThemeWithSettings()));
  ctx.chatContainer.addChild(new DynamicBorder());
  ctx.requestRender();
}
function capitalizeKey(key) {
  return key.split("/").map(
    (k) => k.split("+").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("+")
  ).join("/");
}
function getAppKeyDisplay(keybindings, action) {
  return capitalizeKey(appKey(keybindings, action));
}
function getEditorKeyDisplay(action) {
  return capitalizeKey(editorKey(action));
}
function handleHotkeysCommand(ctx) {
  const cursorWordLeft = getEditorKeyDisplay("cursorWordLeft");
  const cursorWordRight = getEditorKeyDisplay("cursorWordRight");
  const cursorLineStart = getEditorKeyDisplay("cursorLineStart");
  const cursorLineEnd = getEditorKeyDisplay("cursorLineEnd");
  const jumpForward = getEditorKeyDisplay("jumpForward");
  const jumpBackward = getEditorKeyDisplay("jumpBackward");
  const pageUp = getEditorKeyDisplay("pageUp");
  const pageDown = getEditorKeyDisplay("pageDown");
  const submit = getEditorKeyDisplay("submit");
  const newLine = getEditorKeyDisplay("newLine");
  const deleteWordBackward = getEditorKeyDisplay("deleteWordBackward");
  const deleteWordForward = getEditorKeyDisplay("deleteWordForward");
  const deleteToLineStart = getEditorKeyDisplay("deleteToLineStart");
  const deleteToLineEnd = getEditorKeyDisplay("deleteToLineEnd");
  const yank = getEditorKeyDisplay("yank");
  const yankPop = getEditorKeyDisplay("yankPop");
  const undo = getEditorKeyDisplay("undo");
  const tab = getEditorKeyDisplay("tab");
  const interrupt = getAppKeyDisplay(ctx.keybindings, "interrupt");
  const clear = getAppKeyDisplay(ctx.keybindings, "clear");
  const exit = getAppKeyDisplay(ctx.keybindings, "exit");
  const suspend = getAppKeyDisplay(ctx.keybindings, "suspend");
  const cycleThinkingLevel = getAppKeyDisplay(ctx.keybindings, "cycleThinkingLevel");
  const cycleModelForward = getAppKeyDisplay(ctx.keybindings, "cycleModelForward");
  const cycleModelBackward = getAppKeyDisplay(ctx.keybindings, "cycleModelBackward");
  const selectModel = getAppKeyDisplay(ctx.keybindings, "selectModel");
  const expandTools = getAppKeyDisplay(ctx.keybindings, "expandTools");
  const toggleThinking = getAppKeyDisplay(ctx.keybindings, "toggleThinking");
  const externalEditor = getAppKeyDisplay(ctx.keybindings, "externalEditor");
  const followUp = getAppKeyDisplay(ctx.keybindings, "followUp");
  const dequeue = getAppKeyDisplay(ctx.keybindings, "dequeue");
  const pasteImage = getAppKeyDisplay(ctx.keybindings, "pasteImage");
  let hotkeys = `
**Navigation**
| Key | Action |
|-----|--------|
| \`Arrow keys\` | Move cursor / browse history (Up when empty) |
| \`${cursorWordLeft}\` / \`${cursorWordRight}\` | Move by word |
| \`${cursorLineStart}\` | Start of line |
| \`${cursorLineEnd}\` | End of line |
| \`${jumpForward}\` | Jump forward to character |
| \`${jumpBackward}\` | Jump backward to character |
| \`${pageUp}\` / \`${pageDown}\` | Scroll by page |

**Editing**
| Key | Action |
|-----|--------|
| \`${submit}\` | Send message |
| \`${newLine}\` | New line${process.platform === "win32" ? " (Ctrl+Enter on Windows Terminal)" : ""} |
| \`${deleteWordBackward}\` | Delete word backwards |
| \`${deleteWordForward}\` | Delete word forwards |
| \`${deleteToLineStart}\` | Delete to start of line |
| \`${deleteToLineEnd}\` | Delete to end of line |
| \`${yank}\` | Paste the most-recently-deleted text |
| \`${yankPop}\` | Cycle through the deleted text after pasting |
| \`${undo}\` | Undo |

**Other**
| Key | Action |
|-----|--------|
| \`${tab}\` | Path completion / accept autocomplete |
| \`${interrupt}\` | Cancel autocomplete / abort streaming |
| \`${clear}\` | Clear editor (first) / exit (second) |
| \`${exit}\` | Exit (when editor is empty) |
| \`${suspend}\` | Suspend to background |
| \`${cycleThinkingLevel}\` | Cycle thinking level |
| \`${cycleModelForward}\` / \`${cycleModelBackward}\` | Cycle models |
| \`${selectModel}\` | Open model selector |
| \`${expandTools}\` | Toggle tool output expansion |
| \`${toggleThinking}\` | Toggle thinking block visibility |
| \`${externalEditor}\` | Edit message in external editor |
| \`${followUp}\` | Queue follow-up message |
| \`${dequeue}\` | Restore queued messages |
| \`${pasteImage}\` | Paste image from clipboard |
| \`/\` | Slash commands |
| \`!\` | Run bash command |
| \`!!\` | Run bash command (excluded from context) |
`;
  const extensionRunner = ctx.session.extensionRunner;
  if (extensionRunner) {
    const shortcuts = extensionRunner.getShortcuts(ctx.keybindings.getEffectiveConfig());
    if (shortcuts.size > 0) {
      hotkeys += `
**Extensions**
| Key | Action |
|-----|--------|
`;
      for (const [key, shortcut] of shortcuts) {
        const description = shortcut.description ?? shortcut.extensionPath;
        const keyDisplay = formatKeyForDisplay(key).replace(/\b\w/g, (c) => c.toUpperCase());
        hotkeys += `| \`${keyDisplay}\` | ${description} |
`;
      }
    }
  }
  ctx.chatContainer.addChild(new Spacer(1));
  ctx.chatContainer.addChild(new DynamicBorder());
  ctx.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "Keyboard Shortcuts")), 1, 0));
  ctx.chatContainer.addChild(new Spacer(1));
  ctx.chatContainer.addChild(new Markdown(hotkeys.trim(), 1, 1, ctx.getMarkdownThemeWithSettings()));
  ctx.chatContainer.addChild(new DynamicBorder());
  ctx.requestRender();
}
async function handleCompactCommand(customInstructions, ctx) {
  const entries = ctx.sessionManager.getEntries();
  const messageCount = entries.filter((e) => e.type === "message").length;
  if (messageCount < 2) {
    ctx.showWarning("Nothing to compact (no messages yet)");
    return;
  }
  await ctx.executeCompaction(customInstructions, false);
}
function handleThinkingCommand(arg, ctx) {
  if (!ctx.session.supportsThinking()) {
    ctx.showStatus("Current model does not support thinking");
    return;
  }
  const availableLevels = ctx.session.getAvailableThinkingLevels();
  if (arg) {
    const level = arg.toLowerCase();
    if (!availableLevels.includes(level)) {
      ctx.showStatus(`Invalid thinking level "${arg}". Available: ${availableLevels.join(", ")}`);
      return;
    }
    ctx.session.setThinkingLevel(level);
    ctx.invalidateFooter();
    ctx.updateEditorBorderColor();
    ctx.showStatus(`Thinking level: ${level}`);
    return;
  }
  showThinkingSelector(ctx, availableLevels);
}
function showThinkingSelector(ctx, availableLevels) {
  ctx.showSelector((done) => {
    const selector = new SelectSubmenu(
      "Thinking Level",
      "Select reasoning depth for thinking-capable models",
      availableLevels.map((level) => ({
        value: level,
        label: level,
        description: THINKING_DESCRIPTIONS[level]
      })),
      ctx.session.thinkingLevel,
      (value) => {
        ctx.session.setThinkingLevel(value);
        ctx.invalidateFooter();
        ctx.updateEditorBorderColor();
        done();
        ctx.showStatus(`Thinking level: ${value}`);
      },
      () => {
        done();
      }
    );
    return { component: selector, focus: selector };
  });
}
function handleEditModeCommand(arg, ctx) {
  const modes = ["standard", "hashline"];
  if (arg) {
    const mode = arg.toLowerCase();
    if (!modes.includes(mode)) {
      ctx.showStatus(`Invalid edit mode "${arg}". Available: standard, hashline`);
      return;
    }
    ctx.session.setEditMode(mode);
    ctx.showStatus(`Edit mode: ${mode}${mode === "hashline" ? " (LINE#ID anchored edits)" : " (text-match edits)"}`);
    return;
  }
  const current = ctx.session.editMode;
  const next = current === "standard" ? "hashline" : "standard";
  ctx.session.setEditMode(next);
  ctx.showStatus(`Edit mode: ${next}${next === "hashline" ? " (LINE#ID anchored edits)" : " (text-match edits)"}`);
}
function handleTuiCommand(text, ctx) {
  const parts = text.trim().split(/\s+/);
  const mode = parts[1] === "mode" ? parts[2] : parts[1];
  const valid = ["auto", "chat", "workflow", "validation", "debug", "compact"];
  if (!mode) {
    ctx.showStatus(`TUI mode: ${ctx.settingsManager.getAdaptiveMode()}`);
    return;
  }
  if (!valid.includes(mode)) {
    ctx.showWarning(`Usage: /tui mode ${valid.join("|")}`);
    return;
  }
  ctx.settingsManager.setAdaptiveMode(mode);
  ctx.showStatus(`TUI mode: ${mode}`);
  ctx.requestRender();
}
function handleArminSaysHi(ctx) {
  ctx.chatContainer.addChild(new Spacer(1));
  ctx.chatContainer.addChild(new ArminComponent(ctx.ui));
  ctx.requestRender();
}
export {
  capitalizeKey,
  dispatchSlashCommand,
  getAppKeyDisplay
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9tb2Rlcy9pbnRlcmFjdGl2ZS9zbGFzaC1jb21tYW5kLWhhbmRsZXJzLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFNsYXNoIGNvbW1hbmQgZGlzcGF0Y2ggYW5kIGhhbmRsZXIgaW1wbGVtZW50YXRpb25zIGV4dHJhY3RlZCBmcm9tIEludGVyYWN0aXZlTW9kZS5cbiAqXG4gKiBUaGUgYGRpc3BhdGNoU2xhc2hDb21tYW5kYCBmdW5jdGlvbiBjb250YWlucyB0aGUgZGlzcGF0Y2ggbG9naWMgKHJvdXRpbmcgdGV4dFxuICogdG8gaGFuZGxlcnMpLCBhbmQgaW5kaXZpZHVhbCBoYW5kbGVyIGZ1bmN0aW9ucyBpbXBsZW1lbnQgZWFjaCBjb21tYW5kLlxuICpcbiAqIEhhbmRsZXJzIHRoYXQgYXJlIGFsc28gaW52b2tlZCBmcm9tIGtleWJpbmRpbmdzIG9yIG90aGVyIHN1YnN5c3RlbXMgcmVtYWluIG9uXG4gKiBJbnRlcmFjdGl2ZU1vZGUgYW5kIGFyZSBjYWxsZWQgdGhyb3VnaCB0aGUgYFNsYXNoQ29tbWFuZENvbnRleHRgIGludGVyZmFjZS5cbiAqL1xuXG5pbXBvcnQgKiBhcyBmcyBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0ICogYXMgb3MgZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCAqIGFzIHBhdGggZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHR5cGUgeyBUaGlua2luZ0xldmVsIH0gZnJvbSBcIkBnc2QvcGktYWdlbnQtY29yZVwiO1xuaW1wb3J0IHR5cGUge1xuXHRFZGl0b3JBY3Rpb24sXG5cdEVkaXRvckNvbXBvbmVudCxcblx0TWFya2Rvd25UaGVtZSxcbn0gZnJvbSBcIkBnc2QvcGktdHVpXCI7XG5pbXBvcnQge1xuXHR0eXBlIENvbXBvbmVudCxcblx0Q29udGFpbmVyLFxuXHRNYXJrZG93bixcblx0U3BhY2VyLFxuXHRUZXh0LFxufSBmcm9tIFwiQGdzZC9waS10dWlcIjtcbmltcG9ydCB7IHNwYXduLCBzcGF3blN5bmMgfSBmcm9tIFwiY2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHtcblx0Z2V0U2hhcmVWaWV3ZXJVcmwsXG59IGZyb20gXCIuLi8uLi9jb25maWcuanNcIjtcbmltcG9ydCB0eXBlIHsgQWdlbnRTZXNzaW9uIH0gZnJvbSBcIi4uLy4uL2NvcmUvYWdlbnQtc2Vzc2lvbi5qc1wiO1xuaW1wb3J0IHR5cGUgeyBBcHBBY3Rpb24sIEtleWJpbmRpbmdzTWFuYWdlciB9IGZyb20gXCIuLi8uLi9jb3JlL2tleWJpbmRpbmdzLmpzXCI7XG5pbXBvcnQgdHlwZSB7IFNlc3Npb25NYW5hZ2VyIH0gZnJvbSBcIi4uLy4uL2NvcmUvc2Vzc2lvbi1tYW5hZ2VyLmpzXCI7XG5pbXBvcnQgdHlwZSB7IEFkYXB0aXZlVHVpTW9kZSwgU2V0dGluZ3NNYW5hZ2VyIH0gZnJvbSBcIi4uLy4uL2NvcmUvc2V0dGluZ3MtbWFuYWdlci5qc1wiO1xuaW1wb3J0IHsgY29weVRvQ2xpcGJvYXJkIH0gZnJvbSBcIi4uLy4uL3V0aWxzL2NsaXBib2FyZC5qc1wiO1xuaW1wb3J0IHsgZ2V0Q2hhbmdlbG9nUGF0aCwgcGFyc2VDaGFuZ2Vsb2cgfSBmcm9tIFwiLi4vLi4vdXRpbHMvY2hhbmdlbG9nLmpzXCI7XG5pbXBvcnQgeyBBcm1pbkNvbXBvbmVudCB9IGZyb20gXCIuL2NvbXBvbmVudHMvYXJtaW4uanNcIjtcbmltcG9ydCB7IEJvcmRlcmVkTG9hZGVyIH0gZnJvbSBcIi4vY29tcG9uZW50cy9ib3JkZXJlZC1sb2FkZXIuanNcIjtcbmltcG9ydCB7IER5bmFtaWNCb3JkZXIgfSBmcm9tIFwiLi9jb21wb25lbnRzL2R5bmFtaWMtYm9yZGVyLmpzXCI7XG5pbXBvcnQgeyBhcHBLZXksIGVkaXRvcktleSwgZm9ybWF0S2V5Rm9yRGlzcGxheSB9IGZyb20gXCIuL2NvbXBvbmVudHMva2V5YmluZGluZy1oaW50cy5qc1wiO1xuaW1wb3J0IHsgU2VsZWN0U3VibWVudSwgVEhJTktJTkdfREVTQ1JJUFRJT05TIH0gZnJvbSBcIi4vY29tcG9uZW50cy9zZXR0aW5ncy1zZWxlY3Rvci5qc1wiO1xuaW1wb3J0IHsgdGhlbWUgfSBmcm9tIFwiLi90aGVtZS90aGVtZS5qc1wiO1xuXG5pbXBvcnQgdHlwZSB7IFRVSSB9IGZyb20gXCJAZ3NkL3BpLXR1aVwiO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIENvbnRleHQgaW50ZXJmYWNlIFx1MjAxNCB0aGUgc3Vic2V0IG9mIEludGVyYWN0aXZlTW9kZSBuZWVkZWQgYnkgc2xhc2ggY29tbWFuZHNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKipcbiAqIFByb3ZpZGVzIHNsYXNoIGNvbW1hbmQgaGFuZGxlcnMgd2l0aCBhY2Nlc3MgdG8gdGhlIHBhcnRzIG9mIEludGVyYWN0aXZlTW9kZVxuICogdGhleSBuZWVkIHdpdGhvdXQgY291cGxpbmcgdGhlbSB0byB0aGUgZW50aXJlIGNsYXNzLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIFNsYXNoQ29tbWFuZENvbnRleHQge1xuXHQvLyBDb3JlIG9iamVjdHNcblx0cmVhZG9ubHkgc2Vzc2lvbjogQWdlbnRTZXNzaW9uO1xuXHRyZWFkb25seSB1aTogVFVJO1xuXHRyZWFkb25seSBrZXliaW5kaW5nczogS2V5YmluZGluZ3NNYW5hZ2VyO1xuXG5cdC8vIENvbnRhaW5lcnNcblx0cmVhZG9ubHkgY2hhdENvbnRhaW5lcjogQ29udGFpbmVyO1xuXHRyZWFkb25seSBzdGF0dXNDb250YWluZXI6IENvbnRhaW5lcjtcblx0cmVhZG9ubHkgZWRpdG9yQ29udGFpbmVyOiBDb250YWluZXI7XG5cdHJlYWRvbmx5IGhlYWRlckNvbnRhaW5lcjogQ29udGFpbmVyO1xuXHRyZWFkb25seSBwZW5kaW5nTWVzc2FnZXNDb250YWluZXI6IENvbnRhaW5lcjtcblxuXHQvLyBFZGl0b3Jcblx0cmVhZG9ubHkgZWRpdG9yOiBFZGl0b3JDb21wb25lbnQ7XG5cdHJlYWRvbmx5IGRlZmF1bHRFZGl0b3I6IEVkaXRvckNvbXBvbmVudCAmIHtcblx0XHRvbkVzY2FwZT86ICgpID0+IHZvaWQ7XG5cdH07XG5cblx0Ly8gQWNjZXNzb3JzXG5cdHJlYWRvbmx5IHNlc3Npb25NYW5hZ2VyOiBTZXNzaW9uTWFuYWdlcjtcblx0cmVhZG9ubHkgc2V0dGluZ3NNYW5hZ2VyOiBTZXR0aW5nc01hbmFnZXI7XG5cblx0Ly8gRm9vdGVyXG5cdGludmFsaWRhdGVGb290ZXIoKTogdm9pZDtcblxuXHQvLyBVSSBoZWxwZXJzXG5cdHNob3dTdGF0dXMobWVzc2FnZTogc3RyaW5nKTogdm9pZDtcblx0c2hvd0Vycm9yKG1lc3NhZ2U6IHN0cmluZyk6IHZvaWQ7XG5cdHNob3dXYXJuaW5nKG1lc3NhZ2U6IHN0cmluZyk6IHZvaWQ7XG5cdHNob3dTZWxlY3RvcihjcmVhdGU6IChkb25lOiAoKSA9PiB2b2lkKSA9PiB7IGNvbXBvbmVudDogQ29tcG9uZW50OyBmb2N1czogQ29tcG9uZW50IH0pOiB2b2lkO1xuXHR1cGRhdGVFZGl0b3JCb3JkZXJDb2xvcigpOiB2b2lkO1xuXHRnZXRNYXJrZG93blRoZW1lV2l0aFNldHRpbmdzKCk6IE1hcmtkb3duVGhlbWU7XG5cdHJlcXVlc3RSZW5kZXIoKTogdm9pZDtcblxuXHR1cGRhdGVUZXJtaW5hbFRpdGxlKCk6IHZvaWQ7XG5cblx0Ly8gTWV0aG9kcyB0aGF0IHN0YXkgb24gSW50ZXJhY3RpdmVNb2RlIChjYWxsZWQgZnJvbSBib3RoIGRpc3BhdGNoIGFuZCBrZXliaW5kaW5ncy9ldmVudHMpXG5cdHNob3dTZXR0aW5nc1NlbGVjdG9yKCk6IHZvaWQ7XG5cdHNob3dNb2RlbHNTZWxlY3RvcigpOiBQcm9taXNlPHZvaWQ+O1xuXHRoYW5kbGVNb2RlbENvbW1hbmQoc2VhcmNoVGVybT86IHN0cmluZyk6IFByb21pc2U8dm9pZD47XG5cdHNob3dVc2VyTWVzc2FnZVNlbGVjdG9yKCk6IHZvaWQ7XG5cdHNob3dUcmVlU2VsZWN0b3IoKTogdm9pZDtcblx0c2hvd1Byb3ZpZGVyTWFuYWdlcigpOiB2b2lkO1xuXHRzaG93T0F1dGhTZWxlY3Rvcihtb2RlOiBcImxvZ2luXCIgfCBcImxvZ291dFwiKTogUHJvbWlzZTx2b2lkPjtcblx0c2hvd1Nlc3Npb25TZWxlY3RvcigpOiB2b2lkO1xuXHRoYW5kbGVDbGVhckNvbW1hbmQoKTogUHJvbWlzZTx2b2lkPjtcblx0aGFuZGxlUmVsb2FkQ29tbWFuZCgpOiBQcm9taXNlPHZvaWQ+O1xuXHRoYW5kbGVEZWJ1Z0NvbW1hbmQoKTogdm9pZDtcblx0c2h1dGRvd24oKTogUHJvbWlzZTx2b2lkPjtcblxuXHQvLyBGb3IgY29tcGFjdGlvblxuXHRleGVjdXRlQ29tcGFjdGlvbihjdXN0b21JbnN0cnVjdGlvbnM/OiBzdHJpbmcsIGlzQXV0bz86IGJvb2xlYW4pOiBQcm9taXNlPHVua25vd24+O1xuXG5cdC8vIEJhc2ggZXhlY3V0aW9uXG5cdGhhbmRsZUJhc2hDb21tYW5kKGNvbW1hbmQ6IHN0cmluZywgb3B0aW9ucz86IHsgZXhjbHVkZUZyb21Db250ZXh0PzogYm9vbGVhbjsgZGlzcGxheUNvbW1hbmQ/OiBzdHJpbmc7IGxvZ2luU2hlbGw/OiBib29sZWFuIH0pOiBQcm9taXNlPHZvaWQ+O1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIERpc3BhdGNoXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiBSb3V0ZXMgYSBzbGFzaCBjb21tYW5kIHN0cmluZyB0byB0aGUgYXBwcm9wcmlhdGUgaGFuZGxlci5cbiAqXG4gKiBAcmV0dXJucyBgdHJ1ZWAgaWYgdGhlIHRleHQgd2FzIGhhbmRsZWQgYXMgYSBzbGFzaCBjb21tYW5kIChjYWxsZXIgc2hvdWxkXG4gKiAgICAgICAgICBub3QgcHJvY2VzcyBpdCBmdXJ0aGVyKSwgYGZhbHNlYCBvdGhlcndpc2UuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBkaXNwYXRjaFNsYXNoQ29tbWFuZChcblx0dGV4dDogc3RyaW5nLFxuXHRjdHg6IFNsYXNoQ29tbWFuZENvbnRleHQsXG4pOiBQcm9taXNlPGJvb2xlYW4+IHtcblx0aWYgKHRleHQgPT09IFwiL3NldHRpbmdzXCIpIHtcblx0XHRjdHguc2hvd1NldHRpbmdzU2VsZWN0b3IoKTtcblx0XHRyZXR1cm4gdHJ1ZTtcblx0fVxuXHRpZiAodGV4dCA9PT0gXCIvc2NvcGVkLW1vZGVsc1wiKSB7XG5cdFx0YXdhaXQgY3R4LnNob3dNb2RlbHNTZWxlY3RvcigpO1xuXHRcdHJldHVybiB0cnVlO1xuXHR9XG5cdGlmICh0ZXh0ID09PSBcIi9tb2RlbFwiIHx8IHRleHQuc3RhcnRzV2l0aChcIi9tb2RlbCBcIikpIHtcblx0XHRjb25zdCBzZWFyY2hUZXJtID0gdGV4dC5zdGFydHNXaXRoKFwiL21vZGVsIFwiKSA/IHRleHQuc2xpY2UoNykudHJpbSgpIDogdW5kZWZpbmVkO1xuXHRcdGF3YWl0IGN0eC5oYW5kbGVNb2RlbENvbW1hbmQoc2VhcmNoVGVybSk7XG5cdFx0cmV0dXJuIHRydWU7XG5cdH1cblx0aWYgKHRleHQgPT09IFwiL2V4cG9ydFwiIHx8IHRleHQuc3RhcnRzV2l0aChcIi9leHBvcnQgXCIpKSB7XG5cdFx0YXdhaXQgaGFuZGxlRXhwb3J0Q29tbWFuZCh0ZXh0LCBjdHgpO1xuXHRcdHJldHVybiB0cnVlO1xuXHR9XG5cdGlmICh0ZXh0ID09PSBcIi9zaGFyZVwiKSB7XG5cdFx0YXdhaXQgaGFuZGxlU2hhcmVDb21tYW5kKGN0eCk7XG5cdFx0cmV0dXJuIHRydWU7XG5cdH1cblx0aWYgKHRleHQgPT09IFwiL2NvcHlcIikge1xuXHRcdGhhbmRsZUNvcHlDb21tYW5kKGN0eCk7XG5cdFx0cmV0dXJuIHRydWU7XG5cdH1cblx0aWYgKHRleHQgPT09IFwiL25hbWVcIiB8fCB0ZXh0LnN0YXJ0c1dpdGgoXCIvbmFtZSBcIikpIHtcblx0XHRoYW5kbGVOYW1lQ29tbWFuZCh0ZXh0LCBjdHgpO1xuXHRcdHJldHVybiB0cnVlO1xuXHR9XG5cdGlmICh0ZXh0ID09PSBcIi9zZXNzaW9uXCIpIHtcblx0XHRoYW5kbGVTZXNzaW9uQ29tbWFuZChjdHgpO1xuXHRcdHJldHVybiB0cnVlO1xuXHR9XG5cdGlmICh0ZXh0ID09PSBcIi9jaGFuZ2Vsb2dcIikge1xuXHRcdGhhbmRsZUNoYW5nZWxvZ0NvbW1hbmQoY3R4KTtcblx0XHRyZXR1cm4gdHJ1ZTtcblx0fVxuXHRpZiAodGV4dCA9PT0gXCIvaG90a2V5c1wiKSB7XG5cdFx0aGFuZGxlSG90a2V5c0NvbW1hbmQoY3R4KTtcblx0XHRyZXR1cm4gdHJ1ZTtcblx0fVxuXHRpZiAodGV4dCA9PT0gXCIvZm9ya1wiKSB7XG5cdFx0Y3R4LnNob3dVc2VyTWVzc2FnZVNlbGVjdG9yKCk7XG5cdFx0cmV0dXJuIHRydWU7XG5cdH1cblx0aWYgKHRleHQgPT09IFwiL3RyZWVcIikge1xuXHRcdGN0eC5zaG93VHJlZVNlbGVjdG9yKCk7XG5cdFx0cmV0dXJuIHRydWU7XG5cdH1cblx0aWYgKHRleHQgPT09IFwiL3Byb3ZpZGVyXCIpIHtcblx0XHRjdHguc2hvd1Byb3ZpZGVyTWFuYWdlcigpO1xuXHRcdHJldHVybiB0cnVlO1xuXHR9XG5cdGlmICh0ZXh0ID09PSBcIi9sb2dpblwiKSB7XG5cdFx0YXdhaXQgY3R4LnNob3dPQXV0aFNlbGVjdG9yKFwibG9naW5cIik7XG5cdFx0cmV0dXJuIHRydWU7XG5cdH1cblx0aWYgKHRleHQgPT09IFwiL2xvZ291dFwiKSB7XG5cdFx0YXdhaXQgY3R4LnNob3dPQXV0aFNlbGVjdG9yKFwibG9nb3V0XCIpO1xuXHRcdHJldHVybiB0cnVlO1xuXHR9XG5cdGlmICh0ZXh0ID09PSBcIi9uZXdcIikge1xuXHRcdGF3YWl0IGN0eC5oYW5kbGVDbGVhckNvbW1hbmQoKTtcblx0XHRyZXR1cm4gdHJ1ZTtcblx0fVxuXHRpZiAodGV4dCA9PT0gXCIvY29tcGFjdFwiIHx8IHRleHQuc3RhcnRzV2l0aChcIi9jb21wYWN0IFwiKSkge1xuXHRcdGNvbnN0IGN1c3RvbUluc3RydWN0aW9ucyA9IHRleHQuc3RhcnRzV2l0aChcIi9jb21wYWN0IFwiKSA/IHRleHQuc2xpY2UoOSkudHJpbSgpIDogdW5kZWZpbmVkO1xuXHRcdGF3YWl0IGhhbmRsZUNvbXBhY3RDb21tYW5kKGN1c3RvbUluc3RydWN0aW9ucywgY3R4KTtcblx0XHRyZXR1cm4gdHJ1ZTtcblx0fVxuXHRpZiAodGV4dCA9PT0gXCIvcmVsb2FkXCIpIHtcblx0XHRhd2FpdCBjdHguaGFuZGxlUmVsb2FkQ29tbWFuZCgpO1xuXHRcdHJldHVybiB0cnVlO1xuXHR9XG5cdGlmICh0ZXh0ID09PSBcIi90aGlua2luZ1wiIHx8IHRleHQuc3RhcnRzV2l0aChcIi90aGlua2luZyBcIikpIHtcblx0XHRjb25zdCBhcmcgPSB0ZXh0LnN0YXJ0c1dpdGgoXCIvdGhpbmtpbmcgXCIpID8gdGV4dC5zbGljZSgxMCkudHJpbSgpIDogdW5kZWZpbmVkO1xuXHRcdGhhbmRsZVRoaW5raW5nQ29tbWFuZChhcmcsIGN0eCk7XG5cdFx0cmV0dXJuIHRydWU7XG5cdH1cblx0aWYgKHRleHQgPT09IFwiL2VkaXQtbW9kZVwiIHx8IHRleHQuc3RhcnRzV2l0aChcIi9lZGl0LW1vZGUgXCIpKSB7XG5cdFx0Y29uc3QgYXJnID0gdGV4dC5zdGFydHNXaXRoKFwiL2VkaXQtbW9kZSBcIikgPyB0ZXh0LnNsaWNlKDExKS50cmltKCkgOiB1bmRlZmluZWQ7XG5cdFx0aGFuZGxlRWRpdE1vZGVDb21tYW5kKGFyZywgY3R4KTtcblx0XHRyZXR1cm4gdHJ1ZTtcblx0fVxuXHRpZiAodGV4dCA9PT0gXCIvZGVidWdcIikge1xuXHRcdGN0eC5oYW5kbGVEZWJ1Z0NvbW1hbmQoKTtcblx0XHRyZXR1cm4gdHJ1ZTtcblx0fVxuXHRpZiAodGV4dCA9PT0gXCIvYXJtaW5zYXlzaGlcIikge1xuXHRcdGhhbmRsZUFybWluU2F5c0hpKGN0eCk7XG5cdFx0cmV0dXJuIHRydWU7XG5cdH1cblx0aWYgKHRleHQgPT09IFwiL3Jlc3VtZVwiKSB7XG5cdFx0Y3R4LnNob3dTZXNzaW9uU2VsZWN0b3IoKTtcblx0XHRyZXR1cm4gdHJ1ZTtcblx0fVxuXHRpZiAodGV4dCA9PT0gXCIvcXVpdFwiKSB7XG5cdFx0YXdhaXQgY3R4LnNodXRkb3duKCk7XG5cdFx0cmV0dXJuIHRydWU7XG5cdH1cblx0aWYgKHRleHQgPT09IFwiL3Rlcm1pbmFsXCIgfHwgdGV4dC5zdGFydHNXaXRoKFwiL3Rlcm1pbmFsIFwiKSkge1xuXHRcdGNvbnN0IGNvbW1hbmQgPSB0ZXh0LnN0YXJ0c1dpdGgoXCIvdGVybWluYWwgXCIpID8gdGV4dC5zbGljZSgxMCkudHJpbSgpIDogXCJcIjtcblx0XHRpZiAoIWNvbW1hbmQpIHtcblx0XHRcdGN0eC5zaG93V2FybmluZyhcIlVzYWdlOiAvdGVybWluYWwgPGNvbW1hbmQ+ICAoZS5nLiAvdGVybWluYWwgcGluZyAtYzMgMS4xLjEuMSlcIik7XG5cdFx0XHRyZXR1cm4gdHJ1ZTtcblx0XHR9XG5cdFx0Ly8gUnVuIGluIHRoZSB1c2VyJ3MgbG9naW4gc2hlbGwgKCRTSEVMTCAtbCAtYykgc28gUEFUSCBhZGRpdGlvbnNcblx0XHQvLyBhbmQgZW52IHZhcnMgZnJvbSBzaGVsbCBwcm9maWxlcyAoLnpwcm9maWxlLy5wcm9maWxlKSBhcmUgYXZhaWxhYmxlLlxuXHRcdC8vIE5vdGU6IHNoZWxsIGFsaWFzZXMgYXJlIG5vdCBsb2FkZWQgKHJlcXVpcmVzIC1pIHdoaWNoIGhhcyBzaWRlIGVmZmVjdHMpLlxuXHRcdGF3YWl0IGN0eC5oYW5kbGVCYXNoQ29tbWFuZChjb21tYW5kLCB7IGxvZ2luU2hlbGw6IHRydWUgfSk7XG5cdFx0cmV0dXJuIHRydWU7XG5cdH1cblx0aWYgKHRleHQgPT09IFwiL3R1aVwiIHx8IHRleHQuc3RhcnRzV2l0aChcIi90dWkgXCIpKSB7XG5cdFx0aGFuZGxlVHVpQ29tbWFuZCh0ZXh0LCBjdHgpO1xuXHRcdHJldHVybiB0cnVlO1xuXHR9XG5cblx0cmV0dXJuIGZhbHNlO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIEluZGl2aWR1YWwgY29tbWFuZCBoYW5kbGVyc1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZUV4cG9ydENvbW1hbmQodGV4dDogc3RyaW5nLCBjdHg6IFNsYXNoQ29tbWFuZENvbnRleHQpOiBQcm9taXNlPHZvaWQ+IHtcblx0Y29uc3QgcGFydHMgPSB0ZXh0LnNwbGl0KC9cXHMrLyk7XG5cdGNvbnN0IG91dHB1dFBhdGggPSBwYXJ0cy5sZW5ndGggPiAxID8gcGFydHNbMV0gOiB1bmRlZmluZWQ7XG5cblx0dHJ5IHtcblx0XHRjb25zdCBmaWxlUGF0aCA9IGF3YWl0IGN0eC5zZXNzaW9uLmV4cG9ydFRvSHRtbChvdXRwdXRQYXRoKTtcblx0XHRjdHguc2hvd1N0YXR1cyhgU2Vzc2lvbiBleHBvcnRlZCB0bzogJHtmaWxlUGF0aH1gKTtcblx0fSBjYXRjaCAoZXJyb3I6IHVua25vd24pIHtcblx0XHRjdHguc2hvd0Vycm9yKGBGYWlsZWQgdG8gZXhwb3J0IHNlc3Npb246ICR7ZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBcIlVua25vd24gZXJyb3JcIn1gKTtcblx0fVxufVxuXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVTaGFyZUNvbW1hbmQoY3R4OiBTbGFzaENvbW1hbmRDb250ZXh0KTogUHJvbWlzZTx2b2lkPiB7XG5cdC8vIENoZWNrIGlmIGdoIGlzIGF2YWlsYWJsZSBhbmQgbG9nZ2VkIGluXG5cdHRyeSB7XG5cdFx0Y29uc3QgYXV0aFJlc3VsdCA9IHNwYXduU3luYyhcImdoXCIsIFtcImF1dGhcIiwgXCJzdGF0dXNcIl0sIHsgZW5jb2Rpbmc6IFwidXRmLThcIiB9KTtcblx0XHRpZiAoYXV0aFJlc3VsdC5zdGF0dXMgIT09IDApIHtcblx0XHRcdGN0eC5zaG93RXJyb3IoXCJHaXRIdWIgQ0xJIGlzIG5vdCBsb2dnZWQgaW4uIFJ1biAnZ2ggYXV0aCBsb2dpbicgZmlyc3QuXCIpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblx0fSBjYXRjaCB7XG5cdFx0Y3R4LnNob3dFcnJvcihcIkdpdEh1YiBDTEkgKGdoKSBpcyBub3QgaW5zdGFsbGVkLiBJbnN0YWxsIGl0IGZyb20gaHR0cHM6Ly9jbGkuZ2l0aHViLmNvbS9cIik7XG5cdFx0cmV0dXJuO1xuXHR9XG5cblx0Ly8gRXhwb3J0IHRvIGEgdGVtcCBmaWxlXG5cdGNvbnN0IHRtcEZpbGUgPSBwYXRoLmpvaW4ob3MudG1wZGlyKCksIFwic2Vzc2lvbi5odG1sXCIpO1xuXHR0cnkge1xuXHRcdGF3YWl0IGN0eC5zZXNzaW9uLmV4cG9ydFRvSHRtbCh0bXBGaWxlKTtcblx0fSBjYXRjaCAoZXJyb3I6IHVua25vd24pIHtcblx0XHRjdHguc2hvd0Vycm9yKGBGYWlsZWQgdG8gZXhwb3J0IHNlc3Npb246ICR7ZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBcIlVua25vd24gZXJyb3JcIn1gKTtcblx0XHRyZXR1cm47XG5cdH1cblxuXHQvLyBTaG93IGNhbmNlbGxhYmxlIGxvYWRlciwgcmVwbGFjaW5nIHRoZSBlZGl0b3Jcblx0Y29uc3QgbG9hZGVyID0gbmV3IEJvcmRlcmVkTG9hZGVyKGN0eC51aSwgdGhlbWUsIFwiQ3JlYXRpbmcgZ2lzdC4uLlwiKTtcblx0Y3R4LmVkaXRvckNvbnRhaW5lci5jbGVhcigpO1xuXHRjdHguZWRpdG9yQ29udGFpbmVyLmFkZENoaWxkKGxvYWRlcik7XG5cdGN0eC51aS5zZXRGb2N1cyhsb2FkZXIpO1xuXHRjdHgucmVxdWVzdFJlbmRlcigpO1xuXG5cdGNvbnN0IHJlc3RvcmVFZGl0b3IgPSAoKSA9PiB7XG5cdFx0bG9hZGVyLmRpc3Bvc2UoKTtcblx0XHRjdHguZWRpdG9yQ29udGFpbmVyLmNsZWFyKCk7XG5cdFx0Y3R4LmVkaXRvckNvbnRhaW5lci5hZGRDaGlsZChjdHguZWRpdG9yKTtcblx0XHRjdHgudWkuc2V0Rm9jdXMoY3R4LmVkaXRvcik7XG5cdFx0dHJ5IHtcblx0XHRcdGZzLnVubGlua1N5bmModG1wRmlsZSk7XG5cdFx0fSBjYXRjaCB7XG5cdFx0XHQvLyBJZ25vcmUgY2xlYW51cCBlcnJvcnNcblx0XHR9XG5cdH07XG5cblx0Ly8gQ3JlYXRlIGEgc2VjcmV0IGdpc3QgYXN5bmNocm9ub3VzbHlcblx0bGV0IHByb2M6IFJldHVyblR5cGU8dHlwZW9mIHNwYXduPiB8IG51bGwgPSBudWxsO1xuXG5cdGxvYWRlci5vbkFib3J0ID0gKCkgPT4ge1xuXHRcdHByb2M/LmtpbGwoKTtcblx0XHRyZXN0b3JlRWRpdG9yKCk7XG5cdFx0Y3R4LnNob3dTdGF0dXMoXCJTaGFyZSBjYW5jZWxsZWRcIik7XG5cdH07XG5cblx0XHR0cnkge1xuXHRcdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgbmV3IFByb21pc2U8eyBzdGRvdXQ6IHN0cmluZzsgc3RkZXJyOiBzdHJpbmc7IGNvZGU6IG51bWJlciB8IG51bGwgfT4oKHJlc29sdmUpID0+IHtcblx0XHRcdFx0cHJvYyA9IHNwYXduKFwiZ2hcIiwgW1wiZ2lzdFwiLCBcImNyZWF0ZVwiLCBcIi0tcHVibGljPWZhbHNlXCIsIHRtcEZpbGVdLCB7XG5cdFx0XHRcdFx0c2hlbGw6IHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIixcblx0XHRcdFx0fSk7XG5cdFx0XHRcdGxldCBzdGRvdXQgPSBcIlwiO1xuXHRcdFx0XHRsZXQgc3RkZXJyID0gXCJcIjtcblx0XHRcdHByb2Muc3Rkb3V0Py5vbihcImRhdGFcIiwgKGRhdGEpID0+IHtcblx0XHRcdFx0c3Rkb3V0ICs9IGRhdGEudG9TdHJpbmcoKTtcblx0XHRcdH0pO1xuXHRcdFx0cHJvYy5zdGRlcnI/Lm9uKFwiZGF0YVwiLCAoZGF0YSkgPT4ge1xuXHRcdFx0XHRzdGRlcnIgKz0gZGF0YS50b1N0cmluZygpO1xuXHRcdFx0fSk7XG5cdFx0XHRwcm9jLm9uKFwiY2xvc2VcIiwgKGNvZGUpID0+IHJlc29sdmUoeyBzdGRvdXQsIHN0ZGVyciwgY29kZSB9KSk7XG5cdFx0fSk7XG5cblx0XHRpZiAobG9hZGVyLnNpZ25hbC5hYm9ydGVkKSByZXR1cm47XG5cblx0XHRyZXN0b3JlRWRpdG9yKCk7XG5cblx0XHRpZiAocmVzdWx0LmNvZGUgIT09IDApIHtcblx0XHRcdGNvbnN0IGVycm9yTXNnID0gcmVzdWx0LnN0ZGVycj8udHJpbSgpIHx8IFwiVW5rbm93biBlcnJvclwiO1xuXHRcdFx0Y3R4LnNob3dFcnJvcihgRmFpbGVkIHRvIGNyZWF0ZSBnaXN0OiAke2Vycm9yTXNnfWApO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdC8vIEV4dHJhY3QgZ2lzdCBJRCBmcm9tIHRoZSBVUkwgcmV0dXJuZWQgYnkgZ2hcblx0XHQvLyBnaCByZXR1cm5zIHNvbWV0aGluZyBsaWtlOiBodHRwczovL2dpc3QuZ2l0aHViLmNvbS91c2VybmFtZS9HSVNUX0lEXG5cdFx0Y29uc3QgZ2lzdFVybCA9IHJlc3VsdC5zdGRvdXQ/LnRyaW0oKTtcblx0XHRjb25zdCBnaXN0SWQgPSBnaXN0VXJsPy5zcGxpdChcIi9cIikucG9wKCk7XG5cdFx0aWYgKCFnaXN0SWQpIHtcblx0XHRcdGN0eC5zaG93RXJyb3IoXCJGYWlsZWQgdG8gcGFyc2UgZ2lzdCBJRCBmcm9tIGdoIG91dHB1dFwiKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHQvLyBDcmVhdGUgdGhlIHByZXZpZXcgVVJMXG5cdFx0Y29uc3QgcHJldmlld1VybCA9IGdldFNoYXJlVmlld2VyVXJsKGdpc3RJZCk7XG5cdFx0Y3R4LnNob3dTdGF0dXMoYFNoYXJlIFVSTDogJHtwcmV2aWV3VXJsfVxcbkdpc3Q6ICR7Z2lzdFVybH1gKTtcblx0fSBjYXRjaCAoZXJyb3I6IHVua25vd24pIHtcblx0XHRpZiAoIWxvYWRlci5zaWduYWwuYWJvcnRlZCkge1xuXHRcdFx0cmVzdG9yZUVkaXRvcigpO1xuXHRcdFx0Y3R4LnNob3dFcnJvcihgRmFpbGVkIHRvIGNyZWF0ZSBnaXN0OiAke2Vycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogXCJVbmtub3duIGVycm9yXCJ9YCk7XG5cdFx0fVxuXHR9XG59XG5cbmZ1bmN0aW9uIGhhbmRsZUNvcHlDb21tYW5kKGN0eDogU2xhc2hDb21tYW5kQ29udGV4dCk6IHZvaWQge1xuXHRjb25zdCB0ZXh0ID0gY3R4LnNlc3Npb24uZ2V0TGFzdEFzc2lzdGFudFRleHQoKTtcblx0aWYgKCF0ZXh0KSB7XG5cdFx0Y3R4LnNob3dFcnJvcihcIk5vIGFnZW50IG1lc3NhZ2VzIHRvIGNvcHkgeWV0LlwiKTtcblx0XHRyZXR1cm47XG5cdH1cblxuXHR0cnkge1xuXHRcdGNvcHlUb0NsaXBib2FyZCh0ZXh0KTtcblx0XHRjdHguc2hvd1N0YXR1cyhcIkNvcGllZCBsYXN0IGFnZW50IG1lc3NhZ2UgdG8gY2xpcGJvYXJkXCIpO1xuXHR9IGNhdGNoIChlcnJvcikge1xuXHRcdGN0eC5zaG93RXJyb3IoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpKTtcblx0fVxufVxuXG5mdW5jdGlvbiBoYW5kbGVOYW1lQ29tbWFuZCh0ZXh0OiBzdHJpbmcsIGN0eDogU2xhc2hDb21tYW5kQ29udGV4dCk6IHZvaWQge1xuXHRjb25zdCBuYW1lID0gdGV4dC5yZXBsYWNlKC9eXFwvbmFtZVxccyovLCBcIlwiKS50cmltKCk7XG5cdGlmICghbmFtZSkge1xuXHRcdGNvbnN0IGN1cnJlbnROYW1lID0gY3R4LnNlc3Npb25NYW5hZ2VyLmdldFNlc3Npb25OYW1lKCk7XG5cdFx0aWYgKGN1cnJlbnROYW1lKSB7XG5cdFx0XHRjdHguY2hhdENvbnRhaW5lci5hZGRDaGlsZChuZXcgU3BhY2VyKDEpKTtcblx0XHRcdGN0eC5jaGF0Q29udGFpbmVyLmFkZENoaWxkKG5ldyBUZXh0KHRoZW1lLmZnKFwiZGltXCIsIGBTZXNzaW9uIG5hbWU6ICR7Y3VycmVudE5hbWV9YCksIDEsIDApKTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0Y3R4LnNob3dXYXJuaW5nKFwiVXNhZ2U6IC9uYW1lIDxuYW1lPlwiKTtcblx0XHR9XG5cdFx0Y3R4LnJlcXVlc3RSZW5kZXIoKTtcblx0XHRyZXR1cm47XG5cdH1cblxuXHRjdHguc2Vzc2lvbk1hbmFnZXIuYXBwZW5kU2Vzc2lvbkluZm8obmFtZSk7XG5cdGN0eC51cGRhdGVUZXJtaW5hbFRpdGxlKCk7XG5cdGN0eC5jaGF0Q29udGFpbmVyLmFkZENoaWxkKG5ldyBTcGFjZXIoMSkpO1xuXHRjdHguY2hhdENvbnRhaW5lci5hZGRDaGlsZChuZXcgVGV4dCh0aGVtZS5mZyhcImRpbVwiLCBgU2Vzc2lvbiBuYW1lIHNldDogJHtuYW1lfWApLCAxLCAwKSk7XG5cdGN0eC5yZXF1ZXN0UmVuZGVyKCk7XG59XG5cbmZ1bmN0aW9uIGhhbmRsZVNlc3Npb25Db21tYW5kKGN0eDogU2xhc2hDb21tYW5kQ29udGV4dCk6IHZvaWQge1xuXHRjb25zdCBzdGF0cyA9IGN0eC5zZXNzaW9uLmdldFNlc3Npb25TdGF0cygpO1xuXHRjb25zdCBzZXNzaW9uTmFtZSA9IGN0eC5zZXNzaW9uTWFuYWdlci5nZXRTZXNzaW9uTmFtZSgpO1xuXG5cdGxldCBpbmZvID0gYCR7dGhlbWUuYm9sZChcIlNlc3Npb24gSW5mb1wiKX1cXG5cXG5gO1xuXHRpZiAoc2Vzc2lvbk5hbWUpIHtcblx0XHRpbmZvICs9IGAke3RoZW1lLmZnKFwiZGltXCIsIFwiTmFtZTpcIil9ICR7c2Vzc2lvbk5hbWV9XFxuYDtcblx0fVxuXHRpbmZvICs9IGAke3RoZW1lLmZnKFwiZGltXCIsIFwiRmlsZTpcIil9ICR7c3RhdHMuc2Vzc2lvbkZpbGUgPz8gXCJJbi1tZW1vcnlcIn1cXG5gO1xuXHRpbmZvICs9IGAke3RoZW1lLmZnKFwiZGltXCIsIFwiSUQ6XCIpfSAke3N0YXRzLnNlc3Npb25JZH1cXG5cXG5gO1xuXHRpbmZvICs9IGAke3RoZW1lLmJvbGQoXCJNZXNzYWdlc1wiKX1cXG5gO1xuXHRpbmZvICs9IGAke3RoZW1lLmZnKFwiZGltXCIsIFwiVXNlcjpcIil9ICR7c3RhdHMudXNlck1lc3NhZ2VzfVxcbmA7XG5cdGluZm8gKz0gYCR7dGhlbWUuZmcoXCJkaW1cIiwgXCJBc3Npc3RhbnQ6XCIpfSAke3N0YXRzLmFzc2lzdGFudE1lc3NhZ2VzfVxcbmA7XG5cdGluZm8gKz0gYCR7dGhlbWUuZmcoXCJkaW1cIiwgXCJUb29sIENhbGxzOlwiKX0gJHtzdGF0cy50b29sQ2FsbHN9XFxuYDtcblx0aW5mbyArPSBgJHt0aGVtZS5mZyhcImRpbVwiLCBcIlRvb2wgUmVzdWx0czpcIil9ICR7c3RhdHMudG9vbFJlc3VsdHN9XFxuYDtcblx0aW5mbyArPSBgJHt0aGVtZS5mZyhcImRpbVwiLCBcIlRvdGFsOlwiKX0gJHtzdGF0cy50b3RhbE1lc3NhZ2VzfVxcblxcbmA7XG5cdGluZm8gKz0gYCR7dGhlbWUuYm9sZChcIlRva2Vuc1wiKX1cXG5gO1xuXHRpbmZvICs9IGAke3RoZW1lLmZnKFwiZGltXCIsIFwiSW5wdXQ6XCIpfSAke3N0YXRzLnRva2Vucy5pbnB1dC50b0xvY2FsZVN0cmluZygpfVxcbmA7XG5cdGluZm8gKz0gYCR7dGhlbWUuZmcoXCJkaW1cIiwgXCJPdXRwdXQ6XCIpfSAke3N0YXRzLnRva2Vucy5vdXRwdXQudG9Mb2NhbGVTdHJpbmcoKX1cXG5gO1xuXHRpZiAoc3RhdHMudG9rZW5zLmNhY2hlUmVhZCA+IDApIHtcblx0XHRpbmZvICs9IGAke3RoZW1lLmZnKFwiZGltXCIsIFwiQ2FjaGUgUmVhZDpcIil9ICR7c3RhdHMudG9rZW5zLmNhY2hlUmVhZC50b0xvY2FsZVN0cmluZygpfVxcbmA7XG5cdH1cblx0aWYgKHN0YXRzLnRva2Vucy5jYWNoZVdyaXRlID4gMCkge1xuXHRcdGluZm8gKz0gYCR7dGhlbWUuZmcoXCJkaW1cIiwgXCJDYWNoZSBXcml0ZTpcIil9ICR7c3RhdHMudG9rZW5zLmNhY2hlV3JpdGUudG9Mb2NhbGVTdHJpbmcoKX1cXG5gO1xuXHR9XG5cdGluZm8gKz0gYCR7dGhlbWUuZmcoXCJkaW1cIiwgXCJUb3RhbDpcIil9ICR7c3RhdHMudG9rZW5zLnRvdGFsLnRvTG9jYWxlU3RyaW5nKCl9XFxuYDtcblxuXHRpZiAoc3RhdHMuY29zdCA+IDApIHtcblx0XHRpbmZvICs9IGBcXG4ke3RoZW1lLmJvbGQoXCJDb3N0XCIpfVxcbmA7XG5cdFx0aW5mbyArPSBgJHt0aGVtZS5mZyhcImRpbVwiLCBcIlRvdGFsOlwiKX0gJHtzdGF0cy5jb3N0LnRvRml4ZWQoNCl9YDtcblx0fVxuXG5cdGN0eC5jaGF0Q29udGFpbmVyLmFkZENoaWxkKG5ldyBTcGFjZXIoMSkpO1xuXHRjdHguY2hhdENvbnRhaW5lci5hZGRDaGlsZChuZXcgVGV4dChpbmZvLCAxLCAwKSk7XG5cdGN0eC5yZXF1ZXN0UmVuZGVyKCk7XG59XG5cbmZ1bmN0aW9uIGhhbmRsZUNoYW5nZWxvZ0NvbW1hbmQoY3R4OiBTbGFzaENvbW1hbmRDb250ZXh0KTogdm9pZCB7XG5cdGNvbnN0IGNoYW5nZWxvZ1BhdGggPSBnZXRDaGFuZ2Vsb2dQYXRoKCk7XG5cdGNvbnN0IGFsbEVudHJpZXMgPSBwYXJzZUNoYW5nZWxvZyhjaGFuZ2Vsb2dQYXRoKTtcblxuXHRjb25zdCBjaGFuZ2Vsb2dNYXJrZG93biA9XG5cdFx0YWxsRW50cmllcy5sZW5ndGggPiAwXG5cdFx0XHQ/IGFsbEVudHJpZXNcblx0XHRcdFx0XHQucmV2ZXJzZSgpXG5cdFx0XHRcdFx0Lm1hcCgoZSkgPT4gZS5jb250ZW50KVxuXHRcdFx0XHRcdC5qb2luKFwiXFxuXFxuXCIpXG5cdFx0XHQ6IFwiTm8gY2hhbmdlbG9nIGVudHJpZXMgZm91bmQuXCI7XG5cblx0Y3R4LmNoYXRDb250YWluZXIuYWRkQ2hpbGQobmV3IFNwYWNlcigxKSk7XG5cdGN0eC5jaGF0Q29udGFpbmVyLmFkZENoaWxkKG5ldyBEeW5hbWljQm9yZGVyKCkpO1xuXHRjdHguY2hhdENvbnRhaW5lci5hZGRDaGlsZChuZXcgVGV4dCh0aGVtZS5ib2xkKHRoZW1lLmZnKFwiYWNjZW50XCIsIFwiV2hhdCdzIE5ld1wiKSksIDEsIDApKTtcblx0Y3R4LmNoYXRDb250YWluZXIuYWRkQ2hpbGQobmV3IFNwYWNlcigxKSk7XG5cdGN0eC5jaGF0Q29udGFpbmVyLmFkZENoaWxkKG5ldyBNYXJrZG93bihjaGFuZ2Vsb2dNYXJrZG93biwgMSwgMSwgY3R4LmdldE1hcmtkb3duVGhlbWVXaXRoU2V0dGluZ3MoKSkpO1xuXHRjdHguY2hhdENvbnRhaW5lci5hZGRDaGlsZChuZXcgRHluYW1pY0JvcmRlcigpKTtcblx0Y3R4LnJlcXVlc3RSZW5kZXIoKTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyAvaG90a2V5cyBoZWxwZXJzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZXhwb3J0IGZ1bmN0aW9uIGNhcGl0YWxpemVLZXkoa2V5OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRyZXR1cm4ga2V5XG5cdFx0LnNwbGl0KFwiL1wiKVxuXHRcdC5tYXAoKGspID0+XG5cdFx0XHRrXG5cdFx0XHRcdC5zcGxpdChcIitcIilcblx0XHRcdFx0Lm1hcCgocGFydCkgPT4gcGFydC5jaGFyQXQoMCkudG9VcHBlckNhc2UoKSArIHBhcnQuc2xpY2UoMSkpXG5cdFx0XHRcdC5qb2luKFwiK1wiKSxcblx0XHQpXG5cdFx0LmpvaW4oXCIvXCIpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0QXBwS2V5RGlzcGxheShrZXliaW5kaW5nczogS2V5YmluZGluZ3NNYW5hZ2VyLCBhY3Rpb246IEFwcEFjdGlvbik6IHN0cmluZyB7XG5cdHJldHVybiBjYXBpdGFsaXplS2V5KGFwcEtleShrZXliaW5kaW5ncywgYWN0aW9uKSk7XG59XG5cbmZ1bmN0aW9uIGdldEVkaXRvcktleURpc3BsYXkoYWN0aW9uOiBFZGl0b3JBY3Rpb24pOiBzdHJpbmcge1xuXHRyZXR1cm4gY2FwaXRhbGl6ZUtleShlZGl0b3JLZXkoYWN0aW9uKSk7XG59XG5cbmZ1bmN0aW9uIGhhbmRsZUhvdGtleXNDb21tYW5kKGN0eDogU2xhc2hDb21tYW5kQ29udGV4dCk6IHZvaWQge1xuXHQvLyBOYXZpZ2F0aW9uIGtleWJpbmRpbmdzXG5cdGNvbnN0IGN1cnNvcldvcmRMZWZ0ID0gZ2V0RWRpdG9yS2V5RGlzcGxheShcImN1cnNvcldvcmRMZWZ0XCIpO1xuXHRjb25zdCBjdXJzb3JXb3JkUmlnaHQgPSBnZXRFZGl0b3JLZXlEaXNwbGF5KFwiY3Vyc29yV29yZFJpZ2h0XCIpO1xuXHRjb25zdCBjdXJzb3JMaW5lU3RhcnQgPSBnZXRFZGl0b3JLZXlEaXNwbGF5KFwiY3Vyc29yTGluZVN0YXJ0XCIpO1xuXHRjb25zdCBjdXJzb3JMaW5lRW5kID0gZ2V0RWRpdG9yS2V5RGlzcGxheShcImN1cnNvckxpbmVFbmRcIik7XG5cdGNvbnN0IGp1bXBGb3J3YXJkID0gZ2V0RWRpdG9yS2V5RGlzcGxheShcImp1bXBGb3J3YXJkXCIpO1xuXHRjb25zdCBqdW1wQmFja3dhcmQgPSBnZXRFZGl0b3JLZXlEaXNwbGF5KFwianVtcEJhY2t3YXJkXCIpO1xuXHRjb25zdCBwYWdlVXAgPSBnZXRFZGl0b3JLZXlEaXNwbGF5KFwicGFnZVVwXCIpO1xuXHRjb25zdCBwYWdlRG93biA9IGdldEVkaXRvcktleURpc3BsYXkoXCJwYWdlRG93blwiKTtcblxuXHQvLyBFZGl0aW5nIGtleWJpbmRpbmdzXG5cdGNvbnN0IHN1Ym1pdCA9IGdldEVkaXRvcktleURpc3BsYXkoXCJzdWJtaXRcIik7XG5cdGNvbnN0IG5ld0xpbmUgPSBnZXRFZGl0b3JLZXlEaXNwbGF5KFwibmV3TGluZVwiKTtcblx0Y29uc3QgZGVsZXRlV29yZEJhY2t3YXJkID0gZ2V0RWRpdG9yS2V5RGlzcGxheShcImRlbGV0ZVdvcmRCYWNrd2FyZFwiKTtcblx0Y29uc3QgZGVsZXRlV29yZEZvcndhcmQgPSBnZXRFZGl0b3JLZXlEaXNwbGF5KFwiZGVsZXRlV29yZEZvcndhcmRcIik7XG5cdGNvbnN0IGRlbGV0ZVRvTGluZVN0YXJ0ID0gZ2V0RWRpdG9yS2V5RGlzcGxheShcImRlbGV0ZVRvTGluZVN0YXJ0XCIpO1xuXHRjb25zdCBkZWxldGVUb0xpbmVFbmQgPSBnZXRFZGl0b3JLZXlEaXNwbGF5KFwiZGVsZXRlVG9MaW5lRW5kXCIpO1xuXHRjb25zdCB5YW5rID0gZ2V0RWRpdG9yS2V5RGlzcGxheShcInlhbmtcIik7XG5cdGNvbnN0IHlhbmtQb3AgPSBnZXRFZGl0b3JLZXlEaXNwbGF5KFwieWFua1BvcFwiKTtcblx0Y29uc3QgdW5kbyA9IGdldEVkaXRvcktleURpc3BsYXkoXCJ1bmRvXCIpO1xuXHRjb25zdCB0YWIgPSBnZXRFZGl0b3JLZXlEaXNwbGF5KFwidGFiXCIpO1xuXG5cdC8vIEFwcCBrZXliaW5kaW5nc1xuXHRjb25zdCBpbnRlcnJ1cHQgPSBnZXRBcHBLZXlEaXNwbGF5KGN0eC5rZXliaW5kaW5ncywgXCJpbnRlcnJ1cHRcIik7XG5cdGNvbnN0IGNsZWFyID0gZ2V0QXBwS2V5RGlzcGxheShjdHgua2V5YmluZGluZ3MsIFwiY2xlYXJcIik7XG5cdGNvbnN0IGV4aXQgPSBnZXRBcHBLZXlEaXNwbGF5KGN0eC5rZXliaW5kaW5ncywgXCJleGl0XCIpO1xuXHRjb25zdCBzdXNwZW5kID0gZ2V0QXBwS2V5RGlzcGxheShjdHgua2V5YmluZGluZ3MsIFwic3VzcGVuZFwiKTtcblx0Y29uc3QgY3ljbGVUaGlua2luZ0xldmVsID0gZ2V0QXBwS2V5RGlzcGxheShjdHgua2V5YmluZGluZ3MsIFwiY3ljbGVUaGlua2luZ0xldmVsXCIpO1xuXHRjb25zdCBjeWNsZU1vZGVsRm9yd2FyZCA9IGdldEFwcEtleURpc3BsYXkoY3R4LmtleWJpbmRpbmdzLCBcImN5Y2xlTW9kZWxGb3J3YXJkXCIpO1xuXHRjb25zdCBjeWNsZU1vZGVsQmFja3dhcmQgPSBnZXRBcHBLZXlEaXNwbGF5KGN0eC5rZXliaW5kaW5ncywgXCJjeWNsZU1vZGVsQmFja3dhcmRcIik7XG5cdGNvbnN0IHNlbGVjdE1vZGVsID0gZ2V0QXBwS2V5RGlzcGxheShjdHgua2V5YmluZGluZ3MsIFwic2VsZWN0TW9kZWxcIik7XG5cdGNvbnN0IGV4cGFuZFRvb2xzID0gZ2V0QXBwS2V5RGlzcGxheShjdHgua2V5YmluZGluZ3MsIFwiZXhwYW5kVG9vbHNcIik7XG5cdGNvbnN0IHRvZ2dsZVRoaW5raW5nID0gZ2V0QXBwS2V5RGlzcGxheShjdHgua2V5YmluZGluZ3MsIFwidG9nZ2xlVGhpbmtpbmdcIik7XG5cdGNvbnN0IGV4dGVybmFsRWRpdG9yID0gZ2V0QXBwS2V5RGlzcGxheShjdHgua2V5YmluZGluZ3MsIFwiZXh0ZXJuYWxFZGl0b3JcIik7XG5cdGNvbnN0IGZvbGxvd1VwID0gZ2V0QXBwS2V5RGlzcGxheShjdHgua2V5YmluZGluZ3MsIFwiZm9sbG93VXBcIik7XG5cdGNvbnN0IGRlcXVldWUgPSBnZXRBcHBLZXlEaXNwbGF5KGN0eC5rZXliaW5kaW5ncywgXCJkZXF1ZXVlXCIpO1xuXHRjb25zdCBwYXN0ZUltYWdlID0gZ2V0QXBwS2V5RGlzcGxheShjdHgua2V5YmluZGluZ3MsIFwicGFzdGVJbWFnZVwiKTtcblxuXHRsZXQgaG90a2V5cyA9IGBcbioqTmF2aWdhdGlvbioqXG58IEtleSB8IEFjdGlvbiB8XG58LS0tLS18LS0tLS0tLS18XG58IFxcYEFycm93IGtleXNcXGAgfCBNb3ZlIGN1cnNvciAvIGJyb3dzZSBoaXN0b3J5IChVcCB3aGVuIGVtcHR5KSB8XG58IFxcYCR7Y3Vyc29yV29yZExlZnR9XFxgIC8gXFxgJHtjdXJzb3JXb3JkUmlnaHR9XFxgIHwgTW92ZSBieSB3b3JkIHxcbnwgXFxgJHtjdXJzb3JMaW5lU3RhcnR9XFxgIHwgU3RhcnQgb2YgbGluZSB8XG58IFxcYCR7Y3Vyc29yTGluZUVuZH1cXGAgfCBFbmQgb2YgbGluZSB8XG58IFxcYCR7anVtcEZvcndhcmR9XFxgIHwgSnVtcCBmb3J3YXJkIHRvIGNoYXJhY3RlciB8XG58IFxcYCR7anVtcEJhY2t3YXJkfVxcYCB8IEp1bXAgYmFja3dhcmQgdG8gY2hhcmFjdGVyIHxcbnwgXFxgJHtwYWdlVXB9XFxgIC8gXFxgJHtwYWdlRG93bn1cXGAgfCBTY3JvbGwgYnkgcGFnZSB8XG5cbioqRWRpdGluZyoqXG58IEtleSB8IEFjdGlvbiB8XG58LS0tLS18LS0tLS0tLS18XG58IFxcYCR7c3VibWl0fVxcYCB8IFNlbmQgbWVzc2FnZSB8XG58IFxcYCR7bmV3TGluZX1cXGAgfCBOZXcgbGluZSR7cHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiID8gXCIgKEN0cmwrRW50ZXIgb24gV2luZG93cyBUZXJtaW5hbClcIiA6IFwiXCJ9IHxcbnwgXFxgJHtkZWxldGVXb3JkQmFja3dhcmR9XFxgIHwgRGVsZXRlIHdvcmQgYmFja3dhcmRzIHxcbnwgXFxgJHtkZWxldGVXb3JkRm9yd2FyZH1cXGAgfCBEZWxldGUgd29yZCBmb3J3YXJkcyB8XG58IFxcYCR7ZGVsZXRlVG9MaW5lU3RhcnR9XFxgIHwgRGVsZXRlIHRvIHN0YXJ0IG9mIGxpbmUgfFxufCBcXGAke2RlbGV0ZVRvTGluZUVuZH1cXGAgfCBEZWxldGUgdG8gZW5kIG9mIGxpbmUgfFxufCBcXGAke3lhbmt9XFxgIHwgUGFzdGUgdGhlIG1vc3QtcmVjZW50bHktZGVsZXRlZCB0ZXh0IHxcbnwgXFxgJHt5YW5rUG9wfVxcYCB8IEN5Y2xlIHRocm91Z2ggdGhlIGRlbGV0ZWQgdGV4dCBhZnRlciBwYXN0aW5nIHxcbnwgXFxgJHt1bmRvfVxcYCB8IFVuZG8gfFxuXG4qKk90aGVyKipcbnwgS2V5IHwgQWN0aW9uIHxcbnwtLS0tLXwtLS0tLS0tLXxcbnwgXFxgJHt0YWJ9XFxgIHwgUGF0aCBjb21wbGV0aW9uIC8gYWNjZXB0IGF1dG9jb21wbGV0ZSB8XG58IFxcYCR7aW50ZXJydXB0fVxcYCB8IENhbmNlbCBhdXRvY29tcGxldGUgLyBhYm9ydCBzdHJlYW1pbmcgfFxufCBcXGAke2NsZWFyfVxcYCB8IENsZWFyIGVkaXRvciAoZmlyc3QpIC8gZXhpdCAoc2Vjb25kKSB8XG58IFxcYCR7ZXhpdH1cXGAgfCBFeGl0ICh3aGVuIGVkaXRvciBpcyBlbXB0eSkgfFxufCBcXGAke3N1c3BlbmR9XFxgIHwgU3VzcGVuZCB0byBiYWNrZ3JvdW5kIHxcbnwgXFxgJHtjeWNsZVRoaW5raW5nTGV2ZWx9XFxgIHwgQ3ljbGUgdGhpbmtpbmcgbGV2ZWwgfFxufCBcXGAke2N5Y2xlTW9kZWxGb3J3YXJkfVxcYCAvIFxcYCR7Y3ljbGVNb2RlbEJhY2t3YXJkfVxcYCB8IEN5Y2xlIG1vZGVscyB8XG58IFxcYCR7c2VsZWN0TW9kZWx9XFxgIHwgT3BlbiBtb2RlbCBzZWxlY3RvciB8XG58IFxcYCR7ZXhwYW5kVG9vbHN9XFxgIHwgVG9nZ2xlIHRvb2wgb3V0cHV0IGV4cGFuc2lvbiB8XG58IFxcYCR7dG9nZ2xlVGhpbmtpbmd9XFxgIHwgVG9nZ2xlIHRoaW5raW5nIGJsb2NrIHZpc2liaWxpdHkgfFxufCBcXGAke2V4dGVybmFsRWRpdG9yfVxcYCB8IEVkaXQgbWVzc2FnZSBpbiBleHRlcm5hbCBlZGl0b3IgfFxufCBcXGAke2ZvbGxvd1VwfVxcYCB8IFF1ZXVlIGZvbGxvdy11cCBtZXNzYWdlIHxcbnwgXFxgJHtkZXF1ZXVlfVxcYCB8IFJlc3RvcmUgcXVldWVkIG1lc3NhZ2VzIHxcbnwgXFxgJHtwYXN0ZUltYWdlfVxcYCB8IFBhc3RlIGltYWdlIGZyb20gY2xpcGJvYXJkIHxcbnwgXFxgL1xcYCB8IFNsYXNoIGNvbW1hbmRzIHxcbnwgXFxgIVxcYCB8IFJ1biBiYXNoIGNvbW1hbmQgfFxufCBcXGAhIVxcYCB8IFJ1biBiYXNoIGNvbW1hbmQgKGV4Y2x1ZGVkIGZyb20gY29udGV4dCkgfFxuYDtcblxuXHQvLyBBZGQgZXh0ZW5zaW9uLXJlZ2lzdGVyZWQgc2hvcnRjdXRzXG5cdGNvbnN0IGV4dGVuc2lvblJ1bm5lciA9IGN0eC5zZXNzaW9uLmV4dGVuc2lvblJ1bm5lcjtcblx0aWYgKGV4dGVuc2lvblJ1bm5lcikge1xuXHRcdGNvbnN0IHNob3J0Y3V0cyA9IGV4dGVuc2lvblJ1bm5lci5nZXRTaG9ydGN1dHMoY3R4LmtleWJpbmRpbmdzLmdldEVmZmVjdGl2ZUNvbmZpZygpKTtcblx0XHRpZiAoc2hvcnRjdXRzLnNpemUgPiAwKSB7XG5cdFx0XHRob3RrZXlzICs9IGBcbioqRXh0ZW5zaW9ucyoqXG58IEtleSB8IEFjdGlvbiB8XG58LS0tLS18LS0tLS0tLS18XG5gO1xuXHRcdFx0Zm9yIChjb25zdCBba2V5LCBzaG9ydGN1dF0gb2Ygc2hvcnRjdXRzKSB7XG5cdFx0XHRcdGNvbnN0IGRlc2NyaXB0aW9uID0gc2hvcnRjdXQuZGVzY3JpcHRpb24gPz8gc2hvcnRjdXQuZXh0ZW5zaW9uUGF0aDtcblx0XHRcdFx0Y29uc3Qga2V5RGlzcGxheSA9IGZvcm1hdEtleUZvckRpc3BsYXkoa2V5KS5yZXBsYWNlKC9cXGJcXHcvZywgKGMpID0+IGMudG9VcHBlckNhc2UoKSk7XG5cdFx0XHRcdGhvdGtleXMgKz0gYHwgXFxgJHtrZXlEaXNwbGF5fVxcYCB8ICR7ZGVzY3JpcHRpb259IHxcXG5gO1xuXHRcdFx0fVxuXHRcdH1cblx0fVxuXG5cdGN0eC5jaGF0Q29udGFpbmVyLmFkZENoaWxkKG5ldyBTcGFjZXIoMSkpO1xuXHRjdHguY2hhdENvbnRhaW5lci5hZGRDaGlsZChuZXcgRHluYW1pY0JvcmRlcigpKTtcblx0Y3R4LmNoYXRDb250YWluZXIuYWRkQ2hpbGQobmV3IFRleHQodGhlbWUuYm9sZCh0aGVtZS5mZyhcImFjY2VudFwiLCBcIktleWJvYXJkIFNob3J0Y3V0c1wiKSksIDEsIDApKTtcblx0Y3R4LmNoYXRDb250YWluZXIuYWRkQ2hpbGQobmV3IFNwYWNlcigxKSk7XG5cdGN0eC5jaGF0Q29udGFpbmVyLmFkZENoaWxkKG5ldyBNYXJrZG93bihob3RrZXlzLnRyaW0oKSwgMSwgMSwgY3R4LmdldE1hcmtkb3duVGhlbWVXaXRoU2V0dGluZ3MoKSkpO1xuXHRjdHguY2hhdENvbnRhaW5lci5hZGRDaGlsZChuZXcgRHluYW1pY0JvcmRlcigpKTtcblx0Y3R4LnJlcXVlc3RSZW5kZXIoKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gaGFuZGxlQ29tcGFjdENvbW1hbmQoY3VzdG9tSW5zdHJ1Y3Rpb25zOiBzdHJpbmcgfCB1bmRlZmluZWQsIGN0eDogU2xhc2hDb21tYW5kQ29udGV4dCk6IFByb21pc2U8dm9pZD4ge1xuXHRjb25zdCBlbnRyaWVzID0gY3R4LnNlc3Npb25NYW5hZ2VyLmdldEVudHJpZXMoKTtcblx0Y29uc3QgbWVzc2FnZUNvdW50ID0gZW50cmllcy5maWx0ZXIoKGUpID0+IGUudHlwZSA9PT0gXCJtZXNzYWdlXCIpLmxlbmd0aDtcblxuXHRpZiAobWVzc2FnZUNvdW50IDwgMikge1xuXHRcdGN0eC5zaG93V2FybmluZyhcIk5vdGhpbmcgdG8gY29tcGFjdCAobm8gbWVzc2FnZXMgeWV0KVwiKTtcblx0XHRyZXR1cm47XG5cdH1cblxuXHRhd2FpdCBjdHguZXhlY3V0ZUNvbXBhY3Rpb24oY3VzdG9tSW5zdHJ1Y3Rpb25zLCBmYWxzZSk7XG59XG5cbmZ1bmN0aW9uIGhhbmRsZVRoaW5raW5nQ29tbWFuZChhcmc6IHN0cmluZyB8IHVuZGVmaW5lZCwgY3R4OiBTbGFzaENvbW1hbmRDb250ZXh0KTogdm9pZCB7XG5cdGlmICghY3R4LnNlc3Npb24uc3VwcG9ydHNUaGlua2luZygpKSB7XG5cdFx0Y3R4LnNob3dTdGF0dXMoXCJDdXJyZW50IG1vZGVsIGRvZXMgbm90IHN1cHBvcnQgdGhpbmtpbmdcIik7XG5cdFx0cmV0dXJuO1xuXHR9XG5cblx0Y29uc3QgYXZhaWxhYmxlTGV2ZWxzID0gY3R4LnNlc3Npb24uZ2V0QXZhaWxhYmxlVGhpbmtpbmdMZXZlbHMoKTtcblxuXHRpZiAoYXJnKSB7XG5cdFx0Y29uc3QgbGV2ZWwgPSBhcmcudG9Mb3dlckNhc2UoKTtcblx0XHRpZiAoIWF2YWlsYWJsZUxldmVscy5pbmNsdWRlcyhsZXZlbCBhcyBUaGlua2luZ0xldmVsKSkge1xuXHRcdFx0Y3R4LnNob3dTdGF0dXMoYEludmFsaWQgdGhpbmtpbmcgbGV2ZWwgXCIke2FyZ31cIi4gQXZhaWxhYmxlOiAke2F2YWlsYWJsZUxldmVscy5qb2luKFwiLCBcIil9YCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXHRcdGN0eC5zZXNzaW9uLnNldFRoaW5raW5nTGV2ZWwobGV2ZWwgYXMgVGhpbmtpbmdMZXZlbCk7XG5cdFx0Y3R4LmludmFsaWRhdGVGb290ZXIoKTtcblx0XHRjdHgudXBkYXRlRWRpdG9yQm9yZGVyQ29sb3IoKTtcblx0XHRjdHguc2hvd1N0YXR1cyhgVGhpbmtpbmcgbGV2ZWw6ICR7bGV2ZWx9YCk7XG5cdFx0cmV0dXJuO1xuXHR9XG5cblx0c2hvd1RoaW5raW5nU2VsZWN0b3IoY3R4LCBhdmFpbGFibGVMZXZlbHMpO1xufVxuXG5mdW5jdGlvbiBzaG93VGhpbmtpbmdTZWxlY3RvcihjdHg6IFNsYXNoQ29tbWFuZENvbnRleHQsIGF2YWlsYWJsZUxldmVsczogcmVhZG9ubHkgVGhpbmtpbmdMZXZlbFtdKTogdm9pZCB7XG5cdGN0eC5zaG93U2VsZWN0b3IoKGRvbmUpID0+IHtcblx0XHRjb25zdCBzZWxlY3RvciA9IG5ldyBTZWxlY3RTdWJtZW51KFxuXHRcdFx0XCJUaGlua2luZyBMZXZlbFwiLFxuXHRcdFx0XCJTZWxlY3QgcmVhc29uaW5nIGRlcHRoIGZvciB0aGlua2luZy1jYXBhYmxlIG1vZGVsc1wiLFxuXHRcdFx0YXZhaWxhYmxlTGV2ZWxzLm1hcCgobGV2ZWwpID0+ICh7XG5cdFx0XHRcdHZhbHVlOiBsZXZlbCxcblx0XHRcdFx0bGFiZWw6IGxldmVsLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogVEhJTktJTkdfREVTQ1JJUFRJT05TW2xldmVsXSxcblx0XHRcdH0pKSxcblx0XHRcdGN0eC5zZXNzaW9uLnRoaW5raW5nTGV2ZWwsXG5cdFx0XHQodmFsdWUpID0+IHtcblx0XHRcdFx0Y3R4LnNlc3Npb24uc2V0VGhpbmtpbmdMZXZlbCh2YWx1ZSBhcyBUaGlua2luZ0xldmVsKTtcblx0XHRcdFx0Y3R4LmludmFsaWRhdGVGb290ZXIoKTtcblx0XHRcdFx0Y3R4LnVwZGF0ZUVkaXRvckJvcmRlckNvbG9yKCk7XG5cdFx0XHRcdGRvbmUoKTtcblx0XHRcdFx0Y3R4LnNob3dTdGF0dXMoYFRoaW5raW5nIGxldmVsOiAke3ZhbHVlfWApO1xuXHRcdFx0fSxcblx0XHRcdCgpID0+IHtcblx0XHRcdFx0ZG9uZSgpO1xuXHRcdFx0fSxcblx0XHQpO1xuXHRcdHJldHVybiB7IGNvbXBvbmVudDogc2VsZWN0b3IsIGZvY3VzOiBzZWxlY3RvciB9O1xuXHR9KTtcbn1cblxuZnVuY3Rpb24gaGFuZGxlRWRpdE1vZGVDb21tYW5kKGFyZzogc3RyaW5nIHwgdW5kZWZpbmVkLCBjdHg6IFNsYXNoQ29tbWFuZENvbnRleHQpOiB2b2lkIHtcblx0Y29uc3QgbW9kZXMgPSBbXCJzdGFuZGFyZFwiLCBcImhhc2hsaW5lXCJdIGFzIGNvbnN0O1xuXG5cdGlmIChhcmcpIHtcblx0XHRjb25zdCBtb2RlID0gYXJnLnRvTG93ZXJDYXNlKCk7XG5cdFx0aWYgKCFtb2Rlcy5pbmNsdWRlcyhtb2RlIGFzIHR5cGVvZiBtb2Rlc1tudW1iZXJdKSkge1xuXHRcdFx0Y3R4LnNob3dTdGF0dXMoYEludmFsaWQgZWRpdCBtb2RlIFwiJHthcmd9XCIuIEF2YWlsYWJsZTogc3RhbmRhcmQsIGhhc2hsaW5lYCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXHRcdGN0eC5zZXNzaW9uLnNldEVkaXRNb2RlKG1vZGUgYXMgXCJzdGFuZGFyZFwiIHwgXCJoYXNobGluZVwiKTtcblx0XHRjdHguc2hvd1N0YXR1cyhgRWRpdCBtb2RlOiAke21vZGV9JHttb2RlID09PSBcImhhc2hsaW5lXCIgPyBcIiAoTElORSNJRCBhbmNob3JlZCBlZGl0cylcIiA6IFwiICh0ZXh0LW1hdGNoIGVkaXRzKVwifWApO1xuXHRcdHJldHVybjtcblx0fVxuXG5cdC8vIFRvZ2dsZVxuXHRjb25zdCBjdXJyZW50ID0gY3R4LnNlc3Npb24uZWRpdE1vZGU7XG5cdGNvbnN0IG5leHQgPSBjdXJyZW50ID09PSBcInN0YW5kYXJkXCIgPyBcImhhc2hsaW5lXCIgOiBcInN0YW5kYXJkXCI7XG5cdGN0eC5zZXNzaW9uLnNldEVkaXRNb2RlKG5leHQpO1xuXHRjdHguc2hvd1N0YXR1cyhgRWRpdCBtb2RlOiAke25leHR9JHtuZXh0ID09PSBcImhhc2hsaW5lXCIgPyBcIiAoTElORSNJRCBhbmNob3JlZCBlZGl0cylcIiA6IFwiICh0ZXh0LW1hdGNoIGVkaXRzKVwifWApO1xufVxuXG5mdW5jdGlvbiBoYW5kbGVUdWlDb21tYW5kKHRleHQ6IHN0cmluZywgY3R4OiBTbGFzaENvbW1hbmRDb250ZXh0KTogdm9pZCB7XG5cdGNvbnN0IHBhcnRzID0gdGV4dC50cmltKCkuc3BsaXQoL1xccysvKTtcblx0Y29uc3QgbW9kZSA9IHBhcnRzWzFdID09PSBcIm1vZGVcIiA/IHBhcnRzWzJdIDogcGFydHNbMV07XG5cdGNvbnN0IHZhbGlkOiBBZGFwdGl2ZVR1aU1vZGVbXSA9IFtcImF1dG9cIiwgXCJjaGF0XCIsIFwid29ya2Zsb3dcIiwgXCJ2YWxpZGF0aW9uXCIsIFwiZGVidWdcIiwgXCJjb21wYWN0XCJdO1xuXG5cdGlmICghbW9kZSkge1xuXHRcdGN0eC5zaG93U3RhdHVzKGBUVUkgbW9kZTogJHtjdHguc2V0dGluZ3NNYW5hZ2VyLmdldEFkYXB0aXZlTW9kZSgpfWApO1xuXHRcdHJldHVybjtcblx0fVxuXHRpZiAoIXZhbGlkLmluY2x1ZGVzKG1vZGUgYXMgQWRhcHRpdmVUdWlNb2RlKSkge1xuXHRcdGN0eC5zaG93V2FybmluZyhgVXNhZ2U6IC90dWkgbW9kZSAke3ZhbGlkLmpvaW4oXCJ8XCIpfWApO1xuXHRcdHJldHVybjtcblx0fVxuXG5cdGN0eC5zZXR0aW5nc01hbmFnZXIuc2V0QWRhcHRpdmVNb2RlKG1vZGUgYXMgQWRhcHRpdmVUdWlNb2RlKTtcblx0Y3R4LnNob3dTdGF0dXMoYFRVSSBtb2RlOiAke21vZGV9YCk7XG5cdGN0eC5yZXF1ZXN0UmVuZGVyKCk7XG59XG5cbmZ1bmN0aW9uIGhhbmRsZUFybWluU2F5c0hpKGN0eDogU2xhc2hDb21tYW5kQ29udGV4dCk6IHZvaWQge1xuXHRjdHguY2hhdENvbnRhaW5lci5hZGRDaGlsZChuZXcgU3BhY2VyKDEpKTtcblx0Y3R4LmNoYXRDb250YWluZXIuYWRkQ2hpbGQobmV3IEFybWluQ29tcG9uZW50KGN0eC51aSkpO1xuXHRjdHgucmVxdWVzdFJlbmRlcigpO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBVUEsWUFBWSxRQUFRO0FBQ3BCLFlBQVksUUFBUTtBQUNwQixZQUFZLFVBQVU7QUFPdEI7QUFBQSxFQUdDO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNNO0FBQ1AsU0FBUyxPQUFPLGlCQUFpQjtBQUNqQztBQUFBLEVBQ0M7QUFBQSxPQUNNO0FBS1AsU0FBUyx1QkFBdUI7QUFDaEMsU0FBUyxrQkFBa0Isc0JBQXNCO0FBQ2pELFNBQVMsc0JBQXNCO0FBQy9CLFNBQVMsc0JBQXNCO0FBQy9CLFNBQVMscUJBQXFCO0FBQzlCLFNBQVMsUUFBUSxXQUFXLDJCQUEyQjtBQUN2RCxTQUFTLGVBQWUsNkJBQTZCO0FBQ3JELFNBQVMsYUFBYTtBQWdGdEIsZUFBc0IscUJBQ3JCLE1BQ0EsS0FDbUI7QUFDbkIsTUFBSSxTQUFTLGFBQWE7QUFDekIsUUFBSSxxQkFBcUI7QUFDekIsV0FBTztBQUFBLEVBQ1I7QUFDQSxNQUFJLFNBQVMsa0JBQWtCO0FBQzlCLFVBQU0sSUFBSSxtQkFBbUI7QUFDN0IsV0FBTztBQUFBLEVBQ1I7QUFDQSxNQUFJLFNBQVMsWUFBWSxLQUFLLFdBQVcsU0FBUyxHQUFH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
