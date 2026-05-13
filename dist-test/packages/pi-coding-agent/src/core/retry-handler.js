import { isContextOverflow } from "@gsd/pi-ai";
import { sleep } from "../utils/sleep.js";
import { RETRYABLE_ERROR_RE } from "./retryable-error-regex.js";
class RetryHandler {
  constructor(_deps) {
    this._deps = _deps;
    this._retryAbortController = void 0;
    this._retryAttempt = 0;
    this._retryPromise = void 0;
    this._retryResolve = void 0;
    this._retryGeneration = 0;
    this._continueTimeout = void 0;
  }
  /** Current retry attempt (0 if not retrying) */
  get retryAttempt() {
    return this._retryAttempt;
  }
  /** Whether auto-retry is currently in progress */
  get isRetrying() {
    return this._retryPromise !== void 0;
  }
  /** Whether auto-retry is enabled */
  get autoRetryEnabled() {
    return this._deps.settingsManager.getRetryEnabled();
  }
  /** Toggle auto-retry setting */
  setAutoRetryEnabled(enabled) {
    this._deps.settingsManager.setRetryEnabled(enabled);
  }
  /**
   * Create a retry promise synchronously for agent_end events.
   * Must be called synchronously from the agent event handler before
   * any async processing, so that waitForRetry() doesn't miss in-flight retries.
   */
  createRetryPromiseForAgentEnd(messages) {
    if (this._retryPromise) return;
    const settings = this._deps.settingsManager.getRetrySettings();
    if (!settings.enabled) return;
    const lastAssistant = this._findLastAssistantInMessages(messages);
    if (!lastAssistant || !this.isRetryableError(lastAssistant)) return;
    this._retryPromise = new Promise((resolve) => {
      this._retryResolve = resolve;
    });
  }
  /**
   * Handle a successful assistant response by resetting retry state.
   * Call this when an assistant message completes without error.
   */
  handleSuccessfulResponse() {
    if (this._retryAttempt > 0) {
      this._deps.emit({
        type: "auto_retry_end",
        success: true,
        attempt: this._retryAttempt
      });
      this._retryAttempt = 0;
      this._resolveRetry();
    }
  }
  /**
   * Check if an error is retryable (overloaded, rate limit, server errors).
   * Context overflow errors are NOT retryable (handled by compaction instead).
   */
  isRetryableError(message) {
    if (message.stopReason !== "error" || !message.errorMessage) return false;
    const contextWindow = this._deps.getModel()?.contextWindow ?? 0;
    if (isContextOverflow(message, contextWindow)) return false;
    return RETRYABLE_ERROR_RE.test(message.errorMessage);
  }
  /**
   * Handle retryable errors with exponential backoff.
   * When multiple credentials are available, marks the failing credential
   * as backed off and retries immediately with the next one.
   * @returns true if retry was initiated, false if max retries exceeded or disabled
   */
  async handleRetryableError(message) {
    const settings = this._deps.settingsManager.getRetrySettings();
    if (!settings.enabled) {
      this._resolveRetry();
      return false;
    }
    if (!this._retryPromise) {
      this._retryPromise = new Promise((resolve) => {
        this._retryResolve = resolve;
      });
    }
    const retryGeneration = this._retryGeneration;
    if (this._deps.getModel() && message.errorMessage) {
      if (this._isThirdPartyBlock(message.errorMessage)) {
        const switched = this._tryClaudeCodeFallback(message, retryGeneration);
        if (switched) return true;
      }
      const errorType = this._classifyErrorType(message.errorMessage);
      const isRateLimit = errorType === "rate_limit";
      const isQuotaError = errorType === "quota_exhausted";
      if (isQuotaError) {
        const adjusted = this._tryAffordableMaxTokensRetry(message, retryGeneration);
        if (adjusted) return true;
      }
      if (isRateLimit) {
        const hasAlternate = this._deps.modelRegistry.authStorage.markUsageLimitReached(
          this._deps.getModel().provider,
          this._deps.getSessionId(),
          { errorType }
        );
        if (hasAlternate) {
          this._removeLastAssistantError();
          this._deps.emit({
            type: "auto_retry_start",
            attempt: this._retryAttempt + 1,
            maxAttempts: settings.maxRetries,
            delayMs: 0,
            errorMessage: `${message.errorMessage} (switching credential)`
          });
          this._scheduleContinue(retryGeneration);
          return true;
        }
      }
      if (isRateLimit || isQuotaError) {
        const fallbackResult = await this._deps.fallbackResolver.findFallback(
          this._deps.getModel(),
          errorType
        );
        if (fallbackResult) {
          const previousProvider = this._deps.getModel().provider;
          this._deps.agent.setModel(fallbackResult.model);
          this._deps.onModelChange(fallbackResult.model);
          this._removeLastAssistantError();
          this._deps.emit({
            type: "fallback_provider_switch",
            from: `${previousProvider}/${this._deps.getModel()?.id}`,
            to: `${fallbackResult.model.provider}/${fallbackResult.model.id}`,
            reason: fallbackResult.reason
          });
          this._deps.emit({
            type: "auto_retry_start",
            attempt: this._retryAttempt + 1,
            maxAttempts: settings.maxRetries,
            delayMs: 0,
            errorMessage: `${message.errorMessage} (${fallbackResult.reason})`
          });
          this._scheduleContinue(retryGeneration);
          return true;
        }
        if (isQuotaError) {
          const downgraded = this._tryLongContextDowngrade(message, retryGeneration);
          if (downgraded) return true;
          this._deps.emit({
            type: "fallback_chain_exhausted",
            reason: `All providers exhausted for ${this._deps.getModel().provider}/${this._deps.getModel().id}`
          });
          this._deps.emit({
            type: "auto_retry_end",
            success: false,
            attempt: this._retryAttempt,
            finalError: message.errorMessage
          });
          this._retryAttempt = 0;
          this._resolveRetry();
          return false;
        }
      }
    }
    this._retryAttempt++;
    if (this._retryAttempt > settings.maxRetries) {
      this._deps.emit({
        type: "auto_retry_end",
        success: false,
        attempt: this._retryAttempt - 1,
        finalError: message.errorMessage
      });
      this._retryAttempt = 0;
      this._resolveRetry();
      return false;
    }
    const exponentialDelayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);
    let delayMs;
    if (message.retryAfterMs !== void 0) {
      const cap = settings.maxDelayMs > 0 ? settings.maxDelayMs : Infinity;
      if (message.retryAfterMs > cap) {
        this._deps.emit({
          type: "auto_retry_end",
          success: false,
          attempt: this._retryAttempt - 1,
          finalError: `Rate limit reset in ${Math.ceil(message.retryAfterMs / 1e3)}s (max: ${Math.ceil(cap / 1e3)}s). ${message.errorMessage || ""}`.trim()
        });
        this._retryAttempt = 0;
        this._resolveRetry();
        return false;
      }
      delayMs = message.retryAfterMs;
    } else {
      delayMs = exponentialDelayMs;
    }
    this._deps.emit({
      type: "auto_retry_start",
      attempt: this._retryAttempt,
      maxAttempts: settings.maxRetries,
      delayMs,
      errorMessage: message.errorMessage || "Unknown error"
    });
    this._removeLastAssistantError();
    this._retryAbortController = new AbortController();
    try {
      await sleep(delayMs, this._retryAbortController.signal);
    } catch {
      if (retryGeneration !== this._retryGeneration) {
        this._retryAbortController = void 0;
        return false;
      }
      const attempt = this._retryAttempt;
      this._retryAttempt = 0;
      this._retryAbortController = void 0;
      this._deps.emit({
        type: "auto_retry_end",
        success: false,
        attempt,
        finalError: "Retry cancelled"
      });
      this._resolveRetry();
      return false;
    }
    this._retryAbortController = void 0;
    this._scheduleContinue(retryGeneration);
    return true;
  }
  /** Cancel in-progress retry */
  abortRetry() {
    const hadRetry = this._retryPromise !== void 0 || this._retryAbortController !== void 0 || this._continueTimeout !== void 0;
    if (!hadRetry) return;
    const attempt = this._retryAttempt > 0 ? this._retryAttempt : 1;
    this._retryGeneration++;
    if (this._continueTimeout) {
      clearTimeout(this._continueTimeout);
      this._continueTimeout = void 0;
    }
    if (this._retryAbortController) {
      this._retryAbortController.abort();
      this._retryAbortController = void 0;
    }
    this._retryAttempt = 0;
    this._deps.emit({
      type: "auto_retry_end",
      success: false,
      attempt,
      finalError: "Retry cancelled"
    });
    this._resolveRetry();
  }
  /**
   * Wait for any in-progress retry to complete.
   * Returns immediately if no retry is in progress.
   */
  async waitForRetry() {
    if (this._retryPromise) {
      await this._retryPromise;
    }
  }
  /** Resolve the pending retry promise */
  resolveRetry() {
    this._resolveRetry();
  }
  // =========================================================================
  // Private helpers
  // =========================================================================
  _resolveRetry() {
    if (this._retryResolve) {
      this._retryResolve();
      this._retryResolve = void 0;
      this._retryPromise = void 0;
    }
  }
  _scheduleContinue(retryGeneration) {
    if (this._continueTimeout) {
      clearTimeout(this._continueTimeout);
    }
    this._continueTimeout = setTimeout(() => {
      this._continueTimeout = void 0;
      if (retryGeneration !== this._retryGeneration) return;
      this._deps.agent.continue().catch(() => {
      });
    }, 0);
  }
  _findLastAssistantInMessages(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role === "assistant") {
        return message;
      }
    }
    return void 0;
  }
  /**
   * Classify an error message into a usage-limit error type for credential backoff.
   */
  _classifyErrorType(errorMessage) {
    const err = errorMessage.toLowerCase();
    if (/extra usage is required|long context required/i.test(err)) return "quota_exhausted";
    if (/requires more credits|can only afford|insufficient credits|not enough credits|credit balance/i.test(err))
      return "quota_exhausted";
    if (/quota|billing|exceeded.*limit|usage.*limit/i.test(err)) return "quota_exhausted";
    if (/rate.?limit|too many requests|429/i.test(err)) return "rate_limit";
    if (/500|502|503|504|server.?error|internal.?error|service.?unavailable/i.test(err)) return "server_error";
    return "unknown";
  }
  /**
   * Attempt a same-model retry by reducing maxTokens when provider reports
   * an affordability cap (e.g., "can only afford 329").
   */
  _tryAffordableMaxTokensRetry(message, retryGeneration) {
    const currentModel = this._deps.getModel();
    if (!currentModel || !message.errorMessage) return false;
    const match = message.errorMessage.match(/can only afford\s+([\d,]+)/i);
    if (!match?.[1]) return false;
    const affordable = Number.parseInt(match[1].replace(/,/g, ""), 10);
    if (!Number.isFinite(affordable) || affordable <= 0) return false;
    const safetyBuffer = Math.min(64, Math.max(16, Math.floor(affordable * 0.1)));
    const targetMaxTokens = Math.max(64, affordable - safetyBuffer);
    const downgradedMaxTokens = Math.min(currentModel.maxTokens, targetMaxTokens);
    if (downgradedMaxTokens >= currentModel.maxTokens) return false;
    const downgradedModel = {
      ...currentModel,
      maxTokens: downgradedMaxTokens
    };
    this._deps.agent.setModel(downgradedModel);
    this._deps.onModelChange(downgradedModel);
    this._removeLastAssistantError();
    this._deps.emit({
      type: "fallback_provider_switch",
      from: `${currentModel.provider}/${currentModel.id} (maxTokens=${currentModel.maxTokens})`,
      to: `${downgradedModel.provider}/${downgradedModel.id} (maxTokens=${downgradedModel.maxTokens})`,
      reason: `credit-aware retry: provider affordable cap ${affordable} tokens`
    });
    this._deps.emit({
      type: "auto_retry_start",
      attempt: this._retryAttempt + 1,
      maxAttempts: this._deps.settingsManager.getRetrySettings().maxRetries,
      delayMs: 0,
      errorMessage: `${message.errorMessage} (reducing max tokens)`
    });
    this._scheduleContinue(retryGeneration);
    return true;
  }
  /**
   * Attempt to downgrade a long-context model (e.g. claude-opus-4-6[1m]) to its
   * base model (claude-opus-4-6) when the account lacks the long-context billing
   * entitlement. Returns true if the downgrade was initiated.
   */
  _tryLongContextDowngrade(message, retryGeneration) {
    const currentModel = this._deps.getModel();
    if (!currentModel) return false;
    const match = currentModel.id.match(/^(.+)\[\d+m\]$/);
    if (!match) return false;
    const baseModelId = match[1];
    const baseModel = this._deps.modelRegistry.find(currentModel.provider, baseModelId);
    if (!baseModel) return false;
    const previousId = currentModel.id;
    this._deps.agent.setModel(baseModel);
    this._deps.onModelChange(baseModel);
    this._removeLastAssistantError();
    this._deps.emit({
      type: "fallback_provider_switch",
      from: `${currentModel.provider}/${previousId}`,
      to: `${baseModel.provider}/${baseModel.id}`,
      reason: `long context downgrade: ${previousId} \u2192 ${baseModel.id}`
    });
    this._deps.emit({
      type: "auto_retry_start",
      attempt: this._retryAttempt + 1,
      maxAttempts: this._deps.settingsManager.getRetrySettings().maxRetries,
      delayMs: 0,
      errorMessage: `${message.errorMessage} (long context downgrade)`
    });
    this._scheduleContinue(retryGeneration);
    return true;
  }
  /**
   * Detect Anthropic subscription block errors (#3772).
   * These are hard policy blocks, not transient rate limits — credential
   * rotation will not help. Matches both the explicit "third-party" message
   * and the "out of extra usage" variant that subscription users receive.
   */
  _isThirdPartyBlock(errorMessage) {
    return /third[- .]party.*(?:draw from extra|not.*available|plan limits|not permitted|cannot be used|not supported)|(?:out of|no) extra usage/i.test(errorMessage);
  }
  /**
   * Attempt to switch to the claude-code CLI provider when the current
   * Anthropic provider is blocked by the third-party policy (#3772).
   * Returns true if the switch was made and retry scheduled.
   */
  _tryClaudeCodeFallback(message, retryGeneration) {
    if (!this._deps.isClaudeCodeReady?.()) return false;
    const currentModel = this._deps.getModel();
    if (!currentModel) return false;
    if (currentModel.provider !== "anthropic") return false;
    const ccModel = this._deps.modelRegistry.find("claude-code", currentModel.id);
    if (!ccModel) return false;
    const previousProvider = currentModel.provider;
    this._deps.agent.setModel(ccModel);
    this._deps.onModelChange(ccModel);
    this._removeLastAssistantError();
    this._deps.emit({
      type: "fallback_provider_switch",
      from: `${previousProvider}/${currentModel.id}`,
      to: `claude-code/${ccModel.id}`,
      reason: "Anthropic subscription blocked for third-party apps \u2014 routing through Claude Code CLI"
    });
    this._deps.emit({
      type: "auto_retry_start",
      attempt: this._retryAttempt + 1,
      maxAttempts: this._deps.settingsManager.getRetrySettings().maxRetries,
      delayMs: 0,
      errorMessage: `${message.errorMessage} (switching to Claude Code CLI)`
    });
    this._scheduleContinue(retryGeneration);
    return true;
  }
  /** Remove the last assistant error message from agent state */
  _removeLastAssistantError() {
    const messages = this._deps.agent.state.messages;
    if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
      this._deps.agent.replaceMessages(messages.slice(0, -1));
    }
  }
}
export {
  RetryHandler
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL3JldHJ5LWhhbmRsZXIudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogUmV0cnlIYW5kbGVyIC0gQXV0b21hdGljIHJldHJ5IGxvZ2ljIHdpdGggZXhwb25lbnRpYWwgYmFja29mZiBhbmQgY3JlZGVudGlhbC9wcm92aWRlciBmYWxsYmFjay5cbiAqXG4gKiBIYW5kbGVzIHJldHJ5YWJsZSBlcnJvcnMgKG92ZXJsb2FkZWQsIHJhdGUgbGltaXQsIHNlcnZlciBlcnJvcnMpIGJ5OlxuICogMS4gVHJ5aW5nIGFsdGVybmF0ZSBjcmVkZW50aWFscyBmb3IgdGhlIHNhbWUgcHJvdmlkZXJcbiAqIDIuIEZhbGxpbmcgYmFjayB0byBvdGhlciBwcm92aWRlcnMgdmlhIEZhbGxiYWNrUmVzb2x2ZXJcbiAqIDMuIEV4cG9uZW50aWFsIGJhY2tvZmYgd2l0aCBjb25maWd1cmFibGUgbWF4IHJldHJpZXNcbiAqXG4gKiBDb250ZXh0IG92ZXJmbG93IGVycm9ycyBhcmUgTk9UIGhhbmRsZWQgaGVyZSAoc2VlIGNvbXBhY3Rpb24pLlxuICovXG5cbmltcG9ydCB0eXBlIHsgQWdlbnQgfSBmcm9tIFwiQGdzZC9waS1hZ2VudC1jb3JlXCI7XG5pbXBvcnQgdHlwZSB7IEFzc2lzdGFudE1lc3NhZ2UsIE1vZGVsIH0gZnJvbSBcIkBnc2QvcGktYWlcIjtcbmltcG9ydCB7IGlzQ29udGV4dE92ZXJmbG93IH0gZnJvbSBcIkBnc2QvcGktYWlcIjtcbmltcG9ydCB0eXBlIHsgVXNhZ2VMaW1pdEVycm9yVHlwZSB9IGZyb20gXCIuL2F1dGgtc3RvcmFnZS5qc1wiO1xuaW1wb3J0IHR5cGUgeyBGYWxsYmFja1Jlc29sdmVyIH0gZnJvbSBcIi4vZmFsbGJhY2stcmVzb2x2ZXIuanNcIjtcbmltcG9ydCB0eXBlIHsgTW9kZWxSZWdpc3RyeSB9IGZyb20gXCIuL21vZGVsLXJlZ2lzdHJ5LmpzXCI7XG5pbXBvcnQgdHlwZSB7IFNldHRpbmdzTWFuYWdlciB9IGZyb20gXCIuL3NldHRpbmdzLW1hbmFnZXIuanNcIjtcbmltcG9ydCB7IHNsZWVwIH0gZnJvbSBcIi4uL3V0aWxzL3NsZWVwLmpzXCI7XG5pbXBvcnQgdHlwZSB7IEFnZW50U2Vzc2lvbkV2ZW50IH0gZnJvbSBcIi4vYWdlbnQtc2Vzc2lvbi5qc1wiO1xuaW1wb3J0IHsgUkVUUllBQkxFX0VSUk9SX1JFIH0gZnJvbSBcIi4vcmV0cnlhYmxlLWVycm9yLXJlZ2V4LmpzXCI7XG5cbi8qKiBEZXBlbmRlbmNpZXMgaW5qZWN0ZWQgZnJvbSBBZ2VudFNlc3Npb24gaW50byBSZXRyeUhhbmRsZXIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgUmV0cnlIYW5kbGVyRGVwcyB7XG5cdHJlYWRvbmx5IGFnZW50OiBBZ2VudDtcblx0cmVhZG9ubHkgc2V0dGluZ3NNYW5hZ2VyOiBTZXR0aW5nc01hbmFnZXI7XG5cdHJlYWRvbmx5IG1vZGVsUmVnaXN0cnk6IE1vZGVsUmVnaXN0cnk7XG5cdHJlYWRvbmx5IGZhbGxiYWNrUmVzb2x2ZXI6IEZhbGxiYWNrUmVzb2x2ZXI7XG5cdGdldE1vZGVsOiAoKSA9PiBNb2RlbDxhbnk+IHwgdW5kZWZpbmVkO1xuXHRnZXRTZXNzaW9uSWQ6ICgpID0+IHN0cmluZztcblx0ZW1pdDogKGV2ZW50OiBBZ2VudFNlc3Npb25FdmVudCkgPT4gdm9pZDtcblx0LyoqIENhbGxlZCB3aGVuIHRoZSByZXRyeSBoYW5kbGVyIHN3aXRjaGVzIHRvIGEgZmFsbGJhY2sgbW9kZWwgKi9cblx0b25Nb2RlbENoYW5nZTogKG1vZGVsOiBNb2RlbDxhbnk+KSA9PiB2b2lkO1xuXHQvKiogT3B0aW9uYWw6IGNoZWNrIGlmIHRoZSBjbGF1ZGUtY29kZSBDTEkgcHJvdmlkZXIgaXMgcmVhZHkgKGluc3RhbGxlZCArIGF1dGhlZCkuXG5cdCAqIEluamVjdGVkIGZyb20gdGhlIGFwcCBsYXllciB0byBwcmVzZXJ2ZSBwYWNrYWdlIGJvdW5kYXJ5LiAqL1xuXHRpc0NsYXVkZUNvZGVSZWFkeT86ICgpID0+IGJvb2xlYW47XG59XG5cbmV4cG9ydCBjbGFzcyBSZXRyeUhhbmRsZXIge1xuXHRwcml2YXRlIF9yZXRyeUFib3J0Q29udHJvbGxlcjogQWJvcnRDb250cm9sbGVyIHwgdW5kZWZpbmVkID0gdW5kZWZpbmVkO1xuXHRwcml2YXRlIF9yZXRyeUF0dGVtcHQgPSAwO1xuXHRwcml2YXRlIF9yZXRyeVByb21pc2U6IFByb21pc2U8dm9pZD4gfCB1bmRlZmluZWQgPSB1bmRlZmluZWQ7XG5cdHByaXZhdGUgX3JldHJ5UmVzb2x2ZTogKCgpID0+IHZvaWQpIHwgdW5kZWZpbmVkID0gdW5kZWZpbmVkO1xuXHRwcml2YXRlIF9yZXRyeUdlbmVyYXRpb24gPSAwO1xuXHRwcml2YXRlIF9jb250aW51ZVRpbWVvdXQ6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgdW5kZWZpbmVkID0gdW5kZWZpbmVkO1xuXG5cdGNvbnN0cnVjdG9yKHByaXZhdGUgcmVhZG9ubHkgX2RlcHM6IFJldHJ5SGFuZGxlckRlcHMpIHt9XG5cblx0LyoqIEN1cnJlbnQgcmV0cnkgYXR0ZW1wdCAoMCBpZiBub3QgcmV0cnlpbmcpICovXG5cdGdldCByZXRyeUF0dGVtcHQoKTogbnVtYmVyIHtcblx0XHRyZXR1cm4gdGhpcy5fcmV0cnlBdHRlbXB0O1xuXHR9XG5cblx0LyoqIFdoZXRoZXIgYXV0by1yZXRyeSBpcyBjdXJyZW50bHkgaW4gcHJvZ3Jlc3MgKi9cblx0Z2V0IGlzUmV0cnlpbmcoKTogYm9vbGVhbiB7XG5cdFx0cmV0dXJuIHRoaXMuX3JldHJ5UHJvbWlzZSAhPT0gdW5kZWZpbmVkO1xuXHR9XG5cblx0LyoqIFdoZXRoZXIgYXV0by1yZXRyeSBpcyBlbmFibGVkICovXG5cdGdldCBhdXRvUmV0cnlFbmFibGVkKCk6IGJvb2xlYW4ge1xuXHRcdHJldHVybiB0aGlzLl9kZXBzLnNldHRpbmdzTWFuYWdlci5nZXRSZXRyeUVuYWJsZWQoKTtcblx0fVxuXG5cdC8qKiBUb2dnbGUgYXV0by1yZXRyeSBzZXR0aW5nICovXG5cdHNldEF1dG9SZXRyeUVuYWJsZWQoZW5hYmxlZDogYm9vbGVhbik6IHZvaWQge1xuXHRcdHRoaXMuX2RlcHMuc2V0dGluZ3NNYW5hZ2VyLnNldFJldHJ5RW5hYmxlZChlbmFibGVkKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBDcmVhdGUgYSByZXRyeSBwcm9taXNlIHN5bmNocm9ub3VzbHkgZm9yIGFnZW50X2VuZCBldmVudHMuXG5cdCAqIE11c3QgYmUgY2FsbGVkIHN5bmNocm9ub3VzbHkgZnJvbSB0aGUgYWdlbnQgZXZlbnQgaGFuZGxlciBiZWZvcmVcblx0ICogYW55IGFzeW5jIHByb2Nlc3NpbmcsIHNvIHRoYXQgd2FpdEZvclJldHJ5KCkgZG9lc24ndCBtaXNzIGluLWZsaWdodCByZXRyaWVzLlxuXHQgKi9cblx0Y3JlYXRlUmV0cnlQcm9taXNlRm9yQWdlbnRFbmQobWVzc2FnZXM6IEFycmF5PHsgcm9sZTogc3RyaW5nIH0gJiBSZWNvcmQ8c3RyaW5nLCBhbnk+Pik6IHZvaWQge1xuXHRcdGlmICh0aGlzLl9yZXRyeVByb21pc2UpIHJldHVybjtcblxuXHRcdGNvbnN0IHNldHRpbmdzID0gdGhpcy5fZGVwcy5zZXR0aW5nc01hbmFnZXIuZ2V0UmV0cnlTZXR0aW5ncygpO1xuXHRcdGlmICghc2V0dGluZ3MuZW5hYmxlZCkgcmV0dXJuO1xuXG5cdFx0Y29uc3QgbGFzdEFzc2lzdGFudCA9IHRoaXMuX2ZpbmRMYXN0QXNzaXN0YW50SW5NZXNzYWdlcyhtZXNzYWdlcyk7XG5cdFx0aWYgKCFsYXN0QXNzaXN0YW50IHx8ICF0aGlzLmlzUmV0cnlhYmxlRXJyb3IobGFzdEFzc2lzdGFudCkpIHJldHVybjtcblxuXHRcdHRoaXMuX3JldHJ5UHJvbWlzZSA9IG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG5cdFx0XHR0aGlzLl9yZXRyeVJlc29sdmUgPSByZXNvbHZlO1xuXHRcdH0pO1xuXHR9XG5cblx0LyoqXG5cdCAqIEhhbmRsZSBhIHN1Y2Nlc3NmdWwgYXNzaXN0YW50IHJlc3BvbnNlIGJ5IHJlc2V0dGluZyByZXRyeSBzdGF0ZS5cblx0ICogQ2FsbCB0aGlzIHdoZW4gYW4gYXNzaXN0YW50IG1lc3NhZ2UgY29tcGxldGVzIHdpdGhvdXQgZXJyb3IuXG5cdCAqL1xuXHRoYW5kbGVTdWNjZXNzZnVsUmVzcG9uc2UoKTogdm9pZCB7XG5cdFx0aWYgKHRoaXMuX3JldHJ5QXR0ZW1wdCA+IDApIHtcblx0XHRcdHRoaXMuX2RlcHMuZW1pdCh7XG5cdFx0XHRcdHR5cGU6IFwiYXV0b19yZXRyeV9lbmRcIixcblx0XHRcdFx0c3VjY2VzczogdHJ1ZSxcblx0XHRcdFx0YXR0ZW1wdDogdGhpcy5fcmV0cnlBdHRlbXB0LFxuXHRcdFx0fSk7XG5cdFx0XHR0aGlzLl9yZXRyeUF0dGVtcHQgPSAwO1xuXHRcdFx0dGhpcy5fcmVzb2x2ZVJldHJ5KCk7XG5cdFx0fVxuXHR9XG5cblx0LyoqXG5cdCAqIENoZWNrIGlmIGFuIGVycm9yIGlzIHJldHJ5YWJsZSAob3ZlcmxvYWRlZCwgcmF0ZSBsaW1pdCwgc2VydmVyIGVycm9ycykuXG5cdCAqIENvbnRleHQgb3ZlcmZsb3cgZXJyb3JzIGFyZSBOT1QgcmV0cnlhYmxlIChoYW5kbGVkIGJ5IGNvbXBhY3Rpb24gaW5zdGVhZCkuXG5cdCAqL1xuXHRpc1JldHJ5YWJsZUVycm9yKG1lc3NhZ2U6IEFzc2lzdGFudE1lc3NhZ2UpOiBib29sZWFuIHtcblx0XHRpZiAobWVzc2FnZS5zdG9wUmVhc29uICE9PSBcImVycm9yXCIgfHwgIW1lc3NhZ2UuZXJyb3JNZXNzYWdlKSByZXR1cm4gZmFsc2U7XG5cblx0XHQvLyBDb250ZXh0IG92ZXJmbG93IGlzIGhhbmRsZWQgYnkgY29tcGFjdGlvbiwgbm90IHJldHJ5XG5cdFx0Y29uc3QgY29udGV4dFdpbmRvdyA9IHRoaXMuX2RlcHMuZ2V0TW9kZWwoKT8uY29udGV4dFdpbmRvdyA/PyAwO1xuXHRcdGlmIChpc0NvbnRleHRPdmVyZmxvdyhtZXNzYWdlLCBjb250ZXh0V2luZG93KSkgcmV0dXJuIGZhbHNlO1xuXG5cdFx0cmV0dXJuIFJFVFJZQUJMRV9FUlJPUl9SRS50ZXN0KG1lc3NhZ2UuZXJyb3JNZXNzYWdlKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBIYW5kbGUgcmV0cnlhYmxlIGVycm9ycyB3aXRoIGV4cG9uZW50aWFsIGJhY2tvZmYuXG5cdCAqIFdoZW4gbXVsdGlwbGUgY3JlZGVudGlhbHMgYXJlIGF2YWlsYWJsZSwgbWFya3MgdGhlIGZhaWxpbmcgY3JlZGVudGlhbFxuXHQgKiBhcyBiYWNrZWQgb2ZmIGFuZCByZXRyaWVzIGltbWVkaWF0ZWx5IHdpdGggdGhlIG5leHQgb25lLlxuXHQgKiBAcmV0dXJucyB0cnVlIGlmIHJldHJ5IHdhcyBpbml0aWF0ZWQsIGZhbHNlIGlmIG1heCByZXRyaWVzIGV4Y2VlZGVkIG9yIGRpc2FibGVkXG5cdCAqL1xuXHRhc3luYyBoYW5kbGVSZXRyeWFibGVFcnJvcihtZXNzYWdlOiBBc3Npc3RhbnRNZXNzYWdlKTogUHJvbWlzZTxib29sZWFuPiB7XG5cdFx0Y29uc3Qgc2V0dGluZ3MgPSB0aGlzLl9kZXBzLnNldHRpbmdzTWFuYWdlci5nZXRSZXRyeVNldHRpbmdzKCk7XG5cdFx0aWYgKCFzZXR0aW5ncy5lbmFibGVkKSB7XG5cdFx0XHR0aGlzLl9yZXNvbHZlUmV0cnkoKTtcblx0XHRcdHJldHVybiBmYWxzZTtcblx0XHR9XG5cblx0XHQvLyBSZXRyeSBwcm9taXNlIGlzIGNyZWF0ZWQgc3luY2hyb25vdXNseSBpbiBjcmVhdGVSZXRyeVByb21pc2VGb3JBZ2VudEVuZC5cblx0XHQvLyBLZWVwIGEgZGVmZW5zaXZlIGZhbGxiYWNrIGhlcmUgaW4gY2FzZSBhIGZ1dHVyZSByZWZhY3RvciBieXBhc3NlcyB0aGF0IHBhdGguXG5cdFx0aWYgKCF0aGlzLl9yZXRyeVByb21pc2UpIHtcblx0XHRcdHRoaXMuX3JldHJ5UHJvbWlzZSA9IG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG5cdFx0XHRcdHRoaXMuX3JldHJ5UmVzb2x2ZSA9IHJlc29sdmU7XG5cdFx0XHR9KTtcblx0XHR9XG5cblx0XHQvLyBUcnkgY3JlZGVudGlhbCBmYWxsYmFjayBiZWZvcmUgY291bnRpbmcgYWdhaW5zdCByZXRyeSBidWRnZXQuXG5cdFx0Y29uc3QgcmV0cnlHZW5lcmF0aW9uID0gdGhpcy5fcmV0cnlHZW5lcmF0aW9uO1xuXHRcdGlmICh0aGlzLl9kZXBzLmdldE1vZGVsKCkgJiYgbWVzc2FnZS5lcnJvck1lc3NhZ2UpIHtcblx0XHRcdC8vIFRoaXJkLXBhcnR5IHN1YnNjcmlwdGlvbiBibG9jayAoIzM3NzIpOiBBbnRocm9waWMgYmxvY2tzIHRoaXJkLXBhcnR5IGFwcHNcblx0XHRcdC8vIGZyb20gdXNpbmcgUHJvL01heCBzdWJzY3JpcHRpb24gcXVvdGFzLiBJZiB0aGUgY2xhdWRlLWNvZGUgQ0xJIHByb3ZpZGVyIGlzXG5cdFx0XHQvLyBhdmFpbGFibGUsIHN3aXRjaCB0byBpdCBpbW1lZGlhdGVseSBcdTIwMTQgY3JlZGVudGlhbCByb3RhdGlvbiB3b24ndCBoZWxwLlxuXHRcdFx0aWYgKHRoaXMuX2lzVGhpcmRQYXJ0eUJsb2NrKG1lc3NhZ2UuZXJyb3JNZXNzYWdlKSkge1xuXHRcdFx0XHRjb25zdCBzd2l0Y2hlZCA9IHRoaXMuX3RyeUNsYXVkZUNvZGVGYWxsYmFjayhtZXNzYWdlLCByZXRyeUdlbmVyYXRpb24pO1xuXHRcdFx0XHRpZiAoc3dpdGNoZWQpIHJldHVybiB0cnVlO1xuXHRcdFx0XHQvLyBDTEkgbm90IGF2YWlsYWJsZSBcdTIwMTQgZmFsbCB0aHJvdWdoIHRvIHN0YW5kYXJkIGVycm9yIGhhbmRsaW5nXG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IGVycm9yVHlwZSA9IHRoaXMuX2NsYXNzaWZ5RXJyb3JUeXBlKG1lc3NhZ2UuZXJyb3JNZXNzYWdlKTtcblx0XHRcdGNvbnN0IGlzUmF0ZUxpbWl0ID0gZXJyb3JUeXBlID09PSBcInJhdGVfbGltaXRcIjtcblx0XHRcdGNvbnN0IGlzUXVvdGFFcnJvciA9IGVycm9yVHlwZSA9PT0gXCJxdW90YV9leGhhdXN0ZWRcIjtcblxuXHRcdFx0Ly8gQ3JlZGl0LWF3YXJlIHJldHJ5IChPcGVuUm91dGVyLXN0eWxlIDQwMiBhZmZvcmRhYmlsaXR5IGVycm9ycyk6XG5cdFx0XHQvLyB3aGVuIHByb3ZpZGVyIHJlcG9ydHMgXCJjYW4gb25seSBhZmZvcmQgTlwiLCBsb3dlciBtYXhUb2tlbnMgYW5kIHJldHJ5XG5cdFx0XHQvLyBvbiB0aGUgc2FtZSBtb2RlbCBiZWZvcmUgcm90YXRpbmcgY3JlZGVudGlhbHMvcHJvdmlkZXJzLlxuXHRcdFx0aWYgKGlzUXVvdGFFcnJvcikge1xuXHRcdFx0XHRjb25zdCBhZGp1c3RlZCA9IHRoaXMuX3RyeUFmZm9yZGFibGVNYXhUb2tlbnNSZXRyeShtZXNzYWdlLCByZXRyeUdlbmVyYXRpb24pO1xuXHRcdFx0XHRpZiAoYWRqdXN0ZWQpIHJldHVybiB0cnVlO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBDcmVkZW50aWFsIHJvdGF0aW9uIFx1MjAxNCBvbmx5IGZvciB0cmFuc2llbnQgcmF0ZSBsaW1pdHMgKCMzNDMwKS5cblx0XHRcdC8vIFF1b3RhIGVycm9ycyAoXCJFeHRyYSB1c2FnZSBpcyByZXF1aXJlZFwiKSBhcmUgYWNjb3VudC1sZXZlbCBiaWxsaW5nXG5cdFx0XHQvLyBnYXRlczsgcm90YXRpbmcgdG8gYW5vdGhlciBjcmVkZW50aWFsIG9uIHRoZSBzYW1lIGFjY291bnQgd29uJ3QgaGVscFxuXHRcdFx0Ly8gYW5kIHRoZSAzMC1taW51dGUgYmFja29mZiBibG9ja3MgYWxsIHByb3ZpZGVyIHJlcXVlc3RzIG5lZWRsZXNzbHkuXG5cdFx0XHRpZiAoaXNSYXRlTGltaXQpIHtcblx0XHRcdFx0Y29uc3QgaGFzQWx0ZXJuYXRlID1cblx0XHRcdFx0XHR0aGlzLl9kZXBzLm1vZGVsUmVnaXN0cnkuYXV0aFN0b3JhZ2UubWFya1VzYWdlTGltaXRSZWFjaGVkKFxuXHRcdFx0XHRcdFx0dGhpcy5fZGVwcy5nZXRNb2RlbCgpIS5wcm92aWRlcixcblx0XHRcdFx0XHRcdHRoaXMuX2RlcHMuZ2V0U2Vzc2lvbklkKCksXG5cdFx0XHRcdFx0XHR7IGVycm9yVHlwZSB9LFxuXHRcdFx0XHRcdCk7XG5cblx0XHRcdFx0aWYgKGhhc0FsdGVybmF0ZSkge1xuXHRcdFx0XHRcdHRoaXMuX3JlbW92ZUxhc3RBc3Npc3RhbnRFcnJvcigpO1xuXG5cdFx0XHRcdFx0dGhpcy5fZGVwcy5lbWl0KHtcblx0XHRcdFx0XHRcdHR5cGU6IFwiYXV0b19yZXRyeV9zdGFydFwiLFxuXHRcdFx0XHRcdFx0YXR0ZW1wdDogdGhpcy5fcmV0cnlBdHRlbXB0ICsgMSxcblx0XHRcdFx0XHRcdG1heEF0dGVtcHRzOiBzZXR0aW5ncy5tYXhSZXRyaWVzLFxuXHRcdFx0XHRcdFx0ZGVsYXlNczogMCxcblx0XHRcdFx0XHRcdGVycm9yTWVzc2FnZTogYCR7bWVzc2FnZS5lcnJvck1lc3NhZ2V9IChzd2l0Y2hpbmcgY3JlZGVudGlhbClgLFxuXHRcdFx0XHRcdH0pO1xuXG5cdFx0XHRcdFx0Ly8gUmV0cnkgaW1tZWRpYXRlbHkgd2l0aCB0aGUgbmV4dCBjcmVkZW50aWFsIC0gZG9uJ3QgaW5jcmVtZW50IF9yZXRyeUF0dGVtcHRcblx0XHRcdFx0XHR0aGlzLl9zY2hlZHVsZUNvbnRpbnVlKHJldHJ5R2VuZXJhdGlvbik7XG5cblx0XHRcdFx0XHRyZXR1cm4gdHJ1ZTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHQvLyBDcm9zcy1wcm92aWRlciBmYWxsYmFjayBcdTIwMTQgZm9yIHJhdGUgbGltaXRzIHdpdGggYWxsIGNyZWRzIGJhY2tlZCBvZmYsXG5cdFx0XHQvLyBvciBxdW90YSBlcnJvcnMgKHdoaWNoIHNraXAgY3JlZGVudGlhbCBiYWNrb2ZmIGVudGlyZWx5KS5cblx0XHRcdGlmIChpc1JhdGVMaW1pdCB8fCBpc1F1b3RhRXJyb3IpIHtcblx0XHRcdFx0Y29uc3QgZmFsbGJhY2tSZXN1bHQgPSBhd2FpdCB0aGlzLl9kZXBzLmZhbGxiYWNrUmVzb2x2ZXIuZmluZEZhbGxiYWNrKFxuXHRcdFx0XHRcdHRoaXMuX2RlcHMuZ2V0TW9kZWwoKSEsXG5cdFx0XHRcdFx0ZXJyb3JUeXBlLFxuXHRcdFx0XHQpO1xuXG5cdFx0XHRcdGlmIChmYWxsYmFja1Jlc3VsdCkge1xuXHRcdFx0XHRcdGNvbnN0IHByZXZpb3VzUHJvdmlkZXIgPSB0aGlzLl9kZXBzLmdldE1vZGVsKCkhLnByb3ZpZGVyO1xuXHRcdFx0XHRcdHRoaXMuX2RlcHMuYWdlbnQuc2V0TW9kZWwoZmFsbGJhY2tSZXN1bHQubW9kZWwpO1xuXHRcdFx0XHRcdHRoaXMuX2RlcHMub25Nb2RlbENoYW5nZShmYWxsYmFja1Jlc3VsdC5tb2RlbCk7XG5cdFx0XHRcdFx0dGhpcy5fcmVtb3ZlTGFzdEFzc2lzdGFudEVycm9yKCk7XG5cblx0XHRcdFx0XHR0aGlzLl9kZXBzLmVtaXQoe1xuXHRcdFx0XHRcdFx0dHlwZTogXCJmYWxsYmFja19wcm92aWRlcl9zd2l0Y2hcIixcblx0XHRcdFx0XHRcdGZyb206IGAke3ByZXZpb3VzUHJvdmlkZXJ9LyR7dGhpcy5fZGVwcy5nZXRNb2RlbCgpPy5pZH1gLFxuXHRcdFx0XHRcdFx0dG86IGAke2ZhbGxiYWNrUmVzdWx0Lm1vZGVsLnByb3ZpZGVyfS8ke2ZhbGxiYWNrUmVzdWx0Lm1vZGVsLmlkfWAsXG5cdFx0XHRcdFx0XHRyZWFzb246IGZhbGxiYWNrUmVzdWx0LnJlYXNvbixcblx0XHRcdFx0XHR9KTtcblxuXHRcdFx0XHRcdHRoaXMuX2RlcHMuZW1pdCh7XG5cdFx0XHRcdFx0XHR0eXBlOiBcImF1dG9fcmV0cnlfc3RhcnRcIixcblx0XHRcdFx0XHRcdGF0dGVtcHQ6IHRoaXMuX3JldHJ5QXR0ZW1wdCArIDEsXG5cdFx0XHRcdFx0XHRtYXhBdHRlbXB0czogc2V0dGluZ3MubWF4UmV0cmllcyxcblx0XHRcdFx0XHRcdGRlbGF5TXM6IDAsXG5cdFx0XHRcdFx0XHRlcnJvck1lc3NhZ2U6IGAke21lc3NhZ2UuZXJyb3JNZXNzYWdlfSAoJHtmYWxsYmFja1Jlc3VsdC5yZWFzb259KWAsXG5cdFx0XHRcdFx0fSk7XG5cblx0XHRcdFx0XHQvLyBSZXRyeSBpbW1lZGlhdGVseSB3aXRoIGZhbGxiYWNrIHByb3ZpZGVyIC0gZG9uJ3QgaW5jcmVtZW50IF9yZXRyeUF0dGVtcHRcblx0XHRcdFx0XHR0aGlzLl9zY2hlZHVsZUNvbnRpbnVlKHJldHJ5R2VuZXJhdGlvbik7XG5cblx0XHRcdFx0XHRyZXR1cm4gdHJ1ZTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdC8vIE5vIGZhbGxiYWNrIGF2YWlsYWJsZSBlaXRoZXJcblx0XHRcdFx0aWYgKGlzUXVvdGFFcnJvcikge1xuXHRcdFx0XHRcdC8vIFRyeSBsb25nLWNvbnRleHQgbW9kZWwgZG93bmdyYWRlIChbMW1dIFx1MjE5MiBiYXNlKSBiZWZvcmUgZ2l2aW5nIHVwXG5cdFx0XHRcdFx0Y29uc3QgZG93bmdyYWRlZCA9IHRoaXMuX3RyeUxvbmdDb250ZXh0RG93bmdyYWRlKG1lc3NhZ2UsIHJldHJ5R2VuZXJhdGlvbik7XG5cdFx0XHRcdFx0aWYgKGRvd25ncmFkZWQpIHJldHVybiB0cnVlO1xuXG5cdFx0XHRcdFx0dGhpcy5fZGVwcy5lbWl0KHtcblx0XHRcdFx0XHRcdHR5cGU6IFwiZmFsbGJhY2tfY2hhaW5fZXhoYXVzdGVkXCIsXG5cdFx0XHRcdFx0XHRyZWFzb246IGBBbGwgcHJvdmlkZXJzIGV4aGF1c3RlZCBmb3IgJHt0aGlzLl9kZXBzLmdldE1vZGVsKCkhLnByb3ZpZGVyfS8ke3RoaXMuX2RlcHMuZ2V0TW9kZWwoKSEuaWR9YCxcblx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHR0aGlzLl9kZXBzLmVtaXQoe1xuXHRcdFx0XHRcdFx0dHlwZTogXCJhdXRvX3JldHJ5X2VuZFwiLFxuXHRcdFx0XHRcdFx0c3VjY2VzczogZmFsc2UsXG5cdFx0XHRcdFx0XHRhdHRlbXB0OiB0aGlzLl9yZXRyeUF0dGVtcHQsXG5cdFx0XHRcdFx0XHRmaW5hbEVycm9yOiBtZXNzYWdlLmVycm9yTWVzc2FnZSxcblx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHR0aGlzLl9yZXRyeUF0dGVtcHQgPSAwO1xuXHRcdFx0XHRcdHRoaXMuX3Jlc29sdmVSZXRyeSgpO1xuXHRcdFx0XHRcdHJldHVybiBmYWxzZTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH1cblxuXHRcdHRoaXMuX3JldHJ5QXR0ZW1wdCsrO1xuXG5cdFx0aWYgKHRoaXMuX3JldHJ5QXR0ZW1wdCA+IHNldHRpbmdzLm1heFJldHJpZXMpIHtcblx0XHRcdHRoaXMuX2RlcHMuZW1pdCh7XG5cdFx0XHRcdHR5cGU6IFwiYXV0b19yZXRyeV9lbmRcIixcblx0XHRcdFx0c3VjY2VzczogZmFsc2UsXG5cdFx0XHRcdGF0dGVtcHQ6IHRoaXMuX3JldHJ5QXR0ZW1wdCAtIDEsXG5cdFx0XHRcdGZpbmFsRXJyb3I6IG1lc3NhZ2UuZXJyb3JNZXNzYWdlLFxuXHRcdFx0fSk7XG5cdFx0XHR0aGlzLl9yZXRyeUF0dGVtcHQgPSAwO1xuXHRcdFx0dGhpcy5fcmVzb2x2ZVJldHJ5KCk7XG5cdFx0XHRyZXR1cm4gZmFsc2U7XG5cdFx0fVxuXG5cdFx0Ly8gVXNlIHNlcnZlci1yZXF1ZXN0ZWQgZGVsYXkgd2hlbiBhdmFpbGFibGUsIGNhcHBlZCBieSBtYXhEZWxheU1zLlxuXHRcdC8vIEZhbGwgYmFjayB0byBleHBvbmVudGlhbCBiYWNrb2ZmIHdoZW4gbm8gc2VydmVyIGhpbnQgaXMgcHJlc2VudC5cblx0XHRjb25zdCBleHBvbmVudGlhbERlbGF5TXMgPSBzZXR0aW5ncy5iYXNlRGVsYXlNcyAqIDIgKiogKHRoaXMuX3JldHJ5QXR0ZW1wdCAtIDEpO1xuXHRcdGxldCBkZWxheU1zOiBudW1iZXI7XG5cdFx0aWYgKG1lc3NhZ2UucmV0cnlBZnRlck1zICE9PSB1bmRlZmluZWQpIHtcblx0XHRcdGNvbnN0IGNhcCA9IHNldHRpbmdzLm1heERlbGF5TXMgPiAwID8gc2V0dGluZ3MubWF4RGVsYXlNcyA6IEluZmluaXR5O1xuXHRcdFx0aWYgKG1lc3NhZ2UucmV0cnlBZnRlck1zID4gY2FwKSB7XG5cdFx0XHRcdHRoaXMuX2RlcHMuZW1pdCh7XG5cdFx0XHRcdFx0dHlwZTogXCJhdXRvX3JldHJ5X2VuZFwiLFxuXHRcdFx0XHRcdHN1Y2Nlc3M6IGZhbHNlLFxuXHRcdFx0XHRcdGF0dGVtcHQ6IHRoaXMuX3JldHJ5QXR0ZW1wdCAtIDEsXG5cdFx0XHRcdFx0ZmluYWxFcnJvcjogYFJhdGUgbGltaXQgcmVzZXQgaW4gJHtNYXRoLmNlaWwobWVzc2FnZS5yZXRyeUFmdGVyTXMgLyAxMDAwKX1zIChtYXg6ICR7TWF0aC5jZWlsKGNhcCAvIDEwMDApfXMpLiAke21lc3NhZ2UuZXJyb3JNZXNzYWdlIHx8IFwiXCJ9YC50cmltKCksXG5cdFx0XHRcdH0pO1xuXHRcdFx0XHR0aGlzLl9yZXRyeUF0dGVtcHQgPSAwO1xuXHRcdFx0XHR0aGlzLl9yZXNvbHZlUmV0cnkoKTtcblx0XHRcdFx0cmV0dXJuIGZhbHNlO1xuXHRcdFx0fVxuXHRcdFx0ZGVsYXlNcyA9IG1lc3NhZ2UucmV0cnlBZnRlck1zO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHRkZWxheU1zID0gZXhwb25lbnRpYWxEZWxheU1zO1xuXHRcdH1cblxuXHRcdHRoaXMuX2RlcHMuZW1pdCh7XG5cdFx0XHR0eXBlOiBcImF1dG9fcmV0cnlfc3RhcnRcIixcblx0XHRcdGF0dGVtcHQ6IHRoaXMuX3JldHJ5QXR0ZW1wdCxcblx0XHRcdG1heEF0dGVtcHRzOiBzZXR0aW5ncy5tYXhSZXRyaWVzLFxuXHRcdFx0ZGVsYXlNcyxcblx0XHRcdGVycm9yTWVzc2FnZTogbWVzc2FnZS5lcnJvck1lc3NhZ2UgfHwgXCJVbmtub3duIGVycm9yXCIsXG5cdFx0fSk7XG5cblx0XHR0aGlzLl9yZW1vdmVMYXN0QXNzaXN0YW50RXJyb3IoKTtcblxuXHRcdC8vIFdhaXQgd2l0aCBleHBvbmVudGlhbCBiYWNrb2ZmIChhYm9ydGFibGUpXG5cdFx0dGhpcy5fcmV0cnlBYm9ydENvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG5cdFx0dHJ5IHtcblx0XHRcdGF3YWl0IHNsZWVwKGRlbGF5TXMsIHRoaXMuX3JldHJ5QWJvcnRDb250cm9sbGVyLnNpZ25hbCk7XG5cdFx0fSBjYXRjaCB7XG5cdFx0XHQvLyBBYm9ydGVkIGR1cmluZyBzbGVlcC4gSWYgdGhlIHJldHJ5IGdlbmVyYXRpb24gYWxyZWFkeSBhZHZhbmNlZCwgdGhpc1xuXHRcdFx0Ly8gY2FuY2VsbGF0aW9uIHdhcyBoYW5kbGVkIGV4dGVybmFsbHkgKGUuZy4gZXhwbGljaXQgbW9kZWwgc3dpdGNoKS5cblx0XHRcdGlmIChyZXRyeUdlbmVyYXRpb24gIT09IHRoaXMuX3JldHJ5R2VuZXJhdGlvbikge1xuXHRcdFx0XHR0aGlzLl9yZXRyeUFib3J0Q29udHJvbGxlciA9IHVuZGVmaW5lZDtcblx0XHRcdFx0cmV0dXJuIGZhbHNlO1xuXHRcdFx0fVxuXHRcdFx0Y29uc3QgYXR0ZW1wdCA9IHRoaXMuX3JldHJ5QXR0ZW1wdDtcblx0XHRcdHRoaXMuX3JldHJ5QXR0ZW1wdCA9IDA7XG5cdFx0XHR0aGlzLl9yZXRyeUFib3J0Q29udHJvbGxlciA9IHVuZGVmaW5lZDtcblx0XHRcdHRoaXMuX2RlcHMuZW1pdCh7XG5cdFx0XHRcdHR5cGU6IFwiYXV0b19yZXRyeV9lbmRcIixcblx0XHRcdFx0c3VjY2VzczogZmFsc2UsXG5cdFx0XHRcdGF0dGVtcHQsXG5cdFx0XHRcdGZpbmFsRXJyb3I6IFwiUmV0cnkgY2FuY2VsbGVkXCIsXG5cdFx0XHR9KTtcblx0XHRcdHRoaXMuX3Jlc29sdmVSZXRyeSgpO1xuXHRcdFx0cmV0dXJuIGZhbHNlO1xuXHRcdH1cblx0XHR0aGlzLl9yZXRyeUFib3J0Q29udHJvbGxlciA9IHVuZGVmaW5lZDtcblxuXHRcdC8vIFJldHJ5IHZpYSBjb250aW51ZSgpIC0gdXNlIHNldFRpbWVvdXQgdG8gYnJlYWsgb3V0IG9mIGV2ZW50IGhhbmRsZXIgY2hhaW5cblx0XHR0aGlzLl9zY2hlZHVsZUNvbnRpbnVlKHJldHJ5R2VuZXJhdGlvbik7XG5cblx0XHRyZXR1cm4gdHJ1ZTtcblx0fVxuXG5cdC8qKiBDYW5jZWwgaW4tcHJvZ3Jlc3MgcmV0cnkgKi9cblx0YWJvcnRSZXRyeSgpOiB2b2lkIHtcblx0XHRjb25zdCBoYWRSZXRyeSA9XG5cdFx0XHR0aGlzLl9yZXRyeVByb21pc2UgIT09IHVuZGVmaW5lZFxuXHRcdFx0fHwgdGhpcy5fcmV0cnlBYm9ydENvbnRyb2xsZXIgIT09IHVuZGVmaW5lZFxuXHRcdFx0fHwgdGhpcy5fY29udGludWVUaW1lb3V0ICE9PSB1bmRlZmluZWQ7XG5cdFx0aWYgKCFoYWRSZXRyeSkgcmV0dXJuO1xuXG5cdFx0Y29uc3QgYXR0ZW1wdCA9IHRoaXMuX3JldHJ5QXR0ZW1wdCA+IDAgPyB0aGlzLl9yZXRyeUF0dGVtcHQgOiAxO1xuXHRcdHRoaXMuX3JldHJ5R2VuZXJhdGlvbisrO1xuXHRcdGlmICh0aGlzLl9jb250aW51ZVRpbWVvdXQpIHtcblx0XHRcdGNsZWFyVGltZW91dCh0aGlzLl9jb250aW51ZVRpbWVvdXQpO1xuXHRcdFx0dGhpcy5fY29udGludWVUaW1lb3V0ID0gdW5kZWZpbmVkO1xuXHRcdH1cblx0XHRpZiAodGhpcy5fcmV0cnlBYm9ydENvbnRyb2xsZXIpIHtcblx0XHRcdHRoaXMuX3JldHJ5QWJvcnRDb250cm9sbGVyLmFib3J0KCk7XG5cdFx0XHR0aGlzLl9yZXRyeUFib3J0Q29udHJvbGxlciA9IHVuZGVmaW5lZDtcblx0XHR9XG5cdFx0dGhpcy5fcmV0cnlBdHRlbXB0ID0gMDtcblx0XHR0aGlzLl9kZXBzLmVtaXQoe1xuXHRcdFx0dHlwZTogXCJhdXRvX3JldHJ5X2VuZFwiLFxuXHRcdFx0c3VjY2VzczogZmFsc2UsXG5cdFx0XHRhdHRlbXB0LFxuXHRcdFx0ZmluYWxFcnJvcjogXCJSZXRyeSBjYW5jZWxsZWRcIixcblx0XHR9KTtcblx0XHR0aGlzLl9yZXNvbHZlUmV0cnkoKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBXYWl0IGZvciBhbnkgaW4tcHJvZ3Jlc3MgcmV0cnkgdG8gY29tcGxldGUuXG5cdCAqIFJldHVybnMgaW1tZWRpYXRlbHkgaWYgbm8gcmV0cnkgaXMgaW4gcHJvZ3Jlc3MuXG5cdCAqL1xuXHRhc3luYyB3YWl0Rm9yUmV0cnkoKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0aWYgKHRoaXMuX3JldHJ5UHJvbWlzZSkge1xuXHRcdFx0YXdhaXQgdGhpcy5fcmV0cnlQcm9taXNlO1xuXHRcdH1cblx0fVxuXG5cdC8qKiBSZXNvbHZlIHRoZSBwZW5kaW5nIHJldHJ5IHByb21pc2UgKi9cblx0cmVzb2x2ZVJldHJ5KCk6IHZvaWQge1xuXHRcdHRoaXMuX3Jlc29sdmVSZXRyeSgpO1xuXHR9XG5cblx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXHQvLyBQcml2YXRlIGhlbHBlcnNcblx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5cdHByaXZhdGUgX3Jlc29sdmVSZXRyeSgpOiB2b2lkIHtcblx0XHRpZiAodGhpcy5fcmV0cnlSZXNvbHZlKSB7XG5cdFx0XHR0aGlzLl9yZXRyeVJlc29sdmUoKTtcblx0XHRcdHRoaXMuX3JldHJ5UmVzb2x2ZSA9IHVuZGVmaW5lZDtcblx0XHRcdHRoaXMuX3JldHJ5UHJvbWlzZSA9IHVuZGVmaW5lZDtcblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIF9zY2hlZHVsZUNvbnRpbnVlKHJldHJ5R2VuZXJhdGlvbjogbnVtYmVyKTogdm9pZCB7XG5cdFx0aWYgKHRoaXMuX2NvbnRpbnVlVGltZW91dCkge1xuXHRcdFx0Y2xlYXJUaW1lb3V0KHRoaXMuX2NvbnRpbnVlVGltZW91dCk7XG5cdFx0fVxuXHRcdHRoaXMuX2NvbnRpbnVlVGltZW91dCA9IHNldFRpbWVvdXQoKCkgPT4ge1xuXHRcdFx0dGhpcy5fY29udGludWVUaW1lb3V0ID0gdW5kZWZpbmVkO1xuXHRcdFx0aWYgKHJldHJ5R2VuZXJhdGlvbiAhPT0gdGhpcy5fcmV0cnlHZW5lcmF0aW9uKSByZXR1cm47XG5cdFx0XHR0aGlzLl9kZXBzLmFnZW50LmNvbnRpbnVlKCkuY2F0Y2goKCkgPT4ge30pO1xuXHRcdH0sIDApO1xuXHR9XG5cblx0cHJpdmF0ZSBfZmluZExhc3RBc3Npc3RhbnRJbk1lc3NhZ2VzKFxuXHRcdG1lc3NhZ2VzOiBBcnJheTx7IHJvbGU6IHN0cmluZyB9ICYgUmVjb3JkPHN0cmluZywgYW55Pj4sXG5cdCk6IEFzc2lzdGFudE1lc3NhZ2UgfCB1bmRlZmluZWQge1xuXHRcdGZvciAobGV0IGkgPSBtZXNzYWdlcy5sZW5ndGggLSAxOyBpID49IDA7IGktLSkge1xuXHRcdFx0Y29uc3QgbWVzc2FnZSA9IG1lc3NhZ2VzW2ldO1xuXHRcdFx0aWYgKG1lc3NhZ2Uucm9sZSA9PT0gXCJhc3Npc3RhbnRcIikge1xuXHRcdFx0XHRyZXR1cm4gbWVzc2FnZSBhcyBBc3Npc3RhbnRNZXNzYWdlO1xuXHRcdFx0fVxuXHRcdH1cblx0XHRyZXR1cm4gdW5kZWZpbmVkO1xuXHR9XG5cblx0LyoqXG5cdCAqIENsYXNzaWZ5IGFuIGVycm9yIG1lc3NhZ2UgaW50byBhIHVzYWdlLWxpbWl0IGVycm9yIHR5cGUgZm9yIGNyZWRlbnRpYWwgYmFja29mZi5cblx0ICovXG5cdHByaXZhdGUgX2NsYXNzaWZ5RXJyb3JUeXBlKGVycm9yTWVzc2FnZTogc3RyaW5nKTogVXNhZ2VMaW1pdEVycm9yVHlwZSB7XG5cdFx0Y29uc3QgZXJyID0gZXJyb3JNZXNzYWdlLnRvTG93ZXJDYXNlKCk7XG5cdFx0Ly8gTG9uZy1jb250ZXh0IGVudGl0bGVtZW50IGVycm9ycyBhcmUgYmlsbGluZyBnYXRlcywgbm90IHRyYW5zaWVudCByYXRlIGxpbWl0cy5cblx0XHQvLyBNdXN0IGJlIGNoZWNrZWQgYmVmb3JlIHRoZSBnZW5lcmljIDQyOS9yYXRlX2xpbWl0IHJlZ2V4LlxuXHRcdGlmICgvZXh0cmEgdXNhZ2UgaXMgcmVxdWlyZWR8bG9uZyBjb250ZXh0IHJlcXVpcmVkL2kudGVzdChlcnIpKSByZXR1cm4gXCJxdW90YV9leGhhdXN0ZWRcIjtcblx0XHRpZiAoL3JlcXVpcmVzIG1vcmUgY3JlZGl0c3xjYW4gb25seSBhZmZvcmR8aW5zdWZmaWNpZW50IGNyZWRpdHN8bm90IGVub3VnaCBjcmVkaXRzfGNyZWRpdCBiYWxhbmNlL2kudGVzdChlcnIpKVxuXHRcdFx0cmV0dXJuIFwicXVvdGFfZXhoYXVzdGVkXCI7XG5cdFx0aWYgKC9xdW90YXxiaWxsaW5nfGV4Y2VlZGVkLipsaW1pdHx1c2FnZS4qbGltaXQvaS50ZXN0KGVycikpIHJldHVybiBcInF1b3RhX2V4aGF1c3RlZFwiO1xuXHRcdGlmICgvcmF0ZS4/bGltaXR8dG9vIG1hbnkgcmVxdWVzdHN8NDI5L2kudGVzdChlcnIpKSByZXR1cm4gXCJyYXRlX2xpbWl0XCI7XG5cdFx0aWYgKC81MDB8NTAyfDUwM3w1MDR8c2VydmVyLj9lcnJvcnxpbnRlcm5hbC4/ZXJyb3J8c2VydmljZS4/dW5hdmFpbGFibGUvaS50ZXN0KGVycikpIHJldHVybiBcInNlcnZlcl9lcnJvclwiO1xuXHRcdHJldHVybiBcInVua25vd25cIjtcblx0fVxuXG5cdC8qKlxuXHQgKiBBdHRlbXB0IGEgc2FtZS1tb2RlbCByZXRyeSBieSByZWR1Y2luZyBtYXhUb2tlbnMgd2hlbiBwcm92aWRlciByZXBvcnRzXG5cdCAqIGFuIGFmZm9yZGFiaWxpdHkgY2FwIChlLmcuLCBcImNhbiBvbmx5IGFmZm9yZCAzMjlcIikuXG5cdCAqL1xuXHRwcml2YXRlIF90cnlBZmZvcmRhYmxlTWF4VG9rZW5zUmV0cnkobWVzc2FnZTogQXNzaXN0YW50TWVzc2FnZSwgcmV0cnlHZW5lcmF0aW9uOiBudW1iZXIpOiBib29sZWFuIHtcblx0XHRjb25zdCBjdXJyZW50TW9kZWwgPSB0aGlzLl9kZXBzLmdldE1vZGVsKCk7XG5cdFx0aWYgKCFjdXJyZW50TW9kZWwgfHwgIW1lc3NhZ2UuZXJyb3JNZXNzYWdlKSByZXR1cm4gZmFsc2U7XG5cblx0XHQvLyBFeGFtcGxlOiBcImNhbiBvbmx5IGFmZm9yZCAzMjlcIlxuXHRcdGNvbnN0IG1hdGNoID0gbWVzc2FnZS5lcnJvck1lc3NhZ2UubWF0Y2goL2NhbiBvbmx5IGFmZm9yZFxccysoW1xcZCxdKykvaSk7XG5cdFx0aWYgKCFtYXRjaD8uWzFdKSByZXR1cm4gZmFsc2U7XG5cblx0XHRjb25zdCBhZmZvcmRhYmxlID0gTnVtYmVyLnBhcnNlSW50KG1hdGNoWzFdLnJlcGxhY2UoLywvZywgXCJcIiksIDEwKTtcblx0XHRpZiAoIU51bWJlci5pc0Zpbml0ZShhZmZvcmRhYmxlKSB8fCBhZmZvcmRhYmxlIDw9IDApIHJldHVybiBmYWxzZTtcblxuXHRcdC8vIExlYXZlIGEgc21hbGwgYnVmZmVyIHNvIHNsaWdodCBpbnB1dCB2YXJpYW5jZSBkb2Vzbid0IGltbWVkaWF0ZWx5IHJlLWZhaWwuXG5cdFx0Y29uc3Qgc2FmZXR5QnVmZmVyID0gTWF0aC5taW4oNjQsIE1hdGgubWF4KDE2LCBNYXRoLmZsb29yKGFmZm9yZGFibGUgKiAwLjEpKSk7XG5cdFx0Y29uc3QgdGFyZ2V0TWF4VG9rZW5zID0gTWF0aC5tYXgoNjQsIGFmZm9yZGFibGUgLSBzYWZldHlCdWZmZXIpO1xuXHRcdGNvbnN0IGRvd25ncmFkZWRNYXhUb2tlbnMgPSBNYXRoLm1pbihjdXJyZW50TW9kZWwubWF4VG9rZW5zLCB0YXJnZXRNYXhUb2tlbnMpO1xuXHRcdGlmIChkb3duZ3JhZGVkTWF4VG9rZW5zID49IGN1cnJlbnRNb2RlbC5tYXhUb2tlbnMpIHJldHVybiBmYWxzZTtcblxuXHRcdGNvbnN0IGRvd25ncmFkZWRNb2RlbCA9IHtcblx0XHRcdC4uLmN1cnJlbnRNb2RlbCxcblx0XHRcdG1heFRva2VuczogZG93bmdyYWRlZE1heFRva2Vucyxcblx0XHR9O1xuXG5cdFx0dGhpcy5fZGVwcy5hZ2VudC5zZXRNb2RlbChkb3duZ3JhZGVkTW9kZWwpO1xuXHRcdHRoaXMuX2RlcHMub25Nb2RlbENoYW5nZShkb3duZ3JhZGVkTW9kZWwpO1xuXHRcdHRoaXMuX3JlbW92ZUxhc3RBc3Npc3RhbnRFcnJvcigpO1xuXG5cdFx0dGhpcy5fZGVwcy5lbWl0KHtcblx0XHRcdHR5cGU6IFwiZmFsbGJhY2tfcHJvdmlkZXJfc3dpdGNoXCIsXG5cdFx0XHRmcm9tOiBgJHtjdXJyZW50TW9kZWwucHJvdmlkZXJ9LyR7Y3VycmVudE1vZGVsLmlkfSAobWF4VG9rZW5zPSR7Y3VycmVudE1vZGVsLm1heFRva2Vuc30pYCxcblx0XHRcdHRvOiBgJHtkb3duZ3JhZGVkTW9kZWwucHJvdmlkZXJ9LyR7ZG93bmdyYWRlZE1vZGVsLmlkfSAobWF4VG9rZW5zPSR7ZG93bmdyYWRlZE1vZGVsLm1heFRva2Vuc30pYCxcblx0XHRcdHJlYXNvbjogYGNyZWRpdC1hd2FyZSByZXRyeTogcHJvdmlkZXIgYWZmb3JkYWJsZSBjYXAgJHthZmZvcmRhYmxlfSB0b2tlbnNgLFxuXHRcdH0pO1xuXG5cdFx0dGhpcy5fZGVwcy5lbWl0KHtcblx0XHRcdHR5cGU6IFwiYXV0b19yZXRyeV9zdGFydFwiLFxuXHRcdFx0YXR0ZW1wdDogdGhpcy5fcmV0cnlBdHRlbXB0ICsgMSxcblx0XHRcdG1heEF0dGVtcHRzOiB0aGlzLl9kZXBzLnNldHRpbmdzTWFuYWdlci5nZXRSZXRyeVNldHRpbmdzKCkubWF4UmV0cmllcyxcblx0XHRcdGRlbGF5TXM6IDAsXG5cdFx0XHRlcnJvck1lc3NhZ2U6IGAke21lc3NhZ2UuZXJyb3JNZXNzYWdlfSAocmVkdWNpbmcgbWF4IHRva2VucylgLFxuXHRcdH0pO1xuXG5cdFx0dGhpcy5fc2NoZWR1bGVDb250aW51ZShyZXRyeUdlbmVyYXRpb24pO1xuXHRcdHJldHVybiB0cnVlO1xuXHR9XG5cblx0LyoqXG5cdCAqIEF0dGVtcHQgdG8gZG93bmdyYWRlIGEgbG9uZy1jb250ZXh0IG1vZGVsIChlLmcuIGNsYXVkZS1vcHVzLTQtNlsxbV0pIHRvIGl0c1xuXHQgKiBiYXNlIG1vZGVsIChjbGF1ZGUtb3B1cy00LTYpIHdoZW4gdGhlIGFjY291bnQgbGFja3MgdGhlIGxvbmctY29udGV4dCBiaWxsaW5nXG5cdCAqIGVudGl0bGVtZW50LiBSZXR1cm5zIHRydWUgaWYgdGhlIGRvd25ncmFkZSB3YXMgaW5pdGlhdGVkLlxuXHQgKi9cblx0cHJpdmF0ZSBfdHJ5TG9uZ0NvbnRleHREb3duZ3JhZGUobWVzc2FnZTogQXNzaXN0YW50TWVzc2FnZSwgcmV0cnlHZW5lcmF0aW9uOiBudW1iZXIpOiBib29sZWFuIHtcblx0XHRjb25zdCBjdXJyZW50TW9kZWwgPSB0aGlzLl9kZXBzLmdldE1vZGVsKCk7XG5cdFx0aWYgKCFjdXJyZW50TW9kZWwpIHJldHVybiBmYWxzZTtcblxuXHRcdC8vIE9ubHkgYXR0ZW1wdCBkb3duZ3JhZGUgZm9yIFsxbV0gKG9yIHNpbWlsYXIgbG9uZy1jb250ZXh0KSBtb2RlbCBJRHNcblx0XHRjb25zdCBtYXRjaCA9IGN1cnJlbnRNb2RlbC5pZC5tYXRjaCgvXiguKylcXFtcXGQrbVxcXSQvKTtcblx0XHRpZiAoIW1hdGNoKSByZXR1cm4gZmFsc2U7XG5cblx0XHRjb25zdCBiYXNlTW9kZWxJZCA9IG1hdGNoWzFdO1xuXHRcdGNvbnN0IGJhc2VNb2RlbCA9IHRoaXMuX2RlcHMubW9kZWxSZWdpc3RyeS5maW5kKGN1cnJlbnRNb2RlbC5wcm92aWRlciwgYmFzZU1vZGVsSWQpO1xuXHRcdGlmICghYmFzZU1vZGVsKSByZXR1cm4gZmFsc2U7XG5cblx0XHRjb25zdCBwcmV2aW91c0lkID0gY3VycmVudE1vZGVsLmlkO1xuXHRcdHRoaXMuX2RlcHMuYWdlbnQuc2V0TW9kZWwoYmFzZU1vZGVsKTtcblx0XHR0aGlzLl9kZXBzLm9uTW9kZWxDaGFuZ2UoYmFzZU1vZGVsKTtcblx0XHR0aGlzLl9yZW1vdmVMYXN0QXNzaXN0YW50RXJyb3IoKTtcblxuXHRcdHRoaXMuX2RlcHMuZW1pdCh7XG5cdFx0XHR0eXBlOiBcImZhbGxiYWNrX3Byb3ZpZGVyX3N3aXRjaFwiLFxuXHRcdFx0ZnJvbTogYCR7Y3VycmVudE1vZGVsLnByb3ZpZGVyfS8ke3ByZXZpb3VzSWR9YCxcblx0XHRcdHRvOiBgJHtiYXNlTW9kZWwucHJvdmlkZXJ9LyR7YmFzZU1vZGVsLmlkfWAsXG5cdFx0XHRyZWFzb246IGBsb25nIGNvbnRleHQgZG93bmdyYWRlOiAke3ByZXZpb3VzSWR9IFx1MjE5MiAke2Jhc2VNb2RlbC5pZH1gLFxuXHRcdH0pO1xuXG5cdFx0dGhpcy5fZGVwcy5lbWl0KHtcblx0XHRcdHR5cGU6IFwiYXV0b19yZXRyeV9zdGFydFwiLFxuXHRcdFx0YXR0ZW1wdDogdGhpcy5fcmV0cnlBdHRlbXB0ICsgMSxcblx0XHRcdG1heEF0dGVtcHRzOiB0aGlzLl9kZXBzLnNldHRpbmdzTWFuYWdlci5nZXRSZXRyeVNldHRpbmdzKCkubWF4UmV0cmllcyxcblx0XHRcdGRlbGF5TXM6IDAsXG5cdFx0XHRlcnJvck1lc3NhZ2U6IGAke21lc3NhZ2UuZXJyb3JNZXNzYWdlfSAobG9uZyBjb250ZXh0IGRvd25ncmFkZSlgLFxuXHRcdH0pO1xuXG5cdFx0dGhpcy5fc2NoZWR1bGVDb250aW51ZShyZXRyeUdlbmVyYXRpb24pO1xuXG5cdFx0cmV0dXJuIHRydWU7XG5cdH1cblxuXHQvKipcblx0ICogRGV0ZWN0IEFudGhyb3BpYyBzdWJzY3JpcHRpb24gYmxvY2sgZXJyb3JzICgjMzc3MikuXG5cdCAqIFRoZXNlIGFyZSBoYXJkIHBvbGljeSBibG9ja3MsIG5vdCB0cmFuc2llbnQgcmF0ZSBsaW1pdHMgXHUyMDE0IGNyZWRlbnRpYWxcblx0ICogcm90YXRpb24gd2lsbCBub3QgaGVscC4gTWF0Y2hlcyBib3RoIHRoZSBleHBsaWNpdCBcInRoaXJkLXBhcnR5XCIgbWVzc2FnZVxuXHQgKiBhbmQgdGhlIFwib3V0IG9mIGV4dHJhIHVzYWdlXCIgdmFyaWFudCB0aGF0IHN1YnNjcmlwdGlvbiB1c2VycyByZWNlaXZlLlxuXHQgKi9cblx0cHJpdmF0ZSBfaXNUaGlyZFBhcnR5QmxvY2soZXJyb3JNZXNzYWdlOiBzdHJpbmcpOiBib29sZWFuIHtcblx0XHRyZXR1cm4gL3RoaXJkWy0gLl1wYXJ0eS4qKD86ZHJhdyBmcm9tIGV4dHJhfG5vdC4qYXZhaWxhYmxlfHBsYW4gbGltaXRzfG5vdCBwZXJtaXR0ZWR8Y2Fubm90IGJlIHVzZWR8bm90IHN1cHBvcnRlZCl8KD86b3V0IG9mfG5vKSBleHRyYSB1c2FnZS9pLnRlc3QoZXJyb3JNZXNzYWdlKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBBdHRlbXB0IHRvIHN3aXRjaCB0byB0aGUgY2xhdWRlLWNvZGUgQ0xJIHByb3ZpZGVyIHdoZW4gdGhlIGN1cnJlbnRcblx0ICogQW50aHJvcGljIHByb3ZpZGVyIGlzIGJsb2NrZWQgYnkgdGhlIHRoaXJkLXBhcnR5IHBvbGljeSAoIzM3NzIpLlxuXHQgKiBSZXR1cm5zIHRydWUgaWYgdGhlIHN3aXRjaCB3YXMgbWFkZSBhbmQgcmV0cnkgc2NoZWR1bGVkLlxuXHQgKi9cblx0cHJpdmF0ZSBfdHJ5Q2xhdWRlQ29kZUZhbGxiYWNrKG1lc3NhZ2U6IEFzc2lzdGFudE1lc3NhZ2UsIHJldHJ5R2VuZXJhdGlvbjogbnVtYmVyKTogYm9vbGVhbiB7XG5cdFx0aWYgKCF0aGlzLl9kZXBzLmlzQ2xhdWRlQ29kZVJlYWR5Py4oKSkgcmV0dXJuIGZhbHNlO1xuXG5cdFx0Y29uc3QgY3VycmVudE1vZGVsID0gdGhpcy5fZGVwcy5nZXRNb2RlbCgpO1xuXHRcdGlmICghY3VycmVudE1vZGVsKSByZXR1cm4gZmFsc2U7XG5cblx0XHQvLyBPbmx5IGF0dGVtcHQgY2xhdWRlLWNvZGUgZmFsbGJhY2sgd2hlbiB0aGUgY3VycmVudCBwcm92aWRlciBpcyBhbnRocm9waWMuXG5cdFx0Ly8gVHJhbnNwb3J0LXNwZWNpZmljIChBRFItMDEyKTogaW50ZW50aW9uYWxseSBrZXlzIG9uIHByb3ZpZGVyLCBub3QgYXBpIFx1MjAxNFxuXHRcdC8vIHRoZSBmYWxsYmFjayBzcGVjaWZpY2FsbHkgcmVyb3V0ZXMgdGhlIHBsYWluIGBhbnRocm9waWNgIHRyYW5zcG9ydCB0b1xuXHRcdC8vIHRoZSBgY2xhdWRlLWNvZGVgIHRyYW5zcG9ydC4gT3RoZXIgQW50aHJvcGljLWZyb250aW5nIHRyYW5zcG9ydHNcblx0XHQvLyAoYW50aHJvcGljLXZlcnRleCwgYW1hem9uLWJlZHJvY2spIG11c3Qgbm90IGJlIHJlcm91dGVkLlxuXHRcdGlmIChjdXJyZW50TW9kZWwucHJvdmlkZXIgIT09IFwiYW50aHJvcGljXCIpIHJldHVybiBmYWxzZTtcblxuXHRcdC8vIEZpbmQgdGhlIHNhbWUgbW9kZWwgSUQgdW5kZXIgdGhlIGNsYXVkZS1jb2RlIHByb3ZpZGVyXG5cdFx0Y29uc3QgY2NNb2RlbCA9IHRoaXMuX2RlcHMubW9kZWxSZWdpc3RyeS5maW5kKFwiY2xhdWRlLWNvZGVcIiwgY3VycmVudE1vZGVsLmlkKTtcblx0XHRpZiAoIWNjTW9kZWwpIHJldHVybiBmYWxzZTtcblxuXHRcdGNvbnN0IHByZXZpb3VzUHJvdmlkZXIgPSBjdXJyZW50TW9kZWwucHJvdmlkZXI7XG5cdFx0dGhpcy5fZGVwcy5hZ2VudC5zZXRNb2RlbChjY01vZGVsKTtcblx0XHR0aGlzLl9kZXBzLm9uTW9kZWxDaGFuZ2UoY2NNb2RlbCk7XG5cdFx0dGhpcy5fcmVtb3ZlTGFzdEFzc2lzdGFudEVycm9yKCk7XG5cblx0XHR0aGlzLl9kZXBzLmVtaXQoe1xuXHRcdFx0dHlwZTogXCJmYWxsYmFja19wcm92aWRlcl9zd2l0Y2hcIixcblx0XHRcdGZyb206IGAke3ByZXZpb3VzUHJvdmlkZXJ9LyR7Y3VycmVudE1vZGVsLmlkfWAsXG5cdFx0XHR0bzogYGNsYXVkZS1jb2RlLyR7Y2NNb2RlbC5pZH1gLFxuXHRcdFx0cmVhc29uOiBcIkFudGhyb3BpYyBzdWJzY3JpcHRpb24gYmxvY2tlZCBmb3IgdGhpcmQtcGFydHkgYXBwcyBcdTIwMTQgcm91dGluZyB0aHJvdWdoIENsYXVkZSBDb2RlIENMSVwiLFxuXHRcdH0pO1xuXG5cdFx0dGhpcy5fZGVwcy5lbWl0KHtcblx0XHRcdHR5cGU6IFwiYXV0b19yZXRyeV9zdGFydFwiLFxuXHRcdFx0YXR0ZW1wdDogdGhpcy5fcmV0cnlBdHRlbXB0ICsgMSxcblx0XHRcdG1heEF0dGVtcHRzOiB0aGlzLl9kZXBzLnNldHRpbmdzTWFuYWdlci5nZXRSZXRyeVNldHRpbmdzKCkubWF4UmV0cmllcyxcblx0XHRcdGRlbGF5TXM6IDAsXG5cdFx0XHRlcnJvck1lc3NhZ2U6IGAke21lc3NhZ2UuZXJyb3JNZXNzYWdlfSAoc3dpdGNoaW5nIHRvIENsYXVkZSBDb2RlIENMSSlgLFxuXHRcdH0pO1xuXG5cdFx0dGhpcy5fc2NoZWR1bGVDb250aW51ZShyZXRyeUdlbmVyYXRpb24pO1xuXHRcdHJldHVybiB0cnVlO1xuXHR9XG5cblx0LyoqIFJlbW92ZSB0aGUgbGFzdCBhc3Npc3RhbnQgZXJyb3IgbWVzc2FnZSBmcm9tIGFnZW50IHN0YXRlICovXG5cdHByaXZhdGUgX3JlbW92ZUxhc3RBc3Npc3RhbnRFcnJvcigpOiB2b2lkIHtcblx0XHRjb25zdCBtZXNzYWdlcyA9IHRoaXMuX2RlcHMuYWdlbnQuc3RhdGUubWVzc2FnZXM7XG5cdFx0aWYgKG1lc3NhZ2VzLmxlbmd0aCA+IDAgJiYgbWVzc2FnZXNbbWVzc2FnZXMubGVuZ3RoIC0gMV0ucm9sZSA9PT0gXCJhc3Npc3RhbnRcIikge1xuXHRcdFx0dGhpcy5fZGVwcy5hZ2VudC5yZXBsYWNlTWVzc2FnZXMobWVzc2FnZXMuc2xpY2UoMCwgLTEpKTtcblx0XHR9XG5cdH1cbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQWFBLFNBQVMseUJBQXlCO0FBS2xDLFNBQVMsYUFBYTtBQUV0QixTQUFTLDBCQUEwQjtBQWtCNUIsTUFBTSxhQUFhO0FBQUEsRUFRekIsWUFBNkIsT0FBeUI7QUFBekI7QUFQN0IsU0FBUSx3QkFBcUQ7QUFDN0QsU0FBUSxnQkFBZ0I7QUFDeEIsU0FBUSxnQkFBMkM7QUFDbkQsU0FBUSxnQkFBMEM7QUFDbEQsU0FBUSxtQkFBbUI7QUFDM0IsU0FBUSxtQkFBOEQ7QUFBQSxFQUVmO0FBQUE7QUFBQSxFQUd2RCxJQUFJLGVBQXVCO0FBQzFCLFdBQU8sS0FBSztBQUFBLEVBQ2I7QUFBQTtBQUFBLEVBR0EsSUFBSSxhQUFzQjtBQUN6QixXQUFPLEtBQUssa0JBQWtCO0FBQUEsRUFD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
