import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gsdHome } from "./gsd-home.js";
import { extractTrace } from "./session-forensics.js";
import { nativeParseJsonlTail } from "./native-parser-bridge.js";
import { MAX_JSONL_BYTES, parseJSONL } from "./jsonl-utils.js";
import {
  loadLedgerFromDisk,
  getAverageCostPerUnitType,
  getProjectTotals,
  formatCost,
  formatTokenCount
} from "./metrics.js";
import { readCrashLock, isLockProcessAlive, formatCrashInfo } from "./crash-recovery.js";
import { runGSDDoctor, formatDoctorIssuesForPrompt } from "./doctor.js";
import { verifyExpectedArtifact } from "./auto-recovery.js";
import { deriveState } from "./state.js";
import { isAutoActive } from "./auto.js";
import { loadPrompt } from "./prompt-loader.js";
import { gsdRoot } from "./paths.js";
import { isDbAvailable, getAllMilestones, getMilestoneSlices, getSliceTasks } from "./gsd-db.js";
import { isClosedStatus } from "./status-guards.js";
import { formatDuration } from "../shared/format-utils.js";
import { getAutoWorktreePath } from "./auto-worktree.js";
import { loadEffectiveGSDPreferences, loadGlobalGSDPreferences, getGlobalGSDPreferencesPath } from "./preferences.js";
import { showNextAction } from "../shared/tui.js";
import { ensurePreferencesFile, serializePreferencesToFrontmatter } from "./commands-prefs-wizard.js";
import { summarizeWorktreeTelemetry, percentile } from "./worktree-telemetry.js";
import { homedir } from "node:os";
const DEDUP_PROMPT_SECTION = `
## Pre-Investigation: Duplicate Check (REQUIRED)

Before reading GSD source code or performing deep analysis, you MUST search for existing issues and PRs that may already address this bug. This avoids wasting tokens on already-fixed bugs.

### Search Steps

Use keywords from the user's problem description and the anomaly summaries in the forensic report above.

1. **Search closed issues** for similar keywords:
   \`\`\`
   gh issue list --repo gsd-build/gsd-2 --state closed --search "<keywords from root cause>" --limit 20
   \`\`\`

2. **Search open PRs** that might contain the fix:
   \`\`\`
   gh pr list --repo gsd-build/gsd-2 --state open --search "<keywords>" --limit 10
   \`\`\`

3. **Search merged PRs** that may have already fixed this:
   \`\`\`
   gh pr list --repo gsd-build/gsd-2 --state merged --search "<keywords>" --limit 10
   \`\`\`

### Analysis

For each result, compare it against the user's reported symptoms and the forensic anomalies:
- Does the issue describe the same code path or file?
- Does the PR modify the area related to the reported symptoms?
- Is the symptom description semantically similar even if keywords differ?

### Decision Gate

- **Merged PR clearly fixes the described symptom** \u2192 Report "Already fixed by PR #X" with brief explanation. Skip full investigation.
- **Open issue matches** \u2192 Report "Existing issue #Y covers this." Offer to add forensic evidence. Skip full investigation unless user asks for deeper analysis.
- **No matches** \u2192 Proceed to full investigation below.
`;
async function writeForensicsDedupPref(ctx, enabled) {
  const prefsPath = getGlobalGSDPreferencesPath();
  await ensurePreferencesFile(prefsPath, ctx, "global");
  const existing = loadGlobalGSDPreferences();
  const prefs = existing?.preferences ? { ...existing.preferences } : {};
  prefs.version = prefs.version || 1;
  prefs.forensics_dedup = enabled;
  const frontmatter = serializePreferencesToFrontmatter(prefs);
  const raw = existsSync(prefsPath) ? readFileSync(prefsPath, "utf-8") : "";
  let body = "\n# GSD Skill Preferences\n\nSee `~/.gsd/agent/extensions/gsd/docs/preferences-reference.md` for full field documentation and examples.\n";
  const start = raw.startsWith("---\n") ? 4 : raw.startsWith("---\r\n") ? 5 : -1;
  if (start !== -1) {
    const closingIdx = raw.indexOf("\n---", start);
    if (closingIdx !== -1) {
      const after = raw.slice(closingIdx + 4);
      if (after.trim()) body = after;
    }
  }
  writeFileSync(prefsPath, `---
${frontmatter}---${body}`, "utf-8");
}
async function handleForensics(args, ctx, pi) {
  if (isAutoActive()) {
    ctx.ui.notify("Cannot run forensics while auto-mode is active. Stop auto-mode first.", "error");
    return;
  }
  const basePath = process.cwd();
  const root = gsdRoot(basePath);
  if (!existsSync(root)) {
    ctx.ui.notify("No GSD state found. Run /gsd auto first.", "warning");
    return;
  }
  let problemDescription = args.trim();
  if (!problemDescription) {
    problemDescription = await ctx.ui.input(
      "Describe what went wrong:",
      "e.g. auto-mode got stuck on task T03"
    ) ?? "";
  }
  if (!problemDescription?.trim()) {
    ctx.ui.notify("Problem description required for forensic analysis.", "warning");
    return;
  }
  const effectivePrefs = loadEffectiveGSDPreferences()?.preferences;
  let dedupEnabled = effectivePrefs?.forensics_dedup === true;
  if (effectivePrefs?.forensics_dedup === void 0) {
    const choice = await showNextAction(ctx, {
      title: "Duplicate detection available",
      summary: ["Before filing a GitHub issue, forensics can search existing issues and PRs to avoid duplicates.", "This uses additional AI tokens for analysis."],
      actions: [
        { id: "enable", label: "Enable duplicate detection", description: "Search issues/PRs before filing (recommended)", recommended: true },
        { id: "skip", label: "Skip for now", description: "File without checking for duplicates" }
      ],
      notYetMessage: "You can enable this later via preferences (forensics_dedup: true)."
    });
    if (choice === "enable") {
      await writeForensicsDedupPref(ctx, true);
      dedupEnabled = true;
    }
  }
  const dedupSection = dedupEnabled ? DEDUP_PROMPT_SECTION : "";
  ctx.ui.notify("Building forensic report...", "info");
  const report = await buildForensicReport(basePath);
  const savedPath = saveForensicReport(basePath, report, problemDescription);
  let gsdSourceDir = dirname(fileURLToPath(import.meta.url));
  if (!existsSync(join(gsdSourceDir, "prompts"))) {
    const fallback = join(gsdHome(), "agent", "extensions", "gsd");
    if (existsSync(join(fallback, "prompts"))) gsdSourceDir = fallback;
  }
  const forensicData = formatReportForPrompt(report);
  const content = loadPrompt("forensics", {
    problemDescription,
    forensicData,
    gsdSourceDir,
    dedupSection
  });
  ctx.ui.notify(`Forensic report saved: ${relative(basePath, savedPath)}`, "info");
  pi.sendMessage(
    { customType: "gsd-forensics", content, display: false },
    { triggerTurn: true }
  );
  writeForensicsMarker(basePath, savedPath, content);
}
async function buildForensicReport(basePath) {
  const anomalies = [];
  let activeMilestone = null;
  let activeSlice = null;
  try {
    const state = await deriveState(basePath);
    activeMilestone = state.activeMilestone?.id ?? null;
    activeSlice = state.activeSlice?.id ?? null;
  } catch {
  }
  const activeWorktree = activeMilestone ? getAutoWorktreePath(basePath, activeMilestone) : null;
  const unitTraces = scanActivityLogs(basePath, activeMilestone);
  const metrics = loadLedgerFromDisk(basePath);
  const completedKeys = loadCompletedKeys(basePath);
  const dbCompletionCounts = getDbCompletionCounts();
  const crashLock = readCrashLock(basePath);
  let doctorIssues = [];
  try {
    const report = await runGSDDoctor(basePath, { scope: void 0 });
    doctorIssues = report.issues;
  } catch {
  }
  const recentUnits = [];
  if (metrics?.units) {
    const sorted = [...metrics.units].sort((a, b) => b.finishedAt - a.finishedAt).slice(0, 10);
    for (const u of sorted) {
      recentUnits.push({
        type: u.type,
        id: u.id,
        cost: u.cost,
        duration: u.finishedAt - u.startedAt,
        model: u.model,
        finishedAt: u.finishedAt
      });
    }
  }
  const gsdVersion = process.env.GSD_VERSION || "unknown";
  const journalSummary = scanJournalForForensics(basePath);
  const activityLogMeta = gatherActivityLogMeta(basePath, activeMilestone);
  if (metrics?.units) detectStuckLoops(metrics.units, anomalies);
  if (metrics?.units) detectCostSpikes(metrics.units, anomalies);
  detectTimeouts(unitTraces, anomalies);
  detectMissingArtifacts(completedKeys, basePath, activeMilestone, anomalies);
  detectCrash(crashLock, anomalies);
  detectDoctorIssues(doctorIssues, anomalies);
  detectErrorTraces(unitTraces, anomalies);
  let worktreeTelemetry = null;
  try {
    worktreeTelemetry = summarizeWorktreeTelemetry(basePath);
    detectWorktreeOrphans(worktreeTelemetry, anomalies);
  } catch {
  }
  detectJournalAnomalies(journalSummary, anomalies);
  return {
    gsdVersion,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    basePath,
    activeMilestone,
    activeSlice,
    activeWorktree: activeWorktree ? relative(basePath, activeWorktree) : null,
    unitTraces,
    metrics,
    completedKeys,
    dbCompletionCounts,
    crashLock,
    doctorIssues,
    anomalies,
    recentUnits,
    journalSummary,
    activityLogMeta,
    worktreeTelemetry
  };
}
const ACTIVITY_FILENAME_RE = /^(\d+)-(.+?)-(.+)\.jsonl$/;
const RAPID_ITERATION_THRESHOLD_MS = 5e3;
function scanActivityLogs(basePath, activeMilestone) {
  const activityDirs = resolveActivityDirs(basePath, activeMilestone);
  const allTraces = [];
  for (const activityDir of activityDirs) {
    if (!existsSync(activityDir)) continue;
    const files = readdirSync(activityDir).filter((f) => f.endsWith(".jsonl")).sort();
    const lastFiles = files.slice(-5);
    for (const file of lastFiles) {
      const match = ACTIVITY_FILENAME_RE.exec(file);
      if (!match) continue;
      const seq = parseInt(match[1], 10);
      const unitType = match[2];
      const unitId = match[3];
      const filePath = join(activityDir, file);
      let entries = [];
      const nativeResult = nativeParseJsonlTail(filePath, MAX_JSONL_BYTES);
      if (nativeResult) {
        entries = nativeResult.entries;
      } else {
        try {
          const raw = readFileSync(filePath, "utf-8");
          entries = parseJSONL(raw);
        } catch {
          continue;
        }
      }
      const trace = extractTrace(entries);
      const stat = statSync(filePath, { throwIfNoEntry: false });
      allTraces.push({
        file: activityDirs.length > 1 ? `[${relative(basePath, activityDir)}] ${file}` : file,
        unitType,
        unitId,
        seq,
        trace,
        mtime: stat?.mtimeMs ?? 0
      });
    }
  }
  return allTraces.sort((a, b) => b.mtime - a.mtime).slice(0, 5);
}
function resolveActivityDirs(basePath, activeMilestone) {
  const dirs = [];
  if (activeMilestone) {
    const wtPath = getAutoWorktreePath(basePath, activeMilestone);
    if (wtPath) {
      const wtActivityDir = join(gsdRoot(wtPath), "activity");
      if (existsSync(wtActivityDir)) {
        dirs.push(wtActivityDir);
      }
    }
  }
  const rootActivityDir = join(gsdRoot(basePath), "activity");
  dirs.push(rootActivityDir);
  return dirs;
}
const MAX_JOURNAL_RECENT_FILES = 3;
const MAX_JOURNAL_RECENT_EVENTS = 20;
function scanJournalForForensics(basePath) {
  try {
    const journalDir = join(gsdRoot(basePath), "journal");
    if (!existsSync(journalDir)) return null;
    const files = readdirSync(journalDir).filter((f) => f.endsWith(".jsonl")).sort();
    if (files.length === 0) return null;
    const recentFiles = files.slice(-MAX_JOURNAL_RECENT_FILES);
    const olderFiles = files.slice(0, -MAX_JOURNAL_RECENT_FILES);
    let olderEntryCount = 0;
    let oldestEntry = null;
    for (const file of olderFiles) {
      try {
        const raw = readFileSync(join(journalDir, file), "utf-8");
        const lines = raw.split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          olderEntryCount++;
          if (!oldestEntry) {
            try {
              const parsed = JSON.parse(line);
              if (parsed.ts) oldestEntry = parsed.ts;
            } catch {
            }
          }
        }
      } catch {
      }
    }
    const eventCounts = {};
    const flowIds = /* @__PURE__ */ new Set();
    const recentParsedEntries = [];
    let recentEntryCount = 0;
    for (const file of recentFiles) {
      try {
        const raw = readFileSync(join(journalDir, file), "utf-8");
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            recentEntryCount++;
            eventCounts[entry.eventType] = (eventCounts[entry.eventType] ?? 0) + 1;
            flowIds.add(entry.flowId);
            if (!oldestEntry) oldestEntry = entry.ts;
            recentParsedEntries.push({
              ts: entry.ts,
              flowId: entry.flowId,
              eventType: entry.eventType,
              rule: entry.rule,
              unitId: entry.data?.unitId
            });
            if (recentParsedEntries.length > MAX_JOURNAL_RECENT_EVENTS) {
              recentParsedEntries.shift();
            }
          } catch {
          }
        }
      } catch {
      }
    }
    const totalEntries = olderEntryCount + recentEntryCount;
    if (totalEntries === 0) return null;
    const newestEntry = recentParsedEntries.length > 0 ? recentParsedEntries[recentParsedEntries.length - 1].ts : null;
    return {
      totalEntries,
      flowCount: flowIds.size,
      eventCounts,
      recentEvents: recentParsedEntries,
      oldestEntry,
      newestEntry,
      fileCount: files.length
    };
  } catch {
    return null;
  }
}
function gatherActivityLogMeta(basePath, activeMilestone) {
  try {
    const activityDirs = resolveActivityDirs(basePath, activeMilestone);
    let fileCount = 0;
    let totalSizeBytes = 0;
    let oldestFile = null;
    let newestFile = null;
    let oldestMtime = Infinity;
    let newestMtime = 0;
    for (const activityDir of activityDirs) {
      if (!existsSync(activityDir)) continue;
      const files = readdirSync(activityDir).filter((f) => f.endsWith(".jsonl"));
      for (const file of files) {
        const filePath = join(activityDir, file);
        const stat = statSync(filePath, { throwIfNoEntry: false });
        if (!stat) continue;
        fileCount++;
        totalSizeBytes += stat.size;
        if (stat.mtimeMs < oldestMtime) {
          oldestMtime = stat.mtimeMs;
          oldestFile = file;
        }
        if (stat.mtimeMs > newestMtime) {
          newestMtime = stat.mtimeMs;
          newestFile = file;
        }
      }
    }
    if (fileCount === 0) return null;
    return { fileCount, totalSizeBytes, oldestFile, newestFile };
  } catch {
    return null;
  }
}
function splitCompletedKey(key) {
  if (key.startsWith("hook/")) {
    const secondSlash = key.indexOf("/", 5);
    if (secondSlash === -1) return null;
    return { unitType: key.slice(0, secondSlash), unitId: key.slice(secondSlash + 1) };
  }
  const slashIdx = key.indexOf("/");
  if (slashIdx === -1) return null;
  return { unitType: key.slice(0, slashIdx), unitId: key.slice(slashIdx + 1) };
}
function loadCompletedKeys(basePath) {
  const file = join(gsdRoot(basePath), "completed-units.json");
  try {
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, "utf-8"));
    }
  } catch {
  }
  return [];
}
function getDbCompletionCounts() {
  if (!isDbAvailable()) return null;
  const milestones = getAllMilestones();
  let completedMilestones = 0;
  let totalSlices = 0;
  let completedSlices = 0;
  let totalTasks = 0;
  let completedTasks = 0;
  for (const m of milestones) {
    if (isClosedStatus(m.status)) completedMilestones++;
    const slices = getMilestoneSlices(m.id);
    for (const s of slices) {
      totalSlices++;
      if (isClosedStatus(s.status)) completedSlices++;
      const tasks = getSliceTasks(m.id, s.id);
      for (const t of tasks) {
        totalTasks++;
        if (isClosedStatus(t.status)) completedTasks++;
      }
    }
  }
  return {
    milestones: completedMilestones,
    milestonesTotal: milestones.length,
    slices: completedSlices,
    slicesTotal: totalSlices,
    tasks: completedTasks,
    tasksTotal: totalTasks
  };
}
function detectStuckLoops(units, anomalies) {
  const dispatchMap = /* @__PURE__ */ new Map();
  for (const u of units) {
    const key = `${u.type}/${u.id}`;
    let sessionBuckets = dispatchMap.get(key);
    if (!sessionBuckets) {
      sessionBuckets = /* @__PURE__ */ new Map();
      dispatchMap.set(key, sessionBuckets);
    }
    const sessionKey = u.autoSessionKey ?? "__legacy__";
    let starts = sessionBuckets.get(sessionKey);
    if (!starts) {
      starts = /* @__PURE__ */ new Set();
      sessionBuckets.set(sessionKey, starts);
    }
    starts.add(u.startedAt);
  }
  for (const [key, sessionBuckets] of dispatchMap) {
    const hasSessionAwareData = Array.from(sessionBuckets.keys()).some((sessionKey) => sessionKey !== "__legacy__");
    const count = hasSessionAwareData ? Math.max(...Array.from(sessionBuckets.values(), (starts) => starts.size)) : sessionBuckets.get("__legacy__")?.size ?? 0;
    if (count > 1) {
      const [unitType, ...idParts] = key.split("/");
      anomalies.push({
        type: "stuck-loop",
        severity: count >= 3 ? "error" : "warning",
        unitType,
        unitId: idParts.join("/"),
        summary: `Unit ${key} was dispatched ${count} times`,
        details: hasSessionAwareData ? `Repeated dispatch within the same auto session suggests the unit completed but its artifacts were not verified, or the state machine kept returning it. Cross-session recovery runs are ignored.` : `Repeated dispatch suggests the unit completed but its artifacts weren't verified, or the state machine kept returning it.`
      });
    }
  }
}
function detectCostSpikes(units, anomalies) {
  const avgMap = getAverageCostPerUnitType(units);
  for (const u of units) {
    const avg = avgMap.get(u.type);
    if (avg && avg > 0 && u.cost > avg * 3) {
      anomalies.push({
        type: "cost-spike",
        severity: "warning",
        unitType: u.type,
        unitId: u.id,
        summary: `${formatCost(u.cost)} vs ${formatCost(avg)} average for ${u.type}`,
        details: `Unit ${u.type}/${u.id} cost ${(u.cost / avg).toFixed(1)}x the average. May indicate excessive retries or large context.`
      });
    }
  }
}
function detectTimeouts(traces, anomalies) {
  for (const ut of traces) {
    const hasTimeout = ut.trace.toolCalls.some(
      (tc) => tc.name === "sendmessage" && JSON.stringify(tc.input).includes("gsd-auto-timeout-recovery")
    );
    const reasoningTimeout = ut.trace.lastReasoning && /(?:idle.?timeout|hard.?timeout|timeout.?recovery)/i.test(ut.trace.lastReasoning);
    if (hasTimeout || reasoningTimeout) {
      anomalies.push({
        type: "timeout",
        severity: "warning",
        unitType: ut.unitType,
        unitId: ut.unitId,
        summary: `Timeout detected in ${ut.unitType}/${ut.unitId}`,
        details: `Activity log ${ut.file} contains timeout recovery patterns. The unit may have stalled.`
      });
    }
  }
}
function detectMissingArtifacts(completedKeys, basePath, activeMilestone, anomalies) {
  const wtBasePath = activeMilestone ? getAutoWorktreePath(basePath, activeMilestone) : null;
  for (const key of completedKeys) {
    const parsed = splitCompletedKey(key);
    if (!parsed) continue;
    const { unitType, unitId } = parsed;
    const rootHasArtifact = verifyExpectedArtifact(unitType, unitId, basePath);
    const wtHasArtifact = wtBasePath ? verifyExpectedArtifact(unitType, unitId, wtBasePath) : false;
    if (!rootHasArtifact && !wtHasArtifact) {
      anomalies.push({
        type: "missing-artifact",
        severity: "error",
        unitType,
        unitId,
        summary: `Completed key ${key} but artifact missing or invalid`,
        details: `The unit is recorded as completed but verifyExpectedArtifact() returns false at both project root and worktree. The completion state is stale.`
      });
    }
  }
}
function detectWorktreeOrphans(summary, anomalies) {
  for (const [reason, count] of Object.entries(summary.orphansByReason)) {
    if (count <= 0) continue;
    const severity = reason === "in-progress-unmerged" ? "warning" : "info";
    anomalies.push({
      type: "worktree-orphan",
      severity,
      summary: `${count} worktree orphan(s) detected (${reason})`,
      details: reason === "in-progress-unmerged" ? "Auto-mode exited without completing a milestone; live work sits on an unmerged milestone branch. Run `/gsd auto` to resume, or merge manually." : reason === "complete-unmerged" ? "A completed milestone's branch was never merged back to main. Run `/gsd doctor fix` to resolve." : `Reason: ${reason}.`
    });
  }
  if (summary.exitsWithUnmergedWork > 0) {
    const reasonBreakdown = Object.entries(summary.exitsByReason).filter(([, n]) => n > 0).map(([r, n]) => `${r}=${n}`).join(", ");
    anomalies.push({
      type: "worktree-unmerged-exit",
      severity: "warning",
      summary: `${summary.exitsWithUnmergedWork} auto-exit(s) left milestone work unmerged`,
      details: `Exit reasons: ${reasonBreakdown || "(none)"} \xB7 Producer-side signal for #4761-class orphans. Inspect .gsd/journal/*.jsonl with eventType:"auto-exit" for per-exit detail.`
    });
  }
}
function detectCrash(crashLock, anomalies) {
  if (!crashLock) return;
  if (isLockProcessAlive(crashLock)) return;
  anomalies.push({
    type: "crash",
    severity: "error",
    unitType: crashLock.unitType,
    unitId: crashLock.unitId,
    summary: `Stale crash lock: PID ${crashLock.pid} is dead`,
    details: formatCrashInfo(crashLock)
  });
}
function detectDoctorIssues(issues, anomalies) {
  for (const issue of issues) {
    if (issue.severity === "error") {
      anomalies.push({
        type: "doctor-issue",
        severity: "error",
        summary: `Doctor: ${issue.message}`,
        details: `Code: ${issue.code}, Scope: ${issue.scope}, Unit: ${issue.unitId}${issue.file ? `, File: ${issue.file}` : ""}`
      });
    }
  }
}
function detectErrorTraces(traces, anomalies) {
  for (const ut of traces) {
    if (ut.trace.errors.length > 0) {
      anomalies.push({
        type: "error-trace",
        severity: "warning",
        unitType: ut.unitType,
        unitId: ut.unitId,
        summary: `${ut.trace.errors.length} error(s) in ${ut.unitType}/${ut.unitId}`,
        details: ut.trace.errors.slice(0, 3).join("\n")
      });
    }
  }
}
function detectJournalAnomalies(journal, anomalies) {
  if (!journal) return;
  const stuckCount = journal.eventCounts["stuck-detected"] ?? 0;
  if (stuckCount > 0) {
    anomalies.push({
      type: "journal-stuck",
      severity: stuckCount >= 3 ? "error" : "warning",
      summary: `Journal recorded ${stuckCount} stuck-detected event(s)`,
      details: `The auto-mode loop detected it was stuck ${stuckCount} time(s). Check journal events for flow IDs and causal chains to trace the root cause.`
    });
  }
  const guardCount = journal.eventCounts["guard-block"] ?? 0;
  if (guardCount > 0) {
    anomalies.push({
      type: "journal-guard-block",
      severity: guardCount >= 5 ? "warning" : "info",
      summary: `Journal recorded ${guardCount} guard-block event(s)`,
      details: `Dispatch was blocked by a guard condition ${guardCount} time(s). This may indicate a persistent blocking condition preventing progress.`
    });
  }
  if (journal.flowCount > 0 && journal.oldestEntry && journal.newestEntry) {
    const oldest = new Date(journal.oldestEntry).getTime();
    const newest = new Date(journal.newestEntry).getTime();
    const spanMs = newest - oldest;
    if (spanMs > 0 && journal.flowCount > 10) {
      const avgMs = spanMs / journal.flowCount;
      if (avgMs < RAPID_ITERATION_THRESHOLD_MS) {
        anomalies.push({
          type: "journal-rapid-iterations",
          severity: "warning",
          summary: `${journal.flowCount} iterations in ${formatDuration(spanMs)} (avg ${formatDuration(avgMs)}/iteration)`,
          details: `Unusually rapid iteration cadence suggests the loop may be thrashing without making progress. Review recent journal events for dispatch-stop or terminal events.`
        });
      }
    }
  }
  const wtCreateFailed = journal.eventCounts["worktree-create-failed"] ?? 0;
  const wtMergeFailed = journal.eventCounts["worktree-merge-failed"] ?? 0;
  const wtFailures = wtCreateFailed + wtMergeFailed;
  if (wtFailures > 0) {
    const parts = [];
    if (wtCreateFailed > 0) parts.push(`${wtCreateFailed} create failure(s)`);
    if (wtMergeFailed > 0) parts.push(`${wtMergeFailed} merge failure(s)`);
    anomalies.push({
      type: "journal-worktree-failure",
      severity: "warning",
      summary: `Worktree failures: ${parts.join(", ")}`,
      details: `Journal recorded worktree operation failures. These may indicate git state corruption or conflicting branches.`
    });
  }
}
function saveForensicReport(basePath, report, problemDescription) {
  const dir = join(gsdRoot(basePath), "forensics");
  mkdirSync(dir, { recursive: true });
  const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, 19);
  const filePath = join(dir, `report-${ts}.md`);
  const redact = (s) => redactForGitHub(s, basePath);
  const sections = [
    `# GSD Forensic Report`,
    ``,
    `**Generated:** ${report.timestamp}`,
    `**GSD Version:** ${report.gsdVersion}`,
    `**Active Milestone:** ${report.activeMilestone ?? "none"}`,
    `**Active Slice:** ${report.activeSlice ?? "none"}`,
    `**Active Worktree:** ${report.activeWorktree ?? "none"}`,
    ``,
    `## Problem Description`,
    ``,
    problemDescription,
    ``
  ];
  if (report.anomalies.length > 0) {
    sections.push(`## Anomalies Detected (${report.anomalies.length})`, ``);
    for (const a of report.anomalies) {
      sections.push(`### [${a.severity.toUpperCase()}] ${a.type}: ${a.summary}`);
      if (a.unitType) sections.push(`- Unit: ${a.unitType}/${a.unitId ?? ""}`);
      sections.push(`- ${redact(a.details)}`, ``);
    }
  } else {
    sections.push(`## Anomalies`, ``, `No anomalies detected.`, ``);
  }
  if (report.recentUnits.length > 0) {
    sections.push(`## Recent Units`, ``);
    sections.push(`| Type | ID | Cost | Duration | Model |`);
    sections.push(`|------|-----|------|----------|-------|`);
    for (const u of report.recentUnits) {
      sections.push(`| ${u.type} | ${u.id} | ${formatCost(u.cost)} | ${formatDuration(u.duration)} | ${u.model} |`);
    }
    sections.push(``);
  }
  if (report.unitTraces.length > 0) {
    sections.push(`## Activity Log Traces (last ${report.unitTraces.length})`, ``);
    for (const ut of report.unitTraces) {
      sections.push(`### ${ut.unitType}/${ut.unitId} (seq ${ut.seq})`);
      sections.push(`- Tool calls: ${ut.trace.toolCallCount}`);
      sections.push(`- Files written: ${ut.trace.filesWritten.length}`);
      sections.push(`- Errors: ${ut.trace.errors.length}`);
      if (ut.trace.lastReasoning) {
        sections.push(`- Last reasoning: ${redact(ut.trace.lastReasoning.slice(0, 200))}`);
      }
      sections.push(``);
    }
  }
  if (report.doctorIssues.length > 0) {
    sections.push(`## Doctor Issues`, ``);
    sections.push(formatDoctorIssuesForPrompt(report.doctorIssues), ``);
  }
  if (report.crashLock) {
    sections.push(`## Crash Lock`, ``);
    sections.push(redact(formatCrashInfo(report.crashLock)), ``);
  }
  if (report.activityLogMeta) {
    const meta = report.activityLogMeta;
    sections.push(`## Activity Log Metadata`, ``);
    sections.push(`- Files: ${meta.fileCount}`);
    sections.push(`- Total size: ${(meta.totalSizeBytes / 1024).toFixed(1)} KB`);
    if (meta.oldestFile) sections.push(`- Oldest: ${meta.oldestFile}`);
    if (meta.newestFile) sections.push(`- Newest: ${meta.newestFile}`);
    sections.push(``);
  }
  if (report.worktreeTelemetry) {
    const t = report.worktreeTelemetry;
    const p50 = percentile(t.mergeDurationsMs, 0.5);
    const p95 = percentile(t.mergeDurationsMs, 0.95);
    sections.push(`## Worktree Telemetry`, ``);
    sections.push(`- Worktrees created: ${t.worktreesCreated}`);
    sections.push(`- Worktrees merged: ${t.worktreesMerged}`);
    sections.push(`- Orphans detected: ${t.orphansDetected}`);
    if (t.orphansDetected > 0) {
      const breakdown = Object.entries(t.orphansByReason).map(([r, n]) => `${r}=${n}`).join(", ");
      sections.push(`  - By reason: ${breakdown}`);
    }
    sections.push(`- Merge conflicts: ${t.mergeConflicts}`);
    if (t.mergeDurationsMs.length > 0) {
      sections.push(`- Merge duration p50 / p95: ${p50 ?? "-"} / ${p95 ?? "-"} ms (n=${t.mergeDurationsMs.length})`);
    }
    sections.push(`- Auto-exits leaving unmerged work: ${t.exitsWithUnmergedWork}`);
    if (Object.keys(t.exitsByReason).length > 0) {
      const breakdown = Object.entries(t.exitsByReason).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r}=${n}`).join(", ");
      sections.push(`  - Exit reasons: ${breakdown}`);
    }
    sections.push(`- Canonical-root redirects (#4761 fix fired): ${t.canonicalRedirects}`);
    if (t.slicesMerged + t.sliceMergeConflicts + t.milestoneResquashes > 0) {
      sections.push(`- Slices merged: ${t.slicesMerged} \xB7 Slice merge conflicts: ${t.sliceMergeConflicts}`);
      sections.push(`- Milestone re-squashes: ${t.milestoneResquashes}`);
    }
    sections.push(``);
  }
  if (report.journalSummary) {
    const js = report.journalSummary;
    sections.push(`## Journal Summary`, ``);
    sections.push(`- Total entries: ${js.totalEntries}`);
    sections.push(`- Distinct flows (iterations): ${js.flowCount}`);
    sections.push(`- Daily files: ${js.fileCount}`);
    if (js.oldestEntry) sections.push(`- Date range: ${js.oldestEntry} \u2014 ${js.newestEntry}`);
    sections.push(``);
    sections.push(`### Event Type Distribution`, ``);
    sections.push(`| Event Type | Count |`);
    sections.push(`|------------|-------|`);
    for (const [evType, count] of Object.entries(js.eventCounts).sort((a, b) => b[1] - a[1])) {
      sections.push(`| ${evType} | ${count} |`);
    }
    sections.push(``);
    if (js.recentEvents.length > 0) {
      sections.push(`### Recent Journal Events (last ${js.recentEvents.length})`, ``);
      for (const ev of js.recentEvents) {
        const parts = [`${ev.ts} [${ev.eventType}] flow=${ev.flowId.slice(0, 8)}`];
        if (ev.rule) parts.push(`rule=${ev.rule}`);
        if (ev.unitId) parts.push(`unit=${ev.unitId}`);
        sections.push(`- ${parts.join(" ")}`);
      }
      sections.push(``);
    }
  }
  writeFileSync(filePath, sections.join("\n"), "utf-8");
  return filePath;
}
function writeForensicsMarker(basePath, reportPath, promptContent) {
  const dir = join(gsdRoot(basePath), "runtime");
  mkdirSync(dir, { recursive: true });
  const marker = {
    reportPath,
    promptContent,
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  writeFileSync(join(dir, "active-forensics.json"), JSON.stringify(marker), "utf-8");
}
function readForensicsMarker(basePath) {
  const markerPath = join(gsdRoot(basePath), "runtime", "active-forensics.json");
  if (!existsSync(markerPath)) return null;
  try {
    return JSON.parse(readFileSync(markerPath, "utf-8"));
  } catch {
    return null;
  }
}
function formatReportForPrompt(report) {
  const MAX_BYTES = 30 * 1024;
  const sections = [];
  sections.push(`### Anomalies (${report.anomalies.length})`);
  if (report.anomalies.length === 0) {
    sections.push("No anomalies detected.");
  } else {
    for (const a of report.anomalies) {
      sections.push(`- **[${a.severity.toUpperCase()}] ${a.type}**: ${a.summary}`);
      if (a.details) sections.push(`  ${a.details.slice(0, 300)}`);
    }
  }
  sections.push("");
  if (report.recentUnits.length > 0) {
    sections.push(`### Recent Units (last ${report.recentUnits.length})`);
    sections.push("| Type | ID | Cost | Duration | Model |");
    sections.push("|------|-----|------|----------|-------|");
    for (const u of report.recentUnits) {
      sections.push(`| ${u.type} | ${u.id} | ${formatCost(u.cost)} | ${formatDuration(u.duration)} | ${u.model} |`);
    }
    sections.push("");
  }
  const recentTraces = report.unitTraces.slice(0, 3);
  if (recentTraces.length > 0) {
    sections.push(`### Activity Log Traces (last ${recentTraces.length})`);
    for (const ut of recentTraces) {
      sections.push(`**${ut.unitType}/${ut.unitId}** (seq ${ut.seq})`);
      sections.push(`- Tool calls: ${ut.trace.toolCallCount}, Errors: ${ut.trace.errors.length}`);
      if (ut.trace.filesWritten.length > 0) {
        sections.push(`- Files written: ${ut.trace.filesWritten.slice(0, 5).join(", ")}`);
      }
      if (ut.trace.errors.length > 0) {
        sections.push(`- Errors: ${ut.trace.errors.slice(0, 2).map((e) => e.slice(0, 200)).join("; ")}`);
      }
      if (ut.trace.lastReasoning) {
        sections.push(`- Last reasoning: "${ut.trace.lastReasoning.slice(0, 300)}"`);
      }
      sections.push("");
    }
  }
  const errorIssues = report.doctorIssues.filter((i) => i.severity === "error");
  if (errorIssues.length > 0) {
    sections.push(`### Doctor Issues (${errorIssues.length} errors)`);
    sections.push(formatDoctorIssuesForPrompt(errorIssues));
    sections.push("");
  }
  if (report.crashLock) {
    sections.push("### Crash Lock");
    sections.push(formatCrashInfo(report.crashLock));
    const alive = isLockProcessAlive(report.crashLock);
    sections.push(`Process alive: ${alive}`);
    sections.push("");
  }
  if (report.metrics?.units) {
    const totals = getProjectTotals(report.metrics.units);
    sections.push("### Metrics Summary");
    sections.push(`- Total units: ${totals.units}`);
    sections.push(`- Total cost: ${formatCost(totals.cost)}`);
    sections.push(`- Total tokens: ${formatTokenCount(totals.tokens.total)}`);
    sections.push(`- Total duration: ${formatDuration(totals.duration)}`);
    sections.push("");
  }
  if (report.worktreeTelemetry) {
    const t = report.worktreeTelemetry;
    const hasSignal = t.worktreesCreated + t.worktreesMerged + t.orphansDetected + t.exitsWithUnmergedWork + t.canonicalRedirects + t.slicesMerged + t.milestoneResquashes > 0;
    if (hasSignal) {
      sections.push("### Worktree Telemetry");
      sections.push(`- Created: ${t.worktreesCreated} \xB7 Merged: ${t.worktreesMerged} \xB7 Conflicts: ${t.mergeConflicts}`);
      sections.push(`- Orphans: ${t.orphansDetected} \xB7 Unmerged exits: ${t.exitsWithUnmergedWork} \xB7 Redirects (#4761): ${t.canonicalRedirects}`);
      if (t.orphansDetected > 0) {
        const breakdown = Object.entries(t.orphansByReason).map(([r, n]) => `${r}=${n}`).join(", ");
        sections.push(`- Orphan reasons: ${breakdown}`);
      }
      if (t.slicesMerged + t.sliceMergeConflicts + t.milestoneResquashes > 0) {
        sections.push(`- Slices merged: ${t.slicesMerged} \xB7 Slice conflicts: ${t.sliceMergeConflicts} \xB7 Re-squashes: ${t.milestoneResquashes}`);
      }
      sections.push("");
    }
  }
  if (report.activityLogMeta) {
    const meta = report.activityLogMeta;
    sections.push("### Activity Log Overview");
    sections.push(`- Files: ${meta.fileCount}, Total size: ${(meta.totalSizeBytes / 1024).toFixed(1)} KB`);
    if (meta.oldestFile) sections.push(`- Oldest: ${meta.oldestFile}`);
    if (meta.newestFile) sections.push(`- Newest: ${meta.newestFile}`);
    sections.push("");
  }
  if (report.journalSummary) {
    const js = report.journalSummary;
    sections.push("### Journal Summary (Iteration Event Log)");
    sections.push(`- Total entries: ${js.totalEntries}, Distinct flows: ${js.flowCount}, Daily files: ${js.fileCount}`);
    if (js.oldestEntry) sections.push(`- Date range: ${js.oldestEntry} \u2014 ${js.newestEntry}`);
    const eventPairs = Object.entries(js.eventCounts).sort((a, b) => b[1] - a[1]);
    sections.push(`- Events: ${eventPairs.map(([t, c]) => `${t}(${c})`).join(", ")}`);
    if (js.recentEvents.length > 0) {
      sections.push("");
      sections.push(`**Recent Journal Events (last ${js.recentEvents.length}):**`);
      for (const ev of js.recentEvents) {
        const parts = [`${ev.ts} [${ev.eventType}] flow=${ev.flowId.slice(0, 8)}`];
        if (ev.rule) parts.push(`rule=${ev.rule}`);
        if (ev.unitId) parts.push(`unit=${ev.unitId}`);
        sections.push(`- ${parts.join(" ")}`);
      }
    }
    sections.push("");
  }
  if (report.dbCompletionCounts) {
    const c = report.dbCompletionCounts;
    sections.push(`### Completion Status (from DB)`);
    sections.push(`- ${c.milestones}/${c.milestonesTotal} milestones complete`);
    sections.push(`- ${c.slices}/${c.slicesTotal} slices complete`);
    sections.push(`- ${c.tasks}/${c.tasksTotal} tasks complete`);
  } else {
    sections.push(`### Completed Keys: ${report.completedKeys.length}`);
  }
  sections.push(`### GSD Version: ${report.gsdVersion}`);
  sections.push(`### Active Milestone: ${report.activeMilestone ?? "none"}`);
  sections.push(`### Active Slice: ${report.activeSlice ?? "none"}`);
  if (report.activeWorktree) {
    sections.push(`### Active Worktree: ${report.activeWorktree}`);
    sections.push(`Note: Activity logs were scanned from both the worktree and the project root. Worktree logs take priority.`);
  }
  let result = sections.join("\n");
  if (result.length > MAX_BYTES) {
    result = result.slice(0, MAX_BYTES) + "\n\n[... truncated at 30KB ...]";
  }
  return result;
}
function redactForGitHub(text, basePath) {
  let result = text;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pathRe = (p) => new RegExp(esc(p.replace(/\\/g, "/")).replace(/\//g, "[/\\\\]"), "gi");
  result = result.replace(pathRe(basePath), ".");
  const gsdHomePath = gsdHome();
  if (!gsdHomePath.startsWith(homedir())) {
    result = result.replace(pathRe(gsdHomePath), "~/.gsd");
  }
  result = result.replace(pathRe(homedir()), "~");
  result = result.replace(/sk-[a-zA-Z0-9]{20,}/g, "sk-***");
  result = result.replace(/Bearer\s+\S+/g, "Bearer ***");
  result = result.replace(/[A-Z_]{2,}=\S+/g, (match) => {
    const eq = match.indexOf("=");
    return match.slice(0, eq + 1) + "***";
  });
  result = result.split("\n").map(
    (line) => line.length > 500 ? line.slice(0, 497) + "..." : line
  ).join("\n");
  return result;
}
export {
  buildForensicReport,
  detectStuckLoops,
  detectWorktreeOrphans,
  handleForensics,
  readForensicsMarker,
  splitCompletedKey,
  writeForensicsMarker
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9mb3JlbnNpY3MudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogR1NEIEZvcmVuc2ljcyBcdTIwMTQgUG9zdC1tb3J0ZW0gaW52ZXN0aWdhdGlvbiBvZiBhdXRvLW1vZGUgZmFpbHVyZXNcbiAqXG4gKiBQcm9ncmFtbWF0aWNhbGx5IHNjYW5zIGFjdGl2aXR5IGxvZ3MsIG1ldHJpY3MsIGNyYXNoIGxvY2tzLCBhbmQgZG9jdG9yXG4gKiBkaWFnbm9zdGljcyBmb3IgYW5vbWFsaWVzLCB0aGVuIGhhbmRzIGEgc3RydWN0dXJlZCByZXBvcnQgdG8gdGhlIExMTVxuICogZm9yIGludGVyYWN0aXZlIGludmVzdGlnYXRpb24uXG4gKlxuICogRW50cnkgcG9pbnQ6IGhhbmRsZUZvcmVuc2ljcygpIGNhbGxlZCBmcm9tIGNvbW1hbmRzLnRzXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBFeHRlbnNpb25BUEksIEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0IH0gZnJvbSBcIkBnc2QvcGktY29kaW5nLWFnZW50XCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCBta2RpclN5bmMsIHJlYWRGaWxlU3luYywgcmVhZGRpclN5bmMsIHN0YXRTeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4sIGRpcm5hbWUsIHJlbGF0aXZlIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gXCJub2RlOnVybFwiO1xuaW1wb3J0IHsgZ3NkSG9tZSB9IGZyb20gXCIuL2dzZC1ob21lLmpzXCI7XG5cbmltcG9ydCB7IGV4dHJhY3RUcmFjZSwgdHlwZSBFeGVjdXRpb25UcmFjZSB9IGZyb20gXCIuL3Nlc3Npb24tZm9yZW5zaWNzLmpzXCI7XG5pbXBvcnQgeyBuYXRpdmVQYXJzZUpzb25sVGFpbCB9IGZyb20gXCIuL25hdGl2ZS1wYXJzZXItYnJpZGdlLmpzXCI7XG5pbXBvcnQgeyBNQVhfSlNPTkxfQllURVMsIHBhcnNlSlNPTkwgfSBmcm9tIFwiLi9qc29ubC11dGlscy5qc1wiO1xuaW1wb3J0IHtcbiAgbG9hZExlZGdlckZyb21EaXNrLCBnZXRBdmVyYWdlQ29zdFBlclVuaXRUeXBlLCBnZXRQcm9qZWN0VG90YWxzLFxuICBmb3JtYXRDb3N0LCBmb3JtYXRUb2tlbkNvdW50LCB0eXBlIFVuaXRNZXRyaWNzLCB0eXBlIE1ldHJpY3NMZWRnZXIsXG59IGZyb20gXCIuL21ldHJpY3MuanNcIjtcbmltcG9ydCB7IHJlYWRDcmFzaExvY2ssIGlzTG9ja1Byb2Nlc3NBbGl2ZSwgZm9ybWF0Q3Jhc2hJbmZvLCB0eXBlIExvY2tEYXRhIH0gZnJvbSBcIi4vY3Jhc2gtcmVjb3ZlcnkuanNcIjtcbmltcG9ydCB7IHJ1bkdTRERvY3RvciwgZm9ybWF0RG9jdG9ySXNzdWVzRm9yUHJvbXB0LCB0eXBlIERvY3Rvcklzc3VlIH0gZnJvbSBcIi4vZG9jdG9yLmpzXCI7XG5pbXBvcnQgeyB2ZXJpZnlFeHBlY3RlZEFydGlmYWN0IH0gZnJvbSBcIi4vYXV0by1yZWNvdmVyeS5qc1wiO1xuaW1wb3J0IHsgZGVyaXZlU3RhdGUgfSBmcm9tIFwiLi9zdGF0ZS5qc1wiO1xuaW1wb3J0IHsgaXNBdXRvQWN0aXZlIH0gZnJvbSBcIi4vYXV0by5qc1wiO1xuaW1wb3J0IHsgbG9hZFByb21wdCB9IGZyb20gXCIuL3Byb21wdC1sb2FkZXIuanNcIjtcbmltcG9ydCB7IGdzZFJvb3QgfSBmcm9tIFwiLi9wYXRocy5qc1wiO1xuaW1wb3J0IHsgaXNEYkF2YWlsYWJsZSwgZ2V0QWxsTWlsZXN0b25lcywgZ2V0TWlsZXN0b25lU2xpY2VzLCBnZXRTbGljZVRhc2tzIH0gZnJvbSBcIi4vZ3NkLWRiLmpzXCI7XG5pbXBvcnQgeyBpc0Nsb3NlZFN0YXR1cyB9IGZyb20gXCIuL3N0YXR1cy1ndWFyZHMuanNcIjtcbmltcG9ydCB7IGZvcm1hdER1cmF0aW9uIH0gZnJvbSBcIi4uL3NoYXJlZC9mb3JtYXQtdXRpbHMuanNcIjtcbmltcG9ydCB7IGdldEF1dG9Xb3JrdHJlZVBhdGggfSBmcm9tIFwiLi9hdXRvLXdvcmt0cmVlLmpzXCI7XG5pbXBvcnQgeyBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMsIGxvYWRHbG9iYWxHU0RQcmVmZXJlbmNlcywgZ2V0R2xvYmFsR1NEUHJlZmVyZW5jZXNQYXRoIH0gZnJvbSBcIi4vcHJlZmVyZW5jZXMuanNcIjtcbmltcG9ydCB7IHNob3dOZXh0QWN0aW9uIH0gZnJvbSBcIi4uL3NoYXJlZC90dWkuanNcIjtcbmltcG9ydCB7IGVuc3VyZVByZWZlcmVuY2VzRmlsZSwgc2VyaWFsaXplUHJlZmVyZW5jZXNUb0Zyb250bWF0dGVyIH0gZnJvbSBcIi4vY29tbWFuZHMtcHJlZnMtd2l6YXJkLmpzXCI7XG5pbXBvcnQgeyBzdW1tYXJpemVXb3JrdHJlZVRlbGVtZXRyeSwgcGVyY2VudGlsZSwgdHlwZSBXb3JrdHJlZVRlbGVtZXRyeVN1bW1hcnkgfSBmcm9tIFwiLi93b3JrdHJlZS10ZWxlbWV0cnkuanNcIjtcbmltcG9ydCB7IGhvbWVkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVHlwZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBpbnRlcmZhY2UgRm9yZW5zaWNBbm9tYWx5IHtcbiAgdHlwZTogXCJzdHVjay1sb29wXCIgfCBcImNvc3Qtc3Bpa2VcIiB8IFwidGltZW91dFwiIHwgXCJtaXNzaW5nLWFydGlmYWN0XCIgfCBcImNyYXNoXCIgfCBcImRvY3Rvci1pc3N1ZVwiIHwgXCJlcnJvci10cmFjZVwiIHwgXCJqb3VybmFsLXN0dWNrXCIgfCBcImpvdXJuYWwtZ3VhcmQtYmxvY2tcIiB8IFwiam91cm5hbC1yYXBpZC1pdGVyYXRpb25zXCIgfCBcImpvdXJuYWwtd29ya3RyZWUtZmFpbHVyZVwiIHwgXCJ3b3JrdHJlZS1vcnBoYW5cIiB8IFwid29ya3RyZWUtdW5tZXJnZWQtZXhpdFwiO1xuICBzZXZlcml0eTogXCJpbmZvXCIgfCBcIndhcm5pbmdcIiB8IFwiZXJyb3JcIjtcbiAgdW5pdFR5cGU/OiBzdHJpbmc7XG4gIHVuaXRJZD86IHN0cmluZztcbiAgc3VtbWFyeTogc3RyaW5nO1xuICBkZXRhaWxzOiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBVbml0VHJhY2Uge1xuICBmaWxlOiBzdHJpbmc7XG4gIHVuaXRUeXBlOiBzdHJpbmc7XG4gIHVuaXRJZDogc3RyaW5nO1xuICBzZXE6IG51bWJlcjtcbiAgdHJhY2U6IEV4ZWN1dGlvblRyYWNlO1xuICBtdGltZTogbnVtYmVyO1xufVxuXG4vKiogU3VtbWFyeSBvZiAuZ3NkL2FjdGl2aXR5LyBkaXJlY3RvcnkgbWV0YWRhdGEuICovXG5pbnRlcmZhY2UgQWN0aXZpdHlMb2dNZXRhIHtcbiAgZmlsZUNvdW50OiBudW1iZXI7XG4gIHRvdGFsU2l6ZUJ5dGVzOiBudW1iZXI7XG4gIG9sZGVzdEZpbGU6IHN0cmluZyB8IG51bGw7XG4gIG5ld2VzdEZpbGU6IHN0cmluZyB8IG51bGw7XG59XG5cbi8qKlxuICogU3VtbWFyeSBvZiAuZ3NkL2pvdXJuYWwvIGRhdGEgZm9yIGZvcmVuc2ljIGludmVzdGlnYXRpb24uXG4gKlxuICogVG8gYXZvaWQgbG9hZGluZyBodWdlIGpvdXJuYWwgaGlzdG9yaWVzIGludG8gbWVtb3J5LCBvbmx5IHRoZSBtb3N0IHJlY2VudFxuICogZGFpbHkgZmlsZXMgYXJlIGZ1bGx5IHBhcnNlZC4gT2xkZXIgZmlsZXMgYXJlIGxpbmUtY291bnRlZCBmb3IgdG90YWxzLlxuICogRXZlbnQgY291bnRzIGFuZCBmbG93IElEcyByZWZsZWN0IG9ubHkgcmVjZW50IGZpbGVzLlxuICovXG5pbnRlcmZhY2UgSm91cm5hbFN1bW1hcnkge1xuICAvKiogVG90YWwgam91cm5hbCBlbnRyaWVzIGFjcm9zcyBhbGwgZmlsZXMgKHJlY2VudCBwYXJzZWQgKyBvbGRlciBsaW5lLWNvdW50ZWQpICovXG4gIHRvdGFsRW50cmllczogbnVtYmVyO1xuICAvKiogRGlzdGluY3QgZmxvdyBJRHMgZnJvbSByZWNlbnQgZmlsZXMgKGVhY2ggPSBvbmUgYXV0by1tb2RlIGl0ZXJhdGlvbikgKi9cbiAgZmxvd0NvdW50OiBudW1iZXI7XG4gIC8qKiBFdmVudCBjb3VudHMgYnkgdHlwZSAoZnJvbSByZWNlbnQgZmlsZXMgb25seSkgKi9cbiAgZXZlbnRDb3VudHM6IFJlY29yZDxzdHJpbmcsIG51bWJlcj47XG4gIC8qKiBNb3N0IHJlY2VudCBqb3VybmFsIGVudHJpZXMgKGxhc3QgMjApIGZvciBjb250ZXh0ICovXG4gIHJlY2VudEV2ZW50czogeyB0czogc3RyaW5nOyBmbG93SWQ6IHN0cmluZzsgZXZlbnRUeXBlOiBzdHJpbmc7IHJ1bGU/OiBzdHJpbmc7IHVuaXRJZD86IHN0cmluZyB9W107XG4gIC8qKiBEYXRlIHJhbmdlIG9mIGpvdXJuYWwgZGF0YSAqL1xuICBvbGRlc3RFbnRyeTogc3RyaW5nIHwgbnVsbDtcbiAgbmV3ZXN0RW50cnk6IHN0cmluZyB8IG51bGw7XG4gIC8qKiBEYWlseSBmaWxlIGNvdW50ICovXG4gIGZpbGVDb3VudDogbnVtYmVyO1xufVxuXG5pbnRlcmZhY2UgRGJDb21wbGV0aW9uQ291bnRzIHtcbiAgbWlsZXN0b25lczogbnVtYmVyO1xuICBtaWxlc3RvbmVzVG90YWw6IG51bWJlcjtcbiAgc2xpY2VzOiBudW1iZXI7XG4gIHNsaWNlc1RvdGFsOiBudW1iZXI7XG4gIHRhc2tzOiBudW1iZXI7XG4gIHRhc2tzVG90YWw6IG51bWJlcjtcbn1cblxuaW50ZXJmYWNlIEZvcmVuc2ljUmVwb3J0IHtcbiAgZ3NkVmVyc2lvbjogc3RyaW5nO1xuICB0aW1lc3RhbXA6IHN0cmluZztcbiAgYmFzZVBhdGg6IHN0cmluZztcbiAgYWN0aXZlTWlsZXN0b25lOiBzdHJpbmcgfCBudWxsO1xuICBhY3RpdmVTbGljZTogc3RyaW5nIHwgbnVsbDtcbiAgYWN0aXZlV29ya3RyZWU6IHN0cmluZyB8IG51bGw7XG4gIHVuaXRUcmFjZXM6IFVuaXRUcmFjZVtdO1xuICBtZXRyaWNzOiBNZXRyaWNzTGVkZ2VyIHwgbnVsbDtcbiAgY29tcGxldGVkS2V5czogc3RyaW5nW107XG4gIGRiQ29tcGxldGlvbkNvdW50czogRGJDb21wbGV0aW9uQ291bnRzIHwgbnVsbDtcbiAgY3Jhc2hMb2NrOiBMb2NrRGF0YSB8IG51bGw7XG4gIGRvY3Rvcklzc3VlczogRG9jdG9ySXNzdWVbXTtcbiAgYW5vbWFsaWVzOiBGb3JlbnNpY0Fub21hbHlbXTtcbiAgcmVjZW50VW5pdHM6IHsgdHlwZTogc3RyaW5nOyBpZDogc3RyaW5nOyBjb3N0OiBudW1iZXI7IGR1cmF0aW9uOiBudW1iZXI7IG1vZGVsOiBzdHJpbmc7IGZpbmlzaGVkQXQ6IG51bWJlciB9W107XG4gIGpvdXJuYWxTdW1tYXJ5OiBKb3VybmFsU3VtbWFyeSB8IG51bGw7XG4gIGFjdGl2aXR5TG9nTWV0YTogQWN0aXZpdHlMb2dNZXRhIHwgbnVsbDtcbiAgLyoqICM0NzY0IFx1MjAxNCB3b3JrdHJlZSBsaWZlc3BhbiAvIGRpdmVyZ2VuY2UgdGVsZW1ldHJ5IGFnZ3JlZ2F0ZXMuICovXG4gIHdvcmt0cmVlVGVsZW1ldHJ5OiBXb3JrdHJlZVRlbGVtZXRyeVN1bW1hcnkgfCBudWxsO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRHVwbGljYXRlIERldGVjdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuY29uc3QgREVEVVBfUFJPTVBUX1NFQ1RJT04gPSBgXG4jIyBQcmUtSW52ZXN0aWdhdGlvbjogRHVwbGljYXRlIENoZWNrIChSRVFVSVJFRClcblxuQmVmb3JlIHJlYWRpbmcgR1NEIHNvdXJjZSBjb2RlIG9yIHBlcmZvcm1pbmcgZGVlcCBhbmFseXNpcywgeW91IE1VU1Qgc2VhcmNoIGZvciBleGlzdGluZyBpc3N1ZXMgYW5kIFBScyB0aGF0IG1heSBhbHJlYWR5IGFkZHJlc3MgdGhpcyBidWcuIFRoaXMgYXZvaWRzIHdhc3RpbmcgdG9rZW5zIG9uIGFscmVhZHktZml4ZWQgYnVncy5cblxuIyMjIFNlYXJjaCBTdGVwc1xuXG5Vc2Uga2V5d29yZHMgZnJvbSB0aGUgdXNlcidzIHByb2JsZW0gZGVzY3JpcHRpb24gYW5kIHRoZSBhbm9tYWx5IHN1bW1hcmllcyBpbiB0aGUgZm9yZW5zaWMgcmVwb3J0IGFib3ZlLlxuXG4xLiAqKlNlYXJjaCBjbG9zZWQgaXNzdWVzKiogZm9yIHNpbWlsYXIga2V5d29yZHM6XG4gICBcXGBcXGBcXGBcbiAgIGdoIGlzc3VlIGxpc3QgLS1yZXBvIGdzZC1idWlsZC9nc2QtMiAtLXN0YXRlIGNsb3NlZCAtLXNlYXJjaCBcIjxrZXl3b3JkcyBmcm9tIHJvb3QgY2F1c2U+XCIgLS1saW1pdCAyMFxuICAgXFxgXFxgXFxgXG5cbjIuICoqU2VhcmNoIG9wZW4gUFJzKiogdGhhdCBtaWdodCBjb250YWluIHRoZSBmaXg6XG4gICBcXGBcXGBcXGBcbiAgIGdoIHByIGxpc3QgLS1yZXBvIGdzZC1idWlsZC9nc2QtMiAtLXN0YXRlIG9wZW4gLS1zZWFyY2ggXCI8a2V5d29yZHM+XCIgLS1saW1pdCAxMFxuICAgXFxgXFxgXFxgXG5cbjMuICoqU2VhcmNoIG1lcmdlZCBQUnMqKiB0aGF0IG1heSBoYXZlIGFscmVhZHkgZml4ZWQgdGhpczpcbiAgIFxcYFxcYFxcYFxuICAgZ2ggcHIgbGlzdCAtLXJlcG8gZ3NkLWJ1aWxkL2dzZC0yIC0tc3RhdGUgbWVyZ2VkIC0tc2VhcmNoIFwiPGtleXdvcmRzPlwiIC0tbGltaXQgMTBcbiAgIFxcYFxcYFxcYFxuXG4jIyMgQW5hbHlzaXNcblxuRm9yIGVhY2ggcmVzdWx0LCBjb21wYXJlIGl0IGFnYWluc3QgdGhlIHVzZXIncyByZXBvcnRlZCBzeW1wdG9tcyBhbmQgdGhlIGZvcmVuc2ljIGFub21hbGllczpcbi0gRG9lcyB0aGUgaXNzdWUgZGVzY3JpYmUgdGhlIHNhbWUgY29kZSBwYXRoIG9yIGZpbGU/XG4tIERvZXMgdGhlIFBSIG1vZGlmeSB0aGUgYXJlYSByZWxhdGVkIHRvIHRoZSByZXBvcnRlZCBzeW1wdG9tcz9cbi0gSXMgdGhlIHN5bXB0b20gZGVzY3JpcHRpb24gc2VtYW50aWNhbGx5IHNpbWlsYXIgZXZlbiBpZiBrZXl3b3JkcyBkaWZmZXI/XG5cbiMjIyBEZWNpc2lvbiBHYXRlXG5cbi0gKipNZXJnZWQgUFIgY2xlYXJseSBmaXhlcyB0aGUgZGVzY3JpYmVkIHN5bXB0b20qKiBcdTIxOTIgUmVwb3J0IFwiQWxyZWFkeSBmaXhlZCBieSBQUiAjWFwiIHdpdGggYnJpZWYgZXhwbGFuYXRpb24uIFNraXAgZnVsbCBpbnZlc3RpZ2F0aW9uLlxuLSAqKk9wZW4gaXNzdWUgbWF0Y2hlcyoqIFx1MjE5MiBSZXBvcnQgXCJFeGlzdGluZyBpc3N1ZSAjWSBjb3ZlcnMgdGhpcy5cIiBPZmZlciB0byBhZGQgZm9yZW5zaWMgZXZpZGVuY2UuIFNraXAgZnVsbCBpbnZlc3RpZ2F0aW9uIHVubGVzcyB1c2VyIGFza3MgZm9yIGRlZXBlciBhbmFseXNpcy5cbi0gKipObyBtYXRjaGVzKiogXHUyMTkyIFByb2NlZWQgdG8gZnVsbCBpbnZlc3RpZ2F0aW9uIGJlbG93LlxuYDtcblxuYXN5bmMgZnVuY3Rpb24gd3JpdGVGb3JlbnNpY3NEZWR1cFByZWYoY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCwgZW5hYmxlZDogYm9vbGVhbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBwcmVmc1BhdGggPSBnZXRHbG9iYWxHU0RQcmVmZXJlbmNlc1BhdGgoKTtcbiAgYXdhaXQgZW5zdXJlUHJlZmVyZW5jZXNGaWxlKHByZWZzUGF0aCwgY3R4LCBcImdsb2JhbFwiKTtcbiAgY29uc3QgZXhpc3RpbmcgPSBsb2FkR2xvYmFsR1NEUHJlZmVyZW5jZXMoKTtcbiAgY29uc3QgcHJlZnM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0gZXhpc3Rpbmc/LnByZWZlcmVuY2VzID8geyAuLi5leGlzdGluZy5wcmVmZXJlbmNlcyB9IDoge307XG4gIHByZWZzLnZlcnNpb24gPSBwcmVmcy52ZXJzaW9uIHx8IDE7XG4gIHByZWZzLmZvcmVuc2ljc19kZWR1cCA9IGVuYWJsZWQ7XG5cbiAgY29uc3QgZnJvbnRtYXR0ZXIgPSBzZXJpYWxpemVQcmVmZXJlbmNlc1RvRnJvbnRtYXR0ZXIocHJlZnMpO1xuICBjb25zdCByYXcgPSBleGlzdHNTeW5jKHByZWZzUGF0aCkgPyByZWFkRmlsZVN5bmMocHJlZnNQYXRoLCBcInV0Zi04XCIpIDogXCJcIjtcbiAgbGV0IGJvZHkgPSBcIlxcbiMgR1NEIFNraWxsIFByZWZlcmVuY2VzXFxuXFxuU2VlIGB+Ly5nc2QvYWdlbnQvZXh0ZW5zaW9ucy9nc2QvZG9jcy9wcmVmZXJlbmNlcy1yZWZlcmVuY2UubWRgIGZvciBmdWxsIGZpZWxkIGRvY3VtZW50YXRpb24gYW5kIGV4YW1wbGVzLlxcblwiO1xuICBjb25zdCBzdGFydCA9IHJhdy5zdGFydHNXaXRoKFwiLS0tXFxuXCIpID8gNCA6IHJhdy5zdGFydHNXaXRoKFwiLS0tXFxyXFxuXCIpID8gNSA6IC0xO1xuICBpZiAoc3RhcnQgIT09IC0xKSB7XG4gICAgY29uc3QgY2xvc2luZ0lkeCA9IHJhdy5pbmRleE9mKFwiXFxuLS0tXCIsIHN0YXJ0KTtcbiAgICBpZiAoY2xvc2luZ0lkeCAhPT0gLTEpIHtcbiAgICAgIGNvbnN0IGFmdGVyID0gcmF3LnNsaWNlKGNsb3NpbmdJZHggKyA0KTtcbiAgICAgIGlmIChhZnRlci50cmltKCkpIGJvZHkgPSBhZnRlcjtcbiAgICB9XG4gIH1cblxuICB3cml0ZUZpbGVTeW5jKHByZWZzUGF0aCwgYC0tLVxcbiR7ZnJvbnRtYXR0ZXJ9LS0tJHtib2R5fWAsIFwidXRmLThcIik7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBFbnRyeSBQb2ludCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZUZvcmVuc2ljcyhcbiAgYXJnczogc3RyaW5nLFxuICBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LFxuICBwaTogRXh0ZW5zaW9uQVBJLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGlmIChpc0F1dG9BY3RpdmUoKSkge1xuICAgIGN0eC51aS5ub3RpZnkoXCJDYW5ub3QgcnVuIGZvcmVuc2ljcyB3aGlsZSBhdXRvLW1vZGUgaXMgYWN0aXZlLiBTdG9wIGF1dG8tbW9kZSBmaXJzdC5cIiwgXCJlcnJvclwiKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBiYXNlUGF0aCA9IHByb2Nlc3MuY3dkKCk7XG4gIGNvbnN0IHJvb3QgPSBnc2RSb290KGJhc2VQYXRoKTtcbiAgaWYgKCFleGlzdHNTeW5jKHJvb3QpKSB7XG4gICAgY3R4LnVpLm5vdGlmeShcIk5vIEdTRCBzdGF0ZSBmb3VuZC4gUnVuIC9nc2QgYXV0byBmaXJzdC5cIiwgXCJ3YXJuaW5nXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGxldCBwcm9ibGVtRGVzY3JpcHRpb24gPSBhcmdzLnRyaW0oKTtcbiAgaWYgKCFwcm9ibGVtRGVzY3JpcHRpb24pIHtcbiAgICBwcm9ibGVtRGVzY3JpcHRpb24gPSBhd2FpdCBjdHgudWkuaW5wdXQoXG4gICAgICBcIkRlc2NyaWJlIHdoYXQgd2VudCB3cm9uZzpcIixcbiAgICAgIFwiZS5nLiBhdXRvLW1vZGUgZ290IHN0dWNrIG9uIHRhc2sgVDAzXCIsXG4gICAgKSA/PyBcIlwiO1xuICB9XG4gIGlmICghcHJvYmxlbURlc2NyaXB0aW9uPy50cmltKCkpIHtcbiAgICBjdHgudWkubm90aWZ5KFwiUHJvYmxlbSBkZXNjcmlwdGlvbiByZXF1aXJlZCBmb3IgZm9yZW5zaWMgYW5hbHlzaXMuXCIsIFwid2FybmluZ1wiKTtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgRHVwbGljYXRlIGRldGVjdGlvbiBvcHQtaW4gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGNvbnN0IGVmZmVjdGl2ZVByZWZzID0gbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzKCk/LnByZWZlcmVuY2VzO1xuICBsZXQgZGVkdXBFbmFibGVkID0gZWZmZWN0aXZlUHJlZnM/LmZvcmVuc2ljc19kZWR1cCA9PT0gdHJ1ZTtcblxuICBpZiAoZWZmZWN0aXZlUHJlZnM/LmZvcmVuc2ljc19kZWR1cCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgY29uc3QgY2hvaWNlID0gYXdhaXQgc2hvd05leHRBY3Rpb24oY3R4LCB7XG4gICAgICB0aXRsZTogXCJEdXBsaWNhdGUgZGV0ZWN0aW9uIGF2YWlsYWJsZVwiLFxuICAgICAgc3VtbWFyeTogW1wiQmVmb3JlIGZpbGluZyBhIEdpdEh1YiBpc3N1ZSwgZm9yZW5zaWNzIGNhbiBzZWFyY2ggZXhpc3RpbmcgaXNzdWVzIGFuZCBQUnMgdG8gYXZvaWQgZHVwbGljYXRlcy5cIiwgXCJUaGlzIHVzZXMgYWRkaXRpb25hbCBBSSB0b2tlbnMgZm9yIGFuYWx5c2lzLlwiXSxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgeyBpZDogXCJlbmFibGVcIiwgbGFiZWw6IFwiRW5hYmxlIGR1cGxpY2F0ZSBkZXRlY3Rpb25cIiwgZGVzY3JpcHRpb246IFwiU2VhcmNoIGlzc3Vlcy9QUnMgYmVmb3JlIGZpbGluZyAocmVjb21tZW5kZWQpXCIsIHJlY29tbWVuZGVkOiB0cnVlIH0sXG4gICAgICAgIHsgaWQ6IFwic2tpcFwiLCBsYWJlbDogXCJTa2lwIGZvciBub3dcIiwgZGVzY3JpcHRpb246IFwiRmlsZSB3aXRob3V0IGNoZWNraW5nIGZvciBkdXBsaWNhdGVzXCIgfSxcbiAgICAgIF0sXG4gICAgICBub3RZZXRNZXNzYWdlOiBcIllvdSBjYW4gZW5hYmxlIHRoaXMgbGF0ZXIgdmlhIHByZWZlcmVuY2VzIChmb3JlbnNpY3NfZGVkdXA6IHRydWUpLlwiLFxuICAgIH0pO1xuXG4gICAgaWYgKGNob2ljZSA9PT0gXCJlbmFibGVcIikge1xuICAgICAgYXdhaXQgd3JpdGVGb3JlbnNpY3NEZWR1cFByZWYoY3R4LCB0cnVlKTtcbiAgICAgIGRlZHVwRW5hYmxlZCA9IHRydWU7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgZGVkdXBTZWN0aW9uID0gZGVkdXBFbmFibGVkID8gREVEVVBfUFJPTVBUX1NFQ1RJT04gOiBcIlwiO1xuXG4gIGN0eC51aS5ub3RpZnkoXCJCdWlsZGluZyBmb3JlbnNpYyByZXBvcnQuLi5cIiwgXCJpbmZvXCIpO1xuXG4gIGNvbnN0IHJlcG9ydCA9IGF3YWl0IGJ1aWxkRm9yZW5zaWNSZXBvcnQoYmFzZVBhdGgpO1xuICBjb25zdCBzYXZlZFBhdGggPSBzYXZlRm9yZW5zaWNSZXBvcnQoYmFzZVBhdGgsIHJlcG9ydCwgcHJvYmxlbURlc2NyaXB0aW9uKTtcblxuICAvLyBEZXJpdmUgR1NEIHNvdXJjZSBkaXIgZm9yIHByb21wdCBcdTIwMTQgZmFsbCBiYWNrIHRvIH4vLmdzZC9hZ2VudC9leHRlbnNpb25zL2dzZC9cbiAgLy8gd2hlbiBpbXBvcnQubWV0YS51cmwgcmVzb2x2ZXMgdG8gdGhlIG5wbS1nbG9iYWwgaW5zdGFsbCBwYXRoIChXaW5kb3dzKS5cbiAgbGV0IGdzZFNvdXJjZURpciA9IGRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKTtcbiAgaWYgKCFleGlzdHNTeW5jKGpvaW4oZ3NkU291cmNlRGlyLCBcInByb21wdHNcIikpKSB7XG4gICAgY29uc3QgZmFsbGJhY2sgPSBqb2luKGdzZEhvbWUoKSwgXCJhZ2VudFwiLCBcImV4dGVuc2lvbnNcIiwgXCJnc2RcIik7XG4gICAgaWYgKGV4aXN0c1N5bmMoam9pbihmYWxsYmFjaywgXCJwcm9tcHRzXCIpKSkgZ3NkU291cmNlRGlyID0gZmFsbGJhY2s7XG4gIH1cblxuICBjb25zdCBmb3JlbnNpY0RhdGEgPSBmb3JtYXRSZXBvcnRGb3JQcm9tcHQocmVwb3J0KTtcbiAgY29uc3QgY29udGVudCA9IGxvYWRQcm9tcHQoXCJmb3JlbnNpY3NcIiwge1xuICAgIHByb2JsZW1EZXNjcmlwdGlvbixcbiAgICBmb3JlbnNpY0RhdGEsXG4gICAgZ3NkU291cmNlRGlyLFxuICAgIGRlZHVwU2VjdGlvbixcbiAgfSk7XG5cbiAgY3R4LnVpLm5vdGlmeShgRm9yZW5zaWMgcmVwb3J0IHNhdmVkOiAke3JlbGF0aXZlKGJhc2VQYXRoLCBzYXZlZFBhdGgpfWAsIFwiaW5mb1wiKTtcblxuICBwaS5zZW5kTWVzc2FnZShcbiAgICB7IGN1c3RvbVR5cGU6IFwiZ3NkLWZvcmVuc2ljc1wiLCBjb250ZW50LCBkaXNwbGF5OiBmYWxzZSB9LFxuICAgIHsgdHJpZ2dlclR1cm46IHRydWUgfSxcbiAgKTtcblxuICAvLyBQZXJzaXN0IGZvcmVuc2ljcyBjb250ZXh0IHNvIGZvbGxvdy11cCB0dXJucyBjYW4gcmUtaW5qZWN0IGl0ICgjMjk0MSlcbiAgd3JpdGVGb3JlbnNpY3NNYXJrZXIoYmFzZVBhdGgsIHNhdmVkUGF0aCwgY29udGVudCk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBSZXBvcnQgQnVpbGRlciBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGJ1aWxkRm9yZW5zaWNSZXBvcnQoYmFzZVBhdGg6IHN0cmluZyk6IFByb21pc2U8Rm9yZW5zaWNSZXBvcnQ+IHtcbiAgY29uc3QgYW5vbWFsaWVzOiBGb3JlbnNpY0Fub21hbHlbXSA9IFtdO1xuXG4gIC8vIDEuIERlcml2ZSBjdXJyZW50IHN0YXRlXG4gIGxldCBhY3RpdmVNaWxlc3RvbmU6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBsZXQgYWN0aXZlU2xpY2U6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICB0cnkge1xuICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZVBhdGgpO1xuICAgIGFjdGl2ZU1pbGVzdG9uZSA9IHN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQgPz8gbnVsbDtcbiAgICBhY3RpdmVTbGljZSA9IHN0YXRlLmFjdGl2ZVNsaWNlPy5pZCA/PyBudWxsO1xuICB9IGNhdGNoIHsgLyogc3RhdGUgZGVyaXZhdGlvbiBmYWlsdXJlIGlzIG5vbi1mYXRhbCAqLyB9XG5cbiAgLy8gMWIuIENoZWNrIGZvciBhY3RpdmUgYXV0by13b3JrdHJlZVxuICBjb25zdCBhY3RpdmVXb3JrdHJlZSA9IGFjdGl2ZU1pbGVzdG9uZSA/IGdldEF1dG9Xb3JrdHJlZVBhdGgoYmFzZVBhdGgsIGFjdGl2ZU1pbGVzdG9uZSkgOiBudWxsO1xuXG4gIC8vIDIuIFNjYW4gYWN0aXZpdHkgbG9ncyAobGFzdCA1KSBcdTIwMTQgd29ya3RyZWUtYXdhcmVcbiAgY29uc3QgdW5pdFRyYWNlcyA9IHNjYW5BY3Rpdml0eUxvZ3MoYmFzZVBhdGgsIGFjdGl2ZU1pbGVzdG9uZSk7XG5cbiAgLy8gMy4gTG9hZCBtZXRyaWNzXG4gIGNvbnN0IG1ldHJpY3MgPSBsb2FkTGVkZ2VyRnJvbURpc2soYmFzZVBhdGgpO1xuXG4gIC8vIDQuIExvYWQgY29tcGxldGVkIGtleXMgKGxlZ2FjeSkgYW5kIERCIGNvbXBsZXRpb24gY291bnRzXG4gIGNvbnN0IGNvbXBsZXRlZEtleXMgPSBsb2FkQ29tcGxldGVkS2V5cyhiYXNlUGF0aCk7XG4gIGNvbnN0IGRiQ29tcGxldGlvbkNvdW50cyA9IGdldERiQ29tcGxldGlvbkNvdW50cygpO1xuXG4gIC8vIDUuIENoZWNrIGNyYXNoIGxvY2tcbiAgY29uc3QgY3Jhc2hMb2NrID0gcmVhZENyYXNoTG9jayhiYXNlUGF0aCk7XG5cbiAgLy8gNi4gUnVuIGRvY3RvclxuICBsZXQgZG9jdG9ySXNzdWVzOiBEb2N0b3JJc3N1ZVtdID0gW107XG4gIHRyeSB7XG4gICAgY29uc3QgcmVwb3J0ID0gYXdhaXQgcnVuR1NERG9jdG9yKGJhc2VQYXRoLCB7IHNjb3BlOiB1bmRlZmluZWQgfSk7XG4gICAgZG9jdG9ySXNzdWVzID0gcmVwb3J0Lmlzc3VlcztcbiAgfSBjYXRjaCB7IC8qIGRvY3RvciBmYWlsdXJlIGlzIG5vbi1mYXRhbCAqLyB9XG5cbiAgLy8gNy4gQnVpbGQgcmVjZW50IHVuaXRzIGZyb20gbWV0cmljc1xuICBjb25zdCByZWNlbnRVbml0czogRm9yZW5zaWNSZXBvcnRbXCJyZWNlbnRVbml0c1wiXSA9IFtdO1xuICBpZiAobWV0cmljcz8udW5pdHMpIHtcbiAgICBjb25zdCBzb3J0ZWQgPSBbLi4ubWV0cmljcy51bml0c10uc29ydCgoYSwgYikgPT4gYi5maW5pc2hlZEF0IC0gYS5maW5pc2hlZEF0KS5zbGljZSgwLCAxMCk7XG4gICAgZm9yIChjb25zdCB1IG9mIHNvcnRlZCkge1xuICAgICAgcmVjZW50VW5pdHMucHVzaCh7XG4gICAgICAgIHR5cGU6IHUudHlwZSxcbiAgICAgICAgaWQ6IHUuaWQsXG4gICAgICAgIGNvc3Q6IHUuY29zdCxcbiAgICAgICAgZHVyYXRpb246IHUuZmluaXNoZWRBdCAtIHUuc3RhcnRlZEF0LFxuICAgICAgICBtb2RlbDogdS5tb2RlbCxcbiAgICAgICAgZmluaXNoZWRBdDogdS5maW5pc2hlZEF0LFxuICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgLy8gOC4gR1NEIHZlcnNpb24gXHUyMDE0IHVzZSBHU0RfVkVSU0lPTiBlbnYgdmFyIHNldCBieSB0aGUgbG9hZGVyIGF0IHN0YXJ0dXAuXG4gIC8vIEV4dGVuc2lvbnMgcnVuIGZyb20gfi8uZ3NkL2FnZW50L2V4dGVuc2lvbnMvZ3NkLyBhdCBydW50aW1lLCBzbyBwYXRoLXRyYXZlcnNhbFxuICAvLyBmcm9tIGltcG9ydC5tZXRhLnVybCB3b3VsZCByZXNvbHZlIHRvIH4vcGFja2FnZS5qc29uICh3cm9uZyBvbiBldmVyeSBzeXN0ZW0pLlxuICBjb25zdCBnc2RWZXJzaW9uID0gcHJvY2Vzcy5lbnYuR1NEX1ZFUlNJT04gfHwgXCJ1bmtub3duXCI7XG5cbiAgLy8gOS4gU2NhbiBqb3VybmFsIGZvciBmbG93IHRpbWVsaW5lIGFuZCBzdHJ1Y3R1cmVkIGV2ZW50c1xuICBjb25zdCBqb3VybmFsU3VtbWFyeSA9IHNjYW5Kb3VybmFsRm9yRm9yZW5zaWNzKGJhc2VQYXRoKTtcblxuICAvLyAxMC4gR2F0aGVyIGFjdGl2aXR5IGxvZyBkaXJlY3RvcnkgbWV0YWRhdGFcbiAgY29uc3QgYWN0aXZpdHlMb2dNZXRhID0gZ2F0aGVyQWN0aXZpdHlMb2dNZXRhKGJhc2VQYXRoLCBhY3RpdmVNaWxlc3RvbmUpO1xuXG4gIC8vIDExLiBSdW4gYW5vbWFseSBkZXRlY3RvcnNcbiAgaWYgKG1ldHJpY3M/LnVuaXRzKSBkZXRlY3RTdHVja0xvb3BzKG1ldHJpY3MudW5pdHMsIGFub21hbGllcyk7XG4gIGlmIChtZXRyaWNzPy51bml0cykgZGV0ZWN0Q29zdFNwaWtlcyhtZXRyaWNzLnVuaXRzLCBhbm9tYWxpZXMpO1xuICBkZXRlY3RUaW1lb3V0cyh1bml0VHJhY2VzLCBhbm9tYWxpZXMpO1xuICBkZXRlY3RNaXNzaW5nQXJ0aWZhY3RzKGNvbXBsZXRlZEtleXMsIGJhc2VQYXRoLCBhY3RpdmVNaWxlc3RvbmUsIGFub21hbGllcyk7XG4gIGRldGVjdENyYXNoKGNyYXNoTG9jaywgYW5vbWFsaWVzKTtcbiAgZGV0ZWN0RG9jdG9ySXNzdWVzKGRvY3Rvcklzc3VlcywgYW5vbWFsaWVzKTtcbiAgZGV0ZWN0RXJyb3JUcmFjZXModW5pdFRyYWNlcywgYW5vbWFsaWVzKTtcblxuICAvLyAxMWIuICM0NzY0IFx1MjAxNCB3b3JrdHJlZSBsaWZlY3ljbGUgdGVsZW1ldHJ5XG4gIGxldCB3b3JrdHJlZVRlbGVtZXRyeTogV29ya3RyZWVUZWxlbWV0cnlTdW1tYXJ5IHwgbnVsbCA9IG51bGw7XG4gIHRyeSB7XG4gICAgd29ya3RyZWVUZWxlbWV0cnkgPSBzdW1tYXJpemVXb3JrdHJlZVRlbGVtZXRyeShiYXNlUGF0aCk7XG4gICAgZGV0ZWN0V29ya3RyZWVPcnBoYW5zKHdvcmt0cmVlVGVsZW1ldHJ5LCBhbm9tYWxpZXMpO1xuICB9IGNhdGNoIHtcbiAgICAvLyBUZWxlbWV0cnkgaXMgYmVzdC1lZmZvcnQgXHUyMDE0IGRvIG5vdCBsZXQgYW4gYWdncmVnYXRvciBmYWlsdXJlIGJsb2NrIHRoZVxuICAgIC8vIHJlc3Qgb2YgdGhlIGZvcmVuc2ljIHJlcG9ydC5cbiAgfVxuICBkZXRlY3RKb3VybmFsQW5vbWFsaWVzKGpvdXJuYWxTdW1tYXJ5LCBhbm9tYWxpZXMpO1xuXG4gIHJldHVybiB7XG4gICAgZ3NkVmVyc2lvbixcbiAgICB0aW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICBiYXNlUGF0aCxcbiAgICBhY3RpdmVNaWxlc3RvbmUsXG4gICAgYWN0aXZlU2xpY2UsXG4gICAgYWN0aXZlV29ya3RyZWU6IGFjdGl2ZVdvcmt0cmVlID8gcmVsYXRpdmUoYmFzZVBhdGgsIGFjdGl2ZVdvcmt0cmVlKSA6IG51bGwsXG4gICAgdW5pdFRyYWNlcyxcbiAgICBtZXRyaWNzLFxuICAgIGNvbXBsZXRlZEtleXMsXG4gICAgZGJDb21wbGV0aW9uQ291bnRzLFxuICAgIGNyYXNoTG9jayxcbiAgICBkb2N0b3JJc3N1ZXMsXG4gICAgYW5vbWFsaWVzLFxuICAgIHJlY2VudFVuaXRzLFxuICAgIGpvdXJuYWxTdW1tYXJ5LFxuICAgIGFjdGl2aXR5TG9nTWV0YSxcbiAgICB3b3JrdHJlZVRlbGVtZXRyeSxcbiAgfTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEFjdGl2aXR5IExvZyBTY2FubmVyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5jb25zdCBBQ1RJVklUWV9GSUxFTkFNRV9SRSA9IC9eKFxcZCspLSguKz8pLSguKylcXC5qc29ubCQvO1xuXG4vKiogVGhyZXNob2xkIGJlbG93IHdoaWNoIGl0ZXJhdGlvbiBjYWRlbmNlIGlzIGNvbnNpZGVyZWQgcmFwaWQgKHRocmFzaGluZykuICovXG5jb25zdCBSQVBJRF9JVEVSQVRJT05fVEhSRVNIT0xEX01TID0gNTAwMDtcblxuZnVuY3Rpb24gc2NhbkFjdGl2aXR5TG9ncyhiYXNlUGF0aDogc3RyaW5nLCBhY3RpdmVNaWxlc3RvbmU/OiBzdHJpbmcgfCBudWxsKTogVW5pdFRyYWNlW10ge1xuICBjb25zdCBhY3Rpdml0eURpcnMgPSByZXNvbHZlQWN0aXZpdHlEaXJzKGJhc2VQYXRoLCBhY3RpdmVNaWxlc3RvbmUpO1xuICBjb25zdCBhbGxUcmFjZXM6IFVuaXRUcmFjZVtdID0gW107XG5cbiAgZm9yIChjb25zdCBhY3Rpdml0eURpciBvZiBhY3Rpdml0eURpcnMpIHtcbiAgICBpZiAoIWV4aXN0c1N5bmMoYWN0aXZpdHlEaXIpKSBjb250aW51ZTtcblxuICAgIGNvbnN0IGZpbGVzID0gcmVhZGRpclN5bmMoYWN0aXZpdHlEaXIpLmZpbHRlcihmID0+IGYuZW5kc1dpdGgoXCIuanNvbmxcIikpLnNvcnQoKTtcbiAgICBjb25zdCBsYXN0RmlsZXMgPSBmaWxlcy5zbGljZSgtNSk7XG5cbiAgICBmb3IgKGNvbnN0IGZpbGUgb2YgbGFzdEZpbGVzKSB7XG4gICAgICBjb25zdCBtYXRjaCA9IEFDVElWSVRZX0ZJTEVOQU1FX1JFLmV4ZWMoZmlsZSk7XG4gICAgICBpZiAoIW1hdGNoKSBjb250aW51ZTtcblxuICAgICAgY29uc3Qgc2VxID0gcGFyc2VJbnQobWF0Y2hbMV0hLCAxMCk7XG4gICAgICBjb25zdCB1bml0VHlwZSA9IG1hdGNoWzJdITtcbiAgICAgIGNvbnN0IHVuaXRJZCA9IG1hdGNoWzNdITtcbiAgICAgIGNvbnN0IGZpbGVQYXRoID0gam9pbihhY3Rpdml0eURpciwgZmlsZSk7XG5cbiAgICAgIGxldCBlbnRyaWVzOiB1bmtub3duW10gPSBbXTtcbiAgICAgIGNvbnN0IG5hdGl2ZVJlc3VsdCA9IG5hdGl2ZVBhcnNlSnNvbmxUYWlsKGZpbGVQYXRoLCBNQVhfSlNPTkxfQllURVMpO1xuICAgICAgaWYgKG5hdGl2ZVJlc3VsdCkge1xuICAgICAgICBlbnRyaWVzID0gbmF0aXZlUmVzdWx0LmVudHJpZXM7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IHJhdyA9IHJlYWRGaWxlU3luYyhmaWxlUGF0aCwgXCJ1dGYtOFwiKTtcbiAgICAgICAgICBlbnRyaWVzID0gcGFyc2VKU09OTChyYXcpO1xuICAgICAgICB9IGNhdGNoIHsgY29udGludWU7IH1cbiAgICAgIH1cblxuICAgICAgY29uc3QgdHJhY2UgPSBleHRyYWN0VHJhY2UoZW50cmllcyk7XG4gICAgICBjb25zdCBzdGF0ID0gc3RhdFN5bmMoZmlsZVBhdGgsIHsgdGhyb3dJZk5vRW50cnk6IGZhbHNlIH0pO1xuXG4gICAgICBhbGxUcmFjZXMucHVzaCh7XG4gICAgICAgIGZpbGU6IGFjdGl2aXR5RGlycy5sZW5ndGggPiAxID8gYFske3JlbGF0aXZlKGJhc2VQYXRoLCBhY3Rpdml0eURpcil9XSAke2ZpbGV9YCA6IGZpbGUsXG4gICAgICAgIHVuaXRUeXBlLFxuICAgICAgICB1bml0SWQsXG4gICAgICAgIHNlcSxcbiAgICAgICAgdHJhY2UsXG4gICAgICAgIG10aW1lOiBzdGF0Py5tdGltZU1zID8/IDAsXG4gICAgICB9KTtcbiAgICB9XG4gIH1cblxuICAvLyBTb3J0IGJ5IG10aW1lIGRlc2NlbmRpbmcgc28gdGhlIG1vc3QgcmVjZW50IHRyYWNlcyAocmVnYXJkbGVzcyBvZiBzb3VyY2UpIGNvbWUgZmlyc3RcbiAgcmV0dXJuIGFsbFRyYWNlcy5zb3J0KChhLCBiKSA9PiBiLm10aW1lIC0gYS5tdGltZSkuc2xpY2UoMCwgNSk7XG59XG5cbi8qKlxuICogUmVzb2x2ZSBhY3Rpdml0eSBkaXJlY3RvcmllcyB0byBzY2FuIGZvciBmb3JlbnNpY3MuXG4gKiBJZiBhbiBhY3RpdmUgYXV0by13b3JrdHJlZSBleGlzdHMgZm9yIHRoZSBtaWxlc3RvbmUsIGl0cyBhY3Rpdml0eSBkaXJcbiAqIGlzIGluY2x1ZGVkIGZpcnN0IChwcmVmZXJyZWQpIHNvIHN0YWxlIHJvb3QgbG9ncyBkb24ndCBtYXNrIHdvcmt0cmVlIHByb2dyZXNzLlxuICovXG5mdW5jdGlvbiByZXNvbHZlQWN0aXZpdHlEaXJzKGJhc2VQYXRoOiBzdHJpbmcsIGFjdGl2ZU1pbGVzdG9uZT86IHN0cmluZyB8IG51bGwpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGRpcnM6IHN0cmluZ1tdID0gW107XG5cbiAgLy8gQ2hlY2sgZm9yIGFjdGl2ZSBhdXRvLXdvcmt0cmVlIGFjdGl2aXR5IGxvZ3NcbiAgaWYgKGFjdGl2ZU1pbGVzdG9uZSkge1xuICAgIGNvbnN0IHd0UGF0aCA9IGdldEF1dG9Xb3JrdHJlZVBhdGgoYmFzZVBhdGgsIGFjdGl2ZU1pbGVzdG9uZSk7XG4gICAgaWYgKHd0UGF0aCkge1xuICAgICAgY29uc3Qgd3RBY3Rpdml0eURpciA9IGpvaW4oZ3NkUm9vdCh3dFBhdGgpLCBcImFjdGl2aXR5XCIpO1xuICAgICAgaWYgKGV4aXN0c1N5bmMod3RBY3Rpdml0eURpcikpIHtcbiAgICAgICAgZGlycy5wdXNoKHd0QWN0aXZpdHlEaXIpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8vIEFsd2F5cyBpbmNsdWRlIHJvb3QgYWN0aXZpdHkgbG9nc1xuICBjb25zdCByb290QWN0aXZpdHlEaXIgPSBqb2luKGdzZFJvb3QoYmFzZVBhdGgpLCBcImFjdGl2aXR5XCIpO1xuICBkaXJzLnB1c2gocm9vdEFjdGl2aXR5RGlyKTtcblxuICByZXR1cm4gZGlycztcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEpvdXJuYWwgU2Nhbm5lciBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBNYXggcmVjZW50IGpvdXJuYWwgZmlsZXMgdG8gZnVsbHkgcGFyc2UgZm9yIGV2ZW50IGNvdW50cyBhbmQgcmVjZW50IGV2ZW50cy5cbiAqIE9sZGVyIGZpbGVzIGFyZSBsaW5lLWNvdW50ZWQgb25seSB0byBhdm9pZCBsb2FkaW5nIGh1Z2UgYW1vdW50cyBvZiBkYXRhLlxuICovXG5jb25zdCBNQVhfSk9VUk5BTF9SRUNFTlRfRklMRVMgPSAzO1xuXG4vKiogTWF4IHJlY2VudCBldmVudHMgdG8gZXh0cmFjdCBmb3IgdGhlIGZvcmVuc2ljIHJlcG9ydCB0aW1lbGluZS4gKi9cbmNvbnN0IE1BWF9KT1VSTkFMX1JFQ0VOVF9FVkVOVFMgPSAyMDtcblxuLyoqXG4gKiBJbnRlbGxpZ2VudGx5IHNjYW4gam91cm5hbCBmaWxlcyBmb3IgZm9yZW5zaWMgc3VtbWFyeS5cbiAqXG4gKiBKb3VybmFsIGZpbGVzIGNhbiBiZSBodWdlICh0aG91c2FuZHMgb2YgSlNPTkwgZW50cmllcyBvdmVyIHdlZWtzIG9mIGF1dG8tbW9kZSkuXG4gKiBJbnN0ZWFkIG9mIGxvYWRpbmcgYWxsIGVudHJpZXMgaW50byBtZW1vcnk6XG4gKiAtIE9ubHkgZnVsbHkgcGFyc2UgdGhlIG1vc3QgcmVjZW50IE4gZGFpbHkgZmlsZXMgKGV2ZW50IGNvdW50cywgZmxvdyB0cmFja2luZylcbiAqIC0gTGluZS1jb3VudCBvbGRlciBmaWxlcyBmb3IgYXBwcm94aW1hdGUgdG90YWxzIChubyBKU09OIHBhcnNpbmcpXG4gKiAtIEV4dHJhY3Qgb25seSB0aGUgbGFzdCAyMCBldmVudHMgZm9yIHRoZSB0aW1lbGluZVxuICovXG5mdW5jdGlvbiBzY2FuSm91cm5hbEZvckZvcmVuc2ljcyhiYXNlUGF0aDogc3RyaW5nKTogSm91cm5hbFN1bW1hcnkgfCBudWxsIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBqb3VybmFsRGlyID0gam9pbihnc2RSb290KGJhc2VQYXRoKSwgXCJqb3VybmFsXCIpO1xuICAgIGlmICghZXhpc3RzU3luYyhqb3VybmFsRGlyKSkgcmV0dXJuIG51bGw7XG5cbiAgICBjb25zdCBmaWxlcyA9IHJlYWRkaXJTeW5jKGpvdXJuYWxEaXIpLmZpbHRlcihmID0+IGYuZW5kc1dpdGgoXCIuanNvbmxcIikpLnNvcnQoKTtcbiAgICBpZiAoZmlsZXMubGVuZ3RoID09PSAwKSByZXR1cm4gbnVsbDtcblxuICAgIC8vIFNwbGl0IGludG8gcmVjZW50IChmdWxseSBwYXJzZWQpIGFuZCBvbGRlciAobGluZS1jb3VudGVkIG9ubHkpXG4gICAgY29uc3QgcmVjZW50RmlsZXMgPSBmaWxlcy5zbGljZSgtTUFYX0pPVVJOQUxfUkVDRU5UX0ZJTEVTKTtcbiAgICBjb25zdCBvbGRlckZpbGVzID0gZmlsZXMuc2xpY2UoMCwgLU1BWF9KT1VSTkFMX1JFQ0VOVF9GSUxFUyk7XG5cbiAgICAvLyBMaW5lLWNvdW50IG9sZGVyIGZpbGVzIHdpdGhvdXQgcGFyc2luZyBcdTIwMTQgYXZvaWRzIGxvYWRpbmcgbWVnYWJ5dGVzIG9mIEpTT05cbiAgICBsZXQgb2xkZXJFbnRyeUNvdW50ID0gMDtcbiAgICBsZXQgb2xkZXN0RW50cnk6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgIGZvciAoY29uc3QgZmlsZSBvZiBvbGRlckZpbGVzKSB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCByYXcgPSByZWFkRmlsZVN5bmMoam9pbihqb3VybmFsRGlyLCBmaWxlKSwgXCJ1dGYtOFwiKTtcbiAgICAgICAgY29uc3QgbGluZXMgPSByYXcuc3BsaXQoXCJcXG5cIik7XG4gICAgICAgIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xuICAgICAgICAgIGlmICghbGluZS50cmltKCkpIGNvbnRpbnVlO1xuICAgICAgICAgIG9sZGVyRW50cnlDb3VudCsrO1xuICAgICAgICAgIC8vIEV4dHJhY3Qgb25seSB0aGUgdGltZXN0YW1wIGZyb20gdGhlIGZpcnN0IG5vbi1lbXB0eSBsaW5lIG9mIHRoZSBvbGRlc3QgZmlsZVxuICAgICAgICAgIGlmICghb2xkZXN0RW50cnkpIHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UobGluZSkgYXMgeyB0cz86IHN0cmluZyB9O1xuICAgICAgICAgICAgICBpZiAocGFyc2VkLnRzKSBvbGRlc3RFbnRyeSA9IHBhcnNlZC50cztcbiAgICAgICAgICAgIH0gY2F0Y2ggeyAvKiBza2lwIG1hbGZvcm1lZCAqLyB9XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9IGNhdGNoIHsgLyogc2tpcCB1bnJlYWRhYmxlIGZpbGVzICovIH1cbiAgICB9XG5cbiAgICAvLyBGdWxseSBwYXJzZSByZWNlbnQgZmlsZXMgZm9yIGV2ZW50IGNvdW50cyBhbmQgdGltZWxpbmVcbiAgICBjb25zdCBldmVudENvdW50czogUmVjb3JkPHN0cmluZywgbnVtYmVyPiA9IHt9O1xuICAgIGNvbnN0IGZsb3dJZHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgICBjb25zdCByZWNlbnRQYXJzZWRFbnRyaWVzOiB7IHRzOiBzdHJpbmc7IGZsb3dJZDogc3RyaW5nOyBldmVudFR5cGU6IHN0cmluZzsgcnVsZT86IHN0cmluZzsgdW5pdElkPzogc3RyaW5nIH1bXSA9IFtdO1xuICAgIGxldCByZWNlbnRFbnRyeUNvdW50ID0gMDtcblxuICAgIGZvciAoY29uc3QgZmlsZSBvZiByZWNlbnRGaWxlcykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKGpvaW4oam91cm5hbERpciwgZmlsZSksIFwidXRmLThcIik7XG4gICAgICAgIGZvciAoY29uc3QgbGluZSBvZiByYXcuc3BsaXQoXCJcXG5cIikpIHtcbiAgICAgICAgICBpZiAoIWxpbmUudHJpbSgpKSBjb250aW51ZTtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgZW50cnkgPSBKU09OLnBhcnNlKGxpbmUpIGFzIHsgdHM6IHN0cmluZzsgZmxvd0lkOiBzdHJpbmc7IGV2ZW50VHlwZTogc3RyaW5nOyBydWxlPzogc3RyaW5nOyBkYXRhPzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfTtcbiAgICAgICAgICAgIHJlY2VudEVudHJ5Q291bnQrKztcbiAgICAgICAgICAgIGV2ZW50Q291bnRzW2VudHJ5LmV2ZW50VHlwZV0gPSAoZXZlbnRDb3VudHNbZW50cnkuZXZlbnRUeXBlXSA/PyAwKSArIDE7XG4gICAgICAgICAgICBmbG93SWRzLmFkZChlbnRyeS5mbG93SWQpO1xuXG4gICAgICAgICAgICBpZiAoIW9sZGVzdEVudHJ5KSBvbGRlc3RFbnRyeSA9IGVudHJ5LnRzO1xuXG4gICAgICAgICAgICAvLyBLZWVwIGEgcm9sbGluZyB3aW5kb3cgb2YgbGFzdCBOIGV2ZW50cyBcdTIwMTQgYXZvaWRzIGFjY3VtdWxhdGluZyB1bmJvdW5kZWQgYXJyYXlzXG4gICAgICAgICAgICByZWNlbnRQYXJzZWRFbnRyaWVzLnB1c2goe1xuICAgICAgICAgICAgICB0czogZW50cnkudHMsXG4gICAgICAgICAgICAgIGZsb3dJZDogZW50cnkuZmxvd0lkLFxuICAgICAgICAgICAgICBldmVudFR5cGU6IGVudHJ5LmV2ZW50VHlwZSxcbiAgICAgICAgICAgICAgcnVsZTogZW50cnkucnVsZSxcbiAgICAgICAgICAgICAgdW5pdElkOiBlbnRyeS5kYXRhPy51bml0SWQgYXMgc3RyaW5nIHwgdW5kZWZpbmVkLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBpZiAocmVjZW50UGFyc2VkRW50cmllcy5sZW5ndGggPiBNQVhfSk9VUk5BTF9SRUNFTlRfRVZFTlRTKSB7XG4gICAgICAgICAgICAgIHJlY2VudFBhcnNlZEVudHJpZXMuc2hpZnQoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGNhdGNoIHsgLyogc2tpcCBtYWxmb3JtZWQgbGluZXMgKi8gfVxuICAgICAgICB9XG4gICAgICB9IGNhdGNoIHsgLyogc2tpcCB1bnJlYWRhYmxlIGZpbGVzICovIH1cbiAgICB9XG5cbiAgICBjb25zdCB0b3RhbEVudHJpZXMgPSBvbGRlckVudHJ5Q291bnQgKyByZWNlbnRFbnRyeUNvdW50O1xuICAgIGlmICh0b3RhbEVudHJpZXMgPT09IDApIHJldHVybiBudWxsO1xuXG4gICAgY29uc3QgbmV3ZXN0RW50cnkgPSByZWNlbnRQYXJzZWRFbnRyaWVzLmxlbmd0aCA+IDBcbiAgICAgID8gcmVjZW50UGFyc2VkRW50cmllc1tyZWNlbnRQYXJzZWRFbnRyaWVzLmxlbmd0aCAtIDFdIS50c1xuICAgICAgOiBudWxsO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgIHRvdGFsRW50cmllcyxcbiAgICAgIGZsb3dDb3VudDogZmxvd0lkcy5zaXplLFxuICAgICAgZXZlbnRDb3VudHMsXG4gICAgICByZWNlbnRFdmVudHM6IHJlY2VudFBhcnNlZEVudHJpZXMsXG4gICAgICBvbGRlc3RFbnRyeSxcbiAgICAgIG5ld2VzdEVudHJ5LFxuICAgICAgZmlsZUNvdW50OiBmaWxlcy5sZW5ndGgsXG4gICAgfTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEFjdGl2aXR5IExvZyBNZXRhZGF0YSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gZ2F0aGVyQWN0aXZpdHlMb2dNZXRhKGJhc2VQYXRoOiBzdHJpbmcsIGFjdGl2ZU1pbGVzdG9uZT86IHN0cmluZyB8IG51bGwpOiBBY3Rpdml0eUxvZ01ldGEgfCBudWxsIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBhY3Rpdml0eURpcnMgPSByZXNvbHZlQWN0aXZpdHlEaXJzKGJhc2VQYXRoLCBhY3RpdmVNaWxlc3RvbmUpO1xuICAgIGxldCBmaWxlQ291bnQgPSAwO1xuICAgIGxldCB0b3RhbFNpemVCeXRlcyA9IDA7XG4gICAgbGV0IG9sZGVzdEZpbGU6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgIGxldCBuZXdlc3RGaWxlOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICBsZXQgb2xkZXN0TXRpbWUgPSBJbmZpbml0eTtcbiAgICBsZXQgbmV3ZXN0TXRpbWUgPSAwO1xuXG4gICAgZm9yIChjb25zdCBhY3Rpdml0eURpciBvZiBhY3Rpdml0eURpcnMpIHtcbiAgICAgIGlmICghZXhpc3RzU3luYyhhY3Rpdml0eURpcikpIGNvbnRpbnVlO1xuICAgICAgY29uc3QgZmlsZXMgPSByZWFkZGlyU3luYyhhY3Rpdml0eURpcikuZmlsdGVyKGYgPT4gZi5lbmRzV2l0aChcIi5qc29ubFwiKSk7XG4gICAgICBmb3IgKGNvbnN0IGZpbGUgb2YgZmlsZXMpIHtcbiAgICAgICAgY29uc3QgZmlsZVBhdGggPSBqb2luKGFjdGl2aXR5RGlyLCBmaWxlKTtcbiAgICAgICAgY29uc3Qgc3RhdCA9IHN0YXRTeW5jKGZpbGVQYXRoLCB7IHRocm93SWZOb0VudHJ5OiBmYWxzZSB9KTtcbiAgICAgICAgaWYgKCFzdGF0KSBjb250aW51ZTtcbiAgICAgICAgZmlsZUNvdW50Kys7XG4gICAgICAgIHRvdGFsU2l6ZUJ5dGVzICs9IHN0YXQuc2l6ZTtcbiAgICAgICAgaWYgKHN0YXQubXRpbWVNcyA8IG9sZGVzdE10aW1lKSB7XG4gICAgICAgICAgb2xkZXN0TXRpbWUgPSBzdGF0Lm10aW1lTXM7XG4gICAgICAgICAgb2xkZXN0RmlsZSA9IGZpbGU7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHN0YXQubXRpbWVNcyA+IG5ld2VzdE10aW1lKSB7XG4gICAgICAgICAgbmV3ZXN0TXRpbWUgPSBzdGF0Lm10aW1lTXM7XG4gICAgICAgICAgbmV3ZXN0RmlsZSA9IGZpbGU7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoZmlsZUNvdW50ID09PSAwKSByZXR1cm4gbnVsbDtcbiAgICByZXR1cm4geyBmaWxlQ291bnQsIHRvdGFsU2l6ZUJ5dGVzLCBvbGRlc3RGaWxlLCBuZXdlc3RGaWxlIH07XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBDb21wbGV0ZWQgS2V5cyBIZWxwZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFBhcnNlIGEgY29tcGxldGVkLXVuaXQga2V5IGludG8geyB1bml0VHlwZSwgdW5pdElkIH0uXG4gKlxuICogTW9zdCB1bml0IHR5cGVzIGFyZSBhIHNpbmdsZSBzZWdtZW50IChcImV4ZWN1dGUtdGFza1wiLCBcImNvbXBsZXRlLXNsaWNlXCIsIFx1MjAyNilcbiAqIHNvIHRoZSBrZXkgZm9ybWF0IGlzIHNpbXBseSBcInVuaXRUeXBlL3VuaXRJZFwiLiBIb29rIHVuaXRzIGFyZSB0aGUgZXhjZXB0aW9uOlxuICogdGhlaXIgdHlwZSBpcyBjb21wb3VuZCAoXCJob29rLzxob29rTmFtZT5cIiksIG1ha2luZyB0aGUga2V5IGxvb2sgbGlrZVxuICogXCJob29rL3RlbGVncmFtLXByb2dyZXNzL00wMDcvUzAxXCIuIFNwbGl0dGluZyBuYVx1MDBFRnZlbHkgb24gdGhlIGZpcnN0IHNsYXNoXG4gKiB5aWVsZHMgdW5pdFR5cGU9XCJob29rXCIgd2hpY2ggYnlwYXNzZXMgdmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdCgpJ3NcbiAqIHN0YXJ0c1dpdGgoXCJob29rL1wiKSBndWFyZCBhbmQgcHJvZHVjZXMgZmFsc2UtcG9zaXRpdmUgbWlzc2luZy1hcnRpZmFjdFxuICogZXJyb3JzICgjMjgyNikuXG4gKlxuICogUmV0dXJucyBudWxsIGZvciBtYWxmb3JtZWQga2V5cyAobm8gc2xhc2gsIG9yIGhvb2svIHdpdGggbm8gc2Vjb25kIHNsYXNoKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNwbGl0Q29tcGxldGVkS2V5KGtleTogc3RyaW5nKTogeyB1bml0VHlwZTogc3RyaW5nOyB1bml0SWQ6IHN0cmluZyB9IHwgbnVsbCB7XG4gIGlmIChrZXkuc3RhcnRzV2l0aChcImhvb2svXCIpKSB7XG4gICAgY29uc3Qgc2Vjb25kU2xhc2ggPSBrZXkuaW5kZXhPZihcIi9cIiwgNSk7IC8vIHNraXAgcGFzdCBcImhvb2svXCJcbiAgICBpZiAoc2Vjb25kU2xhc2ggPT09IC0xKSByZXR1cm4gbnVsbDsgICAgICAvLyBtYWxmb3JtZWQgXHUyMDE0IFwiaG9vay9cIiB3aXRoIG5vIGhvb2sgbmFtZVxuICAgIHJldHVybiB7IHVuaXRUeXBlOiBrZXkuc2xpY2UoMCwgc2Vjb25kU2xhc2gpLCB1bml0SWQ6IGtleS5zbGljZShzZWNvbmRTbGFzaCArIDEpIH07XG4gIH1cbiAgY29uc3Qgc2xhc2hJZHggPSBrZXkuaW5kZXhPZihcIi9cIik7XG4gIGlmIChzbGFzaElkeCA9PT0gLTEpIHJldHVybiBudWxsO1xuICByZXR1cm4geyB1bml0VHlwZToga2V5LnNsaWNlKDAsIHNsYXNoSWR4KSwgdW5pdElkOiBrZXkuc2xpY2Uoc2xhc2hJZHggKyAxKSB9O1xufVxuXG5mdW5jdGlvbiBsb2FkQ29tcGxldGVkS2V5cyhiYXNlUGF0aDogc3RyaW5nKTogc3RyaW5nW10ge1xuICBjb25zdCBmaWxlID0gam9pbihnc2RSb290KGJhc2VQYXRoKSwgXCJjb21wbGV0ZWQtdW5pdHMuanNvblwiKTtcbiAgdHJ5IHtcbiAgICBpZiAoZXhpc3RzU3luYyhmaWxlKSkge1xuICAgICAgcmV0dXJuIEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGZpbGUsIFwidXRmLThcIikpO1xuICAgIH1cbiAgfSBjYXRjaCB7IC8qIG5vbi1mYXRhbCAqLyB9XG4gIHJldHVybiBbXTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIERCIENvbXBsZXRpb24gQ291bnRzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBnZXREYkNvbXBsZXRpb25Db3VudHMoKTogRGJDb21wbGV0aW9uQ291bnRzIHwgbnVsbCB7XG4gIGlmICghaXNEYkF2YWlsYWJsZSgpKSByZXR1cm4gbnVsbDtcblxuICBjb25zdCBtaWxlc3RvbmVzID0gZ2V0QWxsTWlsZXN0b25lcygpO1xuICBsZXQgY29tcGxldGVkTWlsZXN0b25lcyA9IDA7XG4gIGxldCB0b3RhbFNsaWNlcyA9IDA7XG4gIGxldCBjb21wbGV0ZWRTbGljZXMgPSAwO1xuICBsZXQgdG90YWxUYXNrcyA9IDA7XG4gIGxldCBjb21wbGV0ZWRUYXNrcyA9IDA7XG5cbiAgZm9yIChjb25zdCBtIG9mIG1pbGVzdG9uZXMpIHtcbiAgICBpZiAoaXNDbG9zZWRTdGF0dXMobS5zdGF0dXMpKSBjb21wbGV0ZWRNaWxlc3RvbmVzKys7XG5cbiAgICBjb25zdCBzbGljZXMgPSBnZXRNaWxlc3RvbmVTbGljZXMobS5pZCk7XG4gICAgZm9yIChjb25zdCBzIG9mIHNsaWNlcykge1xuICAgICAgdG90YWxTbGljZXMrKztcbiAgICAgIGlmIChpc0Nsb3NlZFN0YXR1cyhzLnN0YXR1cykpIGNvbXBsZXRlZFNsaWNlcysrO1xuXG4gICAgICBjb25zdCB0YXNrcyA9IGdldFNsaWNlVGFza3MobS5pZCwgcy5pZCk7XG4gICAgICBmb3IgKGNvbnN0IHQgb2YgdGFza3MpIHtcbiAgICAgICAgdG90YWxUYXNrcysrO1xuICAgICAgICBpZiAoaXNDbG9zZWRTdGF0dXModC5zdGF0dXMpKSBjb21wbGV0ZWRUYXNrcysrO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiB7XG4gICAgbWlsZXN0b25lczogY29tcGxldGVkTWlsZXN0b25lcyxcbiAgICBtaWxlc3RvbmVzVG90YWw6IG1pbGVzdG9uZXMubGVuZ3RoLFxuICAgIHNsaWNlczogY29tcGxldGVkU2xpY2VzLFxuICAgIHNsaWNlc1RvdGFsOiB0b3RhbFNsaWNlcyxcbiAgICB0YXNrczogY29tcGxldGVkVGFza3MsXG4gICAgdGFza3NUb3RhbDogdG90YWxUYXNrcyxcbiAgfTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEFub21hbHkgRGV0ZWN0b3JzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIERldGVjdCB1bml0cyB0aGF0IHdlcmUgZGlzcGF0Y2hlZCBtdWx0aXBsZSB0aW1lcyAoc3R1Y2sgaW4gYSBsb29wKS5cbiAqXG4gKiBDb3VudHMgZGlzdGluY3QgZGlzcGF0Y2hlcyBieSBncm91cGluZyBvbiAodHlwZSwgaWQsIHN0YXJ0ZWRBdCkgZmlyc3QgdG9cbiAqIGNvbGxhcHNlIGlkbGUtd2F0Y2hkb2cgZHVwbGljYXRlIHNuYXBzaG90cyAoIzE5NDMpLCB0aGVuIGNvdW50cyB1bmlxdWVcbiAqIHN0YXJ0ZWRBdCB2YWx1ZXMgcGVyIHR5cGUvaWQgdG8gZGV0ZXJtaW5lIGFjdHVhbCBkaXNwYXRjaCBjb3VudC5cbiAqXG4gKiBFeHBvcnRlZCBmb3IgdGVzdGFiaWxpdHkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkZXRlY3RTdHVja0xvb3BzKHVuaXRzOiBVbml0TWV0cmljc1tdLCBhbm9tYWxpZXM6IEZvcmVuc2ljQW5vbWFseVtdKTogdm9pZCB7XG4gIC8vIEZpcnN0LCBjb2xsZWN0IHVuaXF1ZSBzdGFydGVkQXQgdmFsdWVzIHBlciB0eXBlL2lkIGtleSwgYnVja2V0ZWQgYnlcbiAgLy8gYXV0b1Nlc3Npb25LZXkgd2hlbiBhdmFpbGFibGUgc28gY3Jvc3Mtc2Vzc2lvbiByZWNvdmVyeSBkb2VzIG5vdCBsb29rXG4gIC8vIGxpa2UgYSB3aXRoaW4tc2Vzc2lvbiBzdHVjayBsb29wLlxuICBjb25zdCBkaXNwYXRjaE1hcCA9IG5ldyBNYXA8c3RyaW5nLCBNYXA8c3RyaW5nLCBTZXQ8bnVtYmVyPj4+KCk7XG4gIGZvciAoY29uc3QgdSBvZiB1bml0cykge1xuICAgIGNvbnN0IGtleSA9IGAke3UudHlwZX0vJHt1LmlkfWA7XG4gICAgbGV0IHNlc3Npb25CdWNrZXRzID0gZGlzcGF0Y2hNYXAuZ2V0KGtleSk7XG4gICAgaWYgKCFzZXNzaW9uQnVja2V0cykge1xuICAgICAgc2Vzc2lvbkJ1Y2tldHMgPSBuZXcgTWFwKCk7XG4gICAgICBkaXNwYXRjaE1hcC5zZXQoa2V5LCBzZXNzaW9uQnVja2V0cyk7XG4gICAgfVxuXG4gICAgY29uc3Qgc2Vzc2lvbktleSA9IHUuYXV0b1Nlc3Npb25LZXkgPz8gXCJfX2xlZ2FjeV9fXCI7XG4gICAgbGV0IHN0YXJ0cyA9IHNlc3Npb25CdWNrZXRzLmdldChzZXNzaW9uS2V5KTtcbiAgICBpZiAoIXN0YXJ0cykge1xuICAgICAgc3RhcnRzID0gbmV3IFNldCgpO1xuICAgICAgc2Vzc2lvbkJ1Y2tldHMuc2V0KHNlc3Npb25LZXksIHN0YXJ0cyk7XG4gICAgfVxuICAgIHN0YXJ0cy5hZGQodS5zdGFydGVkQXQpO1xuICB9XG5cbiAgZm9yIChjb25zdCBba2V5LCBzZXNzaW9uQnVja2V0c10gb2YgZGlzcGF0Y2hNYXApIHtcbiAgICBjb25zdCBoYXNTZXNzaW9uQXdhcmVEYXRhID0gQXJyYXkuZnJvbShzZXNzaW9uQnVja2V0cy5rZXlzKCkpLnNvbWUoKHNlc3Npb25LZXkpID0+IHNlc3Npb25LZXkgIT09IFwiX19sZWdhY3lfX1wiKTtcbiAgICBjb25zdCBjb3VudCA9IGhhc1Nlc3Npb25Bd2FyZURhdGFcbiAgICAgID8gTWF0aC5tYXgoLi4uQXJyYXkuZnJvbShzZXNzaW9uQnVja2V0cy52YWx1ZXMoKSwgKHN0YXJ0cykgPT4gc3RhcnRzLnNpemUpKVxuICAgICAgOiAoc2Vzc2lvbkJ1Y2tldHMuZ2V0KFwiX19sZWdhY3lfX1wiKT8uc2l6ZSA/PyAwKTtcblxuICAgIGlmIChjb3VudCA+IDEpIHtcbiAgICAgIGNvbnN0IFt1bml0VHlwZSwgLi4uaWRQYXJ0c10gPSBrZXkuc3BsaXQoXCIvXCIpO1xuICAgICAgYW5vbWFsaWVzLnB1c2goe1xuICAgICAgICB0eXBlOiBcInN0dWNrLWxvb3BcIixcbiAgICAgICAgc2V2ZXJpdHk6IGNvdW50ID49IDMgPyBcImVycm9yXCIgOiBcIndhcm5pbmdcIixcbiAgICAgICAgdW5pdFR5cGUsXG4gICAgICAgIHVuaXRJZDogaWRQYXJ0cy5qb2luKFwiL1wiKSxcbiAgICAgICAgc3VtbWFyeTogYFVuaXQgJHtrZXl9IHdhcyBkaXNwYXRjaGVkICR7Y291bnR9IHRpbWVzYCxcbiAgICAgICAgZGV0YWlsczogaGFzU2Vzc2lvbkF3YXJlRGF0YVxuICAgICAgICAgID8gYFJlcGVhdGVkIGRpc3BhdGNoIHdpdGhpbiB0aGUgc2FtZSBhdXRvIHNlc3Npb24gc3VnZ2VzdHMgdGhlIHVuaXQgY29tcGxldGVkIGJ1dCBpdHMgYXJ0aWZhY3RzIHdlcmUgbm90IHZlcmlmaWVkLCBvciB0aGUgc3RhdGUgbWFjaGluZSBrZXB0IHJldHVybmluZyBpdC4gQ3Jvc3Mtc2Vzc2lvbiByZWNvdmVyeSBydW5zIGFyZSBpZ25vcmVkLmBcbiAgICAgICAgICA6IGBSZXBlYXRlZCBkaXNwYXRjaCBzdWdnZXN0cyB0aGUgdW5pdCBjb21wbGV0ZWQgYnV0IGl0cyBhcnRpZmFjdHMgd2VyZW4ndCB2ZXJpZmllZCwgb3IgdGhlIHN0YXRlIG1hY2hpbmUga2VwdCByZXR1cm5pbmcgaXQuYCxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxufVxuXG5mdW5jdGlvbiBkZXRlY3RDb3N0U3Bpa2VzKHVuaXRzOiBVbml0TWV0cmljc1tdLCBhbm9tYWxpZXM6IEZvcmVuc2ljQW5vbWFseVtdKTogdm9pZCB7XG4gIGNvbnN0IGF2Z01hcCA9IGdldEF2ZXJhZ2VDb3N0UGVyVW5pdFR5cGUodW5pdHMpO1xuICBmb3IgKGNvbnN0IHUgb2YgdW5pdHMpIHtcbiAgICBjb25zdCBhdmcgPSBhdmdNYXAuZ2V0KHUudHlwZSk7XG4gICAgaWYgKGF2ZyAmJiBhdmcgPiAwICYmIHUuY29zdCA+IGF2ZyAqIDMpIHtcbiAgICAgIGFub21hbGllcy5wdXNoKHtcbiAgICAgICAgdHlwZTogXCJjb3N0LXNwaWtlXCIsXG4gICAgICAgIHNldmVyaXR5OiBcIndhcm5pbmdcIixcbiAgICAgICAgdW5pdFR5cGU6IHUudHlwZSxcbiAgICAgICAgdW5pdElkOiB1LmlkLFxuICAgICAgICBzdW1tYXJ5OiBgJHtmb3JtYXRDb3N0KHUuY29zdCl9IHZzICR7Zm9ybWF0Q29zdChhdmcpfSBhdmVyYWdlIGZvciAke3UudHlwZX1gLFxuICAgICAgICBkZXRhaWxzOiBgVW5pdCAke3UudHlwZX0vJHt1LmlkfSBjb3N0ICR7KHUuY29zdCAvIGF2ZykudG9GaXhlZCgxKX14IHRoZSBhdmVyYWdlLiBNYXkgaW5kaWNhdGUgZXhjZXNzaXZlIHJldHJpZXMgb3IgbGFyZ2UgY29udGV4dC5gLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIGRldGVjdFRpbWVvdXRzKHRyYWNlczogVW5pdFRyYWNlW10sIGFub21hbGllczogRm9yZW5zaWNBbm9tYWx5W10pOiB2b2lkIHtcbiAgZm9yIChjb25zdCB1dCBvZiB0cmFjZXMpIHtcbiAgICAvLyBDaGVjayBmb3IgdGltZW91dC1yZWNvdmVyeSBjdXN0b20gbWVzc2FnZXMgaW4gdG9vbCBjYWxsc1xuICAgIGNvbnN0IGhhc1RpbWVvdXQgPSB1dC50cmFjZS50b29sQ2FsbHMuc29tZSh0YyA9PlxuICAgICAgdGMubmFtZSA9PT0gXCJzZW5kbWVzc2FnZVwiICYmXG4gICAgICBKU09OLnN0cmluZ2lmeSh0Yy5pbnB1dCkuaW5jbHVkZXMoXCJnc2QtYXV0by10aW1lb3V0LXJlY292ZXJ5XCIpLFxuICAgICk7XG4gICAgLy8gQ2hlY2sgZm9yIHRpbWVvdXQga2V5d29yZHMgaW4gbGFzdCByZWFzb25pbmdcbiAgICBjb25zdCByZWFzb25pbmdUaW1lb3V0ID0gdXQudHJhY2UubGFzdFJlYXNvbmluZyAmJlxuICAgICAgLyg/OmlkbGUuP3RpbWVvdXR8aGFyZC4/dGltZW91dHx0aW1lb3V0Lj9yZWNvdmVyeSkvaS50ZXN0KHV0LnRyYWNlLmxhc3RSZWFzb25pbmcpO1xuXG4gICAgaWYgKGhhc1RpbWVvdXQgfHwgcmVhc29uaW5nVGltZW91dCkge1xuICAgICAgYW5vbWFsaWVzLnB1c2goe1xuICAgICAgICB0eXBlOiBcInRpbWVvdXRcIixcbiAgICAgICAgc2V2ZXJpdHk6IFwid2FybmluZ1wiLFxuICAgICAgICB1bml0VHlwZTogdXQudW5pdFR5cGUsXG4gICAgICAgIHVuaXRJZDogdXQudW5pdElkLFxuICAgICAgICBzdW1tYXJ5OiBgVGltZW91dCBkZXRlY3RlZCBpbiAke3V0LnVuaXRUeXBlfS8ke3V0LnVuaXRJZH1gLFxuICAgICAgICBkZXRhaWxzOiBgQWN0aXZpdHkgbG9nICR7dXQuZmlsZX0gY29udGFpbnMgdGltZW91dCByZWNvdmVyeSBwYXR0ZXJucy4gVGhlIHVuaXQgbWF5IGhhdmUgc3RhbGxlZC5gLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIGRldGVjdE1pc3NpbmdBcnRpZmFjdHMoY29tcGxldGVkS2V5czogc3RyaW5nW10sIGJhc2VQYXRoOiBzdHJpbmcsIGFjdGl2ZU1pbGVzdG9uZTogc3RyaW5nIHwgbnVsbCwgYW5vbWFsaWVzOiBGb3JlbnNpY0Fub21hbHlbXSk6IHZvaWQge1xuICAvLyBBbHNvIGNoZWNrIHRoZSB3b3JrdHJlZSBwYXRoIGZvciBhcnRpZmFjdHMgXHUyMDE0IHRoZXkgbWF5IGV4aXN0IHRoZXJlIGJ1dCBub3QgYXQgcm9vdFxuICBjb25zdCB3dEJhc2VQYXRoID0gYWN0aXZlTWlsZXN0b25lID8gZ2V0QXV0b1dvcmt0cmVlUGF0aChiYXNlUGF0aCwgYWN0aXZlTWlsZXN0b25lKSA6IG51bGw7XG5cbiAgZm9yIChjb25zdCBrZXkgb2YgY29tcGxldGVkS2V5cykge1xuICAgIGNvbnN0IHBhcnNlZCA9IHNwbGl0Q29tcGxldGVkS2V5KGtleSk7XG4gICAgaWYgKCFwYXJzZWQpIGNvbnRpbnVlO1xuICAgIGNvbnN0IHsgdW5pdFR5cGUsIHVuaXRJZCB9ID0gcGFyc2VkO1xuXG4gICAgY29uc3Qgcm9vdEhhc0FydGlmYWN0ID0gdmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdCh1bml0VHlwZSwgdW5pdElkLCBiYXNlUGF0aCk7XG4gICAgY29uc3Qgd3RIYXNBcnRpZmFjdCA9IHd0QmFzZVBhdGggPyB2ZXJpZnlFeHBlY3RlZEFydGlmYWN0KHVuaXRUeXBlLCB1bml0SWQsIHd0QmFzZVBhdGgpIDogZmFsc2U7XG5cbiAgICBpZiAoIXJvb3RIYXNBcnRpZmFjdCAmJiAhd3RIYXNBcnRpZmFjdCkge1xuICAgICAgYW5vbWFsaWVzLnB1c2goe1xuICAgICAgICB0eXBlOiBcIm1pc3NpbmctYXJ0aWZhY3RcIixcbiAgICAgICAgc2V2ZXJpdHk6IFwiZXJyb3JcIixcbiAgICAgICAgdW5pdFR5cGUsXG4gICAgICAgIHVuaXRJZCxcbiAgICAgICAgc3VtbWFyeTogYENvbXBsZXRlZCBrZXkgJHtrZXl9IGJ1dCBhcnRpZmFjdCBtaXNzaW5nIG9yIGludmFsaWRgLFxuICAgICAgICBkZXRhaWxzOiBgVGhlIHVuaXQgaXMgcmVjb3JkZWQgYXMgY29tcGxldGVkIGJ1dCB2ZXJpZnlFeHBlY3RlZEFydGlmYWN0KCkgcmV0dXJucyBmYWxzZSBhdCBib3RoIHByb2plY3Qgcm9vdCBhbmQgd29ya3RyZWUuIFRoZSBjb21wbGV0aW9uIHN0YXRlIGlzIHN0YWxlLmAsXG4gICAgICB9KTtcbiAgICB9XG4gIH1cbn1cblxuLyoqXG4gKiAjNDc2NCBcdTIwMTQgc3VyZmFjZSB3b3JrdHJlZSBsaWZlY3ljbGUgYW5kIG9ycGhhbiBzaWduYWxzIGluIHRoZSBmb3JlbnNpYyByZXBvcnQuXG4gKlxuICogQ29uc3VtZXMgb25seSB0aGUgYWdncmVnYXRlZCBzdW1tYXJ5IChub3QgcmF3IGpvdXJuYWwgZXZlbnRzKSB0byByZXNwZWN0XG4gKiB0aGUgZm9yZW5zaWNzIG1lbW9yeS1ibG9hdCBndWFyZCBpbiBmb3JlbnNpY3Mtam91cm5hbC50ZXN0LnRzIFx1MjAxNCBwZXItZXZlbnRcbiAqIGRldGFpbCBzdGF5cyBpbiB0aGUgam91cm5hbCBpdHNlbGYgd2hlcmUgdGhlIExMTSBjYW4gcXVlcnkgaXQgb24gZGVtYW5kLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZGV0ZWN0V29ya3RyZWVPcnBoYW5zKFxuICBzdW1tYXJ5OiBXb3JrdHJlZVRlbGVtZXRyeVN1bW1hcnksXG4gIGFub21hbGllczogRm9yZW5zaWNBbm9tYWx5W10sXG4pOiB2b2lkIHtcbiAgLy8gMS4gT3JwaGFuIGFnZ3JlZ2F0ZSBcdTIwMTQgc2V2ZXJpdHkgZGVwZW5kcyBvbiByZWFzb24uIEluLXByb2dyZXNzIG9ycGhhbnMgYXJlXG4gIC8vIHRoZSAjNDc2MSBjb25zdW1lci1zaWRlIHNpZ25hbCAobGl2ZSB3b3JrIHNpdHRpbmcgb24gYW4gdW5tZXJnZWQgYnJhbmNoKS5cbiAgZm9yIChjb25zdCBbcmVhc29uLCBjb3VudF0gb2YgT2JqZWN0LmVudHJpZXMoc3VtbWFyeS5vcnBoYW5zQnlSZWFzb24pKSB7XG4gICAgaWYgKGNvdW50IDw9IDApIGNvbnRpbnVlO1xuICAgIGNvbnN0IHNldmVyaXR5OiBGb3JlbnNpY0Fub21hbHlbXCJzZXZlcml0eVwiXSA9XG4gICAgICByZWFzb24gPT09IFwiaW4tcHJvZ3Jlc3MtdW5tZXJnZWRcIiA/IFwid2FybmluZ1wiIDogXCJpbmZvXCI7XG4gICAgYW5vbWFsaWVzLnB1c2goe1xuICAgICAgdHlwZTogXCJ3b3JrdHJlZS1vcnBoYW5cIixcbiAgICAgIHNldmVyaXR5LFxuICAgICAgc3VtbWFyeTogYCR7Y291bnR9IHdvcmt0cmVlIG9ycGhhbihzKSBkZXRlY3RlZCAoJHtyZWFzb259KWAsXG4gICAgICBkZXRhaWxzOlxuICAgICAgICByZWFzb24gPT09IFwiaW4tcHJvZ3Jlc3MtdW5tZXJnZWRcIlxuICAgICAgICAgID8gXCJBdXRvLW1vZGUgZXhpdGVkIHdpdGhvdXQgY29tcGxldGluZyBhIG1pbGVzdG9uZTsgbGl2ZSB3b3JrIHNpdHMgb24gYW4gdW5tZXJnZWQgbWlsZXN0b25lIGJyYW5jaC4gUnVuIGAvZ3NkIGF1dG9gIHRvIHJlc3VtZSwgb3IgbWVyZ2UgbWFudWFsbHkuXCJcbiAgICAgICAgICA6IHJlYXNvbiA9PT0gXCJjb21wbGV0ZS11bm1lcmdlZFwiXG4gICAgICAgICAgICA/IFwiQSBjb21wbGV0ZWQgbWlsZXN0b25lJ3MgYnJhbmNoIHdhcyBuZXZlciBtZXJnZWQgYmFjayB0byBtYWluLiBSdW4gYC9nc2QgZG9jdG9yIGZpeGAgdG8gcmVzb2x2ZS5cIlxuICAgICAgICAgICAgOiBgUmVhc29uOiAke3JlYXNvbn0uYCxcbiAgICB9KTtcbiAgfVxuXG4gIC8vIDIuIEF1dG8tZXhpdCBwcm9kdWNlciBzaWduYWwgXHUyMDE0ICM0NzYxJ3MgdXBzdHJlYW0gY2F1c2UuXG4gIGlmIChzdW1tYXJ5LmV4aXRzV2l0aFVubWVyZ2VkV29yayA+IDApIHtcbiAgICBjb25zdCByZWFzb25CcmVha2Rvd24gPSBPYmplY3QuZW50cmllcyhzdW1tYXJ5LmV4aXRzQnlSZWFzb24pXG4gICAgICAuZmlsdGVyKChbLCBuXSkgPT4gbiA+IDApXG4gICAgICAubWFwKChbciwgbl0pID0+IGAke3J9PSR7bn1gKVxuICAgICAgLmpvaW4oXCIsIFwiKTtcbiAgICBhbm9tYWxpZXMucHVzaCh7XG4gICAgICB0eXBlOiBcIndvcmt0cmVlLXVubWVyZ2VkLWV4aXRcIixcbiAgICAgIHNldmVyaXR5OiBcIndhcm5pbmdcIixcbiAgICAgIHN1bW1hcnk6IGAke3N1bW1hcnkuZXhpdHNXaXRoVW5tZXJnZWRXb3JrfSBhdXRvLWV4aXQocykgbGVmdCBtaWxlc3RvbmUgd29yayB1bm1lcmdlZGAsXG4gICAgICBkZXRhaWxzOiBgRXhpdCByZWFzb25zOiAke3JlYXNvbkJyZWFrZG93biB8fCBcIihub25lKVwifSBcdTAwQjcgUHJvZHVjZXItc2lkZSBzaWduYWwgZm9yICM0NzYxLWNsYXNzIG9ycGhhbnMuIEluc3BlY3QgLmdzZC9qb3VybmFsLyouanNvbmwgd2l0aCBldmVudFR5cGU6XCJhdXRvLWV4aXRcIiBmb3IgcGVyLWV4aXQgZGV0YWlsLmAsXG4gICAgfSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gZGV0ZWN0Q3Jhc2goY3Jhc2hMb2NrOiBMb2NrRGF0YSB8IG51bGwsIGFub21hbGllczogRm9yZW5zaWNBbm9tYWx5W10pOiB2b2lkIHtcbiAgaWYgKCFjcmFzaExvY2spIHJldHVybjtcbiAgaWYgKGlzTG9ja1Byb2Nlc3NBbGl2ZShjcmFzaExvY2spKSByZXR1cm47IC8vIFByb2Nlc3Mgc3RpbGwgcnVubmluZywgbm90IGEgY3Jhc2hcblxuICBhbm9tYWxpZXMucHVzaCh7XG4gICAgdHlwZTogXCJjcmFzaFwiLFxuICAgIHNldmVyaXR5OiBcImVycm9yXCIsXG4gICAgdW5pdFR5cGU6IGNyYXNoTG9jay51bml0VHlwZSxcbiAgICB1bml0SWQ6IGNyYXNoTG9jay51bml0SWQsXG4gICAgc3VtbWFyeTogYFN0YWxlIGNyYXNoIGxvY2s6IFBJRCAke2NyYXNoTG9jay5waWR9IGlzIGRlYWRgLFxuICAgIGRldGFpbHM6IGZvcm1hdENyYXNoSW5mbyhjcmFzaExvY2spLFxuICB9KTtcbn1cblxuZnVuY3Rpb24gZGV0ZWN0RG9jdG9ySXNzdWVzKGlzc3VlczogRG9jdG9ySXNzdWVbXSwgYW5vbWFsaWVzOiBGb3JlbnNpY0Fub21hbHlbXSk6IHZvaWQge1xuICBmb3IgKGNvbnN0IGlzc3VlIG9mIGlzc3Vlcykge1xuICAgIGlmIChpc3N1ZS5zZXZlcml0eSA9PT0gXCJlcnJvclwiKSB7XG4gICAgICBhbm9tYWxpZXMucHVzaCh7XG4gICAgICAgIHR5cGU6IFwiZG9jdG9yLWlzc3VlXCIsXG4gICAgICAgIHNldmVyaXR5OiBcImVycm9yXCIsXG4gICAgICAgIHN1bW1hcnk6IGBEb2N0b3I6ICR7aXNzdWUubWVzc2FnZX1gLFxuICAgICAgICBkZXRhaWxzOiBgQ29kZTogJHtpc3N1ZS5jb2RlfSwgU2NvcGU6ICR7aXNzdWUuc2NvcGV9LCBVbml0OiAke2lzc3VlLnVuaXRJZH0ke2lzc3VlLmZpbGUgPyBgLCBGaWxlOiAke2lzc3VlLmZpbGV9YCA6IFwiXCJ9YCxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxufVxuXG5mdW5jdGlvbiBkZXRlY3RFcnJvclRyYWNlcyh0cmFjZXM6IFVuaXRUcmFjZVtdLCBhbm9tYWxpZXM6IEZvcmVuc2ljQW5vbWFseVtdKTogdm9pZCB7XG4gIGZvciAoY29uc3QgdXQgb2YgdHJhY2VzKSB7XG4gICAgaWYgKHV0LnRyYWNlLmVycm9ycy5sZW5ndGggPiAwKSB7XG4gICAgICBhbm9tYWxpZXMucHVzaCh7XG4gICAgICAgIHR5cGU6IFwiZXJyb3ItdHJhY2VcIixcbiAgICAgICAgc2V2ZXJpdHk6IFwid2FybmluZ1wiLFxuICAgICAgICB1bml0VHlwZTogdXQudW5pdFR5cGUsXG4gICAgICAgIHVuaXRJZDogdXQudW5pdElkLFxuICAgICAgICBzdW1tYXJ5OiBgJHt1dC50cmFjZS5lcnJvcnMubGVuZ3RofSBlcnJvcihzKSBpbiAke3V0LnVuaXRUeXBlfS8ke3V0LnVuaXRJZH1gLFxuICAgICAgICBkZXRhaWxzOiB1dC50cmFjZS5lcnJvcnMuc2xpY2UoMCwgMykuam9pbihcIlxcblwiKSxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxufVxuXG5mdW5jdGlvbiBkZXRlY3RKb3VybmFsQW5vbWFsaWVzKGpvdXJuYWw6IEpvdXJuYWxTdW1tYXJ5IHwgbnVsbCwgYW5vbWFsaWVzOiBGb3JlbnNpY0Fub21hbHlbXSk6IHZvaWQge1xuICBpZiAoIWpvdXJuYWwpIHJldHVybjtcblxuICAvLyBEZXRlY3Qgc3R1Y2stZGV0ZWN0ZWQgZXZlbnRzIGZyb20gdGhlIGpvdXJuYWxcbiAgY29uc3Qgc3R1Y2tDb3VudCA9IGpvdXJuYWwuZXZlbnRDb3VudHNbXCJzdHVjay1kZXRlY3RlZFwiXSA/PyAwO1xuICBpZiAoc3R1Y2tDb3VudCA+IDApIHtcbiAgICBhbm9tYWxpZXMucHVzaCh7XG4gICAgICB0eXBlOiBcImpvdXJuYWwtc3R1Y2tcIixcbiAgICAgIHNldmVyaXR5OiBzdHVja0NvdW50ID49IDMgPyBcImVycm9yXCIgOiBcIndhcm5pbmdcIixcbiAgICAgIHN1bW1hcnk6IGBKb3VybmFsIHJlY29yZGVkICR7c3R1Y2tDb3VudH0gc3R1Y2stZGV0ZWN0ZWQgZXZlbnQocylgLFxuICAgICAgZGV0YWlsczogYFRoZSBhdXRvLW1vZGUgbG9vcCBkZXRlY3RlZCBpdCB3YXMgc3R1Y2sgJHtzdHVja0NvdW50fSB0aW1lKHMpLiBDaGVjayBqb3VybmFsIGV2ZW50cyBmb3IgZmxvdyBJRHMgYW5kIGNhdXNhbCBjaGFpbnMgdG8gdHJhY2UgdGhlIHJvb3QgY2F1c2UuYCxcbiAgICB9KTtcbiAgfVxuXG4gIC8vIERldGVjdCBndWFyZC1ibG9jayBldmVudHMgKGRpc3BhdGNoIHdhcyBibG9ja2VkIGJ5IGEgZ3VhcmQpXG4gIGNvbnN0IGd1YXJkQ291bnQgPSBqb3VybmFsLmV2ZW50Q291bnRzW1wiZ3VhcmQtYmxvY2tcIl0gPz8gMDtcbiAgaWYgKGd1YXJkQ291bnQgPiAwKSB7XG4gICAgYW5vbWFsaWVzLnB1c2goe1xuICAgICAgdHlwZTogXCJqb3VybmFsLWd1YXJkLWJsb2NrXCIsXG4gICAgICBzZXZlcml0eTogZ3VhcmRDb3VudCA+PSA1ID8gXCJ3YXJuaW5nXCIgOiBcImluZm9cIixcbiAgICAgIHN1bW1hcnk6IGBKb3VybmFsIHJlY29yZGVkICR7Z3VhcmRDb3VudH0gZ3VhcmQtYmxvY2sgZXZlbnQocylgLFxuICAgICAgZGV0YWlsczogYERpc3BhdGNoIHdhcyBibG9ja2VkIGJ5IGEgZ3VhcmQgY29uZGl0aW9uICR7Z3VhcmRDb3VudH0gdGltZShzKS4gVGhpcyBtYXkgaW5kaWNhdGUgYSBwZXJzaXN0ZW50IGJsb2NraW5nIGNvbmRpdGlvbiBwcmV2ZW50aW5nIHByb2dyZXNzLmAsXG4gICAgfSk7XG4gIH1cblxuICAvLyBEZXRlY3QgcmFwaWQgaXRlcmF0aW9ucyAobWFueSBmbG93cyBpbiBzaG9ydCB0aW1lID0gbGlrZWx5IHRocmFzaGluZylcbiAgaWYgKGpvdXJuYWwuZmxvd0NvdW50ID4gMCAmJiBqb3VybmFsLm9sZGVzdEVudHJ5ICYmIGpvdXJuYWwubmV3ZXN0RW50cnkpIHtcbiAgICBjb25zdCBvbGRlc3QgPSBuZXcgRGF0ZShqb3VybmFsLm9sZGVzdEVudHJ5KS5nZXRUaW1lKCk7XG4gICAgY29uc3QgbmV3ZXN0ID0gbmV3IERhdGUoam91cm5hbC5uZXdlc3RFbnRyeSkuZ2V0VGltZSgpO1xuICAgIGNvbnN0IHNwYW5NcyA9IG5ld2VzdCAtIG9sZGVzdDtcbiAgICBpZiAoc3Bhbk1zID4gMCAmJiBqb3VybmFsLmZsb3dDb3VudCA+IDEwKSB7XG4gICAgICBjb25zdCBhdmdNcyA9IHNwYW5NcyAvIGpvdXJuYWwuZmxvd0NvdW50O1xuICAgICAgaWYgKGF2Z01zIDwgUkFQSURfSVRFUkFUSU9OX1RIUkVTSE9MRF9NUykge1xuICAgICAgICBhbm9tYWxpZXMucHVzaCh7XG4gICAgICAgICAgdHlwZTogXCJqb3VybmFsLXJhcGlkLWl0ZXJhdGlvbnNcIixcbiAgICAgICAgICBzZXZlcml0eTogXCJ3YXJuaW5nXCIsXG4gICAgICAgICAgc3VtbWFyeTogYCR7am91cm5hbC5mbG93Q291bnR9IGl0ZXJhdGlvbnMgaW4gJHtmb3JtYXREdXJhdGlvbihzcGFuTXMpfSAoYXZnICR7Zm9ybWF0RHVyYXRpb24oYXZnTXMpfS9pdGVyYXRpb24pYCxcbiAgICAgICAgICBkZXRhaWxzOiBgVW51c3VhbGx5IHJhcGlkIGl0ZXJhdGlvbiBjYWRlbmNlIHN1Z2dlc3RzIHRoZSBsb29wIG1heSBiZSB0aHJhc2hpbmcgd2l0aG91dCBtYWtpbmcgcHJvZ3Jlc3MuIFJldmlldyByZWNlbnQgam91cm5hbCBldmVudHMgZm9yIGRpc3BhdGNoLXN0b3Agb3IgdGVybWluYWwgZXZlbnRzLmAsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8vIERldGVjdCB3b3JrdHJlZSBmYWlsdXJlcyBmcm9tIGpvdXJuYWwgZXZlbnRzXG4gIGNvbnN0IHd0Q3JlYXRlRmFpbGVkID0gam91cm5hbC5ldmVudENvdW50c1tcIndvcmt0cmVlLWNyZWF0ZS1mYWlsZWRcIl0gPz8gMDtcbiAgY29uc3Qgd3RNZXJnZUZhaWxlZCA9IGpvdXJuYWwuZXZlbnRDb3VudHNbXCJ3b3JrdHJlZS1tZXJnZS1mYWlsZWRcIl0gPz8gMDtcbiAgY29uc3Qgd3RGYWlsdXJlcyA9IHd0Q3JlYXRlRmFpbGVkICsgd3RNZXJnZUZhaWxlZDtcbiAgaWYgKHd0RmFpbHVyZXMgPiAwKSB7XG4gICAgY29uc3QgcGFydHM6IHN0cmluZ1tdID0gW107XG4gICAgaWYgKHd0Q3JlYXRlRmFpbGVkID4gMCkgcGFydHMucHVzaChgJHt3dENyZWF0ZUZhaWxlZH0gY3JlYXRlIGZhaWx1cmUocylgKTtcbiAgICBpZiAod3RNZXJnZUZhaWxlZCA+IDApIHBhcnRzLnB1c2goYCR7d3RNZXJnZUZhaWxlZH0gbWVyZ2UgZmFpbHVyZShzKWApO1xuICAgIGFub21hbGllcy5wdXNoKHtcbiAgICAgIHR5cGU6IFwiam91cm5hbC13b3JrdHJlZS1mYWlsdXJlXCIsXG4gICAgICBzZXZlcml0eTogXCJ3YXJuaW5nXCIsXG4gICAgICBzdW1tYXJ5OiBgV29ya3RyZWUgZmFpbHVyZXM6ICR7cGFydHMuam9pbihcIiwgXCIpfWAsXG4gICAgICBkZXRhaWxzOiBgSm91cm5hbCByZWNvcmRlZCB3b3JrdHJlZSBvcGVyYXRpb24gZmFpbHVyZXMuIFRoZXNlIG1heSBpbmRpY2F0ZSBnaXQgc3RhdGUgY29ycnVwdGlvbiBvciBjb25mbGljdGluZyBicmFuY2hlcy5gLFxuICAgIH0pO1xuICB9XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBSZXBvcnQgUGVyc2lzdGVuY2UgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIHNhdmVGb3JlbnNpY1JlcG9ydChiYXNlUGF0aDogc3RyaW5nLCByZXBvcnQ6IEZvcmVuc2ljUmVwb3J0LCBwcm9ibGVtRGVzY3JpcHRpb246IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGRpciA9IGpvaW4oZ3NkUm9vdChiYXNlUGF0aCksIFwiZm9yZW5zaWNzXCIpO1xuICBta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICBjb25zdCB0cyA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKS5yZXBsYWNlKC9bOi5dL2csIFwiLVwiKS5yZXBsYWNlKFwiVFwiLCBcIi1cIikuc2xpY2UoMCwgMTkpO1xuICBjb25zdCBmaWxlUGF0aCA9IGpvaW4oZGlyLCBgcmVwb3J0LSR7dHN9Lm1kYCk7XG5cbiAgY29uc3QgcmVkYWN0ID0gKHM6IHN0cmluZykgPT4gcmVkYWN0Rm9yR2l0SHViKHMsIGJhc2VQYXRoKTtcblxuICBjb25zdCBzZWN0aW9uczogc3RyaW5nW10gPSBbXG4gICAgYCMgR1NEIEZvcmVuc2ljIFJlcG9ydGAsXG4gICAgYGAsXG4gICAgYCoqR2VuZXJhdGVkOioqICR7cmVwb3J0LnRpbWVzdGFtcH1gLFxuICAgIGAqKkdTRCBWZXJzaW9uOioqICR7cmVwb3J0LmdzZFZlcnNpb259YCxcbiAgICBgKipBY3RpdmUgTWlsZXN0b25lOioqICR7cmVwb3J0LmFjdGl2ZU1pbGVzdG9uZSA/PyBcIm5vbmVcIn1gLFxuICAgIGAqKkFjdGl2ZSBTbGljZToqKiAke3JlcG9ydC5hY3RpdmVTbGljZSA/PyBcIm5vbmVcIn1gLFxuICAgIGAqKkFjdGl2ZSBXb3JrdHJlZToqKiAke3JlcG9ydC5hY3RpdmVXb3JrdHJlZSA/PyBcIm5vbmVcIn1gLFxuICAgIGBgLFxuICAgIGAjIyBQcm9ibGVtIERlc2NyaXB0aW9uYCxcbiAgICBgYCxcbiAgICBwcm9ibGVtRGVzY3JpcHRpb24sXG4gICAgYGAsXG4gIF07XG5cbiAgLy8gQW5vbWFsaWVzXG4gIGlmIChyZXBvcnQuYW5vbWFsaWVzLmxlbmd0aCA+IDApIHtcbiAgICBzZWN0aW9ucy5wdXNoKGAjIyBBbm9tYWxpZXMgRGV0ZWN0ZWQgKCR7cmVwb3J0LmFub21hbGllcy5sZW5ndGh9KWAsIGBgKTtcbiAgICBmb3IgKGNvbnN0IGEgb2YgcmVwb3J0LmFub21hbGllcykge1xuICAgICAgc2VjdGlvbnMucHVzaChgIyMjIFske2Euc2V2ZXJpdHkudG9VcHBlckNhc2UoKX1dICR7YS50eXBlfTogJHthLnN1bW1hcnl9YCk7XG4gICAgICBpZiAoYS51bml0VHlwZSkgc2VjdGlvbnMucHVzaChgLSBVbml0OiAke2EudW5pdFR5cGV9LyR7YS51bml0SWQgPz8gXCJcIn1gKTtcbiAgICAgIHNlY3Rpb25zLnB1c2goYC0gJHtyZWRhY3QoYS5kZXRhaWxzKX1gLCBgYCk7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIHNlY3Rpb25zLnB1c2goYCMjIEFub21hbGllc2AsIGBgLCBgTm8gYW5vbWFsaWVzIGRldGVjdGVkLmAsIGBgKTtcbiAgfVxuXG4gIC8vIFJlY2VudCB1bml0c1xuICBpZiAocmVwb3J0LnJlY2VudFVuaXRzLmxlbmd0aCA+IDApIHtcbiAgICBzZWN0aW9ucy5wdXNoKGAjIyBSZWNlbnQgVW5pdHNgLCBgYCk7XG4gICAgc2VjdGlvbnMucHVzaChgfCBUeXBlIHwgSUQgfCBDb3N0IHwgRHVyYXRpb24gfCBNb2RlbCB8YCk7XG4gICAgc2VjdGlvbnMucHVzaChgfC0tLS0tLXwtLS0tLXwtLS0tLS18LS0tLS0tLS0tLXwtLS0tLS0tfGApO1xuICAgIGZvciAoY29uc3QgdSBvZiByZXBvcnQucmVjZW50VW5pdHMpIHtcbiAgICAgIHNlY3Rpb25zLnB1c2goYHwgJHt1LnR5cGV9IHwgJHt1LmlkfSB8ICR7Zm9ybWF0Q29zdCh1LmNvc3QpfSB8ICR7Zm9ybWF0RHVyYXRpb24odS5kdXJhdGlvbil9IHwgJHt1Lm1vZGVsfSB8YCk7XG4gICAgfVxuICAgIHNlY3Rpb25zLnB1c2goYGApO1xuICB9XG5cbiAgLy8gVW5pdCB0cmFjZXNcbiAgaWYgKHJlcG9ydC51bml0VHJhY2VzLmxlbmd0aCA+IDApIHtcbiAgICBzZWN0aW9ucy5wdXNoKGAjIyBBY3Rpdml0eSBMb2cgVHJhY2VzIChsYXN0ICR7cmVwb3J0LnVuaXRUcmFjZXMubGVuZ3RofSlgLCBgYCk7XG4gICAgZm9yIChjb25zdCB1dCBvZiByZXBvcnQudW5pdFRyYWNlcykge1xuICAgICAgc2VjdGlvbnMucHVzaChgIyMjICR7dXQudW5pdFR5cGV9LyR7dXQudW5pdElkfSAoc2VxICR7dXQuc2VxfSlgKTtcbiAgICAgIHNlY3Rpb25zLnB1c2goYC0gVG9vbCBjYWxsczogJHt1dC50cmFjZS50b29sQ2FsbENvdW50fWApO1xuICAgICAgc2VjdGlvbnMucHVzaChgLSBGaWxlcyB3cml0dGVuOiAke3V0LnRyYWNlLmZpbGVzV3JpdHRlbi5sZW5ndGh9YCk7XG4gICAgICBzZWN0aW9ucy5wdXNoKGAtIEVycm9yczogJHt1dC50cmFjZS5lcnJvcnMubGVuZ3RofWApO1xuICAgICAgaWYgKHV0LnRyYWNlLmxhc3RSZWFzb25pbmcpIHtcbiAgICAgICAgc2VjdGlvbnMucHVzaChgLSBMYXN0IHJlYXNvbmluZzogJHtyZWRhY3QodXQudHJhY2UubGFzdFJlYXNvbmluZy5zbGljZSgwLCAyMDApKX1gKTtcbiAgICAgIH1cbiAgICAgIHNlY3Rpb25zLnB1c2goYGApO1xuICAgIH1cbiAgfVxuXG4gIC8vIERvY3RvciBpc3N1ZXNcbiAgaWYgKHJlcG9ydC5kb2N0b3JJc3N1ZXMubGVuZ3RoID4gMCkge1xuICAgIHNlY3Rpb25zLnB1c2goYCMjIERvY3RvciBJc3N1ZXNgLCBgYCk7XG4gICAgc2VjdGlvbnMucHVzaChmb3JtYXREb2N0b3JJc3N1ZXNGb3JQcm9tcHQocmVwb3J0LmRvY3Rvcklzc3VlcyksIGBgKTtcbiAgfVxuXG4gIC8vIENyYXNoIGxvY2tcbiAgaWYgKHJlcG9ydC5jcmFzaExvY2spIHtcbiAgICBzZWN0aW9ucy5wdXNoKGAjIyBDcmFzaCBMb2NrYCwgYGApO1xuICAgIHNlY3Rpb25zLnB1c2gocmVkYWN0KGZvcm1hdENyYXNoSW5mbyhyZXBvcnQuY3Jhc2hMb2NrKSksIGBgKTtcbiAgfVxuXG4gIC8vIEFjdGl2aXR5IGxvZyBtZXRhZGF0YVxuICBpZiAocmVwb3J0LmFjdGl2aXR5TG9nTWV0YSkge1xuICAgIGNvbnN0IG1ldGEgPSByZXBvcnQuYWN0aXZpdHlMb2dNZXRhO1xuICAgIHNlY3Rpb25zLnB1c2goYCMjIEFjdGl2aXR5IExvZyBNZXRhZGF0YWAsIGBgKTtcbiAgICBzZWN0aW9ucy5wdXNoKGAtIEZpbGVzOiAke21ldGEuZmlsZUNvdW50fWApO1xuICAgIHNlY3Rpb25zLnB1c2goYC0gVG90YWwgc2l6ZTogJHsobWV0YS50b3RhbFNpemVCeXRlcyAvIDEwMjQpLnRvRml4ZWQoMSl9IEtCYCk7XG4gICAgaWYgKG1ldGEub2xkZXN0RmlsZSkgc2VjdGlvbnMucHVzaChgLSBPbGRlc3Q6ICR7bWV0YS5vbGRlc3RGaWxlfWApO1xuICAgIGlmIChtZXRhLm5ld2VzdEZpbGUpIHNlY3Rpb25zLnB1c2goYC0gTmV3ZXN0OiAke21ldGEubmV3ZXN0RmlsZX1gKTtcbiAgICBzZWN0aW9ucy5wdXNoKGBgKTtcbiAgfVxuXG4gIC8vICM0NzY0IFx1MjAxNCBXb3JrdHJlZSB0ZWxlbWV0cnkgc3VtbWFyeVxuICBpZiAocmVwb3J0Lndvcmt0cmVlVGVsZW1ldHJ5KSB7XG4gICAgY29uc3QgdCA9IHJlcG9ydC53b3JrdHJlZVRlbGVtZXRyeTtcbiAgICBjb25zdCBwNTAgPSBwZXJjZW50aWxlKHQubWVyZ2VEdXJhdGlvbnNNcywgMC41KTtcbiAgICBjb25zdCBwOTUgPSBwZXJjZW50aWxlKHQubWVyZ2VEdXJhdGlvbnNNcywgMC45NSk7XG4gICAgc2VjdGlvbnMucHVzaChgIyMgV29ya3RyZWUgVGVsZW1ldHJ5YCwgYGApO1xuICAgIHNlY3Rpb25zLnB1c2goYC0gV29ya3RyZWVzIGNyZWF0ZWQ6ICR7dC53b3JrdHJlZXNDcmVhdGVkfWApO1xuICAgIHNlY3Rpb25zLnB1c2goYC0gV29ya3RyZWVzIG1lcmdlZDogJHt0Lndvcmt0cmVlc01lcmdlZH1gKTtcbiAgICBzZWN0aW9ucy5wdXNoKGAtIE9ycGhhbnMgZGV0ZWN0ZWQ6ICR7dC5vcnBoYW5zRGV0ZWN0ZWR9YCk7XG4gICAgaWYgKHQub3JwaGFuc0RldGVjdGVkID4gMCkge1xuICAgICAgY29uc3QgYnJlYWtkb3duID0gT2JqZWN0LmVudHJpZXModC5vcnBoYW5zQnlSZWFzb24pXG4gICAgICAgIC5tYXAoKFtyLCBuXSkgPT4gYCR7cn09JHtufWApLmpvaW4oXCIsIFwiKTtcbiAgICAgIHNlY3Rpb25zLnB1c2goYCAgLSBCeSByZWFzb246ICR7YnJlYWtkb3dufWApO1xuICAgIH1cbiAgICBzZWN0aW9ucy5wdXNoKGAtIE1lcmdlIGNvbmZsaWN0czogJHt0Lm1lcmdlQ29uZmxpY3RzfWApO1xuICAgIGlmICh0Lm1lcmdlRHVyYXRpb25zTXMubGVuZ3RoID4gMCkge1xuICAgICAgc2VjdGlvbnMucHVzaChgLSBNZXJnZSBkdXJhdGlvbiBwNTAgLyBwOTU6ICR7cDUwID8/IFwiLVwifSAvICR7cDk1ID8/IFwiLVwifSBtcyAobj0ke3QubWVyZ2VEdXJhdGlvbnNNcy5sZW5ndGh9KWApO1xuICAgIH1cbiAgICBzZWN0aW9ucy5wdXNoKGAtIEF1dG8tZXhpdHMgbGVhdmluZyB1bm1lcmdlZCB3b3JrOiAke3QuZXhpdHNXaXRoVW5tZXJnZWRXb3JrfWApO1xuICAgIGlmIChPYmplY3Qua2V5cyh0LmV4aXRzQnlSZWFzb24pLmxlbmd0aCA+IDApIHtcbiAgICAgIGNvbnN0IGJyZWFrZG93biA9IE9iamVjdC5lbnRyaWVzKHQuZXhpdHNCeVJlYXNvbilcbiAgICAgICAgLnNvcnQoKGEsIGIpID0+IGJbMV0gLSBhWzFdKVxuICAgICAgICAubWFwKChbciwgbl0pID0+IGAke3J9PSR7bn1gKS5qb2luKFwiLCBcIik7XG4gICAgICBzZWN0aW9ucy5wdXNoKGAgIC0gRXhpdCByZWFzb25zOiAke2JyZWFrZG93bn1gKTtcbiAgICB9XG4gICAgc2VjdGlvbnMucHVzaChgLSBDYW5vbmljYWwtcm9vdCByZWRpcmVjdHMgKCM0NzYxIGZpeCBmaXJlZCk6ICR7dC5jYW5vbmljYWxSZWRpcmVjdHN9YCk7XG4gICAgLy8gIzQ3NjUgc2xpY2UtY2FkZW5jZSBjb3VudGVyc1xuICAgIGlmICh0LnNsaWNlc01lcmdlZCArIHQuc2xpY2VNZXJnZUNvbmZsaWN0cyArIHQubWlsZXN0b25lUmVzcXVhc2hlcyA+IDApIHtcbiAgICAgIHNlY3Rpb25zLnB1c2goYC0gU2xpY2VzIG1lcmdlZDogJHt0LnNsaWNlc01lcmdlZH0gXHUwMEI3IFNsaWNlIG1lcmdlIGNvbmZsaWN0czogJHt0LnNsaWNlTWVyZ2VDb25mbGljdHN9YCk7XG4gICAgICBzZWN0aW9ucy5wdXNoKGAtIE1pbGVzdG9uZSByZS1zcXVhc2hlczogJHt0Lm1pbGVzdG9uZVJlc3F1YXNoZXN9YCk7XG4gICAgfVxuICAgIHNlY3Rpb25zLnB1c2goYGApO1xuICB9XG5cbiAgLy8gSm91cm5hbCBzdW1tYXJ5XG4gIGlmIChyZXBvcnQuam91cm5hbFN1bW1hcnkpIHtcbiAgICBjb25zdCBqcyA9IHJlcG9ydC5qb3VybmFsU3VtbWFyeTtcbiAgICBzZWN0aW9ucy5wdXNoKGAjIyBKb3VybmFsIFN1bW1hcnlgLCBgYCk7XG4gICAgc2VjdGlvbnMucHVzaChgLSBUb3RhbCBlbnRyaWVzOiAke2pzLnRvdGFsRW50cmllc31gKTtcbiAgICBzZWN0aW9ucy5wdXNoKGAtIERpc3RpbmN0IGZsb3dzIChpdGVyYXRpb25zKTogJHtqcy5mbG93Q291bnR9YCk7XG4gICAgc2VjdGlvbnMucHVzaChgLSBEYWlseSBmaWxlczogJHtqcy5maWxlQ291bnR9YCk7XG4gICAgaWYgKGpzLm9sZGVzdEVudHJ5KSBzZWN0aW9ucy5wdXNoKGAtIERhdGUgcmFuZ2U6ICR7anMub2xkZXN0RW50cnl9IFx1MjAxNCAke2pzLm5ld2VzdEVudHJ5fWApO1xuICAgIHNlY3Rpb25zLnB1c2goYGApO1xuICAgIHNlY3Rpb25zLnB1c2goYCMjIyBFdmVudCBUeXBlIERpc3RyaWJ1dGlvbmAsIGBgKTtcbiAgICBzZWN0aW9ucy5wdXNoKGB8IEV2ZW50IFR5cGUgfCBDb3VudCB8YCk7XG4gICAgc2VjdGlvbnMucHVzaChgfC0tLS0tLS0tLS0tLXwtLS0tLS0tfGApO1xuICAgIGZvciAoY29uc3QgW2V2VHlwZSwgY291bnRdIG9mIE9iamVjdC5lbnRyaWVzKGpzLmV2ZW50Q291bnRzKS5zb3J0KChhLCBiKSA9PiBiWzFdIC0gYVsxXSkpIHtcbiAgICAgIHNlY3Rpb25zLnB1c2goYHwgJHtldlR5cGV9IHwgJHtjb3VudH0gfGApO1xuICAgIH1cbiAgICBzZWN0aW9ucy5wdXNoKGBgKTtcbiAgICBpZiAoanMucmVjZW50RXZlbnRzLmxlbmd0aCA+IDApIHtcbiAgICAgIHNlY3Rpb25zLnB1c2goYCMjIyBSZWNlbnQgSm91cm5hbCBFdmVudHMgKGxhc3QgJHtqcy5yZWNlbnRFdmVudHMubGVuZ3RofSlgLCBgYCk7XG4gICAgICBmb3IgKGNvbnN0IGV2IG9mIGpzLnJlY2VudEV2ZW50cykge1xuICAgICAgICBjb25zdCBwYXJ0cyA9IFtgJHtldi50c30gWyR7ZXYuZXZlbnRUeXBlfV0gZmxvdz0ke2V2LmZsb3dJZC5zbGljZSgwLCA4KX1gXTtcbiAgICAgICAgaWYgKGV2LnJ1bGUpIHBhcnRzLnB1c2goYHJ1bGU9JHtldi5ydWxlfWApO1xuICAgICAgICBpZiAoZXYudW5pdElkKSBwYXJ0cy5wdXNoKGB1bml0PSR7ZXYudW5pdElkfWApO1xuICAgICAgICBzZWN0aW9ucy5wdXNoKGAtICR7cGFydHMuam9pbihcIiBcIil9YCk7XG4gICAgICB9XG4gICAgICBzZWN0aW9ucy5wdXNoKGBgKTtcbiAgICB9XG4gIH1cblxuICB3cml0ZUZpbGVTeW5jKGZpbGVQYXRoLCBzZWN0aW9ucy5qb2luKFwiXFxuXCIpLCBcInV0Zi04XCIpO1xuICByZXR1cm4gZmlsZVBhdGg7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBGb3JlbnNpY3MgU2Vzc2lvbiBNYXJrZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBpbnRlcmZhY2UgRm9yZW5zaWNzTWFya2VyIHtcbiAgcmVwb3J0UGF0aDogc3RyaW5nO1xuICBwcm9tcHRDb250ZW50OiBzdHJpbmc7XG4gIGNyZWF0ZWRBdDogc3RyaW5nO1xufVxuXG4vKipcbiAqIFdyaXRlIGEgbWFya2VyIGZpbGUgc28gdGhhdCBidWlsZEJlZm9yZUFnZW50U3RhcnRSZXN1bHQoKSBjYW4gcmUtaW5qZWN0XG4gKiB0aGUgZm9yZW5zaWNzIHByb21wdCBvbiBmb2xsb3ctdXAgdHVybnMuICAoIzI5NDEpXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3cml0ZUZvcmVuc2ljc01hcmtlcihiYXNlUGF0aDogc3RyaW5nLCByZXBvcnRQYXRoOiBzdHJpbmcsIHByb21wdENvbnRlbnQ6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBkaXIgPSBqb2luKGdzZFJvb3QoYmFzZVBhdGgpLCBcInJ1bnRpbWVcIik7XG4gIG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBjb25zdCBtYXJrZXI6IEZvcmVuc2ljc01hcmtlciA9IHtcbiAgICByZXBvcnRQYXRoLFxuICAgIHByb21wdENvbnRlbnQsXG4gICAgY3JlYXRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gIH07XG4gIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiYWN0aXZlLWZvcmVuc2ljcy5qc29uXCIpLCBKU09OLnN0cmluZ2lmeShtYXJrZXIpLCBcInV0Zi04XCIpO1xufVxuXG4vKipcbiAqIFJlYWQgdGhlIGFjdGl2ZSBmb3JlbnNpY3MgbWFya2VyLCBvciBudWxsIGlmIG5vbmUgZXhpc3RzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVhZEZvcmVuc2ljc01hcmtlcihiYXNlUGF0aDogc3RyaW5nKTogRm9yZW5zaWNzTWFya2VyIHwgbnVsbCB7XG4gIGNvbnN0IG1hcmtlclBhdGggPSBqb2luKGdzZFJvb3QoYmFzZVBhdGgpLCBcInJ1bnRpbWVcIiwgXCJhY3RpdmUtZm9yZW5zaWNzLmpzb25cIik7XG4gIGlmICghZXhpc3RzU3luYyhtYXJrZXJQYXRoKSkgcmV0dXJuIG51bGw7XG4gIHRyeSB7XG4gICAgcmV0dXJuIEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKG1hcmtlclBhdGgsIFwidXRmLThcIikpIGFzIEZvcmVuc2ljc01hcmtlcjtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFByb21wdCBGb3JtYXR0ZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIGZvcm1hdFJlcG9ydEZvclByb21wdChyZXBvcnQ6IEZvcmVuc2ljUmVwb3J0KTogc3RyaW5nIHtcbiAgY29uc3QgTUFYX0JZVEVTID0gMzAgKiAxMDI0O1xuICBjb25zdCBzZWN0aW9uczogc3RyaW5nW10gPSBbXTtcblxuICAvLyBBbm9tYWxpZXMgKG1vc3QgaW1wb3J0YW50LCBmaXJzdClcbiAgc2VjdGlvbnMucHVzaChgIyMjIEFub21hbGllcyAoJHtyZXBvcnQuYW5vbWFsaWVzLmxlbmd0aH0pYCk7XG4gIGlmIChyZXBvcnQuYW5vbWFsaWVzLmxlbmd0aCA9PT0gMCkge1xuICAgIHNlY3Rpb25zLnB1c2goXCJObyBhbm9tYWxpZXMgZGV0ZWN0ZWQuXCIpO1xuICB9IGVsc2Uge1xuICAgIGZvciAoY29uc3QgYSBvZiByZXBvcnQuYW5vbWFsaWVzKSB7XG4gICAgICBzZWN0aW9ucy5wdXNoKGAtICoqWyR7YS5zZXZlcml0eS50b1VwcGVyQ2FzZSgpfV0gJHthLnR5cGV9Kio6ICR7YS5zdW1tYXJ5fWApO1xuICAgICAgaWYgKGEuZGV0YWlscykgc2VjdGlvbnMucHVzaChgICAke2EuZGV0YWlscy5zbGljZSgwLCAzMDApfWApO1xuICAgIH1cbiAgfVxuICBzZWN0aW9ucy5wdXNoKFwiXCIpO1xuXG4gIC8vIFJlY2VudCB1bml0IGhpc3RvcnlcbiAgaWYgKHJlcG9ydC5yZWNlbnRVbml0cy5sZW5ndGggPiAwKSB7XG4gICAgc2VjdGlvbnMucHVzaChgIyMjIFJlY2VudCBVbml0cyAobGFzdCAke3JlcG9ydC5yZWNlbnRVbml0cy5sZW5ndGh9KWApO1xuICAgIHNlY3Rpb25zLnB1c2goXCJ8IFR5cGUgfCBJRCB8IENvc3QgfCBEdXJhdGlvbiB8IE1vZGVsIHxcIik7XG4gICAgc2VjdGlvbnMucHVzaChcInwtLS0tLS18LS0tLS18LS0tLS0tfC0tLS0tLS0tLS18LS0tLS0tLXxcIik7XG4gICAgZm9yIChjb25zdCB1IG9mIHJlcG9ydC5yZWNlbnRVbml0cykge1xuICAgICAgc2VjdGlvbnMucHVzaChgfCAke3UudHlwZX0gfCAke3UuaWR9IHwgJHtmb3JtYXRDb3N0KHUuY29zdCl9IHwgJHtmb3JtYXREdXJhdGlvbih1LmR1cmF0aW9uKX0gfCAke3UubW9kZWx9IHxgKTtcbiAgICB9XG4gICAgc2VjdGlvbnMucHVzaChcIlwiKTtcbiAgfVxuXG4gIC8vIFRyYWNlIHN1bW1hcmllcyAobGFzdCAzKVxuICBjb25zdCByZWNlbnRUcmFjZXMgPSByZXBvcnQudW5pdFRyYWNlcy5zbGljZSgwLCAzKTtcbiAgaWYgKHJlY2VudFRyYWNlcy5sZW5ndGggPiAwKSB7XG4gICAgc2VjdGlvbnMucHVzaChgIyMjIEFjdGl2aXR5IExvZyBUcmFjZXMgKGxhc3QgJHtyZWNlbnRUcmFjZXMubGVuZ3RofSlgKTtcbiAgICBmb3IgKGNvbnN0IHV0IG9mIHJlY2VudFRyYWNlcykge1xuICAgICAgc2VjdGlvbnMucHVzaChgKioke3V0LnVuaXRUeXBlfS8ke3V0LnVuaXRJZH0qKiAoc2VxICR7dXQuc2VxfSlgKTtcbiAgICAgIHNlY3Rpb25zLnB1c2goYC0gVG9vbCBjYWxsczogJHt1dC50cmFjZS50b29sQ2FsbENvdW50fSwgRXJyb3JzOiAke3V0LnRyYWNlLmVycm9ycy5sZW5ndGh9YCk7XG4gICAgICBpZiAodXQudHJhY2UuZmlsZXNXcml0dGVuLmxlbmd0aCA+IDApIHtcbiAgICAgICAgc2VjdGlvbnMucHVzaChgLSBGaWxlcyB3cml0dGVuOiAke3V0LnRyYWNlLmZpbGVzV3JpdHRlbi5zbGljZSgwLCA1KS5qb2luKFwiLCBcIil9YCk7XG4gICAgICB9XG4gICAgICBpZiAodXQudHJhY2UuZXJyb3JzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgc2VjdGlvbnMucHVzaChgLSBFcnJvcnM6ICR7dXQudHJhY2UuZXJyb3JzLnNsaWNlKDAsIDIpLm1hcChlID0+IGUuc2xpY2UoMCwgMjAwKSkuam9pbihcIjsgXCIpfWApO1xuICAgICAgfVxuICAgICAgaWYgKHV0LnRyYWNlLmxhc3RSZWFzb25pbmcpIHtcbiAgICAgICAgc2VjdGlvbnMucHVzaChgLSBMYXN0IHJlYXNvbmluZzogXCIke3V0LnRyYWNlLmxhc3RSZWFzb25pbmcuc2xpY2UoMCwgMzAwKX1cImApO1xuICAgICAgfVxuICAgICAgc2VjdGlvbnMucHVzaChcIlwiKTtcbiAgICB9XG4gIH1cblxuICAvLyBEb2N0b3IgaXNzdWVzIChlcnJvciBzZXZlcml0eSBvbmx5KVxuICBjb25zdCBlcnJvcklzc3VlcyA9IHJlcG9ydC5kb2N0b3JJc3N1ZXMuZmlsdGVyKGkgPT4gaS5zZXZlcml0eSA9PT0gXCJlcnJvclwiKTtcbiAgaWYgKGVycm9ySXNzdWVzLmxlbmd0aCA+IDApIHtcbiAgICBzZWN0aW9ucy5wdXNoKGAjIyMgRG9jdG9yIElzc3VlcyAoJHtlcnJvcklzc3Vlcy5sZW5ndGh9IGVycm9ycylgKTtcbiAgICBzZWN0aW9ucy5wdXNoKGZvcm1hdERvY3Rvcklzc3Vlc0ZvclByb21wdChlcnJvcklzc3VlcykpO1xuICAgIHNlY3Rpb25zLnB1c2goXCJcIik7XG4gIH1cblxuICAvLyBDcmFzaCBsb2NrXG4gIGlmIChyZXBvcnQuY3Jhc2hMb2NrKSB7XG4gICAgc2VjdGlvbnMucHVzaChcIiMjIyBDcmFzaCBMb2NrXCIpO1xuICAgIHNlY3Rpb25zLnB1c2goZm9ybWF0Q3Jhc2hJbmZvKHJlcG9ydC5jcmFzaExvY2spKTtcbiAgICBjb25zdCBhbGl2ZSA9IGlzTG9ja1Byb2Nlc3NBbGl2ZShyZXBvcnQuY3Jhc2hMb2NrKTtcbiAgICBzZWN0aW9ucy5wdXNoKGBQcm9jZXNzIGFsaXZlOiAke2FsaXZlfWApO1xuICAgIHNlY3Rpb25zLnB1c2goXCJcIik7XG4gIH1cblxuICAvLyBNZXRyaWNzIHN1bW1hcnlcbiAgaWYgKHJlcG9ydC5tZXRyaWNzPy51bml0cykge1xuICAgIGNvbnN0IHRvdGFscyA9IGdldFByb2plY3RUb3RhbHMocmVwb3J0Lm1ldHJpY3MudW5pdHMpO1xuICAgIHNlY3Rpb25zLnB1c2goXCIjIyMgTWV0cmljcyBTdW1tYXJ5XCIpO1xuICAgIHNlY3Rpb25zLnB1c2goYC0gVG90YWwgdW5pdHM6ICR7dG90YWxzLnVuaXRzfWApO1xuICAgIHNlY3Rpb25zLnB1c2goYC0gVG90YWwgY29zdDogJHtmb3JtYXRDb3N0KHRvdGFscy5jb3N0KX1gKTtcbiAgICBzZWN0aW9ucy5wdXNoKGAtIFRvdGFsIHRva2VuczogJHtmb3JtYXRUb2tlbkNvdW50KHRvdGFscy50b2tlbnMudG90YWwpfWApO1xuICAgIHNlY3Rpb25zLnB1c2goYC0gVG90YWwgZHVyYXRpb246ICR7Zm9ybWF0RHVyYXRpb24odG90YWxzLmR1cmF0aW9uKX1gKTtcbiAgICBzZWN0aW9ucy5wdXNoKFwiXCIpO1xuICB9XG5cbiAgLy8gIzQ3NjQgXHUyMDE0IHdvcmt0cmVlIHRlbGVtZXRyeSAoY29tcGFjdCBwcm9tcHQgZm9ybSlcbiAgaWYgKHJlcG9ydC53b3JrdHJlZVRlbGVtZXRyeSkge1xuICAgIGNvbnN0IHQgPSByZXBvcnQud29ya3RyZWVUZWxlbWV0cnk7XG4gICAgY29uc3QgaGFzU2lnbmFsID1cbiAgICAgIHQud29ya3RyZWVzQ3JlYXRlZCArIHQud29ya3RyZWVzTWVyZ2VkICsgdC5vcnBoYW5zRGV0ZWN0ZWQgK1xuICAgICAgdC5leGl0c1dpdGhVbm1lcmdlZFdvcmsgKyB0LmNhbm9uaWNhbFJlZGlyZWN0cyArXG4gICAgICB0LnNsaWNlc01lcmdlZCArIHQubWlsZXN0b25lUmVzcXVhc2hlcyA+IDA7XG4gICAgaWYgKGhhc1NpZ25hbCkge1xuICAgICAgc2VjdGlvbnMucHVzaChcIiMjIyBXb3JrdHJlZSBUZWxlbWV0cnlcIik7XG4gICAgICBzZWN0aW9ucy5wdXNoKGAtIENyZWF0ZWQ6ICR7dC53b3JrdHJlZXNDcmVhdGVkfSBcdTAwQjcgTWVyZ2VkOiAke3Qud29ya3RyZWVzTWVyZ2VkfSBcdTAwQjcgQ29uZmxpY3RzOiAke3QubWVyZ2VDb25mbGljdHN9YCk7XG4gICAgICBzZWN0aW9ucy5wdXNoKGAtIE9ycGhhbnM6ICR7dC5vcnBoYW5zRGV0ZWN0ZWR9IFx1MDBCNyBVbm1lcmdlZCBleGl0czogJHt0LmV4aXRzV2l0aFVubWVyZ2VkV29ya30gXHUwMEI3IFJlZGlyZWN0cyAoIzQ3NjEpOiAke3QuY2Fub25pY2FsUmVkaXJlY3RzfWApO1xuICAgICAgaWYgKHQub3JwaGFuc0RldGVjdGVkID4gMCkge1xuICAgICAgICBjb25zdCBicmVha2Rvd24gPSBPYmplY3QuZW50cmllcyh0Lm9ycGhhbnNCeVJlYXNvbilcbiAgICAgICAgICAubWFwKChbciwgbl0pID0+IGAke3J9PSR7bn1gKS5qb2luKFwiLCBcIik7XG4gICAgICAgIHNlY3Rpb25zLnB1c2goYC0gT3JwaGFuIHJlYXNvbnM6ICR7YnJlYWtkb3dufWApO1xuICAgICAgfVxuICAgICAgLy8gIzQ3NjUgXHUyMDE0IHNsaWNlLWNhZGVuY2UgY291bnRlcnMgKG9ubHkgc2hvd24gd2hlbiB0aGUgZmVhdHVyZSB3YXMgZXhlcmNpc2VkKVxuICAgICAgaWYgKHQuc2xpY2VzTWVyZ2VkICsgdC5zbGljZU1lcmdlQ29uZmxpY3RzICsgdC5taWxlc3RvbmVSZXNxdWFzaGVzID4gMCkge1xuICAgICAgICBzZWN0aW9ucy5wdXNoKGAtIFNsaWNlcyBtZXJnZWQ6ICR7dC5zbGljZXNNZXJnZWR9IFx1MDBCNyBTbGljZSBjb25mbGljdHM6ICR7dC5zbGljZU1lcmdlQ29uZmxpY3RzfSBcdTAwQjcgUmUtc3F1YXNoZXM6ICR7dC5taWxlc3RvbmVSZXNxdWFzaGVzfWApO1xuICAgICAgfVxuICAgICAgc2VjdGlvbnMucHVzaChcIlwiKTtcbiAgICB9XG4gIH1cblxuICAvLyBBY3Rpdml0eSBsb2cgbWV0YWRhdGFcbiAgaWYgKHJlcG9ydC5hY3Rpdml0eUxvZ01ldGEpIHtcbiAgICBjb25zdCBtZXRhID0gcmVwb3J0LmFjdGl2aXR5TG9nTWV0YTtcbiAgICBzZWN0aW9ucy5wdXNoKFwiIyMjIEFjdGl2aXR5IExvZyBPdmVydmlld1wiKTtcbiAgICBzZWN0aW9ucy5wdXNoKGAtIEZpbGVzOiAke21ldGEuZmlsZUNvdW50fSwgVG90YWwgc2l6ZTogJHsobWV0YS50b3RhbFNpemVCeXRlcyAvIDEwMjQpLnRvRml4ZWQoMSl9IEtCYCk7XG4gICAgaWYgKG1ldGEub2xkZXN0RmlsZSkgc2VjdGlvbnMucHVzaChgLSBPbGRlc3Q6ICR7bWV0YS5vbGRlc3RGaWxlfWApO1xuICAgIGlmIChtZXRhLm5ld2VzdEZpbGUpIHNlY3Rpb25zLnB1c2goYC0gTmV3ZXN0OiAke21ldGEubmV3ZXN0RmlsZX1gKTtcbiAgICBzZWN0aW9ucy5wdXNoKFwiXCIpO1xuICB9XG5cbiAgLy8gSm91cm5hbCBzdW1tYXJ5IFx1MjAxNCBzdHJ1Y3R1cmVkIGV2ZW50IHRpbWVsaW5lXG4gIGlmIChyZXBvcnQuam91cm5hbFN1bW1hcnkpIHtcbiAgICBjb25zdCBqcyA9IHJlcG9ydC5qb3VybmFsU3VtbWFyeTtcbiAgICBzZWN0aW9ucy5wdXNoKFwiIyMjIEpvdXJuYWwgU3VtbWFyeSAoSXRlcmF0aW9uIEV2ZW50IExvZylcIik7XG4gICAgc2VjdGlvbnMucHVzaChgLSBUb3RhbCBlbnRyaWVzOiAke2pzLnRvdGFsRW50cmllc30sIERpc3RpbmN0IGZsb3dzOiAke2pzLmZsb3dDb3VudH0sIERhaWx5IGZpbGVzOiAke2pzLmZpbGVDb3VudH1gKTtcbiAgICBpZiAoanMub2xkZXN0RW50cnkpIHNlY3Rpb25zLnB1c2goYC0gRGF0ZSByYW5nZTogJHtqcy5vbGRlc3RFbnRyeX0gXHUyMDE0ICR7anMubmV3ZXN0RW50cnl9YCk7XG5cbiAgICAvLyBFdmVudCB0eXBlIGRpc3RyaWJ1dGlvbiAoY29tcGFjdClcbiAgICBjb25zdCBldmVudFBhaXJzID0gT2JqZWN0LmVudHJpZXMoanMuZXZlbnRDb3VudHMpLnNvcnQoKGEsIGIpID0+IGJbMV0gLSBhWzFdKTtcbiAgICBzZWN0aW9ucy5wdXNoKGAtIEV2ZW50czogJHtldmVudFBhaXJzLm1hcCgoW3QsIGNdKSA9PiBgJHt0fSgke2N9KWApLmpvaW4oXCIsIFwiKX1gKTtcblxuICAgIC8vIFJlY2VudCBldmVudHMgdGltZWxpbmUgKGZvciB0cmFjaW5nIHdoYXQganVzdCBoYXBwZW5lZClcbiAgICBpZiAoanMucmVjZW50RXZlbnRzLmxlbmd0aCA+IDApIHtcbiAgICAgIHNlY3Rpb25zLnB1c2goXCJcIik7XG4gICAgICBzZWN0aW9ucy5wdXNoKGAqKlJlY2VudCBKb3VybmFsIEV2ZW50cyAobGFzdCAke2pzLnJlY2VudEV2ZW50cy5sZW5ndGh9KToqKmApO1xuICAgICAgZm9yIChjb25zdCBldiBvZiBqcy5yZWNlbnRFdmVudHMpIHtcbiAgICAgICAgY29uc3QgcGFydHMgPSBbYCR7ZXYudHN9IFske2V2LmV2ZW50VHlwZX1dIGZsb3c9JHtldi5mbG93SWQuc2xpY2UoMCwgOCl9YF07XG4gICAgICAgIGlmIChldi5ydWxlKSBwYXJ0cy5wdXNoKGBydWxlPSR7ZXYucnVsZX1gKTtcbiAgICAgICAgaWYgKGV2LnVuaXRJZCkgcGFydHMucHVzaChgdW5pdD0ke2V2LnVuaXRJZH1gKTtcbiAgICAgICAgc2VjdGlvbnMucHVzaChgLSAke3BhcnRzLmpvaW4oXCIgXCIpfWApO1xuICAgICAgfVxuICAgIH1cbiAgICBzZWN0aW9ucy5wdXNoKFwiXCIpO1xuICB9XG5cbiAgLy8gQ29tcGxldGlvbiBzdGF0dXMgXHUyMDE0IHByZWZlciBEQiBjb3VudHMsIGZhbGwgYmFjayB0byBsZWdhY3kgY29tcGxldGVkLXVuaXRzLmpzb25cbiAgaWYgKHJlcG9ydC5kYkNvbXBsZXRpb25Db3VudHMpIHtcbiAgICBjb25zdCBjID0gcmVwb3J0LmRiQ29tcGxldGlvbkNvdW50cztcbiAgICBzZWN0aW9ucy5wdXNoKGAjIyMgQ29tcGxldGlvbiBTdGF0dXMgKGZyb20gREIpYCk7XG4gICAgc2VjdGlvbnMucHVzaChgLSAke2MubWlsZXN0b25lc30vJHtjLm1pbGVzdG9uZXNUb3RhbH0gbWlsZXN0b25lcyBjb21wbGV0ZWApO1xuICAgIHNlY3Rpb25zLnB1c2goYC0gJHtjLnNsaWNlc30vJHtjLnNsaWNlc1RvdGFsfSBzbGljZXMgY29tcGxldGVgKTtcbiAgICBzZWN0aW9ucy5wdXNoKGAtICR7Yy50YXNrc30vJHtjLnRhc2tzVG90YWx9IHRhc2tzIGNvbXBsZXRlYCk7XG4gIH0gZWxzZSB7XG4gICAgc2VjdGlvbnMucHVzaChgIyMjIENvbXBsZXRlZCBLZXlzOiAke3JlcG9ydC5jb21wbGV0ZWRLZXlzLmxlbmd0aH1gKTtcbiAgfVxuICBzZWN0aW9ucy5wdXNoKGAjIyMgR1NEIFZlcnNpb246ICR7cmVwb3J0LmdzZFZlcnNpb259YCk7XG4gIHNlY3Rpb25zLnB1c2goYCMjIyBBY3RpdmUgTWlsZXN0b25lOiAke3JlcG9ydC5hY3RpdmVNaWxlc3RvbmUgPz8gXCJub25lXCJ9YCk7XG4gIHNlY3Rpb25zLnB1c2goYCMjIyBBY3RpdmUgU2xpY2U6ICR7cmVwb3J0LmFjdGl2ZVNsaWNlID8/IFwibm9uZVwifWApO1xuICBpZiAocmVwb3J0LmFjdGl2ZVdvcmt0cmVlKSB7XG4gICAgc2VjdGlvbnMucHVzaChgIyMjIEFjdGl2ZSBXb3JrdHJlZTogJHtyZXBvcnQuYWN0aXZlV29ya3RyZWV9YCk7XG4gICAgc2VjdGlvbnMucHVzaChgTm90ZTogQWN0aXZpdHkgbG9ncyB3ZXJlIHNjYW5uZWQgZnJvbSBib3RoIHRoZSB3b3JrdHJlZSBhbmQgdGhlIHByb2plY3Qgcm9vdC4gV29ya3RyZWUgbG9ncyB0YWtlIHByaW9yaXR5LmApO1xuICB9XG5cbiAgbGV0IHJlc3VsdCA9IHNlY3Rpb25zLmpvaW4oXCJcXG5cIik7XG4gIGlmIChyZXN1bHQubGVuZ3RoID4gTUFYX0JZVEVTKSB7XG4gICAgcmVzdWx0ID0gcmVzdWx0LnNsaWNlKDAsIE1BWF9CWVRFUykgKyBcIlxcblxcblsuLi4gdHJ1bmNhdGVkIGF0IDMwS0IgLi4uXVwiO1xuICB9XG4gIHJldHVybiByZXN1bHQ7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBSZWRhY3Rpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIHJlZGFjdEZvckdpdEh1Yih0ZXh0OiBzdHJpbmcsIGJhc2VQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICBsZXQgcmVzdWx0ID0gdGV4dDtcblxuICAvLyBCdWlsZCByZWdleCB0aGF0IG1hdGNoZXMgYm90aCAvIGFuZCBcXCBzZXBhcmF0b3IgdmFyaWFudHMgKFdpbmRvd3MpXG4gIC8vIE5vcm1hbGl6ZSB0byAvIGZpcnN0LCBlc2NhcGUgZm9yIHJlZ2V4LCB0aGVuIHJlcGxhY2UgZWFjaCAvIHdpdGggWy9cXFxcXVxuICBjb25zdCBlc2MgPSAoczogc3RyaW5nKSA9PiBzLnJlcGxhY2UoL1suKis/XiR7fSgpfFtcXF1cXFxcXS9nLCBcIlxcXFwkJlwiKTtcbiAgY29uc3QgcGF0aFJlID0gKHA6IHN0cmluZykgPT5cbiAgICBuZXcgUmVnRXhwKGVzYyhwLnJlcGxhY2UoL1xcXFwvZywgXCIvXCIpKS5yZXBsYWNlKC9cXC8vZywgXCJbL1xcXFxcXFxcXVwiKSwgXCJnaVwiKTtcblxuICAvLyBSZXBsYWNlIGFic29sdXRlIHBhdGhzXG4gIHJlc3VsdCA9IHJlc3VsdC5yZXBsYWNlKHBhdGhSZShiYXNlUGF0aCksIFwiLlwiKTtcbiAgLy8gUmVkYWN0IEdTRF9IT01FIGZpcnN0ICh3aGVuIGl0J3Mgb3V0c2lkZSB+KSwgdGhlbiBPUyBob21lLlxuICAvLyBPcmRlciBtYXR0ZXJzOiBsb25nZXIgcGF0aCBtdXN0IGJlIHJlcGxhY2VkIGJlZm9yZSB0aGUgc2hvcnRlciBwcmVmaXguXG4gIGNvbnN0IGdzZEhvbWVQYXRoID0gZ3NkSG9tZSgpO1xuICBpZiAoIWdzZEhvbWVQYXRoLnN0YXJ0c1dpdGgoaG9tZWRpcigpKSkge1xuICAgIHJlc3VsdCA9IHJlc3VsdC5yZXBsYWNlKHBhdGhSZShnc2RIb21lUGF0aCksIFwifi8uZ3NkXCIpO1xuICB9XG4gIHJlc3VsdCA9IHJlc3VsdC5yZXBsYWNlKHBhdGhSZShob21lZGlyKCkpLCBcIn5cIik7XG5cbiAgLy8gU3RyaXAgQVBJIGtleSBwYXR0ZXJuc1xuICByZXN1bHQgPSByZXN1bHQucmVwbGFjZSgvc2stW2EtekEtWjAtOV17MjAsfS9nLCBcInNrLSoqKlwiKTtcbiAgcmVzdWx0ID0gcmVzdWx0LnJlcGxhY2UoL0JlYXJlclxccytcXFMrL2csIFwiQmVhcmVyICoqKlwiKTtcblxuICAvLyBTdHJpcCBlbnYgdmFyIGFzc2lnbm1lbnRzXG4gIHJlc3VsdCA9IHJlc3VsdC5yZXBsYWNlKC9bQS1aX117Mix9PVxcUysvZywgKG1hdGNoKSA9PiB7XG4gICAgY29uc3QgZXEgPSBtYXRjaC5pbmRleE9mKFwiPVwiKTtcbiAgICByZXR1cm4gbWF0Y2guc2xpY2UoMCwgZXEgKyAxKSArIFwiKioqXCI7XG4gIH0pO1xuXG4gIC8vIFRydW5jYXRlIGxvbmcgbGluZXNcbiAgcmVzdWx0ID0gcmVzdWx0LnNwbGl0KFwiXFxuXCIpLm1hcChsaW5lID0+XG4gICAgbGluZS5sZW5ndGggPiA1MDAgPyBsaW5lLnNsaWNlKDAsIDQ5NykgKyBcIi4uLlwiIDogbGluZSxcbiAg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
