import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getShellConfig, sanitizeCommand } from "@gsd/pi-coding-agent";
import { rewriteCommandWithRtk } from "../shared/rtk.js";
import {
  MAX_BUFFER_LINES,
  MAX_EVENTS,
  DEAD_PROCESS_TTL
} from "./types.js";
import { restoreWindowsVTInput, formatUptime } from "./utilities.js";
import { analyzeLine } from "./output-formatter.js";
import { startPortProbing, transitionToReady } from "./readiness-detector.js";
const processes = /* @__PURE__ */ new Map();
let pendingAlerts = [];
const MAX_PENDING_ALERTS = 50;
function setPendingAlerts(alerts) {
  pendingAlerts = alerts;
}
function addOutputLine(bg, stream, line) {
  bg.output.push({ stream, line, ts: Date.now() });
  if (stream === "stdout") bg.stdoutLineCount++;
  else bg.stderrLineCount++;
  if (bg.output.length > MAX_BUFFER_LINES) {
    const excess = bg.output.length - MAX_BUFFER_LINES;
    bg.output.splice(0, excess);
    bg.lastReadIndex = Math.max(0, bg.lastReadIndex - excess);
  }
}
function addEvent(bg, event) {
  const ev = { ...event, timestamp: Date.now() };
  bg.events.push(ev);
  if (bg.events.length > MAX_EVENTS) {
    bg.events.splice(0, bg.events.length - MAX_EVENTS);
  }
}
function pushAlert(bg, message) {
  const prefix = bg ? `[bg:${bg.id} ${bg.label}] ` : "";
  pendingAlerts.push(`${prefix}${message}`);
  if (pendingAlerts.length > MAX_PENDING_ALERTS) {
    pendingAlerts.splice(0, pendingAlerts.length - MAX_PENDING_ALERTS);
  }
}
function getInfo(p) {
  return {
    id: p.id,
    label: p.label,
    command: p.command,
    cwd: p.cwd,
    ownerSessionFile: p.ownerSessionFile,
    persistAcrossSessions: p.persistAcrossSessions,
    startedAt: p.startedAt,
    alive: p.alive,
    exitCode: p.exitCode,
    signal: p.signal,
    outputLines: p.output.length,
    stdoutLines: p.stdoutLineCount,
    stderrLines: p.stderrLineCount,
    status: p.status,
    processType: p.processType,
    ports: p.ports,
    urls: p.urls,
    group: p.group,
    restartCount: p.restartCount,
    uptime: formatUptime(Date.now() - p.startedAt),
    recentErrorCount: p.recentErrors.length,
    recentWarningCount: p.recentWarnings.length,
    eventCount: p.events.length
  };
}
function detectProcessType(command) {
  const cmd = command.toLowerCase();
  if (/\b(serve|server|dev|start)\b/.test(cmd) && /\b(npm|yarn|pnpm|bun|node|next|vite|nuxt|astro|remix|gatsby|uvicorn|flask|django|rails|cargo)\b/.test(cmd)) return "server";
  if (/\b(uvicorn|gunicorn|flask\s+run|manage\.py\s+runserver|rails\s+s)\b/.test(cmd)) return "server";
  if (/\b(http-server|live-server|serve)\b/.test(cmd)) return "server";
  if (/\b(build|compile|make|tsc|webpack|rollup|esbuild|swc)\b/.test(cmd)) {
    if (/\b(watch|--watch|-w)\b/.test(cmd)) return "watcher";
    return "build";
  }
  if (/\b(test|jest|vitest|mocha|pytest|cargo\s+test|go\s+test|rspec)\b/.test(cmd)) return "test";
  if (/\b(watch|nodemon|chokidar|fswatch|inotifywait)\b/.test(cmd)) return "watcher";
  return "generic";
}
function startProcess(opts) {
  const id = randomUUID().slice(0, 8);
  const processType = opts.type || detectProcessType(opts.command);
  const env = { ...process.env, ...opts.env || {} };
  const { shell, args: shellArgs } = getShellConfig();
  const command = processType === "shell" && !opts.command ? shell : rewriteCommandWithRtk(opts.command);
  const proc = spawn(shell, [...shellArgs, sanitizeCommand(command)], {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env,
    detached: process.platform !== "win32"
  });
  const bg = {
    id,
    label: opts.label || command.slice(0, 60),
    command,
    cwd: opts.cwd,
    ownerSessionFile: opts.ownerSessionFile ?? null,
    persistAcrossSessions: opts.persistAcrossSessions ?? false,
    startedAt: Date.now(),
    proc,
    output: [],
    exitCode: null,
    signal: null,
    alive: true,
    lastReadIndex: 0,
    processType,
    status: "starting",
    ports: [],
    urls: [],
    recentErrors: [],
    recentWarnings: [],
    events: [],
    readyPattern: opts.readyPattern || null,
    readyPort: opts.readyPort || null,
    wasReady: false,
    group: opts.group || null,
    lastErrorCount: 0,
    lastWarningCount: 0,
    stdoutLineCount: 0,
    stderrLineCount: 0,
    restartCount: 0,
    startConfig: {
      command,
      cwd: opts.cwd,
      label: opts.label || command.slice(0, 60),
      processType,
      ownerSessionFile: opts.ownerSessionFile ?? null,
      persistAcrossSessions: opts.persistAcrossSessions ?? false,
      readyPattern: opts.readyPattern || null,
      readyPort: opts.readyPort || null,
      group: opts.group || null
    }
  };
  addEvent(bg, { type: "started", detail: `Process started: ${command.slice(0, 100)}` });
  proc.stdout?.on("data", (chunk) => {
    const lines = chunk.toString().split("\n");
    for (const line of lines) {
      if (line.length > 0) {
        addOutputLine(bg, "stdout", line);
        analyzeLine(bg, line, "stdout");
      }
    }
  });
  proc.stderr?.on("data", (chunk) => {
    const lines = chunk.toString().split("\n");
    for (const line of lines) {
      if (line.length > 0) {
        addOutputLine(bg, "stderr", line);
        analyzeLine(bg, line, "stderr");
      }
    }
  });
  proc.on("exit", (code, sig) => {
    restoreWindowsVTInput();
    bg.alive = false;
    bg.exitCode = code;
    bg.signal = sig ?? null;
    if (code === 0) {
      bg.status = "exited";
      addEvent(bg, { type: "exited", detail: `Exited cleanly (code 0)` });
    } else {
      bg.status = "crashed";
      const lastErrors = bg.recentErrors.slice(-3).join("; ");
      const detail = `Crashed with code ${code}${sig ? ` (signal ${sig})` : ""}${lastErrors ? ` \u2014 ${lastErrors}` : ""}`;
      addEvent(bg, {
        type: "crashed",
        detail,
        data: { exitCode: code, signal: sig, lastErrors: bg.recentErrors.slice(-5) }
      });
      pushAlert(bg, `CRASHED (code ${code})${lastErrors ? `: ${lastErrors.slice(0, 120)}` : ""}`);
    }
  });
  proc.on("error", (err) => {
    bg.alive = false;
    bg.status = "crashed";
    addOutputLine(bg, "stderr", `[spawn error] ${err.message}`);
    addEvent(bg, { type: "crashed", detail: `Spawn error: ${err.message}` });
    pushAlert(bg, `spawn error: ${err.message}`);
  });
  if (bg.readyPort) {
    startPortProbing(bg, bg.readyPort, opts.readyTimeout);
  }
  if (bg.processType === "shell") {
    setTimeout(() => {
      if (bg.alive && bg.status === "starting") {
        transitionToReady(bg, "Shell session initialized");
      }
    }, 200);
  }
  processes.set(id, bg);
  return bg;
}
function killProcess(id, sig = "SIGTERM") {
  const bg = processes.get(id);
  if (!bg) return false;
  if (!bg.alive) return true;
  try {
    if (process.platform === "win32") {
      if (bg.proc.pid) {
        const result = spawnSync("taskkill", ["/F", "/T", "/PID", String(bg.proc.pid)], {
          timeout: 5e3,
          encoding: "utf-8"
        });
        if (result.status !== 0 && result.status !== 128) {
          bg.proc.kill(sig);
        }
      } else {
        bg.proc.kill(sig);
      }
    } else {
      if (bg.proc.pid) {
        try {
          process.kill(-bg.proc.pid, sig);
        } catch {
          bg.proc.kill(sig);
        }
      } else {
        bg.proc.kill(sig);
      }
    }
    return true;
  } catch {
    return false;
  }
}
async function restartProcess(id) {
  const old = processes.get(id);
  if (!old) return null;
  const config = old.startConfig;
  const restartCount = old.restartCount + 1;
  if (old.alive) {
    killProcess(id, "SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    if (old.alive) {
      killProcess(id, "SIGKILL");
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  processes.delete(id);
  const newBg = startProcess({
    command: config.command,
    cwd: config.cwd,
    label: config.label,
    type: config.processType,
    ownerSessionFile: config.ownerSessionFile,
    persistAcrossSessions: config.persistAcrossSessions,
    readyPattern: config.readyPattern || void 0,
    readyPort: config.readyPort || void 0,
    group: config.group || void 0
  });
  newBg.restartCount = restartCount;
  return newBg;
}
function getGroupProcesses(group) {
  return Array.from(processes.values()).filter((p) => p.group === group);
}
function getGroupStatus(group) {
  const procs = getGroupProcesses(group);
  const healthy = procs.length > 0 && procs.every((p) => p.alive && (p.status === "ready" || p.status === "starting"));
  return {
    group,
    healthy,
    processes: procs.map((p) => ({
      id: p.id,
      label: p.label,
      status: p.status,
      alive: p.alive
    }))
  };
}
function pruneDeadProcesses() {
  const now = Date.now();
  for (const [id, bg] of processes) {
    if (!bg.alive) {
      const ttl = bg.processType === "shell" ? DEAD_PROCESS_TTL * 6 : DEAD_PROCESS_TTL;
      if (now - bg.startedAt > ttl) {
        processes.delete(id);
      }
    }
  }
}
function cleanupAll() {
  for (const [id, bg] of processes) {
    if (bg.alive) killProcess(id, "SIGKILL");
  }
  processes.clear();
}
function killSessionProcesses() {
  for (const [id, bg] of processes) {
    if (bg.alive && !bg.persistAcrossSessions) {
      killProcess(id, "SIGTERM");
    }
  }
}
async function waitForProcessExit(bg, timeoutMs) {
  if (!bg.alive) return true;
  await new Promise((resolve) => {
    const done = () => resolve();
    const timer = setTimeout(done, timeoutMs);
    bg.proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  return !bg.alive;
}
async function cleanupSessionProcesses(sessionFile, options) {
  const graceMs = Math.max(0, options?.graceMs ?? 300);
  const matches = Array.from(processes.values()).filter(
    (bg) => bg.alive && !bg.persistAcrossSessions && bg.ownerSessionFile === sessionFile
  );
  if (matches.length === 0) return [];
  for (const bg of matches) {
    killProcess(bg.id, "SIGTERM");
  }
  if (graceMs > 0) {
    await Promise.all(matches.map((bg) => waitForProcessExit(bg, graceMs)));
  }
  for (const bg of matches) {
    if (bg.alive) killProcess(bg.id, "SIGKILL");
  }
  return matches.map((bg) => bg.id);
}
function getManifestPath(cwd) {
  const dir = join(cwd, ".bg-shell");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, "manifest.json");
}
function persistManifest(cwd) {
  try {
    const manifest = Array.from(processes.values()).filter((p) => p.alive).map((p) => ({
      id: p.id,
      label: p.label,
      command: p.command,
      cwd: p.cwd,
      ownerSessionFile: p.ownerSessionFile,
      persistAcrossSessions: p.persistAcrossSessions,
      startedAt: p.startedAt,
      processType: p.processType,
      group: p.group,
      readyPattern: p.readyPattern,
      readyPort: p.readyPort,
      pid: p.proc.pid
    }));
    writeFileSync(getManifestPath(cwd), JSON.stringify(manifest, null, 2));
  } catch {
  }
}
function loadManifest(cwd) {
  try {
    const path = getManifestPath(cwd);
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf-8"));
    }
  } catch {
  }
  return [];
}
export {
  addEvent,
  addOutputLine,
  cleanupAll,
  cleanupSessionProcesses,
  detectProcessType,
  getGroupProcesses,
  getGroupStatus,
  getInfo,
  getManifestPath,
  killProcess,
  killSessionProcesses,
  loadManifest,
  pendingAlerts,
  persistManifest,
  processes,
  pruneDeadProcesses,
  pushAlert,
  restartProcess,
  setPendingAlerts,
  startProcess
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2JnLXNoZWxsL3Byb2Nlc3MtbWFuYWdlci50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBQcm9jZXNzIGxpZmVjeWNsZSBtYW5hZ2VtZW50OiBzdGFydCwgc3RvcCwgcmVzdGFydCwgc2lnbmFsLCBzdGF0ZSB0cmFja2luZyxcbiAqIHByb2Nlc3MgcmVnaXN0cnksIGFuZCBwZXJzaXN0ZW5jZS5cbiAqL1xuXG5pbXBvcnQgeyBzcGF3biwgc3Bhd25TeW5jIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gXCJub2RlOmNyeXB0b1wiO1xuaW1wb3J0IHsgd3JpdGVGaWxlU3luYywgcmVhZEZpbGVTeW5jLCBleGlzdHNTeW5jLCBta2RpclN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGdldFNoZWxsQ29uZmlnLCBzYW5pdGl6ZUNvbW1hbmQgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB7IHJld3JpdGVDb21tYW5kV2l0aFJ0ayB9IGZyb20gXCIuLi9zaGFyZWQvcnRrLmpzXCI7XG5pbXBvcnQgdHlwZSB7XG5cdEJnUHJvY2Vzcyxcblx0QmdQcm9jZXNzSW5mbyxcblx0UHJvY2Vzc0V2ZW50LFxuXHRQcm9jZXNzTWFuaWZlc3QsXG5cdFByb2Nlc3NUeXBlLFxuXHRTdGFydE9wdGlvbnMsXG59IGZyb20gXCIuL3R5cGVzLmpzXCI7XG5pbXBvcnQge1xuXHRNQVhfQlVGRkVSX0xJTkVTLFxuXHRNQVhfRVZFTlRTLFxuXHRERUFEX1BST0NFU1NfVFRMLFxufSBmcm9tIFwiLi90eXBlcy5qc1wiO1xuaW1wb3J0IHsgcmVzdG9yZVdpbmRvd3NWVElucHV0LCBmb3JtYXRVcHRpbWUgfSBmcm9tIFwiLi91dGlsaXRpZXMuanNcIjtcbmltcG9ydCB7IGFuYWx5emVMaW5lIH0gZnJvbSBcIi4vb3V0cHV0LWZvcm1hdHRlci5qc1wiO1xuaW1wb3J0IHsgc3RhcnRQb3J0UHJvYmluZywgdHJhbnNpdGlvblRvUmVhZHkgfSBmcm9tIFwiLi9yZWFkaW5lc3MtZGV0ZWN0b3IuanNcIjtcblxuLy8gXHUyNTAwXHUyNTAwIFByb2Nlc3MgUmVnaXN0cnkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBjb25zdCBwcm9jZXNzZXMgPSBuZXcgTWFwPHN0cmluZywgQmdQcm9jZXNzPigpO1xuXG4vKiogUGVuZGluZyBhbGVydHMgdG8gaW5qZWN0IGludG8gdGhlIG5leHQgYWdlbnQgY29udGV4dCAqL1xuZXhwb3J0IGxldCBwZW5kaW5nQWxlcnRzOiBzdHJpbmdbXSA9IFtdO1xuXG5jb25zdCBNQVhfUEVORElOR19BTEVSVFMgPSA1MDtcblxuLyoqIFJlcGxhY2UgdGhlIHBlbmRpbmdBbGVydHMgYXJyYXkgKHVzZWQgYnkgdGhlIGV4dGVuc2lvbiBlbnRyeSBwb2ludCkgKi9cbmV4cG9ydCBmdW5jdGlvbiBzZXRQZW5kaW5nQWxlcnRzKGFsZXJ0czogc3RyaW5nW10pOiB2b2lkIHtcblx0cGVuZGluZ0FsZXJ0cyA9IGFsZXJ0cztcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFkZE91dHB1dExpbmUoYmc6IEJnUHJvY2Vzcywgc3RyZWFtOiBcInN0ZG91dFwiIHwgXCJzdGRlcnJcIiwgbGluZTogc3RyaW5nKTogdm9pZCB7XG5cdGJnLm91dHB1dC5wdXNoKHsgc3RyZWFtLCBsaW5lLCB0czogRGF0ZS5ub3coKSB9KTtcblx0aWYgKHN0cmVhbSA9PT0gXCJzdGRvdXRcIikgYmcuc3Rkb3V0TGluZUNvdW50Kys7XG5cdGVsc2UgYmcuc3RkZXJyTGluZUNvdW50Kys7XG5cdGlmIChiZy5vdXRwdXQubGVuZ3RoID4gTUFYX0JVRkZFUl9MSU5FUykge1xuXHRcdGNvbnN0IGV4Y2VzcyA9IGJnLm91dHB1dC5sZW5ndGggLSBNQVhfQlVGRkVSX0xJTkVTO1xuXHRcdGJnLm91dHB1dC5zcGxpY2UoMCwgZXhjZXNzKTtcblx0XHQvLyBBZGp1c3QgdGhlIHJlYWQgY3Vyc29yIHNvIGluY3JlbWVudGFsIGRlbGl2ZXJ5IHN0YXlzIGNvcnJlY3Rcblx0XHRiZy5sYXN0UmVhZEluZGV4ID0gTWF0aC5tYXgoMCwgYmcubGFzdFJlYWRJbmRleCAtIGV4Y2Vzcyk7XG5cdH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFkZEV2ZW50KGJnOiBCZ1Byb2Nlc3MsIGV2ZW50OiBPbWl0PFByb2Nlc3NFdmVudCwgXCJ0aW1lc3RhbXBcIj4pOiB2b2lkIHtcblx0Y29uc3QgZXY6IFByb2Nlc3NFdmVudCA9IHsgLi4uZXZlbnQsIHRpbWVzdGFtcDogRGF0ZS5ub3coKSB9O1xuXHRiZy5ldmVudHMucHVzaChldik7XG5cdGlmIChiZy5ldmVudHMubGVuZ3RoID4gTUFYX0VWRU5UUykge1xuXHRcdGJnLmV2ZW50cy5zcGxpY2UoMCwgYmcuZXZlbnRzLmxlbmd0aCAtIE1BWF9FVkVOVFMpO1xuXHR9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBwdXNoQWxlcnQoYmc6IEJnUHJvY2VzcyB8IG51bGwsIG1lc3NhZ2U6IHN0cmluZyk6IHZvaWQge1xuXHRjb25zdCBwcmVmaXggPSBiZyA/IGBbYmc6JHtiZy5pZH0gJHtiZy5sYWJlbH1dIGAgOiBcIlwiO1xuXHRwZW5kaW5nQWxlcnRzLnB1c2goYCR7cHJlZml4fSR7bWVzc2FnZX1gKTtcblx0aWYgKHBlbmRpbmdBbGVydHMubGVuZ3RoID4gTUFYX1BFTkRJTkdfQUxFUlRTKSB7XG5cdFx0cGVuZGluZ0FsZXJ0cy5zcGxpY2UoMCwgcGVuZGluZ0FsZXJ0cy5sZW5ndGggLSBNQVhfUEVORElOR19BTEVSVFMpO1xuXHR9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRJbmZvKHA6IEJnUHJvY2Vzcyk6IEJnUHJvY2Vzc0luZm8ge1xuXHRyZXR1cm4ge1xuXHRcdGlkOiBwLmlkLFxuXHRcdGxhYmVsOiBwLmxhYmVsLFxuXHRcdGNvbW1hbmQ6IHAuY29tbWFuZCxcblx0XHRjd2Q6IHAuY3dkLFxuXHRcdG93bmVyU2Vzc2lvbkZpbGU6IHAub3duZXJTZXNzaW9uRmlsZSxcblx0XHRwZXJzaXN0QWNyb3NzU2Vzc2lvbnM6IHAucGVyc2lzdEFjcm9zc1Nlc3Npb25zLFxuXHRcdHN0YXJ0ZWRBdDogcC5zdGFydGVkQXQsXG5cdFx0YWxpdmU6IHAuYWxpdmUsXG5cdFx0ZXhpdENvZGU6IHAuZXhpdENvZGUsXG5cdFx0c2lnbmFsOiBwLnNpZ25hbCxcblx0XHRvdXRwdXRMaW5lczogcC5vdXRwdXQubGVuZ3RoLFxuXHRcdHN0ZG91dExpbmVzOiBwLnN0ZG91dExpbmVDb3VudCxcblx0XHRzdGRlcnJMaW5lczogcC5zdGRlcnJMaW5lQ291bnQsXG5cdFx0c3RhdHVzOiBwLnN0YXR1cyxcblx0XHRwcm9jZXNzVHlwZTogcC5wcm9jZXNzVHlwZSxcblx0XHRwb3J0czogcC5wb3J0cyxcblx0XHR1cmxzOiBwLnVybHMsXG5cdFx0Z3JvdXA6IHAuZ3JvdXAsXG5cdFx0cmVzdGFydENvdW50OiBwLnJlc3RhcnRDb3VudCxcblx0XHR1cHRpbWU6IGZvcm1hdFVwdGltZShEYXRlLm5vdygpIC0gcC5zdGFydGVkQXQpLFxuXHRcdHJlY2VudEVycm9yQ291bnQ6IHAucmVjZW50RXJyb3JzLmxlbmd0aCxcblx0XHRyZWNlbnRXYXJuaW5nQ291bnQ6IHAucmVjZW50V2FybmluZ3MubGVuZ3RoLFxuXHRcdGV2ZW50Q291bnQ6IHAuZXZlbnRzLmxlbmd0aCxcblx0fTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwIFByb2Nlc3MgVHlwZSBEZXRlY3Rpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBmdW5jdGlvbiBkZXRlY3RQcm9jZXNzVHlwZShjb21tYW5kOiBzdHJpbmcpOiBQcm9jZXNzVHlwZSB7XG5cdGNvbnN0IGNtZCA9IGNvbW1hbmQudG9Mb3dlckNhc2UoKTtcblxuXHQvLyBTZXJ2ZXIgcGF0dGVybnNcblx0aWYgKFxuXHRcdC9cXGIoc2VydmV8c2VydmVyfGRldnxzdGFydClcXGIvLnRlc3QoY21kKSAmJlxuXHRcdC9cXGIobnBtfHlhcm58cG5wbXxidW58bm9kZXxuZXh0fHZpdGV8bnV4dHxhc3Ryb3xyZW1peHxnYXRzYnl8dXZpY29ybnxmbGFza3xkamFuZ298cmFpbHN8Y2FyZ28pXFxiLy50ZXN0KGNtZClcblx0KSByZXR1cm4gXCJzZXJ2ZXJcIjtcblx0aWYgKC9cXGIodXZpY29ybnxndW5pY29ybnxmbGFza1xccytydW58bWFuYWdlXFwucHlcXHMrcnVuc2VydmVyfHJhaWxzXFxzK3MpXFxiLy50ZXN0KGNtZCkpIHJldHVybiBcInNlcnZlclwiO1xuXHRpZiAoL1xcYihodHRwLXNlcnZlcnxsaXZlLXNlcnZlcnxzZXJ2ZSlcXGIvLnRlc3QoY21kKSkgcmV0dXJuIFwic2VydmVyXCI7XG5cblx0Ly8gQnVpbGQgcGF0dGVybnNcblx0aWYgKC9cXGIoYnVpbGR8Y29tcGlsZXxtYWtlfHRzY3x3ZWJwYWNrfHJvbGx1cHxlc2J1aWxkfHN3YylcXGIvLnRlc3QoY21kKSkge1xuXHRcdGlmICgvXFxiKHdhdGNofC0td2F0Y2h8LXcpXFxiLy50ZXN0KGNtZCkpIHJldHVybiBcIndhdGNoZXJcIjtcblx0XHRyZXR1cm4gXCJidWlsZFwiO1xuXHR9XG5cblx0Ly8gVGVzdCBwYXR0ZXJuc1xuXHRpZiAoL1xcYih0ZXN0fGplc3R8dml0ZXN0fG1vY2hhfHB5dGVzdHxjYXJnb1xccyt0ZXN0fGdvXFxzK3Rlc3R8cnNwZWMpXFxiLy50ZXN0KGNtZCkpIHJldHVybiBcInRlc3RcIjtcblxuXHQvLyBXYXRjaGVyIHBhdHRlcm5zXG5cdGlmICgvXFxiKHdhdGNofG5vZGVtb258Y2hva2lkYXJ8ZnN3YXRjaHxpbm90aWZ5d2FpdClcXGIvLnRlc3QoY21kKSkgcmV0dXJuIFwid2F0Y2hlclwiO1xuXG5cdHJldHVybiBcImdlbmVyaWNcIjtcbn1cblxuLy8gXHUyNTAwXHUyNTAwIFByb2Nlc3MgU3RhcnQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBmdW5jdGlvbiBzdGFydFByb2Nlc3Mob3B0czogU3RhcnRPcHRpb25zKTogQmdQcm9jZXNzIHtcblx0Y29uc3QgaWQgPSByYW5kb21VVUlEKCkuc2xpY2UoMCwgOCk7XG5cdGNvbnN0IHByb2Nlc3NUeXBlID0gb3B0cy50eXBlIHx8IGRldGVjdFByb2Nlc3NUeXBlKG9wdHMuY29tbWFuZCk7XG5cblx0Y29uc3QgZW52ID0geyAuLi5wcm9jZXNzLmVudiwgLi4uKG9wdHMuZW52IHx8IHt9KSB9O1xuXG5cdGNvbnN0IHsgc2hlbGwsIGFyZ3M6IHNoZWxsQXJncyB9ID0gZ2V0U2hlbGxDb25maWcoKTtcblx0Ly8gU2hlbGwgc2Vzc2lvbnMgZGVmYXVsdCB0byB0aGUgdXNlcidzIHNoZWxsIGlmIG5vIGNvbW1hbmQgc3BlY2lmaWVkXG5cdGNvbnN0IGNvbW1hbmQgPSBwcm9jZXNzVHlwZSA9PT0gXCJzaGVsbFwiICYmICFvcHRzLmNvbW1hbmRcblx0XHQ/IHNoZWxsXG5cdFx0OiByZXdyaXRlQ29tbWFuZFdpdGhSdGsob3B0cy5jb21tYW5kKTtcblx0Y29uc3QgcHJvYyA9IHNwYXduKHNoZWxsLCBbLi4uc2hlbGxBcmdzLCBzYW5pdGl6ZUNvbW1hbmQoY29tbWFuZCldLCB7XG5cdFx0Y3dkOiBvcHRzLmN3ZCxcblx0XHRzdGRpbzogW1wicGlwZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdLFxuXHRcdGVudixcblx0XHRkZXRhY2hlZDogcHJvY2Vzcy5wbGF0Zm9ybSAhPT0gXCJ3aW4zMlwiLFxuXHR9KTtcblxuXHRjb25zdCBiZzogQmdQcm9jZXNzID0ge1xuXHRcdGlkLFxuXHRcdGxhYmVsOiBvcHRzLmxhYmVsIHx8IGNvbW1hbmQuc2xpY2UoMCwgNjApLFxuXHRcdGNvbW1hbmQsXG5cdFx0Y3dkOiBvcHRzLmN3ZCxcblx0XHRvd25lclNlc3Npb25GaWxlOiBvcHRzLm93bmVyU2Vzc2lvbkZpbGUgPz8gbnVsbCxcblx0XHRwZXJzaXN0QWNyb3NzU2Vzc2lvbnM6IG9wdHMucGVyc2lzdEFjcm9zc1Nlc3Npb25zID8/IGZhbHNlLFxuXHRcdHN0YXJ0ZWRBdDogRGF0ZS5ub3coKSxcblx0XHRwcm9jLFxuXHRcdG91dHB1dDogW10sXG5cdFx0ZXhpdENvZGU6IG51bGwsXG5cdFx0c2lnbmFsOiBudWxsLFxuXHRcdGFsaXZlOiB0cnVlLFxuXHRcdGxhc3RSZWFkSW5kZXg6IDAsXG5cdFx0cHJvY2Vzc1R5cGUsXG5cdFx0c3RhdHVzOiBcInN0YXJ0aW5nXCIsXG5cdFx0cG9ydHM6IFtdLFxuXHRcdHVybHM6IFtdLFxuXHRcdHJlY2VudEVycm9yczogW10sXG5cdFx0cmVjZW50V2FybmluZ3M6IFtdLFxuXHRcdGV2ZW50czogW10sXG5cdFx0cmVhZHlQYXR0ZXJuOiBvcHRzLnJlYWR5UGF0dGVybiB8fCBudWxsLFxuXHRcdHJlYWR5UG9ydDogb3B0cy5yZWFkeVBvcnQgfHwgbnVsbCxcblx0XHR3YXNSZWFkeTogZmFsc2UsXG5cdFx0Z3JvdXA6IG9wdHMuZ3JvdXAgfHwgbnVsbCxcblx0XHRsYXN0RXJyb3JDb3VudDogMCxcblx0XHRsYXN0V2FybmluZ0NvdW50OiAwLFxuXHRcdHN0ZG91dExpbmVDb3VudDogMCxcblx0XHRzdGRlcnJMaW5lQ291bnQ6IDAsXG5cdFx0cmVzdGFydENvdW50OiAwLFxuXHRcdHN0YXJ0Q29uZmlnOiB7XG5cdFx0XHRjb21tYW5kLFxuXHRcdFx0Y3dkOiBvcHRzLmN3ZCxcblx0XHRcdGxhYmVsOiBvcHRzLmxhYmVsIHx8IGNvbW1hbmQuc2xpY2UoMCwgNjApLFxuXHRcdFx0cHJvY2Vzc1R5cGUsXG5cdFx0XHRvd25lclNlc3Npb25GaWxlOiBvcHRzLm93bmVyU2Vzc2lvbkZpbGUgPz8gbnVsbCxcblx0XHRcdHBlcnNpc3RBY3Jvc3NTZXNzaW9uczogb3B0cy5wZXJzaXN0QWNyb3NzU2Vzc2lvbnMgPz8gZmFsc2UsXG5cdFx0XHRyZWFkeVBhdHRlcm46IG9wdHMucmVhZHlQYXR0ZXJuIHx8IG51bGwsXG5cdFx0XHRyZWFkeVBvcnQ6IG9wdHMucmVhZHlQb3J0IHx8IG51bGwsXG5cdFx0XHRncm91cDogb3B0cy5ncm91cCB8fCBudWxsLFxuXHRcdH0sXG5cdH07XG5cblx0YWRkRXZlbnQoYmcsIHsgdHlwZTogXCJzdGFydGVkXCIsIGRldGFpbDogYFByb2Nlc3Mgc3RhcnRlZDogJHtjb21tYW5kLnNsaWNlKDAsIDEwMCl9YCB9KTtcblxuXHRwcm9jLnN0ZG91dD8ub24oXCJkYXRhXCIsIChjaHVuazogQnVmZmVyKSA9PiB7XG5cdFx0Y29uc3QgbGluZXMgPSBjaHVuay50b1N0cmluZygpLnNwbGl0KFwiXFxuXCIpO1xuXHRcdGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xuXHRcdFx0aWYgKGxpbmUubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRhZGRPdXRwdXRMaW5lKGJnLCBcInN0ZG91dFwiLCBsaW5lKTtcblx0XHRcdFx0YW5hbHl6ZUxpbmUoYmcsIGxpbmUsIFwic3Rkb3V0XCIpO1xuXHRcdFx0fVxuXHRcdH1cblx0fSk7XG5cblx0cHJvYy5zdGRlcnI/Lm9uKFwiZGF0YVwiLCAoY2h1bms6IEJ1ZmZlcikgPT4ge1xuXHRcdGNvbnN0IGxpbmVzID0gY2h1bmsudG9TdHJpbmcoKS5zcGxpdChcIlxcblwiKTtcblx0XHRmb3IgKGNvbnN0IGxpbmUgb2YgbGluZXMpIHtcblx0XHRcdGlmIChsaW5lLmxlbmd0aCA+IDApIHtcblx0XHRcdFx0YWRkT3V0cHV0TGluZShiZywgXCJzdGRlcnJcIiwgbGluZSk7XG5cdFx0XHRcdGFuYWx5emVMaW5lKGJnLCBsaW5lLCBcInN0ZGVyclwiKTtcblx0XHRcdH1cblx0XHR9XG5cdH0pO1xuXG5cdHByb2Mub24oXCJleGl0XCIsIChjb2RlLCBzaWcpID0+IHtcblx0XHRyZXN0b3JlV2luZG93c1ZUSW5wdXQoKTtcblx0XHRiZy5hbGl2ZSA9IGZhbHNlO1xuXHRcdGJnLmV4aXRDb2RlID0gY29kZTtcblx0XHRiZy5zaWduYWwgPSBzaWcgPz8gbnVsbDtcblxuXHRcdGlmIChjb2RlID09PSAwKSB7XG5cdFx0XHRiZy5zdGF0dXMgPSBcImV4aXRlZFwiO1xuXHRcdFx0YWRkRXZlbnQoYmcsIHsgdHlwZTogXCJleGl0ZWRcIiwgZGV0YWlsOiBgRXhpdGVkIGNsZWFubHkgKGNvZGUgMClgIH0pO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHRiZy5zdGF0dXMgPSBcImNyYXNoZWRcIjtcblx0XHRcdGNvbnN0IGxhc3RFcnJvcnMgPSBiZy5yZWNlbnRFcnJvcnMuc2xpY2UoLTMpLmpvaW4oXCI7IFwiKTtcblx0XHRcdGNvbnN0IGRldGFpbCA9IGBDcmFzaGVkIHdpdGggY29kZSAke2NvZGV9JHtzaWcgPyBgIChzaWduYWwgJHtzaWd9KWAgOiBcIlwifSR7bGFzdEVycm9ycyA/IGAgXHUyMDE0ICR7bGFzdEVycm9yc31gIDogXCJcIn1gO1xuXHRcdFx0YWRkRXZlbnQoYmcsIHtcblx0XHRcdFx0dHlwZTogXCJjcmFzaGVkXCIsXG5cdFx0XHRcdGRldGFpbCxcblx0XHRcdFx0ZGF0YTogeyBleGl0Q29kZTogY29kZSwgc2lnbmFsOiBzaWcsIGxhc3RFcnJvcnM6IGJnLnJlY2VudEVycm9ycy5zbGljZSgtNSkgfSxcblx0XHRcdH0pO1xuXHRcdFx0cHVzaEFsZXJ0KGJnLCBgQ1JBU0hFRCAoY29kZSAke2NvZGV9KSR7bGFzdEVycm9ycyA/IGA6ICR7bGFzdEVycm9ycy5zbGljZSgwLCAxMjApfWAgOiBcIlwifWApO1xuXHRcdH1cblx0fSk7XG5cblx0cHJvYy5vbihcImVycm9yXCIsIChlcnIpID0+IHtcblx0XHRiZy5hbGl2ZSA9IGZhbHNlO1xuXHRcdGJnLnN0YXR1cyA9IFwiY3Jhc2hlZFwiO1xuXHRcdGFkZE91dHB1dExpbmUoYmcsIFwic3RkZXJyXCIsIGBbc3Bhd24gZXJyb3JdICR7ZXJyLm1lc3NhZ2V9YCk7XG5cdFx0YWRkRXZlbnQoYmcsIHsgdHlwZTogXCJjcmFzaGVkXCIsIGRldGFpbDogYFNwYXduIGVycm9yOiAke2Vyci5tZXNzYWdlfWAgfSk7XG5cdFx0cHVzaEFsZXJ0KGJnLCBgc3Bhd24gZXJyb3I6ICR7ZXJyLm1lc3NhZ2V9YCk7XG5cdH0pO1xuXG5cdC8vIFBvcnQgcHJvYmluZyBmb3Igc2VydmVyLXR5cGUgcHJvY2Vzc2VzXG5cdGlmIChiZy5yZWFkeVBvcnQpIHtcblx0XHRzdGFydFBvcnRQcm9iaW5nKGJnLCBiZy5yZWFkeVBvcnQsIG9wdHMucmVhZHlUaW1lb3V0KTtcblx0fVxuXG5cdC8vIFNoZWxsIHNlc3Npb25zIGFyZSByZWFkeSBpbW1lZGlhdGVseSBhZnRlciBzcGF3blxuXHRpZiAoYmcucHJvY2Vzc1R5cGUgPT09IFwic2hlbGxcIikge1xuXHRcdHNldFRpbWVvdXQoKCkgPT4ge1xuXHRcdFx0aWYgKGJnLmFsaXZlICYmIGJnLnN0YXR1cyA9PT0gXCJzdGFydGluZ1wiKSB7XG5cdFx0XHRcdHRyYW5zaXRpb25Ub1JlYWR5KGJnLCBcIlNoZWxsIHNlc3Npb24gaW5pdGlhbGl6ZWRcIik7XG5cdFx0XHR9XG5cdFx0fSwgMjAwKTtcblx0fVxuXG5cdHByb2Nlc3Nlcy5zZXQoaWQsIGJnKTtcblx0cmV0dXJuIGJnO1xufVxuXG4vLyBcdTI1MDBcdTI1MDAgUHJvY2VzcyBLaWxsIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgZnVuY3Rpb24ga2lsbFByb2Nlc3MoaWQ6IHN0cmluZywgc2lnOiBOb2RlSlMuU2lnbmFscyA9IFwiU0lHVEVSTVwiKTogYm9vbGVhbiB7XG5cdGNvbnN0IGJnID0gcHJvY2Vzc2VzLmdldChpZCk7XG5cdGlmICghYmcpIHJldHVybiBmYWxzZTtcblx0aWYgKCFiZy5hbGl2ZSkgcmV0dXJuIHRydWU7XG5cdHRyeSB7XG5cdFx0aWYgKHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIikge1xuXHRcdFx0Ly8gV2luZG93czogdXNlIHRhc2traWxsIC9GIC9UIHRvIGZvcmNlLWtpbGwgdGhlIGVudGlyZSBwcm9jZXNzIHRyZWUuXG5cdFx0XHQvLyBwcm9jZXNzLmtpbGwoLXBpZCkgKFVuaXggcHJvY2VzcyBncm91cHMpIGRvZXMgbm90IHdvcmsgb24gV2luZG93cy5cblx0XHRcdGlmIChiZy5wcm9jLnBpZCkge1xuXHRcdFx0XHRjb25zdCByZXN1bHQgPSBzcGF3blN5bmMoXCJ0YXNra2lsbFwiLCBbXCIvRlwiLCBcIi9UXCIsIFwiL1BJRFwiLCBTdHJpbmcoYmcucHJvYy5waWQpXSwge1xuXHRcdFx0XHRcdHRpbWVvdXQ6IDUwMDAsXG5cdFx0XHRcdFx0ZW5jb2Rpbmc6IFwidXRmLThcIixcblx0XHRcdFx0fSk7XG5cdFx0XHRcdGlmIChyZXN1bHQuc3RhdHVzICE9PSAwICYmIHJlc3VsdC5zdGF0dXMgIT09IDEyOCkge1xuXHRcdFx0XHRcdC8vIHRhc2traWxsIGZhaWxlZCBcdTIwMTQgdHJ5IHRoZSBkaXJlY3Qga2lsbCBhcyBmYWxsYmFja1xuXHRcdFx0XHRcdGJnLnByb2Mua2lsbChzaWcpO1xuXHRcdFx0XHR9XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRiZy5wcm9jLmtpbGwoc2lnKTtcblx0XHRcdH1cblx0XHR9IGVsc2Uge1xuXHRcdFx0Ly8gVW5peC9tYWNPUzoga2lsbCB0aGUgcHJvY2VzcyBncm91cCB2aWEgbmVnYXRpdmUgUElEXG5cdFx0XHRpZiAoYmcucHJvYy5waWQpIHtcblx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRwcm9jZXNzLmtpbGwoLWJnLnByb2MucGlkLCBzaWcpO1xuXHRcdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0XHRiZy5wcm9jLmtpbGwoc2lnKTtcblx0XHRcdFx0fVxuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0YmcucHJvYy5raWxsKHNpZyk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdHJldHVybiB0cnVlO1xuXHR9IGNhdGNoIHtcblx0XHRyZXR1cm4gZmFsc2U7XG5cdH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwIFByb2Nlc3MgUmVzdGFydCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlc3RhcnRQcm9jZXNzKGlkOiBzdHJpbmcpOiBQcm9taXNlPEJnUHJvY2VzcyB8IG51bGw+IHtcblx0Y29uc3Qgb2xkID0gcHJvY2Vzc2VzLmdldChpZCk7XG5cdGlmICghb2xkKSByZXR1cm4gbnVsbDtcblxuXHRjb25zdCBjb25maWcgPSBvbGQuc3RhcnRDb25maWc7XG5cdGNvbnN0IHJlc3RhcnRDb3VudCA9IG9sZC5yZXN0YXJ0Q291bnQgKyAxO1xuXG5cdC8vIEtpbGwgb2xkIHByb2Nlc3Ncblx0aWYgKG9sZC5hbGl2ZSkge1xuXHRcdGtpbGxQcm9jZXNzKGlkLCBcIlNJR1RFUk1cIik7XG5cdFx0YXdhaXQgbmV3IFByb21pc2UociA9PiBzZXRUaW1lb3V0KHIsIDMwMCkpO1xuXHRcdGlmIChvbGQuYWxpdmUpIHtcblx0XHRcdGtpbGxQcm9jZXNzKGlkLCBcIlNJR0tJTExcIik7XG5cdFx0XHRhd2FpdCBuZXcgUHJvbWlzZShyID0+IHNldFRpbWVvdXQociwgMjAwKSk7XG5cdFx0fVxuXHR9XG5cdHByb2Nlc3Nlcy5kZWxldGUoaWQpO1xuXG5cdC8vIFN0YXJ0IG5ldyBvbmVcblx0Y29uc3QgbmV3QmcgPSBzdGFydFByb2Nlc3Moe1xuXHRcdGNvbW1hbmQ6IGNvbmZpZy5jb21tYW5kLFxuXHRcdGN3ZDogY29uZmlnLmN3ZCxcblx0XHRsYWJlbDogY29uZmlnLmxhYmVsLFxuXHRcdHR5cGU6IGNvbmZpZy5wcm9jZXNzVHlwZSxcblx0XHRvd25lclNlc3Npb25GaWxlOiBjb25maWcub3duZXJTZXNzaW9uRmlsZSxcblx0XHRwZXJzaXN0QWNyb3NzU2Vzc2lvbnM6IGNvbmZpZy5wZXJzaXN0QWNyb3NzU2Vzc2lvbnMsXG5cdFx0cmVhZHlQYXR0ZXJuOiBjb25maWcucmVhZHlQYXR0ZXJuIHx8IHVuZGVmaW5lZCxcblx0XHRyZWFkeVBvcnQ6IGNvbmZpZy5yZWFkeVBvcnQgfHwgdW5kZWZpbmVkLFxuXHRcdGdyb3VwOiBjb25maWcuZ3JvdXAgfHwgdW5kZWZpbmVkLFxuXHR9KTtcblx0bmV3QmcucmVzdGFydENvdW50ID0gcmVzdGFydENvdW50O1xuXG5cdHJldHVybiBuZXdCZztcbn1cblxuLy8gXHUyNTAwXHUyNTAwIEdyb3VwIE9wZXJhdGlvbnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRHcm91cFByb2Nlc3Nlcyhncm91cDogc3RyaW5nKTogQmdQcm9jZXNzW10ge1xuXHRyZXR1cm4gQXJyYXkuZnJvbShwcm9jZXNzZXMudmFsdWVzKCkpLmZpbHRlcihwID0+IHAuZ3JvdXAgPT09IGdyb3VwKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldEdyb3VwU3RhdHVzKGdyb3VwOiBzdHJpbmcpOiB7XG5cdGdyb3VwOiBzdHJpbmc7XG5cdGhlYWx0aHk6IGJvb2xlYW47XG5cdHByb2Nlc3NlczogeyBpZDogc3RyaW5nOyBsYWJlbDogc3RyaW5nOyBzdGF0dXM6IGltcG9ydChcIi4vdHlwZXMuanNcIikuUHJvY2Vzc1N0YXR1czsgYWxpdmU6IGJvb2xlYW4gfVtdO1xufSB7XG5cdGNvbnN0IHByb2NzID0gZ2V0R3JvdXBQcm9jZXNzZXMoZ3JvdXApO1xuXHRjb25zdCBoZWFsdGh5ID0gcHJvY3MubGVuZ3RoID4gMCAmJiBwcm9jcy5ldmVyeShwID0+IHAuYWxpdmUgJiYgKHAuc3RhdHVzID09PSBcInJlYWR5XCIgfHwgcC5zdGF0dXMgPT09IFwic3RhcnRpbmdcIikpO1xuXHRyZXR1cm4ge1xuXHRcdGdyb3VwLFxuXHRcdGhlYWx0aHksXG5cdFx0cHJvY2Vzc2VzOiBwcm9jcy5tYXAocCA9PiAoe1xuXHRcdFx0aWQ6IHAuaWQsXG5cdFx0XHRsYWJlbDogcC5sYWJlbCxcblx0XHRcdHN0YXR1czogcC5zdGF0dXMsXG5cdFx0XHRhbGl2ZTogcC5hbGl2ZSxcblx0XHR9KSksXG5cdH07XG59XG5cbi8vIFx1MjUwMFx1MjUwMCBDbGVhbnVwIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgZnVuY3Rpb24gcHJ1bmVEZWFkUHJvY2Vzc2VzKCk6IHZvaWQge1xuXHRjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuXHRmb3IgKGNvbnN0IFtpZCwgYmddIG9mIHByb2Nlc3Nlcykge1xuXHRcdGlmICghYmcuYWxpdmUpIHtcblx0XHRcdGNvbnN0IHR0bCA9IGJnLnByb2Nlc3NUeXBlID09PSBcInNoZWxsXCIgPyBERUFEX1BST0NFU1NfVFRMICogNiA6IERFQURfUFJPQ0VTU19UVEw7XG5cdFx0XHRpZiAobm93IC0gYmcuc3RhcnRlZEF0ID4gdHRsKSB7XG5cdFx0XHRcdHByb2Nlc3Nlcy5kZWxldGUoaWQpO1xuXHRcdFx0fVxuXHRcdH1cblx0fVxufVxuXG5leHBvcnQgZnVuY3Rpb24gY2xlYW51cEFsbCgpOiB2b2lkIHtcblx0Zm9yIChjb25zdCBbaWQsIGJnXSBvZiBwcm9jZXNzZXMpIHtcblx0XHRpZiAoYmcuYWxpdmUpIGtpbGxQcm9jZXNzKGlkLCBcIlNJR0tJTExcIik7XG5cdH1cblx0cHJvY2Vzc2VzLmNsZWFyKCk7XG59XG5cbi8qKlxuICogS2lsbCBhbGwgYWxpdmUsIG5vbi1wZXJzaXN0ZW50IGJnIHByb2Nlc3Nlcy5cbiAqIENhbGxlZCBiZXR3ZWVuIGF1dG8tbW9kZSB1bml0cyB0byBwcmV2ZW50IG9ycGhhbmVkIHNlcnZlcnMgZnJvbVxuICoga2VlcGluZyBwb3J0cyBib3VuZCBhY3Jvc3MgdGFzayBib3VuZGFyaWVzICgjMTIwOSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBraWxsU2Vzc2lvblByb2Nlc3NlcygpOiB2b2lkIHtcblx0Zm9yIChjb25zdCBbaWQsIGJnXSBvZiBwcm9jZXNzZXMpIHtcblx0XHRpZiAoYmcuYWxpdmUgJiYgIWJnLnBlcnNpc3RBY3Jvc3NTZXNzaW9ucykge1xuXHRcdFx0a2lsbFByb2Nlc3MoaWQsIFwiU0lHVEVSTVwiKTtcblx0XHR9XG5cdH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gd2FpdEZvclByb2Nlc3NFeGl0KGJnOiBCZ1Byb2Nlc3MsIHRpbWVvdXRNczogbnVtYmVyKTogUHJvbWlzZTxib29sZWFuPiB7XG5cdGlmICghYmcuYWxpdmUpIHJldHVybiB0cnVlO1xuXHRhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4ge1xuXHRcdGNvbnN0IGRvbmUgPSAoKSA9PiByZXNvbHZlKCk7XG5cdFx0Y29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KGRvbmUsIHRpbWVvdXRNcyk7XG5cdFx0YmcucHJvYy5vbmNlKFwiZXhpdFwiLCAoKSA9PiB7XG5cdFx0XHRjbGVhclRpbWVvdXQodGltZXIpO1xuXHRcdFx0cmVzb2x2ZSgpO1xuXHRcdH0pO1xuXHR9KTtcblx0cmV0dXJuICFiZy5hbGl2ZTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNsZWFudXBTZXNzaW9uUHJvY2Vzc2VzKFxuXHRzZXNzaW9uRmlsZTogc3RyaW5nLFxuXHRvcHRpb25zPzogeyBncmFjZU1zPzogbnVtYmVyIH0sXG4pOiBQcm9taXNlPHN0cmluZ1tdPiB7XG5cdGNvbnN0IGdyYWNlTXMgPSBNYXRoLm1heCgwLCBvcHRpb25zPy5ncmFjZU1zID8/IDMwMCk7XG5cdGNvbnN0IG1hdGNoZXMgPSBBcnJheS5mcm9tKHByb2Nlc3Nlcy52YWx1ZXMoKSkuZmlsdGVyKFxuXHRcdChiZykgPT4gYmcuYWxpdmUgJiYgIWJnLnBlcnNpc3RBY3Jvc3NTZXNzaW9ucyAmJiBiZy5vd25lclNlc3Npb25GaWxlID09PSBzZXNzaW9uRmlsZSxcblx0KTtcblx0aWYgKG1hdGNoZXMubGVuZ3RoID09PSAwKSByZXR1cm4gW107XG5cblx0Zm9yIChjb25zdCBiZyBvZiBtYXRjaGVzKSB7XG5cdFx0a2lsbFByb2Nlc3MoYmcuaWQsIFwiU0lHVEVSTVwiKTtcblx0fVxuXHRpZiAoZ3JhY2VNcyA+IDApIHtcblx0XHRhd2FpdCBQcm9taXNlLmFsbChtYXRjaGVzLm1hcCgoYmcpID0+IHdhaXRGb3JQcm9jZXNzRXhpdChiZywgZ3JhY2VNcykpKTtcblx0fVxuXHRmb3IgKGNvbnN0IGJnIG9mIG1hdGNoZXMpIHtcblx0XHRpZiAoYmcuYWxpdmUpIGtpbGxQcm9jZXNzKGJnLmlkLCBcIlNJR0tJTExcIik7XG5cdH1cblx0cmV0dXJuIG1hdGNoZXMubWFwKChiZykgPT4gYmcuaWQpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDAgUGVyc2lzdGVuY2UgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRNYW5pZmVzdFBhdGgoY3dkOiBzdHJpbmcpOiBzdHJpbmcge1xuXHRjb25zdCBkaXIgPSBqb2luKGN3ZCwgXCIuYmctc2hlbGxcIik7XG5cdGlmICghZXhpc3RzU3luYyhkaXIpKSBta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblx0cmV0dXJuIGpvaW4oZGlyLCBcIm1hbmlmZXN0Lmpzb25cIik7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBwZXJzaXN0TWFuaWZlc3QoY3dkOiBzdHJpbmcpOiB2b2lkIHtcblx0dHJ5IHtcblx0XHRjb25zdCBtYW5pZmVzdDogUHJvY2Vzc01hbmlmZXN0W10gPSBBcnJheS5mcm9tKHByb2Nlc3Nlcy52YWx1ZXMoKSlcblx0XHRcdC5maWx0ZXIocCA9PiBwLmFsaXZlKVxuXHRcdFx0Lm1hcChwID0+ICh7XG5cdFx0XHRcdGlkOiBwLmlkLFxuXHRcdFx0XHRsYWJlbDogcC5sYWJlbCxcblx0XHRcdFx0Y29tbWFuZDogcC5jb21tYW5kLFxuXHRcdFx0XHRjd2Q6IHAuY3dkLFxuXHRcdFx0XHRvd25lclNlc3Npb25GaWxlOiBwLm93bmVyU2Vzc2lvbkZpbGUsXG5cdFx0XHRcdHBlcnNpc3RBY3Jvc3NTZXNzaW9uczogcC5wZXJzaXN0QWNyb3NzU2Vzc2lvbnMsXG5cdFx0XHRcdHN0YXJ0ZWRBdDogcC5zdGFydGVkQXQsXG5cdFx0XHRcdHByb2Nlc3NUeXBlOiBwLnByb2Nlc3NUeXBlLFxuXHRcdFx0XHRncm91cDogcC5ncm91cCxcblx0XHRcdFx0cmVhZHlQYXR0ZXJuOiBwLnJlYWR5UGF0dGVybixcblx0XHRcdFx0cmVhZHlQb3J0OiBwLnJlYWR5UG9ydCxcblx0XHRcdFx0cGlkOiBwLnByb2MucGlkLFxuXHRcdFx0fSkpO1xuXHRcdHdyaXRlRmlsZVN5bmMoZ2V0TWFuaWZlc3RQYXRoKGN3ZCksIEpTT04uc3RyaW5naWZ5KG1hbmlmZXN0LCBudWxsLCAyKSk7XG5cdH0gY2F0Y2ggeyAvKiBiZXN0IGVmZm9ydCAqLyB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBsb2FkTWFuaWZlc3QoY3dkOiBzdHJpbmcpOiBQcm9jZXNzTWFuaWZlc3RbXSB7XG5cdHRyeSB7XG5cdFx0Y29uc3QgcGF0aCA9IGdldE1hbmlmZXN0UGF0aChjd2QpO1xuXHRcdGlmIChleGlzdHNTeW5jKHBhdGgpKSB7XG5cdFx0XHRyZXR1cm4gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGYtOFwiKSk7XG5cdFx0fVxuXHR9IGNhdGNoIHsgLyogYmVzdCBlZmZvcnQgKi8gfVxuXHRyZXR1cm4gW107XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFLQSxTQUFTLE9BQU8saUJBQWlCO0FBQ2pDLFNBQVMsa0JBQWtCO0FBQzNCLFNBQVMsZUFBZSxjQUFjLFlBQVksaUJBQWlCO0FBQ25FLFNBQVMsWUFBWTtBQUNyQixTQUFTLGdCQUFnQix1QkFBdUI7QUFDaEQsU0FBUyw2QkFBNkI7QUFTdEM7QUFBQSxFQUNDO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNNO0FBQ1AsU0FBUyx1QkFBdUIsb0JBQW9CO0FBQ3BELFNBQVMsbUJBQW1CO0FBQzVCLFNBQVMsa0JBQWtCLHlCQUF5QjtBQUk3QyxNQUFNLFlBQVksb0JBQUksSUFBdUI7QUFHN0MsSUFBSSxnQkFBMEIsQ0FBQztBQUV0QyxNQUFNLHFCQUFxQjtBQUdwQixTQUFTLGlCQUFpQixRQUF3QjtBQUN4RCxrQkFBZ0I7QUFDakI7QUFFTyxTQUFTLGNBQWMsSUFBZSxRQUE2QixNQUFvQjtBQUM3RixLQUFHLE9BQU8sS0FBSyxFQUFFLFFBQVEsTUFBTSxJQUFJLEtBQUssSUFBSSxFQUFFLENBQUM7QUFDL0MsTUFBSSxXQUFXLFNBQVUsSUFBRztBQUFBLE1BQ3ZCLElBQUc7QUFDUixNQUFJLEdBQUcsT0FBTyxTQUFTLGtCQUFrQjtBQUN4QyxVQUFNLFNBQVMsR0FBRyxPQUFPLFNBQVM7QUFDbEMsT0FBRyxPQUFPLE9BQU8sR0FBRyxNQUFNO0FBRTFCLE9BQUcsZ0JBQWdCLEtBQUssSUFBSSxHQUFHLEdBQUcsZ0JBQWdCLE1BQU07QUFBQSxFQUN6RDtBQUNEO0FBRU8sU0FBUyxTQUFTLElBQWUsT0FBOEM7QUFDckYsUUFBTSxLQUFtQixF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
