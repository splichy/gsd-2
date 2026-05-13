import {
  getOrchestratorState,
  getWorkerStatuses,
  isParallelActive,
  pauseWorker,
  prepareParallelStart,
  refreshWorkerStatuses,
  resumeWorker,
  startParallel,
  stopParallel
} from "../../parallel-orchestrator.js";
import { formatEligibilityReport } from "../../parallel-eligibility.js";
import { formatMergeResults, mergeAllCompleted, mergeCompletedMilestone } from "../../parallel-merge.js";
import { loadEffectiveGSDPreferences, resolveParallelConfig } from "../../preferences.js";
import { reconcileBeforeSpawn } from "../../state-reconciliation.js";
import { projectRoot } from "../context.js";
function emitParallelMessage(pi, content) {
  pi.sendMessage({ customType: "gsd-parallel", content, display: true });
}
async function handleParallelCommand(trimmed, _ctx, pi) {
  if (!trimmed.startsWith("parallel")) return false;
  const parallelArgs = trimmed.slice("parallel".length).trim();
  const [subcommand = "", ...restParts] = parallelArgs.split(/\s+/);
  const rest = restParts.join(" ");
  if (subcommand === "start" || subcommand === "") {
    const root = projectRoot();
    const loaded = loadEffectiveGSDPreferences();
    const config = resolveParallelConfig(loaded?.preferences);
    if (!config.enabled) {
      emitParallelMessage(pi, "Parallel mode is not enabled. Set `parallel.enabled: true` in your preferences.");
      return true;
    }
    const candidates = await prepareParallelStart(root, loaded?.preferences);
    const report = formatEligibilityReport(candidates);
    if (candidates.eligible.length === 0) {
      emitParallelMessage(pi, `${report}

No milestones are eligible for parallel execution.`);
      return true;
    }
    const gate = await reconcileBeforeSpawn(root);
    if (!gate.ok) {
      emitParallelMessage(
        pi,
        `${report}

Parallel orchestration aborted before spawn \u2014 ${gate.reason}`
      );
      return true;
    }
    const result = await startParallel(
      root,
      candidates.eligible.map((candidate) => candidate.milestoneId),
      loaded?.preferences
    );
    const lines = ["Parallel orchestration started.", `Workers: ${result.started.join(", ")}`];
    if (result.errors.length > 0) {
      lines.push(`Errors: ${result.errors.map((entry) => `${entry.mid}: ${entry.error}`).join("; ")}`);
    }
    emitParallelMessage(pi, `${report}

${lines.join("\n")}`);
    return true;
  }
  if (subcommand === "status") {
    const root = projectRoot();
    refreshWorkerStatuses(root, { restoreIfNeeded: true });
    const workers = getWorkerStatuses(root);
    if (workers.length === 0 || !isParallelActive()) {
      emitParallelMessage(pi, "No parallel orchestration is currently active.");
      return true;
    }
    const lines = ["# Parallel Workers\n"];
    for (const worker of workers) {
      lines.push(`- **${worker.milestoneId}** (${worker.title}) \u2014 ${worker.state} \u2014 $${worker.cost.toFixed(2)}`);
    }
    const state = getOrchestratorState();
    if (state) {
      lines.push(`
Total cost: $${state.totalCost.toFixed(2)}`);
    }
    emitParallelMessage(pi, lines.join("\n"));
    return true;
  }
  if (subcommand === "stop") {
    const milestoneId = rest.trim() || void 0;
    await stopParallel(projectRoot(), milestoneId);
    emitParallelMessage(pi, milestoneId ? `Stopped worker for ${milestoneId}.` : "All parallel workers stopped.");
    return true;
  }
  if (subcommand === "pause") {
    const milestoneId = rest.trim() || void 0;
    pauseWorker(projectRoot(), milestoneId);
    emitParallelMessage(pi, milestoneId ? `Paused worker for ${milestoneId}.` : "All parallel workers paused.");
    return true;
  }
  if (subcommand === "resume") {
    const milestoneId = rest.trim() || void 0;
    resumeWorker(projectRoot(), milestoneId);
    emitParallelMessage(pi, milestoneId ? `Resumed worker for ${milestoneId}.` : "All parallel workers resumed.");
    return true;
  }
  if (subcommand === "merge") {
    const milestoneId = rest.trim() || void 0;
    if (milestoneId) {
      const result = await mergeCompletedMilestone(projectRoot(), milestoneId);
      emitParallelMessage(pi, formatMergeResults([result]));
      return true;
    }
    const workers = getWorkerStatuses(projectRoot());
    if (workers.length === 0) {
      emitParallelMessage(pi, "No parallel workers to merge.");
      return true;
    }
    const results = await mergeAllCompleted(projectRoot(), workers);
    emitParallelMessage(pi, formatMergeResults(results));
    return true;
  }
  if (subcommand === "watch") {
    const root = projectRoot();
    const { ParallelMonitorOverlay } = await import("../../parallel-monitor-overlay.js");
    await _ctx.ui.custom(
      (tui, theme, _kb, done) => new ParallelMonitorOverlay(tui, theme, () => done(), root),
      {
        overlay: true,
        overlayOptions: {
          width: "90%",
          minWidth: 80,
          maxHeight: "92%",
          anchor: "center"
        }
      }
    );
    return true;
  }
  emitParallelMessage(pi, `Unknown parallel subcommand "${subcommand}". Usage: /gsd parallel [start|status|stop|pause|resume|merge|watch]`);
  return true;
}
export {
  handleParallelCommand
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9jb21tYW5kcy9oYW5kbGVycy9wYXJhbGxlbC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHR5cGUgeyBFeHRlbnNpb25BUEksIEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0IH0gZnJvbSBcIkBnc2QvcGktY29kaW5nLWFnZW50XCI7XG5cbmltcG9ydCB7XG4gIGdldE9yY2hlc3RyYXRvclN0YXRlLFxuICBnZXRXb3JrZXJTdGF0dXNlcyxcbiAgaXNQYXJhbGxlbEFjdGl2ZSxcbiAgcGF1c2VXb3JrZXIsXG4gIHByZXBhcmVQYXJhbGxlbFN0YXJ0LFxuICByZWZyZXNoV29ya2VyU3RhdHVzZXMsXG4gIHJlc3VtZVdvcmtlcixcbiAgc3RhcnRQYXJhbGxlbCxcbiAgc3RvcFBhcmFsbGVsLFxufSBmcm9tIFwiLi4vLi4vcGFyYWxsZWwtb3JjaGVzdHJhdG9yLmpzXCI7XG5pbXBvcnQgeyBmb3JtYXRFbGlnaWJpbGl0eVJlcG9ydCB9IGZyb20gXCIuLi8uLi9wYXJhbGxlbC1lbGlnaWJpbGl0eS5qc1wiO1xuaW1wb3J0IHsgZm9ybWF0TWVyZ2VSZXN1bHRzLCBtZXJnZUFsbENvbXBsZXRlZCwgbWVyZ2VDb21wbGV0ZWRNaWxlc3RvbmUgfSBmcm9tIFwiLi4vLi4vcGFyYWxsZWwtbWVyZ2UuanNcIjtcbmltcG9ydCB7IGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcywgcmVzb2x2ZVBhcmFsbGVsQ29uZmlnIH0gZnJvbSBcIi4uLy4uL3ByZWZlcmVuY2VzLmpzXCI7XG5pbXBvcnQgeyByZWNvbmNpbGVCZWZvcmVTcGF3biB9IGZyb20gXCIuLi8uLi9zdGF0ZS1yZWNvbmNpbGlhdGlvbi5qc1wiO1xuaW1wb3J0IHsgcHJvamVjdFJvb3QgfSBmcm9tIFwiLi4vY29udGV4dC5qc1wiO1xuZnVuY3Rpb24gZW1pdFBhcmFsbGVsTWVzc2FnZShwaTogRXh0ZW5zaW9uQVBJLCBjb250ZW50OiBzdHJpbmcpOiB2b2lkIHtcbiAgcGkuc2VuZE1lc3NhZ2UoeyBjdXN0b21UeXBlOiBcImdzZC1wYXJhbGxlbFwiLCBjb250ZW50LCBkaXNwbGF5OiB0cnVlIH0pO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlUGFyYWxsZWxDb21tYW5kKHRyaW1tZWQ6IHN0cmluZywgX2N0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsIHBpOiBFeHRlbnNpb25BUEkpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgaWYgKCF0cmltbWVkLnN0YXJ0c1dpdGgoXCJwYXJhbGxlbFwiKSkgcmV0dXJuIGZhbHNlO1xuXG4gIGNvbnN0IHBhcmFsbGVsQXJncyA9IHRyaW1tZWQuc2xpY2UoXCJwYXJhbGxlbFwiLmxlbmd0aCkudHJpbSgpO1xuICBjb25zdCBbc3ViY29tbWFuZCA9IFwiXCIsIC4uLnJlc3RQYXJ0c10gPSBwYXJhbGxlbEFyZ3Muc3BsaXQoL1xccysvKTtcbiAgY29uc3QgcmVzdCA9IHJlc3RQYXJ0cy5qb2luKFwiIFwiKTtcblxuICBpZiAoc3ViY29tbWFuZCA9PT0gXCJzdGFydFwiIHx8IHN1YmNvbW1hbmQgPT09IFwiXCIpIHtcbiAgICBjb25zdCByb290ID0gcHJvamVjdFJvb3QoKTtcbiAgICBjb25zdCBsb2FkZWQgPSBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMoKTtcbiAgICBjb25zdCBjb25maWcgPSByZXNvbHZlUGFyYWxsZWxDb25maWcobG9hZGVkPy5wcmVmZXJlbmNlcyk7XG4gICAgaWYgKCFjb25maWcuZW5hYmxlZCkge1xuICAgICAgZW1pdFBhcmFsbGVsTWVzc2FnZShwaSwgXCJQYXJhbGxlbCBtb2RlIGlzIG5vdCBlbmFibGVkLiBTZXQgYHBhcmFsbGVsLmVuYWJsZWQ6IHRydWVgIGluIHlvdXIgcHJlZmVyZW5jZXMuXCIpO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGNvbnN0IGNhbmRpZGF0ZXMgPSBhd2FpdCBwcmVwYXJlUGFyYWxsZWxTdGFydChyb290LCBsb2FkZWQ/LnByZWZlcmVuY2VzKTtcbiAgICBjb25zdCByZXBvcnQgPSBmb3JtYXRFbGlnaWJpbGl0eVJlcG9ydChjYW5kaWRhdGVzKTtcbiAgICBpZiAoY2FuZGlkYXRlcy5lbGlnaWJsZS5sZW5ndGggPT09IDApIHtcbiAgICAgIGVtaXRQYXJhbGxlbE1lc3NhZ2UocGksIGAke3JlcG9ydH1cXG5cXG5ObyBtaWxlc3RvbmVzIGFyZSBlbGlnaWJsZSBmb3IgcGFyYWxsZWwgZXhlY3V0aW9uLmApO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIC8vIEFEUi0wMTcgIzU3MDc6IHJlY29uY2lsZSBiZWZvcmUgc3Bhd25pbmcgc28gd29ya2VycyBkb24ndCBpbmRlcGVuZGVudGx5XG4gICAgLy8gcmFjZSBvbiB0aGUgc2FtZSBkcmlmdC4gRmFpbHVyZXMgYWJvcnQgdGhlIHNwYXduIHdpdGggYW4gYWN0aW9uYWJsZVxuICAgIC8vIHVzZXItdmlzaWJsZSBtZXNzYWdlLlxuICAgIGNvbnN0IGdhdGUgPSBhd2FpdCByZWNvbmNpbGVCZWZvcmVTcGF3bihyb290KTtcbiAgICBpZiAoIWdhdGUub2spIHtcbiAgICAgIGVtaXRQYXJhbGxlbE1lc3NhZ2UoXG4gICAgICAgIHBpLFxuICAgICAgICBgJHtyZXBvcnR9XFxuXFxuUGFyYWxsZWwgb3JjaGVzdHJhdGlvbiBhYm9ydGVkIGJlZm9yZSBzcGF3biBcdTIwMTQgJHtnYXRlLnJlYXNvbn1gLFxuICAgICAgKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBzdGFydFBhcmFsbGVsKFxuICAgICAgcm9vdCxcbiAgICAgIGNhbmRpZGF0ZXMuZWxpZ2libGUubWFwKChjYW5kaWRhdGUpID0+IGNhbmRpZGF0ZS5taWxlc3RvbmVJZCksXG4gICAgICBsb2FkZWQ/LnByZWZlcmVuY2VzLFxuICAgICk7XG4gICAgY29uc3QgbGluZXMgPSBbXCJQYXJhbGxlbCBvcmNoZXN0cmF0aW9uIHN0YXJ0ZWQuXCIsIGBXb3JrZXJzOiAke3Jlc3VsdC5zdGFydGVkLmpvaW4oXCIsIFwiKX1gXTtcbiAgICBpZiAocmVzdWx0LmVycm9ycy5sZW5ndGggPiAwKSB7XG4gICAgICBsaW5lcy5wdXNoKGBFcnJvcnM6ICR7cmVzdWx0LmVycm9ycy5tYXAoKGVudHJ5KSA9PiBgJHtlbnRyeS5taWR9OiAke2VudHJ5LmVycm9yfWApLmpvaW4oXCI7IFwiKX1gKTtcbiAgICB9XG4gICAgZW1pdFBhcmFsbGVsTWVzc2FnZShwaSwgYCR7cmVwb3J0fVxcblxcbiR7bGluZXMuam9pbihcIlxcblwiKX1gKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIGlmIChzdWJjb21tYW5kID09PSBcInN0YXR1c1wiKSB7XG4gICAgY29uc3Qgcm9vdCA9IHByb2plY3RSb290KCk7XG4gICAgcmVmcmVzaFdvcmtlclN0YXR1c2VzKHJvb3QsIHsgcmVzdG9yZUlmTmVlZGVkOiB0cnVlIH0pO1xuICAgIGNvbnN0IHdvcmtlcnMgPSBnZXRXb3JrZXJTdGF0dXNlcyhyb290KTtcbiAgICBpZiAod29ya2Vycy5sZW5ndGggPT09IDAgfHwgIWlzUGFyYWxsZWxBY3RpdmUoKSkge1xuICAgICAgZW1pdFBhcmFsbGVsTWVzc2FnZShwaSwgXCJObyBwYXJhbGxlbCBvcmNoZXN0cmF0aW9uIGlzIGN1cnJlbnRseSBhY3RpdmUuXCIpO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGNvbnN0IGxpbmVzID0gW1wiIyBQYXJhbGxlbCBXb3JrZXJzXFxuXCJdO1xuICAgIGZvciAoY29uc3Qgd29ya2VyIG9mIHdvcmtlcnMpIHtcbiAgICAgIGxpbmVzLnB1c2goYC0gKioke3dvcmtlci5taWxlc3RvbmVJZH0qKiAoJHt3b3JrZXIudGl0bGV9KSBcdTIwMTQgJHt3b3JrZXIuc3RhdGV9IFx1MjAxNCAkJHt3b3JrZXIuY29zdC50b0ZpeGVkKDIpfWApO1xuICAgIH1cbiAgICBjb25zdCBzdGF0ZSA9IGdldE9yY2hlc3RyYXRvclN0YXRlKCk7XG4gICAgaWYgKHN0YXRlKSB7XG4gICAgICBsaW5lcy5wdXNoKGBcXG5Ub3RhbCBjb3N0OiAkJHtzdGF0ZS50b3RhbENvc3QudG9GaXhlZCgyKX1gKTtcbiAgICB9XG4gICAgZW1pdFBhcmFsbGVsTWVzc2FnZShwaSwgbGluZXMuam9pbihcIlxcblwiKSk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICBpZiAoc3ViY29tbWFuZCA9PT0gXCJzdG9wXCIpIHtcbiAgICBjb25zdCBtaWxlc3RvbmVJZCA9IHJlc3QudHJpbSgpIHx8IHVuZGVmaW5lZDtcbiAgICBhd2FpdCBzdG9wUGFyYWxsZWwocHJvamVjdFJvb3QoKSwgbWlsZXN0b25lSWQpO1xuICAgIGVtaXRQYXJhbGxlbE1lc3NhZ2UocGksIG1pbGVzdG9uZUlkID8gYFN0b3BwZWQgd29ya2VyIGZvciAke21pbGVzdG9uZUlkfS5gIDogXCJBbGwgcGFyYWxsZWwgd29ya2VycyBzdG9wcGVkLlwiKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIGlmIChzdWJjb21tYW5kID09PSBcInBhdXNlXCIpIHtcbiAgICBjb25zdCBtaWxlc3RvbmVJZCA9IHJlc3QudHJpbSgpIHx8IHVuZGVmaW5lZDtcbiAgICBwYXVzZVdvcmtlcihwcm9qZWN0Um9vdCgpLCBtaWxlc3RvbmVJZCk7XG4gICAgZW1pdFBhcmFsbGVsTWVzc2FnZShwaSwgbWlsZXN0b25lSWQgPyBgUGF1c2VkIHdvcmtlciBmb3IgJHttaWxlc3RvbmVJZH0uYCA6IFwiQWxsIHBhcmFsbGVsIHdvcmtlcnMgcGF1c2VkLlwiKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIGlmIChzdWJjb21tYW5kID09PSBcInJlc3VtZVwiKSB7XG4gICAgY29uc3QgbWlsZXN0b25lSWQgPSByZXN0LnRyaW0oKSB8fCB1bmRlZmluZWQ7XG4gICAgcmVzdW1lV29ya2VyKHByb2plY3RSb290KCksIG1pbGVzdG9uZUlkKTtcbiAgICBlbWl0UGFyYWxsZWxNZXNzYWdlKHBpLCBtaWxlc3RvbmVJZCA/IGBSZXN1bWVkIHdvcmtlciBmb3IgJHttaWxlc3RvbmVJZH0uYCA6IFwiQWxsIHBhcmFsbGVsIHdvcmtlcnMgcmVzdW1lZC5cIik7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICBpZiAoc3ViY29tbWFuZCA9PT0gXCJtZXJnZVwiKSB7XG4gICAgY29uc3QgbWlsZXN0b25lSWQgPSByZXN0LnRyaW0oKSB8fCB1bmRlZmluZWQ7XG4gICAgaWYgKG1pbGVzdG9uZUlkKSB7XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBtZXJnZUNvbXBsZXRlZE1pbGVzdG9uZShwcm9qZWN0Um9vdCgpLCBtaWxlc3RvbmVJZCk7XG4gICAgICBlbWl0UGFyYWxsZWxNZXNzYWdlKHBpLCBmb3JtYXRNZXJnZVJlc3VsdHMoW3Jlc3VsdF0pKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBjb25zdCB3b3JrZXJzID0gZ2V0V29ya2VyU3RhdHVzZXMocHJvamVjdFJvb3QoKSk7XG4gICAgaWYgKHdvcmtlcnMubGVuZ3RoID09PSAwKSB7XG4gICAgICBlbWl0UGFyYWxsZWxNZXNzYWdlKHBpLCBcIk5vIHBhcmFsbGVsIHdvcmtlcnMgdG8gbWVyZ2UuXCIpO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGNvbnN0IHJlc3VsdHMgPSBhd2FpdCBtZXJnZUFsbENvbXBsZXRlZChwcm9qZWN0Um9vdCgpLCB3b3JrZXJzKTtcbiAgICBlbWl0UGFyYWxsZWxNZXNzYWdlKHBpLCBmb3JtYXRNZXJnZVJlc3VsdHMocmVzdWx0cykpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgaWYgKHN1YmNvbW1hbmQgPT09IFwid2F0Y2hcIikge1xuICAgIGNvbnN0IHJvb3QgPSBwcm9qZWN0Um9vdCgpO1xuICAgIGNvbnN0IHsgUGFyYWxsZWxNb25pdG9yT3ZlcmxheSB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vLi4vcGFyYWxsZWwtbW9uaXRvci1vdmVybGF5LmpzXCIpO1xuICAgIGF3YWl0IF9jdHgudWkuY3VzdG9tPHZvaWQ+KFxuICAgICAgKHR1aSwgdGhlbWUsIF9rYiwgZG9uZSkgPT4gbmV3IFBhcmFsbGVsTW9uaXRvck92ZXJsYXkodHVpLCB0aGVtZSwgKCkgPT4gZG9uZSgpLCByb290KSxcbiAgICAgIHtcbiAgICAgICAgb3ZlcmxheTogdHJ1ZSxcbiAgICAgICAgb3ZlcmxheU9wdGlvbnM6IHtcbiAgICAgICAgICB3aWR0aDogXCI5MCVcIixcbiAgICAgICAgICBtaW5XaWR0aDogODAsXG4gICAgICAgICAgbWF4SGVpZ2h0OiBcIjkyJVwiLFxuICAgICAgICAgIGFuY2hvcjogXCJjZW50ZXJcIixcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIGVtaXRQYXJhbGxlbE1lc3NhZ2UocGksIGBVbmtub3duIHBhcmFsbGVsIHN1YmNvbW1hbmQgXCIke3N1YmNvbW1hbmR9XCIuIFVzYWdlOiAvZ3NkIHBhcmFsbGVsIFtzdGFydHxzdGF0dXN8c3RvcHxwYXVzZXxyZXN1bWV8bWVyZ2V8d2F0Y2hdYCk7XG4gIHJldHVybiB0cnVlO1xufVxuXG4iXSwKICAibWFwcGluZ3MiOiAiQUFFQTtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFDUCxTQUFTLCtCQUErQjtBQUN4QyxTQUFTLG9CQUFvQixtQkFBbUIsK0JBQStCO0FBQy9FLFNBQVMsNkJBQTZCLDZCQUE2QjtBQUNuRSxTQUFTLDRCQUE0QjtBQUNyQyxTQUFTLG1CQUFtQjtBQUM1QixTQUFTLG9CQUFvQixJQUFrQixTQUF1QjtBQUNwRSxLQUFHLFlBQVksRUFBRSxZQUFZLGdCQUFnQixTQUFTLFNBQVMsS0FBSyxDQUFDO0FBQ3ZFO0FBRUEsZUFBc0Isc0JBQXNCLFNBQWlCLE1BQStCLElBQW9DO0FBQzlILE1BQUksQ0FBQyxRQUFRLFdB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
