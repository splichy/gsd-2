function matchesScope(unitId, scope) {
  if (!scope) return true;
  if (unitId === "project" || unitId === "environment") return true;
  return unitId === scope || unitId.startsWith(`${scope}/`) || unitId.startsWith(`${scope}`);
}
function summarizeDoctorIssues(issues) {
  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.filter((issue) => issue.severity === "warning").length;
  const infos = issues.filter((issue) => issue.severity === "info").length;
  const fixable = issues.filter((issue) => issue.fixable).length;
  const byCodeMap = /* @__PURE__ */ new Map();
  for (const issue of issues) {
    byCodeMap.set(issue.code, (byCodeMap.get(issue.code) ?? 0) + 1);
  }
  const byCode = [...byCodeMap.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  return { total: issues.length, errors, warnings, infos, fixable, byCode };
}
function filterDoctorIssues(issues, options) {
  let filtered = issues;
  if (options?.scope) filtered = filtered.filter((issue) => matchesScope(issue.unitId, options.scope));
  if (!options?.includeWarnings) filtered = filtered.filter((issue) => issue.severity === "error");
  return filtered;
}
function formatDoctorReport(report, options) {
  const scopedIssues = filterDoctorIssues(report.issues, {
    scope: options?.scope,
    includeWarnings: options?.includeWarnings ?? true
  });
  const summary = summarizeDoctorIssues(scopedIssues);
  const maxIssues = options?.maxIssues ?? 12;
  const lines = [];
  lines.push(options?.title ?? (summary.errors > 0 ? "GSD doctor found blocking issues." : "GSD doctor report."));
  lines.push(`Scope: ${options?.scope ?? "all milestones"}`);
  lines.push(`Issues: ${summary.total} total \xB7 ${summary.errors} error(s) \xB7 ${summary.warnings} warning(s) \xB7 ${summary.fixable} fixable`);
  if (summary.byCode.length > 0) {
    lines.push("Top issue types:");
    for (const item of summary.byCode.slice(0, 5)) {
      lines.push(`- ${item.code}: ${item.count}`);
    }
  }
  if (scopedIssues.length > 0) {
    lines.push("Priority issues:");
    for (const issue of scopedIssues.slice(0, maxIssues)) {
      const prefix = issue.severity === "error" ? "ERROR" : issue.severity === "warning" ? "WARN" : "INFO";
      lines.push(`- [${prefix}] ${issue.unitId}: ${issue.message}${issue.file ? ` (${issue.file})` : ""}`);
    }
    if (scopedIssues.length > maxIssues) {
      lines.push(`- ...and ${scopedIssues.length - maxIssues} more in scope`);
    }
  }
  if (report.fixesApplied.length > 0) {
    lines.push("Fixes applied:");
    for (const fix of report.fixesApplied.slice(0, maxIssues)) lines.push(`- ${fix}`);
    if (report.fixesApplied.length > maxIssues) lines.push(`- ...and ${report.fixesApplied.length - maxIssues} more`);
  }
  return lines.join("\n");
}
function formatDoctorIssuesForPrompt(issues) {
  if (issues.length === 0) return "- No remaining issues in scope.";
  return issues.map((issue) => {
    const prefix = issue.severity === "error" ? "ERROR" : issue.severity === "warning" ? "WARN" : "INFO";
    return `- [${prefix}] ${issue.unitId} | ${issue.code} | ${issue.message}${issue.file ? ` | file: ${issue.file}` : ""} | fixable: ${issue.fixable ? "yes" : "no"}`;
  }).join("\n");
}
function formatDoctorReportJson(report) {
  return JSON.stringify(
    {
      ok: report.ok,
      basePath: report.basePath,
      generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      summary: summarizeDoctorIssues(report.issues),
      issues: report.issues,
      fixesApplied: report.fixesApplied,
      ...report.timing ? { timing: report.timing } : {}
    },
    null,
    2
  );
}
export {
  filterDoctorIssues,
  formatDoctorIssuesForPrompt,
  formatDoctorReport,
  formatDoctorReportJson,
  summarizeDoctorIssues
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9kb2N0b3ItZm9ybWF0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdHlwZSB7IERvY3Rvcklzc3VlLCBEb2N0b3JJc3N1ZUNvZGUsIERvY3RvclJlcG9ydCwgRG9jdG9yU3VtbWFyeSB9IGZyb20gXCIuL2RvY3Rvci10eXBlcy5qc1wiO1xuXG5mdW5jdGlvbiBtYXRjaGVzU2NvcGUodW5pdElkOiBzdHJpbmcsIHNjb3BlPzogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGlmICghc2NvcGUpIHJldHVybiB0cnVlO1xuICBpZiAodW5pdElkID09PSBcInByb2plY3RcIiB8fCB1bml0SWQgPT09IFwiZW52aXJvbm1lbnRcIikgcmV0dXJuIHRydWU7XG4gIHJldHVybiB1bml0SWQgPT09IHNjb3BlIHx8IHVuaXRJZC5zdGFydHNXaXRoKGAke3Njb3BlfS9gKSB8fCB1bml0SWQuc3RhcnRzV2l0aChgJHtzY29wZX1gKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHN1bW1hcml6ZURvY3Rvcklzc3Vlcyhpc3N1ZXM6IERvY3Rvcklzc3VlW10pOiBEb2N0b3JTdW1tYXJ5IHtcbiAgY29uc3QgZXJyb3JzID0gaXNzdWVzLmZpbHRlcihpc3N1ZSA9PiBpc3N1ZS5zZXZlcml0eSA9PT0gXCJlcnJvclwiKS5sZW5ndGg7XG4gIGNvbnN0IHdhcm5pbmdzID0gaXNzdWVzLmZpbHRlcihpc3N1ZSA9PiBpc3N1ZS5zZXZlcml0eSA9PT0gXCJ3YXJuaW5nXCIpLmxlbmd0aDtcbiAgY29uc3QgaW5mb3MgPSBpc3N1ZXMuZmlsdGVyKGlzc3VlID0+IGlzc3VlLnNldmVyaXR5ID09PSBcImluZm9cIikubGVuZ3RoO1xuICBjb25zdCBmaXhhYmxlID0gaXNzdWVzLmZpbHRlcihpc3N1ZSA9PiBpc3N1ZS5maXhhYmxlKS5sZW5ndGg7XG4gIGNvbnN0IGJ5Q29kZU1hcCA9IG5ldyBNYXA8RG9jdG9ySXNzdWVDb2RlLCBudW1iZXI+KCk7XG4gIGZvciAoY29uc3QgaXNzdWUgb2YgaXNzdWVzKSB7XG4gICAgYnlDb2RlTWFwLnNldChpc3N1ZS5jb2RlLCAoYnlDb2RlTWFwLmdldChpc3N1ZS5jb2RlKSA/PyAwKSArIDEpO1xuICB9XG4gIGNvbnN0IGJ5Q29kZSA9IFsuLi5ieUNvZGVNYXAuZW50cmllcygpXVxuICAgIC5tYXAoKFtjb2RlLCBjb3VudF0pID0+ICh7IGNvZGUsIGNvdW50IH0pKVxuICAgIC5zb3J0KChhLCBiKSA9PiBiLmNvdW50IC0gYS5jb3VudCB8fCBhLmNvZGUubG9jYWxlQ29tcGFyZShiLmNvZGUpKTtcbiAgcmV0dXJuIHsgdG90YWw6IGlzc3Vlcy5sZW5ndGgsIGVycm9ycywgd2FybmluZ3MsIGluZm9zLCBmaXhhYmxlLCBieUNvZGUgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGZpbHRlckRvY3Rvcklzc3Vlcyhpc3N1ZXM6IERvY3Rvcklzc3VlW10sIG9wdGlvbnM/OiB7IHNjb3BlPzogc3RyaW5nOyBpbmNsdWRlV2FybmluZ3M/OiBib29sZWFuOyBpbmNsdWRlSGlzdG9yaWNhbD86IGJvb2xlYW4gfSk6IERvY3Rvcklzc3VlW10ge1xuICBsZXQgZmlsdGVyZWQgPSBpc3N1ZXM7XG4gIGlmIChvcHRpb25zPy5zY29wZSkgZmlsdGVyZWQgPSBmaWx0ZXJlZC5maWx0ZXIoaXNzdWUgPT4gbWF0Y2hlc1Njb3BlKGlzc3VlLnVuaXRJZCwgb3B0aW9ucy5zY29wZSkpO1xuICBpZiAoIW9wdGlvbnM/LmluY2x1ZGVXYXJuaW5ncykgZmlsdGVyZWQgPSBmaWx0ZXJlZC5maWx0ZXIoaXNzdWUgPT4gaXNzdWUuc2V2ZXJpdHkgPT09IFwiZXJyb3JcIik7XG4gIHJldHVybiBmaWx0ZXJlZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdERvY3RvclJlcG9ydChcbiAgcmVwb3J0OiBEb2N0b3JSZXBvcnQsXG4gIG9wdGlvbnM/OiB7IHNjb3BlPzogc3RyaW5nOyBpbmNsdWRlV2FybmluZ3M/OiBib29sZWFuOyBtYXhJc3N1ZXM/OiBudW1iZXI7IHRpdGxlPzogc3RyaW5nIH0sXG4pOiBzdHJpbmcge1xuICBjb25zdCBzY29wZWRJc3N1ZXMgPSBmaWx0ZXJEb2N0b3JJc3N1ZXMocmVwb3J0Lmlzc3Vlcywge1xuICAgIHNjb3BlOiBvcHRpb25zPy5zY29wZSxcbiAgICBpbmNsdWRlV2FybmluZ3M6IG9wdGlvbnM/LmluY2x1ZGVXYXJuaW5ncyA/PyB0cnVlLFxuICB9KTtcbiAgY29uc3Qgc3VtbWFyeSA9IHN1bW1hcml6ZURvY3Rvcklzc3VlcyhzY29wZWRJc3N1ZXMpO1xuICBjb25zdCBtYXhJc3N1ZXMgPSBvcHRpb25zPy5tYXhJc3N1ZXMgPz8gMTI7XG4gIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICBsaW5lcy5wdXNoKG9wdGlvbnM/LnRpdGxlID8/IChzdW1tYXJ5LmVycm9ycyA+IDAgPyBcIkdTRCBkb2N0b3IgZm91bmQgYmxvY2tpbmcgaXNzdWVzLlwiIDogXCJHU0QgZG9jdG9yIHJlcG9ydC5cIikpO1xuICBsaW5lcy5wdXNoKGBTY29wZTogJHtvcHRpb25zPy5zY29wZSA/PyBcImFsbCBtaWxlc3RvbmVzXCJ9YCk7XG4gIGxpbmVzLnB1c2goYElzc3VlczogJHtzdW1tYXJ5LnRvdGFsfSB0b3RhbCBcdTAwQjcgJHtzdW1tYXJ5LmVycm9yc30gZXJyb3IocykgXHUwMEI3ICR7c3VtbWFyeS53YXJuaW5nc30gd2FybmluZyhzKSBcdTAwQjcgJHtzdW1tYXJ5LmZpeGFibGV9IGZpeGFibGVgKTtcblxuICBpZiAoc3VtbWFyeS5ieUNvZGUubGVuZ3RoID4gMCkge1xuICAgIGxpbmVzLnB1c2goXCJUb3AgaXNzdWUgdHlwZXM6XCIpO1xuICAgIGZvciAoY29uc3QgaXRlbSBvZiBzdW1tYXJ5LmJ5Q29kZS5zbGljZSgwLCA1KSkge1xuICAgICAgbGluZXMucHVzaChgLSAke2l0ZW0uY29kZX06ICR7aXRlbS5jb3VudH1gKTtcbiAgICB9XG4gIH1cblxuICBpZiAoc2NvcGVkSXNzdWVzLmxlbmd0aCA+IDApIHtcbiAgICBsaW5lcy5wdXNoKFwiUHJpb3JpdHkgaXNzdWVzOlwiKTtcbiAgICBmb3IgKGNvbnN0IGlzc3VlIG9mIHNjb3BlZElzc3Vlcy5zbGljZSgwLCBtYXhJc3N1ZXMpKSB7XG4gICAgICBjb25zdCBwcmVmaXggPSBpc3N1ZS5zZXZlcml0eSA9PT0gXCJlcnJvclwiID8gXCJFUlJPUlwiIDogaXNzdWUuc2V2ZXJpdHkgPT09IFwid2FybmluZ1wiID8gXCJXQVJOXCIgOiBcIklORk9cIjtcbiAgICAgIGxpbmVzLnB1c2goYC0gWyR7cHJlZml4fV0gJHtpc3N1ZS51bml0SWR9OiAke2lzc3VlLm1lc3NhZ2V9JHtpc3N1ZS5maWxlID8gYCAoJHtpc3N1ZS5maWxlfSlgIDogXCJcIn1gKTtcbiAgICB9XG4gICAgaWYgKHNjb3BlZElzc3Vlcy5sZW5ndGggPiBtYXhJc3N1ZXMpIHtcbiAgICAgIGxpbmVzLnB1c2goYC0gLi4uYW5kICR7c2NvcGVkSXNzdWVzLmxlbmd0aCAtIG1heElzc3Vlc30gbW9yZSBpbiBzY29wZWApO1xuICAgIH1cbiAgfVxuXG4gIGlmIChyZXBvcnQuZml4ZXNBcHBsaWVkLmxlbmd0aCA+IDApIHtcbiAgICBsaW5lcy5wdXNoKFwiRml4ZXMgYXBwbGllZDpcIik7XG4gICAgZm9yIChjb25zdCBmaXggb2YgcmVwb3J0LmZpeGVzQXBwbGllZC5zbGljZSgwLCBtYXhJc3N1ZXMpKSBsaW5lcy5wdXNoKGAtICR7Zml4fWApO1xuICAgIGlmIChyZXBvcnQuZml4ZXNBcHBsaWVkLmxlbmd0aCA+IG1heElzc3VlcykgbGluZXMucHVzaChgLSAuLi5hbmQgJHtyZXBvcnQuZml4ZXNBcHBsaWVkLmxlbmd0aCAtIG1heElzc3Vlc30gbW9yZWApO1xuICB9XG5cbiAgcmV0dXJuIGxpbmVzLmpvaW4oXCJcXG5cIik7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXREb2N0b3JJc3N1ZXNGb3JQcm9tcHQoaXNzdWVzOiBEb2N0b3JJc3N1ZVtdKTogc3RyaW5nIHtcbiAgaWYgKGlzc3Vlcy5sZW5ndGggPT09IDApIHJldHVybiBcIi0gTm8gcmVtYWluaW5nIGlzc3VlcyBpbiBzY29wZS5cIjtcbiAgcmV0dXJuIGlzc3Vlcy5tYXAoaXNzdWUgPT4ge1xuICAgIGNvbnN0IHByZWZpeCA9IGlzc3VlLnNldmVyaXR5ID09PSBcImVycm9yXCIgPyBcIkVSUk9SXCIgOiBpc3N1ZS5zZXZlcml0eSA9PT0gXCJ3YXJuaW5nXCIgPyBcIldBUk5cIiA6IFwiSU5GT1wiO1xuICAgIHJldHVybiBgLSBbJHtwcmVmaXh9XSAke2lzc3VlLnVuaXRJZH0gfCAke2lzc3VlLmNvZGV9IHwgJHtpc3N1ZS5tZXNzYWdlfSR7aXNzdWUuZmlsZSA/IGAgfCBmaWxlOiAke2lzc3VlLmZpbGV9YCA6IFwiXCJ9IHwgZml4YWJsZTogJHtpc3N1ZS5maXhhYmxlID8gXCJ5ZXNcIiA6IFwibm9cIn1gO1xuICB9KS5qb2luKFwiXFxuXCIpO1xufVxuXG4vKipcbiAqIFNlcmlhbGl6ZSBhIGRvY3RvciByZXBvcnQgdG8gSlNPTiBcdTIwMTQgc3VpdGFibGUgZm9yIENJL3Rvb2xpbmcgaW50ZWdyYXRpb24uXG4gKiBVc2FnZTogL2dzZCBkb2N0b3IgLS1qc29uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXREb2N0b3JSZXBvcnRKc29uKHJlcG9ydDogRG9jdG9yUmVwb3J0KTogc3RyaW5nIHtcbiAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KFxuICAgIHtcbiAgICAgIG9rOiByZXBvcnQub2ssXG4gICAgICBiYXNlUGF0aDogcmVwb3J0LmJhc2VQYXRoLFxuICAgICAgZ2VuZXJhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgIHN1bW1hcnk6IHN1bW1hcml6ZURvY3Rvcklzc3VlcyhyZXBvcnQuaXNzdWVzKSxcbiAgICAgIGlzc3VlczogcmVwb3J0Lmlzc3VlcyxcbiAgICAgIGZpeGVzQXBwbGllZDogcmVwb3J0LmZpeGVzQXBwbGllZCxcbiAgICAgIC4uLihyZXBvcnQudGltaW5nID8geyB0aW1pbmc6IHJlcG9ydC50aW1pbmcgfSA6IHt9KSxcbiAgICB9LFxuICAgIG51bGwsXG4gICAgMixcbiAgKTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUVBLFNBQVMsYUFBYSxRQUFnQixPQUF5QjtBQUM3RCxNQUFJLENBQUMsTUFBTyxRQUFPO0FBQ25CLE1BQUksV0FBVyxhQUFhLFdBQVcsY0FBZSxRQUFPO0FBQzdELFNBQU8sV0FBVyxTQUFTLE9BQU8sV0FBVyxHQUFHLEtBQUssR0FBRyxLQUFLLE9BQU8sV0FBVyxHQUFHLEtBQUssRUFBRTtBQUMzRjtBQUVPLFNBQVMsc0JBQXNCLFFBQXNDO0FBQzFFLFFBQU0sU0FBUyxPQUFPLE9BQU8sV0FBUyxNQUFNLGFBQWEsT0FBTyxFQUFFO0FBQ2xFLFFBQU0sV0FBVyxPQUFPLE9BQU8sV0FBUyxNQUFNLGFBQWEsU0FBUyxFQUFFO0FBQ3RFLFFBQU0sUUFBUSxPQUFPLE9BQU8sV0FBUyxNQUFNLGFBQWEsTUFBTSxFQUFFO0FBQ2hFLFFBQU0sVUFBVSxPQUFPLE9BQU8sV0FBUyxNQUFNLE9BQU8sRUFBRTtBQUN0RCxRQUFNLFlBQVksb0JBQUksSUFBNkI7QUFDbkQsYUFBVyxTQUFTLFFBQVE7QUFDMUIsY0FBVSxJQUFJLE1BQU0sT0FBTyxVQUFVLElBQUksTUFBTSxJQUFJLEtBQUssS0FBSyxDQUFDO0FBQUEsRUFDaEU7QUFDQSxRQUFNLFNBQVMsQ0FBQyxHQUFHLFVBQVUsUUFBUSxDQUFDLEVBQ25DLElBQUksQ0FBQyxDQUFDLE1BQU0sS0FBSyxPQUFPLEVBQUUsTUFBTSxNQUFNLEVBQUUsRUFDeEMsS0FBSyxDQUFDLEdBQUcsTUFBTSxFQUFFLFFBQVEsRUFBRSxTQUFTLEVBQUUsS0FBSyxjQUFjLEVBQUUsSUFBSSxDQUFDO0FBQ25FLFNBQU8sRUFBRSxPQUFPLE9BQU8sUUFBUSxRQUFRLFVBQVUsT0FBTyxTQUFTLE9BQU87QUFDMUU7QUFFTyxTQUFTLG1CQUFtQixRQUF1QixTQUFxRztBQUM3SixNQUFJLFdBQVc7QUFDZixNQUFJLFNBQVMsTUFBTyxZQUFXLFNBQVMsT0FBTyxXQUFTLGFBQWEsTUFBTSxRQUFRLFFBQVEsS0FBSyxDQUFDO0FBQ2pHLE1BQUksQ0FBQyxTQUFTLGdCQUFpQixZQUFXLFNBQVMsT0FBTyxXQUFTLE1BQU0sYUFBYSxPQUFPO0FBQzdGLFNBQU87QUFDVDtBQUVPLFNBQVMsbUJBQ2QsUUFDQSxTQUNRO0FBQ1IsUUFBTSxlQUFlLG1CQUFtQixPQUFPLFFBQVE7QUFBQSxJQUNyRCxPQUFPLFNBQVM7QUFBQSxJQUNoQixpQkFBaUIsU0FBUyxtQkFBbUI7QUFBQSxFQUMvQyxDQUFDO0FBQ0QsUUFBTSxVQUFVLHNCQUFzQixZQUFZO0FBQ2xELFFBQU0sWUFBWSxTQUFTLGFBQWE7QUFDeEMsUUFBTSxRQUFrQixDQUFDO0FBQ3pCLFFBQU0sS0FBSyxTQUFTLFVBQVUsUUFBUSxTQUFTLElBQUksc0NBQXNDLHFCQUFxQjtBQUM5RyxRQUFNLEtBQUssVUFBVSxTQUFTLFNBQVMsZ0JBQWdCLEVBQUU7QUFDekQsUUFBTSxLQUFLLFdBQVcsUUFBUSxLQUFLLGVBQVksUUFBUSxNQUFNLGtCQUFlLFFBQVEsUUFBUSxvQkFBaUIsUUFBUSxPQUFPLFVBQVU7QUFFdEksTUFBSSxRQUFRLE9BQU8sU0FBUyxHQUFHO0FBQzdCLFVBQU0sS0FBSyxrQkFBa0I7QUFDN0IsZUFBVyxRQUFRLFFBQVEsT0FBTyxNQUFNLEdBQUcsQ0FBQyxHQUFHO0FBQzdDLFlBQU0sS0FBSyxLQUFLLEtBQUssSUFBSSxLQUFLLEtBQUssS0FBSyxFQUFFO0FBQUEsSUFDNUM7QUFBQSxFQUNGO0FBRUEsTUFBSSxhQUFhLFNBQVMsR0FBRztBQUMzQixVQUFNLEtBQUssa0JBQWtCO0FBQzdCLGVBQVcsU0FBUyxhQUFhLE1BQU0sR0FBRyxTQUFTLEdBQUc7QUFDcEQsWUFBTSxTQUFTLE1BQU0sYUFBYSxVQUFVLFVBQVUsTUFBTSxhQUFhLFlBQVksU0FBUztBQUM5RixZQUFNLEtBQUssTUFBTSxNQUFNLEtBQUssTUFBTSxNQUFNLEtBQUssTUFBTSxPQUFPLEdBQUcsTUFBTSxPQUFPLEtBQUssTUFBTSxJQUFJLE1BQU0sRUFBRSxFQUFFO0FBQUEsSUFDckc7QUFDQSxRQUFJLGFBQWEsU0FBUyxXQUFXO0FBQ25DLFlBQU0sS0FBSyxZQUFZLGFBQWEsU0FBUyxTQUFTLGdCQUFnQjtBQUFBLElBQ3hFO0FBQUEsRUFDRjtBQUVBLE1BQUksT0FBTyxhQUFhLFNBQVMsR0FBRztBQUNsQyxVQUFNLEtBQUssZ0JBQWdCO0FBQzNCLGVBQVcsT0FBTyxPQUFPLGFBQWEsTUFBTSxHQUFHLFNBQVMsRUFBRyxPQUFNLEtBQUssS0FBSyxHQUFHLEVBQUU7QUFDaEYsUUFBSSxPQUFPLGFBQWEsU0FBUyxVQUFXLE9BQU0sS0FBSyxZQUFZLE9BQU8sYUFBYSxTQUFTLFNBQVMsT0FBTztBQUFBLEVBQ2xIO0FBRUEsU0FBTyxNQUFNLEtBQUssSUFBSTtBQUN4QjtBQUVPLFNBQVMsNEJBQTRCLFFBQStCO0FBQ3pFLE1BQUksT0FBTyxXQUFXLEVBQUcsUUFBTztBQUNoQyxTQUFPLE9BQU8sSUFBSSxXQUFTO0FBQ3pCLFVBQU0sU0FBUyxNQUFNLGFBQWEsVUFBVSxVQUFVLE1BQU0sYUFBYSxZQUFZLFNBQVM7QUFDOUYsV0FBTyxNQUFNLE1BQU0sS0FBSyxNQUFNLE1BQU0sTUFBTSxNQUFNLElBQUksTUFBTSxNQUFNLE9BQU8sR0FBRyxNQUFNLE9BQU8sWUFBWSxNQUFNLElBQUksS0FBSyxFQUFFLGVBQWUsTUFBTSxVQUFVLFFBQVEsSUFBSTtBQUFBLEVBQ2pLLENBQUMsRUFBRSxLQUFLLElBQUk7QUFDZDtBQU1PLFNBQVMsdUJBQXVCLFFBQThCO0FBQ25FLFNBQU8sS0FBSztBQUFBLElBQ1Y7QUFBQSxNQUNFLElBQUksT0FBTztBQUFBLE1BQ1gsVUFBVSxPQUFPO0FBQUEsTUFDakIsY0FBYSxvQkFBSSxLQUFLLEdBQUUsWUFBWTtBQUFBLE1BQ3BDLFNBQVMsc0JBQXNCLE9BQU8sTUFBTTtBQUFBLE1BQzVDLFFBQVEsT0FBTztBQUFBLE1BQ2YsY0FBYyxPQUFPO0FBQUEsTUFDckIsR0FBSSxPQUFPLFNBQVMsRUFBRSxRQUFRLE9BQU8sT0FBTyxJQUFJLENBQUM7QUFBQSxJQUNuRDtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsRUFDRjtBQUNGOyIsCiAgIm5hbWVzIjogW10KfQo=
