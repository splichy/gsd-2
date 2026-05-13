import * as vscode from "vscode";
const TOOL_ICONS = {
  Read: "file",
  Write: "new-file",
  Edit: "edit",
  Bash: "terminal",
  Grep: "search",
  Glob: "file-directory",
  Agent: "organization"
};
function toolSummary(toolName, toolInput) {
  const name = toolName ?? "Unknown";
  switch (name) {
    case "Read": {
      const p = String(toolInput?.file_path ?? toolInput?.path ?? "");
      const short = p.split(/[\\/]/).pop() ?? p;
      return { label: `Read ${short}`, filePath: p || void 0 };
    }
    case "Write": {
      const p = String(toolInput?.file_path ?? "");
      const short = p.split(/[\\/]/).pop() ?? p;
      return { label: `Write ${short}`, filePath: p || void 0 };
    }
    case "Edit": {
      const p = String(toolInput?.file_path ?? "");
      const short = p.split(/[\\/]/).pop() ?? p;
      return { label: `Edit ${short}`, filePath: p || void 0 };
    }
    case "Bash": {
      const cmd = String(toolInput?.command ?? "").slice(0, 60);
      return { label: `Bash: ${cmd}` };
    }
    case "Grep": {
      const pat = String(toolInput?.pattern ?? "").slice(0, 40);
      return { label: `Grep: ${pat}` };
    }
    case "Glob": {
      const pat = String(toolInput?.pattern ?? "").slice(0, 40);
      return { label: `Glob: ${pat}` };
    }
    default:
      return { label: name };
  }
}
class GsdActivityFeedProvider {
  constructor(client) {
    this.client = client;
    this.maxItems = vscode.workspace.getConfiguration("gsd").get("activityFeedMaxItems", 100);
    this.disposables.push(
      this._onDidChangeTreeData,
      client.onEvent((evt) => this.handleEvent(evt)),
      client.onConnectionChange((connected) => {
        if (!connected) {
          this.runningTools.clear();
        }
        this._onDidChangeTreeData.fire();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("gsd.activityFeedMaxItems")) {
          this.maxItems = vscode.workspace.getConfiguration("gsd").get("activityFeedMaxItems", 100);
        }
      })
    );
  }
  static viewId = "gsd-activity";
  _onDidChangeTreeData = new vscode.EventEmitter();
  onDidChangeTreeData = this._onDidChangeTreeData.event;
  items = [];
  nextId = 0;
  runningTools = /* @__PURE__ */ new Map();
  // toolUseId -> item id
  maxItems;
  disposables = [];
  getTreeItem(element) {
    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.iconPath = element.icon;
    item.description = element.duration !== void 0 ? `${element.duration}ms` : element.status === "running" ? "running..." : "";
    item.tooltip = `${element.detail}
${new Date(element.timestamp).toLocaleTimeString()}`;
    if (element.filePath) {
      item.command = {
        command: "vscode.open",
        title: "Open File",
        arguments: [vscode.Uri.file(element.filePath)]
      };
    }
    return item;
  }
  getChildren() {
    return [...this.items].reverse();
  }
  clear() {
    this.items = [];
    this.runningTools.clear();
    this._onDidChangeTreeData.fire();
  }
  dispose() {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
  handleEvent(evt) {
    switch (evt.type) {
      case "agent_start": {
        this.addItem({
          type: "agent",
          label: "Agent started",
          detail: "Agent began processing",
          icon: new vscode.ThemeIcon("play", new vscode.ThemeColor("testing.iconPassed")),
          status: "running"
        });
        break;
      }
      case "agent_end": {
        this.addItem({
          type: "agent",
          label: "Agent finished",
          detail: "Agent completed processing",
          icon: new vscode.ThemeIcon("check", new vscode.ThemeColor("testing.iconPassed")),
          status: "success"
        });
        break;
      }
      case "tool_execution_start": {
        const toolName = String(evt.toolName ?? "");
        const toolInput = evt.toolInput ?? {};
        const toolUseId = String(evt.toolUseId ?? "");
        const { label, filePath } = toolSummary(toolName, toolInput);
        const iconName = TOOL_ICONS[toolName] ?? "tools";
        const id = this.addItem({
          type: "tool",
          label,
          detail: `Tool: ${toolName}`,
          icon: new vscode.ThemeIcon(iconName, new vscode.ThemeColor("charts.yellow")),
          status: "running",
          filePath
        });
        if (toolUseId) {
          this.runningTools.set(toolUseId, id);
        }
        break;
      }
      case "tool_execution_end": {
        const toolUseId = String(evt.toolUseId ?? "");
        const itemId = this.runningTools.get(toolUseId);
        if (itemId !== void 0) {
          this.runningTools.delete(toolUseId);
          const item = this.items.find((i) => i.id === itemId);
          if (item) {
            const isError = evt.error === true || evt.isError === true;
            item.status = isError ? "error" : "success";
            item.duration = Date.now() - item.timestamp;
            item.icon = new vscode.ThemeIcon(
              isError ? "error" : "check",
              new vscode.ThemeColor(isError ? "testing.iconFailed" : "testing.iconPassed")
            );
            this._onDidChangeTreeData.fire();
          }
        }
        break;
      }
    }
  }
  addItem(partial) {
    const id = this.nextId++;
    this.items.push({ ...partial, id, timestamp: Date.now() });
    while (this.items.length > this.maxItems) {
      this.items.shift();
    }
    this._onDidChangeTreeData.fire();
    return id;
  }
}
export {
  GsdActivityFeedProvider
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vdnNjb2RlLWV4dGVuc2lvbi9zcmMvYWN0aXZpdHktZmVlZC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0ICogYXMgdnNjb2RlIGZyb20gXCJ2c2NvZGVcIjtcbmltcG9ydCB0eXBlIHsgR3NkQ2xpZW50LCBBZ2VudEV2ZW50IH0gZnJvbSBcIi4vZ3NkLWNsaWVudC5qc1wiO1xuXG5pbnRlcmZhY2UgQWN0aXZpdHlJdGVtIHtcblx0aWQ6IG51bWJlcjtcblx0dHlwZTogXCJ0b29sXCIgfCBcImFnZW50XCI7XG5cdGxhYmVsOiBzdHJpbmc7XG5cdGRldGFpbDogc3RyaW5nO1xuXHRpY29uOiB2c2NvZGUuVGhlbWVJY29uO1xuXHR0aW1lc3RhbXA6IG51bWJlcjtcblx0ZHVyYXRpb24/OiBudW1iZXI7XG5cdGZpbGVQYXRoPzogc3RyaW5nO1xuXHRzdGF0dXM6IFwicnVubmluZ1wiIHwgXCJzdWNjZXNzXCIgfCBcImVycm9yXCI7XG59XG5cbmNvbnN0IFRPT0xfSUNPTlM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG5cdFJlYWQ6IFwiZmlsZVwiLFxuXHRXcml0ZTogXCJuZXctZmlsZVwiLFxuXHRFZGl0OiBcImVkaXRcIixcblx0QmFzaDogXCJ0ZXJtaW5hbFwiLFxuXHRHcmVwOiBcInNlYXJjaFwiLFxuXHRHbG9iOiBcImZpbGUtZGlyZWN0b3J5XCIsXG5cdEFnZW50OiBcIm9yZ2FuaXphdGlvblwiLFxufTtcblxuZnVuY3Rpb24gdG9vbFN1bW1hcnkodG9vbE5hbWU6IHN0cmluZywgdG9vbElucHV0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IHsgbGFiZWw6IHN0cmluZzsgZmlsZVBhdGg/OiBzdHJpbmcgfSB7XG5cdGNvbnN0IG5hbWUgPSB0b29sTmFtZSA/PyBcIlVua25vd25cIjtcblx0c3dpdGNoIChuYW1lKSB7XG5cdFx0Y2FzZSBcIlJlYWRcIjoge1xuXHRcdFx0Y29uc3QgcCA9IFN0cmluZyh0b29sSW5wdXQ/LmZpbGVfcGF0aCA/PyB0b29sSW5wdXQ/LnBhdGggPz8gXCJcIik7XG5cdFx0XHRjb25zdCBzaG9ydCA9IHAuc3BsaXQoL1tcXFxcL10vKS5wb3AoKSA/PyBwO1xuXHRcdFx0cmV0dXJuIHsgbGFiZWw6IGBSZWFkICR7c2hvcnR9YCwgZmlsZVBhdGg6IHAgfHwgdW5kZWZpbmVkIH07XG5cdFx0fVxuXHRcdGNhc2UgXCJXcml0ZVwiOiB7XG5cdFx0XHRjb25zdCBwID0gU3RyaW5nKHRvb2xJbnB1dD8uZmlsZV9wYXRoID8/IFwiXCIpO1xuXHRcdFx0Y29uc3Qgc2hvcnQgPSBwLnNwbGl0KC9bXFxcXC9dLykucG9wKCkgPz8gcDtcblx0XHRcdHJldHVybiB7IGxhYmVsOiBgV3JpdGUgJHtzaG9ydH1gLCBmaWxlUGF0aDogcCB8fCB1bmRlZmluZWQgfTtcblx0XHR9XG5cdFx0Y2FzZSBcIkVkaXRcIjoge1xuXHRcdFx0Y29uc3QgcCA9IFN0cmluZyh0b29sSW5wdXQ/LmZpbGVfcGF0aCA/PyBcIlwiKTtcblx0XHRcdGNvbnN0IHNob3J0ID0gcC5zcGxpdCgvW1xcXFwvXS8pLnBvcCgpID8/IHA7XG5cdFx0XHRyZXR1cm4geyBsYWJlbDogYEVkaXQgJHtzaG9ydH1gLCBmaWxlUGF0aDogcCB8fCB1bmRlZmluZWQgfTtcblx0XHR9XG5cdFx0Y2FzZSBcIkJhc2hcIjoge1xuXHRcdFx0Y29uc3QgY21kID0gU3RyaW5nKHRvb2xJbnB1dD8uY29tbWFuZCA/PyBcIlwiKS5zbGljZSgwLCA2MCk7XG5cdFx0XHRyZXR1cm4geyBsYWJlbDogYEJhc2g6ICR7Y21kfWAgfTtcblx0XHR9XG5cdFx0Y2FzZSBcIkdyZXBcIjoge1xuXHRcdFx0Y29uc3QgcGF0ID0gU3RyaW5nKHRvb2xJbnB1dD8ucGF0dGVybiA/PyBcIlwiKS5zbGljZSgwLCA0MCk7XG5cdFx0XHRyZXR1cm4geyBsYWJlbDogYEdyZXA6ICR7cGF0fWAgfTtcblx0XHR9XG5cdFx0Y2FzZSBcIkdsb2JcIjoge1xuXHRcdFx0Y29uc3QgcGF0ID0gU3RyaW5nKHRvb2xJbnB1dD8ucGF0dGVybiA/PyBcIlwiKS5zbGljZSgwLCA0MCk7XG5cdFx0XHRyZXR1cm4geyBsYWJlbDogYEdsb2I6ICR7cGF0fWAgfTtcblx0XHR9XG5cdFx0ZGVmYXVsdDpcblx0XHRcdHJldHVybiB7IGxhYmVsOiBuYW1lIH07XG5cdH1cbn1cblxuLyoqXG4gKiBUcmVlRGF0YVByb3ZpZGVyIHRoYXQgc2hvd3MgcmVhbC10aW1lIHRvb2wgZXhlY3V0aW9ucyBmcm9tIHRoZSBHU0QgYWdlbnQuXG4gKiBMaXN0ZW5zIHRvIHRvb2xfZXhlY3V0aW9uX3N0YXJ0L2VuZCBhbmQgYWdlbnRfc3RhcnQvZW5kIGV2ZW50cy5cbiAqL1xuZXhwb3J0IGNsYXNzIEdzZEFjdGl2aXR5RmVlZFByb3ZpZGVyIGltcGxlbWVudHMgdnNjb2RlLlRyZWVEYXRhUHJvdmlkZXI8QWN0aXZpdHlJdGVtPiwgdnNjb2RlLkRpc3Bvc2FibGUge1xuXHRwdWJsaWMgc3RhdGljIHJlYWRvbmx5IHZpZXdJZCA9IFwiZ3NkLWFjdGl2aXR5XCI7XG5cblx0cHJpdmF0ZSByZWFkb25seSBfb25EaWRDaGFuZ2VUcmVlRGF0YSA9IG5ldyB2c2NvZGUuRXZlbnRFbWl0dGVyPHZvaWQ+KCk7XG5cdHJlYWRvbmx5IG9uRGlkQ2hhbmdlVHJlZURhdGEgPSB0aGlzLl9vbkRpZENoYW5nZVRyZWVEYXRhLmV2ZW50O1xuXG5cdHByaXZhdGUgaXRlbXM6IEFjdGl2aXR5SXRlbVtdID0gW107XG5cdHByaXZhdGUgbmV4dElkID0gMDtcblx0cHJpdmF0ZSBydW5uaW5nVG9vbHMgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpOyAvLyB0b29sVXNlSWQgLT4gaXRlbSBpZFxuXHRwcml2YXRlIG1heEl0ZW1zOiBudW1iZXI7XG5cdHByaXZhdGUgZGlzcG9zYWJsZXM6IHZzY29kZS5EaXNwb3NhYmxlW10gPSBbXTtcblxuXHRjb25zdHJ1Y3Rvcihwcml2YXRlIHJlYWRvbmx5IGNsaWVudDogR3NkQ2xpZW50KSB7XG5cdFx0dGhpcy5tYXhJdGVtcyA9IHZzY29kZS53b3Jrc3BhY2UuZ2V0Q29uZmlndXJhdGlvbihcImdzZFwiKS5nZXQ8bnVtYmVyPihcImFjdGl2aXR5RmVlZE1heEl0ZW1zXCIsIDEwMCk7XG5cblx0XHR0aGlzLmRpc3Bvc2FibGVzLnB1c2goXG5cdFx0XHR0aGlzLl9vbkRpZENoYW5nZVRyZWVEYXRhLFxuXHRcdFx0Y2xpZW50Lm9uRXZlbnQoKGV2dCkgPT4gdGhpcy5oYW5kbGVFdmVudChldnQpKSxcblx0XHRcdGNsaWVudC5vbkNvbm5lY3Rpb25DaGFuZ2UoKGNvbm5lY3RlZCkgPT4ge1xuXHRcdFx0XHRpZiAoIWNvbm5lY3RlZCkge1xuXHRcdFx0XHRcdHRoaXMucnVubmluZ1Rvb2xzLmNsZWFyKCk7XG5cdFx0XHRcdH1cblx0XHRcdFx0dGhpcy5fb25EaWRDaGFuZ2VUcmVlRGF0YS5maXJlKCk7XG5cdFx0XHR9KSxcblx0XHRcdHZzY29kZS53b3Jrc3BhY2Uub25EaWRDaGFuZ2VDb25maWd1cmF0aW9uKChlKSA9PiB7XG5cdFx0XHRcdGlmIChlLmFmZmVjdHNDb25maWd1cmF0aW9uKFwiZ3NkLmFjdGl2aXR5RmVlZE1heEl0ZW1zXCIpKSB7XG5cdFx0XHRcdFx0dGhpcy5tYXhJdGVtcyA9IHZzY29kZS53b3Jrc3BhY2UuZ2V0Q29uZmlndXJhdGlvbihcImdzZFwiKS5nZXQ8bnVtYmVyPihcImFjdGl2aXR5RmVlZE1heEl0ZW1zXCIsIDEwMCk7XG5cdFx0XHRcdH1cblx0XHRcdH0pLFxuXHRcdCk7XG5cdH1cblxuXHRnZXRUcmVlSXRlbShlbGVtZW50OiBBY3Rpdml0eUl0ZW0pOiB2c2NvZGUuVHJlZUl0ZW0ge1xuXHRcdGNvbnN0IGl0ZW0gPSBuZXcgdnNjb2RlLlRyZWVJdGVtKGVsZW1lbnQubGFiZWwsIHZzY29kZS5UcmVlSXRlbUNvbGxhcHNpYmxlU3RhdGUuTm9uZSk7XG5cdFx0aXRlbS5pY29uUGF0aCA9IGVsZW1lbnQuaWNvbjtcblx0XHRpdGVtLmRlc2NyaXB0aW9uID0gZWxlbWVudC5kdXJhdGlvbiAhPT0gdW5kZWZpbmVkXG5cdFx0XHQ/IGAke2VsZW1lbnQuZHVyYXRpb259bXNgXG5cdFx0XHQ6IGVsZW1lbnQuc3RhdHVzID09PSBcInJ1bm5pbmdcIlxuXHRcdFx0XHQ/IFwicnVubmluZy4uLlwiXG5cdFx0XHRcdDogXCJcIjtcblx0XHRpdGVtLnRvb2x0aXAgPSBgJHtlbGVtZW50LmRldGFpbH1cXG4ke25ldyBEYXRlKGVsZW1lbnQudGltZXN0YW1wKS50b0xvY2FsZVRpbWVTdHJpbmcoKX1gO1xuXG5cdFx0aWYgKGVsZW1lbnQuZmlsZVBhdGgpIHtcblx0XHRcdGl0ZW0uY29tbWFuZCA9IHtcblx0XHRcdFx0Y29tbWFuZDogXCJ2c2NvZGUub3BlblwiLFxuXHRcdFx0XHR0aXRsZTogXCJPcGVuIEZpbGVcIixcblx0XHRcdFx0YXJndW1lbnRzOiBbdnNjb2RlLlVyaS5maWxlKGVsZW1lbnQuZmlsZVBhdGgpXSxcblx0XHRcdH07XG5cdFx0fVxuXG5cdFx0cmV0dXJuIGl0ZW07XG5cdH1cblxuXHRnZXRDaGlsZHJlbigpOiBBY3Rpdml0eUl0ZW1bXSB7XG5cdFx0Ly8gU2hvdyBuZXdlc3QgZmlyc3Rcblx0XHRyZXR1cm4gWy4uLnRoaXMuaXRlbXNdLnJldmVyc2UoKTtcblx0fVxuXG5cdGNsZWFyKCk6IHZvaWQge1xuXHRcdHRoaXMuaXRlbXMgPSBbXTtcblx0XHR0aGlzLnJ1bm5pbmdUb29scy5jbGVhcigpO1xuXHRcdHRoaXMuX29uRGlkQ2hhbmdlVHJlZURhdGEuZmlyZSgpO1xuXHR9XG5cblx0ZGlzcG9zZSgpOiB2b2lkIHtcblx0XHRmb3IgKGNvbnN0IGQgb2YgdGhpcy5kaXNwb3NhYmxlcykge1xuXHRcdFx0ZC5kaXNwb3NlKCk7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBoYW5kbGVFdmVudChldnQ6IEFnZW50RXZlbnQpOiB2b2lkIHtcblx0XHRzd2l0Y2ggKGV2dC50eXBlKSB7XG5cdFx0XHRjYXNlIFwiYWdlbnRfc3RhcnRcIjoge1xuXHRcdFx0XHR0aGlzLmFkZEl0ZW0oe1xuXHRcdFx0XHRcdHR5cGU6IFwiYWdlbnRcIixcblx0XHRcdFx0XHRsYWJlbDogXCJBZ2VudCBzdGFydGVkXCIsXG5cdFx0XHRcdFx0ZGV0YWlsOiBcIkFnZW50IGJlZ2FuIHByb2Nlc3NpbmdcIixcblx0XHRcdFx0XHRpY29uOiBuZXcgdnNjb2RlLlRoZW1lSWNvbihcInBsYXlcIiwgbmV3IHZzY29kZS5UaGVtZUNvbG9yKFwidGVzdGluZy5pY29uUGFzc2VkXCIpKSxcblx0XHRcdFx0XHRzdGF0dXM6IFwicnVubmluZ1wiLFxuXHRcdFx0XHR9KTtcblx0XHRcdFx0YnJlYWs7XG5cdFx0XHR9XG5cdFx0XHRjYXNlIFwiYWdlbnRfZW5kXCI6IHtcblx0XHRcdFx0dGhpcy5hZGRJdGVtKHtcblx0XHRcdFx0XHR0eXBlOiBcImFnZW50XCIsXG5cdFx0XHRcdFx0bGFiZWw6IFwiQWdlbnQgZmluaXNoZWRcIixcblx0XHRcdFx0XHRkZXRhaWw6IFwiQWdlbnQgY29tcGxldGVkIHByb2Nlc3NpbmdcIixcblx0XHRcdFx0XHRpY29uOiBuZXcgdnNjb2RlLlRoZW1lSWNvbihcImNoZWNrXCIsIG5ldyB2c2NvZGUuVGhlbWVDb2xvcihcInRlc3RpbmcuaWNvblBhc3NlZFwiKSksXG5cdFx0XHRcdFx0c3RhdHVzOiBcInN1Y2Nlc3NcIixcblx0XHRcdFx0fSk7XG5cdFx0XHRcdGJyZWFrO1xuXHRcdFx0fVxuXHRcdFx0Y2FzZSBcInRvb2xfZXhlY3V0aW9uX3N0YXJ0XCI6IHtcblx0XHRcdFx0Y29uc3QgdG9vbE5hbWUgPSBTdHJpbmcoZXZ0LnRvb2xOYW1lID8/IFwiXCIpO1xuXHRcdFx0XHRjb25zdCB0b29sSW5wdXQgPSAoZXZ0LnRvb2xJbnB1dCA/PyB7fSkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG5cdFx0XHRcdGNvbnN0IHRvb2xVc2VJZCA9IFN0cmluZyhldnQudG9vbFVzZUlkID8/IFwiXCIpO1xuXHRcdFx0XHRjb25zdCB7IGxhYmVsLCBmaWxlUGF0aCB9ID0gdG9vbFN1bW1hcnkodG9vbE5hbWUsIHRvb2xJbnB1dCk7XG5cdFx0XHRcdGNvbnN0IGljb25OYW1lID0gVE9PTF9JQ09OU1t0b29sTmFtZV0gPz8gXCJ0b29sc1wiO1xuXG5cdFx0XHRcdGNvbnN0IGlkID0gdGhpcy5hZGRJdGVtKHtcblx0XHRcdFx0XHR0eXBlOiBcInRvb2xcIixcblx0XHRcdFx0XHRsYWJlbCxcblx0XHRcdFx0XHRkZXRhaWw6IGBUb29sOiAke3Rvb2xOYW1lfWAsXG5cdFx0XHRcdFx0aWNvbjogbmV3IHZzY29kZS5UaGVtZUljb24oaWNvbk5hbWUsIG5ldyB2c2NvZGUuVGhlbWVDb2xvcihcImNoYXJ0cy55ZWxsb3dcIikpLFxuXHRcdFx0XHRcdHN0YXR1czogXCJydW5uaW5nXCIsXG5cdFx0XHRcdFx0ZmlsZVBhdGgsXG5cdFx0XHRcdH0pO1xuXG5cdFx0XHRcdGlmICh0b29sVXNlSWQpIHtcblx0XHRcdFx0XHR0aGlzLnJ1bm5pbmdUb29scy5zZXQodG9vbFVzZUlkLCBpZCk7XG5cdFx0XHRcdH1cblx0XHRcdFx0YnJlYWs7XG5cdFx0XHR9XG5cdFx0XHRjYXNlIFwidG9vbF9leGVjdXRpb25fZW5kXCI6IHtcblx0XHRcdFx0Y29uc3QgdG9vbFVzZUlkID0gU3RyaW5nKGV2dC50b29sVXNlSWQgPz8gXCJcIik7XG5cdFx0XHRcdGNvbnN0IGl0ZW1JZCA9IHRoaXMucnVubmluZ1Rvb2xzLmdldCh0b29sVXNlSWQpO1xuXHRcdFx0XHRpZiAoaXRlbUlkICE9PSB1bmRlZmluZWQpIHtcblx0XHRcdFx0XHR0aGlzLnJ1bm5pbmdUb29scy5kZWxldGUodG9vbFVzZUlkKTtcblx0XHRcdFx0XHRjb25zdCBpdGVtID0gdGhpcy5pdGVtcy5maW5kKChpKSA9PiBpLmlkID09PSBpdGVtSWQpO1xuXHRcdFx0XHRcdGlmIChpdGVtKSB7XG5cdFx0XHRcdFx0XHRjb25zdCBpc0Vycm9yID0gZXZ0LmVycm9yID09PSB0cnVlIHx8IGV2dC5pc0Vycm9yID09PSB0cnVlO1xuXHRcdFx0XHRcdFx0aXRlbS5zdGF0dXMgPSBpc0Vycm9yID8gXCJlcnJvclwiIDogXCJzdWNjZXNzXCI7XG5cdFx0XHRcdFx0XHRpdGVtLmR1cmF0aW9uID0gRGF0ZS5ub3coKSAtIGl0ZW0udGltZXN0YW1wO1xuXHRcdFx0XHRcdFx0aXRlbS5pY29uID0gbmV3IHZzY29kZS5UaGVtZUljb24oXG5cdFx0XHRcdFx0XHRcdGlzRXJyb3IgPyBcImVycm9yXCIgOiBcImNoZWNrXCIsXG5cdFx0XHRcdFx0XHRcdG5ldyB2c2NvZGUuVGhlbWVDb2xvcihpc0Vycm9yID8gXCJ0ZXN0aW5nLmljb25GYWlsZWRcIiA6IFwidGVzdGluZy5pY29uUGFzc2VkXCIpLFxuXHRcdFx0XHRcdFx0KTtcblx0XHRcdFx0XHRcdHRoaXMuX29uRGlkQ2hhbmdlVHJlZURhdGEuZmlyZSgpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXHRcdFx0XHRicmVhaztcblx0XHRcdH1cblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIGFkZEl0ZW0ocGFydGlhbDogT21pdDxBY3Rpdml0eUl0ZW0sIFwiaWRcIiB8IFwidGltZXN0YW1wXCI+KTogbnVtYmVyIHtcblx0XHRjb25zdCBpZCA9IHRoaXMubmV4dElkKys7XG5cdFx0dGhpcy5pdGVtcy5wdXNoKHsgLi4ucGFydGlhbCwgaWQsIHRpbWVzdGFtcDogRGF0ZS5ub3coKSB9KTtcblxuXHRcdC8vIEV2aWN0IG9sZCBpdGVtc1xuXHRcdHdoaWxlICh0aGlzLml0ZW1zLmxlbmd0aCA+IHRoaXMubWF4SXRlbXMpIHtcblx0XHRcdHRoaXMuaXRlbXMuc2hpZnQoKTtcblx0XHR9XG5cblx0XHR0aGlzLl9vbkRpZENoYW5nZVRyZWVEYXRhLmZpcmUoKTtcblx0XHRyZXR1cm4gaWQ7XG5cdH1cbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFlBQVksWUFBWTtBQWV4QixNQUFNLGFBQXFDO0FBQUEsRUFDMUMsTUFBTTtBQUFBLEVBQ04sT0FBTztBQUFBLEVBQ1AsTUFBTTtBQUFBLEVBQ04sTUFBTTtBQUFBLEVBQ04sTUFBTTtBQUFBLEVBQ04s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
