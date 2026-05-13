import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
class GsdSessionTreeProvider {
  constructor(client) {
    this.client = client;
    this.disposables.push(
      this._onDidChangeTreeData,
      client.onConnectionChange(() => this.refresh())
    );
  }
  static viewId = "gsd-sessions";
  _onDidChangeTreeData = new vscode.EventEmitter();
  onDidChangeTreeData = this._onDidChangeTreeData.event;
  sessions = [];
  currentSessionFile;
  disposables = [];
  async refresh() {
    this.sessions = await this.loadSessions();
    this._onDidChangeTreeData.fire();
  }
  async loadSessions() {
    if (!this.client.isConnected) {
      return [];
    }
    try {
      const state = await this.client.getState();
      this.currentSessionFile = state.sessionFile;
      if (!state.sessionFile) {
        return [];
      }
      const sessionDir = path.dirname(state.sessionFile);
      const files = fs.readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl")).sort().reverse();
      const items = [];
      for (const file of files) {
        const sessionFile = path.join(sessionDir, file);
        const isoMatch = file.match(/^(\d{4}-\d{2}-\d{2}T[\d-]+Z)_(.+)\.jsonl$/);
        const unixMatch = file.match(/^(\d{10,})_(.+)\.jsonl$/);
        let timestamp;
        let sessionId;
        if (isoMatch) {
          const isoStr = isoMatch[1].replace(/(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d+)Z/, "$1:$2:$3.$4Z");
          timestamp = new Date(isoStr);
          sessionId = isoMatch[2];
        } else if (unixMatch) {
          timestamp = new Date(parseInt(unixMatch[1], 10));
          sessionId = unixMatch[2];
        } else {
          continue;
        }
        if (isNaN(timestamp.getTime())) continue;
        items.push({
          label: formatDate(timestamp),
          sessionFile,
          timestamp,
          sessionId,
          isCurrent: sessionFile === state.sessionFile
        });
      }
      return items;
    } catch {
      return [];
    }
  }
  getTreeItem(element) {
    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.description = element.sessionId.slice(0, 8);
    item.tooltip = new vscode.MarkdownString(
      `**${element.label}**

ID: \`${element.sessionId}\`

File: \`${element.sessionFile}\``
    );
    item.iconPath = new vscode.ThemeIcon(
      element.isCurrent ? "comment-discussion" : "history",
      element.isCurrent ? new vscode.ThemeColor("terminal.ansiGreen") : void 0
    );
    if (!element.isCurrent) {
      item.command = {
        command: "gsd.switchSession",
        title: "Switch to Session",
        arguments: [element.sessionFile]
      };
    }
    item.contextValue = element.isCurrent ? "currentSession" : "session";
    return item;
  }
  getChildren() {
    return this.sessions;
  }
  dispose() {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
function formatDate(d) {
  const now = /* @__PURE__ */ new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 864e5);
  if (diffDays === 0) {
    return `Today ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  } else if (diffDays === 1) {
    return `Yesterday ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  } else if (diffDays < 7) {
    return d.toLocaleDateString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}
export {
  GsdSessionTreeProvider
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vdnNjb2RlLWV4dGVuc2lvbi9zcmMvc2Vzc2lvbi10cmVlLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgKiBhcyB2c2NvZGUgZnJvbSBcInZzY29kZVwiO1xuaW1wb3J0ICogYXMgZnMgZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCAqIGFzIHBhdGggZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHR5cGUgeyBHc2RDbGllbnQgfSBmcm9tIFwiLi9nc2QtY2xpZW50LmpzXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2Vzc2lvbkl0ZW0ge1xuXHRsYWJlbDogc3RyaW5nO1xuXHRzZXNzaW9uRmlsZTogc3RyaW5nO1xuXHR0aW1lc3RhbXA6IERhdGU7XG5cdHNlc3Npb25JZDogc3RyaW5nO1xuXHRpc0N1cnJlbnQ6IGJvb2xlYW47XG59XG5cbi8qKlxuICogVHJlZSB2aWV3IHByb3ZpZGVyIHRoYXQgbGlzdHMgR1NEIHNlc3Npb24gZmlsZXMgZnJvbSB0aGUgc2FtZSBkaXJlY3RvcnlcbiAqIGFzIHRoZSBjdXJyZW50bHkgYWN0aXZlIHNlc3Npb24uXG4gKi9cbmV4cG9ydCBjbGFzcyBHc2RTZXNzaW9uVHJlZVByb3ZpZGVyIGltcGxlbWVudHMgdnNjb2RlLlRyZWVEYXRhUHJvdmlkZXI8U2Vzc2lvbkl0ZW0+LCB2c2NvZGUuRGlzcG9zYWJsZSB7XG5cdHB1YmxpYyBzdGF0aWMgcmVhZG9ubHkgdmlld0lkID0gXCJnc2Qtc2Vzc2lvbnNcIjtcblxuXHRwcml2YXRlIHJlYWRvbmx5IF9vbkRpZENoYW5nZVRyZWVEYXRhID0gbmV3IHZzY29kZS5FdmVudEVtaXR0ZXI8dm9pZD4oKTtcblx0cmVhZG9ubHkgb25EaWRDaGFuZ2VUcmVlRGF0YSA9IHRoaXMuX29uRGlkQ2hhbmdlVHJlZURhdGEuZXZlbnQ7XG5cblx0cHJpdmF0ZSBzZXNzaW9uczogU2Vzc2lvbkl0ZW1bXSA9IFtdO1xuXHRwcml2YXRlIGN1cnJlbnRTZXNzaW9uRmlsZTogc3RyaW5nIHwgdW5kZWZpbmVkO1xuXHRwcml2YXRlIGRpc3Bvc2FibGVzOiB2c2NvZGUuRGlzcG9zYWJsZVtdID0gW107XG5cblx0Y29uc3RydWN0b3IocHJpdmF0ZSByZWFkb25seSBjbGllbnQ6IEdzZENsaWVudCkge1xuXHRcdHRoaXMuZGlzcG9zYWJsZXMucHVzaChcblx0XHRcdHRoaXMuX29uRGlkQ2hhbmdlVHJlZURhdGEsXG5cdFx0XHRjbGllbnQub25Db25uZWN0aW9uQ2hhbmdlKCgpID0+IHRoaXMucmVmcmVzaCgpKSxcblx0XHQpO1xuXHR9XG5cblx0YXN5bmMgcmVmcmVzaCgpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHR0aGlzLnNlc3Npb25zID0gYXdhaXQgdGhpcy5sb2FkU2Vzc2lvbnMoKTtcblx0XHR0aGlzLl9vbkRpZENoYW5nZVRyZWVEYXRhLmZpcmUoKTtcblx0fVxuXG5cdHByaXZhdGUgYXN5bmMgbG9hZFNlc3Npb25zKCk6IFByb21pc2U8U2Vzc2lvbkl0ZW1bXT4ge1xuXHRcdGlmICghdGhpcy5jbGllbnQuaXNDb25uZWN0ZWQpIHtcblx0XHRcdHJldHVybiBbXTtcblx0XHR9XG5cdFx0dHJ5IHtcblx0XHRcdGNvbnN0IHN0YXRlID0gYXdhaXQgdGhpcy5jbGllbnQuZ2V0U3RhdGUoKTtcblx0XHRcdHRoaXMuY3VycmVudFNlc3Npb25GaWxlID0gc3RhdGUuc2Vzc2lvbkZpbGU7XG5cdFx0XHRpZiAoIXN0YXRlLnNlc3Npb25GaWxlKSB7XG5cdFx0XHRcdHJldHVybiBbXTtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3Qgc2Vzc2lvbkRpciA9IHBhdGguZGlybmFtZShzdGF0ZS5zZXNzaW9uRmlsZSk7XG5cdFx0XHRjb25zdCBmaWxlcyA9IGZzLnJlYWRkaXJTeW5jKHNlc3Npb25EaXIpXG5cdFx0XHRcdC5maWx0ZXIoKGYpID0+IGYuZW5kc1dpdGgoXCIuanNvbmxcIikpXG5cdFx0XHRcdC5zb3J0KClcblx0XHRcdFx0LnJldmVyc2UoKTsgLy8gbmV3ZXN0IGZpcnN0XG5cblx0XHRcdGNvbnN0IGl0ZW1zOiBTZXNzaW9uSXRlbVtdID0gW107XG5cdFx0XHRmb3IgKGNvbnN0IGZpbGUgb2YgZmlsZXMpIHtcblx0XHRcdFx0Y29uc3Qgc2Vzc2lvbkZpbGUgPSBwYXRoLmpvaW4oc2Vzc2lvbkRpciwgZmlsZSk7XG5cblx0XHRcdFx0Ly8gVHJ5IHR3byBmaWxlbmFtZSBmb3JtYXRzOlxuXHRcdFx0XHQvLyAxLiBJU08gdGltZXN0YW1wOiAyMDI2LTAzLTIzVDE3LTQ5LTA1LTc4NFpfPHNlc3Npb25JZD4uanNvbmxcblx0XHRcdFx0Ly8gMi4gVW5peCB0aW1lc3RhbXA6IDx1bml4VGltZXN0YW1wTXM+XzxzZXNzaW9uSWQ+Lmpzb25sXG5cdFx0XHRcdGNvbnN0IGlzb01hdGNoID0gZmlsZS5tYXRjaCgvXihcXGR7NH0tXFxkezJ9LVxcZHsyfVRbXFxkLV0rWilfKC4rKVxcLmpzb25sJC8pO1xuXHRcdFx0XHRjb25zdCB1bml4TWF0Y2ggPSBmaWxlLm1hdGNoKC9eKFxcZHsxMCx9KV8oLispXFwuanNvbmwkLyk7XG5cblx0XHRcdFx0bGV0IHRpbWVzdGFtcDogRGF0ZTtcblx0XHRcdFx0bGV0IHNlc3Npb25JZDogc3RyaW5nO1xuXG5cdFx0XHRcdGlmIChpc29NYXRjaCkge1xuXHRcdFx0XHRcdC8vIENvbnZlcnQgSVNPLWxpa2UgZm9ybWF0IChkYXNoZXMgaW5zdGVhZCBvZiBjb2xvbnMpIGJhY2sgdG8gcGFyc2VhYmxlIElTT1xuXHRcdFx0XHRcdGNvbnN0IGlzb1N0ciA9IGlzb01hdGNoWzFdLnJlcGxhY2UoLyhcXGR7NH0tXFxkezJ9LVxcZHsyfVRcXGR7Mn0pLShcXGR7Mn0pLShcXGR7Mn0pLShcXGQrKVovLCBcIiQxOiQyOiQzLiQ0WlwiKTtcblx0XHRcdFx0XHR0aW1lc3RhbXAgPSBuZXcgRGF0ZShpc29TdHIpO1xuXHRcdFx0XHRcdHNlc3Npb25JZCA9IGlzb01hdGNoWzJdO1xuXHRcdFx0XHR9IGVsc2UgaWYgKHVuaXhNYXRjaCkge1xuXHRcdFx0XHRcdHRpbWVzdGFtcCA9IG5ldyBEYXRlKHBhcnNlSW50KHVuaXhNYXRjaFsxXSwgMTApKTtcblx0XHRcdFx0XHRzZXNzaW9uSWQgPSB1bml4TWF0Y2hbMl07XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0Y29udGludWU7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRpZiAoaXNOYU4odGltZXN0YW1wLmdldFRpbWUoKSkpIGNvbnRpbnVlO1xuXG5cdFx0XHRcdGl0ZW1zLnB1c2goe1xuXHRcdFx0XHRcdGxhYmVsOiBmb3JtYXREYXRlKHRpbWVzdGFtcCksXG5cdFx0XHRcdFx0c2Vzc2lvbkZpbGUsXG5cdFx0XHRcdFx0dGltZXN0YW1wLFxuXHRcdFx0XHRcdHNlc3Npb25JZCxcblx0XHRcdFx0XHRpc0N1cnJlbnQ6IHNlc3Npb25GaWxlID09PSBzdGF0ZS5zZXNzaW9uRmlsZSxcblx0XHRcdFx0fSk7XG5cdFx0XHR9XG5cdFx0XHRyZXR1cm4gaXRlbXM7XG5cdFx0fSBjYXRjaCB7XG5cdFx0XHRyZXR1cm4gW107XG5cdFx0fVxuXHR9XG5cblx0Z2V0VHJlZUl0ZW0oZWxlbWVudDogU2Vzc2lvbkl0ZW0pOiB2c2NvZGUuVHJlZUl0ZW0ge1xuXHRcdGNvbnN0IGl0ZW0gPSBuZXcgdnNjb2RlLlRyZWVJdGVtKGVsZW1lbnQubGFiZWwsIHZzY29kZS5UcmVlSXRlbUNvbGxhcHNpYmxlU3RhdGUuTm9uZSk7XG5cdFx0aXRlbS5kZXNjcmlwdGlvbiA9IGVsZW1lbnQuc2Vzc2lvbklkLnNsaWNlKDAsIDgpO1xuXHRcdGl0ZW0udG9vbHRpcCA9IG5ldyB2c2NvZGUuTWFya2Rvd25TdHJpbmcoXG5cdFx0XHRgKioke2VsZW1lbnQubGFiZWx9KipcXG5cXG5JRDogXFxgJHtlbGVtZW50LnNlc3Npb25JZH1cXGBcXG5cXG5GaWxlOiBcXGAke2VsZW1lbnQuc2Vzc2lvbkZpbGV9XFxgYCxcblx0XHQpO1xuXHRcdGl0ZW0uaWNvblBhdGggPSBuZXcgdnNjb2RlLlRoZW1lSWNvbihcblx0XHRcdGVsZW1lbnQuaXNDdXJyZW50ID8gXCJjb21tZW50LWRpc2N1c3Npb25cIiA6IFwiaGlzdG9yeVwiLFxuXHRcdFx0ZWxlbWVudC5pc0N1cnJlbnQgPyBuZXcgdnNjb2RlLlRoZW1lQ29sb3IoXCJ0ZXJtaW5hbC5hbnNpR3JlZW5cIikgOiB1bmRlZmluZWQsXG5cdFx0KTtcblx0XHRpZiAoIWVsZW1lbnQuaXNDdXJyZW50KSB7XG5cdFx0XHRpdGVtLmNvbW1hbmQgPSB7XG5cdFx0XHRcdGNvbW1hbmQ6IFwiZ3NkLnN3aXRjaFNlc3Npb25cIixcblx0XHRcdFx0dGl0bGU6IFwiU3dpdGNoIHRvIFNlc3Npb25cIixcblx0XHRcdFx0YXJndW1lbnRzOiBbZWxlbWVudC5zZXNzaW9uRmlsZV0sXG5cdFx0XHR9O1xuXHRcdH1cblx0XHRpdGVtLmNvbnRleHRWYWx1ZSA9IGVsZW1lbnQuaXNDdXJyZW50ID8gXCJjdXJyZW50U2Vzc2lvblwiIDogXCJzZXNzaW9uXCI7XG5cdFx0cmV0dXJuIGl0ZW07XG5cdH1cblxuXHRnZXRDaGlsZHJlbigpOiBTZXNzaW9uSXRlbVtdIHtcblx0XHRyZXR1cm4gdGhpcy5zZXNzaW9ucztcblx0fVxuXG5cdGRpc3Bvc2UoKTogdm9pZCB7XG5cdFx0Zm9yIChjb25zdCBkIG9mIHRoaXMuZGlzcG9zYWJsZXMpIHtcblx0XHRcdGQuZGlzcG9zZSgpO1xuXHRcdH1cblx0fVxufVxuXG5mdW5jdGlvbiBmb3JtYXREYXRlKGQ6IERhdGUpOiBzdHJpbmcge1xuXHRjb25zdCBub3cgPSBuZXcgRGF0ZSgpO1xuXHRjb25zdCBkaWZmTXMgPSBub3cuZ2V0VGltZSgpIC0gZC5nZXRUaW1lKCk7XG5cdGNvbnN0IGRpZmZEYXlzID0gTWF0aC5mbG9vcihkaWZmTXMgLyA4Nl80MDBfMDAwKTtcblxuXHRpZiAoZGlmZkRheXMgPT09IDApIHtcblx0XHRyZXR1cm4gYFRvZGF5ICR7ZC50b0xvY2FsZVRpbWVTdHJpbmcoW10sIHsgaG91cjogXCIyLWRpZ2l0XCIsIG1pbnV0ZTogXCIyLWRpZ2l0XCIgfSl9YDtcblx0fSBlbHNlIGlmIChkaWZmRGF5cyA9PT0gMSkge1xuXHRcdHJldHVybiBgWWVzdGVyZGF5ICR7ZC50b0xvY2FsZVRpbWVTdHJpbmcoW10sIHsgaG91cjogXCIyLWRpZ2l0XCIsIG1pbnV0ZTogXCIyLWRpZ2l0XCIgfSl9YDtcblx0fSBlbHNlIGlmIChkaWZmRGF5cyA8IDcpIHtcblx0XHRyZXR1cm4gZC50b0xvY2FsZURhdGVTdHJpbmcoW10sIHsgd2Vla2RheTogXCJzaG9ydFwiLCBob3VyOiBcIjItZGlnaXRcIiwgbWludXRlOiBcIjItZGlnaXRcIiB9KTtcblx0fVxuXHRyZXR1cm4gZC50b0xvY2FsZURhdGVTdHJpbmcoW10sIHsgbW9udGg6IFwic2hvcnRcIiwgZGF5OiBcIm51bWVyaWNcIiwgeWVhcjogXCJudW1lcmljXCIgfSk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxZQUFZLFlBQVk7QUFDeEIsWUFBWSxRQUFRO0FBQ3BCLFlBQVksVUFBVTtBQWVmLE1BQU0sdUJBQTBGO0FBQUEsRUFVdEcsWUFBNkIsUUFBbUI7QUFBbkI7QUFDNUIsU0FBSyxZQUFZO0FBQUEsTUFDaEIsS0FBSztBQUFBLE1BQ0wsT0FBTyxtQkFBbUIsTUFBTSxLQUFLLFFBQVEsQ0FBQztBQUFBLElBQy9DO0FBQUEsRUFDRDtBQUFBLEVBZEEsT0FBdUIsU0FBUztBQUFBLEVBRWYsdUJBQXVCLElBQUksT0FBTyxhQUFtQjtBQUFBLEVBQzdELHNCQUFzQixLQUFLLHFCQUFxQjtBQUFBLEVBRWpELFdBQTBCLENBQUM7QUFBQSxFQUMzQjtBQUFBLEVBQ0EsY0FBbUMsQ0FBQztBQUFBLEVBUzVDLE1BQU0sVUFBeUI7QUFDOUIsU0FBSyxXQUFXLE1BQU0sS0FBSyxhQUFhO0FBQ3hDLFNBQUsscUJBQXFCLEtBQUs7QUFBQSxFQUNoQztBQUFBLEVBRUEsTUFBYyxlQUF1QztBQUNwRCxRQUFJLENBQUMsS0FBSyxPQUFPLGFBQWE7QUFDN0IsYUFBTyxDQUFDO0FBQUEsSUFDVDtBQUNBLFFBQUk7QUFDSCxZQUFNLFFBQVEsTUFBTSxLQUFLLE9BQU8sU0FBUztBQUN6QyxXQUFLLHFCQUFxQixNQUFNO0FBQ2hDLFVBQUksQ0FBQyxNQUFNLGFBQWE7QUFDdkIsZUFBTyxDQUFDO0FBQUEsTUFDVDtBQUVBLFlBQU0sYUFBYSxLQUFLLFFBQVEsTUFBTSxXQUFXO0FBQ2pELFlBQU0sUUFBUSxHQUFHLFlBQVksVUFBVSxFQUNyQyxPQUFPLENBQUMsTUFBTSxFQUFFLFNBQVMsUUFBUSxDQUFDLEVBQ2xDLEtBQUssRUFDTCxRQUFRO0FBRVYsWUFBTSxRQUF1QixDQUFDO0FBQzlCLGlCQUFXLFFBQVEsT0FBTztBQUN6QixjQUFNLGNBQWMsS0FBSyxLQUFLLFlBQVksSUFBSTtBQUs5QyxjQUFNLFdBQVcsS0FBSyxNQUFNLDJDQUEyQztBQUN2RSxjQUFNLFlBQVksS0FBSyxNQUFNLHlCQUF5QjtBQUV0RCxZQUFJO0FBQ0osWUFBSTtBQUVKLFlBQUksVUFBVTtBQUViLGdCQUFNLFNBQVMsU0FBUyxDQUFDLEVBQUUsUUFBUSxvREFBb0QsY0FBYztBQUNyRyxzQkFBWSxJQUFJLEtBQUssTUFBTTtBQUMzQixzQkFBWSxTQUFTLENBQUM7QUFBQSxRQUN2QixXQUFXLFdBQVc7QUFDckIsc0JBQVksSUFBSSxLQUFLLFNBQVMsVUFBVSxDQUFDLEdBQUcsRUFBRSxDQUFDO0FBQy9DLHNCQUFZLFVBQVUsQ0FBQztBQUFBLFFBQ3hCLE9BQU87QUFDTjtBQUFBLFFBQ0Q7QUFFQSxZQUFJLE1BQU0sVUFBVSxRQUFRLENBQUMsRUFBRztBQUVoQyxjQUFNLEtBQUs7QUFBQSxVQUNWLE9BQU8sV0FBVyxTQUFTO0FBQUEsVUFDM0I7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0EsV0FBVyxnQkFBZ0IsTUFBTTtBQUFBLFFBQ2xDLENBQUM7QUFBQSxNQUNGO0FBQ0EsYUFBTztBQUFBLElBQ1IsUUFBUTtBQUNQLGFBQU8sQ0FBQztBQUFBLElBQ1Q7QUFBQSxFQUNEO0FBQUEsRUFFQSxZQUFZLFNBQXVDO0FBQ2xELFVBQU0sT0FBTyxJQUFJLE9BQU8sU0FBUyxRQUFRLE9BQU8sT0FBTyx5QkFBeUIsSUFBSTtBQUNwRixTQUFLLGNBQWMsUUFBUSxVQUFVLE1BQU0sR0FBRyxDQUFDO0FBQy9DLFNBQUssVUFBVSxJQUFJLE9BQU87QUFBQSxNQUN6QixLQUFLLFFBQVEsS0FBSztBQUFBO0FBQUEsUUFBZSxRQUFRLFNBQVM7QUFBQTtBQUFBLFVBQWlCLFFBQVEsV0FBVztBQUFBLElBQ3ZGO0FBQ0EsU0FBSyxXQUFXLElBQUksT0FBTztBQUFBLE1BQzFCLFFBQVEsWUFBWSx1QkFBdUI7QUFBQSxNQUMzQyxRQUFRLFlBQVksSUFBSSxPQUFPLFdBQVcsb0JBQW9CLElBQUk7QUFBQSxJQUNuRTtBQUNBLFFBQUksQ0FBQyxRQUFRLFdBQVc7QUFDdkIsV0FBSyxVQUFVO0FBQUEsUUFDZCxTQUFTO0FBQUEsUUFDVCxPQUFPO0FBQUEsUUFDUCxXQUFXLENBQUMsUUFBUSxXQUFXO0FBQUEsTUFDaEM7QUFBQSxJQUNEO0FBQ0EsU0FBSyxlQUFlLFFBQVEsWUFBWSxtQkFBbUI7QUFDM0QsV0FBTztBQUFBLEVBQ1I7QUFBQSxFQUVBLGNBQTZCO0FBQzVCLFdBQU8sS0FBSztBQUFBLEVBQ2I7QUFBQSxFQUVBLFVBQWdCO0FBQ2YsZUFBVyxLQUFLLEtBQUssYUFBYTtBQUNqQyxRQUFFLFFBQVE7QUFBQSxJQUNYO0FBQUEsRUFDRDtBQUNEO0FBRUEsU0FBUyxXQUFXLEdBQWlCO0FBQ3BDLFFBQU0sTUFBTSxvQkFBSSxLQUFLO0FBQ3JCLFFBQU0sU0FBUyxJQUFJLFFBQVEsSUFBSSxFQUFFLFFBQVE7QUFDekMsUUFBTSxXQUFXLEtBQUssTUFBTSxTQUFTLEtBQVU7QUFFL0MsTUFBSSxhQUFhLEdBQUc7QUFDbkIsV0FBTyxTQUFTLEVBQUUsbUJBQW1CLENBQUMsR0FBRyxFQUFFLE1BQU0sV0FBVyxRQUFRLFVBQVUsQ0FBQyxDQUFDO0FBQUEsRUFDakYsV0FBVyxhQUFhLEdBQUc7QUFDMUIsV0FBTyxhQUFhLEVBQUUsbUJBQW1CLENBQUMsR0FBRyxFQUFFLE1BQU0sV0FBVyxRQUFRLFVBQVUsQ0FBQyxDQUFDO0FBQUEsRUFDckYsV0FBVyxXQUFXLEdBQUc7QUFDeEIsV0FBTyxFQUFFLG1CQUFtQixDQUFDLEdBQUcsRUFBRSxTQUFTLFNBQVMsTUFBTSxXQUFXLFFBQVEsVUFBVSxDQUFDO0FBQUEsRUFDekY7QUFDQSxTQUFPLEVBQUUsbUJBQW1CLENBQUMsR0FBRyxFQUFFLE9BQU8sU0FBUyxLQUFLLFdBQVcsTUFBTSxVQUFVLENBQUM7QUFDcEY7IiwKICAibmFtZXMiOiBbXQp9Cg==
