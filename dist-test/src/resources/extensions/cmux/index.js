import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { CMUX_CHANNELS } from "../shared/cmux-events.js";
const DEFAULT_SOCKET_PATH = "/tmp/cmux.sock";
const STATUS_KEY = "gsd";
const lastSidebarSnapshots = /* @__PURE__ */ new Map();
let cmuxPromptedThisSession = false;
let cachedCliAvailability = null;
function detectCmuxEnvironment(env = process.env, socketExists = existsSync, cliAvailable = isCmuxCliAvailable) {
  const socketPath = env.CMUX_SOCKET_PATH ?? DEFAULT_SOCKET_PATH;
  const workspaceId = env.CMUX_WORKSPACE_ID?.trim() || void 0;
  const surfaceId = env.CMUX_SURFACE_ID?.trim() || void 0;
  const available = Boolean(workspaceId && surfaceId && socketExists(socketPath));
  return {
    available,
    cliAvailable: cliAvailable(),
    socketPath,
    workspaceId,
    surfaceId
  };
}
function resolveCmuxConfig(preferences, env = process.env, socketExists = existsSync, cliAvailable = isCmuxCliAvailable) {
  const detected = detectCmuxEnvironment(env, socketExists, cliAvailable);
  const cmux = preferences?.cmux ?? {};
  const enabled = detected.available && cmux.enabled === true;
  return {
    ...detected,
    enabled,
    notifications: enabled && cmux.notifications !== false,
    sidebar: enabled && cmux.sidebar !== false,
    splits: enabled && cmux.splits === true,
    browser: enabled && cmux.browser === true
  };
}
function shouldPromptToEnableCmux(preferences, env = process.env, socketExists = existsSync, cliAvailable = isCmuxCliAvailable) {
  if (cmuxPromptedThisSession) return false;
  const detected = detectCmuxEnvironment(env, socketExists, cliAvailable);
  if (!detected.available) return false;
  return preferences?.cmux?.enabled === void 0;
}
function markCmuxPromptShown() {
  cmuxPromptedThisSession = true;
}
function resetCmuxPromptState() {
  cmuxPromptedThisSession = false;
}
function isCmuxCliAvailable() {
  if (cachedCliAvailability !== null) return cachedCliAvailability;
  try {
    execFileSync("cmux", ["--help"], { stdio: "ignore", timeout: 1e3 });
    cachedCliAvailability = true;
  } catch {
    cachedCliAvailability = false;
  }
  return cachedCliAvailability;
}
function supportsOsc777Notifications(env = process.env) {
  const termProgram = env.TERM_PROGRAM?.toLowerCase() ?? "";
  return termProgram === "ghostty" || termProgram === "wezterm" || termProgram === "iterm.app";
}
function emitOsc777Notification(title, body) {
  if (!supportsOsc777Notifications()) return;
  const safeTitle = normalizeNotificationText(title).replace(/;/g, ",");
  const safeBody = normalizeNotificationText(body).replace(/;/g, ",");
  process.stdout.write(`\x1B]777;notify;${safeTitle};${safeBody}\x07`);
}
function buildCmuxStatusLabel(state) {
  const parts = [];
  if (state.activeMilestone) parts.push(state.activeMilestone.id);
  if (state.activeSlice) parts.push(state.activeSlice.id);
  if (state.activeTask) {
    const prev = parts.pop();
    parts.push(prev ? `${prev}/${state.activeTask.id}` : state.activeTask.id);
  }
  if (parts.length === 0) return state.phase;
  return `${parts.join(" ")} \xB7 ${state.phase}`;
}
function buildCmuxProgress(state) {
  const progress = state.progress;
  if (!progress) return null;
  const choose = (done, total, label) => {
    if (total <= 0) return null;
    return { value: Math.max(0, Math.min(1, done / total)), label: `${done}/${total} ${label}` };
  };
  return choose(progress.tasks?.done ?? 0, progress.tasks?.total ?? 0, "tasks") ?? choose(progress.slices?.done ?? 0, progress.slices?.total ?? 0, "slices") ?? choose(progress.milestones.done, progress.milestones.total, "milestones");
}
function phaseVisuals(phase) {
  switch (phase) {
    case "blocked":
      return { icon: "triangle-alert", color: "#ef4444" };
    case "paused":
      return { icon: "pause", color: "#f59e0b" };
    case "complete":
    case "completing-milestone":
      return { icon: "check", color: "#22c55e" };
    case "planning":
    case "researching":
    case "replanning-slice":
      return { icon: "compass", color: "#3b82f6" };
    case "validating-milestone":
    case "verifying":
      return { icon: "shield-check", color: "#06b6d4" };
    default:
      return { icon: "rocket", color: "#4ade80" };
  }
}
function sidebarSnapshotKey(config) {
  return config.workspaceId ?? "default";
}
class CmuxClient {
  config;
  constructor(config) {
    this.config = config;
  }
  static fromPreferences(preferences) {
    return new CmuxClient(resolveCmuxConfig(preferences));
  }
  getConfig() {
    return this.config;
  }
  canRun() {
    return this.config.available && this.config.cliAvailable;
  }
  appendWorkspace(args) {
    return this.config.workspaceId ? [...args, "--workspace", this.config.workspaceId] : args;
  }
  appendSurface(args, surfaceId) {
    return surfaceId ? [...args, "--surface", surfaceId] : args;
  }
  runSync(args) {
    if (!this.canRun()) return null;
    try {
      return execFileSync("cmux", args, {
        encoding: "utf-8",
        timeout: 3e3,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env
      });
    } catch {
      return null;
    }
  }
  async runAsync(args) {
    if (!this.canRun()) return null;
    return new Promise((resolve) => {
      const child = spawn("cmux", args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env
      });
      const chunks = [];
      let settled = false;
      const done = (result) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };
      const timer = setTimeout(() => {
        child.kill();
        done(null);
      }, 5e3);
      child.stdout.on("data", (chunk) => chunks.push(chunk));
      child.on("close", (code) => {
        clearTimeout(timer);
        done(code === 0 ? Buffer.concat(chunks).toString("utf-8") : null);
      });
      child.on("error", () => {
        clearTimeout(timer);
        done(null);
      });
    });
  }
  getCapabilities() {
    const stdout = this.runSync(["capabilities", "--json"]);
    return stdout ? parseJson(stdout) : null;
  }
  identify() {
    const stdout = this.runSync(["identify", "--json"]);
    return stdout ? parseJson(stdout) : null;
  }
  setStatus(label, phase) {
    if (!this.config.sidebar) return;
    const visuals = phaseVisuals(phase);
    this.runSync(this.appendWorkspace([
      "set-status",
      STATUS_KEY,
      label,
      "--icon",
      visuals.icon,
      "--color",
      visuals.color
    ]));
  }
  clearStatus() {
    if (!this.config.sidebar) return;
    this.runSync(this.appendWorkspace(["clear-status", STATUS_KEY]));
  }
  setProgress(progress) {
    if (!this.config.sidebar) return;
    if (!progress) {
      this.runSync(this.appendWorkspace(["clear-progress"]));
      return;
    }
    this.runSync(this.appendWorkspace([
      "set-progress",
      progress.value.toFixed(3),
      "--label",
      progress.label
    ]));
  }
  log(message, level = "info", source = "gsd") {
    if (!this.config.sidebar) return;
    this.runSync(this.appendWorkspace([
      "log",
      "--level",
      level,
      "--source",
      source,
      "--",
      message
    ]));
  }
  notify(title, body, subtitle) {
    if (!this.config.notifications) return false;
    const args = ["notify", "--title", title, "--body", body];
    if (subtitle) args.push("--subtitle", subtitle);
    return this.runSync(args) !== null;
  }
  async listSurfaceIds() {
    const stdout = await this.runAsync(this.appendWorkspace(["list-surfaces", "--json", "--id-format", "both"]));
    const parsed = stdout ? parseJson(stdout) : null;
    return extractSurfaceIds(parsed);
  }
  async createSplit(direction) {
    return this.createSplitFrom(this.config.surfaceId, direction);
  }
  async createSplitFrom(sourceSurfaceId, direction) {
    if (!this.config.splits) return null;
    const before = new Set(await this.listSurfaceIds());
    const args = ["new-split", direction];
    const scopedArgs = this.appendSurface(this.appendWorkspace(args), sourceSurfaceId);
    await this.runAsync(scopedArgs);
    const after = await this.listSurfaceIds();
    for (const id of after) {
      if (!before.has(id)) return id;
    }
    return null;
  }
  /**
   * Create a grid of surfaces for parallel agent execution.
   *
   * Layout strategy (gsd stays in the original surface):
   *   1 agent:  [gsd | A]
   *   2 agents: [gsd | A]
   *             [    | B]
   *   3 agents: [gsd | A]
   *             [ C  | B]
   *   4 agents: [gsd | A]
   *             [ C  | B]  (D splits from B downward)
   *             [    | D]
   *
   * Returns surface IDs in order, or empty array on failure.
   */
  async createGridLayout(count) {
    if (!this.config.splits || count <= 0) return [];
    const surfaces = [];
    const rightCol = await this.createSplitFrom(this.config.surfaceId, "right");
    if (!rightCol) return [];
    surfaces.push(rightCol);
    if (count === 1) return surfaces;
    const bottomRight = await this.createSplitFrom(rightCol, "down");
    if (!bottomRight) return surfaces;
    surfaces.push(bottomRight);
    if (count === 2) return surfaces;
    const bottomLeft = await this.createSplitFrom(this.config.surfaceId, "down");
    if (!bottomLeft) return surfaces;
    surfaces.push(bottomLeft);
    if (count === 3) return surfaces;
    let lastSurface = bottomRight;
    for (let i = 3; i < count; i++) {
      const next = await this.createSplitFrom(lastSurface, "down");
      if (!next) break;
      surfaces.push(next);
      lastSurface = next;
    }
    return surfaces;
  }
  async sendSurface(surfaceId, text) {
    const payload = text.endsWith("\n") ? text : `${text}
`;
    const stdout = await this.runAsync(["send-surface", "--surface", surfaceId, payload]);
    return stdout !== null;
  }
  // Send Ctrl-C (ETX) to a surface to interrupt the running command.
  async sendInterrupt(surfaceId) {
    const stdout = await this.runAsync(["send-surface", "--surface", surfaceId, ""]);
    return stdout !== null;
  }
}
function syncCmuxSidebar(preferences, state) {
  const client = CmuxClient.fromPreferences(preferences);
  const config = client.getConfig();
  if (!config.sidebar) return;
  const label = buildCmuxStatusLabel(state);
  const progress = buildCmuxProgress(state);
  const snapshot = JSON.stringify({ label, progress, phase: state.phase });
  const key = sidebarSnapshotKey(config);
  if (lastSidebarSnapshots.get(key) === snapshot) return;
  client.setStatus(label, state.phase);
  client.setProgress(progress);
  lastSidebarSnapshots.set(key, snapshot);
}
function clearCmuxSidebar(preferences) {
  const config = resolveCmuxConfig(preferences);
  if (!config.available || !config.cliAvailable) return;
  const client = new CmuxClient({ ...config, enabled: true, sidebar: true });
  const key = sidebarSnapshotKey(config);
  client.clearStatus();
  client.setProgress(null);
  lastSidebarSnapshots.delete(key);
}
function logCmuxEvent(preferences, message, level = "info") {
  CmuxClient.fromPreferences(preferences).log(message, level);
}
function shellEscape(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
function normalizeNotificationText(value) {
  return value.replace(/\r?\n/g, " ").trim();
}
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function extractSurfaceIds(value) {
  const found = /* @__PURE__ */ new Set();
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if (typeof child === "string" && (key === "surface_id" || key === "surface" || key === "id" && child.includes("surface"))) {
        found.add(child);
      }
      visit(child);
    }
  };
  visit(value);
  return Array.from(found);
}
function initCmuxEventListeners(events) {
  events.on(CMUX_CHANNELS.SIDEBAR, (data) => {
    const event = data;
    if (event.action === "sync" && event.state) {
      syncCmuxSidebar(event.preferences, event.state);
    }
    if (event.action === "clear") {
      clearCmuxSidebar(event.preferences);
    }
  });
  events.on(CMUX_CHANNELS.LOG, (data) => {
    const event = data;
    logCmuxEvent(event.preferences, event.message, event.level);
  });
}
export {
  CmuxClient,
  buildCmuxProgress,
  buildCmuxStatusLabel,
  clearCmuxSidebar,
  detectCmuxEnvironment,
  emitOsc777Notification,
  initCmuxEventListeners,
  isCmuxCliAvailable,
  logCmuxEvent,
  markCmuxPromptShown,
  resetCmuxPromptState,
  resolveCmuxConfig,
  shellEscape,
  shouldPromptToEnableCmux,
  supportsOsc777Notifications,
  syncCmuxSidebar
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2NtdXgvaW5kZXgudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IGV4ZWNGaWxlU3luYywgc3Bhd24gfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgQ01VWF9DSEFOTkVMUywgdHlwZSBDbXV4U2lkZWJhckV2ZW50LCB0eXBlIENtdXhMb2dFdmVudCwgdHlwZSBDbXV4UHJlZmVyZW5jZXNJbnB1dCwgdHlwZSBDbXV4U3RhdGVJbnB1dCB9IGZyb20gXCIuLi9zaGFyZWQvY211eC1ldmVudHMuanNcIjtcbmltcG9ydCB0eXBlIHsgRXZlbnRCdXMgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcblxudHlwZSBDbXV4UHJlZmVyZW5jZXMgPSBDbXV4UHJlZmVyZW5jZXNJbnB1dDtcbnR5cGUgQ211eFN0YXRlID0gQ211eFN0YXRlSW5wdXQ7XG50eXBlIFBoYXNlID0gc3RyaW5nO1xuY29uc3QgREVGQVVMVF9TT0NLRVRfUEFUSCA9IFwiL3RtcC9jbXV4LnNvY2tcIjtcbmNvbnN0IFNUQVRVU19LRVkgPSBcImdzZFwiO1xuY29uc3QgbGFzdFNpZGViYXJTbmFwc2hvdHMgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xubGV0IGNtdXhQcm9tcHRlZFRoaXNTZXNzaW9uID0gZmFsc2U7XG5sZXQgY2FjaGVkQ2xpQXZhaWxhYmlsaXR5OiBib29sZWFuIHwgbnVsbCA9IG51bGw7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ211eEVudmlyb25tZW50IHtcbiAgYXZhaWxhYmxlOiBib29sZWFuO1xuICBjbGlBdmFpbGFibGU6IGJvb2xlYW47XG4gIHNvY2tldFBhdGg6IHN0cmluZztcbiAgd29ya3NwYWNlSWQ/OiBzdHJpbmc7XG4gIHN1cmZhY2VJZD86IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBSZXNvbHZlZENtdXhDb25maWcgZXh0ZW5kcyBDbXV4RW52aXJvbm1lbnQge1xuICBlbmFibGVkOiBib29sZWFuO1xuICBub3RpZmljYXRpb25zOiBib29sZWFuO1xuICBzaWRlYmFyOiBib29sZWFuO1xuICBzcGxpdHM6IGJvb2xlYW47XG4gIGJyb3dzZXI6IGJvb2xlYW47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ211eFNpZGViYXJQcm9ncmVzcyB7XG4gIHZhbHVlOiBudW1iZXI7XG4gIGxhYmVsOiBzdHJpbmc7XG59XG5cbmV4cG9ydCB0eXBlIENtdXhMb2dMZXZlbCA9IFwiaW5mb1wiIHwgXCJwcm9ncmVzc1wiIHwgXCJzdWNjZXNzXCIgfCBcIndhcm5pbmdcIiB8IFwiZXJyb3JcIjtcblxuZXhwb3J0IGZ1bmN0aW9uIGRldGVjdENtdXhFbnZpcm9ubWVudChcbiAgZW52OiBOb2RlSlMuUHJvY2Vzc0VudiA9IHByb2Nlc3MuZW52LFxuICBzb2NrZXRFeGlzdHM6IChwYXRoOiBzdHJpbmcpID0+IGJvb2xlYW4gPSBleGlzdHNTeW5jLFxuICBjbGlBdmFpbGFibGU6ICgpID0+IGJvb2xlYW4gPSBpc0NtdXhDbGlBdmFpbGFibGUsXG4pOiBDbXV4RW52aXJvbm1lbnQge1xuICBjb25zdCBzb2NrZXRQYXRoID0gZW52LkNNVVhfU09DS0VUX1BBVEggPz8gREVGQVVMVF9TT0NLRVRfUEFUSDtcbiAgY29uc3Qgd29ya3NwYWNlSWQgPSBlbnYuQ01VWF9XT1JLU1BBQ0VfSUQ/LnRyaW0oKSB8fCB1bmRlZmluZWQ7XG4gIGNvbnN0IHN1cmZhY2VJZCA9IGVudi5DTVVYX1NVUkZBQ0VfSUQ/LnRyaW0oKSB8fCB1bmRlZmluZWQ7XG4gIGNvbnN0IGF2YWlsYWJsZSA9IEJvb2xlYW4od29ya3NwYWNlSWQgJiYgc3VyZmFjZUlkICYmIHNvY2tldEV4aXN0cyhzb2NrZXRQYXRoKSk7XG4gIHJldHVybiB7XG4gICAgYXZhaWxhYmxlLFxuICAgIGNsaUF2YWlsYWJsZTogY2xpQXZhaWxhYmxlKCksXG4gICAgc29ja2V0UGF0aCxcbiAgICB3b3Jrc3BhY2VJZCxcbiAgICBzdXJmYWNlSWQsXG4gIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlQ211eENvbmZpZyhcbiAgcHJlZmVyZW5jZXM6IENtdXhQcmVmZXJlbmNlcyB8IHVuZGVmaW5lZCxcbiAgZW52OiBOb2RlSlMuUHJvY2Vzc0VudiA9IHByb2Nlc3MuZW52LFxuICBzb2NrZXRFeGlzdHM6IChwYXRoOiBzdHJpbmcpID0+IGJvb2xlYW4gPSBleGlzdHNTeW5jLFxuICBjbGlBdmFpbGFibGU6ICgpID0+IGJvb2xlYW4gPSBpc0NtdXhDbGlBdmFpbGFibGUsXG4pOiBSZXNvbHZlZENtdXhDb25maWcge1xuICBjb25zdCBkZXRlY3RlZCA9IGRldGVjdENtdXhFbnZpcm9ubWVudChlbnYsIHNvY2tldEV4aXN0cywgY2xpQXZhaWxhYmxlKTtcbiAgY29uc3QgY211eCA9IHByZWZlcmVuY2VzPy5jbXV4ID8/IHt9O1xuICBjb25zdCBlbmFibGVkID0gZGV0ZWN0ZWQuYXZhaWxhYmxlICYmIGNtdXguZW5hYmxlZCA9PT0gdHJ1ZTtcbiAgcmV0dXJuIHtcbiAgICAuLi5kZXRlY3RlZCxcbiAgICBlbmFibGVkLFxuICAgIG5vdGlmaWNhdGlvbnM6IGVuYWJsZWQgJiYgY211eC5ub3RpZmljYXRpb25zICE9PSBmYWxzZSxcbiAgICBzaWRlYmFyOiBlbmFibGVkICYmIGNtdXguc2lkZWJhciAhPT0gZmFsc2UsXG4gICAgc3BsaXRzOiBlbmFibGVkICYmIGNtdXguc3BsaXRzID09PSB0cnVlLFxuICAgIGJyb3dzZXI6IGVuYWJsZWQgJiYgY211eC5icm93c2VyID09PSB0cnVlLFxuICB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2hvdWxkUHJvbXB0VG9FbmFibGVDbXV4KFxuICBwcmVmZXJlbmNlczogQ211eFByZWZlcmVuY2VzIHwgdW5kZWZpbmVkLFxuICBlbnY6IE5vZGVKUy5Qcm9jZXNzRW52ID0gcHJvY2Vzcy5lbnYsXG4gIHNvY2tldEV4aXN0czogKHBhdGg6IHN0cmluZykgPT4gYm9vbGVhbiA9IGV4aXN0c1N5bmMsXG4gIGNsaUF2YWlsYWJsZTogKCkgPT4gYm9vbGVhbiA9IGlzQ211eENsaUF2YWlsYWJsZSxcbik6IGJvb2xlYW4ge1xuICBpZiAoY211eFByb21wdGVkVGhpc1Nlc3Npb24pIHJldHVybiBmYWxzZTtcbiAgY29uc3QgZGV0ZWN0ZWQgPSBkZXRlY3RDbXV4RW52aXJvbm1lbnQoZW52LCBzb2NrZXRFeGlzdHMsIGNsaUF2YWlsYWJsZSk7XG4gIGlmICghZGV0ZWN0ZWQuYXZhaWxhYmxlKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiBwcmVmZXJlbmNlcz8uY211eD8uZW5hYmxlZCA9PT0gdW5kZWZpbmVkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWFya0NtdXhQcm9tcHRTaG93bigpOiB2b2lkIHtcbiAgY211eFByb21wdGVkVGhpc1Nlc3Npb24gPSB0cnVlO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVzZXRDbXV4UHJvbXB0U3RhdGUoKTogdm9pZCB7XG4gIGNtdXhQcm9tcHRlZFRoaXNTZXNzaW9uID0gZmFsc2U7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0NtdXhDbGlBdmFpbGFibGUoKTogYm9vbGVhbiB7XG4gIGlmIChjYWNoZWRDbGlBdmFpbGFiaWxpdHkgIT09IG51bGwpIHJldHVybiBjYWNoZWRDbGlBdmFpbGFiaWxpdHk7XG4gIHRyeSB7XG4gICAgZXhlY0ZpbGVTeW5jKFwiY211eFwiLCBbXCItLWhlbHBcIl0sIHsgc3RkaW86IFwiaWdub3JlXCIsIHRpbWVvdXQ6IDEwMDAgfSk7XG4gICAgY2FjaGVkQ2xpQXZhaWxhYmlsaXR5ID0gdHJ1ZTtcbiAgfSBjYXRjaCB7XG4gICAgY2FjaGVkQ2xpQXZhaWxhYmlsaXR5ID0gZmFsc2U7XG4gIH1cbiAgcmV0dXJuIGNhY2hlZENsaUF2YWlsYWJpbGl0eTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHN1cHBvcnRzT3NjNzc3Tm90aWZpY2F0aW9ucyhlbnY6IE5vZGVKUy5Qcm9jZXNzRW52ID0gcHJvY2Vzcy5lbnYpOiBib29sZWFuIHtcbiAgY29uc3QgdGVybVByb2dyYW0gPSBlbnYuVEVSTV9QUk9HUkFNPy50b0xvd2VyQ2FzZSgpID8/IFwiXCI7XG4gIHJldHVybiB0ZXJtUHJvZ3JhbSA9PT0gXCJnaG9zdHR5XCIgfHwgdGVybVByb2dyYW0gPT09IFwid2V6dGVybVwiIHx8IHRlcm1Qcm9ncmFtID09PSBcIml0ZXJtLmFwcFwiO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZW1pdE9zYzc3N05vdGlmaWNhdGlvbih0aXRsZTogc3RyaW5nLCBib2R5OiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKCFzdXBwb3J0c09zYzc3N05vdGlmaWNhdGlvbnMoKSkgcmV0dXJuO1xuICBjb25zdCBzYWZlVGl0bGUgPSBub3JtYWxpemVOb3RpZmljYXRpb25UZXh0KHRpdGxlKS5yZXBsYWNlKC87L2csIFwiLFwiKTtcbiAgY29uc3Qgc2FmZUJvZHkgPSBub3JtYWxpemVOb3RpZmljYXRpb25UZXh0KGJvZHkpLnJlcGxhY2UoLzsvZywgXCIsXCIpO1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgXFx4MWJdNzc3O25vdGlmeTske3NhZmVUaXRsZX07JHtzYWZlQm9keX1cXHgwN2ApO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRDbXV4U3RhdHVzTGFiZWwoc3RhdGU6IENtdXhTdGF0ZSk6IHN0cmluZyB7XG4gIGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuICBpZiAoc3RhdGUuYWN0aXZlTWlsZXN0b25lKSBwYXJ0cy5wdXNoKHN0YXRlLmFjdGl2ZU1pbGVzdG9uZS5pZCk7XG4gIGlmIChzdGF0ZS5hY3RpdmVTbGljZSkgcGFydHMucHVzaChzdGF0ZS5hY3RpdmVTbGljZS5pZCk7XG4gIGlmIChzdGF0ZS5hY3RpdmVUYXNrKSB7XG4gICAgY29uc3QgcHJldiA9IHBhcnRzLnBvcCgpO1xuICAgIHBhcnRzLnB1c2gocHJldiA/IGAke3ByZXZ9LyR7c3RhdGUuYWN0aXZlVGFzay5pZH1gIDogc3RhdGUuYWN0aXZlVGFzay5pZCk7XG4gIH1cbiAgaWYgKHBhcnRzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHN0YXRlLnBoYXNlO1xuICByZXR1cm4gYCR7cGFydHMuam9pbihcIiBcIil9IFx1MDBCNyAke3N0YXRlLnBoYXNlfWA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBidWlsZENtdXhQcm9ncmVzcyhzdGF0ZTogQ211eFN0YXRlKTogQ211eFNpZGViYXJQcm9ncmVzcyB8IG51bGwge1xuICBjb25zdCBwcm9ncmVzcyA9IHN0YXRlLnByb2dyZXNzO1xuICBpZiAoIXByb2dyZXNzKSByZXR1cm4gbnVsbDtcblxuICBjb25zdCBjaG9vc2UgPSAoZG9uZTogbnVtYmVyLCB0b3RhbDogbnVtYmVyLCBsYWJlbDogc3RyaW5nKTogQ211eFNpZGViYXJQcm9ncmVzcyB8IG51bGwgPT4ge1xuICAgIGlmICh0b3RhbCA8PSAwKSByZXR1cm4gbnVsbDtcbiAgICByZXR1cm4geyB2YWx1ZTogTWF0aC5tYXgoMCwgTWF0aC5taW4oMSwgZG9uZSAvIHRvdGFsKSksIGxhYmVsOiBgJHtkb25lfS8ke3RvdGFsfSAke2xhYmVsfWAgfTtcbiAgfTtcblxuICByZXR1cm4gY2hvb3NlKHByb2dyZXNzLnRhc2tzPy5kb25lID8/IDAsIHByb2dyZXNzLnRhc2tzPy50b3RhbCA/PyAwLCBcInRhc2tzXCIpXG4gICAgPz8gY2hvb3NlKHByb2dyZXNzLnNsaWNlcz8uZG9uZSA/PyAwLCBwcm9ncmVzcy5zbGljZXM/LnRvdGFsID8/IDAsIFwic2xpY2VzXCIpXG4gICAgPz8gY2hvb3NlKHByb2dyZXNzLm1pbGVzdG9uZXMuZG9uZSwgcHJvZ3Jlc3MubWlsZXN0b25lcy50b3RhbCwgXCJtaWxlc3RvbmVzXCIpO1xufVxuXG5mdW5jdGlvbiBwaGFzZVZpc3VhbHMocGhhc2U6IFBoYXNlKTogeyBpY29uOiBzdHJpbmc7IGNvbG9yOiBzdHJpbmcgfSB7XG4gIHN3aXRjaCAocGhhc2UpIHtcbiAgICBjYXNlIFwiYmxvY2tlZFwiOlxuICAgICAgcmV0dXJuIHsgaWNvbjogXCJ0cmlhbmdsZS1hbGVydFwiLCBjb2xvcjogXCIjZWY0NDQ0XCIgfTtcbiAgICBjYXNlIFwicGF1c2VkXCI6XG4gICAgICByZXR1cm4geyBpY29uOiBcInBhdXNlXCIsIGNvbG9yOiBcIiNmNTllMGJcIiB9O1xuICAgIGNhc2UgXCJjb21wbGV0ZVwiOlxuICAgIGNhc2UgXCJjb21wbGV0aW5nLW1pbGVzdG9uZVwiOlxuICAgICAgcmV0dXJuIHsgaWNvbjogXCJjaGVja1wiLCBjb2xvcjogXCIjMjJjNTVlXCIgfTtcbiAgICBjYXNlIFwicGxhbm5pbmdcIjpcbiAgICBjYXNlIFwicmVzZWFyY2hpbmdcIjpcbiAgICBjYXNlIFwicmVwbGFubmluZy1zbGljZVwiOlxuICAgICAgcmV0dXJuIHsgaWNvbjogXCJjb21wYXNzXCIsIGNvbG9yOiBcIiMzYjgyZjZcIiB9O1xuICAgIGNhc2UgXCJ2YWxpZGF0aW5nLW1pbGVzdG9uZVwiOlxuICAgIGNhc2UgXCJ2ZXJpZnlpbmdcIjpcbiAgICAgIHJldHVybiB7IGljb246IFwic2hpZWxkLWNoZWNrXCIsIGNvbG9yOiBcIiMwNmI2ZDRcIiB9O1xuICAgIGRlZmF1bHQ6XG4gICAgICByZXR1cm4geyBpY29uOiBcInJvY2tldFwiLCBjb2xvcjogXCIjNGFkZTgwXCIgfTtcbiAgfVxufVxuXG5mdW5jdGlvbiBzaWRlYmFyU25hcHNob3RLZXkoY29uZmlnOiBSZXNvbHZlZENtdXhDb25maWcpOiBzdHJpbmcge1xuICByZXR1cm4gY29uZmlnLndvcmtzcGFjZUlkID8/IFwiZGVmYXVsdFwiO1xufVxuXG5leHBvcnQgY2xhc3MgQ211eENsaWVudCB7XG4gIHByaXZhdGUgcmVhZG9ubHkgY29uZmlnOiBSZXNvbHZlZENtdXhDb25maWc7XG5cbiAgY29uc3RydWN0b3IoY29uZmlnOiBSZXNvbHZlZENtdXhDb25maWcpIHtcbiAgICB0aGlzLmNvbmZpZyA9IGNvbmZpZztcbiAgfVxuXG4gIHN0YXRpYyBmcm9tUHJlZmVyZW5jZXMocHJlZmVyZW5jZXM6IENtdXhQcmVmZXJlbmNlcyB8IHVuZGVmaW5lZCk6IENtdXhDbGllbnQge1xuICAgIHJldHVybiBuZXcgQ211eENsaWVudChyZXNvbHZlQ211eENvbmZpZyhwcmVmZXJlbmNlcykpO1xuICB9XG5cbiAgZ2V0Q29uZmlnKCk6IFJlc29sdmVkQ211eENvbmZpZyB7XG4gICAgcmV0dXJuIHRoaXMuY29uZmlnO1xuICB9XG5cbiAgcHJpdmF0ZSBjYW5SdW4oKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMuY29uZmlnLmF2YWlsYWJsZSAmJiB0aGlzLmNvbmZpZy5jbGlBdmFpbGFibGU7XG4gIH1cblxuICBwcml2YXRlIGFwcGVuZFdvcmtzcGFjZShhcmdzOiBzdHJpbmdbXSk6IHN0cmluZ1tdIHtcbiAgICByZXR1cm4gdGhpcy5jb25maWcud29ya3NwYWNlSWQgPyBbLi4uYXJncywgXCItLXdvcmtzcGFjZVwiLCB0aGlzLmNvbmZpZy53b3Jrc3BhY2VJZF0gOiBhcmdzO1xuICB9XG5cbiAgcHJpdmF0ZSBhcHBlbmRTdXJmYWNlKGFyZ3M6IHN0cmluZ1tdLCBzdXJmYWNlSWQ/OiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gICAgcmV0dXJuIHN1cmZhY2VJZCA/IFsuLi5hcmdzLCBcIi0tc3VyZmFjZVwiLCBzdXJmYWNlSWRdIDogYXJncztcbiAgfVxuXG4gIHByaXZhdGUgcnVuU3luYyhhcmdzOiBzdHJpbmdbXSk6IHN0cmluZyB8IG51bGwge1xuICAgIGlmICghdGhpcy5jYW5SdW4oKSkgcmV0dXJuIG51bGw7XG4gICAgdHJ5IHtcbiAgICAgIHJldHVybiBleGVjRmlsZVN5bmMoXCJjbXV4XCIsIGFyZ3MsIHtcbiAgICAgICAgZW5jb2Rpbmc6IFwidXRmLThcIixcbiAgICAgICAgdGltZW91dDogMzAwMCxcbiAgICAgICAgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdLFxuICAgICAgICBlbnY6IHByb2Nlc3MuZW52LFxuICAgICAgfSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHJ1bkFzeW5jKGFyZ3M6IHN0cmluZ1tdKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG4gICAgaWYgKCF0aGlzLmNhblJ1bigpKSByZXR1cm4gbnVsbDtcbiAgICByZXR1cm4gbmV3IFByb21pc2U8c3RyaW5nIHwgbnVsbD4oKHJlc29sdmUpID0+IHtcbiAgICAgIGNvbnN0IGNoaWxkID0gc3Bhd24oXCJjbXV4XCIsIGFyZ3MsIHtcbiAgICAgICAgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdLFxuICAgICAgICBlbnY6IHByb2Nlc3MuZW52LFxuICAgICAgfSk7XG4gICAgICBjb25zdCBjaHVua3M6IEJ1ZmZlcltdID0gW107XG4gICAgICBsZXQgc2V0dGxlZCA9IGZhbHNlO1xuICAgICAgY29uc3QgZG9uZSA9IChyZXN1bHQ6IHN0cmluZyB8IG51bGwpID0+IHtcbiAgICAgICAgaWYgKCFzZXR0bGVkKSB7IHNldHRsZWQgPSB0cnVlOyByZXNvbHZlKHJlc3VsdCk7IH1cbiAgICAgIH07XG4gICAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4geyBjaGlsZC5raWxsKCk7IGRvbmUobnVsbCk7IH0sIDUwMDApO1xuICAgICAgY2hpbGQuc3Rkb3V0IS5vbihcImRhdGFcIiwgKGNodW5rOiBCdWZmZXIpID0+IGNodW5rcy5wdXNoKGNodW5rKSk7XG4gICAgICBjaGlsZC5vbihcImNsb3NlXCIsIChjb2RlKSA9PiB7XG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgIGRvbmUoY29kZSA9PT0gMCA/IEJ1ZmZlci5jb25jYXQoY2h1bmtzKS50b1N0cmluZyhcInV0Zi04XCIpIDogbnVsbCk7XG4gICAgICB9KTtcbiAgICAgIGNoaWxkLm9uKFwiZXJyb3JcIiwgKCkgPT4geyBjbGVhclRpbWVvdXQodGltZXIpOyBkb25lKG51bGwpOyB9KTtcbiAgICB9KTtcbiAgfVxuXG4gIGdldENhcGFiaWxpdGllcygpOiB1bmtub3duIHwgbnVsbCB7XG4gICAgY29uc3Qgc3Rkb3V0ID0gdGhpcy5ydW5TeW5jKFtcImNhcGFiaWxpdGllc1wiLCBcIi0tanNvblwiXSk7XG4gICAgcmV0dXJuIHN0ZG91dCA/IHBhcnNlSnNvbihzdGRvdXQpIDogbnVsbDtcbiAgfVxuXG4gIGlkZW50aWZ5KCk6IHVua25vd24gfCBudWxsIHtcbiAgICBjb25zdCBzdGRvdXQgPSB0aGlzLnJ1blN5bmMoW1wiaWRlbnRpZnlcIiwgXCItLWpzb25cIl0pO1xuICAgIHJldHVybiBzdGRvdXQgPyBwYXJzZUpzb24oc3Rkb3V0KSA6IG51bGw7XG4gIH1cblxuICBzZXRTdGF0dXMobGFiZWw6IHN0cmluZywgcGhhc2U6IFBoYXNlKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmNvbmZpZy5zaWRlYmFyKSByZXR1cm47XG4gICAgY29uc3QgdmlzdWFscyA9IHBoYXNlVmlzdWFscyhwaGFzZSk7XG4gICAgdGhpcy5ydW5TeW5jKHRoaXMuYXBwZW5kV29ya3NwYWNlKFtcbiAgICAgIFwic2V0LXN0YXR1c1wiLFxuICAgICAgU1RBVFVTX0tFWSxcbiAgICAgIGxhYmVsLFxuICAgICAgXCItLWljb25cIixcbiAgICAgIHZpc3VhbHMuaWNvbixcbiAgICAgIFwiLS1jb2xvclwiLFxuICAgICAgdmlzdWFscy5jb2xvcixcbiAgICBdKSk7XG4gIH1cblxuICBjbGVhclN0YXR1cygpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuY29uZmlnLnNpZGViYXIpIHJldHVybjtcbiAgICB0aGlzLnJ1blN5bmModGhpcy5hcHBlbmRXb3Jrc3BhY2UoW1wiY2xlYXItc3RhdHVzXCIsIFNUQVRVU19LRVldKSk7XG4gIH1cblxuICBzZXRQcm9ncmVzcyhwcm9ncmVzczogQ211eFNpZGViYXJQcm9ncmVzcyB8IG51bGwpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuY29uZmlnLnNpZGViYXIpIHJldHVybjtcbiAgICBpZiAoIXByb2dyZXNzKSB7XG4gICAgICB0aGlzLnJ1blN5bmModGhpcy5hcHBlbmRXb3Jrc3BhY2UoW1wiY2xlYXItcHJvZ3Jlc3NcIl0pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdGhpcy5ydW5TeW5jKHRoaXMuYXBwZW5kV29ya3NwYWNlKFtcbiAgICAgIFwic2V0LXByb2dyZXNzXCIsXG4gICAgICBwcm9ncmVzcy52YWx1ZS50b0ZpeGVkKDMpLFxuICAgICAgXCItLWxhYmVsXCIsXG4gICAgICBwcm9ncmVzcy5sYWJlbCxcbiAgICBdKSk7XG4gIH1cblxuICBsb2cobWVzc2FnZTogc3RyaW5nLCBsZXZlbDogQ211eExvZ0xldmVsID0gXCJpbmZvXCIsIHNvdXJjZSA9IFwiZ3NkXCIpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuY29uZmlnLnNpZGViYXIpIHJldHVybjtcbiAgICB0aGlzLnJ1blN5bmModGhpcy5hcHBlbmRXb3Jrc3BhY2UoW1xuICAgICAgXCJsb2dcIixcbiAgICAgIFwiLS1sZXZlbFwiLFxuICAgICAgbGV2ZWwsXG4gICAgICBcIi0tc291cmNlXCIsXG4gICAgICBzb3VyY2UsXG4gICAgICBcIi0tXCIsXG4gICAgICBtZXNzYWdlLFxuICAgIF0pKTtcbiAgfVxuXG4gIG5vdGlmeSh0aXRsZTogc3RyaW5nLCBib2R5OiBzdHJpbmcsIHN1YnRpdGxlPzogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgaWYgKCF0aGlzLmNvbmZpZy5ub3RpZmljYXRpb25zKSByZXR1cm4gZmFsc2U7XG4gICAgY29uc3QgYXJncyA9IFtcIm5vdGlmeVwiLCBcIi0tdGl0bGVcIiwgdGl0bGUsIFwiLS1ib2R5XCIsIGJvZHldO1xuICAgIGlmIChzdWJ0aXRsZSkgYXJncy5wdXNoKFwiLS1zdWJ0aXRsZVwiLCBzdWJ0aXRsZSk7XG4gICAgcmV0dXJuIHRoaXMucnVuU3luYyhhcmdzKSAhPT0gbnVsbDtcbiAgfVxuXG4gIGFzeW5jIGxpc3RTdXJmYWNlSWRzKCk6IFByb21pc2U8c3RyaW5nW10+IHtcbiAgICBjb25zdCBzdGRvdXQgPSBhd2FpdCB0aGlzLnJ1bkFzeW5jKHRoaXMuYXBwZW5kV29ya3NwYWNlKFtcImxpc3Qtc3VyZmFjZXNcIiwgXCItLWpzb25cIiwgXCItLWlkLWZvcm1hdFwiLCBcImJvdGhcIl0pKTtcbiAgICBjb25zdCBwYXJzZWQgPSBzdGRvdXQgPyBwYXJzZUpzb24oc3Rkb3V0KSA6IG51bGw7XG4gICAgcmV0dXJuIGV4dHJhY3RTdXJmYWNlSWRzKHBhcnNlZCk7XG4gIH1cblxuICBhc3luYyBjcmVhdGVTcGxpdChkaXJlY3Rpb246IFwicmlnaHRcIiB8IFwiZG93blwiIHwgXCJsZWZ0XCIgfCBcInVwXCIpOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgICByZXR1cm4gdGhpcy5jcmVhdGVTcGxpdEZyb20odGhpcy5jb25maWcuc3VyZmFjZUlkLCBkaXJlY3Rpb24pO1xuICB9XG5cbiAgYXN5bmMgY3JlYXRlU3BsaXRGcm9tKFxuICAgIHNvdXJjZVN1cmZhY2VJZDogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICAgIGRpcmVjdGlvbjogXCJyaWdodFwiIHwgXCJkb3duXCIgfCBcImxlZnRcIiB8IFwidXBcIixcbiAgKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG4gICAgaWYgKCF0aGlzLmNvbmZpZy5zcGxpdHMpIHJldHVybiBudWxsO1xuICAgIGNvbnN0IGJlZm9yZSA9IG5ldyBTZXQoYXdhaXQgdGhpcy5saXN0U3VyZmFjZUlkcygpKTtcbiAgICBjb25zdCBhcmdzID0gW1wibmV3LXNwbGl0XCIsIGRpcmVjdGlvbl07XG4gICAgY29uc3Qgc2NvcGVkQXJncyA9IHRoaXMuYXBwZW5kU3VyZmFjZSh0aGlzLmFwcGVuZFdvcmtzcGFjZShhcmdzKSwgc291cmNlU3VyZmFjZUlkKTtcbiAgICBhd2FpdCB0aGlzLnJ1bkFzeW5jKHNjb3BlZEFyZ3MpO1xuICAgIGNvbnN0IGFmdGVyID0gYXdhaXQgdGhpcy5saXN0U3VyZmFjZUlkcygpO1xuICAgIGZvciAoY29uc3QgaWQgb2YgYWZ0ZXIpIHtcbiAgICAgIGlmICghYmVmb3JlLmhhcyhpZCkpIHJldHVybiBpZDtcbiAgICB9XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cblxuICAvKipcbiAgICogQ3JlYXRlIGEgZ3JpZCBvZiBzdXJmYWNlcyBmb3IgcGFyYWxsZWwgYWdlbnQgZXhlY3V0aW9uLlxuICAgKlxuICAgKiBMYXlvdXQgc3RyYXRlZ3kgKGdzZCBzdGF5cyBpbiB0aGUgb3JpZ2luYWwgc3VyZmFjZSk6XG4gICAqICAgMSBhZ2VudDogIFtnc2QgfCBBXVxuICAgKiAgIDIgYWdlbnRzOiBbZ3NkIHwgQV1cbiAgICogICAgICAgICAgICAgWyAgICB8IEJdXG4gICAqICAgMyBhZ2VudHM6IFtnc2QgfCBBXVxuICAgKiAgICAgICAgICAgICBbIEMgIHwgQl1cbiAgICogICA0IGFnZW50czogW2dzZCB8IEFdXG4gICAqICAgICAgICAgICAgIFsgQyAgfCBCXSAgKEQgc3BsaXRzIGZyb20gQiBkb3dud2FyZClcbiAgICogICAgICAgICAgICAgWyAgICB8IERdXG4gICAqXG4gICAqIFJldHVybnMgc3VyZmFjZSBJRHMgaW4gb3JkZXIsIG9yIGVtcHR5IGFycmF5IG9uIGZhaWx1cmUuXG4gICAqL1xuICBhc3luYyBjcmVhdGVHcmlkTGF5b3V0KGNvdW50OiBudW1iZXIpOiBQcm9taXNlPHN0cmluZ1tdPiB7XG4gICAgaWYgKCF0aGlzLmNvbmZpZy5zcGxpdHMgfHwgY291bnQgPD0gMCkgcmV0dXJuIFtdO1xuICAgIGNvbnN0IHN1cmZhY2VzOiBzdHJpbmdbXSA9IFtdO1xuXG4gICAgLy8gRmlyc3Qgc3BsaXQ6IGNyZWF0ZSByaWdodCBjb2x1bW4gZnJvbSB0aGUgZ3NkIHN1cmZhY2VcbiAgICBjb25zdCByaWdodENvbCA9IGF3YWl0IHRoaXMuY3JlYXRlU3BsaXRGcm9tKHRoaXMuY29uZmlnLnN1cmZhY2VJZCwgXCJyaWdodFwiKTtcbiAgICBpZiAoIXJpZ2h0Q29sKSByZXR1cm4gW107XG4gICAgc3VyZmFjZXMucHVzaChyaWdodENvbCk7XG4gICAgaWYgKGNvdW50ID09PSAxKSByZXR1cm4gc3VyZmFjZXM7XG5cbiAgICAvLyBTZWNvbmQgc3BsaXQ6IHNwbGl0IHJpZ2h0IGNvbHVtbiBkb3duIFx1MjE5MiBib3R0b20tcmlnaHRcbiAgICBjb25zdCBib3R0b21SaWdodCA9IGF3YWl0IHRoaXMuY3JlYXRlU3BsaXRGcm9tKHJpZ2h0Q29sLCBcImRvd25cIik7XG4gICAgaWYgKCFib3R0b21SaWdodCkgcmV0dXJuIHN1cmZhY2VzO1xuICAgIHN1cmZhY2VzLnB1c2goYm90dG9tUmlnaHQpO1xuICAgIGlmIChjb3VudCA9PT0gMikgcmV0dXJuIHN1cmZhY2VzO1xuXG4gICAgLy8gVGhpcmQgc3BsaXQ6IHNwbGl0IGdzZCBzdXJmYWNlIGRvd24gXHUyMTkyIGJvdHRvbS1sZWZ0XG4gICAgY29uc3QgYm90dG9tTGVmdCA9IGF3YWl0IHRoaXMuY3JlYXRlU3BsaXRGcm9tKHRoaXMuY29uZmlnLnN1cmZhY2VJZCwgXCJkb3duXCIpO1xuICAgIGlmICghYm90dG9tTGVmdCkgcmV0dXJuIHN1cmZhY2VzO1xuICAgIHN1cmZhY2VzLnB1c2goYm90dG9tTGVmdCk7XG4gICAgaWYgKGNvdW50ID09PSAzKSByZXR1cm4gc3VyZmFjZXM7XG5cbiAgICAvLyBGb3VydGgrOiBzcGxpdCBzdWJzZXF1ZW50IHN1cmZhY2VzIGRvd24gZnJvbSB0aGUgbGFzdCBjcmVhdGVkXG4gICAgbGV0IGxhc3RTdXJmYWNlID0gYm90dG9tUmlnaHQ7XG4gICAgZm9yIChsZXQgaSA9IDM7IGkgPCBjb3VudDsgaSsrKSB7XG4gICAgICBjb25zdCBuZXh0ID0gYXdhaXQgdGhpcy5jcmVhdGVTcGxpdEZyb20obGFzdFN1cmZhY2UsIFwiZG93blwiKTtcbiAgICAgIGlmICghbmV4dCkgYnJlYWs7XG4gICAgICBzdXJmYWNlcy5wdXNoKG5leHQpO1xuICAgICAgbGFzdFN1cmZhY2UgPSBuZXh0O1xuICAgIH1cblxuICAgIHJldHVybiBzdXJmYWNlcztcbiAgfVxuXG4gIGFzeW5jIHNlbmRTdXJmYWNlKHN1cmZhY2VJZDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgICBjb25zdCBwYXlsb2FkID0gdGV4dC5lbmRzV2l0aChcIlxcblwiKSA/IHRleHQgOiBgJHt0ZXh0fVxcbmA7XG4gICAgY29uc3Qgc3Rkb3V0ID0gYXdhaXQgdGhpcy5ydW5Bc3luYyhbXCJzZW5kLXN1cmZhY2VcIiwgXCItLXN1cmZhY2VcIiwgc3VyZmFjZUlkLCBwYXlsb2FkXSk7XG4gICAgcmV0dXJuIHN0ZG91dCAhPT0gbnVsbDtcbiAgfVxuXG4gIC8vIFNlbmQgQ3RybC1DIChFVFgpIHRvIGEgc3VyZmFjZSB0byBpbnRlcnJ1cHQgdGhlIHJ1bm5pbmcgY29tbWFuZC5cbiAgYXN5bmMgc2VuZEludGVycnVwdChzdXJmYWNlSWQ6IHN0cmluZyk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICAgIGNvbnN0IHN0ZG91dCA9IGF3YWl0IHRoaXMucnVuQXN5bmMoW1wic2VuZC1zdXJmYWNlXCIsIFwiLS1zdXJmYWNlXCIsIHN1cmZhY2VJZCwgXCJcXHgwM1wiXSk7XG4gICAgcmV0dXJuIHN0ZG91dCAhPT0gbnVsbDtcbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gc3luY0NtdXhTaWRlYmFyKHByZWZlcmVuY2VzOiBDbXV4UHJlZmVyZW5jZXMgfCB1bmRlZmluZWQsIHN0YXRlOiBDbXV4U3RhdGUpOiB2b2lkIHtcbiAgY29uc3QgY2xpZW50ID0gQ211eENsaWVudC5mcm9tUHJlZmVyZW5jZXMocHJlZmVyZW5jZXMpO1xuICBjb25zdCBjb25maWcgPSBjbGllbnQuZ2V0Q29uZmlnKCk7XG4gIGlmICghY29uZmlnLnNpZGViYXIpIHJldHVybjtcblxuICBjb25zdCBsYWJlbCA9IGJ1aWxkQ211eFN0YXR1c0xhYmVsKHN0YXRlKTtcbiAgY29uc3QgcHJvZ3Jlc3MgPSBidWlsZENtdXhQcm9ncmVzcyhzdGF0ZSk7XG4gIGNvbnN0IHNuYXBzaG90ID0gSlNPTi5zdHJpbmdpZnkoeyBsYWJlbCwgcHJvZ3Jlc3MsIHBoYXNlOiBzdGF0ZS5waGFzZSB9KTtcbiAgY29uc3Qga2V5ID0gc2lkZWJhclNuYXBzaG90S2V5KGNvbmZpZyk7XG4gIGlmIChsYXN0U2lkZWJhclNuYXBzaG90cy5nZXQoa2V5KSA9PT0gc25hcHNob3QpIHJldHVybjtcblxuICBjbGllbnQuc2V0U3RhdHVzKGxhYmVsLCBzdGF0ZS5waGFzZSk7XG4gIGNsaWVudC5zZXRQcm9ncmVzcyhwcm9ncmVzcyk7XG4gIGxhc3RTaWRlYmFyU25hcHNob3RzLnNldChrZXksIHNuYXBzaG90KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNsZWFyQ211eFNpZGViYXIocHJlZmVyZW5jZXM6IENtdXhQcmVmZXJlbmNlcyB8IHVuZGVmaW5lZCk6IHZvaWQge1xuICBjb25zdCBjb25maWcgPSByZXNvbHZlQ211eENvbmZpZyhwcmVmZXJlbmNlcyk7XG4gIGlmICghY29uZmlnLmF2YWlsYWJsZSB8fCAhY29uZmlnLmNsaUF2YWlsYWJsZSkgcmV0dXJuO1xuICBjb25zdCBjbGllbnQgPSBuZXcgQ211eENsaWVudCh7IC4uLmNvbmZpZywgZW5hYmxlZDogdHJ1ZSwgc2lkZWJhcjogdHJ1ZSB9KTtcbiAgY29uc3Qga2V5ID0gc2lkZWJhclNuYXBzaG90S2V5KGNvbmZpZyk7XG4gIGNsaWVudC5jbGVhclN0YXR1cygpO1xuICBjbGllbnQuc2V0UHJvZ3Jlc3MobnVsbCk7XG4gIGxhc3RTaWRlYmFyU25hcHNob3RzLmRlbGV0ZShrZXkpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbG9nQ211eEV2ZW50KFxuICBwcmVmZXJlbmNlczogQ211eFByZWZlcmVuY2VzIHwgdW5kZWZpbmVkLFxuICBtZXNzYWdlOiBzdHJpbmcsXG4gIGxldmVsOiBDbXV4TG9nTGV2ZWwgPSBcImluZm9cIixcbik6IHZvaWQge1xuICBDbXV4Q2xpZW50LmZyb21QcmVmZXJlbmNlcyhwcmVmZXJlbmNlcykubG9nKG1lc3NhZ2UsIGxldmVsKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNoZWxsRXNjYXBlKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gYCcke3ZhbHVlLnJlcGxhY2UoLycvZywgYCdcXFxcJydgKX0nYDtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplTm90aWZpY2F0aW9uVGV4dCh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHZhbHVlLnJlcGxhY2UoL1xccj9cXG4vZywgXCIgXCIpLnRyaW0oKTtcbn1cblxuZnVuY3Rpb24gcGFyc2VKc29uKHRleHQ6IHN0cmluZyk6IHVua25vd24ge1xuICB0cnkge1xuICAgIHJldHVybiBKU09OLnBhcnNlKHRleHQpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5mdW5jdGlvbiBleHRyYWN0U3VyZmFjZUlkcyh2YWx1ZTogdW5rbm93bik6IHN0cmluZ1tdIHtcbiAgY29uc3QgZm91bmQgPSBuZXcgU2V0PHN0cmluZz4oKTtcblxuICBjb25zdCB2aXNpdCA9IChub2RlOiB1bmtub3duKTogdm9pZCA9PiB7XG4gICAgaWYgKEFycmF5LmlzQXJyYXkobm9kZSkpIHtcbiAgICAgIGZvciAoY29uc3QgaXRlbSBvZiBub2RlKSB2aXNpdChpdGVtKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKCFub2RlIHx8IHR5cGVvZiBub2RlICE9PSBcIm9iamVjdFwiKSByZXR1cm47XG5cbiAgICBmb3IgKGNvbnN0IFtrZXksIGNoaWxkXSBvZiBPYmplY3QuZW50cmllcyhub2RlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSkge1xuICAgICAgaWYgKFxuICAgICAgICB0eXBlb2YgY2hpbGQgPT09IFwic3RyaW5nXCJcbiAgICAgICAgJiYgKGtleSA9PT0gXCJzdXJmYWNlX2lkXCIgfHwga2V5ID09PSBcInN1cmZhY2VcIiB8fCAoa2V5ID09PSBcImlkXCIgJiYgY2hpbGQuaW5jbHVkZXMoXCJzdXJmYWNlXCIpKSlcbiAgICAgICkge1xuICAgICAgICBmb3VuZC5hZGQoY2hpbGQpO1xuICAgICAgfVxuICAgICAgdmlzaXQoY2hpbGQpO1xuICAgIH1cbiAgfTtcblxuICB2aXNpdCh2YWx1ZSk7XG4gIHJldHVybiBBcnJheS5mcm9tKGZvdW5kKTtcbn1cblxuLyoqXG4gKiBXaXJlIGV2ZW50IHN1YnNjcmlwdGlvbnMgc28gY211eCByZWFjdHMgdG8gZ3NkIGV2ZW50cy5cbiAqIENhbGxlZCBieSB0aGUgZ3NkIGV4dGVuc2lvbiBkdXJpbmcgcmVnaXN0cmF0aW9uLCBwYXNzaW5nIHBpLmV2ZW50cy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGluaXRDbXV4RXZlbnRMaXN0ZW5lcnMoZXZlbnRzOiBFdmVudEJ1cyk6IHZvaWQge1xuICBldmVudHMub24oQ01VWF9DSEFOTkVMUy5TSURFQkFSLCAoZGF0YSkgPT4ge1xuICAgIGNvbnN0IGV2ZW50ID0gZGF0YSBhcyBDbXV4U2lkZWJhckV2ZW50O1xuICAgIGlmIChldmVudC5hY3Rpb24gPT09IFwic3luY1wiICYmIGV2ZW50LnN0YXRlKSB7XG4gICAgICBzeW5jQ211eFNpZGViYXIoZXZlbnQucHJlZmVyZW5jZXMgYXMgQ211eFByZWZlcmVuY2VzIHwgdW5kZWZpbmVkLCBldmVudC5zdGF0ZSBhcyBDbXV4U3RhdGUpO1xuICAgIH1cbiAgICBpZiAoZXZlbnQuYWN0aW9uID09PSBcImNsZWFyXCIpIHtcbiAgICAgIGNsZWFyQ211eFNpZGViYXIoZXZlbnQucHJlZmVyZW5jZXMgYXMgQ211eFByZWZlcmVuY2VzIHwgdW5kZWZpbmVkKTtcbiAgICB9XG4gIH0pO1xuXG4gIGV2ZW50cy5vbihDTVVYX0NIQU5ORUxTLkxPRywgKGRhdGEpID0+IHtcbiAgICBjb25zdCBldmVudCA9IGRhdGEgYXMgQ211eExvZ0V2ZW50O1xuICAgIGxvZ0NtdXhFdmVudChldmVudC5wcmVmZXJlbmNlcyBhcyBDbXV4UHJlZmVyZW5jZXMgfCB1bmRlZmluZWQsIGV2ZW50Lm1lc3NhZ2UsIGV2ZW50LmxldmVsKTtcbiAgfSk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxTQUFTLGNBQWMsYUFBYTtBQUNwQyxTQUFTLGtCQUFrQjtBQUczQixTQUFTLHFCQUErRztBQU14SCxNQUFNLHNCQUFzQjtBQUM1QixNQUFNLGFBQWE7QUFDbkIsTUFBTSx1QkFBdUIsb0JBQUksSUFBb0I7QUFDckQsSUFBSSwwQkFBMEI7QUFDOUIsSUFBSSx3QkFBd0M7QUF5QnJDLFNBQVMsc0JBQ2QsTUFBeUIsUUFBUSxLQUNqQyxlQUEwQyxZQUMxQyxlQUE4QixvQkFDYjtBQUNqQixRQUFNLGFBQWEsSUFBSSxvQkFBb0I7QUFDM0MsUUFBTSxjQUFjLElBQUksbUJBQW1CLEtBQUssS0FBSztBQUNyRCxRQUFNLFlBQVksSUFBSSxpQkFBaUIsS0FBSyxLQUFLO0FBQ2pELFFBQU0sWUFBWSxRQUFRLGVBQWUsYUFBYSxhQUFhLFVBQVUsQ0FBQztBQUM5RSxTQUFPO0FBQUEsSUFDTDtBQUFBLElBQ0EsY0FBYyxhQUFhO0FBQUEsSUFDM0I7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLEVBQ0Y7QUFDRjtBQUVPLFNBQVMsa0JBQ2QsYUFDQSxNQUF5QixRQUFRLEtBQ2pDLGVBQTBDLFlBQzFDLGVBQThCLG9CQUNWO0FBQ3BCLFFBQU0sV0FBVyxzQkFBc0IsS0FBSyxjQUFjLFlBQVk7QUFDdEUsUUFBTSxPQUFPLGFBQWEsUUFBUSxDQUFDO0FBQ25DLFFBQU0sVUFBVSxTQUFTLGFBQWEsS0FBSyxZQUFZO0FBQ3ZELFNBQU87QUFBQSxJQUNMLEdBQUc7QUFBQSxJQUNIO0FBQUEsSUFDQSxlQUFlLFdBQVcsS0FBSyxrQkFBa0I7QUFBQSxJQUNqRCxTQUFTLFdBQVcsS0FBSyxZQUFZO0FBQUEsSUFDckMsUUFBUSxXQUFXLEtBQUssV0FBVztBQUFBLElBQ25DLFNBQVMsV0FBVyxLQUFLLFlBQVk7QUFBQSxFQUN2QztBQUNGO0FBRU8sU0FB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
