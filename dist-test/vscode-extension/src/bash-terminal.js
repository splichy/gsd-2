import * as vscode from "vscode";
class GsdBashTerminal {
  terminal;
  writeEmitter;
  disposables = [];
  constructor(client) {
    this.disposables.push(
      client.onEvent((evt) => this.handleEvent(evt)),
      client.onConnectionChange((connected) => {
        if (!connected) {
          this.close();
        }
      })
    );
  }
  getOrCreateTerminal() {
    if (!this.terminal || this.terminal.exitStatus !== void 0) {
      this.writeEmitter?.dispose();
      this.writeEmitter = new vscode.EventEmitter();
      const emitter = this.writeEmitter;
      const pty = {
        onDidWrite: emitter.event,
        open: () => {
        },
        close: () => {
          this.terminal = void 0;
        }
      };
      this.terminal = vscode.window.createTerminal({ name: "GSD Agent", pty });
    }
    return { terminal: this.terminal, writeEmitter: this.writeEmitter };
  }
  handleEvent(evt) {
    switch (evt.type) {
      case "tool_execution_start": {
        if (evt.toolName !== "Bash") {
          break;
        }
        const cmd = evt.toolInput?.command;
        const { terminal, writeEmitter } = this.getOrCreateTerminal();
        terminal.show(true);
        writeEmitter.fire(`\x1B[90m$ ${cmd ?? ""}\x1B[0m\r
`);
        break;
      }
      case "tool_execution_update": {
        if (evt.toolName !== "Bash" || !this.writeEmitter) {
          break;
        }
        const partial = evt.partialResult;
        if (partial) {
          this.writeEmitter.fire(partial.replace(/\n/g, "\r\n"));
        }
        break;
      }
      case "tool_execution_end": {
        if (evt.toolName !== "Bash" || !this.writeEmitter) {
          break;
        }
        this.writeEmitter.fire("\r\n");
        break;
      }
    }
  }
  close() {
    this.terminal?.dispose();
    this.terminal = void 0;
    this.writeEmitter?.dispose();
    this.writeEmitter = void 0;
  }
  dispose() {
    this.close();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
export {
  GsdBashTerminal
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vdnNjb2RlLWV4dGVuc2lvbi9zcmMvYmFzaC10ZXJtaW5hbC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0ICogYXMgdnNjb2RlIGZyb20gXCJ2c2NvZGVcIjtcbmltcG9ydCB0eXBlIHsgQWdlbnRFdmVudCwgR3NkQ2xpZW50IH0gZnJvbSBcIi4vZ3NkLWNsaWVudC5qc1wiO1xuXG4vKipcbiAqIFJvdXRlcyB0aGUgR1NEIGFnZW50J3MgQmFzaCB0b29sIG91dHB1dCB0byBhIGRlZGljYXRlZCBWUyBDb2RlIHRlcm1pbmFsIHBhbmVsLlxuICogU2hvd3Mgc3RyZWFtaW5nIG91dHB1dCBmcm9tIHRvb2xfZXhlY3V0aW9uX3VwZGF0ZSBldmVudHMgaW4gcmVhbCB0aW1lLlxuICovXG5leHBvcnQgY2xhc3MgR3NkQmFzaFRlcm1pbmFsIGltcGxlbWVudHMgdnNjb2RlLkRpc3Bvc2FibGUge1xuXHRwcml2YXRlIHRlcm1pbmFsOiB2c2NvZGUuVGVybWluYWwgfCB1bmRlZmluZWQ7XG5cdHByaXZhdGUgd3JpdGVFbWl0dGVyOiB2c2NvZGUuRXZlbnRFbWl0dGVyPHN0cmluZz4gfCB1bmRlZmluZWQ7XG5cdHByaXZhdGUgZGlzcG9zYWJsZXM6IHZzY29kZS5EaXNwb3NhYmxlW10gPSBbXTtcblxuXHRjb25zdHJ1Y3RvcihjbGllbnQ6IEdzZENsaWVudCkge1xuXHRcdHRoaXMuZGlzcG9zYWJsZXMucHVzaChcblx0XHRcdGNsaWVudC5vbkV2ZW50KChldnQ6IEFnZW50RXZlbnQpID0+IHRoaXMuaGFuZGxlRXZlbnQoZXZ0KSksXG5cdFx0XHRjbGllbnQub25Db25uZWN0aW9uQ2hhbmdlKChjb25uZWN0ZWQpID0+IHtcblx0XHRcdFx0aWYgKCFjb25uZWN0ZWQpIHtcblx0XHRcdFx0XHR0aGlzLmNsb3NlKCk7XG5cdFx0XHRcdH1cblx0XHRcdH0pLFxuXHRcdCk7XG5cdH1cblxuXHRwcml2YXRlIGdldE9yQ3JlYXRlVGVybWluYWwoKTogeyB0ZXJtaW5hbDogdnNjb2RlLlRlcm1pbmFsOyB3cml0ZUVtaXR0ZXI6IHZzY29kZS5FdmVudEVtaXR0ZXI8c3RyaW5nPiB9IHtcblx0XHRpZiAoIXRoaXMudGVybWluYWwgfHwgdGhpcy50ZXJtaW5hbC5leGl0U3RhdHVzICE9PSB1bmRlZmluZWQpIHtcblx0XHRcdHRoaXMud3JpdGVFbWl0dGVyPy5kaXNwb3NlKCk7XG5cdFx0XHR0aGlzLndyaXRlRW1pdHRlciA9IG5ldyB2c2NvZGUuRXZlbnRFbWl0dGVyPHN0cmluZz4oKTtcblx0XHRcdGNvbnN0IGVtaXR0ZXIgPSB0aGlzLndyaXRlRW1pdHRlcjtcblx0XHRcdGNvbnN0IHB0eTogdnNjb2RlLlBzZXVkb3Rlcm1pbmFsID0ge1xuXHRcdFx0XHRvbkRpZFdyaXRlOiBlbWl0dGVyLmV2ZW50LFxuXHRcdFx0XHRvcGVuOiAoKSA9PiB7fSxcblx0XHRcdFx0Y2xvc2U6ICgpID0+IHsgdGhpcy50ZXJtaW5hbCA9IHVuZGVmaW5lZDsgfSxcblx0XHRcdH07XG5cdFx0XHR0aGlzLnRlcm1pbmFsID0gdnNjb2RlLndpbmRvdy5jcmVhdGVUZXJtaW5hbCh7IG5hbWU6IFwiR1NEIEFnZW50XCIsIHB0eSB9KTtcblx0XHR9XG5cdFx0cmV0dXJuIHsgdGVybWluYWw6IHRoaXMudGVybWluYWwsIHdyaXRlRW1pdHRlcjogdGhpcy53cml0ZUVtaXR0ZXIhIH07XG5cdH1cblxuXHRwcml2YXRlIGhhbmRsZUV2ZW50KGV2dDogQWdlbnRFdmVudCk6IHZvaWQge1xuXHRcdHN3aXRjaCAoZXZ0LnR5cGUpIHtcblx0XHRcdGNhc2UgXCJ0b29sX2V4ZWN1dGlvbl9zdGFydFwiOiB7XG5cdFx0XHRcdGlmIChldnQudG9vbE5hbWUgIT09IFwiQmFzaFwiKSB7XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdH1cblx0XHRcdFx0Y29uc3QgY21kID0gKGV2dC50b29sSW5wdXQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQpPy5jb21tYW5kIGFzIHN0cmluZyB8IHVuZGVmaW5lZDtcblx0XHRcdFx0Y29uc3QgeyB0ZXJtaW5hbCwgd3JpdGVFbWl0dGVyIH0gPSB0aGlzLmdldE9yQ3JlYXRlVGVybWluYWwoKTtcblx0XHRcdFx0dGVybWluYWwuc2hvdyh0cnVlKTsgLy8gcHJlc2VydmUgZWRpdG9yIGZvY3VzXG5cdFx0XHRcdHdyaXRlRW1pdHRlci5maXJlKGBcXHgxYls5MG0kICR7Y21kID8/IFwiXCJ9XFx4MWJbMG1cXHJcXG5gKTtcblx0XHRcdFx0YnJlYWs7XG5cdFx0XHR9XG5cdFx0XHRjYXNlIFwidG9vbF9leGVjdXRpb25fdXBkYXRlXCI6IHtcblx0XHRcdFx0aWYgKGV2dC50b29sTmFtZSAhPT0gXCJCYXNoXCIgfHwgIXRoaXMud3JpdGVFbWl0dGVyKSB7XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdH1cblx0XHRcdFx0Y29uc3QgcGFydGlhbCA9IGV2dC5wYXJ0aWFsUmVzdWx0IGFzIHN0cmluZyB8IHVuZGVmaW5lZDtcblx0XHRcdFx0aWYgKHBhcnRpYWwpIHtcblx0XHRcdFx0XHR0aGlzLndyaXRlRW1pdHRlci5maXJlKHBhcnRpYWwucmVwbGFjZSgvXFxuL2csIFwiXFxyXFxuXCIpKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRicmVhaztcblx0XHRcdH1cblx0XHRcdGNhc2UgXCJ0b29sX2V4ZWN1dGlvbl9lbmRcIjoge1xuXHRcdFx0XHRpZiAoZXZ0LnRvb2xOYW1lICE9PSBcIkJhc2hcIiB8fCAhdGhpcy53cml0ZUVtaXR0ZXIpIHtcblx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0fVxuXHRcdFx0XHR0aGlzLndyaXRlRW1pdHRlci5maXJlKFwiXFxyXFxuXCIpO1xuXHRcdFx0XHRicmVhaztcblx0XHRcdH1cblx0XHR9XG5cdH1cblxuXHRjbG9zZSgpOiB2b2lkIHtcblx0XHR0aGlzLnRlcm1pbmFsPy5kaXNwb3NlKCk7XG5cdFx0dGhpcy50ZXJtaW5hbCA9IHVuZGVmaW5lZDtcblx0XHR0aGlzLndyaXRlRW1pdHRlcj8uZGlzcG9zZSgpO1xuXHRcdHRoaXMud3JpdGVFbWl0dGVyID0gdW5kZWZpbmVkO1xuXHR9XG5cblx0ZGlzcG9zZSgpOiB2b2lkIHtcblx0XHR0aGlzLmNsb3NlKCk7XG5cdFx0Zm9yIChjb25zdCBkIG9mIHRoaXMuZGlzcG9zYWJsZXMpIHtcblx0XHRcdGQuZGlzcG9zZSgpO1xuXHRcdH1cblx0fVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsWUFBWSxZQUFZO0FBT2pCLE1BQU0sZ0JBQTZDO0FBQUEsRUFDakQ7QUFBQSxFQUNBO0FBQUEsRUFDQSxjQUFtQyxDQUFDO0FBQUEsRUFFNUMsWUFBWSxRQUFtQjtBQUM5QixTQUFLLFlBQVk7QUFBQSxNQUNoQixPQUFPLFFBQVEsQ0FBQyxRQUFvQixLQUFLLFlBQVksR0FBRyxDQUFDO0FBQUEsTUFDekQsT0FBTyxtQkFBbUIsQ0FBQyxjQUFjO0FBQ3hDLFlBQUksQ0FBQyxXQUFXO0FBQ2YsZUFBSyxNQUFNO0FBQUEsUUFDWjtBQUFBLE1BQ0QsQ0FBQztBQUFBLElBQ0Y7QUFBQSxFQUNEO0FBQUEsRUFFUSxzQkFBZ0c7QUFDdkcsUUFBSSxDQUFDLEtBQUssWUFBWSxLQUFLLFNBQVMsZUFBZSxRQUFXO0FBQzdELFdBQUssY0FBYyxRQUFRO0FBQzNCLFdBQUssZUFBZSxJQUFJLE9BQU8sYUFBcUI7QUFDcEQsWUFBTSxVQUFVLEtBQUs7QUFDckIsWUFBTSxNQUE2QjtBQUFBLFFBQ2xDLFlBQVksUUFBUTtBQUFBLFFBQ3BCLE1BQU0sTUFBTTtBQUFBLFFBQUM7QUFBQSxRQUNiLE9BQU8sTUFBTTtBQUFFLGVBQUssV0FBVztBQUFBLFFBQVc7QUFBQSxNQUMzQztBQUNBLFdBQUssV0FBVyxPQUFPLE9BQU8sZUFBZSxFQUFFLE1BQU0sYUFBYSxJQUFJLENBQUM7QUFBQSxJQUN4RTtBQUNBLFdBQU8sRUFBRSxVQUFVLEtBQUssVUFBVSxjQUFjLEtBQUssYUFBYztBQUFBLEVBQ3BFO0FBQUEsRUFFUSxZQUFZLEtBQXVCO0FBQzFDLFlBQVEsSUFBSSxNQUFNO0FBQUEsTUFDakIsS0FBSyx3QkFBd0I7QUFDNUIsWUFBSSxJQUFJLGFBQWEsUUFBUTtBQUM1QjtBQUFBLFFBQ0Q7QUFDQSxjQUFNLE1BQU8sSUFBSSxXQUFtRDtBQUNwRSxjQUFNLEVBQUUsVUFBVSxhQUFhLElBQUksS0FBSyxvQkFBb0I7QUFDNUQsaUJBQVMsS0FBSyxJQUFJO0FBQ2xCLHFCQUFhLEtBQUssYUFBYSxPQUFPLEVBQUU7QUFBQSxDQUFhO0FBQ3JEO0FBQUEsTUFDRDtBQUFBLE1BQ0EsS0FBSyx5QkFBeUI7QUFDN0IsWUFBSSxJQUFJLGFBQWEsVUFBVSxDQUFDLEtBQUssY0FBYztBQUNsRDtBQUFBLFFBQ0Q7QUFDQSxjQUFNLFVBQVUsSUFBSTtBQUNwQixZQUFJLFNBQVM7QUFDWixlQUFLLGFBQWEsS0FBSyxRQUFRLFFBQVEsT0FBTyxNQUFNLENBQUM7QUFBQSxRQUN0RDtBQUNBO0FBQUEsTUFDRDtBQUFBLE1BQ0EsS0FBSyxzQkFBc0I7QUFDMUIsWUFBSSxJQUFJLGFBQWEsVUFBVSxDQUFDLEtBQUssY0FBYztBQUNsRDtBQUFBLFFBQ0Q7QUFDQSxhQUFLLGFBQWEsS0FBSyxNQUFNO0FBQzdCO0FBQUEsTUFDRDtBQUFBLElBQ0Q7QUFBQSxFQUNEO0FBQUEsRUFFQSxRQUFjO0FBQ2IsU0FBSyxVQUFVLFFBQVE7QUFDdkIsU0FBSyxXQUFXO0FBQ2hCLFNBQUssY0FBYyxRQUFRO0FBQzNCLFNBQUssZUFBZTtBQUFBLEVBQ3JCO0FBQUEsRUFFQSxVQUFnQjtBQUNmLFNBQUssTUFBTTtBQUNYLGVBQVcsS0FBSyxLQUFLLGFBQWE7QUFDakMsUUFBRSxRQUFRO0FBQUEsSUFDWDtBQUFBLEVBQ0Q7QUFDRDsiLAogICJuYW1lcyI6IFtdCn0K
