import { join } from "node:path";
import { openSync, closeSync, unlinkSync, statSync, writeFileSync } from "node:fs";
import { gsdRoot } from "./paths.js";
import { getAndClearSkills } from "./skill-telemetry.js";
import { loadJsonFile, loadJsonFileOrNull, saveJsonFile } from "./json-persistence.js";
import { parseUnitId } from "./unit-id.js";
import { buildAuditEnvelope, emitUokAuditEvent } from "./uok/audit.js";
import { isUnifiedAuditEnabled } from "./uok/audit-toggle.js";
import { logWarning } from "./workflow-logger.js";
import { formatTokenCount } from "../shared/format-utils.js";
function classifyUnitPhase(unitType) {
  switch (unitType) {
    case "research-milestone":
    case "research-slice":
      return "research";
    case "discuss-milestone":
    case "discuss-slice":
      return "discussion";
    case "plan-milestone":
    case "plan-slice":
    case "refine-slice":
      return "planning";
    case "execute-task":
      return "execution";
    case "complete-slice":
      return "completion";
    case "reassess-roadmap":
      return "reassessment";
    default:
      return "execution";
  }
}
let ledger = null;
let basePath = "";
const scopedLedgers = /* @__PURE__ */ new Map();
function initMetrics(base) {
  basePath = base;
  ledger = loadLedger(base);
}
function resetMetrics() {
  ledger = null;
  basePath = "";
}
function snapshotUnitMetrics(ctx, unitType, unitId, startedAt, model, opts) {
  if (!ledger) return null;
  const entries = ctx.sessionManager.getEntries();
  if (!entries || entries.length === 0) return null;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let cost = 0;
  let toolCalls = 0;
  let assistantMessages = 0;
  let userMessages = 0;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg) continue;
    if (msg.role === "assistant") {
      assistantMessages++;
      if (msg.usage) {
        tokens.input += msg.usage.input ?? 0;
        tokens.output += msg.usage.output ?? 0;
        tokens.cacheRead += msg.usage.cacheRead ?? 0;
        tokens.cacheWrite += msg.usage.cacheWrite ?? 0;
        tokens.total += msg.usage.totalTokens ?? 0;
        if (msg.usage.cost != null) {
          const c = msg.usage.cost;
          cost += typeof c === "number" ? c : c.total ?? 0;
        }
      }
      if (msg.content && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "toolCall") toolCalls++;
        }
      }
    } else if (msg.role === "user") {
      userMessages++;
    }
  }
  const unit = {
    type: unitType,
    id: unitId,
    model,
    startedAt,
    finishedAt: Date.now(),
    ...opts?.autoSessionKey ? { autoSessionKey: opts.autoSessionKey } : {},
    tokens,
    cost,
    toolCalls,
    assistantMessages,
    userMessages,
    apiRequests: assistantMessages,
    // each assistant message = one API request
    ...opts?.tier ? { tier: opts.tier } : {},
    ...opts?.modelDowngraded !== void 0 ? { modelDowngraded: opts.modelDowngraded } : {},
    ...opts?.contextWindowTokens !== void 0 ? { contextWindowTokens: opts.contextWindowTokens } : {},
    ...opts?.truncationSections !== void 0 ? { truncationSections: opts.truncationSections } : {},
    ...opts?.continueHereFired !== void 0 ? { continueHereFired: opts.continueHereFired } : {},
    ...opts?.promptCharCount != null ? { promptCharCount: opts.promptCharCount } : {},
    ...opts?.baselineCharCount != null ? { baselineCharCount: opts.baselineCharCount } : {}
  };
  const skills = getAndClearSkills();
  if (skills.length > 0) {
    unit.skills = skills;
  }
  if (tokens.cacheRead > 0 || tokens.input > 0) {
    const totalInput = tokens.cacheRead + tokens.input;
    unit.cacheHitRate = totalInput > 0 ? Math.round(tokens.cacheRead / totalInput * 100) : 0;
  }
  const dupeIdx = ledger.units.findIndex(
    (u) => u.type === unit.type && u.id === unit.id && u.startedAt === unit.startedAt
  );
  if (dupeIdx >= 0) {
    ledger.units[dupeIdx] = unit;
  } else {
    ledger.units.push(unit);
  }
  saveLedger(basePath, ledger);
  if (isUnifiedAuditEnabled()) {
    emitUokAuditEvent(
      basePath,
      buildAuditEnvelope({
        traceId: opts?.traceId ?? `metrics:${unitType}:${unitId}`,
        turnId: opts?.turnId,
        causedBy: opts?.causedBy,
        category: "metrics",
        type: "unit-metrics-snapshot",
        payload: {
          unitType,
          unitId,
          model,
          tokens: unit.tokens,
          cost: unit.cost,
          toolCalls: unit.toolCalls
        }
      })
    );
  }
  return unit;
}
function getLedger() {
  return ledger;
}
function initMetricsByScope(scope) {
  const base = scope.workspace.projectRoot;
  const loaded = loadLedger(base);
  scopedLedgers.set(scope.workspace.identityKey, loaded);
}
function getLedgerByScope(scope) {
  return scopedLedgers.get(scope.workspace.identityKey) ?? null;
}
function resetMetricsByScope(scope) {
  scopedLedgers.delete(scope.workspace.identityKey);
}
function snapshotUnitMetricsByScope(scope, ctx, unitType, unitId, startedAt, model, opts) {
  const base = scope.workspace.projectRoot;
  const key = scope.workspace.identityKey;
  if (!scopedLedgers.has(key)) {
    scopedLedgers.set(key, loadLedger(base));
  }
  const scopedLedger = scopedLedgers.get(key);
  const entries = ctx.sessionManager.getEntries();
  if (!entries || entries.length === 0) return null;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let cost = 0;
  let toolCalls = 0;
  let assistantMessages = 0;
  let userMessages = 0;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg) continue;
    if (msg.role === "assistant") {
      assistantMessages++;
      if (msg.usage) {
        tokens.input += msg.usage.input ?? 0;
        tokens.output += msg.usage.output ?? 0;
        tokens.cacheRead += msg.usage.cacheRead ?? 0;
        tokens.cacheWrite += msg.usage.cacheWrite ?? 0;
        tokens.total += msg.usage.totalTokens ?? 0;
        if (msg.usage.cost != null) {
          const c = msg.usage.cost;
          cost += typeof c === "number" ? c : c.total ?? 0;
        }
      }
      if (msg.content && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "toolCall") toolCalls++;
        }
      }
    } else if (msg.role === "user") {
      userMessages++;
    }
  }
  const unit = {
    type: unitType,
    id: unitId,
    model,
    startedAt,
    finishedAt: Date.now(),
    ...opts?.autoSessionKey ? { autoSessionKey: opts.autoSessionKey } : {},
    tokens,
    cost,
    toolCalls,
    assistantMessages,
    userMessages,
    apiRequests: assistantMessages,
    ...opts?.tier ? { tier: opts.tier } : {},
    ...opts?.modelDowngraded !== void 0 ? { modelDowngraded: opts.modelDowngraded } : {},
    ...opts?.contextWindowTokens !== void 0 ? { contextWindowTokens: opts.contextWindowTokens } : {},
    ...opts?.truncationSections !== void 0 ? { truncationSections: opts.truncationSections } : {},
    ...opts?.continueHereFired !== void 0 ? { continueHereFired: opts.continueHereFired } : {},
    ...opts?.promptCharCount != null ? { promptCharCount: opts.promptCharCount } : {},
    ...opts?.baselineCharCount != null ? { baselineCharCount: opts.baselineCharCount } : {}
  };
  const skills = getAndClearSkills();
  if (skills.length > 0) {
    unit.skills = skills;
  }
  if (tokens.cacheRead > 0 || tokens.input > 0) {
    const totalInput = tokens.cacheRead + tokens.input;
    unit.cacheHitRate = totalInput > 0 ? Math.round(tokens.cacheRead / totalInput * 100) : 0;
  }
  const dupeIdx = scopedLedger.units.findIndex(
    (u) => u.type === unit.type && u.id === unit.id && u.startedAt === unit.startedAt
  );
  if (dupeIdx >= 0) {
    scopedLedger.units[dupeIdx] = unit;
  } else {
    scopedLedger.units.push(unit);
  }
  saveLedger(base, scopedLedger);
  if (isUnifiedAuditEnabled()) {
    emitUokAuditEvent(
      base,
      buildAuditEnvelope({
        traceId: opts?.traceId ?? `metrics:${unitType}:${unitId}`,
        turnId: opts?.turnId,
        causedBy: opts?.causedBy,
        category: "metrics",
        type: "unit-metrics-snapshot",
        payload: {
          unitType,
          unitId,
          model,
          tokens: unit.tokens,
          cost: unit.cost,
          toolCalls: unit.toolCalls
        }
      })
    );
  }
  return unit;
}
function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}
function addTokens(a, b) {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    total: a.total + b.total
  };
}
function aggregateByPhase(units) {
  const map = /* @__PURE__ */ new Map();
  for (const u of units) {
    const phase = classifyUnitPhase(u.type);
    let agg = map.get(phase);
    if (!agg) {
      agg = { phase, units: 0, tokens: emptyTokens(), cost: 0, duration: 0 };
      map.set(phase, agg);
    }
    agg.units++;
    agg.tokens = addTokens(agg.tokens, u.tokens);
    agg.cost += u.cost;
    agg.duration += u.finishedAt - u.startedAt;
  }
  const order = ["research", "discussion", "planning", "execution", "completion", "reassessment"];
  return order.map((p) => map.get(p)).filter((a) => !!a);
}
function aggregateBySlice(units) {
  const map = /* @__PURE__ */ new Map();
  for (const u of units) {
    const { milestone, slice } = parseUnitId(u.id);
    const sliceId = slice ? `${milestone}/${slice}` : milestone;
    let agg = map.get(sliceId);
    if (!agg) {
      agg = { sliceId, units: 0, tokens: emptyTokens(), cost: 0, duration: 0 };
      map.set(sliceId, agg);
    }
    agg.units++;
    agg.tokens = addTokens(agg.tokens, u.tokens);
    agg.cost += u.cost;
    agg.duration += u.finishedAt - u.startedAt;
  }
  return Array.from(map.values()).sort((a, b) => a.sliceId.localeCompare(b.sliceId));
}
function aggregateByModel(units) {
  const map = /* @__PURE__ */ new Map();
  for (const u of units) {
    let agg = map.get(u.model);
    if (!agg) {
      agg = { model: u.model, units: 0, tokens: emptyTokens(), cost: 0 };
      map.set(u.model, agg);
    }
    agg.units++;
    agg.tokens = addTokens(agg.tokens, u.tokens);
    agg.cost += u.cost;
    if (u.contextWindowTokens !== void 0 && agg.contextWindowTokens === void 0) {
      agg.contextWindowTokens = u.contextWindowTokens;
    }
  }
  return Array.from(map.values()).sort((a, b) => b.cost - a.cost);
}
function getProjectTotals(units) {
  const totals = {
    units: units.length,
    tokens: emptyTokens(),
    cost: 0,
    duration: 0,
    toolCalls: 0,
    assistantMessages: 0,
    userMessages: 0,
    apiRequests: 0,
    totalTruncationSections: 0,
    continueHereFiredCount: 0
  };
  for (const u of units) {
    totals.tokens = addTokens(totals.tokens, u.tokens);
    totals.cost += u.cost;
    totals.duration += u.finishedAt - u.startedAt;
    totals.toolCalls += u.toolCalls;
    totals.assistantMessages += u.assistantMessages;
    totals.userMessages += u.userMessages;
    totals.apiRequests += u.apiRequests ?? u.assistantMessages;
    totals.totalTruncationSections += u.truncationSections ?? 0;
    if (u.continueHereFired) totals.continueHereFiredCount++;
  }
  return totals;
}
function aggregateByTier(units) {
  const map = /* @__PURE__ */ new Map();
  for (const u of units) {
    const tier = u.tier ?? "unknown";
    let agg = map.get(tier);
    if (!agg) {
      agg = { tier, units: 0, tokens: emptyTokens(), cost: 0, downgraded: 0 };
      map.set(tier, agg);
    }
    agg.units++;
    agg.tokens = addTokens(agg.tokens, u.tokens);
    agg.cost += u.cost;
    if (u.modelDowngraded) agg.downgraded++;
  }
  const order = ["light", "standard", "heavy", "unknown"];
  return order.map((t) => map.get(t)).filter((a) => !!a);
}
function formatTierSavings(units) {
  const downgraded = units.filter((u) => u.modelDowngraded);
  if (downgraded.length === 0) return "";
  const downgradedCost = downgraded.reduce((sum, u) => sum + u.cost, 0);
  const totalUnits = units.filter((u) => u.tier).length;
  const pct = totalUnits > 0 ? Math.round(downgraded.length / totalUnits * 100) : 0;
  return `Dynamic routing: ${downgraded.length}/${totalUnits} units downgraded (${pct}%), cost: ${formatCost(downgradedCost)}`;
}
function aggregateCacheHitRate() {
  if (!ledger || ledger.units.length === 0) return 0;
  let totalInput = 0;
  let totalCacheRead = 0;
  for (const unit of ledger.units) {
    totalInput += unit.tokens.input;
    totalCacheRead += unit.tokens.cacheRead;
  }
  const total = totalInput + totalCacheRead;
  return total > 0 ? Math.round(totalCacheRead / total * 100) : 0;
}
function formatCost(cost) {
  const n = Number(cost) || 0;
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}
function getAverageCostPerUnitType(units) {
  const sums = /* @__PURE__ */ new Map();
  for (const u of units) {
    const entry = sums.get(u.type) ?? { total: 0, count: 0 };
    entry.total += u.cost;
    entry.count += 1;
    sums.set(u.type, entry);
  }
  const avgs = /* @__PURE__ */ new Map();
  for (const [type, { total, count }] of sums) {
    avgs.set(type, total / count);
  }
  return avgs;
}
function predictRemainingCost(avgCosts, remainingUnits, fallbackAvg) {
  const allAvgs = [...avgCosts.values()];
  const overallAvg = fallbackAvg ?? (allAvgs.length > 0 ? allAvgs.reduce((a, b) => a + b, 0) / allAvgs.length : 0);
  let total = 0;
  for (const unitType of remainingUnits) {
    total += avgCosts.get(unitType) ?? overallAvg;
  }
  return total;
}
function formatCostProjection(completedSlices, remainingCount, budgetCeiling) {
  const sliceLevel = completedSlices.filter((s) => s.sliceId.includes("/"));
  if (sliceLevel.length < 2) return [];
  const totalCost = sliceLevel.reduce((sum, s) => sum + s.cost, 0);
  const avgCost = totalCost / sliceLevel.length;
  const projected = avgCost * remainingCount;
  const projLine = `Projected remaining: ${formatCost(projected)} (${formatCost(avgCost)}/slice avg \xD7 ${remainingCount} remaining)`;
  const result = [projLine];
  if (budgetCeiling !== void 0 && totalCost >= budgetCeiling) {
    result.push(`Budget ceiling ${formatCost(budgetCeiling)} reached (spent ${formatCost(totalCost)})`);
  }
  return result;
}
function metricsPath(base) {
  return join(gsdRoot(base), "metrics.json");
}
function isMetricsLedger(data) {
  return typeof data === "object" && data !== null && data.version === 1 && Array.isArray(data.units);
}
function defaultLedger() {
  return { version: 1, projectStartedAt: Date.now(), units: [] };
}
function pruneMetricsLedger(base, keepCount) {
  const disk = loadLedgerFromDisk(base);
  if (!disk || disk.units.length <= keepCount) return 0;
  const removed = disk.units.length - keepCount;
  disk.units = disk.units.slice(-keepCount);
  saveJsonFile(metricsPath(base), disk);
  if (ledger) {
    ledger.units = ledger.units.slice(-keepCount);
  }
  scopedLedgers.clear();
  return removed;
}
function loadLedgerFromDisk(base) {
  return loadJsonFileOrNull(metricsPath(base), isMetricsLedger);
}
function loadLedger(base) {
  const raw = loadJsonFile(metricsPath(base), isMetricsLedger, defaultLedger);
  const before = raw.units.length;
  raw.units = deduplicateUnits(raw.units);
  if (raw.units.length < before) {
    saveLedger(base, raw);
  }
  return raw;
}
function deduplicateUnits(units) {
  const map = /* @__PURE__ */ new Map();
  for (const u of units) {
    const key = `${u.type}\0${u.id}\0${u.startedAt}`;
    const existing = map.get(key);
    if (!existing || u.finishedAt > existing.finishedAt) {
      map.set(key, u);
    }
  }
  return Array.from(map.values());
}
const STALE_LOCK_THRESHOLD_MS = 4e3;
const LOCK_RETRY_INTERVAL_MS = 5;
const _lockSleepBuf = new Int32Array(new SharedArrayBuffer(4));
function syncSleep(ms) {
  Atomics.wait(_lockSleepBuf, 0, 0, ms);
}
let _lockSleepyRetries = 0;
function getLockSleepyRetries() {
  return _lockSleepyRetries;
}
function resetLockSleepyRetries() {
  _lockSleepyRetries = 0;
}
function acquireLock(lockPath, timeoutMs = 2e3) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockPath, "wx");
      closeSync(fd);
      try {
        writeFileSync(lockPath, `${process.pid}
${(/* @__PURE__ */ new Date()).toISOString()}
`, "utf-8");
      } catch {
      }
      return true;
    } catch {
      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > STALE_LOCK_THRESHOLD_MS) {
          logWarning(
            "fs",
            `stale metrics lock at ${lockPath} (age ${Date.now() - st.mtimeMs}ms); forcibly removing and retrying`
          );
          try {
            unlinkSync(lockPath);
          } catch {
          }
          continue;
        }
      } catch {
      }
      _lockSleepyRetries++;
      syncSleep(LOCK_RETRY_INTERVAL_MS);
    }
  }
  return false;
}
function releaseLock(lockPath) {
  try {
    unlinkSync(lockPath);
  } catch {
  }
}
function saveLedger(base, data) {
  const path = metricsPath(base);
  const lockPath = `${path}.lock`;
  const acquired = acquireLock(lockPath);
  if (acquired) {
    try {
      const onDisk = loadJsonFileOrNull(path, isMetricsLedger);
      if (onDisk && onDisk.units.length > 0) {
        const merged = deduplicateUnits([...onDisk.units, ...data.units]);
        saveJsonFile(path, { ...data, units: merged });
      } else {
        saveJsonFile(path, data);
      }
    } finally {
      releaseLock(lockPath);
    }
  } else {
    logWarning("fs", "saveLedger: lock not acquired \u2014 falling back to direct write (no merge)");
    saveJsonFile(path, data);
  }
}
export {
  LOCK_RETRY_INTERVAL_MS,
  STALE_LOCK_THRESHOLD_MS,
  aggregateByModel,
  aggregateByPhase,
  aggregateBySlice,
  aggregateByTier,
  aggregateCacheHitRate,
  classifyUnitPhase,
  formatCost,
  formatCostProjection,
  formatTierSavings,
  formatTokenCount,
  getAverageCostPerUnitType,
  getLedger,
  getLedgerByScope,
  getLockSleepyRetries,
  getProjectTotals,
  initMetrics,
  initMetricsByScope,
  loadLedgerFromDisk,
  predictRemainingCost,
  pruneMetricsLedger,
  resetLockSleepyRetries,
  resetMetrics,
  resetMetricsByScope,
  snapshotUnitMetrics,
  snapshotUnitMetricsByScope
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9tZXRyaWNzLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBHU0QtMiArIG1ldHJpY3MudHM6IHRva2VuICYgY29zdCB0cmFja2luZyBmb3IgYXV0by1tb2RlIHVuaXRzXG4vKipcbiAqIEdTRCBNZXRyaWNzIFx1MjAxNCBUb2tlbiAmIENvc3QgVHJhY2tpbmdcbiAqXG4gKiBBY2N1bXVsYXRlcyBwZXItdW5pdCB1c2FnZSBkYXRhIGFjcm9zcyBhdXRvLW1vZGUgc2Vzc2lvbnMuXG4gKiBEYXRhIGlzIGV4dHJhY3RlZCBmcm9tIHNlc3Npb24gZW50cmllcyBiZWZvcmUgZWFjaCBjb250ZXh0IHdpcGUsXG4gKiB3cml0dGVuIHRvIC5nc2QvbWV0cmljcy5qc29uLCBhbmQgc3VyZmFjZWQgaW4gdGhlIGRhc2hib2FyZC5cbiAqXG4gKiBEYXRhIGZsb3c6XG4gKiAgIDEuIEJlZm9yZSBuZXdTZXNzaW9uKCkgd2lwZXMgY29udGV4dCwgc25hcHNob3RVbml0TWV0cmljcygpIHNjYW5zXG4gKiAgICAgIHNlc3Npb24gZW50cmllcyBmb3IgQXNzaXN0YW50TWVzc2FnZSB1c2FnZSBkYXRhXG4gKiAgIDIuIFRoZSB1bml0IHJlY29yZCBpcyBhcHBlbmRlZCB0byB0aGUgaW4tbWVtb3J5IGxlZGdlciBhbmQgZmx1c2hlZCB0byBkaXNrXG4gKiAgIDMuIFRoZSBkYXNoYm9hcmQgb3ZlcmxheSBhbmQgcHJvZ3Jlc3Mgd2lkZ2V0IHJlYWQgZnJvbSB0aGUgaW4tbWVtb3J5IGxlZGdlclxuICogICA0LiBPbiBjcmFzaCByZWNvdmVyeSBvciBmcmVzaCBzdGFydCwgdGhlIGxlZGdlciBpcyBsb2FkZWQgZnJvbSBkaXNrXG4gKi9cblxuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IG9wZW5TeW5jLCBjbG9zZVN5bmMsIHVubGlua1N5bmMsIHN0YXRTeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB0eXBlIHsgRXh0ZW5zaW9uQ29udGV4dCB9IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuaW1wb3J0IHsgZ3NkUm9vdCB9IGZyb20gXCIuL3BhdGhzLmpzXCI7XG5pbXBvcnQgeyBnZXRBbmRDbGVhclNraWxscyB9IGZyb20gXCIuL3NraWxsLXRlbGVtZXRyeS5qc1wiO1xuaW1wb3J0IHsgbG9hZEpzb25GaWxlLCBsb2FkSnNvbkZpbGVPck51bGwsIHNhdmVKc29uRmlsZSB9IGZyb20gXCIuL2pzb24tcGVyc2lzdGVuY2UuanNcIjtcbmltcG9ydCB7IHBhcnNlVW5pdElkIH0gZnJvbSBcIi4vdW5pdC1pZC5qc1wiO1xuaW1wb3J0IHsgYnVpbGRBdWRpdEVudmVsb3BlLCBlbWl0VW9rQXVkaXRFdmVudCB9IGZyb20gXCIuL3Vvay9hdWRpdC5qc1wiO1xuaW1wb3J0IHsgaXNVbmlmaWVkQXVkaXRFbmFibGVkIH0gZnJvbSBcIi4vdW9rL2F1ZGl0LXRvZ2dsZS5qc1wiO1xuaW1wb3J0IHR5cGUgeyBNaWxlc3RvbmVTY29wZSB9IGZyb20gXCIuL3dvcmtzcGFjZS5qc1wiO1xuaW1wb3J0IHsgbG9nV2FybmluZyB9IGZyb20gXCIuL3dvcmtmbG93LWxvZ2dlci5qc1wiO1xuXG4vLyBSZS1leHBvcnQgZnJvbSBzaGFyZWQgXHUyMDE0IGltcG9ydCBkaXJlY3RseSBmcm9tIGZvcm1hdC11dGlscyB0byBhdm9pZCBwdWxsaW5nXG4vLyBpbiB0aGUgZnVsbCBiYXJyZWwgKG1vZC5qcyBcdTIxOTIgdWkuanMgXHUyMTkyIEBnc2QvcGktdHVpKSB3aGljaCBicmVha3Mgd2hlbiBsb2FkZWRcbi8vIG91dHNpZGUgaml0aSdzIGFsaWFzIHJlc29sdXRpb24gKGUuZy4gZHluYW1pYyBpbXBvcnQgaW4gYXV0by1sb29wIHJlcG9ydHMpLlxuZXhwb3J0IHsgZm9ybWF0VG9rZW5Db3VudCB9IGZyb20gXCIuLi9zaGFyZWQvZm9ybWF0LXV0aWxzLmpzXCI7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUeXBlcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGludGVyZmFjZSBUb2tlbkNvdW50cyB7XG4gIGlucHV0OiBudW1iZXI7XG4gIG91dHB1dDogbnVtYmVyO1xuICBjYWNoZVJlYWQ6IG51bWJlcjtcbiAgY2FjaGVXcml0ZTogbnVtYmVyO1xuICB0b3RhbDogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFVuaXRNZXRyaWNzIHtcbiAgdHlwZTogc3RyaW5nOyAgICAgICAgICAgIC8vIGUuZy4gXCJyZXNlYXJjaC1taWxlc3RvbmVcIiwgXCJleGVjdXRlLXRhc2tcIlxuICBpZDogc3RyaW5nOyAgICAgICAgICAgICAgLy8gZS5nLiBcIk0wMDEvUzAxL1QwMVwiXG4gIG1vZGVsOiBzdHJpbmc7ICAgICAgICAgICAvLyBtb2RlbCBJRCB1c2VkXG4gIHN0YXJ0ZWRBdDogbnVtYmVyOyAgICAgICAvLyBtcyB0aW1lc3RhbXBcbiAgZmluaXNoZWRBdDogbnVtYmVyOyAgICAgIC8vIG1zIHRpbWVzdGFtcFxuICBhdXRvU2Vzc2lvbktleT86IHN0cmluZzsgLy8gaWRlbnRpZmllcyBvbmUgYXV0by1tb2RlIHJ1biBhY3Jvc3MgcGF1c2UvcmVzdW1lXG4gIHRva2VuczogVG9rZW5Db3VudHM7XG4gIGNvc3Q6IG51bWJlcjsgICAgICAgICAgICAvLyB0b3RhbCBVU0QgY29zdFxuICB0b29sQ2FsbHM6IG51bWJlcjtcbiAgYXNzaXN0YW50TWVzc2FnZXM6IG51bWJlcjtcbiAgdXNlck1lc3NhZ2VzOiBudW1iZXI7XG4gIGFwaVJlcXVlc3RzPzogbnVtYmVyOyAgICAvLyB0b3RhbCBBUEkgcmVxdWVzdHMgbWFkZSAodXNlZnVsIGZvciBjb3BpbG90IHVzZXJzIHdoZXJlIGNvc3QgaXMgYWx3YXlzIDApXG4gIC8vIEJ1ZGdldCBmaWVsZHMgKG9wdGlvbmFsIFx1MjAxNCBhYnNlbnQgaW4gcHJlLU0wMDkgbWV0cmljcyBkYXRhKVxuICBjb250ZXh0V2luZG93VG9rZW5zPzogbnVtYmVyO1xuICB0cnVuY2F0aW9uU2VjdGlvbnM/OiBudW1iZXI7XG4gIGNvbnRpbnVlSGVyZUZpcmVkPzogYm9vbGVhbjtcbiAgcHJvbXB0Q2hhckNvdW50PzogbnVtYmVyO1xuICBiYXNlbGluZUNoYXJDb3VudD86IG51bWJlcjtcbiAgdGllcj86IHN0cmluZzsgICAgICAgICAgIC8vIGNvbXBsZXhpdHkgdGllciAobGlnaHQvc3RhbmRhcmQvaGVhdnkpIGlmIGR5bmFtaWMgcm91dGluZyBhY3RpdmVcbiAgbW9kZWxEb3duZ3JhZGVkPzogYm9vbGVhbjsgLy8gdHJ1ZSBpZiBkeW5hbWljIHJvdXRpbmcgdXNlZCBhIGNoZWFwZXIgbW9kZWxcbiAgc2tpbGxzPzogc3RyaW5nW107ICAgICAgIC8vIHNraWxsIG5hbWVzIGF2YWlsYWJsZS9sb2FkZWQgZHVyaW5nIHRoaXMgdW5pdCAoIzU5OSlcbiAgY2FjaGVIaXRSYXRlPzogbnVtYmVyOyAgICAgICAvLyBwZXJjZW50YWdlIDAtMTAwLCBjb21wdXRlZCBmcm9tIGNhY2hlUmVhZC8oY2FjaGVSZWFkK2lucHV0KVxuICBjb21wcmVzc2lvblNhdmluZ3M/OiBudW1iZXI7IC8vIHBlcmNlbnRhZ2UgMC0xMDAsIGNoYXIgc2F2aW5ncyBmcm9tIHByb21wdCBjb21wcmVzc2lvblxufVxuXG4vKiogQnVkZ2V0IHN0YXRlIHBhc3NlZCB0byBzbmFwc2hvdFVuaXRNZXRyaWNzIGZvciBwZXJzaXN0ZW5jZSBpbiB0aGUgbWV0cmljcyBsZWRnZXIuICovXG5leHBvcnQgaW50ZXJmYWNlIEJ1ZGdldEluZm8ge1xuICBjb250ZXh0V2luZG93VG9rZW5zPzogbnVtYmVyO1xuICB0cnVuY2F0aW9uU2VjdGlvbnM/OiBudW1iZXI7XG4gIGNvbnRpbnVlSGVyZUZpcmVkPzogYm9vbGVhbjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBNZXRyaWNzTGVkZ2VyIHtcbiAgdmVyc2lvbjogMTtcbiAgcHJvamVjdFN0YXJ0ZWRBdDogbnVtYmVyO1xuICB1bml0czogVW5pdE1ldHJpY3NbXTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFBoYXNlIGNsYXNzaWZpY2F0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgdHlwZSBNZXRyaWNzUGhhc2UgPSBcInJlc2VhcmNoXCIgfCBcImRpc2N1c3Npb25cIiB8IFwicGxhbm5pbmdcIiB8IFwiZXhlY3V0aW9uXCIgfCBcImNvbXBsZXRpb25cIiB8IFwicmVhc3Nlc3NtZW50XCI7XG5cbmV4cG9ydCBmdW5jdGlvbiBjbGFzc2lmeVVuaXRQaGFzZSh1bml0VHlwZTogc3RyaW5nKTogTWV0cmljc1BoYXNlIHtcbiAgc3dpdGNoICh1bml0VHlwZSkge1xuICAgIGNhc2UgXCJyZXNlYXJjaC1taWxlc3RvbmVcIjpcbiAgICBjYXNlIFwicmVzZWFyY2gtc2xpY2VcIjpcbiAgICAgIHJldHVybiBcInJlc2VhcmNoXCI7XG4gICAgY2FzZSBcImRpc2N1c3MtbWlsZXN0b25lXCI6XG4gICAgY2FzZSBcImRpc2N1c3Mtc2xpY2VcIjpcbiAgICAgIHJldHVybiBcImRpc2N1c3Npb25cIjtcbiAgICBjYXNlIFwicGxhbi1taWxlc3RvbmVcIjpcbiAgICBjYXNlIFwicGxhbi1zbGljZVwiOlxuICAgIGNhc2UgXCJyZWZpbmUtc2xpY2VcIjpcbiAgICAgIHJldHVybiBcInBsYW5uaW5nXCI7XG4gICAgY2FzZSBcImV4ZWN1dGUtdGFza1wiOlxuICAgICAgcmV0dXJuIFwiZXhlY3V0aW9uXCI7XG4gICAgY2FzZSBcImNvbXBsZXRlLXNsaWNlXCI6XG4gICAgICByZXR1cm4gXCJjb21wbGV0aW9uXCI7XG4gICAgY2FzZSBcInJlYXNzZXNzLXJvYWRtYXBcIjpcbiAgICAgIHJldHVybiBcInJlYXNzZXNzbWVudFwiO1xuICAgIGRlZmF1bHQ6XG4gICAgICByZXR1cm4gXCJleGVjdXRpb25cIjtcbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgSW4tbWVtb3J5IHN0YXRlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5sZXQgbGVkZ2VyOiBNZXRyaWNzTGVkZ2VyIHwgbnVsbCA9IG51bGw7XG5sZXQgYmFzZVBhdGg6IHN0cmluZyA9IFwiXCI7XG5cbi8vIFBlci13b3Jrc3BhY2UgbGVkZ2VyIG1hcCwga2V5ZWQgYnkgd29ya3NwYWNlLmlkZW50aXR5S2V5LlxuLy8gUG9wdWxhdGVkIGJ5IGluaXRNZXRyaWNzQnlTY29wZTsgaW5kZXBlbmRlbnQgb2YgdGhlIG1vZHVsZSBzaW5nbGV0b24uXG5jb25zdCBzY29wZWRMZWRnZXJzID0gbmV3IE1hcDxzdHJpbmcsIE1ldHJpY3NMZWRnZXI+KCk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBQdWJsaWMgQVBJIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIEluaXRpYWxpemUgdGhlIG1ldHJpY3Mgc3lzdGVtIGZvciBhIGdpdmVuIHByb2plY3QuXG4gKiBMb2FkcyBleGlzdGluZyBsZWRnZXIgZnJvbSBkaXNrIGlmIHByZXNlbnQuXG4gKlxuICogQGRlcHJlY2F0ZWQgVE9ETyhDLWZ1dHVyZSk6IHJlbW92ZSBtb2R1bGUgc2luZ2xldG9uLiBVc2UgaW5pdE1ldHJpY3NCeVNjb3BlIGluc3RlYWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpbml0TWV0cmljcyhiYXNlOiBzdHJpbmcpOiB2b2lkIHtcbiAgYmFzZVBhdGggPSBiYXNlO1xuICBsZWRnZXIgPSBsb2FkTGVkZ2VyKGJhc2UpO1xufVxuXG4vKipcbiAqIFJlc2V0IGluLW1lbW9yeSBzdGF0ZS4gQ2FsbGVkIHdoZW4gYXV0by1tb2RlIHN0b3BzLlxuICpcbiAqIEBkZXByZWNhdGVkIFRPRE8oQy1mdXR1cmUpOiByZW1vdmUgbW9kdWxlIHNpbmdsZXRvbi4gVXNlIHJlc2V0TWV0cmljc0J5U2NvcGUgaW5zdGVhZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc2V0TWV0cmljcygpOiB2b2lkIHtcbiAgbGVkZ2VyID0gbnVsbDtcbiAgYmFzZVBhdGggPSBcIlwiO1xufVxuXG4vKipcbiAqIFNuYXBzaG90IHVzYWdlIG1ldHJpY3MgZnJvbSB0aGUgY3VycmVudCBzZXNzaW9uIGJlZm9yZSBpdCdzIHdpcGVkLlxuICogU2NhbnMgc2Vzc2lvbiBlbnRyaWVzIGZvciBBc3Npc3RhbnRNZXNzYWdlIHVzYWdlIGRhdGEuXG4gKlxuICogQGRlcHJlY2F0ZWQgVE9ETyhDLWZ1dHVyZSk6IHJlbW92ZSBtb2R1bGUgc2luZ2xldG9uLiBVc2Ugc25hcHNob3RVbml0TWV0cmljc0J5U2NvcGUgaW5zdGVhZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNuYXBzaG90VW5pdE1ldHJpY3MoXG4gIGN0eDogRXh0ZW5zaW9uQ29udGV4dCxcbiAgdW5pdFR5cGU6IHN0cmluZyxcbiAgdW5pdElkOiBzdHJpbmcsXG4gIHN0YXJ0ZWRBdDogbnVtYmVyLFxuICBtb2RlbDogc3RyaW5nLFxuICBvcHRzPzoge1xuICAgIHRpZXI/OiBzdHJpbmc7XG4gICAgbW9kZWxEb3duZ3JhZGVkPzogYm9vbGVhbjtcbiAgICBjb250ZXh0V2luZG93VG9rZW5zPzogbnVtYmVyO1xuICAgIHRydW5jYXRpb25TZWN0aW9ucz86IG51bWJlcjtcbiAgICBjb250aW51ZUhlcmVGaXJlZD86IGJvb2xlYW47XG4gICAgcHJvbXB0Q2hhckNvdW50PzogbnVtYmVyO1xuICAgIGJhc2VsaW5lQ2hhckNvdW50PzogbnVtYmVyO1xuICAgIGF1dG9TZXNzaW9uS2V5Pzogc3RyaW5nO1xuICAgIHRyYWNlSWQ/OiBzdHJpbmc7XG4gICAgdHVybklkPzogc3RyaW5nO1xuICAgIGNhdXNlZEJ5Pzogc3RyaW5nO1xuICB9LFxuKTogVW5pdE1ldHJpY3MgfCBudWxsIHtcbiAgaWYgKCFsZWRnZXIpIHJldHVybiBudWxsO1xuXG4gIGNvbnN0IGVudHJpZXMgPSBjdHguc2Vzc2lvbk1hbmFnZXIuZ2V0RW50cmllcygpO1xuICBpZiAoIWVudHJpZXMgfHwgZW50cmllcy5sZW5ndGggPT09IDApIHJldHVybiBudWxsO1xuXG4gIGNvbnN0IHRva2VuczogVG9rZW5Db3VudHMgPSB7IGlucHV0OiAwLCBvdXRwdXQ6IDAsIGNhY2hlUmVhZDogMCwgY2FjaGVXcml0ZTogMCwgdG90YWw6IDAgfTtcbiAgbGV0IGNvc3QgPSAwO1xuICBsZXQgdG9vbENhbGxzID0gMDtcbiAgbGV0IGFzc2lzdGFudE1lc3NhZ2VzID0gMDtcbiAgbGV0IHVzZXJNZXNzYWdlcyA9IDA7XG5cbiAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSB7XG4gICAgaWYgKGVudHJ5LnR5cGUgIT09IFwibWVzc2FnZVwiKSBjb250aW51ZTtcbiAgICBjb25zdCBtc2cgPSAoZW50cnkgYXMgYW55KS5tZXNzYWdlO1xuICAgIGlmICghbXNnKSBjb250aW51ZTtcblxuICAgIGlmIChtc2cucm9sZSA9PT0gXCJhc3Npc3RhbnRcIikge1xuICAgICAgYXNzaXN0YW50TWVzc2FnZXMrKztcbiAgICAgIGlmIChtc2cudXNhZ2UpIHtcbiAgICAgICAgdG9rZW5zLmlucHV0ICs9IG1zZy51c2FnZS5pbnB1dCA/PyAwO1xuICAgICAgICB0b2tlbnMub3V0cHV0ICs9IG1zZy51c2FnZS5vdXRwdXQgPz8gMDtcbiAgICAgICAgdG9rZW5zLmNhY2hlUmVhZCArPSBtc2cudXNhZ2UuY2FjaGVSZWFkID8/IDA7XG4gICAgICAgIHRva2Vucy5jYWNoZVdyaXRlICs9IG1zZy51c2FnZS5jYWNoZVdyaXRlID8/IDA7XG4gICAgICAgIHRva2Vucy50b3RhbCArPSBtc2cudXNhZ2UudG90YWxUb2tlbnMgPz8gMDtcbiAgICAgICAgaWYgKG1zZy51c2FnZS5jb3N0ICE9IG51bGwpIHtcbiAgICAgICAgICBjb25zdCBjID0gbXNnLnVzYWdlLmNvc3Q7XG4gICAgICAgICAgY29zdCArPSB0eXBlb2YgYyA9PT0gXCJudW1iZXJcIiA/IGMgOiAoYy50b3RhbCA/PyAwKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgLy8gQ291bnQgdG9vbCBjYWxscyBpbiB0aGlzIG1lc3NhZ2VcbiAgICAgIGlmIChtc2cuY29udGVudCAmJiBBcnJheS5pc0FycmF5KG1zZy5jb250ZW50KSkge1xuICAgICAgICBmb3IgKGNvbnN0IGJsb2NrIG9mIG1zZy5jb250ZW50KSB7XG4gICAgICAgICAgaWYgKGJsb2NrLnR5cGUgPT09IFwidG9vbENhbGxcIikgdG9vbENhbGxzKys7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKG1zZy5yb2xlID09PSBcInVzZXJcIikge1xuICAgICAgdXNlck1lc3NhZ2VzKys7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgdW5pdDogVW5pdE1ldHJpY3MgPSB7XG4gICAgdHlwZTogdW5pdFR5cGUsXG4gICAgaWQ6IHVuaXRJZCxcbiAgICBtb2RlbCxcbiAgICBzdGFydGVkQXQsXG4gICAgZmluaXNoZWRBdDogRGF0ZS5ub3coKSxcbiAgICAuLi4ob3B0cz8uYXV0b1Nlc3Npb25LZXkgPyB7IGF1dG9TZXNzaW9uS2V5OiBvcHRzLmF1dG9TZXNzaW9uS2V5IH0gOiB7fSksXG4gICAgdG9rZW5zLFxuICAgIGNvc3QsXG4gICAgdG9vbENhbGxzLFxuICAgIGFzc2lzdGFudE1lc3NhZ2VzLFxuICAgIHVzZXJNZXNzYWdlcyxcbiAgICBhcGlSZXF1ZXN0czogYXNzaXN0YW50TWVzc2FnZXMsIC8vIGVhY2ggYXNzaXN0YW50IG1lc3NhZ2UgPSBvbmUgQVBJIHJlcXVlc3RcbiAgICAuLi4ob3B0cz8udGllciA/IHsgdGllcjogb3B0cy50aWVyIH0gOiB7fSksXG4gICAgLi4uKG9wdHM/Lm1vZGVsRG93bmdyYWRlZCAhPT0gdW5kZWZpbmVkID8geyBtb2RlbERvd25ncmFkZWQ6IG9wdHMubW9kZWxEb3duZ3JhZGVkIH0gOiB7fSksXG4gICAgLi4uKG9wdHM/LmNvbnRleHRXaW5kb3dUb2tlbnMgIT09IHVuZGVmaW5lZCA/IHsgY29udGV4dFdpbmRvd1Rva2Vuczogb3B0cy5jb250ZXh0V2luZG93VG9rZW5zIH0gOiB7fSksXG4gICAgLi4uKG9wdHM/LnRydW5jYXRpb25TZWN0aW9ucyAhPT0gdW5kZWZpbmVkID8geyB0cnVuY2F0aW9uU2VjdGlvbnM6IG9wdHMudHJ1bmNhdGlvblNlY3Rpb25zIH0gOiB7fSksXG4gICAgLi4uKG9wdHM/LmNvbnRpbnVlSGVyZUZpcmVkICE9PSB1bmRlZmluZWQgPyB7IGNvbnRpbnVlSGVyZUZpcmVkOiBvcHRzLmNvbnRpbnVlSGVyZUZpcmVkIH0gOiB7fSksXG4gICAgLi4uKG9wdHM/LnByb21wdENoYXJDb3VudCAhPSBudWxsID8geyBwcm9tcHRDaGFyQ291bnQ6IG9wdHMucHJvbXB0Q2hhckNvdW50IH0gOiB7fSksXG4gICAgLi4uKG9wdHM/LmJhc2VsaW5lQ2hhckNvdW50ICE9IG51bGwgPyB7IGJhc2VsaW5lQ2hhckNvdW50OiBvcHRzLmJhc2VsaW5lQ2hhckNvdW50IH0gOiB7fSksXG4gIH07XG5cbiAgLy8gQXV0by1jYXB0dXJlIHNraWxsIHRlbGVtZXRyeSAoIzU5OSlcbiAgY29uc3Qgc2tpbGxzID0gZ2V0QW5kQ2xlYXJTa2lsbHMoKTtcbiAgaWYgKHNraWxscy5sZW5ndGggPiAwKSB7XG4gICAgdW5pdC5za2lsbHMgPSBza2lsbHM7XG4gIH1cblxuICAvLyBDb21wdXRlIGNhY2hlIGhpdCByYXRlXG4gIGlmICh0b2tlbnMuY2FjaGVSZWFkID4gMCB8fCB0b2tlbnMuaW5wdXQgPiAwKSB7XG4gICAgY29uc3QgdG90YWxJbnB1dCA9IHRva2Vucy5jYWNoZVJlYWQgKyB0b2tlbnMuaW5wdXQ7XG4gICAgdW5pdC5jYWNoZUhpdFJhdGUgPSB0b3RhbElucHV0ID4gMCA/IE1hdGgucm91bmQoKHRva2Vucy5jYWNoZVJlYWQgLyB0b3RhbElucHV0KSAqIDEwMCkgOiAwO1xuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwIElkZW1wb3RlbmN5IGd1YXJkIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAvLyBQcmV2ZW50IGR1cGxpY2F0ZSBtZXRyaWNzIGVudHJpZXMgd2hlbiBtdWx0aXBsZSBjYWxsZXJzIHNuYXBzaG90IHRoZVxuICAvLyBzYW1lIHVuaXQgKGUuZy4gaWRsZS13YXRjaGRvZyBjbG9zZW91dFVuaXQgKyBub3JtYWwgbG9vcCBjbG9zZW91dFVuaXQpLlxuICAvLyBBIHVuaXQgaXMgY29uc2lkZXJlZCBhIGR1cGxpY2F0ZSB3aGVuIHR5cGUsIGlkLCBBTkQgc3RhcnRlZEF0IGFsbCBtYXRjaFxuICAvLyBhbiBleGlzdGluZyBlbnRyeS4gT24gZHVwbGljYXRlLCB0aGUgZXhpc3RpbmcgZW50cnkgaXMgdXBkYXRlZCBpbi1wbGFjZVxuICAvLyB3aXRoIHRoZSBsYXRlc3QgZmluaXNoZWRBdCBhbmQgdG9rZW4gY291bnRzIGluc3RlYWQgb2YgYXBwZW5kaW5nLlxuICBjb25zdCBkdXBlSWR4ID0gbGVkZ2VyLnVuaXRzLmZpbmRJbmRleChcbiAgICAodSkgPT4gdS50eXBlID09PSB1bml0LnR5cGUgJiYgdS5pZCA9PT0gdW5pdC5pZCAmJiB1LnN0YXJ0ZWRBdCA9PT0gdW5pdC5zdGFydGVkQXQsXG4gICk7XG4gIGlmIChkdXBlSWR4ID49IDApIHtcbiAgICBsZWRnZXIudW5pdHNbZHVwZUlkeF0gPSB1bml0O1xuICB9IGVsc2Uge1xuICAgIGxlZGdlci51bml0cy5wdXNoKHVuaXQpO1xuICB9XG4gIHNhdmVMZWRnZXIoYmFzZVBhdGgsIGxlZGdlcik7XG5cbiAgaWYgKGlzVW5pZmllZEF1ZGl0RW5hYmxlZCgpKSB7XG4gICAgZW1pdFVva0F1ZGl0RXZlbnQoXG4gICAgICBiYXNlUGF0aCxcbiAgICAgIGJ1aWxkQXVkaXRFbnZlbG9wZSh7XG4gICAgICAgIHRyYWNlSWQ6IG9wdHM/LnRyYWNlSWQgPz8gYG1ldHJpY3M6JHt1bml0VHlwZX06JHt1bml0SWR9YCxcbiAgICAgICAgdHVybklkOiBvcHRzPy50dXJuSWQsXG4gICAgICAgIGNhdXNlZEJ5OiBvcHRzPy5jYXVzZWRCeSxcbiAgICAgICAgY2F0ZWdvcnk6IFwibWV0cmljc1wiLFxuICAgICAgICB0eXBlOiBcInVuaXQtbWV0cmljcy1zbmFwc2hvdFwiLFxuICAgICAgICBwYXlsb2FkOiB7XG4gICAgICAgICAgdW5pdFR5cGUsXG4gICAgICAgICAgdW5pdElkLFxuICAgICAgICAgIG1vZGVsLFxuICAgICAgICAgIHRva2VuczogdW5pdC50b2tlbnMsXG4gICAgICAgICAgY29zdDogdW5pdC5jb3N0LFxuICAgICAgICAgIHRvb2xDYWxsczogdW5pdC50b29sQ2FsbHMsXG4gICAgICAgIH0sXG4gICAgICB9KSxcbiAgICApO1xuICB9XG5cbiAgcmV0dXJuIHVuaXQ7XG59XG5cbi8qKlxuICogR2V0IHRoZSBjdXJyZW50IGxlZGdlciAocmVhZC1vbmx5KS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldExlZGdlcigpOiBNZXRyaWNzTGVkZ2VyIHwgbnVsbCB7XG4gIHJldHVybiBsZWRnZXI7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTY29wZS1hd2FyZSBBUEkgKGNhbm9uaWNhbCkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogSW5pdGlhbGl6ZSB0aGUgbWV0cmljcyBzeXN0ZW0gZm9yIGEgZ2l2ZW4gd29ya3NwYWNlIHNjb3BlLlxuICogTG9hZHMgZXhpc3RpbmcgbGVkZ2VyIGZyb20gZGlzayBpbnRvIHRoZSBwZXItc2NvcGUgbGVkZ2VyIG1hcC5cbiAqIERvZXMgTk9UIHRvdWNoIHRoZSBtb2R1bGUtbGV2ZWwgc2luZ2xldG9uLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaW5pdE1ldHJpY3NCeVNjb3BlKHNjb3BlOiBNaWxlc3RvbmVTY29wZSk6IHZvaWQge1xuICBjb25zdCBiYXNlID0gc2NvcGUud29ya3NwYWNlLnByb2plY3RSb290O1xuICBjb25zdCBsb2FkZWQgPSBsb2FkTGVkZ2VyKGJhc2UpO1xuICBzY29wZWRMZWRnZXJzLnNldChzY29wZS53b3Jrc3BhY2UuaWRlbnRpdHlLZXksIGxvYWRlZCk7XG59XG5cbi8qKlxuICogR2V0IHRoZSBpbi1tZW1vcnkgbGVkZ2VyIGZvciB0aGUgZ2l2ZW4gc2NvcGUsIG9yIG51bGwgaWYgbm90IGluaXRpYWxpemVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0TGVkZ2VyQnlTY29wZShzY29wZTogTWlsZXN0b25lU2NvcGUpOiBNZXRyaWNzTGVkZ2VyIHwgbnVsbCB7XG4gIHJldHVybiBzY29wZWRMZWRnZXJzLmdldChzY29wZS53b3Jrc3BhY2UuaWRlbnRpdHlLZXkpID8/IG51bGw7XG59XG5cbi8qKlxuICogUmVzZXQgc2NvcGVkIGluLW1lbW9yeSBzdGF0ZSBmb3IgYSB3b3Jrc3BhY2UuIENhbGxlZCB3aGVuIGF1dG8tbW9kZSBzdG9wcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc2V0TWV0cmljc0J5U2NvcGUoc2NvcGU6IE1pbGVzdG9uZVNjb3BlKTogdm9pZCB7XG4gIHNjb3BlZExlZGdlcnMuZGVsZXRlKHNjb3BlLndvcmtzcGFjZS5pZGVudGl0eUtleSk7XG59XG5cbi8qKlxuICogU25hcHNob3QgdXNhZ2UgbWV0cmljcyB1c2luZyBhbiBleHBsaWNpdCB3b3Jrc3BhY2Ugc2NvcGUuXG4gKlxuICogVGhpcyBpcyB0aGUgY2Fub25pY2FsIHZhcmlhbnQuIEl0IGRlcml2ZXMgdGhlIG1ldHJpY3MgcGF0aCBmcm9tXG4gKiBzY29wZS53b3Jrc3BhY2UucHJvamVjdFJvb3QgcmF0aGVyIHRoYW4gdGhlIG1vZHVsZSBzaW5nbGV0b24sIHNvIGl0XG4gKiByZW1haW5zIGNvcnJlY3QgYWNyb3NzIHNlc3Npb24gcmVzdW1lIGFuZCBpbiBtdWx0aS13b3Jrc3BhY2UgcHJvY2Vzc2VzLlxuICpcbiAqIFByZXNlcnZlcyB0aGUgYXRvbWljIHdyaXRlLW1lcmdlIGxvZ2ljIGZyb20gc2F2ZUxlZGdlciBzbyBjb25jdXJyZW50XG4gKiB3b3JrZXJzIGNhbm5vdCBzaWxlbnRseSBkaXNjYXJkIGVhY2ggb3RoZXIncyBlbnRyaWVzLlxuICpcbiAqIElmIGluaXRNZXRyaWNzQnlTY29wZSBoYXMgbm90IGJlZW4gY2FsbGVkLCB0aGUgbGVkZ2VyIGlzIGxvYWRlZCBmcm9tXG4gKiBkaXNrIG9uIGZpcnN0IGNhbGwgKGxhenkgaW5pdCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzbmFwc2hvdFVuaXRNZXRyaWNzQnlTY29wZShcbiAgc2NvcGU6IE1pbGVzdG9uZVNjb3BlLFxuICBjdHg6IEV4dGVuc2lvbkNvbnRleHQsXG4gIHVuaXRUeXBlOiBzdHJpbmcsXG4gIHVuaXRJZDogc3RyaW5nLFxuICBzdGFydGVkQXQ6IG51bWJlcixcbiAgbW9kZWw6IHN0cmluZyxcbiAgb3B0cz86IHtcbiAgICB0aWVyPzogc3RyaW5nO1xuICAgIG1vZGVsRG93bmdyYWRlZD86IGJvb2xlYW47XG4gICAgY29udGV4dFdpbmRvd1Rva2Vucz86IG51bWJlcjtcbiAgICB0cnVuY2F0aW9uU2VjdGlvbnM/OiBudW1iZXI7XG4gICAgY29udGludWVIZXJlRmlyZWQ/OiBib29sZWFuO1xuICAgIHByb21wdENoYXJDb3VudD86IG51bWJlcjtcbiAgICBiYXNlbGluZUNoYXJDb3VudD86IG51bWJlcjtcbiAgICBhdXRvU2Vzc2lvbktleT86IHN0cmluZztcbiAgICB0cmFjZUlkPzogc3RyaW5nO1xuICAgIHR1cm5JZD86IHN0cmluZztcbiAgICBjYXVzZWRCeT86IHN0cmluZztcbiAgfSxcbik6IFVuaXRNZXRyaWNzIHwgbnVsbCB7XG4gIGNvbnN0IGJhc2UgPSBzY29wZS53b3Jrc3BhY2UucHJvamVjdFJvb3Q7XG4gIGNvbnN0IGtleSA9IHNjb3BlLndvcmtzcGFjZS5pZGVudGl0eUtleTtcblxuICAvLyBMYXp5IGluaXQ6IGxvYWQgZnJvbSBkaXNrIGlmIG5vdCB5ZXQgaW4gc2NvcGVkIG1hcC5cbiAgaWYgKCFzY29wZWRMZWRnZXJzLmhhcyhrZXkpKSB7XG4gICAgc2NvcGVkTGVkZ2Vycy5zZXQoa2V5LCBsb2FkTGVkZ2VyKGJhc2UpKTtcbiAgfVxuICBjb25zdCBzY29wZWRMZWRnZXIgPSBzY29wZWRMZWRnZXJzLmdldChrZXkpITtcblxuICBjb25zdCBlbnRyaWVzID0gY3R4LnNlc3Npb25NYW5hZ2VyLmdldEVudHJpZXMoKTtcbiAgaWYgKCFlbnRyaWVzIHx8IGVudHJpZXMubGVuZ3RoID09PSAwKSByZXR1cm4gbnVsbDtcblxuICBjb25zdCB0b2tlbnM6IFRva2VuQ291bnRzID0geyBpbnB1dDogMCwgb3V0cHV0OiAwLCBjYWNoZVJlYWQ6IDAsIGNhY2hlV3JpdGU6IDAsIHRvdGFsOiAwIH07XG4gIGxldCBjb3N0ID0gMDtcbiAgbGV0IHRvb2xDYWxscyA9IDA7XG4gIGxldCBhc3Npc3RhbnRNZXNzYWdlcyA9IDA7XG4gIGxldCB1c2VyTWVzc2FnZXMgPSAwO1xuXG4gIGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xuICAgIGlmIChlbnRyeS50eXBlICE9PSBcIm1lc3NhZ2VcIikgY29udGludWU7XG4gICAgY29uc3QgbXNnID0gKGVudHJ5IGFzIGFueSkubWVzc2FnZTtcbiAgICBpZiAoIW1zZykgY29udGludWU7XG5cbiAgICBpZiAobXNnLnJvbGUgPT09IFwiYXNzaXN0YW50XCIpIHtcbiAgICAgIGFzc2lzdGFudE1lc3NhZ2VzKys7XG4gICAgICBpZiAobXNnLnVzYWdlKSB7XG4gICAgICAgIHRva2Vucy5pbnB1dCArPSBtc2cudXNhZ2UuaW5wdXQgPz8gMDtcbiAgICAgICAgdG9rZW5zLm91dHB1dCArPSBtc2cudXNhZ2Uub3V0cHV0ID8/IDA7XG4gICAgICAgIHRva2Vucy5jYWNoZVJlYWQgKz0gbXNnLnVzYWdlLmNhY2hlUmVhZCA/PyAwO1xuICAgICAgICB0b2tlbnMuY2FjaGVXcml0ZSArPSBtc2cudXNhZ2UuY2FjaGVXcml0ZSA/PyAwO1xuICAgICAgICB0b2tlbnMudG90YWwgKz0gbXNnLnVzYWdlLnRvdGFsVG9rZW5zID8/IDA7XG4gICAgICAgIGlmIChtc2cudXNhZ2UuY29zdCAhPSBudWxsKSB7XG4gICAgICAgICAgY29uc3QgYyA9IG1zZy51c2FnZS5jb3N0O1xuICAgICAgICAgIGNvc3QgKz0gdHlwZW9mIGMgPT09IFwibnVtYmVyXCIgPyBjIDogKGMudG90YWwgPz8gMCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChtc2cuY29udGVudCAmJiBBcnJheS5pc0FycmF5KG1zZy5jb250ZW50KSkge1xuICAgICAgICBmb3IgKGNvbnN0IGJsb2NrIG9mIG1zZy5jb250ZW50KSB7XG4gICAgICAgICAgaWYgKGJsb2NrLnR5cGUgPT09IFwidG9vbENhbGxcIikgdG9vbENhbGxzKys7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKG1zZy5yb2xlID09PSBcInVzZXJcIikge1xuICAgICAgdXNlck1lc3NhZ2VzKys7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgdW5pdDogVW5pdE1ldHJpY3MgPSB7XG4gICAgdHlwZTogdW5pdFR5cGUsXG4gICAgaWQ6IHVuaXRJZCxcbiAgICBtb2RlbCxcbiAgICBzdGFydGVkQXQsXG4gICAgZmluaXNoZWRBdDogRGF0ZS5ub3coKSxcbiAgICAuLi4ob3B0cz8uYXV0b1Nlc3Npb25LZXkgPyB7IGF1dG9TZXNzaW9uS2V5OiBvcHRzLmF1dG9TZXNzaW9uS2V5IH0gOiB7fSksXG4gICAgdG9rZW5zLFxuICAgIGNvc3QsXG4gICAgdG9vbENhbGxzLFxuICAgIGFzc2lzdGFudE1lc3NhZ2VzLFxuICAgIHVzZXJNZXNzYWdlcyxcbiAgICBhcGlSZXF1ZXN0czogYXNzaXN0YW50TWVzc2FnZXMsXG4gICAgLi4uKG9wdHM/LnRpZXIgPyB7IHRpZXI6IG9wdHMudGllciB9IDoge30pLFxuICAgIC4uLihvcHRzPy5tb2RlbERvd25ncmFkZWQgIT09IHVuZGVmaW5lZCA/IHsgbW9kZWxEb3duZ3JhZGVkOiBvcHRzLm1vZGVsRG93bmdyYWRlZCB9IDoge30pLFxuICAgIC4uLihvcHRzPy5jb250ZXh0V2luZG93VG9rZW5zICE9PSB1bmRlZmluZWQgPyB7IGNvbnRleHRXaW5kb3dUb2tlbnM6IG9wdHMuY29udGV4dFdpbmRvd1Rva2VucyB9IDoge30pLFxuICAgIC4uLihvcHRzPy50cnVuY2F0aW9uU2VjdGlvbnMgIT09IHVuZGVmaW5lZCA/IHsgdHJ1bmNhdGlvblNlY3Rpb25zOiBvcHRzLnRydW5jYXRpb25TZWN0aW9ucyB9IDoge30pLFxuICAgIC4uLihvcHRzPy5jb250aW51ZUhlcmVGaXJlZCAhPT0gdW5kZWZpbmVkID8geyBjb250aW51ZUhlcmVGaXJlZDogb3B0cy5jb250aW51ZUhlcmVGaXJlZCB9IDoge30pLFxuICAgIC4uLihvcHRzPy5wcm9tcHRDaGFyQ291bnQgIT0gbnVsbCA/IHsgcHJvbXB0Q2hhckNvdW50OiBvcHRzLnByb21wdENoYXJDb3VudCB9IDoge30pLFxuICAgIC4uLihvcHRzPy5iYXNlbGluZUNoYXJDb3VudCAhPSBudWxsID8geyBiYXNlbGluZUNoYXJDb3VudDogb3B0cy5iYXNlbGluZUNoYXJDb3VudCB9IDoge30pLFxuICB9O1xuXG4gIC8vIEF1dG8tY2FwdHVyZSBza2lsbCB0ZWxlbWV0cnkgKCM1OTkpXG4gIGNvbnN0IHNraWxscyA9IGdldEFuZENsZWFyU2tpbGxzKCk7XG4gIGlmIChza2lsbHMubGVuZ3RoID4gMCkge1xuICAgIHVuaXQuc2tpbGxzID0gc2tpbGxzO1xuICB9XG5cbiAgLy8gQ29tcHV0ZSBjYWNoZSBoaXQgcmF0ZVxuICBpZiAodG9rZW5zLmNhY2hlUmVhZCA+IDAgfHwgdG9rZW5zLmlucHV0ID4gMCkge1xuICAgIGNvbnN0IHRvdGFsSW5wdXQgPSB0b2tlbnMuY2FjaGVSZWFkICsgdG9rZW5zLmlucHV0O1xuICAgIHVuaXQuY2FjaGVIaXRSYXRlID0gdG90YWxJbnB1dCA+IDAgPyBNYXRoLnJvdW5kKCh0b2tlbnMuY2FjaGVSZWFkIC8gdG90YWxJbnB1dCkgKiAxMDApIDogMDtcbiAgfVxuXG4gIC8vIElkZW1wb3RlbmN5IGd1YXJkOiB1cGRhdGUgaW4tcGxhY2Ugb24gZHVwbGljYXRlLCBhcHBlbmQgb3RoZXJ3aXNlLlxuICBjb25zdCBkdXBlSWR4ID0gc2NvcGVkTGVkZ2VyLnVuaXRzLmZpbmRJbmRleChcbiAgICAodSkgPT4gdS50eXBlID09PSB1bml0LnR5cGUgJiYgdS5pZCA9PT0gdW5pdC5pZCAmJiB1LnN0YXJ0ZWRBdCA9PT0gdW5pdC5zdGFydGVkQXQsXG4gICk7XG4gIGlmIChkdXBlSWR4ID49IDApIHtcbiAgICBzY29wZWRMZWRnZXIudW5pdHNbZHVwZUlkeF0gPSB1bml0O1xuICB9IGVsc2Uge1xuICAgIHNjb3BlZExlZGdlci51bml0cy5wdXNoKHVuaXQpO1xuICB9XG4gIHNhdmVMZWRnZXIoYmFzZSwgc2NvcGVkTGVkZ2VyKTtcblxuICBpZiAoaXNVbmlmaWVkQXVkaXRFbmFibGVkKCkpIHtcbiAgICBlbWl0VW9rQXVkaXRFdmVudChcbiAgICAgIGJhc2UsXG4gICAgICBidWlsZEF1ZGl0RW52ZWxvcGUoe1xuICAgICAgICB0cmFjZUlkOiBvcHRzPy50cmFjZUlkID8/IGBtZXRyaWNzOiR7dW5pdFR5cGV9OiR7dW5pdElkfWAsXG4gICAgICAgIHR1cm5JZDogb3B0cz8udHVybklkLFxuICAgICAgICBjYXVzZWRCeTogb3B0cz8uY2F1c2VkQnksXG4gICAgICAgIGNhdGVnb3J5OiBcIm1ldHJpY3NcIixcbiAgICAgICAgdHlwZTogXCJ1bml0LW1ldHJpY3Mtc25hcHNob3RcIixcbiAgICAgICAgcGF5bG9hZDoge1xuICAgICAgICAgIHVuaXRUeXBlLFxuICAgICAgICAgIHVuaXRJZCxcbiAgICAgICAgICBtb2RlbCxcbiAgICAgICAgICB0b2tlbnM6IHVuaXQudG9rZW5zLFxuICAgICAgICAgIGNvc3Q6IHVuaXQuY29zdCxcbiAgICAgICAgICB0b29sQ2FsbHM6IHVuaXQudG9vbENhbGxzLFxuICAgICAgICB9LFxuICAgICAgfSksXG4gICAgKTtcbiAgfVxuXG4gIHJldHVybiB1bml0O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQWdncmVnYXRpb24gaGVscGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGludGVyZmFjZSBQaGFzZUFnZ3JlZ2F0ZSB7XG4gIHBoYXNlOiBNZXRyaWNzUGhhc2U7XG4gIHVuaXRzOiBudW1iZXI7XG4gIHRva2VuczogVG9rZW5Db3VudHM7XG4gIGNvc3Q6IG51bWJlcjtcbiAgZHVyYXRpb246IG51bWJlcjsgIC8vIG1zXG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2xpY2VBZ2dyZWdhdGUge1xuICBzbGljZUlkOiBzdHJpbmc7XG4gIHVuaXRzOiBudW1iZXI7XG4gIHRva2VuczogVG9rZW5Db3VudHM7XG4gIGNvc3Q6IG51bWJlcjtcbiAgZHVyYXRpb246IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBNb2RlbEFnZ3JlZ2F0ZSB7XG4gIG1vZGVsOiBzdHJpbmc7XG4gIHVuaXRzOiBudW1iZXI7XG4gIHRva2VuczogVG9rZW5Db3VudHM7XG4gIGNvc3Q6IG51bWJlcjtcbiAgY29udGV4dFdpbmRvd1Rva2Vucz86IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBQcm9qZWN0VG90YWxzIHtcbiAgdW5pdHM6IG51bWJlcjtcbiAgdG9rZW5zOiBUb2tlbkNvdW50cztcbiAgY29zdDogbnVtYmVyO1xuICBkdXJhdGlvbjogbnVtYmVyO1xuICB0b29sQ2FsbHM6IG51bWJlcjtcbiAgYXNzaXN0YW50TWVzc2FnZXM6IG51bWJlcjtcbiAgdXNlck1lc3NhZ2VzOiBudW1iZXI7XG4gIGFwaVJlcXVlc3RzOiBudW1iZXI7XG4gIHRvdGFsVHJ1bmNhdGlvblNlY3Rpb25zOiBudW1iZXI7XG4gIGNvbnRpbnVlSGVyZUZpcmVkQ291bnQ6IG51bWJlcjtcbn1cblxuZnVuY3Rpb24gZW1wdHlUb2tlbnMoKTogVG9rZW5Db3VudHMge1xuICByZXR1cm4geyBpbnB1dDogMCwgb3V0cHV0OiAwLCBjYWNoZVJlYWQ6IDAsIGNhY2hlV3JpdGU6IDAsIHRvdGFsOiAwIH07XG59XG5cbmZ1bmN0aW9uIGFkZFRva2VucyhhOiBUb2tlbkNvdW50cywgYjogVG9rZW5Db3VudHMpOiBUb2tlbkNvdW50cyB7XG4gIHJldHVybiB7XG4gICAgaW5wdXQ6IGEuaW5wdXQgKyBiLmlucHV0LFxuICAgIG91dHB1dDogYS5vdXRwdXQgKyBiLm91dHB1dCxcbiAgICBjYWNoZVJlYWQ6IGEuY2FjaGVSZWFkICsgYi5jYWNoZVJlYWQsXG4gICAgY2FjaGVXcml0ZTogYS5jYWNoZVdyaXRlICsgYi5jYWNoZVdyaXRlLFxuICAgIHRvdGFsOiBhLnRvdGFsICsgYi50b3RhbCxcbiAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFnZ3JlZ2F0ZUJ5UGhhc2UodW5pdHM6IFVuaXRNZXRyaWNzW10pOiBQaGFzZUFnZ3JlZ2F0ZVtdIHtcbiAgY29uc3QgbWFwID0gbmV3IE1hcDxNZXRyaWNzUGhhc2UsIFBoYXNlQWdncmVnYXRlPigpO1xuICBmb3IgKGNvbnN0IHUgb2YgdW5pdHMpIHtcbiAgICBjb25zdCBwaGFzZSA9IGNsYXNzaWZ5VW5pdFBoYXNlKHUudHlwZSk7XG4gICAgbGV0IGFnZyA9IG1hcC5nZXQocGhhc2UpO1xuICAgIGlmICghYWdnKSB7XG4gICAgICBhZ2cgPSB7IHBoYXNlLCB1bml0czogMCwgdG9rZW5zOiBlbXB0eVRva2VucygpLCBjb3N0OiAwLCBkdXJhdGlvbjogMCB9O1xuICAgICAgbWFwLnNldChwaGFzZSwgYWdnKTtcbiAgICB9XG4gICAgYWdnLnVuaXRzKys7XG4gICAgYWdnLnRva2VucyA9IGFkZFRva2VucyhhZ2cudG9rZW5zLCB1LnRva2Vucyk7XG4gICAgYWdnLmNvc3QgKz0gdS5jb3N0O1xuICAgIGFnZy5kdXJhdGlvbiArPSB1LmZpbmlzaGVkQXQgLSB1LnN0YXJ0ZWRBdDtcbiAgfVxuICAvLyBSZXR1cm4gaW4gYSBzdGFibGUgb3JkZXJcbiAgY29uc3Qgb3JkZXI6IE1ldHJpY3NQaGFzZVtdID0gW1wicmVzZWFyY2hcIiwgXCJkaXNjdXNzaW9uXCIsIFwicGxhbm5pbmdcIiwgXCJleGVjdXRpb25cIiwgXCJjb21wbGV0aW9uXCIsIFwicmVhc3Nlc3NtZW50XCJdO1xuICByZXR1cm4gb3JkZXIubWFwKHAgPT4gbWFwLmdldChwKSkuZmlsdGVyKChhKTogYSBpcyBQaGFzZUFnZ3JlZ2F0ZSA9PiAhIWEpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWdncmVnYXRlQnlTbGljZSh1bml0czogVW5pdE1ldHJpY3NbXSk6IFNsaWNlQWdncmVnYXRlW10ge1xuICBjb25zdCBtYXAgPSBuZXcgTWFwPHN0cmluZywgU2xpY2VBZ2dyZWdhdGU+KCk7XG4gIGZvciAoY29uc3QgdSBvZiB1bml0cykge1xuICAgIGNvbnN0IHsgbWlsZXN0b25lLCBzbGljZSB9ID0gcGFyc2VVbml0SWQodS5pZCk7XG4gICAgY29uc3Qgc2xpY2VJZCA9IHNsaWNlID8gYCR7bWlsZXN0b25lfS8ke3NsaWNlfWAgOiBtaWxlc3RvbmU7XG4gICAgbGV0IGFnZyA9IG1hcC5nZXQoc2xpY2VJZCk7XG4gICAgaWYgKCFhZ2cpIHtcbiAgICAgIGFnZyA9IHsgc2xpY2VJZCwgdW5pdHM6IDAsIHRva2VuczogZW1wdHlUb2tlbnMoKSwgY29zdDogMCwgZHVyYXRpb246IDAgfTtcbiAgICAgIG1hcC5zZXQoc2xpY2VJZCwgYWdnKTtcbiAgICB9XG4gICAgYWdnLnVuaXRzKys7XG4gICAgYWdnLnRva2VucyA9IGFkZFRva2VucyhhZ2cudG9rZW5zLCB1LnRva2Vucyk7XG4gICAgYWdnLmNvc3QgKz0gdS5jb3N0O1xuICAgIGFnZy5kdXJhdGlvbiArPSB1LmZpbmlzaGVkQXQgLSB1LnN0YXJ0ZWRBdDtcbiAgfVxuICByZXR1cm4gQXJyYXkuZnJvbShtYXAudmFsdWVzKCkpLnNvcnQoKGEsIGIpID0+IGEuc2xpY2VJZC5sb2NhbGVDb21wYXJlKGIuc2xpY2VJZCkpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWdncmVnYXRlQnlNb2RlbCh1bml0czogVW5pdE1ldHJpY3NbXSk6IE1vZGVsQWdncmVnYXRlW10ge1xuICBjb25zdCBtYXAgPSBuZXcgTWFwPHN0cmluZywgTW9kZWxBZ2dyZWdhdGU+KCk7XG4gIGZvciAoY29uc3QgdSBvZiB1bml0cykge1xuICAgIGxldCBhZ2cgPSBtYXAuZ2V0KHUubW9kZWwpO1xuICAgIGlmICghYWdnKSB7XG4gICAgICBhZ2cgPSB7IG1vZGVsOiB1Lm1vZGVsLCB1bml0czogMCwgdG9rZW5zOiBlbXB0eVRva2VucygpLCBjb3N0OiAwIH07XG4gICAgICBtYXAuc2V0KHUubW9kZWwsIGFnZyk7XG4gICAgfVxuICAgIGFnZy51bml0cysrO1xuICAgIGFnZy50b2tlbnMgPSBhZGRUb2tlbnMoYWdnLnRva2VucywgdS50b2tlbnMpO1xuICAgIGFnZy5jb3N0ICs9IHUuY29zdDtcbiAgICBpZiAodS5jb250ZXh0V2luZG93VG9rZW5zICE9PSB1bmRlZmluZWQgJiYgYWdnLmNvbnRleHRXaW5kb3dUb2tlbnMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgYWdnLmNvbnRleHRXaW5kb3dUb2tlbnMgPSB1LmNvbnRleHRXaW5kb3dUb2tlbnM7XG4gICAgfVxuICB9XG4gIHJldHVybiBBcnJheS5mcm9tKG1hcC52YWx1ZXMoKSkuc29ydCgoYSwgYikgPT4gYi5jb3N0IC0gYS5jb3N0KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldFByb2plY3RUb3RhbHModW5pdHM6IFVuaXRNZXRyaWNzW10pOiBQcm9qZWN0VG90YWxzIHtcbiAgY29uc3QgdG90YWxzOiBQcm9qZWN0VG90YWxzID0ge1xuICAgIHVuaXRzOiB1bml0cy5sZW5ndGgsXG4gICAgdG9rZW5zOiBlbXB0eVRva2VucygpLFxuICAgIGNvc3Q6IDAsXG4gICAgZHVyYXRpb246IDAsXG4gICAgdG9vbENhbGxzOiAwLFxuICAgIGFzc2lzdGFudE1lc3NhZ2VzOiAwLFxuICAgIHVzZXJNZXNzYWdlczogMCxcbiAgICBhcGlSZXF1ZXN0czogMCxcbiAgICB0b3RhbFRydW5jYXRpb25TZWN0aW9uczogMCxcbiAgICBjb250aW51ZUhlcmVGaXJlZENvdW50OiAwLFxuICB9O1xuICBmb3IgKGNvbnN0IHUgb2YgdW5pdHMpIHtcbiAgICB0b3RhbHMudG9rZW5zID0gYWRkVG9rZW5zKHRvdGFscy50b2tlbnMsIHUudG9rZW5zKTtcbiAgICB0b3RhbHMuY29zdCArPSB1LmNvc3Q7XG4gICAgdG90YWxzLmR1cmF0aW9uICs9IHUuZmluaXNoZWRBdCAtIHUuc3RhcnRlZEF0O1xuICAgIHRvdGFscy50b29sQ2FsbHMgKz0gdS50b29sQ2FsbHM7XG4gICAgdG90YWxzLmFzc2lzdGFudE1lc3NhZ2VzICs9IHUuYXNzaXN0YW50TWVzc2FnZXM7XG4gICAgdG90YWxzLnVzZXJNZXNzYWdlcyArPSB1LnVzZXJNZXNzYWdlcztcbiAgICB0b3RhbHMuYXBpUmVxdWVzdHMgKz0gdS5hcGlSZXF1ZXN0cyA/PyB1LmFzc2lzdGFudE1lc3NhZ2VzOyAvLyBmYWxsYmFjayBmb3IgcHJlLWV4aXN0aW5nIGRhdGFcbiAgICB0b3RhbHMudG90YWxUcnVuY2F0aW9uU2VjdGlvbnMgKz0gdS50cnVuY2F0aW9uU2VjdGlvbnMgPz8gMDtcbiAgICBpZiAodS5jb250aW51ZUhlcmVGaXJlZCkgdG90YWxzLmNvbnRpbnVlSGVyZUZpcmVkQ291bnQrKztcbiAgfVxuICByZXR1cm4gdG90YWxzO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGllciBBZ2dyZWdhdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGludGVyZmFjZSBUaWVyQWdncmVnYXRlIHtcbiAgdGllcjogc3RyaW5nO1xuICB1bml0czogbnVtYmVyO1xuICB0b2tlbnM6IFRva2VuQ291bnRzO1xuICBjb3N0OiBudW1iZXI7XG4gIGRvd25ncmFkZWQ6IG51bWJlcjsgICAvLyB1bml0cyB0aGF0IHdlcmUgZG93bmdyYWRlZCBieSBkeW5hbWljIHJvdXRpbmdcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFnZ3JlZ2F0ZUJ5VGllcih1bml0czogVW5pdE1ldHJpY3NbXSk6IFRpZXJBZ2dyZWdhdGVbXSB7XG4gIGNvbnN0IG1hcCA9IG5ldyBNYXA8c3RyaW5nLCBUaWVyQWdncmVnYXRlPigpO1xuICBmb3IgKGNvbnN0IHUgb2YgdW5pdHMpIHtcbiAgICBjb25zdCB0aWVyID0gdS50aWVyID8/IFwidW5rbm93blwiO1xuICAgIGxldCBhZ2cgPSBtYXAuZ2V0KHRpZXIpO1xuICAgIGlmICghYWdnKSB7XG4gICAgICBhZ2cgPSB7IHRpZXIsIHVuaXRzOiAwLCB0b2tlbnM6IGVtcHR5VG9rZW5zKCksIGNvc3Q6IDAsIGRvd25ncmFkZWQ6IDAgfTtcbiAgICAgIG1hcC5zZXQodGllciwgYWdnKTtcbiAgICB9XG4gICAgYWdnLnVuaXRzKys7XG4gICAgYWdnLnRva2VucyA9IGFkZFRva2VucyhhZ2cudG9rZW5zLCB1LnRva2Vucyk7XG4gICAgYWdnLmNvc3QgKz0gdS5jb3N0O1xuICAgIGlmICh1Lm1vZGVsRG93bmdyYWRlZCkgYWdnLmRvd25ncmFkZWQrKztcbiAgfVxuICBjb25zdCBvcmRlciA9IFtcImxpZ2h0XCIsIFwic3RhbmRhcmRcIiwgXCJoZWF2eVwiLCBcInVua25vd25cIl07XG4gIHJldHVybiBvcmRlci5tYXAodCA9PiBtYXAuZ2V0KHQpKS5maWx0ZXIoKGEpOiBhIGlzIFRpZXJBZ2dyZWdhdGUgPT4gISFhKTtcbn1cblxuLyoqXG4gKiBGb3JtYXQgYSBzdW1tYXJ5IG9mIHNhdmluZ3MgZnJvbSBkeW5hbWljIHJvdXRpbmcuXG4gKiBSZXR1cm5zIGVtcHR5IHN0cmluZyBpZiBubyB1bml0cyB3ZXJlIGRvd25ncmFkZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXRUaWVyU2F2aW5ncyh1bml0czogVW5pdE1ldHJpY3NbXSk6IHN0cmluZyB7XG4gIGNvbnN0IGRvd25ncmFkZWQgPSB1bml0cy5maWx0ZXIodSA9PiB1Lm1vZGVsRG93bmdyYWRlZCk7XG4gIGlmIChkb3duZ3JhZGVkLmxlbmd0aCA9PT0gMCkgcmV0dXJuIFwiXCI7XG5cbiAgY29uc3QgZG93bmdyYWRlZENvc3QgPSBkb3duZ3JhZGVkLnJlZHVjZSgoc3VtLCB1KSA9PiBzdW0gKyB1LmNvc3QsIDApO1xuICBjb25zdCB0b3RhbFVuaXRzID0gdW5pdHMuZmlsdGVyKHUgPT4gdS50aWVyKS5sZW5ndGg7XG4gIGNvbnN0IHBjdCA9IHRvdGFsVW5pdHMgPiAwID8gTWF0aC5yb3VuZCgoZG93bmdyYWRlZC5sZW5ndGggLyB0b3RhbFVuaXRzKSAqIDEwMCkgOiAwO1xuXG4gIHJldHVybiBgRHluYW1pYyByb3V0aW5nOiAke2Rvd25ncmFkZWQubGVuZ3RofS8ke3RvdGFsVW5pdHN9IHVuaXRzIGRvd25ncmFkZWQgKCR7cGN0fSUpLCBjb3N0OiAke2Zvcm1hdENvc3QoZG93bmdyYWRlZENvc3QpfWA7XG59XG5cbi8qKlxuICogQ29tcHV0ZSBhZ2dyZWdhdGUgY2FjaGUgaGl0IHJhdGUgYWNyb3NzIGFsbCB1bml0cy5cbiAqIFJldHVybnMgcGVyY2VudGFnZSAwLTEwMC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFnZ3JlZ2F0ZUNhY2hlSGl0UmF0ZSgpOiBudW1iZXIge1xuICBpZiAoIWxlZGdlciB8fCBsZWRnZXIudW5pdHMubGVuZ3RoID09PSAwKSByZXR1cm4gMDtcbiAgbGV0IHRvdGFsSW5wdXQgPSAwO1xuICBsZXQgdG90YWxDYWNoZVJlYWQgPSAwO1xuICBmb3IgKGNvbnN0IHVuaXQgb2YgbGVkZ2VyLnVuaXRzKSB7XG4gICAgdG90YWxJbnB1dCArPSB1bml0LnRva2Vucy5pbnB1dDtcbiAgICB0b3RhbENhY2hlUmVhZCArPSB1bml0LnRva2Vucy5jYWNoZVJlYWQ7XG4gIH1cbiAgY29uc3QgdG90YWwgPSB0b3RhbElucHV0ICsgdG90YWxDYWNoZVJlYWQ7XG4gIHJldHVybiB0b3RhbCA+IDAgPyBNYXRoLnJvdW5kKCh0b3RhbENhY2hlUmVhZCAvIHRvdGFsKSAqIDEwMCkgOiAwO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRm9ybWF0dGluZyBoZWxwZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0Q29zdChjb3N0OiBudW1iZXIpOiBzdHJpbmcge1xuICBjb25zdCBuID0gTnVtYmVyKGNvc3QpIHx8IDA7XG4gIGlmIChuIDwgMC4wMSkgcmV0dXJuIGAkJHtuLnRvRml4ZWQoNCl9YDtcbiAgaWYgKG4gPCAxKSByZXR1cm4gYCQke24udG9GaXhlZCgzKX1gO1xuICByZXR1cm4gYCQke24udG9GaXhlZCgyKX1gO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQnVkZ2V0IFByZWRpY3Rpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogQ2FsY3VsYXRlIGF2ZXJhZ2UgY29zdCBwZXIgdW5pdCB0eXBlIGZyb20gY29tcGxldGVkIHVuaXRzLlxuICogUmV0dXJucyBhIE1hcCBmcm9tIHVuaXQgdHlwZSB0byBhdmVyYWdlIGNvc3QgaW4gVVNELlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0QXZlcmFnZUNvc3RQZXJVbml0VHlwZSh1bml0czogVW5pdE1ldHJpY3NbXSk6IE1hcDxzdHJpbmcsIG51bWJlcj4ge1xuICBjb25zdCBzdW1zID0gbmV3IE1hcDxzdHJpbmcsIHsgdG90YWw6IG51bWJlcjsgY291bnQ6IG51bWJlciB9PigpO1xuICBmb3IgKGNvbnN0IHUgb2YgdW5pdHMpIHtcbiAgICBjb25zdCBlbnRyeSA9IHN1bXMuZ2V0KHUudHlwZSkgPz8geyB0b3RhbDogMCwgY291bnQ6IDAgfTtcbiAgICBlbnRyeS50b3RhbCArPSB1LmNvc3Q7XG4gICAgZW50cnkuY291bnQgKz0gMTtcbiAgICBzdW1zLnNldCh1LnR5cGUsIGVudHJ5KTtcbiAgfVxuICBjb25zdCBhdmdzID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgZm9yIChjb25zdCBbdHlwZSwgeyB0b3RhbCwgY291bnQgfV0gb2Ygc3Vtcykge1xuICAgIGF2Z3Muc2V0KHR5cGUsIHRvdGFsIC8gY291bnQpO1xuICB9XG4gIHJldHVybiBhdmdzO1xufVxuXG4vKipcbiAqIEVzdGltYXRlIHJlbWFpbmluZyBjb3N0IGdpdmVuIGF2ZXJhZ2UgY29zdHMgYW5kIHJlbWFpbmluZyB1bml0IGNvdW50cy5cbiAqIEBwYXJhbSBhdmdDb3N0cyAtIEF2ZXJhZ2UgY29zdCBwZXIgdW5pdCB0eXBlXG4gKiBAcGFyYW0gcmVtYWluaW5nVW5pdHMgLSBBcnJheSBvZiB1bml0IHR5cGVzIHN0aWxsIHRvIGRpc3BhdGNoXG4gKiBAcGFyYW0gZmFsbGJhY2tBdmcgLSBGYWxsYmFjayBhdmVyYWdlIGlmIHVuaXQgdHlwZSBub3Qgc2VlbiBiZWZvcmVcbiAqIEByZXR1cm5zIEVzdGltYXRlZCByZW1haW5pbmcgY29zdCBpbiBVU0RcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHByZWRpY3RSZW1haW5pbmdDb3N0KFxuICBhdmdDb3N0czogTWFwPHN0cmluZywgbnVtYmVyPixcbiAgcmVtYWluaW5nVW5pdHM6IHN0cmluZ1tdLFxuICBmYWxsYmFja0F2Zz86IG51bWJlcixcbik6IG51bWJlciB7XG4gIC8vIElmIG5vIGF2ZXJhZ2VzIGF2YWlsYWJsZSwgdXNlIG92ZXJhbGwgYXZlcmFnZSBhcyBmYWxsYmFja1xuICBjb25zdCBhbGxBdmdzID0gWy4uLmF2Z0Nvc3RzLnZhbHVlcygpXTtcbiAgY29uc3Qgb3ZlcmFsbEF2ZyA9IGZhbGxiYWNrQXZnID8/IChhbGxBdmdzLmxlbmd0aCA+IDAgPyBhbGxBdmdzLnJlZHVjZSgoYSwgYikgPT4gYSArIGIsIDApIC8gYWxsQXZncy5sZW5ndGggOiAwKTtcblxuICBsZXQgdG90YWwgPSAwO1xuICBmb3IgKGNvbnN0IHVuaXRUeXBlIG9mIHJlbWFpbmluZ1VuaXRzKSB7XG4gICAgdG90YWwgKz0gYXZnQ29zdHMuZ2V0KHVuaXRUeXBlKSA/PyBvdmVyYWxsQXZnO1xuICB9XG4gIHJldHVybiB0b3RhbDtcbn1cblxuLyoqXG4gKiBDb21wdXRlIGEgcHJvamVjdGVkIHJlbWFpbmluZyBjb3N0IGJhc2VkIG9uIGNvbXBsZXRlZCBzbGljZSBhdmVyYWdlcy5cbiAqXG4gKiBGaWx0ZXJzIHRvIHNsaWNlLWxldmVsIGVudHJpZXMgKHNsaWNlSWQgY29udGFpbnMgXCIvXCIpIHRvIGV4Y2x1ZGUgYmFyZSBtaWxlc3RvbmVcbiAqIGFnZ3JlZ2F0ZXMgZnJvbSB0aGUgYXZlcmFnZS4gUmV0dXJucyBbXSB3aGVuIGZld2VyIHRoYW4gMiBzbGljZS1sZXZlbCBlbnRyaWVzXG4gKiBleGlzdCAoaW5zdWZmaWNpZW50IGRhdGEgZm9yIGEgcmVsaWFibGUgcHJvamVjdGlvbikuXG4gKlxuICogSWYgYGJ1ZGdldENlaWxpbmdgIGlzIHByb3ZpZGVkIGFuZCBgdG90YWxDb3N0ID49IGJ1ZGdldENlaWxpbmdgLCBhIHdhcm5pbmcgbGluZVxuICogaXMgYXBwZW5kZWQgdG8gdGhlIHJlc3VsdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdENvc3RQcm9qZWN0aW9uKFxuICBjb21wbGV0ZWRTbGljZXM6IFNsaWNlQWdncmVnYXRlW10sXG4gIHJlbWFpbmluZ0NvdW50OiBudW1iZXIsXG4gIGJ1ZGdldENlaWxpbmc/OiBudW1iZXIsXG4pOiBzdHJpbmdbXSB7XG4gIGNvbnN0IHNsaWNlTGV2ZWwgPSBjb21wbGV0ZWRTbGljZXMuZmlsdGVyKHMgPT4gcy5zbGljZUlkLmluY2x1ZGVzKFwiL1wiKSk7XG4gIGlmIChzbGljZUxldmVsLmxlbmd0aCA8IDIpIHJldHVybiBbXTtcblxuICBjb25zdCB0b3RhbENvc3QgPSBzbGljZUxldmVsLnJlZHVjZSgoc3VtLCBzKSA9PiBzdW0gKyBzLmNvc3QsIDApO1xuICBjb25zdCBhdmdDb3N0ID0gdG90YWxDb3N0IC8gc2xpY2VMZXZlbC5sZW5ndGg7XG4gIGNvbnN0IHByb2plY3RlZCA9IGF2Z0Nvc3QgKiByZW1haW5pbmdDb3VudDtcblxuICBjb25zdCBwcm9qTGluZSA9IGBQcm9qZWN0ZWQgcmVtYWluaW5nOiAke2Zvcm1hdENvc3QocHJvamVjdGVkKX0gKCR7Zm9ybWF0Q29zdChhdmdDb3N0KX0vc2xpY2UgYXZnIFx1MDBENyAke3JlbWFpbmluZ0NvdW50fSByZW1haW5pbmcpYDtcbiAgY29uc3QgcmVzdWx0OiBzdHJpbmdbXSA9IFtwcm9qTGluZV07XG5cbiAgaWYgKGJ1ZGdldENlaWxpbmcgIT09IHVuZGVmaW5lZCAmJiB0b3RhbENvc3QgPj0gYnVkZ2V0Q2VpbGluZykge1xuICAgIHJlc3VsdC5wdXNoKGBCdWRnZXQgY2VpbGluZyAke2Zvcm1hdENvc3QoYnVkZ2V0Q2VpbGluZyl9IHJlYWNoZWQgKHNwZW50ICR7Zm9ybWF0Q29zdCh0b3RhbENvc3QpfSlgKTtcbiAgfVxuXG4gIHJldHVybiByZXN1bHQ7XG59XG5cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIERpc2sgSS9PIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBtZXRyaWNzUGF0aChiYXNlOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gam9pbihnc2RSb290KGJhc2UpLCBcIm1ldHJpY3MuanNvblwiKTtcbn1cblxuZnVuY3Rpb24gaXNNZXRyaWNzTGVkZ2VyKGRhdGE6IHVua25vd24pOiBkYXRhIGlzIE1ldHJpY3NMZWRnZXIge1xuICByZXR1cm4gKFxuICAgIHR5cGVvZiBkYXRhID09PSBcIm9iamVjdFwiICYmXG4gICAgZGF0YSAhPT0gbnVsbCAmJlxuICAgIChkYXRhIGFzIE1ldHJpY3NMZWRnZXIpLnZlcnNpb24gPT09IDEgJiZcbiAgICBBcnJheS5pc0FycmF5KChkYXRhIGFzIE1ldHJpY3NMZWRnZXIpLnVuaXRzKVxuICApO1xufVxuXG5mdW5jdGlvbiBkZWZhdWx0TGVkZ2VyKCk6IE1ldHJpY3NMZWRnZXIge1xuICByZXR1cm4geyB2ZXJzaW9uOiAxLCBwcm9qZWN0U3RhcnRlZEF0OiBEYXRlLm5vdygpLCB1bml0czogW10gfTtcbn1cblxuLyoqXG4gKiBQcnVuZSB0aGUgbWV0cmljcyBsZWRnZXIgdG8gYXQgbW9zdCBga2VlcENvdW50YCBtb3N0LXJlY2VudCB1bml0IGVudHJpZXMuXG4gKlxuICogQ2FsbGVkIGJ5IHRoZSBkb2N0b3Igd2hlbiB0aGUgbGVkZ2VyIGV4Y2VlZHMgdGhlIGJsb2F0IHRocmVzaG9sZC5cbiAqIEtlZXBzIHRoZSBuZXdlc3QgZW50cmllcyAoaGlnaGVzdCBpbmRleCA9IG1vc3QgcmVjZW50KSBhbmQgZGlzY2FyZHNcbiAqIHRoZSBvbGRlc3QgZnJvbSB0aGUgaGVhZCBvZiB0aGUgYXJyYXkuIFByZXNlcnZlcyBgcHJvamVjdFN0YXJ0ZWRBdGAuXG4gKlxuICogVXBkYXRlcyBib3RoIHRoZSBvbi1kaXNrIGZpbGUgYW5kIHRoZSBpbi1tZW1vcnkgbGVkZ2VyIGlmIGl0IGlzIGxvYWRlZCxcbiAqIHNvIHRoZSBjdXJyZW50IHNlc3Npb24gc2VlcyB0aGUgcHJ1bmVkIHN0YXRlIGltbWVkaWF0ZWx5LlxuICpcbiAqIEByZXR1cm5zIHRoZSBudW1iZXIgb2YgZW50cmllcyByZW1vdmVkLCBvciAwIGlmIG5vIHBydW5pbmcgd2FzIG5lZWRlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBydW5lTWV0cmljc0xlZGdlcihiYXNlOiBzdHJpbmcsIGtlZXBDb3VudDogbnVtYmVyKTogbnVtYmVyIHtcbiAgY29uc3QgZGlzayA9IGxvYWRMZWRnZXJGcm9tRGlzayhiYXNlKTtcbiAgaWYgKCFkaXNrIHx8IGRpc2sudW5pdHMubGVuZ3RoIDw9IGtlZXBDb3VudCkgcmV0dXJuIDA7XG4gIGNvbnN0IHJlbW92ZWQgPSBkaXNrLnVuaXRzLmxlbmd0aCAtIGtlZXBDb3VudDtcbiAgZGlzay51bml0cyA9IGRpc2sudW5pdHMuc2xpY2UoLWtlZXBDb3VudCk7XG4gIHNhdmVKc29uRmlsZShtZXRyaWNzUGF0aChiYXNlKSwgZGlzayk7XG4gIC8vIEtlZXAgdGhlIGluLW1lbW9yeSBsZWRnZXIgaW4gc3luYyBpZiBpdCBpcyBsb2FkZWQgZm9yIHRoaXMgc2Vzc2lvbi5cbiAgaWYgKGxlZGdlcikge1xuICAgIGxlZGdlci51bml0cyA9IGxlZGdlci51bml0cy5zbGljZSgta2VlcENvdW50KTtcbiAgfVxuICAvLyBJbnZhbGlkYXRlIGFsbCBzY29wZWQgbGVkZ2VyIGNhY2hlIGVudHJpZXMuIFBydW5lIGlzIHJhcmU7IGNsZWFyaW5nIHRoZVxuICAvLyBlbnRpcmUgbWFwIGlzIHNpbXBsZXIgdGhhbiB0cmFja2luZyB3aGljaCBlbnRyeSBiZWxvbmdzIHRvIGBiYXNlYC4gV2l0aG91dFxuICAvLyB0aGlzLCBzY29wZWRMZWRnZXJzIGVudHJpZXMgZm9yIHRoZSBwcnVuZWQgd29ya3NwYWNlIGhvbGQgYSBwcmUtcHJ1bmVcbiAgLy8gTWV0cmljc0xlZGdlciB0aGF0IHNuYXBzaG90VW5pdE1ldHJpY3NCeVNjb3BlIHdvdWxkIG1lcmdlIGJhY2sgaW4sIGNhdXNpbmdcbiAgLy8gcHJ1bmVkIHVuaXRzIHRvIHJlYXBwZWFyIGluIHN1YnNlcXVlbnQgc25hcHNob3RzLlxuICBzY29wZWRMZWRnZXJzLmNsZWFyKCk7XG4gIHJldHVybiByZW1vdmVkO1xufVxuXG4vKipcbiAqIExvYWQgbGVkZ2VyIGZyb20gZGlzayB3aXRob3V0IGluaXRpYWxpemluZyBpbi1tZW1vcnkgc3RhdGUuXG4gKiBVc2VkIGJ5IGhpc3RvcnkvZXhwb3J0IGNvbW1hbmRzIG91dHNpZGUgb2YgYXV0by1tb2RlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbG9hZExlZGdlckZyb21EaXNrKGJhc2U6IHN0cmluZyk6IE1ldHJpY3NMZWRnZXIgfCBudWxsIHtcbiAgcmV0dXJuIGxvYWRKc29uRmlsZU9yTnVsbChtZXRyaWNzUGF0aChiYXNlKSwgaXNNZXRyaWNzTGVkZ2VyKTtcbn1cblxuZnVuY3Rpb24gbG9hZExlZGdlcihiYXNlOiBzdHJpbmcpOiBNZXRyaWNzTGVkZ2VyIHtcbiAgY29uc3QgcmF3ID0gbG9hZEpzb25GaWxlKG1ldHJpY3NQYXRoKGJhc2UpLCBpc01ldHJpY3NMZWRnZXIsIGRlZmF1bHRMZWRnZXIpO1xuICBjb25zdCBiZWZvcmUgPSByYXcudW5pdHMubGVuZ3RoO1xuICByYXcudW5pdHMgPSBkZWR1cGxpY2F0ZVVuaXRzKHJhdy51bml0cyk7XG4gIGlmIChyYXcudW5pdHMubGVuZ3RoIDwgYmVmb3JlKSB7XG4gICAgLy8gUGVyc2lzdCB0aGUgY2xlYW5lZCBsZWRnZXIgc28gZHVwbGljYXRlcyBkb24ndCByZS1hY2N1bXVsYXRlXG4gICAgc2F2ZUxlZGdlcihiYXNlLCByYXcpO1xuICB9XG4gIHJldHVybiByYXc7XG59XG5cbi8qKlxuICogQ29sbGFwc2UgZHVwbGljYXRlIGVudHJpZXMgd2l0aCB0aGUgc2FtZSAodHlwZSwgaWQsIHN0YXJ0ZWRBdCkgdHJpcGxlLlxuICogS2VlcHMgdGhlIGVudHJ5IHdpdGggdGhlIGhpZ2hlc3QgZmluaXNoZWRBdCAodGhlIG1vc3QgY29tcGxldGUgc25hcHNob3QpLlxuICpcbiAqIFRoaXMgaXMgYSBkZWZlbnNpdmUgbWVhc3VyZSBhZ2FpbnN0IGlkbGUtd2F0Y2hkb2cgcmFjZSBjb25kaXRpb25zIHRoYXQgY2FuXG4gKiBwcm9kdWNlIGR1cGxpY2F0ZSBlbnRyaWVzIG9uIGRpc2sgZGVzcGl0ZSB0aGUgaW4tbWVtb3J5IGlkZW1wb3RlbmN5IGd1YXJkXG4gKiBpbiBzbmFwc2hvdFVuaXRNZXRyaWNzKCkuIFNlZSAjMTk0My5cbiAqL1xuZnVuY3Rpb24gZGVkdXBsaWNhdGVVbml0cyh1bml0czogVW5pdE1ldHJpY3NbXSk6IFVuaXRNZXRyaWNzW10ge1xuICBjb25zdCBtYXAgPSBuZXcgTWFwPHN0cmluZywgVW5pdE1ldHJpY3M+KCk7XG4gIGZvciAoY29uc3QgdSBvZiB1bml0cykge1xuICAgIGNvbnN0IGtleSA9IGAke3UudHlwZX1cXDAke3UuaWR9XFwwJHt1LnN0YXJ0ZWRBdH1gO1xuICAgIGNvbnN0IGV4aXN0aW5nID0gbWFwLmdldChrZXkpO1xuICAgIGlmICghZXhpc3RpbmcgfHwgdS5maW5pc2hlZEF0ID4gZXhpc3RpbmcuZmluaXNoZWRBdCkge1xuICAgICAgbWFwLnNldChrZXksIHUpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gQXJyYXkuZnJvbShtYXAudmFsdWVzKCkpO1xufVxuXG4vLyBIb3cgbG9uZyBhIGxvY2sgZmlsZSBtdXN0IGJlIHVudG91Y2hlZCAoaW4gbXMpIGJlZm9yZSBpdCBpcyBjb25zaWRlcmVkXG4vLyBvcnBoYW5lZCBmcm9tIGEgY3Jhc2hlZCBwcm9jZXNzLiBTZXQgdG8gMlx1MDBENyB0aGUgYWNxdWlyZSB0aW1lb3V0LlxuZXhwb3J0IGNvbnN0IFNUQUxFX0xPQ0tfVEhSRVNIT0xEX01TID0gNDAwMDtcblxuLy8gUmV0cnkgaW50ZXJ2YWwgYmV0d2VlbiBsb2NrIGFjcXVpcmUgYXR0ZW1wdHMgKG1zKS4gQ2FwcyBzeXNjYWxsIHJhdGUgYXRcbi8vIH4yMDAgYXR0ZW1wdHMgb3ZlciBhIDJzIHRpbWVvdXQgaW5zdGVhZCBvZiB+MjAsMDAwIHdpdGhvdXQgYW55IHNsZWVwLlxuLy8gRXhwb3NlZCBmb3IgdGVzdHMuXG5leHBvcnQgY29uc3QgTE9DS19SRVRSWV9JTlRFUlZBTF9NUyA9IDU7XG5cbi8vIFN5bmMgc2xlZXAgdmlhIEF0b21pY3Mud2FpdCBcdTIwMTQgdHJ1ZSBPUy1sZXZlbCBzbGVlcCwgbm8gQ1BVIHNwaW4uXG4vLyBJbnQzMkFycmF5IG11c3QgcmVmZXJlbmNlIGEgU2hhcmVkQXJyYXlCdWZmZXI7IHdlIHdhaXQgb24gaW5kZXggMCB3aGljaFxuLy8gd2lsbCBuZXZlciBiZSB3b2tlbiBieSBhIEF0b21pY3Mubm90aWZ5LCBzbyB0aGUgd2FpdCBhbHdheXMgdGltZXMgb3V0LlxuY29uc3QgX2xvY2tTbGVlcEJ1ZiA9IG5ldyBJbnQzMkFycmF5KG5ldyBTaGFyZWRBcnJheUJ1ZmZlcig0KSk7XG5mdW5jdGlvbiBzeW5jU2xlZXAobXM6IG51bWJlcik6IHZvaWQge1xuICBBdG9taWNzLndhaXQoX2xvY2tTbGVlcEJ1ZiwgMCwgMCwgbXMpO1xufVxuXG4vLyBDb3VudHMgdGhlIG51bWJlciBvZiBzbGVlcHkgcmV0cmllcyAobm9uLXN0YWxlLWV2aWN0aW5nKSBtYWRlIGJ5IGFjcXVpcmVMb2NrXG4vLyBhY3Jvc3MgYWxsIGNhbGxzIHNpbmNlIHRoZSBsYXN0IHJlc2V0LiBFeHBvcnRlZCBmb3IgdGVzdCBpbnN0cnVtZW50YXRpb24gb25seS5cbmxldCBfbG9ja1NsZWVweVJldHJpZXMgPSAwO1xuZXhwb3J0IGZ1bmN0aW9uIGdldExvY2tTbGVlcHlSZXRyaWVzKCk6IG51bWJlciB7IHJldHVybiBfbG9ja1NsZWVweVJldHJpZXM7IH1cbmV4cG9ydCBmdW5jdGlvbiByZXNldExvY2tTbGVlcHlSZXRyaWVzKCk6IHZvaWQgeyBfbG9ja1NsZWVweVJldHJpZXMgPSAwOyB9XG5cbi8qKlxuICogQWNxdWlyZSBhbiBleGNsdXNpdmUgLmxvY2sgc2VudGluZWwgZmlsZSB2aWEgT19FWENMLlxuICpcbiAqIEltcHJvdmVtZW50cyBvdmVyIHRoZSBvcmlnaW5hbDpcbiAqICAtIE5vIGJ1c3kgc3BpbjogdGhlIGlubmVyIGB3aGlsZSAoRGF0ZS5ub3coKSA8IHdhaXRVbnRpbCkge31gIHNwaW4gdGhhdFxuICogICAgYnVybmVkIENQVSBkb2luZyBub3RoaW5nIHVzZWZ1bCBpcyByZW1vdmVkLiBFYWNoIHJldHJ5IGF0dGVtcHQgbm93IG1ha2VzXG4gKiAgICBvbmUgYG9wZW5TeW5jYCBzeXNjYWxsIGFuZCBpbW1lZGlhdGVseSByZS1jaGVja3MgdGhlIGRlYWRsaW5lLCB3aGljaCBpc1xuICogICAgb3JkZXJzIG9mIG1hZ25pdHVkZSBjaGVhcGVyIHRoYW4gYSB0aWdodCBzcGluIGxvb3AuXG4gKiAgLSBTdGFsZS1sb2NrIGRldGVjdGlvbjogaWYgdGhlIGV4aXN0aW5nIGxvY2sgZmlsZSdzIG10aW1lIGlzIG9sZGVyIHRoYW5cbiAqICAgIFNUQUxFX0xPQ0tfVEhSRVNIT0xEX01TLCB0aGUgbG9jayBpcyBjb25zaWRlcmVkIG9ycGhhbmVkIChlLmcuIHRoZVxuICogICAgd3JpdGluZyBwcm9jZXNzIGNyYXNoZWQpIGFuZCBpcyBmb3JjaWJseSByZW1vdmVkIGJlZm9yZSByZXRyeWluZy5cbiAqICAgIEEgd2FybmluZyBpcyBsb2dnZWQgc28gb3BlcmF0b3JzIGNhbiBkZXRlY3QgY3Jhc2ggcGF0dGVybnMuXG4gKiAgLSBQSUQgc3RhbXA6IG9uIHN1Y2Nlc3MsIHdyaXRlcyB0aGUgYWNxdWlyaW5nIHByb2Nlc3MncyBQSUQgYW5kIGFcbiAqICAgIHRpbWVzdGFtcCBpbnRvIHRoZSBsb2NrIGZpbGUgc28gZXh0ZXJuYWwgbW9uaXRvcnMgY2FuIGlkZW50aWZ5IG9ycGhhbnMuXG4gKiAgLSBSZXRyeSBzbGVlcDogYWZ0ZXIgZWFjaCBub24tc3RhbGUtZXZpY3RpbmcgcmV0cnksIHNsZWVwc1xuICogICAgTE9DS19SRVRSWV9JTlRFUlZBTF9NUyAoNW1zKSB2aWEgQXRvbWljcy53YWl0IHNvIHRoZSBwcm9jZXNzIHlpZWxkcyB0b1xuICogICAgdGhlIE9TLiBUaGlzIGNhcHMgc3lzY2FsbCByYXRlIGF0IH4yMDBcdTIwMTM0MDAvcyB1bmRlciBjb250ZW50aW9uIGluc3RlYWQgb2ZcbiAqICAgIHRoZSB+MjAsMDAwL3MgdGhhdCB3b3VsZCByZXN1bHQgZnJvbSBhIHRpZ2h0IG9wZW5TeW5jIGxvb3AuXG4gKiAgICBBZnRlciBhIHN0YWxlLWxvY2sgZXZpY3Rpb24gKGxvY2sgYWxyZWFkeSByZW1vdmVkKSwgbm8gc2xlZXAgaXMgaW5qZWN0ZWRcbiAqICAgIFx1MjAxNCB3ZSByZXRyeSBpbW1lZGlhdGVseSB0byBjbG9zZSB0aGUgc2hvcnQgcmFjZSB3aW5kb3cuXG4gKlxuICogUmV0dXJucyB0cnVlIG9uIHN1Y2Nlc3MsIGZhbHNlIG9uIHRpbWVvdXQuXG4gKi9cbmZ1bmN0aW9uIGFjcXVpcmVMb2NrKGxvY2tQYXRoOiBzdHJpbmcsIHRpbWVvdXRNcyA9IDIwMDApOiBib29sZWFuIHtcbiAgY29uc3QgZGVhZGxpbmUgPSBEYXRlLm5vdygpICsgdGltZW91dE1zO1xuICB3aGlsZSAoRGF0ZS5ub3coKSA8IGRlYWRsaW5lKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGZkID0gb3BlblN5bmMobG9ja1BhdGgsIFwid3hcIik7IC8vIE9fV1JPTkxZIHwgT19DUkVBVCB8IE9fRVhDTFxuICAgICAgY2xvc2VTeW5jKGZkKTtcbiAgICAgIC8vIFdyaXRlIFBJRCBzdGFtcCBzbyBleHRlcm5hbCBtb25pdG9ycyBjYW4gaWRlbnRpZnkgdGhlIGxvY2sgb3duZXIuXG4gICAgICB0cnkge1xuICAgICAgICB3cml0ZUZpbGVTeW5jKGxvY2tQYXRoLCBgJHtwcm9jZXNzLnBpZH1cXG4ke25ldyBEYXRlKCkudG9JU09TdHJpbmcoKX1cXG5gLCBcInV0Zi04XCIpO1xuICAgICAgfSBjYXRjaCB7IC8qIG5vbi1mYXRhbCBcdTIwMTQgc3RhbXAgaXMgZGlhZ25vc3RpYyBvbmx5ICovIH1cbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gTG9jayBoZWxkIGJ5IGFub3RoZXIgcHJvY2VzcyBcdTIwMTQgY2hlY2sgZm9yIHN0YWxlbmVzcyBiZWZvcmUgcmV0cnlpbmcuXG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBzdCA9IHN0YXRTeW5jKGxvY2tQYXRoKTtcbiAgICAgICAgaWYgKERhdGUubm93KCkgLSBzdC5tdGltZU1zID4gU1RBTEVfTE9DS19USFJFU0hPTERfTVMpIHtcbiAgICAgICAgICBsb2dXYXJuaW5nKFxuICAgICAgICAgICAgXCJmc1wiLFxuICAgICAgICAgICAgYHN0YWxlIG1ldHJpY3MgbG9jayBhdCAke2xvY2tQYXRofSAoYWdlICR7RGF0ZS5ub3coKSAtIHN0Lm10aW1lTXN9bXMpOyBmb3JjaWJseSByZW1vdmluZyBhbmQgcmV0cnlpbmdgLFxuICAgICAgICAgICk7XG4gICAgICAgICAgdHJ5IHsgdW5saW5rU3luYyhsb2NrUGF0aCk7IH0gY2F0Y2ggeyAvKiBhbHJlYWR5IGdvbmUgKi8gfVxuICAgICAgICAgIC8vIERvIE5PVCBzbGVlcCBhZnRlciBzdGFsZS1sb2NrIGV2aWN0aW9uIFx1MjAxNCByZXRyeSB0aGUgb3BlblxuICAgICAgICAgIC8vIGltbWVkaWF0ZWx5LiBUaGUgbG9jayBmaWxlIHdhcyBqdXN0IHJlbW92ZWQ7IGEgc2hvcnQgcmFjZSB3aW5kb3dcbiAgICAgICAgICAvLyBleGlzdHMgYW5kIHNsZWVwaW5nIGhlcmUgd291bGQgdW5uZWNlc3NhcmlseSBkZWxheSByZWNvdmVyeS5cbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCB7IC8qIGxvY2sgZmlsZSBkaXNhcHBlYXJlZCBiZXR3ZWVuIHRoZSBmYWlsZWQgb3BlbiBhbmQgc3RhdCBcdTIwMTQgcmV0cnkgKi8gfVxuICAgICAgLy8gU2xlZXAgYmV0d2VlbiByZXRyaWVzIHRvIHlpZWxkIHRvIHRoZSBPUyBhbmQgY2FwIHN5c2NhbGwgcmF0ZS5cbiAgICAgIC8vIFVzZXMgQXRvbWljcy53YWl0IGZvciBhIHRydWUgYmxvY2tpbmcgc2xlZXAgKG5vIENQVSBzcGluKS5cbiAgICAgIF9sb2NrU2xlZXB5UmV0cmllcysrO1xuICAgICAgc3luY1NsZWVwKExPQ0tfUkVUUllfSU5URVJWQUxfTVMpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gZmFsc2U7XG59XG5cbmZ1bmN0aW9uIHJlbGVhc2VMb2NrKGxvY2tQYXRoOiBzdHJpbmcpOiB2b2lkIHtcbiAgdHJ5IHsgdW5saW5rU3luYyhsb2NrUGF0aCk7IH0gY2F0Y2ggeyAvKiBpZ25vcmUgKi8gfVxufVxuXG4vKipcbiAqIFNhdmUgdGhlIGxlZGdlciB3aXRoIGNyb3NzLXByb2Nlc3MgbWVyZ2Ugc2VtYW50aWNzLlxuICpcbiAqIEFjcXVpcmVzIGEgLmxvY2sgc2VudGluZWwgZmlsZSwgcmVhZHMgdGhlIGN1cnJlbnQgb24tZGlzayBsZWRnZXIsXG4gKiBtZXJnZXMgd29ya2VyIHVuaXRzIHdpdGggZXhpc3RpbmcgcGVlciB1bml0cyAod29ya2VyJ3MgZW50cnkgd2lucyBvblxuICogdHlwZStpZCtzdGFydGVkQXQgY29uZmxpY3Qgc2luY2UgaXQgaGFzIHRoZSBsYXRlc3QgZmluaXNoZWRBdCksXG4gKiB0aGVuIHdyaXRlcyBhdG9taWNhbGx5LiBUaGlzIHByZXZlbnRzIHBhcmFsbGVsIGF1dG8tbW9kZSB3b3JrZXJzIGZyb21cbiAqIHNpbGVudGx5IGRpc2NhcmRpbmcgZWFjaCBvdGhlcidzIG1ldHJpY3MgZW50cmllcy5cbiAqXG4gKiBGYWxscyBiYWNrIHRvIGEgZGlyZWN0IHdyaXRlIChubyBtZXJnZSkgaWYgdGhlIGxvY2sgY2Fubm90IGJlIGFjcXVpcmVkXG4gKiB3aXRoaW4gdGhlIHRpbWVvdXQgXHUyMDE0IGJldHRlciB0byBwb3RlbnRpYWxseSBvdmVyd3JpdGUgdGhhbiB0byBsb3NlIGRhdGFcbiAqIGVudGlyZWx5LlxuICovXG5mdW5jdGlvbiBzYXZlTGVkZ2VyKGJhc2U6IHN0cmluZywgZGF0YTogTWV0cmljc0xlZGdlcik6IHZvaWQge1xuICBjb25zdCBwYXRoID0gbWV0cmljc1BhdGgoYmFzZSk7XG4gIGNvbnN0IGxvY2tQYXRoID0gYCR7cGF0aH0ubG9ja2A7XG4gIGNvbnN0IGFjcXVpcmVkID0gYWNxdWlyZUxvY2sobG9ja1BhdGgpO1xuICBpZiAoYWNxdWlyZWQpIHtcbiAgICB0cnkge1xuICAgICAgLy8gUmVhZCBjdXJyZW50IG9uLWRpc2sgc3RhdGUgYW5kIG1lcmdlIHdpdGggd29ya2VyJ3MgaW4tbWVtb3J5IHVuaXRzLlxuICAgICAgLy8gV29ya2VyIHVuaXRzIHRha2UgcHJlY2VkZW5jZSBvbiBjb25mbGljdCAoYnkgZmluaXNoZWRBdCBpbiBkZWR1cGxpY2F0ZVVuaXRzKS5cbiAgICAgIGNvbnN0IG9uRGlzayA9IGxvYWRKc29uRmlsZU9yTnVsbChwYXRoLCBpc01ldHJpY3NMZWRnZXIpO1xuICAgICAgaWYgKG9uRGlzayAmJiBvbkRpc2sudW5pdHMubGVuZ3RoID4gMCkge1xuICAgICAgICBjb25zdCBtZXJnZWQgPSBkZWR1cGxpY2F0ZVVuaXRzKFsuLi5vbkRpc2sudW5pdHMsIC4uLmRhdGEudW5pdHNdKTtcbiAgICAgICAgc2F2ZUpzb25GaWxlKHBhdGgsIHsgLi4uZGF0YSwgdW5pdHM6IG1lcmdlZCB9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHNhdmVKc29uRmlsZShwYXRoLCBkYXRhKTtcbiAgICAgIH1cbiAgICB9IGZpbmFsbHkge1xuICAgICAgcmVsZWFzZUxvY2sobG9ja1BhdGgpO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICAvLyBMb2NrIGNvdWxkIG5vdCBiZSBhY3F1aXJlZCB3aXRoaW4gdGhlIHRpbWVvdXQuIEZhbGwgYmFjayB0byBhIGRpcmVjdFxuICAgIC8vIHdyaXRlIChubyBjcm9zcy1wcm9jZXNzIG1lcmdlKSB0byBhdm9pZCBsb3NpbmcgdGhpcyB3b3JrZXIncyBkYXRhXG4gICAgLy8gZW50aXJlbHkuIEEgY29uY3VycmVudCB3cml0ZXIgbWF5IG92ZXJ3cml0ZSB1cywgYnV0IHRoYXQgaXMgcHJlZmVyYWJsZVxuICAgIC8vIHRvIGEgdG9ybiB3cml0ZSBjYXVzZWQgYnkgdHdvIHdyaXRlcnMgc2ltdWx0YW5lb3VzbHkgZXhlY3V0aW5nIHRoZVxuICAgIC8vIHJlYWQtbWVyZ2Utd3JpdGUgc2VxdWVuY2Ugd2l0aG91dCBtdXR1YWwgZXhjbHVzaW9uLlxuICAgIGxvZ1dhcm5pbmcoXCJmc1wiLCBcInNhdmVMZWRnZXI6IGxvY2sgbm90IGFjcXVpcmVkIFx1MjAxNCBmYWxsaW5nIGJhY2sgdG8gZGlyZWN0IHdyaXRlIChubyBtZXJnZSlcIik7XG4gICAgc2F2ZUpzb25GaWxlKHBhdGgsIGRhdGEpO1xuICB9XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFnQkEsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsVUFBVSxXQUFXLFlBQVksVUFBVSxxQkFBcUI7QUFFekUsU0FBUyxlQUFlO0FBQ3hCLFNBQVMseUJBQXlCO0FBQ2xDLFNBQVMsY0FBYyxvQkFBb0Isb0JBQW9CO0FBQy9ELFNBQVMsbUJBQW1CO0FBQzVCLFNBQVMsb0JBQW9CLHlCQUF5QjtBQUN0RCxTQUFTLDZCQUE2QjtBQUV0QyxTQUFTLGtCQUFrQjtBQUszQixTQUFTLHdCQUF3QjtBQXVEMUIsU0FBUyxrQkFBa0IsVUFBZ0M7QUFDaEUsVUFBUSxVQUFVO0FBQUEsSUFDaEIsS0FBSztBQUFBLElBQ0wsS0FBSztBQUNILGFBQU87QUFBQSxJQUNULEtBQUs7QUFBQSxJQUNMLEtBQUs7QUFDSCxhQUFPO0FBQUEsSUFDVCxLQUFLO0FBQUEsSUFDTCxLQUFLO0FBQUEsSUFDTCxLQUFLO0FBQ0gsYUFBTztBQUFBLElBQ1QsS0FBSztBQUNILGFBQU87QUFBQSxJQUNULEtBQUs7QUFDSCxhQUFPO0FBQUEsSUFDVCxLQUFLO0FBQ0gsYUFBTztBQUFBLElBQ1Q7QUFDRSxhQUFPO0FBQUEsRUFDWDtBQUNGO0FBSUEsSUFBSSxTQUErQjtBQUNuQyxJQUFJLFdBQW1CO0FBSXZCLE1BQU0sZ0JBQWdCLG9CQUFJLElB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
