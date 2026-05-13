import { deriveState } from "./state.js";
import { nativeBranchList, nativeDetectMainBranch, nativeBranchListMerged, nativeBranchDelete, nativeForEachRef, nativeUpdateRef } from "./native-git-bridge.js";
import { logWarning } from "./workflow-logger.js";
async function handleCleanupBranches(ctx, basePath) {
  let branches;
  try {
    branches = nativeBranchList(basePath, "gsd/*");
  } catch (e) {
    logWarning("command", `branch list failed: ${e.message}`);
    ctx.ui.notify("No GSD branches to clean up.", "info");
    return;
  }
  const quickBranches = branches.filter((b) => b.startsWith("gsd/quick/"));
  const mainBranch = nativeDetectMainBranch(basePath);
  let merged;
  try {
    merged = nativeBranchListMerged(basePath, mainBranch, "gsd/*");
  } catch (e) {
    logWarning("command", `merged branch list failed: ${e.message}`);
    merged = [];
  }
  const mergedNonQuick = merged.filter((b) => !b.startsWith("gsd/quick/"));
  let deletedMerged = 0;
  for (const branch of mergedNonQuick) {
    try {
      nativeBranchDelete(basePath, branch, false);
      deletedMerged++;
    } catch (e) {
      logWarning("command", `branch delete failed for ${branch}: ${e.message}`);
    }
  }
  let deletedStaleMilestones = 0;
  try {
    const { listWorktrees } = await import("./worktree-manager.js");
    const { resolveMilestoneFile } = await import("./paths.js");
    const { loadFile } = await import("./files.js");
    const { parseRoadmap } = await import("./parsers-legacy.js");
    const { isMilestoneComplete } = await import("./state.js");
    const { isDbAvailable, getMilestone } = await import("./gsd-db.js");
    const attachedBranches = new Set(
      listWorktrees(basePath).map((wt) => wt.branch)
    );
    const milestoneBranches = nativeBranchList(basePath, "milestone/*");
    for (const branch of milestoneBranches) {
      if (attachedBranches.has(branch)) continue;
      const milestoneId = branch.replace(/^milestone\//, "");
      if (isDbAvailable()) {
        const dbRow = getMilestone(milestoneId);
        if (dbRow) {
          if (dbRow.status !== "complete" && dbRow.status !== "done") continue;
          try {
            nativeBranchDelete(basePath, branch, true);
            deletedStaleMilestones++;
          } catch (e) {
            logWarning("command", `stale milestone branch delete failed for ${branch}: ${e.message}`);
          }
          continue;
        }
      }
      const roadmapPath = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
      if (!roadmapPath) continue;
      let roadmapContent = null;
      try {
        roadmapContent = await loadFile(roadmapPath);
      } catch (e) {
        logWarning("command", `loadFile failed for ${roadmapPath}: ${e.message}`);
        roadmapContent = null;
      }
      if (!roadmapContent) continue;
      if (!isMilestoneComplete(parseRoadmap(roadmapContent))) continue;
      try {
        nativeBranchDelete(basePath, branch, true);
        deletedStaleMilestones++;
      } catch (e) {
        logWarning("command", `milestone branch delete failed for ${branch}: ${e.message}`);
      }
    }
  } catch (e) {
    logWarning("command", `stale milestone cleanup failed: ${e.message}`);
  }
  const summary = [];
  if (deletedMerged > 0) {
    summary.push(`Cleaned up ${deletedMerged} merged branch${deletedMerged === 1 ? "" : "es"}.`);
  }
  if (deletedStaleMilestones > 0) {
    summary.push(`Deleted ${deletedStaleMilestones} stale milestone branch${deletedStaleMilestones === 1 ? "" : "es"}.`);
  }
  if (quickBranches.length > 0) {
    summary.push(`Skipped ${quickBranches.length} quick branch${quickBranches.length === 1 ? "" : "es"} (gsd/quick/*).`);
  }
  if (summary.length === 0) {
    const nonQuickCount = branches.filter((b) => !b.startsWith("gsd/quick/")).length;
    ctx.ui.notify(
      nonQuickCount > 0 ? `${nonQuickCount} GSD branch${nonQuickCount === 1 ? "" : "es"} found, none merged into ${mainBranch} yet.` : "No non-quick GSD branches to clean up.",
      "info"
    );
    return;
  }
  ctx.ui.notify(summary.join(" "), "success");
}
async function handleCleanupSnapshots(ctx, basePath) {
  let refs;
  try {
    refs = nativeForEachRef(basePath, "refs/gsd/snapshots/");
  } catch (e) {
    logWarning("command", `snapshot ref list failed: ${e.message}`);
    ctx.ui.notify("No snapshot refs to clean up.", "info");
    return;
  }
  if (refs.length === 0) {
    ctx.ui.notify("No snapshot refs to clean up.", "info");
    return;
  }
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
      } catch (e) {
        logWarning("command", `snapshot ref update failed for ${old}: ${e.message}`);
      }
    }
  }
  ctx.ui.notify(`Pruned ${pruned} old snapshot refs. ${refs.length - pruned} remain.`, "success");
}
async function handleCleanupWorktrees(ctx, basePath) {
  const { getAllWorktreeHealth, formatWorktreeStatusLine } = await import("./worktree-health.js");
  const { removeWorktree } = await import("./worktree-manager.js");
  const { sep } = await import("node:path");
  let statuses;
  try {
    statuses = getAllWorktreeHealth(basePath);
  } catch (e) {
    logWarning("command", `worktree health inspection failed: ${e.message}`);
    ctx.ui.notify("Failed to inspect worktrees.", "error");
    return;
  }
  if (statuses.length === 0) {
    ctx.ui.notify("No GSD worktrees found.", "info");
    return;
  }
  const safeToRemove = statuses.filter((s) => s.safeToRemove);
  const stale = statuses.filter((s) => s.stale && !s.safeToRemove);
  const active = statuses.filter((s) => !s.safeToRemove && !s.stale);
  const lines = [];
  lines.push(`${statuses.length} worktree${statuses.length === 1 ? "" : "s"} found.`);
  lines.push("");
  if (safeToRemove.length > 0) {
    lines.push(`Safe to remove (${safeToRemove.length}) \u2014 merged into main, clean:`);
    const cwd = process.cwd();
    let removed = 0;
    for (const s of safeToRemove) {
      const wt = s.worktree;
      const isCwd = wt.path === cwd || cwd.startsWith(wt.path + sep);
      if (isCwd) {
        lines.push(`  \u2298 ${wt.name}  (skipped \u2014 current working directory)`);
        continue;
      }
      try {
        removeWorktree(basePath, wt.name, { deleteBranch: true });
        lines.push(`  \u2713 ${wt.name}  removed (branch ${wt.branch} deleted)`);
        removed++;
      } catch (e) {
        logWarning("command", `worktree removal failed for ${wt.name}: ${e.message}`);
        lines.push(`  \u2717 ${wt.name}  failed to remove`);
      }
    }
    if (removed > 0) {
      lines.push("");
      lines.push(`Removed ${removed} merged worktree${removed === 1 ? "" : "s"}.`);
    }
    lines.push("");
  }
  if (stale.length > 0) {
    lines.push(`Stale (${stale.length}) \u2014 no recent commits, not merged (review manually):`);
    for (const s of stale) {
      lines.push(`  \u26A0 ${s.worktree.name}  ${formatWorktreeStatusLine(s)}`);
    }
    lines.push("");
  }
  if (active.length > 0) {
    lines.push(`Active (${active.length}) \u2014 in progress:`);
    for (const s of active) {
      lines.push(`  \u25CF ${s.worktree.name}  ${formatWorktreeStatusLine(s)}`);
    }
    lines.push("");
  }
  if (safeToRemove.length === 0 && stale.length === 0) {
    lines.push("All worktrees are active \u2014 nothing to clean up.");
  }
  ctx.ui.notify(lines.join("\n"), safeToRemove.length > 0 ? "success" : "info");
}
async function handleSkip(unitArg, ctx, basePath) {
  if (!unitArg) {
    ctx.ui.notify("Usage: /gsd skip <unit-id>  (e.g., /gsd skip execute-task/M001/S01/T03 or /gsd skip T03)", "info");
    return;
  }
  const { existsSync: fileExists, writeFileSync: writeFile, mkdirSync: mkDir, readFileSync: readFile } = await import("node:fs");
  const { join: pathJoin } = await import("node:path");
  const completedKeysFile = pathJoin(basePath, ".gsd", "completed-units.json");
  let keys = [];
  try {
    if (fileExists(completedKeysFile)) {
      keys = JSON.parse(readFile(completedKeysFile, "utf-8"));
    }
  } catch (e) {
    logWarning("command", `completed-units.json parse failed: ${e.message}`);
  }
  let skipKey = unitArg;
  if (!skipKey.includes("execute-task") && !skipKey.includes("plan-") && !skipKey.includes("research-") && !skipKey.includes("complete-")) {
    const state = await deriveState(basePath);
    const mid = state.activeMilestone?.id;
    const sid = state.activeSlice?.id;
    if (unitArg.match(/^T\d+$/i) && mid && sid) {
      skipKey = `execute-task/${mid}/${sid}/${unitArg.toUpperCase()}`;
    } else if (unitArg.match(/^S\d+$/i) && mid) {
      skipKey = `plan-slice/${mid}/${unitArg.toUpperCase()}`;
    } else if (unitArg.includes("/")) {
      skipKey = `execute-task/${unitArg}`;
    }
  }
  if (keys.includes(skipKey)) {
    ctx.ui.notify(`Already skipped: ${skipKey}`, "info");
    return;
  }
  keys.push(skipKey);
  mkDir(pathJoin(basePath, ".gsd"), { recursive: true });
  writeFile(completedKeysFile, JSON.stringify(keys), "utf-8");
  ctx.ui.notify(`Skipped: ${skipKey}. Will not be dispatched in auto-mode.`, "success");
}
async function handleDryRun(ctx, basePath) {
  const state = await deriveState(basePath);
  if (!state.activeMilestone) {
    ctx.ui.notify("No active milestone \u2014 nothing to dispatch.", "info");
    return;
  }
  const { getLedger, getProjectTotals, formatCost, formatTokenCount, loadLedgerFromDisk } = await import("./metrics.js");
  const { loadEffectiveGSDPreferences: loadPrefs } = await import("./preferences.js");
  const { formatDuration } = await import("../shared/format-utils.js");
  const ledger = getLedger();
  const units = ledger?.units ?? loadLedgerFromDisk(basePath)?.units ?? [];
  const prefs = loadPrefs()?.preferences;
  let nextType = "unknown";
  let nextId = "unknown";
  const mid = state.activeMilestone.id;
  const midTitle = state.activeMilestone.title;
  if (state.phase === "pre-planning") {
    nextType = "research-milestone";
    nextId = mid;
  } else if (state.phase === "planning" && state.activeSlice) {
    nextType = "plan-slice";
    nextId = `${mid}/${state.activeSlice.id}`;
  } else if (state.phase === "executing" && state.activeTask && state.activeSlice) {
    nextType = "execute-task";
    nextId = `${mid}/${state.activeSlice.id}/${state.activeTask.id}`;
  } else if (state.phase === "summarizing" && state.activeSlice) {
    nextType = "complete-slice";
    nextId = `${mid}/${state.activeSlice.id}`;
  } else if (state.phase === "completing-milestone") {
    nextType = "complete-milestone";
    nextId = mid;
  } else {
    nextType = state.phase;
    nextId = mid;
  }
  const sameTypeUnits = units.filter((u) => u.type === nextType);
  const avgCost = sameTypeUnits.length > 0 ? sameTypeUnits.reduce((s, u) => s + u.cost, 0) / sameTypeUnits.length : null;
  const avgDuration = sameTypeUnits.length > 0 ? sameTypeUnits.reduce((s, u) => s + (u.finishedAt - u.startedAt), 0) / sameTypeUnits.length : null;
  const totals = units.length > 0 ? getProjectTotals(units) : null;
  const budgetRemaining = prefs?.budget_ceiling && totals ? prefs.budget_ceiling - totals.cost : null;
  const lines = [
    `Dry-run preview:`,
    ``,
    `  Next unit:     ${nextType}`,
    `  ID:            ${nextId}`,
    `  Milestone:     ${mid}: ${midTitle}`,
    `  Phase:         ${state.phase}`,
    `  Est. cost:     ${avgCost !== null ? `${formatCost(avgCost)} (avg of ${sameTypeUnits.length} similar)` : "unknown (first of this type)"}`,
    `  Est. duration: ${avgDuration !== null ? formatDuration(avgDuration) : "unknown"}`,
    `  Spent so far:  ${totals ? formatCost(totals.cost) : "$0"}`,
    `  Budget left:   ${budgetRemaining !== null ? formatCost(budgetRemaining) : "no ceiling set"}`
  ];
  if (state.progress) {
    const p = state.progress;
    lines.push(`  Progress:      ${p.tasks?.done ?? 0}/${p.tasks?.total ?? "?"} tasks, ${p.slices?.done ?? 0}/${p.slices?.total ?? "?"} slices`);
  }
  ctx.ui.notify(lines.join("\n"), "info");
}
async function handleCleanupProjects(args, ctx) {
  const { readdirSync, existsSync: fsExists, rmSync: fsRmSync } = await import("node:fs");
  const { join: pathJoin } = await import("node:path");
  const { readRepoMeta, externalProjectsRoot } = await import("./repo-identity.js");
  const fix = args.includes("--fix");
  const projectsDir = externalProjectsRoot();
  if (!fsExists(projectsDir)) {
    ctx.ui.notify(`No project-state directory found at ${projectsDir} \u2014 nothing to clean up.`, "info");
    return;
  }
  let hashList;
  try {
    hashList = readdirSync(projectsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (e) {
    logWarning("command", `readdir failed for project-state directory: ${e.message}`);
    ctx.ui.notify(`Failed to read project-state directory at ${projectsDir}.`, "error");
    return;
  }
  if (hashList.length === 0) {
    ctx.ui.notify(`Project-state directory is empty (${projectsDir}) \u2014 nothing to clean up.`, "info");
    return;
  }
  const active = [];
  const orphaned = [];
  const unknown = [];
  for (const hash of hashList) {
    const dirPath = pathJoin(projectsDir, hash);
    const meta = readRepoMeta(dirPath);
    if (!meta) {
      unknown.push(hash);
      continue;
    }
    const entry = { hash, gitRoot: meta.gitRoot, remoteUrl: meta.remoteUrl };
    if (fsExists(meta.gitRoot)) {
      active.push(entry);
    } else {
      orphaned.push(entry);
    }
  }
  const pl = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const lines = [
    `${projectsDir}  ${pl(hashList.length, "project state director")}${hashList.length === 1 ? "y" : "ies"}`,
    ""
  ];
  if (active.length > 0) {
    lines.push(`Active (${active.length}) \u2014 git root present on disk:`);
    for (const e of active) {
      const remote = e.remoteUrl ? `  [${e.remoteUrl}]` : "";
      lines.push(`  + ${e.hash}  ${e.gitRoot}${remote}`);
    }
    lines.push("");
  }
  if (orphaned.length > 0) {
    lines.push(`Orphaned (${orphaned.length}) \u2014 git root no longer exists:`);
    for (const e of orphaned) {
      const remote = e.remoteUrl ? `  [${e.remoteUrl}]` : "";
      lines.push(`  - ${e.hash}  ${e.gitRoot}${remote}`);
    }
    lines.push("");
  }
  if (unknown.length > 0) {
    lines.push(`Unknown (${unknown.length}) \u2014 no metadata yet:`);
    for (const h of unknown) {
      lines.push(`  ? ${h}  (open that project in GSD once to register metadata)`);
    }
    lines.push("");
  }
  if (orphaned.length === 0) {
    lines.push("No orphaned project state \u2014 all tracked repos are still present on disk.");
    if (!fix) {
      ctx.ui.notify(lines.join("\n"), "success");
      return;
    }
  }
  if (!fix && orphaned.length > 0) {
    lines.push(`Run /gsd cleanup projects --fix to permanently delete ${pl(orphaned.length, "orphaned director")}${orphaned.length === 1 ? "y" : "ies"}.`);
    ctx.ui.notify(lines.join("\n"), "warning");
    return;
  }
  if (fix && orphaned.length > 0) {
    let removed = 0;
    const failed = [];
    for (const e of orphaned) {
      try {
        fsRmSync(pathJoin(projectsDir, e.hash), { recursive: true, force: true });
        removed++;
      } catch (err) {
        logWarning("command", `project cleanup rm failed for ${e.hash}: ${err.message}`);
        failed.push(e.hash);
      }
    }
    lines.push(`Removed ${pl(removed, "orphaned director")}${removed === 1 ? "y" : "ies"}.`);
    if (failed.length > 0) {
      lines.push(`Failed to remove: ${failed.join(", ")}`);
    }
    ctx.ui.notify(lines.join("\n"), removed > 0 ? "success" : "warning");
    return;
  }
  ctx.ui.notify(lines.join("\n"), "info");
}
async function handleRecover(ctx, basePath) {
  const { isDbAvailable: dbAvailable, clearEngineHierarchy, transaction: dbTransaction } = await import("./gsd-db.js");
  const { migrateHierarchyToDb } = await import("./md-importer.js");
  const { invalidateStateCache } = await import("./state.js");
  if (!dbAvailable()) {
    ctx.ui.notify("gsd recover: No database open. Run a GSD command first to initialize the DB.", "error");
    return;
  }
  try {
    const counts = dbTransaction(() => {
      clearEngineHierarchy();
      return migrateHierarchyToDb(basePath);
    });
    invalidateStateCache();
    const state = await deriveState(basePath);
    const lines = [
      `gsd recover: reconstructed hierarchy from markdown`,
      `  Milestones: ${counts.milestones}`,
      `  Slices:     ${counts.slices}`,
      `  Tasks:      ${counts.tasks}`,
      ``,
      `  Phase:      ${state.phase}`
    ];
    if (state.activeMilestone) {
      lines.push(`  Active:     ${state.activeMilestone.id}: ${state.activeMilestone.title}`);
    }
    if (state.activeSlice) {
      lines.push(`  Slice:      ${state.activeSlice.id}: ${state.activeSlice.title}`);
    }
    if (state.activeTask) {
      lines.push(`  Task:       ${state.activeTask.id}: ${state.activeTask.title}`);
    }
    process.stderr.write(
      `gsd-recover: recovered ${counts.milestones}M/${counts.slices}S/${counts.tasks}T hierarchy
`
    );
    ctx.ui.notify(lines.join("\n"), "success");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logWarning("command", `recover failed: ${msg}`);
    ctx.ui.notify(`gsd recover failed: ${msg}`, "error");
  }
}
export {
  handleCleanupBranches,
  handleCleanupProjects,
  handleCleanupSnapshots,
  handleCleanupWorktrees,
  handleDryRun,
  handleRecover,
  handleSkip
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9jb21tYW5kcy1tYWludGVuYW5jZS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBHU0QgTWFpbnRlbmFuY2UgXHUyMDE0IGNsZWFudXAsIHNraXAsIGRyeS1ydW4sIGFuZCByZWNvdmVyIGhhbmRsZXJzLlxuICpcbiAqIENvbnRhaW5zOiBoYW5kbGVDbGVhbnVwQnJhbmNoZXMsIGhhbmRsZUNsZWFudXBTbmFwc2hvdHMsIGhhbmRsZUNsZWFudXBXb3JrdHJlZXMsIGhhbmRsZVNraXAsIGhhbmRsZURyeVJ1biwgaGFuZGxlUmVjb3ZlclxuICovXG5cbmltcG9ydCB0eXBlIHsgRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB7IGRlcml2ZVN0YXRlIH0gZnJvbSBcIi4vc3RhdGUuanNcIjtcbmltcG9ydCB7IG5hdGl2ZUJyYW5jaExpc3QsIG5hdGl2ZURldGVjdE1haW5CcmFuY2gsIG5hdGl2ZUJyYW5jaExpc3RNZXJnZWQsIG5hdGl2ZUJyYW5jaERlbGV0ZSwgbmF0aXZlRm9yRWFjaFJlZiwgbmF0aXZlVXBkYXRlUmVmIH0gZnJvbSBcIi4vbmF0aXZlLWdpdC1icmlkZ2UuanNcIjtcbmltcG9ydCB7IGxvZ1dhcm5pbmcgfSBmcm9tIFwiLi93b3JrZmxvdy1sb2dnZXIuanNcIjtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZUNsZWFudXBCcmFuY2hlcyhjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LCBiYXNlUGF0aDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGxldCBicmFuY2hlczogc3RyaW5nW107XG4gIHRyeSB7XG4gICAgYnJhbmNoZXMgPSBuYXRpdmVCcmFuY2hMaXN0KGJhc2VQYXRoLCBcImdzZC8qXCIpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgbG9nV2FybmluZyhcImNvbW1hbmRcIiwgYGJyYW5jaCBsaXN0IGZhaWxlZDogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICBjdHgudWkubm90aWZ5KFwiTm8gR1NEIGJyYW5jaGVzIHRvIGNsZWFuIHVwLlwiLCBcImluZm9cIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgcXVpY2tCcmFuY2hlcyA9IGJyYW5jaGVzLmZpbHRlcigoYikgPT4gYi5zdGFydHNXaXRoKFwiZ3NkL3F1aWNrL1wiKSk7XG5cbiAgY29uc3QgbWFpbkJyYW5jaCA9IG5hdGl2ZURldGVjdE1haW5CcmFuY2goYmFzZVBhdGgpO1xuICBsZXQgbWVyZ2VkOiBzdHJpbmdbXTtcbiAgdHJ5IHtcbiAgICBtZXJnZWQgPSBuYXRpdmVCcmFuY2hMaXN0TWVyZ2VkKGJhc2VQYXRoLCBtYWluQnJhbmNoLCBcImdzZC8qXCIpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgbG9nV2FybmluZyhcImNvbW1hbmRcIiwgYG1lcmdlZCBicmFuY2ggbGlzdCBmYWlsZWQ6ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgbWVyZ2VkID0gW107XG4gIH1cblxuICBjb25zdCBtZXJnZWROb25RdWljayA9IG1lcmdlZC5maWx0ZXIoKGIpID0+ICFiLnN0YXJ0c1dpdGgoXCJnc2QvcXVpY2svXCIpKTtcbiAgbGV0IGRlbGV0ZWRNZXJnZWQgPSAwO1xuICBmb3IgKGNvbnN0IGJyYW5jaCBvZiBtZXJnZWROb25RdWljaykge1xuICAgIHRyeSB7XG4gICAgICBuYXRpdmVCcmFuY2hEZWxldGUoYmFzZVBhdGgsIGJyYW5jaCwgZmFsc2UpO1xuICAgICAgZGVsZXRlZE1lcmdlZCsrO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGxvZ1dhcm5pbmcoXCJjb21tYW5kXCIsIGBicmFuY2ggZGVsZXRlIGZhaWxlZCBmb3IgJHticmFuY2h9OiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWApO1xuICAgIH1cbiAgfVxuXG4gIC8vIEFsc28gZGVsZXRlIHN0YWxlIG1pbGVzdG9uZSBicmFuY2hlcyBmb3IgY29tcGxldGVkIG1pbGVzdG9uZXMgd2hlbiBkZXRhY2hlZFxuICAvLyBmcm9tIGFueSByZWdpc3RlcmVkIHdvcmt0cmVlLlxuICBsZXQgZGVsZXRlZFN0YWxlTWlsZXN0b25lcyA9IDA7XG4gIHRyeSB7XG4gICAgY29uc3QgeyBsaXN0V29ya3RyZWVzIH0gPSBhd2FpdCBpbXBvcnQoXCIuL3dvcmt0cmVlLW1hbmFnZXIuanNcIik7XG4gICAgY29uc3QgeyByZXNvbHZlTWlsZXN0b25lRmlsZSB9ID0gYXdhaXQgaW1wb3J0KFwiLi9wYXRocy5qc1wiKTtcbiAgICBjb25zdCB7IGxvYWRGaWxlIH0gPSBhd2FpdCBpbXBvcnQoXCIuL2ZpbGVzLmpzXCIpO1xuICAgIGNvbnN0IHsgcGFyc2VSb2FkbWFwIH0gPSBhd2FpdCBpbXBvcnQoXCIuL3BhcnNlcnMtbGVnYWN5LmpzXCIpO1xuICAgIGNvbnN0IHsgaXNNaWxlc3RvbmVDb21wbGV0ZSB9ID0gYXdhaXQgaW1wb3J0KFwiLi9zdGF0ZS5qc1wiKTtcbiAgICBjb25zdCB7IGlzRGJBdmFpbGFibGUsIGdldE1pbGVzdG9uZSB9ID0gYXdhaXQgaW1wb3J0KFwiLi9nc2QtZGIuanNcIik7XG5cbiAgICBjb25zdCBhdHRhY2hlZEJyYW5jaGVzID0gbmV3IFNldChcbiAgICAgIGxpc3RXb3JrdHJlZXMoYmFzZVBhdGgpLm1hcCgod3QpID0+IHd0LmJyYW5jaCksXG4gICAgKTtcbiAgICBjb25zdCBtaWxlc3RvbmVCcmFuY2hlcyA9IG5hdGl2ZUJyYW5jaExpc3QoYmFzZVBhdGgsIFwibWlsZXN0b25lLypcIik7XG4gICAgZm9yIChjb25zdCBicmFuY2ggb2YgbWlsZXN0b25lQnJhbmNoZXMpIHtcbiAgICAgIGlmIChhdHRhY2hlZEJyYW5jaGVzLmhhcyhicmFuY2gpKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IG1pbGVzdG9uZUlkID0gYnJhbmNoLnJlcGxhY2UoL15taWxlc3RvbmVcXC8vLCBcIlwiKTtcblxuICAgICAgLy8gREItZmlyc3Q6IGNoZWNrIG1pbGVzdG9uZSBzdGF0dXMgZGlyZWN0bHlcbiAgICAgIGlmIChpc0RiQXZhaWxhYmxlKCkpIHtcbiAgICAgICAgY29uc3QgZGJSb3cgPSBnZXRNaWxlc3RvbmUobWlsZXN0b25lSWQpO1xuICAgICAgICBpZiAoZGJSb3cpIHtcbiAgICAgICAgICBpZiAoZGJSb3cuc3RhdHVzICE9PSBcImNvbXBsZXRlXCIgJiYgZGJSb3cuc3RhdHVzICE9PSBcImRvbmVcIikgY29udGludWU7XG4gICAgICAgICAgLy8gTWlsZXN0b25lIGlzIGNvbXBsZXRlIHBlciBEQiBcdTIwMTQgcHJvY2VlZCB0byBkZWxldGUgYnJhbmNoXG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIG5hdGl2ZUJyYW5jaERlbGV0ZShiYXNlUGF0aCwgYnJhbmNoLCB0cnVlKTtcbiAgICAgICAgICAgIGRlbGV0ZWRTdGFsZU1pbGVzdG9uZXMrKztcbiAgICAgICAgICB9IGNhdGNoIChlKSB7IGxvZ1dhcm5pbmcoXCJjb21tYW5kXCIsIGBzdGFsZSBtaWxlc3RvbmUgYnJhbmNoIGRlbGV0ZSBmYWlsZWQgZm9yICR7YnJhbmNofTogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gKTsgfVxuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIEZpbGVzeXN0ZW0gZmFsbGJhY2tcbiAgICAgIGNvbnN0IHJvYWRtYXBQYXRoID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBcIlJPQURNQVBcIik7XG4gICAgICBpZiAoIXJvYWRtYXBQYXRoKSBjb250aW51ZTtcbiAgICAgIGxldCByb2FkbWFwQ29udGVudDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gICAgICB0cnkge1xuICAgICAgICByb2FkbWFwQ29udGVudCA9IGF3YWl0IGxvYWRGaWxlKHJvYWRtYXBQYXRoKTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgbG9nV2FybmluZyhcImNvbW1hbmRcIiwgYGxvYWRGaWxlIGZhaWxlZCBmb3IgJHtyb2FkbWFwUGF0aH06ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgICAgIHJvYWRtYXBDb250ZW50ID0gbnVsbDtcbiAgICAgIH1cbiAgICAgIGlmICghcm9hZG1hcENvbnRlbnQpIGNvbnRpbnVlO1xuICAgICAgaWYgKCFpc01pbGVzdG9uZUNvbXBsZXRlKHBhcnNlUm9hZG1hcChyb2FkbWFwQ29udGVudCkpKSBjb250aW51ZTtcbiAgICAgIHRyeSB7XG4gICAgICAgIG5hdGl2ZUJyYW5jaERlbGV0ZShiYXNlUGF0aCwgYnJhbmNoLCB0cnVlKTtcbiAgICAgICAgZGVsZXRlZFN0YWxlTWlsZXN0b25lcysrO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBsb2dXYXJuaW5nKFwiY29tbWFuZFwiLCBgbWlsZXN0b25lIGJyYW5jaCBkZWxldGUgZmFpbGVkIGZvciAke2JyYW5jaH06ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgICB9XG4gICAgfVxuICB9IGNhdGNoIChlKSB7XG4gICAgbG9nV2FybmluZyhcImNvbW1hbmRcIiwgYHN0YWxlIG1pbGVzdG9uZSBjbGVhbnVwIGZhaWxlZDogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgfVxuXG4gIGNvbnN0IHN1bW1hcnk6IHN0cmluZ1tdID0gW107XG4gIGlmIChkZWxldGVkTWVyZ2VkID4gMCkge1xuICAgIHN1bW1hcnkucHVzaChgQ2xlYW5lZCB1cCAke2RlbGV0ZWRNZXJnZWR9IG1lcmdlZCBicmFuY2gke2RlbGV0ZWRNZXJnZWQgPT09IDEgPyBcIlwiIDogXCJlc1wifS5gKTtcbiAgfVxuICBpZiAoZGVsZXRlZFN0YWxlTWlsZXN0b25lcyA+IDApIHtcbiAgICBzdW1tYXJ5LnB1c2goYERlbGV0ZWQgJHtkZWxldGVkU3RhbGVNaWxlc3RvbmVzfSBzdGFsZSBtaWxlc3RvbmUgYnJhbmNoJHtkZWxldGVkU3RhbGVNaWxlc3RvbmVzID09PSAxID8gXCJcIiA6IFwiZXNcIn0uYCk7XG4gIH1cbiAgaWYgKHF1aWNrQnJhbmNoZXMubGVuZ3RoID4gMCkge1xuICAgIHN1bW1hcnkucHVzaChgU2tpcHBlZCAke3F1aWNrQnJhbmNoZXMubGVuZ3RofSBxdWljayBicmFuY2gke3F1aWNrQnJhbmNoZXMubGVuZ3RoID09PSAxID8gXCJcIiA6IFwiZXNcIn0gKGdzZC9xdWljay8qKS5gKTtcbiAgfVxuXG4gIGlmIChzdW1tYXJ5Lmxlbmd0aCA9PT0gMCkge1xuICAgIGNvbnN0IG5vblF1aWNrQ291bnQgPSBicmFuY2hlcy5maWx0ZXIoKGIpID0+ICFiLnN0YXJ0c1dpdGgoXCJnc2QvcXVpY2svXCIpKS5sZW5ndGg7XG4gICAgY3R4LnVpLm5vdGlmeShcbiAgICAgIG5vblF1aWNrQ291bnQgPiAwXG4gICAgICAgID8gYCR7bm9uUXVpY2tDb3VudH0gR1NEIGJyYW5jaCR7bm9uUXVpY2tDb3VudCA9PT0gMSA/IFwiXCIgOiBcImVzXCJ9IGZvdW5kLCBub25lIG1lcmdlZCBpbnRvICR7bWFpbkJyYW5jaH0geWV0LmBcbiAgICAgICAgOiBcIk5vIG5vbi1xdWljayBHU0QgYnJhbmNoZXMgdG8gY2xlYW4gdXAuXCIsXG4gICAgICBcImluZm9cIixcbiAgICApO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGN0eC51aS5ub3RpZnkoc3VtbWFyeS5qb2luKFwiIFwiKSwgXCJzdWNjZXNzXCIpO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlQ2xlYW51cFNuYXBzaG90cyhjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LCBiYXNlUGF0aDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGxldCByZWZzOiBzdHJpbmdbXTtcbiAgdHJ5IHtcbiAgICByZWZzID0gbmF0aXZlRm9yRWFjaFJlZihiYXNlUGF0aCwgXCJyZWZzL2dzZC9zbmFwc2hvdHMvXCIpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgbG9nV2FybmluZyhcImNvbW1hbmRcIiwgYHNuYXBzaG90IHJlZiBsaXN0IGZhaWxlZDogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICBjdHgudWkubm90aWZ5KFwiTm8gc25hcHNob3QgcmVmcyB0byBjbGVhbiB1cC5cIiwgXCJpbmZvXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmIChyZWZzLmxlbmd0aCA9PT0gMCkge1xuICAgIGN0eC51aS5ub3RpZnkoXCJObyBzbmFwc2hvdCByZWZzIHRvIGNsZWFuIHVwLlwiLCBcImluZm9cIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgYnlMYWJlbCA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmdbXT4oKTtcbiAgZm9yIChjb25zdCByZWYgb2YgcmVmcykge1xuICAgIGNvbnN0IHBhcnRzID0gcmVmLnNwbGl0KFwiL1wiKTtcbiAgICBjb25zdCBsYWJlbCA9IHBhcnRzLnNsaWNlKDAsIC0xKS5qb2luKFwiL1wiKTtcbiAgICBpZiAoIWJ5TGFiZWwuaGFzKGxhYmVsKSkgYnlMYWJlbC5zZXQobGFiZWwsIFtdKTtcbiAgICBieUxhYmVsLmdldChsYWJlbCkhLnB1c2gocmVmKTtcbiAgfVxuXG4gIGxldCBwcnVuZWQgPSAwO1xuICBmb3IgKGNvbnN0IFssIGxhYmVsUmVmc10gb2YgYnlMYWJlbCkge1xuICAgIGNvbnN0IHNvcnRlZCA9IGxhYmVsUmVmcy5zb3J0KCk7XG4gICAgZm9yIChjb25zdCBvbGQgb2Ygc29ydGVkLnNsaWNlKDAsIC01KSkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgbmF0aXZlVXBkYXRlUmVmKGJhc2VQYXRoLCBvbGQpO1xuICAgICAgICBwcnVuZWQrKztcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgbG9nV2FybmluZyhcImNvbW1hbmRcIiwgYHNuYXBzaG90IHJlZiB1cGRhdGUgZmFpbGVkIGZvciAke29sZH06ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgY3R4LnVpLm5vdGlmeShgUHJ1bmVkICR7cHJ1bmVkfSBvbGQgc25hcHNob3QgcmVmcy4gJHtyZWZzLmxlbmd0aCAtIHBydW5lZH0gcmVtYWluLmAsIFwic3VjY2Vzc1wiKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZUNsZWFudXBXb3JrdHJlZXMoY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCwgYmFzZVBhdGg6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB7IGdldEFsbFdvcmt0cmVlSGVhbHRoLCBmb3JtYXRXb3JrdHJlZVN0YXR1c0xpbmUgfSA9IGF3YWl0IGltcG9ydChcIi4vd29ya3RyZWUtaGVhbHRoLmpzXCIpO1xuICBjb25zdCB7IHJlbW92ZVdvcmt0cmVlIH0gPSBhd2FpdCBpbXBvcnQoXCIuL3dvcmt0cmVlLW1hbmFnZXIuanNcIik7XG4gIGNvbnN0IHsgc2VwIH0gPSBhd2FpdCBpbXBvcnQoXCJub2RlOnBhdGhcIik7XG5cbiAgbGV0IHN0YXR1c2VzO1xuICB0cnkge1xuICAgIHN0YXR1c2VzID0gZ2V0QWxsV29ya3RyZWVIZWFsdGgoYmFzZVBhdGgpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgbG9nV2FybmluZyhcImNvbW1hbmRcIiwgYHdvcmt0cmVlIGhlYWx0aCBpbnNwZWN0aW9uIGZhaWxlZDogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICBjdHgudWkubm90aWZ5KFwiRmFpbGVkIHRvIGluc3BlY3Qgd29ya3RyZWVzLlwiLCBcImVycm9yXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmIChzdGF0dXNlcy5sZW5ndGggPT09IDApIHtcbiAgICBjdHgudWkubm90aWZ5KFwiTm8gR1NEIHdvcmt0cmVlcyBmb3VuZC5cIiwgXCJpbmZvXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHNhZmVUb1JlbW92ZSA9IHN0YXR1c2VzLmZpbHRlcihzID0+IHMuc2FmZVRvUmVtb3ZlKTtcbiAgY29uc3Qgc3RhbGUgPSBzdGF0dXNlcy5maWx0ZXIocyA9PiBzLnN0YWxlICYmICFzLnNhZmVUb1JlbW92ZSk7XG4gIGNvbnN0IGFjdGl2ZSA9IHN0YXR1c2VzLmZpbHRlcihzID0+ICFzLnNhZmVUb1JlbW92ZSAmJiAhcy5zdGFsZSk7XG5cbiAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG4gIGxpbmVzLnB1c2goYCR7c3RhdHVzZXMubGVuZ3RofSB3b3JrdHJlZSR7c3RhdHVzZXMubGVuZ3RoID09PSAxID8gXCJcIiA6IFwic1wifSBmb3VuZC5gKTtcbiAgbGluZXMucHVzaChcIlwiKTtcblxuICBpZiAoc2FmZVRvUmVtb3ZlLmxlbmd0aCA+IDApIHtcbiAgICBsaW5lcy5wdXNoKGBTYWZlIHRvIHJlbW92ZSAoJHtzYWZlVG9SZW1vdmUubGVuZ3RofSkgXHUyMDE0IG1lcmdlZCBpbnRvIG1haW4sIGNsZWFuOmApO1xuICAgIGNvbnN0IGN3ZCA9IHByb2Nlc3MuY3dkKCk7XG4gICAgbGV0IHJlbW92ZWQgPSAwO1xuICAgIGZvciAoY29uc3QgcyBvZiBzYWZlVG9SZW1vdmUpIHtcbiAgICAgIGNvbnN0IHd0ID0gcy53b3JrdHJlZTtcbiAgICAgIGNvbnN0IGlzQ3dkID0gd3QucGF0aCA9PT0gY3dkIHx8IGN3ZC5zdGFydHNXaXRoKHd0LnBhdGggKyBzZXApO1xuICAgICAgaWYgKGlzQ3dkKSB7XG4gICAgICAgIGxpbmVzLnB1c2goYCAgXHUyMjk4ICR7d3QubmFtZX0gIChza2lwcGVkIFx1MjAxNCBjdXJyZW50IHdvcmtpbmcgZGlyZWN0b3J5KWApO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIHRyeSB7XG4gICAgICAgIHJlbW92ZVdvcmt0cmVlKGJhc2VQYXRoLCB3dC5uYW1lLCB7IGRlbGV0ZUJyYW5jaDogdHJ1ZSB9KTtcbiAgICAgICAgbGluZXMucHVzaChgICBcdTI3MTMgJHt3dC5uYW1lfSAgcmVtb3ZlZCAoYnJhbmNoICR7d3QuYnJhbmNofSBkZWxldGVkKWApO1xuICAgICAgICByZW1vdmVkKys7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGxvZ1dhcm5pbmcoXCJjb21tYW5kXCIsIGB3b3JrdHJlZSByZW1vdmFsIGZhaWxlZCBmb3IgJHt3dC5uYW1lfTogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICAgICAgbGluZXMucHVzaChgICBcdTI3MTcgJHt3dC5uYW1lfSAgZmFpbGVkIHRvIHJlbW92ZWApO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAocmVtb3ZlZCA+IDApIHtcbiAgICAgIGxpbmVzLnB1c2goXCJcIik7XG4gICAgICBsaW5lcy5wdXNoKGBSZW1vdmVkICR7cmVtb3ZlZH0gbWVyZ2VkIHdvcmt0cmVlJHtyZW1vdmVkID09PSAxID8gXCJcIiA6IFwic1wifS5gKTtcbiAgICB9XG4gICAgbGluZXMucHVzaChcIlwiKTtcbiAgfVxuXG4gIGlmIChzdGFsZS5sZW5ndGggPiAwKSB7XG4gICAgbGluZXMucHVzaChgU3RhbGUgKCR7c3RhbGUubGVuZ3RofSkgXHUyMDE0IG5vIHJlY2VudCBjb21taXRzLCBub3QgbWVyZ2VkIChyZXZpZXcgbWFudWFsbHkpOmApO1xuICAgIGZvciAoY29uc3QgcyBvZiBzdGFsZSkge1xuICAgICAgbGluZXMucHVzaChgICBcdTI2QTAgJHtzLndvcmt0cmVlLm5hbWV9ICAke2Zvcm1hdFdvcmt0cmVlU3RhdHVzTGluZShzKX1gKTtcbiAgICB9XG4gICAgbGluZXMucHVzaChcIlwiKTtcbiAgfVxuXG4gIGlmIChhY3RpdmUubGVuZ3RoID4gMCkge1xuICAgIGxpbmVzLnB1c2goYEFjdGl2ZSAoJHthY3RpdmUubGVuZ3RofSkgXHUyMDE0IGluIHByb2dyZXNzOmApO1xuICAgIGZvciAoY29uc3QgcyBvZiBhY3RpdmUpIHtcbiAgICAgIGxpbmVzLnB1c2goYCAgXHUyNUNGICR7cy53b3JrdHJlZS5uYW1lfSAgJHtmb3JtYXRXb3JrdHJlZVN0YXR1c0xpbmUocyl9YCk7XG4gICAgfVxuICAgIGxpbmVzLnB1c2goXCJcIik7XG4gIH1cblxuICBpZiAoc2FmZVRvUmVtb3ZlLmxlbmd0aCA9PT0gMCAmJiBzdGFsZS5sZW5ndGggPT09IDApIHtcbiAgICBsaW5lcy5wdXNoKFwiQWxsIHdvcmt0cmVlcyBhcmUgYWN0aXZlIFx1MjAxNCBub3RoaW5nIHRvIGNsZWFuIHVwLlwiKTtcbiAgfVxuXG4gIGN0eC51aS5ub3RpZnkobGluZXMuam9pbihcIlxcblwiKSwgc2FmZVRvUmVtb3ZlLmxlbmd0aCA+IDAgPyBcInN1Y2Nlc3NcIiA6IFwiaW5mb1wiKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZVNraXAodW5pdEFyZzogc3RyaW5nLCBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LCBiYXNlUGF0aDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGlmICghdW5pdEFyZykge1xuICAgIGN0eC51aS5ub3RpZnkoXCJVc2FnZTogL2dzZCBza2lwIDx1bml0LWlkPiAgKGUuZy4sIC9nc2Qgc2tpcCBleGVjdXRlLXRhc2svTTAwMS9TMDEvVDAzIG9yIC9nc2Qgc2tpcCBUMDMpXCIsIFwiaW5mb1wiKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCB7IGV4aXN0c1N5bmM6IGZpbGVFeGlzdHMsIHdyaXRlRmlsZVN5bmM6IHdyaXRlRmlsZSwgbWtkaXJTeW5jOiBta0RpciwgcmVhZEZpbGVTeW5jOiByZWFkRmlsZSB9ID0gYXdhaXQgaW1wb3J0KFwibm9kZTpmc1wiKTtcbiAgY29uc3QgeyBqb2luOiBwYXRoSm9pbiB9ID0gYXdhaXQgaW1wb3J0KFwibm9kZTpwYXRoXCIpO1xuXG4gIGNvbnN0IGNvbXBsZXRlZEtleXNGaWxlID0gcGF0aEpvaW4oYmFzZVBhdGgsIFwiLmdzZFwiLCBcImNvbXBsZXRlZC11bml0cy5qc29uXCIpO1xuICBsZXQga2V5czogc3RyaW5nW10gPSBbXTtcbiAgdHJ5IHtcbiAgICBpZiAoZmlsZUV4aXN0cyhjb21wbGV0ZWRLZXlzRmlsZSkpIHtcbiAgICAgIGtleXMgPSBKU09OLnBhcnNlKHJlYWRGaWxlKGNvbXBsZXRlZEtleXNGaWxlLCBcInV0Zi04XCIpKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGUpIHsgbG9nV2FybmluZyhcImNvbW1hbmRcIiwgYGNvbXBsZXRlZC11bml0cy5qc29uIHBhcnNlIGZhaWxlZDogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gKTsgfVxuXG4gIC8vIE5vcm1hbGl6ZTogYWNjZXB0IFwiZXhlY3V0ZS10YXNrL00wMDEvUzAxL1QwM1wiLCBcIk0wMDEvUzAxL1QwM1wiLCBvciBqdXN0IFwiVDAzXCJcbiAgbGV0IHNraXBLZXkgPSB1bml0QXJnO1xuXG4gIGlmICghc2tpcEtleS5pbmNsdWRlcyhcImV4ZWN1dGUtdGFza1wiKSAmJiAhc2tpcEtleS5pbmNsdWRlcyhcInBsYW4tXCIpICYmICFza2lwS2V5LmluY2x1ZGVzKFwicmVzZWFyY2gtXCIpICYmICFza2lwS2V5LmluY2x1ZGVzKFwiY29tcGxldGUtXCIpKSB7XG4gICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlUGF0aCk7XG4gICAgY29uc3QgbWlkID0gc3RhdGUuYWN0aXZlTWlsZXN0b25lPy5pZDtcbiAgICBjb25zdCBzaWQgPSBzdGF0ZS5hY3RpdmVTbGljZT8uaWQ7XG5cbiAgICBpZiAodW5pdEFyZy5tYXRjaCgvXlRcXGQrJC9pKSAmJiBtaWQgJiYgc2lkKSB7XG4gICAgICBza2lwS2V5ID0gYGV4ZWN1dGUtdGFzay8ke21pZH0vJHtzaWR9LyR7dW5pdEFyZy50b1VwcGVyQ2FzZSgpfWA7XG4gICAgfSBlbHNlIGlmICh1bml0QXJnLm1hdGNoKC9eU1xcZCskL2kpICYmIG1pZCkge1xuICAgICAgc2tpcEtleSA9IGBwbGFuLXNsaWNlLyR7bWlkfS8ke3VuaXRBcmcudG9VcHBlckNhc2UoKX1gO1xuICAgIH0gZWxzZSBpZiAodW5pdEFyZy5pbmNsdWRlcyhcIi9cIikpIHtcbiAgICAgIHNraXBLZXkgPSBgZXhlY3V0ZS10YXNrLyR7dW5pdEFyZ31gO1xuICAgIH1cbiAgfVxuXG4gIGlmIChrZXlzLmluY2x1ZGVzKHNraXBLZXkpKSB7XG4gICAgY3R4LnVpLm5vdGlmeShgQWxyZWFkeSBza2lwcGVkOiAke3NraXBLZXl9YCwgXCJpbmZvXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGtleXMucHVzaChza2lwS2V5KTtcbiAgbWtEaXIocGF0aEpvaW4oYmFzZVBhdGgsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZShjb21wbGV0ZWRLZXlzRmlsZSwgSlNPTi5zdHJpbmdpZnkoa2V5cyksIFwidXRmLThcIik7XG5cbiAgY3R4LnVpLm5vdGlmeShgU2tpcHBlZDogJHtza2lwS2V5fS4gV2lsbCBub3QgYmUgZGlzcGF0Y2hlZCBpbiBhdXRvLW1vZGUuYCwgXCJzdWNjZXNzXCIpO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlRHJ5UnVuKGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsIGJhc2VQYXRoOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlUGF0aCk7XG5cbiAgaWYgKCFzdGF0ZS5hY3RpdmVNaWxlc3RvbmUpIHtcbiAgICBjdHgudWkubm90aWZ5KFwiTm8gYWN0aXZlIG1pbGVzdG9uZSBcdTIwMTQgbm90aGluZyB0byBkaXNwYXRjaC5cIiwgXCJpbmZvXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHsgZ2V0TGVkZ2VyLCBnZXRQcm9qZWN0VG90YWxzLCBmb3JtYXRDb3N0LCBmb3JtYXRUb2tlbkNvdW50LCBsb2FkTGVkZ2VyRnJvbURpc2sgfSA9IGF3YWl0IGltcG9ydChcIi4vbWV0cmljcy5qc1wiKTtcbiAgY29uc3QgeyBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXM6IGxvYWRQcmVmcyB9ID0gYXdhaXQgaW1wb3J0KFwiLi9wcmVmZXJlbmNlcy5qc1wiKTtcbiAgY29uc3QgeyBmb3JtYXREdXJhdGlvbiB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vc2hhcmVkL2Zvcm1hdC11dGlscy5qc1wiKTtcblxuICBjb25zdCBsZWRnZXIgPSBnZXRMZWRnZXIoKTtcbiAgY29uc3QgdW5pdHMgPSBsZWRnZXI/LnVuaXRzID8/IGxvYWRMZWRnZXJGcm9tRGlzayhiYXNlUGF0aCk/LnVuaXRzID8/IFtdO1xuICBjb25zdCBwcmVmcyA9IGxvYWRQcmVmcygpPy5wcmVmZXJlbmNlcztcblxuICBsZXQgbmV4dFR5cGUgPSBcInVua25vd25cIjtcbiAgbGV0IG5leHRJZCA9IFwidW5rbm93blwiO1xuXG4gIGNvbnN0IG1pZCA9IHN0YXRlLmFjdGl2ZU1pbGVzdG9uZS5pZDtcbiAgY29uc3QgbWlkVGl0bGUgPSBzdGF0ZS5hY3RpdmVNaWxlc3RvbmUudGl0bGU7XG5cbiAgaWYgKHN0YXRlLnBoYXNlID09PSBcInByZS1wbGFubmluZ1wiKSB7XG4gICAgbmV4dFR5cGUgPSBcInJlc2VhcmNoLW1pbGVzdG9uZVwiO1xuICAgIG5leHRJZCA9IG1pZDtcbiAgfSBlbHNlIGlmIChzdGF0ZS5waGFzZSA9PT0gXCJwbGFubmluZ1wiICYmIHN0YXRlLmFjdGl2ZVNsaWNlKSB7XG4gICAgbmV4dFR5cGUgPSBcInBsYW4tc2xpY2VcIjtcbiAgICBuZXh0SWQgPSBgJHttaWR9LyR7c3RhdGUuYWN0aXZlU2xpY2UuaWR9YDtcbiAgfSBlbHNlIGlmIChzdGF0ZS5waGFzZSA9PT0gXCJleGVjdXRpbmdcIiAmJiBzdGF0ZS5hY3RpdmVUYXNrICYmIHN0YXRlLmFjdGl2ZVNsaWNlKSB7XG4gICAgbmV4dFR5cGUgPSBcImV4ZWN1dGUtdGFza1wiO1xuICAgIG5leHRJZCA9IGAke21pZH0vJHtzdGF0ZS5hY3RpdmVTbGljZS5pZH0vJHtzdGF0ZS5hY3RpdmVUYXNrLmlkfWA7XG4gIH0gZWxzZSBpZiAoc3RhdGUucGhhc2UgPT09IFwic3VtbWFyaXppbmdcIiAmJiBzdGF0ZS5hY3RpdmVTbGljZSkge1xuICAgIG5leHRUeXBlID0gXCJjb21wbGV0ZS1zbGljZVwiO1xuICAgIG5leHRJZCA9IGAke21pZH0vJHtzdGF0ZS5hY3RpdmVTbGljZS5pZH1gO1xuICB9IGVsc2UgaWYgKHN0YXRlLnBoYXNlID09PSBcImNvbXBsZXRpbmctbWlsZXN0b25lXCIpIHtcbiAgICBuZXh0VHlwZSA9IFwiY29tcGxldGUtbWlsZXN0b25lXCI7XG4gICAgbmV4dElkID0gbWlkO1xuICB9IGVsc2Uge1xuICAgIG5leHRUeXBlID0gc3RhdGUucGhhc2U7XG4gICAgbmV4dElkID0gbWlkO1xuICB9XG5cbiAgY29uc3Qgc2FtZVR5cGVVbml0cyA9IHVuaXRzLmZpbHRlcih1ID0+IHUudHlwZSA9PT0gbmV4dFR5cGUpO1xuICBjb25zdCBhdmdDb3N0ID0gc2FtZVR5cGVVbml0cy5sZW5ndGggPiAwXG4gICAgPyBzYW1lVHlwZVVuaXRzLnJlZHVjZSgocywgdSkgPT4gcyArIHUuY29zdCwgMCkgLyBzYW1lVHlwZVVuaXRzLmxlbmd0aFxuICAgIDogbnVsbDtcbiAgY29uc3QgYXZnRHVyYXRpb24gPSBzYW1lVHlwZVVuaXRzLmxlbmd0aCA+IDBcbiAgICA/IHNhbWVUeXBlVW5pdHMucmVkdWNlKChzLCB1KSA9PiBzICsgKHUuZmluaXNoZWRBdCAtIHUuc3RhcnRlZEF0KSwgMCkgLyBzYW1lVHlwZVVuaXRzLmxlbmd0aFxuICAgIDogbnVsbDtcblxuICBjb25zdCB0b3RhbHMgPSB1bml0cy5sZW5ndGggPiAwID8gZ2V0UHJvamVjdFRvdGFscyh1bml0cykgOiBudWxsO1xuICBjb25zdCBidWRnZXRSZW1haW5pbmcgPSBwcmVmcz8uYnVkZ2V0X2NlaWxpbmcgJiYgdG90YWxzXG4gICAgPyBwcmVmcy5idWRnZXRfY2VpbGluZyAtIHRvdGFscy5jb3N0XG4gICAgOiBudWxsO1xuXG4gIGNvbnN0IGxpbmVzID0gW1xuICAgIGBEcnktcnVuIHByZXZpZXc6YCxcbiAgICBgYCxcbiAgICBgICBOZXh0IHVuaXQ6ICAgICAke25leHRUeXBlfWAsXG4gICAgYCAgSUQ6ICAgICAgICAgICAgJHtuZXh0SWR9YCxcbiAgICBgICBNaWxlc3RvbmU6ICAgICAke21pZH06ICR7bWlkVGl0bGV9YCxcbiAgICBgICBQaGFzZTogICAgICAgICAke3N0YXRlLnBoYXNlfWAsXG4gICAgYCAgRXN0LiBjb3N0OiAgICAgJHthdmdDb3N0ICE9PSBudWxsID8gYCR7Zm9ybWF0Q29zdChhdmdDb3N0KX0gKGF2ZyBvZiAke3NhbWVUeXBlVW5pdHMubGVuZ3RofSBzaW1pbGFyKWAgOiBcInVua25vd24gKGZpcnN0IG9mIHRoaXMgdHlwZSlcIn1gLFxuICAgIGAgIEVzdC4gZHVyYXRpb246ICR7YXZnRHVyYXRpb24gIT09IG51bGwgPyBmb3JtYXREdXJhdGlvbihhdmdEdXJhdGlvbikgOiBcInVua25vd25cIn1gLFxuICAgIGAgIFNwZW50IHNvIGZhcjogICR7dG90YWxzID8gZm9ybWF0Q29zdCh0b3RhbHMuY29zdCkgOiBcIiQwXCJ9YCxcbiAgICBgICBCdWRnZXQgbGVmdDogICAke2J1ZGdldFJlbWFpbmluZyAhPT0gbnVsbCA/IGZvcm1hdENvc3QoYnVkZ2V0UmVtYWluaW5nKSA6IFwibm8gY2VpbGluZyBzZXRcIn1gLFxuICBdO1xuXG4gIGlmIChzdGF0ZS5wcm9ncmVzcykge1xuICAgIGNvbnN0IHAgPSBzdGF0ZS5wcm9ncmVzcztcbiAgICBsaW5lcy5wdXNoKGAgIFByb2dyZXNzOiAgICAgICR7cC50YXNrcz8uZG9uZSA/PyAwfS8ke3AudGFza3M/LnRvdGFsID8/IFwiP1wifSB0YXNrcywgJHtwLnNsaWNlcz8uZG9uZSA/PyAwfS8ke3Auc2xpY2VzPy50b3RhbCA/PyBcIj9cIn0gc2xpY2VzYCk7XG4gIH1cblxuICBjdHgudWkubm90aWZ5KGxpbmVzLmpvaW4oXCJcXG5cIiksIFwiaW5mb1wiKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZUNsZWFudXBQcm9qZWN0cyhhcmdzOiBzdHJpbmcsIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgeyByZWFkZGlyU3luYywgZXhpc3RzU3luYzogZnNFeGlzdHMsIHJtU3luYzogZnNSbVN5bmMgfSA9IGF3YWl0IGltcG9ydChcIm5vZGU6ZnNcIik7XG4gIGNvbnN0IHsgam9pbjogcGF0aEpvaW4gfSA9IGF3YWl0IGltcG9ydChcIm5vZGU6cGF0aFwiKTtcbiAgY29uc3QgeyByZWFkUmVwb01ldGEsIGV4dGVybmFsUHJvamVjdHNSb290IH0gPSBhd2FpdCBpbXBvcnQoXCIuL3JlcG8taWRlbnRpdHkuanNcIik7XG5cbiAgY29uc3QgZml4ID0gYXJncy5pbmNsdWRlcyhcIi0tZml4XCIpO1xuICBjb25zdCBwcm9qZWN0c0RpciA9IGV4dGVybmFsUHJvamVjdHNSb290KCk7XG5cbiAgaWYgKCFmc0V4aXN0cyhwcm9qZWN0c0RpcikpIHtcbiAgICBjdHgudWkubm90aWZ5KGBObyBwcm9qZWN0LXN0YXRlIGRpcmVjdG9yeSBmb3VuZCBhdCAke3Byb2plY3RzRGlyfSBcdTIwMTQgbm90aGluZyB0byBjbGVhbiB1cC5gLCBcImluZm9cIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgbGV0IGhhc2hMaXN0OiBzdHJpbmdbXTtcbiAgdHJ5IHtcbiAgICBoYXNoTGlzdCA9IHJlYWRkaXJTeW5jKHByb2plY3RzRGlyLCB7IHdpdGhGaWxlVHlwZXM6IHRydWUgfSlcbiAgICAgIC5maWx0ZXIoZSA9PiBlLmlzRGlyZWN0b3J5KCkpXG4gICAgICAubWFwKGUgPT4gZS5uYW1lKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGxvZ1dhcm5pbmcoXCJjb21tYW5kXCIsIGByZWFkZGlyIGZhaWxlZCBmb3IgcHJvamVjdC1zdGF0ZSBkaXJlY3Rvcnk6ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgY3R4LnVpLm5vdGlmeShgRmFpbGVkIHRvIHJlYWQgcHJvamVjdC1zdGF0ZSBkaXJlY3RvcnkgYXQgJHtwcm9qZWN0c0Rpcn0uYCwgXCJlcnJvclwiKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAoaGFzaExpc3QubGVuZ3RoID09PSAwKSB7XG4gICAgY3R4LnVpLm5vdGlmeShgUHJvamVjdC1zdGF0ZSBkaXJlY3RvcnkgaXMgZW1wdHkgKCR7cHJvamVjdHNEaXJ9KSBcdTIwMTQgbm90aGluZyB0byBjbGVhbiB1cC5gLCBcImluZm9cIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgdHlwZSBQcm9qZWN0RW50cnkgPSB7IGhhc2g6IHN0cmluZzsgZ2l0Um9vdDogc3RyaW5nOyByZW1vdGVVcmw6IHN0cmluZyB9O1xuICBjb25zdCBhY3RpdmU6IFByb2plY3RFbnRyeVtdID0gW107XG4gIGNvbnN0IG9ycGhhbmVkOiBQcm9qZWN0RW50cnlbXSA9IFtdO1xuICBjb25zdCB1bmtub3duOiBzdHJpbmdbXSA9IFtdO1xuXG4gIGZvciAoY29uc3QgaGFzaCBvZiBoYXNoTGlzdCkge1xuICAgIGNvbnN0IGRpclBhdGggPSBwYXRoSm9pbihwcm9qZWN0c0RpciwgaGFzaCk7XG4gICAgY29uc3QgbWV0YSA9IHJlYWRSZXBvTWV0YShkaXJQYXRoKTtcbiAgICBpZiAoIW1ldGEpIHtcbiAgICAgIHVua25vd24ucHVzaChoYXNoKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBlbnRyeTogUHJvamVjdEVudHJ5ID0geyBoYXNoLCBnaXRSb290OiBtZXRhLmdpdFJvb3QsIHJlbW90ZVVybDogbWV0YS5yZW1vdGVVcmwgfTtcbiAgICBpZiAoZnNFeGlzdHMobWV0YS5naXRSb290KSkge1xuICAgICAgYWN0aXZlLnB1c2goZW50cnkpO1xuICAgIH0gZWxzZSB7XG4gICAgICBvcnBoYW5lZC5wdXNoKGVudHJ5KTtcbiAgICB9XG4gIH1cblxuICBjb25zdCBwbCA9IChuOiBudW1iZXIsIHdvcmQ6IHN0cmluZykgPT4gYCR7bn0gJHt3b3JkfSR7biA9PT0gMSA/IFwiXCIgOiBcInNcIn1gO1xuICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXG4gICAgYCR7cHJvamVjdHNEaXJ9ICAke3BsKGhhc2hMaXN0Lmxlbmd0aCwgXCJwcm9qZWN0IHN0YXRlIGRpcmVjdG9yXCIpfSR7aGFzaExpc3QubGVuZ3RoID09PSAxID8gXCJ5XCIgOiBcImllc1wifWAsXG4gICAgXCJcIixcbiAgXTtcblxuICBpZiAoYWN0aXZlLmxlbmd0aCA+IDApIHtcbiAgICBsaW5lcy5wdXNoKGBBY3RpdmUgKCR7YWN0aXZlLmxlbmd0aH0pIFx1MjAxNCBnaXQgcm9vdCBwcmVzZW50IG9uIGRpc2s6YCk7XG4gICAgZm9yIChjb25zdCBlIG9mIGFjdGl2ZSkge1xuICAgICAgY29uc3QgcmVtb3RlID0gZS5yZW1vdGVVcmwgPyBgICBbJHtlLnJlbW90ZVVybH1dYCA6IFwiXCI7XG4gICAgICBsaW5lcy5wdXNoKGAgICsgJHtlLmhhc2h9ICAke2UuZ2l0Um9vdH0ke3JlbW90ZX1gKTtcbiAgICB9XG4gICAgbGluZXMucHVzaChcIlwiKTtcbiAgfVxuXG4gIGlmIChvcnBoYW5lZC5sZW5ndGggPiAwKSB7XG4gICAgbGluZXMucHVzaChgT3JwaGFuZWQgKCR7b3JwaGFuZWQubGVuZ3RofSkgXHUyMDE0IGdpdCByb290IG5vIGxvbmdlciBleGlzdHM6YCk7XG4gICAgZm9yIChjb25zdCBlIG9mIG9ycGhhbmVkKSB7XG4gICAgICBjb25zdCByZW1vdGUgPSBlLnJlbW90ZVVybCA/IGAgIFske2UucmVtb3RlVXJsfV1gIDogXCJcIjtcbiAgICAgIGxpbmVzLnB1c2goYCAgLSAke2UuaGFzaH0gICR7ZS5naXRSb290fSR7cmVtb3RlfWApO1xuICAgIH1cbiAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICB9XG5cbiAgaWYgKHVua25vd24ubGVuZ3RoID4gMCkge1xuICAgIGxpbmVzLnB1c2goYFVua25vd24gKCR7dW5rbm93bi5sZW5ndGh9KSBcdTIwMTQgbm8gbWV0YWRhdGEgeWV0OmApO1xuICAgIGZvciAoY29uc3QgaCBvZiB1bmtub3duKSB7XG4gICAgICBsaW5lcy5wdXNoKGAgID8gJHtofSAgKG9wZW4gdGhhdCBwcm9qZWN0IGluIEdTRCBvbmNlIHRvIHJlZ2lzdGVyIG1ldGFkYXRhKWApO1xuICAgIH1cbiAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICB9XG5cbiAgaWYgKG9ycGhhbmVkLmxlbmd0aCA9PT0gMCkge1xuICAgIGxpbmVzLnB1c2goXCJObyBvcnBoYW5lZCBwcm9qZWN0IHN0YXRlIFx1MjAxNCBhbGwgdHJhY2tlZCByZXBvcyBhcmUgc3RpbGwgcHJlc2VudCBvbiBkaXNrLlwiKTtcbiAgICBpZiAoIWZpeCkge1xuICAgICAgY3R4LnVpLm5vdGlmeShsaW5lcy5qb2luKFwiXFxuXCIpLCBcInN1Y2Nlc3NcIik7XG4gICAgICByZXR1cm47XG4gICAgfVxuICB9XG5cbiAgaWYgKCFmaXggJiYgb3JwaGFuZWQubGVuZ3RoID4gMCkge1xuICAgIGxpbmVzLnB1c2goYFJ1biAvZ3NkIGNsZWFudXAgcHJvamVjdHMgLS1maXggdG8gcGVybWFuZW50bHkgZGVsZXRlICR7cGwob3JwaGFuZWQubGVuZ3RoLCBcIm9ycGhhbmVkIGRpcmVjdG9yXCIpfSR7b3JwaGFuZWQubGVuZ3RoID09PSAxID8gXCJ5XCIgOiBcImllc1wifS5gKTtcbiAgICBjdHgudWkubm90aWZ5KGxpbmVzLmpvaW4oXCJcXG5cIiksIFwid2FybmluZ1wiKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAoZml4ICYmIG9ycGhhbmVkLmxlbmd0aCA+IDApIHtcbiAgICBsZXQgcmVtb3ZlZCA9IDA7XG4gICAgY29uc3QgZmFpbGVkOiBzdHJpbmdbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgZSBvZiBvcnBoYW5lZCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgZnNSbVN5bmMocGF0aEpvaW4ocHJvamVjdHNEaXIsIGUuaGFzaCksIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICAgICAgcmVtb3ZlZCsrO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGxvZ1dhcm5pbmcoXCJjb21tYW5kXCIsIGBwcm9qZWN0IGNsZWFudXAgcm0gZmFpbGVkIGZvciAke2UuaGFzaH06ICR7KGVyciBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICAgICAgZmFpbGVkLnB1c2goZS5oYXNoKTtcbiAgICAgIH1cbiAgICB9XG4gICAgbGluZXMucHVzaChgUmVtb3ZlZCAke3BsKHJlbW92ZWQsIFwib3JwaGFuZWQgZGlyZWN0b3JcIil9JHtyZW1vdmVkID09PSAxID8gXCJ5XCIgOiBcImllc1wifS5gKTtcbiAgICBpZiAoZmFpbGVkLmxlbmd0aCA+IDApIHtcbiAgICAgIGxpbmVzLnB1c2goYEZhaWxlZCB0byByZW1vdmU6ICR7ZmFpbGVkLmpvaW4oXCIsIFwiKX1gKTtcbiAgICB9XG4gICAgY3R4LnVpLm5vdGlmeShsaW5lcy5qb2luKFwiXFxuXCIpLCByZW1vdmVkID4gMCA/IFwic3VjY2Vzc1wiIDogXCJ3YXJuaW5nXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGN0eC51aS5ub3RpZnkobGluZXMuam9pbihcIlxcblwiKSwgXCJpbmZvXCIpO1xufVxuXG4vKipcbiAqIGBnc2QgcmVjb3ZlcmAgXHUyMDE0IFJlY29uc3RydWN0IERCIGhpZXJhcmNoeSBzdGF0ZSBmcm9tIHJlbmRlcmVkIG1hcmtkb3duIG9uIGRpc2suXG4gKlxuICogRGVsZXRlcyBtaWxlc3RvbmVzLCBzbGljZXMsIGFuZCB0YXNrcyB0YWJsZSByb3dzIChwcmVzZXJ2ZXMgZGVjaXNpb25zLFxuICogcmVxdWlyZW1lbnRzLCBhcnRpZmFjdHMsIG1lbW9yaWVzKSwgcmUtcnVucyBgbWlncmF0ZUhpZXJhcmNoeVRvRGIoKWAgdG9cbiAqIHJlcG9wdWxhdGUgZnJvbSBtYXJrZG93biwgdGhlbiBjYWxscyBgZGVyaXZlU3RhdGUoKWAgdG8gdmVyaWZ5IHNhbml0eS5cbiAqXG4gKiBQcmludHMgY291bnRzIG9mIHJlY292ZXJlZCBpdGVtcyBhbmQgdGhlIHJlc3VsdGluZyBwcm9qZWN0IHBoYXNlLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlUmVjb3ZlcihjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LCBiYXNlUGF0aDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHsgaXNEYkF2YWlsYWJsZTogZGJBdmFpbGFibGUsIGNsZWFyRW5naW5lSGllcmFyY2h5LCB0cmFuc2FjdGlvbjogZGJUcmFuc2FjdGlvbiB9ID0gYXdhaXQgaW1wb3J0KFwiLi9nc2QtZGIuanNcIik7XG4gIGNvbnN0IHsgbWlncmF0ZUhpZXJhcmNoeVRvRGIgfSA9IGF3YWl0IGltcG9ydChcIi4vbWQtaW1wb3J0ZXIuanNcIik7XG4gIGNvbnN0IHsgaW52YWxpZGF0ZVN0YXRlQ2FjaGUgfSA9IGF3YWl0IGltcG9ydChcIi4vc3RhdGUuanNcIik7XG5cbiAgaWYgKCFkYkF2YWlsYWJsZSgpKSB7XG4gICAgY3R4LnVpLm5vdGlmeShcImdzZCByZWNvdmVyOiBObyBkYXRhYmFzZSBvcGVuLiBSdW4gYSBHU0QgY29tbWFuZCBmaXJzdCB0byBpbml0aWFsaXplIHRoZSBEQi5cIiwgXCJlcnJvclwiKTtcbiAgICByZXR1cm47XG4gIH1cblxuICB0cnkge1xuICAgIC8vIDEuIERlbGV0ZSArIHJlLXBvcHVsYXRlIGluc2lkZSBhIHNpbmdsZSB0cmFuc2FjdGlvbiBmb3IgYXRvbWljaXR5LlxuICAgIC8vICAgIGNsZWFyRW5naW5lSGllcmFyY2h5KCkgdXNlcyB0cmFuc2FjdGlvbigpIGludGVybmFsbHkgYnV0IHRyYW5zYWN0aW9uKClcbiAgICAvLyAgICBpcyByZS1lbnRyYW50LCBzbyB3cmFwcGluZyBpbiBkYlRyYW5zYWN0aW9uKCkga2VlcHMgdGhlIHdob2xlXG4gICAgLy8gICAgY2xlYXIrcmVwb3B1bGF0ZSBhdG9taWMuXG4gICAgY29uc3QgY291bnRzID0gZGJUcmFuc2FjdGlvbigoKSA9PiB7XG4gICAgICBjbGVhckVuZ2luZUhpZXJhcmNoeSgpO1xuICAgICAgcmV0dXJuIG1pZ3JhdGVIaWVyYXJjaHlUb0RiKGJhc2VQYXRoKTtcbiAgICB9KTtcblxuICAgIC8vIDMuIEludmFsaWRhdGUgc3RhdGUgY2FjaGUgc28gZGVyaXZlU3RhdGUoKSBwaWNrcyB1cCBmcmVzaCBEQiBkYXRhXG4gICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcblxuICAgIC8vIDQuIERlcml2ZSBzdGF0ZSB0byB2ZXJpZnkgc2FuaXR5XG4gICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlUGF0aCk7XG5cbiAgICAvLyA1LiBSZXBvcnRcbiAgICBjb25zdCBsaW5lcyA9IFtcbiAgICAgIGBnc2QgcmVjb3ZlcjogcmVjb25zdHJ1Y3RlZCBoaWVyYXJjaHkgZnJvbSBtYXJrZG93bmAsXG4gICAgICBgICBNaWxlc3RvbmVzOiAke2NvdW50cy5taWxlc3RvbmVzfWAsXG4gICAgICBgICBTbGljZXM6ICAgICAke2NvdW50cy5zbGljZXN9YCxcbiAgICAgIGAgIFRhc2tzOiAgICAgICR7Y291bnRzLnRhc2tzfWAsXG4gICAgICBgYCxcbiAgICAgIGAgIFBoYXNlOiAgICAgICR7c3RhdGUucGhhc2V9YCxcbiAgICBdO1xuICAgIGlmIChzdGF0ZS5hY3RpdmVNaWxlc3RvbmUpIHtcbiAgICAgIGxpbmVzLnB1c2goYCAgQWN0aXZlOiAgICAgJHtzdGF0ZS5hY3RpdmVNaWxlc3RvbmUuaWR9OiAke3N0YXRlLmFjdGl2ZU1pbGVzdG9uZS50aXRsZX1gKTtcbiAgICB9XG4gICAgaWYgKHN0YXRlLmFjdGl2ZVNsaWNlKSB7XG4gICAgICBsaW5lcy5wdXNoKGAgIFNsaWNlOiAgICAgICR7c3RhdGUuYWN0aXZlU2xpY2UuaWR9OiAke3N0YXRlLmFjdGl2ZVNsaWNlLnRpdGxlfWApO1xuICAgIH1cbiAgICBpZiAoc3RhdGUuYWN0aXZlVGFzaykge1xuICAgICAgbGluZXMucHVzaChgICBUYXNrOiAgICAgICAke3N0YXRlLmFjdGl2ZVRhc2suaWR9OiAke3N0YXRlLmFjdGl2ZVRhc2sudGl0bGV9YCk7XG4gICAgfVxuXG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICBgZ3NkLXJlY292ZXI6IHJlY292ZXJlZCAke2NvdW50cy5taWxlc3RvbmVzfU0vJHtjb3VudHMuc2xpY2VzfVMvJHtjb3VudHMudGFza3N9VCBoaWVyYXJjaHlcXG5gLFxuICAgICk7XG4gICAgY3R4LnVpLm5vdGlmeShsaW5lcy5qb2luKFwiXFxuXCIpLCBcInN1Y2Nlc3NcIik7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGNvbnN0IG1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICBsb2dXYXJuaW5nKFwiY29tbWFuZFwiLCBgcmVjb3ZlciBmYWlsZWQ6ICR7bXNnfWApO1xuICAgIGN0eC51aS5ub3RpZnkoYGdzZCByZWNvdmVyIGZhaWxlZDogJHttc2d9YCwgXCJlcnJvclwiKTtcbiAgfVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBT0EsU0FBUyxtQkFBbUI7QUFDNUIsU0FBUyxrQkFBa0Isd0JBQXdCLHdCQUF3QixvQkFBb0Isa0JBQWtCLHVCQUF1QjtBQUN4SSxTQUFTLGtCQUFrQjtBQUUzQixlQUFzQixzQkFBc0IsS0FBOEIsVUFBaUM7QUFDekcsTUFBSTtBQUNKLE1BQUk7QUFDRixlQUFXLGlCQUFpQixVQUFVLE9BQU87QUFBQSxFQUMvQyxTQUFTLEdBQUc7QUFDVixlQUFXLFdBQVcsdUJBQXdCLEVBQVksT0FBTyxFQUFFO0FBQ25FLFFBQUksR0FBRyxPQUFPLGdDQUFnQyxNQUFNO0FBQ3BEO0FBQUEsRUFDRjtBQUVBLFFBQU0sZ0JBQWdCLFNBQVMsT0FBTyxDQUFDLE1BQU0sRUFBRSxXQUFXLFlBQVksQ0FBQztBQUV2RSxRQUFNLGFBQWEsdUJBQXVCLFFBQVE7QUFDbEQsTUFBSTtBQUNKLE1BQUk7QUFDRixhQUFTLHVCQUF1QixVQUFVLFlBQVksT0FBTztBQUFBLEVBQy9ELFNBQVMsR0FBRztBQUNWLGVBQVcsV0FBVyw4QkFBK0IsRUFBWSxPQUFPLEVBQUU7QUFDMUUsYUFBUyxDQUFDO0FBQUEsRUFDWjtBQUVBLFFBQU0saUJBQWlCLE9BQU8sT0FBTyxDQUFDLE1BQU0sQ0FBQyxFQUFFLFdBQVcsWUFBWSxDQUFDO0FBQ3ZFLE1BQUksZ0JBQWdCO0FBQ3BCLGFBQVcs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
