import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteSync } from "./atomic-write.js";
import { gsdRoot } from "./paths.js";
import { formatCost, formatTokenCount } from "./metrics.js";
import { formatDateShort, formatDuration } from "../shared/format-utils.js";
function reportsDir(basePath) {
  return join(gsdRoot(basePath), "reports");
}
function reportsIndexPath(basePath) {
  return join(reportsDir(basePath), "reports.json");
}
function reportsHtmlIndexPath(basePath) {
  return join(reportsDir(basePath), "index.html");
}
function loadReportsIndex(basePath) {
  const p = reportsIndexPath(basePath);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}
function saveReportsIndex(basePath, index) {
  const dir = reportsDir(basePath);
  mkdirSync(dir, { recursive: true });
  atomicWriteSync(reportsIndexPath(basePath), JSON.stringify(index, null, 2) + "\n", "utf-8");
}
function writeReportSnapshot(args) {
  const dir = reportsDir(args.basePath);
  mkdirSync(dir, { recursive: true });
  const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const prefix = args.milestoneId === "final" ? "final" : args.milestoneId;
  const filename = `${prefix}-${timestamp}.html`;
  const filePath = join(dir, filename);
  atomicWriteSync(filePath, args.html, "utf-8");
  const existing = loadReportsIndex(args.basePath);
  const index = existing ?? {
    version: 1,
    projectName: args.projectName,
    projectPath: args.projectPath,
    gsdVersion: args.gsdVersion,
    entries: []
  };
  index.projectName = args.projectName;
  index.projectPath = args.projectPath;
  index.gsdVersion = args.gsdVersion;
  const label = args.milestoneId === "final" ? "Final Report" : `${args.milestoneId}: ${args.milestoneTitle}`;
  const entry = {
    filename,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    milestoneId: args.milestoneId,
    milestoneTitle: args.milestoneTitle,
    label,
    kind: args.kind,
    totalCost: args.totalCost,
    totalTokens: args.totalTokens,
    totalDuration: args.totalDuration,
    doneSlices: args.doneSlices,
    totalSlices: args.totalSlices,
    doneMilestones: args.doneMilestones,
    totalMilestones: args.totalMilestones,
    phase: args.phase
  };
  index.entries.push(entry);
  saveReportsIndex(args.basePath, index);
  regenerateHtmlIndex(args.basePath, index);
  return filePath;
}
function regenerateHtmlIndex(basePath, index) {
  const html = buildIndexHtml(index);
  atomicWriteSync(reportsHtmlIndexPath(basePath), html, "utf-8");
}
function buildIndexHtml(index) {
  const { projectName, projectPath, gsdVersion, entries } = index;
  const generated = (/* @__PURE__ */ new Date()).toISOString();
  const sorted = [...entries].sort(
    (a, b) => new Date(a.generatedAt).getTime() - new Date(b.generatedAt).getTime()
  );
  const latestEntry = sorted[sorted.length - 1];
  const overallPct = latestEntry ? latestEntry.totalSlices > 0 ? Math.round(latestEntry.doneSlices / latestEntry.totalSlices * 100) : 0 : 0;
  const milestoneGroups = /* @__PURE__ */ new Map();
  for (const e of sorted) {
    const key = e.milestoneId;
    const arr = milestoneGroups.get(key) ?? [];
    arr.push(e);
    milestoneGroups.set(key, arr);
  }
  const tocHtml = [...milestoneGroups.entries()].map(([mid, group]) => {
    const links = group.map(
      (e) => `<li><a href="${esc(e.filename)}">${formatDateShort(e.generatedAt)}</a> <span class="toc-kind toc-${e.kind}">${e.kind}</span></li>`
    ).join("");
    return `
      <div class="toc-group">
        <div class="toc-group-label">${esc(mid === "final" ? "Final" : mid)}</div>
        <ul>${links}</ul>
      </div>`;
  }).join("");
  const cardHtml = sorted.map((e, i) => {
    const pct = e.totalSlices > 0 ? Math.round(e.doneSlices / e.totalSlices * 100) : 0;
    const isLatest = i === sorted.length - 1;
    let deltaHtml = "";
    if (i > 0) {
      const prev = sorted[i - 1];
      const dCost = e.totalCost - prev.totalCost;
      const dSlices = e.doneSlices - prev.doneSlices;
      const dMillestones = e.doneMilestones - prev.doneMilestones;
      const parts = [];
      if (dCost > 0) parts.push(`+${formatCost(dCost)}`);
      if (dSlices > 0) parts.push(`+${dSlices} slice${dSlices !== 1 ? "s" : ""}`);
      if (dMillestones > 0) parts.push(`+${dMillestones} milestone${dMillestones !== 1 ? "s" : ""}`);
      if (parts.length > 0) {
        deltaHtml = `<div class="card-delta">${parts.map((p) => `<span>${esc(p)}</span>`).join("")}</div>`;
      }
    }
    return `
      <a class="report-card${isLatest ? " card-latest" : ""}" href="${esc(e.filename)}">
        <div class="card-top">
          <span class="card-label">${esc(e.label)}</span>
          <span class="card-kind card-kind-${e.kind}">${e.kind}</span>
        </div>
        <div class="card-date">${formatDateShort(e.generatedAt)}</div>
        <div class="card-progress">
          <div class="card-bar-track">
            <div class="card-bar-fill" style="width:${pct}%"></div>
          </div>
          <span class="card-pct">${pct}%</span>
        </div>
        <div class="card-stats">
          <span>${esc(formatCost(e.totalCost))}</span>
          <span>${esc(formatTokenCount(e.totalTokens))}</span>
          <span>${esc(formatDuration(e.totalDuration))}</span>
          <span>${e.doneSlices}/${e.totalSlices} slices</span>
        </div>
        ${deltaHtml}
        ${isLatest ? '<div class="card-latest-badge">Latest</div>' : ""}
      </a>`;
  }).join("");
  const sparklineSvg = sorted.length > 1 ? buildCostSparkline(sorted) : "";
  const summaryHtml = latestEntry ? `
    <div class="idx-summary">
      <div class="idx-stat"><span class="idx-val">${formatCost(latestEntry.totalCost)}</span><span class="idx-lbl">Total Cost</span></div>
      <div class="idx-stat"><span class="idx-val">${formatTokenCount(latestEntry.totalTokens)}</span><span class="idx-lbl">Total Tokens</span></div>
      <div class="idx-stat"><span class="idx-val">${formatDuration(latestEntry.totalDuration)}</span><span class="idx-lbl">Duration</span></div>
      <div class="idx-stat"><span class="idx-val">${latestEntry.doneSlices}/${latestEntry.totalSlices}</span><span class="idx-lbl">Slices</span></div>
      <div class="idx-stat"><span class="idx-val">${latestEntry.doneMilestones}/${latestEntry.totalMilestones}</span><span class="idx-lbl">Milestones</span></div>
      <div class="idx-stat"><span class="idx-val">${entries.length}</span><span class="idx-lbl">Reports</span></div>
    </div>
    <div class="idx-progress">
      <div class="idx-bar-track"><div class="idx-bar-fill" style="width:${overallPct}%"></div></div>
      <span class="idx-pct">${overallPct}% complete</span>
    </div>` : '<p class="empty">No reports generated yet.</p>';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>GSD Reports \u2014 ${esc(projectName)}</title>
<style>${INDEX_CSS}</style>
</head>
<body>
<header>
  <div class="hdr-inner">
    <div class="branding">
      <span class="logo">GSD</span>
      <span class="ver">v${esc(gsdVersion)}</span>
    </div>
    <div class="hdr-meta">
      <h1>${esc(projectName)} <span class="hdr-subtitle">Reports</span></h1>
      <span class="hdr-path">${esc(projectPath)}</span>
    </div>
    <div class="hdr-right">
      <span class="gen-lbl">Updated</span>
      <span class="gen">${formatDateShort(generated)}</span>
    </div>
  </div>
</header>

<div class="layout">
  <!-- Sidebar TOC -->
  <aside class="sidebar">
    <div class="sidebar-title">Reports</div>
    ${sorted.length > 0 ? tocHtml : '<p class="empty">No reports yet.</p>'}
  </aside>

  <!-- Main content -->
  <main>
    <section class="idx-overview">
      <h2>Project Overview</h2>
      ${summaryHtml}
      ${sparklineSvg ? `<div class="sparkline-wrap"><h3>Cost Progression</h3>${sparklineSvg}</div>` : ""}
    </section>

    <section class="idx-cards">
      <h2>Progression <span class="sec-count">${entries.length}</span></h2>
      ${sorted.length > 0 ? `<div class="cards-grid">${cardHtml}</div>` : '<p class="empty">No reports generated yet. Run <code>/gsd export --html</code> or enable <code>auto_report: true</code>.</p>'}
    </section>
  </main>
</div>

<footer>
  <div class="ftr-inner">
    <span class="ftr-brand">GSD v${esc(gsdVersion)}</span>
    <span class="ftr-sep">\u2014</span>
    <span>${esc(projectName)}</span>
    <span class="ftr-sep">\u2014</span>
    <span>${esc(projectPath)}</span>
    <span class="ftr-sep">\u2014</span>
    <span>Updated ${formatDateShort(generated)}</span>
  </div>
</footer>
</body>
</html>`;
}
function buildCostSparkline(entries) {
  const costs = entries.map((e) => e.totalCost);
  const maxCost = Math.max(...costs, 1e-3);
  const W = 600, H = 60, PAD = 12;
  const xStep = entries.length > 1 ? (W - PAD * 2) / (entries.length - 1) : W - PAD * 2;
  const points = costs.map((c, i) => {
    const x = PAD + i * xStep;
    const y = PAD + (1 - c / maxCost) * (H - PAD * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const dots = costs.map((c, i) => {
    const x = PAD + i * xStep;
    const y = PAD + (1 - c / maxCost) * (H - PAD * 2);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" class="spark-dot">
      <title>${esc(entries[i].label)} \u2014 ${formatCost(c)}</title>
    </circle>`;
  }).join("");
  const startLabel = formatCost(costs[0]);
  const endLabel = formatCost(costs[costs.length - 1]);
  return `
    <div class="sparkline">
      <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="spark-svg">
        <polyline points="${esc(points)}" class="spark-line" fill="none"/>
        ${dots}
        <text x="${PAD}" y="${H - 2}" class="spark-lbl">${esc(startLabel)}</text>
        <text x="${W - PAD}" y="${H - 2}" text-anchor="end" class="spark-lbl">${esc(endLabel)}</text>
      </svg>
      <div class="spark-axis">
        ${entries.map((e, i) => {
    const x = (PAD + i * xStep) / W * 100;
    return `<span class="spark-tick" style="left:${x.toFixed(1)}%" title="${esc(e.generatedAt)}">${esc(e.milestoneId === "final" ? "final" : e.milestoneId)}</span>`;
  }).join("")}
      </div>
    </div>`;
}
function esc(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
const INDEX_CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg-0:#0f1115;--bg-1:#16181d;--bg-2:#1e2028;--bg-3:#272a33;
  --border-1:#2b2e38;--border-2:#3b3f4c;
  --text-0:#ededef;--text-1:#a1a1aa;--text-2:#71717a;
  --accent:#5e6ad2;--accent-subtle:rgba(94,106,210,.12);
  --font:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  --mono:'JetBrains Mono','Fira Code',ui-monospace,monospace;
}
html{font-size:13px}
body{background:var(--bg-0);color:var(--text-0);font-family:var(--font);line-height:1.6;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
h2{font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-1);margin-bottom:16px;padding-bottom:8px;border-bottom:1px solid var(--border-1)}
h3{font-size:13px;font-weight:600;color:var(--text-1);margin:16px 0 8px}
code{font-family:var(--mono);font-size:12px;background:var(--bg-3);padding:1px 5px;border-radius:3px}
.empty{color:var(--text-2);font-size:13px;padding:8px 0}
.count{font-size:11px;font-weight:500;color:var(--text-2);background:var(--bg-3);border-radius:3px;padding:1px 6px}

