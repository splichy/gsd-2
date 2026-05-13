import { existsSync } from "node:fs";
import { projectRoot } from "./commands/context.js";
import {
  listWorktrees,
  removeWorktree,
  mergeWorktreeToMain,
  diffWorktreeAll,
  diffWorktreeNumstat,
  worktreeBranchName
} from "./worktree-manager.js";
import {
  nativeHasChanges,
  nativeDetectMainBranch,
  nativeCommitCountBetween
} from "./native-git-bridge.js";
import { inferCommitType } from "./git-service.js";
import { autoCommitCurrentBranch } from "./worktree.js";
import { GSDError, GSD_GIT_ERROR } from "./errors.js";
function getStatus(basePath, name, wtPath) {
  const diff = diffWorktreeAll(basePath, name);
  const numstat = diffWorktreeNumstat(basePath, name);
  const filesChanged = diff.added.length + diff.modified.length + diff.removed.length;
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const s of numstat) {
    linesAdded += s.added;
    linesRemoved += s.removed;
  }
  let uncommitted = false;
  try {
    uncommitted = existsSync(wtPath) && nativeHasChanges(wtPath);
  } catch {
  }
  let commits = 0;
  try {
    const main = nativeDetectMainBranch(basePath);
    commits = nativeCommitCountBetween(basePath, main, worktreeBranchName(name));
  } catch {
  }
  return {
    name,
    path: wtPath,
    branch: worktreeBranchName(name),
    exists: existsSync(wtPath),
    filesChanged,
    linesAdded,
    linesRemoved,
    uncommitted,
    commits
  };
}
function formatWorktreeList(statuses) {
  if (statuses.length === 0) {
    return "No worktrees.\n\nCreate one from the CLI: gsd -w <name>";
  }
  const lines = [`Worktrees \u2014 ${statuses.length}`, ""];
  for (const s of statuses) {
    const badge = s.uncommitted ? "(uncommitted)" : s.filesChanged > 0 ? "(unmerged)" : "(clean)";
    lines.push(`  ${s.name} ${badge}`);
    lines.push(`    branch  ${s.branch}`);
    lines.push(`    path    ${s.path}`);
    if (s.filesChanged > 0) {
      lines.push(
        `    diff    ${s.filesChanged} file${s.filesChanged === 1 ? "" : "s"}, +${s.linesAdded} -${s.linesRemoved}, ${s.commits} commit${s.commits === 1 ? "" : "s"}`
      );
    }
    lines.push("");
  }
  lines.push("Commands:");
  lines.push("  /gsd worktree merge <name>   Merge into main and clean up");
  lines.push("  /gsd worktree remove <name>  Remove a worktree (--force to skip safety checks)");
  lines.push("  /gsd worktree clean          Remove all merged/empty worktrees");
  return lines.join("\n");
}
function formatCleanKeepReason(status) {
  if (!status.exists) {
    return "directory missing \u2014 run 'git worktree prune' to unregister";
  }
  if (status.filesChanged > 0) {
    return `${status.filesChanged} changed file${status.filesChanged === 1 ? "" : "s"}${status.uncommitted ? ", uncommitted" : ""}`;
  }
  return "uncommitted changes";
}
async function handleList(ctx) {
  const basePath = projectRoot();
  const worktrees = listWorktrees(basePath);
  const statuses = worktrees.map((wt) => getStatus(basePath, wt.name, wt.path));
  ctx.ui.notify(formatWorktreeList(statuses), "info");
}
async function handleMerge(args, ctx) {
  const basePath = projectRoot();
  const worktrees = listWorktrees(basePath);
  const trimmed = args.trim();
  let target = trimmed;
  if (!target) {
    if (worktrees.length === 1) {
      target = worktrees[0].name;
    } else if (worktrees.length === 0) {
      ctx.ui.notify("No worktrees to merge.", "info");
      return;
    } else {
      const names = worktrees.map((w) => w.name).join(", ");
      ctx.ui.notify(`Usage: /gsd worktree merge <name>

Worktrees: ${names}`, "warning");
      return;
    }
  }
  const wt = worktrees.find((w) => w.name === target);
  if (!wt) {
    const available = worktrees.map((w) => w.name).join(", ") || "(none)";
    ctx.ui.notify(`Worktree "${target}" not found.

Available: ${available}`, "error");
    return;
  }
  const status = getStatus(basePath, target, wt.path);
  if (status.filesChanged === 0 && !status.uncommitted) {
    try {
      removeWorktree(basePath, target, { deleteBranch: true });
      ctx.ui.notify(`Removed empty worktree ${target}.`, "info");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(
        `Worktree partially removed: ${msg}

Run 'git worktree prune' to clean up any dangling registrations.`,
        "error"
      );
    }
    return;
  }
  if (status.uncommitted) {
    try {
      autoCommitCurrentBranch(wt.path, "worktree-merge", target);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(
        [
          `Auto-commit before merge failed: ${msg}`,
          "",
          `Commit or stash changes in ${wt.path}, then re-run /gsd worktree merge ${target}.`
        ].join("\n"),
        "error"
      );
      return;
    }
  }
  const commitType = inferCommitType(target);
  const mainBranch = nativeDetectMainBranch(basePath);
  const commitMessage = `${commitType}: merge worktree ${target}

GSD-Worktree: ${target}`;
  try {
    mergeWorktreeToMain(basePath, target, commitMessage);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof GSDError && err.code === GSD_GIT_ERROR) {
      ctx.ui.notify(
        `Merge requires the main branch to be checked out: ${msg}

Switch to ${mainBranch} (e.g. 'git checkout ${mainBranch}'), then re-run /gsd worktree merge ${target}.`,
        "error"
      );
    } else {
      ctx.ui.notify(
        `Merge failed: ${msg}

Resolve conflicts manually, then run /gsd worktree merge ${target} again.`,
        "error"
      );
    }
    return;
  }
  const successLines = [
    `Merged ${target} \u2192 ${mainBranch}`,
    `  ${status.filesChanged} file${status.filesChanged === 1 ? "" : "s"}, +${status.linesAdded} -${status.linesRemoved}`,
    `  commit: ${commitMessage.split("\n")[0]}`
  ];
  try {
    removeWorktree(basePath, target, { deleteBranch: true });
    ctx.ui.notify(successLines.join("\n"), "info");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const cleanupLines = [
      ...successLines,
      "",
      `Cleanup failed after the merge succeeded: ${msg}`,
      err instanceof GSDError && err.code === GSD_GIT_ERROR ? `Switch to ${mainBranch} (e.g. 'git checkout ${mainBranch}'), then remove the worktree manually with /gsd worktree remove ${target} --force.` : `Remove the worktree manually with /gsd worktree remove ${target} --force, or run 'git worktree prune' to clean up dangling registrations.`
    ];
    ctx.ui.notify(cleanupLines.join("\n"), "warning");
  }
}
async function handleClean(ctx) {
  const basePath = projectRoot();
  const worktrees = listWorktrees(basePath);
  if (worktrees.length === 0) {
    ctx.ui.notify("No worktrees to clean.", "info");
    return;
  }
  const removed = [];
  const kept = [];
  for (const wt of worktrees) {
    const status = getStatus(basePath, wt.name, wt.path);
    if (status.filesChanged === 0 && !status.uncommitted) {
      try {
        removeWorktree(basePath, wt.name, { deleteBranch: true });
        removed.push(wt.name);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        kept.push(`${wt.name} (failed: ${msg})`);
      }
    } else {
      const reason = formatCleanKeepReason(status);
      kept.push(`${wt.name} (${reason})`);
    }
  }
  const lines = [`Cleaned ${removed.length} worktree${removed.length === 1 ? "" : "s"}.`];
  if (removed.length > 0) {
    lines.push("", "Removed:");
    for (const n of removed) lines.push(`  \u2713 ${n}`);
  }
  if (kept.length > 0) {
    lines.push("", "Kept:");
    for (const n of kept) lines.push(`  \u2500 ${n}`);
  }
  ctx.ui.notify(lines.join("\n"), "info");
}
async function handleRemove(args, ctx) {
  const basePath = projectRoot();
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const force = tokens.includes("--force");
  const name = tokens.find((t) => t !== "--force");
  if (!name) {
    ctx.ui.notify("Usage: /gsd worktree remove <name> [--force]", "warning");
    return;
  }
  const worktrees = listWorktrees(basePath);
  const wt = worktrees.find((w) => w.name === name);
  if (!wt) {
    const available = worktrees.map((w) => w.name).join(", ") || "(none)";
    ctx.ui.notify(`Worktree "${name}" not found.

Available: ${available}`, "error");
    return;
  }
  const status = getStatus(basePath, name, wt.path);
  if ((status.filesChanged > 0 || status.uncommitted) && !force) {
    ctx.ui.notify(
      [
        `Worktree "${name}" has pending changes (${formatCleanKeepReason(status)}).`,
        "",
        `  Merge first:     /gsd worktree merge ${name}`,
        `  Or force-remove: /gsd worktree remove ${name} --force`
      ].join("\n"),
      "warning"
    );
    return;
  }
  try {
    removeWorktree(basePath, name, { deleteBranch: true });
    ctx.ui.notify(`Removed worktree ${name}.`, "info");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(
      `Worktree partially removed: ${msg}

Run 'git worktree prune' to clean up any dangling registrations.`,
      "error"
    );
  }
}
const HELP_TEXT = [
  "Usage: /gsd worktree <command> [args]",
  "",
  "Commands:",
  "  list                       Show all worktrees with status",
  "  merge [name]               Merge a worktree into main, then remove it",
  "  remove <name> [--force]    Remove a worktree (refuses unmerged changes without --force)",
  "  clean                      Remove all merged/empty worktrees",
  "",
  "The -w flag (CLI only) creates/resumes worktrees on session start:",
  "  gsd -w               Auto-name a new worktree, or resume the only active one",
  "  gsd -w my-feature    Create or resume a named worktree"
].join("\n");
async function handleWorktree(args, ctx) {
  const trimmed = args.trim();
  const lowered = trimmed.toLowerCase();
  if (!lowered || lowered === "help" || lowered === "--help" || lowered === "-h") {
    ctx.ui.notify(HELP_TEXT, "info");
    return;
  }
  try {
    if (lowered === "list" || lowered === "ls") {
      await handleList(ctx);
      return;
    }
    if (lowered === "merge" || lowered.startsWith("merge ")) {
      await handleMerge(trimmed.replace(/^merge\s*/i, ""), ctx);
      return;
    }
    if (lowered === "clean") {
      await handleClean(ctx);
      return;
    }
    if (lowered === "remove" || lowered.startsWith("remove ") || lowered === "rm" || lowered.startsWith("rm ")) {
      const stripped = trimmed.replace(/^(remove|rm)\s*/i, "");
      await handleRemove(stripped, ctx);
      return;
    }
    ctx.ui.notify(`Unknown worktree command: ${trimmed}

${HELP_TEXT}`, "warning");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Worktree command failed: ${msg}`, "error");
  }
}
export {
  formatCleanKeepReason,
  formatWorktreeList,
  handleWorktree
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9jb21tYW5kcy13b3JrdHJlZS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NELTIgXHUyMDE0IEluLVRVSSBoYW5kbGVyIGZvciAvZ3NkIHdvcmt0cmVlIGNvbW1hbmRzIChsaXN0LCBtZXJnZSwgY2xlYW4sIHJlbW92ZSkuXG4vL1xuLy8gTWlycm9ycyB0aGUgQ0xJIHN1YmNvbW1hbmRzIGluIHNyYy93b3JrdHJlZS1jbGkudHMgYnV0IGVtaXRzIHJlc3VsdHMgdmlhXG4vLyBjdHgudWkubm90aWZ5KCkgaW5zdGVhZCBvZiB3cml0aW5nIGNvbG9yZWQgb3V0cHV0IHRvIHN0ZGVyci4gUmV1c2VzIHRoZVxuLy8gc2FtZSBleHRlbnNpb24gbW9kdWxlcyAod29ya3RyZWUtbWFuYWdlciwgbmF0aXZlLWdpdC1icmlkZ2UsIGV0Yy4pIHNvIHRoZVxuLy8gYmVoYXZpb3IgaXMgaWRlbnRpY2FsIHRvIHRoZSBDTEkgc3VyZmFjZS5cblxuaW1wb3J0IHR5cGUgeyBFeHRlbnNpb25Db21tYW5kQ29udGV4dCB9IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuaW1wb3J0IHsgZXhpc3RzU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5cbmltcG9ydCB7IHByb2plY3RSb290IH0gZnJvbSBcIi4vY29tbWFuZHMvY29udGV4dC5qc1wiO1xuaW1wb3J0IHtcbiAgbGlzdFdvcmt0cmVlcyxcbiAgcmVtb3ZlV29ya3RyZWUsXG4gIG1lcmdlV29ya3RyZWVUb01haW4sXG4gIGRpZmZXb3JrdHJlZUFsbCxcbiAgZGlmZldvcmt0cmVlTnVtc3RhdCxcbiAgd29ya3RyZWVCcmFuY2hOYW1lLFxufSBmcm9tIFwiLi93b3JrdHJlZS1tYW5hZ2VyLmpzXCI7XG5pbXBvcnQge1xuICBuYXRpdmVIYXNDaGFuZ2VzLFxuICBuYXRpdmVEZXRlY3RNYWluQnJhbmNoLFxuICBuYXRpdmVDb21taXRDb3VudEJldHdlZW4sXG59IGZyb20gXCIuL25hdGl2ZS1naXQtYnJpZGdlLmpzXCI7XG5pbXBvcnQgeyBpbmZlckNvbW1pdFR5cGUgfSBmcm9tIFwiLi9naXQtc2VydmljZS5qc1wiO1xuaW1wb3J0IHsgYXV0b0NvbW1pdEN1cnJlbnRCcmFuY2ggfSBmcm9tIFwiLi93b3JrdHJlZS5qc1wiO1xuaW1wb3J0IHsgR1NERXJyb3IsIEdTRF9HSVRfRVJST1IgfSBmcm9tIFwiLi9lcnJvcnMuanNcIjtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFR5cGVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgaW50ZXJmYWNlIFdvcmt0cmVlU3RhdHVzIHtcbiAgbmFtZTogc3RyaW5nO1xuICBwYXRoOiBzdHJpbmc7XG4gIGJyYW5jaDogc3RyaW5nO1xuICBleGlzdHM6IGJvb2xlYW47XG4gIGZpbGVzQ2hhbmdlZDogbnVtYmVyO1xuICBsaW5lc0FkZGVkOiBudW1iZXI7XG4gIGxpbmVzUmVtb3ZlZDogbnVtYmVyO1xuICB1bmNvbW1pdHRlZDogYm9vbGVhbjtcbiAgY29tbWl0czogbnVtYmVyO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU3RhdHVzIGhlbHBlciBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gZ2V0U3RhdHVzKGJhc2VQYXRoOiBzdHJpbmcsIG5hbWU6IHN0cmluZywgd3RQYXRoOiBzdHJpbmcpOiBXb3JrdHJlZVN0YXR1cyB7XG4gIGNvbnN0IGRpZmYgPSBkaWZmV29ya3RyZWVBbGwoYmFzZVBhdGgsIG5hbWUpO1xuICBjb25zdCBudW1zdGF0ID0gZGlmZldvcmt0cmVlTnVtc3RhdChiYXNlUGF0aCwgbmFtZSk7XG4gIGNvbnN0IGZpbGVzQ2hhbmdlZCA9IGRpZmYuYWRkZWQubGVuZ3RoICsgZGlmZi5tb2RpZmllZC5sZW5ndGggKyBkaWZmLnJlbW92ZWQubGVuZ3RoO1xuICBsZXQgbGluZXNBZGRlZCA9IDA7XG4gIGxldCBsaW5lc1JlbW92ZWQgPSAwO1xuICBmb3IgKGNvbnN0IHMgb2YgbnVtc3RhdCkge1xuICAgIGxpbmVzQWRkZWQgKz0gcy5hZGRlZDtcbiAgICBsaW5lc1JlbW92ZWQgKz0gcy5yZW1vdmVkO1xuICB9XG5cbiAgbGV0IHVuY29tbWl0dGVkID0gZmFsc2U7XG4gIHRyeSB7XG4gICAgdW5jb21taXR0ZWQgPSBleGlzdHNTeW5jKHd0UGF0aCkgJiYgbmF0aXZlSGFzQ2hhbmdlcyh3dFBhdGgpO1xuICB9IGNhdGNoIHtcbiAgICAvLyBuYXRpdmUgY2hlY2sgZmFpbHVyZSBcdTIxOTIgdHJlYXQgYXMgY2xlYW4gZm9yIGRpc3BsYXkgcHVycG9zZXNcbiAgfVxuXG4gIGxldCBjb21taXRzID0gMDtcbiAgdHJ5IHtcbiAgICBjb25zdCBtYWluID0gbmF0aXZlRGV0ZWN0TWFpbkJyYW5jaChiYXNlUGF0aCk7XG4gICAgY29tbWl0cyA9IG5hdGl2ZUNvbW1pdENvdW50QmV0d2VlbihiYXNlUGF0aCwgbWFpbiwgd29ya3RyZWVCcmFuY2hOYW1lKG5hbWUpKTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gY29tbWl0IGNvdW50IHVuYXZhaWxhYmxlIFx1MjE5MiBsZWF2ZSBhdCAwXG4gIH1cblxuICByZXR1cm4ge1xuICAgIG5hbWUsXG4gICAgcGF0aDogd3RQYXRoLFxuICAgIGJyYW5jaDogd29ya3RyZWVCcmFuY2hOYW1lKG5hbWUpLFxuICAgIGV4aXN0czogZXhpc3RzU3luYyh3dFBhdGgpLFxuICAgIGZpbGVzQ2hhbmdlZCxcbiAgICBsaW5lc0FkZGVkLFxuICAgIGxpbmVzUmVtb3ZlZCxcbiAgICB1bmNvbW1pdHRlZCxcbiAgICBjb21taXRzLFxuICB9O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRm9ybWF0dGVycyAoZXhwb3J0ZWQgZm9yIHRlc3RzKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdFdvcmt0cmVlTGlzdChzdGF0dXNlczogV29ya3RyZWVTdGF0dXNbXSk6IHN0cmluZyB7XG4gIGlmIChzdGF0dXNlcy5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm4gXCJObyB3b3JrdHJlZXMuXFxuXFxuQ3JlYXRlIG9uZSBmcm9tIHRoZSBDTEk6IGdzZCAtdyA8bmFtZT5cIjtcbiAgfVxuXG4gIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtgV29ya3RyZWVzIFx1MjAxNCAke3N0YXR1c2VzLmxlbmd0aH1gLCBcIlwiXTtcbiAgZm9yIChjb25zdCBzIG9mIHN0YXR1c2VzKSB7XG4gICAgY29uc3QgYmFkZ2UgPSBzLnVuY29tbWl0dGVkXG4gICAgICA/IFwiKHVuY29tbWl0dGVkKVwiXG4gICAgICA6IHMuZmlsZXNDaGFuZ2VkID4gMFxuICAgICAgICA/IFwiKHVubWVyZ2VkKVwiXG4gICAgICAgIDogXCIoY2xlYW4pXCI7XG4gICAgbGluZXMucHVzaChgICAke3MubmFtZX0gJHtiYWRnZX1gKTtcbiAgICBsaW5lcy5wdXNoKGAgICAgYnJhbmNoICAke3MuYnJhbmNofWApO1xuICAgIGxpbmVzLnB1c2goYCAgICBwYXRoICAgICR7cy5wYXRofWApO1xuICAgIGlmIChzLmZpbGVzQ2hhbmdlZCA+IDApIHtcbiAgICAgIGxpbmVzLnB1c2goXG4gICAgICAgIGAgICAgZGlmZiAgICAke3MuZmlsZXNDaGFuZ2VkfSBmaWxlJHtzLmZpbGVzQ2hhbmdlZCA9PT0gMSA/IFwiXCIgOiBcInNcIn0sICske3MubGluZXNBZGRlZH0gLSR7cy5saW5lc1JlbW92ZWR9LCAke3MuY29tbWl0c30gY29tbWl0JHtzLmNvbW1pdHMgPT09IDEgPyBcIlwiIDogXCJzXCJ9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIGxpbmVzLnB1c2goXCJcIik7XG4gIH1cbiAgbGluZXMucHVzaChcIkNvbW1hbmRzOlwiKTtcbiAgbGluZXMucHVzaChcIiAgL2dzZCB3b3JrdHJlZSBtZXJnZSA8bmFtZT4gICBNZXJnZSBpbnRvIG1haW4gYW5kIGNsZWFuIHVwXCIpO1xuICBsaW5lcy5wdXNoKFwiICAvZ3NkIHdvcmt0cmVlIHJlbW92ZSA8bmFtZT4gIFJlbW92ZSBhIHdvcmt0cmVlICgtLWZvcmNlIHRvIHNraXAgc2FmZXR5IGNoZWNrcylcIik7XG4gIGxpbmVzLnB1c2goXCIgIC9nc2Qgd29ya3RyZWUgY2xlYW4gICAgICAgICAgUmVtb3ZlIGFsbCBtZXJnZWQvZW1wdHkgd29ya3RyZWVzXCIpO1xuICByZXR1cm4gbGluZXMuam9pbihcIlxcblwiKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdENsZWFuS2VlcFJlYXNvbihzdGF0dXM6IFdvcmt0cmVlU3RhdHVzKTogc3RyaW5nIHtcbiAgaWYgKCFzdGF0dXMuZXhpc3RzKSB7XG4gICAgcmV0dXJuIFwiZGlyZWN0b3J5IG1pc3NpbmcgXHUyMDE0IHJ1biAnZ2l0IHdvcmt0cmVlIHBydW5lJyB0byB1bnJlZ2lzdGVyXCI7XG4gIH1cblxuICBpZiAoc3RhdHVzLmZpbGVzQ2hhbmdlZCA+IDApIHtcbiAgICByZXR1cm4gYCR7c3RhdHVzLmZpbGVzQ2hhbmdlZH0gY2hhbmdlZCBmaWxlJHtzdGF0dXMuZmlsZXNDaGFuZ2VkID09PSAxID8gXCJcIiA6IFwic1wifSR7c3RhdHVzLnVuY29tbWl0dGVkID8gXCIsIHVuY29tbWl0dGVkXCIgOiBcIlwifWA7XG4gIH1cblxuICByZXR1cm4gXCJ1bmNvbW1pdHRlZCBjaGFuZ2VzXCI7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTdWJjb21tYW5kOiBsaXN0IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVMaXN0KGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgYmFzZVBhdGggPSBwcm9qZWN0Um9vdCgpO1xuICBjb25zdCB3b3JrdHJlZXMgPSBsaXN0V29ya3RyZWVzKGJhc2VQYXRoKTtcbiAgY29uc3Qgc3RhdHVzZXMgPSB3b3JrdHJlZXMubWFwKCh3dCkgPT4gZ2V0U3RhdHVzKGJhc2VQYXRoLCB3dC5uYW1lLCB3dC5wYXRoKSk7XG4gIGN0eC51aS5ub3RpZnkoZm9ybWF0V29ya3RyZWVMaXN0KHN0YXR1c2VzKSwgXCJpbmZvXCIpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU3ViY29tbWFuZDogbWVyZ2UgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZU1lcmdlKGFyZ3M6IHN0cmluZywgY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBiYXNlUGF0aCA9IHByb2plY3RSb290KCk7XG4gIGNvbnN0IHdvcmt0cmVlcyA9IGxpc3RXb3JrdHJlZXMoYmFzZVBhdGgpO1xuICBjb25zdCB0cmltbWVkID0gYXJncy50cmltKCk7XG5cbiAgbGV0IHRhcmdldCA9IHRyaW1tZWQ7XG4gIGlmICghdGFyZ2V0KSB7XG4gICAgaWYgKHdvcmt0cmVlcy5sZW5ndGggPT09IDEpIHtcbiAgICAgIHRhcmdldCA9IHdvcmt0cmVlc1swXS5uYW1lO1xuICAgIH0gZWxzZSBpZiAod29ya3RyZWVzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgY3R4LnVpLm5vdGlmeShcIk5vIHdvcmt0cmVlcyB0byBtZXJnZS5cIiwgXCJpbmZvXCIpO1xuICAgICAgcmV0dXJuO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBuYW1lcyA9IHdvcmt0cmVlcy5tYXAoKHcpID0+IHcubmFtZSkuam9pbihcIiwgXCIpO1xuICAgICAgY3R4LnVpLm5vdGlmeShgVXNhZ2U6IC9nc2Qgd29ya3RyZWUgbWVyZ2UgPG5hbWU+XFxuXFxuV29ya3RyZWVzOiAke25hbWVzfWAsIFwid2FybmluZ1wiKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gIH1cblxuICBjb25zdCB3dCA9IHdvcmt0cmVlcy5maW5kKCh3KSA9PiB3Lm5hbWUgPT09IHRhcmdldCk7XG4gIGlmICghd3QpIHtcbiAgICBjb25zdCBhdmFpbGFibGUgPSB3b3JrdHJlZXMubWFwKCh3KSA9PiB3Lm5hbWUpLmpvaW4oXCIsIFwiKSB8fCBcIihub25lKVwiO1xuICAgIGN0eC51aS5ub3RpZnkoYFdvcmt0cmVlIFwiJHt0YXJnZXR9XCIgbm90IGZvdW5kLlxcblxcbkF2YWlsYWJsZTogJHthdmFpbGFibGV9YCwgXCJlcnJvclwiKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBzdGF0dXMgPSBnZXRTdGF0dXMoYmFzZVBhdGgsIHRhcmdldCwgd3QucGF0aCk7XG4gIGlmIChzdGF0dXMuZmlsZXNDaGFuZ2VkID09PSAwICYmICFzdGF0dXMudW5jb21taXR0ZWQpIHtcbiAgICB0cnkge1xuICAgICAgcmVtb3ZlV29ya3RyZWUoYmFzZVBhdGgsIHRhcmdldCwgeyBkZWxldGVCcmFuY2g6IHRydWUgfSk7XG4gICAgICBjdHgudWkubm90aWZ5KGBSZW1vdmVkIGVtcHR5IHdvcmt0cmVlICR7dGFyZ2V0fS5gLCBcImluZm9cIik7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBjb25zdCBtc2cgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICBgV29ya3RyZWUgcGFydGlhbGx5IHJlbW92ZWQ6ICR7bXNnfVxcblxcblJ1biAnZ2l0IHdvcmt0cmVlIHBydW5lJyB0byBjbGVhbiB1cCBhbnkgZGFuZ2xpbmcgcmVnaXN0cmF0aW9ucy5gLFxuICAgICAgICBcImVycm9yXCIsXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAoc3RhdHVzLnVuY29tbWl0dGVkKSB7XG4gICAgdHJ5IHtcbiAgICAgIGF1dG9Db21taXRDdXJyZW50QnJhbmNoKHd0LnBhdGgsIFwid29ya3RyZWUtbWVyZ2VcIiwgdGFyZ2V0KTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGNvbnN0IG1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgIFtcbiAgICAgICAgICBgQXV0by1jb21taXQgYmVmb3JlIG1lcmdlIGZhaWxlZDogJHttc2d9YCxcbiAgICAgICAgICBcIlwiLFxuICAgICAgICAgIGBDb21taXQgb3Igc3Rhc2ggY2hhbmdlcyBpbiAke3d0LnBhdGh9LCB0aGVuIHJlLXJ1biAvZ3NkIHdvcmt0cmVlIG1lcmdlICR7dGFyZ2V0fS5gLFxuICAgICAgICBdLmpvaW4oXCJcXG5cIiksXG4gICAgICAgIFwiZXJyb3JcIixcbiAgICAgICk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICB9XG5cbiAgY29uc3QgY29tbWl0VHlwZSA9IGluZmVyQ29tbWl0VHlwZSh0YXJnZXQpO1xuICBjb25zdCBtYWluQnJhbmNoID0gbmF0aXZlRGV0ZWN0TWFpbkJyYW5jaChiYXNlUGF0aCk7XG4gIGNvbnN0IGNvbW1pdE1lc3NhZ2UgPSBgJHtjb21taXRUeXBlfTogbWVyZ2Ugd29ya3RyZWUgJHt0YXJnZXR9XFxuXFxuR1NELVdvcmt0cmVlOiAke3RhcmdldH1gO1xuXG4gIHRyeSB7XG4gICAgbWVyZ2VXb3JrdHJlZVRvTWFpbihiYXNlUGF0aCwgdGFyZ2V0LCBjb21taXRNZXNzYWdlKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY29uc3QgbXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICAgIGlmIChlcnIgaW5zdGFuY2VvZiBHU0RFcnJvciAmJiBlcnIuY29kZSA9PT0gR1NEX0dJVF9FUlJPUikge1xuICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgYE1lcmdlIHJlcXVpcmVzIHRoZSBtYWluIGJyYW5jaCB0byBiZSBjaGVja2VkIG91dDogJHttc2d9XFxuXFxuU3dpdGNoIHRvICR7bWFpbkJyYW5jaH0gKGUuZy4gJ2dpdCBjaGVja291dCAke21haW5CcmFuY2h9JyksIHRoZW4gcmUtcnVuIC9nc2Qgd29ya3RyZWUgbWVyZ2UgJHt0YXJnZXR9LmAsXG4gICAgICAgIFwiZXJyb3JcIixcbiAgICAgICk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgIGBNZXJnZSBmYWlsZWQ6ICR7bXNnfVxcblxcblJlc29sdmUgY29uZmxpY3RzIG1hbnVhbGx5LCB0aGVuIHJ1biAvZ3NkIHdvcmt0cmVlIG1lcmdlICR7dGFyZ2V0fSBhZ2Fpbi5gLFxuICAgICAgICBcImVycm9yXCIsXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBzdWNjZXNzTGluZXMgPSBbXG4gICAgYE1lcmdlZCAke3RhcmdldH0gXHUyMTkyICR7bWFpbkJyYW5jaH1gLFxuICAgIGAgICR7c3RhdHVzLmZpbGVzQ2hhbmdlZH0gZmlsZSR7c3RhdHVzLmZpbGVzQ2hhbmdlZCA9PT0gMSA/IFwiXCIgOiBcInNcIn0sICske3N0YXR1cy5saW5lc0FkZGVkfSAtJHtzdGF0dXMubGluZXNSZW1vdmVkfWAsXG4gICAgYCAgY29tbWl0OiAke2NvbW1pdE1lc3NhZ2Uuc3BsaXQoXCJcXG5cIilbMF19YCxcbiAgXTtcblxuICB0cnkge1xuICAgIHJlbW92ZVdvcmt0cmVlKGJhc2VQYXRoLCB0YXJnZXQsIHsgZGVsZXRlQnJhbmNoOiB0cnVlIH0pO1xuICAgIGN0eC51aS5ub3RpZnkoc3VjY2Vzc0xpbmVzLmpvaW4oXCJcXG5cIiksIFwiaW5mb1wiKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY29uc3QgbXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICAgIGNvbnN0IGNsZWFudXBMaW5lcyA9IFtcbiAgICAgIC4uLnN1Y2Nlc3NMaW5lcyxcbiAgICAgIFwiXCIsXG4gICAgICBgQ2xlYW51cCBmYWlsZWQgYWZ0ZXIgdGhlIG1lcmdlIHN1Y2NlZWRlZDogJHttc2d9YCxcbiAgICAgIGVyciBpbnN0YW5jZW9mIEdTREVycm9yICYmIGVyci5jb2RlID09PSBHU0RfR0lUX0VSUk9SXG4gICAgICAgID8gYFN3aXRjaCB0byAke21haW5CcmFuY2h9IChlLmcuICdnaXQgY2hlY2tvdXQgJHttYWluQnJhbmNofScpLCB0aGVuIHJlbW92ZSB0aGUgd29ya3RyZWUgbWFudWFsbHkgd2l0aCAvZ3NkIHdvcmt0cmVlIHJlbW92ZSAke3RhcmdldH0gLS1mb3JjZS5gXG4gICAgICAgIDogYFJlbW92ZSB0aGUgd29ya3RyZWUgbWFudWFsbHkgd2l0aCAvZ3NkIHdvcmt0cmVlIHJlbW92ZSAke3RhcmdldH0gLS1mb3JjZSwgb3IgcnVuICdnaXQgd29ya3RyZWUgcHJ1bmUnIHRvIGNsZWFuIHVwIGRhbmdsaW5nIHJlZ2lzdHJhdGlvbnMuYCxcbiAgICBdO1xuICAgIGN0eC51aS5ub3RpZnkoY2xlYW51cExpbmVzLmpvaW4oXCJcXG5cIiksIFwid2FybmluZ1wiKTtcbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU3ViY29tbWFuZDogY2xlYW4gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZUNsZWFuKGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgYmFzZVBhdGggPSBwcm9qZWN0Um9vdCgpO1xuICBjb25zdCB3b3JrdHJlZXMgPSBsaXN0V29ya3RyZWVzKGJhc2VQYXRoKTtcbiAgaWYgKHdvcmt0cmVlcy5sZW5ndGggPT09IDApIHtcbiAgICBjdHgudWkubm90aWZ5KFwiTm8gd29ya3RyZWVzIHRvIGNsZWFuLlwiLCBcImluZm9cIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgcmVtb3ZlZDogc3RyaW5nW10gPSBbXTtcbiAgY29uc3Qga2VwdDogc3RyaW5nW10gPSBbXTtcbiAgZm9yIChjb25zdCB3dCBvZiB3b3JrdHJlZXMpIHtcbiAgICBjb25zdCBzdGF0dXMgPSBnZXRTdGF0dXMoYmFzZVBhdGgsIHd0Lm5hbWUsIHd0LnBhdGgpO1xuICAgIGlmIChzdGF0dXMuZmlsZXNDaGFuZ2VkID09PSAwICYmICFzdGF0dXMudW5jb21taXR0ZWQpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHJlbW92ZVdvcmt0cmVlKGJhc2VQYXRoLCB3dC5uYW1lLCB7IGRlbGV0ZUJyYW5jaDogdHJ1ZSB9KTtcbiAgICAgICAgcmVtb3ZlZC5wdXNoKHd0Lm5hbWUpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGNvbnN0IG1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICAgICAga2VwdC5wdXNoKGAke3d0Lm5hbWV9IChmYWlsZWQ6ICR7bXNnfSlgKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgcmVhc29uID0gZm9ybWF0Q2xlYW5LZWVwUmVhc29uKHN0YXR1cyk7XG4gICAgICBrZXB0LnB1c2goYCR7d3QubmFtZX0gKCR7cmVhc29ufSlgKTtcbiAgICB9XG4gIH1cblxuICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbYENsZWFuZWQgJHtyZW1vdmVkLmxlbmd0aH0gd29ya3RyZWUke3JlbW92ZWQubGVuZ3RoID09PSAxID8gXCJcIiA6IFwic1wifS5gXTtcbiAgaWYgKHJlbW92ZWQubGVuZ3RoID4gMCkge1xuICAgIGxpbmVzLnB1c2goXCJcIiwgXCJSZW1vdmVkOlwiKTtcbiAgICBmb3IgKGNvbnN0IG4gb2YgcmVtb3ZlZCkgbGluZXMucHVzaChgICBcdTI3MTMgJHtufWApO1xuICB9XG4gIGlmIChrZXB0Lmxlbmd0aCA+IDApIHtcbiAgICBsaW5lcy5wdXNoKFwiXCIsIFwiS2VwdDpcIik7XG4gICAgZm9yIChjb25zdCBuIG9mIGtlcHQpIGxpbmVzLnB1c2goYCAgXHUyNTAwICR7bn1gKTtcbiAgfVxuICBjdHgudWkubm90aWZ5KGxpbmVzLmpvaW4oXCJcXG5cIiksIFwiaW5mb1wiKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFN1YmNvbW1hbmQ6IHJlbW92ZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuYXN5bmMgZnVuY3Rpb24gaGFuZGxlUmVtb3ZlKGFyZ3M6IHN0cmluZywgY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBiYXNlUGF0aCA9IHByb2plY3RSb290KCk7XG4gIGNvbnN0IHRva2VucyA9IGFyZ3MudHJpbSgpLnNwbGl0KC9cXHMrLykuZmlsdGVyKEJvb2xlYW4pO1xuICBjb25zdCBmb3JjZSA9IHRva2Vucy5pbmNsdWRlcyhcIi0tZm9yY2VcIik7XG4gIGNvbnN0IG5hbWUgPSB0b2tlbnMuZmluZCgodCkgPT4gdCAhPT0gXCItLWZvcmNlXCIpO1xuICBpZiAoIW5hbWUpIHtcbiAgICBjdHgudWkubm90aWZ5KFwiVXNhZ2U6IC9nc2Qgd29ya3RyZWUgcmVtb3ZlIDxuYW1lPiBbLS1mb3JjZV1cIiwgXCJ3YXJuaW5nXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHdvcmt0cmVlcyA9IGxpc3RXb3JrdHJlZXMoYmFzZVBhdGgpO1xuICBjb25zdCB3dCA9IHdvcmt0cmVlcy5maW5kKCh3KSA9PiB3Lm5hbWUgPT09IG5hbWUpO1xuICBpZiAoIXd0KSB7XG4gICAgY29uc3QgYXZhaWxhYmxlID0gd29ya3RyZWVzLm1hcCgodykgPT4gdy5uYW1lKS5qb2luKFwiLCBcIikgfHwgXCIobm9uZSlcIjtcbiAgICBjdHgudWkubm90aWZ5KGBXb3JrdHJlZSBcIiR7bmFtZX1cIiBub3QgZm91bmQuXFxuXFxuQXZhaWxhYmxlOiAke2F2YWlsYWJsZX1gLCBcImVycm9yXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHN0YXR1cyA9IGdldFN0YXR1cyhiYXNlUGF0aCwgbmFtZSwgd3QucGF0aCk7XG4gIGlmICgoc3RhdHVzLmZpbGVzQ2hhbmdlZCA+IDAgfHwgc3RhdHVzLnVuY29tbWl0dGVkKSAmJiAhZm9yY2UpIHtcbiAgICBjdHgudWkubm90aWZ5KFxuICAgICAgW1xuICAgICAgICBgV29ya3RyZWUgXCIke25hbWV9XCIgaGFzIHBlbmRpbmcgY2hhbmdlcyAoJHtmb3JtYXRDbGVhbktlZXBSZWFzb24oc3RhdHVzKX0pLmAsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIGAgIE1lcmdlIGZpcnN0OiAgICAgL2dzZCB3b3JrdHJlZSBtZXJnZSAke25hbWV9YCxcbiAgICAgICAgYCAgT3IgZm9yY2UtcmVtb3ZlOiAvZ3NkIHdvcmt0cmVlIHJlbW92ZSAke25hbWV9IC0tZm9yY2VgLFxuICAgICAgXS5qb2luKFwiXFxuXCIpLFxuICAgICAgXCJ3YXJuaW5nXCIsXG4gICAgKTtcbiAgICByZXR1cm47XG4gIH1cblxuICB0cnkge1xuICAgIHJlbW92ZVdvcmt0cmVlKGJhc2VQYXRoLCBuYW1lLCB7IGRlbGV0ZUJyYW5jaDogdHJ1ZSB9KTtcbiAgICBjdHgudWkubm90aWZ5KGBSZW1vdmVkIHdvcmt0cmVlICR7bmFtZX0uYCwgXCJpbmZvXCIpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBjb25zdCBtc2cgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgY3R4LnVpLm5vdGlmeShcbiAgICAgIGBXb3JrdHJlZSBwYXJ0aWFsbHkgcmVtb3ZlZDogJHttc2d9XFxuXFxuUnVuICdnaXQgd29ya3RyZWUgcHJ1bmUnIHRvIGNsZWFuIHVwIGFueSBkYW5nbGluZyByZWdpc3RyYXRpb25zLmAsXG4gICAgICBcImVycm9yXCIsXG4gICAgKTtcbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgSGVscCB0ZXh0IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5jb25zdCBIRUxQX1RFWFQgPSBbXG4gIFwiVXNhZ2U6IC9nc2Qgd29ya3RyZWUgPGNvbW1hbmQ+IFthcmdzXVwiLFxuICBcIlwiLFxuICBcIkNvbW1hbmRzOlwiLFxuICBcIiAgbGlzdCAgICAgICAgICAgICAgICAgICAgICAgU2hvdyBhbGwgd29ya3RyZWVzIHdpdGggc3RhdHVzXCIsXG4gIFwiICBtZXJnZSBbbmFtZV0gICAgICAgICAgICAgICBNZXJnZSBhIHdvcmt0cmVlIGludG8gbWFpbiwgdGhlbiByZW1vdmUgaXRcIixcbiAgXCIgIHJlbW92ZSA8bmFtZT4gWy0tZm9yY2VdICAgIFJlbW92ZSBhIHdvcmt0cmVlIChyZWZ1c2VzIHVubWVyZ2VkIGNoYW5nZXMgd2l0aG91dCAtLWZvcmNlKVwiLFxuICBcIiAgY2xlYW4gICAgICAgICAgICAgICAgICAgICAgUmVtb3ZlIGFsbCBtZXJnZWQvZW1wdHkgd29ya3RyZWVzXCIsXG4gIFwiXCIsXG4gIFwiVGhlIC13IGZsYWcgKENMSSBvbmx5KSBjcmVhdGVzL3Jlc3VtZXMgd29ya3RyZWVzIG9uIHNlc3Npb24gc3RhcnQ6XCIsXG4gIFwiICBnc2QgLXcgICAgICAgICAgICAgICBBdXRvLW5hbWUgYSBuZXcgd29ya3RyZWUsIG9yIHJlc3VtZSB0aGUgb25seSBhY3RpdmUgb25lXCIsXG4gIFwiICBnc2QgLXcgbXktZmVhdHVyZSAgICBDcmVhdGUgb3IgcmVzdW1lIGEgbmFtZWQgd29ya3RyZWVcIixcbl0uam9pbihcIlxcblwiKTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIERpc3BhdGNoZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBoYW5kbGVXb3JrdHJlZShhcmdzOiBzdHJpbmcsIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgdHJpbW1lZCA9IGFyZ3MudHJpbSgpO1xuICBjb25zdCBsb3dlcmVkID0gdHJpbW1lZC50b0xvd2VyQ2FzZSgpO1xuXG4gIGlmICghbG93ZXJlZCB8fCBsb3dlcmVkID09PSBcImhlbHBcIiB8fCBsb3dlcmVkID09PSBcIi0taGVscFwiIHx8IGxvd2VyZWQgPT09IFwiLWhcIikge1xuICAgIGN0eC51aS5ub3RpZnkoSEVMUF9URVhULCBcImluZm9cIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgdHJ5IHtcbiAgICBpZiAobG93ZXJlZCA9PT0gXCJsaXN0XCIgfHwgbG93ZXJlZCA9PT0gXCJsc1wiKSB7XG4gICAgICBhd2FpdCBoYW5kbGVMaXN0KGN0eCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChsb3dlcmVkID09PSBcIm1lcmdlXCIgfHwgbG93ZXJlZC5zdGFydHNXaXRoKFwibWVyZ2UgXCIpKSB7XG4gICAgICBhd2FpdCBoYW5kbGVNZXJnZSh0cmltbWVkLnJlcGxhY2UoL15tZXJnZVxccyovaSwgXCJcIiksIGN0eCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChsb3dlcmVkID09PSBcImNsZWFuXCIpIHtcbiAgICAgIGF3YWl0IGhhbmRsZUNsZWFuKGN0eCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChcbiAgICAgIGxvd2VyZWQgPT09IFwicmVtb3ZlXCIgfHxcbiAgICAgIGxvd2VyZWQuc3RhcnRzV2l0aChcInJlbW92ZSBcIikgfHxcbiAgICAgIGxvd2VyZWQgPT09IFwicm1cIiB8fFxuICAgICAgbG93ZXJlZC5zdGFydHNXaXRoKFwicm0gXCIpXG4gICAgKSB7XG4gICAgICBjb25zdCBzdHJpcHBlZCA9IHRyaW1tZWQucmVwbGFjZSgvXihyZW1vdmV8cm0pXFxzKi9pLCBcIlwiKTtcbiAgICAgIGF3YWl0IGhhbmRsZVJlbW92ZShzdHJpcHBlZCwgY3R4KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjdHgudWkubm90aWZ5KGBVbmtub3duIHdvcmt0cmVlIGNvbW1hbmQ6ICR7dHJpbW1lZH1cXG5cXG4ke0hFTFBfVEVYVH1gLCBcIndhcm5pbmdcIik7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGNvbnN0IG1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICBjdHgudWkubm90aWZ5KGBXb3JrdHJlZSBjb21tYW5kIGZhaWxlZDogJHttc2d9YCwgXCJlcnJvclwiKTtcbiAgfVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBUUEsU0FBUyxrQkFBa0I7QUFFM0IsU0FBUyxtQkFBbUI7QUFDNUI7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1A7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1AsU0FBUyx1QkFBdUI7QUFDaEMsU0FBUywrQkFBK0I7QUFDeEMsU0FBUyxVQUFVLHFCQUFxQjtBQWtCeEMsU0FBUyxVQUFVLFVBQWtCLE1BQWMsUUFBZ0M7QUFDakYsUUFBTSxPQUFPLGdCQUFnQixVQUFVLElBQUk7QUFDM0MsUUFBTSxVQUFVLG9CQUFvQixVQUFVLElBQUk7QUFDbEQsUUFBTSxlQUFlLEtBQUssTUFBTSxTQUFTLEtBQUssU0FBUyxTQUFTLEtBQUssUUFBUTtBQUM3RSxNQUFJLGFBQWE7QUFDakIsTUFBSSxlQUFlO0FBQ25CLGFBQVcsS0FBSyxTQUFTO0FBQ3ZCLGtCQUFjLEVBQUU7QUFDaEIsb0JBQWdCLEVBQUU7QUFBQSxFQUNwQjtBQUVBLE1BQUksY0FBYztBQUNsQixNQUFJO0FBQ0Ysa0JBQWMsV0FBVyxNQUFNLEtBQUssaUJBQWlCLE1BQU07QUFBQSxFQUM3RCxRQUFRO0FBQUEsRUFFUjtBQUVBLE1BQUksVUFBVTtBQUNkLE1BQUk7QUFDRixVQUFNLE9BQU8sdUJBQXVCLFFBQVE7QUFDNUMsY0FBVSx5QkFBeUIsVUFBVSxNQUFNLG1CQUFtQixJQUFJLENBQUM7QUFBQSxFQUM3RSxRQUFRO0FBQUEsRUFFUjtBQUVBLFNBQU87QUFBQSxJQUNMO0FBQUEsSUFDQSxNQUFNO0FBQUEsSUFDTixRQUFRLG1CQUFtQixJQUFJO0FBQUEsSUFDL0IsUUFBUSxXQUFXLE1BQU07QUFBQSxJQUN6QjtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEs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
