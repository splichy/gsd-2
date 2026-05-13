import * as vscode from "vscode";
import * as path from "node:path";
const GSD_ORIGINAL_SCHEME = "gsd-original";
class GsdScmProvider {
  constructor(tracker, workspaceRoot) {
    this.tracker = tracker;
    this.workspaceRoot = workspaceRoot;
    this.contentProvider = new GsdOriginalContentProvider(tracker);
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(
        GSD_ORIGINAL_SCHEME,
        this.contentProvider
      )
    );
    this.scm = vscode.scm.createSourceControl(
      "gsd",
      "GSD Agent",
      vscode.Uri.file(workspaceRoot)
    );
    this.scm.quickDiffProvider = {
      provideOriginalResource: (uri) => {
        const filePath = uri.fsPath;
        if (this.tracker.getOriginal(filePath) !== void 0) {
          return uri.with({ scheme: GSD_ORIGINAL_SCHEME });
        }
        return void 0;
      }
    };
    this.scm.inputBox.placeholder = "Describe changes to accept...";
    this.scm.acceptInputCommand = {
      command: "gsd.acceptAllChanges",
      title: "Accept All"
    };
    this.scm.count = 0;
    this.disposables.push(this.scm);
    this.changesGroup = this.scm.createResourceGroup("changes", "Agent Changes");
    this.changesGroup.hideWhenEmpty = true;
    this.disposables.push(this.changesGroup);
    this.disposables.push(
      tracker.onDidChange(() => this.refresh())
    );
    this.refresh();
  }
  scm;
  changesGroup;
  contentProvider;
  disposables = [];
  refresh() {
    const files = this.tracker.modifiedFiles;
    this.changesGroup.resourceStates = files.map((filePath) => {
      const uri = vscode.Uri.file(filePath);
      const fileName = path.basename(filePath);
      const relativePath = path.relative(this.workspaceRoot, filePath);
      const state = {
        resourceUri: uri,
        decorations: {
          strikeThrough: false,
          tooltip: `Modified by GSD Agent`,
          light: { iconPath: new vscode.ThemeIcon("edit") },
          dark: { iconPath: new vscode.ThemeIcon("edit") }
        },
        command: {
          command: "vscode.diff",
          title: "Show Changes",
          arguments: [
            uri.with({ scheme: GSD_ORIGINAL_SCHEME }),
            uri,
            `${fileName} (GSD Agent Changes)`
          ]
        }
      };
      return state;
    });
    this.scm.count = files.length;
  }
  dispose() {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
class GsdOriginalContentProvider {
  constructor(tracker) {
    this.tracker = tracker;
    tracker.onDidChange((paths) => {
      for (const p of paths) {
        this._onDidChange.fire(vscode.Uri.file(p).with({ scheme: GSD_ORIGINAL_SCHEME }));
      }
    });
  }
  _onDidChange = new vscode.EventEmitter();
  onDidChange = this._onDidChange.event;
  provideTextDocumentContent(uri) {
    const filePath = uri.with({ scheme: "file" }).fsPath;
    return this.tracker.getOriginal(filePath) ?? "";
  }
}
export {
  GsdScmProvider
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vdnNjb2RlLWV4dGVuc2lvbi9zcmMvc2NtLXByb3ZpZGVyLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgKiBhcyB2c2NvZGUgZnJvbSBcInZzY29kZVwiO1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgdHlwZSB7IEdzZENoYW5nZVRyYWNrZXIgfSBmcm9tIFwiLi9jaGFuZ2UtdHJhY2tlci5qc1wiO1xuXG5jb25zdCBHU0RfT1JJR0lOQUxfU0NIRU1FID0gXCJnc2Qtb3JpZ2luYWxcIjtcblxuLyoqXG4gKiBTb3VyY2UgQ29udHJvbCBwcm92aWRlciB0aGF0IHNob3dzIGZpbGVzIG1vZGlmaWVkIGJ5IHRoZSBHU0QgYWdlbnRcbiAqIGluIGEgZGVkaWNhdGVkIFwiR1NEIEFnZW50XCIgc2VjdGlvbiBvZiB0aGUgU291cmNlIENvbnRyb2wgcGFuZWwuXG4gKiBTdXBwb3J0cyBRdWlja0RpZmYgdG8gc2hvdyBiZWZvcmUvYWZ0ZXIgZGlmZnMsIGFuZCBhY2NlcHQvZGlzY2FyZCBwZXItZmlsZS5cbiAqL1xuZXhwb3J0IGNsYXNzIEdzZFNjbVByb3ZpZGVyIGltcGxlbWVudHMgdnNjb2RlLkRpc3Bvc2FibGUge1xuXHRwcml2YXRlIHJlYWRvbmx5IHNjbTogdnNjb2RlLlNvdXJjZUNvbnRyb2w7XG5cdHByaXZhdGUgcmVhZG9ubHkgY2hhbmdlc0dyb3VwOiB2c2NvZGUuU291cmNlQ29udHJvbFJlc291cmNlR3JvdXA7XG5cdHByaXZhdGUgcmVhZG9ubHkgY29udGVudFByb3ZpZGVyOiBHc2RPcmlnaW5hbENvbnRlbnRQcm92aWRlcjtcblx0cHJpdmF0ZSBkaXNwb3NhYmxlczogdnNjb2RlLkRpc3Bvc2FibGVbXSA9IFtdO1xuXG5cdGNvbnN0cnVjdG9yKFxuXHRcdHByaXZhdGUgcmVhZG9ubHkgdHJhY2tlcjogR3NkQ2hhbmdlVHJhY2tlcixcblx0XHRwcml2YXRlIHJlYWRvbmx5IHdvcmtzcGFjZVJvb3Q6IHN0cmluZyxcblx0KSB7XG5cdFx0Ly8gUmVnaXN0ZXIgY29udGVudCBwcm92aWRlciBmb3Igb3JpZ2luYWwgZmlsZSBjb250ZW50c1xuXHRcdHRoaXMuY29udGVudFByb3ZpZGVyID0gbmV3IEdzZE9yaWdpbmFsQ29udGVudFByb3ZpZGVyKHRyYWNrZXIpO1xuXHRcdHRoaXMuZGlzcG9zYWJsZXMucHVzaChcblx0XHRcdHZzY29kZS53b3Jrc3BhY2UucmVnaXN0ZXJUZXh0RG9jdW1lbnRDb250ZW50UHJvdmlkZXIoXG5cdFx0XHRcdEdTRF9PUklHSU5BTF9TQ0hFTUUsXG5cdFx0XHRcdHRoaXMuY29udGVudFByb3ZpZGVyLFxuXHRcdFx0KSxcblx0XHQpO1xuXG5cdFx0Ly8gQ3JlYXRlIHNvdXJjZSBjb250cm9sIGluc3RhbmNlXG5cdFx0dGhpcy5zY20gPSB2c2NvZGUuc2NtLmNyZWF0ZVNvdXJjZUNvbnRyb2woXG5cdFx0XHRcImdzZFwiLFxuXHRcdFx0XCJHU0QgQWdlbnRcIixcblx0XHRcdHZzY29kZS5VcmkuZmlsZSh3b3Jrc3BhY2VSb290KSxcblx0XHQpO1xuXHRcdHRoaXMuc2NtLnF1aWNrRGlmZlByb3ZpZGVyID0ge1xuXHRcdFx0cHJvdmlkZU9yaWdpbmFsUmVzb3VyY2U6ICh1cmk6IHZzY29kZS5VcmkpOiB2c2NvZGUuVXJpIHwgdW5kZWZpbmVkID0+IHtcblx0XHRcdFx0Y29uc3QgZmlsZVBhdGggPSB1cmkuZnNQYXRoO1xuXHRcdFx0XHRpZiAodGhpcy50cmFja2VyLmdldE9yaWdpbmFsKGZpbGVQYXRoKSAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0XHRcdFx0cmV0dXJuIHVyaS53aXRoKHsgc2NoZW1lOiBHU0RfT1JJR0lOQUxfU0NIRU1FIH0pO1xuXHRcdFx0XHR9XG5cdFx0XHRcdHJldHVybiB1bmRlZmluZWQ7XG5cdFx0XHR9LFxuXHRcdH07XG5cdFx0dGhpcy5zY20uaW5wdXRCb3gucGxhY2Vob2xkZXIgPSBcIkRlc2NyaWJlIGNoYW5nZXMgdG8gYWNjZXB0Li4uXCI7XG5cdFx0dGhpcy5zY20uYWNjZXB0SW5wdXRDb21tYW5kID0ge1xuXHRcdFx0Y29tbWFuZDogXCJnc2QuYWNjZXB0QWxsQ2hhbmdlc1wiLFxuXHRcdFx0dGl0bGU6IFwiQWNjZXB0IEFsbFwiLFxuXHRcdH07XG5cdFx0dGhpcy5zY20uY291bnQgPSAwO1xuXHRcdHRoaXMuZGlzcG9zYWJsZXMucHVzaCh0aGlzLnNjbSk7XG5cblx0XHQvLyBDcmVhdGUgcmVzb3VyY2UgZ3JvdXBcblx0XHR0aGlzLmNoYW5nZXNHcm91cCA9IHRoaXMuc2NtLmNyZWF0ZVJlc291cmNlR3JvdXAoXCJjaGFuZ2VzXCIsIFwiQWdlbnQgQ2hhbmdlc1wiKTtcblx0XHR0aGlzLmNoYW5nZXNHcm91cC5oaWRlV2hlbkVtcHR5ID0gdHJ1ZTtcblx0XHR0aGlzLmRpc3Bvc2FibGVzLnB1c2godGhpcy5jaGFuZ2VzR3JvdXApO1xuXG5cdFx0Ly8gTGlzdGVuIGZvciBjaGFuZ2UgdHJhY2tlciB1cGRhdGVzXG5cdFx0dGhpcy5kaXNwb3NhYmxlcy5wdXNoKFxuXHRcdFx0dHJhY2tlci5vbkRpZENoYW5nZSgoKSA9PiB0aGlzLnJlZnJlc2goKSksXG5cdFx0KTtcblxuXHRcdHRoaXMucmVmcmVzaCgpO1xuXHR9XG5cblx0cHJpdmF0ZSByZWZyZXNoKCk6IHZvaWQge1xuXHRcdGNvbnN0IGZpbGVzID0gdGhpcy50cmFja2VyLm1vZGlmaWVkRmlsZXM7XG5cdFx0dGhpcy5jaGFuZ2VzR3JvdXAucmVzb3VyY2VTdGF0ZXMgPSBmaWxlcy5tYXAoKGZpbGVQYXRoKSA9PiB7XG5cdFx0XHRjb25zdCB1cmkgPSB2c2NvZGUuVXJpLmZpbGUoZmlsZVBhdGgpO1xuXHRcdFx0Y29uc3QgZmlsZU5hbWUgPSBwYXRoLmJhc2VuYW1lKGZpbGVQYXRoKTtcblx0XHRcdGNvbnN0IHJlbGF0aXZlUGF0aCA9IHBhdGgucmVsYXRpdmUodGhpcy53b3Jrc3BhY2VSb290LCBmaWxlUGF0aCk7XG5cblx0XHRcdGNvbnN0IHN0YXRlOiB2c2NvZGUuU291cmNlQ29udHJvbFJlc291cmNlU3RhdGUgPSB7XG5cdFx0XHRcdHJlc291cmNlVXJpOiB1cmksXG5cdFx0XHRcdGRlY29yYXRpb25zOiB7XG5cdFx0XHRcdFx0c3RyaWtlVGhyb3VnaDogZmFsc2UsXG5cdFx0XHRcdFx0dG9vbHRpcDogYE1vZGlmaWVkIGJ5IEdTRCBBZ2VudGAsXG5cdFx0XHRcdFx0bGlnaHQ6IHsgaWNvblBhdGg6IG5ldyB2c2NvZGUuVGhlbWVJY29uKFwiZWRpdFwiKSB9LFxuXHRcdFx0XHRcdGRhcms6IHsgaWNvblBhdGg6IG5ldyB2c2NvZGUuVGhlbWVJY29uKFwiZWRpdFwiKSB9LFxuXHRcdFx0XHR9LFxuXHRcdFx0XHRjb21tYW5kOiB7XG5cdFx0XHRcdFx0Y29tbWFuZDogXCJ2c2NvZGUuZGlmZlwiLFxuXHRcdFx0XHRcdHRpdGxlOiBcIlNob3cgQ2hhbmdlc1wiLFxuXHRcdFx0XHRcdGFyZ3VtZW50czogW1xuXHRcdFx0XHRcdFx0dXJpLndpdGgoeyBzY2hlbWU6IEdTRF9PUklHSU5BTF9TQ0hFTUUgfSksXG5cdFx0XHRcdFx0XHR1cmksXG5cdFx0XHRcdFx0XHRgJHtmaWxlTmFtZX0gKEdTRCBBZ2VudCBDaGFuZ2VzKWAsXG5cdFx0XHRcdFx0XSxcblx0XHRcdFx0fSxcblx0XHRcdH07XG5cdFx0XHRyZXR1cm4gc3RhdGU7XG5cdFx0fSk7XG5cdFx0dGhpcy5zY20uY291bnQgPSBmaWxlcy5sZW5ndGg7XG5cdH1cblxuXHRkaXNwb3NlKCk6IHZvaWQge1xuXHRcdGZvciAoY29uc3QgZCBvZiB0aGlzLmRpc3Bvc2FibGVzKSB7XG5cdFx0XHRkLmRpc3Bvc2UoKTtcblx0XHR9XG5cdH1cbn1cblxuLyoqXG4gKiBUZXh0RG9jdW1lbnRDb250ZW50UHJvdmlkZXIgdGhhdCBzZXJ2ZXMgdGhlIG9yaWdpbmFsIChwcmUtYWdlbnQpIGNvbnRlbnRcbiAqIG9mIGZpbGVzIHZpYSB0aGUgYGdzZC1vcmlnaW5hbDpgIFVSSSBzY2hlbWUuXG4gKi9cbmNsYXNzIEdzZE9yaWdpbmFsQ29udGVudFByb3ZpZGVyIGltcGxlbWVudHMgdnNjb2RlLlRleHREb2N1bWVudENvbnRlbnRQcm92aWRlciB7XG5cdHByaXZhdGUgcmVhZG9ubHkgX29uRGlkQ2hhbmdlID0gbmV3IHZzY29kZS5FdmVudEVtaXR0ZXI8dnNjb2RlLlVyaT4oKTtcblx0cmVhZG9ubHkgb25EaWRDaGFuZ2UgPSB0aGlzLl9vbkRpZENoYW5nZS5ldmVudDtcblxuXHRjb25zdHJ1Y3Rvcihwcml2YXRlIHJlYWRvbmx5IHRyYWNrZXI6IEdzZENoYW5nZVRyYWNrZXIpIHtcblx0XHR0cmFja2VyLm9uRGlkQ2hhbmdlKChwYXRocykgPT4ge1xuXHRcdFx0Zm9yIChjb25zdCBwIG9mIHBhdGhzKSB7XG5cdFx0XHRcdHRoaXMuX29uRGlkQ2hhbmdlLmZpcmUodnNjb2RlLlVyaS5maWxlKHApLndpdGgoeyBzY2hlbWU6IEdTRF9PUklHSU5BTF9TQ0hFTUUgfSkpO1xuXHRcdFx0fVxuXHRcdH0pO1xuXHR9XG5cblx0cHJvdmlkZVRleHREb2N1bWVudENvbnRlbnQodXJpOiB2c2NvZGUuVXJpKTogc3RyaW5nIHtcblx0XHRjb25zdCBmaWxlUGF0aCA9IHVyaS53aXRoKHsgc2NoZW1lOiBcImZpbGVcIiB9KS5mc1BhdGg7XG5cdFx0cmV0dXJuIHRoaXMudHJhY2tlci5nZXRPcmlnaW5hbChmaWxlUGF0aCkgPz8gXCJcIjtcblx0fVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsWUFBWSxZQUFZO0FBQ3hCLFlBQVksVUFBVTtBQUd0QixNQUFNLHNCQUFzQjtBQU9yQixNQUFNLGVBQTRDO0FBQUEsRUFNeEQsWUFDa0IsU0FDQSxlQUNoQjtBQUZnQjtBQUNBO0FBR2pCLFNBQUssa0JBQWtCLElBQUksMkJBQTJCLE9BQU87QUFDN0QsU0FBSyxZQUFZO0FBQUEsTUFDaEIsT0FBTyxVQUFVO0FBQUEsUUFDaEI7QUFBQSxRQUNBLEtBQUs7QUFBQSxNQUNOO0FBQUEsSUFDRDtBQUdBLFNBQUssTUFBTSxPQUFPLElBQUk7QUFBQSxNQUNy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
