import { truncateToWidth } from "@gsd/pi-tui";
import { formatCost, formatTokenCount, classifyUnitPhase } from "./metrics.js";
import { formatDuration, padRight, joinColumns, sparkline, STATUS_GLYPH, STATUS_COLOR } from "../shared/mod.js";
function formatCompletionDate(input) {
  if (!input) return "unknown";
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) return input;
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function sliceLabel(slice) {
  return `${slice.milestoneId}/${slice.sliceId}`;
}
function renderFeatureStats(data, th, width) {
  const stats = data.stats;
  const lines = [];
  lines.push(th.fg("accent", th.bold("Feature Snapshot")));
  lines.push("");
  const missingLabel = `Missing slices: ${th.fg("warning", String(stats.missingCount))}`;
  lines.push(truncateToWidth(`  ${missingLabel}`, width));
  if (stats.missingSlices.length > 0) {
    for (const slice of stats.missingSlices) {
      const row = `    ${th.fg("dim", sliceLabel(slice))} ${slice.title}`;
      lines.push(truncateToWidth(row, width));
    }
    const remaining = stats.missingCount - stats.missingSlices.length;
    if (remaining > 0) {
      lines.push(truncateToWidth(`    ... and ${remaining} more`, width));
    }
  }
  lines.push("");
  const updatedLabel = `Updated (last 7 days): ${th.fg("accent", String(stats.updatedCount))}`;
  lines.push(truncateToWidth(`  ${updatedLabel}`, width));
  if (stats.updatedSlices.length > 0) {
    for (const slice of stats.updatedSlices) {
      const when = formatCompletionDate(slice.completedAt);
      const row = `    ${th.fg("text", sliceLabel(slice))} ${th.fg("dim", when)} ${slice.title}`;
      lines.push(truncateToWidth(row, width));
    }
  }
  lines.push("");
  lines.push(truncateToWidth(`  Recent completions: ${th.fg("success", String(stats.recentEntries.length))}`, width));
  for (const entry of stats.recentEntries) {
    const when = formatCompletionDate(entry.completedAt);
    const row = `    ${th.fg("text", entry.sliceId)} \u2014 ${entry.oneLiner || entry.title} ${th.fg("dim", when)}`;
    lines.push(truncateToWidth(row, width));
  }
  lines.push("");
  return lines;
}
function renderDiscussionStatus(data, th, width) {
  const states = data.discussion;
  if (states.length === 0) return [];
  const counts = {
    discussed: 0,
    draft: 0,
    undiscussed: 0
  };
  for (const state of states) counts[state.state]++;
  const lines = [];
  lines.push(th.fg("accent", th.bold("Discussion Status")));
  lines.push("");
  const summary = `  Discussed: ${th.fg("success", String(counts.discussed))}  Draft: ${th.fg("warning", String(counts.draft))}  Pending: ${th.fg("dim", String(counts.undiscussed))}`;
  lines.push(truncateToWidth(summary, width));
  lines.push("");
  for (const state of states) {
    const badge = state.state === "discussed" ? th.fg("success", "Discussed") : state.state === "draft" ? th.fg("warning", "Draft") : th.fg("dim", "Pending");
    const when = state.lastUpdated ? ` ${th.fg("dim", formatCompletionDate(state.lastUpdated))}` : "";
    const row = `    ${th.fg("text", state.milestoneId)} ${badge} ${state.title}${when}`;
    lines.push(truncateToWidth(row, width));
  }
  lines.push("");
  return lines;
}
function findVerification(data, milestoneId, sliceId) {
  return data.sliceVerifications.find((v) => v.milestoneId === milestoneId && v.sliceId === sliceId);
}
function renderProgressView(data, th, width, filter, collapsed) {
  const lines = [];
  lines.push(...renderRiskHeatmap(data, th, width));
  if (data.milestones.length > 0) lines.push("");
  if (filter && filter.text) {
    lines.push(th.fg("accent", `Filter (${filter.field}): ${filter.text}`));
    lines.push("");
  }
  lines.push(...renderFeatureStats(data, th, width));
  lines.push(...renderDiscussionStatus(data, th, width));
  for (const ms of data.milestones) {
    if (filter && filter.text) {
      const matchesMs = matchesFilter(ms, filter);
      if (!matchesMs) continue;
    }
    const msStatus = ms.status === "complete" ? "done" : ms.status === "active" ? "active" : ms.status === "parked" ? "paused" : "pending";
    const statusGlyph = th.fg(STATUS_COLOR[msStatus], STATUS_GLYPH[msStatus]);
    const statusLabel = th.fg(STATUS_COLOR[msStatus], ms.status);
    const collapseIndicator = collapsed?.has(ms.id) ? "[+] " : "";
    const msLeft = `${collapseIndicator}${ms.id}: ${ms.title}`;
    const msRight = `${statusGlyph} ${statusLabel}`;
    lines.push(joinColumns(msLeft, msRight, width));
    if (collapsed?.has(ms.id)) continue;
    if (ms.slices.length === 0 && ms.dependsOn.length > 0) {
      lines.push(th.fg("dim", `  (depends on ${ms.dependsOn.join(", ")})`));
      continue;
    }
    if (ms.status === "pending" && ms.dependsOn.length > 0) {
      lines.push(th.fg("dim", `  (depends on ${ms.dependsOn.join(", ")})`));
      continue;
    }
    for (const sl of ms.slices) {
      if (filter && filter.text) {
        if (!matchesSliceFilter(sl, filter)) continue;
      }
      const slStatus = sl.done ? "done" : sl.active ? "active" : "pending";
      const slGlyph = th.fg(STATUS_COLOR[slStatus], STATUS_GLYPH[slStatus]);
      const riskColor = sl.risk === "high" ? "warning" : sl.risk === "medium" ? "text" : "dim";
      const riskBadge = th.fg(riskColor, sl.risk);
      const ver = findVerification(data, ms.id, sl.id);
      let verBadge = "";
      if (ver) {
        if (ver.verificationResult === "passed") {
          verBadge = " " + th.fg("success", "\u2713");
        } else if (ver.verificationResult === "failed") {
          verBadge = " " + th.fg("error", "\u2717");
        } else if (ver.verificationResult === "untested" || ver.verificationResult === "") {
          verBadge = " " + th.fg("dim", "?");
        }
        if (ver.blockerDiscovered) {
          verBadge += " " + th.fg("warning", "\u26A0");
        }
      }
      const slLeft = `  ${slGlyph} ${sl.id}: ${sl.title}${verBadge}`;
      lines.push(joinColumns(slLeft, riskBadge, width));
      if (sl.active && sl.tasks.length > 0) {
        for (const task of sl.tasks) {
          const tStatus = task.done ? "done" : task.active ? "active" : "pending";
          const tGlyph = th.fg(STATUS_COLOR[tStatus], STATUS_GLYPH[tStatus]);
          const estimateStr = task.estimate ? th.fg("dim", ` (${task.estimate})`) : "";
          lines.push(`      ${tGlyph} ${task.id}: ${task.title}${estimateStr}`);
        }
      }
    }
  }
  return lines;
}
function matchesFilter(ms, filter) {
  const text = filter.text.toLowerCase();
  if (filter.field === "status") {
    return ms.status.includes(text);
  }
  if (filter.field === "risk") {
    return ms.slices.some((s) => s.risk.toLowerCase().includes(text));
  }
  if (ms.id.toLowerCase().includes(text)) return true;
  if (ms.title.toLowerCase().includes(text)) return true;
  if (ms.status.includes(text)) return true;
  return ms.slices.some((s) => matchesSliceFilter(s, filter));
}
function matchesSliceFilter(sl, filter) {
  const text = filter.text.toLowerCase();
  if (filter.field === "status") return true;
  if (filter.field === "risk") return sl.risk.toLowerCase().includes(text);
  return sl.id.toLowerCase().includes(text) || sl.title.toLowerCase().includes(text) || sl.risk.toLowerCase().includes(text);
}
function renderRiskHeatmap(data, th, width) {
  const allSlices = data.milestones.flatMap((m) => m.slices);
  if (allSlices.length === 0) return [];
  const lines = [];
  lines.push(th.fg("accent", th.bold("Risk Heatmap")));
  lines.push("");
  for (const ms of data.milestones) {
    if (ms.slices.length === 0) continue;
    const blocks = ms.slices.map((s) => {
      const color = s.risk === "high" ? "error" : s.risk === "medium" ? "warning" : "success";
      return th.fg(color, "\u2588\u2588");
    });
    const row = `  ${padRight(ms.id, 6)} ${blocks.join(" ")}`;
    lines.push(truncateToWidth(row, width));
  }
  lines.push("");
  lines.push(
    `  ${th.fg("success", "\u2588\u2588")} low  ${th.fg("warning", "\u2588\u2588")} med  ${th.fg("error", "\u2588\u2588")} high`
  );
  let low = 0, med = 0, high = 0;
  let highNotStarted = 0;
  for (const sl of allSlices) {
    if (sl.risk === "high") {
      high++;
      if (!sl.done && !sl.active) highNotStarted++;
    } else if (sl.risk === "medium") {
      med++;
    } else {
      low++;
    }
  }
  let summary = `  Risk: ${low} low, ${med} med, ${high} high`;
  if (highNotStarted > 0) {
    summary += ` | ${th.fg("error", `${highNotStarted} high-risk not started`)}`;
  }
  lines.push(summary);
  return lines;
}
function renderDepsView(data, th, width) {
  const lines = [];
  lines.push(th.fg("accent", th.bold("Milestone Dependencies")));
  lines.push("");
  const msDeps = data.milestones.filter((ms) => ms.dependsOn.length > 0);
  if (msDeps.length === 0) {
    lines.push(th.fg("dim", "  No milestone dependencies."));
  } else {
    for (const ms of msDeps) {
      for (const dep of ms.dependsOn) {
        lines.push(
          `  ${th.fg("text", dep)} ${th.fg("accent", "\u2500\u2500\u25BA")} ${th.fg("text", ms.id)}`
        );
      }
    }
  }
  lines.push("");
  lines.push(th.fg("accent", th.bold("Slice Dependencies (active milestone)")));
  lines.push("");
  const activeMs = data.milestones.find((ms) => ms.status === "active");
  if (!activeMs) {
    lines.push(th.fg("dim", "  No active milestone."));
  } else {
    const slDeps = activeMs.slices.filter((sl) => sl.depends.length > 0);
    if (slDeps.length === 0) {
      lines.push(th.fg("dim", "  No slice dependencies."));
    } else {
      for (const sl of slDeps) {
        for (const dep of sl.depends) {
          lines.push(
            `  ${th.fg("text", dep)} ${th.fg("accent", "\u2500\u2500\u25BA")} ${th.fg("text", sl.id)}`
          );
        }
      }
    }
  }
  lines.push("");
  lines.push(...renderCriticalPath(data, th, width));
  lines.push("");
  lines.push(...renderDataFlow(data, th));
  return lines;
}
function renderDataFlow(data, th) {
  const lines = [];
  const versWithProvides = data.sliceVerifications.filter((v) => v.provides.length > 0);
  const versWithRequires = data.sliceVerifications.filter((v) => v.requires.length > 0);
  if (versWithProvides.length === 0 && versWithRequires.length === 0) return lines;
  lines.push(th.fg("accent", th.bold("Data Flow")));
  lines.push("");
  for (const v of versWithProvides) {
    for (const artifact of v.provides) {
      lines.push(`  ${th.fg("text", v.sliceId)} ${th.fg("accent", "\u2500\u2500\u25BA")} ${th.fg("dim", `[${artifact}]`)}`);
    }
  }
  for (const v of versWithRequires) {
    for (const req of v.requires) {
      lines.push(`  ${th.fg("dim", `[${req.provides}]`)} ${th.fg("accent", "\u25C4\u2500\u2500")} ${th.fg("text", req.slice)}`);
    }
  }
  return lines;
}
function renderCriticalPath(data, th, _width) {
  const lines = [];
  const cp = data.criticalPath;
  lines.push(th.fg("accent", th.bold("Critical Path")));
  lines.push("");
  if (cp.milestonePath.length === 0) {
    lines.push(th.fg("dim", "  No critical path data."));
    return lines;
  }
  const chain = cp.milestonePath.map((id) => {
    const badge = th.fg("error", "[CRITICAL]");
    return `${id} ${badge}`;
  }).join(` ${th.fg("accent", "\u2500\u2500\u25BA")} `);
  lines.push(`  ${chain}`);
  lines.push("");
  for (const ms of data.milestones) {
    if (cp.milestonePath.includes(ms.id)) continue;
    const slack = cp.milestoneSlack.get(ms.id) ?? 0;
    lines.push(th.fg("dim", `  ${ms.id} (slack: ${slack})`));
  }
  if (cp.slicePath.length > 0) {
    lines.push("");
    lines.push(th.fg("accent", th.bold("Slice Critical Path")));
    lines.push("");
    const sliceChain = cp.slicePath.join(` ${th.fg("accent", "\u2500\u2500\u25BA")} `);
    lines.push(`  ${sliceChain}`);
    const activeMs = data.milestones.find((m) => m.status === "active");
    if (activeMs) {
      for (const sid of cp.slicePath) {
        const sl = activeMs.slices.find((s) => s.id === sid);
        if (sl && !sl.done && !sl.active) {
          lines.push(th.fg("warning", `  \u26A0 ${sid}: critical but not yet started`));
        }
      }
    }
  }
  return lines;
}
function renderMetricsView(data, th, width) {
  const lines = [];
  if (data.totals === null) {
    lines.push(th.fg("dim", "No metrics data available."));
    return lines;
  }
  const totals = data.totals;
  lines.push(
    th.fg("accent", th.bold("Summary"))
  );
  lines.push(
    `  Cost: ${th.fg("text", formatCost(totals.cost))}  Tokens: ${th.fg("text", formatTokenCount(totals.tokens.total))}  Units: ${th.fg("text", String(totals.units))}`
  );
  lines.push(
    `  Tools: ${th.fg("text", String(totals.toolCalls))}  Messages: ${th.fg("text", String(totals.assistantMessages))} sent / ${th.fg("text", String(totals.userMessages))} received`
  );
  lines.push("");
  const barWidth = Math.max(10, width - 40);
  if (data.byPhase.length > 0) {
    lines.push(th.fg("accent", th.bold("By Phase")));
    lines.push("");
    const maxPhaseCost = Math.max(...data.byPhase.map((p) => p.cost));
    for (const phase of data.byPhase) {
      const pct = totals.cost > 0 ? phase.cost / totals.cost * 100 : 0;
      const fillLen = maxPhaseCost > 0 ? Math.round(phase.cost / maxPhaseCost * barWidth) : 0;
      const bar = th.fg("accent", "\u2588".repeat(fillLen)) + th.fg("dim", "\u2591".repeat(barWidth - fillLen));
      const label = padRight(phase.phase, 14);
      const costStr = formatCost(phase.cost);
      const pctStr = `${pct.toFixed(1)}%`;
      const tokenStr = formatTokenCount(phase.tokens.total);
      lines.push(`  ${label} ${bar} ${costStr} ${pctStr} ${tokenStr}`);
    }
    lines.push("");
  }
  if (data.byModel.length > 0) {
    lines.push(th.fg("accent", th.bold("By Model")));
    lines.push("");
    const maxModelCost = Math.max(...data.byModel.map((m) => m.cost));
    for (const model of data.byModel) {
      const pct = totals.cost > 0 ? model.cost / totals.cost * 100 : 0;
      const fillLen = maxModelCost > 0 ? Math.round(model.cost / maxModelCost * barWidth) : 0;
      const bar = th.fg("accent", "\u2588".repeat(fillLen)) + th.fg("dim", "\u2591".repeat(barWidth - fillLen));
      const label = padRight(model.model, 20);
      const costStr = formatCost(model.cost);
      const pctStr = `${pct.toFixed(1)}%`;
      lines.push(`  ${label} ${bar} ${costStr} ${pctStr}`);
    }
    lines.push("");
  }
  if (data.byTier.length > 0) {
    lines.push(th.fg("accent", th.bold("By Tier")));
    lines.push("");
    const maxTierCost = Math.max(...data.byTier.map((t) => t.cost));
    for (const tier of data.byTier) {
      const pct = totals.cost > 0 ? tier.cost / totals.cost * 100 : 0;
      const fillLen = maxTierCost > 0 ? Math.round(tier.cost / maxTierCost * barWidth) : 0;
      const bar = th.fg("accent", "\u2588".repeat(fillLen)) + th.fg("dim", "\u2591".repeat(barWidth - fillLen));
      const label = padRight(tier.tier, 12);
      const costStr = formatCost(tier.cost);
      const pctStr = `${pct.toFixed(1)}%`;
      const unitsStr = `${tier.units} units`;
      lines.push(`  ${label} ${bar} ${costStr} ${pctStr} ${unitsStr}`);
    }
    if (data.tierSavingsLine) {
      lines.push(`  ${th.fg("success", data.tierSavingsLine)}`);
    }
    lines.push("");
  }
  lines.push(...renderCostProjections(data, th, width));
  return lines;
}
function renderCostProjections(data, th, _width) {
  const lines = [];
  if (!data.totals || data.bySlice.length === 0) return lines;
  lines.push(th.fg("accent", th.bold("Projections")));
  lines.push("");
  const sliceLevelEntries = data.bySlice.filter((s) => s.sliceId.includes("/"));
  if (sliceLevelEntries.length < 2) {
    lines.push(th.fg("dim", "  Insufficient data for projections (need 2+ completed slices)."));
    return lines;
  }
  const totalSliceCost = sliceLevelEntries.reduce((sum, s) => sum + s.cost, 0);
  const avgCostPerSlice = totalSliceCost / sliceLevelEntries.length;
  const projectedRemaining = avgCostPerSlice * data.remainingSliceCount;
  lines.push(`  Avg cost/slice: ${th.fg("text", formatCost(avgCostPerSlice))}`);
  lines.push(
    `  Projected remaining: ${th.fg("text", formatCost(projectedRemaining))} (${formatCost(avgCostPerSlice)}/slice \xD7 ${data.remainingSliceCount} remaining)`
  );
  if (data.totals.duration > 0) {
    const costPerHour = data.totals.cost / (data.totals.duration / 36e5);
    lines.push(`  Burn rate: ${th.fg("text", formatCost(costPerHour) + "/hr")}`);
  }
  const sliceCosts = sliceLevelEntries.map((s) => s.cost);
  if (sliceCosts.length > 0) {
    const spark = sparkline(sliceCosts);
    lines.push(`  Cost trend: ${spark}`);
  }
  const projectedTotal = data.totals.cost + projectedRemaining;
  if (projectedTotal > 2 * data.totals.cost && data.remainingSliceCount > 0) {
    lines.push(th.fg("warning", `  \u26A0 Projected total ${formatCost(projectedTotal)} exceeds 2\xD7 current spend`));
  }
  return lines;
}
function renderTimelineView(data, th, width) {
  const lines = [];
  if (data.units.length === 0) {
    lines.push(th.fg("dim", "No execution history."));
    return lines;
  }
  if (width >= 90) {
    return renderGanttView(data, th, width);
  }
  return renderTimelineList(data, th, width);
}
function shortenModel(model) {
  return model.replace(/^claude-/, "").slice(0, 12);
}
function renderTimelineList(data, th, width) {
  const lines = [];
  const recent = data.units.slice(-20).reverse();
  const maxDuration = Math.max(
    ...recent.map((u) => u.finishedAt - u.startedAt)
  );
  const timeBarWidth = Math.max(4, Math.min(12, width - 60));
  for (const unit of recent) {
    const dt = new Date(unit.startedAt);
    const hh = String(dt.getHours()).padStart(2, "0");
    const mm = String(dt.getMinutes()).padStart(2, "0");
    const time = `${hh}:${mm}`;
    const duration = unit.finishedAt - unit.startedAt;
    const unitStatus = unit.finishedAt > 0 ? "done" : "active";
    const glyph = th.fg(STATUS_COLOR[unitStatus], STATUS_GLYPH[unitStatus]);
    const typeLabel = padRight(unit.type, 16);
    const idLabel = padRight(unit.id, 14);
    const fillLen = maxDuration > 0 ? Math.round(duration / maxDuration * timeBarWidth) : 0;
    const bar = th.fg("accent", "\u2588".repeat(fillLen)) + th.fg("dim", "\u2591".repeat(timeBarWidth - fillLen));
    const durStr = formatDuration(duration);
    const costStr = formatCost(unit.cost);
    const tierLabel = unit.tier ? th.fg("dim", `[${unit.tier}]`) : "";
    const modelLabel = th.fg("dim", shortenModel(unit.model));
    const tierModelPart = [tierLabel, modelLabel].filter(Boolean).join(" ");
    const line = `  ${time}  ${glyph} ${typeLabel} ${tierModelPart} ${idLabel} ${bar}  ${durStr}  ${costStr}`;
    lines.push(truncateToWidth(line, width));
  }
  return lines;
}
function renderGanttView(data, th, width) {
  const lines = [];
  const recent = data.units.slice(-20);
  if (recent.length === 0) return lines;
  const finishedUnits = recent.filter((u) => u.finishedAt > 0);
  if (finishedUnits.length === 0) return renderTimelineList(data, th, width);
  const minStart = Math.min(...recent.map((u) => u.startedAt));
  const maxEnd = Math.max(...recent.map((u) => u.finishedAt > 0 ? u.finishedAt : Date.now()));
  const totalSpan = maxEnd - minStart;
  if (totalSpan <= 0) return renderTimelineList(data, th, width);
  const gutterWidth = 20;
  const barArea = Math.max(10, width - gutterWidth - 25);
  const startLabel = formatTimeLabel(minStart);
  const endLabel = formatTimeLabel(maxEnd);
  lines.push(
    `${" ".repeat(gutterWidth)} ${th.fg("dim", startLabel)}${" ".repeat(Math.max(1, barArea - startLabel.length - endLabel.length))}${th.fg("dim", endLabel)}`
  );
  let lastPhase = "";
  for (const unit of recent) {
    const phase = classifyUnitPhase(unit.type);
    if (phase !== lastPhase && lastPhase !== "") {
      lines.push(th.fg("dim", "  " + "\u2500".repeat(width - 4)));
    }
    lastPhase = phase;
    const end = unit.finishedAt > 0 ? unit.finishedAt : Date.now();
    const startPos = Math.round((unit.startedAt - minStart) / totalSpan * barArea);
    const endPos = Math.round((end - minStart) / totalSpan * barArea);
    const barLen = Math.max(1, endPos - startPos);
    const phaseColor = phase === "research" ? "dim" : phase === "planning" ? "accent" : phase === "execution" ? "success" : "warning";
    const barStr = " ".repeat(startPos) + th.fg(phaseColor, "\u2588".repeat(barLen)) + " ".repeat(Math.max(0, barArea - startPos - barLen));
    const tierTag = unit.tier ? `[${unit.tier[0]}]` : "";
    const gutter = padRight(
      truncateToWidth(`${unit.type.slice(0, 8)} ${unit.id}${tierTag}`, gutterWidth - 1),
      gutterWidth
    );
    const duration = end - unit.startedAt;
    const durStr = formatDuration(duration);
    const costStr = formatCost(unit.cost);
    lines.push(truncateToWidth(`${gutter}${barStr} ${durStr} ${costStr}`, width));
  }
  return lines;
}
function formatTimeLabel(ts) {
  const dt = new Date(ts);
  return `${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
}
function renderAgentView(data, th, width) {
  const lines = [];
  const activity = data.agentActivity;
  if (!activity) {
    lines.push(th.fg("dim", "No agent activity data."));
    return lines;
  }
  const agentStatus = activity.active ? "active" : "pending";
  const statusDot = th.fg(STATUS_COLOR[agentStatus], STATUS_GLYPH[agentStatus]);
  const statusText = activity.active ? "ACTIVE" : "IDLE";
  const elapsedStr = activity.active ? formatDuration(activity.elapsed) : "\u2014";
  lines.push(
    joinColumns(
      `Status: ${statusDot} ${statusText}`,
      `Elapsed: ${elapsedStr}`,
      width
    )
  );
  if (activity.currentUnit) {
    lines.push(`Current: ${th.fg("accent", `${activity.currentUnit.type} ${activity.currentUnit.id}`)}`);
  } else {
    lines.push(th.fg("dim", "Not in auto mode"));
  }
  lines.push("");
  const completed = activity.completedUnits;
  const total = Math.max(completed, activity.totalSlices);
  if (total > 0) {
    const pct = Math.min(1, completed / total);
    const barW = Math.max(10, Math.min(30, width - 30));
    const fillLen = Math.round(pct * barW);
    const bar = th.fg("accent", "\u2588".repeat(fillLen)) + th.fg("dim", "\u2591".repeat(barW - fillLen));
    lines.push(`Progress ${bar} ${completed}/${total} slices`);
  }
  const rateStr = activity.completionRate > 0 ? `${activity.completionRate.toFixed(1)} units/hr` : "\u2014";
  lines.push(
    `Rate: ${th.fg("text", rateStr)}    Session: ${th.fg("text", formatCost(activity.sessionCost))}  ${th.fg("text", formatTokenCount(activity.sessionTokens))} tokens`
  );
  lines.push("");
  const health = data.health;
  const truncColor = health.truncationRate < 10 ? "success" : health.truncationRate < 30 ? "warning" : "error";
  const contColor = health.continueHereRate < 10 ? "success" : health.continueHereRate < 30 ? "warning" : "error";
  lines.push(th.fg("accent", th.bold("Pressure")));
  lines.push(`  Truncation rate: ${th.fg(truncColor, `${health.truncationRate.toFixed(1)}%`)}`);
  lines.push(`  Continue-here rate: ${th.fg(contColor, `${health.continueHereRate.toFixed(1)}%`)}`);
  if (data.captures.pendingCount > 0) {
    lines.push(`  Pending captures: ${th.fg("warning", String(data.captures.pendingCount))}`);
  }
  lines.push("");
  const recentUnits = data.units.filter((u) => u.finishedAt > 0).slice(-5).reverse();
  if (recentUnits.length > 0) {
    lines.push(th.fg("accent", th.bold("Recent (last 5):")));
    for (const u of recentUnits) {
      const dt = new Date(u.startedAt);
      const hh = String(dt.getHours()).padStart(2, "0");
      const mm = String(dt.getMinutes()).padStart(2, "0");
      const dur = formatDuration(u.finishedAt - u.startedAt);
      const cost = formatCost(u.cost);
      const typeLabel = padRight(u.type, 16);
      lines.push(
        truncateToWidth(
          `  ${hh}:${mm}  ${th.fg(STATUS_COLOR.done, STATUS_GLYPH.done)} ${typeLabel} ${padRight(u.id, 16)} ${dur}  ${cost}`,
          width
        )
      );
    }
  } else {
    lines.push(th.fg("dim", "No completed units yet."));
  }
  return lines;
}
function renderChangelogView(data, th, width) {
  const lines = [];
  const changelog = data.changelog;
  if (changelog.entries.length === 0) {
    lines.push(th.fg("dim", "No completed slices yet."));
    return lines;
  }
  lines.push(th.fg("accent", th.bold("Changes")));
  lines.push("");
  for (const entry of changelog.entries) {
    const header = `${entry.milestoneId}/${entry.sliceId}: ${entry.title}`;
    lines.push(th.fg("success", header));
    if (entry.oneLiner) {
      lines.push(`  "${th.fg("text", entry.oneLiner)}"`);
    }
    if (entry.filesModified.length > 0) {
      lines.push("  Files:");
      for (const f of entry.filesModified) {
        lines.push(
          truncateToWidth(
            `    ${th.fg(STATUS_COLOR.done, STATUS_GLYPH.done)} ${f.path} \u2014 ${f.description}`,
            width
          )
        );
      }
    }
    const ver = findVerification(data, entry.milestoneId, entry.sliceId);
    if (ver) {
      if (ver.keyDecisions.length > 0) {
        lines.push("  Decisions:");
        for (const d of ver.keyDecisions) {
          lines.push(`    - ${d}`);
        }
      }
      if (ver.patternsEstablished.length > 0) {
        lines.push("  Patterns:");
        for (const p of ver.patternsEstablished) {
          lines.push(`    - ${p}`);
        }
      }
    }
    if (entry.completedAt) {
      lines.push(th.fg("dim", `  Completed: ${entry.completedAt}`));
    }
    lines.push("");
  }
  return lines;
}
function renderExportView(_data, th, _width, lastExportPath) {
  const lines = [];
  lines.push(th.fg("accent", th.bold("Export Options")));
  lines.push("");
  lines.push(`  ${th.fg("accent", "[m]")}  Markdown report \u2014 full project summary with tables`);
  lines.push(`  ${th.fg("accent", "[j]")}  JSON report \u2014 machine-readable project data`);
  lines.push(`  ${th.fg("accent", "[s]")}  Snapshot \u2014 current view as plain text`);
  if (lastExportPath) {
    lines.push("");
    lines.push(th.fg("dim", `Last export: ${lastExportPath}`));
  }
  return lines;
}
function renderKnowledgeView(data, th, width) {
  const lines = [];
  const knowledge = data.knowledge;
  if (!knowledge.exists) {
    lines.push(th.fg("dim", "No KNOWLEDGE.md found"));
    return lines;
  }
  if (knowledge.rules.length === 0 && knowledge.patterns.length === 0 && knowledge.lessons.length === 0) {
    lines.push(th.fg("dim", "KNOWLEDGE.md exists but is empty"));
    return lines;
  }
  if (knowledge.rules.length > 0) {
    lines.push(th.fg("accent", th.bold("Rules")));
    lines.push("");
    for (const rule of knowledge.rules) {
      lines.push(truncateToWidth(
        `  ${th.fg("accent", rule.id)}  ${th.fg("dim", `[${rule.scope}]`)}  ${rule.content}`,
        width
      ));
    }
    lines.push("");
  }
  if (knowledge.patterns.length > 0) {
    lines.push(th.fg("accent", th.bold("Patterns")));
    lines.push("");
    for (const pattern of knowledge.patterns) {
      lines.push(truncateToWidth(
        `  ${th.fg("accent", pattern.id)}  ${pattern.content}`,
        width
      ));
    }
    lines.push("");
  }
  if (knowledge.lessons.length > 0) {
    lines.push(th.fg("accent", th.bold("Lessons Learned")));
    lines.push("");
    for (const lesson of knowledge.lessons) {
      lines.push(truncateToWidth(
        `  ${th.fg("accent", lesson.id)}  ${lesson.content}`,
        width
      ));
    }
    lines.push("");
  }
  return lines;
}
function renderCapturesView(data, th, width) {
  const lines = [];
  const captures = data.captures;
  const resolved = captures.entries.filter((e) => e.status === "resolved").length;
  lines.push(
    `${th.fg("text", String(captures.totalCount))} total \xB7 ${th.fg("warning", String(captures.pendingCount))} pending \xB7 ${th.fg("dim", String(resolved))} resolved`
  );
  lines.push("");
  if (captures.entries.length === 0) {
    lines.push(th.fg("dim", "No captures recorded."));
    return lines;
  }
  const statusOrder = { pending: 0, triaged: 1, resolved: 2 };
  const sorted = [...captures.entries].sort(
    (a, b) => (statusOrder[a.status] ?? 3) - (statusOrder[b.status] ?? 3)
  );
  for (const entry of sorted) {
    const statusColor = entry.status === "pending" ? "warning" : entry.status === "triaged" ? "accent" : "dim";
    const classColor = entry.classification === "inject" ? "warning" : entry.classification === "quick-task" ? "accent" : entry.classification === "replan" ? "error" : entry.classification === "defer" ? "text" : "dim";
    const classBadge = entry.classification ? th.fg(classColor, `(${entry.classification})`) : "";
    const statusBadge = th.fg(statusColor, `[${entry.status}]`);
    const textPreview = truncateToWidth(entry.text, Math.max(20, width - 50));
    lines.push(`  ${th.fg("accent", entry.id)} ${statusBadge} ${textPreview} ${classBadge}`);
    if (entry.timestamp) {
      lines.push(`    ${th.fg("dim", entry.timestamp)}`);
    }
  }
  return lines;
}
function renderHealthView(data, th, width) {
  const lines = [];
  const health = data.health;
  lines.push(th.fg("accent", th.bold("Budget")));
  lines.push("");
  if (health.budgetCeiling !== void 0) {
    const currentSpend = data.totals?.cost ?? 0;
    const pct = health.budgetCeiling > 0 ? Math.min(1, currentSpend / health.budgetCeiling) : 0;
    const barW = Math.max(10, Math.min(30, width - 40));
    const fillLen = Math.round(pct * barW);
    const budgetColor = pct < 0.7 ? "success" : pct < 0.9 ? "warning" : "error";
    const bar = th.fg(budgetColor, "\u2588".repeat(fillLen)) + th.fg("dim", "\u2591".repeat(barW - fillLen));
    lines.push(`  Ceiling: ${th.fg("text", formatCost(health.budgetCeiling))}`);
    lines.push(`  Spend:   ${bar} ${formatCost(currentSpend)} (${(pct * 100).toFixed(1)}%)`);
  } else {
    lines.push(th.fg("dim", "  No budget ceiling set"));
  }
  lines.push(`  Token profile: ${th.fg("text", health.tokenProfile)}`);
  lines.push("");
  lines.push(th.fg("accent", th.bold("Pressure")));
  lines.push("");
  const truncColor = health.truncationRate < 10 ? "success" : health.truncationRate < 30 ? "warning" : "error";
  const contColor = health.continueHereRate < 10 ? "success" : health.continueHereRate < 30 ? "warning" : "error";
  const pressBarW = Math.max(10, Math.min(20, width - 50));
  const truncFill = Math.round(Math.min(health.truncationRate, 100) / 100 * pressBarW);
  const truncBar = th.fg(truncColor, "\u2588".repeat(truncFill)) + th.fg("dim", "\u2591".repeat(pressBarW - truncFill));
  lines.push(`  Truncation:    ${truncBar} ${health.truncationRate.toFixed(1)}%`);
  const contFill = Math.round(Math.min(health.continueHereRate, 100) / 100 * pressBarW);
  const contBar = th.fg(contColor, "\u2588".repeat(contFill)) + th.fg("dim", "\u2591".repeat(pressBarW - contFill));
  lines.push(`  Continue-here: ${contBar} ${health.continueHereRate.toFixed(1)}%`);
  lines.push("");
  if (health.tierBreakdown.length > 0) {
    lines.push(th.fg("accent", th.bold("Routing")));
    lines.push("");
    for (const tier of health.tierBreakdown) {
      const downTag = tier.downgraded > 0 ? th.fg("warning", ` (${tier.downgraded} downgraded)`) : "";
      lines.push(`  ${padRight(tier.tier, 12)} ${tier.units} units  ${formatCost(tier.cost)}${downTag}`);
    }
    if (health.tierSavingsLine) {
      lines.push(`  ${th.fg("success", health.tierSavingsLine)}`);
    }
    lines.push("");
  }
  lines.push(th.fg("accent", th.bold("Session")));
  lines.push("");
  lines.push(`  Tool calls: ${th.fg("text", String(health.toolCalls))}`);
  lines.push(`  Messages: ${th.fg("text", String(health.assistantMessages))} sent / ${th.fg("text", String(health.userMessages))} received`);
  if (health.environmentIssues?.length > 0) {
    lines.push("");
    lines.push(th.fg("accent", th.bold("Environment")));
    lines.push("");
    for (const r of health.environmentIssues) {
      const icon = r.status === "error" ? th.fg("error", "\u2717") : th.fg("warning", "\u26A0");
      lines.push(`  ${icon} ${th.fg("text", r.message)}`);
      if (r.detail) lines.push(`    ${th.fg("dim", r.detail)}`);
    }
  }
  if (health.providers?.length > 0) {
    lines.push("");
    lines.push(th.fg("accent", th.bold("Providers")));
    lines.push("");
    const categoryOrder = ["llm", "remote", "search", "tool"];
    const categoryLabels = { llm: "LLM", remote: "Notifications", search: "Search", tool: "Tools" };
    const grouped = /* @__PURE__ */ new Map();
    for (const p of health.providers) {
      const cat = p.category;
      if (!grouped.has(cat)) grouped.set(cat, []);
      grouped.get(cat).push(p);
    }
    for (const cat of categoryOrder) {
      const items = grouped.get(cat);
      if (!items || items.length === 0) continue;
      lines.push(`  ${th.fg("dim", categoryLabels[cat] ?? cat)}`);
      for (const p of items) {
        const icon = p.ok ? th.fg("success", "\u2713") : th.fg("error", "\u2717");
        const msg = p.ok ? th.fg("dim", p.message) : th.fg("text", p.message);
        lines.push(`    ${icon} ${msg}`);
      }
    }
  }
  if (health.progressScore) {
    lines.push("");
    lines.push(th.fg("accent", th.bold("Progress Score")));
    lines.push("");
    const ps = health.progressScore;
    const scoreColor = ps.level === "green" ? "success" : ps.level === "yellow" ? "warning" : "error";
    const scoreIcon = ps.level === "green" ? "\u25CF" : ps.level === "yellow" ? "\u25D0" : "\u25CB";
    lines.push(`  ${th.fg(scoreColor, scoreIcon)} ${th.fg(scoreColor, ps.summary)}`);
    for (const signal of ps.signals) {
      const prefix = signal.kind === "positive" ? th.fg("success", "  \u2713") : signal.kind === "negative" ? th.fg("error", "  \u2717") : th.fg("dim", "  \xB7");
      lines.push(`  ${prefix} ${th.fg("dim", signal.label)}`);
    }
  }
  const doctorHistory = health.doctorHistory ?? [];
  if (doctorHistory.length > 0) {
    lines.push("");
    lines.push(th.fg("accent", th.bold("Doctor History")));
    lines.push("");
    for (const entry of doctorHistory.slice(0, 10)) {
      const icon = entry.ok ? th.fg("success", "\u2713") : th.fg("error", "\u2717");
      const ts = entry.ts.replace("T", " ").slice(0, 19);
      const scopeTag = entry.scope ? th.fg("accent", ` [${entry.scope}]`) : "";
      const detail = entry.summary ? th.fg("text", entry.summary) : th.fg("text", `${entry.errors} errors, ${entry.warnings} warnings, ${entry.fixes} fixes`);
      lines.push(`  ${icon} ${th.fg("dim", ts)}${scopeTag}  ${detail}`);
      if (entry.issues && entry.issues.length > 0) {
        for (const issue of entry.issues.slice(0, 3)) {
          const issuePfx = issue.severity === "error" ? th.fg("error", "    \u2717") : th.fg("warning", "    \u26A0");
          lines.push(`  ${issuePfx} ${th.fg("dim", truncateToWidth(issue.message, width - 12))}`);
        }
        if (entry.issues.length > 3) {
          lines.push(`    ${th.fg("dim", `+${entry.issues.length - 3} more`)}`);
        }
      }
      if (entry.fixDescriptions && entry.fixDescriptions.length > 0) {
        for (const fix of entry.fixDescriptions.slice(0, 2)) {
          lines.push(`    ${th.fg("success", "\u21B3")} ${th.fg("dim", truncateToWidth(fix, width - 12))}`);
        }
      }
    }
    if (doctorHistory.length > 10) {
      lines.push(`  ${th.fg("dim", `...${doctorHistory.length - 10} older entries`)}`);
    }
  }
  if (health.skillSummary?.total > 0) {
    lines.push("");
    lines.push(th.fg("accent", th.bold("Skills")));
    lines.push("");
    const { total, warningCount, criticalCount, topIssue } = health.skillSummary;
    const issueColor = criticalCount > 0 ? "error" : warningCount > 0 ? "warning" : "success";
    const issueTag = criticalCount > 0 ? `${criticalCount} critical` : warningCount > 0 ? `${warningCount} warning${warningCount > 1 ? "s" : ""}` : "all healthy";
    lines.push(`  ${th.fg("text", String(total))} skills tracked  \xB7  ${th.fg(issueColor, issueTag)}`);
    if (topIssue) lines.push(`  ${th.fg("warning", "\u26A0")} ${th.fg("dim", topIssue)}`);
    lines.push(`  ${th.fg("dim", "\u2192 /gsd skill-health for full report")}`);
  }
  return lines;
}
export {
  renderAgentView,
  renderCapturesView,
  renderChangelogView,
  renderDepsView,
  renderExportView,
  renderHealthView,
  renderKnowledgeView,
  renderMetricsView,
  renderProgressView,
  renderTimelineView
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC92aXN1YWxpemVyLXZpZXdzLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBWaWV3IHJlbmRlcmVycyBmb3IgdGhlIEdTRCB3b3JrZmxvdyB2aXN1YWxpemVyIG92ZXJsYXkuXG5cbmltcG9ydCB0eXBlIHsgVGhlbWUgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB7IHRydW5jYXRlVG9XaWR0aCwgdmlzaWJsZVdpZHRoIH0gZnJvbSBcIkBnc2QvcGktdHVpXCI7XG5pbXBvcnQgdHlwZSB7IFZpc3VhbGl6ZXJEYXRhLCBWaXN1YWxpemVyTWlsZXN0b25lLCBTbGljZVZlcmlmaWNhdGlvbiwgVmlzdWFsaXplclNsaWNlQWN0aXZpdHksIFZpc3VhbGl6ZXJTdGF0cywgVmlzdWFsaXplclNsaWNlUmVmIH0gZnJvbSBcIi4vdmlzdWFsaXplci1kYXRhLmpzXCI7XG5pbXBvcnQgeyBmb3JtYXRDb3N0LCBmb3JtYXRUb2tlbkNvdW50LCBjbGFzc2lmeVVuaXRQaGFzZSB9IGZyb20gXCIuL21ldHJpY3MuanNcIjtcbmltcG9ydCB7IGZvcm1hdER1cmF0aW9uLCBwYWRSaWdodCwgam9pbkNvbHVtbnMsIHNwYXJrbGluZSwgU1RBVFVTX0dMWVBILCBTVEFUVVNfQ09MT1IgfSBmcm9tIFwiLi4vc2hhcmVkL21vZC5qc1wiO1xuXG5mdW5jdGlvbiBmb3JtYXRDb21wbGV0aW9uRGF0ZShpbnB1dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKCFpbnB1dCkgcmV0dXJuIFwidW5rbm93blwiO1xuICBjb25zdCBwYXJzZWQgPSBuZXcgRGF0ZShpbnB1dCk7XG4gIGlmIChOdW1iZXIuaXNOYU4ocGFyc2VkLmdldFRpbWUoKSkpIHJldHVybiBpbnB1dDtcbiAgcmV0dXJuIHBhcnNlZC50b0xvY2FsZURhdGVTdHJpbmcoXCJlbi1VU1wiLCB7IG1vbnRoOiBcInNob3J0XCIsIGRheTogXCJudW1lcmljXCIgfSk7XG59XG5cbmZ1bmN0aW9uIHNsaWNlTGFiZWwoc2xpY2U6IFZpc3VhbGl6ZXJTbGljZVJlZik6IHN0cmluZyB7XG4gIHJldHVybiBgJHtzbGljZS5taWxlc3RvbmVJZH0vJHtzbGljZS5zbGljZUlkfWA7XG59XG5cbmZ1bmN0aW9uIHJlbmRlckZlYXR1cmVTdGF0cyhkYXRhOiBWaXN1YWxpemVyRGF0YSwgdGg6IFRoZW1lLCB3aWR0aDogbnVtYmVyKTogc3RyaW5nW10ge1xuICBjb25zdCBzdGF0cyA9IGRhdGEuc3RhdHM7XG4gIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICBsaW5lcy5wdXNoKHRoLmZnKFwiYWNjZW50XCIsIHRoLmJvbGQoXCJGZWF0dXJlIFNuYXBzaG90XCIpKSk7XG4gIGxpbmVzLnB1c2goXCJcIik7XG5cbiAgY29uc3QgbWlzc2luZ0xhYmVsID0gYE1pc3Npbmcgc2xpY2VzOiAke3RoLmZnKFwid2FybmluZ1wiLCBTdHJpbmcoc3RhdHMubWlzc2luZ0NvdW50KSl9YDtcbiAgbGluZXMucHVzaCh0cnVuY2F0ZVRvV2lkdGgoYCAgJHttaXNzaW5nTGFiZWx9YCwgd2lkdGgpKTtcbiAgaWYgKHN0YXRzLm1pc3NpbmdTbGljZXMubGVuZ3RoID4gMCkge1xuICAgIGZvciAoY29uc3Qgc2xpY2Ugb2Ygc3RhdHMubWlzc2luZ1NsaWNlcykge1xuICAgICAgY29uc3Qgcm93ID0gYCAgICAke3RoLmZnKFwiZGltXCIsIHNsaWNlTGFiZWwoc2xpY2UpKX0gJHtzbGljZS50aXRsZX1gO1xuICAgICAgbGluZXMucHVzaCh0cnVuY2F0ZVRvV2lkdGgocm93LCB3aWR0aCkpO1xuICAgIH1cbiAgICBjb25zdCByZW1haW5pbmcgPSBzdGF0cy5taXNzaW5nQ291bnQgLSBzdGF0cy5taXNzaW5nU2xpY2VzLmxlbmd0aDtcbiAgICBpZiAocmVtYWluaW5nID4gMCkge1xuICAgICAgbGluZXMucHVzaCh0cnVuY2F0ZVRvV2lkdGgoYCAgICAuLi4gYW5kICR7cmVtYWluaW5nfSBtb3JlYCwgd2lkdGgpKTtcbiAgICB9XG4gIH1cblxuICBsaW5lcy5wdXNoKFwiXCIpO1xuICBjb25zdCB1cGRhdGVkTGFiZWwgPSBgVXBkYXRlZCAobGFzdCA3IGRheXMpOiAke3RoLmZnKFwiYWNjZW50XCIsIFN0cmluZyhzdGF0cy51cGRhdGVkQ291bnQpKX1gO1xuICBsaW5lcy5wdXNoKHRydW5jYXRlVG9XaWR0aChgICAke3VwZGF0ZWRMYWJlbH1gLCB3aWR0aCkpO1xuICBpZiAoc3RhdHMudXBkYXRlZFNsaWNlcy5sZW5ndGggPiAwKSB7XG4gICAgZm9yIChjb25zdCBzbGljZSBvZiBzdGF0cy51cGRhdGVkU2xpY2VzKSB7XG4gICAgICBjb25zdCB3aGVuID0gZm9ybWF0Q29tcGxldGlvbkRhdGUoc2xpY2UuY29tcGxldGVkQXQpO1xuICAgICAgY29uc3Qgcm93ID0gYCAgICAke3RoLmZnKFwidGV4dFwiLCBzbGljZUxhYmVsKHNsaWNlKSl9ICR7dGguZmcoXCJkaW1cIiwgd2hlbil9ICR7c2xpY2UudGl0bGV9YDtcbiAgICAgIGxpbmVzLnB1c2godHJ1bmNhdGVUb1dpZHRoKHJvdywgd2lkdGgpKTtcbiAgICB9XG4gIH1cblxuICBsaW5lcy5wdXNoKFwiXCIpO1xuICBsaW5lcy5wdXNoKHRydW5jYXRlVG9XaWR0aChgICBSZWNlbnQgY29tcGxldGlvbnM6ICR7dGguZmcoXCJzdWNjZXNzXCIsIFN0cmluZyhzdGF0cy5yZWNlbnRFbnRyaWVzLmxlbmd0aCkpfWAsIHdpZHRoKSk7XG4gIGZvciAoY29uc3QgZW50cnkgb2Ygc3RhdHMucmVjZW50RW50cmllcykge1xuICAgIGNvbnN0IHdoZW4gPSBmb3JtYXRDb21wbGV0aW9uRGF0ZShlbnRyeS5jb21wbGV0ZWRBdCk7XG4gICAgY29uc3Qgcm93ID0gYCAgICAke3RoLmZnKFwidGV4dFwiLCBlbnRyeS5zbGljZUlkKX0gXHUyMDE0ICR7ZW50cnkub25lTGluZXIgfHwgZW50cnkudGl0bGV9ICR7dGguZmcoXCJkaW1cIiwgd2hlbil9YDtcbiAgICBsaW5lcy5wdXNoKHRydW5jYXRlVG9XaWR0aChyb3csIHdpZHRoKSk7XG4gIH1cblxuICBsaW5lcy5wdXNoKFwiXCIpO1xuICByZXR1cm4gbGluZXM7XG59XG5cbmZ1bmN0aW9uIHJlbmRlckRpc2N1c3Npb25TdGF0dXMoZGF0YTogVmlzdWFsaXplckRhdGEsIHRoOiBUaGVtZSwgd2lkdGg6IG51bWJlcik6IHN0cmluZ1tdIHtcbiAgY29uc3Qgc3RhdGVzID0gZGF0YS5kaXNjdXNzaW9uO1xuICBpZiAoc3RhdGVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIFtdO1xuXG4gIGNvbnN0IGNvdW50cyA9IHtcbiAgICBkaXNjdXNzZWQ6IDAsXG4gICAgZHJhZnQ6IDAsXG4gICAgdW5kaXNjdXNzZWQ6IDAsXG4gIH07XG4gIGZvciAoY29uc3Qgc3RhdGUgb2Ygc3RhdGVzKSBjb3VudHNbc3RhdGUuc3RhdGVdKys7XG5cbiAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG4gIGxpbmVzLnB1c2godGguZmcoXCJhY2NlbnRcIiwgdGguYm9sZChcIkRpc2N1c3Npb24gU3RhdHVzXCIpKSk7XG4gIGxpbmVzLnB1c2goXCJcIik7XG4gIGNvbnN0IHN1bW1hcnkgPSBgICBEaXNjdXNzZWQ6ICR7dGguZmcoXCJzdWNjZXNzXCIsIFN0cmluZyhjb3VudHMuZGlzY3Vzc2VkKSl9ICBEcmFmdDogJHt0aC5mZyhcIndhcm5pbmdcIiwgU3RyaW5nKGNvdW50cy5kcmFmdCkpfSAgUGVuZGluZzogJHt0aC5mZyhcImRpbVwiLCBTdHJpbmcoY291bnRzLnVuZGlzY3Vzc2VkKSl9YDtcbiAgbGluZXMucHVzaCh0cnVuY2F0ZVRvV2lkdGgoc3VtbWFyeSwgd2lkdGgpKTtcbiAgbGluZXMucHVzaChcIlwiKTtcblxuICBmb3IgKGNvbnN0IHN0YXRlIG9mIHN0YXRlcykge1xuICAgIGNvbnN0IGJhZGdlID1cbiAgICAgIHN0YXRlLnN0YXRlID09PSBcImRpc2N1c3NlZFwiXG4gICAgICAgID8gdGguZmcoXCJzdWNjZXNzXCIsIFwiRGlzY3Vzc2VkXCIpXG4gICAgICAgIDogc3RhdGUuc3RhdGUgPT09IFwiZHJhZnRcIlxuICAgICAgICAgID8gdGguZmcoXCJ3YXJuaW5nXCIsIFwiRHJhZnRcIilcbiAgICAgICAgICA6IHRoLmZnKFwiZGltXCIsIFwiUGVuZGluZ1wiKTtcbiAgICBjb25zdCB3aGVuID0gc3RhdGUubGFzdFVwZGF0ZWQgPyBgICR7dGguZmcoXCJkaW1cIiwgZm9ybWF0Q29tcGxldGlvbkRhdGUoc3RhdGUubGFzdFVwZGF0ZWQpKX1gIDogXCJcIjtcbiAgICBjb25zdCByb3cgPSBgICAgICR7dGguZmcoXCJ0ZXh0XCIsIHN0YXRlLm1pbGVzdG9uZUlkKX0gJHtiYWRnZX0gJHtzdGF0ZS50aXRsZX0ke3doZW59YDtcbiAgICBsaW5lcy5wdXNoKHRydW5jYXRlVG9XaWR0aChyb3csIHdpZHRoKSk7XG4gIH1cblxuICBsaW5lcy5wdXNoKFwiXCIpO1xuICByZXR1cm4gbGluZXM7XG59XG5cbmZ1bmN0aW9uIGZpbmRWZXJpZmljYXRpb24oZGF0YTogVmlzdWFsaXplckRhdGEsIG1pbGVzdG9uZUlkOiBzdHJpbmcsIHNsaWNlSWQ6IHN0cmluZyk6IFNsaWNlVmVyaWZpY2F0aW9uIHwgdW5kZWZpbmVkIHtcbiAgcmV0dXJuIGRhdGEuc2xpY2VWZXJpZmljYXRpb25zLmZpbmQodiA9PiB2Lm1pbGVzdG9uZUlkID09PSBtaWxlc3RvbmVJZCAmJiB2LnNsaWNlSWQgPT09IHNsaWNlSWQpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUHJvZ3Jlc3MgVmlldyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGludGVyZmFjZSBQcm9ncmVzc0ZpbHRlciB7XG4gIHRleHQ6IHN0cmluZztcbiAgZmllbGQ6IFwiYWxsXCIgfCBcInN0YXR1c1wiIHwgXCJyaXNrXCIgfCBcImtleXdvcmRcIjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlclByb2dyZXNzVmlldyhcbiAgZGF0YTogVmlzdWFsaXplckRhdGEsXG4gIHRoOiBUaGVtZSxcbiAgd2lkdGg6IG51bWJlcixcbiAgZmlsdGVyPzogUHJvZ3Jlc3NGaWx0ZXIsXG4gIGNvbGxhcHNlZD86IFNldDxzdHJpbmc+LFxuKTogc3RyaW5nW10ge1xuICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcblxuICAvLyBSaXNrIEhlYXRtYXBcbiAgbGluZXMucHVzaCguLi5yZW5kZXJSaXNrSGVhdG1hcChkYXRhLCB0aCwgd2lkdGgpKTtcbiAgaWYgKGRhdGEubWlsZXN0b25lcy5sZW5ndGggPiAwKSBsaW5lcy5wdXNoKFwiXCIpO1xuXG4gIC8vIEZpbHRlciBpbmRpY2F0b3JcbiAgaWYgKGZpbHRlciAmJiBmaWx0ZXIudGV4dCkge1xuICAgIGxpbmVzLnB1c2godGguZmcoXCJhY2NlbnRcIiwgYEZpbHRlciAoJHtmaWx0ZXIuZmllbGR9KTogJHtmaWx0ZXIudGV4dH1gKSk7XG4gICAgbGluZXMucHVzaChcIlwiKTtcbiAgfVxuXG4gIGxpbmVzLnB1c2goLi4ucmVuZGVyRmVhdHVyZVN0YXRzKGRhdGEsIHRoLCB3aWR0aCkpO1xuICBsaW5lcy5wdXNoKC4uLnJlbmRlckRpc2N1c3Npb25TdGF0dXMoZGF0YSwgdGgsIHdpZHRoKSk7XG5cbiAgZm9yIChjb25zdCBtcyBvZiBkYXRhLm1pbGVzdG9uZXMpIHtcbiAgICAvLyBBcHBseSBmaWx0ZXIgdG8gbWlsZXN0b25lc1xuICAgIGlmIChmaWx0ZXIgJiYgZmlsdGVyLnRleHQpIHtcbiAgICAgIGNvbnN0IG1hdGNoZXNNcyA9IG1hdGNoZXNGaWx0ZXIobXMsIGZpbHRlcik7XG4gICAgICBpZiAoIW1hdGNoZXNNcykgY29udGludWU7XG4gICAgfVxuXG4gICAgLy8gTWlsZXN0b25lIGhlYWRlciBsaW5lXG4gICAgY29uc3QgbXNTdGF0dXMgPSBtcy5zdGF0dXMgPT09IFwiY29tcGxldGVcIiA/IFwiZG9uZVwiIDogbXMuc3RhdHVzID09PSBcImFjdGl2ZVwiID8gXCJhY3RpdmVcIiA6IG1zLnN0YXR1cyA9PT0gXCJwYXJrZWRcIiA/IFwicGF1c2VkXCIgOiBcInBlbmRpbmdcIjtcbiAgICBjb25zdCBzdGF0dXNHbHlwaCA9IHRoLmZnKFNUQVRVU19DT0xPUlttc1N0YXR1c10sIFNUQVRVU19HTFlQSFttc1N0YXR1c10pO1xuICAgIGNvbnN0IHN0YXR1c0xhYmVsID0gdGguZmcoU1RBVFVTX0NPTE9SW21zU3RhdHVzXSwgbXMuc3RhdHVzKTtcblxuICAgIGNvbnN0IGNvbGxhcHNlSW5kaWNhdG9yID0gY29sbGFwc2VkPy5oYXMobXMuaWQpID8gXCJbK10gXCIgOiBcIlwiO1xuICAgIGNvbnN0IG1zTGVmdCA9IGAke2NvbGxhcHNlSW5kaWNhdG9yfSR7bXMuaWR9OiAke21zLnRpdGxlfWA7XG4gICAgY29uc3QgbXNSaWdodCA9IGAke3N0YXR1c0dseXBofSAke3N0YXR1c0xhYmVsfWA7XG4gICAgbGluZXMucHVzaChqb2luQ29sdW1ucyhtc0xlZnQsIG1zUmlnaHQsIHdpZHRoKSk7XG5cbiAgICAvLyBJZiBjb2xsYXBzZWQsIHNraXAgcmVuZGVyaW5nIHNsaWNlcy90YXNrc1xuICAgIGlmIChjb2xsYXBzZWQ/Lmhhcyhtcy5pZCkpIGNvbnRpbnVlO1xuXG4gICAgaWYgKG1zLnNsaWNlcy5sZW5ndGggPT09IDAgJiYgbXMuZGVwZW5kc09uLmxlbmd0aCA+IDApIHtcbiAgICAgIGxpbmVzLnB1c2godGguZmcoXCJkaW1cIiwgYCAgKGRlcGVuZHMgb24gJHttcy5kZXBlbmRzT24uam9pbihcIiwgXCIpfSlgKSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBpZiAobXMuc3RhdHVzID09PSBcInBlbmRpbmdcIiAmJiBtcy5kZXBlbmRzT24ubGVuZ3RoID4gMCkge1xuICAgICAgbGluZXMucHVzaCh0aC5mZyhcImRpbVwiLCBgICAoZGVwZW5kcyBvbiAke21zLmRlcGVuZHNPbi5qb2luKFwiLCBcIil9KWApKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGZvciAoY29uc3Qgc2wgb2YgbXMuc2xpY2VzKSB7XG4gICAgICAvLyBBcHBseSBmaWx0ZXIgdG8gc2xpY2VzXG4gICAgICBpZiAoZmlsdGVyICYmIGZpbHRlci50ZXh0KSB7XG4gICAgICAgIGlmICghbWF0Y2hlc1NsaWNlRmlsdGVyKHNsLCBmaWx0ZXIpKSBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgLy8gU2xpY2UgbGluZVxuICAgICAgY29uc3Qgc2xTdGF0dXMgPSBzbC5kb25lID8gXCJkb25lXCIgOiBzbC5hY3RpdmUgPyBcImFjdGl2ZVwiIDogXCJwZW5kaW5nXCI7XG4gICAgICBjb25zdCBzbEdseXBoID0gdGguZmcoU1RBVFVTX0NPTE9SW3NsU3RhdHVzXSwgU1RBVFVTX0dMWVBIW3NsU3RhdHVzXSk7XG4gICAgICBjb25zdCByaXNrQ29sb3IgPVxuICAgICAgICBzbC5yaXNrID09PSBcImhpZ2hcIlxuICAgICAgICAgID8gXCJ3YXJuaW5nXCJcbiAgICAgICAgICA6IHNsLnJpc2sgPT09IFwibWVkaXVtXCJcbiAgICAgICAgICAgID8gXCJ0ZXh0XCJcbiAgICAgICAgICAgIDogXCJkaW1cIjtcbiAgICAgIGNvbnN0IHJpc2tCYWRnZSA9IHRoLmZnKHJpc2tDb2xvciwgc2wucmlzayk7XG5cbiAgICAgIC8vIFZlcmlmaWNhdGlvbiBiYWRnZVxuICAgICAgY29uc3QgdmVyID0gZmluZFZlcmlmaWNhdGlvbihkYXRhLCBtcy5pZCwgc2wuaWQpO1xuICAgICAgbGV0IHZlckJhZGdlID0gXCJcIjtcbiAgICAgIGlmICh2ZXIpIHtcbiAgICAgICAgaWYgKHZlci52ZXJpZmljYXRpb25SZXN1bHQgPT09IFwicGFzc2VkXCIpIHtcbiAgICAgICAgICB2ZXJCYWRnZSA9IFwiIFwiICsgdGguZmcoXCJzdWNjZXNzXCIsIFwiXFx1MjcxM1wiKTtcbiAgICAgICAgfSBlbHNlIGlmICh2ZXIudmVyaWZpY2F0aW9uUmVzdWx0ID09PSBcImZhaWxlZFwiKSB7XG4gICAgICAgICAgdmVyQmFkZ2UgPSBcIiBcIiArIHRoLmZnKFwiZXJyb3JcIiwgXCJcXHUyNzE3XCIpO1xuICAgICAgICB9IGVsc2UgaWYgKHZlci52ZXJpZmljYXRpb25SZXN1bHQgPT09IFwidW50ZXN0ZWRcIiB8fCB2ZXIudmVyaWZpY2F0aW9uUmVzdWx0ID09PSBcIlwiKSB7XG4gICAgICAgICAgdmVyQmFkZ2UgPSBcIiBcIiArIHRoLmZnKFwiZGltXCIsIFwiP1wiKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAodmVyLmJsb2NrZXJEaXNjb3ZlcmVkKSB7XG4gICAgICAgICAgdmVyQmFkZ2UgKz0gXCIgXCIgKyB0aC5mZyhcIndhcm5pbmdcIiwgXCJcXHUyNmEwXCIpO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHNsTGVmdCA9IGAgICR7c2xHbHlwaH0gJHtzbC5pZH06ICR7c2wudGl0bGV9JHt2ZXJCYWRnZX1gO1xuICAgICAgbGluZXMucHVzaChqb2luQ29sdW1ucyhzbExlZnQsIHJpc2tCYWRnZSwgd2lkdGgpKTtcblxuICAgICAgLy8gU2hvdyB0YXNrcyBmb3IgYWN0aXZlIHNsaWNlXG4gICAgICBpZiAoc2wuYWN0aXZlICYmIHNsLnRhc2tzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgZm9yIChjb25zdCB0YXNrIG9mIHNsLnRhc2tzKSB7XG4gICAgICAgICAgY29uc3QgdFN0YXR1cyA9IHRhc2suZG9uZSA/IFwiZG9uZVwiIDogdGFzay5hY3RpdmUgPyBcImFjdGl2ZVwiIDogXCJwZW5kaW5nXCI7XG4gICAgICAgICAgY29uc3QgdEdseXBoID0gdGguZmcoU1RBVFVTX0NPTE9SW3RTdGF0dXNdLCBTVEFUVVNfR0xZUEhbdFN0YXR1c10pO1xuICAgICAgICAgIGNvbnN0IGVzdGltYXRlU3RyID0gdGFzay5lc3RpbWF0ZSA/IHRoLmZnKFwiZGltXCIsIGAgKCR7dGFzay5lc3RpbWF0ZX0pYCkgOiBcIlwiO1xuICAgICAgICAgIGxpbmVzLnB1c2goYCAgICAgICR7dEdseXBofSAke3Rhc2suaWR9OiAke3Rhc2sudGl0bGV9JHtlc3RpbWF0ZVN0cn1gKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiBsaW5lcztcbn1cblxuZnVuY3Rpb24gbWF0Y2hlc0ZpbHRlcihtczogVmlzdWFsaXplck1pbGVzdG9uZSwgZmlsdGVyOiBQcm9ncmVzc0ZpbHRlcik6IGJvb2xlYW4ge1xuICBjb25zdCB0ZXh0ID0gZmlsdGVyLnRleHQudG9Mb3dlckNhc2UoKTtcbiAgaWYgKGZpbHRlci5maWVsZCA9PT0gXCJzdGF0dXNcIikge1xuICAgIHJldHVybiBtcy5zdGF0dXMuaW5jbHVkZXModGV4dCk7XG4gIH1cbiAgaWYgKGZpbHRlci5maWVsZCA9PT0gXCJyaXNrXCIpIHtcbiAgICByZXR1cm4gbXMuc2xpY2VzLnNvbWUocyA9PiBzLnJpc2sudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyh0ZXh0KSk7XG4gIH1cbiAgLy8gXCJhbGxcIiBvciBcImtleXdvcmRcIlxuICBpZiAobXMuaWQudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyh0ZXh0KSkgcmV0dXJuIHRydWU7XG4gIGlmIChtcy50aXRsZS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHRleHQpKSByZXR1cm4gdHJ1ZTtcbiAgaWYgKG1zLnN0YXR1cy5pbmNsdWRlcyh0ZXh0KSkgcmV0dXJuIHRydWU7XG4gIHJldHVybiBtcy5zbGljZXMuc29tZShzID0+IG1hdGNoZXNTbGljZUZpbHRlcihzLCBmaWx0ZXIpKTtcbn1cblxuZnVuY3Rpb24gbWF0Y2hlc1NsaWNlRmlsdGVyKHNsOiB7IGlkOiBzdHJpbmc7IHRpdGxlOiBzdHJpbmc7IHJpc2s6IHN0cmluZyB9LCBmaWx0ZXI6IFByb2dyZXNzRmlsdGVyKTogYm9vbGVhbiB7XG4gIGNvbnN0IHRleHQgPSBmaWx0ZXIudGV4dC50b0xvd2VyQ2FzZSgpO1xuICBpZiAoZmlsdGVyLmZpZWxkID09PSBcInN0YXR1c1wiKSByZXR1cm4gdHJ1ZTsgLy8gc2xpY2VzIGRvbid0IGhhdmUgbmFtZWQgc3RhdHVzXG4gIGlmIChmaWx0ZXIuZmllbGQgPT09IFwicmlza1wiKSByZXR1cm4gc2wucmlzay50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHRleHQpO1xuICByZXR1cm4gc2wuaWQudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyh0ZXh0KSB8fFxuICAgIHNsLnRpdGxlLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXModGV4dCkgfHxcbiAgICBzbC5yaXNrLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXModGV4dCk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBSaXNrIEhlYXRtYXAgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIHJlbmRlclJpc2tIZWF0bWFwKGRhdGE6IFZpc3VhbGl6ZXJEYXRhLCB0aDogVGhlbWUsIHdpZHRoOiBudW1iZXIpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGFsbFNsaWNlcyA9IGRhdGEubWlsZXN0b25lcy5mbGF0TWFwKG0gPT4gbS5zbGljZXMpO1xuICBpZiAoYWxsU2xpY2VzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIFtdO1xuXG4gIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICBsaW5lcy5wdXNoKHRoLmZnKFwiYWNjZW50XCIsIHRoLmJvbGQoXCJSaXNrIEhlYXRtYXBcIikpKTtcbiAgbGluZXMucHVzaChcIlwiKTtcblxuICBmb3IgKGNvbnN0IG1zIG9mIGRhdGEubWlsZXN0b25lcykge1xuICAgIGlmIChtcy5zbGljZXMubGVuZ3RoID09PSAwKSBjb250aW51ZTtcbiAgICBjb25zdCBibG9ja3MgPSBtcy5zbGljZXMubWFwKHMgPT4ge1xuICAgICAgY29uc3QgY29sb3IgPSBzLnJpc2sgPT09IFwiaGlnaFwiID8gXCJlcnJvclwiIDogcy5yaXNrID09PSBcIm1lZGl1bVwiID8gXCJ3YXJuaW5nXCIgOiBcInN1Y2Nlc3NcIjtcbiAgICAgIHJldHVybiB0aC5mZyhjb2xvciwgXCJcXHUyNTg4XFx1MjU4OFwiKTtcbiAgICB9KTtcbiAgICBjb25zdCByb3cgPSBgICAke3BhZFJpZ2h0KG1zLmlkLCA2KX0gJHtibG9ja3Muam9pbihcIiBcIil9YDtcbiAgICBsaW5lcy5wdXNoKHRydW5jYXRlVG9XaWR0aChyb3csIHdpZHRoKSk7XG4gIH1cblxuICBsaW5lcy5wdXNoKFwiXCIpO1xuICBsaW5lcy5wdXNoKFxuICAgIGAgICR7dGguZmcoXCJzdWNjZXNzXCIsIFwiXFx1MjU4OFxcdTI1ODhcIil9IGxvdyAgJHt0aC5mZyhcIndhcm5pbmdcIiwgXCJcXHUyNTg4XFx1MjU4OFwiKX0gbWVkICAke3RoLmZnKFwiZXJyb3JcIiwgXCJcXHUyNTg4XFx1MjU4OFwiKX0gaGlnaGAsXG4gICk7XG5cbiAgLy8gU3VtbWFyeSBjb3VudHNcbiAgbGV0IGxvdyA9IDAsIG1lZCA9IDAsIGhpZ2ggPSAwO1xuICBsZXQgaGlnaE5vdFN0YXJ0ZWQgPSAwO1xuICBmb3IgKGNvbnN0IHNsIG9mIGFsbFNsaWNlcykge1xuICAgIGlmIChzbC5yaXNrID09PSBcImhpZ2hcIikge1xuICAgICAgaGlnaCsrO1xuICAgICAgaWYgKCFzbC5kb25lICYmICFzbC5hY3RpdmUpIGhpZ2hOb3RTdGFydGVkKys7XG4gICAgfSBlbHNlIGlmIChzbC5yaXNrID09PSBcIm1lZGl1bVwiKSB7XG4gICAgICBtZWQrKztcbiAgICB9IGVsc2Uge1xuICAgICAgbG93Kys7XG4gICAgfVxuICB9XG5cbiAgbGV0IHN1bW1hcnkgPSBgICBSaXNrOiAke2xvd30gbG93LCAke21lZH0gbWVkLCAke2hpZ2h9IGhpZ2hgO1xuICBpZiAoaGlnaE5vdFN0YXJ0ZWQgPiAwKSB7XG4gICAgc3VtbWFyeSArPSBgIHwgJHt0aC5mZyhcImVycm9yXCIsIGAke2hpZ2hOb3RTdGFydGVkfSBoaWdoLXJpc2sgbm90IHN0YXJ0ZWRgKX1gO1xuICB9XG4gIGxpbmVzLnB1c2goc3VtbWFyeSk7XG5cbiAgcmV0dXJuIGxpbmVzO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRGVwZW5kZW5jaWVzIFZpZXcgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJEZXBzVmlldyhcbiAgZGF0YTogVmlzdWFsaXplckRhdGEsXG4gIHRoOiBUaGVtZSxcbiAgd2lkdGg6IG51bWJlcixcbik6IHN0cmluZ1tdIHtcbiAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG5cbiAgLy8gTWlsZXN0b25lIERlcGVuZGVuY2llc1xuICBsaW5lcy5wdXNoKHRoLmZnKFwiYWNjZW50XCIsIHRoLmJvbGQoXCJNaWxlc3RvbmUgRGVwZW5kZW5jaWVzXCIpKSk7XG4gIGxpbmVzLnB1c2goXCJcIik7XG5cbiAgY29uc3QgbXNEZXBzID0gZGF0YS5taWxlc3RvbmVzLmZpbHRlcigobXMpID0+IG1zLmRlcGVuZHNPbi5sZW5ndGggPiAwKTtcbiAgaWYgKG1zRGVwcy5sZW5ndGggPT09IDApIHtcbiAgICBsaW5lcy5wdXNoKHRoLmZnKFwiZGltXCIsIFwiICBObyBtaWxlc3RvbmUgZGVwZW5kZW5jaWVzLlwiKSk7XG4gIH0gZWxzZSB7XG4gICAgZm9yIChjb25zdCBtcyBvZiBtc0RlcHMpIHtcbiAgICAgIGZvciAoY29uc3QgZGVwIG9mIG1zLmRlcGVuZHNPbikge1xuICAgICAgICBsaW5lcy5wdXNoKFxuICAgICAgICAgIGAgICR7dGguZmcoXCJ0ZXh0XCIsIGRlcCl9ICR7dGguZmcoXCJhY2NlbnRcIiwgXCJcXHUyNTAwXFx1MjUwMFxcdTI1YmFcIil9ICR7dGguZmcoXCJ0ZXh0XCIsIG1zLmlkKX1gLFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGxpbmVzLnB1c2goXCJcIik7XG5cbiAgLy8gU2xpY2UgRGVwZW5kZW5jaWVzIChhY3RpdmUgbWlsZXN0b25lKVxuICBsaW5lcy5wdXNoKHRoLmZnKFwiYWNjZW50XCIsIHRoLmJvbGQoXCJTbGljZSBEZXBlbmRlbmNpZXMgKGFjdGl2ZSBtaWxlc3RvbmUpXCIpKSk7XG4gIGxpbmVzLnB1c2goXCJcIik7XG5cbiAgY29uc3QgYWN0aXZlTXMgPSBkYXRhLm1pbGVzdG9uZXMuZmluZCgobXMpID0+IG1zLnN0YXR1cyA9PT0gXCJhY3RpdmVcIik7XG4gIGlmICghYWN0aXZlTXMpIHtcbiAgICBsaW5lcy5wdXNoKHRoLmZnKFwiZGltXCIsIFwiICBObyBhY3RpdmUgbWlsZXN0b25lLlwiKSk7XG4gIH0gZWxzZSB7XG4gICAgY29uc3Qgc2xEZXBzID0gYWN0aXZlTXMuc2xpY2VzLmZpbHRlcigoc2wpID0+IHNsLmRlcGVuZHMubGVuZ3RoID4gMCk7XG4gICAgaWYgKHNsRGVwcy5sZW5ndGggPT09IDApIHtcbiAgICAgIGxpbmVzLnB1c2godGguZmcoXCJkaW1cIiwgXCIgIE5vIHNsaWNlIGRlcGVuZGVuY2llcy5cIikpO1xuICAgIH0gZWxzZSB7XG4gICAgICBmb3IgKGNvbnN0IHNsIG9mIHNsRGVwcykge1xuICAgICAgICBmb3IgKGNvbnN0IGRlcCBvZiBzbC5kZXBlbmRzKSB7XG4gICAgICAgICAgbGluZXMucHVzaChcbiAgICAgICAgICAgIGAgICR7dGguZmcoXCJ0ZXh0XCIsIGRlcCl9ICR7dGguZmcoXCJhY2NlbnRcIiwgXCJcXHUyNTAwXFx1MjUwMFxcdTI1YmFcIil9ICR7dGguZmcoXCJ0ZXh0XCIsIHNsLmlkKX1gLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBsaW5lcy5wdXNoKFwiXCIpO1xuXG4gIC8vIENyaXRpY2FsIFBhdGggc2VjdGlvblxuICBsaW5lcy5wdXNoKC4uLnJlbmRlckNyaXRpY2FsUGF0aChkYXRhLCB0aCwgd2lkdGgpKTtcblxuICAvLyBEYXRhIEZsb3cgc2VjdGlvbiBmcm9tIHNsaWNlIHZlcmlmaWNhdGlvbnNcbiAgbGluZXMucHVzaChcIlwiKTtcbiAgbGluZXMucHVzaCguLi5yZW5kZXJEYXRhRmxvdyhkYXRhLCB0aCkpO1xuXG4gIHJldHVybiBsaW5lcztcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIERhdGEgRmxvdyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gcmVuZGVyRGF0YUZsb3coZGF0YTogVmlzdWFsaXplckRhdGEsIHRoOiBUaGVtZSk6IHN0cmluZ1tdIHtcbiAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IHZlcnNXaXRoUHJvdmlkZXMgPSBkYXRhLnNsaWNlVmVyaWZpY2F0aW9ucy5maWx0ZXIodiA9PiB2LnByb3ZpZGVzLmxlbmd0aCA+IDApO1xuICBjb25zdCB2ZXJzV2l0aFJlcXVpcmVzID0gZGF0YS5zbGljZVZlcmlmaWNhdGlvbnMuZmlsdGVyKHYgPT4gdi5yZXF1aXJlcy5sZW5ndGggPiAwKTtcblxuICBpZiAodmVyc1dpdGhQcm92aWRlcy5sZW5ndGggPT09IDAgJiYgdmVyc1dpdGhSZXF1aXJlcy5sZW5ndGggPT09IDApIHJldHVybiBsaW5lcztcblxuICBsaW5lcy5wdXNoKHRoLmZnKFwiYWNjZW50XCIsIHRoLmJvbGQoXCJEYXRhIEZsb3dcIikpKTtcbiAgbGluZXMucHVzaChcIlwiKTtcblxuICBmb3IgKGNvbnN0IHYgb2YgdmVyc1dpdGhQcm92aWRlcykge1xuICAgIGZvciAoY29uc3QgYXJ0aWZhY3Qgb2Ygdi5wcm92aWRlcykge1xuICAgICAgbGluZXMucHVzaChgICAke3RoLmZnKFwidGV4dFwiLCB2LnNsaWNlSWQpfSAke3RoLmZnKFwiYWNjZW50XCIsIFwiXFx1MjUwMFxcdTI1MDBcXHUyNWJhXCIpfSAke3RoLmZnKFwiZGltXCIsIGBbJHthcnRpZmFjdH1dYCl9YCk7XG4gICAgfVxuICB9XG5cbiAgZm9yIChjb25zdCB2IG9mIHZlcnNXaXRoUmVxdWlyZXMpIHtcbiAgICBmb3IgKGNvbnN0IHJlcSBvZiB2LnJlcXVpcmVzKSB7XG4gICAgICBsaW5lcy5wdXNoKGAgICR7dGguZmcoXCJkaW1cIiwgYFske3JlcS5wcm92aWRlc31dYCl9ICR7dGguZmcoXCJhY2NlbnRcIiwgXCJcXHUyNWM0XFx1MjUwMFxcdTI1MDBcIil9ICR7dGguZmcoXCJ0ZXh0XCIsIHJlcS5zbGljZSl9YCk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGxpbmVzO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQ3JpdGljYWwgUGF0aCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gcmVuZGVyQ3JpdGljYWxQYXRoKGRhdGE6IFZpc3VhbGl6ZXJEYXRhLCB0aDogVGhlbWUsIF93aWR0aDogbnVtYmVyKTogc3RyaW5nW10ge1xuICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgY3AgPSBkYXRhLmNyaXRpY2FsUGF0aDtcblxuICBsaW5lcy5wdXNoKHRoLmZnKFwiYWNjZW50XCIsIHRoLmJvbGQoXCJDcml0aWNhbCBQYXRoXCIpKSk7XG4gIGxpbmVzLnB1c2goXCJcIik7XG5cbiAgaWYgKGNwLm1pbGVzdG9uZVBhdGgubGVuZ3RoID09PSAwKSB7XG4gICAgbGluZXMucHVzaCh0aC5mZyhcImRpbVwiLCBcIiAgTm8gY3JpdGljYWwgcGF0aCBkYXRhLlwiKSk7XG4gICAgcmV0dXJuIGxpbmVzO1xuICB9XG5cbiAgLy8gTWlsZXN0b25lIGNoYWluXG4gIGNvbnN0IGNoYWluID0gY3AubWlsZXN0b25lUGF0aC5tYXAoaWQgPT4ge1xuICAgIGNvbnN0IGJhZGdlID0gdGguZmcoXCJlcnJvclwiLCBcIltDUklUSUNBTF1cIik7XG4gICAgcmV0dXJuIGAke2lkfSAke2JhZGdlfWA7XG4gIH0pLmpvaW4oYCAke3RoLmZnKFwiYWNjZW50XCIsIFwiXFx1MjUwMFxcdTI1MDBcXHUyNWJhXCIpfSBgKTtcbiAgbGluZXMucHVzaChgICAke2NoYWlufWApO1xuICBsaW5lcy5wdXNoKFwiXCIpO1xuXG4gIC8vIE5vbi1jcml0aWNhbCBtaWxlc3RvbmVzIHdpdGggc2xhY2tcbiAgZm9yIChjb25zdCBtcyBvZiBkYXRhLm1pbGVzdG9uZXMpIHtcbiAgICBpZiAoY3AubWlsZXN0b25lUGF0aC5pbmNsdWRlcyhtcy5pZCkpIGNvbnRpbnVlO1xuICAgIGNvbnN0IHNsYWNrID0gY3AubWlsZXN0b25lU2xhY2suZ2V0KG1zLmlkKSA/PyAwO1xuICAgIGxpbmVzLnB1c2godGguZmcoXCJkaW1cIiwgYCAgJHttcy5pZH0gKHNsYWNrOiAke3NsYWNrfSlgKSk7XG4gIH1cblxuICAvLyBTbGljZS1sZXZlbCBjcml0aWNhbCBwYXRoXG4gIGlmIChjcC5zbGljZVBhdGgubGVuZ3RoID4gMCkge1xuICAgIGxpbmVzLnB1c2goXCJcIik7XG4gICAgbGluZXMucHVzaCh0aC5mZyhcImFjY2VudFwiLCB0aC5ib2xkKFwiU2xpY2UgQ3JpdGljYWwgUGF0aFwiKSkpO1xuICAgIGxpbmVzLnB1c2goXCJcIik7XG5cbiAgICBjb25zdCBzbGljZUNoYWluID0gY3Auc2xpY2VQYXRoLmpvaW4oYCAke3RoLmZnKFwiYWNjZW50XCIsIFwiXFx1MjUwMFxcdTI1MDBcXHUyNWJhXCIpfSBgKTtcbiAgICBsaW5lcy5wdXNoKGAgICR7c2xpY2VDaGFpbn1gKTtcblxuICAgIC8vIEJvdHRsZW5lY2sgd2FybmluZ3NcbiAgICBjb25zdCBhY3RpdmVNcyA9IGRhdGEubWlsZXN0b25lcy5maW5kKG0gPT4gbS5zdGF0dXMgPT09IFwiYWN0aXZlXCIpO1xuICAgIGlmIChhY3RpdmVNcykge1xuICAgICAgZm9yIChjb25zdCBzaWQgb2YgY3Auc2xpY2VQYXRoKSB7XG4gICAgICAgIGNvbnN0IHNsID0gYWN0aXZlTXMuc2xpY2VzLmZpbmQocyA9PiBzLmlkID09PSBzaWQpO1xuICAgICAgICBpZiAoc2wgJiYgIXNsLmRvbmUgJiYgIXNsLmFjdGl2ZSkge1xuICAgICAgICAgIGxpbmVzLnB1c2godGguZmcoXCJ3YXJuaW5nXCIsIGAgIFxcdTI2YTAgJHtzaWR9OiBjcml0aWNhbCBidXQgbm90IHlldCBzdGFydGVkYCkpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGxpbmVzO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgTWV0cmljcyBWaWV3IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgZnVuY3Rpb24gcmVuZGVyTWV0cmljc1ZpZXcoXG4gIGRhdGE6IFZpc3VhbGl6ZXJEYXRhLFxuICB0aDogVGhlbWUsXG4gIHdpZHRoOiBudW1iZXIsXG4pOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuXG4gIGlmIChkYXRhLnRvdGFscyA9PT0gbnVsbCkge1xuICAgIGxpbmVzLnB1c2godGguZmcoXCJkaW1cIiwgXCJObyBtZXRyaWNzIGRhdGEgYXZhaWxhYmxlLlwiKSk7XG4gICAgcmV0dXJuIGxpbmVzO1xuICB9XG5cbiAgY29uc3QgdG90YWxzID0gZGF0YS50b3RhbHM7XG5cbiAgLy8gU3VtbWFyeSBsaW5lXG4gIGxpbmVzLnB1c2goXG4gICAgdGguZmcoXCJhY2NlbnRcIiwgdGguYm9sZChcIlN1bW1hcnlcIikpLFxuICApO1xuICBsaW5lcy5wdXNoKFxuICAgIGAgIENvc3Q6ICR7dGguZmcoXCJ0ZXh0XCIsIGZvcm1hdENvc3QodG90YWxzLmNvc3QpKX0gIGAgK1xuICAgIGBUb2tlbnM6ICR7dGguZmcoXCJ0ZXh0XCIsIGZvcm1hdFRva2VuQ291bnQodG90YWxzLnRva2Vucy50b3RhbCkpfSAgYCArXG4gICAgYFVuaXRzOiAke3RoLmZnKFwidGV4dFwiLCBTdHJpbmcodG90YWxzLnVuaXRzKSl9YCxcbiAgKTtcbiAgbGluZXMucHVzaChcbiAgICBgICBUb29sczogJHt0aC5mZyhcInRleHRcIiwgU3RyaW5nKHRvdGFscy50b29sQ2FsbHMpKX0gIGAgK1xuICAgIGBNZXNzYWdlczogJHt0aC5mZyhcInRleHRcIiwgU3RyaW5nKHRvdGFscy5hc3Npc3RhbnRNZXNzYWdlcykpfSBzZW50IC8gJHt0aC5mZyhcInRleHRcIiwgU3RyaW5nKHRvdGFscy51c2VyTWVzc2FnZXMpKX0gcmVjZWl2ZWRgLFxuICApO1xuICBsaW5lcy5wdXNoKFwiXCIpO1xuXG4gIGNvbnN0IGJhcldpZHRoID0gTWF0aC5tYXgoMTAsIHdpZHRoIC0gNDApO1xuXG4gIC8vIEJ5IFBoYXNlXG4gIGlmIChkYXRhLmJ5UGhhc2UubGVuZ3RoID4gMCkge1xuICAgIGxpbmVzLnB1c2godGguZmcoXCJhY2NlbnRcIiwgdGguYm9sZChcIkJ5IFBoYXNlXCIpKSk7XG4gICAgbGluZXMucHVzaChcIlwiKTtcblxuICAgIGNvbnN0IG1heFBoYXNlQ29zdCA9IE1hdGgubWF4KC4uLmRhdGEuYnlQaGFzZS5tYXAoKHApID0+IHAuY29zdCkpO1xuXG4gICAgZm9yIChjb25zdCBwaGFzZSBvZiBkYXRhLmJ5UGhhc2UpIHtcbiAgICAgIGNvbnN0IHBjdCA9IHRvdGFscy5jb3N0ID4gMCA/IChwaGFzZS5jb3N0IC8gdG90YWxzLmNvc3QpICogMTAwIDogMDtcbiAgICAgIGNvbnN0IGZpbGxMZW4gPVxuICAgICAgICBtYXhQaGFzZUNvc3QgPiAwXG4gICAgICAgICAgPyBNYXRoLnJvdW5kKChwaGFzZS5jb3N0IC8gbWF4UGhhc2VDb3N0KSAqIGJhcldpZHRoKVxuICAgICAgICAgIDogMDtcbiAgICAgIGNvbnN0IGJhciA9XG4gICAgICAgIHRoLmZnKFwiYWNjZW50XCIsIFwiXFx1MjU4OFwiLnJlcGVhdChmaWxsTGVuKSkgK1xuICAgICAgICB0aC5mZyhcImRpbVwiLCBcIlxcdTI1OTFcIi5yZXBlYXQoYmFyV2lkdGggLSBmaWxsTGVuKSk7XG4gICAgICBjb25zdCBsYWJlbCA9IHBhZFJpZ2h0KHBoYXNlLnBoYXNlLCAxNCk7XG4gICAgICBjb25zdCBjb3N0U3RyID0gZm9ybWF0Q29zdChwaGFzZS5jb3N0KTtcbiAgICAgIGNvbnN0IHBjdFN0ciA9IGAke3BjdC50b0ZpeGVkKDEpfSVgO1xuICAgICAgY29uc3QgdG9rZW5TdHIgPSBmb3JtYXRUb2tlbkNvdW50KHBoYXNlLnRva2Vucy50b3RhbCk7XG4gICAgICBsaW5lcy5wdXNoKGAgICR7bGFiZWx9ICR7YmFyfSAke2Nvc3RTdHJ9ICR7cGN0U3RyfSAke3Rva2VuU3RyfWApO1xuICAgIH1cblxuICAgIGxpbmVzLnB1c2goXCJcIik7XG4gIH1cblxuICAvLyBCeSBNb2RlbFxuICBpZiAoZGF0YS5ieU1vZGVsLmxlbmd0aCA+IDApIHtcbiAgICBsaW5lcy5wdXNoKHRoLmZnKFwiYWNjZW50XCIsIHRoLmJvbGQoXCJCeSBNb2RlbFwiKSkpO1xuICAgIGxpbmVzLnB1c2goXCJcIik7XG5cbiAgICBjb25zdCBtYXhNb2RlbENvc3QgPSBNYXRoLm1heCguLi5kYXRhLmJ5TW9kZWwubWFwKChtKSA9PiBtLmNvc3QpKTtcblxuICAgIGZvciAoY29uc3QgbW9kZWwgb2YgZGF0YS5ieU1vZGVsKSB7XG4gICAgICBjb25zdCBwY3QgPSB0b3RhbHMuY29zdCA+IDAgPyAobW9kZWwuY29zdCAvIHRvdGFscy5jb3N0KSAqIDEwMCA6IDA7XG4gICAgICBjb25zdCBmaWxsTGVuID1cbiAgICAgICAgbWF4TW9kZWxDb3N0ID4gMFxuICAgICAgICAgID8gTWF0aC5yb3VuZCgobW9kZWwuY29zdCAvIG1heE1vZGVsQ29zdCkgKiBiYXJXaWR0aClcbiAgICAgICAgICA6IDA7XG4gICAgICBjb25zdCBiYXIgPVxuICAgICAgICB0aC5mZyhcImFjY2VudFwiLCBcIlxcdTI1ODhcIi5yZXBlYXQoZmlsbExlbikpICtcbiAgICAgICAgdGguZmcoXCJkaW1cIiwgXCJcXHUyNTkxXCIucmVwZWF0KGJhcldpZHRoIC0gZmlsbExlbikpO1xuICAgICAgY29uc3QgbGFiZWwgPSBwYWRSaWdodChtb2RlbC5tb2RlbCwgMjApO1xuICAgICAgY29uc3QgY29zdFN0ciA9IGZvcm1hdENvc3QobW9kZWwuY29zdCk7XG4gICAgICBjb25zdCBwY3RTdHIgPSBgJHtwY3QudG9GaXhlZCgxKX0lYDtcbiAgICAgIGxpbmVzLnB1c2goYCAgJHtsYWJlbH0gJHtiYXJ9ICR7Y29zdFN0cn0gJHtwY3RTdHJ9YCk7XG4gICAgfVxuXG4gICAgbGluZXMucHVzaChcIlwiKTtcbiAgfVxuXG4gIC8vIEJ5IFRpZXJcbiAgaWYgKGRhdGEuYnlUaWVyLmxlbmd0aCA+IDApIHtcbiAgICBsaW5lcy5wdXNoKHRoLmZnKFwiYWNjZW50XCIsIHRoLmJvbGQoXCJCeSBUaWVyXCIpKSk7XG4gICAgbGluZXMucHVzaChcIlwiKTtcblxuICAgIGNvbnN0IG1heFRpZXJDb3N0ID0gTWF0aC5tYXgoLi4uZGF0YS5ieVRpZXIubWFwKCh0KSA9PiB0LmNvc3QpKTtcblxuICAgIGZvciAoY29uc3QgdGllciBvZiBkYXRhLmJ5VGllcikge1xuICAgICAgY29uc3QgcGN0ID0gdG90YWxzLmNvc3QgPiAwID8gKHRpZXIuY29zdCAvIHRvdGFscy5jb3N0KSAqIDEwMCA6IDA7XG4gICAgICBjb25zdCBmaWxsTGVuID1cbiAgICAgICAgbWF4VGllckNvc3QgPiAwXG4gICAgICAgICAgPyBNYXRoLnJvdW5kKCh0aWVyLmNvc3QgLyBtYXhUaWVyQ29zdCkgKiBiYXJXaWR0aClcbiAgICAgICAgICA6IDA7XG4gICAgICBjb25zdCBiYXIgPVxuICAgICAgICB0aC5mZyhcImFjY2VudFwiLCBcIlxcdTI1ODhcIi5yZXBlYXQoZmlsbExlbikpICtcbiAgICAgICAgdGguZmcoXCJkaW1cIiwgXCJcXHUyNTkxXCIucmVwZWF0KGJhcldpZHRoIC0gZmlsbExlbikpO1xuICAgICAgY29uc3QgbGFiZWwgPSBwYWRSaWdodCh0aWVyLnRpZXIsIDEyKTtcbiAgICAgIGNvbnN0IGNvc3RTdHIgPSBmb3JtYXRDb3N0KHRpZXIuY29zdCk7XG4gICAgICBjb25zdCBwY3RTdHIgPSBgJHtwY3QudG9GaXhlZCgxKX0lYDtcbiAgICAgIGNvbnN0IHVuaXRzU3RyID0gYCR7dGllci51bml0c30gdW5pdHNgO1xuICAgICAgbGluZXMucHVzaChgICAke2xhYmVsfSAke2Jhcn0gJHtjb3N0U3RyfSAke3BjdFN0cn0gJHt1bml0c1N0cn1gKTtcbiAgICB9XG5cbiAgICBpZiAoZGF0YS50aWVyU2F2aW5nc0xpbmUpIHtcbiAgICAgIGxpbmVzLnB1c2goYCAgJHt0aC5mZyhcInN1Y2Nlc3NcIiwgZGF0YS50aWVyU2F2aW5nc0xpbmUpfWApO1xuICAgIH1cblxuICAgIGxpbmVzLnB1c2goXCJcIik7XG4gIH1cblxuICAvLyBDb3N0IFByb2plY3Rpb25zXG4gIGxpbmVzLnB1c2goLi4ucmVuZGVyQ29zdFByb2plY3Rpb25zKGRhdGEsIHRoLCB3aWR0aCkpO1xuXG4gIHJldHVybiBsaW5lcztcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIENvc3QgUHJvamVjdGlvbnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIHJlbmRlckNvc3RQcm9qZWN0aW9ucyhkYXRhOiBWaXN1YWxpemVyRGF0YSwgdGg6IFRoZW1lLCBfd2lkdGg6IG51bWJlcik6IHN0cmluZ1tdIHtcbiAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG5cbiAgaWYgKCFkYXRhLnRvdGFscyB8fCBkYXRhLmJ5U2xpY2UubGVuZ3RoID09PSAwKSByZXR1cm4gbGluZXM7XG5cbiAgbGluZXMucHVzaCh0aC5mZyhcImFjY2VudFwiLCB0aC5ib2xkKFwiUHJvamVjdGlvbnNcIikpKTtcbiAgbGluZXMucHVzaChcIlwiKTtcblxuICAvLyBBdmVyYWdlIGNvc3QgcGVyIHNsaWNlXG4gIGNvbnN0IHNsaWNlTGV2ZWxFbnRyaWVzID0gZGF0YS5ieVNsaWNlLmZpbHRlcihzID0+IHMuc2xpY2VJZC5pbmNsdWRlcyhcIi9cIikpO1xuICBpZiAoc2xpY2VMZXZlbEVudHJpZXMubGVuZ3RoIDwgMikge1xuICAgIGxpbmVzLnB1c2godGguZmcoXCJkaW1cIiwgXCIgIEluc3VmZmljaWVudCBkYXRhIGZvciBwcm9qZWN0aW9ucyAobmVlZCAyKyBjb21wbGV0ZWQgc2xpY2VzKS5cIikpO1xuICAgIHJldHVybiBsaW5lcztcbiAgfVxuXG4gIGNvbnN0IHRvdGFsU2xpY2VDb3N0ID0gc2xpY2VMZXZlbEVudHJpZXMucmVkdWNlKChzdW0sIHMpID0+IHN1bSArIHMuY29zdCwgMCk7XG4gIGNvbnN0IGF2Z0Nvc3RQZXJTbGljZSA9IHRvdGFsU2xpY2VDb3N0IC8gc2xpY2VMZXZlbEVudHJpZXMubGVuZ3RoO1xuICBjb25zdCBwcm9qZWN0ZWRSZW1haW5pbmcgPSBhdmdDb3N0UGVyU2xpY2UgKiBkYXRhLnJlbWFpbmluZ1NsaWNlQ291bnQ7XG5cbiAgbGluZXMucHVzaChgICBBdmcgY29zdC9zbGljZTogJHt0aC5mZyhcInRleHRcIiwgZm9ybWF0Q29zdChhdmdDb3N0UGVyU2xpY2UpKX1gKTtcbiAgbGluZXMucHVzaChcbiAgICBgICBQcm9qZWN0ZWQgcmVtYWluaW5nOiAke3RoLmZnKFwidGV4dFwiLCBmb3JtYXRDb3N0KHByb2plY3RlZFJlbWFpbmluZykpfSBgICtcbiAgICBgKCR7Zm9ybWF0Q29zdChhdmdDb3N0UGVyU2xpY2UpfS9zbGljZSBcXHUwMGQ3ICR7ZGF0YS5yZW1haW5pbmdTbGljZUNvdW50fSByZW1haW5pbmcpYCxcbiAgKTtcblxuICAvLyBCdXJuIHJhdGVcbiAgaWYgKGRhdGEudG90YWxzLmR1cmF0aW9uID4gMCkge1xuICAgIGNvbnN0IGNvc3RQZXJIb3VyID0gZGF0YS50b3RhbHMuY29zdCAvIChkYXRhLnRvdGFscy5kdXJhdGlvbiAvIDNfNjAwXzAwMCk7XG4gICAgbGluZXMucHVzaChgICBCdXJuIHJhdGU6ICR7dGguZmcoXCJ0ZXh0XCIsIGZvcm1hdENvc3QoY29zdFBlckhvdXIpICsgXCIvaHJcIil9YCk7XG4gIH1cblxuICAvLyBTcGFya2xpbmUgb2YgcGVyLXNsaWNlIGNvc3RzXG4gIGNvbnN0IHNsaWNlQ29zdHMgPSBzbGljZUxldmVsRW50cmllcy5tYXAocyA9PiBzLmNvc3QpO1xuICBpZiAoc2xpY2VDb3N0cy5sZW5ndGggPiAwKSB7XG4gICAgY29uc3Qgc3BhcmsgPSBzcGFya2xpbmUoc2xpY2VDb3N0cyk7XG4gICAgbGluZXMucHVzaChgICBDb3N0IHRyZW5kOiAke3NwYXJrfWApO1xuICB9XG5cbiAgLy8gQnVkZ2V0IHdhcm5pbmc6IHByb2plY3RlZCB0b3RhbCA+IDJ4IGN1cnJlbnQgc3BlbmRcbiAgY29uc3QgcHJvamVjdGVkVG90YWwgPSBkYXRhLnRvdGFscy5jb3N0ICsgcHJvamVjdGVkUmVtYWluaW5nO1xuICBpZiAocHJvamVjdGVkVG90YWwgPiAyICogZGF0YS50b3RhbHMuY29zdCAmJiBkYXRhLnJlbWFpbmluZ1NsaWNlQ291bnQgPiAwKSB7XG4gICAgbGluZXMucHVzaCh0aC5mZyhcIndhcm5pbmdcIiwgYCAgXFx1MjZhMCBQcm9qZWN0ZWQgdG90YWwgJHtmb3JtYXRDb3N0KHByb2plY3RlZFRvdGFsKX0gZXhjZWVkcyAyXFx1MDBkNyBjdXJyZW50IHNwZW5kYCkpO1xuICB9XG5cbiAgcmV0dXJuIGxpbmVzO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGltZWxpbmUgVmlldyAoR2FudHQpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgZnVuY3Rpb24gcmVuZGVyVGltZWxpbmVWaWV3KFxuICBkYXRhOiBWaXN1YWxpemVyRGF0YSxcbiAgdGg6IFRoZW1lLFxuICB3aWR0aDogbnVtYmVyLFxuKTogc3RyaW5nW10ge1xuICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcblxuICBpZiAoZGF0YS51bml0cy5sZW5ndGggPT09IDApIHtcbiAgICBsaW5lcy5wdXNoKHRoLmZnKFwiZGltXCIsIFwiTm8gZXhlY3V0aW9uIGhpc3RvcnkuXCIpKTtcbiAgICByZXR1cm4gbGluZXM7XG4gIH1cblxuICAvLyBHYW50dCBtb2RlIGZvciB3aWRlIHRlcm1pbmFscywgbGlzdCBtb2RlIGZvciBuYXJyb3dcbiAgaWYgKHdpZHRoID49IDkwKSB7XG4gICAgcmV0dXJuIHJlbmRlckdhbnR0VmlldyhkYXRhLCB0aCwgd2lkdGgpO1xuICB9XG5cbiAgcmV0dXJuIHJlbmRlclRpbWVsaW5lTGlzdChkYXRhLCB0aCwgd2lkdGgpO1xufVxuXG5mdW5jdGlvbiBzaG9ydGVuTW9kZWwobW9kZWw6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBtb2RlbC5yZXBsYWNlKC9eY2xhdWRlLS8sIFwiXCIpLnNsaWNlKDAsIDEyKTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyVGltZWxpbmVMaXN0KGRhdGE6IFZpc3VhbGl6ZXJEYXRhLCB0aDogVGhlbWUsIHdpZHRoOiBudW1iZXIpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuXG4gIC8vIFNob3cgdXAgdG8gMjAgbW9zdCByZWNlbnQgKHVuaXRzIGFyZSBzb3J0ZWQgYnkgc3RhcnRlZEF0IGFzYywgc2hvdyBtb3N0IHJlY2VudClcbiAgY29uc3QgcmVjZW50ID0gZGF0YS51bml0cy5zbGljZSgtMjApLnJldmVyc2UoKTtcblxuICBjb25zdCBtYXhEdXJhdGlvbiA9IE1hdGgubWF4KFxuICAgIC4uLnJlY2VudC5tYXAoKHUpID0+IHUuZmluaXNoZWRBdCAtIHUuc3RhcnRlZEF0KSxcbiAgKTtcbiAgY29uc3QgdGltZUJhcldpZHRoID0gTWF0aC5tYXgoNCwgTWF0aC5taW4oMTIsIHdpZHRoIC0gNjApKTtcblxuICBmb3IgKGNvbnN0IHVuaXQgb2YgcmVjZW50KSB7XG4gICAgY29uc3QgZHQgPSBuZXcgRGF0ZSh1bml0LnN0YXJ0ZWRBdCk7XG4gICAgY29uc3QgaGggPSBTdHJpbmcoZHQuZ2V0SG91cnMoKSkucGFkU3RhcnQoMiwgXCIwXCIpO1xuICAgIGNvbnN0IG1tID0gU3RyaW5nKGR0LmdldE1pbnV0ZXMoKSkucGFkU3RhcnQoMiwgXCIwXCIpO1xuICAgIGNvbnN0IHRpbWUgPSBgJHtoaH06JHttbX1gO1xuXG4gICAgY29uc3QgZHVyYXRpb24gPSB1bml0LmZpbmlzaGVkQXQgLSB1bml0LnN0YXJ0ZWRBdDtcbiAgICBjb25zdCB1bml0U3RhdHVzID0gdW5pdC5maW5pc2hlZEF0ID4gMCA/IFwiZG9uZVwiIDogXCJhY3RpdmVcIjtcbiAgICBjb25zdCBnbHlwaCA9IHRoLmZnKFNUQVRVU19DT0xPUlt1bml0U3RhdHVzXSwgU1RBVFVTX0dMWVBIW3VuaXRTdGF0dXNdKTtcblxuICAgIGNvbnN0IHR5cGVMYWJlbCA9IHBhZFJpZ2h0KHVuaXQudHlwZSwgMTYpO1xuICAgIGNvbnN0IGlkTGFiZWwgPSBwYWRSaWdodCh1bml0LmlkLCAxNCk7XG5cbiAgICBjb25zdCBmaWxsTGVuID1cbiAgICAgIG1heER1cmF0aW9uID4gMFxuICAgICAgICA/IE1hdGgucm91bmQoKGR1cmF0aW9uIC8gbWF4RHVyYXRpb24pICogdGltZUJhcldpZHRoKVxuICAgICAgICA6IDA7XG4gICAgY29uc3QgYmFyID1cbiAgICAgIHRoLmZnKFwiYWNjZW50XCIsIFwiXFx1MjU4OFwiLnJlcGVhdChmaWxsTGVuKSkgK1xuICAgICAgdGguZmcoXCJkaW1cIiwgXCJcXHUyNTkxXCIucmVwZWF0KHRpbWVCYXJXaWR0aCAtIGZpbGxMZW4pKTtcblxuICAgIGNvbnN0IGR1clN0ciA9IGZvcm1hdER1cmF0aW9uKGR1cmF0aW9uKTtcbiAgICBjb25zdCBjb3N0U3RyID0gZm9ybWF0Q29zdCh1bml0LmNvc3QpO1xuXG4gICAgLy8gVGllciBhbmQgbW9kZWwgaW5mb1xuICAgIGNvbnN0IHRpZXJMYWJlbCA9IHVuaXQudGllciA/IHRoLmZnKFwiZGltXCIsIGBbJHt1bml0LnRpZXJ9XWApIDogXCJcIjtcbiAgICBjb25zdCBtb2RlbExhYmVsID0gdGguZmcoXCJkaW1cIiwgc2hvcnRlbk1vZGVsKHVuaXQubW9kZWwpKTtcbiAgICBjb25zdCB0aWVyTW9kZWxQYXJ0ID0gW3RpZXJMYWJlbCwgbW9kZWxMYWJlbF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oXCIgXCIpO1xuXG4gICAgY29uc3QgbGluZSA9IGAgICR7dGltZX0gICR7Z2x5cGh9ICR7dHlwZUxhYmVsfSAke3RpZXJNb2RlbFBhcnR9ICR7aWRMYWJlbH0gJHtiYXJ9ICAke2R1clN0cn0gICR7Y29zdFN0cn1gO1xuICAgIGxpbmVzLnB1c2godHJ1bmNhdGVUb1dpZHRoKGxpbmUsIHdpZHRoKSk7XG4gIH1cblxuICByZXR1cm4gbGluZXM7XG59XG5cbmZ1bmN0aW9uIHJlbmRlckdhbnR0VmlldyhkYXRhOiBWaXN1YWxpemVyRGF0YSwgdGg6IFRoZW1lLCB3aWR0aDogbnVtYmVyKTogc3RyaW5nW10ge1xuICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgcmVjZW50ID0gZGF0YS51bml0cy5zbGljZSgtMjApO1xuICBpZiAocmVjZW50Lmxlbmd0aCA9PT0gMCkgcmV0dXJuIGxpbmVzO1xuXG4gIGNvbnN0IGZpbmlzaGVkVW5pdHMgPSByZWNlbnQuZmlsdGVyKHUgPT4gdS5maW5pc2hlZEF0ID4gMCk7XG4gIGlmIChmaW5pc2hlZFVuaXRzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHJlbmRlclRpbWVsaW5lTGlzdChkYXRhLCB0aCwgd2lkdGgpO1xuXG4gIGNvbnN0IG1pblN0YXJ0ID0gTWF0aC5taW4oLi4ucmVjZW50Lm1hcCh1ID0+IHUuc3RhcnRlZEF0KSk7XG4gIGNvbnN0IG1heEVuZCA9IE1hdGgubWF4KC4uLnJlY2VudC5tYXAodSA9PiB1LmZpbmlzaGVkQXQgPiAwID8gdS5maW5pc2hlZEF0IDogRGF0ZS5ub3coKSkpO1xuICBjb25zdCB0b3RhbFNwYW4gPSBtYXhFbmQgLSBtaW5TdGFydDtcbiAgaWYgKHRvdGFsU3BhbiA8PSAwKSByZXR1cm4gcmVuZGVyVGltZWxpbmVMaXN0KGRhdGEsIHRoLCB3aWR0aCk7XG5cbiAgY29uc3QgZ3V0dGVyV2lkdGggPSAyMDtcbiAgY29uc3QgYmFyQXJlYSA9IE1hdGgubWF4KDEwLCB3aWR0aCAtIGd1dHRlcldpZHRoIC0gMjUpO1xuXG4gIC8vIFRpbWUgYXhpcyBsYWJlbHNcbiAgY29uc3Qgc3RhcnRMYWJlbCA9IGZvcm1hdFRpbWVMYWJlbChtaW5TdGFydCk7XG4gIGNvbnN0IGVuZExhYmVsID0gZm9ybWF0VGltZUxhYmVsKG1heEVuZCk7XG4gIGxpbmVzLnB1c2goXG4gICAgYCR7XCIgXCIucmVwZWF0KGd1dHRlcldpZHRoKX0gJHt0aC5mZyhcImRpbVwiLCBzdGFydExhYmVsKX1gICtcbiAgICBgJHtcIiBcIi5yZXBlYXQoTWF0aC5tYXgoMSwgYmFyQXJlYSAtIHN0YXJ0TGFiZWwubGVuZ3RoIC0gZW5kTGFiZWwubGVuZ3RoKSl9YCArXG4gICAgYCR7dGguZmcoXCJkaW1cIiwgZW5kTGFiZWwpfWAsXG4gICk7XG5cbiAgLy8gUGhhc2UgdHJhY2tpbmcgZm9yIHNlcGFyYXRvcnNcbiAgbGV0IGxhc3RQaGFzZSA9IFwiXCI7XG5cbiAgZm9yIChjb25zdCB1bml0IG9mIHJlY2VudCkge1xuICAgIGNvbnN0IHBoYXNlID0gY2xhc3NpZnlVbml0UGhhc2UodW5pdC50eXBlKTtcbiAgICBpZiAocGhhc2UgIT09IGxhc3RQaGFzZSAmJiBsYXN0UGhhc2UgIT09IFwiXCIpIHtcbiAgICAgIGxpbmVzLnB1c2godGguZmcoXCJkaW1cIiwgXCIgIFwiICsgXCJcXHUyNTAwXCIucmVwZWF0KHdpZHRoIC0gNCkpKTtcbiAgICB9XG4gICAgbGFzdFBoYXNlID0gcGhhc2U7XG5cbiAgICBjb25zdCBlbmQgPSB1bml0LmZpbmlzaGVkQXQgPiAwID8gdW5pdC5maW5pc2hlZEF0IDogRGF0ZS5ub3coKTtcbiAgICBjb25zdCBzdGFydFBvcyA9IE1hdGgucm91bmQoKCh1bml0LnN0YXJ0ZWRBdCAtIG1pblN0YXJ0KSAvIHRvdGFsU3BhbikgKiBiYXJBcmVhKTtcbiAgICBjb25zdCBlbmRQb3MgPSBNYXRoLnJvdW5kKCgoZW5kIC0gbWluU3RhcnQpIC8gdG90YWxTcGFuKSAqIGJhckFyZWEpO1xuICAgIGNvbnN0IGJhckxlbiA9IE1hdGgubWF4KDEsIGVuZFBvcyAtIHN0YXJ0UG9zKTtcblxuICAgIGNvbnN0IHBoYXNlQ29sb3IgPVxuICAgICAgcGhhc2UgPT09IFwicmVzZWFyY2hcIiA/IFwiZGltXCIgOlxuICAgICAgcGhhc2UgPT09IFwicGxhbm5pbmdcIiA/IFwiYWNjZW50XCIgOlxuICAgICAgcGhhc2UgPT09IFwiZXhlY3V0aW9uXCIgPyBcInN1Y2Nlc3NcIiA6XG4gICAgICBcIndhcm5pbmdcIjtcblxuICAgIGNvbnN0IGJhclN0ciA9XG4gICAgICBcIiBcIi5yZXBlYXQoc3RhcnRQb3MpICtcbiAgICAgIHRoLmZnKHBoYXNlQ29sb3IsIFwiXFx1MjU4OFwiLnJlcGVhdChiYXJMZW4pKSArXG4gICAgICBcIiBcIi5yZXBlYXQoTWF0aC5tYXgoMCwgYmFyQXJlYSAtIHN0YXJ0UG9zIC0gYmFyTGVuKSk7XG5cbiAgICBjb25zdCB0aWVyVGFnID0gdW5pdC50aWVyID8gYFske3VuaXQudGllclswXX1dYCA6IFwiXCI7XG4gICAgY29uc3QgZ3V0dGVyID0gcGFkUmlnaHQoXG4gICAgICB0cnVuY2F0ZVRvV2lkdGgoYCR7dW5pdC50eXBlLnNsaWNlKDAsIDgpfSAke3VuaXQuaWR9JHt0aWVyVGFnfWAsIGd1dHRlcldpZHRoIC0gMSksXG4gICAgICBndXR0ZXJXaWR0aCxcbiAgICApO1xuXG4gICAgY29uc3QgZHVyYXRpb24gPSBlbmQgLSB1bml0LnN0YXJ0ZWRBdDtcbiAgICBjb25zdCBkdXJTdHIgPSBmb3JtYXREdXJhdGlvbihkdXJhdGlvbik7XG4gICAgY29uc3QgY29zdFN0ciA9IGZvcm1hdENvc3QodW5pdC5jb3N0KTtcblxuICAgIGxpbmVzLnB1c2godHJ1bmNhdGVUb1dpZHRoKGAke2d1dHRlcn0ke2JhclN0cn0gJHtkdXJTdHJ9ICR7Y29zdFN0cn1gLCB3aWR0aCkpO1xuICB9XG5cbiAgcmV0dXJuIGxpbmVzO1xufVxuXG5mdW5jdGlvbiBmb3JtYXRUaW1lTGFiZWwodHM6IG51bWJlcik6IHN0cmluZyB7XG4gIGNvbnN0IGR0ID0gbmV3IERhdGUodHMpO1xuICByZXR1cm4gYCR7U3RyaW5nKGR0LmdldEhvdXJzKCkpLnBhZFN0YXJ0KDIsIFwiMFwiKX06JHtTdHJpbmcoZHQuZ2V0TWludXRlcygpKS5wYWRTdGFydCgyLCBcIjBcIil9YDtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEFnZW50IFZpZXcgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJBZ2VudFZpZXcoXG4gIGRhdGE6IFZpc3VhbGl6ZXJEYXRhLFxuICB0aDogVGhlbWUsXG4gIHdpZHRoOiBudW1iZXIsXG4pOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBhY3Rpdml0eSA9IGRhdGEuYWdlbnRBY3Rpdml0eTtcblxuICBpZiAoIWFjdGl2aXR5KSB7XG4gICAgbGluZXMucHVzaCh0aC5mZyhcImRpbVwiLCBcIk5vIGFnZW50IGFjdGl2aXR5IGRhdGEuXCIpKTtcbiAgICByZXR1cm4gbGluZXM7XG4gIH1cblxuICAvLyBTdGF0dXMgbGluZVxuICBjb25zdCBhZ2VudFN0YXR1cyA9IGFjdGl2aXR5LmFjdGl2ZSA/IFwiYWN0aXZlXCIgOiBcInBlbmRpbmdcIjtcbiAgY29uc3Qgc3RhdHVzRG90ID0gdGguZmcoU1RBVFVTX0NPTE9SW2FnZW50U3RhdHVzXSwgU1RBVFVTX0dMWVBIW2FnZW50U3RhdHVzXSk7XG4gIGNvbnN0IHN0YXR1c1RleHQgPSBhY3Rpdml0eS5hY3RpdmUgPyBcIkFDVElWRVwiIDogXCJJRExFXCI7XG4gIGNvbnN0IGVsYXBzZWRTdHIgPSBhY3Rpdml0eS5hY3RpdmUgPyBmb3JtYXREdXJhdGlvbihhY3Rpdml0eS5lbGFwc2VkKSA6IFwiXFx1MjAxNFwiO1xuXG4gIGxpbmVzLnB1c2goXG4gICAgam9pbkNvbHVtbnMoXG4gICAgICBgU3RhdHVzOiAke3N0YXR1c0RvdH0gJHtzdGF0dXNUZXh0fWAsXG4gICAgICBgRWxhcHNlZDogJHtlbGFwc2VkU3RyfWAsXG4gICAgICB3aWR0aCxcbiAgICApLFxuICApO1xuXG4gIGlmIChhY3Rpdml0eS5jdXJyZW50VW5pdCkge1xuICAgIGxpbmVzLnB1c2goYEN1cnJlbnQ6ICR7dGguZmcoXCJhY2NlbnRcIiwgYCR7YWN0aXZpdHkuY3VycmVudFVuaXQudHlwZX0gJHthY3Rpdml0eS5jdXJyZW50VW5pdC5pZH1gKX1gKTtcbiAgfSBlbHNlIHtcbiAgICBsaW5lcy5wdXNoKHRoLmZnKFwiZGltXCIsIFwiTm90IGluIGF1dG8gbW9kZVwiKSk7XG4gIH1cblxuICBsaW5lcy5wdXNoKFwiXCIpO1xuXG4gIC8vIFByb2dyZXNzIGJhclxuICBjb25zdCBjb21wbGV0ZWQgPSBhY3Rpdml0eS5jb21wbGV0ZWRVbml0cztcbiAgY29uc3QgdG90YWwgPSBNYXRoLm1heChjb21wbGV0ZWQsIGFjdGl2aXR5LnRvdGFsU2xpY2VzKTtcbiAgaWYgKHRvdGFsID4gMCkge1xuICAgIGNvbnN0IHBjdCA9IE1hdGgubWluKDEsIGNvbXBsZXRlZCAvIHRvdGFsKTtcbiAgICBjb25zdCBiYXJXID0gTWF0aC5tYXgoMTAsIE1hdGgubWluKDMwLCB3aWR0aCAtIDMwKSk7XG4gICAgY29uc3QgZmlsbExlbiA9IE1hdGgucm91bmQocGN0ICogYmFyVyk7XG4gICAgY29uc3QgYmFyID1cbiAgICAgIHRoLmZnKFwiYWNjZW50XCIsIFwiXFx1MjU4OFwiLnJlcGVhdChmaWxsTGVuKSkgK1xuICAgICAgdGguZmcoXCJkaW1cIiwgXCJcXHUyNTkxXCIucmVwZWF0KGJhclcgLSBmaWxsTGVuKSk7XG4gICAgbGluZXMucHVzaChgUHJvZ3Jlc3MgJHtiYXJ9ICR7Y29tcGxldGVkfS8ke3RvdGFsfSBzbGljZXNgKTtcbiAgfVxuXG4gIC8vIFJhdGUgYW5kIHNlc3Npb24gc3RhdHNcbiAgY29uc3QgcmF0ZVN0ciA9IGFjdGl2aXR5LmNvbXBsZXRpb25SYXRlID4gMFxuICAgID8gYCR7YWN0aXZpdHkuY29tcGxldGlvblJhdGUudG9GaXhlZCgxKX0gdW5pdHMvaHJgXG4gICAgOiBcIlxcdTIwMTRcIjtcbiAgbGluZXMucHVzaChcbiAgICBgUmF0ZTogJHt0aC5mZyhcInRleHRcIiwgcmF0ZVN0cil9ICAgIGAgK1xuICAgIGBTZXNzaW9uOiAke3RoLmZnKFwidGV4dFwiLCBmb3JtYXRDb3N0KGFjdGl2aXR5LnNlc3Npb25Db3N0KSl9ICBgICtcbiAgICBgJHt0aC5mZyhcInRleHRcIiwgZm9ybWF0VG9rZW5Db3VudChhY3Rpdml0eS5zZXNzaW9uVG9rZW5zKSl9IHRva2Vuc2AsXG4gICk7XG5cbiAgbGluZXMucHVzaChcIlwiKTtcblxuICAvLyBCdWRnZXQgcHJlc3N1cmVcbiAgY29uc3QgaGVhbHRoID0gZGF0YS5oZWFsdGg7XG4gIGNvbnN0IHRydW5jQ29sb3IgPSBoZWFsdGgudHJ1bmNhdGlvblJhdGUgPCAxMCA/IFwic3VjY2Vzc1wiIDogaGVhbHRoLnRydW5jYXRpb25SYXRlIDwgMzAgPyBcIndhcm5pbmdcIiA6IFwiZXJyb3JcIjtcbiAgY29uc3QgY29udENvbG9yID0gaGVhbHRoLmNvbnRpbnVlSGVyZVJhdGUgPCAxMCA/IFwic3VjY2Vzc1wiIDogaGVhbHRoLmNvbnRpbnVlSGVyZVJhdGUgPCAzMCA/IFwid2FybmluZ1wiIDogXCJlcnJvclwiO1xuICBsaW5lcy5wdXNoKHRoLmZnKFwiYWNjZW50XCIsIHRoLmJvbGQoXCJQcmVzc3VyZVwiKSkpO1xuICBsaW5lcy5wdXNoKGAgIFRydW5jYXRpb24gcmF0ZTogJHt0aC5mZyh0cnVuY0NvbG9yLCBgJHtoZWFsdGgudHJ1bmNhdGlvblJhdGUudG9GaXhlZCgxKX0lYCl9YCk7XG4gIGxpbmVzLnB1c2goYCAgQ29udGludWUtaGVyZSByYXRlOiAke3RoLmZnKGNvbnRDb2xvciwgYCR7aGVhbHRoLmNvbnRpbnVlSGVyZVJhdGUudG9GaXhlZCgxKX0lYCl9YCk7XG5cbiAgLy8gUGVuZGluZyBjYXB0dXJlc1xuICBpZiAoZGF0YS5jYXB0dXJlcy5wZW5kaW5nQ291bnQgPiAwKSB7XG4gICAgbGluZXMucHVzaChgICBQZW5kaW5nIGNhcHR1cmVzOiAke3RoLmZnKFwid2FybmluZ1wiLCBTdHJpbmcoZGF0YS5jYXB0dXJlcy5wZW5kaW5nQ291bnQpKX1gKTtcbiAgfVxuXG4gIGxpbmVzLnB1c2goXCJcIik7XG5cbiAgLy8gUmVjZW50IGNvbXBsZXRlZCB1bml0cyAobGFzdCA1KVxuICBjb25zdCByZWNlbnRVbml0cyA9IGRhdGEudW5pdHMuZmlsdGVyKHUgPT4gdS5maW5pc2hlZEF0ID4gMCkuc2xpY2UoLTUpLnJldmVyc2UoKTtcbiAgaWYgKHJlY2VudFVuaXRzLmxlbmd0aCA+IDApIHtcbiAgICBsaW5lcy5wdXNoKHRoLmZnKFwiYWNjZW50XCIsIHRoLmJvbGQoXCJSZWNlbnQgKGxhc3QgNSk6XCIpKSk7XG4gICAgZm9yIChjb25zdCB1IG9mIHJlY2VudFVuaXRzKSB7XG4gICAgICBjb25zdCBkdCA9IG5ldyBEYXRlKHUuc3RhcnRlZEF0KTtcbiAgICAgIGNvbnN0IGhoID0gU3RyaW5nKGR0LmdldEhvdXJzKCkpLnBhZFN0YXJ0KDIsIFwiMFwiKTtcbiAgICAgIGNvbnN0IG1tID0gU3RyaW5nKGR0LmdldE1pbnV0ZXMoKSkucGFkU3RhcnQoMiwgXCIwXCIpO1xuICAgICAgY29uc3QgZHVyID0gZm9ybWF0RHVyYXRpb24odS5maW5pc2hlZEF0IC0gdS5zdGFydGVkQXQpO1xuICAgICAgY29uc3QgY29zdCA9IGZvcm1hdENvc3QodS5jb3N0KTtcbiAgICAgIGNvbnN0IHR5cGVMYWJlbCA9IHBhZFJpZ2h0KHUudHlwZSwgMTYpO1xuICAgICAgbGluZXMucHVzaChcbiAgICAgICAgdHJ1bmNhdGVUb1dpZHRoKFxuICAgICAgICAgIGAgICR7aGh9OiR7bW19ICAke3RoLmZnKFNUQVRVU19DT0xPUi5kb25lLCBTVEFUVVNfR0xZUEguZG9uZSl9ICR7dHlwZUxhYmVsfSAke3BhZFJpZ2h0KHUuaWQsIDE2KX0gJHtkdXJ9ICAke2Nvc3R9YCxcbiAgICAgICAgICB3aWR0aCxcbiAgICAgICAgKSxcbiAgICAgICk7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIGxpbmVzLnB1c2godGguZmcoXCJkaW1cIiwgXCJObyBjb21wbGV0ZWQgdW5pdHMgeWV0LlwiKSk7XG4gIH1cblxuICByZXR1cm4gbGluZXM7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBDaGFuZ2Vsb2cgVmlldyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlckNoYW5nZWxvZ1ZpZXcoXG4gIGRhdGE6IFZpc3VhbGl6ZXJEYXRhLFxuICB0aDogVGhlbWUsXG4gIHdpZHRoOiBudW1iZXIsXG4pOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBjaGFuZ2Vsb2cgPSBkYXRhLmNoYW5nZWxvZztcblxuICBpZiAoY2hhbmdlbG9nLmVudHJpZXMubGVuZ3RoID09PSAwKSB7XG4gICAgbGluZXMucHVzaCh0aC5mZyhcImRpbVwiLCBcIk5vIGNvbXBsZXRlZCBzbGljZXMgeWV0LlwiKSk7XG4gICAgcmV0dXJuIGxpbmVzO1xuICB9XG5cbiAgbGluZXMucHVzaCh0aC5mZyhcImFjY2VudFwiLCB0aC5ib2xkKFwiQ2hhbmdlc1wiKSkpO1xuICBsaW5lcy5wdXNoKFwiXCIpO1xuXG4gIGZvciAoY29uc3QgZW50cnkgb2YgY2hhbmdlbG9nLmVudHJpZXMpIHtcbiAgICBjb25zdCBoZWFkZXIgPSBgJHtlbnRyeS5taWxlc3RvbmVJZH0vJHtlbnRyeS5zbGljZUlkfTogJHtlbnRyeS50aXRsZX1gO1xuICAgIGxpbmVzLnB1c2godGguZmcoXCJzdWNjZXNzXCIsIGhlYWRlcikpO1xuXG4gICAgaWYgKGVudHJ5Lm9uZUxpbmVyKSB7XG4gICAgICBsaW5lcy5wdXNoKGAgIFwiJHt0aC5mZyhcInRleHRcIiwgZW50cnkub25lTGluZXIpfVwiYCk7XG4gICAgfVxuXG4gICAgaWYgKGVudHJ5LmZpbGVzTW9kaWZpZWQubGVuZ3RoID4gMCkge1xuICAgICAgbGluZXMucHVzaChcIiAgRmlsZXM6XCIpO1xuICAgICAgZm9yIChjb25zdCBmIG9mIGVudHJ5LmZpbGVzTW9kaWZpZWQpIHtcbiAgICAgICAgbGluZXMucHVzaChcbiAgICAgICAgICB0cnVuY2F0ZVRvV2lkdGgoXG4gICAgICAgICAgICBgICAgICR7dGguZmcoU1RBVFVTX0NPTE9SLmRvbmUsIFNUQVRVU19HTFlQSC5kb25lKX0gJHtmLnBhdGh9IFxcdTIwMTQgJHtmLmRlc2NyaXB0aW9ufWAsXG4gICAgICAgICAgICB3aWR0aCxcbiAgICAgICAgICApLFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIERlY2lzaW9ucyBhbmQgcGF0dGVybnMgZnJvbSBzbGljZSB2ZXJpZmljYXRpb25cbiAgICBjb25zdCB2ZXIgPSBmaW5kVmVyaWZpY2F0aW9uKGRhdGEsIGVudHJ5Lm1pbGVzdG9uZUlkLCBlbnRyeS5zbGljZUlkKTtcbiAgICBpZiAodmVyKSB7XG4gICAgICBpZiAodmVyLmtleURlY2lzaW9ucy5sZW5ndGggPiAwKSB7XG4gICAgICAgIGxpbmVzLnB1c2goXCIgIERlY2lzaW9uczpcIik7XG4gICAgICAgIGZvciAoY29uc3QgZCBvZiB2ZXIua2V5RGVjaXNpb25zKSB7XG4gICAgICAgICAgbGluZXMucHVzaChgICAgIC0gJHtkfWApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBpZiAodmVyLnBhdHRlcm5zRXN0YWJsaXNoZWQubGVuZ3RoID4gMCkge1xuICAgICAgICBsaW5lcy5wdXNoKFwiICBQYXR0ZXJuczpcIik7XG4gICAgICAgIGZvciAoY29uc3QgcCBvZiB2ZXIucGF0dGVybnNFc3RhYmxpc2hlZCkge1xuICAgICAgICAgIGxpbmVzLnB1c2goYCAgICAtICR7cH1gKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChlbnRyeS5jb21wbGV0ZWRBdCkge1xuICAgICAgbGluZXMucHVzaCh0aC5mZyhcImRpbVwiLCBgICBDb21wbGV0ZWQ6ICR7ZW50cnkuY29tcGxldGVkQXR9YCkpO1xuICAgIH1cblxuICAgIGxpbmVzLnB1c2goXCJcIik7XG4gIH1cblxuICByZXR1cm4gbGluZXM7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBFeHBvcnQgVmlldyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlckV4cG9ydFZpZXcoXG4gIF9kYXRhOiBWaXN1YWxpemVyRGF0YSxcbiAgdGg6IFRoZW1lLFxuICBfd2lkdGg6IG51bWJlcixcbiAgbGFzdEV4cG9ydFBhdGg/OiBzdHJpbmcsXG4pOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuXG4gIGxpbmVzLnB1c2godGguZmcoXCJhY2NlbnRcIiwgdGguYm9sZChcIkV4cG9ydCBPcHRpb25zXCIpKSk7XG4gIGxpbmVzLnB1c2goXCJcIik7XG4gIGxpbmVzLnB1c2goYCAgJHt0aC5mZyhcImFjY2VudFwiLCBcIlttXVwiKX0gIE1hcmtkb3duIHJlcG9ydCBcXHUyMDE0IGZ1bGwgcHJvamVjdCBzdW1tYXJ5IHdpdGggdGFibGVzYCk7XG4gIGxpbmVzLnB1c2goYCAgJHt0aC5mZyhcImFjY2VudFwiLCBcIltqXVwiKX0gIEpTT04gcmVwb3J0IFxcdTIwMTQgbWFjaGluZS1yZWFkYWJsZSBwcm9qZWN0IGRhdGFgKTtcbiAgbGluZXMucHVzaChgICAke3RoLmZnKFwiYWNjZW50XCIsIFwiW3NdXCIpfSAgU25hcHNob3QgXFx1MjAxNCBjdXJyZW50IHZpZXcgYXMgcGxhaW4gdGV4dGApO1xuXG4gIGlmIChsYXN0RXhwb3J0UGF0aCkge1xuICAgIGxpbmVzLnB1c2goXCJcIik7XG4gICAgbGluZXMucHVzaCh0aC5mZyhcImRpbVwiLCBgTGFzdCBleHBvcnQ6ICR7bGFzdEV4cG9ydFBhdGh9YCkpO1xuICB9XG5cbiAgcmV0dXJuIGxpbmVzO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgS25vd2xlZGdlIFZpZXcgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJLbm93bGVkZ2VWaWV3KFxuICBkYXRhOiBWaXN1YWxpemVyRGF0YSxcbiAgdGg6IFRoZW1lLFxuICB3aWR0aDogbnVtYmVyLFxuKTogc3RyaW5nW10ge1xuICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcbiAgY29uc3Qga25vd2xlZGdlID0gZGF0YS5rbm93bGVkZ2U7XG5cbiAgaWYgKCFrbm93bGVkZ2UuZXhpc3RzKSB7XG4gICAgbGluZXMucHVzaCh0aC5mZyhcImRpbVwiLCBcIk5vIEtOT1dMRURHRS5tZCBmb3VuZFwiKSk7XG4gICAgcmV0dXJuIGxpbmVzO1xuICB9XG5cbiAgaWYgKGtub3dsZWRnZS5ydWxlcy5sZW5ndGggPT09IDAgJiYga25vd2xlZGdlLnBhdHRlcm5zLmxlbmd0aCA9PT0gMCAmJiBrbm93bGVkZ2UubGVzc29ucy5sZW5ndGggPT09IDApIHtcbiAgICBsaW5lcy5wdXNoKHRoLmZnKFwiZGltXCIsIFwiS05PV0xFREdFLm1kIGV4aXN0cyBidXQgaXMgZW1wdHlcIikpO1xuICAgIHJldHVybiBsaW5lcztcbiAgfVxuXG4gIC8vIFJ1bGVzIHNlY3Rpb25cbiAgaWYgKGtub3dsZWRnZS5ydWxlcy5sZW5ndGggPiAwKSB7XG4gICAgbGluZXMucHVzaCh0aC5mZyhcImFjY2VudFwiLCB0aC5ib2xkKFwiUnVsZXNcIikpKTtcbiAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICAgIGZvciAoY29uc3QgcnVsZSBvZiBrbm93bGVkZ2UucnVsZXMpIHtcbiAgICAgIGxpbmVzLnB1c2godHJ1bmNhdGVUb1dpZHRoKFxuICAgICAgICBgICAke3RoLmZnKFwiYWNjZW50XCIsIHJ1bGUuaWQpfSAgJHt0aC5mZyhcImRpbVwiLCBgWyR7cnVsZS5zY29wZX1dYCl9ICAke3J1bGUuY29udGVudH1gLFxuICAgICAgICB3aWR0aCxcbiAgICAgICkpO1xuICAgIH1cbiAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICB9XG5cbiAgLy8gUGF0dGVybnMgc2VjdGlvblxuICBpZiAoa25vd2xlZGdlLnBhdHRlcm5zLmxlbmd0aCA+IDApIHtcbiAgICBsaW5lcy5wdXNoKHRoLmZnKFwiYWNjZW50XCIsIHRoLmJvbGQoXCJQYXR0ZXJuc1wiKSkpO1xuICAgIGxpbmVzLnB1c2goXCJcIik7XG4gICAgZm9yIChjb25zdCBwYXR0ZXJuIG9mIGtub3dsZWRnZS5wYXR0ZXJucykge1xuICAgICAgbGluZXMucHVzaCh0cnVuY2F0ZVRvV2lkdGgoXG4gICAgICAgIGAgICR7dGguZmcoXCJhY2NlbnRcIiwgcGF0dGVybi5pZCl9ICAke3BhdHRlcm4uY29udGVudH1gLFxuICAgICAgICB3aWR0aCxcbiAgICAgICkpO1xuICAgIH1cbiAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICB9XG5cbiAgLy8gTGVzc29ucyBzZWN0aW9uXG4gIGlmIChrbm93bGVkZ2UubGVzc29ucy5sZW5ndGggPiAwKSB7XG4gICAgbGluZXMucHVzaCh0aC5mZyhcImFjY2VudFwiLCB0aC5ib2xkKFwiTGVzc29ucyBMZWFybmVkXCIpKSk7XG4gICAgbGluZXMucHVzaChcIlwiKTtcbiAgICBmb3IgKGNvbnN0IGxlc3NvbiBvZiBrbm93bGVkZ2UubGVzc29ucykge1xuICAgICAgbGluZXMucHVzaCh0cnVuY2F0ZVRvV2lkdGgoXG4gICAgICAgIGAgICR7dGguZmcoXCJhY2NlbnRcIiwgbGVzc29uLmlkKX0gICR7bGVzc29uLmNvbnRlbnR9YCxcbiAgICAgICAgd2lkdGgsXG4gICAgICApKTtcbiAgICB9XG4gICAgbGluZXMucHVzaChcIlwiKTtcbiAgfVxuXG4gIHJldHVybiBsaW5lcztcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIENhcHR1cmVzIFZpZXcgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJDYXB0dXJlc1ZpZXcoXG4gIGRhdGE6IFZpc3VhbGl6ZXJEYXRhLFxuICB0aDogVGhlbWUsXG4gIHdpZHRoOiBudW1iZXIsXG4pOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBjYXB0dXJlcyA9IGRhdGEuY2FwdHVyZXM7XG5cbiAgLy8gU3VtbWFyeSBsaW5lXG4gIGNvbnN0IHJlc29sdmVkID0gY2FwdHVyZXMuZW50cmllcy5maWx0ZXIoZSA9PiBlLnN0YXR1cyA9PT0gXCJyZXNvbHZlZFwiKS5sZW5ndGg7XG4gIGxpbmVzLnB1c2goXG4gICAgYCR7dGguZmcoXCJ0ZXh0XCIsIFN0cmluZyhjYXB0dXJlcy50b3RhbENvdW50KSl9IHRvdGFsIFxcdTAwYjcgYCArXG4gICAgYCR7dGguZmcoXCJ3YXJuaW5nXCIsIFN0cmluZyhjYXB0dXJlcy5wZW5kaW5nQ291bnQpKX0gcGVuZGluZyBcXHUwMGI3IGAgK1xuICAgIGAke3RoLmZnKFwiZGltXCIsIFN0cmluZyhyZXNvbHZlZCkpfSByZXNvbHZlZGAsXG4gICk7XG4gIGxpbmVzLnB1c2goXCJcIik7XG5cbiAgaWYgKGNhcHR1cmVzLmVudHJpZXMubGVuZ3RoID09PSAwKSB7XG4gICAgbGluZXMucHVzaCh0aC5mZyhcImRpbVwiLCBcIk5vIGNhcHR1cmVzIHJlY29yZGVkLlwiKSk7XG4gICAgcmV0dXJuIGxpbmVzO1xuICB9XG5cbiAgLy8gR3JvdXAgYnkgc3RhdHVzOiBwZW5kaW5nIGZpcnN0LCB0aGVuIHRyaWFnZWQsIHRoZW4gcmVzb2x2ZWRcbiAgY29uc3Qgc3RhdHVzT3JkZXI6IFJlY29yZDxzdHJpbmcsIG51bWJlcj4gPSB7IHBlbmRpbmc6IDAsIHRyaWFnZWQ6IDEsIHJlc29sdmVkOiAyIH07XG4gIGNvbnN0IHNvcnRlZCA9IFsuLi5jYXB0dXJlcy5lbnRyaWVzXS5zb3J0KChhLCBiKSA9PlxuICAgIChzdGF0dXNPcmRlclthLnN0YXR1c10gPz8gMykgLSAoc3RhdHVzT3JkZXJbYi5zdGF0dXNdID8/IDMpLFxuICApO1xuXG4gIGZvciAoY29uc3QgZW50cnkgb2Ygc29ydGVkKSB7XG4gICAgY29uc3Qgc3RhdHVzQ29sb3IgPVxuICAgICAgZW50cnkuc3RhdHVzID09PSBcInBlbmRpbmdcIiA/IFwid2FybmluZ1wiIDpcbiAgICAgIGVudHJ5LnN0YXR1cyA9PT0gXCJ0cmlhZ2VkXCIgPyBcImFjY2VudFwiIDpcbiAgICAgIFwiZGltXCI7XG5cbiAgICBjb25zdCBjbGFzc0NvbG9yID1cbiAgICAgIGVudHJ5LmNsYXNzaWZpY2F0aW9uID09PSBcImluamVjdFwiID8gXCJ3YXJuaW5nXCIgOlxuICAgICAgZW50cnkuY2xhc3NpZmljYXRpb24gPT09IFwicXVpY2stdGFza1wiID8gXCJhY2NlbnRcIiA6XG4gICAgICBlbnRyeS5jbGFzc2lmaWNhdGlvbiA9PT0gXCJyZXBsYW5cIiA/IFwiZXJyb3JcIiA6XG4gICAgICBlbnRyeS5jbGFzc2lmaWNhdGlvbiA9PT0gXCJkZWZlclwiID8gXCJ0ZXh0XCIgOlxuICAgICAgXCJkaW1cIjtcblxuICAgIGNvbnN0IGNsYXNzQmFkZ2UgPSBlbnRyeS5jbGFzc2lmaWNhdGlvblxuICAgICAgPyB0aC5mZyhjbGFzc0NvbG9yLCBgKCR7ZW50cnkuY2xhc3NpZmljYXRpb259KWApXG4gICAgICA6IFwiXCI7XG5cbiAgICBjb25zdCBzdGF0dXNCYWRnZSA9IHRoLmZnKHN0YXR1c0NvbG9yLCBgWyR7ZW50cnkuc3RhdHVzfV1gKTtcbiAgICBjb25zdCB0ZXh0UHJldmlldyA9IHRydW5jYXRlVG9XaWR0aChlbnRyeS50ZXh0LCBNYXRoLm1heCgyMCwgd2lkdGggLSA1MCkpO1xuXG4gICAgbGluZXMucHVzaChgICAke3RoLmZnKFwiYWNjZW50XCIsIGVudHJ5LmlkKX0gJHtzdGF0dXNCYWRnZX0gJHt0ZXh0UHJldmlld30gJHtjbGFzc0JhZGdlfWApO1xuICAgIGlmIChlbnRyeS50aW1lc3RhbXApIHtcbiAgICAgIGxpbmVzLnB1c2goYCAgICAke3RoLmZnKFwiZGltXCIsIGVudHJ5LnRpbWVzdGFtcCl9YCk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGxpbmVzO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgSGVhbHRoIFZpZXcgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJIZWFsdGhWaWV3KFxuICBkYXRhOiBWaXN1YWxpemVyRGF0YSxcbiAgdGg6IFRoZW1lLFxuICB3aWR0aDogbnVtYmVyLFxuKTogc3RyaW5nW10ge1xuICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgaGVhbHRoID0gZGF0YS5oZWFsdGg7XG5cbiAgLy8gQnVkZ2V0IHNlY3Rpb25cbiAgbGluZXMucHVzaCh0aC5mZyhcImFjY2VudFwiLCB0aC5ib2xkKFwiQnVkZ2V0XCIpKSk7XG4gIGxpbmVzLnB1c2goXCJcIik7XG4gIGlmIChoZWFsdGguYnVkZ2V0Q2VpbGluZyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgY29uc3QgY3VycmVudFNwZW5kID0gZGF0YS50b3RhbHM/LmNvc3QgPz8gMDtcbiAgICBjb25zdCBwY3QgPSBoZWFsdGguYnVkZ2V0Q2VpbGluZyA+IDAgPyBNYXRoLm1pbigxLCBjdXJyZW50U3BlbmQgLyBoZWFsdGguYnVkZ2V0Q2VpbGluZykgOiAwO1xuICAgIGNvbnN0IGJhclcgPSBNYXRoLm1heCgxMCwgTWF0aC5taW4oMzAsIHdpZHRoIC0gNDApKTtcbiAgICBjb25zdCBmaWxsTGVuID0gTWF0aC5yb3VuZChwY3QgKiBiYXJXKTtcbiAgICBjb25zdCBidWRnZXRDb2xvciA9IHBjdCA8IDAuNyA/IFwic3VjY2Vzc1wiIDogcGN0IDwgMC45ID8gXCJ3YXJuaW5nXCIgOiBcImVycm9yXCI7XG4gICAgY29uc3QgYmFyID1cbiAgICAgIHRoLmZnKGJ1ZGdldENvbG9yLCBcIlxcdTI1ODhcIi5yZXBlYXQoZmlsbExlbikpICtcbiAgICAgIHRoLmZnKFwiZGltXCIsIFwiXFx1MjU5MVwiLnJlcGVhdChiYXJXIC0gZmlsbExlbikpO1xuICAgIGxpbmVzLnB1c2goYCAgQ2VpbGluZzogJHt0aC5mZyhcInRleHRcIiwgZm9ybWF0Q29zdChoZWFsdGguYnVkZ2V0Q2VpbGluZykpfWApO1xuICAgIGxpbmVzLnB1c2goYCAgU3BlbmQ6ICAgJHtiYXJ9ICR7Zm9ybWF0Q29zdChjdXJyZW50U3BlbmQpfSAoJHsocGN0ICogMTAwKS50b0ZpeGVkKDEpfSUpYCk7XG4gIH0gZWxzZSB7XG4gICAgbGluZXMucHVzaCh0aC5mZyhcImRpbVwiLCBcIiAgTm8gYnVkZ2V0IGNlaWxpbmcgc2V0XCIpKTtcbiAgfVxuICBsaW5lcy5wdXNoKGAgIFRva2VuIHByb2ZpbGU6ICR7dGguZmcoXCJ0ZXh0XCIsIGhlYWx0aC50b2tlblByb2ZpbGUpfWApO1xuICBsaW5lcy5wdXNoKFwiXCIpO1xuXG4gIC8vIFByZXNzdXJlIHNlY3Rpb25cbiAgbGluZXMucHVzaCh0aC5mZyhcImFjY2VudFwiLCB0aC5ib2xkKFwiUHJlc3N1cmVcIikpKTtcbiAgbGluZXMucHVzaChcIlwiKTtcbiAgY29uc3QgdHJ1bmNDb2xvciA9IGhlYWx0aC50cnVuY2F0aW9uUmF0ZSA8IDEwID8gXCJzdWNjZXNzXCIgOiBoZWFsdGgudHJ1bmNhdGlvblJhdGUgPCAzMCA/IFwid2FybmluZ1wiIDogXCJlcnJvclwiO1xuICBjb25zdCBjb250Q29sb3IgPSBoZWFsdGguY29udGludWVIZXJlUmF0ZSA8IDEwID8gXCJzdWNjZXNzXCIgOiBoZWFsdGguY29udGludWVIZXJlUmF0ZSA8IDMwID8gXCJ3YXJuaW5nXCIgOiBcImVycm9yXCI7XG4gIGNvbnN0IHByZXNzQmFyVyA9IE1hdGgubWF4KDEwLCBNYXRoLm1pbigyMCwgd2lkdGggLSA1MCkpO1xuXG4gIGNvbnN0IHRydW5jRmlsbCA9IE1hdGgucm91bmQoKE1hdGgubWluKGhlYWx0aC50cnVuY2F0aW9uUmF0ZSwgMTAwKSAvIDEwMCkgKiBwcmVzc0JhclcpO1xuICBjb25zdCB0cnVuY0JhciA9IHRoLmZnKHRydW5jQ29sb3IsIFwiXFx1MjU4OFwiLnJlcGVhdCh0cnVuY0ZpbGwpKSArIHRoLmZnKFwiZGltXCIsIFwiXFx1MjU5MVwiLnJlcGVhdChwcmVzc0JhclcgLSB0cnVuY0ZpbGwpKTtcbiAgbGluZXMucHVzaChgICBUcnVuY2F0aW9uOiAgICAke3RydW5jQmFyfSAke2hlYWx0aC50cnVuY2F0aW9uUmF0ZS50b0ZpeGVkKDEpfSVgKTtcblxuICBjb25zdCBjb250RmlsbCA9IE1hdGgucm91bmQoKE1hdGgubWluKGhlYWx0aC5jb250aW51ZUhlcmVSYXRlLCAxMDApIC8gMTAwKSAqIHByZXNzQmFyVyk7XG4gIGNvbnN0IGNvbnRCYXIgPSB0aC5mZyhjb250Q29sb3IsIFwiXFx1MjU4OFwiLnJlcGVhdChjb250RmlsbCkpICsgdGguZmcoXCJkaW1cIiwgXCJcXHUyNTkxXCIucmVwZWF0KHByZXNzQmFyVyAtIGNvbnRGaWxsKSk7XG4gIGxpbmVzLnB1c2goYCAgQ29udGludWUtaGVyZTogJHtjb250QmFyfSAke2hlYWx0aC5jb250aW51ZUhlcmVSYXRlLnRvRml4ZWQoMSl9JWApO1xuICBsaW5lcy5wdXNoKFwiXCIpO1xuXG4gIC8vIFJvdXRpbmcgc2VjdGlvblxuICBpZiAoaGVhbHRoLnRpZXJCcmVha2Rvd24ubGVuZ3RoID4gMCkge1xuICAgIGxpbmVzLnB1c2godGguZmcoXCJhY2NlbnRcIiwgdGguYm9sZChcIlJvdXRpbmdcIikpKTtcbiAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICAgIGZvciAoY29uc3QgdGllciBvZiBoZWFsdGgudGllckJyZWFrZG93bikge1xuICAgICAgY29uc3QgZG93blRhZyA9IHRpZXIuZG93bmdyYWRlZCA+IDAgPyB0aC5mZyhcIndhcm5pbmdcIiwgYCAoJHt0aWVyLmRvd25ncmFkZWR9IGRvd25ncmFkZWQpYCkgOiBcIlwiO1xuICAgICAgbGluZXMucHVzaChgICAke3BhZFJpZ2h0KHRpZXIudGllciwgMTIpfSAke3RpZXIudW5pdHN9IHVuaXRzICAke2Zvcm1hdENvc3QodGllci5jb3N0KX0ke2Rvd25UYWd9YCk7XG4gICAgfVxuICAgIGlmIChoZWFsdGgudGllclNhdmluZ3NMaW5lKSB7XG4gICAgICBsaW5lcy5wdXNoKGAgICR7dGguZmcoXCJzdWNjZXNzXCIsIGhlYWx0aC50aWVyU2F2aW5nc0xpbmUpfWApO1xuICAgIH1cbiAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICB9XG5cbiAgLy8gU2Vzc2lvbiBzZWN0aW9uXG4gIGxpbmVzLnB1c2godGguZmcoXCJhY2NlbnRcIiwgdGguYm9sZChcIlNlc3Npb25cIikpKTtcbiAgbGluZXMucHVzaChcIlwiKTtcbiAgbGluZXMucHVzaChgICBUb29sIGNhbGxzOiAke3RoLmZnKFwidGV4dFwiLCBTdHJpbmcoaGVhbHRoLnRvb2xDYWxscykpfWApO1xuICBsaW5lcy5wdXNoKGAgIE1lc3NhZ2VzOiAke3RoLmZnKFwidGV4dFwiLCBTdHJpbmcoaGVhbHRoLmFzc2lzdGFudE1lc3NhZ2VzKSl9IHNlbnQgLyAke3RoLmZnKFwidGV4dFwiLCBTdHJpbmcoaGVhbHRoLnVzZXJNZXNzYWdlcykpfSByZWNlaXZlZGApO1xuXG4gIC8vIEVudmlyb25tZW50IHNlY3Rpb24gXHUyMDE0IGlzc3VlcyBvbmx5IChmcm9tIGRvY3Rvci1lbnZpcm9ubWVudC50cywgIzEyMjEpXG4gIGlmIChoZWFsdGguZW52aXJvbm1lbnRJc3N1ZXM/Lmxlbmd0aCA+IDApIHtcbiAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICAgIGxpbmVzLnB1c2godGguZmcoXCJhY2NlbnRcIiwgdGguYm9sZChcIkVudmlyb25tZW50XCIpKSk7XG4gICAgbGluZXMucHVzaChcIlwiKTtcbiAgICBmb3IgKGNvbnN0IHIgb2YgaGVhbHRoLmVudmlyb25tZW50SXNzdWVzKSB7XG4gICAgICBjb25zdCBpY29uID0gci5zdGF0dXMgPT09IFwiZXJyb3JcIiA/IHRoLmZnKFwiZXJyb3JcIiwgXCJcdTI3MTdcIikgOiB0aC5mZyhcIndhcm5pbmdcIiwgXCJcdTI2QTBcIik7XG4gICAgICBsaW5lcy5wdXNoKGAgICR7aWNvbn0gJHt0aC5mZyhcInRleHRcIiwgci5tZXNzYWdlKX1gKTtcbiAgICAgIGlmIChyLmRldGFpbCkgbGluZXMucHVzaChgICAgICR7dGguZmcoXCJkaW1cIiwgci5kZXRhaWwpfWApO1xuICAgIH1cbiAgfVxuXG4gIC8vIFByb3ZpZGVycyBzZWN0aW9uXG4gIGlmIChoZWFsdGgucHJvdmlkZXJzPy5sZW5ndGggPiAwKSB7XG4gICAgbGluZXMucHVzaChcIlwiKTtcbiAgICBsaW5lcy5wdXNoKHRoLmZnKFwiYWNjZW50XCIsIHRoLmJvbGQoXCJQcm92aWRlcnNcIikpKTtcbiAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICAgIGNvbnN0IGNhdGVnb3J5T3JkZXIgPSBbXCJsbG1cIiwgXCJyZW1vdGVcIiwgXCJzZWFyY2hcIiwgXCJ0b29sXCJdO1xuICAgIGNvbnN0IGNhdGVnb3J5TGFiZWxzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0geyBsbG06IFwiTExNXCIsIHJlbW90ZTogXCJOb3RpZmljYXRpb25zXCIsIHNlYXJjaDogXCJTZWFyY2hcIiwgdG9vbDogXCJUb29sc1wiIH07XG4gICAgY29uc3QgZ3JvdXBlZCA9IG5ldyBNYXA8c3RyaW5nLCB0eXBlb2YgaGVhbHRoLnByb3ZpZGVycz4oKTtcbiAgICBmb3IgKGNvbnN0IHAgb2YgaGVhbHRoLnByb3ZpZGVycykge1xuICAgICAgY29uc3QgY2F0ID0gcC5jYXRlZ29yeTtcbiAgICAgIGlmICghZ3JvdXBlZC5oYXMoY2F0KSkgZ3JvdXBlZC5zZXQoY2F0LCBbXSk7XG4gICAgICBncm91cGVkLmdldChjYXQpIS5wdXNoKHApO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IGNhdCBvZiBjYXRlZ29yeU9yZGVyKSB7XG4gICAgICBjb25zdCBpdGVtcyA9IGdyb3VwZWQuZ2V0KGNhdCk7XG4gICAgICBpZiAoIWl0ZW1zIHx8IGl0ZW1zLmxlbmd0aCA9PT0gMCkgY29udGludWU7XG4gICAgICBsaW5lcy5wdXNoKGAgICR7dGguZmcoXCJkaW1cIiwgY2F0ZWdvcnlMYWJlbHNbY2F0XSA/PyBjYXQpfWApO1xuICAgICAgZm9yIChjb25zdCBwIG9mIGl0ZW1zKSB7XG4gICAgICAgIGNvbnN0IGljb24gPSBwLm9rID8gdGguZmcoXCJzdWNjZXNzXCIsIFwiXHUyNzEzXCIpIDogdGguZmcoXCJlcnJvclwiLCBcIlx1MjcxN1wiKTtcbiAgICAgICAgY29uc3QgbXNnID0gcC5vayA/IHRoLmZnKFwiZGltXCIsIHAubWVzc2FnZSkgOiB0aC5mZyhcInRleHRcIiwgcC5tZXNzYWdlKTtcbiAgICAgICAgbGluZXMucHVzaChgICAgICR7aWNvbn0gJHttc2d9YCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gUHJvZ3Jlc3Mgc2NvcmUgc2VjdGlvbiBcdTIwMTQgY3VycmVudCB0cmFmZmljIGxpZ2h0IHN0YXR1c1xuICBpZiAoaGVhbHRoLnByb2dyZXNzU2NvcmUpIHtcbiAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICAgIGxpbmVzLnB1c2godGguZmcoXCJhY2NlbnRcIiwgdGguYm9sZChcIlByb2dyZXNzIFNjb3JlXCIpKSk7XG4gICAgbGluZXMucHVzaChcIlwiKTtcbiAgICBjb25zdCBwcyA9IGhlYWx0aC5wcm9ncmVzc1Njb3JlO1xuICAgIGNvbnN0IHNjb3JlQ29sb3IgPSBwcy5sZXZlbCA9PT0gXCJncmVlblwiID8gXCJzdWNjZXNzXCIgOiBwcy5sZXZlbCA9PT0gXCJ5ZWxsb3dcIiA/IFwid2FybmluZ1wiIDogXCJlcnJvclwiO1xuICAgIGNvbnN0IHNjb3JlSWNvbiA9IHBzLmxldmVsID09PSBcImdyZWVuXCIgPyBcIlx1MjVDRlwiIDogcHMubGV2ZWwgPT09IFwieWVsbG93XCIgPyBcIlx1MjVEMFwiIDogXCJcdTI1Q0JcIjtcbiAgICBsaW5lcy5wdXNoKGAgICR7dGguZmcoc2NvcmVDb2xvciwgc2NvcmVJY29uKX0gJHt0aC5mZyhzY29yZUNvbG9yLCBwcy5zdW1tYXJ5KX1gKTtcbiAgICBmb3IgKGNvbnN0IHNpZ25hbCBvZiBwcy5zaWduYWxzKSB7XG4gICAgICBjb25zdCBwcmVmaXggPSBzaWduYWwua2luZCA9PT0gXCJwb3NpdGl2ZVwiID8gdGguZmcoXCJzdWNjZXNzXCIsIFwiICBcdTI3MTNcIilcbiAgICAgICAgOiBzaWduYWwua2luZCA9PT0gXCJuZWdhdGl2ZVwiID8gdGguZmcoXCJlcnJvclwiLCBcIiAgXHUyNzE3XCIpXG4gICAgICAgICAgOiB0aC5mZyhcImRpbVwiLCBcIiAgXHUwMEI3XCIpO1xuICAgICAgbGluZXMucHVzaChgICAke3ByZWZpeH0gJHt0aC5mZyhcImRpbVwiLCBzaWduYWwubGFiZWwpfWApO1xuICAgIH1cbiAgfVxuXG4gIC8vIERvY3RvciBoaXN0b3J5IHNlY3Rpb24gXHUyMDE0IHBlcnNpc3RlZCBhY3Jvc3Mgc2Vzc2lvbnNcbiAgY29uc3QgZG9jdG9ySGlzdG9yeSA9IGhlYWx0aC5kb2N0b3JIaXN0b3J5ID8/IFtdO1xuICBpZiAoZG9jdG9ySGlzdG9yeS5sZW5ndGggPiAwKSB7XG4gICAgbGluZXMucHVzaChcIlwiKTtcbiAgICBsaW5lcy5wdXNoKHRoLmZnKFwiYWNjZW50XCIsIHRoLmJvbGQoXCJEb2N0b3IgSGlzdG9yeVwiKSkpO1xuICAgIGxpbmVzLnB1c2goXCJcIik7XG5cbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGRvY3Rvckhpc3Rvcnkuc2xpY2UoMCwgMTApKSB7XG4gICAgICBjb25zdCBpY29uID0gZW50cnkub2sgPyB0aC5mZyhcInN1Y2Nlc3NcIiwgXCJcdTI3MTNcIikgOiB0aC5mZyhcImVycm9yXCIsIFwiXHUyNzE3XCIpO1xuICAgICAgY29uc3QgdHMgPSBlbnRyeS50cy5yZXBsYWNlKFwiVFwiLCBcIiBcIikuc2xpY2UoMCwgMTkpO1xuICAgICAgY29uc3Qgc2NvcGVUYWcgPSBlbnRyeS5zY29wZSA/IHRoLmZnKFwiYWNjZW50XCIsIGAgWyR7ZW50cnkuc2NvcGV9XWApIDogXCJcIjtcbiAgICAgIC8vIFByZWZlciBodW1hbi1yZWFkYWJsZSBzdW1tYXJ5LCBmYWxsIGJhY2sgdG8gY291bnRzXG4gICAgICBjb25zdCBkZXRhaWwgPSBlbnRyeS5zdW1tYXJ5XG4gICAgICAgID8gdGguZmcoXCJ0ZXh0XCIsIGVudHJ5LnN1bW1hcnkpXG4gICAgICAgIDogdGguZmcoXCJ0ZXh0XCIsIGAke2VudHJ5LmVycm9yc30gZXJyb3JzLCAke2VudHJ5Lndhcm5pbmdzfSB3YXJuaW5ncywgJHtlbnRyeS5maXhlc30gZml4ZXNgKTtcbiAgICAgIGxpbmVzLnB1c2goYCAgJHtpY29ufSAke3RoLmZnKFwiZGltXCIsIHRzKX0ke3Njb3BlVGFnfSAgJHtkZXRhaWx9YCk7XG5cbiAgICAgIC8vIFNob3cgaXNzdWUgZGV0YWlscyBpZiBhdmFpbGFibGVcbiAgICAgIGlmIChlbnRyeS5pc3N1ZXMgJiYgZW50cnkuaXNzdWVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgZm9yIChjb25zdCBpc3N1ZSBvZiBlbnRyeS5pc3N1ZXMuc2xpY2UoMCwgMykpIHtcbiAgICAgICAgICBjb25zdCBpc3N1ZVBmeCA9IGlzc3VlLnNldmVyaXR5ID09PSBcImVycm9yXCIgPyB0aC5mZyhcImVycm9yXCIsIFwiICAgIFx1MjcxN1wiKSA6IHRoLmZnKFwid2FybmluZ1wiLCBcIiAgICBcdTI2QTBcIik7XG4gICAgICAgICAgbGluZXMucHVzaChgICAke2lzc3VlUGZ4fSAke3RoLmZnKFwiZGltXCIsIHRydW5jYXRlVG9XaWR0aChpc3N1ZS5tZXNzYWdlLCB3aWR0aCAtIDEyKSl9YCk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGVudHJ5Lmlzc3Vlcy5sZW5ndGggPiAzKSB7XG4gICAgICAgICAgbGluZXMucHVzaChgICAgICR7dGguZmcoXCJkaW1cIiwgYCske2VudHJ5Lmlzc3Vlcy5sZW5ndGggLSAzfSBtb3JlYCl9YCk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gU2hvdyBmaXhlcyBpZiBhdmFpbGFibGVcbiAgICAgIGlmIChlbnRyeS5maXhEZXNjcmlwdGlvbnMgJiYgZW50cnkuZml4RGVzY3JpcHRpb25zLmxlbmd0aCA+IDApIHtcbiAgICAgICAgZm9yIChjb25zdCBmaXggb2YgZW50cnkuZml4RGVzY3JpcHRpb25zLnNsaWNlKDAsIDIpKSB7XG4gICAgICAgICAgbGluZXMucHVzaChgICAgICR7dGguZmcoXCJzdWNjZXNzXCIsIFwiXHUyMUIzXCIpfSAke3RoLmZnKFwiZGltXCIsIHRydW5jYXRlVG9XaWR0aChmaXgsIHdpZHRoIC0gMTIpKX1gKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChkb2N0b3JIaXN0b3J5Lmxlbmd0aCA+IDEwKSB7XG4gICAgICBsaW5lcy5wdXNoKGAgICR7dGguZmcoXCJkaW1cIiwgYC4uLiR7ZG9jdG9ySGlzdG9yeS5sZW5ndGggLSAxMH0gb2xkZXIgZW50cmllc2ApfWApO1xuICAgIH1cbiAgfVxuXG4gIC8vIFNraWxscyBzZWN0aW9uXG4gIGlmIChoZWFsdGguc2tpbGxTdW1tYXJ5Py50b3RhbCA+IDApIHtcbiAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICAgIGxpbmVzLnB1c2godGguZmcoXCJhY2NlbnRcIiwgdGguYm9sZChcIlNraWxsc1wiKSkpO1xuICAgIGxpbmVzLnB1c2goXCJcIik7XG4gICAgY29uc3QgeyB0b3RhbCwgd2FybmluZ0NvdW50LCBjcml0aWNhbENvdW50LCB0b3BJc3N1ZSB9ID0gaGVhbHRoLnNraWxsU3VtbWFyeTtcbiAgICBjb25zdCBpc3N1ZUNvbG9yID0gY3JpdGljYWxDb3VudCA+IDAgPyBcImVycm9yXCIgOiB3YXJuaW5nQ291bnQgPiAwID8gXCJ3YXJuaW5nXCIgOiBcInN1Y2Nlc3NcIjtcbiAgICBjb25zdCBpc3N1ZVRhZyA9IGNyaXRpY2FsQ291bnQgPiAwXG4gICAgICA/IGAke2NyaXRpY2FsQ291bnR9IGNyaXRpY2FsYFxuICAgICAgOiB3YXJuaW5nQ291bnQgPiAwXG4gICAgICAgID8gYCR7d2FybmluZ0NvdW50fSB3YXJuaW5nJHt3YXJuaW5nQ291bnQgPiAxID8gXCJzXCIgOiBcIlwifWBcbiAgICAgICAgOiBcImFsbCBoZWFsdGh5XCI7XG4gICAgbGluZXMucHVzaChgICAke3RoLmZnKFwidGV4dFwiLCBTdHJpbmcodG90YWwpKX0gc2tpbGxzIHRyYWNrZWQgIFx1MDBCNyAgJHt0aC5mZyhpc3N1ZUNvbG9yLCBpc3N1ZVRhZyl9YCk7XG4gICAgaWYgKHRvcElzc3VlKSBsaW5lcy5wdXNoKGAgICR7dGguZmcoXCJ3YXJuaW5nXCIsIFwiXHUyNkEwXCIpfSAke3RoLmZnKFwiZGltXCIsIHRvcElzc3VlKX1gKTtcbiAgICBsaW5lcy5wdXNoKGAgICR7dGguZmcoXCJkaW1cIiwgXCJcdTIxOTIgL2dzZCBza2lsbC1oZWFsdGggZm9yIGZ1bGwgcmVwb3J0XCIpfWApO1xuICB9XG5cbiAgcmV0dXJuIGxpbmVzO1xufVxu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
