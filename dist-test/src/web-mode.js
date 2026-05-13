import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appRoot, webPidFilePath as defaultWebPidFilePath } from "./app-paths.js";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function openBrowser(url) {
  if (process.platform === "win32") {
    execFile("powershell", ["-c", `Start-Process '${url.replace(/'/g, "''")}'`], { windowsHide: true }, () => {
    });
  } else {
    const cmd = process.platform === "darwin" ? "open" : "xdg-open";
    execFile(cmd, [url], () => {
    });
  }
}
const WEB_INSTANCES_PATH = join(appRoot, "web-instances.json");
function readInstanceRegistry(registryPath = WEB_INSTANCES_PATH) {
  try {
    return JSON.parse(readFileSync(registryPath, "utf8"));
  } catch {
    return {};
  }
}
function writeInstanceRegistry(registry, registryPath = WEB_INSTANCES_PATH) {
  writeFileSync(registryPath, JSON.stringify(registry, null, 2), "utf8");
}
function registerInstance(cwd, entry, registryPath = WEB_INSTANCES_PATH) {
  const registry = readInstanceRegistry(registryPath);
  registry[resolve(cwd)] = {
    ...entry,
    cwd: resolve(cwd),
    startedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  writeInstanceRegistry(registry, registryPath);
}
function unregisterInstance(cwd, registryPath = WEB_INSTANCES_PATH) {
  const registry = readInstanceRegistry(registryPath);
  delete registry[resolve(cwd)];
  writeInstanceRegistry(registry, registryPath);
}
function killPid(pid) {
  try {
    process.kill(pid, "SIGTERM");
    return "killed";
  } catch (error) {
    const isAlreadyDead = error instanceof Error && "code" in error && error.code === "ESRCH";
    if (isAlreadyDead) return "already-dead";
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
function writePidFile(filePath, pid) {
  writeFileSync(filePath, String(pid), "utf8");
}
function readPidFile(filePath) {
  try {
    const content = readFileSync(filePath, "utf8").trim();
    const pid = parseInt(content, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
function deletePidFile(filePath) {
  try {
    unlinkSync(filePath);
  } catch {
  }
}
function stopWebMode(deps = {}, options = {}) {
  const stderr = deps.stderr ?? process.stderr;
  if (options.all) {
    const registry = readInstanceRegistry();
    const entries = Object.entries(registry);
    if (entries.length === 0) {
      return stopLegacyPidFile(deps);
    }
    let stopped = 0;
    for (const [cwd, entry] of entries) {
      const result = killPid(entry.pid);
      if (result === "killed") {
        stderr.write(`[gsd] Stopped web server for ${cwd} (pid=${entry.pid})
`);
        stopped++;
      } else if (result === "already-dead") {
        stderr.write(`[gsd] Web server for ${cwd} was already stopped (pid=${entry.pid})
`);
        stopped++;
      } else {
        stderr.write(`[gsd] Failed to stop web server for ${cwd}: ${result.error}
`);
      }
      unregisterInstance(cwd);
    }
    const deletePid = deps.deletePidFile ?? deletePidFile;
    const pidFilePath = deps.pidFilePath ?? defaultWebPidFilePath;
    deletePid(pidFilePath);
    stderr.write(`[gsd] Stopped ${stopped} instance${stopped === 1 ? "" : "s"}.
`);
    return { ok: true, stoppedCount: stopped };
  }
  if (options.projectCwd) {
    const resolvedCwd = resolve(options.projectCwd);
    const registry = readInstanceRegistry();
    const entry = registry[resolvedCwd];
    if (!entry) {
      stderr.write(`[gsd] No web server running for ${resolvedCwd}
`);
      return { ok: false, reason: "not-found" };
    }
    const result = killPid(entry.pid);
    unregisterInstance(resolvedCwd);
    if (result === "killed") {
      stderr.write(`[gsd] Stopped web server for ${resolvedCwd} (pid=${entry.pid})
`);
      return { ok: true, stoppedCount: 1 };
    } else if (result === "already-dead") {
      stderr.write(`[gsd] Web server for ${resolvedCwd} was already stopped \u2014 cleared stale entry.
`);
      return { ok: true, stoppedCount: 1 };
    } else {
      stderr.write(`[gsd] Failed to stop web server for ${resolvedCwd}: ${result.error}
`);
      return { ok: false, reason: result.error };
    }
  }
  return stopLegacyPidFile(deps);
}
function stopLegacyPidFile(deps) {
  const stderr = deps.stderr ?? process.stderr;
  const pidFilePath = deps.pidFilePath ?? defaultWebPidFilePath;
  const readPid = deps.readPidFile ?? readPidFile;
  const deletePid = deps.deletePidFile ?? deletePidFile;
  const pid = readPid(pidFilePath);
  if (pid === null) {
    stderr.write(`[gsd] Web server is not running (no PID file found)
`);
    return { ok: false, reason: "no-pid-file" };
  }
  stderr.write(`[gsd] Stopping web server (pid=${pid})\u2026
`);
  const result = killPid(pid);
  deletePid(pidFilePath);
  if (result === "killed") {
    stderr.write(`[gsd] Web server stopped.
`);
    return { ok: true };
  } else if (result === "already-dead") {
    stderr.write(`[gsd] Web server was already stopped \u2014 cleared stale PID file.
`);
    return { ok: true };
  } else {
    stderr.write(`[gsd] Failed to stop web server: ${result.error}
`);
    return { ok: false, reason: result.error };
  }
}
async function loadResourceBootstrap() {
  const mod = await import("./resource-loader.js");
  return {
    initResources: mod.initResources
  };
}
function resolveWebHostBootstrap(options = {}) {
  const packageRoot = options.packageRoot ?? DEFAULT_PACKAGE_ROOT;
  const checkExists = options.existsSync ?? existsSync;
  const packagedStandaloneServer = join(packageRoot, "dist", "web", "standalone", "server.js");
  if (checkExists(packagedStandaloneServer)) {
    return {
      ok: true,
      kind: "packaged-standalone",
      packageRoot,
      hostRoot: join(packageRoot, "dist", "web", "standalone"),
      entryPath: packagedStandaloneServer
    };
  }
  const sourceWebRoot = join(packageRoot, "web");
  const sourceManifest = join(sourceWebRoot, "package.json");
  if (checkExists(sourceManifest)) {
    return {
      ok: true,
      kind: "source-dev",
      packageRoot,
      hostRoot: sourceWebRoot,
      entryPath: sourceManifest
    };
  }
  return {
    ok: false,
    packageRoot,
    reason: "host bootstrap not found",
    candidates: [packagedStandaloneServer, sourceManifest]
  };
}
async function reserveWebPort(host = DEFAULT_HOST) {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to determine reserved web port")));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePort(address.port);
      });
    });
  });
}
function getSpawnCommandForSourceHost(platform) {
  return platform === "win32" ? "npm.cmd" : "npm";
}
function needsWindowsShell(command, platform) {
  return platform === "win32" && /\.(cmd|bat)$/i.test(command);
}
function formatLaunchStatus(status) {
  if (status.ok) {
    return `[gsd] Web mode startup: status=started cwd=${status.cwd} port=${status.port} host=${status.hostPath} kind=${status.hostKind} url=${status.url}
`;
  }
  return `[gsd] Web mode startup: status=failed cwd=${status.cwd} port=${status.port ?? "n/a"} host=${status.hostPath ?? "unresolved"} kind=${status.hostKind} reason=${status.failureReason}
`;
}
function emitLaunchStatus(stderr, status) {
  stderr.write(formatLaunchStatus(status));
}
function buildSpawnSpec(resolution, host, port, platform, execPath) {
  if (resolution.kind === "packaged-standalone") {
    return {
      command: execPath,
      args: [resolution.entryPath],
      cwd: resolution.hostRoot
    };
  }
  return {
    command: getSpawnCommandForSourceHost(platform),
    args: ["run", "dev", "--", "--hostname", host, "--port", String(port)],
    cwd: resolution.hostRoot
  };
}
async function spawnDetachedProcess(spawnCommand, command, args, options) {
  return await new Promise((resolve2) => {
    try {
      const child = spawnCommand(command, args, options);
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve2(result);
      };
      child.once?.("error", (error) => finish({ ok: false, error }));
      setImmediate(() => finish({ ok: true, child }));
    } catch (error) {
      resolve2({ ok: false, error });
    }
  });
}
async function requestLocalJson(url, timeoutMs, authToken) {
  return await new Promise((resolve2, reject) => {
    const headers = {
      Accept: "application/json",
      // Keep launch readiness on the cheapest uncompressed path. The
      // packaged host can spend noticeable time compressing the large boot
      // snapshot, which adds avoidable startup jitter for a local health
      // check that only needs the JSON payload itself.
      "Accept-Encoding": "identity"
    };
    if (authToken) {
      headers["Authorization"] = `Bearer ${authToken}`;
    }
    const request = httpRequest(
      url,
      {
        method: "GET",
        headers
      },
      (response) => {
        const statusCode = response.statusCode ?? 0;
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => resolve2({ statusCode, body }));
      }
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`request timed out after ${timeoutMs}ms`));
    });
    request.once("error", reject);
    request.end();
  });
}
async function waitForBootReady(url, timeoutMs = 18e4, stderr, authToken) {
  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  let lastError = null;
  let lastBody = null;
  let hostUp = false;
  let consecutive5xx = 0;
  const MAX_CONSECUTIVE_5XX = 3;
  const TICKER_INTERVAL_MS = 5e3;
  let lastTickAt = startedAt;
  const elapsed = () => `${Math.round((Date.now() - startedAt) / 1e3)}s`;
  while (Date.now() < deadline) {
    try {
      const response = await requestLocalJson(`${url}/api/boot`, 45e3, authToken);
      if (response.statusCode >= 200 && response.statusCode < 300) {
        if (!hostUp) {
          hostUp = true;
          stderr?.write(`[gsd] Web host ready.
`);
        }
        consecutive5xx = 0;
        return;
      } else if (response.statusCode >= 500) {
        consecutive5xx++;
        lastError = `http ${response.statusCode}`;
        lastBody = response.body || null;
        if (consecutive5xx >= MAX_CONSECUTIVE_5XX) {
          const detail = lastBody ? `: ${lastBody.slice(0, 500)}` : "";
          throw new Error(
            `boot route returned ${MAX_CONSECUTIVE_5XX} consecutive 5xx responses (last: ${response.statusCode})${detail}`
          );
        }
      } else {
        consecutive5xx = 0;
        lastError = `http ${response.statusCode}`;
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("boot route returned")) {
        throw error;
      }
      consecutive5xx = 0;
      lastError = error instanceof Error ? error.message : String(error);
    }
    const now = Date.now();
    if (now - lastTickAt >= TICKER_INTERVAL_MS) {
      lastTickAt = now;
      if (hostUp) {
        stderr?.write(`[gsd] Still waiting\u2026 (${elapsed()})
`);
      } else {
        stderr?.write(`[gsd] Waiting for web host\u2026 (${elapsed()})
`);
      }
    }
    await new Promise((resolve2) => setTimeout(resolve2, 250));
  }
  throw new Error(lastError ?? "timed out waiting for boot readiness");
}
function cleanupStaleInstance(cwd, stderr, registryPath) {
  const registry = readInstanceRegistry(registryPath);
  const key = resolve(cwd);
  const stale = registry[key];
  if (!stale) return;
  stderr.write(`[gsd] Cleaning up stale web server for ${key} (pid=${stale.pid}, port=${stale.port})\u2026
`);
  const result = killPid(stale.pid);
  if (result === "killed") {
    stderr.write(`[gsd] Killed stale web server (pid=${stale.pid}).
`);
  } else if (result === "already-dead") {
    stderr.write(`[gsd] Stale web server was already stopped (pid=${stale.pid}) \u2014 clearing entry.
`);
  } else {
    stderr.write(`[gsd] Could not kill stale web server (pid=${stale.pid}): ${result.error}
`);
  }
  unregisterInstance(cwd, registryPath);
}
async function launchWebMode(options, deps = {}) {
  const stderr = deps.stderr ?? process.stderr;
  const host = options.host ?? DEFAULT_HOST;
  const resolution = resolveWebHostBootstrap({
    packageRoot: options.packageRoot,
    existsSync: deps.existsSync
  });
  if (!resolution.ok) {
    const failure = {
      mode: "web",
      ok: false,
      cwd: options.cwd,
      projectSessionsDir: options.projectSessionsDir,
      host,
      port: null,
      url: null,
      hostKind: "unresolved",
      hostPath: null,
      hostRoot: null,
      failureReason: `${resolution.reason}; checked=${resolution.candidates.join(",")}`,
      candidates: resolution.candidates
    };
    emitLaunchStatus(stderr, failure);
    return failure;
  }
  stderr.write(`[gsd] Starting web mode\u2026
`);
  cleanupStaleInstance(options.cwd, stderr, deps.registryPath);
  const port = options.port ?? await (deps.resolvePort ?? reserveWebPort)(host);
  const authToken = randomBytes(32).toString("hex");
  const url = `http://${host}:${port}`;
  const env = {
    ...deps.env ?? process.env,
    HOSTNAME: host,
    PORT: String(port),
    GSD_WEB_HOST: host,
    GSD_WEB_PORT: String(port),
    GSD_WEB_AUTH_TOKEN: authToken,
    GSD_WEB_PROJECT_CWD: options.cwd,
    GSD_WEB_PROJECT_SESSIONS_DIR: options.projectSessionsDir,
    GSD_WEB_PACKAGE_ROOT: resolution.packageRoot,
    GSD_WEB_HOST_KIND: resolution.kind,
    ...resolution.kind === "source-dev" ? { NEXT_PUBLIC_GSD_DEV: "1" } : {},
    ...options.allowedOrigins?.length ? { GSD_WEB_ALLOWED_ORIGINS: options.allowedOrigins.join(",") } : {}
  };
  try {
    stderr.write(`[gsd] Initialising resources\u2026
`);
    const bootstrap = deps.initResources ? { initResources: deps.initResources } : await loadResourceBootstrap();
    bootstrap.initResources(options.agentDir);
  } catch (error) {
    const failure = {
      mode: "web",
      ok: false,
      cwd: options.cwd,
      projectSessionsDir: options.projectSessionsDir,
      host,
      port,
      url,
      hostKind: resolution.kind,
      hostPath: resolution.entryPath,
      hostRoot: resolution.hostRoot,
      failureReason: `bootstrap:${error instanceof Error ? error.message : String(error)}`
    };
    emitLaunchStatus(stderr, failure);
    return failure;
  }
  const spawnSpec = buildSpawnSpec(
    resolution,
    host,
    port,
    deps.platform ?? process.platform,
    deps.execPath ?? process.execPath
  );
  stderr.write(`[gsd] Launching web host on port ${port}\u2026
`);
  const spawnResult = await spawnDetachedProcess(
    deps.spawn ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions)),
    spawnSpec.command,
    spawnSpec.args,
    {
      cwd: spawnSpec.cwd,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: needsWindowsShell(spawnSpec.command, deps.platform ?? process.platform),
      env
    }
  );
  if (!spawnResult.ok) {
    const failure = {
      mode: "web",
      ok: false,
      cwd: options.cwd,
      projectSessionsDir: options.projectSessionsDir,
      host,
      port,
      url,
      hostKind: resolution.kind,
      hostPath: resolution.entryPath,
      hostRoot: resolution.hostRoot,
      failureReason: `launch:${spawnResult.error instanceof Error ? spawnResult.error.message : String(spawnResult.error)}`
    };
    emitLaunchStatus(stderr, failure);
    return failure;
  }
  try {
    const bootReadyFn = deps.waitForBootReady ?? ((u) => waitForBootReady(u, 18e4, stderr, authToken));
    await bootReadyFn(url);
  } catch (error) {
    const failure = {
      mode: "web",
      ok: false,
      cwd: options.cwd,
      projectSessionsDir: options.projectSessionsDir,
      host,
      port,
      url,
      hostKind: resolution.kind,
      hostPath: resolution.entryPath,
      hostRoot: resolution.hostRoot,
      failureReason: `boot-ready:${error instanceof Error ? error.message : String(error)}`
    };
    emitLaunchStatus(stderr, failure);
    return failure;
  }
  try {
    spawnResult.child.unref?.();
    const pid = spawnResult.child.pid;
    if (pid !== void 0) {
      const pidFilePath = deps.pidFilePath ?? defaultWebPidFilePath;
      (deps.writePidFile ?? writePidFile)(pidFilePath, pid);
      registerInstance(options.cwd, { pid, port, url }, deps.registryPath);
    }
    const authenticatedUrl2 = `${url}/#token=${authToken}`;
    try {
      ;
      (deps.openBrowser ?? openBrowser)(authenticatedUrl2);
    } catch (browserError) {
      stderr.write(`[gsd] Could not open browser: ${browserError instanceof Error ? browserError.message : String(browserError)}
`);
    }
  } catch (error) {
    const failure = {
      mode: "web",
      ok: false,
      cwd: options.cwd,
      projectSessionsDir: options.projectSessionsDir,
      host,
      port,
      url,
      hostKind: resolution.kind,
      hostPath: resolution.entryPath,
      hostRoot: resolution.hostRoot,
      failureReason: `browser-open:${error instanceof Error ? error.message : String(error)}`
    };
    emitLaunchStatus(stderr, failure);
    return failure;
  }
  const authenticatedUrl = `${url}/#token=${authToken}`;
  const success = {
    mode: "web",
    ok: true,
    cwd: options.cwd,
    projectSessionsDir: options.projectSessionsDir,
    host,
    port,
    url,
    hostKind: resolution.kind,
    hostPath: resolution.entryPath,
    hostRoot: resolution.hostRoot
  };
  stderr.write(`[gsd] Ready \u2192 ${authenticatedUrl}
`);
  emitLaunchStatus(stderr, success);
  return success;
}
export {
  deletePidFile,
  launchWebMode,
  readInstanceRegistry,
  readPidFile,
  registerInstance,
  reserveWebPort,
  resolveWebHostBootstrap,
  stopWebMode,
  unregisterInstance,
  writeInstanceRegistry,
  writePidFile
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL3dlYi1tb2RlLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyByYW5kb21CeXRlcyB9IGZyb20gJ25vZGU6Y3J5cHRvJ1xuaW1wb3J0IHsgZXhlYywgZXhlY0ZpbGUsIHNwYXduLCB0eXBlIENoaWxkUHJvY2VzcywgdHlwZSBTcGF3bk9wdGlvbnMgfSBmcm9tICdub2RlOmNoaWxkX3Byb2Nlc3MnXG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkRmlsZVN5bmMsIHVubGlua1N5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tICdub2RlOmZzJ1xuaW1wb3J0IHsgcmVxdWVzdCBhcyBodHRwUmVxdWVzdCB9IGZyb20gJ25vZGU6aHR0cCdcbmltcG9ydCB7IGNyZWF0ZVNlcnZlciB9IGZyb20gJ25vZGU6bmV0J1xuaW1wb3J0IHsgZGlybmFtZSwgam9pbiwgcmVzb2x2ZSB9IGZyb20gJ25vZGU6cGF0aCdcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tICdub2RlOnVybCdcbmltcG9ydCB7IGFwcFJvb3QsIHdlYlBpZEZpbGVQYXRoIGFzIGRlZmF1bHRXZWJQaWRGaWxlUGF0aCB9IGZyb20gJy4vYXBwLXBhdGhzLmpzJ1xuXG5jb25zdCBERUZBVUxUX0hPU1QgPSAnMTI3LjAuMC4xJ1xuY29uc3QgREVGQVVMVF9QQUNLQUdFX1JPT1QgPSByZXNvbHZlKGRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKSwgJy4uJylcblxuLyoqIE9wZW4gYSBVUkwgaW4gdGhlIHVzZXIncyBkZWZhdWx0IGJyb3dzZXIuICovXG5mdW5jdGlvbiBvcGVuQnJvd3Nlcih1cmw6IHN0cmluZyk6IHZvaWQge1xuICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gJ3dpbjMyJykge1xuICAgIC8vIFBvd2VyU2hlbGwncyBTdGFydC1Qcm9jZXNzIGhhbmRsZXMgVVJMcyB3aXRoICcmJyBzYWZlbHk7IGNtZCAvYyBzdGFydCBkb2VzIG5vdC5cbiAgICBleGVjRmlsZSgncG93ZXJzaGVsbCcsIFsnLWMnLCBgU3RhcnQtUHJvY2VzcyAnJHt1cmwucmVwbGFjZSgvJy9nLCBcIicnXCIpfSdgXSwgeyB3aW5kb3dzSGlkZTogdHJ1ZSB9LCAoKSA9PiB7fSlcbiAgfSBlbHNlIHtcbiAgICBjb25zdCBjbWQgPSBwcm9jZXNzLnBsYXRmb3JtID09PSAnZGFyd2luJyA/ICdvcGVuJyA6ICd4ZGctb3BlbidcbiAgICBleGVjRmlsZShjbWQsIFt1cmxdLCAoKSA9PiB7fSlcbiAgfVxufVxuXG50eXBlIFdyaXRhYmxlTGlrZSA9IFBpY2s8dHlwZW9mIHByb2Nlc3Muc3RkZXJyLCAnd3JpdGUnPlxuXG50eXBlIFJlc291cmNlQm9vdHN0cmFwTGlrZSA9IHtcbiAgaW5pdFJlc291cmNlczogKGFnZW50RGlyOiBzdHJpbmcpID0+IHZvaWRcbn1cblxudHlwZSBTcGF3bmVkQ2hpbGRMaWtlID0gUGljazxDaGlsZFByb2Nlc3MsICdvbmNlJyB8ICd1bnJlZicgfCAncGlkJz5cblxuZXhwb3J0IGludGVyZmFjZSBXZWJNb2RlTGF1bmNoT3B0aW9ucyB7XG4gIGN3ZDogc3RyaW5nXG4gIHByb2plY3RTZXNzaW9uc0Rpcjogc3RyaW5nXG4gIGFnZW50RGlyOiBzdHJpbmdcbiAgcGFja2FnZVJvb3Q/OiBzdHJpbmdcbiAgaG9zdD86IHN0cmluZ1xuICBwb3J0PzogbnVtYmVyXG4gIC8qKiBBZGRpdGlvbmFsIGFsbG93ZWQgb3JpZ2lucyBmb3IgQ09SUyAoZm9yd2FyZGVkIGFzIEdTRF9XRUJfQUxMT1dFRF9PUklHSU5TKS4gKi9cbiAgYWxsb3dlZE9yaWdpbnM/OiBzdHJpbmdbXVxufVxuXG5leHBvcnQgaW50ZXJmYWNlIFJlc29sdmVkV2ViSG9zdEJvb3RzdHJhcCB7XG4gIG9rOiB0cnVlXG4gIGtpbmQ6ICdwYWNrYWdlZC1zdGFuZGFsb25lJyB8ICdzb3VyY2UtZGV2J1xuICBwYWNrYWdlUm9vdDogc3RyaW5nXG4gIGhvc3RSb290OiBzdHJpbmdcbiAgZW50cnlQYXRoOiBzdHJpbmdcbn1cblxuZXhwb3J0IGludGVyZmFjZSBVbnJlc29sdmVkV2ViSG9zdEJvb3RzdHJhcCB7XG4gIG9rOiBmYWxzZVxuICBwYWNrYWdlUm9vdDogc3RyaW5nXG4gIHJlYXNvbjogc3RyaW5nXG4gIGNhbmRpZGF0ZXM6IHN0cmluZ1tdXG59XG5cbmV4cG9ydCB0eXBlIFdlYkhvc3RCb290c3RyYXAgPSBSZXNvbHZlZFdlYkhvc3RCb290c3RyYXAgfCBVbnJlc29sdmVkV2ViSG9zdEJvb3RzdHJhcFxuXG5leHBvcnQgaW50ZXJmYWNlIFdlYk1vZGVMYXVuY2hTdWNjZXNzIHtcbiAgbW9kZTogJ3dlYidcbiAgb2s6IHRydWVcbiAgY3dkOiBzdHJpbmdcbiAgcHJvamVjdFNlc3Npb25zRGlyOiBzdHJpbmdcbiAgaG9zdDogc3RyaW5nXG4gIHBvcnQ6IG51bWJlclxuICB1cmw6IHN0cmluZ1xuICBob3N0S2luZDogUmVzb2x2ZWRXZWJIb3N0Qm9vdHN0cmFwWydraW5kJ11cbiAgaG9zdFBhdGg6IHN0cmluZ1xuICBob3N0Um9vdDogc3RyaW5nXG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV2ViTW9kZUxhdW5jaEZhaWx1cmUge1xuICBtb2RlOiAnd2ViJ1xuICBvazogZmFsc2VcbiAgY3dkOiBzdHJpbmdcbiAgcHJvamVjdFNlc3Npb25zRGlyOiBzdHJpbmdcbiAgaG9zdDogc3RyaW5nXG4gIHBvcnQ6IG51bWJlciB8IG51bGxcbiAgdXJsOiBzdHJpbmcgfCBudWxsXG4gIGhvc3RLaW5kOiBSZXNvbHZlZFdlYkhvc3RCb290c3RyYXBbJ2tpbmQnXSB8ICd1bnJlc29sdmVkJ1xuICBob3N0UGF0aDogc3RyaW5nIHwgbnVsbFxuICBob3N0Um9vdDogc3RyaW5nIHwgbnVsbFxuICBmYWlsdXJlUmVhc29uOiBzdHJpbmdcbiAgY2FuZGlkYXRlcz86IHN0cmluZ1tdXG59XG5cbmV4cG9ydCB0eXBlIFdlYk1vZGVMYXVuY2hTdGF0dXMgPSBXZWJNb2RlTGF1bmNoU3VjY2VzcyB8IFdlYk1vZGVMYXVuY2hGYWlsdXJlXG5cbmV4cG9ydCBpbnRlcmZhY2UgV2ViTW9kZURlcHMge1xuICBleGlzdHNTeW5jPzogKHBhdGg6IHN0cmluZykgPT4gYm9vbGVhblxuICBpbml0UmVzb3VyY2VzPzogKGFnZW50RGlyOiBzdHJpbmcpID0+IHZvaWRcbiAgcmVzb2x2ZVBvcnQ/OiAoaG9zdDogc3RyaW5nKSA9PiBQcm9taXNlPG51bWJlcj5cbiAgc3Bhd24/OiAoY29tbWFuZDogc3RyaW5nLCBhcmdzOiByZWFkb25seSBzdHJpbmdbXSwgb3B0aW9uczogU3Bhd25PcHRpb25zKSA9PiBTcGF3bmVkQ2hpbGRMaWtlXG4gIHdhaXRGb3JCb290UmVhZHk/OiAodXJsOiBzdHJpbmcpID0+IFByb21pc2U8dm9pZD5cbiAgb3BlbkJyb3dzZXI/OiAodXJsOiBzdHJpbmcpID0+IHZvaWRcbiAgc3RkZXJyPzogV3JpdGFibGVMaWtlXG4gIGVudj86IE5vZGVKUy5Qcm9jZXNzRW52XG4gIHBsYXRmb3JtPzogTm9kZUpTLlBsYXRmb3JtXG4gIGV4ZWNQYXRoPzogc3RyaW5nXG4gIHBpZEZpbGVQYXRoPzogc3RyaW5nXG4gIHdyaXRlUGlkRmlsZT86IChwYXRoOiBzdHJpbmcsIHBpZDogbnVtYmVyKSA9PiB2b2lkXG4gIHJlYWRQaWRGaWxlPzogKHBhdGg6IHN0cmluZykgPT4gbnVtYmVyIHwgbnVsbFxuICBkZWxldGVQaWRGaWxlPzogKHBhdGg6IHN0cmluZykgPT4gdm9pZFxuICAvKiogUGF0aCB0byB0aGUgbXVsdGktaW5zdGFuY2UgcmVnaXN0cnkgSlNPTiAoZm9yIHRlc3RpbmcpLiAqL1xuICByZWdpc3RyeVBhdGg/OiBzdHJpbmdcbn1cblxuZXhwb3J0IGludGVyZmFjZSBXZWJNb2RlU3RvcFJlc3VsdCB7XG4gIG9rOiBib29sZWFuXG4gIHJlYXNvbj86IHN0cmluZ1xuICAvKiogSG93IG1hbnkgaW5zdGFuY2VzIHdlcmUgc3RvcHBlZCAocmVsZXZhbnQgZm9yIC0tYWxsKSAqL1xuICBzdG9wcGVkQ291bnQ/OiBudW1iZXJcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEluc3RhbmNlIFJlZ2lzdHJ5IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgaW50ZXJmYWNlIFdlYkluc3RhbmNlRW50cnkge1xuICBwaWQ6IG51bWJlclxuICBwb3J0OiBudW1iZXJcbiAgdXJsOiBzdHJpbmdcbiAgY3dkOiBzdHJpbmdcbiAgc3RhcnRlZEF0OiBzdHJpbmdcbn1cblxuZXhwb3J0IHR5cGUgV2ViSW5zdGFuY2VSZWdpc3RyeSA9IFJlY29yZDxzdHJpbmcsIFdlYkluc3RhbmNlRW50cnk+XG5cbmNvbnN0IFdFQl9JTlNUQU5DRVNfUEFUSCA9IGpvaW4oYXBwUm9vdCwgJ3dlYi1pbnN0YW5jZXMuanNvbicpXG5cbmV4cG9ydCBmdW5jdGlvbiByZWFkSW5zdGFuY2VSZWdpc3RyeShyZWdpc3RyeVBhdGggPSBXRUJfSU5TVEFOQ0VTX1BBVEgpOiBXZWJJbnN0YW5jZVJlZ2lzdHJ5IHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocmVnaXN0cnlQYXRoLCAndXRmOCcpKSBhcyBXZWJJbnN0YW5jZVJlZ2lzdHJ5XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiB7fVxuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB3cml0ZUluc3RhbmNlUmVnaXN0cnkocmVnaXN0cnk6IFdlYkluc3RhbmNlUmVnaXN0cnksIHJlZ2lzdHJ5UGF0aCA9IFdFQl9JTlNUQU5DRVNfUEFUSCk6IHZvaWQge1xuICB3cml0ZUZpbGVTeW5jKHJlZ2lzdHJ5UGF0aCwgSlNPTi5zdHJpbmdpZnkocmVnaXN0cnksIG51bGwsIDIpLCAndXRmOCcpXG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZWdpc3Rlckluc3RhbmNlKGN3ZDogc3RyaW5nLCBlbnRyeTogT21pdDxXZWJJbnN0YW5jZUVudHJ5LCAnY3dkJyB8ICdzdGFydGVkQXQnPiwgcmVnaXN0cnlQYXRoID0gV0VCX0lOU1RBTkNFU19QQVRIKTogdm9pZCB7XG4gIGNvbnN0IHJlZ2lzdHJ5ID0gcmVhZEluc3RhbmNlUmVnaXN0cnkocmVnaXN0cnlQYXRoKVxuICByZWdpc3RyeVtyZXNvbHZlKGN3ZCldID0ge1xuICAgIC4uLmVudHJ5LFxuICAgIGN3ZDogcmVzb2x2ZShjd2QpLFxuICAgIHN0YXJ0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICB9XG4gIHdyaXRlSW5zdGFuY2VSZWdpc3RyeShyZWdpc3RyeSwgcmVnaXN0cnlQYXRoKVxufVxuXG5leHBvcnQgZnVuY3Rpb24gdW5yZWdpc3Rlckluc3RhbmNlKGN3ZDogc3RyaW5nLCByZWdpc3RyeVBhdGggPSBXRUJfSU5TVEFOQ0VTX1BBVEgpOiB2b2lkIHtcbiAgY29uc3QgcmVnaXN0cnkgPSByZWFkSW5zdGFuY2VSZWdpc3RyeShyZWdpc3RyeVBhdGgpXG4gIGRlbGV0ZSByZWdpc3RyeVtyZXNvbHZlKGN3ZCldXG4gIHdyaXRlSW5zdGFuY2VSZWdpc3RyeShyZWdpc3RyeSwgcmVnaXN0cnlQYXRoKVxufVxuXG5mdW5jdGlvbiBraWxsUGlkKHBpZDogbnVtYmVyKTogJ2tpbGxlZCcgfCAnYWxyZWFkeS1kZWFkJyB8IHsgZXJyb3I6IHN0cmluZyB9IHtcbiAgdHJ5IHtcbiAgICBwcm9jZXNzLmtpbGwocGlkLCAnU0lHVEVSTScpXG4gICAgcmV0dXJuICdraWxsZWQnXG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc3QgaXNBbHJlYWR5RGVhZCA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgJiYgJ2NvZGUnIGluIGVycm9yICYmIChlcnJvciBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24pLmNvZGUgPT09ICdFU1JDSCdcbiAgICBpZiAoaXNBbHJlYWR5RGVhZCkgcmV0dXJuICdhbHJlYWR5LWRlYWQnXG4gICAgcmV0dXJuIHsgZXJyb3I6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKSB9XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHdyaXRlUGlkRmlsZShmaWxlUGF0aDogc3RyaW5nLCBwaWQ6IG51bWJlcik6IHZvaWQge1xuICB3cml0ZUZpbGVTeW5jKGZpbGVQYXRoLCBTdHJpbmcocGlkKSwgJ3V0ZjgnKVxufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVhZFBpZEZpbGUoZmlsZVBhdGg6IHN0cmluZyk6IG51bWJlciB8IG51bGwge1xuICB0cnkge1xuICAgIGNvbnN0IGNvbnRlbnQgPSByZWFkRmlsZVN5bmMoZmlsZVBhdGgsICd1dGY4JykudHJpbSgpXG4gICAgY29uc3QgcGlkID0gcGFyc2VJbnQoY29udGVudCwgMTApXG4gICAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShwaWQpICYmIHBpZCA+IDAgPyBwaWQgOiBudWxsXG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsXG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGRlbGV0ZVBpZEZpbGUoZmlsZVBhdGg6IHN0cmluZyk6IHZvaWQge1xuICB0cnkge1xuICAgIHVubGlua1N5bmMoZmlsZVBhdGgpXG4gIH0gY2F0Y2gge1xuICAgIC8vIE5vbi1mYXRhbCBcdTIwMTQgZmlsZSBtYXkgYWxyZWFkeSBiZSBnb25lXG4gIH1cbn1cblxuZXhwb3J0IGludGVyZmFjZSBXZWJNb2RlU3RvcE9wdGlvbnMge1xuICAvKiogU3RvcCBpbnN0YW5jZSBmb3IgYSBzcGVjaWZpYyBwcm9qZWN0IHBhdGggKi9cbiAgcHJvamVjdEN3ZD86IHN0cmluZ1xuICAvKiogU3RvcCBhbGwgcnVubmluZyBpbnN0YW5jZXMgKi9cbiAgYWxsPzogYm9vbGVhblxufVxuXG5leHBvcnQgZnVuY3Rpb24gc3RvcFdlYk1vZGUoZGVwczogUGljazxXZWJNb2RlRGVwcywgJ3BpZEZpbGVQYXRoJyB8ICdyZWFkUGlkRmlsZScgfCAnZGVsZXRlUGlkRmlsZScgfCAnc3RkZXJyJz4gPSB7fSwgb3B0aW9uczogV2ViTW9kZVN0b3BPcHRpb25zID0ge30pOiBXZWJNb2RlU3RvcFJlc3VsdCB7XG4gIGNvbnN0IHN0ZGVyciA9IGRlcHMuc3RkZXJyID8/IHByb2Nlc3Muc3RkZXJyXG5cbiAgLy8gXHUyNTAwXHUyNTAwIFN0b3AgYWxsIGluc3RhbmNlcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgaWYgKG9wdGlvbnMuYWxsKSB7XG4gICAgY29uc3QgcmVnaXN0cnkgPSByZWFkSW5zdGFuY2VSZWdpc3RyeSgpXG4gICAgY29uc3QgZW50cmllcyA9IE9iamVjdC5lbnRyaWVzKHJlZ2lzdHJ5KVxuICAgIGlmIChlbnRyaWVzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgLy8gRmFsbCBiYWNrIHRvIGxlZ2FjeSBQSUQgZmlsZVxuICAgICAgcmV0dXJuIHN0b3BMZWdhY3lQaWRGaWxlKGRlcHMpXG4gICAgfVxuICAgIGxldCBzdG9wcGVkID0gMFxuICAgIGZvciAoY29uc3QgW2N3ZCwgZW50cnldIG9mIGVudHJpZXMpIHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGtpbGxQaWQoZW50cnkucGlkKVxuICAgICAgaWYgKHJlc3VsdCA9PT0gJ2tpbGxlZCcpIHtcbiAgICAgICAgc3RkZXJyLndyaXRlKGBbZ3NkXSBTdG9wcGVkIHdlYiBzZXJ2ZXIgZm9yICR7Y3dkfSAocGlkPSR7ZW50cnkucGlkfSlcXG5gKVxuICAgICAgICBzdG9wcGVkKytcbiAgICAgIH0gZWxzZSBpZiAocmVzdWx0ID09PSAnYWxyZWFkeS1kZWFkJykge1xuICAgICAgICBzdGRlcnIud3JpdGUoYFtnc2RdIFdlYiBzZXJ2ZXIgZm9yICR7Y3dkfSB3YXMgYWxyZWFkeSBzdG9wcGVkIChwaWQ9JHtlbnRyeS5waWR9KVxcbmApXG4gICAgICAgIHN0b3BwZWQrK1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgc3RkZXJyLndyaXRlKGBbZ3NkXSBGYWlsZWQgdG8gc3RvcCB3ZWIgc2VydmVyIGZvciAke2N3ZH06ICR7cmVzdWx0LmVycm9yfVxcbmApXG4gICAgICB9XG4gICAgICB1bnJlZ2lzdGVySW5zdGFuY2UoY3dkKVxuICAgIH1cbiAgICAvLyBBbHNvIGNsZWFuIHVwIGxlZ2FjeSBQSUQgZmlsZVxuICAgIGNvbnN0IGRlbGV0ZVBpZCA9IGRlcHMuZGVsZXRlUGlkRmlsZSA/PyBkZWxldGVQaWRGaWxlXG4gICAgY29uc3QgcGlkRmlsZVBhdGggPSBkZXBzLnBpZEZpbGVQYXRoID8/IGRlZmF1bHRXZWJQaWRGaWxlUGF0aFxuICAgIGRlbGV0ZVBpZChwaWRGaWxlUGF0aClcbiAgICBzdGRlcnIud3JpdGUoYFtnc2RdIFN0b3BwZWQgJHtzdG9wcGVkfSBpbnN0YW5jZSR7c3RvcHBlZCA9PT0gMSA/ICcnIDogJ3MnfS5cXG5gKVxuICAgIHJldHVybiB7IG9rOiB0cnVlLCBzdG9wcGVkQ291bnQ6IHN0b3BwZWQgfVxuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwIFN0b3Agc3BlY2lmaWMgcHJvamVjdCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgaWYgKG9wdGlvbnMucHJvamVjdEN3ZCkge1xuICAgIGNvbnN0IHJlc29sdmVkQ3dkID0gcmVzb2x2ZShvcHRpb25zLnByb2plY3RDd2QpXG4gICAgY29uc3QgcmVnaXN0cnkgPSByZWFkSW5zdGFuY2VSZWdpc3RyeSgpXG4gICAgY29uc3QgZW50cnkgPSByZWdpc3RyeVtyZXNvbHZlZEN3ZF1cbiAgICBpZiAoIWVudHJ5KSB7XG4gICAgICBzdGRlcnIud3JpdGUoYFtnc2RdIE5vIHdlYiBzZXJ2ZXIgcnVubmluZyBmb3IgJHtyZXNvbHZlZEN3ZH1cXG5gKVxuICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCByZWFzb246ICdub3QtZm91bmQnIH1cbiAgICB9XG4gICAgY29uc3QgcmVzdWx0ID0ga2lsbFBpZChlbnRyeS5waWQpXG4gICAgdW5yZWdpc3Rlckluc3RhbmNlKHJlc29sdmVkQ3dkKVxuICAgIGlmIChyZXN1bHQgPT09ICdraWxsZWQnKSB7XG4gICAgICBzdGRlcnIud3JpdGUoYFtnc2RdIFN0b3BwZWQgd2ViIHNlcnZlciBmb3IgJHtyZXNvbHZlZEN3ZH0gKHBpZD0ke2VudHJ5LnBpZH0pXFxuYClcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBzdG9wcGVkQ291bnQ6IDEgfVxuICAgIH0gZWxzZSBpZiAocmVzdWx0ID09PSAnYWxyZWFkeS1kZWFkJykge1xuICAgICAgc3RkZXJyLndyaXRlKGBbZ3NkXSBXZWIgc2VydmVyIGZvciAke3Jlc29sdmVkQ3dkfSB3YXMgYWxyZWFkeSBzdG9wcGVkIFx1MjAxNCBjbGVhcmVkIHN0YWxlIGVudHJ5LlxcbmApXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgc3RvcHBlZENvdW50OiAxIH1cbiAgICB9IGVsc2Uge1xuICAgICAgc3RkZXJyLndyaXRlKGBbZ3NkXSBGYWlsZWQgdG8gc3RvcCB3ZWIgc2VydmVyIGZvciAke3Jlc29sdmVkQ3dkfTogJHtyZXN1bHQuZXJyb3J9XFxuYClcbiAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgcmVhc29uOiByZXN1bHQuZXJyb3IgfVxuICAgIH1cbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBEZWZhdWx0OiBzdG9wIHZpYSBsZWdhY3kgUElEIGZpbGUgKGJhY2t3YXJkIGNvbXBhdCkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIHJldHVybiBzdG9wTGVnYWN5UGlkRmlsZShkZXBzKVxufVxuXG5mdW5jdGlvbiBzdG9wTGVnYWN5UGlkRmlsZShkZXBzOiBQaWNrPFdlYk1vZGVEZXBzLCAncGlkRmlsZVBhdGgnIHwgJ3JlYWRQaWRGaWxlJyB8ICdkZWxldGVQaWRGaWxlJyB8ICdzdGRlcnInPik6IFdlYk1vZGVTdG9wUmVzdWx0IHtcbiAgY29uc3Qgc3RkZXJyID0gZGVwcy5zdGRlcnIgPz8gcHJvY2Vzcy5zdGRlcnJcbiAgY29uc3QgcGlkRmlsZVBhdGggPSBkZXBzLnBpZEZpbGVQYXRoID8/IGRlZmF1bHRXZWJQaWRGaWxlUGF0aFxuICBjb25zdCByZWFkUGlkID0gZGVwcy5yZWFkUGlkRmlsZSA/PyByZWFkUGlkRmlsZVxuICBjb25zdCBkZWxldGVQaWQgPSBkZXBzLmRlbGV0ZVBpZEZpbGUgPz8gZGVsZXRlUGlkRmlsZVxuXG4gIGNvbnN0IHBpZCA9IHJlYWRQaWQocGlkRmlsZVBhdGgpXG4gIGlmIChwaWQgPT09IG51bGwpIHtcbiAgICBzdGRlcnIud3JpdGUoYFtnc2RdIFdlYiBzZXJ2ZXIgaXMgbm90IHJ1bm5pbmcgKG5vIFBJRCBmaWxlIGZvdW5kKVxcbmApXG4gICAgcmV0dXJuIHsgb2s6IGZhbHNlLCByZWFzb246ICduby1waWQtZmlsZScgfVxuICB9XG5cbiAgc3RkZXJyLndyaXRlKGBbZ3NkXSBTdG9wcGluZyB3ZWIgc2VydmVyIChwaWQ9JHtwaWR9KVx1MjAyNlxcbmApXG5cbiAgY29uc3QgcmVzdWx0ID0ga2lsbFBpZChwaWQpXG4gIGRlbGV0ZVBpZChwaWRGaWxlUGF0aClcbiAgaWYgKHJlc3VsdCA9PT0gJ2tpbGxlZCcpIHtcbiAgICBzdGRlcnIud3JpdGUoYFtnc2RdIFdlYiBzZXJ2ZXIgc3RvcHBlZC5cXG5gKVxuICAgIHJldHVybiB7IG9rOiB0cnVlIH1cbiAgfSBlbHNlIGlmIChyZXN1bHQgPT09ICdhbHJlYWR5LWRlYWQnKSB7XG4gICAgc3RkZXJyLndyaXRlKGBbZ3NkXSBXZWIgc2VydmVyIHdhcyBhbHJlYWR5IHN0b3BwZWQgXHUyMDE0IGNsZWFyZWQgc3RhbGUgUElEIGZpbGUuXFxuYClcbiAgICByZXR1cm4geyBvazogdHJ1ZSB9XG4gIH0gZWxzZSB7XG4gICAgc3RkZXJyLndyaXRlKGBbZ3NkXSBGYWlsZWQgdG8gc3RvcCB3ZWIgc2VydmVyOiAke3Jlc3VsdC5lcnJvcn1cXG5gKVxuICAgIHJldHVybiB7IG9rOiBmYWxzZSwgcmVhc29uOiByZXN1bHQuZXJyb3IgfVxuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGxvYWRSZXNvdXJjZUJvb3RzdHJhcCgpOiBQcm9taXNlPFJlc291cmNlQm9vdHN0cmFwTGlrZT4ge1xuICBjb25zdCBtb2QgPSBhd2FpdCBpbXBvcnQoJy4vcmVzb3VyY2UtbG9hZGVyLmpzJylcbiAgcmV0dXJuIHtcbiAgICBpbml0UmVzb3VyY2VzOiBtb2QuaW5pdFJlc291cmNlcyxcbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZVdlYkhvc3RCb290c3RyYXAob3B0aW9uczoge1xuICBwYWNrYWdlUm9vdD86IHN0cmluZ1xuICBleGlzdHNTeW5jPzogKHBhdGg6IHN0cmluZykgPT4gYm9vbGVhblxufSA9IHt9KTogV2ViSG9zdEJvb3RzdHJhcCB7XG4gIGNvbnN0IHBhY2thZ2VSb290ID0gb3B0aW9ucy5wYWNrYWdlUm9vdCA/PyBERUZBVUxUX1BBQ0tBR0VfUk9PVFxuICBjb25zdCBjaGVja0V4aXN0cyA9IG9wdGlvbnMuZXhpc3RzU3luYyA/PyBleGlzdHNTeW5jXG4gIGNvbnN0IHBhY2thZ2VkU3RhbmRhbG9uZVNlcnZlciA9IGpvaW4ocGFja2FnZVJvb3QsICdkaXN0JywgJ3dlYicsICdzdGFuZGFsb25lJywgJ3NlcnZlci5qcycpXG4gIGlmIChjaGVja0V4aXN0cyhwYWNrYWdlZFN0YW5kYWxvbmVTZXJ2ZXIpKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiB0cnVlLFxuICAgICAga2luZDogJ3BhY2thZ2VkLXN0YW5kYWxvbmUnLFxuICAgICAgcGFja2FnZVJvb3QsXG4gICAgICBob3N0Um9vdDogam9pbihwYWNrYWdlUm9vdCwgJ2Rpc3QnLCAnd2ViJywgJ3N0YW5kYWxvbmUnKSxcbiAgICAgIGVudHJ5UGF0aDogcGFja2FnZWRTdGFuZGFsb25lU2VydmVyLFxuICAgIH1cbiAgfVxuXG4gIGNvbnN0IHNvdXJjZVdlYlJvb3QgPSBqb2luKHBhY2thZ2VSb290LCAnd2ViJylcbiAgY29uc3Qgc291cmNlTWFuaWZlc3QgPSBqb2luKHNvdXJjZVdlYlJvb3QsICdwYWNrYWdlLmpzb24nKVxuICBpZiAoY2hlY2tFeGlzdHMoc291cmNlTWFuaWZlc3QpKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiB0cnVlLFxuICAgICAga2luZDogJ3NvdXJjZS1kZXYnLFxuICAgICAgcGFja2FnZVJvb3QsXG4gICAgICBob3N0Um9vdDogc291cmNlV2ViUm9vdCxcbiAgICAgIGVudHJ5UGF0aDogc291cmNlTWFuaWZlc3QsXG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBvazogZmFsc2UsXG4gICAgcGFja2FnZVJvb3QsXG4gICAgcmVhc29uOiAnaG9zdCBib290c3RyYXAgbm90IGZvdW5kJyxcbiAgICBjYW5kaWRhdGVzOiBbcGFja2FnZWRTdGFuZGFsb25lU2VydmVyLCBzb3VyY2VNYW5pZmVzdF0sXG4gIH1cbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlc2VydmVXZWJQb3J0KGhvc3QgPSBERUZBVUxUX0hPU1QpOiBQcm9taXNlPG51bWJlcj4ge1xuICByZXR1cm4gYXdhaXQgbmV3IFByb21pc2U8bnVtYmVyPigocmVzb2x2ZVBvcnQsIHJlamVjdCkgPT4ge1xuICAgIGNvbnN0IHNlcnZlciA9IGNyZWF0ZVNlcnZlcigpXG4gICAgc2VydmVyLnVucmVmKClcbiAgICBzZXJ2ZXIub25jZSgnZXJyb3InLCByZWplY3QpXG4gICAgc2VydmVyLmxpc3RlbigwLCBob3N0LCAoKSA9PiB7XG4gICAgICBjb25zdCBhZGRyZXNzID0gc2VydmVyLmFkZHJlc3MoKVxuICAgICAgaWYgKCFhZGRyZXNzIHx8IHR5cGVvZiBhZGRyZXNzID09PSAnc3RyaW5nJykge1xuICAgICAgICBzZXJ2ZXIuY2xvc2UoKCkgPT4gcmVqZWN0KG5ldyBFcnJvcignZmFpbGVkIHRvIGRldGVybWluZSByZXNlcnZlZCB3ZWIgcG9ydCcpKSlcbiAgICAgICAgcmV0dXJuXG4gICAgICB9XG4gICAgICBzZXJ2ZXIuY2xvc2UoKGVycm9yKSA9PiB7XG4gICAgICAgIGlmIChlcnJvcikge1xuICAgICAgICAgIHJlamVjdChlcnJvcilcbiAgICAgICAgICByZXR1cm5cbiAgICAgICAgfVxuICAgICAgICByZXNvbHZlUG9ydChhZGRyZXNzLnBvcnQpXG4gICAgICB9KVxuICAgIH0pXG4gIH0pXG59XG5cbmZ1bmN0aW9uIGdldFNwYXduQ29tbWFuZEZvclNvdXJjZUhvc3QocGxhdGZvcm06IE5vZGVKUy5QbGF0Zm9ybSk6IHN0cmluZyB7XG4gIHJldHVybiBwbGF0Zm9ybSA9PT0gJ3dpbjMyJyA/ICducG0uY21kJyA6ICducG0nXG59XG5cbmZ1bmN0aW9uIG5lZWRzV2luZG93c1NoZWxsKGNvbW1hbmQ6IHN0cmluZywgcGxhdGZvcm06IE5vZGVKUy5QbGF0Zm9ybSk6IGJvb2xlYW4ge1xuICByZXR1cm4gcGxhdGZvcm0gPT09ICd3aW4zMicgJiYgL1xcLihjbWR8YmF0KSQvaS50ZXN0KGNvbW1hbmQpXG59XG5cbmZ1bmN0aW9uIGZvcm1hdExhdW5jaFN0YXR1cyhzdGF0dXM6IFdlYk1vZGVMYXVuY2hTdGF0dXMpOiBzdHJpbmcge1xuICBpZiAoc3RhdHVzLm9rKSB7XG4gICAgcmV0dXJuIGBbZ3NkXSBXZWIgbW9kZSBzdGFydHVwOiBzdGF0dXM9c3RhcnRlZCBjd2Q9JHtzdGF0dXMuY3dkfSBwb3J0PSR7c3RhdHVzLnBvcnR9IGhvc3Q9JHtzdGF0dXMuaG9zdFBhdGh9IGtpbmQ9JHtzdGF0dXMuaG9zdEtpbmR9IHVybD0ke3N0YXR1cy51cmx9XFxuYFxuICB9XG5cbiAgcmV0dXJuIGBbZ3NkXSBXZWIgbW9kZSBzdGFydHVwOiBzdGF0dXM9ZmFpbGVkIGN3ZD0ke3N0YXR1cy5jd2R9IHBvcnQ9JHtzdGF0dXMucG9ydCA/PyAnbi9hJ30gaG9zdD0ke3N0YXR1cy5ob3N0UGF0aCA/PyAndW5yZXNvbHZlZCd9IGtpbmQ9JHtzdGF0dXMuaG9zdEtpbmR9IHJlYXNvbj0ke3N0YXR1cy5mYWlsdXJlUmVhc29ufVxcbmBcbn1cblxuZnVuY3Rpb24gZW1pdExhdW5jaFN0YXR1cyhzdGRlcnI6IFdyaXRhYmxlTGlrZSwgc3RhdHVzOiBXZWJNb2RlTGF1bmNoU3RhdHVzKTogdm9pZCB7XG4gIHN0ZGVyci53cml0ZShmb3JtYXRMYXVuY2hTdGF0dXMoc3RhdHVzKSlcbn1cblxuZnVuY3Rpb24gYnVpbGRTcGF3blNwZWMoXG4gIHJlc29sdXRpb246IFJlc29sdmVkV2ViSG9zdEJvb3RzdHJhcCxcbiAgaG9zdDogc3RyaW5nLFxuICBwb3J0OiBudW1iZXIsXG4gIHBsYXRmb3JtOiBOb2RlSlMuUGxhdGZvcm0sXG4gIGV4ZWNQYXRoOiBzdHJpbmcsXG4pOiB7IGNvbW1hbmQ6IHN0cmluZzsgYXJnczogc3RyaW5nW107IGN3ZDogc3RyaW5nIH0ge1xuICBpZiAocmVzb2x1dGlvbi5raW5kID09PSAncGFja2FnZWQtc3RhbmRhbG9uZScpIHtcbiAgICByZXR1cm4ge1xuICAgICAgY29tbWFuZDogZXhlY1BhdGgsXG4gICAgICBhcmdzOiBbcmVzb2x1dGlvbi5lbnRyeVBhdGhdLFxuICAgICAgY3dkOiByZXNvbHV0aW9uLmhvc3RSb290LFxuICAgIH1cbiAgfVxuXG4gIHJldHVybiB7XG4gICAgY29tbWFuZDogZ2V0U3Bhd25Db21tYW5kRm9yU291cmNlSG9zdChwbGF0Zm9ybSksXG4gICAgYXJnczogWydydW4nLCAnZGV2JywgJy0tJywgJy0taG9zdG5hbWUnLCBob3N0LCAnLS1wb3J0JywgU3RyaW5nKHBvcnQpXSxcbiAgICBjd2Q6IHJlc29sdXRpb24uaG9zdFJvb3QsXG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gc3Bhd25EZXRhY2hlZFByb2Nlc3MoXG4gIHNwYXduQ29tbWFuZDogKGNvbW1hbmQ6IHN0cmluZywgYXJnczogcmVhZG9ubHkgc3RyaW5nW10sIG9wdGlvbnM6IFNwYXduT3B0aW9ucykgPT4gU3Bhd25lZENoaWxkTGlrZSxcbiAgY29tbWFuZDogc3RyaW5nLFxuICBhcmdzOiBzdHJpbmdbXSxcbiAgb3B0aW9uczogU3Bhd25PcHRpb25zLFxuKTogUHJvbWlzZTx7IG9rOiB0cnVlOyBjaGlsZDogU3Bhd25lZENoaWxkTGlrZSB9IHwgeyBvazogZmFsc2U7IGVycm9yOiB1bmtub3duIH0+IHtcbiAgcmV0dXJuIGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGNoaWxkID0gc3Bhd25Db21tYW5kKGNvbW1hbmQsIGFyZ3MsIG9wdGlvbnMpXG4gICAgICBsZXQgc2V0dGxlZCA9IGZhbHNlXG4gICAgICBjb25zdCBmaW5pc2ggPSAocmVzdWx0OiB7IG9rOiB0cnVlOyBjaGlsZDogU3Bhd25lZENoaWxkTGlrZSB9IHwgeyBvazogZmFsc2U7IGVycm9yOiB1bmtub3duIH0pID0+IHtcbiAgICAgICAgaWYgKHNldHRsZWQpIHJldHVyblxuICAgICAgICBzZXR0bGVkID0gdHJ1ZVxuICAgICAgICByZXNvbHZlKHJlc3VsdClcbiAgICAgIH1cblxuICAgICAgY2hpbGQub25jZT8uKCdlcnJvcicsIChlcnJvcikgPT4gZmluaXNoKHsgb2s6IGZhbHNlLCBlcnJvciB9KSlcbiAgICAgIHNldEltbWVkaWF0ZSgoKSA9PiBmaW5pc2goeyBvazogdHJ1ZSwgY2hpbGQgfSkpXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIHJlc29sdmUoeyBvazogZmFsc2UsIGVycm9yIH0pXG4gICAgfVxuICB9KVxufVxuXG5hc3luYyBmdW5jdGlvbiByZXF1ZXN0TG9jYWxKc29uKHVybDogc3RyaW5nLCB0aW1lb3V0TXM6IG51bWJlciwgYXV0aFRva2VuPzogc3RyaW5nKTogUHJvbWlzZTx7IHN0YXR1c0NvZGU6IG51bWJlcjsgYm9keTogc3RyaW5nIH0+IHtcbiAgcmV0dXJuIGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICBjb25zdCBoZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICAgICAgQWNjZXB0OiAnYXBwbGljYXRpb24vanNvbicsXG4gICAgICAvLyBLZWVwIGxhdW5jaCByZWFkaW5lc3Mgb24gdGhlIGNoZWFwZXN0IHVuY29tcHJlc3NlZCBwYXRoLiBUaGVcbiAgICAgIC8vIHBhY2thZ2VkIGhvc3QgY2FuIHNwZW5kIG5vdGljZWFibGUgdGltZSBjb21wcmVzc2luZyB0aGUgbGFyZ2UgYm9vdFxuICAgICAgLy8gc25hcHNob3QsIHdoaWNoIGFkZHMgYXZvaWRhYmxlIHN0YXJ0dXAgaml0dGVyIGZvciBhIGxvY2FsIGhlYWx0aFxuICAgICAgLy8gY2hlY2sgdGhhdCBvbmx5IG5lZWRzIHRoZSBKU09OIHBheWxvYWQgaXRzZWxmLlxuICAgICAgJ0FjY2VwdC1FbmNvZGluZyc6ICdpZGVudGl0eScsXG4gICAgfVxuICAgIGlmIChhdXRoVG9rZW4pIHtcbiAgICAgIGhlYWRlcnNbJ0F1dGhvcml6YXRpb24nXSA9IGBCZWFyZXIgJHthdXRoVG9rZW59YFxuICAgIH1cbiAgICBjb25zdCByZXF1ZXN0ID0gaHR0cFJlcXVlc3QoXG4gICAgICB1cmwsXG4gICAgICB7XG4gICAgICAgIG1ldGhvZDogJ0dFVCcsXG4gICAgICAgIGhlYWRlcnMsXG4gICAgICB9LFxuICAgICAgKHJlc3BvbnNlKSA9PiB7XG4gICAgICAgIGNvbnN0IHN0YXR1c0NvZGUgPSByZXNwb25zZS5zdGF0dXNDb2RlID8/IDBcbiAgICAgICAgbGV0IGJvZHkgPSAnJ1xuICAgICAgICByZXNwb25zZS5zZXRFbmNvZGluZygndXRmOCcpXG4gICAgICAgIHJlc3BvbnNlLm9uKCdkYXRhJywgKGNodW5rKSA9PiB7XG4gICAgICAgICAgYm9keSArPSBjaHVua1xuICAgICAgICB9KVxuICAgICAgICByZXNwb25zZS5vbignZW5kJywgKCkgPT4gcmVzb2x2ZSh7IHN0YXR1c0NvZGUsIGJvZHkgfSkpXG4gICAgICB9LFxuICAgIClcblxuICAgIHJlcXVlc3Quc2V0VGltZW91dCh0aW1lb3V0TXMsICgpID0+IHtcbiAgICAgIHJlcXVlc3QuZGVzdHJveShuZXcgRXJyb3IoYHJlcXVlc3QgdGltZWQgb3V0IGFmdGVyICR7dGltZW91dE1zfW1zYCkpXG4gICAgfSlcbiAgICByZXF1ZXN0Lm9uY2UoJ2Vycm9yJywgcmVqZWN0KVxuICAgIHJlcXVlc3QuZW5kKClcbiAgfSlcbn1cblxuYXN5bmMgZnVuY3Rpb24gd2FpdEZvckJvb3RSZWFkeSh1cmw6IHN0cmluZywgdGltZW91dE1zID0gMTgwXzAwMCwgc3RkZXJyPzogV3JpdGFibGVMaWtlLCBhdXRoVG9rZW4/OiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgZGVhZGxpbmUgPSBEYXRlLm5vdygpICsgdGltZW91dE1zXG4gIGNvbnN0IHN0YXJ0ZWRBdCA9IERhdGUubm93KClcbiAgbGV0IGxhc3RFcnJvcjogc3RyaW5nIHwgbnVsbCA9IG51bGxcbiAgbGV0IGxhc3RCb2R5OiBzdHJpbmcgfCBudWxsID0gbnVsbFxuICBsZXQgaG9zdFVwID0gZmFsc2VcbiAgbGV0IGNvbnNlY3V0aXZlNXh4ID0gMFxuICBjb25zdCBNQVhfQ09OU0VDVVRJVkVfNVhYID0gM1xuICAvLyBQcmludCBhIHByb2dyZXNzIGRvdCBldmVyeSBOIG1zIHdoaWxlIHdhaXRpbmcgc28gdGhlIHRlcm1pbmFsIGlzbid0IHNpbGVudFxuICBjb25zdCBUSUNLRVJfSU5URVJWQUxfTVMgPSA1XzAwMFxuICBsZXQgbGFzdFRpY2tBdCA9IHN0YXJ0ZWRBdFxuXG4gIGNvbnN0IGVsYXBzZWQgPSAoKSA9PiBgJHtNYXRoLnJvdW5kKChEYXRlLm5vdygpIC0gc3RhcnRlZEF0KSAvIDEwMDApfXNgXG5cbiAgd2hpbGUgKERhdGUubm93KCkgPCBkZWFkbGluZSkge1xuICAgIHRyeSB7XG4gICAgICAvLyBHaXZlIHRoZSBwYWNrYWdlZCBob3N0IGVub3VnaCB0aW1lIHRvIGZpbmlzaCBhIGNvbGQgL2FwaS9ib290IHJlbmRlci5cbiAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgcmVxdWVzdExvY2FsSnNvbihgJHt1cmx9L2FwaS9ib290YCwgNDVfMDAwLCBhdXRoVG9rZW4pXG5cbiAgICAgIGlmIChyZXNwb25zZS5zdGF0dXNDb2RlID49IDIwMCAmJiByZXNwb25zZS5zdGF0dXNDb2RlIDwgMzAwKSB7XG4gICAgICAgIGlmICghaG9zdFVwKSB7XG4gICAgICAgICAgaG9zdFVwID0gdHJ1ZVxuICAgICAgICAgIHN0ZGVycj8ud3JpdGUoYFtnc2RdIFdlYiBob3N0IHJlYWR5LlxcbmApXG4gICAgICAgIH1cbiAgICAgICAgY29uc2VjdXRpdmU1eHggPSAwXG4gICAgICAgIC8vIEhvc3QgcmVzcG9uZGVkIHN1Y2Nlc3NmdWxseSBcdTIwMTQgaXQncyByZWFkeSBmb3IgdGhlIGJyb3dzZXJcbiAgICAgICAgcmV0dXJuXG4gICAgICB9IGVsc2UgaWYgKHJlc3BvbnNlLnN0YXR1c0NvZGUgPj0gNTAwKSB7XG4gICAgICAgIGNvbnNlY3V0aXZlNXh4KytcbiAgICAgICAgbGFzdEVycm9yID0gYGh0dHAgJHtyZXNwb25zZS5zdGF0dXNDb2RlfWBcbiAgICAgICAgbGFzdEJvZHkgPSByZXNwb25zZS5ib2R5IHx8IG51bGxcbiAgICAgICAgaWYgKGNvbnNlY3V0aXZlNXh4ID49IE1BWF9DT05TRUNVVElWRV81WFgpIHtcbiAgICAgICAgICBjb25zdCBkZXRhaWwgPSBsYXN0Qm9keSA/IGA6ICR7bGFzdEJvZHkuc2xpY2UoMCwgNTAwKX1gIDogJydcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICBgYm9vdCByb3V0ZSByZXR1cm5lZCAke01BWF9DT05TRUNVVElWRV81WFh9IGNvbnNlY3V0aXZlIDV4eCByZXNwb25zZXMgKGxhc3Q6ICR7cmVzcG9uc2Uuc3RhdHVzQ29kZX0pJHtkZXRhaWx9YCxcbiAgICAgICAgICApXG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbnNlY3V0aXZlNXh4ID0gMFxuICAgICAgICBsYXN0RXJyb3IgPSBgaHR0cCAke3Jlc3BvbnNlLnN0YXR1c0NvZGV9YFxuICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciAmJiBlcnJvci5tZXNzYWdlLnN0YXJ0c1dpdGgoJ2Jvb3Qgcm91dGUgcmV0dXJuZWQnKSkge1xuICAgICAgICB0aHJvdyBlcnJvclxuICAgICAgfVxuICAgICAgLy8gQ29ubmVjdGlvbiByZWZ1c2VkLCB0aW1lb3V0LCBldGMuIFx1MjAxNCB0cmFuc2llbnQgZHVyaW5nIGNvbGQgc3RhcnRcbiAgICAgIGNvbnNlY3V0aXZlNXh4ID0gMFxuICAgICAgbGFzdEVycm9yID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpXG4gICAgfVxuXG4gICAgLy8gRW1pdCBhIGhlYXJ0YmVhdCBsaW5lIGV2ZXJ5IFRJQ0tFUl9JTlRFUlZBTF9NUyB0byBzaG93IHdlJ3JlIGFsaXZlXG4gICAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKVxuICAgIGlmIChub3cgLSBsYXN0VGlja0F0ID49IFRJQ0tFUl9JTlRFUlZBTF9NUykge1xuICAgICAgbGFzdFRpY2tBdCA9IG5vd1xuICAgICAgaWYgKGhvc3RVcCkge1xuICAgICAgICBzdGRlcnI/LndyaXRlKGBbZ3NkXSBTdGlsbCB3YWl0aW5nXHUyMDI2ICgke2VsYXBzZWQoKX0pXFxuYClcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHN0ZGVycj8ud3JpdGUoYFtnc2RdIFdhaXRpbmcgZm9yIHdlYiBob3N0XHUyMDI2ICgke2VsYXBzZWQoKX0pXFxuYClcbiAgICAgIH1cbiAgICB9XG5cbiAgICBhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4gc2V0VGltZW91dChyZXNvbHZlLCAyNTApKVxuICB9XG5cbiAgdGhyb3cgbmV3IEVycm9yKGxhc3RFcnJvciA/PyAndGltZWQgb3V0IHdhaXRpbmcgZm9yIGJvb3QgcmVhZGluZXNzJylcbn1cblxuLyoqXG4gKiBJZiBhIHByZXZpb3VzIHdlYiBzZXJ2ZXIgaW5zdGFuY2UgaXMgcmVnaXN0ZXJlZCBmb3IgdGhlIHNhbWUgYGN3ZGAsIGF0dGVtcHRcbiAqIHRvIGtpbGwgaXQgYW5kIHJlbW92ZSBpdHMgcmVnaXN0cnkgZW50cnkgc28gdGhlIG5ldyBsYXVuY2ggY2FuIGJpbmQgdGhlIHBvcnRcbiAqIGNsZWFubHkuICBUaGlzIGhhbmRsZXMgdGhlIFwib3JwaGFuIHByb2Nlc3NcIiBzY2VuYXJpbyB3aGVyZSBhIHByaW9yIGBnc2QgLS13ZWJgXG4gKiB3YXMgdGVybWluYXRlZCB3aXRob3V0IGNsZWFuIHNodXRkb3duIChlLmcuIHRlcm1pbmFsIGNsb3NlZCkuXG4gKi9cbmZ1bmN0aW9uIGNsZWFudXBTdGFsZUluc3RhbmNlKGN3ZDogc3RyaW5nLCBzdGRlcnI6IFdyaXRhYmxlTGlrZSwgcmVnaXN0cnlQYXRoPzogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IHJlZ2lzdHJ5ID0gcmVhZEluc3RhbmNlUmVnaXN0cnkocmVnaXN0cnlQYXRoKVxuICBjb25zdCBrZXkgPSByZXNvbHZlKGN3ZClcbiAgY29uc3Qgc3RhbGUgPSByZWdpc3RyeVtrZXldXG4gIGlmICghc3RhbGUpIHJldHVyblxuXG4gIHN0ZGVyci53cml0ZShgW2dzZF0gQ2xlYW5pbmcgdXAgc3RhbGUgd2ViIHNlcnZlciBmb3IgJHtrZXl9IChwaWQ9JHtzdGFsZS5waWR9LCBwb3J0PSR7c3RhbGUucG9ydH0pXHUyMDI2XFxuYClcbiAgY29uc3QgcmVzdWx0ID0ga2lsbFBpZChzdGFsZS5waWQpXG4gIGlmIChyZXN1bHQgPT09ICdraWxsZWQnKSB7XG4gICAgc3RkZXJyLndyaXRlKGBbZ3NkXSBLaWxsZWQgc3RhbGUgd2ViIHNlcnZlciAocGlkPSR7c3RhbGUucGlkfSkuXFxuYClcbiAgfSBlbHNlIGlmIChyZXN1bHQgPT09ICdhbHJlYWR5LWRlYWQnKSB7XG4gICAgc3RkZXJyLndyaXRlKGBbZ3NkXSBTdGFsZSB3ZWIgc2VydmVyIHdhcyBhbHJlYWR5IHN0b3BwZWQgKHBpZD0ke3N0YWxlLnBpZH0pIFx1MjAxNCBjbGVhcmluZyBlbnRyeS5cXG5gKVxuICB9IGVsc2Uge1xuICAgIHN0ZGVyci53cml0ZShgW2dzZF0gQ291bGQgbm90IGtpbGwgc3RhbGUgd2ViIHNlcnZlciAocGlkPSR7c3RhbGUucGlkfSk6ICR7cmVzdWx0LmVycm9yfVxcbmApXG4gIH1cbiAgdW5yZWdpc3Rlckluc3RhbmNlKGN3ZCwgcmVnaXN0cnlQYXRoKVxufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbGF1bmNoV2ViTW9kZShcbiAgb3B0aW9uczogV2ViTW9kZUxhdW5jaE9wdGlvbnMsXG4gIGRlcHM6IFdlYk1vZGVEZXBzID0ge30sXG4pOiBQcm9taXNlPFdlYk1vZGVMYXVuY2hTdGF0dXM+IHtcbiAgY29uc3Qgc3RkZXJyID0gZGVwcy5zdGRlcnIgPz8gcHJvY2Vzcy5zdGRlcnJcbiAgY29uc3QgaG9zdCA9IG9wdGlvbnMuaG9zdCA/PyBERUZBVUxUX0hPU1RcbiAgY29uc3QgcmVzb2x1dGlvbiA9IHJlc29sdmVXZWJIb3N0Qm9vdHN0cmFwKHtcbiAgICBwYWNrYWdlUm9vdDogb3B0aW9ucy5wYWNrYWdlUm9vdCxcbiAgICBleGlzdHNTeW5jOiBkZXBzLmV4aXN0c1N5bmMsXG4gIH0pXG5cbiAgaWYgKCFyZXNvbHV0aW9uLm9rKSB7XG4gICAgY29uc3QgZmFpbHVyZTogV2ViTW9kZUxhdW5jaEZhaWx1cmUgPSB7XG4gICAgICBtb2RlOiAnd2ViJyxcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGN3ZDogb3B0aW9ucy5jd2QsXG4gICAgICBwcm9qZWN0U2Vzc2lvbnNEaXI6IG9wdGlvbnMucHJvamVjdFNlc3Npb25zRGlyLFxuICAgICAgaG9zdCxcbiAgICAgIHBvcnQ6IG51bGwsXG4gICAgICB1cmw6IG51bGwsXG4gICAgICBob3N0S2luZDogJ3VucmVzb2x2ZWQnLFxuICAgICAgaG9zdFBhdGg6IG51bGwsXG4gICAgICBob3N0Um9vdDogbnVsbCxcbiAgICAgIGZhaWx1cmVSZWFzb246IGAke3Jlc29sdXRpb24ucmVhc29ufTsgY2hlY2tlZD0ke3Jlc29sdXRpb24uY2FuZGlkYXRlcy5qb2luKCcsJyl9YCxcbiAgICAgIGNhbmRpZGF0ZXM6IHJlc29sdXRpb24uY2FuZGlkYXRlcyxcbiAgICB9XG4gICAgZW1pdExhdW5jaFN0YXR1cyhzdGRlcnIsIGZhaWx1cmUpXG4gICAgcmV0dXJuIGZhaWx1cmVcbiAgfVxuXG4gIHN0ZGVyci53cml0ZShgW2dzZF0gU3RhcnRpbmcgd2ViIG1vZGVcdTIwMjZcXG5gKVxuXG4gIC8vIEtpbGwgYW55IHN0YWxlIHNlcnZlciBpbnN0YW5jZSBmb3IgdGhpcyBwcm9qZWN0IGJlZm9yZSByZXNlcnZpbmcgYSBwb3J0LlxuICAvLyBUaGlzIHByZXZlbnRzIEVBRERSSU5VU0Ugd2hlbiB0aGUgcHJldmlvdXMgYGdzZCAtLXdlYmAgd2FzIHRlcm1pbmF0ZWRcbiAgLy8gd2l0aG91dCBhIGNsZWFuIHNodXRkb3duIChlLmcuIHRlcm1pbmFsIGNsb3NlZCwgY3Jhc2gpLlxuICBjbGVhbnVwU3RhbGVJbnN0YW5jZShvcHRpb25zLmN3ZCwgc3RkZXJyLCBkZXBzLnJlZ2lzdHJ5UGF0aClcblxuICBjb25zdCBwb3J0ID0gb3B0aW9ucy5wb3J0ID8/IGF3YWl0IChkZXBzLnJlc29sdmVQb3J0ID8/IHJlc2VydmVXZWJQb3J0KShob3N0KVxuICBjb25zdCBhdXRoVG9rZW4gPSByYW5kb21CeXRlcygzMikudG9TdHJpbmcoJ2hleCcpXG4gIGNvbnN0IHVybCA9IGBodHRwOi8vJHtob3N0fToke3BvcnR9YFxuICBjb25zdCBlbnYgPSB7XG4gICAgLi4uKGRlcHMuZW52ID8/IHByb2Nlc3MuZW52KSxcbiAgICBIT1NUTkFNRTogaG9zdCxcbiAgICBQT1JUOiBTdHJpbmcocG9ydCksXG4gICAgR1NEX1dFQl9IT1NUOiBob3N0LFxuICAgIEdTRF9XRUJfUE9SVDogU3RyaW5nKHBvcnQpLFxuICAgIEdTRF9XRUJfQVVUSF9UT0tFTjogYXV0aFRva2VuLFxuICAgIEdTRF9XRUJfUFJPSkVDVF9DV0Q6IG9wdGlvbnMuY3dkLFxuICAgIEdTRF9XRUJfUFJPSkVDVF9TRVNTSU9OU19ESVI6IG9wdGlvbnMucHJvamVjdFNlc3Npb25zRGlyLFxuICAgIEdTRF9XRUJfUEFDS0FHRV9ST09UOiByZXNvbHV0aW9uLnBhY2thZ2VSb290LFxuICAgIEdTRF9XRUJfSE9TVF9LSU5EOiByZXNvbHV0aW9uLmtpbmQsXG4gICAgLi4uKHJlc29sdXRpb24ua2luZCA9PT0gJ3NvdXJjZS1kZXYnID8geyBORVhUX1BVQkxJQ19HU0RfREVWOiAnMScgfSA6IHt9KSxcbiAgICAuLi4ob3B0aW9ucy5hbGxvd2VkT3JpZ2lucz8ubGVuZ3RoID8geyBHU0RfV0VCX0FMTE9XRURfT1JJR0lOUzogb3B0aW9ucy5hbGxvd2VkT3JpZ2lucy5qb2luKCcsJykgfSA6IHt9KSxcbiAgfVxuXG4gIHRyeSB7XG4gICAgc3RkZXJyLndyaXRlKGBbZ3NkXSBJbml0aWFsaXNpbmcgcmVzb3VyY2VzXHUyMDI2XFxuYClcbiAgICBjb25zdCBib290c3RyYXAgPSBkZXBzLmluaXRSZXNvdXJjZXMgPyB7IGluaXRSZXNvdXJjZXM6IGRlcHMuaW5pdFJlc291cmNlcyB9IDogYXdhaXQgbG9hZFJlc291cmNlQm9vdHN0cmFwKClcbiAgICBib290c3RyYXAuaW5pdFJlc291cmNlcyhvcHRpb25zLmFnZW50RGlyKVxuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnN0IGZhaWx1cmU6IFdlYk1vZGVMYXVuY2hGYWlsdXJlID0ge1xuICAgICAgbW9kZTogJ3dlYicsXG4gICAgICBvazogZmFsc2UsXG4gICAgICBjd2Q6IG9wdGlvbnMuY3dkLFxuICAgICAgcHJvamVjdFNlc3Npb25zRGlyOiBvcHRpb25zLnByb2plY3RTZXNzaW9uc0RpcixcbiAgICAgIGhvc3QsXG4gICAgICBwb3J0LFxuICAgICAgdXJsLFxuICAgICAgaG9zdEtpbmQ6IHJlc29sdXRpb24ua2luZCxcbiAgICAgIGhvc3RQYXRoOiByZXNvbHV0aW9uLmVudHJ5UGF0aCxcbiAgICAgIGhvc3RSb290OiByZXNvbHV0aW9uLmhvc3RSb290LFxuICAgICAgZmFpbHVyZVJlYXNvbjogYGJvb3RzdHJhcDoke2Vycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKX1gLFxuICAgIH1cbiAgICBlbWl0TGF1bmNoU3RhdHVzKHN0ZGVyciwgZmFpbHVyZSlcbiAgICByZXR1cm4gZmFpbHVyZVxuICB9XG5cbiAgY29uc3Qgc3Bhd25TcGVjID0gYnVpbGRTcGF3blNwZWMoXG4gICAgcmVzb2x1dGlvbixcbiAgICBob3N0LFxuICAgIHBvcnQsXG4gICAgZGVwcy5wbGF0Zm9ybSA/PyBwcm9jZXNzLnBsYXRmb3JtLFxuICAgIGRlcHMuZXhlY1BhdGggPz8gcHJvY2Vzcy5leGVjUGF0aCxcbiAgKVxuXG4gIHN0ZGVyci53cml0ZShgW2dzZF0gTGF1bmNoaW5nIHdlYiBob3N0IG9uIHBvcnQgJHtwb3J0fVx1MjAyNlxcbmApXG5cbiAgY29uc3Qgc3Bhd25SZXN1bHQgPSBhd2FpdCBzcGF3bkRldGFjaGVkUHJvY2VzcyhcbiAgICBkZXBzLnNwYXduID8/ICgoY29tbWFuZCwgYXJncywgc3Bhd25PcHRpb25zKSA9PiBzcGF3bihjb21tYW5kLCBhcmdzLCBzcGF3bk9wdGlvbnMpKSxcbiAgICBzcGF3blNwZWMuY29tbWFuZCxcbiAgICBzcGF3blNwZWMuYXJncyxcbiAgICB7XG4gICAgICBjd2Q6IHNwYXduU3BlYy5jd2QsXG4gICAgICBkZXRhY2hlZDogdHJ1ZSxcbiAgICAgIHN0ZGlvOiAnaWdub3JlJyxcbiAgICAgIHdpbmRvd3NIaWRlOiB0cnVlLFxuICAgICAgc2hlbGw6IG5lZWRzV2luZG93c1NoZWxsKHNwYXduU3BlYy5jb21tYW5kLCBkZXBzLnBsYXRmb3JtID8/IHByb2Nlc3MucGxhdGZvcm0pLFxuICAgICAgZW52LFxuICAgIH0sXG4gIClcblxuICBpZiAoIXNwYXduUmVzdWx0Lm9rKSB7XG4gICAgY29uc3QgZmFpbHVyZTogV2ViTW9kZUxhdW5jaEZhaWx1cmUgPSB7XG4gICAgICBtb2RlOiAnd2ViJyxcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGN3ZDogb3B0aW9ucy5jd2QsXG4gICAgICBwcm9qZWN0U2Vzc2lvbnNEaXI6IG9wdGlvbnMucHJvamVjdFNlc3Npb25zRGlyLFxuICAgICAgaG9zdCxcbiAgICAgIHBvcnQsXG4gICAgICB1cmwsXG4gICAgICBob3N0S2luZDogcmVzb2x1dGlvbi5raW5kLFxuICAgICAgaG9zdFBhdGg6IHJlc29sdXRpb24uZW50cnlQYXRoLFxuICAgICAgaG9zdFJvb3Q6IHJlc29sdXRpb24uaG9zdFJvb3QsXG4gICAgICBmYWlsdXJlUmVhc29uOiBgbGF1bmNoOiR7c3Bhd25SZXN1bHQuZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IHNwYXduUmVzdWx0LmVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoc3Bhd25SZXN1bHQuZXJyb3IpfWAsXG4gICAgfVxuICAgIGVtaXRMYXVuY2hTdGF0dXMoc3RkZXJyLCBmYWlsdXJlKVxuICAgIHJldHVybiBmYWlsdXJlXG4gIH1cblxuICB0cnkge1xuICAgIGNvbnN0IGJvb3RSZWFkeUZuID0gZGVwcy53YWl0Rm9yQm9vdFJlYWR5ID8/ICgodTogc3RyaW5nKSA9PiB3YWl0Rm9yQm9vdFJlYWR5KHUsIDE4MF8wMDAsIHN0ZGVyciwgYXV0aFRva2VuKSlcbiAgICBhd2FpdCBib290UmVhZHlGbih1cmwpXG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc3QgZmFpbHVyZTogV2ViTW9kZUxhdW5jaEZhaWx1cmUgPSB7XG4gICAgICBtb2RlOiAnd2ViJyxcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGN3ZDogb3B0aW9ucy5jd2QsXG4gICAgICBwcm9qZWN0U2Vzc2lvbnNEaXI6IG9wdGlvbnMucHJvamVjdFNlc3Npb25zRGlyLFxuICAgICAgaG9zdCxcbiAgICAgIHBvcnQsXG4gICAgICB1cmwsXG4gICAgICBob3N0S2luZDogcmVzb2x1dGlvbi5raW5kLFxuICAgICAgaG9zdFBhdGg6IHJlc29sdXRpb24uZW50cnlQYXRoLFxuICAgICAgaG9zdFJvb3Q6IHJlc29sdXRpb24uaG9zdFJvb3QsXG4gICAgICBmYWlsdXJlUmVhc29uOiBgYm9vdC1yZWFkeToke2Vycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKX1gLFxuICAgIH1cbiAgICBlbWl0TGF1bmNoU3RhdHVzKHN0ZGVyciwgZmFpbHVyZSlcbiAgICByZXR1cm4gZmFpbHVyZVxuICB9XG5cbiAgdHJ5IHtcbiAgICBzcGF3blJlc3VsdC5jaGlsZC51bnJlZj8uKClcbiAgICBjb25zdCBwaWQgPSBzcGF3blJlc3VsdC5jaGlsZC5waWRcbiAgICBpZiAocGlkICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbnN0IHBpZEZpbGVQYXRoID0gZGVwcy5waWRGaWxlUGF0aCA/PyBkZWZhdWx0V2ViUGlkRmlsZVBhdGhcbiAgICAgIDsoZGVwcy53cml0ZVBpZEZpbGUgPz8gd3JpdGVQaWRGaWxlKShwaWRGaWxlUGF0aCwgcGlkKVxuICAgICAgLy8gUmVnaXN0ZXIgaW4gbXVsdGktaW5zdGFuY2UgcmVnaXN0cnlcbiAgICAgIHJlZ2lzdGVySW5zdGFuY2Uob3B0aW9ucy5jd2QsIHsgcGlkLCBwb3J0LCB1cmwgfSwgZGVwcy5yZWdpc3RyeVBhdGgpXG4gICAgfVxuICAgIGNvbnN0IGF1dGhlbnRpY2F0ZWRVcmwgPSBgJHt1cmx9LyN0b2tlbj0ke2F1dGhUb2tlbn1gXG4gICAgdHJ5IHtcbiAgICAgIDsoZGVwcy5vcGVuQnJvd3NlciA/PyBvcGVuQnJvd3NlcikoYXV0aGVudGljYXRlZFVybClcbiAgICB9IGNhdGNoIChicm93c2VyRXJyb3IpIHtcbiAgICAgIHN0ZGVyci53cml0ZShgW2dzZF0gQ291bGQgbm90IG9wZW4gYnJvd3NlcjogJHticm93c2VyRXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGJyb3dzZXJFcnJvci5tZXNzYWdlIDogU3RyaW5nKGJyb3dzZXJFcnJvcil9XFxuYClcbiAgICB9XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc3QgZmFpbHVyZTogV2ViTW9kZUxhdW5jaEZhaWx1cmUgPSB7XG4gICAgICBtb2RlOiAnd2ViJyxcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGN3ZDogb3B0aW9ucy5jd2QsXG4gICAgICBwcm9qZWN0U2Vzc2lvbnNEaXI6IG9wdGlvbnMucHJvamVjdFNlc3Npb25zRGlyLFxuICAgICAgaG9zdCxcbiAgICAgIHBvcnQsXG4gICAgICB1cmwsXG4gICAgICBob3N0S2luZDogcmVzb2x1dGlvbi5raW5kLFxuICAgICAgaG9zdFBhdGg6IHJlc29sdXRpb24uZW50cnlQYXRoLFxuICAgICAgaG9zdFJvb3Q6IHJlc29sdXRpb24uaG9zdFJvb3QsXG4gICAgICBmYWlsdXJlUmVhc29uOiBgYnJvd3Nlci1vcGVuOiR7ZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpfWAsXG4gICAgfVxuICAgIGVtaXRMYXVuY2hTdGF0dXMoc3RkZXJyLCBmYWlsdXJlKVxuICAgIHJldHVybiBmYWlsdXJlXG4gIH1cblxuICBjb25zdCBhdXRoZW50aWNhdGVkVXJsID0gYCR7dXJsfS8jdG9rZW49JHthdXRoVG9rZW59YFxuICBjb25zdCBzdWNjZXNzOiBXZWJNb2RlTGF1bmNoU3VjY2VzcyA9IHtcbiAgICBtb2RlOiAnd2ViJyxcbiAgICBvazogdHJ1ZSxcbiAgICBjd2Q6IG9wdGlvbnMuY3dkLFxuICAgIHByb2plY3RTZXNzaW9uc0Rpcjogb3B0aW9ucy5wcm9qZWN0U2Vzc2lvbnNEaXIsXG4gICAgaG9zdCxcbiAgICBwb3J0LFxuICAgIHVybCxcbiAgICBob3N0S2luZDogcmVzb2x1dGlvbi5raW5kLFxuICAgIGhvc3RQYXRoOiByZXNvbHV0aW9uLmVudHJ5UGF0aCxcbiAgICBob3N0Um9vdDogcmVzb2x1dGlvbi5ob3N0Um9vdCxcbiAgfVxuICBzdGRlcnIud3JpdGUoYFtnc2RdIFJlYWR5IFx1MjE5MiAke2F1dGhlbnRpY2F0ZWRVcmx9XFxuYClcbiAgZW1pdExhdW5jaFN0YXR1cyhzdGRlcnIsIHN1Y2Nlc3MpXG4gIHJldHVybiBzdWNjZXNzXG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxTQUFTLG1CQUFtQjtBQUM1QixTQUFlLFVBQVUsYUFBbUQ7QUFDNUUsU0FBUyxZQUFZLGNBQWMsWUFBWSxxQkFBcUI7QUFDcEUsU0FBUyxXQUFXLG1CQUFtQjtBQUN2QyxTQUFTLG9CQUFvQjtBQUM3QixTQUFTLFNBQVMsTUFBTSxlQUFlO0FBQ3ZDLFNBQVMscUJBQXFCO0FBQzlCLFNBQVMsU0FBUyxrQkFBa0IsNkJBQTZCO0FBRWpFLE1BQU0sZUFBZTtBQUNyQixNQUFNLHVCQUF1QixRQUFR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QVUsT0FBTyxLQUFLLENBQUM7QUFBQSxJQUNyRjtBQUNBLHFCQUFpQixRQUFRLE9BQU87QUFDaEMsV0FBTztBQUFBLEVBQ1Q7QUFFQSxNQUFJO0FBQ0YsZ0JBQVksTUFBTSxRQUFRO0FBQzFCLFVBQU0sTUFBTSxZQUFZLE1BQU07QUFDOUIsUUFBSSxRQUFRLFFBQVc7QUFDckIsWUFBTSxjQUFjLEtBQUssZUFBZTtBQUN2QyxPQUFDLEtBQUssZ0JBQWdCLGNBQWMsYUFBYSxHQUFHO0FBRXJELHVCQUFpQixRQUFRLEtBQUssRUFBRSxLQUFLLE1BQU0sSUFBSSxHQUFHLEtBQUssWUFBWTtBQUFBLElBQ3JFO0FBQ0EsVUFBTUMsb0JBQW1CLEdBQUcsR0FBRyxXQUFXLFNBQVM7QUFDbkQsUUFBSTtBQUNGO0FBQUMsT0FBQyxLQUFLLGVBQWUsYUFBYUEsaUJBQWdCO0FBQUEsSUFDckQsU0FBUyxjQUFjO0FBQ3JCLGFBQU8sTUFBTSxpQ0FBaUMsd0JBQXdCLFFBQVEsYUFBYSxVQUFVLE9BQU8sWUFBWSxDQUFDO0FBQUEsQ0FBSTtBQUFBLElBQy9IO0FBQUEsRUFDRixTQUFTLE9BQU87QUFDZCxVQUFNLFVBQWdDO0FBQUEsTUFDcEMsTUFBTTtBQUFBLE1BQ04sSUFBSTtBQUFBLE1BQ0osS0FBSyxRQUFRO0FBQUEsTUFDYixvQkFBb0IsUUFBUTtBQUFBLE1BQzVCO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBLFVBQVUsV0FBVztBQUFBLE1BQ3JCLFVBQVUsV0FBVztBQUFBLE1BQ3JCLFVBQVUsV0FBVztBQUFBLE1BQ3JCLGVBQWUsZ0JBQWdCLGlCQUFpQixRQUFRLE1BQU0sVUFBVSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQ3ZGO0FBQ0EscUJBQWlCLFFBQVEsT0FBTztBQUNoQyxXQUFPO0FBQUEsRUFDVDtBQUVBLFFBQU0sbUJBQW1CLEdBQUcsR0FBRyxXQUFXLFNBQVM7QUFDbkQsUUFBTSxVQUFnQztBQUFBLElBQ3BDLE1BQU07QUFBQSxJQUNOLElBQUk7QUFBQSxJQUNKLEtBQUssUUFBUTtBQUFBLElBQ2Isb0JBQW9CLFFBQVE7QUFBQSxJQUM1QjtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQSxVQUFVLFdBQVc7QUFBQSxJQUNyQixVQUFVLFdBQVc7QUFBQSxJQUNyQixVQUFVLFdBQVc7QUFBQSxFQUN2QjtBQUNBLFNBQU8sTUFBTSxzQkFBaUIsZ0JBQWdCO0FBQUEsQ0FBSTtBQUNsRCxtQkFBaUIsUUFBUSxPQUFPO0FBQ2hDLFNBQU87QUFDVDsiLAogICJuYW1lcyI6IFsicmVzb2x2ZSIsICJhdXRoZW50aWNhdGVkVXJsIl0KfQo=
