import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { deriveState } from "./state.js";
import { parseSummary, loadFile } from "./files.js";
import { isDbAvailable, getMilestoneSlices, getSliceTasks } from "./gsd-db.js";
import { parseRoadmap, parsePlan } from "./parsers-legacy.js";
import { findMilestoneIds } from "./milestone-ids.js";
import { resolveMilestoneFile, resolveSliceFile, resolveGsdRootFile, gsdRoot } from "./paths.js";
import {
  getLedger,
  getProjectTotals,
  aggregateByPhase,
  aggregateBySlice,
  aggregateByModel,
  aggregateByTier,
  formatTierSavings,
  loadLedgerFromDisk
} from "./metrics.js";
import { loadAllCaptures, countPendingCaptures } from "./captures.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { runProviderChecks } from "./doctor-providers.js";
import { generateSkillHealthReport } from "./skill-health.js";
import { runEnvironmentChecks } from "./doctor-environment.js";
import { computeProgressScore } from "./progress-score.js";
import { getHealthHistory } from "./doctor-proactive.js";
function computeCriticalPath(milestones) {
  const empty = {
    milestonePath: [],
    slicePath: [],
    milestoneSlack: /* @__PURE__ */ new Map(),
    sliceSlack: /* @__PURE__ */ new Map()
  };
  if (milestones.length === 0) return empty;
  const msMap = new Map(milestones.map((m) => [m.id, m]));
  const msIds = milestones.map((m) => m.id);
  const msAdj = /* @__PURE__ */ new Map();
  const msWeight = /* @__PURE__ */ new Map();
  for (const ms of milestones) {
    msAdj.set(ms.id, []);
    const incomplete = ms.slices.filter((s) => !s.done).length;
    msWeight.set(ms.id, ms.status === "complete" ? 0 : Math.max(1, incomplete));
  }
  for (const ms of milestones) {
    for (const dep of ms.dependsOn) {
      if (msMap.has(dep)) {
        const adj = msAdj.get(dep);
        if (adj) adj.push(ms.id);
      }
    }
  }
  const inDegree = /* @__PURE__ */ new Map();
  for (const id of msIds) inDegree.set(id, 0);
  for (const ms of milestones) {
    for (const dep of ms.dependsOn) {
      if (msMap.has(dep)) inDegree.set(ms.id, (inDegree.get(ms.id) ?? 0) + 1);
    }
  }
  const queue = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }
  const topoOrder = [];
  while (queue.length > 0) {
    const node = queue.shift();
    topoOrder.push(node);
    for (const next of msAdj.get(node) ?? []) {
      const d = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  const dist = /* @__PURE__ */ new Map();
  const prev = /* @__PURE__ */ new Map();
  for (const id of msIds) {
    dist.set(id, 0);
    prev.set(id, null);
  }
  for (const node of topoOrder) {
    const w = msWeight.get(node) ?? 1;
    const nodeDist = dist.get(node) + w;
    for (const next of msAdj.get(node) ?? []) {
      if (nodeDist > dist.get(next)) {
        dist.set(next, nodeDist);
        prev.set(next, node);
      }
    }
  }
  let maxDist = 0;
  let endNode = msIds[0];
  for (const id of msIds) {
    const totalDist = dist.get(id) + (msWeight.get(id) ?? 1);
    if (totalDist > maxDist) {
      maxDist = totalDist;
      endNode = id;
    }
  }
  const milestonePath = [];
  let cur = endNode;
  while (cur !== null) {
    milestonePath.unshift(cur);
    cur = prev.get(cur) ?? null;
  }
  const milestoneSlack = /* @__PURE__ */ new Map();
  const criticalSet = new Set(milestonePath);
  for (const id of msIds) {
    if (criticalSet.has(id)) {
      milestoneSlack.set(id, 0);
    } else {
      const nodeTotal = dist.get(id) + (msWeight.get(id) ?? 1);
      milestoneSlack.set(id, Math.max(0, maxDist - nodeTotal));
    }
  }
  const activeMs = milestones.find((m) => m.status === "active");
  let slicePath = [];
  const sliceSlack = /* @__PURE__ */ new Map();
  if (activeMs && activeMs.slices.length > 0) {
    const slMap = new Map(activeMs.slices.map((s) => [s.id, s]));
    const slAdj = /* @__PURE__ */ new Map();
    for (const s of activeMs.slices) slAdj.set(s.id, []);
    for (const s of activeMs.slices) {
      for (const dep of s.depends) {
        if (slMap.has(dep)) {
          const adj = slAdj.get(dep);
          if (adj) adj.push(s.id);
        }
      }
    }
    const slIn = /* @__PURE__ */ new Map();
    for (const s of activeMs.slices) slIn.set(s.id, 0);
    for (const s of activeMs.slices) {
      for (const dep of s.depends) {
        if (slMap.has(dep)) slIn.set(s.id, (slIn.get(s.id) ?? 0) + 1);
      }
    }
    const slQueue = [];
    for (const [id, d] of slIn) {
      if (d === 0) slQueue.push(id);
    }
    const slTopo = [];
    while (slQueue.length > 0) {
      const n = slQueue.shift();
      slTopo.push(n);
      for (const next of slAdj.get(n) ?? []) {
        const d = (slIn.get(next) ?? 1) - 1;
        slIn.set(next, d);
        if (d === 0) slQueue.push(next);
      }
    }
    const slDist = /* @__PURE__ */ new Map();
    const slPrev = /* @__PURE__ */ new Map();
    for (const s of activeMs.slices) {
      const w = s.done ? 0 : 1;
      slDist.set(s.id, 0);
      slPrev.set(s.id, null);
    }
    for (const n of slTopo) {
      const w = slMap.get(n)?.done ? 0 : 1;
      const nd = slDist.get(n) + w;
      for (const next of slAdj.get(n) ?? []) {
        if (nd > slDist.get(next)) {
          slDist.set(next, nd);
          slPrev.set(next, n);
        }
      }
    }
    let slMax = 0;
    let slEnd = activeMs.slices[0].id;
    for (const s of activeMs.slices) {
      const totalDist = slDist.get(s.id) + (s.done ? 0 : 1);
      if (totalDist > slMax) {
        slMax = totalDist;
        slEnd = s.id;
      }
    }
    let slCur = slEnd;
    while (slCur !== null) {
      slicePath.unshift(slCur);
      slCur = slPrev.get(slCur) ?? null;
    }
    const slCritSet = new Set(slicePath);
    for (const s of activeMs.slices) {
      if (slCritSet.has(s.id)) {
        sliceSlack.set(s.id, 0);
      } else {
        const nodeTotal = slDist.get(s.id) + (s.done ? 0 : 1);
        sliceSlack.set(s.id, Math.max(0, slMax - nodeTotal));
      }
    }
  }
  return { milestonePath, slicePath, milestoneSlack, sliceSlack };
}
function loadAgentActivity(units, milestones) {
  if (units.length === 0) return null;
  const running = units.find((u) => u.finishedAt === 0);
  const now = Date.now();
  const completedUnits = units.filter((u) => u.finishedAt > 0).length;
  const totalSlices = milestones.reduce((sum, m) => sum + m.slices.length, 0);
  const finished = units.filter((u) => u.finishedAt > 0);
  let completionRate = 0;
  if (finished.length >= 2) {
    const earliest = Math.min(...finished.map((u) => u.startedAt));
    const latest = Math.max(...finished.map((u) => u.finishedAt));
    const totalHours = (latest - earliest) / 36e5;
    completionRate = totalHours > 0 ? finished.length / totalHours : 0;
  }
  const sessionCost = units.reduce((sum, u) => sum + u.cost, 0);
  const sessionTokens = units.reduce((sum, u) => sum + u.tokens.total, 0);
  return {
    currentUnit: running ? { type: running.type, id: running.id, startedAt: running.startedAt } : null,
    elapsed: running ? now - running.startedAt : 0,
    completedUnits,
    totalSlices,
    completionRate,
    active: !!running,
    sessionCost,
    sessionTokens
  };
}
const changelogCache = /* @__PURE__ */ new Map();
async function loadChangelogAndVerifications(basePath, milestones) {
  const entries = [];
  const verifications = [];
  for (const ms of milestones) {
    for (const sl of ms.slices) {
      if (!sl.done) continue;
      const summaryFile = resolveSliceFile(basePath, ms.id, sl.id, "SUMMARY");
      if (!summaryFile) continue;
      const cacheKey = `${ms.id}/${sl.id}`;
      const cached = changelogCache.get(cacheKey);
      let mtime = 0;
      try {
        mtime = statSync(summaryFile).mtimeMs;
      } catch {
        continue;
      }
      if (cached && cached.mtime === mtime) {
        entries.push(cached.entry);
        verifications.push(cached.verification);
        continue;
      }
      const content = await loadFile(summaryFile);
      if (!content) continue;
      const summary = parseSummary(content);
      const entry = {
        milestoneId: ms.id,
        sliceId: sl.id,
        title: sl.title,
        oneLiner: summary.oneLiner,
        filesModified: summary.filesModified.map((f) => ({
          path: f.path,
          description: f.description
        })),
        completedAt: String(summary.frontmatter.completed_at ?? "")
      };
      const verification = {
        milestoneId: ms.id,
        sliceId: sl.id,
        verificationResult: summary.frontmatter.verification_result || "",
        blockerDiscovered: summary.frontmatter.blocker_discovered,
        keyDecisions: summary.frontmatter.key_decisions || [],
        patternsEstablished: summary.frontmatter.patterns_established || [],
        provides: summary.frontmatter.provides || [],
        requires: (summary.frontmatter.requires || []).map((r) => ({
          slice: r.slice,
          provides: r.provides
        }))
      };
      changelogCache.set(cacheKey, { mtime, entry, verification });
      entries.push(entry);
      verifications.push(verification);
    }
  }
  entries.sort((a, b) => String(b.completedAt || "").localeCompare(String(a.completedAt || "")));
  return { changelog: { entries }, verifications };
}
function loadKnowledge(basePath) {
  const knowledgePath = resolveGsdRootFile(basePath, "KNOWLEDGE");
  if (!existsSync(knowledgePath)) {
    return { rules: [], patterns: [], lessons: [], exists: false };
  }
  let content;
  try {
    content = readFileSync(knowledgePath, "utf-8");
  } catch {
    return { rules: [], patterns: [], lessons: [], exists: false };
  }
  const rules = [];
  const patterns = [];
  const lessons = [];
  const lines = content.split("\n");
  let currentSection = "";
  for (const line of lines) {
    if (line.startsWith("## Rules")) {
      currentSection = "rules";
      continue;
    }
    if (line.startsWith("## Patterns")) {
      currentSection = "patterns";
      continue;
    }
    if (line.startsWith("## Lessons")) {
      currentSection = "lessons";
      continue;
    }
    if (line.startsWith("## ")) {
      currentSection = "";
      continue;
    }
    if (!line.startsWith("| ") || line.startsWith("| ---") || line.startsWith("| ID")) continue;
    const cols = line.split("|").map((c) => c.trim()).filter((c) => c.length > 0);
    if (cols.length < 2) continue;
    if (currentSection === "rules" && cols.length >= 3) {
      rules.push({ id: cols[0], scope: cols[1], content: cols[2] });
    } else if (currentSection === "patterns" && cols.length >= 2) {
      patterns.push({ id: cols[0], content: cols[1] });
    } else if (currentSection === "lessons" && cols.length >= 2) {
      lessons.push({ id: cols[0], content: cols[1] });
    }
  }
  return { rules, patterns, lessons, exists: true };
}
function loadHealth(units, totals, basePath) {
  const prefs = loadEffectiveGSDPreferences();
  const budgetCeiling = prefs?.preferences?.budget_ceiling;
  const tokenProfile = prefs?.preferences?.token_profile ?? "standard";
  let truncationRate = 0;
  let continueHereRate = 0;
  if (totals && totals.units > 0) {
    truncationRate = totals.totalTruncationSections / totals.units * 100;
    continueHereRate = totals.continueHereFiredCount / totals.units * 100;
  }
  const tierBreakdown = aggregateByTier(units);
  const tierSavingsLine = formatTierSavings(units);
  let providers = [];
  try {
    providers = runProviderChecks().map((r) => ({
      name: r.name,
      label: r.label,
      category: r.category,
      ok: r.status === "ok" || r.status === "unconfigured",
      required: r.required,
      message: r.message
    }));
  } catch {
  }
  let skillSummary = { total: 0, warningCount: 0, criticalCount: 0, topIssue: null };
  try {
    const report = generateSkillHealthReport(basePath);
    const warnings = report.suggestions.filter((s) => s.severity === "warning");
    const criticals = report.suggestions.filter((s) => s.severity === "critical");
    skillSummary = {
      total: report.skills.length,
      warningCount: warnings.length,
      criticalCount: criticals.length,
      topIssue: report.suggestions[0]?.message ?? null
    };
  } catch {
  }
  let environmentIssues = [];
  try {
    environmentIssues = runEnvironmentChecks(basePath).filter((r) => r.status !== "ok");
  } catch {
  }
  let doctorHistory = [];
  try {
    const historyPath = join(gsdRoot(basePath), "doctor-history.jsonl");
    if (existsSync(historyPath)) {
      const lines = readFileSync(historyPath, "utf-8").split("\n").filter((l) => l.trim());
      doctorHistory = lines.slice(-20).reverse().map((l) => JSON.parse(l));
    }
  } catch {
  }
  let progressScore = null;
  try {
    const history = getHealthHistory();
    if (history.length > 0) {
      const score = computeProgressScore();
      progressScore = { level: score.level, summary: score.summary, signals: score.signals };
    }
  } catch {
  }
  return {
    budgetCeiling,
    tokenProfile,
    truncationRate,
    continueHereRate,
    tierBreakdown,
    tierSavingsLine,
    toolCalls: totals?.toolCalls ?? 0,
    assistantMessages: totals?.assistantMessages ?? 0,
    userMessages: totals?.userMessages ?? 0,
    providers,
    skillSummary,
    environmentIssues,
    doctorHistory,
    progressScore
  };
}
const RECENT_ENTRY_LIMIT = 3;
const FEATURE_PREVIEW_LIMIT = 5;
const UPDATED_WINDOW_MS = 7 * 24 * 60 * 60 * 1e3;
function buildVisualizerStats(milestones, entries) {
  const missing = [];
  for (const ms of milestones) {
    for (const sl of ms.slices) {
      if (!sl.done) missing.push({ milestoneId: ms.id, sliceId: sl.id, title: sl.title });
    }
  }
  const missingCount = missing.length;
  const missingSlices = missing.slice(0, FEATURE_PREVIEW_LIMIT);
  const now = Date.now();
  const updatedEntries = entries.filter((entry) => {
    if (!entry.completedAt) return false;
    const parsed = Date.parse(entry.completedAt);
    return !Number.isNaN(parsed) && now - parsed <= UPDATED_WINDOW_MS;
  });
  const updatedCount = updatedEntries.length;
  const updatedSlices = updatedEntries.slice(0, FEATURE_PREVIEW_LIMIT).map((entry) => ({
    milestoneId: entry.milestoneId,
    sliceId: entry.sliceId,
    title: entry.title,
    completedAt: entry.completedAt
  }));
  const recentEntries = entries.slice(0, RECENT_ENTRY_LIMIT);
  return {
    missingCount,
    missingSlices,
    updatedCount,
    updatedSlices,
    recentEntries
  };
}
function loadDiscussionState(basePath, milestones) {
  const states = [];
  for (const ms of milestones) {
    const contextPath = resolveMilestoneFile(basePath, ms.id, "CONTEXT");
    const draftPath = resolveMilestoneFile(basePath, ms.id, "CONTEXT-DRAFT");
    const state = contextPath ? "discussed" : draftPath ? "draft" : "undiscussed";
    let lastUpdated = null;
    const target = contextPath ?? draftPath;
    if (target) {
      try {
        lastUpdated = new Date(statSync(target).mtimeMs).toISOString();
      } catch {
        lastUpdated = null;
      }
    }
    states.push({
      milestoneId: ms.id,
      title: ms.title,
      state,
      hasContext: !!contextPath,
      hasDraft: !!draftPath,
      lastUpdated
    });
  }
  return states;
}
const fileContentCache = /* @__PURE__ */ new Map();
function readFileCached(filePath) {
  try {
    const mtime = statSync(filePath).mtimeMs;
    const cached = fileContentCache.get(filePath);
    if (cached && cached.mtime === mtime) {
      return cached.content;
    }
    const content = readFileSync(filePath, "utf-8");
    fileContentCache.set(filePath, { mtime, content });
    return content;
  } catch {
    return null;
  }
}
async function loadVisualizerData(basePath) {
  const state = await deriveState(basePath);
  const milestoneIds = findMilestoneIds(basePath);
  const milestones = [];
  for (const mid of milestoneIds) {
    const entry = state.registry.find((r) => r.id === mid);
    const status = entry?.status ?? "pending";
    const dependsOn = entry?.dependsOn ?? [];
    const slices = [];
    const roadmapFile = resolveMilestoneFile(basePath, mid, "ROADMAP");
    const roadmapContent = roadmapFile ? readFileCached(roadmapFile) : null;
    if (roadmapContent || isDbAvailable()) {
      let normSlices = null;
      if (isDbAvailable()) {
        const dbSlices = getMilestoneSlices(mid);
        if (dbSlices.length > 0) {
          normSlices = dbSlices.map((s) => ({ id: s.id, done: s.status === "complete", title: s.title, risk: s.risk || "medium", depends: s.depends, demo: s.demo }));
        }
      }
      if (!normSlices && roadmapContent) {
        const parsed = parseRoadmap(roadmapContent);
        normSlices = parsed.slices.map((s) => ({ id: s.id, done: s.done, title: s.title, risk: s.risk || "medium", depends: s.depends, demo: "" }));
      }
      if (!normSlices) normSlices = [];
      for (const s of normSlices) {
        const isActiveSlice = state.activeMilestone?.id === mid && state.activeSlice?.id === s.id;
        const tasks = [];
        if (isActiveSlice) {
          let usedDbTasks = false;
          if (isDbAvailable()) {
            const dbTasks = getSliceTasks(mid, s.id);
            if (dbTasks.length > 0) {
              usedDbTasks = true;
              for (const t of dbTasks) {
                tasks.push({
                  id: t.id,
                  title: t.title,
                  done: t.status === "complete" || t.status === "done",
                  active: state.activeTask?.id === t.id,
                  estimate: t.estimate || void 0
                });
              }
            }
          }
          if (!usedDbTasks) {
            const slicePlanFile = resolveSliceFile(basePath, mid, s.id, "PLAN");
            if (slicePlanFile) {
              const planContent = readFileCached(slicePlanFile);
              if (planContent) {
                const parsed = parsePlan(planContent);
                for (const t of parsed.tasks) {
                  tasks.push({
                    id: t.id,
                    title: t.title,
                    done: t.done,
                    active: state.activeTask?.id === t.id,
                    estimate: t.estimate || void 0
                  });
                }
              }
            }
          }
        }
        slices.push({
          id: s.id,
          title: s.title,
          done: s.done,
          active: isActiveSlice,
          risk: s.risk,
          depends: s.depends,
          tasks
        });
      }
    }
    milestones.push({
      id: mid,
      title: entry?.title ?? mid,
      status,
      dependsOn,
      slices
    });
  }
  let totals = null;
  let byPhase = [];
  let bySlice = [];
  let byModel = [];
  let byTier = [];
  let tierSavingsLine = "";
  let units = [];
  const ledger = getLedger() ?? loadLedgerFromDisk(basePath);
  if (ledger && ledger.units.length > 0) {
    units = [...ledger.units].sort((a, b) => a.startedAt - b.startedAt);
    totals = getProjectTotals(units);
    byPhase = aggregateByPhase(units);
    bySlice = aggregateBySlice(units);
    byModel = aggregateByModel(units);
    byTier = aggregateByTier(units);
    tierSavingsLine = formatTierSavings(units);
  }
  const criticalPath = computeCriticalPath(milestones);
  let remainingSliceCount = 0;
  for (const ms of milestones) {
    for (const sl of ms.slices) {
      if (!sl.done) remainingSliceCount++;
    }
  }
  const agentActivity = loadAgentActivity(units, milestones);
  const { changelog, verifications: sliceVerifications } = await loadChangelogAndVerifications(basePath, milestones);
  const knowledge = loadKnowledge(basePath);
  const allCaptures = loadAllCaptures(basePath);
  const pendingCount = countPendingCaptures(basePath);
  const captures = {
    entries: allCaptures,
    pendingCount,
    totalCount: allCaptures.length
  };
  const health = loadHealth(units, totals, basePath);
  const stats = buildVisualizerStats(milestones, changelog.entries);
  const discussion = loadDiscussionState(basePath, milestones);
  return {
    milestones,
    phase: state.phase,
    totals,
    byPhase,
    bySlice,
    byModel,
    byTier,
    tierSavingsLine,
    units,
    criticalPath,
    remainingSliceCount,
    agentActivity,
    changelog,
    sliceVerifications,
    knowledge,
    captures,
    health,
    discussion,
    stats
  };
}
export {
  computeCriticalPath,
  loadVisualizerData
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC92aXN1YWxpemVyLWRhdGEudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIERhdGEgbG9hZGVyIGZvciB3b3JrZmxvdyB2aXN1YWxpemVyIG92ZXJsYXkgXHUyMDE0IGFnZ3JlZ2F0ZXMgc3RhdGUgKyBtZXRyaWNzLlxuXG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkRmlsZVN5bmMsIHN0YXRTeW5jIH0gZnJvbSAnbm9kZTpmcyc7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJztcbmltcG9ydCB7IGRlcml2ZVN0YXRlIH0gZnJvbSAnLi9zdGF0ZS5qcyc7XG5pbXBvcnQgeyBwYXJzZVN1bW1hcnksIGxvYWRGaWxlIH0gZnJvbSAnLi9maWxlcy5qcyc7XG5pbXBvcnQgeyBpc0RiQXZhaWxhYmxlLCBnZXRNaWxlc3RvbmVTbGljZXMsIGdldFNsaWNlVGFza3MgfSBmcm9tICcuL2dzZC1kYi5qcyc7XG5pbXBvcnQgeyBwYXJzZVJvYWRtYXAsIHBhcnNlUGxhbiB9IGZyb20gJy4vcGFyc2Vycy1sZWdhY3kuanMnO1xuaW1wb3J0IHsgZmluZE1pbGVzdG9uZUlkcyB9IGZyb20gJy4vbWlsZXN0b25lLWlkcy5qcyc7XG5pbXBvcnQgeyByZXNvbHZlTWlsZXN0b25lRmlsZSwgcmVzb2x2ZVNsaWNlRmlsZSwgcmVzb2x2ZUdzZFJvb3RGaWxlLCBnc2RSb290IH0gZnJvbSAnLi9wYXRocy5qcyc7XG5pbXBvcnQge1xuICBnZXRMZWRnZXIsXG4gIGdldFByb2plY3RUb3RhbHMsXG4gIGFnZ3JlZ2F0ZUJ5UGhhc2UsXG4gIGFnZ3JlZ2F0ZUJ5U2xpY2UsXG4gIGFnZ3JlZ2F0ZUJ5TW9kZWwsXG4gIGFnZ3JlZ2F0ZUJ5VGllcixcbiAgZm9ybWF0VGllclNhdmluZ3MsXG4gIGxvYWRMZWRnZXJGcm9tRGlzayxcbiAgY2xhc3NpZnlVbml0UGhhc2UsXG59IGZyb20gJy4vbWV0cmljcy5qcyc7XG5pbXBvcnQgeyBsb2FkQWxsQ2FwdHVyZXMsIGNvdW50UGVuZGluZ0NhcHR1cmVzIH0gZnJvbSAnLi9jYXB0dXJlcy5qcyc7XG5pbXBvcnQgeyBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMgfSBmcm9tICcuL3ByZWZlcmVuY2VzLmpzJztcbmltcG9ydCB7IHJ1blByb3ZpZGVyQ2hlY2tzLCB0eXBlIFByb3ZpZGVyQ2hlY2tSZXN1bHQgfSBmcm9tICcuL2RvY3Rvci1wcm92aWRlcnMuanMnO1xuaW1wb3J0IHsgZ2VuZXJhdGVTa2lsbEhlYWx0aFJlcG9ydCB9IGZyb20gJy4vc2tpbGwtaGVhbHRoLmpzJztcbmltcG9ydCB7IHJ1bkVudmlyb25tZW50Q2hlY2tzLCB0eXBlIEVudmlyb25tZW50Q2hlY2tSZXN1bHQgfSBmcm9tICcuL2RvY3Rvci1lbnZpcm9ubWVudC5qcyc7XG5pbXBvcnQgeyBjb21wdXRlUHJvZ3Jlc3NTY29yZSB9IGZyb20gJy4vcHJvZ3Jlc3Mtc2NvcmUuanMnO1xuaW1wb3J0IHsgZ2V0SGVhbHRoSGlzdG9yeSB9IGZyb20gJy4vZG9jdG9yLXByb2FjdGl2ZS5qcyc7XG5cbmltcG9ydCB0eXBlIHsgUGhhc2UgfSBmcm9tICcuL3R5cGVzLmpzJztcbmltcG9ydCB0eXBlIHsgQ2FwdHVyZUVudHJ5IH0gZnJvbSAnLi9jYXB0dXJlcy5qcyc7XG5pbXBvcnQgdHlwZSB7XG4gIFByb2plY3RUb3RhbHMsXG4gIFBoYXNlQWdncmVnYXRlLFxuICBTbGljZUFnZ3JlZ2F0ZSxcbiAgTW9kZWxBZ2dyZWdhdGUsXG4gIFRpZXJBZ2dyZWdhdGUsXG4gIFVuaXRNZXRyaWNzLFxufSBmcm9tICcuL21ldHJpY3MuanMnO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVmlzdWFsaXplciBUeXBlcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGludGVyZmFjZSBWaXN1YWxpemVyTWlsZXN0b25lIHtcbiAgaWQ6IHN0cmluZztcbiAgdGl0bGU6IHN0cmluZztcbiAgc3RhdHVzOiAnY29tcGxldGUnIHwgJ2FjdGl2ZScgfCAncGVuZGluZycgfCAncGFya2VkJztcbiAgZGVwZW5kc09uOiBzdHJpbmdbXTtcbiAgc2xpY2VzOiBWaXN1YWxpemVyU2xpY2VbXTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBWaXN1YWxpemVyU2xpY2Uge1xuICBpZDogc3RyaW5nO1xuICB0aXRsZTogc3RyaW5nO1xuICBkb25lOiBib29sZWFuO1xuICBhY3RpdmU6IGJvb2xlYW47XG4gIHJpc2s6IHN0cmluZztcbiAgZGVwZW5kczogc3RyaW5nW107XG4gIHRhc2tzOiBWaXN1YWxpemVyVGFza1tdO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFZpc3VhbGl6ZXJUYXNrIHtcbiAgaWQ6IHN0cmluZztcbiAgdGl0bGU6IHN0cmluZztcbiAgZG9uZTogYm9vbGVhbjtcbiAgYWN0aXZlOiBib29sZWFuO1xuICBlc3RpbWF0ZT86IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDcml0aWNhbFBhdGhJbmZvIHtcbiAgbWlsZXN0b25lUGF0aDogc3RyaW5nW107XG4gIHNsaWNlUGF0aDogc3RyaW5nW107XG4gIG1pbGVzdG9uZVNsYWNrOiBNYXA8c3RyaW5nLCBudW1iZXI+O1xuICBzbGljZVNsYWNrOiBNYXA8c3RyaW5nLCBudW1iZXI+O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEFnZW50QWN0aXZpdHlJbmZvIHtcbiAgY3VycmVudFVuaXQ6IHsgdHlwZTogc3RyaW5nOyBpZDogc3RyaW5nOyBzdGFydGVkQXQ6IG51bWJlciB9IHwgbnVsbDtcbiAgZWxhcHNlZDogbnVtYmVyO1xuICBjb21wbGV0ZWRVbml0czogbnVtYmVyO1xuICB0b3RhbFNsaWNlczogbnVtYmVyO1xuICBjb21wbGV0aW9uUmF0ZTogbnVtYmVyO1xuICBhY3RpdmU6IGJvb2xlYW47XG4gIHNlc3Npb25Db3N0OiBudW1iZXI7XG4gIHNlc3Npb25Ub2tlbnM6IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDaGFuZ2Vsb2dFbnRyeSB7XG4gIG1pbGVzdG9uZUlkOiBzdHJpbmc7XG4gIHNsaWNlSWQ6IHN0cmluZztcbiAgdGl0bGU6IHN0cmluZztcbiAgb25lTGluZXI6IHN0cmluZztcbiAgZmlsZXNNb2RpZmllZDogeyBwYXRoOiBzdHJpbmc7IGRlc2NyaXB0aW9uOiBzdHJpbmcgfVtdO1xuICBjb21wbGV0ZWRBdDogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIENoYW5nZWxvZ0luZm8ge1xuICBlbnRyaWVzOiBDaGFuZ2Vsb2dFbnRyeVtdO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFZpc3VhbGl6ZXJTbGljZVJlZiB7XG4gIG1pbGVzdG9uZUlkOiBzdHJpbmc7XG4gIHNsaWNlSWQ6IHN0cmluZztcbiAgdGl0bGU6IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBWaXN1YWxpemVyU2xpY2VBY3Rpdml0eSBleHRlbmRzIFZpc3VhbGl6ZXJTbGljZVJlZiB7XG4gIGNvbXBsZXRlZEF0OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgVmlzdWFsaXplclN0YXRzIHtcbiAgbWlzc2luZ0NvdW50OiBudW1iZXI7XG4gIG1pc3NpbmdTbGljZXM6IFZpc3VhbGl6ZXJTbGljZVJlZltdO1xuICB1cGRhdGVkQ291bnQ6IG51bWJlcjtcbiAgdXBkYXRlZFNsaWNlczogVmlzdWFsaXplclNsaWNlQWN0aXZpdHlbXTtcbiAgcmVjZW50RW50cmllczogQ2hhbmdlbG9nRW50cnlbXTtcbn1cblxuZXhwb3J0IHR5cGUgRGlzY3Vzc2lvblN0YXRlID0gJ3VuZGlzY3Vzc2VkJyB8ICdkcmFmdCcgfCAnZGlzY3Vzc2VkJztcblxuZXhwb3J0IGludGVyZmFjZSBWaXN1YWxpemVyRGlzY3Vzc2lvblN0YXRlIHtcbiAgbWlsZXN0b25lSWQ6IHN0cmluZztcbiAgdGl0bGU6IHN0cmluZztcbiAgc3RhdGU6IERpc2N1c3Npb25TdGF0ZTtcbiAgaGFzQ29udGV4dDogYm9vbGVhbjtcbiAgaGFzRHJhZnQ6IGJvb2xlYW47XG4gIGxhc3RVcGRhdGVkOiBzdHJpbmcgfCBudWxsO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFNsaWNlVmVyaWZpY2F0aW9uIHtcbiAgbWlsZXN0b25lSWQ6IHN0cmluZztcbiAgc2xpY2VJZDogc3RyaW5nO1xuICB2ZXJpZmljYXRpb25SZXN1bHQ6IHN0cmluZztcbiAgYmxvY2tlckRpc2NvdmVyZWQ6IGJvb2xlYW47XG4gIGtleURlY2lzaW9uczogc3RyaW5nW107XG4gIHBhdHRlcm5zRXN0YWJsaXNoZWQ6IHN0cmluZ1tdO1xuICBwcm92aWRlczogc3RyaW5nW107XG4gIHJlcXVpcmVzOiB7IHNsaWNlOiBzdHJpbmc7IHByb3ZpZGVzOiBzdHJpbmcgfVtdO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEtub3dsZWRnZUluZm8ge1xuICBydWxlczogeyBpZDogc3RyaW5nOyBzY29wZTogc3RyaW5nOyBjb250ZW50OiBzdHJpbmcgfVtdO1xuICBwYXR0ZXJuczogeyBpZDogc3RyaW5nOyBjb250ZW50OiBzdHJpbmcgfVtdO1xuICBsZXNzb25zOiB7IGlkOiBzdHJpbmc7IGNvbnRlbnQ6IHN0cmluZyB9W107XG4gIGV4aXN0czogYm9vbGVhbjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDYXB0dXJlc0luZm8ge1xuICBlbnRyaWVzOiBDYXB0dXJlRW50cnlbXTtcbiAgcGVuZGluZ0NvdW50OiBudW1iZXI7XG4gIHRvdGFsQ291bnQ6IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBQcm92aWRlclN0YXR1c1N1bW1hcnkge1xuICBuYW1lOiBzdHJpbmc7XG4gIGxhYmVsOiBzdHJpbmc7XG4gIGNhdGVnb3J5OiBzdHJpbmc7XG4gIG9rOiBib29sZWFuO1xuICByZXF1aXJlZDogYm9vbGVhbjtcbiAgbWVzc2FnZTogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFNraWxsU3VtbWFyeUluZm8ge1xuICB0b3RhbDogbnVtYmVyO1xuICB3YXJuaW5nQ291bnQ6IG51bWJlcjtcbiAgY3JpdGljYWxDb3VudDogbnVtYmVyO1xuICB0b3BJc3N1ZTogc3RyaW5nIHwgbnVsbDtcbn1cblxuLyoqIEEgc2luZ2xlIGRvY3RvciBoaXN0b3J5IGVudHJ5IGZvciB2aXN1YWxpemVyIGRpc3BsYXkuICovXG5leHBvcnQgaW50ZXJmYWNlIFZpc3VhbGl6ZXJEb2N0b3JFbnRyeSB7XG4gIHRzOiBzdHJpbmc7XG4gIG9rOiBib29sZWFuO1xuICBlcnJvcnM6IG51bWJlcjtcbiAgd2FybmluZ3M6IG51bWJlcjtcbiAgZml4ZXM6IG51bWJlcjtcbiAgY29kZXM6IHN0cmluZ1tdO1xuICBpc3N1ZXM/OiBBcnJheTx7IHNldmVyaXR5OiBzdHJpbmc7IGNvZGU6IHN0cmluZzsgbWVzc2FnZTogc3RyaW5nOyB1bml0SWQ6IHN0cmluZyB9PjtcbiAgZml4RGVzY3JpcHRpb25zPzogc3RyaW5nW107XG4gIHNjb3BlPzogc3RyaW5nO1xuICBzdW1tYXJ5Pzogc3RyaW5nO1xufVxuXG4vKiogQ3VycmVudCBwcm9ncmVzcyBzY29yZSBzbmFwc2hvdCBmb3IgaGVhbHRoIGRpc3BsYXkuICovXG5leHBvcnQgaW50ZXJmYWNlIFZpc3VhbGl6ZXJQcm9ncmVzc1Njb3JlIHtcbiAgbGV2ZWw6IFwiZ3JlZW5cIiB8IFwieWVsbG93XCIgfCBcInJlZFwiO1xuICBzdW1tYXJ5OiBzdHJpbmc7XG4gIHNpZ25hbHM6IEFycmF5PHsga2luZDogXCJwb3NpdGl2ZVwiIHwgXCJuZWdhdGl2ZVwiIHwgXCJuZXV0cmFsXCI7IGxhYmVsOiBzdHJpbmcgfT47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgSGVhbHRoSW5mbyB7XG4gIGJ1ZGdldENlaWxpbmc6IG51bWJlciB8IHVuZGVmaW5lZDtcbiAgdG9rZW5Qcm9maWxlOiBzdHJpbmc7XG4gIHRydW5jYXRpb25SYXRlOiBudW1iZXI7XG4gIGNvbnRpbnVlSGVyZVJhdGU6IG51bWJlcjtcbiAgdGllckJyZWFrZG93bjogVGllckFnZ3JlZ2F0ZVtdO1xuICB0aWVyU2F2aW5nc0xpbmU6IHN0cmluZztcbiAgdG9vbENhbGxzOiBudW1iZXI7XG4gIGFzc2lzdGFudE1lc3NhZ2VzOiBudW1iZXI7XG4gIHVzZXJNZXNzYWdlczogbnVtYmVyO1xuICBwcm92aWRlcnM6IFByb3ZpZGVyU3RhdHVzU3VtbWFyeVtdO1xuICBza2lsbFN1bW1hcnk6IFNraWxsU3VtbWFyeUluZm87XG4gIGVudmlyb25tZW50SXNzdWVzOiBpbXBvcnQoXCIuL2RvY3Rvci1lbnZpcm9ubWVudC5qc1wiKS5FbnZpcm9ubWVudENoZWNrUmVzdWx0W107XG4gIC8qKiBQZXJzaXN0ZWQgZG9jdG9yIHJ1biBoaXN0b3J5IChtb3N0IHJlY2VudCBmaXJzdCwgdXAgdG8gMjAgZW50cmllcykuICovXG4gIGRvY3Rvckhpc3Rvcnk/OiBWaXN1YWxpemVyRG9jdG9yRW50cnlbXTtcbiAgLyoqIEN1cnJlbnQgaW4tbWVtb3J5IHByb2dyZXNzIHNjb3JlIChudWxsIGlmIGF1dG8tbW9kZSBub3QgYWN0aXZlKS4gKi9cbiAgcHJvZ3Jlc3NTY29yZT86IFZpc3VhbGl6ZXJQcm9ncmVzc1Njb3JlIHwgbnVsbDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBWaXN1YWxpemVyRGF0YSB7XG4gIG1pbGVzdG9uZXM6IFZpc3VhbGl6ZXJNaWxlc3RvbmVbXTtcbiAgcGhhc2U6IFBoYXNlO1xuICB0b3RhbHM6IFByb2plY3RUb3RhbHMgfCBudWxsO1xuICBieVBoYXNlOiBQaGFzZUFnZ3JlZ2F0ZVtdO1xuICBieVNsaWNlOiBTbGljZUFnZ3JlZ2F0ZVtdO1xuICBieU1vZGVsOiBNb2RlbEFnZ3JlZ2F0ZVtdO1xuICBieVRpZXI6IFRpZXJBZ2dyZWdhdGVbXTtcbiAgdGllclNhdmluZ3NMaW5lOiBzdHJpbmc7XG4gIHVuaXRzOiBVbml0TWV0cmljc1tdO1xuICBjcml0aWNhbFBhdGg6IENyaXRpY2FsUGF0aEluZm87XG4gIHJlbWFpbmluZ1NsaWNlQ291bnQ6IG51bWJlcjtcbiAgYWdlbnRBY3Rpdml0eTogQWdlbnRBY3Rpdml0eUluZm8gfCBudWxsO1xuICBjaGFuZ2Vsb2c6IENoYW5nZWxvZ0luZm87XG4gIHNsaWNlVmVyaWZpY2F0aW9uczogU2xpY2VWZXJpZmljYXRpb25bXTtcbiAga25vd2xlZGdlOiBLbm93bGVkZ2VJbmZvO1xuICBjYXB0dXJlczogQ2FwdHVyZXNJbmZvO1xuICBoZWFsdGg6IEhlYWx0aEluZm87XG4gIGRpc2N1c3Npb246IFZpc3VhbGl6ZXJEaXNjdXNzaW9uU3RhdGVbXTtcbiAgc3RhdHM6IFZpc3VhbGl6ZXJTdGF0cztcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIENyaXRpY2FsIFBhdGggXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBmdW5jdGlvbiBjb21wdXRlQ3JpdGljYWxQYXRoKG1pbGVzdG9uZXM6IFZpc3VhbGl6ZXJNaWxlc3RvbmVbXSk6IENyaXRpY2FsUGF0aEluZm8ge1xuICBjb25zdCBlbXB0eTogQ3JpdGljYWxQYXRoSW5mbyA9IHtcbiAgICBtaWxlc3RvbmVQYXRoOiBbXSxcbiAgICBzbGljZVBhdGg6IFtdLFxuICAgIG1pbGVzdG9uZVNsYWNrOiBuZXcgTWFwKCksXG4gICAgc2xpY2VTbGFjazogbmV3IE1hcCgpLFxuICB9O1xuXG4gIGlmIChtaWxlc3RvbmVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIGVtcHR5O1xuXG4gIC8vIE1pbGVzdG9uZS1sZXZlbCBjcml0aWNhbCBwYXRoICh3ZWlnaHQgPSBudW1iZXIgb2YgaW5jb21wbGV0ZSBzbGljZXMpXG4gIGNvbnN0IG1zTWFwID0gbmV3IE1hcChtaWxlc3RvbmVzLm1hcChtID0+IFttLmlkLCBtXSkpO1xuICBjb25zdCBtc0lkcyA9IG1pbGVzdG9uZXMubWFwKG0gPT4gbS5pZCk7XG4gIGNvbnN0IG1zQWRqID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZ1tdPigpO1xuICBjb25zdCBtc1dlaWdodCA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG5cbiAgZm9yIChjb25zdCBtcyBvZiBtaWxlc3RvbmVzKSB7XG4gICAgbXNBZGouc2V0KG1zLmlkLCBbXSk7XG4gICAgY29uc3QgaW5jb21wbGV0ZSA9IG1zLnNsaWNlcy5maWx0ZXIocyA9PiAhcy5kb25lKS5sZW5ndGg7XG4gICAgbXNXZWlnaHQuc2V0KG1zLmlkLCBtcy5zdGF0dXMgPT09ICdjb21wbGV0ZScgPyAwIDogTWF0aC5tYXgoMSwgaW5jb21wbGV0ZSkpO1xuICB9XG5cbiAgZm9yIChjb25zdCBtcyBvZiBtaWxlc3RvbmVzKSB7XG4gICAgZm9yIChjb25zdCBkZXAgb2YgbXMuZGVwZW5kc09uKSB7XG4gICAgICBpZiAobXNNYXAuaGFzKGRlcCkpIHtcbiAgICAgICAgY29uc3QgYWRqID0gbXNBZGouZ2V0KGRlcCk7XG4gICAgICAgIGlmIChhZGopIGFkai5wdXNoKG1zLmlkKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyBUb3BvbG9naWNhbCBzb3J0IChLYWhuJ3MgYWxnb3JpdGhtKVxuICBjb25zdCBpbkRlZ3JlZSA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gIGZvciAoY29uc3QgaWQgb2YgbXNJZHMpIGluRGVncmVlLnNldChpZCwgMCk7XG4gIGZvciAoY29uc3QgbXMgb2YgbWlsZXN0b25lcykge1xuICAgIGZvciAoY29uc3QgZGVwIG9mIG1zLmRlcGVuZHNPbikge1xuICAgICAgaWYgKG1zTWFwLmhhcyhkZXApKSBpbkRlZ3JlZS5zZXQobXMuaWQsIChpbkRlZ3JlZS5nZXQobXMuaWQpID8/IDApICsgMSk7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgcXVldWU6IHN0cmluZ1tdID0gW107XG4gIGZvciAoY29uc3QgW2lkLCBkZWddIG9mIGluRGVncmVlKSB7XG4gICAgaWYgKGRlZyA9PT0gMCkgcXVldWUucHVzaChpZCk7XG4gIH1cblxuICBjb25zdCB0b3BvT3JkZXI6IHN0cmluZ1tdID0gW107XG4gIHdoaWxlIChxdWV1ZS5sZW5ndGggPiAwKSB7XG4gICAgY29uc3Qgbm9kZSA9IHF1ZXVlLnNoaWZ0KCkhO1xuICAgIHRvcG9PcmRlci5wdXNoKG5vZGUpO1xuICAgIGZvciAoY29uc3QgbmV4dCBvZiAobXNBZGouZ2V0KG5vZGUpID8/IFtdKSkge1xuICAgICAgY29uc3QgZCA9IChpbkRlZ3JlZS5nZXQobmV4dCkgPz8gMSkgLSAxO1xuICAgICAgaW5EZWdyZWUuc2V0KG5leHQsIGQpO1xuICAgICAgaWYgKGQgPT09IDApIHF1ZXVlLnB1c2gobmV4dCk7XG4gICAgfVxuICB9XG5cbiAgLy8gTG9uZ2VzdCBwYXRoIGZyb20gZWFjaCByb290XG4gIGNvbnN0IGRpc3QgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuICBjb25zdCBwcmV2ID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZyB8IG51bGw+KCk7XG4gIGZvciAoY29uc3QgaWQgb2YgbXNJZHMpIHtcbiAgICBkaXN0LnNldChpZCwgMCk7XG4gICAgcHJldi5zZXQoaWQsIG51bGwpO1xuICB9XG5cbiAgZm9yIChjb25zdCBub2RlIG9mIHRvcG9PcmRlcikge1xuICAgIGNvbnN0IHcgPSBtc1dlaWdodC5nZXQobm9kZSkgPz8gMTtcbiAgICBjb25zdCBub2RlRGlzdCA9IGRpc3QuZ2V0KG5vZGUpISArIHc7XG4gICAgZm9yIChjb25zdCBuZXh0IG9mIChtc0Fkai5nZXQobm9kZSkgPz8gW10pKSB7XG4gICAgICBpZiAobm9kZURpc3QgPiBkaXN0LmdldChuZXh0KSEpIHtcbiAgICAgICAgZGlzdC5zZXQobmV4dCwgbm9kZURpc3QpO1xuICAgICAgICBwcmV2LnNldChuZXh0LCBub2RlKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyBGaW5kIHRoZSBlbmQgb2YgdGhlIGNyaXRpY2FsIHBhdGggKG5vZGUgd2l0aCBtYXggZGlzdCArIG93biB3ZWlnaHQpXG4gIGxldCBtYXhEaXN0ID0gMDtcbiAgbGV0IGVuZE5vZGUgPSBtc0lkc1swXTtcbiAgZm9yIChjb25zdCBpZCBvZiBtc0lkcykge1xuICAgIGNvbnN0IHRvdGFsRGlzdCA9IGRpc3QuZ2V0KGlkKSEgKyAobXNXZWlnaHQuZ2V0KGlkKSA/PyAxKTtcbiAgICBpZiAodG90YWxEaXN0ID4gbWF4RGlzdCkge1xuICAgICAgbWF4RGlzdCA9IHRvdGFsRGlzdDtcbiAgICAgIGVuZE5vZGUgPSBpZDtcbiAgICB9XG4gIH1cblxuICAvLyBUcmFjZSBiYWNrXG4gIGNvbnN0IG1pbGVzdG9uZVBhdGg6IHN0cmluZ1tdID0gW107XG4gIGxldCBjdXI6IHN0cmluZyB8IG51bGwgPSBlbmROb2RlO1xuICB3aGlsZSAoY3VyICE9PSBudWxsKSB7XG4gICAgbWlsZXN0b25lUGF0aC51bnNoaWZ0KGN1cik7XG4gICAgY3VyID0gcHJldi5nZXQoY3VyKSA/PyBudWxsO1xuICB9XG5cbiAgLy8gQ29tcHV0ZSBtaWxlc3RvbmUgc2xhY2tcbiAgY29uc3QgbWlsZXN0b25lU2xhY2sgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuICBjb25zdCBjcml0aWNhbFNldCA9IG5ldyBTZXQobWlsZXN0b25lUGF0aCk7XG4gIGZvciAoY29uc3QgaWQgb2YgbXNJZHMpIHtcbiAgICBpZiAoY3JpdGljYWxTZXQuaGFzKGlkKSkge1xuICAgICAgbWlsZXN0b25lU2xhY2suc2V0KGlkLCAwKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3Qgbm9kZVRvdGFsID0gZGlzdC5nZXQoaWQpISArIChtc1dlaWdodC5nZXQoaWQpID8/IDEpO1xuICAgICAgbWlsZXN0b25lU2xhY2suc2V0KGlkLCBNYXRoLm1heCgwLCBtYXhEaXN0IC0gbm9kZVRvdGFsKSk7XG4gICAgfVxuICB9XG5cbiAgLy8gU2xpY2UtbGV2ZWwgY3JpdGljYWwgcGF0aCB3aXRoaW4gYWN0aXZlIG1pbGVzdG9uZVxuICBjb25zdCBhY3RpdmVNcyA9IG1pbGVzdG9uZXMuZmluZChtID0+IG0uc3RhdHVzID09PSAnYWN0aXZlJyk7XG4gIGxldCBzbGljZVBhdGg6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IHNsaWNlU2xhY2sgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuXG4gIGlmIChhY3RpdmVNcyAmJiBhY3RpdmVNcy5zbGljZXMubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IHNsTWFwID0gbmV3IE1hcChhY3RpdmVNcy5zbGljZXMubWFwKHMgPT4gW3MuaWQsIHNdKSk7XG4gICAgY29uc3Qgc2xBZGogPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nW10+KCk7XG4gICAgZm9yIChjb25zdCBzIG9mIGFjdGl2ZU1zLnNsaWNlcykgc2xBZGouc2V0KHMuaWQsIFtdKTtcbiAgICBmb3IgKGNvbnN0IHMgb2YgYWN0aXZlTXMuc2xpY2VzKSB7XG4gICAgICBmb3IgKGNvbnN0IGRlcCBvZiBzLmRlcGVuZHMpIHtcbiAgICAgICAgaWYgKHNsTWFwLmhhcyhkZXApKSB7XG4gICAgICAgICAgY29uc3QgYWRqID0gc2xBZGouZ2V0KGRlcCk7XG4gICAgICAgICAgaWYgKGFkaikgYWRqLnB1c2gocy5pZCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBUb3BvIHNvcnQgc2xpY2VzXG4gICAgY29uc3Qgc2xJbiA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gICAgZm9yIChjb25zdCBzIG9mIGFjdGl2ZU1zLnNsaWNlcykgc2xJbi5zZXQocy5pZCwgMCk7XG4gICAgZm9yIChjb25zdCBzIG9mIGFjdGl2ZU1zLnNsaWNlcykge1xuICAgICAgZm9yIChjb25zdCBkZXAgb2Ygcy5kZXBlbmRzKSB7XG4gICAgICAgIGlmIChzbE1hcC5oYXMoZGVwKSkgc2xJbi5zZXQocy5pZCwgKHNsSW4uZ2V0KHMuaWQpID8/IDApICsgMSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3Qgc2xRdWV1ZTogc3RyaW5nW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IFtpZCwgZF0gb2Ygc2xJbikge1xuICAgICAgaWYgKGQgPT09IDApIHNsUXVldWUucHVzaChpZCk7XG4gICAgfVxuXG4gICAgY29uc3Qgc2xUb3BvOiBzdHJpbmdbXSA9IFtdO1xuICAgIHdoaWxlIChzbFF1ZXVlLmxlbmd0aCA+IDApIHtcbiAgICAgIGNvbnN0IG4gPSBzbFF1ZXVlLnNoaWZ0KCkhO1xuICAgICAgc2xUb3BvLnB1c2gobik7XG4gICAgICBmb3IgKGNvbnN0IG5leHQgb2YgKHNsQWRqLmdldChuKSA/PyBbXSkpIHtcbiAgICAgICAgY29uc3QgZCA9IChzbEluLmdldChuZXh0KSA/PyAxKSAtIDE7XG4gICAgICAgIHNsSW4uc2V0KG5leHQsIGQpO1xuICAgICAgICBpZiAoZCA9PT0gMCkgc2xRdWV1ZS5wdXNoKG5leHQpO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IHNsRGlzdCA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gICAgY29uc3Qgc2xQcmV2ID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZyB8IG51bGw+KCk7XG4gICAgZm9yIChjb25zdCBzIG9mIGFjdGl2ZU1zLnNsaWNlcykge1xuICAgICAgY29uc3QgdyA9IHMuZG9uZSA/IDAgOiAxO1xuICAgICAgc2xEaXN0LnNldChzLmlkLCAwKTtcbiAgICAgIHNsUHJldi5zZXQocy5pZCwgbnVsbCk7XG4gICAgfVxuXG4gICAgZm9yIChjb25zdCBuIG9mIHNsVG9wbykge1xuICAgICAgY29uc3QgdyA9IChzbE1hcC5nZXQobik/LmRvbmUgPyAwIDogMSk7XG4gICAgICBjb25zdCBuZCA9IHNsRGlzdC5nZXQobikhICsgdztcbiAgICAgIGZvciAoY29uc3QgbmV4dCBvZiAoc2xBZGouZ2V0KG4pID8/IFtdKSkge1xuICAgICAgICBpZiAobmQgPiBzbERpc3QuZ2V0KG5leHQpISkge1xuICAgICAgICAgIHNsRGlzdC5zZXQobmV4dCwgbmQpO1xuICAgICAgICAgIHNsUHJldi5zZXQobmV4dCwgbik7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICBsZXQgc2xNYXggPSAwO1xuICAgIGxldCBzbEVuZCA9IGFjdGl2ZU1zLnNsaWNlc1swXS5pZDtcbiAgICBmb3IgKGNvbnN0IHMgb2YgYWN0aXZlTXMuc2xpY2VzKSB7XG4gICAgICBjb25zdCB0b3RhbERpc3QgPSBzbERpc3QuZ2V0KHMuaWQpISArIChzLmRvbmUgPyAwIDogMSk7XG4gICAgICBpZiAodG90YWxEaXN0ID4gc2xNYXgpIHtcbiAgICAgICAgc2xNYXggPSB0b3RhbERpc3Q7XG4gICAgICAgIHNsRW5kID0gcy5pZDtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBsZXQgc2xDdXI6IHN0cmluZyB8IG51bGwgPSBzbEVuZDtcbiAgICB3aGlsZSAoc2xDdXIgIT09IG51bGwpIHtcbiAgICAgIHNsaWNlUGF0aC51bnNoaWZ0KHNsQ3VyKTtcbiAgICAgIHNsQ3VyID0gc2xQcmV2LmdldChzbEN1cikgPz8gbnVsbDtcbiAgICB9XG5cbiAgICBjb25zdCBzbENyaXRTZXQgPSBuZXcgU2V0KHNsaWNlUGF0aCk7XG4gICAgZm9yIChjb25zdCBzIG9mIGFjdGl2ZU1zLnNsaWNlcykge1xuICAgICAgaWYgKHNsQ3JpdFNldC5oYXMocy5pZCkpIHtcbiAgICAgICAgc2xpY2VTbGFjay5zZXQocy5pZCwgMCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zdCBub2RlVG90YWwgPSBzbERpc3QuZ2V0KHMuaWQpISArIChzLmRvbmUgPyAwIDogMSk7XG4gICAgICAgIHNsaWNlU2xhY2suc2V0KHMuaWQsIE1hdGgubWF4KDAsIHNsTWF4IC0gbm9kZVRvdGFsKSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHsgbWlsZXN0b25lUGF0aCwgc2xpY2VQYXRoLCBtaWxlc3RvbmVTbGFjaywgc2xpY2VTbGFjayB9O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQWdlbnQgQWN0aXZpdHkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIGxvYWRBZ2VudEFjdGl2aXR5KHVuaXRzOiBVbml0TWV0cmljc1tdLCBtaWxlc3RvbmVzOiBWaXN1YWxpemVyTWlsZXN0b25lW10pOiBBZ2VudEFjdGl2aXR5SW5mbyB8IG51bGwge1xuICBpZiAodW5pdHMubGVuZ3RoID09PSAwKSByZXR1cm4gbnVsbDtcblxuICAvLyBGaW5kIGN1cnJlbnRseSBydW5uaW5nIHVuaXQgKGZpbmlzaGVkQXQgPT09IDApXG4gIGNvbnN0IHJ1bm5pbmcgPSB1bml0cy5maW5kKHUgPT4gdS5maW5pc2hlZEF0ID09PSAwKTtcbiAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcblxuICBjb25zdCBjb21wbGV0ZWRVbml0cyA9IHVuaXRzLmZpbHRlcih1ID0+IHUuZmluaXNoZWRBdCA+IDApLmxlbmd0aDtcbiAgY29uc3QgdG90YWxTbGljZXMgPSBtaWxlc3RvbmVzLnJlZHVjZSgoc3VtLCBtKSA9PiBzdW0gKyBtLnNsaWNlcy5sZW5ndGgsIDApO1xuXG4gIC8vIENvbXBsZXRpb24gcmF0ZSBmcm9tIGZpbmlzaGVkIHVuaXRzXG4gIGNvbnN0IGZpbmlzaGVkID0gdW5pdHMuZmlsdGVyKHUgPT4gdS5maW5pc2hlZEF0ID4gMCk7XG4gIGxldCBjb21wbGV0aW9uUmF0ZSA9IDA7XG4gIGlmIChmaW5pc2hlZC5sZW5ndGggPj0gMikge1xuICAgIGNvbnN0IGVhcmxpZXN0ID0gTWF0aC5taW4oLi4uZmluaXNoZWQubWFwKHUgPT4gdS5zdGFydGVkQXQpKTtcbiAgICBjb25zdCBsYXRlc3QgPSBNYXRoLm1heCguLi5maW5pc2hlZC5tYXAodSA9PiB1LmZpbmlzaGVkQXQpKTtcbiAgICBjb25zdCB0b3RhbEhvdXJzID0gKGxhdGVzdCAtIGVhcmxpZXN0KSAvIDNfNjAwXzAwMDtcbiAgICBjb21wbGV0aW9uUmF0ZSA9IHRvdGFsSG91cnMgPiAwID8gZmluaXNoZWQubGVuZ3RoIC8gdG90YWxIb3VycyA6IDA7XG4gIH1cblxuICBjb25zdCBzZXNzaW9uQ29zdCA9IHVuaXRzLnJlZHVjZSgoc3VtLCB1KSA9PiBzdW0gKyB1LmNvc3QsIDApO1xuICBjb25zdCBzZXNzaW9uVG9rZW5zID0gdW5pdHMucmVkdWNlKChzdW0sIHUpID0+IHN1bSArIHUudG9rZW5zLnRvdGFsLCAwKTtcblxuICByZXR1cm4ge1xuICAgIGN1cnJlbnRVbml0OiBydW5uaW5nXG4gICAgICA/IHsgdHlwZTogcnVubmluZy50eXBlLCBpZDogcnVubmluZy5pZCwgc3RhcnRlZEF0OiBydW5uaW5nLnN0YXJ0ZWRBdCB9XG4gICAgICA6IG51bGwsXG4gICAgZWxhcHNlZDogcnVubmluZyA/IG5vdyAtIHJ1bm5pbmcuc3RhcnRlZEF0IDogMCxcbiAgICBjb21wbGV0ZWRVbml0cyxcbiAgICB0b3RhbFNsaWNlcyxcbiAgICBjb21wbGV0aW9uUmF0ZSxcbiAgICBhY3RpdmU6ICEhcnVubmluZyxcbiAgICBzZXNzaW9uQ29zdCxcbiAgICBzZXNzaW9uVG9rZW5zLFxuICB9O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQ2hhbmdlbG9nICYgVmVyaWZpY2F0aW9ucyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuY29uc3QgY2hhbmdlbG9nQ2FjaGUgPSBuZXcgTWFwPHN0cmluZywgeyBtdGltZTogbnVtYmVyOyBlbnRyeTogQ2hhbmdlbG9nRW50cnk7IHZlcmlmaWNhdGlvbjogU2xpY2VWZXJpZmljYXRpb24gfT4oKTtcblxuaW50ZXJmYWNlIENoYW5nZWxvZ0FuZFZlcmlmaWNhdGlvbnMge1xuICBjaGFuZ2Vsb2c6IENoYW5nZWxvZ0luZm87XG4gIHZlcmlmaWNhdGlvbnM6IFNsaWNlVmVyaWZpY2F0aW9uW107XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGxvYWRDaGFuZ2Vsb2dBbmRWZXJpZmljYXRpb25zKGJhc2VQYXRoOiBzdHJpbmcsIG1pbGVzdG9uZXM6IFZpc3VhbGl6ZXJNaWxlc3RvbmVbXSk6IFByb21pc2U8Q2hhbmdlbG9nQW5kVmVyaWZpY2F0aW9ucz4ge1xuICBjb25zdCBlbnRyaWVzOiBDaGFuZ2Vsb2dFbnRyeVtdID0gW107XG4gIGNvbnN0IHZlcmlmaWNhdGlvbnM6IFNsaWNlVmVyaWZpY2F0aW9uW10gPSBbXTtcblxuICBmb3IgKGNvbnN0IG1zIG9mIG1pbGVzdG9uZXMpIHtcbiAgICBmb3IgKGNvbnN0IHNsIG9mIG1zLnNsaWNlcykge1xuICAgICAgaWYgKCFzbC5kb25lKSBjb250aW51ZTtcblxuICAgICAgY29uc3Qgc3VtbWFyeUZpbGUgPSByZXNvbHZlU2xpY2VGaWxlKGJhc2VQYXRoLCBtcy5pZCwgc2wuaWQsICdTVU1NQVJZJyk7XG4gICAgICBpZiAoIXN1bW1hcnlGaWxlKSBjb250aW51ZTtcblxuICAgICAgY29uc3QgY2FjaGVLZXkgPSBgJHttcy5pZH0vJHtzbC5pZH1gO1xuICAgICAgY29uc3QgY2FjaGVkID0gY2hhbmdlbG9nQ2FjaGUuZ2V0KGNhY2hlS2V5KTtcblxuICAgICAgbGV0IG10aW1lID0gMDtcbiAgICAgIHRyeSB7XG4gICAgICAgIG10aW1lID0gc3RhdFN5bmMoc3VtbWFyeUZpbGUpLm10aW1lTXM7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIGlmIChjYWNoZWQgJiYgY2FjaGVkLm10aW1lID09PSBtdGltZSkge1xuICAgICAgICBlbnRyaWVzLnB1c2goY2FjaGVkLmVudHJ5KTtcbiAgICAgICAgdmVyaWZpY2F0aW9ucy5wdXNoKGNhY2hlZC52ZXJpZmljYXRpb24pO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgY29udGVudCA9IGF3YWl0IGxvYWRGaWxlKHN1bW1hcnlGaWxlKTtcbiAgICAgIGlmICghY29udGVudCkgY29udGludWU7XG5cbiAgICAgIGNvbnN0IHN1bW1hcnkgPSBwYXJzZVN1bW1hcnkoY29udGVudCk7XG4gICAgICBjb25zdCBlbnRyeTogQ2hhbmdlbG9nRW50cnkgPSB7XG4gICAgICAgIG1pbGVzdG9uZUlkOiBtcy5pZCxcbiAgICAgICAgc2xpY2VJZDogc2wuaWQsXG4gICAgICAgIHRpdGxlOiBzbC50aXRsZSxcbiAgICAgICAgb25lTGluZXI6IHN1bW1hcnkub25lTGluZXIsXG4gICAgICAgIGZpbGVzTW9kaWZpZWQ6IHN1bW1hcnkuZmlsZXNNb2RpZmllZC5tYXAoZiA9PiAoe1xuICAgICAgICAgIHBhdGg6IGYucGF0aCxcbiAgICAgICAgICBkZXNjcmlwdGlvbjogZi5kZXNjcmlwdGlvbixcbiAgICAgICAgfSkpLFxuICAgICAgICBjb21wbGV0ZWRBdDogU3RyaW5nKHN1bW1hcnkuZnJvbnRtYXR0ZXIuY29tcGxldGVkX2F0ID8/ICcnKSxcbiAgICAgIH07XG5cbiAgICAgIGNvbnN0IHZlcmlmaWNhdGlvbjogU2xpY2VWZXJpZmljYXRpb24gPSB7XG4gICAgICAgIG1pbGVzdG9uZUlkOiBtcy5pZCxcbiAgICAgICAgc2xpY2VJZDogc2wuaWQsXG4gICAgICAgIHZlcmlmaWNhdGlvblJlc3VsdDogc3VtbWFyeS5mcm9udG1hdHRlci52ZXJpZmljYXRpb25fcmVzdWx0IHx8ICcnLFxuICAgICAgICBibG9ja2VyRGlzY292ZXJlZDogc3VtbWFyeS5mcm9udG1hdHRlci5ibG9ja2VyX2Rpc2NvdmVyZWQsXG4gICAgICAgIGtleURlY2lzaW9uczogc3VtbWFyeS5mcm9udG1hdHRlci5rZXlfZGVjaXNpb25zIHx8IFtdLFxuICAgICAgICBwYXR0ZXJuc0VzdGFibGlzaGVkOiBzdW1tYXJ5LmZyb250bWF0dGVyLnBhdHRlcm5zX2VzdGFibGlzaGVkIHx8IFtdLFxuICAgICAgICBwcm92aWRlczogc3VtbWFyeS5mcm9udG1hdHRlci5wcm92aWRlcyB8fCBbXSxcbiAgICAgICAgcmVxdWlyZXM6IChzdW1tYXJ5LmZyb250bWF0dGVyLnJlcXVpcmVzIHx8IFtdKS5tYXAociA9PiAoe1xuICAgICAgICAgIHNsaWNlOiByLnNsaWNlLFxuICAgICAgICAgIHByb3ZpZGVzOiByLnByb3ZpZGVzLFxuICAgICAgICB9KSksXG4gICAgICB9O1xuXG4gICAgICBjaGFuZ2Vsb2dDYWNoZS5zZXQoY2FjaGVLZXksIHsgbXRpbWUsIGVudHJ5LCB2ZXJpZmljYXRpb24gfSk7XG4gICAgICBlbnRyaWVzLnB1c2goZW50cnkpO1xuICAgICAgdmVyaWZpY2F0aW9ucy5wdXNoKHZlcmlmaWNhdGlvbik7XG4gICAgfVxuICB9XG5cbiAgZW50cmllcy5zb3J0KChhLCBiKSA9PiBTdHJpbmcoYi5jb21wbGV0ZWRBdCB8fCAnJykubG9jYWxlQ29tcGFyZShTdHJpbmcoYS5jb21wbGV0ZWRBdCB8fCAnJykpKTtcblxuICByZXR1cm4geyBjaGFuZ2Vsb2c6IHsgZW50cmllcyB9LCB2ZXJpZmljYXRpb25zIH07XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBLbm93bGVkZ2UgTG9hZGVyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBsb2FkS25vd2xlZGdlKGJhc2VQYXRoOiBzdHJpbmcpOiBLbm93bGVkZ2VJbmZvIHtcbiAgY29uc3Qga25vd2xlZGdlUGF0aCA9IHJlc29sdmVHc2RSb290RmlsZShiYXNlUGF0aCwgJ0tOT1dMRURHRScpO1xuICBpZiAoIWV4aXN0c1N5bmMoa25vd2xlZGdlUGF0aCkpIHtcbiAgICByZXR1cm4geyBydWxlczogW10sIHBhdHRlcm5zOiBbXSwgbGVzc29uczogW10sIGV4aXN0czogZmFsc2UgfTtcbiAgfVxuXG4gIGxldCBjb250ZW50OiBzdHJpbmc7XG4gIHRyeSB7XG4gICAgY29udGVudCA9IHJlYWRGaWxlU3luYyhrbm93bGVkZ2VQYXRoLCAndXRmLTgnKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHsgcnVsZXM6IFtdLCBwYXR0ZXJuczogW10sIGxlc3NvbnM6IFtdLCBleGlzdHM6IGZhbHNlIH07XG4gIH1cblxuICBjb25zdCBydWxlczogeyBpZDogc3RyaW5nOyBzY29wZTogc3RyaW5nOyBjb250ZW50OiBzdHJpbmcgfVtdID0gW107XG4gIGNvbnN0IHBhdHRlcm5zOiB7IGlkOiBzdHJpbmc7IGNvbnRlbnQ6IHN0cmluZyB9W10gPSBbXTtcbiAgY29uc3QgbGVzc29uczogeyBpZDogc3RyaW5nOyBjb250ZW50OiBzdHJpbmcgfVtdID0gW107XG5cbiAgY29uc3QgbGluZXMgPSBjb250ZW50LnNwbGl0KCdcXG4nKTtcbiAgbGV0IGN1cnJlbnRTZWN0aW9uID0gJyc7XG5cbiAgZm9yIChjb25zdCBsaW5lIG9mIGxpbmVzKSB7XG4gICAgaWYgKGxpbmUuc3RhcnRzV2l0aCgnIyMgUnVsZXMnKSkgeyBjdXJyZW50U2VjdGlvbiA9ICdydWxlcyc7IGNvbnRpbnVlOyB9XG4gICAgaWYgKGxpbmUuc3RhcnRzV2l0aCgnIyMgUGF0dGVybnMnKSkgeyBjdXJyZW50U2VjdGlvbiA9ICdwYXR0ZXJucyc7IGNvbnRpbnVlOyB9XG4gICAgaWYgKGxpbmUuc3RhcnRzV2l0aCgnIyMgTGVzc29ucycpKSB7IGN1cnJlbnRTZWN0aW9uID0gJ2xlc3NvbnMnOyBjb250aW51ZTsgfVxuICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoJyMjICcpKSB7IGN1cnJlbnRTZWN0aW9uID0gJyc7IGNvbnRpbnVlOyB9XG5cbiAgICBpZiAoIWxpbmUuc3RhcnRzV2l0aCgnfCAnKSB8fCBsaW5lLnN0YXJ0c1dpdGgoJ3wgLS0tJykgfHwgbGluZS5zdGFydHNXaXRoKCd8IElEJykpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGNvbHMgPSBsaW5lLnNwbGl0KCd8JykubWFwKGMgPT4gYy50cmltKCkpLmZpbHRlcihjID0+IGMubGVuZ3RoID4gMCk7XG4gICAgaWYgKGNvbHMubGVuZ3RoIDwgMikgY29udGludWU7XG5cbiAgICBpZiAoY3VycmVudFNlY3Rpb24gPT09ICdydWxlcycgJiYgY29scy5sZW5ndGggPj0gMykge1xuICAgICAgcnVsZXMucHVzaCh7IGlkOiBjb2xzWzBdLCBzY29wZTogY29sc1sxXSwgY29udGVudDogY29sc1syXSB9KTtcbiAgICB9IGVsc2UgaWYgKGN1cnJlbnRTZWN0aW9uID09PSAncGF0dGVybnMnICYmIGNvbHMubGVuZ3RoID49IDIpIHtcbiAgICAgIHBhdHRlcm5zLnB1c2goeyBpZDogY29sc1swXSwgY29udGVudDogY29sc1sxXSB9KTtcbiAgICB9IGVsc2UgaWYgKGN1cnJlbnRTZWN0aW9uID09PSAnbGVzc29ucycgJiYgY29scy5sZW5ndGggPj0gMikge1xuICAgICAgbGVzc29ucy5wdXNoKHsgaWQ6IGNvbHNbMF0sIGNvbnRlbnQ6IGNvbHNbMV0gfSk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHsgcnVsZXMsIHBhdHRlcm5zLCBsZXNzb25zLCBleGlzdHM6IHRydWUgfTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEhlYWx0aCBMb2FkZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIGxvYWRIZWFsdGgodW5pdHM6IFVuaXRNZXRyaWNzW10sIHRvdGFsczogUHJvamVjdFRvdGFscyB8IG51bGwsIGJhc2VQYXRoOiBzdHJpbmcpOiBIZWFsdGhJbmZvIHtcbiAgY29uc3QgcHJlZnMgPSBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMoKTtcbiAgY29uc3QgYnVkZ2V0Q2VpbGluZyA9IHByZWZzPy5wcmVmZXJlbmNlcz8uYnVkZ2V0X2NlaWxpbmc7XG4gIGNvbnN0IHRva2VuUHJvZmlsZSA9IHByZWZzPy5wcmVmZXJlbmNlcz8udG9rZW5fcHJvZmlsZSA/PyAnc3RhbmRhcmQnO1xuXG4gIGxldCB0cnVuY2F0aW9uUmF0ZSA9IDA7XG4gIGxldCBjb250aW51ZUhlcmVSYXRlID0gMDtcbiAgaWYgKHRvdGFscyAmJiB0b3RhbHMudW5pdHMgPiAwKSB7XG4gICAgdHJ1bmNhdGlvblJhdGUgPSAodG90YWxzLnRvdGFsVHJ1bmNhdGlvblNlY3Rpb25zIC8gdG90YWxzLnVuaXRzKSAqIDEwMDtcbiAgICBjb250aW51ZUhlcmVSYXRlID0gKHRvdGFscy5jb250aW51ZUhlcmVGaXJlZENvdW50IC8gdG90YWxzLnVuaXRzKSAqIDEwMDtcbiAgfVxuXG4gIGNvbnN0IHRpZXJCcmVha2Rvd24gPSBhZ2dyZWdhdGVCeVRpZXIodW5pdHMpO1xuICBjb25zdCB0aWVyU2F2aW5nc0xpbmUgPSBmb3JtYXRUaWVyU2F2aW5ncyh1bml0cyk7XG5cbiAgLy8gUHJvdmlkZXIgY2hlY2tzIFx1MjAxNCBmYXN0IChhdXRoLmpzb24gKyBlbnYgdmFycyBvbmx5LCBubyBuZXR3b3JrKVxuICBsZXQgcHJvdmlkZXJzOiBQcm92aWRlclN0YXR1c1N1bW1hcnlbXSA9IFtdO1xuICB0cnkge1xuICAgIHByb3ZpZGVycyA9IHJ1blByb3ZpZGVyQ2hlY2tzKCkubWFwKChyOiBQcm92aWRlckNoZWNrUmVzdWx0KSA9PiAoe1xuICAgICAgbmFtZTogci5uYW1lLFxuICAgICAgbGFiZWw6IHIubGFiZWwsXG4gICAgICBjYXRlZ29yeTogci5jYXRlZ29yeSxcbiAgICAgIG9rOiByLnN0YXR1cyA9PT0gXCJva1wiIHx8IHIuc3RhdHVzID09PSBcInVuY29uZmlndXJlZFwiLFxuICAgICAgcmVxdWlyZWQ6IHIucmVxdWlyZWQsXG4gICAgICBtZXNzYWdlOiByLm1lc3NhZ2UsXG4gICAgfSkpO1xuICB9IGNhdGNoIHsgLyogbm9uLWZhdGFsICovIH1cblxuICAvLyBTa2lsbCBoZWFsdGggc3VtbWFyeVxuICBsZXQgc2tpbGxTdW1tYXJ5OiBTa2lsbFN1bW1hcnlJbmZvID0geyB0b3RhbDogMCwgd2FybmluZ0NvdW50OiAwLCBjcml0aWNhbENvdW50OiAwLCB0b3BJc3N1ZTogbnVsbCB9O1xuICB0cnkge1xuICAgIGNvbnN0IHJlcG9ydCA9IGdlbmVyYXRlU2tpbGxIZWFsdGhSZXBvcnQoYmFzZVBhdGgpO1xuICAgIGNvbnN0IHdhcm5pbmdzID0gcmVwb3J0LnN1Z2dlc3Rpb25zLmZpbHRlcihzID0+IHMuc2V2ZXJpdHkgPT09IFwid2FybmluZ1wiKTtcbiAgICBjb25zdCBjcml0aWNhbHMgPSByZXBvcnQuc3VnZ2VzdGlvbnMuZmlsdGVyKHMgPT4gcy5zZXZlcml0eSA9PT0gXCJjcml0aWNhbFwiKTtcbiAgICBza2lsbFN1bW1hcnkgPSB7XG4gICAgICB0b3RhbDogcmVwb3J0LnNraWxscy5sZW5ndGgsXG4gICAgICB3YXJuaW5nQ291bnQ6IHdhcm5pbmdzLmxlbmd0aCxcbiAgICAgIGNyaXRpY2FsQ291bnQ6IGNyaXRpY2Fscy5sZW5ndGgsXG4gICAgICB0b3BJc3N1ZTogcmVwb3J0LnN1Z2dlc3Rpb25zWzBdPy5tZXNzYWdlID8/IG51bGwsXG4gICAgfTtcbiAgfSBjYXRjaCB7IC8qIG5vbi1mYXRhbCAqLyB9XG5cbiAgLy8gRW52aXJvbm1lbnQgaXNzdWVzIChmcm9tIGRvY3Rvci1lbnZpcm9ubWVudC50cywgIzEyMjEpXG4gIGxldCBlbnZpcm9ubWVudElzc3VlczogRW52aXJvbm1lbnRDaGVja1Jlc3VsdFtdID0gW107XG4gIHRyeSB7XG4gICAgZW52aXJvbm1lbnRJc3N1ZXMgPSBydW5FbnZpcm9ubWVudENoZWNrcyhiYXNlUGF0aCkuZmlsdGVyKHIgPT4gci5zdGF0dXMgIT09IFwib2tcIik7XG4gIH0gY2F0Y2ggeyAvKiBub24tZmF0YWwgKi8gfVxuXG4gIC8vIERvY3RvciBydW4gaGlzdG9yeSBcdTIwMTQgcGVyc2lzdGVkIGFjcm9zcyBzZXNzaW9ucyAoc3luYyByZWFkIHRvIGtlZXAgbG9hZEhlYWx0aCBzeW5jKVxuICBsZXQgZG9jdG9ySGlzdG9yeTogVmlzdWFsaXplckRvY3RvckVudHJ5W10gPSBbXTtcbiAgdHJ5IHtcbiAgICBjb25zdCBoaXN0b3J5UGF0aCA9IGpvaW4oZ3NkUm9vdChiYXNlUGF0aCksIFwiZG9jdG9yLWhpc3RvcnkuanNvbmxcIik7XG4gICAgaWYgKGV4aXN0c1N5bmMoaGlzdG9yeVBhdGgpKSB7XG4gICAgICBjb25zdCBsaW5lcyA9IHJlYWRGaWxlU3luYyhoaXN0b3J5UGF0aCwgXCJ1dGYtOFwiKS5zcGxpdChcIlxcblwiKS5maWx0ZXIobCA9PiBsLnRyaW0oKSk7XG4gICAgICBkb2N0b3JIaXN0b3J5ID0gbGluZXMuc2xpY2UoLTIwKS5yZXZlcnNlKCkubWFwKGwgPT4gSlNPTi5wYXJzZShsKSBhcyBWaXN1YWxpemVyRG9jdG9yRW50cnkpO1xuICAgIH1cbiAgfSBjYXRjaCB7IC8qIG5vbi1mYXRhbCAqLyB9XG5cbiAgLy8gQ3VycmVudCBwcm9ncmVzcyBzY29yZSBcdTIwMTQgb25seSBtZWFuaW5nZnVsIHdoZW4gYXV0by1tb2RlIGhhcyBoZWFsdGggZGF0YVxuICBsZXQgcHJvZ3Jlc3NTY29yZTogVmlzdWFsaXplclByb2dyZXNzU2NvcmUgfCBudWxsID0gbnVsbDtcbiAgdHJ5IHtcbiAgICBjb25zdCBoaXN0b3J5ID0gZ2V0SGVhbHRoSGlzdG9yeSgpO1xuICAgIGlmIChoaXN0b3J5Lmxlbmd0aCA+IDApIHtcbiAgICAgIGNvbnN0IHNjb3JlID0gY29tcHV0ZVByb2dyZXNzU2NvcmUoKTtcbiAgICAgIHByb2dyZXNzU2NvcmUgPSB7IGxldmVsOiBzY29yZS5sZXZlbCwgc3VtbWFyeTogc2NvcmUuc3VtbWFyeSwgc2lnbmFsczogc2NvcmUuc2lnbmFscyB9O1xuICAgIH1cbiAgfSBjYXRjaCB7IC8qIG5vbi1mYXRhbCAqLyB9XG5cbiAgcmV0dXJuIHtcbiAgICBidWRnZXRDZWlsaW5nLFxuICAgIHRva2VuUHJvZmlsZSxcbiAgICB0cnVuY2F0aW9uUmF0ZSxcbiAgICBjb250aW51ZUhlcmVSYXRlLFxuICAgIHRpZXJCcmVha2Rvd24sXG4gICAgdGllclNhdmluZ3NMaW5lLFxuICAgIHRvb2xDYWxsczogdG90YWxzPy50b29sQ2FsbHMgPz8gMCxcbiAgICBhc3Npc3RhbnRNZXNzYWdlczogdG90YWxzPy5hc3Npc3RhbnRNZXNzYWdlcyA/PyAwLFxuICAgIHVzZXJNZXNzYWdlczogdG90YWxzPy51c2VyTWVzc2FnZXMgPz8gMCxcbiAgICBwcm92aWRlcnMsXG4gICAgc2tpbGxTdW1tYXJ5LFxuICAgIGVudmlyb25tZW50SXNzdWVzLFxuICAgIGRvY3Rvckhpc3RvcnksXG4gICAgcHJvZ3Jlc3NTY29yZSxcbiAgfTtcbn1cblxuY29uc3QgUkVDRU5UX0VOVFJZX0xJTUlUID0gMztcbmNvbnN0IEZFQVRVUkVfUFJFVklFV19MSU1JVCA9IDU7XG5jb25zdCBVUERBVEVEX1dJTkRPV19NUyA9IDcgKiAyNCAqIDYwICogNjAgKiAxMDAwO1xuXG5mdW5jdGlvbiBidWlsZFZpc3VhbGl6ZXJTdGF0cyhcbiAgbWlsZXN0b25lczogVmlzdWFsaXplck1pbGVzdG9uZVtdLFxuICBlbnRyaWVzOiBDaGFuZ2Vsb2dFbnRyeVtdLFxuKTogVmlzdWFsaXplclN0YXRzIHtcbiAgY29uc3QgbWlzc2luZzogVmlzdWFsaXplclNsaWNlUmVmW10gPSBbXTtcbiAgZm9yIChjb25zdCBtcyBvZiBtaWxlc3RvbmVzKSB7XG4gICAgZm9yIChjb25zdCBzbCBvZiBtcy5zbGljZXMpIHtcbiAgICAgIGlmICghc2wuZG9uZSkgbWlzc2luZy5wdXNoKHsgbWlsZXN0b25lSWQ6IG1zLmlkLCBzbGljZUlkOiBzbC5pZCwgdGl0bGU6IHNsLnRpdGxlIH0pO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IG1pc3NpbmdDb3VudCA9IG1pc3NpbmcubGVuZ3RoO1xuICBjb25zdCBtaXNzaW5nU2xpY2VzID0gbWlzc2luZy5zbGljZSgwLCBGRUFUVVJFX1BSRVZJRVdfTElNSVQpO1xuXG4gIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gIGNvbnN0IHVwZGF0ZWRFbnRyaWVzID0gZW50cmllcy5maWx0ZXIoZW50cnkgPT4ge1xuICAgIGlmICghZW50cnkuY29tcGxldGVkQXQpIHJldHVybiBmYWxzZTtcbiAgICBjb25zdCBwYXJzZWQgPSBEYXRlLnBhcnNlKGVudHJ5LmNvbXBsZXRlZEF0KTtcbiAgICByZXR1cm4gIU51bWJlci5pc05hTihwYXJzZWQpICYmIG5vdyAtIHBhcnNlZCA8PSBVUERBVEVEX1dJTkRPV19NUztcbiAgfSk7XG4gIGNvbnN0IHVwZGF0ZWRDb3VudCA9IHVwZGF0ZWRFbnRyaWVzLmxlbmd0aDtcbiAgY29uc3QgdXBkYXRlZFNsaWNlcyA9IHVwZGF0ZWRFbnRyaWVzLnNsaWNlKDAsIEZFQVRVUkVfUFJFVklFV19MSU1JVCkubWFwKGVudHJ5ID0+ICh7XG4gICAgbWlsZXN0b25lSWQ6IGVudHJ5Lm1pbGVzdG9uZUlkLFxuICAgIHNsaWNlSWQ6IGVudHJ5LnNsaWNlSWQsXG4gICAgdGl0bGU6IGVudHJ5LnRpdGxlLFxuICAgIGNvbXBsZXRlZEF0OiBlbnRyeS5jb21wbGV0ZWRBdCxcbiAgfSkpO1xuXG4gIGNvbnN0IHJlY2VudEVudHJpZXMgPSBlbnRyaWVzLnNsaWNlKDAsIFJFQ0VOVF9FTlRSWV9MSU1JVCk7XG5cbiAgcmV0dXJuIHtcbiAgICBtaXNzaW5nQ291bnQsXG4gICAgbWlzc2luZ1NsaWNlcyxcbiAgICB1cGRhdGVkQ291bnQsXG4gICAgdXBkYXRlZFNsaWNlcyxcbiAgICByZWNlbnRFbnRyaWVzLFxuICB9O1xufVxuXG5mdW5jdGlvbiBsb2FkRGlzY3Vzc2lvblN0YXRlKFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICBtaWxlc3RvbmVzOiBWaXN1YWxpemVyTWlsZXN0b25lW10sXG4pOiBWaXN1YWxpemVyRGlzY3Vzc2lvblN0YXRlW10ge1xuICBjb25zdCBzdGF0ZXM6IFZpc3VhbGl6ZXJEaXNjdXNzaW9uU3RhdGVbXSA9IFtdO1xuXG4gIGZvciAoY29uc3QgbXMgb2YgbWlsZXN0b25lcykge1xuICAgIGNvbnN0IGNvbnRleHRQYXRoID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZVBhdGgsIG1zLmlkLCBcIkNPTlRFWFRcIik7XG4gICAgY29uc3QgZHJhZnRQYXRoID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZVBhdGgsIG1zLmlkLCBcIkNPTlRFWFQtRFJBRlRcIik7XG4gICAgY29uc3Qgc3RhdGU6IERpc2N1c3Npb25TdGF0ZSA9IGNvbnRleHRQYXRoXG4gICAgICA/IFwiZGlzY3Vzc2VkXCJcbiAgICAgIDogZHJhZnRQYXRoXG4gICAgICAgID8gXCJkcmFmdFwiXG4gICAgICAgIDogXCJ1bmRpc2N1c3NlZFwiO1xuXG4gICAgbGV0IGxhc3RVcGRhdGVkOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICBjb25zdCB0YXJnZXQgPSBjb250ZXh0UGF0aCA/PyBkcmFmdFBhdGg7XG4gICAgaWYgKHRhcmdldCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgbGFzdFVwZGF0ZWQgPSBuZXcgRGF0ZShzdGF0U3luYyh0YXJnZXQpLm10aW1lTXMpLnRvSVNPU3RyaW5nKCk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgbGFzdFVwZGF0ZWQgPSBudWxsO1xuICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRlcy5wdXNoKHtcbiAgICAgIG1pbGVzdG9uZUlkOiBtcy5pZCxcbiAgICAgIHRpdGxlOiBtcy50aXRsZSxcbiAgICAgIHN0YXRlLFxuICAgICAgaGFzQ29udGV4dDogISFjb250ZXh0UGF0aCxcbiAgICAgIGhhc0RyYWZ0OiAhIWRyYWZ0UGF0aCxcbiAgICAgIGxhc3RVcGRhdGVkLFxuICAgIH0pO1xuICB9XG5cbiAgcmV0dXJuIHN0YXRlcztcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEZpbGUgRmluZ2VycHJpbnQgQ2FjaGUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogTXRpbWUtYmFzZWQgY2FjaGUgZm9yIHBhcnNlZCBmaWxlIGNvbnRlbnRzLiBBdm9pZHMgcmUtcmVhZGluZyBhbmQgcmUtcGFyc2luZ1xuICogcm9hZG1hcC9wbGFuIGZpbGVzIHdob3NlIG10aW1lIGhhc24ndCBjaGFuZ2VkIHNpbmNlIHRoZSBsYXN0IGxvYWQuXG4gKi9cbmNvbnN0IGZpbGVDb250ZW50Q2FjaGUgPSBuZXcgTWFwPHN0cmluZywgeyBtdGltZTogbnVtYmVyOyBjb250ZW50OiBzdHJpbmcgfT4oKTtcblxuZnVuY3Rpb24gcmVhZEZpbGVDYWNoZWQoZmlsZVBhdGg6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICB0cnkge1xuICAgIGNvbnN0IG10aW1lID0gc3RhdFN5bmMoZmlsZVBhdGgpLm10aW1lTXM7XG4gICAgY29uc3QgY2FjaGVkID0gZmlsZUNvbnRlbnRDYWNoZS5nZXQoZmlsZVBhdGgpO1xuICAgIGlmIChjYWNoZWQgJiYgY2FjaGVkLm10aW1lID09PSBtdGltZSkge1xuICAgICAgcmV0dXJuIGNhY2hlZC5jb250ZW50O1xuICAgIH1cbiAgICBjb25zdCBjb250ZW50ID0gcmVhZEZpbGVTeW5jKGZpbGVQYXRoLCAndXRmLTgnKTtcbiAgICBmaWxlQ29udGVudENhY2hlLnNldChmaWxlUGF0aCwgeyBtdGltZSwgY29udGVudCB9KTtcbiAgICByZXR1cm4gY29udGVudDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIExvYWRlciBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGxvYWRWaXN1YWxpemVyRGF0YShiYXNlUGF0aDogc3RyaW5nKTogUHJvbWlzZTxWaXN1YWxpemVyRGF0YT4ge1xuICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2VQYXRoKTtcbiAgY29uc3QgbWlsZXN0b25lSWRzID0gZmluZE1pbGVzdG9uZUlkcyhiYXNlUGF0aCk7XG5cbiAgY29uc3QgbWlsZXN0b25lczogVmlzdWFsaXplck1pbGVzdG9uZVtdID0gW107XG5cbiAgZm9yIChjb25zdCBtaWQgb2YgbWlsZXN0b25lSWRzKSB7XG4gICAgY29uc3QgZW50cnkgPSBzdGF0ZS5yZWdpc3RyeS5maW5kKHIgPT4gci5pZCA9PT0gbWlkKTtcbiAgICBjb25zdCBzdGF0dXMgPSBlbnRyeT8uc3RhdHVzID8/ICdwZW5kaW5nJztcbiAgICBjb25zdCBkZXBlbmRzT24gPSBlbnRyeT8uZGVwZW5kc09uID8/IFtdO1xuXG4gICAgY29uc3Qgc2xpY2VzOiBWaXN1YWxpemVyU2xpY2VbXSA9IFtdO1xuXG4gICAgY29uc3Qgcm9hZG1hcEZpbGUgPSByZXNvbHZlTWlsZXN0b25lRmlsZShiYXNlUGF0aCwgbWlkLCAnUk9BRE1BUCcpO1xuICAgIGNvbnN0IHJvYWRtYXBDb250ZW50ID0gcm9hZG1hcEZpbGUgPyByZWFkRmlsZUNhY2hlZChyb2FkbWFwRmlsZSkgOiBudWxsO1xuXG4gICAgaWYgKHJvYWRtYXBDb250ZW50IHx8IGlzRGJBdmFpbGFibGUoKSkge1xuICAgICAgLy8gTm9ybWFsaXplIHNsaWNlcyBmcm9tIERCLCBmYWxsIGJhY2sgdG8gZmlsZS1iYXNlZCBwYXJzaW5nIHdoZW4gREIgaGFzIG5vIGRhdGFcbiAgICAgIHR5cGUgTm9ybVNsaWNlID0geyBpZDogc3RyaW5nOyBkb25lOiBib29sZWFuOyB0aXRsZTogc3RyaW5nOyByaXNrOiBzdHJpbmc7IGRlcGVuZHM6IHN0cmluZ1tdOyBkZW1vOiBzdHJpbmcgfTtcbiAgICAgIGxldCBub3JtU2xpY2VzOiBOb3JtU2xpY2VbXSB8IG51bGwgPSBudWxsO1xuICAgICAgaWYgKGlzRGJBdmFpbGFibGUoKSkge1xuICAgICAgICBjb25zdCBkYlNsaWNlcyA9IGdldE1pbGVzdG9uZVNsaWNlcyhtaWQpO1xuICAgICAgICBpZiAoZGJTbGljZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgIG5vcm1TbGljZXMgPSBkYlNsaWNlcy5tYXAocyA9PiAoeyBpZDogcy5pZCwgZG9uZTogcy5zdGF0dXMgPT09ICdjb21wbGV0ZScsIHRpdGxlOiBzLnRpdGxlLCByaXNrOiBzLnJpc2sgfHwgJ21lZGl1bScsIGRlcGVuZHM6IHMuZGVwZW5kcywgZGVtbzogcy5kZW1vIH0pKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKCFub3JtU2xpY2VzICYmIHJvYWRtYXBDb250ZW50KSB7XG4gICAgICAgIC8vIEZpbGUtYmFzZWQgZmFsbGJhY2s6IHBhcnNlIHJvYWRtYXAgZm9yIHNsaWNlIGVudHJpZXNcbiAgICAgICAgY29uc3QgcGFyc2VkID0gcGFyc2VSb2FkbWFwKHJvYWRtYXBDb250ZW50KTtcbiAgICAgICAgbm9ybVNsaWNlcyA9IHBhcnNlZC5zbGljZXMubWFwKHMgPT4gKHsgaWQ6IHMuaWQsIGRvbmU6IHMuZG9uZSwgdGl0bGU6IHMudGl0bGUsIHJpc2s6IHMucmlzayB8fCAnbWVkaXVtJywgZGVwZW5kczogcy5kZXBlbmRzLCBkZW1vOiAnJyB9KSk7XG4gICAgICB9XG4gICAgICBpZiAoIW5vcm1TbGljZXMpIG5vcm1TbGljZXMgPSBbXTtcblxuICAgICAgZm9yIChjb25zdCBzIG9mIG5vcm1TbGljZXMpIHtcbiAgICAgICAgY29uc3QgaXNBY3RpdmVTbGljZSA9XG4gICAgICAgICAgc3RhdGUuYWN0aXZlTWlsZXN0b25lPy5pZCA9PT0gbWlkICYmXG4gICAgICAgICAgc3RhdGUuYWN0aXZlU2xpY2U/LmlkID09PSBzLmlkO1xuXG4gICAgICAgIGNvbnN0IHRhc2tzOiBWaXN1YWxpemVyVGFza1tdID0gW107XG5cbiAgICAgICAgaWYgKGlzQWN0aXZlU2xpY2UpIHtcbiAgICAgICAgICAvLyBOb3JtYWxpemUgdGFza3MgZnJvbSBEQiwgZmFsbCBiYWNrIHRvIGZpbGUgcGFyc2luZyB3aGVuIERCIGhhcyBubyBkYXRhXG4gICAgICAgICAgbGV0IHVzZWREYlRhc2tzID0gZmFsc2U7XG4gICAgICAgICAgaWYgKGlzRGJBdmFpbGFibGUoKSkge1xuICAgICAgICAgICAgY29uc3QgZGJUYXNrcyA9IGdldFNsaWNlVGFza3MobWlkLCBzLmlkKTtcbiAgICAgICAgICAgIGlmIChkYlRhc2tzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgdXNlZERiVGFza3MgPSB0cnVlO1xuICAgICAgICAgICAgICBmb3IgKGNvbnN0IHQgb2YgZGJUYXNrcykge1xuICAgICAgICAgICAgICAgIHRhc2tzLnB1c2goe1xuICAgICAgICAgICAgICAgICAgaWQ6IHQuaWQsXG4gICAgICAgICAgICAgICAgICB0aXRsZTogdC50aXRsZSxcbiAgICAgICAgICAgICAgICAgIGRvbmU6IHQuc3RhdHVzID09PSAnY29tcGxldGUnIHx8IHQuc3RhdHVzID09PSAnZG9uZScsXG4gICAgICAgICAgICAgICAgICBhY3RpdmU6IHN0YXRlLmFjdGl2ZVRhc2s/LmlkID09PSB0LmlkLFxuICAgICAgICAgICAgICAgICAgZXN0aW1hdGU6IHQuZXN0aW1hdGUgfHwgdW5kZWZpbmVkLFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmICghdXNlZERiVGFza3MpIHtcbiAgICAgICAgICAgIC8vIEZpbGUtYmFzZWQgZmFsbGJhY2s6IHBhcnNlIHNsaWNlIHBsYW4gZm9yIHRhc2sgZW50cmllc1xuICAgICAgICAgICAgY29uc3Qgc2xpY2VQbGFuRmlsZSA9IHJlc29sdmVTbGljZUZpbGUoYmFzZVBhdGgsIG1pZCwgcy5pZCwgJ1BMQU4nKTtcbiAgICAgICAgICAgIGlmIChzbGljZVBsYW5GaWxlKSB7XG4gICAgICAgICAgICAgIGNvbnN0IHBsYW5Db250ZW50ID0gcmVhZEZpbGVDYWNoZWQoc2xpY2VQbGFuRmlsZSk7XG4gICAgICAgICAgICAgIGlmIChwbGFuQ29udGVudCkge1xuICAgICAgICAgICAgICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlUGxhbihwbGFuQ29udGVudCk7XG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCB0IG9mIHBhcnNlZC50YXNrcykge1xuICAgICAgICAgICAgICAgICAgdGFza3MucHVzaCh7XG4gICAgICAgICAgICAgICAgICAgIGlkOiB0LmlkLFxuICAgICAgICAgICAgICAgICAgICB0aXRsZTogdC50aXRsZSxcbiAgICAgICAgICAgICAgICAgICAgZG9uZTogdC5kb25lLFxuICAgICAgICAgICAgICAgICAgICBhY3RpdmU6IHN0YXRlLmFjdGl2ZVRhc2s/LmlkID09PSB0LmlkLFxuICAgICAgICAgICAgICAgICAgICBlc3RpbWF0ZTogdC5lc3RpbWF0ZSB8fCB1bmRlZmluZWQsXG4gICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBzbGljZXMucHVzaCh7XG4gICAgICAgICAgaWQ6IHMuaWQsXG4gICAgICAgICAgdGl0bGU6IHMudGl0bGUsXG4gICAgICAgICAgZG9uZTogcy5kb25lLFxuICAgICAgICAgIGFjdGl2ZTogaXNBY3RpdmVTbGljZSxcbiAgICAgICAgICByaXNrOiBzLnJpc2ssXG4gICAgICAgICAgZGVwZW5kczogcy5kZXBlbmRzLFxuICAgICAgICAgIHRhc2tzLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBtaWxlc3RvbmVzLnB1c2goe1xuICAgICAgaWQ6IG1pZCxcbiAgICAgIHRpdGxlOiBlbnRyeT8udGl0bGUgPz8gbWlkLFxuICAgICAgc3RhdHVzLFxuICAgICAgZGVwZW5kc09uLFxuICAgICAgc2xpY2VzLFxuICAgIH0pO1xuICB9XG5cbiAgLy8gTWV0cmljc1xuICBsZXQgdG90YWxzOiBQcm9qZWN0VG90YWxzIHwgbnVsbCA9IG51bGw7XG4gIGxldCBieVBoYXNlOiBQaGFzZUFnZ3JlZ2F0ZVtdID0gW107XG4gIGxldCBieVNsaWNlOiBTbGljZUFnZ3JlZ2F0ZVtdID0gW107XG4gIGxldCBieU1vZGVsOiBNb2RlbEFnZ3JlZ2F0ZVtdID0gW107XG4gIGxldCBieVRpZXI6IFRpZXJBZ2dyZWdhdGVbXSA9IFtdO1xuICBsZXQgdGllclNhdmluZ3NMaW5lID0gJyc7XG4gIGxldCB1bml0czogVW5pdE1ldHJpY3NbXSA9IFtdO1xuXG4gIGNvbnN0IGxlZGdlciA9IGdldExlZGdlcigpID8/IGxvYWRMZWRnZXJGcm9tRGlzayhiYXNlUGF0aCk7XG5cbiAgaWYgKGxlZGdlciAmJiBsZWRnZXIudW5pdHMubGVuZ3RoID4gMCkge1xuICAgIHVuaXRzID0gWy4uLmxlZGdlci51bml0c10uc29ydCgoYSwgYikgPT4gYS5zdGFydGVkQXQgLSBiLnN0YXJ0ZWRBdCk7XG4gICAgdG90YWxzID0gZ2V0UHJvamVjdFRvdGFscyh1bml0cyk7XG4gICAgYnlQaGFzZSA9IGFnZ3JlZ2F0ZUJ5UGhhc2UodW5pdHMpO1xuICAgIGJ5U2xpY2UgPSBhZ2dyZWdhdGVCeVNsaWNlKHVuaXRzKTtcbiAgICBieU1vZGVsID0gYWdncmVnYXRlQnlNb2RlbCh1bml0cyk7XG4gICAgYnlUaWVyID0gYWdncmVnYXRlQnlUaWVyKHVuaXRzKTtcbiAgICB0aWVyU2F2aW5nc0xpbmUgPSBmb3JtYXRUaWVyU2F2aW5ncyh1bml0cyk7XG4gIH1cblxuICAvLyBDb21wdXRlIG5ldyBmaWVsZHNcbiAgY29uc3QgY3JpdGljYWxQYXRoID0gY29tcHV0ZUNyaXRpY2FsUGF0aChtaWxlc3RvbmVzKTtcblxuICBsZXQgcmVtYWluaW5nU2xpY2VDb3VudCA9IDA7XG4gIGZvciAoY29uc3QgbXMgb2YgbWlsZXN0b25lcykge1xuICAgIGZvciAoY29uc3Qgc2wgb2YgbXMuc2xpY2VzKSB7XG4gICAgICBpZiAoIXNsLmRvbmUpIHJlbWFpbmluZ1NsaWNlQ291bnQrKztcbiAgICB9XG4gIH1cblxuICBjb25zdCBhZ2VudEFjdGl2aXR5ID0gbG9hZEFnZW50QWN0aXZpdHkodW5pdHMsIG1pbGVzdG9uZXMpO1xuICBjb25zdCB7IGNoYW5nZWxvZywgdmVyaWZpY2F0aW9uczogc2xpY2VWZXJpZmljYXRpb25zIH0gPSBhd2FpdCBsb2FkQ2hhbmdlbG9nQW5kVmVyaWZpY2F0aW9ucyhiYXNlUGF0aCwgbWlsZXN0b25lcyk7XG5cbiAgY29uc3Qga25vd2xlZGdlID0gbG9hZEtub3dsZWRnZShiYXNlUGF0aCk7XG4gIGNvbnN0IGFsbENhcHR1cmVzID0gbG9hZEFsbENhcHR1cmVzKGJhc2VQYXRoKTtcbiAgY29uc3QgcGVuZGluZ0NvdW50ID0gY291bnRQZW5kaW5nQ2FwdHVyZXMoYmFzZVBhdGgpO1xuICBjb25zdCBjYXB0dXJlczogQ2FwdHVyZXNJbmZvID0ge1xuICAgIGVudHJpZXM6IGFsbENhcHR1cmVzLFxuICAgIHBlbmRpbmdDb3VudCxcbiAgICB0b3RhbENvdW50OiBhbGxDYXB0dXJlcy5sZW5ndGgsXG4gIH07XG5cbiAgY29uc3QgaGVhbHRoID0gbG9hZEhlYWx0aCh1bml0cywgdG90YWxzLCBiYXNlUGF0aCk7XG4gIGNvbnN0IHN0YXRzID0gYnVpbGRWaXN1YWxpemVyU3RhdHMobWlsZXN0b25lcywgY2hhbmdlbG9nLmVudHJpZXMpO1xuICBjb25zdCBkaXNjdXNzaW9uID0gbG9hZERpc2N1c3Npb25TdGF0ZShiYXNlUGF0aCwgbWlsZXN0b25lcyk7XG5cbiAgcmV0dXJuIHtcbiAgICBtaWxlc3RvbmVzLFxuICAgIHBoYXNlOiBzdGF0ZS5waGFzZSxcbiAgICB0b3RhbHMsXG4gICAgYnlQaGFzZSxcbiAgICBieVNsaWNlLFxuICAgIGJ5TW9kZWwsXG4gICAgYnlUaWVyLFxuICAgIHRpZXJTYXZpbmdzTGluZSxcbiAgICB1bml0cyxcbiAgICBjcml0aWNhbFBhdGgsXG4gICAgcmVtYWluaW5nU2xpY2VDb3VudCxcbiAgICBhZ2VudEFjdGl2aXR5LFxuICAgIGNoYW5nZWxvZyxcbiAgICBzbGljZVZlcmlmaWNhdGlvbnMsXG4gICAga25vd2xlZGdlLFxuICAgIGNhcHR1cmVzLFxuICAgIGhlYWx0aCxcbiAgICBkaXNjdXNzaW9uLFxuICAgIHN0YXRzLFxuICB9O1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBRUEsU0FBUyxZQUFZLGNBQWMsZ0JBQWdCO0FBQ25ELFNBQVMsWUFBWTtBQUNyQixTQUFTLG1CQUFtQjtBQUM1QixTQUFTLGNBQWMsZ0JBQWdCO0FBQ3ZDLFNBQVMsZUFBZSxvQkFBb0IscUJBQXFCO0FBQ2pFLFNBQVMsY0FBYyxpQkFBaUI7QUFDeEMsU0FBUyx3QkFBd0I7QUFDakMsU0FBUyxzQkFBc0Isa0JBQWtCLG9CQUFvQixlQUFlO0FBQ3BGO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUVLO0FBQ1AsU0FBUyxpQkFBaUIsNEJBQTRCO0FBQ3RELFNBQVMsbUNBQW1DO0FBQzVDLFNBQVMseUJBQW1EO0FBQzVELFNBQVMsaUNBQWlDO0FBQzFDLFNBQVMsNEJBQXlEO0FBQ2xFLFNBQVMsNEJBQTRCO0FBQ3JDLFNBQVMsd0JBQXdCO0FBNk0xQixTQUFTLG9CQUFvQixZQUFxRDtBQUN2RixRQUFNLFFBQTBCO0FBQUEsSUFDOUIsZUFBZSxDQUFDO0FBQUEsSUFDaEIsV0FBVyxDQUFDO0FBQUEsSUFDWixnQkFBZ0Isb0JBQUksSUFBSTtBQUFBLElBQ3hCLFlBQVksb0JBQUksSUFBSTtBQUFBLEVBQ3RCO0FBRUEsTUFBSSxXQUFXLFdBQVcsRUFBRyxRQUFPO0FBR3BDLFFBQU0sUUFBUSxJQUFJLElBQUksV0FBVyxJQUFJLE9BQUssQ0FBQyxFQUFFLElB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
