import { logWarning } from "./workflow-logger.js";
import { resolvePostUnitHooks, resolvePreDispatchHooks } from "./preferences.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseUnitId } from "./unit-id.js";
function resolveHookArtifactPath(basePath, unitId, artifactName) {
  const { milestone, slice, task } = parseUnitId(unitId);
  if (task !== void 0 && slice !== void 0) {
    return join(basePath, ".gsd", "milestones", milestone, "slices", slice, "tasks", `${task}-${artifactName}`);
  }
  if (slice !== void 0) {
    return join(basePath, ".gsd", "milestones", milestone, "slices", slice, artifactName);
  }
  return join(basePath, ".gsd", "milestones", milestone, artifactName);
}
function convertDispatchRules(rules) {
  return rules.map((rule) => ({
    name: rule.name,
    when: "dispatch",
    evaluation: "first-match",
    where: rule.match,
    then: (result) => result,
    description: `Dispatch rule: ${rule.name}`
  }));
}
const HOOK_STATE_FILE = "hook-state.json";
class RuleRegistry {
  /** Static dispatch rules provided at construction time. */
  dispatchRules;
  // ── Mutable hook state (encapsulated, not module-level) ──────────────
  activeHook = null;
  hookQueue = [];
  cycleCounts = /* @__PURE__ */ new Map();
  retryPending = false;
  retryTrigger = null;
  constructor(dispatchRules) {
    this.dispatchRules = dispatchRules;
  }
  // ── Core query ───────────────────────────────────────────────────────
  /**
   * Returns all rules: static dispatch rules + dynamically loaded hook rules.
   * Hook rules are loaded fresh from preferences on each call (not cached).
   */
  listRules() {
    const rules = [...this.dispatchRules];
    const postHooks = resolvePostUnitHooks();
    for (const hook of postHooks) {
      rules.push({
        name: hook.name,
        when: "post-unit",
        evaluation: "all-matching",
        where: (unitType) => hook.after.includes(unitType),
        then: () => hook,
        description: `Post-unit hook: fires after ${hook.after.join(", ")}`,
        lifecycle: {
          artifact: hook.artifact,
          retry_on: hook.retry_on,
          max_cycles: hook.max_cycles
        }
      });
    }
    const preHooks = resolvePreDispatchHooks();
    for (const hook of preHooks) {
      rules.push({
        name: hook.name,
        when: "pre-dispatch",
        evaluation: "all-matching",
        where: (unitType) => hook.before.includes(unitType),
        then: () => hook,
        description: `Pre-dispatch hook: fires before ${hook.before.join(", ")}`
      });
    }
    return rules;
  }
  // ── Dispatch evaluation (async, first-match-wins) ───────────────────
  /**
   * Iterate dispatch rules in order. First match wins.
   * Returns stop action if no rule matches (unhandled phase).
   */
  async evaluateDispatch(ctx) {
    for (const rule of this.dispatchRules) {
      const result = await rule.where(ctx);
      if (result) {
        if (result.action !== "skip") result.matchedRule = rule.name;
        return result;
      }
    }
    return {
      action: "stop",
      reason: `Unhandled phase "${ctx.state.phase}" \u2014 run /gsd doctor to diagnose.`,
      level: "info",
      matchedRule: "<no-match>"
    };
  }
  // ── Post-unit hook evaluation (sync, all-matching with lifecycle) ────
  /**
   * Replicate exact semantics of checkPostUnitHooks from post-unit-hooks.ts:
   * hook-on-hook prevention, idempotency, cycle limits, retry_on, dequeue.
   */
  evaluatePostUnit(completedUnitType, completedUnitId, basePath) {
    if (this.activeHook) {
      return this._handleHookCompletion(basePath);
    }
    if (completedUnitType.startsWith("hook/") || completedUnitType === "triage-captures" || completedUnitType === "quick-task") {
      return null;
    }
    const hooks = resolvePostUnitHooks().filter(
      (h) => h.after.includes(completedUnitType)
    );
    if (hooks.length === 0) return null;
    this.hookQueue = hooks.map((config) => ({
      config,
      triggerUnitType: completedUnitType,
      triggerUnitId: completedUnitId
    }));
    return this._dequeueNextHook(basePath);
  }
  _dequeueNextHook(basePath) {
    while (this.hookQueue.length > 0) {
      const entry = this.hookQueue.shift();
      const { config, triggerUnitType, triggerUnitId } = entry;
      if (config.artifact) {
        const artifactPath = resolveHookArtifactPath(basePath, triggerUnitId, config.artifact);
        if (existsSync(artifactPath)) continue;
      }
      const cycleKey = `${config.name}/${triggerUnitType}/${triggerUnitId}`;
      const currentCycle = (this.cycleCounts.get(cycleKey) ?? 0) + 1;
      const maxCycles = config.max_cycles ?? 1;
      if (currentCycle > maxCycles) continue;
      this.cycleCounts.set(cycleKey, currentCycle);
      this.activeHook = {
        hookName: config.name,
        triggerUnitType,
        triggerUnitId,
        cycle: currentCycle,
        pendingRetry: false
      };
      const { milestone: mid, slice: sid, task: tid } = parseUnitId(triggerUnitId);
      let prompt = config.prompt.replace(/\{milestoneId\}/g, mid ?? "").replace(/\{sliceId\}/g, sid ?? "").replace(/\{taskId\}/g, tid ?? "");
      prompt += '\n\n**Browser tool safety:** Do NOT use `browser_wait_for` with `condition: "network_idle"` \u2014 it hangs indefinitely when dev servers keep persistent connections (Vite HMR, WebSocket). Use `selector_visible`, `text_visible`, or `delay` instead.';
      return {
        hookName: config.name,
        prompt,
        model: config.model,
        unitType: `hook/${config.name}`,
        unitId: triggerUnitId
      };
    }
    this.activeHook = null;
    return null;
  }
  _handleHookCompletion(basePath) {
    const hook = this.activeHook;
    const hooks = resolvePostUnitHooks();
    const config = hooks.find((h) => h.name === hook.hookName);
    if (config?.retry_on) {
      const retryArtifactPath = resolveHookArtifactPath(basePath, hook.triggerUnitId, config.retry_on);
      if (existsSync(retryArtifactPath)) {
        const cycleKey = `${config.name}/${hook.triggerUnitType}/${hook.triggerUnitId}`;
        const currentCycle = this.cycleCounts.get(cycleKey) ?? 1;
        const maxCycles = config.max_cycles ?? 1;
        if (currentCycle < maxCycles) {
          this.activeHook = null;
          this.hookQueue = [];
          this.retryPending = true;
          this.retryTrigger = {
            unitType: hook.triggerUnitType,
            unitId: hook.triggerUnitId,
            retryArtifact: config.retry_on
          };
          return null;
        }
      }
    }
    this.activeHook = null;
    return this._dequeueNextHook(basePath);
  }
  // ── Pre-dispatch hook evaluation (sync, all-matching with compose) ──
  /**
   * Replicate exact semantics of runPreDispatchHooks from post-unit-hooks.ts:
   * modify/skip/replace compose semantics.
   */
  evaluatePreDispatch(unitType, unitId, prompt, basePath) {
    if (unitType.startsWith("hook/")) {
      return { action: "proceed", prompt, firedHooks: [] };
    }
    const hooks = resolvePreDispatchHooks().filter(
      (h) => h.before.includes(unitType)
    );
    if (hooks.length === 0) {
      return { action: "proceed", prompt, firedHooks: [] };
    }
    const { milestone: mid, slice: sid, task: tid } = parseUnitId(unitId);
    const substitute = (text) => text.replace(/\{milestoneId\}/g, mid ?? "").replace(/\{sliceId\}/g, sid ?? "").replace(/\{taskId\}/g, tid ?? "");
    const firedHooks = [];
    let currentPrompt = prompt;
    for (const hook of hooks) {
      if (hook.action === "skip") {
        if (hook.skip_if) {
          const conditionPath = resolveHookArtifactPath(basePath, unitId, hook.skip_if);
          if (!existsSync(conditionPath)) continue;
        }
        firedHooks.push(hook.name);
        return { action: "skip", firedHooks };
      }
      if (hook.action === "replace") {
        firedHooks.push(hook.name);
        return {
          action: "replace",
          prompt: substitute(hook.prompt ?? ""),
          unitType: hook.unit_type,
          model: hook.model,
          firedHooks
        };
      }
      if (hook.action === "modify") {
        firedHooks.push(hook.name);
        if (hook.prepend) {
          currentPrompt = `${substitute(hook.prepend)}

${currentPrompt}`;
        }
        if (hook.append) {
          currentPrompt = `${currentPrompt}

${substitute(hook.append)}`;
        }
      }
    }
    return {
      action: "proceed",
      prompt: currentPrompt,
      model: hooks.find((h) => h.action === "modify" && h.model)?.model,
      firedHooks
    };
  }
  // ── State accessors ─────────────────────────────────────────────────
  getActiveHook() {
    return this.activeHook;
  }
  isRetryPending() {
    return this.retryPending;
  }
  /**
   * Returns the trigger unit info for a pending retry, or null.
   * Clears the retry state after reading.
   */
  consumeRetryTrigger() {
    if (!this.retryPending || !this.retryTrigger) return null;
    const trigger = { ...this.retryTrigger };
    this.retryPending = false;
    this.retryTrigger = null;
    return trigger;
  }
  /** Clear all mutable state (activeHook, hookQueue, cycleCounts, retryPending, retryTrigger). */
  resetState() {
    this.activeHook = null;
    this.hookQueue = [];
    this.cycleCounts.clear();
    this.retryPending = false;
    this.retryTrigger = null;
  }
  // ── Persistence ─────────────────────────────────────────────────────
  _hookStatePath(basePath) {
    return join(basePath, ".gsd", HOOK_STATE_FILE);
  }
  /** Persist current hook cycle counts to disk. */
  persistState(basePath) {
    const state = {
      cycleCounts: Object.fromEntries(this.cycleCounts),
      savedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    try {
      const dir = join(basePath, ".gsd");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this._hookStatePath(basePath), JSON.stringify(state, null, 2), "utf-8");
    } catch (e) {
      logWarning("registry", `failed to persist hook state: ${e.message}`);
    }
  }
  /** Restore hook cycle counts from disk after a crash/restart. */
  restoreState(basePath) {
    try {
      const filePath = this._hookStatePath(basePath);
      if (!existsSync(filePath)) return;
      const raw = readFileSync(filePath, "utf-8");
      const state = JSON.parse(raw);
      if (state.cycleCounts && typeof state.cycleCounts === "object") {
        this.cycleCounts.clear();
        for (const [key, value] of Object.entries(state.cycleCounts)) {
          if (typeof value === "number") {
            this.cycleCounts.set(key, value);
          }
        }
      }
    } catch (e) {
      logWarning("registry", `failed to restore hook state: ${e.message}`);
    }
  }
  /** Clear persisted hook state file from disk. */
  clearPersistedState(basePath) {
    try {
      const filePath = this._hookStatePath(basePath);
      if (existsSync(filePath)) {
        writeFileSync(
          filePath,
          JSON.stringify({ cycleCounts: {}, savedAt: (/* @__PURE__ */ new Date()).toISOString() }, null, 2),
          "utf-8"
        );
      }
    } catch (e) {
      logWarning("registry", `failed to clear hook state: ${e.message}`);
    }
  }
  // ── Hook status reporting ───────────────────────────────────────────
  /** Get status of all configured hooks for display. */
  getHookStatus() {
    const entries = [];
    const postHooks = resolvePostUnitHooks();
    for (const hook of postHooks) {
      const activeCycles = {};
      for (const [key, count] of this.cycleCounts) {
        if (key.startsWith(`${hook.name}/`)) {
          activeCycles[key] = count;
        }
      }
      entries.push({
        name: hook.name,
        type: "post",
        enabled: hook.enabled !== false,
        targets: hook.after,
        activeCycles
      });
    }
    const preHooks = resolvePreDispatchHooks();
    for (const hook of preHooks) {
      entries.push({
        name: hook.name,
        type: "pre",
        enabled: hook.enabled !== false,
        targets: hook.before,
        activeCycles: {}
      });
    }
    return entries;
  }
  /**
   * Manually trigger a specific hook for a unit.
   * Bypasses normal flow — forces hook to run even if artifact exists.
   */
  triggerHookManually(hookName, unitType, unitId, basePath) {
    const hook = resolvePostUnitHooks().find((h) => h.name === hookName);
    if (!hook) {
      console.error(`[triggerHookManually] Hook "${hookName}" not found in post_unit_hooks`);
      return null;
    }
    if (!hook.prompt || typeof hook.prompt !== "string" || hook.prompt.trim().length === 0) {
      console.error(`[triggerHookManually] Hook "${hookName}" has empty prompt`);
      return null;
    }
    this.activeHook = {
      hookName: hook.name,
      triggerUnitType: unitType,
      triggerUnitId: unitId,
      cycle: 1,
      pendingRetry: false
    };
    this.hookQueue = [{
      config: hook,
      triggerUnitType: unitType,
      triggerUnitId: unitId
    }];
    const cycleKey = `${hook.name}/${unitType}/${unitId}`;
    const currentCycle = (this.cycleCounts.get(cycleKey) ?? 0) + 1;
    this.cycleCounts.set(cycleKey, currentCycle);
    this.activeHook.cycle = currentCycle;
    const { milestone: mid, slice: sid, task: tid } = parseUnitId(unitId);
    const prompt = hook.prompt.replace(/\{milestoneId\}/g, mid ?? "").replace(/\{sliceId\}/g, sid ?? "").replace(/\{taskId\}/g, tid ?? "");
    return {
      hookName: hook.name,
      prompt,
      model: hook.model,
      unitType: `hook/${hook.name}`,
      unitId
    };
  }
  /** Format hook status for terminal display. */
  formatHookStatus() {
    const entries = this.getHookStatus();
    if (entries.length === 0) {
      return "No hooks configured. Add post_unit_hooks or pre_dispatch_hooks to .gsd/PREFERENCES.md";
    }
    const lines = ["Configured Hooks:", ""];
    const postHooks = entries.filter((e) => e.type === "post");
    const preHooks = entries.filter((e) => e.type === "pre");
    if (postHooks.length > 0) {
      lines.push("Post-Unit Hooks (run after unit completes):");
      for (const hook of postHooks) {
        const status = hook.enabled ? "enabled" : "disabled";
        const cycles = Object.keys(hook.activeCycles).length;
        const cycleInfo = cycles > 0 ? ` (${cycles} active cycle${cycles === 1 ? "" : "s"})` : "";
        lines.push(`  ${hook.name} [${status}] \u2192 after: ${hook.targets.join(", ")}${cycleInfo}`);
      }
      lines.push("");
    }
    if (preHooks.length > 0) {
      lines.push("Pre-Dispatch Hooks (run before unit dispatches):");
      for (const hook of preHooks) {
        const status = hook.enabled ? "enabled" : "disabled";
        lines.push(`  ${hook.name} [${status}] \u2192 before: ${hook.targets.join(", ")}`);
      }
      lines.push("");
    }
    return lines.join("\n");
  }
}
let _registry = null;
function getRegistry() {
  if (!_registry) {
    throw new Error("RuleRegistry not initialized \u2014 call initRegistry() or setRegistry() first.");
  }
  return _registry;
}
function setRegistry(r) {
  _registry = r;
}
function initRegistry(dispatchRules) {
  const registry = new RuleRegistry(dispatchRules);
  setRegistry(registry);
  return registry;
}
function getOrCreateRegistry() {
  if (!_registry) {
    _registry = new RuleRegistry([]);
  }
  return _registry;
}
function resetRegistry() {
  _registry = null;
}
export {
  RuleRegistry,
  convertDispatchRules,
  getOrCreateRegistry,
  getRegistry,
  initRegistry,
  resetRegistry,
  resolveHookArtifactPath,
  setRegistry
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9ydWxlLXJlZ2lzdHJ5LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBHU0QgRXh0ZW5zaW9uIFx1MjAxNCBVbmlmaWVkIFJ1bGUgUmVnaXN0cnlcbi8vXG4vLyBIb2xkcyBhbGwgZGlzcGF0Y2ggcnVsZXMgYW5kIGhvb2tzIGFzIGEgZmxhdCBsaXN0IG9mIFVuaWZpZWRSdWxlIG9iamVjdHMuXG4vLyBQcm92aWRlcyBldmFsdWF0aW9uIG1ldGhvZHMgZm9yIGVhY2ggcGhhc2UgKGRpc3BhdGNoLCBwb3N0LXVuaXQsIHByZS1kaXNwYXRjaClcbi8vIGFuZCBlbmNhcHN1bGF0ZXMgbXV0YWJsZSBob29rIHN0YXRlIGFzIGluc3RhbmNlIGZpZWxkcy5cbi8vXG4vLyBBIG1vZHVsZS1sZXZlbCBzaW5nbGV0b24gYWNjZXNzb3IgYWxsb3dzIGV4aXN0aW5nIGNvZGUgdG8gbWlncmF0ZSBpbmNyZW1lbnRhbGx5LlxuXG5pbXBvcnQgeyBsb2dXYXJuaW5nIH0gZnJvbSBcIi4vd29ya2Zsb3ctbG9nZ2VyLmpzXCI7XG5pbXBvcnQgdHlwZSB7IFVuaWZpZWRSdWxlLCBSdWxlUGhhc2UgfSBmcm9tIFwiLi9ydWxlLXR5cGVzLmpzXCI7XG5pbXBvcnQgdHlwZSB7IERpc3BhdGNoQWN0aW9uLCBEaXNwYXRjaENvbnRleHQsIERpc3BhdGNoUnVsZSB9IGZyb20gXCIuL2F1dG8tZGlzcGF0Y2guanNcIjtcbmltcG9ydCB0eXBlIHtcbiAgUG9zdFVuaXRIb29rQ29uZmlnLFxuICBQcmVEaXNwYXRjaEhvb2tDb25maWcsXG4gIEhvb2tEaXNwYXRjaFJlc3VsdCxcbiAgUHJlRGlzcGF0Y2hSZXN1bHQsXG4gIEhvb2tFeGVjdXRpb25TdGF0ZSxcbiAgUGVyc2lzdGVkSG9va1N0YXRlLFxuICBIb29rU3RhdHVzRW50cnksXG59IGZyb20gXCIuL3R5cGVzLmpzXCI7XG5pbXBvcnQgeyByZXNvbHZlUG9zdFVuaXRIb29rcywgcmVzb2x2ZVByZURpc3BhdGNoSG9va3MgfSBmcm9tIFwiLi9wcmVmZXJlbmNlcy5qc1wiO1xuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jLCB3cml0ZUZpbGVTeW5jLCBta2RpclN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHBhcnNlVW5pdElkIH0gZnJvbSBcIi4vdW5pdC1pZC5qc1wiO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQXJ0aWZhY3QgUGF0aCBSZXNvbHV0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZUhvb2tBcnRpZmFjdFBhdGgoYmFzZVBhdGg6IHN0cmluZywgdW5pdElkOiBzdHJpbmcsIGFydGlmYWN0TmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgeyBtaWxlc3RvbmUsIHNsaWNlLCB0YXNrIH0gPSBwYXJzZVVuaXRJZCh1bml0SWQpO1xuICBpZiAodGFzayAhPT0gdW5kZWZpbmVkICYmIHNsaWNlICE9PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4gam9pbihiYXNlUGF0aCwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBtaWxlc3RvbmUsIFwic2xpY2VzXCIsIHNsaWNlLCBcInRhc2tzXCIsIGAke3Rhc2t9LSR7YXJ0aWZhY3ROYW1lfWApO1xuICB9XG4gIGlmIChzbGljZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIGpvaW4oYmFzZVBhdGgsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgbWlsZXN0b25lLCBcInNsaWNlc1wiLCBzbGljZSwgYXJ0aWZhY3ROYW1lKTtcbiAgfVxuICByZXR1cm4gam9pbihiYXNlUGF0aCwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBtaWxlc3RvbmUsIGFydGlmYWN0TmFtZSk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBEaXNwYXRjaCBSdWxlIENvbnZlcnNpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogQ29udmVydCBhbiBhcnJheSBvZiBEaXNwYXRjaFJ1bGUgb2JqZWN0cyB0byBVbmlmaWVkUnVsZVtdIGZvcm1hdC5cbiAqIFByZXNlcnZlcyBleGFjdCBhcnJheSBvcmRlciBcdTIwMTQgZGlzcGF0Y2ggaXMgb3JkZXItZGVwZW5kZW50IChmaXJzdC1tYXRjaC13aW5zKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbnZlcnREaXNwYXRjaFJ1bGVzKHJ1bGVzOiBEaXNwYXRjaFJ1bGVbXSk6IFVuaWZpZWRSdWxlW10ge1xuICByZXR1cm4gcnVsZXMubWFwKChydWxlKSA9PiAoe1xuICAgIG5hbWU6IHJ1bGUubmFtZSxcbiAgICB3aGVuOiBcImRpc3BhdGNoXCIgYXMgY29uc3QsXG4gICAgZXZhbHVhdGlvbjogXCJmaXJzdC1tYXRjaFwiIGFzIGNvbnN0LFxuICAgIHdoZXJlOiBydWxlLm1hdGNoLFxuICAgIHRoZW46IChyZXN1bHQ6IGFueSkgPT4gcmVzdWx0LFxuICAgIGRlc2NyaXB0aW9uOiBgRGlzcGF0Y2ggcnVsZTogJHtydWxlLm5hbWV9YCxcbiAgfSkpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUnVsZVJlZ2lzdHJ5IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5jb25zdCBIT09LX1NUQVRFX0ZJTEUgPSBcImhvb2stc3RhdGUuanNvblwiO1xuXG5leHBvcnQgY2xhc3MgUnVsZVJlZ2lzdHJ5IHtcbiAgLyoqIFN0YXRpYyBkaXNwYXRjaCBydWxlcyBwcm92aWRlZCBhdCBjb25zdHJ1Y3Rpb24gdGltZS4gKi9cbiAgcHJpdmF0ZSByZWFkb25seSBkaXNwYXRjaFJ1bGVzOiBVbmlmaWVkUnVsZVtdO1xuXG4gIC8vIFx1MjUwMFx1MjUwMCBNdXRhYmxlIGhvb2sgc3RhdGUgKGVuY2Fwc3VsYXRlZCwgbm90IG1vZHVsZS1sZXZlbCkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbiAgYWN0aXZlSG9vazogSG9va0V4ZWN1dGlvblN0YXRlIHwgbnVsbCA9IG51bGw7XG4gIGhvb2tRdWV1ZTogQXJyYXk8e1xuICAgIGNvbmZpZzogUG9zdFVuaXRIb29rQ29uZmlnO1xuICAgIHRyaWdnZXJVbml0VHlwZTogc3RyaW5nO1xuICAgIHRyaWdnZXJVbml0SWQ6IHN0cmluZztcbiAgfT4gPSBbXTtcbiAgY3ljbGVDb3VudHM6IE1hcDxzdHJpbmcsIG51bWJlcj4gPSBuZXcgTWFwKCk7XG4gIHJldHJ5UGVuZGluZzogYm9vbGVhbiA9IGZhbHNlO1xuICByZXRyeVRyaWdnZXI6IHsgdW5pdFR5cGU6IHN0cmluZzsgdW5pdElkOiBzdHJpbmc7IHJldHJ5QXJ0aWZhY3Q6IHN0cmluZyB9IHwgbnVsbCA9IG51bGw7XG5cbiAgY29uc3RydWN0b3IoZGlzcGF0Y2hSdWxlczogVW5pZmllZFJ1bGVbXSkge1xuICAgIHRoaXMuZGlzcGF0Y2hSdWxlcyA9IGRpc3BhdGNoUnVsZXM7XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgQ29yZSBxdWVyeSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuICAvKipcbiAgICogUmV0dXJucyBhbGwgcnVsZXM6IHN0YXRpYyBkaXNwYXRjaCBydWxlcyArIGR5bmFtaWNhbGx5IGxvYWRlZCBob29rIHJ1bGVzLlxuICAgKiBIb29rIHJ1bGVzIGFyZSBsb2FkZWQgZnJlc2ggZnJvbSBwcmVmZXJlbmNlcyBvbiBlYWNoIGNhbGwgKG5vdCBjYWNoZWQpLlxuICAgKi9cbiAgbGlzdFJ1bGVzKCk6IFVuaWZpZWRSdWxlW10ge1xuICAgIGNvbnN0IHJ1bGVzOiBVbmlmaWVkUnVsZVtdID0gWy4uLnRoaXMuZGlzcGF0Y2hSdWxlc107XG5cbiAgICAvLyBDb252ZXJ0IHBvc3QtdW5pdCBob29rcyB0byB1bmlmaWVkIHJ1bGVzXG4gICAgY29uc3QgcG9zdEhvb2tzID0gcmVzb2x2ZVBvc3RVbml0SG9va3MoKTtcbiAgICBmb3IgKGNvbnN0IGhvb2sgb2YgcG9zdEhvb2tzKSB7XG4gICAgICBydWxlcy5wdXNoKHtcbiAgICAgICAgbmFtZTogaG9vay5uYW1lLFxuICAgICAgICB3aGVuOiBcInBvc3QtdW5pdFwiLFxuICAgICAgICBldmFsdWF0aW9uOiBcImFsbC1tYXRjaGluZ1wiLFxuICAgICAgICB3aGVyZTogKHVuaXRUeXBlOiBzdHJpbmcpID0+IGhvb2suYWZ0ZXIuaW5jbHVkZXModW5pdFR5cGUpLFxuICAgICAgICB0aGVuOiAoKSA9PiBob29rLFxuICAgICAgICBkZXNjcmlwdGlvbjogYFBvc3QtdW5pdCBob29rOiBmaXJlcyBhZnRlciAke2hvb2suYWZ0ZXIuam9pbihcIiwgXCIpfWAsXG4gICAgICAgIGxpZmVjeWNsZToge1xuICAgICAgICAgIGFydGlmYWN0OiBob29rLmFydGlmYWN0LFxuICAgICAgICAgIHJldHJ5X29uOiBob29rLnJldHJ5X29uLFxuICAgICAgICAgIG1heF9jeWNsZXM6IGhvb2subWF4X2N5Y2xlcyxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIENvbnZlcnQgcHJlLWRpc3BhdGNoIGhvb2tzIHRvIHVuaWZpZWQgcnVsZXNcbiAgICBjb25zdCBwcmVIb29rcyA9IHJlc29sdmVQcmVEaXNwYXRjaEhvb2tzKCk7XG4gICAgZm9yIChjb25zdCBob29rIG9mIHByZUhvb2tzKSB7XG4gICAgICBydWxlcy5wdXNoKHtcbiAgICAgICAgbmFtZTogaG9vay5uYW1lLFxuICAgICAgICB3aGVuOiBcInByZS1kaXNwYXRjaFwiLFxuICAgICAgICBldmFsdWF0aW9uOiBcImFsbC1tYXRjaGluZ1wiLFxuICAgICAgICB3aGVyZTogKHVuaXRUeXBlOiBzdHJpbmcpID0+IGhvb2suYmVmb3JlLmluY2x1ZGVzKHVuaXRUeXBlKSxcbiAgICAgICAgdGhlbjogKCkgPT4gaG9vayxcbiAgICAgICAgZGVzY3JpcHRpb246IGBQcmUtZGlzcGF0Y2ggaG9vazogZmlyZXMgYmVmb3JlICR7aG9vay5iZWZvcmUuam9pbihcIiwgXCIpfWAsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICByZXR1cm4gcnVsZXM7XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgRGlzcGF0Y2ggZXZhbHVhdGlvbiAoYXN5bmMsIGZpcnN0LW1hdGNoLXdpbnMpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4gIC8qKlxuICAgKiBJdGVyYXRlIGRpc3BhdGNoIHJ1bGVzIGluIG9yZGVyLiBGaXJzdCBtYXRjaCB3aW5zLlxuICAgKiBSZXR1cm5zIHN0b3AgYWN0aW9uIGlmIG5vIHJ1bGUgbWF0Y2hlcyAodW5oYW5kbGVkIHBoYXNlKS5cbiAgICovXG4gIGFzeW5jIGV2YWx1YXRlRGlzcGF0Y2goY3R4OiBEaXNwYXRjaENvbnRleHQpOiBQcm9taXNlPERpc3BhdGNoQWN0aW9uPiB7XG4gICAgZm9yIChjb25zdCBydWxlIG9mIHRoaXMuZGlzcGF0Y2hSdWxlcykge1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVsZS53aGVyZShjdHgpO1xuICAgICAgaWYgKHJlc3VsdCkge1xuICAgICAgICBpZiAocmVzdWx0LmFjdGlvbiAhPT0gXCJza2lwXCIpIHJlc3VsdC5tYXRjaGVkUnVsZSA9IHJ1bGUubmFtZTtcbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHtcbiAgICAgIGFjdGlvbjogXCJzdG9wXCIsXG4gICAgICByZWFzb246IGBVbmhhbmRsZWQgcGhhc2UgXCIke2N0eC5zdGF0ZS5waGFzZX1cIiBcdTIwMTQgcnVuIC9nc2QgZG9jdG9yIHRvIGRpYWdub3NlLmAsXG4gICAgICBsZXZlbDogXCJpbmZvXCIsXG4gICAgICBtYXRjaGVkUnVsZTogXCI8bm8tbWF0Y2g+XCIsXG4gICAgfTtcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBQb3N0LXVuaXQgaG9vayBldmFsdWF0aW9uIChzeW5jLCBhbGwtbWF0Y2hpbmcgd2l0aCBsaWZlY3ljbGUpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4gIC8qKlxuICAgKiBSZXBsaWNhdGUgZXhhY3Qgc2VtYW50aWNzIG9mIGNoZWNrUG9zdFVuaXRIb29rcyBmcm9tIHBvc3QtdW5pdC1ob29rcy50czpcbiAgICogaG9vay1vbi1ob29rIHByZXZlbnRpb24sIGlkZW1wb3RlbmN5LCBjeWNsZSBsaW1pdHMsIHJldHJ5X29uLCBkZXF1ZXVlLlxuICAgKi9cbiAgZXZhbHVhdGVQb3N0VW5pdChcbiAgICBjb21wbGV0ZWRVbml0VHlwZTogc3RyaW5nLFxuICAgIGNvbXBsZXRlZFVuaXRJZDogc3RyaW5nLFxuICAgIGJhc2VQYXRoOiBzdHJpbmcsXG4gICk6IEhvb2tEaXNwYXRjaFJlc3VsdCB8IG51bGwge1xuICAgIC8vIElmIHdlIGp1c3QgY29tcGxldGVkIGEgaG9vayB1bml0LCBoYW5kbGUgaXRzIHJlc3VsdFxuICAgIGlmICh0aGlzLmFjdGl2ZUhvb2spIHtcbiAgICAgIHJldHVybiB0aGlzLl9oYW5kbGVIb29rQ29tcGxldGlvbihiYXNlUGF0aCk7XG4gICAgfVxuXG4gICAgLy8gRG9uJ3QgdHJpZ2dlciBob29rcyBmb3Igb3RoZXIgaG9vayB1bml0cyAocHJldmVudCBob29rLW9uLWhvb2sgY2hhaW5zKVxuICAgIC8vIERvbid0IHRyaWdnZXIgaG9va3MgZm9yIHRyaWFnZSB1bml0cyBvciBxdWljay10YXNrIHVuaXRzXG4gICAgaWYgKFxuICAgICAgY29tcGxldGVkVW5pdFR5cGUuc3RhcnRzV2l0aChcImhvb2svXCIpIHx8XG4gICAgICBjb21wbGV0ZWRVbml0VHlwZSA9PT0gXCJ0cmlhZ2UtY2FwdHVyZXNcIiB8fFxuICAgICAgY29tcGxldGVkVW5pdFR5cGUgPT09IFwicXVpY2stdGFza1wiXG4gICAgKSB7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG5cbiAgICAvLyBDaGVjayBpZiBhbnkgaG9va3MgYXJlIGNvbmZpZ3VyZWQgZm9yIHRoaXMgdW5pdCB0eXBlXG4gICAgY29uc3QgaG9va3MgPSByZXNvbHZlUG9zdFVuaXRIb29rcygpLmZpbHRlcihoID0+XG4gICAgICBoLmFmdGVyLmluY2x1ZGVzKGNvbXBsZXRlZFVuaXRUeXBlKSxcbiAgICApO1xuICAgIGlmIChob29rcy5sZW5ndGggPT09IDApIHJldHVybiBudWxsO1xuXG4gICAgLy8gQnVpbGQgaG9vayBxdWV1ZSBmb3IgdGhpcyB0cmlnZ2VyXG4gICAgdGhpcy5ob29rUXVldWUgPSBob29rcy5tYXAoY29uZmlnID0+ICh7XG4gICAgICBjb25maWcsXG4gICAgICB0cmlnZ2VyVW5pdFR5cGU6IGNvbXBsZXRlZFVuaXRUeXBlLFxuICAgICAgdHJpZ2dlclVuaXRJZDogY29tcGxldGVkVW5pdElkLFxuICAgIH0pKTtcblxuICAgIHJldHVybiB0aGlzLl9kZXF1ZXVlTmV4dEhvb2soYmFzZVBhdGgpO1xuICB9XG5cbiAgcHJpdmF0ZSBfZGVxdWV1ZU5leHRIb29rKGJhc2VQYXRoOiBzdHJpbmcpOiBIb29rRGlzcGF0Y2hSZXN1bHQgfCBudWxsIHtcbiAgICB3aGlsZSAodGhpcy5ob29rUXVldWUubGVuZ3RoID4gMCkge1xuICAgICAgY29uc3QgZW50cnkgPSB0aGlzLmhvb2tRdWV1ZS5zaGlmdCgpITtcbiAgICAgIGNvbnN0IHsgY29uZmlnLCB0cmlnZ2VyVW5pdFR5cGUsIHRyaWdnZXJVbml0SWQgfSA9IGVudHJ5O1xuXG4gICAgICAvLyBDaGVjayBpZGVtcG90ZW5jeSBcdTIwMTQgaWYgYXJ0aWZhY3QgYWxyZWFkeSBleGlzdHMsIHNraXBcbiAgICAgIGlmIChjb25maWcuYXJ0aWZhY3QpIHtcbiAgICAgICAgY29uc3QgYXJ0aWZhY3RQYXRoID0gcmVzb2x2ZUhvb2tBcnRpZmFjdFBhdGgoYmFzZVBhdGgsIHRyaWdnZXJVbml0SWQsIGNvbmZpZy5hcnRpZmFjdCk7XG4gICAgICAgIGlmIChleGlzdHNTeW5jKGFydGlmYWN0UGF0aCkpIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICAvLyBDaGVjayBjeWNsZSBsaW1pdFxuICAgICAgY29uc3QgY3ljbGVLZXkgPSBgJHtjb25maWcubmFtZX0vJHt0cmlnZ2VyVW5pdFR5cGV9LyR7dHJpZ2dlclVuaXRJZH1gO1xuICAgICAgY29uc3QgY3VycmVudEN5Y2xlID0gKHRoaXMuY3ljbGVDb3VudHMuZ2V0KGN5Y2xlS2V5KSA/PyAwKSArIDE7XG4gICAgICBjb25zdCBtYXhDeWNsZXMgPSBjb25maWcubWF4X2N5Y2xlcyA/PyAxO1xuICAgICAgaWYgKGN1cnJlbnRDeWNsZSA+IG1heEN5Y2xlcykgY29udGludWU7XG5cbiAgICAgIHRoaXMuY3ljbGVDb3VudHMuc2V0KGN5Y2xlS2V5LCBjdXJyZW50Q3ljbGUpO1xuXG4gICAgICB0aGlzLmFjdGl2ZUhvb2sgPSB7XG4gICAgICAgIGhvb2tOYW1lOiBjb25maWcubmFtZSxcbiAgICAgICAgdHJpZ2dlclVuaXRUeXBlLFxuICAgICAgICB0cmlnZ2VyVW5pdElkLFxuICAgICAgICBjeWNsZTogY3VycmVudEN5Y2xlLFxuICAgICAgICBwZW5kaW5nUmV0cnk6IGZhbHNlLFxuICAgICAgfTtcblxuICAgICAgLy8gQnVpbGQgcHJvbXB0IHdpdGggdmFyaWFibGUgc3Vic3RpdHV0aW9uXG4gICAgICBjb25zdCB7IG1pbGVzdG9uZTogbWlkLCBzbGljZTogc2lkLCB0YXNrOiB0aWQgfSA9IHBhcnNlVW5pdElkKHRyaWdnZXJVbml0SWQpO1xuICAgICAgbGV0IHByb21wdCA9IGNvbmZpZy5wcm9tcHRcbiAgICAgICAgLnJlcGxhY2UoL1xce21pbGVzdG9uZUlkXFx9L2csIG1pZCA/PyBcIlwiKVxuICAgICAgICAucmVwbGFjZSgvXFx7c2xpY2VJZFxcfS9nLCBzaWQgPz8gXCJcIilcbiAgICAgICAgLnJlcGxhY2UoL1xce3Rhc2tJZFxcfS9nLCB0aWQgPz8gXCJcIik7XG5cbiAgICAgIC8vIEluamVjdCBicm93c2VyIHNhZmV0eSBpbnN0cnVjdGlvblxuICAgICAgcHJvbXB0ICs9IFwiXFxuXFxuKipCcm93c2VyIHRvb2wgc2FmZXR5OioqIERvIE5PVCB1c2UgYGJyb3dzZXJfd2FpdF9mb3JgIHdpdGggYGNvbmRpdGlvbjogXFxcIm5ldHdvcmtfaWRsZVxcXCJgIFx1MjAxNCBpdCBoYW5ncyBpbmRlZmluaXRlbHkgd2hlbiBkZXYgc2VydmVycyBrZWVwIHBlcnNpc3RlbnQgY29ubmVjdGlvbnMgKFZpdGUgSE1SLCBXZWJTb2NrZXQpLiBVc2UgYHNlbGVjdG9yX3Zpc2libGVgLCBgdGV4dF92aXNpYmxlYCwgb3IgYGRlbGF5YCBpbnN0ZWFkLlwiO1xuXG4gICAgICByZXR1cm4ge1xuICAgICAgICBob29rTmFtZTogY29uZmlnLm5hbWUsXG4gICAgICAgIHByb21wdCxcbiAgICAgICAgbW9kZWw6IGNvbmZpZy5tb2RlbCxcbiAgICAgICAgdW5pdFR5cGU6IGBob29rLyR7Y29uZmlnLm5hbWV9YCxcbiAgICAgICAgdW5pdElkOiB0cmlnZ2VyVW5pdElkLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyBObyBtb3JlIGhvb2tzIFx1MjAxNCBjbGVhciBhY3RpdmUgc3RhdGVcbiAgICB0aGlzLmFjdGl2ZUhvb2sgPSBudWxsO1xuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgcHJpdmF0ZSBfaGFuZGxlSG9va0NvbXBsZXRpb24oYmFzZVBhdGg6IHN0cmluZyk6IEhvb2tEaXNwYXRjaFJlc3VsdCB8IG51bGwge1xuICAgIGNvbnN0IGhvb2sgPSB0aGlzLmFjdGl2ZUhvb2shO1xuICAgIGNvbnN0IGhvb2tzID0gcmVzb2x2ZVBvc3RVbml0SG9va3MoKTtcbiAgICBjb25zdCBjb25maWcgPSBob29rcy5maW5kKGggPT4gaC5uYW1lID09PSBob29rLmhvb2tOYW1lKTtcblxuICAgIC8vIENoZWNrIGlmIHJldHJ5IHdhcyByZXF1ZXN0ZWQgdmlhIHJldHJ5X29uIGFydGlmYWN0XG4gICAgaWYgKGNvbmZpZz8ucmV0cnlfb24pIHtcbiAgICAgIGNvbnN0IHJldHJ5QXJ0aWZhY3RQYXRoID0gcmVzb2x2ZUhvb2tBcnRpZmFjdFBhdGgoYmFzZVBhdGgsIGhvb2sudHJpZ2dlclVuaXRJZCwgY29uZmlnLnJldHJ5X29uKTtcbiAgICAgIGlmIChleGlzdHNTeW5jKHJldHJ5QXJ0aWZhY3RQYXRoKSkge1xuICAgICAgICBjb25zdCBjeWNsZUtleSA9IGAke2NvbmZpZy5uYW1lfS8ke2hvb2sudHJpZ2dlclVuaXRUeXBlfS8ke2hvb2sudHJpZ2dlclVuaXRJZH1gO1xuICAgICAgICBjb25zdCBjdXJyZW50Q3ljbGUgPSB0aGlzLmN5Y2xlQ291bnRzLmdldChjeWNsZUtleSkgPz8gMTtcbiAgICAgICAgY29uc3QgbWF4Q3ljbGVzID0gY29uZmlnLm1heF9jeWNsZXMgPz8gMTtcblxuICAgICAgICBpZiAoY3VycmVudEN5Y2xlIDwgbWF4Q3ljbGVzKSB7XG4gICAgICAgICAgdGhpcy5hY3RpdmVIb29rID0gbnVsbDtcbiAgICAgICAgICB0aGlzLmhvb2tRdWV1ZSA9IFtdO1xuICAgICAgICAgIHRoaXMucmV0cnlQZW5kaW5nID0gdHJ1ZTtcbiAgICAgICAgICB0aGlzLnJldHJ5VHJpZ2dlciA9IHtcbiAgICAgICAgICAgIHVuaXRUeXBlOiBob29rLnRyaWdnZXJVbml0VHlwZSxcbiAgICAgICAgICAgIHVuaXRJZDogaG9vay50cmlnZ2VyVW5pdElkLFxuICAgICAgICAgICAgcmV0cnlBcnRpZmFjdDogY29uZmlnLnJldHJ5X29uLFxuICAgICAgICAgIH07XG4gICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBIb29rIGNvbXBsZXRlZCBub3JtYWxseSBcdTIwMTQgdHJ5IG5leHQgaG9vayBpbiBxdWV1ZVxuICAgIHRoaXMuYWN0aXZlSG9vayA9IG51bGw7XG4gICAgcmV0dXJuIHRoaXMuX2RlcXVldWVOZXh0SG9vayhiYXNlUGF0aCk7XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgUHJlLWRpc3BhdGNoIGhvb2sgZXZhbHVhdGlvbiAoc3luYywgYWxsLW1hdGNoaW5nIHdpdGggY29tcG9zZSkgXHUyNTAwXHUyNTAwXG5cbiAgLyoqXG4gICAqIFJlcGxpY2F0ZSBleGFjdCBzZW1hbnRpY3Mgb2YgcnVuUHJlRGlzcGF0Y2hIb29rcyBmcm9tIHBvc3QtdW5pdC1ob29rcy50czpcbiAgICogbW9kaWZ5L3NraXAvcmVwbGFjZSBjb21wb3NlIHNlbWFudGljcy5cbiAgICovXG4gIGV2YWx1YXRlUHJlRGlzcGF0Y2goXG4gICAgdW5pdFR5cGU6IHN0cmluZyxcbiAgICB1bml0SWQ6IHN0cmluZyxcbiAgICBwcm9tcHQ6IHN0cmluZyxcbiAgICBiYXNlUGF0aDogc3RyaW5nLFxuICApOiBQcmVEaXNwYXRjaFJlc3VsdCB7XG4gICAgLy8gRG9uJ3QgaW50ZXJjZXB0IGhvb2sgdW5pdHNcbiAgICBpZiAodW5pdFR5cGUuc3RhcnRzV2l0aChcImhvb2svXCIpKSB7XG4gICAgICByZXR1cm4geyBhY3Rpb246IFwicHJvY2VlZFwiLCBwcm9tcHQsIGZpcmVkSG9va3M6IFtdIH07XG4gICAgfVxuXG4gICAgY29uc3QgaG9va3MgPSByZXNvbHZlUHJlRGlzcGF0Y2hIb29rcygpLmZpbHRlcihoID0+XG4gICAgICBoLmJlZm9yZS5pbmNsdWRlcyh1bml0VHlwZSksXG4gICAgKTtcbiAgICBpZiAoaG9va3MubGVuZ3RoID09PSAwKSB7XG4gICAgICByZXR1cm4geyBhY3Rpb246IFwicHJvY2VlZFwiLCBwcm9tcHQsIGZpcmVkSG9va3M6IFtdIH07XG4gICAgfVxuXG4gICAgY29uc3QgeyBtaWxlc3RvbmU6IG1pZCwgc2xpY2U6IHNpZCwgdGFzazogdGlkIH0gPSBwYXJzZVVuaXRJZCh1bml0SWQpO1xuICAgIGNvbnN0IHN1YnN0aXR1dGUgPSAodGV4dDogc3RyaW5nKTogc3RyaW5nID0+XG4gICAgICB0ZXh0XG4gICAgICAgIC5yZXBsYWNlKC9cXHttaWxlc3RvbmVJZFxcfS9nLCBtaWQgPz8gXCJcIilcbiAgICAgICAgLnJlcGxhY2UoL1xce3NsaWNlSWRcXH0vZywgc2lkID8/IFwiXCIpXG4gICAgICAgIC5yZXBsYWNlKC9cXHt0YXNrSWRcXH0vZywgdGlkID8/IFwiXCIpO1xuXG4gICAgY29uc3QgZmlyZWRIb29rczogc3RyaW5nW10gPSBbXTtcbiAgICBsZXQgY3VycmVudFByb21wdCA9IHByb21wdDtcblxuICAgIGZvciAoY29uc3QgaG9vayBvZiBob29rcykge1xuICAgICAgaWYgKGhvb2suYWN0aW9uID09PSBcInNraXBcIikge1xuICAgICAgICBpZiAoaG9vay5za2lwX2lmKSB7XG4gICAgICAgICAgY29uc3QgY29uZGl0aW9uUGF0aCA9IHJlc29sdmVIb29rQXJ0aWZhY3RQYXRoKGJhc2VQYXRoLCB1bml0SWQsIGhvb2suc2tpcF9pZik7XG4gICAgICAgICAgaWYgKCFleGlzdHNTeW5jKGNvbmRpdGlvblBhdGgpKSBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBmaXJlZEhvb2tzLnB1c2goaG9vay5uYW1lKTtcbiAgICAgICAgcmV0dXJuIHsgYWN0aW9uOiBcInNraXBcIiwgZmlyZWRIb29rcyB9O1xuICAgICAgfVxuXG4gICAgICBpZiAoaG9vay5hY3Rpb24gPT09IFwicmVwbGFjZVwiKSB7XG4gICAgICAgIGZpcmVkSG9va3MucHVzaChob29rLm5hbWUpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGFjdGlvbjogXCJyZXBsYWNlXCIsXG4gICAgICAgICAgcHJvbXB0OiBzdWJzdGl0dXRlKGhvb2sucHJvbXB0ID8/IFwiXCIpLFxuICAgICAgICAgIHVuaXRUeXBlOiBob29rLnVuaXRfdHlwZSxcbiAgICAgICAgICBtb2RlbDogaG9vay5tb2RlbCxcbiAgICAgICAgICBmaXJlZEhvb2tzLFxuICAgICAgICB9O1xuICAgICAgfVxuXG4gICAgICBpZiAoaG9vay5hY3Rpb24gPT09IFwibW9kaWZ5XCIpIHtcbiAgICAgICAgZmlyZWRIb29rcy5wdXNoKGhvb2submFtZSk7XG4gICAgICAgIGlmIChob29rLnByZXBlbmQpIHtcbiAgICAgICAgICBjdXJyZW50UHJvbXB0ID0gYCR7c3Vic3RpdHV0ZShob29rLnByZXBlbmQpfVxcblxcbiR7Y3VycmVudFByb21wdH1gO1xuICAgICAgICB9XG4gICAgICAgIGlmIChob29rLmFwcGVuZCkge1xuICAgICAgICAgIGN1cnJlbnRQcm9tcHQgPSBgJHtjdXJyZW50UHJvbXB0fVxcblxcbiR7c3Vic3RpdHV0ZShob29rLmFwcGVuZCl9YDtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiB7XG4gICAgICBhY3Rpb246IFwicHJvY2VlZFwiLFxuICAgICAgcHJvbXB0OiBjdXJyZW50UHJvbXB0LFxuICAgICAgbW9kZWw6IGhvb2tzLmZpbmQoaCA9PiBoLmFjdGlvbiA9PT0gXCJtb2RpZnlcIiAmJiBoLm1vZGVsKT8ubW9kZWwsXG4gICAgICBmaXJlZEhvb2tzLFxuICAgIH07XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgU3RhdGUgYWNjZXNzb3JzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4gIGdldEFjdGl2ZUhvb2soKTogSG9va0V4ZWN1dGlvblN0YXRlIHwgbnVsbCB7XG4gICAgcmV0dXJuIHRoaXMuYWN0aXZlSG9vaztcbiAgfVxuXG4gIGlzUmV0cnlQZW5kaW5nKCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLnJldHJ5UGVuZGluZztcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXR1cm5zIHRoZSB0cmlnZ2VyIHVuaXQgaW5mbyBmb3IgYSBwZW5kaW5nIHJldHJ5LCBvciBudWxsLlxuICAgKiBDbGVhcnMgdGhlIHJldHJ5IHN0YXRlIGFmdGVyIHJlYWRpbmcuXG4gICAqL1xuICBjb25zdW1lUmV0cnlUcmlnZ2VyKCk6IHsgdW5pdFR5cGU6IHN0cmluZzsgdW5pdElkOiBzdHJpbmc7IHJldHJ5QXJ0aWZhY3Q6IHN0cmluZyB9IHwgbnVsbCB7XG4gICAgaWYgKCF0aGlzLnJldHJ5UGVuZGluZyB8fCAhdGhpcy5yZXRyeVRyaWdnZXIpIHJldHVybiBudWxsO1xuICAgIGNvbnN0IHRyaWdnZXIgPSB7IC4uLnRoaXMucmV0cnlUcmlnZ2VyIH07XG4gICAgdGhpcy5yZXRyeVBlbmRpbmcgPSBmYWxzZTtcbiAgICB0aGlzLnJldHJ5VHJpZ2dlciA9IG51bGw7XG4gICAgcmV0dXJuIHRyaWdnZXI7XG4gIH1cblxuICAvKiogQ2xlYXIgYWxsIG11dGFibGUgc3RhdGUgKGFjdGl2ZUhvb2ssIGhvb2tRdWV1ZSwgY3ljbGVDb3VudHMsIHJldHJ5UGVuZGluZywgcmV0cnlUcmlnZ2VyKS4gKi9cbiAgcmVzZXRTdGF0ZSgpOiB2b2lkIHtcbiAgICB0aGlzLmFjdGl2ZUhvb2sgPSBudWxsO1xuICAgIHRoaXMuaG9va1F1ZXVlID0gW107XG4gICAgdGhpcy5jeWNsZUNvdW50cy5jbGVhcigpO1xuICAgIHRoaXMucmV0cnlQZW5kaW5nID0gZmFsc2U7XG4gICAgdGhpcy5yZXRyeVRyaWdnZXIgPSBudWxsO1xuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwIFBlcnNpc3RlbmNlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4gIHByaXZhdGUgX2hvb2tTdGF0ZVBhdGgoYmFzZVBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgcmV0dXJuIGpvaW4oYmFzZVBhdGgsIFwiLmdzZFwiLCBIT09LX1NUQVRFX0ZJTEUpO1xuICB9XG5cbiAgLyoqIFBlcnNpc3QgY3VycmVudCBob29rIGN5Y2xlIGNvdW50cyB0byBkaXNrLiAqL1xuICBwZXJzaXN0U3RhdGUoYmFzZVBhdGg6IHN0cmluZyk6IHZvaWQge1xuICAgIGNvbnN0IHN0YXRlOiBQZXJzaXN0ZWRIb29rU3RhdGUgPSB7XG4gICAgICBjeWNsZUNvdW50czogT2JqZWN0LmZyb21FbnRyaWVzKHRoaXMuY3ljbGVDb3VudHMpLFxuICAgICAgc2F2ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgIH07XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGRpciA9IGpvaW4oYmFzZVBhdGgsIFwiLmdzZFwiKTtcbiAgICAgIGlmICghZXhpc3RzU3luYyhkaXIpKSBta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIHdyaXRlRmlsZVN5bmModGhpcy5faG9va1N0YXRlUGF0aChiYXNlUGF0aCksIEpTT04uc3RyaW5naWZ5KHN0YXRlLCBudWxsLCAyKSwgXCJ1dGYtOFwiKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBsb2dXYXJuaW5nKFwicmVnaXN0cnlcIiwgYGZhaWxlZCB0byBwZXJzaXN0IGhvb2sgc3RhdGU6ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgfVxuICB9XG5cbiAgLyoqIFJlc3RvcmUgaG9vayBjeWNsZSBjb3VudHMgZnJvbSBkaXNrIGFmdGVyIGEgY3Jhc2gvcmVzdGFydC4gKi9cbiAgcmVzdG9yZVN0YXRlKGJhc2VQYXRoOiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgZmlsZVBhdGggPSB0aGlzLl9ob29rU3RhdGVQYXRoKGJhc2VQYXRoKTtcbiAgICAgIGlmICghZXhpc3RzU3luYyhmaWxlUGF0aCkpIHJldHVybjtcbiAgICAgIGNvbnN0IHJhdyA9IHJlYWRGaWxlU3luYyhmaWxlUGF0aCwgXCJ1dGYtOFwiKTtcbiAgICAgIGNvbnN0IHN0YXRlOiBQZXJzaXN0ZWRIb29rU3RhdGUgPSBKU09OLnBhcnNlKHJhdyk7XG4gICAgICBpZiAoc3RhdGUuY3ljbGVDb3VudHMgJiYgdHlwZW9mIHN0YXRlLmN5Y2xlQ291bnRzID09PSBcIm9iamVjdFwiKSB7XG4gICAgICAgIHRoaXMuY3ljbGVDb3VudHMuY2xlYXIoKTtcbiAgICAgICAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMoc3RhdGUuY3ljbGVDb3VudHMpKSB7XG4gICAgICAgICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gXCJudW1iZXJcIikge1xuICAgICAgICAgICAgdGhpcy5jeWNsZUNvdW50cy5zZXQoa2V5LCB2YWx1ZSk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgbG9nV2FybmluZyhcInJlZ2lzdHJ5XCIsIGBmYWlsZWQgdG8gcmVzdG9yZSBob29rIHN0YXRlOiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWApO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBDbGVhciBwZXJzaXN0ZWQgaG9vayBzdGF0ZSBmaWxlIGZyb20gZGlzay4gKi9cbiAgY2xlYXJQZXJzaXN0ZWRTdGF0ZShiYXNlUGF0aDogc3RyaW5nKTogdm9pZCB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGZpbGVQYXRoID0gdGhpcy5faG9va1N0YXRlUGF0aChiYXNlUGF0aCk7XG4gICAgICBpZiAoZXhpc3RzU3luYyhmaWxlUGF0aCkpIHtcbiAgICAgICAgd3JpdGVGaWxlU3luYyhcbiAgICAgICAgICBmaWxlUGF0aCxcbiAgICAgICAgICBKU09OLnN0cmluZ2lmeSh7IGN5Y2xlQ291bnRzOiB7fSwgc2F2ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpIH0sIG51bGwsIDIpLFxuICAgICAgICAgIFwidXRmLThcIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBsb2dXYXJuaW5nKFwicmVnaXN0cnlcIiwgYGZhaWxlZCB0byBjbGVhciBob29rIHN0YXRlOiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWApO1xuICAgIH1cbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBIb29rIHN0YXR1cyByZXBvcnRpbmcgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbiAgLyoqIEdldCBzdGF0dXMgb2YgYWxsIGNvbmZpZ3VyZWQgaG9va3MgZm9yIGRpc3BsYXkuICovXG4gIGdldEhvb2tTdGF0dXMoKTogSG9va1N0YXR1c0VudHJ5W10ge1xuICAgIGNvbnN0IGVudHJpZXM6IEhvb2tTdGF0dXNFbnRyeVtdID0gW107XG5cbiAgICBjb25zdCBwb3N0SG9va3MgPSByZXNvbHZlUG9zdFVuaXRIb29rcygpO1xuICAgIGZvciAoY29uc3QgaG9vayBvZiBwb3N0SG9va3MpIHtcbiAgICAgIGNvbnN0IGFjdGl2ZUN5Y2xlczogUmVjb3JkPHN0cmluZywgbnVtYmVyPiA9IHt9O1xuICAgICAgZm9yIChjb25zdCBba2V5LCBjb3VudF0gb2YgdGhpcy5jeWNsZUNvdW50cykge1xuICAgICAgICBpZiAoa2V5LnN0YXJ0c1dpdGgoYCR7aG9vay5uYW1lfS9gKSkge1xuICAgICAgICAgIGFjdGl2ZUN5Y2xlc1trZXldID0gY291bnQ7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGVudHJpZXMucHVzaCh7XG4gICAgICAgIG5hbWU6IGhvb2submFtZSxcbiAgICAgICAgdHlwZTogXCJwb3N0XCIsXG4gICAgICAgIGVuYWJsZWQ6IGhvb2suZW5hYmxlZCAhPT0gZmFsc2UsXG4gICAgICAgIHRhcmdldHM6IGhvb2suYWZ0ZXIsXG4gICAgICAgIGFjdGl2ZUN5Y2xlcyxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGNvbnN0IHByZUhvb2tzID0gcmVzb2x2ZVByZURpc3BhdGNoSG9va3MoKTtcbiAgICBmb3IgKGNvbnN0IGhvb2sgb2YgcHJlSG9va3MpIHtcbiAgICAgIGVudHJpZXMucHVzaCh7XG4gICAgICAgIG5hbWU6IGhvb2submFtZSxcbiAgICAgICAgdHlwZTogXCJwcmVcIixcbiAgICAgICAgZW5hYmxlZDogaG9vay5lbmFibGVkICE9PSBmYWxzZSxcbiAgICAgICAgdGFyZ2V0czogaG9vay5iZWZvcmUsXG4gICAgICAgIGFjdGl2ZUN5Y2xlczoge30sXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICByZXR1cm4gZW50cmllcztcbiAgfVxuXG4gIC8qKlxuICAgKiBNYW51YWxseSB0cmlnZ2VyIGEgc3BlY2lmaWMgaG9vayBmb3IgYSB1bml0LlxuICAgKiBCeXBhc3NlcyBub3JtYWwgZmxvdyBcdTIwMTQgZm9yY2VzIGhvb2sgdG8gcnVuIGV2ZW4gaWYgYXJ0aWZhY3QgZXhpc3RzLlxuICAgKi9cbiAgdHJpZ2dlckhvb2tNYW51YWxseShcbiAgICBob29rTmFtZTogc3RyaW5nLFxuICAgIHVuaXRUeXBlOiBzdHJpbmcsXG4gICAgdW5pdElkOiBzdHJpbmcsXG4gICAgYmFzZVBhdGg6IHN0cmluZyxcbiAgKTogSG9va0Rpc3BhdGNoUmVzdWx0IHwgbnVsbCB7XG4gICAgY29uc3QgaG9vayA9IHJlc29sdmVQb3N0VW5pdEhvb2tzKCkuZmluZChoID0+IGgubmFtZSA9PT0gaG9va05hbWUpO1xuICAgIGlmICghaG9vaykge1xuICAgICAgY29uc29sZS5lcnJvcihgW3RyaWdnZXJIb29rTWFudWFsbHldIEhvb2sgXCIke2hvb2tOYW1lfVwiIG5vdCBmb3VuZCBpbiBwb3N0X3VuaXRfaG9va3NgKTtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cblxuICAgIGlmICghaG9vay5wcm9tcHQgfHwgdHlwZW9mIGhvb2sucHJvbXB0ICE9PSBcInN0cmluZ1wiIHx8IGhvb2sucHJvbXB0LnRyaW0oKS5sZW5ndGggPT09IDApIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoYFt0cmlnZ2VySG9va01hbnVhbGx5XSBIb29rIFwiJHtob29rTmFtZX1cIiBoYXMgZW1wdHkgcHJvbXB0YCk7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG5cbiAgICB0aGlzLmFjdGl2ZUhvb2sgPSB7XG4gICAgICBob29rTmFtZTogaG9vay5uYW1lLFxuICAgICAgdHJpZ2dlclVuaXRUeXBlOiB1bml0VHlwZSxcbiAgICAgIHRyaWdnZXJVbml0SWQ6IHVuaXRJZCxcbiAgICAgIGN5Y2xlOiAxLFxuICAgICAgcGVuZGluZ1JldHJ5OiBmYWxzZSxcbiAgICB9O1xuXG4gICAgdGhpcy5ob29rUXVldWUgPSBbe1xuICAgICAgY29uZmlnOiBob29rLFxuICAgICAgdHJpZ2dlclVuaXRUeXBlOiB1bml0VHlwZSxcbiAgICAgIHRyaWdnZXJVbml0SWQ6IHVuaXRJZCxcbiAgICB9XTtcblxuICAgIGNvbnN0IGN5Y2xlS2V5ID0gYCR7aG9vay5uYW1lfS8ke3VuaXRUeXBlfS8ke3VuaXRJZH1gO1xuICAgIGNvbnN0IGN1cnJlbnRDeWNsZSA9ICh0aGlzLmN5Y2xlQ291bnRzLmdldChjeWNsZUtleSkgPz8gMCkgKyAxO1xuICAgIHRoaXMuY3ljbGVDb3VudHMuc2V0KGN5Y2xlS2V5LCBjdXJyZW50Q3ljbGUpO1xuICAgIHRoaXMuYWN0aXZlSG9vay5jeWNsZSA9IGN1cnJlbnRDeWNsZTtcblxuICAgIGNvbnN0IHsgbWlsZXN0b25lOiBtaWQsIHNsaWNlOiBzaWQsIHRhc2s6IHRpZCB9ID0gcGFyc2VVbml0SWQodW5pdElkKTtcbiAgICBjb25zdCBwcm9tcHQgPSBob29rLnByb21wdFxuICAgICAgLnJlcGxhY2UoL1xce21pbGVzdG9uZUlkXFx9L2csIG1pZCA/PyBcIlwiKVxuICAgICAgLnJlcGxhY2UoL1xce3NsaWNlSWRcXH0vZywgc2lkID8/IFwiXCIpXG4gICAgICAucmVwbGFjZSgvXFx7dGFza0lkXFx9L2csIHRpZCA/PyBcIlwiKTtcblxuICAgIHJldHVybiB7XG4gICAgICBob29rTmFtZTogaG9vay5uYW1lLFxuICAgICAgcHJvbXB0LFxuICAgICAgbW9kZWw6IGhvb2subW9kZWwsXG4gICAgICB1bml0VHlwZTogYGhvb2svJHtob29rLm5hbWV9YCxcbiAgICAgIHVuaXRJZCxcbiAgICB9O1xuICB9XG5cbiAgLyoqIEZvcm1hdCBob29rIHN0YXR1cyBmb3IgdGVybWluYWwgZGlzcGxheS4gKi9cbiAgZm9ybWF0SG9va1N0YXR1cygpOiBzdHJpbmcge1xuICAgIGNvbnN0IGVudHJpZXMgPSB0aGlzLmdldEhvb2tTdGF0dXMoKTtcbiAgICBpZiAoZW50cmllcy5sZW5ndGggPT09IDApIHtcbiAgICAgIHJldHVybiBcIk5vIGhvb2tzIGNvbmZpZ3VyZWQuIEFkZCBwb3N0X3VuaXRfaG9va3Mgb3IgcHJlX2Rpc3BhdGNoX2hvb2tzIHRvIC5nc2QvUFJFRkVSRU5DRVMubWRcIjtcbiAgICB9XG5cbiAgICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXCJDb25maWd1cmVkIEhvb2tzOlwiLCBcIlwiXTtcblxuICAgIGNvbnN0IHBvc3RIb29rcyA9IGVudHJpZXMuZmlsdGVyKGUgPT4gZS50eXBlID09PSBcInBvc3RcIik7XG4gICAgY29uc3QgcHJlSG9va3MgPSBlbnRyaWVzLmZpbHRlcihlID0+IGUudHlwZSA9PT0gXCJwcmVcIik7XG5cbiAgICBpZiAocG9zdEhvb2tzLmxlbmd0aCA+IDApIHtcbiAgICAgIGxpbmVzLnB1c2goXCJQb3N0LVVuaXQgSG9va3MgKHJ1biBhZnRlciB1bml0IGNvbXBsZXRlcyk6XCIpO1xuICAgICAgZm9yIChjb25zdCBob29rIG9mIHBvc3RIb29rcykge1xuICAgICAgICBjb25zdCBzdGF0dXMgPSBob29rLmVuYWJsZWQgPyBcImVuYWJsZWRcIiA6IFwiZGlzYWJsZWRcIjtcbiAgICAgICAgY29uc3QgY3ljbGVzID0gT2JqZWN0LmtleXMoaG9vay5hY3RpdmVDeWNsZXMpLmxlbmd0aDtcbiAgICAgICAgY29uc3QgY3ljbGVJbmZvID0gY3ljbGVzID4gMCA/IGAgKCR7Y3ljbGVzfSBhY3RpdmUgY3ljbGUke2N5Y2xlcyA9PT0gMSA/IFwiXCIgOiBcInNcIn0pYCA6IFwiXCI7XG4gICAgICAgIGxpbmVzLnB1c2goYCAgJHtob29rLm5hbWV9IFske3N0YXR1c31dIFx1MjE5MiBhZnRlcjogJHtob29rLnRhcmdldHMuam9pbihcIiwgXCIpfSR7Y3ljbGVJbmZvfWApO1xuICAgICAgfVxuICAgICAgbGluZXMucHVzaChcIlwiKTtcbiAgICB9XG5cbiAgICBpZiAocHJlSG9va3MubGVuZ3RoID4gMCkge1xuICAgICAgbGluZXMucHVzaChcIlByZS1EaXNwYXRjaCBIb29rcyAocnVuIGJlZm9yZSB1bml0IGRpc3BhdGNoZXMpOlwiKTtcbiAgICAgIGZvciAoY29uc3QgaG9vayBvZiBwcmVIb29rcykge1xuICAgICAgICBjb25zdCBzdGF0dXMgPSBob29rLmVuYWJsZWQgPyBcImVuYWJsZWRcIiA6IFwiZGlzYWJsZWRcIjtcbiAgICAgICAgbGluZXMucHVzaChgICAke2hvb2submFtZX0gWyR7c3RhdHVzfV0gXHUyMTkyIGJlZm9yZTogJHtob29rLnRhcmdldHMuam9pbihcIiwgXCIpfWApO1xuICAgICAgfVxuICAgICAgbGluZXMucHVzaChcIlwiKTtcbiAgICB9XG5cbiAgICByZXR1cm4gbGluZXMuam9pbihcIlxcblwiKTtcbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgTW9kdWxlLWxldmVsIFNpbmdsZXRvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxubGV0IF9yZWdpc3RyeTogUnVsZVJlZ2lzdHJ5IHwgbnVsbCA9IG51bGw7XG5cbi8qKiBHZXQgdGhlIHNpbmdsZXRvbiByZWdpc3RyeS4gVGhyb3dzIGlmIG5vdCBpbml0aWFsaXplZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRSZWdpc3RyeSgpOiBSdWxlUmVnaXN0cnkge1xuICBpZiAoIV9yZWdpc3RyeSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIlJ1bGVSZWdpc3RyeSBub3QgaW5pdGlhbGl6ZWQgXHUyMDE0IGNhbGwgaW5pdFJlZ2lzdHJ5KCkgb3Igc2V0UmVnaXN0cnkoKSBmaXJzdC5cIik7XG4gIH1cbiAgcmV0dXJuIF9yZWdpc3RyeTtcbn1cblxuLyoqIFNldCB0aGUgc2luZ2xldG9uIHJlZ2lzdHJ5IGluc3RhbmNlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNldFJlZ2lzdHJ5KHI6IFJ1bGVSZWdpc3RyeSk6IHZvaWQge1xuICBfcmVnaXN0cnkgPSByO1xufVxuXG4vKiogQ3JlYXRlIGFuZCBzZXQgdGhlIHNpbmdsZXRvbiByZWdpc3RyeSB3aXRoIHRoZSBnaXZlbiBkaXNwYXRjaCBydWxlcy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpbml0UmVnaXN0cnkoZGlzcGF0Y2hSdWxlczogVW5pZmllZFJ1bGVbXSk6IFJ1bGVSZWdpc3RyeSB7XG4gIGNvbnN0IHJlZ2lzdHJ5ID0gbmV3IFJ1bGVSZWdpc3RyeShkaXNwYXRjaFJ1bGVzKTtcbiAgc2V0UmVnaXN0cnkocmVnaXN0cnkpO1xuICByZXR1cm4gcmVnaXN0cnk7XG59XG5cbi8qKlxuICogR2V0IHRoZSBzaW5nbGV0b24gcmVnaXN0cnksIGxhemlseSBjcmVhdGluZyBvbmUgd2l0aCBlbXB0eSBkaXNwYXRjaCBydWxlc1xuICogaWYgbm90IHlldCBpbml0aWFsaXplZC4gVGhpcyBlbnN1cmVzIGZhY2FkZSBmdW5jdGlvbnMgd29yayBldmVuIHdoZW5cbiAqIHRoZSBmdWxsIHJlZ2lzdHJ5IGhhc24ndCBiZWVuIHNldCB1cCAoZS5nLiBkdXJpbmcgdGVzdGluZykuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRPckNyZWF0ZVJlZ2lzdHJ5KCk6IFJ1bGVSZWdpc3RyeSB7XG4gIGlmICghX3JlZ2lzdHJ5KSB7XG4gICAgX3JlZ2lzdHJ5ID0gbmV3IFJ1bGVSZWdpc3RyeShbXSk7XG4gIH1cbiAgcmV0dXJuIF9yZWdpc3RyeTtcbn1cblxuLyoqIFJlc2V0IHRoZSBzaW5nbGV0b24gKGZvciB0ZXN0aW5nKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNldFJlZ2lzdHJ5KCk6IHZvaWQge1xuICBfcmVnaXN0cnkgPSBudWxsO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBUUEsU0FBUyxrQkFBa0I7QUFZM0IsU0FBUyxzQkFBc0IsK0JBQStCO0FBQzlELFNBQVMsWUFBWSxjQUFjLGVBQWUsaUJBQWlCO0FBQ25FLFNBQVMsWUFBWTtBQUNyQixTQUFTLG1CQUFtQjtBQUlyQixTQUFTLHdCQUF3QixVQUFrQixRQUFnQixjQUE4QjtBQUN0RyxRQUFNLEVBQUUsV0FBVyxPQUFPLEtBQUssSUFBSSxZQUFZLE1BQU07QUFDckQsTUFBSSxTQUFTLFVBQWEsVUFBVSxRQUFXO0FBQzdDLFdBQU8sS0FBSyxVQUFVLFFBQVEsY0FBYyxXQUFXLFVBQVUsT0FBTyxTQUFTLEdBQUcsSUFBSSxJQUFJLFlBQVksRUFBRTtBQUFBLEVBQzVHO0FBQ0EsTUFBSSxVQUFVLFFBQVc7QUFDdkIsV0FBTyxLQUFLLFVBQVUsUUFBUSxjQUFjLFdBQVcsVUFBVSxPQUFPLFlBQVk7QUFBQSxFQUN0RjtBQUNBLFNBQU8sS0FBSyxVQUFVLFFBQVEsY0FBYyxXQUFXLFlBQVk7QUFDckU7QUFRTyxTQUFTLHFCQUFxQixPQUFzQztBQUN6RSxTQUFPLE1BQU0sSUFBSSxDQUFDLFVBQVU7QUFBQSxJQUMxQixNQUFNLEtBQUs7QUFBQSxJQUNYLE1BQU07QUFBQSxJQUNOLFlBQVk7QUFBQSxJQUNaLE9BQU8sS0FBSztBQUFBLElBQ1osTUFBTSxDQUFDLFdBQWdCO0FBQUEsSUFDdkIsYUFBYSxrQkFBa0IsS0FBSyxJQUFJO0FBQUEsRUFDMUMsRUFBRTtBQUNKO0FBSUEsTUFBTSxrQkFBa0I7QUFFakIsTUFBTSxhQUFhO0FBQUE7QUFBQSxFQUVQO0FBQUE7QUFBQSxFQUlqQixhQUF3QztBQUFBLEVBQ3hDLFlBSUssQ0FBQztBQUFBLEVBQ04sY0FBbUMsb0JBQUksSUFBSTtBQUFBLEVBQzNDLGVBQXdCO0FBQUEsRUFDeEIsZUFBbUY7QUFB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
