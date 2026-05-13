import { bootstrapSync } from "./sync.js";
import { loadSyncMapping } from "./mapping.js";
import { ghIsAvailable } from "./cli.js";
function github_sync_default(pi) {
  pi.registerCommand("github-sync", {
    description: "Bootstrap GitHub sync or show sync status",
    handler: async (args, ctx) => {
      const subcommand = args.trim().toLowerCase();
      if (subcommand === "status") {
        await showStatus(ctx);
        return;
      }
      if (subcommand === "bootstrap" || subcommand === "") {
        await runBootstrap(ctx);
        return;
      }
      ctx.ui.notify(
        "Usage: /github-sync [bootstrap|status]",
        "info"
      );
    }
  });
}
async function showStatus(ctx) {
  if (!ghIsAvailable()) {
    ctx.ui.notify("GitHub sync: `gh` CLI not installed or not authenticated.", "warning");
    return;
  }
  const mapping = loadSyncMapping(ctx.cwd);
  if (!mapping) {
    ctx.ui.notify("GitHub sync: No sync mapping found. Run `/github-sync bootstrap` to initialize.", "info");
    return;
  }
  const milestoneCount = Object.keys(mapping.milestones).length;
  const sliceCount = Object.keys(mapping.slices).length;
  const taskCount = Object.keys(mapping.tasks).length;
  const openMilestones = Object.values(mapping.milestones).filter((m) => m.state === "open").length;
  const openSlices = Object.values(mapping.slices).filter((s) => s.state === "open").length;
  const openTasks = Object.values(mapping.tasks).filter((t) => t.state === "open").length;
  ctx.ui.notify(
    [
      `GitHub sync: repo=${mapping.repo}`,
      `  Milestones: ${milestoneCount} (${openMilestones} open)`,
      `  Slices: ${sliceCount} (${openSlices} open)`,
      `  Tasks: ${taskCount} (${openTasks} open)`
    ].join("\n"),
    "info"
  );
}
async function runBootstrap(ctx) {
  if (!ghIsAvailable()) {
    ctx.ui.notify("GitHub sync: `gh` CLI not installed or not authenticated.", "warning");
    return;
  }
  ctx.ui.notify("GitHub sync: bootstrapping...", "info");
  try {
    const counts = await bootstrapSync(ctx.cwd);
    if (counts.milestones === 0 && counts.slices === 0 && counts.tasks === 0) {
      ctx.ui.notify("GitHub sync: everything already synced (or no milestones found).", "info");
    } else {
      ctx.ui.notify(
        `GitHub sync: created ${counts.milestones} milestone(s), ${counts.slices} slice(s), ${counts.tasks} task(s).`,
        "info"
      );
    }
  } catch (err) {
    ctx.ui.notify(`GitHub sync bootstrap failed: ${err}`, "error");
  }
}
export {
  github_sync_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dpdGh1Yi1zeW5jL2luZGV4LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIEdpdEh1YiBTeW5jIGV4dGVuc2lvbiBmb3IgR1NELlxuICpcbiAqIE9wdC1pbiBleHRlbnNpb24gdGhhdCBzeW5jcyBHU0QgbGlmZWN5Y2xlIGV2ZW50cyB0byBHaXRIdWI6XG4gKiBtaWxlc3RvbmVzIFx1MjE5MiBHSCBNaWxlc3RvbmVzICsgdHJhY2tpbmcgaXNzdWVzLCBzbGljZXMgXHUyMTkyIGRyYWZ0IFBScyxcbiAqIHRhc2tzIFx1MjE5MiBzdWItaXNzdWVzIHdpdGggYXV0by1jbG9zZSBvbiBjb21taXQuXG4gKlxuICogSW50ZWdyYXRpb24gaGFwcGVucyB2aWEgYSBzaW5nbGUgZHluYW1pYyBpbXBvcnQgaW4gYXV0by1wb3N0LXVuaXQudHMuXG4gKiBUaGlzIGluZGV4IHJlZ2lzdGVycyBhIGAvZ2l0aHViLXN5bmNgIGNvbW1hbmQgZm9yIG1hbnVhbCBib290c3RyYXBcbiAqIGFuZCBzdGF0dXMgZGlzcGxheS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEV4dGVuc2lvbkFQSSB9IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuaW1wb3J0IHsgYm9vdHN0cmFwU3luYyB9IGZyb20gXCIuL3N5bmMuanNcIjtcbmltcG9ydCB7IGxvYWRTeW5jTWFwcGluZyB9IGZyb20gXCIuL21hcHBpbmcuanNcIjtcbmltcG9ydCB7IGdoSXNBdmFpbGFibGUgfSBmcm9tIFwiLi9jbGkuanNcIjtcblxuZXhwb3J0IGRlZmF1bHQgZnVuY3Rpb24gKHBpOiBFeHRlbnNpb25BUEkpIHtcbiAgcGkucmVnaXN0ZXJDb21tYW5kKFwiZ2l0aHViLXN5bmNcIiwge1xuICAgIGRlc2NyaXB0aW9uOiBcIkJvb3RzdHJhcCBHaXRIdWIgc3luYyBvciBzaG93IHN5bmMgc3RhdHVzXCIsXG4gICAgaGFuZGxlcjogYXN5bmMgKGFyZ3M6IHN0cmluZywgY3R4KSA9PiB7XG4gICAgICBjb25zdCBzdWJjb21tYW5kID0gYXJncy50cmltKCkudG9Mb3dlckNhc2UoKTtcblxuICAgICAgaWYgKHN1YmNvbW1hbmQgPT09IFwic3RhdHVzXCIpIHtcbiAgICAgICAgYXdhaXQgc2hvd1N0YXR1cyhjdHgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGlmIChzdWJjb21tYW5kID09PSBcImJvb3RzdHJhcFwiIHx8IHN1YmNvbW1hbmQgPT09IFwiXCIpIHtcbiAgICAgICAgYXdhaXQgcnVuQm9vdHN0cmFwKGN0eCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgXCJVc2FnZTogL2dpdGh1Yi1zeW5jIFtib290c3RyYXB8c3RhdHVzXVwiLFxuICAgICAgICBcImluZm9cIixcbiAgICAgICk7XG4gICAgfSxcbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHNob3dTdGF0dXMoY3R4OiBpbXBvcnQoXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiKS5FeHRlbnNpb25Db21tYW5kQ29udGV4dCkge1xuICBpZiAoIWdoSXNBdmFpbGFibGUoKSkge1xuICAgIGN0eC51aS5ub3RpZnkoXCJHaXRIdWIgc3luYzogYGdoYCBDTEkgbm90IGluc3RhbGxlZCBvciBub3QgYXV0aGVudGljYXRlZC5cIiwgXCJ3YXJuaW5nXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IG1hcHBpbmcgPSBsb2FkU3luY01hcHBpbmcoY3R4LmN3ZCk7XG4gIGlmICghbWFwcGluZykge1xuICAgIGN0eC51aS5ub3RpZnkoXCJHaXRIdWIgc3luYzogTm8gc3luYyBtYXBwaW5nIGZvdW5kLiBSdW4gYC9naXRodWItc3luYyBib290c3RyYXBgIHRvIGluaXRpYWxpemUuXCIsIFwiaW5mb1wiKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBtaWxlc3RvbmVDb3VudCA9IE9iamVjdC5rZXlzKG1hcHBpbmcubWlsZXN0b25lcykubGVuZ3RoO1xuICBjb25zdCBzbGljZUNvdW50ID0gT2JqZWN0LmtleXMobWFwcGluZy5zbGljZXMpLmxlbmd0aDtcbiAgY29uc3QgdGFza0NvdW50ID0gT2JqZWN0LmtleXMobWFwcGluZy50YXNrcykubGVuZ3RoO1xuICBjb25zdCBvcGVuTWlsZXN0b25lcyA9IE9iamVjdC52YWx1ZXMobWFwcGluZy5taWxlc3RvbmVzKS5maWx0ZXIobSA9PiBtLnN0YXRlID09PSBcIm9wZW5cIikubGVuZ3RoO1xuICBjb25zdCBvcGVuU2xpY2VzID0gT2JqZWN0LnZhbHVlcyhtYXBwaW5nLnNsaWNlcykuZmlsdGVyKHMgPT4gcy5zdGF0ZSA9PT0gXCJvcGVuXCIpLmxlbmd0aDtcbiAgY29uc3Qgb3BlblRhc2tzID0gT2JqZWN0LnZhbHVlcyhtYXBwaW5nLnRhc2tzKS5maWx0ZXIodCA9PiB0LnN0YXRlID09PSBcIm9wZW5cIikubGVuZ3RoO1xuXG4gIGN0eC51aS5ub3RpZnkoXG4gICAgW1xuICAgICAgYEdpdEh1YiBzeW5jOiByZXBvPSR7bWFwcGluZy5yZXBvfWAsXG4gICAgICBgICBNaWxlc3RvbmVzOiAke21pbGVzdG9uZUNvdW50fSAoJHtvcGVuTWlsZXN0b25lc30gb3BlbilgLFxuICAgICAgYCAgU2xpY2VzOiAke3NsaWNlQ291bnR9ICgke29wZW5TbGljZXN9IG9wZW4pYCxcbiAgICAgIGAgIFRhc2tzOiAke3Rhc2tDb3VudH0gKCR7b3BlblRhc2tzfSBvcGVuKWAsXG4gICAgXS5qb2luKFwiXFxuXCIpLFxuICAgIFwiaW5mb1wiLFxuICApO1xufVxuXG5hc3luYyBmdW5jdGlvbiBydW5Cb290c3RyYXAoY3R4OiBpbXBvcnQoXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiKS5FeHRlbnNpb25Db21tYW5kQ29udGV4dCkge1xuICBpZiAoIWdoSXNBdmFpbGFibGUoKSkge1xuICAgIGN0eC51aS5ub3RpZnkoXCJHaXRIdWIgc3luYzogYGdoYCBDTEkgbm90IGluc3RhbGxlZCBvciBub3QgYXV0aGVudGljYXRlZC5cIiwgXCJ3YXJuaW5nXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGN0eC51aS5ub3RpZnkoXCJHaXRIdWIgc3luYzogYm9vdHN0cmFwcGluZy4uLlwiLCBcImluZm9cIik7XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBjb3VudHMgPSBhd2FpdCBib290c3RyYXBTeW5jKGN0eC5jd2QpO1xuICAgIGlmIChjb3VudHMubWlsZXN0b25lcyA9PT0gMCAmJiBjb3VudHMuc2xpY2VzID09PSAwICYmIGNvdW50cy50YXNrcyA9PT0gMCkge1xuICAgICAgY3R4LnVpLm5vdGlmeShcIkdpdEh1YiBzeW5jOiBldmVyeXRoaW5nIGFscmVhZHkgc3luY2VkIChvciBubyBtaWxlc3RvbmVzIGZvdW5kKS5cIiwgXCJpbmZvXCIpO1xuICAgIH0gZWxzZSB7XG4gICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICBgR2l0SHViIHN5bmM6IGNyZWF0ZWQgJHtjb3VudHMubWlsZXN0b25lc30gbWlsZXN0b25lKHMpLCAke2NvdW50cy5zbGljZXN9IHNsaWNlKHMpLCAke2NvdW50cy50YXNrc30gdGFzayhzKS5gLFxuICAgICAgICBcImluZm9cIixcbiAgICAgICk7XG4gICAgfVxuICB9IGNhdGNoIChlcnIpIHtcbiAgICBjdHgudWkubm90aWZ5KGBHaXRIdWIgc3luYyBib290c3RyYXAgZmFpbGVkOiAke2Vycn1gLCBcImVycm9yXCIpO1xuICB9XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFhQSxTQUFTLHFCQUFxQjtBQUM5QixTQUFTLHVCQUF1QjtBQUNoQyxTQUFTLHFCQUFxQjtBQUVmLFNBQVIsb0JBQWtCLElBQWtCO0FBQ3pDLEtBQUcsZ0JBQWdCLGVBQWU7QUFBQSxJQUNoQyxhQUFhO0FBQUEsSUFDYixTQUFTLE9BQU8sTUFBYyxRQUFRO0FBQ3BDLFlBQU0sYUFBYSxLQUFLLEtBQUssRUFBRSxZQUFZO0FBRTNDLFVBQUksZUFBZSxVQUFVO0FBQzNCLGNBQU0sV0FBVyxHQUFHO0FBQ3BCO0FBQUEsTUFDRjtBQUVBLFVBQUksZUFBZSxlQUFlLGVBQWUsSUFBSTtBQUNuRCxjQUFNLGFBQWEsR0FBRztBQUN0QjtBQUFBLE1BQ0Y7QUFFQSxVQUFJLEdBQUc7QUFBQSxRQUNMO0FBQUEsUUFDQTtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBQUEsRUFDRixDQUFDO0FBQ0g7QUFFQSxlQUFlLFdBQVcsS0FBNkQ7QUFDckYsTUFBSSxDQUFDLGNBQWMsR0FBRztBQUNwQixRQUFJLEdBQUcsT0FBTyw2REFBNkQsU0FBUztBQUNwRjtBQUFBLEVBQ0Y7QUFFQSxRQUFNLFVBQVUsZ0JBQWdCLElBQUksR0FBRztBQUN2QyxNQUFJLENBQUMsU0FBUztBQUNaLFFBQUksR0FBRyxPQUFPLG1GQUFtRixNQUFNO0FBQ3ZHO0FBQUEsRUFDRjtBQUVBLFFBQU0saUJBQWlCLE9BQU8sS0FBSyxRQUFRLFVBQVUsRUFBRTtBQUN2RCxRQUFNLGFBQWEsT0FBTyxLQUFLLFFBQVEsTUFBTSxFQUFFO0FBQy9DLFFBQU0sWUFBWSxPQUFPLEtBQUssUUFBUSxLQUFLLEVBQUU7QUFDN0MsUUFBTSxpQkFBaUIsT0FBTyxPQUFPLFFBQVEsVUFBVSxFQUFFLE9BQU8sT0FBSyxFQUFFLFVBQVUsTUFBTSxFQUFFO0FBQ3pGLFFBQU0sYUFBYSxPQUFPLE9BQU8sUUFBUSxNQUFNLEVBQUUsT0FBTyxPQUFLLEVBQUUsVUFBVSxNQUFNLEVBQUU7QUFDakYsUUFBTSxZQUFZLE9BQU8sT0FBTyxRQUFRLEtBQUssRUFBRSxPQUFPLE9BQUssRUFBRSxVQUFVLE1BQU0sRUFBRTtBQUUvRSxNQUFJLEdBQUc7QUFBQSxJQUNMO0FBQUEsTUFDRSxxQkFBcUIsUUFBUSxJQUFJO0FBQUEsTUFDakMsaUJBQWlCLGNBQWMsS0FBSyxjQUFjO0FBQUEsTUFDbEQsYUFBYSxVQUFVLEtBQUssVUFBVTtBQUFBLE1BQ3RDLFlBQVksU0FBUyxLQUFLLFNBQVM7QUFBQSxJQUNyQyxFQUFFLEtBQUssSUFBSTtBQUFBLElBQ1g7QUFBQSxFQUNGO0FBQ0Y7QUFFQSxlQUFlLGFBQWEsS0FBNkQ7QUFDdkYsTUFBSSxDQUFDLGNBQWMsR0FBRztBQUNwQixRQUFJLEdBQUcsT0FBTyw2REFBNkQsU0FBUztBQUNwRjtBQUFBLEVBQ0Y7QUFFQSxNQUFJLEdBQUcsT0FBTyxpQ0FBaUMsTUFBTTtBQUVyRCxNQUFJO0FBQ0YsVUFBTSxTQUFTLE1BQU0sY0FBYyxJQUFJLEdBQUc7QUFDMUMsUUFBSSxPQUFPLGVBQWUsS0FBSyxPQUFPLFdBQVcsS0FBSyxPQUFPLFVBQVUsR0FBRztBQUN4RSxVQUFJLEdBQUcsT0FBTyxvRUFBb0UsTUFBTTtBQUFBLElBQzFGLE9BQU87QUFDTCxVQUFJLEdBQUc7QUFBQSxRQUNMLHdCQUF3QixPQUFPLFVBQVUsa0JBQWtCLE9BQU8sTUFBTSxjQUFjLE9BQU8sS0FBSztBQUFBLFFBQ2xHO0FBQUEsTUFDRjtBQUFBLElBQ0Y7QUFBQSxFQUNGLFNBQVMsS0FBSztBQUNaLFFBQUksR0FBRyxPQUFPLGlDQUFpQyxHQUFHLElBQUksT0FBTztBQUFBLEVBQy9EO0FBQ0Y7IiwKICAibmFtZXMiOiBbXQp9Cg==