/* Header */
header{background:var(--bg-1);border-bottom:1px solid var(--border-1);padding:12px 32px;position:sticky;top:0;z-index:100}
.hdr-inner{display:flex;align-items:center;gap:16px;max-width:1280px;margin:0 auto}
.branding{display:flex;align-items:baseline;gap:6px;flex-shrink:0}
.logo{font-size:18px;font-weight:800;letter-spacing:-.5px;color:var(--text-0)}
.ver{font-size:10px;color:var(--text-2);font-family:var(--mono)}
.hdr-meta{flex:1;min-width:0}
.hdr-meta h1{font-size:15px;font-weight:600}
.hdr-subtitle{color:var(--text-2);font-weight:400;font-size:13px;margin-left:4px}
.hdr-path{font-size:11px;color:var(--text-2);font-family:var(--mono);display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hdr-right{text-align:right;flex-shrink:0}
.gen-lbl{font-size:10px;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px;display:block}
.gen{font-size:11px;color:var(--text-1)}

/* Layout */
.layout{display:grid;grid-template-columns:200px 1fr;gap:0;max-width:1280px;margin:0 auto;min-height:calc(100vh - 120px)}

/* Sidebar */
.sidebar{background:var(--bg-1);border-right:1px solid var(--border-1);padding:20px 14px;position:sticky;top:52px;height:calc(100vh - 52px);overflow-y:auto}
.sidebar-title{font-size:10px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px}
.toc-group{margin-bottom:14px}
.toc-group-label{font-size:11px;font-weight:600;color:var(--text-1);margin-bottom:3px;font-family:var(--mono)}
.toc-group ul{list-style:none;display:flex;flex-direction:column;gap:1px}
.toc-group li{display:flex;align-items:center;gap:6px}
.toc-group a{font-size:11px;color:var(--text-2);padding:2px 4px;border-radius:3px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.toc-group a:hover{background:var(--bg-2);color:var(--text-0);text-decoration:none}
.toc-kind{font-size:9px;color:var(--text-2);font-family:var(--mono);flex-shrink:0}

/* Main */
main{padding:28px;display:flex;flex-direction:column;gap:40px}

/* Overview */
.idx-summary{display:flex;flex-wrap:wrap;gap:1px;background:var(--border-1);border:1px solid var(--border-1);border-radius:4px;overflow:hidden;margin-bottom:16px}
.idx-stat{background:var(--bg-1);padding:10px 16px;display:flex;flex-direction:column;gap:2px;min-width:100px;flex:1}
.idx-val{font-size:18px;font-weight:600;color:var(--text-0);font-variant-numeric:tabular-nums}
.idx-lbl{font-size:10px;color:var(--text-2);text-transform:uppercase;letter-spacing:.4px}
.idx-progress{display:flex;align-items:center;gap:10px;margin-top:10px}
.idx-bar-track{flex:1;height:4px;background:var(--bg-3);border-radius:2px;overflow:hidden}
.idx-bar-fill{height:100%;background:var(--accent);border-radius:2px}
.idx-pct{font-size:12px;font-weight:600;color:var(--text-1);min-width:40px;text-align:right}

/* Sparkline */
.sparkline-wrap{margin-top:20px}
.sparkline{position:relative}
.spark-svg{display:block;background:var(--bg-1);border:1px solid var(--border-1);border-radius:4px;overflow:visible;max-width:100%}
.spark-line{stroke:var(--accent);stroke-width:1.5;fill:none}
.spark-dot{fill:var(--accent);stroke:var(--bg-1);stroke-width:2;cursor:pointer}
.spark-dot:hover{r:4;fill:var(--text-0)}
.spark-lbl{font-size:10px;fill:var(--text-2);font-family:var(--mono)}
.spark-axis{display:flex;position:relative;height:18px;margin-top:2px}
.spark-tick{position:absolute;transform:translateX(-50%);font-size:9px;color:var(--text-2);font-family:var(--mono);white-space:nowrap}

/* Report cards */
.cards-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px}
.report-card{
  display:flex;flex-direction:column;gap:6px;
  background:var(--bg-1);border:1px solid var(--border-1);border-radius:4px;
  padding:14px;text-decoration:none;color:var(--text-0);
  transition:border-color .12s;
}
.report-card:hover{border-color:var(--accent);text-decoration:none}
.card-latest{border-color:var(--accent)}
.card-top{display:flex;align-items:center;gap:8px}
.card-label{flex:1;font-weight:500;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card-kind{font-size:10px;color:var(--text-2);font-family:var(--mono);flex-shrink:0}
.card-date{font-size:11px;color:var(--text-2)}
.card-progress{display:flex;align-items:center;gap:6px}
.card-bar-track{flex:1;height:3px;background:var(--bg-3);border-radius:2px;overflow:hidden}
.card-bar-fill{height:100%;background:var(--accent);border-radius:2px}
.card-pct{font-size:11px;color:var(--text-2);min-width:30px;text-align:right}
.card-stats{display:flex;gap:8px;flex-wrap:wrap}
.card-stats span{font-size:11px;color:var(--text-2);font-variant-numeric:tabular-nums}
.card-delta{display:flex;gap:4px;flex-wrap:wrap}
.card-delta span{font-size:10px;color:var(--text-1);font-family:var(--mono)}
.card-latest-badge{display:none}

/* Footer */
footer{border-top:1px solid var(--border-1);padding:16px 32px}
.ftr-inner{display:flex;align-items:center;gap:6px;justify-content:center;font-size:11px;color:var(--text-2)}
.ftr-sep{color:var(--border-2)}

@media(max-width:768px){
  .layout{grid-template-columns:1fr}
  .sidebar{position:static;height:auto;border-right:none;border-bottom:1px solid var(--border-1)}
}
@media print{
  .sidebar{display:none}
  header{position:static}
  body{background:#fff;color:#1a1a1a}
  :root{--bg-0:#fff;--bg-1:#fafafa;--bg-2:#f5f5f5;--bg-3:#ebebeb;--border-1:#e5e5e5;--border-2:#d4d4d4;--text-0:#1a1a1a;--text-1:#525252;--text-2:#a3a3a3;--accent:#4f46e5}
}
`;
export {
  loadReportsIndex,
  regenerateHtmlIndex,
  reportsDir,
  writeReportSnapshot
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9yZXBvcnRzLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIEdTRCBSZXBvcnRzIFJlZ2lzdHJ5XG4gKlxuICogTWFuYWdlcyAuZ3NkL3JlcG9ydHMvIFx1MjAxNCB0aGUgcGVyc2lzdGVudCBwcm9ncmVzc2lvbiBsb2cgb2YgSFRNTCBzbmFwc2hvdHMuXG4gKlxuICogTGF5b3V0OlxuICogICAuZ3NkL3JlcG9ydHMvXG4gKiAgICAgcmVwb3J0cy5qc29uICAgICAgICAgIGxpZ2h0d2VpZ2h0IG1ldGFkYXRhIGluZGV4IChuZXZlciByZS1wYXJzZXMgSFRNTClcbiAqICAgICBpbmRleC5odG1sICAgICAgICAgICAgYXV0by1yZWdlbmVyYXRlZCBvbiBldmVyeSBuZXcgc25hcHNob3RcbiAqICAgICBNMDAxLTIwMjYwMTAxVDEyMDAwMC5odG1sICAgIHBlci1taWxlc3RvbmUgc25hcHNob3RcbiAqICAgICBmaW5hbC0yMDI2MDIwMVQwOTAwMDAuaHRtbCAgIGZ1bGwtcHJvamVjdCBmaW5hbCBzbmFwc2hvdFxuICpcbiAqIEF1dG8tdHJpZ2dlcmVkOiBhZnRlciBlYWNoIG1pbGVzdG9uZSBjb21wbGV0aW9uICh3aGVuIGF1dG9fcmVwb3J0OiB0cnVlKS5cbiAqIE1hbnVhbDogL2dzZCBleHBvcnQgLS1odG1sXG4gKi9cblxuaW1wb3J0IHsgcmVhZEZpbGVTeW5jLCBta2RpclN5bmMsIGV4aXN0c1N5bmMgfSBmcm9tICdub2RlOmZzJztcbmltcG9ydCB7IGpvaW4sIGJhc2VuYW1lIH0gZnJvbSAnbm9kZTpwYXRoJztcbmltcG9ydCB7IGF0b21pY1dyaXRlU3luYyB9IGZyb20gJy4vYXRvbWljLXdyaXRlLmpzJztcbmltcG9ydCB7IGdzZFJvb3QgfSBmcm9tICcuL3BhdGhzLmpzJztcbmltcG9ydCB7IGZvcm1hdENvc3QsIGZvcm1hdFRva2VuQ291bnQgfSBmcm9tICcuL21ldHJpY3MuanMnO1xuaW1wb3J0IHsgZm9ybWF0RGF0ZVNob3J0LCBmb3JtYXREdXJhdGlvbiB9IGZyb20gJy4uL3NoYXJlZC9mb3JtYXQtdXRpbHMuanMnO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVHlwZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBpbnRlcmZhY2UgUmVwb3J0RW50cnkge1xuICAvKiogRmlsZW5hbWUgcmVsYXRpdmUgdG8gdGhlIHJlcG9ydHMvIGRpciwgZS5nLiBcIk0wMDEtMjAyNjAxMDFUMTIwMDAwLmh0bWxcIiAqL1xuICBmaWxlbmFtZTogc3RyaW5nO1xuICAvKiogSVNPIHRpbWVzdGFtcCB3aGVuIHRoaXMgcmVwb3J0IHdhcyBnZW5lcmF0ZWQgKi9cbiAgZ2VuZXJhdGVkQXQ6IHN0cmluZztcbiAgLyoqIE1pbGVzdG9uZSBJRCB0aGlzIHNuYXBzaG90IGNvdmVycywgb3IgXCJmaW5hbFwiIGZvciBhIGZ1bGwtcHJvamVjdCBzbmFwc2hvdCAqL1xuICBtaWxlc3RvbmVJZDogc3RyaW5nIHwgJ2ZpbmFsJztcbiAgLyoqIE1pbGVzdG9uZSB0aXRsZSBhdCBzbmFwc2hvdCB0aW1lICovXG4gIG1pbGVzdG9uZVRpdGxlOiBzdHJpbmc7XG4gIC8qKiBIdW1hbi1yZWFkYWJsZSBsYWJlbCBzaG93biBpbiB0aGUgaW5kZXggKi9cbiAgbGFiZWw6IHN0cmluZztcbiAgLyoqIFNuYXBzaG90IGtpbmQgKi9cbiAga2luZDogJ21pbGVzdG9uZScgfCAnbWFudWFsJyB8ICdmaW5hbCc7XG4gIC8vIE1ldHJpY3MgYXQgc25hcHNob3QgdGltZSBcdTIwMTQgZm9yIHRoZSBpbmRleCBwcm9ncmVzc2lvbiB2aWV3XG4gIHRvdGFsQ29zdDogbnVtYmVyO1xuICB0b3RhbFRva2VuczogbnVtYmVyO1xuICB0b3RhbER1cmF0aW9uOiBudW1iZXI7XG4gIGRvbmVTbGljZXM6IG51bWJlcjtcbiAgdG90YWxTbGljZXM6IG51bWJlcjtcbiAgZG9uZU1pbGVzdG9uZXM6IG51bWJlcjtcbiAgdG90YWxNaWxlc3RvbmVzOiBudW1iZXI7XG4gIHBoYXNlOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUmVwb3J0c0luZGV4IHtcbiAgdmVyc2lvbjogMTtcbiAgcHJvamVjdE5hbWU6IHN0cmluZztcbiAgcHJvamVjdFBhdGg6IHN0cmluZztcbiAgZ3NkVmVyc2lvbjogc3RyaW5nO1xuICBlbnRyaWVzOiBSZXBvcnRFbnRyeVtdO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUGF0aHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBmdW5jdGlvbiByZXBvcnRzRGlyKGJhc2VQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gam9pbihnc2RSb290KGJhc2VQYXRoKSwgJ3JlcG9ydHMnKTtcbn1cblxuZnVuY3Rpb24gcmVwb3J0c0luZGV4UGF0aChiYXNlUGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGpvaW4ocmVwb3J0c0RpcihiYXNlUGF0aCksICdyZXBvcnRzLmpzb24nKTtcbn1cblxuZnVuY3Rpb24gcmVwb3J0c0h0bWxJbmRleFBhdGgoYmFzZVBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBqb2luKHJlcG9ydHNEaXIoYmFzZVBhdGgpLCAnaW5kZXguaHRtbCcpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUmVnaXN0cnkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBmdW5jdGlvbiBsb2FkUmVwb3J0c0luZGV4KGJhc2VQYXRoOiBzdHJpbmcpOiBSZXBvcnRzSW5kZXggfCBudWxsIHtcbiAgY29uc3QgcCA9IHJlcG9ydHNJbmRleFBhdGgoYmFzZVBhdGgpO1xuICBpZiAoIWV4aXN0c1N5bmMocCkpIHJldHVybiBudWxsO1xuICB0cnkge1xuICAgIHJldHVybiBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhwLCAndXRmLTgnKSkgYXMgUmVwb3J0c0luZGV4O1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5mdW5jdGlvbiBzYXZlUmVwb3J0c0luZGV4KGJhc2VQYXRoOiBzdHJpbmcsIGluZGV4OiBSZXBvcnRzSW5kZXgpOiB2b2lkIHtcbiAgY29uc3QgZGlyID0gcmVwb3J0c0RpcihiYXNlUGF0aCk7XG4gIG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBhdG9taWNXcml0ZVN5bmMocmVwb3J0c0luZGV4UGF0aChiYXNlUGF0aCksIEpTT04uc3RyaW5naWZ5KGluZGV4LCBudWxsLCAyKSArICdcXG4nLCAndXRmLTgnKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFdyaXRlIGEgcmVwb3J0IHNuYXBzaG90IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgaW50ZXJmYWNlIFdyaXRlUmVwb3J0U25hcHNob3RBcmdzIHtcbiAgYmFzZVBhdGg6IHN0cmluZztcbiAgaHRtbDogc3RyaW5nO1xuICBtaWxlc3RvbmVJZDogc3RyaW5nIHwgJ2ZpbmFsJztcbiAgbWlsZXN0b25lVGl0bGU6IHN0cmluZztcbiAga2luZDogJ21pbGVzdG9uZScgfCAnbWFudWFsJyB8ICdmaW5hbCc7XG4gIHByb2plY3ROYW1lOiBzdHJpbmc7XG4gIHByb2plY3RQYXRoOiBzdHJpbmc7XG4gIGdzZFZlcnNpb246IHN0cmluZztcbiAgLy8gbWV0cmljc1xuICB0b3RhbENvc3Q6IG51bWJlcjtcbiAgdG90YWxUb2tlbnM6IG51bWJlcjtcbiAgdG90YWxEdXJhdGlvbjogbnVtYmVyO1xuICBkb25lU2xpY2VzOiBudW1iZXI7XG4gIHRvdGFsU2xpY2VzOiBudW1iZXI7XG4gIGRvbmVNaWxlc3RvbmVzOiBudW1iZXI7XG4gIHRvdGFsTWlsZXN0b25lczogbnVtYmVyO1xuICBwaGFzZTogc3RyaW5nO1xufVxuXG4vKipcbiAqIFdyaXRlIGEgcmVwb3J0IHNuYXBzaG90IHRvIC5nc2QvcmVwb3J0cy8sIHVwZGF0ZSByZXBvcnRzLmpzb24sIHJlZ2VuZXJhdGUgaW5kZXguaHRtbC5cbiAqIFJldHVybnMgdGhlIHBhdGggb2YgdGhlIHdyaXR0ZW4gcmVwb3J0IGZpbGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3cml0ZVJlcG9ydFNuYXBzaG90KGFyZ3M6IFdyaXRlUmVwb3J0U25hcHNob3RBcmdzKTogc3RyaW5nIHtcbiAgY29uc3QgZGlyID0gcmVwb3J0c0RpcihhcmdzLmJhc2VQYXRoKTtcbiAgbWtkaXJTeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgY29uc3QgdGltZXN0YW1wID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpLnJlcGxhY2UoL1s6Ll0vZywgJy0nKS5zbGljZSgwLCAxOSk7XG4gIGNvbnN0IHByZWZpeCA9IGFyZ3MubWlsZXN0b25lSWQgPT09ICdmaW5hbCcgPyAnZmluYWwnIDogYXJncy5taWxlc3RvbmVJZDtcbiAgY29uc3QgZmlsZW5hbWUgPSBgJHtwcmVmaXh9LSR7dGltZXN0YW1wfS5odG1sYDtcbiAgY29uc3QgZmlsZVBhdGggPSBqb2luKGRpciwgZmlsZW5hbWUpO1xuXG4gIGF0b21pY1dyaXRlU3luYyhmaWxlUGF0aCwgYXJncy5odG1sLCAndXRmLTgnKTtcblxuICAvLyBMb2FkIG9yIGluaXQgcmVnaXN0cnlcbiAgY29uc3QgZXhpc3RpbmcgPSBsb2FkUmVwb3J0c0luZGV4KGFyZ3MuYmFzZVBhdGgpO1xuICBjb25zdCBpbmRleDogUmVwb3J0c0luZGV4ID0gZXhpc3RpbmcgPz8ge1xuICAgIHZlcnNpb246IDEsXG4gICAgcHJvamVjdE5hbWU6IGFyZ3MucHJvamVjdE5hbWUsXG4gICAgcHJvamVjdFBhdGg6IGFyZ3MucHJvamVjdFBhdGgsXG4gICAgZ3NkVmVyc2lvbjogYXJncy5nc2RWZXJzaW9uLFxuICAgIGVudHJpZXM6IFtdLFxuICB9O1xuXG4gIC8vIEtlZXAgbWV0YWRhdGEgZnJlc2hcbiAgaW5kZXgucHJvamVjdE5hbWUgPSBhcmdzLnByb2plY3ROYW1lO1xuICBpbmRleC5wcm9qZWN0UGF0aCA9IGFyZ3MucHJvamVjdFBhdGg7XG4gIGluZGV4LmdzZFZlcnNpb24gPSBhcmdzLmdzZFZlcnNpb247XG5cbiAgY29uc3QgbGFiZWwgPSBhcmdzLm1pbGVzdG9uZUlkID09PSAnZmluYWwnXG4gICAgPyAnRmluYWwgUmVwb3J0J1xuICAgIDogYCR7YXJncy5taWxlc3RvbmVJZH06ICR7YXJncy5taWxlc3RvbmVUaXRsZX1gO1xuXG4gIGNvbnN0IGVudHJ5OiBSZXBvcnRFbnRyeSA9IHtcbiAgICBmaWxlbmFtZSxcbiAgICBnZW5lcmF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgIG1pbGVzdG9uZUlkOiBhcmdzLm1pbGVzdG9uZUlkLFxuICAgIG1pbGVzdG9uZVRpdGxlOiBhcmdzLm1pbGVzdG9uZVRpdGxlLFxuICAgIGxhYmVsLFxuICAgIGtpbmQ6IGFyZ3Mua2luZCxcbiAgICB0b3RhbENvc3Q6IGFyZ3MudG90YWxDb3N0LFxuICAgIHRvdGFsVG9rZW5zOiBhcmdzLnRvdGFsVG9rZW5zLFxuICAgIHRvdGFsRHVyYXRpb246IGFyZ3MudG90YWxEdXJhdGlvbixcbiAgICBkb25lU2xpY2VzOiBhcmdzLmRvbmVTbGljZXMsXG4gICAgdG90YWxTbGljZXM6IGFyZ3MudG90YWxTbGljZXMsXG4gICAgZG9uZU1pbGVzdG9uZXM6IGFyZ3MuZG9uZU1pbGVzdG9uZXMsXG4gICAgdG90YWxNaWxlc3RvbmVzOiBhcmdzLnRvdGFsTWlsZXN0b25lcyxcbiAgICBwaGFzZTogYXJncy5waGFzZSxcbiAgfTtcblxuICBpbmRleC5lbnRyaWVzLnB1c2goZW50cnkpO1xuICBzYXZlUmVwb3J0c0luZGV4KGFyZ3MuYmFzZVBhdGgsIGluZGV4KTtcbiAgcmVnZW5lcmF0ZUh0bWxJbmRleChhcmdzLmJhc2VQYXRoLCBpbmRleCk7XG5cbiAgcmV0dXJuIGZpbGVQYXRoO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgSFRNTCBJbmRleCBHZW5lcmF0b3IgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBmdW5jdGlvbiByZWdlbmVyYXRlSHRtbEluZGV4KGJhc2VQYXRoOiBzdHJpbmcsIGluZGV4OiBSZXBvcnRzSW5kZXgpOiB2b2lkIHtcbiAgY29uc3QgaHRtbCA9IGJ1aWxkSW5kZXhIdG1sKGluZGV4KTtcbiAgYXRvbWljV3JpdGVTeW5jKHJlcG9ydHNIdG1sSW5kZXhQYXRoKGJhc2VQYXRoKSwgaHRtbCwgJ3V0Zi04Jyk7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkSW5kZXhIdG1sKGluZGV4OiBSZXBvcnRzSW5kZXgpOiBzdHJpbmcge1xuICBjb25zdCB7IHByb2plY3ROYW1lLCBwcm9qZWN0UGF0aCwgZ3NkVmVyc2lvbiwgZW50cmllcyB9ID0gaW5kZXg7XG4gIGNvbnN0IGdlbmVyYXRlZCA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcblxuICAvLyBTb3J0IG9sZGVzdCBcdTIxOTIgbmV3ZXN0IGZvciB0aGUgcHJvZ3Jlc3Npb24gdGltZWxpbmVcbiAgY29uc3Qgc29ydGVkID0gWy4uLmVudHJpZXNdLnNvcnQoXG4gICAgKGEsIGIpID0+IG5ldyBEYXRlKGEuZ2VuZXJhdGVkQXQpLmdldFRpbWUoKSAtIG5ldyBEYXRlKGIuZ2VuZXJhdGVkQXQpLmdldFRpbWUoKVxuICApO1xuXG4gIGNvbnN0IGxhdGVzdEVudHJ5ID0gc29ydGVkW3NvcnRlZC5sZW5ndGggLSAxXTtcbiAgY29uc3Qgb3ZlcmFsbFBjdCA9IGxhdGVzdEVudHJ5XG4gICAgPyAobGF0ZXN0RW50cnkudG90YWxTbGljZXMgPiAwXG4gICAgICAgID8gTWF0aC5yb3VuZCgobGF0ZXN0RW50cnkuZG9uZVNsaWNlcyAvIGxhdGVzdEVudHJ5LnRvdGFsU2xpY2VzKSAqIDEwMClcbiAgICAgICAgOiAwKVxuICAgIDogMDtcblxuICAvLyBUT0M6IGdyb3VwIGJ5IG1pbGVzdG9uZVxuICBjb25zdCBtaWxlc3RvbmVHcm91cHMgPSBuZXcgTWFwPHN0cmluZywgUmVwb3J0RW50cnlbXT4oKTtcbiAgZm9yIChjb25zdCBlIG9mIHNvcnRlZCkge1xuICAgIGNvbnN0IGtleSA9IGUubWlsZXN0b25lSWQ7XG4gICAgY29uc3QgYXJyID0gbWlsZXN0b25lR3JvdXBzLmdldChrZXkpID8/IFtdO1xuICAgIGFyci5wdXNoKGUpO1xuICAgIG1pbGVzdG9uZUdyb3Vwcy5zZXQoa2V5LCBhcnIpO1xuICB9XG5cbiAgY29uc3QgdG9jSHRtbCA9IFsuLi5taWxlc3RvbmVHcm91cHMuZW50cmllcygpXS5tYXAoKFttaWQsIGdyb3VwXSkgPT4ge1xuICAgIGNvbnN0IGxpbmtzID0gZ3JvdXAubWFwKGUgPT5cbiAgICAgIGA8bGk+PGEgaHJlZj1cIiR7ZXNjKGUuZmlsZW5hbWUpfVwiPiR7Zm9ybWF0RGF0ZVNob3J0KGUuZ2VuZXJhdGVkQXQpfTwvYT4gPHNwYW4gY2xhc3M9XCJ0b2Mta2luZCB0b2MtJHtlLmtpbmR9XCI+JHtlLmtpbmR9PC9zcGFuPjwvbGk+YFxuICAgICkuam9pbignJyk7XG4gICAgcmV0dXJuIGBcbiAgICAgIDxkaXYgY2xhc3M9XCJ0b2MtZ3JvdXBcIj5cbiAgICAgICAgPGRpdiBjbGFzcz1cInRvYy1ncm91cC1sYWJlbFwiPiR7ZXNjKG1pZCA9PT0gJ2ZpbmFsJyA/ICdGaW5hbCcgOiBtaWQpfTwvZGl2PlxuICAgICAgICA8dWw+JHtsaW5rc308L3VsPlxuICAgICAgPC9kaXY+YDtcbiAgfSkuam9pbignJyk7XG5cbiAgLy8gUHJvZ3Jlc3Npb24gY2FyZHNcbiAgY29uc3QgY2FyZEh0bWwgPSBzb3J0ZWQubWFwKChlLCBpKSA9PiB7XG4gICAgY29uc3QgcGN0ID0gZS50b3RhbFNsaWNlcyA+IDAgPyBNYXRoLnJvdW5kKChlLmRvbmVTbGljZXMgLyBlLnRvdGFsU2xpY2VzKSAqIDEwMCkgOiAwO1xuICAgIGNvbnN0IGlzTGF0ZXN0ID0gaSA9PT0gc29ydGVkLmxlbmd0aCAtIDE7XG5cbiAgICAvLyBEZWx0YSB2cyBwcmV2aW91c1xuICAgIGxldCBkZWx0YUh0bWwgPSAnJztcbiAgICBpZiAoaSA+IDApIHtcbiAgICAgIGNvbnN0IHByZXYgPSBzb3J0ZWRbaSAtIDFdO1xuICAgICAgY29uc3QgZENvc3QgPSBlLnRvdGFsQ29zdCAtIHByZXYudG90YWxDb3N0O1xuICAgICAgY29uc3QgZFNsaWNlcyA9IGUuZG9uZVNsaWNlcyAtIHByZXYuZG9uZVNsaWNlcztcbiAgICAgIGNvbnN0IGRNaWxsZXN0b25lcyA9IGUuZG9uZU1pbGVzdG9uZXMgLSBwcmV2LmRvbmVNaWxlc3RvbmVzO1xuICAgICAgY29uc3QgcGFydHM6IHN0cmluZ1tdID0gW107XG4gICAgICBpZiAoZENvc3QgPiAwKSBwYXJ0cy5wdXNoKGArJHtmb3JtYXRDb3N0KGRDb3N0KX1gKTtcbiAgICAgIGlmIChkU2xpY2VzID4gMCkgcGFydHMucHVzaChgKyR7ZFNsaWNlc30gc2xpY2Uke2RTbGljZXMgIT09IDEgPyAncycgOiAnJ31gKTtcbiAgICAgIGlmIChkTWlsbGVzdG9uZXMgPiAwKSBwYXJ0cy5wdXNoKGArJHtkTWlsbGVzdG9uZXN9IG1pbGVzdG9uZSR7ZE1pbGxlc3RvbmVzICE9PSAxID8gJ3MnIDogJyd9YCk7XG4gICAgICBpZiAocGFydHMubGVuZ3RoID4gMCkge1xuICAgICAgICBkZWx0YUh0bWwgPSBgPGRpdiBjbGFzcz1cImNhcmQtZGVsdGFcIj4ke3BhcnRzLm1hcChwID0+IGA8c3Bhbj4ke2VzYyhwKX08L3NwYW4+YCkuam9pbignJyl9PC9kaXY+YDtcbiAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4gYFxuICAgICAgPGEgY2xhc3M9XCJyZXBvcnQtY2FyZCR7aXNMYXRlc3QgPyAnIGNhcmQtbGF0ZXN0JyA6ICcnfVwiIGhyZWY9XCIke2VzYyhlLmZpbGVuYW1lKX1cIj5cbiAgICAgICAgPGRpdiBjbGFzcz1cImNhcmQtdG9wXCI+XG4gICAgICAgICAgPHNwYW4gY2xhc3M9XCJjYXJkLWxhYmVsXCI+JHtlc2MoZS5sYWJlbCl9PC9zcGFuPlxuICAgICAgICAgIDxzcGFuIGNsYXNzPVwiY2FyZC1raW5kIGNhcmQta2luZC0ke2Uua2luZH1cIj4ke2Uua2luZH08L3NwYW4+XG4gICAgICAgIDwvZGl2PlxuICAgICAgICA8ZGl2IGNsYXNzPVwiY2FyZC1kYXRlXCI+JHtmb3JtYXREYXRlU2hvcnQoZS5nZW5lcmF0ZWRBdCl9PC9kaXY+XG4gICAgICAgIDxkaXYgY2xhc3M9XCJjYXJkLXByb2dyZXNzXCI+XG4gICAgICAgICAgPGRpdiBjbGFzcz1cImNhcmQtYmFyLXRyYWNrXCI+XG4gICAgICAgICAgICA8ZGl2IGNsYXNzPVwiY2FyZC1iYXItZmlsbFwiIHN0eWxlPVwid2lkdGg6JHtwY3R9JVwiPjwvZGl2PlxuICAgICAgICAgIDwvZGl2PlxuICAgICAgICAgIDxzcGFuIGNsYXNzPVwiY2FyZC1wY3RcIj4ke3BjdH0lPC9zcGFuPlxuICAgICAgICA8L2Rpdj5cbiAgICAgICAgPGRpdiBjbGFzcz1cImNhcmQtc3RhdHNcIj5cbiAgICAgICAgICA8c3Bhbj4ke2VzYyhmb3JtYXRDb3N0KGUudG90YWxDb3N0KSl9PC9zcGFuPlxuICAgICAgICAgIDxzcGFuPiR7ZXNjKGZvcm1hdFRva2VuQ291bnQoZS50b3RhbFRva2VucykpfTwvc3Bhbj5cbiAgICAgICAgICA8c3Bhbj4ke2VzYyhmb3JtYXREdXJhdGlvbihlLnRvdGFsRHVyYXRpb24pKX08L3NwYW4+XG4gICAgICAgICAgPHNwYW4+JHtlLmRvbmVTbGljZXN9LyR7ZS50b3RhbFNsaWNlc30gc2xpY2VzPC9zcGFuPlxuICAgICAgICA8L2Rpdj5cbiAgICAgICAgJHtkZWx0YUh0bWx9XG4gICAgICAgICR7aXNMYXRlc3QgPyAnPGRpdiBjbGFzcz1cImNhcmQtbGF0ZXN0LWJhZGdlXCI+TGF0ZXN0PC9kaXY+JyA6ICcnfVxuICAgICAgPC9hPmA7XG4gIH0pLmpvaW4oJycpO1xuXG4gIC8vIENvc3QgcHJvZ3Jlc3Npb24gbWluaS1jaGFydCAoaW5saW5lIFNWRyBzcGFya2xpbmUpXG4gIGNvbnN0IHNwYXJrbGluZVN2ZyA9IHNvcnRlZC5sZW5ndGggPiAxID8gYnVpbGRDb3N0U3BhcmtsaW5lKHNvcnRlZCkgOiAnJztcblxuICAvLyBTdW1tYXJ5IG9mIGxhdGVzdCBzdGF0ZVxuICBjb25zdCBzdW1tYXJ5SHRtbCA9IGxhdGVzdEVudHJ5ID8gYFxuICAgIDxkaXYgY2xhc3M9XCJpZHgtc3VtbWFyeVwiPlxuICAgICAgPGRpdiBjbGFzcz1cImlkeC1zdGF0XCI+PHNwYW4gY2xhc3M9XCJpZHgtdmFsXCI+JHtmb3JtYXRDb3N0KGxhdGVzdEVudHJ5LnRvdGFsQ29zdCl9PC9zcGFuPjxzcGFuIGNsYXNzPVwiaWR4LWxibFwiPlRvdGFsIENvc3Q8L3NwYW4+PC9kaXY+XG4gICAgICA8ZGl2IGNsYXNzPVwiaWR4LXN0YXRcIj48c3BhbiBjbGFzcz1cImlkeC12YWxcIj4ke2Zvcm1hdFRva2VuQ291bnQobGF0ZXN0RW50cnkudG90YWxUb2tlbnMpfTwvc3Bhbj48c3BhbiBjbGFzcz1cImlkeC1sYmxcIj5Ub3RhbCBUb2tlbnM8L3NwYW4+PC9kaXY+XG4gICAgICA8ZGl2IGNsYXNzPVwiaWR4LXN0YXRcIj48c3BhbiBjbGFzcz1cImlkeC12YWxcIj4ke2Zvcm1hdER1cmF0aW9uKGxhdGVzdEVudHJ5LnRvdGFsRHVyYXRpb24pfTwvc3Bhbj48c3BhbiBjbGFzcz1cImlkeC1sYmxcIj5EdXJhdGlvbjwvc3Bhbj48L2Rpdj5cbiAgICAgIDxkaXYgY2xhc3M9XCJpZHgtc3RhdFwiPjxzcGFuIGNsYXNzPVwiaWR4LXZhbFwiPiR7bGF0ZXN0RW50cnkuZG9uZVNsaWNlc30vJHtsYXRlc3RFbnRyeS50b3RhbFNsaWNlc308L3NwYW4+PHNwYW4gY2xhc3M9XCJpZHgtbGJsXCI+U2xpY2VzPC9zcGFuPjwvZGl2PlxuICAgICAgPGRpdiBjbGFzcz1cImlkeC1zdGF0XCI+PHNwYW4gY2xhc3M9XCJpZHgtdmFsXCI+JHtsYXRlc3RFbnRyeS5kb25lTWlsZXN0b25lc30vJHtsYXRlc3RFbnRyeS50b3RhbE1pbGVzdG9uZXN9PC9zcGFuPjxzcGFuIGNsYXNzPVwiaWR4LWxibFwiPk1pbGVzdG9uZXM8L3NwYW4+PC9kaXY+XG4gICAgICA8ZGl2IGNsYXNzPVwiaWR4LXN0YXRcIj48c3BhbiBjbGFzcz1cImlkeC12YWxcIj4ke2VudHJpZXMubGVuZ3RofTwvc3Bhbj48c3BhbiBjbGFzcz1cImlkeC1sYmxcIj5SZXBvcnRzPC9zcGFuPjwvZGl2PlxuICAgIDwvZGl2PlxuICAgIDxkaXYgY2xhc3M9XCJpZHgtcHJvZ3Jlc3NcIj5cbiAgICAgIDxkaXYgY2xhc3M9XCJpZHgtYmFyLXRyYWNrXCI+PGRpdiBjbGFzcz1cImlkeC1iYXItZmlsbFwiIHN0eWxlPVwid2lkdGg6JHtvdmVyYWxsUGN0fSVcIj48L2Rpdj48L2Rpdj5cbiAgICAgIDxzcGFuIGNsYXNzPVwiaWR4LXBjdFwiPiR7b3ZlcmFsbFBjdH0lIGNvbXBsZXRlPC9zcGFuPlxuICAgIDwvZGl2PmAgOiAnPHAgY2xhc3M9XCJlbXB0eVwiPk5vIHJlcG9ydHMgZ2VuZXJhdGVkIHlldC48L3A+JztcblxuICByZXR1cm4gYDwhRE9DVFlQRSBodG1sPlxuPGh0bWwgbGFuZz1cImVuXCI+XG48aGVhZD5cbjxtZXRhIGNoYXJzZXQ9XCJVVEYtOFwiPlxuPG1ldGEgbmFtZT1cInZpZXdwb3J0XCIgY29udGVudD1cIndpZHRoPWRldmljZS13aWR0aCwgaW5pdGlhbC1zY2FsZT0xLjBcIj5cbjx0aXRsZT5HU0QgUmVwb3J0cyBcdTIwMTQgJHtlc2MocHJvamVjdE5hbWUpfTwvdGl0bGU+XG48c3R5bGU+JHtJTkRFWF9DU1N9PC9zdHlsZT5cbjwvaGVhZD5cbjxib2R5PlxuPGhlYWRlcj5cbiAgPGRpdiBjbGFzcz1cImhkci1pbm5lclwiPlxuICAgIDxkaXYgY2xhc3M9XCJicmFuZGluZ1wiPlxuICAgICAgPHNwYW4gY2xhc3M9XCJsb2dvXCI+R1NEPC9zcGFuPlxuICAgICAgPHNwYW4gY2xhc3M9XCJ2ZXJcIj52JHtlc2MoZ3NkVmVyc2lvbil9PC9zcGFuPlxuICAgIDwvZGl2PlxuICAgIDxkaXYgY2xhc3M9XCJoZHItbWV0YVwiPlxuICAgICAgPGgxPiR7ZXNjKHByb2plY3ROYW1lKX0gPHNwYW4gY2xhc3M9XCJoZHItc3VidGl0bGVcIj5SZXBvcnRzPC9zcGFuPjwvaDE+XG4gICAgICA8c3BhbiBjbGFzcz1cImhkci1wYXRoXCI+JHtlc2MocHJvamVjdFBhdGgpfTwvc3Bhbj5cbiAgICA8L2Rpdj5cbiAgICA8ZGl2IGNsYXNzPVwiaGRyLXJpZ2h0XCI+XG4gICAgICA8c3BhbiBjbGFzcz1cImdlbi1sYmxcIj5VcGRhdGVkPC9zcGFuPlxuICAgICAgPHNwYW4gY2xhc3M9XCJnZW5cIj4ke2Zvcm1hdERhdGVTaG9ydChnZW5lcmF0ZWQpfTwvc3Bhbj5cbiAgICA8L2Rpdj5cbiAgPC9kaXY+XG48L2hlYWRlcj5cblxuPGRpdiBjbGFzcz1cImxheW91dFwiPlxuICA8IS0tIFNpZGViYXIgVE9DIC0tPlxuICA8YXNpZGUgY2xhc3M9XCJzaWRlYmFyXCI+XG4gICAgPGRpdiBjbGFzcz1cInNpZGViYXItdGl0bGVcIj5SZXBvcnRzPC9kaXY+XG4gICAgJHtzb3J0ZWQubGVuZ3RoID4gMCA/IHRvY0h0bWwgOiAnPHAgY2xhc3M9XCJlbXB0eVwiPk5vIHJlcG9ydHMgeWV0LjwvcD4nfVxuICA8L2FzaWRlPlxuXG4gIDwhLS0gTWFpbiBjb250ZW50IC0tPlxuICA8bWFpbj5cbiAgICA8c2VjdGlvbiBjbGFzcz1cImlkeC1vdmVydmlld1wiPlxuICAgICAgPGgyPlByb2plY3QgT3ZlcnZpZXc8L2gyPlxuICAgICAgJHtzdW1tYXJ5SHRtbH1cbiAgICAgICR7c3BhcmtsaW5lU3ZnID8gYDxkaXYgY2xhc3M9XCJzcGFya2xpbmUtd3JhcFwiPjxoMz5Db3N0IFByb2dyZXNzaW9uPC9oMz4ke3NwYXJrbGluZVN2Z308L2Rpdj5gIDogJyd9XG4gICAgPC9zZWN0aW9uPlxuXG4gICAgPHNlY3Rpb24gY2xhc3M9XCJpZHgtY2FyZHNcIj5cbiAgICAgIDxoMj5Qcm9ncmVzc2lvbiA8c3BhbiBjbGFzcz1cInNlYy1jb3VudFwiPiR7ZW50cmllcy5sZW5ndGh9PC9zcGFuPjwvaDI+XG4gICAgICAke3NvcnRlZC5sZW5ndGggPiAwXG4gICAgICAgID8gYDxkaXYgY2xhc3M9XCJjYXJkcy1ncmlkXCI+JHtjYXJkSHRtbH08L2Rpdj5gXG4gICAgICAgIDogJzxwIGNsYXNzPVwiZW1wdHlcIj5ObyByZXBvcnRzIGdlbmVyYXRlZCB5ZXQuIFJ1biA8Y29kZT4vZ3NkIGV4cG9ydCAtLWh0bWw8L2NvZGU+IG9yIGVuYWJsZSA8Y29kZT5hdXRvX3JlcG9ydDogdHJ1ZTwvY29kZT4uPC9wPid9XG4gICAgPC9zZWN0aW9uPlxuICA8L21haW4+XG48L2Rpdj5cblxuPGZvb3Rlcj5cbiAgPGRpdiBjbGFzcz1cImZ0ci1pbm5lclwiPlxuICAgIDxzcGFuIGNsYXNzPVwiZnRyLWJyYW5kXCI+R1NEIHYke2VzYyhnc2RWZXJzaW9uKX08L3NwYW4+XG4gICAgPHNwYW4gY2xhc3M9XCJmdHItc2VwXCI+XHUyMDE0PC9zcGFuPlxuICAgIDxzcGFuPiR7ZXNjKHByb2plY3ROYW1lKX08L3NwYW4+XG4gICAgPHNwYW4gY2xhc3M9XCJmdHItc2VwXCI+XHUyMDE0PC9zcGFuPlxuICAgIDxzcGFuPiR7ZXNjKHByb2plY3RQYXRoKX08L3NwYW4+XG4gICAgPHNwYW4gY2xhc3M9XCJmdHItc2VwXCI+XHUyMDE0PC9zcGFuPlxuICAgIDxzcGFuPlVwZGF0ZWQgJHtmb3JtYXREYXRlU2hvcnQoZ2VuZXJhdGVkKX08L3NwYW4+XG4gIDwvZGl2PlxuPC9mb290ZXI+XG48L2JvZHk+XG48L2h0bWw+YDtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIENvc3Qgc3BhcmtsaW5lIChpbmxpbmUgU1ZHKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gYnVpbGRDb3N0U3BhcmtsaW5lKGVudHJpZXM6IFJlcG9ydEVudHJ5W10pOiBzdHJpbmcge1xuICBjb25zdCBjb3N0cyA9IGVudHJpZXMubWFwKGUgPT4gZS50b3RhbENvc3QpO1xuICBjb25zdCBtYXhDb3N0ID0gTWF0aC5tYXgoLi4uY29zdHMsIDAuMDAxKTtcbiAgY29uc3QgVyA9IDYwMCwgSCA9IDYwLCBQQUQgPSAxMjtcbiAgY29uc3QgeFN0ZXAgPSBlbnRyaWVzLmxlbmd0aCA+IDEgPyAoVyAtIFBBRCAqIDIpIC8gKGVudHJpZXMubGVuZ3RoIC0gMSkgOiBXIC0gUEFEICogMjtcblxuICBjb25zdCBwb2ludHMgPSBjb3N0cy5tYXAoKGMsIGkpID0+IHtcbiAgICBjb25zdCB4ID0gUEFEICsgaSAqIHhTdGVwO1xuICAgIGNvbnN0IHkgPSBQQUQgKyAoMSAtIGMgLyBtYXhDb3N0KSAqIChIIC0gUEFEICogMik7XG4gICAgcmV0dXJuIGAke3gudG9GaXhlZCgxKX0sJHt5LnRvRml4ZWQoMSl9YDtcbiAgfSkuam9pbignICcpO1xuXG4gIGNvbnN0IGRvdHMgPSBjb3N0cy5tYXAoKGMsIGkpID0+IHtcbiAgICBjb25zdCB4ID0gUEFEICsgaSAqIHhTdGVwO1xuICAgIGNvbnN0IHkgPSBQQUQgKyAoMSAtIGMgLyBtYXhDb3N0KSAqIChIIC0gUEFEICogMik7XG4gICAgcmV0dXJuIGA8Y2lyY2xlIGN4PVwiJHt4LnRvRml4ZWQoMSl9XCIgY3k9XCIke3kudG9GaXhlZCgxKX1cIiByPVwiM1wiIGNsYXNzPVwic3BhcmstZG90XCI+XG4gICAgICA8dGl0bGU+JHtlc2MoZW50cmllc1tpXS5sYWJlbCl9IFx1MjAxNCAke2Zvcm1hdENvc3QoYyl9PC90aXRsZT5cbiAgICA8L2NpcmNsZT5gO1xuICB9KS5qb2luKCcnKTtcblxuICAvLyBMYWJlbHMgYXQgc3RhcnQgYW5kIGVuZFxuICBjb25zdCBzdGFydExhYmVsID0gZm9ybWF0Q29zdChjb3N0c1swXSk7XG4gIGNvbnN0IGVuZExhYmVsICAgPSBmb3JtYXRDb3N0KGNvc3RzW2Nvc3RzLmxlbmd0aCAtIDFdKTtcblxuICByZXR1cm4gYFxuICAgIDxkaXYgY2xhc3M9XCJzcGFya2xpbmVcIj5cbiAgICAgIDxzdmcgdmlld0JveD1cIjAgMCAke1d9ICR7SH1cIiB3aWR0aD1cIiR7V31cIiBoZWlnaHQ9XCIke0h9XCIgY2xhc3M9XCJzcGFyay1zdmdcIj5cbiAgICAgICAgPHBvbHlsaW5lIHBvaW50cz1cIiR7ZXNjKHBvaW50cyl9XCIgY2xhc3M9XCJzcGFyay1saW5lXCIgZmlsbD1cIm5vbmVcIi8+XG4gICAgICAgICR7ZG90c31cbiAgICAgICAgPHRleHQgeD1cIiR7UEFEfVwiIHk9XCIke0ggLSAyfVwiIGNsYXNzPVwic3BhcmstbGJsXCI+JHtlc2Moc3RhcnRMYWJlbCl9PC90ZXh0PlxuICAgICAgICA8dGV4dCB4PVwiJHtXIC0gUEFEfVwiIHk9XCIke0ggLSAyfVwiIHRleHQtYW5jaG9yPVwiZW5kXCIgY2xhc3M9XCJzcGFyay1sYmxcIj4ke2VzYyhlbmRMYWJlbCl9PC90ZXh0PlxuICAgICAgPC9zdmc+XG4gICAgICA8ZGl2IGNsYXNzPVwic3BhcmstYXhpc1wiPlxuICAgICAgICAke2VudHJpZXMubWFwKChlLCBpKSA9PiB7XG4gICAgICAgICAgY29uc3QgeCA9IChQQUQgKyBpICogeFN0ZXApIC8gVyAqIDEwMDtcbiAgICAgICAgICByZXR1cm4gYDxzcGFuIGNsYXNzPVwic3BhcmstdGlja1wiIHN0eWxlPVwibGVmdDoke3gudG9GaXhlZCgxKX0lXCIgdGl0bGU9XCIke2VzYyhlLmdlbmVyYXRlZEF0KX1cIj4ke2VzYyhlLm1pbGVzdG9uZUlkID09PSAnZmluYWwnID8gJ2ZpbmFsJyA6IGUubWlsZXN0b25lSWQpfTwvc3Bhbj5gO1xuICAgICAgICB9KS5qb2luKCcnKX1cbiAgICAgIDwvZGl2PlxuICAgIDwvZGl2PmA7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBIZWxwZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5cbmZ1bmN0aW9uIGVzYyhzOiBzdHJpbmcgfCBudW1iZXIgfCB1bmRlZmluZWQgfCBudWxsKTogc3RyaW5nIHtcbiAgaWYgKHMgPT0gbnVsbCkgcmV0dXJuICcnO1xuICByZXR1cm4gU3RyaW5nKHMpLnJlcGxhY2UoLyYvZywgJyZhbXA7JykucmVwbGFjZSgvPC9nLCAnJmx0OycpLnJlcGxhY2UoLz4vZywgJyZndDsnKS5yZXBsYWNlKC9cIi9nLCAnJnF1b3Q7JykucmVwbGFjZSgvJy9nLCAnJiMzOTsnKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEluZGV4IENTUyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuY29uc3QgSU5ERVhfQ1NTID0gYFxuKiwqOjpiZWZvcmUsKjo6YWZ0ZXJ7Ym94LXNpemluZzpib3JkZXItYm94O21hcmdpbjowO3BhZGRpbmc6MH1cbjpyb290e1xuICAtLWJnLTA6IzBmMTExNTstLWJnLTE6IzE2MTgxZDstLWJnLTI6IzFlMjAyODstLWJnLTM6IzI3MmEzMztcbiAgLS1ib3JkZXItMTojMmIyZTM4Oy0tYm9yZGVyLTI6IzNiM2Y0YztcbiAgLS10ZXh0LTA6I2VkZWRlZjstLXRleHQtMTojYTFhMWFhOy0tdGV4dC0yOiM3MTcxN2E7XG4gIC0tYWNjZW50OiM1ZTZhZDI7LS1hY2NlbnQtc3VidGxlOnJnYmEoOTQsMTA2LDIxMCwuMTIpO1xuICAtLWZvbnQ6J0ludGVyJywtYXBwbGUtc3lzdGVtLEJsaW5rTWFjU3lzdGVtRm9udCwnU2Vnb2UgVUknLHNhbnMtc2VyaWY7XG4gIC0tbW9ubzonSmV0QnJhaW5zIE1vbm8nLCdGaXJhIENvZGUnLHVpLW1vbm9zcGFjZSxtb25vc3BhY2U7XG59XG5odG1se2ZvbnQtc2l6ZToxM3B4fVxuYm9keXtiYWNrZ3JvdW5kOnZhcigtLWJnLTApO2NvbG9yOnZhcigtLXRleHQtMCk7Zm9udC1mYW1pbHk6dmFyKC0tZm9udCk7bGluZS1oZWlnaHQ6MS42Oy13ZWJraXQtZm9udC1zbW9vdGhpbmc6YW50aWFsaWFzZWR9XG5he2NvbG9yOnZhcigtLWFjY2VudCk7dGV4dC1kZWNvcmF0aW9uOm5vbmV9XG5hOmhvdmVye3RleHQtZGVjb3JhdGlvbjp1bmRlcmxpbmV9XG5oMntmb250LXNpemU6MTRweDtmb250LXdlaWdodDo2MDA7dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO2xldHRlci1zcGFjaW5nOi41cHg7Y29sb3I6dmFyKC0tdGV4dC0xKTttYXJnaW4tYm90dG9tOjE2cHg7cGFkZGluZy1ib3R0b206OHB4O2JvcmRlci1ib3R0b206MXB4IHNvbGlkIHZhcigtLWJvcmRlci0xKX1cbmgze2ZvbnQtc2l6ZToxM3B4O2ZvbnQtd2VpZ2h0OjYwMDtjb2xvcjp2YXIoLS10ZXh0LTEpO21hcmdpbjoxNnB4IDAgOHB4fVxuY29kZXtmb250LWZhbWlseTp2YXIoLS1tb25vKTtmb250LXNpemU6MTJweDtiYWNrZ3JvdW5kOnZhcigtLWJnLTMpO3BhZGRpbmc6MXB4IDVweDtib3JkZXItcmFkaXVzOjNweH1cbi5lbXB0eXtjb2xvcjp2YXIoLS10ZXh0LTIpO2ZvbnQtc2l6ZToxM3B4O3BhZGRpbmc6OHB4IDB9XG4uY291bnR7Zm9udC1zaXplOjExcHg7Zm9udC13ZWlnaHQ6NTAwO2NvbG9yOnZhcigtLXRleHQtMik7YmFja2dyb3VuZDp2YXIoLS1iZy0zKTtib3JkZXItcmFkaXVzOjNweDtwYWRkaW5nOjFweCA2cHh9XG5cbi8qIEhlYWRlciAqL1xuaGVhZGVye2JhY2tncm91bmQ6dmFyKC0tYmctMSk7Ym9yZGVyLWJvdHRvbToxcHggc29saWQgdmFyKC0tYm9yZGVyLTEpO3BhZGRpbmc6MTJweCAzMnB4O3Bvc2l0aW9uOnN0aWNreTt0b3A6MDt6LWluZGV4OjEwMH1cbi5oZHItaW5uZXJ7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MTZweDttYXgtd2lkdGg6MTI4MHB4O21hcmdpbjowIGF1dG99XG4uYnJhbmRpbmd7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmJhc2VsaW5lO2dhcDo2cHg7ZmxleC1zaHJpbms6MH1cbi5sb2dve2ZvbnQtc2l6ZToxOHB4O2ZvbnQtd2VpZ2h0OjgwMDtsZXR0ZXItc3BhY2luZzotLjVweDtjb2xvcjp2YXIoLS10ZXh0LTApfVxuLnZlcntmb250LXNpemU6MTBweDtjb2xvcjp2YXIoLS10ZXh0LTIpO2ZvbnQtZmFtaWx5OnZhcigtLW1vbm8pfVxuLmhkci1tZXRhe2ZsZXg6MTttaW4td2lkdGg6MH1cbi5oZHItbWV0YSBoMXtmb250LXNpemU6MTVweDtmb250LXdlaWdodDo2MDB9XG4uaGRyLXN1YnRpdGxle2NvbG9yOnZhcigtLXRleHQtMik7Zm9udC13ZWlnaHQ6NDAwO2ZvbnQtc2l6ZToxM3B4O21hcmdpbi1sZWZ0OjRweH1cbi5oZHItcGF0aHtmb250LXNpemU6MTFweDtjb2xvcjp2YXIoLS10ZXh0LTIpO2ZvbnQtZmFtaWx5OnZhcigtLW1vbm8pO2Rpc3BsYXk6YmxvY2s7b3ZlcmZsb3c6aGlkZGVuO3RleHQtb3ZlcmZsb3c6ZWxsaXBzaXM7d2hpdGUtc3BhY2U6bm93cmFwfVxuLmhkci1yaWdodHt0ZXh0LWFsaWduOnJpZ2h0O2ZsZXgtc2hyaW5rOjB9XG4uZ2VuLWxibHtmb250LXNpemU6MTBweDtjb2xvcjp2YXIoLS10ZXh0LTIpO3RleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTtsZXR0ZXItc3BhY2luZzouNXB4O2Rpc3BsYXk6YmxvY2t9XG4uZ2Vue2ZvbnQtc2l6ZToxMXB4O2NvbG9yOnZhcigtLXRleHQtMSl9XG5cbi8qIExheW91dCAqL1xuLmxheW91dHtkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjIwMHB4IDFmcjtnYXA6MDttYXgtd2lkdGg6MTI4MHB4O21hcmdpbjowIGF1dG87bWluLWhlaWdodDpjYWxjKDEwMHZoIC0gMTIwcHgpfVxuXG4vKiBTaWRlYmFyICovXG4uc2lkZWJhcntiYWNrZ3JvdW5kOnZhcigtLWJnLTEpO2JvcmRlci1yaWdodDoxcHggc29saWQgdmFyKC0tYm9yZGVyLTEpO3BhZGRpbmc6MjBweCAxNHB4O3Bvc2l0aW9uOnN0aWNreTt0b3A6NTJweDtoZWlnaHQ6Y2FsYygxMDB2aCAtIDUycHgpO292ZXJmbG93LXk6YXV0b31cbi5zaWRlYmFyLXRpdGxle2ZvbnQtc2l6ZToxMHB4O2ZvbnQtd2VpZ2h0OjYwMDtjb2xvcjp2YXIoLS10ZXh0LTIpO3RleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTtsZXR0ZXItc3BhY2luZzouNXB4O21hcmdpbi1ib3R0b206MTJweH1cbi50b2MtZ3JvdXB7bWFyZ2luLWJvdHRvbToxNHB4fVxuLnRvYy1ncm91cC1sYWJlbHtmb250LXNpemU6MTFweDtmb250LXdlaWdodDo2MDA7Y29sb3I6dmFyKC0tdGV4dC0xKTttYXJnaW4tYm90dG9tOjNweDtmb250LWZhbWlseTp2YXIoLS1tb25vKX1cbi50b2MtZ3JvdXAgdWx7bGlzdC1zdHlsZTpub25lO2Rpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47Z2FwOjFweH1cbi50b2MtZ3JvdXAgbGl7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6NnB4fVxuLnRvYy1ncm91cCBhe2ZvbnQtc2l6ZToxMXB4O2NvbG9yOnZhcigtLXRleHQtMik7cGFkZGluZzoycHggNHB4O2JvcmRlci1yYWRpdXM6M3B4O2ZsZXg6MTtvdmVyZmxvdzpoaWRkZW47dGV4dC1vdmVyZmxvdzplbGxpcHNpczt3aGl0ZS1zcGFjZTpub3dyYXB9XG4udG9jLWdyb3VwIGE6aG92ZXJ7YmFja2dyb3VuZDp2YXIoLS1iZy0yKTtjb2xvcjp2YXIoLS10ZXh0LTApO3RleHQtZGVjb3JhdGlvbjpub25lfVxuLnRvYy1raW5ke2ZvbnQtc2l6ZTo5cHg7Y29sb3I6dmFyKC0tdGV4dC0yKTtmb250LWZhbWlseTp2YXIoLS1tb25vKTtmbGV4LXNocmluazowfVxuXG4vKiBNYWluICovXG5tYWlue3BhZGRpbmc6MjhweDtkaXNwbGF5OmZsZXg7ZmxleC1kaXJlY3Rpb246Y29sdW1uO2dhcDo0MHB4fVxuXG4vKiBPdmVydmlldyAqL1xuLmlkeC1zdW1tYXJ5e2Rpc3BsYXk6ZmxleDtmbGV4LXdyYXA6d3JhcDtnYXA6MXB4O2JhY2tncm91bmQ6dmFyKC0tYm9yZGVyLTEpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyLTEpO2JvcmRlci1yYWRpdXM6NHB4O292ZXJmbG93OmhpZGRlbjttYXJnaW4tYm90dG9tOjE2cHh9XG4uaWR4LXN0YXR7YmFja2dyb3VuZDp2YXIoLS1iZy0xKTtwYWRkaW5nOjEwcHggMTZweDtkaXNwbGF5OmZsZXg7ZmxleC1kaXJlY3Rpb246Y29sdW1uO2dhcDoycHg7bWluLXdpZHRoOjEwMHB4O2ZsZXg6MX1cbi5pZHgtdmFse2ZvbnQtc2l6ZToxOHB4O2ZvbnQtd2VpZ2h0OjYwMDtjb2xvcjp2YXIoLS10ZXh0LTApO2ZvbnQtdmFyaWFudC1udW1lcmljOnRhYnVsYXItbnVtc31cbi5pZHgtbGJse2ZvbnQtc2l6ZToxMHB4O2NvbG9yOnZhcigtLXRleHQtMik7dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO2xldHRlci1zcGFjaW5nOi40cHh9XG4uaWR4LXByb2dyZXNze2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjEwcHg7bWFyZ2luLXRvcDoxMHB4fVxuLmlkeC1iYXItdHJhY2t7ZmxleDoxO2hlaWdodDo0cHg7YmFja2dyb3VuZDp2YXIoLS1iZy0zKTtib3JkZXItcmFkaXVzOjJweDtvdmVyZmxvdzpoaWRkZW59XG4uaWR4LWJhci1maWxse2hlaWdodDoxMDAlO2JhY2tncm91bmQ6dmFyKC0tYWNjZW50KTtib3JkZXItcmFkaXVzOjJweH1cbi5pZHgtcGN0e2ZvbnQtc2l6ZToxMnB4O2ZvbnQtd2VpZ2h0OjYwMDtjb2xvcjp2YXIoLS10ZXh0LTEpO21pbi13aWR0aDo0MHB4O3RleHQtYWxpZ246cmlnaHR9XG5cbi8qIFNwYXJrbGluZSAqL1xuLnNwYXJrbGluZS13cmFwe21hcmdpbi10b3A6MjBweH1cbi5zcGFya2xpbmV7cG9zaXRpb246cmVsYXRpdmV9XG4uc3Bhcmstc3Zne2Rpc3BsYXk6YmxvY2s7YmFja2dyb3VuZDp2YXIoLS1iZy0xKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlci0xKTtib3JkZXItcmFkaXVzOjRweDtvdmVyZmxvdzp2aXNpYmxlO21heC13aWR0aDoxMDAlfVxuLnNwYXJrLWxpbmV7c3Ryb2tlOnZhcigtLWFjY2VudCk7c3Ryb2tlLXdpZHRoOjEuNTtmaWxsOm5vbmV9XG4uc3BhcmstZG90e2ZpbGw6dmFyKC0tYWNjZW50KTtzdHJva2U6dmFyKC0tYmctMSk7c3Ryb2tlLXdpZHRoOjI7Y3Vyc29yOnBvaW50ZXJ9XG4uc3BhcmstZG90OmhvdmVye3I6NDtmaWxsOnZhcigtLXRleHQtMCl9XG4uc3BhcmstbGJse2ZvbnQtc2l6ZToxMHB4O2ZpbGw6dmFyKC0tdGV4dC0yKTtmb250LWZhbWlseTp2YXIoLS1tb25vKX1cbi5zcGFyay1heGlze2Rpc3BsYXk6ZmxleDtwb3NpdGlvbjpyZWxhdGl2ZTtoZWlnaHQ6MThweDttYXJnaW4tdG9wOjJweH1cbi5zcGFyay10aWNre3Bvc2l0aW9uOmFic29sdXRlO3RyYW5zZm9ybTp0cmFuc2xhdGVYKC01MCUpO2ZvbnQtc2l6ZTo5cHg7Y29sb3I6dmFyKC0tdGV4dC0yKTtmb250LWZhbWlseTp2YXIoLS1tb25vKTt3aGl0ZS1zcGFjZTpub3dyYXB9XG5cbi8qIFJlcG9ydCBjYXJkcyAqL1xuLmNhcmRzLWdyaWR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoYXV0by1maWxsLG1pbm1heCgyNjBweCwxZnIpKTtnYXA6MTBweH1cbi5yZXBvcnQtY2FyZHtcbiAgZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjtnYXA6NnB4O1xuICBiYWNrZ3JvdW5kOnZhcigtLWJnLTEpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyLTEpO2JvcmRlci1yYWRpdXM6NHB4O1xuICBwYWRkaW5nOjE0cHg7dGV4dC1kZWNvcmF0aW9uOm5vbmU7Y29sb3I6dmFyKC0tdGV4dC0wKTtcbiAgdHJhbnNpdGlvbjpib3JkZXItY29sb3IgLjEycztcbn1cbi5yZXBvcnQtY2FyZDpob3Zlcntib3JkZXItY29sb3I6dmFyKC0tYWNjZW50KTt0ZXh0LWRlY29yYXRpb246bm9uZX1cbi5jYXJkLWxhdGVzdHtib3JkZXItY29sb3I6dmFyKC0tYWNjZW50KX1cbi5jYXJkLXRvcHtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo4cHh9XG4uY2FyZC1sYWJlbHtmbGV4OjE7Zm9udC13ZWlnaHQ6NTAwO2ZvbnQtc2l6ZToxM3B4O292ZXJmbG93OmhpZGRlbjt0ZXh0LW92ZXJmbG93OmVsbGlwc2lzO3doaXRlLXNwYWNlOm5vd3JhcH1cbi5jYXJkLWtpbmR7Zm9udC1zaXplOjEwcHg7Y29sb3I6dmFyKC0tdGV4dC0yKTtmb250LWZhbWlseTp2YXIoLS1tb25vKTtmbGV4LXNocmluazowfVxuLmNhcmQtZGF0ZXtmb250LXNpemU6MTFweDtjb2xvcjp2YXIoLS10ZXh0LTIpfVxuLmNhcmQtcHJvZ3Jlc3N7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6NnB4fVxuLmNhcmQtYmFyLXRyYWNre2ZsZXg6MTtoZWlnaHQ6M3B4O2JhY2tncm91bmQ6dmFyKC0tYmctMyk7Ym9yZGVyLXJhZGl1czoycHg7b3ZlcmZsb3c6aGlkZGVufVxuLmNhcmQtYmFyLWZpbGx7aGVpZ2h0OjEwMCU7YmFja2dyb3VuZDp2YXIoLS1hY2NlbnQpO2JvcmRlci1yYWRpdXM6MnB4fVxuLmNhcmQtcGN0e2ZvbnQtc2l6ZToxMXB4O2NvbG9yOnZhcigtLXRleHQtMik7bWluLXdpZHRoOjMwcHg7dGV4dC1hbGlnbjpyaWdodH1cbi5jYXJkLXN0YXRze2Rpc3BsYXk6ZmxleDtnYXA6OHB4O2ZsZXgtd3JhcDp3cmFwfVxuLmNhcmQtc3RhdHMgc3Bhbntmb250LXNpemU6MTFweDtjb2xvcjp2YXIoLS10ZXh0LTIpO2ZvbnQtdmFyaWFudC1udW1lcmljOnRhYnVsYXItbnVtc31cbi5jYXJkLWRlbHRhe2Rpc3BsYXk6ZmxleDtnYXA6NHB4O2ZsZXgtd3JhcDp3cmFwfVxuLmNhcmQtZGVsdGEgc3Bhbntmb250LXNpemU6MTBweDtjb2xvcjp2YXIoLS10ZXh0LTEpO2ZvbnQtZmFtaWx5OnZhcigtLW1vbm8pfVxuLmNhcmQtbGF0ZXN0LWJhZGdle2Rpc3BsYXk6bm9uZX1cblxuLyogRm9vdGVyICovXG5mb290ZXJ7Ym9yZGVyLXRvcDoxcHggc29saWQgdmFyKC0tYm9yZGVyLTEpO3BhZGRpbmc6MTZweCAzMnB4fVxuLmZ0ci1pbm5lcntkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo2cHg7anVzdGlmeS1jb250ZW50OmNlbnRlcjtmb250LXNpemU6MTFweDtjb2xvcjp2YXIoLS10ZXh0LTIpfVxuLmZ0ci1zZXB7Y29sb3I6dmFyKC0tYm9yZGVyLTIpfVxuXG5AbWVkaWEobWF4LXdpZHRoOjc2OHB4KXtcbiAgLmxheW91dHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyfVxuICAuc2lkZWJhcntwb3NpdGlvbjpzdGF0aWM7aGVpZ2h0OmF1dG87Ym9yZGVyLXJpZ2h0Om5vbmU7Ym9yZGVyLWJvdHRvbToxcHggc29saWQgdmFyKC0tYm9yZGVyLTEpfVxufVxuQG1lZGlhIHByaW50e1xuICAuc2lkZWJhcntkaXNwbGF5Om5vbmV9XG4gIGhlYWRlcntwb3NpdGlvbjpzdGF0aWN9XG4gIGJvZHl7YmFja2dyb3VuZDojZmZmO2NvbG9yOiMxYTFhMWF9XG4gIDpyb290ey0tYmctMDojZmZmOy0tYmctMTojZmFmYWZhOy0tYmctMjojZjVmNWY1Oy0tYmctMzojZWJlYmViOy0tYm9yZGVyLTE6I2U1ZTVlNTstLWJvcmRlci0yOiNkNGQ0ZDQ7LS10ZXh0LTA6IzFhMWExYTstLXRleHQtMTojNTI1MjUyOy0tdGV4dC0yOiNhM2EzYTM7LS1hY2NlbnQ6IzRmNDZlNX1cbn1cbmA7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFnQkEsU0FBUyxjQUFjLFdBQVcsa0JBQWtCO0FBQ3BELFNBQVMsWUFBc0I7QUFDL0IsU0FBUyx1QkFBdUI7QUFDaEMsU0FBUyxlQUFlO0FBQ3hCLFNBQVMsWUFBWSx3QkFBd0I7QUFDN0MsU0FBUyxpQkFBaUIsc0JBQXNCO0FBc0N6QyxTQUFTLFdBQVcsVUFBMEI7QUFDbkQsU0FBTyxLQUFLLFFBQVEsUUFBUSxHQUFHLFNBQVM7QUFDMUM7QUFFQSxTQUFTLGlCQUFpQixVQUEwQjtBQUNsRCxTQUFPLEtBQUssV0FBVyxRQUFRLEdBQUcsY0FBYztBQUNsRDtBQUVBLFNBQVMs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SUFBSSxDQUFDLHVCQUF1QixJQUFJLFVBQVUsQ0FBQztBQUFBLG1CQUN0RCxJQUFJLEdBQUcsUUFBUSxJQUFJLENBQUMseUNBQXlDLElBQUksUUFBUSxDQUFDO0FBQUE7QUFBQTtBQUFBLFVBR25GLFFBQVEsSUFBSSxDQUFDLEdBQUcsTUFBTTtBQUN0QixVQUFNLEtBQUssTUFBTSxJQUFJLFNBQVMsSUFBSTtBQUNsQyxXQUFPLHdDQUF3QyxFQUFFLFFBQVEsQ0FBQyxDQUFDLGFBQWEsSUFBSSxFQUFFLFdBQVcsQ0FBQyxLQUFLLElBQUksRUFBRSxnQkFBZ0IsVUFBVSxVQUFVLEVBQUUsV0FBVyxDQUFDO0FBQUEsRUFDekosQ0FBQyxFQUFFLEtBQUssRUFBRSxDQUFDO0FBQUE7QUFBQTtBQUduQjtBQUtBLFNBQVMsSUFBSSxHQUErQztBQUMxRCxNQUFJLEtBQUssS0FBTSxRQUFPO0FBQ3RCLFNBQU8sT0FBTyxDQUFDLEVBQUUsUUFBUSxNQUFNLE9BQU8sRUFBRSxRQUFRLE1BQU0sTUFBTSxFQUFFLFFBQVEsTUFBTSxNQUFNLEVBQUUsUUFBUSxNQUFNLFFBQVEsRUFBRSxRQUFRLE1BQU0sT0FBTztBQUNuSTtBQUlBLE1BQU0sWUFBWTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTsiLAogICJuYW1lcyI6IFtdCn0K
