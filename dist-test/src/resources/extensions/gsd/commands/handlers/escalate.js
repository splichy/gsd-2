import { projectRoot } from "../context.js";
import { getActiveMilestoneId } from "../../state.js";
import {
  readEscalationArtifact,
  formatEscalationForDisplay,
  resolveEscalation,
  listActionableEscalations,
  listAllEscalations
} from "../../escalation.js";
import { saveDecisionToDb } from "../../db-writer.js";
import { loadEffectiveGSDPreferences } from "../../preferences.js";
import { invalidateStateCache } from "../../state.js";
import { emitUokAuditEvent, buildAuditEnvelope } from "../../uok/audit.js";
function helpMessage() {
  return [
    "/gsd escalate \u2014 manage mid-execution escalations (ADR-011 Phase 2)",
    "",
    "Subcommands:",
    "  list [--all]           show pending escalations (use --all to include resolved)",
    "  show <taskId>          print the escalation artifact",
    "  resolve <taskId> <choice> [rationale...]",
    "                         resolve an escalation \u2014 choice is an option id,",
    "                         `accept` (use recommendation), or `reject-blocker`",
    "                         (convert to a blocker and trigger slice replan)",
    "",
    "Note: disabling `phases.mid_execution_escalation` does NOT clear pending",
    "escalations. If you need to drain them, re-enable the flag, resolve via",
    "`/gsd escalate resolve`, then disable."
  ].join("\n");
}
function formatListEntries(rows, basePath) {
  if (rows.length === 0) return "No escalations.";
  return rows.map((t) => {
    const art = t.escalation_artifact_path ? readEscalationArtifact(t.escalation_artifact_path) : null;
    const status = t.escalation_pending ? "PENDING (paused)" : t.escalation_awaiting_review ? "awaiting-review" : "resolved";
    const question = art?.question ?? "(artifact missing)";
    return `  ${t.slice_id}/${t.id}  [${status}]  ${question}`;
  }).join("\n");
}
async function handleEscalateCommand(args, ctx, pi) {
  void pi;
  const trimmed = args.trim();
  if (trimmed === "" || trimmed === "help") {
    ctx.ui.notify(helpMessage(), "info");
    return;
  }
  const basePath = projectRoot();
  const prefs = loadEffectiveGSDPreferences()?.preferences;
  if (prefs?.phases?.mid_execution_escalation !== true) {
    ctx.ui.notify(
      "Escalation is off. Enable with `phases: { mid_execution_escalation: true }` in your PREFERENCES.md.",
      "warning"
    );
    return;
  }
  const milestoneId = await getActiveMilestoneId(basePath);
  if (!milestoneId) {
    ctx.ui.notify("No active milestone \u2014 cannot list escalations.", "warning");
    return;
  }
  if (trimmed === "list" || trimmed === "list --all" || trimmed === "--all") {
    const includeAll = trimmed.includes("--all");
    const rows = includeAll ? listAllEscalations(milestoneId) : listActionableEscalations(milestoneId);
    const body = formatListEntries(rows, basePath);
    ctx.ui.notify(
      `${includeAll ? "All escalations" : "Actionable escalations"} for ${milestoneId}:
${body}`,
      "info"
    );
    return;
  }
  const parseTaskRef = (ref) => {
    const slash = ref.indexOf("/");
    if (slash > 0) {
      return { sliceId: ref.slice(0, slash), taskId: ref.slice(slash + 1) };
    }
    return { taskId: ref };
  };
  const locateRow = (ref) => {
    const { sliceId, taskId } = parseTaskRef(ref);
    const rows = listAllEscalations(milestoneId).filter(
      (t) => t.id === taskId && (sliceId === void 0 || t.slice_id === sliceId)
    );
    if (rows.length === 0) return "not-found";
    if (rows.length > 1) return "ambiguous";
    return rows[0];
  };
  if (trimmed.startsWith("show ")) {
    const ref = trimmed.slice(5).trim();
    const row = locateRow(ref);
    if (row === "ambiguous") {
      ctx.ui.notify(`Task ${ref} matches multiple slices. Use Sxx/Tyy format.`, "warning");
      return;
    }
    if (row === "not-found" || !row.escalation_artifact_path) {
      ctx.ui.notify(`No escalation found for ${ref} in ${milestoneId}.`, "warning");
      return;
    }
    const art = readEscalationArtifact(row.escalation_artifact_path);
    if (!art) {
      ctx.ui.notify(`Escalation artifact at ${row.escalation_artifact_path} is missing or malformed.`, "error");
      return;
    }
    ctx.ui.notify(formatEscalationForDisplay(art), "info");
    return;
  }
  if (trimmed.startsWith("resolve ")) {
    const parts = trimmed.slice(8).trim().split(/\s+/);
    const ref = parts[0];
    const choice = parts[1];
    const rationale = parts.slice(2).join(" ").trim();
    if (!ref || !choice) {
      ctx.ui.notify("Usage: /gsd escalate resolve <taskId|Sxx/Tyy> <choice> [rationale...]", "warning");
      return;
    }
    const row = locateRow(ref);
    if (row === "ambiguous") {
      ctx.ui.notify(`Task ${ref} matches multiple slices. Use Sxx/Tyy format.`, "warning");
      return;
    }
    if (row === "not-found") {
      ctx.ui.notify(`No escalation found for ${ref} in ${milestoneId}.`, "warning");
      return;
    }
    const taskId = row.id;
    const result = resolveEscalation(basePath, milestoneId, row.slice_id, taskId, choice, rationale);
    invalidateStateCache();
    if (result.status !== "resolved" && result.status !== "rejected-to-blocker") {
      ctx.ui.notify(result.message, result.status === "invalid-choice" ? "warning" : "error");
      return;
    }
    if (result.status === "resolved") {
      try {
        const art = row.escalation_artifact_path ? readEscalationArtifact(row.escalation_artifact_path) : null;
        const scope = `${milestoneId}/${row.slice_id}/${taskId}`;
        const decisionText = art?.question ?? `escalation on ${taskId}`;
        const choiceLabel = choice === "accept" ? `${art?.recommendation ?? "accepted"} (recommended)` : result.chosenOption?.label ?? choice;
        const { id: decisionId } = await saveDecisionToDb({
          scope,
          decision: decisionText,
          choice: choiceLabel,
          rationale: rationale || result.chosenOption?.tradeoffs || "User-resolved escalation.",
          made_by: "human",
          source: "escalation",
          when_context: `ADR-011 escalation resolved ${(/* @__PURE__ */ new Date()).toISOString()}`
        }, basePath);
        emitUokAuditEvent(basePath, buildAuditEnvelope({
          traceId: `escalation:${milestoneId}:${row.slice_id}:${taskId}`,
          category: "gate",
          type: "escalation-decision-persisted",
          payload: {
            milestoneId,
            sliceId: row.slice_id,
            taskId,
            decisionId,
            choice
          }
        }));
        ctx.ui.notify(
          `${result.message}
Decision recorded as ${decisionId}. Run /gsd auto to continue.`,
          "success"
        );
      } catch (decErr) {
        ctx.ui.notify(
          `${result.message}
WARN: decision persistence failed: ${decErr.message}`,
          "warning"
        );
      }
      return;
    }
    ctx.ui.notify(`${result.message} Run /gsd auto to trigger the replan.`, "success");
    return;
  }
  ctx.ui.notify(`Unknown subcommand. ${helpMessage()}`, "warning");
}
export {
  handleEscalateCommand
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9jb21tYW5kcy9oYW5kbGVycy9lc2NhbGF0ZS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NEIEV4dGVuc2lvbiBcdTIwMTQgL2dzZCBlc2NhbGF0ZSBDb21tYW5kIEhhbmRsZXIgKEFEUi0wMTEgUGhhc2UgMilcbi8vIFN1cmZhY2UgYW5kIHJlc29sdmUgbWlkLWV4ZWN1dGlvbiBlc2NhbGF0aW9ucyBmcm9tIHRoZSBDTEkuXG5cbmltcG9ydCB0eXBlIHsgRXh0ZW5zaW9uQVBJLCBFeHRlbnNpb25Db21tYW5kQ29udGV4dCB9IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuXG5pbXBvcnQgeyBwcm9qZWN0Um9vdCB9IGZyb20gXCIuLi9jb250ZXh0LmpzXCI7XG5pbXBvcnQgeyBnZXRBY3RpdmVNaWxlc3RvbmVJZCB9IGZyb20gXCIuLi8uLi9zdGF0ZS5qc1wiO1xuaW1wb3J0IHtcbiAgcmVhZEVzY2FsYXRpb25BcnRpZmFjdCxcbiAgZm9ybWF0RXNjYWxhdGlvbkZvckRpc3BsYXksXG4gIHJlc29sdmVFc2NhbGF0aW9uLFxuICBsaXN0QWN0aW9uYWJsZUVzY2FsYXRpb25zLFxuICBsaXN0QWxsRXNjYWxhdGlvbnMsXG59IGZyb20gXCIuLi8uLi9lc2NhbGF0aW9uLmpzXCI7XG5pbXBvcnQgeyBzYXZlRGVjaXNpb25Ub0RiIH0gZnJvbSBcIi4uLy4uL2RiLXdyaXRlci5qc1wiO1xuaW1wb3J0IHsgbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzIH0gZnJvbSBcIi4uLy4uL3ByZWZlcmVuY2VzLmpzXCI7XG5pbXBvcnQgeyBpbnZhbGlkYXRlU3RhdGVDYWNoZSB9IGZyb20gXCIuLi8uLi9zdGF0ZS5qc1wiO1xuaW1wb3J0IHsgZW1pdFVva0F1ZGl0RXZlbnQsIGJ1aWxkQXVkaXRFbnZlbG9wZSB9IGZyb20gXCIuLi8uLi91b2svYXVkaXQuanNcIjtcblxuZnVuY3Rpb24gaGVscE1lc3NhZ2UoKTogc3RyaW5nIHtcbiAgcmV0dXJuIFtcbiAgICBcIi9nc2QgZXNjYWxhdGUgXHUyMDE0IG1hbmFnZSBtaWQtZXhlY3V0aW9uIGVzY2FsYXRpb25zIChBRFItMDExIFBoYXNlIDIpXCIsXG4gICAgXCJcIixcbiAgICBcIlN1YmNvbW1hbmRzOlwiLFxuICAgIFwiICBsaXN0IFstLWFsbF0gICAgICAgICAgIHNob3cgcGVuZGluZyBlc2NhbGF0aW9ucyAodXNlIC0tYWxsIHRvIGluY2x1ZGUgcmVzb2x2ZWQpXCIsXG4gICAgXCIgIHNob3cgPHRhc2tJZD4gICAgICAgICAgcHJpbnQgdGhlIGVzY2FsYXRpb24gYXJ0aWZhY3RcIixcbiAgICBcIiAgcmVzb2x2ZSA8dGFza0lkPiA8Y2hvaWNlPiBbcmF0aW9uYWxlLi4uXVwiLFxuICAgIFwiICAgICAgICAgICAgICAgICAgICAgICAgIHJlc29sdmUgYW4gZXNjYWxhdGlvbiBcdTIwMTQgY2hvaWNlIGlzIGFuIG9wdGlvbiBpZCxcIixcbiAgICBcIiAgICAgICAgICAgICAgICAgICAgICAgICBgYWNjZXB0YCAodXNlIHJlY29tbWVuZGF0aW9uKSwgb3IgYHJlamVjdC1ibG9ja2VyYFwiLFxuICAgIFwiICAgICAgICAgICAgICAgICAgICAgICAgIChjb252ZXJ0IHRvIGEgYmxvY2tlciBhbmQgdHJpZ2dlciBzbGljZSByZXBsYW4pXCIsXG4gICAgXCJcIixcbiAgICBcIk5vdGU6IGRpc2FibGluZyBgcGhhc2VzLm1pZF9leGVjdXRpb25fZXNjYWxhdGlvbmAgZG9lcyBOT1QgY2xlYXIgcGVuZGluZ1wiLFxuICAgIFwiZXNjYWxhdGlvbnMuIElmIHlvdSBuZWVkIHRvIGRyYWluIHRoZW0sIHJlLWVuYWJsZSB0aGUgZmxhZywgcmVzb2x2ZSB2aWFcIixcbiAgICBcImAvZ3NkIGVzY2FsYXRlIHJlc29sdmVgLCB0aGVuIGRpc2FibGUuXCIsXG4gIF0uam9pbihcIlxcblwiKTtcbn1cblxuZnVuY3Rpb24gZm9ybWF0TGlzdEVudHJpZXMoXG4gIHJvd3M6IFJldHVyblR5cGU8dHlwZW9mIGxpc3RBY3Rpb25hYmxlRXNjYWxhdGlvbnM+LFxuICBiYXNlUGF0aDogc3RyaW5nLFxuKTogc3RyaW5nIHtcbiAgaWYgKHJvd3MubGVuZ3RoID09PSAwKSByZXR1cm4gXCJObyBlc2NhbGF0aW9ucy5cIjtcbiAgcmV0dXJuIHJvd3MubWFwKCh0KSA9PiB7XG4gICAgY29uc3QgYXJ0ID0gdC5lc2NhbGF0aW9uX2FydGlmYWN0X3BhdGggPyByZWFkRXNjYWxhdGlvbkFydGlmYWN0KHQuZXNjYWxhdGlvbl9hcnRpZmFjdF9wYXRoKSA6IG51bGw7XG4gICAgY29uc3Qgc3RhdHVzID0gdC5lc2NhbGF0aW9uX3BlbmRpbmcgPyBcIlBFTkRJTkcgKHBhdXNlZClcIiA6IHQuZXNjYWxhdGlvbl9hd2FpdGluZ19yZXZpZXcgPyBcImF3YWl0aW5nLXJldmlld1wiIDogXCJyZXNvbHZlZFwiO1xuICAgIGNvbnN0IHF1ZXN0aW9uID0gYXJ0Py5xdWVzdGlvbiA/PyBcIihhcnRpZmFjdCBtaXNzaW5nKVwiO1xuICAgIHJldHVybiBgICAke3Quc2xpY2VfaWR9LyR7dC5pZH0gIFske3N0YXR1c31dICAke3F1ZXN0aW9ufWA7XG4gIH0pLmpvaW4oXCJcXG5cIik7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBoYW5kbGVFc2NhbGF0ZUNvbW1hbmQoXG4gIGFyZ3M6IHN0cmluZyxcbiAgY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCxcbiAgcGk6IEV4dGVuc2lvbkFQSSxcbik6IFByb21pc2U8dm9pZD4ge1xuICB2b2lkIHBpO1xuXG4gIGNvbnN0IHRyaW1tZWQgPSBhcmdzLnRyaW0oKTtcbiAgaWYgKHRyaW1tZWQgPT09IFwiXCIgfHwgdHJpbW1lZCA9PT0gXCJoZWxwXCIpIHtcbiAgICBjdHgudWkubm90aWZ5KGhlbHBNZXNzYWdlKCksIFwiaW5mb1wiKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBiYXNlUGF0aCA9IHByb2plY3RSb290KCk7XG4gIGNvbnN0IHByZWZzID0gbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzKCk/LnByZWZlcmVuY2VzO1xuICBpZiAocHJlZnM/LnBoYXNlcz8ubWlkX2V4ZWN1dGlvbl9lc2NhbGF0aW9uICE9PSB0cnVlKSB7XG4gICAgY3R4LnVpLm5vdGlmeShcbiAgICAgIFwiRXNjYWxhdGlvbiBpcyBvZmYuIEVuYWJsZSB3aXRoIGBwaGFzZXM6IHsgbWlkX2V4ZWN1dGlvbl9lc2NhbGF0aW9uOiB0cnVlIH1gIGluIHlvdXIgUFJFRkVSRU5DRVMubWQuXCIsXG4gICAgICBcIndhcm5pbmdcIixcbiAgICApO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IG1pbGVzdG9uZUlkID0gYXdhaXQgZ2V0QWN0aXZlTWlsZXN0b25lSWQoYmFzZVBhdGgpO1xuICBpZiAoIW1pbGVzdG9uZUlkKSB7XG4gICAgY3R4LnVpLm5vdGlmeShcIk5vIGFjdGl2ZSBtaWxlc3RvbmUgXHUyMDE0IGNhbm5vdCBsaXN0IGVzY2FsYXRpb25zLlwiLCBcIndhcm5pbmdcIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwIGxpc3QgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGlmICh0cmltbWVkID09PSBcImxpc3RcIiB8fCB0cmltbWVkID09PSBcImxpc3QgLS1hbGxcIiB8fCB0cmltbWVkID09PSBcIi0tYWxsXCIpIHtcbiAgICBjb25zdCBpbmNsdWRlQWxsID0gdHJpbW1lZC5pbmNsdWRlcyhcIi0tYWxsXCIpO1xuICAgIGNvbnN0IHJvd3MgPSBpbmNsdWRlQWxsID8gbGlzdEFsbEVzY2FsYXRpb25zKG1pbGVzdG9uZUlkKSA6IGxpc3RBY3Rpb25hYmxlRXNjYWxhdGlvbnMobWlsZXN0b25lSWQpO1xuICAgIGNvbnN0IGJvZHkgPSBmb3JtYXRMaXN0RW50cmllcyhyb3dzLCBiYXNlUGF0aCk7XG4gICAgY3R4LnVpLm5vdGlmeShcbiAgICAgIGAke2luY2x1ZGVBbGwgPyBcIkFsbCBlc2NhbGF0aW9uc1wiIDogXCJBY3Rpb25hYmxlIGVzY2FsYXRpb25zXCJ9IGZvciAke21pbGVzdG9uZUlkfTpcXG4ke2JvZHl9YCxcbiAgICAgIFwiaW5mb1wiLFxuICAgICk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gUGFyc2UgYSBwb3NzaWJseS1zbGljZS1xdWFsaWZpZWQgdGFzayBpZDogXCJTeHgvVHl5XCIgb3IgcGxhaW4gXCJUeXlcIi5cbiAgLy8gUmV0dXJucyB7IHNsaWNlSWQ/LCB0YXNrSWQgfS5cbiAgY29uc3QgcGFyc2VUYXNrUmVmID0gKHJlZjogc3RyaW5nKTogeyBzbGljZUlkPzogc3RyaW5nOyB0YXNrSWQ6IHN0cmluZyB9ID0+IHtcbiAgICBjb25zdCBzbGFzaCA9IHJlZi5pbmRleE9mKFwiL1wiKTtcbiAgICBpZiAoc2xhc2ggPiAwKSB7XG4gICAgICByZXR1cm4geyBzbGljZUlkOiByZWYuc2xpY2UoMCwgc2xhc2gpLCB0YXNrSWQ6IHJlZi5zbGljZShzbGFzaCArIDEpIH07XG4gICAgfVxuICAgIHJldHVybiB7IHRhc2tJZDogcmVmIH07XG4gIH07XG5cbiAgLy8gUmVzb2x2ZSBhIHRhc2sgcmVmIHRvIGEgc2luZ2xlIHJvdywgc3VyZmFjaW5nIGFtYmlndWl0eSB3aGVuIGEgYmFyZSB0YXNrXG4gIC8vIGlkIG1hdGNoZXMgbW9yZSB0aGFuIG9uZSBzbGljZS5cbiAgY29uc3QgbG9jYXRlUm93ID0gKHJlZjogc3RyaW5nKTogUmV0dXJuVHlwZTx0eXBlb2YgbGlzdEFsbEVzY2FsYXRpb25zPltudW1iZXJdIHwgXCJhbWJpZ3VvdXNcIiB8IFwibm90LWZvdW5kXCIgPT4ge1xuICAgIGNvbnN0IHsgc2xpY2VJZCwgdGFza0lkIH0gPSBwYXJzZVRhc2tSZWYocmVmKTtcbiAgICBjb25zdCByb3dzID0gbGlzdEFsbEVzY2FsYXRpb25zKG1pbGVzdG9uZUlkKS5maWx0ZXIoXG4gICAgICAodCkgPT4gdC5pZCA9PT0gdGFza0lkICYmIChzbGljZUlkID09PSB1bmRlZmluZWQgfHwgdC5zbGljZV9pZCA9PT0gc2xpY2VJZCksXG4gICAgKTtcbiAgICBpZiAocm93cy5sZW5ndGggPT09IDApIHJldHVybiBcIm5vdC1mb3VuZFwiO1xuICAgIGlmIChyb3dzLmxlbmd0aCA+IDEpIHJldHVybiBcImFtYmlndW91c1wiO1xuICAgIHJldHVybiByb3dzWzBdITtcbiAgfTtcblxuICAvLyBcdTI1MDBcdTI1MDAgc2hvdyA8dGFza1JlZj4gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGlmICh0cmltbWVkLnN0YXJ0c1dpdGgoXCJzaG93IFwiKSkge1xuICAgIGNvbnN0IHJlZiA9IHRyaW1tZWQuc2xpY2UoNSkudHJpbSgpO1xuICAgIGNvbnN0IHJvdyA9IGxvY2F0ZVJvdyhyZWYpO1xuICAgIGlmIChyb3cgPT09IFwiYW1iaWd1b3VzXCIpIHtcbiAgICAgIGN0eC51aS5ub3RpZnkoYFRhc2sgJHtyZWZ9IG1hdGNoZXMgbXVsdGlwbGUgc2xpY2VzLiBVc2UgU3h4L1R5eSBmb3JtYXQuYCwgXCJ3YXJuaW5nXCIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocm93ID09PSBcIm5vdC1mb3VuZFwiIHx8ICFyb3cuZXNjYWxhdGlvbl9hcnRpZmFjdF9wYXRoKSB7XG4gICAgICBjdHgudWkubm90aWZ5KGBObyBlc2NhbGF0aW9uIGZvdW5kIGZvciAke3JlZn0gaW4gJHttaWxlc3RvbmVJZH0uYCwgXCJ3YXJuaW5nXCIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBhcnQgPSByZWFkRXNjYWxhdGlvbkFydGlmYWN0KHJvdy5lc2NhbGF0aW9uX2FydGlmYWN0X3BhdGgpO1xuICAgIGlmICghYXJ0KSB7XG4gICAgICBjdHgudWkubm90aWZ5KGBFc2NhbGF0aW9uIGFydGlmYWN0IGF0ICR7cm93LmVzY2FsYXRpb25fYXJ0aWZhY3RfcGF0aH0gaXMgbWlzc2luZyBvciBtYWxmb3JtZWQuYCwgXCJlcnJvclwiKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY3R4LnVpLm5vdGlmeShmb3JtYXRFc2NhbGF0aW9uRm9yRGlzcGxheShhcnQpLCBcImluZm9cIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwIHJlc29sdmUgPHRhc2tSZWY+IDxjaG9pY2U+IFtyYXRpb25hbGUuLi5dIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBpZiAodHJpbW1lZC5zdGFydHNXaXRoKFwicmVzb2x2ZSBcIikpIHtcbiAgICBjb25zdCBwYXJ0cyA9IHRyaW1tZWQuc2xpY2UoOCkudHJpbSgpLnNwbGl0KC9cXHMrLyk7XG4gICAgY29uc3QgcmVmID0gcGFydHNbMF07XG4gICAgY29uc3QgY2hvaWNlID0gcGFydHNbMV07XG4gICAgY29uc3QgcmF0aW9uYWxlID0gcGFydHMuc2xpY2UoMikuam9pbihcIiBcIikudHJpbSgpO1xuICAgIGlmICghcmVmIHx8ICFjaG9pY2UpIHtcbiAgICAgIGN0eC51aS5ub3RpZnkoXCJVc2FnZTogL2dzZCBlc2NhbGF0ZSByZXNvbHZlIDx0YXNrSWR8U3h4L1R5eT4gPGNob2ljZT4gW3JhdGlvbmFsZS4uLl1cIiwgXCJ3YXJuaW5nXCIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IHJvdyA9IGxvY2F0ZVJvdyhyZWYpO1xuICAgIGlmIChyb3cgPT09IFwiYW1iaWd1b3VzXCIpIHtcbiAgICAgIGN0eC51aS5ub3RpZnkoYFRhc2sgJHtyZWZ9IG1hdGNoZXMgbXVsdGlwbGUgc2xpY2VzLiBVc2UgU3h4L1R5eSBmb3JtYXQuYCwgXCJ3YXJuaW5nXCIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocm93ID09PSBcIm5vdC1mb3VuZFwiKSB7XG4gICAgICBjdHgudWkubm90aWZ5KGBObyBlc2NhbGF0aW9uIGZvdW5kIGZvciAke3JlZn0gaW4gJHttaWxlc3RvbmVJZH0uYCwgXCJ3YXJuaW5nXCIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCB0YXNrSWQgPSByb3cuaWQ7XG5cbiAgICBjb25zdCByZXN1bHQgPSByZXNvbHZlRXNjYWxhdGlvbihiYXNlUGF0aCwgbWlsZXN0b25lSWQsIHJvdy5zbGljZV9pZCwgdGFza0lkLCBjaG9pY2UsIHJhdGlvbmFsZSk7XG4gICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcblxuICAgIGlmIChyZXN1bHQuc3RhdHVzICE9PSBcInJlc29sdmVkXCIgJiYgcmVzdWx0LnN0YXR1cyAhPT0gXCJyZWplY3RlZC10by1ibG9ja2VyXCIpIHtcbiAgICAgIGN0eC51aS5ub3RpZnkocmVzdWx0Lm1lc3NhZ2UsIHJlc3VsdC5zdGF0dXMgPT09IFwiaW52YWxpZC1jaG9pY2VcIiA/IFwid2FybmluZ1wiIDogXCJlcnJvclwiKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBQZXJzaXN0IHRoZSB1c2VyJ3MgY2hvaWNlIGFzIGEgZGVjaXNpb24gKG9ubHkgZm9yIHJlc29sdmVkLCBub3QgcmVqZWN0LWJsb2NrZXIpLlxuICAgIGlmIChyZXN1bHQuc3RhdHVzID09PSBcInJlc29sdmVkXCIpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGFydCA9IHJvdy5lc2NhbGF0aW9uX2FydGlmYWN0X3BhdGggPyByZWFkRXNjYWxhdGlvbkFydGlmYWN0KHJvdy5lc2NhbGF0aW9uX2FydGlmYWN0X3BhdGgpIDogbnVsbDtcbiAgICAgICAgY29uc3Qgc2NvcGUgPSBgJHttaWxlc3RvbmVJZH0vJHtyb3cuc2xpY2VfaWR9LyR7dGFza0lkfWA7XG4gICAgICAgIGNvbnN0IGRlY2lzaW9uVGV4dCA9IGFydD8ucXVlc3Rpb24gPz8gYGVzY2FsYXRpb24gb24gJHt0YXNrSWR9YDtcbiAgICAgICAgY29uc3QgY2hvaWNlTGFiZWwgPSBjaG9pY2UgPT09IFwiYWNjZXB0XCJcbiAgICAgICAgICA/IGAke2FydD8ucmVjb21tZW5kYXRpb24gPz8gXCJhY2NlcHRlZFwifSAocmVjb21tZW5kZWQpYFxuICAgICAgICAgIDogKHJlc3VsdC5jaG9zZW5PcHRpb24/LmxhYmVsID8/IGNob2ljZSk7XG4gICAgICAgIGNvbnN0IHsgaWQ6IGRlY2lzaW9uSWQgfSA9IGF3YWl0IHNhdmVEZWNpc2lvblRvRGIoe1xuICAgICAgICAgIHNjb3BlLFxuICAgICAgICAgIGRlY2lzaW9uOiBkZWNpc2lvblRleHQsXG4gICAgICAgICAgY2hvaWNlOiBjaG9pY2VMYWJlbCxcbiAgICAgICAgICByYXRpb25hbGU6IHJhdGlvbmFsZSB8fCByZXN1bHQuY2hvc2VuT3B0aW9uPy50cmFkZW9mZnMgfHwgXCJVc2VyLXJlc29sdmVkIGVzY2FsYXRpb24uXCIsXG4gICAgICAgICAgbWFkZV9ieTogXCJodW1hblwiLFxuICAgICAgICAgIHNvdXJjZTogXCJlc2NhbGF0aW9uXCIsXG4gICAgICAgICAgd2hlbl9jb250ZXh0OiBgQURSLTAxMSBlc2NhbGF0aW9uIHJlc29sdmVkICR7bmV3IERhdGUoKS50b0lTT1N0cmluZygpfWAsXG4gICAgICAgIH0sIGJhc2VQYXRoKTtcblxuICAgICAgICBlbWl0VW9rQXVkaXRFdmVudChiYXNlUGF0aCwgYnVpbGRBdWRpdEVudmVsb3BlKHtcbiAgICAgICAgICB0cmFjZUlkOiBgZXNjYWxhdGlvbjoke21pbGVzdG9uZUlkfToke3Jvdy5zbGljZV9pZH06JHt0YXNrSWR9YCxcbiAgICAgICAgICBjYXRlZ29yeTogXCJnYXRlXCIsXG4gICAgICAgICAgdHlwZTogXCJlc2NhbGF0aW9uLWRlY2lzaW9uLXBlcnNpc3RlZFwiLFxuICAgICAgICAgIHBheWxvYWQ6IHtcbiAgICAgICAgICAgIG1pbGVzdG9uZUlkLFxuICAgICAgICAgICAgc2xpY2VJZDogcm93LnNsaWNlX2lkLFxuICAgICAgICAgICAgdGFza0lkLFxuICAgICAgICAgICAgZGVjaXNpb25JZCxcbiAgICAgICAgICAgIGNob2ljZSxcbiAgICAgICAgICB9LFxuICAgICAgICB9KSk7XG5cbiAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICBgJHtyZXN1bHQubWVzc2FnZX1cXG5EZWNpc2lvbiByZWNvcmRlZCBhcyAke2RlY2lzaW9uSWR9LiBSdW4gL2dzZCBhdXRvIHRvIGNvbnRpbnVlLmAsXG4gICAgICAgICAgXCJzdWNjZXNzXCIsXG4gICAgICAgICk7XG4gICAgICB9IGNhdGNoIChkZWNFcnIpIHtcbiAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICBgJHtyZXN1bHQubWVzc2FnZX1cXG5XQVJOOiBkZWNpc2lvbiBwZXJzaXN0ZW5jZSBmYWlsZWQ6ICR7KGRlY0VyciBhcyBFcnJvcikubWVzc2FnZX1gLFxuICAgICAgICAgIFwid2FybmluZ1wiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIHJlamVjdGVkLXRvLWJsb2NrZXIgcGF0aFxuICAgIGN0eC51aS5ub3RpZnkoYCR7cmVzdWx0Lm1lc3NhZ2V9IFJ1biAvZ3NkIGF1dG8gdG8gdHJpZ2dlciB0aGUgcmVwbGFuLmAsIFwic3VjY2Vzc1wiKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjdHgudWkubm90aWZ5KGBVbmtub3duIHN1YmNvbW1hbmQuICR7aGVscE1lc3NhZ2UoKX1gLCBcIndhcm5pbmdcIik7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFLQSxTQUFTLG1CQUFtQjtBQUM1QixTQUFTLDRCQUE0QjtBQUNyQztBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUNQLFNBQVMsd0JBQXdCO0FBQ2pDLFNBQVMsbUNBQW1DO0FBQzVDLFNBQVMsNEJBQTRCO0FBQ3JDLFNBQVMsbUJBQW1CLDBCQUEwQjtBQUV0RCxTQUFTLGNBQXNCO0FBQzdCLFNBQU87QUFBQSxJQUNMO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsRUFDRixFQUFFLEtBQUssSUFBSTtBQUNiO0FBRUEsU0FBUyxrQkFDUCxNQUNBLFVBQ1E7QUFDUixNQUFJLEtBQUssV0FBVyxFQUFHLFFBQU87QUFDOUIsU0FBTyxLQUFLLElBQUksQ0FB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
