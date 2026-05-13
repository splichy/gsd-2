import * as vscode from "vscode";
class GsdPlanViewerProvider {
  constructor(client) {
    this.client = client;
    this.disposables.push(
      this._onDidChangeTreeData,
      client.onEvent((evt) => this.handleEvent(evt)),
      client.onConnectionChange((connected) => {
        if (!connected) {
          this.steps = [];
          this.runningTools.clear();
          this._onDidChangeTreeData.fire();
        }
      })
    );
  }
  static viewId = "gsd-plan";
  _onDidChangeTreeData = new vscode.EventEmitter();
  onDidChangeTreeData = this._onDidChangeTreeData.event;
  steps = [];
  nextId = 0;
  runningTools = /* @__PURE__ */ new Map();
  // toolUseId -> step id
  disposables = [];
  getTreeItem(step) {
    const icon = stepIcon(step.status);
    const item = new vscode.TreeItem(step.description, vscode.TreeItemCollapsibleState.None);
    item.iconPath = icon;
    item.description = step.duration !== void 0 ? `${step.duration}ms` : step.status === "running" ? "running..." : "";
    const time = new Date(step.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    item.tooltip = `${step.tool}: ${step.description}
Status: ${step.status}
Time: ${time}`;
    return item;
  }
  getChildren() {
    return this.steps;
  }
  clear() {
    this.steps = [];
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
        if (this.steps.length > 0) {
          this.steps.push({
            id: this.nextId++,
            tool: "separator",
            description: "--- New Turn ---",
            status: "done",
            timestamp: Date.now()
          });
        }
        this.steps.push({
          id: this.nextId++,
          tool: "agent",
          description: "Agent started",
          status: "running",
          timestamp: Date.now()
        });
        this._onDidChangeTreeData.fire();
        break;
      }
      case "agent_end": {
        const agentStep = [...this.steps].reverse().find((s) => s.tool === "agent" && s.status === "running");
        if (agentStep) {
          agentStep.status = "done";
          agentStep.duration = Date.now() - agentStep.timestamp;
          agentStep.description = "Agent finished";
        }
        this._onDidChangeTreeData.fire();
        break;
      }
      case "tool_execution_start": {
        const toolName = String(evt.toolName ?? "");
        const toolInput = evt.toolInput ?? {};
        const toolUseId = String(evt.toolUseId ?? "");
        const description = describeStep(toolName, toolInput);
        const id = this.nextId++;
        this.steps.push({
          id,
          tool: toolName,
          description,
          status: "running",
          timestamp: Date.now()
        });
        if (toolUseId) {
          this.runningTools.set(toolUseId, id);
        }
        while (this.steps.length > 200) {
          this.steps.shift();
        }
        this._onDidChangeTreeData.fire();
        break;
      }
      case "tool_execution_end": {
        const toolUseId = String(evt.toolUseId ?? "");
        const stepId = this.runningTools.get(toolUseId);
        if (stepId !== void 0) {
          this.runningTools.delete(toolUseId);
          const step = this.steps.find((s) => s.id === stepId);
          if (step) {
            const isError = evt.error === true || evt.isError === true;
            step.status = isError ? "error" : "done";
            step.duration = Date.now() - step.timestamp;
            this._onDidChangeTreeData.fire();
          }
        }
        break;
      }
    }
  }
}
function stepIcon(status) {
  switch (status) {
    case "running":
      return new vscode.ThemeIcon("sync~spin", new vscode.ThemeColor("charts.yellow"));
    case "done":
      return new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"));
    case "error":
      return new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed"));
    default:
      return new vscode.ThemeIcon("circle-outline");
  }
}
function describeStep(toolName, input) {
  switch (toolName) {
    case "Read": {
      const p = String(input.file_path ?? input.path ?? "");
      return `Read ${p.split(/[\\/]/).pop() ?? p}`;
    }
    case "Write": {
      const p = String(input.file_path ?? "");
      return `Write ${p.split(/[\\/]/).pop() ?? p}`;
    }
    case "Edit": {
      const p = String(input.file_path ?? "");
      return `Edit ${p.split(/[\\/]/).pop() ?? p}`;
    }
    case "Bash":
      return `$ ${String(input.command ?? "").slice(0, 50)}`;
    case "Grep":
      return `Grep: ${String(input.pattern ?? "").slice(0, 40)}`;
    case "Glob":
      return `Glob: ${String(input.pattern ?? "").slice(0, 40)}`;
    default:
      return toolName;
  }
}
export {
  GsdPlanViewerProvider
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vdnNjb2RlLWV4dGVuc2lvbi9zcmMvcGxhbi12aWV3ZXIudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCAqIGFzIHZzY29kZSBmcm9tIFwidnNjb2RlXCI7XG5pbXBvcnQgdHlwZSB7IEdzZENsaWVudCwgQWdlbnRFdmVudCB9IGZyb20gXCIuL2dzZC1jbGllbnQuanNcIjtcblxuaW50ZXJmYWNlIFBsYW5TdGVwIHtcblx0aWQ6IG51bWJlcjtcblx0dG9vbDogc3RyaW5nO1xuXHRkZXNjcmlwdGlvbjogc3RyaW5nO1xuXHRzdGF0dXM6IFwicGVuZGluZ1wiIHwgXCJydW5uaW5nXCIgfCBcImRvbmVcIiB8IFwiZXJyb3JcIjtcblx0dGltZXN0YW1wOiBudW1iZXI7XG5cdGR1cmF0aW9uPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIFRyZWVEYXRhUHJvdmlkZXIgdGhhdCBzaG93cyBhIHBsYW4tbGlrZSB2aWV3IG9mIGFnZW50IHRvb2wgZXhlY3V0aW9ucy5cbiAqIERpc3BsYXlzIHN0ZXBzIGFzIHRoZXkgaGFwcGVuLCBzaG93aW5nIHdoYXQgdGhlIGFnZW50IGlzIGRvaW5nIGFuZFxuICogd2hhdCBpdCBoYXMgY29tcGxldGVkIFx1MjAxNCBhIGxpdmUgZXhlY3V0aW9uIHBsYW4uXG4gKi9cbmV4cG9ydCBjbGFzcyBHc2RQbGFuVmlld2VyUHJvdmlkZXIgaW1wbGVtZW50cyB2c2NvZGUuVHJlZURhdGFQcm92aWRlcjxQbGFuU3RlcD4sIHZzY29kZS5EaXNwb3NhYmxlIHtcblx0cHVibGljIHN0YXRpYyByZWFkb25seSB2aWV3SWQgPSBcImdzZC1wbGFuXCI7XG5cblx0cHJpdmF0ZSByZWFkb25seSBfb25EaWRDaGFuZ2VUcmVlRGF0YSA9IG5ldyB2c2NvZGUuRXZlbnRFbWl0dGVyPHZvaWQ+KCk7XG5cdHJlYWRvbmx5IG9uRGlkQ2hhbmdlVHJlZURhdGEgPSB0aGlzLl9vbkRpZENoYW5nZVRyZWVEYXRhLmV2ZW50O1xuXG5cdHByaXZhdGUgc3RlcHM6IFBsYW5TdGVwW10gPSBbXTtcblx0cHJpdmF0ZSBuZXh0SWQgPSAwO1xuXHRwcml2YXRlIHJ1bm5pbmdUb29scyA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7IC8vIHRvb2xVc2VJZCAtPiBzdGVwIGlkXG5cdHByaXZhdGUgZGlzcG9zYWJsZXM6IHZzY29kZS5EaXNwb3NhYmxlW10gPSBbXTtcblxuXHRjb25zdHJ1Y3Rvcihwcml2YXRlIHJlYWRvbmx5IGNsaWVudDogR3NkQ2xpZW50KSB7XG5cdFx0dGhpcy5kaXNwb3NhYmxlcy5wdXNoKFxuXHRcdFx0dGhpcy5fb25EaWRDaGFuZ2VUcmVlRGF0YSxcblx0XHRcdGNsaWVudC5vbkV2ZW50KChldnQpID0+IHRoaXMuaGFuZGxlRXZlbnQoZXZ0KSksXG5cdFx0XHRjbGllbnQub25Db25uZWN0aW9uQ2hhbmdlKChjb25uZWN0ZWQpID0+IHtcblx0XHRcdFx0aWYgKCFjb25uZWN0ZWQpIHtcblx0XHRcdFx0XHR0aGlzLnN0ZXBzID0gW107XG5cdFx0XHRcdFx0dGhpcy5ydW5uaW5nVG9vbHMuY2xlYXIoKTtcblx0XHRcdFx0XHR0aGlzLl9vbkRpZENoYW5nZVRyZWVEYXRhLmZpcmUoKTtcblx0XHRcdFx0fVxuXHRcdFx0fSksXG5cdFx0KTtcblx0fVxuXG5cdGdldFRyZWVJdGVtKHN0ZXA6IFBsYW5TdGVwKTogdnNjb2RlLlRyZWVJdGVtIHtcblx0XHRjb25zdCBpY29uID0gc3RlcEljb24oc3RlcC5zdGF0dXMpO1xuXHRcdGNvbnN0IGl0ZW0gPSBuZXcgdnNjb2RlLlRyZWVJdGVtKHN0ZXAuZGVzY3JpcHRpb24sIHZzY29kZS5UcmVlSXRlbUNvbGxhcHNpYmxlU3RhdGUuTm9uZSk7XG5cdFx0aXRlbS5pY29uUGF0aCA9IGljb247XG5cdFx0aXRlbS5kZXNjcmlwdGlvbiA9IHN0ZXAuZHVyYXRpb24gIT09IHVuZGVmaW5lZCA/IGAke3N0ZXAuZHVyYXRpb259bXNgIDogc3RlcC5zdGF0dXMgPT09IFwicnVubmluZ1wiID8gXCJydW5uaW5nLi4uXCIgOiBcIlwiO1xuXG5cdFx0Y29uc3QgdGltZSA9IG5ldyBEYXRlKHN0ZXAudGltZXN0YW1wKS50b0xvY2FsZVRpbWVTdHJpbmcoW10sIHsgaG91cjogXCIyLWRpZ2l0XCIsIG1pbnV0ZTogXCIyLWRpZ2l0XCIsIHNlY29uZDogXCIyLWRpZ2l0XCIgfSk7XG5cdFx0aXRlbS50b29sdGlwID0gYCR7c3RlcC50b29sfTogJHtzdGVwLmRlc2NyaXB0aW9ufVxcblN0YXR1czogJHtzdGVwLnN0YXR1c31cXG5UaW1lOiAke3RpbWV9YDtcblxuXHRcdHJldHVybiBpdGVtO1xuXHR9XG5cblx0Z2V0Q2hpbGRyZW4oKTogUGxhblN0ZXBbXSB7XG5cdFx0cmV0dXJuIHRoaXMuc3RlcHM7XG5cdH1cblxuXHRjbGVhcigpOiB2b2lkIHtcblx0XHR0aGlzLnN0ZXBzID0gW107XG5cdFx0dGhpcy5ydW5uaW5nVG9vbHMuY2xlYXIoKTtcblx0XHR0aGlzLl9vbkRpZENoYW5nZVRyZWVEYXRhLmZpcmUoKTtcblx0fVxuXG5cdGRpc3Bvc2UoKTogdm9pZCB7XG5cdFx0Zm9yIChjb25zdCBkIG9mIHRoaXMuZGlzcG9zYWJsZXMpIHtcblx0XHRcdGQuZGlzcG9zZSgpO1xuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgaGFuZGxlRXZlbnQoZXZ0OiBBZ2VudEV2ZW50KTogdm9pZCB7XG5cdFx0c3dpdGNoIChldnQudHlwZSkge1xuXHRcdFx0Y2FzZSBcImFnZW50X3N0YXJ0XCI6IHtcblx0XHRcdFx0Ly8gRG9uJ3QgY2xlYXIgXHUyMDE0IGtlZXAgaGlzdG9yeSB2aXNpYmxlLiBBZGQgYSBzZXBhcmF0b3IuXG5cdFx0XHRcdGlmICh0aGlzLnN0ZXBzLmxlbmd0aCA+IDApIHtcblx0XHRcdFx0XHR0aGlzLnN0ZXBzLnB1c2goe1xuXHRcdFx0XHRcdFx0aWQ6IHRoaXMubmV4dElkKyssXG5cdFx0XHRcdFx0XHR0b29sOiBcInNlcGFyYXRvclwiLFxuXHRcdFx0XHRcdFx0ZGVzY3JpcHRpb246IFwiLS0tIE5ldyBUdXJuIC0tLVwiLFxuXHRcdFx0XHRcdFx0c3RhdHVzOiBcImRvbmVcIixcblx0XHRcdFx0XHRcdHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcblx0XHRcdFx0XHR9KTtcblx0XHRcdFx0fVxuXHRcdFx0XHR0aGlzLnN0ZXBzLnB1c2goe1xuXHRcdFx0XHRcdGlkOiB0aGlzLm5leHRJZCsrLFxuXHRcdFx0XHRcdHRvb2w6IFwiYWdlbnRcIixcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjogXCJBZ2VudCBzdGFydGVkXCIsXG5cdFx0XHRcdFx0c3RhdHVzOiBcInJ1bm5pbmdcIixcblx0XHRcdFx0XHR0aW1lc3RhbXA6IERhdGUubm93KCksXG5cdFx0XHRcdH0pO1xuXHRcdFx0XHR0aGlzLl9vbkRpZENoYW5nZVRyZWVEYXRhLmZpcmUoKTtcblx0XHRcdFx0YnJlYWs7XG5cdFx0XHR9XG5cblx0XHRcdGNhc2UgXCJhZ2VudF9lbmRcIjoge1xuXHRcdFx0XHQvLyBNYXJrIHRoZSBhZ2VudCBzdGVwIGFzIGRvbmVcblx0XHRcdFx0Y29uc3QgYWdlbnRTdGVwID0gWy4uLnRoaXMuc3RlcHNdLnJldmVyc2UoKS5maW5kKChzKSA9PiBzLnRvb2wgPT09IFwiYWdlbnRcIiAmJiBzLnN0YXR1cyA9PT0gXCJydW5uaW5nXCIpO1xuXHRcdFx0XHRpZiAoYWdlbnRTdGVwKSB7XG5cdFx0XHRcdFx0YWdlbnRTdGVwLnN0YXR1cyA9IFwiZG9uZVwiO1xuXHRcdFx0XHRcdGFnZW50U3RlcC5kdXJhdGlvbiA9IERhdGUubm93KCkgLSBhZ2VudFN0ZXAudGltZXN0YW1wO1xuXHRcdFx0XHRcdGFnZW50U3RlcC5kZXNjcmlwdGlvbiA9IFwiQWdlbnQgZmluaXNoZWRcIjtcblx0XHRcdFx0fVxuXHRcdFx0XHR0aGlzLl9vbkRpZENoYW5nZVRyZWVEYXRhLmZpcmUoKTtcblx0XHRcdFx0YnJlYWs7XG5cdFx0XHR9XG5cblx0XHRcdGNhc2UgXCJ0b29sX2V4ZWN1dGlvbl9zdGFydFwiOiB7XG5cdFx0XHRcdGNvbnN0IHRvb2xOYW1lID0gU3RyaW5nKGV2dC50b29sTmFtZSA/PyBcIlwiKTtcblx0XHRcdFx0Y29uc3QgdG9vbElucHV0ID0gKGV2dC50b29sSW5wdXQgPz8ge30pIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuXHRcdFx0XHRjb25zdCB0b29sVXNlSWQgPSBTdHJpbmcoZXZ0LnRvb2xVc2VJZCA/PyBcIlwiKTtcblx0XHRcdFx0Y29uc3QgZGVzY3JpcHRpb24gPSBkZXNjcmliZVN0ZXAodG9vbE5hbWUsIHRvb2xJbnB1dCk7XG5cblx0XHRcdFx0Y29uc3QgaWQgPSB0aGlzLm5leHRJZCsrO1xuXHRcdFx0XHR0aGlzLnN0ZXBzLnB1c2goe1xuXHRcdFx0XHRcdGlkLFxuXHRcdFx0XHRcdHRvb2w6IHRvb2xOYW1lLFxuXHRcdFx0XHRcdGRlc2NyaXB0aW9uLFxuXHRcdFx0XHRcdHN0YXR1czogXCJydW5uaW5nXCIsXG5cdFx0XHRcdFx0dGltZXN0YW1wOiBEYXRlLm5vdygpLFxuXHRcdFx0XHR9KTtcblxuXHRcdFx0XHRpZiAodG9vbFVzZUlkKSB7XG5cdFx0XHRcdFx0dGhpcy5ydW5uaW5nVG9vbHMuc2V0KHRvb2xVc2VJZCwgaWQpO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Ly8gQ2FwIGF0IDIwMCBzdGVwc1xuXHRcdFx0XHR3aGlsZSAodGhpcy5zdGVwcy5sZW5ndGggPiAyMDApIHtcblx0XHRcdFx0XHR0aGlzLnN0ZXBzLnNoaWZ0KCk7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHR0aGlzLl9vbkRpZENoYW5nZVRyZWVEYXRhLmZpcmUoKTtcblx0XHRcdFx0YnJlYWs7XG5cdFx0XHR9XG5cblx0XHRcdGNhc2UgXCJ0b29sX2V4ZWN1dGlvbl9lbmRcIjoge1xuXHRcdFx0XHRjb25zdCB0b29sVXNlSWQgPSBTdHJpbmcoZXZ0LnRvb2xVc2VJZCA/PyBcIlwiKTtcblx0XHRcdFx0Y29uc3Qgc3RlcElkID0gdGhpcy5ydW5uaW5nVG9vbHMuZ2V0KHRvb2xVc2VJZCk7XG5cdFx0XHRcdGlmIChzdGVwSWQgIT09IHVuZGVmaW5lZCkge1xuXHRcdFx0XHRcdHRoaXMucnVubmluZ1Rvb2xzLmRlbGV0ZSh0b29sVXNlSWQpO1xuXHRcdFx0XHRcdGNvbnN0IHN0ZXAgPSB0aGlzLnN0ZXBzLmZpbmQoKHMpID0+IHMuaWQgPT09IHN0ZXBJZCk7XG5cdFx0XHRcdFx0aWYgKHN0ZXApIHtcblx0XHRcdFx0XHRcdGNvbnN0IGlzRXJyb3IgPSBldnQuZXJyb3IgPT09IHRydWUgfHwgZXZ0LmlzRXJyb3IgPT09IHRydWU7XG5cdFx0XHRcdFx0XHRzdGVwLnN0YXR1cyA9IGlzRXJyb3IgPyBcImVycm9yXCIgOiBcImRvbmVcIjtcblx0XHRcdFx0XHRcdHN0ZXAuZHVyYXRpb24gPSBEYXRlLm5vdygpIC0gc3RlcC50aW1lc3RhbXA7XG5cdFx0XHRcdFx0XHR0aGlzLl9vbkRpZENoYW5nZVRyZWVEYXRhLmZpcmUoKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblx0XHRcdFx0YnJlYWs7XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG59XG5cbmZ1bmN0aW9uIHN0ZXBJY29uKHN0YXR1czogc3RyaW5nKTogdnNjb2RlLlRoZW1lSWNvbiB7XG5cdHN3aXRjaCAoc3RhdHVzKSB7XG5cdFx0Y2FzZSBcInJ1bm5pbmdcIjpcblx0XHRcdHJldHVybiBuZXcgdnNjb2RlLlRoZW1lSWNvbihcInN5bmN+c3BpblwiLCBuZXcgdnNjb2RlLlRoZW1lQ29sb3IoXCJjaGFydHMueWVsbG93XCIpKTtcblx0XHRjYXNlIFwiZG9uZVwiOlxuXHRcdFx0cmV0dXJuIG5ldyB2c2NvZGUuVGhlbWVJY29uKFwicGFzc1wiLCBuZXcgdnNjb2RlLlRoZW1lQ29sb3IoXCJ0ZXN0aW5nLmljb25QYXNzZWRcIikpO1xuXHRcdGNhc2UgXCJlcnJvclwiOlxuXHRcdFx0cmV0dXJuIG5ldyB2c2NvZGUuVGhlbWVJY29uKFwiZXJyb3JcIiwgbmV3IHZzY29kZS5UaGVtZUNvbG9yKFwidGVzdGluZy5pY29uRmFpbGVkXCIpKTtcblx0XHRkZWZhdWx0OlxuXHRcdFx0cmV0dXJuIG5ldyB2c2NvZGUuVGhlbWVJY29uKFwiY2lyY2xlLW91dGxpbmVcIik7XG5cdH1cbn1cblxuZnVuY3Rpb24gZGVzY3JpYmVTdGVwKHRvb2xOYW1lOiBzdHJpbmcsIGlucHV0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IHN0cmluZyB7XG5cdHN3aXRjaCAodG9vbE5hbWUpIHtcblx0XHRjYXNlIFwiUmVhZFwiOiB7XG5cdFx0XHRjb25zdCBwID0gU3RyaW5nKGlucHV0LmZpbGVfcGF0aCA/PyBpbnB1dC5wYXRoID8/IFwiXCIpO1xuXHRcdFx0cmV0dXJuIGBSZWFkICR7cC5zcGxpdCgvW1xcXFwvXS8pLnBvcCgpID8/IHB9YDtcblx0XHR9XG5cdFx0Y2FzZSBcIldyaXRlXCI6IHtcblx0XHRcdGNvbnN0IHAgPSBTdHJpbmcoaW5wdXQuZmlsZV9wYXRoID8/IFwiXCIpO1xuXHRcdFx0cmV0dXJuIGBXcml0ZSAke3Auc3BsaXQoL1tcXFxcL10vKS5wb3AoKSA/PyBwfWA7XG5cdFx0fVxuXHRcdGNhc2UgXCJFZGl0XCI6IHtcblx0XHRcdGNvbnN0IHAgPSBTdHJpbmcoaW5wdXQuZmlsZV9wYXRoID8/IFwiXCIpO1xuXHRcdFx0cmV0dXJuIGBFZGl0ICR7cC5zcGxpdCgvW1xcXFwvXS8pLnBvcCgpID8/IHB9YDtcblx0XHR9XG5cdFx0Y2FzZSBcIkJhc2hcIjpcblx0XHRcdHJldHVybiBgJCAke1N0cmluZyhpbnB1dC5jb21tYW5kID8/IFwiXCIpLnNsaWNlKDAsIDUwKX1gO1xuXHRcdGNhc2UgXCJHcmVwXCI6XG5cdFx0XHRyZXR1cm4gYEdyZXA6ICR7U3RyaW5nKGlucHV0LnBhdHRlcm4gPz8gXCJcIikuc2xpY2UoMCwgNDApfWA7XG5cdFx0Y2FzZSBcIkdsb2JcIjpcblx0XHRcdHJldHVybiBgR2xvYjogJHtTdHJpbmcoaW5wdXQucGF0dGVybiA/PyBcIlwiKS5zbGljZSgwLCA0MCl9YDtcblx0XHRkZWZhdWx0OlxuXHRcdFx0cmV0dXJuIHRvb2xOYW1lO1xuXHR9XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxZQUFZLFlBQVk7QUFpQmpCLE1BQU0sc0JBQXNGO0FBQUEsRUFXbEcsWUFBNkIsUUFBbUI7QUFBbkI7QUFDNUIsU0FBSyxZQUFZO0FBQUEsTUFDaEIsS0FBSztBQUFBLE1BQ0wsT0FBTyxRQUFRLENBQUMsUUFBUSxLQUFLLFlBQVksR0FBRyxDQUFDO0FBQUEsTUFDN0MsT0FBTyxtQkFBbUIsQ0FBQyxjQUFjO0FBQ3hDLFlBQUksQ0FBQyxXQUFXO0FBQ2YsZUFBSyxRQUFRLENBQUM7QUFDZCxlQUFLLGFBQWEsTUFBTTtBQUN4QixlQUFLLHFCQUFxQixLQUFLO0FBQUEsUUFDaEM7QUFBQSxNQUNELENBQUM7QUFBQSxJQUNGO0FBQUEsRUFDRDtBQUFBLEVBdEJBLE9BQXVCLFNBQVM7QUFBQSxFQUVmLHVCQUF1QixJQUFJLE9BQU8sYUFBbUI7QUFBQSxFQUM3RCxzQkFBc0IsS0FBSyxxQkFBcUI7QUFBQSxFQUVqRCxRQUFvQixDQUFDO0FBQUEsRUFDckIsU0FBUztBQUFBLEVBQ1QsZUFBZSxvQkFBSSxJQUFvQjtBQUFBO0FBQUEsRUFDdkMsY0FBbUMsQ0FBQztBQUFBLEVBZ0I1QyxZQUFZLE1BQWlDO0FBQzVDLFVBQU0sT0FBTyxTQUFTLEtBQUssTUFBTTtBQUNqQyxVQUFNLE9BQU8sSUFBSSxPQUFPLFNBQVMsS0FBSyxhQUFhLE9BQU8seUJBQXlCLElBQUk7QUFDdkYsU0FBSyxXQUFXO0FBQ2hCLFNBQUssY0FBYyxLQUFLLGFBQWEsU0FBWSxHQUFHLEtBQUssUUFBUSxPQUFPLEtBQUssV0FBVyxZQUFZLGVBQWU7QUFFbkgsVUFBTSxPQUFPLElBQUksS0FBSyxLQUFLLFNBQVMsRUFBRSxtQkFBbUIsQ0FBQyxHQUFHLEVBQUUsTUFBTSxXQUFXLFFBQVEsV0FBVyxRQUFRLFVBQVUsQ0FBQztBQUN0SCxTQUFLLFVBQVUsR0FBRyxLQUFLLElBQUksS0FBSyxLQUFLLFdBQVc7QUFBQSxVQUFhLEtBQUssTUFBTTtBQUFBLFFBQVcsSUFBSTtBQUV2RixXQUFPO0FBQUEsRUFDUjtBQUFBLEVBRUEsY0FBMEI7QUFDekIsV0FBTyxLQUFLO0FBQUEsRUFDYjtBQUFBLEVBRUEsUUFBYztBQUNiLFNBQUssUUFBUSxDQUFDO0FBQ2QsU0FBSyxhQUFhLE1BQU07QUFDeEIsU0FBSyxxQkFBcUIsS0FBSztBQUFBLEVBQ2hDO0FBQUEsRUFFQSxVQUFnQjtBQUNmLGVBQVcsS0FBSyxLQUFLLGFBQWE7QUFDakMsUUFBRSxRQUFRO0FBQUEsSUFDWDtBQUFBLEVBQ0Q7QUFBQSxFQUVRLFlBQVksS0FBdUI7QUFDMUMsWUFBUSxJQUFJLE1BQU07QUFBQSxNQUNqQixLQUFLLGVBQWU7QUFFbkIsWUFBSSxLQUFLLE1BQU0sU0FBUyxHQUFHO0FBQzFCLGVBQUssTUFBTSxLQUFLO0FBQUEsWUFDZixJQUFJLEtBQUs7QUFBQSxZQUNULE1BQU07QUFBQSxZQUNOLGFBQWE7QUFBQSxZQUNiLFFBQVE7QUFBQSxZQUNSLFdBQVcsS0FBSyxJQUFJO0FBQUEsVUFDckIsQ0FBQztBQUFBLFFBQ0Y7QUFDQSxhQUFLLE1BQU0sS0FBSztBQUFBLFVBQ2YsSUFBSSxLQUFLO0FBQUEsVUFDVCxNQUFNO0FBQUEsVUFDTixhQUFhO0FBQUEsVUFDYixRQUFRO0FBQUEsVUFDUixXQUFXLEtBQUssSUFBSTtBQUFBLFFBQ3JCLENBQUM7QUFDRCxhQUFLLHFCQUFxQixLQUFLO0FBQy9CO0FBQUEsTUFDRDtBQUFBLE1BRUEsS0FBSyxhQUFhO0FBRWpCLGNBQU0sWUFBWSxDQUFDLEdBQUcsS0FBSyxLQUFLLEVBQUUsUUFBUSxFQUFFLEtBQUssQ0FBQyxNQUFNLEVBQUUsU0FBUyxXQUFXLEVBQUUsV0FBVyxTQUFTO0FBQ3BHLFlBQUksV0FBVztBQUNkLG9CQUFVLFNBQVM7QUFDbkIsb0JBQVUsV0FBVyxLQUFLLElBQUksSUFBSSxVQUFVO0FBQzVDLG9CQUFVLGNBQWM7QUFBQSxRQUN6QjtBQUNBLGFBQUsscUJBQXFCLEtBQUs7QUFDL0I7QUFBQSxNQUNEO0FBQUEsTUFFQSxLQUFLLHdCQUF3QjtBQUM1QixjQUFNLFdBQVcsT0FBTyxJQUFJLFlBQVksRUFBRTtBQUMxQyxjQUFNLFlBQWEsSUFBSSxhQUFhLENBQUM7QUFDckMsY0FBTSxZQUFZLE9BQU8sSUFBSSxhQUFhLEVBQUU7QUFDNUMsY0FBTSxjQUFjLGFBQWEsVUFBVSxTQUFTO0FBRXBELGNBQU0sS0FBSyxLQUFLO0FBQ2hCLGFBQUssTUFBTSxLQUFLO0FBQUEsVUFDZjtBQUFBLFVBQ0EsTUFBTTtBQUFBLFVBQ047QUFBQSxVQUNBLFFBQVE7QUFBQSxVQUNSLFdBQVcsS0FBSyxJQUFJO0FBQUEsUUFDckIsQ0FBQztBQUVELFlBQUksV0FBVztBQUNkLGVBQUssYUFBYSxJQUFJLFdBQVcsRUFBRTtBQUFBLFFBQ3BDO0FBR0EsZUFBTyxLQUFLLE1BQU0sU0FBUyxLQUFLO0FBQy9CLGVBQUssTUFBTSxNQUFNO0FBQUEsUUFDbEI7QUFFQSxhQUFLLHFCQUFxQixLQUFLO0FBQy9CO0FBQUEsTUFDRDtBQUFBLE1BRUEsS0FBSyxzQkFBc0I7QUFDMUIsY0FBTSxZQUFZLE9BQU8sSUFBSSxhQUFhLEVBQUU7QUFDNUMsY0FBTSxTQUFTLEtBQUssYUFBYSxJQUFJLFNBQVM7QUFDOUMsWUFBSSxXQUFXLFFBQVc7QUFDekIsZUFBSyxhQUFhLE9BQU8sU0FBUztBQUNsQyxnQkFBTSxPQUFPLEtBQUssTUFBTSxLQUFLLENBQUMsTUFBTSxFQUFFLE9BQU8sTUFBTTtBQUNuRCxjQUFJLE1BQU07QUFDVCxrQkFBTSxVQUFVLElBQUksVUFBVSxRQUFRLElBQUksWUFBWTtBQUN0RCxpQkFBSyxTQUFTLFVBQVUsVUFBVTtBQUNsQyxpQkFBSyxXQUFXLEtBQUssSUFBSSxJQUFJLEtBQUs7QUFDbEMsaUJBQUsscUJBQXFCLEtBQUs7QUFBQSxVQUNoQztBQUFBLFFBQ0Q7QUFDQTtBQUFBLE1BQ0Q7QUFBQSxJQUNEO0FBQUEsRUFDRDtBQUNEO0FBRUEsU0FBUyxTQUFTLFFBQWtDO0FBQ25ELFVBQVEsUUFBUTtBQUFBLElBQ2YsS0FBSztBQUNKLGFBQU8sSUFBSSxPQUFPLFVBQVUsYUFBYSxJQUFJLE9BQU8sV0FBVyxlQUFlLENBQUM7QUFBQSxJQUNoRixLQUFLO0FBQ0osYUFBTyxJQUFJLE9BQU8sVUFBVSxRQUFRLElBQUksT0FBTyxXQUFXLG9CQUFvQixDQUFDO0FBQUEsSUFDaEYsS0FBSztBQUNKLGFBQU8sSUFBSSxPQUFPLFVBQVUsU0FBUyxJQUFJLE9BQU8sV0FBVyxvQkFBb0IsQ0FBQztBQUFBLElBQ2pGO0FBQ0MsYUFBTyxJQUFJLE9BQU8sVUFBVSxnQkFBZ0I7QUFBQSxFQUM5QztBQUNEO0FBRUEsU0FBUyxhQUFhLFVBQWtCLE9BQXdDO0FBQy9FLFVBQVEsVUFBVTtBQUFBLElBQ2pCLEtBQUssUUFBUTtBQUNaLFlBQU0sSUFBSSxPQUFPLE1BQU0sYUFBYSxNQUFNLFFBQVEsRUFBRTtBQUNwRCxhQUFPLFFBQVEsRUFBRSxNQUFNLE9BQU8sRUFBRSxJQUFJLEtBQUssQ0FBQztBQUFBLElBQzNDO0FBQUEsSUFDQSxLQUFLLFNBQVM7QUFDYixZQUFNLElBQUksT0FBTyxNQUFNLGFBQWEsRUFBRTtBQUN0QyxhQUFPLFNBQVMsRUFBRSxNQUFNLE9BQU8sRUFBRSxJQUFJLEtBQUssQ0FBQztBQUFBLElBQzVDO0FBQUEsSUFDQSxLQUFLLFFBQVE7QUFDWixZQUFNLElBQUksT0FBTyxNQUFNLGFBQWEsRUFBRTtBQUN0QyxhQUFPLFFBQVEsRUFBRSxNQUFNLE9BQU8sRUFBRSxJQUFJLEtBQUssQ0FBQztBQUFBLElBQzNDO0FBQUEsSUFDQSxLQUFLO0FBQ0osYUFBTyxLQUFLLE9BQU8sTUFBTSxXQUFXLEVBQUUsRUFBRSxNQUFNLEdBQUcsRUFBRSxDQUFDO0FBQUEsSUFDckQsS0FBSztBQUNKLGFBQU8sU0FBUyxPQUFPLE1BQU0sV0FBVyxFQUFFLEVBQUUsTUFBTSxHQUFHLEVBQUUsQ0FBQztBQUFBLElBQ3pELEtBQUs7QUFDSixhQUFPLFNBQVMsT0FBTyxNQUFNLFdBQVcsRUFBRSxFQUFFLE1BQU0sR0FBRyxFQUFFLENBQUM7QUFBQSxJQUN6RDtBQUNDLGFBQU87QUFBQSxFQUNUO0FBQ0Q7IiwKICAibmFtZXMiOiBbXQp9Cg==
