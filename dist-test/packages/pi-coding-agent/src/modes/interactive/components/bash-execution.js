import { Container, Loader, Spacer, Text } from "@gsd/pi-tui";
import stripAnsi from "strip-ansi";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateTail
} from "../../../core/tools/truncate.js";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { editorKey, keyHint } from "./keybinding-hints.js";
import { renderCommandCard, renderTranscriptCard } from "./transcript-design.js";
import { truncateToVisualLines } from "./visual-truncate.js";
const PREVIEW_LINES = 20;
class BashExecutionComponent extends Container {
  constructor(command, ui, excludeFromContext = false) {
    super();
    this.outputLines = [];
    this.status = "running";
    this.exitCode = void 0;
    this.expanded = false;
    this.command = command;
    this.ui = ui;
    const colorKey = excludeFromContext ? "dim" : "bashMode";
    this._borderColorKey = colorKey;
    const borderColor = (str) => theme.fg(colorKey, str);
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder(borderColor));
    this.contentContainer = new Container();
    this.addChild(this.contentContainer);
    const header = new Text(theme.fg(colorKey, theme.bold(`$ ${command}`)), 1, 0);
    this.contentContainer.addChild(header);
    this.loader = new Loader(
      ui,
      (spinner) => theme.fg(colorKey, spinner),
      (text) => theme.fg("muted", text),
      `Running... (${editorKey("selectCancel")} to cancel)`
      // Plain text for loader
    );
    this.contentContainer.addChild(this.loader);
    this.addChild(new DynamicBorder(borderColor));
  }
  /**
   * Set whether the output is expanded (shows full output) or collapsed (preview only).
   */
  setExpanded(expanded) {
    this.expanded = expanded;
    this.updateDisplay();
  }
  invalidate() {
    super.invalidate();
    this.updateDisplay();
  }
  appendOutput(chunk) {
    const clean = stripAnsi(chunk).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const newLines = clean.split("\n");
    if (this.outputLines.length > 0 && newLines.length > 0) {
      this.outputLines[this.outputLines.length - 1] += newLines[0];
      this.outputLines.push(...newLines.slice(1));
    } else {
      this.outputLines.push(...newLines);
    }
    this.updateDisplay();
  }
  setComplete(exitCode, cancelled, truncationResult, fullOutputPath) {
    this.exitCode = exitCode;
    this.status = cancelled ? "cancelled" : exitCode !== 0 && exitCode !== void 0 && exitCode !== null ? "error" : "complete";
    this.truncationResult = truncationResult;
    this.fullOutputPath = fullOutputPath;
    this.loader.stop();
    this.updateDisplay();
  }
  render(width) {
    const frameWidth = Math.max(20, width);
    const elapsedStatus = this.status === "running" ? "running" : this.status === "complete" ? "success" : this.status === "cancelled" ? "cancelled" : `failed${this.exitCode !== void 0 ? ` \xB7 exit ${this.exitCode}` : ""}`;
    const tone = this.status === "running" ? "running" : this.status === "complete" ? "success" : this.status === "cancelled" ? "warning" : "error";
    if (!this.expanded && this.status !== "error") {
      return [
        "",
        ...renderCommandCard(this.command.replace(/\s+/g, " ").trim(), frameWidth, {
          status: elapsedStatus,
          tone
        })
      ];
    }
    const output = this.outputLines.join("\n");
    const contextTruncation = truncateTail(output, {
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES
    });
    const truncationResult = this.truncationResult ?? contextTruncation;
    const fullOutputPath = this.fullOutputPath;
    const availableLines = contextTruncation.content ? contextTruncation.content.split("\n") : [];
    const preview = this.expanded ? availableLines : availableLines.slice(-PREVIEW_LINES);
    const hidden = Math.max(0, availableLines.length - preview.length);
    const truncationWarning = (truncationResult.truncated || contextTruncation.truncated) && fullOutputPath ? [theme.fg("warning", `Output truncated. Full output: ${fullOutputPath}`)] : [];
    const body = [
      theme.fg("toolTitle", `$ ${this.command}`),
      ...preview.map((line) => theme.fg("toolOutput", line)),
      ...hidden > 0 ? [theme.fg("muted", `... ${hidden} earlier lines`)] : [],
      ...truncationWarning
    ];
    return [
      "",
      ...renderTranscriptCard(body, frameWidth, {
        title: "command",
        right: elapsedStatus,
        tone,
        footerLeft: this.expanded ? "output expanded" : "output preview",
        footerRight: this.expanded ? "ctrl+o collapse" : "ctrl+o expand"
      })
    ];
  }
  updateDisplay() {
    const fullOutput = this.outputLines.join("\n");
    const contextTruncation = truncateTail(fullOutput, {
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES
    });
    const availableLines = contextTruncation.content ? contextTruncation.content.split("\n") : [];
    const previewLogicalLines = availableLines.slice(-PREVIEW_LINES);
    const hiddenLineCount = availableLines.length - previewLogicalLines.length;
    this.contentContainer.clear();
    const header = new Text(theme.fg(this._borderColorKey, theme.bold(`$ ${this.command}`)), 1, 0);
    this.contentContainer.addChild(header);
    if (availableLines.length > 0) {
      if (this.expanded) {
        const displayText = availableLines.map((line) => theme.fg("muted", line)).join("\n");
        this.contentContainer.addChild(new Text(`
${displayText}`, 1, 0));
      } else {
        const styledOutput = previewLogicalLines.map((line) => theme.fg("muted", line)).join("\n");
        const { visualLines } = truncateToVisualLines(
          `
${styledOutput}`,
          PREVIEW_LINES,
          this.ui.terminal.columns,
          1
          // padding
        );
        this.contentContainer.addChild({ render: () => visualLines, invalidate: () => {
        } });
      }
    }
    if (this.status === "running") {
      this.contentContainer.addChild(this.loader);
    } else {
      const statusParts = [];
      if (hiddenLineCount > 0) {
        if (this.expanded) {
          statusParts.push(`(${keyHint("expandTools", "to collapse")})`);
        } else {
          statusParts.push(
            `${theme.fg("muted", `... ${hiddenLineCount} more lines`)} (${keyHint("expandTools", "to expand")})`
          );
        }
      }
      if (this.status === "cancelled") {
        statusParts.push(theme.fg("warning", "(cancelled)"));
      } else if (this.status === "error") {
        statusParts.push(theme.fg("error", `(exit ${this.exitCode})`));
      }
      const wasTruncated = this.truncationResult?.truncated || contextTruncation.truncated;
      if (wasTruncated && this.fullOutputPath) {
        statusParts.push(theme.fg("warning", `Output truncated. Full output: ${this.fullOutputPath}`));
      }
      if (statusParts.length > 0) {
        this.contentContainer.addChild(new Text(`
${statusParts.join("\n")}`, 1, 0));
      }
    }
  }
  /**
   * Get the raw output for creating BashExecutionMessage.
   */
  getOutput() {
    return this.outputLines.join("\n");
  }
  /**
   * Get the command that was executed.
   */
  getCommand() {
    return this.command;
  }
}
export {
  BashExecutionComponent
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9tb2Rlcy9pbnRlcmFjdGl2ZS9jb21wb25lbnRzL2Jhc2gtZXhlY3V0aW9uLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBQcm9qZWN0L0FwcDogR1NELTJcbi8vIEZpbGUgUHVycG9zZTogSW50ZXJhY3RpdmUgdGVybWluYWwgYmFzaCBleGVjdXRpb24gcmVuZGVyZXIgd2l0aCBzdHJlYW1pbmcgb3V0cHV0IGFuZCByZWNvbW1lbmRlZCBjb21tYW5kIGNhcmRzLlxuXG5pbXBvcnQgeyBDb250YWluZXIsIExvYWRlciwgU3BhY2VyLCBUZXh0LCB0eXBlIFRVSSB9IGZyb20gXCJAZ3NkL3BpLXR1aVwiO1xuaW1wb3J0IHN0cmlwQW5zaSBmcm9tIFwic3RyaXAtYW5zaVwiO1xuaW1wb3J0IHtcblx0REVGQVVMVF9NQVhfQllURVMsXG5cdERFRkFVTFRfTUFYX0xJTkVTLFxuXHR0eXBlIFRydW5jYXRpb25SZXN1bHQsXG5cdHRydW5jYXRlVGFpbCxcbn0gZnJvbSBcIi4uLy4uLy4uL2NvcmUvdG9vbHMvdHJ1bmNhdGUuanNcIjtcbmltcG9ydCB7IHRoZW1lIH0gZnJvbSBcIi4uL3RoZW1lL3RoZW1lLmpzXCI7XG5pbXBvcnQgeyBEeW5hbWljQm9yZGVyIH0gZnJvbSBcIi4vZHluYW1pYy1ib3JkZXIuanNcIjtcbmltcG9ydCB7IGVkaXRvcktleSwga2V5SGludCB9IGZyb20gXCIuL2tleWJpbmRpbmctaGludHMuanNcIjtcbmltcG9ydCB7IHJlbmRlckNvbW1hbmRDYXJkLCByZW5kZXJUcmFuc2NyaXB0Q2FyZCwgdHlwZSBTdGF0dXNUb25lIH0gZnJvbSBcIi4vdHJhbnNjcmlwdC1kZXNpZ24uanNcIjtcbmltcG9ydCB7IHRydW5jYXRlVG9WaXN1YWxMaW5lcyB9IGZyb20gXCIuL3Zpc3VhbC10cnVuY2F0ZS5qc1wiO1xuXG4vLyBQcmV2aWV3IGxpbmUgbGltaXQgd2hlbiBub3QgZXhwYW5kZWQgKG1hdGNoZXMgdG9vbCBleGVjdXRpb24gYmVoYXZpb3IpXG5jb25zdCBQUkVWSUVXX0xJTkVTID0gMjA7XG5cbmV4cG9ydCBjbGFzcyBCYXNoRXhlY3V0aW9uQ29tcG9uZW50IGV4dGVuZHMgQ29udGFpbmVyIHtcblx0cHJpdmF0ZSBjb21tYW5kOiBzdHJpbmc7XG5cdHByaXZhdGUgb3V0cHV0TGluZXM6IHN0cmluZ1tdID0gW107XG5cdHByaXZhdGUgc3RhdHVzOiBcInJ1bm5pbmdcIiB8IFwiY29tcGxldGVcIiB8IFwiY2FuY2VsbGVkXCIgfCBcImVycm9yXCIgPSBcInJ1bm5pbmdcIjtcblx0cHJpdmF0ZSBleGl0Q29kZTogbnVtYmVyIHwgdW5kZWZpbmVkID0gdW5kZWZpbmVkO1xuXHRwcml2YXRlIGxvYWRlcjogTG9hZGVyO1xuXHRwcml2YXRlIHRydW5jYXRpb25SZXN1bHQ/OiBUcnVuY2F0aW9uUmVzdWx0O1xuXHRwcml2YXRlIGZ1bGxPdXRwdXRQYXRoPzogc3RyaW5nO1xuXHRwcml2YXRlIGV4cGFuZGVkID0gZmFsc2U7XG5cdHByaXZhdGUgY29udGVudENvbnRhaW5lcjogQ29udGFpbmVyO1xuXHRwcml2YXRlIHVpOiBUVUk7XG5cdHByaXZhdGUgX2JvcmRlckNvbG9yS2V5OiBcImRpbVwiIHwgXCJiYXNoTW9kZVwiO1xuXG5cdGNvbnN0cnVjdG9yKGNvbW1hbmQ6IHN0cmluZywgdWk6IFRVSSwgZXhjbHVkZUZyb21Db250ZXh0ID0gZmFsc2UpIHtcblx0XHRzdXBlcigpO1xuXHRcdHRoaXMuY29tbWFuZCA9IGNvbW1hbmQ7XG5cdFx0dGhpcy51aSA9IHVpO1xuXG5cdFx0Ly8gVXNlIGRpbSBib3JkZXIgZm9yIGV4Y2x1ZGVkLWZyb20tY29udGV4dCBjb21tYW5kcyAoISEgcHJlZml4KVxuXHRcdGNvbnN0IGNvbG9yS2V5ID0gZXhjbHVkZUZyb21Db250ZXh0ID8gXCJkaW1cIiA6IFwiYmFzaE1vZGVcIjtcblx0XHR0aGlzLl9ib3JkZXJDb2xvcktleSA9IGNvbG9yS2V5O1xuXHRcdGNvbnN0IGJvcmRlckNvbG9yID0gKHN0cjogc3RyaW5nKSA9PiB0aGVtZS5mZyhjb2xvcktleSwgc3RyKTtcblxuXHRcdC8vIEFkZCBzcGFjZXJcblx0XHR0aGlzLmFkZENoaWxkKG5ldyBTcGFjZXIoMSkpO1xuXG5cdFx0Ly8gVG9wIGJvcmRlclxuXHRcdHRoaXMuYWRkQ2hpbGQobmV3IER5bmFtaWNCb3JkZXIoYm9yZGVyQ29sb3IpKTtcblxuXHRcdC8vIENvbnRlbnQgY29udGFpbmVyIChob2xkcyBkeW5hbWljIGNvbnRlbnQgYmV0d2VlbiBib3JkZXJzKVxuXHRcdHRoaXMuY29udGVudENvbnRhaW5lciA9IG5ldyBDb250YWluZXIoKTtcblx0XHR0aGlzLmFkZENoaWxkKHRoaXMuY29udGVudENvbnRhaW5lcik7XG5cblx0XHQvLyBDb21tYW5kIGhlYWRlclxuXHRcdGNvbnN0IGhlYWRlciA9IG5ldyBUZXh0KHRoZW1lLmZnKGNvbG9yS2V5LCB0aGVtZS5ib2xkKGAkICR7Y29tbWFuZH1gKSksIDEsIDApO1xuXHRcdHRoaXMuY29udGVudENvbnRhaW5lci5hZGRDaGlsZChoZWFkZXIpO1xuXG5cdFx0Ly8gTG9hZGVyXG5cdFx0dGhpcy5sb2FkZXIgPSBuZXcgTG9hZGVyKFxuXHRcdFx0dWksXG5cdFx0XHQoc3Bpbm5lcikgPT4gdGhlbWUuZmcoY29sb3JLZXksIHNwaW5uZXIpLFxuXHRcdFx0KHRleHQpID0+IHRoZW1lLmZnKFwibXV0ZWRcIiwgdGV4dCksXG5cdFx0XHRgUnVubmluZy4uLiAoJHtlZGl0b3JLZXkoXCJzZWxlY3RDYW5jZWxcIil9IHRvIGNhbmNlbClgLCAvLyBQbGFpbiB0ZXh0IGZvciBsb2FkZXJcblx0XHQpO1xuXHRcdHRoaXMuY29udGVudENvbnRhaW5lci5hZGRDaGlsZCh0aGlzLmxvYWRlcik7XG5cblx0XHQvLyBCb3R0b20gYm9yZGVyXG5cdFx0dGhpcy5hZGRDaGlsZChuZXcgRHluYW1pY0JvcmRlcihib3JkZXJDb2xvcikpO1xuXHR9XG5cblx0LyoqXG5cdCAqIFNldCB3aGV0aGVyIHRoZSBvdXRwdXQgaXMgZXhwYW5kZWQgKHNob3dzIGZ1bGwgb3V0cHV0KSBvciBjb2xsYXBzZWQgKHByZXZpZXcgb25seSkuXG5cdCAqL1xuXHRzZXRFeHBhbmRlZChleHBhbmRlZDogYm9vbGVhbik6IHZvaWQge1xuXHRcdHRoaXMuZXhwYW5kZWQgPSBleHBhbmRlZDtcblx0XHR0aGlzLnVwZGF0ZURpc3BsYXkoKTtcblx0fVxuXG5cdG92ZXJyaWRlIGludmFsaWRhdGUoKTogdm9pZCB7XG5cdFx0c3VwZXIuaW52YWxpZGF0ZSgpO1xuXHRcdHRoaXMudXBkYXRlRGlzcGxheSgpO1xuXHR9XG5cblx0YXBwZW5kT3V0cHV0KGNodW5rOiBzdHJpbmcpOiB2b2lkIHtcblx0XHQvLyBTdHJpcCBBTlNJIGNvZGVzIGFuZCBub3JtYWxpemUgbGluZSBlbmRpbmdzXG5cdFx0Ly8gTm90ZTogYmluYXJ5IGRhdGEgaXMgYWxyZWFkeSBzYW5pdGl6ZWQgaW4gdHVpLXJlbmRlcmVyLnRzIGV4ZWN1dGVCYXNoQ29tbWFuZFxuXHRcdGNvbnN0IGNsZWFuID0gc3RyaXBBbnNpKGNodW5rKS5yZXBsYWNlKC9cXHJcXG4vZywgXCJcXG5cIikucmVwbGFjZSgvXFxyL2csIFwiXFxuXCIpO1xuXG5cdFx0Ly8gQXBwZW5kIHRvIG91dHB1dCBsaW5lc1xuXHRcdGNvbnN0IG5ld0xpbmVzID0gY2xlYW4uc3BsaXQoXCJcXG5cIik7XG5cdFx0aWYgKHRoaXMub3V0cHV0TGluZXMubGVuZ3RoID4gMCAmJiBuZXdMaW5lcy5sZW5ndGggPiAwKSB7XG5cdFx0XHQvLyBBcHBlbmQgZmlyc3QgY2h1bmsgdG8gbGFzdCBsaW5lIChpbmNvbXBsZXRlIGxpbmUgY29udGludWF0aW9uKVxuXHRcdFx0dGhpcy5vdXRwdXRMaW5lc1t0aGlzLm91dHB1dExpbmVzLmxlbmd0aCAtIDFdICs9IG5ld0xpbmVzWzBdO1xuXHRcdFx0dGhpcy5vdXRwdXRMaW5lcy5wdXNoKC4uLm5ld0xpbmVzLnNsaWNlKDEpKTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0dGhpcy5vdXRwdXRMaW5lcy5wdXNoKC4uLm5ld0xpbmVzKTtcblx0XHR9XG5cblx0XHR0aGlzLnVwZGF0ZURpc3BsYXkoKTtcblx0fVxuXG5cdHNldENvbXBsZXRlKFxuXHRcdGV4aXRDb2RlOiBudW1iZXIgfCB1bmRlZmluZWQsXG5cdFx0Y2FuY2VsbGVkOiBib29sZWFuLFxuXHRcdHRydW5jYXRpb25SZXN1bHQ/OiBUcnVuY2F0aW9uUmVzdWx0LFxuXHRcdGZ1bGxPdXRwdXRQYXRoPzogc3RyaW5nLFxuXHQpOiB2b2lkIHtcblx0XHR0aGlzLmV4aXRDb2RlID0gZXhpdENvZGU7XG5cdFx0dGhpcy5zdGF0dXMgPSBjYW5jZWxsZWRcblx0XHRcdD8gXCJjYW5jZWxsZWRcIlxuXHRcdFx0OiBleGl0Q29kZSAhPT0gMCAmJiBleGl0Q29kZSAhPT0gdW5kZWZpbmVkICYmIGV4aXRDb2RlICE9PSBudWxsXG5cdFx0XHRcdD8gXCJlcnJvclwiXG5cdFx0XHRcdDogXCJjb21wbGV0ZVwiO1xuXHRcdHRoaXMudHJ1bmNhdGlvblJlc3VsdCA9IHRydW5jYXRpb25SZXN1bHQ7XG5cdFx0dGhpcy5mdWxsT3V0cHV0UGF0aCA9IGZ1bGxPdXRwdXRQYXRoO1xuXG5cdFx0Ly8gU3RvcCBsb2FkZXJcblx0XHR0aGlzLmxvYWRlci5zdG9wKCk7XG5cblx0XHR0aGlzLnVwZGF0ZURpc3BsYXkoKTtcblx0fVxuXG5cdG92ZXJyaWRlIHJlbmRlcih3aWR0aDogbnVtYmVyKTogc3RyaW5nW10ge1xuXHRcdGNvbnN0IGZyYW1lV2lkdGggPSBNYXRoLm1heCgyMCwgd2lkdGgpO1xuXHRcdGNvbnN0IGVsYXBzZWRTdGF0dXMgPVxuXHRcdFx0dGhpcy5zdGF0dXMgPT09IFwicnVubmluZ1wiXG5cdFx0XHRcdD8gXCJydW5uaW5nXCJcblx0XHRcdFx0OiB0aGlzLnN0YXR1cyA9PT0gXCJjb21wbGV0ZVwiXG5cdFx0XHRcdFx0PyBcInN1Y2Nlc3NcIlxuXHRcdFx0XHRcdDogdGhpcy5zdGF0dXMgPT09IFwiY2FuY2VsbGVkXCJcblx0XHRcdFx0XHRcdD8gXCJjYW5jZWxsZWRcIlxuXHRcdFx0XHRcdFx0OiBgZmFpbGVkJHt0aGlzLmV4aXRDb2RlICE9PSB1bmRlZmluZWQgPyBgIFx1MDBCNyBleGl0ICR7dGhpcy5leGl0Q29kZX1gIDogXCJcIn1gO1xuXHRcdGNvbnN0IHRvbmU6IFN0YXR1c1RvbmUgPVxuXHRcdFx0dGhpcy5zdGF0dXMgPT09IFwicnVubmluZ1wiXG5cdFx0XHRcdD8gXCJydW5uaW5nXCJcblx0XHRcdFx0OiB0aGlzLnN0YXR1cyA9PT0gXCJjb21wbGV0ZVwiXG5cdFx0XHRcdFx0PyBcInN1Y2Nlc3NcIlxuXHRcdFx0XHRcdDogdGhpcy5zdGF0dXMgPT09IFwiY2FuY2VsbGVkXCJcblx0XHRcdFx0XHRcdD8gXCJ3YXJuaW5nXCJcblx0XHRcdFx0XHRcdDogXCJlcnJvclwiO1xuXG5cdFx0aWYgKCF0aGlzLmV4cGFuZGVkICYmIHRoaXMuc3RhdHVzICE9PSBcImVycm9yXCIpIHtcblx0XHRcdHJldHVybiBbXG5cdFx0XHRcdFwiXCIsXG5cdFx0XHRcdC4uLnJlbmRlckNvbW1hbmRDYXJkKHRoaXMuY29tbWFuZC5yZXBsYWNlKC9cXHMrL2csIFwiIFwiKS50cmltKCksIGZyYW1lV2lkdGgsIHtcblx0XHRcdFx0XHRzdGF0dXM6IGVsYXBzZWRTdGF0dXMsXG5cdFx0XHRcdFx0dG9uZSxcblx0XHRcdFx0fSksXG5cdFx0XHRdO1xuXHRcdH1cblxuXHRcdGNvbnN0IG91dHB1dCA9IHRoaXMub3V0cHV0TGluZXMuam9pbihcIlxcblwiKTtcblx0XHRjb25zdCBjb250ZXh0VHJ1bmNhdGlvbiA9IHRydW5jYXRlVGFpbChvdXRwdXQsIHtcblx0XHRcdG1heExpbmVzOiBERUZBVUxUX01BWF9MSU5FUyxcblx0XHRcdG1heEJ5dGVzOiBERUZBVUxUX01BWF9CWVRFUyxcblx0XHR9KTtcblx0XHRjb25zdCB0cnVuY2F0aW9uUmVzdWx0ID0gdGhpcy50cnVuY2F0aW9uUmVzdWx0ID8/IGNvbnRleHRUcnVuY2F0aW9uO1xuXHRcdGNvbnN0IGZ1bGxPdXRwdXRQYXRoID0gdGhpcy5mdWxsT3V0cHV0UGF0aDtcblx0XHRjb25zdCBhdmFpbGFibGVMaW5lcyA9IGNvbnRleHRUcnVuY2F0aW9uLmNvbnRlbnQgPyBjb250ZXh0VHJ1bmNhdGlvbi5jb250ZW50LnNwbGl0KFwiXFxuXCIpIDogW107XG5cdFx0Y29uc3QgcHJldmlldyA9IHRoaXMuZXhwYW5kZWQgPyBhdmFpbGFibGVMaW5lcyA6IGF2YWlsYWJsZUxpbmVzLnNsaWNlKC1QUkVWSUVXX0xJTkVTKTtcblx0XHRjb25zdCBoaWRkZW4gPSBNYXRoLm1heCgwLCBhdmFpbGFibGVMaW5lcy5sZW5ndGggLSBwcmV2aWV3Lmxlbmd0aCk7XG5cdFx0Y29uc3QgdHJ1bmNhdGlvbldhcm5pbmcgPVxuXHRcdFx0KHRydW5jYXRpb25SZXN1bHQudHJ1bmNhdGVkIHx8IGNvbnRleHRUcnVuY2F0aW9uLnRydW5jYXRlZCkgJiYgZnVsbE91dHB1dFBhdGhcblx0XHRcdFx0PyBbdGhlbWUuZmcoXCJ3YXJuaW5nXCIsIGBPdXRwdXQgdHJ1bmNhdGVkLiBGdWxsIG91dHB1dDogJHtmdWxsT3V0cHV0UGF0aH1gKV1cblx0XHRcdFx0OiBbXTtcblx0XHRjb25zdCBib2R5ID0gW1xuXHRcdFx0dGhlbWUuZmcoXCJ0b29sVGl0bGVcIiwgYCQgJHt0aGlzLmNvbW1hbmR9YCksXG5cdFx0XHQuLi5wcmV2aWV3Lm1hcCgobGluZSkgPT4gdGhlbWUuZmcoXCJ0b29sT3V0cHV0XCIsIGxpbmUpKSxcblx0XHRcdC4uLihoaWRkZW4gPiAwID8gW3RoZW1lLmZnKFwibXV0ZWRcIiwgYC4uLiAke2hpZGRlbn0gZWFybGllciBsaW5lc2ApXSA6IFtdKSxcblx0XHRcdC4uLnRydW5jYXRpb25XYXJuaW5nLFxuXHRcdF07XG5cdFx0cmV0dXJuIFtcblx0XHRcdFwiXCIsXG5cdFx0XHQuLi5yZW5kZXJUcmFuc2NyaXB0Q2FyZChib2R5LCBmcmFtZVdpZHRoLCB7XG5cdFx0XHRcdHRpdGxlOiBcImNvbW1hbmRcIixcblx0XHRcdFx0cmlnaHQ6IGVsYXBzZWRTdGF0dXMsXG5cdFx0XHRcdHRvbmUsXG5cdFx0XHRcdGZvb3RlckxlZnQ6IHRoaXMuZXhwYW5kZWQgPyBcIm91dHB1dCBleHBhbmRlZFwiIDogXCJvdXRwdXQgcHJldmlld1wiLFxuXHRcdFx0XHRmb290ZXJSaWdodDogdGhpcy5leHBhbmRlZCA/IFwiY3RybCtvIGNvbGxhcHNlXCIgOiBcImN0cmwrbyBleHBhbmRcIixcblx0XHRcdH0pLFxuXHRcdF07XG5cdH1cblxuXHRwcml2YXRlIHVwZGF0ZURpc3BsYXkoKTogdm9pZCB7XG5cdFx0Ly8gQXBwbHkgdHJ1bmNhdGlvbiBmb3IgTExNIGNvbnRleHQgbGltaXRzIChzYW1lIGxpbWl0cyBhcyBiYXNoIHRvb2wpXG5cdFx0Y29uc3QgZnVsbE91dHB1dCA9IHRoaXMub3V0cHV0TGluZXMuam9pbihcIlxcblwiKTtcblx0XHRjb25zdCBjb250ZXh0VHJ1bmNhdGlvbiA9IHRydW5jYXRlVGFpbChmdWxsT3V0cHV0LCB7XG5cdFx0XHRtYXhMaW5lczogREVGQVVMVF9NQVhfTElORVMsXG5cdFx0XHRtYXhCeXRlczogREVGQVVMVF9NQVhfQllURVMsXG5cdFx0fSk7XG5cblx0XHQvLyBHZXQgdGhlIGxpbmVzIHRvIHBvdGVudGlhbGx5IGRpc3BsYXkgKGFmdGVyIGNvbnRleHQgdHJ1bmNhdGlvbilcblx0XHRjb25zdCBhdmFpbGFibGVMaW5lcyA9IGNvbnRleHRUcnVuY2F0aW9uLmNvbnRlbnQgPyBjb250ZXh0VHJ1bmNhdGlvbi5jb250ZW50LnNwbGl0KFwiXFxuXCIpIDogW107XG5cblx0XHQvLyBBcHBseSBwcmV2aWV3IHRydW5jYXRpb24gYmFzZWQgb24gZXhwYW5kZWQgc3RhdGVcblx0XHRjb25zdCBwcmV2aWV3TG9naWNhbExpbmVzID0gYXZhaWxhYmxlTGluZXMuc2xpY2UoLVBSRVZJRVdfTElORVMpO1xuXHRcdGNvbnN0IGhpZGRlbkxpbmVDb3VudCA9IGF2YWlsYWJsZUxpbmVzLmxlbmd0aCAtIHByZXZpZXdMb2dpY2FsTGluZXMubGVuZ3RoO1xuXG5cdFx0Ly8gUmVidWlsZCBjb250ZW50IGNvbnRhaW5lclxuXHRcdHRoaXMuY29udGVudENvbnRhaW5lci5jbGVhcigpO1xuXG5cdFx0Ly8gQ29tbWFuZCBoZWFkZXJcblx0XHRjb25zdCBoZWFkZXIgPSBuZXcgVGV4dCh0aGVtZS5mZyh0aGlzLl9ib3JkZXJDb2xvcktleSwgdGhlbWUuYm9sZChgJCAke3RoaXMuY29tbWFuZH1gKSksIDEsIDApO1xuXHRcdHRoaXMuY29udGVudENvbnRhaW5lci5hZGRDaGlsZChoZWFkZXIpO1xuXG5cdFx0Ly8gT3V0cHV0XG5cdFx0aWYgKGF2YWlsYWJsZUxpbmVzLmxlbmd0aCA+IDApIHtcblx0XHRcdGlmICh0aGlzLmV4cGFuZGVkKSB7XG5cdFx0XHRcdC8vIFNob3cgYWxsIGxpbmVzXG5cdFx0XHRcdGNvbnN0IGRpc3BsYXlUZXh0ID0gYXZhaWxhYmxlTGluZXMubWFwKChsaW5lKSA9PiB0aGVtZS5mZyhcIm11dGVkXCIsIGxpbmUpKS5qb2luKFwiXFxuXCIpO1xuXHRcdFx0XHR0aGlzLmNvbnRlbnRDb250YWluZXIuYWRkQ2hpbGQobmV3IFRleHQoYFxcbiR7ZGlzcGxheVRleHR9YCwgMSwgMCkpO1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0Ly8gVXNlIHNoYXJlZCB2aXN1YWwgdHJ1bmNhdGlvbiB1dGlsaXR5XG5cdFx0XHRcdGNvbnN0IHN0eWxlZE91dHB1dCA9IHByZXZpZXdMb2dpY2FsTGluZXMubWFwKChsaW5lKSA9PiB0aGVtZS5mZyhcIm11dGVkXCIsIGxpbmUpKS5qb2luKFwiXFxuXCIpO1xuXHRcdFx0XHRjb25zdCB7IHZpc3VhbExpbmVzIH0gPSB0cnVuY2F0ZVRvVmlzdWFsTGluZXMoXG5cdFx0XHRcdFx0YFxcbiR7c3R5bGVkT3V0cHV0fWAsXG5cdFx0XHRcdFx0UFJFVklFV19MSU5FUyxcblx0XHRcdFx0XHR0aGlzLnVpLnRlcm1pbmFsLmNvbHVtbnMsXG5cdFx0XHRcdFx0MSwgLy8gcGFkZGluZ1xuXHRcdFx0XHQpO1xuXHRcdFx0XHR0aGlzLmNvbnRlbnRDb250YWluZXIuYWRkQ2hpbGQoeyByZW5kZXI6ICgpID0+IHZpc3VhbExpbmVzLCBpbnZhbGlkYXRlOiAoKSA9PiB7fSB9KTtcblx0XHRcdH1cblx0XHR9XG5cblx0XHQvLyBMb2FkZXIgb3Igc3RhdHVzXG5cdFx0aWYgKHRoaXMuc3RhdHVzID09PSBcInJ1bm5pbmdcIikge1xuXHRcdFx0dGhpcy5jb250ZW50Q29udGFpbmVyLmFkZENoaWxkKHRoaXMubG9hZGVyKTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0Y29uc3Qgc3RhdHVzUGFydHM6IHN0cmluZ1tdID0gW107XG5cblx0XHRcdC8vIFNob3cgaG93IG1hbnkgbGluZXMgYXJlIGhpZGRlbiAoY29sbGFwc2VkIHByZXZpZXcpXG5cdFx0XHRpZiAoaGlkZGVuTGluZUNvdW50ID4gMCkge1xuXHRcdFx0XHRpZiAodGhpcy5leHBhbmRlZCkge1xuXHRcdFx0XHRcdHN0YXR1c1BhcnRzLnB1c2goYCgke2tleUhpbnQoXCJleHBhbmRUb29sc1wiLCBcInRvIGNvbGxhcHNlXCIpfSlgKTtcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRzdGF0dXNQYXJ0cy5wdXNoKFxuXHRcdFx0XHRcdFx0YCR7dGhlbWUuZmcoXCJtdXRlZFwiLCBgLi4uICR7aGlkZGVuTGluZUNvdW50fSBtb3JlIGxpbmVzYCl9ICgke2tleUhpbnQoXCJleHBhbmRUb29sc1wiLCBcInRvIGV4cGFuZFwiKX0pYCxcblx0XHRcdFx0XHQpO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdGlmICh0aGlzLnN0YXR1cyA9PT0gXCJjYW5jZWxsZWRcIikge1xuXHRcdFx0XHRzdGF0dXNQYXJ0cy5wdXNoKHRoZW1lLmZnKFwid2FybmluZ1wiLCBcIihjYW5jZWxsZWQpXCIpKTtcblx0XHRcdH0gZWxzZSBpZiAodGhpcy5zdGF0dXMgPT09IFwiZXJyb3JcIikge1xuXHRcdFx0XHRzdGF0dXNQYXJ0cy5wdXNoKHRoZW1lLmZnKFwiZXJyb3JcIiwgYChleGl0ICR7dGhpcy5leGl0Q29kZX0pYCkpO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBBZGQgdHJ1bmNhdGlvbiB3YXJuaW5nIChjb250ZXh0IHRydW5jYXRpb24sIG5vdCBwcmV2aWV3IHRydW5jYXRpb24pXG5cdFx0XHRjb25zdCB3YXNUcnVuY2F0ZWQgPSB0aGlzLnRydW5jYXRpb25SZXN1bHQ/LnRydW5jYXRlZCB8fCBjb250ZXh0VHJ1bmNhdGlvbi50cnVuY2F0ZWQ7XG5cdFx0XHRpZiAod2FzVHJ1bmNhdGVkICYmIHRoaXMuZnVsbE91dHB1dFBhdGgpIHtcblx0XHRcdFx0c3RhdHVzUGFydHMucHVzaCh0aGVtZS5mZyhcIndhcm5pbmdcIiwgYE91dHB1dCB0cnVuY2F0ZWQuIEZ1bGwgb3V0cHV0OiAke3RoaXMuZnVsbE91dHB1dFBhdGh9YCkpO1xuXHRcdFx0fVxuXG5cdFx0XHRpZiAoc3RhdHVzUGFydHMubGVuZ3RoID4gMCkge1xuXHRcdFx0XHR0aGlzLmNvbnRlbnRDb250YWluZXIuYWRkQ2hpbGQobmV3IFRleHQoYFxcbiR7c3RhdHVzUGFydHMuam9pbihcIlxcblwiKX1gLCAxLCAwKSk7XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG5cblx0LyoqXG5cdCAqIEdldCB0aGUgcmF3IG91dHB1dCBmb3IgY3JlYXRpbmcgQmFzaEV4ZWN1dGlvbk1lc3NhZ2UuXG5cdCAqL1xuXHRnZXRPdXRwdXQoKTogc3RyaW5nIHtcblx0XHRyZXR1cm4gdGhpcy5vdXRwdXRMaW5lcy5qb2luKFwiXFxuXCIpO1xuXHR9XG5cblx0LyoqXG5cdCAqIEdldCB0aGUgY29tbWFuZCB0aGF0IHdhcyBleGVjdXRlZC5cblx0ICovXG5cdGdldENvbW1hbmQoKTogc3RyaW5nIHtcblx0XHRyZXR1cm4gdGhpcy5jb21tYW5kO1xuXHR9XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFHQSxTQUFTLFdBQVcsUUFBUSxRQUFRLFlBQXNCO0FBQzFELE9BQU8sZUFB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QUFBQSxVQUN2QjtBQUFBLEVBQUssWUFBWTtBQUFBLFVBQ2pCO0FBQUEsVUFDQSxLQUFLLEdBQUcsU0FBUztBQUFBLFVBQ2pCO0FBQUE7QUFBQSxRQUNEO0FBQ0EsYUFBSyxpQkFBaUIsU0FBUyxFQUFFLFFBQVEsTUFBTSxhQUFhLFlBQVksTUFBTTtBQUFBLFFBQUMsRUFBRSxDQUFDO0FBQUEsTUFDbkY7QUFBQSxJQUNEO0FBR0EsUUFBSSxLQUFLLFdBQVcsV0FBVztBQUM5QixXQUFLLGlCQUFpQixTQUFTLEtBQUssTUFBTTtBQUFBLElBQzNDLE9BQU87QUFDTixZQUFNLGNBQXdCLENBQUM7QUFHL0IsVUFBSSxrQkFBa0IsR0FBRztBQUN4QixZQUFJLEtBQUssVUFBVTtBQUNsQixzQkFBWSxLQUFLLElBQUksUUFBUSxlQUFlLGFBQWEsQ0FBQyxHQUFHO0FBQUEsUUFDOUQsT0FBTztBQUNOLHNCQUFZO0FBQUEsWUFDWCxHQUFHLE1BQU0sR0FBRyxTQUFTLE9BQU8sZUFBZSxhQUFhLENBQUMsS0FBSyxRQUFRLGVBQWUsV0FBVyxDQUFDO0FBQUEsVUFDbEc7QUFBQSxRQUNEO0FBQUEsTUFDRDtBQUVBLFVBQUksS0FBSyxXQUFXLGFBQWE7QUFDaEMsb0JBQVksS0FBSyxNQUFNLEdBQUcsV0FBVyxhQUFhLENBQUM7QUFBQSxNQUNwRCxXQUFXLEtBQUssV0FBVyxTQUFTO0FBQ25DLG9CQUFZLEtBQUssTUFBTSxHQUFHLFNBQVMsU0FBUyxLQUFLLFFBQVEsR0FBRyxDQUFDO0FBQUEsTUFDOUQ7QUFHQSxZQUFNLGVBQWUsS0FBSyxrQkFBa0IsYUFBYSxrQkFBa0I7QUFDM0UsVUFBSSxnQkFBZ0IsS0FBSyxnQkFBZ0I7QUFDeEMsb0JBQVksS0FBSyxNQUFNLEdBQUcsV0FBVyxrQ0FBa0MsS0FBSyxjQUFjLEVBQUUsQ0FBQztBQUFBLE1BQzlGO0FBRUEsVUFBSSxZQUFZLFNBQVMsR0FBRztBQUMzQixhQUFLLGlCQUFpQixTQUFTLElBQUksS0FBSztBQUFBLEVBQUssWUFBWSxLQUFLLElBQUksQ0FBQyxJQUFJLEdBQUcsQ0FBQyxDQUFDO0FBQUEsTUFDN0U7QUFBQSxJQUNEO0FBQUEsRUFDRDtBQUFBO0FBQUE7QUFBQTtBQUFBLEVBS0EsWUFBb0I7QUFDbkIsV0FBTyxLQUFLLFlBQVksS0FBSyxJQUFJO0FBQUEsRUFDbEM7QUFBQTtBQUFBO0FBQUE7QUFBQSxFQUtBLGFBQXFCO0FBQ3BCLFdBQU8sS0FBSztBQUFBLEVBQ2I7QUFDRDsiLAogICJuYW1lcyI6IFtdCn0K
