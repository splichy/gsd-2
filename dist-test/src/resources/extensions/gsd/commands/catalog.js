import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadRegistry } from "../workflow-templates.js";
import { gsdHome } from "../gsd-home.js";
import { VISUAL_BRIEF_MODES } from "../../visual-brief/prompts.js";
const GSD_COMMAND_DESCRIPTION = "GSD \u2014 Get Shit Done: /gsd help|start|templates|next|auto|stop|pause|status|widget|visualize|brief|queue|quick|discuss|capture|triage|dispatch|history|undo|undo-task|reset-slice|rate|skip|export|cleanup|model|mode|prefs|config|keys|hooks|run-hook|skill-health|doctor|debug|logs|forensics|changelog|migrate|remote|steer|knowledge|new-milestone|new-project|parallel|cmux|park|unpark|init|setup|onboarding|inspect|extensions|update|fast|mcp|rethink|workflow|codebase|notifications|ship|do|session-report|backlog|pr-branch|add-tests|scan|language|worktree|eval-review";
const TOP_LEVEL_SUBCOMMANDS = [
  { cmd: "help", desc: "Categorized command reference with descriptions" },
  { cmd: "next", desc: "Explicit step mode (same as /gsd)" },
  { cmd: "auto", desc: "Autonomous mode \u2014 research, plan, execute, commit, repeat" },
  { cmd: "stop", desc: "Stop auto mode gracefully" },
  { cmd: "pause", desc: "Pause auto-mode (preserves state, /gsd auto to resume)" },
  { cmd: "status", desc: "Progress dashboard" },
  { cmd: "widget", desc: "Cycle widget: full \u2192 small \u2192 min \u2192 off" },
  { cmd: "visualize", desc: "Open 10-tab workflow visualizer (progress, timeline, deps, metrics, health, agent, changes, knowledge, captures, export)" },
  { cmd: "brief", desc: "Generate a visual HTML brief: diagram, plan, diff review, recap, table, or slides" },
  { cmd: "queue", desc: "Queue and reorder future milestones" },
  { cmd: "quick", desc: "Execute a quick task without full planning overhead" },
  { cmd: "discuss", desc: "Discuss architecture and decisions" },
  { cmd: "capture", desc: "Fire-and-forget thought capture" },
  { cmd: "changelog", desc: "Show categorized release notes" },
  { cmd: "triage", desc: "Manually trigger triage of pending captures" },
  { cmd: "dispatch", desc: "Dispatch a specific phase directly" },
  { cmd: "history", desc: "View execution history" },
  { cmd: "undo", desc: "Revert last completed unit" },
  { cmd: "undo-task", desc: "Reset a specific task's completion state (DB + markdown)" },
  { cmd: "reset-slice", desc: "Reset a slice and all its tasks (DB + markdown)" },
  { cmd: "rate", desc: "Rate last unit's model tier (over/ok/under) \u2014 improves adaptive routing" },
  { cmd: "skip", desc: "Prevent a unit from auto-mode dispatch" },
  { cmd: "export", desc: "Export milestone/slice results" },
  { cmd: "cleanup", desc: "Remove merged branches or snapshots" },
  { cmd: "model", desc: "Switch the active session model or open a picker" },
  { cmd: "mode", desc: "Switch workflow mode (solo/team)" },
  { cmd: "prefs", desc: "Manage preferences (model selection, timeouts, etc.)" },
  { cmd: "config", desc: "(deprecated) Set tool API keys \u2014 use /gsd keys instead" },
  { cmd: "keys", desc: "API key manager \u2014 list, add, remove, test, rotate, doctor" },
  { cmd: "hooks", desc: "Show configured post-unit and pre-dispatch hooks" },
  { cmd: "run-hook", desc: "Manually trigger a specific hook" },
  { cmd: "skill-health", desc: "Skill lifecycle dashboard" },
  { cmd: "notifications", desc: "View, filter, and clear persistent notification history" },
  { cmd: "doctor", desc: "Runtime health checks with auto-fix" },
  { cmd: "logs", desc: "Browse activity logs, debug logs, and metrics" },
  { cmd: "debug", desc: "Create and inspect persistent /gsd debug sessions" },
  { cmd: "forensics", desc: "Examine execution logs" },
  { cmd: "init", desc: "Project init wizard \u2014 detect, configure, bootstrap .gsd/" },
  { cmd: "setup", desc: "Configuration hub: status + sub-routes (llm, model, search, remote, keys, prefs, onboarding)" },
  { cmd: "onboarding", desc: "Re-run the setup wizard  [--resume|--reset|--step <name>]" },
  { cmd: "migrate", desc: "Migrate a v1 .planning directory to .gsd format" },
  { cmd: "remote", desc: "Control remote auto-mode" },
  { cmd: "steer", desc: "Hard-steer plan documents during execution" },
  { cmd: "inspect", desc: "Show SQLite DB diagnostics" },
  { cmd: "knowledge", desc: "Add persistent project knowledge (rule, pattern, or lesson)" },
  { cmd: "new-milestone", desc: "Create a milestone from a specification document (headless)" },
  { cmd: "new-project", desc: "Bootstrap a new project (use --deep for staged project-level discovery)" },
  { cmd: "parallel", desc: "Parallel milestone orchestration (start, status, stop, merge, watch)" },
  { cmd: "cmux", desc: "Manage cmux integration (status, sidebar, notifications, splits)" },
  { cmd: "park", desc: "Park a milestone \u2014 skip without deleting" },
  { cmd: "unpark", desc: "Reactivate a parked milestone" },
  { cmd: "update", desc: "Update GSD to the latest version" },
  { cmd: "start", desc: "Start a workflow template (bugfix, spike, feature, etc.)" },
  { cmd: "templates", desc: "List available workflow templates" },
  { cmd: "extensions", desc: "Manage extensions (list, enable, disable, info)" },
  { cmd: "fast", desc: "Toggle OpenAI service tier (on/off/flex/status)" },
  { cmd: "mcp", desc: "MCP server status, connectivity, and local config bootstrap (status, check, init)" },
  { cmd: "rethink", desc: "Conversational project reorganization \u2014 reorder, park, discard, add milestones" },
  { cmd: "workflow", desc: "Custom workflow lifecycle (new, run, list, info, install, uninstall, validate, pause, resume) or run <name> directly" },
  { cmd: "codebase", desc: "Generate, refresh, and inspect the codebase map cache (.gsd/CODEBASE.md)" },
  { cmd: "ship", desc: "Create PR from milestone artifacts and open for review" },
  { cmd: "do", desc: "Route freeform text to the right GSD command" },
  { cmd: "session-report", desc: "Session cost, tokens, and work summary" },
  { cmd: "backlog", desc: "Manage backlog items (add, promote, remove, list)" },
  { cmd: "pr-branch", desc: "Create clean PR branch filtering .gsd/ commits" },
  { cmd: "add-tests", desc: "Generate tests for completed slices" },
  { cmd: "scan", desc: "Rapid codebase assessment \u2014 lightweight alternative to full map (--focus tech|arch|quality|concerns|tech+arch)" },
  { cmd: "language", desc: "Set or clear the global response language (e.g. /gsd language Chinese)" },
  { cmd: "worktree", desc: "Manage worktrees from the TUI (list, merge, clean, remove)" },
  { cmd: "eval-review", desc: "Audit a slice's AI evaluation strategy and write a scored EVAL-REVIEW.md (--force, --show)" }
];
const NESTED_COMPLETIONS = {
  brief: VISUAL_BRIEF_MODES.map((mode) => ({ cmd: mode.mode, desc: mode.description })),
  auto: [
    { cmd: "--verbose", desc: "Show detailed execution output" },
    { cmd: "--debug", desc: "Enable debug logging" }
  ],
  next: [
    { cmd: "--verbose", desc: "Show detailed step output" },
    { cmd: "--dry-run", desc: "Preview next step without executing" },
    { cmd: "--debug", desc: "Enable debug logging" }
  ],
  widget: [
    { cmd: "full", desc: "Full widget display" },
    { cmd: "small", desc: "Compact widget display" },
    { cmd: "min", desc: "Minimal widget display" },
    { cmd: "off", desc: "Hide widget" }
  ],
  mode: [
    { cmd: "global", desc: "Edit global workflow mode" },
    { cmd: "project", desc: "Edit project-specific workflow mode" }
  ],
  parallel: [
    { cmd: "start", desc: "Start parallel milestone orchestration" },
    { cmd: "status", desc: "Show parallel worker statuses" },
    { cmd: "stop", desc: "Stop all parallel workers" },
    { cmd: "pause", desc: "Pause a specific worker" },
    { cmd: "resume", desc: "Resume a paused worker" },
    { cmd: "merge", desc: "Merge completed milestone branches" },
    { cmd: "watch", desc: "Live TUI dashboard monitoring all workers" }
  ],
  setup: [
    { cmd: "llm", desc: "Configure LLM provider & auth" },
    { cmd: "model", desc: "Pick default model for the active provider" },
    { cmd: "search", desc: "Configure web search provider" },
    { cmd: "remote", desc: "Configure remote integrations (Discord/Slack/Telegram)" },
    { cmd: "keys", desc: "Manage API keys (alias for /gsd keys)" },
    { cmd: "prefs", desc: "Global preferences wizard (alias for /gsd prefs)" },
    { cmd: "onboarding", desc: "Run the full onboarding wizard (alias for /gsd onboarding)" }
  ],
  onboarding: [
    { cmd: "--resume", desc: "Resume from the last completed step" },
    { cmd: "--reset", desc: "Reset onboarding state and start over (does not clear API keys)" },
    { cmd: "--step", desc: "Run a single step: llm|model|search|remote|tool-keys|prefs|skills|doctor|project" }
  ],
  notifications: [
    { cmd: "clear", desc: "Clear all notifications" },
    { cmd: "tail", desc: "Show last N notifications (default: 20)" },
    { cmd: "filter", desc: "Filter by severity (error|warning|info|success)" }
  ],
  logs: [
    { cmd: "debug", desc: "List or view debug log files" },
    { cmd: "tail", desc: "Show last N activity log summaries" },
    { cmd: "clear", desc: "Remove old activity and debug logs" }
  ],
  debug: [
    { cmd: "list", desc: "List persisted debug sessions" },
    { cmd: "status", desc: "Show status for one debug session slug" },
    { cmd: "continue", desc: "Resume an existing debug session slug" },
    { cmd: "--diagnose", desc: "Inspect malformed artifacts and session health" }
  ],
  keys: [
    { cmd: "list", desc: "Show key status dashboard" },
    { cmd: "add", desc: "Add a key for a provider" },
    { cmd: "remove", desc: "Remove a key" },
    { cmd: "test", desc: "Validate key(s) with API call" },
    { cmd: "rotate", desc: "Replace an existing key" },
    { cmd: "doctor", desc: "Health check all keys" }
  ],
  prefs: [
    { cmd: "global", desc: "Edit global preferences file" },
    { cmd: "project", desc: "Edit project preferences file" },
    { cmd: "status", desc: "Show effective preferences" },
    { cmd: "wizard", desc: "Interactive preferences wizard" },
    { cmd: "setup", desc: "First-time preferences setup" },
    { cmd: "import-claude", desc: "Import settings from Claude Code" }
  ],
  remote: [
    { cmd: "slack", desc: "Configure Slack integration" },
    { cmd: "discord", desc: "Configure Discord integration" },
    { cmd: "status", desc: "Show remote connection status" },
    { cmd: "disconnect", desc: "Disconnect remote integrations" }
  ],
  history: [
    { cmd: "--cost", desc: "Show cost breakdown per entry" },
    { cmd: "--phase", desc: "Filter by phase type" },
    { cmd: "--model", desc: "Filter by model used" },
    { cmd: "10", desc: "Show last 10 entries" },
    { cmd: "20", desc: "Show last 20 entries" },
    { cmd: "50", desc: "Show last 50 entries" }
  ],
  export: [
    { cmd: "--json", desc: "Export as JSON" },
    { cmd: "--markdown", desc: "Export as Markdown" },
    { cmd: "--html", desc: "Export as HTML" },
    { cmd: "--html --all", desc: "Export all milestones as HTML" }
  ],
  cleanup: [
    { cmd: "branches", desc: "Remove merged milestone and legacy branches" },
    { cmd: "snapshots", desc: "Remove old execution snapshots" },
    { cmd: "worktrees", desc: "Remove merged/safe-to-delete worktrees" },
    { cmd: "projects", desc: "Audit orphaned ~/.gsd/projects/ state directories" },
    { cmd: "projects --fix", desc: "Delete orphaned project state directories (cannot be undone)" }
  ],
  knowledge: [
    { cmd: "rule", desc: "Add a project rule (always/never do X)" },
    { cmd: "pattern", desc: "Add a code pattern to follow" },
    { cmd: "lesson", desc: "Record a lesson learned" }
  ],
  start: [
    { cmd: "bugfix", desc: "Triage, fix, test, and ship a bug fix" },
    { cmd: "small-feature", desc: "Lightweight feature with optional discussion" },
    { cmd: "spike", desc: "Research, prototype, and document findings" },
    { cmd: "hotfix", desc: "Minimal: fix it, test it, ship it" },
    { cmd: "refactor", desc: "Inventory, plan waves, migrate, verify" },
    { cmd: "security-audit", desc: "Scan, triage, remediate, re-scan" },
    { cmd: "dep-upgrade", desc: "Assess, upgrade, fix breaks, verify" },
    { cmd: "full-project", desc: "Complete GSD workflow with full ceremony" },
    { cmd: "resume", desc: "Resume an in-progress workflow" },
    { cmd: "--list", desc: "List all available templates" },
    { cmd: "--dry-run", desc: "Preview workflow without executing" }
  ],
  templates: [
    { cmd: "info", desc: "Show detailed template info" }
  ],
  extensions: [
    { cmd: "list", desc: "List all extensions and their status" },
    { cmd: "enable", desc: "Enable a disabled extension" },
    { cmd: "disable", desc: "Disable an extension" },
    { cmd: "info", desc: "Show extension details" }
  ],
  fast: [
    { cmd: "on", desc: "Priority tier (2x cost, faster)" },
    { cmd: "off", desc: "Disable service tier" },
    { cmd: "flex", desc: "Flex tier (0.5x cost, slower)" },
    { cmd: "status", desc: "Show current service tier setting" }
  ],
  mcp: [
    { cmd: "status", desc: "Show all MCP server statuses (default)" },
    { cmd: "check", desc: "Detailed status for a specific server" },
    { cmd: "init", desc: "Write .mcp.json for the local GSD workflow MCP server" }
  ],
  doctor: [
    { cmd: "fix", desc: "Auto-fix detected issues" },
    { cmd: "heal", desc: "AI-driven deep healing" },
    { cmd: "audit", desc: "Run health audit without fixing" },
    { cmd: "--dry-run", desc: "Show what --fix would change without applying" },
    { cmd: "--json", desc: "Output report as JSON (CI/tooling friendly)" },
    { cmd: "--build", desc: "Include slow build health check (npm run build)" },
    { cmd: "--test", desc: "Include slow test health check (npm test)" }
  ],
  dispatch: [
    { cmd: "research", desc: "Run research phase" },
    { cmd: "plan", desc: "Run planning phase" },
    { cmd: "execute", desc: "Run execution phase" },
    { cmd: "complete", desc: "Run completion phase" },
    { cmd: "reassess", desc: "Reassess current progress" },
    { cmd: "uat", desc: "Run user acceptance testing" },
    { cmd: "replan", desc: "Replan the current slice" }
  ],
  rate: [
    { cmd: "over", desc: "Model was overqualified for this task" },
    { cmd: "ok", desc: "Model was appropriate for this task" },
    { cmd: "under", desc: "Model was underqualified for this task" }
  ],
  workflow: [
    { cmd: "new", desc: "Create a new workflow definition (via skill)" },
    { cmd: "run", desc: "Create a YAML run and start auto-mode" },
    { cmd: "list", desc: "List workflow runs" },
    { cmd: "info", desc: "Show plugin details (source, mode, phases)" },
    { cmd: "install", desc: "Install a plugin from a URL / gist: / gh:" },
    { cmd: "uninstall", desc: "Remove an installed plugin" },
    { cmd: "validate", desc: "Validate a workflow definition YAML" },
    { cmd: "pause", desc: "Pause custom workflow auto-mode" },
    { cmd: "resume", desc: "Resume paused custom workflow auto-mode" }
  ],
  codebase: [
    { cmd: "generate", desc: "Generate or regenerate CODEBASE.md" },
    { cmd: "generate --max-files", desc: "Generate with custom file limit (default: 500)" },
    { cmd: "generate --collapse-threshold", desc: "Generate with custom collapse threshold (default: 20)" },
    { cmd: "update", desc: "Refresh the CODEBASE.md cache immediately (preserves descriptions)" },
    { cmd: "update --max-files", desc: "Update with custom file limit" },
    { cmd: "update --collapse-threshold", desc: "Update with custom collapse threshold" },
    { cmd: "stats", desc: "Show file count, description coverage, and generation time" },
    { cmd: "help", desc: "Show usage and available subcommands" }
  ],
  ship: [
    { cmd: "--dry-run", desc: "Preview PR without creating" },
    { cmd: "--draft", desc: "Open as draft PR" },
    { cmd: "--base", desc: "Override target branch (default: main)" },
    { cmd: "--force", desc: "Ship even with pending tasks" }
  ],
  "session-report": [
    { cmd: "--json", desc: "Machine-readable JSON output" },
    { cmd: "--save", desc: "Save report to .gsd/reports/" }
  ],
  backlog: [
    { cmd: "add", desc: "Add item to backlog" },
    { cmd: "promote", desc: "Promote backlog item to active slice" },
    { cmd: "remove", desc: "Remove backlog item" }
  ],
  "pr-branch": [
    { cmd: "--dry-run", desc: "Preview what would be filtered" },
    { cmd: "--name", desc: "Custom branch name" }
  ],
  scan: [
    { cmd: "--focus tech", desc: "Technology stack and external integrations" },
    { cmd: "--focus arch", desc: "Architecture patterns and directory structure" },
    { cmd: "--focus quality", desc: "Coding conventions and testing patterns" },
    { cmd: "--focus concerns", desc: "Technical debt and risk areas" },
    { cmd: "--focus tech+arch", desc: "Tech + Architecture (default)" }
  ],
  language: [
    { cmd: "off", desc: "Clear the language preference (revert to default)" },
    { cmd: "clear", desc: "Alias for off \u2014 clear the language preference" }
  ],
  worktree: [
    { cmd: "list", desc: "Show all worktrees with status" },
    { cmd: "merge", desc: "Merge a worktree into main and clean up" },
    { cmd: "clean", desc: "Remove all merged/empty worktrees" },
    { cmd: "remove", desc: "Remove a worktree (--force to skip safety checks)" }
  ]
};
function filterOptions(partial, options, prefix = "") {
  const normalizedPrefix = prefix ? `${prefix} ` : "";
  return options.filter((option) => option.cmd.startsWith(partial)).map((option) => ({
    value: `${normalizedPrefix}${option.cmd}`,
    label: option.cmd,
    description: option.desc
  }));
}
function getExtensionCompletions(prefix, action) {
  try {
    const extDir = join(gsdHome(), "agent", "extensions");
    const ids = [];
    for (const entry of readdirSync(extDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(extDir, entry.name, "extension-manifest.json");
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        if (typeof manifest?.id === "string") {
          ids.push({ id: manifest.id, name: manifest.name ?? manifest.id });
        }
      } catch {
      }
    }
    return ids.filter((entry) => entry.id.startsWith(prefix)).map((entry) => ({
      value: `extensions ${action} ${entry.id}`,
      label: entry.id,
      description: entry.name
    }));
  } catch {
    return [];
  }
}
function normalizePathForCompare(path) {
  return path.replaceAll("\\", "/").replace(/\/+$/, "");
}
function findWorktreeSegment(normalizedPath) {
  const directMarker = "/.gsd/worktrees/";
  const directIdx = normalizedPath.indexOf(directMarker);
  if (directIdx !== -1) {
    return { gsdIdx: directIdx, afterWorktrees: directIdx + directMarker.length };
  }
  const symlinkMatch = normalizedPath.match(/\/\.gsd\/projects\/[a-f0-9]+\/worktrees\//);
  if (symlinkMatch?.index !== void 0) {
    return { gsdIdx: symlinkMatch.index, afterWorktrees: symlinkMatch.index + symlinkMatch[0].length };
  }
  return null;
}
function resolveProjectRootFromGitFile(worktreePath) {
  try {
    let dir = worktreePath;
    for (let i = 0; i < 30; i++) {
      const gitPath = join(dir, ".git");
      if (existsSync(gitPath)) {
        const content = readFileSync(gitPath, "utf8").trim();
        if (content.startsWith("gitdir: ")) {
          const gitDir = resolve(dir, content.slice(8));
          const dotGitDir = resolve(gitDir, "..", "..");
          if (dotGitDir.endsWith(".git") || dotGitDir.endsWith(".git/") || dotGitDir.endsWith(".git\\")) {
            return resolve(dotGitDir, "..");
          }
          const commonDirPath = join(gitDir, "commondir");
          if (existsSync(commonDirPath)) {
            const commonDir = readFileSync(commonDirPath, "utf8").trim();
            return resolve(resolve(gitDir, commonDir), "..");
          }
        }
        break;
      }
      const parent = resolve(dir, "..");
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
  }
  return null;
}
function resolveProjectRootForCompletion(basePath) {
  if (process.env.GSD_PROJECT_ROOT) return process.env.GSD_PROJECT_ROOT;
  const normalizedPath = normalizePathForCompare(basePath);
  const segment = findWorktreeSegment(normalizedPath);
  if (!segment) return basePath;
  const separator = basePath.includes("\\") ? "\\" : "/";
  const gsdMarker = `${separator}.gsd${separator}`;
  const gsdIdx = basePath.indexOf(gsdMarker);
  const candidate = gsdIdx !== -1 ? basePath.slice(0, gsdIdx) : basePath.slice(0, segment.gsdIdx);
  const normalizedGsdHome = normalizePathForCompare(gsdHome());
  const candidateGsdPath = normalizePathForCompare(join(candidate, ".gsd"));
  if (candidateGsdPath === normalizedGsdHome || candidateGsdPath.startsWith(`${normalizedGsdHome}/`)) {
    return resolveProjectRootFromGitFile(basePath) ?? basePath;
  }
  return candidate;
}
function getGsdArgumentCompletions(prefix) {
  const hasTrailingSpace = prefix.endsWith(" ");
  const parts = prefix.trim().split(/\s+/);
  if (hasTrailingSpace && parts.length >= 1) {
    parts.push("");
  }
  if (parts.length <= 1) {
    return filterOptions(parts[0] ?? "", TOP_LEVEL_SUBCOMMANDS);
  }
  const [command, subcommand = "", third = ""] = parts;
  if (command === "cmux") {
    if (parts.length <= 2) {
      return filterOptions(subcommand, [
        { cmd: "status", desc: "Show cmux detection, prefs, and capabilities" },
        { cmd: "on", desc: "Enable cmux integration" },
        { cmd: "off", desc: "Disable cmux integration" },
        { cmd: "notifications", desc: "Toggle cmux desktop notifications" },
        { cmd: "sidebar", desc: "Toggle cmux sidebar metadata" },
        { cmd: "splits", desc: "Toggle cmux visual subagent splits" },
        { cmd: "browser", desc: "Toggle future browser integration flag" }
      ], "cmux");
    }
    if (parts.length <= 3 && ["notifications", "sidebar", "splits", "browser"].includes(subcommand)) {
      return filterOptions(third, [
        { cmd: "on", desc: "Enable this cmux area" },
        { cmd: "off", desc: "Disable this cmux area" }
      ], `cmux ${subcommand}`);
    }
    return [];
  }
  if (command === "templates" && subcommand === "info" && parts.length <= 3) {
    try {
      const registry = loadRegistry();
      return Object.entries(registry.templates).filter(([id]) => id.startsWith(third)).map(([id, entry]) => ({
        value: `templates info ${id}`,
        label: id,
        description: entry.description
      }));
    } catch {
      return [];
    }
  }
  if (command === "extensions" && parts.length === 3 && ["enable", "disable", "info"].includes(subcommand)) {
    return getExtensionCompletions(third, subcommand);
  }
  if (command === "undo" && parts.length <= 2) {
    return [{ value: "undo --force", label: "--force", description: "Skip confirmation prompt" }];
  }
  if (command === "workflow" && (subcommand === "run" || subcommand === "validate") && parts.length <= 3) {
    try {
      const defsDir = join(resolveProjectRootForCompletion(process.cwd()), ".gsd", "workflow-defs");
      if (existsSync(defsDir)) {
        return readdirSync(defsDir).filter((f) => f.endsWith(".yaml") && f.startsWith(third)).map((f) => {
          const name = f.replace(/\.yaml$/, "");
          return {
            value: `workflow ${subcommand} ${name}`,
            label: name,
            description: `Workflow definition: ${name}`
          };
        });
      }
    } catch {
    }
    return [];
  }
  if (command === "workflow" && subcommand === "info" && parts.length <= 3) {
    const results = [];
    const seen = /* @__PURE__ */ new Set();
    const scanDir = (dir, source) => {
      if (!existsSync(dir)) return;
      try {
        for (const f of readdirSync(dir)) {
          if (!/\.(ya?ml|md)$/i.test(f)) continue;
          const name = f.replace(/\.(ya?ml|md)$/i, "");
          if (!name.startsWith(third)) continue;
          if (seen.has(name)) continue;
          seen.add(name);
          results.push({ cmd: name, desc: `Workflow plugin (${source})` });
        }
      } catch {
      }
    };
    try {
      const base = resolveProjectRootForCompletion(process.cwd());
      scanDir(join(base, ".gsd", "workflows"), "project");
      scanDir(join(base, ".gsd", "workflow-defs"), "project-legacy");
      scanDir(join(gsdHome(), "workflows"), "global");
    } catch {
    }
    try {
      const registry = loadRegistry();
      for (const id of Object.keys(registry.templates)) {
        if (seen.has(id) || !id.startsWith(third)) continue;
        seen.add(id);
        results.push({ cmd: id, desc: "Workflow plugin (bundled)" });
      }
    } catch {
    }
    return results.map((r) => ({
      value: `workflow info ${r.cmd}`,
      label: r.cmd,
      description: r.desc
    }));
  }
  const nested = NESTED_COMPLETIONS[command];
  if (nested && parts.length <= 2) {
    return filterOptions(subcommand, nested, command);
  }
  return [];
}
export {
  GSD_COMMAND_DESCRIPTION,
  TOP_LEVEL_SUBCOMMANDS,
  getGsdArgumentCompletions
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9jb21tYW5kcy9jYXRhbG9nLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkRmlsZVN5bmMsIHJlYWRkaXJTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4sIHJlc29sdmUgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbmltcG9ydCB7IGxvYWRSZWdpc3RyeSB9IGZyb20gXCIuLi93b3JrZmxvdy10ZW1wbGF0ZXMuanNcIjtcbmltcG9ydCB7IGdzZEhvbWUgfSBmcm9tIFwiLi4vZ3NkLWhvbWUuanNcIjtcbmltcG9ydCB7IFZJU1VBTF9CUklFRl9NT0RFUyB9IGZyb20gXCIuLi8uLi92aXN1YWwtYnJpZWYvcHJvbXB0cy5qc1wiO1xuXG5cbmV4cG9ydCBpbnRlcmZhY2UgR3NkQ29tbWFuZERlZmluaXRpb24ge1xuICBjbWQ6IHN0cmluZztcbiAgZGVzYzogc3RyaW5nO1xufVxuXG50eXBlIENvbXBsZXRpb25NYXAgPSBSZWNvcmQ8c3RyaW5nLCByZWFkb25seSBHc2RDb21tYW5kRGVmaW5pdGlvbltdPjtcblxuZXhwb3J0IGNvbnN0IEdTRF9DT01NQU5EX0RFU0NSSVBUSU9OID1cbiAgXCJHU0QgXHUyMDE0IEdldCBTaGl0IERvbmU6IC9nc2QgaGVscHxzdGFydHx0ZW1wbGF0ZXN8bmV4dHxhdXRvfHN0b3B8cGF1c2V8c3RhdHVzfHdpZGdldHx2aXN1YWxpemV8YnJpZWZ8cXVldWV8cXVpY2t8ZGlzY3Vzc3xjYXB0dXJlfHRyaWFnZXxkaXNwYXRjaHxoaXN0b3J5fHVuZG98dW5kby10YXNrfHJlc2V0LXNsaWNlfHJhdGV8c2tpcHxleHBvcnR8Y2xlYW51cHxtb2RlbHxtb2RlfHByZWZzfGNvbmZpZ3xrZXlzfGhvb2tzfHJ1bi1ob29rfHNraWxsLWhlYWx0aHxkb2N0b3J8ZGVidWd8bG9nc3xmb3JlbnNpY3N8Y2hhbmdlbG9nfG1pZ3JhdGV8cmVtb3RlfHN0ZWVyfGtub3dsZWRnZXxuZXctbWlsZXN0b25lfG5ldy1wcm9qZWN0fHBhcmFsbGVsfGNtdXh8cGFya3x1bnBhcmt8aW5pdHxzZXR1cHxvbmJvYXJkaW5nfGluc3BlY3R8ZXh0ZW5zaW9uc3x1cGRhdGV8ZmFzdHxtY3B8cmV0aGlua3x3b3JrZmxvd3xjb2RlYmFzZXxub3RpZmljYXRpb25zfHNoaXB8ZG98c2Vzc2lvbi1yZXBvcnR8YmFja2xvZ3xwci1icmFuY2h8YWRkLXRlc3RzfHNjYW58bGFuZ3VhZ2V8d29ya3RyZWV8ZXZhbC1yZXZpZXdcIjtcblxuZXhwb3J0IGNvbnN0IFRPUF9MRVZFTF9TVUJDT01NQU5EUzogcmVhZG9ubHkgR3NkQ29tbWFuZERlZmluaXRpb25bXSA9IFtcbiAgeyBjbWQ6IFwiaGVscFwiLCBkZXNjOiBcIkNhdGVnb3JpemVkIGNvbW1hbmQgcmVmZXJlbmNlIHdpdGggZGVzY3JpcHRpb25zXCIgfSxcbiAgeyBjbWQ6IFwibmV4dFwiLCBkZXNjOiBcIkV4cGxpY2l0IHN0ZXAgbW9kZSAoc2FtZSBhcyAvZ3NkKVwiIH0sXG4gIHsgY21kOiBcImF1dG9cIiwgZGVzYzogXCJBdXRvbm9tb3VzIG1vZGUgXHUyMDE0IHJlc2VhcmNoLCBwbGFuLCBleGVjdXRlLCBjb21taXQsIHJlcGVhdFwiIH0sXG4gIHsgY21kOiBcInN0b3BcIiwgZGVzYzogXCJTdG9wIGF1dG8gbW9kZSBncmFjZWZ1bGx5XCIgfSxcbiAgeyBjbWQ6IFwicGF1c2VcIiwgZGVzYzogXCJQYXVzZSBhdXRvLW1vZGUgKHByZXNlcnZlcyBzdGF0ZSwgL2dzZCBhdXRvIHRvIHJlc3VtZSlcIiB9LFxuICB7IGNtZDogXCJzdGF0dXNcIiwgZGVzYzogXCJQcm9ncmVzcyBkYXNoYm9hcmRcIiB9LFxuICB7IGNtZDogXCJ3aWRnZXRcIiwgZGVzYzogXCJDeWNsZSB3aWRnZXQ6IGZ1bGwgXHUyMTkyIHNtYWxsIFx1MjE5MiBtaW4gXHUyMTkyIG9mZlwiIH0sXG4gIHsgY21kOiBcInZpc3VhbGl6ZVwiLCBkZXNjOiBcIk9wZW4gMTAtdGFiIHdvcmtmbG93IHZpc3VhbGl6ZXIgKHByb2dyZXNzLCB0aW1lbGluZSwgZGVwcywgbWV0cmljcywgaGVhbHRoLCBhZ2VudCwgY2hhbmdlcywga25vd2xlZGdlLCBjYXB0dXJlcywgZXhwb3J0KVwiIH0sXG4gIHsgY21kOiBcImJyaWVmXCIsIGRlc2M6IFwiR2VuZXJhdGUgYSB2aXN1YWwgSFRNTCBicmllZjogZGlhZ3JhbSwgcGxhbiwgZGlmZiByZXZpZXcsIHJlY2FwLCB0YWJsZSwgb3Igc2xpZGVzXCIgfSxcbiAgeyBjbWQ6IFwicXVldWVcIiwgZGVzYzogXCJRdWV1ZSBhbmQgcmVvcmRlciBmdXR1cmUgbWlsZXN0b25lc1wiIH0sXG4gIHsgY21kOiBcInF1aWNrXCIsIGRlc2M6IFwiRXhlY3V0ZSBhIHF1aWNrIHRhc2sgd2l0aG91dCBmdWxsIHBsYW5uaW5nIG92ZXJoZWFkXCIgfSxcbiAgeyBjbWQ6IFwiZGlzY3Vzc1wiLCBkZXNjOiBcIkRpc2N1c3MgYXJjaGl0ZWN0dXJlIGFuZCBkZWNpc2lvbnNcIiB9LFxuICB7IGNtZDogXCJjYXB0dXJlXCIsIGRlc2M6IFwiRmlyZS1hbmQtZm9yZ2V0IHRob3VnaHQgY2FwdHVyZVwiIH0sXG4gIHsgY21kOiBcImNoYW5nZWxvZ1wiLCBkZXNjOiBcIlNob3cgY2F0ZWdvcml6ZWQgcmVsZWFzZSBub3Rlc1wiIH0sXG4gIHsgY21kOiBcInRyaWFnZVwiLCBkZXNjOiBcIk1hbnVhbGx5IHRyaWdnZXIgdHJpYWdlIG9mIHBlbmRpbmcgY2FwdHVyZXNcIiB9LFxuICB7IGNtZDogXCJkaXNwYXRjaFwiLCBkZXNjOiBcIkRpc3BhdGNoIGEgc3BlY2lmaWMgcGhhc2UgZGlyZWN0bHlcIiB9LFxuICB7IGNtZDogXCJoaXN0b3J5XCIsIGRlc2M6IFwiVmlldyBleGVjdXRpb24gaGlzdG9yeVwiIH0sXG4gIHsgY21kOiBcInVuZG9cIiwgZGVzYzogXCJSZXZlcnQgbGFzdCBjb21wbGV0ZWQgdW5pdFwiIH0sXG4gIHsgY21kOiBcInVuZG8tdGFza1wiLCBkZXNjOiBcIlJlc2V0IGEgc3BlY2lmaWMgdGFzaydzIGNvbXBsZXRpb24gc3RhdGUgKERCICsgbWFya2Rvd24pXCIgfSxcbiAgeyBjbWQ6IFwicmVzZXQtc2xpY2VcIiwgZGVzYzogXCJSZXNldCBhIHNsaWNlIGFuZCBhbGwgaXRzIHRhc2tzIChEQiArIG1hcmtkb3duKVwiIH0sXG4gIHsgY21kOiBcInJhdGVcIiwgZGVzYzogXCJSYXRlIGxhc3QgdW5pdCdzIG1vZGVsIHRpZXIgKG92ZXIvb2svdW5kZXIpIFx1MjAxNCBpbXByb3ZlcyBhZGFwdGl2ZSByb3V0aW5nXCIgfSxcbiAgeyBjbWQ6IFwic2tpcFwiLCBkZXNjOiBcIlByZXZlbnQgYSB1bml0IGZyb20gYXV0by1tb2RlIGRpc3BhdGNoXCIgfSxcbiAgeyBjbWQ6IFwiZXhwb3J0XCIsIGRlc2M6IFwiRXhwb3J0IG1pbGVzdG9uZS9zbGljZSByZXN1bHRzXCIgfSxcbiAgeyBjbWQ6IFwiY2xlYW51cFwiLCBkZXNjOiBcIlJlbW92ZSBtZXJnZWQgYnJhbmNoZXMgb3Igc25hcHNob3RzXCIgfSxcbiAgeyBjbWQ6IFwibW9kZWxcIiwgZGVzYzogXCJTd2l0Y2ggdGhlIGFjdGl2ZSBzZXNzaW9uIG1vZGVsIG9yIG9wZW4gYSBwaWNrZXJcIiB9LFxuICB7IGNtZDogXCJtb2RlXCIsIGRlc2M6IFwiU3dpdGNoIHdvcmtmbG93IG1vZGUgKHNvbG8vdGVhbSlcIiB9LFxuICB7IGNtZDogXCJwcmVmc1wiLCBkZXNjOiBcIk1hbmFnZSBwcmVmZXJlbmNlcyAobW9kZWwgc2VsZWN0aW9uLCB0aW1lb3V0cywgZXRjLilcIiB9LFxuICB7IGNtZDogXCJjb25maWdcIiwgZGVzYzogXCIoZGVwcmVjYXRlZCkgU2V0IHRvb2wgQVBJIGtleXMgXHUyMDE0IHVzZSAvZ3NkIGtleXMgaW5zdGVhZFwiIH0sXG4gIHsgY21kOiBcImtleXNcIiwgZGVzYzogXCJBUEkga2V5IG1hbmFnZXIgXHUyMDE0IGxpc3QsIGFkZCwgcmVtb3ZlLCB0ZXN0LCByb3RhdGUsIGRvY3RvclwiIH0sXG4gIHsgY21kOiBcImhvb2tzXCIsIGRlc2M6IFwiU2hvdyBjb25maWd1cmVkIHBvc3QtdW5pdCBhbmQgcHJlLWRpc3BhdGNoIGhvb2tzXCIgfSxcbiAgeyBjbWQ6IFwicnVuLWhvb2tcIiwgZGVzYzogXCJNYW51YWxseSB0cmlnZ2VyIGEgc3BlY2lmaWMgaG9va1wiIH0sXG4gIHsgY21kOiBcInNraWxsLWhlYWx0aFwiLCBkZXNjOiBcIlNraWxsIGxpZmVjeWNsZSBkYXNoYm9hcmRcIiB9LFxuICB7IGNtZDogXCJub3RpZmljYXRpb25zXCIsIGRlc2M6IFwiVmlldywgZmlsdGVyLCBhbmQgY2xlYXIgcGVyc2lzdGVudCBub3RpZmljYXRpb24gaGlzdG9yeVwiIH0sXG4gIHsgY21kOiBcImRvY3RvclwiLCBkZXNjOiBcIlJ1bnRpbWUgaGVhbHRoIGNoZWNrcyB3aXRoIGF1dG8tZml4XCIgfSxcbiAgeyBjbWQ6IFwibG9nc1wiLCBkZXNjOiBcIkJyb3dzZSBhY3Rpdml0eSBsb2dzLCBkZWJ1ZyBsb2dzLCBhbmQgbWV0cmljc1wiIH0sXG4gIHsgY21kOiBcImRlYnVnXCIsIGRlc2M6IFwiQ3JlYXRlIGFuZCBpbnNwZWN0IHBlcnNpc3RlbnQgL2dzZCBkZWJ1ZyBzZXNzaW9uc1wiIH0sXG4gIHsgY21kOiBcImZvcmVuc2ljc1wiLCBkZXNjOiBcIkV4YW1pbmUgZXhlY3V0aW9uIGxvZ3NcIiB9LFxuICB7IGNtZDogXCJpbml0XCIsIGRlc2M6IFwiUHJvamVjdCBpbml0IHdpemFyZCBcdTIwMTQgZGV0ZWN0LCBjb25maWd1cmUsIGJvb3RzdHJhcCAuZ3NkL1wiIH0sXG4gIHsgY21kOiBcInNldHVwXCIsIGRlc2M6IFwiQ29uZmlndXJhdGlvbiBodWI6IHN0YXR1cyArIHN1Yi1yb3V0ZXMgKGxsbSwgbW9kZWwsIHNlYXJjaCwgcmVtb3RlLCBrZXlzLCBwcmVmcywgb25ib2FyZGluZylcIiB9LFxuICB7IGNtZDogXCJvbmJvYXJkaW5nXCIsIGRlc2M6IFwiUmUtcnVuIHRoZSBzZXR1cCB3aXphcmQgIFstLXJlc3VtZXwtLXJlc2V0fC0tc3RlcCA8bmFtZT5dXCIgfSxcbiAgeyBjbWQ6IFwibWlncmF0ZVwiLCBkZXNjOiBcIk1pZ3JhdGUgYSB2MSAucGxhbm5pbmcgZGlyZWN0b3J5IHRvIC5nc2QgZm9ybWF0XCIgfSxcbiAgeyBjbWQ6IFwicmVtb3RlXCIsIGRlc2M6IFwiQ29udHJvbCByZW1vdGUgYXV0by1tb2RlXCIgfSxcbiAgeyBjbWQ6IFwic3RlZXJcIiwgZGVzYzogXCJIYXJkLXN0ZWVyIHBsYW4gZG9jdW1lbnRzIGR1cmluZyBleGVjdXRpb25cIiB9LFxuICB7IGNtZDogXCJpbnNwZWN0XCIsIGRlc2M6IFwiU2hvdyBTUUxpdGUgREIgZGlhZ25vc3RpY3NcIiB9LFxuICB7IGNtZDogXCJrbm93bGVkZ2VcIiwgZGVzYzogXCJBZGQgcGVyc2lzdGVudCBwcm9qZWN0IGtub3dsZWRnZSAocnVsZSwgcGF0dGVybiwgb3IgbGVzc29uKVwiIH0sXG4gIHsgY21kOiBcIm5ldy1taWxlc3RvbmVcIiwgZGVzYzogXCJDcmVhdGUgYSBtaWxlc3RvbmUgZnJvbSBhIHNwZWNpZmljYXRpb24gZG9jdW1lbnQgKGhlYWRsZXNzKVwiIH0sXG4gIHsgY21kOiBcIm5ldy1wcm9qZWN0XCIsIGRlc2M6IFwiQm9vdHN0cmFwIGEgbmV3IHByb2plY3QgKHVzZSAtLWRlZXAgZm9yIHN0YWdlZCBwcm9qZWN0LWxldmVsIGRpc2NvdmVyeSlcIiB9LFxuICB7IGNtZDogXCJwYXJhbGxlbFwiLCBkZXNjOiBcIlBhcmFsbGVsIG1pbGVzdG9uZSBvcmNoZXN0cmF0aW9uIChzdGFydCwgc3RhdHVzLCBzdG9wLCBtZXJnZSwgd2F0Y2gpXCIgfSxcbiAgeyBjbWQ6IFwiY211eFwiLCBkZXNjOiBcIk1hbmFnZSBjbXV4IGludGVncmF0aW9uIChzdGF0dXMsIHNpZGViYXIsIG5vdGlmaWNhdGlvbnMsIHNwbGl0cylcIiB9LFxuICB7IGNtZDogXCJwYXJrXCIsIGRlc2M6IFwiUGFyayBhIG1pbGVzdG9uZSBcdTIwMTQgc2tpcCB3aXRob3V0IGRlbGV0aW5nXCIgfSxcbiAgeyBjbWQ6IFwidW5wYXJrXCIsIGRlc2M6IFwiUmVhY3RpdmF0ZSBhIHBhcmtlZCBtaWxlc3RvbmVcIiB9LFxuICB7IGNtZDogXCJ1cGRhdGVcIiwgZGVzYzogXCJVcGRhdGUgR1NEIHRvIHRoZSBsYXRlc3QgdmVyc2lvblwiIH0sXG4gIHsgY21kOiBcInN0YXJ0XCIsIGRlc2M6IFwiU3RhcnQgYSB3b3JrZmxvdyB0ZW1wbGF0ZSAoYnVnZml4LCBzcGlrZSwgZmVhdHVyZSwgZXRjLilcIiB9LFxuICB7IGNtZDogXCJ0ZW1wbGF0ZXNcIiwgZGVzYzogXCJMaXN0IGF2YWlsYWJsZSB3b3JrZmxvdyB0ZW1wbGF0ZXNcIiB9LFxuICB7IGNtZDogXCJleHRlbnNpb25zXCIsIGRlc2M6IFwiTWFuYWdlIGV4dGVuc2lvbnMgKGxpc3QsIGVuYWJsZSwgZGlzYWJsZSwgaW5mbylcIiB9LFxuICB7IGNtZDogXCJmYXN0XCIsIGRlc2M6IFwiVG9nZ2xlIE9wZW5BSSBzZXJ2aWNlIHRpZXIgKG9uL29mZi9mbGV4L3N0YXR1cylcIiB9LFxuICB7IGNtZDogXCJtY3BcIiwgZGVzYzogXCJNQ1Agc2VydmVyIHN0YXR1cywgY29ubmVjdGl2aXR5LCBhbmQgbG9jYWwgY29uZmlnIGJvb3RzdHJhcCAoc3RhdHVzLCBjaGVjaywgaW5pdClcIiB9LFxuICB7IGNtZDogXCJyZXRoaW5rXCIsIGRlc2M6IFwiQ29udmVyc2F0aW9uYWwgcHJvamVjdCByZW9yZ2FuaXphdGlvbiBcdTIwMTQgcmVvcmRlciwgcGFyaywgZGlzY2FyZCwgYWRkIG1pbGVzdG9uZXNcIiB9LFxuICB7IGNtZDogXCJ3b3JrZmxvd1wiLCBkZXNjOiBcIkN1c3RvbSB3b3JrZmxvdyBsaWZlY3ljbGUgKG5ldywgcnVuLCBsaXN0LCBpbmZvLCBpbnN0YWxsLCB1bmluc3RhbGwsIHZhbGlkYXRlLCBwYXVzZSwgcmVzdW1lKSBvciBydW4gPG5hbWU+IGRpcmVjdGx5XCIgfSxcbiAgeyBjbWQ6IFwiY29kZWJhc2VcIiwgZGVzYzogXCJHZW5lcmF0ZSwgcmVmcmVzaCwgYW5kIGluc3BlY3QgdGhlIGNvZGViYXNlIG1hcCBjYWNoZSAoLmdzZC9DT0RFQkFTRS5tZClcIiB9LFxuICB7IGNtZDogXCJzaGlwXCIsIGRlc2M6IFwiQ3JlYXRlIFBSIGZyb20gbWlsZXN0b25lIGFydGlmYWN0cyBhbmQgb3BlbiBmb3IgcmV2aWV3XCIgfSxcbiAgeyBjbWQ6IFwiZG9cIiwgZGVzYzogXCJSb3V0ZSBmcmVlZm9ybSB0ZXh0IHRvIHRoZSByaWdodCBHU0QgY29tbWFuZFwiIH0sXG4gIHsgY21kOiBcInNlc3Npb24tcmVwb3J0XCIsIGRlc2M6IFwiU2Vzc2lvbiBjb3N0LCB0b2tlbnMsIGFuZCB3b3JrIHN1bW1hcnlcIiB9LFxuICB7IGNtZDogXCJiYWNrbG9nXCIsIGRlc2M6IFwiTWFuYWdlIGJhY2tsb2cgaXRlbXMgKGFkZCwgcHJvbW90ZSwgcmVtb3ZlLCBsaXN0KVwiIH0sXG4gIHsgY21kOiBcInByLWJyYW5jaFwiLCBkZXNjOiBcIkNyZWF0ZSBjbGVhbiBQUiBicmFuY2ggZmlsdGVyaW5nIC5nc2QvIGNvbW1pdHNcIiB9LFxuICB7IGNtZDogXCJhZGQtdGVzdHNcIiwgZGVzYzogXCJHZW5lcmF0ZSB0ZXN0cyBmb3IgY29tcGxldGVkIHNsaWNlc1wiIH0sXG4gIHsgY21kOiBcInNjYW5cIiwgZGVzYzogXCJSYXBpZCBjb2RlYmFzZSBhc3Nlc3NtZW50IFx1MjAxNCBsaWdodHdlaWdodCBhbHRlcm5hdGl2ZSB0byBmdWxsIG1hcCAoLS1mb2N1cyB0ZWNofGFyY2h8cXVhbGl0eXxjb25jZXJuc3x0ZWNoK2FyY2gpXCIgfSxcbiAgeyBjbWQ6IFwibGFuZ3VhZ2VcIiwgZGVzYzogXCJTZXQgb3IgY2xlYXIgdGhlIGdsb2JhbCByZXNwb25zZSBsYW5ndWFnZSAoZS5nLiAvZ3NkIGxhbmd1YWdlIENoaW5lc2UpXCIgfSxcbiAgeyBjbWQ6IFwid29ya3RyZWVcIiwgZGVzYzogXCJNYW5hZ2Ugd29ya3RyZWVzIGZyb20gdGhlIFRVSSAobGlzdCwgbWVyZ2UsIGNsZWFuLCByZW1vdmUpXCIgfSxcbiAgeyBjbWQ6IFwiZXZhbC1yZXZpZXdcIiwgZGVzYzogXCJBdWRpdCBhIHNsaWNlJ3MgQUkgZXZhbHVhdGlvbiBzdHJhdGVneSBhbmQgd3JpdGUgYSBzY29yZWQgRVZBTC1SRVZJRVcubWQgKC0tZm9yY2UsIC0tc2hvdylcIiB9LFxuXTtcblxuY29uc3QgTkVTVEVEX0NPTVBMRVRJT05TOiBDb21wbGV0aW9uTWFwID0ge1xuICBicmllZjogVklTVUFMX0JSSUVGX01PREVTLm1hcCgobW9kZSkgPT4gKHsgY21kOiBtb2RlLm1vZGUsIGRlc2M6IG1vZGUuZGVzY3JpcHRpb24gfSkpLFxuICBhdXRvOiBbXG4gICAgeyBjbWQ6IFwiLS12ZXJib3NlXCIsIGRlc2M6IFwiU2hvdyBkZXRhaWxlZCBleGVjdXRpb24gb3V0cHV0XCIgfSxcbiAgICB7IGNtZDogXCItLWRlYnVnXCIsIGRlc2M6IFwiRW5hYmxlIGRlYnVnIGxvZ2dpbmdcIiB9LFxuICBdLFxuICBuZXh0OiBbXG4gICAgeyBjbWQ6IFwiLS12ZXJib3NlXCIsIGRlc2M6IFwiU2hvdyBkZXRhaWxlZCBzdGVwIG91dHB1dFwiIH0sXG4gICAgeyBjbWQ6IFwiLS1kcnktcnVuXCIsIGRlc2M6IFwiUHJldmlldyBuZXh0IHN0ZXAgd2l0aG91dCBleGVjdXRpbmdcIiB9LFxuICAgIHsgY21kOiBcIi0tZGVidWdcIiwgZGVzYzogXCJFbmFibGUgZGVidWcgbG9nZ2luZ1wiIH0sXG4gIF0sXG4gIHdpZGdldDogW1xuICAgIHsgY21kOiBcImZ1bGxcIiwgZGVzYzogXCJGdWxsIHdpZGdldCBkaXNwbGF5XCIgfSxcbiAgICB7IGNtZDogXCJzbWFsbFwiLCBkZXNjOiBcIkNvbXBhY3Qgd2lkZ2V0IGRpc3BsYXlcIiB9LFxuICAgIHsgY21kOiBcIm1pblwiLCBkZXNjOiBcIk1pbmltYWwgd2lkZ2V0IGRpc3BsYXlcIiB9LFxuICAgIHsgY21kOiBcIm9mZlwiLCBkZXNjOiBcIkhpZGUgd2lkZ2V0XCIgfSxcbiAgXSxcbiAgbW9kZTogW1xuICAgIHsgY21kOiBcImdsb2JhbFwiLCBkZXNjOiBcIkVkaXQgZ2xvYmFsIHdvcmtmbG93IG1vZGVcIiB9LFxuICAgIHsgY21kOiBcInByb2plY3RcIiwgZGVzYzogXCJFZGl0IHByb2plY3Qtc3BlY2lmaWMgd29ya2Zsb3cgbW9kZVwiIH0sXG4gIF0sXG4gIHBhcmFsbGVsOiBbXG4gICAgeyBjbWQ6IFwic3RhcnRcIiwgZGVzYzogXCJTdGFydCBwYXJhbGxlbCBtaWxlc3RvbmUgb3JjaGVzdHJhdGlvblwiIH0sXG4gICAgeyBjbWQ6IFwic3RhdHVzXCIsIGRlc2M6IFwiU2hvdyBwYXJhbGxlbCB3b3JrZXIgc3RhdHVzZXNcIiB9LFxuICAgIHsgY21kOiBcInN0b3BcIiwgZGVzYzogXCJTdG9wIGFsbCBwYXJhbGxlbCB3b3JrZXJzXCIgfSxcbiAgICB7IGNtZDogXCJwYXVzZVwiLCBkZXNjOiBcIlBhdXNlIGEgc3BlY2lmaWMgd29ya2VyXCIgfSxcbiAgICB7IGNtZDogXCJyZXN1bWVcIiwgZGVzYzogXCJSZXN1bWUgYSBwYXVzZWQgd29ya2VyXCIgfSxcbiAgICB7IGNtZDogXCJtZXJnZVwiLCBkZXNjOiBcIk1lcmdlIGNvbXBsZXRlZCBtaWxlc3RvbmUgYnJhbmNoZXNcIiB9LFxuICAgIHsgY21kOiBcIndhdGNoXCIsIGRlc2M6IFwiTGl2ZSBUVUkgZGFzaGJvYXJkIG1vbml0b3JpbmcgYWxsIHdvcmtlcnNcIiB9LFxuICBdLFxuICBzZXR1cDogW1xuICAgIHsgY21kOiBcImxsbVwiLCBkZXNjOiBcIkNvbmZpZ3VyZSBMTE0gcHJvdmlkZXIgJiBhdXRoXCIgfSxcbiAgICB7IGNtZDogXCJtb2RlbFwiLCBkZXNjOiBcIlBpY2sgZGVmYXVsdCBtb2RlbCBmb3IgdGhlIGFjdGl2ZSBwcm92aWRlclwiIH0sXG4gICAgeyBjbWQ6IFwic2VhcmNoXCIsIGRlc2M6IFwiQ29uZmlndXJlIHdlYiBzZWFyY2ggcHJvdmlkZXJcIiB9LFxuICAgIHsgY21kOiBcInJlbW90ZVwiLCBkZXNjOiBcIkNvbmZpZ3VyZSByZW1vdGUgaW50ZWdyYXRpb25zIChEaXNjb3JkL1NsYWNrL1RlbGVncmFtKVwiIH0sXG4gICAgeyBjbWQ6IFwia2V5c1wiLCBkZXNjOiBcIk1hbmFnZSBBUEkga2V5cyAoYWxpYXMgZm9yIC9nc2Qga2V5cylcIiB9LFxuICAgIHsgY21kOiBcInByZWZzXCIsIGRlc2M6IFwiR2xvYmFsIHByZWZlcmVuY2VzIHdpemFyZCAoYWxpYXMgZm9yIC9nc2QgcHJlZnMpXCIgfSxcbiAgICB7IGNtZDogXCJvbmJvYXJkaW5nXCIsIGRlc2M6IFwiUnVuIHRoZSBmdWxsIG9uYm9hcmRpbmcgd2l6YXJkIChhbGlhcyBmb3IgL2dzZCBvbmJvYXJkaW5nKVwiIH0sXG4gIF0sXG4gIG9uYm9hcmRpbmc6IFtcbiAgICB7IGNtZDogXCItLXJlc3VtZVwiLCBkZXNjOiBcIlJlc3VtZSBmcm9tIHRoZSBsYXN0IGNvbXBsZXRlZCBzdGVwXCIgfSxcbiAgICB7IGNtZDogXCItLXJlc2V0XCIsIGRlc2M6IFwiUmVzZXQgb25ib2FyZGluZyBzdGF0ZSBhbmQgc3RhcnQgb3ZlciAoZG9lcyBub3QgY2xlYXIgQVBJIGtleXMpXCIgfSxcbiAgICB7IGNtZDogXCItLXN0ZXBcIiwgZGVzYzogXCJSdW4gYSBzaW5nbGUgc3RlcDogbGxtfG1vZGVsfHNlYXJjaHxyZW1vdGV8dG9vbC1rZXlzfHByZWZzfHNraWxsc3xkb2N0b3J8cHJvamVjdFwiIH0sXG4gIF0sXG4gIG5vdGlmaWNhdGlvbnM6IFtcbiAgICB7IGNtZDogXCJjbGVhclwiLCBkZXNjOiBcIkNsZWFyIGFsbCBub3RpZmljYXRpb25zXCIgfSxcbiAgICB7IGNtZDogXCJ0YWlsXCIsIGRlc2M6IFwiU2hvdyBsYXN0IE4gbm90aWZpY2F0aW9ucyAoZGVmYXVsdDogMjApXCIgfSxcbiAgICB7IGNtZDogXCJmaWx0ZXJcIiwgZGVzYzogXCJGaWx0ZXIgYnkgc2V2ZXJpdHkgKGVycm9yfHdhcm5pbmd8aW5mb3xzdWNjZXNzKVwiIH0sXG4gIF0sXG4gIGxvZ3M6IFtcbiAgICB7IGNtZDogXCJkZWJ1Z1wiLCBkZXNjOiBcIkxpc3Qgb3IgdmlldyBkZWJ1ZyBsb2cgZmlsZXNcIiB9LFxuICAgIHsgY21kOiBcInRhaWxcIiwgZGVzYzogXCJTaG93IGxhc3QgTiBhY3Rpdml0eSBsb2cgc3VtbWFyaWVzXCIgfSxcbiAgICB7IGNtZDogXCJjbGVhclwiLCBkZXNjOiBcIlJlbW92ZSBvbGQgYWN0aXZpdHkgYW5kIGRlYnVnIGxvZ3NcIiB9LFxuICBdLFxuICBkZWJ1ZzogW1xuICAgIHsgY21kOiBcImxpc3RcIiwgZGVzYzogXCJMaXN0IHBlcnNpc3RlZCBkZWJ1ZyBzZXNzaW9uc1wiIH0sXG4gICAgeyBjbWQ6IFwic3RhdHVzXCIsIGRlc2M6IFwiU2hvdyBzdGF0dXMgZm9yIG9uZSBkZWJ1ZyBzZXNzaW9uIHNsdWdcIiB9LFxuICAgIHsgY21kOiBcImNvbnRpbnVlXCIsIGRlc2M6IFwiUmVzdW1lIGFuIGV4aXN0aW5nIGRlYnVnIHNlc3Npb24gc2x1Z1wiIH0sXG4gICAgeyBjbWQ6IFwiLS1kaWFnbm9zZVwiLCBkZXNjOiBcIkluc3BlY3QgbWFsZm9ybWVkIGFydGlmYWN0cyBhbmQgc2Vzc2lvbiBoZWFsdGhcIiB9LFxuICBdLFxuICBrZXlzOiBbXG4gICAgeyBjbWQ6IFwibGlzdFwiLCBkZXNjOiBcIlNob3cga2V5IHN0YXR1cyBkYXNoYm9hcmRcIiB9LFxuICAgIHsgY21kOiBcImFkZFwiLCBkZXNjOiBcIkFkZCBhIGtleSBmb3IgYSBwcm92aWRlclwiIH0sXG4gICAgeyBjbWQ6IFwicmVtb3ZlXCIsIGRlc2M6IFwiUmVtb3ZlIGEga2V5XCIgfSxcbiAgICB7IGNtZDogXCJ0ZXN0XCIsIGRlc2M6IFwiVmFsaWRhdGUga2V5KHMpIHdpdGggQVBJIGNhbGxcIiB9LFxuICAgIHsgY21kOiBcInJvdGF0ZVwiLCBkZXNjOiBcIlJlcGxhY2UgYW4gZXhpc3Rpbmcga2V5XCIgfSxcbiAgICB7IGNtZDogXCJkb2N0b3JcIiwgZGVzYzogXCJIZWFsdGggY2hlY2sgYWxsIGtleXNcIiB9LFxuICBdLFxuICBwcmVmczogW1xuICAgIHsgY21kOiBcImdsb2JhbFwiLCBkZXNjOiBcIkVkaXQgZ2xvYmFsIHByZWZlcmVuY2VzIGZpbGVcIiB9LFxuICAgIHsgY21kOiBcInByb2plY3RcIiwgZGVzYzogXCJFZGl0IHByb2plY3QgcHJlZmVyZW5jZXMgZmlsZVwiIH0sXG4gICAgeyBjbWQ6IFwic3RhdHVzXCIsIGRlc2M6IFwiU2hvdyBlZmZlY3RpdmUgcHJlZmVyZW5jZXNcIiB9LFxuICAgIHsgY21kOiBcIndpemFyZFwiLCBkZXNjOiBcIkludGVyYWN0aXZlIHByZWZlcmVuY2VzIHdpemFyZFwiIH0sXG4gICAgeyBjbWQ6IFwic2V0dXBcIiwgZGVzYzogXCJGaXJzdC10aW1lIHByZWZlcmVuY2VzIHNldHVwXCIgfSxcbiAgICB7IGNtZDogXCJpbXBvcnQtY2xhdWRlXCIsIGRlc2M6IFwiSW1wb3J0IHNldHRpbmdzIGZyb20gQ2xhdWRlIENvZGVcIiB9LFxuICBdLFxuICByZW1vdGU6IFtcbiAgICB7IGNtZDogXCJzbGFja1wiLCBkZXNjOiBcIkNvbmZpZ3VyZSBTbGFjayBpbnRlZ3JhdGlvblwiIH0sXG4gICAgeyBjbWQ6IFwiZGlzY29yZFwiLCBkZXNjOiBcIkNvbmZpZ3VyZSBEaXNjb3JkIGludGVncmF0aW9uXCIgfSxcbiAgICB7IGNtZDogXCJzdGF0dXNcIiwgZGVzYzogXCJTaG93IHJlbW90ZSBjb25uZWN0aW9uIHN0YXR1c1wiIH0sXG4gICAgeyBjbWQ6IFwiZGlzY29ubmVjdFwiLCBkZXNjOiBcIkRpc2Nvbm5lY3QgcmVtb3RlIGludGVncmF0aW9uc1wiIH0sXG4gIF0sXG4gIGhpc3Rvcnk6IFtcbiAgICB7IGNtZDogXCItLWNvc3RcIiwgZGVzYzogXCJTaG93IGNvc3QgYnJlYWtkb3duIHBlciBlbnRyeVwiIH0sXG4gICAgeyBjbWQ6IFwiLS1waGFzZVwiLCBkZXNjOiBcIkZpbHRlciBieSBwaGFzZSB0eXBlXCIgfSxcbiAgICB7IGNtZDogXCItLW1vZGVsXCIsIGRlc2M6IFwiRmlsdGVyIGJ5IG1vZGVsIHVzZWRcIiB9LFxuICAgIHsgY21kOiBcIjEwXCIsIGRlc2M6IFwiU2hvdyBsYXN0IDEwIGVudHJpZXNcIiB9LFxuICAgIHsgY21kOiBcIjIwXCIsIGRlc2M6IFwiU2hvdyBsYXN0IDIwIGVudHJpZXNcIiB9LFxuICAgIHsgY21kOiBcIjUwXCIsIGRlc2M6IFwiU2hvdyBsYXN0IDUwIGVudHJpZXNcIiB9LFxuICBdLFxuICBleHBvcnQ6IFtcbiAgICB7IGNtZDogXCItLWpzb25cIiwgZGVzYzogXCJFeHBvcnQgYXMgSlNPTlwiIH0sXG4gICAgeyBjbWQ6IFwiLS1tYXJrZG93blwiLCBkZXNjOiBcIkV4cG9ydCBhcyBNYXJrZG93blwiIH0sXG4gICAgeyBjbWQ6IFwiLS1odG1sXCIsIGRlc2M6IFwiRXhwb3J0IGFzIEhUTUxcIiB9LFxuICAgIHsgY21kOiBcIi0taHRtbCAtLWFsbFwiLCBkZXNjOiBcIkV4cG9ydCBhbGwgbWlsZXN0b25lcyBhcyBIVE1MXCIgfSxcbiAgXSxcbiAgY2xlYW51cDogW1xuICAgIHsgY21kOiBcImJyYW5jaGVzXCIsIGRlc2M6IFwiUmVtb3ZlIG1lcmdlZCBtaWxlc3RvbmUgYW5kIGxlZ2FjeSBicmFuY2hlc1wiIH0sXG4gICAgeyBjbWQ6IFwic25hcHNob3RzXCIsIGRlc2M6IFwiUmVtb3ZlIG9sZCBleGVjdXRpb24gc25hcHNob3RzXCIgfSxcbiAgICB7IGNtZDogXCJ3b3JrdHJlZXNcIiwgZGVzYzogXCJSZW1vdmUgbWVyZ2VkL3NhZmUtdG8tZGVsZXRlIHdvcmt0cmVlc1wiIH0sXG4gICAgeyBjbWQ6IFwicHJvamVjdHNcIiwgZGVzYzogXCJBdWRpdCBvcnBoYW5lZCB+Ly5nc2QvcHJvamVjdHMvIHN0YXRlIGRpcmVjdG9yaWVzXCIgfSxcbiAgICB7IGNtZDogXCJwcm9qZWN0cyAtLWZpeFwiLCBkZXNjOiBcIkRlbGV0ZSBvcnBoYW5lZCBwcm9qZWN0IHN0YXRlIGRpcmVjdG9yaWVzIChjYW5ub3QgYmUgdW5kb25lKVwiIH0sXG4gIF0sXG4gIGtub3dsZWRnZTogW1xuICAgIHsgY21kOiBcInJ1bGVcIiwgZGVzYzogXCJBZGQgYSBwcm9qZWN0IHJ1bGUgKGFsd2F5cy9uZXZlciBkbyBYKVwiIH0sXG4gICAgeyBjbWQ6IFwicGF0dGVyblwiLCBkZXNjOiBcIkFkZCBhIGNvZGUgcGF0dGVybiB0byBmb2xsb3dcIiB9LFxuICAgIHsgY21kOiBcImxlc3NvblwiLCBkZXNjOiBcIlJlY29yZCBhIGxlc3NvbiBsZWFybmVkXCIgfSxcbiAgXSxcbiAgc3RhcnQ6IFtcbiAgICB7IGNtZDogXCJidWdmaXhcIiwgZGVzYzogXCJUcmlhZ2UsIGZpeCwgdGVzdCwgYW5kIHNoaXAgYSBidWcgZml4XCIgfSxcbiAgICB7IGNtZDogXCJzbWFsbC1mZWF0dXJlXCIsIGRlc2M6IFwiTGlnaHR3ZWlnaHQgZmVhdHVyZSB3aXRoIG9wdGlvbmFsIGRpc2N1c3Npb25cIiB9LFxuICAgIHsgY21kOiBcInNwaWtlXCIsIGRlc2M6IFwiUmVzZWFyY2gsIHByb3RvdHlwZSwgYW5kIGRvY3VtZW50IGZpbmRpbmdzXCIgfSxcbiAgICB7IGNtZDogXCJob3RmaXhcIiwgZGVzYzogXCJNaW5pbWFsOiBmaXggaXQsIHRlc3QgaXQsIHNoaXAgaXRcIiB9LFxuICAgIHsgY21kOiBcInJlZmFjdG9yXCIsIGRlc2M6IFwiSW52ZW50b3J5LCBwbGFuIHdhdmVzLCBtaWdyYXRlLCB2ZXJpZnlcIiB9LFxuICAgIHsgY21kOiBcInNlY3VyaXR5LWF1ZGl0XCIsIGRlc2M6IFwiU2NhbiwgdHJpYWdlLCByZW1lZGlhdGUsIHJlLXNjYW5cIiB9LFxuICAgIHsgY21kOiBcImRlcC11cGdyYWRlXCIsIGRlc2M6IFwiQXNzZXNzLCB1cGdyYWRlLCBmaXggYnJlYWtzLCB2ZXJpZnlcIiB9LFxuICAgIHsgY21kOiBcImZ1bGwtcHJvamVjdFwiLCBkZXNjOiBcIkNvbXBsZXRlIEdTRCB3b3JrZmxvdyB3aXRoIGZ1bGwgY2VyZW1vbnlcIiB9LFxuICAgIHsgY21kOiBcInJlc3VtZVwiLCBkZXNjOiBcIlJlc3VtZSBhbiBpbi1wcm9ncmVzcyB3b3JrZmxvd1wiIH0sXG4gICAgeyBjbWQ6IFwiLS1saXN0XCIsIGRlc2M6IFwiTGlzdCBhbGwgYXZhaWxhYmxlIHRlbXBsYXRlc1wiIH0sXG4gICAgeyBjbWQ6IFwiLS1kcnktcnVuXCIsIGRlc2M6IFwiUHJldmlldyB3b3JrZmxvdyB3aXRob3V0IGV4ZWN1dGluZ1wiIH0sXG4gIF0sXG4gIHRlbXBsYXRlczogW1xuICAgIHsgY21kOiBcImluZm9cIiwgZGVzYzogXCJTaG93IGRldGFpbGVkIHRlbXBsYXRlIGluZm9cIiB9LFxuICBdLFxuICBleHRlbnNpb25zOiBbXG4gICAgeyBjbWQ6IFwibGlzdFwiLCBkZXNjOiBcIkxpc3QgYWxsIGV4dGVuc2lvbnMgYW5kIHRoZWlyIHN0YXR1c1wiIH0sXG4gICAgeyBjbWQ6IFwiZW5hYmxlXCIsIGRlc2M6IFwiRW5hYmxlIGEgZGlzYWJsZWQgZXh0ZW5zaW9uXCIgfSxcbiAgICB7IGNtZDogXCJkaXNhYmxlXCIsIGRlc2M6IFwiRGlzYWJsZSBhbiBleHRlbnNpb25cIiB9LFxuICAgIHsgY21kOiBcImluZm9cIiwgZGVzYzogXCJTaG93IGV4dGVuc2lvbiBkZXRhaWxzXCIgfSxcbiAgXSxcbiAgZmFzdDogW1xuICAgIHsgY21kOiBcIm9uXCIsIGRlc2M6IFwiUHJpb3JpdHkgdGllciAoMnggY29zdCwgZmFzdGVyKVwiIH0sXG4gICAgeyBjbWQ6IFwib2ZmXCIsIGRlc2M6IFwiRGlzYWJsZSBzZXJ2aWNlIHRpZXJcIiB9LFxuICAgIHsgY21kOiBcImZsZXhcIiwgZGVzYzogXCJGbGV4IHRpZXIgKDAuNXggY29zdCwgc2xvd2VyKVwiIH0sXG4gICAgeyBjbWQ6IFwic3RhdHVzXCIsIGRlc2M6IFwiU2hvdyBjdXJyZW50IHNlcnZpY2UgdGllciBzZXR0aW5nXCIgfSxcbiAgXSxcbiAgbWNwOiBbXG4gICAgeyBjbWQ6IFwic3RhdHVzXCIsIGRlc2M6IFwiU2hvdyBhbGwgTUNQIHNlcnZlciBzdGF0dXNlcyAoZGVmYXVsdClcIiB9LFxuICAgIHsgY21kOiBcImNoZWNrXCIsIGRlc2M6IFwiRGV0YWlsZWQgc3RhdHVzIGZvciBhIHNwZWNpZmljIHNlcnZlclwiIH0sXG4gICAgeyBjbWQ6IFwiaW5pdFwiLCBkZXNjOiBcIldyaXRlIC5tY3AuanNvbiBmb3IgdGhlIGxvY2FsIEdTRCB3b3JrZmxvdyBNQ1Agc2VydmVyXCIgfSxcbiAgXSxcbiAgZG9jdG9yOiBbXG4gICAgeyBjbWQ6IFwiZml4XCIsIGRlc2M6IFwiQXV0by1maXggZGV0ZWN0ZWQgaXNzdWVzXCIgfSxcbiAgICB7IGNtZDogXCJoZWFsXCIsIGRlc2M6IFwiQUktZHJpdmVuIGRlZXAgaGVhbGluZ1wiIH0sXG4gICAgeyBjbWQ6IFwiYXVkaXRcIiwgZGVzYzogXCJSdW4gaGVhbHRoIGF1ZGl0IHdpdGhvdXQgZml4aW5nXCIgfSxcbiAgICB7IGNtZDogXCItLWRyeS1ydW5cIiwgZGVzYzogXCJTaG93IHdoYXQgLS1maXggd291bGQgY2hhbmdlIHdpdGhvdXQgYXBwbHlpbmdcIiB9LFxuICAgIHsgY21kOiBcIi0tanNvblwiLCBkZXNjOiBcIk91dHB1dCByZXBvcnQgYXMgSlNPTiAoQ0kvdG9vbGluZyBmcmllbmRseSlcIiB9LFxuICAgIHsgY21kOiBcIi0tYnVpbGRcIiwgZGVzYzogXCJJbmNsdWRlIHNsb3cgYnVpbGQgaGVhbHRoIGNoZWNrIChucG0gcnVuIGJ1aWxkKVwiIH0sXG4gICAgeyBjbWQ6IFwiLS10ZXN0XCIsIGRlc2M6IFwiSW5jbHVkZSBzbG93IHRlc3QgaGVhbHRoIGNoZWNrIChucG0gdGVzdClcIiB9LFxuICBdLFxuICBkaXNwYXRjaDogW1xuICAgIHsgY21kOiBcInJlc2VhcmNoXCIsIGRlc2M6IFwiUnVuIHJlc2VhcmNoIHBoYXNlXCIgfSxcbiAgICB7IGNtZDogXCJwbGFuXCIsIGRlc2M6IFwiUnVuIHBsYW5uaW5nIHBoYXNlXCIgfSxcbiAgICB7IGNtZDogXCJleGVjdXRlXCIsIGRlc2M6IFwiUnVuIGV4ZWN1dGlvbiBwaGFzZVwiIH0sXG4gICAgeyBjbWQ6IFwiY29tcGxldGVcIiwgZGVzYzogXCJSdW4gY29tcGxldGlvbiBwaGFzZVwiIH0sXG4gICAgeyBjbWQ6IFwicmVhc3Nlc3NcIiwgZGVzYzogXCJSZWFzc2VzcyBjdXJyZW50IHByb2dyZXNzXCIgfSxcbiAgICB7IGNtZDogXCJ1YXRcIiwgZGVzYzogXCJSdW4gdXNlciBhY2NlcHRhbmNlIHRlc3RpbmdcIiB9LFxuICAgIHsgY21kOiBcInJlcGxhblwiLCBkZXNjOiBcIlJlcGxhbiB0aGUgY3VycmVudCBzbGljZVwiIH0sXG4gIF0sXG4gIHJhdGU6IFtcbiAgICB7IGNtZDogXCJvdmVyXCIsIGRlc2M6IFwiTW9kZWwgd2FzIG92ZXJxdWFsaWZpZWQgZm9yIHRoaXMgdGFza1wiIH0sXG4gICAgeyBjbWQ6IFwib2tcIiwgZGVzYzogXCJNb2RlbCB3YXMgYXBwcm9wcmlhdGUgZm9yIHRoaXMgdGFza1wiIH0sXG4gICAgeyBjbWQ6IFwidW5kZXJcIiwgZGVzYzogXCJNb2RlbCB3YXMgdW5kZXJxdWFsaWZpZWQgZm9yIHRoaXMgdGFza1wiIH0sXG4gIF0sXG4gIHdvcmtmbG93OiBbXG4gICAgeyBjbWQ6IFwibmV3XCIsIGRlc2M6IFwiQ3JlYXRlIGEgbmV3IHdvcmtmbG93IGRlZmluaXRpb24gKHZpYSBza2lsbClcIiB9LFxuICAgIHsgY21kOiBcInJ1blwiLCBkZXNjOiBcIkNyZWF0ZSBhIFlBTUwgcnVuIGFuZCBzdGFydCBhdXRvLW1vZGVcIiB9LFxuICAgIHsgY21kOiBcImxpc3RcIiwgZGVzYzogXCJMaXN0IHdvcmtmbG93IHJ1bnNcIiB9LFxuICAgIHsgY21kOiBcImluZm9cIiwgZGVzYzogXCJTaG93IHBsdWdpbiBkZXRhaWxzIChzb3VyY2UsIG1vZGUsIHBoYXNlcylcIiB9LFxuICAgIHsgY21kOiBcImluc3RhbGxcIiwgZGVzYzogXCJJbnN0YWxsIGEgcGx1Z2luIGZyb20gYSBVUkwgLyBnaXN0OiAvIGdoOlwiIH0sXG4gICAgeyBjbWQ6IFwidW5pbnN0YWxsXCIsIGRlc2M6IFwiUmVtb3ZlIGFuIGluc3RhbGxlZCBwbHVnaW5cIiB9LFxuICAgIHsgY21kOiBcInZhbGlkYXRlXCIsIGRlc2M6IFwiVmFsaWRhdGUgYSB3b3JrZmxvdyBkZWZpbml0aW9uIFlBTUxcIiB9LFxuICAgIHsgY21kOiBcInBhdXNlXCIsIGRlc2M6IFwiUGF1c2UgY3VzdG9tIHdvcmtmbG93IGF1dG8tbW9kZVwiIH0sXG4gICAgeyBjbWQ6IFwicmVzdW1lXCIsIGRlc2M6IFwiUmVzdW1lIHBhdXNlZCBjdXN0b20gd29ya2Zsb3cgYXV0by1tb2RlXCIgfSxcbiAgXSxcbiAgY29kZWJhc2U6IFtcbiAgICB7IGNtZDogXCJnZW5lcmF0ZVwiLCBkZXNjOiBcIkdlbmVyYXRlIG9yIHJlZ2VuZXJhdGUgQ09ERUJBU0UubWRcIiB9LFxuICAgIHsgY21kOiBcImdlbmVyYXRlIC0tbWF4LWZpbGVzXCIsIGRlc2M6IFwiR2VuZXJhdGUgd2l0aCBjdXN0b20gZmlsZSBsaW1pdCAoZGVmYXVsdDogNTAwKVwiIH0sXG4gICAgeyBjbWQ6IFwiZ2VuZXJhdGUgLS1jb2xsYXBzZS10aHJlc2hvbGRcIiwgZGVzYzogXCJHZW5lcmF0ZSB3aXRoIGN1c3RvbSBjb2xsYXBzZSB0aHJlc2hvbGQgKGRlZmF1bHQ6IDIwKVwiIH0sXG4gICAgeyBjbWQ6IFwidXBkYXRlXCIsIGRlc2M6IFwiUmVmcmVzaCB0aGUgQ09ERUJBU0UubWQgY2FjaGUgaW1tZWRpYXRlbHkgKHByZXNlcnZlcyBkZXNjcmlwdGlvbnMpXCIgfSxcbiAgICB7IGNtZDogXCJ1cGRhdGUgLS1tYXgtZmlsZXNcIiwgZGVzYzogXCJVcGRhdGUgd2l0aCBjdXN0b20gZmlsZSBsaW1pdFwiIH0sXG4gICAgeyBjbWQ6IFwidXBkYXRlIC0tY29sbGFwc2UtdGhyZXNob2xkXCIsIGRlc2M6IFwiVXBkYXRlIHdpdGggY3VzdG9tIGNvbGxhcHNlIHRocmVzaG9sZFwiIH0sXG4gICAgeyBjbWQ6IFwic3RhdHNcIiwgZGVzYzogXCJTaG93IGZpbGUgY291bnQsIGRlc2NyaXB0aW9uIGNvdmVyYWdlLCBhbmQgZ2VuZXJhdGlvbiB0aW1lXCIgfSxcbiAgICB7IGNtZDogXCJoZWxwXCIsIGRlc2M6IFwiU2hvdyB1c2FnZSBhbmQgYXZhaWxhYmxlIHN1YmNvbW1hbmRzXCIgfSxcbiAgXSxcbiAgc2hpcDogW1xuICAgIHsgY21kOiBcIi0tZHJ5LXJ1blwiLCBkZXNjOiBcIlByZXZpZXcgUFIgd2l0aG91dCBjcmVhdGluZ1wiIH0sXG4gICAgeyBjbWQ6IFwiLS1kcmFmdFwiLCBkZXNjOiBcIk9wZW4gYXMgZHJhZnQgUFJcIiB9LFxuICAgIHsgY21kOiBcIi0tYmFzZVwiLCBkZXNjOiBcIk92ZXJyaWRlIHRhcmdldCBicmFuY2ggKGRlZmF1bHQ6IG1haW4pXCIgfSxcbiAgICB7IGNtZDogXCItLWZvcmNlXCIsIGRlc2M6IFwiU2hpcCBldmVuIHdpdGggcGVuZGluZyB0YXNrc1wiIH0sXG4gIF0sXG4gIFwic2Vzc2lvbi1yZXBvcnRcIjogW1xuICAgIHsgY21kOiBcIi0tanNvblwiLCBkZXNjOiBcIk1hY2hpbmUtcmVhZGFibGUgSlNPTiBvdXRwdXRcIiB9LFxuICAgIHsgY21kOiBcIi0tc2F2ZVwiLCBkZXNjOiBcIlNhdmUgcmVwb3J0IHRvIC5nc2QvcmVwb3J0cy9cIiB9LFxuICBdLFxuICBiYWNrbG9nOiBbXG4gICAgeyBjbWQ6IFwiYWRkXCIsIGRlc2M6IFwiQWRkIGl0ZW0gdG8gYmFja2xvZ1wiIH0sXG4gICAgeyBjbWQ6IFwicHJvbW90ZVwiLCBkZXNjOiBcIlByb21vdGUgYmFja2xvZyBpdGVtIHRvIGFjdGl2ZSBzbGljZVwiIH0sXG4gICAgeyBjbWQ6IFwicmVtb3ZlXCIsIGRlc2M6IFwiUmVtb3ZlIGJhY2tsb2cgaXRlbVwiIH0sXG4gIF0sXG4gIFwicHItYnJhbmNoXCI6IFtcbiAgICB7IGNtZDogXCItLWRyeS1ydW5cIiwgZGVzYzogXCJQcmV2aWV3IHdoYXQgd291bGQgYmUgZmlsdGVyZWRcIiB9LFxuICAgIHsgY21kOiBcIi0tbmFtZVwiLCBkZXNjOiBcIkN1c3RvbSBicmFuY2ggbmFtZVwiIH0sXG4gIF0sXG4gIHNjYW46IFtcbiAgICB7IGNtZDogXCItLWZvY3VzIHRlY2hcIiwgZGVzYzogXCJUZWNobm9sb2d5IHN0YWNrIGFuZCBleHRlcm5hbCBpbnRlZ3JhdGlvbnNcIiB9LFxuICAgIHsgY21kOiBcIi0tZm9jdXMgYXJjaFwiLCBkZXNjOiBcIkFyY2hpdGVjdHVyZSBwYXR0ZXJucyBhbmQgZGlyZWN0b3J5IHN0cnVjdHVyZVwiIH0sXG4gICAgeyBjbWQ6IFwiLS1mb2N1cyBxdWFsaXR5XCIsIGRlc2M6IFwiQ29kaW5nIGNvbnZlbnRpb25zIGFuZCB0ZXN0aW5nIHBhdHRlcm5zXCIgfSxcbiAgICB7IGNtZDogXCItLWZvY3VzIGNvbmNlcm5zXCIsIGRlc2M6IFwiVGVjaG5pY2FsIGRlYnQgYW5kIHJpc2sgYXJlYXNcIiB9LFxuICAgIHsgY21kOiBcIi0tZm9jdXMgdGVjaCthcmNoXCIsIGRlc2M6IFwiVGVjaCArIEFyY2hpdGVjdHVyZSAoZGVmYXVsdClcIiB9LFxuICBdLFxuICBsYW5ndWFnZTogW1xuICAgIHsgY21kOiBcIm9mZlwiLCAgIGRlc2M6IFwiQ2xlYXIgdGhlIGxhbmd1YWdlIHByZWZlcmVuY2UgKHJldmVydCB0byBkZWZhdWx0KVwiIH0sXG4gICAgeyBjbWQ6IFwiY2xlYXJcIiwgZGVzYzogXCJBbGlhcyBmb3Igb2ZmIFx1MjAxNCBjbGVhciB0aGUgbGFuZ3VhZ2UgcHJlZmVyZW5jZVwiIH0sXG4gIF0sXG4gIHdvcmt0cmVlOiBbXG4gICAgeyBjbWQ6IFwibGlzdFwiLCAgIGRlc2M6IFwiU2hvdyBhbGwgd29ya3RyZWVzIHdpdGggc3RhdHVzXCIgfSxcbiAgICB7IGNtZDogXCJtZXJnZVwiLCAgZGVzYzogXCJNZXJnZSBhIHdvcmt0cmVlIGludG8gbWFpbiBhbmQgY2xlYW4gdXBcIiB9LFxuICAgIHsgY21kOiBcImNsZWFuXCIsICBkZXNjOiBcIlJlbW92ZSBhbGwgbWVyZ2VkL2VtcHR5IHdvcmt0cmVlc1wiIH0sXG4gICAgeyBjbWQ6IFwicmVtb3ZlXCIsIGRlc2M6IFwiUmVtb3ZlIGEgd29ya3RyZWUgKC0tZm9yY2UgdG8gc2tpcCBzYWZldHkgY2hlY2tzKVwiIH0sXG4gIF0sXG59O1xuXG5mdW5jdGlvbiBmaWx0ZXJPcHRpb25zKFxuICBwYXJ0aWFsOiBzdHJpbmcsXG4gIG9wdGlvbnM6IHJlYWRvbmx5IEdzZENvbW1hbmREZWZpbml0aW9uW10sXG4gIHByZWZpeCA9IFwiXCIsXG4pIHtcbiAgY29uc3Qgbm9ybWFsaXplZFByZWZpeCA9IHByZWZpeCA/IGAke3ByZWZpeH0gYCA6IFwiXCI7XG4gIHJldHVybiBvcHRpb25zXG4gICAgLmZpbHRlcigob3B0aW9uKSA9PiBvcHRpb24uY21kLnN0YXJ0c1dpdGgocGFydGlhbCkpXG4gICAgLm1hcCgob3B0aW9uKSA9PiAoe1xuICAgICAgdmFsdWU6IGAke25vcm1hbGl6ZWRQcmVmaXh9JHtvcHRpb24uY21kfWAsXG4gICAgICBsYWJlbDogb3B0aW9uLmNtZCxcbiAgICAgIGRlc2NyaXB0aW9uOiBvcHRpb24uZGVzYyxcbiAgICB9KSk7XG59XG5cbmZ1bmN0aW9uIGdldEV4dGVuc2lvbkNvbXBsZXRpb25zKHByZWZpeDogc3RyaW5nLCBhY3Rpb246IHN0cmluZykge1xuICB0cnkge1xuICAgIGNvbnN0IGV4dERpciA9IGpvaW4oZ3NkSG9tZSgpLCBcImFnZW50XCIsIFwiZXh0ZW5zaW9uc1wiKTtcbiAgICBjb25zdCBpZHM6IEFycmF5PHsgaWQ6IHN0cmluZzsgbmFtZTogc3RyaW5nIH0+ID0gW107XG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiByZWFkZGlyU3luYyhleHREaXIsIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KSkge1xuICAgICAgaWYgKCFlbnRyeS5pc0RpcmVjdG9yeSgpKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IG1hbmlmZXN0UGF0aCA9IGpvaW4oZXh0RGlyLCBlbnRyeS5uYW1lLCBcImV4dGVuc2lvbi1tYW5pZmVzdC5qc29uXCIpO1xuICAgICAgaWYgKCFleGlzdHNTeW5jKG1hbmlmZXN0UGF0aCkpIGNvbnRpbnVlO1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgbWFuaWZlc3QgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhtYW5pZmVzdFBhdGgsIFwidXRmLThcIikpO1xuICAgICAgICBpZiAodHlwZW9mIG1hbmlmZXN0Py5pZCA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICAgIGlkcy5wdXNoKHsgaWQ6IG1hbmlmZXN0LmlkLCBuYW1lOiBtYW5pZmVzdC5uYW1lID8/IG1hbmlmZXN0LmlkIH0pO1xuICAgICAgICB9XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLy8gaWdub3JlIG1hbGZvcm1lZCBtYW5pZmVzdHNcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIGlkc1xuICAgICAgLmZpbHRlcigoZW50cnkpID0+IGVudHJ5LmlkLnN0YXJ0c1dpdGgocHJlZml4KSlcbiAgICAgIC5tYXAoKGVudHJ5KSA9PiAoe1xuICAgICAgICB2YWx1ZTogYGV4dGVuc2lvbnMgJHthY3Rpb259ICR7ZW50cnkuaWR9YCxcbiAgICAgICAgbGFiZWw6IGVudHJ5LmlkLFxuICAgICAgICBkZXNjcmlwdGlvbjogZW50cnkubmFtZSxcbiAgICAgIH0pKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVBhdGhGb3JDb21wYXJlKHBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBwYXRoLnJlcGxhY2VBbGwoXCJcXFxcXCIsIFwiL1wiKS5yZXBsYWNlKC9cXC8rJC8sIFwiXCIpO1xufVxuXG5mdW5jdGlvbiBmaW5kV29ya3RyZWVTZWdtZW50KG5vcm1hbGl6ZWRQYXRoOiBzdHJpbmcpOiB7IGdzZElkeDogbnVtYmVyOyBhZnRlcldvcmt0cmVlczogbnVtYmVyIH0gfCBudWxsIHtcbiAgY29uc3QgZGlyZWN0TWFya2VyID0gXCIvLmdzZC93b3JrdHJlZXMvXCI7XG4gIGNvbnN0IGRpcmVjdElkeCA9IG5vcm1hbGl6ZWRQYXRoLmluZGV4T2YoZGlyZWN0TWFya2VyKTtcbiAgaWYgKGRpcmVjdElkeCAhPT0gLTEpIHtcbiAgICByZXR1cm4geyBnc2RJZHg6IGRpcmVjdElkeCwgYWZ0ZXJXb3JrdHJlZXM6IGRpcmVjdElkeCArIGRpcmVjdE1hcmtlci5sZW5ndGggfTtcbiAgfVxuXG4gIGNvbnN0IHN5bWxpbmtNYXRjaCA9IG5vcm1hbGl6ZWRQYXRoLm1hdGNoKC9cXC9cXC5nc2RcXC9wcm9qZWN0c1xcL1thLWYwLTldK1xcL3dvcmt0cmVlc1xcLy8pO1xuICBpZiAoc3ltbGlua01hdGNoPy5pbmRleCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIHsgZ3NkSWR4OiBzeW1saW5rTWF0Y2guaW5kZXgsIGFmdGVyV29ya3RyZWVzOiBzeW1saW5rTWF0Y2guaW5kZXggKyBzeW1saW5rTWF0Y2hbMF0ubGVuZ3RoIH07XG4gIH1cblxuICByZXR1cm4gbnVsbDtcbn1cblxuZnVuY3Rpb24gcmVzb2x2ZVByb2plY3RSb290RnJvbUdpdEZpbGUod29ya3RyZWVQYXRoOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcbiAgdHJ5IHtcbiAgICBsZXQgZGlyID0gd29ya3RyZWVQYXRoO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgMzA7IGkrKykge1xuICAgICAgY29uc3QgZ2l0UGF0aCA9IGpvaW4oZGlyLCBcIi5naXRcIik7XG4gICAgICBpZiAoZXhpc3RzU3luYyhnaXRQYXRoKSkge1xuICAgICAgICBjb25zdCBjb250ZW50ID0gcmVhZEZpbGVTeW5jKGdpdFBhdGgsIFwidXRmOFwiKS50cmltKCk7XG4gICAgICAgIGlmIChjb250ZW50LnN0YXJ0c1dpdGgoXCJnaXRkaXI6IFwiKSkge1xuICAgICAgICAgIGNvbnN0IGdpdERpciA9IHJlc29sdmUoZGlyLCBjb250ZW50LnNsaWNlKDgpKTtcbiAgICAgICAgICBjb25zdCBkb3RHaXREaXIgPSByZXNvbHZlKGdpdERpciwgXCIuLlwiLCBcIi4uXCIpO1xuICAgICAgICAgIGlmIChkb3RHaXREaXIuZW5kc1dpdGgoXCIuZ2l0XCIpIHx8IGRvdEdpdERpci5lbmRzV2l0aChcIi5naXQvXCIpIHx8IGRvdEdpdERpci5lbmRzV2l0aChcIi5naXRcXFxcXCIpKSB7XG4gICAgICAgICAgICByZXR1cm4gcmVzb2x2ZShkb3RHaXREaXIsIFwiLi5cIik7XG4gICAgICAgICAgfVxuICAgICAgICAgIGNvbnN0IGNvbW1vbkRpclBhdGggPSBqb2luKGdpdERpciwgXCJjb21tb25kaXJcIik7XG4gICAgICAgICAgaWYgKGV4aXN0c1N5bmMoY29tbW9uRGlyUGF0aCkpIHtcbiAgICAgICAgICAgIGNvbnN0IGNvbW1vbkRpciA9IHJlYWRGaWxlU3luYyhjb21tb25EaXJQYXRoLCBcInV0ZjhcIikudHJpbSgpO1xuICAgICAgICAgICAgcmV0dXJuIHJlc29sdmUocmVzb2x2ZShnaXREaXIsIGNvbW1vbkRpciksIFwiLi5cIik7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY29uc3QgcGFyZW50ID0gcmVzb2x2ZShkaXIsIFwiLi5cIik7XG4gICAgICBpZiAocGFyZW50ID09PSBkaXIpIGJyZWFrO1xuICAgICAgZGlyID0gcGFyZW50O1xuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gQ29tcGxldGlvbiBtdXN0IHN0YXkgYmVzdC1lZmZvcnQuXG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIHJlc29sdmVQcm9qZWN0Um9vdEZvckNvbXBsZXRpb24oYmFzZVBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmIChwcm9jZXNzLmVudi5HU0RfUFJPSkVDVF9ST09UKSByZXR1cm4gcHJvY2Vzcy5lbnYuR1NEX1BST0pFQ1RfUk9PVDtcblxuICBjb25zdCBub3JtYWxpemVkUGF0aCA9IG5vcm1hbGl6ZVBhdGhGb3JDb21wYXJlKGJhc2VQYXRoKTtcbiAgY29uc3Qgc2VnbWVudCA9IGZpbmRXb3JrdHJlZVNlZ21lbnQobm9ybWFsaXplZFBhdGgpO1xuICBpZiAoIXNlZ21lbnQpIHJldHVybiBiYXNlUGF0aDtcblxuICBjb25zdCBzZXBhcmF0b3IgPSBiYXNlUGF0aC5pbmNsdWRlcyhcIlxcXFxcIikgPyBcIlxcXFxcIiA6IFwiL1wiO1xuICBjb25zdCBnc2RNYXJrZXIgPSBgJHtzZXBhcmF0b3J9LmdzZCR7c2VwYXJhdG9yfWA7XG4gIGNvbnN0IGdzZElkeCA9IGJhc2VQYXRoLmluZGV4T2YoZ3NkTWFya2VyKTtcbiAgY29uc3QgY2FuZGlkYXRlID0gZ3NkSWR4ICE9PSAtMSA/IGJhc2VQYXRoLnNsaWNlKDAsIGdzZElkeCkgOiBiYXNlUGF0aC5zbGljZSgwLCBzZWdtZW50LmdzZElkeCk7XG5cbiAgY29uc3Qgbm9ybWFsaXplZEdzZEhvbWUgPSBub3JtYWxpemVQYXRoRm9yQ29tcGFyZShnc2RIb21lKCkpO1xuICBjb25zdCBjYW5kaWRhdGVHc2RQYXRoID0gbm9ybWFsaXplUGF0aEZvckNvbXBhcmUoam9pbihjYW5kaWRhdGUsIFwiLmdzZFwiKSk7XG4gIGlmIChjYW5kaWRhdGVHc2RQYXRoID09PSBub3JtYWxpemVkR3NkSG9tZSB8fCBjYW5kaWRhdGVHc2RQYXRoLnN0YXJ0c1dpdGgoYCR7bm9ybWFsaXplZEdzZEhvbWV9L2ApKSB7XG4gICAgcmV0dXJuIHJlc29sdmVQcm9qZWN0Um9vdEZyb21HaXRGaWxlKGJhc2VQYXRoKSA/PyBiYXNlUGF0aDtcbiAgfVxuXG4gIHJldHVybiBjYW5kaWRhdGU7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRHc2RBcmd1bWVudENvbXBsZXRpb25zKHByZWZpeDogc3RyaW5nKSB7XG4gIGNvbnN0IGhhc1RyYWlsaW5nU3BhY2UgPSBwcmVmaXguZW5kc1dpdGgoXCIgXCIpO1xuICBjb25zdCBwYXJ0cyA9IHByZWZpeC50cmltKCkuc3BsaXQoL1xccysvKTtcbiAgaWYgKGhhc1RyYWlsaW5nU3BhY2UgJiYgcGFydHMubGVuZ3RoID49IDEpIHtcbiAgICBwYXJ0cy5wdXNoKFwiXCIpO1xuICB9XG5cbiAgaWYgKHBhcnRzLmxlbmd0aCA8PSAxKSB7XG4gICAgcmV0dXJuIGZpbHRlck9wdGlvbnMocGFydHNbMF0gPz8gXCJcIiwgVE9QX0xFVkVMX1NVQkNPTU1BTkRTKTtcbiAgfVxuXG4gIGNvbnN0IFtjb21tYW5kLCBzdWJjb21tYW5kID0gXCJcIiwgdGhpcmQgPSBcIlwiXSA9IHBhcnRzO1xuXG4gIGlmIChjb21tYW5kID09PSBcImNtdXhcIikge1xuICAgIGlmIChwYXJ0cy5sZW5ndGggPD0gMikge1xuICAgICAgcmV0dXJuIGZpbHRlck9wdGlvbnMoc3ViY29tbWFuZCwgW1xuICAgICAgICB7IGNtZDogXCJzdGF0dXNcIiwgZGVzYzogXCJTaG93IGNtdXggZGV0ZWN0aW9uLCBwcmVmcywgYW5kIGNhcGFiaWxpdGllc1wiIH0sXG4gICAgICAgIHsgY21kOiBcIm9uXCIsIGRlc2M6IFwiRW5hYmxlIGNtdXggaW50ZWdyYXRpb25cIiB9LFxuICAgICAgICB7IGNtZDogXCJvZmZcIiwgZGVzYzogXCJEaXNhYmxlIGNtdXggaW50ZWdyYXRpb25cIiB9LFxuICAgICAgICB7IGNtZDogXCJub3RpZmljYXRpb25zXCIsIGRlc2M6IFwiVG9nZ2xlIGNtdXggZGVza3RvcCBub3RpZmljYXRpb25zXCIgfSxcbiAgICAgICAgeyBjbWQ6IFwic2lkZWJhclwiLCBkZXNjOiBcIlRvZ2dsZSBjbXV4IHNpZGViYXIgbWV0YWRhdGFcIiB9LFxuICAgICAgICB7IGNtZDogXCJzcGxpdHNcIiwgZGVzYzogXCJUb2dnbGUgY211eCB2aXN1YWwgc3ViYWdlbnQgc3BsaXRzXCIgfSxcbiAgICAgICAgeyBjbWQ6IFwiYnJvd3NlclwiLCBkZXNjOiBcIlRvZ2dsZSBmdXR1cmUgYnJvd3NlciBpbnRlZ3JhdGlvbiBmbGFnXCIgfSxcbiAgICAgIF0sIFwiY211eFwiKTtcbiAgICB9XG4gICAgaWYgKHBhcnRzLmxlbmd0aCA8PSAzICYmIFtcIm5vdGlmaWNhdGlvbnNcIiwgXCJzaWRlYmFyXCIsIFwic3BsaXRzXCIsIFwiYnJvd3NlclwiXS5pbmNsdWRlcyhzdWJjb21tYW5kKSkge1xuICAgICAgcmV0dXJuIGZpbHRlck9wdGlvbnModGhpcmQsIFtcbiAgICAgICAgeyBjbWQ6IFwib25cIiwgZGVzYzogXCJFbmFibGUgdGhpcyBjbXV4IGFyZWFcIiB9LFxuICAgICAgICB7IGNtZDogXCJvZmZcIiwgZGVzYzogXCJEaXNhYmxlIHRoaXMgY211eCBhcmVhXCIgfSxcbiAgICAgIF0sIGBjbXV4ICR7c3ViY29tbWFuZH1gKTtcbiAgICB9XG4gICAgcmV0dXJuIFtdO1xuICB9XG5cbiAgaWYgKGNvbW1hbmQgPT09IFwidGVtcGxhdGVzXCIgJiYgc3ViY29tbWFuZCA9PT0gXCJpbmZvXCIgJiYgcGFydHMubGVuZ3RoIDw9IDMpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVnaXN0cnkgPSBsb2FkUmVnaXN0cnkoKTtcbiAgICAgIHJldHVybiBPYmplY3QuZW50cmllcyhyZWdpc3RyeS50ZW1wbGF0ZXMpXG4gICAgICAgIC5maWx0ZXIoKFtpZF0pID0+IGlkLnN0YXJ0c1dpdGgodGhpcmQpKVxuICAgICAgICAubWFwKChbaWQsIGVudHJ5XSkgPT4gKHtcbiAgICAgICAgICB2YWx1ZTogYHRlbXBsYXRlcyBpbmZvICR7aWR9YCxcbiAgICAgICAgICBsYWJlbDogaWQsXG4gICAgICAgICAgZGVzY3JpcHRpb246IGVudHJ5LmRlc2NyaXB0aW9uLFxuICAgICAgICB9KSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gW107XG4gICAgfVxuICB9XG5cbiAgaWYgKGNvbW1hbmQgPT09IFwiZXh0ZW5zaW9uc1wiICYmIHBhcnRzLmxlbmd0aCA9PT0gMyAmJiBbXCJlbmFibGVcIiwgXCJkaXNhYmxlXCIsIFwiaW5mb1wiXS5pbmNsdWRlcyhzdWJjb21tYW5kKSkge1xuICAgIHJldHVybiBnZXRFeHRlbnNpb25Db21wbGV0aW9ucyh0aGlyZCwgc3ViY29tbWFuZCk7XG4gIH1cblxuICBpZiAoY29tbWFuZCA9PT0gXCJ1bmRvXCIgJiYgcGFydHMubGVuZ3RoIDw9IDIpIHtcbiAgICByZXR1cm4gW3sgdmFsdWU6IFwidW5kbyAtLWZvcmNlXCIsIGxhYmVsOiBcIi0tZm9yY2VcIiwgZGVzY3JpcHRpb246IFwiU2tpcCBjb25maXJtYXRpb24gcHJvbXB0XCIgfV07XG4gIH1cblxuICAvLyBXb3JrZmxvdyBkZWZpbml0aW9uLW5hbWUgY29tcGxldGlvbiBmb3IgYHdvcmtmbG93IHJ1biA8bmFtZT5gIGFuZCBgd29ya2Zsb3cgdmFsaWRhdGUgPG5hbWU+YFxuICBpZiAoY29tbWFuZCA9PT0gXCJ3b3JrZmxvd1wiICYmIChzdWJjb21tYW5kID09PSBcInJ1blwiIHx8IHN1YmNvbW1hbmQgPT09IFwidmFsaWRhdGVcIikgJiYgcGFydHMubGVuZ3RoIDw9IDMpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgZGVmc0RpciA9IGpvaW4ocmVzb2x2ZVByb2plY3RSb290Rm9yQ29tcGxldGlvbihwcm9jZXNzLmN3ZCgpKSwgXCIuZ3NkXCIsIFwid29ya2Zsb3ctZGVmc1wiKTtcbiAgICAgIGlmIChleGlzdHNTeW5jKGRlZnNEaXIpKSB7XG4gICAgICAgIHJldHVybiByZWFkZGlyU3luYyhkZWZzRGlyKVxuICAgICAgICAgIC5maWx0ZXIoKGYpID0+IGYuZW5kc1dpdGgoXCIueWFtbFwiKSAmJiBmLnN0YXJ0c1dpdGgodGhpcmQpKVxuICAgICAgICAgIC5tYXAoKGYpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IG5hbWUgPSBmLnJlcGxhY2UoL1xcLnlhbWwkLywgXCJcIik7XG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICB2YWx1ZTogYHdvcmtmbG93ICR7c3ViY29tbWFuZH0gJHtuYW1lfWAsXG4gICAgICAgICAgICAgIGxhYmVsOiBuYW1lLFxuICAgICAgICAgICAgICBkZXNjcmlwdGlvbjogYFdvcmtmbG93IGRlZmluaXRpb246ICR7bmFtZX1gLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIGlnbm9yZSBmaWxlc3lzdGVtIGVycm9ycyBkdXJpbmcgY29tcGxldGlvblxuICAgIH1cbiAgICByZXR1cm4gW107XG4gIH1cblxuICAvLyBDb21wbGV0aW9uIGZvciBgL2dzZCB3b3JrZmxvdyBpbmZvIDxuYW1lPmAgXHUyMDE0IGxpc3QgYWxsIGRpc2NvdmVyYWJsZSBwbHVnaW5zIChwcm9qZWN0ICsgZ2xvYmFsKS5cbiAgaWYgKGNvbW1hbmQgPT09IFwid29ya2Zsb3dcIiAmJiBzdWJjb21tYW5kID09PSBcImluZm9cIiAmJiBwYXJ0cy5sZW5ndGggPD0gMykge1xuICAgIGNvbnN0IHJlc3VsdHM6IEdzZENvbW1hbmREZWZpbml0aW9uW10gPSBbXTtcbiAgICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgY29uc3Qgc2NhbkRpciA9IChkaXI6IHN0cmluZywgc291cmNlOiBzdHJpbmcpID0+IHtcbiAgICAgIGlmICghZXhpc3RzU3luYyhkaXIpKSByZXR1cm47XG4gICAgICB0cnkge1xuICAgICAgICBmb3IgKGNvbnN0IGYgb2YgcmVhZGRpclN5bmMoZGlyKSkge1xuICAgICAgICAgIGlmICghL1xcLih5YT9tbHxtZCkkL2kudGVzdChmKSkgY29udGludWU7XG4gICAgICAgICAgY29uc3QgbmFtZSA9IGYucmVwbGFjZSgvXFwuKHlhP21sfG1kKSQvaSwgXCJcIik7XG4gICAgICAgICAgaWYgKCFuYW1lLnN0YXJ0c1dpdGgodGhpcmQpKSBjb250aW51ZTtcbiAgICAgICAgICBpZiAoc2Vlbi5oYXMobmFtZSkpIGNvbnRpbnVlO1xuICAgICAgICAgIHNlZW4uYWRkKG5hbWUpO1xuICAgICAgICAgIHJlc3VsdHMucHVzaCh7IGNtZDogbmFtZSwgZGVzYzogYFdvcmtmbG93IHBsdWdpbiAoJHtzb3VyY2V9KWAgfSk7XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2ggeyAvKiBpZ25vcmUgKi8gfVxuICAgIH07XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGJhc2UgPSByZXNvbHZlUHJvamVjdFJvb3RGb3JDb21wbGV0aW9uKHByb2Nlc3MuY3dkKCkpO1xuICAgICAgc2NhbkRpcihqb2luKGJhc2UsIFwiLmdzZFwiLCBcIndvcmtmbG93c1wiKSwgXCJwcm9qZWN0XCIpO1xuICAgICAgc2NhbkRpcihqb2luKGJhc2UsIFwiLmdzZFwiLCBcIndvcmtmbG93LWRlZnNcIiksIFwicHJvamVjdC1sZWdhY3lcIik7XG4gICAgICBzY2FuRGlyKGpvaW4oZ3NkSG9tZSgpLCBcIndvcmtmbG93c1wiKSwgXCJnbG9iYWxcIik7XG4gICAgfSBjYXRjaCB7IC8qIGlnbm9yZSAqLyB9XG4gICAgLy8gQWxzbyBpbmNsdWRlIGJ1bmRsZWQgdGVtcGxhdGUgbmFtZXMuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlZ2lzdHJ5ID0gbG9hZFJlZ2lzdHJ5KCk7XG4gICAgICBmb3IgKGNvbnN0IGlkIG9mIE9iamVjdC5rZXlzKHJlZ2lzdHJ5LnRlbXBsYXRlcykpIHtcbiAgICAgICAgaWYgKHNlZW4uaGFzKGlkKSB8fCAhaWQuc3RhcnRzV2l0aCh0aGlyZCkpIGNvbnRpbnVlO1xuICAgICAgICBzZWVuLmFkZChpZCk7XG4gICAgICAgIHJlc3VsdHMucHVzaCh7IGNtZDogaWQsIGRlc2M6IFwiV29ya2Zsb3cgcGx1Z2luIChidW5kbGVkKVwiIH0pO1xuICAgICAgfVxuICAgIH0gY2F0Y2ggeyAvKiBpZ25vcmUgKi8gfVxuICAgIHJldHVybiByZXN1bHRzLm1hcCgocikgPT4gKHtcbiAgICAgIHZhbHVlOiBgd29ya2Zsb3cgaW5mbyAke3IuY21kfWAsXG4gICAgICBsYWJlbDogci5jbWQsXG4gICAgICBkZXNjcmlwdGlvbjogci5kZXNjLFxuICAgIH0pKTtcbiAgfVxuXG4gIGNvbnN0IG5lc3RlZCA9IE5FU1RFRF9DT01QTEVUSU9OU1tjb21tYW5kXTtcbiAgaWYgKG5lc3RlZCAmJiBwYXJ0cy5sZW5ndGggPD0gMikge1xuICAgIHJldHVybiBmaWx0ZXJPcHRpb25zKHN1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
