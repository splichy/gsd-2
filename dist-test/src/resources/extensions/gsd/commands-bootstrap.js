import { importExtensionModule } from "@gsd/pi-coding-agent";
import { VISUAL_BRIEF_MODES } from "../visual-brief/prompts.js";
const TOP_LEVEL_SUBCOMMANDS = [
  { cmd: "help", desc: "Categorized command reference with descriptions" },
  { cmd: "next", desc: "Explicit step mode (same as /gsd)" },
  { cmd: "auto", desc: "Autonomous mode \u2014 research, plan, execute, commit, repeat" },
  { cmd: "stop", desc: "Stop auto mode gracefully" },
  { cmd: "pause", desc: "Pause auto-mode (preserves state, /gsd auto to resume)" },
  { cmd: "status", desc: "Progress dashboard" },
  { cmd: "visualize", desc: "Open workflow visualizer" },
  { cmd: "brief", desc: "Generate a visual HTML brief" },
  { cmd: "queue", desc: "Queue and reorder future milestones" },
  { cmd: "quick", desc: "Execute a quick task without full planning overhead" },
  { cmd: "discuss", desc: "Discuss architecture and decisions" },
  { cmd: "capture", desc: "Fire-and-forget thought capture" },
  { cmd: "changelog", desc: "Show categorized release notes" },
  { cmd: "triage", desc: "Manually trigger triage of pending captures" },
  { cmd: "dispatch", desc: "Dispatch a specific phase directly" },
  { cmd: "history", desc: "View execution history" },
  { cmd: "undo", desc: "Revert last completed unit" },
  { cmd: "skip", desc: "Prevent a unit from auto-mode dispatch" },
  { cmd: "export", desc: "Export milestone or slice results" },
  { cmd: "cleanup", desc: "Remove merged branches or snapshots" },
  { cmd: "mode", desc: "Switch workflow mode (solo/team)" },
  { cmd: "prefs", desc: "Manage preferences" },
  { cmd: "config", desc: "Set API keys for external tools" },
  { cmd: "keys", desc: "API key manager" },
  { cmd: "hooks", desc: "Show configured hooks" },
  { cmd: "run-hook", desc: "Manually trigger a specific hook" },
  { cmd: "skill-health", desc: "Skill lifecycle dashboard" },
  { cmd: "doctor", desc: "Runtime health checks with auto-fix" },
  { cmd: "logs", desc: "Browse activity logs, debug logs, and metrics" },
  { cmd: "forensics", desc: "Examine execution logs" },
  { cmd: "init", desc: "Project init wizard" },
  { cmd: "setup", desc: "Global setup status and configuration" },
  { cmd: "migrate", desc: "Migrate a v1 .planning directory to .gsd format" },
  { cmd: "remote", desc: "Control remote auto-mode" },
  { cmd: "steer", desc: "Hard-steer plan documents during execution" },
  { cmd: "inspect", desc: "Show SQLite DB diagnostics" },
  { cmd: "knowledge", desc: "Add persistent project knowledge" },
  { cmd: "new-milestone", desc: "Create a milestone from a specification document" },
  { cmd: "new-project", desc: "Bootstrap a new project (use --deep for staged project-level discovery)" },
  { cmd: "parallel", desc: "Parallel milestone orchestration" },
  { cmd: "park", desc: "Park a milestone" },
  { cmd: "unpark", desc: "Reactivate a parked milestone" },
  { cmd: "update", desc: "Update GSD to the latest version" },
  { cmd: "start", desc: "Start a workflow template" },
  { cmd: "templates", desc: "List available workflow templates" },
  { cmd: "extensions", desc: "Manage extensions" },
  { cmd: "codebase", desc: "Generate, refresh, and inspect the codebase map cache" }
];
function filterStartsWith(partial, options, prefix = "") {
  const normalizedPrefix = prefix.length > 0 ? `${prefix} ` : "";
  return options.filter((option) => option.cmd.startsWith(partial)).map((option) => ({
    value: `${normalizedPrefix}${option.cmd}`,
    label: option.cmd,
    description: option.desc
  }));
}
function getGsdArgumentCompletions(prefix) {
  const parts = prefix.trim().split(/\s+/);
  if (parts.length <= 1) {
    return filterStartsWith(parts[0] ?? "", TOP_LEVEL_SUBCOMMANDS);
  }
  const partial = parts[1] ?? "";
  if (parts[0] === "auto" && parts.length <= 2) {
    return filterStartsWith(partial, [
      { cmd: "--verbose", desc: "Show detailed execution output" },
      { cmd: "--debug", desc: "Enable debug logging" }
    ], "auto");
  }
  if (parts[0] === "next" && parts.length <= 2) {
    return filterStartsWith(partial, [
      { cmd: "--verbose", desc: "Show detailed step output" },
      { cmd: "--dry-run", desc: "Preview next step without executing" }
    ], "next");
  }
  if (parts[0] === "brief" && parts.length <= 2) {
    return filterStartsWith(
      partial,
      VISUAL_BRIEF_MODES.map((mode) => ({ cmd: mode.mode, desc: mode.description })),
      "brief"
    );
  }
  if ((parts[0] === "new-project" || parts[0] === "new-milestone") && parts.length <= 2) {
    return filterStartsWith(partial, [
      { cmd: "--deep", desc: "Enable deep planning mode (staged project-level discovery)" }
    ], parts[0]);
  }
  if (parts[0] === "mode" && parts.length <= 2) {
    return filterStartsWith(partial, [
      { cmd: "global", desc: "Edit global workflow mode" },
      { cmd: "project", desc: "Edit project-specific workflow mode" }
    ], "mode");
  }
  if (parts[0] === "parallel" && parts.length <= 2) {
    return filterStartsWith(partial, [
      { cmd: "start", desc: "Start parallel milestone orchestration" },
      { cmd: "status", desc: "Show parallel worker statuses" },
      { cmd: "stop", desc: "Stop all parallel workers" },
      { cmd: "pause", desc: "Pause a specific worker" },
      { cmd: "resume", desc: "Resume a paused worker" },
      { cmd: "merge", desc: "Merge completed milestone branches" }
    ], "parallel");
  }
  if (parts[0] === "setup" && parts.length <= 2) {
    return filterStartsWith(partial, [
      { cmd: "llm", desc: "Configure LLM provider settings" },
      { cmd: "search", desc: "Configure web search provider" },
      { cmd: "remote", desc: "Configure remote integrations" },
      { cmd: "keys", desc: "Manage API keys" },
      { cmd: "prefs", desc: "Configure global preferences" }
    ], "setup");
  }
  if (parts[0] === "logs" && parts.length <= 2) {
    return filterStartsWith(partial, [
      { cmd: "debug", desc: "List or view debug log files" },
      { cmd: "tail", desc: "Show last N activity log summaries" },
      { cmd: "clear", desc: "Remove old activity and debug logs" }
    ], "logs");
  }
  if (parts[0] === "keys" && parts.length <= 2) {
    return filterStartsWith(partial, [
      { cmd: "list", desc: "Show key status dashboard" },
      { cmd: "add", desc: "Add a key for a provider" },
      { cmd: "remove", desc: "Remove a key" },
      { cmd: "test", desc: "Validate key(s) with API call" },
      { cmd: "rotate", desc: "Replace an existing key" },
      { cmd: "doctor", desc: "Health check all keys" }
    ], "keys");
  }
  if (parts[0] === "prefs" && parts.length <= 2) {
    return filterStartsWith(partial, [
      { cmd: "global", desc: "Edit global preferences file" },
      { cmd: "project", desc: "Edit project preferences file" },
      { cmd: "status", desc: "Show effective preferences" },
      { cmd: "wizard", desc: "Interactive preferences wizard" },
      { cmd: "setup", desc: "First-time preferences setup" },
      { cmd: "import-claude", desc: "Import settings from Claude Code" }
    ], "prefs");
  }
  if (parts[0] === "remote" && parts.length <= 2) {
    return filterStartsWith(partial, [
      { cmd: "slack", desc: "Configure Slack integration" },
      { cmd: "discord", desc: "Configure Discord integration" },
      { cmd: "status", desc: "Show remote connection status" },
      { cmd: "disconnect", desc: "Disconnect remote integrations" }
    ], "remote");
  }
  if (parts[0] === "history" && parts.length <= 2) {
    return filterStartsWith(partial, [
      { cmd: "--cost", desc: "Show cost breakdown per entry" },
      { cmd: "--phase", desc: "Filter by phase type" },
      { cmd: "--model", desc: "Filter by model used" },
      { cmd: "10", desc: "Show last 10 entries" },
      { cmd: "20", desc: "Show last 20 entries" },
      { cmd: "50", desc: "Show last 50 entries" }
    ], "history");
  }
  if (parts[0] === "export" && parts.length <= 2) {
    return filterStartsWith(partial, [
      { cmd: "--json", desc: "Export as JSON" },
      { cmd: "--markdown", desc: "Export as Markdown" },
      { cmd: "--html", desc: "Export as HTML" },
      { cmd: "--html --all", desc: "Export all milestones as HTML" }
    ], "export");
  }
  if (parts[0] === "cleanup" && parts.length <= 2) {
    return filterStartsWith(partial, [
      { cmd: "branches", desc: "Remove merged milestone branches" },
      { cmd: "snapshots", desc: "Remove old execution snapshots" }
    ], "cleanup");
  }
  if (parts[0] === "knowledge" && parts.length <= 2) {
    return filterStartsWith(partial, [
      { cmd: "rule", desc: "Add a project rule" },
      { cmd: "pattern", desc: "Add a code pattern" },
      { cmd: "lesson", desc: "Record a lesson learned" }
    ], "knowledge");
  }
  if (parts[0] === "start" && parts.length <= 2) {
    return filterStartsWith(partial, [
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
    ], "start");
  }
  if (parts[0] === "templates" && parts.length <= 2) {
    return filterStartsWith(partial, [
      { cmd: "info", desc: "Show detailed template info" }
    ], "templates");
  }
  if (parts[0] === "extensions" && parts.length <= 2) {
    return filterStartsWith(partial, [
      { cmd: "list", desc: "List all extensions and their status" },
      { cmd: "enable", desc: "Enable a disabled extension" },
      { cmd: "disable", desc: "Disable an extension" },
      { cmd: "info", desc: "Show extension details" }
    ], "extensions");
  }
  if (parts[0] === "codebase" && parts.length <= 2) {
    return filterStartsWith(partial, [
      { cmd: "generate", desc: "Generate or regenerate CODEBASE.md" },
      { cmd: "update", desc: "Refresh the CODEBASE.md cache immediately" },
      { cmd: "stats", desc: "Show codebase-map coverage and generation time" },
      { cmd: "help", desc: "Show usage and subcommands" }
    ], "codebase");
  }
  if (parts[0] === "doctor" && parts.length <= 2) {
    return filterStartsWith(partial, [
      { cmd: "fix", desc: "Auto-fix detected issues" },
      { cmd: "heal", desc: "AI-driven deep healing" },
      { cmd: "audit", desc: "Run health audit without fixing" }
    ], "doctor");
  }
  if (parts[0] === "dispatch" && parts.length <= 2) {
    return filterStartsWith(partial, [
      { cmd: "research", desc: "Run research phase" },
      { cmd: "plan", desc: "Run planning phase" },
      { cmd: "execute", desc: "Run execution phase" },
      { cmd: "complete", desc: "Run completion phase" },
      { cmd: "reassess", desc: "Reassess current progress" },
      { cmd: "uat", desc: "Run user acceptance testing" },
      { cmd: "replan", desc: "Replan the current slice" }
    ], "dispatch");
  }
  return null;
}
function registerLazyGSDCommand(pi) {
  pi.registerCommand("gsd", {
    description: "GSD \u2014 Get Shit Done",
    getArgumentCompletions: getGsdArgumentCompletions,
    handler: async (args, ctx) => {
      const { handleGSDCommand } = await importExtensionModule(import.meta.url, "./commands.js");
      await handleGSDCommand(args, ctx, pi);
    }
  });
}
export {
  registerLazyGSDCommand
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9jb21tYW5kcy1ib290c3RyYXAudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IGltcG9ydEV4dGVuc2lvbk1vZHVsZSwgdHlwZSBFeHRlbnNpb25BUEksIHR5cGUgRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB7IFZJU1VBTF9CUklFRl9NT0RFUyB9IGZyb20gXCIuLi92aXN1YWwtYnJpZWYvcHJvbXB0cy5qc1wiO1xuXG5jb25zdCBUT1BfTEVWRUxfU1VCQ09NTUFORFMgPSBbXG4gIHsgY21kOiBcImhlbHBcIiwgZGVzYzogXCJDYXRlZ29yaXplZCBjb21tYW5kIHJlZmVyZW5jZSB3aXRoIGRlc2NyaXB0aW9uc1wiIH0sXG4gIHsgY21kOiBcIm5leHRcIiwgZGVzYzogXCJFeHBsaWNpdCBzdGVwIG1vZGUgKHNhbWUgYXMgL2dzZClcIiB9LFxuICB7IGNtZDogXCJhdXRvXCIsIGRlc2M6IFwiQXV0b25vbW91cyBtb2RlIFx1MjAxNCByZXNlYXJjaCwgcGxhbiwgZXhlY3V0ZSwgY29tbWl0LCByZXBlYXRcIiB9LFxuICB7IGNtZDogXCJzdG9wXCIsIGRlc2M6IFwiU3RvcCBhdXRvIG1vZGUgZ3JhY2VmdWxseVwiIH0sXG4gIHsgY21kOiBcInBhdXNlXCIsIGRlc2M6IFwiUGF1c2UgYXV0by1tb2RlIChwcmVzZXJ2ZXMgc3RhdGUsIC9nc2QgYXV0byB0byByZXN1bWUpXCIgfSxcbiAgeyBjbWQ6IFwic3RhdHVzXCIsIGRlc2M6IFwiUHJvZ3Jlc3MgZGFzaGJvYXJkXCIgfSxcbiAgeyBjbWQ6IFwidmlzdWFsaXplXCIsIGRlc2M6IFwiT3BlbiB3b3JrZmxvdyB2aXN1YWxpemVyXCIgfSxcbiAgeyBjbWQ6IFwiYnJpZWZcIiwgZGVzYzogXCJHZW5lcmF0ZSBhIHZpc3VhbCBIVE1MIGJyaWVmXCIgfSxcbiAgeyBjbWQ6IFwicXVldWVcIiwgZGVzYzogXCJRdWV1ZSBhbmQgcmVvcmRlciBmdXR1cmUgbWlsZXN0b25lc1wiIH0sXG4gIHsgY21kOiBcInF1aWNrXCIsIGRlc2M6IFwiRXhlY3V0ZSBhIHF1aWNrIHRhc2sgd2l0aG91dCBmdWxsIHBsYW5uaW5nIG92ZXJoZWFkXCIgfSxcbiAgeyBjbWQ6IFwiZGlzY3Vzc1wiLCBkZXNjOiBcIkRpc2N1c3MgYXJjaGl0ZWN0dXJlIGFuZCBkZWNpc2lvbnNcIiB9LFxuICB7IGNtZDogXCJjYXB0dXJlXCIsIGRlc2M6IFwiRmlyZS1hbmQtZm9yZ2V0IHRob3VnaHQgY2FwdHVyZVwiIH0sXG4gIHsgY21kOiBcImNoYW5nZWxvZ1wiLCBkZXNjOiBcIlNob3cgY2F0ZWdvcml6ZWQgcmVsZWFzZSBub3Rlc1wiIH0sXG4gIHsgY21kOiBcInRyaWFnZVwiLCBkZXNjOiBcIk1hbnVhbGx5IHRyaWdnZXIgdHJpYWdlIG9mIHBlbmRpbmcgY2FwdHVyZXNcIiB9LFxuICB7IGNtZDogXCJkaXNwYXRjaFwiLCBkZXNjOiBcIkRpc3BhdGNoIGEgc3BlY2lmaWMgcGhhc2UgZGlyZWN0bHlcIiB9LFxuICB7IGNtZDogXCJoaXN0b3J5XCIsIGRlc2M6IFwiVmlldyBleGVjdXRpb24gaGlzdG9yeVwiIH0sXG4gIHsgY21kOiBcInVuZG9cIiwgZGVzYzogXCJSZXZlcnQgbGFzdCBjb21wbGV0ZWQgdW5pdFwiIH0sXG4gIHsgY21kOiBcInNraXBcIiwgZGVzYzogXCJQcmV2ZW50IGEgdW5pdCBmcm9tIGF1dG8tbW9kZSBkaXNwYXRjaFwiIH0sXG4gIHsgY21kOiBcImV4cG9ydFwiLCBkZXNjOiBcIkV4cG9ydCBtaWxlc3RvbmUgb3Igc2xpY2UgcmVzdWx0c1wiIH0sXG4gIHsgY21kOiBcImNsZWFudXBcIiwgZGVzYzogXCJSZW1vdmUgbWVyZ2VkIGJyYW5jaGVzIG9yIHNuYXBzaG90c1wiIH0sXG4gIHsgY21kOiBcIm1vZGVcIiwgZGVzYzogXCJTd2l0Y2ggd29ya2Zsb3cgbW9kZSAoc29sby90ZWFtKVwiIH0sXG4gIHsgY21kOiBcInByZWZzXCIsIGRlc2M6IFwiTWFuYWdlIHByZWZlcmVuY2VzXCIgfSxcbiAgeyBjbWQ6IFwiY29uZmlnXCIsIGRlc2M6IFwiU2V0IEFQSSBrZXlzIGZvciBleHRlcm5hbCB0b29sc1wiIH0sXG4gIHsgY21kOiBcImtleXNcIiwgZGVzYzogXCJBUEkga2V5IG1hbmFnZXJcIiB9LFxuICB7IGNtZDogXCJob29rc1wiLCBkZXNjOiBcIlNob3cgY29uZmlndXJlZCBob29rc1wiIH0sXG4gIHsgY21kOiBcInJ1bi1ob29rXCIsIGRlc2M6IFwiTWFudWFsbHkgdHJpZ2dlciBhIHNwZWNpZmljIGhvb2tcIiB9LFxuICB7IGNtZDogXCJza2lsbC1oZWFsdGhcIiwgZGVzYzogXCJTa2lsbCBsaWZlY3ljbGUgZGFzaGJvYXJkXCIgfSxcbiAgeyBjbWQ6IFwiZG9jdG9yXCIsIGRlc2M6IFwiUnVudGltZSBoZWFsdGggY2hlY2tzIHdpdGggYXV0by1maXhcIiB9LFxuICB7IGNtZDogXCJsb2dzXCIsIGRlc2M6IFwiQnJvd3NlIGFjdGl2aXR5IGxvZ3MsIGRlYnVnIGxvZ3MsIGFuZCBtZXRyaWNzXCIgfSxcbiAgeyBjbWQ6IFwiZm9yZW5zaWNzXCIsIGRlc2M6IFwiRXhhbWluZSBleGVjdXRpb24gbG9nc1wiIH0sXG4gIHsgY21kOiBcImluaXRcIiwgZGVzYzogXCJQcm9qZWN0IGluaXQgd2l6YXJkXCIgfSxcbiAgeyBjbWQ6IFwic2V0dXBcIiwgZGVzYzogXCJHbG9iYWwgc2V0dXAgc3RhdHVzIGFuZCBjb25maWd1cmF0aW9uXCIgfSxcbiAgeyBjbWQ6IFwibWlncmF0ZVwiLCBkZXNjOiBcIk1pZ3JhdGUgYSB2MSAucGxhbm5pbmcgZGlyZWN0b3J5IHRvIC5nc2QgZm9ybWF0XCIgfSxcbiAgeyBjbWQ6IFwicmVtb3RlXCIsIGRlc2M6IFwiQ29udHJvbCByZW1vdGUgYXV0by1tb2RlXCIgfSxcbiAgeyBjbWQ6IFwic3RlZXJcIiwgZGVzYzogXCJIYXJkLXN0ZWVyIHBsYW4gZG9jdW1lbnRzIGR1cmluZyBleGVjdXRpb25cIiB9LFxuICB7IGNtZDogXCJpbnNwZWN0XCIsIGRlc2M6IFwiU2hvdyBTUUxpdGUgREIgZGlhZ25vc3RpY3NcIiB9LFxuICB7IGNtZDogXCJrbm93bGVkZ2VcIiwgZGVzYzogXCJBZGQgcGVyc2lzdGVudCBwcm9qZWN0IGtub3dsZWRnZVwiIH0sXG4gIHsgY21kOiBcIm5ldy1taWxlc3RvbmVcIiwgZGVzYzogXCJDcmVhdGUgYSBtaWxlc3RvbmUgZnJvbSBhIHNwZWNpZmljYXRpb24gZG9jdW1lbnRcIiB9LFxuICB7IGNtZDogXCJuZXctcHJvamVjdFwiLCBkZXNjOiBcIkJvb3RzdHJhcCBhIG5ldyBwcm9qZWN0ICh1c2UgLS1kZWVwIGZvciBzdGFnZWQgcHJvamVjdC1sZXZlbCBkaXNjb3ZlcnkpXCIgfSxcbiAgeyBjbWQ6IFwicGFyYWxsZWxcIiwgZGVzYzogXCJQYXJhbGxlbCBtaWxlc3RvbmUgb3JjaGVzdHJhdGlvblwiIH0sXG4gIHsgY21kOiBcInBhcmtcIiwgZGVzYzogXCJQYXJrIGEgbWlsZXN0b25lXCIgfSxcbiAgeyBjbWQ6IFwidW5wYXJrXCIsIGRlc2M6IFwiUmVhY3RpdmF0ZSBhIHBhcmtlZCBtaWxlc3RvbmVcIiB9LFxuICB7IGNtZDogXCJ1cGRhdGVcIiwgZGVzYzogXCJVcGRhdGUgR1NEIHRvIHRoZSBsYXRlc3QgdmVyc2lvblwiIH0sXG4gIHsgY21kOiBcInN0YXJ0XCIsIGRlc2M6IFwiU3RhcnQgYSB3b3JrZmxvdyB0ZW1wbGF0ZVwiIH0sXG4gIHsgY21kOiBcInRlbXBsYXRlc1wiLCBkZXNjOiBcIkxpc3QgYXZhaWxhYmxlIHdvcmtmbG93IHRlbXBsYXRlc1wiIH0sXG4gIHsgY21kOiBcImV4dGVuc2lvbnNcIiwgZGVzYzogXCJNYW5hZ2UgZXh0ZW5zaW9uc1wiIH0sXG4gIHsgY21kOiBcImNvZGViYXNlXCIsIGRlc2M6IFwiR2VuZXJhdGUsIHJlZnJlc2gsIGFuZCBpbnNwZWN0IHRoZSBjb2RlYmFzZSBtYXAgY2FjaGVcIiB9LFxuXSBhcyBjb25zdDtcblxuZnVuY3Rpb24gZmlsdGVyU3RhcnRzV2l0aChcbiAgcGFydGlhbDogc3RyaW5nLFxuICBvcHRpb25zOiBSZWFkb25seUFycmF5PHsgY21kOiBzdHJpbmc7IGRlc2M6IHN0cmluZyB9PixcbiAgcHJlZml4ID0gXCJcIixcbikge1xuICBjb25zdCBub3JtYWxpemVkUHJlZml4ID0gcHJlZml4Lmxlbmd0aCA+IDAgPyBgJHtwcmVmaXh9IGAgOiBcIlwiO1xuICByZXR1cm4gb3B0aW9uc1xuICAgIC5maWx0ZXIoKG9wdGlvbikgPT4gb3B0aW9uLmNtZC5zdGFydHNXaXRoKHBhcnRpYWwpKVxuICAgIC5tYXAoKG9wdGlvbikgPT4gKHtcbiAgICAgIHZhbHVlOiBgJHtub3JtYWxpemVkUHJlZml4fSR7b3B0aW9uLmNtZH1gLFxuICAgICAgbGFiZWw6IG9wdGlvbi5jbWQsXG4gICAgICBkZXNjcmlwdGlvbjogb3B0aW9uLmRlc2MsXG4gICAgfSkpO1xufVxuXG5mdW5jdGlvbiBnZXRHc2RBcmd1bWVudENvbXBsZXRpb25zKHByZWZpeDogc3RyaW5nKSB7XG4gIGNvbnN0IHBhcnRzID0gcHJlZml4LnRyaW0oKS5zcGxpdCgvXFxzKy8pO1xuXG4gIGlmIChwYXJ0cy5sZW5ndGggPD0gMSkge1xuICAgIHJldHVybiBmaWx0ZXJTdGFydHNXaXRoKHBhcnRzWzBdID8/IFwiXCIsIFRPUF9MRVZFTF9TVUJDT01NQU5EUyk7XG4gIH1cblxuICBjb25zdCBwYXJ0aWFsID0gcGFydHNbMV0gPz8gXCJcIjtcblxuICBpZiAocGFydHNbMF0gPT09IFwiYXV0b1wiICYmIHBhcnRzLmxlbmd0aCA8PSAyKSB7XG4gICAgcmV0dXJuIGZpbHRlclN0YXJ0c1dpdGgocGFydGlhbCwgW1xuICAgICAgeyBjbWQ6IFwiLS12ZXJib3NlXCIsIGRlc2M6IFwiU2hvdyBkZXRhaWxlZCBleGVjdXRpb24gb3V0cHV0XCIgfSxcbiAgICAgIHsgY21kOiBcIi0tZGVidWdcIiwgZGVzYzogXCJFbmFibGUgZGVidWcgbG9nZ2luZ1wiIH0sXG4gICAgXSwgXCJhdXRvXCIpO1xuICB9XG5cbiAgaWYgKHBhcnRzWzBdID09PSBcIm5leHRcIiAmJiBwYXJ0cy5sZW5ndGggPD0gMikge1xuICAgIHJldHVybiBmaWx0ZXJTdGFydHNXaXRoKHBhcnRpYWwsIFtcbiAgICAgIHsgY21kOiBcIi0tdmVyYm9zZVwiLCBkZXNjOiBcIlNob3cgZGV0YWlsZWQgc3RlcCBvdXRwdXRcIiB9LFxuICAgICAgeyBjbWQ6IFwiLS1kcnktcnVuXCIsIGRlc2M6IFwiUHJldmlldyBuZXh0IHN0ZXAgd2l0aG91dCBleGVjdXRpbmdcIiB9LFxuICAgIF0sIFwibmV4dFwiKTtcbiAgfVxuXG4gIGlmIChwYXJ0c1swXSA9PT0gXCJicmllZlwiICYmIHBhcnRzLmxlbmd0aCA8PSAyKSB7XG4gICAgcmV0dXJuIGZpbHRlclN0YXJ0c1dpdGgoXG4gICAgICBwYXJ0aWFsLFxuICAgICAgVklTVUFMX0JSSUVGX01PREVTLm1hcCgobW9kZSkgPT4gKHsgY21kOiBtb2RlLm1vZGUsIGRlc2M6IG1vZGUuZGVzY3JpcHRpb24gfSkpLFxuICAgICAgXCJicmllZlwiLFxuICAgICk7XG4gIH1cblxuICBpZiAoKHBhcnRzWzBdID09PSBcIm5ldy1wcm9qZWN0XCIgfHwgcGFydHNbMF0gPT09IFwibmV3LW1pbGVzdG9uZVwiKSAmJiBwYXJ0cy5sZW5ndGggPD0gMikge1xuICAgIHJldHVybiBmaWx0ZXJTdGFydHNXaXRoKHBhcnRpYWwsIFtcbiAgICAgIHsgY21kOiBcIi0tZGVlcFwiLCBkZXNjOiBcIkVuYWJsZSBkZWVwIHBsYW5uaW5nIG1vZGUgKHN0YWdlZCBwcm9qZWN0LWxldmVsIGRpc2NvdmVyeSlcIiB9LFxuICAgIF0sIHBhcnRzWzBdKTtcbiAgfVxuXG4gIGlmIChwYXJ0c1swXSA9PT0gXCJtb2RlXCIgJiYgcGFydHMubGVuZ3RoIDw9IDIpIHtcbiAgICByZXR1cm4gZmlsdGVyU3RhcnRzV2l0aChwYXJ0aWFsLCBbXG4gICAgICB7IGNtZDogXCJnbG9iYWxcIiwgZGVzYzogXCJFZGl0IGdsb2JhbCB3b3JrZmxvdyBtb2RlXCIgfSxcbiAgICAgIHsgY21kOiBcInByb2plY3RcIiwgZGVzYzogXCJFZGl0IHByb2plY3Qtc3BlY2lmaWMgd29ya2Zsb3cgbW9kZVwiIH0sXG4gICAgXSwgXCJtb2RlXCIpO1xuICB9XG5cbiAgaWYgKHBhcnRzWzBdID09PSBcInBhcmFsbGVsXCIgJiYgcGFydHMubGVuZ3RoIDw9IDIpIHtcbiAgICByZXR1cm4gZmlsdGVyU3RhcnRzV2l0aChwYXJ0aWFsLCBbXG4gICAgICB7IGNtZDogXCJzdGFydFwiLCBkZXNjOiBcIlN0YXJ0IHBhcmFsbGVsIG1pbGVzdG9uZSBvcmNoZXN0cmF0aW9uXCIgfSxcbiAgICAgIHsgY21kOiBcInN0YXR1c1wiLCBkZXNjOiBcIlNob3cgcGFyYWxsZWwgd29ya2VyIHN0YXR1c2VzXCIgfSxcbiAgICAgIHsgY21kOiBcInN0b3BcIiwgZGVzYzogXCJTdG9wIGFsbCBwYXJhbGxlbCB3b3JrZXJzXCIgfSxcbiAgICAgIHsgY21kOiBcInBhdXNlXCIsIGRlc2M6IFwiUGF1c2UgYSBzcGVjaWZpYyB3b3JrZXJcIiB9LFxuICAgICAgeyBjbWQ6IFwicmVzdW1lXCIsIGRlc2M6IFwiUmVzdW1lIGEgcGF1c2VkIHdvcmtlclwiIH0sXG4gICAgICB7IGNtZDogXCJtZXJnZVwiLCBkZXNjOiBcIk1lcmdlIGNvbXBsZXRlZCBtaWxlc3RvbmUgYnJhbmNoZXNcIiB9LFxuICAgIF0sIFwicGFyYWxsZWxcIik7XG4gIH1cblxuICBpZiAocGFydHNbMF0gPT09IFwic2V0dXBcIiAmJiBwYXJ0cy5sZW5ndGggPD0gMikge1xuICAgIHJldHVybiBmaWx0ZXJTdGFydHNXaXRoKHBhcnRpYWwsIFtcbiAgICAgIHsgY21kOiBcImxsbVwiLCBkZXNjOiBcIkNvbmZpZ3VyZSBMTE0gcHJvdmlkZXIgc2V0dGluZ3NcIiB9LFxuICAgICAgeyBjbWQ6IFwic2VhcmNoXCIsIGRlc2M6IFwiQ29uZmlndXJlIHdlYiBzZWFyY2ggcHJvdmlkZXJcIiB9LFxuICAgICAgeyBjbWQ6IFwicmVtb3RlXCIsIGRlc2M6IFwiQ29uZmlndXJlIHJlbW90ZSBpbnRlZ3JhdGlvbnNcIiB9LFxuICAgICAgeyBjbWQ6IFwia2V5c1wiLCBkZXNjOiBcIk1hbmFnZSBBUEkga2V5c1wiIH0sXG4gICAgICB7IGNtZDogXCJwcmVmc1wiLCBkZXNjOiBcIkNvbmZpZ3VyZSBnbG9iYWwgcHJlZmVyZW5jZXNcIiB9LFxuICAgIF0sIFwic2V0dXBcIik7XG4gIH1cblxuICBpZiAocGFydHNbMF0gPT09IFwibG9nc1wiICYmIHBhcnRzLmxlbmd0aCA8PSAyKSB7XG4gICAgcmV0dXJuIGZpbHRlclN0YXJ0c1dpdGgocGFydGlhbCwgW1xuICAgICAgeyBjbWQ6IFwiZGVidWdcIiwgZGVzYzogXCJMaXN0IG9yIHZpZXcgZGVidWcgbG9nIGZpbGVzXCIgfSxcbiAgICAgIHsgY21kOiBcInRhaWxcIiwgZGVzYzogXCJTaG93IGxhc3QgTiBhY3Rpdml0eSBsb2cgc3VtbWFyaWVzXCIgfSxcbiAgICAgIHsgY21kOiBcImNsZWFyXCIsIGRlc2M6IFwiUmVtb3ZlIG9sZCBhY3Rpdml0eSBhbmQgZGVidWcgbG9nc1wiIH0sXG4gICAgXSwgXCJsb2dzXCIpO1xuICB9XG5cbiAgaWYgKHBhcnRzWzBdID09PSBcImtleXNcIiAmJiBwYXJ0cy5sZW5ndGggPD0gMikge1xuICAgIHJldHVybiBmaWx0ZXJTdGFydHNXaXRoKHBhcnRpYWwsIFtcbiAgICAgIHsgY21kOiBcImxpc3RcIiwgZGVzYzogXCJTaG93IGtleSBzdGF0dXMgZGFzaGJvYXJkXCIgfSxcbiAgICAgIHsgY21kOiBcImFkZFwiLCBkZXNjOiBcIkFkZCBhIGtleSBmb3IgYSBwcm92aWRlclwiIH0sXG4gICAgICB7IGNtZDogXCJyZW1vdmVcIiwgZGVzYzogXCJSZW1vdmUgYSBrZXlcIiB9LFxuICAgICAgeyBjbWQ6IFwidGVzdFwiLCBkZXNjOiBcIlZhbGlkYXRlIGtleShzKSB3aXRoIEFQSSBjYWxsXCIgfSxcbiAgICAgIHsgY21kOiBcInJvdGF0ZVwiLCBkZXNjOiBcIlJlcGxhY2UgYW4gZXhpc3Rpbmcga2V5XCIgfSxcbiAgICAgIHsgY21kOiBcImRvY3RvclwiLCBkZXNjOiBcIkhlYWx0aCBjaGVjayBhbGwga2V5c1wiIH0sXG4gICAgXSwgXCJrZXlzXCIpO1xuICB9XG5cbiAgaWYgKHBhcnRzWzBdID09PSBcInByZWZzXCIgJiYgcGFydHMubGVuZ3RoIDw9IDIpIHtcbiAgICByZXR1cm4gZmlsdGVyU3RhcnRzV2l0aChwYXJ0aWFsLCBbXG4gICAgICB7IGNtZDogXCJnbG9iYWxcIiwgZGVzYzogXCJFZGl0IGdsb2JhbCBwcmVmZXJlbmNlcyBmaWxlXCIgfSxcbiAgICAgIHsgY21kOiBcInByb2plY3RcIiwgZGVzYzogXCJFZGl0IHByb2plY3QgcHJlZmVyZW5jZXMgZmlsZVwiIH0sXG4gICAgICB7IGNtZDogXCJzdGF0dXNcIiwgZGVzYzogXCJTaG93IGVmZmVjdGl2ZSBwcmVmZXJlbmNlc1wiIH0sXG4gICAgICB7IGNtZDogXCJ3aXphcmRcIiwgZGVzYzogXCJJbnRlcmFjdGl2ZSBwcmVmZXJlbmNlcyB3aXphcmRcIiB9LFxuICAgICAgeyBjbWQ6IFwic2V0dXBcIiwgZGVzYzogXCJGaXJzdC10aW1lIHByZWZlcmVuY2VzIHNldHVwXCIgfSxcbiAgICAgIHsgY21kOiBcImltcG9ydC1jbGF1ZGVcIiwgZGVzYzogXCJJbXBvcnQgc2V0dGluZ3MgZnJvbSBDbGF1ZGUgQ29kZVwiIH0sXG4gICAgXSwgXCJwcmVmc1wiKTtcbiAgfVxuXG4gIGlmIChwYXJ0c1swXSA9PT0gXCJyZW1vdGVcIiAmJiBwYXJ0cy5sZW5ndGggPD0gMikge1xuICAgIHJldHVybiBmaWx0ZXJTdGFydHNXaXRoKHBhcnRpYWwsIFtcbiAgICAgIHsgY21kOiBcInNsYWNrXCIsIGRlc2M6IFwiQ29uZmlndXJlIFNsYWNrIGludGVncmF0aW9uXCIgfSxcbiAgICAgIHsgY21kOiBcImRpc2NvcmRcIiwgZGVzYzogXCJDb25maWd1cmUgRGlzY29yZCBpbnRlZ3JhdGlvblwiIH0sXG4gICAgICB7IGNtZDogXCJzdGF0dXNcIiwgZGVzYzogXCJTaG93IHJlbW90ZSBjb25uZWN0aW9uIHN0YXR1c1wiIH0sXG4gICAgICB7IGNtZDogXCJkaXNjb25uZWN0XCIsIGRlc2M6IFwiRGlzY29ubmVjdCByZW1vdGUgaW50ZWdyYXRpb25zXCIgfSxcbiAgICBdLCBcInJlbW90ZVwiKTtcbiAgfVxuXG4gIGlmIChwYXJ0c1swXSA9PT0gXCJoaXN0b3J5XCIgJiYgcGFydHMubGVuZ3RoIDw9IDIpIHtcbiAgICByZXR1cm4gZmlsdGVyU3RhcnRzV2l0aChwYXJ0aWFsLCBbXG4gICAgICB7IGNtZDogXCItLWNvc3RcIiwgZGVzYzogXCJTaG93IGNvc3QgYnJlYWtkb3duIHBlciBlbnRyeVwiIH0sXG4gICAgICB7IGNtZDogXCItLXBoYXNlXCIsIGRlc2M6IFwiRmlsdGVyIGJ5IHBoYXNlIHR5cGVcIiB9LFxuICAgICAgeyBjbWQ6IFwiLS1tb2RlbFwiLCBkZXNjOiBcIkZpbHRlciBieSBtb2RlbCB1c2VkXCIgfSxcbiAgICAgIHsgY21kOiBcIjEwXCIsIGRlc2M6IFwiU2hvdyBsYXN0IDEwIGVudHJpZXNcIiB9LFxuICAgICAgeyBjbWQ6IFwiMjBcIiwgZGVzYzogXCJTaG93IGxhc3QgMjAgZW50cmllc1wiIH0sXG4gICAgICB7IGNtZDogXCI1MFwiLCBkZXNjOiBcIlNob3cgbGFzdCA1MCBlbnRyaWVzXCIgfSxcbiAgICBdLCBcImhpc3RvcnlcIik7XG4gIH1cblxuICBpZiAocGFydHNbMF0gPT09IFwiZXhwb3J0XCIgJiYgcGFydHMubGVuZ3RoIDw9IDIpIHtcbiAgICByZXR1cm4gZmlsdGVyU3RhcnRzV2l0aChwYXJ0aWFsLCBbXG4gICAgICB7IGNtZDogXCItLWpzb25cIiwgZGVzYzogXCJFeHBvcnQgYXMgSlNPTlwiIH0sXG4gICAgICB7IGNtZDogXCItLW1hcmtkb3duXCIsIGRlc2M6IFwiRXhwb3J0IGFzIE1hcmtkb3duXCIgfSxcbiAgICAgIHsgY21kOiBcIi0taHRtbFwiLCBkZXNjOiBcIkV4cG9ydCBhcyBIVE1MXCIgfSxcbiAgICAgIHsgY21kOiBcIi0taHRtbCAtLWFsbFwiLCBkZXNjOiBcIkV4cG9ydCBhbGwgbWlsZXN0b25lcyBhcyBIVE1MXCIgfSxcbiAgICBdLCBcImV4cG9ydFwiKTtcbiAgfVxuXG4gIGlmIChwYXJ0c1swXSA9PT0gXCJjbGVhbnVwXCIgJiYgcGFydHMubGVuZ3RoIDw9IDIpIHtcbiAgICByZXR1cm4gZmlsdGVyU3RhcnRzV2l0aChwYXJ0aWFsLCBbXG4gICAgICB7IGNtZDogXCJicmFuY2hlc1wiLCBkZXNjOiBcIlJlbW92ZSBtZXJnZWQgbWlsZXN0b25lIGJyYW5jaGVzXCIgfSxcbiAgICAgIHsgY21kOiBcInNuYXBzaG90c1wiLCBkZXNjOiBcIlJlbW92ZSBvbGQgZXhlY3V0aW9uIHNuYXBzaG90c1wiIH0sXG4gICAgXSwgXCJjbGVhbnVwXCIpO1xuICB9XG5cbiAgaWYgKHBhcnRzWzBdID09PSBcImtub3dsZWRnZVwiICYmIHBhcnRzLmxlbmd0aCA8PSAyKSB7XG4gICAgcmV0dXJuIGZpbHRlclN0YXJ0c1dpdGgocGFydGlhbCwgW1xuICAgICAgeyBjbWQ6IFwicnVsZVwiLCBkZXNjOiBcIkFkZCBhIHByb2plY3QgcnVsZVwiIH0sXG4gICAgICB7IGNtZDogXCJwYXR0ZXJuXCIsIGRlc2M6IFwiQWRkIGEgY29kZSBwYXR0ZXJuXCIgfSxcbiAgICAgIHsgY21kOiBcImxlc3NvblwiLCBkZXNjOiBcIlJlY29yZCBhIGxlc3NvbiBsZWFybmVkXCIgfSxcbiAgICBdLCBcImtub3dsZWRnZVwiKTtcbiAgfVxuXG4gIGlmIChwYXJ0c1swXSA9PT0gXCJzdGFydFwiICYmIHBhcnRzLmxlbmd0aCA8PSAyKSB7XG4gICAgcmV0dXJuIGZpbHRlclN0YXJ0c1dpdGgocGFydGlhbCwgW1xuICAgICAgeyBjbWQ6IFwiYnVnZml4XCIsIGRlc2M6IFwiVHJpYWdlLCBmaXgsIHRlc3QsIGFuZCBzaGlwIGEgYnVnIGZpeFwiIH0sXG4gICAgICB7IGNtZDogXCJzbWFsbC1mZWF0dXJlXCIsIGRlc2M6IFwiTGlnaHR3ZWlnaHQgZmVhdHVyZSB3aXRoIG9wdGlvbmFsIGRpc2N1c3Npb25cIiB9LFxuICAgICAgeyBjbWQ6IFwic3Bpa2VcIiwgZGVzYzogXCJSZXNlYXJjaCwgcHJvdG90eXBlLCBhbmQgZG9jdW1lbnQgZmluZGluZ3NcIiB9LFxuICAgICAgeyBjbWQ6IFwiaG90Zml4XCIsIGRlc2M6IFwiTWluaW1hbDogZml4IGl0LCB0ZXN0IGl0LCBzaGlwIGl0XCIgfSxcbiAgICAgIHsgY21kOiBcInJlZmFjdG9yXCIsIGRlc2M6IFwiSW52ZW50b3J5LCBwbGFuIHdhdmVzLCBtaWdyYXRlLCB2ZXJpZnlcIiB9LFxuICAgICAgeyBjbWQ6IFwic2VjdXJpdHktYXVkaXRcIiwgZGVzYzogXCJTY2FuLCB0cmlhZ2UsIHJlbWVkaWF0ZSwgcmUtc2NhblwiIH0sXG4gICAgICB7IGNtZDogXCJkZXAtdXBncmFkZVwiLCBkZXNjOiBcIkFzc2VzcywgdXBncmFkZSwgZml4IGJyZWFrcywgdmVyaWZ5XCIgfSxcbiAgICAgIHsgY21kOiBcImZ1bGwtcHJvamVjdFwiLCBkZXNjOiBcIkNvbXBsZXRlIEdTRCB3b3JrZmxvdyB3aXRoIGZ1bGwgY2VyZW1vbnlcIiB9LFxuICAgICAgeyBjbWQ6IFwicmVzdW1lXCIsIGRlc2M6IFwiUmVzdW1lIGFuIGluLXByb2dyZXNzIHdvcmtmbG93XCIgfSxcbiAgICAgIHsgY21kOiBcIi0tbGlzdFwiLCBkZXNjOiBcIkxpc3QgYWxsIGF2YWlsYWJsZSB0ZW1wbGF0ZXNcIiB9LFxuICAgICAgeyBjbWQ6IFwiLS1kcnktcnVuXCIsIGRlc2M6IFwiUHJldmlldyB3b3JrZmxvdyB3aXRob3V0IGV4ZWN1dGluZ1wiIH0sXG4gICAgXSwgXCJzdGFydFwiKTtcbiAgfVxuXG4gIGlmIChwYXJ0c1swXSA9PT0gXCJ0ZW1wbGF0ZXNcIiAmJiBwYXJ0cy5sZW5ndGggPD0gMikge1xuICAgIHJldHVybiBmaWx0ZXJTdGFydHNXaXRoKHBhcnRpYWwsIFtcbiAgICAgIHsgY21kOiBcImluZm9cIiwgZGVzYzogXCJTaG93IGRldGFpbGVkIHRlbXBsYXRlIGluZm9cIiB9LFxuICAgIF0sIFwidGVtcGxhdGVzXCIpO1xuICB9XG5cbiAgaWYgKHBhcnRzWzBdID09PSBcImV4dGVuc2lvbnNcIiAmJiBwYXJ0cy5sZW5ndGggPD0gMikge1xuICAgIHJldHVybiBmaWx0ZXJTdGFydHNXaXRoKHBhcnRpYWwsIFtcbiAgICAgIHsgY21kOiBcImxpc3RcIiwgZGVzYzogXCJMaXN0IGFsbCBleHRlbnNpb25zIGFuZCB0aGVpciBzdGF0dXNcIiB9LFxuICAgICAgeyBjbWQ6IFwiZW5hYmxlXCIsIGRlc2M6IFwiRW5hYmxlIGEgZGlzYWJsZWQgZXh0ZW5zaW9uXCIgfSxcbiAgICAgIHsgY21kOiBcImRpc2FibGVcIiwgZGVzYzogXCJEaXNhYmxlIGFuIGV4dGVuc2lvblwiIH0sXG4gICAgICB7IGNtZDogXCJpbmZvXCIsIGRlc2M6IFwiU2hvdyBleHRlbnNpb24gZGV0YWlsc1wiIH0sXG4gICAgXSwgXCJleHRlbnNpb25zXCIpO1xuICB9XG5cbiAgaWYgKHBhcnRzWzBdID09PSBcImNvZGViYXNlXCIgJiYgcGFydHMubGVuZ3RoIDw9IDIpIHtcbiAgICByZXR1cm4gZmlsdGVyU3RhcnRzV2l0aChwYXJ0aWFsLCBbXG4gICAgICB7IGNtZDogXCJnZW5lcmF0ZVwiLCBkZXNjOiBcIkdlbmVyYXRlIG9yIHJlZ2VuZXJhdGUgQ09ERUJBU0UubWRcIiB9LFxuICAgICAgeyBjbWQ6IFwidXBkYXRlXCIsIGRlc2M6IFwiUmVmcmVzaCB0aGUgQ09ERUJBU0UubWQgY2FjaGUgaW1tZWRpYXRlbHlcIiB9LFxuICAgICAgeyBjbWQ6IFwic3RhdHNcIiwgZGVzYzogXCJTaG93IGNvZGViYXNlLW1hcCBjb3ZlcmFnZSBhbmQgZ2VuZXJhdGlvbiB0aW1lXCIgfSxcbiAgICAgIHsgY21kOiBcImhlbHBcIiwgZGVzYzogXCJTaG93IHVzYWdlIGFuZCBzdWJjb21tYW5kc1wiIH0sXG4gICAgXSwgXCJjb2RlYmFzZVwiKTtcbiAgfVxuXG4gIGlmIChwYXJ0c1swXSA9PT0gXCJkb2N0b3JcIiAmJiBwYXJ0cy5sZW5ndGggPD0gMikge1xuICAgIHJldHVybiBmaWx0ZXJTdGFydHNXaXRoKHBhcnRpYWwsIFtcbiAgICAgIHsgY21kOiBcImZpeFwiLCBkZXNjOiBcIkF1dG8tZml4IGRldGVjdGVkIGlzc3Vlc1wiIH0sXG4gICAgICB7IGNtZDogXCJoZWFsXCIsIGRlc2M6IFwiQUktZHJpdmVuIGRlZXAgaGVhbGluZ1wiIH0sXG4gICAgICB7IGNtZDogXCJhdWRpdFwiLCBkZXNjOiBcIlJ1biBoZWFsdGggYXVkaXQgd2l0aG91dCBmaXhpbmdcIiB9LFxuICAgIF0sIFwiZG9jdG9yXCIpO1xuICB9XG5cbiAgaWYgKHBhcnRzWzBdID09PSBcImRpc3BhdGNoXCIgJiYgcGFydHMubGVuZ3RoIDw9IDIpIHtcbiAgICByZXR1cm4gZmlsdGVyU3RhcnRzV2l0aChwYXJ0aWFsLCBbXG4gICAgICB7IGNtZDogXCJyZXNlYXJjaFwiLCBkZXNjOiBcIlJ1biByZXNlYXJjaCBwaGFzZVwiIH0sXG4gICAgICB7IGNtZDogXCJwbGFuXCIsIGRlc2M6IFwiUnVuIHBsYW5uaW5nIHBoYXNlXCIgfSxcbiAgICAgIHsgY21kOiBcImV4ZWN1dGVcIiwgZGVzYzogXCJSdW4gZXhlY3V0aW9uIHBoYXNlXCIgfSxcbiAgICAgIHsgY21kOiBcImNvbXBsZXRlXCIsIGRlc2M6IFwiUnVuIGNvbXBsZXRpb24gcGhhc2VcIiB9LFxuICAgICAgeyBjbWQ6IFwicmVhc3Nlc3NcIiwgZGVzYzogXCJSZWFzc2VzcyBjdXJyZW50IHByb2dyZXNzXCIgfSxcbiAgICAgIHsgY21kOiBcInVhdFwiLCBkZXNjOiBcIlJ1biB1c2VyIGFjY2VwdGFuY2UgdGVzdGluZ1wiIH0sXG4gICAgICB7IGNtZDogXCJyZXBsYW5cIiwgZGVzYzogXCJSZXBsYW4gdGhlIGN1cnJlbnQgc2xpY2VcIiB9LFxuICAgIF0sIFwiZGlzcGF0Y2hcIik7XG4gIH1cblxuICByZXR1cm4gbnVsbDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVyTGF6eUdTRENvbW1hbmQocGk6IEV4dGVuc2lvbkFQSSk6IHZvaWQge1xuICBwaS5yZWdpc3RlckNvbW1hbmQoXCJnc2RcIiwge1xuICAgIGRlc2NyaXB0aW9uOiBcIkdTRCBcdTIwMTQgR2V0IFNoaXQgRG9uZVwiLFxuICAgIGdldEFyZ3VtZW50Q29tcGxldGlvbnM6IGdldEdzZEFyZ3VtZW50Q29tcGxldGlvbnMsXG4gICAgaGFuZGxlcjogYXN5bmMgKGFyZ3M6IHN0cmluZywgY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCkgPT4ge1xuICAgICAgY29uc3QgeyBoYW5kbGVHU0RDb21tYW5kIH0gPSBhd2FpdCBpbXBvcnRFeHRlbnNpb25Nb2R1bGU8dHlwZW9mIGltcG9ydChcIi4vY29tbWFuZHMuanNcIik+KGltcG9ydC5tZXRhLnVybCwgXCIuL2NvbW1hbmRzLmpzXCIpO1xuICAgICAgYXdhaXQgaGFuZGxlR1NEQ29tbWFuZChhcmdzLCBjdHgsIHBpKTtcbiAgICB9LFxuICB9KTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFNBQVMsNkJBQThFO0FBQ3ZGLFNBQVMsMEJBQTBCO0FBRW5DLE1BQU0sd0JBQXdCO0FBQUEsRUFDNUIsRUFBRSxLQUFLLFFBQVEsTUFBTSxrREFBa0Q7QUFBQSxFQUN2RSxFQUFFLEtBQUssUUFBUSxNQUFNLG9DQUFvQztBQUFBLEVBQ3pELEVBQUUsS0FBSyxRQUFRLE1BQU0saUVBQTREO0FBQUEsRUFDakYsRUFBRSxLQUFLLFFBQVEsTUFBTSw0QkFBNEI7QUFBQSxFQUNqRCxFQUFFLEtBQUssU0FBUyxNQUFNLHlEQUF5RDtBQUFBLEVBQy9FLEVBQUUsS0FBSyxVQUFVLE1BQU0scUJBQXFCO0FBQUEsRUFDNUMsRUFBRSxLQUFLLGFBQWEsTUFBTSwyQkFBMkI7QUFBQSxFQUNyRCxFQUFFLEtBQUssU0FBUyxNQUFNLCtCQUErQjtBQUFBLEVBQ3JELEVBQUUsS0FBSyxTQUFT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
