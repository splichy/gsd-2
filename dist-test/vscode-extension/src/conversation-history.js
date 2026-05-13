import * as vscode from "vscode";
class GsdConversationHistoryPanel {
  static currentPanel;
  panel;
  client;
  disposables = [];
  static createOrShow(extensionUri, client) {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (GsdConversationHistoryPanel.currentPanel) {
      GsdConversationHistoryPanel.currentPanel.panel.reveal(column);
      void GsdConversationHistoryPanel.currentPanel.refresh();
      return GsdConversationHistoryPanel.currentPanel;
    }
    const panel = vscode.window.createWebviewPanel(
      "gsd-history",
      "GSD Conversation History",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );
    GsdConversationHistoryPanel.currentPanel = new GsdConversationHistoryPanel(
      panel,
      extensionUri,
      client
    );
    void GsdConversationHistoryPanel.currentPanel.refresh();
    return GsdConversationHistoryPanel.currentPanel;
  }
  constructor(panel, _extensionUri, client) {
    this.panel = panel;
    this.client = client;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      async (msg) => {
        if (msg.command === "refresh") {
          await this.refresh();
        } else if (msg.command === "fork" && msg.entryId) {
          try {
            const result = await this.client.forkSession(msg.entryId);
            if (!result.cancelled) {
              vscode.window.showInformationMessage("Session forked successfully.");
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Fork failed: ${errMsg}`);
          }
        }
      },
      null,
      this.disposables
    );
  }
  async refresh() {
    if (!this.client.isConnected) {
      this.panel.webview.html = this.getHtml([], "Not connected to GSD agent.");
      return;
    }
    try {
      const raw = await this.client.getMessages();
      this.panel.webview.html = this.getHtml(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.panel.webview.html = this.getHtml([], `Error loading messages: ${msg}`);
    }
  }
  dispose() {
    GsdConversationHistoryPanel.currentPanel = void 0;
    this.panel.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
  getHtml(messages, errorMessage) {
    const nonce = getNonce();
    const visibleMessages = messages.filter((m) => m.role === "user" || m.role === "assistant");
    const renderedMessages = visibleMessages.map((msg, idx) => {
      const isUser = msg.role === "user";
      const blocks = renderContentBlocks(msg.content);
      if (!blocks.trim()) return "";
      const entryId = `msg-${idx}`;
      const forkBtn = `<button class="fork-btn" data-entry-id="${entryId}" title="Fork from this message">Fork</button>`;
      return `<div class="message ${isUser ? "user" : "assistant"}" id="${entryId}">
				<div class="role-row">
					<span class="role">${isUser ? "You" : "GSD"}</span>
					${forkBtn}
				</div>
				<div class="content">${blocks}</div>
			</div>`;
    }).filter(Boolean).join("\n");
    return (
      /* html */
      `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<style>
		body {
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			color: var(--vscode-foreground);
			padding: 16px;
			margin: 0;
		}
		h2 {
			margin: 0 0 12px;
			font-size: 15px;
			font-weight: 600;
		}
		.toolbar {
			display: flex;
			align-items: center;
			gap: 8px;
			margin-bottom: 16px;
		}
		.search-input {
			flex: 1;
			padding: 5px 10px;
			border: 1px solid var(--vscode-input-border);
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border-radius: 2px;
			font-size: var(--vscode-font-size);
		}
		.btn {
			padding: 5px 12px;
			border: none;
			border-radius: 2px;
			cursor: pointer;
			font-size: var(--vscode-font-size);
			color: var(--vscode-button-foreground);
			background: var(--vscode-button-background);
			white-space: nowrap;
		}
		.btn:hover { background: var(--vscode-button-hoverBackground); }
		.count {
			font-size: 12px;
			opacity: 0.6;
			white-space: nowrap;
		}
		.error {
			color: var(--vscode-errorForeground);
			padding: 10px 12px;
			background: var(--vscode-inputValidation-errorBackground);
			border-radius: 4px;
			margin-bottom: 12px;
		}
		.empty {
			opacity: 0.55;
			font-style: italic;
		}
		.message {
			margin-bottom: 14px;
			border-radius: 5px;
			overflow: hidden;
			border: 1px solid var(--vscode-panel-border);
		}
		.message.hidden {
			display: none;
		}
		.role-row {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 3px 10px;
			background: var(--vscode-panel-border);
		}
		.message.assistant .role-row {
			background: var(--vscode-focusBorder);
		}
		.role {
			font-size: 10px;
			font-weight: 700;
			text-transform: uppercase;
			letter-spacing: 0.6px;
			opacity: 0.85;
		}
		.message.assistant .role {
			color: var(--vscode-button-foreground);
			opacity: 1;
		}
		.fork-btn {
			padding: 1px 6px;
			font-size: 10px;
			border: 1px solid var(--vscode-foreground);
			background: transparent;
			color: var(--vscode-foreground);
			border-radius: 3px;
			cursor: pointer;
			opacity: 0;
			transition: opacity 0.15s;
		}
		.message:hover .fork-btn {
			opacity: 0.6;
		}
		.fork-btn:hover {
			opacity: 1 !important;
			background: var(--vscode-button-secondaryBackground);
		}
		.content {
			padding: 10px 12px;
			white-space: pre-wrap;
			word-break: break-word;
			line-height: 1.55;
		}
		.tool-block {
			margin: 8px 0;
			padding: 6px 10px;
			background: var(--vscode-editor-background);
			border: 1px solid var(--vscode-panel-border);
			border-radius: 4px;
			font-size: 12px;
		}
		.tool-header {
			display: flex;
			align-items: center;
			gap: 6px;
			cursor: pointer;
			user-select: none;
			font-weight: 600;
			opacity: 0.8;
		}
		.tool-header:hover {
			opacity: 1;
		}
		.tool-body {
			display: none;
			margin-top: 6px;
			padding-top: 6px;
			border-top: 1px solid var(--vscode-panel-border);
			white-space: pre-wrap;
			word-break: break-all;
			max-height: 200px;
			overflow-y: auto;
			opacity: 0.75;
		}
		.tool-block.expanded .tool-body {
			display: block;
		}
		.thinking-block {
			margin: 8px 0;
			padding: 6px 10px;
			background: var(--vscode-editor-background);
			border-left: 3px solid var(--vscode-focusBorder);
			border-radius: 2px;
			font-size: 12px;
			opacity: 0.65;
			font-style: italic;
		}
		.thinking-header {
			cursor: pointer;
			user-select: none;
			font-weight: 600;
		}
		.thinking-body {
			display: none;
			margin-top: 4px;
			white-space: pre-wrap;
			max-height: 300px;
			overflow-y: auto;
		}
		.thinking-block.expanded .thinking-body {
			display: block;
		}
		code {
			background: var(--vscode-editor-background);
			padding: 1px 4px;
			border-radius: 3px;
			font-family: var(--vscode-editor-font-family);
			font-size: 0.92em;
		}
	</style>
</head>
<body>
	<h2>Conversation History</h2>
	<div class="toolbar">
		<input type="text" class="search-input" id="search" placeholder="Search messages..." />
		<button class="btn" id="refresh">Refresh</button>
		${visibleMessages.length > 0 ? `<span class="count">${visibleMessages.length} message${visibleMessages.length === 1 ? "" : "s"}</span>` : ""}
	</div>
	${errorMessage ? `<div class="error">${escapeHtml(errorMessage)}</div>` : ""}
	<div id="messages">
		${!errorMessage && renderedMessages === "" ? '<div class="empty">No messages in this session.</div>' : renderedMessages}
	</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();

		document.getElementById('refresh').addEventListener('click', () => {
			vscode.postMessage({ command: 'refresh' });
		});

		// Search filter
		document.getElementById('search').addEventListener('input', (e) => {
			const query = e.target.value.toLowerCase();
			document.querySelectorAll('.message').forEach((el) => {
				const text = el.textContent.toLowerCase();
				el.classList.toggle('hidden', query && !text.includes(query));
			});
		});

		// Toggle tool/thinking blocks
		document.addEventListener('click', (e) => {
			const header = e.target.closest('.tool-header, .thinking-header');
			if (header) {
				header.parentElement.classList.toggle('expanded');
				return;
			}
			const forkBtn = e.target.closest('.fork-btn');
			if (forkBtn) {
				vscode.postMessage({ command: 'fork', entryId: forkBtn.dataset.entryId });
			}
		});
	</script>
</body>
</html>`
    );
  }
}
function renderContentBlocks(content) {
  if (typeof content === "string") return escapeHtml(content);
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (typeof block === "string") return escapeHtml(block);
    switch (block.type) {
      case "text":
        return escapeHtml(block.text ?? "");
      case "thinking":
        if (!block.text) return "";
        return `<div class="thinking-block">
						<div class="thinking-header">Thinking...</div>
						<div class="thinking-body">${escapeHtml(block.text)}</div>
					</div>`;
      case "tool_use":
        return `<div class="tool-block">
						<div class="tool-header">Tool: ${escapeHtml(block.name ?? "unknown")}</div>
						<div class="tool-body">${escapeHtml(JSON.stringify(block.input ?? {}, null, 2))}</div>
					</div>`;
      case "tool_result": {
        const resultText = typeof block.content === "string" ? block.content : Array.isArray(block.content) ? block.content.map((b) => typeof b === "string" ? b : b?.text ?? "").join("") : "";
        if (!resultText) return "";
        const truncated = resultText.length > 500 ? resultText.slice(0, 500) + "..." : resultText;
        return `<div class="tool-block">
						<div class="tool-header">Tool Result</div>
						<div class="tool-body">${escapeHtml(truncated)}</div>
					</div>`;
      }
      default:
        return "";
    }
  }).join("");
}
function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function getNonce() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
export {
  GsdConversationHistoryPanel
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vdnNjb2RlLWV4dGVuc2lvbi9zcmMvY29udmVyc2F0aW9uLWhpc3RvcnkudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCAqIGFzIHZzY29kZSBmcm9tIFwidnNjb2RlXCI7XG5pbXBvcnQgdHlwZSB7IEdzZENsaWVudCB9IGZyb20gXCIuL2dzZC1jbGllbnQuanNcIjtcblxuaW50ZXJmYWNlIENvbnRlbnRCbG9jayB7XG5cdHR5cGU6IHN0cmluZztcblx0dGV4dD86IHN0cmluZztcblx0bmFtZT86IHN0cmluZztcblx0aW5wdXQ/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcblx0Y29udGVudD86IHN0cmluZyB8IENvbnRlbnRCbG9ja1tdO1xuXHRba2V5OiBzdHJpbmddOiB1bmtub3duO1xufVxuXG5pbnRlcmZhY2UgQ29udmVyc2F0aW9uTWVzc2FnZSB7XG5cdHJvbGU6IFwidXNlclwiIHwgXCJhc3Npc3RhbnRcIiB8IFwic3lzdGVtXCI7XG5cdGNvbnRlbnQ6IHN0cmluZyB8IENvbnRlbnRCbG9ja1tdO1xufVxuXG4vKipcbiAqIFdlYnZpZXcgcGFuZWwgdGhhdCBkaXNwbGF5cyB0aGUgZnVsbCBjb252ZXJzYXRpb24gaGlzdG9yeSBmb3IgdGhlXG4gKiBjdXJyZW50IEdTRCBzZXNzaW9uIHVzaW5nIHRoZSBnZXRfbWVzc2FnZXMgUlBDIGNhbGwuIFNob3dzIHRvb2wgY2FsbHMsXG4gKiB0aGlua2luZyBibG9ja3MsIHNlYXJjaC9maWx0ZXIsIGFuZCBmb3JrLWZyb20taGVyZSBhY3Rpb25zLlxuICovXG5leHBvcnQgY2xhc3MgR3NkQ29udmVyc2F0aW9uSGlzdG9yeVBhbmVsIGltcGxlbWVudHMgdnNjb2RlLkRpc3Bvc2FibGUge1xuXHRwcml2YXRlIHN0YXRpYyBjdXJyZW50UGFuZWw6IEdzZENvbnZlcnNhdGlvbkhpc3RvcnlQYW5lbCB8IHVuZGVmaW5lZDtcblxuXHRwcml2YXRlIHJlYWRvbmx5IHBhbmVsOiB2c2NvZGUuV2Vidmlld1BhbmVsO1xuXHRwcml2YXRlIHJlYWRvbmx5IGNsaWVudDogR3NkQ2xpZW50O1xuXHRwcml2YXRlIGRpc3Bvc2FibGVzOiB2c2NvZGUuRGlzcG9zYWJsZVtdID0gW107XG5cblx0c3RhdGljIGNyZWF0ZU9yU2hvdyhcblx0XHRleHRlbnNpb25Vcmk6IHZzY29kZS5VcmksXG5cdFx0Y2xpZW50OiBHc2RDbGllbnQsXG5cdCk6IEdzZENvbnZlcnNhdGlvbkhpc3RvcnlQYW5lbCB7XG5cdFx0Y29uc3QgY29sdW1uID0gdnNjb2RlLndpbmRvdy5hY3RpdmVUZXh0RWRpdG9yPy52aWV3Q29sdW1uID8/IHZzY29kZS5WaWV3Q29sdW1uLk9uZTtcblxuXHRcdGlmIChHc2RDb252ZXJzYXRpb25IaXN0b3J5UGFuZWwuY3VycmVudFBhbmVsKSB7XG5cdFx0XHRHc2RDb252ZXJzYXRpb25IaXN0b3J5UGFuZWwuY3VycmVudFBhbmVsLnBhbmVsLnJldmVhbChjb2x1bW4pO1xuXHRcdFx0dm9pZCBHc2RDb252ZXJzYXRpb25IaXN0b3J5UGFuZWwuY3VycmVudFBhbmVsLnJlZnJlc2goKTtcblx0XHRcdHJldHVybiBHc2RDb252ZXJzYXRpb25IaXN0b3J5UGFuZWwuY3VycmVudFBhbmVsO1xuXHRcdH1cblxuXHRcdGNvbnN0IHBhbmVsID0gdnNjb2RlLndpbmRvdy5jcmVhdGVXZWJ2aWV3UGFuZWwoXG5cdFx0XHRcImdzZC1oaXN0b3J5XCIsXG5cdFx0XHRcIkdTRCBDb252ZXJzYXRpb24gSGlzdG9yeVwiLFxuXHRcdFx0Y29sdW1uLFxuXHRcdFx0e1xuXHRcdFx0XHRlbmFibGVTY3JpcHRzOiB0cnVlLFxuXHRcdFx0XHRyZXRhaW5Db250ZXh0V2hlbkhpZGRlbjogdHJ1ZSxcblx0XHRcdH0sXG5cdFx0KTtcblxuXHRcdEdzZENvbnZlcnNhdGlvbkhpc3RvcnlQYW5lbC5jdXJyZW50UGFuZWwgPSBuZXcgR3NkQ29udmVyc2F0aW9uSGlzdG9yeVBhbmVsKFxuXHRcdFx0cGFuZWwsXG5cdFx0XHRleHRlbnNpb25VcmksXG5cdFx0XHRjbGllbnQsXG5cdFx0KTtcblx0XHR2b2lkIEdzZENvbnZlcnNhdGlvbkhpc3RvcnlQYW5lbC5jdXJyZW50UGFuZWwucmVmcmVzaCgpO1xuXHRcdHJldHVybiBHc2RDb252ZXJzYXRpb25IaXN0b3J5UGFuZWwuY3VycmVudFBhbmVsO1xuXHR9XG5cblx0cHJpdmF0ZSBjb25zdHJ1Y3Rvcihcblx0XHRwYW5lbDogdnNjb2RlLldlYnZpZXdQYW5lbCxcblx0XHRfZXh0ZW5zaW9uVXJpOiB2c2NvZGUuVXJpLFxuXHRcdGNsaWVudDogR3NkQ2xpZW50LFxuXHQpIHtcblx0XHR0aGlzLnBhbmVsID0gcGFuZWw7XG5cdFx0dGhpcy5jbGllbnQgPSBjbGllbnQ7XG5cblx0XHR0aGlzLnBhbmVsLm9uRGlkRGlzcG9zZSgoKSA9PiB0aGlzLmRpc3Bvc2UoKSwgbnVsbCwgdGhpcy5kaXNwb3NhYmxlcyk7XG5cblx0XHR0aGlzLnBhbmVsLndlYnZpZXcub25EaWRSZWNlaXZlTWVzc2FnZShcblx0XHRcdGFzeW5jIChtc2c6IHsgY29tbWFuZDogc3RyaW5nOyBlbnRyeUlkPzogc3RyaW5nIH0pID0+IHtcblx0XHRcdFx0aWYgKG1zZy5jb21tYW5kID09PSBcInJlZnJlc2hcIikge1xuXHRcdFx0XHRcdGF3YWl0IHRoaXMucmVmcmVzaCgpO1xuXHRcdFx0XHR9IGVsc2UgaWYgKG1zZy5jb21tYW5kID09PSBcImZvcmtcIiAmJiBtc2cuZW50cnlJZCkge1xuXHRcdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCB0aGlzLmNsaWVudC5mb3JrU2Vzc2lvbihtc2cuZW50cnlJZCk7XG5cdFx0XHRcdFx0XHRpZiAoIXJlc3VsdC5jYW5jZWxsZWQpIHtcblx0XHRcdFx0XHRcdFx0dnNjb2RlLndpbmRvdy5zaG93SW5mb3JtYXRpb25NZXNzYWdlKFwiU2Vzc2lvbiBmb3JrZWQgc3VjY2Vzc2Z1bGx5LlwiKTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdFx0XHRcdGNvbnN0IGVyck1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcblx0XHRcdFx0XHRcdHZzY29kZS53aW5kb3cuc2hvd0Vycm9yTWVzc2FnZShgRm9yayBmYWlsZWQ6ICR7ZXJyTXNnfWApO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXHRcdFx0fSxcblx0XHRcdG51bGwsXG5cdFx0XHR0aGlzLmRpc3Bvc2FibGVzLFxuXHRcdCk7XG5cdH1cblxuXHRhc3luYyByZWZyZXNoKCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGlmICghdGhpcy5jbGllbnQuaXNDb25uZWN0ZWQpIHtcblx0XHRcdHRoaXMucGFuZWwud2Vidmlldy5odG1sID0gdGhpcy5nZXRIdG1sKFtdLCBcIk5vdCBjb25uZWN0ZWQgdG8gR1NEIGFnZW50LlwiKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHR0cnkge1xuXHRcdFx0Y29uc3QgcmF3ID0gYXdhaXQgdGhpcy5jbGllbnQuZ2V0TWVzc2FnZXMoKTtcblx0XHRcdHRoaXMucGFuZWwud2Vidmlldy5odG1sID0gdGhpcy5nZXRIdG1sKHJhdyBhcyBDb252ZXJzYXRpb25NZXNzYWdlW10pO1xuXHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0Y29uc3QgbXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuXHRcdFx0dGhpcy5wYW5lbC53ZWJ2aWV3Lmh0bWwgPSB0aGlzLmdldEh0bWwoW10sIGBFcnJvciBsb2FkaW5nIG1lc3NhZ2VzOiAke21zZ31gKTtcblx0XHR9XG5cdH1cblxuXHRkaXNwb3NlKCk6IHZvaWQge1xuXHRcdEdzZENvbnZlcnNhdGlvbkhpc3RvcnlQYW5lbC5jdXJyZW50UGFuZWwgPSB1bmRlZmluZWQ7XG5cdFx0dGhpcy5wYW5lbC5kaXNwb3NlKCk7XG5cdFx0Zm9yIChjb25zdCBkIG9mIHRoaXMuZGlzcG9zYWJsZXMpIHtcblx0XHRcdGQuZGlzcG9zZSgpO1xuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgZ2V0SHRtbChtZXNzYWdlczogQ29udmVyc2F0aW9uTWVzc2FnZVtdLCBlcnJvck1lc3NhZ2U/OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRcdGNvbnN0IG5vbmNlID0gZ2V0Tm9uY2UoKTtcblx0XHRjb25zdCB2aXNpYmxlTWVzc2FnZXMgPSBtZXNzYWdlcy5maWx0ZXIoKG0pID0+IG0ucm9sZSA9PT0gXCJ1c2VyXCIgfHwgbS5yb2xlID09PSBcImFzc2lzdGFudFwiKTtcblxuXHRcdGNvbnN0IHJlbmRlcmVkTWVzc2FnZXMgPSB2aXNpYmxlTWVzc2FnZXNcblx0XHRcdC5tYXAoKG1zZywgaWR4KSA9PiB7XG5cdFx0XHRcdGNvbnN0IGlzVXNlciA9IG1zZy5yb2xlID09PSBcInVzZXJcIjtcblx0XHRcdFx0Y29uc3QgYmxvY2tzID0gcmVuZGVyQ29udGVudEJsb2Nrcyhtc2cuY29udGVudCk7XG5cdFx0XHRcdGlmICghYmxvY2tzLnRyaW0oKSkgcmV0dXJuIFwiXCI7XG5cblx0XHRcdFx0Y29uc3QgZW50cnlJZCA9IGBtc2ctJHtpZHh9YDtcblx0XHRcdFx0Y29uc3QgZm9ya0J0biA9IGA8YnV0dG9uIGNsYXNzPVwiZm9yay1idG5cIiBkYXRhLWVudHJ5LWlkPVwiJHtlbnRyeUlkfVwiIHRpdGxlPVwiRm9yayBmcm9tIHRoaXMgbWVzc2FnZVwiPkZvcms8L2J1dHRvbj5gO1xuXG5cdFx0XHRcdHJldHVybiBgPGRpdiBjbGFzcz1cIm1lc3NhZ2UgJHtpc1VzZXIgPyBcInVzZXJcIiA6IFwiYXNzaXN0YW50XCJ9XCIgaWQ9XCIke2VudHJ5SWR9XCI+XG5cdFx0XHRcdDxkaXYgY2xhc3M9XCJyb2xlLXJvd1wiPlxuXHRcdFx0XHRcdDxzcGFuIGNsYXNzPVwicm9sZVwiPiR7aXNVc2VyID8gXCJZb3VcIiA6IFwiR1NEXCJ9PC9zcGFuPlxuXHRcdFx0XHRcdCR7Zm9ya0J0bn1cblx0XHRcdFx0PC9kaXY+XG5cdFx0XHRcdDxkaXYgY2xhc3M9XCJjb250ZW50XCI+JHtibG9ja3N9PC9kaXY+XG5cdFx0XHQ8L2Rpdj5gO1xuXHRcdFx0fSlcblx0XHRcdC5maWx0ZXIoQm9vbGVhbilcblx0XHRcdC5qb2luKFwiXFxuXCIpO1xuXG5cdFx0cmV0dXJuIC8qIGh0bWwgKi8gYDwhRE9DVFlQRSBodG1sPlxuPGh0bWwgbGFuZz1cImVuXCI+XG48aGVhZD5cblx0PG1ldGEgY2hhcnNldD1cIlVURi04XCI+XG5cdDxtZXRhIG5hbWU9XCJ2aWV3cG9ydFwiIGNvbnRlbnQ9XCJ3aWR0aD1kZXZpY2Utd2lkdGgsIGluaXRpYWwtc2NhbGU9MS4wXCI+XG5cdDxtZXRhIGh0dHAtZXF1aXY9XCJDb250ZW50LVNlY3VyaXR5LVBvbGljeVwiIGNvbnRlbnQ9XCJkZWZhdWx0LXNyYyAnbm9uZSc7IHN0eWxlLXNyYyAndW5zYWZlLWlubGluZSc7IHNjcmlwdC1zcmMgJ25vbmNlLSR7bm9uY2V9JztcIj5cblx0PHN0eWxlPlxuXHRcdGJvZHkge1xuXHRcdFx0Zm9udC1mYW1pbHk6IHZhcigtLXZzY29kZS1mb250LWZhbWlseSk7XG5cdFx0XHRmb250LXNpemU6IHZhcigtLXZzY29kZS1mb250LXNpemUpO1xuXHRcdFx0Y29sb3I6IHZhcigtLXZzY29kZS1mb3JlZ3JvdW5kKTtcblx0XHRcdHBhZGRpbmc6IDE2cHg7XG5cdFx0XHRtYXJnaW46IDA7XG5cdFx0fVxuXHRcdGgyIHtcblx0XHRcdG1hcmdpbjogMCAwIDEycHg7XG5cdFx0XHRmb250LXNpemU6IDE1cHg7XG5cdFx0XHRmb250LXdlaWdodDogNjAwO1xuXHRcdH1cblx0XHQudG9vbGJhciB7XG5cdFx0XHRkaXNwbGF5OiBmbGV4O1xuXHRcdFx0YWxpZ24taXRlbXM6IGNlbnRlcjtcblx0XHRcdGdhcDogOHB4O1xuXHRcdFx0bWFyZ2luLWJvdHRvbTogMTZweDtcblx0XHR9XG5cdFx0LnNlYXJjaC1pbnB1dCB7XG5cdFx0XHRmbGV4OiAxO1xuXHRcdFx0cGFkZGluZzogNXB4IDEwcHg7XG5cdFx0XHRib3JkZXI6IDFweCBzb2xpZCB2YXIoLS12c2NvZGUtaW5wdXQtYm9yZGVyKTtcblx0XHRcdGJhY2tncm91bmQ6IHZhcigtLXZzY29kZS1pbnB1dC1iYWNrZ3JvdW5kKTtcblx0XHRcdGNvbG9yOiB2YXIoLS12c2NvZGUtaW5wdXQtZm9yZWdyb3VuZCk7XG5cdFx0XHRib3JkZXItcmFkaXVzOiAycHg7XG5cdFx0XHRmb250LXNpemU6IHZhcigtLXZzY29kZS1mb250LXNpemUpO1xuXHRcdH1cblx0XHQuYnRuIHtcblx0XHRcdHBhZGRpbmc6IDVweCAxMnB4O1xuXHRcdFx0Ym9yZGVyOiBub25lO1xuXHRcdFx0Ym9yZGVyLXJhZGl1czogMnB4O1xuXHRcdFx0Y3Vyc29yOiBwb2ludGVyO1xuXHRcdFx0Zm9udC1zaXplOiB2YXIoLS12c2NvZGUtZm9udC1zaXplKTtcblx0XHRcdGNvbG9yOiB2YXIoLS12c2NvZGUtYnV0dG9uLWZvcmVncm91bmQpO1xuXHRcdFx0YmFja2dyb3VuZDogdmFyKC0tdnNjb2RlLWJ1dHRvbi1iYWNrZ3JvdW5kKTtcblx0XHRcdHdoaXRlLXNwYWNlOiBub3dyYXA7XG5cdFx0fVxuXHRcdC5idG46aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS12c2NvZGUtYnV0dG9uLWhvdmVyQmFja2dyb3VuZCk7IH1cblx0XHQuY291bnQge1xuXHRcdFx0Zm9udC1zaXplOiAxMnB4O1xuXHRcdFx0b3BhY2l0eTogMC42O1xuXHRcdFx0d2hpdGUtc3BhY2U6IG5vd3JhcDtcblx0XHR9XG5cdFx0LmVycm9yIHtcblx0XHRcdGNvbG9yOiB2YXIoLS12c2NvZGUtZXJyb3JGb3JlZ3JvdW5kKTtcblx0XHRcdHBhZGRpbmc6IDEwcHggMTJweDtcblx0XHRcdGJhY2tncm91bmQ6IHZhcigtLXZzY29kZS1pbnB1dFZhbGlkYXRpb24tZXJyb3JCYWNrZ3JvdW5kKTtcblx0XHRcdGJvcmRlci1yYWRpdXM6IDRweDtcblx0XHRcdG1hcmdpbi1ib3R0b206IDEycHg7XG5cdFx0fVxuXHRcdC5lbXB0eSB7XG5cdFx0XHRvcGFjaXR5OiAwLjU1O1xuXHRcdFx0Zm9udC1zdHlsZTogaXRhbGljO1xuXHRcdH1cblx0XHQubWVzc2FnZSB7XG5cdFx0XHRtYXJnaW4tYm90dG9tOiAxNHB4O1xuXHRcdFx0Ym9yZGVyLXJhZGl1czogNXB4O1xuXHRcdFx0b3ZlcmZsb3c6IGhpZGRlbjtcblx0XHRcdGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLXZzY29kZS1wYW5lbC1ib3JkZXIpO1xuXHRcdH1cblx0XHQubWVzc2FnZS5oaWRkZW4ge1xuXHRcdFx0ZGlzcGxheTogbm9uZTtcblx0XHR9XG5cdFx0LnJvbGUtcm93IHtcblx0XHRcdGRpc3BsYXk6IGZsZXg7XG5cdFx0XHRhbGlnbi1pdGVtczogY2VudGVyO1xuXHRcdFx0anVzdGlmeS1jb250ZW50OiBzcGFjZS1iZXR3ZWVuO1xuXHRcdFx0cGFkZGluZzogM3B4IDEwcHg7XG5cdFx0XHRiYWNrZ3JvdW5kOiB2YXIoLS12c2NvZGUtcGFuZWwtYm9yZGVyKTtcblx0XHR9XG5cdFx0Lm1lc3NhZ2UuYXNzaXN0YW50IC5yb2xlLXJvdyB7XG5cdFx0XHRiYWNrZ3JvdW5kOiB2YXIoLS12c2NvZGUtZm9jdXNCb3JkZXIpO1xuXHRcdH1cblx0XHQucm9sZSB7XG5cdFx0XHRmb250LXNpemU6IDEwcHg7XG5cdFx0XHRmb250LXdlaWdodDogNzAwO1xuXHRcdFx0dGV4dC10cmFuc2Zvcm06IHVwcGVyY2FzZTtcblx0XHRcdGxldHRlci1zcGFjaW5nOiAwLjZweDtcblx0XHRcdG9wYWNpdHk6IDAuODU7XG5cdFx0fVxuXHRcdC5tZXNzYWdlLmFzc2lzdGFudCAucm9sZSB7XG5cdFx0XHRjb2xvcjogdmFyKC0tdnNjb2RlLWJ1dHRvbi1mb3JlZ3JvdW5kKTtcblx0XHRcdG9wYWNpdHk6IDE7XG5cdFx0fVxuXHRcdC5mb3JrLWJ0biB7XG5cdFx0XHRwYWRkaW5nOiAxcHggNnB4O1xuXHRcdFx0Zm9udC1zaXplOiAxMHB4O1xuXHRcdFx0Ym9yZGVyOiAxcHggc29saWQgdmFyKC0tdnNjb2RlLWZvcmVncm91bmQpO1xuXHRcdFx0YmFja2dyb3VuZDogdHJhbnNwYXJlbnQ7XG5cdFx0XHRjb2xvcjogdmFyKC0tdnNjb2RlLWZvcmVncm91bmQpO1xuXHRcdFx0Ym9yZGVyLXJhZGl1czogM3B4O1xuXHRcdFx0Y3Vyc29yOiBwb2ludGVyO1xuXHRcdFx0b3BhY2l0eTogMDtcblx0XHRcdHRyYW5zaXRpb246IG9wYWNpdHkgMC4xNXM7XG5cdFx0fVxuXHRcdC5tZXNzYWdlOmhvdmVyIC5mb3JrLWJ0biB7XG5cdFx0XHRvcGFjaXR5OiAwLjY7XG5cdFx0fVxuXHRcdC5mb3JrLWJ0bjpob3ZlciB7XG5cdFx0XHRvcGFjaXR5OiAxICFpbXBvcnRhbnQ7XG5cdFx0XHRiYWNrZ3JvdW5kOiB2YXIoLS12c2NvZGUtYnV0dG9uLXNlY29uZGFyeUJhY2tncm91bmQpO1xuXHRcdH1cblx0XHQuY29udGVudCB7XG5cdFx0XHRwYWRkaW5nOiAxMHB4IDEycHg7XG5cdFx0XHR3aGl0ZS1zcGFjZTogcHJlLXdyYXA7XG5cdFx0XHR3b3JkLWJyZWFrOiBicmVhay13b3JkO1xuXHRcdFx0bGluZS1oZWlnaHQ6IDEuNTU7XG5cdFx0fVxuXHRcdC50b29sLWJsb2NrIHtcblx0XHRcdG1hcmdpbjogOHB4IDA7XG5cdFx0XHRwYWRkaW5nOiA2cHggMTBweDtcblx0XHRcdGJhY2tncm91bmQ6IHZhcigtLXZzY29kZS1lZGl0b3ItYmFja2dyb3VuZCk7XG5cdFx0XHRib3JkZXI6IDFweCBzb2xpZCB2YXIoLS12c2NvZGUtcGFuZWwtYm9yZGVyKTtcblx0XHRcdGJvcmRlci1yYWRpdXM6IDRweDtcblx0XHRcdGZvbnQtc2l6ZTogMTJweDtcblx0XHR9XG5cdFx0LnRvb2wtaGVhZGVyIHtcblx0XHRcdGRpc3BsYXk6IGZsZXg7XG5cdFx0XHRhbGlnbi1pdGVtczogY2VudGVyO1xuXHRcdFx0Z2FwOiA2cHg7XG5cdFx0XHRjdXJzb3I6IHBvaW50ZXI7XG5cdFx0XHR1c2VyLXNlbGVjdDogbm9uZTtcblx0XHRcdGZvbnQtd2VpZ2h0OiA2MDA7XG5cdFx0XHRvcGFjaXR5OiAwLjg7XG5cdFx0fVxuXHRcdC50b29sLWhlYWRlcjpob3ZlciB7XG5cdFx0XHRvcGFjaXR5OiAxO1xuXHRcdH1cblx0XHQudG9vbC1ib2R5IHtcblx0XHRcdGRpc3BsYXk6IG5vbmU7XG5cdFx0XHRtYXJnaW4tdG9wOiA2cHg7XG5cdFx0XHRwYWRkaW5nLXRvcDogNnB4O1xuXHRcdFx0Ym9yZGVyLXRvcDogMXB4IHNvbGlkIHZhcigtLXZzY29kZS1wYW5lbC1ib3JkZXIpO1xuXHRcdFx0d2hpdGUtc3BhY2U6IHByZS13cmFwO1xuXHRcdFx0d29yZC1icmVhazogYnJlYWstYWxsO1xuXHRcdFx0bWF4LWhlaWdodDogMjAwcHg7XG5cdFx0XHRvdmVyZmxvdy15OiBhdXRvO1xuXHRcdFx0b3BhY2l0eTogMC43NTtcblx0XHR9XG5cdFx0LnRvb2wtYmxvY2suZXhwYW5kZWQgLnRvb2wtYm9keSB7XG5cdFx0XHRkaXNwbGF5OiBibG9jaztcblx0XHR9XG5cdFx0LnRoaW5raW5nLWJsb2NrIHtcblx0XHRcdG1hcmdpbjogOHB4IDA7XG5cdFx0XHRwYWRkaW5nOiA2cHggMTBweDtcblx0XHRcdGJhY2tncm91bmQ6IHZhcigtLXZzY29kZS1lZGl0b3ItYmFja2dyb3VuZCk7XG5cdFx0XHRib3JkZXItbGVmdDogM3B4IHNvbGlkIHZhcigtLXZzY29kZS1mb2N1c0JvcmRlcik7XG5cdFx0XHRib3JkZXItcmFkaXVzOiAycHg7XG5cdFx0XHRmb250LXNpemU6IDEycHg7XG5cdFx0XHRvcGFjaXR5OiAwLjY1O1xuXHRcdFx0Zm9udC1zdHlsZTogaXRhbGljO1xuXHRcdH1cblx0XHQudGhpbmtpbmctaGVhZGVyIHtcblx0XHRcdGN1cnNvcjogcG9pbnRlcjtcblx0XHRcdHVzZXItc2VsZWN0OiBub25lO1xuXHRcdFx0Zm9udC13ZWlnaHQ6IDYwMDtcblx0XHR9XG5cdFx0LnRoaW5raW5nLWJvZHkge1xuXHRcdFx0ZGlzcGxheTogbm9uZTtcblx0XHRcdG1hcmdpbi10b3A6IDRweDtcblx0XHRcdHdoaXRlLXNwYWNlOiBwcmUtd3JhcDtcblx0XHRcdG1heC1oZWlnaHQ6IDMwMHB4O1xuXHRcdFx0b3ZlcmZsb3cteTogYXV0bztcblx0XHR9XG5cdFx0LnRoaW5raW5nLWJsb2NrLmV4cGFuZGVkIC50aGlua2luZy1ib2R5IHtcblx0XHRcdGRpc3BsYXk6IGJsb2NrO1xuXHRcdH1cblx0XHRjb2RlIHtcblx0XHRcdGJhY2tncm91bmQ6IHZhcigtLXZzY29kZS1lZGl0b3ItYmFja2dyb3VuZCk7XG5cdFx0XHRwYWRkaW5nOiAxcHggNHB4O1xuXHRcdFx0Ym9yZGVyLXJhZGl1czogM3B4O1xuXHRcdFx0Zm9udC1mYW1pbHk6IHZhcigtLXZzY29kZS1lZGl0b3ItZm9udC1mYW1pbHkpO1xuXHRcdFx0Zm9udC1zaXplOiAwLjkyZW07XG5cdFx0fVxuXHQ8L3N0eWxlPlxuPC9oZWFkPlxuPGJvZHk+XG5cdDxoMj5Db252ZXJzYXRpb24gSGlzdG9yeTwvaDI+XG5cdDxkaXYgY2xhc3M9XCJ0b29sYmFyXCI+XG5cdFx0PGlucHV0IHR5cGU9XCJ0ZXh0XCIgY2xhc3M9XCJzZWFyY2gtaW5wdXRcIiBpZD1cInNlYXJjaFwiIHBsYWNlaG9sZGVyPVwiU2VhcmNoIG1lc3NhZ2VzLi4uXCIgLz5cblx0XHQ8YnV0dG9uIGNsYXNzPVwiYnRuXCIgaWQ9XCJyZWZyZXNoXCI+UmVmcmVzaDwvYnV0dG9uPlxuXHRcdCR7dmlzaWJsZU1lc3NhZ2VzLmxlbmd0aCA+IDAgPyBgPHNwYW4gY2xhc3M9XCJjb3VudFwiPiR7dmlzaWJsZU1lc3NhZ2VzLmxlbmd0aH0gbWVzc2FnZSR7dmlzaWJsZU1lc3NhZ2VzLmxlbmd0aCA9PT0gMSA/IFwiXCIgOiBcInNcIn08L3NwYW4+YCA6IFwiXCJ9XG5cdDwvZGl2PlxuXHQke2Vycm9yTWVzc2FnZSA/IGA8ZGl2IGNsYXNzPVwiZXJyb3JcIj4ke2VzY2FwZUh0bWwoZXJyb3JNZXNzYWdlKX08L2Rpdj5gIDogXCJcIn1cblx0PGRpdiBpZD1cIm1lc3NhZ2VzXCI+XG5cdFx0JHshZXJyb3JNZXNzYWdlICYmIHJlbmRlcmVkTWVzc2FnZXMgPT09IFwiXCIgPyAnPGRpdiBjbGFzcz1cImVtcHR5XCI+Tm8gbWVzc2FnZXMgaW4gdGhpcyBzZXNzaW9uLjwvZGl2PicgOiByZW5kZXJlZE1lc3NhZ2VzfVxuXHQ8L2Rpdj5cblx0PHNjcmlwdCBub25jZT1cIiR7bm9uY2V9XCI+XG5cdFx0Y29uc3QgdnNjb2RlID0gYWNxdWlyZVZzQ29kZUFwaSgpO1xuXG5cdFx0ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3JlZnJlc2gnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcblx0XHRcdHZzY29kZS5wb3N0TWVzc2FnZSh7IGNvbW1hbmQ6ICdyZWZyZXNoJyB9KTtcblx0XHR9KTtcblxuXHRcdC8vIFNlYXJjaCBmaWx0ZXJcblx0XHRkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2VhcmNoJykuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLCAoZSkgPT4ge1xuXHRcdFx0Y29uc3QgcXVlcnkgPSBlLnRhcmdldC52YWx1ZS50b0xvd2VyQ2FzZSgpO1xuXHRcdFx0ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLm1lc3NhZ2UnKS5mb3JFYWNoKChlbCkgPT4ge1xuXHRcdFx0XHRjb25zdCB0ZXh0ID0gZWwudGV4dENvbnRlbnQudG9Mb3dlckNhc2UoKTtcblx0XHRcdFx0ZWwuY2xhc3NMaXN0LnRvZ2dsZSgnaGlkZGVuJywgcXVlcnkgJiYgIXRleHQuaW5jbHVkZXMocXVlcnkpKTtcblx0XHRcdH0pO1xuXHRcdH0pO1xuXG5cdFx0Ly8gVG9nZ2xlIHRvb2wvdGhpbmtpbmcgYmxvY2tzXG5cdFx0ZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoZSkgPT4ge1xuXHRcdFx0Y29uc3QgaGVhZGVyID0gZS50YXJnZXQuY2xvc2VzdCgnLnRvb2wtaGVhZGVyLCAudGhpbmtpbmctaGVhZGVyJyk7XG5cdFx0XHRpZiAoaGVhZGVyKSB7XG5cdFx0XHRcdGhlYWRlci5wYXJlbnRFbGVtZW50LmNsYXNzTGlzdC50b2dnbGUoJ2V4cGFuZGVkJyk7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblx0XHRcdGNvbnN0IGZvcmtCdG4gPSBlLnRhcmdldC5jbG9zZXN0KCcuZm9yay1idG4nKTtcblx0XHRcdGlmIChmb3JrQnRuKSB7XG5cdFx0XHRcdHZzY29kZS5wb3N0TWVzc2FnZSh7IGNvbW1hbmQ6ICdmb3JrJywgZW50cnlJZDogZm9ya0J0bi5kYXRhc2V0LmVudHJ5SWQgfSk7XG5cdFx0XHR9XG5cdFx0fSk7XG5cdDwvc2NyaXB0PlxuPC9ib2R5PlxuPC9odG1sPmA7XG5cdH1cbn1cblxuZnVuY3Rpb24gcmVuZGVyQ29udGVudEJsb2Nrcyhjb250ZW50OiBzdHJpbmcgfCBDb250ZW50QmxvY2tbXSk6IHN0cmluZyB7XG5cdGlmICh0eXBlb2YgY29udGVudCA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIGVzY2FwZUh0bWwoY29udGVudCk7XG5cdGlmICghQXJyYXkuaXNBcnJheShjb250ZW50KSkgcmV0dXJuIFwiXCI7XG5cblx0cmV0dXJuIGNvbnRlbnRcblx0XHQubWFwKChibG9jaykgPT4ge1xuXHRcdFx0aWYgKHR5cGVvZiBibG9jayA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIGVzY2FwZUh0bWwoYmxvY2spO1xuXG5cdFx0XHRzd2l0Y2ggKGJsb2NrLnR5cGUpIHtcblx0XHRcdFx0Y2FzZSBcInRleHRcIjpcblx0XHRcdFx0XHRyZXR1cm4gZXNjYXBlSHRtbChibG9jay50ZXh0ID8/IFwiXCIpO1xuXG5cdFx0XHRcdGNhc2UgXCJ0aGlua2luZ1wiOlxuXHRcdFx0XHRcdGlmICghYmxvY2sudGV4dCkgcmV0dXJuIFwiXCI7XG5cdFx0XHRcdFx0cmV0dXJuIGA8ZGl2IGNsYXNzPVwidGhpbmtpbmctYmxvY2tcIj5cblx0XHRcdFx0XHRcdDxkaXYgY2xhc3M9XCJ0aGlua2luZy1oZWFkZXJcIj5UaGlua2luZy4uLjwvZGl2PlxuXHRcdFx0XHRcdFx0PGRpdiBjbGFzcz1cInRoaW5raW5nLWJvZHlcIj4ke2VzY2FwZUh0bWwoYmxvY2sudGV4dCl9PC9kaXY+XG5cdFx0XHRcdFx0PC9kaXY+YDtcblxuXHRcdFx0XHRjYXNlIFwidG9vbF91c2VcIjpcblx0XHRcdFx0XHRyZXR1cm4gYDxkaXYgY2xhc3M9XCJ0b29sLWJsb2NrXCI+XG5cdFx0XHRcdFx0XHQ8ZGl2IGNsYXNzPVwidG9vbC1oZWFkZXJcIj5Ub29sOiAke2VzY2FwZUh0bWwoYmxvY2submFtZSA/PyBcInVua25vd25cIil9PC9kaXY+XG5cdFx0XHRcdFx0XHQ8ZGl2IGNsYXNzPVwidG9vbC1ib2R5XCI+JHtlc2NhcGVIdG1sKEpTT04uc3RyaW5naWZ5KGJsb2NrLmlucHV0ID8/IHt9LCBudWxsLCAyKSl9PC9kaXY+XG5cdFx0XHRcdFx0PC9kaXY+YDtcblxuXHRcdFx0XHRjYXNlIFwidG9vbF9yZXN1bHRcIjoge1xuXHRcdFx0XHRcdGNvbnN0IHJlc3VsdFRleHQgPSB0eXBlb2YgYmxvY2suY29udGVudCA9PT0gXCJzdHJpbmdcIlxuXHRcdFx0XHRcdFx0PyBibG9jay5jb250ZW50XG5cdFx0XHRcdFx0XHQ6IEFycmF5LmlzQXJyYXkoYmxvY2suY29udGVudClcblx0XHRcdFx0XHRcdFx0PyBibG9jay5jb250ZW50Lm1hcCgoYikgPT4gKHR5cGVvZiBiID09PSBcInN0cmluZ1wiID8gYiA6IGI/LnRleHQgPz8gXCJcIikpLmpvaW4oXCJcIilcblx0XHRcdFx0XHRcdFx0OiBcIlwiO1xuXHRcdFx0XHRcdGlmICghcmVzdWx0VGV4dCkgcmV0dXJuIFwiXCI7XG5cdFx0XHRcdFx0Y29uc3QgdHJ1bmNhdGVkID0gcmVzdWx0VGV4dC5sZW5ndGggPiA1MDAgPyByZXN1bHRUZXh0LnNsaWNlKDAsIDUwMCkgKyBcIi4uLlwiIDogcmVzdWx0VGV4dDtcblx0XHRcdFx0XHRyZXR1cm4gYDxkaXYgY2xhc3M9XCJ0b29sLWJsb2NrXCI+XG5cdFx0XHRcdFx0XHQ8ZGl2IGNsYXNzPVwidG9vbC1oZWFkZXJcIj5Ub29sIFJlc3VsdDwvZGl2PlxuXHRcdFx0XHRcdFx0PGRpdiBjbGFzcz1cInRvb2wtYm9keVwiPiR7ZXNjYXBlSHRtbCh0cnVuY2F0ZWQpfTwvZGl2PlxuXHRcdFx0XHRcdDwvZGl2PmA7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRkZWZhdWx0OlxuXHRcdFx0XHRcdHJldHVybiBcIlwiO1xuXHRcdFx0fVxuXHRcdH0pXG5cdFx0LmpvaW4oXCJcIik7XG59XG5cbmZ1bmN0aW9uIGVzY2FwZUh0bWwodGV4dDogc3RyaW5nKTogc3RyaW5nIHtcblx0cmV0dXJuIHRleHRcblx0XHQucmVwbGFjZSgvJi9nLCBcIiZhbXA7XCIpXG5cdFx0LnJlcGxhY2UoLzwvZywgXCImbHQ7XCIpXG5cdFx0LnJlcGxhY2UoLz4vZywgXCImZ3Q7XCIpXG5cdFx0LnJlcGxhY2UoL1wiL2csIFwiJnF1b3Q7XCIpO1xufVxuXG5mdW5jdGlvbiBnZXROb25jZSgpOiBzdHJpbmcge1xuXHRjb25zdCBjaGFycyA9IFwiQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODlcIjtcblx0bGV0IG5vbmNlID0gXCJcIjtcblx0Zm9yIChsZXQgaSA9IDA7IGkgPCAzMjsgaSsrKSB7XG5cdFx0bm9uY2UgKz0gY2hhcnMuY2hhckF0KE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIGNoYXJzLmxlbmd0aCkpO1xuXHR9XG5cdHJldHVybiBub25jZTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFlBQVksWUFBWTtBQXNCakIsTUFBTSw0QkFBeUQ7QUFBQSxFQUNyRSxPQUFlO0FBQUEsRUFFRTtBQUFBLEVBQ0E7QUFBQSxFQUNULGNBQW1DLENBQUM7QUFBQSxFQUU1QyxPQUFPLGFBQ04sY0FDQSxRQUM4QjtBQUM5QixVQUFNLFNBQVMsT0FBTyxPQUFPLGtCQUFrQixjQUFjLE9BQU8sV0FBVztBQUUvRSxRQUFJLDRCQUE0QixjQUFjO0FBQzdDLGtDQUE0QixhQUFhLE1BQU0sT0FBTyxN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STtBQUVYO0FBQUE7QUFBQSxNQUFrQjtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsd0hBS29HLEtBQUs7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7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
