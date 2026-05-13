import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { gsdRoot } from "./paths.js";
import { loadJsonFileOrNull } from "./json-persistence.js";
import { currentDirectoryRoot } from "./commands/context.js";
function activityDir(basePath) {
  return join(gsdRoot(basePath), "activity");
}
function debugDir(basePath) {
  return join(gsdRoot(basePath), "debug");
}
function listActivityLogs(basePath) {
  const dir = activityDir(basePath);
  if (!existsSync(dir)) return [];
  const entries = [];
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const match = f.match(/^(\d+)-([\w-]+?)-(M\d[\w-]*)\.jsonl$/);
      if (!match) continue;
      const filePath = join(dir, f);
      let stat;
      try {
        stat = statSync(filePath);
      } catch {
        continue;
      }
      entries.push({
        seq: parseInt(match[1], 10),
        filename: f,
        unitType: match[2],
        unitId: match[3].replace(/-/g, "/"),
        size: stat.size,
        mtime: stat.mtime
      });
    }
  } catch {
  }
  return entries.sort((a, b) => a.seq - b.seq);
}
function listDebugLogs(basePath) {
  const dir = debugDir(basePath);
  if (!existsSync(dir)) return [];
  const entries = [];
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".log")) continue;
      const filePath = join(dir, f);
      let stat;
      try {
        stat = statSync(filePath);
      } catch {
        continue;
      }
      entries.push({ filename: f, size: stat.size, mtime: stat.mtime });
    }
  } catch {
  }
  return entries.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());
}
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
function formatAge(date) {
  const ms = Date.now() - date.getTime();
  const mins = Math.floor(ms / 6e4);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
function summarizeActivityLog(filePath) {
  const result = {
    toolCalls: 0,
    errors: 0,
    filesWritten: /* @__PURE__ */ new Set(),
    commandsRun: [],
    lastReasoning: "",
    entryCount: 0
  };
  let raw;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return { ...result, filesWritten: [] };
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  result.entryCount = lines.length;
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "toolCall" || entry.role === "assistant" && entry.content && Array.isArray(entry.content)) {
      if (entry.type === "toolCall") {
        result.toolCalls++;
        const name = entry.name;
        const args = entry.arguments;
        if (name === "write" || name === "edit") {
          const path = args?.file_path;
          if (path) result.filesWritten.add(path);
        }
        if (name === "bash") {
          const cmd = args?.command;
          if (cmd) result.commandsRun.push({ command: cmd.slice(0, 80), failed: false });
        }
      }
    }
    if (entry.role === "toolResult" && entry.isError) {
      result.errors++;
      if (result.commandsRun.length > 0) {
        result.commandsRun[result.commandsRun.length - 1].failed = true;
      }
    }
    if (entry.role === "assistant" && typeof entry.content === "string") {
      result.lastReasoning = entry.content.slice(0, 200);
    }
  }
  return {
    ...result,
    filesWritten: [...result.filesWritten]
  };
}
function summarizeDebugLog(filePath) {
  const result = {
    events: 0,
    duration: "unknown",
    dispatches: 0,
    errors: []
  };
  let raw;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return result;
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  result.events = lines.length;
  let firstTs = 0;
  let lastTs = 0;
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = entry.ts;
    if (ts) {
      const t = new Date(ts).getTime();
      if (!firstTs) firstTs = t;
      lastTs = t;
    }
    const event = entry.event;
    if (!event) continue;
    if (event === "debug-summary") {
      result.dispatches = entry.dispatches ?? 0;
    }
    if (event.includes("error") || event.includes("failed")) {
      const msg = entry.error ?? entry.message ?? JSON.stringify(entry).slice(0, 100);
      result.errors.push({ event, message: msg });
    }
  }
  if (firstTs && lastTs) {
    const elapsed = lastTs - firstTs;
    const mins = Math.floor(elapsed / 6e4);
    if (mins < 1) result.duration = `${Math.floor(elapsed / 1e3)}s`;
    else if (mins < 60) result.duration = `${mins}m`;
    else result.duration = `${Math.floor(mins / 60)}h ${mins % 60}m`;
  }
  return result;
}
async function handleLogs(args, ctx) {
  const basePath = currentDirectoryRoot();
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const subCmd = parts[0] ?? "";
  if (subCmd === "clear") {
    await handleLogsClear(basePath, ctx);
    return;
  }
  if (subCmd === "debug") {
    const idx = parts[1] ? parseInt(parts[1], 10) : void 0;
    await handleLogsDebug(basePath, ctx, idx);
    return;
  }
  if (subCmd === "tail") {
    const count = parts[1] ? parseInt(parts[1], 10) : 5;
    await handleLogsTail(basePath, ctx, count);
    return;
  }
  if (subCmd && /^\d+$/.test(subCmd)) {
    const seq = parseInt(subCmd, 10);
    await handleLogsShow(basePath, ctx, seq);
    return;
  }
  await handleLogsList(basePath, ctx);
}
async function handleLogsList(basePath, ctx) {
  const activities = listActivityLogs(basePath);
  const debugLogs = listDebugLogs(basePath);
  if (activities.length === 0 && debugLogs.length === 0) {
    ctx.ui.notify(
      "No logs found.\n\nActivity logs are created during auto-mode.\nDebug logs require GSD_DEBUG=1.",
      "info"
    );
    return;
  }
  const lines = [];
  if (activities.length > 0) {
    lines.push("Activity Logs (.gsd/activity/):");
    lines.push("  #   Unit Type         Unit ID              Size    Age");
    lines.push("  " + "\u2500".repeat(70));
    const recent = activities.slice(-15);
    for (const e of recent) {
      const seq = String(e.seq).padStart(3, " ");
      const type = e.unitType.padEnd(18, " ");
      const id = e.unitId.padEnd(20, " ");
      const size = formatSize(e.size).padStart(7, " ");
      const age = formatAge(e.mtime);
      lines.push(`  ${seq} ${type} ${id} ${size}  ${age}`);
    }
    if (activities.length > 15) {
      lines.push(`  ... and ${activities.length - 15} older entries`);
    }
    lines.push("");
    lines.push("  View details: /gsd logs <#>");
  }
  if (debugLogs.length > 0) {
    lines.push("");
    lines.push("Debug Logs (.gsd/debug/):");
    for (let i = 0; i < debugLogs.length; i++) {
      const d = debugLogs[i];
      const size = formatSize(d.size).padStart(7, " ");
      const age = formatAge(d.mtime);
      lines.push(`  ${i + 1}. ${d.filename}  ${size}  ${age}`);
    }
    lines.push("");
    lines.push("  View details: /gsd logs debug <#>");
  }
  const metricsPath = join(gsdRoot(basePath), "metrics.json");
  const isMetrics = (d) => d !== null && typeof d === "object" && "units" in d && Array.isArray(d.units);
  const metrics = loadJsonFileOrNull(metricsPath, isMetrics);
  if (metrics && metrics.units.length > 0) {
    const units = metrics.units;
    const totalCost = units.reduce((sum, u) => sum + (u.cost ?? 0), 0);
    const totalTokens = units.reduce((sum, u) => {
      const t = u.tokens;
      return sum + (t?.total ?? 0);
    }, 0);
    lines.push("");
    lines.push(`Metrics: ${units.length} units tracked \xB7 $${totalCost.toFixed(2)} \xB7 ${(totalTokens / 1e3).toFixed(0)}K tokens`);
  }
  lines.push("");
  lines.push("Tip: Enable debug logging with GSD_DEBUG=1 before /gsd auto");
  ctx.ui.notify(lines.join("\n"), "info");
}
async function handleLogsShow(basePath, ctx, seq) {
  const activities = listActivityLogs(basePath);
  const entry = activities.find((e) => e.seq === seq);
  if (!entry) {
    ctx.ui.notify(`Activity log #${seq} not found. Run /gsd logs to see available logs.`, "warning");
    return;
  }
  const filePath = join(activityDir(basePath), entry.filename);
  const summary = summarizeActivityLog(filePath);
  const lines = [];
  lines.push(`Activity Log #${entry.seq}: ${entry.unitType} \u2014 ${entry.unitId}`);
  lines.push("\u2500".repeat(60));
  lines.push(`File: ${entry.filename}`);
  lines.push(`Size: ${formatSize(entry.size)}  |  Age: ${formatAge(entry.mtime)}`);
  lines.push(`Entries: ${summary.entryCount}  |  Tool calls: ${summary.toolCalls}  |  Errors: ${summary.errors}`);
  if (summary.filesWritten.length > 0) {
    lines.push("");
    lines.push("Files written/edited:");
    for (const f of summary.filesWritten.slice(0, 10)) {
      lines.push(`  ${f}`);
    }
    if (summary.filesWritten.length > 10) {
      lines.push(`  ... and ${summary.filesWritten.length - 10} more`);
    }
  }
  if (summary.commandsRun.length > 0) {
    lines.push("");
    lines.push("Commands run:");
    for (const c of summary.commandsRun.slice(0, 10)) {
      const status = c.failed ? " FAILED" : "";
      lines.push(`  ${c.command}${status}`);
    }
    if (summary.commandsRun.length > 10) {
      lines.push(`  ... and ${summary.commandsRun.length - 10} more`);
    }
  }
  if (summary.errors > 0) {
    lines.push("");
    lines.push(`${summary.errors} error(s) encountered during this unit.`);
  }
  if (summary.lastReasoning) {
    lines.push("");
    lines.push("Last reasoning:");
    lines.push(`  "${summary.lastReasoning}${summary.lastReasoning.length >= 200 ? "..." : ""}"`);
  }
  lines.push("");
  lines.push(`Full log: ${filePath}`);
  ctx.ui.notify(lines.join("\n"), "info");
}
async function handleLogsDebug(basePath, ctx, idx) {
  const debugLogs = listDebugLogs(basePath);
  if (debugLogs.length === 0) {
    ctx.ui.notify(
      "No debug logs found.\n\nEnable debug logging: GSD_DEBUG=1 gsd auto",
      "info"
    );
    return;
  }
  if (idx === void 0) {
    const lines2 = ["Debug Logs (.gsd/debug/):", ""];
    for (let i = 0; i < debugLogs.length; i++) {
      const d = debugLogs[i];
      lines2.push(`  ${i + 1}. ${d.filename}  ${formatSize(d.size)}  ${formatAge(d.mtime)}`);
    }
    lines2.push("");
    lines2.push("View details: /gsd logs debug <#>");
    ctx.ui.notify(lines2.join("\n"), "info");
    return;
  }
  if (idx < 1 || idx > debugLogs.length) {
    ctx.ui.notify(`Debug log #${idx} not found. Available: 1-${debugLogs.length}`, "warning");
    return;
  }
  const entry = debugLogs[idx - 1];
  const filePath = join(debugDir(basePath), entry.filename);
  const summary = summarizeDebugLog(filePath);
  const lines = [];
  lines.push(`Debug Log: ${entry.filename}`);
  lines.push("\u2500".repeat(60));
  lines.push(`Size: ${formatSize(entry.size)}  |  Age: ${formatAge(entry.mtime)}`);
  lines.push(`Events: ${summary.events}  |  Duration: ${summary.duration}  |  Dispatches: ${summary.dispatches}`);
  if (summary.errors.length > 0) {
    lines.push("");
    lines.push("Errors/failures:");
    for (const e of summary.errors.slice(0, 10)) {
      lines.push(`  [${e.event}] ${e.message}`);
    }
    if (summary.errors.length > 10) {
      lines.push(`  ... and ${summary.errors.length - 10} more`);
    }
  }
  lines.push("");
  lines.push(`Full log: ${filePath}`);
  ctx.ui.notify(lines.join("\n"), "info");
}
async function handleLogsTail(basePath, ctx, count) {
  const activities = listActivityLogs(basePath);
  if (activities.length === 0) {
    ctx.ui.notify("No activity logs found. Logs are created during auto-mode.", "info");
    return;
  }
  const recent = activities.slice(-Math.max(1, Math.min(count, 20)));
  const lines = [`Last ${recent.length} activity log(s):`, ""];
  for (const e of recent) {
    const filePath = join(activityDir(basePath), e.filename);
    const summary = summarizeActivityLog(filePath);
    const status = summary.errors > 0 ? `${summary.errors} err` : "ok";
    lines.push(`  #${e.seq} ${e.unitType} ${e.unitId} \u2014 ${summary.toolCalls} tools, ${status}, ${formatAge(e.mtime)}`);
  }
  ctx.ui.notify(lines.join("\n"), "info");
}
async function handleLogsClear(basePath, ctx) {
  let removedActivity = 0;
  let removedDebug = 0;
  const activities = listActivityLogs(basePath);
  const keepRecent = activities.slice(-5);
  const keepSeqs = new Set(keepRecent.map((e) => e.seq));
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1e3;
  for (const e of activities) {
    if (keepSeqs.has(e.seq)) continue;
    if (e.mtime.getTime() < cutoff) {
      try {
        unlinkSync(join(activityDir(basePath), e.filename));
        removedActivity++;
      } catch {
      }
    }
  }
  const debugLogs = listDebugLogs(basePath);
  const keepDebug = debugLogs.slice(-2);
  const keepDebugNames = new Set(keepDebug.map((d) => d.filename));
  const debugCutoff = Date.now() - 3 * 24 * 60 * 60 * 1e3;
  for (const d of debugLogs) {
    if (keepDebugNames.has(d.filename)) continue;
    if (d.mtime.getTime() < debugCutoff) {
      try {
        unlinkSync(join(debugDir(basePath), d.filename));
        removedDebug++;
      } catch {
      }
    }
  }
  if (removedActivity === 0 && removedDebug === 0) {
    ctx.ui.notify("No old logs to clear.", "info");
  } else {
    ctx.ui.notify(
      `Cleared ${removedActivity} activity log(s) and ${removedDebug} debug log(s).`,
      "info"
    );
  }
}
export {
  handleLogs
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9jb21tYW5kcy1sb2dzLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIC9nc2QgbG9ncyBcdTIwMTQgQnJvd3NlIGFjdGl2aXR5IGxvZ3MsIGRlYnVnIGxvZ3MsIGFuZCBtZXRyaWNzLlxuICpcbiAqIFN1YmNvbW1hbmRzOlxuICogICAvZ3NkIGxvZ3MgICAgICAgICAgICAgIFx1MjAxNCBMaXN0IHJlY2VudCBhY3Rpdml0eSArIGRlYnVnIGxvZ3NcbiAqICAgL2dzZCBsb2dzIDxOPiAgICAgICAgICBcdTIwMTQgU2hvdyBzdW1tYXJ5IG9mIGFjdGl2aXR5IGxvZyAjTlxuICogICAvZ3NkIGxvZ3MgZGVidWcgICAgICAgIFx1MjAxNCBMaXN0IGRlYnVnIGxvZyBmaWxlc1xuICogICAvZ3NkIGxvZ3MgZGVidWcgPE4+ICAgIFx1MjAxNCBTaG93IGRlYnVnIGxvZyBzdW1tYXJ5ICNOXG4gKiAgIC9nc2QgbG9ncyB0YWlsIFtOXSAgICAgXHUyMDE0IFNob3cgbGFzdCBOIGFjdGl2aXR5IGxvZyBlbnRyaWVzIChkZWZhdWx0IDUpXG4gKiAgIC9nc2QgbG9ncyBjbGVhciAgICAgICAgXHUyMDE0IFJlbW92ZSBvbGQgYWN0aXZpdHkgYW5kIGRlYnVnIGxvZ3NcbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0IH0gZnJvbSBcIkBnc2QvcGktY29kaW5nLWFnZW50XCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkZGlyU3luYywgcmVhZEZpbGVTeW5jLCBzdGF0U3luYywgdW5saW5rU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZ3NkUm9vdCB9IGZyb20gXCIuL3BhdGhzLmpzXCI7XG5pbXBvcnQgeyBsb2FkSnNvbkZpbGVPck51bGwgfSBmcm9tIFwiLi9qc29uLXBlcnNpc3RlbmNlLmpzXCI7XG5pbXBvcnQgeyBjdXJyZW50RGlyZWN0b3J5Um9vdCB9IGZyb20gXCIuL2NvbW1hbmRzL2NvbnRleHQuanNcIjtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFR5cGVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5pbnRlcmZhY2UgTG9nRW50cnkge1xuICBzZXE6IG51bWJlcjtcbiAgZmlsZW5hbWU6IHN0cmluZztcbiAgdW5pdFR5cGU6IHN0cmluZztcbiAgdW5pdElkOiBzdHJpbmc7XG4gIHNpemU6IG51bWJlcjtcbiAgbXRpbWU6IERhdGU7XG59XG5cbmludGVyZmFjZSBEZWJ1Z0xvZ0VudHJ5IHtcbiAgZmlsZW5hbWU6IHN0cmluZztcbiAgc2l6ZTogbnVtYmVyO1xuICBtdGltZTogRGF0ZTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEhlbHBlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIGFjdGl2aXR5RGlyKGJhc2VQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gam9pbihnc2RSb290KGJhc2VQYXRoKSwgXCJhY3Rpdml0eVwiKTtcbn1cblxuZnVuY3Rpb24gZGVidWdEaXIoYmFzZVBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBqb2luKGdzZFJvb3QoYmFzZVBhdGgpLCBcImRlYnVnXCIpO1xufVxuXG5mdW5jdGlvbiBsaXN0QWN0aXZpdHlMb2dzKGJhc2VQYXRoOiBzdHJpbmcpOiBMb2dFbnRyeVtdIHtcbiAgY29uc3QgZGlyID0gYWN0aXZpdHlEaXIoYmFzZVBhdGgpO1xuICBpZiAoIWV4aXN0c1N5bmMoZGlyKSkgcmV0dXJuIFtdO1xuXG4gIGNvbnN0IGVudHJpZXM6IExvZ0VudHJ5W10gPSBbXTtcbiAgdHJ5IHtcbiAgICBmb3IgKGNvbnN0IGYgb2YgcmVhZGRpclN5bmMoZGlyKSkge1xuICAgICAgaWYgKCFmLmVuZHNXaXRoKFwiLmpzb25sXCIpKSBjb250aW51ZTtcbiAgICAgIC8vIEZpbGVuYW1lIGZvcm1hdDoge3NlcX0te3VuaXRUeXBlfS17dW5pdElkfS5qc29ubFxuICAgICAgLy8gdW5pdFR5cGUgaXMgbG93ZXJjYXNlLXdpdGgtaHlwaGVucyAoZS5nLiwgXCJleGVjdXRlLXRhc2tcIiwgXCJjb21wbGV0ZS1zbGljZVwiKVxuICAgICAgLy8gdW5pdElkIHN0YXJ0cyB3aXRoIE0gZm9sbG93ZWQgYnkgZGlnaXRzIChlLmcuLCBcIk0wMDEtUzAxLVQwMVwiKVxuICAgICAgY29uc3QgbWF0Y2ggPSBmLm1hdGNoKC9eKFxcZCspLShbXFx3LV0rPyktKE1cXGRbXFx3LV0qKVxcLmpzb25sJC8pO1xuICAgICAgaWYgKCFtYXRjaCkgY29udGludWU7XG5cbiAgICAgIGNvbnN0IGZpbGVQYXRoID0gam9pbihkaXIsIGYpO1xuICAgICAgbGV0IHN0YXQ7XG4gICAgICB0cnkgeyBzdGF0ID0gc3RhdFN5bmMoZmlsZVBhdGgpOyB9IGNhdGNoIHsgY29udGludWU7IH1cblxuICAgICAgZW50cmllcy5wdXNoKHtcbiAgICAgICAgc2VxOiBwYXJzZUludChtYXRjaFsxXSwgMTApLFxuICAgICAgICBmaWxlbmFtZTogZixcbiAgICAgICAgdW5pdFR5cGU6IG1hdGNoWzJdLFxuICAgICAgICB1bml0SWQ6IG1hdGNoWzNdLnJlcGxhY2UoLy0vZywgXCIvXCIpLFxuICAgICAgICBzaXplOiBzdGF0LnNpemUsXG4gICAgICAgIG10aW1lOiBzdGF0Lm10aW1lLFxuICAgICAgfSk7XG4gICAgfVxuICB9IGNhdGNoIHsgLyogZGlyIG5vdCByZWFkYWJsZSAqLyB9XG5cbiAgcmV0dXJuIGVudHJpZXMuc29ydCgoYSwgYikgPT4gYS5zZXEgLSBiLnNlcSk7XG59XG5cbmZ1bmN0aW9uIGxpc3REZWJ1Z0xvZ3MoYmFzZVBhdGg6IHN0cmluZyk6IERlYnVnTG9nRW50cnlbXSB7XG4gIGNvbnN0IGRpciA9IGRlYnVnRGlyKGJhc2VQYXRoKTtcbiAgaWYgKCFleGlzdHNTeW5jKGRpcikpIHJldHVybiBbXTtcblxuICBjb25zdCBlbnRyaWVzOiBEZWJ1Z0xvZ0VudHJ5W10gPSBbXTtcbiAgdHJ5IHtcbiAgICBmb3IgKGNvbnN0IGYgb2YgcmVhZGRpclN5bmMoZGlyKSkge1xuICAgICAgaWYgKCFmLmVuZHNXaXRoKFwiLmxvZ1wiKSkgY29udGludWU7XG4gICAgICBjb25zdCBmaWxlUGF0aCA9IGpvaW4oZGlyLCBmKTtcbiAgICAgIGxldCBzdGF0O1xuICAgICAgdHJ5IHsgc3RhdCA9IHN0YXRTeW5jKGZpbGVQYXRoKTsgfSBjYXRjaCB7IGNvbnRpbnVlOyB9XG4gICAgICBlbnRyaWVzLnB1c2goeyBmaWxlbmFtZTogZiwgc2l6ZTogc3RhdC5zaXplLCBtdGltZTogc3RhdC5tdGltZSB9KTtcbiAgICB9XG4gIH0gY2F0Y2ggeyAvKiBkaXIgbm90IHJlYWRhYmxlICovIH1cblxuICByZXR1cm4gZW50cmllcy5zb3J0KChhLCBiKSA9PiBhLm10aW1lLmdldFRpbWUoKSAtIGIubXRpbWUuZ2V0VGltZSgpKTtcbn1cblxuZnVuY3Rpb24gZm9ybWF0U2l6ZShieXRlczogbnVtYmVyKTogc3RyaW5nIHtcbiAgaWYgKGJ5dGVzIDwgMTAyNCkgcmV0dXJuIGAke2J5dGVzfUJgO1xuICBpZiAoYnl0ZXMgPCAxMDI0ICogMTAyNCkgcmV0dXJuIGAkeyhieXRlcyAvIDEwMjQpLnRvRml4ZWQoMSl9S0JgO1xuICByZXR1cm4gYCR7KGJ5dGVzIC8gKDEwMjQgKiAxMDI0KSkudG9GaXhlZCgxKX1NQmA7XG59XG5cbmZ1bmN0aW9uIGZvcm1hdEFnZShkYXRlOiBEYXRlKTogc3RyaW5nIHtcbiAgY29uc3QgbXMgPSBEYXRlLm5vdygpIC0gZGF0ZS5nZXRUaW1lKCk7XG4gIGNvbnN0IG1pbnMgPSBNYXRoLmZsb29yKG1zIC8gNjBfMDAwKTtcbiAgaWYgKG1pbnMgPCAxKSByZXR1cm4gXCJqdXN0IG5vd1wiO1xuICBpZiAobWlucyA8IDYwKSByZXR1cm4gYCR7bWluc31tIGFnb2A7XG4gIGNvbnN0IGhycyA9IE1hdGguZmxvb3IobWlucyAvIDYwKTtcbiAgaWYgKGhycyA8IDI0KSByZXR1cm4gYCR7aHJzfWggYWdvYDtcbiAgY29uc3QgZGF5cyA9IE1hdGguZmxvb3IoaHJzIC8gMjQpO1xuICByZXR1cm4gYCR7ZGF5c31kIGFnb2A7XG59XG5cbi8qKlxuICogRXh0cmFjdCBhIHN1bW1hcnkgZnJvbSBhbiBhY3Rpdml0eSBsb2cgSlNPTkwgZmlsZS5cbiAqIFBhcnNlcyB0aGUgZW50cmllcyB0byBjb3VudCB0b29sIGNhbGxzLCBlcnJvcnMsIGFuZCBleHRyYWN0IGtleSBldmVudHMuXG4gKi9cbmZ1bmN0aW9uIHN1bW1hcml6ZUFjdGl2aXR5TG9nKGZpbGVQYXRoOiBzdHJpbmcpOiB7XG4gIHRvb2xDYWxsczogbnVtYmVyO1xuICBlcnJvcnM6IG51bWJlcjtcbiAgZmlsZXNXcml0dGVuOiBzdHJpbmdbXTtcbiAgY29tbWFuZHNSdW46IEFycmF5PHsgY29tbWFuZDogc3RyaW5nOyBmYWlsZWQ6IGJvb2xlYW4gfT47XG4gIGxhc3RSZWFzb25pbmc6IHN0cmluZztcbiAgZW50cnlDb3VudDogbnVtYmVyO1xufSB7XG4gIGNvbnN0IHJlc3VsdCA9IHtcbiAgICB0b29sQ2FsbHM6IDAsXG4gICAgZXJyb3JzOiAwLFxuICAgIGZpbGVzV3JpdHRlbjogbmV3IFNldDxzdHJpbmc+KCksXG4gICAgY29tbWFuZHNSdW46IFtdIGFzIEFycmF5PHsgY29tbWFuZDogc3RyaW5nOyBmYWlsZWQ6IGJvb2xlYW4gfT4sXG4gICAgbGFzdFJlYXNvbmluZzogXCJcIixcbiAgICBlbnRyeUNvdW50OiAwLFxuICB9O1xuXG4gIGxldCByYXc6IHN0cmluZztcbiAgdHJ5IHsgcmF3ID0gcmVhZEZpbGVTeW5jKGZpbGVQYXRoLCBcInV0Zi04XCIpOyB9IGNhdGNoIHsgcmV0dXJuIHsgLi4ucmVzdWx0LCBmaWxlc1dyaXR0ZW46IFtdIH07IH1cblxuICBjb25zdCBsaW5lcyA9IHJhdy5zcGxpdChcIlxcblwiKS5maWx0ZXIobCA9PiBsLnRyaW0oKSk7XG4gIHJlc3VsdC5lbnRyeUNvdW50ID0gbGluZXMubGVuZ3RoO1xuXG4gIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xuICAgIGxldCBlbnRyeTogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgdHJ5IHsgZW50cnkgPSBKU09OLnBhcnNlKGxpbmUpOyB9IGNhdGNoIHsgY29udGludWU7IH1cblxuICAgIC8vIENvdW50IHRvb2wgY2FsbHNcbiAgICBpZiAoZW50cnkudHlwZSA9PT0gXCJ0b29sQ2FsbFwiIHx8IChlbnRyeS5yb2xlID09PSBcImFzc2lzdGFudFwiICYmIGVudHJ5LmNvbnRlbnQgJiYgQXJyYXkuaXNBcnJheShlbnRyeS5jb250ZW50KSkpIHtcbiAgICAgIGlmIChlbnRyeS50eXBlID09PSBcInRvb2xDYWxsXCIpIHtcbiAgICAgICAgcmVzdWx0LnRvb2xDYWxscysrO1xuICAgICAgICBjb25zdCBuYW1lID0gZW50cnkubmFtZSBhcyBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gICAgICAgIGNvbnN0IGFyZ3MgPSBlbnRyeS5hcmd1bWVudHMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQ7XG5cbiAgICAgICAgaWYgKG5hbWUgPT09IFwid3JpdGVcIiB8fCBuYW1lID09PSBcImVkaXRcIikge1xuICAgICAgICAgIGNvbnN0IHBhdGggPSBhcmdzPy5maWxlX3BhdGggYXMgc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAgICAgICAgIGlmIChwYXRoKSByZXN1bHQuZmlsZXNXcml0dGVuLmFkZChwYXRoKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAobmFtZSA9PT0gXCJiYXNoXCIpIHtcbiAgICAgICAgICBjb25zdCBjbWQgPSBhcmdzPy5jb21tYW5kIGFzIHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICAgICAgICBpZiAoY21kKSByZXN1bHQuY29tbWFuZHNSdW4ucHVzaCh7IGNvbW1hbmQ6IGNtZC5zbGljZSgwLCA4MCksIGZhaWxlZDogZmFsc2UgfSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBDb3VudCBlcnJvcnNcbiAgICBpZiAoZW50cnkucm9sZSA9PT0gXCJ0b29sUmVzdWx0XCIgJiYgZW50cnkuaXNFcnJvcikge1xuICAgICAgcmVzdWx0LmVycm9ycysrO1xuICAgICAgLy8gTWFyayBsYXN0IGNvbW1hbmQgYXMgZmFpbGVkXG4gICAgICBpZiAocmVzdWx0LmNvbW1hbmRzUnVuLmxlbmd0aCA+IDApIHtcbiAgICAgICAgcmVzdWx0LmNvbW1hbmRzUnVuW3Jlc3VsdC5jb21tYW5kc1J1bi5sZW5ndGggLSAxXS5mYWlsZWQgPSB0cnVlO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIFRyYWNrIGFzc2lzdGFudCByZWFzb25pbmdcbiAgICBpZiAoZW50cnkucm9sZSA9PT0gXCJhc3Npc3RhbnRcIiAmJiB0eXBlb2YgZW50cnkuY29udGVudCA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgcmVzdWx0Lmxhc3RSZWFzb25pbmcgPSBlbnRyeS5jb250ZW50LnNsaWNlKDAsIDIwMCk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHtcbiAgICAuLi5yZXN1bHQsXG4gICAgZmlsZXNXcml0dGVuOiBbLi4ucmVzdWx0LmZpbGVzV3JpdHRlbl0sXG4gIH07XG59XG5cbi8qKlxuICogRXh0cmFjdCBzdW1tYXJ5IGV2ZW50cyBmcm9tIGEgZGVidWcgbG9nIGZpbGUuXG4gKi9cbmZ1bmN0aW9uIHN1bW1hcml6ZURlYnVnTG9nKGZpbGVQYXRoOiBzdHJpbmcpOiB7XG4gIGV2ZW50czogbnVtYmVyO1xuICBkdXJhdGlvbjogc3RyaW5nO1xuICBkaXNwYXRjaGVzOiBudW1iZXI7XG4gIGVycm9yczogQXJyYXk8eyBldmVudDogc3RyaW5nOyBtZXNzYWdlOiBzdHJpbmcgfT47XG59IHtcbiAgY29uc3QgcmVzdWx0ID0ge1xuICAgIGV2ZW50czogMCxcbiAgICBkdXJhdGlvbjogXCJ1bmtub3duXCIsXG4gICAgZGlzcGF0Y2hlczogMCxcbiAgICBlcnJvcnM6IFtdIGFzIEFycmF5PHsgZXZlbnQ6IHN0cmluZzsgbWVzc2FnZTogc3RyaW5nIH0+LFxuICB9O1xuXG4gIGxldCByYXc6IHN0cmluZztcbiAgdHJ5IHsgcmF3ID0gcmVhZEZpbGVTeW5jKGZpbGVQYXRoLCBcInV0Zi04XCIpOyB9IGNhdGNoIHsgcmV0dXJuIHJlc3VsdDsgfVxuXG4gIGNvbnN0IGxpbmVzID0gcmF3LnNwbGl0KFwiXFxuXCIpLmZpbHRlcihsID0+IGwudHJpbSgpKTtcbiAgcmVzdWx0LmV2ZW50cyA9IGxpbmVzLmxlbmd0aDtcblxuICBsZXQgZmlyc3RUcyA9IDA7XG4gIGxldCBsYXN0VHMgPSAwO1xuXG4gIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xuICAgIGxldCBlbnRyeTogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgdHJ5IHsgZW50cnkgPSBKU09OLnBhcnNlKGxpbmUpOyB9IGNhdGNoIHsgY29udGludWU7IH1cblxuICAgIGNvbnN0IHRzID0gZW50cnkudHMgYXMgc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAgIGlmICh0cykge1xuICAgICAgY29uc3QgdCA9IG5ldyBEYXRlKHRzKS5nZXRUaW1lKCk7XG4gICAgICBpZiAoIWZpcnN0VHMpIGZpcnN0VHMgPSB0O1xuICAgICAgbGFzdFRzID0gdDtcbiAgICB9XG5cbiAgICBjb25zdCBldmVudCA9IGVudHJ5LmV2ZW50IGFzIHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICBpZiAoIWV2ZW50KSBjb250aW51ZTtcblxuICAgIGlmIChldmVudCA9PT0gXCJkZWJ1Zy1zdW1tYXJ5XCIpIHtcbiAgICAgIHJlc3VsdC5kaXNwYXRjaGVzID0gKGVudHJ5LmRpc3BhdGNoZXMgYXMgbnVtYmVyKSA/PyAwO1xuICAgIH1cblxuICAgIGlmIChldmVudC5pbmNsdWRlcyhcImVycm9yXCIpIHx8IGV2ZW50LmluY2x1ZGVzKFwiZmFpbGVkXCIpKSB7XG4gICAgICBjb25zdCBtc2cgPSAoZW50cnkuZXJyb3IgYXMgc3RyaW5nKSA/PyAoZW50cnkubWVzc2FnZSBhcyBzdHJpbmcpID8/IEpTT04uc3RyaW5naWZ5KGVudHJ5KS5zbGljZSgwLCAxMDApO1xuICAgICAgcmVzdWx0LmVycm9ycy5wdXNoKHsgZXZlbnQsIG1lc3NhZ2U6IG1zZyB9KTtcbiAgICB9XG4gIH1cblxuICBpZiAoZmlyc3RUcyAmJiBsYXN0VHMpIHtcbiAgICBjb25zdCBlbGFwc2VkID0gbGFzdFRzIC0gZmlyc3RUcztcbiAgICBjb25zdCBtaW5zID0gTWF0aC5mbG9vcihlbGFwc2VkIC8gNjBfMDAwKTtcbiAgICBpZiAobWlucyA8IDEpIHJlc3VsdC5kdXJhdGlvbiA9IGAke01hdGguZmxvb3IoZWxhcHNlZCAvIDEwMDApfXNgO1xuICAgIGVsc2UgaWYgKG1pbnMgPCA2MCkgcmVzdWx0LmR1cmF0aW9uID0gYCR7bWluc31tYDtcbiAgICBlbHNlIHJlc3VsdC5kdXJhdGlvbiA9IGAke01hdGguZmxvb3IobWlucyAvIDYwKX1oICR7bWlucyAlIDYwfW1gO1xuICB9XG5cbiAgcmV0dXJuIHJlc3VsdDtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIE1haW4gSGFuZGxlciBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZUxvZ3MoYXJnczogc3RyaW5nLCBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGJhc2VQYXRoID0gY3VycmVudERpcmVjdG9yeVJvb3QoKTtcbiAgY29uc3QgcGFydHMgPSBhcmdzLnRyaW0oKS5zcGxpdCgvXFxzKy8pLmZpbHRlcihCb29sZWFuKTtcbiAgY29uc3Qgc3ViQ21kID0gcGFydHNbMF0gPz8gXCJcIjtcblxuICAvLyAvZ3NkIGxvZ3MgY2xlYXJcbiAgaWYgKHN1YkNtZCA9PT0gXCJjbGVhclwiKSB7XG4gICAgYXdhaXQgaGFuZGxlTG9nc0NsZWFyKGJhc2VQYXRoLCBjdHgpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIC9nc2QgbG9ncyBkZWJ1ZyBbTl1cbiAgaWYgKHN1YkNtZCA9PT0gXCJkZWJ1Z1wiKSB7XG4gICAgY29uc3QgaWR4ID0gcGFydHNbMV0gPyBwYXJzZUludChwYXJ0c1sxXSwgMTApIDogdW5kZWZpbmVkO1xuICAgIGF3YWl0IGhhbmRsZUxvZ3NEZWJ1ZyhiYXNlUGF0aCwgY3R4LCBpZHgpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIC9nc2QgbG9ncyB0YWlsIFtOXVxuICBpZiAoc3ViQ21kID09PSBcInRhaWxcIikge1xuICAgIGNvbnN0IGNvdW50ID0gcGFydHNbMV0gPyBwYXJzZUludChwYXJ0c1sxXSwgMTApIDogNTtcbiAgICBhd2FpdCBoYW5kbGVMb2dzVGFpbChiYXNlUGF0aCwgY3R4LCBjb3VudCk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gL2dzZCBsb2dzIDxOPiBcdTIwMTQgc2hvdyBzcGVjaWZpYyBhY3Rpdml0eSBsb2dcbiAgaWYgKHN1YkNtZCAmJiAvXlxcZCskLy50ZXN0KHN1YkNtZCkpIHtcbiAgICBjb25zdCBzZXEgPSBwYXJzZUludChzdWJDbWQsIDEwKTtcbiAgICBhd2FpdCBoYW5kbGVMb2dzU2hvdyhiYXNlUGF0aCwgY3R4LCBzZXEpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIC9nc2QgbG9ncyBcdTIwMTQgbGlzdCBvdmVydmlld1xuICBhd2FpdCBoYW5kbGVMb2dzTGlzdChiYXNlUGF0aCwgY3R4KTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFN1YmNvbW1hbmQgSGFuZGxlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZUxvZ3NMaXN0KGJhc2VQYXRoOiBzdHJpbmcsIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgYWN0aXZpdGllcyA9IGxpc3RBY3Rpdml0eUxvZ3MoYmFzZVBhdGgpO1xuICBjb25zdCBkZWJ1Z0xvZ3MgPSBsaXN0RGVidWdMb2dzKGJhc2VQYXRoKTtcblxuICBpZiAoYWN0aXZpdGllcy5sZW5ndGggPT09IDAgJiYgZGVidWdMb2dzLmxlbmd0aCA9PT0gMCkge1xuICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICBcIk5vIGxvZ3MgZm91bmQuXFxuXFxuQWN0aXZpdHkgbG9ncyBhcmUgY3JlYXRlZCBkdXJpbmcgYXV0by1tb2RlLlxcbkRlYnVnIGxvZ3MgcmVxdWlyZSBHU0RfREVCVUc9MS5cIixcbiAgICAgIFwiaW5mb1wiLFxuICAgICk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG5cbiAgaWYgKGFjdGl2aXRpZXMubGVuZ3RoID4gMCkge1xuICAgIGxpbmVzLnB1c2goXCJBY3Rpdml0eSBMb2dzICguZ3NkL2FjdGl2aXR5Lyk6XCIpO1xuICAgIGxpbmVzLnB1c2goXCIgICMgICBVbml0IFR5cGUgICAgICAgICBVbml0IElEICAgICAgICAgICAgICBTaXplICAgIEFnZVwiKTtcbiAgICBsaW5lcy5wdXNoKFwiICBcIiArIFwiXHUyNTAwXCIucmVwZWF0KDcwKSk7XG5cbiAgICAvLyBTaG93IGxhc3QgMTUgZW50cmllc1xuICAgIGNvbnN0IHJlY2VudCA9IGFjdGl2aXRpZXMuc2xpY2UoLTE1KTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgcmVjZW50KSB7XG4gICAgICBjb25zdCBzZXEgPSBTdHJpbmcoZS5zZXEpLnBhZFN0YXJ0KDMsIFwiIFwiKTtcbiAgICAgIGNvbnN0IHR5cGUgPSBlLnVuaXRUeXBlLnBhZEVuZCgxOCwgXCIgXCIpO1xuICAgICAgY29uc3QgaWQgPSBlLnVuaXRJZC5wYWRFbmQoMjAsIFwiIFwiKTtcbiAgICAgIGNvbnN0IHNpemUgPSBmb3JtYXRTaXplKGUuc2l6ZSkucGFkU3RhcnQoNywgXCIgXCIpO1xuICAgICAgY29uc3QgYWdlID0gZm9ybWF0QWdlKGUubXRpbWUpO1xuICAgICAgbGluZXMucHVzaChgICAke3NlcX0gJHt0eXBlfSAke2lkfSAke3NpemV9ICAke2FnZX1gKTtcbiAgICB9XG5cbiAgICBpZiAoYWN0aXZpdGllcy5sZW5ndGggPiAxNSkge1xuICAgICAgbGluZXMucHVzaChgICAuLi4gYW5kICR7YWN0aXZpdGllcy5sZW5ndGggLSAxNX0gb2xkZXIgZW50cmllc2ApO1xuICAgIH1cbiAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICAgIGxpbmVzLnB1c2goXCIgIFZpZXcgZGV0YWlsczogL2dzZCBsb2dzIDwjPlwiKTtcbiAgfVxuXG4gIGlmIChkZWJ1Z0xvZ3MubGVuZ3RoID4gMCkge1xuICAgIGxpbmVzLnB1c2goXCJcIik7XG4gICAgbGluZXMucHVzaChcIkRlYnVnIExvZ3MgKC5nc2QvZGVidWcvKTpcIik7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBkZWJ1Z0xvZ3MubGVuZ3RoOyBpKyspIHtcbiAgICAgIGNvbnN0IGQgPSBkZWJ1Z0xvZ3NbaV07XG4gICAgICBjb25zdCBzaXplID0gZm9ybWF0U2l6ZShkLnNpemUpLnBhZFN0YXJ0KDcsIFwiIFwiKTtcbiAgICAgIGNvbnN0IGFnZSA9IGZvcm1hdEFnZShkLm10aW1lKTtcbiAgICAgIGxpbmVzLnB1c2goYCAgJHtpICsgMX0uICR7ZC5maWxlbmFtZX0gICR7c2l6ZX0gICR7YWdlfWApO1xuICAgIH1cbiAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICAgIGxpbmVzLnB1c2goXCIgIFZpZXcgZGV0YWlsczogL2dzZCBsb2dzIGRlYnVnIDwjPlwiKTtcbiAgfVxuXG4gIC8vIE1ldHJpY3Mgc3VtbWFyeVxuICBjb25zdCBtZXRyaWNzUGF0aCA9IGpvaW4oZ3NkUm9vdChiYXNlUGF0aCksIFwibWV0cmljcy5qc29uXCIpO1xuICBjb25zdCBpc01ldHJpY3MgPSAoZDogdW5rbm93bik6IGQgaXMgeyB1bml0czogQXJyYXk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IH0gPT5cbiAgICBkICE9PSBudWxsICYmIHR5cGVvZiBkID09PSBcIm9iamVjdFwiICYmIFwidW5pdHNcIiBpbiBkISAmJiBBcnJheS5pc0FycmF5KChkIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KS51bml0cyk7XG4gIGNvbnN0IG1ldHJpY3MgPSBsb2FkSnNvbkZpbGVPck51bGwobWV0cmljc1BhdGgsIGlzTWV0cmljcyk7XG4gIGlmIChtZXRyaWNzICYmIG1ldHJpY3MudW5pdHMubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IHVuaXRzID0gbWV0cmljcy51bml0cztcbiAgICBjb25zdCB0b3RhbENvc3QgPSB1bml0cy5yZWR1Y2UoKHN1bTogbnVtYmVyLCB1KSA9PiBzdW0gKyAoKHUuY29zdCBhcyBudW1iZXIpID8/IDApLCAwKTtcbiAgICBjb25zdCB0b3RhbFRva2VucyA9IHVuaXRzLnJlZHVjZSgoc3VtOiBudW1iZXIsIHUpID0+IHtcbiAgICAgIGNvbnN0IHQgPSB1LnRva2VucyBhcyBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+IHwgdW5kZWZpbmVkO1xuICAgICAgcmV0dXJuIHN1bSArICh0Py50b3RhbCA/PyAwKTtcbiAgICB9LCAwKTtcbiAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICAgIGxpbmVzLnB1c2goYE1ldHJpY3M6ICR7dW5pdHMubGVuZ3RofSB1bml0cyB0cmFja2VkIFx1MDBCNyAkJHt0b3RhbENvc3QudG9GaXhlZCgyKX0gXHUwMEI3ICR7KHRvdGFsVG9rZW5zIC8gMTAwMCkudG9GaXhlZCgwKX1LIHRva2Vuc2ApO1xuICB9XG5cbiAgbGluZXMucHVzaChcIlwiKTtcbiAgbGluZXMucHVzaChcIlRpcDogRW5hYmxlIGRlYnVnIGxvZ2dpbmcgd2l0aCBHU0RfREVCVUc9MSBiZWZvcmUgL2dzZCBhdXRvXCIpO1xuXG4gIGN0eC51aS5ub3RpZnkobGluZXMuam9pbihcIlxcblwiKSwgXCJpbmZvXCIpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVMb2dzU2hvdyhiYXNlUGF0aDogc3RyaW5nLCBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LCBzZXE6IG51bWJlcik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBhY3Rpdml0aWVzID0gbGlzdEFjdGl2aXR5TG9ncyhiYXNlUGF0aCk7XG4gIGNvbnN0IGVudHJ5ID0gYWN0aXZpdGllcy5maW5kKGUgPT4gZS5zZXEgPT09IHNlcSk7XG5cbiAgaWYgKCFlbnRyeSkge1xuICAgIGN0eC51aS5ub3RpZnkoYEFjdGl2aXR5IGxvZyAjJHtzZXF9IG5vdCBmb3VuZC4gUnVuIC9nc2QgbG9ncyB0byBzZWUgYXZhaWxhYmxlIGxvZ3MuYCwgXCJ3YXJuaW5nXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IGZpbGVQYXRoID0gam9pbihhY3Rpdml0eURpcihiYXNlUGF0aCksIGVudHJ5LmZpbGVuYW1lKTtcbiAgY29uc3Qgc3VtbWFyeSA9IHN1bW1hcml6ZUFjdGl2aXR5TG9nKGZpbGVQYXRoKTtcblxuICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcbiAgbGluZXMucHVzaChgQWN0aXZpdHkgTG9nICMke2VudHJ5LnNlcX06ICR7ZW50cnkudW5pdFR5cGV9IFx1MjAxNCAke2VudHJ5LnVuaXRJZH1gKTtcbiAgbGluZXMucHVzaChcIlx1MjUwMFwiLnJlcGVhdCg2MCkpO1xuICBsaW5lcy5wdXNoKGBGaWxlOiAke2VudHJ5LmZpbGVuYW1lfWApO1xuICBsaW5lcy5wdXNoKGBTaXplOiAke2Zvcm1hdFNpemUoZW50cnkuc2l6ZSl9ICB8ICBBZ2U6ICR7Zm9ybWF0QWdlKGVudHJ5Lm10aW1lKX1gKTtcbiAgbGluZXMucHVzaChgRW50cmllczogJHtzdW1tYXJ5LmVudHJ5Q291bnR9ICB8ICBUb29sIGNhbGxzOiAke3N1bW1hcnkudG9vbENhbGxzfSAgfCAgRXJyb3JzOiAke3N1bW1hcnkuZXJyb3JzfWApO1xuXG4gIGlmIChzdW1tYXJ5LmZpbGVzV3JpdHRlbi5sZW5ndGggPiAwKSB7XG4gICAgbGluZXMucHVzaChcIlwiKTtcbiAgICBsaW5lcy5wdXNoKFwiRmlsZXMgd3JpdHRlbi9lZGl0ZWQ6XCIpO1xuICAgIGZvciAoY29uc3QgZiBvZiBzdW1tYXJ5LmZpbGVzV3JpdHRlbi5zbGljZSgwLCAxMCkpIHtcbiAgICAgIGxpbmVzLnB1c2goYCAgJHtmfWApO1xuICAgIH1cbiAgICBpZiAoc3VtbWFyeS5maWxlc1dyaXR0ZW4ubGVuZ3RoID4gMTApIHtcbiAgICAgIGxpbmVzLnB1c2goYCAgLi4uIGFuZCAke3N1bW1hcnkuZmlsZXNXcml0dGVuLmxlbmd0aCAtIDEwfSBtb3JlYCk7XG4gICAgfVxuICB9XG5cbiAgaWYgKHN1bW1hcnkuY29tbWFuZHNSdW4ubGVuZ3RoID4gMCkge1xuICAgIGxpbmVzLnB1c2goXCJcIik7XG4gICAgbGluZXMucHVzaChcIkNvbW1hbmRzIHJ1bjpcIik7XG4gICAgZm9yIChjb25zdCBjIG9mIHN1bW1hcnkuY29tbWFuZHNSdW4uc2xpY2UoMCwgMTApKSB7XG4gICAgICBjb25zdCBzdGF0dXMgPSBjLmZhaWxlZCA/IFwiIEZBSUxFRFwiIDogXCJcIjtcbiAgICAgIGxpbmVzLnB1c2goYCAgJHtjLmNvbW1hbmR9JHtzdGF0dXN9YCk7XG4gICAgfVxuICAgIGlmIChzdW1tYXJ5LmNvbW1hbmRzUnVuLmxlbmd0aCA+IDEwKSB7XG4gICAgICBsaW5lcy5wdXNoKGAgIC4uLiBhbmQgJHtzdW1tYXJ5LmNvbW1hbmRzUnVuLmxlbmd0aCAtIDEwfSBtb3JlYCk7XG4gICAgfVxuICB9XG5cbiAgaWYgKHN1bW1hcnkuZXJyb3JzID4gMCkge1xuICAgIGxpbmVzLnB1c2goXCJcIik7XG4gICAgbGluZXMucHVzaChgJHtzdW1tYXJ5LmVycm9yc30gZXJyb3IocykgZW5jb3VudGVyZWQgZHVyaW5nIHRoaXMgdW5pdC5gKTtcbiAgfVxuXG4gIGlmIChzdW1tYXJ5Lmxhc3RSZWFzb25pbmcpIHtcbiAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICAgIGxpbmVzLnB1c2goXCJMYXN0IHJlYXNvbmluZzpcIik7XG4gICAgbGluZXMucHVzaChgICBcIiR7c3VtbWFyeS5sYXN0UmVhc29uaW5nfSR7c3VtbWFyeS5sYXN0UmVhc29uaW5nLmxlbmd0aCA+PSAyMDAgPyBcIi4uLlwiIDogXCJcIn1cImApO1xuICB9XG5cbiAgbGluZXMucHVzaChcIlwiKTtcbiAgbGluZXMucHVzaChgRnVsbCBsb2c6ICR7ZmlsZVBhdGh9YCk7XG5cbiAgY3R4LnVpLm5vdGlmeShsaW5lcy5qb2luKFwiXFxuXCIpLCBcImluZm9cIik7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZUxvZ3NEZWJ1ZyhiYXNlUGF0aDogc3RyaW5nLCBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LCBpZHg/OiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgZGVidWdMb2dzID0gbGlzdERlYnVnTG9ncyhiYXNlUGF0aCk7XG5cbiAgaWYgKGRlYnVnTG9ncy5sZW5ndGggPT09IDApIHtcbiAgICBjdHgudWkubm90aWZ5KFxuICAgICAgXCJObyBkZWJ1ZyBsb2dzIGZvdW5kLlxcblxcbkVuYWJsZSBkZWJ1ZyBsb2dnaW5nOiBHU0RfREVCVUc9MSBnc2QgYXV0b1wiLFxuICAgICAgXCJpbmZvXCIsXG4gICAgKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAoaWR4ID09PSB1bmRlZmluZWQpIHtcbiAgICAvLyBMaXN0IGRlYnVnIGxvZ3NcbiAgICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXCJEZWJ1ZyBMb2dzICguZ3NkL2RlYnVnLyk6XCIsIFwiXCJdO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgZGVidWdMb2dzLmxlbmd0aDsgaSsrKSB7XG4gICAgICBjb25zdCBkID0gZGVidWdMb2dzW2ldO1xuICAgICAgbGluZXMucHVzaChgICAke2kgKyAxfS4gJHtkLmZpbGVuYW1lfSAgJHtmb3JtYXRTaXplKGQuc2l6ZSl9ICAke2Zvcm1hdEFnZShkLm10aW1lKX1gKTtcbiAgICB9XG4gICAgbGluZXMucHVzaChcIlwiKTtcbiAgICBsaW5lcy5wdXNoKFwiVmlldyBkZXRhaWxzOiAvZ3NkIGxvZ3MgZGVidWcgPCM+XCIpO1xuICAgIGN0eC51aS5ub3RpZnkobGluZXMuam9pbihcIlxcblwiKSwgXCJpbmZvXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFNob3cgc3BlY2lmaWMgZGVidWcgbG9nXG4gIGlmIChpZHggPCAxIHx8IGlkeCA+IGRlYnVnTG9ncy5sZW5ndGgpIHtcbiAgICBjdHgudWkubm90aWZ5KGBEZWJ1ZyBsb2cgIyR7aWR4fSBub3QgZm91bmQuIEF2YWlsYWJsZTogMS0ke2RlYnVnTG9ncy5sZW5ndGh9YCwgXCJ3YXJuaW5nXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IGVudHJ5ID0gZGVidWdMb2dzW2lkeCAtIDFdO1xuICBjb25zdCBmaWxlUGF0aCA9IGpvaW4oZGVidWdEaXIoYmFzZVBhdGgpLCBlbnRyeS5maWxlbmFtZSk7XG4gIGNvbnN0IHN1bW1hcnkgPSBzdW1tYXJpemVEZWJ1Z0xvZyhmaWxlUGF0aCk7XG5cbiAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG4gIGxpbmVzLnB1c2goYERlYnVnIExvZzogJHtlbnRyeS5maWxlbmFtZX1gKTtcbiAgbGluZXMucHVzaChcIlx1MjUwMFwiLnJlcGVhdCg2MCkpO1xuICBsaW5lcy5wdXNoKGBTaXplOiAke2Zvcm1hdFNpemUoZW50cnkuc2l6ZSl9ICB8ICBBZ2U6ICR7Zm9ybWF0QWdlKGVudHJ5Lm10aW1lKX1gKTtcbiAgbGluZXMucHVzaChgRXZlbnRzOiAke3N1bW1hcnkuZXZlbnRzfSAgfCAgRHVyYXRpb246ICR7c3VtbWFyeS5kdXJhdGlvbn0gIHwgIERpc3BhdGNoZXM6ICR7c3VtbWFyeS5kaXNwYXRjaGVzfWApO1xuXG4gIGlmIChzdW1tYXJ5LmVycm9ycy5sZW5ndGggPiAwKSB7XG4gICAgbGluZXMucHVzaChcIlwiKTtcbiAgICBsaW5lcy5wdXNoKFwiRXJyb3JzL2ZhaWx1cmVzOlwiKTtcbiAgICBmb3IgKGNvbnN0IGUgb2Ygc3VtbWFyeS5lcnJvcnMuc2xpY2UoMCwgMTApKSB7XG4gICAgICBsaW5lcy5wdXNoKGAgIFske2UuZXZlbnR9XSAke2UubWVzc2FnZX1gKTtcbiAgICB9XG4gICAgaWYgKHN1bW1hcnkuZXJyb3JzLmxlbmd0aCA+IDEwKSB7XG4gICAgICBsaW5lcy5wdXNoKGAgIC4uLiBhbmQgJHtzdW1tYXJ5LmVycm9ycy5sZW5ndGggLSAxMH0gbW9yZWApO1xuICAgIH1cbiAgfVxuXG4gIGxpbmVzLnB1c2goXCJcIik7XG4gIGxpbmVzLnB1c2goYEZ1bGwgbG9nOiAke2ZpbGVQYXRofWApO1xuXG4gIGN0eC51aS5ub3RpZnkobGluZXMuam9pbihcIlxcblwiKSwgXCJpbmZvXCIpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVMb2dzVGFpbChiYXNlUGF0aDogc3RyaW5nLCBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LCBjb3VudDogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGFjdGl2aXRpZXMgPSBsaXN0QWN0aXZpdHlMb2dzKGJhc2VQYXRoKTtcblxuICBpZiAoYWN0aXZpdGllcy5sZW5ndGggPT09IDApIHtcbiAgICBjdHgudWkubm90aWZ5KFwiTm8gYWN0aXZpdHkgbG9ncyBmb3VuZC4gTG9ncyBhcmUgY3JlYXRlZCBkdXJpbmcgYXV0by1tb2RlLlwiLCBcImluZm9cIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgcmVjZW50ID0gYWN0aXZpdGllcy5zbGljZSgtTWF0aC5tYXgoMSwgTWF0aC5taW4oY291bnQsIDIwKSkpO1xuICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbYExhc3QgJHtyZWNlbnQubGVuZ3RofSBhY3Rpdml0eSBsb2cocyk6YCwgXCJcIl07XG5cbiAgZm9yIChjb25zdCBlIG9mIHJlY2VudCkge1xuICAgIGNvbnN0IGZpbGVQYXRoID0gam9pbihhY3Rpdml0eURpcihiYXNlUGF0aCksIGUuZmlsZW5hbWUpO1xuICAgIGNvbnN0IHN1bW1hcnkgPSBzdW1tYXJpemVBY3Rpdml0eUxvZyhmaWxlUGF0aCk7XG4gICAgY29uc3Qgc3RhdHVzID0gc3VtbWFyeS5lcnJvcnMgPiAwID8gYCR7c3VtbWFyeS5lcnJvcnN9IGVycmAgOiBcIm9rXCI7XG4gICAgbGluZXMucHVzaChgICAjJHtlLnNlcX0gJHtlLnVuaXRUeXBlfSAke2UudW5pdElkfSBcdTIwMTQgJHtzdW1tYXJ5LnRvb2xDYWxsc30gdG9vbHMsICR7c3RhdHVzfSwgJHtmb3JtYXRBZ2UoZS5tdGltZSl9YCk7XG4gIH1cblxuICBjdHgudWkubm90aWZ5KGxpbmVzLmpvaW4oXCJcXG5cIiksIFwiaW5mb1wiKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gaGFuZGxlTG9nc0NsZWFyKGJhc2VQYXRoOiBzdHJpbmcsIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgbGV0IHJlbW92ZWRBY3Rpdml0eSA9IDA7XG4gIGxldCByZW1vdmVkRGVidWcgPSAwO1xuXG4gIC8vIENsZWFyIGFjdGl2aXR5IGxvZ3Mgb2xkZXIgdGhhbiA3IGRheXMsIGtlZXAgdGhlIDUgbW9zdCByZWNlbnRcbiAgY29uc3QgYWN0aXZpdGllcyA9IGxpc3RBY3Rpdml0eUxvZ3MoYmFzZVBhdGgpO1xuICBjb25zdCBrZWVwUmVjZW50ID0gYWN0aXZpdGllcy5zbGljZSgtNSk7XG4gIGNvbnN0IGtlZXBTZXFzID0gbmV3IFNldChrZWVwUmVjZW50Lm1hcChlID0+IGUuc2VxKSk7XG4gIGNvbnN0IGN1dG9mZiA9IERhdGUubm93KCkgLSA3ICogMjQgKiA2MCAqIDYwICogMTAwMDtcblxuICBmb3IgKGNvbnN0IGUgb2YgYWN0aXZpdGllcykge1xuICAgIGlmIChrZWVwU2Vxcy5oYXMoZS5zZXEpKSBjb250aW51ZTtcbiAgICBpZiAoZS5tdGltZS5nZXRUaW1lKCkgPCBjdXRvZmYpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHVubGlua1N5bmMoam9pbihhY3Rpdml0eURpcihiYXNlUGF0aCksIGUuZmlsZW5hbWUpKTtcbiAgICAgICAgcmVtb3ZlZEFjdGl2aXR5Kys7XG4gICAgICB9IGNhdGNoIHsgLyogaWdub3JlICovIH1cbiAgICB9XG4gIH1cblxuICAvLyBDbGVhciBkZWJ1ZyBsb2dzIG9sZGVyIHRoYW4gMyBkYXlzLCBrZWVwIGxhdGVzdCAyXG4gIGNvbnN0IGRlYnVnTG9ncyA9IGxpc3REZWJ1Z0xvZ3MoYmFzZVBhdGgpO1xuICBjb25zdCBrZWVwRGVidWcgPSBkZWJ1Z0xvZ3Muc2xpY2UoLTIpO1xuICBjb25zdCBrZWVwRGVidWdOYW1lcyA9IG5ldyBTZXQoa2VlcERlYnVnLm1hcChkID0+IGQuZmlsZW5hbWUpKTtcbiAgY29uc3QgZGVidWdDdXRvZmYgPSBEYXRlLm5vdygpIC0gMyAqIDI0ICogNjAgKiA2MCAqIDEwMDA7XG5cbiAgZm9yIChjb25zdCBkIG9mIGRlYnVnTG9ncykge1xuICAgIGlmIChrZWVwRGVidWdOYW1lcy5oYXMoZC5maWxlbmFtZSkpIGNvbnRpbnVlO1xuICAgIGlmIChkLm10aW1lLmdldFRpbWUoKSA8IGRlYnVnQ3V0b2ZmKSB7XG4gICAgICB0cnkge1xuICAgICAgICB1bmxpbmtTeW5jKGpvaW4oZGVidWdEaXIoYmFzZVBhdGgpLCBkLmZpbGVuYW1lKSk7XG4gICAgICAgIHJlbW92ZWREZWJ1ZysrO1xuICAgICAgfSBjYXRjaCB7IC8qIGlnbm9yZSAqLyB9XG4gICAgfVxuICB9XG5cbiAgaWYgKHJlbW92ZWRBY3Rpdml0eSA9PT0gMCAmJiByZW1vdmVkRGVidWcgPT09IDApIHtcbiAgICBjdHgudWkubm90aWZ5KFwiTm8gb2xkIGxvZ3MgdG8gY2xlYXIuXCIsIFwiaW5mb1wiKTtcbiAgfSBlbHNlIHtcbiAgICBjdHgudWkubm90aWZ5KFxuICAgICAgYENsZWFyZWQgJHtyZW1vdmVkQWN0aXZpdHl9IGFjdGl2aXR5IGxvZyhzKSBhbmQgJHtyZW1vdmVkRGVidWd9IGRlYnVnIGxvZyhzKS5gLFxuICAgICAgXCJpbmZvXCIsXG4gICAgKTtcbiAgfVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBYUEsU0FBUyxZQUFZLGFBQWEsY0FBYyxVQUFVLGtCQUFrQjtBQUM1RSxTQUFTLFlBQVk7QUFDckIsU0FBUyxlQUFlO0FBQ3hCLFNBQVMsMEJBQTBCO0FBQ25DLFNBQVMsNEJBQTRCO0FBcUJyQyxTQUFTLFlBQVksVUFBMEI7QUFDN0MsU0FBTyxLQUFLLFFBQVEsUUFBUSxHQUFHLFVBQVU7QUFDM0M7QUFFQSxTQUFTLFNBQVMsVUFBMEI7QUFDMUMsU0FBTyxLQUFLLFFBQVEsUUFBUSxHQUFHLE9BQU87QUFDeEM7QUFFQSxTQUFTLGlCQUFpQixVQUE4QjtBQUN0RCxRQUFNLE1BQU0sWUFBWSxRQUFRO0FBQ2hDLE1BQUksQ0FBQyxXQUFXLEdBQUcsRUFBRyxRQUFPLENBQUM7QUFFOUIsUUFBTSxVQUFzQixDQUFDO0FBQzdCLE1BQUk7QUFDRixlQUFXLEtBQUssWUFBWSxHQUFHLEdBQUc7QUFDaEMsVUFBSSxDQUFDLEVBQUUsU0FBUyxRQUFRLEVBQUc7QUFJM0IsWUFBTSxRQUFRLEVBQUUsTUFBTSxzQ0FBc0M7QUFDNUQsVUFBSSxDQUFDLE1BQU87QUFFWixZQUFNLFdBQVcsS0FBSyxLQUFLLENBQUM7QUFDNUIsVUFBSTtBQUNKLFVBQUk7QUFB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
