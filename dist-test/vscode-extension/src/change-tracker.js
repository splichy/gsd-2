import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  captureCurrentSnapshots,
  captureOriginalContent,
  describeAction,
  getToolInput,
  getToolUseId,
  isFileMutationTool,
  normalizeToolName,
  resolveToolPath
} from "./change-tracker-core.js";
class GsdChangeTracker {
  constructor(client, workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()) {
    this.client = client;
    this.workspaceRoot = workspaceRoot;
    this.disposables.push(this._onDidChange, this._onCheckpointChange);
    this.disposables.push(
      client.onEvent((evt) => this.handleEvent(evt)),
      client.onConnectionChange((connected) => {
        if (!connected) {
          this.reset();
        }
      })
    );
  }
  /** file path → original content (before first agent modification this session) */
  originals = /* @__PURE__ */ new Map();
  /** Set of file paths modified in the current agent turn */
  currentTurnFiles = /* @__PURE__ */ new Set();
  /** Ordered list of checkpoints */
  _checkpoints = [];
  nextCheckpointId = 1;
  /** toolUseId → file path for in-flight tool executions */
  pendingTools = /* @__PURE__ */ new Map();
  /** Whether the current turn has been described in the checkpoint label */
  turnDescribed = false;
  _onDidChange = new vscode.EventEmitter();
  /** Fires when the set of tracked files changes. Payload is array of changed file paths. */
  onDidChange = this._onDidChange.event;
  _onCheckpointChange = new vscode.EventEmitter();
  onCheckpointChange = this._onCheckpointChange.event;
  disposables = [];
  /** All file paths that have been modified by the agent */
  get modifiedFiles() {
    return [...this.originals.keys()];
  }
  /** Get the original content of a file (before agent first modified it) */
  getOriginal(filePath) {
    const original = this.originals.get(filePath);
    return original === void 0 ? void 0 : original ?? "";
  }
  /** Whether the tracker has any modifications */
  get hasChanges() {
    return this.originals.size > 0;
  }
  /** Current checkpoints (newest first) */
  get checkpoints() {
    return this._checkpoints;
  }
  /**
   * Discard agent changes to a single file — restore original content.
   * Returns true if the file was restored.
   */
  async discardFile(filePath) {
    const original = this.originals.get(filePath);
    if (original === void 0) return false;
    try {
      if (original === null) {
        await fs.promises.rm(filePath, { force: true });
      } else {
        await fs.promises.writeFile(filePath, original, "utf8");
      }
      this.originals.delete(filePath);
      this._onDidChange.fire([filePath]);
      return true;
    } catch {
      return false;
    }
  }
  /**
   * Discard all agent changes — restore all files to their original state.
   */
  async discardAll() {
    let count = 0;
    const paths = [...this.originals.keys()];
    for (const filePath of paths) {
      if (await this.discardFile(filePath)) {
        count++;
      }
    }
    return count;
  }
  /**
   * Accept changes to a file — remove from tracking (keep the current content).
   */
  acceptFile(filePath) {
    if (this.originals.delete(filePath)) {
      this._onDidChange.fire([filePath]);
    }
  }
  /**
   * Accept all changes — clear all tracking.
   */
  acceptAll() {
    const paths = [...this.originals.keys()];
    this.originals.clear();
    if (paths.length > 0) {
      this._onDidChange.fire(paths);
    }
  }
  /**
   * Restore all files to a checkpoint state.
   */
  async restoreCheckpoint(checkpointId) {
    const idx = this._checkpoints.findIndex((c) => c.id === checkpointId);
    if (idx === -1) return 0;
    const checkpoint = this._checkpoints[idx];
    let count = 0;
    for (const [filePath, content] of checkpoint.snapshots) {
      try {
        if (content === null) {
          await fs.promises.rm(filePath, { force: true });
        } else {
          await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
          await fs.promises.writeFile(filePath, content, "utf8");
        }
        count++;
      } catch {
      }
    }
    this.originals = new Map(checkpoint.snapshots);
    this._checkpoints = this._checkpoints.slice(0, idx);
    this._onDidChange.fire([...checkpoint.snapshots.keys()]);
    this._onCheckpointChange.fire();
    return count;
  }
  /** Clear all tracking state */
  reset() {
    const paths = [...this.originals.keys()];
    this.originals.clear();
    this.currentTurnFiles.clear();
    this.pendingTools.clear();
    this._checkpoints = [];
    this.nextCheckpointId = 1;
    if (paths.length > 0) {
      this._onDidChange.fire(paths);
    }
    this._onCheckpointChange.fire();
  }
  dispose() {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
  handleEvent(evt) {
    switch (evt.type) {
      case "agent_start":
        this.createCheckpoint();
        this.currentTurnFiles.clear();
        this.turnDescribed = false;
        break;
      case "tool_execution_start": {
        const toolName = String(evt.toolName ?? "");
        const normalizedToolName = normalizeToolName(toolName);
        const toolInput = getToolInput(evt);
        const toolUseId = getToolUseId(evt);
        if (!this.turnDescribed) {
          this.turnDescribed = true;
          this.updateLatestCheckpointLabel(describeAction(toolName, toolInput));
        }
        if (!isFileMutationTool(normalizedToolName)) break;
        const filePath = this.resolveToolPath(toolInput);
        if (!filePath) break;
        if (!this.originals.has(filePath)) {
          const original = captureOriginalContent(filePath, fs);
          if (original !== void 0) {
            this.originals.set(filePath, original);
          }
        }
        if (toolUseId) {
          this.pendingTools.set(toolUseId, filePath);
        }
        break;
      }
      case "tool_execution_end": {
        const toolUseId = getToolUseId(evt);
        const filePath = this.pendingTools.get(toolUseId);
        if (filePath) {
          this.pendingTools.delete(toolUseId);
          this.currentTurnFiles.add(filePath);
          this._onDidChange.fire([filePath]);
        }
        break;
      }
    }
  }
  resolveToolPath(input) {
    return resolveToolPath(this.workspaceRoot, input);
  }
  createCheckpoint() {
    const now = Date.now();
    const time = new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const fileCount = this.originals.size;
    const label = fileCount > 0 ? `${time} (${fileCount} file${fileCount !== 1 ? "s" : ""} tracked)` : `${time} (start)`;
    const checkpoint = {
      id: this.nextCheckpointId++,
      label,
      timestamp: now,
      snapshots: this.captureCurrentSnapshots()
    };
    this._checkpoints.push(checkpoint);
    this._onCheckpointChange.fire();
  }
  captureCurrentSnapshots() {
    return captureCurrentSnapshots(this.originals.keys(), fs);
  }
  /**
   * Update the label of the latest checkpoint with a description
   * of the first action taken (called after first tool execution in a turn).
   */
  updateLatestCheckpointLabel(description) {
    if (this._checkpoints.length === 0) return;
    const latest = this._checkpoints[this._checkpoints.length - 1];
    const time = new Date(latest.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    latest.label = `${time} \u2014 ${description}`;
    this._onCheckpointChange.fire();
  }
}
export {
  GsdChangeTracker
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vdnNjb2RlLWV4dGVuc2lvbi9zcmMvY2hhbmdlLXRyYWNrZXIudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCAqIGFzIHZzY29kZSBmcm9tIFwidnNjb2RlXCI7XG5pbXBvcnQgKiBhcyBmcyBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgdHlwZSB7IEdzZENsaWVudCwgQWdlbnRFdmVudCB9IGZyb20gXCIuL2dzZC1jbGllbnQuanNcIjtcbmltcG9ydCB7XG5cdGNhcHR1cmVDdXJyZW50U25hcHNob3RzLFxuXHRjYXB0dXJlT3JpZ2luYWxDb250ZW50LFxuXHRkZXNjcmliZUFjdGlvbixcblx0Z2V0VG9vbElucHV0LFxuXHRnZXRUb29sVXNlSWQsXG5cdGlzRmlsZU11dGF0aW9uVG9vbCxcblx0bm9ybWFsaXplVG9vbE5hbWUsXG5cdHJlc29sdmVUb29sUGF0aCxcbn0gZnJvbSBcIi4vY2hhbmdlLXRyYWNrZXItY29yZS5qc1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIEZpbGVTbmFwc2hvdCB7XG5cdHVyaTogdnNjb2RlLlVyaTtcblx0b3JpZ2luYWxDb250ZW50OiBzdHJpbmc7XG5cdHRpbWVzdGFtcDogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIENoZWNrcG9pbnQge1xuXHRpZDogbnVtYmVyO1xuXHRsYWJlbDogc3RyaW5nO1xuXHR0aW1lc3RhbXA6IG51bWJlcjtcblx0LyoqIE1hcCBvZiBmaWxlIHBhdGggLT4gY29udGVudCBhdCBjaGVja3BvaW50IGNyZWF0aW9uIHRpbWU7IG51bGwgbWVhbnMgdGhlIGZpbGUgZGlkIG5vdCBleGlzdC4gKi9cblx0c25hcHNob3RzOiBNYXA8c3RyaW5nLCBzdHJpbmcgfCBudWxsPjtcbn1cblxuLyoqXG4gKiBUcmFja3MgZmlsZSBjaGFuZ2VzIG1hZGUgYnkgdGhlIEdTRCBhZ2VudC4gU3RvcmVzIG9yaWdpbmFsIGZpbGUgY29udGVudFxuICogYmVmb3JlIHRoZSBhZ2VudCBtb2RpZmllcyBpdCwgZW5hYmxpbmcgZGlmZiB2aWV3cywgU0NNIGludGVncmF0aW9uLFxuICogYW5kIGNoZWNrcG9pbnQvcm9sbGJhY2sgZnVuY3Rpb25hbGl0eS5cbiAqL1xuZXhwb3J0IGNsYXNzIEdzZENoYW5nZVRyYWNrZXIgaW1wbGVtZW50cyB2c2NvZGUuRGlzcG9zYWJsZSB7XG5cdC8qKiBmaWxlIHBhdGggXHUyMTkyIG9yaWdpbmFsIGNvbnRlbnQgKGJlZm9yZSBmaXJzdCBhZ2VudCBtb2RpZmljYXRpb24gdGhpcyBzZXNzaW9uKSAqL1xuXHRwcml2YXRlIG9yaWdpbmFscyA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmcgfCBudWxsPigpO1xuXHQvKiogU2V0IG9mIGZpbGUgcGF0aHMgbW9kaWZpZWQgaW4gdGhlIGN1cnJlbnQgYWdlbnQgdHVybiAqL1xuXHRwcml2YXRlIGN1cnJlbnRUdXJuRmlsZXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcblx0LyoqIE9yZGVyZWQgbGlzdCBvZiBjaGVja3BvaW50cyAqL1xuXHRwcml2YXRlIF9jaGVja3BvaW50czogQ2hlY2twb2ludFtdID0gW107XG5cdHByaXZhdGUgbmV4dENoZWNrcG9pbnRJZCA9IDE7XG5cdC8qKiB0b29sVXNlSWQgXHUyMTkyIGZpbGUgcGF0aCBmb3IgaW4tZmxpZ2h0IHRvb2wgZXhlY3V0aW9ucyAqL1xuXHRwcml2YXRlIHBlbmRpbmdUb29scyA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG5cdC8qKiBXaGV0aGVyIHRoZSBjdXJyZW50IHR1cm4gaGFzIGJlZW4gZGVzY3JpYmVkIGluIHRoZSBjaGVja3BvaW50IGxhYmVsICovXG5cdHByaXZhdGUgdHVybkRlc2NyaWJlZCA9IGZhbHNlO1xuXG5cdHByaXZhdGUgcmVhZG9ubHkgX29uRGlkQ2hhbmdlID0gbmV3IHZzY29kZS5FdmVudEVtaXR0ZXI8c3RyaW5nW10+KCk7XG5cdC8qKiBGaXJlcyB3aGVuIHRoZSBzZXQgb2YgdHJhY2tlZCBmaWxlcyBjaGFuZ2VzLiBQYXlsb2FkIGlzIGFycmF5IG9mIGNoYW5nZWQgZmlsZSBwYXRocy4gKi9cblx0cmVhZG9ubHkgb25EaWRDaGFuZ2UgPSB0aGlzLl9vbkRpZENoYW5nZS5ldmVudDtcblxuXHRwcml2YXRlIHJlYWRvbmx5IF9vbkNoZWNrcG9pbnRDaGFuZ2UgPSBuZXcgdnNjb2RlLkV2ZW50RW1pdHRlcjx2b2lkPigpO1xuXHRyZWFkb25seSBvbkNoZWNrcG9pbnRDaGFuZ2UgPSB0aGlzLl9vbkNoZWNrcG9pbnRDaGFuZ2UuZXZlbnQ7XG5cblx0cHJpdmF0ZSBkaXNwb3NhYmxlczogdnNjb2RlLkRpc3Bvc2FibGVbXSA9IFtdO1xuXG5cdGNvbnN0cnVjdG9yKFxuXHRcdHByaXZhdGUgcmVhZG9ubHkgY2xpZW50OiBHc2RDbGllbnQsXG5cdFx0cHJpdmF0ZSByZWFkb25seSB3b3Jrc3BhY2VSb290ID0gdnNjb2RlLndvcmtzcGFjZS53b3Jrc3BhY2VGb2xkZXJzPy5bMF0/LnVyaS5mc1BhdGggPz8gcHJvY2Vzcy5jd2QoKSxcblx0KSB7XG5cdFx0dGhpcy5kaXNwb3NhYmxlcy5wdXNoKHRoaXMuX29uRGlkQ2hhbmdlLCB0aGlzLl9vbkNoZWNrcG9pbnRDaGFuZ2UpO1xuXG5cdFx0dGhpcy5kaXNwb3NhYmxlcy5wdXNoKFxuXHRcdFx0Y2xpZW50Lm9uRXZlbnQoKGV2dCkgPT4gdGhpcy5oYW5kbGVFdmVudChldnQpKSxcblx0XHRcdGNsaWVudC5vbkNvbm5lY3Rpb25DaGFuZ2UoKGNvbm5lY3RlZCkgPT4ge1xuXHRcdFx0XHRpZiAoIWNvbm5lY3RlZCkge1xuXHRcdFx0XHRcdHRoaXMucmVzZXQoKTtcblx0XHRcdFx0fVxuXHRcdFx0fSksXG5cdFx0KTtcblx0fVxuXG5cdC8qKiBBbGwgZmlsZSBwYXRocyB0aGF0IGhhdmUgYmVlbiBtb2RpZmllZCBieSB0aGUgYWdlbnQgKi9cblx0Z2V0IG1vZGlmaWVkRmlsZXMoKTogc3RyaW5nW10ge1xuXHRcdHJldHVybiBbLi4udGhpcy5vcmlnaW5hbHMua2V5cygpXTtcblx0fVxuXG5cdC8qKiBHZXQgdGhlIG9yaWdpbmFsIGNvbnRlbnQgb2YgYSBmaWxlIChiZWZvcmUgYWdlbnQgZmlyc3QgbW9kaWZpZWQgaXQpICovXG5cdGdldE9yaWdpbmFsKGZpbGVQYXRoOiBzdHJpbmcpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuXHRcdGNvbnN0IG9yaWdpbmFsID0gdGhpcy5vcmlnaW5hbHMuZ2V0KGZpbGVQYXRoKTtcblx0XHRyZXR1cm4gb3JpZ2luYWwgPT09IHVuZGVmaW5lZCA/IHVuZGVmaW5lZCA6IG9yaWdpbmFsID8/IFwiXCI7XG5cdH1cblxuXHQvKiogV2hldGhlciB0aGUgdHJhY2tlciBoYXMgYW55IG1vZGlmaWNhdGlvbnMgKi9cblx0Z2V0IGhhc0NoYW5nZXMoKTogYm9vbGVhbiB7XG5cdFx0cmV0dXJuIHRoaXMub3JpZ2luYWxzLnNpemUgPiAwO1xuXHR9XG5cblx0LyoqIEN1cnJlbnQgY2hlY2twb2ludHMgKG5ld2VzdCBmaXJzdCkgKi9cblx0Z2V0IGNoZWNrcG9pbnRzKCk6IHJlYWRvbmx5IENoZWNrcG9pbnRbXSB7XG5cdFx0cmV0dXJuIHRoaXMuX2NoZWNrcG9pbnRzO1xuXHR9XG5cblx0LyoqXG5cdCAqIERpc2NhcmQgYWdlbnQgY2hhbmdlcyB0byBhIHNpbmdsZSBmaWxlIFx1MjAxNCByZXN0b3JlIG9yaWdpbmFsIGNvbnRlbnQuXG5cdCAqIFJldHVybnMgdHJ1ZSBpZiB0aGUgZmlsZSB3YXMgcmVzdG9yZWQuXG5cdCAqL1xuXHRhc3luYyBkaXNjYXJkRmlsZShmaWxlUGF0aDogc3RyaW5nKTogUHJvbWlzZTxib29sZWFuPiB7XG5cdFx0Y29uc3Qgb3JpZ2luYWwgPSB0aGlzLm9yaWdpbmFscy5nZXQoZmlsZVBhdGgpO1xuXHRcdGlmIChvcmlnaW5hbCA9PT0gdW5kZWZpbmVkKSByZXR1cm4gZmFsc2U7XG5cblx0XHR0cnkge1xuXHRcdFx0aWYgKG9yaWdpbmFsID09PSBudWxsKSB7XG5cdFx0XHRcdGF3YWl0IGZzLnByb21pc2VzLnJtKGZpbGVQYXRoLCB7IGZvcmNlOiB0cnVlIH0pO1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0YXdhaXQgZnMucHJvbWlzZXMud3JpdGVGaWxlKGZpbGVQYXRoLCBvcmlnaW5hbCwgXCJ1dGY4XCIpO1xuXHRcdFx0fVxuXHRcdFx0dGhpcy5vcmlnaW5hbHMuZGVsZXRlKGZpbGVQYXRoKTtcblx0XHRcdHRoaXMuX29uRGlkQ2hhbmdlLmZpcmUoW2ZpbGVQYXRoXSk7XG5cdFx0XHRyZXR1cm4gdHJ1ZTtcblx0XHR9IGNhdGNoIHtcblx0XHRcdHJldHVybiBmYWxzZTtcblx0XHR9XG5cdH1cblxuXHQvKipcblx0ICogRGlzY2FyZCBhbGwgYWdlbnQgY2hhbmdlcyBcdTIwMTQgcmVzdG9yZSBhbGwgZmlsZXMgdG8gdGhlaXIgb3JpZ2luYWwgc3RhdGUuXG5cdCAqL1xuXHRhc3luYyBkaXNjYXJkQWxsKCk6IFByb21pc2U8bnVtYmVyPiB7XG5cdFx0bGV0IGNvdW50ID0gMDtcblx0XHRjb25zdCBwYXRocyA9IFsuLi50aGlzLm9yaWdpbmFscy5rZXlzKCldO1xuXHRcdGZvciAoY29uc3QgZmlsZVBhdGggb2YgcGF0aHMpIHtcblx0XHRcdGlmIChhd2FpdCB0aGlzLmRpc2NhcmRGaWxlKGZpbGVQYXRoKSkge1xuXHRcdFx0XHRjb3VudCsrO1xuXHRcdFx0fVxuXHRcdH1cblx0XHRyZXR1cm4gY291bnQ7XG5cdH1cblxuXHQvKipcblx0ICogQWNjZXB0IGNoYW5nZXMgdG8gYSBmaWxlIFx1MjAxNCByZW1vdmUgZnJvbSB0cmFja2luZyAoa2VlcCB0aGUgY3VycmVudCBjb250ZW50KS5cblx0ICovXG5cdGFjY2VwdEZpbGUoZmlsZVBhdGg6IHN0cmluZyk6IHZvaWQge1xuXHRcdGlmICh0aGlzLm9yaWdpbmFscy5kZWxldGUoZmlsZVBhdGgpKSB7XG5cdFx0XHR0aGlzLl9vbkRpZENoYW5nZS5maXJlKFtmaWxlUGF0aF0pO1xuXHRcdH1cblx0fVxuXG5cdC8qKlxuXHQgKiBBY2NlcHQgYWxsIGNoYW5nZXMgXHUyMDE0IGNsZWFyIGFsbCB0cmFja2luZy5cblx0ICovXG5cdGFjY2VwdEFsbCgpOiB2b2lkIHtcblx0XHRjb25zdCBwYXRocyA9IFsuLi50aGlzLm9yaWdpbmFscy5rZXlzKCldO1xuXHRcdHRoaXMub3JpZ2luYWxzLmNsZWFyKCk7XG5cdFx0aWYgKHBhdGhzLmxlbmd0aCA+IDApIHtcblx0XHRcdHRoaXMuX29uRGlkQ2hhbmdlLmZpcmUocGF0aHMpO1xuXHRcdH1cblx0fVxuXG5cdC8qKlxuXHQgKiBSZXN0b3JlIGFsbCBmaWxlcyB0byBhIGNoZWNrcG9pbnQgc3RhdGUuXG5cdCAqL1xuXHRhc3luYyByZXN0b3JlQ2hlY2twb2ludChjaGVja3BvaW50SWQ6IG51bWJlcik6IFByb21pc2U8bnVtYmVyPiB7XG5cdFx0Y29uc3QgaWR4ID0gdGhpcy5fY2hlY2twb2ludHMuZmluZEluZGV4KChjKSA9PiBjLmlkID09PSBjaGVja3BvaW50SWQpO1xuXHRcdGlmIChpZHggPT09IC0xKSByZXR1cm4gMDtcblxuXHRcdGNvbnN0IGNoZWNrcG9pbnQgPSB0aGlzLl9jaGVja3BvaW50c1tpZHhdO1xuXHRcdGxldCBjb3VudCA9IDA7XG5cblx0XHRmb3IgKGNvbnN0IFtmaWxlUGF0aCwgY29udGVudF0gb2YgY2hlY2twb2ludC5zbmFwc2hvdHMpIHtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGlmIChjb250ZW50ID09PSBudWxsKSB7XG5cdFx0XHRcdFx0YXdhaXQgZnMucHJvbWlzZXMucm0oZmlsZVBhdGgsIHsgZm9yY2U6IHRydWUgfSk7XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0YXdhaXQgZnMucHJvbWlzZXMubWtkaXIocGF0aC5kaXJuYW1lKGZpbGVQYXRoKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cdFx0XHRcdFx0YXdhaXQgZnMucHJvbWlzZXMud3JpdGVGaWxlKGZpbGVQYXRoLCBjb250ZW50LCBcInV0ZjhcIik7XG5cdFx0XHRcdH1cblx0XHRcdFx0Y291bnQrKztcblx0XHRcdH0gY2F0Y2gge1xuXHRcdFx0XHQvLyBza2lwIGZpbGVzIHRoYXQgY2FuJ3QgYmUgcmVzdG9yZWRcblx0XHRcdH1cblx0XHR9XG5cblx0XHQvLyBSZXNldCBvcmlnaW5hbHMgdG8gdGhlIGNoZWNrcG9pbnQgc3RhdGVcblx0XHR0aGlzLm9yaWdpbmFscyA9IG5ldyBNYXAoY2hlY2twb2ludC5zbmFwc2hvdHMpO1xuXG5cdFx0Ly8gUmVtb3ZlIGFsbCBjaGVja3BvaW50cyBhZnRlciB0aGlzIG9uZVxuXHRcdHRoaXMuX2NoZWNrcG9pbnRzID0gdGhpcy5fY2hlY2twb2ludHMuc2xpY2UoMCwgaWR4KTtcblxuXHRcdHRoaXMuX29uRGlkQ2hhbmdlLmZpcmUoWy4uLmNoZWNrcG9pbnQuc25hcHNob3RzLmtleXMoKV0pO1xuXHRcdHRoaXMuX29uQ2hlY2twb2ludENoYW5nZS5maXJlKCk7XG5cdFx0cmV0dXJuIGNvdW50O1xuXHR9XG5cblx0LyoqIENsZWFyIGFsbCB0cmFja2luZyBzdGF0ZSAqL1xuXHRyZXNldCgpOiB2b2lkIHtcblx0XHRjb25zdCBwYXRocyA9IFsuLi50aGlzLm9yaWdpbmFscy5rZXlzKCldO1xuXHRcdHRoaXMub3JpZ2luYWxzLmNsZWFyKCk7XG5cdFx0dGhpcy5jdXJyZW50VHVybkZpbGVzLmNsZWFyKCk7XG5cdFx0dGhpcy5wZW5kaW5nVG9vbHMuY2xlYXIoKTtcblx0XHR0aGlzLl9jaGVja3BvaW50cyA9IFtdO1xuXHRcdHRoaXMubmV4dENoZWNrcG9pbnRJZCA9IDE7XG5cdFx0aWYgKHBhdGhzLmxlbmd0aCA+IDApIHtcblx0XHRcdHRoaXMuX29uRGlkQ2hhbmdlLmZpcmUocGF0aHMpO1xuXHRcdH1cblx0XHR0aGlzLl9vbkNoZWNrcG9pbnRDaGFuZ2UuZmlyZSgpO1xuXHR9XG5cblx0ZGlzcG9zZSgpOiB2b2lkIHtcblx0XHRmb3IgKGNvbnN0IGQgb2YgdGhpcy5kaXNwb3NhYmxlcykge1xuXHRcdFx0ZC5kaXNwb3NlKCk7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBoYW5kbGVFdmVudChldnQ6IEFnZW50RXZlbnQpOiB2b2lkIHtcblx0XHRzd2l0Y2ggKGV2dC50eXBlKSB7XG5cdFx0XHRjYXNlIFwiYWdlbnRfc3RhcnRcIjpcblx0XHRcdFx0dGhpcy5jcmVhdGVDaGVja3BvaW50KCk7XG5cdFx0XHRcdHRoaXMuY3VycmVudFR1cm5GaWxlcy5jbGVhcigpO1xuXHRcdFx0XHR0aGlzLnR1cm5EZXNjcmliZWQgPSBmYWxzZTtcblx0XHRcdFx0YnJlYWs7XG5cblx0XHRcdGNhc2UgXCJ0b29sX2V4ZWN1dGlvbl9zdGFydFwiOiB7XG5cdFx0XHRcdGNvbnN0IHRvb2xOYW1lID0gU3RyaW5nKGV2dC50b29sTmFtZSA/PyBcIlwiKTtcblx0XHRcdFx0Y29uc3Qgbm9ybWFsaXplZFRvb2xOYW1lID0gbm9ybWFsaXplVG9vbE5hbWUodG9vbE5hbWUpO1xuXHRcdFx0XHRjb25zdCB0b29sSW5wdXQgPSBnZXRUb29sSW5wdXQoZXZ0KTtcblx0XHRcdFx0Y29uc3QgdG9vbFVzZUlkID0gZ2V0VG9vbFVzZUlkKGV2dCk7XG5cblx0XHRcdFx0Ly8gVXBkYXRlIGNoZWNrcG9pbnQgbGFiZWwgd2l0aCBmaXJzdCBhY3Rpb24gZGVzY3JpcHRpb25cblx0XHRcdFx0aWYgKCF0aGlzLnR1cm5EZXNjcmliZWQpIHtcblx0XHRcdFx0XHR0aGlzLnR1cm5EZXNjcmliZWQgPSB0cnVlO1xuXHRcdFx0XHRcdHRoaXMudXBkYXRlTGF0ZXN0Q2hlY2twb2ludExhYmVsKGRlc2NyaWJlQWN0aW9uKHRvb2xOYW1lLCB0b29sSW5wdXQpKTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGlmICghaXNGaWxlTXV0YXRpb25Ub29sKG5vcm1hbGl6ZWRUb29sTmFtZSkpIGJyZWFrO1xuXG5cdFx0XHRcdGNvbnN0IGZpbGVQYXRoID0gdGhpcy5yZXNvbHZlVG9vbFBhdGgodG9vbElucHV0KTtcblxuXHRcdFx0XHRpZiAoIWZpbGVQYXRoKSBicmVhaztcblxuXHRcdFx0XHQvLyBTdG9yZSB0aGUgb3JpZ2luYWwgY29udGVudCBiZWZvcmUgdGhlIGFnZW50IG1vZGlmaWVzIGl0XG5cdFx0XHRcdC8vIE9ubHkgY2FwdHVyZSBvbiBGSVJTVCBtb2RpZmljYXRpb24gKGRvbid0IG92ZXJ3cml0ZSlcblx0XHRcdFx0aWYgKCF0aGlzLm9yaWdpbmFscy5oYXMoZmlsZVBhdGgpKSB7XG5cdFx0XHRcdFx0Y29uc3Qgb3JpZ2luYWwgPSBjYXB0dXJlT3JpZ2luYWxDb250ZW50KGZpbGVQYXRoLCBmcyk7XG5cdFx0XHRcdFx0aWYgKG9yaWdpbmFsICE9PSB1bmRlZmluZWQpIHtcblx0XHRcdFx0XHRcdHRoaXMub3JpZ2luYWxzLnNldChmaWxlUGF0aCwgb3JpZ2luYWwpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXG5cdFx0XHRcdGlmICh0b29sVXNlSWQpIHtcblx0XHRcdFx0XHR0aGlzLnBlbmRpbmdUb29scy5zZXQodG9vbFVzZUlkLCBmaWxlUGF0aCk7XG5cdFx0XHRcdH1cblx0XHRcdFx0YnJlYWs7XG5cdFx0XHR9XG5cblx0XHRcdGNhc2UgXCJ0b29sX2V4ZWN1dGlvbl9lbmRcIjoge1xuXHRcdFx0XHRjb25zdCB0b29sVXNlSWQgPSBnZXRUb29sVXNlSWQoZXZ0KTtcblx0XHRcdFx0Y29uc3QgZmlsZVBhdGggPSB0aGlzLnBlbmRpbmdUb29scy5nZXQodG9vbFVzZUlkKTtcblx0XHRcdFx0aWYgKGZpbGVQYXRoKSB7XG5cdFx0XHRcdFx0dGhpcy5wZW5kaW5nVG9vbHMuZGVsZXRlKHRvb2xVc2VJZCk7XG5cdFx0XHRcdFx0dGhpcy5jdXJyZW50VHVybkZpbGVzLmFkZChmaWxlUGF0aCk7XG5cdFx0XHRcdFx0dGhpcy5fb25EaWRDaGFuZ2UuZmlyZShbZmlsZVBhdGhdKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRicmVhaztcblx0XHRcdH1cblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIHJlc29sdmVUb29sUGF0aChpbnB1dDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBzdHJpbmcge1xuXHRcdHJldHVybiByZXNvbHZlVG9vbFBhdGgodGhpcy53b3Jrc3BhY2VSb290LCBpbnB1dCk7XG5cdH1cblxuXHRwcml2YXRlIGNyZWF0ZUNoZWNrcG9pbnQoKTogdm9pZCB7XG5cdFx0Y29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcblx0XHRjb25zdCB0aW1lID0gbmV3IERhdGUobm93KS50b0xvY2FsZVRpbWVTdHJpbmcoW10sIHsgaG91cjogXCIyLWRpZ2l0XCIsIG1pbnV0ZTogXCIyLWRpZ2l0XCIsIHNlY29uZDogXCIyLWRpZ2l0XCIgfSk7XG5cdFx0Y29uc3QgZmlsZUNvdW50ID0gdGhpcy5vcmlnaW5hbHMuc2l6ZTtcblx0XHRjb25zdCBsYWJlbCA9IGZpbGVDb3VudCA+IDBcblx0XHRcdD8gYCR7dGltZX0gKCR7ZmlsZUNvdW50fSBmaWxlJHtmaWxlQ291bnQgIT09IDEgPyBcInNcIiA6IFwiXCJ9IHRyYWNrZWQpYFxuXHRcdFx0OiBgJHt0aW1lfSAoc3RhcnQpYDtcblxuXHRcdGNvbnN0IGNoZWNrcG9pbnQ6IENoZWNrcG9pbnQgPSB7XG5cdFx0XHRpZDogdGhpcy5uZXh0Q2hlY2twb2ludElkKyssXG5cdFx0XHRsYWJlbCxcblx0XHRcdHRpbWVzdGFtcDogbm93LFxuXHRcdFx0c25hcHNob3RzOiB0aGlzLmNhcHR1cmVDdXJyZW50U25hcHNob3RzKCksXG5cdFx0fTtcblx0XHR0aGlzLl9jaGVja3BvaW50cy5wdXNoKGNoZWNrcG9pbnQpO1xuXHRcdHRoaXMuX29uQ2hlY2twb2ludENoYW5nZS5maXJlKCk7XG5cdH1cblxuXHRwcml2YXRlIGNhcHR1cmVDdXJyZW50U25hcHNob3RzKCk6IE1hcDxzdHJpbmcsIHN0cmluZyB8IG51bGw+IHtcblx0XHRyZXR1cm4gY2FwdHVyZUN1cnJlbnRTbmFwc2hvdHModGhpcy5vcmlnaW5hbHMua2V5cygpLCBmcyk7XG5cdH1cblxuXHQvKipcblx0ICogVXBkYXRlIHRoZSBsYWJlbCBvZiB0aGUgbGF0ZXN0IGNoZWNrcG9pbnQgd2l0aCBhIGRlc2NyaXB0aW9uXG5cdCAqIG9mIHRoZSBmaXJzdCBhY3Rpb24gdGFrZW4gKGNhbGxlZCBhZnRlciBmaXJzdCB0b29sIGV4ZWN1dGlvbiBpbiBhIHR1cm4pLlxuXHQgKi9cblx0cHJpdmF0ZSB1cGRhdGVMYXRlc3RDaGVja3BvaW50TGFiZWwoZGVzY3JpcHRpb246IHN0cmluZyk6IHZvaWQge1xuXHRcdGlmICh0aGlzLl9jaGVja3BvaW50cy5sZW5ndGggPT09IDApIHJldHVybjtcblx0XHRjb25zdCBsYXRlc3QgPSB0aGlzLl9jaGVja3BvaW50c1t0aGlzLl9jaGVja3BvaW50cy5sZW5ndGggLSAxXTtcblx0XHRjb25zdCB0aW1lID0gbmV3IERhdGUobGF0ZXN0LnRpbWVzdGFtcCkudG9Mb2NhbGVUaW1lU3RyaW5nKFtdLCB7IGhvdXI6IFwiMi1kaWdpdFwiLCBtaW51dGU6IFwiMi1kaWdpdFwiLCBzZWNvbmQ6IFwiMi1kaWdpdFwiIH0pO1xuXHRcdGxhdGVzdC5sYWJlbCA9IGAke3RpbWV9IFx1MjAxNCAke2Rlc2NyaXB0aW9ufWA7XG5cdFx0dGhpcy5fb25DaGVja3BvaW50Q2hhbmdlLmZpcmUoKTtcblx0fVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsWUFBWSxZQUFZO0FBQ3hCLFlBQVksUUFBUTtBQUNwQixZQUFZLFVBQVU7QUFFdEI7QUFBQSxFQUNDO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ007QUFxQkEsTUFBTSxpQkFBOEM7QUFBQSxFQXNCMUQsWUFDa0IsUUFDQSxnQkFBZ0IsT0FBTyxVQUFVLG1CQUFtQixDQUFDLEdBQUcsSUFBSSxVQUFVLFFBQVEsSUFBSSxHQUNsRztBQUZnQjtBQUNBO0FBRWpCLFNBQUssWUFBWSxLQUFLLEtBQUssY0FBYyxLQUFLLG1CQUFtQjtBQUVqRSxTQUFLLFlBQVk7QUFBQSxNQUNoQixPQUFPLFFBQVEsQ0FBQyxRQUFRLEtBQUssWUFBWSxHQUFHLENBQUM7QUFBQSxNQUM3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
