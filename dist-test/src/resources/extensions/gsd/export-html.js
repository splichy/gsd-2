import { formatDateShort, formatDuration } from "../shared/format-utils.js";
import { esc, renderHtmlShell } from "../shared/html-shell.js";
import { formatCost, formatTokenCount } from "./metrics.js";
function generateHtmlReport(data, opts) {
  const generated = (/* @__PURE__ */ new Date()).toISOString();
  const sections = [
    buildSummarySection(data, opts, generated),
    buildBlockersSection(data),
    buildProgressSection(data),
    buildTimelineSection(data),
    buildDepGraphSection(data),
    buildMetricsSection(data),
    buildHealthSection(data),
    buildChangelogSection(data),
    buildKnowledgeSection(data),
    buildCapturesSection(data),
    buildStatsSection(data),
    buildDiscussionSection(data)
  ];
  const title = opts.milestoneId ? `${opts.projectName} / ${opts.milestoneId}` : opts.projectName;
  const backLink = opts.indexRelPath ? `<a class="back-link" href="${esc(opts.indexRelPath)}">All Reports</a>` : "";
  return renderHtmlShell({
    title,
    documentTitle: `GSD Report \u2014 ${opts.projectName}${opts.milestoneId ? ` \u2014 ${opts.milestoneId}` : ""}`,
    subtitle: opts.projectPath,
    kind: "Report",
    version: opts.gsdVersion,
    generatedAt: generated,
    headerActionsHtml: backLink,
    footerNote: opts.milestoneId ? `${opts.projectName} / ${opts.milestoneId}` : opts.projectName,
    toc: [
      { href: "#summary", label: "Summary" },
      { href: "#blockers", label: "Blockers" },
      { href: "#progress", label: "Progress" },
      { href: "#timeline", label: "Timeline" },
      { href: "#depgraph", label: "Dependencies" },
      { href: "#metrics", label: "Metrics" },
      { href: "#health", label: "Health" },
      { href: "#changelog", label: "Changelog" },
      { href: "#knowledge", label: "Knowledge" },
      { href: "#captures", label: "Captures" },
      { href: "#stats", label: "Artifacts" },
      { href: "#discussion", label: "Planning" }
    ],
    mainHtml: sections.join("\n")
  });
}
function buildSummarySection(data, opts, _generated) {
  const t = data.totals;
  const totalSlices = data.milestones.reduce((s, m) => s + m.slices.length, 0);
  const doneSlices = data.milestones.reduce((s, m) => s + m.slices.filter((sl) => sl.done).length, 0);
  const doneMilestones = data.milestones.filter((m) => m.status === "complete").length;
  const activeMilestone = data.milestones.find((m) => m.status === "active");
  const pct = totalSlices > 0 ? Math.round(doneSlices / totalSlices * 100) : 0;
  const act = data.agentActivity;
  const kv = [
    kvi("Milestones", `${doneMilestones}/${data.milestones.length}`),
    kvi("Slices", `${doneSlices}/${totalSlices}`),
    kvi("Phase", data.phase),
    t ? kvi("Cost", formatCost(t.cost)) : "",
    t ? kvi("Tokens", formatTokenCount(t.tokens.total)) : "",
    t ? kvi("Duration", formatDuration(t.duration)) : "",
    t ? kvi("Tool calls", String(t.toolCalls)) : "",
    t ? kvi("Units", String(t.units)) : "",
    data.remainingSliceCount > 0 ? kvi("Remaining", String(data.remainingSliceCount)) : "",
    act ? kvi("Rate", `${act.completionRate.toFixed(1)}/hr`) : "",
    t && doneSlices > 0 ? kvi("Cost/slice", formatCost(t.cost / doneSlices)) : "",
    t && t.toolCalls > 0 ? kvi("Tokens/tool", formatTokenCount(t.tokens.total / t.toolCalls)) : "",
    t && t.tokens.input + t.tokens.cacheRead > 0 ? kvi("Cache hit", (t.tokens.cacheRead / (t.tokens.input + t.tokens.cacheRead) * 100).toFixed(1) + "%") : "",
    opts.milestoneId ? kvi("Scope", opts.milestoneId) : ""
  ].filter(Boolean).join("");
  const activeInfo = activeMilestone ? (() => {
    const active = activeMilestone.slices.find((s) => s.active);
    if (!active) return "";
    return `<div class="active-info">
      Executing <span class="mono">${esc(activeMilestone.id)}/${esc(active.id)}</span> \u2014 ${esc(active.title)}
    </div>`;
  })() : "";
  const activityHtml = act?.active ? `
    <div class="activity-line">
      <span class="dot dot-active"></span>
      <span class="mono">${esc(act.currentUnit?.type ?? "")}</span>
      <span class="mono muted">${esc(act.currentUnit?.id ?? "")}</span>
      <span class="muted">${formatDuration(act.elapsed)} elapsed</span>
    </div>` : "";
  const execSummary = buildExecutiveSummary(data, opts);
  const etaLine = buildEtaLine(data);
  return section("summary", "Summary", `
    ${execSummary}
    <div class="kv-grid">${kv}</div>
    <div class="progress-wrap">
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
      <span class="progress-label">${pct}%</span>
    </div>
    ${activeInfo}
    ${activityHtml}
    ${etaLine}
  `);
}
function buildExecutiveSummary(data, opts) {
  const totalSlices = data.milestones.reduce((s, m) => s + m.slices.length, 0);
  const doneSlices = data.milestones.reduce((s, m) => s + m.slices.filter((sl) => sl.done).length, 0);
  const pct = totalSlices > 0 ? Math.round(doneSlices / totalSlices * 100) : 0;
  const spent = data.totals?.cost ?? 0;
  const activeMilestone = data.milestones.find((m) => m.status === "active");
  const activeSlice = activeMilestone?.slices.find((s) => s.active);
  const currentExec = activeMilestone && activeSlice ? ` Currently executing ${esc(activeMilestone.id)}/${esc(activeSlice.id)}.` : "";
  const budgetCtx = data.health.budgetCeiling ? ` Budget: ${formatCost(spent)} of ${formatCost(data.health.budgetCeiling)} ceiling (${(spent / data.health.budgetCeiling * 100).toFixed(0)}% used).` : "";
  return `<p class="exec-summary">${esc(opts.projectName)} is ${pct}% complete across ${data.milestones.length} milestones. ${formatCost(spent)} spent.${currentExec}${budgetCtx}</p>`;
}
function buildEtaLine(data) {
  const act = data.agentActivity;
  if (!act || act.completionRate <= 0 || data.remainingSliceCount <= 0) return "";
  const hoursRemaining = data.remainingSliceCount / act.completionRate;
  const formatted = formatDuration(hoursRemaining * 36e5);
  return `<div class="eta-line">ETA: ~${formatted} remaining (${data.remainingSliceCount} slices at ${act.completionRate.toFixed(1)}/hr)</div>`;
}
function buildBlockersSection(data) {
  const blockers = data.sliceVerifications.filter((v) => v.blockerDiscovered === true);
  const highRisk = [];
  for (const ms of data.milestones) {
    for (const sl of ms.slices) {
      if (!sl.done && sl.risk?.toLowerCase() === "high") {
        highRisk.push({ msId: ms.id, slId: sl.id });
      }
    }
  }
  if (blockers.length === 0 && highRisk.length === 0) {
    return section("blockers", "Blockers", '<p class="empty">No blockers or high-risk items found.</p>');
  }
  const blockerCards = blockers.map((v) => `
    <div class="blocker-card">
      <div class="blocker-id">${esc(v.milestoneId)}/${esc(v.sliceId)}</div>
      <div class="blocker-text">${esc(v.verificationResult ?? "Blocker discovered")}</div>
    </div>`).join("");
  const riskCards = highRisk.filter((hr) => !blockers.some((b) => b.milestoneId === hr.msId && b.sliceId === hr.slId)).map((hr) => `
    <div class="blocker-card">
      <div class="blocker-id">${esc(hr.msId)}/${esc(hr.slId)}</div>
      <div class="blocker-text">High risk \u2014 incomplete</div>
    </div>`).join("");
  return section("blockers", "Blockers", `${blockerCards}${riskCards}`);
}
function buildHealthSection(data) {
  const h = data.health;
  const t = data.totals;
  const rows = [];
  rows.push(hRow("Token profile", h.tokenProfile));
  if (h.budgetCeiling !== void 0) {
    const spent = t?.cost ?? 0;
    const pct = spent / h.budgetCeiling * 100;
    const status = pct > 90 ? "warn" : pct > 75 ? "caution" : "ok";
    rows.push(hRow(
      "Budget ceiling",
      `${formatCost(h.budgetCeiling)} (${formatCost(spent)} spent, ${pct.toFixed(0)}% used)`,
      status
    ));
  }
  rows.push(hRow(
    "Truncation rate",
    `${h.truncationRate.toFixed(1)}% per unit (${t?.totalTruncationSections ?? 0} total)`,
    h.truncationRate > 20 ? "warn" : h.truncationRate > 10 ? "caution" : "ok"
  ));
  rows.push(hRow(
    "Continue-here rate",
    `${h.continueHereRate.toFixed(1)}% per unit (${t?.continueHereFiredCount ?? 0} total)`,
    h.continueHereRate > 15 ? "warn" : h.continueHereRate > 8 ? "caution" : "ok"
  ));
  if (h.tierSavingsLine) rows.push(hRow("Routing savings", h.tierSavingsLine));
  rows.push(hRow("Tool calls", String(h.toolCalls)));
  rows.push(hRow("Messages", `${h.assistantMessages} assistant / ${h.userMessages} user`));
  const tierRows = h.tierBreakdown.length > 0 ? `
    <h3>Tier breakdown</h3>
    <table class="tbl">
      <thead><tr><th>Tier</th><th>Units</th><th>Cost</th><th>Tokens</th></tr></thead>
      <tbody>
        ${h.tierBreakdown.map(
    (tb) => `<tr><td class="mono">${esc(tb.tier)}</td>
           <td>${tb.units}</td><td>${formatCost(tb.cost)}</td>
           <td>${formatTokenCount(tb.tokens.total)}</td></tr>`
  ).join("")}
      </tbody>
    </table>` : "";
  let progressHtml = "";
  if (h.progressScore) {
    const ps = h.progressScore;
    const scoreColor = ps.level === "green" ? "#22c55e" : ps.level === "yellow" ? "#eab308" : "#ef4444";
    const signalRows = ps.signals.map((s) => {
      const icon = s.kind === "positive" ? "\u2713" : s.kind === "negative" ? "\u2717" : "\xB7";
      const color = s.kind === "positive" ? "#22c55e" : s.kind === "negative" ? "#ef4444" : "#888";
      return `<div style="margin-left:1em;color:${color}">${icon} ${esc(s.label)}</div>`;
    }).join("");
    progressHtml = `
      <h3>Progress Score</h3>
      <div style="font-size:1.1em;font-weight:bold;color:${scoreColor}">\u25CF ${esc(ps.summary)}</div>
      ${signalRows}`;
  }
  let historyHtml = "";
  const doctorHistory = h.doctorHistory ?? [];
  if (doctorHistory.length > 0) {
    const historyRows = doctorHistory.slice(0, 20).map((entry) => {
      const statusIcon = entry.ok ? "\u2713" : "\u2717";
      const statusColor = entry.ok ? "#22c55e" : "#ef4444";
      const ts = entry.ts.replace("T", " ").slice(0, 19);
      const scopeTag = entry.scope ? `<span class="mono" style="color:#888"> [${esc(entry.scope)}]</span>` : "";
      const summaryText = entry.summary ? esc(entry.summary) : `${entry.errors} errors, ${entry.warnings} warnings, ${entry.fixes} fixes`;
      const issueDetails = (entry.issues ?? []).slice(0, 3).map((i) => {
        const iColor = i.severity === "error" ? "#ef4444" : "#eab308";
        return `<div style="margin-left:2em;color:${iColor};font-size:0.85em">${i.severity === "error" ? "\u2717" : "\u26A0"} ${esc(i.message)} <span class="mono" style="color:#888">${esc(i.unitId)}</span></div>`;
      }).join("");
      const fixDetails = (entry.fixDescriptions ?? []).slice(0, 2).map(
        (f) => `<div style="margin-left:2em;color:#22c55e;font-size:0.85em">\u21B3 ${esc(f)}</div>`
      ).join("");
      return `<tr style="color:${statusColor}">
        <td class="mono">${statusIcon}</td>
        <td class="mono">${esc(ts)}${scopeTag}</td>
        <td>${summaryText}</td>
      </tr>
      ${issueDetails || fixDetails ? `<tr><td colspan="3">${issueDetails}${fixDetails}</td></tr>` : ""}`;
    }).join("");
    historyHtml = `
      <h3>Doctor Run History</h3>
      <table class="tbl">
        <thead><tr><th></th><th>Time</th><th>Summary</th></tr></thead>
        <tbody>${historyRows}</tbody>
      </table>`;
  }
  return section("health", "Health", `
    <table class="tbl tbl-kv"><tbody>${rows.join("")}</tbody></table>
    ${tierRows}
    ${progressHtml}
    ${historyHtml}
  `);
}
function buildProgressSection(data) {
  if (data.milestones.length === 0) {
    return section("progress", "Progress", '<p class="empty">No milestones found.</p>');
  }
  const critMS = new Set(data.criticalPath.milestonePath);
  const critSL = new Set(data.criticalPath.slicePath);
  const msHtml = data.milestones.map((ms) => {
    const doneCount = ms.slices.filter((s) => s.done).length;
    const onCrit = critMS.has(ms.id);
    const sliceHtml = ms.slices.length > 0 ? ms.slices.map((sl) => buildSliceRow(sl, critSL, data)).join("") : '<p class="empty indent">No slices in roadmap yet.</p>';
    return `
      <details class="ms-block" ${ms.status !== "pending" && ms.status !== "parked" ? "open" : ""}>
        <summary class="ms-summary ms-${ms.status}">
          <span class="dot dot-${ms.status}"></span>
          <span class="mono ms-id">${esc(ms.id)}</span>
          <span class="ms-title">${esc(ms.title)}</span>
          <span class="muted">${doneCount}/${ms.slices.length}</span>
          ${onCrit ? '<span class="label">critical path</span>' : ""}
          ${ms.dependsOn.length > 0 ? `<span class="muted">needs ${ms.dependsOn.map(esc).join(", ")}</span>` : ""}
        </summary>
        <div class="ms-body">${sliceHtml}</div>
      </details>`;
  }).join("");
  return section("progress", "Progress", msHtml);
}
function buildSliceRow(sl, critSL, data) {
  const onCrit = critSL.has(sl.id);
  const ver = data.sliceVerifications.find((v) => v.sliceId === sl.id);
  const slack = data.criticalPath.sliceSlack.get(sl.id);
  const status = sl.done ? "complete" : sl.active ? "active" : "pending";
  const taskHtml = sl.tasks.length > 0 ? `
    <ul class="task-list">
      ${sl.tasks.map((t) => `
        <li class="task-row">
          <span class="dot dot-${t.done ? "complete" : t.active ? "active" : "pending"} dot-sm"></span>
          <span class="mono muted">${esc(t.id)}</span>
          <span class="${t.done ? "muted" : ""}">${esc(t.title)}</span>
          ${t.estimate ? `<span class="muted">${esc(t.estimate)}</span>` : ""}
        </li>`).join("")}
    </ul>` : "";
  const tags = [
    ...(ver?.provides ?? []).map((p) => `<span class="tag">provides: ${esc(p)}</span>`),
    ...(ver?.requires ?? []).map((r) => `<span class="tag">requires: ${esc(r.provides)}</span>`)
  ].join("");
  const keyDecisions = ver?.keyDecisions?.length ? `<div class="detail-block"><span class="detail-label">Decisions</span><ul>${ver.keyDecisions.map((d) => `<li>${esc(d)}</li>`).join("")}</ul></div>` : "";
  const patterns = ver?.patternsEstablished?.length ? `<div class="detail-block"><span class="detail-label">Patterns</span><ul>${ver.patternsEstablished.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>` : "";
  const verifBadge = ver?.verificationResult ? `<div class="verif ${ver.blockerDiscovered ? "verif-blocker" : ""}">
        ${ver.blockerDiscovered ? "Blocker: " : ""}${esc(ver.verificationResult)}
       </div>` : "";
  return `
    <details class="sl-block">
      <summary class="sl-summary ${onCrit ? "sl-crit" : ""}">
        <span class="dot dot-${status} dot-sm"></span>
        <span class="mono muted">${esc(sl.id)}</span>
        <span class="${status === "active" ? "accent" : sl.done ? "muted" : ""}">${esc(sl.title)}</span>
        <span class="risk risk-${(sl.risk || "unknown").toLowerCase()}">${esc(sl.risk || "?")}</span>
        ${sl.depends.length > 0 ? `<span class="muted sl-deps">${sl.depends.map(esc).join(", ")}</span>` : ""}
        ${onCrit ? '<span class="label">critical</span>' : ""}
        ${slack !== void 0 && slack > 0 ? `<span class="muted">+${slack} slack</span>` : ""}
      </summary>
      <div class="sl-detail">
        ${tags ? `<div class="tag-row">${tags}</div>` : ""}
        ${verifBadge}
        ${keyDecisions}
        ${patterns}
        ${taskHtml}
      </div>
    </details>`;
}
function buildDepGraphSection(data) {
  const hasSlices = data.milestones.some((ms) => ms.slices.length > 0);
  if (!hasSlices) return section("depgraph", "Dependencies", '<p class="empty">No slices to graph.</p>');
  const hasDeps = data.milestones.some((ms) => ms.slices.some((s) => s.depends.length > 0));
  if (!hasDeps) return section("depgraph", "Dependencies", '<p class="empty">No dependencies defined.</p>');
  const svgs = data.milestones.filter((ms) => ms.slices.length > 0).map((ms) => buildMilestoneDepSVG(ms, data)).filter(Boolean).join("");
  return section("depgraph", "Dependencies", svgs);
}
function buildMilestoneDepSVG(ms, data) {
  const slices = ms.slices;
  if (slices.length === 0) return "";
  const critSL = new Set(data.criticalPath.slicePath);
  const slMap = new Map(slices.map((s) => [s.id, s]));
  const layerMap = /* @__PURE__ */ new Map();
  const inDeg = /* @__PURE__ */ new Map();
  for (const s of slices) inDeg.set(s.id, 0);
  for (const s of slices) {
    for (const dep of s.depends) {
      if (slMap.has(dep)) inDeg.set(s.id, (inDeg.get(s.id) ?? 0) + 1);
    }
  }
  const visited = /* @__PURE__ */ new Set();
  const q = [];
  for (const [id, d] of inDeg) {
    if (d === 0) {
      q.push(id);
      visited.add(id);
      layerMap.set(id, 0);
    }
  }
  while (q.length > 0) {
    const node = q.shift();
    for (const s of slices) {
      if (!s.depends.includes(node)) continue;
      const newDeg = (inDeg.get(s.id) ?? 1) - 1;
      inDeg.set(s.id, newDeg);
      layerMap.set(s.id, Math.max(layerMap.get(s.id) ?? 0, (layerMap.get(node) ?? 0) + 1));
      if (newDeg === 0 && !visited.has(s.id)) {
        visited.add(s.id);
        q.push(s.id);
      }
    }
  }
  for (const s of slices) if (!layerMap.has(s.id)) layerMap.set(s.id, 0);
  const maxLayer = Math.max(...[...layerMap.values()]);
  const byLayer = /* @__PURE__ */ new Map();
  for (const [id, layer] of layerMap) {
    const arr = byLayer.get(layer) ?? [];
    arr.push(id);
    byLayer.set(layer, arr);
  }
  const NW = 130, NH = 40, CGAP = 56, RGAP = 14, PAD = 20;
  let maxRows = 0;
  for (let c = 0; c <= maxLayer; c++) maxRows = Math.max(maxRows, (byLayer.get(c) ?? []).length);
  const totalH = PAD * 2 + maxRows * NH + Math.max(0, maxRows - 1) * RGAP;
  const totalW = PAD * 2 + (maxLayer + 1) * NW + maxLayer * CGAP;
  const pos = /* @__PURE__ */ new Map();
  for (let col = 0; col <= maxLayer; col++) {
    const ids = byLayer.get(col) ?? [];
    const colH = ids.length * NH + Math.max(0, ids.length - 1) * RGAP;
    const startY = (totalH - colH) / 2;
    ids.forEach((id, i) => pos.set(id, { x: PAD + col * (NW + CGAP), y: startY + i * (NH + RGAP) }));
  }
  const edges = slices.flatMap((sl) => sl.depends.flatMap((dep) => {
    if (!pos.has(dep) || !pos.has(sl.id)) return [];
    const f = pos.get(dep), t = pos.get(sl.id);
    const x1 = f.x + NW, y1 = f.y + NH / 2;
    const x2 = t.x, y2 = t.y + NH / 2;
    const mx = (x1 + x2) / 2;
    const crit = critSL.has(sl.id) && critSL.has(dep);
    return [`<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" class="edge${crit ? " edge-crit" : ""}" marker-end="url(#arr${crit ? "-crit" : ""})"/>`];
  }));
  const nodes = slices.map((sl) => {
    const p = pos.get(sl.id);
    if (!p) return "";
    const crit = critSL.has(sl.id);
    const sc = sl.done ? "n-done" : sl.active ? "n-active" : "n-pending";
    return `<g class="node ${sc}${crit ? " n-crit" : ""}" transform="translate(${p.x},${p.y})">
      <rect width="${NW}" height="${NH}" rx="4"/>
      <text x="${NW / 2}" y="16" class="n-id">${esc(truncStr(sl.id, 18))}</text>
      <text x="${NW / 2}" y="30" class="n-title">${esc(truncStr(sl.title, 18))}</text>
      <title>${esc(sl.id)}: ${esc(sl.title)}</title>
    </g>`;
  });
  const legend = `<div class="dep-legend">
    <span><span class="dot dot-complete dot-sm"></span> done</span>
    <span><span class="dot dot-active dot-sm"></span> active</span>
    <span><span class="dot dot-pending dot-sm"></span> pending</span>
    <span><span class="dot dot-parked dot-sm"></span> parked</span>
  </div>`;
  return `
    <div class="dep-block">
      <h3>${esc(ms.id)}: ${esc(ms.title)}</h3>
      ${legend}
      <div class="dep-wrap">
        <svg class="dep-svg" viewBox="0 0 ${totalW} ${totalH}" width="${totalW}" height="${totalH}">
          <defs>
            <marker id="arr" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
              <path d="M0,0 L0,6 L8,3 z" fill="var(--border-2)"/>
            </marker>
            <marker id="arr-crit" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
              <path d="M0,0 L0,6 L8,3 z" fill="var(--accent)"/>
            </marker>
          </defs>
          ${edges.join("")}
          ${nodes.join("")}
        </svg>
      </div>
    </div>`;
}
function buildMetricsSection(data) {
  if (!data.totals) return section("metrics", "Metrics", '<p class="empty">No metrics data yet.</p>');
  const t = data.totals;
  const grid = [
    kvi("Total cost", formatCost(t.cost)),
    kvi("Total tokens", formatTokenCount(t.tokens.total)),
    kvi("Input", formatTokenCount(t.tokens.input)),
    kvi("Output", formatTokenCount(t.tokens.output)),
    kvi("Cache read", formatTokenCount(t.tokens.cacheRead)),
    kvi("Cache write", formatTokenCount(t.tokens.cacheWrite)),
    kvi("Duration", formatDuration(t.duration)),
    kvi("Units", String(t.units)),
    kvi("Tool calls", String(t.toolCalls)),
    kvi("Truncations", String(t.totalTruncationSections))
  ].join("");
  const tokenBreakdown = buildTokenBreakdown(t.tokens);
  const phaseRow = data.byPhase.length > 0 ? `
    <div class="chart-row">
      ${buildBarChart("Cost by phase", data.byPhase.map((p) => ({
    label: p.phase,
    value: p.cost,
    display: formatCost(p.cost),
    sub: `${p.units} units`
  })))}
      ${buildBarChart("Tokens by phase", data.byPhase.map((p) => ({
    label: p.phase,
    value: p.tokens.total,
    display: formatTokenCount(p.tokens.total),
    sub: formatCost(p.cost)
  })))}
    </div>` : "";
  const sliceModelRow = data.bySlice.length > 0 || data.byModel.length > 0 ? `
    <div class="chart-row">
      ${data.bySlice.length > 0 ? buildBarChart("Cost by slice", data.bySlice.map((s) => ({
    label: s.sliceId,
    value: s.cost,
    display: formatCost(s.cost),
    sub: `${s.units} units`
  }))) : ""}
      ${data.byModel.length > 0 ? buildBarChart("Cost by model", data.byModel.map((m) => ({
    label: shortModel(m.model),
    value: m.cost,
    display: formatCost(m.cost),
    sub: `${m.units} units`
  }))) : ""}
      ${data.bySlice.length > 0 ? buildBarChart("Duration by slice", data.bySlice.map((s) => ({
    label: s.sliceId,
    value: s.duration,
    display: formatDuration(s.duration),
    sub: formatCost(s.cost)
  }))) : ""}
    </div>` : "";
  const costOverTime = buildCostOverTimeChart(data.units);
  const budgetBurndown = buildBudgetBurndown(data);
  const gantt = buildSliceGantt(data);
  return section("metrics", "Metrics", `
    <div class="kv-grid">${grid}</div>
    ${budgetBurndown}
    ${tokenBreakdown}
    ${costOverTime}
    ${phaseRow}
    ${sliceModelRow}
    ${gantt}
  `);
}
function buildCostOverTimeChart(units) {
  if (units.length < 2) return "";
  const sorted = [...units].sort((a, b) => a.startedAt - b.startedAt);
  const cumulative = [];
  let running = 0;
  for (const u of sorted) {
    running += u.cost;
    cumulative.push(running);
  }
  const padL = 50, padR = 30, padT = 20, padB = 30;
  const w = 600, h = 200;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const maxCost = cumulative[cumulative.length - 1] || 1;
  const n = cumulative.length;
  const points = cumulative.map((c, i) => {
    const x = padL + i / (n - 1) * plotW;
    const y = padT + plotH - c / maxCost * plotH;
    return { x, y };
  });
  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${points[points.length - 1].x.toFixed(1)},${(padT + plotH).toFixed(1)} L${points[0].x.toFixed(1)},${(padT + plotH).toFixed(1)} Z`;
  const gridLines = [];
  for (let i = 0; i <= 4; i++) {
    const y = padT + plotH / 4 * i;
    const val = formatCost(maxCost * (1 - i / 4));
    gridLines.push(`<line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" class="cost-grid"/>`);
    gridLines.push(`<text x="${padL - 4}" y="${y + 3}" class="cost-axis" text-anchor="end">${val}</text>`);
  }
  return `
    <div class="token-block">
      <h3>Cost over time</h3>
      <svg class="cost-svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
        ${gridLines.join("")}
        <path d="${areaPath}" class="cost-area"/>
        <path d="${linePath}" class="cost-line"/>
        <text x="${padL}" y="${h - 4}" class="cost-axis">#1</text>
        <text x="${w - padR}" y="${h - 4}" class="cost-axis" text-anchor="end">#${n}</text>
      </svg>
    </div>`;
}
function buildBudgetBurndown(data) {
  if (!data.health.budgetCeiling) return "";
  const ceiling = data.health.budgetCeiling;
  const spent = data.totals?.cost ?? 0;
  const totalSlices = data.milestones.reduce((s, m) => s + m.slices.length, 0);
  const doneSlices = data.milestones.reduce((s, m) => s + m.slices.filter((sl) => sl.done).length, 0);
  const avgCostPerSlice = doneSlices > 0 ? spent / doneSlices : 0;
  const projected = avgCostPerSlice > 0 ? avgCostPerSlice * data.remainingSliceCount + spent : spent;
  const maxVal = Math.max(ceiling, projected, spent);
  const spentPct = spent / maxVal * 100;
  const projectedRemPct = Math.max(0, (projected - spent) / maxVal * 100);
  const overshoot = projected > ceiling ? (projected - ceiling) / maxVal * 100 : 0;
  const projectedClean = projectedRemPct - overshoot;
  const legend = [
    `<span><span class="burndown-dot" style="background:var(--accent)"></span> Spent: ${formatCost(spent)}</span>`,
    `<span><span class="burndown-dot" style="background:var(--caution)"></span> Projected remaining: ${formatCost(Math.max(0, projected - spent))}</span>`,
    `<span><span class="burndown-dot" style="background:var(--border-2)"></span> Ceiling: ${formatCost(ceiling)}</span>`,
    overshoot > 0 ? `<span><span class="burndown-dot" style="background:var(--warn)"></span> Overshoot: ${formatCost(projected - ceiling)}</span>` : ""
  ].filter(Boolean).join("");
  return `
    <div class="burndown-wrap">
      <h3>Budget burndown</h3>
      <div class="burndown-bar">
        <div class="burndown-spent" style="width:${spentPct.toFixed(1)}%"></div>
        ${projectedClean > 0 ? `<div class="burndown-projected" style="width:${projectedClean.toFixed(1)}%"></div>` : ""}
        ${overshoot > 0 ? `<div class="burndown-overshoot" style="width:${overshoot.toFixed(1)}%"></div>` : ""}
      </div>
      <div class="burndown-legend">${legend}</div>
    </div>`;
}
function buildSliceGantt(data) {
  const sliceTimings = /* @__PURE__ */ new Map();
  for (const u of data.units) {
    const parts = u.id.split("/");
    const sliceKey = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : u.id;
    if (u.startedAt <= 0) continue;
    const existing = sliceTimings.get(sliceKey);
    const end = u.finishedAt > 0 ? u.finishedAt : Date.now();
    if (existing) {
      existing.min = Math.min(existing.min, u.startedAt);
      existing.max = Math.max(existing.max, end);
    } else {
      sliceTimings.set(sliceKey, { min: u.startedAt, max: end });
    }
  }
  if (sliceTimings.size < 2) return "";
  const sliceEntries = [...sliceTimings.entries()].sort((a, b) => a[1].min - b[1].min);
  const globalMin = Math.min(...sliceEntries.map((e) => e[1].min));
  const globalMax = Math.max(...sliceEntries.map((e) => e[1].max));
  const range = globalMax - globalMin || 1;
  const sliceCount = sliceEntries.length;
  const barH = 18, rowH = 30, padL = 140, padR = 20, padT = 30, padB = 30;
  const plotW = 700 - padL - padR;
  const svgH = sliceCount * rowH + padT + padB;
  const sliceStatusMap = /* @__PURE__ */ new Map();
  for (const ms of data.milestones) {
    for (const sl of ms.slices) {
      const key = `${ms.id}/${sl.id}`;
      sliceStatusMap.set(key, sl.done ? "done" : sl.active ? "active" : "pending");
    }
  }
  const bars = sliceEntries.map(([sliceId, timing], i) => {
    const x = padL + (timing.min - globalMin) / range * plotW;
    const w = Math.max(2, (timing.max - timing.min) / range * plotW);
    const y = padT + i * rowH + (rowH - barH) / 2;
    const status = sliceStatusMap.get(sliceId) ?? "pending";
    return `<text x="${padL - 6}" y="${y + barH / 2 + 4}" class="gantt-label" text-anchor="end">${esc(truncStr(sliceId, 18))}</text>
      <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${barH}" rx="2" class="gantt-bar-${status}"><title>${esc(sliceId)}: ${formatDuration(timing.max - timing.min)}</title></rect>`;
  }).join("\n");
  const axisLabels = [0, 0.25, 0.5, 0.75, 1].map((frac) => {
    const t = globalMin + frac * range;
    const x = padL + frac * plotW;
    return `<text x="${x.toFixed(1)}" y="${svgH - 8}" class="gantt-axis" text-anchor="middle">${formatDateShort(new Date(t).toISOString())}</text>`;
  }).join("");
  return `
    <div class="gantt-wrap">
      <h3>Slice timeline</h3>
      <svg class="gantt-svg" viewBox="0 0 700 ${svgH}" width="700" height="${svgH}">
        ${bars}
        ${axisLabels}
      </svg>
    </div>`;
}
function buildTokenBreakdown(tokens) {
  if (tokens.total === 0) return "";
  const segs = [
    { label: "Input", value: tokens.input, cls: "seg-1" },
    { label: "Output", value: tokens.output, cls: "seg-2" },
    { label: "Cache read", value: tokens.cacheRead, cls: "seg-3" },
    { label: "Cache write", value: tokens.cacheWrite, cls: "seg-4" }
  ].filter((s) => s.value > 0);
  const bars = segs.map((s) => {
    const pct = s.value / tokens.total * 100;
    return `<div class="tseg ${s.cls}" style="width:${pct.toFixed(2)}%" title="${s.label}: ${formatTokenCount(s.value)} (${pct.toFixed(1)}%)"></div>`;
  }).join("");
  const legend = segs.map((s) => {
    const pct = (s.value / tokens.total * 100).toFixed(1);
    return `<span class="leg-item"><span class="leg-dot ${s.cls}"></span>${s.label}: ${formatTokenCount(s.value)} (${pct}%)</span>`;
  }).join("");
  return `
    <div class="token-block">
      <h3>Token breakdown</h3>
      <div class="token-bar">${bars}</div>
      <div class="token-legend">${legend}</div>
    </div>`;
}
const CHART_COLORS = 6;
function buildBarChart(title, entries) {
  if (entries.length === 0) return "";
  const max = Math.max(...entries.map((e) => e.value), 1);
  const rows = entries.map((e, i) => {
    const pct = e.value / max * 100;
    const ci = e.color ?? i;
    return `
      <div class="bar-row">
        <div class="bar-lbl">${esc(truncStr(e.label, 22))}</div>
        <div class="bar-track"><div class="bar-fill bar-c${ci % CHART_COLORS}" style="width:${pct.toFixed(1)}%"></div></div>
        <div class="bar-val">${esc(e.display)}</div>
      </div>
      ${e.sub ? `<div class="bar-sub">${esc(e.sub)}</div>` : ""}`;
  }).join("");
  return `<div class="chart-block"><h3>${esc(title)}</h3>${rows}</div>`;
}
function buildTimelineSection(data) {
  if (data.units.length === 0) return section("timeline", "Timeline", '<p class="empty">No units executed yet.</p>');
  const sorted = [...data.units].sort((a, b) => a.startedAt - b.startedAt);
  const maxCost = Math.max(...sorted.map((u) => u.cost), 0.01);
  const rows = sorted.map((u, i) => {
    const dur = u.finishedAt > 0 ? formatDuration(u.finishedAt - u.startedAt) : "running";
    const intensity = Math.min(u.cost / maxCost, 1);
    const heatStyle = intensity > 0.15 ? ` style="background:rgba(239,68,68,${(intensity * 0.15).toFixed(3)})"` : "";
    return `
      <tr${heatStyle}>
        <td class="muted">${i + 1}</td>
        <td class="mono">${esc(u.type)}</td>
        <td class="mono muted">${esc(u.id)}</td>
        <td>${esc(shortModel(u.model))}</td>
        <td class="muted">${formatDateShort(new Date(u.startedAt).toISOString())}</td>
        <td>${dur}</td>
        <td class="num">${formatCost(u.cost)}</td>
        <td class="num">${formatTokenCount(u.tokens.total)}</td>
        <td class="num">${u.toolCalls}</td>
        <td class="mono">${u.tier ?? ""}</td>
        <td>${u.modelDowngraded ? "routed" : ""}</td>
        <td class="num">${(u.truncationSections ?? 0) > 0 ? u.truncationSections : ""}</td>
        <td>${u.continueHereFired ? "yes" : ""}</td>
      </tr>`;
  }).join("");
  return section("timeline", "Timeline", `
    <div class="table-scroll">
      <table class="tbl">
        <thead><tr>
          <th>#</th><th>Type</th><th>ID</th><th>Model</th>
          <th>Started</th><th>Duration</th><th>Cost</th>
          <th>Tokens</th><th>Tools</th><th>Tier</th><th>Routed</th><th>Trunc</th><th>CHF</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`);
}
function buildChangelogSection(data) {
  if (data.changelog.entries.length === 0) return section("changelog", "Changelog", '<p class="empty">No completed slices yet.</p>');
  const entries = data.changelog.entries.map((e) => {
    const filesHtml = e.filesModified.length > 0 ? `
      <details class="files-detail">
        <summary class="muted">${e.filesModified.length} file${e.filesModified.length !== 1 ? "s" : ""} modified</summary>
        <ul class="file-list">
          ${e.filesModified.map((f) => `<li><code>${esc(f.path)}</code>${f.description ? ` \u2014 ${esc(f.description)}` : ""}</li>`).join("")}
        </ul>
      </details>` : "";
    const ver = data.sliceVerifications.find((v) => v.sliceId === e.sliceId);
    const decisionsHtml = ver?.keyDecisions?.length ? `
      <div class="detail-block"><span class="detail-label">Decisions</span>
        <ul>${ver.keyDecisions.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>
      </div>` : "";
    return `
      <div class="cl-entry">
        <div class="cl-header">
          <span class="mono muted">${esc(e.milestoneId)}/${esc(e.sliceId)}</span>
          <span class="cl-title">${esc(e.title)}</span>
          ${e.completedAt ? `<span class="muted cl-date">${formatDateShort(e.completedAt)}</span>` : ""}
        </div>
        ${e.oneLiner ? `<p class="cl-liner">${esc(e.oneLiner)}</p>` : ""}
        ${decisionsHtml}
        ${filesHtml}
      </div>`;
  }).join("");
  return section("changelog", `Changelog <span class="count">${data.changelog.entries.length}</span>`, entries);
}
function buildKnowledgeSection(data) {
  const k = data.knowledge;
  if (!k.exists) return section("knowledge", "Knowledge", '<p class="empty">No KNOWLEDGE.md found.</p>');
  const total = k.rules.length + k.patterns.length + k.lessons.length;
  if (total === 0) return section("knowledge", "Knowledge", '<p class="empty">KNOWLEDGE.md exists but no entries parsed.</p>');
  const rulesHtml = k.rules.length > 0 ? `
    <h3>Rules <span class="count">${k.rules.length}</span></h3>
    <table class="tbl">
      <thead><tr><th>ID</th><th>Scope</th><th>Rule</th></tr></thead>
      <tbody>${k.rules.map((r) => `<tr><td class="mono">${esc(r.id)}</td><td>${esc(r.scope)}</td><td>${esc(r.content)}</td></tr>`).join("")}</tbody>
    </table>` : "";
  const patternsHtml = k.patterns.length > 0 ? `
    <h3>Patterns <span class="count">${k.patterns.length}</span></h3>
    <table class="tbl">
      <thead><tr><th>ID</th><th>Pattern</th></tr></thead>
      <tbody>${k.patterns.map((p) => `<tr><td class="mono">${esc(p.id)}</td><td>${esc(p.content)}</td></tr>`).join("")}</tbody>
    </table>` : "";
  const lessonsHtml = k.lessons.length > 0 ? `
    <h3>Lessons <span class="count">${k.lessons.length}</span></h3>
    <table class="tbl">
      <thead><tr><th>ID</th><th>Lesson</th></tr></thead>
      <tbody>${k.lessons.map((l) => `<tr><td class="mono">${esc(l.id)}</td><td>${esc(l.content)}</td></tr>`).join("")}</tbody>
    </table>` : "";
  return section("knowledge", `Knowledge <span class="count">${total}</span>`, `${rulesHtml}${patternsHtml}${lessonsHtml}`);
}
function buildCapturesSection(data) {
  const c = data.captures;
  if (c.totalCount === 0) return section("captures", "Captures", '<p class="empty">No captures recorded.</p>');
  const badge = c.pendingCount > 0 ? `<span class="count count-warn">${c.pendingCount} pending</span>` : `<span class="count">all triaged</span>`;
  const rows = c.entries.map((e) => `
    <tr>
      <td class="muted">${formatDateShort(new Date(e.timestamp).toISOString())}</td>
      <td class="mono">${esc(e.status)}</td>
      <td class="mono">${e.classification ?? ""}</td>
      <td>${e.resolution ?? ""}</td>
      <td>${esc(e.text)}</td>
      <td class="muted">${e.rationale ?? ""}</td>
      <td class="muted">${e.resolvedAt ? formatDateShort(e.resolvedAt) : ""}</td>
      <td>${e.executed !== void 0 ? e.executed ? "yes" : "no" : ""}</td>
    </tr>`).join("");
  return section("captures", `Captures ${badge}`, `
    <div class="table-scroll">
      <table class="tbl">
        <thead><tr><th>Captured</th><th>Status</th><th>Class</th><th>Resolution</th><th>Text</th><th>Rationale</th><th>Resolved</th><th>Executed</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`);
}
function buildStatsSection(data) {
  const s = data.stats;
  const missingHtml = s.missingCount > 0 ? `
    <h3>Missing changelogs <span class="count">${s.missingCount}</span></h3>
    <table class="tbl">
      <thead><tr><th>Milestone</th><th>Slice</th><th>Title</th></tr></thead>
      <tbody>
        ${s.missingSlices.map((sl) => `<tr><td class="mono">${esc(sl.milestoneId)}</td><td class="mono">${esc(sl.sliceId)}</td><td>${esc(sl.title)}</td></tr>`).join("")}
        ${s.missingCount > s.missingSlices.length ? `<tr><td colspan="3" class="muted">and ${s.missingCount - s.missingSlices.length} more</td></tr>` : ""}
      </tbody>
    </table>` : "";
  const updatedHtml = s.updatedCount > 0 ? `
    <h3>Recently completed <span class="count">${s.updatedCount}</span></h3>
    <table class="tbl">
      <thead><tr><th>Milestone</th><th>Slice</th><th>Title</th><th>Completed</th></tr></thead>
      <tbody>${s.updatedSlices.map((sl) => `
        <tr><td class="mono">${esc(sl.milestoneId)}</td><td class="mono">${esc(sl.sliceId)}</td><td>${esc(sl.title)}</td><td class="muted">${sl.completedAt ? formatDateShort(sl.completedAt) : ""}</td></tr>`).join("")}
      </tbody>
    </table>` : "";
  if (!missingHtml && !updatedHtml) {
    return section("stats", "Artifacts", '<p class="empty">All artifacts accounted for.</p>');
  }
  return section("stats", "Artifacts", `${missingHtml}${updatedHtml}`);
}
function buildDiscussionSection(data) {
  if (data.discussion.length === 0) return section("discussion", "Planning", '<p class="empty">No milestones.</p>');
  const rows = data.discussion.map((d) => `
    <tr>
      <td class="mono">${esc(d.milestoneId)}</td>
      <td>${esc(d.title)}</td>
      <td class="mono">${d.state}</td>
      <td>${d.hasContext ? "yes" : ""}</td>
      <td>${d.hasDraft ? "draft" : ""}</td>
      <td class="muted">${d.lastUpdated ? formatDateShort(d.lastUpdated) : ""}</td>
    </tr>`).join("");
  return section("discussion", "Planning", `
    <table class="tbl">
      <thead><tr><th>ID</th><th>Milestone</th><th>State</th><th>Context</th><th>Draft</th><th>Updated</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`);
}
function section(id, title, body) {
  return `
<section id="${id}">
  <h2>${title}</h2>
  ${body}
</section>`;
}
function kvi(label, value) {
  return `<div class="kv"><span class="kv-val">${esc(value)}</span><span class="kv-lbl">${esc(label)}</span></div>`;
}
function hRow(label, value, status) {
  const cls = status ? ` class="h-${status}"` : "";
  return `<tr${cls}><td>${esc(label)}</td><td>${esc(value)}</td></tr>`;
}
function shortModel(m) {
  return m.replace(/^claude-/, "").replace(/^anthropic\//, "");
}
function truncStr(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
}
export {
  generateHtmlReport
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9leHBvcnQtaHRtbC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBHU0QgSFRNTCBSZXBvcnQgR2VuZXJhdG9yXG4gKlxuICogUHJvZHVjZXMgYSBzaW5nbGUgc2VsZi1jb250YWluZWQgSFRNTCBmaWxlIHdpdGg6XG4gKiAgIC0gQnJhbmRpbmcgaGVhZGVyIChwcm9qZWN0IG5hbWUsIHBhdGgsIEdTRCB2ZXJzaW9uLCBnZW5lcmF0ZWQgdGltZXN0YW1wKVxuICogICAtIFByb2plY3Qgc3VtbWFyeSAmIG92ZXJhbGwgcHJvZ3Jlc3NcbiAqICAgLSBQcm9ncmVzcyB0cmVlIChtaWxlc3RvbmVzIFx1MjE5MiBzbGljZXMgXHUyMTkyIHRhc2tzLCB3aXRoIGNyaXRpY2FsIHBhdGgpXG4gKiAgIC0gRXhlY3V0aW9uIHRpbWVsaW5lIChjaHJvbm9sb2dpY2FsIHVuaXQgaGlzdG9yeSlcbiAqICAgLSBTbGljZSBkZXBlbmRlbmN5IGdyYXBoIChTVkcgREFHIHBlciBtaWxlc3RvbmUpXG4gKiAgIC0gQ29zdCAmIHRva2VuIG1ldHJpY3MgKGJhciBjaGFydHMsIHBoYXNlL3NsaWNlL21vZGVsL3RpZXIgYnJlYWtkb3ducylcbiAqICAgLSBIZWFsdGggJiBjb25maWd1cmF0aW9uIG92ZXJ2aWV3XG4gKiAgIC0gQ2hhbmdlbG9nIChjb21wbGV0ZWQgc2xpY2Ugc3VtbWFyaWVzICsgZmlsZSBtb2RpZmljYXRpb25zKVxuICogICAtIEtub3dsZWRnZSBiYXNlIChydWxlcywgcGF0dGVybnMsIGxlc3NvbnMpXG4gKiAgIC0gQ2FwdHVyZXMgbG9nXG4gKiAgIC0gQXJ0aWZhY3RzICYgbWlsZXN0b25lIHBsYW5uaW5nIC8gZGlzY3Vzc2lvbiBzdGF0ZVxuICpcbiAqIE5vIGV4dGVybmFsIGRlcGVuZGVuY2llcyBcdTIwMTQgYWxsIENTUyBhbmQgSlMgaXMgaW5saW5lZC5cbiAqIFByaW50YWJsZSB0byBQREYgZnJvbSBhbnkgYnJvd3Nlci5cbiAqXG4gKiBEZXNpZ246IExpbmVhci1pbnNwaXJlZCBcdTIwMTQgcmVzdHJhaW5lZCBwYWxldHRlLCBnZW9tZXRyaWMgc3RhdHVzLCBubyBlbW9qaS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7XG4gIFZpc3VhbGl6ZXJEYXRhLFxuICBWaXN1YWxpemVyTWlsZXN0b25lLFxuICBWaXN1YWxpemVyU2xpY2UsXG59IGZyb20gJy4vdmlzdWFsaXplci1kYXRhLmpzJztcbmltcG9ydCB7IGZvcm1hdERhdGVTaG9ydCwgZm9ybWF0RHVyYXRpb24gfSBmcm9tICcuLi9zaGFyZWQvZm9ybWF0LXV0aWxzLmpzJztcbmltcG9ydCB7IGVzYywgcmVuZGVySHRtbFNoZWxsIH0gZnJvbSAnLi4vc2hhcmVkL2h0bWwtc2hlbGwuanMnO1xuaW1wb3J0IHsgZm9ybWF0Q29zdCwgZm9ybWF0VG9rZW5Db3VudCB9IGZyb20gJy4vbWV0cmljcy5qcyc7XG5pbXBvcnQgdHlwZSB7IFVuaXRNZXRyaWNzIH0gZnJvbSAnLi9tZXRyaWNzLmpzJztcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFB1YmxpYyBBUEkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBpbnRlcmZhY2UgSHRtbFJlcG9ydE9wdGlvbnMge1xuICBwcm9qZWN0TmFtZTogc3RyaW5nO1xuICBwcm9qZWN0UGF0aDogc3RyaW5nO1xuICBnc2RWZXJzaW9uOiBzdHJpbmc7XG4gIG1pbGVzdG9uZUlkPzogc3RyaW5nO1xuICBpbmRleFJlbFBhdGg/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZW5lcmF0ZUh0bWxSZXBvcnQoXG4gIGRhdGE6IFZpc3VhbGl6ZXJEYXRhLFxuICBvcHRzOiBIdG1sUmVwb3J0T3B0aW9ucyxcbik6IHN0cmluZyB7XG4gIGNvbnN0IGdlbmVyYXRlZCA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcblxuICBjb25zdCBzZWN0aW9ucyA9IFtcbiAgICBidWlsZFN1bW1hcnlTZWN0aW9uKGRhdGEsIG9wdHMsIGdlbmVyYXRlZCksXG4gICAgYnVpbGRCbG9ja2Vyc1NlY3Rpb24oZGF0YSksXG4gICAgYnVpbGRQcm9ncmVzc1NlY3Rpb24oZGF0YSksXG4gICAgYnVpbGRUaW1lbGluZVNlY3Rpb24oZGF0YSksXG4gICAgYnVpbGREZXBHcmFwaFNlY3Rpb24oZGF0YSksXG4gICAgYnVpbGRNZXRyaWNzU2VjdGlvbihkYXRhKSxcbiAgICBidWlsZEhlYWx0aFNlY3Rpb24oZGF0YSksXG4gICAgYnVpbGRDaGFuZ2Vsb2dTZWN0aW9uKGRhdGEpLFxuICAgIGJ1aWxkS25vd2xlZGdlU2VjdGlvbihkYXRhKSxcbiAgICBidWlsZENhcHR1cmVzU2VjdGlvbihkYXRhKSxcbiAgICBidWlsZFN0YXRzU2VjdGlvbihkYXRhKSxcbiAgICBidWlsZERpc2N1c3Npb25TZWN0aW9uKGRhdGEpLFxuICBdO1xuXG4gIGNvbnN0IHRpdGxlID0gb3B0cy5taWxlc3RvbmVJZCA/IGAke29wdHMucHJvamVjdE5hbWV9IC8gJHtvcHRzLm1pbGVzdG9uZUlkfWAgOiBvcHRzLnByb2plY3ROYW1lO1xuXG4gIGNvbnN0IGJhY2tMaW5rID0gb3B0cy5pbmRleFJlbFBhdGhcbiAgICA/IGA8YSBjbGFzcz1cImJhY2stbGlua1wiIGhyZWY9XCIke2VzYyhvcHRzLmluZGV4UmVsUGF0aCl9XCI+QWxsIFJlcG9ydHM8L2E+YFxuICAgIDogJyc7XG5cbiAgcmV0dXJuIHJlbmRlckh0bWxTaGVsbCh7XG4gICAgdGl0bGUsXG4gICAgZG9jdW1lbnRUaXRsZTogYEdTRCBSZXBvcnQgXHUyMDE0ICR7b3B0cy5wcm9qZWN0TmFtZX0ke29wdHMubWlsZXN0b25lSWQgPyBgIFx1MjAxNCAke29wdHMubWlsZXN0b25lSWR9YCA6ICcnfWAsXG4gICAgc3VidGl0bGU6IG9wdHMucHJvamVjdFBhdGgsXG4gICAga2luZDogJ1JlcG9ydCcsXG4gICAgdmVyc2lvbjogb3B0cy5nc2RWZXJzaW9uLFxuICAgIGdlbmVyYXRlZEF0OiBnZW5lcmF0ZWQsXG4gICAgaGVhZGVyQWN0aW9uc0h0bWw6IGJhY2tMaW5rLFxuICAgIGZvb3Rlck5vdGU6IG9wdHMubWlsZXN0b25lSWQgPyBgJHtvcHRzLnByb2plY3ROYW1lfSAvICR7b3B0cy5taWxlc3RvbmVJZH1gIDogb3B0cy5wcm9qZWN0TmFtZSxcbiAgICB0b2M6IFtcbiAgICAgIHsgaHJlZjogJyNzdW1tYXJ5JywgbGFiZWw6ICdTdW1tYXJ5JyB9LFxuICAgICAgeyBocmVmOiAnI2Jsb2NrZXJzJywgbGFiZWw6ICdCbG9ja2VycycgfSxcbiAgICAgIHsgaHJlZjogJyNwcm9ncmVzcycsIGxhYmVsOiAnUHJvZ3Jlc3MnIH0sXG4gICAgICB7IGhyZWY6ICcjdGltZWxpbmUnLCBsYWJlbDogJ1RpbWVsaW5lJyB9LFxuICAgICAgeyBocmVmOiAnI2RlcGdyYXBoJywgbGFiZWw6ICdEZXBlbmRlbmNpZXMnIH0sXG4gICAgICB7IGhyZWY6ICcjbWV0cmljcycsIGxhYmVsOiAnTWV0cmljcycgfSxcbiAgICAgIHsgaHJlZjogJyNoZWFsdGgnLCBsYWJlbDogJ0hlYWx0aCcgfSxcbiAgICAgIHsgaHJlZjogJyNjaGFuZ2Vsb2cnLCBsYWJlbDogJ0NoYW5nZWxvZycgfSxcbiAgICAgIHsgaHJlZjogJyNrbm93bGVkZ2UnLCBsYWJlbDogJ0tub3dsZWRnZScgfSxcbiAgICAgIHsgaHJlZjogJyNjYXB0dXJlcycsIGxhYmVsOiAnQ2FwdHVyZXMnIH0sXG4gICAgICB7IGhyZWY6ICcjc3RhdHMnLCBsYWJlbDogJ0FydGlmYWN0cycgfSxcbiAgICAgIHsgaHJlZjogJyNkaXNjdXNzaW9uJywgbGFiZWw6ICdQbGFubmluZycgfSxcbiAgICBdLFxuICAgIG1haW5IdG1sOiBzZWN0aW9ucy5qb2luKCdcXG4nKSxcbiAgfSk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTZWN0aW9uOiBTdW1tYXJ5IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBidWlsZFN1bW1hcnlTZWN0aW9uKFxuICBkYXRhOiBWaXN1YWxpemVyRGF0YSxcbiAgb3B0czogSHRtbFJlcG9ydE9wdGlvbnMsXG4gIF9nZW5lcmF0ZWQ6IHN0cmluZyxcbik6IHN0cmluZyB7XG4gIGNvbnN0IHQgPSBkYXRhLnRvdGFscztcbiAgY29uc3QgdG90YWxTbGljZXMgPSBkYXRhLm1pbGVzdG9uZXMucmVkdWNlKChzLCBtKSA9PiBzICsgbS5zbGljZXMubGVuZ3RoLCAwKTtcbiAgY29uc3QgZG9uZVNsaWNlcyAgPSBkYXRhLm1pbGVzdG9uZXMucmVkdWNlKChzLCBtKSA9PiBzICsgbS5zbGljZXMuZmlsdGVyKHNsID0+IHNsLmRvbmUpLmxlbmd0aCwgMCk7XG4gIGNvbnN0IGRvbmVNaWxlc3RvbmVzID0gZGF0YS5taWxlc3RvbmVzLmZpbHRlcihtID0+IG0uc3RhdHVzID09PSAnY29tcGxldGUnKS5sZW5ndGg7XG4gIGNvbnN0IGFjdGl2ZU1pbGVzdG9uZSA9IGRhdGEubWlsZXN0b25lcy5maW5kKG0gPT4gbS5zdGF0dXMgPT09ICdhY3RpdmUnKTtcbiAgY29uc3QgcGN0ID0gdG90YWxTbGljZXMgPiAwID8gTWF0aC5yb3VuZCgoZG9uZVNsaWNlcyAvIHRvdGFsU2xpY2VzKSAqIDEwMCkgOiAwO1xuXG4gIGNvbnN0IGFjdCA9IGRhdGEuYWdlbnRBY3Rpdml0eTtcbiAgY29uc3Qga3YgPSBbXG4gICAga3ZpKCdNaWxlc3RvbmVzJywgYCR7ZG9uZU1pbGVzdG9uZXN9LyR7ZGF0YS5taWxlc3RvbmVzLmxlbmd0aH1gKSxcbiAgICBrdmkoJ1NsaWNlcycsIGAke2RvbmVTbGljZXN9LyR7dG90YWxTbGljZXN9YCksXG4gICAga3ZpKCdQaGFzZScsIGRhdGEucGhhc2UpLFxuICAgIHQgPyBrdmkoJ0Nvc3QnLCBmb3JtYXRDb3N0KHQuY29zdCkpIDogJycsXG4gICAgdCA/IGt2aSgnVG9rZW5zJywgZm9ybWF0VG9rZW5Db3VudCh0LnRva2Vucy50b3RhbCkpIDogJycsXG4gICAgdCA/IGt2aSgnRHVyYXRpb24nLCBmb3JtYXREdXJhdGlvbih0LmR1cmF0aW9uKSkgOiAnJyxcbiAgICB0ID8ga3ZpKCdUb29sIGNhbGxzJywgU3RyaW5nKHQudG9vbENhbGxzKSkgOiAnJyxcbiAgICB0ID8ga3ZpKCdVbml0cycsIFN0cmluZyh0LnVuaXRzKSkgOiAnJyxcbiAgICBkYXRhLnJlbWFpbmluZ1NsaWNlQ291bnQgPiAwID8ga3ZpKCdSZW1haW5pbmcnLCBTdHJpbmcoZGF0YS5yZW1haW5pbmdTbGljZUNvdW50KSkgOiAnJyxcbiAgICBhY3QgPyBrdmkoJ1JhdGUnLCBgJHthY3QuY29tcGxldGlvblJhdGUudG9GaXhlZCgxKX0vaHJgKSA6ICcnLFxuICAgIHQgJiYgZG9uZVNsaWNlcyA+IDAgPyBrdmkoJ0Nvc3Qvc2xpY2UnLCBmb3JtYXRDb3N0KHQuY29zdCAvIGRvbmVTbGljZXMpKSA6ICcnLFxuICAgIHQgJiYgdC50b29sQ2FsbHMgPiAwID8ga3ZpKCdUb2tlbnMvdG9vbCcsIGZvcm1hdFRva2VuQ291bnQodC50b2tlbnMudG90YWwgLyB0LnRvb2xDYWxscykpIDogJycsXG4gICAgdCAmJiAodC50b2tlbnMuaW5wdXQgKyB0LnRva2Vucy5jYWNoZVJlYWQpID4gMFxuICAgICAgPyBrdmkoJ0NhY2hlIGhpdCcsICgodC50b2tlbnMuY2FjaGVSZWFkIC8gKHQudG9rZW5zLmlucHV0ICsgdC50b2tlbnMuY2FjaGVSZWFkKSkgKiAxMDApLnRvRml4ZWQoMSkgKyAnJScpXG4gICAgICA6ICcnLFxuICAgIG9wdHMubWlsZXN0b25lSWQgPyBrdmkoJ1Njb3BlJywgb3B0cy5taWxlc3RvbmVJZCkgOiAnJyxcbiAgXS5maWx0ZXIoQm9vbGVhbikuam9pbignJyk7XG5cbiAgY29uc3QgYWN0aXZlSW5mbyA9IGFjdGl2ZU1pbGVzdG9uZSA/ICgoKSA9PiB7XG4gICAgY29uc3QgYWN0aXZlID0gYWN0aXZlTWlsZXN0b25lLnNsaWNlcy5maW5kKHMgPT4gcy5hY3RpdmUpO1xuICAgIGlmICghYWN0aXZlKSByZXR1cm4gJyc7XG4gICAgcmV0dXJuIGA8ZGl2IGNsYXNzPVwiYWN0aXZlLWluZm9cIj5cbiAgICAgIEV4ZWN1dGluZyA8c3BhbiBjbGFzcz1cIm1vbm9cIj4ke2VzYyhhY3RpdmVNaWxlc3RvbmUuaWQpfS8ke2VzYyhhY3RpdmUuaWQpfTwvc3Bhbj4gXHUyMDE0ICR7ZXNjKGFjdGl2ZS50aXRsZSl9XG4gICAgPC9kaXY+YDtcbiAgfSkoKSA6ICcnO1xuXG4gIGNvbnN0IGFjdGl2aXR5SHRtbCA9IGFjdD8uYWN0aXZlID8gYFxuICAgIDxkaXYgY2xhc3M9XCJhY3Rpdml0eS1saW5lXCI+XG4gICAgICA8c3BhbiBjbGFzcz1cImRvdCBkb3QtYWN0aXZlXCI+PC9zcGFuPlxuICAgICAgPHNwYW4gY2xhc3M9XCJtb25vXCI+JHtlc2MoYWN0LmN1cnJlbnRVbml0Py50eXBlID8/ICcnKX08L3NwYW4+XG4gICAgICA8c3BhbiBjbGFzcz1cIm1vbm8gbXV0ZWRcIj4ke2VzYyhhY3QuY3VycmVudFVuaXQ/LmlkID8/ICcnKX08L3NwYW4+XG4gICAgICA8c3BhbiBjbGFzcz1cIm11dGVkXCI+JHtmb3JtYXREdXJhdGlvbihhY3QuZWxhcHNlZCl9IGVsYXBzZWQ8L3NwYW4+XG4gICAgPC9kaXY+YCA6ICcnO1xuXG4gIGNvbnN0IGV4ZWNTdW1tYXJ5ID0gYnVpbGRFeGVjdXRpdmVTdW1tYXJ5KGRhdGEsIG9wdHMpO1xuICBjb25zdCBldGFMaW5lID0gYnVpbGRFdGFMaW5lKGRhdGEpO1xuXG4gIHJldHVybiBzZWN0aW9uKCdzdW1tYXJ5JywgJ1N1bW1hcnknLCBgXG4gICAgJHtleGVjU3VtbWFyeX1cbiAgICA8ZGl2IGNsYXNzPVwia3YtZ3JpZFwiPiR7a3Z9PC9kaXY+XG4gICAgPGRpdiBjbGFzcz1cInByb2dyZXNzLXdyYXBcIj5cbiAgICAgIDxkaXYgY2xhc3M9XCJwcm9ncmVzcy10cmFja1wiPjxkaXYgY2xhc3M9XCJwcm9ncmVzcy1maWxsXCIgc3R5bGU9XCJ3aWR0aDoke3BjdH0lXCI+PC9kaXY+PC9kaXY+XG4gICAgICA8c3BhbiBjbGFzcz1cInByb2dyZXNzLWxhYmVsXCI+JHtwY3R9JTwvc3Bhbj5cbiAgICA8L2Rpdj5cbiAgICAke2FjdGl2ZUluZm99XG4gICAgJHthY3Rpdml0eUh0bWx9XG4gICAgJHtldGFMaW5lfVxuICBgKTtcbn1cblxuZnVuY3Rpb24gYnVpbGRFeGVjdXRpdmVTdW1tYXJ5KGRhdGE6IFZpc3VhbGl6ZXJEYXRhLCBvcHRzOiBIdG1sUmVwb3J0T3B0aW9ucyk6IHN0cmluZyB7XG4gIGNvbnN0IHRvdGFsU2xpY2VzID0gZGF0YS5taWxlc3RvbmVzLnJlZHVjZSgocywgbSkgPT4gcyArIG0uc2xpY2VzLmxlbmd0aCwgMCk7XG4gIGNvbnN0IGRvbmVTbGljZXMgPSBkYXRhLm1pbGVzdG9uZXMucmVkdWNlKChzLCBtKSA9PiBzICsgbS5zbGljZXMuZmlsdGVyKHNsID0+IHNsLmRvbmUpLmxlbmd0aCwgMCk7XG4gIGNvbnN0IHBjdCA9IHRvdGFsU2xpY2VzID4gMCA/IE1hdGgucm91bmQoKGRvbmVTbGljZXMgLyB0b3RhbFNsaWNlcykgKiAxMDApIDogMDtcbiAgY29uc3Qgc3BlbnQgPSBkYXRhLnRvdGFscz8uY29zdCA/PyAwO1xuICBjb25zdCBhY3RpdmVNaWxlc3RvbmUgPSBkYXRhLm1pbGVzdG9uZXMuZmluZChtID0+IG0uc3RhdHVzID09PSAnYWN0aXZlJyk7XG4gIGNvbnN0IGFjdGl2ZVNsaWNlID0gYWN0aXZlTWlsZXN0b25lPy5zbGljZXMuZmluZChzID0+IHMuYWN0aXZlKTtcbiAgY29uc3QgY3VycmVudEV4ZWMgPSBhY3RpdmVNaWxlc3RvbmUgJiYgYWN0aXZlU2xpY2VcbiAgICA/IGAgQ3VycmVudGx5IGV4ZWN1dGluZyAke2VzYyhhY3RpdmVNaWxlc3RvbmUuaWQpfS8ke2VzYyhhY3RpdmVTbGljZS5pZCl9LmBcbiAgICA6ICcnO1xuICBjb25zdCBidWRnZXRDdHggPSBkYXRhLmhlYWx0aC5idWRnZXRDZWlsaW5nXG4gICAgPyBgIEJ1ZGdldDogJHtmb3JtYXRDb3N0KHNwZW50KX0gb2YgJHtmb3JtYXRDb3N0KGRhdGEuaGVhbHRoLmJ1ZGdldENlaWxpbmcpfSBjZWlsaW5nICgkeygoc3BlbnQgLyBkYXRhLmhlYWx0aC5idWRnZXRDZWlsaW5nKSAqIDEwMCkudG9GaXhlZCgwKX0lIHVzZWQpLmBcbiAgICA6ICcnO1xuICByZXR1cm4gYDxwIGNsYXNzPVwiZXhlYy1zdW1tYXJ5XCI+JHtlc2Mob3B0cy5wcm9qZWN0TmFtZSl9IGlzICR7cGN0fSUgY29tcGxldGUgYWNyb3NzICR7ZGF0YS5taWxlc3RvbmVzLmxlbmd0aH0gbWlsZXN0b25lcy4gJHtmb3JtYXRDb3N0KHNwZW50KX0gc3BlbnQuJHtjdXJyZW50RXhlY30ke2J1ZGdldEN0eH08L3A+YDtcbn1cblxuZnVuY3Rpb24gYnVpbGRFdGFMaW5lKGRhdGE6IFZpc3VhbGl6ZXJEYXRhKTogc3RyaW5nIHtcbiAgY29uc3QgYWN0ID0gZGF0YS5hZ2VudEFjdGl2aXR5O1xuICBpZiAoIWFjdCB8fCBhY3QuY29tcGxldGlvblJhdGUgPD0gMCB8fCBkYXRhLnJlbWFpbmluZ1NsaWNlQ291bnQgPD0gMCkgcmV0dXJuICcnO1xuICBjb25zdCBob3Vyc1JlbWFpbmluZyA9IGRhdGEucmVtYWluaW5nU2xpY2VDb3VudCAvIGFjdC5jb21wbGV0aW9uUmF0ZTtcbiAgY29uc3QgZm9ybWF0dGVkID0gZm9ybWF0RHVyYXRpb24oaG91cnNSZW1haW5pbmcgKiAzXzYwMF8wMDApO1xuICByZXR1cm4gYDxkaXYgY2xhc3M9XCJldGEtbGluZVwiPkVUQTogfiR7Zm9ybWF0dGVkfSByZW1haW5pbmcgKCR7ZGF0YS5yZW1haW5pbmdTbGljZUNvdW50fSBzbGljZXMgYXQgJHthY3QuY29tcGxldGlvblJhdGUudG9GaXhlZCgxKX0vaHIpPC9kaXY+YDtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFNlY3Rpb246IEJsb2NrZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBidWlsZEJsb2NrZXJzU2VjdGlvbihkYXRhOiBWaXN1YWxpemVyRGF0YSk6IHN0cmluZyB7XG4gIGNvbnN0IGJsb2NrZXJzID0gZGF0YS5zbGljZVZlcmlmaWNhdGlvbnMuZmlsdGVyKHYgPT4gdi5ibG9ja2VyRGlzY292ZXJlZCA9PT0gdHJ1ZSk7XG4gIGNvbnN0IGhpZ2hSaXNrOiB7IG1zSWQ6IHN0cmluZzsgc2xJZDogc3RyaW5nIH1bXSA9IFtdO1xuICBmb3IgKGNvbnN0IG1zIG9mIGRhdGEubWlsZXN0b25lcykge1xuICAgIGZvciAoY29uc3Qgc2wgb2YgbXMuc2xpY2VzKSB7XG4gICAgICBpZiAoIXNsLmRvbmUgJiYgc2wucmlzaz8udG9Mb3dlckNhc2UoKSA9PT0gJ2hpZ2gnKSB7XG4gICAgICAgIGhpZ2hSaXNrLnB1c2goeyBtc0lkOiBtcy5pZCwgc2xJZDogc2wuaWQgfSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgaWYgKGJsb2NrZXJzLmxlbmd0aCA9PT0gMCAmJiBoaWdoUmlzay5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm4gc2VjdGlvbignYmxvY2tlcnMnLCAnQmxvY2tlcnMnLCAnPHAgY2xhc3M9XCJlbXB0eVwiPk5vIGJsb2NrZXJzIG9yIGhpZ2gtcmlzayBpdGVtcyBmb3VuZC48L3A+Jyk7XG4gIH1cblxuICBjb25zdCBibG9ja2VyQ2FyZHMgPSBibG9ja2Vycy5tYXAodiA9PiBgXG4gICAgPGRpdiBjbGFzcz1cImJsb2NrZXItY2FyZFwiPlxuICAgICAgPGRpdiBjbGFzcz1cImJsb2NrZXItaWRcIj4ke2VzYyh2Lm1pbGVzdG9uZUlkKX0vJHtlc2Modi5zbGljZUlkKX08L2Rpdj5cbiAgICAgIDxkaXYgY2xhc3M9XCJibG9ja2VyLXRleHRcIj4ke2VzYyh2LnZlcmlmaWNhdGlvblJlc3VsdCA/PyAnQmxvY2tlciBkaXNjb3ZlcmVkJyl9PC9kaXY+XG4gICAgPC9kaXY+YCkuam9pbignJyk7XG5cbiAgY29uc3Qgcmlza0NhcmRzID0gaGlnaFJpc2tcbiAgICAuZmlsdGVyKGhyID0+ICFibG9ja2Vycy5zb21lKGIgPT4gYi5taWxlc3RvbmVJZCA9PT0gaHIubXNJZCAmJiBiLnNsaWNlSWQgPT09IGhyLnNsSWQpKVxuICAgIC5tYXAoaHIgPT4gYFxuICAgIDxkaXYgY2xhc3M9XCJibG9ja2VyLWNhcmRcIj5cbiAgICAgIDxkaXYgY2xhc3M9XCJibG9ja2VyLWlkXCI+JHtlc2MoaHIubXNJZCl9LyR7ZXNjKGhyLnNsSWQpfTwvZGl2PlxuICAgICAgPGRpdiBjbGFzcz1cImJsb2NrZXItdGV4dFwiPkhpZ2ggcmlzayBcdTIwMTQgaW5jb21wbGV0ZTwvZGl2PlxuICAgIDwvZGl2PmApLmpvaW4oJycpO1xuXG4gIHJldHVybiBzZWN0aW9uKCdibG9ja2VycycsICdCbG9ja2VycycsIGAke2Jsb2NrZXJDYXJkc30ke3Jpc2tDYXJkc31gKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFNlY3Rpb246IEhlYWx0aCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gYnVpbGRIZWFsdGhTZWN0aW9uKGRhdGE6IFZpc3VhbGl6ZXJEYXRhKTogc3RyaW5nIHtcbiAgY29uc3QgaCA9IGRhdGEuaGVhbHRoO1xuICBjb25zdCB0ID0gZGF0YS50b3RhbHM7XG5cbiAgY29uc3Qgcm93czogc3RyaW5nW10gPSBbXTtcbiAgcm93cy5wdXNoKGhSb3coJ1Rva2VuIHByb2ZpbGUnLCBoLnRva2VuUHJvZmlsZSkpO1xuICBpZiAoaC5idWRnZXRDZWlsaW5nICE9PSB1bmRlZmluZWQpIHtcbiAgICBjb25zdCBzcGVudCA9IHQ/LmNvc3QgPz8gMDtcbiAgICBjb25zdCBwY3QgPSAoc3BlbnQgLyBoLmJ1ZGdldENlaWxpbmcpICogMTAwO1xuICAgIGNvbnN0IHN0YXR1cyA9IHBjdCA+IDkwID8gJ3dhcm4nIDogcGN0ID4gNzUgPyAnY2F1dGlvbicgOiAnb2snO1xuICAgIHJvd3MucHVzaChoUm93KFxuICAgICAgJ0J1ZGdldCBjZWlsaW5nJyxcbiAgICAgIGAke2Zvcm1hdENvc3QoaC5idWRnZXRDZWlsaW5nKX0gKCR7Zm9ybWF0Q29zdChzcGVudCl9IHNwZW50LCAke3BjdC50b0ZpeGVkKDApfSUgdXNlZClgLFxuICAgICAgc3RhdHVzLFxuICAgICkpO1xuICB9XG4gIHJvd3MucHVzaChoUm93KFxuICAgICdUcnVuY2F0aW9uIHJhdGUnLFxuICAgIGAke2gudHJ1bmNhdGlvblJhdGUudG9GaXhlZCgxKX0lIHBlciB1bml0ICgke3Q/LnRvdGFsVHJ1bmNhdGlvblNlY3Rpb25zID8/IDB9IHRvdGFsKWAsXG4gICAgaC50cnVuY2F0aW9uUmF0ZSA+IDIwID8gJ3dhcm4nIDogaC50cnVuY2F0aW9uUmF0ZSA+IDEwID8gJ2NhdXRpb24nIDogJ29rJyxcbiAgKSk7XG4gIHJvd3MucHVzaChoUm93KFxuICAgICdDb250aW51ZS1oZXJlIHJhdGUnLFxuICAgIGAke2guY29udGludWVIZXJlUmF0ZS50b0ZpeGVkKDEpfSUgcGVyIHVuaXQgKCR7dD8uY29udGludWVIZXJlRmlyZWRDb3VudCA/PyAwfSB0b3RhbClgLFxuICAgIGguY29udGludWVIZXJlUmF0ZSA+IDE1ID8gJ3dhcm4nIDogaC5jb250aW51ZUhlcmVSYXRlID4gOCA/ICdjYXV0aW9uJyA6ICdvaycsXG4gICkpO1xuICBpZiAoaC50aWVyU2F2aW5nc0xpbmUpIHJvd3MucHVzaChoUm93KCdSb3V0aW5nIHNhdmluZ3MnLCBoLnRpZXJTYXZpbmdzTGluZSkpO1xuICByb3dzLnB1c2goaFJvdygnVG9vbCBjYWxscycsIFN0cmluZyhoLnRvb2xDYWxscykpKTtcbiAgcm93cy5wdXNoKGhSb3coJ01lc3NhZ2VzJywgYCR7aC5hc3Npc3RhbnRNZXNzYWdlc30gYXNzaXN0YW50IC8gJHtoLnVzZXJNZXNzYWdlc30gdXNlcmApKTtcblxuICBjb25zdCB0aWVyUm93cyA9IGgudGllckJyZWFrZG93bi5sZW5ndGggPiAwID8gYFxuICAgIDxoMz5UaWVyIGJyZWFrZG93bjwvaDM+XG4gICAgPHRhYmxlIGNsYXNzPVwidGJsXCI+XG4gICAgICA8dGhlYWQ+PHRyPjx0aD5UaWVyPC90aD48dGg+VW5pdHM8L3RoPjx0aD5Db3N0PC90aD48dGg+VG9rZW5zPC90aD48L3RyPjwvdGhlYWQ+XG4gICAgICA8dGJvZHk+XG4gICAgICAgICR7aC50aWVyQnJlYWtkb3duLm1hcCh0YiA9PlxuICAgICAgICAgIGA8dHI+PHRkIGNsYXNzPVwibW9ub1wiPiR7ZXNjKHRiLnRpZXIpfTwvdGQ+XG4gICAgICAgICAgIDx0ZD4ke3RiLnVuaXRzfTwvdGQ+PHRkPiR7Zm9ybWF0Q29zdCh0Yi5jb3N0KX08L3RkPlxuICAgICAgICAgICA8dGQ+JHtmb3JtYXRUb2tlbkNvdW50KHRiLnRva2Vucy50b3RhbCl9PC90ZD48L3RyPmBcbiAgICAgICAgKS5qb2luKCcnKX1cbiAgICAgIDwvdGJvZHk+XG4gICAgPC90YWJsZT5gIDogJyc7XG5cbiAgLy8gUHJvZ3Jlc3Mgc2NvcmUgc2VjdGlvblxuICBsZXQgcHJvZ3Jlc3NIdG1sID0gJyc7XG4gIGlmIChoLnByb2dyZXNzU2NvcmUpIHtcbiAgICBjb25zdCBwcyA9IGgucHJvZ3Jlc3NTY29yZTtcbiAgICBjb25zdCBzY29yZUNvbG9yID0gcHMubGV2ZWwgPT09ICdncmVlbicgPyAnIzIyYzU1ZScgOiBwcy5sZXZlbCA9PT0gJ3llbGxvdycgPyAnI2VhYjMwOCcgOiAnI2VmNDQ0NCc7XG4gICAgY29uc3Qgc2lnbmFsUm93cyA9IHBzLnNpZ25hbHMubWFwKHMgPT4ge1xuICAgICAgY29uc3QgaWNvbiA9IHMua2luZCA9PT0gJ3Bvc2l0aXZlJyA/ICdcdTI3MTMnIDogcy5raW5kID09PSAnbmVnYXRpdmUnID8gJ1x1MjcxNycgOiAnXHUwMEI3JztcbiAgICAgIGNvbnN0IGNvbG9yID0gcy5raW5kID09PSAncG9zaXRpdmUnID8gJyMyMmM1NWUnIDogcy5raW5kID09PSAnbmVnYXRpdmUnID8gJyNlZjQ0NDQnIDogJyM4ODgnO1xuICAgICAgcmV0dXJuIGA8ZGl2IHN0eWxlPVwibWFyZ2luLWxlZnQ6MWVtO2NvbG9yOiR7Y29sb3J9XCI+JHtpY29ufSAke2VzYyhzLmxhYmVsKX08L2Rpdj5gO1xuICAgIH0pLmpvaW4oJycpO1xuICAgIHByb2dyZXNzSHRtbCA9IGBcbiAgICAgIDxoMz5Qcm9ncmVzcyBTY29yZTwvaDM+XG4gICAgICA8ZGl2IHN0eWxlPVwiZm9udC1zaXplOjEuMWVtO2ZvbnQtd2VpZ2h0OmJvbGQ7Y29sb3I6JHtzY29yZUNvbG9yfVwiPlx1MjVDRiAke2VzYyhwcy5zdW1tYXJ5KX08L2Rpdj5cbiAgICAgICR7c2lnbmFsUm93c31gO1xuICB9XG5cbiAgLy8gRG9jdG9yIGhpc3Rvcnkgc2VjdGlvblxuICBsZXQgaGlzdG9yeUh0bWwgPSAnJztcbiAgY29uc3QgZG9jdG9ySGlzdG9yeSA9IGguZG9jdG9ySGlzdG9yeSA/PyBbXTtcbiAgaWYgKGRvY3Rvckhpc3RvcnkubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IGhpc3RvcnlSb3dzID0gZG9jdG9ySGlzdG9yeS5zbGljZSgwLCAyMCkubWFwKGVudHJ5ID0+IHtcbiAgICAgIGNvbnN0IHN0YXR1c0ljb24gPSBlbnRyeS5vayA/ICdcdTI3MTMnIDogJ1x1MjcxNyc7XG4gICAgICBjb25zdCBzdGF0dXNDb2xvciA9IGVudHJ5Lm9rID8gJyMyMmM1NWUnIDogJyNlZjQ0NDQnO1xuICAgICAgY29uc3QgdHMgPSBlbnRyeS50cy5yZXBsYWNlKCdUJywgJyAnKS5zbGljZSgwLCAxOSk7XG4gICAgICBjb25zdCBzY29wZVRhZyA9IGVudHJ5LnNjb3BlID8gYDxzcGFuIGNsYXNzPVwibW9ub1wiIHN0eWxlPVwiY29sb3I6Izg4OFwiPiBbJHtlc2MoZW50cnkuc2NvcGUpfV08L3NwYW4+YCA6ICcnO1xuICAgICAgY29uc3Qgc3VtbWFyeVRleHQgPSBlbnRyeS5zdW1tYXJ5ID8gZXNjKGVudHJ5LnN1bW1hcnkpIDogYCR7ZW50cnkuZXJyb3JzfSBlcnJvcnMsICR7ZW50cnkud2FybmluZ3N9IHdhcm5pbmdzLCAke2VudHJ5LmZpeGVzfSBmaXhlc2A7XG4gICAgICBjb25zdCBpc3N1ZURldGFpbHMgPSAoZW50cnkuaXNzdWVzID8/IFtdKS5zbGljZSgwLCAzKS5tYXAoaSA9PiB7XG4gICAgICAgIGNvbnN0IGlDb2xvciA9IGkuc2V2ZXJpdHkgPT09ICdlcnJvcicgPyAnI2VmNDQ0NCcgOiAnI2VhYjMwOCc7XG4gICAgICAgIHJldHVybiBgPGRpdiBzdHlsZT1cIm1hcmdpbi1sZWZ0OjJlbTtjb2xvcjoke2lDb2xvcn07Zm9udC1zaXplOjAuODVlbVwiPiR7aS5zZXZlcml0eSA9PT0gJ2Vycm9yJyA/ICdcdTI3MTcnIDogJ1x1MjZBMCd9ICR7ZXNjKGkubWVzc2FnZSl9IDxzcGFuIGNsYXNzPVwibW9ub1wiIHN0eWxlPVwiY29sb3I6Izg4OFwiPiR7ZXNjKGkudW5pdElkKX08L3NwYW4+PC9kaXY+YDtcbiAgICAgIH0pLmpvaW4oJycpO1xuICAgICAgY29uc3QgZml4RGV0YWlscyA9IChlbnRyeS5maXhEZXNjcmlwdGlvbnMgPz8gW10pLnNsaWNlKDAsIDIpLm1hcChmID0+XG4gICAgICAgIGA8ZGl2IHN0eWxlPVwibWFyZ2luLWxlZnQ6MmVtO2NvbG9yOiMyMmM1NWU7Zm9udC1zaXplOjAuODVlbVwiPlx1MjFCMyAke2VzYyhmKX08L2Rpdj5gXG4gICAgICApLmpvaW4oJycpO1xuICAgICAgcmV0dXJuIGA8dHIgc3R5bGU9XCJjb2xvcjoke3N0YXR1c0NvbG9yfVwiPlxuICAgICAgICA8dGQgY2xhc3M9XCJtb25vXCI+JHtzdGF0dXNJY29ufTwvdGQ+XG4gICAgICAgIDx0ZCBjbGFzcz1cIm1vbm9cIj4ke2VzYyh0cyl9JHtzY29wZVRhZ308L3RkPlxuICAgICAgICA8dGQ+JHtzdW1tYXJ5VGV4dH08L3RkPlxuICAgICAgPC90cj5cbiAgICAgICR7aXNzdWVEZXRhaWxzIHx8IGZpeERldGFpbHMgPyBgPHRyPjx0ZCBjb2xzcGFuPVwiM1wiPiR7aXNzdWVEZXRhaWxzfSR7Zml4RGV0YWlsc308L3RkPjwvdHI+YCA6ICcnfWA7XG4gICAgfSkuam9pbignJyk7XG5cbiAgICBoaXN0b3J5SHRtbCA9IGBcbiAgICAgIDxoMz5Eb2N0b3IgUnVuIEhpc3Rvcnk8L2gzPlxuICAgICAgPHRhYmxlIGNsYXNzPVwidGJsXCI+XG4gICAgICAgIDx0aGVhZD48dHI+PHRoPjwvdGg+PHRoPlRpbWU8L3RoPjx0aD5TdW1tYXJ5PC90aD48L3RyPjwvdGhlYWQ+XG4gICAgICAgIDx0Ym9keT4ke2hpc3RvcnlSb3dzfTwvdGJvZHk+XG4gICAgICA8L3RhYmxlPmA7XG4gIH1cblxuICByZXR1cm4gc2VjdGlvbignaGVhbHRoJywgJ0hlYWx0aCcsIGBcbiAgICA8dGFibGUgY2xhc3M9XCJ0YmwgdGJsLWt2XCI+PHRib2R5PiR7cm93cy5qb2luKCcnKX08L3Rib2R5PjwvdGFibGU+XG4gICAgJHt0aWVyUm93c31cbiAgICAke3Byb2dyZXNzSHRtbH1cbiAgICAke2hpc3RvcnlIdG1sfVxuICBgKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFNlY3Rpb246IFByb2dyZXNzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBidWlsZFByb2dyZXNzU2VjdGlvbihkYXRhOiBWaXN1YWxpemVyRGF0YSk6IHN0cmluZyB7XG4gIGlmIChkYXRhLm1pbGVzdG9uZXMubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIHNlY3Rpb24oJ3Byb2dyZXNzJywgJ1Byb2dyZXNzJywgJzxwIGNsYXNzPVwiZW1wdHlcIj5ObyBtaWxlc3RvbmVzIGZvdW5kLjwvcD4nKTtcbiAgfVxuXG4gIGNvbnN0IGNyaXRNUyA9IG5ldyBTZXQoZGF0YS5jcml0aWNhbFBhdGgubWlsZXN0b25lUGF0aCk7XG4gIGNvbnN0IGNyaXRTTCA9IG5ldyBTZXQoZGF0YS5jcml0aWNhbFBhdGguc2xpY2VQYXRoKTtcblxuICBjb25zdCBtc0h0bWwgPSBkYXRhLm1pbGVzdG9uZXMubWFwKG1zID0+IHtcbiAgICBjb25zdCBkb25lQ291bnQgPSBtcy5zbGljZXMuZmlsdGVyKHMgPT4gcy5kb25lKS5sZW5ndGg7XG4gICAgY29uc3Qgb25Dcml0ID0gY3JpdE1TLmhhcyhtcy5pZCk7XG4gICAgY29uc3Qgc2xpY2VIdG1sID0gbXMuc2xpY2VzLmxlbmd0aCA+IDBcbiAgICAgID8gbXMuc2xpY2VzLm1hcChzbCA9PiBidWlsZFNsaWNlUm93KHNsLCBjcml0U0wsIGRhdGEpKS5qb2luKCcnKVxuICAgICAgOiAnPHAgY2xhc3M9XCJlbXB0eSBpbmRlbnRcIj5ObyBzbGljZXMgaW4gcm9hZG1hcCB5ZXQuPC9wPic7XG5cbiAgICByZXR1cm4gYFxuICAgICAgPGRldGFpbHMgY2xhc3M9XCJtcy1ibG9ja1wiICR7bXMuc3RhdHVzICE9PSAncGVuZGluZycgJiYgbXMuc3RhdHVzICE9PSAncGFya2VkJyA/ICdvcGVuJyA6ICcnfT5cbiAgICAgICAgPHN1bW1hcnkgY2xhc3M9XCJtcy1zdW1tYXJ5IG1zLSR7bXMuc3RhdHVzfVwiPlxuICAgICAgICAgIDxzcGFuIGNsYXNzPVwiZG90IGRvdC0ke21zLnN0YXR1c31cIj48L3NwYW4+XG4gICAgICAgICAgPHNwYW4gY2xhc3M9XCJtb25vIG1zLWlkXCI+JHtlc2MobXMuaWQpfTwvc3Bhbj5cbiAgICAgICAgICA8c3BhbiBjbGFzcz1cIm1zLXRpdGxlXCI+JHtlc2MobXMudGl0bGUpfTwvc3Bhbj5cbiAgICAgICAgICA8c3BhbiBjbGFzcz1cIm11dGVkXCI+JHtkb25lQ291bnR9LyR7bXMuc2xpY2VzLmxlbmd0aH08L3NwYW4+XG4gICAgICAgICAgJHtvbkNyaXQgPyAnPHNwYW4gY2xhc3M9XCJsYWJlbFwiPmNyaXRpY2FsIHBhdGg8L3NwYW4+JyA6ICcnfVxuICAgICAgICAgICR7bXMuZGVwZW5kc09uLmxlbmd0aCA+IDAgPyBgPHNwYW4gY2xhc3M9XCJtdXRlZFwiPm5lZWRzICR7bXMuZGVwZW5kc09uLm1hcChlc2MpLmpvaW4oJywgJyl9PC9zcGFuPmAgOiAnJ31cbiAgICAgICAgPC9zdW1tYXJ5PlxuICAgICAgICA8ZGl2IGNsYXNzPVwibXMtYm9keVwiPiR7c2xpY2VIdG1sfTwvZGl2PlxuICAgICAgPC9kZXRhaWxzPmA7XG4gIH0pLmpvaW4oJycpO1xuXG4gIHJldHVybiBzZWN0aW9uKCdwcm9ncmVzcycsICdQcm9ncmVzcycsIG1zSHRtbCk7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkU2xpY2VSb3coc2w6IFZpc3VhbGl6ZXJTbGljZSwgY3JpdFNMOiBTZXQ8c3RyaW5nPiwgZGF0YTogVmlzdWFsaXplckRhdGEpOiBzdHJpbmcge1xuICBjb25zdCBvbkNyaXQgPSBjcml0U0wuaGFzKHNsLmlkKTtcbiAgY29uc3QgdmVyID0gZGF0YS5zbGljZVZlcmlmaWNhdGlvbnMuZmluZCh2ID0+IHYuc2xpY2VJZCA9PT0gc2wuaWQpO1xuICBjb25zdCBzbGFjayA9IGRhdGEuY3JpdGljYWxQYXRoLnNsaWNlU2xhY2suZ2V0KHNsLmlkKTtcbiAgY29uc3Qgc3RhdHVzID0gc2wuZG9uZSA/ICdjb21wbGV0ZScgOiBzbC5hY3RpdmUgPyAnYWN0aXZlJyA6ICdwZW5kaW5nJztcblxuICBjb25zdCB0YXNrSHRtbCA9IHNsLnRhc2tzLmxlbmd0aCA+IDAgPyBgXG4gICAgPHVsIGNsYXNzPVwidGFzay1saXN0XCI+XG4gICAgICAke3NsLnRhc2tzLm1hcCh0ID0+IGBcbiAgICAgICAgPGxpIGNsYXNzPVwidGFzay1yb3dcIj5cbiAgICAgICAgICA8c3BhbiBjbGFzcz1cImRvdCBkb3QtJHt0LmRvbmUgPyAnY29tcGxldGUnIDogdC5hY3RpdmUgPyAnYWN0aXZlJyA6ICdwZW5kaW5nJ30gZG90LXNtXCI+PC9zcGFuPlxuICAgICAgICAgIDxzcGFuIGNsYXNzPVwibW9ubyBtdXRlZFwiPiR7ZXNjKHQuaWQpfTwvc3Bhbj5cbiAgICAgICAgICA8c3BhbiBjbGFzcz1cIiR7dC5kb25lID8gJ211dGVkJyA6ICcnfVwiPiR7ZXNjKHQudGl0bGUpfTwvc3Bhbj5cbiAgICAgICAgICAke3QuZXN0aW1hdGUgPyBgPHNwYW4gY2xhc3M9XCJtdXRlZFwiPiR7ZXNjKHQuZXN0aW1hdGUpfTwvc3Bhbj5gIDogJyd9XG4gICAgICAgIDwvbGk+YCkuam9pbignJyl9XG4gICAgPC91bD5gIDogJyc7XG5cbiAgY29uc3QgdGFncyA9IFtcbiAgICAuLi4odmVyPy5wcm92aWRlcyA/PyBbXSkubWFwKHAgPT4gYDxzcGFuIGNsYXNzPVwidGFnXCI+cHJvdmlkZXM6ICR7ZXNjKHApfTwvc3Bhbj5gKSxcbiAgICAuLi4odmVyPy5yZXF1aXJlcyA/PyBbXSkubWFwKHIgPT4gYDxzcGFuIGNsYXNzPVwidGFnXCI+cmVxdWlyZXM6ICR7ZXNjKHIucHJvdmlkZXMpfTwvc3Bhbj5gKSxcbiAgXS5qb2luKCcnKTtcblxuICBjb25zdCBrZXlEZWNpc2lvbnMgPSB2ZXI/LmtleURlY2lzaW9ucz8ubGVuZ3RoXG4gICAgPyBgPGRpdiBjbGFzcz1cImRldGFpbC1ibG9ja1wiPjxzcGFuIGNsYXNzPVwiZGV0YWlsLWxhYmVsXCI+RGVjaXNpb25zPC9zcGFuPjx1bD4ke3Zlci5rZXlEZWNpc2lvbnMubWFwKGQgPT4gYDxsaT4ke2VzYyhkKX08L2xpPmApLmpvaW4oJycpfTwvdWw+PC9kaXY+YFxuICAgIDogJyc7XG5cbiAgY29uc3QgcGF0dGVybnMgPSB2ZXI/LnBhdHRlcm5zRXN0YWJsaXNoZWQ/Lmxlbmd0aFxuICAgID8gYDxkaXYgY2xhc3M9XCJkZXRhaWwtYmxvY2tcIj48c3BhbiBjbGFzcz1cImRldGFpbC1sYWJlbFwiPlBhdHRlcm5zPC9zcGFuPjx1bD4ke3Zlci5wYXR0ZXJuc0VzdGFibGlzaGVkLm1hcChwID0+IGA8bGk+JHtlc2MocCl9PC9saT5gKS5qb2luKCcnKX08L3VsPjwvZGl2PmBcbiAgICA6ICcnO1xuXG4gIGNvbnN0IHZlcmlmQmFkZ2UgPSB2ZXI/LnZlcmlmaWNhdGlvblJlc3VsdFxuICAgID8gYDxkaXYgY2xhc3M9XCJ2ZXJpZiAke3Zlci5ibG9ja2VyRGlzY292ZXJlZCA/ICd2ZXJpZi1ibG9ja2VyJyA6ICcnfVwiPlxuICAgICAgICAke3Zlci5ibG9ja2VyRGlzY292ZXJlZCA/ICdCbG9ja2VyOiAnIDogJyd9JHtlc2ModmVyLnZlcmlmaWNhdGlvblJlc3VsdCl9XG4gICAgICAgPC9kaXY+YFxuICAgIDogJyc7XG5cbiAgcmV0dXJuIGBcbiAgICA8ZGV0YWlscyBjbGFzcz1cInNsLWJsb2NrXCI+XG4gICAgICA8c3VtbWFyeSBjbGFzcz1cInNsLXN1bW1hcnkgJHtvbkNyaXQgPyAnc2wtY3JpdCcgOiAnJ31cIj5cbiAgICAgICAgPHNwYW4gY2xhc3M9XCJkb3QgZG90LSR7c3RhdHVzfSBkb3Qtc21cIj48L3NwYW4+XG4gICAgICAgIDxzcGFuIGNsYXNzPVwibW9ubyBtdXRlZFwiPiR7ZXNjKHNsLmlkKX08L3NwYW4+XG4gICAgICAgIDxzcGFuIGNsYXNzPVwiJHtzdGF0dXMgPT09ICdhY3RpdmUnID8gJ2FjY2VudCcgOiBzbC5kb25lID8gJ211dGVkJyA6ICcnfVwiPiR7ZXNjKHNsLnRpdGxlKX08L3NwYW4+XG4gICAgICAgIDxzcGFuIGNsYXNzPVwicmlzayByaXNrLSR7KHNsLnJpc2sgfHwgJ3Vua25vd24nKS50b0xvd2VyQ2FzZSgpfVwiPiR7ZXNjKHNsLnJpc2sgfHwgJz8nKX08L3NwYW4+XG4gICAgICAgICR7c2wuZGVwZW5kcy5sZW5ndGggPiAwID8gYDxzcGFuIGNsYXNzPVwibXV0ZWQgc2wtZGVwc1wiPiR7c2wuZGVwZW5kcy5tYXAoZXNjKS5qb2luKCcsICcpfTwvc3Bhbj5gIDogJyd9XG4gICAgICAgICR7b25Dcml0ID8gJzxzcGFuIGNsYXNzPVwibGFiZWxcIj5jcml0aWNhbDwvc3Bhbj4nIDogJyd9XG4gICAgICAgICR7c2xhY2sgIT09IHVuZGVmaW5lZCAmJiBzbGFjayA+IDAgPyBgPHNwYW4gY2xhc3M9XCJtdXRlZFwiPiske3NsYWNrfSBzbGFjazwvc3Bhbj5gIDogJyd9XG4gICAgICA8L3N1bW1hcnk+XG4gICAgICA8ZGl2IGNsYXNzPVwic2wtZGV0YWlsXCI+XG4gICAgICAgICR7dGFncyA/IGA8ZGl2IGNsYXNzPVwidGFnLXJvd1wiPiR7dGFnc308L2Rpdj5gIDogJyd9XG4gICAgICAgICR7dmVyaWZCYWRnZX1cbiAgICAgICAgJHtrZXlEZWNpc2lvbnN9XG4gICAgICAgICR7cGF0dGVybnN9XG4gICAgICAgICR7dGFza0h0bWx9XG4gICAgICA8L2Rpdj5cbiAgICA8L2RldGFpbHM+YDtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFNlY3Rpb246IERlcGVuZGVuY3kgR3JhcGggXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIGJ1aWxkRGVwR3JhcGhTZWN0aW9uKGRhdGE6IFZpc3VhbGl6ZXJEYXRhKTogc3RyaW5nIHtcbiAgY29uc3QgaGFzU2xpY2VzID0gZGF0YS5taWxlc3RvbmVzLnNvbWUobXMgPT4gbXMuc2xpY2VzLmxlbmd0aCA+IDApO1xuICBpZiAoIWhhc1NsaWNlcykgcmV0dXJuIHNlY3Rpb24oJ2RlcGdyYXBoJywgJ0RlcGVuZGVuY2llcycsICc8cCBjbGFzcz1cImVtcHR5XCI+Tm8gc2xpY2VzIHRvIGdyYXBoLjwvcD4nKTtcblxuICBjb25zdCBoYXNEZXBzID0gZGF0YS5taWxlc3RvbmVzLnNvbWUobXMgPT4gbXMuc2xpY2VzLnNvbWUocyA9PiBzLmRlcGVuZHMubGVuZ3RoID4gMCkpO1xuICBpZiAoIWhhc0RlcHMpIHJldHVybiBzZWN0aW9uKCdkZXBncmFwaCcsICdEZXBlbmRlbmNpZXMnLCAnPHAgY2xhc3M9XCJlbXB0eVwiPk5vIGRlcGVuZGVuY2llcyBkZWZpbmVkLjwvcD4nKTtcblxuICBjb25zdCBzdmdzID0gZGF0YS5taWxlc3RvbmVzXG4gICAgLmZpbHRlcihtcyA9PiBtcy5zbGljZXMubGVuZ3RoID4gMClcbiAgICAubWFwKG1zID0+IGJ1aWxkTWlsZXN0b25lRGVwU1ZHKG1zLCBkYXRhKSlcbiAgICAuZmlsdGVyKEJvb2xlYW4pXG4gICAgLmpvaW4oJycpO1xuXG4gIHJldHVybiBzZWN0aW9uKCdkZXBncmFwaCcsICdEZXBlbmRlbmNpZXMnLCBzdmdzKTtcbn1cblxuZnVuY3Rpb24gYnVpbGRNaWxlc3RvbmVEZXBTVkcobXM6IFZpc3VhbGl6ZXJNaWxlc3RvbmUsIGRhdGE6IFZpc3VhbGl6ZXJEYXRhKTogc3RyaW5nIHtcbiAgY29uc3Qgc2xpY2VzID0gbXMuc2xpY2VzO1xuICBpZiAoc2xpY2VzLmxlbmd0aCA9PT0gMCkgcmV0dXJuICcnO1xuXG4gIGNvbnN0IGNyaXRTTCA9IG5ldyBTZXQoZGF0YS5jcml0aWNhbFBhdGguc2xpY2VQYXRoKTtcbiAgY29uc3Qgc2xNYXAgPSBuZXcgTWFwKHNsaWNlcy5tYXAocyA9PiBbcy5pZCwgc10pKTtcblxuICBjb25zdCBsYXllck1hcCA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gIGNvbnN0IGluRGVnID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgZm9yIChjb25zdCBzIG9mIHNsaWNlcykgaW5EZWcuc2V0KHMuaWQsIDApO1xuICBmb3IgKGNvbnN0IHMgb2Ygc2xpY2VzKSB7XG4gICAgZm9yIChjb25zdCBkZXAgb2Ygcy5kZXBlbmRzKSB7XG4gICAgICBpZiAoc2xNYXAuaGFzKGRlcCkpIGluRGVnLnNldChzLmlkLCAoaW5EZWcuZ2V0KHMuaWQpID8/IDApICsgMSk7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgdmlzaXRlZCA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBjb25zdCBxOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IFtpZCwgZF0gb2YgaW5EZWcpIHtcbiAgICBpZiAoZCA9PT0gMCkgeyBxLnB1c2goaWQpOyB2aXNpdGVkLmFkZChpZCk7IGxheWVyTWFwLnNldChpZCwgMCk7IH1cbiAgfVxuXG4gIHdoaWxlIChxLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCBub2RlID0gcS5zaGlmdCgpITtcbiAgICBmb3IgKGNvbnN0IHMgb2Ygc2xpY2VzKSB7XG4gICAgICBpZiAoIXMuZGVwZW5kcy5pbmNsdWRlcyhub2RlKSkgY29udGludWU7XG4gICAgICBjb25zdCBuZXdEZWcgPSAoaW5EZWcuZ2V0KHMuaWQpID8/IDEpIC0gMTtcbiAgICAgIGluRGVnLnNldChzLmlkLCBuZXdEZWcpO1xuICAgICAgbGF5ZXJNYXAuc2V0KHMuaWQsIE1hdGgubWF4KGxheWVyTWFwLmdldChzLmlkKSA/PyAwLCAobGF5ZXJNYXAuZ2V0KG5vZGUpID8/IDApICsgMSkpO1xuICAgICAgaWYgKG5ld0RlZyA9PT0gMCAmJiAhdmlzaXRlZC5oYXMocy5pZCkpIHsgdmlzaXRlZC5hZGQocy5pZCk7IHEucHVzaChzLmlkKTsgfVxuICAgIH1cbiAgfVxuICBmb3IgKGNvbnN0IHMgb2Ygc2xpY2VzKSBpZiAoIWxheWVyTWFwLmhhcyhzLmlkKSkgbGF5ZXJNYXAuc2V0KHMuaWQsIDApO1xuXG4gIGNvbnN0IG1heExheWVyID0gTWF0aC5tYXgoLi4uWy4uLmxheWVyTWFwLnZhbHVlcygpXSk7XG4gIGNvbnN0IGJ5TGF5ZXIgPSBuZXcgTWFwPG51bWJlciwgc3RyaW5nW10+KCk7XG4gIGZvciAoY29uc3QgW2lkLCBsYXllcl0gb2YgbGF5ZXJNYXApIHtcbiAgICBjb25zdCBhcnIgPSBieUxheWVyLmdldChsYXllcikgPz8gW107XG4gICAgYXJyLnB1c2goaWQpO1xuICAgIGJ5TGF5ZXIuc2V0KGxheWVyLCBhcnIpO1xuICB9XG5cbiAgY29uc3QgTlcgPSAxMzAsIE5IID0gNDAsIENHQVAgPSA1NiwgUkdBUCA9IDE0LCBQQUQgPSAyMDtcbiAgbGV0IG1heFJvd3MgPSAwO1xuICBmb3IgKGxldCBjID0gMDsgYyA8PSBtYXhMYXllcjsgYysrKSBtYXhSb3dzID0gTWF0aC5tYXgobWF4Um93cywgKGJ5TGF5ZXIuZ2V0KGMpID8/IFtdKS5sZW5ndGgpO1xuICBjb25zdCB0b3RhbEggPSBQQUQgKiAyICsgbWF4Um93cyAqIE5IICsgTWF0aC5tYXgoMCwgbWF4Um93cyAtIDEpICogUkdBUDtcbiAgY29uc3QgdG90YWxXID0gUEFEICogMiArIChtYXhMYXllciArIDEpICogTlcgKyBtYXhMYXllciAqIENHQVA7XG5cbiAgY29uc3QgcG9zID0gbmV3IE1hcDxzdHJpbmcsIHsgeDogbnVtYmVyOyB5OiBudW1iZXIgfT4oKTtcbiAgZm9yIChsZXQgY29sID0gMDsgY29sIDw9IG1heExheWVyOyBjb2wrKykge1xuICAgIGNvbnN0IGlkcyA9IGJ5TGF5ZXIuZ2V0KGNvbCkgPz8gW107XG4gICAgY29uc3QgY29sSCA9IGlkcy5sZW5ndGggKiBOSCArIE1hdGgubWF4KDAsIGlkcy5sZW5ndGggLSAxKSAqIFJHQVA7XG4gICAgY29uc3Qgc3RhcnRZID0gKHRvdGFsSCAtIGNvbEgpIC8gMjtcbiAgICBpZHMuZm9yRWFjaCgoaWQsIGkpID0+IHBvcy5zZXQoaWQsIHsgeDogUEFEICsgY29sICogKE5XICsgQ0dBUCksIHk6IHN0YXJ0WSArIGkgKiAoTkggKyBSR0FQKSB9KSk7XG4gIH1cblxuICBjb25zdCBlZGdlcyA9IHNsaWNlcy5mbGF0TWFwKHNsID0+IHNsLmRlcGVuZHMuZmxhdE1hcChkZXAgPT4ge1xuICAgIGlmICghcG9zLmhhcyhkZXApIHx8ICFwb3MuaGFzKHNsLmlkKSkgcmV0dXJuIFtdO1xuICAgIGNvbnN0IGYgPSBwb3MuZ2V0KGRlcCkhLCB0ID0gcG9zLmdldChzbC5pZCkhO1xuICAgIGNvbnN0IHgxID0gZi54ICsgTlcsIHkxID0gZi55ICsgTkggLyAyO1xuICAgIGNvbnN0IHgyID0gdC54LCAgICAgICB5MiA9IHQueSArIE5IIC8gMjtcbiAgICBjb25zdCBteCA9ICh4MSArIHgyKSAvIDI7XG4gICAgY29uc3QgY3JpdCA9IGNyaXRTTC5oYXMoc2wuaWQpICYmIGNyaXRTTC5oYXMoZGVwKTtcbiAgICByZXR1cm4gW2A8cGF0aCBkPVwiTSR7eDF9LCR7eTF9IEMke214fSwke3kxfSAke214fSwke3kyfSAke3gyfSwke3kyfVwiIGNsYXNzPVwiZWRnZSR7Y3JpdCA/ICcgZWRnZS1jcml0JyA6ICcnfVwiIG1hcmtlci1lbmQ9XCJ1cmwoI2FyciR7Y3JpdCA/ICctY3JpdCcgOiAnJ30pXCIvPmBdO1xuICB9KSk7XG5cbiAgY29uc3Qgbm9kZXMgPSBzbGljZXMubWFwKHNsID0+IHtcbiAgICBjb25zdCBwID0gcG9zLmdldChzbC5pZCk7XG4gICAgaWYgKCFwKSByZXR1cm4gJyc7XG4gICAgY29uc3QgY3JpdCA9IGNyaXRTTC5oYXMoc2wuaWQpO1xuICAgIGNvbnN0IHNjID0gc2wuZG9uZSA/ICduLWRvbmUnIDogc2wuYWN0aXZlID8gJ24tYWN0aXZlJyA6ICduLXBlbmRpbmcnO1xuICAgIHJldHVybiBgPGcgY2xhc3M9XCJub2RlICR7c2N9JHtjcml0ID8gJyBuLWNyaXQnIDogJyd9XCIgdHJhbnNmb3JtPVwidHJhbnNsYXRlKCR7cC54fSwke3AueX0pXCI+XG4gICAgICA8cmVjdCB3aWR0aD1cIiR7Tld9XCIgaGVpZ2h0PVwiJHtOSH1cIiByeD1cIjRcIi8+XG4gICAgICA8dGV4dCB4PVwiJHtOVy8yfVwiIHk9XCIxNlwiIGNsYXNzPVwibi1pZFwiPiR7ZXNjKHRydW5jU3RyKHNsLmlkLCAxOCkpfTwvdGV4dD5cbiAgICAgIDx0ZXh0IHg9XCIke05XLzJ9XCIgeT1cIjMwXCIgY2xhc3M9XCJuLXRpdGxlXCI+JHtlc2ModHJ1bmNTdHIoc2wudGl0bGUsIDE4KSl9PC90ZXh0PlxuICAgICAgPHRpdGxlPiR7ZXNjKHNsLmlkKX06ICR7ZXNjKHNsLnRpdGxlKX08L3RpdGxlPlxuICAgIDwvZz5gO1xuICB9KTtcblxuICBjb25zdCBsZWdlbmQgPSBgPGRpdiBjbGFzcz1cImRlcC1sZWdlbmRcIj5cbiAgICA8c3Bhbj48c3BhbiBjbGFzcz1cImRvdCBkb3QtY29tcGxldGUgZG90LXNtXCI+PC9zcGFuPiBkb25lPC9zcGFuPlxuICAgIDxzcGFuPjxzcGFuIGNsYXNzPVwiZG90IGRvdC1hY3RpdmUgZG90LXNtXCI+PC9zcGFuPiBhY3RpdmU8L3NwYW4+XG4gICAgPHNwYW4+PHNwYW4gY2xhc3M9XCJkb3QgZG90LXBlbmRpbmcgZG90LXNtXCI+PC9zcGFuPiBwZW5kaW5nPC9zcGFuPlxuICAgIDxzcGFuPjxzcGFuIGNsYXNzPVwiZG90IGRvdC1wYXJrZWQgZG90LXNtXCI+PC9zcGFuPiBwYXJrZWQ8L3NwYW4+XG4gIDwvZGl2PmA7XG5cbiAgcmV0dXJuIGBcbiAgICA8ZGl2IGNsYXNzPVwiZGVwLWJsb2NrXCI+XG4gICAgICA8aDM+JHtlc2MobXMuaWQpfTogJHtlc2MobXMudGl0bGUpfTwvaDM+XG4gICAgICAke2xlZ2VuZH1cbiAgICAgIDxkaXYgY2xhc3M9XCJkZXAtd3JhcFwiPlxuICAgICAgICA8c3ZnIGNsYXNzPVwiZGVwLXN2Z1wiIHZpZXdCb3g9XCIwIDAgJHt0b3RhbFd9ICR7dG90YWxIfVwiIHdpZHRoPVwiJHt0b3RhbFd9XCIgaGVpZ2h0PVwiJHt0b3RhbEh9XCI+XG4gICAgICAgICAgPGRlZnM+XG4gICAgICAgICAgICA8bWFya2VyIGlkPVwiYXJyXCIgbWFya2VyV2lkdGg9XCI4XCIgbWFya2VySGVpZ2h0PVwiOFwiIHJlZlg9XCI3XCIgcmVmWT1cIjNcIiBvcmllbnQ9XCJhdXRvXCI+XG4gICAgICAgICAgICAgIDxwYXRoIGQ9XCJNMCwwIEwwLDYgTDgsMyB6XCIgZmlsbD1cInZhcigtLWJvcmRlci0yKVwiLz5cbiAgICAgICAgICAgIDwvbWFya2VyPlxuICAgICAgICAgICAgPG1hcmtlciBpZD1cImFyci1jcml0XCIgbWFya2VyV2lkdGg9XCI4XCIgbWFya2VySGVpZ2h0PVwiOFwiIHJlZlg9XCI3XCIgcmVmWT1cIjNcIiBvcmllbnQ9XCJhdXRvXCI+XG4gICAgICAgICAgICAgIDxwYXRoIGQ9XCJNMCwwIEwwLDYgTDgsMyB6XCIgZmlsbD1cInZhcigtLWFjY2VudClcIi8+XG4gICAgICAgICAgICA8L21hcmtlcj5cbiAgICAgICAgICA8L2RlZnM+XG4gICAgICAgICAgJHtlZGdlcy5qb2luKCcnKX1cbiAgICAgICAgICAke25vZGVzLmpvaW4oJycpfVxuICAgICAgICA8L3N2Zz5cbiAgICAgIDwvZGl2PlxuICAgIDwvZGl2PmA7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTZWN0aW9uOiBNZXRyaWNzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBidWlsZE1ldHJpY3NTZWN0aW9uKGRhdGE6IFZpc3VhbGl6ZXJEYXRhKTogc3RyaW5nIHtcbiAgaWYgKCFkYXRhLnRvdGFscykgcmV0dXJuIHNlY3Rpb24oJ21ldHJpY3MnLCAnTWV0cmljcycsICc8cCBjbGFzcz1cImVtcHR5XCI+Tm8gbWV0cmljcyBkYXRhIHlldC48L3A+Jyk7XG4gIGNvbnN0IHQgPSBkYXRhLnRvdGFscztcblxuICBjb25zdCBncmlkID0gW1xuICAgIGt2aSgnVG90YWwgY29zdCcsIGZvcm1hdENvc3QodC5jb3N0KSksXG4gICAga3ZpKCdUb3RhbCB0b2tlbnMnLCBmb3JtYXRUb2tlbkNvdW50KHQudG9rZW5zLnRvdGFsKSksXG4gICAga3ZpKCdJbnB1dCcsIGZvcm1hdFRva2VuQ291bnQodC50b2tlbnMuaW5wdXQpKSxcbiAgICBrdmkoJ091dHB1dCcsIGZvcm1hdFRva2VuQ291bnQodC50b2tlbnMub3V0cHV0KSksXG4gICAga3ZpKCdDYWNoZSByZWFkJywgZm9ybWF0VG9rZW5Db3VudCh0LnRva2Vucy5jYWNoZVJlYWQpKSxcbiAgICBrdmkoJ0NhY2hlIHdyaXRlJywgZm9ybWF0VG9rZW5Db3VudCh0LnRva2Vucy5jYWNoZVdyaXRlKSksXG4gICAga3ZpKCdEdXJhdGlvbicsIGZvcm1hdER1cmF0aW9uKHQuZHVyYXRpb24pKSxcbiAgICBrdmkoJ1VuaXRzJywgU3RyaW5nKHQudW5pdHMpKSxcbiAgICBrdmkoJ1Rvb2wgY2FsbHMnLCBTdHJpbmcodC50b29sQ2FsbHMpKSxcbiAgICBrdmkoJ1RydW5jYXRpb25zJywgU3RyaW5nKHQudG90YWxUcnVuY2F0aW9uU2VjdGlvbnMpKSxcbiAgXS5qb2luKCcnKTtcblxuICBjb25zdCB0b2tlbkJyZWFrZG93biA9IGJ1aWxkVG9rZW5CcmVha2Rvd24odC50b2tlbnMpO1xuXG4gIGNvbnN0IHBoYXNlUm93ID0gZGF0YS5ieVBoYXNlLmxlbmd0aCA+IDAgPyBgXG4gICAgPGRpdiBjbGFzcz1cImNoYXJ0LXJvd1wiPlxuICAgICAgJHtidWlsZEJhckNoYXJ0KCdDb3N0IGJ5IHBoYXNlJywgZGF0YS5ieVBoYXNlLm1hcChwID0+ICh7XG4gICAgICAgIGxhYmVsOiBwLnBoYXNlLCB2YWx1ZTogcC5jb3N0LCBkaXNwbGF5OiBmb3JtYXRDb3N0KHAuY29zdCksIHN1YjogYCR7cC51bml0c30gdW5pdHNgLFxuICAgICAgfSkpKX1cbiAgICAgICR7YnVpbGRCYXJDaGFydCgnVG9rZW5zIGJ5IHBoYXNlJywgZGF0YS5ieVBoYXNlLm1hcChwID0+ICh7XG4gICAgICAgIGxhYmVsOiBwLnBoYXNlLCB2YWx1ZTogcC50b2tlbnMudG90YWwsIGRpc3BsYXk6IGZvcm1hdFRva2VuQ291bnQocC50b2tlbnMudG90YWwpLCBzdWI6IGZvcm1hdENvc3QocC5jb3N0KSxcbiAgICAgIH0pKSl9XG4gICAgPC9kaXY+YCA6ICcnO1xuXG4gIGNvbnN0IHNsaWNlTW9kZWxSb3cgPSAoZGF0YS5ieVNsaWNlLmxlbmd0aCA+IDAgfHwgZGF0YS5ieU1vZGVsLmxlbmd0aCA+IDApID8gYFxuICAgIDxkaXYgY2xhc3M9XCJjaGFydC1yb3dcIj5cbiAgICAgICR7ZGF0YS5ieVNsaWNlLmxlbmd0aCA+IDAgPyBidWlsZEJhckNoYXJ0KCdDb3N0IGJ5IHNsaWNlJywgZGF0YS5ieVNsaWNlLm1hcChzID0+ICh7XG4gICAgICAgIGxhYmVsOiBzLnNsaWNlSWQsIHZhbHVlOiBzLmNvc3QsIGRpc3BsYXk6IGZvcm1hdENvc3Qocy5jb3N0KSxcbiAgICAgICAgc3ViOiBgJHtzLnVuaXRzfSB1bml0c2AsXG4gICAgICB9KSkpIDogJyd9XG4gICAgICAke2RhdGEuYnlNb2RlbC5sZW5ndGggPiAwID8gYnVpbGRCYXJDaGFydCgnQ29zdCBieSBtb2RlbCcsIGRhdGEuYnlNb2RlbC5tYXAobSA9PiAoe1xuICAgICAgICBsYWJlbDogc2hvcnRNb2RlbChtLm1vZGVsKSwgdmFsdWU6IG0uY29zdCwgZGlzcGxheTogZm9ybWF0Q29zdChtLmNvc3QpLFxuICAgICAgICBzdWI6IGAke20udW5pdHN9IHVuaXRzYCxcbiAgICAgIH0pKSkgOiAnJ31cbiAgICAgICR7ZGF0YS5ieVNsaWNlLmxlbmd0aCA+IDAgPyBidWlsZEJhckNoYXJ0KCdEdXJhdGlvbiBieSBzbGljZScsIGRhdGEuYnlTbGljZS5tYXAocyA9PiAoe1xuICAgICAgICBsYWJlbDogcy5zbGljZUlkLCB2YWx1ZTogcy5kdXJhdGlvbiwgZGlzcGxheTogZm9ybWF0RHVyYXRpb24ocy5kdXJhdGlvbiksXG4gICAgICAgIHN1YjogZm9ybWF0Q29zdChzLmNvc3QpLFxuICAgICAgfSkpKSA6ICcnfVxuICAgIDwvZGl2PmAgOiAnJztcblxuICBjb25zdCBjb3N0T3ZlclRpbWUgPSBidWlsZENvc3RPdmVyVGltZUNoYXJ0KGRhdGEudW5pdHMpO1xuICBjb25zdCBidWRnZXRCdXJuZG93biA9IGJ1aWxkQnVkZ2V0QnVybmRvd24oZGF0YSk7XG4gIGNvbnN0IGdhbnR0ID0gYnVpbGRTbGljZUdhbnR0KGRhdGEpO1xuXG4gIHJldHVybiBzZWN0aW9uKCdtZXRyaWNzJywgJ01ldHJpY3MnLCBgXG4gICAgPGRpdiBjbGFzcz1cImt2LWdyaWRcIj4ke2dyaWR9PC9kaXY+XG4gICAgJHtidWRnZXRCdXJuZG93bn1cbiAgICAke3Rva2VuQnJlYWtkb3dufVxuICAgICR7Y29zdE92ZXJUaW1lfVxuICAgICR7cGhhc2VSb3d9XG4gICAgJHtzbGljZU1vZGVsUm93fVxuICAgICR7Z2FudHR9XG4gIGApO1xufVxuXG5mdW5jdGlvbiBidWlsZENvc3RPdmVyVGltZUNoYXJ0KHVuaXRzOiBVbml0TWV0cmljc1tdKTogc3RyaW5nIHtcbiAgaWYgKHVuaXRzLmxlbmd0aCA8IDIpIHJldHVybiAnJztcbiAgY29uc3Qgc29ydGVkID0gWy4uLnVuaXRzXS5zb3J0KChhLCBiKSA9PiBhLnN0YXJ0ZWRBdCAtIGIuc3RhcnRlZEF0KTtcbiAgY29uc3QgY3VtdWxhdGl2ZTogbnVtYmVyW10gPSBbXTtcbiAgbGV0IHJ1bm5pbmcgPSAwO1xuICBmb3IgKGNvbnN0IHUgb2Ygc29ydGVkKSB7XG4gICAgcnVubmluZyArPSB1LmNvc3Q7XG4gICAgY3VtdWxhdGl2ZS5wdXNoKHJ1bm5pbmcpO1xuICB9XG5cbiAgY29uc3QgcGFkTCA9IDUwLCBwYWRSID0gMzAsIHBhZFQgPSAyMCwgcGFkQiA9IDMwO1xuICBjb25zdCB3ID0gNjAwLCBoID0gMjAwO1xuICBjb25zdCBwbG90VyA9IHcgLSBwYWRMIC0gcGFkUjtcbiAgY29uc3QgcGxvdEggPSBoIC0gcGFkVCAtIHBhZEI7XG4gIGNvbnN0IG1heENvc3QgPSBjdW11bGF0aXZlW2N1bXVsYXRpdmUubGVuZ3RoIC0gMV0gfHwgMTtcbiAgY29uc3QgbiA9IGN1bXVsYXRpdmUubGVuZ3RoO1xuXG4gIGNvbnN0IHBvaW50cyA9IGN1bXVsYXRpdmUubWFwKChjLCBpKSA9PiB7XG4gICAgY29uc3QgeCA9IHBhZEwgKyAoaSAvIChuIC0gMSkpICogcGxvdFc7XG4gICAgY29uc3QgeSA9IHBhZFQgKyBwbG90SCAtIChjIC8gbWF4Q29zdCkgKiBwbG90SDtcbiAgICByZXR1cm4geyB4LCB5IH07XG4gIH0pO1xuXG4gIGNvbnN0IGxpbmVQYXRoID0gcG9pbnRzLm1hcCgocCwgaSkgPT4gYCR7aSA9PT0gMCA/ICdNJyA6ICdMJ30ke3AueC50b0ZpeGVkKDEpfSwke3AueS50b0ZpeGVkKDEpfWApLmpvaW4oJyAnKTtcbiAgY29uc3QgYXJlYVBhdGggPSBgJHtsaW5lUGF0aH0gTCR7cG9pbnRzW3BvaW50cy5sZW5ndGggLSAxXS54LnRvRml4ZWQoMSl9LCR7KHBhZFQgKyBwbG90SCkudG9GaXhlZCgxKX0gTCR7cG9pbnRzWzBdLngudG9GaXhlZCgxKX0sJHsocGFkVCArIHBsb3RIKS50b0ZpeGVkKDEpfSBaYDtcblxuICBjb25zdCBncmlkTGluZXM6IHN0cmluZ1tdID0gW107XG4gIGZvciAobGV0IGkgPSAwOyBpIDw9IDQ7IGkrKykge1xuICAgIGNvbnN0IHkgPSBwYWRUICsgKHBsb3RIIC8gNCkgKiBpO1xuICAgIGNvbnN0IHZhbCA9IGZvcm1hdENvc3QobWF4Q29zdCAqICgxIC0gaSAvIDQpKTtcbiAgICBncmlkTGluZXMucHVzaChgPGxpbmUgeDE9XCIke3BhZEx9XCIgeTE9XCIke3l9XCIgeDI9XCIke3cgLSBwYWRSfVwiIHkyPVwiJHt5fVwiIGNsYXNzPVwiY29zdC1ncmlkXCIvPmApO1xuICAgIGdyaWRMaW5lcy5wdXNoKGA8dGV4dCB4PVwiJHtwYWRMIC0gNH1cIiB5PVwiJHt5ICsgM31cIiBjbGFzcz1cImNvc3QtYXhpc1wiIHRleHQtYW5jaG9yPVwiZW5kXCI+JHt2YWx9PC90ZXh0PmApO1xuICB9XG5cbiAgcmV0dXJuIGBcbiAgICA8ZGl2IGNsYXNzPVwidG9rZW4tYmxvY2tcIj5cbiAgICAgIDxoMz5Db3N0IG92ZXIgdGltZTwvaDM+XG4gICAgICA8c3ZnIGNsYXNzPVwiY29zdC1zdmdcIiB2aWV3Qm94PVwiMCAwICR7d30gJHtofVwiIHdpZHRoPVwiJHt3fVwiIGhlaWdodD1cIiR7aH1cIj5cbiAgICAgICAgJHtncmlkTGluZXMuam9pbignJyl9XG4gICAgICAgIDxwYXRoIGQ9XCIke2FyZWFQYXRofVwiIGNsYXNzPVwiY29zdC1hcmVhXCIvPlxuICAgICAgICA8cGF0aCBkPVwiJHtsaW5lUGF0aH1cIiBjbGFzcz1cImNvc3QtbGluZVwiLz5cbiAgICAgICAgPHRleHQgeD1cIiR7cGFkTH1cIiB5PVwiJHtoIC0gNH1cIiBjbGFzcz1cImNvc3QtYXhpc1wiPiMxPC90ZXh0PlxuICAgICAgICA8dGV4dCB4PVwiJHt3IC0gcGFkUn1cIiB5PVwiJHtoIC0gNH1cIiBjbGFzcz1cImNvc3QtYXhpc1wiIHRleHQtYW5jaG9yPVwiZW5kXCI+IyR7bn08L3RleHQ+XG4gICAgICA8L3N2Zz5cbiAgICA8L2Rpdj5gO1xufVxuXG5mdW5jdGlvbiBidWlsZEJ1ZGdldEJ1cm5kb3duKGRhdGE6IFZpc3VhbGl6ZXJEYXRhKTogc3RyaW5nIHtcbiAgaWYgKCFkYXRhLmhlYWx0aC5idWRnZXRDZWlsaW5nKSByZXR1cm4gJyc7XG4gIGNvbnN0IGNlaWxpbmcgPSBkYXRhLmhlYWx0aC5idWRnZXRDZWlsaW5nO1xuICBjb25zdCBzcGVudCA9IGRhdGEudG90YWxzPy5jb3N0ID8/IDA7XG4gIGNvbnN0IHRvdGFsU2xpY2VzID0gZGF0YS5taWxlc3RvbmVzLnJlZHVjZSgocywgbSkgPT4gcyArIG0uc2xpY2VzLmxlbmd0aCwgMCk7XG4gIGNvbnN0IGRvbmVTbGljZXMgPSBkYXRhLm1pbGVzdG9uZXMucmVkdWNlKChzLCBtKSA9PiBzICsgbS5zbGljZXMuZmlsdGVyKHNsID0+IHNsLmRvbmUpLmxlbmd0aCwgMCk7XG4gIGNvbnN0IGF2Z0Nvc3RQZXJTbGljZSA9IGRvbmVTbGljZXMgPiAwID8gc3BlbnQgLyBkb25lU2xpY2VzIDogMDtcbiAgY29uc3QgcHJvamVjdGVkID0gYXZnQ29zdFBlclNsaWNlID4gMCA/IGF2Z0Nvc3RQZXJTbGljZSAqIGRhdGEucmVtYWluaW5nU2xpY2VDb3VudCArIHNwZW50IDogc3BlbnQ7XG4gIGNvbnN0IG1heFZhbCA9IE1hdGgubWF4KGNlaWxpbmcsIHByb2plY3RlZCwgc3BlbnQpO1xuXG4gIGNvbnN0IHNwZW50UGN0ID0gKHNwZW50IC8gbWF4VmFsKSAqIDEwMDtcbiAgY29uc3QgcHJvamVjdGVkUmVtUGN0ID0gTWF0aC5tYXgoMCwgKChwcm9qZWN0ZWQgLSBzcGVudCkgLyBtYXhWYWwpICogMTAwKTtcbiAgY29uc3Qgb3ZlcnNob290ID0gcHJvamVjdGVkID4gY2VpbGluZyA/ICgocHJvamVjdGVkIC0gY2VpbGluZykgLyBtYXhWYWwpICogMTAwIDogMDtcbiAgY29uc3QgcHJvamVjdGVkQ2xlYW4gPSBwcm9qZWN0ZWRSZW1QY3QgLSBvdmVyc2hvb3Q7XG5cbiAgY29uc3QgbGVnZW5kID0gW1xuICAgIGA8c3Bhbj48c3BhbiBjbGFzcz1cImJ1cm5kb3duLWRvdFwiIHN0eWxlPVwiYmFja2dyb3VuZDp2YXIoLS1hY2NlbnQpXCI+PC9zcGFuPiBTcGVudDogJHtmb3JtYXRDb3N0KHNwZW50KX08L3NwYW4+YCxcbiAgICBgPHNwYW4+PHNwYW4gY2xhc3M9XCJidXJuZG93bi1kb3RcIiBzdHlsZT1cImJhY2tncm91bmQ6dmFyKC0tY2F1dGlvbilcIj48L3NwYW4+IFByb2plY3RlZCByZW1haW5pbmc6ICR7Zm9ybWF0Q29zdChNYXRoLm1heCgwLCBwcm9qZWN0ZWQgLSBzcGVudCkpfTwvc3Bhbj5gLFxuICAgIGA8c3Bhbj48c3BhbiBjbGFzcz1cImJ1cm5kb3duLWRvdFwiIHN0eWxlPVwiYmFja2dyb3VuZDp2YXIoLS1ib3JkZXItMilcIj48L3NwYW4+IENlaWxpbmc6ICR7Zm9ybWF0Q29zdChjZWlsaW5nKX08L3NwYW4+YCxcbiAgICBvdmVyc2hvb3QgPiAwID8gYDxzcGFuPjxzcGFuIGNsYXNzPVwiYnVybmRvd24tZG90XCIgc3R5bGU9XCJiYWNrZ3JvdW5kOnZhcigtLXdhcm4pXCI+PC9zcGFuPiBPdmVyc2hvb3Q6ICR7Zm9ybWF0Q29zdChwcm9qZWN0ZWQgLSBjZWlsaW5nKX08L3NwYW4+YCA6ICcnLFxuICBdLmZpbHRlcihCb29sZWFuKS5qb2luKCcnKTtcblxuICByZXR1cm4gYFxuICAgIDxkaXYgY2xhc3M9XCJidXJuZG93bi13cmFwXCI+XG4gICAgICA8aDM+QnVkZ2V0IGJ1cm5kb3duPC9oMz5cbiAgICAgIDxkaXYgY2xhc3M9XCJidXJuZG93bi1iYXJcIj5cbiAgICAgICAgPGRpdiBjbGFzcz1cImJ1cm5kb3duLXNwZW50XCIgc3R5bGU9XCJ3aWR0aDoke3NwZW50UGN0LnRvRml4ZWQoMSl9JVwiPjwvZGl2PlxuICAgICAgICAke3Byb2plY3RlZENsZWFuID4gMCA/IGA8ZGl2IGNsYXNzPVwiYnVybmRvd24tcHJvamVjdGVkXCIgc3R5bGU9XCJ3aWR0aDoke3Byb2plY3RlZENsZWFuLnRvRml4ZWQoMSl9JVwiPjwvZGl2PmAgOiAnJ31cbiAgICAgICAgJHtvdmVyc2hvb3QgPiAwID8gYDxkaXYgY2xhc3M9XCJidXJuZG93bi1vdmVyc2hvb3RcIiBzdHlsZT1cIndpZHRoOiR7b3ZlcnNob290LnRvRml4ZWQoMSl9JVwiPjwvZGl2PmAgOiAnJ31cbiAgICAgIDwvZGl2PlxuICAgICAgPGRpdiBjbGFzcz1cImJ1cm5kb3duLWxlZ2VuZFwiPiR7bGVnZW5kfTwvZGl2PlxuICAgIDwvZGl2PmA7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkU2xpY2VHYW50dChkYXRhOiBWaXN1YWxpemVyRGF0YSk6IHN0cmluZyB7XG4gIGNvbnN0IHNsaWNlVGltaW5ncyA9IG5ldyBNYXA8c3RyaW5nLCB7IG1pbjogbnVtYmVyOyBtYXg6IG51bWJlciB9PigpO1xuICBmb3IgKGNvbnN0IHUgb2YgZGF0YS51bml0cykge1xuICAgIGNvbnN0IHBhcnRzID0gdS5pZC5zcGxpdCgnLycpO1xuICAgIGNvbnN0IHNsaWNlS2V5ID0gcGFydHMubGVuZ3RoID49IDIgPyBgJHtwYXJ0c1swXX0vJHtwYXJ0c1sxXX1gIDogdS5pZDtcbiAgICBpZiAodS5zdGFydGVkQXQgPD0gMCkgY29udGludWU7XG4gICAgY29uc3QgZXhpc3RpbmcgPSBzbGljZVRpbWluZ3MuZ2V0KHNsaWNlS2V5KTtcbiAgICBjb25zdCBlbmQgPSB1LmZpbmlzaGVkQXQgPiAwID8gdS5maW5pc2hlZEF0IDogRGF0ZS5ub3coKTtcbiAgICBpZiAoZXhpc3RpbmcpIHtcbiAgICAgIGV4aXN0aW5nLm1pbiA9IE1hdGgubWluKGV4aXN0aW5nLm1pbiwgdS5zdGFydGVkQXQpO1xuICAgICAgZXhpc3RpbmcubWF4ID0gTWF0aC5tYXgoZXhpc3RpbmcubWF4LCBlbmQpO1xuICAgIH0gZWxzZSB7XG4gICAgICBzbGljZVRpbWluZ3Muc2V0KHNsaWNlS2V5LCB7IG1pbjogdS5zdGFydGVkQXQsIG1heDogZW5kIH0pO1xuICAgIH1cbiAgfVxuXG4gIGlmIChzbGljZVRpbWluZ3Muc2l6ZSA8IDIpIHJldHVybiAnJztcblxuICBjb25zdCBzbGljZUVudHJpZXMgPSBbLi4uc2xpY2VUaW1pbmdzLmVudHJpZXMoKV0uc29ydCgoYSwgYikgPT4gYVsxXS5taW4gLSBiWzFdLm1pbik7XG4gIGNvbnN0IGdsb2JhbE1pbiA9IE1hdGgubWluKC4uLnNsaWNlRW50cmllcy5tYXAoZSA9PiBlWzFdLm1pbikpO1xuICBjb25zdCBnbG9iYWxNYXggPSBNYXRoLm1heCguLi5zbGljZUVudHJpZXMubWFwKGUgPT4gZVsxXS5tYXgpKTtcbiAgY29uc3QgcmFuZ2UgPSBnbG9iYWxNYXggLSBnbG9iYWxNaW4gfHwgMTtcblxuICBjb25zdCBzbGljZUNvdW50ID0gc2xpY2VFbnRyaWVzLmxlbmd0aDtcbiAgY29uc3QgYmFySCA9IDE4LCByb3dIID0gMzAsIHBhZEwgPSAxNDAsIHBhZFIgPSAyMCwgcGFkVCA9IDMwLCBwYWRCID0gMzA7XG4gIGNvbnN0IHBsb3RXID0gNzAwIC0gcGFkTCAtIHBhZFI7XG4gIGNvbnN0IHN2Z0ggPSBzbGljZUNvdW50ICogcm93SCArIHBhZFQgKyBwYWRCO1xuXG4gIC8vIEJ1aWxkIGEgbG9va3VwIG9mIHNsaWNlIHN0YXR1c1xuICBjb25zdCBzbGljZVN0YXR1c01hcCA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gIGZvciAoY29uc3QgbXMgb2YgZGF0YS5taWxlc3RvbmVzKSB7XG4gICAgZm9yIChjb25zdCBzbCBvZiBtcy5zbGljZXMpIHtcbiAgICAgIGNvbnN0IGtleSA9IGAke21zLmlkfS8ke3NsLmlkfWA7XG4gICAgICBzbGljZVN0YXR1c01hcC5zZXQoa2V5LCBzbC5kb25lID8gJ2RvbmUnIDogc2wuYWN0aXZlID8gJ2FjdGl2ZScgOiAncGVuZGluZycpO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IGJhcnMgPSBzbGljZUVudHJpZXMubWFwKChbc2xpY2VJZCwgdGltaW5nXSwgaSkgPT4ge1xuICAgIGNvbnN0IHggPSBwYWRMICsgKCh0aW1pbmcubWluIC0gZ2xvYmFsTWluKSAvIHJhbmdlKSAqIHBsb3RXO1xuICAgIGNvbnN0IHcgPSBNYXRoLm1heCgyLCAoKHRpbWluZy5tYXggLSB0aW1pbmcubWluKSAvIHJhbmdlKSAqIHBsb3RXKTtcbiAgICBjb25zdCB5ID0gcGFkVCArIGkgKiByb3dIICsgKHJvd0ggLSBiYXJIKSAvIDI7XG4gICAgY29uc3Qgc3RhdHVzID0gc2xpY2VTdGF0dXNNYXAuZ2V0KHNsaWNlSWQpID8/ICdwZW5kaW5nJztcbiAgICByZXR1cm4gYDx0ZXh0IHg9XCIke3BhZEwgLSA2fVwiIHk9XCIke3kgKyBiYXJIIC8gMiArIDR9XCIgY2xhc3M9XCJnYW50dC1sYWJlbFwiIHRleHQtYW5jaG9yPVwiZW5kXCI+JHtlc2ModHJ1bmNTdHIoc2xpY2VJZCwgMTgpKX08L3RleHQ+XG4gICAgICA8cmVjdCB4PVwiJHt4LnRvRml4ZWQoMSl9XCIgeT1cIiR7eS50b0ZpeGVkKDEpfVwiIHdpZHRoPVwiJHt3LnRvRml4ZWQoMSl9XCIgaGVpZ2h0PVwiJHtiYXJIfVwiIHJ4PVwiMlwiIGNsYXNzPVwiZ2FudHQtYmFyLSR7c3RhdHVzfVwiPjx0aXRsZT4ke2VzYyhzbGljZUlkKX06ICR7Zm9ybWF0RHVyYXRpb24odGltaW5nLm1heCAtIHRpbWluZy5taW4pfTwvdGl0bGU+PC9yZWN0PmA7XG4gIH0pLmpvaW4oJ1xcbicpO1xuXG4gIC8vIFRpbWUgYXhpcyBsYWJlbHNcbiAgY29uc3QgYXhpc0xhYmVscyA9IFswLCAwLjI1LCAwLjUsIDAuNzUsIDFdLm1hcChmcmFjID0+IHtcbiAgICBjb25zdCB0ID0gZ2xvYmFsTWluICsgZnJhYyAqIHJhbmdlO1xuICAgIGNvbnN0IHggPSBwYWRMICsgZnJhYyAqIHBsb3RXO1xuICAgIHJldHVybiBgPHRleHQgeD1cIiR7eC50b0ZpeGVkKDEpfVwiIHk9XCIke3N2Z0ggLSA4fVwiIGNsYXNzPVwiZ2FudHQtYXhpc1wiIHRleHQtYW5jaG9yPVwibWlkZGxlXCI+JHtmb3JtYXREYXRlU2hvcnQobmV3IERhdGUodCkudG9JU09TdHJpbmcoKSl9PC90ZXh0PmA7XG4gIH0pLmpvaW4oJycpO1xuXG4gIHJldHVybiBgXG4gICAgPGRpdiBjbGFzcz1cImdhbnR0LXdyYXBcIj5cbiAgICAgIDxoMz5TbGljZSB0aW1lbGluZTwvaDM+XG4gICAgICA8c3ZnIGNsYXNzPVwiZ2FudHQtc3ZnXCIgdmlld0JveD1cIjAgMCA3MDAgJHtzdmdIfVwiIHdpZHRoPVwiNzAwXCIgaGVpZ2h0PVwiJHtzdmdIfVwiPlxuICAgICAgICAke2JhcnN9XG4gICAgICAgICR7YXhpc0xhYmVsc31cbiAgICAgIDwvc3ZnPlxuICAgIDwvZGl2PmA7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkVG9rZW5CcmVha2Rvd24odG9rZW5zOiB7IGlucHV0OiBudW1iZXI7IG91dHB1dDogbnVtYmVyOyBjYWNoZVJlYWQ6IG51bWJlcjsgY2FjaGVXcml0ZTogbnVtYmVyOyB0b3RhbDogbnVtYmVyIH0pOiBzdHJpbmcge1xuICBpZiAodG9rZW5zLnRvdGFsID09PSAwKSByZXR1cm4gJyc7XG4gIGNvbnN0IHNlZ3MgPSBbXG4gICAgeyBsYWJlbDogJ0lucHV0JywgICAgICAgdmFsdWU6IHRva2Vucy5pbnB1dCwgICAgICBjbHM6ICdzZWctMScgfSxcbiAgICB7IGxhYmVsOiAnT3V0cHV0JywgICAgICB2YWx1ZTogdG9rZW5zLm91dHB1dCwgICAgIGNsczogJ3NlZy0yJyB9LFxuICAgIHsgbGFiZWw6ICdDYWNoZSByZWFkJywgIHZhbHVlOiB0b2tlbnMuY2FjaGVSZWFkLCAgY2xzOiAnc2VnLTMnIH0sXG4gICAgeyBsYWJlbDogJ0NhY2hlIHdyaXRlJywgdmFsdWU6IHRva2Vucy5jYWNoZVdyaXRlLCBjbHM6ICdzZWctNCcgfSxcbiAgXS5maWx0ZXIocyA9PiBzLnZhbHVlID4gMCk7XG5cbiAgY29uc3QgYmFycyA9IHNlZ3MubWFwKHMgPT4ge1xuICAgIGNvbnN0IHBjdCA9IChzLnZhbHVlIC8gdG9rZW5zLnRvdGFsKSAqIDEwMDtcbiAgICByZXR1cm4gYDxkaXYgY2xhc3M9XCJ0c2VnICR7cy5jbHN9XCIgc3R5bGU9XCJ3aWR0aDoke3BjdC50b0ZpeGVkKDIpfSVcIiB0aXRsZT1cIiR7cy5sYWJlbH06ICR7Zm9ybWF0VG9rZW5Db3VudChzLnZhbHVlKX0gKCR7cGN0LnRvRml4ZWQoMSl9JSlcIj48L2Rpdj5gO1xuICB9KS5qb2luKCcnKTtcblxuICBjb25zdCBsZWdlbmQgPSBzZWdzLm1hcChzID0+IHtcbiAgICBjb25zdCBwY3QgPSAoKHMudmFsdWUgLyB0b2tlbnMudG90YWwpICogMTAwKS50b0ZpeGVkKDEpO1xuICAgIHJldHVybiBgPHNwYW4gY2xhc3M9XCJsZWctaXRlbVwiPjxzcGFuIGNsYXNzPVwibGVnLWRvdCAke3MuY2xzfVwiPjwvc3Bhbj4ke3MubGFiZWx9OiAke2Zvcm1hdFRva2VuQ291bnQocy52YWx1ZSl9ICgke3BjdH0lKTwvc3Bhbj5gO1xuICB9KS5qb2luKCcnKTtcblxuICByZXR1cm4gYFxuICAgIDxkaXYgY2xhc3M9XCJ0b2tlbi1ibG9ja1wiPlxuICAgICAgPGgzPlRva2VuIGJyZWFrZG93bjwvaDM+XG4gICAgICA8ZGl2IGNsYXNzPVwidG9rZW4tYmFyXCI+JHtiYXJzfTwvZGl2PlxuICAgICAgPGRpdiBjbGFzcz1cInRva2VuLWxlZ2VuZFwiPiR7bGVnZW5kfTwvZGl2PlxuICAgIDwvZGl2PmA7XG59XG5cbmludGVyZmFjZSBCYXJFbnRyeSB7IGxhYmVsOiBzdHJpbmc7IHZhbHVlOiBudW1iZXI7IGRpc3BsYXk6IHN0cmluZzsgc3ViPzogc3RyaW5nOyBjb2xvcj86IG51bWJlciB9XG5cbmNvbnN0IENIQVJUX0NPTE9SUyA9IDY7XG5cbmZ1bmN0aW9uIGJ1aWxkQmFyQ2hhcnQodGl0bGU6IHN0cmluZywgZW50cmllczogQmFyRW50cnlbXSk6IHN0cmluZyB7XG4gIGlmIChlbnRyaWVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuICcnO1xuICBjb25zdCBtYXggPSBNYXRoLm1heCguLi5lbnRyaWVzLm1hcChlID0+IGUudmFsdWUpLCAxKTtcbiAgY29uc3Qgcm93cyA9IGVudHJpZXMubWFwKChlLCBpKSA9PiB7XG4gICAgY29uc3QgcGN0ID0gKGUudmFsdWUgLyBtYXgpICogMTAwO1xuICAgIGNvbnN0IGNpID0gZS5jb2xvciA/PyBpO1xuICAgIHJldHVybiBgXG4gICAgICA8ZGl2IGNsYXNzPVwiYmFyLXJvd1wiPlxuICAgICAgICA8ZGl2IGNsYXNzPVwiYmFyLWxibFwiPiR7ZXNjKHRydW5jU3RyKGUubGFiZWwsIDIyKSl9PC9kaXY+XG4gICAgICAgIDxkaXYgY2xhc3M9XCJiYXItdHJhY2tcIj48ZGl2IGNsYXNzPVwiYmFyLWZpbGwgYmFyLWMke2NpICUgQ0hBUlRfQ09MT1JTfVwiIHN0eWxlPVwid2lkdGg6JHtwY3QudG9GaXhlZCgxKX0lXCI+PC9kaXY+PC9kaXY+XG4gICAgICAgIDxkaXYgY2xhc3M9XCJiYXItdmFsXCI+JHtlc2MoZS5kaXNwbGF5KX08L2Rpdj5cbiAgICAgIDwvZGl2PlxuICAgICAgJHtlLnN1YiA/IGA8ZGl2IGNsYXNzPVwiYmFyLXN1YlwiPiR7ZXNjKGUuc3ViKX08L2Rpdj5gIDogJyd9YDtcbiAgfSkuam9pbignJyk7XG4gIHJldHVybiBgPGRpdiBjbGFzcz1cImNoYXJ0LWJsb2NrXCI+PGgzPiR7ZXNjKHRpdGxlKX08L2gzPiR7cm93c308L2Rpdj5gO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU2VjdGlvbjogVGltZWxpbmUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIGJ1aWxkVGltZWxpbmVTZWN0aW9uKGRhdGE6IFZpc3VhbGl6ZXJEYXRhKTogc3RyaW5nIHtcbiAgaWYgKGRhdGEudW5pdHMubGVuZ3RoID09PSAwKSByZXR1cm4gc2VjdGlvbigndGltZWxpbmUnLCAnVGltZWxpbmUnLCAnPHAgY2xhc3M9XCJlbXB0eVwiPk5vIHVuaXRzIGV4ZWN1dGVkIHlldC48L3A+Jyk7XG5cbiAgY29uc3Qgc29ydGVkID0gWy4uLmRhdGEudW5pdHNdLnNvcnQoKGEsIGIpID0+IGEuc3RhcnRlZEF0IC0gYi5zdGFydGVkQXQpO1xuICBjb25zdCBtYXhDb3N0ID0gTWF0aC5tYXgoLi4uc29ydGVkLm1hcCh1ID0+IHUuY29zdCksIDAuMDEpO1xuXG4gIGNvbnN0IHJvd3MgPSBzb3J0ZWQubWFwKCh1LCBpKSA9PiB7XG4gICAgY29uc3QgZHVyID0gdS5maW5pc2hlZEF0ID4gMCA/IGZvcm1hdER1cmF0aW9uKHUuZmluaXNoZWRBdCAtIHUuc3RhcnRlZEF0KSA6ICdydW5uaW5nJztcbiAgICAvLyBDb3N0IGhlYXRtYXA6IHN1YnRsZSByZWQgYmFja2dyb3VuZCBmb3IgZXhwZW5zaXZlIHJvd3NcbiAgICBjb25zdCBpbnRlbnNpdHkgPSBNYXRoLm1pbih1LmNvc3QgLyBtYXhDb3N0LCAxKTtcbiAgICBjb25zdCBoZWF0U3R5bGUgPSBpbnRlbnNpdHkgPiAwLjE1ID8gYCBzdHlsZT1cImJhY2tncm91bmQ6cmdiYSgyMzksNjgsNjgsJHsoaW50ZW5zaXR5ICogMC4xNSkudG9GaXhlZCgzKX0pXCJgIDogJyc7XG4gICAgcmV0dXJuIGBcbiAgICAgIDx0ciR7aGVhdFN0eWxlfT5cbiAgICAgICAgPHRkIGNsYXNzPVwibXV0ZWRcIj4ke2kgKyAxfTwvdGQ+XG4gICAgICAgIDx0ZCBjbGFzcz1cIm1vbm9cIj4ke2VzYyh1LnR5cGUpfTwvdGQ+XG4gICAgICAgIDx0ZCBjbGFzcz1cIm1vbm8gbXV0ZWRcIj4ke2VzYyh1LmlkKX08L3RkPlxuICAgICAgICA8dGQ+JHtlc2Moc2hvcnRNb2RlbCh1Lm1vZGVsKSl9PC90ZD5cbiAgICAgICAgPHRkIGNsYXNzPVwibXV0ZWRcIj4ke2Zvcm1hdERhdGVTaG9ydChuZXcgRGF0ZSh1LnN0YXJ0ZWRBdCkudG9JU09TdHJpbmcoKSl9PC90ZD5cbiAgICAgICAgPHRkPiR7ZHVyfTwvdGQ+XG4gICAgICAgIDx0ZCBjbGFzcz1cIm51bVwiPiR7Zm9ybWF0Q29zdCh1LmNvc3QpfTwvdGQ+XG4gICAgICAgIDx0ZCBjbGFzcz1cIm51bVwiPiR7Zm9ybWF0VG9rZW5Db3VudCh1LnRva2Vucy50b3RhbCl9PC90ZD5cbiAgICAgICAgPHRkIGNsYXNzPVwibnVtXCI+JHt1LnRvb2xDYWxsc308L3RkPlxuICAgICAgICA8dGQgY2xhc3M9XCJtb25vXCI+JHt1LnRpZXIgPz8gJyd9PC90ZD5cbiAgICAgICAgPHRkPiR7dS5tb2RlbERvd25ncmFkZWQgPyAncm91dGVkJyA6ICcnfTwvdGQ+XG4gICAgICAgIDx0ZCBjbGFzcz1cIm51bVwiPiR7KHUudHJ1bmNhdGlvblNlY3Rpb25zID8/IDApID4gMCA/IHUudHJ1bmNhdGlvblNlY3Rpb25zIDogJyd9PC90ZD5cbiAgICAgICAgPHRkPiR7dS5jb250aW51ZUhlcmVGaXJlZCA/ICd5ZXMnIDogJyd9PC90ZD5cbiAgICAgIDwvdHI+YDtcbiAgfSkuam9pbignJyk7XG5cbiAgcmV0dXJuIHNlY3Rpb24oJ3RpbWVsaW5lJywgJ1RpbWVsaW5lJywgYFxuICAgIDxkaXYgY2xhc3M9XCJ0YWJsZS1zY3JvbGxcIj5cbiAgICAgIDx0YWJsZSBjbGFzcz1cInRibFwiPlxuICAgICAgICA8dGhlYWQ+PHRyPlxuICAgICAgICAgIDx0aD4jPC90aD48dGg+VHlwZTwvdGg+PHRoPklEPC90aD48dGg+TW9kZWw8L3RoPlxuICAgICAgICAgIDx0aD5TdGFydGVkPC90aD48dGg+RHVyYXRpb248L3RoPjx0aD5Db3N0PC90aD5cbiAgICAgICAgICA8dGg+VG9rZW5zPC90aD48dGg+VG9vbHM8L3RoPjx0aD5UaWVyPC90aD48dGg+Um91dGVkPC90aD48dGg+VHJ1bmM8L3RoPjx0aD5DSEY8L3RoPlxuICAgICAgICA8L3RyPjwvdGhlYWQ+XG4gICAgICAgIDx0Ym9keT4ke3Jvd3N9PC90Ym9keT5cbiAgICAgIDwvdGFibGU+XG4gICAgPC9kaXY+YCk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTZWN0aW9uOiBDaGFuZ2Vsb2cgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIGJ1aWxkQ2hhbmdlbG9nU2VjdGlvbihkYXRhOiBWaXN1YWxpemVyRGF0YSk6IHN0cmluZyB7XG4gIGlmIChkYXRhLmNoYW5nZWxvZy5lbnRyaWVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHNlY3Rpb24oJ2NoYW5nZWxvZycsICdDaGFuZ2Vsb2cnLCAnPHAgY2xhc3M9XCJlbXB0eVwiPk5vIGNvbXBsZXRlZCBzbGljZXMgeWV0LjwvcD4nKTtcblxuICBjb25zdCBlbnRyaWVzID0gZGF0YS5jaGFuZ2Vsb2cuZW50cmllcy5tYXAoZSA9PiB7XG4gICAgY29uc3QgZmlsZXNIdG1sID0gZS5maWxlc01vZGlmaWVkLmxlbmd0aCA+IDAgPyBgXG4gICAgICA8ZGV0YWlscyBjbGFzcz1cImZpbGVzLWRldGFpbFwiPlxuICAgICAgICA8c3VtbWFyeSBjbGFzcz1cIm11dGVkXCI+JHtlLmZpbGVzTW9kaWZpZWQubGVuZ3RofSBmaWxlJHtlLmZpbGVzTW9kaWZpZWQubGVuZ3RoICE9PSAxID8gJ3MnIDogJyd9IG1vZGlmaWVkPC9zdW1tYXJ5PlxuICAgICAgICA8dWwgY2xhc3M9XCJmaWxlLWxpc3RcIj5cbiAgICAgICAgICAke2UuZmlsZXNNb2RpZmllZC5tYXAoZiA9PiBgPGxpPjxjb2RlPiR7ZXNjKGYucGF0aCl9PC9jb2RlPiR7Zi5kZXNjcmlwdGlvbiA/IGAgXHUyMDE0ICR7ZXNjKGYuZGVzY3JpcHRpb24pfWAgOiAnJ308L2xpPmApLmpvaW4oJycpfVxuICAgICAgICA8L3VsPlxuICAgICAgPC9kZXRhaWxzPmAgOiAnJztcblxuICAgIGNvbnN0IHZlciA9IGRhdGEuc2xpY2VWZXJpZmljYXRpb25zLmZpbmQodiA9PiB2LnNsaWNlSWQgPT09IGUuc2xpY2VJZCk7XG4gICAgY29uc3QgZGVjaXNpb25zSHRtbCA9IHZlcj8ua2V5RGVjaXNpb25zPy5sZW5ndGggPyBgXG4gICAgICA8ZGl2IGNsYXNzPVwiZGV0YWlsLWJsb2NrXCI+PHNwYW4gY2xhc3M9XCJkZXRhaWwtbGFiZWxcIj5EZWNpc2lvbnM8L3NwYW4+XG4gICAgICAgIDx1bD4ke3Zlci5rZXlEZWNpc2lvbnMubWFwKGQgPT4gYDxsaT4ke2VzYyhkKX08L2xpPmApLmpvaW4oJycpfTwvdWw+XG4gICAgICA8L2Rpdj5gIDogJyc7XG5cbiAgICByZXR1cm4gYFxuICAgICAgPGRpdiBjbGFzcz1cImNsLWVudHJ5XCI+XG4gICAgICAgIDxkaXYgY2xhc3M9XCJjbC1oZWFkZXJcIj5cbiAgICAgICAgICA8c3BhbiBjbGFzcz1cIm1vbm8gbXV0ZWRcIj4ke2VzYyhlLm1pbGVzdG9uZUlkKX0vJHtlc2MoZS5zbGljZUlkKX08L3NwYW4+XG4gICAgICAgICAgPHNwYW4gY2xhc3M9XCJjbC10aXRsZVwiPiR7ZXNjKGUudGl0bGUpfTwvc3Bhbj5cbiAgICAgICAgICAke2UuY29tcGxldGVkQXQgPyBgPHNwYW4gY2xhc3M9XCJtdXRlZCBjbC1kYXRlXCI+JHtmb3JtYXREYXRlU2hvcnQoZS5jb21wbGV0ZWRBdCl9PC9zcGFuPmAgOiAnJ31cbiAgICAgICAgPC9kaXY+XG4gICAgICAgICR7ZS5vbmVMaW5lciA/IGA8cCBjbGFzcz1cImNsLWxpbmVyXCI+JHtlc2MoZS5vbmVMaW5lcil9PC9wPmAgOiAnJ31cbiAgICAgICAgJHtkZWNpc2lvbnNIdG1sfVxuICAgICAgICAke2ZpbGVzSHRtbH1cbiAgICAgIDwvZGl2PmA7XG4gIH0pLmpvaW4oJycpO1xuXG4gIHJldHVybiBzZWN0aW9uKCdjaGFuZ2Vsb2cnLCBgQ2hhbmdlbG9nIDxzcGFuIGNsYXNzPVwiY291bnRcIj4ke2RhdGEuY2hhbmdlbG9nLmVudHJpZXMubGVuZ3RofTwvc3Bhbj5gLCBlbnRyaWVzKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFNlY3Rpb246IEtub3dsZWRnZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gYnVpbGRLbm93bGVkZ2VTZWN0aW9uKGRhdGE6IFZpc3VhbGl6ZXJEYXRhKTogc3RyaW5nIHtcbiAgY29uc3QgayA9IGRhdGEua25vd2xlZGdlO1xuICBpZiAoIWsuZXhpc3RzKSByZXR1cm4gc2VjdGlvbigna25vd2xlZGdlJywgJ0tub3dsZWRnZScsICc8cCBjbGFzcz1cImVtcHR5XCI+Tm8gS05PV0xFREdFLm1kIGZvdW5kLjwvcD4nKTtcbiAgY29uc3QgdG90YWwgPSBrLnJ1bGVzLmxlbmd0aCArIGsucGF0dGVybnMubGVuZ3RoICsgay5sZXNzb25zLmxlbmd0aDtcbiAgaWYgKHRvdGFsID09PSAwKSByZXR1cm4gc2VjdGlvbigna25vd2xlZGdlJywgJ0tub3dsZWRnZScsICc8cCBjbGFzcz1cImVtcHR5XCI+S05PV0xFREdFLm1kIGV4aXN0cyBidXQgbm8gZW50cmllcyBwYXJzZWQuPC9wPicpO1xuXG4gIGNvbnN0IHJ1bGVzSHRtbCA9IGsucnVsZXMubGVuZ3RoID4gMCA/IGBcbiAgICA8aDM+UnVsZXMgPHNwYW4gY2xhc3M9XCJjb3VudFwiPiR7ay5ydWxlcy5sZW5ndGh9PC9zcGFuPjwvaDM+XG4gICAgPHRhYmxlIGNsYXNzPVwidGJsXCI+XG4gICAgICA8dGhlYWQ+PHRyPjx0aD5JRDwvdGg+PHRoPlNjb3BlPC90aD48dGg+UnVsZTwvdGg+PC90cj48L3RoZWFkPlxuICAgICAgPHRib2R5PiR7ay5ydWxlcy5tYXAociA9PiBgPHRyPjx0ZCBjbGFzcz1cIm1vbm9cIj4ke2VzYyhyLmlkKX08L3RkPjx0ZD4ke2VzYyhyLnNjb3BlKX08L3RkPjx0ZD4ke2VzYyhyLmNvbnRlbnQpfTwvdGQ+PC90cj5gKS5qb2luKCcnKX08L3Rib2R5PlxuICAgIDwvdGFibGU+YCA6ICcnO1xuXG4gIGNvbnN0IHBhdHRlcm5zSHRtbCA9IGsucGF0dGVybnMubGVuZ3RoID4gMCA/IGBcbiAgICA8aDM+UGF0dGVybnMgPHNwYW4gY2xhc3M9XCJjb3VudFwiPiR7ay5wYXR0ZXJucy5sZW5ndGh9PC9zcGFuPjwvaDM+XG4gICAgPHRhYmxlIGNsYXNzPVwidGJsXCI+XG4gICAgICA8dGhlYWQ+PHRyPjx0aD5JRDwvdGg+PHRoPlBhdHRlcm48L3RoPjwvdHI+PC90aGVhZD5cbiAgICAgIDx0Ym9keT4ke2sucGF0dGVybnMubWFwKHAgPT4gYDx0cj48dGQgY2xhc3M9XCJtb25vXCI+JHtlc2MocC5pZCl9PC90ZD48dGQ+JHtlc2MocC5jb250ZW50KX08L3RkPjwvdHI+YCkuam9pbignJyl9PC90Ym9keT5cbiAgICA8L3RhYmxlPmAgOiAnJztcblxuICBjb25zdCBsZXNzb25zSHRtbCA9IGsubGVzc29ucy5sZW5ndGggPiAwID8gYFxuICAgIDxoMz5MZXNzb25zIDxzcGFuIGNsYXNzPVwiY291bnRcIj4ke2subGVzc29ucy5sZW5ndGh9PC9zcGFuPjwvaDM+XG4gICAgPHRhYmxlIGNsYXNzPVwidGJsXCI+XG4gICAgICA8dGhlYWQ+PHRyPjx0aD5JRDwvdGg+PHRoPkxlc3NvbjwvdGg+PC90cj48L3RoZWFkPlxuICAgICAgPHRib2R5PiR7ay5sZXNzb25zLm1hcChsID0+IGA8dHI+PHRkIGNsYXNzPVwibW9ub1wiPiR7ZXNjKGwuaWQpfTwvdGQ+PHRkPiR7ZXNjKGwuY29udGVudCl9PC90ZD48L3RyPmApLmpvaW4oJycpfTwvdGJvZHk+XG4gICAgPC90YWJsZT5gIDogJyc7XG5cbiAgcmV0dXJuIHNlY3Rpb24oJ2tub3dsZWRnZScsIGBLbm93bGVkZ2UgPHNwYW4gY2xhc3M9XCJjb3VudFwiPiR7dG90YWx9PC9zcGFuPmAsIGAke3J1bGVzSHRtbH0ke3BhdHRlcm5zSHRtbH0ke2xlc3NvbnNIdG1sfWApO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU2VjdGlvbjogQ2FwdHVyZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIGJ1aWxkQ2FwdHVyZXNTZWN0aW9uKGRhdGE6IFZpc3VhbGl6ZXJEYXRhKTogc3RyaW5nIHtcbiAgY29uc3QgYyA9IGRhdGEuY2FwdHVyZXM7XG4gIGlmIChjLnRvdGFsQ291bnQgPT09IDApIHJldHVybiBzZWN0aW9uKCdjYXB0dXJlcycsICdDYXB0dXJlcycsICc8cCBjbGFzcz1cImVtcHR5XCI+Tm8gY2FwdHVyZXMgcmVjb3JkZWQuPC9wPicpO1xuXG4gIGNvbnN0IGJhZGdlID0gYy5wZW5kaW5nQ291bnQgPiAwXG4gICAgPyBgPHNwYW4gY2xhc3M9XCJjb3VudCBjb3VudC13YXJuXCI+JHtjLnBlbmRpbmdDb3VudH0gcGVuZGluZzwvc3Bhbj5gXG4gICAgOiBgPHNwYW4gY2xhc3M9XCJjb3VudFwiPmFsbCB0cmlhZ2VkPC9zcGFuPmA7XG5cbiAgY29uc3Qgcm93cyA9IGMuZW50cmllcy5tYXAoZSA9PiBgXG4gICAgPHRyPlxuICAgICAgPHRkIGNsYXNzPVwibXV0ZWRcIj4ke2Zvcm1hdERhdGVTaG9ydChuZXcgRGF0ZShlLnRpbWVzdGFtcCkudG9JU09TdHJpbmcoKSl9PC90ZD5cbiAgICAgIDx0ZCBjbGFzcz1cIm1vbm9cIj4ke2VzYyhlLnN0YXR1cyl9PC90ZD5cbiAgICAgIDx0ZCBjbGFzcz1cIm1vbm9cIj4ke2UuY2xhc3NpZmljYXRpb24gPz8gJyd9PC90ZD5cbiAgICAgIDx0ZD4ke2UucmVzb2x1dGlvbiA/PyAnJ308L3RkPlxuICAgICAgPHRkPiR7ZXNjKGUudGV4dCl9PC90ZD5cbiAgICAgIDx0ZCBjbGFzcz1cIm11dGVkXCI+JHtlLnJhdGlvbmFsZSA/PyAnJ308L3RkPlxuICAgICAgPHRkIGNsYXNzPVwibXV0ZWRcIj4ke2UucmVzb2x2ZWRBdCA/IGZvcm1hdERhdGVTaG9ydChlLnJlc29sdmVkQXQpIDogJyd9PC90ZD5cbiAgICAgIDx0ZD4ke2UuZXhlY3V0ZWQgIT09IHVuZGVmaW5lZCA/IChlLmV4ZWN1dGVkID8gJ3llcycgOiAnbm8nKSA6ICcnfTwvdGQ+XG4gICAgPC90cj5gKS5qb2luKCcnKTtcblxuICByZXR1cm4gc2VjdGlvbignY2FwdHVyZXMnLCBgQ2FwdHVyZXMgJHtiYWRnZX1gLCBgXG4gICAgPGRpdiBjbGFzcz1cInRhYmxlLXNjcm9sbFwiPlxuICAgICAgPHRhYmxlIGNsYXNzPVwidGJsXCI+XG4gICAgICAgIDx0aGVhZD48dHI+PHRoPkNhcHR1cmVkPC90aD48dGg+U3RhdHVzPC90aD48dGg+Q2xhc3M8L3RoPjx0aD5SZXNvbHV0aW9uPC90aD48dGg+VGV4dDwvdGg+PHRoPlJhdGlvbmFsZTwvdGg+PHRoPlJlc29sdmVkPC90aD48dGg+RXhlY3V0ZWQ8L3RoPjwvdHI+PC90aGVhZD5cbiAgICAgICAgPHRib2R5PiR7cm93c308L3Rib2R5PlxuICAgICAgPC90YWJsZT5cbiAgICA8L2Rpdj5gKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFNlY3Rpb246IFN0YXRzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBidWlsZFN0YXRzU2VjdGlvbihkYXRhOiBWaXN1YWxpemVyRGF0YSk6IHN0cmluZyB7XG4gIGNvbnN0IHMgPSBkYXRhLnN0YXRzO1xuXG4gIGNvbnN0IG1pc3NpbmdIdG1sID0gcy5taXNzaW5nQ291bnQgPiAwID8gYFxuICAgIDxoMz5NaXNzaW5nIGNoYW5nZWxvZ3MgPHNwYW4gY2xhc3M9XCJjb3VudFwiPiR7cy5taXNzaW5nQ291bnR9PC9zcGFuPjwvaDM+XG4gICAgPHRhYmxlIGNsYXNzPVwidGJsXCI+XG4gICAgICA8dGhlYWQ+PHRyPjx0aD5NaWxlc3RvbmU8L3RoPjx0aD5TbGljZTwvdGg+PHRoPlRpdGxlPC90aD48L3RyPjwvdGhlYWQ+XG4gICAgICA8dGJvZHk+XG4gICAgICAgICR7cy5taXNzaW5nU2xpY2VzLm1hcChzbCA9PiBgPHRyPjx0ZCBjbGFzcz1cIm1vbm9cIj4ke2VzYyhzbC5taWxlc3RvbmVJZCl9PC90ZD48dGQgY2xhc3M9XCJtb25vXCI+JHtlc2Moc2wuc2xpY2VJZCl9PC90ZD48dGQ+JHtlc2Moc2wudGl0bGUpfTwvdGQ+PC90cj5gKS5qb2luKCcnKX1cbiAgICAgICAgJHtzLm1pc3NpbmdDb3VudCA+IHMubWlzc2luZ1NsaWNlcy5sZW5ndGhcbiAgICAgICAgICA/IGA8dHI+PHRkIGNvbHNwYW49XCIzXCIgY2xhc3M9XCJtdXRlZFwiPmFuZCAke3MubWlzc2luZ0NvdW50IC0gcy5taXNzaW5nU2xpY2VzLmxlbmd0aH0gbW9yZTwvdGQ+PC90cj5gXG4gICAgICAgICAgOiAnJ31cbiAgICAgIDwvdGJvZHk+XG4gICAgPC90YWJsZT5gIDogJyc7XG5cbiAgY29uc3QgdXBkYXRlZEh0bWwgPSBzLnVwZGF0ZWRDb3VudCA+IDAgPyBgXG4gICAgPGgzPlJlY2VudGx5IGNvbXBsZXRlZCA8c3BhbiBjbGFzcz1cImNvdW50XCI+JHtzLnVwZGF0ZWRDb3VudH08L3NwYW4+PC9oMz5cbiAgICA8dGFibGUgY2xhc3M9XCJ0YmxcIj5cbiAgICAgIDx0aGVhZD48dHI+PHRoPk1pbGVzdG9uZTwvdGg+PHRoPlNsaWNlPC90aD48dGg+VGl0bGU8L3RoPjx0aD5Db21wbGV0ZWQ8L3RoPjwvdHI+PC90aGVhZD5cbiAgICAgIDx0Ym9keT4ke3MudXBkYXRlZFNsaWNlcy5tYXAoc2wgPT4gYFxuICAgICAgICA8dHI+PHRkIGNsYXNzPVwibW9ub1wiPiR7ZXNjKHNsLm1pbGVzdG9uZUlkKX08L3RkPjx0ZCBjbGFzcz1cIm1vbm9cIj4ke2VzYyhzbC5zbGljZUlkKX08L3RkPjx0ZD4ke2VzYyhzbC50aXRsZSl9PC90ZD48dGQgY2xhc3M9XCJtdXRlZFwiPiR7c2wuY29tcGxldGVkQXQgPyBmb3JtYXREYXRlU2hvcnQoc2wuY29tcGxldGVkQXQpIDogJyd9PC90ZD48L3RyPmApLmpvaW4oJycpfVxuICAgICAgPC90Ym9keT5cbiAgICA8L3RhYmxlPmAgOiAnJztcblxuICBpZiAoIW1pc3NpbmdIdG1sICYmICF1cGRhdGVkSHRtbCkge1xuICAgIHJldHVybiBzZWN0aW9uKCdzdGF0cycsICdBcnRpZmFjdHMnLCAnPHAgY2xhc3M9XCJlbXB0eVwiPkFsbCBhcnRpZmFjdHMgYWNjb3VudGVkIGZvci48L3A+Jyk7XG4gIH1cblxuICByZXR1cm4gc2VjdGlvbignc3RhdHMnLCAnQXJ0aWZhY3RzJywgYCR7bWlzc2luZ0h0bWx9JHt1cGRhdGVkSHRtbH1gKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFNlY3Rpb246IERpc2N1c3Npb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIGJ1aWxkRGlzY3Vzc2lvblNlY3Rpb24oZGF0YTogVmlzdWFsaXplckRhdGEpOiBzdHJpbmcge1xuICBpZiAoZGF0YS5kaXNjdXNzaW9uLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHNlY3Rpb24oJ2Rpc2N1c3Npb24nLCAnUGxhbm5pbmcnLCAnPHAgY2xhc3M9XCJlbXB0eVwiPk5vIG1pbGVzdG9uZXMuPC9wPicpO1xuXG4gIGNvbnN0IHJvd3MgPSBkYXRhLmRpc2N1c3Npb24ubWFwKGQgPT4gYFxuICAgIDx0cj5cbiAgICAgIDx0ZCBjbGFzcz1cIm1vbm9cIj4ke2VzYyhkLm1pbGVzdG9uZUlkKX08L3RkPlxuICAgICAgPHRkPiR7ZXNjKGQudGl0bGUpfTwvdGQ+XG4gICAgICA8dGQgY2xhc3M9XCJtb25vXCI+JHtkLnN0YXRlfTwvdGQ+XG4gICAgICA8dGQ+JHtkLmhhc0NvbnRleHQgPyAneWVzJyA6ICcnfTwvdGQ+XG4gICAgICA8dGQ+JHtkLmhhc0RyYWZ0ID8gJ2RyYWZ0JyA6ICcnfTwvdGQ+XG4gICAgICA8dGQgY2xhc3M9XCJtdXRlZFwiPiR7ZC5sYXN0VXBkYXRlZCA/IGZvcm1hdERhdGVTaG9ydChkLmxhc3RVcGRhdGVkKSA6ICcnfTwvdGQ+XG4gICAgPC90cj5gKS5qb2luKCcnKTtcblxuICByZXR1cm4gc2VjdGlvbignZGlzY3Vzc2lvbicsICdQbGFubmluZycsIGBcbiAgICA8dGFibGUgY2xhc3M9XCJ0YmxcIj5cbiAgICAgIDx0aGVhZD48dHI+PHRoPklEPC90aD48dGg+TWlsZXN0b25lPC90aD48dGg+U3RhdGU8L3RoPjx0aD5Db250ZXh0PC90aD48dGg+RHJhZnQ8L3RoPjx0aD5VcGRhdGVkPC90aD48L3RyPjwvdGhlYWQ+XG4gICAgICA8dGJvZHk+JHtyb3dzfTwvdGJvZHk+XG4gICAgPC90YWJsZT5gKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFByaW1pdGl2ZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIHNlY3Rpb24oaWQ6IHN0cmluZywgdGl0bGU6IHN0cmluZywgYm9keTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBcXG48c2VjdGlvbiBpZD1cIiR7aWR9XCI+XFxuICA8aDI+JHt0aXRsZX08L2gyPlxcbiAgJHtib2R5fVxcbjwvc2VjdGlvbj5gO1xufVxuXG5mdW5jdGlvbiBrdmkobGFiZWw6IHN0cmluZywgdmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgPGRpdiBjbGFzcz1cImt2XCI+PHNwYW4gY2xhc3M9XCJrdi12YWxcIj4ke2VzYyh2YWx1ZSl9PC9zcGFuPjxzcGFuIGNsYXNzPVwia3YtbGJsXCI+JHtlc2MobGFiZWwpfTwvc3Bhbj48L2Rpdj5gO1xufVxuXG5mdW5jdGlvbiBoUm93KGxhYmVsOiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcsIHN0YXR1cz86ICdvaycgfCAnY2F1dGlvbicgfCAnd2FybicpOiBzdHJpbmcge1xuICBjb25zdCBjbHMgPSBzdGF0dXMgPyBgIGNsYXNzPVwiaC0ke3N0YXR1c31cImAgOiAnJztcbiAgcmV0dXJuIGA8dHIke2Nsc30+PHRkPiR7ZXNjKGxhYmVsKX08L3RkPjx0ZD4ke2VzYyh2YWx1ZSl9PC90ZD48L3RyPmA7XG59XG5cbmZ1bmN0aW9uIHNob3J0TW9kZWwobTogc3RyaW5nKSB7IHJldHVybiBtLnJlcGxhY2UoL15jbGF1ZGUtLywgJycpLnJlcGxhY2UoL15hbnRocm9waWNcXC8vLCAnJyk7IH1cbmZ1bmN0aW9uIHRydW5jU3RyKHM6IHN0cmluZywgbjogbnVtYmVyKSB7IHJldHVybiBzLmxlbmd0aCA+IG4gPyBzLnNsaWNlKDAsIG4gLSAxKSArICdcXHUyMDI2JyA6IHM7IH1cblxuIl0sCiAgIm1hcHBpbmdzIjogIkFBMkJBLFNBQVMsaUJBQWlCLHNCQUFzQjtBQUNoRCxTQUFTLEtBQUssdUJBQXVCO0FBQ3JDLFNBQVMsWUFBWSx3QkFBd0I7QUFhdEMsU0FBUyxtQkFDZCxNQUNBLE1BQ1E7QUFDUixRQUFNLGFBQVksb0JBQUksS0FBSyxHQUFFLFlBQVk7QUFFekMsUUFBTSxXQUFXO0FBQUEsSUFDZixvQkFBb0IsTUFBTSxNQUFNLFNBQVM7QUFBQSxJQUN6QyxxQkFBcUIsSUFBSTtBQUFBLElBQ3pCLHFCQUFxQixJQUFJO0FBQUEsSUFDekIscUJBQXFCLElBQUk7QUFBQSxJQUN6QixxQkFBcUIsSUFBSTtBQUFBLElBQ3pCLG9CQUFvQixJQUFJO0FBQUEsSUFDeEIsbUJBQW1CLElBQUk7QUFBQSxJQUN2QixzQkFBc0IsSUFBSTtBQUFBLElBQzFCLHNCQUFzQixJQUFJO0FBQUEsSUFDMUIscUJBQXFCLElBQUk7QUFBQSxJQUN6QixrQkFBa0IsSUFBSTtBQUFBLElBQ3RCLHVC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
