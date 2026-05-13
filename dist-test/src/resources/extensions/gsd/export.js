import { writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { execFile } from "node:child_process";
import {
  getLedger,
  getProjectTotals,
  aggregateByPhase,
  aggregateBySlice,
  aggregateByModel,
  formatCost,
  formatTokenCount,
  loadLedgerFromDisk
} from "./metrics.js";
import { gsdRoot } from "./paths.js";
import { formatDuration, fileLink } from "../shared/format-utils.js";
import { getErrorMessage } from "./error-utils.js";
function openInBrowser(filePath) {
  if (process.platform === "win32") {
    execFile("powershell", ["-c", `Start-Process '${filePath.replace(/'/g, "''")}'`], () => {
    });
  } else {
    const cmd = process.platform === "darwin" ? "open" : "xdg-open";
    execFile(cmd, [filePath], () => {
    });
  }
}
function writeExportFile(basePath, format, visualizerData) {
  const ledger = getLedger();
  let units;
  if (visualizerData && visualizerData.units.length > 0) {
    units = visualizerData.units;
  } else if (ledger && ledger.units.length > 0) {
    units = ledger.units;
  } else {
    const diskLedger = loadLedgerFromDisk(basePath);
    if (!diskLedger || diskLedger.units.length === 0) return null;
    units = diskLedger.units;
  }
  const projectName = basename(basePath);
  const exportDir = gsdRoot(basePath);
  mkdirSync(exportDir, { recursive: true });
  const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  if (format === "json") {
    const report = {
      exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
      project: projectName,
      totals: visualizerData?.totals ?? getProjectTotals(units),
      byPhase: visualizerData?.byPhase ?? aggregateByPhase(units),
      bySlice: visualizerData?.bySlice ?? aggregateBySlice(units),
      byModel: visualizerData?.byModel ?? aggregateByModel(units),
      units
    };
    const outPath = join(exportDir, `export-${timestamp}.json`);
    writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf-8");
    return outPath;
  } else {
    const totals = visualizerData?.totals ?? getProjectTotals(units);
    const phases = visualizerData?.byPhase ?? aggregateByPhase(units);
    const slices = visualizerData?.bySlice ?? aggregateBySlice(units);
    const md = [
      `# GSD Session Report \u2014 ${projectName}`,
      ``,
      `**Generated**: ${(/* @__PURE__ */ new Date()).toISOString()}`,
      `**Units completed**: ${totals.units}`,
      `**Total cost**: ${formatCost(totals.cost)}`,
      `**Total tokens**: ${formatTokenCount(totals.tokens.total)}`,
      `**Total duration**: ${formatDuration(totals.duration)}`,
      `**Tool calls**: ${totals.toolCalls}`,
      ``,
      `## Cost by Phase`,
      ``,
      `| Phase | Units | Cost | Tokens | Duration |`,
      `|-------|-------|------|--------|----------|`,
      ...phases.map(
        (p) => `| ${p.phase} | ${p.units} | ${formatCost(p.cost)} | ${formatTokenCount(p.tokens.total)} | ${formatDuration(p.duration)} |`
      ),
      ``,
      `## Cost by Slice`,
      ``,
      `| Slice | Units | Cost | Tokens | Duration |`,
      `|-------|-------|------|--------|----------|`,
      ...slices.map(
        (s) => `| ${s.sliceId} | ${s.units} | ${formatCost(s.cost)} | ${formatTokenCount(s.tokens.total)} | ${formatDuration(s.duration)} |`
      ),
      ``
    ].join("\n");
    const outPath = join(exportDir, `export-${timestamp}.md`);
    writeFileSync(outPath, md, "utf-8");
    return outPath;
  }
}
async function handleExport(args, ctx, basePath) {
  if (args.includes("--html")) {
    const generateAll = args.includes("--all");
    try {
      const { loadVisualizerData } = await import("./visualizer-data.js");
      const { generateHtmlReport } = await import("./export-html.js");
      const { writeReportSnapshot, loadReportsIndex } = await import("./reports.js");
      const { basename: bn } = await import("node:path");
      const data = await loadVisualizerData(basePath);
      const projName = basename(basePath);
      const gsdVersion = process.env.GSD_VERSION ?? "0.0.0";
      const doneMilestones = data.milestones.filter((m) => m.status === "complete").length;
      const htmlOpts = {
        projectName: projName,
        projectPath: basePath,
        gsdVersion,
        indexRelPath: "index.html"
      };
      if (generateAll) {
        const existing = loadReportsIndex(basePath);
        const existingIds = new Set(existing?.entries.map((e) => e.milestoneId) ?? []);
        const targets = data.milestones.filter((m) => !existingIds.has(m.id));
        if (targets.length === 0) {
          ctx.ui.notify(
            "All milestones already have report snapshots. Run without --all to create a new snapshot for the active milestone.",
            "info"
          );
          return;
        }
        const html = generateHtmlReport(data, htmlOpts);
        const paths = [];
        for (const ms of targets) {
          const msSlicesDone = ms.slices.filter((sl) => sl.done).length;
          const msSlicesTotal = ms.slices.length;
          const msIdx = data.milestones.indexOf(ms);
          let cumulativeDone = 0;
          let cumulativeTotal = 0;
          for (let i = 0; i <= msIdx; i++) {
            cumulativeDone += data.milestones[i].slices.filter((sl) => sl.done).length;
            cumulativeTotal += data.milestones[i].slices.length;
          }
          const outPath = writeReportSnapshot({
            basePath,
            html,
            milestoneId: ms.id,
            milestoneTitle: ms.title,
            kind: ms.status === "complete" ? "milestone" : "manual",
            projectName: projName,
            projectPath: basePath,
            gsdVersion,
            totalCost: data.totals?.cost ?? 0,
            totalTokens: data.totals?.tokens.total ?? 0,
            totalDuration: data.totals?.duration ?? 0,
            doneSlices: cumulativeDone,
            totalSlices: cumulativeTotal,
            doneMilestones: data.milestones.slice(0, msIdx + 1).filter((m) => m.status === "complete").length,
            totalMilestones: data.milestones.length,
            phase: ms.status === "complete" ? "complete" : data.phase
          });
          paths.push(bn(outPath));
        }
        const indexPath = join(gsdRoot(basePath), "reports", "index.html");
        ctx.ui.notify(
          `Generated ${paths.length} report snapshot${paths.length !== 1 ? "s" : ""}:
${paths.map((p) => `  ${p}`).join("\n")}
Opening reports index in browser...`,
          "success"
        );
        openInBrowser(indexPath);
      } else {
        const doneSlices = data.milestones.reduce((s, m) => s + m.slices.filter((sl) => sl.done).length, 0);
        const totalSlices = data.milestones.reduce((s, m) => s + m.slices.length, 0);
        const outPath = writeReportSnapshot({
          basePath,
          html: generateHtmlReport(data, htmlOpts),
          milestoneId: data.milestones.find((m) => m.status === "active")?.id ?? "manual",
          milestoneTitle: data.milestones.find((m) => m.status === "active")?.title ?? "",
          kind: "manual",
          projectName: projName,
          projectPath: basePath,
          gsdVersion,
          totalCost: data.totals?.cost ?? 0,
          totalTokens: data.totals?.tokens.total ?? 0,
          totalDuration: data.totals?.duration ?? 0,
          doneSlices,
          totalSlices,
          doneMilestones,
          totalMilestones: data.milestones.length,
          phase: data.phase
        });
        ctx.ui.notify(
          `HTML report saved: .gsd/reports/${bn(outPath)}
Opening in browser...`,
          "success"
        );
        openInBrowser(outPath);
      }
    } catch (err) {
      ctx.ui.notify(
        `HTML export failed: ${getErrorMessage(err)}`,
        "error"
      );
    }
    return;
  }
  const format = args.includes("--json") ? "json" : "markdown";
  const ledger = getLedger();
  let units;
  if (ledger && ledger.units.length > 0) {
    units = ledger.units;
  } else {
    const { loadLedgerFromDisk: loadLedgerFromDisk2 } = await import("./metrics.js");
    const diskLedger = loadLedgerFromDisk2(basePath);
    if (!diskLedger || diskLedger.units.length === 0) {
      ctx.ui.notify("Nothing to export \u2014 no units executed yet.", "info");
      return;
    }
    units = diskLedger.units;
  }
  const projectName = basename(basePath);
  const exportDir = gsdRoot(basePath);
  mkdirSync(exportDir, { recursive: true });
  const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  if (format === "json") {
    const report = {
      exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
      project: projectName,
      totals: getProjectTotals(units),
      byPhase: aggregateByPhase(units),
      bySlice: aggregateBySlice(units),
      byModel: aggregateByModel(units),
      units
    };
    const outPath = join(exportDir, `export-${timestamp}.json`);
    writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf-8");
    ctx.ui.notify(`Exported to ${fileLink(outPath)}`, "success");
  } else {
    const totals = getProjectTotals(units);
    const phases = aggregateByPhase(units);
    const slices = aggregateBySlice(units);
    const md = [
      `# GSD Session Report \u2014 ${projectName}`,
      ``,
      `**Generated**: ${(/* @__PURE__ */ new Date()).toISOString()}`,
      `**Units completed**: ${totals.units}`,
      `**Total cost**: ${formatCost(totals.cost)}`,
      `**Total tokens**: ${formatTokenCount(totals.tokens.total)}`,
      `**Total duration**: ${formatDuration(totals.duration)}`,
      `**Tool calls**: ${totals.toolCalls}`,
      ``,
      `## Cost by Phase`,
      ``,
      `| Phase | Units | Cost | Tokens | Duration |`,
      `|-------|-------|------|--------|----------|`,
      ...phases.map(
        (p) => `| ${p.phase} | ${p.units} | ${formatCost(p.cost)} | ${formatTokenCount(p.tokens.total)} | ${formatDuration(p.duration)} |`
      ),
      ``,
      `## Cost by Slice`,
      ``,
      `| Slice | Units | Cost | Tokens | Duration |`,
      `|-------|-------|------|--------|----------|`,
      ...slices.map(
        (s) => `| ${s.sliceId} | ${s.units} | ${formatCost(s.cost)} | ${formatTokenCount(s.tokens.total)} | ${formatDuration(s.duration)} |`
      ),
      ``,
      `## Unit History`,
      ``,
      `| Type | ID | Model | Cost | Tokens | Duration |`,
      `|------|-----|-------|------|--------|----------|`,
      ...units.map(
        (u) => `| ${u.type} | ${u.id} | ${u.model.replace(/^claude-/, "")} | ${formatCost(u.cost)} | ${formatTokenCount(u.tokens.total)} | ${formatDuration(u.finishedAt - u.startedAt)} |`
      ),
      ``
    ].join("\n");
    const outPath = join(exportDir, `export-${timestamp}.md`);
    writeFileSync(outPath, md, "utf-8");
    ctx.ui.notify(`Exported to ${fileLink(outPath)}`, "success");
  }
}
export {
  handleExport,
  openInBrowser,
  writeExportFile
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9leHBvcnQudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRCBFeHRlbnNpb24gXHUyMDE0IFNlc3Npb24vTWlsZXN0b25lIEV4cG9ydFxuLy8gR2VuZXJhdGUgc2hhcmVhYmxlIHJlcG9ydHMgb2YgbWlsZXN0b25lIHdvcmsgaW4gSlNPTiBvciBtYXJrZG93biBmb3JtYXQuXG5cbmltcG9ydCB0eXBlIHsgRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB7IHdyaXRlRmlsZVN5bmMsIG1rZGlyU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luLCBiYXNlbmFtZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGV4ZWMsIGV4ZWNGaWxlIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHtcbiAgZ2V0TGVkZ2VyLCBnZXRQcm9qZWN0VG90YWxzLCBhZ2dyZWdhdGVCeVBoYXNlLCBhZ2dyZWdhdGVCeVNsaWNlLFxuICBhZ2dyZWdhdGVCeU1vZGVsLCBmb3JtYXRDb3N0LCBmb3JtYXRUb2tlbkNvdW50LCBsb2FkTGVkZ2VyRnJvbURpc2ssXG59IGZyb20gXCIuL21ldHJpY3MuanNcIjtcbmltcG9ydCB0eXBlIHsgVW5pdE1ldHJpY3MgfSBmcm9tIFwiLi9tZXRyaWNzLmpzXCI7XG5pbXBvcnQgeyBnc2RSb290IH0gZnJvbSBcIi4vcGF0aHMuanNcIjtcbmltcG9ydCB7IGZvcm1hdER1cmF0aW9uLCBmaWxlTGluayB9IGZyb20gXCIuLi9zaGFyZWQvZm9ybWF0LXV0aWxzLmpzXCI7XG5pbXBvcnQgeyBnZXRFcnJvck1lc3NhZ2UgfSBmcm9tIFwiLi9lcnJvci11dGlscy5qc1wiO1xuXG4vKipcbiAqIE9wZW4gYSBmaWxlIGluIHRoZSB1c2VyJ3MgZGVmYXVsdCBicm93c2VyLlxuICogVXNlcyBwbGF0Zm9ybS1zcGVjaWZpYyBjb21tYW5kczogYG9wZW5gIChtYWNPUyksIGB4ZGctb3BlbmAgKExpbnV4KSwgYHN0YXJ0YCAoV2luZG93cykuXG4gKiBOb24tYmxvY2tpbmcsIG5vbi1mYXRhbCBcdTIwMTQgZmFpbHVyZXMgYXJlIHNpbGVudGx5IGlnbm9yZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBvcGVuSW5Ccm93c2VyKGZpbGVQYXRoOiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIikge1xuICAgIC8vIFBvd2VyU2hlbGwncyBTdGFydC1Qcm9jZXNzIGhhbmRsZXMgcGF0aHMgd2l0aCAnJicgYW5kIHNwYWNlcyBzYWZlbHkuXG4gICAgZXhlY0ZpbGUoXCJwb3dlcnNoZWxsXCIsIFtcIi1jXCIsIGBTdGFydC1Qcm9jZXNzICcke2ZpbGVQYXRoLnJlcGxhY2UoLycvZywgXCInJ1wiKX0nYF0sICgpID0+IHt9KTtcbiAgfSBlbHNlIHtcbiAgICBjb25zdCBjbWQgPSBwcm9jZXNzLnBsYXRmb3JtID09PSBcImRhcndpblwiID8gXCJvcGVuXCIgOiBcInhkZy1vcGVuXCI7XG4gICAgZXhlY0ZpbGUoY21kLCBbZmlsZVBhdGhdLCAoKSA9PiB7fSk7XG4gIH1cbn1cblxuLyoqXG4gKiBXcml0ZSBhbiBleHBvcnQgZmlsZSBkaXJlY3RseSwgd2l0aG91dCByZXF1aXJpbmcgYW4gRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQuXG4gKiBVc2VkIGJ5IHRoZSB2aXN1YWxpemVyIG92ZXJsYXkgZXhwb3J0IHRhYi5cbiAqIFJldHVybnMgdGhlIG91dHB1dCBmaWxlIHBhdGgsIG9yIG51bGwgb24gZmFpbHVyZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdyaXRlRXhwb3J0RmlsZShcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgZm9ybWF0OiBcIm1hcmtkb3duXCIgfCBcImpzb25cIixcbiAgdmlzdWFsaXplckRhdGE/OiB7IHRvdGFsczogYW55OyBieVBoYXNlOiBhbnlbXTsgYnlTbGljZTogYW55W107IGJ5TW9kZWw6IGFueVtdOyB1bml0czogYW55W107IGNyaXRpY2FsUGF0aD86IGFueTsgcmVtYWluaW5nU2xpY2VDb3VudD86IG51bWJlciB9LFxuKTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IGxlZGdlciA9IGdldExlZGdlcigpO1xuICBsZXQgdW5pdHM6IFVuaXRNZXRyaWNzW107XG5cbiAgaWYgKHZpc3VhbGl6ZXJEYXRhICYmIHZpc3VhbGl6ZXJEYXRhLnVuaXRzLmxlbmd0aCA+IDApIHtcbiAgICB1bml0cyA9IHZpc3VhbGl6ZXJEYXRhLnVuaXRzO1xuICB9IGVsc2UgaWYgKGxlZGdlciAmJiBsZWRnZXIudW5pdHMubGVuZ3RoID4gMCkge1xuICAgIHVuaXRzID0gbGVkZ2VyLnVuaXRzO1xuICB9IGVsc2Uge1xuICAgIGNvbnN0IGRpc2tMZWRnZXIgPSBsb2FkTGVkZ2VyRnJvbURpc2soYmFzZVBhdGgpO1xuICAgIGlmICghZGlza0xlZGdlciB8fCBkaXNrTGVkZ2VyLnVuaXRzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG4gICAgdW5pdHMgPSBkaXNrTGVkZ2VyLnVuaXRzO1xuICB9XG5cbiAgY29uc3QgcHJvamVjdE5hbWUgPSBiYXNlbmFtZShiYXNlUGF0aCk7XG4gIGNvbnN0IGV4cG9ydERpciA9IGdzZFJvb3QoYmFzZVBhdGgpO1xuICBta2RpclN5bmMoZXhwb3J0RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgY29uc3QgdGltZXN0YW1wID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpLnJlcGxhY2UoL1s6Ll0vZywgXCItXCIpLnNsaWNlKDAsIDE5KTtcblxuICBpZiAoZm9ybWF0ID09PSBcImpzb25cIikge1xuICAgIGNvbnN0IHJlcG9ydCA9IHtcbiAgICAgIGV4cG9ydGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgIHByb2plY3Q6IHByb2plY3ROYW1lLFxuICAgICAgdG90YWxzOiB2aXN1YWxpemVyRGF0YT8udG90YWxzID8/IGdldFByb2plY3RUb3RhbHModW5pdHMpLFxuICAgICAgYnlQaGFzZTogdmlzdWFsaXplckRhdGE/LmJ5UGhhc2UgPz8gYWdncmVnYXRlQnlQaGFzZSh1bml0cyksXG4gICAgICBieVNsaWNlOiB2aXN1YWxpemVyRGF0YT8uYnlTbGljZSA/PyBhZ2dyZWdhdGVCeVNsaWNlKHVuaXRzKSxcbiAgICAgIGJ5TW9kZWw6IHZpc3VhbGl6ZXJEYXRhPy5ieU1vZGVsID8/IGFnZ3JlZ2F0ZUJ5TW9kZWwodW5pdHMpLFxuICAgICAgdW5pdHMsXG4gICAgfTtcbiAgICBjb25zdCBvdXRQYXRoID0gam9pbihleHBvcnREaXIsIGBleHBvcnQtJHt0aW1lc3RhbXB9Lmpzb25gKTtcbiAgICB3cml0ZUZpbGVTeW5jKG91dFBhdGgsIEpTT04uc3RyaW5naWZ5KHJlcG9ydCwgbnVsbCwgMikgKyBcIlxcblwiLCBcInV0Zi04XCIpO1xuICAgIHJldHVybiBvdXRQYXRoO1xuICB9IGVsc2Uge1xuICAgIGNvbnN0IHRvdGFscyA9IHZpc3VhbGl6ZXJEYXRhPy50b3RhbHMgPz8gZ2V0UHJvamVjdFRvdGFscyh1bml0cyk7XG4gICAgY29uc3QgcGhhc2VzID0gdmlzdWFsaXplckRhdGE/LmJ5UGhhc2UgPz8gYWdncmVnYXRlQnlQaGFzZSh1bml0cyk7XG4gICAgY29uc3Qgc2xpY2VzID0gdmlzdWFsaXplckRhdGE/LmJ5U2xpY2UgPz8gYWdncmVnYXRlQnlTbGljZSh1bml0cyk7XG5cbiAgICBjb25zdCBtZCA9IFtcbiAgICAgIGAjIEdTRCBTZXNzaW9uIFJlcG9ydCBcdTIwMTQgJHtwcm9qZWN0TmFtZX1gLFxuICAgICAgYGAsXG4gICAgICBgKipHZW5lcmF0ZWQqKjogJHtuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCl9YCxcbiAgICAgIGAqKlVuaXRzIGNvbXBsZXRlZCoqOiAke3RvdGFscy51bml0c31gLFxuICAgICAgYCoqVG90YWwgY29zdCoqOiAke2Zvcm1hdENvc3QodG90YWxzLmNvc3QpfWAsXG4gICAgICBgKipUb3RhbCB0b2tlbnMqKjogJHtmb3JtYXRUb2tlbkNvdW50KHRvdGFscy50b2tlbnMudG90YWwpfWAsXG4gICAgICBgKipUb3RhbCBkdXJhdGlvbioqOiAke2Zvcm1hdER1cmF0aW9uKHRvdGFscy5kdXJhdGlvbil9YCxcbiAgICAgIGAqKlRvb2wgY2FsbHMqKjogJHt0b3RhbHMudG9vbENhbGxzfWAsXG4gICAgICBgYCxcbiAgICAgIGAjIyBDb3N0IGJ5IFBoYXNlYCxcbiAgICAgIGBgLFxuICAgICAgYHwgUGhhc2UgfCBVbml0cyB8IENvc3QgfCBUb2tlbnMgfCBEdXJhdGlvbiB8YCxcbiAgICAgIGB8LS0tLS0tLXwtLS0tLS0tfC0tLS0tLXwtLS0tLS0tLXwtLS0tLS0tLS0tfGAsXG4gICAgICAuLi5waGFzZXMubWFwKChwOiBhbnkpID0+XG4gICAgICAgIGB8ICR7cC5waGFzZX0gfCAke3AudW5pdHN9IHwgJHtmb3JtYXRDb3N0KHAuY29zdCl9IHwgJHtmb3JtYXRUb2tlbkNvdW50KHAudG9rZW5zLnRvdGFsKX0gfCAke2Zvcm1hdER1cmF0aW9uKHAuZHVyYXRpb24pfSB8YCxcbiAgICAgICksXG4gICAgICBgYCxcbiAgICAgIGAjIyBDb3N0IGJ5IFNsaWNlYCxcbiAgICAgIGBgLFxuICAgICAgYHwgU2xpY2UgfCBVbml0cyB8IENvc3QgfCBUb2tlbnMgfCBEdXJhdGlvbiB8YCxcbiAgICAgIGB8LS0tLS0tLXwtLS0tLS0tfC0tLS0tLXwtLS0tLS0tLXwtLS0tLS0tLS0tfGAsXG4gICAgICAuLi5zbGljZXMubWFwKChzOiBhbnkpID0+XG4gICAgICAgIGB8ICR7cy5zbGljZUlkfSB8ICR7cy51bml0c30gfCAke2Zvcm1hdENvc3Qocy5jb3N0KX0gfCAke2Zvcm1hdFRva2VuQ291bnQocy50b2tlbnMudG90YWwpfSB8ICR7Zm9ybWF0RHVyYXRpb24ocy5kdXJhdGlvbil9IHxgLFxuICAgICAgKSxcbiAgICAgIGBgLFxuICAgIF0uam9pbihcIlxcblwiKTtcblxuICAgIGNvbnN0IG91dFBhdGggPSBqb2luKGV4cG9ydERpciwgYGV4cG9ydC0ke3RpbWVzdGFtcH0ubWRgKTtcbiAgICB3cml0ZUZpbGVTeW5jKG91dFBhdGgsIG1kLCBcInV0Zi04XCIpO1xuICAgIHJldHVybiBvdXRQYXRoO1xuICB9XG59XG5cbi8qKlxuICogRXhwb3J0IHNlc3Npb24vbWlsZXN0b25lIGRhdGEgdG8gSlNPTiwgbWFya2Rvd24sIG9yIEhUTUwuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBoYW5kbGVFeHBvcnQoYXJnczogc3RyaW5nLCBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LCBiYXNlUGF0aDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIC8vIEhUTUwgcmVwb3J0IFx1MjAxNCBkZWxlZ2F0ZXMgdG8gdGhlIGZ1bGwgdmlzdWFsaXplci1kYXRhIHBpcGVsaW5lXG4gIGlmIChhcmdzLmluY2x1ZGVzKFwiLS1odG1sXCIpKSB7XG4gICAgY29uc3QgZ2VuZXJhdGVBbGwgPSBhcmdzLmluY2x1ZGVzKFwiLS1hbGxcIik7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHsgbG9hZFZpc3VhbGl6ZXJEYXRhIH0gPSBhd2FpdCBpbXBvcnQoXCIuL3Zpc3VhbGl6ZXItZGF0YS5qc1wiKTtcbiAgICAgIGNvbnN0IHsgZ2VuZXJhdGVIdG1sUmVwb3J0IH0gPSBhd2FpdCBpbXBvcnQoXCIuL2V4cG9ydC1odG1sLmpzXCIpO1xuICAgICAgY29uc3QgeyB3cml0ZVJlcG9ydFNuYXBzaG90LCBsb2FkUmVwb3J0c0luZGV4IH0gPSBhd2FpdCBpbXBvcnQoXCIuL3JlcG9ydHMuanNcIik7XG4gICAgICBjb25zdCB7IGJhc2VuYW1lOiBibiB9ID0gYXdhaXQgaW1wb3J0KFwibm9kZTpwYXRoXCIpO1xuICAgICAgY29uc3QgZGF0YSA9IGF3YWl0IGxvYWRWaXN1YWxpemVyRGF0YShiYXNlUGF0aCk7XG4gICAgICBjb25zdCBwcm9qTmFtZSA9IGJhc2VuYW1lKGJhc2VQYXRoKTtcbiAgICAgIGNvbnN0IGdzZFZlcnNpb24gPSBwcm9jZXNzLmVudi5HU0RfVkVSU0lPTiA/PyBcIjAuMC4wXCI7XG4gICAgICBjb25zdCBkb25lTWlsZXN0b25lcyA9IGRhdGEubWlsZXN0b25lcy5maWx0ZXIobSA9PiBtLnN0YXR1cyA9PT0gXCJjb21wbGV0ZVwiKS5sZW5ndGg7XG5cbiAgICAgIGNvbnN0IGh0bWxPcHRzID0ge1xuICAgICAgICBwcm9qZWN0TmFtZTogcHJvak5hbWUsXG4gICAgICAgIHByb2plY3RQYXRoOiBiYXNlUGF0aCxcbiAgICAgICAgZ3NkVmVyc2lvbixcbiAgICAgICAgaW5kZXhSZWxQYXRoOiBcImluZGV4Lmh0bWxcIixcbiAgICAgIH07XG5cbiAgICAgIGlmIChnZW5lcmF0ZUFsbCkge1xuICAgICAgICAvLyBHZW5lcmF0ZSBhIHJlcG9ydCBzbmFwc2hvdCBmb3IgZXZlcnkgbWlsZXN0b25lXG4gICAgICAgIGNvbnN0IGV4aXN0aW5nID0gbG9hZFJlcG9ydHNJbmRleChiYXNlUGF0aCk7XG4gICAgICAgIGNvbnN0IGV4aXN0aW5nSWRzID0gbmV3IFNldChleGlzdGluZz8uZW50cmllcy5tYXAoZSA9PiBlLm1pbGVzdG9uZUlkKSA/PyBbXSk7XG5cbiAgICAgICAgY29uc3QgdGFyZ2V0cyA9IGRhdGEubWlsZXN0b25lcy5maWx0ZXIobSA9PiAhZXhpc3RpbmdJZHMuaGFzKG0uaWQpKTtcbiAgICAgICAgaWYgKHRhcmdldHMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICAgIFwiQWxsIG1pbGVzdG9uZXMgYWxyZWFkeSBoYXZlIHJlcG9ydCBzbmFwc2hvdHMuIFJ1biB3aXRob3V0IC0tYWxsIHRvIGNyZWF0ZSBhIG5ldyBzbmFwc2hvdCBmb3IgdGhlIGFjdGl2ZSBtaWxlc3RvbmUuXCIsXG4gICAgICAgICAgICBcImluZm9cIixcbiAgICAgICAgICApO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IGh0bWwgPSBnZW5lcmF0ZUh0bWxSZXBvcnQoZGF0YSwgaHRtbE9wdHMpO1xuICAgICAgICBjb25zdCBwYXRoczogc3RyaW5nW10gPSBbXTtcblxuICAgICAgICBmb3IgKGNvbnN0IG1zIG9mIHRhcmdldHMpIHtcbiAgICAgICAgICBjb25zdCBtc1NsaWNlc0RvbmUgPSBtcy5zbGljZXMuZmlsdGVyKHNsID0+IHNsLmRvbmUpLmxlbmd0aDtcbiAgICAgICAgICBjb25zdCBtc1NsaWNlc1RvdGFsID0gbXMuc2xpY2VzLmxlbmd0aDtcblxuICAgICAgICAgIC8vIEFjY3VtdWxhdGUgcHJvamVjdC13aWRlIHByb2dyZXNzIHVwIHRvIGFuZCBpbmNsdWRpbmcgdGhpcyBtaWxlc3RvbmVcbiAgICAgICAgICBjb25zdCBtc0lkeCA9IGRhdGEubWlsZXN0b25lcy5pbmRleE9mKG1zKTtcbiAgICAgICAgICBsZXQgY3VtdWxhdGl2ZURvbmUgPSAwO1xuICAgICAgICAgIGxldCBjdW11bGF0aXZlVG90YWwgPSAwO1xuICAgICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDw9IG1zSWR4OyBpKyspIHtcbiAgICAgICAgICAgIGN1bXVsYXRpdmVEb25lICs9IGRhdGEubWlsZXN0b25lc1tpXS5zbGljZXMuZmlsdGVyKHNsID0+IHNsLmRvbmUpLmxlbmd0aDtcbiAgICAgICAgICAgIGN1bXVsYXRpdmVUb3RhbCArPSBkYXRhLm1pbGVzdG9uZXNbaV0uc2xpY2VzLmxlbmd0aDtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBjb25zdCBvdXRQYXRoID0gd3JpdGVSZXBvcnRTbmFwc2hvdCh7XG4gICAgICAgICAgICBiYXNlUGF0aCxcbiAgICAgICAgICAgIGh0bWwsXG4gICAgICAgICAgICBtaWxlc3RvbmVJZDogbXMuaWQsXG4gICAgICAgICAgICBtaWxlc3RvbmVUaXRsZTogbXMudGl0bGUsXG4gICAgICAgICAgICBraW5kOiBtcy5zdGF0dXMgPT09IFwiY29tcGxldGVcIiA/IFwibWlsZXN0b25lXCIgOiBcIm1hbnVhbFwiLFxuICAgICAgICAgICAgcHJvamVjdE5hbWU6IHByb2pOYW1lLFxuICAgICAgICAgICAgcHJvamVjdFBhdGg6IGJhc2VQYXRoLFxuICAgICAgICAgICAgZ3NkVmVyc2lvbixcbiAgICAgICAgICAgIHRvdGFsQ29zdDogZGF0YS50b3RhbHM/LmNvc3QgPz8gMCxcbiAgICAgICAgICAgIHRvdGFsVG9rZW5zOiBkYXRhLnRvdGFscz8udG9rZW5zLnRvdGFsID8/IDAsXG4gICAgICAgICAgICB0b3RhbER1cmF0aW9uOiBkYXRhLnRvdGFscz8uZHVyYXRpb24gPz8gMCxcbiAgICAgICAgICAgIGRvbmVTbGljZXM6IGN1bXVsYXRpdmVEb25lLFxuICAgICAgICAgICAgdG90YWxTbGljZXM6IGN1bXVsYXRpdmVUb3RhbCxcbiAgICAgICAgICAgIGRvbmVNaWxlc3RvbmVzOiBkYXRhLm1pbGVzdG9uZXMuc2xpY2UoMCwgbXNJZHggKyAxKS5maWx0ZXIobSA9PiBtLnN0YXR1cyA9PT0gXCJjb21wbGV0ZVwiKS5sZW5ndGgsXG4gICAgICAgICAgICB0b3RhbE1pbGVzdG9uZXM6IGRhdGEubWlsZXN0b25lcy5sZW5ndGgsXG4gICAgICAgICAgICBwaGFzZTogbXMuc3RhdHVzID09PSBcImNvbXBsZXRlXCIgPyBcImNvbXBsZXRlXCIgOiBkYXRhLnBoYXNlLFxuICAgICAgICAgIH0pO1xuICAgICAgICAgIHBhdGhzLnB1c2goYm4ob3V0UGF0aCkpO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgaW5kZXhQYXRoID0gam9pbihnc2RSb290KGJhc2VQYXRoKSwgXCJyZXBvcnRzXCIsIFwiaW5kZXguaHRtbFwiKTtcbiAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICBgR2VuZXJhdGVkICR7cGF0aHMubGVuZ3RofSByZXBvcnQgc25hcHNob3Qke3BhdGhzLmxlbmd0aCAhPT0gMSA/IFwic1wiIDogXCJcIn06XFxuJHtwYXRocy5tYXAocCA9PiBgICAke3B9YCkuam9pbihcIlxcblwiKX1cXG5PcGVuaW5nIHJlcG9ydHMgaW5kZXggaW4gYnJvd3Nlci4uLmAsXG4gICAgICAgICAgXCJzdWNjZXNzXCIsXG4gICAgICAgICk7XG4gICAgICAgIG9wZW5JbkJyb3dzZXIoaW5kZXhQYXRoKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIFNpbmdsZSByZXBvcnQgZm9yIHRoZSBhY3RpdmUgbWlsZXN0b25lIChleGlzdGluZyBiZWhhdmlvcilcbiAgICAgICAgY29uc3QgZG9uZVNsaWNlcyA9IGRhdGEubWlsZXN0b25lcy5yZWR1Y2UoKHMsIG0pID0+IHMgKyBtLnNsaWNlcy5maWx0ZXIoc2wgPT4gc2wuZG9uZSkubGVuZ3RoLCAwKTtcbiAgICAgICAgY29uc3QgdG90YWxTbGljZXMgPSBkYXRhLm1pbGVzdG9uZXMucmVkdWNlKChzLCBtKSA9PiBzICsgbS5zbGljZXMubGVuZ3RoLCAwKTtcbiAgICAgICAgY29uc3Qgb3V0UGF0aCA9IHdyaXRlUmVwb3J0U25hcHNob3Qoe1xuICAgICAgICAgIGJhc2VQYXRoLFxuICAgICAgICAgIGh0bWw6IGdlbmVyYXRlSHRtbFJlcG9ydChkYXRhLCBodG1sT3B0cyksXG4gICAgICAgICAgbWlsZXN0b25lSWQ6IGRhdGEubWlsZXN0b25lcy5maW5kKG0gPT4gbS5zdGF0dXMgPT09IFwiYWN0aXZlXCIpPy5pZCA/PyBcIm1hbnVhbFwiLFxuICAgICAgICAgIG1pbGVzdG9uZVRpdGxlOiBkYXRhLm1pbGVzdG9uZXMuZmluZChtID0+IG0uc3RhdHVzID09PSBcImFjdGl2ZVwiKT8udGl0bGUgPz8gXCJcIixcbiAgICAgICAgICBraW5kOiBcIm1hbnVhbFwiLFxuICAgICAgICAgIHByb2plY3ROYW1lOiBwcm9qTmFtZSxcbiAgICAgICAgICBwcm9qZWN0UGF0aDogYmFzZVBhdGgsXG4gICAgICAgICAgZ3NkVmVyc2lvbixcbiAgICAgICAgICB0b3RhbENvc3Q6IGRhdGEudG90YWxzPy5jb3N0ID8/IDAsXG4gICAgICAgICAgdG90YWxUb2tlbnM6IGRhdGEudG90YWxzPy50b2tlbnMudG90YWwgPz8gMCxcbiAgICAgICAgICB0b3RhbER1cmF0aW9uOiBkYXRhLnRvdGFscz8uZHVyYXRpb24gPz8gMCxcbiAgICAgICAgICBkb25lU2xpY2VzLFxuICAgICAgICAgIHRvdGFsU2xpY2VzLFxuICAgICAgICAgIGRvbmVNaWxlc3RvbmVzLFxuICAgICAgICAgIHRvdGFsTWlsZXN0b25lczogZGF0YS5taWxlc3RvbmVzLmxlbmd0aCxcbiAgICAgICAgICBwaGFzZTogZGF0YS5waGFzZSxcbiAgICAgICAgfSk7XG4gICAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgICAgYEhUTUwgcmVwb3J0IHNhdmVkOiAuZ3NkL3JlcG9ydHMvJHtibihvdXRQYXRoKX1cXG5PcGVuaW5nIGluIGJyb3dzZXIuLi5gLFxuICAgICAgICAgIFwic3VjY2Vzc1wiLFxuICAgICAgICApO1xuICAgICAgICBvcGVuSW5Ccm93c2VyKG91dFBhdGgpO1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgYEhUTUwgZXhwb3J0IGZhaWxlZDogJHtnZXRFcnJvck1lc3NhZ2UoZXJyKX1gLFxuICAgICAgICBcImVycm9yXCIsXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBmb3JtYXQgPSBhcmdzLmluY2x1ZGVzKFwiLS1qc29uXCIpID8gXCJqc29uXCIgOiBcIm1hcmtkb3duXCI7XG5cbiAgY29uc3QgbGVkZ2VyID0gZ2V0TGVkZ2VyKCk7XG4gIGxldCB1bml0czogVW5pdE1ldHJpY3NbXTtcblxuICBpZiAobGVkZ2VyICYmIGxlZGdlci51bml0cy5sZW5ndGggPiAwKSB7XG4gICAgdW5pdHMgPSBsZWRnZXIudW5pdHM7XG4gIH0gZWxzZSB7XG4gICAgY29uc3QgeyBsb2FkTGVkZ2VyRnJvbURpc2sgfSA9IGF3YWl0IGltcG9ydChcIi4vbWV0cmljcy5qc1wiKTtcbiAgICBjb25zdCBkaXNrTGVkZ2VyID0gbG9hZExlZGdlckZyb21EaXNrKGJhc2VQYXRoKTtcbiAgICBpZiAoIWRpc2tMZWRnZXIgfHwgZGlza0xlZGdlci51bml0cy5sZW5ndGggPT09IDApIHtcbiAgICAgIGN0eC51aS5ub3RpZnkoXCJOb3RoaW5nIHRvIGV4cG9ydCBcdTIwMTQgbm8gdW5pdHMgZXhlY3V0ZWQgeWV0LlwiLCBcImluZm9cIik7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHVuaXRzID0gZGlza0xlZGdlci51bml0cztcbiAgfVxuXG4gIGNvbnN0IHByb2plY3ROYW1lID0gYmFzZW5hbWUoYmFzZVBhdGgpO1xuICBjb25zdCBleHBvcnREaXIgPSBnc2RSb290KGJhc2VQYXRoKTtcbiAgbWtkaXJTeW5jKGV4cG9ydERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGNvbnN0IHRpbWVzdGFtcCA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKS5yZXBsYWNlKC9bOi5dL2csIFwiLVwiKS5zbGljZSgwLCAxOSk7XG5cbiAgaWYgKGZvcm1hdCA9PT0gXCJqc29uXCIpIHtcbiAgICBjb25zdCByZXBvcnQgPSB7XG4gICAgICBleHBvcnRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICBwcm9qZWN0OiBwcm9qZWN0TmFtZSxcbiAgICAgIHRvdGFsczogZ2V0UHJvamVjdFRvdGFscyh1bml0cyksXG4gICAgICBieVBoYXNlOiBhZ2dyZWdhdGVCeVBoYXNlKHVuaXRzKSxcbiAgICAgIGJ5U2xpY2U6IGFnZ3JlZ2F0ZUJ5U2xpY2UodW5pdHMpLFxuICAgICAgYnlNb2RlbDogYWdncmVnYXRlQnlNb2RlbCh1bml0cyksXG4gICAgICB1bml0cyxcbiAgICB9O1xuICAgIGNvbnN0IG91dFBhdGggPSBqb2luKGV4cG9ydERpciwgYGV4cG9ydC0ke3RpbWVzdGFtcH0uanNvbmApO1xuICAgIHdyaXRlRmlsZVN5bmMob3V0UGF0aCwgSlNPTi5zdHJpbmdpZnkocmVwb3J0LCBudWxsLCAyKSArIFwiXFxuXCIsIFwidXRmLThcIik7XG4gICAgY3R4LnVpLm5vdGlmeShgRXhwb3J0ZWQgdG8gJHtmaWxlTGluayhvdXRQYXRoKX1gLCBcInN1Y2Nlc3NcIik7XG4gIH0gZWxzZSB7XG4gICAgY29uc3QgdG90YWxzID0gZ2V0UHJvamVjdFRvdGFscyh1bml0cyk7XG4gICAgY29uc3QgcGhhc2VzID0gYWdncmVnYXRlQnlQaGFzZSh1bml0cyk7XG4gICAgY29uc3Qgc2xpY2VzID0gYWdncmVnYXRlQnlTbGljZSh1bml0cyk7XG5cbiAgICBjb25zdCBtZCA9IFtcbiAgICAgIGAjIEdTRCBTZXNzaW9uIFJlcG9ydCBcdTIwMTQgJHtwcm9qZWN0TmFtZX1gLFxuICAgICAgYGAsXG4gICAgICBgKipHZW5lcmF0ZWQqKjogJHtuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCl9YCxcbiAgICAgIGAqKlVuaXRzIGNvbXBsZXRlZCoqOiAke3RvdGFscy51bml0c31gLFxuICAgICAgYCoqVG90YWwgY29zdCoqOiAke2Zvcm1hdENvc3QodG90YWxzLmNvc3QpfWAsXG4gICAgICBgKipUb3RhbCB0b2tlbnMqKjogJHtmb3JtYXRUb2tlbkNvdW50KHRvdGFscy50b2tlbnMudG90YWwpfWAsXG4gICAgICBgKipUb3RhbCBkdXJhdGlvbioqOiAke2Zvcm1hdER1cmF0aW9uKHRvdGFscy5kdXJhdGlvbil9YCxcbiAgICAgIGAqKlRvb2wgY2FsbHMqKjogJHt0b3RhbHMudG9vbENhbGxzfWAsXG4gICAgICBgYCxcbiAgICAgIGAjIyBDb3N0IGJ5IFBoYXNlYCxcbiAgICAgIGBgLFxuICAgICAgYHwgUGhhc2UgfCBVbml0cyB8IENvc3QgfCBUb2tlbnMgfCBEdXJhdGlvbiB8YCxcbiAgICAgIGB8LS0tLS0tLXwtLS0tLS0tfC0tLS0tLXwtLS0tLS0tLXwtLS0tLS0tLS0tfGAsXG4gICAgICAuLi5waGFzZXMubWFwKHAgPT5cbiAgICAgICAgYHwgJHtwLnBoYXNlfSB8ICR7cC51bml0c30gfCAke2Zvcm1hdENvc3QocC5jb3N0KX0gfCAke2Zvcm1hdFRva2VuQ291bnQocC50b2tlbnMudG90YWwpfSB8ICR7Zm9ybWF0RHVyYXRpb24ocC5kdXJhdGlvbil9IHxgLFxuICAgICAgKSxcbiAgICAgIGBgLFxuICAgICAgYCMjIENvc3QgYnkgU2xpY2VgLFxuICAgICAgYGAsXG4gICAgICBgfCBTbGljZSB8IFVuaXRzIHwgQ29zdCB8IFRva2VucyB8IER1cmF0aW9uIHxgLFxuICAgICAgYHwtLS0tLS0tfC0tLS0tLS18LS0tLS0tfC0tLS0tLS0tfC0tLS0tLS0tLS18YCxcbiAgICAgIC4uLnNsaWNlcy5tYXAocyA9PlxuICAgICAgICBgfCAke3Muc2xpY2VJZH0gfCAke3MudW5pdHN9IHwgJHtmb3JtYXRDb3N0KHMuY29zdCl9IHwgJHtmb3JtYXRUb2tlbkNvdW50KHMudG9rZW5zLnRvdGFsKX0gfCAke2Zvcm1hdER1cmF0aW9uKHMuZHVyYXRpb24pfSB8YCxcbiAgICAgICksXG4gICAgICBgYCxcbiAgICAgIGAjIyBVbml0IEhpc3RvcnlgLFxuICAgICAgYGAsXG4gICAgICBgfCBUeXBlIHwgSUQgfCBNb2RlbCB8IENvc3QgfCBUb2tlbnMgfCBEdXJhdGlvbiB8YCxcbiAgICAgIGB8LS0tLS0tfC0tLS0tfC0tLS0tLS18LS0tLS0tfC0tLS0tLS0tfC0tLS0tLS0tLS18YCxcbiAgICAgIC4uLnVuaXRzLm1hcCh1ID0+XG4gICAgICAgIGB8ICR7dS50eXBlfSB8ICR7dS5pZH0gfCAke3UubW9kZWwucmVwbGFjZSgvXmNsYXVkZS0vLCBcIlwiKX0gfCAke2Zvcm1hdENvc3QodS5jb3N0KX0gfCAke2Zvcm1hdFRva2VuQ291bnQodS50b2tlbnMudG90YWwpfSB8ICR7Zm9ybWF0RHVyYXRpb24odS5maW5pc2hlZEF0IC0gdS5zdGFydGVkQXQpfSB8YCxcbiAgICAgICksXG4gICAgICBgYCxcbiAgICBdLmpvaW4oXCJcXG5cIik7XG5cbiAgICBjb25zdCBvdXRQYXRoID0gam9pbihleHBvcnREaXIsIGBleHBvcnQtJHt0aW1lc3RhbXB9Lm1kYCk7XG4gICAgd3JpdGVGaWxlU3luYyhvdXRQYXRoLCBtZCwgXCJ1dGYtOFwiKTtcbiAgICBjdHgudWkubm90aWZ5KGBFeHBvcnRlZCB0byAke2ZpbGVMaW5rKG91dFBhdGgpfWAsIFwic3VjY2Vzc1wiKTtcbiAgfVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBSUEsU0FBUyxlQUFlLGlCQUFpQjtBQUN6QyxTQUFTLE1BQU0sZ0JBQWdCO0FBQy9CLFNBQWUsZ0JBQWdCO0FBQy9CO0FBQUEsRUFDRTtBQUFBLEVBQVc7QUFBQSxFQUFrQjtBQUFBLEVBQWtCO0FBQUEsRUFDL0M7QUFBQSxFQUFrQjtBQUFBLEVBQVk7QUFBQSxFQUFrQjtBQUFBLE9BQzNDO0FBRVAsU0FBUyxlQUFlO0FBQ3hCLFNBQVMsZ0JBQWdCLGdCQUFnQjtBQUN6QyxTQUFTLHVCQUF1QjtBQU96QixTQUFTLGNBQWMsVUFBd0I7QUFDcEQsTUFBSSxRQUFRLGFBQWEsU0FBUztBQUVoQyxhQUFTLGNBQWMsQ0FBQyxNQUFNLGtCQUFrQixTQUFTLFFBQVEsTUFBTSxJQUFJLENBQUMsR0FBRyxHQUFHLE1BQU07QUFBQSxJQUFDLENBQUM7QUFBQSxFQUM1RixPQUFPO0FBQ0wsVUFBTSxNQUFNLFFBQVEsYUFBYSxXQUFXLFNBQVM7QUFDckQsYUFBUyxLQUFLLENBQUMsUUFBUSxHQUFHLE1BQU07QUFBQSxJQUFDLENBQUM7QUFBQSxFQUNwQztBQUNGO0FBT08sU0FBUyxnQkFDZCxVQUNBLFFBQ0EsZ0JBQ2U7QUFDZixRQUFNLFNBQVMsVUFBVTtBQUN6QixNQUFJO0FBRUosTUFBSSxrQkFBa0IsZUFBZSxNQUFNLFNBQVMsR0FBRztBQUNyRCxZQUFRLGVBQWU7QUFBQSxFQUN6QixXQUFXLFVBQVUsT0FBTyxNQUFNLFNBQVMsR0FBRztBQUM1QyxZQUFRLE9BQU87QUFBQSxFQUNqQixPQUFPO0FBQ0wsVUFBTSxhQUFhLG1CQUFtQixRQUFRO0FBQzlDLFFBQUksQ0FBQyxjQUFjLFdBQVcsTUFBTSxXQUFXLEVBQUcsUUFBTztBQUN6RCxZQUFRLFdBQVc7QUFB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
