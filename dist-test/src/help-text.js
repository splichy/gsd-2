const SUBCOMMAND_HELP = {
  config: [
    "Usage: gsd config",
    "",
    "Re-run the interactive setup wizard to configure:",
    "  - LLM provider (Anthropic, OpenAI, Google, OpenRouter, Ollama, LM Studio, etc.)",
    "  - Web search provider (Brave, Tavily, built-in)",
    "  - Remote questions (Discord, Slack, Telegram)",
    "  - Tool API keys (Context7, Jina, Groq)",
    "",
    "All steps are skippable and can be changed later with /login or /search-provider.",
    "",
    "For detailed provider setup instructions (OpenRouter, Ollama, LM Studio, vLLM,",
    "and other OpenAI-compatible endpoints), see docs/providers.md."
  ].join("\n"),
  update: [
    "Usage: gsd update",
    "",
    "Update GSD to the latest version.",
    "",
    "Equivalent to: npm install -g gsd-pi@latest"
  ].join("\n"),
  sessions: [
    "Usage: gsd sessions",
    "",
    "List all saved sessions for the current directory and interactively",
    "pick one to resume. Shows date, message count, and a preview of the",
    "first message for each session.",
    "",
    "Sessions are stored per-directory, so you only see sessions that were",
    "started from the current working directory.",
    "",
    "Compare with --continue (-c) which always resumes the most recent session."
  ].join("\n"),
  install: [
    "Usage: gsd install <source> [-l, --local]",
    "",
    "Install a package/extension source and run post-install validation (dependency checks, setup).",
    "",
    "Examples:",
    "  gsd install npm:@foo/bar",
    "  gsd install git:github.com/user/repo",
    "  gsd install https://github.com/user/repo",
    "  gsd install ./local/path"
  ].join("\n"),
  remove: [
    "Usage: gsd remove <source> [-l, --local]",
    "",
    "Remove an installed package source and its settings entry."
  ].join("\n"),
  list: [
    "Usage: gsd list",
    "",
    "List installed package sources from user and project settings."
  ].join("\n"),
  worktree: [
    "Usage: gsd worktree <command> [args]",
    "",
    "Manage isolated git worktrees for parallel work streams.",
    "",
    "Commands:",
    "  list                 List worktrees with status (files changed, commits, dirty)",
    "  merge [name]         Squash-merge a worktree into main and clean up",
    "  clean                Remove all worktrees that have been merged or are empty",
    "  remove <name>        Remove a worktree (--force to remove with unmerged changes)",
    "",
    "The -w flag creates/resumes worktrees for interactive sessions:",
    "  gsd -w               Auto-name a new worktree, or resume the only active one",
    "  gsd -w my-feature    Create or resume a named worktree",
    "",
    "Lifecycle:",
    "  1. gsd -w             Create worktree, start session inside it",
    "  2. (work normally)    All changes happen on the worktree branch",
    "  3. Ctrl+C             Exit \u2014 dirty work is auto-committed",
    "  4. gsd -w             Resume where you left off",
    "  5. gsd worktree merge Squash-merge into main when done",
    "",
    "Examples:",
    "  gsd -w                              Start in a new auto-named worktree",
    '  gsd -w auth-refactor                Create/resume "auth-refactor" worktree',
    "  gsd worktree list                   See all worktrees and their status",
    "  gsd worktree merge auth-refactor    Merge and clean up",
    "  gsd worktree clean                  Remove all merged/empty worktrees",
    "  gsd worktree remove old-branch      Remove a specific worktree",
    "  gsd worktree remove old-branch --force  Remove even with unmerged changes"
  ].join("\n"),
  graph: [
    "Usage: gsd graph <subcommand> [options]",
    "",
    "Manage the GSD project knowledge graph. Reads .gsd/ artifacts and builds",
    "a queryable graph of milestones, slices, tasks, rules, patterns, and lessons.",
    "",
    "Subcommands:",
    "  build   Parse .gsd/ artifacts (STATE.md, milestone ROADMAPs, slice PLANs,",
    "          KNOWLEDGE.md) and write .gsd/graphs/graph.json atomically.",
    "  query   Search graph nodes by term (BFS from seed matches, budget-trimmed).",
    "          Returns matching nodes and reachable edges within the token budget.",
    "  status  Show whether graph.json exists, its age, node/edge counts, and",
    "          whether it is stale (built more than 24 hours ago).",
    "  diff    Compare current graph.json with .last-build-snapshot.json.",
    "          Returns added, removed, and changed nodes and edges.",
    "",
    "Examples:",
    "  gsd graph build                        Build the graph from .gsd/ artifacts",
    "  gsd graph status                       Check graph age and node/edge counts",
    '  gsd graph query auth                   Find nodes related to "auth"',
    "  gsd graph diff                         Show changes since last snapshot"
  ].join("\n"),
  headless: [
    "Usage: gsd headless [flags] [command] [args...]",
    "",
    "Run /gsd commands without the TUI. Default command: auto",
    "",
    "Flags:",
    "  --timeout N            Overall timeout in ms (default: 300000)",
    "  --json                 JSONL event stream to stdout (alias for --output-format stream-json)",
    "  --output-format <fmt>  Output format: text (default), json (structured result), stream-json (JSONL events)",
    "  --bare                 Minimal context: skip CLAUDE.md, AGENTS.md, user settings, user skills",
    "  --resume <id>          Resume a prior headless session by ID",
    "  --model ID             Override model",
    "  --supervised           Forward interactive UI requests to orchestrator via stdout/stdin",
    "  --response-timeout N   Timeout (ms) for orchestrator response (default: 30000)",
    "  --answers <path>       Pre-supply answers and secrets (JSON file)",
    "  --events <types>       Filter JSONL output to specific event types (comma-separated)",
    "",
    "Commands:",
    "  auto                 Run all queued units continuously (default)",
    "  next                 Run one unit",
    "  status               Show progress dashboard",
    "  new-milestone        Create a milestone from a specification document",
    "  query                JSON snapshot: state + next dispatch + costs (no LLM)",
    "",
    "new-milestone flags:",
    "  --context <path>     Path to spec/PRD file (use '-' for stdin)",
    "  --context-text <txt> Inline specification text",
    "  --auto               Start auto-mode after milestone creation",
    "  --verbose            Show tool calls in progress output",
    "",
    "Output formats:",
    "  text         Human-readable progress on stderr (default)",
    "  json         Collect events silently, emit structured HeadlessJsonResult on stdout at exit",
    "  stream-json  Stream JSONL events to stdout in real time (same as --json)",
    "",
    "Examples:",
    "  gsd headless                                    Run /gsd auto",
    "  gsd headless next                               Run one unit",
    "  gsd headless --output-format json auto           Structured JSON result on stdout",
    "  gsd headless --json status                      Machine-readable JSONL stream",
    "  gsd headless --timeout 60000                    With 1-minute timeout",
    "  gsd headless --bare auto                        Minimal context (CI/ecosystem use)",
    "  gsd headless --resume abc123 auto               Resume a prior session",
    "  gsd headless new-milestone --context spec.md    Create milestone from file",
    "  cat spec.md | gsd headless new-milestone --context -   From stdin",
    "  gsd headless new-milestone --context spec.md --auto    Create + auto-execute",
    "  gsd headless --supervised auto                     Supervised orchestrator mode",
    "  gsd headless --answers answers.json auto              With pre-supplied answers",
    "  gsd headless --events agent_end,extension_ui_request auto   Filtered event stream",
    "  gsd headless query                              Instant JSON state snapshot",
    "  gsd headless recover                            Reset hierarchy + validation/gates, then rebuild from markdown",
    "",
    "Exit codes: 0 = success, 1 = error/timeout, 10 = blocked, 11 = cancelled"
  ].join("\n")
};
SUBCOMMAND_HELP["wt"] = SUBCOMMAND_HELP["worktree"];
function printHelp(version) {
  process.stdout.write(`GSD v${version} \u2014 Get Shit Done

`);
  process.stdout.write("Usage: gsd [options] [message...]\n\n");
  process.stdout.write("Options:\n");
  process.stdout.write("  --mode <text|json|rpc|mcp> Output mode (default: interactive)\n");
  process.stdout.write("  --print, -p              Single-shot print mode\n");
  process.stdout.write("  --continue, -c           Resume the most recent session\n");
  process.stdout.write("  --worktree, -w [name]    Start in an isolated worktree (auto-named if omitted)\n");
  process.stdout.write("  --model <id>             Override model (e.g. provider/model-id)\n");
  process.stdout.write("  --no-session             Disable session persistence\n");
  process.stdout.write("  --extension <path>       Load additional extension\n");
  process.stdout.write("  --tools <a,b,c>          Restrict available tools\n");
  process.stdout.write("  --list-models [search]   List available models and exit\n");
  process.stdout.write("  --version, -v            Print version and exit\n");
  process.stdout.write("  --help, -h               Print this help and exit\n");
  process.stdout.write("\nSubcommands:\n");
  process.stdout.write("  config                   Re-run the setup wizard\n");
  process.stdout.write("  install <source>         Install a package/extension source\n");
  process.stdout.write("  remove <source>          Remove an installed package source\n");
  process.stdout.write("  list                     List installed package sources\n");
  process.stdout.write("  update                   Update GSD to the latest version\n");
  process.stdout.write("  sessions                 List and resume a past session\n");
  process.stdout.write("  worktree <cmd>           Manage worktrees (list, merge, clean, remove)\n");
  process.stdout.write("  auto [args]              Run auto-mode without TUI (pipeable)\n");
  process.stdout.write("  headless [cmd] [args]    Run /gsd commands without TUI (default: auto)\n");
  process.stdout.write("  graph <subcommand>       Manage knowledge graph (build, query, status, diff)\n");
  process.stdout.write("\nRun gsd <subcommand> --help for subcommand-specific help.\n");
}
function printSubcommandHelp(subcommand, version) {
  const help = SUBCOMMAND_HELP[subcommand];
  if (!help) return false;
  process.stdout.write(`GSD v${version} \u2014 Get Shit Done

`);
  process.stdout.write(help + "\n");
  return true;
}
export {
  printHelp,
  printSubcommandHelp
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL2hlbHAtdGV4dC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiY29uc3QgU1VCQ09NTUFORF9IRUxQOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICBjb25maWc6IFtcbiAgICAnVXNhZ2U6IGdzZCBjb25maWcnLFxuICAgICcnLFxuICAgICdSZS1ydW4gdGhlIGludGVyYWN0aXZlIHNldHVwIHdpemFyZCB0byBjb25maWd1cmU6JyxcbiAgICAnICAtIExMTSBwcm92aWRlciAoQW50aHJvcGljLCBPcGVuQUksIEdvb2dsZSwgT3BlblJvdXRlciwgT2xsYW1hLCBMTSBTdHVkaW8sIGV0Yy4pJyxcbiAgICAnICAtIFdlYiBzZWFyY2ggcHJvdmlkZXIgKEJyYXZlLCBUYXZpbHksIGJ1aWx0LWluKScsXG4gICAgJyAgLSBSZW1vdGUgcXVlc3Rpb25zIChEaXNjb3JkLCBTbGFjaywgVGVsZWdyYW0pJyxcbiAgICAnICAtIFRvb2wgQVBJIGtleXMgKENvbnRleHQ3LCBKaW5hLCBHcm9xKScsXG4gICAgJycsXG4gICAgJ0FsbCBzdGVwcyBhcmUgc2tpcHBhYmxlIGFuZCBjYW4gYmUgY2hhbmdlZCBsYXRlciB3aXRoIC9sb2dpbiBvciAvc2VhcmNoLXByb3ZpZGVyLicsXG4gICAgJycsXG4gICAgJ0ZvciBkZXRhaWxlZCBwcm92aWRlciBzZXR1cCBpbnN0cnVjdGlvbnMgKE9wZW5Sb3V0ZXIsIE9sbGFtYSwgTE0gU3R1ZGlvLCB2TExNLCcsXG4gICAgJ2FuZCBvdGhlciBPcGVuQUktY29tcGF0aWJsZSBlbmRwb2ludHMpLCBzZWUgZG9jcy9wcm92aWRlcnMubWQuJyxcbiAgXS5qb2luKCdcXG4nKSxcblxuICB1cGRhdGU6IFtcbiAgICAnVXNhZ2U6IGdzZCB1cGRhdGUnLFxuICAgICcnLFxuICAgICdVcGRhdGUgR1NEIHRvIHRoZSBsYXRlc3QgdmVyc2lvbi4nLFxuICAgICcnLFxuICAgICdFcXVpdmFsZW50IHRvOiBucG0gaW5zdGFsbCAtZyBnc2QtcGlAbGF0ZXN0JyxcbiAgXS5qb2luKCdcXG4nKSxcblxuICBzZXNzaW9uczogW1xuICAgICdVc2FnZTogZ3NkIHNlc3Npb25zJyxcbiAgICAnJyxcbiAgICAnTGlzdCBhbGwgc2F2ZWQgc2Vzc2lvbnMgZm9yIHRoZSBjdXJyZW50IGRpcmVjdG9yeSBhbmQgaW50ZXJhY3RpdmVseScsXG4gICAgJ3BpY2sgb25lIHRvIHJlc3VtZS4gU2hvd3MgZGF0ZSwgbWVzc2FnZSBjb3VudCwgYW5kIGEgcHJldmlldyBvZiB0aGUnLFxuICAgICdmaXJzdCBtZXNzYWdlIGZvciBlYWNoIHNlc3Npb24uJyxcbiAgICAnJyxcbiAgICAnU2Vzc2lvbnMgYXJlIHN0b3JlZCBwZXItZGlyZWN0b3J5LCBzbyB5b3Ugb25seSBzZWUgc2Vzc2lvbnMgdGhhdCB3ZXJlJyxcbiAgICAnc3RhcnRlZCBmcm9tIHRoZSBjdXJyZW50IHdvcmtpbmcgZGlyZWN0b3J5LicsXG4gICAgJycsXG4gICAgJ0NvbXBhcmUgd2l0aCAtLWNvbnRpbnVlICgtYykgd2hpY2ggYWx3YXlzIHJlc3VtZXMgdGhlIG1vc3QgcmVjZW50IHNlc3Npb24uJyxcbiAgXS5qb2luKCdcXG4nKSxcblxuICBpbnN0YWxsOiBbXG4gICAgJ1VzYWdlOiBnc2QgaW5zdGFsbCA8c291cmNlPiBbLWwsIC0tbG9jYWxdJyxcbiAgICAnJyxcbiAgICAnSW5zdGFsbCBhIHBhY2thZ2UvZXh0ZW5zaW9uIHNvdXJjZSBhbmQgcnVuIHBvc3QtaW5zdGFsbCB2YWxpZGF0aW9uIChkZXBlbmRlbmN5IGNoZWNrcywgc2V0dXApLicsXG4gICAgJycsXG4gICAgJ0V4YW1wbGVzOicsXG4gICAgJyAgZ3NkIGluc3RhbGwgbnBtOkBmb28vYmFyJyxcbiAgICAnICBnc2QgaW5zdGFsbCBnaXQ6Z2l0aHViLmNvbS91c2VyL3JlcG8nLFxuICAgICcgIGdzZCBpbnN0YWxsIGh0dHBzOi8vZ2l0aHViLmNvbS91c2VyL3JlcG8nLFxuICAgICcgIGdzZCBpbnN0YWxsIC4vbG9jYWwvcGF0aCcsXG4gIF0uam9pbignXFxuJyksXG5cbiAgcmVtb3ZlOiBbXG4gICAgJ1VzYWdlOiBnc2QgcmVtb3ZlIDxzb3VyY2U+IFstbCwgLS1sb2NhbF0nLFxuICAgICcnLFxuICAgICdSZW1vdmUgYW4gaW5zdGFsbGVkIHBhY2thZ2Ugc291cmNlIGFuZCBpdHMgc2V0dGluZ3MgZW50cnkuJyxcbiAgXS5qb2luKCdcXG4nKSxcblxuICBsaXN0OiBbXG4gICAgJ1VzYWdlOiBnc2QgbGlzdCcsXG4gICAgJycsXG4gICAgJ0xpc3QgaW5zdGFsbGVkIHBhY2thZ2Ugc291cmNlcyBmcm9tIHVzZXIgYW5kIHByb2plY3Qgc2V0dGluZ3MuJyxcbiAgXS5qb2luKCdcXG4nKSxcblxuICB3b3JrdHJlZTogW1xuICAgICdVc2FnZTogZ3NkIHdvcmt0cmVlIDxjb21tYW5kPiBbYXJnc10nLFxuICAgICcnLFxuICAgICdNYW5hZ2UgaXNvbGF0ZWQgZ2l0IHdvcmt0cmVlcyBmb3IgcGFyYWxsZWwgd29yayBzdHJlYW1zLicsXG4gICAgJycsXG4gICAgJ0NvbW1hbmRzOicsXG4gICAgJyAgbGlzdCAgICAgICAgICAgICAgICAgTGlzdCB3b3JrdHJlZXMgd2l0aCBzdGF0dXMgKGZpbGVzIGNoYW5nZWQsIGNvbW1pdHMsIGRpcnR5KScsXG4gICAgJyAgbWVyZ2UgW25hbWVdICAgICAgICAgU3F1YXNoLW1lcmdlIGEgd29ya3RyZWUgaW50byBtYWluIGFuZCBjbGVhbiB1cCcsXG4gICAgJyAgY2xlYW4gICAgICAgICAgICAgICAgUmVtb3ZlIGFsbCB3b3JrdHJlZXMgdGhhdCBoYXZlIGJlZW4gbWVyZ2VkIG9yIGFyZSBlbXB0eScsXG4gICAgJyAgcmVtb3ZlIDxuYW1lPiAgICAgICAgUmVtb3ZlIGEgd29ya3RyZWUgKC0tZm9yY2UgdG8gcmVtb3ZlIHdpdGggdW5tZXJnZWQgY2hhbmdlcyknLFxuICAgICcnLFxuICAgICdUaGUgLXcgZmxhZyBjcmVhdGVzL3Jlc3VtZXMgd29ya3RyZWVzIGZvciBpbnRlcmFjdGl2ZSBzZXNzaW9uczonLFxuICAgICcgIGdzZCAtdyAgICAgICAgICAgICAgIEF1dG8tbmFtZSBhIG5ldyB3b3JrdHJlZSwgb3IgcmVzdW1lIHRoZSBvbmx5IGFjdGl2ZSBvbmUnLFxuICAgICcgIGdzZCAtdyBteS1mZWF0dXJlICAgIENyZWF0ZSBvciByZXN1bWUgYSBuYW1lZCB3b3JrdHJlZScsXG4gICAgJycsXG4gICAgJ0xpZmVjeWNsZTonLFxuICAgICcgIDEuIGdzZCAtdyAgICAgICAgICAgICBDcmVhdGUgd29ya3RyZWUsIHN0YXJ0IHNlc3Npb24gaW5zaWRlIGl0JyxcbiAgICAnICAyLiAod29yayBub3JtYWxseSkgICAgQWxsIGNoYW5nZXMgaGFwcGVuIG9uIHRoZSB3b3JrdHJlZSBicmFuY2gnLFxuICAgICcgIDMuIEN0cmwrQyAgICAgICAgICAgICBFeGl0IFx1MjAxNCBkaXJ0eSB3b3JrIGlzIGF1dG8tY29tbWl0dGVkJyxcbiAgICAnICA0LiBnc2QgLXcgICAgICAgICAgICAgUmVzdW1lIHdoZXJlIHlvdSBsZWZ0IG9mZicsXG4gICAgJyAgNS4gZ3NkIHdvcmt0cmVlIG1lcmdlIFNxdWFzaC1tZXJnZSBpbnRvIG1haW4gd2hlbiBkb25lJyxcbiAgICAnJyxcbiAgICAnRXhhbXBsZXM6JyxcbiAgICAnICBnc2QgLXcgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBTdGFydCBpbiBhIG5ldyBhdXRvLW5hbWVkIHdvcmt0cmVlJyxcbiAgICAnICBnc2QgLXcgYXV0aC1yZWZhY3RvciAgICAgICAgICAgICAgICBDcmVhdGUvcmVzdW1lIFwiYXV0aC1yZWZhY3RvclwiIHdvcmt0cmVlJyxcbiAgICAnICBnc2Qgd29ya3RyZWUgbGlzdCAgICAgICAgICAgICAgICAgICBTZWUgYWxsIHdvcmt0cmVlcyBhbmQgdGhlaXIgc3RhdHVzJyxcbiAgICAnICBnc2Qgd29ya3RyZWUgbWVyZ2UgYXV0aC1yZWZhY3RvciAgICBNZXJnZSBhbmQgY2xlYW4gdXAnLFxuICAgICcgIGdzZCB3b3JrdHJlZSBjbGVhbiAgICAgICAgICAgICAgICAgIFJlbW92ZSBhbGwgbWVyZ2VkL2VtcHR5IHdvcmt0cmVlcycsXG4gICAgJyAgZ3NkIHdvcmt0cmVlIHJlbW92ZSBvbGQtYnJhbmNoICAgICAgUmVtb3ZlIGEgc3BlY2lmaWMgd29ya3RyZWUnLFxuICAgICcgIGdzZCB3b3JrdHJlZSByZW1vdmUgb2xkLWJyYW5jaCAtLWZvcmNlICBSZW1vdmUgZXZlbiB3aXRoIHVubWVyZ2VkIGNoYW5nZXMnLFxuICBdLmpvaW4oJ1xcbicpLFxuXG4gIGdyYXBoOiBbXG4gICAgJ1VzYWdlOiBnc2QgZ3JhcGggPHN1YmNvbW1hbmQ+IFtvcHRpb25zXScsXG4gICAgJycsXG4gICAgJ01hbmFnZSB0aGUgR1NEIHByb2plY3Qga25vd2xlZGdlIGdyYXBoLiBSZWFkcyAuZ3NkLyBhcnRpZmFjdHMgYW5kIGJ1aWxkcycsXG4gICAgJ2EgcXVlcnlhYmxlIGdyYXBoIG9mIG1pbGVzdG9uZXMsIHNsaWNlcywgdGFza3MsIHJ1bGVzLCBwYXR0ZXJucywgYW5kIGxlc3NvbnMuJyxcbiAgICAnJyxcbiAgICAnU3ViY29tbWFuZHM6JyxcbiAgICAnICBidWlsZCAgIFBhcnNlIC5nc2QvIGFydGlmYWN0cyAoU1RBVEUubWQsIG1pbGVzdG9uZSBST0FETUFQcywgc2xpY2UgUExBTnMsJyxcbiAgICAnICAgICAgICAgIEtOT1dMRURHRS5tZCkgYW5kIHdyaXRlIC5nc2QvZ3JhcGhzL2dyYXBoLmpzb24gYXRvbWljYWxseS4nLFxuICAgICcgIHF1ZXJ5ICAgU2VhcmNoIGdyYXBoIG5vZGVzIGJ5IHRlcm0gKEJGUyBmcm9tIHNlZWQgbWF0Y2hlcywgYnVkZ2V0LXRyaW1tZWQpLicsXG4gICAgJyAgICAgICAgICBSZXR1cm5zIG1hdGNoaW5nIG5vZGVzIGFuZCByZWFjaGFibGUgZWRnZXMgd2l0aGluIHRoZSB0b2tlbiBidWRnZXQuJyxcbiAgICAnICBzdGF0dXMgIFNob3cgd2hldGhlciBncmFwaC5qc29uIGV4aXN0cywgaXRzIGFnZSwgbm9kZS9lZGdlIGNvdW50cywgYW5kJyxcbiAgICAnICAgICAgICAgIHdoZXRoZXIgaXQgaXMgc3RhbGUgKGJ1aWx0IG1vcmUgdGhhbiAyNCBob3VycyBhZ28pLicsXG4gICAgJyAgZGlmZiAgICBDb21wYXJlIGN1cnJlbnQgZ3JhcGguanNvbiB3aXRoIC5sYXN0LWJ1aWxkLXNuYXBzaG90Lmpzb24uJyxcbiAgICAnICAgICAgICAgIFJldHVybnMgYWRkZWQsIHJlbW92ZWQsIGFuZCBjaGFuZ2VkIG5vZGVzIGFuZCBlZGdlcy4nLFxuICAgICcnLFxuICAgICdFeGFtcGxlczonLFxuICAgICcgIGdzZCBncmFwaCBidWlsZCAgICAgICAgICAgICAgICAgICAgICAgIEJ1aWxkIHRoZSBncmFwaCBmcm9tIC5nc2QvIGFydGlmYWN0cycsXG4gICAgJyAgZ3NkIGdyYXBoIHN0YXR1cyAgICAgICAgICAgICAgICAgICAgICAgQ2hlY2sgZ3JhcGggYWdlIGFuZCBub2RlL2VkZ2UgY291bnRzJyxcbiAgICAnICBnc2QgZ3JhcGggcXVlcnkgYXV0aCAgICAgICAgICAgICAgICAgICBGaW5kIG5vZGVzIHJlbGF0ZWQgdG8gXCJhdXRoXCInLFxuICAgICcgIGdzZCBncmFwaCBkaWZmICAgICAgICAgICAgICAgICAgICAgICAgIFNob3cgY2hhbmdlcyBzaW5jZSBsYXN0IHNuYXBzaG90JyxcbiAgXS5qb2luKCdcXG4nKSxcblxuICBoZWFkbGVzczogW1xuICAgICdVc2FnZTogZ3NkIGhlYWRsZXNzIFtmbGFnc10gW2NvbW1hbmRdIFthcmdzLi4uXScsXG4gICAgJycsXG4gICAgJ1J1biAvZ3NkIGNvbW1hbmRzIHdpdGhvdXQgdGhlIFRVSS4gRGVmYXVsdCBjb21tYW5kOiBhdXRvJyxcbiAgICAnJyxcbiAgICAnRmxhZ3M6JyxcbiAgICAnICAtLXRpbWVvdXQgTiAgICAgICAgICAgIE92ZXJhbGwgdGltZW91dCBpbiBtcyAoZGVmYXVsdDogMzAwMDAwKScsXG4gICAgJyAgLS1qc29uICAgICAgICAgICAgICAgICBKU09OTCBldmVudCBzdHJlYW0gdG8gc3Rkb3V0IChhbGlhcyBmb3IgLS1vdXRwdXQtZm9ybWF0IHN0cmVhbS1qc29uKScsXG4gICAgJyAgLS1vdXRwdXQtZm9ybWF0IDxmbXQ+ICBPdXRwdXQgZm9ybWF0OiB0ZXh0IChkZWZhdWx0KSwganNvbiAoc3RydWN0dXJlZCByZXN1bHQpLCBzdHJlYW0tanNvbiAoSlNPTkwgZXZlbnRzKScsXG4gICAgJyAgLS1iYXJlICAgICAgICAgICAgICAgICBNaW5pbWFsIGNvbnRleHQ6IHNraXAgQ0xBVURFLm1kLCBBR0VOVFMubWQsIHVzZXIgc2V0dGluZ3MsIHVzZXIgc2tpbGxzJyxcbiAgICAnICAtLXJlc3VtZSA8aWQ+ICAgICAgICAgIFJlc3VtZSBhIHByaW9yIGhlYWRsZXNzIHNlc3Npb24gYnkgSUQnLFxuICAgICcgIC0tbW9kZWwgSUQgICAgICAgICAgICAgT3ZlcnJpZGUgbW9kZWwnLFxuICAgICcgIC0tc3VwZXJ2aXNlZCAgICAgICAgICAgRm9yd2FyZCBpbnRlcmFjdGl2ZSBVSSByZXF1ZXN0cyB0byBvcmNoZXN0cmF0b3IgdmlhIHN0ZG91dC9zdGRpbicsXG4gICAgJyAgLS1yZXNwb25zZS10aW1lb3V0IE4gICBUaW1lb3V0IChtcykgZm9yIG9yY2hlc3RyYXRvciByZXNwb25zZSAoZGVmYXVsdDogMzAwMDApJyxcbiAgICAnICAtLWFuc3dlcnMgPHBhdGg+ICAgICAgIFByZS1zdXBwbHkgYW5zd2VycyBhbmQgc2VjcmV0cyAoSlNPTiBmaWxlKScsXG4gICAgJyAgLS1ldmVudHMgPHR5cGVzPiAgICAgICBGaWx0ZXIgSlNPTkwgb3V0cHV0IHRvIHNwZWNpZmljIGV2ZW50IHR5cGVzIChjb21tYS1zZXBhcmF0ZWQpJyxcbiAgICAnJyxcbiAgICAnQ29tbWFuZHM6JyxcbiAgICAnICBhdXRvICAgICAgICAgICAgICAgICBSdW4gYWxsIHF1ZXVlZCB1bml0cyBjb250aW51b3VzbHkgKGRlZmF1bHQpJyxcbiAgICAnICBuZXh0ICAgICAgICAgICAgICAgICBSdW4gb25lIHVuaXQnLFxuICAgICcgIHN0YXR1cyAgICAgICAgICAgICAgIFNob3cgcHJvZ3Jlc3MgZGFzaGJvYXJkJyxcbiAgICAnICBuZXctbWlsZXN0b25lICAgICAgICBDcmVhdGUgYSBtaWxlc3RvbmUgZnJvbSBhIHNwZWNpZmljYXRpb24gZG9jdW1lbnQnLFxuICAgICcgIHF1ZXJ5ICAgICAgICAgICAgICAgIEpTT04gc25hcHNob3Q6IHN0YXRlICsgbmV4dCBkaXNwYXRjaCArIGNvc3RzIChubyBMTE0pJyxcbiAgICAnJyxcbiAgICAnbmV3LW1pbGVzdG9uZSBmbGFnczonLFxuICAgICcgIC0tY29udGV4dCA8cGF0aD4gICAgIFBhdGggdG8gc3BlYy9QUkQgZmlsZSAodXNlIFxcJy1cXCcgZm9yIHN0ZGluKScsXG4gICAgJyAgLS1jb250ZXh0LXRleHQgPHR4dD4gSW5saW5lIHNwZWNpZmljYXRpb24gdGV4dCcsXG4gICAgJyAgLS1hdXRvICAgICAgICAgICAgICAgU3RhcnQgYXV0by1tb2RlIGFmdGVyIG1pbGVzdG9uZSBjcmVhdGlvbicsXG4gICAgJyAgLS12ZXJib3NlICAgICAgICAgICAgU2hvdyB0b29sIGNhbGxzIGluIHByb2dyZXNzIG91dHB1dCcsXG4gICAgJycsXG4gICAgJ091dHB1dCBmb3JtYXRzOicsXG4gICAgJyAgdGV4dCAgICAgICAgIEh1bWFuLXJlYWRhYmxlIHByb2dyZXNzIG9uIHN0ZGVyciAoZGVmYXVsdCknLFxuICAgICcgIGpzb24gICAgICAgICBDb2xsZWN0IGV2ZW50cyBzaWxlbnRseSwgZW1pdCBzdHJ1Y3R1cmVkIEhlYWRsZXNzSnNvblJlc3VsdCBvbiBzdGRvdXQgYXQgZXhpdCcsXG4gICAgJyAgc3RyZWFtLWpzb24gIFN0cmVhbSBKU09OTCBldmVudHMgdG8gc3Rkb3V0IGluIHJlYWwgdGltZSAoc2FtZSBhcyAtLWpzb24pJyxcbiAgICAnJyxcbiAgICAnRXhhbXBsZXM6JyxcbiAgICAnICBnc2QgaGVhZGxlc3MgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBSdW4gL2dzZCBhdXRvJyxcbiAgICAnICBnc2QgaGVhZGxlc3MgbmV4dCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBSdW4gb25lIHVuaXQnLFxuICAgICcgIGdzZCBoZWFkbGVzcyAtLW91dHB1dC1mb3JtYXQganNvbiBhdXRvICAgICAgICAgICBTdHJ1Y3R1cmVkIEpTT04gcmVzdWx0IG9uIHN0ZG91dCcsXG4gICAgJyAgZ3NkIGhlYWRsZXNzIC0tanNvbiBzdGF0dXMgICAgICAgICAgICAgICAgICAgICAgTWFjaGluZS1yZWFkYWJsZSBKU09OTCBzdHJlYW0nLFxuICAgICcgIGdzZCBoZWFkbGVzcyAtLXRpbWVvdXQgNjAwMDAgICAgICAgICAgICAgICAgICAgIFdpdGggMS1taW51dGUgdGltZW91dCcsXG4gICAgJyAgZ3NkIGhlYWRsZXNzIC0tYmFyZSBhdXRvICAgICAgICAgICAgICAgICAgICAgICAgTWluaW1hbCBjb250ZXh0IChDSS9lY29zeXN0ZW0gdXNlKScsXG4gICAgJyAgZ3NkIGhlYWRsZXNzIC0tcmVzdW1lIGFiYzEyMyBhdXRvICAgICAgICAgICAgICAgUmVzdW1lIGEgcHJpb3Igc2Vzc2lvbicsXG4gICAgJyAgZ3NkIGhlYWRsZXNzIG5ldy1taWxlc3RvbmUgLS1jb250ZXh0IHNwZWMubWQgICAgQ3JlYXRlIG1pbGVzdG9uZSBmcm9tIGZpbGUnLFxuICAgICcgIGNhdCBzcGVjLm1kIHwgZ3NkIGhlYWRsZXNzIG5ldy1taWxlc3RvbmUgLS1jb250ZXh0IC0gICBGcm9tIHN0ZGluJyxcbiAgICAnICBnc2QgaGVhZGxlc3MgbmV3LW1pbGVzdG9uZSAtLWNvbnRleHQgc3BlYy5tZCAtLWF1dG8gICAgQ3JlYXRlICsgYXV0by1leGVjdXRlJyxcbiAgICAnICBnc2QgaGVhZGxlc3MgLS1zdXBlcnZpc2VkIGF1dG8gICAgICAgICAgICAgICAgICAgICBTdXBlcnZpc2VkIG9yY2hlc3RyYXRvciBtb2RlJyxcbiAgICAnICBnc2QgaGVhZGxlc3MgLS1hbnN3ZXJzIGFuc3dlcnMuanNvbiBhdXRvICAgICAgICAgICAgICBXaXRoIHByZS1zdXBwbGllZCBhbnN3ZXJzJyxcbiAgICAnICBnc2QgaGVhZGxlc3MgLS1ldmVudHMgYWdlbnRfZW5kLGV4dGVuc2lvbl91aV9yZXF1ZXN0IGF1dG8gICBGaWx0ZXJlZCBldmVudCBzdHJlYW0nLFxuICAgICcgIGdzZCBoZWFkbGVzcyBxdWVyeSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIEluc3RhbnQgSlNPTiBzdGF0ZSBzbmFwc2hvdCcsXG4gICAgJyAgZ3NkIGhlYWRsZXNzIHJlY292ZXIgICAgICAgICAgICAgICAgICAgICAgICAgICAgUmVzZXQgaGllcmFyY2h5ICsgdmFsaWRhdGlvbi9nYXRlcywgdGhlbiByZWJ1aWxkIGZyb20gbWFya2Rvd24nLFxuICAgICcnLFxuICAgICdFeGl0IGNvZGVzOiAwID0gc3VjY2VzcywgMSA9IGVycm9yL3RpbWVvdXQsIDEwID0gYmxvY2tlZCwgMTEgPSBjYW5jZWxsZWQnLFxuICBdLmpvaW4oJ1xcbicpLFxufVxuXG4vLyBBbGlhczogYGdzZCB3dCAtLWhlbHBgIFx1MjE5MiBzYW1lIGFzIGBnc2Qgd29ya3RyZWUgLS1oZWxwYFxuU1VCQ09NTUFORF9IRUxQWyd3dCddID0gU1VCQ09NTUFORF9IRUxQWyd3b3JrdHJlZSddXG5cbmV4cG9ydCBmdW5jdGlvbiBwcmludEhlbHAodmVyc2lvbjogc3RyaW5nKTogdm9pZCB7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGBHU0QgdiR7dmVyc2lvbn0gXHUyMDE0IEdldCBTaGl0IERvbmVcXG5cXG5gKVxuICBwcm9jZXNzLnN0ZG91dC53cml0ZSgnVXNhZ2U6IGdzZCBbb3B0aW9uc10gW21lc3NhZ2UuLi5dXFxuXFxuJylcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoJ09wdGlvbnM6XFxuJylcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoJyAgLS1tb2RlIDx0ZXh0fGpzb258cnBjfG1jcD4gT3V0cHV0IG1vZGUgKGRlZmF1bHQ6IGludGVyYWN0aXZlKVxcbicpXG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKCcgIC0tcHJpbnQsIC1wICAgICAgICAgICAgICBTaW5nbGUtc2hvdCBwcmludCBtb2RlXFxuJylcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoJyAgLS1jb250aW51ZSwgLWMgICAgICAgICAgIFJlc3VtZSB0aGUgbW9zdCByZWNlbnQgc2Vzc2lvblxcbicpXG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKCcgIC0td29ya3RyZWUsIC13IFtuYW1lXSAgICBTdGFydCBpbiBhbiBpc29sYXRlZCB3b3JrdHJlZSAoYXV0by1uYW1lZCBpZiBvbWl0dGVkKVxcbicpXG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKCcgIC0tbW9kZWwgPGlkPiAgICAgICAgICAgICBPdmVycmlkZSBtb2RlbCAoZS5nLiBwcm92aWRlci9tb2RlbC1pZClcXG4nKVxuICBwcm9jZXNzLnN0ZG91dC53cml0ZSgnICAtLW5vLXNlc3Npb24gICAgICAgICAgICAgRGlzYWJsZSBzZXNzaW9uIHBlcnNpc3RlbmNlXFxuJylcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoJyAgLS1leHRlbnNpb24gPHBhdGg+ICAgICAgIExvYWQgYWRkaXRpb25hbCBleHRlbnNpb25cXG4nKVxuICBwcm9jZXNzLnN0ZG91dC53cml0ZSgnICAtLXRvb2xzIDxhLGIsYz4gICAgICAgICAgUmVzdHJpY3QgYXZhaWxhYmxlIHRvb2xzXFxuJylcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoJyAgLS1saXN0LW1vZGVscyBbc2VhcmNoXSAgIExpc3QgYXZhaWxhYmxlIG1vZGVscyBhbmQgZXhpdFxcbicpXG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKCcgIC0tdmVyc2lvbiwgLXYgICAgICAgICAgICBQcmludCB2ZXJzaW9uIGFuZCBleGl0XFxuJylcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoJyAgLS1oZWxwLCAtaCAgICAgICAgICAgICAgIFByaW50IHRoaXMgaGVscCBhbmQgZXhpdFxcbicpXG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKCdcXG5TdWJjb21tYW5kczpcXG4nKVxuICBwcm9jZXNzLnN0ZG91dC53cml0ZSgnICBjb25maWcgICAgICAgICAgICAgICAgICAgUmUtcnVuIHRoZSBzZXR1cCB3aXphcmRcXG4nKVxuICBwcm9jZXNzLnN0ZG91dC53cml0ZSgnICBpbnN0YWxsIDxzb3VyY2U+ICAgICAgICAgSW5zdGFsbCBhIHBhY2thZ2UvZXh0ZW5zaW9uIHNvdXJjZVxcbicpXG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKCcgIHJlbW92ZSA8c291cmNlPiAgICAgICAgICBSZW1vdmUgYW4gaW5zdGFsbGVkIHBhY2thZ2Ugc291cmNlXFxuJylcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoJyAgbGlzdCAgICAgICAgICAgICAgICAgICAgIExpc3QgaW5zdGFsbGVkIHBhY2thZ2Ugc291cmNlc1xcbicpXG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKCcgIHVwZGF0ZSAgICAgICAgICAgICAgICAgICBVcGRhdGUgR1NEIHRvIHRoZSBsYXRlc3QgdmVyc2lvblxcbicpXG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKCcgIHNlc3Npb25zICAgICAgICAgICAgICAgICBMaXN0IGFuZCByZXN1bWUgYSBwYXN0IHNlc3Npb25cXG4nKVxuICBwcm9jZXNzLnN0ZG91dC53cml0ZSgnICB3b3JrdHJlZSA8Y21kPiAgICAgICAgICAgTWFuYWdlIHdvcmt0cmVlcyAobGlzdCwgbWVyZ2UsIGNsZWFuLCByZW1vdmUpXFxuJylcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoJyAgYXV0byBbYXJnc10gICAgICAgICAgICAgIFJ1biBhdXRvLW1vZGUgd2l0aG91dCBUVUkgKHBpcGVhYmxlKVxcbicpXG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKCcgIGhlYWRsZXNzIFtjbWRdIFthcmdzXSAgICBSdW4gL2dzZCBjb21tYW5kcyB3aXRob3V0IFRVSSAoZGVmYXVsdDogYXV0bylcXG4nKVxuICBwcm9jZXNzLnN0ZG91dC53cml0ZSgnICBncmFwaCA8c3ViY29tbWFuZD4gICAgICAgTWFuYWdlIGtub3dsZWRnZSBncmFwaCAoYnVpbGQsIHF1ZXJ5LCBzdGF0dXMsIGRpZmYpXFxuJylcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoJ1xcblJ1biBnc2QgPHN1YmNvbW1hbmQ+IC0taGVscCBmb3Igc3ViY29tbWFuZC1zcGVjaWZpYyBoZWxwLlxcbicpXG59XG5cbmV4cG9ydCBmdW5jdGlvbiBwcmludFN1YmNvbW1hbmRIZWxwKHN1YmNvbW1hbmQ6IHN0cmluZywgdmVyc2lvbjogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IGhlbHAgPSBTVUJDT01NQU5EX0hFTFBbc3ViY29tbWFuZF1cbiAgaWYgKCFoZWxwKSByZXR1cm4gZmFsc2VcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYEdTRCB2JHt2ZXJzaW9ufSBcdTIwMTQgR2V0IFNoaXQgRG9uZVxcblxcbmApXG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGhlbHAgKyAnXFxuJylcbiAgcmV0dXJuIHRydWVcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLE1BQU0sa0JBQTBDO0FBQUEsRUFDOUMsUUFBUTtBQUFBLElBQ047QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLEVBQ0YsRUFBRSxLQUFLLElBQUk7QUFBQSxFQUVYLFFBQVE7QUFBQSxJQUNOO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLEVBQ0YsRUFBRSxLQUFLLElBQUk7QUFBQSxFQUVYLFVBQVU7QUFBQSxJQUNSO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsRUFDRixFQUFFLEtBQUssSUFBSTtBQUFBLEVBRVgsU0FBUztBQUFBLElBQ1A7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLEVBQ0YsRUFBRSxLQUFLLElBQUk7QUFBQSxFQUVYLFFBQVE7QUFBQSxJQUNOO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxFQUNGLEVBQUUsS0FBSyxJQUFJO0FBQUEsRUFFWCxNQUFNO0FBQUEsSUFDSjtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsRUFDRixFQUFFLEtBQUssSUFBSTtBQUFBLEVBRVgsVUFBVTtBQUFBLElBQ1I7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsRUFDRixFQUFFLEtBQUssSUFBSTtBQUFBLEVBRVgsT0FBTztBQUFBLElBQ0w7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsRUFDRixFQUFFLEtBQUssSUFBSTtBQUFBLEVBRVgsVUFBVTtBQUFBLElBQ1I7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxFQUNGLEVBQUUsS0FBSyxJQUFJO0FBQ2I7QUFHQSxnQkFBZ0IsSUFBSSxJQUFJLGdCQUFnQixVQUFVO0FBRTNDLFNBQVMsVUFBVSxTQUF1QjtBQUMvQyxVQUFRLE9BQU8sTUFBTSxRQUFRLE9BQU87QUFBQTtBQUFBLENBQXNCO0FBQzFELFVBQVEsT0FBTyxNQUFNLHVDQUF1QztBQUM1RCxVQUFRLE9BQU8sTUFBTSxZQUFZO0FBQ2pDLFVBQVEsT0FBTyxNQUFNLG1FQUFtRTtBQUN4RixVQUFRLE9BQU8sTUFBTSxxREFBcUQ7QUFDMUUsVUFBUSxPQUFPLE1BQU0sNkRBQTZEO0FBQ2xGLFVBQVEsT0FBTyxNQUFNLG9GQUFvRjtBQUN6RyxVQUFRLE9BQU8sTUFBTSxzRUFBc0U7QUFDM0YsVUFBUSxPQUFPLE1BQU0sMERBQTBEO0FBQy9FLFVBQVEsT0FBTyxNQUFNLHdEQUF3RDtBQUM3RSxVQUFRLE9BQU8sTUFBTSx1REFBdUQ7QUFDNUUsVUFBUSxPQUFPLE1BQU0sNkRBQTZEO0FBQ2xGLFVBQVEsT0FBTyxNQUFNLHFEQUFxRDtBQUMxRSxVQUFRLE9BQU8sTUFBTSx1REFBdUQ7QUFDNUUsVUFBUSxPQUFPLE1BQU0sa0JBQWtCO0FBQ3ZDLFVBQVEsT0FBTyxNQUFNLHNEQUFzRDtBQUMzRSxVQUFRLE9BQU8sTUFBTSxpRUFBaUU7QUFDdEYsVUFBUSxPQUFPLE1BQU0saUVBQWlFO0FBQ3RGLFVBQVEsT0FBTyxNQUFNLDZEQUE2RDtBQUNsRixVQUFRLE9BQU8sTUFBTSwrREFBK0Q7QUFDcEYsVUFBUSxPQUFPLE1BQU0sNkRBQTZEO0FBQ2xGLFVBQVEsT0FBTyxNQUFNLDRFQUE0RTtBQUNqRyxVQUFRLE9BQU8sTUFBTSxtRUFBbUU7QUFDeEYsVUFBUSxPQUFPLE1BQU0sNEVBQTRFO0FBQ2pHLFVBQVEsT0FBTyxNQUFNLGtGQUFrRjtBQUN2RyxVQUFRLE9BQU8sTUFBTSwrREFBK0Q7QUFDdEY7QUFFTyxTQUFTLG9CQUFvQixZQUFvQixTQUEwQjtBQUNoRixRQUFNLE9BQU8sZ0JBQWdCLFVBQVU7QUFDdkMsTUFBSSxDQUFDLEtBQU0sUUFBTztBQUNsQixVQUFRLE9BQU8sTUFBTSxRQUFRLE9BQU87QUFBQTtBQUFBLENBQXNCO0FBQzFELFVBQVEsT0FBTyxNQUFNLE9BQU8sSUFBSTtBQUNoQyxTQUFPO0FBQ1Q7IiwKICAibmFtZXMiOiBbXQp9Cg==
