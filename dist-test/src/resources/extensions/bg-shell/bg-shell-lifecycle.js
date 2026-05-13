import {
  truncateToWidth,
  visibleWidth
} from "@gsd/pi-tui";
import {
  processes,
  pendingAlerts,
  pushAlert,
  cleanupAll,
  cleanupSessionProcesses,
  persistManifest,
  loadManifest,
  pruneDeadProcesses
} from "./process-manager.js";
import { formatUptime, getBgShellLiveCwd, resolveBgShellPersistenceCwd } from "./utilities.js";
import { formatTokenCount } from "../shared/format-utils.js";
import { homedir } from "node:os";
function registerBgShellLifecycle(pi, state) {
  function syncLatestCtxCwd() {
    if (!state.latestCtx) return;
    const syncedCwd = resolveBgShellPersistenceCwd(state.latestCtx.cwd);
    if (syncedCwd !== state.latestCtx.cwd) {
      state.latestCtx = { ...state.latestCtx, cwd: syncedCwd };
    }
  }
  const signalCleanup = () => {
    cleanupAll();
    try {
      const { listDescendants } = require("@gsd/native");
      const descendants = listDescendants(process.pid);
      for (const childPid of descendants) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
        }
      }
    } catch {
    }
  };
  process.on("SIGTERM", signalCleanup);
  process.on("SIGINT", signalCleanup);
  process.on("beforeExit", signalCleanup);
  pi.on("session_shutdown", async () => {
    process.off("SIGTERM", signalCleanup);
    process.off("SIGINT", signalCleanup);
    process.off("beforeExit", signalCleanup);
    cleanupAll();
  });
  function buildProcessStateAlert(reason) {
    const alive = Array.from(processes.values()).filter((p) => p.alive);
    if (alive.length === 0) return;
    const processSummaries = alive.map((p) => {
      const portInfo = p.ports.length > 0 ? ` :${p.ports.join(",")}` : "";
      const urlInfo = p.urls.length > 0 ? ` ${p.urls[0]}` : "";
      const errInfo = p.recentErrors.length > 0 ? ` (${p.recentErrors.length} errors)` : "";
      const groupInfo = p.group ? ` [${p.group}]` : "";
      return `  - id:${p.id} "${p.label}" [${p.processType}] status:${p.status} uptime:${formatUptime(Date.now() - p.startedAt)}${portInfo}${urlInfo}${errInfo}${groupInfo}`;
    }).join("\n");
    pushAlert(
      null,
      `${reason} ${alive.length} background process(es) are still running:
${processSummaries}
Use bg_shell digest/output/kill with these IDs.`
    );
  }
  pi.on("session_compact", async () => {
    buildProcessStateAlert("Context was compacted.");
  });
  pi.on("session_tree", async () => {
    buildProcessStateAlert("Session tree was navigated.");
  });
  pi.on("session_switch", async (event, ctx) => {
    state.latestCtx = ctx;
    if (event.reason === "new" && event.previousSessionFile) {
      await cleanupSessionProcesses(event.previousSessionFile);
      syncLatestCtxCwd();
      if (state.latestCtx) persistManifest(state.latestCtx.cwd);
    }
    buildProcessStateAlert("Session was switched.");
  });
  pi.on("before_agent_start", async (_event, _ctx) => {
    const alerts = pendingAlerts.splice(0);
    const alive = Array.from(processes.values()).filter((p) => p.alive);
    if (alerts.length === 0 && alive.length === 0) return;
    const parts = [];
    if (alerts.length > 0) {
      parts.push(`Background process alerts:
${alerts.map((a) => `  ${a}`).join("\n")}`);
    }
    if (alive.length > 0) {
      const summary = alive.map((p) => {
        const status = p.status === "ready" ? "\u2713" : p.status === "error" ? "\u2717" : p.status === "starting" ? "\u22EF" : "?";
        const portInfo = p.ports.length > 0 ? ` :${p.ports.join(",")}` : "";
        const errInfo = p.recentErrors.length > 0 ? ` (${p.recentErrors.length} errors)` : "";
        return `  ${status} ${p.id} ${p.label}${portInfo}${errInfo}`;
      }).join("\n");
      parts.push(`Background processes:
${summary}`);
    }
    return {
      message: {
        customType: "bg-shell-status",
        content: parts.join("\n\n"),
        display: false
      }
    };
  });
  pi.on("session_start", async (_event, ctx) => {
    state.latestCtx = ctx;
    const manifest = loadManifest(ctx.cwd);
    if (manifest.length > 0) {
      const surviving = [];
      for (const entry of manifest) {
        if (entry.pid) {
          try {
            process.kill(entry.pid, 0);
            surviving.push(entry);
          } catch {
          }
        }
      }
      if (surviving.length > 0) {
        const summary = surviving.map(
          (s) => `  - ${s.id}: ${s.label} (pid ${s.pid}, type: ${s.processType}${s.group ? `, group: ${s.group}` : ""})`
        ).join("\n");
        pushAlert(
          null,
          `${surviving.length} background process(es) from previous session still running:
${summary}
  Note: These processes are outside bg_shell's control. Kill them manually if needed.`
        );
      }
    }
  });
  let footerActive = false;
  function buildBgStatusText(th) {
    const alive = Array.from(processes.values()).filter((p) => p.alive);
    if (alive.length === 0) return "";
    const sep = th.fg("dim", " \xB7 ");
    const items = [];
    for (const p of alive) {
      const statusIcon = p.status === "ready" ? th.fg("success", "\u25CF") : p.status === "error" ? th.fg("error", "\u25CF") : th.fg("warning", "\u25CF");
      const name = p.label.length > 14 ? p.label.slice(0, 12) + "\u2026" : p.label;
      const portInfo = p.ports.length > 0 ? th.fg("dim", `:${p.ports[0]}`) : "";
      const errBadge = p.recentErrors.length > 0 ? th.fg("error", ` err:${p.recentErrors.length}`) : "";
      items.push(`${statusIcon} ${th.fg("muted", name)}${portInfo}${errBadge}`);
    }
    return items.join(sep);
  }
  let footerTui = null;
  function refreshWidget() {
    if (!state.latestCtx?.hasUI) return;
    const alive = Array.from(processes.values()).filter((p) => p.alive);
    if (alive.length === 0) {
      if (footerActive) {
        state.latestCtx.ui.setFooter(void 0);
        footerActive = false;
        footerTui = null;
      }
      return;
    }
    if (footerActive) {
      footerTui?.requestRender();
      return;
    }
    footerActive = true;
    state.latestCtx.ui.setFooter((tui, th, footerData) => {
      footerTui = tui;
      const branchUnsub = footerData.onBranchChange(() => tui.requestRender());
      return {
        render(width) {
          let pwd = getBgShellLiveCwd(state.latestCtx?.cwd);
          const home = homedir();
          if (pwd.startsWith(home)) {
            pwd = `~${pwd.slice(home.length)}`;
          }
          const branch = footerData.getGitBranch();
          if (branch) pwd = `${pwd} (${branch})`;
          const sessionName = state.latestCtx?.sessionManager?.getSessionName?.();
          if (sessionName) pwd = `${pwd} \u2022 ${sessionName}`;
          const bgStatus = buildBgStatusText(th);
          const leftPwd = th.fg("dim", pwd);
          const leftWidth = visibleWidth(leftPwd);
          const rightWidth = visibleWidth(bgStatus);
          let pwdLine;
          const minGap = 2;
          if (bgStatus && leftWidth + minGap + rightWidth <= width) {
            const pad = " ".repeat(width - leftWidth - rightWidth);
            pwdLine = leftPwd + pad + bgStatus;
          } else if (bgStatus) {
            const availForPwd = width - rightWidth - minGap;
            if (availForPwd > 10) {
              const truncPwd = truncateToWidth(leftPwd, availForPwd, th.fg("dim", "\u2026"));
              const truncWidth = visibleWidth(truncPwd);
              const pad = " ".repeat(Math.max(0, width - truncWidth - rightWidth));
              pwdLine = truncPwd + pad + bgStatus;
            } else {
              pwdLine = truncateToWidth(leftPwd, width, th.fg("dim", "\u2026"));
            }
          } else {
            pwdLine = truncateToWidth(leftPwd, width, th.fg("dim", "\u2026"));
          }
          const ctx = state.latestCtx;
          const sm = ctx?.sessionManager;
          let totalInput = 0, totalOutput = 0;
          let totalCacheRead = 0, totalCacheWrite = 0, totalCost = 0;
          if (sm) {
            for (const entry of sm.getEntries()) {
              if (entry.type === "message" && entry.message?.role === "assistant") {
                const u = entry.message.usage;
                if (u) {
                  totalInput += u.input || 0;
                  totalOutput += u.output || 0;
                  totalCacheRead += u.cacheRead || 0;
                  totalCacheWrite += u.cacheWrite || 0;
                  totalCost += u.cost?.total || 0;
                }
              }
            }
          }
          const contextUsage = ctx?.getContextUsage?.();
          const contextWindow = contextUsage?.contextWindow ?? ctx?.model?.contextWindow ?? 0;
          const contextPercentValue = contextUsage?.percent ?? 0;
          const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";
          const statsParts = [];
          if (totalInput) statsParts.push(`\u2191${formatTokenCount(totalInput)}`);
          if (totalOutput) statsParts.push(`\u2193${formatTokenCount(totalOutput)}`);
          if (totalCacheRead) statsParts.push(`R${formatTokenCount(totalCacheRead)}`);
          if (totalCacheWrite) statsParts.push(`W${formatTokenCount(totalCacheWrite)}`);
          if (totalCost) statsParts.push(`$${totalCost.toFixed(3)}`);
          const contextDisplay = contextPercent === "?" ? `?/${formatTokenCount(contextWindow)}` : `${contextPercent}%/${formatTokenCount(contextWindow)}`;
          let contextStr;
          if (contextPercentValue > 90) {
            contextStr = th.fg("error", contextDisplay);
          } else if (contextPercentValue > 70) {
            contextStr = th.fg("warning", contextDisplay);
          } else {
            contextStr = contextDisplay;
          }
          statsParts.push(contextStr);
          let statsLeft = statsParts.join(" ");
          let statsLeftWidth = visibleWidth(statsLeft);
          if (statsLeftWidth > width) {
            statsLeft = truncateToWidth(statsLeft, width, "...");
            statsLeftWidth = visibleWidth(statsLeft);
          }
          const modelName = ctx?.model?.id || "no-model";
          let rightSide = modelName;
          if (ctx?.model?.reasoning) {
            const thinkingLevel = ctx.getThinkingLevel?.() || "off";
            rightSide = thinkingLevel === "off" ? `${modelName} \u2022 thinking off` : `${modelName} \u2022 ${thinkingLevel}`;
          }
          if (footerData.getAvailableProviderCount() > 1 && ctx?.model) {
            const withProvider = `(${ctx.model.provider}) ${rightSide}`;
            if (statsLeftWidth + 2 + visibleWidth(withProvider) <= width) {
              rightSide = withProvider;
            }
          }
          const rightSideWidth = visibleWidth(rightSide);
          let statsLine;
          if (statsLeftWidth + 2 + rightSideWidth <= width) {
            const pad = " ".repeat(width - statsLeftWidth - rightSideWidth);
            statsLine = statsLeft + pad + rightSide;
          } else {
            const avail = width - statsLeftWidth - 2;
            if (avail > 0) {
              const truncRight = truncateToWidth(rightSide, avail, "");
              const truncRightWidth = visibleWidth(truncRight);
              const pad = " ".repeat(Math.max(0, width - statsLeftWidth - truncRightWidth));
              statsLine = statsLeft + pad + truncRight;
            } else {
              statsLine = statsLeft;
            }
          }
          const dimStatsLeft = th.fg("dim", statsLeft);
          const remainder = statsLine.slice(statsLeft.length);
          const dimRemainder = th.fg("dim", remainder);
          const lines = [pwdLine, dimStatsLeft + dimRemainder];
          const extensionStatuses = footerData.getExtensionStatuses();
          const otherStatuses = Array.from(extensionStatuses.entries()).filter(([key]) => key !== "bg-shell").sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim());
          if (otherStatuses.length > 0) {
            lines.push(truncateToWidth(otherStatuses.join(" "), width, th.fg("dim", "...")));
          }
          return lines;
        },
        invalidate() {
        },
        dispose() {
          branchUnsub();
          footerTui = null;
        }
      };
    });
  }
  state.refreshWidget = refreshWidget;
  const maintenanceInterval = setInterval(() => {
    pruneDeadProcesses();
    refreshWidget();
    if (state.latestCtx) {
      syncLatestCtxCwd();
      persistManifest(state.latestCtx.cwd);
    }
  }, 2e3);
  const refreshHandler = async (_event, ctx) => {
    state.latestCtx = ctx;
    refreshWidget();
  };
  pi.on("turn_end", refreshHandler);
  pi.on("agent_end", refreshHandler);
  pi.on("session_start", refreshHandler);
  pi.on("session_switch", refreshHandler);
  pi.on("tool_execution_end", async (_event, ctx) => {
    state.latestCtx = ctx;
    refreshWidget();
  });
  pi.on("session_shutdown", async () => {
    clearInterval(maintenanceInterval);
    if (state.latestCtx) {
      syncLatestCtxCwd();
      persistManifest(state.latestCtx.cwd);
    }
    cleanupAll();
  });
}
export {
  registerBgShellLifecycle
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2JnLXNoZWxsL2JnLXNoZWxsLWxpZmVjeWNsZS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBiZ19zaGVsbCBsaWZlY3ljbGUgaG9vayByZWdpc3RyYXRpb24gXHUyMDE0IHNlc3Npb24gZXZlbnRzLCBjb21wYWN0aW9uIGF3YXJlbmVzcyxcbiAqIGNvbnRleHQgaW5qZWN0aW9uLCBwcm9jZXNzIGRpc2NvdmVyeSwgZm9vdGVyIHdpZGdldCwgYW5kIHBlcmlvZGljIG1haW50ZW5hbmNlLlxuICovXG5cbmltcG9ydCB0eXBlIHtcblx0RXh0ZW5zaW9uQVBJLFxuXHRFeHRlbnNpb25Db250ZXh0LFxuXHRUaGVtZSxcbn0gZnJvbSBcIkBnc2QvcGktY29kaW5nLWFnZW50XCI7XG5pbXBvcnQge1xuXHR0cnVuY2F0ZVRvV2lkdGgsXG5cdHZpc2libGVXaWR0aCxcbn0gZnJvbSBcIkBnc2QvcGktdHVpXCI7XG5cbmltcG9ydCB7XG5cdHByb2Nlc3Nlcyxcblx0cGVuZGluZ0FsZXJ0cyxcblx0cHVzaEFsZXJ0LFxuXHRjbGVhbnVwQWxsLFxuXHRjbGVhbnVwU2Vzc2lvblByb2Nlc3Nlcyxcblx0cGVyc2lzdE1hbmlmZXN0LFxuXHRsb2FkTWFuaWZlc3QsXG5cdHBydW5lRGVhZFByb2Nlc3Nlcyxcbn0gZnJvbSBcIi4vcHJvY2Vzcy1tYW5hZ2VyLmpzXCI7XG5pbXBvcnQgeyBmb3JtYXRVcHRpbWUsIGdldEJnU2hlbGxMaXZlQ3dkLCByZXNvbHZlQmdTaGVsbFBlcnNpc3RlbmNlQ3dkIH0gZnJvbSBcIi4vdXRpbGl0aWVzLmpzXCI7XG5pbXBvcnQgeyBmb3JtYXRUb2tlbkNvdW50IH0gZnJvbSBcIi4uL3NoYXJlZC9mb3JtYXQtdXRpbHMuanNcIjtcblxuaW1wb3J0IHR5cGUgeyBCZ1NoZWxsU2hhcmVkU3RhdGUgfSBmcm9tIFwiLi9pbmRleC5qc1wiO1xuaW1wb3J0IHsgaG9tZWRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5cbmV4cG9ydCBmdW5jdGlvbiByZWdpc3RlckJnU2hlbGxMaWZlY3ljbGUocGk6IEV4dGVuc2lvbkFQSSwgc3RhdGU6IEJnU2hlbGxTaGFyZWRTdGF0ZSk6IHZvaWQge1xuXG5cdGZ1bmN0aW9uIHN5bmNMYXRlc3RDdHhDd2QoKTogdm9pZCB7XG5cdFx0aWYgKCFzdGF0ZS5sYXRlc3RDdHgpIHJldHVybjtcblx0XHRjb25zdCBzeW5jZWRDd2QgPSByZXNvbHZlQmdTaGVsbFBlcnNpc3RlbmNlQ3dkKHN0YXRlLmxhdGVzdEN0eC5jd2QpO1xuXHRcdGlmIChzeW5jZWRDd2QgIT09IHN0YXRlLmxhdGVzdEN0eC5jd2QpIHtcblx0XHRcdHN0YXRlLmxhdGVzdEN0eCA9IHsgLi4uc3RhdGUubGF0ZXN0Q3R4LCBjd2Q6IHN5bmNlZEN3ZCB9O1xuXHRcdH1cblx0fVxuXG5cdC8vIFJlZ2lzdGVyIHNpZ25hbCBoYW5kbGVycyB0byBjbGVhbiB1cCBiZyBwcm9jZXNzZXMgb24gdW5leHBlY3RlZCBleGl0IChmaXhlcyAjNDI4KVxuXHRjb25zdCBzaWduYWxDbGVhbnVwID0gKCkgPT4ge1xuXHRcdGNsZWFudXBBbGwoKTtcblx0XHQvLyBBbHNvIGtpbGwgYmFzaC10b29sIHNwYXduZWQgY2hpbGRyZW4gdGhhdCBiZy1zaGVsbCBkb2Vzbid0IHRyYWNrXG5cdFx0dHJ5IHtcblx0XHRcdGNvbnN0IHsgbGlzdERlc2NlbmRhbnRzIH0gPSByZXF1aXJlKFwiQGdzZC9uYXRpdmVcIikgYXMgdHlwZW9mIGltcG9ydChcIkBnc2QvbmF0aXZlXCIpO1xuXHRcdFx0Y29uc3QgZGVzY2VuZGFudHMgPSBsaXN0RGVzY2VuZGFudHMocHJvY2Vzcy5waWQpO1xuXHRcdFx0Zm9yIChjb25zdCBjaGlsZFBpZCBvZiBkZXNjZW5kYW50cykge1xuXHRcdFx0XHR0cnkgeyBwcm9jZXNzLmtpbGwoY2hpbGRQaWQsIFwiU0lHS0lMTFwiKTsgfSBjYXRjaCB7fVxuXHRcdFx0fVxuXHRcdH0gY2F0Y2gge31cblx0fTtcblx0cHJvY2Vzcy5vbihcIlNJR1RFUk1cIiwgc2lnbmFsQ2xlYW51cCk7XG5cdHByb2Nlc3Mub24oXCJTSUdJTlRcIiwgc2lnbmFsQ2xlYW51cCk7XG5cdHByb2Nlc3Mub24oXCJiZWZvcmVFeGl0XCIsIHNpZ25hbENsZWFudXApO1xuXG5cdC8vIENsZWFuIHVwIG9uIHNlc3Npb24gc2h1dGRvd24gXHUyMDE0IHJlbW92ZSBzaWduYWwgaGFuZGxlcnMgdG8gcHJldmVudCBhY2N1bXVsYXRpb25cblx0cGkub24oXCJzZXNzaW9uX3NodXRkb3duXCIsIGFzeW5jICgpID0+IHtcblx0XHRwcm9jZXNzLm9mZihcIlNJR1RFUk1cIiwgc2lnbmFsQ2xlYW51cCk7XG5cdFx0cHJvY2Vzcy5vZmYoXCJTSUdJTlRcIiwgc2lnbmFsQ2xlYW51cCk7XG5cdFx0cHJvY2Vzcy5vZmYoXCJiZWZvcmVFeGl0XCIsIHNpZ25hbENsZWFudXApO1xuXHRcdGNsZWFudXBBbGwoKTtcblx0fSk7XG5cblx0Ly8gXHUyNTAwXHUyNTAwIENvbXBhY3Rpb24gQXdhcmVuZXNzOiBTdXJ2aXZlIENvbnRleHQgUmVzZXRzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5cdC8qKiBCdWlsZCBhIGNvbXBhY3Qgc3RhdGUgc3VtbWFyeSBvZiBhbGwgYWxpdmUgcHJvY2Vzc2VzIGZvciBjb250ZXh0IHJlLWluamVjdGlvbiAqL1xuXHRmdW5jdGlvbiBidWlsZFByb2Nlc3NTdGF0ZUFsZXJ0KHJlYXNvbjogc3RyaW5nKTogdm9pZCB7XG5cdFx0Y29uc3QgYWxpdmUgPSBBcnJheS5mcm9tKHByb2Nlc3Nlcy52YWx1ZXMoKSkuZmlsdGVyKHAgPT4gcC5hbGl2ZSk7XG5cdFx0aWYgKGFsaXZlLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuXG5cdFx0Y29uc3QgcHJvY2Vzc1N1bW1hcmllcyA9IGFsaXZlLm1hcChwID0+IHtcblx0XHRcdGNvbnN0IHBvcnRJbmZvID0gcC5wb3J0cy5sZW5ndGggPiAwID8gYCA6JHtwLnBvcnRzLmpvaW4oXCIsXCIpfWAgOiBcIlwiO1xuXHRcdFx0Y29uc3QgdXJsSW5mbyA9IHAudXJscy5sZW5ndGggPiAwID8gYCAke3AudXJsc1swXX1gIDogXCJcIjtcblx0XHRcdGNvbnN0IGVyckluZm8gPSBwLnJlY2VudEVycm9ycy5sZW5ndGggPiAwID8gYCAoJHtwLnJlY2VudEVycm9ycy5sZW5ndGh9IGVycm9ycylgIDogXCJcIjtcblx0XHRcdGNvbnN0IGdyb3VwSW5mbyA9IHAuZ3JvdXAgPyBgIFske3AuZ3JvdXB9XWAgOiBcIlwiO1xuXHRcdFx0cmV0dXJuIGAgIC0gaWQ6JHtwLmlkfSBcIiR7cC5sYWJlbH1cIiBbJHtwLnByb2Nlc3NUeXBlfV0gc3RhdHVzOiR7cC5zdGF0dXN9IHVwdGltZToke2Zvcm1hdFVwdGltZShEYXRlLm5vdygpIC0gcC5zdGFydGVkQXQpfSR7cG9ydEluZm99JHt1cmxJbmZvfSR7ZXJySW5mb30ke2dyb3VwSW5mb31gO1xuXHRcdH0pLmpvaW4oXCJcXG5cIik7XG5cblx0XHRwdXNoQWxlcnQobnVsbCxcblx0XHRcdGAke3JlYXNvbn0gJHthbGl2ZS5sZW5ndGh9IGJhY2tncm91bmQgcHJvY2VzcyhlcykgYXJlIHN0aWxsIHJ1bm5pbmc6XFxuJHtwcm9jZXNzU3VtbWFyaWVzfVxcblVzZSBiZ19zaGVsbCBkaWdlc3Qvb3V0cHV0L2tpbGwgd2l0aCB0aGVzZSBJRHMuYFxuXHRcdCk7XG5cdH1cblxuXHQvLyBBZnRlciBjb21wYWN0aW9uLCB0aGUgTExNIGxvc2VzIGFsbCBtZW1vcnkgb2YgcnVubmluZyBwcm9jZXNzZXMuXG5cdC8vIFF1ZXVlIGEgZGV0YWlsZWQgYWxlcnQgc28gdGhlIG5leHQgYmVmb3JlX2FnZW50X3N0YXJ0IGluamVjdHMgZnVsbCBzdGF0ZS5cblx0cGkub24oXCJzZXNzaW9uX2NvbXBhY3RcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGJ1aWxkUHJvY2Vzc1N0YXRlQWxlcnQoXCJDb250ZXh0IHdhcyBjb21wYWN0ZWQuXCIpO1xuXHR9KTtcblxuXHQvLyBUcmVlIG5hdmlnYXRpb24gYWxzbyByZXNldHMgdGhlIGFnZW50J3MgY29udGV4dC5cblx0cGkub24oXCJzZXNzaW9uX3RyZWVcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGJ1aWxkUHJvY2Vzc1N0YXRlQWxlcnQoXCJTZXNzaW9uIHRyZWUgd2FzIG5hdmlnYXRlZC5cIik7XG5cdH0pO1xuXG5cdC8vIFNlc3Npb24gc3dpdGNoIHJlc2V0cyB0aGUgYWdlbnQncyBjb250ZXh0LlxuXHRwaS5vbihcInNlc3Npb25fc3dpdGNoXCIsIGFzeW5jIChldmVudCwgY3R4KSA9PiB7XG5cdFx0c3RhdGUubGF0ZXN0Q3R4ID0gY3R4O1xuXHRcdGlmIChldmVudC5yZWFzb24gPT09IFwibmV3XCIgJiYgZXZlbnQucHJldmlvdXNTZXNzaW9uRmlsZSkge1xuXHRcdFx0YXdhaXQgY2xlYW51cFNlc3Npb25Qcm9jZXNzZXMoZXZlbnQucHJldmlvdXNTZXNzaW9uRmlsZSk7XG5cdFx0XHRzeW5jTGF0ZXN0Q3R4Q3dkKCk7XG5cdFx0XHRpZiAoc3RhdGUubGF0ZXN0Q3R4KSBwZXJzaXN0TWFuaWZlc3Qoc3RhdGUubGF0ZXN0Q3R4LmN3ZCk7XG5cdFx0fVxuXHRcdGJ1aWxkUHJvY2Vzc1N0YXRlQWxlcnQoXCJTZXNzaW9uIHdhcyBzd2l0Y2hlZC5cIik7XG5cdH0pO1xuXG5cdC8vIFx1MjUwMFx1MjUwMCBDb250ZXh0IEluamVjdGlvbjogUHJvYWN0aXZlIEFsZXJ0cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuXHRwaS5vbihcImJlZm9yZV9hZ2VudF9zdGFydFwiLCBhc3luYyAoX2V2ZW50LCBfY3R4KSA9PiB7XG5cdFx0Ly8gSW5qZWN0IHByb2Nlc3Mgc3RhdHVzIG92ZXJ2aWV3IGFuZCBhbnkgcGVuZGluZyBhbGVydHNcblx0XHRjb25zdCBhbGVydHMgPSBwZW5kaW5nQWxlcnRzLnNwbGljZSgwKTtcblx0XHRjb25zdCBhbGl2ZSA9IEFycmF5LmZyb20ocHJvY2Vzc2VzLnZhbHVlcygpKS5maWx0ZXIocCA9PiBwLmFsaXZlKTtcblxuXHRcdGlmIChhbGVydHMubGVuZ3RoID09PSAwICYmIGFsaXZlLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuXG5cdFx0Y29uc3QgcGFydHM6IHN0cmluZ1tdID0gW107XG5cblx0XHRpZiAoYWxlcnRzLmxlbmd0aCA+IDApIHtcblx0XHRcdHBhcnRzLnB1c2goYEJhY2tncm91bmQgcHJvY2VzcyBhbGVydHM6XFxuJHthbGVydHMubWFwKGEgPT4gYCAgJHthfWApLmpvaW4oXCJcXG5cIil9YCk7XG5cdFx0fVxuXG5cdFx0aWYgKGFsaXZlLmxlbmd0aCA+IDApIHtcblx0XHRcdGNvbnN0IHN1bW1hcnkgPSBhbGl2ZS5tYXAocCA9PiB7XG5cdFx0XHRcdGNvbnN0IHN0YXR1cyA9IHAuc3RhdHVzID09PSBcInJlYWR5XCIgPyBcIlx1MjcxM1wiIDogcC5zdGF0dXMgPT09IFwiZXJyb3JcIiA/IFwiXHUyNzE3XCIgOiBwLnN0YXR1cyA9PT0gXCJzdGFydGluZ1wiID8gXCJcdTIyRUZcIiA6IFwiP1wiO1xuXHRcdFx0XHRjb25zdCBwb3J0SW5mbyA9IHAucG9ydHMubGVuZ3RoID4gMCA/IGAgOiR7cC5wb3J0cy5qb2luKFwiLFwiKX1gIDogXCJcIjtcblx0XHRcdFx0Y29uc3QgZXJySW5mbyA9IHAucmVjZW50RXJyb3JzLmxlbmd0aCA+IDAgPyBgICgke3AucmVjZW50RXJyb3JzLmxlbmd0aH0gZXJyb3JzKWAgOiBcIlwiO1xuXHRcdFx0XHRyZXR1cm4gYCAgJHtzdGF0dXN9ICR7cC5pZH0gJHtwLmxhYmVsfSR7cG9ydEluZm99JHtlcnJJbmZvfWA7XG5cdFx0XHR9KS5qb2luKFwiXFxuXCIpO1xuXHRcdFx0cGFydHMucHVzaChgQmFja2dyb3VuZCBwcm9jZXNzZXM6XFxuJHtzdW1tYXJ5fWApO1xuXHRcdH1cblxuXHRcdHJldHVybiB7XG5cdFx0XHRtZXNzYWdlOiB7XG5cdFx0XHRcdGN1c3RvbVR5cGU6IFwiYmctc2hlbGwtc3RhdHVzXCIsXG5cdFx0XHRcdGNvbnRlbnQ6IHBhcnRzLmpvaW4oXCJcXG5cXG5cIiksXG5cdFx0XHRcdGRpc3BsYXk6IGZhbHNlLFxuXHRcdFx0fSxcblx0XHR9O1xuXHR9KTtcblxuXHQvLyBcdTI1MDBcdTI1MDAgU2Vzc2lvbiBTdGFydDogRGlzY292ZXIgU3Vydml2aW5nIFByb2Nlc3NlcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuXHRwaS5vbihcInNlc3Npb25fc3RhcnRcIiwgYXN5bmMgKF9ldmVudCwgY3R4KSA9PiB7XG5cdFx0c3RhdGUubGF0ZXN0Q3R4ID0gY3R4O1xuXG5cdFx0Ly8gQ2hlY2sgZm9yIHN1cnZpdmluZyBwcm9jZXNzZXMgZnJvbSBwcmV2aW91cyBzZXNzaW9uXG5cdFx0Y29uc3QgbWFuaWZlc3QgPSBsb2FkTWFuaWZlc3QoY3R4LmN3ZCk7XG5cdFx0aWYgKG1hbmlmZXN0Lmxlbmd0aCA+IDApIHtcblx0XHRcdC8vIENoZWNrIHdoaWNoIFBJRHMgYXJlIHN0aWxsIGFsaXZlXG5cdFx0XHRjb25zdCBzdXJ2aXZpbmc6IHR5cGVvZiBtYW5pZmVzdCA9IFtdO1xuXHRcdFx0Zm9yIChjb25zdCBlbnRyeSBvZiBtYW5pZmVzdCkge1xuXHRcdFx0XHRpZiAoZW50cnkucGlkKSB7XG5cdFx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRcdHByb2Nlc3Mua2lsbChlbnRyeS5waWQsIDApOyAvLyBDaGVjayBpZiBwcm9jZXNzIGV4aXN0c1xuXHRcdFx0XHRcdFx0c3Vydml2aW5nLnB1c2goZW50cnkpO1xuXHRcdFx0XHRcdH0gY2F0Y2ggeyAvKiBwcm9jZXNzIGlzIGRlYWQgKi8gfVxuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdGlmIChzdXJ2aXZpbmcubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRjb25zdCBzdW1tYXJ5ID0gc3Vydml2aW5nLm1hcChzID0+XG5cdFx0XHRcdFx0YCAgLSAke3MuaWR9OiAke3MubGFiZWx9IChwaWQgJHtzLnBpZH0sIHR5cGU6ICR7cy5wcm9jZXNzVHlwZX0ke3MuZ3JvdXAgPyBgLCBncm91cDogJHtzLmdyb3VwfWAgOiBcIlwifSlgXG5cdFx0XHRcdCkuam9pbihcIlxcblwiKTtcblxuXHRcdFx0XHRwdXNoQWxlcnQobnVsbCxcblx0XHRcdFx0XHRgJHtzdXJ2aXZpbmcubGVuZ3RofSBiYWNrZ3JvdW5kIHByb2Nlc3MoZXMpIGZyb20gcHJldmlvdXMgc2Vzc2lvbiBzdGlsbCBydW5uaW5nOlxcbiR7c3VtbWFyeX1cXG4gIE5vdGU6IFRoZXNlIHByb2Nlc3NlcyBhcmUgb3V0c2lkZSBiZ19zaGVsbCdzIGNvbnRyb2wuIEtpbGwgdGhlbSBtYW51YWxseSBpZiBuZWVkZWQuYFxuXHRcdFx0XHQpO1xuXHRcdFx0fVxuXHRcdH1cblx0fSk7XG5cblx0Ly8gXHUyNTAwXHUyNTAwIExpdmUgRm9vdGVyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5cdC8qKiBXaGV0aGVyIHdlIGN1cnJlbnRseSBvd24gdGhlIGZvb3RlciB2aWEgc2V0Rm9vdGVyICovXG5cdGxldCBmb290ZXJBY3RpdmUgPSBmYWxzZTtcblxuXHRmdW5jdGlvbiBidWlsZEJnU3RhdHVzVGV4dCh0aDogVGhlbWUpOiBzdHJpbmcge1xuXHRcdGNvbnN0IGFsaXZlID0gQXJyYXkuZnJvbShwcm9jZXNzZXMudmFsdWVzKCkpLmZpbHRlcihwID0+IHAuYWxpdmUpO1xuXHRcdGlmIChhbGl2ZS5sZW5ndGggPT09IDApIHJldHVybiBcIlwiO1xuXG5cdFx0Y29uc3Qgc2VwID0gdGguZmcoXCJkaW1cIiwgXCIgXHUwMEI3IFwiKTtcblx0XHRjb25zdCBpdGVtczogc3RyaW5nW10gPSBbXTtcblx0XHRmb3IgKGNvbnN0IHAgb2YgYWxpdmUpIHtcblx0XHRcdGNvbnN0IHN0YXR1c0ljb24gPSBwLnN0YXR1cyA9PT0gXCJyZWFkeVwiID8gdGguZmcoXCJzdWNjZXNzXCIsIFwiXHUyNUNGXCIpXG5cdFx0XHRcdDogcC5zdGF0dXMgPT09IFwiZXJyb3JcIiA/IHRoLmZnKFwiZXJyb3JcIiwgXCJcdTI1Q0ZcIilcblx0XHRcdFx0OiB0aC5mZyhcIndhcm5pbmdcIiwgXCJcdTI1Q0ZcIik7XG5cdFx0XHRjb25zdCBuYW1lID0gcC5sYWJlbC5sZW5ndGggPiAxNCA/IHAubGFiZWwuc2xpY2UoMCwgMTIpICsgXCJcdTIwMjZcIiA6IHAubGFiZWw7XG5cdFx0XHRjb25zdCBwb3J0SW5mbyA9IHAucG9ydHMubGVuZ3RoID4gMCA/IHRoLmZnKFwiZGltXCIsIGA6JHtwLnBvcnRzWzBdfWApIDogXCJcIjtcblx0XHRcdGNvbnN0IGVyckJhZGdlID0gcC5yZWNlbnRFcnJvcnMubGVuZ3RoID4gMFxuXHRcdFx0XHQ/IHRoLmZnKFwiZXJyb3JcIiwgYCBlcnI6JHtwLnJlY2VudEVycm9ycy5sZW5ndGh9YClcblx0XHRcdFx0OiBcIlwiO1xuXHRcdFx0aXRlbXMucHVzaChgJHtzdGF0dXNJY29ufSAke3RoLmZnKFwibXV0ZWRcIiwgbmFtZSl9JHtwb3J0SW5mb30ke2VyckJhZGdlfWApO1xuXHRcdH1cblx0XHRyZXR1cm4gaXRlbXMuam9pbihzZXApO1xuXHR9XG5cblx0LyoqIFJlZmVyZW5jZSB0byB0dWkgZm9yIHRyaWdnZXJpbmcgcmUtcmVuZGVycyB3aGVuIGZvb3RlciBpcyBhY3RpdmUgKi9cblx0bGV0IGZvb3RlclR1aTogeyByZXF1ZXN0UmVuZGVyOiAoKSA9PiB2b2lkIH0gfCBudWxsID0gbnVsbDtcblxuXHRmdW5jdGlvbiByZWZyZXNoV2lkZ2V0KCkge1xuXHRcdGlmICghc3RhdGUubGF0ZXN0Q3R4Py5oYXNVSSkgcmV0dXJuO1xuXHRcdGNvbnN0IGFsaXZlID0gQXJyYXkuZnJvbShwcm9jZXNzZXMudmFsdWVzKCkpLmZpbHRlcihwID0+IHAuYWxpdmUpO1xuXG5cdFx0aWYgKGFsaXZlLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0aWYgKGZvb3RlckFjdGl2ZSkge1xuXHRcdFx0XHRzdGF0ZS5sYXRlc3RDdHgudWkuc2V0Rm9vdGVyKHVuZGVmaW5lZCk7XG5cdFx0XHRcdGZvb3RlckFjdGl2ZSA9IGZhbHNlO1xuXHRcdFx0XHRmb290ZXJUdWkgPSBudWxsO1xuXHRcdFx0fVxuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGlmIChmb290ZXJBY3RpdmUpIHtcblx0XHRcdC8vIEZvb3RlciBhbHJlYWR5IGluc3RhbGxlZCBcdTIwMTQganVzdCB0cmlnZ2VyIGEgcmUtcmVuZGVyXG5cdFx0XHRmb290ZXJUdWk/LnJlcXVlc3RSZW5kZXIoKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHQvLyBJbnN0YWxsIGN1c3RvbSBmb290ZXIgdGhhdCBwdXRzIGJnIHByb2Nlc3MgaW5mbyByaWdodC1hbGlnbmVkIG9uIGxpbmUgMVxuXHRcdGZvb3RlckFjdGl2ZSA9IHRydWU7XG5cdFx0c3RhdGUubGF0ZXN0Q3R4LnVpLnNldEZvb3RlcigodHVpLCB0aCwgZm9vdGVyRGF0YSkgPT4ge1xuXHRcdFx0Zm9vdGVyVHVpID0gdHVpO1xuXHRcdFx0Y29uc3QgYnJhbmNoVW5zdWIgPSBmb290ZXJEYXRhLm9uQnJhbmNoQ2hhbmdlKCgpID0+IHR1aS5yZXF1ZXN0UmVuZGVyKCkpO1xuXG5cdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRyZW5kZXIod2lkdGg6IG51bWJlcik6IHN0cmluZ1tdIHtcblx0XHRcdFx0XHQvLyBcdTI1MDBcdTI1MDAgTGluZSAxOiBwd2QgKGJyYW5jaCkgW3Nlc3Npb25dICAuLi4gIGJnIHN0YXR1cyBcdTI1MDBcdTI1MDBcblx0XHRcdFx0XHRsZXQgcHdkID0gZ2V0QmdTaGVsbExpdmVDd2Qoc3RhdGUubGF0ZXN0Q3R4Py5jd2QpO1xuXHRcdFx0XHRcdGNvbnN0IGhvbWUgPSBob21lZGlyKCk7XG5cdFx0XHRcdFx0aWYgKHB3ZC5zdGFydHNXaXRoKGhvbWUpKSB7XG5cdFx0XHRcdFx0XHRwd2QgPSBgfiR7cHdkLnNsaWNlKGhvbWUubGVuZ3RoKX1gO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRjb25zdCBicmFuY2ggPSBmb290ZXJEYXRhLmdldEdpdEJyYW5jaCgpO1xuXHRcdFx0XHRcdGlmIChicmFuY2gpIHB3ZCA9IGAke3B3ZH0gKCR7YnJhbmNofSlgO1xuXG5cdFx0XHRcdFx0Y29uc3Qgc2Vzc2lvbk5hbWUgPSBzdGF0ZS5sYXRlc3RDdHg/LnNlc3Npb25NYW5hZ2VyPy5nZXRTZXNzaW9uTmFtZT8uKCk7XG5cdFx0XHRcdFx0aWYgKHNlc3Npb25OYW1lKSBwd2QgPSBgJHtwd2R9IFx1MjAyMiAke3Nlc3Npb25OYW1lfWA7XG5cblx0XHRcdFx0XHRjb25zdCBiZ1N0YXR1cyA9IGJ1aWxkQmdTdGF0dXNUZXh0KHRoKTtcblx0XHRcdFx0XHRjb25zdCBsZWZ0UHdkID0gdGguZmcoXCJkaW1cIiwgcHdkKTtcblx0XHRcdFx0XHRjb25zdCBsZWZ0V2lkdGggPSB2aXNpYmxlV2lkdGgobGVmdFB3ZCk7XG5cdFx0XHRcdFx0Y29uc3QgcmlnaHRXaWR0aCA9IHZpc2libGVXaWR0aChiZ1N0YXR1cyk7XG5cblx0XHRcdFx0XHRsZXQgcHdkTGluZTogc3RyaW5nO1xuXHRcdFx0XHRcdGNvbnN0IG1pbkdhcCA9IDI7XG5cdFx0XHRcdFx0aWYgKGJnU3RhdHVzICYmIGxlZnRXaWR0aCArIG1pbkdhcCArIHJpZ2h0V2lkdGggPD0gd2lkdGgpIHtcblx0XHRcdFx0XHRcdGNvbnN0IHBhZCA9IFwiIFwiLnJlcGVhdCh3aWR0aCAtIGxlZnRXaWR0aCAtIHJpZ2h0V2lkdGgpO1xuXHRcdFx0XHRcdFx0cHdkTGluZSA9IGxlZnRQd2QgKyBwYWQgKyBiZ1N0YXR1cztcblx0XHRcdFx0XHR9IGVsc2UgaWYgKGJnU3RhdHVzKSB7XG5cdFx0XHRcdFx0XHQvLyBUcnVuY2F0ZSBwd2QgdG8gbWFrZSByb29tIGZvciBiZyBzdGF0dXNcblx0XHRcdFx0XHRcdGNvbnN0IGF2YWlsRm9yUHdkID0gd2lkdGggLSByaWdodFdpZHRoIC0gbWluR2FwO1xuXHRcdFx0XHRcdFx0aWYgKGF2YWlsRm9yUHdkID4gMTApIHtcblx0XHRcdFx0XHRcdFx0Y29uc3QgdHJ1bmNQd2QgPSB0cnVuY2F0ZVRvV2lkdGgobGVmdFB3ZCwgYXZhaWxGb3JQd2QsIHRoLmZnKFwiZGltXCIsIFwiXHUyMDI2XCIpKTtcblx0XHRcdFx0XHRcdFx0Y29uc3QgdHJ1bmNXaWR0aCA9IHZpc2libGVXaWR0aCh0cnVuY1B3ZCk7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IHBhZCA9IFwiIFwiLnJlcGVhdChNYXRoLm1heCgwLCB3aWR0aCAtIHRydW5jV2lkdGggLSByaWdodFdpZHRoKSk7XG5cdFx0XHRcdFx0XHRcdHB3ZExpbmUgPSB0cnVuY1B3ZCArIHBhZCArIGJnU3RhdHVzO1xuXHRcdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdFx0cHdkTGluZSA9IHRydW5jYXRlVG9XaWR0aChsZWZ0UHdkLCB3aWR0aCwgdGguZmcoXCJkaW1cIiwgXCJcdTIwMjZcIikpO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHRwd2RMaW5lID0gdHJ1bmNhdGVUb1dpZHRoKGxlZnRQd2QsIHdpZHRoLCB0aC5mZyhcImRpbVwiLCBcIlx1MjAyNlwiKSk7XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Ly8gXHUyNTAwXHUyNTAwIExpbmUgMjogdG9rZW4gc3RhdHMgKGxlZnQpIC4uLiBtb2RlbCAocmlnaHQpIFx1MjUwMFx1MjUwMFxuXHRcdFx0XHRcdGNvbnN0IGN0eCA9IHN0YXRlLmxhdGVzdEN0eDtcblx0XHRcdFx0XHRjb25zdCBzbSA9IGN0eD8uc2Vzc2lvbk1hbmFnZXI7XG5cdFx0XHRcdFx0bGV0IHRvdGFsSW5wdXQgPSAwLCB0b3RhbE91dHB1dCA9IDA7XG5cdFx0XHRcdFx0bGV0IHRvdGFsQ2FjaGVSZWFkID0gMCwgdG90YWxDYWNoZVdyaXRlID0gMCwgdG90YWxDb3N0ID0gMDtcblx0XHRcdFx0XHRpZiAoc20pIHtcblx0XHRcdFx0XHRcdGZvciAoY29uc3QgZW50cnkgb2Ygc20uZ2V0RW50cmllcygpKSB7XG5cdFx0XHRcdFx0XHRcdGlmIChlbnRyeS50eXBlID09PSBcIm1lc3NhZ2VcIiAmJiAoZW50cnkgYXMgYW55KS5tZXNzYWdlPy5yb2xlID09PSBcImFzc2lzdGFudFwiKSB7XG5cdFx0XHRcdFx0XHRcdFx0Y29uc3QgdSA9IChlbnRyeSBhcyBhbnkpLm1lc3NhZ2UudXNhZ2U7XG5cdFx0XHRcdFx0XHRcdFx0aWYgKHUpIHtcblx0XHRcdFx0XHRcdFx0XHRcdHRvdGFsSW5wdXQgKz0gdS5pbnB1dCB8fCAwO1xuXHRcdFx0XHRcdFx0XHRcdFx0dG90YWxPdXRwdXQgKz0gdS5vdXRwdXQgfHwgMDtcblx0XHRcdFx0XHRcdFx0XHRcdHRvdGFsQ2FjaGVSZWFkICs9IHUuY2FjaGVSZWFkIHx8IDA7XG5cdFx0XHRcdFx0XHRcdFx0XHR0b3RhbENhY2hlV3JpdGUgKz0gdS5jYWNoZVdyaXRlIHx8IDA7XG5cdFx0XHRcdFx0XHRcdFx0XHR0b3RhbENvc3QgKz0gdS5jb3N0Py50b3RhbCB8fCAwO1xuXHRcdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdGNvbnN0IGNvbnRleHRVc2FnZSA9IGN0eD8uZ2V0Q29udGV4dFVzYWdlPy4oKTtcblx0XHRcdFx0XHRjb25zdCBjb250ZXh0V2luZG93ID0gY29udGV4dFVzYWdlPy5jb250ZXh0V2luZG93ID8/IGN0eD8ubW9kZWw/LmNvbnRleHRXaW5kb3cgPz8gMDtcblx0XHRcdFx0XHRjb25zdCBjb250ZXh0UGVyY2VudFZhbHVlID0gY29udGV4dFVzYWdlPy5wZXJjZW50ID8/IDA7XG5cdFx0XHRcdFx0Y29uc3QgY29udGV4dFBlcmNlbnQgPSBjb250ZXh0VXNhZ2U/LnBlcmNlbnQgIT09IG51bGwgPyAoY29udGV4dFBlcmNlbnRWYWx1ZSkudG9GaXhlZCgxKSA6IFwiP1wiO1xuXG5cdFx0XHRcdFx0Y29uc3Qgc3RhdHNQYXJ0czogc3RyaW5nW10gPSBbXTtcblx0XHRcdFx0XHRpZiAodG90YWxJbnB1dCkgc3RhdHNQYXJ0cy5wdXNoKGBcdTIxOTEke2Zvcm1hdFRva2VuQ291bnQodG90YWxJbnB1dCl9YCk7XG5cdFx0XHRcdFx0aWYgKHRvdGFsT3V0cHV0KSBzdGF0c1BhcnRzLnB1c2goYFx1MjE5MyR7Zm9ybWF0VG9rZW5Db3VudCh0b3RhbE91dHB1dCl9YCk7XG5cdFx0XHRcdFx0aWYgKHRvdGFsQ2FjaGVSZWFkKSBzdGF0c1BhcnRzLnB1c2goYFIke2Zvcm1hdFRva2VuQ291bnQodG90YWxDYWNoZVJlYWQpfWApO1xuXHRcdFx0XHRcdGlmICh0b3RhbENhY2hlV3JpdGUpIHN0YXRzUGFydHMucHVzaChgVyR7Zm9ybWF0VG9rZW5Db3VudCh0b3RhbENhY2hlV3JpdGUpfWApO1xuXHRcdFx0XHRcdGlmICh0b3RhbENvc3QpIHN0YXRzUGFydHMucHVzaChgJCR7dG90YWxDb3N0LnRvRml4ZWQoMyl9YCk7XG5cblx0XHRcdFx0XHRjb25zdCBjb250ZXh0RGlzcGxheSA9IGNvbnRleHRQZXJjZW50ID09PSBcIj9cIlxuXHRcdFx0XHRcdFx0PyBgPy8ke2Zvcm1hdFRva2VuQ291bnQoY29udGV4dFdpbmRvdyl9YFxuXHRcdFx0XHRcdFx0OiBgJHtjb250ZXh0UGVyY2VudH0lLyR7Zm9ybWF0VG9rZW5Db3VudChjb250ZXh0V2luZG93KX1gO1xuXHRcdFx0XHRcdGxldCBjb250ZXh0U3RyOiBzdHJpbmc7XG5cdFx0XHRcdFx0aWYgKGNvbnRleHRQZXJjZW50VmFsdWUgPiA5MCkge1xuXHRcdFx0XHRcdFx0Y29udGV4dFN0ciA9IHRoLmZnKFwiZXJyb3JcIiwgY29udGV4dERpc3BsYXkpO1xuXHRcdFx0XHRcdH0gZWxzZSBpZiAoY29udGV4dFBlcmNlbnRWYWx1ZSA+IDcwKSB7XG5cdFx0XHRcdFx0XHRjb250ZXh0U3RyID0gdGguZmcoXCJ3YXJuaW5nXCIsIGNvbnRleHREaXNwbGF5KTtcblx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0Y29udGV4dFN0ciA9IGNvbnRleHREaXNwbGF5O1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRzdGF0c1BhcnRzLnB1c2goY29udGV4dFN0cik7XG5cblx0XHRcdFx0XHRsZXQgc3RhdHNMZWZ0ID0gc3RhdHNQYXJ0cy5qb2luKFwiIFwiKTtcblx0XHRcdFx0XHRsZXQgc3RhdHNMZWZ0V2lkdGggPSB2aXNpYmxlV2lkdGgoc3RhdHNMZWZ0KTtcblx0XHRcdFx0XHRpZiAoc3RhdHNMZWZ0V2lkdGggPiB3aWR0aCkge1xuXHRcdFx0XHRcdFx0c3RhdHNMZWZ0ID0gdHJ1bmNhdGVUb1dpZHRoKHN0YXRzTGVmdCwgd2lkdGgsIFwiLi4uXCIpO1xuXHRcdFx0XHRcdFx0c3RhdHNMZWZ0V2lkdGggPSB2aXNpYmxlV2lkdGgoc3RhdHNMZWZ0KTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRjb25zdCBtb2RlbE5hbWUgPSBjdHg/Lm1vZGVsPy5pZCB8fCBcIm5vLW1vZGVsXCI7XG5cdFx0XHRcdFx0bGV0IHJpZ2h0U2lkZSA9IG1vZGVsTmFtZTtcblx0XHRcdFx0XHRpZiAoY3R4Py5tb2RlbD8ucmVhc29uaW5nKSB7XG5cdFx0XHRcdFx0XHRjb25zdCB0aGlua2luZ0xldmVsID0gKGN0eCBhcyBhbnkpLmdldFRoaW5raW5nTGV2ZWw/LigpIHx8IFwib2ZmXCI7XG5cdFx0XHRcdFx0XHRyaWdodFNpZGUgPSB0aGlua2luZ0xldmVsID09PSBcIm9mZlwiID8gYCR7bW9kZWxOYW1lfSBcdTIwMjIgdGhpbmtpbmcgb2ZmYCA6IGAke21vZGVsTmFtZX0gXHUyMDIyICR7dGhpbmtpbmdMZXZlbH1gO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRpZiAoZm9vdGVyRGF0YS5nZXRBdmFpbGFibGVQcm92aWRlckNvdW50KCkgPiAxICYmIGN0eD8ubW9kZWwpIHtcblx0XHRcdFx0XHRcdGNvbnN0IHdpdGhQcm92aWRlciA9IGAoJHtjdHgubW9kZWwucHJvdmlkZXJ9KSAke3JpZ2h0U2lkZX1gO1xuXHRcdFx0XHRcdFx0aWYgKHN0YXRzTGVmdFdpZHRoICsgMiArIHZpc2libGVXaWR0aCh3aXRoUHJvdmlkZXIpIDw9IHdpZHRoKSB7XG5cdFx0XHRcdFx0XHRcdHJpZ2h0U2lkZSA9IHdpdGhQcm92aWRlcjtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRjb25zdCByaWdodFNpZGVXaWR0aCA9IHZpc2libGVXaWR0aChyaWdodFNpZGUpO1xuXHRcdFx0XHRcdGxldCBzdGF0c0xpbmU6IHN0cmluZztcblx0XHRcdFx0XHRpZiAoc3RhdHNMZWZ0V2lkdGggKyAyICsgcmlnaHRTaWRlV2lkdGggPD0gd2lkdGgpIHtcblx0XHRcdFx0XHRcdGNvbnN0IHBhZCA9IFwiIFwiLnJlcGVhdCh3aWR0aCAtIHN0YXRzTGVmdFdpZHRoIC0gcmlnaHRTaWRlV2lkdGgpO1xuXHRcdFx0XHRcdFx0c3RhdHNMaW5lID0gc3RhdHNMZWZ0ICsgcGFkICsgcmlnaHRTaWRlO1xuXHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHRjb25zdCBhdmFpbCA9IHdpZHRoIC0gc3RhdHNMZWZ0V2lkdGggLSAyO1xuXHRcdFx0XHRcdFx0aWYgKGF2YWlsID4gMCkge1xuXHRcdFx0XHRcdFx0XHRjb25zdCB0cnVuY1JpZ2h0ID0gdHJ1bmNhdGVUb1dpZHRoKHJpZ2h0U2lkZSwgYXZhaWwsIFwiXCIpO1xuXHRcdFx0XHRcdFx0XHRjb25zdCB0cnVuY1JpZ2h0V2lkdGggPSB2aXNpYmxlV2lkdGgodHJ1bmNSaWdodCk7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IHBhZCA9IFwiIFwiLnJlcGVhdChNYXRoLm1heCgwLCB3aWR0aCAtIHN0YXRzTGVmdFdpZHRoIC0gdHJ1bmNSaWdodFdpZHRoKSk7XG5cdFx0XHRcdFx0XHRcdHN0YXRzTGluZSA9IHN0YXRzTGVmdCArIHBhZCArIHRydW5jUmlnaHQ7XG5cdFx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0XHRzdGF0c0xpbmUgPSBzdGF0c0xlZnQ7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Y29uc3QgZGltU3RhdHNMZWZ0ID0gdGguZmcoXCJkaW1cIiwgc3RhdHNMZWZ0KTtcblx0XHRcdFx0XHRjb25zdCByZW1haW5kZXIgPSBzdGF0c0xpbmUuc2xpY2Uoc3RhdHNMZWZ0Lmxlbmd0aCk7XG5cdFx0XHRcdFx0Y29uc3QgZGltUmVtYWluZGVyID0gdGguZmcoXCJkaW1cIiwgcmVtYWluZGVyKTtcblxuXHRcdFx0XHRcdGNvbnN0IGxpbmVzID0gW3B3ZExpbmUsIGRpbVN0YXRzTGVmdCArIGRpbVJlbWFpbmRlcl07XG5cblx0XHRcdFx0XHQvLyBcdTI1MDBcdTI1MDAgTGluZSAzIChvcHRpb25hbCk6IG90aGVyIGV4dGVuc2lvbiBzdGF0dXNlcyBcdTI1MDBcdTI1MDBcblx0XHRcdFx0XHRjb25zdCBleHRlbnNpb25TdGF0dXNlcyA9IGZvb3RlckRhdGEuZ2V0RXh0ZW5zaW9uU3RhdHVzZXMoKTtcblx0XHRcdFx0XHQvLyBGaWx0ZXIgb3V0IG91ciBvd24gYmctc2hlbGwgc3RhdHVzIHNpbmNlIGl0J3MgYWxyZWFkeSBvbiBsaW5lIDFcblx0XHRcdFx0XHRjb25zdCBvdGhlclN0YXR1c2VzID0gQXJyYXkuZnJvbShleHRlbnNpb25TdGF0dXNlcy5lbnRyaWVzKCkpXG5cdFx0XHRcdFx0XHQuZmlsdGVyKChba2V5XSkgPT4ga2V5ICE9PSBcImJnLXNoZWxsXCIpXG5cdFx0XHRcdFx0XHQuc29ydCgoW2FdLCBbYl0pID0+IGEubG9jYWxlQ29tcGFyZShiKSlcblx0XHRcdFx0XHRcdC5tYXAoKFssIHRleHRdKSA9PiB0ZXh0LnJlcGxhY2UoL1tcXHJcXG5cXHRdL2csIFwiIFwiKS5yZXBsYWNlKC8gKy9nLCBcIiBcIikudHJpbSgpKTtcblx0XHRcdFx0XHRpZiAob3RoZXJTdGF0dXNlcy5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdFx0XHRsaW5lcy5wdXNoKHRydW5jYXRlVG9XaWR0aChvdGhlclN0YXR1c2VzLmpvaW4oXCIgXCIpLCB3aWR0aCwgdGguZmcoXCJkaW1cIiwgXCIuLi5cIikpKTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRyZXR1cm4gbGluZXM7XG5cdFx0XHRcdH0sXG5cdFx0XHRcdGludmFsaWRhdGUoKSB7fSxcblx0XHRcdFx0ZGlzcG9zZSgpIHtcblx0XHRcdFx0XHRicmFuY2hVbnN1YigpO1xuXHRcdFx0XHRcdGZvb3RlclR1aSA9IG51bGw7XG5cdFx0XHRcdH0sXG5cdFx0XHR9O1xuXHRcdH0pO1xuXHR9XG5cblx0Ly8gRXhwb3NlIHJlZnJlc2hXaWRnZXQgdmlhIHNoYXJlZCBzdGF0ZSBzbyB0aGUgY29tbWFuZCBtb2R1bGUgY2FuIHVzZSBpdFxuXHRzdGF0ZS5yZWZyZXNoV2lkZ2V0ID0gcmVmcmVzaFdpZGdldDtcblxuXHQvLyBQZXJpb2RpYyBtYWludGVuYW5jZVxuXHRjb25zdCBtYWludGVuYW5jZUludGVydmFsID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuXHRcdHBydW5lRGVhZFByb2Nlc3NlcygpO1xuXHRcdHJlZnJlc2hXaWRnZXQoKTtcblx0XHQvLyBQZXJzaXN0IG1hbmlmZXN0IHBlcmlvZGljYWxseVxuXHRcdGlmIChzdGF0ZS5sYXRlc3RDdHgpIHtcblx0XHRcdHN5bmNMYXRlc3RDdHhDd2QoKTtcblx0XHRcdHBlcnNpc3RNYW5pZmVzdChzdGF0ZS5sYXRlc3RDdHguY3dkKTtcblx0XHR9XG5cdH0sIDIwMDApO1xuXG5cdC8vIFJlZnJlc2ggd2lkZ2V0IGFmdGVyIGFnZW50IGFjdGlvbnMgYW5kIHNlc3Npb24gZXZlbnRzXG5cdGNvbnN0IHJlZnJlc2hIYW5kbGVyID0gYXN5bmMgKF9ldmVudDogdW5rbm93biwgY3R4OiBFeHRlbnNpb25Db250ZXh0KSA9PiB7XG5cdFx0c3RhdGUubGF0ZXN0Q3R4ID0gY3R4O1xuXHRcdHJlZnJlc2hXaWRnZXQoKTtcblx0fTtcblx0cGkub24oXCJ0dXJuX2VuZFwiLCByZWZyZXNoSGFuZGxlciBhcyBhbnkpO1xuXHRwaS5vbihcImFnZW50X2VuZFwiLCByZWZyZXNoSGFuZGxlciBhcyBhbnkpO1xuXHRwaS5vbihcInNlc3Npb25fc3RhcnRcIiwgcmVmcmVzaEhhbmRsZXIgYXMgYW55KTtcblx0cGkub24oXCJzZXNzaW9uX3N3aXRjaFwiLCByZWZyZXNoSGFuZGxlciBhcyBhbnkpO1xuXG5cdHBpLm9uKFwidG9vbF9leGVjdXRpb25fZW5kXCIsIGFzeW5jIChfZXZlbnQsIGN0eCkgPT4ge1xuXHRcdHN0YXRlLmxhdGVzdEN0eCA9IGN0eDtcblx0XHRyZWZyZXNoV2lkZ2V0KCk7XG5cdH0pO1xuXG5cdC8vIENsZWFuIHVwIG9uIHNodXRkb3duXG5cdHBpLm9uKFwic2Vzc2lvbl9zaHV0ZG93blwiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y2xlYXJJbnRlcnZhbChtYWludGVuYW5jZUludGVydmFsKTtcblx0XHRpZiAoc3RhdGUubGF0ZXN0Q3R4KSB7XG5cdFx0XHRzeW5jTGF0ZXN0Q3R4Q3dkKCk7XG5cdFx0XHRwZXJzaXN0TWFuaWZlc3Qoc3RhdGUubGF0ZXN0Q3R4LmN3ZCk7XG5cdFx0fVxuXHRcdGNsZWFudXBBbGwoKTtcblx0fSk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFVQTtBQUFBLEVBQ0M7QUFBQSxFQUNBO0FBQUEsT0FDTTtBQUVQO0FBQUEsRUFDQztBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNNO0FBQ1AsU0FBUyxjQUFjLG1CQUFtQixvQ0FBb0M7QUFDOUUsU0FBUyx3QkFBd0I7QUFHakMsU0FBUyxlQUFlO0FBRWpCLFNBQVMseUJBQXlCLElBQWtCLE9BQWlDO0FBRTNGLFdBQVMsbUJBQXlCO0FBQ2pDLFFBQUksQ0FBQyxNQUFNLFVBQVc7QUFDdEIsVUFBTSxZQUFZLDZCQUE2QixNQUFNLFVBQVUsR0FBRztBQUNsRSxRQUFJLGNBQWMsTUFBTSxVQUFVLEtBQUs7QUFDdEMsWUFBTSxZQUFZLEVBQUUsR0FBRyxNQUFNLFdBQVcsS0FBSyxVQUFVO0FBQUEsSUFDeEQ7QUFBQSxFQUNEO0FBR0EsUUFBTSxnQkFBZ0IsTUFBTTtBQUMzQixlQUFXO0FBRVgsUUFBSTtBQUNILFlBQU0sRUFBRSxnQkFBZ0IsSUFBSSxRQUFRLGFBQWE7QUFDakQsWUFBTSxjQUFjLGdCQUFnQixRQUFRLEdBQUc7QUFDL0MsaUJBQVcsWUFBWSxhQUFhO0FBQ25DLFlBQUk7QUFBRSxrQkFBUSxLQUFLLFVBQVUsU0FBUztBQUFBLFFBQUcsUUFBUTtBQUFBLFFBQUM7QUFBQSxNQUNuRDtBQUFBLElBQ0QsUUFBUTtBQUFBLElBQUM7QUFBQSxFQUNWO0FBQ0EsVUFBUSxHQUFHLFdBQVcsYUFBYTtBQUNuQyxVQUFRLEdBQUcsVUFBVSxhQUFhO0FBQ2xDLFVBQVEsR0FBRyxjQUFjLGFBQWE7QUFHdEMsS0FBRyxHQUFHLG9CQUFvQixZQUFZO0FBQ3JDLFlBQVEsSUFBSSxXQUFXLGFBQWE7QUFDcEMsWUFBUSxJQUFJLFVBQVUsYUFBYTtBQUNuQyxZQUFR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
