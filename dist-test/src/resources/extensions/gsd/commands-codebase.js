import {
  generateCodebaseMap,
  updateCodebaseMap,
  writeCodebaseMap,
  getCodebaseMapStats,
  readCodebaseMap
} from "./codebase-generator.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { currentDirectoryRoot } from "./commands/context.js";
const USAGE = 'Usage: /gsd codebase [generate|update|stats]\n\n  generate [--max-files N] [--collapse-threshold N]  \u2014 Generate or regenerate CODEBASE.md\n  update [--max-files N] [--collapse-threshold N]    \u2014 Refresh the CODEBASE.md cache immediately\n  stats                                              \u2014 Show file count, coverage, and generation time\n  help                                               \u2014 Show this help\n\nWith no subcommand, shows stats if a map exists or help if not.\nGSD also refreshes CODEBASE.md automatically before prompt injection and after completed units when tracked files change.\n\nConfigure defaults via preferences.md:\n  codebase:\n    exclude_patterns: ["docs/", "fixtures/"]\n    max_files: 1000\n    collapse_threshold: 15';
async function handleCodebase(args, ctx, _pi) {
  const basePath = currentDirectoryRoot();
  const parts = args.trim().split(/\s+/);
  const sub = parts[0] ?? "";
  switch (sub) {
    case "generate": {
      const options = resolveCodebaseOptions(args, ctx);
      if (options === false) return;
      const existing = readCodebaseMap(basePath);
      const existingDescriptions = existing ? (await import("./codebase-generator.js")).parseCodebaseMap(existing) : void 0;
      const result = generateCodebaseMap(basePath, options, existingDescriptions);
      if (result.fileCount === 0) {
        ctx.ui.notify(
          "Codebase map generated with 0 files.\nIs this a git repository? Run 'git ls-files' to verify.",
          "warning"
        );
        return;
      }
      const outPath = writeCodebaseMap(basePath, result.content);
      ctx.ui.notify(
        `Codebase map generated: ${result.fileCount} files
Written to: ${outPath}` + (result.truncated ? `
\u26A0 Truncated \u2014 increase --max-files to include all files` : ""),
        "success"
      );
      return;
    }
    case "update": {
      const existing = readCodebaseMap(basePath);
      if (!existing) {
        ctx.ui.notify(
          "No codebase map found. Run /gsd codebase generate to create one.",
          "warning"
        );
        return;
      }
      const options = resolveCodebaseOptions(args, ctx);
      if (options === false) return;
      const result = updateCodebaseMap(basePath, options);
      writeCodebaseMap(basePath, result.content);
      ctx.ui.notify(
        `Codebase map updated: ${result.fileCount} files
  Added: ${result.added} | Removed: ${result.removed} | Unchanged: ${result.unchanged}` + (result.truncated ? `
\u26A0 Truncated \u2014 increase --max-files to include all files` : ""),
        "success"
      );
      return;
    }
    case "stats": {
      showStats(basePath, ctx);
      return;
    }
    case "help":
      ctx.ui.notify(USAGE, "info");
      return;
    case "": {
      const existing = readCodebaseMap(basePath);
      if (existing) {
        showStats(basePath, ctx);
      } else {
        ctx.ui.notify(USAGE, "info");
      }
      return;
    }
    default:
      ctx.ui.notify(
        `Unknown subcommand "${sub}".

${USAGE}`,
        "warning"
      );
  }
}
function showStats(basePath, ctx) {
  const stats = getCodebaseMapStats(basePath);
  if (!stats.exists) {
    ctx.ui.notify("No codebase map found. Run /gsd codebase generate to create one.", "info");
    return;
  }
  const coverage = stats.fileCount > 0 ? Math.round(stats.describedCount / stats.fileCount * 100) : 0;
  ctx.ui.notify(
    `Codebase Map Stats:
  Files: ${stats.fileCount}
  Described: ${stats.describedCount} (${coverage}%)
  Undescribed: ${stats.undescribedCount}
  Generated: ${stats.generatedAt ?? "unknown"}

` + (stats.undescribedCount > 0 ? `Tip: Auto-refresh keeps the cache current, but /gsd codebase update forces an immediate refresh.` : `Coverage is complete.`),
    "info"
  );
}
function resolveCodebaseOptions(args, ctx) {
  const prefs = loadEffectiveGSDPreferences()?.preferences?.codebase;
  const maxFilesStr = extractFlag(args, "--max-files");
  const collapseStr = extractFlag(args, "--collapse-threshold");
  let maxFiles;
  if (maxFilesStr) {
    maxFiles = parseInt(maxFilesStr, 10);
    if (isNaN(maxFiles) || maxFiles < 1) {
      ctx.ui.notify("--max-files must be a positive integer (e.g. --max-files 200).", "warning");
      return false;
    }
  }
  let collapseThreshold;
  if (collapseStr) {
    collapseThreshold = parseInt(collapseStr, 10);
    if (isNaN(collapseThreshold) || collapseThreshold < 1) {
      ctx.ui.notify("--collapse-threshold must be a positive integer (e.g. --collapse-threshold 15).", "warning");
      return false;
    }
  }
  return {
    // CLI flags override preferences
    maxFiles: maxFiles ?? prefs?.max_files,
    collapseThreshold: collapseThreshold ?? prefs?.collapse_threshold,
    excludePatterns: prefs?.exclude_patterns
  };
}
function extractFlag(args, flag) {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`${escaped}[=\\s]+(\\S+)`);
  const match = args.match(regex);
  return match?.[1];
}
export {
  handleCodebase
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9jb21tYW5kcy1jb2RlYmFzZS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBHU0QgQ29tbWFuZCBcdTIwMTQgL2dzZCBjb2RlYmFzZVxuICpcbiAqIEdlbmVyYXRlIGFuZCBtYW5hZ2UgdGhlIGNvZGViYXNlIG1hcCAoLmdzZC9DT0RFQkFTRS5tZCkuXG4gKiBTdWJjb21tYW5kczogZ2VuZXJhdGUsIHVwZGF0ZSwgc3RhdHMsIGhlbHBcbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEV4dGVuc2lvbkFQSSwgRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcblxuaW1wb3J0IHtcbiAgZ2VuZXJhdGVDb2RlYmFzZU1hcCxcbiAgdXBkYXRlQ29kZWJhc2VNYXAsXG4gIHdyaXRlQ29kZWJhc2VNYXAsXG4gIGdldENvZGViYXNlTWFwU3RhdHMsXG4gIHJlYWRDb2RlYmFzZU1hcCxcbn0gZnJvbSBcIi4vY29kZWJhc2UtZ2VuZXJhdG9yLmpzXCI7XG5pbXBvcnQgeyBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMgfSBmcm9tIFwiLi9wcmVmZXJlbmNlcy5qc1wiO1xuaW1wb3J0IHR5cGUgeyBDb2RlYmFzZU1hcE9wdGlvbnMgfSBmcm9tIFwiLi9jb2RlYmFzZS1nZW5lcmF0b3IuanNcIjtcbmltcG9ydCB7IGN1cnJlbnREaXJlY3RvcnlSb290IH0gZnJvbSBcIi4vY29tbWFuZHMvY29udGV4dC5qc1wiO1xuXG5jb25zdCBVU0FHRSA9XG4gIFwiVXNhZ2U6IC9nc2QgY29kZWJhc2UgW2dlbmVyYXRlfHVwZGF0ZXxzdGF0c11cXG5cXG5cIiArXG4gIFwiICBnZW5lcmF0ZSBbLS1tYXgtZmlsZXMgTl0gWy0tY29sbGFwc2UtdGhyZXNob2xkIE5dICBcdTIwMTQgR2VuZXJhdGUgb3IgcmVnZW5lcmF0ZSBDT0RFQkFTRS5tZFxcblwiICtcbiAgXCIgIHVwZGF0ZSBbLS1tYXgtZmlsZXMgTl0gWy0tY29sbGFwc2UtdGhyZXNob2xkIE5dICAgIFx1MjAxNCBSZWZyZXNoIHRoZSBDT0RFQkFTRS5tZCBjYWNoZSBpbW1lZGlhdGVseVxcblwiICtcbiAgXCIgIHN0YXRzICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFx1MjAxNCBTaG93IGZpbGUgY291bnQsIGNvdmVyYWdlLCBhbmQgZ2VuZXJhdGlvbiB0aW1lXFxuXCIgK1xuICBcIiAgaGVscCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXHUyMDE0IFNob3cgdGhpcyBoZWxwXFxuXFxuXCIgK1xuICBcIldpdGggbm8gc3ViY29tbWFuZCwgc2hvd3Mgc3RhdHMgaWYgYSBtYXAgZXhpc3RzIG9yIGhlbHAgaWYgbm90LlxcblwiICtcbiAgXCJHU0QgYWxzbyByZWZyZXNoZXMgQ09ERUJBU0UubWQgYXV0b21hdGljYWxseSBiZWZvcmUgcHJvbXB0IGluamVjdGlvbiBhbmQgYWZ0ZXIgY29tcGxldGVkIHVuaXRzIHdoZW4gdHJhY2tlZCBmaWxlcyBjaGFuZ2UuXFxuXFxuXCIgK1xuICBcIkNvbmZpZ3VyZSBkZWZhdWx0cyB2aWEgcHJlZmVyZW5jZXMubWQ6XFxuXCIgK1xuICBcIiAgY29kZWJhc2U6XFxuXCIgK1xuICBcIiAgICBleGNsdWRlX3BhdHRlcm5zOiBbXFxcImRvY3MvXFxcIiwgXFxcImZpeHR1cmVzL1xcXCJdXFxuXCIgK1xuICBcIiAgICBtYXhfZmlsZXM6IDEwMDBcXG5cIiArXG4gIFwiICAgIGNvbGxhcHNlX3RocmVzaG9sZDogMTVcIjtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZUNvZGViYXNlKFxuICBhcmdzOiBzdHJpbmcsXG4gIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsXG4gIF9waTogRXh0ZW5zaW9uQVBJLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGJhc2VQYXRoID0gY3VycmVudERpcmVjdG9yeVJvb3QoKTtcbiAgY29uc3QgcGFydHMgPSBhcmdzLnRyaW0oKS5zcGxpdCgvXFxzKy8pO1xuICBjb25zdCBzdWIgPSBwYXJ0c1swXSA/PyBcIlwiO1xuXG4gIHN3aXRjaCAoc3ViKSB7XG4gICAgY2FzZSBcImdlbmVyYXRlXCI6IHtcbiAgICAgIGNvbnN0IG9wdGlvbnMgPSByZXNvbHZlQ29kZWJhc2VPcHRpb25zKGFyZ3MsIGN0eCk7XG4gICAgICBpZiAob3B0aW9ucyA9PT0gZmFsc2UpIHJldHVybjsgLy8gdmFsaWRhdGlvbiBmYWlsZWQsIG1lc3NhZ2UgYWxyZWFkeSBzaG93blxuXG4gICAgICBjb25zdCBleGlzdGluZyA9IHJlYWRDb2RlYmFzZU1hcChiYXNlUGF0aCk7XG4gICAgICBjb25zdCBleGlzdGluZ0Rlc2NyaXB0aW9ucyA9IGV4aXN0aW5nXG4gICAgICAgID8gKGF3YWl0IGltcG9ydChcIi4vY29kZWJhc2UtZ2VuZXJhdG9yLmpzXCIpKS5wYXJzZUNvZGViYXNlTWFwKGV4aXN0aW5nKVxuICAgICAgICA6IHVuZGVmaW5lZDtcblxuICAgICAgY29uc3QgcmVzdWx0ID0gZ2VuZXJhdGVDb2RlYmFzZU1hcChiYXNlUGF0aCwgb3B0aW9ucywgZXhpc3RpbmdEZXNjcmlwdGlvbnMpO1xuXG4gICAgICBpZiAocmVzdWx0LmZpbGVDb3VudCA9PT0gMCkge1xuICAgICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICAgIFwiQ29kZWJhc2UgbWFwIGdlbmVyYXRlZCB3aXRoIDAgZmlsZXMuXFxuXCIgK1xuICAgICAgICAgIFwiSXMgdGhpcyBhIGdpdCByZXBvc2l0b3J5PyBSdW4gJ2dpdCBscy1maWxlcycgdG8gdmVyaWZ5LlwiLFxuICAgICAgICAgIFwid2FybmluZ1wiLFxuICAgICAgICApO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IG91dFBhdGggPSB3cml0ZUNvZGViYXNlTWFwKGJhc2VQYXRoLCByZXN1bHQuY29udGVudCk7XG4gICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICBgQ29kZWJhc2UgbWFwIGdlbmVyYXRlZDogJHtyZXN1bHQuZmlsZUNvdW50fSBmaWxlc1xcbmAgK1xuICAgICAgICBgV3JpdHRlbiB0bzogJHtvdXRQYXRofWAgK1xuICAgICAgICAocmVzdWx0LnRydW5jYXRlZCA/IGBcXG5cdTI2QTAgVHJ1bmNhdGVkIFx1MjAxNCBpbmNyZWFzZSAtLW1heC1maWxlcyB0byBpbmNsdWRlIGFsbCBmaWxlc2AgOiBcIlwiKSxcbiAgICAgICAgXCJzdWNjZXNzXCIsXG4gICAgICApO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNhc2UgXCJ1cGRhdGVcIjoge1xuICAgICAgY29uc3QgZXhpc3RpbmcgPSByZWFkQ29kZWJhc2VNYXAoYmFzZVBhdGgpO1xuICAgICAgaWYgKCFleGlzdGluZykge1xuICAgICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICAgIFwiTm8gY29kZWJhc2UgbWFwIGZvdW5kLiBSdW4gL2dzZCBjb2RlYmFzZSBnZW5lcmF0ZSB0byBjcmVhdGUgb25lLlwiLFxuICAgICAgICAgIFwid2FybmluZ1wiLFxuICAgICAgICApO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IG9wdGlvbnMgPSByZXNvbHZlQ29kZWJhc2VPcHRpb25zKGFyZ3MsIGN0eCk7XG4gICAgICBpZiAob3B0aW9ucyA9PT0gZmFsc2UpIHJldHVybjtcblxuICAgICAgY29uc3QgcmVzdWx0ID0gdXBkYXRlQ29kZWJhc2VNYXAoYmFzZVBhdGgsIG9wdGlvbnMpO1xuICAgICAgd3JpdGVDb2RlYmFzZU1hcChiYXNlUGF0aCwgcmVzdWx0LmNvbnRlbnQpO1xuXG4gICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICBgQ29kZWJhc2UgbWFwIHVwZGF0ZWQ6ICR7cmVzdWx0LmZpbGVDb3VudH0gZmlsZXNcXG5gICtcbiAgICAgICAgYCAgQWRkZWQ6ICR7cmVzdWx0LmFkZGVkfSB8IFJlbW92ZWQ6ICR7cmVzdWx0LnJlbW92ZWR9IHwgVW5jaGFuZ2VkOiAke3Jlc3VsdC51bmNoYW5nZWR9YCArXG4gICAgICAgIChyZXN1bHQudHJ1bmNhdGVkID8gYFxcblx1MjZBMCBUcnVuY2F0ZWQgXHUyMDE0IGluY3JlYXNlIC0tbWF4LWZpbGVzIHRvIGluY2x1ZGUgYWxsIGZpbGVzYCA6IFwiXCIpLFxuICAgICAgICBcInN1Y2Nlc3NcIixcbiAgICAgICk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY2FzZSBcInN0YXRzXCI6IHtcbiAgICAgIHNob3dTdGF0cyhiYXNlUGF0aCwgY3R4KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjYXNlIFwiaGVscFwiOlxuICAgICAgY3R4LnVpLm5vdGlmeShVU0FHRSwgXCJpbmZvXCIpO1xuICAgICAgcmV0dXJuO1xuXG4gICAgY2FzZSBcIlwiOiB7XG4gICAgICAvLyBTYWZlIGRlZmF1bHQ6IHNob3cgc3RhdHMgaWYgbWFwIGV4aXN0cywgaGVscCBpZiBub3RcbiAgICAgIGNvbnN0IGV4aXN0aW5nID0gcmVhZENvZGViYXNlTWFwKGJhc2VQYXRoKTtcbiAgICAgIGlmIChleGlzdGluZykge1xuICAgICAgICBzaG93U3RhdHMoYmFzZVBhdGgsIGN0eCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjdHgudWkubm90aWZ5KFVTQUdFLCBcImluZm9cIik7XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgZGVmYXVsdDpcbiAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgIGBVbmtub3duIHN1YmNvbW1hbmQgXCIke3N1Yn1cIi5cXG5cXG4ke1VTQUdFfWAsXG4gICAgICAgIFwid2FybmluZ1wiLFxuICAgICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBzaG93U3RhdHMoYmFzZVBhdGg6IHN0cmluZywgY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCk6IHZvaWQge1xuICBjb25zdCBzdGF0cyA9IGdldENvZGViYXNlTWFwU3RhdHMoYmFzZVBhdGgpO1xuICBpZiAoIXN0YXRzLmV4aXN0cykge1xuICAgIGN0eC51aS5ub3RpZnkoXCJObyBjb2RlYmFzZSBtYXAgZm91bmQuIFJ1biAvZ3NkIGNvZGViYXNlIGdlbmVyYXRlIHRvIGNyZWF0ZSBvbmUuXCIsIFwiaW5mb1wiKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBjb3ZlcmFnZSA9IHN0YXRzLmZpbGVDb3VudCA+IDBcbiAgICA/IE1hdGgucm91bmQoKHN0YXRzLmRlc2NyaWJlZENvdW50IC8gc3RhdHMuZmlsZUNvdW50KSAqIDEwMClcbiAgICA6IDA7XG5cbiAgY3R4LnVpLm5vdGlmeShcbiAgICBgQ29kZWJhc2UgTWFwIFN0YXRzOlxcbmAgK1xuICAgIGAgIEZpbGVzOiAke3N0YXRzLmZpbGVDb3VudH1cXG5gICtcbiAgICBgICBEZXNjcmliZWQ6ICR7c3RhdHMuZGVzY3JpYmVkQ291bnR9ICgke2NvdmVyYWdlfSUpXFxuYCArXG4gICAgYCAgVW5kZXNjcmliZWQ6ICR7c3RhdHMudW5kZXNjcmliZWRDb3VudH1cXG5gICtcbiAgICBgICBHZW5lcmF0ZWQ6ICR7c3RhdHMuZ2VuZXJhdGVkQXQgPz8gXCJ1bmtub3duXCJ9XFxuXFxuYCArXG4gICAgKHN0YXRzLnVuZGVzY3JpYmVkQ291bnQgPiAwXG4gICAgICA/IGBUaXA6IEF1dG8tcmVmcmVzaCBrZWVwcyB0aGUgY2FjaGUgY3VycmVudCwgYnV0IC9nc2QgY29kZWJhc2UgdXBkYXRlIGZvcmNlcyBhbiBpbW1lZGlhdGUgcmVmcmVzaC5gXG4gICAgICA6IGBDb3ZlcmFnZSBpcyBjb21wbGV0ZS5gKSxcbiAgICBcImluZm9cIixcbiAgKTtcbn1cblxuLyoqXG4gKiBSZXNvbHZlIGNvZGViYXNlIG1hcCBvcHRpb25zIGJ5IG1lcmdpbmcgcHJlZmVyZW5jZXMgd2l0aCBDTEkgZmxhZ3MuXG4gKiBDTEkgZmxhZ3Mgb3ZlcnJpZGUgcHJlZmVyZW5jZXM7IHByZWZlcmVuY2VzIG92ZXJyaWRlIGJ1aWx0LWluIGRlZmF1bHRzLlxuICogUmV0dXJucyBmYWxzZSBpZiB2YWxpZGF0aW9uIGZhaWxlZCAoZXJyb3IgYWxyZWFkeSBzaG93biB0byB1c2VyKS5cbiAqL1xuZnVuY3Rpb24gcmVzb2x2ZUNvZGViYXNlT3B0aW9ucyhhcmdzOiBzdHJpbmcsIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQpOiBDb2RlYmFzZU1hcE9wdGlvbnMgfCBmYWxzZSB7XG4gIC8vIExvYWQgcHJlZmVyZW5jZXMgZGVmYXVsdHNcbiAgY29uc3QgcHJlZnMgPSBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMoKT8ucHJlZmVyZW5jZXM/LmNvZGViYXNlO1xuXG4gIC8vIFBhcnNlIENMSSBmbGFnc1xuICBjb25zdCBtYXhGaWxlc1N0ciA9IGV4dHJhY3RGbGFnKGFyZ3MsIFwiLS1tYXgtZmlsZXNcIik7XG4gIGNvbnN0IGNvbGxhcHNlU3RyID0gZXh0cmFjdEZsYWcoYXJncywgXCItLWNvbGxhcHNlLXRocmVzaG9sZFwiKTtcblxuICAvLyBWYWxpZGF0ZSAtLW1heC1maWxlc1xuICBsZXQgbWF4RmlsZXM6IG51bWJlciB8IHVuZGVmaW5lZDtcbiAgaWYgKG1heEZpbGVzU3RyKSB7XG4gICAgbWF4RmlsZXMgPSBwYXJzZUludChtYXhGaWxlc1N0ciwgMTApO1xuICAgIGlmIChpc05hTihtYXhGaWxlcykgfHwgbWF4RmlsZXMgPCAxKSB7XG4gICAgICBjdHgudWkubm90aWZ5KFwiLS1tYXgtZmlsZXMgbXVzdCBiZSBhIHBvc2l0aXZlIGludGVnZXIgKGUuZy4gLS1tYXgtZmlsZXMgMjAwKS5cIiwgXCJ3YXJuaW5nXCIpO1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgfVxuXG4gIC8vIFZhbGlkYXRlIC0tY29sbGFwc2UtdGhyZXNob2xkXG4gIGxldCBjb2xsYXBzZVRocmVzaG9sZDogbnVtYmVyIHwgdW5kZWZpbmVkO1xuICBpZiAoY29sbGFwc2VTdHIpIHtcbiAgICBjb2xsYXBzZVRocmVzaG9sZCA9IHBhcnNlSW50KGNvbGxhcHNlU3RyLCAxMCk7XG4gICAgaWYgKGlzTmFOKGNvbGxhcHNlVGhyZXNob2xkKSB8fCBjb2xsYXBzZVRocmVzaG9sZCA8IDEpIHtcbiAgICAgIGN0eC51aS5ub3RpZnkoXCItLWNvbGxhcHNlLXRocmVzaG9sZCBtdXN0IGJlIGEgcG9zaXRpdmUgaW50ZWdlciAoZS5nLiAtLWNvbGxhcHNlLXRocmVzaG9sZCAxNSkuXCIsIFwid2FybmluZ1wiKTtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4ge1xuICAgIC8vIENMSSBmbGFncyBvdmVycmlkZSBwcmVmZXJlbmNlc1xuICAgIG1heEZpbGVzOiBtYXhGaWxlcyA/PyBwcmVmcz8ubWF4X2ZpbGVzLFxuICAgIGNvbGxhcHNlVGhyZXNob2xkOiBjb2xsYXBzZVRocmVzaG9sZCA/PyBwcmVmcz8uY29sbGFwc2VfdGhyZXNob2xkLFxuICAgIGV4Y2x1ZGVQYXR0ZXJuczogcHJlZnM/LmV4Y2x1ZGVfcGF0dGVybnMsXG4gIH07XG59XG5cbmZ1bmN0aW9uIGV4dHJhY3RGbGFnKGFyZ3M6IHN0cmluZywgZmxhZzogc3RyaW5nKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgZXNjYXBlZCA9IGZsYWcucmVwbGFjZSgvWy4qKz9eJHt9KCl8W1xcXVxcXFxdL2csIFwiXFxcXCQmXCIpO1xuICBjb25zdCByZWdleCA9IG5ldyBSZWdFeHAoYCR7ZXNjYXBlZH1bPVxcXFxzXSsoXFxcXFMrKWApO1xuICBjb25zdCBtYXRjaCA9IGFyZ3MubWF0Y2gocmVnZXgpO1xuICByZXR1cm4gbWF0Y2g/LlsxXTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQVNBO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1AsU0FBUyxtQ0FBbUM7QUFFNUMsU0FBUyw0QkFBNEI7QUFFckMsTUFBTSxRQUNKO0FBYUYsZUFBc0IsZUFDcEIsTUFDQSxLQUNBLEtBQ2U7QUFDZixR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
