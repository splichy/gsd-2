import { logWarning } from "../workflow-logger.js";
import {
  checkDeepProjectSetupAfterTurn,
  checkAutoStartAfterDiscuss,
  maybeHandleReadyPhraseWithoutFiles,
  maybeHandleEmptyIntentTurn,
  resetEmptyTurnCounter
} from "../guided-flow.js";
import { clearPathCache } from "../paths.js";
import {
  getAutoDashboardData,
  getAutoModeStartModel,
  isAutoActive,
  isAutoCompletionStopInProgress,
  pauseAuto,
  setCurrentDispatchedModelId
} from "../auto.js";
import { getNextFallbackModel, resolveModelWithFallbacksForUnit } from "../preferences.js";
import { pauseAutoForProviderError } from "../provider-error-pause.js";
import {
  isSessionSwitchAbortGraceActive,
  isSessionSwitchInFlight,
  resolveAgentEnd,
  resolveAgentEndCancelled
} from "../auto/resolve.js";
import { shouldIgnoreAgentEndForActiveUnit } from "../auto/unit-runner-events.js";
import { resolveModelId } from "../auto-model-selection.js";
import { resolveProjectRoot } from "../worktree.js";
import { clearDiscussionFlowState } from "./write-gate.js";
import { resumeAutoAfterProviderDelay } from "./provider-error-resume.js";
import {
  classifyError,
  createRetryState,
  resetRetryState,
  isTransient
} from "../error-classifier.js";
import { blockModel, isModelBlocked } from "../blocked-models.js";
const retryState = createRetryState();
const MAX_NETWORK_RETRIES = 2;
function isObjectRecord(value) {
  return !!value && typeof value === "object";
}
function _hasEmptyAgentEndContent(content) {
  return content == null || Array.isArray(content) && content.length === 0;
}
const MAX_TRANSIENT_AUTO_RESUMES = 8;
function resetTransientRetryState() {
  resetRetryState(retryState);
}
function resolveAgentEndBasePath() {
  try {
    return resolveProjectRoot(process.cwd());
  } catch {
    return void 0;
  }
}
function _buildAbortedPauseContext(lastMsg) {
  const hasErrorMessage = Object.prototype.hasOwnProperty.call(lastMsg, "errorMessage") && !!lastMsg.errorMessage;
  return {
    message: hasErrorMessage ? String(lastMsg.errorMessage) : "Operation aborted",
    category: "aborted",
    isTransient: true
  };
}
function isUserInitiatedAbortMessage(message) {
  if (!message) return false;
  return /\b(?:claude code process aborted by user|request aborted by user|process aborted by user)\b/i.test(message);
}
function isBareClaudeCodeSessionSwitchAbortMarker(message) {
  if (!message) return false;
  const normalized = message.trim().replace(/\s+/g, " ").toLowerCase();
  return normalized === "claude code process aborted by user" || normalized === "request aborted by user" || normalized === "process aborted by user" || normalized === "claude code stream aborted by caller";
}
function readAssistantTextContent(content) {
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (!block || typeof block !== "object") return "";
    const text = block.text;
    return typeof text === "string" ? text : "";
  }).filter(Boolean).join("\n");
}
function isClaudeCodeSessionSwitchAbortMessage(lastMsg) {
  if (!lastMsg || typeof lastMsg !== "object") return false;
  const m = lastMsg;
  const carriers = [
    m.errorMessage ? String(m.errorMessage) : "",
    readAssistantTextContent(m.content)
  ].filter((value) => value.trim().length > 0);
  if ((m.stopReason === "error" || m.stopReason === "aborted") && carriers.length > 0) {
    return carriers.every(isBareClaudeCodeSessionSwitchAbortMarker);
  }
  return false;
}
function isBareClaudeCodeStreamAbortPlaceholder(lastMsg) {
  if (!lastMsg || typeof lastMsg !== "object") return false;
  const m = lastMsg;
  if (m.stopReason !== "aborted" || m.errorMessage) return false;
  const text = readAssistantTextContent(m.content).trim().replace(/\s+/g, " ").toLowerCase();
  return text === "claude code stream aborted by caller";
}
function _handleSessionSwitchAgentEnd(lastMsg, resolveCancelled) {
  if (!lastMsg || typeof lastMsg !== "object") return;
  const m = lastMsg;
  if (isClaudeCodeSessionSwitchAbortMessage(m)) {
    return;
  }
  if (m.stopReason === "error") {
    const rawErrorMsg = m.errorMessage ? String(m.errorMessage) : "";
    if (isBareClaudeCodeSessionSwitchAbortMarker(rawErrorMsg)) {
      return;
    }
    return;
  }
  if (m.stopReason === "aborted") {
    const hasErrorMessage = !!m.errorMessage;
    if (hasErrorMessage) {
      resolveCancelled(_buildAbortedPauseContext(m));
    }
  }
}
function resolveAgentEndErrorDisplay(rawErrorMsg, content) {
  const isUseless = !rawErrorMsg || /^(success|ok|true|error|unknown)$/i.test(rawErrorMsg.trim());
  if (isUseless && Array.isArray(content)) {
    const textBlock = content.find((b) => b.type === "text" && b.text);
    if (textBlock) return textBlock.text.slice(0, 300);
  }
  return rawErrorMsg;
}
async function pauseTransientWithBackoff(cls, pi, ctx, errorDetail, isRateLimit) {
  retryState.consecutiveTransientCount += 1;
  const baseRetryAfterMs = "retryAfterMs" in cls ? cls.retryAfterMs : 15e3;
  const retryAfterMs = baseRetryAfterMs * 2 ** Math.max(0, retryState.consecutiveTransientCount - 1);
  const allowAutoResume = retryState.consecutiveTransientCount <= MAX_TRANSIENT_AUTO_RESUMES;
  if (!allowAutoResume) {
    ctx.ui.notify(`Transient provider errors persisted after ${MAX_TRANSIENT_AUTO_RESUMES} auto-resume attempts. Pausing for manual review.`, "warning");
  }
  await pauseAutoForProviderError(ctx.ui, errorDetail, () => pauseAuto(ctx, pi, {
    message: `Provider error: ${errorDetail}`,
    category: "provider",
    isTransient: allowAutoResume,
    retryAfterMs
  }), {
    isRateLimit,
    isTransient: allowAutoResume,
    retryAfterMs,
    resume: allowAutoResume ? () => {
      void resumeAutoAfterProviderDelay(pi, ctx).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Provider error recovery delay elapsed, but auto-mode failed to resume: ${message}`, "error");
      });
    } : void 0
  });
}
async function handleAgentEnd(pi, event, ctx) {
  clearPathCache();
  try {
    if (await checkDeepProjectSetupAfterTurn(event, ctx, resolveAgentEndBasePath())) {
      return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logWarning("bootstrap", `checkDeepProjectSetupAfterTurn failed: ${message}`);
  }
  if (checkAutoStartAfterDiscuss()) {
    clearDiscussionFlowState(resolveAgentEndBasePath() ?? process.cwd());
    return;
  }
  if (maybeHandleReadyPhraseWithoutFiles(event)) return;
  if (maybeHandleEmptyIntentTurn(event, isAutoActive())) return;
  if (!isAutoActive()) return;
  if (shouldIgnoreAgentEndForActiveUnit(event)) {
    return;
  }
  const lastMsg = event.messages[event.messages.length - 1];
  if (isSessionSwitchInFlight()) {
    _handleSessionSwitchAgentEnd(lastMsg, resolveAgentEndCancelled);
    return;
  }
  if (isSessionSwitchAbortGraceActive() && isClaudeCodeSessionSwitchAbortMessage(lastMsg)) {
    return;
  }
  if (isBareClaudeCodeStreamAbortPlaceholder(lastMsg)) {
    return;
  }
  if (isObjectRecord(lastMsg) && "stopReason" in lastMsg && lastMsg.stopReason === "aborted") {
    if (isAutoCompletionStopInProgress()) {
      resetRetryState(retryState);
      resolveAgentEnd(event);
      return;
    }
    const content = "content" in lastMsg ? lastMsg.content : void 0;
    const hasEmptyContent = _hasEmptyAgentEndContent(content);
    const hasErrorMessage = "errorMessage" in lastMsg && !!lastMsg.errorMessage;
    if (hasEmptyContent && !hasErrorMessage) {
      try {
        resetRetryState(retryState);
        resolveAgentEnd(event);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Auto-mode error after empty-content abort: ${message}. Stopping auto-mode.`, "error");
        try {
          await pauseAuto(ctx, pi);
        } catch (e) {
          logWarning("bootstrap", `pauseAuto failed after empty-content abort: ${e.message}`);
        }
      }
      return;
    }
    await pauseAuto(ctx, pi, _buildAbortedPauseContext(lastMsg));
    return;
  }
  if (isObjectRecord(lastMsg) && "stopReason" in lastMsg && lastMsg.stopReason === "error") {
    const rawErrorMsg = "errorMessage" in lastMsg && lastMsg.errorMessage ? String(lastMsg.errorMessage) : "";
    if (isUserInitiatedAbortMessage(rawErrorMsg)) {
      if (isAutoCompletionStopInProgress()) {
        resetRetryState(retryState);
        resolveAgentEnd(event);
        return;
      }
      resolveAgentEndCancelled({
        message: rawErrorMsg,
        category: "aborted",
        isTransient: false
      });
      return;
    }
    const displayMsg = resolveAgentEndErrorDisplay(
      rawErrorMsg,
      "content" in lastMsg ? lastMsg.content : void 0
    );
    const errorDetail = displayMsg ? `: ${displayMsg}` : "";
    const explicitRetryAfterMs = "retryAfterMs" in lastMsg && typeof lastMsg.retryAfterMs === "number" ? lastMsg.retryAfterMs : void 0;
    const cls = classifyError(rawErrorMsg, explicitRetryAfterMs);
    if (cls.kind === "unsupported-model") {
      const dash = getAutoDashboardData();
      const rejectedProvider = ctx.model?.provider;
      const rejectedId = ctx.model?.id;
      if (dash.basePath && rejectedProvider && rejectedId) {
        try {
          blockModel(dash.basePath, rejectedProvider, rejectedId, rawErrorMsg || "unsupported for account");
          ctx.ui.notify(
            `Blocked ${rejectedProvider}/${rejectedId} for this project \u2014 provider rejected it for the current account.`,
            "warning"
          );
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          logWarning("bootstrap", `Failed to persist blocked model: ${m}`);
        }
      }
      if (dash.currentUnit && dash.basePath) {
        const modelConfig = resolveModelWithFallbacksForUnit(dash.currentUnit.type);
        if (modelConfig && modelConfig.fallbacks.length > 0) {
          const availableModels = ctx.modelRegistry.getAvailable();
          let cursorModelId = ctx.model?.id;
          while (true) {
            const nextModelId = getNextFallbackModel(cursorModelId, modelConfig);
            if (!nextModelId) break;
            const candidate = resolveModelId(nextModelId, availableModels, ctx.model?.provider);
            if (candidate && !isModelBlocked(dash.basePath, candidate.provider, candidate.id)) {
              const ok = await pi.setModel(candidate, { persist: false });
              if (ok) {
                setCurrentDispatchedModelId({ provider: candidate.provider, id: candidate.id });
                ctx.ui.notify(
                  `Switched to fallback ${candidate.provider}/${candidate.id} after account entitlement rejection.`,
                  "warning"
                );
                pi.sendMessage(
                  { customType: "gsd-auto-timeout-recovery", content: "Continue execution.", display: false },
                  { triggerTurn: true }
                );
                return;
              }
            }
            cursorModelId = nextModelId;
          }
        }
        const sessionModel = getAutoModeStartModel();
        if (sessionModel && !(sessionModel.provider === rejectedProvider && sessionModel.id === rejectedId) && !isModelBlocked(dash.basePath, sessionModel.provider, sessionModel.id)) {
          const startModel = ctx.modelRegistry.getAvailable().find((m) => m.provider === sessionModel.provider && m.id === sessionModel.id);
          if (startModel) {
            const ok = await pi.setModel(startModel, { persist: false });
            if (ok) {
              setCurrentDispatchedModelId({ provider: startModel.provider, id: startModel.id });
              ctx.ui.notify(
                `Restored auto-mode start model ${startModel.provider}/${startModel.id} after entitlement rejection.`,
                "warning"
              );
              pi.sendMessage(
                { customType: "gsd-auto-timeout-recovery", content: "Continue execution.", display: false },
                { triggerTurn: true }
              );
              return;
            }
          }
        }
      }
      const blockedLabel = rejectedProvider && rejectedId ? `${rejectedProvider}/${rejectedId}` : "current model";
      const pauseDetail = `Model ${blockedLabel} blocked for this account${errorDetail}. Configure a different model and restart /gsd auto.`;
      await pauseAutoForProviderError(
        ctx.ui,
        pauseDetail,
        () => pauseAuto(ctx, pi, {
          message: pauseDetail,
          category: "provider",
          isTransient: false
        }),
        {
          isRateLimit: false,
          isTransient: false,
          retryAfterMs: 0
        }
      );
      return;
    }
    if (isTransient(cls) && cls.kind !== "rate-limit") {
      return;
    }
    if (cls.kind === "rate-limit") {
      const currentProvider = ctx.model?.provider;
      if (currentProvider === "openai-codex" || currentProvider === "google-gemini-cli") {
        cls.retryAfterMs = Math.min(cls.retryAfterMs, 3e4);
      }
    }
    if (cls.kind === "network") {
      const currentModelId = ctx.model?.id ?? "unknown";
      if (retryState.currentRetryModelId !== currentModelId) {
        retryState.networkRetryCount = 0;
        retryState.currentRetryModelId = currentModelId;
      }
      if (retryState.networkRetryCount < MAX_NETWORK_RETRIES) {
        retryState.networkRetryCount += 1;
        retryState.consecutiveTransientCount += 1;
        const attempt = retryState.networkRetryCount;
        const delayMs = attempt * cls.retryAfterMs;
        ctx.ui.notify(`Network error on ${currentModelId}${errorDetail}. Retry ${attempt}/${MAX_NETWORK_RETRIES} in ${delayMs / 1e3}s...`, "warning");
        setTimeout(() => {
          pi.sendMessage(
            { customType: "gsd-auto-timeout-recovery", content: "Continue execution \u2014 retrying after transient network error.", display: false },
            { triggerTurn: true }
          );
        }, delayMs);
        return;
      }
      retryState.networkRetryCount = 0;
      retryState.currentRetryModelId = void 0;
      ctx.ui.notify(`Network retries exhausted for ${currentModelId}. Attempting model fallback.`, "warning");
    }
    if (cls.kind === "rate-limit" || cls.kind === "network" || cls.kind === "server" || cls.kind === "connection" || cls.kind === "stream") {
      const dash = getAutoDashboardData();
      if (dash.currentUnit) {
        const modelConfig = resolveModelWithFallbacksForUnit(dash.currentUnit.type);
        if (modelConfig && modelConfig.fallbacks.length > 0) {
          const availableModels = ctx.modelRegistry.getAvailable();
          const nextModelId = getNextFallbackModel(ctx.model?.id, modelConfig);
          if (nextModelId) {
            retryState.networkRetryCount = 0;
            retryState.currentRetryModelId = void 0;
            const modelToSet = resolveModelId(nextModelId, availableModels, ctx.model?.provider);
            if (modelToSet) {
              const ok = await pi.setModel(modelToSet, { persist: false });
              if (ok) {
                setCurrentDispatchedModelId({ provider: modelToSet.provider, id: modelToSet.id });
                ctx.ui.notify(`Model error${errorDetail}. Switched to fallback: ${nextModelId} and resuming.`, "warning");
                pi.sendMessage({ customType: "gsd-auto-timeout-recovery", content: "Continue execution.", display: false }, { triggerTurn: true });
                return;
              }
            }
          }
        }
      }
      const sessionModel = getAutoModeStartModel();
      if (sessionModel) {
        if (ctx.model?.id !== sessionModel.id || ctx.model?.provider !== sessionModel.provider) {
          const startModel = ctx.modelRegistry.getAvailable().find((m) => m.provider === sessionModel.provider && m.id === sessionModel.id);
          if (startModel) {
            const ok = await pi.setModel(startModel, { persist: false });
            if (ok) {
              setCurrentDispatchedModelId({ provider: startModel.provider, id: startModel.id });
              retryState.networkRetryCount = 0;
              retryState.currentRetryModelId = void 0;
              ctx.ui.notify(`Model error${errorDetail}. Restored session model: ${sessionModel.provider}/${sessionModel.id} and resuming.`, "warning");
              pi.sendMessage({ customType: "gsd-auto-timeout-recovery", content: "Continue execution.", display: false }, { triggerTurn: true });
              return;
            }
          }
        }
      }
    }
    if (isTransient(cls)) {
      await pauseTransientWithBackoff(cls, pi, ctx, errorDetail, cls.kind === "rate-limit");
      return;
    }
    await pauseAutoForProviderError(ctx.ui, errorDetail, () => pauseAuto(ctx, pi, {
      message: `Provider error: ${errorDetail}`,
      category: "provider",
      isTransient: false
    }), {
      isRateLimit: false,
      isTransient: false,
      retryAfterMs: 0
    });
    return;
  }
  try {
    resetRetryState(retryState);
    resetEmptyTurnCounter();
    resolveAgentEnd(event);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Auto-mode error in agent_end handler: ${message}. Stopping auto-mode.`, "error");
    try {
      await pauseAuto(ctx, pi);
    } catch (e) {
      logWarning("bootstrap", `pauseAuto failed in agent_end handler: ${e.message}`);
    }
  }
}
export {
  MAX_TRANSIENT_AUTO_RESUMES,
  _buildAbortedPauseContext,
  _handleSessionSwitchAgentEnd,
  _hasEmptyAgentEndContent,
  handleAgentEnd,
  isBareClaudeCodeStreamAbortPlaceholder,
  isClaudeCodeSessionSwitchAbortMessage,
  isUserInitiatedAbortMessage,
  resetTransientRetryState,
  resolveAgentEndErrorDisplay
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9ib290c3RyYXAvYWdlbnQtZW5kLXJlY292ZXJ5LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBHU0QtMiArIHNyYy9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvYm9vdHN0cmFwL2FnZW50LWVuZC1yZWNvdmVyeS50cyAtIEhhbmRsZXMgcHJvdmlkZXIgYW5kIGFnZW50LWVuZCByZWNvdmVyeSBmb3IgR1NEIGF1dG8tbW9kZS5cblxuaW1wb3J0IHR5cGUgeyBFeHRlbnNpb25BUEksIEV4dGVuc2lvbkNvbnRleHQgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcblxuaW1wb3J0IHR5cGUgeyBBZ2VudEVuZEV2ZW50LCBFcnJvckNvbnRleHQgfSBmcm9tIFwiLi4vYXV0by90eXBlcy5qc1wiO1xuaW1wb3J0IHsgbG9nV2FybmluZyB9IGZyb20gXCIuLi93b3JrZmxvdy1sb2dnZXIuanNcIjtcbmltcG9ydCB7XG4gIGNoZWNrRGVlcFByb2plY3RTZXR1cEFmdGVyVHVybixcbiAgY2hlY2tBdXRvU3RhcnRBZnRlckRpc2N1c3MsXG4gIG1heWJlSGFuZGxlUmVhZHlQaHJhc2VXaXRob3V0RmlsZXMsXG4gIG1heWJlSGFuZGxlRW1wdHlJbnRlbnRUdXJuLFxuICByZXNldEVtcHR5VHVybkNvdW50ZXIsXG59IGZyb20gXCIuLi9ndWlkZWQtZmxvdy5qc1wiO1xuaW1wb3J0IHsgY2xlYXJQYXRoQ2FjaGUgfSBmcm9tIFwiLi4vcGF0aHMuanNcIjtcbmltcG9ydCB7XG4gIGdldEF1dG9EYXNoYm9hcmREYXRhLFxuICBnZXRBdXRvTW9kZVN0YXJ0TW9kZWwsXG4gIGlzQXV0b0FjdGl2ZSxcbiAgaXNBdXRvQ29tcGxldGlvblN0b3BJblByb2dyZXNzLFxuICBwYXVzZUF1dG8sXG4gIHNldEN1cnJlbnREaXNwYXRjaGVkTW9kZWxJZCxcbn0gZnJvbSBcIi4uL2F1dG8uanNcIjtcbmltcG9ydCB7IGdldE5leHRGYWxsYmFja01vZGVsLCByZXNvbHZlTW9kZWxXaXRoRmFsbGJhY2tzRm9yVW5pdCB9IGZyb20gXCIuLi9wcmVmZXJlbmNlcy5qc1wiO1xuaW1wb3J0IHsgcGF1c2VBdXRvRm9yUHJvdmlkZXJFcnJvciB9IGZyb20gXCIuLi9wcm92aWRlci1lcnJvci1wYXVzZS5qc1wiO1xuaW1wb3J0IHtcbiAgaXNTZXNzaW9uU3dpdGNoQWJvcnRHcmFjZUFjdGl2ZSxcbiAgaXNTZXNzaW9uU3dpdGNoSW5GbGlnaHQsXG4gIHJlc29sdmVBZ2VudEVuZCxcbiAgcmVzb2x2ZUFnZW50RW5kQ2FuY2VsbGVkLFxufSBmcm9tIFwiLi4vYXV0by9yZXNvbHZlLmpzXCI7XG5pbXBvcnQgeyBzaG91bGRJZ25vcmVBZ2VudEVuZEZvckFjdGl2ZVVuaXQgfSBmcm9tIFwiLi4vYXV0by91bml0LXJ1bm5lci1ldmVudHMuanNcIjtcbmltcG9ydCB7IHJlc29sdmVNb2RlbElkIH0gZnJvbSBcIi4uL2F1dG8tbW9kZWwtc2VsZWN0aW9uLmpzXCI7XG5pbXBvcnQgeyByZXNvbHZlUHJvamVjdFJvb3QgfSBmcm9tIFwiLi4vd29ya3RyZWUuanNcIjtcbmltcG9ydCB7IGNsZWFyRGlzY3Vzc2lvbkZsb3dTdGF0ZSB9IGZyb20gXCIuL3dyaXRlLWdhdGUuanNcIjtcbmltcG9ydCB7IHJlc3VtZUF1dG9BZnRlclByb3ZpZGVyRGVsYXkgfSBmcm9tIFwiLi9wcm92aWRlci1lcnJvci1yZXN1bWUuanNcIjtcbmltcG9ydCB7XG4gIGNsYXNzaWZ5RXJyb3IsXG4gIGNyZWF0ZVJldHJ5U3RhdGUsXG4gIHJlc2V0UmV0cnlTdGF0ZSxcbiAgaXNUcmFuc2llbnQsXG4gIHR5cGUgRXJyb3JDbGFzcyxcbn0gZnJvbSBcIi4uL2Vycm9yLWNsYXNzaWZpZXIuanNcIjtcbmltcG9ydCB7IGJsb2NrTW9kZWwsIGlzTW9kZWxCbG9ja2VkIH0gZnJvbSBcIi4uL2Jsb2NrZWQtbW9kZWxzLmpzXCI7XG5cbmNvbnN0IHJldHJ5U3RhdGUgPSBjcmVhdGVSZXRyeVN0YXRlKCk7XG5jb25zdCBNQVhfTkVUV09SS19SRVRSSUVTID0gMjtcblxuZnVuY3Rpb24gaXNPYmplY3RSZWNvcmQodmFsdWU6IHVua25vd24pOiB2YWx1ZSBpcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gIHJldHVybiAhIXZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gXCJvYmplY3RcIjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIF9oYXNFbXB0eUFnZW50RW5kQ29udGVudChjb250ZW50OiB1bmtub3duKTogYm9vbGVhbiB7XG4gIHJldHVybiBjb250ZW50ID09IG51bGwgfHwgKEFycmF5LmlzQXJyYXkoY29udGVudCkgJiYgY29udGVudC5sZW5ndGggPT09IDApO1xufVxuXG4vKipcbiAqIENhcCBvbiBhdXRvLXJlc3VtZSBhdHRlbXB0cyBmb3Igc3VzdGFpbmVkIHRyYW5zaWVudC1wcm92aWRlciBlcnJvcnMuXG4gKlxuICogRXhwb3J0ZWQgc28gdGVzdHMgYXNzZXJ0IGFnYWluc3QgdGhlIHNoYXJlZCBjb25zdGFudCBpbnN0ZWFkIG9mXG4gKiByZWdleC1zY3JhcGluZyB0aGUgc291cmNlIGxpdGVyYWwgKHNlZSAjNDgzNykuIFJhaXNpbmcgdGhpcyB2YWx1ZSB0b1xuICogaGFuZGxlIGxvbmdlciBwcm92aWRlciBvdmVybG9hZHMgc2hvdWxkIHVwZGF0ZSB0aGUgc2luZ2xlIGNvbnN0YW50OyB0aGVcbiAqIHRlc3QgaW4gcHJvdmlkZXItZXJyb3JzLnRlc3QudHMgY29uc3VtZXMgaXQgZGlyZWN0bHkuXG4gKi9cbmV4cG9ydCBjb25zdCBNQVhfVFJBTlNJRU5UX0FVVE9fUkVTVU1FUyA9IDg7XG5cbi8qKlxuICogUmVzZXQgdGhlIG1vZHVsZS1sZXZlbCByZXRyeSBzdGF0ZSBzbyBhIHJlc3VtZWQgYXV0by1zZXNzaW9uIHN0YXJ0cyBmcmVzaC5cbiAqIENhbGxlZCBieSBwcm92aWRlci1lcnJvci1yZXN1bWUudHMgYmVmb3JlIHN0YXJ0QXV0bygpIFx1MjAxNCB3aXRob3V0IHRoaXMsIHRoZVxuICogY29uc2VjdXRpdmVUcmFuc2llbnRDb3VudCBhY2N1bXVsYXRlcyBhY3Jvc3MgcGF1c2UvcmVzdW1lIGN5Y2xlcyBhbmQgbG9ja3NcbiAqIG91dCBhdXRvLXJlc3VtZSBhZnRlciBNQVhfVFJBTlNJRU5UX0FVVE9fUkVTVU1FUyB0b3RhbCAobm90IGNvbnNlY3V0aXZlKSBlcnJvcnMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNldFRyYW5zaWVudFJldHJ5U3RhdGUoKTogdm9pZCB7XG4gIHJlc2V0UmV0cnlTdGF0ZShyZXRyeVN0YXRlKTtcbn1cblxuZnVuY3Rpb24gcmVzb2x2ZUFnZW50RW5kQmFzZVBhdGgoKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gcmVzb2x2ZVByb2plY3RSb290KHByb2Nlc3MuY3dkKCkpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBfYnVpbGRBYm9ydGVkUGF1c2VDb250ZXh0KGxhc3RNc2c6IHsgZXJyb3JNZXNzYWdlPzogdW5rbm93biB9KToge1xuICBtZXNzYWdlOiBzdHJpbmc7XG4gIGNhdGVnb3J5OiBcImFib3J0ZWRcIjtcbiAgaXNUcmFuc2llbnQ6IHRydWU7XG59IHtcbiAgY29uc3QgaGFzRXJyb3JNZXNzYWdlID0gT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKGxhc3RNc2csIFwiZXJyb3JNZXNzYWdlXCIpICYmICEhbGFzdE1zZy5lcnJvck1lc3NhZ2U7XG4gIHJldHVybiB7XG4gICAgbWVzc2FnZTogaGFzRXJyb3JNZXNzYWdlID8gU3RyaW5nKGxhc3RNc2cuZXJyb3JNZXNzYWdlKSA6IFwiT3BlcmF0aW9uIGFib3J0ZWRcIixcbiAgICBjYXRlZ29yeTogXCJhYm9ydGVkXCIsXG4gICAgaXNUcmFuc2llbnQ6IHRydWUsXG4gIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpc1VzZXJJbml0aWF0ZWRBYm9ydE1lc3NhZ2UobWVzc2FnZTogc3RyaW5nIHwgdW5kZWZpbmVkIHwgbnVsbCk6IGJvb2xlYW4ge1xuICBpZiAoIW1lc3NhZ2UpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIC9cXGIoPzpjbGF1ZGUgY29kZSBwcm9jZXNzIGFib3J0ZWQgYnkgdXNlcnxyZXF1ZXN0IGFib3J0ZWQgYnkgdXNlcnxwcm9jZXNzIGFib3J0ZWQgYnkgdXNlcilcXGIvaS50ZXN0KG1lc3NhZ2UpO1xufVxuXG5mdW5jdGlvbiBpc0JhcmVDbGF1ZGVDb2RlU2Vzc2lvblN3aXRjaEFib3J0TWFya2VyKG1lc3NhZ2U6IHN0cmluZyB8IHVuZGVmaW5lZCB8IG51bGwpOiBib29sZWFuIHtcbiAgaWYgKCFtZXNzYWdlKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBtZXNzYWdlLnRyaW0oKS5yZXBsYWNlKC9cXHMrL2csIFwiIFwiKS50b0xvd2VyQ2FzZSgpO1xuICByZXR1cm4gbm9ybWFsaXplZCA9PT0gXCJjbGF1ZGUgY29kZSBwcm9jZXNzIGFib3J0ZWQgYnkgdXNlclwiXG4gICAgfHwgbm9ybWFsaXplZCA9PT0gXCJyZXF1ZXN0IGFib3J0ZWQgYnkgdXNlclwiXG4gICAgfHwgbm9ybWFsaXplZCA9PT0gXCJwcm9jZXNzIGFib3J0ZWQgYnkgdXNlclwiXG4gICAgfHwgbm9ybWFsaXplZCA9PT0gXCJjbGF1ZGUgY29kZSBzdHJlYW0gYWJvcnRlZCBieSBjYWxsZXJcIjtcbn1cblxuZnVuY3Rpb24gcmVhZEFzc2lzdGFudFRleHRDb250ZW50KGNvbnRlbnQ6IHVua25vd24pOiBzdHJpbmcge1xuICBpZiAoIUFycmF5LmlzQXJyYXkoY29udGVudCkpIHJldHVybiBcIlwiO1xuICByZXR1cm4gY29udGVudFxuICAgIC5tYXAoKGJsb2NrKSA9PiB7XG4gICAgICBpZiAoIWJsb2NrIHx8IHR5cGVvZiBibG9jayAhPT0gXCJvYmplY3RcIikgcmV0dXJuIFwiXCI7XG4gICAgICBjb25zdCB0ZXh0ID0gKGJsb2NrIGFzIHsgdGV4dD86IHVua25vd24gfSkudGV4dDtcbiAgICAgIHJldHVybiB0eXBlb2YgdGV4dCA9PT0gXCJzdHJpbmdcIiA/IHRleHQgOiBcIlwiO1xuICAgIH0pXG4gICAgLmZpbHRlcihCb29sZWFuKVxuICAgIC5qb2luKFwiXFxuXCIpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaXNDbGF1ZGVDb2RlU2Vzc2lvblN3aXRjaEFib3J0TWVzc2FnZShsYXN0TXNnOiB1bmtub3duKTogYm9vbGVhbiB7XG4gIGlmICghbGFzdE1zZyB8fCB0eXBlb2YgbGFzdE1zZyAhPT0gXCJvYmplY3RcIikgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBtID0gbGFzdE1zZyBhcyB7IHN0b3BSZWFzb24/OiB1bmtub3duOyBlcnJvck1lc3NhZ2U/OiB1bmtub3duOyBjb250ZW50PzogdW5rbm93biB9O1xuICBjb25zdCBjYXJyaWVycyA9IFtcbiAgICBtLmVycm9yTWVzc2FnZSA/IFN0cmluZyhtLmVycm9yTWVzc2FnZSkgOiBcIlwiLFxuICAgIHJlYWRBc3Npc3RhbnRUZXh0Q29udGVudChtLmNvbnRlbnQpLFxuICBdLmZpbHRlcigodmFsdWUpID0+IHZhbHVlLnRyaW0oKS5sZW5ndGggPiAwKTtcblxuICBpZiAoKG0uc3RvcFJlYXNvbiA9PT0gXCJlcnJvclwiIHx8IG0uc3RvcFJlYXNvbiA9PT0gXCJhYm9ydGVkXCIpICYmIGNhcnJpZXJzLmxlbmd0aCA+IDApIHtcbiAgICByZXR1cm4gY2FycmllcnMuZXZlcnkoaXNCYXJlQ2xhdWRlQ29kZVNlc3Npb25Td2l0Y2hBYm9ydE1hcmtlcik7XG4gIH1cblxuICByZXR1cm4gZmFsc2U7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0JhcmVDbGF1ZGVDb2RlU3RyZWFtQWJvcnRQbGFjZWhvbGRlcihsYXN0TXNnOiB1bmtub3duKTogYm9vbGVhbiB7XG4gIGlmICghbGFzdE1zZyB8fCB0eXBlb2YgbGFzdE1zZyAhPT0gXCJvYmplY3RcIikgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBtID0gbGFzdE1zZyBhcyB7IHN0b3BSZWFzb24/OiB1bmtub3duOyBlcnJvck1lc3NhZ2U/OiB1bmtub3duOyBjb250ZW50PzogdW5rbm93biB9O1xuICBpZiAobS5zdG9wUmVhc29uICE9PSBcImFib3J0ZWRcIiB8fCBtLmVycm9yTWVzc2FnZSkgcmV0dXJuIGZhbHNlO1xuICBjb25zdCB0ZXh0ID0gcmVhZEFzc2lzdGFudFRleHRDb250ZW50KG0uY29udGVudCkudHJpbSgpLnJlcGxhY2UoL1xccysvZywgXCIgXCIpLnRvTG93ZXJDYXNlKCk7XG4gIHJldHVybiB0ZXh0ID09PSBcImNsYXVkZSBjb2RlIHN0cmVhbSBhYm9ydGVkIGJ5IGNhbGxlclwiO1xufVxuXG4vKipcbiAqIFJlc29sdmUgYW4gYWdlbnRfZW5kIGV2ZW50IG9ic2VydmVkIHdoaWxlIGEgc2Vzc2lvbiBzd2l0Y2ggaXMgaW4gZmxpZ2h0LlxuICpcbiAqICM1NTM4LWZvbGxvd3VwOiBXaGVuIGBuZXdTZXNzaW9uKClgIGFib3J0cyBhbiBpbi1mbGlnaHQgc3RyZWFtIGFzIHBhcnQgb2YgYVxuICogc2Vzc2lvbiB0cmFuc2l0aW9uIChydW4tdW5pdC50czo2MyBcdTIxOTIgX3NldHRsZUN1cnJlbnRUdXJuRm9yU2Vzc2lvblRyYW5zaXRpb25cbiAqIFx1MjE5MiBhZ2VudC5hYm9ydCgpKSwgdGhlIFNESyBlbWl0cyBcIkNsYXVkZSBDb2RlIHByb2Nlc3MgYWJvcnRlZCBieSB1c2VyXCIgb3JcbiAqIFwiUmVxdWVzdCBhYm9ydGVkIGJ5IHVzZXJcIiBhZ2FpbnN0IHRoZSBwcmV2aW91cyB1bml0J3MgdHVybi4gVGhlIHByZXZpb3VzXG4gKiBjb2RlIHBhdGggdHJlYXRlZCB0aGF0IGFzIGEgdXNlciBjYW5jZWxsYXRpb24gYW5kIHByb3BhZ2F0ZWQgaXQgdG8gdGhlIG5leHRcbiAqIHVuaXQgdmlhIHRoZSBwZW5kaW5nLXN3aXRjaC1jYW5jZWxsYXRpb24gcXVldWUsIGtpbGxpbmcgYXV0by1tb2RlIHdpdGhcbiAqIFwiQXV0by1tb2RlIHN0b3BwZWQgXHUyMDE0IFVuaXQgYWJvcnRlZDogQ2xhdWRlIENvZGUgcHJvY2VzcyBhYm9ydGVkIGJ5IHVzZXJcIlxuICogZXZlbiB0aG91Z2ggbm8gdXNlciBpbnB1dCBvY2N1cnJlZC5cbiAqXG4gKiBDbGF1ZGUgQ29kZSBhYm9ydCBtYXJrZXJzIGFyZSBpbnRlbnRpb25hbGx5IGlnbm9yZWQgd2hlbiB0aGUgYWJvcnQgZmlyZXNcbiAqIHdoaWxlIHRoZSBzZXNzaW9uLXN3aXRjaCBpcyBpbiBmbGlnaHQ6IHRoZSBhYm9ydCBpcyB0aGUgZXhwZWN0ZWQgc2lkZS1lZmZlY3RcbiAqIG9mIHRoZSB0cmFuc2l0aW9uLCBub3QgYSB1c2VyIHNpZ25hbC4gT3RoZXIgYnJhbmNoZXMgKGdlbnVpbmUgYHN0b3BSZWFzb25cbiAqID09PSBcImFib3J0ZWRcImAgd2l0aCBleHBsaWNpdCBlcnJvck1lc3NhZ2UpIHByZXNlcnZlIHRoZSBwcmlvciBiZWhhdmlvci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIF9oYW5kbGVTZXNzaW9uU3dpdGNoQWdlbnRFbmQoXG4gIGxhc3RNc2c6IHVua25vd24sXG4gIHJlc29sdmVDYW5jZWxsZWQ6IChjdHg6IEVycm9yQ29udGV4dCkgPT4gYm9vbGVhbixcbik6IHZvaWQge1xuICBpZiAoIWxhc3RNc2cgfHwgdHlwZW9mIGxhc3RNc2cgIT09IFwib2JqZWN0XCIpIHJldHVybjtcbiAgY29uc3QgbSA9IGxhc3RNc2cgYXMgeyBzdG9wUmVhc29uPzogdW5rbm93bjsgZXJyb3JNZXNzYWdlPzogdW5rbm93bjsgY29udGVudD86IHVua25vd24gfTtcblxuICBpZiAoaXNDbGF1ZGVDb2RlU2Vzc2lvblN3aXRjaEFib3J0TWVzc2FnZShtKSkge1xuICAgIC8vIEludGVybmFsIGFib3J0IGZyb20gaW4tZmxpZ2h0IHNlc3Npb24gdHJhbnNpdGlvbiBcdTIwMTQgZHJvcCBvbiB0aGUgZmxvb3IuXG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKG0uc3RvcFJlYXNvbiA9PT0gXCJlcnJvclwiKSB7XG4gICAgY29uc3QgcmF3RXJyb3JNc2cgPSBtLmVycm9yTWVzc2FnZSA/IFN0cmluZyhtLmVycm9yTWVzc2FnZSkgOiBcIlwiO1xuICAgIGlmIChpc0JhcmVDbGF1ZGVDb2RlU2Vzc2lvblN3aXRjaEFib3J0TWFya2VyKHJhd0Vycm9yTXNnKSkge1xuICAgICAgLy8gSW50ZXJuYWwgYWJvcnQgZnJvbSBpbi1mbGlnaHQgc2Vzc2lvbiB0cmFuc2l0aW9uIFx1MjAxNCBkcm9wIG9uIHRoZSBmbG9vci5cbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKG0uc3RvcFJlYXNvbiA9PT0gXCJhYm9ydGVkXCIpIHtcbiAgICBjb25zdCBoYXNFcnJvck1lc3NhZ2UgPSAhIW0uZXJyb3JNZXNzYWdlO1xuICAgIGlmIChoYXNFcnJvck1lc3NhZ2UpIHtcbiAgICAgIHJlc29sdmVDYW5jZWxsZWQoX2J1aWxkQWJvcnRlZFBhdXNlQ29udGV4dChtIGFzIHsgZXJyb3JNZXNzYWdlPzogdW5rbm93biB9KSk7XG4gICAgfVxuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlQWdlbnRFbmRFcnJvckRpc3BsYXkoXG4gIHJhd0Vycm9yTXNnOiBzdHJpbmcsXG4gIGNvbnRlbnQ6IHVua25vd24sXG4pOiBzdHJpbmcge1xuICBjb25zdCBpc1VzZWxlc3MgPSAhcmF3RXJyb3JNc2cgfHwgL14oc3VjY2Vzc3xva3x0cnVlfGVycm9yfHVua25vd24pJC9pLnRlc3QocmF3RXJyb3JNc2cudHJpbSgpKTtcbiAgaWYgKGlzVXNlbGVzcyAmJiBBcnJheS5pc0FycmF5KGNvbnRlbnQpKSB7XG4gICAgY29uc3QgdGV4dEJsb2NrID0gY29udGVudC5maW5kKChiOiBhbnkpID0+IGIudHlwZSA9PT0gXCJ0ZXh0XCIgJiYgYi50ZXh0KTtcbiAgICBpZiAodGV4dEJsb2NrKSByZXR1cm4gKHRleHRCbG9jayBhcyBhbnkpLnRleHQuc2xpY2UoMCwgMzAwKTtcbiAgfVxuICByZXR1cm4gcmF3RXJyb3JNc2c7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHBhdXNlVHJhbnNpZW50V2l0aEJhY2tvZmYoXG4gIGNsczogRXJyb3JDbGFzcyxcbiAgcGk6IEV4dGVuc2lvbkFQSSxcbiAgY3R4OiBFeHRlbnNpb25Db250ZXh0LFxuICBlcnJvckRldGFpbDogc3RyaW5nLFxuICBpc1JhdGVMaW1pdDogYm9vbGVhbixcbik6IFByb21pc2U8dm9pZD4ge1xuICByZXRyeVN0YXRlLmNvbnNlY3V0aXZlVHJhbnNpZW50Q291bnQgKz0gMTtcbiAgY29uc3QgYmFzZVJldHJ5QWZ0ZXJNcyA9IFwicmV0cnlBZnRlck1zXCIgaW4gY2xzID8gY2xzLnJldHJ5QWZ0ZXJNcyA6IDE1XzAwMDtcbiAgY29uc3QgcmV0cnlBZnRlck1zID0gYmFzZVJldHJ5QWZ0ZXJNcyAqIDIgKiogTWF0aC5tYXgoMCwgcmV0cnlTdGF0ZS5jb25zZWN1dGl2ZVRyYW5zaWVudENvdW50IC0gMSk7XG4gIGNvbnN0IGFsbG93QXV0b1Jlc3VtZSA9IHJldHJ5U3RhdGUuY29uc2VjdXRpdmVUcmFuc2llbnRDb3VudCA8PSBNQVhfVFJBTlNJRU5UX0FVVE9fUkVTVU1FUztcbiAgaWYgKCFhbGxvd0F1dG9SZXN1bWUpIHtcbiAgICBjdHgudWkubm90aWZ5KGBUcmFuc2llbnQgcHJvdmlkZXIgZXJyb3JzIHBlcnNpc3RlZCBhZnRlciAke01BWF9UUkFOU0lFTlRfQVVUT19SRVNVTUVTfSBhdXRvLXJlc3VtZSBhdHRlbXB0cy4gUGF1c2luZyBmb3IgbWFudWFsIHJldmlldy5gLCBcIndhcm5pbmdcIik7XG4gIH1cbiAgYXdhaXQgcGF1c2VBdXRvRm9yUHJvdmlkZXJFcnJvcihjdHgudWksIGVycm9yRGV0YWlsLCAoKSA9PiBwYXVzZUF1dG8oY3R4LCBwaSwge1xuICAgIG1lc3NhZ2U6IGBQcm92aWRlciBlcnJvcjogJHtlcnJvckRldGFpbH1gLFxuICAgIGNhdGVnb3J5OiBcInByb3ZpZGVyXCIsXG4gICAgaXNUcmFuc2llbnQ6IGFsbG93QXV0b1Jlc3VtZSxcbiAgICByZXRyeUFmdGVyTXMsXG4gIH0pLCB7XG4gICAgaXNSYXRlTGltaXQsXG4gICAgaXNUcmFuc2llbnQ6IGFsbG93QXV0b1Jlc3VtZSxcbiAgICByZXRyeUFmdGVyTXMsXG4gICAgcmVzdW1lOiBhbGxvd0F1dG9SZXN1bWVcbiAgICAgID8gKCkgPT4ge1xuICAgICAgICB2b2lkIHJlc3VtZUF1dG9BZnRlclByb3ZpZGVyRGVsYXkocGksIGN0eCkuY2F0Y2goKGVycikgPT4ge1xuICAgICAgICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgICAgICAgY3R4LnVpLm5vdGlmeShgUHJvdmlkZXIgZXJyb3IgcmVjb3ZlcnkgZGVsYXkgZWxhcHNlZCwgYnV0IGF1dG8tbW9kZSBmYWlsZWQgdG8gcmVzdW1lOiAke21lc3NhZ2V9YCwgXCJlcnJvclwiKTtcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgICA6IHVuZGVmaW5lZCxcbiAgfSk7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBoYW5kbGVBZ2VudEVuZChcbiAgcGk6IEV4dGVuc2lvbkFQSSxcbiAgZXZlbnQ6IEFnZW50RW5kRXZlbnQsXG4gIGN0eDogRXh0ZW5zaW9uQ29udGV4dCxcbik6IFByb21pc2U8dm9pZD4ge1xuICAvLyAjNDY0OCBcdTIwMTQgSW52YWxpZGF0ZSB0aGUgZGlyZWN0b3J5LWxpc3RpbmcgY2FjaGUgYmVmb3JlIGFueSBhcnRpZmFjdC1leGlzdGVuY2VcbiAgLy8gY2hlY2tzLiBUaGUgTExNIG1heSBoYXZlIHdyaXR0ZW4gbWlsZXN0b25lIGZpbGVzIChDT05URVhULm1kLCBST0FETUFQLm1kLFxuICAvLyBQUk9KRUNULm1kLCBSRVFVSVJFTUVOVFMubWQpIHZpYSB0b29sIGNhbGxzIGR1cmluZyB0aGUgdHVybiB0aGF0IGp1c3RcbiAgLy8gZW5kZWQuIGBwYXRocy50c2AgY2FjaGVzIHJlYWRkaXIoKSByZXN1bHRzIHdpdGhvdXQgYSBUVEwsIHNvIHdpdGhvdXQgdGhpc1xuICAvLyBmbHVzaCwgYHJlc29sdmVNaWxlc3RvbmVGaWxlYCByZXR1cm5zIHRoZSBwcmUtd3JpdGUgbGlzdGluZyBhbmQgdGhlIGd1YXJkc1xuICAvLyBiZWxvdyAoYGNoZWNrQXV0b1N0YXJ0QWZ0ZXJEaXNjdXNzYCBhbmQgYG1heWJlSGFuZGxlUmVhZHlQaHJhc2VXaXRob3V0RmlsZXNgKVxuICAvLyBmYWxzZWx5IHJlcG9ydCBmaWxlcyBhcyBtaXNzaW5nIFx1MjAxNCBwcm9kdWNpbmcgYSBzcHVyaW91cyBcInJlYWR5IHNpZ25hbFxuICAvLyByZWplY3RlZFwiIGxvb3AgZXZlbiB0aG91Z2ggdGhlIGZpbGVzIGFyZSBvbiBkaXNrLlxuICBjbGVhclBhdGhDYWNoZSgpO1xuXG4gIHRyeSB7XG4gICAgaWYgKGF3YWl0IGNoZWNrRGVlcFByb2plY3RTZXR1cEFmdGVyVHVybihldmVudCwgY3R4LCByZXNvbHZlQWdlbnRFbmRCYXNlUGF0aCgpKSkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICBsb2dXYXJuaW5nKFwiYm9vdHN0cmFwXCIsIGBjaGVja0RlZXBQcm9qZWN0U2V0dXBBZnRlclR1cm4gZmFpbGVkOiAke21lc3NhZ2V9YCk7XG4gIH1cblxuICBpZiAoY2hlY2tBdXRvU3RhcnRBZnRlckRpc2N1c3MoKSkge1xuICAgIGNsZWFyRGlzY3Vzc2lvbkZsb3dTdGF0ZShyZXNvbHZlQWdlbnRFbmRCYXNlUGF0aCgpID8/IHByb2Nlc3MuY3dkKCkpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vICM0NTczIFx1MjAxNCBXaGVuIHRoZSBMTE0gZW1pdHMgXCJNaWxlc3RvbmUgWCByZWFkeS5cIiBidXQgdGhlIHJlcXVpcmVkIGZpbGVzXG4gIC8vIGFyZSBtaXNzaW5nLCBgY2hlY2tBdXRvU3RhcnRBZnRlckRpc2N1c3NgIHJldHVybnMgZmFsc2Ugc2lsZW50bHkuIFN1cmZhY2VcbiAgLy8gdGhhdCBhbmQgbnVkZ2UgdGhlIExMTSB0byBjb21wbGV0ZSB0aGUgd3JpdGVzIGJlZm9yZSB0aGUgdXNlciBoaXRzIHRoZVxuICAvLyBkb3duc3RyZWFtIFwiQWxsIG1pbGVzdG9uZXMgY29tcGxldGVcIiB3YXJuaW5nIGxvb3AuXG4gIGlmIChtYXliZUhhbmRsZVJlYWR5UGhyYXNlV2l0aG91dEZpbGVzKGV2ZW50KSkgcmV0dXJuO1xuXG4gIC8vICM0NTczIFx1MjAxNCBFbXB0eS10dXJuIHJlY292ZXJ5OiBpZiB0aGUgTExNIGFubm91bmNlZCBpbnRlbnQgaW4gcHJvc2UgYnV0XG4gIC8vIGVtaXR0ZWQgbm8gdG9vbCBjYWxscywgbnVkZ2UgaXQgdG8gZXhlY3V0ZS4gRmlyZXMgb25seSB3aGVuIGF1dG8tbW9kZSBpc1xuICAvLyBhY3RpdmUgb3IgYSBkaXNjdXNzaW9uIGF1dG9zdGFydCBpcyBwZW5kaW5nIChub24tYXV0byBpbnRlcmFjdGl2ZSBkaXNjdXNzXG4gIC8vIGlzIHVzZXItZHJpdmVuKS4gUnVucyBiZWZvcmUgYGlzQXV0b0FjdGl2ZWAgZWFybHkgcmV0dXJuIHNvIHBlbmRpbmdcbiAgLy8gZGlzY3Vzc2lvbnMgKHdoZXJlIGlzQXV0b0FjdGl2ZSBtYXkgYmUgZmFsc2UpIHN0aWxsIGdldCByZWNvdmVyZWQuXG4gIGlmIChtYXliZUhhbmRsZUVtcHR5SW50ZW50VHVybihldmVudCwgaXNBdXRvQWN0aXZlKCkpKSByZXR1cm47XG5cbiAgaWYgKCFpc0F1dG9BY3RpdmUoKSkgcmV0dXJuO1xuXG4gIGlmIChzaG91bGRJZ25vcmVBZ2VudEVuZEZvckFjdGl2ZVVuaXQoZXZlbnQpKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgbGFzdE1zZyA9IGV2ZW50Lm1lc3NhZ2VzW2V2ZW50Lm1lc3NhZ2VzLmxlbmd0aCAtIDFdO1xuICBpZiAoaXNTZXNzaW9uU3dpdGNoSW5GbGlnaHQoKSkge1xuICAgIF9oYW5kbGVTZXNzaW9uU3dpdGNoQWdlbnRFbmQobGFzdE1zZywgcmVzb2x2ZUFnZW50RW5kQ2FuY2VsbGVkKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAoaXNTZXNzaW9uU3dpdGNoQWJvcnRHcmFjZUFjdGl2ZSgpICYmIGlzQ2xhdWRlQ29kZVNlc3Npb25Td2l0Y2hBYm9ydE1lc3NhZ2UobGFzdE1zZykpIHtcbiAgICAvLyBDbGF1ZGUgQ29kZSBjYW4gcmVwb3J0IHRoZSBhYm9ydCBmcm9tIGBuZXdTZXNzaW9uKClgIGEgZmV3IGh1bmRyZWQgbXNcbiAgICAvLyBhZnRlciB0aGUgZ3VhcmQgZHJvcHMuIFRoYXQgZXZlbnQgYmVsb25ncyB0byB0aGUgb2xkIHR1cm47IGRvIG5vdCBsZXQgaXRcbiAgICAvLyBjYW5jZWwgdGhlIGZyZXNobHktZGlzcGF0Y2hlZCB1bml0LlxuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmIChpc0JhcmVDbGF1ZGVDb2RlU3RyZWFtQWJvcnRQbGFjZWhvbGRlcihsYXN0TXNnKSkge1xuICAgIC8vIFRoZSBDbGF1ZGUgQ29kZSBhZGFwdGVyIGNhbiBlbWl0IHRoaXMgcGxhY2Vob2xkZXIgYWZ0ZXIgYSBwcmlvciB0dXJuIGhhc1xuICAgIC8vIGFscmVhZHkgY29tcGxldGVkIGFuZCB0aGUgbmV4dCB1bml0IGlzIGFjdGl2ZS4gSXQgaGFzIG5vIHVzZXIvcHJvdmlkZXJcbiAgICAvLyBkaWFnbm9zdGljIHZhbHVlIGFuZCBtdXN0IG5vdCBjYW5jZWwgdGhlIG5ld2x5LWRpc3BhdGNoZWQgdW5pdC5cbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAoaXNPYmplY3RSZWNvcmQobGFzdE1zZykgJiYgXCJzdG9wUmVhc29uXCIgaW4gbGFzdE1zZyAmJiBsYXN0TXNnLnN0b3BSZWFzb24gPT09IFwiYWJvcnRlZFwiKSB7XG4gICAgaWYgKGlzQXV0b0NvbXBsZXRpb25TdG9wSW5Qcm9ncmVzcygpKSB7XG4gICAgICByZXNldFJldHJ5U3RhdGUocmV0cnlTdGF0ZSk7XG4gICAgICByZXNvbHZlQWdlbnRFbmQoZXZlbnQpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIEVtcHR5IGNvbnRlbnQgd2l0aCBhYm9ydGVkIHN0b3BSZWFzb24gaXMgYSBub24tZmF0YWwgYWdlbnQgc3RvcCAodGhlIExMTVxuICAgIC8vIGNob3NlIHRvIGVuZCB3aXRob3V0IHByb2R1Y2luZyBvdXRwdXQpLiBPbmx5IHBhdXNlIG9uIGdlbnVpbmUgZmF0YWwgYWJvcnRzXG4gICAgLy8gdGhhdCBjYXJyeSBlcnJvciBjb250ZXh0IFx1MjAxNCBlLmcuIGVycm9yTWVzc2FnZSBmaWVsZCBvciBub24tZW1wdHkgY29udGVudFxuICAgIC8vIGluZGljYXRpbmcgYSBtaWQtc3RyZWFtIGZhaWx1cmUuICgjMjY5NSlcbiAgICBjb25zdCBjb250ZW50ID0gXCJjb250ZW50XCIgaW4gbGFzdE1zZyA/IGxhc3RNc2cuY29udGVudCA6IHVuZGVmaW5lZDtcbiAgICBjb25zdCBoYXNFbXB0eUNvbnRlbnQgPSBfaGFzRW1wdHlBZ2VudEVuZENvbnRlbnQoY29udGVudCk7XG4gICAgY29uc3QgaGFzRXJyb3JNZXNzYWdlID0gXCJlcnJvck1lc3NhZ2VcIiBpbiBsYXN0TXNnICYmICEhbGFzdE1zZy5lcnJvck1lc3NhZ2U7XG5cbiAgICBpZiAoaGFzRW1wdHlDb250ZW50ICYmICFoYXNFcnJvck1lc3NhZ2UpIHtcbiAgICAgIC8vIE5vbi1mYXRhbDogdHJlYXQgYXMgYSBub3JtYWwgYWdlbnQgZW5kIHNvIHRoZSBsb29wIGNhbiBjb250aW51ZVxuICAgICAgLy8gaW5zdGVhZCBvZiBlbnRlcmluZyBhIHN0dWNrIHJlLWRpc3BhdGNoIGN5Y2xlLlxuICAgICAgdHJ5IHtcbiAgICAgICAgcmVzZXRSZXRyeVN0YXRlKHJldHJ5U3RhdGUpO1xuICAgICAgICByZXNvbHZlQWdlbnRFbmQoZXZlbnQpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgICAgIGN0eC51aS5ub3RpZnkoYEF1dG8tbW9kZSBlcnJvciBhZnRlciBlbXB0eS1jb250ZW50IGFib3J0OiAke21lc3NhZ2V9LiBTdG9wcGluZyBhdXRvLW1vZGUuYCwgXCJlcnJvclwiKTtcbiAgICAgICAgdHJ5IHsgYXdhaXQgcGF1c2VBdXRvKGN0eCwgcGkpOyB9IGNhdGNoIChlKSB7IGxvZ1dhcm5pbmcoXCJib290c3RyYXBcIiwgYHBhdXNlQXV0byBmYWlsZWQgYWZ0ZXIgZW1wdHktY29udGVudCBhYm9ydDogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gKTsgfVxuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGF3YWl0IHBhdXNlQXV0byhjdHgsIHBpLCBfYnVpbGRBYm9ydGVkUGF1c2VDb250ZXh0KGxhc3RNc2cgYXMgeyBlcnJvck1lc3NhZ2U/OiB1bmtub3duIH0pKTtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKGlzT2JqZWN0UmVjb3JkKGxhc3RNc2cpICYmIFwic3RvcFJlYXNvblwiIGluIGxhc3RNc2cgJiYgbGFzdE1zZy5zdG9wUmVhc29uID09PSBcImVycm9yXCIpIHtcbiAgICAvLyAjMzU4ODogZXJyb3JNZXNzYWdlIGNhbiBiZSB1c2VsZXNzIChlLmcuIFwic3VjY2Vzc1wiKSB3aGlsZSB0aGUgcmVhbCBlcnJvclxuICAgIC8vIGlzIGluIHRoZSBhc3Npc3RhbnQgbWVzc2FnZSB0ZXh0IGNvbnRlbnQuIEZhbGwgYmFjayB0byBjb250ZW50IHdoZW5cbiAgICAvLyBlcnJvck1lc3NhZ2UgbG9va3MgdW5pbmZvcm1hdGl2ZS5cbiAgICBjb25zdCByYXdFcnJvck1zZyA9IChcImVycm9yTWVzc2FnZVwiIGluIGxhc3RNc2cgJiYgbGFzdE1zZy5lcnJvck1lc3NhZ2UpID8gU3RyaW5nKGxhc3RNc2cuZXJyb3JNZXNzYWdlKSA6IFwiXCI7XG4gICAgaWYgKGlzVXNlckluaXRpYXRlZEFib3J0TWVzc2FnZShyYXdFcnJvck1zZykpIHtcbiAgICAgIGlmIChpc0F1dG9Db21wbGV0aW9uU3RvcEluUHJvZ3Jlc3MoKSkge1xuICAgICAgICByZXNldFJldHJ5U3RhdGUocmV0cnlTdGF0ZSk7XG4gICAgICAgIHJlc29sdmVBZ2VudEVuZChldmVudCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHJlc29sdmVBZ2VudEVuZENhbmNlbGxlZCh7XG4gICAgICAgIG1lc3NhZ2U6IHJhd0Vycm9yTXNnLFxuICAgICAgICBjYXRlZ29yeTogXCJhYm9ydGVkXCIsXG4gICAgICAgIGlzVHJhbnNpZW50OiBmYWxzZSxcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICAvLyAjMzU4ODogV2hlbiBlcnJvck1lc3NhZ2UgaXMgdW5pbmZvcm1hdGl2ZSwgZXh0cmFjdCB0aGUgcmVhbCBlcnJvciBmcm9tXG4gICAgLy8gdGhlIGFzc2lzdGFudCBtZXNzYWdlIHRleHQgY29udGVudCBmb3IgZGlzcGxheSBwdXJwb3NlcyBvbmx5LlxuICAgIC8vIENsYXNzaWZpY2F0aW9uIHN0aWxsIHVzZXMgcmF3RXJyb3JNc2cgdG8gYXZvaWQgZmFsc2UgcG9zaXRpdmVzIGZyb20gcHJvc2UuXG4gICAgY29uc3QgZGlzcGxheU1zZyA9IHJlc29sdmVBZ2VudEVuZEVycm9yRGlzcGxheShcbiAgICAgIHJhd0Vycm9yTXNnLFxuICAgICAgXCJjb250ZW50XCIgaW4gbGFzdE1zZyA/IGxhc3RNc2cuY29udGVudCA6IHVuZGVmaW5lZCxcbiAgICApO1xuICAgIGNvbnN0IGVycm9yRGV0YWlsID0gZGlzcGxheU1zZyA/IGA6ICR7ZGlzcGxheU1zZ31gIDogXCJcIjtcbiAgICBjb25zdCBleHBsaWNpdFJldHJ5QWZ0ZXJNcyA9IChcInJldHJ5QWZ0ZXJNc1wiIGluIGxhc3RNc2cgJiYgdHlwZW9mIGxhc3RNc2cucmV0cnlBZnRlck1zID09PSBcIm51bWJlclwiKSA/IGxhc3RNc2cucmV0cnlBZnRlck1zIDogdW5kZWZpbmVkO1xuXG4gICAgLy8gXHUyNTAwXHUyNTAwIDEuIENsYXNzaWZ5IHVzaW5nIHJhd0Vycm9yTXNnIHRvIGF2b2lkIHByb3NlIGZhbHNlLXBvc2l0aXZlcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgICBjb25zdCBjbHMgPSBjbGFzc2lmeUVycm9yKHJhd0Vycm9yTXNnLCBleHBsaWNpdFJldHJ5QWZ0ZXJNcyk7XG5cbiAgICAvLyBcdTI1MDBcdTI1MDAgMWEuIFVuc3VwcG9ydGVkLW1vZGVsOiBwcm92aWRlciByZWplY3RlZCB0aGlzIG1vZGVsIGZvciB0aGUgY3VycmVudFxuICAgIC8vICAgICAgICBhY2NvdW50L3BsYW4gYXQgcmVxdWVzdCB0aW1lICgjNDUxMykuICBQZXJzaXN0IGEgYmxvY2sgc28gdGhlXG4gICAgLy8gICAgICAgIHNhbWUgZGVhZCBtb2RlbCBpc24ndCByZXNlbGVjdGVkIG9uIHRoZSBuZXh0IC9nc2QgYXV0byByZXN0YXJ0LFxuICAgIC8vICAgICAgICB0aGVuIHRyeSBhIGZhbGxiYWNrIGJlZm9yZSBwYXVzaW5nLlxuICAgIGlmIChjbHMua2luZCA9PT0gXCJ1bnN1cHBvcnRlZC1tb2RlbFwiKSB7XG4gICAgICBjb25zdCBkYXNoID0gZ2V0QXV0b0Rhc2hib2FyZERhdGEoKTtcbiAgICAgIGNvbnN0IHJlamVjdGVkUHJvdmlkZXIgPSBjdHgubW9kZWw/LnByb3ZpZGVyO1xuICAgICAgY29uc3QgcmVqZWN0ZWRJZCA9IGN0eC5tb2RlbD8uaWQ7XG4gICAgICBpZiAoZGFzaC5iYXNlUGF0aCAmJiByZWplY3RlZFByb3ZpZGVyICYmIHJlamVjdGVkSWQpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBibG9ja01vZGVsKGRhc2guYmFzZVBhdGgsIHJlamVjdGVkUHJvdmlkZXIsIHJlamVjdGVkSWQsIHJhd0Vycm9yTXNnIHx8IFwidW5zdXBwb3J0ZWQgZm9yIGFjY291bnRcIik7XG4gICAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICAgIGBCbG9ja2VkICR7cmVqZWN0ZWRQcm92aWRlcn0vJHtyZWplY3RlZElkfSBmb3IgdGhpcyBwcm9qZWN0IFx1MjAxNCBwcm92aWRlciByZWplY3RlZCBpdCBmb3IgdGhlIGN1cnJlbnQgYWNjb3VudC5gLFxuICAgICAgICAgICAgXCJ3YXJuaW5nXCIsXG4gICAgICAgICAgKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgY29uc3QgbSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICAgICAgICBsb2dXYXJuaW5nKFwiYm9vdHN0cmFwXCIsIGBGYWlsZWQgdG8gcGVyc2lzdCBibG9ja2VkIG1vZGVsOiAke219YCk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gVHJ5IGNvbmZpZ3VyZWQgZmFsbGJhY2sgY2hhaW4sIHNraXBwaW5nIGFueXRoaW5nIGFscmVhZHkgYmxvY2tlZC5cbiAgICAgIGlmIChkYXNoLmN1cnJlbnRVbml0ICYmIGRhc2guYmFzZVBhdGgpIHtcbiAgICAgICAgY29uc3QgbW9kZWxDb25maWcgPSByZXNvbHZlTW9kZWxXaXRoRmFsbGJhY2tzRm9yVW5pdChkYXNoLmN1cnJlbnRVbml0LnR5cGUpO1xuICAgICAgICBpZiAobW9kZWxDb25maWcgJiYgbW9kZWxDb25maWcuZmFsbGJhY2tzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICBjb25zdCBhdmFpbGFibGVNb2RlbHMgPSBjdHgubW9kZWxSZWdpc3RyeS5nZXRBdmFpbGFibGUoKTtcbiAgICAgICAgICBsZXQgY3Vyc29yTW9kZWxJZDogc3RyaW5nIHwgdW5kZWZpbmVkID0gY3R4Lm1vZGVsPy5pZDtcbiAgICAgICAgICB3aGlsZSAodHJ1ZSkge1xuICAgICAgICAgICAgY29uc3QgbmV4dE1vZGVsSWQgPSBnZXROZXh0RmFsbGJhY2tNb2RlbChjdXJzb3JNb2RlbElkLCBtb2RlbENvbmZpZyk7XG4gICAgICAgICAgICBpZiAoIW5leHRNb2RlbElkKSBicmVhaztcbiAgICAgICAgICAgIGNvbnN0IGNhbmRpZGF0ZSA9IHJlc29sdmVNb2RlbElkKG5leHRNb2RlbElkLCBhdmFpbGFibGVNb2RlbHMsIGN0eC5tb2RlbD8ucHJvdmlkZXIpO1xuICAgICAgICAgICAgaWYgKGNhbmRpZGF0ZSAmJiAhaXNNb2RlbEJsb2NrZWQoZGFzaC5iYXNlUGF0aCwgY2FuZGlkYXRlLnByb3ZpZGVyLCBjYW5kaWRhdGUuaWQpKSB7XG4gICAgICAgICAgICAgIGNvbnN0IG9rID0gYXdhaXQgcGkuc2V0TW9kZWwoY2FuZGlkYXRlLCB7IHBlcnNpc3Q6IGZhbHNlIH0pO1xuICAgICAgICAgICAgICBpZiAob2spIHtcbiAgICAgICAgICAgICAgICBzZXRDdXJyZW50RGlzcGF0Y2hlZE1vZGVsSWQoeyBwcm92aWRlcjogY2FuZGlkYXRlLnByb3ZpZGVyLCBpZDogY2FuZGlkYXRlLmlkIH0pO1xuICAgICAgICAgICAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgICAgICAgICAgICBgU3dpdGNoZWQgdG8gZmFsbGJhY2sgJHtjYW5kaWRhdGUucHJvdmlkZXJ9LyR7Y2FuZGlkYXRlLmlkfSBhZnRlciBhY2NvdW50IGVudGl0bGVtZW50IHJlamVjdGlvbi5gLFxuICAgICAgICAgICAgICAgICAgXCJ3YXJuaW5nXCIsXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICBwaS5zZW5kTWVzc2FnZShcbiAgICAgICAgICAgICAgICAgIHsgY3VzdG9tVHlwZTogXCJnc2QtYXV0by10aW1lb3V0LXJlY292ZXJ5XCIsIGNvbnRlbnQ6IFwiQ29udGludWUgZXhlY3V0aW9uLlwiLCBkaXNwbGF5OiBmYWxzZSB9LFxuICAgICAgICAgICAgICAgICAgeyB0cmlnZ2VyVHVybjogdHJ1ZSB9LFxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjdXJzb3JNb2RlbElkID0gbmV4dE1vZGVsSWQ7XG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gRmFsbGJhY2sgY2hhaW4gZXhoYXVzdGVkIFx1MjAxNCB0cnkgdGhlIGF1dG8tbW9kZSBzdGFydCBtb2RlbCBpZiBpdCBpc24ndFxuICAgICAgICAvLyB0aGUgc2FtZSBvbmUgd2UganVzdCBibG9ja2VkIGFuZCBpc24ndCBpdHNlbGYgYmxvY2tlZC5cbiAgICAgICAgY29uc3Qgc2Vzc2lvbk1vZGVsID0gZ2V0QXV0b01vZGVTdGFydE1vZGVsKCk7XG4gICAgICAgIGlmIChcbiAgICAgICAgICBzZXNzaW9uTW9kZWwgJiZcbiAgICAgICAgICAhKHNlc3Npb25Nb2RlbC5wcm92aWRlciA9PT0gcmVqZWN0ZWRQcm92aWRlciAmJiBzZXNzaW9uTW9kZWwuaWQgPT09IHJlamVjdGVkSWQpICYmXG4gICAgICAgICAgIWlzTW9kZWxCbG9ja2VkKGRhc2guYmFzZVBhdGgsIHNlc3Npb25Nb2RlbC5wcm92aWRlciwgc2Vzc2lvbk1vZGVsLmlkKVxuICAgICAgICApIHtcbiAgICAgICAgICBjb25zdCBzdGFydE1vZGVsID0gY3R4Lm1vZGVsUmVnaXN0cnlcbiAgICAgICAgICAgIC5nZXRBdmFpbGFibGUoKVxuICAgICAgICAgICAgLmZpbmQoKG0pID0+IG0ucHJvdmlkZXIgPT09IHNlc3Npb25Nb2RlbC5wcm92aWRlciAmJiBtLmlkID09PSBzZXNzaW9uTW9kZWwuaWQpO1xuICAgICAgICAgIGlmIChzdGFydE1vZGVsKSB7XG4gICAgICAgICAgICBjb25zdCBvayA9IGF3YWl0IHBpLnNldE1vZGVsKHN0YXJ0TW9kZWwsIHsgcGVyc2lzdDogZmFsc2UgfSk7XG4gICAgICAgICAgICBpZiAob2spIHtcbiAgICAgICAgICAgICAgc2V0Q3VycmVudERpc3BhdGNoZWRNb2RlbElkKHsgcHJvdmlkZXI6IHN0YXJ0TW9kZWwucHJvdmlkZXIsIGlkOiBzdGFydE1vZGVsLmlkIH0pO1xuICAgICAgICAgICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICAgICAgICAgIGBSZXN0b3JlZCBhdXRvLW1vZGUgc3RhcnQgbW9kZWwgJHtzdGFydE1vZGVsLnByb3ZpZGVyfS8ke3N0YXJ0TW9kZWwuaWR9IGFmdGVyIGVudGl0bGVtZW50IHJlamVjdGlvbi5gLFxuICAgICAgICAgICAgICAgIFwid2FybmluZ1wiLFxuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICBwaS5zZW5kTWVzc2FnZShcbiAgICAgICAgICAgICAgICB7IGN1c3RvbVR5cGU6IFwiZ3NkLWF1dG8tdGltZW91dC1yZWNvdmVyeVwiLCBjb250ZW50OiBcIkNvbnRpbnVlIGV4ZWN1dGlvbi5cIiwgZGlzcGxheTogZmFsc2UgfSxcbiAgICAgICAgICAgICAgICB7IHRyaWdnZXJUdXJuOiB0cnVlIH0sXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gTm8gdXNhYmxlIGZhbGxiYWNrIFx1MjAxNCBwYXVzZSB3aXRoIGEgY2xlYXJseSBuYW1lZCBtZXNzYWdlLlxuICAgICAgY29uc3QgYmxvY2tlZExhYmVsID0gcmVqZWN0ZWRQcm92aWRlciAmJiByZWplY3RlZElkID8gYCR7cmVqZWN0ZWRQcm92aWRlcn0vJHtyZWplY3RlZElkfWAgOiBcImN1cnJlbnQgbW9kZWxcIjtcbiAgICAgIGNvbnN0IHBhdXNlRGV0YWlsID0gYE1vZGVsICR7YmxvY2tlZExhYmVsfSBibG9ja2VkIGZvciB0aGlzIGFjY291bnQke2Vycm9yRGV0YWlsfS4gQ29uZmlndXJlIGEgZGlmZmVyZW50IG1vZGVsIGFuZCByZXN0YXJ0IC9nc2QgYXV0by5gO1xuICAgICAgYXdhaXQgcGF1c2VBdXRvRm9yUHJvdmlkZXJFcnJvcihjdHgudWksIHBhdXNlRGV0YWlsLCAoKSA9PlxuICAgICAgICBwYXVzZUF1dG8oY3R4LCBwaSwge1xuICAgICAgICAgIG1lc3NhZ2U6IHBhdXNlRGV0YWlsLFxuICAgICAgICAgIGNhdGVnb3J5OiBcInByb3ZpZGVyXCIsXG4gICAgICAgICAgaXNUcmFuc2llbnQ6IGZhbHNlLFxuICAgICAgICB9KSxcbiAgICAgIHtcbiAgICAgICAgaXNSYXRlTGltaXQ6IGZhbHNlLFxuICAgICAgICBpc1RyYW5zaWVudDogZmFsc2UsXG4gICAgICAgIHJldHJ5QWZ0ZXJNczogMCxcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIFx1MjUwMFx1MjUwMCAxYi4gRGVmZXIgdG8gQ29yZSBSZXRyeUhhbmRsZXIgZm9yIG1vc3QgdHJhbnNpZW50IGVycm9ycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgICAvLyBDb3JlIHJldHJpZXMgdHJhbnNpZW50IGZhaWx1cmVzIGluLXNlc3Npb24gYWZ0ZXIgdGhpcyBoYW5kbGVyLlxuICAgIC8vIEtlZXAgdGhhdCBiZWhhdmlvciBmb3Igbm9uLXJhdGUtbGltaXQgY2xhc3NlcyB0byBhdm9pZCBwYXVzZS9yZXRyeSByYWNlcyxcbiAgICAvLyBidXQgbGV0IHJhdGUtbGltaXQgY29udGludWUgaW50byBtb2RlbCBmYWxsYmFjayBsb2dpYyBiZWxvdyAoIzQzNzMpLlxuICAgIGlmIChpc1RyYW5zaWVudChjbHMpICYmIGNscy5raW5kICE9PSBcInJhdGUtbGltaXRcIikge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIENhcCByYXRlLWxpbWl0IGJhY2tvZmYgZm9yIENMSS1zdHlsZSBwcm92aWRlcnMgKG9wZW5haS1jb2RleCwgZ29vZ2xlLWdlbWluaS1jbGkpXG4gICAgLy8gd2hpY2ggdXNlIHBlci11c2VyIHF1b3RhcyB3aXRoIHNob3J0ZXIgd2luZG93cyAoIzI5MjIpLlxuICAgIGlmIChjbHMua2luZCA9PT0gXCJyYXRlLWxpbWl0XCIpIHtcbiAgICAgIGNvbnN0IGN1cnJlbnRQcm92aWRlciA9IGN0eC5tb2RlbD8ucHJvdmlkZXI7XG4gICAgICBpZiAoY3VycmVudFByb3ZpZGVyID09PSBcIm9wZW5haS1jb2RleFwiIHx8IGN1cnJlbnRQcm92aWRlciA9PT0gXCJnb29nbGUtZ2VtaW5pLWNsaVwiKSB7XG4gICAgICAgIGNscy5yZXRyeUFmdGVyTXMgPSBNYXRoLm1pbihjbHMucmV0cnlBZnRlck1zLCAzMF8wMDApO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIFx1MjUwMFx1MjUwMCAyLiBEZWNpZGUgJiBBY3QgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbiAgICAvLyAtLS0gTmV0d29yayBlcnJvcnM6IHNhbWUtbW9kZWwgcmV0cnkgd2l0aCBiYWNrb2ZmIC0tLVxuICAgIGlmIChjbHMua2luZCA9PT0gXCJuZXR3b3JrXCIpIHtcbiAgICAgIGNvbnN0IGN1cnJlbnRNb2RlbElkID0gY3R4Lm1vZGVsPy5pZCA/PyBcInVua25vd25cIjtcbiAgICAgIGlmIChyZXRyeVN0YXRlLmN1cnJlbnRSZXRyeU1vZGVsSWQgIT09IGN1cnJlbnRNb2RlbElkKSB7XG4gICAgICAgIHJldHJ5U3RhdGUubmV0d29ya1JldHJ5Q291bnQgPSAwO1xuICAgICAgICByZXRyeVN0YXRlLmN1cnJlbnRSZXRyeU1vZGVsSWQgPSBjdXJyZW50TW9kZWxJZDtcbiAgICAgIH1cbiAgICAgIGlmIChyZXRyeVN0YXRlLm5ldHdvcmtSZXRyeUNvdW50IDwgTUFYX05FVFdPUktfUkVUUklFUykge1xuICAgICAgICByZXRyeVN0YXRlLm5ldHdvcmtSZXRyeUNvdW50ICs9IDE7XG4gICAgICAgIHJldHJ5U3RhdGUuY29uc2VjdXRpdmVUcmFuc2llbnRDb3VudCArPSAxO1xuICAgICAgICBjb25zdCBhdHRlbXB0ID0gcmV0cnlTdGF0ZS5uZXR3b3JrUmV0cnlDb3VudDtcbiAgICAgICAgY29uc3QgZGVsYXlNcyA9IGF0dGVtcHQgKiBjbHMucmV0cnlBZnRlck1zO1xuICAgICAgICBjdHgudWkubm90aWZ5KGBOZXR3b3JrIGVycm9yIG9uICR7Y3VycmVudE1vZGVsSWR9JHtlcnJvckRldGFpbH0uIFJldHJ5ICR7YXR0ZW1wdH0vJHtNQVhfTkVUV09SS19SRVRSSUVTfSBpbiAke2RlbGF5TXMgLyAxMDAwfXMuLi5gLCBcIndhcm5pbmdcIik7XG4gICAgICAgIHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICAgIHBpLnNlbmRNZXNzYWdlKFxuICAgICAgICAgICAgeyBjdXN0b21UeXBlOiBcImdzZC1hdXRvLXRpbWVvdXQtcmVjb3ZlcnlcIiwgY29udGVudDogXCJDb250aW51ZSBleGVjdXRpb24gXHUyMDE0IHJldHJ5aW5nIGFmdGVyIHRyYW5zaWVudCBuZXR3b3JrIGVycm9yLlwiLCBkaXNwbGF5OiBmYWxzZSB9LFxuICAgICAgICAgICAgeyB0cmlnZ2VyVHVybjogdHJ1ZSB9LFxuICAgICAgICAgICk7XG4gICAgICAgIH0sIGRlbGF5TXMpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICAvLyBOZXR3b3JrIHJldHJpZXMgZXhoYXVzdGVkIFx1MjAxNCBmYWxsIHRocm91Z2ggdG8gbW9kZWwgZmFsbGJhY2tcbiAgICAgIHJldHJ5U3RhdGUubmV0d29ya1JldHJ5Q291bnQgPSAwO1xuICAgICAgcmV0cnlTdGF0ZS5jdXJyZW50UmV0cnlNb2RlbElkID0gdW5kZWZpbmVkO1xuICAgICAgY3R4LnVpLm5vdGlmeShgTmV0d29yayByZXRyaWVzIGV4aGF1c3RlZCBmb3IgJHtjdXJyZW50TW9kZWxJZH0uIEF0dGVtcHRpbmcgbW9kZWwgZmFsbGJhY2suYCwgXCJ3YXJuaW5nXCIpO1xuICAgIH1cblxuICAgIC8vIC0tLSBUcmFuc2llbnQgZXJyb3JzOiB0cnkgbW9kZWwgZmFsbGJhY2sgZmlyc3QsIHRoZW4gcGF1c2UgLS0tXG4gICAgLy8gUmF0ZSBsaW1pdHMgYXJlIG9mdGVuIHBlci1tb2RlbCwgc28gc3dpdGNoaW5nIG1vZGVscyBjYW4gYnlwYXNzIHRoZW0uXG4gICAgaWYgKGNscy5raW5kID09PSBcInJhdGUtbGltaXRcIiB8fCBjbHMua2luZCA9PT0gXCJuZXR3b3JrXCIgfHwgY2xzLmtpbmQgPT09IFwic2VydmVyXCIgfHwgY2xzLmtpbmQgPT09IFwiY29ubmVjdGlvblwiIHx8IGNscy5raW5kID09PSBcInN0cmVhbVwiKSB7XG4gICAgICAvLyBUcnkgbW9kZWwgZmFsbGJhY2tcbiAgICAgIGNvbnN0IGRhc2ggPSBnZXRBdXRvRGFzaGJvYXJkRGF0YSgpO1xuICAgICAgaWYgKGRhc2guY3VycmVudFVuaXQpIHtcbiAgICAgICAgY29uc3QgbW9kZWxDb25maWcgPSByZXNvbHZlTW9kZWxXaXRoRmFsbGJhY2tzRm9yVW5pdChkYXNoLmN1cnJlbnRVbml0LnR5cGUpO1xuICAgICAgICBpZiAobW9kZWxDb25maWcgJiYgbW9kZWxDb25maWcuZmFsbGJhY2tzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICBjb25zdCBhdmFpbGFibGVNb2RlbHMgPSBjdHgubW9kZWxSZWdpc3RyeS5nZXRBdmFpbGFibGUoKTtcbiAgICAgICAgICBjb25zdCBuZXh0TW9kZWxJZCA9IGdldE5leHRGYWxsYmFja01vZGVsKGN0eC5tb2RlbD8uaWQsIG1vZGVsQ29uZmlnKTtcbiAgICAgICAgICBpZiAobmV4dE1vZGVsSWQpIHtcbiAgICAgICAgICAgIHJldHJ5U3RhdGUubmV0d29ya1JldHJ5Q291bnQgPSAwO1xuICAgICAgICAgICAgcmV0cnlTdGF0ZS5jdXJyZW50UmV0cnlNb2RlbElkID0gdW5kZWZpbmVkO1xuICAgICAgICAgICAgY29uc3QgbW9kZWxUb1NldCA9IHJlc29sdmVNb2RlbElkKG5leHRNb2RlbElkLCBhdmFpbGFibGVNb2RlbHMsIGN0eC5tb2RlbD8ucHJvdmlkZXIpO1xuICAgICAgICAgICAgaWYgKG1vZGVsVG9TZXQpIHtcbiAgICAgICAgICAgICAgY29uc3Qgb2sgPSBhd2FpdCBwaS5zZXRNb2RlbChtb2RlbFRvU2V0LCB7IHBlcnNpc3Q6IGZhbHNlIH0pO1xuICAgICAgICAgICAgICBpZiAob2spIHtcbiAgICAgICAgICAgICAgICBzZXRDdXJyZW50RGlzcGF0Y2hlZE1vZGVsSWQoeyBwcm92aWRlcjogbW9kZWxUb1NldC5wcm92aWRlciwgaWQ6IG1vZGVsVG9TZXQuaWQgfSk7XG4gICAgICAgICAgICAgICAgY3R4LnVpLm5vdGlmeShgTW9kZWwgZXJyb3Ike2Vycm9yRGV0YWlsfS4gU3dpdGNoZWQgdG8gZmFsbGJhY2s6ICR7bmV4dE1vZGVsSWR9IGFuZCByZXN1bWluZy5gLCBcIndhcm5pbmdcIik7XG4gICAgICAgICAgICAgICAgcGkuc2VuZE1lc3NhZ2UoeyBjdXN0b21UeXBlOiBcImdzZC1hdXRvLXRpbWVvdXQtcmVjb3ZlcnlcIiwgY29udGVudDogXCJDb250aW51ZSBleGVjdXRpb24uXCIsIGRpc3BsYXk6IGZhbHNlIH0sIHsgdHJpZ2dlclR1cm46IHRydWUgfSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIFRyeSByZXN0b3Jpbmcgc2Vzc2lvbiBtb2RlbFxuICAgICAgY29uc3Qgc2Vzc2lvbk1vZGVsID0gZ2V0QXV0b01vZGVTdGFydE1vZGVsKCk7XG4gICAgICBpZiAoc2Vzc2lvbk1vZGVsKSB7XG4gICAgICAgIGlmIChjdHgubW9kZWw/LmlkICE9PSBzZXNzaW9uTW9kZWwuaWQgfHwgY3R4Lm1vZGVsPy5wcm92aWRlciAhPT0gc2Vzc2lvbk1vZGVsLnByb3ZpZGVyKSB7XG4gICAgICAgICAgY29uc3Qgc3RhcnRNb2RlbCA9IGN0eC5tb2RlbFJlZ2lzdHJ5LmdldEF2YWlsYWJsZSgpLmZpbmQoKG0pID0+IG0ucHJvdmlkZXIgPT09IHNlc3Npb25Nb2RlbC5wcm92aWRlciAmJiBtLmlkID09PSBzZXNzaW9uTW9kZWwuaWQpO1xuICAgICAgICAgIGlmIChzdGFydE1vZGVsKSB7XG4gICAgICAgICAgICBjb25zdCBvayA9IGF3YWl0IHBpLnNldE1vZGVsKHN0YXJ0TW9kZWwsIHsgcGVyc2lzdDogZmFsc2UgfSk7XG4gICAgICAgICAgICBpZiAob2spIHtcbiAgICAgICAgICAgICAgc2V0Q3VycmVudERpc3BhdGNoZWRNb2RlbElkKHsgcHJvdmlkZXI6IHN0YXJ0TW9kZWwucHJvdmlkZXIsIGlkOiBzdGFydE1vZGVsLmlkIH0pO1xuICAgICAgICAgICAgICByZXRyeVN0YXRlLm5ldHdvcmtSZXRyeUNvdW50ID0gMDtcbiAgICAgICAgICAgICAgcmV0cnlTdGF0ZS5jdXJyZW50UmV0cnlNb2RlbElkID0gdW5kZWZpbmVkO1xuICAgICAgICAgICAgICBjdHgudWkubm90aWZ5KGBNb2RlbCBlcnJvciR7ZXJyb3JEZXRhaWx9LiBSZXN0b3JlZCBzZXNzaW9uIG1vZGVsOiAke3Nlc3Npb25Nb2RlbC5wcm92aWRlcn0vJHtzZXNzaW9uTW9kZWwuaWR9IGFuZCByZXN1bWluZy5gLCBcIndhcm5pbmdcIik7XG4gICAgICAgICAgICAgIHBpLnNlbmRNZXNzYWdlKHsgY3VzdG9tVHlwZTogXCJnc2QtYXV0by10aW1lb3V0LXJlY292ZXJ5XCIsIGNvbnRlbnQ6IFwiQ29udGludWUgZXhlY3V0aW9uLlwiLCBkaXNwbGF5OiBmYWxzZSB9LCB7IHRyaWdnZXJUdXJuOiB0cnVlIH0pO1xuICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gLS0tIFRyYW5zaWVudCBmYWxsYmFjazogcGF1c2Ugd2l0aCBhdXRvLXJlc3VtZSAtLS1cbiAgICBpZiAoaXNUcmFuc2llbnQoY2xzKSkge1xuICAgICAgYXdhaXQgcGF1c2VUcmFuc2llbnRXaXRoQmFja29mZihjbHMsIHBpLCBjdHgsIGVycm9yRGV0YWlsLCBjbHMua2luZCA9PT0gXCJyYXRlLWxpbWl0XCIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIC0tLSBQZXJtYW5lbnQgLyB1bmtub3duOiBwYXVzZSBpbmRlZmluaXRlbHkgLS0tXG4gICAgYXdhaXQgcGF1c2VBdXRvRm9yUHJvdmlkZXJFcnJvcihjdHgudWksIGVycm9yRGV0YWlsLCAoKSA9PiBwYXVzZUF1dG8oY3R4LCBwaSwge1xuICAgICAgbWVzc2FnZTogYFByb3ZpZGVyIGVycm9yOiAke2Vycm9yRGV0YWlsfWAsXG4gICAgICBjYXRlZ29yeTogXCJwcm92aWRlclwiLFxuICAgICAgaXNUcmFuc2llbnQ6IGZhbHNlLFxuICAgIH0pLCB7XG4gICAgICBpc1JhdGVMaW1pdDogZmFsc2UsXG4gICAgICBpc1RyYW5zaWVudDogZmFsc2UsXG4gICAgICByZXRyeUFmdGVyTXM6IDAsXG4gICAgfSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwIFN1Y2Nlc3MgcGF0aCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgdHJ5IHtcbiAgICByZXNldFJldHJ5U3RhdGUocmV0cnlTdGF0ZSk7XG4gICAgLy8gIzQ1NzMgXHUyMDE0IFJlc2V0IHRoZSBlbXB0eS10dXJuIGNvdW50ZXIgb24gYW55IHN1Y2Nlc3NmdWwgYWdlbnQgdHVybiBzb1xuICAgIC8vIHRyYW5zaWVudCBzdGFsbHMgZG9uJ3QgYWNjdW11bGF0ZSBhY3Jvc3MgaW5kZXBlbmRlbnQgdW5pdHMuXG4gICAgcmVzZXRFbXB0eVR1cm5Db3VudGVyKCk7XG4gICAgcmVzb2x2ZUFnZW50RW5kKGV2ZW50KTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICBjdHgudWkubm90aWZ5KGBBdXRvLW1vZGUgZXJyb3IgaW4gYWdlbnRfZW5kIGhhbmRsZXI6ICR7bWVzc2FnZX0uIFN0b3BwaW5nIGF1dG8tbW9kZS5gLCBcImVycm9yXCIpO1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBwYXVzZUF1dG8oY3R4LCBwaSk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgbG9nV2FybmluZyhcImJvb3RzdHJhcFwiLCBgcGF1c2VBdXRvIGZhaWxlZCBpbiBhZ2VudF9lbmQgaGFuZGxlcjogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICB9XG4gIH1cbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUtBLFNBQVMsa0JBQWtCO0FBQzNCO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1AsU0FBUyxzQkFBc0I7QUFDL0I7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FB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
