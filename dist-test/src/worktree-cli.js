import chalk from "chalk";
import { createJiti } from "@mariozechner/jiti";
import { fileURLToPath } from "node:url";
import { generateWorktreeName } from "./worktree-name-gen.js";
import { existsSync } from "node:fs";
import { resolveBundledGsdExtensionModule } from "./bundled-resource-path.js";
const jiti = createJiti(fileURLToPath(import.meta.url), { interopDefault: true, debug: false });
const gsdExtensionPath = (...segments) => resolveBundledGsdExtensionModule(import.meta.url, segments.join("/"));
let _ext = null;
function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function logDebugFailure(scope, error) {
  if (process.env.GSD_DEBUG === "1") {
    process.stderr.write(chalk.dim(`[gsd] ${scope} failed: ${toErrorMessage(error)}
`));
  }
}
async function loadExtensionModules() {
  if (_ext) return _ext;
  const [wtMgr, autoWt, gitBridge, gitSvc, wt] = await Promise.all([
    jiti.import(gsdExtensionPath("worktree-manager.ts"), {}),
    jiti.import(gsdExtensionPath("auto-worktree.ts"), {}),
    jiti.import(gsdExtensionPath("native-git-bridge.ts"), {}),
    jiti.import(gsdExtensionPath("git-service.ts"), {}),
    jiti.import(gsdExtensionPath("worktree.ts"), {})
  ]);
  _ext = {
    createWorktree: wtMgr.createWorktree,
    listWorktrees: wtMgr.listWorktrees,
    removeWorktree: wtMgr.removeWorktree,
    mergeWorktreeToMain: wtMgr.mergeWorktreeToMain,
    diffWorktreeAll: wtMgr.diffWorktreeAll,
    diffWorktreeNumstat: wtMgr.diffWorktreeNumstat,
    worktreeBranchName: wtMgr.worktreeBranchName,
    worktreePath: wtMgr.worktreePath,
    runWorktreePostCreateHook: autoWt.runWorktreePostCreateHook,
    nativeHasChanges: gitBridge.nativeHasChanges,
    nativeDetectMainBranch: gitBridge.nativeDetectMainBranch,
    nativeCommitCountBetween: gitBridge.nativeCommitCountBetween,
    inferCommitType: gitSvc.inferCommitType,
    autoCommitCurrentBranch: wt.autoCommitCurrentBranch,
    resolveWorktreeProjectRoot: wt.resolveWorktreeProjectRoot
  };
  return _ext;
}
function getWorktreeStatus(ext, basePath, name, wtPath, branch) {
  const diff = ext.diffWorktreeAll(basePath, name, branch);
  const numstat = ext.diffWorktreeNumstat(basePath, name, branch);
  const filesChanged = diff.added.length + diff.modified.length + diff.removed.length;
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const s of numstat) {
    linesAdded += s.added;
    linesRemoved += s.removed;
  }
  let uncommitted = false;
  try {
    uncommitted = existsSync(wtPath) && ext.nativeHasChanges(wtPath);
  } catch (error) {
    logDebugFailure("native worktree dirty check", error);
  }
  let commits = 0;
  try {
    const mainBranch = ext.nativeDetectMainBranch(basePath);
    commits = ext.nativeCommitCountBetween(basePath, mainBranch, branch);
  } catch (error) {
    logDebugFailure("native commit count", error);
  }
  return {
    name,
    path: wtPath,
    branch,
    exists: existsSync(wtPath),
    filesChanged,
    linesAdded,
    linesRemoved,
    uncommitted,
    commits
  };
}
function formatStatus(s) {
  const lines = [];
  const badge = s.uncommitted ? chalk.yellow(" (uncommitted)") : s.filesChanged > 0 ? chalk.cyan(" (unmerged)") : chalk.green(" (clean)");
  lines.push(`  ${chalk.bold.cyan(s.name)}${badge}`);
  lines.push(`    ${chalk.dim("branch")}  ${chalk.magenta(s.branch)}`);
  lines.push(`    ${chalk.dim("path")}    ${chalk.dim(s.path)}`);
  if (s.filesChanged > 0) {
    lines.push(`    ${chalk.dim("diff")}    ${s.filesChanged} files, ${chalk.green(`+${s.linesAdded}`)} ${chalk.red(`-${s.linesRemoved}`)}, ${s.commits} commit${s.commits === 1 ? "" : "s"}`);
  }
  return lines.join("\n");
}
async function handleList(basePath) {
  const ext = await loadExtensionModules();
  basePath = ext.resolveWorktreeProjectRoot(basePath);
  const worktrees = ext.listWorktrees(basePath);
  if (worktrees.length === 0) {
    process.stderr.write(chalk.dim("No worktrees. Create one with: gsd -w <name>\n"));
    return;
  }
  process.stderr.write(chalk.bold("\nWorktrees\n\n"));
  for (const wt of worktrees) {
    const status = getWorktreeStatus(ext, basePath, wt.name, wt.path, wt.branch);
    process.stderr.write(formatStatus(status) + "\n\n");
  }
}
async function handleMerge(basePath, args) {
  const ext = await loadExtensionModules();
  basePath = ext.resolveWorktreeProjectRoot(basePath);
  const name = args[0];
  if (!name) {
    const worktrees = ext.listWorktrees(basePath);
    if (worktrees.length === 1) {
      await doMerge(ext, basePath, worktrees[0].name);
      return;
    }
    process.stderr.write(chalk.red("Usage: gsd worktree merge <name>\n"));
    process.stderr.write(chalk.dim("Run gsd worktree list to see worktrees.\n"));
    process.exit(1);
  }
  await doMerge(ext, basePath, name);
}
async function doMerge(ext, basePath, name) {
  const worktrees = ext.listWorktrees(basePath);
  const wt = worktrees.find((w) => w.name === name);
  if (!wt) {
    process.stderr.write(chalk.red(`Worktree "${name}" not found.
`));
    process.exit(1);
  }
  const status = getWorktreeStatus(ext, basePath, name, wt.path, wt.branch);
  if (status.filesChanged === 0 && !status.uncommitted) {
    process.stderr.write(chalk.dim(`Worktree "${name}" has no changes to merge.
`));
    ext.removeWorktree(basePath, name, { deleteBranch: true, branch: wt.branch });
    process.stderr.write(chalk.green(`Removed empty worktree ${chalk.bold(name)}.
`));
    return;
  }
  if (status.uncommitted) {
    try {
      ext.autoCommitCurrentBranch(wt.path, "worktree-merge", name);
      process.stderr.write(chalk.dim("  Auto-committed dirty work before merge.\n"));
    } catch (error) {
      process.stderr.write(chalk.yellow(`  Auto-commit before merge failed: ${toErrorMessage(error)}
`));
    }
  }
  const commitType = ext.inferCommitType(name);
  const commitMessage = `${commitType}: merge worktree ${name}

GSD-Worktree: ${name}`;
  process.stderr.write(`
Merging ${chalk.bold.cyan(name)} \u2192 ${chalk.magenta(ext.nativeDetectMainBranch(basePath))}
`);
  process.stderr.write(chalk.dim(`  ${status.filesChanged} files, ${chalk.green(`+${status.linesAdded}`)} ${chalk.red(`-${status.linesRemoved}`)}

`));
  try {
    ext.mergeWorktreeToMain(basePath, name, commitMessage, wt.branch);
    ext.removeWorktree(basePath, name, { deleteBranch: true, branch: wt.branch });
    process.stderr.write(chalk.green(`\u2713 Merged and cleaned up ${chalk.bold(name)}
`));
    process.stderr.write(chalk.dim(`  commit: ${commitMessage}
`));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(chalk.red(`\u2717 Merge failed: ${msg}
`));
    process.stderr.write(chalk.dim("  Resolve conflicts manually, then run gsd worktree merge again.\n"));
    process.exit(1);
  }
}
async function handleClean(basePath) {
  const ext = await loadExtensionModules();
  basePath = ext.resolveWorktreeProjectRoot(basePath);
  const worktrees = ext.listWorktrees(basePath);
  if (worktrees.length === 0) {
    process.stderr.write(chalk.dim("No worktrees to clean.\n"));
    return;
  }
  let cleaned = 0;
  for (const wt of worktrees) {
    const status = getWorktreeStatus(ext, basePath, wt.name, wt.path, wt.branch);
    if (status.filesChanged === 0 && !status.uncommitted) {
      try {
        ext.removeWorktree(basePath, wt.name, { deleteBranch: true, branch: wt.branch });
        process.stderr.write(chalk.green(`  \u2713 Removed ${chalk.bold(wt.name)} (clean)
`));
        cleaned++;
      } catch (error) {
        process.stderr.write(chalk.yellow(`  \u2717 Failed to remove ${wt.name}: ${toErrorMessage(error)}
`));
      }
    } else {
      process.stderr.write(chalk.dim(`  \u2500 Kept ${chalk.bold(wt.name)} (${status.filesChanged} changed files)
`));
    }
  }
  process.stderr.write(chalk.dim(`
Cleaned ${cleaned} worktree${cleaned === 1 ? "" : "s"}.
`));
}
async function handleRemove(basePath, args) {
  const ext = await loadExtensionModules();
  basePath = ext.resolveWorktreeProjectRoot(basePath);
  const name = args[0];
  if (!name) {
    process.stderr.write(chalk.red("Usage: gsd worktree remove <name>\n"));
    process.exit(1);
  }
  const worktrees = ext.listWorktrees(basePath);
  const wt = worktrees.find((w) => w.name === name);
  if (!wt) {
    process.stderr.write(chalk.red(`Worktree "${name}" not found.
`));
    process.exit(1);
  }
  const status = getWorktreeStatus(ext, basePath, name, wt.path, wt.branch);
  if (status.filesChanged > 0 || status.uncommitted) {
    process.stderr.write(chalk.yellow(`\u26A0 Worktree "${name}" has unmerged changes (${status.filesChanged} files).
`));
    process.stderr.write(chalk.yellow("  Use --force to remove anyway, or merge first: gsd worktree merge " + name + "\n"));
    if (!process.argv.includes("--force")) {
      process.exit(1);
    }
  }
  ext.removeWorktree(basePath, name, { deleteBranch: true, branch: wt.branch });
  process.stderr.write(chalk.green(`\u2713 Removed worktree ${chalk.bold(name)}
`));
}
async function handleStatusBanner(basePath) {
  const ext = await loadExtensionModules();
  basePath = ext.resolveWorktreeProjectRoot(basePath);
  const worktrees = ext.listWorktrees(basePath);
  if (worktrees.length === 0) return;
  const withChanges = worktrees.filter((wt) => {
    try {
      const diff = ext.diffWorktreeAll(basePath, wt.name, wt.branch);
      return diff.added.length + diff.modified.length + diff.removed.length > 0;
    } catch (error) {
      logDebugFailure(`status scan for ${wt.name}`, error);
      return false;
    }
  });
  if (withChanges.length === 0) return;
  const names = withChanges.map((w) => chalk.cyan(w.name)).join(", ");
  process.stderr.write(
    chalk.dim("[gsd] ") + chalk.yellow(`${withChanges.length} worktree${withChanges.length === 1 ? "" : "s"} with unmerged changes: `) + names + "\n" + chalk.dim("[gsd] ") + chalk.dim("Resume: gsd -w <name>  |  Merge: gsd worktree merge <name>  |  List: gsd worktree list\n\n")
  );
}
async function handleWorktreeFlag(worktreeFlag) {
  const ext = await loadExtensionModules();
  const basePath = ext.resolveWorktreeProjectRoot(process.cwd());
  if (worktreeFlag === true) {
    const existing2 = ext.listWorktrees(basePath);
    const withChanges = existing2.filter((wt) => {
      try {
        const diff = ext.diffWorktreeAll(basePath, wt.name, wt.branch);
        return diff.added.length + diff.modified.length + diff.removed.length > 0;
      } catch (error) {
        logDebugFailure(`worktree -w scan for ${wt.name}`, error);
        return false;
      }
    });
    if (withChanges.length === 1) {
      const wt = withChanges[0];
      process.chdir(wt.path);
      process.env.GSD_CLI_WORKTREE = wt.name;
      process.env.GSD_CLI_WORKTREE_BASE = basePath;
      process.stderr.write(chalk.green(`\u2713 Resumed worktree ${chalk.bold(wt.name)}
`));
      process.stderr.write(chalk.dim(`  path   ${wt.path}
`));
      process.stderr.write(chalk.dim(`  branch ${wt.branch}

`));
      return;
    }
    if (withChanges.length > 1) {
      process.stderr.write(chalk.yellow(`${withChanges.length} worktrees have unmerged changes:

`));
      for (const wt of withChanges) {
        const status = getWorktreeStatus(ext, basePath, wt.name, wt.path, wt.branch);
        process.stderr.write(formatStatus(status) + "\n\n");
      }
      process.stderr.write(chalk.dim("Specify which one: gsd -w <name>\n"));
      process.exit(0);
    }
    const name2 = generateWorktreeName();
    await createAndEnter(ext, basePath, name2);
    return;
  }
  const name = worktreeFlag;
  const existing = ext.listWorktrees(basePath);
  const found = existing.find((wt) => wt.name === name);
  if (found) {
    process.chdir(found.path);
    process.env.GSD_CLI_WORKTREE = name;
    process.env.GSD_CLI_WORKTREE_BASE = basePath;
    process.stderr.write(chalk.green(`\u2713 Resumed worktree ${chalk.bold(name)}
`));
    process.stderr.write(chalk.dim(`  path   ${found.path}
`));
    process.stderr.write(chalk.dim(`  branch ${found.branch}

`));
  } else {
    await createAndEnter(ext, basePath, name);
  }
}
async function createAndEnter(ext, basePath, name) {
  try {
    const info = ext.createWorktree(basePath, name);
    const hookError = ext.runWorktreePostCreateHook(basePath, info.path);
    if (hookError) {
      process.stderr.write(chalk.yellow(`[gsd] ${hookError}
`));
    }
    process.chdir(info.path);
    process.env.GSD_CLI_WORKTREE = name;
    process.env.GSD_CLI_WORKTREE_BASE = basePath;
    process.stderr.write(chalk.green(`\u2713 Created worktree ${chalk.bold(name)}
`));
    process.stderr.write(chalk.dim(`  path   ${info.path}
`));
    process.stderr.write(chalk.dim(`  branch ${info.branch}

`));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(chalk.red(`[gsd] Failed to create worktree: ${msg}
`));
    process.exit(1);
  }
}
export {
  getWorktreeStatus,
  handleClean,
  handleList,
  handleMerge,
  handleRemove,
  handleStatusBanner,
  handleWorktreeFlag
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL3dvcmt0cmVlLWNsaS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBHU0QgV29ya3RyZWUgQ0xJIFx1MjAxNCBzdGFuZGFsb25lIHN1YmNvbW1hbmQgYW5kIC13IGZsYWcgaGFuZGxpbmcuXG4gKlxuICogTWFuYWdlcyB0aGUgZnVsbCB3b3JrdHJlZSBsaWZlY3ljbGUgZnJvbSB0aGUgY29tbWFuZCBsaW5lOlxuICogICBnc2QgLXcgICAgICAgICAgICAgICAgICAgIENyZWF0ZSBhdXRvLW5hbWVkIHdvcmt0cmVlLCBzdGFydCBpbnRlcmFjdGl2ZSBzZXNzaW9uXG4gKiAgIGdzZCAtdyBteS1mZWF0dXJlICAgICAgICAgQ3JlYXRlL3Jlc3VtZSBuYW1lZCB3b3JrdHJlZVxuICogICBnc2Qgd29ya3RyZWUgbGlzdCAgICAgICAgIExpc3Qgd29ya3RyZWVzIHdpdGggc3RhdHVzXG4gKiAgIGdzZCB3b3JrdHJlZSBtZXJnZSBbbmFtZV0gU3F1YXNoLW1lcmdlIGEgd29ya3RyZWUgaW50byBtYWluXG4gKiAgIGdzZCB3b3JrdHJlZSBjbGVhbiAgICAgICAgUmVtb3ZlIGFsbCBtZXJnZWQvZW1wdHkgd29ya3RyZWVzXG4gKiAgIGdzZCB3b3JrdHJlZSByZW1vdmUgPG4+ICAgUmVtb3ZlIGEgc3BlY2lmaWMgd29ya3RyZWVcbiAqXG4gKiBPbiBzZXNzaW9uIGV4aXQgKHZpYSBzZXNzaW9uX3NodXRkb3duIGV2ZW50KSwgYXV0by1jb21taXRzIGRpcnR5IHdvcmtcbiAqIHNvIG5vdGhpbmcgaXMgbG9zdC4gVGhlIEdTRCBleHRlbnNpb24gcmVhZHMgR1NEX0NMSV9XT1JLVFJFRSB0byBrbm93XG4gKiB3aGVuIGEgc2Vzc2lvbiB3YXMgbGF1bmNoZWQgdmlhIC13LlxuICpcbiAqIE5vdGU6IEV4dGVuc2lvbiBtb2R1bGVzIGFyZSAudHMgZmlsZXMgbG9hZGVkIHZpYSBqaXRpIChub3QgY29tcGlsZWQgdG8gLmpzKS5cbiAqIFdlIHVzZSBjcmVhdGVKaXRpKCkgaGVyZSBiZWNhdXNlIHRoaXMgbW9kdWxlIGlzIGNvbXBpbGVkIGJ5IHRzYyBidXQgaW1wb3J0c1xuICogZnJvbSByZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvIHdoaWNoIGFyZSBzaGlwcGVkIGFzIHJhdyAudHMgKCMxMjgzKS5cbiAqL1xuXG5pbXBvcnQgY2hhbGsgZnJvbSAnY2hhbGsnXG5pbXBvcnQgeyBjcmVhdGVKaXRpIH0gZnJvbSAnQG1hcmlvemVjaG5lci9qaXRpJ1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gJ25vZGU6dXJsJ1xuaW1wb3J0IHsgZ2VuZXJhdGVXb3JrdHJlZU5hbWUgfSBmcm9tICcuL3dvcmt0cmVlLW5hbWUtZ2VuLmpzJ1xuaW1wb3J0IHsgZXhpc3RzU3luYyB9IGZyb20gJ25vZGU6ZnMnXG5pbXBvcnQgeyByZXNvbHZlQnVuZGxlZEdzZEV4dGVuc2lvbk1vZHVsZSB9IGZyb20gJy4vYnVuZGxlZC1yZXNvdXJjZS1wYXRoLmpzJ1xuXG5jb25zdCBqaXRpID0gY3JlYXRlSml0aShmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCksIHsgaW50ZXJvcERlZmF1bHQ6IHRydWUsIGRlYnVnOiBmYWxzZSB9KVxuY29uc3QgZ3NkRXh0ZW5zaW9uUGF0aCA9ICguLi5zZWdtZW50czogc3RyaW5nW10pID0+XG4gIHJlc29sdmVCdW5kbGVkR3NkRXh0ZW5zaW9uTW9kdWxlKGltcG9ydC5tZXRhLnVybCwgc2VnbWVudHMuam9pbignLycpKVxuXG4vLyBMYXppbHktbG9hZGVkIGV4dGVuc2lvbiBtb2R1bGVzIChsb2FkZWQgb25jZSBvbiBmaXJzdCB1c2UgdmlhIGppdGkpXG5sZXQgX2V4dDogRXh0ZW5zaW9uTW9kdWxlcyB8IG51bGwgPSBudWxsXG5cbmludGVyZmFjZSBFeHRlbnNpb25Nb2R1bGVzIHtcbiAgY3JlYXRlV29ya3RyZWU6IChiYXNlUGF0aDogc3RyaW5nLCBuYW1lOiBzdHJpbmcpID0+IHsgcGF0aDogc3RyaW5nOyBicmFuY2g6IHN0cmluZyB9XG4gIGxpc3RXb3JrdHJlZXM6IChiYXNlUGF0aDogc3RyaW5nKSA9PiBBcnJheTx7IG5hbWU6IHN0cmluZzsgcGF0aDogc3RyaW5nOyBicmFuY2g6IHN0cmluZyB9PlxuICByZW1vdmVXb3JrdHJlZTogKGJhc2VQYXRoOiBzdHJpbmcsIG5hbWU6IHN0cmluZywgb3B0cz86IHsgZGVsZXRlQnJhbmNoPzogYm9vbGVhbjsgYnJhbmNoPzogc3RyaW5nIH0pID0+IHZvaWRcbiAgbWVyZ2VXb3JrdHJlZVRvTWFpbjogKGJhc2VQYXRoOiBzdHJpbmcsIG5hbWU6IHN0cmluZywgY29tbWl0TWVzc2FnZTogc3RyaW5nLCBicmFuY2g/OiBzdHJpbmcpID0+IHZvaWRcbiAgZGlmZldvcmt0cmVlQWxsOiAoYmFzZVBhdGg6IHN0cmluZywgbmFtZTogc3RyaW5nLCBicmFuY2g/OiBzdHJpbmcpID0+IFdvcmt0cmVlRGlmZlxuICBkaWZmV29ya3RyZWVOdW1zdGF0OiAoYmFzZVBhdGg6IHN0cmluZywgbmFtZTogc3RyaW5nLCBicmFuY2g/OiBzdHJpbmcpID0+IEFycmF5PHsgYWRkZWQ6IG51bWJlcjsgcmVtb3ZlZDogbnVtYmVyIH0+XG4gIHdvcmt0cmVlQnJhbmNoTmFtZTogKG5hbWU6IHN0cmluZykgPT4gc3RyaW5nXG4gIHdvcmt0cmVlUGF0aDogKGJhc2VQYXRoOiBzdHJpbmcsIG5hbWU6IHN0cmluZykgPT4gc3RyaW5nXG4gIHJ1bldvcmt0cmVlUG9zdENyZWF0ZUhvb2s6IChiYXNlUGF0aDogc3RyaW5nLCB3dFBhdGg6IHN0cmluZykgPT4gc3RyaW5nIHwgbnVsbFxuICBuYXRpdmVIYXNDaGFuZ2VzOiAocGF0aDogc3RyaW5nKSA9PiBib29sZWFuXG4gIG5hdGl2ZURldGVjdE1haW5CcmFuY2g6IChiYXNlUGF0aDogc3RyaW5nKSA9PiBzdHJpbmdcbiAgbmF0aXZlQ29tbWl0Q291bnRCZXR3ZWVuOiAoYmFzZVBhdGg6IHN0cmluZywgZnJvbTogc3RyaW5nLCB0bzogc3RyaW5nKSA9PiBudW1iZXJcbiAgaW5mZXJDb21taXRUeXBlOiAobmFtZTogc3RyaW5nKSA9PiBzdHJpbmdcbiAgYXV0b0NvbW1pdEN1cnJlbnRCcmFuY2g6ICh3dFBhdGg6IHN0cmluZywgcmVhc29uOiBzdHJpbmcsIG5hbWU6IHN0cmluZykgPT4gdm9pZFxuICByZXNvbHZlV29ya3RyZWVQcm9qZWN0Um9vdDogKGJhc2VQYXRoOiBzdHJpbmcpID0+IHN0cmluZ1xufVxuXG5pbnRlcmZhY2UgV29ya3RyZWVEaWZmIHtcbiAgYWRkZWQ6IHN0cmluZ1tdXG4gIG1vZGlmaWVkOiBzdHJpbmdbXVxuICByZW1vdmVkOiBzdHJpbmdbXVxufVxuXG5pbnRlcmZhY2UgV29ya3RyZWVNYW5hZ2VyTW9kdWxlIHtcbiAgY3JlYXRlV29ya3RyZWU6IEV4dGVuc2lvbk1vZHVsZXNbJ2NyZWF0ZVdvcmt0cmVlJ11cbiAgbGlzdFdvcmt0cmVlczogRXh0ZW5zaW9uTW9kdWxlc1snbGlzdFdvcmt0cmVlcyddXG4gIHJlbW92ZVdvcmt0cmVlOiBFeHRlbnNpb25Nb2R1bGVzWydyZW1vdmVXb3JrdHJlZSddXG4gIG1lcmdlV29ya3RyZWVUb01haW46IEV4dGVuc2lvbk1vZHVsZXNbJ21lcmdlV29ya3RyZWVUb01haW4nXVxuICBkaWZmV29ya3RyZWVBbGw6IEV4dGVuc2lvbk1vZHVsZXNbJ2RpZmZXb3JrdHJlZUFsbCddXG4gIGRpZmZXb3JrdHJlZU51bXN0YXQ6IEV4dGVuc2lvbk1vZHVsZXNbJ2RpZmZXb3JrdHJlZU51bXN0YXQnXVxuICB3b3JrdHJlZUJyYW5jaE5hbWU6IEV4dGVuc2lvbk1vZHVsZXNbJ3dvcmt0cmVlQnJhbmNoTmFtZSddXG4gIHdvcmt0cmVlUGF0aDogRXh0ZW5zaW9uTW9kdWxlc1snd29ya3RyZWVQYXRoJ11cbn1cblxuaW50ZXJmYWNlIEF1dG9Xb3JrdHJlZU1vZHVsZSB7XG4gIHJ1bldvcmt0cmVlUG9zdENyZWF0ZUhvb2s6IEV4dGVuc2lvbk1vZHVsZXNbJ3J1bldvcmt0cmVlUG9zdENyZWF0ZUhvb2snXVxufVxuXG5pbnRlcmZhY2UgTmF0aXZlR2l0QnJpZGdlTW9kdWxlIHtcbiAgbmF0aXZlSGFzQ2hhbmdlczogRXh0ZW5zaW9uTW9kdWxlc1snbmF0aXZlSGFzQ2hhbmdlcyddXG4gIG5hdGl2ZURldGVjdE1haW5CcmFuY2g6IEV4dGVuc2lvbk1vZHVsZXNbJ25hdGl2ZURldGVjdE1haW5CcmFuY2gnXVxuICBuYXRpdmVDb21taXRDb3VudEJldHdlZW46IEV4dGVuc2lvbk1vZHVsZXNbJ25hdGl2ZUNvbW1pdENvdW50QmV0d2VlbiddXG59XG5cbmludGVyZmFjZSBHaXRTZXJ2aWNlTW9kdWxlIHtcbiAgaW5mZXJDb21taXRUeXBlOiBFeHRlbnNpb25Nb2R1bGVzWydpbmZlckNvbW1pdFR5cGUnXVxufVxuXG5pbnRlcmZhY2UgV29ya3RyZWVNb2R1bGUge1xuICBhdXRvQ29tbWl0Q3VycmVudEJyYW5jaDogRXh0ZW5zaW9uTW9kdWxlc1snYXV0b0NvbW1pdEN1cnJlbnRCcmFuY2gnXVxuICByZXNvbHZlV29ya3RyZWVQcm9qZWN0Um9vdDogRXh0ZW5zaW9uTW9kdWxlc1sncmVzb2x2ZVdvcmt0cmVlUHJvamVjdFJvb3QnXVxufVxuXG5mdW5jdGlvbiB0b0Vycm9yTWVzc2FnZShlcnJvcjogdW5rbm93bik6IHN0cmluZyB7XG4gIHJldHVybiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcilcbn1cblxuZnVuY3Rpb24gbG9nRGVidWdGYWlsdXJlKHNjb3BlOiBzdHJpbmcsIGVycm9yOiB1bmtub3duKTogdm9pZCB7XG4gIGlmIChwcm9jZXNzLmVudi5HU0RfREVCVUcgPT09ICcxJykge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGNoYWxrLmRpbShgW2dzZF0gJHtzY29wZX0gZmFpbGVkOiAke3RvRXJyb3JNZXNzYWdlKGVycm9yKX1cXG5gKSlcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBsb2FkRXh0ZW5zaW9uTW9kdWxlcygpOiBQcm9taXNlPEV4dGVuc2lvbk1vZHVsZXM+IHtcbiAgaWYgKF9leHQpIHJldHVybiBfZXh0XG4gIGNvbnN0IFt3dE1nciwgYXV0b1d0LCBnaXRCcmlkZ2UsIGdpdFN2Yywgd3RdID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgIGppdGkuaW1wb3J0KGdzZEV4dGVuc2lvblBhdGgoJ3dvcmt0cmVlLW1hbmFnZXIudHMnKSwge30pIGFzIFByb21pc2U8V29ya3RyZWVNYW5hZ2VyTW9kdWxlPixcbiAgICBqaXRpLmltcG9ydChnc2RFeHRlbnNpb25QYXRoKCdhdXRvLXdvcmt0cmVlLnRzJyksIHt9KSBhcyBQcm9taXNlPEF1dG9Xb3JrdHJlZU1vZHVsZT4sXG4gICAgaml0aS5pbXBvcnQoZ3NkRXh0ZW5zaW9uUGF0aCgnbmF0aXZlLWdpdC1icmlkZ2UudHMnKSwge30pIGFzIFByb21pc2U8TmF0aXZlR2l0QnJpZGdlTW9kdWxlPixcbiAgICBqaXRpLmltcG9ydChnc2RFeHRlbnNpb25QYXRoKCdnaXQtc2VydmljZS50cycpLCB7fSkgYXMgUHJvbWlzZTxHaXRTZXJ2aWNlTW9kdWxlPixcbiAgICBqaXRpLmltcG9ydChnc2RFeHRlbnNpb25QYXRoKCd3b3JrdHJlZS50cycpLCB7fSkgYXMgUHJvbWlzZTxXb3JrdHJlZU1vZHVsZT4sXG4gIF0pXG4gIF9leHQgPSB7XG4gICAgY3JlYXRlV29ya3RyZWU6IHd0TWdyLmNyZWF0ZVdvcmt0cmVlLFxuICAgIGxpc3RXb3JrdHJlZXM6IHd0TWdyLmxpc3RXb3JrdHJlZXMsXG4gICAgcmVtb3ZlV29ya3RyZWU6IHd0TWdyLnJlbW92ZVdvcmt0cmVlLFxuICAgIG1lcmdlV29ya3RyZWVUb01haW46IHd0TWdyLm1lcmdlV29ya3RyZWVUb01haW4sXG4gICAgZGlmZldvcmt0cmVlQWxsOiB3dE1nci5kaWZmV29ya3RyZWVBbGwsXG4gICAgZGlmZldvcmt0cmVlTnVtc3RhdDogd3RNZ3IuZGlmZldvcmt0cmVlTnVtc3RhdCxcbiAgICB3b3JrdHJlZUJyYW5jaE5hbWU6IHd0TWdyLndvcmt0cmVlQnJhbmNoTmFtZSxcbiAgICB3b3JrdHJlZVBhdGg6IHd0TWdyLndvcmt0cmVlUGF0aCxcbiAgICBydW5Xb3JrdHJlZVBvc3RDcmVhdGVIb29rOiBhdXRvV3QucnVuV29ya3RyZWVQb3N0Q3JlYXRlSG9vayxcbiAgICBuYXRpdmVIYXNDaGFuZ2VzOiBnaXRCcmlkZ2UubmF0aXZlSGFzQ2hhbmdlcyxcbiAgICBuYXRpdmVEZXRlY3RNYWluQnJhbmNoOiBnaXRCcmlkZ2UubmF0aXZlRGV0ZWN0TWFpbkJyYW5jaCxcbiAgICBuYXRpdmVDb21taXRDb3VudEJldHdlZW46IGdpdEJyaWRnZS5uYXRpdmVDb21taXRDb3VudEJldHdlZW4sXG4gICAgaW5mZXJDb21taXRUeXBlOiBnaXRTdmMuaW5mZXJDb21taXRUeXBlLFxuICAgIGF1dG9Db21taXRDdXJyZW50QnJhbmNoOiB3dC5hdXRvQ29tbWl0Q3VycmVudEJyYW5jaCxcbiAgICByZXNvbHZlV29ya3RyZWVQcm9qZWN0Um9vdDogd3QucmVzb2x2ZVdvcmt0cmVlUHJvamVjdFJvb3QsXG4gIH1cbiAgcmV0dXJuIF9leHRcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFR5cGVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5pbnRlcmZhY2UgV29ya3RyZWVTdGF0dXMge1xuICBuYW1lOiBzdHJpbmdcbiAgcGF0aDogc3RyaW5nXG4gIGJyYW5jaDogc3RyaW5nXG4gIGV4aXN0czogYm9vbGVhblxuICBmaWxlc0NoYW5nZWQ6IG51bWJlclxuICBsaW5lc0FkZGVkOiBudW1iZXJcbiAgbGluZXNSZW1vdmVkOiBudW1iZXJcbiAgdW5jb21taXR0ZWQ6IGJvb2xlYW5cbiAgY29tbWl0czogbnVtYmVyXG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTdGF0dXMgSGVscGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gZ2V0V29ya3RyZWVTdGF0dXMoZXh0OiBFeHRlbnNpb25Nb2R1bGVzLCBiYXNlUGF0aDogc3RyaW5nLCBuYW1lOiBzdHJpbmcsIHd0UGF0aDogc3RyaW5nLCBicmFuY2g6IHN0cmluZyk6IFdvcmt0cmVlU3RhdHVzIHtcbiAgY29uc3QgZGlmZiA9IGV4dC5kaWZmV29ya3RyZWVBbGwoYmFzZVBhdGgsIG5hbWUsIGJyYW5jaClcbiAgY29uc3QgbnVtc3RhdCA9IGV4dC5kaWZmV29ya3RyZWVOdW1zdGF0KGJhc2VQYXRoLCBuYW1lLCBicmFuY2gpXG4gIGNvbnN0IGZpbGVzQ2hhbmdlZCA9IGRpZmYuYWRkZWQubGVuZ3RoICsgZGlmZi5tb2RpZmllZC5sZW5ndGggKyBkaWZmLnJlbW92ZWQubGVuZ3RoXG4gIGxldCBsaW5lc0FkZGVkID0gMFxuICBsZXQgbGluZXNSZW1vdmVkID0gMFxuICBmb3IgKGNvbnN0IHMgb2YgbnVtc3RhdCkgeyBsaW5lc0FkZGVkICs9IHMuYWRkZWQ7IGxpbmVzUmVtb3ZlZCArPSBzLnJlbW92ZWQgfVxuXG4gIGxldCB1bmNvbW1pdHRlZCA9IGZhbHNlXG4gIHRyeSB7XG4gICAgdW5jb21taXR0ZWQgPSBleGlzdHNTeW5jKHd0UGF0aCkgJiYgZXh0Lm5hdGl2ZUhhc0NoYW5nZXMod3RQYXRoKVxuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGxvZ0RlYnVnRmFpbHVyZSgnbmF0aXZlIHdvcmt0cmVlIGRpcnR5IGNoZWNrJywgZXJyb3IpXG4gIH1cblxuICBsZXQgY29tbWl0cyA9IDBcbiAgdHJ5IHtcbiAgICBjb25zdCBtYWluQnJhbmNoID0gZXh0Lm5hdGl2ZURldGVjdE1haW5CcmFuY2goYmFzZVBhdGgpXG4gICAgY29tbWl0cyA9IGV4dC5uYXRpdmVDb21taXRDb3VudEJldHdlZW4oYmFzZVBhdGgsIG1haW5CcmFuY2gsIGJyYW5jaClcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBsb2dEZWJ1Z0ZhaWx1cmUoJ25hdGl2ZSBjb21taXQgY291bnQnLCBlcnJvcilcbiAgfVxuXG4gIHJldHVybiB7XG4gICAgbmFtZSxcbiAgICBwYXRoOiB3dFBhdGgsXG4gICAgYnJhbmNoLFxuICAgIGV4aXN0czogZXhpc3RzU3luYyh3dFBhdGgpLFxuICAgIGZpbGVzQ2hhbmdlZCxcbiAgICBsaW5lc0FkZGVkLFxuICAgIGxpbmVzUmVtb3ZlZCxcbiAgICB1bmNvbW1pdHRlZCxcbiAgICBjb21taXRzLFxuICB9XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBGb3JtYXR0ZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBmb3JtYXRTdGF0dXMoczogV29ya3RyZWVTdGF0dXMpOiBzdHJpbmcge1xuICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXVxuICBjb25zdCBiYWRnZSA9IHMudW5jb21taXR0ZWRcbiAgICA/IGNoYWxrLnllbGxvdygnICh1bmNvbW1pdHRlZCknKVxuICAgIDogcy5maWxlc0NoYW5nZWQgPiAwXG4gICAgICA/IGNoYWxrLmN5YW4oJyAodW5tZXJnZWQpJylcbiAgICAgIDogY2hhbGsuZ3JlZW4oJyAoY2xlYW4pJylcblxuICBsaW5lcy5wdXNoKGAgICR7Y2hhbGsuYm9sZC5jeWFuKHMubmFtZSl9JHtiYWRnZX1gKVxuICBsaW5lcy5wdXNoKGAgICAgJHtjaGFsay5kaW0oJ2JyYW5jaCcpfSAgJHtjaGFsay5tYWdlbnRhKHMuYnJhbmNoKX1gKVxuICBsaW5lcy5wdXNoKGAgICAgJHtjaGFsay5kaW0oJ3BhdGgnKX0gICAgJHtjaGFsay5kaW0ocy5wYXRoKX1gKVxuXG4gIGlmIChzLmZpbGVzQ2hhbmdlZCA+IDApIHtcbiAgICBsaW5lcy5wdXNoKGAgICAgJHtjaGFsay5kaW0oJ2RpZmYnKX0gICAgJHtzLmZpbGVzQ2hhbmdlZH0gZmlsZXMsICR7Y2hhbGsuZ3JlZW4oYCske3MubGluZXNBZGRlZH1gKX0gJHtjaGFsay5yZWQoYC0ke3MubGluZXNSZW1vdmVkfWApfSwgJHtzLmNvbW1pdHN9IGNvbW1pdCR7cy5jb21taXRzID09PSAxID8gJycgOiAncyd9YClcbiAgfVxuXG4gIHJldHVybiBsaW5lcy5qb2luKCdcXG4nKVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU3ViY29tbWFuZDogbGlzdCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuYXN5bmMgZnVuY3Rpb24gaGFuZGxlTGlzdChiYXNlUGF0aDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGV4dCA9IGF3YWl0IGxvYWRFeHRlbnNpb25Nb2R1bGVzKClcbiAgYmFzZVBhdGggPSBleHQucmVzb2x2ZVdvcmt0cmVlUHJvamVjdFJvb3QoYmFzZVBhdGgpXG4gIGNvbnN0IHdvcmt0cmVlcyA9IGV4dC5saXN0V29ya3RyZWVzKGJhc2VQYXRoKVxuXG4gIGlmICh3b3JrdHJlZXMubGVuZ3RoID09PSAwKSB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoY2hhbGsuZGltKCdObyB3b3JrdHJlZXMuIENyZWF0ZSBvbmUgd2l0aDogZ3NkIC13IDxuYW1lPlxcbicpKVxuICAgIHJldHVyblxuICB9XG5cbiAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoY2hhbGsuYm9sZCgnXFxuV29ya3RyZWVzXFxuXFxuJykpXG4gIGZvciAoY29uc3Qgd3Qgb2Ygd29ya3RyZWVzKSB7XG4gICAgY29uc3Qgc3RhdHVzID0gZ2V0V29ya3RyZWVTdGF0dXMoZXh0LCBiYXNlUGF0aCwgd3QubmFtZSwgd3QucGF0aCwgd3QuYnJhbmNoKVxuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGZvcm1hdFN0YXR1cyhzdGF0dXMpICsgJ1xcblxcbicpXG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFN1YmNvbW1hbmQ6IG1lcmdlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVNZXJnZShiYXNlUGF0aDogc3RyaW5nLCBhcmdzOiBzdHJpbmdbXSk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBleHQgPSBhd2FpdCBsb2FkRXh0ZW5zaW9uTW9kdWxlcygpXG4gIGJhc2VQYXRoID0gZXh0LnJlc29sdmVXb3JrdHJlZVByb2plY3RSb290KGJhc2VQYXRoKVxuICBjb25zdCBuYW1lID0gYXJnc1swXVxuICBpZiAoIW5hbWUpIHtcbiAgICAvLyBJZiBvbmx5IG9uZSB3b3JrdHJlZSBleGlzdHMsIG1lcmdlIGl0XG4gICAgY29uc3Qgd29ya3RyZWVzID0gZXh0Lmxpc3RXb3JrdHJlZXMoYmFzZVBhdGgpXG4gICAgaWYgKHdvcmt0cmVlcy5sZW5ndGggPT09IDEpIHtcbiAgICAgIGF3YWl0IGRvTWVyZ2UoZXh0LCBiYXNlUGF0aCwgd29ya3RyZWVzWzBdLm5hbWUpXG4gICAgICByZXR1cm5cbiAgICB9XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoY2hhbGsucmVkKCdVc2FnZTogZ3NkIHdvcmt0cmVlIG1lcmdlIDxuYW1lPlxcbicpKVxuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGNoYWxrLmRpbSgnUnVuIGdzZCB3b3JrdHJlZSBsaXN0IHRvIHNlZSB3b3JrdHJlZXMuXFxuJykpXG4gICAgcHJvY2Vzcy5leGl0KDEpXG4gIH1cbiAgYXdhaXQgZG9NZXJnZShleHQsIGJhc2VQYXRoLCBuYW1lKVxufVxuXG5hc3luYyBmdW5jdGlvbiBkb01lcmdlKGV4dDogRXh0ZW5zaW9uTW9kdWxlcywgYmFzZVBhdGg6IHN0cmluZywgbmFtZTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHdvcmt0cmVlcyA9IGV4dC5saXN0V29ya3RyZWVzKGJhc2VQYXRoKVxuICBjb25zdCB3dCA9IHdvcmt0cmVlcy5maW5kKHcgPT4gdy5uYW1lID09PSBuYW1lKVxuICBpZiAoIXd0KSB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoY2hhbGsucmVkKGBXb3JrdHJlZSBcIiR7bmFtZX1cIiBub3QgZm91bmQuXFxuYCkpXG4gICAgcHJvY2Vzcy5leGl0KDEpXG4gIH1cblxuICBjb25zdCBzdGF0dXMgPSBnZXRXb3JrdHJlZVN0YXR1cyhleHQsIGJhc2VQYXRoLCBuYW1lLCB3dC5wYXRoLCB3dC5icmFuY2gpXG4gIGlmIChzdGF0dXMuZmlsZXNDaGFuZ2VkID09PSAwICYmICFzdGF0dXMudW5jb21taXR0ZWQpIHtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShjaGFsay5kaW0oYFdvcmt0cmVlIFwiJHtuYW1lfVwiIGhhcyBubyBjaGFuZ2VzIHRvIG1lcmdlLlxcbmApKVxuICAgIC8vIENsZWFuIHVwIGVtcHR5IHdvcmt0cmVlXG4gICAgZXh0LnJlbW92ZVdvcmt0cmVlKGJhc2VQYXRoLCBuYW1lLCB7IGRlbGV0ZUJyYW5jaDogdHJ1ZSwgYnJhbmNoOiB3dC5icmFuY2ggfSlcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShjaGFsay5ncmVlbihgUmVtb3ZlZCBlbXB0eSB3b3JrdHJlZSAke2NoYWxrLmJvbGQobmFtZSl9LlxcbmApKVxuICAgIHJldHVyblxuICB9XG5cbiAgLy8gQXV0by1jb21taXQgZGlydHkgd29yayBiZWZvcmUgbWVyZ2VcbiAgaWYgKHN0YXR1cy51bmNvbW1pdHRlZCkge1xuICAgIHRyeSB7XG4gICAgICBleHQuYXV0b0NvbW1pdEN1cnJlbnRCcmFuY2god3QucGF0aCwgJ3dvcmt0cmVlLW1lcmdlJywgbmFtZSlcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGNoYWxrLmRpbSgnICBBdXRvLWNvbW1pdHRlZCBkaXJ0eSB3b3JrIGJlZm9yZSBtZXJnZS5cXG4nKSlcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoY2hhbGsueWVsbG93KGAgIEF1dG8tY29tbWl0IGJlZm9yZSBtZXJnZSBmYWlsZWQ6ICR7dG9FcnJvck1lc3NhZ2UoZXJyb3IpfVxcbmApKVxuICAgIH1cbiAgfVxuXG4gIGNvbnN0IGNvbW1pdFR5cGUgPSBleHQuaW5mZXJDb21taXRUeXBlKG5hbWUpXG4gIGNvbnN0IGNvbW1pdE1lc3NhZ2UgPSBgJHtjb21taXRUeXBlfTogbWVyZ2Ugd29ya3RyZWUgJHtuYW1lfVxcblxcbkdTRC1Xb3JrdHJlZTogJHtuYW1lfWBcblxuICBwcm9jZXNzLnN0ZGVyci53cml0ZShgXFxuTWVyZ2luZyAke2NoYWxrLmJvbGQuY3lhbihuYW1lKX0gXHUyMTkyICR7Y2hhbGsubWFnZW50YShleHQubmF0aXZlRGV0ZWN0TWFpbkJyYW5jaChiYXNlUGF0aCkpfVxcbmApXG4gIHByb2Nlc3Muc3RkZXJyLndyaXRlKGNoYWxrLmRpbShgICAke3N0YXR1cy5maWxlc0NoYW5nZWR9IGZpbGVzLCAke2NoYWxrLmdyZWVuKGArJHtzdGF0dXMubGluZXNBZGRlZH1gKX0gJHtjaGFsay5yZWQoYC0ke3N0YXR1cy5saW5lc1JlbW92ZWR9YCl9XFxuXFxuYCkpXG5cbiAgdHJ5IHtcbiAgICBleHQubWVyZ2VXb3JrdHJlZVRvTWFpbihiYXNlUGF0aCwgbmFtZSwgY29tbWl0TWVzc2FnZSwgd3QuYnJhbmNoKVxuICAgIGV4dC5yZW1vdmVXb3JrdHJlZShiYXNlUGF0aCwgbmFtZSwgeyBkZWxldGVCcmFuY2g6IHRydWUsIGJyYW5jaDogd3QuYnJhbmNoIH0pXG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoY2hhbGsuZ3JlZW4oYFx1MjcxMyBNZXJnZWQgYW5kIGNsZWFuZWQgdXAgJHtjaGFsay5ib2xkKG5hbWUpfVxcbmApKVxuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGNoYWxrLmRpbShgICBjb21taXQ6ICR7Y29tbWl0TWVzc2FnZX1cXG5gKSlcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY29uc3QgbXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpXG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoY2hhbGsucmVkKGBcdTI3MTcgTWVyZ2UgZmFpbGVkOiAke21zZ31cXG5gKSlcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShjaGFsay5kaW0oJyAgUmVzb2x2ZSBjb25mbGljdHMgbWFudWFsbHksIHRoZW4gcnVuIGdzZCB3b3JrdHJlZSBtZXJnZSBhZ2Fpbi5cXG4nKSlcbiAgICBwcm9jZXNzLmV4aXQoMSlcbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU3ViY29tbWFuZDogY2xlYW4gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZUNsZWFuKGJhc2VQYXRoOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgZXh0ID0gYXdhaXQgbG9hZEV4dGVuc2lvbk1vZHVsZXMoKVxuICBiYXNlUGF0aCA9IGV4dC5yZXNvbHZlV29ya3RyZWVQcm9qZWN0Um9vdChiYXNlUGF0aClcbiAgY29uc3Qgd29ya3RyZWVzID0gZXh0Lmxpc3RXb3JrdHJlZXMoYmFzZVBhdGgpXG4gIGlmICh3b3JrdHJlZXMubGVuZ3RoID09PSAwKSB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoY2hhbGsuZGltKCdObyB3b3JrdHJlZXMgdG8gY2xlYW4uXFxuJykpXG4gICAgcmV0dXJuXG4gIH1cblxuICBsZXQgY2xlYW5lZCA9IDBcbiAgZm9yIChjb25zdCB3dCBvZiB3b3JrdHJlZXMpIHtcbiAgICBjb25zdCBzdGF0dXMgPSBnZXRXb3JrdHJlZVN0YXR1cyhleHQsIGJhc2VQYXRoLCB3dC5uYW1lLCB3dC5wYXRoLCB3dC5icmFuY2gpXG4gICAgaWYgKHN0YXR1cy5maWxlc0NoYW5nZWQgPT09IDAgJiYgIXN0YXR1cy51bmNvbW1pdHRlZCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgZXh0LnJlbW92ZVdvcmt0cmVlKGJhc2VQYXRoLCB3dC5uYW1lLCB7IGRlbGV0ZUJyYW5jaDogdHJ1ZSwgYnJhbmNoOiB3dC5icmFuY2ggfSlcbiAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoY2hhbGsuZ3JlZW4oYCAgXHUyNzEzIFJlbW92ZWQgJHtjaGFsay5ib2xkKHd0Lm5hbWUpfSAoY2xlYW4pXFxuYCkpXG4gICAgICAgIGNsZWFuZWQrK1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoY2hhbGsueWVsbG93KGAgIFx1MjcxNyBGYWlsZWQgdG8gcmVtb3ZlICR7d3QubmFtZX06ICR7dG9FcnJvck1lc3NhZ2UoZXJyb3IpfVxcbmApKVxuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShjaGFsay5kaW0oYCAgXHUyNTAwIEtlcHQgJHtjaGFsay5ib2xkKHd0Lm5hbWUpfSAoJHtzdGF0dXMuZmlsZXNDaGFuZ2VkfSBjaGFuZ2VkIGZpbGVzKVxcbmApKVxuICAgIH1cbiAgfVxuXG4gIHByb2Nlc3Muc3RkZXJyLndyaXRlKGNoYWxrLmRpbShgXFxuQ2xlYW5lZCAke2NsZWFuZWR9IHdvcmt0cmVlJHtjbGVhbmVkID09PSAxID8gJycgOiAncyd9LlxcbmApKVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU3ViY29tbWFuZDogcmVtb3ZlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVSZW1vdmUoYmFzZVBhdGg6IHN0cmluZywgYXJnczogc3RyaW5nW10pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgZXh0ID0gYXdhaXQgbG9hZEV4dGVuc2lvbk1vZHVsZXMoKVxuICBiYXNlUGF0aCA9IGV4dC5yZXNvbHZlV29ya3RyZWVQcm9qZWN0Um9vdChiYXNlUGF0aClcbiAgY29uc3QgbmFtZSA9IGFyZ3NbMF1cbiAgaWYgKCFuYW1lKSB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoY2hhbGsucmVkKCdVc2FnZTogZ3NkIHdvcmt0cmVlIHJlbW92ZSA8bmFtZT5cXG4nKSlcbiAgICBwcm9jZXNzLmV4aXQoMSlcbiAgfVxuXG4gIGNvbnN0IHdvcmt0cmVlcyA9IGV4dC5saXN0V29ya3RyZWVzKGJhc2VQYXRoKVxuICBjb25zdCB3dCA9IHdvcmt0cmVlcy5maW5kKHcgPT4gdy5uYW1lID09PSBuYW1lKVxuICBpZiAoIXd0KSB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoY2hhbGsucmVkKGBXb3JrdHJlZSBcIiR7bmFtZX1cIiBub3QgZm91bmQuXFxuYCkpXG4gICAgcHJvY2Vzcy5leGl0KDEpXG4gIH1cblxuICBjb25zdCBzdGF0dXMgPSBnZXRXb3JrdHJlZVN0YXR1cyhleHQsIGJhc2VQYXRoLCBuYW1lLCB3dC5wYXRoLCB3dC5icmFuY2gpXG4gIGlmIChzdGF0dXMuZmlsZXNDaGFuZ2VkID4gMCB8fCBzdGF0dXMudW5jb21taXR0ZWQpIHtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShjaGFsay55ZWxsb3coYFx1MjZBMCBXb3JrdHJlZSBcIiR7bmFtZX1cIiBoYXMgdW5tZXJnZWQgY2hhbmdlcyAoJHtzdGF0dXMuZmlsZXNDaGFuZ2VkfSBmaWxlcykuXFxuYCkpXG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoY2hhbGsueWVsbG93KCcgIFVzZSAtLWZvcmNlIHRvIHJlbW92ZSBhbnl3YXksIG9yIG1lcmdlIGZpcnN0OiBnc2Qgd29ya3RyZWUgbWVyZ2UgJyArIG5hbWUgKyAnXFxuJykpXG4gICAgaWYgKCFwcm9jZXNzLmFyZ3YuaW5jbHVkZXMoJy0tZm9yY2UnKSkge1xuICAgICAgcHJvY2Vzcy5leGl0KDEpXG4gICAgfVxuICB9XG5cbiAgZXh0LnJlbW92ZVdvcmt0cmVlKGJhc2VQYXRoLCBuYW1lLCB7IGRlbGV0ZUJyYW5jaDogdHJ1ZSwgYnJhbmNoOiB3dC5icmFuY2ggfSlcbiAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoY2hhbGsuZ3JlZW4oYFx1MjcxMyBSZW1vdmVkIHdvcmt0cmVlICR7Y2hhbGsuYm9sZChuYW1lKX1cXG5gKSlcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFN1YmNvbW1hbmQ6IHN0YXR1cyAoZGVmYXVsdCB3aGVuIG5vIGFyZ3MpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVTdGF0dXNCYW5uZXIoYmFzZVBhdGg6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBleHQgPSBhd2FpdCBsb2FkRXh0ZW5zaW9uTW9kdWxlcygpXG4gIGJhc2VQYXRoID0gZXh0LnJlc29sdmVXb3JrdHJlZVByb2plY3RSb290KGJhc2VQYXRoKVxuICBjb25zdCB3b3JrdHJlZXMgPSBleHQubGlzdFdvcmt0cmVlcyhiYXNlUGF0aClcbiAgaWYgKHdvcmt0cmVlcy5sZW5ndGggPT09IDApIHJldHVyblxuXG4gIGNvbnN0IHdpdGhDaGFuZ2VzID0gd29ya3RyZWVzLmZpbHRlcih3dCA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGRpZmYgPSBleHQuZGlmZldvcmt0cmVlQWxsKGJhc2VQYXRoLCB3dC5uYW1lLCB3dC5icmFuY2gpXG4gICAgICByZXR1cm4gZGlmZi5hZGRlZC5sZW5ndGggKyBkaWZmLm1vZGlmaWVkLmxlbmd0aCArIGRpZmYucmVtb3ZlZC5sZW5ndGggPiAwXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGxvZ0RlYnVnRmFpbHVyZShgc3RhdHVzIHNjYW4gZm9yICR7d3QubmFtZX1gLCBlcnJvcilcbiAgICAgIHJldHVybiBmYWxzZVxuICAgIH1cbiAgfSlcblxuICBpZiAod2l0aENoYW5nZXMubGVuZ3RoID09PSAwKSByZXR1cm5cblxuICBjb25zdCBuYW1lcyA9IHdpdGhDaGFuZ2VzLm1hcCh3ID0+IGNoYWxrLmN5YW4ody5uYW1lKSkuam9pbignLCAnKVxuICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICBjaGFsay5kaW0oJ1tnc2RdICcpICtcbiAgICBjaGFsay55ZWxsb3coYCR7d2l0aENoYW5nZXMubGVuZ3RofSB3b3JrdHJlZSR7d2l0aENoYW5nZXMubGVuZ3RoID09PSAxID8gJycgOiAncyd9IHdpdGggdW5tZXJnZWQgY2hhbmdlczogYCkgK1xuICAgIG5hbWVzICsgJ1xcbicgK1xuICAgIGNoYWxrLmRpbSgnW2dzZF0gJykgK1xuICAgIGNoYWxrLmRpbSgnUmVzdW1lOiBnc2QgLXcgPG5hbWU+ICB8ICBNZXJnZTogZ3NkIHdvcmt0cmVlIG1lcmdlIDxuYW1lPiAgfCAgTGlzdDogZ3NkIHdvcmt0cmVlIGxpc3RcXG5cXG4nKSxcbiAgKVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgLXcgZmxhZzogY3JlYXRlL3Jlc3VtZSB3b3JrdHJlZSBmb3IgaW50ZXJhY3RpdmUgc2Vzc2lvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuYXN5bmMgZnVuY3Rpb24gaGFuZGxlV29ya3RyZWVGbGFnKHdvcmt0cmVlRmxhZzogYm9vbGVhbiB8IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBleHQgPSBhd2FpdCBsb2FkRXh0ZW5zaW9uTW9kdWxlcygpXG4gIGNvbnN0IGJhc2VQYXRoID0gZXh0LnJlc29sdmVXb3JrdHJlZVByb2plY3RSb290KHByb2Nlc3MuY3dkKCkpXG5cbiAgLy8gZ3NkIC13IChubyBuYW1lKSBcdTIwMTQgcmVzdW1lIG1vc3QgcmVjZW50IHdvcmt0cmVlIHdpdGggY2hhbmdlcywgb3IgY3JlYXRlIG5ld1xuICBpZiAod29ya3RyZWVGbGFnID09PSB0cnVlKSB7XG4gICAgY29uc3QgZXhpc3RpbmcgPSBleHQubGlzdFdvcmt0cmVlcyhiYXNlUGF0aClcbiAgICBjb25zdCB3aXRoQ2hhbmdlcyA9IGV4aXN0aW5nLmZpbHRlcih3dCA9PiB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBkaWZmID0gZXh0LmRpZmZXb3JrdHJlZUFsbChiYXNlUGF0aCwgd3QubmFtZSwgd3QuYnJhbmNoKVxuICAgICAgICByZXR1cm4gZGlmZi5hZGRlZC5sZW5ndGggKyBkaWZmLm1vZGlmaWVkLmxlbmd0aCArIGRpZmYucmVtb3ZlZC5sZW5ndGggPiAwXG4gICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBsb2dEZWJ1Z0ZhaWx1cmUoYHdvcmt0cmVlIC13IHNjYW4gZm9yICR7d3QubmFtZX1gLCBlcnJvcilcbiAgICAgICAgcmV0dXJuIGZhbHNlXG4gICAgICB9XG4gICAgfSlcblxuICAgIGlmICh3aXRoQ2hhbmdlcy5sZW5ndGggPT09IDEpIHtcbiAgICAgIC8vIFNpbmdsZSBhY3RpdmUgd29ya3RyZWUgXHUyMDE0IHJlc3VtZSBpdFxuICAgICAgY29uc3Qgd3QgPSB3aXRoQ2hhbmdlc1swXVxuICAgICAgcHJvY2Vzcy5jaGRpcih3dC5wYXRoKVxuICAgICAgcHJvY2Vzcy5lbnYuR1NEX0NMSV9XT1JLVFJFRSA9IHd0Lm5hbWVcbiAgICAgIHByb2Nlc3MuZW52LkdTRF9DTElfV09SS1RSRUVfQkFTRSA9IGJhc2VQYXRoXG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShjaGFsay5ncmVlbihgXHUyNzEzIFJlc3VtZWQgd29ya3RyZWUgJHtjaGFsay5ib2xkKHd0Lm5hbWUpfVxcbmApKVxuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoY2hhbGsuZGltKGAgIHBhdGggICAke3d0LnBhdGh9XFxuYCkpXG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShjaGFsay5kaW0oYCAgYnJhbmNoICR7d3QuYnJhbmNofVxcblxcbmApKVxuICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgaWYgKHdpdGhDaGFuZ2VzLmxlbmd0aCA+IDEpIHtcbiAgICAgIC8vIE11bHRpcGxlIGFjdGl2ZSB3b3JrdHJlZXMgXHUyMDE0IHNob3cgdGhlbSBhbmQgYXNrIHVzZXIgdG8gcGlja1xuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoY2hhbGsueWVsbG93KGAke3dpdGhDaGFuZ2VzLmxlbmd0aH0gd29ya3RyZWVzIGhhdmUgdW5tZXJnZWQgY2hhbmdlczpcXG5cXG5gKSlcbiAgICAgIGZvciAoY29uc3Qgd3Qgb2Ygd2l0aENoYW5nZXMpIHtcbiAgICAgICAgY29uc3Qgc3RhdHVzID0gZ2V0V29ya3RyZWVTdGF0dXMoZXh0LCBiYXNlUGF0aCwgd3QubmFtZSwgd3QucGF0aCwgd3QuYnJhbmNoKVxuICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShmb3JtYXRTdGF0dXMoc3RhdHVzKSArICdcXG5cXG4nKVxuICAgICAgfVxuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoY2hhbGsuZGltKCdTcGVjaWZ5IHdoaWNoIG9uZTogZ3NkIC13IDxuYW1lPlxcbicpKVxuICAgICAgcHJvY2Vzcy5leGl0KDApXG4gICAgfVxuXG4gICAgLy8gTm8gYWN0aXZlIHdvcmt0cmVlcyBcdTIwMTQgY3JlYXRlIGEgbmV3IG9uZVxuICAgIGNvbnN0IG5hbWUgPSBnZW5lcmF0ZVdvcmt0cmVlTmFtZSgpXG4gICAgYXdhaXQgY3JlYXRlQW5kRW50ZXIoZXh0LCBiYXNlUGF0aCwgbmFtZSlcbiAgICByZXR1cm5cbiAgfVxuXG4gIC8vIGdzZCAtdyA8bmFtZT4gXHUyMDE0IGNyZWF0ZSBvciByZXN1bWUgbmFtZWQgd29ya3RyZWVcbiAgY29uc3QgbmFtZSA9IHdvcmt0cmVlRmxhZyBhcyBzdHJpbmdcbiAgY29uc3QgZXhpc3RpbmcgPSBleHQubGlzdFdvcmt0cmVlcyhiYXNlUGF0aClcbiAgY29uc3QgZm91bmQgPSBleGlzdGluZy5maW5kKHd0ID0+IHd0Lm5hbWUgPT09IG5hbWUpXG5cbiAgaWYgKGZvdW5kKSB7XG4gICAgcHJvY2Vzcy5jaGRpcihmb3VuZC5wYXRoKVxuICAgIHByb2Nlc3MuZW52LkdTRF9DTElfV09SS1RSRUUgPSBuYW1lXG4gICAgcHJvY2Vzcy5lbnYuR1NEX0NMSV9XT1JLVFJFRV9CQVNFID0gYmFzZVBhdGhcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShjaGFsay5ncmVlbihgXHUyNzEzIFJlc3VtZWQgd29ya3RyZWUgJHtjaGFsay5ib2xkKG5hbWUpfVxcbmApKVxuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGNoYWxrLmRpbShgICBwYXRoICAgJHtmb3VuZC5wYXRofVxcbmApKVxuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGNoYWxrLmRpbShgICBicmFuY2ggJHtmb3VuZC5icmFuY2h9XFxuXFxuYCkpXG4gIH0gZWxzZSB7XG4gICAgYXdhaXQgY3JlYXRlQW5kRW50ZXIoZXh0LCBiYXNlUGF0aCwgbmFtZSlcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBjcmVhdGVBbmRFbnRlcihleHQ6IEV4dGVuc2lvbk1vZHVsZXMsIGJhc2VQYXRoOiBzdHJpbmcsIG5hbWU6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICB0cnkge1xuICAgIGNvbnN0IGluZm8gPSBleHQuY3JlYXRlV29ya3RyZWUoYmFzZVBhdGgsIG5hbWUpXG5cbiAgICBjb25zdCBob29rRXJyb3IgPSBleHQucnVuV29ya3RyZWVQb3N0Q3JlYXRlSG9vayhiYXNlUGF0aCwgaW5mby5wYXRoKVxuICAgIGlmIChob29rRXJyb3IpIHtcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGNoYWxrLnllbGxvdyhgW2dzZF0gJHtob29rRXJyb3J9XFxuYCkpXG4gICAgfVxuXG4gICAgcHJvY2Vzcy5jaGRpcihpbmZvLnBhdGgpXG4gICAgcHJvY2Vzcy5lbnYuR1NEX0NMSV9XT1JLVFJFRSA9IG5hbWVcbiAgICBwcm9jZXNzLmVudi5HU0RfQ0xJX1dPUktUUkVFX0JBU0UgPSBiYXNlUGF0aFxuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGNoYWxrLmdyZWVuKGBcdTI3MTMgQ3JlYXRlZCB3b3JrdHJlZSAke2NoYWxrLmJvbGQobmFtZSl9XFxuYCkpXG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoY2hhbGsuZGltKGAgIHBhdGggICAke2luZm8ucGF0aH1cXG5gKSlcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShjaGFsay5kaW0oYCAgYnJhbmNoICR7aW5mby5icmFuY2h9XFxuXFxuYCkpXG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGNvbnN0IG1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKVxuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGNoYWxrLnJlZChgW2dzZF0gRmFpbGVkIHRvIGNyZWF0ZSB3b3JrdHJlZTogJHttc2d9XFxuYCkpXG4gICAgcHJvY2Vzcy5leGl0KDEpXG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEV4cG9ydHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCB7XG4gIGhhbmRsZUxpc3QsXG4gIGhhbmRsZU1lcmdlLFxuICBoYW5kbGVDbGVhbixcbiAgaGFuZGxlUmVtb3ZlLFxuICBoYW5kbGVTdGF0dXNCYW5uZXIsXG4gIGhhbmRsZVdvcmt0cmVlRmxhZyxcbiAgZ2V0V29ya3RyZWVTdGF0dXMsXG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFvQkEsT0FBTyxXQUFXO0FBQ2xCLFNBQVMsa0JBQWtCO0FBQzNCLFNBQVMscUJBQXFCO0FBQzlCLFNBQVMsNEJBQTRCO0FBQ3JDLFNBQVMsa0JBQWtCO0FBQzNCLFNBQVMsd0NBQXdDO0FBRWpELE1BQU0sT0FBTyxXQUFXLGNBQWMsWUFBWSxHQUFHLEdBQUcsRUFBRSxnQkFBZ0IsTUFBTSxPQUFPLE1BQU0sQ0FBQztBQUM5RixNQUFNLG1CQUFtQixJQUFJLGFBQzNCLGlDQUFpQyxZQUFZLEtBQUssU0FBUyxLQUFLLEdBQUcsQ0FBQztBQUd0RSxJQUFJLE9BQWdDO0FBd0RwQyxTQUFTLGVBQWUsT0FBd0I7QUFDOUMsU0FBTyxpQkFBaUIsUUFBUSxNQUFNLFVBQVUsT0FBTyxLQUFLO0FBQzlEO0FBRUEsU0FBUyxnQkFBZ0IsT0FBZSxPQUFzQjtBQUM1RCxNQUFJLFFBQVEsSUFBSSxjQUFjLEtBQUs7QUFDakMsWUFBUSxPQUFPLE1BQU0sTUFBTSxJQUFJLFNBQVMsS0FBSyxZQUFZLGVBQWUsS0FBSyxDQUFDO0FBQUEsQ0FBSSxDQUFDO0FBQUEsRUFDckY7QUFDRjtBQUVBLGVBQWUsdUJBQWtEO0FBQy9ELE1BQUksS0FBTSxRQUFPO0FBQ2pCLFFBQU0sQ0FBQyxPQUFPLFFBQVEsV0FBVyxRQUFRLEVBQUUsSUFBSSxNQUFNLFFBQVEsSUFBSTtBQUFBLElBQy9ELEtBQUssT0FBTyxpQkFBaUIscUJBQXFCLEdBQUcsQ0FBQyxDQUFDO0FBQUEsSUFDdkQsS0FBSyxPQUFPLGlCQUFpQixrQkFBa0IsR0FBRyxDQUFDLENBQUM7QUFB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
