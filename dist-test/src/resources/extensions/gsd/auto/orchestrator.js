function now() {
  return Date.now();
}
const STUCK_WINDOW_SIZE = 6;
class AutoOrchestrator {
  status = {
    phase: "idle",
    transitionCount: 0
  };
  deps;
  lastAdvanceKey = null;
  dispatchKeyWindow = [];
  constructor(deps) {
    this.deps = deps;
  }
  async start(_sessionContext) {
    this.lastAdvanceKey = null;
    this.dispatchKeyWindow = [];
    this.status.phase = "running";
    this.bumpTransition();
    await this.deps.runtime.journalTransition({ name: "start" });
    await this.deps.notifications.notifyLifecycle({ name: "start" });
    return this.advance();
  }
  async advance() {
    try {
      await this.deps.runtime.ensureLockOwnership();
      const staleMsg = this.deps.health.checkResourcesStale();
      if (staleMsg) {
        await this.deps.uokGate.emit({
          gateId: "resource-version-guard",
          gateType: "policy",
          outcome: "fail",
          failureClass: "policy",
          rationale: "resource version guard blocked dispatch",
          findings: staleMsg
        });
        const blocked = { kind: "blocked", reason: staleMsg, action: "stop" };
        await this.deps.runtime.journalTransition({ name: "advance-blocked", reason: blocked.reason });
        await this.deps.health.postAdvanceRecord(blocked);
        return blocked;
      }
      await this.deps.uokGate.emit({
        gateId: "resource-version-guard",
        gateType: "policy",
        outcome: "pass",
        failureClass: "none",
        rationale: "resource version guard passed"
      });
      const gate = await this.deps.health.preAdvanceGate();
      if (gate.kind === "fail") {
        await this.deps.uokGate.emit({
          gateId: "pre-dispatch-health-gate",
          gateType: "execution",
          outcome: "manual-attention",
          failureClass: "manual-attention",
          rationale: "pre-dispatch health gate blocked dispatch",
          findings: gate.reason
        });
        const blocked = { kind: "blocked", reason: gate.reason, action: "pause" };
        await this.deps.runtime.journalTransition({ name: "advance-blocked", reason: blocked.reason });
        await this.deps.health.postAdvanceRecord(blocked);
        return blocked;
      }
      if (gate.kind === "threw") {
        await this.deps.uokGate.emit({
          gateId: "pre-dispatch-health-gate",
          gateType: "execution",
          outcome: "manual-attention",
          failureClass: "manual-attention",
          rationale: "pre-dispatch health gate threw unexpectedly",
          findings: String(gate.error)
        });
      } else {
        await this.deps.uokGate.emit({
          gateId: "pre-dispatch-health-gate",
          gateType: "execution",
          outcome: "pass",
          failureClass: "none",
          rationale: "pre-dispatch health gate passed",
          findings: gate.fixesApplied?.join(", ") ?? ""
        });
      }
      const reconciliation = await this.deps.stateReconciliation.reconcileBeforeDispatch();
      if (!reconciliation.ok || !reconciliation.stateSnapshot) {
        const blocked = {
          kind: "blocked",
          reason: reconciliation.reason ?? "state reconciliation produced no snapshot",
          action: "pause",
          stateSnapshot: reconciliation.stateSnapshot
        };
        await this.deps.runtime.journalTransition({ name: "advance-blocked", reason: blocked.reason });
        await this.deps.health.postAdvanceRecord(blocked);
        return blocked;
      }
      const decision = await this.deps.dispatch.decideNextUnit({ stateSnapshot: reconciliation.stateSnapshot });
      if (!decision) {
        const stopped = { kind: "stopped", reason: "no remaining units", stateSnapshot: reconciliation.stateSnapshot };
        this.status.phase = "stopped";
        this.status.activeUnit = void 0;
        this.lastAdvanceKey = null;
        this.dispatchKeyWindow = [];
        this.bumpTransition();
        await this.deps.runtime.journalTransition({ name: "advance-stopped", reason: stopped.reason });
        await this.deps.health.postAdvanceRecord(stopped);
        return stopped;
      }
      if (!("unitType" in decision)) {
        const blocked = {
          kind: "blocked",
          reason: decision.reason,
          action: decision.action,
          stateSnapshot: reconciliation.stateSnapshot
        };
        await this.deps.runtime.journalTransition({ name: "advance-blocked", reason: blocked.reason });
        await this.deps.health.postAdvanceRecord(blocked);
        return blocked;
      }
      const nextKey = `${decision.unitType}:${decision.unitId}`;
      this.dispatchKeyWindow.push(nextKey);
      if (this.dispatchKeyWindow.length > STUCK_WINDOW_SIZE) {
        this.dispatchKeyWindow.shift();
      }
      const matchingCount = this.dispatchKeyWindow.filter((k) => k === nextKey).length;
      if (this.lastAdvanceKey === nextKey && matchingCount < STUCK_WINDOW_SIZE) {
        const blocked = { kind: "blocked", reason: "idempotent advance: unit already active", action: "stop" };
        await this.deps.runtime.journalTransition({
          name: "advance-blocked",
          reason: blocked.reason,
          unitType: decision.unitType,
          unitId: decision.unitId
        });
        await this.deps.health.postAdvanceRecord(blocked);
        return blocked;
      }
      if (matchingCount >= STUCK_WINDOW_SIZE) {
        const blocked = {
          kind: "blocked",
          reason: `stuck-loop: ${nextKey} picked ${matchingCount} times`,
          action: "stop"
        };
        await this.deps.runtime.journalTransition({
          name: "advance-blocked",
          reason: blocked.reason,
          unitType: decision.unitType,
          unitId: decision.unitId
        });
        await this.deps.health.postAdvanceRecord(blocked);
        return blocked;
      }
      const contract = await this.deps.toolContract.compileUnitToolContract(decision.unitType, decision.unitId);
      if (!contract.ok) {
        const blocked = {
          kind: "blocked",
          reason: contract.reason,
          action: "pause",
          stateSnapshot: reconciliation.stateSnapshot
        };
        await this.deps.runtime.journalTransition({
          name: "advance-blocked",
          reason: blocked.reason,
          unitType: decision.unitType,
          unitId: decision.unitId
        });
        await this.deps.health.postAdvanceRecord(blocked);
        return blocked;
      }
      const worktree = await this.deps.worktree.prepareForUnit(decision.unitType, decision.unitId);
      if (!worktree.ok) {
        const blocked = {
          kind: "blocked",
          reason: worktree.reason,
          action: "pause",
          stateSnapshot: reconciliation.stateSnapshot
        };
        await this.deps.runtime.journalTransition({
          name: "advance-blocked",
          reason: blocked.reason,
          unitType: decision.unitType,
          unitId: decision.unitId
        });
        await this.deps.health.postAdvanceRecord(blocked);
        return blocked;
      }
      this.status.activeUnit = { unitType: decision.unitType, unitId: decision.unitId };
      this.status.phase = "running";
      this.lastAdvanceKey = nextKey;
      this.bumpTransition();
      await this.deps.runtime.journalTransition({
        name: "advance",
        reason: decision.reason,
        unitType: decision.unitType,
        unitId: decision.unitId
      });
      await this.deps.worktree.syncAfterUnit(decision.unitType, decision.unitId);
      const advanced = {
        kind: "advanced",
        unit: { unitType: decision.unitType, unitId: decision.unitId },
        stateSnapshot: reconciliation.stateSnapshot
      };
      await this.deps.health.postAdvanceRecord(advanced);
      return advanced;
    } catch (error) {
      const recovery = await this.deps.recovery.classifyAndRecover({
        error,
        unitType: this.status.activeUnit?.unitType,
        unitId: this.status.activeUnit?.unitId
      });
      const result = recovery.action === "retry" ? { kind: "paused", reason: recovery.reason } : recovery.action === "escalate" ? { kind: "error", reason: recovery.reason } : { kind: "stopped", reason: recovery.reason };
      if (result.kind === "paused") {
        this.status.phase = "paused";
      } else if (result.kind === "stopped") {
        this.status.phase = "stopped";
      } else {
        this.status.phase = "error";
      }
      if (result.kind === "stopped") {
        this.lastAdvanceKey = null;
        this.dispatchKeyWindow = [];
        this.status.activeUnit = void 0;
      }
      this.bumpTransition();
      const journalName = result.kind === "paused" ? "advance-paused" : result.kind === "stopped" ? "advance-stopped" : "advance-error";
      await this.deps.runtime.journalTransition({ name: journalName, reason: recovery.reason });
      if (result.kind === "paused") {
        await this.deps.notifications.notifyLifecycle({ name: "pause", detail: recovery.reason });
      } else if (result.kind === "stopped") {
        await this.deps.notifications.notifyLifecycle({ name: "stopped", detail: recovery.reason });
      } else if (result.kind === "error") {
        await this.deps.notifications.notifyLifecycle({ name: "error", detail: recovery.reason });
      }
      await this.deps.health.postAdvanceRecord(result);
      return result;
    }
  }
  async resume() {
    this.lastAdvanceKey = null;
    this.dispatchKeyWindow = [];
    this.status.phase = "running";
    this.bumpTransition();
    await this.deps.runtime.journalTransition({ name: "resume" });
    await this.deps.notifications.notifyLifecycle({ name: "resume" });
    return this.advance();
  }
  async stop(reason) {
    if (this.status.phase === "stopped") {
      return { kind: "stopped", reason };
    }
    await this.deps.worktree.cleanupOnStop(reason);
    this.status.phase = "stopped";
    this.status.activeUnit = void 0;
    this.lastAdvanceKey = null;
    this.dispatchKeyWindow = [];
    this.bumpTransition();
    await this.deps.runtime.journalTransition({ name: "stop", reason });
    await this.deps.notifications.notifyLifecycle({ name: "stop", detail: reason });
    return { kind: "stopped", reason };
  }
  getStatus() {
    return { ...this.status, activeUnit: this.status.activeUnit ? { ...this.status.activeUnit } : void 0 };
  }
  bumpTransition() {
    this.status.transitionCount += 1;
    this.status.lastTransitionAt = now();
  }
}
function createAutoOrchestrator(deps) {
  return new AutoOrchestrator(deps);
}
export {
  AutoOrchestrator,
  STUCK_WINDOW_SIZE,
  createAutoOrchestrator
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9hdXRvL29yY2hlc3RyYXRvci50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IEF1dG8gT3JjaGVzdHJhdGlvbiBtb2R1bGUgaW1wbGVtZW50YXRpb24gYW5kIEFEUi0wMTUgaW52YXJpYW50IHBpcGVsaW5lIG93bmVyLlxuXG5pbXBvcnQgdHlwZSB7IEF1dG9BZHZhbmNlUmVzdWx0LCBBdXRvT3JjaGVzdHJhdGlvbk1vZHVsZSwgQXV0b09yY2hlc3RyYXRvckRlcHMsIEF1dG9TZXNzaW9uQ29udGV4dCwgQXV0b1N0YXR1cyB9IGZyb20gXCIuL2NvbnRyYWN0cy5qc1wiO1xuXG5mdW5jdGlvbiBub3coKTogbnVtYmVyIHtcbiAgcmV0dXJuIERhdGUubm93KCk7XG59XG5cbi8qKlxuICogU2l6ZSBvZiB0aGUgZGlzcGF0Y2gtZGVjaXNpb24gcmluZyBidWZmZXIgdXNlZCBieSB0aGUgQXV0byBPcmNoZXN0cmF0aW9uXG4gKiBtb2R1bGUncyBzdHVjay1sb29wIGRldGVjdG9yLiBXaGVuIHRoZSBzYW1lIGAke3VuaXRUeXBlfToke3VuaXRJZH1gIGtleVxuICogZmlsbHMgdGhlIHdpbmRvdywgYWR2YW5jZSgpIGJsb2NrcyB3aXRoIGBhY3Rpb246IFwic3RvcFwiYC5cbiAqXG4gKiBNaXJyb3JzIHRoZSBsZWdhY3kgYFNUVUNLX1dJTkRPV19TSVpFYCBpbiBhdXRvL3BoYXNlcy50cyBzbyBiZWhhdmlvdXIgaXNcbiAqIHByZXNlcnZlZCBhY3Jvc3MgdGhlIGV2ZW50dWFsIGN1dG92ZXIgKGlzc3VlICM1NzkxKS5cbiAqL1xuZXhwb3J0IGNvbnN0IFNUVUNLX1dJTkRPV19TSVpFID0gNjtcblxuZXhwb3J0IGNsYXNzIEF1dG9PcmNoZXN0cmF0b3IgaW1wbGVtZW50cyBBdXRvT3JjaGVzdHJhdGlvbk1vZHVsZSB7XG4gIHByaXZhdGUgc3RhdHVzOiBBdXRvU3RhdHVzID0ge1xuICAgIHBoYXNlOiBcImlkbGVcIixcbiAgICB0cmFuc2l0aW9uQ291bnQ6IDAsXG4gIH07XG4gIHByaXZhdGUgcmVhZG9ubHkgZGVwczogQXV0b09yY2hlc3RyYXRvckRlcHM7XG4gIHByaXZhdGUgbGFzdEFkdmFuY2VLZXk6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIGRpc3BhdGNoS2V5V2luZG93OiBzdHJpbmdbXSA9IFtdO1xuXG4gIHB1YmxpYyBjb25zdHJ1Y3RvcihkZXBzOiBBdXRvT3JjaGVzdHJhdG9yRGVwcykge1xuICAgIHRoaXMuZGVwcyA9IGRlcHM7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgc3RhcnQoX3Nlc3Npb25Db250ZXh0OiBBdXRvU2Vzc2lvbkNvbnRleHQpOiBQcm9taXNlPEF1dG9BZHZhbmNlUmVzdWx0PiB7XG4gICAgdGhpcy5sYXN0QWR2YW5jZUtleSA9IG51bGw7XG4gICAgdGhpcy5kaXNwYXRjaEtleVdpbmRvdyA9IFtdO1xuICAgIHRoaXMuc3RhdHVzLnBoYXNlID0gXCJydW5uaW5nXCI7XG4gICAgdGhpcy5idW1wVHJhbnNpdGlvbigpO1xuICAgIGF3YWl0IHRoaXMuZGVwcy5ydW50aW1lLmpvdXJuYWxUcmFuc2l0aW9uKHsgbmFtZTogXCJzdGFydFwiIH0pO1xuICAgIGF3YWl0IHRoaXMuZGVwcy5ub3RpZmljYXRpb25zLm5vdGlmeUxpZmVjeWNsZSh7IG5hbWU6IFwic3RhcnRcIiB9KTtcbiAgICByZXR1cm4gdGhpcy5hZHZhbmNlKCk7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgYWR2YW5jZSgpOiBQcm9taXNlPEF1dG9BZHZhbmNlUmVzdWx0PiB7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IHRoaXMuZGVwcy5ydW50aW1lLmVuc3VyZUxvY2tPd25lcnNoaXAoKTtcblxuICAgICAgY29uc3Qgc3RhbGVNc2cgPSB0aGlzLmRlcHMuaGVhbHRoLmNoZWNrUmVzb3VyY2VzU3RhbGUoKTtcbiAgICAgIGlmIChzdGFsZU1zZykge1xuICAgICAgICBhd2FpdCB0aGlzLmRlcHMudW9rR2F0ZS5lbWl0KHtcbiAgICAgICAgICBnYXRlSWQ6IFwicmVzb3VyY2UtdmVyc2lvbi1ndWFyZFwiLFxuICAgICAgICAgIGdhdGVUeXBlOiBcInBvbGljeVwiLFxuICAgICAgICAgIG91dGNvbWU6IFwiZmFpbFwiLFxuICAgICAgICAgIGZhaWx1cmVDbGFzczogXCJwb2xpY3lcIixcbiAgICAgICAgICByYXRpb25hbGU6IFwicmVzb3VyY2UgdmVyc2lvbiBndWFyZCBibG9ja2VkIGRpc3BhdGNoXCIsXG4gICAgICAgICAgZmluZGluZ3M6IHN0YWxlTXNnLFxuICAgICAgICB9KTtcbiAgICAgICAgY29uc3QgYmxvY2tlZDogQXV0b0FkdmFuY2VSZXN1bHQgPSB7IGtpbmQ6IFwiYmxvY2tlZFwiLCByZWFzb246IHN0YWxlTXNnLCBhY3Rpb246IFwic3RvcFwiIH07XG4gICAgICAgIGF3YWl0IHRoaXMuZGVwcy5ydW50aW1lLmpvdXJuYWxUcmFuc2l0aW9uKHsgbmFtZTogXCJhZHZhbmNlLWJsb2NrZWRcIiwgcmVhc29uOiBibG9ja2VkLnJlYXNvbiB9KTtcbiAgICAgICAgYXdhaXQgdGhpcy5kZXBzLmhlYWx0aC5wb3N0QWR2YW5jZVJlY29yZChibG9ja2VkKTtcbiAgICAgICAgcmV0dXJuIGJsb2NrZWQ7XG4gICAgICB9XG4gICAgICBhd2FpdCB0aGlzLmRlcHMudW9rR2F0ZS5lbWl0KHtcbiAgICAgICAgZ2F0ZUlkOiBcInJlc291cmNlLXZlcnNpb24tZ3VhcmRcIixcbiAgICAgICAgZ2F0ZVR5cGU6IFwicG9saWN5XCIsXG4gICAgICAgIG91dGNvbWU6IFwicGFzc1wiLFxuICAgICAgICBmYWlsdXJlQ2xhc3M6IFwibm9uZVwiLFxuICAgICAgICByYXRpb25hbGU6IFwicmVzb3VyY2UgdmVyc2lvbiBndWFyZCBwYXNzZWRcIixcbiAgICAgIH0pO1xuXG4gICAgICBjb25zdCBnYXRlID0gYXdhaXQgdGhpcy5kZXBzLmhlYWx0aC5wcmVBZHZhbmNlR2F0ZSgpO1xuICAgICAgaWYgKGdhdGUua2luZCA9PT0gXCJmYWlsXCIpIHtcbiAgICAgICAgYXdhaXQgdGhpcy5kZXBzLnVva0dhdGUuZW1pdCh7XG4gICAgICAgICAgZ2F0ZUlkOiBcInByZS1kaXNwYXRjaC1oZWFsdGgtZ2F0ZVwiLFxuICAgICAgICAgIGdhdGVUeXBlOiBcImV4ZWN1dGlvblwiLFxuICAgICAgICAgIG91dGNvbWU6IFwibWFudWFsLWF0dGVudGlvblwiLFxuICAgICAgICAgIGZhaWx1cmVDbGFzczogXCJtYW51YWwtYXR0ZW50aW9uXCIsXG4gICAgICAgICAgcmF0aW9uYWxlOiBcInByZS1kaXNwYXRjaCBoZWFsdGggZ2F0ZSBibG9ja2VkIGRpc3BhdGNoXCIsXG4gICAgICAgICAgZmluZGluZ3M6IGdhdGUucmVhc29uLFxuICAgICAgICB9KTtcbiAgICAgICAgY29uc3QgYmxvY2tlZDogQXV0b0FkdmFuY2VSZXN1bHQgPSB7IGtpbmQ6IFwiYmxvY2tlZFwiLCByZWFzb246IGdhdGUucmVhc29uLCBhY3Rpb246IFwicGF1c2VcIiB9O1xuICAgICAgICBhd2FpdCB0aGlzLmRlcHMucnVudGltZS5qb3VybmFsVHJhbnNpdGlvbih7IG5hbWU6IFwiYWR2YW5jZS1ibG9ja2VkXCIsIHJlYXNvbjogYmxvY2tlZC5yZWFzb24gfSk7XG4gICAgICAgIGF3YWl0IHRoaXMuZGVwcy5oZWFsdGgucG9zdEFkdmFuY2VSZWNvcmQoYmxvY2tlZCk7XG4gICAgICAgIHJldHVybiBibG9ja2VkO1xuICAgICAgfVxuICAgICAgaWYgKGdhdGUua2luZCA9PT0gXCJ0aHJld1wiKSB7XG4gICAgICAgIGF3YWl0IHRoaXMuZGVwcy51b2tHYXRlLmVtaXQoe1xuICAgICAgICAgIGdhdGVJZDogXCJwcmUtZGlzcGF0Y2gtaGVhbHRoLWdhdGVcIixcbiAgICAgICAgICBnYXRlVHlwZTogXCJleGVjdXRpb25cIixcbiAgICAgICAgICBvdXRjb21lOiBcIm1hbnVhbC1hdHRlbnRpb25cIixcbiAgICAgICAgICBmYWlsdXJlQ2xhc3M6IFwibWFudWFsLWF0dGVudGlvblwiLFxuICAgICAgICAgIHJhdGlvbmFsZTogXCJwcmUtZGlzcGF0Y2ggaGVhbHRoIGdhdGUgdGhyZXcgdW5leHBlY3RlZGx5XCIsXG4gICAgICAgICAgZmluZGluZ3M6IFN0cmluZyhnYXRlLmVycm9yKSxcbiAgICAgICAgfSk7XG4gICAgICAgIC8vIGludGVudGlvbmFsIGZhbGwtdGhyb3VnaDogbWF0Y2hlcyBydW5QcmVEaXNwYXRjaCBiZWhhdmlvdXJcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGF3YWl0IHRoaXMuZGVwcy51b2tHYXRlLmVtaXQoe1xuICAgICAgICAgIGdhdGVJZDogXCJwcmUtZGlzcGF0Y2gtaGVhbHRoLWdhdGVcIixcbiAgICAgICAgICBnYXRlVHlwZTogXCJleGVjdXRpb25cIixcbiAgICAgICAgICBvdXRjb21lOiBcInBhc3NcIixcbiAgICAgICAgICBmYWlsdXJlQ2xhc3M6IFwibm9uZVwiLFxuICAgICAgICAgIHJhdGlvbmFsZTogXCJwcmUtZGlzcGF0Y2ggaGVhbHRoIGdhdGUgcGFzc2VkXCIsXG4gICAgICAgICAgZmluZGluZ3M6IGdhdGUuZml4ZXNBcHBsaWVkPy5qb2luKFwiLCBcIikgPz8gXCJcIixcbiAgICAgICAgfSk7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHJlY29uY2lsaWF0aW9uID0gYXdhaXQgdGhpcy5kZXBzLnN0YXRlUmVjb25jaWxpYXRpb24ucmVjb25jaWxlQmVmb3JlRGlzcGF0Y2goKTtcbiAgICAgIGlmICghcmVjb25jaWxpYXRpb24ub2sgfHwgIXJlY29uY2lsaWF0aW9uLnN0YXRlU25hcHNob3QpIHtcbiAgICAgICAgY29uc3QgYmxvY2tlZDogQXV0b0FkdmFuY2VSZXN1bHQgPSB7XG4gICAgICAgICAga2luZDogXCJibG9ja2VkXCIsXG4gICAgICAgICAgcmVhc29uOiByZWNvbmNpbGlhdGlvbi5yZWFzb24gPz8gXCJzdGF0ZSByZWNvbmNpbGlhdGlvbiBwcm9kdWNlZCBubyBzbmFwc2hvdFwiLFxuICAgICAgICAgIGFjdGlvbjogXCJwYXVzZVwiLFxuICAgICAgICAgIHN0YXRlU25hcHNob3Q6IHJlY29uY2lsaWF0aW9uLnN0YXRlU25hcHNob3QsXG4gICAgICAgIH07XG4gICAgICAgIGF3YWl0IHRoaXMuZGVwcy5ydW50aW1lLmpvdXJuYWxUcmFuc2l0aW9uKHsgbmFtZTogXCJhZHZhbmNlLWJsb2NrZWRcIiwgcmVhc29uOiBibG9ja2VkLnJlYXNvbiB9KTtcbiAgICAgICAgYXdhaXQgdGhpcy5kZXBzLmhlYWx0aC5wb3N0QWR2YW5jZVJlY29yZChibG9ja2VkKTtcbiAgICAgICAgcmV0dXJuIGJsb2NrZWQ7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGRlY2lzaW9uID0gYXdhaXQgdGhpcy5kZXBzLmRpc3BhdGNoLmRlY2lkZU5leHRVbml0KHsgc3RhdGVTbmFwc2hvdDogcmVjb25jaWxpYXRpb24uc3RhdGVTbmFwc2hvdCB9KTtcbiAgICAgIGlmICghZGVjaXNpb24pIHtcbiAgICAgICAgY29uc3Qgc3RvcHBlZDogQXV0b0FkdmFuY2VSZXN1bHQgPSB7IGtpbmQ6IFwic3RvcHBlZFwiLCByZWFzb246IFwibm8gcmVtYWluaW5nIHVuaXRzXCIsIHN0YXRlU25hcHNob3Q6IHJlY29uY2lsaWF0aW9uLnN0YXRlU25hcHNob3QgfTtcbiAgICAgICAgdGhpcy5zdGF0dXMucGhhc2UgPSBcInN0b3BwZWRcIjtcbiAgICAgICAgdGhpcy5zdGF0dXMuYWN0aXZlVW5pdCA9IHVuZGVmaW5lZDtcbiAgICAgICAgdGhpcy5sYXN0QWR2YW5jZUtleSA9IG51bGw7XG4gICAgICAgIHRoaXMuZGlzcGF0Y2hLZXlXaW5kb3cgPSBbXTtcbiAgICAgICAgdGhpcy5idW1wVHJhbnNpdGlvbigpO1xuICAgICAgICBhd2FpdCB0aGlzLmRlcHMucnVudGltZS5qb3VybmFsVHJhbnNpdGlvbih7IG5hbWU6IFwiYWR2YW5jZS1zdG9wcGVkXCIsIHJlYXNvbjogc3RvcHBlZC5yZWFzb24gfSk7XG4gICAgICAgIGF3YWl0IHRoaXMuZGVwcy5oZWFsdGgucG9zdEFkdmFuY2VSZWNvcmQoc3RvcHBlZCk7XG4gICAgICAgIHJldHVybiBzdG9wcGVkO1xuICAgICAgfVxuICAgICAgaWYgKCEoXCJ1bml0VHlwZVwiIGluIGRlY2lzaW9uKSkge1xuICAgICAgICBjb25zdCBibG9ja2VkOiBBdXRvQWR2YW5jZVJlc3VsdCA9IHtcbiAgICAgICAgICBraW5kOiBcImJsb2NrZWRcIixcbiAgICAgICAgICByZWFzb246IGRlY2lzaW9uLnJlYXNvbixcbiAgICAgICAgICBhY3Rpb246IGRlY2lzaW9uLmFjdGlvbixcbiAgICAgICAgICBzdGF0ZVNuYXBzaG90OiByZWNvbmNpbGlhdGlvbi5zdGF0ZVNuYXBzaG90LFxuICAgICAgICB9O1xuICAgICAgICBhd2FpdCB0aGlzLmRlcHMucnVudGltZS5qb3VybmFsVHJhbnNpdGlvbih7IG5hbWU6IFwiYWR2YW5jZS1ibG9ja2VkXCIsIHJlYXNvbjogYmxvY2tlZC5yZWFzb24gfSk7XG4gICAgICAgIGF3YWl0IHRoaXMuZGVwcy5oZWFsdGgucG9zdEFkdmFuY2VSZWNvcmQoYmxvY2tlZCk7XG4gICAgICAgIHJldHVybiBibG9ja2VkO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBuZXh0S2V5ID0gYCR7ZGVjaXNpb24udW5pdFR5cGV9OiR7ZGVjaXNpb24udW5pdElkfWA7XG5cbiAgICAgIC8vIFJlY29yZCBldmVyeSBkaXNwYXRjaCBkZWNpc2lvbiBpbiB0aGUgcmluZyBidWZmZXIgYmVmb3JlIHByZS1mbGlnaHRcbiAgICAgIC8vIGNoZWNrcyBzbyB0aGUgc3R1Y2stbG9vcCBkZXRlY3RvciBvYnNlcnZlcyB0aGUgZnVsbCBkZWNpc2lvbiBoaXN0b3J5XG4gICAgICAvLyAoaW5jbHVkaW5nIGRlY2lzaW9ucyB0aGF0IGlkZW1wb3RlbmN5IHdvdWxkIG90aGVyd2lzZSBzaG9ydC1jaXJjdWl0KS5cbiAgICAgIC8vIFRoZSByaW5nIGlzIGNhcHBlZCBhdCBTVFVDS19XSU5ET1dfU0laRSBhbmQgZXZpY3RzIG9sZGVzdC1maXJzdC5cbiAgICAgIHRoaXMuZGlzcGF0Y2hLZXlXaW5kb3cucHVzaChuZXh0S2V5KTtcbiAgICAgIGlmICh0aGlzLmRpc3BhdGNoS2V5V2luZG93Lmxlbmd0aCA+IFNUVUNLX1dJTkRPV19TSVpFKSB7XG4gICAgICAgIHRoaXMuZGlzcGF0Y2hLZXlXaW5kb3cuc2hpZnQoKTtcbiAgICAgIH1cblxuICAgICAgLy8gSWRlbXBvdGVuY3k6IHNhbWUga2V5IGFzIGltbWVkaWF0ZWx5IHByZXZpb3VzIHN1Y2Nlc3NmdWwgYWR2YW5jZS5cbiAgICAgIC8vIFRoaXMgaXMgdGhlIHNvZnQsIGZhc3QtcGF0aCBibG9jayBrZXB0IGZyb20gIzU3ODYuIEl0IG9ubHkgZmlyZXMgd2hlblxuICAgICAgLy8gdGhlIHJpbmcgaXMgTk9UIHlldCBzYXR1cmF0ZWQgZm9yIHRoaXMga2V5IFx1MjAxNCBvbmNlIHRoZSByaW5nIGlzIGZ1bGwgb2ZcbiAgICAgIC8vIGBuZXh0S2V5YCwgdGhlIHN0dWNrLWxvb3AgdmVyZGljdCB0YWtlcyBwcmVjZWRlbmNlIChzZWUgYmVsb3cpLiBCb3RoXG4gICAgICAvLyBjaGVja3MgY29leGlzdDogaWRlbXBvdGVuY3kgZm9yIHRoZSBjb21tb24gaW1tZWRpYXRlLXJlcGVhdCBjYXNlLFxuICAgICAgLy8gc3R1Y2stbG9vcCBmb3IgdGhlIHNhdHVyYXRlZC13aW5kb3cgY2FzZS5cbiAgICAgIGNvbnN0IG1hdGNoaW5nQ291bnQgPSB0aGlzLmRpc3BhdGNoS2V5V2luZG93LmZpbHRlcigoaykgPT4gayA9PT0gbmV4dEtleSkubGVuZ3RoO1xuICAgICAgaWYgKHRoaXMubGFzdEFkdmFuY2VLZXkgPT09IG5leHRLZXkgJiYgbWF0Y2hpbmdDb3VudCA8IFNUVUNLX1dJTkRPV19TSVpFKSB7XG4gICAgICAgIGNvbnN0IGJsb2NrZWQ6IEF1dG9BZHZhbmNlUmVzdWx0ID0geyBraW5kOiBcImJsb2NrZWRcIiwgcmVhc29uOiBcImlkZW1wb3RlbnQgYWR2YW5jZTogdW5pdCBhbHJlYWR5IGFjdGl2ZVwiLCBhY3Rpb246IFwic3RvcFwiIH07XG4gICAgICAgIGF3YWl0IHRoaXMuZGVwcy5ydW50aW1lLmpvdXJuYWxUcmFuc2l0aW9uKHtcbiAgICAgICAgICBuYW1lOiBcImFkdmFuY2UtYmxvY2tlZFwiLFxuICAgICAgICAgIHJlYXNvbjogYmxvY2tlZC5yZWFzb24sXG4gICAgICAgICAgdW5pdFR5cGU6IGRlY2lzaW9uLnVuaXRUeXBlLFxuICAgICAgICAgIHVuaXRJZDogZGVjaXNpb24udW5pdElkLFxuICAgICAgICB9KTtcbiAgICAgICAgYXdhaXQgdGhpcy5kZXBzLmhlYWx0aC5wb3N0QWR2YW5jZVJlY29yZChibG9ja2VkKTtcbiAgICAgICAgcmV0dXJuIGJsb2NrZWQ7XG4gICAgICB9XG5cbiAgICAgIC8vIFN0dWNrLWxvb3AgZGV0ZWN0aW9uOiB3aGVuIHRoZSByaW5nIGlzIHNhdHVyYXRlZCB3aXRoIGNvcGllcyBvZlxuICAgICAgLy8gYG5leHRLZXlgIChjb3VudCA+PSBTVFVDS19XSU5ET1dfU0laRSksIHRoZSBvcmNoZXN0cmF0b3IgaGFzIGJlZW5cbiAgICAgIC8vIHBpY2tpbmcgdGhlIHNhbWUgdW5pdCBhY3Jvc3MgdGhlIHdob2xlIHdpbmRvdyBhbmQgbXVzdCBoYXJkLXN0b3Agd2l0aFxuICAgICAgLy8gYSBkaWFnbm9zYWJsZSByZWFzb24uXG4gICAgICBpZiAobWF0Y2hpbmdDb3VudCA+PSBTVFVDS19XSU5ET1dfU0laRSkge1xuICAgICAgICBjb25zdCBibG9ja2VkOiBBdXRvQWR2YW5jZVJlc3VsdCA9IHtcbiAgICAgICAgICBraW5kOiBcImJsb2NrZWRcIixcbiAgICAgICAgICByZWFzb246IGBzdHVjay1sb29wOiAke25leHRLZXl9IHBpY2tlZCAke21hdGNoaW5nQ291bnR9IHRpbWVzYCxcbiAgICAgICAgICBhY3Rpb246IFwic3RvcFwiLFxuICAgICAgICB9O1xuICAgICAgICBhd2FpdCB0aGlzLmRlcHMucnVudGltZS5qb3VybmFsVHJhbnNpdGlvbih7XG4gICAgICAgICAgbmFtZTogXCJhZHZhbmNlLWJsb2NrZWRcIixcbiAgICAgICAgICByZWFzb246IGJsb2NrZWQucmVhc29uLFxuICAgICAgICAgIHVuaXRUeXBlOiBkZWNpc2lvbi51bml0VHlwZSxcbiAgICAgICAgICB1bml0SWQ6IGRlY2lzaW9uLnVuaXRJZCxcbiAgICAgICAgfSk7XG4gICAgICAgIGF3YWl0IHRoaXMuZGVwcy5oZWFsdGgucG9zdEFkdmFuY2VSZWNvcmQoYmxvY2tlZCk7XG4gICAgICAgIHJldHVybiBibG9ja2VkO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBjb250cmFjdCA9IGF3YWl0IHRoaXMuZGVwcy50b29sQ29udHJhY3QuY29tcGlsZVVuaXRUb29sQ29udHJhY3QoZGVjaXNpb24udW5pdFR5cGUsIGRlY2lzaW9uLnVuaXRJZCk7XG4gICAgICBpZiAoIWNvbnRyYWN0Lm9rKSB7XG4gICAgICAgIGNvbnN0IGJsb2NrZWQ6IEF1dG9BZHZhbmNlUmVzdWx0ID0ge1xuICAgICAgICAgIGtpbmQ6IFwiYmxvY2tlZFwiLFxuICAgICAgICAgIHJlYXNvbjogY29udHJhY3QucmVhc29uLFxuICAgICAgICAgIGFjdGlvbjogXCJwYXVzZVwiLFxuICAgICAgICAgIHN0YXRlU25hcHNob3Q6IHJlY29uY2lsaWF0aW9uLnN0YXRlU25hcHNob3QsXG4gICAgICAgIH07XG4gICAgICAgIGF3YWl0IHRoaXMuZGVwcy5ydW50aW1lLmpvdXJuYWxUcmFuc2l0aW9uKHtcbiAgICAgICAgICBuYW1lOiBcImFkdmFuY2UtYmxvY2tlZFwiLFxuICAgICAgICAgIHJlYXNvbjogYmxvY2tlZC5yZWFzb24sXG4gICAgICAgICAgdW5pdFR5cGU6IGRlY2lzaW9uLnVuaXRUeXBlLFxuICAgICAgICAgIHVuaXRJZDogZGVjaXNpb24udW5pdElkLFxuICAgICAgICB9KTtcbiAgICAgICAgYXdhaXQgdGhpcy5kZXBzLmhlYWx0aC5wb3N0QWR2YW5jZVJlY29yZChibG9ja2VkKTtcbiAgICAgICAgcmV0dXJuIGJsb2NrZWQ7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHdvcmt0cmVlID0gYXdhaXQgdGhpcy5kZXBzLndvcmt0cmVlLnByZXBhcmVGb3JVbml0KGRlY2lzaW9uLnVuaXRUeXBlLCBkZWNpc2lvbi51bml0SWQpO1xuICAgICAgaWYgKCF3b3JrdHJlZS5vaykge1xuICAgICAgICBjb25zdCBibG9ja2VkOiBBdXRvQWR2YW5jZVJlc3VsdCA9IHtcbiAgICAgICAgICBraW5kOiBcImJsb2NrZWRcIixcbiAgICAgICAgICByZWFzb246IHdvcmt0cmVlLnJlYXNvbixcbiAgICAgICAgICBhY3Rpb246IFwicGF1c2VcIixcbiAgICAgICAgICBzdGF0ZVNuYXBzaG90OiByZWNvbmNpbGlhdGlvbi5zdGF0ZVNuYXBzaG90LFxuICAgICAgICB9O1xuICAgICAgICBhd2FpdCB0aGlzLmRlcHMucnVudGltZS5qb3VybmFsVHJhbnNpdGlvbih7XG4gICAgICAgICAgbmFtZTogXCJhZHZhbmNlLWJsb2NrZWRcIixcbiAgICAgICAgICByZWFzb246IGJsb2NrZWQucmVhc29uLFxuICAgICAgICAgIHVuaXRUeXBlOiBkZWNpc2lvbi51bml0VHlwZSxcbiAgICAgICAgICB1bml0SWQ6IGRlY2lzaW9uLnVuaXRJZCxcbiAgICAgICAgfSk7XG4gICAgICAgIGF3YWl0IHRoaXMuZGVwcy5oZWFsdGgucG9zdEFkdmFuY2VSZWNvcmQoYmxvY2tlZCk7XG4gICAgICAgIHJldHVybiBibG9ja2VkO1xuICAgICAgfVxuXG4gICAgICB0aGlzLnN0YXR1cy5hY3RpdmVVbml0ID0geyB1bml0VHlwZTogZGVjaXNpb24udW5pdFR5cGUsIHVuaXRJZDogZGVjaXNpb24udW5pdElkIH07XG4gICAgICB0aGlzLnN0YXR1cy5waGFzZSA9IFwicnVubmluZ1wiO1xuICAgICAgdGhpcy5sYXN0QWR2YW5jZUtleSA9IG5leHRLZXk7XG4gICAgICB0aGlzLmJ1bXBUcmFuc2l0aW9uKCk7XG5cbiAgICAgIGF3YWl0IHRoaXMuZGVwcy5ydW50aW1lLmpvdXJuYWxUcmFuc2l0aW9uKHtcbiAgICAgICAgbmFtZTogXCJhZHZhbmNlXCIsXG4gICAgICAgIHJlYXNvbjogZGVjaXNpb24ucmVhc29uLFxuICAgICAgICB1bml0VHlwZTogZGVjaXNpb24udW5pdFR5cGUsXG4gICAgICAgIHVuaXRJZDogZGVjaXNpb24udW5pdElkLFxuICAgICAgfSk7XG4gICAgICBhd2FpdCB0aGlzLmRlcHMud29ya3RyZWUuc3luY0FmdGVyVW5pdChkZWNpc2lvbi51bml0VHlwZSwgZGVjaXNpb24udW5pdElkKTtcblxuICAgICAgY29uc3QgYWR2YW5jZWQ6IEF1dG9BZHZhbmNlUmVzdWx0ID0ge1xuICAgICAgICBraW5kOiBcImFkdmFuY2VkXCIsXG4gICAgICAgIHVuaXQ6IHsgdW5pdFR5cGU6IGRlY2lzaW9uLnVuaXRUeXBlLCB1bml0SWQ6IGRlY2lzaW9uLnVuaXRJZCB9LFxuICAgICAgICBzdGF0ZVNuYXBzaG90OiByZWNvbmNpbGlhdGlvbi5zdGF0ZVNuYXBzaG90LFxuICAgICAgfTtcbiAgICAgIGF3YWl0IHRoaXMuZGVwcy5oZWFsdGgucG9zdEFkdmFuY2VSZWNvcmQoYWR2YW5jZWQpO1xuICAgICAgcmV0dXJuIGFkdmFuY2VkO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBjb25zdCByZWNvdmVyeSA9IGF3YWl0IHRoaXMuZGVwcy5yZWNvdmVyeS5jbGFzc2lmeUFuZFJlY292ZXIoe1xuICAgICAgICBlcnJvcixcbiAgICAgICAgdW5pdFR5cGU6IHRoaXMuc3RhdHVzLmFjdGl2ZVVuaXQ/LnVuaXRUeXBlLFxuICAgICAgICB1bml0SWQ6IHRoaXMuc3RhdHVzLmFjdGl2ZVVuaXQ/LnVuaXRJZCxcbiAgICAgIH0pO1xuICAgICAgY29uc3QgcmVzdWx0OiBBdXRvQWR2YW5jZVJlc3VsdCA9IHJlY292ZXJ5LmFjdGlvbiA9PT0gXCJyZXRyeVwiXG4gICAgICAgID8geyBraW5kOiBcInBhdXNlZFwiLCByZWFzb246IHJlY292ZXJ5LnJlYXNvbiB9XG4gICAgICAgIDogcmVjb3ZlcnkuYWN0aW9uID09PSBcImVzY2FsYXRlXCJcbiAgICAgICAgICA/IHsga2luZDogXCJlcnJvclwiLCByZWFzb246IHJlY292ZXJ5LnJlYXNvbiB9XG4gICAgICAgICAgOiB7IGtpbmQ6IFwic3RvcHBlZFwiLCByZWFzb246IHJlY292ZXJ5LnJlYXNvbiB9O1xuXG4gICAgICBpZiAocmVzdWx0LmtpbmQgPT09IFwicGF1c2VkXCIpIHtcbiAgICAgICAgdGhpcy5zdGF0dXMucGhhc2UgPSBcInBhdXNlZFwiO1xuICAgICAgfSBlbHNlIGlmIChyZXN1bHQua2luZCA9PT0gXCJzdG9wcGVkXCIpIHtcbiAgICAgICAgdGhpcy5zdGF0dXMucGhhc2UgPSBcInN0b3BwZWRcIjtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMuc3RhdHVzLnBoYXNlID0gXCJlcnJvclwiO1xuICAgICAgfVxuXG4gICAgICBpZiAocmVzdWx0LmtpbmQgPT09IFwic3RvcHBlZFwiKSB7XG4gICAgICAgIHRoaXMubGFzdEFkdmFuY2VLZXkgPSBudWxsO1xuICAgICAgICB0aGlzLmRpc3BhdGNoS2V5V2luZG93ID0gW107XG4gICAgICAgIHRoaXMuc3RhdHVzLmFjdGl2ZVVuaXQgPSB1bmRlZmluZWQ7XG4gICAgICB9XG4gICAgICB0aGlzLmJ1bXBUcmFuc2l0aW9uKCk7XG5cbiAgICAgIGNvbnN0IGpvdXJuYWxOYW1lID0gcmVzdWx0LmtpbmQgPT09IFwicGF1c2VkXCJcbiAgICAgICAgPyBcImFkdmFuY2UtcGF1c2VkXCJcbiAgICAgICAgOiByZXN1bHQua2luZCA9PT0gXCJzdG9wcGVkXCJcbiAgICAgICAgICA/IFwiYWR2YW5jZS1zdG9wcGVkXCJcbiAgICAgICAgICA6IFwiYWR2YW5jZS1lcnJvclwiO1xuICAgICAgYXdhaXQgdGhpcy5kZXBzLnJ1bnRpbWUuam91cm5hbFRyYW5zaXRpb24oeyBuYW1lOiBqb3VybmFsTmFtZSwgcmVhc29uOiByZWNvdmVyeS5yZWFzb24gfSk7XG5cbiAgICAgIGlmIChyZXN1bHQua2luZCA9PT0gXCJwYXVzZWRcIikge1xuICAgICAgICBhd2FpdCB0aGlzLmRlcHMubm90aWZpY2F0aW9ucy5ub3RpZnlMaWZlY3ljbGUoeyBuYW1lOiBcInBhdXNlXCIsIGRldGFpbDogcmVjb3ZlcnkucmVhc29uIH0pO1xuICAgICAgfSBlbHNlIGlmIChyZXN1bHQua2luZCA9PT0gXCJzdG9wcGVkXCIpIHtcbiAgICAgICAgYXdhaXQgdGhpcy5kZXBzLm5vdGlmaWNhdGlvbnMubm90aWZ5TGlmZWN5Y2xlKHsgbmFtZTogXCJzdG9wcGVkXCIsIGRldGFpbDogcmVjb3ZlcnkucmVhc29uIH0pO1xuICAgICAgfSBlbHNlIGlmIChyZXN1bHQua2luZCA9PT0gXCJlcnJvclwiKSB7XG4gICAgICAgIGF3YWl0IHRoaXMuZGVwcy5ub3RpZmljYXRpb25zLm5vdGlmeUxpZmVjeWNsZSh7IG5hbWU6IFwiZXJyb3JcIiwgZGV0YWlsOiByZWNvdmVyeS5yZWFzb24gfSk7XG4gICAgICB9XG4gICAgICBhd2FpdCB0aGlzLmRlcHMuaGVhbHRoLnBvc3RBZHZhbmNlUmVjb3JkKHJlc3VsdCk7XG4gICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cbiAgfVxuXG4gIHB1YmxpYyBhc3luYyByZXN1bWUoKTogUHJvbWlzZTxBdXRvQWR2YW5jZVJlc3VsdD4ge1xuICAgIHRoaXMubGFzdEFkdmFuY2VLZXkgPSBudWxsO1xuICAgIHRoaXMuZGlzcGF0Y2hLZXlXaW5kb3cgPSBbXTtcbiAgICB0aGlzLnN0YXR1cy5waGFzZSA9IFwicnVubmluZ1wiO1xuICAgIHRoaXMuYnVtcFRyYW5zaXRpb24oKTtcbiAgICBhd2FpdCB0aGlzLmRlcHMucnVudGltZS5qb3VybmFsVHJhbnNpdGlvbih7IG5hbWU6IFwicmVzdW1lXCIgfSk7XG4gICAgYXdhaXQgdGhpcy5kZXBzLm5vdGlmaWNhdGlvbnMubm90aWZ5TGlmZWN5Y2xlKHsgbmFtZTogXCJyZXN1bWVcIiB9KTtcbiAgICByZXR1cm4gdGhpcy5hZHZhbmNlKCk7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgc3RvcChyZWFzb246IHN0cmluZyk6IFByb21pc2U8QXV0b0FkdmFuY2VSZXN1bHQ+IHtcbiAgICBpZiAodGhpcy5zdGF0dXMucGhhc2UgPT09IFwic3RvcHBlZFwiKSB7XG4gICAgICByZXR1cm4geyBraW5kOiBcInN0b3BwZWRcIiwgcmVhc29uIH07XG4gICAgfVxuICAgIGF3YWl0IHRoaXMuZGVwcy53b3JrdHJlZS5jbGVhbnVwT25TdG9wKHJlYXNvbik7XG4gICAgdGhpcy5zdGF0dXMucGhhc2UgPSBcInN0b3BwZWRcIjtcbiAgICB0aGlzLnN0YXR1cy5hY3RpdmVVbml0ID0gdW5kZWZpbmVkO1xuICAgIHRoaXMubGFzdEFkdmFuY2VLZXkgPSBudWxsO1xuICAgIHRoaXMuZGlzcGF0Y2hLZXlXaW5kb3cgPSBbXTtcbiAgICB0aGlzLmJ1bXBUcmFuc2l0aW9uKCk7XG4gICAgYXdhaXQgdGhpcy5kZXBzLnJ1bnRpbWUuam91cm5hbFRyYW5zaXRpb24oeyBuYW1lOiBcInN0b3BcIiwgcmVhc29uIH0pO1xuICAgIGF3YWl0IHRoaXMuZGVwcy5ub3RpZmljYXRpb25zLm5vdGlmeUxpZmVjeWNsZSh7IG5hbWU6IFwic3RvcFwiLCBkZXRhaWw6IHJlYXNvbiB9KTtcbiAgICByZXR1cm4geyBraW5kOiBcInN0b3BwZWRcIiwgcmVhc29uIH07XG4gIH1cblxuICBwdWJsaWMgZ2V0U3RhdHVzKCk6IEF1dG9TdGF0dXMge1xuICAgIHJldHVybiB7IC4uLnRoaXMuc3RhdHVzLCBhY3RpdmVVbml0OiB0aGlzLnN0YXR1cy5hY3RpdmVVbml0ID8geyAuLi50aGlzLnN0YXR1cy5hY3RpdmVVbml0IH0gOiB1bmRlZmluZWQgfTtcbiAgfVxuXG4gIHByaXZhdGUgYnVtcFRyYW5zaXRpb24oKTogdm9pZCB7XG4gICAgdGhpcy5zdGF0dXMudHJhbnNpdGlvbkNvdW50ICs9IDE7XG4gICAgdGhpcy5zdGF0dXMubGFzdFRyYW5zaXRpb25BdCA9IG5vdygpO1xuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVBdXRvT3JjaGVzdHJhdG9yKGRlcHM6IEF1dG9PcmNoZXN0cmF0b3JEZXBzKTogQXV0b09yY2hlc3RyYXRpb25Nb2R1bGUge1xuICByZXR1cm4gbmV3IEF1dG9PcmNoZXN0cmF0b3IoZGVwcyk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFLQSxTQUFTLE1BQWM7QUFDckIsU0FBTyxLQUFLLElBQUk7QUFDbEI7QUFVTyxNQUFNLG9CQUFvQjtBQUUxQixNQUFNLGlCQUFvRDtBQUFBLEVBQ3ZELFNBQXFCO0FBQUEsSUFDM0IsT0FBTztBQUFBLElBQ1AsaUJBQWlCO0FBQUEsRUFDbkI7QUFBQSxFQUNpQjtBQUFBLEVBQ1QsaUJBQWdDO0FBQUEsRUFDaEMsb0JBQThCLENBQUM7QUFBQSxFQUVoQyxZQUFZLE1BQTRCO0FBQzdDLFNBQUssT0FBTztBQUFBLEVBQ2Q7QUFBQSxFQUVBLE1BQWEsTUFBTSxpQkFBaUU7QUFDbEYsU0FBSyxpQkFBaUI7QUFDdEIsU0FBSyxvQkFBb0IsQ0FBQztBQUMxQixTQUFLLE9BQU8sUUFBUTtBQUNwQixTQUFLLGVBQWU7QUFDcEIsVUFBTSxLQUFLLEtBQUssUUFBUSxrQkFBa0IsRUFBRSxNQUFNLFFBQVEsQ0FBQztBQUMzRCxVQUFNLEtBQUssS0FBSyxjQUFjLGdCQUFnQixFQUFFLE1BQU0sUUFBUSxDQUFDO0FBQy9ELFdBQU8sS0FBSyxRQUFRO0FBQUEsRUFDdEI7QUFBQSxFQUVBLE1BQWEsVUFBc0M7QUFDakQsUUFBSTtBQUNGLFlBQU0sS0FBSyxLQUFLLFFBQVEsb0JBQW9CO0FBRTVDLFlBQU0sV0FBVyxLQUFLLEtBQUssT0FBTyxvQkFBb0I7QUFDdEQsVUFBSSxVQUFVO0FBQ1osY0FBTSxLQUFLLEtBQUssUUFBUSxLQUFLO0FBQUEsVUFDM0IsUUFBUTtBQUFBLFVBQ1IsVUFBVTtBQUFBLFVBQ1YsU0FBUztBQUFBLFVBQ1QsY0FBYztBQUFBLFVBQ2QsV0FBVztB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
