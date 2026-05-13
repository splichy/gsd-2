import { loadPrompt } from "./prompt-loader.js";
import { autoCommitCurrentBranch, getMainBranch, nudgeGitBranchCache } from "./worktree.js";
import { runWorktreePostCreateHook } from "./auto-worktree.js";
import { showConfirm } from "../shared/tui.js";
import { gsdRoot, milestonesDir, resolveGsdPathContract } from "./paths.js";
import {
  createWorktree,
  listWorktrees,
  removeWorktree,
  mergeWorktreeToMain,
  diffWorktreeAll,
  diffWorktreeNumstat,
  getWorktreeGSDDiff,
  getWorktreeCodeDiff,
  getWorktreeLog,
  worktreeBranchName,
  worktreePath
} from "./worktree-manager.js";
import { inferCommitType } from "./git-service.js";
import { existsSync, realpathSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { nativeMergeAbort } from "./native-git-bridge.js";
import { join } from "node:path";
import {
  clearWorktreeOriginalCwd,
  ensureWorktreeOriginalCwdFromPath,
  getActiveWorktreeName,
  getWorktreeOriginalCwd,
  setWorktreeOriginalCwd
} from "./worktree-session-state.js";
import { getActiveWorktreeName as getActiveWorktreeName2, getWorktreeOriginalCwd as getWorktreeOriginalCwd2 } from "./worktree-session-state.js";
function worktreeCompletions(prefix) {
  const parts = prefix.trim().split(/\s+/);
  const subcommands = ["list", "merge", "remove", "switch", "create", "return"];
  if (parts.length <= 1) {
    const partial = parts[0] ?? "";
    const cmdCompletions = subcommands.filter((cmd) => cmd.startsWith(partial)).map((cmd) => ({ value: cmd, label: cmd }));
    try {
      const mainBase = getWorktreeOriginalCwd() ?? process.cwd();
      const existing = listWorktrees(mainBase);
      const nameCompletions = existing.filter((wt) => wt.name.startsWith(partial)).map((wt) => ({ value: wt.name, label: wt.name }));
      return [...cmdCompletions, ...nameCompletions];
    } catch {
      return cmdCompletions;
    }
  }
  if ((parts[0] === "merge" || parts[0] === "remove" || parts[0] === "switch" || parts[0] === "create") && parts.length <= 2) {
    const namePrefix = parts[1] ?? "";
    try {
      const mainBase = getWorktreeOriginalCwd() ?? process.cwd();
      const existing = listWorktrees(mainBase);
      const nameCompletions = existing.filter((wt) => wt.name.startsWith(namePrefix)).map((wt) => ({ value: `${parts[0]} ${wt.name}`, label: wt.name }));
      if (parts[0] === "remove" && "all".startsWith(namePrefix)) {
        nameCompletions.push({ value: "remove all", label: "all" });
      }
      return nameCompletions;
    } catch {
      return [];
    }
  }
  return [];
}
async function worktreeHandler(args, ctx, pi, alias) {
  const trimmed = (typeof args === "string" ? args : "").trim();
  const basePath = process.cwd();
  if (trimmed === "") {
    ctx.ui.notify(
      [
        "Usage:",
        `  /${alias} <name>        \u2014 create and switch into a new worktree`,
        `  /${alias} switch <name> \u2014 switch into an existing worktree`,
        `  /${alias} return        \u2014 switch back to the main project tree`,
        `  /${alias} list          \u2014 list all worktrees`,
        `  /${alias} merge [name] [target] \u2014 merge worktree into target branch (auto-detects when inside a worktree)`,
        `  /${alias} remove <name|all> \u2014 remove a worktree (or all) and its branch`
      ].join("\n"),
      "info"
    );
    return;
  }
  if (trimmed === "list") {
    await handleList(basePath, ctx);
    return;
  }
  if (trimmed === "return") {
    await handleReturn(ctx);
    return;
  }
  if (trimmed.startsWith("switch ") || trimmed.startsWith("create ")) {
    const name = trimmed.replace(/^(?:switch|create)\s+/, "").trim();
    if (!name) {
      ctx.ui.notify(`Usage: /${alias} ${trimmed.split(" ")[0]} <name>`, "warning");
      return;
    }
    const mainBase2 = getWorktreeOriginalCwd() ?? basePath;
    const existing2 = listWorktrees(mainBase2);
    if (existing2.some((wt) => wt.name === name)) {
      await handleSwitch(basePath, name, ctx);
    } else {
      await handleCreate(basePath, name, ctx);
    }
    return;
  }
  if (trimmed === "merge" || trimmed.startsWith("merge ")) {
    const mergeArgs = trimmed.replace(/^merge\s*/, "").trim().split(/\s+/).filter(Boolean);
    const mainBase2 = getWorktreeOriginalCwd() ?? basePath;
    const activeWt = getActiveWorktreeName();
    if (mergeArgs.length === 0) {
      if (!activeWt) {
        ctx.ui.notify(`Usage: /${alias} merge <name> [target]`, "warning");
        return;
      }
      await handleMerge(mainBase2, activeWt, ctx, pi, void 0);
      return;
    }
    const name = mergeArgs[0];
    const targetBranch = mergeArgs[1];
    const worktrees = listWorktrees(mainBase2);
    const isWorktree = worktrees.some((w) => w.name === name);
    if (isWorktree) {
      await handleMerge(mainBase2, name, ctx, pi, targetBranch);
    } else if (activeWt) {
      await handleMerge(mainBase2, activeWt, ctx, pi, name);
    } else {
      ctx.ui.notify(`Worktree "${name}" not found. Run /${alias} list to see available worktrees.`, "warning");
    }
    return;
  }
  if (trimmed === "remove" || trimmed.startsWith("remove ")) {
    const name = trimmed.replace(/^remove\s*/, "").trim();
    const mainBase2 = getWorktreeOriginalCwd() ?? basePath;
    if (name === "all") {
      await handleRemoveAll(mainBase2, ctx);
      return;
    }
    if (!name) {
      ctx.ui.notify(`Usage: /${alias} remove <name|all>`, "warning");
      return;
    }
    await handleRemove(mainBase2, name, ctx);
    return;
  }
  const RESERVED = ["list", "return", "switch", "create", "merge", "remove"];
  if (RESERVED.includes(trimmed)) {
    ctx.ui.notify(`Usage: /${alias} ${trimmed}${trimmed === "list" || trimmed === "return" ? "" : " <name>"}`, "warning");
    return;
  }
  const mainBase = getWorktreeOriginalCwd() ?? basePath;
  const nameOnly = trimmed.split(/\s+/)[0];
  if (trimmed !== nameOnly) {
    ctx.ui.notify(`Unknown command. Did you mean /${alias} switch ${nameOnly}?`, "warning");
    return;
  }
  const existing = listWorktrees(mainBase);
  if (existing.some((wt) => wt.name === nameOnly)) {
    await handleSwitch(basePath, nameOnly, ctx);
  } else {
    await handleCreate(basePath, nameOnly, ctx);
  }
}
async function handleWorktreeCommand(args, ctx, pi, alias) {
  await worktreeHandler(args, ctx, pi, alias);
}
function registerWorktreeCommand(pi) {
  ensureWorktreeOriginalCwdFromPath();
  pi.registerCommand("worktree", {
    description: "Git worktrees (also /wt): /worktree <name> | list | merge | remove",
    getArgumentCompletions: worktreeCompletions,
    async handler(args, ctx) {
      await handleWorktreeCommand(args, ctx, pi, "worktree");
    }
  });
  pi.registerCommand("wt", {
    description: "Alias for /worktree",
    getArgumentCompletions: worktreeCompletions,
    async handler(args, ctx) {
      await handleWorktreeCommand(args, ctx, pi, "wt");
    }
  });
}
function hasExistingMilestones(wtPath) {
  const mDir = milestonesDir(wtPath);
  if (!existsSync(mDir)) return false;
  try {
    const entries = readdirSync(mDir, { withFileTypes: true }).filter((d) => d.isDirectory() && /^M\d+(?:-[a-z0-9]{6})?/.test(d.name));
    return entries.length > 0;
  } catch {
    return false;
  }
}
function clearGSDPlans(wtPath) {
  const mDir = milestonesDir(wtPath);
  if (existsSync(mDir)) {
    rmSync(mDir, { recursive: true, force: true });
  }
  const root = gsdRoot(wtPath);
  const planningFiles = ["PROJECT.md", "DECISIONS.md", "QUEUE.md", "REQUIREMENTS.md"];
  for (const file of planningFiles) {
    const filePath = join(root, file);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  }
}
async function handleCreate(basePath, name, ctx) {
  try {
    const commitMsg = autoCommitCurrentBranch(basePath, "worktree-switch", name);
    const mainBase = getWorktreeOriginalCwd() ?? basePath;
    const info = createWorktree(mainBase, name);
    const hookError = runWorktreePostCreateHook(mainBase, info.path);
    if (hookError) {
      ctx.ui.notify(hookError, "warning");
    }
    if (!getWorktreeOriginalCwd()) setWorktreeOriginalCwd(basePath);
    const prevCwd = process.cwd();
    process.chdir(info.path);
    nudgeGitBranchCache(prevCwd);
    let clearedPlans = false;
    if (hasExistingMilestones(info.path)) {
      const keepExisting = await showConfirm(ctx, {
        title: "Worktree Setup",
        message: [
          `This worktree inherited existing GSD milestones from the main branch.`,
          ``,
          `  Continue \u2014 keep milestones and pick up where main left off`,
          `  Start fresh \u2014 clear milestones so /gsd auto starts a new project`
        ].join("\n"),
        confirmLabel: "Continue",
        declineLabel: "Start fresh"
      });
      if (!keepExisting) {
        clearGSDPlans(info.path);
        clearedPlans = true;
      }
    }
    const commitNote = commitMsg ? `  ${CLR.muted("Auto-committed on previous branch before switching.")}` : "";
    const freshNote = clearedPlans ? `  ${CLR.ok("\u2713")} Cleared milestones \u2014 ${CLR.hint("/gsd auto")} will start fresh.` : "";
    ctx.ui.notify(
      [
        `${CLR.ok("\u2713")} Worktree ${CLR.name(name)} created and activated.`,
        "",
        `  ${CLR.label("path")}     ${CLR.path(info.path)}`,
        `  ${CLR.label("branch")}   ${CLR.branch(info.branch)}`,
        commitNote,
        freshNote,
        "",
        `  ${CLR.hint(`/worktree merge ${name}`)}  ${CLR.muted("merge back when done")}`,
        `  ${CLR.hint("/worktree return")}${" ".repeat(Math.max(1, name.length - 2))}  ${CLR.muted("switch back to main tree")}`
      ].filter(Boolean).join("\n"),
      "info"
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to create worktree: ${msg}`, "error");
  }
}
async function handleSwitch(basePath, name, ctx) {
  try {
    const mainBase = getWorktreeOriginalCwd() ?? basePath;
    const wtPath = worktreePath(mainBase, name);
    if (!existsSync(wtPath)) {
      ctx.ui.notify(
        `Worktree "${name}" not found. Run /worktree list to see available worktrees.`,
        "warning"
      );
      return;
    }
    const commitMsg = autoCommitCurrentBranch(basePath, "worktree-switch", name);
    if (!getWorktreeOriginalCwd()) setWorktreeOriginalCwd(basePath);
    const prevCwd = process.cwd();
    process.chdir(wtPath);
    nudgeGitBranchCache(prevCwd);
    const commitNote = commitMsg ? `  ${CLR.muted("Auto-committed on previous branch before switching.")}` : "";
    ctx.ui.notify(
      [
        `${CLR.ok("\u2713")} Switched to worktree ${CLR.name(name)}.`,
        "",
        `  ${CLR.label("path")}     ${CLR.path(wtPath)}`,
        `  ${CLR.label("branch")}   ${CLR.branch(worktreeBranchName(name))}`,
        commitNote,
        "",
        `  ${CLR.hint("/worktree return")}  ${CLR.muted("switch back to main tree")}`
      ].filter(Boolean).join("\n"),
      "info"
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to switch to worktree: ${msg}`, "error");
  }
}
async function handleReturn(ctx) {
  const originalCwd = getWorktreeOriginalCwd();
  if (!originalCwd) {
    ctx.ui.notify("Already in the main project tree.", "info");
    return;
  }
  const commitMsg = autoCommitCurrentBranch(process.cwd(), "worktree-return", "worktree");
  const returnTo = originalCwd;
  clearWorktreeOriginalCwd();
  const prevCwd = process.cwd();
  process.chdir(returnTo);
  nudgeGitBranchCache(prevCwd);
  const commitNote = commitMsg ? `  ${CLR.muted("Auto-committed on worktree branch before returning.")}` : "";
  ctx.ui.notify(
    [
      `${CLR.ok("\u2713")} Returned to main project tree.`,
      "",
      `  ${CLR.label("path")}  ${CLR.path(returnTo)}`,
      commitNote
    ].filter(Boolean).join("\n"),
    "info"
  );
}
const BOLD = "\x1B[1m";
const DIM = "\x1B[2m";
const RESET = "\x1B[0m";
const CYAN = "\x1B[36m";
const GREEN = "\x1B[32m";
const RED = "\x1B[31m";
const YELLOW = "\x1B[33m";
const WHITE = "\x1B[37m";
const MAGENTA = "\x1B[35m";
const CLR = {
  /** Worktree names and primary emphasis */
  name: (s) => `${BOLD}${CYAN}${s}${RESET}`,
  /** Active worktree name */
  nameActive: (s) => `${BOLD}${GREEN}${s}${RESET}`,
  /** Branch names */
  branch: (s) => `${MAGENTA}${s}${RESET}`,
  /** File paths */
  path: (s) => `${DIM}${s}${RESET}`,
  /** Labels (key in key:value pairs) */
  label: (s) => `${WHITE}${s}${RESET}`,
  /** Hints and commands the user can run */
  hint: (s) => `${DIM}${CYAN}${s}${RESET}`,
  /** Success messages and checks */
  ok: (s) => `${GREEN}${s}${RESET}`,
  /** Warning badges */
  warn: (s) => `${YELLOW}${s}${RESET}`,
  /** Section headers */
  header: (s) => `${BOLD}${WHITE}${s}${RESET}`,
  /** Muted secondary info */
  muted: (s) => `${DIM}${s}${RESET}`
};
async function handleList(basePath, ctx) {
  try {
    const mainBase = getWorktreeOriginalCwd() ?? basePath;
    const worktrees = listWorktrees(mainBase);
    if (worktrees.length === 0) {
      ctx.ui.notify("No GSD worktrees found. Create one with /worktree <name>.", "info");
      return;
    }
    const { getAllWorktreeHealth, formatWorktreeStatusLine } = await import("./worktree-health.js");
    const healthMap = /* @__PURE__ */ new Map();
    try {
      const statuses = getAllWorktreeHealth(mainBase);
      for (const s of statuses) healthMap.set(s.worktree.name, s);
    } catch {
    }
    const cwd = process.cwd();
    const lines = [CLR.header("GSD Worktrees"), ""];
    for (const wt of worktrees) {
      const isCurrent = cwd === wt.path || existsSync(cwd) && existsSync(wt.path) && realpathSync(cwd) === realpathSync(wt.path);
      const styledName = isCurrent ? CLR.nameActive(wt.name) : CLR.name(wt.name);
      const badge = isCurrent ? `  ${CLR.ok("\u25CF active")}` : !wt.exists ? `  ${CLR.warn("\u2717 missing")}` : "";
      lines.push(`  ${styledName}${badge}`);
      lines.push(`    ${CLR.label("branch")}  ${CLR.branch(wt.branch)}`);
      lines.push(`    ${CLR.label("path")}    ${CLR.path(wt.path)}`);
      const health = healthMap.get(wt.name);
      if (health) {
        const statusLine = formatWorktreeStatusLine(health);
        const statusColor = health.safeToRemove ? CLR.ok(statusLine) : health.stale || health.dirty ? CLR.warn(statusLine) : CLR.muted(statusLine);
        lines.push(`    ${CLR.label("status")}  ${statusColor}`);
      }
      lines.push("");
    }
    const originalCwd = getWorktreeOriginalCwd();
    if (originalCwd) {
      lines.push(`  ${CLR.label("main tree")}  ${CLR.path(originalCwd)}`);
    }
    ctx.ui.notify(lines.join("\n"), "info");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to list worktrees: ${msg}`, "error");
  }
}
async function handleMerge(basePath, name, ctx, pi, targetBranch) {
  try {
    const branch = worktreeBranchName(name);
    const mainBranch = targetBranch ?? getMainBranch(basePath);
    const worktrees = listWorktrees(basePath);
    const wt = worktrees.find((w) => w.name === name);
    if (!wt) {
      ctx.ui.notify(`Worktree "${name}" not found. Run /worktree list to see available worktrees.`, "warning");
      return;
    }
    const diffSummary = diffWorktreeAll(basePath, name);
    const numstat = diffWorktreeNumstat(basePath, name);
    const gsdDiff = getWorktreeGSDDiff(basePath, name);
    const codeDiff = getWorktreeCodeDiff(basePath, name);
    const commitLog = getWorktreeLog(basePath, name);
    const totalChanges = diffSummary.added.length + diffSummary.modified.length + diffSummary.removed.length;
    if (totalChanges === 0 && !commitLog.trim()) {
      ctx.ui.notify(`Worktree ${CLR.name(name)} has no changes to merge.`, "info");
      return;
    }
    const statMap = /* @__PURE__ */ new Map();
    for (const s of numstat) statMap.set(s.file, s);
    let totalAdded = 0;
    let totalRemoved = 0;
    for (const s of numstat) {
      totalAdded += s.added;
      totalRemoved += s.removed;
    }
    const isGSD = (f) => f.startsWith(".gsd/");
    const codeChanges = diffSummary.added.filter((f) => !isGSD(f)).length + diffSummary.modified.filter((f) => !isGSD(f)).length + diffSummary.removed.filter((f) => !isGSD(f)).length;
    const gsdChanges = diffSummary.added.filter(isGSD).length + diffSummary.modified.filter(isGSD).length + diffSummary.removed.filter(isGSD).length;
    const formatFileLine = (prefix, file) => {
      const s = statMap.get(file);
      const stat = s ? ` ${CLR.ok(`+${s.added}`)} ${RED}-${s.removed}${RESET}` : "";
      return `    ${prefix} ${file}${stat}`;
    };
    const previewLines = [
      `Merge ${CLR.name(name)} \u2192 ${CLR.branch(mainBranch)}`,
      "",
      `  ${totalChanges} file${totalChanges === 1 ? "" : "s"} changed, ${CLR.ok(`+${totalAdded}`)} ${RED}-${totalRemoved}${RESET} lines ${CLR.muted(`(${codeChanges} code, ${gsdChanges} GSD)`)}`
    ];
    const appendFileList = (label, files, prefix, limit = 10) => {
      if (files.length === 0) return;
      previewLines.push("", `  ${label}:`);
      for (const f of files.slice(0, limit)) previewLines.push(formatFileLine(prefix, f));
      if (files.length > limit) previewLines.push(`    \u2026 and ${files.length - limit} more`);
    };
    appendFileList("Added", diffSummary.added, "+");
    appendFileList("Modified", diffSummary.modified, "~");
    appendFileList("Removed", diffSummary.removed, "-");
    const confirmed = await showConfirm(ctx, {
      title: "Worktree Merge",
      message: previewLines.join("\n"),
      confirmLabel: "Merge",
      declineLabel: "Cancel"
    });
    if (!confirmed) {
      ctx.ui.notify("Merge cancelled.", "info");
      return;
    }
    if (getWorktreeOriginalCwd()) {
      const prevCwd = process.cwd();
      process.chdir(basePath);
      nudgeGitBranchCache(prevCwd);
      clearWorktreeOriginalCwd();
    }
    const commitType = inferCommitType(name);
    const commitMessage = `${commitType}: merge worktree ${name}

GSD-Worktree: ${name}`;
    const contract = resolveGsdPathContract(worktreePath(basePath, name), basePath);
    const wtDbPath = join(contract.worktreeGsd ?? join(contract.workRoot, ".gsd"), "gsd.db");
    const mainDbPath = contract.projectDb;
    if (existsSync(wtDbPath) && existsSync(mainDbPath)) {
      try {
        const { reconcileWorktreeDb } = await import("./gsd-db.js");
        reconcileWorktreeDb(mainDbPath, wtDbPath);
      } catch {
      }
    }
    try {
      mergeWorktreeToMain(basePath, name, commitMessage);
      ctx.ui.notify(
        [
          `${CLR.ok("\u2713")} Merged ${CLR.name(name)} \u2192 ${CLR.branch(mainBranch)} ${CLR.muted("(deterministic squash)")}`,
          "",
          `  ${totalChanges} file${totalChanges === 1 ? "" : "s"} changed, ${CLR.ok(`+${totalAdded}`)} ${RED}-${totalRemoved}${RESET} lines`,
          `  ${CLR.muted("commit:")} ${commitMessage}`
        ].join("\n"),
        "info"
      );
      return;
    } catch (mergeErr) {
      const mergeMsg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
      const isConflict = /conflict/i.test(mergeMsg);
      if (isConflict) {
        try {
          nativeMergeAbort(basePath);
        } catch {
        }
        ctx.ui.notify(
          `${CLR.muted("Deterministic merge hit conflicts \u2014 falling back to LLM-guided merge.")}`,
          "warning"
        );
      } else {
        ctx.ui.notify(`Failed to merge: ${mergeMsg}`, "error");
        return;
      }
    }
    const formatFiles = (files) => files.length > 0 ? files.map((f) => `- \`${f}\``).join("\n") : "_(none)_";
    const wtPath = worktreePath(basePath, name);
    const prompt = loadPrompt("worktree-merge", {
      worktreeName: name,
      worktreeBranch: branch,
      mainBranch,
      mainTreePath: basePath,
      worktreePath: wtPath,
      commitLog: commitLog || "(no commits)",
      addedFiles: formatFiles(diffSummary.added),
      modifiedFiles: formatFiles(diffSummary.modified),
      removedFiles: formatFiles(diffSummary.removed),
      gsdDiff: gsdDiff || "(no GSD artifact changes)",
      codeDiff: codeDiff || "(no code changes)"
    });
    pi.sendMessage(
      {
        customType: "gsd-worktree-merge",
        content: prompt,
        display: false
      },
      { triggerTurn: true }
    );
    ctx.ui.notify(
      `${CLR.ok("\u2713")} Merge helper started for ${CLR.name(name)} ${CLR.muted(`(${codeChanges} code + ${gsdChanges} GSD artifact change${totalChanges === 1 ? "" : "s"})`)}`,
      "info"
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to start merge: ${msg}`, "error");
  }
}
async function handleRemove(basePath, name, ctx) {
  try {
    const mainBase = getWorktreeOriginalCwd() ?? basePath;
    const worktrees = listWorktrees(mainBase);
    const wt = worktrees.find((w) => w.name === name);
    if (!wt) {
      ctx.ui.notify(`Worktree "${name}" not found. Run /worktree list to see available worktrees.`, "warning");
      return;
    }
    const confirmed = await showConfirm(ctx, {
      title: "Remove Worktree",
      message: `Remove worktree ${CLR.name(name)} and delete branch ${CLR.branch(wt.branch)}?`,
      confirmLabel: "Remove",
      declineLabel: "Cancel"
    });
    if (!confirmed) {
      ctx.ui.notify("Cancelled.", "info");
      return;
    }
    const prevCwd = process.cwd();
    removeWorktree(mainBase, name, { deleteBranch: true });
    if (getWorktreeOriginalCwd() && process.cwd() !== prevCwd) {
      nudgeGitBranchCache(prevCwd);
      clearWorktreeOriginalCwd();
    }
    ctx.ui.notify(`${CLR.ok("\u2713")} Worktree ${CLR.name(name)} removed ${CLR.muted("(branch deleted)")}.`, "info");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to remove worktree: ${msg}`, "error");
  }
}
async function handleRemoveAll(basePath, ctx) {
  try {
    const mainBase = getWorktreeOriginalCwd() ?? basePath;
    const worktrees = listWorktrees(mainBase);
    if (worktrees.length === 0) {
      ctx.ui.notify("No worktrees to remove.", "info");
      return;
    }
    const names = worktrees.map((w) => w.name);
    const confirmed = await showConfirm(ctx, {
      title: "Remove All Worktrees",
      message: `Remove ${worktrees.length} worktree${worktrees.length === 1 ? "" : "s"} and delete their branches?

${names.map((n) => `  \u2022 ${CLR.name(n)}`).join("\n")}`,
      confirmLabel: "Remove all",
      declineLabel: "Cancel"
    });
    if (!confirmed) {
      ctx.ui.notify("Cancelled.", "info");
      return;
    }
    const prevCwd = process.cwd();
    const removed = [];
    const failed = [];
    for (const wt of worktrees) {
      try {
        removeWorktree(mainBase, wt.name, { deleteBranch: true });
        removed.push(wt.name);
      } catch {
        failed.push(wt.name);
      }
    }
    if (getWorktreeOriginalCwd() && process.cwd() !== prevCwd) {
      nudgeGitBranchCache(prevCwd);
      clearWorktreeOriginalCwd();
    }
    const lines = [];
    if (removed.length > 0) lines.push(`${CLR.ok("\u2713")} Removed: ${removed.map((n) => CLR.name(n)).join(", ")}`);
    if (failed.length > 0) lines.push(`${CLR.warn("\u2717")} Failed: ${failed.map((n) => CLR.name(n)).join(", ")}`);
    ctx.ui.notify(lines.join("\n"), failed.length > 0 ? "warning" : "info");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to remove worktrees: ${msg}`, "error");
  }
}
export {
  getActiveWorktreeName2 as getActiveWorktreeName,
  getWorktreeOriginalCwd2 as getWorktreeOriginalCwd,
  handleWorktreeCommand,
  registerWorktreeCommand
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC93b3JrdHJlZS1jb21tYW5kLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIEdTRCBXb3JrdHJlZSBDb21tYW5kIFx1MjAxNCAvd29ya3RyZWVcbiAqXG4gKiBDcmVhdGUsIGxpc3QsIG1lcmdlLCBhbmQgcmVtb3ZlIGdpdCB3b3JrdHJlZXMgdW5kZXIgLmdzZC93b3JrdHJlZXMvLlxuICpcbiAqIFVzYWdlOlxuICogICAvd29ya3RyZWUgPG5hbWU+ICAgICAgICBcdTIwMTQgY3JlYXRlIGEgbmV3IHdvcmt0cmVlXG4gKiAgIC93b3JrdHJlZSBsaXN0ICAgICAgICAgIFx1MjAxNCBsaXN0IGV4aXN0aW5nIHdvcmt0cmVlc1xuICogICAvd29ya3RyZWUgbWVyZ2UgW25hbWVdIFt0YXJnZXRdIFx1MjAxNCBzdGFydCBMTE0tZ3VpZGVkIG1lcmdlIChhdXRvLWRldGVjdHMgd2hlbiBpbnNpZGUgYSB3b3JrdHJlZSlcbiAqICAgL3dvcmt0cmVlIHJlbW92ZSA8bmFtZT4gXHUyMDE0IHJlbW92ZSBhIHdvcmt0cmVlIGFuZCBpdHMgYnJhbmNoXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBFeHRlbnNpb25BUEksIEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0IH0gZnJvbSBcIkBnc2QvcGktY29kaW5nLWFnZW50XCI7XG5pbXBvcnQgeyBsb2FkUHJvbXB0IH0gZnJvbSBcIi4vcHJvbXB0LWxvYWRlci5qc1wiO1xuaW1wb3J0IHsgYXV0b0NvbW1pdEN1cnJlbnRCcmFuY2gsIGdldE1haW5CcmFuY2gsIHJlc29sdmVHaXRIZWFkUGF0aCwgbnVkZ2VHaXRCcmFuY2hDYWNoZSB9IGZyb20gXCIuL3dvcmt0cmVlLmpzXCI7XG5pbXBvcnQgeyBydW5Xb3JrdHJlZVBvc3RDcmVhdGVIb29rIH0gZnJvbSBcIi4vYXV0by13b3JrdHJlZS5qc1wiO1xuaW1wb3J0IHsgc2hvd0NvbmZpcm0gfSBmcm9tIFwiLi4vc2hhcmVkL3R1aS5qc1wiO1xuaW1wb3J0IHsgZ3NkUm9vdCwgbWlsZXN0b25lc0RpciwgcmVzb2x2ZUdzZFBhdGhDb250cmFjdCB9IGZyb20gXCIuL3BhdGhzLmpzXCI7XG5pbXBvcnQge1xuICBjcmVhdGVXb3JrdHJlZSxcbiAgbGlzdFdvcmt0cmVlcyxcbiAgcmVtb3ZlV29ya3RyZWUsXG4gIG1lcmdlV29ya3RyZWVUb01haW4sXG4gIGRpZmZXb3JrdHJlZUFsbCxcbiAgZGlmZldvcmt0cmVlTnVtc3RhdCxcbiAgZ2V0V29ya3RyZWVHU0REaWZmLFxuICBnZXRXb3JrdHJlZUNvZGVEaWZmLFxuICBnZXRXb3JrdHJlZUxvZyxcbiAgd29ya3RyZWVCcmFuY2hOYW1lLFxuICB3b3JrdHJlZVBhdGgsXG59IGZyb20gXCIuL3dvcmt0cmVlLW1hbmFnZXIuanNcIjtcbmltcG9ydCB7IGluZmVyQ29tbWl0VHlwZSB9IGZyb20gXCIuL2dpdC1zZXJ2aWNlLmpzXCI7XG5pbXBvcnQgdHlwZSB7IEZpbGVMaW5lU3RhdCB9IGZyb20gXCIuL3dvcmt0cmVlLW1hbmFnZXIuanNcIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMsIHJlYWxwYXRoU3luYywgcmVhZGRpclN5bmMsIHJtU3luYywgdW5saW5rU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBuYXRpdmVNZXJnZUFib3J0IH0gZnJvbSBcIi4vbmF0aXZlLWdpdC1icmlkZ2UuanNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQge1xuICBjbGVhcldvcmt0cmVlT3JpZ2luYWxDd2QsXG4gIGVuc3VyZVdvcmt0cmVlT3JpZ2luYWxDd2RGcm9tUGF0aCxcbiAgZ2V0QWN0aXZlV29ya3RyZWVOYW1lLFxuICBnZXRXb3JrdHJlZU9yaWdpbmFsQ3dkLFxuICBzZXRXb3JrdHJlZU9yaWdpbmFsQ3dkLFxufSBmcm9tIFwiLi93b3JrdHJlZS1zZXNzaW9uLXN0YXRlLmpzXCI7XG5cbmV4cG9ydCB7IGdldEFjdGl2ZVdvcmt0cmVlTmFtZSwgZ2V0V29ya3RyZWVPcmlnaW5hbEN3ZCB9IGZyb20gXCIuL3dvcmt0cmVlLXNlc3Npb24tc3RhdGUuanNcIjtcblxuLyoqXG4gKiBUcmFja3MgdGhlIG9yaWdpbmFsIHByb2plY3Qgcm9vdCBzbyB3ZSBjYW4gc3dpdGNoIGJhY2suXG4gKiBTZXQgd2hlbiB3ZSBmaXJzdCBjaGRpciBpbnRvIGEgd29ya3RyZWUsIGNsZWFyZWQgb24gcmV0dXJuLlxuICovXG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTaGFyZWQgY29tcGxldGlvbnMgYW5kIGhhbmRsZXIgKHVzZWQgYnkgYm90aCAvd29ya3RyZWUgYW5kIC93dCkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIHdvcmt0cmVlQ29tcGxldGlvbnMocHJlZml4OiBzdHJpbmcpIHtcbiAgY29uc3QgcGFydHMgPSBwcmVmaXgudHJpbSgpLnNwbGl0KC9cXHMrLyk7XG4gIGNvbnN0IHN1YmNvbW1hbmRzID0gW1wibGlzdFwiLCBcIm1lcmdlXCIsIFwicmVtb3ZlXCIsIFwic3dpdGNoXCIsIFwiY3JlYXRlXCIsIFwicmV0dXJuXCJdO1xuXG4gIGlmIChwYXJ0cy5sZW5ndGggPD0gMSkge1xuICAgIGNvbnN0IHBhcnRpYWwgPSBwYXJ0c1swXSA/PyBcIlwiO1xuICAgIGNvbnN0IGNtZENvbXBsZXRpb25zID0gc3ViY29tbWFuZHNcbiAgICAgIC5maWx0ZXIoY21kID0+IGNtZC5zdGFydHNXaXRoKHBhcnRpYWwpKVxuICAgICAgLm1hcChjbWQgPT4gKHsgdmFsdWU6IGNtZCwgbGFiZWw6IGNtZCB9KSk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IG1haW5CYXNlID0gZ2V0V29ya3RyZWVPcmlnaW5hbEN3ZCgpID8/IHByb2Nlc3MuY3dkKCk7XG4gICAgICBjb25zdCBleGlzdGluZyA9IGxpc3RXb3JrdHJlZXMobWFpbkJhc2UpO1xuICAgICAgY29uc3QgbmFtZUNvbXBsZXRpb25zID0gZXhpc3RpbmdcbiAgICAgICAgLmZpbHRlcih3dCA9PiB3dC5uYW1lLnN0YXJ0c1dpdGgocGFydGlhbCkpXG4gICAgICAgIC5tYXAod3QgPT4gKHsgdmFsdWU6IHd0Lm5hbWUsIGxhYmVsOiB3dC5uYW1lIH0pKTtcbiAgICAgIHJldHVybiBbLi4uY21kQ29tcGxldGlvbnMsIC4uLm5hbWVDb21wbGV0aW9uc107XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gY21kQ29tcGxldGlvbnM7XG4gICAgfVxuICB9XG5cbiAgaWYgKChwYXJ0c1swXSA9PT0gXCJtZXJnZVwiIHx8IHBhcnRzWzBdID09PSBcInJlbW92ZVwiIHx8IHBhcnRzWzBdID09PSBcInN3aXRjaFwiIHx8IHBhcnRzWzBdID09PSBcImNyZWF0ZVwiKSAmJiBwYXJ0cy5sZW5ndGggPD0gMikge1xuICAgIGNvbnN0IG5hbWVQcmVmaXggPSBwYXJ0c1sxXSA/PyBcIlwiO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBtYWluQmFzZSA9IGdldFdvcmt0cmVlT3JpZ2luYWxDd2QoKSA/PyBwcm9jZXNzLmN3ZCgpO1xuICAgICAgY29uc3QgZXhpc3RpbmcgPSBsaXN0V29ya3RyZWVzKG1haW5CYXNlKTtcbiAgICAgIGNvbnN0IG5hbWVDb21wbGV0aW9ucyA9IGV4aXN0aW5nXG4gICAgICAgIC5maWx0ZXIod3QgPT4gd3QubmFtZS5zdGFydHNXaXRoKG5hbWVQcmVmaXgpKVxuICAgICAgICAubWFwKHd0ID0+ICh7IHZhbHVlOiBgJHtwYXJ0c1swXX0gJHt3dC5uYW1lfWAsIGxhYmVsOiB3dC5uYW1lIH0pKTtcblxuICAgICAgLy8gQWRkIFwiYWxsXCIgb3B0aW9uIGZvciByZW1vdmVcbiAgICAgIGlmIChwYXJ0c1swXSA9PT0gXCJyZW1vdmVcIiAmJiBcImFsbFwiLnN0YXJ0c1dpdGgobmFtZVByZWZpeCkpIHtcbiAgICAgICAgbmFtZUNvbXBsZXRpb25zLnB1c2goeyB2YWx1ZTogXCJyZW1vdmUgYWxsXCIsIGxhYmVsOiBcImFsbFwiIH0pO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gbmFtZUNvbXBsZXRpb25zO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIFtdO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiBbXTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gd29ya3RyZWVIYW5kbGVyKFxuICBhcmdzOiBzdHJpbmcsXG4gIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsXG4gIHBpOiBFeHRlbnNpb25BUEksXG4gIGFsaWFzOiBzdHJpbmcsXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgdHJpbW1lZCA9ICh0eXBlb2YgYXJncyA9PT0gXCJzdHJpbmdcIiA/IGFyZ3MgOiBcIlwiKS50cmltKCk7XG4gIGNvbnN0IGJhc2VQYXRoID0gcHJvY2Vzcy5jd2QoKTtcblxuICBpZiAodHJpbW1lZCA9PT0gXCJcIikge1xuICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICBbXG4gICAgICAgIFwiVXNhZ2U6XCIsXG4gICAgICAgIGAgIC8ke2FsaWFzfSA8bmFtZT4gICAgICAgIFx1MjAxNCBjcmVhdGUgYW5kIHN3aXRjaCBpbnRvIGEgbmV3IHdvcmt0cmVlYCxcbiAgICAgICAgYCAgLyR7YWxpYXN9IHN3aXRjaCA8bmFtZT4gXHUyMDE0IHN3aXRjaCBpbnRvIGFuIGV4aXN0aW5nIHdvcmt0cmVlYCxcbiAgICAgICAgYCAgLyR7YWxpYXN9IHJldHVybiAgICAgICAgXHUyMDE0IHN3aXRjaCBiYWNrIHRvIHRoZSBtYWluIHByb2plY3QgdHJlZWAsXG4gICAgICAgIGAgIC8ke2FsaWFzfSBsaXN0ICAgICAgICAgIFx1MjAxNCBsaXN0IGFsbCB3b3JrdHJlZXNgLFxuICAgICAgICBgICAvJHthbGlhc30gbWVyZ2UgW25hbWVdIFt0YXJnZXRdIFx1MjAxNCBtZXJnZSB3b3JrdHJlZSBpbnRvIHRhcmdldCBicmFuY2ggKGF1dG8tZGV0ZWN0cyB3aGVuIGluc2lkZSBhIHdvcmt0cmVlKWAsXG4gICAgICAgIGAgIC8ke2FsaWFzfSByZW1vdmUgPG5hbWV8YWxsPiBcdTIwMTQgcmVtb3ZlIGEgd29ya3RyZWUgKG9yIGFsbCkgYW5kIGl0cyBicmFuY2hgLFxuICAgICAgXS5qb2luKFwiXFxuXCIpLFxuICAgICAgXCJpbmZvXCIsXG4gICAgKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAodHJpbW1lZCA9PT0gXCJsaXN0XCIpIHtcbiAgICBhd2FpdCBoYW5kbGVMaXN0KGJhc2VQYXRoLCBjdHgpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICh0cmltbWVkID09PSBcInJldHVyblwiKSB7XG4gICAgYXdhaXQgaGFuZGxlUmV0dXJuKGN0eCk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKHRyaW1tZWQuc3RhcnRzV2l0aChcInN3aXRjaCBcIikgfHwgdHJpbW1lZC5zdGFydHNXaXRoKFwiY3JlYXRlIFwiKSkge1xuICAgIGNvbnN0IG5hbWUgPSB0cmltbWVkLnJlcGxhY2UoL14oPzpzd2l0Y2h8Y3JlYXRlKVxccysvLCBcIlwiKS50cmltKCk7XG4gICAgaWYgKCFuYW1lKSB7XG4gICAgICBjdHgudWkubm90aWZ5KGBVc2FnZTogLyR7YWxpYXN9ICR7dHJpbW1lZC5zcGxpdChcIiBcIilbMF19IDxuYW1lPmAsIFwid2FybmluZ1wiKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgLy8gY3JlYXRlIGFuZCBzd2l0Y2ggYm90aCBkbyB0aGUgc2FtZSB0aGluZzogc3dpdGNoIGlmIGV4aXN0cywgY3JlYXRlIGlmIG5vdFxuICAgIGNvbnN0IG1haW5CYXNlID0gZ2V0V29ya3RyZWVPcmlnaW5hbEN3ZCgpID8/IGJhc2VQYXRoO1xuICAgIGNvbnN0IGV4aXN0aW5nID0gbGlzdFdvcmt0cmVlcyhtYWluQmFzZSk7XG4gICAgaWYgKGV4aXN0aW5nLnNvbWUod3QgPT4gd3QubmFtZSA9PT0gbmFtZSkpIHtcbiAgICAgIGF3YWl0IGhhbmRsZVN3aXRjaChiYXNlUGF0aCwgbmFtZSwgY3R4KTtcbiAgICB9IGVsc2Uge1xuICAgICAgYXdhaXQgaGFuZGxlQ3JlYXRlKGJhc2VQYXRoLCBuYW1lLCBjdHgpO1xuICAgIH1cbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAodHJpbW1lZCA9PT0gXCJtZXJnZVwiIHx8IHRyaW1tZWQuc3RhcnRzV2l0aChcIm1lcmdlIFwiKSkge1xuICAgIGNvbnN0IG1lcmdlQXJncyA9IHRyaW1tZWQucmVwbGFjZSgvXm1lcmdlXFxzKi8sIFwiXCIpLnRyaW0oKS5zcGxpdCgvXFxzKy8pLmZpbHRlcihCb29sZWFuKTtcbiAgICBjb25zdCBtYWluQmFzZSA9IGdldFdvcmt0cmVlT3JpZ2luYWxDd2QoKSA/PyBiYXNlUGF0aDtcbiAgICBjb25zdCBhY3RpdmVXdCA9IGdldEFjdGl2ZVdvcmt0cmVlTmFtZSgpO1xuXG4gICAgaWYgKG1lcmdlQXJncy5sZW5ndGggPT09IDApIHtcbiAgICAgIC8vIEJhcmUgXCIvd29ya3RyZWUgbWVyZ2VcIiBcdTIwMTQgb25seSB2YWxpZCB3aGVuIGluc2lkZSBhIHdvcmt0cmVlXG4gICAgICBpZiAoIWFjdGl2ZVd0KSB7XG4gICAgICAgIGN0eC51aS5ub3RpZnkoYFVzYWdlOiAvJHthbGlhc30gbWVyZ2UgPG5hbWU+IFt0YXJnZXRdYCwgXCJ3YXJuaW5nXCIpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBhd2FpdCBoYW5kbGVNZXJnZShtYWluQmFzZSwgYWN0aXZlV3QsIGN0eCwgcGksIHVuZGVmaW5lZCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgbmFtZSA9IG1lcmdlQXJnc1swXSE7XG4gICAgY29uc3QgdGFyZ2V0QnJhbmNoID0gbWVyZ2VBcmdzWzFdO1xuXG4gICAgLy8gQ2hlY2sgaWYgJ25hbWUnIGlzIGFuIGFjdHVhbCB3b3JrdHJlZVxuICAgIGNvbnN0IHdvcmt0cmVlcyA9IGxpc3RXb3JrdHJlZXMobWFpbkJhc2UpO1xuICAgIGNvbnN0IGlzV29ya3RyZWUgPSB3b3JrdHJlZXMuc29tZSh3ID0+IHcubmFtZSA9PT0gbmFtZSk7XG5cbiAgICBpZiAoaXNXb3JrdHJlZSkge1xuICAgICAgYXdhaXQgaGFuZGxlTWVyZ2UobWFpbkJhc2UsIG5hbWUsIGN0eCwgcGksIHRhcmdldEJyYW5jaCk7XG4gICAgfSBlbHNlIGlmIChhY3RpdmVXdCkge1xuICAgICAgLy8gTm90IGEgd29ya3RyZWUgbmFtZSBcdTIwMTQgdXNlciBpcyBpbiBhIHdvcmt0cmVlIGFuZCBnYXZlIHRoZSB0YXJnZXQgYnJhbmNoXG4gICAgICAvLyBlLmcuIFwiL3dvcmt0cmVlIG1lcmdlIG1haW5cIiB3aGlsZSBpbnNpZGUgd29ya3RyZWUgXCJuZXdcIlxuICAgICAgYXdhaXQgaGFuZGxlTWVyZ2UobWFpbkJhc2UsIGFjdGl2ZVd0LCBjdHgsIHBpLCBuYW1lKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY3R4LnVpLm5vdGlmeShgV29ya3RyZWUgXCIke25hbWV9XCIgbm90IGZvdW5kLiBSdW4gLyR7YWxpYXN9IGxpc3QgdG8gc2VlIGF2YWlsYWJsZSB3b3JrdHJlZXMuYCwgXCJ3YXJuaW5nXCIpO1xuICAgIH1cbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAodHJpbW1lZCA9PT0gXCJyZW1vdmVcIiB8fCB0cmltbWVkLnN0YXJ0c1dpdGgoXCJyZW1vdmUgXCIpKSB7XG4gICAgY29uc3QgbmFtZSA9IHRyaW1tZWQucmVwbGFjZSgvXnJlbW92ZVxccyovLCBcIlwiKS50cmltKCk7XG4gICAgY29uc3QgbWFpbkJhc2UgPSBnZXRXb3JrdHJlZU9yaWdpbmFsQ3dkKCkgPz8gYmFzZVBhdGg7XG5cbiAgICBpZiAobmFtZSA9PT0gXCJhbGxcIikge1xuICAgICAgYXdhaXQgaGFuZGxlUmVtb3ZlQWxsKG1haW5CYXNlLCBjdHgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmICghbmFtZSkge1xuICAgICAgY3R4LnVpLm5vdGlmeShgVXNhZ2U6IC8ke2FsaWFzfSByZW1vdmUgPG5hbWV8YWxsPmAsIFwid2FybmluZ1wiKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBhd2FpdCBoYW5kbGVSZW1vdmUobWFpbkJhc2UsIG5hbWUsIGN0eCk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgUkVTRVJWRUQgPSBbXCJsaXN0XCIsIFwicmV0dXJuXCIsIFwic3dpdGNoXCIsIFwiY3JlYXRlXCIsIFwibWVyZ2VcIiwgXCJyZW1vdmVcIl07XG4gIGlmIChSRVNFUlZFRC5pbmNsdWRlcyh0cmltbWVkKSkge1xuICAgIGN0eC51aS5ub3RpZnkoYFVzYWdlOiAvJHthbGlhc30gJHt0cmltbWVkfSR7dHJpbW1lZCA9PT0gXCJsaXN0XCIgfHwgdHJpbW1lZCA9PT0gXCJyZXR1cm5cIiA/IFwiXCIgOiBcIiA8bmFtZT5cIn1gLCBcIndhcm5pbmdcIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgbWFpbkJhc2UgPSBnZXRXb3JrdHJlZU9yaWdpbmFsQ3dkKCkgPz8gYmFzZVBhdGg7XG4gIGNvbnN0IG5hbWVPbmx5ID0gdHJpbW1lZC5zcGxpdCgvXFxzKy8pWzBdITtcbiAgaWYgKHRyaW1tZWQgIT09IG5hbWVPbmx5KSB7XG4gICAgY3R4LnVpLm5vdGlmeShgVW5rbm93biBjb21tYW5kLiBEaWQgeW91IG1lYW4gLyR7YWxpYXN9IHN3aXRjaCAke25hbWVPbmx5fT9gLCBcIndhcm5pbmdcIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgZXhpc3RpbmcgPSBsaXN0V29ya3RyZWVzKG1haW5CYXNlKTtcbiAgaWYgKGV4aXN0aW5nLnNvbWUod3QgPT4gd3QubmFtZSA9PT0gbmFtZU9ubHkpKSB7XG4gICAgYXdhaXQgaGFuZGxlU3dpdGNoKGJhc2VQYXRoLCBuYW1lT25seSwgY3R4KTtcbiAgfSBlbHNlIHtcbiAgICBhd2FpdCBoYW5kbGVDcmVhdGUoYmFzZVBhdGgsIG5hbWVPbmx5LCBjdHgpO1xuICB9XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBoYW5kbGVXb3JrdHJlZUNvbW1hbmQoXG4gIGFyZ3M6IHN0cmluZyxcbiAgY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCxcbiAgcGk6IEV4dGVuc2lvbkFQSSxcbiAgYWxpYXM6IHN0cmluZyxcbik6IFByb21pc2U8dm9pZD4ge1xuICBhd2FpdCB3b3JrdHJlZUhhbmRsZXIoYXJncywgY3R4LCBwaSwgYWxpYXMpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVnaXN0ZXJXb3JrdHJlZUNvbW1hbmQocGk6IEV4dGVuc2lvbkFQSSk6IHZvaWQge1xuICAvLyBSZXN0b3JlIHdvcmt0cmVlIHN0YXRlIGFmdGVyIC9yZWxvYWQuXG4gIC8vIFRoZSBtb2R1bGUtbGV2ZWwgb3JpZ2luYWxDd2QgcmVzZXRzIHRvIG51bGwgd2hlbiBleHRlbnNpb25zIGFyZSByZS1sb2FkZWQsXG4gIC8vIGJ1dCBwcm9jZXNzLmN3ZCgpIGlzIHN0aWxsIGluc2lkZSB0aGUgd29ya3RyZWUuIERldGVjdCB0aGlzIGFuZCByZWNvdmVyLlxuICBlbnN1cmVXb3JrdHJlZU9yaWdpbmFsQ3dkRnJvbVBhdGgoKTtcblxuICBwaS5yZWdpc3RlckNvbW1hbmQoXCJ3b3JrdHJlZVwiLCB7XG4gICAgZGVzY3JpcHRpb246IFwiR2l0IHdvcmt0cmVlcyAoYWxzbyAvd3QpOiAvd29ya3RyZWUgPG5hbWU+IHwgbGlzdCB8IG1lcmdlIHwgcmVtb3ZlXCIsXG4gICAgZ2V0QXJndW1lbnRDb21wbGV0aW9uczogd29ya3RyZWVDb21wbGV0aW9ucyxcblxuICAgIGFzeW5jIGhhbmRsZXIoYXJnczogc3RyaW5nLCBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0KSB7XG4gICAgICBhd2FpdCBoYW5kbGVXb3JrdHJlZUNvbW1hbmQoYXJncywgY3R4LCBwaSwgXCJ3b3JrdHJlZVwiKTtcbiAgICB9LFxuICB9KTtcblxuICAvLyAvd3QgYWxpYXMgXHUyMDE0IHNhbWUgaGFuZGxlciwgc2FtZSBjb21wbGV0aW9uc1xuICBwaS5yZWdpc3RlckNvbW1hbmQoXCJ3dFwiLCB7XG4gICAgZGVzY3JpcHRpb246IFwiQWxpYXMgZm9yIC93b3JrdHJlZVwiLFxuICAgIGdldEFyZ3VtZW50Q29tcGxldGlvbnM6IHdvcmt0cmVlQ29tcGxldGlvbnMsXG4gICAgYXN5bmMgaGFuZGxlcihhcmdzOiBzdHJpbmcsIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQpIHtcbiAgICAgIGF3YWl0IGhhbmRsZVdvcmt0cmVlQ29tbWFuZChhcmdzLCBjdHgsIHBpLCBcInd0XCIpO1xuICAgIH0sXG4gIH0pO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgSGFuZGxlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogQ2hlY2sgaWYgdGhlIHdvcmt0cmVlIGhhcyBleGlzdGluZyBHU0QgbWlsZXN0b25lcyB0aGF0IHdvdWxkXG4gKiBjYXVzZSBhdXRvLW1vZGUgdG8gY29udGludWUgcHJldmlvdXMgd29yayBpbnN0ZWFkIG9mIHN0YXJ0aW5nIGZyZXNoLlxuICovXG5mdW5jdGlvbiBoYXNFeGlzdGluZ01pbGVzdG9uZXMod3RQYXRoOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgbURpciA9IG1pbGVzdG9uZXNEaXIod3RQYXRoKTtcbiAgaWYgKCFleGlzdHNTeW5jKG1EaXIpKSByZXR1cm4gZmFsc2U7XG4gIHRyeSB7XG4gICAgY29uc3QgZW50cmllcyA9IHJlYWRkaXJTeW5jKG1EaXIsIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KVxuICAgICAgLmZpbHRlcihkID0+IGQuaXNEaXJlY3RvcnkoKSAmJiAvXk1cXGQrKD86LVthLXowLTldezZ9KT8vLnRlc3QoZC5uYW1lKSk7XG4gICAgcmV0dXJuIGVudHJpZXMubGVuZ3RoID4gMDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbi8qKlxuICogQ2xlYXIgR1NEIHBsYW5uaW5nIGFydGlmYWN0cyBzbyBhdXRvLW1vZGUgc3RhcnRzIGZyZXNoIHdpdGggdGhlIGRpc2N1c3MgZmxvdy5cbiAqIEtlZXBzIHRoZSAuZ3NkLyBkaXJlY3Rvcnkgc3RydWN0dXJlIGludGFjdCBidXQgcmVtb3ZlcyBtaWxlc3RvbmVzIGFuZCByb290IHBsYW5uaW5nIGZpbGVzLlxuICovXG5mdW5jdGlvbiBjbGVhckdTRFBsYW5zKHd0UGF0aDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IG1EaXIgPSBtaWxlc3RvbmVzRGlyKHd0UGF0aCk7XG4gIGlmIChleGlzdHNTeW5jKG1EaXIpKSB7XG4gICAgcm1TeW5jKG1EaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxuXG4gIC8vIFJlbW92ZSByb290IHBsYW5uaW5nIGZpbGVzIFx1MjAxNCBQUk9KRUNULm1kLCBERUNJU0lPTlMubWQsIFFVRVVFLm1kLCBSRVFVSVJFTUVOVFMubWRcbiAgLy8gS2VlcCBTVEFURS5tZCAoZ2l0aWdub3JlZCwgd2lsbCBiZSByZWJ1aWx0KSBhbmQgb3RoZXIgcnVudGltZSBmaWxlc1xuICBjb25zdCByb290ID0gZ3NkUm9vdCh3dFBhdGgpO1xuICBjb25zdCBwbGFubmluZ0ZpbGVzID0gW1wiUFJPSkVDVC5tZFwiLCBcIkRFQ0lTSU9OUy5tZFwiLCBcIlFVRVVFLm1kXCIsIFwiUkVRVUlSRU1FTlRTLm1kXCJdO1xuICBmb3IgKGNvbnN0IGZpbGUgb2YgcGxhbm5pbmdGaWxlcykge1xuICAgIGNvbnN0IGZpbGVQYXRoID0gam9pbihyb290LCBmaWxlKTtcbiAgICBpZiAoZXhpc3RzU3luYyhmaWxlUGF0aCkpIHtcbiAgICAgIHVubGlua1N5bmMoZmlsZVBhdGgpO1xuICAgIH1cbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVDcmVhdGUoXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIG5hbWU6IHN0cmluZyxcbiAgY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCxcbik6IFByb21pc2U8dm9pZD4ge1xuICB0cnkge1xuICAgIC8vIEF1dG8tY29tbWl0IGRpcnR5IGZpbGVzIGJlZm9yZSBsZWF2aW5nIGN1cnJlbnQgd29ya3NwYWNlIChtdXN0IGhhcHBlblxuICAgIC8vIGJlZm9yZSBjcmVhdGVXb3JrdHJlZSBzbyB0aGUgbmV3IHdvcmt0cmVlIGZvcmtzIGZyb20gY29tbWl0dGVkIEhFQUQpXG4gICAgY29uc3QgY29tbWl0TXNnID0gYXV0b0NvbW1pdEN1cnJlbnRCcmFuY2goYmFzZVBhdGgsIFwid29ya3RyZWUtc3dpdGNoXCIsIG5hbWUpO1xuXG4gICAgLy8gQ3JlYXRlIGZyb20gdGhlIG1haW4gdHJlZSwgbm90IGZyb20gaW5zaWRlIGFub3RoZXIgd29ya3RyZWVcbiAgICBjb25zdCBtYWluQmFzZSA9IGdldFdvcmt0cmVlT3JpZ2luYWxDd2QoKSA/PyBiYXNlUGF0aDtcbiAgICBjb25zdCBpbmZvID0gY3JlYXRlV29ya3RyZWUobWFpbkJhc2UsIG5hbWUpO1xuXG4gICAgLy8gUnVuIHVzZXItY29uZmlndXJlZCBwb3N0LWNyZWF0ZSBob29rICgjNTk3KSBcdTIwMTQgZS5nLiBjb3B5IC5lbnYsIHN5bWxpbmsgYXNzZXRzXG4gICAgY29uc3QgaG9va0Vycm9yID0gcnVuV29ya3RyZWVQb3N0Q3JlYXRlSG9vayhtYWluQmFzZSwgaW5mby5wYXRoKTtcbiAgICBpZiAoaG9va0Vycm9yKSB7XG4gICAgICBjdHgudWkubm90aWZ5KGhvb2tFcnJvciwgXCJ3YXJuaW5nXCIpO1xuICAgIH1cblxuICAgIC8vIFRyYWNrIG9yaWdpbmFsIGN3ZCBiZWZvcmUgc3dpdGNoaW5nXG4gICAgaWYgKCFnZXRXb3JrdHJlZU9yaWdpbmFsQ3dkKCkpIHNldFdvcmt0cmVlT3JpZ2luYWxDd2QoYmFzZVBhdGgpO1xuXG4gICAgY29uc3QgcHJldkN3ZCA9IHByb2Nlc3MuY3dkKCk7XG4gICAgcHJvY2Vzcy5jaGRpcihpbmZvLnBhdGgpO1xuICAgIG51ZGdlR2l0QnJhbmNoQ2FjaGUocHJldkN3ZCk7XG5cbiAgICAvLyBJZiB0aGUgd29ya3RyZWUgaW5oZXJpdGVkIGV4aXN0aW5nIG1pbGVzdG9uZXMsIGFzayB3aGV0aGVyIHRvIGtlZXAgb3IgY2xlYXIgdGhlbVxuICAgIGxldCBjbGVhcmVkUGxhbnMgPSBmYWxzZTtcbiAgICBpZiAoaGFzRXhpc3RpbmdNaWxlc3RvbmVzKGluZm8ucGF0aCkpIHtcbiAgICAgIC8vIGNvbmZpcm1MYWJlbCA9IENvbnRpbnVlIChzYWZlIGRlZmF1bHQsIG9uIHRoZSBsZWZ0IC8gZmlyc3QpXG4gICAgICAvLyBkZWNsaW5lTGFiZWwgPSBTdGFydCBmcmVzaCAoZGVzdHJ1Y3RpdmUsIG9uIHRoZSByaWdodClcbiAgICAgIGNvbnN0IGtlZXBFeGlzdGluZyA9IGF3YWl0IHNob3dDb25maXJtKGN0eCwge1xuICAgICAgICB0aXRsZTogXCJXb3JrdHJlZSBTZXR1cFwiLFxuICAgICAgICBtZXNzYWdlOiBbXG4gICAgICAgICAgYFRoaXMgd29ya3RyZWUgaW5oZXJpdGVkIGV4aXN0aW5nIEdTRCBtaWxlc3RvbmVzIGZyb20gdGhlIG1haW4gYnJhbmNoLmAsXG4gICAgICAgICAgYGAsXG4gICAgICAgICAgYCAgQ29udGludWUgXHUyMDE0IGtlZXAgbWlsZXN0b25lcyBhbmQgcGljayB1cCB3aGVyZSBtYWluIGxlZnQgb2ZmYCxcbiAgICAgICAgICBgICBTdGFydCBmcmVzaCBcdTIwMTQgY2xlYXIgbWlsZXN0b25lcyBzbyAvZ3NkIGF1dG8gc3RhcnRzIGEgbmV3IHByb2plY3RgLFxuICAgICAgICBdLmpvaW4oXCJcXG5cIiksXG4gICAgICAgIGNvbmZpcm1MYWJlbDogXCJDb250aW51ZVwiLFxuICAgICAgICBkZWNsaW5lTGFiZWw6IFwiU3RhcnQgZnJlc2hcIixcbiAgICAgIH0pO1xuICAgICAgaWYgKCFrZWVwRXhpc3RpbmcpIHtcbiAgICAgICAgY2xlYXJHU0RQbGFucyhpbmZvLnBhdGgpO1xuICAgICAgICBjbGVhcmVkUGxhbnMgPSB0cnVlO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IGNvbW1pdE5vdGUgPSBjb21taXRNc2dcbiAgICAgID8gYCAgJHtDTFIubXV0ZWQoXCJBdXRvLWNvbW1pdHRlZCBvbiBwcmV2aW91cyBicmFuY2ggYmVmb3JlIHN3aXRjaGluZy5cIil9YFxuICAgICAgOiBcIlwiO1xuICAgIGNvbnN0IGZyZXNoTm90ZSA9IGNsZWFyZWRQbGFuc1xuICAgICAgPyBgICAke0NMUi5vayhcIlx1MjcxM1wiKX0gQ2xlYXJlZCBtaWxlc3RvbmVzIFx1MjAxNCAke0NMUi5oaW50KFwiL2dzZCBhdXRvXCIpfSB3aWxsIHN0YXJ0IGZyZXNoLmBcbiAgICAgIDogXCJcIjtcbiAgICBjdHgudWkubm90aWZ5KFxuICAgICAgW1xuICAgICAgICBgJHtDTFIub2soXCJcdTI3MTNcIil9IFdvcmt0cmVlICR7Q0xSLm5hbWUobmFtZSl9IGNyZWF0ZWQgYW5kIGFjdGl2YXRlZC5gLFxuICAgICAgICBcIlwiLFxuICAgICAgICBgICAke0NMUi5sYWJlbChcInBhdGhcIil9ICAgICAke0NMUi5wYXRoKGluZm8ucGF0aCl9YCxcbiAgICAgICAgYCAgJHtDTFIubGFiZWwoXCJicmFuY2hcIil9ICAgJHtDTFIuYnJhbmNoKGluZm8uYnJhbmNoKX1gLFxuICAgICAgICBjb21taXROb3RlLFxuICAgICAgICBmcmVzaE5vdGUsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIGAgICR7Q0xSLmhpbnQoYC93b3JrdHJlZSBtZXJnZSAke25hbWV9YCl9ICAke0NMUi5tdXRlZChcIm1lcmdlIGJhY2sgd2hlbiBkb25lXCIpfWAsXG4gICAgICAgIGAgICR7Q0xSLmhpbnQoXCIvd29ya3RyZWUgcmV0dXJuXCIpfSR7XCIgXCIucmVwZWF0KE1hdGgubWF4KDEsIG5hbWUubGVuZ3RoIC0gMikpfSAgJHtDTFIubXV0ZWQoXCJzd2l0Y2ggYmFjayB0byBtYWluIHRyZWVcIil9YCxcbiAgICAgIF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oXCJcXG5cIiksXG4gICAgICBcImluZm9cIixcbiAgICApO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnN0IG1zZyA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbiAgICBjdHgudWkubm90aWZ5KGBGYWlsZWQgdG8gY3JlYXRlIHdvcmt0cmVlOiAke21zZ31gLCBcImVycm9yXCIpO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZVN3aXRjaChcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgbmFtZTogc3RyaW5nLFxuICBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIHRyeSB7XG4gICAgY29uc3QgbWFpbkJhc2UgPSBnZXRXb3JrdHJlZU9yaWdpbmFsQ3dkKCkgPz8gYmFzZVBhdGg7XG4gICAgY29uc3Qgd3RQYXRoID0gd29ya3RyZWVQYXRoKG1haW5CYXNlLCBuYW1lKTtcblxuICAgIGlmICghZXhpc3RzU3luYyh3dFBhdGgpKSB7XG4gICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICBgV29ya3RyZWUgXCIke25hbWV9XCIgbm90IGZvdW5kLiBSdW4gL3dvcmt0cmVlIGxpc3QgdG8gc2VlIGF2YWlsYWJsZSB3b3JrdHJlZXMuYCxcbiAgICAgICAgXCJ3YXJuaW5nXCIsXG4gICAgICApO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIEF1dG8tY29tbWl0IGRpcnR5IGZpbGVzIGJlZm9yZSBsZWF2aW5nIGN1cnJlbnQgd29ya3NwYWNlXG4gICAgY29uc3QgY29tbWl0TXNnID0gYXV0b0NvbW1pdEN1cnJlbnRCcmFuY2goYmFzZVBhdGgsIFwid29ya3RyZWUtc3dpdGNoXCIsIG5hbWUpO1xuXG4gICAgLy8gVHJhY2sgb3JpZ2luYWwgY3dkIGJlZm9yZSBzd2l0Y2hpbmdcbiAgICBpZiAoIWdldFdvcmt0cmVlT3JpZ2luYWxDd2QoKSkgc2V0V29ya3RyZWVPcmlnaW5hbEN3ZChiYXNlUGF0aCk7XG5cbiAgICBjb25zdCBwcmV2Q3dkID0gcHJvY2Vzcy5jd2QoKTtcbiAgICBwcm9jZXNzLmNoZGlyKHd0UGF0aCk7XG4gICAgbnVkZ2VHaXRCcmFuY2hDYWNoZShwcmV2Q3dkKTtcblxuICAgIGNvbnN0IGNvbW1pdE5vdGUgPSBjb21taXRNc2dcbiAgICAgID8gYCAgJHtDTFIubXV0ZWQoXCJBdXRvLWNvbW1pdHRlZCBvbiBwcmV2aW91cyBicmFuY2ggYmVmb3JlIHN3aXRjaGluZy5cIil9YFxuICAgICAgOiBcIlwiO1xuICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICBbXG4gICAgICAgIGAke0NMUi5vayhcIlx1MjcxM1wiKX0gU3dpdGNoZWQgdG8gd29ya3RyZWUgJHtDTFIubmFtZShuYW1lKX0uYCxcbiAgICAgICAgXCJcIixcbiAgICAgICAgYCAgJHtDTFIubGFiZWwoXCJwYXRoXCIpfSAgICAgJHtDTFIucGF0aCh3dFBhdGgpfWAsXG4gICAgICAgIGAgICR7Q0xSLmxhYmVsKFwiYnJhbmNoXCIpfSAgICR7Q0xSLmJyYW5jaCh3b3JrdHJlZUJyYW5jaE5hbWUobmFtZSkpfWAsXG4gICAgICAgIGNvbW1pdE5vdGUsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIGAgICR7Q0xSLmhpbnQoXCIvd29ya3RyZWUgcmV0dXJuXCIpfSAgJHtDTFIubXV0ZWQoXCJzd2l0Y2ggYmFjayB0byBtYWluIHRyZWVcIil9YCxcbiAgICAgIF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oXCJcXG5cIiksXG4gICAgICBcImluZm9cIixcbiAgICApO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnN0IG1zZyA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbiAgICBjdHgudWkubm90aWZ5KGBGYWlsZWQgdG8gc3dpdGNoIHRvIHdvcmt0cmVlOiAke21zZ31gLCBcImVycm9yXCIpO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZVJldHVybihjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IG9yaWdpbmFsQ3dkID0gZ2V0V29ya3RyZWVPcmlnaW5hbEN3ZCgpO1xuICBpZiAoIW9yaWdpbmFsQ3dkKSB7XG4gICAgY3R4LnVpLm5vdGlmeShcIkFscmVhZHkgaW4gdGhlIG1haW4gcHJvamVjdCB0cmVlLlwiLCBcImluZm9cIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gQXV0by1jb21taXQgZGlydHkgZmlsZXMgYmVmb3JlIGxlYXZpbmcgd29ya3RyZWVcbiAgY29uc3QgY29tbWl0TXNnID0gYXV0b0NvbW1pdEN1cnJlbnRCcmFuY2gocHJvY2Vzcy5jd2QoKSwgXCJ3b3JrdHJlZS1yZXR1cm5cIiwgXCJ3b3JrdHJlZVwiKTtcblxuICBjb25zdCByZXR1cm5UbyA9IG9yaWdpbmFsQ3dkO1xuICBjbGVhcldvcmt0cmVlT3JpZ2luYWxDd2QoKTtcblxuICBjb25zdCBwcmV2Q3dkID0gcHJvY2Vzcy5jd2QoKTtcbiAgcHJvY2Vzcy5jaGRpcihyZXR1cm5Ubyk7XG4gIG51ZGdlR2l0QnJhbmNoQ2FjaGUocHJldkN3ZCk7XG5cbiAgY29uc3QgY29tbWl0Tm90ZSA9IGNvbW1pdE1zZ1xuICAgID8gYCAgJHtDTFIubXV0ZWQoXCJBdXRvLWNvbW1pdHRlZCBvbiB3b3JrdHJlZSBicmFuY2ggYmVmb3JlIHJldHVybmluZy5cIil9YFxuICAgIDogXCJcIjtcbiAgY3R4LnVpLm5vdGlmeShcbiAgICBbXG4gICAgICBgJHtDTFIub2soXCJcdTI3MTNcIil9IFJldHVybmVkIHRvIG1haW4gcHJvamVjdCB0cmVlLmAsXG4gICAgICBcIlwiLFxuICAgICAgYCAgJHtDTFIubGFiZWwoXCJwYXRoXCIpfSAgJHtDTFIucGF0aChyZXR1cm5Ubyl9YCxcbiAgICAgIGNvbW1pdE5vdGUsXG4gICAgXS5maWx0ZXIoQm9vbGVhbikuam9pbihcIlxcblwiKSxcbiAgICBcImluZm9cIixcbiAgKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEFOU0kgc3R5bGluZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbi8vIENvbnNpc3RlbnQgcGFsZXR0ZSBmb3IgYWxsIHdvcmt0cmVlIGNvbW1hbmQgb3V0cHV0LlxuXG5jb25zdCBCT0xEICAgPSBcIlxceDFiWzFtXCI7XG5jb25zdCBESU0gICAgPSBcIlxceDFiWzJtXCI7XG5jb25zdCBSRVNFVCAgPSBcIlxceDFiWzBtXCI7XG5jb25zdCBDWUFOICAgPSBcIlxceDFiWzM2bVwiO1xuY29uc3QgR1JFRU4gID0gXCJcXHgxYlszMm1cIjtcbmNvbnN0IFJFRCAgICA9IFwiXFx4MWJbMzFtXCI7XG5jb25zdCBZRUxMT1cgPSBcIlxceDFiWzMzbVwiO1xuY29uc3QgV0hJVEUgID0gXCJcXHgxYlszN21cIjtcbmNvbnN0IE1BR0VOVEEgPSBcIlxceDFiWzM1bVwiO1xuXG4vLyBTZW1hbnRpYyBhbGlhc2VzIGZvciBjb25zaXN0ZW50IHVzZSBhY3Jvc3MgYWxsIGhhbmRsZXJzXG5jb25zdCBDTFIgPSB7XG4gIC8qKiBXb3JrdHJlZSBuYW1lcyBhbmQgcHJpbWFyeSBlbXBoYXNpcyAqL1xuICBuYW1lOiAgICAoczogc3RyaW5nKSA9PiBgJHtCT0xEfSR7Q1lBTn0ke3N9JHtSRVNFVH1gLFxuICAvKiogQWN0aXZlIHdvcmt0cmVlIG5hbWUgKi9cbiAgbmFtZUFjdGl2ZTogKHM6IHN0cmluZykgPT4gYCR7Qk9MRH0ke0dSRUVOfSR7c30ke1JFU0VUfWAsXG4gIC8qKiBCcmFuY2ggbmFtZXMgKi9cbiAgYnJhbmNoOiAgKHM6IHN0cmluZykgPT4gYCR7TUFHRU5UQX0ke3N9JHtSRVNFVH1gLFxuICAvKiogRmlsZSBwYXRocyAqL1xuICBwYXRoOiAgICAoczogc3RyaW5nKSA9PiBgJHtESU19JHtzfSR7UkVTRVR9YCxcbiAgLyoqIExhYmVscyAoa2V5IGluIGtleTp2YWx1ZSBwYWlycykgKi9cbiAgbGFiZWw6ICAgKHM6IHN0cmluZykgPT4gYCR7V0hJVEV9JHtzfSR7UkVTRVR9YCxcbiAgLyoqIEhpbnRzIGFuZCBjb21tYW5kcyB0aGUgdXNlciBjYW4gcnVuICovXG4gIGhpbnQ6ICAgIChzOiBzdHJpbmcpID0+IGAke0RJTX0ke0NZQU59JHtzfSR7UkVTRVR9YCxcbiAgLyoqIFN1Y2Nlc3MgbWVzc2FnZXMgYW5kIGNoZWNrcyAqL1xuICBvazogICAgICAoczogc3RyaW5nKSA9PiBgJHtHUkVFTn0ke3N9JHtSRVNFVH1gLFxuICAvKiogV2FybmluZyBiYWRnZXMgKi9cbiAgd2FybjogICAgKHM6IHN0cmluZykgPT4gYCR7WUVMTE9XfSR7c30ke1JFU0VUfWAsXG4gIC8qKiBTZWN0aW9uIGhlYWRlcnMgKi9cbiAgaGVhZGVyOiAgKHM6IHN0cmluZykgPT4gYCR7Qk9MRH0ke1dISVRFfSR7c30ke1JFU0VUfWAsXG4gIC8qKiBNdXRlZCBzZWNvbmRhcnkgaW5mbyAqL1xuICBtdXRlZDogICAoczogc3RyaW5nKSA9PiBgJHtESU19JHtzfSR7UkVTRVR9YCxcbn0gYXMgY29uc3Q7XG5cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZUxpc3QoXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBtYWluQmFzZSA9IGdldFdvcmt0cmVlT3JpZ2luYWxDd2QoKSA/PyBiYXNlUGF0aDtcbiAgICBjb25zdCB3b3JrdHJlZXMgPSBsaXN0V29ya3RyZWVzKG1haW5CYXNlKTtcblxuICAgIGlmICh3b3JrdHJlZXMubGVuZ3RoID09PSAwKSB7XG4gICAgICBjdHgudWkubm90aWZ5KFwiTm8gR1NEIHdvcmt0cmVlcyBmb3VuZC4gQ3JlYXRlIG9uZSB3aXRoIC93b3JrdHJlZSA8bmFtZT4uXCIsIFwiaW5mb1wiKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBDb21wdXRlIGhlYWx0aCBzdGF0dXMgZm9yIGVhY2ggd29ya3RyZWVcbiAgICBjb25zdCB7IGdldEFsbFdvcmt0cmVlSGVhbHRoLCBmb3JtYXRXb3JrdHJlZVN0YXR1c0xpbmUgfSA9IGF3YWl0IGltcG9ydChcIi4vd29ya3RyZWUtaGVhbHRoLmpzXCIpO1xuICAgIGNvbnN0IGhlYWx0aE1hcCA9IG5ldyBNYXA8c3RyaW5nLCBSZXR1cm5UeXBlPHR5cGVvZiBnZXRBbGxXb3JrdHJlZUhlYWx0aD5bbnVtYmVyXT4oKTtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc3RhdHVzZXMgPSBnZXRBbGxXb3JrdHJlZUhlYWx0aChtYWluQmFzZSk7XG4gICAgICBmb3IgKGNvbnN0IHMgb2Ygc3RhdHVzZXMpIGhlYWx0aE1hcC5zZXQocy53b3JrdHJlZS5uYW1lLCBzKTtcbiAgICB9IGNhdGNoIHsgLyogaGVhbHRoIGNoZWNrIGZhaWxlZCBcdTIwMTQgc2hvdyBsaXN0IHdpdGhvdXQgc3RhdHVzICovIH1cblxuICAgIGNvbnN0IGN3ZCA9IHByb2Nlc3MuY3dkKCk7XG4gICAgY29uc3QgbGluZXMgPSBbQ0xSLmhlYWRlcihcIkdTRCBXb3JrdHJlZXNcIiksIFwiXCJdO1xuICAgIGZvciAoY29uc3Qgd3Qgb2Ygd29ya3RyZWVzKSB7XG4gICAgICBjb25zdCBpc0N1cnJlbnQgPSBjd2QgPT09IHd0LnBhdGhcbiAgICAgICAgfHwgKGV4aXN0c1N5bmMoY3dkKSAmJiBleGlzdHNTeW5jKHd0LnBhdGgpXG4gICAgICAgICAgJiYgcmVhbHBhdGhTeW5jKGN3ZCkgPT09IHJlYWxwYXRoU3luYyh3dC5wYXRoKSk7XG5cbiAgICAgIGNvbnN0IHN0eWxlZE5hbWUgPSBpc0N1cnJlbnQgPyBDTFIubmFtZUFjdGl2ZSh3dC5uYW1lKSA6IENMUi5uYW1lKHd0Lm5hbWUpO1xuICAgICAgY29uc3QgYmFkZ2UgPSBpc0N1cnJlbnRcbiAgICAgICAgPyBgICAke0NMUi5vayhcIlx1MjVDRiBhY3RpdmVcIil9YFxuICAgICAgICA6ICF3dC5leGlzdHNcbiAgICAgICAgICA/IGAgICR7Q0xSLndhcm4oXCJcdTI3MTcgbWlzc2luZ1wiKX1gXG4gICAgICAgICAgOiBcIlwiO1xuICAgICAgbGluZXMucHVzaChgICAke3N0eWxlZE5hbWV9JHtiYWRnZX1gKTtcbiAgICAgIGxpbmVzLnB1c2goYCAgICAke0NMUi5sYWJlbChcImJyYW5jaFwiKX0gICR7Q0xSLmJyYW5jaCh3dC5icmFuY2gpfWApO1xuICAgICAgbGluZXMucHVzaChgICAgICR7Q0xSLmxhYmVsKFwicGF0aFwiKX0gICAgJHtDTFIucGF0aCh3dC5wYXRoKX1gKTtcblxuICAgICAgLy8gU2hvdyBoZWFsdGggc3RhdHVzIGxpbmVcbiAgICAgIGNvbnN0IGhlYWx0aCA9IGhlYWx0aE1hcC5nZXQod3QubmFtZSk7XG4gICAgICBpZiAoaGVhbHRoKSB7XG4gICAgICAgIGNvbnN0IHN0YXR1c0xpbmUgPSBmb3JtYXRXb3JrdHJlZVN0YXR1c0xpbmUoaGVhbHRoKTtcbiAgICAgICAgY29uc3Qgc3RhdHVzQ29sb3IgPSBoZWFsdGguc2FmZVRvUmVtb3ZlXG4gICAgICAgICAgPyBDTFIub2soc3RhdHVzTGluZSlcbiAgICAgICAgICA6IGhlYWx0aC5zdGFsZSB8fCBoZWFsdGguZGlydHlcbiAgICAgICAgICAgID8gQ0xSLndhcm4oc3RhdHVzTGluZSlcbiAgICAgICAgICAgIDogQ0xSLm11dGVkKHN0YXR1c0xpbmUpO1xuICAgICAgICBsaW5lcy5wdXNoKGAgICAgJHtDTFIubGFiZWwoXCJzdGF0dXNcIil9ICAke3N0YXR1c0NvbG9yfWApO1xuICAgICAgfVxuXG4gICAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICAgIH1cblxuICAgIGNvbnN0IG9yaWdpbmFsQ3dkID0gZ2V0V29ya3RyZWVPcmlnaW5hbEN3ZCgpO1xuICAgIGlmIChvcmlnaW5hbEN3ZCkge1xuICAgICAgbGluZXMucHVzaChgICAke0NMUi5sYWJlbChcIm1haW4gdHJlZVwiKX0gICR7Q0xSLnBhdGgob3JpZ2luYWxDd2QpfWApO1xuICAgIH1cblxuICAgIGN0eC51aS5ub3RpZnkobGluZXMuam9pbihcIlxcblwiKSwgXCJpbmZvXCIpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnN0IG1zZyA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbiAgICBjdHgudWkubm90aWZ5KGBGYWlsZWQgdG8gbGlzdCB3b3JrdHJlZXM6ICR7bXNnfWAsIFwiZXJyb3JcIik7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gaGFuZGxlTWVyZ2UoXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIG5hbWU6IHN0cmluZyxcbiAgY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCxcbiAgcGk6IEV4dGVuc2lvbkFQSSxcbiAgdGFyZ2V0QnJhbmNoPzogc3RyaW5nLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIHRyeSB7XG4gICAgY29uc3QgYnJhbmNoID0gd29ya3RyZWVCcmFuY2hOYW1lKG5hbWUpO1xuICAgIGNvbnN0IG1haW5CcmFuY2ggPSB0YXJnZXRCcmFuY2ggPz8gZ2V0TWFpbkJyYW5jaChiYXNlUGF0aCk7XG5cbiAgICAvLyBWYWxpZGF0ZSB0aGUgd29ya3RyZWUvYnJhbmNoIGV4aXN0c1xuICAgIGNvbnN0IHdvcmt0cmVlcyA9IGxpc3RXb3JrdHJlZXMoYmFzZVBhdGgpO1xuICAgIGNvbnN0IHd0ID0gd29ya3RyZWVzLmZpbmQodyA9PiB3Lm5hbWUgPT09IG5hbWUpO1xuICAgIGlmICghd3QpIHtcbiAgICAgIGN0eC51aS5ub3RpZnkoYFdvcmt0cmVlIFwiJHtuYW1lfVwiIG5vdCBmb3VuZC4gUnVuIC93b3JrdHJlZSBsaXN0IHRvIHNlZSBhdmFpbGFibGUgd29ya3RyZWVzLmAsIFwid2FybmluZ1wiKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBHYXRoZXIgbWVyZ2UgY29udGV4dCBcdTIwMTQgZnVsbCByZXBvIGRpZmYsIG5vdCBqdXN0IC5nc2QvXG4gICAgY29uc3QgZGlmZlN1bW1hcnkgPSBkaWZmV29ya3RyZWVBbGwoYmFzZVBhdGgsIG5hbWUpO1xuICAgIGNvbnN0IG51bXN0YXQgPSBkaWZmV29ya3RyZWVOdW1zdGF0KGJhc2VQYXRoLCBuYW1lKTtcbiAgICBjb25zdCBnc2REaWZmID0gZ2V0V29ya3RyZWVHU0REaWZmKGJhc2VQYXRoLCBuYW1lKTtcbiAgICBjb25zdCBjb2RlRGlmZiA9IGdldFdvcmt0cmVlQ29kZURpZmYoYmFzZVBhdGgsIG5hbWUpO1xuICAgIGNvbnN0IGNvbW1pdExvZyA9IGdldFdvcmt0cmVlTG9nKGJhc2VQYXRoLCBuYW1lKTtcblxuICAgIGNvbnN0IHRvdGFsQ2hhbmdlcyA9IGRpZmZTdW1tYXJ5LmFkZGVkLmxlbmd0aCArIGRpZmZTdW1tYXJ5Lm1vZGlmaWVkLmxlbmd0aCArIGRpZmZTdW1tYXJ5LnJlbW92ZWQubGVuZ3RoO1xuICAgIGlmICh0b3RhbENoYW5nZXMgPT09IDAgJiYgIWNvbW1pdExvZy50cmltKCkpIHtcbiAgICAgIGN0eC51aS5ub3RpZnkoYFdvcmt0cmVlICR7Q0xSLm5hbWUobmFtZSl9IGhhcyBubyBjaGFuZ2VzIHRvIG1lcmdlLmAsIFwiaW5mb1wiKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBCdWlsZCBhIG1hcCBvZiBmaWxlIFx1MjE5MiBsaW5lIHN0YXRzIGZvciB0aGUgcHJldmlld1xuICAgIGNvbnN0IHN0YXRNYXAgPSBuZXcgTWFwPHN0cmluZywgRmlsZUxpbmVTdGF0PigpO1xuICAgIGZvciAoY29uc3QgcyBvZiBudW1zdGF0KSBzdGF0TWFwLnNldChzLmZpbGUsIHMpO1xuXG4gICAgLy8gQ29tcHV0ZSB0b3RhbHNcbiAgICBsZXQgdG90YWxBZGRlZCA9IDA7XG4gICAgbGV0IHRvdGFsUmVtb3ZlZCA9IDA7XG4gICAgZm9yIChjb25zdCBzIG9mIG51bXN0YXQpIHsgdG90YWxBZGRlZCArPSBzLmFkZGVkOyB0b3RhbFJlbW92ZWQgKz0gcy5yZW1vdmVkOyB9XG5cbiAgICAvLyBTcGxpdCBmaWxlcyBpbnRvIGNvZGUgdnMgR1NEIGZvciB0aGUgcHJldmlld1xuICAgIGNvbnN0IGlzR1NEID0gKGY6IHN0cmluZykgPT4gZi5zdGFydHNXaXRoKFwiLmdzZC9cIik7XG4gICAgY29uc3QgY29kZUNoYW5nZXMgPSBkaWZmU3VtbWFyeS5hZGRlZC5maWx0ZXIoZiA9PiAhaXNHU0QoZikpLmxlbmd0aFxuICAgICAgKyBkaWZmU3VtbWFyeS5tb2RpZmllZC5maWx0ZXIoZiA9PiAhaXNHU0QoZikpLmxlbmd0aFxuICAgICAgKyBkaWZmU3VtbWFyeS5yZW1vdmVkLmZpbHRlcihmID0+ICFpc0dTRChmKSkubGVuZ3RoO1xuICAgIGNvbnN0IGdzZENoYW5nZXMgPSBkaWZmU3VtbWFyeS5hZGRlZC5maWx0ZXIoaXNHU0QpLmxlbmd0aFxuICAgICAgKyBkaWZmU3VtbWFyeS5tb2RpZmllZC5maWx0ZXIoaXNHU0QpLmxlbmd0aFxuICAgICAgKyBkaWZmU3VtbWFyeS5yZW1vdmVkLmZpbHRlcihpc0dTRCkubGVuZ3RoO1xuXG4gICAgLy8gRm9ybWF0IGEgZmlsZSBsaW5lIHdpdGggKy8tIHN0YXRzXG4gICAgY29uc3QgZm9ybWF0RmlsZUxpbmUgPSAocHJlZml4OiBzdHJpbmcsIGZpbGU6IHN0cmluZyk6IHN0cmluZyA9PiB7XG4gICAgICBjb25zdCBzID0gc3RhdE1hcC5nZXQoZmlsZSk7XG4gICAgICBjb25zdCBzdGF0ID0gcyA/IGAgJHtDTFIub2soYCske3MuYWRkZWR9YCl9ICR7UkVEfS0ke3MucmVtb3ZlZH0ke1JFU0VUfWAgOiBcIlwiO1xuICAgICAgcmV0dXJuIGAgICAgJHtwcmVmaXh9ICR7ZmlsZX0ke3N0YXR9YDtcbiAgICB9O1xuXG4gICAgLy8gUHJldmlldyBjb25maXJtYXRpb24gYmVmb3JlIG1lcmdlIGRpc3BhdGNoXG4gICAgY29uc3QgcHJldmlld0xpbmVzID0gW1xuICAgICAgYE1lcmdlICR7Q0xSLm5hbWUobmFtZSl9IFx1MjE5MiAke0NMUi5icmFuY2gobWFpbkJyYW5jaCl9YCxcbiAgICAgIFwiXCIsXG4gICAgICBgICAke3RvdGFsQ2hhbmdlc30gZmlsZSR7dG90YWxDaGFuZ2VzID09PSAxID8gXCJcIiA6IFwic1wifSBjaGFuZ2VkLCAke0NMUi5vayhgKyR7dG90YWxBZGRlZH1gKX0gJHtSRUR9LSR7dG90YWxSZW1vdmVkfSR7UkVTRVR9IGxpbmVzICR7Q0xSLm11dGVkKGAoJHtjb2RlQ2hhbmdlc30gY29kZSwgJHtnc2RDaGFuZ2VzfSBHU0QpYCl9YCxcbiAgICBdO1xuXG4gICAgY29uc3QgYXBwZW5kRmlsZUxpc3QgPSAobGFiZWw6IHN0cmluZywgZmlsZXM6IHN0cmluZ1tdLCBwcmVmaXg6IHN0cmluZywgbGltaXQgPSAxMCkgPT4ge1xuICAgICAgaWYgKGZpbGVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuICAgICAgcHJldmlld0xpbmVzLnB1c2goXCJcIiwgYCAgJHtsYWJlbH06YCk7XG4gICAgICBmb3IgKGNvbnN0IGYgb2YgZmlsZXMuc2xpY2UoMCwgbGltaXQpKSBwcmV2aWV3TGluZXMucHVzaChmb3JtYXRGaWxlTGluZShwcmVmaXgsIGYpKTtcbiAgICAgIGlmIChmaWxlcy5sZW5ndGggPiBsaW1pdCkgcHJldmlld0xpbmVzLnB1c2goYCAgICBcdTIwMjYgYW5kICR7ZmlsZXMubGVuZ3RoIC0gbGltaXR9IG1vcmVgKTtcbiAgICB9O1xuXG4gICAgYXBwZW5kRmlsZUxpc3QoXCJBZGRlZFwiLCBkaWZmU3VtbWFyeS5hZGRlZCwgXCIrXCIpO1xuICAgIGFwcGVuZEZpbGVMaXN0KFwiTW9kaWZpZWRcIiwgZGlmZlN1bW1hcnkubW9kaWZpZWQsIFwiflwiKTtcbiAgICBhcHBlbmRGaWxlTGlzdChcIlJlbW92ZWRcIiwgZGlmZlN1bW1hcnkucmVtb3ZlZCwgXCItXCIpO1xuXG4gICAgY29uc3QgY29uZmlybWVkID0gYXdhaXQgc2hvd0NvbmZpcm0oY3R4LCB7XG4gICAgICB0aXRsZTogXCJXb3JrdHJlZSBNZXJnZVwiLFxuICAgICAgbWVzc2FnZTogcHJldmlld0xpbmVzLmpvaW4oXCJcXG5cIiksXG4gICAgICBjb25maXJtTGFiZWw6IFwiTWVyZ2VcIixcbiAgICAgIGRlY2xpbmVMYWJlbDogXCJDYW5jZWxcIixcbiAgICB9KTtcbiAgICBpZiAoIWNvbmZpcm1lZCkge1xuICAgICAgY3R4LnVpLm5vdGlmeShcIk1lcmdlIGNhbmNlbGxlZC5cIiwgXCJpbmZvXCIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIFN3aXRjaCB0byB0aGUgbWFpbiB0cmVlIGJlZm9yZSBtZXJnaW5nLlxuICAgIC8vIE11c3QgYmUgb24gdGhlIG1haW4gYnJhbmNoIHRvIHJ1biBnaXQgbWVyZ2UgLS1zcXVhc2guXG4gICAgaWYgKGdldFdvcmt0cmVlT3JpZ2luYWxDd2QoKSkge1xuICAgICAgY29uc3QgcHJldkN3ZCA9IHByb2Nlc3MuY3dkKCk7XG4gICAgICBwcm9jZXNzLmNoZGlyKGJhc2VQYXRoKTtcbiAgICAgIG51ZGdlR2l0QnJhbmNoQ2FjaGUocHJldkN3ZCk7XG4gICAgICBjbGVhcldvcmt0cmVlT3JpZ2luYWxDd2QoKTtcbiAgICB9XG5cbiAgICAvLyAtLS0gRGV0ZXJtaW5pc3RpYyBtZXJnZSBwYXRoIChwcmVmZXJyZWQpIC0tLVxuICAgIC8vIFRyeSBhIGRpcmVjdCBzcXVhc2gtbWVyZ2UgZmlyc3QuIE9ubHkgZmFsbCBiYWNrIHRvIExMTSBvbiBjb25mbGljdC5cbiAgICBjb25zdCBjb21taXRUeXBlID0gaW5mZXJDb21taXRUeXBlKG5hbWUpO1xuICAgIGNvbnN0IGNvbW1pdE1lc3NhZ2UgPSBgJHtjb21taXRUeXBlfTogbWVyZ2Ugd29ya3RyZWUgJHtuYW1lfVxcblxcbkdTRC1Xb3JrdHJlZTogJHtuYW1lfWA7XG5cbiAgICAvLyBSZWNvbmNpbGUgd29ya3RyZWUgREIgaW50byBtYWluIERCIGJlZm9yZSBzcXVhc2ggbWVyZ2VcbiAgICBjb25zdCBjb250cmFjdCA9IHJlc29sdmVHc2RQYXRoQ29udHJhY3Qod29ya3RyZWVQYXRoKGJhc2VQYXRoLCBuYW1lKSwgYmFzZVBhdGgpO1xuICAgIGNvbnN0IHd0RGJQYXRoID0gam9pbihjb250cmFjdC53b3JrdHJlZUdzZCA/PyBqb2luKGNvbnRyYWN0LndvcmtSb290LCBcIi5nc2RcIiksIFwiZ3NkLmRiXCIpO1xuICAgIGNvbnN0IG1haW5EYlBhdGggPSBjb250cmFjdC5wcm9qZWN0RGI7XG4gICAgaWYgKGV4aXN0c1N5bmMod3REYlBhdGgpICYmIGV4aXN0c1N5bmMobWFpbkRiUGF0aCkpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHsgcmVjb25jaWxlV29ya3RyZWVEYiB9ID0gYXdhaXQgaW1wb3J0KFwiLi9nc2QtZGIuanNcIik7XG4gICAgICAgIHJlY29uY2lsZVdvcmt0cmVlRGIobWFpbkRiUGF0aCwgd3REYlBhdGgpO1xuICAgICAgfSBjYXRjaCB7IC8qIG5vbi1mYXRhbCAqLyB9XG4gICAgfVxuXG4gICAgdHJ5IHtcbiAgICAgIG1lcmdlV29ya3RyZWVUb01haW4oYmFzZVBhdGgsIG5hbWUsIGNvbW1pdE1lc3NhZ2UpO1xuICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgW1xuICAgICAgICAgIGAke0NMUi5vayhcIlx1MjcxM1wiKX0gTWVyZ2VkICR7Q0xSLm5hbWUobmFtZSl9IFx1MjE5MiAke0NMUi5icmFuY2gobWFpbkJyYW5jaCl9ICR7Q0xSLm11dGVkKFwiKGRldGVybWluaXN0aWMgc3F1YXNoKVwiKX1gLFxuICAgICAgICAgIFwiXCIsXG4gICAgICAgICAgYCAgJHt0b3RhbENoYW5nZXN9IGZpbGUke3RvdGFsQ2hhbmdlcyA9PT0gMSA/IFwiXCIgOiBcInNcIn0gY2hhbmdlZCwgJHtDTFIub2soYCske3RvdGFsQWRkZWR9YCl9ICR7UkVEfS0ke3RvdGFsUmVtb3ZlZH0ke1JFU0VUfSBsaW5lc2AsXG4gICAgICAgICAgYCAgJHtDTFIubXV0ZWQoXCJjb21taXQ6XCIpfSAke2NvbW1pdE1lc3NhZ2V9YCxcbiAgICAgICAgXS5qb2luKFwiXFxuXCIpLFxuICAgICAgICBcImluZm9cIixcbiAgICAgICk7XG4gICAgICByZXR1cm47XG4gICAgfSBjYXRjaCAobWVyZ2VFcnIpIHtcbiAgICAgIGNvbnN0IG1lcmdlTXNnID0gbWVyZ2VFcnIgaW5zdGFuY2VvZiBFcnJvciA/IG1lcmdlRXJyLm1lc3NhZ2UgOiBTdHJpbmcobWVyZ2VFcnIpO1xuICAgICAgY29uc3QgaXNDb25mbGljdCA9IC9jb25mbGljdC9pLnRlc3QobWVyZ2VNc2cpO1xuXG4gICAgICBpZiAoaXNDb25mbGljdCkge1xuICAgICAgICAvLyBBYm9ydCB0aGUgZmFpbGVkIG1lcmdlIHNvIHRoZSB3b3JraW5nIHRyZWUgaXMgY2xlYW4gZm9yIExMTSByZXRyeVxuICAgICAgICB0cnkge1xuICAgICAgICAgIG5hdGl2ZU1lcmdlQWJvcnQoYmFzZVBhdGgpO1xuICAgICAgICB9IGNhdGNoIHsgLyogYWxyZWFkeSBjbGVhbiAqLyB9XG5cbiAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICBgJHtDTFIubXV0ZWQoXCJEZXRlcm1pbmlzdGljIG1lcmdlIGhpdCBjb25mbGljdHMgXHUyMDE0IGZhbGxpbmcgYmFjayB0byBMTE0tZ3VpZGVkIG1lcmdlLlwiKX1gLFxuICAgICAgICAgIFwid2FybmluZ1wiLFxuICAgICAgICApO1xuICAgICAgICAvLyBGYWxsIHRocm91Z2ggdG8gTExNIGRpc3BhdGNoIGJlbG93XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBOb24tY29uZmxpY3QgZXJyb3IgXHUyMDE0IHN1cmZhY2UgaXQgZGlyZWN0bHksIGRvbid0IGZhbGwgYmFja1xuICAgICAgICBjdHgudWkubm90aWZ5KGBGYWlsZWQgdG8gbWVyZ2U6ICR7bWVyZ2VNc2d9YCwgXCJlcnJvclwiKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIC0tLSBMTE0gZmFsbGJhY2sgcGF0aCAoY29uZmxpY3QgcmVzb2x1dGlvbikgLS0tXG4gICAgLy8gRm9ybWF0IGZpbGUgbGlzdHMgZm9yIHRoZSBwcm9tcHRcbiAgICBjb25zdCBmb3JtYXRGaWxlcyA9IChmaWxlczogc3RyaW5nW10pID0+XG4gICAgICBmaWxlcy5sZW5ndGggPiAwID8gZmlsZXMubWFwKGYgPT4gYC0gXFxgJHtmfVxcYGApLmpvaW4oXCJcXG5cIikgOiBcIl8obm9uZSlfXCI7XG5cbiAgICAvLyBMb2FkIGFuZCBwb3B1bGF0ZSB0aGUgbWVyZ2UgcHJvbXB0XG4gICAgY29uc3Qgd3RQYXRoID0gd29ya3RyZWVQYXRoKGJhc2VQYXRoLCBuYW1lKTtcbiAgICBjb25zdCBwcm9tcHQgPSBsb2FkUHJvbXB0KFwid29ya3RyZWUtbWVyZ2VcIiwge1xuICAgICAgd29ya3RyZWVOYW1lOiBuYW1lLFxuICAgICAgd29ya3RyZWVCcmFuY2g6IGJyYW5jaCxcbiAgICAgIG1haW5CcmFuY2gsXG4gICAgICBtYWluVHJlZVBhdGg6IGJhc2VQYXRoLFxuICAgICAgd29ya3RyZWVQYXRoOiB3dFBhdGgsXG4gICAgICBjb21taXRMb2c6IGNvbW1pdExvZyB8fCBcIihubyBjb21taXRzKVwiLFxuICAgICAgYWRkZWRGaWxlczogZm9ybWF0RmlsZXMoZGlmZlN1bW1hcnkuYWRkZWQpLFxuICAgICAgbW9kaWZpZWRGaWxlczogZm9ybWF0RmlsZXMoZGlmZlN1bW1hcnkubW9kaWZpZWQpLFxuICAgICAgcmVtb3ZlZEZpbGVzOiBmb3JtYXRGaWxlcyhkaWZmU3VtbWFyeS5yZW1vdmVkKSxcbiAgICAgIGdzZERpZmY6IGdzZERpZmYgfHwgXCIobm8gR1NEIGFydGlmYWN0IGNoYW5nZXMpXCIsXG4gICAgICBjb2RlRGlmZjogY29kZURpZmYgfHwgXCIobm8gY29kZSBjaGFuZ2VzKVwiLFxuICAgIH0pO1xuXG4gICAgLy8gRGlzcGF0Y2ggdG8gdGhlIExMTVxuICAgIHBpLnNlbmRNZXNzYWdlKFxuICAgICAge1xuICAgICAgICBjdXN0b21UeXBlOiBcImdzZC13b3JrdHJlZS1tZXJnZVwiLFxuICAgICAgICBjb250ZW50OiBwcm9tcHQsXG4gICAgICAgIGRpc3BsYXk6IGZhbHNlLFxuICAgICAgfSxcbiAgICAgIHsgdHJpZ2dlclR1cm46IHRydWUgfSxcbiAgICApO1xuXG4gICAgY3R4LnVpLm5vdGlmeShcbiAgICAgIGAke0NMUi5vayhcIlx1MjcxM1wiKX0gTWVyZ2UgaGVscGVyIHN0YXJ0ZWQgZm9yICR7Q0xSLm5hbWUobmFtZSl9ICR7Q0xSLm11dGVkKGAoJHtjb2RlQ2hhbmdlc30gY29kZSArICR7Z3NkQ2hhbmdlc30gR1NEIGFydGlmYWN0IGNoYW5nZSR7dG90YWxDaGFuZ2VzID09PSAxID8gXCJcIiA6IFwic1wifSlgKX1gLFxuICAgICAgXCJpbmZvXCIsXG4gICAgKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zdCBtc2cgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XG4gICAgY3R4LnVpLm5vdGlmeShgRmFpbGVkIHRvIHN0YXJ0IG1lcmdlOiAke21zZ31gLCBcImVycm9yXCIpO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZVJlbW92ZShcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgbmFtZTogc3RyaW5nLFxuICBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIHRyeSB7XG4gICAgY29uc3QgbWFpbkJhc2UgPSBnZXRXb3JrdHJlZU9yaWdpbmFsQ3dkKCkgPz8gYmFzZVBhdGg7XG5cbiAgICAvLyBWYWxpZGF0ZSB0aGUgd29ya3RyZWUgZXhpc3RzIGJlZm9yZSBhdHRlbXB0aW5nIHJlbW92YWxcbiAgICBjb25zdCB3b3JrdHJlZXMgPSBsaXN0V29ya3RyZWVzKG1haW5CYXNlKTtcbiAgICBjb25zdCB3dCA9IHdvcmt0cmVlcy5maW5kKHcgPT4gdy5uYW1lID09PSBuYW1lKTtcbiAgICBpZiAoIXd0KSB7XG4gICAgICBjdHgudWkubm90aWZ5KGBXb3JrdHJlZSBcIiR7bmFtZX1cIiBub3QgZm91bmQuIFJ1biAvd29ya3RyZWUgbGlzdCB0byBzZWUgYXZhaWxhYmxlIHdvcmt0cmVlcy5gLCBcIndhcm5pbmdcIik7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgY29uZmlybWVkID0gYXdhaXQgc2hvd0NvbmZpcm0oY3R4LCB7XG4gICAgICB0aXRsZTogXCJSZW1vdmUgV29ya3RyZWVcIixcbiAgICAgIG1lc3NhZ2U6IGBSZW1vdmUgd29ya3RyZWUgJHtDTFIubmFtZShuYW1lKX0gYW5kIGRlbGV0ZSBicmFuY2ggJHtDTFIuYnJhbmNoKHd0LmJyYW5jaCl9P2AsXG4gICAgICBjb25maXJtTGFiZWw6IFwiUmVtb3ZlXCIsXG4gICAgICBkZWNsaW5lTGFiZWw6IFwiQ2FuY2VsXCIsXG4gICAgfSk7XG4gICAgaWYgKCFjb25maXJtZWQpIHtcbiAgICAgIGN0eC51aS5ub3RpZnkoXCJDYW5jZWxsZWQuXCIsIFwiaW5mb1wiKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCBwcmV2Q3dkID0gcHJvY2Vzcy5jd2QoKTtcbiAgICByZW1vdmVXb3JrdHJlZShtYWluQmFzZSwgbmFtZSwgeyBkZWxldGVCcmFuY2g6IHRydWUgfSk7XG5cbiAgICAvLyBJZiB3ZSB3ZXJlIGluIHRoYXQgd29ya3RyZWUsIHJlbW92ZVdvcmt0cmVlIGNoZGlyJ2QgdXMgb3V0IFx1MjAxNCBjbGVhciB0cmFja2luZ1xuICAgIGlmIChnZXRXb3JrdHJlZU9yaWdpbmFsQ3dkKCkgJiYgcHJvY2Vzcy5jd2QoKSAhPT0gcHJldkN3ZCkge1xuICAgICAgbnVkZ2VHaXRCcmFuY2hDYWNoZShwcmV2Q3dkKTtcbiAgICAgIGNsZWFyV29ya3RyZWVPcmlnaW5hbEN3ZCgpO1xuICAgIH1cblxuICAgIGN0eC51aS5ub3RpZnkoYCR7Q0xSLm9rKFwiXHUyNzEzXCIpfSBXb3JrdHJlZSAke0NMUi5uYW1lKG5hbWUpfSByZW1vdmVkICR7Q0xSLm11dGVkKFwiKGJyYW5jaCBkZWxldGVkKVwiKX0uYCwgXCJpbmZvXCIpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnN0IG1zZyA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbiAgICBjdHgudWkubm90aWZ5KGBGYWlsZWQgdG8gcmVtb3ZlIHdvcmt0cmVlOiAke21zZ31gLCBcImVycm9yXCIpO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZVJlbW92ZUFsbChcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCxcbik6IFByb21pc2U8dm9pZD4ge1xuICB0cnkge1xuICAgIGNvbnN0IG1haW5CYXNlID0gZ2V0V29ya3RyZWVPcmlnaW5hbEN3ZCgpID8/IGJhc2VQYXRoO1xuICAgIGNvbnN0IHdvcmt0cmVlcyA9IGxpc3RXb3JrdHJlZXMobWFpbkJhc2UpO1xuXG4gICAgaWYgKHdvcmt0cmVlcy5sZW5ndGggPT09IDApIHtcbiAgICAgIGN0eC51aS5ub3RpZnkoXCJObyB3b3JrdHJlZXMgdG8gcmVtb3ZlLlwiLCBcImluZm9cIik7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgbmFtZXMgPSB3b3JrdHJlZXMubWFwKHcgPT4gdy5uYW1lKTtcbiAgICBjb25zdCBjb25maXJtZWQgPSBhd2FpdCBzaG93Q29uZmlybShjdHgsIHtcbiAgICAgIHRpdGxlOiBcIlJlbW92ZSBBbGwgV29ya3RyZWVzXCIsXG4gICAgICBtZXNzYWdlOiBgUmVtb3ZlICR7d29ya3RyZWVzLmxlbmd0aH0gd29ya3RyZWUke3dvcmt0cmVlcy5sZW5ndGggPT09IDEgPyBcIlwiIDogXCJzXCJ9IGFuZCBkZWxldGUgdGhlaXIgYnJhbmNoZXM/XFxuXFxuJHtuYW1lcy5tYXAobiA9PiBgICBcdTIwMjIgJHtDTFIubmFtZShuKX1gKS5qb2luKFwiXFxuXCIpfWAsXG4gICAgICBjb25maXJtTGFiZWw6IFwiUmVtb3ZlIGFsbFwiLFxuICAgICAgZGVjbGluZUxhYmVsOiBcIkNhbmNlbFwiLFxuICAgIH0pO1xuICAgIGlmICghY29uZmlybWVkKSB7XG4gICAgICBjdHgudWkubm90aWZ5KFwiQ2FuY2VsbGVkLlwiLCBcImluZm9cIik7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgcHJldkN3ZCA9IHByb2Nlc3MuY3dkKCk7XG4gICAgY29uc3QgcmVtb3ZlZDogc3RyaW5nW10gPSBbXTtcbiAgICBjb25zdCBmYWlsZWQ6IHN0cmluZ1tdID0gW107XG5cbiAgICBmb3IgKGNvbnN0IHd0IG9mIHdvcmt0cmVlcykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgcmVtb3ZlV29ya3RyZWUobWFpbkJhc2UsIHd0Lm5hbWUsIHsgZGVsZXRlQnJhbmNoOiB0cnVlIH0pO1xuICAgICAgICByZW1vdmVkLnB1c2god3QubmFtZSk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgZmFpbGVkLnB1c2god3QubmFtZSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gSWYgd2Ugd2VyZSBpbiBhIHdvcmt0cmVlIHRoYXQgZ290IHJlbW92ZWQsIGNsZWFyIHRyYWNraW5nXG4gICAgaWYgKGdldFdvcmt0cmVlT3JpZ2luYWxDd2QoKSAmJiBwcm9jZXNzLmN3ZCgpICE9PSBwcmV2Q3dkKSB7XG4gICAgICBudWRnZUdpdEJyYW5jaENhY2hlKHByZXZDd2QpO1xuICAgICAgY2xlYXJXb3JrdHJlZU9yaWdpbmFsQ3dkKCk7XG4gICAgfVxuXG4gICAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG4gICAgaWYgKHJlbW92ZWQubGVuZ3RoID4gMCkgbGluZXMucHVzaChgJHtDTFIub2soXCJcdTI3MTNcIil9IFJlbW92ZWQ6ICR7cmVtb3ZlZC5tYXAobiA9PiBDTFIubmFtZShuKSkuam9pbihcIiwgXCIpfWApO1xuICAgIGlmIChmYWlsZWQubGVuZ3RoID4gMCkgbGluZXMucHVzaChgJHtDTFIud2FybihcIlx1MjcxN1wiKX0gRmFpbGVkOiAke2ZhaWxlZC5tYXAobiA9PiBDTFIubmFtZShuKSkuam9pbihcIiwgXCIpfWApO1xuICAgIGN0eC51aS5ub3RpZnkobGluZXMuam9pbihcIlxcblwiKSwgZmFpbGVkLmxlbmd0aCA+IDAgPyBcIndhcm5pbmdcIiA6IFwiaW5mb1wiKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zdCBtc2cgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XG4gICAgY3R4LnVpLm5vdGlmeShgRmFpbGVkIHRvIHJlbW92ZSB3b3JrdHJlZXM6ICR7bXNnfWAsIFwiZXJyb3JcIik7XG4gIH1cbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQWFBLFNBQVMsa0JBQWtCO0FBQzNCLFNBQVMseUJBQXlCLGVBQW1DLDJCQUEyQjtBQUNoRyxTQUFTLGlDQUFpQztBQUMxQyxTQUFTLG1CQUFtQjtBQUM1QixTQUFTLFNBQVMsZUFBZSw4QkFBOEI7QUFDL0Q7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFB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QUk7QUFDNUIsVUFBTSxVQUFvQixDQUFDO0FBQzNCLFVBQU0sU0FBbUIsQ0FBQztBQUUxQixlQUFXLE1BQU0sV0FBVztBQUMxQixVQUFJO0FBQ0YsdUJBQWUsVUFBVSxHQUFHLE1BQU0sRUFBRSxjQUFjLEtBQUssQ0FBQztBQUN4RCxnQkFBUSxLQUFLLEdBQUcsSUFBSTtBQUFBLE1BQ3RCLFFBQVE7QUFDTixlQUFPLEtBQUssR0FBRyxJQUFJO0FBQUEsTUFDckI7QUFBQSxJQUNGO0FBR0EsUUFBSSx1QkFBdUIsS0FBSyxRQUFRLElBQUksTUFBTSxTQUFTO0FBQ3pELDBCQUFvQixPQUFPO0FBQzNCLCtCQUF5QjtBQUFBLElBQzNCO0FBRUEsVUFBTSxRQUFrQixDQUFDO0FBQ3pCLFFBQUksUUFBUSxTQUFTLEVBQUcsT0FBTSxLQUFLLEdBQUcsSUFBSSxHQUFHLFFBQUcsQ0FBQyxhQUFhLFFBQVEsSUFBSSxPQUFLLElBQUksS0FBSyxDQUFDLENBQUMsRUFBRSxLQUFLLElBQUksQ0FBQyxFQUFFO0FBQ3hHLFFBQUksT0FBTyxTQUFTLEVBQUcsT0FBTSxLQUFLLEdBQUcsSUFBSSxLQUFLLFFBQUcsQ0FBQyxZQUFZLE9BQU8sSUFBSSxPQUFLLElBQUksS0FBSyxDQUFDLENBQUMsRUFBRSxLQUFLLElBQUksQ0FBQyxFQUFFO0FBQ3ZHLFFBQUksR0FBRyxPQUFPLE1BQU0sS0FBSyxJQUFJLEdBQUcsT0FBTyxTQUFTLElBQUksWUFBWSxNQUFNO0FBQUEsRUFDeEUsU0FBUyxPQUFPO0FBQ2QsVUFBTSxNQUFNLGlCQUFpQixRQUFRLE1BQU0sVUFBVSxPQUFPLEtBQUs7QUFDakUsUUFBSSxHQUFHLE9BQU8sK0JBQStCLEdBQUcsSUFBSSxPQUFPO0FBQUEsRUFDN0Q7QUFDRjsiLAogICJuYW1lcyI6IFsiZ2V0QWN0aXZlV29ya3RyZWVOYW1lIiwgImdldFdvcmt0cmVlT3JpZ2luYWxDd2QiLCAibWFpbkJhc2UiLCAiZXhpc3RpbmciXQp9Cg==
