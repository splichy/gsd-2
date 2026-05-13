import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { buildAgentGitAddArgs, buildAgentGitDiffArgs, buildAgentGitStatusArgs } from "./git-args.js";
class GsdGitIntegration {
  constructor(tracker, cwd) {
    this.tracker = tracker;
    this.cwd = cwd;
  }
  disposables = [];
  /**
   * Commit all files modified by the agent with a user-provided message.
   */
  async commitAgentChanges() {
    const files = this.tracker.modifiedFiles;
    if (files.length === 0) {
      vscode.window.showInformationMessage("No agent changes to commit.");
      return;
    }
    const defaultMsg = `feat: agent changes (${files.length} file${files.length !== 1 ? "s" : ""})`;
    const message = await vscode.window.showInputBox({
      prompt: "Commit message for agent changes",
      value: defaultMsg,
      placeHolder: "feat: describe the changes"
    });
    if (!message) return;
    try {
      await this.git(buildAgentGitAddArgs(files));
      await this.git(["commit", "-m", message]);
      this.tracker.acceptAll();
      vscode.window.showInformationMessage(`Committed ${files.length} file${files.length !== 1 ? "s" : ""}.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Git commit failed: ${msg}`);
    }
  }
  /**
   * Create a new branch for agent work and switch to it.
   */
  async createAgentBranch() {
    const branchName = await vscode.window.showInputBox({
      prompt: "Branch name for agent work",
      placeHolder: "feat/agent-changes",
      validateInput: (value) => {
        if (!value.trim()) return "Branch name is required";
        if (/\s/.test(value)) return "Branch name cannot contain spaces";
        return null;
      }
    });
    if (!branchName) return;
    try {
      await this.git(["checkout", "-b", branchName]);
      vscode.window.showInformationMessage(`Created and switched to branch: ${branchName}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to create branch: ${msg}`);
    }
  }
  /**
   * Show a git diff of all agent-modified files.
   */
  async showAgentDiff() {
    const files = this.tracker.modifiedFiles;
    if (files.length === 0) {
      vscode.window.showInformationMessage("No agent changes to diff.");
      return;
    }
    try {
      const diff = await this.git(buildAgentGitDiffArgs(files));
      if (!diff.trim()) {
        const status = await this.git(buildAgentGitStatusArgs(files));
        const channel = vscode.window.createOutputChannel("GSD Git Diff");
        channel.appendLine("# Agent-modified files (unstaged):");
        channel.appendLine(status);
        channel.show();
      } else {
        const channel = vscode.window.createOutputChannel("GSD Git Diff");
        channel.clear();
        channel.appendLine(diff);
        channel.show();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Git diff failed: ${msg}`);
    }
  }
  dispose() {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
  git(args) {
    return new Promise((resolve, reject) => {
      execFile("git", args, { cwd: this.cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr.trim() || err.message));
        } else {
          resolve(stdout);
        }
      });
    });
  }
}
export {
  GsdGitIntegration
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vdnNjb2RlLWV4dGVuc2lvbi9zcmMvZ2l0LWludGVncmF0aW9uLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgKiBhcyB2c2NvZGUgZnJvbSBcInZzY29kZVwiO1xuaW1wb3J0IHsgZXhlY0ZpbGUgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgdHlwZSB7IEdzZENoYW5nZVRyYWNrZXIgfSBmcm9tIFwiLi9jaGFuZ2UtdHJhY2tlci5qc1wiO1xuaW1wb3J0IHsgYnVpbGRBZ2VudEdpdEFkZEFyZ3MsIGJ1aWxkQWdlbnRHaXREaWZmQXJncywgYnVpbGRBZ2VudEdpdFN0YXR1c0FyZ3MgfSBmcm9tIFwiLi9naXQtYXJncy5qc1wiO1xuXG4vKipcbiAqIFByb3ZpZGVzIGdpdCBpbnRlZ3JhdGlvbiBmb3IgYWdlbnQgY2hhbmdlcyBcdTIwMTQgY29tbWl0LCBicmFuY2gsIGFuZCBkaWZmLlxuICovXG5leHBvcnQgY2xhc3MgR3NkR2l0SW50ZWdyYXRpb24gaW1wbGVtZW50cyB2c2NvZGUuRGlzcG9zYWJsZSB7XG5cdHByaXZhdGUgZGlzcG9zYWJsZXM6IHZzY29kZS5EaXNwb3NhYmxlW10gPSBbXTtcblxuXHRjb25zdHJ1Y3Rvcihcblx0XHRwcml2YXRlIHJlYWRvbmx5IHRyYWNrZXI6IEdzZENoYW5nZVRyYWNrZXIsXG5cdFx0cHJpdmF0ZSByZWFkb25seSBjd2Q6IHN0cmluZyxcblx0KSB7fVxuXG5cdC8qKlxuXHQgKiBDb21taXQgYWxsIGZpbGVzIG1vZGlmaWVkIGJ5IHRoZSBhZ2VudCB3aXRoIGEgdXNlci1wcm92aWRlZCBtZXNzYWdlLlxuXHQgKi9cblx0YXN5bmMgY29tbWl0QWdlbnRDaGFuZ2VzKCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGNvbnN0IGZpbGVzID0gdGhpcy50cmFja2VyLm1vZGlmaWVkRmlsZXM7XG5cdFx0aWYgKGZpbGVzLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0dnNjb2RlLndpbmRvdy5zaG93SW5mb3JtYXRpb25NZXNzYWdlKFwiTm8gYWdlbnQgY2hhbmdlcyB0byBjb21taXQuXCIpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGNvbnN0IGRlZmF1bHRNc2cgPSBgZmVhdDogYWdlbnQgY2hhbmdlcyAoJHtmaWxlcy5sZW5ndGh9IGZpbGUke2ZpbGVzLmxlbmd0aCAhPT0gMSA/IFwic1wiIDogXCJcIn0pYDtcblx0XHRjb25zdCBtZXNzYWdlID0gYXdhaXQgdnNjb2RlLndpbmRvdy5zaG93SW5wdXRCb3goe1xuXHRcdFx0cHJvbXB0OiBcIkNvbW1pdCBtZXNzYWdlIGZvciBhZ2VudCBjaGFuZ2VzXCIsXG5cdFx0XHR2YWx1ZTogZGVmYXVsdE1zZyxcblx0XHRcdHBsYWNlSG9sZGVyOiBcImZlYXQ6IGRlc2NyaWJlIHRoZSBjaGFuZ2VzXCIsXG5cdFx0fSk7XG5cdFx0aWYgKCFtZXNzYWdlKSByZXR1cm47XG5cblx0XHRcdHRyeSB7XG5cdFx0XHRcdC8vIFN0YWdlIHRoZSBtb2RpZmllZCBmaWxlc1xuXHRcdFx0XHRhd2FpdCB0aGlzLmdpdChidWlsZEFnZW50R2l0QWRkQXJncyhmaWxlcykpO1xuXHRcdFx0XHQvLyBDb21taXRcblx0XHRcdFx0YXdhaXQgdGhpcy5naXQoW1wiY29tbWl0XCIsIFwiLW1cIiwgbWVzc2FnZV0pO1xuXG5cdFx0XHQvLyBBY2NlcHQgYWxsIGNoYW5nZXMgKGNsZWFyIHRyYWNraW5nIHNpbmNlIHRoZXkncmUgY29tbWl0dGVkKVxuXHRcdFx0dGhpcy50cmFja2VyLmFjY2VwdEFsbCgpO1xuXG5cdFx0XHR2c2NvZGUud2luZG93LnNob3dJbmZvcm1hdGlvbk1lc3NhZ2UoYENvbW1pdHRlZCAke2ZpbGVzLmxlbmd0aH0gZmlsZSR7ZmlsZXMubGVuZ3RoICE9PSAxID8gXCJzXCIgOiBcIlwifS5gKTtcblx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdGNvbnN0IG1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcblx0XHRcdHZzY29kZS53aW5kb3cuc2hvd0Vycm9yTWVzc2FnZShgR2l0IGNvbW1pdCBmYWlsZWQ6ICR7bXNnfWApO1xuXHRcdH1cblx0fVxuXG5cdC8qKlxuXHQgKiBDcmVhdGUgYSBuZXcgYnJhbmNoIGZvciBhZ2VudCB3b3JrIGFuZCBzd2l0Y2ggdG8gaXQuXG5cdCAqL1xuXHRhc3luYyBjcmVhdGVBZ2VudEJyYW5jaCgpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRjb25zdCBicmFuY2hOYW1lID0gYXdhaXQgdnNjb2RlLndpbmRvdy5zaG93SW5wdXRCb3goe1xuXHRcdFx0cHJvbXB0OiBcIkJyYW5jaCBuYW1lIGZvciBhZ2VudCB3b3JrXCIsXG5cdFx0XHRwbGFjZUhvbGRlcjogXCJmZWF0L2FnZW50LWNoYW5nZXNcIixcblx0XHRcdHZhbGlkYXRlSW5wdXQ6ICh2YWx1ZSkgPT4ge1xuXHRcdFx0XHRpZiAoIXZhbHVlLnRyaW0oKSkgcmV0dXJuIFwiQnJhbmNoIG5hbWUgaXMgcmVxdWlyZWRcIjtcblx0XHRcdFx0aWYgKC9cXHMvLnRlc3QodmFsdWUpKSByZXR1cm4gXCJCcmFuY2ggbmFtZSBjYW5ub3QgY29udGFpbiBzcGFjZXNcIjtcblx0XHRcdFx0cmV0dXJuIG51bGw7XG5cdFx0XHR9LFxuXHRcdH0pO1xuXHRcdGlmICghYnJhbmNoTmFtZSkgcmV0dXJuO1xuXG5cdFx0XHR0cnkge1xuXHRcdFx0XHRhd2FpdCB0aGlzLmdpdChbXCJjaGVja291dFwiLCBcIi1iXCIsIGJyYW5jaE5hbWVdKTtcblx0XHRcdHZzY29kZS53aW5kb3cuc2hvd0luZm9ybWF0aW9uTWVzc2FnZShgQ3JlYXRlZCBhbmQgc3dpdGNoZWQgdG8gYnJhbmNoOiAke2JyYW5jaE5hbWV9YCk7XG5cdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHRjb25zdCBtc2cgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG5cdFx0XHR2c2NvZGUud2luZG93LnNob3dFcnJvck1lc3NhZ2UoYEZhaWxlZCB0byBjcmVhdGUgYnJhbmNoOiAke21zZ31gKTtcblx0XHR9XG5cdH1cblxuXHQvKipcblx0ICogU2hvdyBhIGdpdCBkaWZmIG9mIGFsbCBhZ2VudC1tb2RpZmllZCBmaWxlcy5cblx0ICovXG5cdGFzeW5jIHNob3dBZ2VudERpZmYoKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0Y29uc3QgZmlsZXMgPSB0aGlzLnRyYWNrZXIubW9kaWZpZWRGaWxlcztcblx0XHRpZiAoZmlsZXMubGVuZ3RoID09PSAwKSB7XG5cdFx0XHR2c2NvZGUud2luZG93LnNob3dJbmZvcm1hdGlvbk1lc3NhZ2UoXCJObyBhZ2VudCBjaGFuZ2VzIHRvIGRpZmYuXCIpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBkaWZmID0gYXdhaXQgdGhpcy5naXQoYnVpbGRBZ2VudEdpdERpZmZBcmdzKGZpbGVzKSk7XG5cdFx0XHRpZiAoIWRpZmYudHJpbSgpKSB7XG5cdFx0XHRcdC8vIEZpbGVzIG1heSBiZSB1bnRyYWNrZWQgXHUyMDE0IHNob3cgc3RhdHVzIGluc3RlYWRcblx0XHRcdFx0Y29uc3Qgc3RhdHVzID0gYXdhaXQgdGhpcy5naXQoYnVpbGRBZ2VudEdpdFN0YXR1c0FyZ3MoZmlsZXMpKTtcblx0XHRcdFx0Y29uc3QgY2hhbm5lbCA9IHZzY29kZS53aW5kb3cuY3JlYXRlT3V0cHV0Q2hhbm5lbChcIkdTRCBHaXQgRGlmZlwiKTtcblx0XHRcdFx0Y2hhbm5lbC5hcHBlbmRMaW5lKFwiIyBBZ2VudC1tb2RpZmllZCBmaWxlcyAodW5zdGFnZWQpOlwiKTtcblx0XHRcdFx0Y2hhbm5lbC5hcHBlbmRMaW5lKHN0YXR1cyk7XG5cdFx0XHRcdGNoYW5uZWwuc2hvdygpO1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0Y29uc3QgY2hhbm5lbCA9IHZzY29kZS53aW5kb3cuY3JlYXRlT3V0cHV0Q2hhbm5lbChcIkdTRCBHaXQgRGlmZlwiKTtcblx0XHRcdFx0Y2hhbm5lbC5jbGVhcigpO1xuXHRcdFx0XHRjaGFubmVsLmFwcGVuZExpbmUoZGlmZik7XG5cdFx0XHRcdGNoYW5uZWwuc2hvdygpO1xuXHRcdFx0fVxuXHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0Y29uc3QgbXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuXHRcdFx0dnNjb2RlLndpbmRvdy5zaG93RXJyb3JNZXNzYWdlKGBHaXQgZGlmZiBmYWlsZWQ6ICR7bXNnfWApO1xuXHRcdH1cblx0fVxuXG5cdGRpc3Bvc2UoKTogdm9pZCB7XG5cdFx0Zm9yIChjb25zdCBkIG9mIHRoaXMuZGlzcG9zYWJsZXMpIHtcblx0XHRcdGQuZGlzcG9zZSgpO1xuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgZ2l0KGFyZ3M6IHN0cmluZ1tdKTogUHJvbWlzZTxzdHJpbmc+IHtcblx0XHRyZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuXHRcdFx0ZXhlY0ZpbGUoXCJnaXRcIiwgYXJncywgeyBjd2Q6IHRoaXMuY3dkLCBtYXhCdWZmZXI6IDEwICogMTAyNCAqIDEwMjQgfSwgKGVyciwgc3Rkb3V0LCBzdGRlcnIpID0+IHtcblx0XHRcdFx0aWYgKGVycikge1xuXHRcdFx0XHRcdHJlamVjdChuZXcgRXJyb3Ioc3RkZXJyLnRyaW0oKSB8fCBlcnIubWVzc2FnZSkpO1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdHJlc29sdmUoc3Rkb3V0KTtcblx0XHRcdFx0fVxuXHRcdFx0fSk7XG5cdFx0fSk7XG5cdH1cbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFlBQVksWUFBWTtBQUN4QixTQUFTLGdCQUFnQjtBQUV6QixTQUFTLHNCQUFzQix1QkFBdUIsK0JBQStCO0FBSzlFLE1BQU0sa0JBQStDO0FBQUEsRUFHM0QsWUFDa0IsU0FDQSxLQUNoQjtBQUZnQjtBQUNBO0FBQUEsRUFDZjtBQUFBLEVBTEssY0FBbUMsQ0FBQztBQUFBO0FB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
