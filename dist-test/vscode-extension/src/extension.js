import * as vscode from "vscode";
import { pickTrustedConfigurationValue } from "./trusted-config.js";
import { GsdClient } from "./gsd-client.js";
import { registerChatParticipant } from "./chat-participant.js";
import { GsdSidebarProvider } from "./sidebar.js";
import { GsdFileDecorationProvider } from "./file-decorations.js";
import { GsdBashTerminal } from "./bash-terminal.js";
import { GsdSessionTreeProvider } from "./session-tree.js";
import { GsdConversationHistoryPanel } from "./conversation-history.js";
import { GsdSlashCompletionProvider } from "./slash-completion.js";
import { GsdCodeLensProvider } from "./code-lens.js";
import { GsdActivityFeedProvider } from "./activity-feed.js";
import { GsdChangeTracker } from "./change-tracker.js";
import { GsdScmProvider } from "./scm-provider.js";
import { GsdDiagnosticBridge } from "./diagnostics.js";
import { GsdLineDecorationManager } from "./line-decorations.js";
import { GsdGitIntegration } from "./git-integration.js";
import { GsdPermissionManager } from "./permissions.js";
import { GsdPlanViewerProvider } from "./plan-viewer.js";
import { GsdCheckpointProvider } from "./checkpoints.js";
import {
  formatSessionStatsLines,
  getBashExitCode,
  getBashOutput,
  getSessionCost,
  getSessionTotalTokens
} from "./rpc-display.js";
let client;
let sidebarProvider;
let fileDecorations;
let sessionTreeProvider;
let activityFeedProvider;
let planViewerProvider;
let checkpointProvider;
let changeTracker;
let scmProvider;
let diagnosticBridge;
let lineDecorations;
let gitIntegration;
let permissionManager;
function getTrustedConfigurationValue(section, key, fallback) {
  const config = vscode.workspace.getConfiguration(section);
  return pickTrustedConfigurationValue(config.inspect(key), fallback);
}
function resolveTrustedGsdStartupConfig() {
  return {
    binaryPath: getTrustedConfigurationValue("gsd", "binaryPath", "gsd"),
    autoStart: getTrustedConfigurationValue("gsd", "autoStart", false)
  };
}
function requireConnected() {
  if (!client?.isConnected) {
    vscode.window.showWarningMessage("GSD agent is not running.");
    return false;
  }
  return true;
}
function handleError(err, context) {
  const msg = err instanceof Error ? err.message : String(err);
  vscode.window.showErrorMessage(`${context}: ${msg}`);
}
function activate(context) {
  const startupConfig = resolveTrustedGsdStartupConfig();
  const config = vscode.workspace.getConfiguration("gsd");
  const binaryPath = startupConfig.binaryPath;
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  client = new GsdClient(binaryPath, cwd);
  context.subscriptions.push(client);
  const outputChannel = vscode.window.createOutputChannel("GSD-2 Agent");
  context.subscriptions.push(outputChannel);
  client.onError((msg) => {
    outputChannel.appendLine(`[stderr] ${msg}`);
  });
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  statusBarItem.command = "workbench.view.extension.gsd";
  statusBarItem.text = "$(hubot) GSD";
  statusBarItem.tooltip = "GSD Agent \u2014 click to open";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
  async function refreshStatusBar() {
    if (!client?.isConnected) {
      statusBarItem.text = "$(hubot) GSD";
      statusBarItem.tooltip = "GSD: Disconnected";
      return;
    }
    try {
      const [state, stats] = await Promise.all([
        client.getState().catch(() => null),
        client.getSessionStats().catch(() => null)
      ]);
      const modelId = state?.model?.id ?? "";
      const cost = getSessionCost(stats);
      const costPart = cost > 0 ? ` | $${cost.toFixed(4)}` : "";
      const streamPart = state?.isStreaming ? " $(sync~spin)" : "";
      statusBarItem.text = `$(hubot) GSD${modelId ? ` | ${modelId}` : ""}${costPart}${streamPart}`;
      statusBarItem.tooltip = state?.model ? `GSD: Connected \u2014 ${state.model.provider}/${state.model.id}` : "GSD: Connected";
    } catch {
    }
  }
  const statusBarTimer = setInterval(() => refreshStatusBar(), 1e4);
  context.subscriptions.push({ dispose: () => clearInterval(statusBarTimer) });
  client.onConnectionChange(async (connected) => {
    await refreshStatusBar();
    if (connected) {
      vscode.window.setStatusBarMessage("$(hubot) GSD connected", 3e3);
    } else {
      vscode.window.setStatusBarMessage("$(hubot) GSD disconnected", 3e3);
    }
  });
  sidebarProvider = new GsdSidebarProvider(context.extensionUri, client);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      GsdSidebarProvider.viewId,
      sidebarProvider
    )
  );
  fileDecorations = new GsdFileDecorationProvider(client);
  context.subscriptions.push(
    fileDecorations,
    vscode.window.registerFileDecorationProvider(fileDecorations)
  );
  const bashTerminal = new GsdBashTerminal(client);
  context.subscriptions.push(bashTerminal);
  sessionTreeProvider = new GsdSessionTreeProvider(client);
  context.subscriptions.push(
    sessionTreeProvider,
    vscode.window.registerTreeDataProvider(GsdSessionTreeProvider.viewId, sessionTreeProvider)
  );
  activityFeedProvider = new GsdActivityFeedProvider(client);
  context.subscriptions.push(
    activityFeedProvider,
    vscode.window.registerTreeDataProvider(GsdActivityFeedProvider.viewId, activityFeedProvider)
  );
  planViewerProvider = new GsdPlanViewerProvider(client);
  context.subscriptions.push(
    planViewerProvider,
    vscode.window.registerTreeDataProvider(GsdPlanViewerProvider.viewId, planViewerProvider)
  );
  changeTracker = new GsdChangeTracker(client, cwd);
  context.subscriptions.push(changeTracker);
  checkpointProvider = new GsdCheckpointProvider(changeTracker);
  context.subscriptions.push(
    checkpointProvider,
    vscode.window.registerTreeDataProvider(GsdCheckpointProvider.viewId, checkpointProvider)
  );
  scmProvider = new GsdScmProvider(changeTracker, cwd);
  context.subscriptions.push(scmProvider);
  diagnosticBridge = new GsdDiagnosticBridge(client);
  context.subscriptions.push(diagnosticBridge);
  lineDecorations = new GsdLineDecorationManager(changeTracker);
  context.subscriptions.push(lineDecorations);
  gitIntegration = new GsdGitIntegration(changeTracker, cwd);
  context.subscriptions.push(gitIntegration);
  permissionManager = new GsdPermissionManager(client);
  context.subscriptions.push(permissionManager);
  let currentProgress;
  client.onEvent((evt) => {
    const showProgress = vscode.workspace.getConfiguration("gsd").get("showProgressNotifications", true);
    if (!showProgress) return;
    if (evt.type === "agent_start" && !currentProgress) {
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "GSD Agent",
          cancellable: true
        },
        (progress, token) => {
          token.onCancellationRequested(() => {
            client?.abort().catch(() => {
            });
          });
          const toolListener = client.onEvent((toolEvt) => {
            if (toolEvt.type === "tool_execution_start") {
              const toolName = String(toolEvt.toolName ?? "");
              progress.report({ message: `Running ${toolName}...` });
            }
          });
          return new Promise((resolve) => {
            currentProgress = { resolve };
            token.onCancellationRequested(() => {
              toolListener.dispose();
              currentProgress = void 0;
              resolve();
            });
          }).finally(() => {
            toolListener.dispose();
          });
        }
      );
    } else if (evt.type === "agent_end" && currentProgress) {
      currentProgress.resolve();
      currentProgress = void 0;
    }
  });
  let lastContextWarning = 0;
  client.onEvent(async (evt) => {
    if (evt.type !== "message_end") return;
    const showWarning = vscode.workspace.getConfiguration("gsd").get("showContextWarning", true);
    if (!showWarning) return;
    if (Date.now() - lastContextWarning < 6e4) return;
    try {
      const [state, stats] = await Promise.all([
        client.getState().catch(() => null),
        client.getSessionStats().catch(() => null)
      ]);
      const contextWindow = state?.model?.contextWindow ?? 0;
      const totalTokens = getSessionTotalTokens(stats);
      if (contextWindow <= 0) return;
      const threshold = vscode.workspace.getConfiguration("gsd").get("contextWarningThreshold", 80);
      const pct = Math.round(totalTokens / contextWindow * 100);
      if (pct >= threshold) {
        lastContextWarning = Date.now();
        const action = await vscode.window.showWarningMessage(
          `Context window ${pct}% full (${Math.round(totalTokens / 1e3)}k / ${Math.round(contextWindow / 1e3)}k). Consider compacting.`,
          "Compact Now"
        );
        if (action === "Compact Now") {
          await vscode.commands.executeCommand("gsd.compact");
        }
      }
    } catch {
    }
  });
  context.subscriptions.push(registerChatParticipant(context, client));
  const slashCompletion = new GsdSlashCompletionProvider(client);
  context.subscriptions.push(
    slashCompletion,
    vscode.languages.registerCompletionItemProvider(
      [
        { language: "markdown" },
        { language: "plaintext" },
        { language: "typescript" },
        { language: "typescriptreact" },
        { language: "javascript" },
        { language: "javascriptreact" }
      ],
      slashCompletion,
      "/"
    )
  );
  const codeLensProvider = new GsdCodeLensProvider(client);
  context.subscriptions.push(
    codeLensProvider,
    vscode.languages.registerCodeLensProvider(
      [
        { language: "typescript" },
        { language: "typescriptreact" },
        { language: "javascript" },
        { language: "javascriptreact" },
        { language: "python" },
        { language: "go" },
        { language: "rust" }
      ],
      codeLensProvider
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.start", async () => {
      try {
        await client.start();
        const autoCompaction = vscode.workspace.getConfiguration("gsd").get("autoCompaction", true);
        await client.setAutoCompaction(autoCompaction).catch(() => {
        });
        sidebarProvider?.refresh();
        refreshStatusBar();
        vscode.window.showInformationMessage("GSD agent started.");
      } catch (err) {
        handleError(err, "Failed to start GSD");
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.stop", async () => {
      await client.stop();
      sidebarProvider?.refresh();
      vscode.window.showInformationMessage("GSD agent stopped.");
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.newSession", async () => {
      if (!requireConnected()) return;
      try {
        await client.newSession();
        sidebarProvider?.refresh();
        sessionTreeProvider?.refresh();
        fileDecorations?.clear();
        vscode.window.showInformationMessage("New GSD session started.");
      } catch (err) {
        handleError(err, "Failed to start new session");
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.sendMessage", async () => {
      if (!requireConnected()) return;
      const message = await vscode.window.showInputBox({
        prompt: "Enter message for GSD",
        placeHolder: "What should I do?"
      });
      if (!message) return;
      try {
        await client.sendPrompt(message);
      } catch (err) {
        handleError(err, "Failed to send message");
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.abort", async () => {
      if (!requireConnected()) return;
      try {
        await client.abort();
        vscode.window.showInformationMessage("Operation aborted.");
      } catch (err) {
        handleError(err, "Failed to abort");
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.cycleModel", async () => {
      if (!requireConnected()) return;
      try {
        const result = await client.cycleModel();
        if (result) {
          vscode.window.showInformationMessage(
            `Model: ${result.model.provider}/${result.model.id} (thinking: ${result.thinkingLevel})`
          );
        } else {
          vscode.window.showInformationMessage("No other models available.");
        }
        sidebarProvider?.refresh();
      } catch (err) {
        handleError(err, "Failed to cycle model");
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.switchModel", async () => {
      if (!requireConnected()) return;
      try {
        const models = await client.getAvailableModels();
        if (models.length === 0) {
          vscode.window.showInformationMessage("No models available.");
          return;
        }
        const items = models.map((m) => ({
          label: `${m.provider}/${m.id}`,
          description: m.contextWindow ? `${Math.round(m.contextWindow / 1e3)}k context` : void 0,
          provider: m.provider,
          modelId: m.id
        }));
        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: "Select a model"
        });
        if (!selected) return;
        await client.setModel(selected.provider, selected.modelId);
        vscode.window.showInformationMessage(`Model set to ${selected.label}`);
        sidebarProvider?.refresh();
      } catch (err) {
        handleError(err, "Failed to switch model");
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.cycleThinking", async () => {
      if (!requireConnected()) return;
      try {
        const result = await client.cycleThinkingLevel();
        if (result) {
          vscode.window.showInformationMessage(`Thinking level: ${result.level}`);
        } else {
          vscode.window.showInformationMessage("Cannot change thinking level for this model.");
        }
        sidebarProvider?.refresh();
      } catch (err) {
        handleError(err, "Failed to cycle thinking level");
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.setThinking", async () => {
      if (!requireConnected()) return;
      const levels = ["off", "low", "medium", "high"];
      const selected = await vscode.window.showQuickPick(levels, {
        placeHolder: "Select thinking level"
      });
      if (!selected) return;
      try {
        await client.setThinkingLevel(selected);
        vscode.window.showInformationMessage(`Thinking level set to ${selected}`);
        sidebarProvider?.refresh();
      } catch (err) {
        handleError(err, "Failed to set thinking level");
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.compact", async () => {
      if (!requireConnected()) return;
      try {
        await client.compact();
        vscode.window.showInformationMessage("Context compacted.");
        sidebarProvider?.refresh();
      } catch (err) {
        handleError(err, "Failed to compact context");
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.exportHtml", async () => {
      if (!requireConnected()) return;
      try {
        const saveUri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file("gsd-conversation.html"),
          filters: { "HTML Files": ["html"] }
        });
        const outputPath = saveUri?.fsPath;
        const result = await client.exportHtml(outputPath);
        vscode.window.showInformationMessage(`Conversation exported to ${result.path}`);
      } catch (err) {
        handleError(err, "Failed to export HTML");
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.sessionStats", async () => {
      if (!requireConnected()) return;
      try {
        const stats = await client.getSessionStats();
        const lines = formatSessionStatsLines(stats);
        vscode.window.showInformationMessage(
          lines.length > 0 ? lines.join(" | ") : "No stats available."
        );
      } catch (err) {
        handleError(err, "Failed to get session stats");
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.runBash", async () => {
      if (!requireConnected()) return;
      const command = await vscode.window.showInputBox({
        prompt: "Enter bash command to execute",
        placeHolder: "ls -la"
      });
      if (!command) return;
      try {
        const result = await client.runBash(command);
        outputChannel.appendLine(`[bash] $ ${command}`);
        const output = getBashOutput(result);
        if (output) outputChannel.appendLine(output);
        outputChannel.appendLine(`[exit code: ${getBashExitCode(result) ?? "unknown"}]`);
        outputChannel.show(true);
        if (getBashExitCode(result) === 0) {
          vscode.window.showInformationMessage("Bash command completed successfully.");
        } else {
          vscode.window.showWarningMessage(`Bash command exited with code ${getBashExitCode(result) ?? "unknown"}`);
        }
      } catch (err) {
        handleError(err, "Failed to run bash command");
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.steer", async () => {
      if (!requireConnected()) return;
      const message = await vscode.window.showInputBox({
        prompt: "Enter steering message (interrupts current operation)",
        placeHolder: "Focus on the error handling instead"
      });
      if (!message) return;
      try {
        await client.steer(message);
      } catch (err) {
        handleError(err, "Failed to steer agent");
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.listCommands", async () => {
      if (!requireConnected()) return;
      try {
        const commands = await client.getCommands();
        if (commands.length === 0) {
          vscode.window.showInformationMessage("No slash commands available.");
          return;
        }
        const items = commands.map((cmd) => ({
          label: `/${cmd.name}`,
          description: cmd.description ?? "",
          detail: `Source: ${cmd.source}${cmd.location ? ` (${cmd.location})` : ""}`
        }));
        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: "Available slash commands"
        });
        if (selected) {
          await client.sendPrompt(selected.label);
        }
      } catch (err) {
        handleError(err, "Failed to list commands");
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.switchSession", async (sessionFile) => {
      if (!requireConnected()) return;
      const file = sessionFile ?? await (async () => {
        const input = await vscode.window.showInputBox({
          prompt: "Enter session file path",
          placeHolder: "/path/to/session.jsonl"
        });
        return input;
      })();
      if (!file) return;
      try {
        await client.switchSession(file);
        sidebarProvider?.refresh();
        sessionTreeProvider?.refresh();
        vscode.window.showInformationMessage("Switched session.");
      } catch (err) {
        handleError(err, "Failed to switch session");
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.refreshSessions", () => {
      sessionTreeProvider?.refresh();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.showHistory", () => {
      if (!requireConnected()) return;
      GsdConversationHistoryPanel.createOrShow(context.extensionUri, client);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "gsd.askAboutSymbol",
      async (symbolName, fileName, lineNumber) => {
        if (!requireConnected()) return;
        try {
          const prompt = `Explain the \`${symbolName}\` function/class in ${fileName} (line ${lineNumber}). Be concise.`;
          await client.sendPrompt(prompt);
        } catch (err) {
          handleError(err, "Failed to send Ask GSD request");
        }
      }
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.clearFileDecorations", () => {
      fileDecorations?.clear();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.clearActivity", () => {
      activityFeedProvider?.clear();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.forkSession", async () => {
      if (!requireConnected()) return;
      try {
        const messages = await client.getForkMessages();
        if (messages.length === 0) {
          vscode.window.showInformationMessage("No fork points available.");
          return;
        }
        const items = messages.map((m) => ({
          label: m.text.slice(0, 80) + (m.text.length > 80 ? "..." : ""),
          description: m.entryId,
          entryId: m.entryId
        }));
        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: "Select a message to fork from"
        });
        if (!selected) return;
        const result = await client.forkSession(selected.entryId);
        if (!result.cancelled) {
          vscode.window.showInformationMessage("Session forked successfully.");
          sidebarProvider?.refresh();
          sessionTreeProvider?.refresh();
        }
      } catch (err) {
        handleError(err, "Failed to fork session");
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.toggleSteeringMode", async () => {
      if (!requireConnected()) return;
      try {
        const state = await client.getState();
        const next = state.steeringMode === "all" ? "one-at-a-time" : "all";
        await client.setSteeringMode(next);
        vscode.window.showInformationMessage(`Steering mode: ${next}`);
        sidebarProvider?.refresh();
      } catch (err) {
        handleError(err, "Failed to toggle steering mode");
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.toggleFollowUpMode", async () => {
      if (!requireConnected()) return;
      try {
        const state = await client.getState();
        const next = state.followUpMode === "all" ? "one-at-a-time" : "all";
        await client.setFollowUpMode(next);
        vscode.window.showInformationMessage(`Follow-up mode: ${next}`);
        sidebarProvider?.refresh();
      } catch (err) {
        handleError(err, "Failed to toggle follow-up mode");
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "gsd.refactorSymbol",
      async (symbolName, fileName, lineNumber) => {
        if (!requireConnected()) return;
        try {
          await client.sendPrompt(`Refactor the \`${symbolName}\` function/class in ${fileName} (line ${lineNumber}). Improve clarity, performance, or structure while preserving behavior.`);
        } catch (err) {
          handleError(err, "Failed to send refactor request");
        }
      }
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "gsd.findBugsSymbol",
      async (symbolName, fileName, lineNumber) => {
        if (!requireConnected()) return;
        try {
          await client.sendPrompt(`Review the \`${symbolName}\` function/class in ${fileName} (line ${lineNumber}) for potential bugs, edge cases, and issues.`);
        } catch (err) {
          handleError(err, "Failed to send bug review request");
        }
      }
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "gsd.generateTestsSymbol",
      async (symbolName, fileName, lineNumber) => {
        if (!requireConnected()) return;
        try {
          await client.sendPrompt(`Generate comprehensive tests for the \`${symbolName}\` function/class in ${fileName} (line ${lineNumber}). Cover success paths, edge cases, and error scenarios.`);
        } catch (err) {
          handleError(err, "Failed to send test generation request");
        }
      }
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.toggleAutoRetry", async () => {
      if (!requireConnected()) return;
      try {
        const next = !client.autoRetryEnabled;
        await client.setAutoRetry(next);
        vscode.window.showInformationMessage(`Auto-retry ${next ? "enabled" : "disabled"}.`);
        sidebarProvider?.refresh();
      } catch (err) {
        handleError(err, "Failed to toggle auto-retry");
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.abortRetry", async () => {
      if (!requireConnected()) return;
      try {
        await client.abortRetry();
        vscode.window.showInformationMessage("Retry aborted.");
      } catch (err) {
        handleError(err, "Failed to abort retry");
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.setSessionName", async () => {
      if (!requireConnected()) return;
      const name = await vscode.window.showInputBox({
        prompt: "Enter a name for this session",
        placeHolder: "e.g. auth-refactor"
      });
      if (!name) return;
      try {
        await client.setSessionName(name);
        sidebarProvider?.refresh();
        vscode.window.showInformationMessage(`Session named "${name}".`);
      } catch (err) {
        handleError(err, "Failed to set session name");
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.copyLastResponse", async () => {
      if (!requireConnected()) return;
      try {
        const text = await client.getLastAssistantText();
        if (!text) {
          vscode.window.showInformationMessage("No response to copy.");
          return;
        }
        await vscode.env.clipboard.writeText(text);
        vscode.window.showInformationMessage("Last response copied to clipboard.");
      } catch (err) {
        handleError(err, "Failed to copy last response");
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.acceptAllChanges", () => {
      changeTracker?.acceptAll();
      vscode.window.showInformationMessage("All agent changes accepted.");
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.discardAllChanges", async () => {
      if (!changeTracker?.hasChanges) {
        vscode.window.showInformationMessage("No agent changes to discard.");
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Discard all agent changes (${changeTracker.modifiedFiles.length} files)?`,
        { modal: true },
        "Discard"
      );
      if (confirm === "Discard") {
        const count = await changeTracker.discardAll();
        vscode.window.showInformationMessage(`Reverted ${count} file${count !== 1 ? "s" : ""}.`);
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.discardFileChanges", async (resourceState) => {
      if (!changeTracker || !resourceState?.resourceUri) return;
      const filePath = resourceState.resourceUri.fsPath;
      const success = await changeTracker.discardFile(filePath);
      if (success) {
        vscode.window.showInformationMessage(`Reverted ${vscode.workspace.asRelativePath(filePath)}`);
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.acceptFileChanges", (resourceState) => {
      if (!changeTracker || !resourceState?.resourceUri) return;
      changeTracker.acceptFile(resourceState.resourceUri.fsPath);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.restoreCheckpoint", async (checkpointId) => {
      if (!changeTracker) return;
      const checkpoint = changeTracker.checkpoints.find((c) => c.id === checkpointId);
      if (!checkpoint) return;
      const confirm = await vscode.window.showWarningMessage(
        `Restore to "${checkpoint.label}"? This will revert files to their state at ${new Date(checkpoint.timestamp).toLocaleTimeString()}.`,
        { modal: true },
        "Restore"
      );
      if (confirm === "Restore") {
        const count = await changeTracker.restoreCheckpoint(checkpointId);
        vscode.window.showInformationMessage(`Restored ${count} file${count !== 1 ? "s" : ""} to checkpoint.`);
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.fixProblemsInFile", async () => {
      if (!requireConnected()) return;
      try {
        await diagnosticBridge.fixProblemsInFile();
      } catch (err) {
        handleError(err, "Failed to fix problems");
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.fixAllProblems", async () => {
      if (!requireConnected()) return;
      try {
        await diagnosticBridge.fixAllProblems();
      } catch (err) {
        handleError(err, "Failed to fix problems");
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.clearDiagnostics", () => {
      diagnosticBridge?.clearFindings();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.clearPlan", () => {
      planViewerProvider?.clear();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.cycleApprovalMode", () => {
      permissionManager?.cycleMode();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.selectApprovalMode", () => {
      permissionManager?.selectMode();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.commitAgentChanges", () => {
      gitIntegration?.commitAgentChanges();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.createAgentBranch", () => {
      gitIntegration?.createAgentBranch();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gsd.showAgentDiff", () => {
      gitIntegration?.showAgentDiff();
    })
  );
  if (startupConfig.autoStart) {
    vscode.commands.executeCommand("gsd.start");
  }
}
function deactivate() {
  client?.dispose();
  sidebarProvider?.dispose();
  fileDecorations?.dispose();
  sessionTreeProvider?.dispose();
  activityFeedProvider?.dispose();
  checkpointProvider?.dispose();
  changeTracker?.dispose();
  scmProvider?.dispose();
  diagnosticBridge?.dispose();
  lineDecorations?.dispose();
  gitIntegration?.dispose();
  permissionManager?.dispose();
  client = void 0;
  sidebarProvider = void 0;
  fileDecorations = void 0;
  sessionTreeProvider = void 0;
  activityFeedProvider = void 0;
  checkpointProvider = void 0;
  changeTracker = void 0;
  scmProvider = void 0;
  diagnosticBridge = void 0;
  lineDecorations = void 0;
  gitIntegration = void 0;
  permissionManager = void 0;
}
export {
  activate,
  deactivate,
  resolveTrustedGsdStartupConfig
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vdnNjb2RlLWV4dGVuc2lvbi9zcmMvZXh0ZW5zaW9uLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBQcm9qZWN0L0FwcDogR1NELTJcbi8vIEZpbGUgUHVycG9zZTogVlMgQ29kZSBleHRlbnNpb24gYWN0aXZhdGlvbiBhbmQgY29tbWFuZCByZWdpc3RyYXRpb24gZm9yIEdTRC5cblxuaW1wb3J0ICogYXMgdnNjb2RlIGZyb20gXCJ2c2NvZGVcIjtcbmltcG9ydCB7IHBpY2tUcnVzdGVkQ29uZmlndXJhdGlvblZhbHVlIH0gZnJvbSBcIi4vdHJ1c3RlZC1jb25maWcuanNcIjtcbmltcG9ydCB7IEdzZENsaWVudCwgVGhpbmtpbmdMZXZlbCB9IGZyb20gXCIuL2dzZC1jbGllbnQuanNcIjtcbmltcG9ydCB7IHJlZ2lzdGVyQ2hhdFBhcnRpY2lwYW50IH0gZnJvbSBcIi4vY2hhdC1wYXJ0aWNpcGFudC5qc1wiO1xuaW1wb3J0IHsgR3NkU2lkZWJhclByb3ZpZGVyIH0gZnJvbSBcIi4vc2lkZWJhci5qc1wiO1xuaW1wb3J0IHsgR3NkRmlsZURlY29yYXRpb25Qcm92aWRlciB9IGZyb20gXCIuL2ZpbGUtZGVjb3JhdGlvbnMuanNcIjtcbmltcG9ydCB7IEdzZEJhc2hUZXJtaW5hbCB9IGZyb20gXCIuL2Jhc2gtdGVybWluYWwuanNcIjtcbmltcG9ydCB7IEdzZFNlc3Npb25UcmVlUHJvdmlkZXIgfSBmcm9tIFwiLi9zZXNzaW9uLXRyZWUuanNcIjtcbmltcG9ydCB7IEdzZENvbnZlcnNhdGlvbkhpc3RvcnlQYW5lbCB9IGZyb20gXCIuL2NvbnZlcnNhdGlvbi1oaXN0b3J5LmpzXCI7XG5pbXBvcnQgeyBHc2RTbGFzaENvbXBsZXRpb25Qcm92aWRlciB9IGZyb20gXCIuL3NsYXNoLWNvbXBsZXRpb24uanNcIjtcbmltcG9ydCB7IEdzZENvZGVMZW5zUHJvdmlkZXIgfSBmcm9tIFwiLi9jb2RlLWxlbnMuanNcIjtcbmltcG9ydCB7IEdzZEFjdGl2aXR5RmVlZFByb3ZpZGVyIH0gZnJvbSBcIi4vYWN0aXZpdHktZmVlZC5qc1wiO1xuaW1wb3J0IHsgR3NkQ2hhbmdlVHJhY2tlciB9IGZyb20gXCIuL2NoYW5nZS10cmFja2VyLmpzXCI7XG5pbXBvcnQgeyBHc2RTY21Qcm92aWRlciB9IGZyb20gXCIuL3NjbS1wcm92aWRlci5qc1wiO1xuaW1wb3J0IHsgR3NkRGlhZ25vc3RpY0JyaWRnZSB9IGZyb20gXCIuL2RpYWdub3N0aWNzLmpzXCI7XG5pbXBvcnQgeyBHc2RMaW5lRGVjb3JhdGlvbk1hbmFnZXIgfSBmcm9tIFwiLi9saW5lLWRlY29yYXRpb25zLmpzXCI7XG5pbXBvcnQgeyBHc2RHaXRJbnRlZ3JhdGlvbiB9IGZyb20gXCIuL2dpdC1pbnRlZ3JhdGlvbi5qc1wiO1xuaW1wb3J0IHsgR3NkUGVybWlzc2lvbk1hbmFnZXIgfSBmcm9tIFwiLi9wZXJtaXNzaW9ucy5qc1wiO1xuaW1wb3J0IHsgR3NkUGxhblZpZXdlclByb3ZpZGVyIH0gZnJvbSBcIi4vcGxhbi12aWV3ZXIuanNcIjtcbmltcG9ydCB7IEdzZENoZWNrcG9pbnRQcm92aWRlciB9IGZyb20gXCIuL2NoZWNrcG9pbnRzLmpzXCI7XG5pbXBvcnQge1xuXHRmb3JtYXRTZXNzaW9uU3RhdHNMaW5lcyxcblx0Z2V0QmFzaEV4aXRDb2RlLFxuXHRnZXRCYXNoT3V0cHV0LFxuXHRnZXRTZXNzaW9uQ29zdCxcblx0Z2V0U2Vzc2lvblRvdGFsVG9rZW5zLFxufSBmcm9tIFwiLi9ycGMtZGlzcGxheS5qc1wiO1xuXG5sZXQgY2xpZW50OiBHc2RDbGllbnQgfCB1bmRlZmluZWQ7XG5sZXQgc2lkZWJhclByb3ZpZGVyOiBHc2RTaWRlYmFyUHJvdmlkZXIgfCB1bmRlZmluZWQ7XG5sZXQgZmlsZURlY29yYXRpb25zOiBHc2RGaWxlRGVjb3JhdGlvblByb3ZpZGVyIHwgdW5kZWZpbmVkO1xubGV0IHNlc3Npb25UcmVlUHJvdmlkZXI6IEdzZFNlc3Npb25UcmVlUHJvdmlkZXIgfCB1bmRlZmluZWQ7XG5sZXQgYWN0aXZpdHlGZWVkUHJvdmlkZXI6IEdzZEFjdGl2aXR5RmVlZFByb3ZpZGVyIHwgdW5kZWZpbmVkO1xubGV0IHBsYW5WaWV3ZXJQcm92aWRlcjogR3NkUGxhblZpZXdlclByb3ZpZGVyIHwgdW5kZWZpbmVkO1xubGV0IGNoZWNrcG9pbnRQcm92aWRlcjogR3NkQ2hlY2twb2ludFByb3ZpZGVyIHwgdW5kZWZpbmVkO1xubGV0IGNoYW5nZVRyYWNrZXI6IEdzZENoYW5nZVRyYWNrZXIgfCB1bmRlZmluZWQ7XG5sZXQgc2NtUHJvdmlkZXI6IEdzZFNjbVByb3ZpZGVyIHwgdW5kZWZpbmVkO1xubGV0IGRpYWdub3N0aWNCcmlkZ2U6IEdzZERpYWdub3N0aWNCcmlkZ2UgfCB1bmRlZmluZWQ7XG5sZXQgbGluZURlY29yYXRpb25zOiBHc2RMaW5lRGVjb3JhdGlvbk1hbmFnZXIgfCB1bmRlZmluZWQ7XG5sZXQgZ2l0SW50ZWdyYXRpb246IEdzZEdpdEludGVncmF0aW9uIHwgdW5kZWZpbmVkO1xubGV0IHBlcm1pc3Npb25NYW5hZ2VyOiBHc2RQZXJtaXNzaW9uTWFuYWdlciB8IHVuZGVmaW5lZDtcblxuZnVuY3Rpb24gZ2V0VHJ1c3RlZENvbmZpZ3VyYXRpb25WYWx1ZTxUPihzZWN0aW9uOiBzdHJpbmcsIGtleTogc3RyaW5nLCBmYWxsYmFjazogVCk6IFQge1xuXHRjb25zdCBjb25maWcgPSB2c2NvZGUud29ya3NwYWNlLmdldENvbmZpZ3VyYXRpb24oc2VjdGlvbik7XG5cdHJldHVybiBwaWNrVHJ1c3RlZENvbmZpZ3VyYXRpb25WYWx1ZShjb25maWcuaW5zcGVjdDxUPihrZXkpLCBmYWxsYmFjayk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlVHJ1c3RlZEdzZFN0YXJ0dXBDb25maWcoKTogeyBiaW5hcnlQYXRoOiBzdHJpbmc7IGF1dG9TdGFydDogYm9vbGVhbiB9IHtcblx0cmV0dXJuIHtcblx0XHRiaW5hcnlQYXRoOiBnZXRUcnVzdGVkQ29uZmlndXJhdGlvblZhbHVlKFwiZ3NkXCIsIFwiYmluYXJ5UGF0aFwiLCBcImdzZFwiKSxcblx0XHRhdXRvU3RhcnQ6IGdldFRydXN0ZWRDb25maWd1cmF0aW9uVmFsdWUoXCJnc2RcIiwgXCJhdXRvU3RhcnRcIiwgZmFsc2UpLFxuXHR9O1xufVxuXG5mdW5jdGlvbiByZXF1aXJlQ29ubmVjdGVkKCk6IGJvb2xlYW4ge1xuXHRpZiAoIWNsaWVudD8uaXNDb25uZWN0ZWQpIHtcblx0XHR2c2NvZGUud2luZG93LnNob3dXYXJuaW5nTWVzc2FnZShcIkdTRCBhZ2VudCBpcyBub3QgcnVubmluZy5cIik7XG5cdFx0cmV0dXJuIGZhbHNlO1xuXHR9XG5cdHJldHVybiB0cnVlO1xufVxuXG5mdW5jdGlvbiBoYW5kbGVFcnJvcihlcnI6IHVua25vd24sIGNvbnRleHQ6IHN0cmluZyk6IHZvaWQge1xuXHRjb25zdCBtc2cgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG5cdHZzY29kZS53aW5kb3cuc2hvd0Vycm9yTWVzc2FnZShgJHtjb250ZXh0fTogJHttc2d9YCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhY3RpdmF0ZShjb250ZXh0OiB2c2NvZGUuRXh0ZW5zaW9uQ29udGV4dCk6IHZvaWQge1xuXHRjb25zdCBzdGFydHVwQ29uZmlnID0gcmVzb2x2ZVRydXN0ZWRHc2RTdGFydHVwQ29uZmlnKCk7XG5cdGNvbnN0IGNvbmZpZyA9IHZzY29kZS53b3Jrc3BhY2UuZ2V0Q29uZmlndXJhdGlvbihcImdzZFwiKTtcblx0Y29uc3QgYmluYXJ5UGF0aCA9IHN0YXJ0dXBDb25maWcuYmluYXJ5UGF0aDtcblx0Y29uc3QgY3dkID0gdnNjb2RlLndvcmtzcGFjZS53b3Jrc3BhY2VGb2xkZXJzPy5bMF0/LnVyaS5mc1BhdGggPz8gcHJvY2Vzcy5jd2QoKTtcblxuXHRjbGllbnQgPSBuZXcgR3NkQ2xpZW50KGJpbmFyeVBhdGgsIGN3ZCk7XG5cdGNvbnRleHQuc3Vic2NyaXB0aW9ucy5wdXNoKGNsaWVudCk7XG5cblx0Ly8gTG9nIHN0ZGVyciB0byBhbiBvdXRwdXQgY2hhbm5lbFxuXHRjb25zdCBvdXRwdXRDaGFubmVsID0gdnNjb2RlLndpbmRvdy5jcmVhdGVPdXRwdXRDaGFubmVsKFwiR1NELTIgQWdlbnRcIik7XG5cdGNvbnRleHQuc3Vic2NyaXB0aW9ucy5wdXNoKG91dHB1dENoYW5uZWwpO1xuXG5cdGNsaWVudC5vbkVycm9yKChtc2cpID0+IHtcblx0XHRvdXRwdXRDaGFubmVsLmFwcGVuZExpbmUoYFtzdGRlcnJdICR7bXNnfWApO1xuXHR9KTtcblxuXHQvLyAtLSBQZXJzaXN0ZW50IHN0YXR1cyBiYXIgaXRlbSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cblx0Y29uc3Qgc3RhdHVzQmFySXRlbSA9IHZzY29kZS53aW5kb3cuY3JlYXRlU3RhdHVzQmFySXRlbSh2c2NvZGUuU3RhdHVzQmFyQWxpZ25tZW50LkxlZnQsIDApO1xuXHRzdGF0dXNCYXJJdGVtLmNvbW1hbmQgPSBcIndvcmtiZW5jaC52aWV3LmV4dGVuc2lvbi5nc2RcIjtcblx0c3RhdHVzQmFySXRlbS50ZXh0ID0gXCIkKGh1Ym90KSBHU0RcIjtcblx0c3RhdHVzQmFySXRlbS50b29sdGlwID0gXCJHU0QgQWdlbnQgXHUyMDE0IGNsaWNrIHRvIG9wZW5cIjtcblx0c3RhdHVzQmFySXRlbS5zaG93KCk7XG5cdGNvbnRleHQuc3Vic2NyaXB0aW9ucy5wdXNoKHN0YXR1c0Jhckl0ZW0pO1xuXG5cdGFzeW5jIGZ1bmN0aW9uIHJlZnJlc2hTdGF0dXNCYXIoKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0aWYgKCFjbGllbnQ/LmlzQ29ubmVjdGVkKSB7XG5cdFx0XHRzdGF0dXNCYXJJdGVtLnRleHQgPSBcIiQoaHVib3QpIEdTRFwiO1xuXHRcdFx0c3RhdHVzQmFySXRlbS50b29sdGlwID0gXCJHU0Q6IERpc2Nvbm5lY3RlZFwiO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblx0XHR0cnkge1xuXHRcdFx0Y29uc3QgW3N0YXRlLCBzdGF0c10gPSBhd2FpdCBQcm9taXNlLmFsbChbXG5cdFx0XHRcdGNsaWVudC5nZXRTdGF0ZSgpLmNhdGNoKCgpID0+IG51bGwpLFxuXHRcdFx0XHRjbGllbnQuZ2V0U2Vzc2lvblN0YXRzKCkuY2F0Y2goKCkgPT4gbnVsbCksXG5cdFx0XHRdKTtcblx0XHRcdGNvbnN0IG1vZGVsSWQgPSBzdGF0ZT8ubW9kZWw/LmlkID8/IFwiXCI7XG5cdFx0XHRjb25zdCBjb3N0ID0gZ2V0U2Vzc2lvbkNvc3Qoc3RhdHMpO1xuXHRcdFx0Y29uc3QgY29zdFBhcnQgPSBjb3N0ID4gMCA/IGAgfCAkJHtjb3N0LnRvRml4ZWQoNCl9YCA6IFwiXCI7XG5cdFx0XHRjb25zdCBzdHJlYW1QYXJ0ID0gc3RhdGU/LmlzU3RyZWFtaW5nID8gXCIgJChzeW5jfnNwaW4pXCIgOiBcIlwiO1xuXHRcdFx0c3RhdHVzQmFySXRlbS50ZXh0ID0gYCQoaHVib3QpIEdTRCR7bW9kZWxJZCA/IGAgfCAke21vZGVsSWR9YCA6IFwiXCJ9JHtjb3N0UGFydH0ke3N0cmVhbVBhcnR9YDtcblx0XHRcdHN0YXR1c0Jhckl0ZW0udG9vbHRpcCA9IHN0YXRlPy5tb2RlbFxuXHRcdFx0XHQ/IGBHU0Q6IENvbm5lY3RlZCBcdTIwMTQgJHtzdGF0ZS5tb2RlbC5wcm92aWRlcn0vJHtzdGF0ZS5tb2RlbC5pZH1gXG5cdFx0XHRcdDogXCJHU0Q6IENvbm5lY3RlZFwiO1xuXHRcdH0gY2F0Y2gge1xuXHRcdFx0Ly8gaWdub3JlIGZldGNoIGVycm9yc1xuXHRcdH1cblx0fVxuXG5cdGNvbnN0IHN0YXR1c0JhclRpbWVyID0gc2V0SW50ZXJ2YWwoKCkgPT4gcmVmcmVzaFN0YXR1c0JhcigpLCAxMF8wMDApO1xuXHRjb250ZXh0LnN1YnNjcmlwdGlvbnMucHVzaCh7IGRpc3Bvc2U6ICgpID0+IGNsZWFySW50ZXJ2YWwoc3RhdHVzQmFyVGltZXIpIH0pO1xuXG5cdGNsaWVudC5vbkNvbm5lY3Rpb25DaGFuZ2UoYXN5bmMgKGNvbm5lY3RlZCkgPT4ge1xuXHRcdGF3YWl0IHJlZnJlc2hTdGF0dXNCYXIoKTtcblx0XHRpZiAoY29ubmVjdGVkKSB7XG5cdFx0XHR2c2NvZGUud2luZG93LnNldFN0YXR1c0Jhck1lc3NhZ2UoXCIkKGh1Ym90KSBHU0QgY29ubmVjdGVkXCIsIDMwMDApO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHR2c2NvZGUud2luZG93LnNldFN0YXR1c0Jhck1lc3NhZ2UoXCIkKGh1Ym90KSBHU0QgZGlzY29ubmVjdGVkXCIsIDMwMDApO1xuXHRcdH1cblx0fSk7XG5cblx0Ly8gLS0gU2lkZWJhciAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5cdHNpZGViYXJQcm92aWRlciA9IG5ldyBHc2RTaWRlYmFyUHJvdmlkZXIoY29udGV4dC5leHRlbnNpb25VcmksIGNsaWVudCk7XG5cdGNvbnRleHQuc3Vic2NyaXB0aW9ucy5wdXNoKFxuXHRcdHZzY29kZS53aW5kb3cucmVnaXN0ZXJXZWJ2aWV3Vmlld1Byb3ZpZGVyKFxuXHRcdFx0R3NkU2lkZWJhclByb3ZpZGVyLnZpZXdJZCxcblx0XHRcdHNpZGViYXJQcm92aWRlcixcblx0XHQpLFxuXHQpO1xuXG5cdC8vIC0tIEZpbGUgZGVjb3JhdGlvbnMgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuXHRmaWxlRGVjb3JhdGlvbnMgPSBuZXcgR3NkRmlsZURlY29yYXRpb25Qcm92aWRlcihjbGllbnQpO1xuXHRjb250ZXh0LnN1YnNjcmlwdGlvbnMucHVzaChcblx0XHRmaWxlRGVjb3JhdGlvbnMsXG5cdFx0dnNjb2RlLndpbmRvdy5yZWdpc3RlckZpbGVEZWNvcmF0aW9uUHJvdmlkZXIoZmlsZURlY29yYXRpb25zKSxcblx0KTtcblxuXHQvLyAtLSBCYXNoIHRlcm1pbmFsIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cblx0Y29uc3QgYmFzaFRlcm1pbmFsID0gbmV3IEdzZEJhc2hUZXJtaW5hbChjbGllbnQpO1xuXHRjb250ZXh0LnN1YnNjcmlwdGlvbnMucHVzaChiYXNoVGVybWluYWwpO1xuXG5cdC8vIC0tIFNlc3Npb24gdHJlZSB2aWV3IC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuXHRzZXNzaW9uVHJlZVByb3ZpZGVyID0gbmV3IEdzZFNlc3Npb25UcmVlUHJvdmlkZXIoY2xpZW50KTtcblx0Y29udGV4dC5zdWJzY3JpcHRpb25zLnB1c2goXG5cdFx0c2Vzc2lvblRyZWVQcm92aWRlcixcblx0XHR2c2NvZGUud2luZG93LnJlZ2lzdGVyVHJlZURhdGFQcm92aWRlcihHc2RTZXNzaW9uVHJlZVByb3ZpZGVyLnZpZXdJZCwgc2Vzc2lvblRyZWVQcm92aWRlciksXG5cdCk7XG5cblx0Ly8gLS0gQWN0aXZpdHkgZmVlZCAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5cdGFjdGl2aXR5RmVlZFByb3ZpZGVyID0gbmV3IEdzZEFjdGl2aXR5RmVlZFByb3ZpZGVyKGNsaWVudCk7XG5cdGNvbnRleHQuc3Vic2NyaXB0aW9ucy5wdXNoKFxuXHRcdGFjdGl2aXR5RmVlZFByb3ZpZGVyLFxuXHRcdHZzY29kZS53aW5kb3cucmVnaXN0ZXJUcmVlRGF0YVByb3ZpZGVyKEdzZEFjdGl2aXR5RmVlZFByb3ZpZGVyLnZpZXdJZCwgYWN0aXZpdHlGZWVkUHJvdmlkZXIpLFxuXHQpO1xuXG5cdC8vIC0tIFBsYW4gdmlldyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cblx0cGxhblZpZXdlclByb3ZpZGVyID0gbmV3IEdzZFBsYW5WaWV3ZXJQcm92aWRlcihjbGllbnQpO1xuXHRjb250ZXh0LnN1YnNjcmlwdGlvbnMucHVzaChcblx0XHRwbGFuVmlld2VyUHJvdmlkZXIsXG5cdFx0dnNjb2RlLndpbmRvdy5yZWdpc3RlclRyZWVEYXRhUHJvdmlkZXIoR3NkUGxhblZpZXdlclByb3ZpZGVyLnZpZXdJZCwgcGxhblZpZXdlclByb3ZpZGVyKSxcblx0KTtcblxuXHQvLyAtLSBDaGFuZ2UgdHJhY2tlciAmIFNDTSBwcm92aWRlciAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cblx0Y2hhbmdlVHJhY2tlciA9IG5ldyBHc2RDaGFuZ2VUcmFja2VyKGNsaWVudCwgY3dkKTtcblx0Y29udGV4dC5zdWJzY3JpcHRpb25zLnB1c2goY2hhbmdlVHJhY2tlcik7XG5cblx0Y2hlY2twb2ludFByb3ZpZGVyID0gbmV3IEdzZENoZWNrcG9pbnRQcm92aWRlcihjaGFuZ2VUcmFja2VyKTtcblx0Y29udGV4dC5zdWJzY3JpcHRpb25zLnB1c2goXG5cdFx0Y2hlY2twb2ludFByb3ZpZGVyLFxuXHRcdHZzY29kZS53aW5kb3cucmVnaXN0ZXJUcmVlRGF0YVByb3ZpZGVyKEdzZENoZWNrcG9pbnRQcm92aWRlci52aWV3SWQsIGNoZWNrcG9pbnRQcm92aWRlciksXG5cdCk7XG5cblx0c2NtUHJvdmlkZXIgPSBuZXcgR3NkU2NtUHJvdmlkZXIoY2hhbmdlVHJhY2tlciwgY3dkKTtcblx0Y29udGV4dC5zdWJzY3JpcHRpb25zLnB1c2goc2NtUHJvdmlkZXIpO1xuXG5cdC8vIC0tIERpYWdub3N0aWNzIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuXHRkaWFnbm9zdGljQnJpZGdlID0gbmV3IEdzZERpYWdub3N0aWNCcmlkZ2UoY2xpZW50KTtcblx0Y29udGV4dC5zdWJzY3JpcHRpb25zLnB1c2goZGlhZ25vc3RpY0JyaWRnZSk7XG5cblx0Ly8gLS0gTGluZS1sZXZlbCBkZWNvcmF0aW9ucyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5cdGxpbmVEZWNvcmF0aW9ucyA9IG5ldyBHc2RMaW5lRGVjb3JhdGlvbk1hbmFnZXIoY2hhbmdlVHJhY2tlciEpO1xuXHRjb250ZXh0LnN1YnNjcmlwdGlvbnMucHVzaChsaW5lRGVjb3JhdGlvbnMpO1xuXG5cdC8vIC0tIEdpdCBpbnRlZ3JhdGlvbiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuXHRnaXRJbnRlZ3JhdGlvbiA9IG5ldyBHc2RHaXRJbnRlZ3JhdGlvbihjaGFuZ2VUcmFja2VyISwgY3dkKTtcblx0Y29udGV4dC5zdWJzY3JpcHRpb25zLnB1c2goZ2l0SW50ZWdyYXRpb24pO1xuXG5cdC8vIC0tIFBlcm1pc3Npb25zIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuXHRwZXJtaXNzaW9uTWFuYWdlciA9IG5ldyBHc2RQZXJtaXNzaW9uTWFuYWdlcihjbGllbnQpO1xuXHRjb250ZXh0LnN1YnNjcmlwdGlvbnMucHVzaChwZXJtaXNzaW9uTWFuYWdlcik7XG5cblx0Ly8gLS0gUHJvZ3Jlc3Mgbm90aWZpY2F0aW9ucyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5cdGxldCBjdXJyZW50UHJvZ3Jlc3M6IHsgcmVzb2x2ZTogKCkgPT4gdm9pZCB9IHwgdW5kZWZpbmVkO1xuXG5cdGNsaWVudC5vbkV2ZW50KChldnQpID0+IHtcblx0XHRjb25zdCBzaG93UHJvZ3Jlc3MgPSB2c2NvZGUud29ya3NwYWNlLmdldENvbmZpZ3VyYXRpb24oXCJnc2RcIikuZ2V0PGJvb2xlYW4+KFwic2hvd1Byb2dyZXNzTm90aWZpY2F0aW9uc1wiLCB0cnVlKTtcblx0XHRpZiAoIXNob3dQcm9ncmVzcykgcmV0dXJuO1xuXG5cdFx0aWYgKGV2dC50eXBlID09PSBcImFnZW50X3N0YXJ0XCIgJiYgIWN1cnJlbnRQcm9ncmVzcykge1xuXHRcdFx0dnNjb2RlLndpbmRvdy53aXRoUHJvZ3Jlc3MoXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRsb2NhdGlvbjogdnNjb2RlLlByb2dyZXNzTG9jYXRpb24uTm90aWZpY2F0aW9uLFxuXHRcdFx0XHRcdHRpdGxlOiBcIkdTRCBBZ2VudFwiLFxuXHRcdFx0XHRcdGNhbmNlbGxhYmxlOiB0cnVlLFxuXHRcdFx0XHR9LFxuXHRcdFx0XHQocHJvZ3Jlc3MsIHRva2VuKSA9PiB7XG5cdFx0XHRcdFx0dG9rZW4ub25DYW5jZWxsYXRpb25SZXF1ZXN0ZWQoKCkgPT4ge1xuXHRcdFx0XHRcdFx0Y2xpZW50Py5hYm9ydCgpLmNhdGNoKCgpID0+IHt9KTtcblx0XHRcdFx0XHR9KTtcblxuXHRcdFx0XHRcdC8vIExpc3RlbiBmb3IgdG9vbCBldmVudHMgdG8gdXBkYXRlIHByb2dyZXNzIG1lc3NhZ2Vcblx0XHRcdFx0XHRjb25zdCB0b29sTGlzdGVuZXIgPSBjbGllbnQhLm9uRXZlbnQoKHRvb2xFdnQpID0+IHtcblx0XHRcdFx0XHRcdGlmICh0b29sRXZ0LnR5cGUgPT09IFwidG9vbF9leGVjdXRpb25fc3RhcnRcIikge1xuXHRcdFx0XHRcdFx0XHRjb25zdCB0b29sTmFtZSA9IFN0cmluZyh0b29sRXZ0LnRvb2xOYW1lID8/IFwiXCIpO1xuXHRcdFx0XHRcdFx0XHRwcm9ncmVzcy5yZXBvcnQoeyBtZXNzYWdlOiBgUnVubmluZyAke3Rvb2xOYW1lfS4uLmAgfSk7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fSk7XG5cblx0XHRcdFx0XHRyZXR1cm4gbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUpID0+IHtcblx0XHRcdFx0XHRcdGN1cnJlbnRQcm9ncmVzcyA9IHsgcmVzb2x2ZSB9O1xuXHRcdFx0XHRcdFx0Ly8gQWxzbyBjbGVhbiB1cCBpZiBkaXNwb3NlZFxuXHRcdFx0XHRcdFx0dG9rZW4ub25DYW5jZWxsYXRpb25SZXF1ZXN0ZWQoKCkgPT4ge1xuXHRcdFx0XHRcdFx0XHR0b29sTGlzdGVuZXIuZGlzcG9zZSgpO1xuXHRcdFx0XHRcdFx0XHRjdXJyZW50UHJvZ3Jlc3MgPSB1bmRlZmluZWQ7XG5cdFx0XHRcdFx0XHRcdHJlc29sdmUoKTtcblx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdH0pLmZpbmFsbHkoKCkgPT4ge1xuXHRcdFx0XHRcdFx0dG9vbExpc3RlbmVyLmRpc3Bvc2UoKTtcblx0XHRcdFx0XHR9KTtcblx0XHRcdFx0fSxcblx0XHRcdCk7XG5cdFx0fSBlbHNlIGlmIChldnQudHlwZSA9PT0gXCJhZ2VudF9lbmRcIiAmJiBjdXJyZW50UHJvZ3Jlc3MpIHtcblx0XHRcdGN1cnJlbnRQcm9ncmVzcy5yZXNvbHZlKCk7XG5cdFx0XHRjdXJyZW50UHJvZ3Jlc3MgPSB1bmRlZmluZWQ7XG5cdFx0fVxuXHR9KTtcblxuXHQvLyAtLSBDb250ZXh0IHdpbmRvdyB3YXJuaW5nIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cblx0bGV0IGxhc3RDb250ZXh0V2FybmluZyA9IDA7XG5cdGNsaWVudC5vbkV2ZW50KGFzeW5jIChldnQpID0+IHtcblx0XHRpZiAoZXZ0LnR5cGUgIT09IFwibWVzc2FnZV9lbmRcIikgcmV0dXJuO1xuXHRcdGNvbnN0IHNob3dXYXJuaW5nID0gdnNjb2RlLndvcmtzcGFjZS5nZXRDb25maWd1cmF0aW9uKFwiZ3NkXCIpLmdldDxib29sZWFuPihcInNob3dDb250ZXh0V2FybmluZ1wiLCB0cnVlKTtcblx0XHRpZiAoIXNob3dXYXJuaW5nKSByZXR1cm47XG5cblx0XHQvLyBUaHJvdHRsZTogYXQgbW9zdCBvbmNlIHBlciA2MCBzZWNvbmRzXG5cdFx0aWYgKERhdGUubm93KCkgLSBsYXN0Q29udGV4dFdhcm5pbmcgPCA2MF8wMDApIHJldHVybjtcblxuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBbc3RhdGUsIHN0YXRzXSA9IGF3YWl0IFByb21pc2UuYWxsKFtcblx0XHRcdFx0Y2xpZW50IS5nZXRTdGF0ZSgpLmNhdGNoKCgpID0+IG51bGwpLFxuXHRcdFx0XHRjbGllbnQhLmdldFNlc3Npb25TdGF0cygpLmNhdGNoKCgpID0+IG51bGwpLFxuXHRcdFx0XSk7XG5cdFx0XHRjb25zdCBjb250ZXh0V2luZG93ID0gc3RhdGU/Lm1vZGVsPy5jb250ZXh0V2luZG93ID8/IDA7XG5cdFx0XHRjb25zdCB0b3RhbFRva2VucyA9IGdldFNlc3Npb25Ub3RhbFRva2VucyhzdGF0cyk7XG5cdFx0XHRpZiAoY29udGV4dFdpbmRvdyA8PSAwKSByZXR1cm47XG5cblx0XHRcdGNvbnN0IHRocmVzaG9sZCA9IHZzY29kZS53b3Jrc3BhY2UuZ2V0Q29uZmlndXJhdGlvbihcImdzZFwiKS5nZXQ8bnVtYmVyPihcImNvbnRleHRXYXJuaW5nVGhyZXNob2xkXCIsIDgwKTtcblx0XHRcdGNvbnN0IHBjdCA9IE1hdGgucm91bmQoKHRvdGFsVG9rZW5zIC8gY29udGV4dFdpbmRvdykgKiAxMDApO1xuXHRcdFx0aWYgKHBjdCA+PSB0aHJlc2hvbGQpIHtcblx0XHRcdFx0bGFzdENvbnRleHRXYXJuaW5nID0gRGF0ZS5ub3coKTtcblx0XHRcdFx0Y29uc3QgYWN0aW9uID0gYXdhaXQgdnNjb2RlLndpbmRvdy5zaG93V2FybmluZ01lc3NhZ2UoXG5cdFx0XHRcdFx0YENvbnRleHQgd2luZG93ICR7cGN0fSUgZnVsbCAoJHtNYXRoLnJvdW5kKHRvdGFsVG9rZW5zIC8gMTAwMCl9ayAvICR7TWF0aC5yb3VuZChjb250ZXh0V2luZG93IC8gMTAwMCl9aykuIENvbnNpZGVyIGNvbXBhY3RpbmcuYCxcblx0XHRcdFx0XHRcIkNvbXBhY3QgTm93XCIsXG5cdFx0XHRcdCk7XG5cdFx0XHRcdGlmIChhY3Rpb24gPT09IFwiQ29tcGFjdCBOb3dcIikge1xuXHRcdFx0XHRcdGF3YWl0IHZzY29kZS5jb21tYW5kcy5leGVjdXRlQ29tbWFuZChcImdzZC5jb21wYWN0XCIpO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0fSBjYXRjaCB7XG5cdFx0XHQvLyBpZ25vcmVcblx0XHR9XG5cdH0pO1xuXG5cdC8vIC0tIENoYXQgcGFydGljaXBhbnQgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cblx0Y29udGV4dC5zdWJzY3JpcHRpb25zLnB1c2gocmVnaXN0ZXJDaGF0UGFydGljaXBhbnQoY29udGV4dCwgY2xpZW50KSk7XG5cblx0Ly8gLS0gQ29udmVyc2F0aW9uIGhpc3RvcnkgcGFuZWwgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5cdC8vIChwYW5lbCBpcyBjcmVhdGVkIG9uIGRlbWFuZCB2aWEgZ3NkLnNob3dIaXN0b3J5IGNvbW1hbmQpXG5cblx0Ly8gLS0gU2xhc2ggY29tbWFuZCBjb21wbGV0aW9uIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5cdGNvbnN0IHNsYXNoQ29tcGxldGlvbiA9IG5ldyBHc2RTbGFzaENvbXBsZXRpb25Qcm92aWRlcihjbGllbnQpO1xuXHRjb250ZXh0LnN1YnNjcmlwdGlvbnMucHVzaChcblx0XHRzbGFzaENvbXBsZXRpb24sXG5cdFx0dnNjb2RlLmxhbmd1YWdlcy5yZWdpc3RlckNvbXBsZXRpb25JdGVtUHJvdmlkZXIoXG5cdFx0XHRbXG5cdFx0XHRcdHsgbGFuZ3VhZ2U6IFwibWFya2Rvd25cIiB9LFxuXHRcdFx0XHR7IGxhbmd1YWdlOiBcInBsYWludGV4dFwiIH0sXG5cdFx0XHRcdHsgbGFuZ3VhZ2U6IFwidHlwZXNjcmlwdFwiIH0sXG5cdFx0XHRcdHsgbGFuZ3VhZ2U6IFwidHlwZXNjcmlwdHJlYWN0XCIgfSxcblx0XHRcdFx0eyBsYW5ndWFnZTogXCJqYXZhc2NyaXB0XCIgfSxcblx0XHRcdFx0eyBsYW5ndWFnZTogXCJqYXZhc2NyaXB0cmVhY3RcIiB9LFxuXHRcdFx0XSxcblx0XHRcdHNsYXNoQ29tcGxldGlvbixcblx0XHRcdFwiL1wiLFxuXHRcdCksXG5cdCk7XG5cblx0Ly8gLS0gQ29kZSBsZW5zIFwiQXNrIEdTRFwiIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cblx0Y29uc3QgY29kZUxlbnNQcm92aWRlciA9IG5ldyBHc2RDb2RlTGVuc1Byb3ZpZGVyKGNsaWVudCk7XG5cdGNvbnRleHQuc3Vic2NyaXB0aW9ucy5wdXNoKFxuXHRcdGNvZGVMZW5zUHJvdmlkZXIsXG5cdFx0dnNjb2RlLmxhbmd1YWdlcy5yZWdpc3RlckNvZGVMZW5zUHJvdmlkZXIoXG5cdFx0XHRbXG5cdFx0XHRcdHsgbGFuZ3VhZ2U6IFwidHlwZXNjcmlwdFwiIH0sXG5cdFx0XHRcdHsgbGFuZ3VhZ2U6IFwidHlwZXNjcmlwdHJlYWN0XCIgfSxcblx0XHRcdFx0eyBsYW5ndWFnZTogXCJqYXZhc2NyaXB0XCIgfSxcblx0XHRcdFx0eyBsYW5ndWFnZTogXCJqYXZhc2NyaXB0cmVhY3RcIiB9LFxuXHRcdFx0XHR7IGxhbmd1YWdlOiBcInB5dGhvblwiIH0sXG5cdFx0XHRcdHsgbGFuZ3VhZ2U6IFwiZ29cIiB9LFxuXHRcdFx0XHR7IGxhbmd1YWdlOiBcInJ1c3RcIiB9LFxuXHRcdFx0XSxcblx0XHRcdGNvZGVMZW5zUHJvdmlkZXIsXG5cdFx0KSxcblx0KTtcblxuXHQvLyAtLSBDb21tYW5kcyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5cdC8vIFN0YXJ0XG5cdGNvbnRleHQuc3Vic2NyaXB0aW9ucy5wdXNoKFxuXHRcdHZzY29kZS5jb21tYW5kcy5yZWdpc3RlckNvbW1hbmQoXCJnc2Quc3RhcnRcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0YXdhaXQgY2xpZW50IS5zdGFydCgpO1xuXHRcdFx0XHQvLyBBcHBseSBhdXRvLWNvbXBhY3Rpb24gc2V0dGluZ1xuXHRcdFx0XHRjb25zdCBhdXRvQ29tcGFjdGlvbiA9IHZzY29kZS53b3Jrc3BhY2UuZ2V0Q29uZmlndXJhdGlvbihcImdzZFwiKS5nZXQ8Ym9vbGVhbj4oXCJhdXRvQ29tcGFjdGlvblwiLCB0cnVlKTtcblx0XHRcdFx0YXdhaXQgY2xpZW50IS5zZXRBdXRvQ29tcGFjdGlvbihhdXRvQ29tcGFjdGlvbikuY2F0Y2goKCkgPT4ge30pO1xuXHRcdFx0XHRzaWRlYmFyUHJvdmlkZXI/LnJlZnJlc2goKTtcblx0XHRcdFx0cmVmcmVzaFN0YXR1c0JhcigpO1xuXHRcdFx0XHR2c2NvZGUud2luZG93LnNob3dJbmZvcm1hdGlvbk1lc3NhZ2UoXCJHU0QgYWdlbnQgc3RhcnRlZC5cIik7XG5cdFx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdFx0aGFuZGxlRXJyb3IoZXJyLCBcIkZhaWxlZCB0byBzdGFydCBHU0RcIik7XG5cdFx0XHR9XG5cdFx0fSksXG5cdCk7XG5cblx0Ly8gU3RvcFxuXHRjb250ZXh0LnN1YnNjcmlwdGlvbnMucHVzaChcblx0XHR2c2NvZGUuY29tbWFuZHMucmVnaXN0ZXJDb21tYW5kKFwiZ3NkLnN0b3BcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdFx0YXdhaXQgY2xpZW50IS5zdG9wKCk7XG5cdFx0XHRzaWRlYmFyUHJvdmlkZXI/LnJlZnJlc2goKTtcblx0XHRcdHZzY29kZS53aW5kb3cuc2hvd0luZm9ybWF0aW9uTWVzc2FnZShcIkdTRCBhZ2VudCBzdG9wcGVkLlwiKTtcblx0XHR9KSxcblx0KTtcblxuXHQvLyBOZXcgU2Vzc2lvblxuXHRjb250ZXh0LnN1YnNjcmlwdGlvbnMucHVzaChcblx0XHR2c2NvZGUuY29tbWFuZHMucmVnaXN0ZXJDb21tYW5kKFwiZ3NkLm5ld1Nlc3Npb25cIiwgYXN5bmMgKCkgPT4ge1xuXHRcdFx0aWYgKCFyZXF1aXJlQ29ubmVjdGVkKCkpIHJldHVybjtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGF3YWl0IGNsaWVudCEubmV3U2Vzc2lvbigpO1xuXHRcdFx0XHRzaWRlYmFyUHJvdmlkZXI/LnJlZnJlc2goKTtcblx0XHRcdFx0c2Vzc2lvblRyZWVQcm92aWRlcj8ucmVmcmVzaCgpO1xuXHRcdFx0XHRmaWxlRGVjb3JhdGlvbnM/LmNsZWFyKCk7XG5cdFx0XHRcdHZzY29kZS53aW5kb3cuc2hvd0luZm9ybWF0aW9uTWVzc2FnZShcIk5ldyBHU0Qgc2Vzc2lvbiBzdGFydGVkLlwiKTtcblx0XHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0XHRoYW5kbGVFcnJvcihlcnIsIFwiRmFpbGVkIHRvIHN0YXJ0IG5ldyBzZXNzaW9uXCIpO1xuXHRcdFx0fVxuXHRcdH0pLFxuXHQpO1xuXG5cdC8vIFNlbmQgTWVzc2FnZVxuXHRjb250ZXh0LnN1YnNjcmlwdGlvbnMucHVzaChcblx0XHR2c2NvZGUuY29tbWFuZHMucmVnaXN0ZXJDb21tYW5kKFwiZ3NkLnNlbmRNZXNzYWdlXCIsIGFzeW5jICgpID0+IHtcblx0XHRcdGlmICghcmVxdWlyZUNvbm5lY3RlZCgpKSByZXR1cm47XG5cdFx0XHRjb25zdCBtZXNzYWdlID0gYXdhaXQgdnNjb2RlLndpbmRvdy5zaG93SW5wdXRCb3goe1xuXHRcdFx0XHRwcm9tcHQ6IFwiRW50ZXIgbWVzc2FnZSBmb3IgR1NEXCIsXG5cdFx0XHRcdHBsYWNlSG9sZGVyOiBcIldoYXQgc2hvdWxkIEkgZG8/XCIsXG5cdFx0XHR9KTtcblx0XHRcdGlmICghbWVzc2FnZSkgcmV0dXJuO1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0YXdhaXQgY2xpZW50IS5zZW5kUHJvbXB0KG1lc3NhZ2UpO1xuXHRcdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHRcdGhhbmRsZUVycm9yKGVyciwgXCJGYWlsZWQgdG8gc2VuZCBtZXNzYWdlXCIpO1xuXHRcdFx0fVxuXHRcdH0pLFxuXHQpO1xuXG5cdC8vIEFib3J0XG5cdGNvbnRleHQuc3Vic2NyaXB0aW9ucy5wdXNoKFxuXHRcdHZzY29kZS5jb21tYW5kcy5yZWdpc3RlckNvbW1hbmQoXCJnc2QuYWJvcnRcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdFx0aWYgKCFyZXF1aXJlQ29ubmVjdGVkKCkpIHJldHVybjtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGF3YWl0IGNsaWVudCEuYWJvcnQoKTtcblx0XHRcdFx0dnNjb2RlLndpbmRvdy5zaG93SW5mb3JtYXRpb25NZXNzYWdlKFwiT3BlcmF0aW9uIGFib3J0ZWQuXCIpO1xuXHRcdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHRcdGhhbmRsZUVycm9yKGVyciwgXCJGYWlsZWQgdG8gYWJvcnRcIik7XG5cdFx0XHR9XG5cdFx0fSksXG5cdCk7XG5cblx0Ly8gQ3ljbGUgTW9kZWxcblx0Y29udGV4dC5zdWJzY3JpcHRpb25zLnB1c2goXG5cdFx0dnNjb2RlLmNvbW1hbmRzLnJlZ2lzdGVyQ29tbWFuZChcImdzZC5jeWNsZU1vZGVsXCIsIGFzeW5jICgpID0+IHtcblx0XHRcdGlmICghcmVxdWlyZUNvbm5lY3RlZCgpKSByZXR1cm47XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCBjbGllbnQhLmN5Y2xlTW9kZWwoKTtcblx0XHRcdFx0aWYgKHJlc3VsdCkge1xuXHRcdFx0XHRcdHZzY29kZS53aW5kb3cuc2hvd0luZm9ybWF0aW9uTWVzc2FnZShcblx0XHRcdFx0XHRcdGBNb2RlbDogJHtyZXN1bHQubW9kZWwucHJvdmlkZXJ9LyR7cmVzdWx0Lm1vZGVsLmlkfSAodGhpbmtpbmc6ICR7cmVzdWx0LnRoaW5raW5nTGV2ZWx9KWAsXG5cdFx0XHRcdFx0KTtcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHR2c2NvZGUud2luZG93LnNob3dJbmZvcm1hdGlvbk1lc3NhZ2UoXCJObyBvdGhlciBtb2RlbHMgYXZhaWxhYmxlLlwiKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRzaWRlYmFyUHJvdmlkZXI/LnJlZnJlc2goKTtcblx0XHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0XHRoYW5kbGVFcnJvcihlcnIsIFwiRmFpbGVkIHRvIGN5Y2xlIG1vZGVsXCIpO1xuXHRcdFx0fVxuXHRcdH0pLFxuXHQpO1xuXG5cdC8vIFN3aXRjaCBNb2RlbCAoUXVpY2tQaWNrKVxuXHRjb250ZXh0LnN1YnNjcmlwdGlvbnMucHVzaChcblx0XHR2c2NvZGUuY29tbWFuZHMucmVnaXN0ZXJDb21tYW5kKFwiZ3NkLnN3aXRjaE1vZGVsXCIsIGFzeW5jICgpID0+IHtcblx0XHRcdGlmICghcmVxdWlyZUNvbm5lY3RlZCgpKSByZXR1cm47XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCBtb2RlbHMgPSBhd2FpdCBjbGllbnQhLmdldEF2YWlsYWJsZU1vZGVscygpO1xuXHRcdFx0XHRpZiAobW9kZWxzLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0XHRcdHZzY29kZS53aW5kb3cuc2hvd0luZm9ybWF0aW9uTWVzc2FnZShcIk5vIG1vZGVscyBhdmFpbGFibGUuXCIpO1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXHRcdFx0XHRjb25zdCBpdGVtcyA9IG1vZGVscy5tYXAoKG0pID0+ICh7XG5cdFx0XHRcdFx0bGFiZWw6IGAke20ucHJvdmlkZXJ9LyR7bS5pZH1gLFxuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOiBtLmNvbnRleHRXaW5kb3cgPyBgJHtNYXRoLnJvdW5kKG0uY29udGV4dFdpbmRvdyAvIDEwMDApfWsgY29udGV4dGAgOiB1bmRlZmluZWQsXG5cdFx0XHRcdFx0cHJvdmlkZXI6IG0ucHJvdmlkZXIsXG5cdFx0XHRcdFx0bW9kZWxJZDogbS5pZCxcblx0XHRcdFx0fSkpO1xuXHRcdFx0XHRjb25zdCBzZWxlY3RlZCA9IGF3YWl0IHZzY29kZS53aW5kb3cuc2hvd1F1aWNrUGljayhpdGVtcywge1xuXHRcdFx0XHRcdHBsYWNlSG9sZGVyOiBcIlNlbGVjdCBhIG1vZGVsXCIsXG5cdFx0XHRcdH0pO1xuXHRcdFx0XHRpZiAoIXNlbGVjdGVkKSByZXR1cm47XG5cdFx0XHRcdGF3YWl0IGNsaWVudCEuc2V0TW9kZWwoc2VsZWN0ZWQucHJvdmlkZXIsIHNlbGVjdGVkLm1vZGVsSWQpO1xuXHRcdFx0XHR2c2NvZGUud2luZG93LnNob3dJbmZvcm1hdGlvbk1lc3NhZ2UoYE1vZGVsIHNldCB0byAke3NlbGVjdGVkLmxhYmVsfWApO1xuXHRcdFx0XHRzaWRlYmFyUHJvdmlkZXI/LnJlZnJlc2goKTtcblx0XHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0XHRoYW5kbGVFcnJvcihlcnIsIFwiRmFpbGVkIHRvIHN3aXRjaCBtb2RlbFwiKTtcblx0XHRcdH1cblx0XHR9KSxcblx0KTtcblxuXHQvLyBDeWNsZSBUaGlua2luZyBMZXZlbFxuXHRjb250ZXh0LnN1YnNjcmlwdGlvbnMucHVzaChcblx0XHR2c2NvZGUuY29tbWFuZHMucmVnaXN0ZXJDb21tYW5kKFwiZ3NkLmN5Y2xlVGhpbmtpbmdcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdFx0aWYgKCFyZXF1aXJlQ29ubmVjdGVkKCkpIHJldHVybjtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNsaWVudCEuY3ljbGVUaGlua2luZ0xldmVsKCk7XG5cdFx0XHRcdGlmIChyZXN1bHQpIHtcblx0XHRcdFx0XHR2c2NvZGUud2luZG93LnNob3dJbmZvcm1hdGlvbk1lc3NhZ2UoYFRoaW5raW5nIGxldmVsOiAke3Jlc3VsdC5sZXZlbH1gKTtcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHR2c2NvZGUud2luZG93LnNob3dJbmZvcm1hdGlvbk1lc3NhZ2UoXCJDYW5ub3QgY2hhbmdlIHRoaW5raW5nIGxldmVsIGZvciB0aGlzIG1vZGVsLlwiKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRzaWRlYmFyUHJvdmlkZXI/LnJlZnJlc2goKTtcblx0XHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0XHRoYW5kbGVFcnJvcihlcnIsIFwiRmFpbGVkIHRvIGN5Y2xlIHRoaW5raW5nIGxldmVsXCIpO1xuXHRcdFx0fVxuXHRcdH0pLFxuXHQpO1xuXG5cdC8vIFNldCBUaGlua2luZyBMZXZlbCAoUXVpY2tQaWNrKVxuXHRjb250ZXh0LnN1YnNjcmlwdGlvbnMucHVzaChcblx0XHR2c2NvZGUuY29tbWFuZHMucmVnaXN0ZXJDb21tYW5kKFwiZ3NkLnNldFRoaW5raW5nXCIsIGFzeW5jICgpID0+IHtcblx0XHRcdGlmICghcmVxdWlyZUNvbm5lY3RlZCgpKSByZXR1cm47XG5cdFx0XHRjb25zdCBsZXZlbHM6IFRoaW5raW5nTGV2ZWxbXSA9IFtcIm9mZlwiLCBcImxvd1wiLCBcIm1lZGl1bVwiLCBcImhpZ2hcIl07XG5cdFx0XHRjb25zdCBzZWxlY3RlZCA9IGF3YWl0IHZzY29kZS53aW5kb3cuc2hvd1F1aWNrUGljayhsZXZlbHMsIHtcblx0XHRcdFx0cGxhY2VIb2xkZXI6IFwiU2VsZWN0IHRoaW5raW5nIGxldmVsXCIsXG5cdFx0XHR9KTtcblx0XHRcdGlmICghc2VsZWN0ZWQpIHJldHVybjtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGF3YWl0IGNsaWVudCEuc2V0VGhpbmtpbmdMZXZlbChzZWxlY3RlZCBhcyBUaGlua2luZ0xldmVsKTtcblx0XHRcdFx0dnNjb2RlLndpbmRvdy5zaG93SW5mb3JtYXRpb25NZXNzYWdlKGBUaGlua2luZyBsZXZlbCBzZXQgdG8gJHtzZWxlY3RlZH1gKTtcblx0XHRcdFx0c2lkZWJhclByb3ZpZGVyPy5yZWZyZXNoKCk7XG5cdFx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdFx0aGFuZGxlRXJyb3IoZXJyLCBcIkZhaWxlZCB0byBzZXQgdGhpbmtpbmcgbGV2ZWxcIik7XG5cdFx0XHR9XG5cdFx0fSksXG5cdCk7XG5cblx0Ly8gQ29tcGFjdCBDb250ZXh0XG5cdGNvbnRleHQuc3Vic2NyaXB0aW9ucy5wdXNoKFxuXHRcdHZzY29kZS5jb21tYW5kcy5yZWdpc3RlckNvbW1hbmQoXCJnc2QuY29tcGFjdFwiLCBhc3luYyAoKSA9PiB7XG5cdFx0XHRpZiAoIXJlcXVpcmVDb25uZWN0ZWQoKSkgcmV0dXJuO1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0YXdhaXQgY2xpZW50IS5jb21wYWN0KCk7XG5cdFx0XHRcdHZzY29kZS53aW5kb3cuc2hvd0luZm9ybWF0aW9uTWVzc2FnZShcIkNvbnRleHQgY29tcGFjdGVkLlwiKTtcblx0XHRcdFx0c2lkZWJhclByb3ZpZGVyPy5yZWZyZXNoKCk7XG5cdFx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdFx0aGFuZGxlRXJyb3IoZXJyLCBcIkZhaWxlZCB0byBjb21wYWN0IGNvbnRleHRcIik7XG5cdFx0XHR9XG5cdFx0fSksXG5cdCk7XG5cblx0Ly8gRXhwb3J0IEhUTUxcblx0Y29udGV4dC5zdWJzY3JpcHRpb25zLnB1c2goXG5cdFx0dnNjb2RlLmNvbW1hbmRzLnJlZ2lzdGVyQ29tbWFuZChcImdzZC5leHBvcnRIdG1sXCIsIGFzeW5jICgpID0+IHtcblx0XHRcdGlmICghcmVxdWlyZUNvbm5lY3RlZCgpKSByZXR1cm47XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCBzYXZlVXJpID0gYXdhaXQgdnNjb2RlLndpbmRvdy5zaG93U2F2ZURpYWxvZyh7XG5cdFx0XHRcdFx0ZGVmYXVsdFVyaTogdnNjb2RlLlVyaS5maWxlKFwiZ3NkLWNvbnZlcnNhdGlvbi5odG1sXCIpLFxuXHRcdFx0XHRcdGZpbHRlcnM6IHsgXCJIVE1MIEZpbGVzXCI6IFtcImh0bWxcIl0gfSxcblx0XHRcdFx0fSk7XG5cdFx0XHRcdGNvbnN0IG91dHB1dFBhdGggPSBzYXZlVXJpPy5mc1BhdGg7XG5cdFx0XHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNsaWVudCEuZXhwb3J0SHRtbChvdXRwdXRQYXRoKTtcblx0XHRcdFx0dnNjb2RlLndpbmRvdy5zaG93SW5mb3JtYXRpb25NZXNzYWdlKGBDb252ZXJzYXRpb24gZXhwb3J0ZWQgdG8gJHtyZXN1bHQucGF0aH1gKTtcblx0XHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0XHRoYW5kbGVFcnJvcihlcnIsIFwiRmFpbGVkIHRvIGV4cG9ydCBIVE1MXCIpO1xuXHRcdFx0fVxuXHRcdH0pLFxuXHQpO1xuXG5cdC8vIFNlc3Npb24gU3RhdHNcblx0Y29udGV4dC5zdWJzY3JpcHRpb25zLnB1c2goXG5cdFx0dnNjb2RlLmNvbW1hbmRzLnJlZ2lzdGVyQ29tbWFuZChcImdzZC5zZXNzaW9uU3RhdHNcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdFx0aWYgKCFyZXF1aXJlQ29ubmVjdGVkKCkpIHJldHVybjtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnN0IHN0YXRzID0gYXdhaXQgY2xpZW50IS5nZXRTZXNzaW9uU3RhdHMoKTtcblx0XHRcdFx0Y29uc3QgbGluZXMgPSBmb3JtYXRTZXNzaW9uU3RhdHNMaW5lcyhzdGF0cyk7XG5cblx0XHRcdFx0dnNjb2RlLndpbmRvdy5zaG93SW5mb3JtYXRpb25NZXNzYWdlKFxuXHRcdFx0XHRcdGxpbmVzLmxlbmd0aCA+IDAgPyBsaW5lcy5qb2luKFwiIHwgXCIpIDogXCJObyBzdGF0cyBhdmFpbGFibGUuXCIsXG5cdFx0XHRcdCk7XG5cdFx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdFx0aGFuZGxlRXJyb3IoZXJyLCBcIkZhaWxlZCB0byBnZXQgc2Vzc2lvbiBzdGF0c1wiKTtcblx0XHRcdH1cblx0XHR9KSxcblx0KTtcblxuXHQvLyBSdW4gQmFzaCBDb21tYW5kXG5cdGNvbnRleHQuc3Vic2NyaXB0aW9ucy5wdXNoKFxuXHRcdHZzY29kZS5jb21tYW5kcy5yZWdpc3RlckNvbW1hbmQoXCJnc2QucnVuQmFzaFwiLCBhc3luYyAoKSA9PiB7XG5cdFx0XHRpZiAoIXJlcXVpcmVDb25uZWN0ZWQoKSkgcmV0dXJuO1xuXHRcdFx0Y29uc3QgY29tbWFuZCA9IGF3YWl0IHZzY29kZS53aW5kb3cuc2hvd0lucHV0Qm94KHtcblx0XHRcdFx0cHJvbXB0OiBcIkVudGVyIGJhc2ggY29tbWFuZCB0byBleGVjdXRlXCIsXG5cdFx0XHRcdHBsYWNlSG9sZGVyOiBcImxzIC1sYVwiLFxuXHRcdFx0fSk7XG5cdFx0XHRpZiAoIWNvbW1hbmQpIHJldHVybjtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNsaWVudCEucnVuQmFzaChjb21tYW5kKTtcblx0XHRcdFx0b3V0cHV0Q2hhbm5lbC5hcHBlbmRMaW5lKGBbYmFzaF0gJCAke2NvbW1hbmR9YCk7XG5cdFx0XHRcdGNvbnN0IG91dHB1dCA9IGdldEJhc2hPdXRwdXQocmVzdWx0KTtcblx0XHRcdFx0aWYgKG91dHB1dCkgb3V0cHV0Q2hhbm5lbC5hcHBlbmRMaW5lKG91dHB1dCk7XG5cdFx0XHRcdG91dHB1dENoYW5uZWwuYXBwZW5kTGluZShgW2V4aXQgY29kZTogJHtnZXRCYXNoRXhpdENvZGUocmVzdWx0KSA/PyBcInVua25vd25cIn1dYCk7XG5cdFx0XHRcdG91dHB1dENoYW5uZWwuc2hvdyh0cnVlKTtcblxuXHRcdFx0XHRpZiAoZ2V0QmFzaEV4aXRDb2RlKHJlc3VsdCkgPT09IDApIHtcblx0XHRcdFx0XHR2c2NvZGUud2luZG93LnNob3dJbmZvcm1hdGlvbk1lc3NhZ2UoXCJCYXNoIGNvbW1hbmQgY29tcGxldGVkIHN1Y2Nlc3NmdWxseS5cIik7XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0dnNjb2RlLndpbmRvdy5zaG93V2FybmluZ01lc3NhZ2UoYEJhc2ggY29tbWFuZCBleGl0ZWQgd2l0aCBjb2RlICR7Z2V0QmFzaEV4aXRDb2RlKHJlc3VsdCkgPz8gXCJ1bmtub3duXCJ9YCk7XG5cdFx0XHRcdH1cblx0XHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0XHRoYW5kbGVFcnJvcihlcnIsIFwiRmFpbGVkIHRvIHJ1biBiYXNoIGNvbW1hbmRcIik7XG5cdFx0XHR9XG5cdFx0fSksXG5cdCk7XG5cblx0Ly8gU3RlZXIgQWdlbnRcblx0Y29udGV4dC5zdWJzY3JpcHRpb25zLnB1c2goXG5cdFx0dnNjb2RlLmNvbW1hbmRzLnJlZ2lzdGVyQ29tbWFuZChcImdzZC5zdGVlclwiLCBhc3luYyAoKSA9PiB7XG5cdFx0XHRpZiAoIXJlcXVpcmVDb25uZWN0ZWQoKSkgcmV0dXJuO1xuXHRcdFx0Y29uc3QgbWVzc2FnZSA9IGF3YWl0IHZzY29kZS53aW5kb3cuc2hvd0lucHV0Qm94KHtcblx0XHRcdFx0cHJvbXB0OiBcIkVudGVyIHN0ZWVyaW5nIG1lc3NhZ2UgKGludGVycnVwdHMgY3VycmVudCBvcGVyYXRpb24pXCIsXG5cdFx0XHRcdHBsYWNlSG9sZGVyOiBcIkZvY3VzIG9uIHRoZSBlcnJvciBoYW5kbGluZyBpbnN0ZWFkXCIsXG5cdFx0XHR9KTtcblx0XHRcdGlmICghbWVzc2FnZSkgcmV0dXJuO1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0YXdhaXQgY2xpZW50IS5zdGVlcihtZXNzYWdlKTtcblx0XHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0XHRoYW5kbGVFcnJvcihlcnIsIFwiRmFpbGVkIHRvIHN0ZWVyIGFnZW50XCIpO1xuXHRcdFx0fVxuXHRcdH0pLFxuXHQpO1xuXG5cdC8vIExpc3QgQXZhaWxhYmxlIENvbW1hbmRzXG5cdGNvbnRleHQuc3Vic2NyaXB0aW9ucy5wdXNoKFxuXHRcdHZzY29kZS5jb21tYW5kcy5yZWdpc3RlckNvbW1hbmQoXCJnc2QubGlzdENvbW1hbmRzXCIsIGFzeW5jICgpID0+IHtcblx0XHRcdGlmICghcmVxdWlyZUNvbm5lY3RlZCgpKSByZXR1cm47XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCBjb21tYW5kcyA9IGF3YWl0IGNsaWVudCEuZ2V0Q29tbWFuZHMoKTtcblx0XHRcdFx0aWYgKGNvbW1hbmRzLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0XHRcdHZzY29kZS53aW5kb3cuc2hvd0luZm9ybWF0aW9uTWVzc2FnZShcIk5vIHNsYXNoIGNvbW1hbmRzIGF2YWlsYWJsZS5cIik7XG5cdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGNvbnN0IGl0ZW1zID0gY29tbWFuZHMubWFwKChjbWQpID0+ICh7XG5cdFx0XHRcdFx0bGFiZWw6IGAvJHtjbWQubmFtZX1gLFxuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOiBjbWQuZGVzY3JpcHRpb24gPz8gXCJcIixcblx0XHRcdFx0XHRkZXRhaWw6IGBTb3VyY2U6ICR7Y21kLnNvdXJjZX0ke2NtZC5sb2NhdGlvbiA/IGAgKCR7Y21kLmxvY2F0aW9ufSlgIDogXCJcIn1gLFxuXHRcdFx0XHR9KSk7XG5cdFx0XHRcdGNvbnN0IHNlbGVjdGVkID0gYXdhaXQgdnNjb2RlLndpbmRvdy5zaG93UXVpY2tQaWNrKGl0ZW1zLCB7XG5cdFx0XHRcdFx0cGxhY2VIb2xkZXI6IFwiQXZhaWxhYmxlIHNsYXNoIGNvbW1hbmRzXCIsXG5cdFx0XHRcdH0pO1xuXHRcdFx0XHRpZiAoc2VsZWN0ZWQpIHtcblx0XHRcdFx0XHQvLyBTZW5kIHRoZSBzZWxlY3RlZCBjb21tYW5kIGFzIGEgcHJvbXB0XG5cdFx0XHRcdFx0YXdhaXQgY2xpZW50IS5zZW5kUHJvbXB0KHNlbGVjdGVkLmxhYmVsKTtcblx0XHRcdFx0fVxuXHRcdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHRcdGhhbmRsZUVycm9yKGVyciwgXCJGYWlsZWQgdG8gbGlzdCBjb21tYW5kc1wiKTtcblx0XHRcdH1cblx0XHR9KSxcblx0KTtcblxuXHQvLyBTd2l0Y2ggU2Vzc2lvblxuXHRjb250ZXh0LnN1YnNjcmlwdGlvbnMucHVzaChcblx0XHR2c2NvZGUuY29tbWFuZHMucmVnaXN0ZXJDb21tYW5kKFwiZ3NkLnN3aXRjaFNlc3Npb25cIiwgYXN5bmMgKHNlc3Npb25GaWxlPzogc3RyaW5nKSA9PiB7XG5cdFx0XHRpZiAoIXJlcXVpcmVDb25uZWN0ZWQoKSkgcmV0dXJuO1xuXHRcdFx0Y29uc3QgZmlsZSA9IHNlc3Npb25GaWxlID8/IGF3YWl0IChhc3luYyAoKSA9PiB7XG5cdFx0XHRcdGNvbnN0IGlucHV0ID0gYXdhaXQgdnNjb2RlLndpbmRvdy5zaG93SW5wdXRCb3goe1xuXHRcdFx0XHRcdHByb21wdDogXCJFbnRlciBzZXNzaW9uIGZpbGUgcGF0aFwiLFxuXHRcdFx0XHRcdHBsYWNlSG9sZGVyOiBcIi9wYXRoL3RvL3Nlc3Npb24uanNvbmxcIixcblx0XHRcdFx0fSk7XG5cdFx0XHRcdHJldHVybiBpbnB1dDtcblx0XHRcdH0pKCk7XG5cdFx0XHRpZiAoIWZpbGUpIHJldHVybjtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGF3YWl0IGNsaWVudCEuc3dpdGNoU2Vzc2lvbihmaWxlKTtcblx0XHRcdFx0c2lkZWJhclByb3ZpZGVyPy5yZWZyZXNoKCk7XG5cdFx0XHRcdHNlc3Npb25UcmVlUHJvdmlkZXI/LnJlZnJlc2goKTtcblx0XHRcdFx0dnNjb2RlLndpbmRvdy5zaG93SW5mb3JtYXRpb25NZXNzYWdlKFwiU3dpdGNoZWQgc2Vzc2lvbi5cIik7XG5cdFx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdFx0aGFuZGxlRXJyb3IoZXJyLCBcIkZhaWxlZCB0byBzd2l0Y2ggc2Vzc2lvblwiKTtcblx0XHRcdH1cblx0XHR9KSxcblx0KTtcblxuXHQvLyBSZWZyZXNoIFNlc3Npb25zXG5cdGNvbnRleHQuc3Vic2NyaXB0aW9ucy5wdXNoKFxuXHRcdHZzY29kZS5jb21tYW5kcy5yZWdpc3RlckNvbW1hbmQoXCJnc2QucmVmcmVzaFNlc3Npb25zXCIsICgpID0+IHtcblx0XHRcdHNlc3Npb25UcmVlUHJvdmlkZXI/LnJlZnJlc2goKTtcblx0XHR9KSxcblx0KTtcblxuXHQvLyBTaG93IENvbnZlcnNhdGlvbiBIaXN0b3J5XG5cdGNvbnRleHQuc3Vic2NyaXB0aW9ucy5wdXNoKFxuXHRcdHZzY29kZS5jb21tYW5kcy5yZWdpc3RlckNvbW1hbmQoXCJnc2Quc2hvd0hpc3RvcnlcIiwgKCkgPT4ge1xuXHRcdFx0aWYgKCFyZXF1aXJlQ29ubmVjdGVkKCkpIHJldHVybjtcblx0XHRcdEdzZENvbnZlcnNhdGlvbkhpc3RvcnlQYW5lbC5jcmVhdGVPclNob3coY29udGV4dC5leHRlbnNpb25VcmksIGNsaWVudCEpO1xuXHRcdH0pLFxuXHQpO1xuXG5cdC8vIEFzayBBYm91dCBTeW1ib2wgKHRyaWdnZXJlZCBieSBjb2RlIGxlbnMpXG5cdGNvbnRleHQuc3Vic2NyaXB0aW9ucy5wdXNoKFxuXHRcdHZzY29kZS5jb21tYW5kcy5yZWdpc3RlckNvbW1hbmQoXG5cdFx0XHRcImdzZC5hc2tBYm91dFN5bWJvbFwiLFxuXHRcdFx0YXN5bmMgKHN5bWJvbE5hbWU6IHN0cmluZywgZmlsZU5hbWU6IHN0cmluZywgbGluZU51bWJlcjogbnVtYmVyKSA9PiB7XG5cdFx0XHRcdGlmICghcmVxdWlyZUNvbm5lY3RlZCgpKSByZXR1cm47XG5cdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0Y29uc3QgcHJvbXB0ID0gYEV4cGxhaW4gdGhlIFxcYCR7c3ltYm9sTmFtZX1cXGAgZnVuY3Rpb24vY2xhc3MgaW4gJHtmaWxlTmFtZX0gKGxpbmUgJHtsaW5lTnVtYmVyfSkuIEJlIGNvbmNpc2UuYDtcblx0XHRcdFx0XHRhd2FpdCBjbGllbnQhLnNlbmRQcm9tcHQocHJvbXB0KTtcblx0XHRcdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHRcdFx0aGFuZGxlRXJyb3IoZXJyLCBcIkZhaWxlZCB0byBzZW5kIEFzayBHU0QgcmVxdWVzdFwiKTtcblx0XHRcdFx0fVxuXHRcdFx0fSxcblx0XHQpLFxuXHQpO1xuXG5cdC8vIENsZWFyIEZpbGUgRGVjb3JhdGlvbnNcblx0Y29udGV4dC5zdWJzY3JpcHRpb25zLnB1c2goXG5cdFx0dnNjb2RlLmNvbW1hbmRzLnJlZ2lzdGVyQ29tbWFuZChcImdzZC5jbGVhckZpbGVEZWNvcmF0aW9uc1wiLCAoKSA9PiB7XG5cdFx0XHRmaWxlRGVjb3JhdGlvbnM/LmNsZWFyKCk7XG5cdFx0fSksXG5cdCk7XG5cblx0Ly8gQ2xlYXIgQWN0aXZpdHkgRmVlZFxuXHRjb250ZXh0LnN1YnNjcmlwdGlvbnMucHVzaChcblx0XHR2c2NvZGUuY29tbWFuZHMucmVnaXN0ZXJDb21tYW5kKFwiZ3NkLmNsZWFyQWN0aXZpdHlcIiwgKCkgPT4ge1xuXHRcdFx0YWN0aXZpdHlGZWVkUHJvdmlkZXI/LmNsZWFyKCk7XG5cdFx0fSksXG5cdCk7XG5cblx0Ly8gRm9yayBTZXNzaW9uXG5cdGNvbnRleHQuc3Vic2NyaXB0aW9ucy5wdXNoKFxuXHRcdHZzY29kZS5jb21tYW5kcy5yZWdpc3RlckNvbW1hbmQoXCJnc2QuZm9ya1Nlc3Npb25cIiwgYXN5bmMgKCkgPT4ge1xuXHRcdFx0aWYgKCFyZXF1aXJlQ29ubmVjdGVkKCkpIHJldHVybjtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnN0IG1lc3NhZ2VzID0gYXdhaXQgY2xpZW50IS5nZXRGb3JrTWVzc2FnZXMoKTtcblx0XHRcdFx0aWYgKG1lc3NhZ2VzLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0XHRcdHZzY29kZS53aW5kb3cuc2hvd0luZm9ybWF0aW9uTWVzc2FnZShcIk5vIGZvcmsgcG9pbnRzIGF2YWlsYWJsZS5cIik7XG5cdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGNvbnN0IGl0ZW1zID0gbWVzc2FnZXMubWFwKChtKSA9PiAoe1xuXHRcdFx0XHRcdGxhYmVsOiBtLnRleHQuc2xpY2UoMCwgODApICsgKG0udGV4dC5sZW5ndGggPiA4MCA/IFwiLi4uXCIgOiBcIlwiKSxcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjogbS5lbnRyeUlkLFxuXHRcdFx0XHRcdGVudHJ5SWQ6IG0uZW50cnlJZCxcblx0XHRcdFx0fSkpO1xuXHRcdFx0XHRjb25zdCBzZWxlY3RlZCA9IGF3YWl0IHZzY29kZS53aW5kb3cuc2hvd1F1aWNrUGljayhpdGVtcywge1xuXHRcdFx0XHRcdHBsYWNlSG9sZGVyOiBcIlNlbGVjdCBhIG1lc3NhZ2UgdG8gZm9yayBmcm9tXCIsXG5cdFx0XHRcdH0pO1xuXHRcdFx0XHRpZiAoIXNlbGVjdGVkKSByZXR1cm47XG5cdFx0XHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNsaWVudCEuZm9ya1Nlc3Npb24oc2VsZWN0ZWQuZW50cnlJZCk7XG5cdFx0XHRcdGlmICghcmVzdWx0LmNhbmNlbGxlZCkge1xuXHRcdFx0XHRcdHZzY29kZS53aW5kb3cuc2hvd0luZm9ybWF0aW9uTWVzc2FnZShcIlNlc3Npb24gZm9ya2VkIHN1Y2Nlc3NmdWxseS5cIik7XG5cdFx0XHRcdFx0c2lkZWJhclByb3ZpZGVyPy5yZWZyZXNoKCk7XG5cdFx0XHRcdFx0c2Vzc2lvblRyZWVQcm92aWRlcj8ucmVmcmVzaCgpO1xuXHRcdFx0XHR9XG5cdFx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdFx0aGFuZGxlRXJyb3IoZXJyLCBcIkZhaWxlZCB0byBmb3JrIHNlc3Npb25cIik7XG5cdFx0XHR9XG5cdFx0fSksXG5cdCk7XG5cblx0Ly8gVG9nZ2xlIFN0ZWVyaW5nIE1vZGVcblx0Y29udGV4dC5zdWJzY3JpcHRpb25zLnB1c2goXG5cdFx0dnNjb2RlLmNvbW1hbmRzLnJlZ2lzdGVyQ29tbWFuZChcImdzZC50b2dnbGVTdGVlcmluZ01vZGVcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdFx0aWYgKCFyZXF1aXJlQ29ubmVjdGVkKCkpIHJldHVybjtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnN0IHN0YXRlID0gYXdhaXQgY2xpZW50IS5nZXRTdGF0ZSgpO1xuXHRcdFx0XHRjb25zdCBuZXh0ID0gc3RhdGUuc3RlZXJpbmdNb2RlID09PSBcImFsbFwiID8gXCJvbmUtYXQtYS10aW1lXCIgOiBcImFsbFwiO1xuXHRcdFx0XHRhd2FpdCBjbGllbnQhLnNldFN0ZWVyaW5nTW9kZShuZXh0KTtcblx0XHRcdFx0dnNjb2RlLndpbmRvdy5zaG93SW5mb3JtYXRpb25NZXNzYWdlKGBTdGVlcmluZyBtb2RlOiAke25leHR9YCk7XG5cdFx0XHRcdHNpZGViYXJQcm92aWRlcj8ucmVmcmVzaCgpO1xuXHRcdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHRcdGhhbmRsZUVycm9yKGVyciwgXCJGYWlsZWQgdG8gdG9nZ2xlIHN0ZWVyaW5nIG1vZGVcIik7XG5cdFx0XHR9XG5cdFx0fSksXG5cdCk7XG5cblx0Ly8gVG9nZ2xlIEZvbGxvdy1VcCBNb2RlXG5cdGNvbnRleHQuc3Vic2NyaXB0aW9ucy5wdXNoKFxuXHRcdHZzY29kZS5jb21tYW5kcy5yZWdpc3RlckNvbW1hbmQoXCJnc2QudG9nZ2xlRm9sbG93VXBNb2RlXCIsIGFzeW5jICgpID0+IHtcblx0XHRcdGlmICghcmVxdWlyZUNvbm5lY3RlZCgpKSByZXR1cm47XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCBzdGF0ZSA9IGF3YWl0IGNsaWVudCEuZ2V0U3RhdGUoKTtcblx0XHRcdFx0Y29uc3QgbmV4dCA9IHN0YXRlLmZvbGxvd1VwTW9kZSA9PT0gXCJhbGxcIiA/IFwib25lLWF0LWEtdGltZVwiIDogXCJhbGxcIjtcblx0XHRcdFx0YXdhaXQgY2xpZW50IS5zZXRGb2xsb3dVcE1vZGUobmV4dCk7XG5cdFx0XHRcdHZzY29kZS53aW5kb3cuc2hvd0luZm9ybWF0aW9uTWVzc2FnZShgRm9sbG93LXVwIG1vZGU6ICR7bmV4dH1gKTtcblx0XHRcdFx0c2lkZWJhclByb3ZpZGVyPy5yZWZyZXNoKCk7XG5cdFx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdFx0aGFuZGxlRXJyb3IoZXJyLCBcIkZhaWxlZCB0byB0b2dnbGUgZm9sbG93LXVwIG1vZGVcIik7XG5cdFx0XHR9XG5cdFx0fSksXG5cdCk7XG5cblx0Ly8gUmVmYWN0b3IgU3ltYm9sIChjb2RlIGxlbnMpXG5cdGNvbnRleHQuc3Vic2NyaXB0aW9ucy5wdXNoKFxuXHRcdHZzY29kZS5jb21tYW5kcy5yZWdpc3RlckNvbW1hbmQoXG5cdFx0XHRcImdzZC5yZWZhY3RvclN5bWJvbFwiLFxuXHRcdFx0YXN5bmMgKHN5bWJvbE5hbWU6IHN0cmluZywgZmlsZU5hbWU6IHN0cmluZywgbGluZU51bWJlcjogbnVtYmVyKSA9PiB7XG5cdFx0XHRcdGlmICghcmVxdWlyZUNvbm5lY3RlZCgpKSByZXR1cm47XG5cdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0YXdhaXQgY2xpZW50IS5zZW5kUHJvbXB0KGBSZWZhY3RvciB0aGUgXFxgJHtzeW1ib2xOYW1lfVxcYCBmdW5jdGlvbi9jbGFzcyBpbiAke2ZpbGVOYW1lfSAobGluZSAke2xpbmVOdW1iZXJ9KS4gSW1wcm92ZSBjbGFyaXR5LCBwZXJmb3JtYW5jZSwgb3Igc3RydWN0dXJlIHdoaWxlIHByZXNlcnZpbmcgYmVoYXZpb3IuYCk7XG5cdFx0XHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0XHRcdGhhbmRsZUVycm9yKGVyciwgXCJGYWlsZWQgdG8gc2VuZCByZWZhY3RvciByZXF1ZXN0XCIpO1xuXHRcdFx0XHR9XG5cdFx0XHR9LFxuXHRcdCksXG5cdCk7XG5cblx0Ly8gRmluZCBCdWdzIGluIFN5bWJvbCAoY29kZSBsZW5zKVxuXHRjb250ZXh0LnN1YnNjcmlwdGlvbnMucHVzaChcblx0XHR2c2NvZGUuY29tbWFuZHMucmVnaXN0ZXJDb21tYW5kKFxuXHRcdFx0XCJnc2QuZmluZEJ1Z3NTeW1ib2xcIixcblx0XHRcdGFzeW5jIChzeW1ib2xOYW1lOiBzdHJpbmcsIGZpbGVOYW1lOiBzdHJpbmcsIGxpbmVOdW1iZXI6IG51bWJlcikgPT4ge1xuXHRcdFx0XHRpZiAoIXJlcXVpcmVDb25uZWN0ZWQoKSkgcmV0dXJuO1xuXHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdGF3YWl0IGNsaWVudCEuc2VuZFByb21wdChgUmV2aWV3IHRoZSBcXGAke3N5bWJvbE5hbWV9XFxgIGZ1bmN0aW9uL2NsYXNzIGluICR7ZmlsZU5hbWV9IChsaW5lICR7bGluZU51bWJlcn0pIGZvciBwb3RlbnRpYWwgYnVncywgZWRnZSBjYXNlcywgYW5kIGlzc3Vlcy5gKTtcblx0XHRcdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHRcdFx0aGFuZGxlRXJyb3IoZXJyLCBcIkZhaWxlZCB0byBzZW5kIGJ1ZyByZXZpZXcgcmVxdWVzdFwiKTtcblx0XHRcdFx0fVxuXHRcdFx0fSxcblx0XHQpLFxuXHQpO1xuXG5cdC8vIEdlbmVyYXRlIFRlc3RzIGZvciBTeW1ib2wgKGNvZGUgbGVucylcblx0Y29udGV4dC5zdWJzY3JpcHRpb25zLnB1c2goXG5cdFx0dnNjb2RlLmNvbW1hbmRzLnJlZ2lzdGVyQ29tbWFuZChcblx0XHRcdFwiZ3NkLmdlbmVyYXRlVGVzdHNTeW1ib2xcIixcblx0XHRcdGFzeW5jIChzeW1ib2xOYW1lOiBzdHJpbmcsIGZpbGVOYW1lOiBzdHJpbmcsIGxpbmVOdW1iZXI6IG51bWJlcikgPT4ge1xuXHRcdFx0XHRpZiAoIXJlcXVpcmVDb25uZWN0ZWQoKSkgcmV0dXJuO1xuXHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdGF3YWl0IGNsaWVudCEuc2VuZFByb21wdChgR2VuZXJhdGUgY29tcHJlaGVuc2l2ZSB0ZXN0cyBmb3IgdGhlIFxcYCR7c3ltYm9sTmFtZX1cXGAgZnVuY3Rpb24vY2xhc3MgaW4gJHtmaWxlTmFtZX0gKGxpbmUgJHtsaW5lTnVtYmVyfSkuIENvdmVyIHN1Y2Nlc3MgcGF0aHMsIGVkZ2UgY2FzZXMsIGFuZCBlcnJvciBzY2VuYXJpb3MuYCk7XG5cdFx0XHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0XHRcdGhhbmRsZUVycm9yKGVyciwgXCJGYWlsZWQgdG8gc2VuZCB0ZXN0IGdlbmVyYXRpb24gcmVxdWVzdFwiKTtcblx0XHRcdFx0fVxuXHRcdFx0fSxcblx0XHQpLFxuXHQpO1xuXG5cdC8vIFRvZ2dsZSBBdXRvLVJldHJ5XG5cdGNvbnRleHQuc3Vic2NyaXB0aW9ucy5wdXNoKFxuXHRcdHZzY29kZS5jb21tYW5kcy5yZWdpc3RlckNvbW1hbmQoXCJnc2QudG9nZ2xlQXV0b1JldHJ5XCIsIGFzeW5jICgpID0+IHtcblx0XHRcdGlmICghcmVxdWlyZUNvbm5lY3RlZCgpKSByZXR1cm47XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCBuZXh0ID0gIWNsaWVudCEuYXV0b1JldHJ5RW5hYmxlZDtcblx0XHRcdFx0YXdhaXQgY2xpZW50IS5zZXRBdXRvUmV0cnkobmV4dCk7XG5cdFx0XHRcdHZzY29kZS53aW5kb3cuc2hvd0luZm9ybWF0aW9uTWVzc2FnZShgQXV0by1yZXRyeSAke25leHQgPyBcImVuYWJsZWRcIiA6IFwiZGlzYWJsZWRcIn0uYCk7XG5cdFx0XHRcdHNpZGViYXJQcm92aWRlcj8ucmVmcmVzaCgpO1xuXHRcdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHRcdGhhbmRsZUVycm9yKGVyciwgXCJGYWlsZWQgdG8gdG9nZ2xlIGF1dG8tcmV0cnlcIik7XG5cdFx0XHR9XG5cdFx0fSksXG5cdCk7XG5cblx0Ly8gQWJvcnQgUmV0cnlcblx0Y29udGV4dC5zdWJzY3JpcHRpb25zLnB1c2goXG5cdFx0dnNjb2RlLmNvbW1hbmRzLnJlZ2lzdGVyQ29tbWFuZChcImdzZC5hYm9ydFJldHJ5XCIsIGFzeW5jICgpID0+IHtcblx0XHRcdGlmICghcmVxdWlyZUNvbm5lY3RlZCgpKSByZXR1cm47XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRhd2FpdCBjbGllbnQhLmFib3J0UmV0cnkoKTtcblx0XHRcdFx0dnNjb2RlLndpbmRvdy5zaG93SW5mb3JtYXRpb25NZXNzYWdlKFwiUmV0cnkgYWJvcnRlZC5cIik7XG5cdFx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdFx0aGFuZGxlRXJyb3IoZXJyLCBcIkZhaWxlZCB0byBhYm9ydCByZXRyeVwiKTtcblx0XHRcdH1cblx0XHR9KSxcblx0KTtcblxuXHQvLyBTZXQgU2Vzc2lvbiBOYW1lXG5cdGNvbnRleHQuc3Vic2NyaXB0aW9ucy5wdXNoKFxuXHRcdHZzY29kZS5jb21tYW5kcy5yZWdpc3RlckNvbW1hbmQoXCJnc2Quc2V0U2Vzc2lvbk5hbWVcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdFx0aWYgKCFyZXF1aXJlQ29ubmVjdGVkKCkpIHJldHVybjtcblx0XHRcdGNvbnN0IG5hbWUgPSBhd2FpdCB2c2NvZGUud2luZG93LnNob3dJbnB1dEJveCh7XG5cdFx0XHRcdHByb21wdDogXCJFbnRlciBhIG5hbWUgZm9yIHRoaXMgc2Vzc2lvblwiLFxuXHRcdFx0XHRwbGFjZUhvbGRlcjogXCJlLmcuIGF1dGgtcmVmYWN0b3JcIixcblx0XHRcdH0pO1xuXHRcdFx0aWYgKCFuYW1lKSByZXR1cm47XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRhd2FpdCBjbGllbnQhLnNldFNlc3Npb25OYW1lKG5hbWUpO1xuXHRcdFx0XHRzaWRlYmFyUHJvdmlkZXI/LnJlZnJlc2goKTtcblx0XHRcdFx0dnNjb2RlLndpbmRvdy5zaG93SW5mb3JtYXRpb25NZXNzYWdlKGBTZXNzaW9uIG5hbWVkIFwiJHtuYW1lfVwiLmApO1xuXHRcdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHRcdGhhbmRsZUVycm9yKGVyciwgXCJGYWlsZWQgdG8gc2V0IHNlc3Npb24gbmFtZVwiKTtcblx0XHRcdH1cblx0XHR9KSxcblx0KTtcblxuXHQvLyBDb3B5IExhc3QgUmVzcG9uc2Vcblx0Y29udGV4dC5zdWJzY3JpcHRpb25zLnB1c2goXG5cdFx0dnNjb2RlLmNvbW1hbmRzLnJlZ2lzdGVyQ29tbWFuZChcImdzZC5jb3B5TGFzdFJlc3BvbnNlXCIsIGFzeW5jICgpID0+IHtcblx0XHRcdGlmICghcmVxdWlyZUNvbm5lY3RlZCgpKSByZXR1cm47XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCB0ZXh0ID0gYXdhaXQgY2xpZW50IS5nZXRMYXN0QXNzaXN0YW50VGV4dCgpO1xuXHRcdFx0XHRpZiAoIXRleHQpIHtcblx0XHRcdFx0XHR2c2NvZGUud2luZG93LnNob3dJbmZvcm1hdGlvbk1lc3NhZ2UoXCJObyByZXNwb25zZSB0byBjb3B5LlwiKTtcblx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdH1cblx0XHRcdFx0YXdhaXQgdnNjb2RlLmVudi5jbGlwYm9hcmQud3JpdGVUZXh0KHRleHQpO1xuXHRcdFx0XHR2c2NvZGUud2luZG93LnNob3dJbmZvcm1hdGlvbk1lc3NhZ2UoXCJMYXN0IHJlc3BvbnNlIGNvcGllZCB0byBjbGlwYm9hcmQuXCIpO1xuXHRcdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHRcdGhhbmRsZUVycm9yKGVyciwgXCJGYWlsZWQgdG8gY29weSBsYXN0IHJlc3BvbnNlXCIpO1xuXHRcdFx0fVxuXHRcdH0pLFxuXHQpO1xuXG5cdC8vIC0tIFNDTSBjb21tYW5kcyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cblx0Y29udGV4dC5zdWJzY3JpcHRpb25zLnB1c2goXG5cdFx0dnNjb2RlLmNvbW1hbmRzLnJlZ2lzdGVyQ29tbWFuZChcImdzZC5hY2NlcHRBbGxDaGFuZ2VzXCIsICgpID0+IHtcblx0XHRcdGNoYW5nZVRyYWNrZXI/LmFjY2VwdEFsbCgpO1xuXHRcdFx0dnNjb2RlLndpbmRvdy5zaG93SW5mb3JtYXRpb25NZXNzYWdlKFwiQWxsIGFnZW50IGNoYW5nZXMgYWNjZXB0ZWQuXCIpO1xuXHRcdH0pLFxuXHQpO1xuXG5cdGNvbnRleHQuc3Vic2NyaXB0aW9ucy5wdXNoKFxuXHRcdHZzY29kZS5jb21tYW5kcy5yZWdpc3RlckNvbW1hbmQoXCJnc2QuZGlzY2FyZEFsbENoYW5nZXNcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdFx0aWYgKCFjaGFuZ2VUcmFja2VyPy5oYXNDaGFuZ2VzKSB7XG5cdFx0XHRcdHZzY29kZS53aW5kb3cuc2hvd0luZm9ybWF0aW9uTWVzc2FnZShcIk5vIGFnZW50IGNoYW5nZXMgdG8gZGlzY2FyZC5cIik7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblx0XHRcdGNvbnN0IGNvbmZpcm0gPSBhd2FpdCB2c2NvZGUud2luZG93LnNob3dXYXJuaW5nTWVzc2FnZShcblx0XHRcdFx0YERpc2NhcmQgYWxsIGFnZW50IGNoYW5nZXMgKCR7Y2hhbmdlVHJhY2tlci5tb2RpZmllZEZpbGVzLmxlbmd0aH0gZmlsZXMpP2AsXG5cdFx0XHRcdHsgbW9kYWw6IHRydWUgfSxcblx0XHRcdFx0XCJEaXNjYXJkXCIsXG5cdFx0XHQpO1xuXHRcdFx0aWYgKGNvbmZpcm0gPT09IFwiRGlzY2FyZFwiKSB7XG5cdFx0XHRcdGNvbnN0IGNvdW50ID0gYXdhaXQgY2hhbmdlVHJhY2tlci5kaXNjYXJkQWxsKCk7XG5cdFx0XHRcdHZzY29kZS53aW5kb3cuc2hvd0luZm9ybWF0aW9uTWVzc2FnZShgUmV2ZXJ0ZWQgJHtjb3VudH0gZmlsZSR7Y291bnQgIT09IDEgPyBcInNcIiA6IFwiXCJ9LmApO1xuXHRcdFx0fVxuXHRcdH0pLFxuXHQpO1xuXG5cdGNvbnRleHQuc3Vic2NyaXB0aW9ucy5wdXNoKFxuXHRcdHZzY29kZS5jb21tYW5kcy5yZWdpc3RlckNvbW1hbmQoXCJnc2QuZGlzY2FyZEZpbGVDaGFuZ2VzXCIsIGFzeW5jIChyZXNvdXJjZVN0YXRlOiB2c2NvZGUuU291cmNlQ29udHJvbFJlc291cmNlU3RhdGUpID0+IHtcblx0XHRcdGlmICghY2hhbmdlVHJhY2tlciB8fCAhcmVzb3VyY2VTdGF0ZT8ucmVzb3VyY2VVcmkpIHJldHVybjtcblx0XHRcdGNvbnN0IGZpbGVQYXRoID0gcmVzb3VyY2VTdGF0ZS5yZXNvdXJjZVVyaS5mc1BhdGg7XG5cdFx0XHRjb25zdCBzdWNjZXNzID0gYXdhaXQgY2hhbmdlVHJhY2tlci5kaXNjYXJkRmlsZShmaWxlUGF0aCk7XG5cdFx0XHRpZiAoc3VjY2Vzcykge1xuXHRcdFx0XHR2c2NvZGUud2luZG93LnNob3dJbmZvcm1hdGlvbk1lc3NhZ2UoYFJldmVydGVkICR7dnNjb2RlLndvcmtzcGFjZS5hc1JlbGF0aXZlUGF0aChmaWxlUGF0aCl9YCk7XG5cdFx0XHR9XG5cdFx0fSksXG5cdCk7XG5cblx0Y29udGV4dC5zdWJzY3JpcHRpb25zLnB1c2goXG5cdFx0dnNjb2RlLmNvbW1hbmRzLnJlZ2lzdGVyQ29tbWFuZChcImdzZC5hY2NlcHRGaWxlQ2hhbmdlc1wiLCAocmVzb3VyY2VTdGF0ZTogdnNjb2RlLlNvdXJjZUNvbnRyb2xSZXNvdXJjZVN0YXRlKSA9PiB7XG5cdFx0XHRpZiAoIWNoYW5nZVRyYWNrZXIgfHwgIXJlc291cmNlU3RhdGU/LnJlc291cmNlVXJpKSByZXR1cm47XG5cdFx0XHRjaGFuZ2VUcmFja2VyLmFjY2VwdEZpbGUocmVzb3VyY2VTdGF0ZS5yZXNvdXJjZVVyaS5mc1BhdGgpO1xuXHRcdH0pLFxuXHQpO1xuXG5cdC8vIC0tIENoZWNrcG9pbnQgY29tbWFuZHMgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cblx0Y29udGV4dC5zdWJzY3JpcHRpb25zLnB1c2goXG5cdFx0dnNjb2RlLmNvbW1hbmRzLnJlZ2lzdGVyQ29tbWFuZChcImdzZC5yZXN0b3JlQ2hlY2twb2ludFwiLCBhc3luYyAoY2hlY2twb2ludElkOiBudW1iZXIpID0+IHtcblx0XHRcdGlmICghY2hhbmdlVHJhY2tlcikgcmV0dXJuO1xuXHRcdFx0Y29uc3QgY2hlY2twb2ludCA9IGNoYW5nZVRyYWNrZXIuY2hlY2twb2ludHMuZmluZCgoYykgPT4gYy5pZCA9PT0gY2hlY2twb2ludElkKTtcblx0XHRcdGlmICghY2hlY2twb2ludCkgcmV0dXJuO1xuXG5cdFx0XHRjb25zdCBjb25maXJtID0gYXdhaXQgdnNjb2RlLndpbmRvdy5zaG93V2FybmluZ01lc3NhZ2UoXG5cdFx0XHRcdGBSZXN0b3JlIHRvIFwiJHtjaGVja3BvaW50LmxhYmVsfVwiPyBUaGlzIHdpbGwgcmV2ZXJ0IGZpbGVzIHRvIHRoZWlyIHN0YXRlIGF0ICR7bmV3IERhdGUoY2hlY2twb2ludC50aW1lc3RhbXApLnRvTG9jYWxlVGltZVN0cmluZygpfS5gLFxuXHRcdFx0XHR7IG1vZGFsOiB0cnVlIH0sXG5cdFx0XHRcdFwiUmVzdG9yZVwiLFxuXHRcdFx0KTtcblx0XHRcdGlmIChjb25maXJtID09PSBcIlJlc3RvcmVcIikge1xuXHRcdFx0XHRjb25zdCBjb3VudCA9IGF3YWl0IGNoYW5nZVRyYWNrZXIucmVzdG9yZUNoZWNrcG9pbnQoY2hlY2twb2ludElkKTtcblx0XHRcdFx0dnNjb2RlLndpbmRvdy5zaG93SW5mb3JtYXRpb25NZXNzYWdlKGBSZXN0b3JlZCAke2NvdW50fSBmaWxlJHtjb3VudCAhPT0gMSA/IFwic1wiIDogXCJcIn0gdG8gY2hlY2twb2ludC5gKTtcblx0XHRcdH1cblx0XHR9KSxcblx0KTtcblxuXHQvLyAtLSBEaWFnbm9zdGljIGNvbW1hbmRzIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5cdGNvbnRleHQuc3Vic2NyaXB0aW9ucy5wdXNoKFxuXHRcdHZzY29kZS5jb21tYW5kcy5yZWdpc3RlckNvbW1hbmQoXCJnc2QuZml4UHJvYmxlbXNJbkZpbGVcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdFx0aWYgKCFyZXF1aXJlQ29ubmVjdGVkKCkpIHJldHVybjtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGF3YWl0IGRpYWdub3N0aWNCcmlkZ2UhLmZpeFByb2JsZW1zSW5GaWxlKCk7XG5cdFx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdFx0aGFuZGxlRXJyb3IoZXJyLCBcIkZhaWxlZCB0byBmaXggcHJvYmxlbXNcIik7XG5cdFx0XHR9XG5cdFx0fSksXG5cdCk7XG5cblx0Y29udGV4dC5zdWJzY3JpcHRpb25zLnB1c2goXG5cdFx0dnNjb2RlLmNvbW1hbmRzLnJlZ2lzdGVyQ29tbWFuZChcImdzZC5maXhBbGxQcm9ibGVtc1wiLCBhc3luYyAoKSA9PiB7XG5cdFx0XHRpZiAoIXJlcXVpcmVDb25uZWN0ZWQoKSkgcmV0dXJuO1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0YXdhaXQgZGlhZ25vc3RpY0JyaWRnZSEuZml4QWxsUHJvYmxlbXMoKTtcblx0XHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0XHRoYW5kbGVFcnJvcihlcnIsIFwiRmFpbGVkIHRvIGZpeCBwcm9ibGVtc1wiKTtcblx0XHRcdH1cblx0XHR9KSxcblx0KTtcblxuXHRjb250ZXh0LnN1YnNjcmlwdGlvbnMucHVzaChcblx0XHR2c2NvZGUuY29tbWFuZHMucmVnaXN0ZXJDb21tYW5kKFwiZ3NkLmNsZWFyRGlhZ25vc3RpY3NcIiwgKCkgPT4ge1xuXHRcdFx0ZGlhZ25vc3RpY0JyaWRnZT8uY2xlYXJGaW5kaW5ncygpO1xuXHRcdH0pLFxuXHQpO1xuXG5cdGNvbnRleHQuc3Vic2NyaXB0aW9ucy5wdXNoKFxuXHRcdHZzY29kZS5jb21tYW5kcy5yZWdpc3RlckNvbW1hbmQoXCJnc2QuY2xlYXJQbGFuXCIsICgpID0+IHtcblx0XHRcdHBsYW5WaWV3ZXJQcm92aWRlcj8uY2xlYXIoKTtcblx0XHR9KSxcblx0KTtcblxuXHQvLyAtLSBQZXJtaXNzaW9uIGNvbW1hbmRzIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5cdGNvbnRleHQuc3Vic2NyaXB0aW9ucy5wdXNoKFxuXHRcdHZzY29kZS5jb21tYW5kcy5yZWdpc3RlckNvbW1hbmQoXCJnc2QuY3ljbGVBcHByb3ZhbE1vZGVcIiwgKCkgPT4ge1xuXHRcdFx0cGVybWlzc2lvbk1hbmFnZXI/LmN5Y2xlTW9kZSgpO1xuXHRcdH0pLFxuXHQpO1xuXG5cdGNvbnRleHQuc3Vic2NyaXB0aW9ucy5wdXNoKFxuXHRcdHZzY29kZS5jb21tYW5kcy5yZWdpc3RlckNvbW1hbmQoXCJnc2Quc2VsZWN0QXBwcm92YWxNb2RlXCIsICgpID0+IHtcblx0XHRcdHBlcm1pc3Npb25NYW5hZ2VyPy5zZWxlY3RNb2RlKCk7XG5cdFx0fSksXG5cdCk7XG5cblx0Ly8gLS0gR2l0IGNvbW1hbmRzIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuXHRjb250ZXh0LnN1YnNjcmlwdGlvbnMucHVzaChcblx0XHR2c2NvZGUuY29tbWFuZHMucmVnaXN0ZXJDb21tYW5kKFwiZ3NkLmNvbW1pdEFnZW50Q2hhbmdlc1wiLCAoKSA9PiB7XG5cdFx0XHRnaXRJbnRlZ3JhdGlvbj8uY29tbWl0QWdlbnRDaGFuZ2VzKCk7XG5cdFx0fSksXG5cdCk7XG5cblx0Y29udGV4dC5zdWJzY3JpcHRpb25zLnB1c2goXG5cdFx0dnNjb2RlLmNvbW1hbmRzLnJlZ2lzdGVyQ29tbWFuZChcImdzZC5jcmVhdGVBZ2VudEJyYW5jaFwiLCAoKSA9PiB7XG5cdFx0XHRnaXRJbnRlZ3JhdGlvbj8uY3JlYXRlQWdlbnRCcmFuY2goKTtcblx0XHR9KSxcblx0KTtcblxuXHRjb250ZXh0LnN1YnNjcmlwdGlvbnMucHVzaChcblx0XHR2c2NvZGUuY29tbWFuZHMucmVnaXN0ZXJDb21tYW5kKFwiZ3NkLnNob3dBZ2VudERpZmZcIiwgKCkgPT4ge1xuXHRcdFx0Z2l0SW50ZWdyYXRpb24/LnNob3dBZ2VudERpZmYoKTtcblx0XHR9KSxcblx0KTtcblxuXHQvLyAtLSBBdXRvLXN0YXJ0IC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5cdGlmIChzdGFydHVwQ29uZmlnLmF1dG9TdGFydCkge1xuXHRcdHZzY29kZS5jb21tYW5kcy5leGVjdXRlQ29tbWFuZChcImdzZC5zdGFydFwiKTtcblx0fVxufVxuXG5leHBvcnQgZnVuY3Rpb24gZGVhY3RpdmF0ZSgpOiB2b2lkIHtcblx0Y2xpZW50Py5kaXNwb3NlKCk7XG5cdHNpZGViYXJQcm92aWRlcj8uZGlzcG9zZSgpO1xuXHRmaWxlRGVjb3JhdGlvbnM/LmRpc3Bvc2UoKTtcblx0c2Vzc2lvblRyZWVQcm92aWRlcj8uZGlzcG9zZSgpO1xuXHRhY3Rpdml0eUZlZWRQcm92aWRlcj8uZGlzcG9zZSgpO1xuXHRjaGVja3BvaW50UHJvdmlkZXI/LmRpc3Bvc2UoKTtcblx0Y2hhbmdlVHJhY2tlcj8uZGlzcG9zZSgpO1xuXHRzY21Qcm92aWRlcj8uZGlzcG9zZSgpO1xuXHRkaWFnbm9zdGljQnJpZGdlPy5kaXNwb3NlKCk7XG5cdGxpbmVEZWNvcmF0aW9ucz8uZGlzcG9zZSgpO1xuXHRnaXRJbnRlZ3JhdGlvbj8uZGlzcG9zZSgpO1xuXHRwZXJtaXNzaW9uTWFuYWdlcj8uZGlzcG9zZSgpO1xuXHRjbGllbnQgPSB1bmRlZmluZWQ7XG5cdHNpZGViYXJQcm92aWRlciA9IHVuZGVmaW5lZDtcblx0ZmlsZURlY29yYXRpb25zID0gdW5kZWZpbmVkO1xuXHRzZXNzaW9uVHJlZVByb3ZpZGVyID0gdW5kZWZpbmVkO1xuXHRhY3Rpdml0eUZlZWRQcm92aWRlciA9IHVuZGVmaW5lZDtcblx0Y2hlY2twb2ludFByb3ZpZGVyID0gdW5kZWZpbmVkO1xuXHRjaGFuZ2VUcmFja2VyID0gdW5kZWZpbmVkO1xuXHRzY21Qcm92aWRlciA9IHVuZGVmaW5lZDtcblx0ZGlhZ25vc3RpY0JyaWRnZSA9IHVuZGVmaW5lZDtcblx0bGluZURlY29yYXRpb25zID0gdW5kZWZpbmVkO1xuXHRnaXRJbnRlZ3JhdGlvbiA9IHVu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
