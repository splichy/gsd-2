import * as vscode from "vscode";
class GsdFileDecorationProvider {
  constructor(client) {
    this.client = client;
    this.disposables.push(
      this._onDidChangeFileDecorations,
      client.onEvent((evt) => this.handleEvent(evt)),
      client.onConnectionChange((connected) => {
        if (!connected) {
          this.clear();
        }
      })
    );
  }
  _onDidChangeFileDecorations = new vscode.EventEmitter();
  onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;
  modifiedUris = /* @__PURE__ */ new Set();
  disposables = [];
  handleEvent(evt) {
    if (evt.type !== "tool_execution_start") {
      return;
    }
    const toolName = evt.toolName;
    if (toolName !== "Write" && toolName !== "Edit") {
      return;
    }
    const toolInput = evt.toolInput;
    const fp = toolInput?.file_path ? String(toolInput.file_path) : void 0;
    if (!fp) {
      return;
    }
    const uri = resolveUri(fp);
    if (uri) {
      this.modifiedUris.add(uri.toString());
      this._onDidChangeFileDecorations.fire(uri);
    }
  }
  provideFileDecoration(uri) {
    if (this.modifiedUris.has(uri.toString())) {
      return {
        badge: "G",
        tooltip: "Modified by GSD",
        color: new vscode.ThemeColor("gitDecoration.modifiedResourceForeground")
      };
    }
    return void 0;
  }
  clear() {
    this.modifiedUris.clear();
    this._onDidChangeFileDecorations.fire(void 0);
  }
  dispose() {
    this.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
function resolveUri(fp) {
  try {
    if (fp.startsWith("/") || /^[A-Za-z]:[\\/]/.test(fp)) {
      return vscode.Uri.file(fp);
    }
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
      return null;
    }
    return vscode.Uri.joinPath(folders[0].uri, fp);
  } catch {
    return null;
  }
}
export {
  GsdFileDecorationProvider
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vdnNjb2RlLWV4dGVuc2lvbi9zcmMvZmlsZS1kZWNvcmF0aW9ucy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0ICogYXMgdnNjb2RlIGZyb20gXCJ2c2NvZGVcIjtcbmltcG9ydCB0eXBlIHsgQWdlbnRFdmVudCwgR3NkQ2xpZW50IH0gZnJvbSBcIi4vZ3NkLWNsaWVudC5qc1wiO1xuXG4vKipcbiAqIEJhZGdlcyBmaWxlcyBpbiB0aGUgVlMgQ29kZSBleHBsb3JlciB0aGF0IEdTRCBoYXMgd3JpdHRlbiBvciBlZGl0ZWRcbiAqIGR1cmluZyB0aGUgY3VycmVudCBzZXNzaW9uLlxuICovXG5leHBvcnQgY2xhc3MgR3NkRmlsZURlY29yYXRpb25Qcm92aWRlciBpbXBsZW1lbnRzIHZzY29kZS5GaWxlRGVjb3JhdGlvblByb3ZpZGVyLCB2c2NvZGUuRGlzcG9zYWJsZSB7XG5cdHByaXZhdGUgcmVhZG9ubHkgX29uRGlkQ2hhbmdlRmlsZURlY29yYXRpb25zID0gbmV3IHZzY29kZS5FdmVudEVtaXR0ZXI8dnNjb2RlLlVyaSB8IHZzY29kZS5VcmlbXSB8IHVuZGVmaW5lZD4oKTtcblx0cmVhZG9ubHkgb25EaWRDaGFuZ2VGaWxlRGVjb3JhdGlvbnMgPSB0aGlzLl9vbkRpZENoYW5nZUZpbGVEZWNvcmF0aW9ucy5ldmVudDtcblxuXHRwcml2YXRlIG1vZGlmaWVkVXJpcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXHRwcml2YXRlIGRpc3Bvc2FibGVzOiB2c2NvZGUuRGlzcG9zYWJsZVtdID0gW107XG5cblx0Y29uc3RydWN0b3IocHJpdmF0ZSByZWFkb25seSBjbGllbnQ6IEdzZENsaWVudCkge1xuXHRcdHRoaXMuZGlzcG9zYWJsZXMucHVzaChcblx0XHRcdHRoaXMuX29uRGlkQ2hhbmdlRmlsZURlY29yYXRpb25zLFxuXHRcdFx0Y2xpZW50Lm9uRXZlbnQoKGV2dDogQWdlbnRFdmVudCkgPT4gdGhpcy5oYW5kbGVFdmVudChldnQpKSxcblx0XHRcdGNsaWVudC5vbkNvbm5lY3Rpb25DaGFuZ2UoKGNvbm5lY3RlZCkgPT4ge1xuXHRcdFx0XHRpZiAoIWNvbm5lY3RlZCkge1xuXHRcdFx0XHRcdHRoaXMuY2xlYXIoKTtcblx0XHRcdFx0fVxuXHRcdFx0fSksXG5cdFx0KTtcblx0fVxuXG5cdHByaXZhdGUgaGFuZGxlRXZlbnQoZXZ0OiBBZ2VudEV2ZW50KTogdm9pZCB7XG5cdFx0aWYgKGV2dC50eXBlICE9PSBcInRvb2xfZXhlY3V0aW9uX3N0YXJ0XCIpIHtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cdFx0Y29uc3QgdG9vbE5hbWUgPSBldnQudG9vbE5hbWUgYXMgc3RyaW5nIHwgdW5kZWZpbmVkO1xuXHRcdGlmICh0b29sTmFtZSAhPT0gXCJXcml0ZVwiICYmIHRvb2xOYW1lICE9PSBcIkVkaXRcIikge1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblx0XHRjb25zdCB0b29sSW5wdXQgPSBldnQudG9vbElucHV0IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkO1xuXHRcdGNvbnN0IGZwID0gdG9vbElucHV0Py5maWxlX3BhdGggPyBTdHJpbmcodG9vbElucHV0LmZpbGVfcGF0aCkgOiB1bmRlZmluZWQ7XG5cdFx0aWYgKCFmcCkge1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblx0XHRjb25zdCB1cmkgPSByZXNvbHZlVXJpKGZwKTtcblx0XHRpZiAodXJpKSB7XG5cdFx0XHR0aGlzLm1vZGlmaWVkVXJpcy5hZGQodXJpLnRvU3RyaW5nKCkpO1xuXHRcdFx0dGhpcy5fb25EaWRDaGFuZ2VGaWxlRGVjb3JhdGlvbnMuZmlyZSh1cmkpO1xuXHRcdH1cblx0fVxuXG5cdHByb3ZpZGVGaWxlRGVjb3JhdGlvbih1cmk6IHZzY29kZS5VcmkpOiB2c2NvZGUuRmlsZURlY29yYXRpb24gfCB1bmRlZmluZWQge1xuXHRcdGlmICh0aGlzLm1vZGlmaWVkVXJpcy5oYXModXJpLnRvU3RyaW5nKCkpKSB7XG5cdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRiYWRnZTogXCJHXCIsXG5cdFx0XHRcdHRvb2x0aXA6IFwiTW9kaWZpZWQgYnkgR1NEXCIsXG5cdFx0XHRcdGNvbG9yOiBuZXcgdnNjb2RlLlRoZW1lQ29sb3IoXCJnaXREZWNvcmF0aW9uLm1vZGlmaWVkUmVzb3VyY2VGb3JlZ3JvdW5kXCIpLFxuXHRcdFx0fTtcblx0XHR9XG5cdFx0cmV0dXJuIHVuZGVmaW5lZDtcblx0fVxuXG5cdGNsZWFyKCk6IHZvaWQge1xuXHRcdHRoaXMubW9kaWZpZWRVcmlzLmNsZWFyKCk7XG5cdFx0dGhpcy5fb25EaWRDaGFuZ2VGaWxlRGVjb3JhdGlvbnMuZmlyZSh1bmRlZmluZWQpO1xuXHR9XG5cblx0ZGlzcG9zZSgpOiB2b2lkIHtcblx0XHR0aGlzLmNsZWFyKCk7XG5cdFx0Zm9yIChjb25zdCBkIG9mIHRoaXMuZGlzcG9zYWJsZXMpIHtcblx0XHRcdGQuZGlzcG9zZSgpO1xuXHRcdH1cblx0fVxufVxuXG5mdW5jdGlvbiByZXNvbHZlVXJpKGZwOiBzdHJpbmcpOiB2c2NvZGUuVXJpIHwgbnVsbCB7XG5cdHRyeSB7XG5cdFx0aWYgKGZwLnN0YXJ0c1dpdGgoXCIvXCIpIHx8IC9eW0EtWmEtel06W1xcXFwvXS8udGVzdChmcCkpIHtcblx0XHRcdHJldHVybiB2c2NvZGUuVXJpLmZpbGUoZnApO1xuXHRcdH1cblx0XHRjb25zdCBmb2xkZXJzID0gdnNjb2RlLndvcmtzcGFjZS53b3Jrc3BhY2VGb2xkZXJzO1xuXHRcdGlmICghZm9sZGVycz8ubGVuZ3RoKSB7XG5cdFx0XHRyZXR1cm4gbnVsbDtcblx0XHR9XG5cdFx0cmV0dXJuIHZzY29kZS5Vcmkuam9pblBhdGgoZm9sZGVyc1swXS51cmksIGZwKTtcblx0fSBjYXRjaCB7XG5cdFx0cmV0dXJuIG51bGw7XG5cdH1cbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFlBQVksWUFBWTtBQU9qQixNQUFNLDBCQUFzRjtBQUFBLEVBT2xHLFlBQTZCLFFBQW1CO0FBQW5CO0FBQzVCLFNBQUssWUFBWTtBQUFBLE1BQ2hCLEtBQUs7QUFBQSxNQUNMLE9BQU8sUUFBUSxDQUFDLFFBQW9CLEtBQUssWUFBWSxHQUFHLENBQUM7QUFBQSxNQUN6RCxPQUFPLG1CQUFtQixDQUFDLGNBQWM7QUFDeEMsWUFBSSxDQUFDLFdBQVc7QUFDZixlQUFLLE1BQU07QUFBQSxRQUNaO0FBQUEsTUFDRCxDQUFDO0FBQUEsSUFDRjtBQUFBLEVBQ0Q7QUFBQSxFQWhCaUIsOEJBQThCLElBQUksT0FBTyxhQUFvRDtBQUFBLEVBQ3JHLDZCQUE2QixLQUFLLDRCQUE0QjtBQUFBLEVBRS9ELGVBQWUsb0JBQUksSUFBWTtBQUFBLEVBQy9CLGNBQW1DLENBQUM7QUFBQSxFQWNwQyxZQUFZLEtBQXVCO0FBQzFDLFFBQUksSUFBSSxTQUFTLHdCQUF3QjtBQUN4QztBQUFBLElBQ0Q7QUFDQSxVQUFNLFdBQVcsSUFBSTtBQUNyQixRQUFJLGFBQWEsV0FBVyxhQUFhLFFBQVE7QUFDaEQ7QUFBQSxJQUNEO0FBQ0EsVUFBTSxZQUFZLElBQUk7QUFDdEIsVUFBTSxLQUFLLFdBQVcsWUFBWSxPQUFPLFVBQVUsU0FBUyxJQUFJO0FBQ2hFLFFBQUksQ0FBQyxJQUFJO0FBQ1I7QUFBQSxJQUNEO0FBQ0EsVUFBTSxNQUFNLFdBQVcsRUFBRTtBQUN6QixRQUFJLEtBQUs7QUFDUixXQUFLLGFBQWEsSUFBSSxJQUFJLFNBQVMsQ0FBQztBQUNwQyxXQUFLLDRCQUE0QixLQUFLLEdBQUc7QUFBQSxJQUMxQztBQUFBLEVBQ0Q7QUFBQSxFQUVBLHNCQUFzQixLQUFvRDtBQUN6RSxRQUFJLEtBQUssYUFBYSxJQUFJLElBQUksU0FBUyxDQUFDLEdBQUc7QUFDMUMsYUFBTztBQUFBLFFBQ04sT0FBTztBQUFBLFFBQ1AsU0FBUztBQUFBLFFBQ1QsT0FBTyxJQUFJLE9BQU8sV0FBVywwQ0FBMEM7QUFBQSxNQUN4RTtBQUFBLElBQ0Q7QUFDQSxXQUFPO0FBQUEsRUFDUjtBQUFBLEVBRUEsUUFBYztBQUNiLFNBQUssYUFBYSxNQUFNO0FBQ3hCLFNBQUssNEJBQTRCLEtBQUssTUFBUztBQUFBLEVBQ2hEO0FBQUEsRUFFQSxVQUFnQjtBQUNmLFNBQUssTUFBTTtBQUNYLGVBQVcsS0FBSyxLQUFLLGFBQWE7QUFDakMsUUFBRSxRQUFRO0FBQUEsSUFDWDtBQUFBLEVBQ0Q7QUFDRDtBQUVBLFNBQVMsV0FBVyxJQUErQjtBQUNsRCxNQUFJO0FBQ0gsUUFBSSxHQUFHLFdBQVcsR0FBRyxLQUFLLGtCQUFrQixLQUFLLEVBQUUsR0FBRztBQUNyRCxhQUFPLE9BQU8sSUFBSSxLQUFLLEVBQUU7QUFBQSxJQUMxQjtBQUNBLFVBQU0sVUFBVSxPQUFPLFVBQVU7QUFDakMsUUFBSSxDQUFDLFNBQVMsUUFBUTtBQUNyQixhQUFPO0FBQUEsSUFDUjtBQUNBLFdBQU8sT0FBTyxJQUFJLFNBQVMsUUFBUSxDQUFDLEVBQUUsS0FBSyxFQUFFO0FBQUEsRUFDOUMsUUFBUTtBQUNQLFdBQU87QUFBQSxFQUNSO0FBQ0Q7IiwKICAibmFtZXMiOiBbXQp9Cg==
