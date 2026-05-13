import * as vscode from "vscode";
class GsdDiagnosticBridge {
  constructor(client) {
    this.client = client;
    this.collection = vscode.languages.createDiagnosticCollection("gsd");
    this.disposables.push(this.collection);
  }
  collection;
  disposables = [];
  /**
   * Read all diagnostics for the active file and send them to the agent
   * as a "fix these problems" prompt.
   */
  async fixProblemsInFile() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage("No active file to fix.");
      return;
    }
    const uri = editor.document.uri;
    const diagnostics = vscode.languages.getDiagnostics(uri);
    if (diagnostics.length === 0) {
      vscode.window.showInformationMessage("No problems found in this file.");
      return;
    }
    const fileName = vscode.workspace.asRelativePath(uri);
    const problemText = formatDiagnostics(fileName, diagnostics);
    const prompt = [
      `Fix the following problems in \`${fileName}\`:`,
      "",
      problemText,
      "",
      "Fix all of these issues. Show me the changes."
    ].join("\n");
    await this.client.sendPrompt(prompt);
  }
  /**
   * Read all diagnostics across the workspace (errors only) and send
   * them to the agent as a "fix all errors" prompt.
   */
  async fixAllProblems() {
    const allDiagnostics = vscode.languages.getDiagnostics();
    const errorFiles = [];
    for (const [uri, diagnostics] of allDiagnostics) {
      const significant = diagnostics.filter(
        (d) => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning
      );
      if (significant.length > 0) {
        errorFiles.push({
          fileName: vscode.workspace.asRelativePath(uri),
          diagnostics: significant
        });
      }
    }
    if (errorFiles.length === 0) {
      vscode.window.showInformationMessage("No errors or warnings found in the workspace.");
      return;
    }
    const capped = errorFiles.slice(0, 20);
    const totalProblems = capped.reduce((sum, f) => sum + f.diagnostics.length, 0);
    const sections = capped.map((f) => formatDiagnostics(f.fileName, f.diagnostics));
    const prompt = [
      `Fix the following ${totalProblems} problems across ${capped.length} file${capped.length > 1 ? "s" : ""}:`,
      "",
      ...sections,
      "",
      "Fix all of these issues."
    ].join("\n");
    await this.client.sendPrompt(prompt);
  }
  /**
   * Add a GSD diagnostic (agent finding) to a file.
   * Can be used to surface agent review findings in the Problems panel.
   */
  addFinding(uri, range, message, severity = vscode.DiagnosticSeverity.Warning) {
    const existing = this.collection.get(uri) ?? [];
    const diagnostic = new vscode.Diagnostic(range, message, severity);
    diagnostic.source = "GSD Agent";
    this.collection.set(uri, [...existing, diagnostic]);
  }
  /** Clear all GSD diagnostics */
  clearFindings() {
    this.collection.clear();
  }
  dispose() {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
function formatDiagnostics(fileName, diagnostics) {
  const lines = [`**${fileName}**`];
  for (const d of diagnostics) {
    const severity = severityLabel(d.severity);
    const line = d.range.start.line + 1;
    const col = d.range.start.character + 1;
    const source = d.source ? ` [${d.source}]` : "";
    lines.push(`  - ${severity} (line ${line}:${col}): ${d.message}${source}`);
  }
  return lines.join("\n");
}
function severityLabel(severity) {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return "Error";
    case vscode.DiagnosticSeverity.Warning:
      return "Warning";
    case vscode.DiagnosticSeverity.Information:
      return "Info";
    case vscode.DiagnosticSeverity.Hint:
      return "Hint";
    default:
      return "Unknown";
  }
}
export {
  GsdDiagnosticBridge
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vdnNjb2RlLWV4dGVuc2lvbi9zcmMvZGlhZ25vc3RpY3MudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCAqIGFzIHZzY29kZSBmcm9tIFwidnNjb2RlXCI7XG5pbXBvcnQgdHlwZSB7IEdzZENsaWVudCB9IGZyb20gXCIuL2dzZC1jbGllbnQuanNcIjtcblxuLyoqXG4gKiBJbnRlZ3JhdGVzIHdpdGggVlMgQ29kZSdzIGRpYWdub3N0aWMgc3lzdGVtOlxuICogLSBSZWFkcyBkaWFnbm9zdGljcyAoZXJyb3JzL3dhcm5pbmdzKSBmcm9tIHRoZSBQcm9ibGVtcyBwYW5lbCBhbmQgc2VuZHMgdGhlbSB0byB0aGUgYWdlbnRcbiAqIC0gUHJvdmlkZXMgYSBEaWFnbm9zdGljQ29sbGVjdGlvbiBmb3IgdGhlIGFnZW50IHRvIHN1cmZhY2UgaXRzIG93biBmaW5kaW5nc1xuICovXG5leHBvcnQgY2xhc3MgR3NkRGlhZ25vc3RpY0JyaWRnZSBpbXBsZW1lbnRzIHZzY29kZS5EaXNwb3NhYmxlIHtcblx0cHJpdmF0ZSByZWFkb25seSBjb2xsZWN0aW9uOiB2c2NvZGUuRGlhZ25vc3RpY0NvbGxlY3Rpb247XG5cdHByaXZhdGUgZGlzcG9zYWJsZXM6IHZzY29kZS5EaXNwb3NhYmxlW10gPSBbXTtcblxuXHRjb25zdHJ1Y3Rvcihwcml2YXRlIHJlYWRvbmx5IGNsaWVudDogR3NkQ2xpZW50KSB7XG5cdFx0dGhpcy5jb2xsZWN0aW9uID0gdnNjb2RlLmxhbmd1YWdlcy5jcmVhdGVEaWFnbm9zdGljQ29sbGVjdGlvbihcImdzZFwiKTtcblx0XHR0aGlzLmRpc3Bvc2FibGVzLnB1c2godGhpcy5jb2xsZWN0aW9uKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBSZWFkIGFsbCBkaWFnbm9zdGljcyBmb3IgdGhlIGFjdGl2ZSBmaWxlIGFuZCBzZW5kIHRoZW0gdG8gdGhlIGFnZW50XG5cdCAqIGFzIGEgXCJmaXggdGhlc2UgcHJvYmxlbXNcIiBwcm9tcHQuXG5cdCAqL1xuXHRhc3luYyBmaXhQcm9ibGVtc0luRmlsZSgpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRjb25zdCBlZGl0b3IgPSB2c2NvZGUud2luZG93LmFjdGl2ZVRleHRFZGl0b3I7XG5cdFx0aWYgKCFlZGl0b3IpIHtcblx0XHRcdHZzY29kZS53aW5kb3cuc2hvd1dhcm5pbmdNZXNzYWdlKFwiTm8gYWN0aXZlIGZpbGUgdG8gZml4LlwiKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRjb25zdCB1cmkgPSBlZGl0b3IuZG9jdW1lbnQudXJpO1xuXHRcdGNvbnN0IGRpYWdub3N0aWNzID0gdnNjb2RlLmxhbmd1YWdlcy5nZXREaWFnbm9zdGljcyh1cmkpO1xuXG5cdFx0aWYgKGRpYWdub3N0aWNzLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0dnNjb2RlLndpbmRvdy5zaG93SW5mb3JtYXRpb25NZXNzYWdlKFwiTm8gcHJvYmxlbXMgZm91bmQgaW4gdGhpcyBmaWxlLlwiKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRjb25zdCBmaWxlTmFtZSA9IHZzY29kZS53b3Jrc3BhY2UuYXNSZWxhdGl2ZVBhdGgodXJpKTtcblx0XHRjb25zdCBwcm9ibGVtVGV4dCA9IGZvcm1hdERpYWdub3N0aWNzKGZpbGVOYW1lLCBkaWFnbm9zdGljcyk7XG5cblx0XHRjb25zdCBwcm9tcHQgPSBbXG5cdFx0XHRgRml4IHRoZSBmb2xsb3dpbmcgcHJvYmxlbXMgaW4gXFxgJHtmaWxlTmFtZX1cXGA6YCxcblx0XHRcdFwiXCIsXG5cdFx0XHRwcm9ibGVtVGV4dCxcblx0XHRcdFwiXCIsXG5cdFx0XHRcIkZpeCBhbGwgb2YgdGhlc2UgaXNzdWVzLiBTaG93IG1lIHRoZSBjaGFuZ2VzLlwiLFxuXHRcdF0uam9pbihcIlxcblwiKTtcblxuXHRcdGF3YWl0IHRoaXMuY2xpZW50LnNlbmRQcm9tcHQocHJvbXB0KTtcblx0fVxuXG5cdC8qKlxuXHQgKiBSZWFkIGFsbCBkaWFnbm9zdGljcyBhY3Jvc3MgdGhlIHdvcmtzcGFjZSAoZXJyb3JzIG9ubHkpIGFuZCBzZW5kXG5cdCAqIHRoZW0gdG8gdGhlIGFnZW50IGFzIGEgXCJmaXggYWxsIGVycm9yc1wiIHByb21wdC5cblx0ICovXG5cdGFzeW5jIGZpeEFsbFByb2JsZW1zKCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGNvbnN0IGFsbERpYWdub3N0aWNzID0gdnNjb2RlLmxhbmd1YWdlcy5nZXREaWFnbm9zdGljcygpO1xuXHRcdGNvbnN0IGVycm9yRmlsZXM6IHsgZmlsZU5hbWU6IHN0cmluZzsgZGlhZ25vc3RpY3M6IHZzY29kZS5EaWFnbm9zdGljW10gfVtdID0gW107XG5cblx0XHRmb3IgKGNvbnN0IFt1cmksIGRpYWdub3N0aWNzXSBvZiBhbGxEaWFnbm9zdGljcykge1xuXHRcdFx0Ly8gT25seSBpbmNsdWRlIGVycm9ycyBhbmQgd2FybmluZ3MsIHNraXAgaGludHMvaW5mb1xuXHRcdFx0Y29uc3Qgc2lnbmlmaWNhbnQgPSBkaWFnbm9zdGljcy5maWx0ZXIoXG5cdFx0XHRcdChkKSA9PiBkLnNldmVyaXR5ID09PSB2c2NvZGUuRGlhZ25vc3RpY1NldmVyaXR5LkVycm9yIHx8IGQuc2V2ZXJpdHkgPT09IHZzY29kZS5EaWFnbm9zdGljU2V2ZXJpdHkuV2FybmluZyxcblx0XHRcdCk7XG5cdFx0XHRpZiAoc2lnbmlmaWNhbnQubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRlcnJvckZpbGVzLnB1c2goe1xuXHRcdFx0XHRcdGZpbGVOYW1lOiB2c2NvZGUud29ya3NwYWNlLmFzUmVsYXRpdmVQYXRoKHVyaSksXG5cdFx0XHRcdFx0ZGlhZ25vc3RpY3M6IHNpZ25pZmljYW50LFxuXHRcdFx0XHR9KTtcblx0XHRcdH1cblx0XHR9XG5cblx0XHRpZiAoZXJyb3JGaWxlcy5sZW5ndGggPT09IDApIHtcblx0XHRcdHZzY29kZS53aW5kb3cuc2hvd0luZm9ybWF0aW9uTWVzc2FnZShcIk5vIGVycm9ycyBvciB3YXJuaW5ncyBmb3VuZCBpbiB0aGUgd29ya3NwYWNlLlwiKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHQvLyBDYXAgYXQgMjAgZmlsZXMgdG8gYXZvaWQgb3ZlcndoZWxtaW5nIHRoZSBhZ2VudFxuXHRcdGNvbnN0IGNhcHBlZCA9IGVycm9yRmlsZXMuc2xpY2UoMCwgMjApO1xuXHRcdGNvbnN0IHRvdGFsUHJvYmxlbXMgPSBjYXBwZWQucmVkdWNlKChzdW0sIGYpID0+IHN1bSArIGYuZGlhZ25vc3RpY3MubGVuZ3RoLCAwKTtcblxuXHRcdGNvbnN0IHNlY3Rpb25zID0gY2FwcGVkLm1hcCgoZikgPT4gZm9ybWF0RGlhZ25vc3RpY3MoZi5maWxlTmFtZSwgZi5kaWFnbm9zdGljcykpO1xuXG5cdFx0Y29uc3QgcHJvbXB0ID0gW1xuXHRcdFx0YEZpeCB0aGUgZm9sbG93aW5nICR7dG90YWxQcm9ibGVtc30gcHJvYmxlbXMgYWNyb3NzICR7Y2FwcGVkLmxlbmd0aH0gZmlsZSR7Y2FwcGVkLmxlbmd0aCA+IDEgPyBcInNcIiA6IFwiXCJ9OmAsXG5cdFx0XHRcIlwiLFxuXHRcdFx0Li4uc2VjdGlvbnMsXG5cdFx0XHRcIlwiLFxuXHRcdFx0XCJGaXggYWxsIG9mIHRoZXNlIGlzc3Vlcy5cIixcblx0XHRdLmpvaW4oXCJcXG5cIik7XG5cblx0XHRhd2FpdCB0aGlzLmNsaWVudC5zZW5kUHJvbXB0KHByb21wdCk7XG5cdH1cblxuXHQvKipcblx0ICogQWRkIGEgR1NEIGRpYWdub3N0aWMgKGFnZW50IGZpbmRpbmcpIHRvIGEgZmlsZS5cblx0ICogQ2FuIGJlIHVzZWQgdG8gc3VyZmFjZSBhZ2VudCByZXZpZXcgZmluZGluZ3MgaW4gdGhlIFByb2JsZW1zIHBhbmVsLlxuXHQgKi9cblx0YWRkRmluZGluZyhcblx0XHR1cmk6IHZzY29kZS5VcmksXG5cdFx0cmFuZ2U6IHZzY29kZS5SYW5nZSxcblx0XHRtZXNzYWdlOiBzdHJpbmcsXG5cdFx0c2V2ZXJpdHk6IHZzY29kZS5EaWFnbm9zdGljU2V2ZXJpdHkgPSB2c2NvZGUuRGlhZ25vc3RpY1NldmVyaXR5Lldhcm5pbmcsXG5cdCk6IHZvaWQge1xuXHRcdGNvbnN0IGV4aXN0aW5nID0gdGhpcy5jb2xsZWN0aW9uLmdldCh1cmkpID8/IFtdO1xuXHRcdGNvbnN0IGRpYWdub3N0aWMgPSBuZXcgdnNjb2RlLkRpYWdub3N0aWMocmFuZ2UsIG1lc3NhZ2UsIHNldmVyaXR5KTtcblx0XHRkaWFnbm9zdGljLnNvdXJjZSA9IFwiR1NEIEFnZW50XCI7XG5cdFx0dGhpcy5jb2xsZWN0aW9uLnNldCh1cmksIFsuLi5leGlzdGluZywgZGlhZ25vc3RpY10pO1xuXHR9XG5cblx0LyoqIENsZWFyIGFsbCBHU0QgZGlhZ25vc3RpY3MgKi9cblx0Y2xlYXJGaW5kaW5ncygpOiB2b2lkIHtcblx0XHR0aGlzLmNvbGxlY3Rpb24uY2xlYXIoKTtcblx0fVxuXG5cdGRpc3Bvc2UoKTogdm9pZCB7XG5cdFx0Zm9yIChjb25zdCBkIG9mIHRoaXMuZGlzcG9zYWJsZXMpIHtcblx0XHRcdGQuZGlzcG9zZSgpO1xuXHRcdH1cblx0fVxufVxuXG5mdW5jdGlvbiBmb3JtYXREaWFnbm9zdGljcyhmaWxlTmFtZTogc3RyaW5nLCBkaWFnbm9zdGljczogdnNjb2RlLkRpYWdub3N0aWNbXSk6IHN0cmluZyB7XG5cdGNvbnN0IGxpbmVzID0gW2AqKiR7ZmlsZU5hbWV9KipgXTtcblx0Zm9yIChjb25zdCBkIG9mIGRpYWdub3N0aWNzKSB7XG5cdFx0Y29uc3Qgc2V2ZXJpdHkgPSBzZXZlcml0eUxhYmVsKGQuc2V2ZXJpdHkpO1xuXHRcdGNvbnN0IGxpbmUgPSBkLnJhbmdlLnN0YXJ0LmxpbmUgKyAxO1xuXHRcdGNvbnN0IGNvbCA9IGQucmFuZ2Uuc3RhcnQuY2hhcmFjdGVyICsgMTtcblx0XHRjb25zdCBzb3VyY2UgPSBkLnNvdXJjZSA/IGAgWyR7ZC5zb3VyY2V9XWAgOiBcIlwiO1xuXHRcdGxpbmVzLnB1c2goYCAgLSAke3NldmVyaXR5fSAobGluZSAke2xpbmV9OiR7Y29sfSk6ICR7ZC5tZXNzYWdlfSR7c291cmNlfWApO1xuXHR9XG5cdHJldHVybiBsaW5lcy5qb2luKFwiXFxuXCIpO1xufVxuXG5mdW5jdGlvbiBzZXZlcml0eUxhYmVsKHNldmVyaXR5OiB2c2NvZGUuRGlhZ25vc3RpY1NldmVyaXR5KTogc3RyaW5nIHtcblx0c3dpdGNoIChzZXZlcml0eSkge1xuXHRcdGNhc2UgdnNjb2RlLkRpYWdub3N0aWNTZXZlcml0eS5FcnJvcjogcmV0dXJuIFwiRXJyb3JcIjtcblx0XHRjYXNlIHZzY29kZS5EaWFnbm9zdGljU2V2ZXJpdHkuV2FybmluZzogcmV0dXJuIFwiV2FybmluZ1wiO1xuXHRcdGNhc2UgdnNjb2RlLkRpYWdub3N0aWNTZXZlcml0eS5JbmZvcm1hdGlvbjogcmV0dXJuIFwiSW5mb1wiO1xuXHRcdGNhc2UgdnNjb2RlLkRpYWdub3N0aWNTZXZlcml0eS5IaW50OiByZXR1cm4gXCJIaW50XCI7XG5cdFx0ZGVmYXVsdDogcmV0dXJuIFwiVW5rbm93blwiO1xuXHR9XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxZQUFZLFlBQVk7QUFRakIsTUFBTSxvQkFBaUQ7QUFBQSxFQUk3RCxZQUE2QixRQUFtQjtBQUFuQjtBQUM1QixTQUFLLGFBQWEsT0FBTyxVQUFVLDJCQUEyQixLQUFLO0FBQ25FLFNBQUssWUFBWSxLQUFLLEtBQUssVUFBVTtBQUFBLEVBQ3RDO0FBQUEsRUFOaUI7QUFBQSxFQUNULGNBQW1DLENBQUM7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLEVBVzVDLE1BQU0sb0JBQW1DO0FBQ3hDLFVBQU0sU0FBUyxPQUFPLE9BQU87QUFDN0IsUUFBSSxDQUFDLFFBQVE7QUFDWixhQUFPLE9BQU8sbUJBQW1CLHdCQUF3QjtBQUN6RDtBQUFBLElBQ0Q7QUFFQSxVQUFNLE1BQU0sT0FBTyxTQUFTO0FBQzVCLFVBQU0sY0FBYyxPQUFPLFVBQVUsZUFBZSxHQUFHO0FBRXZELFFBQUksWUFBWSxXQUFXLEdBQUc7QUFDN0IsYUFBTyxPQUFPLHVCQUF1QixpQ0FBaUM7QUFDdEU7QUFBQSxJQUNEO0FBRUEsVUFBTSxXQUFXLE9BQU8sVUFBVSxlQUFlLEdBQUc7QUFDcEQsVUFBTSxjQUFjLGtCQUFrQixVQUFVLFdBQVc7QUFFM0QsVUFBTSxTQUFTO0FBQUEsTUFDZCxtQ0FBbUMsUUFBUTtBQUFBLE1BQzNDO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRCxFQUFFLEtBQUssSUFBSTtBQUVYLFVBQU0sS0FBSyxPQUFPLFdBQVcsTUFBTTtBQUFBLEVBQ3BDO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxFQU1BLE1BQU0saUJBQWdDO0FBQ3JDLFVBQU0saUJBQWlCLE9BQU8sVUFBVSxlQUFlO0FBQ3ZELFVBQU0sYUFBdUUsQ0FBQztBQUU5RSxlQUFXLENBQUMsS0FBSyxXQUFXLEtBQUssZ0JBQWdCO0FBRWhELFlBQU0sY0FBYyxZQUFZO0FBQUEsUUFDL0IsQ0FBQyxNQUFNLEVBQUUsYUFBYSxPQUFPLG1CQUFtQixTQUFTLEVBQUUsYUFBYSxPQUFPLG1CQUFtQjtBQUFBLE1BQ25HO0FBQ0EsVUFBSSxZQUFZLFNBQVMsR0FBRztBQUMzQixtQkFBVyxLQUFLO0FBQUEsVUFDZixVQUFVLE9BQU8sVUFBVSxlQUFlLEdBQUc7QUFBQSxVQUM3QyxhQUFhO0FBQUEsUUFDZCxDQUFDO0FBQUEsTUFDRjtBQUFBLElBQ0Q7QUFFQSxRQUFJLFdBQVcsV0FBVyxHQUFHO0FBQzVCLGFBQU8sT0FBTyx1QkFBdUIsK0NBQStDO0FBQ3BGO0FBQUEsSUFDRDtBQUdBLFVBQU0sU0FBUyxXQUFXLE1BQU0sR0FBRyxFQUFFO0FBQ3JDLFVBQU0sZ0JBQWdCLE9BQU8sT0FBTyxDQUFDLEtBQUssTUFBTSxNQUFNLEVBQUUsWUFBWSxRQUFRLENBQUM7QUFFN0UsVUFBTSxXQUFXLE9BQU8sSUFBSSxDQUFDLE1BQU0sa0JBQWtCLEVBQUUsVUFBVSxFQUFFLFdBQVcsQ0FBQztBQUUvRSxVQUFNLFNBQVM7QUFBQSxNQUNkLHFCQUFxQixhQUFhLG9CQUFvQixPQUFPLE1BQU0sUUFBUSxPQUFPLFNBQVMsSUFBSSxNQUFNLEVBQUU7QUFBQSxNQUN2RztBQUFBLE1BQ0EsR0FBRztBQUFBLE1BQ0g7QUFBQSxNQUNBO0FBQUEsSUFDRCxFQUFFLEtBQUssSUFBSTtBQUVYLFVBQU0sS0FBSyxPQUFPLFdBQVcsTUFBTTtBQUFBLEVBQ3BDO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxFQU1BLFdBQ0MsS0FDQSxPQUNBLFNBQ0EsV0FBc0MsT0FBTyxtQkFBbUIsU0FDekQ7QUFDUCxVQUFNLFdBQVcsS0FBSyxXQUFXLElBQUksR0FBRyxLQUFLLENBQUM7QUFDOUMsVUFBTSxhQUFhLElBQUksT0FBTyxXQUFXLE9BQU8sU0FBUyxRQUFRO0FBQ2pFLGVBQVcsU0FBUztBQUNwQixTQUFLLFdBQVcsSUFBSSxLQUFLLENBQUMsR0FBRyxVQUFVLFVBQVUsQ0FBQztBQUFBLEVBQ25EO0FBQUE7QUFBQSxFQUdBLGdCQUFzQjtBQUNyQixTQUFLLFdBQVcsTUFBTTtBQUFBLEVBQ3ZCO0FBQUEsRUFFQSxVQUFnQjtBQUNmLGVBQVcsS0FBSyxLQUFLLGFBQWE7QUFDakMsUUFBRSxRQUFRO0FBQUEsSUFDWDtBQUFBLEVBQ0Q7QUFDRDtBQUVBLFNBQVMsa0JBQWtCLFVBQWtCLGFBQTBDO0FBQ3RGLFFBQU0sUUFBUSxDQUFDLEtBQUssUUFBUSxJQUFJO0FBQ2hDLGFBQVcsS0FBSyxhQUFhO0FBQzVCLFVBQU0sV0FBVyxjQUFjLEVBQUUsUUFBUTtBQUN6QyxVQUFNLE9BQU8sRUFBRSxNQUFNLE1BQU0sT0FBTztBQUNsQyxVQUFNLE1BQU0sRUFBRSxNQUFNLE1BQU0sWUFBWTtBQUN0QyxVQUFNLFNBQVMsRUFBRSxTQUFTLEtBQUssRUFBRSxNQUFNLE1BQU07QUFDN0MsVUFBTSxLQUFLLE9BQU8sUUFBUSxVQUFVLElBQUksSUFBSSxHQUFHLE1BQU0sRUFBRSxPQUFPLEdBQUcsTUFBTSxFQUFFO0FBQUEsRUFDMUU7QUFDQSxTQUFPLE1BQU0sS0FBSyxJQUFJO0FBQ3ZCO0FBRUEsU0FBUyxjQUFjLFVBQTZDO0FBQ25FLFVBQVEsVUFBVTtBQUFBLElBQ2pCLEtBQUssT0FBTyxtQkFBbUI7QUFBTyxhQUFPO0FBQUEsSUFDN0MsS0FBSyxPQUFPLG1CQUFtQjtBQUFTLGFBQU87QUFBQSxJQUMvQyxLQUFLLE9BQU8sbUJBQW1CO0FBQWEsYUFBTztBQUFBLElBQ25ELEtBQUssT0FBTyxtQkFBbUI7QUFBTSxhQUFPO0FBQUEsSUFDNUM7QUFBUyxhQUFPO0FBQUEsRUFDakI7QUFDRDsiLAogICJuYW1lcyI6IFtdCn0K
