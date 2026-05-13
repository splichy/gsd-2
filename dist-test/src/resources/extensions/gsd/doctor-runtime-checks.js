import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { cleanNumberedGsdVariants } from "./repo-identity.js";
import { milestonesDir, gsdRoot, resolveGsdRootFile } from "./paths.js";
import { deriveState, isGhostMilestone, isReusableGhostMilestone } from "./state.js";
import { saveFile } from "./files.js";
import { nativeIsRepo, nativeForEachRef, nativeUpdateRef } from "./native-git-bridge.js";
import { readCrashLock, isLockProcessAlive, clearStaleWorkerLock } from "./crash-recovery.js";
import { getActiveAutoWorkers } from "./db/auto-workers.js";
import { normalizeRealPath } from "./paths.js";
import { ensureGitignore, isGsdGitignored } from "./gitignore.js";
import { readAllSessionStatuses, isSessionStale, removeSessionStatus } from "./session-status-io.js";
import { recoverFailedMigration } from "./migrate-external.js";
import { splitCompletedKey } from "./forensics.js";
import { findMilestoneIds } from "./milestone-ids.js";
const MAX_UAT_ATTEMPTS = 3;
function hasAssessmentVerdict(basePath, mid, sid) {
  const assessmentPath = join(gsdRoot(basePath), "milestones", mid, "slices", sid, `${sid}-ASSESSMENT.md`);
  if (!existsSync(assessmentPath)) return false;
  try {
    return /^\s*verdict\s*:\s*(PASS|FAIL|PARTIAL)\b/im.test(readFileSync(assessmentPath, "utf-8"));
  } catch {
    return false;
  }
}
async function checkRuntimeHealth(basePath, issues, fixesApplied, shouldFix) {
  const root = gsdRoot(basePath);
  try {
    const lock = readCrashLock(basePath);
    if (lock) {
      const alive = isLockProcessAlive(lock);
      if (!alive) {
        issues.push({
          severity: "error",
          code: "stale_crash_lock",
          scope: "project",
          unitId: "project",
          message: `Stale auto-mode worker (PID ${lock.pid}, started ${lock.startedAt}, was executing ${lock.unitType} ${lock.unitId}) \u2014 process is no longer running`,
          file: "<workers table>",
          fixable: true
        });
        if (shouldFix("stale_crash_lock")) {
          clearStaleWorkerLock(basePath);
          fixesApplied.push("cleared stale auto-mode worker state");
        }
      }
    }
  } catch {
  }
  try {
    const lockDir = join(dirname(root), `${basename(root)}.lock`);
    if (existsSync(lockDir)) {
      const statRes = statSync(lockDir);
      if (statRes.isDirectory()) {
        let lockHolderAlive = false;
        try {
          const projectRoot = normalizeRealPath(basePath);
          for (const worker of getActiveAutoWorkers()) {
            if (worker.project_root_realpath !== projectRoot) continue;
            try {
              if (isLockProcessAlive({
                pid: worker.pid,
                startedAt: worker.started_at,
                unitType: "starting",
                unitId: "bootstrap",
                unitStartedAt: worker.started_at
              })) {
                lockHolderAlive = true;
                break;
              }
            } catch {
            }
          }
        } catch {
        }
        if (!lockHolderAlive) {
          issues.push({
            severity: "error",
            code: "stranded_lock_directory",
            scope: "project",
            unitId: "project",
            message: `Stranded lock directory "${lockDir}" exists but no live process holds the session lock. This blocks new auto-mode sessions from starting.`,
            file: lockDir,
            fixable: true
          });
          if (shouldFix("stranded_lock_directory")) {
            try {
              rmSync(lockDir, { recursive: true, force: true });
              fixesApplied.push(`removed stranded lock directory ${lockDir}`);
            } catch {
              fixesApplied.push(`failed to remove stranded lock directory ${lockDir}`);
            }
          }
        }
      }
    }
  } catch {
  }
  try {
    const parallelStatuses = readAllSessionStatuses(basePath);
    for (const status of parallelStatuses) {
      if (isSessionStale(status)) {
        issues.push({
          severity: "warning",
          code: "stale_parallel_session",
          scope: "project",
          unitId: status.milestoneId,
          message: `Stale parallel session for ${status.milestoneId} (PID ${status.pid}, started ${new Date(status.startedAt).toISOString()}, last heartbeat ${new Date(status.lastHeartbeat).toISOString()}) \u2014 process is no longer running`,
          file: `.gsd/parallel/${status.milestoneId}.status.json`,
          fixable: true
        });
        if (shouldFix("stale_parallel_session")) {
          removeSessionStatus(basePath, status.milestoneId);
          fixesApplied.push(`cleaned up stale parallel session for ${status.milestoneId}`);
        }
      }
    }
  } catch {
  }
  try {
    const completedKeysFile = join(root, "completed-units.json");
    if (existsSync(completedKeysFile)) {
      const raw = readFileSync(completedKeysFile, "utf-8");
      const keys = JSON.parse(raw);
      const orphaned = [];
      for (const key of keys) {
        const parsed = splitCompletedKey(key);
        if (!parsed) continue;
        const { unitType, unitId } = parsed;
        const { verifyExpectedArtifact } = await import("./auto-recovery.js");
        if (!verifyExpectedArtifact(unitType, unitId, basePath)) {
          orphaned.push(key);
        }
      }
      if (orphaned.length > 0) {
        issues.push({
          severity: "warning",
          code: "orphaned_completed_units",
          scope: "project",
          unitId: "project",
          message: `${orphaned.length} completed-unit key(s) reference missing artifacts: ${orphaned.slice(0, 3).join(", ")}${orphaned.length > 3 ? "..." : ""}`,
          file: ".gsd/completed-units.json",
          fixable: true
        });
        if (shouldFix("orphaned_completed_units")) {
          const orphanedSet = new Set(orphaned);
          const remaining = keys.filter((key) => !orphanedSet.has(key));
          await saveFile(completedKeysFile, JSON.stringify(remaining));
          fixesApplied.push(`removed ${orphaned.length} orphaned completed-unit key(s)`);
        }
      }
    }
  } catch {
  }
  try {
    const hookStateFile = join(root, "hook-state.json");
    if (existsSync(hookStateFile)) {
      const raw = readFileSync(hookStateFile, "utf-8");
      const state = JSON.parse(raw);
      const hasCycleCounts = state.cycleCounts && typeof state.cycleCounts === "object" && Object.keys(state.cycleCounts).length > 0;
      if (hasCycleCounts) {
        const lock = readCrashLock(basePath);
        const autoRunning = lock ? isLockProcessAlive(lock) : false;
        if (!autoRunning) {
          issues.push({
            severity: "info",
            code: "stale_hook_state",
            scope: "project",
            unitId: "project",
            message: `hook-state.json has ${Object.keys(state.cycleCounts).length} residual cycle count(s) from a previous session`,
            file: ".gsd/hook-state.json",
            fixable: true
          });
          if (shouldFix("stale_hook_state")) {
            const { clearPersistedHookState } = await import("./post-unit-hooks.js");
            clearPersistedHookState(basePath);
            fixesApplied.push("cleared stale hook-state.json");
          }
        }
      }
    }
  } catch {
  }
  try {
    const runtimeDir = join(root, "runtime");
    if (existsSync(runtimeDir)) {
      const uatCounterPattern = /^uat-count-(M\d+)-(S\d+)\.json$/;
      for (const fileName of readdirSync(runtimeDir)) {
        const match = fileName.match(uatCounterPattern);
        if (!match) continue;
        const [, mid, sid] = match;
        if (!mid || !sid || hasAssessmentVerdict(basePath, mid, sid)) continue;
        const filePath = join(runtimeDir, fileName);
        let count = 0;
        try {
          const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
          count = typeof parsed.count === "number" ? parsed.count : 0;
        } catch {
          count = MAX_UAT_ATTEMPTS + 1;
        }
        if (count <= MAX_UAT_ATTEMPTS) continue;
        issues.push({
          severity: "warning",
          code: "uat_retry_exhausted",
          scope: "slice",
          unitId: `${mid}/${sid}`,
          message: `run-uat for ${mid}/${sid} exhausted ${count - 1} retry attempt(s) without an ASSESSMENT verdict. Reset the retry counter after fixing the underlying UAT/tool issue, then rerun /gsd auto.`,
          file: `.gsd/runtime/${fileName}`,
          fixable: true
        });
        if (shouldFix("uat_retry_exhausted")) {
          rmSync(filePath, { force: true });
          fixesApplied.push(`reset exhausted run-uat retry counter for ${mid}/${sid}`);
        }
      }
    }
  } catch {
  }
  try {
    const activityDir = join(root, "activity");
    if (existsSync(activityDir)) {
      const files = readdirSync(activityDir);
      let totalSize = 0;
      for (const f of files) {
        try {
          totalSize += statSync(join(activityDir, f)).size;
        } catch {
        }
      }
      const totalMB = totalSize / (1024 * 1024);
      const BLOAT_FILE_THRESHOLD = 500;
      const BLOAT_SIZE_MB = 100;
      if (files.length > BLOAT_FILE_THRESHOLD || totalMB > BLOAT_SIZE_MB) {
        issues.push({
          severity: "warning",
          code: "activity_log_bloat",
          scope: "project",
          unitId: "project",
          message: `Activity logs: ${files.length} files, ${totalMB.toFixed(1)}MB (thresholds: ${BLOAT_FILE_THRESHOLD} files / ${BLOAT_SIZE_MB}MB)`,
          file: ".gsd/activity/",
          fixable: true
        });
        if (shouldFix("activity_log_bloat")) {
          const { pruneActivityLogs } = await import("./activity-log.js");
          pruneActivityLogs(activityDir, 7);
          fixesApplied.push("pruned activity logs (7-day retention)");
        }
      }
    }
  } catch {
  }
  try {
    const stateFilePath = resolveGsdRootFile(basePath, "STATE");
    const milestonesPath = milestonesDir(basePath);
    if (existsSync(milestonesPath)) {
      if (!existsSync(stateFilePath)) {
        issues.push({
          severity: "warning",
          code: "state_file_missing",
          scope: "project",
          unitId: "project",
          message: "STATE.md is missing \u2014 state display will not work",
          file: ".gsd/STATE.md",
          fixable: true
        });
        if (shouldFix("state_file_missing")) {
          const state = await deriveState(basePath);
          await saveFile(stateFilePath, buildStateMarkdownForCheck(state));
          fixesApplied.push("created STATE.md from derived state");
        }
      } else {
        const currentContent = readFileSync(stateFilePath, "utf-8");
        const state = await deriveState(basePath);
        const freshContent = buildStateMarkdownForCheck(state);
        const extractFields = (content) => {
          const milestone = content.match(/\*\*Active Milestone:\*\*\s*(.+)/)?.[1]?.trim() ?? "";
          const slice = content.match(/\*\*Active Slice:\*\*\s*(.+)/)?.[1]?.trim() ?? "";
          const phase = content.match(/\*\*Phase:\*\*\s*(.+)/)?.[1]?.trim() ?? "";
          return { milestone, slice, phase };
        };
        const current = extractFields(currentContent);
        const fresh = extractFields(freshContent);
        if (current.milestone !== fresh.milestone || current.slice !== fresh.slice || current.phase !== fresh.phase) {
          issues.push({
            severity: "warning",
            code: "state_file_stale",
            scope: "project",
            unitId: "project",
            message: `STATE.md is stale \u2014 shows "${current.phase}" but derived state is "${fresh.phase}"`,
            file: ".gsd/STATE.md",
            fixable: true
          });
          if (shouldFix("state_file_stale")) {
            await saveFile(stateFilePath, freshContent);
            fixesApplied.push("rebuilt STATE.md from derived state");
          }
        }
      }
    }
  } catch {
  }
  try {
    const gitignorePath = join(basePath, ".gitignore");
    if (existsSync(gitignorePath) && nativeIsRepo(basePath)) {
      const content = readFileSync(gitignorePath, "utf-8");
      const existingLines = new Set(
        content.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
      );
      const criticalPatterns = [
        ".gsd/activity/",
        ".gsd/runtime/",
        ".gsd/auto.lock",
        ".gsd/gsd.db*",
        ".gsd/completed-units*.json",
        ".gsd/event-log.jsonl"
      ];
      const hasBlanketIgnore = existingLines.has(".gsd/") || existingLines.has(".gsd");
      if (!hasBlanketIgnore) {
        const missing = criticalPatterns.filter((p) => !existingLines.has(p));
        if (missing.length > 0) {
          issues.push({
            severity: "warning",
            code: "gitignore_missing_patterns",
            scope: "project",
            unitId: "project",
            message: `${missing.length} critical GSD runtime pattern(s) missing from .gitignore: ${missing.join(", ")}`,
            file: ".gitignore",
            fixable: true
          });
          if (shouldFix("gitignore_missing_patterns")) {
            ensureGitignore(basePath);
            fixesApplied.push("added missing GSD runtime patterns to .gitignore");
          }
        }
      }
    }
  } catch {
  }
  try {
    const localGsd = join(basePath, ".gsd");
    if (existsSync(localGsd)) {
      const stat = lstatSync(localGsd);
      const migratingPath = join(basePath, ".gsd.migrating");
      if (existsSync(migratingPath)) {
        issues.push({
          severity: "error",
          code: "failed_migration",
          scope: "project",
          unitId: "project",
          message: "Found .gsd.migrating \u2014 a previous external state migration failed. State may be incomplete.",
          file: ".gsd.migrating",
          fixable: true
        });
        if (shouldFix("failed_migration")) {
          if (recoverFailedMigration(basePath)) {
            fixesApplied.push("recovered failed migration (.gsd.migrating \u2192 .gsd)");
          }
        }
      }
      if (stat.isSymbolicLink()) {
        try {
          realpathSync(localGsd);
        } catch {
          issues.push({
            severity: "error",
            code: "broken_symlink",
            scope: "project",
            unitId: "project",
            message: ".gsd symlink target does not exist. External state directory may have been deleted.",
            file: ".gsd",
            fixable: false
          });
        }
        if (nativeIsRepo(basePath) && !isGsdGitignored(basePath)) {
          issues.push({
            severity: "warning",
            code: "symlinked_gsd_unignored",
            scope: "project",
            unitId: "project",
            message: ".gsd is a symlink to external state but is not listed in .gitignore. This causes git pathspec exclusions to fail and can lead to silently dropped new files during auto-commit. Add `.gsd` to .gitignore.",
            file: ".gitignore",
            fixable: true
          });
          if (shouldFix("symlinked_gsd_unignored")) {
            const modified = ensureGitignore(basePath);
            if (modified) fixesApplied.push("added .gsd to .gitignore (symlinked external state)");
          }
        }
      }
    }
  } catch {
  }
  try {
    const variantPattern = /^\.gsd \d+$/;
    const entries = readdirSync(basePath);
    const variants = entries.filter((e) => variantPattern.test(e));
    if (variants.length > 0) {
      for (const v of variants) {
        issues.push({
          severity: "warning",
          code: "numbered_gsd_variant",
          scope: "project",
          unitId: "project",
          message: `Found macOS collision variant "${v}" \u2014 this can cause GSD state to appear deleted.`,
          file: v,
          fixable: true
        });
      }
      if (shouldFix("numbered_gsd_variant")) {
        const removed = cleanNumberedGsdVariants(basePath);
        for (const name of removed) {
          fixesApplied.push(`removed numbered .gsd variant: ${name}`);
        }
      }
    }
  } catch {
  }
  try {
    const metricsPath = join(root, "metrics.json");
    if (existsSync(metricsPath)) {
      try {
        const raw = readFileSync(metricsPath, "utf-8");
        const ledger = JSON.parse(raw);
        if (ledger.version !== 1 || !Array.isArray(ledger.units)) {
          issues.push({
            severity: "warning",
            code: "metrics_ledger_corrupt",
            scope: "project",
            unitId: "project",
            message: "metrics.json has an unexpected structure (version !== 1 or units is not an array) \u2014 metrics data may be unreliable",
            file: ".gsd/metrics.json",
            fixable: false
          });
        }
      } catch {
        issues.push({
          severity: "warning",
          code: "metrics_ledger_corrupt",
          scope: "project",
          unitId: "project",
          message: "metrics.json is not valid JSON \u2014 metrics data may be corrupt",
          file: ".gsd/metrics.json",
          fixable: false
        });
      }
    }
  } catch {
  }
  try {
    const metricsFilePath = join(root, "metrics.json");
    if (existsSync(metricsFilePath)) {
      try {
        const raw = readFileSync(metricsFilePath, "utf-8");
        const parsed = JSON.parse(raw);
        const BLOAT_UNITS_THRESHOLD = 2e3;
        if (parsed.version === 1 && Array.isArray(parsed.units) && parsed.units.length > BLOAT_UNITS_THRESHOLD) {
          const fileSizeMB = (statSync(metricsFilePath).size / (1024 * 1024)).toFixed(1);
          issues.push({
            severity: "warning",
            code: "metrics_ledger_bloat",
            scope: "project",
            unitId: "project",
            message: `metrics.json has ${parsed.units.length} unit entries (${fileSizeMB}MB) \u2014 threshold is ${BLOAT_UNITS_THRESHOLD}. Run /gsd doctor --fix to prune to the newest 1500 entries.`,
            file: ".gsd/metrics.json",
            fixable: true
          });
          if (shouldFix("metrics_ledger_bloat")) {
            const { pruneMetricsLedger } = await import("./metrics.js");
            const removed = pruneMetricsLedger(basePath, 1500);
            fixesApplied.push(`pruned metrics ledger: removed ${removed} oldest entries (${parsed.units.length - removed} remain)`);
          }
        }
      } catch {
      }
    }
  } catch {
  }
  try {
    const MAX_FILE_BYTES = 100 * 1024;
    const milestonesPath = milestonesDir(basePath);
    if (existsSync(milestonesPath)) {
      let scanForLargeFiles2 = function(dir, depth = 0) {
        if (depth > 6) return;
        try {
          for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            try {
              const s = statSync(full);
              if (s.isDirectory()) {
                scanForLargeFiles2(full, depth + 1);
                continue;
              }
              if (entry.endsWith(".md") && s.size > MAX_FILE_BYTES) {
                largeFiles.push({ path: full.replace(basePath + "/", ""), sizeKB: Math.round(s.size / 1024) });
              }
            } catch {
            }
          }
        } catch {
        }
      };
      var scanForLargeFiles = scanForLargeFiles2;
      const largeFiles = [];
      scanForLargeFiles2(milestonesPath);
      if (largeFiles.length > 0) {
        largeFiles.sort((a, b) => b.sizeKB - a.sizeKB);
        const worst = largeFiles[0];
        issues.push({
          severity: "warning",
          code: "large_planning_file",
          scope: "project",
          unitId: "project",
          message: `${largeFiles.length} planning file(s) exceed 100KB \u2014 largest: ${worst.path} (${worst.sizeKB}KB). Large files cause LLM context pressure.`,
          file: worst.path,
          fixable: false
        });
      }
    }
  } catch {
  }
  try {
    if (nativeIsRepo(basePath)) {
      const refs = nativeForEachRef(basePath, "refs/gsd/snapshots/");
      if (refs.length > 50) {
        issues.push({
          severity: "warning",
          code: "snapshot_ref_bloat",
          scope: "project",
          unitId: "project",
          message: `${refs.length} snapshot refs found under refs/gsd/snapshots/ \u2014 pruning to newest 5 per label will reclaim git storage`,
          fixable: true
        });
        if (shouldFix("snapshot_ref_bloat")) {
          const byLabel = /* @__PURE__ */ new Map();
          for (const ref of refs) {
            const parts = ref.split("/");
            const label = parts.slice(0, -1).join("/");
            if (!byLabel.has(label)) byLabel.set(label, []);
            byLabel.get(label).push(ref);
          }
          let pruned = 0;
          for (const [, labelRefs] of byLabel) {
            const sorted = labelRefs.sort();
            for (const old of sorted.slice(0, -5)) {
              try {
                nativeUpdateRef(basePath, old);
                pruned++;
              } catch {
              }
            }
          }
          if (pruned > 0) {
            fixesApplied.push(`pruned ${pruned} old snapshot ref(s)`);
          }
        }
      }
    }
  } catch {
  }
  try {
    const milestoneIds = findMilestoneIds(basePath);
    const hasDbFile = existsSync(join(root, "gsd.db"));
    for (const mid of milestoneIds) {
      const isOrphan = isReusableGhostMilestone(basePath, mid) || !hasDbFile && isGhostMilestone(basePath, mid);
      if (isOrphan) {
        issues.push({
          severity: "warning",
          code: "orphan_milestone_dir",
          scope: "milestone",
          unitId: mid,
          message: `Orphan milestone directory: ${mid} \u2014 directory exists on disk with no DB row, no worktree, and no content files. This stub skews milestone ID generation and should be removed.`,
          file: `.gsd/milestones/${mid}`,
          fixable: true
        });
        if (shouldFix("orphan_milestone_dir")) {
          try {
            const orphanPath = join(milestonesDir(basePath), mid);
            rmSync(orphanPath, { recursive: true, force: true });
            fixesApplied.push(`removed orphan milestone directory: ${mid}`);
          } catch {
          }
        }
      }
    }
  } catch {
  }
}
function buildStateMarkdownForCheck(state) {
  const lines = [];
  lines.push("# GSD State", "");
  const activeMilestone = state.activeMilestone ? `${state.activeMilestone.id}: ${state.activeMilestone.title}` : "None";
  const activeSlice = state.activeSlice ? `${state.activeSlice.id}: ${state.activeSlice.title}` : "None";
  lines.push(`**Active Milestone:** ${activeMilestone}`);
  lines.push(`**Active Slice:** ${activeSlice}`);
  lines.push(`**Phase:** ${state.phase}`);
  if (state.requirements) {
    lines.push(`**Requirements Status:** ${state.requirements.active} active \xB7 ${state.requirements.validated} validated \xB7 ${state.requirements.deferred} deferred \xB7 ${state.requirements.outOfScope} out of scope`);
  }
  lines.push("");
  lines.push("## Milestone Registry");
  for (const entry of state.registry) {
    const glyph = entry.status === "complete" ? "\u2705" : entry.status === "active" ? "\u{1F504}" : entry.status === "parked" ? "\u23F8\uFE0F" : "\u2B1C";
    lines.push(`- ${glyph} **${entry.id}:** ${entry.title}`);
  }
  lines.push("");
  lines.push("## Recent Decisions");
  if (state.recentDecisions.length > 0) {
    for (const decision of state.recentDecisions) lines.push(`- ${decision}`);
  } else {
    lines.push("- None recorded");
  }
  lines.push("");
  lines.push("## Blockers");
  if (state.blockers.length > 0) {
    for (const blocker of state.blockers) lines.push(`- ${blocker}`);
  } else {
    lines.push("- None");
  }
  lines.push("");
  lines.push("## Next Action");
  lines.push(state.nextAction || "None");
  lines.push("");
  return lines.join("\n");
}
export {
  checkRuntimeHealth
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9kb2N0b3ItcnVudGltZS1jaGVja3MudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IGV4aXN0c1N5bmMsIGxzdGF0U3luYywgcmVhZGRpclN5bmMsIHJlYWRGaWxlU3luYywgcmVhbHBhdGhTeW5jLCBybVN5bmMsIHN0YXRTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBkaXJuYW1lLCBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuXG5pbXBvcnQgdHlwZSB7IERvY3Rvcklzc3VlLCBEb2N0b3JJc3N1ZUNvZGUgfSBmcm9tIFwiLi9kb2N0b3ItdHlwZXMuanNcIjtcbmltcG9ydCB7IGNsZWFuTnVtYmVyZWRHc2RWYXJpYW50cyB9IGZyb20gXCIuL3JlcG8taWRlbnRpdHkuanNcIjtcbmltcG9ydCB7IG1pbGVzdG9uZXNEaXIsIGdzZFJvb3QsIHJlc29sdmVHc2RSb290RmlsZSB9IGZyb20gXCIuL3BhdGhzLmpzXCI7XG5pbXBvcnQgeyBkZXJpdmVTdGF0ZSwgaXNHaG9zdE1pbGVzdG9uZSwgaXNSZXVzYWJsZUdob3N0TWlsZXN0b25lIH0gZnJvbSBcIi4vc3RhdGUuanNcIjtcbmltcG9ydCB7IHNhdmVGaWxlIH0gZnJvbSBcIi4vZmlsZXMuanNcIjtcbmltcG9ydCB7IG5hdGl2ZUlzUmVwbywgbmF0aXZlRm9yRWFjaFJlZiwgbmF0aXZlVXBkYXRlUmVmIH0gZnJvbSBcIi4vbmF0aXZlLWdpdC1icmlkZ2UuanNcIjtcbmltcG9ydCB7IHJlYWRDcmFzaExvY2ssIGlzTG9ja1Byb2Nlc3NBbGl2ZSwgY2xlYXJTdGFsZVdvcmtlckxvY2sgfSBmcm9tIFwiLi9jcmFzaC1yZWNvdmVyeS5qc1wiO1xuaW1wb3J0IHsgZ2V0QWN0aXZlQXV0b1dvcmtlcnMgfSBmcm9tIFwiLi9kYi9hdXRvLXdvcmtlcnMuanNcIjtcbmltcG9ydCB7IG5vcm1hbGl6ZVJlYWxQYXRoIH0gZnJvbSBcIi4vcGF0aHMuanNcIjtcbmltcG9ydCB7IGVuc3VyZUdpdGlnbm9yZSwgaXNHc2RHaXRpZ25vcmVkIH0gZnJvbSBcIi4vZ2l0aWdub3JlLmpzXCI7XG5pbXBvcnQgeyByZWFkQWxsU2Vzc2lvblN0YXR1c2VzLCBpc1Nlc3Npb25TdGFsZSwgcmVtb3ZlU2Vzc2lvblN0YXR1cyB9IGZyb20gXCIuL3Nlc3Npb24tc3RhdHVzLWlvLmpzXCI7XG5pbXBvcnQgeyByZWNvdmVyRmFpbGVkTWlncmF0aW9uIH0gZnJvbSBcIi4vbWlncmF0ZS1leHRlcm5hbC5qc1wiO1xuaW1wb3J0IHsgc3BsaXRDb21wbGV0ZWRLZXkgfSBmcm9tIFwiLi9mb3JlbnNpY3MuanNcIjtcbmltcG9ydCB7IGZpbmRNaWxlc3RvbmVJZHMgfSBmcm9tIFwiLi9taWxlc3RvbmUtaWRzLmpzXCI7XG5cbmNvbnN0IE1BWF9VQVRfQVRURU1QVFMgPSAzO1xuXG5mdW5jdGlvbiBoYXNBc3Nlc3NtZW50VmVyZGljdChiYXNlUGF0aDogc3RyaW5nLCBtaWQ6IHN0cmluZywgc2lkOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgYXNzZXNzbWVudFBhdGggPSBqb2luKGdzZFJvb3QoYmFzZVBhdGgpLCBcIm1pbGVzdG9uZXNcIiwgbWlkLCBcInNsaWNlc1wiLCBzaWQsIGAke3NpZH0tQVNTRVNTTUVOVC5tZGApO1xuICBpZiAoIWV4aXN0c1N5bmMoYXNzZXNzbWVudFBhdGgpKSByZXR1cm4gZmFsc2U7XG4gIHRyeSB7XG4gICAgcmV0dXJuIC9eXFxzKnZlcmRpY3RcXHMqOlxccyooUEFTU3xGQUlMfFBBUlRJQUwpXFxiL2ltLnRlc3QocmVhZEZpbGVTeW5jKGFzc2Vzc21lbnRQYXRoLCBcInV0Zi04XCIpKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjaGVja1J1bnRpbWVIZWFsdGgoXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIGlzc3VlczogRG9jdG9ySXNzdWVbXSxcbiAgZml4ZXNBcHBsaWVkOiBzdHJpbmdbXSxcbiAgc2hvdWxkRml4OiAoY29kZTogRG9jdG9ySXNzdWVDb2RlKSA9PiBib29sZWFuLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHJvb3QgPSBnc2RSb290KGJhc2VQYXRoKTtcblxuICAvLyBcdTI1MDBcdTI1MDAgU3RhbGUgY3Jhc2ggbG9jayBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgLy8gUGhhc2UgQyBwdCAyOiB0aGUgbG9jayBzdGF0ZSBsaXZlcyBpbiB0aGUgd29ya2VycyArIHVuaXRfZGlzcGF0Y2hlc1xuICAvLyB0YWJsZXMgbm93LCBub3QgYXV0by5sb2NrLiByZWFkQ3Jhc2hMb2NrIHN5bnRoZXNpemVzIGEgTG9ja0RhdGEgZnJvbVxuICAvLyB0aGUgREI7IGlzTG9ja1Byb2Nlc3NBbGl2ZSBpcyBhIHB1cmUgT1MgUElEIGNoZWNrLlxuICB0cnkge1xuICAgIGNvbnN0IGxvY2sgPSByZWFkQ3Jhc2hMb2NrKGJhc2VQYXRoKTtcbiAgICBpZiAobG9jaykge1xuICAgICAgY29uc3QgYWxpdmUgPSBpc0xvY2tQcm9jZXNzQWxpdmUobG9jayk7XG4gICAgICBpZiAoIWFsaXZlKSB7XG4gICAgICAgIGlzc3Vlcy5wdXNoKHtcbiAgICAgICAgICBzZXZlcml0eTogXCJlcnJvclwiLFxuICAgICAgICAgIGNvZGU6IFwic3RhbGVfY3Jhc2hfbG9ja1wiLFxuICAgICAgICAgIHNjb3BlOiBcInByb2plY3RcIixcbiAgICAgICAgICB1bml0SWQ6IFwicHJvamVjdFwiLFxuICAgICAgICAgIG1lc3NhZ2U6IGBTdGFsZSBhdXRvLW1vZGUgd29ya2VyIChQSUQgJHtsb2NrLnBpZH0sIHN0YXJ0ZWQgJHtsb2NrLnN0YXJ0ZWRBdH0sIHdhcyBleGVjdXRpbmcgJHtsb2NrLnVuaXRUeXBlfSAke2xvY2sudW5pdElkfSkgXHUyMDE0IHByb2Nlc3MgaXMgbm8gbG9uZ2VyIHJ1bm5pbmdgLFxuICAgICAgICAgIGZpbGU6IFwiPHdvcmtlcnMgdGFibGU+XCIsXG4gICAgICAgICAgZml4YWJsZTogdHJ1ZSxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgaWYgKHNob3VsZEZpeChcInN0YWxlX2NyYXNoX2xvY2tcIikpIHtcbiAgICAgICAgICBjbGVhclN0YWxlV29ya2VyTG9jayhiYXNlUGF0aCk7XG4gICAgICAgICAgZml4ZXNBcHBsaWVkLnB1c2goXCJjbGVhcmVkIHN0YWxlIGF1dG8tbW9kZSB3b3JrZXIgc3RhdGVcIik7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIE5vbi1mYXRhbCBcdTIwMTQgY3Jhc2ggbG9jayBjaGVjayBmYWlsZWRcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBTdHJhbmRlZCBsb2NrIGRpcmVjdG9yeSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgLy8gcHJvcGVyLWxvY2tmaWxlIGNyZWF0ZXMgYSBgLmdzZC5sb2NrL2AgZGlyZWN0b3J5IGFzIHRoZSBPUy1sZXZlbCBsb2NrXG4gIC8vIG1lY2hhbmlzbS4gSWYgdGhlIHByb2Nlc3Mgd2FzIFNJR0tJTExlZCBvciBjcmFzaGVkIGhhcmQsIHRoaXMgZGlyZWN0b3J5XG4gIC8vIGNhbiByZW1haW4gb24gZGlzayB3aXRob3V0IGFueSBsaXZlIHByb2Nlc3MgaG9sZGluZyBpdC4gVGhlIG5leHQgc2Vzc2lvblxuICAvLyBmYWlscyB0byBhY3F1aXJlIHRoZSBsb2NrIHVudGlsIHRoZSBkaXJlY3RvcnkgaXMgcmVtb3ZlZCAoIzEyNDUpLlxuICB0cnkge1xuICAgIGNvbnN0IGxvY2tEaXIgPSBqb2luKGRpcm5hbWUocm9vdCksIGAke2Jhc2VuYW1lKHJvb3QpfS5sb2NrYCk7XG4gICAgaWYgKGV4aXN0c1N5bmMobG9ja0RpcikpIHtcbiAgICAgIGNvbnN0IHN0YXRSZXMgPSBzdGF0U3luYyhsb2NrRGlyKTtcbiAgICAgIGlmIChzdGF0UmVzLmlzRGlyZWN0b3J5KCkpIHtcbiAgICAgICAgLy8gUGhhc2UgQyBwdCAyOiBcImFueSBsaXZlIHByb2Nlc3MgaG9sZHMgdGhlIGxvY2s/XCIgY2hlY2sgbm93IG1lYW5zXG4gICAgICAgIC8vIFwiaXMgYW55IHdvcmtlciByZWdpc3RlcmVkIHdpdGggc3RhdHVzPSdhY3RpdmUnIEFORCBhIGZyZXNoXG4gICAgICAgIC8vIGhlYXJ0YmVhdCBmb3IgdGhpcyBwcm9qZWN0P1wiIFx1MjAxNCByZWFkQ3Jhc2hMb2NrIHJldHVybnMgbnVsbCBmb3JcbiAgICAgICAgLy8gaGVhbHRoeSBsaXZlIHdvcmtlcnMgKGl0IHN1cmZhY2VzIHN0YWxlIG9uZXMgb25seSksIHNvIHdlIG11c3RcbiAgICAgICAgLy8gY29uc3VsdCBnZXRBY3RpdmVBdXRvV29ya2VycyBkaXJlY3RseS5cbiAgICAgICAgbGV0IGxvY2tIb2xkZXJBbGl2ZSA9IGZhbHNlO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IHByb2plY3RSb290ID0gbm9ybWFsaXplUmVhbFBhdGgoYmFzZVBhdGgpO1xuICAgICAgICAgIGZvciAoY29uc3Qgd29ya2VyIG9mIGdldEFjdGl2ZUF1dG9Xb3JrZXJzKCkpIHtcbiAgICAgICAgICAgIGlmICh3b3JrZXIucHJvamVjdF9yb290X3JlYWxwYXRoICE9PSBwcm9qZWN0Um9vdCkgY29udGludWU7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICBpZiAoaXNMb2NrUHJvY2Vzc0FsaXZlKHtcbiAgICAgICAgICAgICAgICBwaWQ6IHdvcmtlci5waWQsXG4gICAgICAgICAgICAgICAgc3RhcnRlZEF0OiB3b3JrZXIuc3RhcnRlZF9hdCxcbiAgICAgICAgICAgICAgICB1bml0VHlwZTogXCJzdGFydGluZ1wiLFxuICAgICAgICAgICAgICAgIHVuaXRJZDogXCJib290c3RyYXBcIixcbiAgICAgICAgICAgICAgICB1bml0U3RhcnRlZEF0OiB3b3JrZXIuc3RhcnRlZF9hdCxcbiAgICAgICAgICAgICAgfSkpIHtcbiAgICAgICAgICAgICAgICBsb2NrSG9sZGVyQWxpdmUgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgLy8gSWdub3JlIG1hbGZvcm1lZCB3b3JrZXIgcm93cyBvciB0cmFuc2llbnQgUElEIHByb2JlIGZhaWx1cmVzLlxuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgLy8gSWYgd29ya2VyIGxvb2t1cCBmYWlscywgY29udGludWUgd2l0aCB0aGUgc3RyYW5kZWQgbG9jayBkaWFnbm9zaXMuXG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFsb2NrSG9sZGVyQWxpdmUpIHtcbiAgICAgICAgICBpc3N1ZXMucHVzaCh7XG4gICAgICAgICAgICBzZXZlcml0eTogXCJlcnJvclwiLFxuICAgICAgICAgICAgY29kZTogXCJzdHJhbmRlZF9sb2NrX2RpcmVjdG9yeVwiLFxuICAgICAgICAgICAgc2NvcGU6IFwicHJvamVjdFwiLFxuICAgICAgICAgICAgdW5pdElkOiBcInByb2plY3RcIixcbiAgICAgICAgICAgIG1lc3NhZ2U6IGBTdHJhbmRlZCBsb2NrIGRpcmVjdG9yeSBcIiR7bG9ja0Rpcn1cIiBleGlzdHMgYnV0IG5vIGxpdmUgcHJvY2VzcyBob2xkcyB0aGUgc2Vzc2lvbiBsb2NrLiBUaGlzIGJsb2NrcyBuZXcgYXV0by1tb2RlIHNlc3Npb25zIGZyb20gc3RhcnRpbmcuYCxcbiAgICAgICAgICAgIGZpbGU6IGxvY2tEaXIsXG4gICAgICAgICAgICBmaXhhYmxlOiB0cnVlLFxuICAgICAgICAgIH0pO1xuICAgICAgICAgIGlmIChzaG91bGRGaXgoXCJzdHJhbmRlZF9sb2NrX2RpcmVjdG9yeVwiKSkge1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgcm1TeW5jKGxvY2tEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICAgICAgICAgICAgZml4ZXNBcHBsaWVkLnB1c2goYHJlbW92ZWQgc3RyYW5kZWQgbG9jayBkaXJlY3RvcnkgJHtsb2NrRGlyfWApO1xuICAgICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAgIGZpeGVzQXBwbGllZC5wdXNoKGBmYWlsZWQgdG8gcmVtb3ZlIHN0cmFuZGVkIGxvY2sgZGlyZWN0b3J5ICR7bG9ja0Rpcn1gKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIE5vbi1mYXRhbCBcdTIwMTQgc3RyYW5kZWQgbG9jayBkaXJlY3RvcnkgY2hlY2sgZmFpbGVkXG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgU3RhbGUgcGFyYWxsZWwgc2Vzc2lvbnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIHRyeSB7XG4gICAgY29uc3QgcGFyYWxsZWxTdGF0dXNlcyA9IHJlYWRBbGxTZXNzaW9uU3RhdHVzZXMoYmFzZVBhdGgpO1xuICAgIGZvciAoY29uc3Qgc3RhdHVzIG9mIHBhcmFsbGVsU3RhdHVzZXMpIHtcbiAgICAgIGlmIChpc1Nlc3Npb25TdGFsZShzdGF0dXMpKSB7XG4gICAgICAgIGlzc3Vlcy5wdXNoKHtcbiAgICAgICAgICBzZXZlcml0eTogXCJ3YXJuaW5nXCIsXG4gICAgICAgICAgY29kZTogXCJzdGFsZV9wYXJhbGxlbF9zZXNzaW9uXCIsXG4gICAgICAgICAgc2NvcGU6IFwicHJvamVjdFwiLFxuICAgICAgICAgIHVuaXRJZDogc3RhdHVzLm1pbGVzdG9uZUlkLFxuICAgICAgICAgIG1lc3NhZ2U6IGBTdGFsZSBwYXJhbGxlbCBzZXNzaW9uIGZvciAke3N0YXR1cy5taWxlc3RvbmVJZH0gKFBJRCAke3N0YXR1cy5waWR9LCBzdGFydGVkICR7bmV3IERhdGUoc3RhdHVzLnN0YXJ0ZWRBdCkudG9JU09TdHJpbmcoKX0sIGxhc3QgaGVhcnRiZWF0ICR7bmV3IERhdGUoc3RhdHVzLmxhc3RIZWFydGJlYXQpLnRvSVNPU3RyaW5nKCl9KSBcdTIwMTQgcHJvY2VzcyBpcyBubyBsb25nZXIgcnVubmluZ2AsXG4gICAgICAgICAgZmlsZTogYC5nc2QvcGFyYWxsZWwvJHtzdGF0dXMubWlsZXN0b25lSWR9LnN0YXR1cy5qc29uYCxcbiAgICAgICAgICBmaXhhYmxlOiB0cnVlLFxuICAgICAgICB9KTtcblxuICAgICAgICBpZiAoc2hvdWxkRml4KFwic3RhbGVfcGFyYWxsZWxfc2Vzc2lvblwiKSkge1xuICAgICAgICAgIHJlbW92ZVNlc3Npb25TdGF0dXMoYmFzZVBhdGgsIHN0YXR1cy5taWxlc3RvbmVJZCk7XG4gICAgICAgICAgZml4ZXNBcHBsaWVkLnB1c2goYGNsZWFuZWQgdXAgc3RhbGUgcGFyYWxsZWwgc2Vzc2lvbiBmb3IgJHtzdGF0dXMubWlsZXN0b25lSWR9YCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIE5vbi1mYXRhbCBcdTIwMTQgcGFyYWxsZWwgc2Vzc2lvbiBjaGVjayBmYWlsZWRcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBPcnBoYW5lZCBjb21wbGV0ZWQtdW5pdHMga2V5cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgdHJ5IHtcbiAgICBjb25zdCBjb21wbGV0ZWRLZXlzRmlsZSA9IGpvaW4ocm9vdCwgXCJjb21wbGV0ZWQtdW5pdHMuanNvblwiKTtcbiAgICBpZiAoZXhpc3RzU3luYyhjb21wbGV0ZWRLZXlzRmlsZSkpIHtcbiAgICAgIGNvbnN0IHJhdyA9IHJlYWRGaWxlU3luYyhjb21wbGV0ZWRLZXlzRmlsZSwgXCJ1dGYtOFwiKTtcbiAgICAgIGNvbnN0IGtleXM6IHN0cmluZ1tdID0gSlNPTi5wYXJzZShyYXcpO1xuICAgICAgY29uc3Qgb3JwaGFuZWQ6IHN0cmluZ1tdID0gW107XG5cbiAgICAgIGZvciAoY29uc3Qga2V5IG9mIGtleXMpIHtcbiAgICAgICAgY29uc3QgcGFyc2VkID0gc3BsaXRDb21wbGV0ZWRLZXkoa2V5KTtcbiAgICAgICAgaWYgKCFwYXJzZWQpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCB7IHVuaXRUeXBlLCB1bml0SWQgfSA9IHBhcnNlZDtcblxuICAgICAgICAvLyBPbmx5IHZhbGlkYXRlIGFydGlmYWN0LXByb2R1Y2luZyB1bml0IHR5cGVzXG4gICAgICAgIGNvbnN0IHsgdmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdCB9ID0gYXdhaXQgaW1wb3J0KFwiLi9hdXRvLXJlY292ZXJ5LmpzXCIpO1xuICAgICAgICBpZiAoIXZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QodW5pdFR5cGUsIHVuaXRJZCwgYmFzZVBhdGgpKSB7XG4gICAgICAgICAgb3JwaGFuZWQucHVzaChrZXkpO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGlmIChvcnBoYW5lZC5sZW5ndGggPiAwKSB7XG4gICAgICAgIGlzc3Vlcy5wdXNoKHtcbiAgICAgICAgICBzZXZlcml0eTogXCJ3YXJuaW5nXCIsXG4gICAgICAgICAgY29kZTogXCJvcnBoYW5lZF9jb21wbGV0ZWRfdW5pdHNcIixcbiAgICAgICAgICBzY29wZTogXCJwcm9qZWN0XCIsXG4gICAgICAgICAgdW5pdElkOiBcInByb2plY3RcIixcbiAgICAgICAgICBtZXNzYWdlOiBgJHtvcnBoYW5lZC5sZW5ndGh9IGNvbXBsZXRlZC11bml0IGtleShzKSByZWZlcmVuY2UgbWlzc2luZyBhcnRpZmFjdHM6ICR7b3JwaGFuZWQuc2xpY2UoMCwgMykuam9pbihcIiwgXCIpfSR7b3JwaGFuZWQubGVuZ3RoID4gMyA/IFwiLi4uXCIgOiBcIlwifWAsXG4gICAgICAgICAgZmlsZTogXCIuZ3NkL2NvbXBsZXRlZC11bml0cy5qc29uXCIsXG4gICAgICAgICAgZml4YWJsZTogdHJ1ZSxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgaWYgKHNob3VsZEZpeChcIm9ycGhhbmVkX2NvbXBsZXRlZF91bml0c1wiKSkge1xuICAgICAgICAgIGNvbnN0IG9ycGhhbmVkU2V0ID0gbmV3IFNldChvcnBoYW5lZCk7XG4gICAgICAgICAgY29uc3QgcmVtYWluaW5nID0ga2V5cy5maWx0ZXIoKGtleSkgPT4gIW9ycGhhbmVkU2V0LmhhcyhrZXkpKTtcbiAgICAgICAgICBhd2FpdCBzYXZlRmlsZShjb21wbGV0ZWRLZXlzRmlsZSwgSlNPTi5zdHJpbmdpZnkocmVtYWluaW5nKSk7XG4gICAgICAgICAgZml4ZXNBcHBsaWVkLnB1c2goYHJlbW92ZWQgJHtvcnBoYW5lZC5sZW5ndGh9IG9ycGhhbmVkIGNvbXBsZXRlZC11bml0IGtleShzKWApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9IGNhdGNoIHtcbiAgICAvLyBOb24tZmF0YWwgXHUyMDE0IGNvbXBsZXRlZC11bml0cyBjaGVjayBmYWlsZWRcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBTdGFsZSBob29rIHN0YXRlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICB0cnkge1xuICAgIGNvbnN0IGhvb2tTdGF0ZUZpbGUgPSBqb2luKHJvb3QsIFwiaG9vay1zdGF0ZS5qc29uXCIpO1xuICAgIGlmIChleGlzdHNTeW5jKGhvb2tTdGF0ZUZpbGUpKSB7XG4gICAgICBjb25zdCByYXcgPSByZWFkRmlsZVN5bmMoaG9va1N0YXRlRmlsZSwgXCJ1dGYtOFwiKTtcbiAgICAgIGNvbnN0IHN0YXRlID0gSlNPTi5wYXJzZShyYXcpO1xuICAgICAgY29uc3QgaGFzQ3ljbGVDb3VudHMgPSBzdGF0ZS5jeWNsZUNvdW50cyAmJiB0eXBlb2Ygc3RhdGUuY3ljbGVDb3VudHMgPT09IFwib2JqZWN0XCJcbiAgICAgICAgJiYgT2JqZWN0LmtleXMoc3RhdGUuY3ljbGVDb3VudHMpLmxlbmd0aCA+IDA7XG5cbiAgICAgIC8vIE9ubHkgZmxhZyBpZiB0aGVyZSBhcmUgYWN0dWFsIGN5Y2xlIGNvdW50cyBBTkQgbm8gYXV0by1tb2RlIGlzIHJ1bm5pbmdcbiAgICAgIGlmIChoYXNDeWNsZUNvdW50cykge1xuICAgICAgICBjb25zdCBsb2NrID0gcmVhZENyYXNoTG9jayhiYXNlUGF0aCk7XG4gICAgICAgIGNvbnN0IGF1dG9SdW5uaW5nID0gbG9jayA/IGlzTG9ja1Byb2Nlc3NBbGl2ZShsb2NrKSA6IGZhbHNlO1xuXG4gICAgICAgIGlmICghYXV0b1J1bm5pbmcpIHtcbiAgICAgICAgICBpc3N1ZXMucHVzaCh7XG4gICAgICAgICAgICBzZXZlcml0eTogXCJpbmZvXCIsXG4gICAgICAgICAgICBjb2RlOiBcInN0YWxlX2hvb2tfc3RhdGVcIixcbiAgICAgICAgICAgIHNjb3BlOiBcInByb2plY3RcIixcbiAgICAgICAgICAgIHVuaXRJZDogXCJwcm9qZWN0XCIsXG4gICAgICAgICAgICBtZXNzYWdlOiBgaG9vay1zdGF0ZS5qc29uIGhhcyAke09iamVjdC5rZXlzKHN0YXRlLmN5Y2xlQ291bnRzKS5sZW5ndGh9IHJlc2lkdWFsIGN5Y2xlIGNvdW50KHMpIGZyb20gYSBwcmV2aW91cyBzZXNzaW9uYCxcbiAgICAgICAgICAgIGZpbGU6IFwiLmdzZC9ob29rLXN0YXRlLmpzb25cIixcbiAgICAgICAgICAgIGZpeGFibGU6IHRydWUsXG4gICAgICAgICAgfSk7XG5cbiAgICAgICAgICBpZiAoc2hvdWxkRml4KFwic3RhbGVfaG9va19zdGF0ZVwiKSkge1xuICAgICAgICAgICAgY29uc3QgeyBjbGVhclBlcnNpc3RlZEhvb2tTdGF0ZSB9ID0gYXdhaXQgaW1wb3J0KFwiLi9wb3N0LXVuaXQtaG9va3MuanNcIik7XG4gICAgICAgICAgICBjbGVhclBlcnNpc3RlZEhvb2tTdGF0ZShiYXNlUGF0aCk7XG4gICAgICAgICAgICBmaXhlc0FwcGxpZWQucHVzaChcImNsZWFyZWQgc3RhbGUgaG9vay1zdGF0ZS5qc29uXCIpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gTm9uLWZhdGFsIFx1MjAxNCBob29rIHN0YXRlIGNoZWNrIGZhaWxlZFxuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwIEV4aGF1c3RlZCBydW4tdWF0IHJldHJ5IGNvdW50ZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICB0cnkge1xuICAgIGNvbnN0IHJ1bnRpbWVEaXIgPSBqb2luKHJvb3QsIFwicnVudGltZVwiKTtcbiAgICBpZiAoZXhpc3RzU3luYyhydW50aW1lRGlyKSkge1xuICAgICAgY29uc3QgdWF0Q291bnRlclBhdHRlcm4gPSAvXnVhdC1jb3VudC0oTVxcZCspLShTXFxkKylcXC5qc29uJC87XG4gICAgICBmb3IgKGNvbnN0IGZpbGVOYW1lIG9mIHJlYWRkaXJTeW5jKHJ1bnRpbWVEaXIpKSB7XG4gICAgICAgIGNvbnN0IG1hdGNoID0gZmlsZU5hbWUubWF0Y2godWF0Q291bnRlclBhdHRlcm4pO1xuICAgICAgICBpZiAoIW1hdGNoKSBjb250aW51ZTtcbiAgICAgICAgY29uc3QgWywgbWlkLCBzaWRdID0gbWF0Y2g7XG4gICAgICAgIGlmICghbWlkIHx8ICFzaWQgfHwgaGFzQXNzZXNzbWVudFZlcmRpY3QoYmFzZVBhdGgsIG1pZCwgc2lkKSkgY29udGludWU7XG5cbiAgICAgICAgY29uc3QgZmlsZVBhdGggPSBqb2luKHJ1bnRpbWVEaXIsIGZpbGVOYW1lKTtcbiAgICAgICAgbGV0IGNvdW50ID0gMDtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhmaWxlUGF0aCwgXCJ1dGYtOFwiKSk7XG4gICAgICAgICAgY291bnQgPSB0eXBlb2YgcGFyc2VkLmNvdW50ID09PSBcIm51bWJlclwiID8gcGFyc2VkLmNvdW50IDogMDtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgY291bnQgPSBNQVhfVUFUX0FUVEVNUFRTICsgMTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoY291bnQgPD0gTUFYX1VBVF9BVFRFTVBUUykgY29udGludWU7XG5cbiAgICAgICAgaXNzdWVzLnB1c2goe1xuICAgICAgICAgIHNldmVyaXR5OiBcIndhcm5pbmdcIixcbiAgICAgICAgICBjb2RlOiBcInVhdF9yZXRyeV9leGhhdXN0ZWRcIixcbiAgICAgICAgICBzY29wZTogXCJzbGljZVwiLFxuICAgICAgICAgIHVuaXRJZDogYCR7bWlkfS8ke3NpZH1gLFxuICAgICAgICAgIG1lc3NhZ2U6IGBydW4tdWF0IGZvciAke21pZH0vJHtzaWR9IGV4aGF1c3RlZCAke2NvdW50IC0gMX0gcmV0cnkgYXR0ZW1wdChzKSB3aXRob3V0IGFuIEFTU0VTU01FTlQgdmVyZGljdC4gUmVzZXQgdGhlIHJldHJ5IGNvdW50ZXIgYWZ0ZXIgZml4aW5nIHRoZSB1bmRlcmx5aW5nIFVBVC90b29sIGlzc3VlLCB0aGVuIHJlcnVuIC9nc2QgYXV0by5gLFxuICAgICAgICAgIGZpbGU6IGAuZ3NkL3J1bnRpbWUvJHtmaWxlTmFtZX1gLFxuICAgICAgICAgIGZpeGFibGU6IHRydWUsXG4gICAgICAgIH0pO1xuXG4gICAgICAgIGlmIChzaG91bGRGaXgoXCJ1YXRfcmV0cnlfZXhoYXVzdGVkXCIpKSB7XG4gICAgICAgICAgcm1TeW5jKGZpbGVQYXRoLCB7IGZvcmNlOiB0cnVlIH0pO1xuICAgICAgICAgIGZpeGVzQXBwbGllZC5wdXNoKGByZXNldCBleGhhdXN0ZWQgcnVuLXVhdCByZXRyeSBjb3VudGVyIGZvciAke21pZH0vJHtzaWR9YCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIE5vbi1mYXRhbCBcdTIwMTQgVUFUIHJldHJ5IGNvdW50ZXIgY2hlY2sgZmFpbGVkXG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgQWN0aXZpdHkgbG9nIGJsb2F0IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICB0cnkge1xuICAgIGNvbnN0IGFjdGl2aXR5RGlyID0gam9pbihyb290LCBcImFjdGl2aXR5XCIpO1xuICAgIGlmIChleGlzdHNTeW5jKGFjdGl2aXR5RGlyKSkge1xuICAgICAgY29uc3QgZmlsZXMgPSByZWFkZGlyU3luYyhhY3Rpdml0eURpcik7XG4gICAgICBsZXQgdG90YWxTaXplID0gMDtcbiAgICAgIGZvciAoY29uc3QgZiBvZiBmaWxlcykge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHRvdGFsU2l6ZSArPSBzdGF0U3luYyhqb2luKGFjdGl2aXR5RGlyLCBmKSkuc2l6ZTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgLy8gc3RhdCBmYWlsZWQgXHUyMDE0IHNraXBcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBjb25zdCB0b3RhbE1CID0gdG90YWxTaXplIC8gKDEwMjQgKiAxMDI0KTtcbiAgICAgIGNvbnN0IEJMT0FUX0ZJTEVfVEhSRVNIT0xEID0gNTAwO1xuICAgICAgY29uc3QgQkxPQVRfU0laRV9NQiA9IDEwMDtcblxuICAgICAgaWYgKGZpbGVzLmxlbmd0aCA+IEJMT0FUX0ZJTEVfVEhSRVNIT0xEIHx8IHRvdGFsTUIgPiBCTE9BVF9TSVpFX01CKSB7XG4gICAgICAgIGlzc3Vlcy5wdXNoKHtcbiAgICAgICAgICBzZXZlcml0eTogXCJ3YXJuaW5nXCIsXG4gICAgICAgICAgY29kZTogXCJhY3Rpdml0eV9sb2dfYmxvYXRcIixcbiAgICAgICAgICBzY29wZTogXCJwcm9qZWN0XCIsXG4gICAgICAgICAgdW5pdElkOiBcInByb2plY3RcIixcbiAgICAgICAgICBtZXNzYWdlOiBgQWN0aXZpdHkgbG9nczogJHtmaWxlcy5sZW5ndGh9IGZpbGVzLCAke3RvdGFsTUIudG9GaXhlZCgxKX1NQiAodGhyZXNob2xkczogJHtCTE9BVF9GSUxFX1RIUkVTSE9MRH0gZmlsZXMgLyAke0JMT0FUX1NJWkVfTUJ9TUIpYCxcbiAgICAgICAgICBmaWxlOiBcIi5nc2QvYWN0aXZpdHkvXCIsXG4gICAgICAgICAgZml4YWJsZTogdHJ1ZSxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgaWYgKHNob3VsZEZpeChcImFjdGl2aXR5X2xvZ19ibG9hdFwiKSkge1xuICAgICAgICAgIGNvbnN0IHsgcHJ1bmVBY3Rpdml0eUxvZ3MgfSA9IGF3YWl0IGltcG9ydChcIi4vYWN0aXZpdHktbG9nLmpzXCIpO1xuICAgICAgICAgIHBydW5lQWN0aXZpdHlMb2dzKGFjdGl2aXR5RGlyLCA3KTsgLy8gNy1kYXkgcmV0ZW50aW9uXG4gICAgICAgICAgZml4ZXNBcHBsaWVkLnB1c2goXCJwcnVuZWQgYWN0aXZpdHkgbG9ncyAoNy1kYXkgcmV0ZW50aW9uKVwiKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gTm9uLWZhdGFsIFx1MjAxNCBhY3Rpdml0eSBsb2cgY2hlY2sgZmFpbGVkXG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgU1RBVEUubWQgaGVhbHRoIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICB0cnkge1xuICAgIGNvbnN0IHN0YXRlRmlsZVBhdGggPSByZXNvbHZlR3NkUm9vdEZpbGUoYmFzZVBhdGgsIFwiU1RBVEVcIik7XG4gICAgY29uc3QgbWlsZXN0b25lc1BhdGggPSBtaWxlc3RvbmVzRGlyKGJhc2VQYXRoKTtcblxuICAgIGlmIChleGlzdHNTeW5jKG1pbGVzdG9uZXNQYXRoKSkge1xuICAgICAgaWYgKCFleGlzdHNTeW5jKHN0YXRlRmlsZVBhdGgpKSB7XG4gICAgICAgIGlzc3Vlcy5wdXNoKHtcbiAgICAgICAgICBzZXZlcml0eTogXCJ3YXJuaW5nXCIsXG4gICAgICAgICAgY29kZTogXCJzdGF0ZV9maWxlX21pc3NpbmdcIixcbiAgICAgICAgICBzY29wZTogXCJwcm9qZWN0XCIsXG4gICAgICAgICAgdW5pdElkOiBcInByb2plY3RcIixcbiAgICAgICAgICBtZXNzYWdlOiBcIlNUQVRFLm1kIGlzIG1pc3NpbmcgXHUyMDE0IHN0YXRlIGRpc3BsYXkgd2lsbCBub3Qgd29ya1wiLFxuICAgICAgICAgIGZpbGU6IFwiLmdzZC9TVEFURS5tZFwiLFxuICAgICAgICAgIGZpeGFibGU6IHRydWUsXG4gICAgICAgIH0pO1xuXG4gICAgICAgIGlmIChzaG91bGRGaXgoXCJzdGF0ZV9maWxlX21pc3NpbmdcIikpIHtcbiAgICAgICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2VQYXRoKTtcbiAgICAgICAgICBhd2FpdCBzYXZlRmlsZShzdGF0ZUZpbGVQYXRoLCBidWlsZFN0YXRlTWFya2Rvd25Gb3JDaGVjayhzdGF0ZSkpO1xuICAgICAgICAgIGZpeGVzQXBwbGllZC5wdXNoKFwiY3JlYXRlZCBTVEFURS5tZCBmcm9tIGRlcml2ZWQgc3RhdGVcIik7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIENoZWNrIGlmIFNUQVRFLm1kIGlzIHN0YWxlIGJ5IGNvbXBhcmluZyBhY3RpdmUgbWlsZXN0b25lL3NsaWNlL3BoYXNlXG4gICAgICAgIGNvbnN0IGN1cnJlbnRDb250ZW50ID0gcmVhZEZpbGVTeW5jKHN0YXRlRmlsZVBhdGgsIFwidXRmLThcIik7XG4gICAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZVBhdGgpO1xuICAgICAgICBjb25zdCBmcmVzaENvbnRlbnQgPSBidWlsZFN0YXRlTWFya2Rvd25Gb3JDaGVjayhzdGF0ZSk7XG5cbiAgICAgICAgLy8gRXh0cmFjdCBrZXkgZmllbGRzIGZvciBjb21wYXJpc29uIFx1MjAxNCBkb24ndCBjb21wYXJlIGZ1bGwgY29udGVudFxuICAgICAgICAvLyBzaW5jZSB0aW1lc3RhbXAvZm9ybWF0dGluZyBkaWZmZXJlbmNlcyBhcmUgbm9ybWFsXG4gICAgICAgIGNvbnN0IGV4dHJhY3RGaWVsZHMgPSAoY29udGVudDogc3RyaW5nKSA9PiB7XG4gICAgICAgICAgY29uc3QgbWlsZXN0b25lID0gY29udGVudC5tYXRjaCgvXFwqXFwqQWN0aXZlIE1pbGVzdG9uZTpcXCpcXCpcXHMqKC4rKS8pPy5bMV0/LnRyaW0oKSA/PyBcIlwiO1xuICAgICAgICAgIGNvbnN0IHNsaWNlID0gY29udGVudC5tYXRjaCgvXFwqXFwqQWN0aXZlIFNsaWNlOlxcKlxcKlxccyooLispLyk/LlsxXT8udHJpbSgpID8/IFwiXCI7XG4gICAgICAgICAgY29uc3QgcGhhc2UgPSBjb250ZW50Lm1hdGNoKC9cXCpcXCpQaGFzZTpcXCpcXCpcXHMqKC4rKS8pPy5bMV0/LnRyaW0oKSA/PyBcIlwiO1xuICAgICAgICAgIHJldHVybiB7IG1pbGVzdG9uZSwgc2xpY2UsIHBoYXNlIH07XG4gICAgICAgIH07XG5cbiAgICAgICAgY29uc3QgY3VycmVudCA9IGV4dHJhY3RGaWVsZHMoY3VycmVudENvbnRlbnQpO1xuICAgICAgICBjb25zdCBmcmVzaCA9IGV4dHJhY3RGaWVsZHMoZnJlc2hDb250ZW50KTtcblxuICAgICAgICBpZiAoY3VycmVudC5taWxlc3RvbmUgIT09IGZyZXNoLm1pbGVzdG9uZSB8fCBjdXJyZW50LnNsaWNlICE9PSBmcmVzaC5zbGljZSB8fCBjdXJyZW50LnBoYXNlICE9PSBmcmVzaC5waGFzZSkge1xuICAgICAgICAgIGlzc3Vlcy5wdXNoKHtcbiAgICAgICAgICAgIHNldmVyaXR5OiBcIndhcm5pbmdcIixcbiAgICAgICAgICAgIGNvZGU6IFwic3RhdGVfZmlsZV9zdGFsZVwiLFxuICAgICAgICAgICAgc2NvcGU6IFwicHJvamVjdFwiLFxuICAgICAgICAgICAgdW5pdElkOiBcInByb2plY3RcIixcbiAgICAgICAgICAgIG1lc3NhZ2U6IGBTVEFURS5tZCBpcyBzdGFsZSBcdTIwMTQgc2hvd3MgXCIke2N1cnJlbnQucGhhc2V9XCIgYnV0IGRlcml2ZWQgc3RhdGUgaXMgXCIke2ZyZXNoLnBoYXNlfVwiYCxcbiAgICAgICAgICAgIGZpbGU6IFwiLmdzZC9TVEFURS5tZFwiLFxuICAgICAgICAgICAgZml4YWJsZTogdHJ1ZSxcbiAgICAgICAgICB9KTtcblxuICAgICAgICAgIGlmIChzaG91bGRGaXgoXCJzdGF0ZV9maWxlX3N0YWxlXCIpKSB7XG4gICAgICAgICAgICBhd2FpdCBzYXZlRmlsZShzdGF0ZUZpbGVQYXRoLCBmcmVzaENvbnRlbnQpO1xuICAgICAgICAgICAgZml4ZXNBcHBsaWVkLnB1c2goXCJyZWJ1aWx0IFNUQVRFLm1kIGZyb20gZGVyaXZlZCBzdGF0ZVwiKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIE5vbi1mYXRhbCBcdTIwMTQgU1RBVEUubWQgY2hlY2sgZmFpbGVkXG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgR2l0aWdub3JlIGRyaWZ0IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICB0cnkge1xuICAgIGNvbnN0IGdpdGlnbm9yZVBhdGggPSBqb2luKGJhc2VQYXRoLCBcIi5naXRpZ25vcmVcIik7XG4gICAgaWYgKGV4aXN0c1N5bmMoZ2l0aWdub3JlUGF0aCkgJiYgbmF0aXZlSXNSZXBvKGJhc2VQYXRoKSkge1xuICAgICAgY29uc3QgY29udGVudCA9IHJlYWRGaWxlU3luYyhnaXRpZ25vcmVQYXRoLCBcInV0Zi04XCIpO1xuICAgICAgY29uc3QgZXhpc3RpbmdMaW5lcyA9IG5ldyBTZXQoXG4gICAgICAgIGNvbnRlbnQuc3BsaXQoXCJcXG5cIikubWFwKGwgPT4gbC50cmltKCkpLmZpbHRlcihsID0+IGwgJiYgIWwuc3RhcnRzV2l0aChcIiNcIikpLFxuICAgICAgKTtcblxuICAgICAgLy8gQ2hlY2sgZm9yIGNyaXRpY2FsIHJ1bnRpbWUgcGF0dGVybnMgdGhhdCBtdXN0IGJlIHByZXNlbnQuXG4gICAgICAvLyBOT1RFOiBHU0RfUlVOVElNRV9QQVRURVJOUyBpbiBnaXRpZ25vcmUudHMgaXMgdGhlIGNhbm9uaWNhbCBzb3VyY2Ugb2YgdHJ1dGguXG4gICAgICAvLyBUaGlzIGlzIGEgbWluaW1hbCBzdWJzZXQgZm9yIHRoZSBkb2N0b3IgY2hlY2suXG4gICAgICBjb25zdCBjcml0aWNhbFBhdHRlcm5zID0gW1xuICAgICAgICBcIi5nc2QvYWN0aXZpdHkvXCIsXG4gICAgICAgIFwiLmdzZC9ydW50aW1lL1wiLFxuICAgICAgICBcIi5nc2QvYXV0by5sb2NrXCIsXG4gICAgICAgIFwiLmdzZC9nc2QuZGIqXCIsXG4gICAgICAgIFwiLmdzZC9jb21wbGV0ZWQtdW5pdHMqLmpzb25cIixcbiAgICAgICAgXCIuZ3NkL2V2ZW50LWxvZy5qc29ubFwiLFxuICAgICAgXTtcblxuICAgICAgLy8gSWYgYmxhbmtldCAuZ3NkLyBvciAuZ3NkIGlzIHByZXNlbnQsIGFsbCBwYXR0ZXJucyBhcmUgY292ZXJlZFxuICAgICAgY29uc3QgaGFzQmxhbmtldElnbm9yZSA9IGV4aXN0aW5nTGluZXMuaGFzKFwiLmdzZC9cIikgfHwgZXhpc3RpbmdMaW5lcy5oYXMoXCIuZ3NkXCIpO1xuXG4gICAgICBpZiAoIWhhc0JsYW5rZXRJZ25vcmUpIHtcbiAgICAgICAgY29uc3QgbWlzc2luZyA9IGNyaXRpY2FsUGF0dGVybnMuZmlsdGVyKHAgPT4gIWV4aXN0aW5nTGluZXMuaGFzKHApKTtcbiAgICAgICAgaWYgKG1pc3NpbmcubGVuZ3RoID4gMCkge1xuICAgICAgICAgIGlzc3Vlcy5wdXNoKHtcbiAgICAgICAgICAgIHNldmVyaXR5OiBcIndhcm5pbmdcIixcbiAgICAgICAgICAgIGNvZGU6IFwiZ2l0aWdub3JlX21pc3NpbmdfcGF0dGVybnNcIixcbiAgICAgICAgICAgIHNjb3BlOiBcInByb2plY3RcIixcbiAgICAgICAgICAgIHVuaXRJZDogXCJwcm9qZWN0XCIsXG4gICAgICAgICAgICBtZXNzYWdlOiBgJHttaXNzaW5nLmxlbmd0aH0gY3JpdGljYWwgR1NEIHJ1bnRpbWUgcGF0dGVybihzKSBtaXNzaW5nIGZyb20gLmdpdGlnbm9yZTogJHttaXNzaW5nLmpvaW4oXCIsIFwiKX1gLFxuICAgICAgICAgICAgZmlsZTogXCIuZ2l0aWdub3JlXCIsXG4gICAgICAgICAgICBmaXhhYmxlOiB0cnVlLFxuICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgaWYgKHNob3VsZEZpeChcImdpdGlnbm9yZV9taXNzaW5nX3BhdHRlcm5zXCIpKSB7XG4gICAgICAgICAgICBlbnN1cmVHaXRpZ25vcmUoYmFzZVBhdGgpO1xuICAgICAgICAgICAgZml4ZXNBcHBsaWVkLnB1c2goXCJhZGRlZCBtaXNzaW5nIEdTRCBydW50aW1lIHBhdHRlcm5zIHRvIC5naXRpZ25vcmVcIik7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9IGNhdGNoIHtcbiAgICAvLyBOb24tZmF0YWwgXHUyMDE0IGdpdGlnbm9yZSBjaGVjayBmYWlsZWRcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBFeHRlcm5hbCBzdGF0ZSBzeW1saW5rIGhlYWx0aCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgdHJ5IHtcbiAgICBjb25zdCBsb2NhbEdzZCA9IGpvaW4oYmFzZVBhdGgsIFwiLmdzZFwiKTtcbiAgICBpZiAoZXhpc3RzU3luYyhsb2NhbEdzZCkpIHtcbiAgICAgIGNvbnN0IHN0YXQgPSBsc3RhdFN5bmMobG9jYWxHc2QpO1xuXG4gICAgICAvLyBDaGVjayBmb3IgLmdzZC5taWdyYXRpbmcgKGZhaWxlZCBtaWdyYXRpb24pXG4gICAgICBjb25zdCBtaWdyYXRpbmdQYXRoID0gam9pbihiYXNlUGF0aCwgXCIuZ3NkLm1pZ3JhdGluZ1wiKTtcbiAgICAgIGlmIChleGlzdHNTeW5jKG1pZ3JhdGluZ1BhdGgpKSB7XG4gICAgICAgIGlzc3Vlcy5wdXNoKHtcbiAgICAgICAgICBzZXZlcml0eTogXCJlcnJvclwiLFxuICAgICAgICAgIGNvZGU6IFwiZmFpbGVkX21pZ3JhdGlvblwiLFxuICAgICAgICAgIHNjb3BlOiBcInByb2plY3RcIixcbiAgICAgICAgICB1bml0SWQ6IFwicHJvamVjdFwiLFxuICAgICAgICAgIG1lc3NhZ2U6IFwiRm91bmQgLmdzZC5taWdyYXRpbmcgXHUyMDE0IGEgcHJldmlvdXMgZXh0ZXJuYWwgc3RhdGUgbWlncmF0aW9uIGZhaWxlZC4gU3RhdGUgbWF5IGJlIGluY29tcGxldGUuXCIsXG4gICAgICAgICAgZmlsZTogXCIuZ3NkLm1pZ3JhdGluZ1wiLFxuICAgICAgICAgIGZpeGFibGU6IHRydWUsXG4gICAgICAgIH0pO1xuXG4gICAgICAgIGlmIChzaG91bGRGaXgoXCJmYWlsZWRfbWlncmF0aW9uXCIpKSB7XG4gICAgICAgICAgaWYgKHJlY292ZXJGYWlsZWRNaWdyYXRpb24oYmFzZVBhdGgpKSB7XG4gICAgICAgICAgICBmaXhlc0FwcGxpZWQucHVzaChcInJlY292ZXJlZCBmYWlsZWQgbWlncmF0aW9uICguZ3NkLm1pZ3JhdGluZyBcdTIxOTIgLmdzZClcIik7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIENoZWNrIHN5bWxpbmsgdGFyZ2V0IGV4aXN0c1xuICAgICAgaWYgKHN0YXQuaXNTeW1ib2xpY0xpbmsoKSkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHJlYWxwYXRoU3luYyhsb2NhbEdzZCk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIGlzc3Vlcy5wdXNoKHtcbiAgICAgICAgICAgIHNldmVyaXR5OiBcImVycm9yXCIsXG4gICAgICAgICAgICBjb2RlOiBcImJyb2tlbl9zeW1saW5rXCIsXG4gICAgICAgICAgICBzY29wZTogXCJwcm9qZWN0XCIsXG4gICAgICAgICAgICB1bml0SWQ6IFwicHJvamVjdFwiLFxuICAgICAgICAgICAgbWVzc2FnZTogXCIuZ3NkIHN5bWxpbmsgdGFyZ2V0IGRvZXMgbm90IGV4aXN0LiBFeHRlcm5hbCBzdGF0ZSBkaXJlY3RvcnkgbWF5IGhhdmUgYmVlbiBkZWxldGVkLlwiLFxuICAgICAgICAgICAgZmlsZTogXCIuZ3NkXCIsXG4gICAgICAgICAgICBmaXhhYmxlOiBmYWxzZSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIFx1MjUwMFx1MjUwMCBTeW1saW5rZWQgLmdzZCB3aXRob3V0IC5naXRpZ25vcmUgZW50cnkgKCM0NDIzKSBcdTI1MDBcdTI1MDBcbiAgICAgICAgLy8gV2hlbiBgLmdzZGAgaXMgYSBzeW1saW5rIEFORCBub3QgZ2l0aWdub3JlZCwgYGdpdCBhZGQgLUEgLS0gOiEuZ3NkLy4uLmBcbiAgICAgICAgLy8gcGF0aHNwZWNzIGZhaWwgd2l0aCBcImJleW9uZCBhIHN5bWJvbGljIGxpbmtcIi4gV2l0aG91dCBzZWxmLWhlYWwgdGhpc1xuICAgICAgICAvLyBzaWxlbnRseSBkcm9wcyBuZXcgdXNlciBmaWxlcyBkdXJpbmcgYXV0by1jb21taXQuXG4gICAgICAgIGlmIChuYXRpdmVJc1JlcG8oYmFzZVBhdGgpICYmICFpc0dzZEdpdGlnbm9yZWQoYmFzZVBhdGgpKSB7XG4gICAgICAgICAgaXNzdWVzLnB1c2goe1xuICAgICAgICAgICAgc2V2ZXJpdHk6IFwid2FybmluZ1wiLFxuICAgICAgICAgICAgY29kZTogXCJzeW1saW5rZWRfZ3NkX3VuaWdub3JlZFwiLFxuICAgICAgICAgICAgc2NvcGU6IFwicHJvamVjdFwiLFxuICAgICAgICAgICAgdW5pdElkOiBcInByb2plY3RcIixcbiAgICAgICAgICAgIG1lc3NhZ2U6IFwiLmdzZCBpcyBhIHN5bWxpbmsgdG8gZXh0ZXJuYWwgc3RhdGUgYnV0IGlzIG5vdCBsaXN0ZWQgaW4gLmdpdGlnbm9yZS4gVGhpcyBjYXVzZXMgZ2l0IHBhdGhzcGVjIGV4Y2x1c2lvbnMgdG8gZmFpbCBhbmQgY2FuIGxlYWQgdG8gc2lsZW50bHkgZHJvcHBlZCBuZXcgZmlsZXMgZHVyaW5nIGF1dG8tY29tbWl0LiBBZGQgYC5nc2RgIHRvIC5naXRpZ25vcmUuXCIsXG4gICAgICAgICAgICBmaWxlOiBcIi5naXRpZ25vcmVcIixcbiAgICAgICAgICAgIGZpeGFibGU6IHRydWUsXG4gICAgICAgICAgfSk7XG5cbiAgICAgICAgICBpZiAoc2hvdWxkRml4KFwic3ltbGlua2VkX2dzZF91bmlnbm9yZWRcIikpIHtcbiAgICAgICAgICAgIGNvbnN0IG1vZGlmaWVkID0gZW5zdXJlR2l0aWdub3JlKGJhc2VQYXRoKTtcbiAgICAgICAgICAgIGlmIChtb2RpZmllZCkgZml4ZXNBcHBsaWVkLnB1c2goXCJhZGRlZCAuZ3NkIHRvIC5naXRpZ25vcmUgKHN5bWxpbmtlZCBleHRlcm5hbCBzdGF0ZSlcIik7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9IGNhdGNoIHtcbiAgICAvLyBOb24tZmF0YWwgXHUyMDE0IGV4dGVybmFsIHN0YXRlIGNoZWNrIGZhaWxlZFxuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwIE51bWJlcmVkIC5nc2QgY29sbGlzaW9uIHZhcmlhbnRzICgjMjIwNSkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIC8vIG1hY09TIEFQRlMgY2FuIGNyZWF0ZSBcIi5nc2QgMlwiLCBcIi5nc2QgM1wiIGV0Yy4gd2hlbiBhIGRpcmVjdG9yeSBibG9ja3NcbiAgLy8gc3ltbGluayBjcmVhdGlvbi4gVGhlc2UgbXVzdCBiZSByZW1vdmVkIHNvIHRoZSBjYW5vbmljYWwgLmdzZCBpcyB1c2VkLlxuICB0cnkge1xuICAgIGNvbnN0IHZhcmlhbnRQYXR0ZXJuID0gL15cXC5nc2QgXFxkKyQvO1xuICAgIGNvbnN0IGVudHJpZXMgPSByZWFkZGlyU3luYyhiYXNlUGF0aCk7XG4gICAgY29uc3QgdmFyaWFudHMgPSBlbnRyaWVzLmZpbHRlcihlID0+IHZhcmlhbnRQYXR0ZXJuLnRlc3QoZSkpO1xuICAgIGlmICh2YXJpYW50cy5sZW5ndGggPiAwKSB7XG4gICAgICBmb3IgKGNvbnN0IHYgb2YgdmFyaWFudHMpIHtcbiAgICAgICAgaXNzdWVzLnB1c2goe1xuICAgICAgICAgIHNldmVyaXR5OiBcIndhcm5pbmdcIixcbiAgICAgICAgICBjb2RlOiBcIm51bWJlcmVkX2dzZF92YXJpYW50XCIsXG4gICAgICAgICAgc2NvcGU6IFwicHJvamVjdFwiLFxuICAgICAgICAgIHVuaXRJZDogXCJwcm9qZWN0XCIsXG4gICAgICAgICAgbWVzc2FnZTogYEZvdW5kIG1hY09TIGNvbGxpc2lvbiB2YXJpYW50IFwiJHt2fVwiIFx1MjAxNCB0aGlzIGNhbiBjYXVzZSBHU0Qgc3RhdGUgdG8gYXBwZWFyIGRlbGV0ZWQuYCxcbiAgICAgICAgICBmaWxlOiB2LFxuICAgICAgICAgIGZpeGFibGU6IHRydWUsXG4gICAgICAgIH0pO1xuICAgICAgfVxuXG4gICAgICBpZiAoc2hvdWxkRml4KFwibnVtYmVyZWRfZ3NkX3ZhcmlhbnRcIikpIHtcbiAgICAgICAgY29uc3QgcmVtb3ZlZCA9IGNsZWFuTnVtYmVyZWRHc2RWYXJpYW50cyhiYXNlUGF0aCk7XG4gICAgICAgIGZvciAoY29uc3QgbmFtZSBvZiByZW1vdmVkKSB7XG4gICAgICAgICAgZml4ZXNBcHBsaWVkLnB1c2goYHJlbW92ZWQgbnVtYmVyZWQgLmdzZCB2YXJpYW50OiAke25hbWV9YCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIE5vbi1mYXRhbCBcdTIwMTQgdmFyaWFudCBjaGVjayBmYWlsZWRcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBNZXRyaWNzIGxlZGdlciBpbnRlZ3JpdHkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIHRyeSB7XG4gICAgY29uc3QgbWV0cmljc1BhdGggPSBqb2luKHJvb3QsIFwibWV0cmljcy5qc29uXCIpO1xuICAgIGlmIChleGlzdHNTeW5jKG1ldHJpY3NQYXRoKSkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKG1ldHJpY3NQYXRoLCBcInV0Zi04XCIpO1xuICAgICAgICBjb25zdCBsZWRnZXIgPSBKU09OLnBhcnNlKHJhdyk7XG4gICAgICAgIGlmIChsZWRnZXIudmVyc2lvbiAhPT0gMSB8fCAhQXJyYXkuaXNBcnJheShsZWRnZXIudW5pdHMpKSB7XG4gICAgICAgICAgaXNzdWVzLnB1c2goe1xuICAgICAgICAgICAgc2V2ZXJpdHk6IFwid2FybmluZ1wiLFxuICAgICAgICAgICAgY29kZTogXCJtZXRyaWNzX2xlZGdlcl9jb3JydXB0XCIsXG4gICAgICAgICAgICBzY29wZTogXCJwcm9qZWN0XCIsXG4gICAgICAgICAgICB1bml0SWQ6IFwicHJvamVjdFwiLFxuICAgICAgICAgICAgbWVzc2FnZTogXCJtZXRyaWNzLmpzb24gaGFzIGFuIHVuZXhwZWN0ZWQgc3RydWN0dXJlICh2ZXJzaW9uICE9PSAxIG9yIHVuaXRzIGlzIG5vdCBhbiBhcnJheSkgXHUyMDE0IG1ldHJpY3MgZGF0YSBtYXkgYmUgdW5yZWxpYWJsZVwiLFxuICAgICAgICAgICAgZmlsZTogXCIuZ3NkL21ldHJpY3MuanNvblwiLFxuICAgICAgICAgICAgZml4YWJsZTogZmFsc2UsXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICBpc3N1ZXMucHVzaCh7XG4gICAgICAgICAgc2V2ZXJpdHk6IFwid2FybmluZ1wiLFxuICAgICAgICAgIGNvZGU6IFwibWV0cmljc19sZWRnZXJfY29ycnVwdFwiLFxuICAgICAgICAgIHNjb3BlOiBcInByb2plY3RcIixcbiAgICAgICAgICB1bml0SWQ6IFwicHJvamVjdFwiLFxuICAgICAgICAgIG1lc3NhZ2U6IFwibWV0cmljcy5qc29uIGlzIG5vdCB2YWxpZCBKU09OIFx1MjAxNCBtZXRyaWNzIGRhdGEgbWF5IGJlIGNvcnJ1cHRcIixcbiAgICAgICAgICBmaWxlOiBcIi5nc2QvbWV0cmljcy5qc29uXCIsXG4gICAgICAgICAgZml4YWJsZTogZmFsc2UsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gTm9uLWZhdGFsIFx1MjAxNCBtZXRyaWNzIGNoZWNrIGZhaWxlZFxuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwIE1ldHJpY3MgbGVkZ2VyIGJsb2F0IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAvLyBUaGUgbWV0cmljcyBsZWRnZXIgaGFzIG5vIFRUTCBhbmQgZ3Jvd3MgYnkgb25lIGVudHJ5IHBlciBjb21wbGV0ZWQgdW5pdC5cbiAgLy8gQXQgNTAgdW5pdHMvZGF5IGEgcHJvamVjdCBjYW4gYWNjdW11bGF0ZSB0ZW5zIG9mIHRob3VzYW5kcyBvZiBlbnRyaWVzIG92ZXJcbiAgLy8gbW9udGhzIG9mIHVzZS4gUHJ1bmUgdG8gdGhlIG5ld2VzdCAxNTAwIHdoZW4gdGhlIHRocmVzaG9sZCBpcyBleGNlZWRlZC5cbiAgdHJ5IHtcbiAgICBjb25zdCBtZXRyaWNzRmlsZVBhdGggPSBqb2luKHJvb3QsIFwibWV0cmljcy5qc29uXCIpO1xuICAgIGlmIChleGlzdHNTeW5jKG1ldHJpY3NGaWxlUGF0aCkpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHJhdyA9IHJlYWRGaWxlU3luYyhtZXRyaWNzRmlsZVBhdGgsIFwidXRmLThcIik7XG4gICAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocmF3KTtcbiAgICAgICAgY29uc3QgQkxPQVRfVU5JVFNfVEhSRVNIT0xEID0gMjAwMDtcbiAgICAgICAgaWYgKHBhcnNlZC52ZXJzaW9uID09PSAxICYmIEFycmF5LmlzQXJyYXkocGFyc2VkLnVuaXRzKSAmJiBwYXJzZWQudW5pdHMubGVuZ3RoID4gQkxPQVRfVU5JVFNfVEhSRVNIT0xEKSB7XG4gICAgICAgICAgY29uc3QgZmlsZVNpemVNQiA9IChzdGF0U3luYyhtZXRyaWNzRmlsZVBhdGgpLnNpemUgLyAoMTAyNCAqIDEwMjQpKS50b0ZpeGVkKDEpO1xuICAgICAgICAgIGlzc3Vlcy5wdXNoKHtcbiAgICAgICAgICAgIHNldmVyaXR5OiBcIndhcm5pbmdcIixcbiAgICAgICAgICAgIGNvZGU6IFwibWV0cmljc19sZWRnZXJfYmxvYXRcIixcbiAgICAgICAgICAgIHNjb3BlOiBcInByb2plY3RcIixcbiAgICAgICAgICAgIHVuaXRJZDogXCJwcm9qZWN0XCIsXG4gICAgICAgICAgICBtZXNzYWdlOiBgbWV0cmljcy5qc29uIGhhcyAke3BhcnNlZC51bml0cy5sZW5ndGh9IHVuaXQgZW50cmllcyAoJHtmaWxlU2l6ZU1CfU1CKSBcdTIwMTQgdGhyZXNob2xkIGlzICR7QkxPQVRfVU5JVFNfVEhSRVNIT0xEfS4gUnVuIC9nc2QgZG9jdG9yIC0tZml4IHRvIHBydW5lIHRvIHRoZSBuZXdlc3QgMTUwMCBlbnRyaWVzLmAsXG4gICAgICAgICAgICBmaWxlOiBcIi5nc2QvbWV0cmljcy5qc29uXCIsXG4gICAgICAgICAgICBmaXhhYmxlOiB0cnVlLFxuICAgICAgICAgIH0pO1xuICAgICAgICAgIGlmIChzaG91bGRGaXgoXCJtZXRyaWNzX2xlZGdlcl9ibG9hdFwiKSkge1xuICAgICAgICAgICAgY29uc3QgeyBwcnVuZU1ldHJpY3NMZWRnZXIgfSA9IGF3YWl0IGltcG9ydChcIi4vbWV0cmljcy5qc1wiKTtcbiAgICAgICAgICAgIGNvbnN0IHJlbW92ZWQgPSBwcnVuZU1ldHJpY3NMZWRnZXIoYmFzZVBhdGgsIDE1MDApO1xuICAgICAgICAgICAgZml4ZXNBcHBsaWVkLnB1c2goYHBydW5lZCBtZXRyaWNzIGxlZGdlcjogcmVtb3ZlZCAke3JlbW92ZWR9IG9sZGVzdCBlbnRyaWVzICgke3BhcnNlZC51bml0cy5sZW5ndGggLSByZW1vdmVkfSByZW1haW4pYCk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLy8gSlNPTiBwYXJzZSBmYWlsZWQgXHUyMDE0IGFscmVhZHkgaGFuZGxlZCBieSB0aGUgaW50ZWdyaXR5IGNoZWNrIGFib3ZlXG4gICAgICB9XG4gICAgfVxuICB9IGNhdGNoIHtcbiAgICAvLyBOb24tZmF0YWwgXHUyMDE0IG1ldHJpY3MgYmxvYXQgY2hlY2sgZmFpbGVkXG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgTGFyZ2UgcGxhbm5pbmcgZmlsZSBkZXRlY3Rpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIC8vIEZpbGVzIG92ZXIgMTAwS0IgY2FuIGNhdXNlIExMTSBjb250ZXh0IHByZXNzdXJlLiBSZXBvcnQgdGhlIHdvcnN0IG9mZmVuZGVycy5cbiAgdHJ5IHtcbiAgICBjb25zdCBNQVhfRklMRV9CWVRFUyA9IDEwMCAqIDEwMjQ7IC8vIDEwMEtCXG4gICAgY29uc3QgbWlsZXN0b25lc1BhdGggPSBtaWxlc3RvbmVzRGlyKGJhc2VQYXRoKTtcbiAgICBpZiAoZXhpc3RzU3luYyhtaWxlc3RvbmVzUGF0aCkpIHtcbiAgICAgIGNvbnN0IGxhcmdlRmlsZXM6IEFycmF5PHsgcGF0aDogc3RyaW5nOyBzaXplS0I6IG51bWJlciB9PiA9IFtdO1xuICAgICAgZnVuY3Rpb24gc2NhbkZvckxhcmdlRmlsZXMoZGlyOiBzdHJpbmcsIGRlcHRoID0gMCk6IHZvaWQge1xuICAgICAgICBpZiAoZGVwdGggPiA2KSByZXR1cm47XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgZm9yIChjb25zdCBlbnRyeSBvZiByZWFkZGlyU3luYyhkaXIpKSB7XG4gICAgICAgICAgICBjb25zdCBmdWxsID0gam9pbihkaXIsIGVudHJ5KTtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIGNvbnN0IHMgPSBzdGF0U3luYyhmdWxsKTtcbiAgICAgICAgICAgICAgaWYgKHMuaXNEaXJlY3RvcnkoKSkgeyBzY2FuRm9yTGFyZ2VGaWxlcyhmdWxsLCBkZXB0aCArIDEpOyBjb250aW51ZTsgfVxuICAgICAgICAgICAgICBpZiAoZW50cnkuZW5kc1dpdGgoXCIubWRcIikgJiYgcy5zaXplID4gTUFYX0ZJTEVfQllURVMpIHtcbiAgICAgICAgICAgICAgICBsYXJnZUZpbGVzLnB1c2goeyBwYXRoOiBmdWxsLnJlcGxhY2UoYmFzZVBhdGggKyBcIi9cIiwgXCJcIiksIHNpemVLQjogTWF0aC5yb3VuZChzLnNpemUgLyAxMDI0KSB9KTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBjYXRjaCB7IC8qIHNraXAgZW50cnkgKi8gfVxuICAgICAgICAgIH1cbiAgICAgICAgfSBjYXRjaCB7IC8qIHNraXAgZGlyICovIH1cbiAgICAgIH1cbiAgICAgIHNjYW5Gb3JMYXJnZUZpbGVzKG1pbGVzdG9uZXNQYXRoKTtcbiAgICAgIGlmIChsYXJnZUZpbGVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgbGFyZ2VGaWxlcy5zb3J0KChhLCBiKSA9PiBiLnNpemVLQiAtIGEuc2l6ZUtCKTtcbiAgICAgICAgY29uc3Qgd29yc3QgPSBsYXJnZUZpbGVzWzBdITtcbiAgICAgICAgaXNzdWVzLnB1c2goe1xuICAgICAgICAgIHNldmVyaXR5OiBcIndhcm5pbmdcIixcbiAgICAgICAgICBjb2RlOiBcImxhcmdlX3BsYW5uaW5nX2ZpbGVcIixcbiAgICAgICAgICBzY29wZTogXCJwcm9qZWN0XCIsXG4gICAgICAgICAgdW5pdElkOiBcInByb2plY3RcIixcbiAgICAgICAgICBtZXNzYWdlOiBgJHtsYXJnZUZpbGVzLmxlbmd0aH0gcGxhbm5pbmcgZmlsZShzKSBleGNlZWQgMTAwS0IgXHUyMDE0IGxhcmdlc3Q6ICR7d29yc3QucGF0aH0gKCR7d29yc3Quc2l6ZUtCfUtCKS4gTGFyZ2UgZmlsZXMgY2F1c2UgTExNIGNvbnRleHQgcHJlc3N1cmUuYCxcbiAgICAgICAgICBmaWxlOiB3b3JzdC5wYXRoLFxuICAgICAgICAgIGZpeGFibGU6IGZhbHNlLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIE5vbi1mYXRhbCBcdTIwMTQgbGFyZ2UgZmlsZSBzY2FuIGZhaWxlZFxuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwIFNuYXBzaG90IHJlZiBibG9hdCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgLy8gcmVmcy9nc2Qvc25hcHNob3RzLyBhY2N1bXVsYXRlIG92ZXIgdGltZS4gUHJ1bmUgdG8gbmV3ZXN0IDUgcGVyIGxhYmVsXG4gIC8vIHdoZW4gdG90YWwgY291bnQgZXhjZWVkcyB0aHJlc2hvbGQuXG4gIHRyeSB7XG4gICAgaWYgKG5hdGl2ZUlzUmVwbyhiYXNlUGF0aCkpIHtcbiAgICAgIGNvbnN0IHJlZnMgPSBuYXRpdmVGb3JFYWNoUmVmKGJhc2VQYXRoLCBcInJlZnMvZ3NkL3NuYXBzaG90cy9cIik7XG4gICAgICBpZiAocmVmcy5sZW5ndGggPiA1MCkge1xuICAgICAgICBpc3N1ZXMucHVzaCh7XG4gICAgICAgICAgc2V2ZXJpdHk6IFwid2FybmluZ1wiLFxuICAgICAgICAgIGNvZGU6IFwic25hcHNob3RfcmVmX2Jsb2F0XCIsXG4gICAgICAgICAgc2NvcGU6IFwicHJvamVjdFwiLFxuICAgICAgICAgIHVuaXRJZDogXCJwcm9qZWN0XCIsXG4gICAgICAgICAgbWVzc2FnZTogYCR7cmVmcy5sZW5ndGh9IHNuYXBzaG90IHJlZnMgZm91bmQgdW5kZXIgcmVmcy9nc2Qvc25hcHNob3RzLyBcdTIwMTQgcHJ1bmluZyB0byBuZXdlc3QgNSBwZXIgbGFiZWwgd2lsbCByZWNsYWltIGdpdCBzdG9yYWdlYCxcbiAgICAgICAgICBmaXhhYmxlOiB0cnVlLFxuICAgICAgICB9KTtcblxuICAgICAgICBpZiAoc2hvdWxkRml4KFwic25hcHNob3RfcmVmX2Jsb2F0XCIpKSB7XG4gICAgICAgICAgY29uc3QgYnlMYWJlbCA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmdbXT4oKTtcbiAgICAgICAgICBmb3IgKGNvbnN0IHJlZiBvZiByZWZzKSB7XG4gICAgICAgICAgICBjb25zdCBwYXJ0cyA9IHJlZi5zcGxpdChcIi9cIik7XG4gICAgICAgICAgICBjb25zdCBsYWJlbCA9IHBhcnRzLnNsaWNlKDAsIC0xKS5qb2luKFwiL1wiKTtcbiAgICAgICAgICAgIGlmICghYnlMYWJlbC5oYXMobGFiZWwpKSBieUxhYmVsLnNldChsYWJlbCwgW10pO1xuICAgICAgICAgICAgYnlMYWJlbC5nZXQobGFiZWwpIS5wdXNoKHJlZik7XG4gICAgICAgICAgfVxuICAgICAgICAgIGxldCBwcnVuZWQgPSAwO1xuICAgICAgICAgIGZvciAoY29uc3QgWywgbGFiZWxSZWZzXSBvZiBieUxhYmVsKSB7XG4gICAgICAgICAgICBjb25zdCBzb3J0ZWQgPSBsYWJlbFJlZnMuc29ydCgpO1xuICAgICAgICAgICAgZm9yIChjb25zdCBvbGQgb2Ygc29ydGVkLnNsaWNlKDAsIC01KSkge1xuICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIG5hdGl2ZVVwZGF0ZVJlZihiYXNlUGF0aCwgb2xkKTtcbiAgICAgICAgICAgICAgICBwcnVuZWQrKztcbiAgICAgICAgICAgICAgfSBjYXRjaCB7IC8qIHNraXAgKi8gfVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAocHJ1bmVkID4gMCkge1xuICAgICAgICAgICAgZml4ZXNBcHBsaWVkLnB1c2goYHBydW5lZCAke3BydW5lZH0gb2xkIHNuYXBzaG90IHJlZihzKWApO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gTm9uLWZhdGFsIFx1MjAxNCBzbmFwc2hvdCByZWYgY2hlY2sgZmFpbGVkXG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgT3JwaGFuIG1pbGVzdG9uZSBkaXJlY3RvcmllcyAoIzQ5OTYpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAvLyBXYWxrIGV2ZXJ5IG1pbGVzdG9uZSBJRCBvbiBkaXNrLiBBbnkgZGlyIHRoYXQgaGFzIG5vIERCIHJvdywgbm8gd29ya3RyZWUsXG4gIC8vIGFuZCBubyBjb250ZW50IGZpbGVzIGlzIGFuIG9ycGhhbmVkIHN0dWIgXHUyMDE0IGl0IHNrZXdzIG5leHRNaWxlc3RvbmVJZCBhbmRcbiAgLy8gd2FzIGxpa2VseSBjcmVhdGVkIGJ5IGVuc3VyZVByZWNvbmRpdGlvbnMgb3Igc2hvd0hlYWRsZXNzTWlsZXN0b25lQ3JlYXRpb25cbiAgLy8gZm9yIGEgcGhhbnRvbSBmb3J3YXJkLXJlZmVyZW5jZS4gU3VyZmFjZSBhcyBhIGZpeGFibGUgd2FybmluZy5cbiAgdHJ5IHtcbiAgICBjb25zdCBtaWxlc3RvbmVJZHMgPSBmaW5kTWlsZXN0b25lSWRzKGJhc2VQYXRoKTtcbiAgICBjb25zdCBoYXNEYkZpbGUgPSBleGlzdHNTeW5jKGpvaW4ocm9vdCwgXCJnc2QuZGJcIikpO1xuICAgIGZvciAoY29uc3QgbWlkIG9mIG1pbGVzdG9uZUlkcykge1xuICAgICAgY29uc3QgaXNPcnBoYW4gPSBpc1JldXNhYmxlR2hvc3RNaWxlc3RvbmUoYmFzZVBhdGgsIG1pZClcbiAgICAgICAgfHwgKCFoYXNEYkZpbGUgJiYgaXNHaG9zdE1pbGVzdG9uZShiYXNlUGF0aCwgbWlkKSk7XG4gICAgICBpZiAoaXNPcnBoYW4pIHtcbiAgICAgICAgaXNzdWVzLnB1c2goe1xuICAgICAgICAgIHNldmVyaXR5OiBcIndhcm5pbmdcIixcbiAgICAgICAgICBjb2RlOiBcIm9ycGhhbl9taWxlc3RvbmVfZGlyXCIsXG4gICAgICAgICAgc2NvcGU6IFwibWlsZXN0b25lXCIsXG4gICAgICAgICAgdW5pdElkOiBtaWQsXG4gICAgICAgICAgbWVzc2FnZTogYE9ycGhhbiBtaWxlc3RvbmUgZGlyZWN0b3J5OiAke21pZH0gXHUyMDE0IGRpcmVjdG9yeSBleGlzdHMgb24gZGlzayB3aXRoIG5vIERCIHJvdywgbm8gd29ya3RyZWUsIGFuZCBubyBjb250ZW50IGZpbGVzLiBUaGlzIHN0dWIgc2tld3MgbWlsZXN0b25lIElEIGdlbmVyYXRpb24gYW5kIHNob3VsZCBiZSByZW1vdmVkLmAsXG4gICAgICAgICAgZmlsZTogYC5nc2QvbWlsZXN0b25lcy8ke21pZH1gLFxuICAgICAgICAgIGZpeGFibGU6IHRydWUsXG4gICAgICAgIH0pO1xuXG4gICAgICAgIGlmIChzaG91bGRGaXgoXCJvcnBoYW5fbWlsZXN0b25lX2RpclwiKSkge1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBvcnBoYW5QYXRoID0gam9pbihtaWxlc3RvbmVzRGlyKGJhc2VQYXRoKSwgbWlkKTtcbiAgICAgICAgICAgIHJtU3luYyhvcnBoYW5QYXRoLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgICAgICAgICBmaXhlc0FwcGxpZWQucHVzaChgcmVtb3ZlZCBvcnBoYW4gbWlsZXN0b25lIGRpcmVjdG9yeTogJHttaWR9YCk7XG4gICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAvLyBOb24tZmF0YWwgXHUyMDE0IGxlYXZlIGZvciBtYW51YWwgY2xlYW51cFxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gTm9uLWZhdGFsIFx1MjAxNCBvcnBoYW4gbWlsZXN0b25lIGRpcmVjdG9yeSBjaGVjayBmYWlsZWRcbiAgfVxufVxuXG4vKipcbiAqIEJ1aWxkIFNUQVRFLm1kIG1hcmtkb3duIGNvbnRlbnQgZnJvbSBkZXJpdmVkIHN0YXRlLlxuICogTG9jYWwgaGVscGVyIHVzZWQgYnkgY2hlY2tSdW50aW1lSGVhbHRoIGZvciBTVEFURS5tZCBkcmlmdCBkZXRlY3Rpb24gYW5kIHJlcGFpci5cbiAqL1xuZnVuY3Rpb24gYnVpbGRTdGF0ZU1hcmtkb3duRm9yQ2hlY2soc3RhdGU6IEF3YWl0ZWQ8UmV0dXJuVHlwZTx0eXBlb2YgZGVyaXZlU3RhdGU+Pik6IHN0cmluZyB7XG4gIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICBsaW5lcy5wdXNoKFwiIyBHU0QgU3RhdGVcIiwgXCJcIik7XG5cbiAgY29uc3QgYWN0aXZlTWlsZXN0b25lID0gc3RhdGUuYWN0aXZlTWlsZXN0b25lXG4gICAgPyBgJHtzdGF0ZS5hY3RpdmVNaWxlc3RvbmUuaWR9OiAke3N0YXRlLmFjdGl2ZU1pbGVzdG9uZS50aXRsZX1gXG4gICAgOiBcIk5vbmVcIjtcbiAgY29uc3QgYWN0aXZlU2xpY2UgPSBzdGF0ZS5hY3RpdmVTbGljZVxuICAgID8gYCR7c3RhdGUuYWN0aXZlU2xpY2UuaWR9OiAke3N0YXRlLmFjdGl2ZVNsaWNlLnRpdGxlfWBcbiAgICA6IFwiTm9uZVwiO1xuXG4gIGxpbmVzLnB1c2goYCoqQWN0aXZlIE1pbGVzdG9uZToqKiAke2FjdGl2ZU1pbGVzdG9uZX1gKTtcbiAgbGluZXMucHVzaChgKipBY3RpdmUgU2xpY2U6KiogJHthY3RpdmVTbGljZX1gKTtcbiAgbGluZXMucHVzaChgKipQaGFzZToqKiAke3N0YXRlLnBoYXNlfWApO1xuICBpZiAoc3RhdGUucmVxdWlyZW1lbnRzKSB7XG4gICAgbGluZXMucHVzaChgKipSZXF1aXJlbWVudHMgU3RhdHVzOioqICR7c3RhdGUucmVxdWlyZW1lbnRzLmFjdGl2ZX0gYWN0aXZlIFx1MDBCNyAke3N0YXRlLnJlcXVpcmVtZW50cy52YWxpZGF0ZWR9IHZhbGlkYXRlZCBcdTAwQjcgJHtzdGF0ZS5yZXF1aXJlbWVudHMuZGVmZXJyZWR9IGRlZmVycmVkIFx1MDBCNyAke3N0YXRlLnJlcXVpcmVtZW50cy5vdXRPZlNjb3BlfSBvdXQgb2Ygc2NvcGVgKTtcbiAgfVxuICBsaW5lcy5wdXNoKFwiXCIpO1xuICBsaW5lcy5wdXNoKFwiIyMgTWlsZXN0b25lIFJlZ2lzdHJ5XCIpO1xuXG4gIGZvciAoY29uc3QgZW50cnkgb2Ygc3RhdGUucmVnaXN0cnkpIHtcbiAgICBjb25zdCBnbHlwaCA9IGVudHJ5LnN0YXR1cyA9PT0gXCJjb21wbGV0ZVwiID8gXCJcXHUyNzA1XCIgOiBlbnRyeS5zdGF0dXMgPT09IFwiYWN0aXZlXCIgPyBcIlxcdUQ4M0RcXHVERDA0XCIgOiBlbnRyeS5zdGF0dXMgPT09IFwicGFya2VkXCIgPyBcIlxcdTIzRjhcXHVGRTBGXCIgOiBcIlxcdTJCMUNcIjtcbiAgICBsaW5lcy5wdXNoKGAtICR7Z2x5cGh9ICoqJHtlbnRyeS5pZH06KiogJHtlbnRyeS50aXRsZX1gKTtcbiAgfVxuXG4gIGxpbmVzLnB1c2goXCJcIik7XG4gIGxpbmVzLnB1c2goXCIjIyBSZWNlbnQgRGVjaXNpb25zXCIpO1xuICBpZiAoc3RhdGUucmVjZW50RGVjaXNpb25zLmxlbmd0aCA+IDApIHtcbiAgICBmb3IgKGNvbnN0IGRlY2lzaW9uIG9mIHN0YXRlLnJlY2VudERlY2lzaW9ucykgbGluZXMucHVzaChgLSAke2RlY2lzaW9ufWApO1xuICB9IGVsc2Uge1xuICAgIGxpbmVzLnB1c2goXCItIE5vbmUgcmVjb3JkZWRcIik7XG4gIH1cblxuICBsaW5lcy5wdXNoKFwiXCIpO1xuICBsaW5lcy5wdXNoKFwiIyMgQmxvY2tlcnNcIik7XG4gIGlmIChzdGF0ZS5ibG9ja2Vycy5sZW5ndGggPiAwKSB7XG4gICAgZm9yIChjb25zdCBibG9ja2VyIG9mIHN0YXRlLmJsb2NrZXJzKSBsaW5lcy5wdXNoKGAtICR7YmxvY2tlcn1gKTtcbiAgfSBlbHNlIHtcbiAgICBsaW5lcy5wdXNoKFwiLSBOb25lXCIpO1xuICB9XG5cbiAgbGluZXMucHVzaChcIlwiKTtcbiAgbGluZXMucHVzaChcIiMjIE5leHQgQWN0aW9uXCIpO1xuICBsaW5lcy5wdXNoKHN0YXRlLm5leHRBY3Rpb24gfHwgXCJOb25lXCIpO1xuICBsaW5lcy5wdXNoKFwiXCIpO1xuXG4gIHJldHVybiBsaW5lcy5qb2luKFwiXFxuXCIpO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxZQUFZLFdBQVcsYUFBYSxjQUFjLGNBQWMsUUFBUSxnQkFBZ0I7QUFDakcsU0FBUyxVQUFVLFNBQVMsWUFBWTtBQUd4QyxTQUFTLGdDQUFnQztBQUN6QyxTQUFTLGVBQWUsU0FBUywwQkFBMEI7QUFDM0QsU0FBUyxhQUFhLGtCQUFrQixnQ0FBZ0M7QUFDeEUsU0FBUyxnQkFBZ0I7QUFDekIsU0FBUyxjQUFjLGtCQUFrQix1QkFBdUI7QUFDaEUsU0FBUyxlQUFlLG9CQUFvQiw0QkFBNEI7QUFDeEUsU0FBUyw0QkFBNEI7QUFDckMsU0FBUyx5QkFBeUI7QUFDbEMsU0FBUyxpQkFBaUIsdUJBQXVCO0FBQ2pELFNBQVMsd0JBQXdCLGdCQUFnQiwyQkFBMkI7QUFDNUUsU0FBUyw4QkFBOEI7QUFDdkMsU0FBUyx5QkFBeUI7QUFDbEMsU0FBUyx3QkFBd0I7QUFFakMsTUFBTSxtQkFBbUI7QUFFekIsU0FBUyxxQkFBcUIsVUFBa0IsS0FBYSxLQUFzQjtBQUNqRixRQUFNLGlCQUFpQixL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
