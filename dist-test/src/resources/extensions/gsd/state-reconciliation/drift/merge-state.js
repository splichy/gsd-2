import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { getErrorMessage } from "../../error-utils.js";
import {
  nativeAddPaths,
  nativeCheckoutTheirs,
  nativeCommit,
  nativeConflictFiles,
  nativeMergeAbort,
  nativeRebaseAbort,
  nativeResetHard
} from "../../native-git-bridge.js";
import { logError, logWarning } from "../../workflow-logger.js";
import { isGsdWorktreePath } from "../../worktree-root.js";
const SILENT_NOTIFY = () => {
};
function resolveGitDir(basePath) {
  try {
    const gitDir = execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8"
    }).trim();
    if (gitDir.length > 0) {
      return isAbsolute(gitDir) ? gitDir : resolve(basePath, gitDir);
    }
  } catch (err) {
    const message = getErrorMessage(err);
    logWarning("recovery", `gitdir resolution failed: ${message}`);
    if (isGsdWorktreePath(basePath)) {
      throw new Error(
        `Worktree integrity failure: ${basePath} is not a valid git worktree (git rev-parse failed: ${message.split("\n")[0]}). Repair or recreate the worktree before retrying.`
      );
    }
  }
  return join(basePath, ".git");
}
function abortAndResetMerge(basePath, hasMergeHead, squashMsgPath) {
  if (hasMergeHead) {
    try {
      nativeMergeAbort(basePath);
    } catch (err) {
      logWarning(
        "recovery",
        `git merge-abort failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else if (squashMsgPath) {
    try {
      unlinkSync(squashMsgPath);
    } catch (err) {
      logWarning(
        "recovery",
        `file unlink failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  try {
    nativeResetHard(basePath);
  } catch (err) {
    logError(
      "recovery",
      `git reset failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
function reconcileOtherInProgressGitOps(basePath, notify) {
  const gitDir = resolveGitDir(basePath);
  const states = [
    {
      label: "rebase",
      indicators: [join(gitDir, "rebase-merge"), join(gitDir, "rebase-apply")],
      abort: () => nativeRebaseAbort(basePath)
    },
    {
      label: "cherry-pick",
      indicators: [join(gitDir, "CHERRY_PICK_HEAD")],
      abort: () => {
        try {
          execFileSync("git", ["cherry-pick", "--abort"], {
            cwd: basePath,
            stdio: ["ignore", "pipe", "pipe"],
            encoding: "utf-8"
          });
        } catch (err) {
          throw new Error(`cherry-pick --abort failed: ${getErrorMessage(err)}`);
        }
      }
    },
    {
      label: "revert",
      indicators: [join(gitDir, "REVERT_HEAD")],
      abort: () => {
        try {
          execFileSync("git", ["revert", "--abort"], {
            cwd: basePath,
            stdio: ["ignore", "pipe", "pipe"],
            encoding: "utf-8"
          });
        } catch (err) {
          throw new Error(`revert --abort failed: ${getErrorMessage(err)}`);
        }
      }
    }
  ];
  let reconciled = false;
  for (const s of states) {
    const present = s.indicators.some((p) => existsSync(p));
    if (!present) continue;
    try {
      s.abort();
      notify(
        `Detected leftover ${s.label} state from prior session \u2014 aborted.`,
        "warning"
      );
      reconciled = true;
    } catch (err) {
      logError("recovery", `${s.label} abort failed: ${getErrorMessage(err)}`);
      notify(
        `Detected leftover ${s.label} state but auto-abort failed. Run \`git ${s.label} --abort\` manually before retrying.`,
        "error"
      );
      return "blocked";
    }
  }
  return reconciled ? "reconciled" : "clean";
}
function reconcileMergeStateCore(basePath, notify) {
  const otherOpsResult = reconcileOtherInProgressGitOps(basePath, notify);
  if (otherOpsResult === "blocked") return "blocked";
  const gitDir = resolveGitDir(basePath);
  const mergeHeadPath = join(gitDir, "MERGE_HEAD");
  const squashMsgPath = join(gitDir, "SQUASH_MSG");
  const hasMergeHead = existsSync(mergeHeadPath);
  const hasSquashMsg = existsSync(squashMsgPath);
  if (!hasMergeHead && !hasSquashMsg) {
    return otherOpsResult === "reconciled" ? "reconciled" : "clean";
  }
  const conflictedFiles = nativeConflictFiles(basePath);
  if (conflictedFiles.length === 0) {
    try {
      const commitSha = nativeCommit(basePath, "chore(gsd): reconcile merge state");
      if (commitSha) {
        const mode = hasMergeHead ? "merge" : "squash commit";
        notify(`Finalized leftover ${mode} from prior session.`, "info");
      } else {
        notify(
          "No new commit needed for leftover merge/squash state \u2014 already committed.",
          "info"
        );
      }
    } catch (err) {
      const errorMessage = getErrorMessage(err);
      notify(
        `Failed to finalize leftover merge/squash commit: ${errorMessage}`,
        "error"
      );
      return "blocked";
    }
  } else {
    const gsdConflicts = conflictedFiles.filter((f) => f.startsWith(".gsd/"));
    const codeConflicts = conflictedFiles.filter((f) => !f.startsWith(".gsd/"));
    if (gsdConflicts.length > 0 && codeConflicts.length === 0) {
      let resolved = true;
      try {
        nativeCheckoutTheirs(basePath, gsdConflicts);
        nativeAddPaths(basePath, gsdConflicts);
      } catch (e) {
        logError(
          "recovery",
          `auto-resolve .gsd/ conflicts failed: ${e.message}`
        );
        resolved = false;
      }
      if (resolved) {
        try {
          nativeCommit(
            basePath,
            "chore: auto-resolve .gsd/ state file conflicts"
          );
          notify(
            `Auto-resolved ${gsdConflicts.length} .gsd/ state file conflict(s) from prior merge.`,
            "info"
          );
        } catch (e) {
          logError(
            "recovery",
            `auto-commit .gsd/ conflict resolution failed: ${e.message}`
          );
          resolved = false;
        }
      }
      if (!resolved) {
        abortAndResetMerge(basePath, hasMergeHead, squashMsgPath);
        notify(
          "Detected leftover merge state \u2014 auto-resolve failed, cleaned up. Re-deriving state.",
          "warning"
        );
      }
    } else {
      notify(
        "Detected leftover merge state with unresolved code conflicts. Auto-mode will pause without modifying the worktree so manual conflict resolution is preserved.",
        "error"
      );
      return "blocked";
    }
  }
  return "reconciled";
}
function reconcileMergeState(basePath, ctx) {
  return reconcileMergeStateCore(
    basePath,
    (message, severity) => ctx.ui.notify(message, severity)
  );
}
function hasMergeStateLeftovers(basePath) {
  const gitDir = resolveGitDir(basePath);
  return existsSync(join(gitDir, "MERGE_HEAD")) || existsSync(join(gitDir, "SQUASH_MSG")) || existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply")) || existsSync(join(gitDir, "CHERRY_PICK_HEAD")) || existsSync(join(gitDir, "REVERT_HEAD"));
}
function detectMergeStateDrift(_state, ctx) {
  if (hasMergeStateLeftovers(ctx.basePath)) {
    return [{ kind: "unmerged-merge-state", basePath: ctx.basePath }];
  }
  return [];
}
function repairMergeStateDrift(record) {
  const result = reconcileMergeStateCore(record.basePath, SILENT_NOTIFY);
  if (result === "blocked") {
    throw new Error(
      `Merge state reconciliation blocked for ${record.basePath} \u2014 likely unresolved code conflicts. Manual intervention required.`
    );
  }
}
const mergeStateHandler = {
  kind: "unmerged-merge-state",
  detect: detectMergeStateDrift,
  repair: (record) => {
    repairMergeStateDrift(record);
  }
};
export {
  detectMergeStateDrift,
  mergeStateHandler,
  reconcileMergeState,
  repairMergeStateDrift
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9zdGF0ZS1yZWNvbmNpbGlhdGlvbi9kcmlmdC9tZXJnZS1zdGF0ZS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IEFEUi0wMTcgdW5tZXJnZWQtbWVyZ2Utc3RhdGUgZHJpZnQgaGFuZGxlci4gUmVsb2NhdGVkIGZyb21cbi8vIGF1dG8tcmVjb3ZlcnkudHMgYXMgcGFydCBvZiBpc3N1ZSAjNTcwMS4gT3duczpcbi8vICAgLSByZWJhc2UvY2hlcnJ5LXBpY2svcmV2ZXJ0IGxlZnRvdmVyIGNsZWFudXAgKCM0OTgwIEhJR0gtNylcbi8vICAgLSBNRVJHRV9IRUFEIC8gU1FVQVNIX01TRyByZWNvbmNpbGlhdGlvbiB3aXRoIGF1dG8tcmVzb2x2ZSBvZiAuZ3NkL1xuLy8gICAgIGNvbmZsaWN0cyAoIzUzMCwgIzI1NDIpXG5cbmltcG9ydCB7IGV4ZWNGaWxlU3luYyB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMsIHVubGlua1N5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgaXNBYnNvbHV0ZSwgam9pbiwgcmVzb2x2ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcblxuaW1wb3J0IHR5cGUgeyBFeHRlbnNpb25Db250ZXh0IH0gZnJvbSBcIkBnc2QvcGktY29kaW5nLWFnZW50XCI7XG5cbmltcG9ydCB7IGdldEVycm9yTWVzc2FnZSB9IGZyb20gXCIuLi8uLi9lcnJvci11dGlscy5qc1wiO1xuaW1wb3J0IHtcbiAgbmF0aXZlQWRkUGF0aHMsXG4gIG5hdGl2ZUNoZWNrb3V0VGhlaXJzLFxuICBuYXRpdmVDb21taXQsXG4gIG5hdGl2ZUNvbmZsaWN0RmlsZXMsXG4gIG5hdGl2ZU1lcmdlQWJvcnQsXG4gIG5hdGl2ZVJlYmFzZUFib3J0LFxuICBuYXRpdmVSZXNldEhhcmQsXG59IGZyb20gXCIuLi8uLi9uYXRpdmUtZ2l0LWJyaWRnZS5qc1wiO1xuaW1wb3J0IHR5cGUgeyBHU0RTdGF0ZSB9IGZyb20gXCIuLi8uLi90eXBlcy5qc1wiO1xuaW1wb3J0IHsgbG9nRXJyb3IsIGxvZ1dhcm5pbmcgfSBmcm9tIFwiLi4vLi4vd29ya2Zsb3ctbG9nZ2VyLmpzXCI7XG5pbXBvcnQgeyBpc0dzZFdvcmt0cmVlUGF0aCB9IGZyb20gXCIuLi8uLi93b3JrdHJlZS1yb290LmpzXCI7XG5pbXBvcnQgdHlwZSB7IERyaWZ0Q29udGV4dCwgRHJpZnRIYW5kbGVyLCBEcmlmdFJlY29yZCB9IGZyb20gXCIuLi90eXBlcy5qc1wiO1xuXG5leHBvcnQgdHlwZSBNZXJnZVJlY29uY2lsZVJlc3VsdCA9IFwiY2xlYW5cIiB8IFwicmVjb25jaWxlZFwiIHwgXCJibG9ja2VkXCI7XG5cbnR5cGUgTm90aWZ5Rm4gPSAoXG4gIG1lc3NhZ2U6IHN0cmluZyxcbiAgc2V2ZXJpdHk6IFwiaW5mb1wiIHwgXCJ3YXJuaW5nXCIgfCBcImVycm9yXCIsXG4pID0+IHZvaWQ7XG5cbmNvbnN0IFNJTEVOVF9OT1RJRlk6IE5vdGlmeUZuID0gKCkgPT4ge307XG5cbmZ1bmN0aW9uIHJlc29sdmVHaXREaXIoYmFzZVBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gIHRyeSB7XG4gICAgY29uc3QgZ2l0RGlyID0gZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcInJldi1wYXJzZVwiLCBcIi0tZ2l0LWRpclwiXSwge1xuICAgICAgY3dkOiBiYXNlUGF0aCxcbiAgICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwicGlwZVwiXSxcbiAgICAgIGVuY29kaW5nOiBcInV0Zi04XCIsXG4gICAgfSkudHJpbSgpO1xuXG4gICAgaWYgKGdpdERpci5sZW5ndGggPiAwKSB7XG4gICAgICByZXR1cm4gaXNBYnNvbHV0ZShnaXREaXIpID8gZ2l0RGlyIDogcmVzb2x2ZShiYXNlUGF0aCwgZ2l0RGlyKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGNvbnN0IG1lc3NhZ2UgPSBnZXRFcnJvck1lc3NhZ2UoZXJyKTtcbiAgICBsb2dXYXJuaW5nKFwicmVjb3ZlcnlcIiwgYGdpdGRpciByZXNvbHV0aW9uIGZhaWxlZDogJHttZXNzYWdlfWApO1xuICAgIGlmIChpc0dzZFdvcmt0cmVlUGF0aChiYXNlUGF0aCkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYFdvcmt0cmVlIGludGVncml0eSBmYWlsdXJlOiAke2Jhc2VQYXRofSBpcyBub3QgYSB2YWxpZCBnaXQgd29ya3RyZWUgKGdpdCByZXYtcGFyc2UgZmFpbGVkOiAke21lc3NhZ2Uuc3BsaXQoXCJcXG5cIilbMF19KS4gUmVwYWlyIG9yIHJlY3JlYXRlIHRoZSB3b3JrdHJlZSBiZWZvcmUgcmV0cnlpbmcuYCxcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGpvaW4oYmFzZVBhdGgsIFwiLmdpdFwiKTtcbn1cblxuLyoqXG4gKiBCZXN0LWVmZm9ydCBhYm9ydCBvZiBhIHBlbmRpbmcgbWVyZ2Uvc3F1YXNoIGFuZCBoYXJkLXJlc2V0IHRvIEhFQUQuXG4gKiBIYW5kbGVzIGJvdGggcmVhbCBtZXJnZXMgKE1FUkdFX0hFQUQpIGFuZCBzcXVhc2ggbWVyZ2VzIChTUVVBU0hfTVNHKS5cbiAqL1xuZnVuY3Rpb24gYWJvcnRBbmRSZXNldE1lcmdlKFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICBoYXNNZXJnZUhlYWQ6IGJvb2xlYW4sXG4gIHNxdWFzaE1zZ1BhdGg6IHN0cmluZyxcbik6IHZvaWQge1xuICBpZiAoaGFzTWVyZ2VIZWFkKSB7XG4gICAgdHJ5IHtcbiAgICAgIG5hdGl2ZU1lcmdlQWJvcnQoYmFzZVBhdGgpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgLyogYmVzdC1lZmZvcnQgKi9cbiAgICAgIGxvZ1dhcm5pbmcoXG4gICAgICAgIFwicmVjb3ZlcnlcIixcbiAgICAgICAgYGdpdCBtZXJnZS1hYm9ydCBmYWlsZWQ6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWAsXG4gICAgICApO1xuICAgIH1cbiAgfSBlbHNlIGlmIChzcXVhc2hNc2dQYXRoKSB7XG4gICAgdHJ5IHtcbiAgICAgIHVubGlua1N5bmMoc3F1YXNoTXNnUGF0aCk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAvKiBiZXN0LWVmZm9ydCAqL1xuICAgICAgbG9nV2FybmluZyhcbiAgICAgICAgXCJyZWNvdmVyeVwiLFxuICAgICAgICBgZmlsZSB1bmxpbmsgZmFpbGVkOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gLFxuICAgICAgKTtcbiAgICB9XG4gIH1cbiAgdHJ5IHtcbiAgICBuYXRpdmVSZXNldEhhcmQoYmFzZVBhdGgpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICAvKiBiZXN0LWVmZm9ydCAqL1xuICAgIGxvZ0Vycm9yKFxuICAgICAgXCJyZWNvdmVyeVwiLFxuICAgICAgYGdpdCByZXNldCBmYWlsZWQ6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWAsXG4gICAgKTtcbiAgfVxufVxuXG4vKipcbiAqIERldGVjdCBhbmQgYWJvcnQgb3RoZXIgaW4tcHJvZ3Jlc3MgZ2l0IG9wZXJhdGlvbnMgbGVmdCBiZWhpbmQgYnkgYSBTSUdLSUxMJ2RcbiAqIHdvcmtlciAocmViYXNlLCBjaGVycnktcGljaywgcmV2ZXJ0KS4gV2l0aG91dCB0aGlzLCBhIGtpbGxlZCB3b3JrZXJcbiAqIG1pZC1yZWJhc2UgbGVhdmVzIGAuZ2l0L3JlYmFzZS1tZXJnZS9gIG9yIGAuZ2l0L0NIRVJSWV9QSUNLX0hFQURgIGFuZCB0aGVcbiAqIHdvcmt0cmVlIGlzIHdlZGdlZCB1bnRpbCB0aGUgdXNlciBtYW51YWxseSBydW5zIHRoZSBtYXRjaGluZyBgLS1hYm9ydGAuXG4gKlxuICogQ2FsbGVkIGJlZm9yZSBtZXJnZS1zdGF0ZSByZWNvbmNpbGlhdGlvbiBiZWNhdXNlIHRoZXNlIHN0YXRlcyBibG9jayBhbnlcbiAqIHN1YnNlcXVlbnQgbWVyZ2UvY29tbWl0IG9wZXJhdGlvbi4gKCM0OTgwIEhJR0gtNylcbiAqL1xuZnVuY3Rpb24gcmVjb25jaWxlT3RoZXJJblByb2dyZXNzR2l0T3BzKFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICBub3RpZnk6IE5vdGlmeUZuLFxuKTogTWVyZ2VSZWNvbmNpbGVSZXN1bHQge1xuICBjb25zdCBnaXREaXIgPSByZXNvbHZlR2l0RGlyKGJhc2VQYXRoKTtcbiAgY29uc3Qgc3RhdGVzOiBBcnJheTx7XG4gICAgbGFiZWw6IHN0cmluZztcbiAgICBpbmRpY2F0b3JzOiBzdHJpbmdbXTtcbiAgICBhYm9ydDogKCkgPT4gdm9pZDtcbiAgfT4gPSBbXG4gICAge1xuICAgICAgbGFiZWw6IFwicmViYXNlXCIsXG4gICAgICBpbmRpY2F0b3JzOiBbam9pbihnaXREaXIsIFwicmViYXNlLW1lcmdlXCIpLCBqb2luKGdpdERpciwgXCJyZWJhc2UtYXBwbHlcIildLFxuICAgICAgYWJvcnQ6ICgpID0+IG5hdGl2ZVJlYmFzZUFib3J0KGJhc2VQYXRoKSxcbiAgICB9LFxuICAgIHtcbiAgICAgIGxhYmVsOiBcImNoZXJyeS1waWNrXCIsXG4gICAgICBpbmRpY2F0b3JzOiBbam9pbihnaXREaXIsIFwiQ0hFUlJZX1BJQ0tfSEVBRFwiKV0sXG4gICAgICBhYm9ydDogKCkgPT4ge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJjaGVycnktcGlja1wiLCBcIi0tYWJvcnRcIl0sIHtcbiAgICAgICAgICAgIGN3ZDogYmFzZVBhdGgsXG4gICAgICAgICAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0sXG4gICAgICAgICAgICBlbmNvZGluZzogXCJ1dGYtOFwiLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYGNoZXJyeS1waWNrIC0tYWJvcnQgZmFpbGVkOiAke2dldEVycm9yTWVzc2FnZShlcnIpfWApO1xuICAgICAgICB9XG4gICAgICB9LFxuICAgIH0sXG4gICAge1xuICAgICAgbGFiZWw6IFwicmV2ZXJ0XCIsXG4gICAgICBpbmRpY2F0b3JzOiBbam9pbihnaXREaXIsIFwiUkVWRVJUX0hFQURcIildLFxuICAgICAgYWJvcnQ6ICgpID0+IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wicmV2ZXJ0XCIsIFwiLS1hYm9ydFwiXSwge1xuICAgICAgICAgICAgY3dkOiBiYXNlUGF0aCxcbiAgICAgICAgICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwicGlwZVwiXSxcbiAgICAgICAgICAgIGVuY29kaW5nOiBcInV0Zi04XCIsXG4gICAgICAgICAgfSk7XG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgcmV2ZXJ0IC0tYWJvcnQgZmFpbGVkOiAke2dldEVycm9yTWVzc2FnZShlcnIpfWApO1xuICAgICAgICB9XG4gICAgICB9LFxuICAgIH0sXG4gIF07XG5cbiAgbGV0IHJlY29uY2lsZWQgPSBmYWxzZTtcbiAgZm9yIChjb25zdCBzIG9mIHN0YXRlcykge1xuICAgIGNvbnN0IHByZXNlbnQgPSBzLmluZGljYXRvcnMuc29tZSgocCkgPT4gZXhpc3RzU3luYyhwKSk7XG4gICAgaWYgKCFwcmVzZW50KSBjb250aW51ZTtcbiAgICB0cnkge1xuICAgICAgcy5hYm9ydCgpO1xuICAgICAgbm90aWZ5KFxuICAgICAgICBgRGV0ZWN0ZWQgbGVmdG92ZXIgJHtzLmxhYmVsfSBzdGF0ZSBmcm9tIHByaW9yIHNlc3Npb24gXHUyMDE0IGFib3J0ZWQuYCxcbiAgICAgICAgXCJ3YXJuaW5nXCIsXG4gICAgICApO1xuICAgICAgcmVjb25jaWxlZCA9IHRydWU7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBsb2dFcnJvcihcInJlY292ZXJ5XCIsIGAke3MubGFiZWx9IGFib3J0IGZhaWxlZDogJHtnZXRFcnJvck1lc3NhZ2UoZXJyKX1gKTtcbiAgICAgIG5vdGlmeShcbiAgICAgICAgYERldGVjdGVkIGxlZnRvdmVyICR7cy5sYWJlbH0gc3RhdGUgYnV0IGF1dG8tYWJvcnQgZmFpbGVkLiBgICtcbiAgICAgICAgICBgUnVuIFxcYGdpdCAke3MubGFiZWx9IC0tYWJvcnRcXGAgbWFudWFsbHkgYmVmb3JlIHJldHJ5aW5nLmAsXG4gICAgICAgIFwiZXJyb3JcIixcbiAgICAgICk7XG4gICAgICByZXR1cm4gXCJibG9ja2VkXCI7XG4gICAgfVxuICB9XG4gIHJldHVybiByZWNvbmNpbGVkID8gXCJyZWNvbmNpbGVkXCIgOiBcImNsZWFuXCI7XG59XG5cbi8qKlxuICogQ29yZTogZGV0ZWN0IGxlZnRvdmVyIG1lcmdlIHN0YXRlIGFuZCByZWNvbmNpbGUgaXQuIFRha2VzIGEgTm90aWZ5Rm4gc28gdGhlXG4gKiBsZWdhY3kgcmVjb25jaWxlTWVyZ2VTdGF0ZShiYXNlUGF0aCwgY3R4KSB3cmFwcGVyIGFuZCB0aGUgZHJpZnQgaGFuZGxlciBjYW5cbiAqIGJvdGggY2FsbCBpdCBcdTIwMTQgdGhlIGRyaWZ0IGhhbmRsZXIgdXNlcyBTSUxFTlRfTk9USUZZLlxuICovXG5mdW5jdGlvbiByZWNvbmNpbGVNZXJnZVN0YXRlQ29yZShcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgbm90aWZ5OiBOb3RpZnlGbixcbik6IE1lcmdlUmVjb25jaWxlUmVzdWx0IHtcbiAgLy8gRmlyc3QsIGFib3J0IGFueSByZWJhc2UvY2hlcnJ5LXBpY2svcmV2ZXJ0IGxlZnQgb3ZlciBmcm9tIGEgU0lHS0lMTCdkXG4gIC8vIHdvcmtlci4gRG9pbmcgdGhpcyBiZWZvcmUgdGhlIG1lcmdlLXN0YXRlIGNoZWNrIHVuYmxvY2tzIGFueSBtZXJnZSB0aGF0XG4gIC8vIHdvdWxkIG90aGVyd2lzZSByZWZ1c2Ugd2l0aCBcInlvdSBoYXZlIHVuZmluaXNoZWQgb3BlcmF0aW9uXCIuIChISUdILTcpXG4gIGNvbnN0IG90aGVyT3BzUmVzdWx0ID0gcmVjb25jaWxlT3RoZXJJblByb2dyZXNzR2l0T3BzKGJhc2VQYXRoLCBub3RpZnkpO1xuICBpZiAob3RoZXJPcHNSZXN1bHQgPT09IFwiYmxvY2tlZFwiKSByZXR1cm4gXCJibG9ja2VkXCI7XG5cbiAgY29uc3QgZ2l0RGlyID0gcmVzb2x2ZUdpdERpcihiYXNlUGF0aCk7XG4gIGNvbnN0IG1lcmdlSGVhZFBhdGggPSBqb2luKGdpdERpciwgXCJNRVJHRV9IRUFEXCIpO1xuICBjb25zdCBzcXVhc2hNc2dQYXRoID0gam9pbihnaXREaXIsIFwiU1FVQVNIX01TR1wiKTtcbiAgY29uc3QgaGFzTWVyZ2VIZWFkID0gZXhpc3RzU3luYyhtZXJnZUhlYWRQYXRoKTtcbiAgY29uc3QgaGFzU3F1YXNoTXNnID0gZXhpc3RzU3luYyhzcXVhc2hNc2dQYXRoKTtcbiAgaWYgKCFoYXNNZXJnZUhlYWQgJiYgIWhhc1NxdWFzaE1zZykge1xuICAgIHJldHVybiBvdGhlck9wc1Jlc3VsdCA9PT0gXCJyZWNvbmNpbGVkXCIgPyBcInJlY29uY2lsZWRcIiA6IFwiY2xlYW5cIjtcbiAgfVxuXG4gIGNvbnN0IGNvbmZsaWN0ZWRGaWxlcyA9IG5hdGl2ZUNvbmZsaWN0RmlsZXMoYmFzZVBhdGgpO1xuICBpZiAoY29uZmxpY3RlZEZpbGVzLmxlbmd0aCA9PT0gMCkge1xuICAgIC8vIEFsbCBjb25mbGljdHMgcmVzb2x2ZWQgXHUyMDE0IGZpbmFsaXplIHRoZSBtZXJnZS9zcXVhc2ggY29tbWl0XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGNvbW1pdFNoYSA9IG5hdGl2ZUNvbW1pdChiYXNlUGF0aCwgXCJjaG9yZShnc2QpOiByZWNvbmNpbGUgbWVyZ2Ugc3RhdGVcIik7XG4gICAgICBpZiAoY29tbWl0U2hhKSB7XG4gICAgICAgIGNvbnN0IG1vZGUgPSBoYXNNZXJnZUhlYWQgPyBcIm1lcmdlXCIgOiBcInNxdWFzaCBjb21taXRcIjtcbiAgICAgICAgbm90aWZ5KGBGaW5hbGl6ZWQgbGVmdG92ZXIgJHttb2RlfSBmcm9tIHByaW9yIHNlc3Npb24uYCwgXCJpbmZvXCIpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgbm90aWZ5KFxuICAgICAgICAgIFwiTm8gbmV3IGNvbW1pdCBuZWVkZWQgZm9yIGxlZnRvdmVyIG1lcmdlL3NxdWFzaCBzdGF0ZSBcdTIwMTQgYWxyZWFkeSBjb21taXR0ZWQuXCIsXG4gICAgICAgICAgXCJpbmZvXCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBjb25zdCBlcnJvck1lc3NhZ2UgPSBnZXRFcnJvck1lc3NhZ2UoZXJyKTtcbiAgICAgIG5vdGlmeShcbiAgICAgICAgYEZhaWxlZCB0byBmaW5hbGl6ZSBsZWZ0b3ZlciBtZXJnZS9zcXVhc2ggY29tbWl0OiAke2Vycm9yTWVzc2FnZX1gLFxuICAgICAgICBcImVycm9yXCIsXG4gICAgICApO1xuICAgICAgcmV0dXJuIFwiYmxvY2tlZFwiO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICAvLyBTdGlsbCBjb25mbGljdGVkIFx1MjAxNCB0cnkgYXV0by1yZXNvbHZpbmcgLmdzZC8gc3RhdGUgZmlsZSBjb25mbGljdHMgKCM1MzApXG4gICAgY29uc3QgZ3NkQ29uZmxpY3RzID0gY29uZmxpY3RlZEZpbGVzLmZpbHRlcigoZikgPT4gZi5zdGFydHNXaXRoKFwiLmdzZC9cIikpO1xuICAgIGNvbnN0IGNvZGVDb25mbGljdHMgPSBjb25mbGljdGVkRmlsZXMuZmlsdGVyKChmKSA9PiAhZi5zdGFydHNXaXRoKFwiLmdzZC9cIikpO1xuXG4gICAgaWYgKGdzZENvbmZsaWN0cy5sZW5ndGggPiAwICYmIGNvZGVDb25mbGljdHMubGVuZ3RoID09PSAwKSB7XG4gICAgICBsZXQgcmVzb2x2ZWQgPSB0cnVlO1xuICAgICAgdHJ5IHtcbiAgICAgICAgbmF0aXZlQ2hlY2tvdXRUaGVpcnMoYmFzZVBhdGgsIGdzZENvbmZsaWN0cyk7XG4gICAgICAgIG5hdGl2ZUFkZFBhdGhzKGJhc2VQYXRoLCBnc2RDb25mbGljdHMpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBsb2dFcnJvcihcbiAgICAgICAgICBcInJlY292ZXJ5XCIsXG4gICAgICAgICAgYGF1dG8tcmVzb2x2ZSAuZ3NkLyBjb25mbGljdHMgZmFpbGVkOiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWAsXG4gICAgICAgICk7XG4gICAgICAgIHJlc29sdmVkID0gZmFsc2U7XG4gICAgICB9XG4gICAgICBpZiAocmVzb2x2ZWQpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBuYXRpdmVDb21taXQoXG4gICAgICAgICAgICBiYXNlUGF0aCxcbiAgICAgICAgICAgIFwiY2hvcmU6IGF1dG8tcmVzb2x2ZSAuZ3NkLyBzdGF0ZSBmaWxlIGNvbmZsaWN0c1wiLFxuICAgICAgICAgICk7XG4gICAgICAgICAgbm90aWZ5KFxuICAgICAgICAgICAgYEF1dG8tcmVzb2x2ZWQgJHtnc2RDb25mbGljdHMubGVuZ3RofSAuZ3NkLyBzdGF0ZSBmaWxlIGNvbmZsaWN0KHMpIGZyb20gcHJpb3IgbWVyZ2UuYCxcbiAgICAgICAgICAgIFwiaW5mb1wiLFxuICAgICAgICAgICk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICBsb2dFcnJvcihcbiAgICAgICAgICAgIFwicmVjb3ZlcnlcIixcbiAgICAgICAgICAgIGBhdXRvLWNvbW1pdCAuZ3NkLyBjb25mbGljdCByZXNvbHV0aW9uIGZhaWxlZDogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gLFxuICAgICAgICAgICk7XG4gICAgICAgICAgcmVzb2x2ZWQgPSBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKCFyZXNvbHZlZCkge1xuICAgICAgICBhYm9ydEFuZFJlc2V0TWVyZ2UoYmFzZVBhdGgsIGhhc01lcmdlSGVhZCwgc3F1YXNoTXNnUGF0aCk7XG4gICAgICAgIG5vdGlmeShcbiAgICAgICAgICBcIkRldGVjdGVkIGxlZnRvdmVyIG1lcmdlIHN0YXRlIFx1MjAxNCBhdXRvLXJlc29sdmUgZmFpbGVkLCBjbGVhbmVkIHVwLiBSZS1kZXJpdmluZyBzdGF0ZS5cIixcbiAgICAgICAgICBcIndhcm5pbmdcIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgLy8gQ29kZSBjb25mbGljdHMgcHJlc2VudCBcdTIwMTQgZmFpbCBzYWZlIGFuZCBwcmVzZXJ2ZSBhbnkgbWFudWFsIHJlc29sdXRpb25cbiAgICAgIC8vIHdvcmsgaW5zdGVhZCBvZiBkaXNjYXJkaW5nIGl0IHdpdGggbWVyZ2UgLS1hYm9ydC9yZXNldCAtLWhhcmQuXG4gICAgICBub3RpZnkoXG4gICAgICAgIFwiRGV0ZWN0ZWQgbGVmdG92ZXIgbWVyZ2Ugc3RhdGUgd2l0aCB1bnJlc29sdmVkIGNvZGUgY29uZmxpY3RzLiBBdXRvLW1vZGUgd2lsbCBwYXVzZSB3aXRob3V0IG1vZGlmeWluZyB0aGUgd29ya3RyZWUgc28gbWFudWFsIGNvbmZsaWN0IHJlc29sdXRpb24gaXMgcHJlc2VydmVkLlwiLFxuICAgICAgICBcImVycm9yXCIsXG4gICAgICApO1xuICAgICAgcmV0dXJuIFwiYmxvY2tlZFwiO1xuICAgIH1cbiAgfVxuICByZXR1cm4gXCJyZWNvbmNpbGVkXCI7XG59XG5cbi8qKlxuICogTGVnYWN5IGVudHJ5IHBvaW50IHByZXNlcnZlZCBmb3IgZXhpc3RpbmcgY2FsbGVycyAoYXV0by50cywgYXV0by9waGFzZXMudHNcbiAqIHZpYSBsb29wLWRlcHMsIGludGVncmF0aW9uIHRlc3RzKS4gTmV3IGNvZGUgcHJlZmVycyB0aGUgZHJpZnQgaGFuZGxlci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlY29uY2lsZU1lcmdlU3RhdGUoXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIGN0eDogRXh0ZW5zaW9uQ29udGV4dCxcbik6IE1lcmdlUmVjb25jaWxlUmVzdWx0IHtcbiAgcmV0dXJuIHJlY29uY2lsZU1lcmdlU3RhdGVDb3JlKGJhc2VQYXRoLCAobWVzc2FnZSwgc2V2ZXJpdHkpID0+XG4gICAgY3R4LnVpLm5vdGlmeShtZXNzYWdlLCBzZXZlcml0eSksXG4gICk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBEcmlmdCBIYW5kbGVyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50eXBlIE1lcmdlU3RhdGVEcmlmdCA9IEV4dHJhY3Q8RHJpZnRSZWNvcmQsIHsga2luZDogXCJ1bm1lcmdlZC1tZXJnZS1zdGF0ZVwiIH0+O1xuXG5mdW5jdGlvbiBoYXNNZXJnZVN0YXRlTGVmdG92ZXJzKGJhc2VQYXRoOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgZ2l0RGlyID0gcmVzb2x2ZUdpdERpcihiYXNlUGF0aCk7XG4gIHJldHVybiAoXG4gICAgZXhpc3RzU3luYyhqb2luKGdpdERpciwgXCJNRVJHRV9IRUFEXCIpKSB8fFxuICAgIGV4aXN0c1N5bmMoam9pbihnaXREaXIsIFwiU1FVQVNIX01TR1wiKSkgfHxcbiAgICBleGlzdHNTeW5jKGpvaW4oZ2l0RGlyLCBcInJlYmFzZS1tZXJnZVwiKSkgfHxcbiAgICBleGlzdHNTeW5jKGpvaW4oZ2l0RGlyLCBcInJlYmFzZS1hcHBseVwiKSkgfHxcbiAgICBleGlzdHNTeW5jKGpvaW4oZ2l0RGlyLCBcIkNIRVJSWV9QSUNLX0hFQURcIikpIHx8XG4gICAgZXhpc3RzU3luYyhqb2luKGdpdERpciwgXCJSRVZFUlRfSEVBRFwiKSlcbiAgKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGRldGVjdE1lcmdlU3RhdGVEcmlmdChcbiAgX3N0YXRlOiBHU0RTdGF0ZSxcbiAgY3R4OiBEcmlmdENvbnRleHQsXG4pOiBNZXJnZVN0YXRlRHJpZnRbXSB7XG4gIGlmIChoYXNNZXJnZVN0YXRlTGVmdG92ZXJzKGN0eC5iYXNlUGF0aCkpIHtcbiAgICByZXR1cm4gW3sga2luZDogXCJ1bm1lcmdlZC1tZXJnZS1zdGF0ZVwiLCBiYXNlUGF0aDogY3R4LmJhc2VQYXRoIH1dO1xuICB9XG4gIHJldHVybiBbXTtcbn1cblxuLyoqXG4gKiBSZXBhaXI6IGludm9rZSB0aGUgcmVjb25jaWxpYXRpb24gY29yZSB3aXRoIGEgc2lsZW50IG5vdGlmeS4gSWYgdGhlXG4gKiB1bmRlcmx5aW5nIHJlY29uY2lsaWF0aW9uIHJlcG9ydHMgXCJibG9ja2VkXCIgKGUuZy4sIHVucmVzb2x2ZWQgY29kZVxuICogY29uZmxpY3RzIHByZXNlbnQpLCB0aHJvdyBzbyByZWNvbmNpbGVCZWZvcmVEaXNwYXRjaCBzdXJmYWNlcyB0aGUgZHJpZnRcbiAqIHZpYSBSZWNvbmNpbGlhdGlvbkZhaWxlZEVycm9yLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVwYWlyTWVyZ2VTdGF0ZURyaWZ0KHJlY29yZDogTWVyZ2VTdGF0ZURyaWZ0KTogdm9pZCB7XG4gIGNvbnN0IHJlc3VsdCA9IHJlY29uY2lsZU1lcmdlU3RhdGVDb3JlKHJlY29yZC5iYXNlUGF0aCwgU0lMRU5UX05PVElGWSk7XG4gIGlmIChyZXN1bHQgPT09IFwiYmxvY2tlZFwiKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYE1lcmdlIHN0YXRlIHJlY29uY2lsaWF0aW9uIGJsb2NrZWQgZm9yICR7cmVjb3JkLmJhc2VQYXRofSBcdTIwMTQgbGlrZWx5IHVucmVzb2x2ZWQgY29kZSBjb25mbGljdHMuIE1hbnVhbCBpbnRlcnZlbnRpb24gcmVxdWlyZWQuYCxcbiAgICApO1xuICB9XG59XG5cbmV4cG9ydCBjb25zdCBtZXJnZVN0YXRlSGFuZGxlcjogRHJpZnRIYW5kbGVyPE1lcmdlU3RhdGVEcmlmdD4gPSB7XG4gIGtpbmQ6IFwidW5tZXJnZWQtbWVyZ2Utc3RhdGVcIixcbiAgZGV0ZWN0OiBkZXRlY3RNZXJnZVN0YXRlRHJpZnQsXG4gIHJlcGFpcjogKHJlY29yZCkgPT4ge1xuICAgIHJlcGFpck1lcmdlU3RhdGVEcmlmdChyZWNvcmQpO1xuICB9LFxufTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQU9BLFNBQVMsb0JBQW9CO0FBQzdCLFNBQVMsWUFBWSxrQkFBa0I7QUFDdkMsU0FBUyxZQUFZLE1BQU0sZUFBZTtBQUkxQyxTQUFTLHVCQUF1QjtBQUNoQztBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBRVAsU0FBUyxVQUFVLGtCQUFrQjtBQUNyQyxTQUFTLHlCQUF5QjtBQVVsQyxNQUFNLGdCQUEwQixNQUFNO0FBQUM7QUFFdkMsU0FBUyxjQUFjLFVBQTBCO0FBQy9DLE1BQUk7QUFDRixVQUFNLFNBQVMsYUFBYSxPQUFPLENBQUMsYUFBYSxXQUFXLEdBQUc7QUFBQSxNQUM3RCxLQUFLO0FBQUEsTUFDTCxPQUFPLENBQUMsVUFBVSxRQUFRLE1BQU07QUFBQSxNQUNoQyxVQUFVO0FBQUEsSUFDWixDQUFDLEVBQUUsS0FBSztBQUVSLFFBQUksT0FBTyxTQUFTLEdBQUc7QUFDckIsYUFBTyxXQUFXLE1BQU0sSUFBSSxTQUFTLFFBQVEsVUFBVSxNQUFNO0FBQUEsSUFDL0Q7QUFBQSxFQUNGLFNBQVMsS0FBSztBQUNaLFVBQU0sVUFBVSxnQkFBZ0IsR0FBRztBQUNu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
