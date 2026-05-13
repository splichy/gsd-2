import { AsyncJobManager } from "./job-manager.js";
import { createAsyncBashTool } from "./async-bash-tool.js";
import { createAwaitTool } from "./await-tool.js";
import { createCancelJobTool } from "./cancel-job-tool.js";
function AsyncJobs(pi) {
  let manager = null;
  let latestCwd = process.cwd();
  function getManager() {
    if (!manager) {
      throw new Error("AsyncJobManager not initialized. Wait for session_start.");
    }
    return manager;
  }
  function getCwd() {
    return latestCwd;
  }
  pi.on("session_start", async (_event, ctx) => {
    latestCwd = ctx.cwd;
    manager = new AsyncJobManager({
      onJobComplete: (job) => {
        if (job.awaited) return;
        const statusEmoji = job.status === "completed" ? "done" : "error";
        const elapsed = ((Date.now() - job.startTime) / 1e3).toFixed(1);
        const output = job.status === "completed" ? job.resultText ?? "(no output)" : `Error: ${job.errorText ?? "unknown error"}`;
        const maxLen = 2e3;
        const truncatedOutput = output.length > maxLen ? output.slice(0, maxLen) + "\n\n[... truncated, use await_job for full output]" : output;
        pi.sendMessage(
          {
            customType: "async_job_result",
            content: [
              `**Background job ${statusEmoji}: ${job.id}** (${job.label}, ${elapsed}s)`,
              "",
              truncatedOutput
            ].join("\n"),
            display: true
          },
          { deliverAs: "followUp" }
        );
      }
    });
  });
  pi.on("session_before_switch", async () => {
    if (manager) {
      for (const job of manager.getRunningJobs()) {
        manager.cancel(job.id);
      }
    }
  });
  pi.on("session_shutdown", async () => {
    if (manager) {
      manager.shutdown();
      manager = null;
    }
  });
  pi.registerTool(createAsyncBashTool(getManager, getCwd));
  pi.registerTool(createAwaitTool(getManager));
  pi.registerTool(createCancelJobTool(getManager));
  pi.registerCommand("jobs", {
    description: "Show running and recent background jobs",
    handler: async (_args, _ctx) => {
      if (!manager) {
        pi.sendMessage({
          customType: "async_jobs_list",
          content: "No async job manager active.",
          display: true
        });
        return;
      }
      const running = manager.getRunningJobs();
      const recent = manager.getRecentJobs(10);
      const completed = recent.filter((j) => j.status !== "running");
      const lines = ["## Background Jobs"];
      if (running.length === 0 && completed.length === 0) {
        lines.push("", "No background jobs.");
      } else {
        if (running.length > 0) {
          lines.push("", "### Running");
          for (const job of running) {
            const elapsed = ((Date.now() - job.startTime) / 1e3).toFixed(0);
            lines.push(`- **${job.id}** \u2014 ${job.label} (${elapsed}s)`);
          }
        }
        if (completed.length > 0) {
          lines.push("", "### Recent");
          for (const job of completed) {
            const elapsed = ((Date.now() - job.startTime) / 1e3).toFixed(1);
            lines.push(`- **${job.id}** \u2014 ${job.label} (${job.status}, ${elapsed}s)`);
          }
        }
      }
      pi.sendMessage({
        customType: "async_jobs_list",
        content: lines.join("\n"),
        display: true
      });
    }
  });
}
export {
  AsyncJobs as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2FzeW5jLWpvYnMvaW5kZXgudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogQXN5bmMgSm9icyBFeHRlbnNpb25cbiAqXG4gKiBBbGxvd3MgYmFzaCBjb21tYW5kcyB0byBydW4gaW4gdGhlIGJhY2tncm91bmQuIFRoZSBhZ2VudCBnZXRzIGEgam9iIElEXG4gKiBpbW1lZGlhdGVseSBhbmQgY2FuIGNvbnRpbnVlIHdvcmtpbmcuIFJlc3VsdHMgYXJlIGRlbGl2ZXJlZCB2aWEgZm9sbG93LXVwXG4gKiBtZXNzYWdlcyB3aGVuIGpvYnMgY29tcGxldGUuXG4gKlxuICogVG9vbHM6XG4gKiAgIGFzeW5jX2Jhc2ggXHUyMDE0IHJ1biBhIGNvbW1hbmQgaW4gdGhlIGJhY2tncm91bmQsIGdldCBhIGpvYiBJRFxuICogICBhd2FpdF9qb2IgIFx1MjAxNCB3YWl0IGZvciBiYWNrZ3JvdW5kIGpvYnMgdG8gY29tcGxldGUsIGdldCByZXN1bHRzXG4gKiAgIGNhbmNlbF9qb2IgXHUyMDE0IGNhbmNlbCBhIHJ1bm5pbmcgYmFja2dyb3VuZCBqb2JcbiAqXG4gKiBDb21tYW5kczpcbiAqICAgL2pvYnMgXHUyMDE0IHNob3cgcnVubmluZyBhbmQgcmVjZW50IGJhY2tncm91bmQgam9ic1xuICovXG5cbmltcG9ydCB0eXBlIHsgRXh0ZW5zaW9uQVBJLCBFeHRlbnNpb25Db21tYW5kQ29udGV4dCB9IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuaW1wb3J0IHsgQXN5bmNKb2JNYW5hZ2VyLCB0eXBlIEpvYiB9IGZyb20gXCIuL2pvYi1tYW5hZ2VyLmpzXCI7XG5pbXBvcnQgeyBjcmVhdGVBc3luY0Jhc2hUb29sIH0gZnJvbSBcIi4vYXN5bmMtYmFzaC10b29sLmpzXCI7XG5pbXBvcnQgeyBjcmVhdGVBd2FpdFRvb2wgfSBmcm9tIFwiLi9hd2FpdC10b29sLmpzXCI7XG5pbXBvcnQgeyBjcmVhdGVDYW5jZWxKb2JUb29sIH0gZnJvbSBcIi4vY2FuY2VsLWpvYi10b29sLmpzXCI7XG5cbmV4cG9ydCBkZWZhdWx0IGZ1bmN0aW9uIEFzeW5jSm9icyhwaTogRXh0ZW5zaW9uQVBJKSB7XG5cdGxldCBtYW5hZ2VyOiBBc3luY0pvYk1hbmFnZXIgfCBudWxsID0gbnVsbDtcblx0bGV0IGxhdGVzdEN3ZDogc3RyaW5nID0gcHJvY2Vzcy5jd2QoKTtcblxuXHRmdW5jdGlvbiBnZXRNYW5hZ2VyKCk6IEFzeW5jSm9iTWFuYWdlciB7XG5cdFx0aWYgKCFtYW5hZ2VyKSB7XG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoXCJBc3luY0pvYk1hbmFnZXIgbm90IGluaXRpYWxpemVkLiBXYWl0IGZvciBzZXNzaW9uX3N0YXJ0LlwiKTtcblx0XHR9XG5cdFx0cmV0dXJuIG1hbmFnZXI7XG5cdH1cblxuXHRmdW5jdGlvbiBnZXRDd2QoKTogc3RyaW5nIHtcblx0XHRyZXR1cm4gbGF0ZXN0Q3dkO1xuXHR9XG5cblx0Ly8gXHUyNTAwXHUyNTAwIFNlc3Npb24gbGlmZWN5Y2xlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5cdHBpLm9uKFwic2Vzc2lvbl9zdGFydFwiLCBhc3luYyAoX2V2ZW50LCBjdHgpID0+IHtcblx0XHRsYXRlc3RDd2QgPSBjdHguY3dkO1xuXG5cdFx0bWFuYWdlciA9IG5ldyBBc3luY0pvYk1hbmFnZXIoe1xuXHRcdFx0b25Kb2JDb21wbGV0ZTogKGpvYikgPT4ge1xuXHRcdFx0XHRpZiAoam9iLmF3YWl0ZWQpIHJldHVybjtcblx0XHRcdFx0Y29uc3Qgc3RhdHVzRW1vamkgPSBqb2Iuc3RhdHVzID09PSBcImNvbXBsZXRlZFwiID8gXCJkb25lXCIgOiBcImVycm9yXCI7XG5cdFx0XHRcdGNvbnN0IGVsYXBzZWQgPSAoKERhdGUubm93KCkgLSBqb2Iuc3RhcnRUaW1lKSAvIDEwMDApLnRvRml4ZWQoMSk7XG5cdFx0XHRcdGNvbnN0IG91dHB1dCA9IGpvYi5zdGF0dXMgPT09IFwiY29tcGxldGVkXCJcblx0XHRcdFx0XHQ/IGpvYi5yZXN1bHRUZXh0ID8/IFwiKG5vIG91dHB1dClcIlxuXHRcdFx0XHRcdDogYEVycm9yOiAke2pvYi5lcnJvclRleHQgPz8gXCJ1bmtub3duIGVycm9yXCJ9YDtcblxuXHRcdFx0XHQvLyBUcnVuY2F0ZSBvdXRwdXQgZm9yIHRoZSBmb2xsb3ctdXAgbWVzc2FnZVxuXHRcdFx0XHRjb25zdCBtYXhMZW4gPSAyMDAwO1xuXHRcdFx0XHRjb25zdCB0cnVuY2F0ZWRPdXRwdXQgPSBvdXRwdXQubGVuZ3RoID4gbWF4TGVuXG5cdFx0XHRcdFx0PyBvdXRwdXQuc2xpY2UoMCwgbWF4TGVuKSArIFwiXFxuXFxuWy4uLiB0cnVuY2F0ZWQsIHVzZSBhd2FpdF9qb2IgZm9yIGZ1bGwgb3V0cHV0XVwiXG5cdFx0XHRcdFx0OiBvdXRwdXQ7XG5cblx0XHRcdFx0Ly8gRGVsaXZlciBhcyBmb2xsb3ctdXAgd2l0aG91dCB0cmlnZ2VyaW5nIGEgbmV3IExMTSB0dXJuICgjODc1KS5cblx0XHRcdFx0Ly8gV2hlbiB0aGUgYWdlbnQgaXMgc3RyZWFtaW5nOiB0aGUgbWVzc2FnZSBpcyBxdWV1ZWQgYW5kIHBpY2tlZCB1cFxuXHRcdFx0XHQvLyBieSB0aGUgYWdlbnQgbG9vcCdzIGdldEZvbGxvd1VwTWVzc2FnZXMoKSBhZnRlciB0aGUgY3VycmVudCB0dXJuLlxuXHRcdFx0XHQvLyBXaGVuIHRoZSBhZ2VudCBpcyBpZGxlOiB0aGUgbWVzc2FnZSBpcyBhcHBlbmRlZCB0byBjb250ZXh0IHNvIGl0J3Ncblx0XHRcdFx0Ly8gdmlzaWJsZSBvbiB0aGUgbmV4dCB1c2VyLWluaXRpYXRlZCBwcm9tcHQuIFByZXZpb3VzbHkgdHJpZ2dlclR1cm46dHJ1ZVxuXHRcdFx0XHQvLyBjYXVzZWQgc3B1cmlvdXMgYXV0b25vbW91cyB0dXJucyBcdTIwMTQgdGhlIG1vZGVsIHdvdWxkIGludGVycHJldCBjb21wbGV0ZWRcblx0XHRcdFx0Ly8gam9iIG91dHB1dCBhcyByZXF1aXJpbmcgYWN0aW9uIGFuZCBjYXNjYWRlIGludG8gdW5ib3VuZGVkIHNlbGYtcmVpbmZvcmNpbmdcblx0XHRcdFx0Ly8gbG9vcHMgKHJ1bm5pbmcgbW9yZSBjb21tYW5kcywgc3Bhd25pbmcgbW9yZSBqb2JzLCBidXJuaW5nIGNvbnRleHQpLlxuXHRcdFx0XHRwaS5zZW5kTWVzc2FnZShcblx0XHRcdFx0XHR7XG5cdFx0XHRcdFx0XHRjdXN0b21UeXBlOiBcImFzeW5jX2pvYl9yZXN1bHRcIixcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IFtcblx0XHRcdFx0XHRcdFx0YCoqQmFja2dyb3VuZCBqb2IgJHtzdGF0dXNFbW9qaX06ICR7am9iLmlkfSoqICgke2pvYi5sYWJlbH0sICR7ZWxhcHNlZH1zKWAsXG5cdFx0XHRcdFx0XHRcdFwiXCIsXG5cdFx0XHRcdFx0XHRcdHRydW5jYXRlZE91dHB1dCxcblx0XHRcdFx0XHRcdF0uam9pbihcIlxcblwiKSxcblx0XHRcdFx0XHRcdGRpc3BsYXk6IHRydWUsXG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0XHR7IGRlbGl2ZXJBczogXCJmb2xsb3dVcFwiIH0sXG5cdFx0XHRcdCk7XG5cdFx0XHR9LFxuXHRcdH0pO1xuXHR9KTtcblxuXHRwaS5vbihcInNlc3Npb25fYmVmb3JlX3N3aXRjaFwiLCBhc3luYyAoKSA9PiB7XG5cdFx0aWYgKG1hbmFnZXIpIHtcblx0XHRcdC8vIENhbmNlbCBhbGwgcnVubmluZyBiYWNrZ3JvdW5kIGpvYnMgXHUyMDE0IHRoZWlyIHJlc3VsdHMgYXJlIG5vIGxvbmdlclxuXHRcdFx0Ly8gcmVsZXZhbnQgdG8gdGhlIG5ldyBzZXNzaW9uIGFuZCB3b3VsZCBwcm9kdWNlIHdhc3RlZnVsIGZvbGxvdy11cFxuXHRcdFx0Ly8gbm90aWZpY2F0aW9ucyB0aGF0IHRyaWdnZXIgZW1wdHkgTExNIHR1cm5zICgjMTY0MikuXG5cdFx0XHRmb3IgKGNvbnN0IGpvYiBvZiBtYW5hZ2VyLmdldFJ1bm5pbmdKb2JzKCkpIHtcblx0XHRcdFx0bWFuYWdlci5jYW5jZWwoam9iLmlkKTtcblx0XHRcdH1cblx0XHR9XG5cdH0pO1xuXG5cdHBpLm9uKFwic2Vzc2lvbl9zaHV0ZG93blwiLCBhc3luYyAoKSA9PiB7XG5cdFx0aWYgKG1hbmFnZXIpIHtcblx0XHRcdG1hbmFnZXIuc2h1dGRvd24oKTtcblx0XHRcdG1hbmFnZXIgPSBudWxsO1xuXHRcdH1cblx0fSk7XG5cblx0Ly8gXHUyNTAwXHUyNTAwIFRvb2xzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5cdHBpLnJlZ2lzdGVyVG9vbChjcmVhdGVBc3luY0Jhc2hUb29sKGdldE1hbmFnZXIsIGdldEN3ZCkpO1xuXHRwaS5yZWdpc3RlclRvb2woY3JlYXRlQXdhaXRUb29sKGdldE1hbmFnZXIpKTtcblx0cGkucmVnaXN0ZXJUb29sKGNyZWF0ZUNhbmNlbEpvYlRvb2woZ2V0TWFuYWdlcikpO1xuXG5cdC8vIFx1MjUwMFx1MjUwMCAvam9icyBjb21tYW5kIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5cdHBpLnJlZ2lzdGVyQ29tbWFuZChcImpvYnNcIiwge1xuXHRcdGRlc2NyaXB0aW9uOiBcIlNob3cgcnVubmluZyBhbmQgcmVjZW50IGJhY2tncm91bmQgam9ic1wiLFxuXHRcdGhhbmRsZXI6IGFzeW5jIChfYXJnczogc3RyaW5nLCBfY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCkgPT4ge1xuXHRcdFx0aWYgKCFtYW5hZ2VyKSB7XG5cdFx0XHRcdHBpLnNlbmRNZXNzYWdlKHtcblx0XHRcdFx0XHRjdXN0b21UeXBlOiBcImFzeW5jX2pvYnNfbGlzdFwiLFxuXHRcdFx0XHRcdGNvbnRlbnQ6IFwiTm8gYXN5bmMgam9iIG1hbmFnZXIgYWN0aXZlLlwiLFxuXHRcdFx0XHRcdGRpc3BsYXk6IHRydWUsXG5cdFx0XHRcdH0pO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IHJ1bm5pbmcgPSBtYW5hZ2VyLmdldFJ1bm5pbmdKb2JzKCk7XG5cdFx0XHRjb25zdCByZWNlbnQgPSBtYW5hZ2VyLmdldFJlY2VudEpvYnMoMTApO1xuXHRcdFx0Y29uc3QgY29tcGxldGVkID0gcmVjZW50LmZpbHRlcigoaikgPT4gai5zdGF0dXMgIT09IFwicnVubmluZ1wiKTtcblxuXHRcdFx0Y29uc3QgbGluZXM6IHN0cmluZ1tdID0gW1wiIyMgQmFja2dyb3VuZCBKb2JzXCJdO1xuXG5cdFx0XHRpZiAocnVubmluZy5sZW5ndGggPT09IDAgJiYgY29tcGxldGVkLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0XHRsaW5lcy5wdXNoKFwiXCIsIFwiTm8gYmFja2dyb3VuZCBqb2JzLlwiKTtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdGlmIChydW5uaW5nLmxlbmd0aCA+IDApIHtcblx0XHRcdFx0XHRsaW5lcy5wdXNoKFwiXCIsIFwiIyMjIFJ1bm5pbmdcIik7XG5cdFx0XHRcdFx0Zm9yIChjb25zdCBqb2Igb2YgcnVubmluZykge1xuXHRcdFx0XHRcdFx0Y29uc3QgZWxhcHNlZCA9ICgoRGF0ZS5ub3coKSAtIGpvYi5zdGFydFRpbWUpIC8gMTAwMCkudG9GaXhlZCgwKTtcblx0XHRcdFx0XHRcdGxpbmVzLnB1c2goYC0gKioke2pvYi5pZH0qKiBcdTIwMTQgJHtqb2IubGFiZWx9ICgke2VsYXBzZWR9cylgKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRpZiAoY29tcGxldGVkLmxlbmd0aCA+IDApIHtcblx0XHRcdFx0XHRsaW5lcy5wdXNoKFwiXCIsIFwiIyMjIFJlY2VudFwiKTtcblx0XHRcdFx0XHRmb3IgKGNvbnN0IGpvYiBvZiBjb21wbGV0ZWQpIHtcblx0XHRcdFx0XHRcdGNvbnN0IGVsYXBzZWQgPSAoKERhdGUubm93KCkgLSBqb2Iuc3RhcnRUaW1lKSAvIDEwMDApLnRvRml4ZWQoMSk7XG5cdFx0XHRcdFx0XHRsaW5lcy5wdXNoKGAtICoqJHtqb2IuaWR9KiogXHUyMDE0ICR7am9iLmxhYmVsfSAoJHtqb2Iuc3RhdHVzfSwgJHtlbGFwc2VkfXMpYCk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdHBpLnNlbmRNZXNzYWdlKHtcblx0XHRcdFx0Y3VzdG9tVHlwZTogXCJhc3luY19qb2JzX2xpc3RcIixcblx0XHRcdFx0Y29udGVudDogbGluZXMuam9pbihcIlxcblwiKSxcblx0XHRcdFx0ZGlzcGxheTogdHJ1ZSxcblx0XHRcdH0pO1xuXHRcdH0sXG5cdH0pO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBaUJBLFNBQVMsdUJBQWlDO0FBQzFDLFNBQVMsMkJBQTJCO0FBQ3BDLFNBQVMsdUJBQXVCO0FBQ2hDLFNBQVMsMkJBQTJCO0FBRXJCLFNBQVIsVUFBMkIsSUFBa0I7QUFDbkQsTUFBSSxVQUFrQztBQUN0QyxNQUFJLFlBQW9CLFFBQVEsSUFBSTtBQUVwQyxXQUFTLGFBQThCO0FBQ3RDLFFBQUksQ0FBQyxTQUFTO0FBQ2IsWUFBTSxJQUFJLE1BQU0sMERBQTBEO0FBQUEsSUFDM0U7QUFDQSxXQUFPO0FBQUEsRUFDUjtBQUVBLFdBQVMsU0FBaUI7QUFDekIsV0FBTztBQUFBLEVBQ1I7QUFJQSxLQUFHLEdBQUcsaUJBQWlCLE9BQU8sUUFBUSxRQUFRO0FBQzdDLGdCQUFZLElBQUk7QUFFaEIsY0FBVSxJQUFJLGdCQUFnQjtBQUFBLE1BQzdCLGVBQWUsQ0FBQyxRQUFRO0FBQ3ZCLFlBQUksSUFBSSxRQUFTO0FBQ2pCLGNBQU0sY0FBYyxJQUFJLFdBQVcsY0FBYyxTQUFTO0FBQzFELGNBQU0sWUFBWSxLQUFLLElBQUksSUFBSSxJQUFJLGFBQWEsS0FBTSxRQUFRLENBQUM7QUFDL0QsY0FBTSxTQUFTLElBQUksV0FBVyxjQUMzQixJQUFJLGNBQWMsZ0JBQ2xCLFVBQVUsSUFBSSxhQUFhLGVBQWU7QUFHN0MsY0FBTSxTQUFTO0FBQ2YsY0FBTSxrQkFBa0IsT0FBTyxTQUFTLFNBQ3JDLE9BQU8sTUFBTSxHQUFHLE1BQU0sSUFBSSx1REFDMUI7QUFVSCxXQUFHO0FBQUEsVUFDRjtBQUFBLFlBQ0MsWUFB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
