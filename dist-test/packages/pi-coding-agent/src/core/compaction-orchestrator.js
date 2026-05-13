import { isContextOverflow } from "@gsd/pi-ai";
import {
  CompactionProducedNoSummaryError,
  calculateContextTokens,
  compact,
  estimateContextTokens,
  prepareCompaction,
  shouldCompact
} from "./compaction/index.js";
import { getLatestCompactionEntry } from "./session-manager.js";
import { getErrorMessage } from "../utils/error.js";
class CompactionOrchestrator {
  constructor(_deps) {
    this._deps = _deps;
    this._compactionAbortController = void 0;
    this._autoCompactionAbortController = void 0;
    this._overflowRecoveryAttempted = false;
    this._branchSummaryAbortController = void 0;
  }
  /** Whether compaction or branch summarization is currently running */
  get isCompacting() {
    return this._autoCompactionAbortController !== void 0 || this._compactionAbortController !== void 0 || this._branchSummaryAbortController !== void 0;
  }
  /** Reset overflow recovery flag (called when a new user message starts) */
  resetOverflowRecovery() {
    this._overflowRecoveryAttempted = false;
  }
  /** Mark overflow recovery as not needed (called on successful assistant response) */
  clearOverflowRecovery() {
    this._overflowRecoveryAttempted = false;
  }
  /** Get/set the branch summary abort controller (used by navigateTree) */
  get branchSummaryAbortController() {
    return this._branchSummaryAbortController;
  }
  set branchSummaryAbortController(controller) {
    this._branchSummaryAbortController = controller;
  }
  /**
   * Manually compact the session context.
   * Aborts current agent operation first.
   * @param customInstructions Optional instructions for the compaction summary
   */
  async compact(customInstructions) {
    this._deps.disconnectFromAgent();
    await this._deps.abort();
    this._compactionAbortController = new AbortController();
    try {
      const model = this._deps.getModel();
      if (!model) {
        throw new Error("No model selected");
      }
      if (!this._deps.modelRegistry.isProviderRequestReady(model.provider)) {
        throw new Error(`No API key for ${model.provider}`);
      }
      const apiKey = await this._deps.modelRegistry.getApiKey(model, this._deps.getSessionId());
      const pathEntries = this._deps.sessionManager.getBranch();
      const settings = this._deps.settingsManager.getCompactionSettings();
      const preparation = prepareCompaction(pathEntries, settings);
      if (!preparation) {
        const lastEntry = pathEntries[pathEntries.length - 1];
        if (lastEntry?.type === "compaction") {
          throw new Error("Already compacted");
        }
        throw new Error("Nothing to compact (session too small)");
      }
      let extensionCompaction;
      let fromExtension = false;
      const extensionRunner = this._deps.getExtensionRunner();
      if (extensionRunner?.hasHandlers("session_before_compact")) {
        const result = await extensionRunner.emit({
          type: "session_before_compact",
          preparation,
          branchEntries: pathEntries,
          customInstructions,
          signal: this._compactionAbortController.signal
        });
        if (result?.cancel) {
          throw new Error("Compaction cancelled");
        }
        if (result?.compaction) {
          extensionCompaction = result.compaction;
          fromExtension = true;
        }
      }
      let summary;
      let firstKeptEntryId;
      let tokensBefore;
      let details;
      if (extensionCompaction) {
        summary = extensionCompaction.summary;
        firstKeptEntryId = extensionCompaction.firstKeptEntryId;
        tokensBefore = extensionCompaction.tokensBefore;
        details = extensionCompaction.details;
      } else {
        const result = await compact(
          preparation,
          model,
          apiKey,
          customInstructions,
          this._compactionAbortController.signal
        );
        summary = result.summary;
        firstKeptEntryId = result.firstKeptEntryId;
        tokensBefore = result.tokensBefore;
        details = result.details;
      }
      if (this._compactionAbortController.signal.aborted) {
        throw new Error("Compaction cancelled");
      }
      this._deps.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension);
      const newEntries = this._deps.sessionManager.getEntries();
      const sessionContext = this._deps.sessionManager.buildSessionContext();
      this._deps.agent.replaceMessages(sessionContext.messages);
      const savedCompactionEntry = newEntries.find(
        (e) => e.type === "compaction" && e.summary === summary
      );
      if (extensionRunner && savedCompactionEntry) {
        await extensionRunner.emit({
          type: "session_compact",
          compactionEntry: savedCompactionEntry,
          fromExtension
        });
      }
      return { summary, firstKeptEntryId, tokensBefore, details };
    } finally {
      this._compactionAbortController = void 0;
      this._deps.reconnectToAgent();
    }
  }
  /** Cancel in-progress compaction (manual or auto) */
  abortCompaction() {
    this._compactionAbortController?.abort();
    this._autoCompactionAbortController?.abort();
  }
  /** Cancel in-progress branch summarization */
  abortBranchSummary() {
    this._branchSummaryAbortController?.abort();
  }
  /**
   * Check if compaction is needed and run it.
   * Called after agent_end and before prompt submission.
   *
   * Two cases:
   * 1. Overflow: LLM returned context overflow error, remove error message, compact, auto-retry
   * 2. Threshold: Context over threshold, compact, NO auto-retry
   *
   * @param assistantMessage The assistant message to check
   * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
   */
  async checkCompaction(assistantMessage, skipAbortedCheck = true) {
    const settings = this._deps.settingsManager.getCompactionSettings();
    if (!settings.enabled) return;
    if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return;
    const model = this._deps.getModel();
    const contextWindow = model?.contextWindow ?? 0;
    const sameModel = model && assistantMessage.provider === model.provider && assistantMessage.model === model.id;
    const branchEntries = this._deps.sessionManager.getBranch();
    const compactionEntry = getLatestCompactionEntry(branchEntries);
    const assistantIsFromBeforeCompaction = compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
    if (assistantIsFromBeforeCompaction) return;
    if (sameModel && isContextOverflow(assistantMessage, contextWindow)) {
      if (this._overflowRecoveryAttempted) {
        this._deps.emit({
          type: "auto_compaction_end",
          result: void 0,
          aborted: false,
          willRetry: false,
          errorMessage: "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model."
        });
        return;
      }
      this._overflowRecoveryAttempted = true;
      const messages = this._deps.agent.state.messages;
      if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
        this._deps.agent.replaceMessages(messages.slice(0, -1));
      }
      await this._runAutoCompaction("overflow", true);
      return;
    }
    let contextTokens;
    if (assistantMessage.stopReason === "error") {
      const messages = this._deps.agent.state.messages;
      const estimate = estimateContextTokens(messages);
      if (estimate.lastUsageIndex === null) return;
      const usageMsg = messages[estimate.lastUsageIndex];
      if (compactionEntry && usageMsg.role === "assistant" && usageMsg.timestamp <= new Date(compactionEntry.timestamp).getTime()) {
        return;
      }
      contextTokens = estimate.tokens;
    } else {
      contextTokens = calculateContextTokens(assistantMessage.usage);
    }
    if (shouldCompact(contextTokens, contextWindow, settings)) {
      await this._runAutoCompaction("threshold", false);
    }
  }
  /** Toggle auto-compaction setting */
  setAutoCompactionEnabled(enabled) {
    this._deps.settingsManager.setCompactionEnabled(enabled);
  }
  /** Whether auto-compaction is enabled */
  get autoCompactionEnabled() {
    return this._deps.settingsManager.getCompactionEnabled();
  }
  // =========================================================================
  // Private helpers
  // =========================================================================
  async _runAutoCompaction(reason, willRetry) {
    const settings = this._deps.settingsManager.getCompactionSettings();
    this._deps.emit({ type: "auto_compaction_start", reason });
    this._autoCompactionAbortController = new AbortController();
    try {
      const model = this._deps.getModel();
      if (!model) {
        this._deps.emit({ type: "auto_compaction_end", result: void 0, aborted: false, willRetry: false });
        return;
      }
      if (!this._deps.modelRegistry.isProviderRequestReady(model.provider)) {
        this._deps.emit({ type: "auto_compaction_end", result: void 0, aborted: false, willRetry: false });
        return;
      }
      const apiKey = await this._deps.modelRegistry.getApiKey(model, this._deps.getSessionId());
      const pathEntries = this._deps.sessionManager.getBranch();
      const preparation = prepareCompaction(pathEntries, settings);
      if (!preparation) {
        this._deps.emit({ type: "auto_compaction_end", result: void 0, aborted: false, willRetry: false });
        return;
      }
      let extensionCompaction;
      let fromExtension = false;
      const extensionRunner = this._deps.getExtensionRunner();
      if (extensionRunner?.hasHandlers("session_before_compact")) {
        const extensionResult = await extensionRunner.emit({
          type: "session_before_compact",
          preparation,
          branchEntries: pathEntries,
          customInstructions: void 0,
          signal: this._autoCompactionAbortController.signal
        });
        if (extensionResult?.cancel) {
          this._deps.emit({
            type: "auto_compaction_end",
            result: void 0,
            aborted: true,
            willRetry
          });
          this._scheduleAutoCompactionFollowup(willRetry);
          return;
        }
        if (extensionResult?.compaction) {
          extensionCompaction = extensionResult.compaction;
          fromExtension = true;
        }
      }
      let summary;
      let firstKeptEntryId;
      let tokensBefore;
      let details;
      if (extensionCompaction) {
        summary = extensionCompaction.summary;
        firstKeptEntryId = extensionCompaction.firstKeptEntryId;
        tokensBefore = extensionCompaction.tokensBefore;
        details = extensionCompaction.details;
      } else {
        const compactResult = await compact(
          preparation,
          model,
          apiKey,
          void 0,
          this._autoCompactionAbortController.signal
        );
        summary = compactResult.summary;
        firstKeptEntryId = compactResult.firstKeptEntryId;
        tokensBefore = compactResult.tokensBefore;
        details = compactResult.details;
      }
      if (this._autoCompactionAbortController.signal.aborted) {
        this._deps.emit({ type: "auto_compaction_end", result: void 0, aborted: true, willRetry: false });
        return;
      }
      this._deps.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension);
      const newEntries = this._deps.sessionManager.getEntries();
      const sessionContext = this._deps.sessionManager.buildSessionContext();
      this._deps.agent.replaceMessages(sessionContext.messages);
      const savedCompactionEntry = newEntries.find(
        (e) => e.type === "compaction" && e.summary === summary
      );
      if (extensionRunner && savedCompactionEntry) {
        await extensionRunner.emit({
          type: "session_compact",
          compactionEntry: savedCompactionEntry,
          fromExtension
        });
      }
      const result = { summary, firstKeptEntryId, tokensBefore, details };
      this._deps.emit({ type: "auto_compaction_end", result, aborted: false, willRetry });
      this._scheduleAutoCompactionFollowup(willRetry);
    } catch (error) {
      const errorMessage = error instanceof CompactionProducedNoSummaryError ? `Compaction produced no usable summary \u2014 session history preserved as-is. (${error.message})` : getErrorMessage(error);
      this._deps.emit({
        type: "auto_compaction_end",
        result: void 0,
        aborted: false,
        willRetry: false,
        errorMessage: reason === "overflow" ? `Context overflow recovery failed: ${errorMessage}` : `Auto-compaction failed: ${errorMessage}`
      });
    } finally {
      this._autoCompactionAbortController = void 0;
    }
  }
  _scheduleAutoCompactionFollowup(willRetry) {
    if (willRetry) {
      const messages = this._deps.agent.state.messages;
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.role === "assistant" && lastMsg.stopReason === "error") {
        this._deps.agent.replaceMessages(messages.slice(0, -1));
      }
      setTimeout(() => {
        this._deps.agent.continue().catch(() => {
        });
      }, 100);
      return;
    }
    if (this._deps.agent.hasQueuedMessages()) {
      setTimeout(() => {
        this._deps.agent.continue().catch(() => {
        });
      }, 100);
    }
  }
}
export {
  CompactionOrchestrator
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL2NvbXBhY3Rpb24tb3JjaGVzdHJhdG9yLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIENvbXBhY3Rpb25PcmNoZXN0cmF0b3IgLSBNYW5hZ2VzIG1hbnVhbCBhbmQgYXV0b21hdGljIGNvbnRleHQgY29tcGFjdGlvbi5cbiAqXG4gKiBIYW5kbGVzOlxuICogLSBNYW51YWwgY29tcGFjdGlvbiAodXNlci10cmlnZ2VyZWQgL2NvbXBhY3QpXG4gKiAtIEF1dG8tY29tcGFjdGlvbiB3aGVuIGNvbnRleHQgZXhjZWVkcyB0aHJlc2hvbGRcbiAqIC0gT3ZlcmZsb3cgcmVjb3Zlcnkgd2hlbiBMTE0gcmV0dXJucyBjb250ZXh0IG92ZXJmbG93IGVycm9yc1xuICogLSBFeHRlbnNpb24gaW50ZWdyYXRpb24gZm9yIGN1c3RvbSBjb21wYWN0aW9uIHByb3ZpZGVyc1xuICogLSBCcmFuY2ggc3VtbWFyaXphdGlvbiBhYm9ydCBjb29yZGluYXRpb25cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEFnZW50IH0gZnJvbSBcIkBnc2QvcGktYWdlbnQtY29yZVwiO1xuaW1wb3J0IHR5cGUgeyBBc3Npc3RhbnRNZXNzYWdlLCBNb2RlbCB9IGZyb20gXCJAZ3NkL3BpLWFpXCI7XG5pbXBvcnQgeyBpc0NvbnRleHRPdmVyZmxvdyB9IGZyb20gXCJAZ3NkL3BpLWFpXCI7XG5pbXBvcnQge1xuXHR0eXBlIENvbXBhY3Rpb25SZXN1bHQsXG5cdENvbXBhY3Rpb25Qcm9kdWNlZE5vU3VtbWFyeUVycm9yLFxuXHRjYWxjdWxhdGVDb250ZXh0VG9rZW5zLFxuXHRjb21wYWN0LFxuXHRlc3RpbWF0ZUNvbnRleHRUb2tlbnMsXG5cdHByZXBhcmVDb21wYWN0aW9uLFxuXHRzaG91bGRDb21wYWN0LFxufSBmcm9tIFwiLi9jb21wYWN0aW9uL2luZGV4LmpzXCI7XG5pbXBvcnQgdHlwZSB7IEV4dGVuc2lvblJ1bm5lciwgU2Vzc2lvbkJlZm9yZUNvbXBhY3RSZXN1bHQgfSBmcm9tIFwiLi9leHRlbnNpb25zL2luZGV4LmpzXCI7XG5pbXBvcnQgdHlwZSB7IE1vZGVsUmVnaXN0cnkgfSBmcm9tIFwiLi9tb2RlbC1yZWdpc3RyeS5qc1wiO1xuaW1wb3J0IHsgZ2V0TGF0ZXN0Q29tcGFjdGlvbkVudHJ5IH0gZnJvbSBcIi4vc2Vzc2lvbi1tYW5hZ2VyLmpzXCI7XG5pbXBvcnQgdHlwZSB7IENvbXBhY3Rpb25FbnRyeSwgU2Vzc2lvbk1hbmFnZXIgfSBmcm9tIFwiLi9zZXNzaW9uLW1hbmFnZXIuanNcIjtcbmltcG9ydCB0eXBlIHsgU2V0dGluZ3NNYW5hZ2VyIH0gZnJvbSBcIi4vc2V0dGluZ3MtbWFuYWdlci5qc1wiO1xuaW1wb3J0IHR5cGUgeyBBZ2VudFNlc3Npb25FdmVudCB9IGZyb20gXCIuL2FnZW50LXNlc3Npb24uanNcIjtcbmltcG9ydCB7IGdldEVycm9yTWVzc2FnZSB9IGZyb20gXCIuLi91dGlscy9lcnJvci5qc1wiO1xuXG4vKiogRGVwZW5kZW5jaWVzIGluamVjdGVkIGZyb20gQWdlbnRTZXNzaW9uIGludG8gQ29tcGFjdGlvbk9yY2hlc3RyYXRvciAqL1xuZXhwb3J0IGludGVyZmFjZSBDb21wYWN0aW9uT3JjaGVzdHJhdG9yRGVwcyB7XG5cdHJlYWRvbmx5IGFnZW50OiBBZ2VudDtcblx0cmVhZG9ubHkgc2Vzc2lvbk1hbmFnZXI6IFNlc3Npb25NYW5hZ2VyO1xuXHRyZWFkb25seSBzZXR0aW5nc01hbmFnZXI6IFNldHRpbmdzTWFuYWdlcjtcblx0cmVhZG9ubHkgbW9kZWxSZWdpc3RyeTogTW9kZWxSZWdpc3RyeTtcblx0Z2V0TW9kZWw6ICgpID0+IE1vZGVsPGFueT4gfCB1bmRlZmluZWQ7XG5cdGdldFNlc3Npb25JZDogKCkgPT4gc3RyaW5nO1xuXHRnZXRFeHRlbnNpb25SdW5uZXI6ICgpID0+IEV4dGVuc2lvblJ1bm5lciB8IHVuZGVmaW5lZDtcblx0ZW1pdDogKGV2ZW50OiBBZ2VudFNlc3Npb25FdmVudCkgPT4gdm9pZDtcblx0ZGlzY29ubmVjdEZyb21BZ2VudDogKCkgPT4gdm9pZDtcblx0cmVjb25uZWN0VG9BZ2VudDogKCkgPT4gdm9pZDtcblx0YWJvcnQ6ICgpID0+IFByb21pc2U8dm9pZD47XG59XG5cbmV4cG9ydCBjbGFzcyBDb21wYWN0aW9uT3JjaGVzdHJhdG9yIHtcblx0cHJpdmF0ZSBfY29tcGFjdGlvbkFib3J0Q29udHJvbGxlcjogQWJvcnRDb250cm9sbGVyIHwgdW5kZWZpbmVkID0gdW5kZWZpbmVkO1xuXHRwcml2YXRlIF9hdXRvQ29tcGFjdGlvbkFib3J0Q29udHJvbGxlcjogQWJvcnRDb250cm9sbGVyIHwgdW5kZWZpbmVkID0gdW5kZWZpbmVkO1xuXHRwcml2YXRlIF9vdmVyZmxvd1JlY292ZXJ5QXR0ZW1wdGVkID0gZmFsc2U7XG5cdHByaXZhdGUgX2JyYW5jaFN1bW1hcnlBYm9ydENvbnRyb2xsZXI6IEFib3J0Q29udHJvbGxlciB8IHVuZGVmaW5lZCA9IHVuZGVmaW5lZDtcblxuXHRjb25zdHJ1Y3Rvcihwcml2YXRlIHJlYWRvbmx5IF9kZXBzOiBDb21wYWN0aW9uT3JjaGVzdHJhdG9yRGVwcykge31cblxuXHQvKiogV2hldGhlciBjb21wYWN0aW9uIG9yIGJyYW5jaCBzdW1tYXJpemF0aW9uIGlzIGN1cnJlbnRseSBydW5uaW5nICovXG5cdGdldCBpc0NvbXBhY3RpbmcoKTogYm9vbGVhbiB7XG5cdFx0cmV0dXJuIChcblx0XHRcdHRoaXMuX2F1dG9Db21wYWN0aW9uQWJvcnRDb250cm9sbGVyICE9PSB1bmRlZmluZWQgfHxcblx0XHRcdHRoaXMuX2NvbXBhY3Rpb25BYm9ydENvbnRyb2xsZXIgIT09IHVuZGVmaW5lZCB8fFxuXHRcdFx0dGhpcy5fYnJhbmNoU3VtbWFyeUFib3J0Q29udHJvbGxlciAhPT0gdW5kZWZpbmVkXG5cdFx0KTtcblx0fVxuXG5cdC8qKiBSZXNldCBvdmVyZmxvdyByZWNvdmVyeSBmbGFnIChjYWxsZWQgd2hlbiBhIG5ldyB1c2VyIG1lc3NhZ2Ugc3RhcnRzKSAqL1xuXHRyZXNldE92ZXJmbG93UmVjb3ZlcnkoKTogdm9pZCB7XG5cdFx0dGhpcy5fb3ZlcmZsb3dSZWNvdmVyeUF0dGVtcHRlZCA9IGZhbHNlO1xuXHR9XG5cblx0LyoqIE1hcmsgb3ZlcmZsb3cgcmVjb3ZlcnkgYXMgbm90IG5lZWRlZCAoY2FsbGVkIG9uIHN1Y2Nlc3NmdWwgYXNzaXN0YW50IHJlc3BvbnNlKSAqL1xuXHRjbGVhck92ZXJmbG93UmVjb3ZlcnkoKTogdm9pZCB7XG5cdFx0dGhpcy5fb3ZlcmZsb3dSZWNvdmVyeUF0dGVtcHRlZCA9IGZhbHNlO1xuXHR9XG5cblx0LyoqIEdldC9zZXQgdGhlIGJyYW5jaCBzdW1tYXJ5IGFib3J0IGNvbnRyb2xsZXIgKHVzZWQgYnkgbmF2aWdhdGVUcmVlKSAqL1xuXHRnZXQgYnJhbmNoU3VtbWFyeUFib3J0Q29udHJvbGxlcigpOiBBYm9ydENvbnRyb2xsZXIgfCB1bmRlZmluZWQge1xuXHRcdHJldHVybiB0aGlzLl9icmFuY2hTdW1tYXJ5QWJvcnRDb250cm9sbGVyO1xuXHR9XG5cdHNldCBicmFuY2hTdW1tYXJ5QWJvcnRDb250cm9sbGVyKGNvbnRyb2xsZXI6IEFib3J0Q29udHJvbGxlciB8IHVuZGVmaW5lZCkge1xuXHRcdHRoaXMuX2JyYW5jaFN1bW1hcnlBYm9ydENvbnRyb2xsZXIgPSBjb250cm9sbGVyO1xuXHR9XG5cblx0LyoqXG5cdCAqIE1hbnVhbGx5IGNvbXBhY3QgdGhlIHNlc3Npb24gY29udGV4dC5cblx0ICogQWJvcnRzIGN1cnJlbnQgYWdlbnQgb3BlcmF0aW9uIGZpcnN0LlxuXHQgKiBAcGFyYW0gY3VzdG9tSW5zdHJ1Y3Rpb25zIE9wdGlvbmFsIGluc3RydWN0aW9ucyBmb3IgdGhlIGNvbXBhY3Rpb24gc3VtbWFyeVxuXHQgKi9cblx0YXN5bmMgY29tcGFjdChjdXN0b21JbnN0cnVjdGlvbnM/OiBzdHJpbmcpOiBQcm9taXNlPENvbXBhY3Rpb25SZXN1bHQ+IHtcblx0XHR0aGlzLl9kZXBzLmRpc2Nvbm5lY3RGcm9tQWdlbnQoKTtcblx0XHRhd2FpdCB0aGlzLl9kZXBzLmFib3J0KCk7XG5cdFx0dGhpcy5fY29tcGFjdGlvbkFib3J0Q29udHJvbGxlciA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcblxuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBtb2RlbCA9IHRoaXMuX2RlcHMuZ2V0TW9kZWwoKTtcblx0XHRcdGlmICghbW9kZWwpIHtcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKFwiTm8gbW9kZWwgc2VsZWN0ZWRcIik7XG5cdFx0XHR9XG5cblx0XHRcdGlmICghdGhpcy5fZGVwcy5tb2RlbFJlZ2lzdHJ5LmlzUHJvdmlkZXJSZXF1ZXN0UmVhZHkobW9kZWwucHJvdmlkZXIpKSB7XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcihgTm8gQVBJIGtleSBmb3IgJHttb2RlbC5wcm92aWRlcn1gKTtcblx0XHRcdH1cblx0XHRcdC8vIHVuZGVmaW5lZCBmb3IgZXh0ZXJuYWxDbGkvbm9uZSBwcm92aWRlcnMgXHUyMDE0IHN0cmlwcGVkIGF0IHRoZSBzdHJlYW1TaW1wbGUgYm91bmRhcnkgKG1vZGVsLXJlZ2lzdHJ5LnRzKVxuXHRcdFx0Y29uc3QgYXBpS2V5ID0gYXdhaXQgdGhpcy5fZGVwcy5tb2RlbFJlZ2lzdHJ5LmdldEFwaUtleShtb2RlbCwgdGhpcy5fZGVwcy5nZXRTZXNzaW9uSWQoKSk7XG5cblx0XHRcdGNvbnN0IHBhdGhFbnRyaWVzID0gdGhpcy5fZGVwcy5zZXNzaW9uTWFuYWdlci5nZXRCcmFuY2goKTtcblx0XHRcdGNvbnN0IHNldHRpbmdzID0gdGhpcy5fZGVwcy5zZXR0aW5nc01hbmFnZXIuZ2V0Q29tcGFjdGlvblNldHRpbmdzKCk7XG5cblx0XHRcdGNvbnN0IHByZXBhcmF0aW9uID0gcHJlcGFyZUNvbXBhY3Rpb24ocGF0aEVudHJpZXMsIHNldHRpbmdzKTtcblx0XHRcdGlmICghcHJlcGFyYXRpb24pIHtcblx0XHRcdFx0Y29uc3QgbGFzdEVudHJ5ID0gcGF0aEVudHJpZXNbcGF0aEVudHJpZXMubGVuZ3RoIC0gMV07XG5cdFx0XHRcdGlmIChsYXN0RW50cnk/LnR5cGUgPT09IFwiY29tcGFjdGlvblwiKSB7XG5cdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKFwiQWxyZWFkeSBjb21wYWN0ZWRcIik7XG5cdFx0XHRcdH1cblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKFwiTm90aGluZyB0byBjb21wYWN0IChzZXNzaW9uIHRvbyBzbWFsbClcIik7XG5cdFx0XHR9XG5cblx0XHRcdGxldCBleHRlbnNpb25Db21wYWN0aW9uOiBDb21wYWN0aW9uUmVzdWx0IHwgdW5kZWZpbmVkO1xuXHRcdFx0bGV0IGZyb21FeHRlbnNpb24gPSBmYWxzZTtcblx0XHRcdGNvbnN0IGV4dGVuc2lvblJ1bm5lciA9IHRoaXMuX2RlcHMuZ2V0RXh0ZW5zaW9uUnVubmVyKCk7XG5cblx0XHRcdGlmIChleHRlbnNpb25SdW5uZXI/Lmhhc0hhbmRsZXJzKFwic2Vzc2lvbl9iZWZvcmVfY29tcGFjdFwiKSkge1xuXHRcdFx0XHRjb25zdCByZXN1bHQgPSAoYXdhaXQgZXh0ZW5zaW9uUnVubmVyLmVtaXQoe1xuXHRcdFx0XHRcdHR5cGU6IFwic2Vzc2lvbl9iZWZvcmVfY29tcGFjdFwiLFxuXHRcdFx0XHRcdHByZXBhcmF0aW9uLFxuXHRcdFx0XHRcdGJyYW5jaEVudHJpZXM6IHBhdGhFbnRyaWVzLFxuXHRcdFx0XHRcdGN1c3RvbUluc3RydWN0aW9ucyxcblx0XHRcdFx0XHRzaWduYWw6IHRoaXMuX2NvbXBhY3Rpb25BYm9ydENvbnRyb2xsZXIuc2lnbmFsLFxuXHRcdFx0XHR9KSkgYXMgU2Vzc2lvbkJlZm9yZUNvbXBhY3RSZXN1bHQgfCB1bmRlZmluZWQ7XG5cblx0XHRcdFx0aWYgKHJlc3VsdD8uY2FuY2VsKSB7XG5cdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKFwiQ29tcGFjdGlvbiBjYW5jZWxsZWRcIik7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRpZiAocmVzdWx0Py5jb21wYWN0aW9uKSB7XG5cdFx0XHRcdFx0ZXh0ZW5zaW9uQ29tcGFjdGlvbiA9IHJlc3VsdC5jb21wYWN0aW9uO1xuXHRcdFx0XHRcdGZyb21FeHRlbnNpb24gPSB0cnVlO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdGxldCBzdW1tYXJ5OiBzdHJpbmc7XG5cdFx0XHRsZXQgZmlyc3RLZXB0RW50cnlJZDogc3RyaW5nO1xuXHRcdFx0bGV0IHRva2Vuc0JlZm9yZTogbnVtYmVyO1xuXHRcdFx0bGV0IGRldGFpbHM6IHVua25vd247XG5cblx0XHRcdGlmIChleHRlbnNpb25Db21wYWN0aW9uKSB7XG5cdFx0XHRcdHN1bW1hcnkgPSBleHRlbnNpb25Db21wYWN0aW9uLnN1bW1hcnk7XG5cdFx0XHRcdGZpcnN0S2VwdEVudHJ5SWQgPSBleHRlbnNpb25Db21wYWN0aW9uLmZpcnN0S2VwdEVudHJ5SWQ7XG5cdFx0XHRcdHRva2Vuc0JlZm9yZSA9IGV4dGVuc2lvbkNvbXBhY3Rpb24udG9rZW5zQmVmb3JlO1xuXHRcdFx0XHRkZXRhaWxzID0gZXh0ZW5zaW9uQ29tcGFjdGlvbi5kZXRhaWxzO1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgY29tcGFjdChcblx0XHRcdFx0XHRwcmVwYXJhdGlvbixcblx0XHRcdFx0XHRtb2RlbCxcblx0XHRcdFx0XHRhcGlLZXksXG5cdFx0XHRcdFx0Y3VzdG9tSW5zdHJ1Y3Rpb25zLFxuXHRcdFx0XHRcdHRoaXMuX2NvbXBhY3Rpb25BYm9ydENvbnRyb2xsZXIuc2lnbmFsLFxuXHRcdFx0XHQpO1xuXHRcdFx0XHRzdW1tYXJ5ID0gcmVzdWx0LnN1bW1hcnk7XG5cdFx0XHRcdGZpcnN0S2VwdEVudHJ5SWQgPSByZXN1bHQuZmlyc3RLZXB0RW50cnlJZDtcblx0XHRcdFx0dG9rZW5zQmVmb3JlID0gcmVzdWx0LnRva2Vuc0JlZm9yZTtcblx0XHRcdFx0ZGV0YWlscyA9IHJlc3VsdC5kZXRhaWxzO1xuXHRcdFx0fVxuXG5cdFx0XHRpZiAodGhpcy5fY29tcGFjdGlvbkFib3J0Q29udHJvbGxlci5zaWduYWwuYWJvcnRlZCkge1xuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoXCJDb21wYWN0aW9uIGNhbmNlbGxlZFwiKTtcblx0XHRcdH1cblxuXHRcdFx0dGhpcy5fZGVwcy5zZXNzaW9uTWFuYWdlci5hcHBlbmRDb21wYWN0aW9uKHN1bW1hcnksIGZpcnN0S2VwdEVudHJ5SWQsIHRva2Vuc0JlZm9yZSwgZGV0YWlscywgZnJvbUV4dGVuc2lvbik7XG5cdFx0XHRjb25zdCBuZXdFbnRyaWVzID0gdGhpcy5fZGVwcy5zZXNzaW9uTWFuYWdlci5nZXRFbnRyaWVzKCk7XG5cdFx0XHRjb25zdCBzZXNzaW9uQ29udGV4dCA9IHRoaXMuX2RlcHMuc2Vzc2lvbk1hbmFnZXIuYnVpbGRTZXNzaW9uQ29udGV4dCgpO1xuXHRcdFx0dGhpcy5fZGVwcy5hZ2VudC5yZXBsYWNlTWVzc2FnZXMoc2Vzc2lvbkNvbnRleHQubWVzc2FnZXMpO1xuXG5cdFx0XHRjb25zdCBzYXZlZENvbXBhY3Rpb25FbnRyeSA9IG5ld0VudHJpZXMuZmluZChcblx0XHRcdFx0KGUpID0+IGUudHlwZSA9PT0gXCJjb21wYWN0aW9uXCIgJiYgZS5zdW1tYXJ5ID09PSBzdW1tYXJ5LFxuXHRcdFx0KSBhcyBDb21wYWN0aW9uRW50cnkgfCB1bmRlZmluZWQ7XG5cblx0XHRcdGlmIChleHRlbnNpb25SdW5uZXIgJiYgc2F2ZWRDb21wYWN0aW9uRW50cnkpIHtcblx0XHRcdFx0YXdhaXQgZXh0ZW5zaW9uUnVubmVyLmVtaXQoe1xuXHRcdFx0XHRcdHR5cGU6IFwic2Vzc2lvbl9jb21wYWN0XCIsXG5cdFx0XHRcdFx0Y29tcGFjdGlvbkVudHJ5OiBzYXZlZENvbXBhY3Rpb25FbnRyeSxcblx0XHRcdFx0XHRmcm9tRXh0ZW5zaW9uLFxuXHRcdFx0XHR9KTtcblx0XHRcdH1cblxuXHRcdFx0cmV0dXJuIHsgc3VtbWFyeSwgZmlyc3RLZXB0RW50cnlJZCwgdG9rZW5zQmVmb3JlLCBkZXRhaWxzIH07XG5cdFx0fSBmaW5hbGx5IHtcblx0XHRcdHRoaXMuX2NvbXBhY3Rpb25BYm9ydENvbnRyb2xsZXIgPSB1bmRlZmluZWQ7XG5cdFx0XHR0aGlzLl9kZXBzLnJlY29ubmVjdFRvQWdlbnQoKTtcblx0XHR9XG5cdH1cblxuXHQvKiogQ2FuY2VsIGluLXByb2dyZXNzIGNvbXBhY3Rpb24gKG1hbnVhbCBvciBhdXRvKSAqL1xuXHRhYm9ydENvbXBhY3Rpb24oKTogdm9pZCB7XG5cdFx0dGhpcy5fY29tcGFjdGlvbkFib3J0Q29udHJvbGxlcj8uYWJvcnQoKTtcblx0XHR0aGlzLl9hdXRvQ29tcGFjdGlvbkFib3J0Q29udHJvbGxlcj8uYWJvcnQoKTtcblx0fVxuXG5cdC8qKiBDYW5jZWwgaW4tcHJvZ3Jlc3MgYnJhbmNoIHN1bW1hcml6YXRpb24gKi9cblx0YWJvcnRCcmFuY2hTdW1tYXJ5KCk6IHZvaWQge1xuXHRcdHRoaXMuX2JyYW5jaFN1bW1hcnlBYm9ydENvbnRyb2xsZXI/LmFib3J0KCk7XG5cdH1cblxuXHQvKipcblx0ICogQ2hlY2sgaWYgY29tcGFjdGlvbiBpcyBuZWVkZWQgYW5kIHJ1biBpdC5cblx0ICogQ2FsbGVkIGFmdGVyIGFnZW50X2VuZCBhbmQgYmVmb3JlIHByb21wdCBzdWJtaXNzaW9uLlxuXHQgKlxuXHQgKiBUd28gY2FzZXM6XG5cdCAqIDEuIE92ZXJmbG93OiBMTE0gcmV0dXJuZWQgY29udGV4dCBvdmVyZmxvdyBlcnJvciwgcmVtb3ZlIGVycm9yIG1lc3NhZ2UsIGNvbXBhY3QsIGF1dG8tcmV0cnlcblx0ICogMi4gVGhyZXNob2xkOiBDb250ZXh0IG92ZXIgdGhyZXNob2xkLCBjb21wYWN0LCBOTyBhdXRvLXJldHJ5XG5cdCAqXG5cdCAqIEBwYXJhbSBhc3Npc3RhbnRNZXNzYWdlIFRoZSBhc3Npc3RhbnQgbWVzc2FnZSB0byBjaGVja1xuXHQgKiBAcGFyYW0gc2tpcEFib3J0ZWRDaGVjayBJZiBmYWxzZSwgaW5jbHVkZSBhYm9ydGVkIG1lc3NhZ2VzIChmb3IgcHJlLXByb21wdCBjaGVjaykuIERlZmF1bHQ6IHRydWVcblx0ICovXG5cdGFzeW5jIGNoZWNrQ29tcGFjdGlvbihhc3Npc3RhbnRNZXNzYWdlOiBBc3Npc3RhbnRNZXNzYWdlLCBza2lwQWJvcnRlZENoZWNrID0gdHJ1ZSk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGNvbnN0IHNldHRpbmdzID0gdGhpcy5fZGVwcy5zZXR0aW5nc01hbmFnZXIuZ2V0Q29tcGFjdGlvblNldHRpbmdzKCk7XG5cdFx0aWYgKCFzZXR0aW5ncy5lbmFibGVkKSByZXR1cm47XG5cblx0XHRpZiAoc2tpcEFib3J0ZWRDaGVjayAmJiBhc3Npc3RhbnRNZXNzYWdlLnN0b3BSZWFzb24gPT09IFwiYWJvcnRlZFwiKSByZXR1cm47XG5cblx0XHRjb25zdCBtb2RlbCA9IHRoaXMuX2RlcHMuZ2V0TW9kZWwoKTtcblx0XHRjb25zdCBjb250ZXh0V2luZG93ID0gbW9kZWw/LmNvbnRleHRXaW5kb3cgPz8gMDtcblxuXHRcdGNvbnN0IHNhbWVNb2RlbCA9XG5cdFx0XHRtb2RlbCAmJiBhc3Npc3RhbnRNZXNzYWdlLnByb3ZpZGVyID09PSBtb2RlbC5wcm92aWRlciAmJiBhc3Npc3RhbnRNZXNzYWdlLm1vZGVsID09PSBtb2RlbC5pZDtcblxuXHRcdGNvbnN0IGJyYW5jaEVudHJpZXMgPSB0aGlzLl9kZXBzLnNlc3Npb25NYW5hZ2VyLmdldEJyYW5jaCgpO1xuXHRcdGNvbnN0IGNvbXBhY3Rpb25FbnRyeSA9IGdldExhdGVzdENvbXBhY3Rpb25FbnRyeShicmFuY2hFbnRyaWVzKTtcblx0XHRjb25zdCBhc3Npc3RhbnRJc0Zyb21CZWZvcmVDb21wYWN0aW9uID1cblx0XHRcdGNvbXBhY3Rpb25FbnRyeSAhPT0gbnVsbCAmJiBhc3Npc3RhbnRNZXNzYWdlLnRpbWVzdGFtcCA8PSBuZXcgRGF0ZShjb21wYWN0aW9uRW50cnkudGltZXN0YW1wKS5nZXRUaW1lKCk7XG5cdFx0aWYgKGFzc2lzdGFudElzRnJvbUJlZm9yZUNvbXBhY3Rpb24pIHJldHVybjtcblxuXHRcdC8vIENhc2UgMTogT3ZlcmZsb3cgLSBMTE0gcmV0dXJuZWQgY29udGV4dCBvdmVyZmxvdyBlcnJvclxuXHRcdGlmIChzYW1lTW9kZWwgJiYgaXNDb250ZXh0T3ZlcmZsb3coYXNzaXN0YW50TWVzc2FnZSwgY29udGV4dFdpbmRvdykpIHtcblx0XHRcdGlmICh0aGlzLl9vdmVyZmxvd1JlY292ZXJ5QXR0ZW1wdGVkKSB7XG5cdFx0XHRcdHRoaXMuX2RlcHMuZW1pdCh7XG5cdFx0XHRcdFx0dHlwZTogXCJhdXRvX2NvbXBhY3Rpb25fZW5kXCIsXG5cdFx0XHRcdFx0cmVzdWx0OiB1bmRlZmluZWQsXG5cdFx0XHRcdFx0YWJvcnRlZDogZmFsc2UsXG5cdFx0XHRcdFx0d2lsbFJldHJ5OiBmYWxzZSxcblx0XHRcdFx0XHRlcnJvck1lc3NhZ2U6XG5cdFx0XHRcdFx0XHRcIkNvbnRleHQgb3ZlcmZsb3cgcmVjb3ZlcnkgZmFpbGVkIGFmdGVyIG9uZSBjb21wYWN0LWFuZC1yZXRyeSBhdHRlbXB0LiBUcnkgcmVkdWNpbmcgY29udGV4dCBvciBzd2l0Y2hpbmcgdG8gYSBsYXJnZXItY29udGV4dCBtb2RlbC5cIixcblx0XHRcdFx0fSk7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblxuXHRcdFx0dGhpcy5fb3ZlcmZsb3dSZWNvdmVyeUF0dGVtcHRlZCA9IHRydWU7XG5cdFx0XHRjb25zdCBtZXNzYWdlcyA9IHRoaXMuX2RlcHMuYWdlbnQuc3RhdGUubWVzc2FnZXM7XG5cdFx0XHRpZiAobWVzc2FnZXMubGVuZ3RoID4gMCAmJiBtZXNzYWdlc1ttZXNzYWdlcy5sZW5ndGggLSAxXS5yb2xlID09PSBcImFzc2lzdGFudFwiKSB7XG5cdFx0XHRcdHRoaXMuX2RlcHMuYWdlbnQucmVwbGFjZU1lc3NhZ2VzKG1lc3NhZ2VzLnNsaWNlKDAsIC0xKSk7XG5cdFx0XHR9XG5cdFx0XHRhd2FpdCB0aGlzLl9ydW5BdXRvQ29tcGFjdGlvbihcIm92ZXJmbG93XCIsIHRydWUpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdC8vIENhc2UgMjogVGhyZXNob2xkIC0gY29udGV4dCBpcyBnZXR0aW5nIGxhcmdlXG5cdFx0bGV0IGNvbnRleHRUb2tlbnM6IG51bWJlcjtcblx0XHRpZiAoYXNzaXN0YW50TWVzc2FnZS5zdG9wUmVhc29uID09PSBcImVycm9yXCIpIHtcblx0XHRcdGNvbnN0IG1lc3NhZ2VzID0gdGhpcy5fZGVwcy5hZ2VudC5zdGF0ZS5tZXNzYWdlcztcblx0XHRcdGNvbnN0IGVzdGltYXRlID0gZXN0aW1hdGVDb250ZXh0VG9rZW5zKG1lc3NhZ2VzKTtcblx0XHRcdGlmIChlc3RpbWF0ZS5sYXN0VXNhZ2VJbmRleCA9PT0gbnVsbCkgcmV0dXJuO1xuXHRcdFx0Y29uc3QgdXNhZ2VNc2cgPSBtZXNzYWdlc1tlc3RpbWF0ZS5sYXN0VXNhZ2VJbmRleF07XG5cdFx0XHRpZiAoXG5cdFx0XHRcdGNvbXBhY3Rpb25FbnRyeSAmJlxuXHRcdFx0XHR1c2FnZU1zZy5yb2xlID09PSBcImFzc2lzdGFudFwiICYmXG5cdFx0XHRcdCh1c2FnZU1zZyBhcyBBc3Npc3RhbnRNZXNzYWdlKS50aW1lc3RhbXAgPD0gbmV3IERhdGUoY29tcGFjdGlvbkVudHJ5LnRpbWVzdGFtcCkuZ2V0VGltZSgpXG5cdFx0XHQpIHtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXHRcdFx0Y29udGV4dFRva2VucyA9IGVzdGltYXRlLnRva2Vucztcblx0XHR9IGVsc2Uge1xuXHRcdFx0Y29udGV4dFRva2VucyA9IGNhbGN1bGF0ZUNvbnRleHRUb2tlbnMoYXNzaXN0YW50TWVzc2FnZS51c2FnZSk7XG5cdFx0fVxuXHRcdGlmIChzaG91bGRDb21wYWN0KGNvbnRleHRUb2tlbnMsIGNvbnRleHRXaW5kb3csIHNldHRpbmdzKSkge1xuXHRcdFx0YXdhaXQgdGhpcy5fcnVuQXV0b0NvbXBhY3Rpb24oXCJ0aHJlc2hvbGRcIiwgZmFsc2UpO1xuXHRcdH1cblx0fVxuXG5cdC8qKiBUb2dnbGUgYXV0by1jb21wYWN0aW9uIHNldHRpbmcgKi9cblx0c2V0QXV0b0NvbXBhY3Rpb25FbmFibGVkKGVuYWJsZWQ6IGJvb2xlYW4pOiB2b2lkIHtcblx0XHR0aGlzLl9kZXBzLnNldHRpbmdzTWFuYWdlci5zZXRDb21wYWN0aW9uRW5hYmxlZChlbmFibGVkKTtcblx0fVxuXG5cdC8qKiBXaGV0aGVyIGF1dG8tY29tcGFjdGlvbiBpcyBlbmFibGVkICovXG5cdGdldCBhdXRvQ29tcGFjdGlvbkVuYWJsZWQoKTogYm9vbGVhbiB7XG5cdFx0cmV0dXJuIHRoaXMuX2RlcHMuc2V0dGluZ3NNYW5hZ2VyLmdldENvbXBhY3Rpb25FbmFibGVkKCk7XG5cdH1cblxuXHQvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cdC8vIFByaXZhdGUgaGVscGVyc1xuXHQvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cblx0cHJpdmF0ZSBhc3luYyBfcnVuQXV0b0NvbXBhY3Rpb24ocmVhc29uOiBcIm92ZXJmbG93XCIgfCBcInRocmVzaG9sZFwiLCB3aWxsUmV0cnk6IGJvb2xlYW4pOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRjb25zdCBzZXR0aW5ncyA9IHRoaXMuX2RlcHMuc2V0dGluZ3NNYW5hZ2VyLmdldENvbXBhY3Rpb25TZXR0aW5ncygpO1xuXG5cdFx0dGhpcy5fZGVwcy5lbWl0KHsgdHlwZTogXCJhdXRvX2NvbXBhY3Rpb25fc3RhcnRcIiwgcmVhc29uIH0pO1xuXHRcdHRoaXMuX2F1dG9Db21wYWN0aW9uQWJvcnRDb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuXG5cdFx0dHJ5IHtcblx0XHRcdGNvbnN0IG1vZGVsID0gdGhpcy5fZGVwcy5nZXRNb2RlbCgpO1xuXHRcdFx0aWYgKCFtb2RlbCkge1xuXHRcdFx0XHR0aGlzLl9kZXBzLmVtaXQoeyB0eXBlOiBcImF1dG9fY29tcGFjdGlvbl9lbmRcIiwgcmVzdWx0OiB1bmRlZmluZWQsIGFib3J0ZWQ6IGZhbHNlLCB3aWxsUmV0cnk6IGZhbHNlIH0pO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cblx0XHRcdGlmICghdGhpcy5fZGVwcy5tb2RlbFJlZ2lzdHJ5LmlzUHJvdmlkZXJSZXF1ZXN0UmVhZHkobW9kZWwucHJvdmlkZXIpKSB7XG5cdFx0XHRcdHRoaXMuX2RlcHMuZW1pdCh7IHR5cGU6IFwiYXV0b19jb21wYWN0aW9uX2VuZFwiLCByZXN1bHQ6IHVuZGVmaW5lZCwgYWJvcnRlZDogZmFsc2UsIHdpbGxSZXRyeTogZmFsc2UgfSk7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblx0XHRcdC8vIHVuZGVmaW5lZCBmb3IgZXh0ZXJuYWxDbGkvbm9uZSBwcm92aWRlcnMgXHUyMDE0IHN0cmlwcGVkIGF0IHRoZSBzdHJlYW1TaW1wbGUgYm91bmRhcnkgKG1vZGVsLXJlZ2lzdHJ5LnRzKVxuXHRcdFx0Y29uc3QgYXBpS2V5ID0gYXdhaXQgdGhpcy5fZGVwcy5tb2RlbFJlZ2lzdHJ5LmdldEFwaUtleShtb2RlbCwgdGhpcy5fZGVwcy5nZXRTZXNzaW9uSWQoKSk7XG5cblx0XHRcdGNvbnN0IHBhdGhFbnRyaWVzID0gdGhpcy5fZGVwcy5zZXNzaW9uTWFuYWdlci5nZXRCcmFuY2goKTtcblx0XHRcdGNvbnN0IHByZXBhcmF0aW9uID0gcHJlcGFyZUNvbXBhY3Rpb24ocGF0aEVudHJpZXMsIHNldHRpbmdzKTtcblx0XHRcdGlmICghcHJlcGFyYXRpb24pIHtcblx0XHRcdFx0dGhpcy5fZGVwcy5lbWl0KHsgdHlwZTogXCJhdXRvX2NvbXBhY3Rpb25fZW5kXCIsIHJlc3VsdDogdW5kZWZpbmVkLCBhYm9ydGVkOiBmYWxzZSwgd2lsbFJldHJ5OiBmYWxzZSB9KTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXG5cdFx0XHRsZXQgZXh0ZW5zaW9uQ29tcGFjdGlvbjogQ29tcGFjdGlvblJlc3VsdCB8IHVuZGVmaW5lZDtcblx0XHRcdGxldCBmcm9tRXh0ZW5zaW9uID0gZmFsc2U7XG5cdFx0XHRjb25zdCBleHRlbnNpb25SdW5uZXIgPSB0aGlzLl9kZXBzLmdldEV4dGVuc2lvblJ1bm5lcigpO1xuXG5cdFx0XHRpZiAoZXh0ZW5zaW9uUnVubmVyPy5oYXNIYW5kbGVycyhcInNlc3Npb25fYmVmb3JlX2NvbXBhY3RcIikpIHtcblx0XHRcdFx0Y29uc3QgZXh0ZW5zaW9uUmVzdWx0ID0gKGF3YWl0IGV4dGVuc2lvblJ1bm5lci5lbWl0KHtcblx0XHRcdFx0XHR0eXBlOiBcInNlc3Npb25fYmVmb3JlX2NvbXBhY3RcIixcblx0XHRcdFx0XHRwcmVwYXJhdGlvbixcblx0XHRcdFx0XHRicmFuY2hFbnRyaWVzOiBwYXRoRW50cmllcyxcblx0XHRcdFx0XHRjdXN0b21JbnN0cnVjdGlvbnM6IHVuZGVmaW5lZCxcblx0XHRcdFx0XHRzaWduYWw6IHRoaXMuX2F1dG9Db21wYWN0aW9uQWJvcnRDb250cm9sbGVyLnNpZ25hbCxcblx0XHRcdFx0fSkpIGFzIFNlc3Npb25CZWZvcmVDb21wYWN0UmVzdWx0IHwgdW5kZWZpbmVkO1xuXG5cdFx0XHRcdGlmIChleHRlbnNpb25SZXN1bHQ/LmNhbmNlbCkge1xuXHRcdFx0XHRcdHRoaXMuX2RlcHMuZW1pdCh7XG5cdFx0XHRcdFx0XHR0eXBlOiBcImF1dG9fY29tcGFjdGlvbl9lbmRcIixcblx0XHRcdFx0XHRcdHJlc3VsdDogdW5kZWZpbmVkLFxuXHRcdFx0XHRcdFx0YWJvcnRlZDogdHJ1ZSxcblx0XHRcdFx0XHRcdHdpbGxSZXRyeSxcblx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHR0aGlzLl9zY2hlZHVsZUF1dG9Db21wYWN0aW9uRm9sbG93dXAod2lsbFJldHJ5KTtcblx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRpZiAoZXh0ZW5zaW9uUmVzdWx0Py5jb21wYWN0aW9uKSB7XG5cdFx0XHRcdFx0ZXh0ZW5zaW9uQ29tcGFjdGlvbiA9IGV4dGVuc2lvblJlc3VsdC5jb21wYWN0aW9uO1xuXHRcdFx0XHRcdGZyb21FeHRlbnNpb24gPSB0cnVlO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdGxldCBzdW1tYXJ5OiBzdHJpbmc7XG5cdFx0XHRsZXQgZmlyc3RLZXB0RW50cnlJZDogc3RyaW5nO1xuXHRcdFx0bGV0IHRva2Vuc0JlZm9yZTogbnVtYmVyO1xuXHRcdFx0bGV0IGRldGFpbHM6IHVua25vd247XG5cblx0XHRcdGlmIChleHRlbnNpb25Db21wYWN0aW9uKSB7XG5cdFx0XHRcdHN1bW1hcnkgPSBleHRlbnNpb25Db21wYWN0aW9uLnN1bW1hcnk7XG5cdFx0XHRcdGZpcnN0S2VwdEVudHJ5SWQgPSBleHRlbnNpb25Db21wYWN0aW9uLmZpcnN0S2VwdEVudHJ5SWQ7XG5cdFx0XHRcdHRva2Vuc0JlZm9yZSA9IGV4dGVuc2lvbkNvbXBhY3Rpb24udG9rZW5zQmVmb3JlO1xuXHRcdFx0XHRkZXRhaWxzID0gZXh0ZW5zaW9uQ29tcGFjdGlvbi5kZXRhaWxzO1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0Y29uc3QgY29tcGFjdFJlc3VsdCA9IGF3YWl0IGNvbXBhY3QoXG5cdFx0XHRcdFx0cHJlcGFyYXRpb24sXG5cdFx0XHRcdFx0bW9kZWwsXG5cdFx0XHRcdFx0YXBpS2V5LFxuXHRcdFx0XHRcdHVuZGVmaW5lZCxcblx0XHRcdFx0XHR0aGlzLl9hdXRvQ29tcGFjdGlvbkFib3J0Q29udHJvbGxlci5zaWduYWwsXG5cdFx0XHRcdCk7XG5cdFx0XHRcdHN1bW1hcnkgPSBjb21wYWN0UmVzdWx0LnN1bW1hcnk7XG5cdFx0XHRcdGZpcnN0S2VwdEVudHJ5SWQgPSBjb21wYWN0UmVzdWx0LmZpcnN0S2VwdEVudHJ5SWQ7XG5cdFx0XHRcdHRva2Vuc0JlZm9yZSA9IGNvbXBhY3RSZXN1bHQudG9rZW5zQmVmb3JlO1xuXHRcdFx0XHRkZXRhaWxzID0gY29tcGFjdFJlc3VsdC5kZXRhaWxzO1xuXHRcdFx0fVxuXG5cdFx0XHRpZiAodGhpcy5fYXV0b0NvbXBhY3Rpb25BYm9ydENvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIHtcblx0XHRcdFx0dGhpcy5fZGVwcy5lbWl0KHsgdHlwZTogXCJhdXRvX2NvbXBhY3Rpb25fZW5kXCIsIHJlc3VsdDogdW5kZWZpbmVkLCBhYm9ydGVkOiB0cnVlLCB3aWxsUmV0cnk6IGZhbHNlIH0pO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cblx0XHRcdHRoaXMuX2RlcHMuc2Vzc2lvbk1hbmFnZXIuYXBwZW5kQ29tcGFjdGlvbihzdW1tYXJ5LCBmaXJzdEtlcHRFbnRyeUlkLCB0b2tlbnNCZWZvcmUsIGRldGFpbHMsIGZyb21FeHRlbnNpb24pO1xuXHRcdFx0Y29uc3QgbmV3RW50cmllcyA9IHRoaXMuX2RlcHMuc2Vzc2lvbk1hbmFnZXIuZ2V0RW50cmllcygpO1xuXHRcdFx0Y29uc3Qgc2Vzc2lvbkNvbnRleHQgPSB0aGlzLl9kZXBzLnNlc3Npb25NYW5hZ2VyLmJ1aWxkU2Vzc2lvbkNvbnRleHQoKTtcblx0XHRcdHRoaXMuX2RlcHMuYWdlbnQucmVwbGFjZU1lc3NhZ2VzKHNlc3Npb25Db250ZXh0Lm1lc3NhZ2VzKTtcblxuXHRcdFx0Y29uc3Qgc2F2ZWRDb21wYWN0aW9uRW50cnkgPSBuZXdFbnRyaWVzLmZpbmQoXG5cdFx0XHRcdChlKSA9PiBlLnR5cGUgPT09IFwiY29tcGFjdGlvblwiICYmIGUuc3VtbWFyeSA9PT0gc3VtbWFyeSxcblx0XHRcdCkgYXMgQ29tcGFjdGlvbkVudHJ5IHwgdW5kZWZpbmVkO1xuXG5cdFx0XHRpZiAoZXh0ZW5zaW9uUnVubmVyICYmIHNhdmVkQ29tcGFjdGlvbkVudHJ5KSB7XG5cdFx0XHRcdGF3YWl0IGV4dGVuc2lvblJ1bm5lci5lbWl0KHtcblx0XHRcdFx0XHR0eXBlOiBcInNlc3Npb25fY29tcGFjdFwiLFxuXHRcdFx0XHRcdGNvbXBhY3Rpb25FbnRyeTogc2F2ZWRDb21wYWN0aW9uRW50cnksXG5cdFx0XHRcdFx0ZnJvbUV4dGVuc2lvbixcblx0XHRcdFx0fSk7XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IHJlc3VsdDogQ29tcGFjdGlvblJlc3VsdCA9IHsgc3VtbWFyeSwgZmlyc3RLZXB0RW50cnlJZCwgdG9rZW5zQmVmb3JlLCBkZXRhaWxzIH07XG5cdFx0XHR0aGlzLl9kZXBzLmVtaXQoeyB0eXBlOiBcImF1dG9fY29tcGFjdGlvbl9lbmRcIiwgcmVzdWx0LCBhYm9ydGVkOiBmYWxzZSwgd2lsbFJldHJ5IH0pO1xuXHRcdFx0dGhpcy5fc2NoZWR1bGVBdXRvQ29tcGFjdGlvbkZvbGxvd3VwKHdpbGxSZXRyeSk7XG5cdFx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRcdC8vIERpc3Rpbmd1aXNoIHRoZSBcIm5vIHVzYWJsZSBzdW1tYXJ5XCIgZmFpbHVyZSAoaXNzdWUgIzQ2NjUpIHNvIHRoZSBVSVxuXHRcdFx0Ly8gY2FuIHN1cmZhY2UgYSBjbGVhcmVyIG1lc3NhZ2UgdGhhbiBhIGdlbmVyaWMgY29tcGFjdGlvbiBmYWlsdXJlLlxuXHRcdFx0Ly8gRWl0aGVyIHdheSB3ZSBkcm9wIHRoZSB3b3VsZC1iZSBjb21wYWN0aW9uIGVudHJ5IHJhdGhlciB0aGFuIHdyaXRpbmdcblx0XHRcdC8vIGFuIGVtcHR5IHN0cmluZyB0byB0aGUgc2Vzc2lvbiBoaXN0b3J5LlxuXHRcdFx0Y29uc3QgZXJyb3JNZXNzYWdlID0gZXJyb3IgaW5zdGFuY2VvZiBDb21wYWN0aW9uUHJvZHVjZWROb1N1bW1hcnlFcnJvclxuXHRcdFx0XHQ/IGBDb21wYWN0aW9uIHByb2R1Y2VkIG5vIHVzYWJsZSBzdW1tYXJ5IFx1MjAxNCBzZXNzaW9uIGhpc3RvcnkgcHJlc2VydmVkIGFzLWlzLiAoJHtlcnJvci5tZXNzYWdlfSlgXG5cdFx0XHRcdDogZ2V0RXJyb3JNZXNzYWdlKGVycm9yKTtcblx0XHRcdHRoaXMuX2RlcHMuZW1pdCh7XG5cdFx0XHRcdHR5cGU6IFwiYXV0b19jb21wYWN0aW9uX2VuZFwiLFxuXHRcdFx0XHRyZXN1bHQ6IHVuZGVmaW5lZCxcblx0XHRcdFx0YWJvcnRlZDogZmFsc2UsXG5cdFx0XHRcdHdpbGxSZXRyeTogZmFsc2UsXG5cdFx0XHRcdGVycm9yTWVzc2FnZTpcblx0XHRcdFx0XHRyZWFzb24gPT09IFwib3ZlcmZsb3dcIlxuXHRcdFx0XHRcdFx0PyBgQ29udGV4dCBvdmVyZmxvdyByZWNvdmVyeSBmYWlsZWQ6ICR7ZXJyb3JNZXNzYWdlfWBcblx0XHRcdFx0XHRcdDogYEF1dG8tY29tcGFjdGlvbiBmYWlsZWQ6ICR7ZXJyb3JNZXNzYWdlfWAsXG5cdFx0XHR9KTtcblx0XHR9IGZpbmFsbHkge1xuXHRcdFx0dGhpcy5fYXV0b0NvbXBhY3Rpb25BYm9ydENvbnRyb2xsZXIgPSB1bmRlZmluZWQ7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBfc2NoZWR1bGVBdXRvQ29tcGFjdGlvbkZvbGxvd3VwKHdpbGxSZXRyeTogYm9vbGVhbik6IHZvaWQge1xuXHRcdGlmICh3aWxsUmV0cnkpIHtcblx0XHRcdGNvbnN0IG1lc3NhZ2VzID0gdGhpcy5fZGVwcy5hZ2VudC5zdGF0ZS5tZXNzYWdlcztcblx0XHRcdGNvbnN0IGxhc3RNc2cgPSBtZXNzYWdlc1ttZXNzYWdlcy5sZW5ndGggLSAxXTtcblx0XHRcdGlmIChsYXN0TXNnPy5yb2xlID09PSBcImFzc2lzdGFudFwiICYmIChsYXN0TXNnIGFzIEFzc2lzdGFudE1lc3NhZ2UpLnN0b3BSZWFzb24gPT09IFwiZXJyb3JcIikge1xuXHRcdFx0XHR0aGlzLl9kZXBzLmFnZW50LnJlcGxhY2VNZXNzYWdlcyhtZXNzYWdlcy5zbGljZSgwLCAtMSkpO1xuXHRcdFx0fVxuXG5cdFx0XHRzZXRUaW1lb3V0KCgpID0+IHtcblx0XHRcdFx0dGhpcy5fZGVwcy5hZ2VudC5jb250aW51ZSgpLmNhdGNoKCgpID0+IHt9KTtcblx0XHRcdH0sIDEwMCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0aWYgKHRoaXMuX2RlcHMuYWdlbnQuaGFzUXVldWVkTWVzc2FnZXMoKSkge1xuXHRcdFx0c2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHRcdHRoaXMuX2RlcHMuYWdlbnQuY29udGludWUoKS5jYXRjaCgoKSA9PiB7fSk7XG5cdFx0XHR9LCAxMDApO1xuXHRcdH1cblx0fVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBYUEsU0FBUyx5QkFBeUI7QUFDbEM7QUFBQSxFQUVDO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNNO0FBR1AsU0FBUyxnQ0FBZ0M7QUFJekMsU0FBUyx1QkFBdUI7QUFpQnpCLE1BQU0sdUJBQXVCO0FBQUEsRUFNbkMsWUFBNkIsT0FBbUM7QUFBbkM7QUFMN0IsU0FBUSw2QkFBMEQ7QUFDbEUsU0FBUSxpQ0FBOEQ7QUFDdEUsU0FBUSw2QkFBNkI7QUFDckMsU0FBUSxnQ0FBNkQ7QUFBQSxFQUVKO0FBQUE7QUFBQSxFQUdqRSxJQUFJLGVBQXdCO0FBQzNCLFdBQ0MsS0FBSyxtQ0FBbUMsVUFDeEMsS0FBSywrQkFBK0IsVUFDcEMsS0FBSyxrQ0FBa0M7QUFBQSxFQUV6QztBQUFBO0FBQUEsRUFHQSx3QkFBOEI7QUFDN0IsU0FBSyw2QkFBNkI7QUFBQSxFQUNuQztBQUFBO0FBQUEsRUFHQSx3QkFBOEI7QUFDN0IsU0FBSyw2QkFBNkI7QUFBQSxFQUNuQztBQUFBO0FBQUEsRUFHQSxJQUFJLCtCQUE0RDtBQUMvRCxXQUFPLEtBQUs7QUFBQSxFQUNiO0FBQUEsRUFDQSxJQUFJLDZCQUE2QixZQUF5QztBQUN6RSxTQUFLLGdDQUFnQztBQUFBLEVBQ3RDO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLEVBT0EsTUFBTSxRQUFRLG9CQUF3RDtBQUNyRSxTQUFLLE1BQU0sb0JBQW9CO0FBQy9CLFVBQU0sS0FBSyxNQUFNLE1BQU07QUFDdkIsU0FBSyw2QkFBNkIsSUFBSSxnQkFBZ0I7QUFFdEQsUUFBSTtBQUNILFlBQU0sUUFBUSxLQUFLLE1BQU0sU0FBUztBQUNsQyxVQUFJLENBQUMsT0FBTztBQUNYLGNBQU0sSUFBSSxNQUFNLG1CQUFtQjtBQUFBLE1BQ3BDO0FBRUEs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
