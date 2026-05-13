import { execSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { EventEmitter } from "node:events";
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
class SessionManager extends EventEmitter {
  constructor(logger) {
    super();
    this.logger = logger;
  }
  /** Sessions keyed by resolved projectDir for duplicate-start prevention */
  sessions = /* @__PURE__ */ new Map();
  /**
   * Start a new GSD auto-mode session for the given project directory.
   *
   * Rejects if a session already exists for this projectDir.
   * Creates an RpcClient, starts the process, performs the v2 init handshake,
   * wires event tracking, and sends '/gsd auto' to begin execution.
   */
  async startSession(options) {
    const { projectDir } = options;
    if (!projectDir || projectDir.trim() === "") {
      throw new Error("projectDir is required and cannot be empty");
    }
    const resolvedDir = resolve(projectDir);
    const projectName = basename(resolvedDir);
    const existing = this.sessions.get(resolvedDir);
    if (existing) {
      throw new Error(
        `Session already active for ${resolvedDir} (sessionId: ${existing.sessionId}, status: ${existing.status})`
      );
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
      projectName,
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
      this.logger.info("session started", { sessionId: session.sessionId, projectDir: resolvedDir });
      this.emit("session:started", { sessionId: session.sessionId, projectDir: resolvedDir, projectName });
      return session.sessionId;
    } catch (err) {
      session.status = "error";
      session.error = err instanceof Error ? err.message : String(err);
      try {
        await client.stop();
      } catch {
      }
      this.logger.error("session error", { sessionId: session.sessionId, projectDir: resolvedDir, error: session.error });
      this.emit("session:error", { sessionId: session.sessionId, projectDir: resolvedDir, projectName, error: session.error });
      throw new Error(`Failed to start session for ${resolvedDir}: ${session.error}`);
    }
  }
  /**
   * Look up a session by sessionId.
   * Linear scan is fine — we expect <10 concurrent sessions.
   */
  getSession(sessionId) {
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
   * Return all tracked sessions (R035 — cross-project status).
   */
  getAllSessions() {
    return Array.from(this.sessions.values());
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
    this.logger.info("blocker resolved", {
      sessionId,
      projectDir: session.projectDir,
      blockerId: blocker.id,
      blockerMethod: blocker.method
    });
  }
  /**
   * Cancel a running session — abort current operation then stop the process.
   */
  async cancelSession(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
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
    this.logger.info("session cancelled", { sessionId, projectDir: session.projectDir });
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
      projectName: session.projectName,
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
   * 2. `which gsd` → resolve to the actual dist/cli.js
   */
  static resolveCLIPath() {
    const envPath = process.env["GSD_CLI_PATH"];
    if (envPath) return resolve(envPath);
    try {
      const gsdBin = execSync("which gsd", { encoding: "utf-8" }).trim();
      if (gsdBin) return resolve(gsdBin);
    } catch {
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
    this.logger.debug("session event", { sessionId: session.sessionId, type: event.type });
    this.emit("session:event", { sessionId: session.sessionId, projectDir: session.projectDir, event });
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
        this.logger.info("session blocked", {
          sessionId: session.sessionId,
          projectDir: session.projectDir,
          blockerId: session.pendingBlocker.id,
          blockerMethod: session.pendingBlocker.method
        });
        this.emit("session:blocked", {
          sessionId: session.sessionId,
          projectDir: session.projectDir,
          projectName: session.projectName,
          blocker: session.pendingBlocker
        });
      } else {
        session.status = "completed";
        session.unsubscribe?.();
        this.logger.info("session completed", { sessionId: session.sessionId, projectDir: session.projectDir });
        this.emit("session:completed", {
          sessionId: session.sessionId,
          projectDir: session.projectDir,
          projectName: session.projectName
        });
      }
      return;
    }
    if (isBlockingUIRequest(event)) {
      session.status = "blocked";
      session.pendingBlocker = extractBlocker(event);
      this.logger.info("session blocked", {
        sessionId: session.sessionId,
        projectDir: session.projectDir,
        blockerId: session.pendingBlocker.id,
        blockerMethod: session.pendingBlocker.method
      });
      this.emit("session:blocked", {
        sessionId: session.sessionId,
        projectDir: session.projectDir,
        projectName: session.projectName,
        blocker: session.pendingBlocker
      });
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvZGFlbW9uL3NyYy9zZXNzaW9uLW1hbmFnZXIudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogU2Vzc2lvbk1hbmFnZXIgXHUyMDE0IG1hbmFnZXMgUnBjQ2xpZW50IGxpZmVjeWNsZSBmb3IgZGFlbW9uLWRyaXZlbiBHU0QgZXhlY3V0aW9uLlxuICpcbiAqIEV4dGVuZHMgRXZlbnRFbWl0dGVyIHRvIGVtaXQgdHlwZWQgc2Vzc2lvbiBsaWZlY3ljbGUgZXZlbnRzLlxuICogT25lIGFjdGl2ZSBzZXNzaW9uIHBlciBwcm9qZWN0RGlyLiBUcmFja3MgZXZlbnRzIGluIGEgcmluZyBidWZmZXIsXG4gKiBkZXRlY3RzIGJsb2NrZXJzLCB0cmFja3MgdGVybWluYWwgc3RhdGUsIGFuZCBhY2N1bXVsYXRlcyBjb3N0IHVzaW5nXG4gKiB0aGUgY3VtdWxhdGl2ZS1tYXggcGF0dGVybiAoSzAwNCkuXG4gKlxuICogQWRhcHRlZCBmcm9tIHBhY2thZ2VzL21jcC1zZXJ2ZXIvc3JjL3Nlc3Npb24tbWFuYWdlci50cyB3aXRoOlxuICogLSBMb2dnZXIgaW50ZWdyYXRpb24gZm9yIHN0cnVjdHVyZWQgbG9nZ2luZ1xuICogLSBFdmVudEVtaXR0ZXIgZm9yIHNlc3Npb24gbGlmZWN5Y2xlIGV2ZW50c1xuICogLSBnZXRBbGxTZXNzaW9ucygpIGZvciBjcm9zcy1wcm9qZWN0IHN0YXR1cyAoUjAzNSlcbiAqIC0gcHJvamVjdE5hbWUgZmllbGQgb24gTWFuYWdlZFNlc3Npb25cbiAqL1xuXG5pbXBvcnQgeyBleGVjU3luYyB9IGZyb20gJ25vZGU6Y2hpbGRfcHJvY2Vzcyc7XG5pbXBvcnQgeyBiYXNlbmFtZSwgcmVzb2x2ZSB9IGZyb20gJ25vZGU6cGF0aCc7XG5pbXBvcnQgeyBFdmVudEVtaXR0ZXIgfSBmcm9tICdub2RlOmV2ZW50cyc7XG5pbXBvcnQgeyBScGNDbGllbnQgfSBmcm9tICdAZ3NkLWJ1aWxkL3JwYy1jbGllbnQnO1xuaW1wb3J0IHR5cGUgeyBScGNDb3N0VXBkYXRlRXZlbnQsIFJwY0V4dGVuc2lvblVJUmVxdWVzdCwgUnBjSW5pdFJlc3VsdCwgU2RrQWdlbnRFdmVudCB9IGZyb20gJ0Bnc2QtYnVpbGQvY29udHJhY3RzJztcbmltcG9ydCB0eXBlIHtcbiAgTWFuYWdlZFNlc3Npb24sXG4gIFN0YXJ0U2Vzc2lvbk9wdGlvbnMsXG4gIFBlbmRpbmdCbG9ja2VyLFxufSBmcm9tICcuL3R5cGVzLmpzJztcbmltcG9ydCB7IE1BWF9FVkVOVFMsIElOSVRfVElNRU9VVF9NUyB9IGZyb20gJy4vdHlwZXMuanMnO1xuaW1wb3J0IHR5cGUgeyBMb2dnZXIgfSBmcm9tICcuL2xvZ2dlci5qcyc7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gSW5saW5lZCBkZXRlY3Rpb24gbG9naWMgKGZyb20gaGVhZGxlc3MtZXZlbnRzLnRzIFx1MjAxNCBubyBpbnRlcm5hbCBwYWNrYWdlIGltcG9ydHMpXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuY29uc3QgRklSRV9BTkRfRk9SR0VUX01FVEhPRFMgPSBuZXcgU2V0KFtcbiAgJ25vdGlmeScsICdzZXRTdGF0dXMnLCAnc2V0V2lkZ2V0JywgJ3NldFRpdGxlJywgJ3NldF9lZGl0b3JfdGV4dCcsXG5dKTtcblxuY29uc3QgVEVSTUlOQUxfUFJFRklYRVMgPSBbJ2F1dG8tbW9kZSBzdG9wcGVkJywgJ3N0ZXAtbW9kZSBzdG9wcGVkJ107XG5cbmZ1bmN0aW9uIGlzVGVybWluYWxOb3RpZmljYXRpb24oZXZlbnQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogYm9vbGVhbiB7XG4gIGlmIChldmVudC50eXBlICE9PSAnZXh0ZW5zaW9uX3VpX3JlcXVlc3QnIHx8IGV2ZW50Lm1ldGhvZCAhPT0gJ25vdGlmeScpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgbWVzc2FnZSA9IFN0cmluZyhldmVudC5tZXNzYWdlID8/ICcnKS50b0xvd2VyQ2FzZSgpO1xuICByZXR1cm4gVEVSTUlOQUxfUFJFRklYRVMuc29tZSgocHJlZml4KSA9PiBtZXNzYWdlLnN0YXJ0c1dpdGgocHJlZml4KSk7XG59XG5cbmZ1bmN0aW9uIGlzQmxvY2tlZE5vdGlmaWNhdGlvbihldmVudDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBib29sZWFuIHtcbiAgaWYgKGV2ZW50LnR5cGUgIT09ICdleHRlbnNpb25fdWlfcmVxdWVzdCcgfHwgZXZlbnQubWV0aG9kICE9PSAnbm90aWZ5JykgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBtZXNzYWdlID0gU3RyaW5nKGV2ZW50Lm1lc3NhZ2UgPz8gJycpLnRvTG93ZXJDYXNlKCk7XG4gIHJldHVybiBtZXNzYWdlLmluY2x1ZGVzKCdibG9ja2VkOicpO1xufVxuXG5mdW5jdGlvbiBpc0Jsb2NraW5nVUlSZXF1ZXN0KGV2ZW50OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IGJvb2xlYW4ge1xuICBpZiAoZXZlbnQudHlwZSAhPT0gJ2V4dGVuc2lvbl91aV9yZXF1ZXN0JykgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBtZXRob2QgPSBTdHJpbmcoZXZlbnQubWV0aG9kID8/ICcnKTtcbiAgcmV0dXJuICFGSVJFX0FORF9GT1JHRVRfTUVUSE9EUy5oYXMobWV0aG9kKTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBTZXNzaW9uTWFuYWdlclxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmV4cG9ydCBjbGFzcyBTZXNzaW9uTWFuYWdlciBleHRlbmRzIEV2ZW50RW1pdHRlciB7XG4gIC8qKiBTZXNzaW9ucyBrZXllZCBieSByZXNvbHZlZCBwcm9qZWN0RGlyIGZvciBkdXBsaWNhdGUtc3RhcnQgcHJldmVudGlvbiAqL1xuICBwcml2YXRlIHNlc3Npb25zID0gbmV3IE1hcDxzdHJpbmcsIE1hbmFnZWRTZXNzaW9uPigpO1xuXG4gIGNvbnN0cnVjdG9yKHByaXZhdGUgcmVhZG9ubHkgbG9nZ2VyOiBMb2dnZXIpIHtcbiAgICBzdXBlcigpO1xuICB9XG5cbiAgLyoqXG4gICAqIFN0YXJ0IGEgbmV3IEdTRCBhdXRvLW1vZGUgc2Vzc2lvbiBmb3IgdGhlIGdpdmVuIHByb2plY3QgZGlyZWN0b3J5LlxuICAgKlxuICAgKiBSZWplY3RzIGlmIGEgc2Vzc2lvbiBhbHJlYWR5IGV4aXN0cyBmb3IgdGhpcyBwcm9qZWN0RGlyLlxuICAgKiBDcmVhdGVzIGFuIFJwY0NsaWVudCwgc3RhcnRzIHRoZSBwcm9jZXNzLCBwZXJmb3JtcyB0aGUgdjIgaW5pdCBoYW5kc2hha2UsXG4gICAqIHdpcmVzIGV2ZW50IHRyYWNraW5nLCBhbmQgc2VuZHMgJy9nc2QgYXV0bycgdG8gYmVnaW4gZXhlY3V0aW9uLlxuICAgKi9cbiAgYXN5bmMgc3RhcnRTZXNzaW9uKG9wdGlvbnM6IFN0YXJ0U2Vzc2lvbk9wdGlvbnMpOiBQcm9taXNlPHN0cmluZz4ge1xuICAgIGNvbnN0IHsgcHJvamVjdERpciB9ID0gb3B0aW9ucztcblxuICAgIGlmICghcHJvamVjdERpciB8fCBwcm9qZWN0RGlyLnRyaW0oKSA9PT0gJycpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcigncHJvamVjdERpciBpcyByZXF1aXJlZCBhbmQgY2Fubm90IGJlIGVtcHR5Jyk7XG4gICAgfVxuXG4gICAgY29uc3QgcmVzb2x2ZWREaXIgPSByZXNvbHZlKHByb2plY3REaXIpO1xuICAgIGNvbnN0IHByb2plY3ROYW1lID0gYmFzZW5hbWUocmVzb2x2ZWREaXIpO1xuXG4gICAgY29uc3QgZXhpc3RpbmcgPSB0aGlzLnNlc3Npb25zLmdldChyZXNvbHZlZERpcik7XG4gICAgaWYgKGV4aXN0aW5nKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBTZXNzaW9uIGFscmVhZHkgYWN0aXZlIGZvciAke3Jlc29sdmVkRGlyfSAoc2Vzc2lvbklkOiAke2V4aXN0aW5nLnNlc3Npb25JZH0sIHN0YXR1czogJHtleGlzdGluZy5zdGF0dXN9KWBcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3QgY2xpUGF0aCA9IG9wdGlvbnMuY2xpUGF0aCA/PyBTZXNzaW9uTWFuYWdlci5yZXNvbHZlQ0xJUGF0aCgpO1xuXG4gICAgY29uc3QgYXJnczogc3RyaW5nW10gPSBbJy0tbW9kZScsICdycGMnXTtcbiAgICBpZiAob3B0aW9ucy5tb2RlbCkgYXJncy5wdXNoKCctLW1vZGVsJywgb3B0aW9ucy5tb2RlbCk7XG4gICAgaWYgKG9wdGlvbnMuYmFyZSkgYXJncy5wdXNoKCctLWJhcmUnKTtcblxuICAgIGNvbnN0IGNsaWVudCA9IG5ldyBScGNDbGllbnQoe1xuICAgICAgY2xpUGF0aCxcbiAgICAgIGN3ZDogcmVzb2x2ZWREaXIsXG4gICAgICBhcmdzLFxuICAgIH0pO1xuXG4gICAgLy8gQnVpbGQgdGhlIHNlc3Npb24gc2hlbGwgYmVmb3JlIGFzeW5jIG9wZXJhdGlvbnMgc28gd2UgY2FuIHRyYWNrIHN0YXRlXG4gICAgY29uc3Qgc2Vzc2lvbjogTWFuYWdlZFNlc3Npb24gPSB7XG4gICAgICBzZXNzaW9uSWQ6ICcnLCAvLyBmaWxsZWQgYWZ0ZXIgaW5pdFxuICAgICAgcHJvamVjdERpcjogcmVzb2x2ZWREaXIsXG4gICAgICBwcm9qZWN0TmFtZSxcbiAgICAgIHN0YXR1czogJ3N0YXJ0aW5nJyxcbiAgICAgIGNsaWVudCxcbiAgICAgIGV2ZW50czogW10sXG4gICAgICBwZW5kaW5nQmxvY2tlcjogbnVsbCxcbiAgICAgIGNvc3Q6IHsgdG90YWxDb3N0OiAwLCB0b2tlbnM6IHsgaW5wdXQ6IDAsIG91dHB1dDogMCwgY2FjaGVSZWFkOiAwLCBjYWNoZVdyaXRlOiAwIH0gfSxcbiAgICAgIHN0YXJ0VGltZTogRGF0ZS5ub3coKSxcbiAgICB9O1xuXG4gICAgLy8gSW5zZXJ0IGludG8gbWFwIGVhcmx5IChrZXllZCBieSBkaXIpIHNvIGNvbmN1cnJlbnQgc3RhcnRzIGFyZSByZWplY3RlZFxuICAgIHRoaXMuc2Vzc2lvbnMuc2V0KHJlc29sdmVkRGlyLCBzZXNzaW9uKTtcblxuICAgIHRyeSB7XG4gICAgICAvLyBTdGFydCB0aGUgcHJvY2VzcyB3aXRoIHRpbWVvdXRcbiAgICAgIGF3YWl0IFByb21pc2UucmFjZShbXG4gICAgICAgIGNsaWVudC5zdGFydCgpLFxuICAgICAgICB0aW1lb3V0KElOSVRfVElNRU9VVF9NUywgYFJwY0NsaWVudC5zdGFydCgpIHRpbWVkIG91dCBhZnRlciAke0lOSVRfVElNRU9VVF9NU31tc2ApLFxuICAgICAgXSk7XG5cbiAgICAgIC8vIFBlcmZvcm0gdjIgaW5pdCBoYW5kc2hha2VcbiAgICAgIGNvbnN0IGluaXRSZXN1bHQ6IFJwY0luaXRSZXN1bHQgPSBhd2FpdCBQcm9taXNlLnJhY2UoW1xuICAgICAgICBjbGllbnQuaW5pdCgpLFxuICAgICAgICB0aW1lb3V0KElOSVRfVElNRU9VVF9NUywgYFJwY0NsaWVudC5pbml0KCkgdGltZWQgb3V0IGFmdGVyICR7SU5JVF9USU1FT1VUX01TfW1zYCksXG4gICAgICBdKSBhcyBScGNJbml0UmVzdWx0O1xuXG4gICAgICBzZXNzaW9uLnNlc3Npb25JZCA9IGluaXRSZXN1bHQuc2Vzc2lvbklkO1xuICAgICAgc2Vzc2lvbi5zdGF0dXMgPSAncnVubmluZyc7XG5cbiAgICAgIC8vIFdpcmUgZXZlbnQgdHJhY2tpbmdcbiAgICAgIHNlc3Npb24udW5zdWJzY3JpYmUgPSBjbGllbnQub25FdmVudCgoZXZlbnQ6IFNka0FnZW50RXZlbnQpID0+IHtcbiAgICAgICAgdGhpcy5oYW5kbGVFdmVudChzZXNzaW9uLCBldmVudCk7XG4gICAgICB9KTtcblxuICAgICAgLy8gS2ljayBvZmYgYXV0by1tb2RlXG4gICAgICBjb25zdCBjb21tYW5kID0gb3B0aW9ucy5jb21tYW5kID8/ICcvZ3NkIGF1dG8nO1xuICAgICAgYXdhaXQgY2xpZW50LnByb21wdChjb21tYW5kKTtcblxuICAgICAgdGhpcy5sb2dnZXIuaW5mbygnc2Vzc2lvbiBzdGFydGVkJywgeyBzZXNzaW9uSWQ6IHNlc3Npb24uc2Vzc2lvbklkLCBwcm9qZWN0RGlyOiByZXNvbHZlZERpciB9KTtcbiAgICAgIHRoaXMuZW1pdCgnc2Vzc2lvbjpzdGFydGVkJywgeyBzZXNzaW9uSWQ6IHNlc3Npb24uc2Vzc2lvbklkLCBwcm9qZWN0RGlyOiByZXNvbHZlZERpciwgcHJvamVjdE5hbWUgfSk7XG5cbiAgICAgIHJldHVybiBzZXNzaW9uLnNlc3Npb25JZDtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHNlc3Npb24uc3RhdHVzID0gJ2Vycm9yJztcbiAgICAgIHNlc3Npb24uZXJyb3IgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG5cbiAgICAgIC8vIEF0dGVtcHQgY2xlYW51cFxuICAgICAgdHJ5IHsgYXdhaXQgY2xpZW50LnN0b3AoKTsgfSBjYXRjaCB7IC8qIHN3YWxsb3cgY2xlYW51cCBlcnJvcnMgKi8gfVxuXG4gICAgICB0aGlzLmxvZ2dlci5lcnJvcignc2Vzc2lvbiBlcnJvcicsIHsgc2Vzc2lvbklkOiBzZXNzaW9uLnNlc3Npb25JZCwgcHJvamVjdERpcjogcmVzb2x2ZWREaXIsIGVycm9yOiBzZXNzaW9uLmVycm9yIH0pO1xuICAgICAgdGhpcy5lbWl0KCdzZXNzaW9uOmVycm9yJywgeyBzZXNzaW9uSWQ6IHNlc3Npb24uc2Vzc2lvbklkLCBwcm9qZWN0RGlyOiByZXNvbHZlZERpciwgcHJvamVjdE5hbWUsIGVycm9yOiBzZXNzaW9uLmVycm9yIH0pO1xuXG4gICAgICAvLyBLZWVwIHNlc3Npb24gaW4gbWFwIHNvIGNhbGxlcnMgY2FuIGluc3BlY3QgdGhlIGVycm9yXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEZhaWxlZCB0byBzdGFydCBzZXNzaW9uIGZvciAke3Jlc29sdmVkRGlyfTogJHtzZXNzaW9uLmVycm9yfWApO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBMb29rIHVwIGEgc2Vzc2lvbiBieSBzZXNzaW9uSWQuXG4gICAqIExpbmVhciBzY2FuIGlzIGZpbmUgXHUyMDE0IHdlIGV4cGVjdCA8MTAgY29uY3VycmVudCBzZXNzaW9ucy5cbiAgICovXG4gIGdldFNlc3Npb24oc2Vzc2lvbklkOiBzdHJpbmcpOiBNYW5hZ2VkU2Vzc2lvbiB8IHVuZGVmaW5lZCB7XG4gICAgZm9yIChjb25zdCBzZXNzaW9uIG9mIHRoaXMuc2Vzc2lvbnMudmFsdWVzKCkpIHtcbiAgICAgIGlmIChzZXNzaW9uLnNlc3Npb25JZCA9PT0gc2Vzc2lvbklkKSByZXR1cm4gc2Vzc2lvbjtcbiAgICB9XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuXG4gIC8qKlxuICAgKiBMb29rIHVwIGEgc2Vzc2lvbiBieSBwcm9qZWN0IGRpcmVjdG9yeSAoZGlyZWN0IG1hcCBsb29rdXApLlxuICAgKi9cbiAgZ2V0U2Vzc2lvbkJ5RGlyKHByb2plY3REaXI6IHN0cmluZyk6IE1hbmFnZWRTZXNzaW9uIHwgdW5kZWZpbmVkIHtcbiAgICByZXR1cm4gdGhpcy5zZXNzaW9ucy5nZXQocmVzb2x2ZShwcm9qZWN0RGlyKSk7XG4gIH1cblxuICAvKipcbiAgICogUmV0dXJuIGFsbCB0cmFja2VkIHNlc3Npb25zIChSMDM1IFx1MjAxNCBjcm9zcy1wcm9qZWN0IHN0YXR1cykuXG4gICAqL1xuICBnZXRBbGxTZXNzaW9ucygpOiBNYW5hZ2VkU2Vzc2lvbltdIHtcbiAgICByZXR1cm4gQXJyYXkuZnJvbSh0aGlzLnNlc3Npb25zLnZhbHVlcygpKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXNvbHZlIGEgcGVuZGluZyBibG9ja2VyIGJ5IHNlbmRpbmcgYSBVSSByZXNwb25zZS5cbiAgICovXG4gIGFzeW5jIHJlc29sdmVCbG9ja2VyKHNlc3Npb25JZDogc3RyaW5nLCByZXNwb25zZTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3Qgc2Vzc2lvbiA9IHRoaXMuZ2V0U2Vzc2lvbihzZXNzaW9uSWQpO1xuICAgIGlmICghc2Vzc2lvbikgdGhyb3cgbmV3IEVycm9yKGBTZXNzaW9uIG5vdCBmb3VuZDogJHtzZXNzaW9uSWR9YCk7XG4gICAgaWYgKCFzZXNzaW9uLnBlbmRpbmdCbG9ja2VyKSB0aHJvdyBuZXcgRXJyb3IoYE5vIHBlbmRpbmcgYmxvY2tlciBmb3Igc2Vzc2lvbiAke3Nlc3Npb25JZH1gKTtcblxuICAgIGNvbnN0IGJsb2NrZXIgPSBzZXNzaW9uLnBlbmRpbmdCbG9ja2VyO1xuICAgIHNlc3Npb24uY2xpZW50LnNlbmRVSVJlc3BvbnNlKGJsb2NrZXIuaWQsIHsgdmFsdWU6IHJlc3BvbnNlIH0pO1xuICAgIHNlc3Npb24ucGVuZGluZ0Jsb2NrZXIgPSBudWxsO1xuICAgIGlmIChzZXNzaW9uLnN0YXR1cyA9PT0gJ2Jsb2NrZWQnKSB7XG4gICAgICBzZXNzaW9uLnN0YXR1cyA9ICdydW5uaW5nJztcbiAgICB9XG5cbiAgICB0aGlzLmxvZ2dlci5pbmZvKCdibG9ja2VyIHJlc29sdmVkJywge1xuICAgICAgc2Vzc2lvbklkLFxuICAgICAgcHJvamVjdERpcjogc2Vzc2lvbi5wcm9qZWN0RGlyLFxuICAgICAgYmxvY2tlcklkOiBibG9ja2VyLmlkLFxuICAgICAgYmxvY2tlck1ldGhvZDogYmxvY2tlci5tZXRob2QsXG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogQ2FuY2VsIGEgcnVubmluZyBzZXNzaW9uIFx1MjAxNCBhYm9ydCBjdXJyZW50IG9wZXJhdGlvbiB0aGVuIHN0b3AgdGhlIHByb2Nlc3MuXG4gICAqL1xuICBhc3luYyBjYW5jZWxTZXNzaW9uKHNlc3Npb25JZDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3Qgc2Vzc2lvbiA9IHRoaXMuZ2V0U2Vzc2lvbihzZXNzaW9uSWQpO1xuICAgIGlmICghc2Vzc2lvbikgdGhyb3cgbmV3IEVycm9yKGBTZXNzaW9uIG5vdCBmb3VuZDogJHtzZXNzaW9uSWR9YCk7XG5cbiAgICB0cnkge1xuICAgICAgYXdhaXQgc2Vzc2lvbi5jbGllbnQuYWJvcnQoKTtcbiAgICB9IGNhdGNoIHsgLyogbWF5IGFscmVhZHkgYmUgc3RvcHBlZCAqLyB9XG5cbiAgICB0cnkge1xuICAgICAgYXdhaXQgc2Vzc2lvbi5jbGllbnQuc3RvcCgpO1xuICAgIH0gY2F0Y2ggeyAvKiBzd2FsbG93ICovIH1cblxuICAgIHNlc3Npb24uc3RhdHVzID0gJ2NhbmNlbGxlZCc7XG4gICAgc2Vzc2lvbi51bnN1YnNjcmliZT8uKCk7XG5cbiAgICB0aGlzLmxvZ2dlci5pbmZvKCdzZXNzaW9uIGNhbmNlbGxlZCcsIHsgc2Vzc2lvbklkLCBwcm9qZWN0RGlyOiBzZXNzaW9uLnByb2plY3REaXIgfSk7XG4gIH1cblxuICAvKipcbiAgICogQnVpbGQgYSBIZWFkbGVzc0pzb25SZXN1bHQtc2hhcGVkIG9iamVjdCBmcm9tIGFjY3VtdWxhdGVkIHNlc3Npb24gc3RhdGUuXG4gICAqL1xuICBnZXRSZXN1bHQoc2Vzc2lvbklkOiBzdHJpbmcpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgY29uc3Qgc2Vzc2lvbiA9IHRoaXMuZ2V0U2Vzc2lvbihzZXNzaW9uSWQpO1xuICAgIGlmICghc2Vzc2lvbikgdGhyb3cgbmV3IEVycm9yKGBTZXNzaW9uIG5vdCBmb3VuZDogJHtzZXNzaW9uSWR9YCk7XG5cbiAgICBjb25zdCBkdXJhdGlvbk1zID0gRGF0ZS5ub3coKSAtIHNlc3Npb24uc3RhcnRUaW1lO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgIHNlc3Npb25JZDogc2Vzc2lvbi5zZXNzaW9uSWQsXG4gICAgICBwcm9qZWN0RGlyOiBzZXNzaW9uLnByb2plY3REaXIsXG4gICAgICBwcm9qZWN0TmFtZTogc2Vzc2lvbi5wcm9qZWN0TmFtZSxcbiAgICAgIHN0YXR1czogc2Vzc2lvbi5zdGF0dXMsXG4gICAgICBkdXJhdGlvbk1zLFxuICAgICAgY29zdDogc2Vzc2lvbi5jb3N0LFxuICAgICAgcmVjZW50RXZlbnRzOiBzZXNzaW9uLmV2ZW50cy5zbGljZSgtMTApLFxuICAgICAgcGVuZGluZ0Jsb2NrZXI6IHNlc3Npb24ucGVuZGluZ0Jsb2NrZXJcbiAgICAgICAgPyB7IGlkOiBzZXNzaW9uLnBlbmRpbmdCbG9ja2VyLmlkLCBtZXRob2Q6IHNlc3Npb24ucGVuZGluZ0Jsb2NrZXIubWV0aG9kLCBtZXNzYWdlOiBzZXNzaW9uLnBlbmRpbmdCbG9ja2VyLm1lc3NhZ2UgfVxuICAgICAgICA6IG51bGwsXG4gICAgICBlcnJvcjogc2Vzc2lvbi5lcnJvciA/PyBudWxsLFxuICAgIH07XG4gIH1cblxuICAvKipcbiAgICogU3RvcCBhbGwgYWN0aXZlIHNlc3Npb25zIGFuZCBjbGVhbiB1cCByZXNvdXJjZXMuXG4gICAqL1xuICBhc3luYyBjbGVhbnVwKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IHN0b3BQcm9taXNlczogUHJvbWlzZTx2b2lkPltdID0gW107XG5cbiAgICBmb3IgKGNvbnN0IHNlc3Npb24gb2YgdGhpcy5zZXNzaW9ucy52YWx1ZXMoKSkge1xuICAgICAgc2Vzc2lvbi51bnN1YnNjcmliZT8uKCk7XG4gICAgICBpZiAoc2Vzc2lvbi5zdGF0dXMgPT09ICdydW5uaW5nJyB8fCBzZXNzaW9uLnN0YXR1cyA9PT0gJ3N0YXJ0aW5nJyB8fCBzZXNzaW9uLnN0YXR1cyA9PT0gJ2Jsb2NrZWQnKSB7XG4gICAgICAgIHN0b3BQcm9taXNlcy5wdXNoKFxuICAgICAgICAgIHNlc3Npb24uY2xpZW50LnN0b3AoKS5jYXRjaCgoKSA9PiB7IC8qIHN3YWxsb3cgKi8gfSlcbiAgICAgICAgKTtcbiAgICAgICAgc2Vzc2lvbi5zdGF0dXMgPSAnY2FuY2VsbGVkJztcbiAgICAgIH1cbiAgICB9XG5cbiAgICBhd2FpdCBQcm9taXNlLmFsbFNldHRsZWQoc3RvcFByb21pc2VzKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXNvbHZlIHRoZSBHU0QgQ0xJIHBhdGguXG4gICAqXG4gICAqIDEuIEdTRF9DTElfUEFUSCBlbnYgdmFyIChoaWdoZXN0IHByaW9yaXR5KVxuICAgKiAyLiBgd2hpY2ggZ3NkYCBcdTIxOTIgcmVzb2x2ZSB0byB0aGUgYWN0dWFsIGRpc3QvY2xpLmpzXG4gICAqL1xuICBzdGF0aWMgcmVzb2x2ZUNMSVBhdGgoKTogc3RyaW5nIHtcbiAgICBjb25zdCBlbnZQYXRoID0gcHJvY2Vzcy5lbnZbJ0dTRF9DTElfUEFUSCddO1xuICAgIGlmIChlbnZQYXRoKSByZXR1cm4gcmVzb2x2ZShlbnZQYXRoKTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCBnc2RCaW4gPSBleGVjU3luYygnd2hpY2ggZ3NkJywgeyBlbmNvZGluZzogJ3V0Zi04JyB9KS50cmltKCk7XG4gICAgICBpZiAoZ3NkQmluKSByZXR1cm4gcmVzb2x2ZShnc2RCaW4pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gd2hpY2ggZmFpbGVkXG4gICAgfVxuXG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgJ0Nhbm5vdCBmaW5kIEdTRCBDTEkuIFNldCBHU0RfQ0xJX1BBVEggZW52aXJvbm1lbnQgdmFyaWFibGUgb3IgZW5zdXJlIGBnc2RgIGlzIGluIFBBVEguJ1xuICAgICk7XG4gIH1cblxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgLy8gUHJpdmF0ZTogRXZlbnQgSGFuZGxpbmdcbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgcHJpdmF0ZSBoYW5kbGVFdmVudChzZXNzaW9uOiBNYW5hZ2VkU2Vzc2lvbiwgZXZlbnQ6IFNka0FnZW50RXZlbnQpOiB2b2lkIHtcbiAgICAvLyBSaW5nIGJ1ZmZlcjogcHVzaCBhbmQgdHJpbVxuICAgIHNlc3Npb24uZXZlbnRzLnB1c2goZXZlbnQpO1xuICAgIGlmIChzZXNzaW9uLmV2ZW50cy5sZW5ndGggPiBNQVhfRVZFTlRTKSB7XG4gICAgICBzZXNzaW9uLmV2ZW50cy5zcGxpY2UoMCwgc2Vzc2lvbi5ldmVudHMubGVuZ3RoIC0gTUFYX0VWRU5UUyk7XG4gICAgfVxuXG4gICAgLy8gRm9yd2FyZCBldmVudCB0byBsaXN0ZW5lcnNcbiAgICB0aGlzLmxvZ2dlci5kZWJ1Zygnc2Vzc2lvbiBldmVudCcsIHsgc2Vzc2lvbklkOiBzZXNzaW9uLnNlc3Npb25JZCwgdHlwZTogKGV2ZW50IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KS50eXBlIGFzIHN0cmluZyB9KTtcbiAgICB0aGlzLmVtaXQoJ3Nlc3Npb246ZXZlbnQnLCB7IHNlc3Npb25JZDogc2Vzc2lvbi5zZXNzaW9uSWQsIHByb2plY3REaXI6IHNlc3Npb24ucHJvamVjdERpciwgZXZlbnQgfSk7XG5cbiAgICAvLyBDb3N0IHRyYWNraW5nIChLMDA0IFx1MjAxNCBjdW11bGF0aXZlLW1heClcbiAgICBpZiAoKGV2ZW50IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KS50eXBlID09PSAnY29zdF91cGRhdGUnKSB7XG4gICAgICBjb25zdCBjb3N0RXZlbnQgPSBldmVudCBhcyB1bmtub3duIGFzIFJwY0Nvc3RVcGRhdGVFdmVudDtcbiAgICAgIHNlc3Npb24uY29zdC50b3RhbENvc3QgPSBNYXRoLm1heChzZXNzaW9uLmNvc3QudG90YWxDb3N0LCBjb3N0RXZlbnQuY3VtdWxhdGl2ZUNvc3QgPz8gMCk7XG4gICAgICBpZiAoY29zdEV2ZW50LnRva2Vucykge1xuICAgICAgICBzZXNzaW9uLmNvc3QudG9rZW5zLmlucHV0ID0gTWF0aC5tYXgoc2Vzc2lvbi5jb3N0LnRva2Vucy5pbnB1dCwgY29zdEV2ZW50LnRva2Vucy5pbnB1dCA/PyAwKTtcbiAgICAgICAgc2Vzc2lvbi5jb3N0LnRva2Vucy5vdXRwdXQgPSBNYXRoLm1heChzZXNzaW9uLmNvc3QudG9rZW5zLm91dHB1dCwgY29zdEV2ZW50LnRva2Vucy5vdXRwdXQgPz8gMCk7XG4gICAgICAgIHNlc3Npb24uY29zdC50b2tlbnMuY2FjaGVSZWFkID0gTWF0aC5tYXgoc2Vzc2lvbi5jb3N0LnRva2Vucy5jYWNoZVJlYWQsIGNvc3RFdmVudC50b2tlbnMuY2FjaGVSZWFkID8/IDApO1xuICAgICAgICBzZXNzaW9uLmNvc3QudG9rZW5zLmNhY2hlV3JpdGUgPSBNYXRoLm1heChzZXNzaW9uLmNvc3QudG9rZW5zLmNhY2hlV3JpdGUsIGNvc3RFdmVudC50b2tlbnMuY2FjaGVXcml0ZSA/PyAwKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBUZXJtaW5hbCBkZXRlY3Rpb24gXHUyMDE0IGF1dG8tbW9kZS9zdGVwLW1vZGUgc3RvcHBlZFxuICAgIGlmIChpc1Rlcm1pbmFsTm90aWZpY2F0aW9uKGV2ZW50IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSkge1xuICAgICAgaWYgKGlzQmxvY2tlZE5vdGlmaWNhdGlvbihldmVudCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikpIHtcbiAgICAgICAgc2Vzc2lvbi5zdGF0dXMgPSAnYmxvY2tlZCc7XG4gICAgICAgIHNlc3Npb24ucGVuZGluZ0Jsb2NrZXIgPSBleHRyYWN0QmxvY2tlcihldmVudCk7XG4gICAgICAgIHRoaXMubG9nZ2VyLmluZm8oJ3Nlc3Npb24gYmxvY2tlZCcsIHtcbiAgICAgICAgICBzZXNzaW9uSWQ6IHNlc3Npb24uc2Vzc2lvbklkLFxuICAgICAgICAgIHByb2plY3REaXI6IHNlc3Npb24ucHJvamVjdERpcixcbiAgICAgICAgICBibG9ja2VySWQ6IHNlc3Npb24ucGVuZGluZ0Jsb2NrZXIuaWQsXG4gICAgICAgICAgYmxvY2tlck1ldGhvZDogc2Vzc2lvbi5wZW5kaW5nQmxvY2tlci5tZXRob2QsXG4gICAgICAgIH0pO1xuICAgICAgICB0aGlzLmVtaXQoJ3Nlc3Npb246YmxvY2tlZCcsIHtcbiAgICAgICAgICBzZXNzaW9uSWQ6IHNlc3Npb24uc2Vzc2lvbklkLFxuICAgICAgICAgIHByb2plY3REaXI6IHNlc3Npb24ucHJvamVjdERpcixcbiAgICAgICAgICBwcm9qZWN0TmFtZTogc2Vzc2lvbi5wcm9qZWN0TmFtZSxcbiAgICAgICAgICBibG9ja2VyOiBzZXNzaW9uLnBlbmRpbmdCbG9ja2VyLFxuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHNlc3Npb24uc3RhdHVzID0gJ2NvbXBsZXRlZCc7XG4gICAgICAgIHNlc3Npb24udW5zdWJzY3JpYmU/LigpO1xuICAgICAgICB0aGlzLmxvZ2dlci5pbmZvKCdzZXNzaW9uIGNvbXBsZXRlZCcsIHsgc2Vzc2lvbklkOiBzZXNzaW9uLnNlc3Npb25JZCwgcHJvamVjdERpcjogc2Vzc2lvbi5wcm9qZWN0RGlyIH0pO1xuICAgICAgICB0aGlzLmVtaXQoJ3Nlc3Npb246Y29tcGxldGVkJywge1xuICAgICAgICAgIHNlc3Npb25JZDogc2Vzc2lvbi5zZXNzaW9uSWQsXG4gICAgICAgICAgcHJvamVjdERpcjogc2Vzc2lvbi5wcm9qZWN0RGlyLFxuICAgICAgICAgIHByb2plY3ROYW1lOiBzZXNzaW9uLnByb2plY3ROYW1lLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBCbG9ja2VyIGRldGVjdGlvbiBcdTIwMTQgbm9uLWZpcmUtYW5kLWZvcmdldCBleHRlbnNpb25fdWlfcmVxdWVzdFxuICAgIGlmIChpc0Jsb2NraW5nVUlSZXF1ZXN0KGV2ZW50IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSkge1xuICAgICAgc2Vzc2lvbi5zdGF0dXMgPSAnYmxvY2tlZCc7XG4gICAgICBzZXNzaW9uLnBlbmRpbmdCbG9ja2VyID0gZXh0cmFjdEJsb2NrZXIoZXZlbnQpO1xuICAgICAgdGhpcy5sb2dnZXIuaW5mbygnc2Vzc2lvbiBibG9ja2VkJywge1xuICAgICAgICBzZXNzaW9uSWQ6IHNlc3Npb24uc2Vzc2lvbklkLFxuICAgICAgICBwcm9qZWN0RGlyOiBzZXNzaW9uLnByb2plY3REaXIsXG4gICAgICAgIGJsb2NrZXJJZDogc2Vzc2lvbi5wZW5kaW5nQmxvY2tlci5pZCxcbiAgICAgICAgYmxvY2tlck1ldGhvZDogc2Vzc2lvbi5wZW5kaW5nQmxvY2tlci5tZXRob2QsXG4gICAgICB9KTtcbiAgICAgIHRoaXMuZW1pdCgnc2Vzc2lvbjpibG9ja2VkJywge1xuICAgICAgICBzZXNzaW9uSWQ6IHNlc3Npb24uc2Vzc2lvbklkLFxuICAgICAgICBwcm9qZWN0RGlyOiBzZXNzaW9uLnByb2plY3REaXIsXG4gICAgICAgIHByb2plY3ROYW1lOiBzZXNzaW9uLnByb2plY3ROYW1lLFxuICAgICAgICBibG9ja2VyOiBzZXNzaW9uLnBlbmRpbmdCbG9ja2VyLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gSGVscGVyc1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmZ1bmN0aW9uIHRpbWVvdXQobXM6IG51bWJlciwgbWVzc2FnZTogc3RyaW5nKTogUHJvbWlzZTxuZXZlcj4ge1xuICByZXR1cm4gbmV3IFByb21pc2UoKF8sIHJlamVjdCkgPT4ge1xuICAgIHNldFRpbWVvdXQoKCkgPT4gcmVqZWN0KG5ldyBFcnJvcihtZXNzYWdlKSksIG1zKTtcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGV4dHJhY3RCbG9ja2VyKGV2ZW50OiBTZGtBZ2VudEV2ZW50KTogUGVuZGluZ0Jsb2NrZXIge1xuICBjb25zdCB1aUV2ZW50ID0gZXZlbnQgYXMgdW5rbm93biBhcyBScGNFeHRlbnNpb25VSVJlcXVlc3Q7XG4gIHJldHVybiB7XG4gICAgaWQ6IFN0cmluZyh1aUV2ZW50LmlkID8/ICcnKSxcbiAgICBtZXRob2Q6IHVpRXZlbnQubWV0aG9kLFxuICAgIG1lc3NhZ2U6IFN0cmluZygodWlFdmVudCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikudGl0bGUgPz8gKHVpRXZlbnQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pLm1lc3NhZ2UgPz8gJycpLFxuICAgIGV2ZW50OiB1aUV2ZW50LFxuICB9O1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBZUEsU0FBUyxnQkFBZ0I7QUFDekIsU0FBUyxVQUFVLGVBQWU7QUFDbEMsU0FBUyxvQkFBb0I7QUFDN0IsU0FBUyxpQkFBaUI7QUFPMUIsU0FBUyxZQUFZLHVCQUF1QjtBQU81QyxNQUFNLDBCQUEwQixvQkFBSSxJQUFJO0FBQUEsRUFDdEM7QUFBQSxFQUFVO0FBQUEsRUFBYTtBQUFBLEVBQWE7QUFBQSxFQUFZO0FBQ2xELENBQUM7QUFFRCxNQUFNLG9CQUFvQixDQUFDLHFCQUFxQixtQkFBbUI7QUFFbkUsU0FBUyx1QkFBdUIsT0FBeUM7QUFDdkUsTUFBSSxNQUFNLFNBQVMsMEJBQTBCLE1BQU0sV0FBVyxTQUFVLFFBQU87QUFDL0UsUUFBTSxVQUFVLE9BQU8sTUFBTSxXQUFXLEVBQUUsRUFBRSxZQUFZO0FBQ3hELFNBQU8sa0JBQWtCLEtBQUssQ0FBQyxXQUFXLFFBQVEsV0FBVyxNQUFNLENBQUM7QUFDdEU7QUFFQSxTQUFTLHNCQUFzQixPQUF5QztBQUN0RSxNQUFJLE1BQU0sU0FBUywwQkFBMEIsTUFBTSxXQUFXLFNBQVUsUUFBTztBQUMvRSxRQUFNLFVBQVUsT0FBTyxNQUFNLFdBQVcsRUFBRSxFQUFFLFlBQVk7QUFDeEQsU0FBTyxRQUFRLFNBQVMsVUFBVTtBQUNwQztBQUVBLFNBQVMsb0JBQW9CLE9BQXlDO0FBQ3BFLE1BQUksTUFBTSxTQUFTLHVCQUF3QixRQUFPO0FBQ2xELFFBQU0sU0FBUyxPQUFPLE1BQU0s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
