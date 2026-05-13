import * as vscode from "vscode";
import {
  getContextUsageDisplay,
  getSessionCacheReadTokens,
  getSessionCacheWriteTokens,
  getSessionCost,
  getSessionInputTokens,
  getSessionOutputTokens,
  getSessionTotalTokens,
  hasSessionTokenStats
} from "./rpc-display.js";
async function sendViaChat(message) {
  await vscode.commands.executeCommand("workbench.action.chat.open", { query: message });
}
class GsdSidebarProvider {
  constructor(extensionUri, client) {
    this.extensionUri = extensionUri;
    this.client = client;
    this.disposables.push(
      client.onConnectionChange(() => this.refresh()),
      client.onEvent((evt) => {
        switch (evt.type) {
          case "agent_start":
          case "agent_end":
          case "model_switched":
          case "compaction_start":
          case "compaction_end":
          case "retry_start":
          case "retry_end":
          case "retry_error":
            this.refresh();
            break;
        }
      })
    );
  }
  static viewId = "gsd-sidebar";
  view;
  disposables = [];
  refreshTimer;
  resolveWebviewView(webviewView, _context, _token) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true
    };
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.command) {
        case "start":
          await vscode.commands.executeCommand("gsd.start");
          break;
        case "stop":
          await vscode.commands.executeCommand("gsd.stop");
          break;
        case "newSession":
          await vscode.commands.executeCommand("gsd.newSession");
          break;
        case "cycleModel":
          await vscode.commands.executeCommand("gsd.cycleModel");
          break;
        case "cycleThinking":
          await vscode.commands.executeCommand("gsd.cycleThinking");
          break;
        case "switchModel":
          await vscode.commands.executeCommand("gsd.switchModel");
          break;
        case "setThinking":
          await vscode.commands.executeCommand("gsd.setThinking");
          break;
        case "compact":
          await vscode.commands.executeCommand("gsd.compact");
          break;
        case "abort":
          await vscode.commands.executeCommand("gsd.abort");
          break;
        case "exportHtml":
          await vscode.commands.executeCommand("gsd.exportHtml");
          break;
        case "sessionStats":
          await vscode.commands.executeCommand("gsd.sessionStats");
          break;
        case "listCommands":
          await vscode.commands.executeCommand("gsd.listCommands");
          break;
        case "toggleAutoCompaction":
          if (this.client.isConnected) {
            const state = await this.client.getState().catch(() => null);
            if (state) {
              await this.client.setAutoCompaction(!state.autoCompactionEnabled).catch(() => {
              });
              this.refresh();
            }
          }
          break;
        case "toggleAutoRetry":
          if (this.client.isConnected) {
            await this.client.setAutoRetry(!this.client.autoRetryEnabled).catch(() => {
            });
            this.refresh();
          }
          break;
        case "setSessionName":
          await vscode.commands.executeCommand("gsd.setSessionName");
          break;
        case "copyLastResponse":
          await vscode.commands.executeCommand("gsd.copyLastResponse");
          break;
        case "autoMode":
          await sendViaChat("@gsd /gsd auto");
          break;
        case "nextUnit":
          await sendViaChat("@gsd /gsd next");
          break;
        case "quickTask": {
          const quickInput = await vscode.window.showInputBox({
            prompt: "Describe the quick task",
            placeHolder: "e.g. fix the typo in README"
          });
          if (quickInput) {
            await sendViaChat(`@gsd /gsd quick ${quickInput}`);
          }
          break;
        }
        case "capture": {
          const thought = await vscode.window.showInputBox({
            prompt: "Capture a thought",
            placeHolder: "e.g. we should also handle the edge case for..."
          });
          if (thought) {
            await sendViaChat(`@gsd /gsd capture ${thought}`);
          }
          break;
        }
        case "status":
          await sendViaChat("@gsd /gsd status");
          break;
        case "forkSession":
          await vscode.commands.executeCommand("gsd.forkSession");
          break;
        case "toggleSteeringMode":
          await vscode.commands.executeCommand("gsd.toggleSteeringMode");
          break;
        case "toggleFollowUpMode":
          await vscode.commands.executeCommand("gsd.toggleFollowUpMode");
          break;
        case "showHistory":
          await vscode.commands.executeCommand("gsd.showHistory");
          break;
        case "fixProblemsInFile":
          await vscode.commands.executeCommand("gsd.fixProblemsInFile");
          break;
        case "selectApprovalMode":
          await vscode.commands.executeCommand("gsd.selectApprovalMode");
          break;
        default:
          vscode.window.showWarningMessage(`Unknown GSD sidebar command: ${msg.command}`);
          break;
      }
    });
    this.refreshTimer = setInterval(() => {
      if (this.client.isConnected) {
        this.refresh();
      }
    }, 1e4);
    this.refresh();
  }
  async refresh() {
    if (!this.view) {
      return;
    }
    let modelName = "N/A";
    let modelShort = "";
    let sessionId = "N/A";
    let sessionName = "";
    let messageCount = 0;
    let pendingMessageCount = 0;
    let thinkingLevel = "off";
    let isStreaming = false;
    let isCompacting = false;
    let autoCompaction = false;
    let autoRetry = false;
    let stats = null;
    let steeringMode = "all";
    let followUpMode = "all";
    if (this.client.isConnected) {
      autoRetry = this.client.autoRetryEnabled;
      try {
        const state = await this.client.getState();
        modelName = state.model ? `${state.model.provider}/${state.model.id}` : "Not set";
        modelShort = state.model?.id ?? "";
        sessionId = state.sessionId;
        sessionName = state.sessionName ?? "";
        messageCount = state.messageCount;
        pendingMessageCount = state.pendingMessageCount;
        thinkingLevel = state.thinkingLevel;
        isStreaming = state.isStreaming;
        isCompacting = state.isCompacting;
        autoCompaction = state.autoCompactionEnabled;
        steeringMode = state.steeringMode;
        followUpMode = state.followUpMode;
      } catch {
      }
      try {
        stats = await this.client.getSessionStats();
      } catch {
      }
    }
    const connected = this.client.isConnected;
    this.view.webview.html = this.getHtml({
      connected,
      modelName,
      modelShort,
      sessionId,
      sessionName,
      messageCount,
      pendingMessageCount,
      thinkingLevel,
      isStreaming,
      isCompacting,
      autoCompaction,
      autoRetry,
      stats,
      steeringMode,
      followUpMode
    });
  }
  dispose() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }
    for (const d of this.disposables) {
      d.dispose();
    }
  }
  getHtml(info) {
    const statusColor = info.connected ? "#4ec9b0" : "#f44747";
    const statusLabel = info.isStreaming ? "Working" : info.isCompacting ? "Compacting" : info.connected ? "Connected" : "Disconnected";
    const modelDisplay = info.modelShort || "N/A";
    const sessionDisplay = info.sessionName || (info.sessionId !== "N/A" ? info.sessionId.slice(0, 8) : "N/A");
    const cost = getSessionCost(info.stats);
    const costDisplay = cost > 0 ? `$${cost.toFixed(4)}` : "";
    const totalTokens = getSessionTotalTokens(info.stats);
    const contextUsage = getContextUsageDisplay(info.stats);
    const hasStats = hasSessionTokenStats(info.stats);
    const nonce = getNonce();
    let statRows = "";
    if (hasStats && info.stats) {
      const pairs = [];
      if (totalTokens) pairs.push(["Session tokens", formatNum(totalTokens)]);
      if (getSessionInputTokens(info.stats)) pairs.push(["In", formatNum(getSessionInputTokens(info.stats))]);
      if (getSessionOutputTokens(info.stats)) pairs.push(["Out", formatNum(getSessionOutputTokens(info.stats))]);
      if (getSessionCacheReadTokens(info.stats)) pairs.push(["Cache R", formatNum(getSessionCacheReadTokens(info.stats))]);
      if (getSessionCacheWriteTokens(info.stats)) pairs.push(["Cache W", formatNum(getSessionCacheWriteTokens(info.stats))]);
      if (info.stats.totalMessages) pairs.push(["Messages", String(info.stats.totalMessages)]);
      if (info.stats.toolCalls) pairs.push(["Tools", String(info.stats.toolCalls)]);
      if (getSessionCost(info.stats) > 0) pairs.push(["Cost", `$${getSessionCost(info.stats).toFixed(4)}`]);
      statRows = pairs.map(
        ([k, v]) => `<span class="stat-label">${k}</span><span class="stat-value">${v}</span>`
      ).join("");
    }
    return (
      /* html */
      `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<style>
		* { box-sizing: border-box; margin: 0; padding: 0; }
		body {
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			color: var(--vscode-foreground);
			padding: 8px;
		}

		/* ---- Header card ---- */
		.header {
			padding: 10px 12px;
			border-radius: 6px;
			background: var(--vscode-editor-background);
			border: 1px solid var(--vscode-panel-border);
			margin-bottom: 8px;
		}
		.header-top {
			display: flex;
			align-items: center;
			gap: 8px;
		}
		.status-dot {
			width: 8px;
			height: 8px;
			border-radius: 50%;
			background: ${statusColor};
			flex-shrink: 0;
		}
		.status-label {
			font-size: 11px;
			opacity: 0.7;
			flex-shrink: 0;
		}
		.header-model {
			margin-left: auto;
			font-size: 11px;
			font-weight: 600;
			opacity: 0.85;
			cursor: pointer;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.header-model:hover { opacity: 1; }
		.header-cost {
			font-size: 11px;
			font-variant-numeric: tabular-nums;
			opacity: 0.6;
			flex-shrink: 0;
		}
		.header-sub {
			display: flex;
			align-items: center;
			gap: 6px;
			margin-top: 6px;
			font-size: 11px;
			opacity: 0.6;
		}
		.header-sub .sep { opacity: 0.3; }
		.session-name {
			cursor: pointer;
			max-width: 120px;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.session-name:hover { opacity: 1; text-decoration: underline; }

		/* ---- Streaming banner ---- */
		.streaming {
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 6px 10px;
			margin-bottom: 8px;
			background: color-mix(in srgb, var(--vscode-focusBorder) 15%, transparent);
			border: 1px solid var(--vscode-focusBorder);
			border-radius: 6px;
			font-size: 12px;
		}
		.spinner {
			width: 10px; height: 10px;
			border: 2px solid var(--vscode-focusBorder);
			border-top-color: transparent;
			border-radius: 50%;
			animation: spin 0.8s linear infinite;
			flex-shrink: 0;
		}
		@keyframes spin { to { transform: rotate(360deg); } }
		.streaming-abort {
			margin-left: auto;
			font-size: 10px;
			padding: 2px 8px;
			border: 1px solid var(--vscode-foreground);
			background: transparent;
			color: var(--vscode-foreground);
			border-radius: 3px;
			cursor: pointer;
			opacity: 0.6;
		}
		.streaming-abort:hover { opacity: 1; }

		/* ---- Context bar (inline in header) ---- */
		.context-bar {
			margin-top: 8px;
		}
		.context-track {
			width: 100%;
			height: 3px;
			background: var(--vscode-panel-border);
			border-radius: 2px;
			overflow: hidden;
		}
		.context-fill {
			height: 100%;
			border-radius: 2px;
			transition: width 0.3s ease;
		}
		.context-text {
			font-size: 10px;
			opacity: 0.5;
			margin-top: 2px;
		}

		/* ---- Collapsible section ---- */
		.section {
			margin-bottom: 6px;
			border: 1px solid var(--vscode-panel-border);
			border-radius: 6px;
			overflow: hidden;
		}
		.section-header {
			display: flex;
			align-items: center;
			gap: 6px;
			padding: 6px 10px;
			cursor: pointer;
			user-select: none;
			font-size: 11px;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: 0.5px;
			opacity: 0.7;
			background: var(--vscode-editor-background);
		}
		.section-header:hover { opacity: 1; }
		.chevron {
			font-size: 10px;
			transition: transform 0.15s;
		}
		.section.collapsed .section-body { display: none; }
		.section.collapsed .chevron { transform: rotate(-90deg); }
		.section-body {
			padding: 6px 10px 8px;
		}

		/* ---- Stats grid ---- */
		.stats-grid {
			display: grid;
			grid-template-columns: auto 1fr;
			gap: 2px 10px;
			font-size: 11px;
		}
		.stat-label { opacity: 0.6; }
		.stat-value {
			text-align: right;
			font-variant-numeric: tabular-nums;
		}

		/* ---- Toggle row ---- */
		.toggle-row {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 3px 0;
			font-size: 11px;
		}
		.toggle-label { opacity: 0.7; }
		.toggle-pill {
			display: inline-block;
			padding: 1px 8px;
			border-radius: 10px;
			font-size: 10px;
			cursor: pointer;
			transition: all 0.15s;
			border: 1px solid transparent;
		}
		.toggle-pill.on {
			background: color-mix(in srgb, var(--vscode-focusBorder) 30%, transparent);
			border-color: var(--vscode-focusBorder);
			color: var(--vscode-foreground);
		}
		.toggle-pill.off {
			background: transparent;
			border-color: var(--vscode-panel-border);
			opacity: 0.5;
		}
		.toggle-pill:hover { opacity: 1; }

		/* ---- Buttons ---- */
		.actions {
			display: grid;
			grid-template-columns: 1fr 1fr;
			gap: 4px;
		}
		.actions.three-col {
			grid-template-columns: 1fr 1fr 1fr;
		}
		.action-btn {
			display: flex;
			align-items: center;
			justify-content: center;
			gap: 4px;
			padding: 5px 6px;
			border: 1px solid var(--vscode-panel-border);
			border-radius: 4px;
			background: transparent;
			color: var(--vscode-foreground);
			font-size: 11px;
			cursor: pointer;
			white-space: nowrap;
			width: auto;
		}
		.action-btn:hover {
			background: var(--vscode-list-hoverBackground);
			border-color: var(--vscode-focusBorder);
		}
		.action-btn.primary {
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			border-color: var(--vscode-button-background);
			font-weight: 600;
		}
		.action-btn.primary:hover {
			background: var(--vscode-button-hoverBackground);
		}
		.action-btn.danger {
			border-color: #f44747;
			color: #f44747;
		}
		.action-btn.danger:hover {
			background: color-mix(in srgb, #f44747 15%, transparent);
		}
		.action-btn.full {
			grid-column: 1 / -1;
		}

		/* ---- Disconnected state ---- */
		.disconnected {
			text-align: center;
			padding: 20px 12px;
		}
		.disconnected p {
			opacity: 0.5;
			font-size: 12px;
			margin-bottom: 12px;
		}
		.start-btn {
			padding: 8px 24px;
			border: none;
			border-radius: 4px;
			cursor: pointer;
			font-size: var(--vscode-font-size);
			font-weight: 600;
			color: var(--vscode-button-foreground);
			background: var(--vscode-button-background);
			width: auto;
			display: inline-block;
		}
		.start-btn:hover {
			background: var(--vscode-button-hoverBackground);
		}
	</style>
</head>
<body>
	${info.connected ? this.getConnectedHtml(info, {
        statusLabel,
        modelDisplay,
        sessionDisplay,
        costDisplay,
        contextUsage,
        totalTokens,
        hasStats: !!hasStats,
        statRows,
        nonce
      }) : `
	<div class="header">
		<div class="header-top">
			<div class="status-dot"></div>
			<span class="status-label">Disconnected</span>
		</div>
	</div>
	<div class="disconnected">
		<p>Agent is not running</p>
		<button class="start-btn" data-command="start">Start Agent</button>
	</div>
	`}

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const stored = vscode.getState() || {};

		// Restore collapsed state
		document.querySelectorAll('.section').forEach(s => {
			const id = s.dataset.section;
			if (id && stored[id] === 'collapsed') s.classList.add('collapsed');
		});

		document.addEventListener('click', (e) => {
			// Section toggle
			const header = e.target.closest('.section-header');
			if (header) {
				const section = header.parentElement;
				section.classList.toggle('collapsed');
				const id = section.dataset.section;
				if (id) {
					const state = vscode.getState() || {};
					state[id] = section.classList.contains('collapsed') ? 'collapsed' : 'open';
					vscode.setState(state);
				}
				return;
			}
			// Button/command click
			const btn = e.target.closest('[data-command]');
			if (btn) {
				vscode.postMessage({ command: btn.dataset.command });
			}
		});
	</script>
</body>
</html>`
    );
  }
  getConnectedHtml(info, ui) {
    const pendingBadge = info.pendingMessageCount > 0 ? ` <span style="opacity:0.5">+${info.pendingMessageCount}</span>` : "";
    return `
	<!-- Header card -->
	<div class="header">
		<div class="header-top">
			<div class="status-dot"></div>
			<span class="status-label">${ui.statusLabel}</span>
			<span class="header-model" data-command="switchModel" title="${escapeHtml(info.modelName)}">${escapeHtml(ui.modelDisplay)}</span>
			${ui.costDisplay ? `<span class="header-cost">${ui.costDisplay}</span>` : ""}
		</div>
		<div class="header-sub">
			<span class="session-name" data-command="setSessionName" title="${escapeHtml(info.sessionId)}">${escapeHtml(ui.sessionDisplay)}</span>
			<span class="sep">/</span>
			<span>${info.messageCount} msg${pendingBadge}</span>
			<span class="sep">/</span>
			<span data-command="cycleThinking" style="cursor:pointer" title="Click to cycle thinking level">${info.thinkingLevel === "off" ? "no think" : info.thinkingLevel}</span>
		</div>
		<div class="context-bar">
			${ui.contextUsage.percent !== null ? `
			<div class="context-track">
				<div class="context-fill" style="width:${ui.contextUsage.percent}%;background:#4ec9b0"></div>
			</div>
			` : ""}
			<div class="context-text">${escapeHtml(ui.contextUsage.text)}${ui.totalTokens ? ` / Session tokens: ${formatNum(ui.totalTokens)}` : ""}</div>
		</div>
	</div>

	${info.isStreaming ? `
	<div class="streaming">
		<span class="spinner"></span>
		<span>Agent is working...</span>
		<button class="streaming-abort" data-command="abort">Stop</button>
	</div>
	` : ""}

	<!-- Workflow -->
	<div class="section" data-section="workflow">
		<div class="section-header"><span class="chevron">&#9660;</span> Workflow</div>
		<div class="section-body">
			<div class="actions">
				<button class="action-btn primary" data-command="autoMode">Auto</button>
				<button class="action-btn" data-command="nextUnit">Next</button>
				<button class="action-btn" data-command="quickTask">Quick</button>
				<button class="action-btn" data-command="capture">Capture</button>
			</div>
		</div>
	</div>

	${ui.hasStats ? `
	<!-- Stats -->
	<div class="section" data-section="stats">
		<div class="section-header"><span class="chevron">&#9660;</span> Stats</div>
		<div class="section-body">
			<div class="stats-grid">${ui.statRows}</div>
		</div>
	</div>
	` : ""}

	<!-- Actions -->
	<div class="section" data-section="actions">
		<div class="section-header"><span class="chevron">&#9660;</span> Actions</div>
		<div class="section-body">
			<div class="actions three-col">
				<button class="action-btn" data-command="newSession">New</button>
				<button class="action-btn" data-command="compact">Compact</button>
				<button class="action-btn" data-command="copyLastResponse">Copy</button>
				<button class="action-btn" data-command="status">Status</button>
				<button class="action-btn" data-command="fixProblemsInFile">Fix Errs</button>
				<button class="action-btn" data-command="showHistory">History</button>
			</div>
			<div style="margin-top:6px">
				<button class="action-btn danger full" data-command="stop">Stop Agent</button>
			</div>
		</div>
	</div>

	<!-- Settings (collapsed by default) -->
	<div class="section collapsed" data-section="settings">
		<div class="section-header"><span class="chevron">&#9660;</span> Settings</div>
		<div class="section-body">
			<div class="toggle-row">
				<span class="toggle-label">Auto-compact</span>
				<span class="toggle-pill ${info.autoCompaction ? "on" : "off"}" data-command="toggleAutoCompaction">${info.autoCompaction ? "on" : "off"}</span>
			</div>
			<div class="toggle-row">
				<span class="toggle-label">Auto-retry</span>
				<span class="toggle-pill ${info.autoRetry ? "on" : "off"}" data-command="toggleAutoRetry">${info.autoRetry ? "on" : "off"}</span>
			</div>
			<div class="toggle-row">
				<span class="toggle-label">Steering</span>
				<span class="toggle-pill ${info.steeringMode === "one-at-a-time" ? "on" : "off"}" data-command="toggleSteeringMode">${info.steeringMode === "one-at-a-time" ? "1-at-a-time" : "all"}</span>
			</div>
			<div class="toggle-row">
				<span class="toggle-label">Follow-up</span>
				<span class="toggle-pill ${info.followUpMode === "one-at-a-time" ? "on" : "off"}" data-command="toggleFollowUpMode">${info.followUpMode === "one-at-a-time" ? "1-at-a-time" : "all"}</span>
			</div>
			<div class="toggle-row">
				<span class="toggle-label">Approval</span>
				<span class="toggle-pill on" data-command="selectApprovalMode">change</span>
			</div>
		</div>
	</div>`;
  }
}
function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function formatNum(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
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
  GsdSidebarProvider
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vdnNjb2RlLWV4dGVuc2lvbi9zcmMvc2lkZWJhci50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IFZTIENvZGUgc2lkZWJhciB3ZWJ2aWV3IHByb3ZpZGVyIGZvciBHU0QgYWdlbnQgY29udHJvbHMgYW5kIHN0YXR1cy5cblxuaW1wb3J0ICogYXMgdnNjb2RlIGZyb20gXCJ2c2NvZGVcIjtcbmltcG9ydCB0eXBlIHsgR3NkQ2xpZW50LCBTZXNzaW9uU3RhdHMsIFRoaW5raW5nTGV2ZWwgfSBmcm9tIFwiLi9nc2QtY2xpZW50LmpzXCI7XG5pbXBvcnQge1xuXHRnZXRDb250ZXh0VXNhZ2VEaXNwbGF5LFxuXHRnZXRTZXNzaW9uQ2FjaGVSZWFkVG9rZW5zLFxuXHRnZXRTZXNzaW9uQ2FjaGVXcml0ZVRva2Vucyxcblx0Z2V0U2Vzc2lvbkNvc3QsXG5cdGdldFNlc3Npb25JbnB1dFRva2Vucyxcblx0Z2V0U2Vzc2lvbk91dHB1dFRva2Vucyxcblx0Z2V0U2Vzc2lvblRvdGFsVG9rZW5zLFxuXHRoYXNTZXNzaW9uVG9rZW5TdGF0cyxcbn0gZnJvbSBcIi4vcnBjLWRpc3BsYXkuanNcIjtcblxuLyoqXG4gKiBTZW5kIGEgbWVzc2FnZSB0aHJvdWdoIFZTIENvZGUncyBDaGF0IHBhbmVsIHNvIHRoZSB1c2VyIHNlZXMgdGhlIHJlc3BvbnNlLlxuICogT3BlbnMgdGhlIENoYXQgcGFuZWwgYW5kIHByZS1maWxscyB0aGUgQGdzZCBwYXJ0aWNpcGFudCB3aXRoIHRoZSBtZXNzYWdlLlxuICovXG5hc3luYyBmdW5jdGlvbiBzZW5kVmlhQ2hhdChtZXNzYWdlOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcblx0YXdhaXQgdnNjb2RlLmNvbW1hbmRzLmV4ZWN1dGVDb21tYW5kKFwid29ya2JlbmNoLmFjdGlvbi5jaGF0Lm9wZW5cIiwgeyBxdWVyeTogbWVzc2FnZSB9KTtcbn1cblxuLyoqXG4gKiBXZWJ2aWV3Vmlld1Byb3ZpZGVyIHRoYXQgcmVuZGVycyBhIGNvbXBhY3QsIGNhcmQtYmFzZWQgc2lkZWJhciBwYW5lbC5cbiAqIERlc2lnbmVkIGZvciBpbmZvcm1hdGlvbiBkZW5zaXR5IHdpdGhvdXQgY2x1dHRlciBcdTIwMTQgY29sbGFwc2libGUgc2VjdGlvbnMsXG4gKiBoaWRkZW4gZW1wdHkgZGF0YSwgYW5kIGNvbnNvbGlkYXRlZCBhY3Rpb24gYnV0dG9ucy5cbiAqL1xuZXhwb3J0IGNsYXNzIEdzZFNpZGViYXJQcm92aWRlciBpbXBsZW1lbnRzIHZzY29kZS5XZWJ2aWV3Vmlld1Byb3ZpZGVyIHtcblx0cHVibGljIHN0YXRpYyByZWFkb25seSB2aWV3SWQgPSBcImdzZC1zaWRlYmFyXCI7XG5cblx0cHJpdmF0ZSB2aWV3PzogdnNjb2RlLldlYnZpZXdWaWV3O1xuXHRwcml2YXRlIGRpc3Bvc2FibGVzOiB2c2NvZGUuRGlzcG9zYWJsZVtdID0gW107XG5cdHByaXZhdGUgcmVmcmVzaFRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRJbnRlcnZhbD4gfCB1bmRlZmluZWQ7XG5cblx0Y29uc3RydWN0b3IoXG5cdFx0cHJpdmF0ZSByZWFkb25seSBleHRlbnNpb25Vcmk6IHZzY29kZS5VcmksXG5cdFx0cHJpdmF0ZSByZWFkb25seSBjbGllbnQ6IEdzZENsaWVudCxcblx0KSB7XG5cdFx0dGhpcy5kaXNwb3NhYmxlcy5wdXNoKFxuXHRcdFx0Y2xpZW50Lm9uQ29ubmVjdGlvbkNoYW5nZSgoKSA9PiB0aGlzLnJlZnJlc2goKSksXG5cdFx0XHRjbGllbnQub25FdmVudCgoZXZ0KSA9PiB7XG5cdFx0XHRcdHN3aXRjaCAoZXZ0LnR5cGUpIHtcblx0XHRcdFx0XHRjYXNlIFwiYWdlbnRfc3RhcnRcIjpcblx0XHRcdFx0XHRjYXNlIFwiYWdlbnRfZW5kXCI6XG5cdFx0XHRcdFx0Y2FzZSBcIm1vZGVsX3N3aXRjaGVkXCI6XG5cdFx0XHRcdFx0Y2FzZSBcImNvbXBhY3Rpb25fc3RhcnRcIjpcblx0XHRcdFx0XHRjYXNlIFwiY29tcGFjdGlvbl9lbmRcIjpcblx0XHRcdFx0XHRjYXNlIFwicmV0cnlfc3RhcnRcIjpcblx0XHRcdFx0XHRjYXNlIFwicmV0cnlfZW5kXCI6XG5cdFx0XHRcdFx0Y2FzZSBcInJldHJ5X2Vycm9yXCI6XG5cdFx0XHRcdFx0XHR0aGlzLnJlZnJlc2goKTtcblx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHR9XG5cdFx0XHR9KSxcblx0XHQpO1xuXHR9XG5cblx0cmVzb2x2ZVdlYnZpZXdWaWV3KFxuXHRcdHdlYnZpZXdWaWV3OiB2c2NvZGUuV2Vidmlld1ZpZXcsXG5cdFx0X2NvbnRleHQ6IHZzY29kZS5XZWJ2aWV3Vmlld1Jlc29sdmVDb250ZXh0LFxuXHRcdF90b2tlbjogdnNjb2RlLkNhbmNlbGxhdGlvblRva2VuLFxuXHQpOiB2b2lkIHtcblx0XHR0aGlzLnZpZXcgPSB3ZWJ2aWV3VmlldztcblxuXHRcdHdlYnZpZXdWaWV3LndlYnZpZXcub3B0aW9ucyA9IHtcblx0XHRcdGVuYWJsZVNjcmlwdHM6IHRydWUsXG5cdFx0fTtcblxuXHRcdHdlYnZpZXdWaWV3LndlYnZpZXcub25EaWRSZWNlaXZlTWVzc2FnZShhc3luYyAobXNnOiB7IGNvbW1hbmQ6IHN0cmluZzsgdmFsdWU/OiBzdHJpbmcgfSkgPT4ge1xuXHRcdFx0c3dpdGNoIChtc2cuY29tbWFuZCkge1xuXHRcdFx0XHRjYXNlIFwic3RhcnRcIjpcblx0XHRcdFx0XHRhd2FpdCB2c2NvZGUuY29tbWFuZHMuZXhlY3V0ZUNvbW1hbmQoXCJnc2Quc3RhcnRcIik7XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdGNhc2UgXCJzdG9wXCI6XG5cdFx0XHRcdFx0YXdhaXQgdnNjb2RlLmNvbW1hbmRzLmV4ZWN1dGVDb21tYW5kKFwiZ3NkLnN0b3BcIik7XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdGNhc2UgXCJuZXdTZXNzaW9uXCI6XG5cdFx0XHRcdFx0YXdhaXQgdnNjb2RlLmNvbW1hbmRzLmV4ZWN1dGVDb21tYW5kKFwiZ3NkLm5ld1Nlc3Npb25cIik7XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdGNhc2UgXCJjeWNsZU1vZGVsXCI6XG5cdFx0XHRcdFx0YXdhaXQgdnNjb2RlLmNvbW1hbmRzLmV4ZWN1dGVDb21tYW5kKFwiZ3NkLmN5Y2xlTW9kZWxcIik7XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdGNhc2UgXCJjeWNsZVRoaW5raW5nXCI6XG5cdFx0XHRcdFx0YXdhaXQgdnNjb2RlLmNvbW1hbmRzLmV4ZWN1dGVDb21tYW5kKFwiZ3NkLmN5Y2xlVGhpbmtpbmdcIik7XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdGNhc2UgXCJzd2l0Y2hNb2RlbFwiOlxuXHRcdFx0XHRcdGF3YWl0IHZzY29kZS5jb21tYW5kcy5leGVjdXRlQ29tbWFuZChcImdzZC5zd2l0Y2hNb2RlbFwiKTtcblx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0Y2FzZSBcInNldFRoaW5raW5nXCI6XG5cdFx0XHRcdFx0YXdhaXQgdnNjb2RlLmNvbW1hbmRzLmV4ZWN1dGVDb21tYW5kKFwiZ3NkLnNldFRoaW5raW5nXCIpO1xuXHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRjYXNlIFwiY29tcGFjdFwiOlxuXHRcdFx0XHRcdGF3YWl0IHZzY29kZS5jb21tYW5kcy5leGVjdXRlQ29tbWFuZChcImdzZC5jb21wYWN0XCIpO1xuXHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRjYXNlIFwiYWJvcnRcIjpcblx0XHRcdFx0XHRhd2FpdCB2c2NvZGUuY29tbWFuZHMuZXhlY3V0ZUNvbW1hbmQoXCJnc2QuYWJvcnRcIik7XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdGNhc2UgXCJleHBvcnRIdG1sXCI6XG5cdFx0XHRcdFx0YXdhaXQgdnNjb2RlLmNvbW1hbmRzLmV4ZWN1dGVDb21tYW5kKFwiZ3NkLmV4cG9ydEh0bWxcIik7XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdGNhc2UgXCJzZXNzaW9uU3RhdHNcIjpcblx0XHRcdFx0XHRhd2FpdCB2c2NvZGUuY29tbWFuZHMuZXhlY3V0ZUNvbW1hbmQoXCJnc2Quc2Vzc2lvblN0YXRzXCIpO1xuXHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRjYXNlIFwibGlzdENvbW1hbmRzXCI6XG5cdFx0XHRcdFx0YXdhaXQgdnNjb2RlLmNvbW1hbmRzLmV4ZWN1dGVDb21tYW5kKFwiZ3NkLmxpc3RDb21tYW5kc1wiKTtcblx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0Y2FzZSBcInRvZ2dsZUF1dG9Db21wYWN0aW9uXCI6XG5cdFx0XHRcdFx0aWYgKHRoaXMuY2xpZW50LmlzQ29ubmVjdGVkKSB7XG5cdFx0XHRcdFx0XHRjb25zdCBzdGF0ZSA9IGF3YWl0IHRoaXMuY2xpZW50LmdldFN0YXRlKCkuY2F0Y2goKCkgPT4gbnVsbCk7XG5cdFx0XHRcdFx0XHRpZiAoc3RhdGUpIHtcblx0XHRcdFx0XHRcdFx0YXdhaXQgdGhpcy5jbGllbnQuc2V0QXV0b0NvbXBhY3Rpb24oIXN0YXRlLmF1dG9Db21wYWN0aW9uRW5hYmxlZCkuY2F0Y2goKCkgPT4ge30pO1xuXHRcdFx0XHRcdFx0XHR0aGlzLnJlZnJlc2goKTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdGNhc2UgXCJ0b2dnbGVBdXRvUmV0cnlcIjpcblx0XHRcdFx0XHRpZiAodGhpcy5jbGllbnQuaXNDb25uZWN0ZWQpIHtcblx0XHRcdFx0XHRcdGF3YWl0IHRoaXMuY2xpZW50LnNldEF1dG9SZXRyeSghdGhpcy5jbGllbnQuYXV0b1JldHJ5RW5hYmxlZCkuY2F0Y2goKCkgPT4ge30pO1xuXHRcdFx0XHRcdFx0dGhpcy5yZWZyZXNoKCk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRjYXNlIFwic2V0U2Vzc2lvbk5hbWVcIjpcblx0XHRcdFx0XHRhd2FpdCB2c2NvZGUuY29tbWFuZHMuZXhlY3V0ZUNvbW1hbmQoXCJnc2Quc2V0U2Vzc2lvbk5hbWVcIik7XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdGNhc2UgXCJjb3B5TGFzdFJlc3BvbnNlXCI6XG5cdFx0XHRcdFx0YXdhaXQgdnNjb2RlLmNvbW1hbmRzLmV4ZWN1dGVDb21tYW5kKFwiZ3NkLmNvcHlMYXN0UmVzcG9uc2VcIik7XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdGNhc2UgXCJhdXRvTW9kZVwiOlxuXHRcdFx0XHRcdGF3YWl0IHNlbmRWaWFDaGF0KFwiQGdzZCAvZ3NkIGF1dG9cIik7XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdGNhc2UgXCJuZXh0VW5pdFwiOlxuXHRcdFx0XHRcdGF3YWl0IHNlbmRWaWFDaGF0KFwiQGdzZCAvZ3NkIG5leHRcIik7XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdGNhc2UgXCJxdWlja1Rhc2tcIjoge1xuXHRcdFx0XHRcdGNvbnN0IHF1aWNrSW5wdXQgPSBhd2FpdCB2c2NvZGUud2luZG93LnNob3dJbnB1dEJveCh7XG5cdFx0XHRcdFx0XHRwcm9tcHQ6IFwiRGVzY3JpYmUgdGhlIHF1aWNrIHRhc2tcIixcblx0XHRcdFx0XHRcdHBsYWNlSG9sZGVyOiBcImUuZy4gZml4IHRoZSB0eXBvIGluIFJFQURNRVwiLFxuXHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdGlmIChxdWlja0lucHV0KSB7XG5cdFx0XHRcdFx0XHRhd2FpdCBzZW5kVmlhQ2hhdChgQGdzZCAvZ3NkIHF1aWNrICR7cXVpY2tJbnB1dH1gKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdH1cblx0XHRcdFx0Y2FzZSBcImNhcHR1cmVcIjoge1xuXHRcdFx0XHRcdGNvbnN0IHRob3VnaHQgPSBhd2FpdCB2c2NvZGUud2luZG93LnNob3dJbnB1dEJveCh7XG5cdFx0XHRcdFx0XHRwcm9tcHQ6IFwiQ2FwdHVyZSBhIHRob3VnaHRcIixcblx0XHRcdFx0XHRcdHBsYWNlSG9sZGVyOiBcImUuZy4gd2Ugc2hvdWxkIGFsc28gaGFuZGxlIHRoZSBlZGdlIGNhc2UgZm9yLi4uXCIsXG5cdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0aWYgKHRob3VnaHQpIHtcblx0XHRcdFx0XHRcdGF3YWl0IHNlbmRWaWFDaGF0KGBAZ3NkIC9nc2QgY2FwdHVyZSAke3Rob3VnaHR9YCk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGNhc2UgXCJzdGF0dXNcIjpcblx0XHRcdFx0XHRhd2FpdCBzZW5kVmlhQ2hhdChcIkBnc2QgL2dzZCBzdGF0dXNcIik7XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdGNhc2UgXCJmb3JrU2Vzc2lvblwiOlxuXHRcdFx0XHRcdGF3YWl0IHZzY29kZS5jb21tYW5kcy5leGVjdXRlQ29tbWFuZChcImdzZC5mb3JrU2Vzc2lvblwiKTtcblx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0Y2FzZSBcInRvZ2dsZVN0ZWVyaW5nTW9kZVwiOlxuXHRcdFx0XHRcdGF3YWl0IHZzY29kZS5jb21tYW5kcy5leGVjdXRlQ29tbWFuZChcImdzZC50b2dnbGVTdGVlcmluZ01vZGVcIik7XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdGNhc2UgXCJ0b2dnbGVGb2xsb3dVcE1vZGVcIjpcblx0XHRcdFx0XHRhd2FpdCB2c2NvZGUuY29tbWFuZHMuZXhlY3V0ZUNvbW1hbmQoXCJnc2QudG9nZ2xlRm9sbG93VXBNb2RlXCIpO1xuXHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRcdGNhc2UgXCJzaG93SGlzdG9yeVwiOlxuXHRcdFx0XHRcdFx0YXdhaXQgdnNjb2RlLmNvbW1hbmRzLmV4ZWN1dGVDb21tYW5kKFwiZ3NkLnNob3dIaXN0b3J5XCIpO1xuXHRcdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdFx0Y2FzZSBcImZpeFByb2JsZW1zSW5GaWxlXCI6XG5cdFx0XHRcdFx0XHRhd2FpdCB2c2NvZGUuY29tbWFuZHMuZXhlY3V0ZUNvbW1hbmQoXCJnc2QuZml4UHJvYmxlbXNJbkZpbGVcIik7XG5cdFx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0XHRjYXNlIFwic2VsZWN0QXBwcm92YWxNb2RlXCI6XG5cdFx0XHRcdFx0XHRhd2FpdCB2c2NvZGUuY29tbWFuZHMuZXhlY3V0ZUNvbW1hbmQoXCJnc2Quc2VsZWN0QXBwcm92YWxNb2RlXCIpO1xuXHRcdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdFx0ZGVmYXVsdDpcblx0XHRcdFx0XHRcdHZzY29kZS53aW5kb3cuc2hvd1dhcm5pbmdNZXNzYWdlKGBVbmtub3duIEdTRCBzaWRlYmFyIGNvbW1hbmQ6ICR7bXNnLmNvbW1hbmR9YCk7XG5cdFx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0fVxuXHRcdFx0fSk7XG5cblx0XHQvLyBQZXJpb2RpYyByZWZyZXNoIHdoaWxlIGNvbm5lY3RlZCAoZm9yIHRva2VuIHN0YXRzKVxuXHRcdHRoaXMucmVmcmVzaFRpbWVyID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuXHRcdFx0aWYgKHRoaXMuY2xpZW50LmlzQ29ubmVjdGVkKSB7XG5cdFx0XHRcdHRoaXMucmVmcmVzaCgpO1xuXHRcdFx0fVxuXHRcdH0sIDEwXzAwMCk7XG5cblx0XHR0aGlzLnJlZnJlc2goKTtcblx0fVxuXG5cdGFzeW5jIHJlZnJlc2goKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0aWYgKCF0aGlzLnZpZXcpIHtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRsZXQgbW9kZWxOYW1lID0gXCJOL0FcIjtcblx0XHRsZXQgbW9kZWxTaG9ydCA9IFwiXCI7XG5cdFx0bGV0IHNlc3Npb25JZCA9IFwiTi9BXCI7XG5cdFx0bGV0IHNlc3Npb25OYW1lID0gXCJcIjtcblx0XHRsZXQgbWVzc2FnZUNvdW50ID0gMDtcblx0XHRsZXQgcGVuZGluZ01lc3NhZ2VDb3VudCA9IDA7XG5cdFx0bGV0IHRoaW5raW5nTGV2ZWw6IFRoaW5raW5nTGV2ZWwgPSBcIm9mZlwiO1xuXHRcdGxldCBpc1N0cmVhbWluZyA9IGZhbHNlO1xuXHRcdGxldCBpc0NvbXBhY3RpbmcgPSBmYWxzZTtcblx0XHRsZXQgYXV0b0NvbXBhY3Rpb24gPSBmYWxzZTtcblx0XHRsZXQgYXV0b1JldHJ5ID0gZmFsc2U7XG5cdFx0bGV0IHN0YXRzOiBTZXNzaW9uU3RhdHMgfCBudWxsID0gbnVsbDtcblx0XHRsZXQgc3RlZXJpbmdNb2RlOiBcImFsbFwiIHwgXCJvbmUtYXQtYS10aW1lXCIgPSBcImFsbFwiO1xuXHRcdGxldCBmb2xsb3dVcE1vZGU6IFwiYWxsXCIgfCBcIm9uZS1hdC1hLXRpbWVcIiA9IFwiYWxsXCI7XG5cblx0XHRpZiAodGhpcy5jbGllbnQuaXNDb25uZWN0ZWQpIHtcblx0XHRcdGF1dG9SZXRyeSA9IHRoaXMuY2xpZW50LmF1dG9SZXRyeUVuYWJsZWQ7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCBzdGF0ZSA9IGF3YWl0IHRoaXMuY2xpZW50LmdldFN0YXRlKCk7XG5cdFx0XHRcdG1vZGVsTmFtZSA9IHN0YXRlLm1vZGVsXG5cdFx0XHRcdFx0PyBgJHtzdGF0ZS5tb2RlbC5wcm92aWRlcn0vJHtzdGF0ZS5tb2RlbC5pZH1gXG5cdFx0XHRcdFx0OiBcIk5vdCBzZXRcIjtcblx0XHRcdFx0bW9kZWxTaG9ydCA9IHN0YXRlLm1vZGVsPy5pZCA/PyBcIlwiO1xuXHRcdFx0XHRzZXNzaW9uSWQgPSBzdGF0ZS5zZXNzaW9uSWQ7XG5cdFx0XHRcdHNlc3Npb25OYW1lID0gc3RhdGUuc2Vzc2lvbk5hbWUgPz8gXCJcIjtcblx0XHRcdFx0bWVzc2FnZUNvdW50ID0gc3RhdGUubWVzc2FnZUNvdW50O1xuXHRcdFx0XHRwZW5kaW5nTWVzc2FnZUNvdW50ID0gc3RhdGUucGVuZGluZ01lc3NhZ2VDb3VudDtcblx0XHRcdFx0dGhpbmtpbmdMZXZlbCA9IHN0YXRlLnRoaW5raW5nTGV2ZWwgYXMgVGhpbmtpbmdMZXZlbDtcblx0XHRcdFx0aXNTdHJlYW1pbmcgPSBzdGF0ZS5pc1N0cmVhbWluZztcblx0XHRcdFx0aXNDb21wYWN0aW5nID0gc3RhdGUuaXNDb21wYWN0aW5nO1xuXHRcdFx0XHRhdXRvQ29tcGFjdGlvbiA9IHN0YXRlLmF1dG9Db21wYWN0aW9uRW5hYmxlZDtcblx0XHRcdFx0c3RlZXJpbmdNb2RlID0gc3RhdGUuc3RlZXJpbmdNb2RlO1xuXHRcdFx0XHRmb2xsb3dVcE1vZGUgPSBzdGF0ZS5mb2xsb3dVcE1vZGU7XG5cdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0Ly8gU3RhdGUgZmV0Y2ggZmFpbGVkLCBzaG93IGRlZmF1bHRzXG5cdFx0XHR9XG5cblx0XHRcdHRyeSB7XG5cdFx0XHRcdHN0YXRzID0gYXdhaXQgdGhpcy5jbGllbnQuZ2V0U2Vzc2lvblN0YXRzKCk7XG5cdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0Ly8gU3RhdHMgZmV0Y2ggZmFpbGVkXG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0Y29uc3QgY29ubmVjdGVkID0gdGhpcy5jbGllbnQuaXNDb25uZWN0ZWQ7XG5cblx0XHR0aGlzLnZpZXcud2Vidmlldy5odG1sID0gdGhpcy5nZXRIdG1sKHtcblx0XHRcdGNvbm5lY3RlZCxcblx0XHRcdG1vZGVsTmFtZSxcblx0XHRcdG1vZGVsU2hvcnQsXG5cdFx0XHRzZXNzaW9uSWQsXG5cdFx0XHRzZXNzaW9uTmFtZSxcblx0XHRcdG1lc3NhZ2VDb3VudCxcblx0XHRcdHBlbmRpbmdNZXNzYWdlQ291bnQsXG5cdFx0XHR0aGlua2luZ0xldmVsLFxuXHRcdFx0aXNTdHJlYW1pbmcsXG5cdFx0XHRpc0NvbXBhY3RpbmcsXG5cdFx0XHRhdXRvQ29tcGFjdGlvbixcblx0XHRcdGF1dG9SZXRyeSxcblx0XHRcdHN0YXRzLFxuXHRcdFx0c3RlZXJpbmdNb2RlLFxuXHRcdFx0Zm9sbG93VXBNb2RlLFxuXHRcdH0pO1xuXHR9XG5cblx0ZGlzcG9zZSgpOiB2b2lkIHtcblx0XHRpZiAodGhpcy5yZWZyZXNoVGltZXIpIHtcblx0XHRcdGNsZWFySW50ZXJ2YWwodGhpcy5yZWZyZXNoVGltZXIpO1xuXHRcdH1cblx0XHRmb3IgKGNvbnN0IGQgb2YgdGhpcy5kaXNwb3NhYmxlcykge1xuXHRcdFx0ZC5kaXNwb3NlKCk7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBnZXRIdG1sKGluZm86IHtcblx0XHRjb25uZWN0ZWQ6IGJvb2xlYW47XG5cdFx0bW9kZWxOYW1lOiBzdHJpbmc7XG5cdFx0bW9kZWxTaG9ydDogc3RyaW5nO1xuXHRcdHNlc3Npb25JZDogc3RyaW5nO1xuXHRcdHNlc3Npb25OYW1lOiBzdHJpbmc7XG5cdFx0bWVzc2FnZUNvdW50OiBudW1iZXI7XG5cdFx0cGVuZGluZ01lc3NhZ2VDb3VudDogbnVtYmVyO1xuXHRcdHRoaW5raW5nTGV2ZWw6IFRoaW5raW5nTGV2ZWw7XG5cdFx0aXNTdHJlYW1pbmc6IGJvb2xlYW47XG5cdFx0aXNDb21wYWN0aW5nOiBib29sZWFuO1xuXHRcdGF1dG9Db21wYWN0aW9uOiBib29sZWFuO1xuXHRcdGF1dG9SZXRyeTogYm9vbGVhbjtcblx0XHRzdGF0czogU2Vzc2lvblN0YXRzIHwgbnVsbDtcblx0XHRzdGVlcmluZ01vZGU6IFwiYWxsXCIgfCBcIm9uZS1hdC1hLXRpbWVcIjtcblx0XHRmb2xsb3dVcE1vZGU6IFwiYWxsXCIgfCBcIm9uZS1hdC1hLXRpbWVcIjtcblx0fSk6IHN0cmluZyB7XG5cdFx0Y29uc3Qgc3RhdHVzQ29sb3IgPSBpbmZvLmNvbm5lY3RlZCA/IFwiIzRlYzliMFwiIDogXCIjZjQ0NzQ3XCI7XG5cdFx0Y29uc3Qgc3RhdHVzTGFiZWwgPSBpbmZvLmlzU3RyZWFtaW5nID8gXCJXb3JraW5nXCIgOiBpbmZvLmlzQ29tcGFjdGluZyA/IFwiQ29tcGFjdGluZ1wiIDogaW5mby5jb25uZWN0ZWQgPyBcIkNvbm5lY3RlZFwiIDogXCJEaXNjb25uZWN0ZWRcIjtcblxuXHRcdC8vIE1vZGVsIHNob3J0IG5hbWUgZm9yIGhlYWRlclxuXHRcdGNvbnN0IG1vZGVsRGlzcGxheSA9IGluZm8ubW9kZWxTaG9ydCB8fCBcIk4vQVwiO1xuXG5cdFx0Ly8gU2Vzc2lvbiBkaXNwbGF5IFx1MjAxNCBuYW1lIG9yIHRydW5jYXRlZCBJRFxuXHRcdGNvbnN0IHNlc3Npb25EaXNwbGF5ID0gaW5mby5zZXNzaW9uTmFtZSB8fCAoaW5mby5zZXNzaW9uSWQgIT09IFwiTi9BXCIgPyBpbmZvLnNlc3Npb25JZC5zbGljZSgwLCA4KSA6IFwiTi9BXCIpO1xuXG5cdFx0Ly8gQ29zdCBmb3IgaGVhZGVyXG5cdFx0Y29uc3QgY29zdCA9IGdldFNlc3Npb25Db3N0KGluZm8uc3RhdHMpO1xuXHRcdGNvbnN0IGNvc3REaXNwbGF5ID0gY29zdCA+IDBcblx0XHRcdD8gYCQke2Nvc3QudG9GaXhlZCg0KX1gXG5cdFx0XHQ6IFwiXCI7XG5cblx0XHQvLyBMaXZlIGNvbnRleHQgdXNhZ2UgaXMgdW5rbm93biB1bnRpbCBwcm92aWRlci1ib3VuZCBhdWRpdCBkYXRhIGlzIGF2YWlsYWJsZS5cblx0XHRjb25zdCB0b3RhbFRva2VucyA9IGdldFNlc3Npb25Ub3RhbFRva2VucyhpbmZvLnN0YXRzKTtcblx0XHRjb25zdCBjb250ZXh0VXNhZ2UgPSBnZXRDb250ZXh0VXNhZ2VEaXNwbGF5KGluZm8uc3RhdHMpO1xuXG5cdFx0Ly8gT25seSBzaG93IHN0YXRzIHRoYXQgaGF2ZSByZWFsIGRhdGFcblx0XHRjb25zdCBoYXNTdGF0cyA9IGhhc1Nlc3Npb25Ub2tlblN0YXRzKGluZm8uc3RhdHMpO1xuXG5cdFx0Y29uc3Qgbm9uY2UgPSBnZXROb25jZSgpO1xuXG5cdFx0Ly8gQnVpbGQgc3RhdCByb3dzIG9ubHkgZm9yIG5vbi16ZXJvIHZhbHVlc1xuXHRcdGxldCBzdGF0Um93cyA9IFwiXCI7XG5cdFx0aWYgKGhhc1N0YXRzICYmIGluZm8uc3RhdHMpIHtcblx0XHRcdGNvbnN0IHBhaXJzOiBbc3RyaW5nLCBzdHJpbmddW10gPSBbXTtcblx0XHRcdGlmICh0b3RhbFRva2VucykgcGFpcnMucHVzaChbXCJTZXNzaW9uIHRva2Vuc1wiLCBmb3JtYXROdW0odG90YWxUb2tlbnMpXSk7XG5cdFx0XHRpZiAoZ2V0U2Vzc2lvbklucHV0VG9rZW5zKGluZm8uc3RhdHMpKSBwYWlycy5wdXNoKFtcIkluXCIsIGZvcm1hdE51bShnZXRTZXNzaW9uSW5wdXRUb2tlbnMoaW5mby5zdGF0cykpXSk7XG5cdFx0XHRpZiAoZ2V0U2Vzc2lvbk91dHB1dFRva2VucyhpbmZvLnN0YXRzKSkgcGFpcnMucHVzaChbXCJPdXRcIiwgZm9ybWF0TnVtKGdldFNlc3Npb25PdXRwdXRUb2tlbnMoaW5mby5zdGF0cykpXSk7XG5cdFx0XHRpZiAoZ2V0U2Vzc2lvbkNhY2hlUmVhZFRva2VucyhpbmZvLnN0YXRzKSkgcGFpcnMucHVzaChbXCJDYWNoZSBSXCIsIGZvcm1hdE51bShnZXRTZXNzaW9uQ2FjaGVSZWFkVG9rZW5zKGluZm8uc3RhdHMpKV0pO1xuXHRcdFx0aWYgKGdldFNlc3Npb25DYWNoZVdyaXRlVG9rZW5zKGluZm8uc3RhdHMpKSBwYWlycy5wdXNoKFtcIkNhY2hlIFdcIiwgZm9ybWF0TnVtKGdldFNlc3Npb25DYWNoZVdyaXRlVG9rZW5zKGluZm8uc3RhdHMpKV0pO1xuXHRcdFx0aWYgKGluZm8uc3RhdHMudG90YWxNZXNzYWdlcykgcGFpcnMucHVzaChbXCJNZXNzYWdlc1wiLCBTdHJpbmcoaW5mby5zdGF0cy50b3RhbE1lc3NhZ2VzKV0pO1xuXHRcdFx0aWYgKGluZm8uc3RhdHMudG9vbENhbGxzKSBwYWlycy5wdXNoKFtcIlRvb2xzXCIsIFN0cmluZyhpbmZvLnN0YXRzLnRvb2xDYWxscyldKTtcblx0XHRcdGlmIChnZXRTZXNzaW9uQ29zdChpbmZvLnN0YXRzKSA+IDApIHBhaXJzLnB1c2goW1wiQ29zdFwiLCBgJCR7Z2V0U2Vzc2lvbkNvc3QoaW5mby5zdGF0cykudG9GaXhlZCg0KX1gXSk7XG5cblx0XHRcdHN0YXRSb3dzID0gcGFpcnMubWFwKChbaywgdl0pID0+XG5cdFx0XHRcdGA8c3BhbiBjbGFzcz1cInN0YXQtbGFiZWxcIj4ke2t9PC9zcGFuPjxzcGFuIGNsYXNzPVwic3RhdC12YWx1ZVwiPiR7dn08L3NwYW4+YFxuXHRcdFx0KS5qb2luKFwiXCIpO1xuXHRcdH1cblxuXHRcdHJldHVybiAvKiBodG1sICovIGA8IURPQ1RZUEUgaHRtbD5cbjxodG1sIGxhbmc9XCJlblwiPlxuPGhlYWQ+XG5cdDxtZXRhIGNoYXJzZXQ9XCJVVEYtOFwiPlxuXHQ8bWV0YSBuYW1lPVwidmlld3BvcnRcIiBjb250ZW50PVwid2lkdGg9ZGV2aWNlLXdpZHRoLCBpbml0aWFsLXNjYWxlPTEuMFwiPlxuXHQ8bWV0YSBodHRwLWVxdWl2PVwiQ29udGVudC1TZWN1cml0eS1Qb2xpY3lcIiBjb250ZW50PVwiZGVmYXVsdC1zcmMgJ25vbmUnOyBzdHlsZS1zcmMgJ3Vuc2FmZS1pbmxpbmUnOyBzY3JpcHQtc3JjICdub25jZS0ke25vbmNlfSc7XCI+XG5cdDxzdHlsZT5cblx0XHQqIHsgYm94LXNpemluZzogYm9yZGVyLWJveDsgbWFyZ2luOiAwOyBwYWRkaW5nOiAwOyB9XG5cdFx0Ym9keSB7XG5cdFx0XHRmb250LWZhbWlseTogdmFyKC0tdnNjb2RlLWZvbnQtZmFtaWx5KTtcblx0XHRcdGZvbnQtc2l6ZTogdmFyKC0tdnNjb2RlLWZvbnQtc2l6ZSk7XG5cdFx0XHRjb2xvcjogdmFyKC0tdnNjb2RlLWZvcmVncm91bmQpO1xuXHRcdFx0cGFkZGluZzogOHB4O1xuXHRcdH1cblxuXHRcdC8qIC0tLS0gSGVhZGVyIGNhcmQgLS0tLSAqL1xuXHRcdC5oZWFkZXIge1xuXHRcdFx0cGFkZGluZzogMTBweCAxMnB4O1xuXHRcdFx0Ym9yZGVyLXJhZGl1czogNnB4O1xuXHRcdFx0YmFja2dyb3VuZDogdmFyKC0tdnNjb2RlLWVkaXRvci1iYWNrZ3JvdW5kKTtcblx0XHRcdGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLXZzY29kZS1wYW5lbC1ib3JkZXIpO1xuXHRcdFx0bWFyZ2luLWJvdHRvbTogOHB4O1xuXHRcdH1cblx0XHQuaGVhZGVyLXRvcCB7XG5cdFx0XHRkaXNwbGF5OiBmbGV4O1xuXHRcdFx0YWxpZ24taXRlbXM6IGNlbnRlcjtcblx0XHRcdGdhcDogOHB4O1xuXHRcdH1cblx0XHQuc3RhdHVzLWRvdCB7XG5cdFx0XHR3aWR0aDogOHB4O1xuXHRcdFx0aGVpZ2h0OiA4cHg7XG5cdFx0XHRib3JkZXItcmFkaXVzOiA1MCU7XG5cdFx0XHRiYWNrZ3JvdW5kOiAke3N0YXR1c0NvbG9yfTtcblx0XHRcdGZsZXgtc2hyaW5rOiAwO1xuXHRcdH1cblx0XHQuc3RhdHVzLWxhYmVsIHtcblx0XHRcdGZvbnQtc2l6ZTogMTFweDtcblx0XHRcdG9wYWNpdHk6IDAuNztcblx0XHRcdGZsZXgtc2hyaW5rOiAwO1xuXHRcdH1cblx0XHQuaGVhZGVyLW1vZGVsIHtcblx0XHRcdG1hcmdpbi1sZWZ0OiBhdXRvO1xuXHRcdFx0Zm9udC1zaXplOiAxMXB4O1xuXHRcdFx0Zm9udC13ZWlnaHQ6IDYwMDtcblx0XHRcdG9wYWNpdHk6IDAuODU7XG5cdFx0XHRjdXJzb3I6IHBvaW50ZXI7XG5cdFx0XHR3aGl0ZS1zcGFjZTogbm93cmFwO1xuXHRcdFx0b3ZlcmZsb3c6IGhpZGRlbjtcblx0XHRcdHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzO1xuXHRcdH1cblx0XHQuaGVhZGVyLW1vZGVsOmhvdmVyIHsgb3BhY2l0eTogMTsgfVxuXHRcdC5oZWFkZXItY29zdCB7XG5cdFx0XHRmb250LXNpemU6IDExcHg7XG5cdFx0XHRmb250LXZhcmlhbnQtbnVtZXJpYzogdGFidWxhci1udW1zO1xuXHRcdFx0b3BhY2l0eTogMC42O1xuXHRcdFx0ZmxleC1zaHJpbms6IDA7XG5cdFx0fVxuXHRcdC5oZWFkZXItc3ViIHtcblx0XHRcdGRpc3BsYXk6IGZsZXg7XG5cdFx0XHRhbGlnbi1pdGVtczogY2VudGVyO1xuXHRcdFx0Z2FwOiA2cHg7XG5cdFx0XHRtYXJnaW4tdG9wOiA2cHg7XG5cdFx0XHRmb250LXNpemU6IDExcHg7XG5cdFx0XHRvcGFjaXR5OiAwLjY7XG5cdFx0fVxuXHRcdC5oZWFkZXItc3ViIC5zZXAgeyBvcGFjaXR5OiAwLjM7IH1cblx0XHQuc2Vzc2lvbi1uYW1lIHtcblx0XHRcdGN1cnNvcjogcG9pbnRlcjtcblx0XHRcdG1heC13aWR0aDogMTIwcHg7XG5cdFx0XHRvdmVyZmxvdzogaGlkZGVuO1xuXHRcdFx0dGV4dC1vdmVyZmxvdzogZWxsaXBzaXM7XG5cdFx0XHR3aGl0ZS1zcGFjZTogbm93cmFwO1xuXHRcdH1cblx0XHQuc2Vzc2lvbi1uYW1lOmhvdmVyIHsgb3BhY2l0eTogMTsgdGV4dC1kZWNvcmF0aW9uOiB1bmRlcmxpbmU7IH1cblxuXHRcdC8qIC0tLS0gU3RyZWFtaW5nIGJhbm5lciAtLS0tICovXG5cdFx0LnN0cmVhbWluZyB7XG5cdFx0XHRkaXNwbGF5OiBmbGV4O1xuXHRcdFx0YWxpZ24taXRlbXM6IGNlbnRlcjtcblx0XHRcdGdhcDogOHB4O1xuXHRcdFx0cGFkZGluZzogNnB4IDEwcHg7XG5cdFx0XHRtYXJnaW4tYm90dG9tOiA4cHg7XG5cdFx0XHRiYWNrZ3JvdW5kOiBjb2xvci1taXgoaW4gc3JnYiwgdmFyKC0tdnNjb2RlLWZvY3VzQm9yZGVyKSAxNSUsIHRyYW5zcGFyZW50KTtcblx0XHRcdGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLXZzY29kZS1mb2N1c0JvcmRlcik7XG5cdFx0XHRib3JkZXItcmFkaXVzOiA2cHg7XG5cdFx0XHRmb250LXNpemU6IDEycHg7XG5cdFx0fVxuXHRcdC5zcGlubmVyIHtcblx0XHRcdHdpZHRoOiAxMHB4OyBoZWlnaHQ6IDEwcHg7XG5cdFx0XHRib3JkZXI6IDJweCBzb2xpZCB2YXIoLS12c2NvZGUtZm9jdXNCb3JkZXIpO1xuXHRcdFx0Ym9yZGVyLXRvcC1jb2xvcjogdHJhbnNwYXJlbnQ7XG5cdFx0XHRib3JkZXItcmFkaXVzOiA1MCU7XG5cdFx0XHRhbmltYXRpb246IHNwaW4gMC44cyBsaW5lYXIgaW5maW5pdGU7XG5cdFx0XHRmbGV4LXNocmluazogMDtcblx0XHR9XG5cdFx0QGtleWZyYW1lcyBzcGluIHsgdG8geyB0cmFuc2Zvcm06IHJvdGF0ZSgzNjBkZWcpOyB9IH1cblx0XHQuc3RyZWFtaW5nLWFib3J0IHtcblx0XHRcdG1hcmdpbi1sZWZ0OiBhdXRvO1xuXHRcdFx0Zm9udC1zaXplOiAxMHB4O1xuXHRcdFx0cGFkZGluZzogMnB4IDhweDtcblx0XHRcdGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLXZzY29kZS1mb3JlZ3JvdW5kKTtcblx0XHRcdGJhY2tncm91bmQ6IHRyYW5zcGFyZW50O1xuXHRcdFx0Y29sb3I6IHZhcigtLXZzY29kZS1mb3JlZ3JvdW5kKTtcblx0XHRcdGJvcmRlci1yYWRpdXM6IDNweDtcblx0XHRcdGN1cnNvcjogcG9pbnRlcjtcblx0XHRcdG9wYWNpdHk6IDAuNjtcblx0XHR9XG5cdFx0LnN0cmVhbWluZy1hYm9ydDpob3ZlciB7IG9wYWNpdHk6IDE7IH1cblxuXHRcdC8qIC0tLS0gQ29udGV4dCBiYXIgKGlubGluZSBpbiBoZWFkZXIpIC0tLS0gKi9cblx0XHQuY29udGV4dC1iYXIge1xuXHRcdFx0bWFyZ2luLXRvcDogOHB4O1xuXHRcdH1cblx0XHQuY29udGV4dC10cmFjayB7XG5cdFx0XHR3aWR0aDogMTAwJTtcblx0XHRcdGhlaWdodDogM3B4O1xuXHRcdFx0YmFja2dyb3VuZDogdmFyKC0tdnNjb2RlLXBhbmVsLWJvcmRlcik7XG5cdFx0XHRib3JkZXItcmFkaXVzOiAycHg7XG5cdFx0XHRvdmVyZmxvdzogaGlkZGVuO1xuXHRcdH1cblx0XHQuY29udGV4dC1maWxsIHtcblx0XHRcdGhlaWdodDogMTAwJTtcblx0XHRcdGJvcmRlci1yYWRpdXM6IDJweDtcblx0XHRcdHRyYW5zaXRpb246IHdpZHRoIDAuM3MgZWFzZTtcblx0XHR9XG5cdFx0LmNvbnRleHQtdGV4dCB7XG5cdFx0XHRmb250LXNpemU6IDEwcHg7XG5cdFx0XHRvcGFjaXR5OiAwLjU7XG5cdFx0XHRtYXJnaW4tdG9wOiAycHg7XG5cdFx0fVxuXG5cdFx0LyogLS0tLSBDb2xsYXBzaWJsZSBzZWN0aW9uIC0tLS0gKi9cblx0XHQuc2VjdGlvbiB7XG5cdFx0XHRtYXJnaW4tYm90dG9tOiA2cHg7XG5cdFx0XHRib3JkZXI6IDFweCBzb2xpZCB2YXIoLS12c2NvZGUtcGFuZWwtYm9yZGVyKTtcblx0XHRcdGJvcmRlci1yYWRpdXM6IDZweDtcblx0XHRcdG92ZXJmbG93OiBoaWRkZW47XG5cdFx0fVxuXHRcdC5zZWN0aW9uLWhlYWRlciB7XG5cdFx0XHRkaXNwbGF5OiBmbGV4O1xuXHRcdFx0YWxpZ24taXRlbXM6IGNlbnRlcjtcblx0XHRcdGdhcDogNnB4O1xuXHRcdFx0cGFkZGluZzogNnB4IDEwcHg7XG5cdFx0XHRjdXJzb3I6IHBvaW50ZXI7XG5cdFx0XHR1c2VyLXNlbGVjdDogbm9uZTtcblx0XHRcdGZvbnQtc2l6ZTogMTFweDtcblx0XHRcdGZvbnQtd2VpZ2h0OiA2MDA7XG5cdFx0XHR0ZXh0LXRyYW5zZm9ybTogdXBwZXJjYXNlO1xuXHRcdFx0bGV0dGVyLXNwYWNpbmc6IDAuNXB4O1xuXHRcdFx0b3BhY2l0eTogMC43O1xuXHRcdFx0YmFja2dyb3VuZDogdmFyKC0tdnNjb2RlLWVkaXRvci1iYWNrZ3JvdW5kKTtcblx0XHR9XG5cdFx0LnNlY3Rpb24taGVhZGVyOmhvdmVyIHsgb3BhY2l0eTogMTsgfVxuXHRcdC5jaGV2cm9uIHtcblx0XHRcdGZvbnQtc2l6ZTogMTBweDtcblx0XHRcdHRyYW5zaXRpb246IHRyYW5zZm9ybSAwLjE1cztcblx0XHR9XG5cdFx0LnNlY3Rpb24uY29sbGFwc2VkIC5zZWN0aW9uLWJvZHkgeyBkaXNwbGF5OiBub25lOyB9XG5cdFx0LnNlY3Rpb24uY29sbGFwc2VkIC5jaGV2cm9uIHsgdHJhbnNmb3JtOiByb3RhdGUoLTkwZGVnKTsgfVxuXHRcdC5zZWN0aW9uLWJvZHkge1xuXHRcdFx0cGFkZGluZzogNnB4IDEwcHggOHB4O1xuXHRcdH1cblxuXHRcdC8qIC0tLS0gU3RhdHMgZ3JpZCAtLS0tICovXG5cdFx0LnN0YXRzLWdyaWQge1xuXHRcdFx0ZGlzcGxheTogZ3JpZDtcblx0XHRcdGdyaWQtdGVtcGxhdGUtY29sdW1uczogYXV0byAxZnI7XG5cdFx0XHRnYXA6IDJweCAxMHB4O1xuXHRcdFx0Zm9udC1zaXplOiAxMXB4O1xuXHRcdH1cblx0XHQuc3RhdC1sYWJlbCB7IG9wYWNpdHk6IDAuNjsgfVxuXHRcdC5zdGF0LXZhbHVlIHtcblx0XHRcdHRleHQtYWxpZ246IHJpZ2h0O1xuXHRcdFx0Zm9udC12YXJpYW50LW51bWVyaWM6IHRhYnVsYXItbnVtcztcblx0XHR9XG5cblx0XHQvKiAtLS0tIFRvZ2dsZSByb3cgLS0tLSAqL1xuXHRcdC50b2dnbGUtcm93IHtcblx0XHRcdGRpc3BsYXk6IGZsZXg7XG5cdFx0XHRhbGlnbi1pdGVtczogY2VudGVyO1xuXHRcdFx0anVzdGlmeS1jb250ZW50OiBzcGFjZS1iZXR3ZWVuO1xuXHRcdFx0cGFkZGluZzogM3B4IDA7XG5cdFx0XHRmb250LXNpemU6IDExcHg7XG5cdFx0fVxuXHRcdC50b2dnbGUtbGFiZWwgeyBvcGFjaXR5OiAwLjc7IH1cblx0XHQudG9nZ2xlLXBpbGwge1xuXHRcdFx0ZGlzcGxheTogaW5saW5lLWJsb2NrO1xuXHRcdFx0cGFkZGluZzogMXB4IDhweDtcblx0XHRcdGJvcmRlci1yYWRpdXM6IDEwcHg7XG5cdFx0XHRmb250LXNpemU6IDEwcHg7XG5cdFx0XHRjdXJzb3I6IHBvaW50ZXI7XG5cdFx0XHR0cmFuc2l0aW9uOiBhbGwgMC4xNXM7XG5cdFx0XHRib3JkZXI6IDFweCBzb2xpZCB0cmFuc3BhcmVudDtcblx0XHR9XG5cdFx0LnRvZ2dsZS1waWxsLm9uIHtcblx0XHRcdGJhY2tncm91bmQ6IGNvbG9yLW1peChpbiBzcmdiLCB2YXIoLS12c2NvZGUtZm9jdXNCb3JkZXIpIDMwJSwgdHJhbnNwYXJlbnQpO1xuXHRcdFx0Ym9yZGVyLWNvbG9yOiB2YXIoLS12c2NvZGUtZm9jdXNCb3JkZXIpO1xuXHRcdFx0Y29sb3I6IHZhcigtLXZzY29kZS1mb3JlZ3JvdW5kKTtcblx0XHR9XG5cdFx0LnRvZ2dsZS1waWxsLm9mZiB7XG5cdFx0XHRiYWNrZ3JvdW5kOiB0cmFuc3BhcmVudDtcblx0XHRcdGJvcmRlci1jb2xvcjogdmFyKC0tdnNjb2RlLXBhbmVsLWJvcmRlcik7XG5cdFx0XHRvcGFjaXR5OiAwLjU7XG5cdFx0fVxuXHRcdC50b2dnbGUtcGlsbDpob3ZlciB7IG9wYWNpdHk6IDE7IH1cblxuXHRcdC8qIC0tLS0gQnV0dG9ucyAtLS0tICovXG5cdFx0LmFjdGlvbnMge1xuXHRcdFx0ZGlzcGxheTogZ3JpZDtcblx0XHRcdGdyaWQtdGVtcGxhdGUtY29sdW1uczogMWZyIDFmcjtcblx0XHRcdGdhcDogNHB4O1xuXHRcdH1cblx0XHQuYWN0aW9ucy50aHJlZS1jb2wge1xuXHRcdFx0Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiAxZnIgMWZyIDFmcjtcblx0XHR9XG5cdFx0LmFjdGlvbi1idG4ge1xuXHRcdFx0ZGlzcGxheTogZmxleDtcblx0XHRcdGFsaWduLWl0ZW1zOiBjZW50ZXI7XG5cdFx0XHRqdXN0aWZ5LWNvbnRlbnQ6IGNlbnRlcjtcblx0XHRcdGdhcDogNHB4O1xuXHRcdFx0cGFkZGluZzogNXB4IDZweDtcblx0XHRcdGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLXZzY29kZS1wYW5lbC1ib3JkZXIpO1xuXHRcdFx0Ym9yZGVyLXJhZGl1czogNHB4O1xuXHRcdFx0YmFja2dyb3VuZDogdHJhbnNwYXJlbnQ7XG5cdFx0XHRjb2xvcjogdmFyKC0tdnNjb2RlLWZvcmVncm91bmQpO1xuXHRcdFx0Zm9udC1zaXplOiAxMXB4O1xuXHRcdFx0Y3Vyc29yOiBwb2ludGVyO1xuXHRcdFx0d2hpdGUtc3BhY2U6IG5vd3JhcDtcblx0XHRcdHdpZHRoOiBhdXRvO1xuXHRcdH1cblx0XHQuYWN0aW9uLWJ0bjpob3ZlciB7XG5cdFx0XHRiYWNrZ3JvdW5kOiB2YXIoLS12c2NvZGUtbGlzdC1ob3ZlckJhY2tncm91bmQpO1xuXHRcdFx0Ym9yZGVyLWNvbG9yOiB2YXIoLS12c2NvZGUtZm9jdXNCb3JkZXIpO1xuXHRcdH1cblx0XHQuYWN0aW9uLWJ0bi5wcmltYXJ5IHtcblx0XHRcdGJhY2tncm91bmQ6IHZhcigtLXZzY29kZS1idXR0b24tYmFja2dyb3VuZCk7XG5cdFx0XHRjb2xvcjogdmFyKC0tdnNjb2RlLWJ1dHRvbi1mb3JlZ3JvdW5kKTtcblx0XHRcdGJvcmRlci1jb2xvcjogdmFyKC0tdnNjb2RlLWJ1dHRvbi1iYWNrZ3JvdW5kKTtcblx0XHRcdGZvbnQtd2VpZ2h0OiA2MDA7XG5cdFx0fVxuXHRcdC5hY3Rpb24tYnRuLnByaW1hcnk6aG92ZXIge1xuXHRcdFx0YmFja2dyb3VuZDogdmFyKC0tdnNjb2RlLWJ1dHRvbi1ob3ZlckJhY2tncm91bmQpO1xuXHRcdH1cblx0XHQuYWN0aW9uLWJ0bi5kYW5nZXIge1xuXHRcdFx0Ym9yZGVyLWNvbG9yOiAjZjQ0NzQ3O1xuXHRcdFx0Y29sb3I6ICNmNDQ3NDc7XG5cdFx0fVxuXHRcdC5hY3Rpb24tYnRuLmRhbmdlcjpob3ZlciB7XG5cdFx0XHRiYWNrZ3JvdW5kOiBjb2xvci1taXgoaW4gc3JnYiwgI2Y0NDc0NyAxNSUsIHRyYW5zcGFyZW50KTtcblx0XHR9XG5cdFx0LmFjdGlvbi1idG4uZnVsbCB7XG5cdFx0XHRncmlkLWNvbHVtbjogMSAvIC0xO1xuXHRcdH1cblxuXHRcdC8qIC0tLS0gRGlzY29ubmVjdGVkIHN0YXRlIC0tLS0gKi9cblx0XHQuZGlzY29ubmVjdGVkIHtcblx0XHRcdHRleHQtYWxpZ246IGNlbnRlcjtcblx0XHRcdHBhZGRpbmc6IDIwcHggMTJweDtcblx0XHR9XG5cdFx0LmRpc2Nvbm5lY3RlZCBwIHtcblx0XHRcdG9wYWNpdHk6IDAuNTtcblx0XHRcdGZvbnQtc2l6ZTogMTJweDtcblx0XHRcdG1hcmdpbi1ib3R0b206IDEycHg7XG5cdFx0fVxuXHRcdC5zdGFydC1idG4ge1xuXHRcdFx0cGFkZGluZzogOHB4IDI0cHg7XG5cdFx0XHRib3JkZXI6IG5vbmU7XG5cdFx0XHRib3JkZXItcmFkaXVzOiA0cHg7XG5cdFx0XHRjdXJzb3I6IHBvaW50ZXI7XG5cdFx0XHRmb250LXNpemU6IHZhcigtLXZzY29kZS1mb250LXNpemUpO1xuXHRcdFx0Zm9udC13ZWlnaHQ6IDYwMDtcblx0XHRcdGNvbG9yOiB2YXIoLS12c2NvZGUtYnV0dG9uLWZvcmVncm91bmQpO1xuXHRcdFx0YmFja2dyb3VuZDogdmFyKC0tdnNjb2RlLWJ1dHRvbi1iYWNrZ3JvdW5kKTtcblx0XHRcdHdpZHRoOiBhdXRvO1xuXHRcdFx0ZGlzcGxheTogaW5saW5lLWJsb2NrO1xuXHRcdH1cblx0XHQuc3RhcnQtYnRuOmhvdmVyIHtcblx0XHRcdGJhY2tncm91bmQ6IHZhcigtLXZzY29kZS1idXR0b24taG92ZXJCYWNrZ3JvdW5kKTtcblx0XHR9XG5cdDwvc3R5bGU+XG48L2hlYWQ+XG48Ym9keT5cblx0JHtpbmZvLmNvbm5lY3RlZCA/IHRoaXMuZ2V0Q29ubmVjdGVkSHRtbChpbmZvLCB7XG5cdFx0XHRzdGF0dXNMYWJlbCxcblx0XHRcdG1vZGVsRGlzcGxheSxcblx0XHRcdHNlc3Npb25EaXNwbGF5LFxuXHRcdFx0Y29zdERpc3BsYXksXG5cdFx0XHRjb250ZXh0VXNhZ2UsXG5cdFx0XHR0b3RhbFRva2Vucyxcblx0XHRcdGhhc1N0YXRzOiAhIWhhc1N0YXRzLFxuXHRcdFx0c3RhdFJvd3MsXG5cdFx0XHRub25jZSxcblx0XHR9KSA6IGBcblx0PGRpdiBjbGFzcz1cImhlYWRlclwiPlxuXHRcdDxkaXYgY2xhc3M9XCJoZWFkZXItdG9wXCI+XG5cdFx0XHQ8ZGl2IGNsYXNzPVwic3RhdHVzLWRvdFwiPjwvZGl2PlxuXHRcdFx0PHNwYW4gY2xhc3M9XCJzdGF0dXMtbGFiZWxcIj5EaXNjb25uZWN0ZWQ8L3NwYW4+XG5cdFx0PC9kaXY+XG5cdDwvZGl2PlxuXHQ8ZGl2IGNsYXNzPVwiZGlzY29ubmVjdGVkXCI+XG5cdFx0PHA+QWdlbnQgaXMgbm90IHJ1bm5pbmc8L3A+XG5cdFx0PGJ1dHRvbiBjbGFzcz1cInN0YXJ0LWJ0blwiIGRhdGEtY29tbWFuZD1cInN0YXJ0XCI+U3RhcnQgQWdlbnQ8L2J1dHRvbj5cblx0PC9kaXY+XG5cdGB9XG5cblx0PHNjcmlwdCBub25jZT1cIiR7bm9uY2V9XCI+XG5cdFx0Y29uc3QgdnNjb2RlID0gYWNxdWlyZVZzQ29kZUFwaSgpO1xuXHRcdGNvbnN0IHN0b3JlZCA9IHZzY29kZS5nZXRTdGF0ZSgpIHx8IHt9O1xuXG5cdFx0Ly8gUmVzdG9yZSBjb2xsYXBzZWQgc3RhdGVcblx0XHRkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2VjdGlvbicpLmZvckVhY2gocyA9PiB7XG5cdFx0XHRjb25zdCBpZCA9IHMuZGF0YXNldC5zZWN0aW9uO1xuXHRcdFx0aWYgKGlkICYmIHN0b3JlZFtpZF0gPT09ICdjb2xsYXBzZWQnKSBzLmNsYXNzTGlzdC5hZGQoJ2NvbGxhcHNlZCcpO1xuXHRcdH0pO1xuXG5cdFx0ZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoZSkgPT4ge1xuXHRcdFx0Ly8gU2VjdGlvbiB0b2dnbGVcblx0XHRcdGNvbnN0IGhlYWRlciA9IGUudGFyZ2V0LmNsb3Nlc3QoJy5zZWN0aW9uLWhlYWRlcicpO1xuXHRcdFx0aWYgKGhlYWRlcikge1xuXHRcdFx0XHRjb25zdCBzZWN0aW9uID0gaGVhZGVyLnBhcmVudEVsZW1lbnQ7XG5cdFx0XHRcdHNlY3Rpb24uY2xhc3NMaXN0LnRvZ2dsZSgnY29sbGFwc2VkJyk7XG5cdFx0XHRcdGNvbnN0IGlkID0gc2VjdGlvbi5kYXRhc2V0LnNlY3Rpb247XG5cdFx0XHRcdGlmIChpZCkge1xuXHRcdFx0XHRcdGNvbnN0IHN0YXRlID0gdnNjb2RlLmdldFN0YXRlKCkgfHwge307XG5cdFx0XHRcdFx0c3RhdGVbaWRdID0gc2VjdGlvbi5jbGFzc0xpc3QuY29udGFpbnMoJ2NvbGxhcHNlZCcpID8gJ2NvbGxhcHNlZCcgOiAnb3Blbic7XG5cdFx0XHRcdFx0dnNjb2RlLnNldFN0YXRlKHN0YXRlKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cdFx0XHQvLyBCdXR0b24vY29tbWFuZCBjbGlja1xuXHRcdFx0Y29uc3QgYnRuID0gZS50YXJnZXQuY2xvc2VzdCgnW2RhdGEtY29tbWFuZF0nKTtcblx0XHRcdGlmIChidG4pIHtcblx0XHRcdFx0dnNjb2RlLnBvc3RNZXNzYWdlKHsgY29tbWFuZDogYnRuLmRhdGFzZXQuY29tbWFuZCB9KTtcblx0XHRcdH1cblx0XHR9KTtcblx0PC9zY3JpcHQ+XG48L2JvZHk+XG48L2h0bWw+YDtcblx0fVxuXG5cdHByaXZhdGUgZ2V0Q29ubmVjdGVkSHRtbChcblx0XHRpbmZvOiB7XG5cdFx0XHRjb25uZWN0ZWQ6IGJvb2xlYW47XG5cdFx0XHRtb2RlbE5hbWU6IHN0cmluZztcblx0XHRcdG1vZGVsU2hvcnQ6IHN0cmluZztcblx0XHRcdHNlc3Npb25JZDogc3RyaW5nO1xuXHRcdFx0c2Vzc2lvbk5hbWU6IHN0cmluZztcblx0XHRcdG1lc3NhZ2VDb3VudDogbnVtYmVyO1xuXHRcdFx0cGVuZGluZ01lc3NhZ2VDb3VudDogbnVtYmVyO1xuXHRcdFx0dGhpbmtpbmdMZXZlbDogVGhpbmtpbmdMZXZlbDtcblx0XHRcdGlzU3RyZWFtaW5nOiBib29sZWFuO1xuXHRcdFx0aXNDb21wYWN0aW5nOiBib29sZWFuO1xuXHRcdFx0YXV0b0NvbXBhY3Rpb246IGJvb2xlYW47XG5cdFx0XHRhdXRvUmV0cnk6IGJvb2xlYW47XG5cdFx0XHRzdGF0czogU2Vzc2lvblN0YXRzIHwgbnVsbDtcblx0XHRcdHN0ZWVyaW5nTW9kZTogXCJhbGxcIiB8IFwib25lLWF0LWEtdGltZVwiO1xuXHRcdFx0Zm9sbG93VXBNb2RlOiBcImFsbFwiIHwgXCJvbmUtYXQtYS10aW1lXCI7XG5cdFx0fSxcblx0XHR1aToge1xuXHRcdFx0c3RhdHVzTGFiZWw6IHN0cmluZztcblx0XHRcdG1vZGVsRGlzcGxheTogc3RyaW5nO1xuXHRcdFx0c2Vzc2lvbkRpc3BsYXk6IHN0cmluZztcblx0XHRcdGNvc3REaXNwbGF5OiBzdHJpbmc7XG5cdFx0XHRjb250ZXh0VXNhZ2U6IFJldHVyblR5cGU8dHlwZW9mIGdldENvbnRleHRVc2FnZURpc3BsYXk+O1xuXHRcdFx0dG90YWxUb2tlbnM6IG51bWJlcjtcblx0XHRcdGhhc1N0YXRzOiBib29sZWFuO1xuXHRcdFx0c3RhdFJvd3M6IHN0cmluZztcblx0XHRcdG5vbmNlOiBzdHJpbmc7XG5cdFx0fSxcblx0KTogc3RyaW5nIHtcblx0XHRjb25zdCBwZW5kaW5nQmFkZ2UgPSBpbmZvLnBlbmRpbmdNZXNzYWdlQ291bnQgPiAwXG5cdFx0XHQ/IGAgPHNwYW4gc3R5bGU9XCJvcGFjaXR5OjAuNVwiPiske2luZm8ucGVuZGluZ01lc3NhZ2VDb3VudH08L3NwYW4+YFxuXHRcdFx0OiBcIlwiO1xuXG5cdFx0cmV0dXJuIGBcblx0PCEtLSBIZWFkZXIgY2FyZCAtLT5cblx0PGRpdiBjbGFzcz1cImhlYWRlclwiPlxuXHRcdDxkaXYgY2xhc3M9XCJoZWFkZXItdG9wXCI+XG5cdFx0XHQ8ZGl2IGNsYXNzPVwic3RhdHVzLWRvdFwiPjwvZGl2PlxuXHRcdFx0PHNwYW4gY2xhc3M9XCJzdGF0dXMtbGFiZWxcIj4ke3VpLnN0YXR1c0xhYmVsfTwvc3Bhbj5cblx0XHRcdDxzcGFuIGNsYXNzPVwiaGVhZGVyLW1vZGVsXCIgZGF0YS1jb21tYW5kPVwic3dpdGNoTW9kZWxcIiB0aXRsZT1cIiR7ZXNjYXBlSHRtbChpbmZvLm1vZGVsTmFtZSl9XCI+JHtlc2NhcGVIdG1sKHVpLm1vZGVsRGlzcGxheSl9PC9zcGFuPlxuXHRcdFx0JHt1aS5jb3N0RGlzcGxheSA/IGA8c3BhbiBjbGFzcz1cImhlYWRlci1jb3N0XCI+JHt1aS5jb3N0RGlzcGxheX08L3NwYW4+YCA6IFwiXCJ9XG5cdFx0PC9kaXY+XG5cdFx0PGRpdiBjbGFzcz1cImhlYWRlci1zdWJcIj5cblx0XHRcdDxzcGFuIGNsYXNzPVwic2Vzc2lvbi1uYW1lXCIgZGF0YS1jb21tYW5kPVwic2V0U2Vzc2lvbk5hbWVcIiB0aXRsZT1cIiR7ZXNjYXBlSHRtbChpbmZvLnNlc3Npb25JZCl9XCI+JHtlc2NhcGVIdG1sKHVpLnNlc3Npb25EaXNwbGF5KX08L3NwYW4+XG5cdFx0XHQ8c3BhbiBjbGFzcz1cInNlcFwiPi88L3NwYW4+XG5cdFx0XHQ8c3Bhbj4ke2luZm8ubWVzc2FnZUNvdW50fSBtc2cke3BlbmRpbmdCYWRnZX08L3NwYW4+XG5cdFx0XHQ8c3BhbiBjbGFzcz1cInNlcFwiPi88L3NwYW4+XG5cdFx0XHQ8c3BhbiBkYXRhLWNvbW1hbmQ9XCJjeWNsZVRoaW5raW5nXCIgc3R5bGU9XCJjdXJzb3I6cG9pbnRlclwiIHRpdGxlPVwiQ2xpY2sgdG8gY3ljbGUgdGhpbmtpbmcgbGV2ZWxcIj4ke2luZm8udGhpbmtpbmdMZXZlbCA9PT0gXCJvZmZcIiA/IFwibm8gdGhpbmtcIiA6IGluZm8udGhpbmtpbmdMZXZlbH08L3NwYW4+XG5cdFx0PC9kaXY+XG5cdFx0PGRpdiBjbGFzcz1cImNvbnRleHQtYmFyXCI+XG5cdFx0XHQke3VpLmNvbnRleHRVc2FnZS5wZXJjZW50ICE9PSBudWxsID8gYFxuXHRcdFx0PGRpdiBjbGFzcz1cImNvbnRleHQtdHJhY2tcIj5cblx0XHRcdFx0PGRpdiBjbGFzcz1cImNvbnRleHQtZmlsbFwiIHN0eWxlPVwid2lkdGg6JHt1aS5jb250ZXh0VXNhZ2UucGVyY2VudH0lO2JhY2tncm91bmQ6IzRlYzliMFwiPjwvZGl2PlxuXHRcdFx0PC9kaXY+XG5cdFx0XHRgIDogXCJcIn1cblx0XHRcdDxkaXYgY2xhc3M9XCJjb250ZXh0LXRleHRcIj4ke2VzY2FwZUh0bWwodWkuY29udGV4dFVzYWdlLnRleHQpfSR7dWkudG90YWxUb2tlbnMgPyBgIC8gU2Vzc2lvbiB0b2tlbnM6ICR7Zm9ybWF0TnVtKHVpLnRvdGFsVG9rZW5zKX1gIDogXCJcIn08L2Rpdj5cblx0XHQ8L2Rpdj5cblx0PC9kaXY+XG5cblx0JHtpbmZvLmlzU3RyZWFtaW5nID8gYFxuXHQ8ZGl2IGNsYXNzPVwic3RyZWFtaW5nXCI+XG5cdFx0PHNwYW4gY2xhc3M9XCJzcGlubmVyXCI+PC9zcGFuPlxuXHRcdDxzcGFuPkFnZW50IGlzIHdvcmtpbmcuLi48L3NwYW4+XG5cdFx0PGJ1dHRvbiBjbGFzcz1cInN0cmVhbWluZy1hYm9ydFwiIGRhdGEtY29tbWFuZD1cImFib3J0XCI+U3RvcDwvYnV0dG9uPlxuXHQ8L2Rpdj5cblx0YCA6IFwiXCJ9XG5cblx0PCEtLSBXb3JrZmxvdyAtLT5cblx0PGRpdiBjbGFzcz1cInNlY3Rpb25cIiBkYXRhLXNlY3Rpb249XCJ3b3JrZmxvd1wiPlxuXHRcdDxkaXYgY2xhc3M9XCJzZWN0aW9uLWhlYWRlclwiPjxzcGFuIGNsYXNzPVwiY2hldnJvblwiPiYjOTY2MDs8L3NwYW4+IFdvcmtmbG93PC9kaXY+XG5cdFx0PGRpdiBjbGFzcz1cInNlY3Rpb24tYm9keVwiPlxuXHRcdFx0PGRpdiBjbGFzcz1cImFjdGlvbnNcIj5cblx0XHRcdFx0PGJ1dHRvbiBjbGFzcz1cImFjdGlvbi1idG4gcHJpbWFyeVwiIGRhdGEtY29tbWFuZD1cImF1dG9Nb2RlXCI+QXV0bzwvYnV0dG9uPlxuXHRcdFx0XHQ8YnV0dG9uIGNsYXNzPVwiYWN0aW9uLWJ0blwiIGRhdGEtY29tbWFuZD1cIm5leHRVbml0XCI+TmV4dDwvYnV0dG9uPlxuXHRcdFx0XHQ8YnV0dG9uIGNsYXNzPVwiYWN0aW9uLWJ0blwiIGRhdGEtY29tbWFuZD1cInF1aWNrVGFza1wiPlF1aWNrPC9idXR0b24+XG5cdFx0XHRcdDxidXR0b24gY2xhc3M9XCJhY3Rpb24tYnRuXCIgZGF0YS1jb21tYW5kPVwiY2FwdHVyZVwiPkNhcHR1cmU8L2J1dHRvbj5cblx0XHRcdDwvZGl2PlxuXHRcdDwvZGl2PlxuXHQ8L2Rpdj5cblxuXHQke3VpLmhhc1N0YXRzID8gYFxuXHQ8IS0tIFN0YXRzIC0tPlxuXHQ8ZGl2IGNsYXNzPVwic2VjdGlvblwiIGRhdGEtc2VjdGlvbj1cInN0YXRzXCI+XG5cdFx0PGRpdiBjbGFzcz1cInNlY3Rpb24taGVhZGVyXCI+PHNwYW4gY2xhc3M9XCJjaGV2cm9uXCI+JiM5NjYwOzwvc3Bhbj4gU3RhdHM8L2Rpdj5cblx0XHQ8ZGl2IGNsYXNzPVwic2VjdGlvbi1ib2R5XCI+XG5cdFx0XHQ8ZGl2IGNsYXNzPVwic3RhdHMtZ3JpZFwiPiR7dWkuc3RhdFJvd3N9PC9kaXY+XG5cdFx0PC9kaXY+XG5cdDwvZGl2PlxuXHRgIDogXCJcIn1cblxuXHQ8IS0tIEFjdGlvbnMgLS0+XG5cdDxkaXYgY2xhc3M9XCJzZWN0aW9uXCIgZGF0YS1zZWN0aW9uPVwiYWN0aW9uc1wiPlxuXHRcdDxkaXYgY2xhc3M9XCJzZWN0aW9uLWhlYWRlclwiPjxzcGFuIGNsYXNzPVwiY2hldnJvblwiPiYjOTY2MDs8L3NwYW4+IEFjdGlvbnM8L2Rpdj5cblx0XHQ8ZGl2IGNsYXNzPVwic2VjdGlvbi1ib2R5XCI+XG5cdFx0XHQ8ZGl2IGNsYXNzPVwiYWN0aW9ucyB0aHJlZS1jb2xcIj5cblx0XHRcdFx0PGJ1dHRvbiBjbGFzcz1cImFjdGlvbi1idG5cIiBkYXRhLWNvbW1hbmQ9XCJuZXdTZXNzaW9uXCI+TmV3PC9idXR0b24+XG5cdFx0XHRcdDxidXR0b24gY2xhc3M9XCJhY3Rpb24tYnRuXCIgZGF0YS1jb21tYW5kPVwiY29tcGFjdFwiPkNvbXBhY3Q8L2J1dHRvbj5cblx0XHRcdFx0PGJ1dHRvbiBjbGFzcz1cImFjdGlvbi1idG5cIiBkYXRhLWNvbW1hbmQ9XCJjb3B5TGFzdFJlc3BvbnNlXCI+Q29weTwvYnV0dG9uPlxuXHRcdFx0XHQ8YnV0dG9uIGNsYXNzPVwiYWN0aW9uLWJ0blwiIGRhdGEtY29tbWFuZD1cInN0YXR1c1wiPlN0YXR1czwvYnV0dG9uPlxuXHRcdFx0XHQ8YnV0dG9uIGNsYXNzPVwiYWN0aW9uLWJ0blwiIGRhdGEtY29tbWFuZD1cImZpeFByb2JsZW1zSW5GaWxlXCI+Rml4IEVycnM8L2J1dHRvbj5cblx0XHRcdFx0PGJ1dHRvbiBjbGFzcz1cImFjdGlvbi1idG5cIiBkYXRhLWNvbW1hbmQ9XCJzaG93SGlzdG9yeVwiPkhpc3Rvcnk8L2J1dHRvbj5cblx0XHRcdDwvZGl2PlxuXHRcdFx0PGRpdiBzdHlsZT1cIm1hcmdpbi10b3A6NnB4XCI+XG5cdFx0XHRcdDxidXR0b24gY2xhc3M9XCJhY3Rpb24tYnRuIGRhbmdlciBmdWxsXCIgZGF0YS1jb21tYW5kPVwic3RvcFwiPlN0b3AgQWdlbnQ8L2J1dHRvbj5cblx0XHRcdDwvZGl2PlxuXHRcdDwvZGl2PlxuXHQ8L2Rpdj5cblxuXHQ8IS0tIFNldHRpbmdzIChjb2xsYXBzZWQgYnkgZGVmYXVsdCkgLS0+XG5cdDxkaXYgY2xhc3M9XCJzZWN0aW9uIGNvbGxhcHNlZFwiIGRhdGEtc2VjdGlvbj1cInNldHRpbmdzXCI+XG5cdFx0PGRpdiBjbGFzcz1cInNlY3Rpb24taGVhZGVyXCI+PHNwYW4gY2xhc3M9XCJjaGV2cm9uXCI+JiM5NjYwOzwvc3Bhbj4gU2V0dGluZ3M8L2Rpdj5cblx0XHQ8ZGl2IGNsYXNzPVwic2VjdGlvbi1ib2R5XCI+XG5cdFx0XHQ8ZGl2IGNsYXNzPVwidG9nZ2xlLXJvd1wiPlxuXHRcdFx0XHQ8c3BhbiBjbGFzcz1cInRvZ2dsZS1sYWJlbFwiPkF1dG8tY29tcGFjdDwvc3Bhbj5cblx0XHRcdFx0PHNwYW4gY2xhc3M9XCJ0b2dnbGUtcGlsbCAke2luZm8uYXV0b0NvbXBhY3Rpb24gPyBcIm9uXCIgOiBcIm9mZlwifVwiIGRhdGEtY29tbWFuZD1cInRvZ2dsZUF1dG9Db21wYWN0aW9uXCI+JHtpbmZvLmF1dG9Db21wYWN0aW9uID8gXCJvblwiIDogXCJvZmZcIn08L3NwYW4+XG5cdFx0XHQ8L2Rpdj5cblx0XHRcdDxkaXYgY2xhc3M9XCJ0b2dnbGUtcm93XCI+XG5cdFx0XHRcdDxzcGFuIGNsYXNzPVwidG9nZ2xlLWxhYmVsXCI+QXV0by1yZXRyeTwvc3Bhbj5cblx0XHRcdFx0PHNwYW4gY2xhc3M9XCJ0b2dnbGUtcGlsbCAke2luZm8uYXV0b1JldHJ5ID8gXCJvblwiIDogXCJvZmZcIn1cIiBkYXRhLWNvbW1hbmQ9XCJ0b2dnbGVBdXRvUmV0cnlcIj4ke2luZm8uYXV0b1JldHJ5ID8gXCJvblwiIDogXCJvZmZcIn08L3NwYW4+XG5cdFx0XHQ8L2Rpdj5cblx0XHRcdDxkaXYgY2xhc3M9XCJ0b2dnbGUtcm93XCI+XG5cdFx0XHRcdDxzcGFuIGNsYXNzPVwidG9nZ2xlLWxhYmVsXCI+U3RlZXJpbmc8L3NwYW4+XG5cdFx0XHRcdDxzcGFuIGNsYXNzPVwidG9nZ2xlLXBpbGwgJHtpbmZvLnN0ZWVyaW5nTW9kZSA9PT0gXCJvbmUtYXQtYS10aW1lXCIgPyBcIm9uXCIgOiBcIm9mZlwifVwiIGRhdGEtY29tbWFuZD1cInRvZ2dsZVN0ZWVyaW5nTW9kZVwiPiR7aW5mby5zdGVlcmluZ01vZGUgPT09IFwib25lLWF0LWEtdGltZVwiID8gXCIxLWF0LWEtdGltZVwiIDogXCJhbGxcIn08L3NwYW4+XG5cdFx0XHQ8L2Rpdj5cblx0XHRcdDxkaXYgY2xhc3M9XCJ0b2dnbGUtcm93XCI+XG5cdFx0XHRcdDxzcGFuIGNsYXNzPVwidG9nZ2xlLWxhYmVsXCI+Rm9sbG93LXVwPC9zcGFuPlxuXHRcdFx0XHQ8c3BhbiBjbGFzcz1cInRvZ2dsZS1waWxsICR7aW5mby5mb2xsb3dVcE1vZGUgPT09IFwib25lLWF0LWEtdGltZVwiID8gXCJvblwiIDogXCJvZmZcIn1cIiBkYXRhLWNvbW1hbmQ9XCJ0b2dnbGVGb2xsb3dVcE1vZGVcIj4ke2luZm8uZm9sbG93VXBNb2RlID09PSBcIm9uZS1hdC1hLXRpbWVcIiA/IFwiMS1hdC1hLXRpbWVcIiA6IFwiYWxsXCJ9PC9zcGFuPlxuXHRcdFx0PC9kaXY+XG5cdFx0XHQ8ZGl2IGNsYXNzPVwidG9nZ2xlLXJvd1wiPlxuXHRcdFx0XHQ8c3BhbiBjbGFzcz1cInRvZ2dsZS1sYWJlbFwiPkFwcHJvdmFsPC9zcGFuPlxuXHRcdFx0XHQ8c3BhbiBjbGFzcz1cInRvZ2dsZS1waWxsIG9uXCIgZGF0YS1jb21tYW5kPVwic2VsZWN0QXBwcm92YWxNb2RlXCI+Y2hhbmdlPC9zcGFuPlxuXHRcdFx0PC9kaXY+XG5cdFx0PC9kaXY+XG5cdDwvZGl2PmA7XG5cdH1cbn1cblxuZnVuY3Rpb24gZXNjYXBlSHRtbCh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRyZXR1cm4gdGV4dFxuXHRcdC5yZXBsYWNlKC8mL2csIFwiJmFtcDtcIilcblx0XHQucmVwbGFjZSgvPC9nLCBcIiZsdDtcIilcblx0XHQucmVwbGFjZSgvPi9nLCBcIiZndDtcIilcblx0XHQucmVwbGFjZSgvXCIvZywgXCImcXVvdDtcIik7XG59XG5cbmZ1bmN0aW9uIGZvcm1hdE51bShuOiBudW1iZXIpOiBzdHJpbmcge1xuXHRpZiAobiA+PSAxXzAwMF8wMDApIHJldHVybiBgJHsobiAvIDFfMDAwXzAwMCkudG9GaXhlZCgxKX1NYDtcblx0aWYgKG4gPj0gMV8wMDApIHJldHVybiBgJHsobiAvIDFfMDAwKS50b0ZpeGVkKDEpfWtgO1xuXHRyZXR1cm4gU3RyaW5nKG4pO1xufVxuXG5mdW5jdGlvbiBnZXROb25jZSgpOiBzdHJpbmcge1xuXHRjb25zdCBjaGFycyA9IFwiQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODlcIjtcblx0bGV0IG5vbmNlID0gXCJcIjtcblx0Zm9yIChsZXQgaSA9IDA7IGkgPCAzMjsgaSsrKSB7XG5cdFx0bm9uY2UgKz0gY2hhcnMuY2hhckF0KE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIGNoYXJzLmxlbmd0aCkpO1xuXHR9XG5cdHJldHVybiBub25jZTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUdBLFlBQVksWUFBWTtBQUV4QjtBQUFBLEVBQ0M7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDTTtBQU1QLGVBQWUsWUFBWSxTQUFnQztBQUMxRCxRQUFNLE9BQU8sU0FBUyxlQUFlLDhCQUE4QixFQUFFLE9BQU8sUUFBUSxDQUFDO0FBQ3RGO0FBT08sTUFBTSxtQkFBeUQ7QUFBQSxFQU9yRSxZQUNrQixjQUNBLFFBQ2hCO0FBRmdCO0FBQ0E7QUFFakIsU0FBSyxZQUFZO0FBQUEsTUFDaEIsT0FBTyxtQkFBbUIsTUFBTSxLQUFLLFFBQVEsQ0FBQztBQUFBLE1BQzlDLE9BQU8sUUFBUSxDQUFDLFFBQVE7QUFDdkIsZ0JBQVEsSUFBSSxNQUFNO0FBQUEsVUFDakIsS0FBSztBQUFBLFVBQ0wsS0FBSztBQUFBLFVBQ0wsS0FBSztBQUFB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O0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFB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
