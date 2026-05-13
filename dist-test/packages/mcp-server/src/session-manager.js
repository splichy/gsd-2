import { readFileSync, existsSync } from "node:fs";
import { resolve, join, delimiter } from "node:path";
import { RpcClient } from "@gsd-build/rpc-client";
import { MAX_EVENTS, INIT_TIMEOUT_MS } from "./types.js";
const FIRE_AND_FORGET_METHODS = /* @__PURE__ */ new Set([
  "notify",
  "setStatus",
  "setWidget",
  "setTitle",
  "set_editor_text"
]);
const TERMINAL_PREFIXES = ["auto-mode stopped", "step-mode stopped"];
function findExecutableOnPath(command) {
  const pathValue = getPathEnvValue();
  if (!pathValue) return null;
  const extensions = process.platform === "win32" ? ["", ...(process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = join(dir, `${command}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}
function getPathEnvValue(env = process.env) {
  return env["PATH"] ?? env["Path"] ?? env["path"] ?? "";
}
function isTerminalNotification(event) {
  if (event.type !== "extension_ui_request" || event.method !== "notify") return false;
  const message = String(event.message ?? "").toLowerCase();
  return TERMINAL_PREFIXES.some((prefix) => message.startsWith(prefix));
}
function isBlockedNotification(event) {
  if (event.type !== "extension_ui_request" || event.method !== "notify") return false;
  const message = String(event.message ?? "").toLowerCase();
  return message.includes("blocked:");
}
function isBlockingUIRequest(event) {
  if (event.type !== "extension_ui_request") return false;
  const method = String(event.method ?? "");
  return !FIRE_AND_FORGET_METHODS.has(method);
}
class SessionManager {
  /** Sessions keyed by projectDir for duplicate-start prevention */
  sessions = /* @__PURE__ */ new Map();
  /**
   * Start a new GSD auto-mode session for the given project directory.
   *
   * Rejects if a session already exists for this projectDir.
   * Creates an RpcClient, starts the process, performs the v2 init handshake,
   * wires event tracking, and sends '/gsd auto' to begin execution.
   */
  async startSession(projectDir, options = {}) {
    if (!projectDir || projectDir.trim() === "") {
      throw new Error("projectDir is required and cannot be empty");
    }
    const resolvedDir = resolve(projectDir);
    const existing = this.sessions.get(resolvedDir);
    if (existing) {
      if (existing.status === "starting" || existing.status === "running" || existing.status === "blocked") {
        throw new Error(
          `Session already active for ${resolvedDir} (sessionId: ${existing.sessionId}, status: ${existing.status})`
        );
      }
      existing.unsubscribe?.();
      this.sessions.delete(resolvedDir);
    }
    const cliPath = options.cliPath ?? SessionManager.resolveCLIPath();
    const args = ["--mode", "rpc"];
    if (options.model) args.push("--model", options.model);
    if (options.bare) args.push("--bare");
    const client = new RpcClient({
      cliPath,
      cwd: resolvedDir,
      args
    });
    const session = {
      sessionId: "",
      // filled after init
      projectDir: resolvedDir,
      status: "starting",
      client,
      events: [],
      pendingBlocker: null,
      cost: { totalCost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      startTime: Date.now()
    };
    this.sessions.set(resolvedDir, session);
    try {
      await Promise.race([
        client.start(),
        timeout(INIT_TIMEOUT_MS, `RpcClient.start() timed out after ${INIT_TIMEOUT_MS}ms`)
      ]);
      const initResult = await Promise.race([
        client.init(),
        timeout(INIT_TIMEOUT_MS, `RpcClient.init() timed out after ${INIT_TIMEOUT_MS}ms`)
      ]);
      session.sessionId = initResult.sessionId;
      session.status = "running";
      session.unsubscribe = client.onEvent((event) => {
        this.handleEvent(session, event);
      });
      const command = options.command ?? "/gsd auto";
      await client.prompt(command);
      return session.sessionId;
    } catch (err) {
      session.status = "error";
      session.error = err instanceof Error ? err.message : String(err);
      try {
        await client.stop();
      } catch {
      }
      throw new Error(`Failed to start session for ${resolvedDir}: ${session.error}`);
    }
  }
  /**
   * Look up a session by sessionId.
   * Linear scan is fine — we expect <10 concurrent sessions.
   *
   * Empty sessionId is rejected explicitly: in-progress sessions carry an
   * empty sessionId until init() resolves, so an empty-string lookup would
   * otherwise match the first in-flight session and silently target the
   * wrong one (e.g. cancel a different caller's session).
   */
  getSession(sessionId) {
    if (!sessionId) return void 0;
    for (const session of this.sessions.values()) {
      if (session.sessionId === sessionId) return session;
    }
    return void 0;
  }
  /**
   * Look up a session by project directory (direct map lookup).
   */
  getSessionByDir(projectDir) {
    return this.sessions.get(resolve(projectDir));
  }
  /**
   * Resolve a pending blocker by sending a UI response.
   */
  async resolveBlocker(sessionId, response) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (!session.pendingBlocker) throw new Error(`No pending blocker for session ${sessionId}`);
    const blocker = session.pendingBlocker;
    session.client.sendUIResponse(blocker.id, { value: response });
    session.pendingBlocker = null;
    if (session.status === "blocked") {
      session.status = "running";
    }
  }
  /**
   * Cancel a running session — abort current operation then stop the process.
   */
  async cancelSession(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    await this._cancelSessionObject(session);
  }
  /**
   * Cancel a session looked up by project directory.
   *
   * This is the fallback path for interactive sessions (started via `/gsd auto`
   * in the terminal) and sessions from a restarted MCP server that have no
   * registered sessionId. The sessions map is keyed by projectDir, so this
   * lookup always succeeds for any tracked session regardless of sessionId.
   */
  async cancelSessionByDir(projectDir) {
    const session = this.getSessionByDir(projectDir);
    if (session) {
      await this._cancelSessionObject(session);
      return;
    }
    const stopped = await this.stopDetachedAutoProcess(projectDir);
    if (!stopped) {
      throw new Error(`Session not found for projectDir: ${projectDir}`);
    }
  }
  async stopDetachedAutoProcess(projectDir) {
    const lockPath = join(projectDir, ".gsd", "auto.lock");
    if (!existsSync(lockPath)) return false;
    try {
      const lockData = JSON.parse(readFileSync(lockPath, "utf-8"));
      const pid = lockData.pid;
      if (typeof pid !== "number") return false;
      try {
        process.kill(pid, 0);
      } catch {
        return false;
      }
      process.kill(pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }
  /**
   * Internal: perform abort + stop + mark cancelled on a resolved session object.
   */
  async _cancelSessionObject(session) {
    try {
      await session.client.abort();
    } catch {
    }
    try {
      await session.client.stop();
    } catch {
    }
    session.status = "cancelled";
    session.unsubscribe?.();
  }
  /**
   * Build a HeadlessJsonResult-shaped object from accumulated session state.
   */
  getResult(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const durationMs = Date.now() - session.startTime;
    return {
      sessionId: session.sessionId,
      projectDir: session.projectDir,
      status: session.status,
      durationMs,
      cost: session.cost,
      recentEvents: session.events.slice(-10),
      pendingBlocker: session.pendingBlocker ? { id: session.pendingBlocker.id, method: session.pendingBlocker.method, message: session.pendingBlocker.message } : null,
      error: session.error ?? null
    };
  }
  /**
   * Stop all active sessions and clean up resources.
   */
  async cleanup() {
    const stopPromises = [];
    for (const session of this.sessions.values()) {
      session.unsubscribe?.();
      if (session.status === "running" || session.status === "starting" || session.status === "blocked") {
        stopPromises.push(
          session.client.stop().catch(() => {
          })
        );
        session.status = "cancelled";
      }
    }
    await Promise.allSettled(stopPromises);
  }
  /**
   * Resolve the GSD CLI path.
   *
   * 1. GSD_CLI_PATH env var (highest priority)
   * 2. PATH lookup → resolve to the actual gsd executable/shim
   */
  static resolveCLIPath() {
    const envPath = process.env["GSD_CLI_PATH"];
    if (envPath) return resolve(envPath);
    const gsdBin = findExecutableOnPath("gsd");
    if (gsdBin) {
      return resolve(gsdBin);
    }
    throw new Error(
      "Cannot find GSD CLI. Set GSD_CLI_PATH environment variable or ensure `gsd` is in PATH."
    );
  }
  // ---------------------------------------------------------------------------
  // Private: Event Handling
  // ---------------------------------------------------------------------------
  handleEvent(session, event) {
    session.events.push(event);
    if (session.events.length > MAX_EVENTS) {
      session.events.splice(0, session.events.length - MAX_EVENTS);
    }
    if (event.type === "cost_update") {
      const costEvent = event;
      session.cost.totalCost = Math.max(session.cost.totalCost, costEvent.cumulativeCost ?? 0);
      if (costEvent.tokens) {
        session.cost.tokens.input = Math.max(session.cost.tokens.input, costEvent.tokens.input ?? 0);
        session.cost.tokens.output = Math.max(session.cost.tokens.output, costEvent.tokens.output ?? 0);
        session.cost.tokens.cacheRead = Math.max(session.cost.tokens.cacheRead, costEvent.tokens.cacheRead ?? 0);
        session.cost.tokens.cacheWrite = Math.max(session.cost.tokens.cacheWrite, costEvent.tokens.cacheWrite ?? 0);
      }
    }
    if (isTerminalNotification(event)) {
      if (isBlockedNotification(event)) {
        session.status = "blocked";
        session.pendingBlocker = extractBlocker(event);
      } else {
        session.status = "completed";
        session.unsubscribe?.();
      }
      return;
    }
    if (isBlockingUIRequest(event)) {
      session.status = "blocked";
      session.pendingBlocker = extractBlocker(event);
    }
  }
}
function timeout(ms, message) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}
function extractBlocker(event) {
  const uiEvent = event;
  return {
    id: String(uiEvent.id ?? ""),
    method: uiEvent.method,
    message: String(uiEvent.title ?? uiEvent.message ?? ""),
    event: uiEvent
  };
}
export {
  SessionManager
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvbWNwLXNlcnZlci9zcmMvc2Vzc2lvbi1tYW5hZ2VyLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFNlc3Npb25NYW5hZ2VyIFx1MjAxNCBtYW5hZ2VzIFJwY0NsaWVudCBsaWZlY3ljbGUgZm9yIGJhY2tncm91bmQgR1NEIGV4ZWN1dGlvbi5cbiAqXG4gKiBPbmUgYWN0aXZlIHNlc3Npb24gcGVyIHByb2plY3REaXIuIFRyYWNrcyBldmVudHMgaW4gYSByaW5nIGJ1ZmZlcixcbiAqIGRldGVjdHMgYmxvY2tlcnMsIHRyYWNrcyB0ZXJtaW5hbCBzdGF0ZSwgYW5kIGFjY3VtdWxhdGVzIGNvc3QgdXNpbmdcbiAqIHRoZSBjdW11bGF0aXZlLW1heCBwYXR0ZXJuIChLMDA0KS5cbiAqL1xuXG5pbXBvcnQgeyByZWFkRmlsZVN5bmMsIGV4aXN0c1N5bmMgfSBmcm9tICdub2RlOmZzJztcbmltcG9ydCB7IHJlc29sdmUsIGpvaW4sIGRlbGltaXRlciB9IGZyb20gJ25vZGU6cGF0aCc7XG5pbXBvcnQgeyBScGNDbGllbnQgfSBmcm9tICdAZ3NkLWJ1aWxkL3JwYy1jbGllbnQnO1xuaW1wb3J0IHR5cGUgeyBTZGtBZ2VudEV2ZW50LCBScGNJbml0UmVzdWx0LCBScGNDb3N0VXBkYXRlRXZlbnQsIFJwY0V4dGVuc2lvblVJUmVxdWVzdCB9IGZyb20gJ0Bnc2QtYnVpbGQvY29udHJhY3RzJztcbmltcG9ydCB0eXBlIHtcbiAgTWFuYWdlZFNlc3Npb24sXG4gIEV4ZWN1dGVPcHRpb25zLFxuICBQZW5kaW5nQmxvY2tlcixcbiAgQ29zdEFjY3VtdWxhdG9yLFxuICBTZXNzaW9uU3RhdHVzLFxufSBmcm9tICcuL3R5cGVzLmpzJztcbmltcG9ydCB7IE1BWF9FVkVOVFMsIElOSVRfVElNRU9VVF9NUyB9IGZyb20gJy4vdHlwZXMuanMnO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIElubGluZWQgZGV0ZWN0aW9uIGxvZ2ljIChmcm9tIGhlYWRsZXNzLWV2ZW50cy50cyBcdTIwMTQgbm8gaW50ZXJuYWwgcGFja2FnZSBpbXBvcnRzKVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmNvbnN0IEZJUkVfQU5EX0ZPUkdFVF9NRVRIT0RTID0gbmV3IFNldChbXG4gICdub3RpZnknLCAnc2V0U3RhdHVzJywgJ3NldFdpZGdldCcsICdzZXRUaXRsZScsICdzZXRfZWRpdG9yX3RleHQnLFxuXSk7XG5cbmNvbnN0IFRFUk1JTkFMX1BSRUZJWEVTID0gWydhdXRvLW1vZGUgc3RvcHBlZCcsICdzdGVwLW1vZGUgc3RvcHBlZCddO1xuXG5mdW5jdGlvbiBmaW5kRXhlY3V0YWJsZU9uUGF0aChjb21tYW5kOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3QgcGF0aFZhbHVlID0gZ2V0UGF0aEVudlZhbHVlKCk7XG4gIGlmICghcGF0aFZhbHVlKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgZXh0ZW5zaW9ucyA9IHByb2Nlc3MucGxhdGZvcm0gPT09ICd3aW4zMidcbiAgICA/IFsnJywgLi4uKHByb2Nlc3MuZW52WydQQVRIRVhUJ10gPz8gJy5DT007LkVYRTsuQkFUOy5DTUQnKVxuICAgICAgLnNwbGl0KCc7JylcbiAgICAgIC5maWx0ZXIoQm9vbGVhbildXG4gICAgOiBbJyddO1xuICBmb3IgKGNvbnN0IGRpciBvZiBwYXRoVmFsdWUuc3BsaXQoZGVsaW1pdGVyKSkge1xuICAgIGlmICghZGlyKSBjb250aW51ZTtcbiAgICBmb3IgKGNvbnN0IGV4dCBvZiBleHRlbnNpb25zKSB7XG4gICAgICBjb25zdCBjYW5kaWRhdGUgPSBqb2luKGRpciwgYCR7Y29tbWFuZH0ke2V4dH1gKTtcbiAgICAgIGlmIChleGlzdHNTeW5jKGNhbmRpZGF0ZSkpIHJldHVybiBjYW5kaWRhdGU7XG4gICAgfVxuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBnZXRQYXRoRW52VmFsdWUoZW52OiBOb2RlSlMuUHJvY2Vzc0VudiA9IHByb2Nlc3MuZW52KTogc3RyaW5nIHtcbiAgcmV0dXJuIGVudlsnUEFUSCddID8/IGVudlsnUGF0aCddID8/IGVudlsncGF0aCddID8/ICcnO1xufVxuXG5mdW5jdGlvbiBpc1Rlcm1pbmFsTm90aWZpY2F0aW9uKGV2ZW50OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IGJvb2xlYW4ge1xuICBpZiAoZXZlbnQudHlwZSAhPT0gJ2V4dGVuc2lvbl91aV9yZXF1ZXN0JyB8fCBldmVudC5tZXRob2QgIT09ICdub3RpZnknKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IG1lc3NhZ2UgPSBTdHJpbmcoZXZlbnQubWVzc2FnZSA/PyAnJykudG9Mb3dlckNhc2UoKTtcbiAgcmV0dXJuIFRFUk1JTkFMX1BSRUZJWEVTLnNvbWUoKHByZWZpeCkgPT4gbWVzc2FnZS5zdGFydHNXaXRoKHByZWZpeCkpO1xufVxuXG5mdW5jdGlvbiBpc0Jsb2NrZWROb3RpZmljYXRpb24oZXZlbnQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogYm9vbGVhbiB7XG4gIGlmIChldmVudC50eXBlICE9PSAnZXh0ZW5zaW9uX3VpX3JlcXVlc3QnIHx8IGV2ZW50Lm1ldGhvZCAhPT0gJ25vdGlmeScpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgbWVzc2FnZSA9IFN0cmluZyhldmVudC5tZXNzYWdlID8/ICcnKS50b0xvd2VyQ2FzZSgpO1xuICByZXR1cm4gbWVzc2FnZS5pbmNsdWRlcygnYmxvY2tlZDonKTtcbn1cblxuZnVuY3Rpb24gaXNCbG9ja2luZ1VJUmVxdWVzdChldmVudDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBib29sZWFuIHtcbiAgaWYgKGV2ZW50LnR5cGUgIT09ICdleHRlbnNpb25fdWlfcmVxdWVzdCcpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgbWV0aG9kID0gU3RyaW5nKGV2ZW50Lm1ldGhvZCA/PyAnJyk7XG4gIHJldHVybiAhRklSRV9BTkRfRk9SR0VUX01FVEhPRFMuaGFzKG1ldGhvZCk7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gU2Vzc2lvbk1hbmFnZXJcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5leHBvcnQgY2xhc3MgU2Vzc2lvbk1hbmFnZXIge1xuICAvKiogU2Vzc2lvbnMga2V5ZWQgYnkgcHJvamVjdERpciBmb3IgZHVwbGljYXRlLXN0YXJ0IHByZXZlbnRpb24gKi9cbiAgcHJpdmF0ZSBzZXNzaW9ucyA9IG5ldyBNYXA8c3RyaW5nLCBNYW5hZ2VkU2Vzc2lvbj4oKTtcblxuICAvKipcbiAgICogU3RhcnQgYSBuZXcgR1NEIGF1dG8tbW9kZSBzZXNzaW9uIGZvciB0aGUgZ2l2ZW4gcHJvamVjdCBkaXJlY3RvcnkuXG4gICAqXG4gICAqIFJlamVjdHMgaWYgYSBzZXNzaW9uIGFscmVhZHkgZXhpc3RzIGZvciB0aGlzIHByb2plY3REaXIuXG4gICAqIENyZWF0ZXMgYW4gUnBjQ2xpZW50LCBzdGFydHMgdGhlIHByb2Nlc3MsIHBlcmZvcm1zIHRoZSB2MiBpbml0IGhhbmRzaGFrZSxcbiAgICogd2lyZXMgZXZlbnQgdHJhY2tpbmcsIGFuZCBzZW5kcyAnL2dzZCBhdXRvJyB0byBiZWdpbiBleGVjdXRpb24uXG4gICAqL1xuICBhc3luYyBzdGFydFNlc3Npb24ocHJvamVjdERpcjogc3RyaW5nLCBvcHRpb25zOiBFeGVjdXRlT3B0aW9ucyA9IHt9KTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgICBpZiAoIXByb2plY3REaXIgfHwgcHJvamVjdERpci50cmltKCkgPT09ICcnKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ3Byb2plY3REaXIgaXMgcmVxdWlyZWQgYW5kIGNhbm5vdCBiZSBlbXB0eScpO1xuICAgIH1cblxuICAgIGNvbnN0IHJlc29sdmVkRGlyID0gcmVzb2x2ZShwcm9qZWN0RGlyKTtcblxuICAgIGNvbnN0IGV4aXN0aW5nID0gdGhpcy5zZXNzaW9ucy5nZXQocmVzb2x2ZWREaXIpO1xuICAgIGlmIChleGlzdGluZykge1xuICAgICAgLy8gT25seSBibG9jayB3aGVuIGEgZ2VudWluZWx5IGFjdGl2ZSBzZXNzaW9uIGlzIHJ1bm5pbmcuIFRlcm1pbmFsXG4gICAgICAvLyBzdGF0ZXMgKGVycm9yLCBjb21wbGV0ZWQsIGNhbmNlbGxlZCkgYXJlIGV2aWN0ZWQgc28gdGhlIGNhbGxlciBjYW5cbiAgICAgIC8vIHN0YXJ0IGEgZnJlc2ggc2Vzc2lvbiBmb3IgdGhlIHNhbWUgcHJvamVjdERpci5cbiAgICAgIGlmIChleGlzdGluZy5zdGF0dXMgPT09ICdzdGFydGluZycgfHwgZXhpc3Rpbmcuc3RhdHVzID09PSAncnVubmluZycgfHwgZXhpc3Rpbmcuc3RhdHVzID09PSAnYmxvY2tlZCcpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIGBTZXNzaW9uIGFscmVhZHkgYWN0aXZlIGZvciAke3Jlc29sdmVkRGlyfSAoc2Vzc2lvbklkOiAke2V4aXN0aW5nLnNlc3Npb25JZH0sIHN0YXR1czogJHtleGlzdGluZy5zdGF0dXN9KWBcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGV4aXN0aW5nLnVuc3Vic2NyaWJlPy4oKTtcbiAgICAgIHRoaXMuc2Vzc2lvbnMuZGVsZXRlKHJlc29sdmVkRGlyKTtcbiAgICB9XG5cbiAgICBjb25zdCBjbGlQYXRoID0gb3B0aW9ucy5jbGlQYXRoID8/IFNlc3Npb25NYW5hZ2VyLnJlc29sdmVDTElQYXRoKCk7XG5cbiAgICBjb25zdCBhcmdzOiBzdHJpbmdbXSA9IFsnLS1tb2RlJywgJ3JwYyddO1xuICAgIGlmIChvcHRpb25zLm1vZGVsKSBhcmdzLnB1c2goJy0tbW9kZWwnLCBvcHRpb25zLm1vZGVsKTtcbiAgICBpZiAob3B0aW9ucy5iYXJlKSBhcmdzLnB1c2goJy0tYmFyZScpO1xuXG4gICAgY29uc3QgY2xpZW50ID0gbmV3IFJwY0NsaWVudCh7XG4gICAgICBjbGlQYXRoLFxuICAgICAgY3dkOiByZXNvbHZlZERpcixcbiAgICAgIGFyZ3MsXG4gICAgfSk7XG5cbiAgICAvLyBCdWlsZCB0aGUgc2Vzc2lvbiBzaGVsbCBiZWZvcmUgYXN5bmMgb3BlcmF0aW9ucyBzbyB3ZSBjYW4gdHJhY2sgc3RhdGVcbiAgICBjb25zdCBzZXNzaW9uOiBNYW5hZ2VkU2Vzc2lvbiA9IHtcbiAgICAgIHNlc3Npb25JZDogJycsIC8vIGZpbGxlZCBhZnRlciBpbml0XG4gICAgICBwcm9qZWN0RGlyOiByZXNvbHZlZERpcixcbiAgICAgIHN0YXR1czogJ3N0YXJ0aW5nJyxcbiAgICAgIGNsaWVudCxcbiAgICAgIGV2ZW50czogW10sXG4gICAgICBwZW5kaW5nQmxvY2tlcjogbnVsbCxcbiAgICAgIGNvc3Q6IHsgdG90YWxDb3N0OiAwLCB0b2tlbnM6IHsgaW5wdXQ6IDAsIG91dHB1dDogMCwgY2FjaGVSZWFkOiAwLCBjYWNoZVdyaXRlOiAwIH0gfSxcbiAgICAgIHN0YXJ0VGltZTogRGF0ZS5ub3coKSxcbiAgICB9O1xuXG4gICAgLy8gSW5zZXJ0IGludG8gbWFwIGVhcmx5IChrZXllZCBieSBkaXIpIHNvIGNvbmN1cnJlbnQgc3RhcnRzIGFyZSByZWplY3RlZFxuICAgIHRoaXMuc2Vzc2lvbnMuc2V0KHJlc29sdmVkRGlyLCBzZXNzaW9uKTtcblxuICAgIHRyeSB7XG4gICAgICAvLyBTdGFydCB0aGUgcHJvY2VzcyB3aXRoIHRpbWVvdXRcbiAgICAgIGF3YWl0IFByb21pc2UucmFjZShbXG4gICAgICAgIGNsaWVudC5zdGFydCgpLFxuICAgICAgICB0aW1lb3V0KElOSVRfVElNRU9VVF9NUywgYFJwY0NsaWVudC5zdGFydCgpIHRpbWVkIG91dCBhZnRlciAke0lOSVRfVElNRU9VVF9NU31tc2ApLFxuICAgICAgXSk7XG5cbiAgICAgIC8vIFBlcmZvcm0gdjIgaW5pdCBoYW5kc2hha2VcbiAgICAgIGNvbnN0IGluaXRSZXN1bHQ6IFJwY0luaXRSZXN1bHQgPSBhd2FpdCBQcm9taXNlLnJhY2UoW1xuICAgICAgICBjbGllbnQuaW5pdCgpLFxuICAgICAgICB0aW1lb3V0KElOSVRfVElNRU9VVF9NUywgYFJwY0NsaWVudC5pbml0KCkgdGltZWQgb3V0IGFmdGVyICR7SU5JVF9USU1FT1VUX01TfW1zYCksXG4gICAgICBdKSBhcyBScGNJbml0UmVzdWx0O1xuXG4gICAgICBzZXNzaW9uLnNlc3Npb25JZCA9IGluaXRSZXN1bHQuc2Vzc2lvbklkO1xuICAgICAgc2Vzc2lvbi5zdGF0dXMgPSAncnVubmluZyc7XG5cbiAgICAgIC8vIFdpcmUgZXZlbnQgdHJhY2tpbmdcbiAgICAgIHNlc3Npb24udW5zdWJzY3JpYmUgPSBjbGllbnQub25FdmVudCgoZXZlbnQ6IFNka0FnZW50RXZlbnQpID0+IHtcbiAgICAgICAgdGhpcy5oYW5kbGVFdmVudChzZXNzaW9uLCBldmVudCk7XG4gICAgICB9KTtcblxuICAgICAgLy8gS2ljayBvZmYgYXV0by1tb2RlXG4gICAgICBjb25zdCBjb21tYW5kID0gb3B0aW9ucy5jb21tYW5kID8/ICcvZ3NkIGF1dG8nO1xuICAgICAgYXdhaXQgY2xpZW50LnByb21wdChjb21tYW5kKTtcblxuICAgICAgcmV0dXJuIHNlc3Npb24uc2Vzc2lvbklkO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgc2Vzc2lvbi5zdGF0dXMgPSAnZXJyb3InO1xuICAgICAgc2Vzc2lvbi5lcnJvciA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcblxuICAgICAgLy8gQXR0ZW1wdCBjbGVhbnVwXG4gICAgICB0cnkgeyBhd2FpdCBjbGllbnQuc3RvcCgpOyB9IGNhdGNoIHsgLyogc3dhbGxvdyBjbGVhbnVwIGVycm9ycyAqLyB9XG5cbiAgICAgIC8vIEtlZXAgc2Vzc2lvbiBpbiBtYXAgc28gY2FsbGVycyBjYW4gaW5zcGVjdCB0aGUgZXJyb3JcbiAgICAgIHRocm93IG5ldyBFcnJvcihgRmFpbGVkIHRvIHN0YXJ0IHNlc3Npb24gZm9yICR7cmVzb2x2ZWREaXJ9OiAke3Nlc3Npb24uZXJyb3J9YCk7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIExvb2sgdXAgYSBzZXNzaW9uIGJ5IHNlc3Npb25JZC5cbiAgICogTGluZWFyIHNjYW4gaXMgZmluZSBcdTIwMTQgd2UgZXhwZWN0IDwxMCBjb25jdXJyZW50IHNlc3Npb25zLlxuICAgKlxuICAgKiBFbXB0eSBzZXNzaW9uSWQgaXMgcmVqZWN0ZWQgZXhwbGljaXRseTogaW4tcHJvZ3Jlc3Mgc2Vzc2lvbnMgY2FycnkgYW5cbiAgICogZW1wdHkgc2Vzc2lvbklkIHVudGlsIGluaXQoKSByZXNvbHZlcywgc28gYW4gZW1wdHktc3RyaW5nIGxvb2t1cCB3b3VsZFxuICAgKiBvdGhlcndpc2UgbWF0Y2ggdGhlIGZpcnN0IGluLWZsaWdodCBzZXNzaW9uIGFuZCBzaWxlbnRseSB0YXJnZXQgdGhlXG4gICAqIHdyb25nIG9uZSAoZS5nLiBjYW5jZWwgYSBkaWZmZXJlbnQgY2FsbGVyJ3Mgc2Vzc2lvbikuXG4gICAqL1xuICBnZXRTZXNzaW9uKHNlc3Npb25JZDogc3RyaW5nKTogTWFuYWdlZFNlc3Npb24gfCB1bmRlZmluZWQge1xuICAgIGlmICghc2Vzc2lvbklkKSByZXR1cm4gdW5kZWZpbmVkO1xuICAgIGZvciAoY29uc3Qgc2Vzc2lvbiBvZiB0aGlzLnNlc3Npb25zLnZhbHVlcygpKSB7XG4gICAgICBpZiAoc2Vzc2lvbi5zZXNzaW9uSWQgPT09IHNlc3Npb25JZCkgcmV0dXJuIHNlc3Npb247XG4gICAgfVxuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cblxuICAvKipcbiAgICogTG9vayB1cCBhIHNlc3Npb24gYnkgcHJvamVjdCBkaXJlY3RvcnkgKGRpcmVjdCBtYXAgbG9va3VwKS5cbiAgICovXG4gIGdldFNlc3Npb25CeURpcihwcm9qZWN0RGlyOiBzdHJpbmcpOiBNYW5hZ2VkU2Vzc2lvbiB8IHVuZGVmaW5lZCB7XG4gICAgcmV0dXJuIHRoaXMuc2Vzc2lvbnMuZ2V0KHJlc29sdmUocHJvamVjdERpcikpO1xuICB9XG5cbiAgLyoqXG4gICAqIFJlc29sdmUgYSBwZW5kaW5nIGJsb2NrZXIgYnkgc2VuZGluZyBhIFVJIHJlc3BvbnNlLlxuICAgKi9cbiAgYXN5bmMgcmVzb2x2ZUJsb2NrZXIoc2Vzc2lvbklkOiBzdHJpbmcsIHJlc3BvbnNlOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCBzZXNzaW9uID0gdGhpcy5nZXRTZXNzaW9uKHNlc3Npb25JZCk7XG4gICAgaWYgKCFzZXNzaW9uKSB0aHJvdyBuZXcgRXJyb3IoYFNlc3Npb24gbm90IGZvdW5kOiAke3Nlc3Npb25JZH1gKTtcbiAgICBpZiAoIXNlc3Npb24ucGVuZGluZ0Jsb2NrZXIpIHRocm93IG5ldyBFcnJvcihgTm8gcGVuZGluZyBibG9ja2VyIGZvciBzZXNzaW9uICR7c2Vzc2lvbklkfWApO1xuXG4gICAgY29uc3QgYmxvY2tlciA9IHNlc3Npb24ucGVuZGluZ0Jsb2NrZXI7XG4gICAgc2Vzc2lvbi5jbGllbnQuc2VuZFVJUmVzcG9uc2UoYmxvY2tlci5pZCwgeyB2YWx1ZTogcmVzcG9uc2UgfSk7XG4gICAgc2Vzc2lvbi5wZW5kaW5nQmxvY2tlciA9IG51bGw7XG4gICAgaWYgKHNlc3Npb24uc3RhdHVzID09PSAnYmxvY2tlZCcpIHtcbiAgICAgIHNlc3Npb24uc3RhdHVzID0gJ3J1bm5pbmcnO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBDYW5jZWwgYSBydW5uaW5nIHNlc3Npb24gXHUyMDE0IGFib3J0IGN1cnJlbnQgb3BlcmF0aW9uIHRoZW4gc3RvcCB0aGUgcHJvY2Vzcy5cbiAgICovXG4gIGFzeW5jIGNhbmNlbFNlc3Npb24oc2Vzc2lvbklkOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCBzZXNzaW9uID0gdGhpcy5nZXRTZXNzaW9uKHNlc3Npb25JZCk7XG4gICAgaWYgKCFzZXNzaW9uKSB0aHJvdyBuZXcgRXJyb3IoYFNlc3Npb24gbm90IGZvdW5kOiAke3Nlc3Npb25JZH1gKTtcbiAgICBhd2FpdCB0aGlzLl9jYW5jZWxTZXNzaW9uT2JqZWN0KHNlc3Npb24pO1xuICB9XG5cbiAgLyoqXG4gICAqIENhbmNlbCBhIHNlc3Npb24gbG9va2VkIHVwIGJ5IHByb2plY3QgZGlyZWN0b3J5LlxuICAgKlxuICAgKiBUaGlzIGlzIHRoZSBmYWxsYmFjayBwYXRoIGZvciBpbnRlcmFjdGl2ZSBzZXNzaW9ucyAoc3RhcnRlZCB2aWEgYC9nc2QgYXV0b2BcbiAgICogaW4gdGhlIHRlcm1pbmFsKSBhbmQgc2Vzc2lvbnMgZnJvbSBhIHJlc3RhcnRlZCBNQ1Agc2VydmVyIHRoYXQgaGF2ZSBub1xuICAgKiByZWdpc3RlcmVkIHNlc3Npb25JZC4gVGhlIHNlc3Npb25zIG1hcCBpcyBrZXllZCBieSBwcm9qZWN0RGlyLCBzbyB0aGlzXG4gICAqIGxvb2t1cCBhbHdheXMgc3VjY2VlZHMgZm9yIGFueSB0cmFja2VkIHNlc3Npb24gcmVnYXJkbGVzcyBvZiBzZXNzaW9uSWQuXG4gICAqL1xuICBhc3luYyBjYW5jZWxTZXNzaW9uQnlEaXIocHJvamVjdERpcjogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3Qgc2Vzc2lvbiA9IHRoaXMuZ2V0U2Vzc2lvbkJ5RGlyKHByb2plY3REaXIpO1xuICAgIGlmIChzZXNzaW9uKSB7XG4gICAgICBhd2FpdCB0aGlzLl9jYW5jZWxTZXNzaW9uT2JqZWN0KHNlc3Npb24pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBzdG9wcGVkID0gYXdhaXQgdGhpcy5zdG9wRGV0YWNoZWRBdXRvUHJvY2Vzcyhwcm9qZWN0RGlyKTtcbiAgICBpZiAoIXN0b3BwZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgU2Vzc2lvbiBub3QgZm91bmQgZm9yIHByb2plY3REaXI6ICR7cHJvamVjdERpcn1gKTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHN0b3BEZXRhY2hlZEF1dG9Qcm9jZXNzKHByb2plY3REaXI6IHN0cmluZyk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICAgIGNvbnN0IGxvY2tQYXRoID0gam9pbihwcm9qZWN0RGlyLCAnLmdzZCcsICdhdXRvLmxvY2snKTtcbiAgICBpZiAoIWV4aXN0c1N5bmMobG9ja1BhdGgpKSByZXR1cm4gZmFsc2U7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGxvY2tEYXRhID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMobG9ja1BhdGgsICd1dGYtOCcpKSBhcyB7IHBpZD86IG51bWJlciB9O1xuICAgICAgY29uc3QgcGlkID0gbG9ja0RhdGEucGlkO1xuICAgICAgaWYgKHR5cGVvZiBwaWQgIT09ICdudW1iZXInKSByZXR1cm4gZmFsc2U7XG4gICAgICB0cnkgeyBwcm9jZXNzLmtpbGwocGlkLCAwKTsgfSBjYXRjaCB7IHJldHVybiBmYWxzZTsgfVxuICAgICAgcHJvY2Vzcy5raWxsKHBpZCwgJ1NJR1RFUk0nKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBJbnRlcm5hbDogcGVyZm9ybSBhYm9ydCArIHN0b3AgKyBtYXJrIGNhbmNlbGxlZCBvbiBhIHJlc29sdmVkIHNlc3Npb24gb2JqZWN0LlxuICAgKi9cbiAgcHJpdmF0ZSBhc3luYyBfY2FuY2VsU2Vzc2lvbk9iamVjdChzZXNzaW9uOiBNYW5hZ2VkU2Vzc2lvbik6IFByb21pc2U8dm9pZD4ge1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBzZXNzaW9uLmNsaWVudC5hYm9ydCgpO1xuICAgIH0gY2F0Y2ggeyAvKiBtYXkgYWxyZWFkeSBiZSBzdG9wcGVkICovIH1cblxuICAgIHRyeSB7XG4gICAgICBhd2FpdCBzZXNzaW9uLmNsaWVudC5zdG9wKCk7XG4gICAgfSBjYXRjaCB7IC8qIHN3YWxsb3cgKi8gfVxuXG4gICAgc2Vzc2lvbi5zdGF0dXMgPSAnY2FuY2VsbGVkJztcbiAgICBzZXNzaW9uLnVuc3Vic2NyaWJlPy4oKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBCdWlsZCBhIEhlYWRsZXNzSnNvblJlc3VsdC1zaGFwZWQgb2JqZWN0IGZyb20gYWNjdW11bGF0ZWQgc2Vzc2lvbiBzdGF0ZS5cbiAgICovXG4gIGdldFJlc3VsdChzZXNzaW9uSWQ6IHN0cmluZyk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICBjb25zdCBzZXNzaW9uID0gdGhpcy5nZXRTZXNzaW9uKHNlc3Npb25JZCk7XG4gICAgaWYgKCFzZXNzaW9uKSB0aHJvdyBuZXcgRXJyb3IoYFNlc3Npb24gbm90IGZvdW5kOiAke3Nlc3Npb25JZH1gKTtcblxuICAgIGNvbnN0IGR1cmF0aW9uTXMgPSBEYXRlLm5vdygpIC0gc2Vzc2lvbi5zdGFydFRpbWU7XG5cbiAgICByZXR1cm4ge1xuICAgICAgc2Vzc2lvbklkOiBzZXNzaW9uLnNlc3Npb25JZCxcbiAgICAgIHByb2plY3REaXI6IHNlc3Npb24ucHJvamVjdERpcixcbiAgICAgIHN0YXR1czogc2Vzc2lvbi5zdGF0dXMsXG4gICAgICBkdXJhdGlvbk1zLFxuICAgICAgY29zdDogc2Vzc2lvbi5jb3N0LFxuICAgICAgcmVjZW50RXZlbnRzOiBzZXNzaW9uLmV2ZW50cy5zbGljZSgtMTApLFxuICAgICAgcGVuZGluZ0Jsb2NrZXI6IHNlc3Npb24ucGVuZGluZ0Jsb2NrZXJcbiAgICAgICAgPyB7IGlkOiBzZXNzaW9uLnBlbmRpbmdCbG9ja2VyLmlkLCBtZXRob2Q6IHNlc3Npb24ucGVuZGluZ0Jsb2NrZXIubWV0aG9kLCBtZXNzYWdlOiBzZXNzaW9uLnBlbmRpbmdCbG9ja2VyLm1lc3NhZ2UgfVxuICAgICAgICA6IG51bGwsXG4gICAgICBlcnJvcjogc2Vzc2lvbi5lcnJvciA/PyBudWxsLFxuICAgIH07XG4gIH1cblxuICAvKipcbiAgICogU3RvcCBhbGwgYWN0aXZlIHNlc3Npb25zIGFuZCBjbGVhbiB1cCByZXNvdXJjZXMuXG4gICAqL1xuICBhc3luYyBjbGVhbnVwKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IHN0b3BQcm9taXNlczogUHJvbWlzZTx2b2lkPltdID0gW107XG5cbiAgICBmb3IgKGNvbnN0IHNlc3Npb24gb2YgdGhpcy5zZXNzaW9ucy52YWx1ZXMoKSkge1xuICAgICAgc2Vzc2lvbi51bnN1YnNjcmliZT8uKCk7XG4gICAgICBpZiAoc2Vzc2lvbi5zdGF0dXMgPT09ICdydW5uaW5nJyB8fCBzZXNzaW9uLnN0YXR1cyA9PT0gJ3N0YXJ0aW5nJyB8fCBzZXNzaW9uLnN0YXR1cyA9PT0gJ2Jsb2NrZWQnKSB7XG4gICAgICAgIHN0b3BQcm9taXNlcy5wdXNoKFxuICAgICAgICAgIHNlc3Npb24uY2xpZW50LnN0b3AoKS5jYXRjaCgoKSA9PiB7IC8qIHN3YWxsb3cgKi8gfSlcbiAgICAgICAgKTtcbiAgICAgICAgc2Vzc2lvbi5zdGF0dXMgPSAnY2FuY2VsbGVkJztcbiAgICAgIH1cbiAgICB9XG5cbiAgICBhd2FpdCBQcm9taXNlLmFsbFNldHRsZWQoc3RvcFByb21pc2VzKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXNvbHZlIHRoZSBHU0QgQ0xJIHBhdGguXG4gICAqXG4gICAqIDEuIEdTRF9DTElfUEFUSCBlbnYgdmFyIChoaWdoZXN0IHByaW9yaXR5KVxuICAgKiAyLiBQQVRIIGxvb2t1cCBcdTIxOTIgcmVzb2x2ZSB0byB0aGUgYWN0dWFsIGdzZCBleGVjdXRhYmxlL3NoaW1cbiAgICovXG4gIHN0YXRpYyByZXNvbHZlQ0xJUGF0aCgpOiBzdHJpbmcge1xuICAgIC8vIENoZWNrIGVudiB2YXIgZmlyc3RcbiAgICBjb25zdCBlbnZQYXRoID0gcHJvY2Vzcy5lbnZbJ0dTRF9DTElfUEFUSCddO1xuICAgIGlmIChlbnZQYXRoKSByZXR1cm4gcmVzb2x2ZShlbnZQYXRoKTtcblxuICAgIGNvbnN0IGdzZEJpbiA9IGZpbmRFeGVjdXRhYmxlT25QYXRoKCdnc2QnKTtcbiAgICBpZiAoZ3NkQmluKSB7XG4gICAgICByZXR1cm4gcmVzb2x2ZShnc2RCaW4pO1xuICAgIH1cblxuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICdDYW5ub3QgZmluZCBHU0QgQ0xJLiBTZXQgR1NEX0NMSV9QQVRIIGVudmlyb25tZW50IHZhcmlhYmxlIG9yIGVuc3VyZSBgZ3NkYCBpcyBpbiBQQVRILidcbiAgICApO1xuICB9XG5cbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIC8vIFByaXZhdGU6IEV2ZW50IEhhbmRsaW5nXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gIHByaXZhdGUgaGFuZGxlRXZlbnQoc2Vzc2lvbjogTWFuYWdlZFNlc3Npb24sIGV2ZW50OiBTZGtBZ2VudEV2ZW50KTogdm9pZCB7XG4gICAgLy8gUmluZyBidWZmZXI6IHB1c2ggYW5kIHRyaW1cbiAgICBzZXNzaW9uLmV2ZW50cy5wdXNoKGV2ZW50KTtcbiAgICBpZiAoc2Vzc2lvbi5ldmVudHMubGVuZ3RoID4gTUFYX0VWRU5UUykge1xuICAgICAgc2Vzc2lvbi5ldmVudHMuc3BsaWNlKDAsIHNlc3Npb24uZXZlbnRzLmxlbmd0aCAtIE1BWF9FVkVOVFMpO1xuICAgIH1cblxuICAgIC8vIENvc3QgdHJhY2tpbmcgKEswMDQgXHUyMDE0IGN1bXVsYXRpdmUtbWF4KVxuICAgIGlmIChldmVudC50eXBlID09PSAnY29zdF91cGRhdGUnKSB7XG4gICAgICBjb25zdCBjb3N0RXZlbnQgPSBldmVudCBhcyB1bmtub3duIGFzIFJwY0Nvc3RVcGRhdGVFdmVudDtcbiAgICAgIHNlc3Npb24uY29zdC50b3RhbENvc3QgPSBNYXRoLm1heChzZXNzaW9uLmNvc3QudG90YWxDb3N0LCBjb3N0RXZlbnQuY3VtdWxhdGl2ZUNvc3QgPz8gMCk7XG4gICAgICBpZiAoY29zdEV2ZW50LnRva2Vucykge1xuICAgICAgICBzZXNzaW9uLmNvc3QudG9rZW5zLmlucHV0ID0gTWF0aC5tYXgoc2Vzc2lvbi5jb3N0LnRva2Vucy5pbnB1dCwgY29zdEV2ZW50LnRva2Vucy5pbnB1dCA/PyAwKTtcbiAgICAgICAgc2Vzc2lvbi5jb3N0LnRva2Vucy5vdXRwdXQgPSBNYXRoLm1heChzZXNzaW9uLmNvc3QudG9rZW5zLm91dHB1dCwgY29zdEV2ZW50LnRva2Vucy5vdXRwdXQgPz8gMCk7XG4gICAgICAgIHNlc3Npb24uY29zdC50b2tlbnMuY2FjaGVSZWFkID0gTWF0aC5tYXgoc2Vzc2lvbi5jb3N0LnRva2Vucy5jYWNoZVJlYWQsIGNvc3RFdmVudC50b2tlbnMuY2FjaGVSZWFkID8/IDApO1xuICAgICAgICBzZXNzaW9uLmNvc3QudG9rZW5zLmNhY2hlV3JpdGUgPSBNYXRoLm1heChzZXNzaW9uLmNvc3QudG9rZW5zLmNhY2hlV3JpdGUsIGNvc3RFdmVudC50b2tlbnMuY2FjaGVXcml0ZSA/PyAwKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBUZXJtaW5hbCBkZXRlY3Rpb24gXHUyMDE0IGF1dG8tbW9kZS9zdGVwLW1vZGUgc3RvcHBlZFxuICAgIGlmIChpc1Rlcm1pbmFsTm90aWZpY2F0aW9uKGV2ZW50IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSkge1xuICAgICAgLy8gQ2hlY2sgaWYgaXQncyBhIGJsb2NrZWQgc3RvcCAobm90IHRydWx5IHRlcm1pbmFsIFx1MjAxNCBpdCdzIGEgYmxvY2tlcilcbiAgICAgIGlmIChpc0Jsb2NrZWROb3RpZmljYXRpb24oZXZlbnQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pKSB7XG4gICAgICAgIHNlc3Npb24uc3RhdHVzID0gJ2Jsb2NrZWQnO1xuICAgICAgICBzZXNzaW9uLnBlbmRpbmdCbG9ja2VyID0gZXh0cmFjdEJsb2NrZXIoZXZlbnQpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgc2Vzc2lvbi5zdGF0dXMgPSAnY29tcGxldGVkJztcbiAgICAgICAgc2Vzc2lvbi51bnN1YnNjcmliZT8uKCk7XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gQmxvY2tlciBkZXRlY3Rpb24gXHUyMDE0IG5vbi1maXJlLWFuZC1mb3JnZXQgZXh0ZW5zaW9uX3VpX3JlcXVlc3RcbiAgICBpZiAoaXNCbG9ja2luZ1VJUmVxdWVzdChldmVudCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikpIHtcbiAgICAgIHNlc3Npb24uc3RhdHVzID0gJ2Jsb2NrZWQnO1xuICAgICAgc2Vzc2lvbi5wZW5kaW5nQmxvY2tlciA9IGV4dHJhY3RCbG9ja2VyKGV2ZW50KTtcbiAgICB9XG4gIH1cbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBIZWxwZXJzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZnVuY3Rpb24gdGltZW91dChtczogbnVtYmVyLCBtZXNzYWdlOiBzdHJpbmcpOiBQcm9taXNlPG5ldmVyPiB7XG4gIHJldHVybiBuZXcgUHJvbWlzZSgoXywgcmVqZWN0KSA9PiB7XG4gICAgc2V0VGltZW91dCgoKSA9PiByZWplY3QobmV3IEVycm9yKG1lc3NhZ2UpKSwgbXMpO1xuICB9KTtcbn1cblxuZnVuY3Rpb24gZXh0cmFjdEJsb2NrZXIoZXZlbnQ6IFNka0FnZW50RXZlbnQpOiBQZW5kaW5nQmxvY2tlciB7XG4gIGNvbnN0IHVpRXZlbnQgPSBldmVudCBhcyB1bmtub3duIGFzIFJwY0V4dGVuc2lvblVJUmVxdWVzdDtcbiAgcmV0dXJuIHtcbiAgICBpZDogU3RyaW5nKHVpRXZlbnQuaWQgPz8gJycpLFxuICAgIG1ldGhvZDogdWlFdmVudC5tZXRob2QsXG4gICAgbWVzc2FnZTogU3RyaW5nKCh1aUV2ZW50IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KS50aXRsZSA/PyAodWlFdmVudCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikubWVzc2FnZSA/PyAnJyksXG4gICAgZXZlbnQ6IHVpRXZlbnQsXG4gIH07XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFRQSxTQUFTLGNBQWMsa0JBQWtCO0FBQ3pDLFNBQVMsU0FBUyxNQUFNLGlCQUFpQjtBQUN6QyxTQUFTLGlCQUFpQjtBQVMxQixTQUFTLFlBQVksdUJBQXVCO0FBTTVDLE1BQU0sMEJBQTBCLG9CQUFJLElBQUk7QUFBQSxFQUN0QztBQUFBLEVBQVU7QUFBQSxFQUFhO0FBQUEsRUFBYTtBQUFBLEVBQVk7QUFDbEQsQ0FBQztBQUVELE1BQU0sb0JBQW9CLENBQUMscUJBQXFCLG1CQUFtQjtBQUVuRSxTQUFTLHFCQUFxQixTQUFnQztBQUM1RCxRQUFNLFlBQVksZ0JBQWdCO0FBQ2xDLE1BQUksQ0FBQyxVQUFXLFFBQU87QUFDdkIsUUFBTSxhQUFhLFFBQVEsYUFBYSxVQUNwQyxDQUFDLElBQUksSUFBSSxRQUFRLElBQUksU0FBUyxLQUFLLHVCQUNsQyxNQUFNLEdBQUcsRUFDVCxPQUFPLE9BQU8sQ0FBQyxJQUNoQixDQUFDLEVBQUU7QUFDUCxhQUFXLE9BQU8sVUFBVSxNQUFNLFNBQVMsR0FBRztBQUM1QyxRQUFJLENBQUMsSUFBSztBQUNWLGVBQVcsT0FBTyxZQUFZO0FBQzVCLFlBQU0sWUFBWSxLQUFLLEtBQUssR0FBRyxPQUFPLEdBQUcsR0FBRyxFQUFFO0FBQzlDLFVBQUksV0FBVyxTQUFTLEVBQUcsUUFBTztBQUFBLElBQ3BDO0FBQUEsRUFDRjtBQUNBLFNBQU87QUFDVDtBQUVBLFNBQVMsZ0JBQWdCLE1BQXlCLFFBQVEsS0FBYTtBQUNy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
