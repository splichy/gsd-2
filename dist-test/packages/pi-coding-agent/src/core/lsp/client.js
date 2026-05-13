import { spawn } from "node:child_process";
import * as fsPromises from "node:fs/promises";
import { killProcessTree } from "../../utils/shell.js";
import { ToolAbortError, isEnoent, throwIfAborted, untilAborted } from "./helpers.js";
import { applyWorkspaceEdit } from "./edits.js";
import { getLspmuxCommand, isLspmuxSupported } from "./lspmux.js";
import { detectLanguageId, fileToUri } from "./utils.js";
const clients = /* @__PURE__ */ new Map();
const clientLocks = /* @__PURE__ */ new Map();
const fileOperationLocks = /* @__PURE__ */ new Map();
const clientStreamHandlers = /* @__PURE__ */ new Map();
let idleTimeoutMs = null;
let idleCheckInterval = null;
const IDLE_CHECK_INTERVAL_MS = 60 * 1e3;
const MAX_MESSAGE_BUFFER_SIZE = 10 * 1024 * 1024;
function setIdleTimeout(ms) {
  idleTimeoutMs = ms ?? null;
  if (idleTimeoutMs && idleTimeoutMs > 0) {
    startIdleChecker();
  } else {
    stopIdleChecker();
  }
}
function startIdleChecker() {
  if (idleCheckInterval) return;
  idleCheckInterval = setInterval(() => {
    if (!idleTimeoutMs) return;
    const now = Date.now();
    for (const [key, client] of Array.from(clients.entries())) {
      if (now - client.lastActivity > idleTimeoutMs) {
        shutdownClient(key);
      }
    }
    if (clients.size === 0) {
      stopIdleChecker();
    }
  }, IDLE_CHECK_INTERVAL_MS);
}
function stopIdleChecker() {
  if (idleCheckInterval) {
    clearInterval(idleCheckInterval);
    idleCheckInterval = null;
  }
}
const CLIENT_CAPABILITIES = {
  textDocument: {
    synchronization: {
      didSave: true,
      dynamicRegistration: false,
      willSave: false,
      willSaveWaitUntil: false
    },
    hover: {
      contentFormat: ["markdown", "plaintext"],
      dynamicRegistration: false
    },
    definition: {
      dynamicRegistration: false,
      linkSupport: true
    },
    typeDefinition: {
      dynamicRegistration: false,
      linkSupport: true
    },
    implementation: {
      dynamicRegistration: false,
      linkSupport: true
    },
    references: {
      dynamicRegistration: false
    },
    documentSymbol: {
      dynamicRegistration: false,
      hierarchicalDocumentSymbolSupport: true,
      symbolKind: {
        valueSet: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26]
      }
    },
    rename: {
      dynamicRegistration: false,
      prepareSupport: true
    },
    codeAction: {
      dynamicRegistration: false,
      codeActionLiteralSupport: {
        codeActionKind: {
          valueSet: [
            "quickfix",
            "refactor",
            "refactor.extract",
            "refactor.inline",
            "refactor.rewrite",
            "source",
            "source.organizeImports",
            "source.fixAll"
          ]
        }
      },
      resolveSupport: {
        properties: ["edit"]
      }
    },
    callHierarchy: {
      dynamicRegistration: false
    },
    signatureHelp: {
      dynamicRegistration: false,
      signatureInformation: {
        documentationFormat: ["markdown", "plaintext"],
        parameterInformation: {
          labelOffsetSupport: true
        }
      }
    },
    formatting: {
      dynamicRegistration: false
    },
    rangeFormatting: {
      dynamicRegistration: false
    },
    publishDiagnostics: {
      relatedInformation: true,
      versionSupport: false,
      tagSupport: { valueSet: [1, 2] },
      codeDescriptionSupport: true,
      dataSupport: true
    }
  },
  workspace: {
    applyEdit: true,
    workspaceEdit: {
      documentChanges: true,
      resourceOperations: ["create", "rename", "delete"],
      failureHandling: "textOnlyTransactional"
    },
    configuration: true,
    symbol: {
      dynamicRegistration: false,
      symbolKind: {
        valueSet: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26]
      }
    }
  },
  experimental: {
    snippetTextEdit: true
  }
};
function parseMessage(buffer) {
  const headerEndIndex = findHeaderEnd(buffer);
  if (headerEndIndex === -1) return null;
  const headerText = new TextDecoder().decode(buffer.slice(0, headerEndIndex));
  const contentLengthMatch = headerText.match(/Content-Length: (\d+)/i);
  if (!contentLengthMatch) return null;
  const contentLength = Number.parseInt(contentLengthMatch[1], 10);
  const messageStart = headerEndIndex + 4;
  const messageEnd = messageStart + contentLength;
  if (buffer.length < messageEnd) return null;
  const messageBytes = buffer.subarray(messageStart, messageEnd);
  const messageText = new TextDecoder().decode(messageBytes);
  const remaining = Buffer.from(buffer.subarray(messageEnd));
  let message;
  try {
    message = JSON.parse(messageText);
  } catch (err) {
    if (process.env.DEBUG) {
      const preview = messageText.length > 200 ? messageText.slice(0, 200) + "..." : messageText;
      console.error(`[lsp] Dropped malformed JSON message: ${err instanceof Error ? err.message : err} \u2014 ${preview}`);
    }
    return { message: null, remaining };
  }
  return { message, remaining };
}
function findHeaderEnd(buffer) {
  for (let i = 0; i < buffer.length - 3; i++) {
    if (buffer[i] === 13 && buffer[i + 1] === 10 && buffer[i + 2] === 13 && buffer[i + 3] === 10) {
      return i;
    }
  }
  return -1;
}
async function writeMessage(stdin, message) {
  if (!stdin) {
    throw new Error("LSP process stdin is not available");
  }
  const content = JSON.stringify(message);
  const header = `Content-Length: ${Buffer.byteLength(content, "utf-8")}\r
\r
`;
  return new Promise((resolve, reject) => {
    stdin.write(header + content, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
async function startMessageReader(client) {
  if (client.isReading) return;
  client.isReading = true;
  const stdout = client.proc.stdout;
  if (!stdout) {
    client.isReading = false;
    return;
  }
  return new Promise((resolve) => {
    const handlers = clientStreamHandlers.get(client.name) ?? {};
    handlers.stdoutData = async (chunk) => {
      const currentBuffer = Buffer.concat([client.messageBuffer, chunk]);
      if (currentBuffer.length > MAX_MESSAGE_BUFFER_SIZE) {
        if (process.env.DEBUG) {
          console.error(
            `[lsp] Message buffer exceeded ${MAX_MESSAGE_BUFFER_SIZE} bytes (${currentBuffer.length}), discarding`
          );
        }
        client.messageBuffer = Buffer.alloc(0);
        return;
      }
      client.messageBuffer = currentBuffer;
      let workingBuffer = currentBuffer;
      let parsed = parseMessage(workingBuffer);
      while (parsed) {
        const { message, remaining } = parsed;
        workingBuffer = remaining;
        if (!message) {
          parsed = parseMessage(workingBuffer);
          continue;
        }
        if ("id" in message && message.id !== void 0) {
          const pending = client.pendingRequests.get(message.id);
          if (pending) {
            client.pendingRequests.delete(message.id);
            if ("error" in message && message.error) {
              pending.reject(new Error(`LSP error: ${message.error.message}`));
            } else {
              pending.resolve(message.result);
            }
          } else if ("method" in message) {
            await handleServerRequest(client, message);
          }
        } else if ("method" in message) {
          if (message.method === "textDocument/publishDiagnostics" && message.params) {
            const params = message.params;
            client.diagnostics.set(params.uri, params.diagnostics);
            client.diagnosticsVersion += 1;
          }
        }
        parsed = parseMessage(workingBuffer);
      }
      client.messageBuffer = workingBuffer;
    };
    stdout.on("data", handlers.stdoutData);
    handlers.stdoutEnd = () => {
      client.isReading = false;
      resolve();
    };
    stdout.on("end", handlers.stdoutEnd);
    handlers.stdoutError = () => {
      client.isReading = false;
      resolve();
    };
    stdout.on("error", handlers.stdoutError);
    clientStreamHandlers.set(client.name, handlers);
  });
}
async function handleConfigurationRequest(client, message) {
  if (typeof message.id !== "number") return;
  const params = message.params;
  const items = params?.items ?? [];
  const result = items.map((item) => {
    const section = item.section ?? "";
    return client.config.settings?.[section] ?? {};
  });
  await sendResponse(client, message.id, result, "workspace/configuration");
}
async function handleApplyEditRequest(client, message) {
  if (typeof message.id !== "number") return;
  const params = message.params;
  if (!params?.edit) {
    await sendResponse(
      client,
      message.id,
      { applied: false, failureReason: "No edit provided" },
      "workspace/applyEdit"
    );
    return;
  }
  try {
    await applyWorkspaceEdit(params.edit, client.cwd);
    await sendResponse(client, message.id, { applied: true }, "workspace/applyEdit");
  } catch (err) {
    await sendResponse(client, message.id, { applied: false, failureReason: String(err) }, "workspace/applyEdit");
  }
}
async function handleServerRequest(client, message) {
  if (message.method === "workspace/configuration") {
    await handleConfigurationRequest(client, message);
    return;
  }
  if (message.method === "workspace/applyEdit") {
    await handleApplyEditRequest(client, message);
    return;
  }
  if (typeof message.id !== "number") return;
  await sendResponse(client, message.id, null, message.method, {
    code: -32601,
    message: `Method not found: ${message.method}`
  });
}
async function sendResponse(client, id, result, _method, error) {
  const response = {
    jsonrpc: "2.0",
    id,
    ...error ? { error } : { result }
  };
  try {
    await writeMessage(client.proc.stdin, response);
  } catch {
  }
}
async function startStderrReader(client) {
  const stderr = client.proc.stderr;
  if (!stderr) return;
  return new Promise((resolve) => {
    const handlers = clientStreamHandlers.get(client.name) ?? {};
    handlers.stderrData = (chunk) => {
      const text = chunk.toString("utf-8");
      client.stderrBuffer += text;
      if (client.stderrBuffer.length > 4096) {
        client.stderrBuffer = client.stderrBuffer.slice(-4096);
      }
    };
    stderr.on("data", handlers.stderrData);
    handlers.stderrEnd = () => {
      resolve();
    };
    stderr.on("end", handlers.stderrEnd);
    handlers.stderrError = () => {
      resolve();
    };
    stderr.on("error", handlers.stderrError);
    clientStreamHandlers.set(client.name, handlers);
  });
}
const WARMUP_TIMEOUT_MS = 5e3;
async function getOrCreateClient(config, cwd, initTimeoutMs) {
  const maxRetries = 2;
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await getOrCreateClientOnce(config, cwd, initTimeoutMs);
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 1e3 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}
async function getOrCreateClientOnce(config, cwd, initTimeoutMs) {
  const key = `${config.command}:${cwd}`;
  const existingClient = clients.get(key);
  if (existingClient) {
    existingClient.lastActivity = Date.now();
    return existingClient;
  }
  const existingLock = clientLocks.get(key);
  if (existingLock) {
    return existingLock;
  }
  const clientPromise = (async () => {
    const baseCommand = config.resolvedCommand ?? config.command;
    const baseArgs = config.args ?? [];
    const { command, args, env } = isLspmuxSupported(baseCommand) ? await getLspmuxCommand(baseCommand, baseArgs) : { command: baseCommand, args: baseArgs };
    const proc = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: env ? { ...process.env, ...env } : void 0,
      // On Windows, executables like npx/tsc are .cmd scripts that need
      // shell resolution. Without this, spawn fails with ENOENT (#1222).
      shell: process.platform === "win32"
    });
    proc.on("error", (err) => {
      if (err.code === "ENOENT") {
        proc.emit("exit", 1);
      }
    });
    const exitedPromise = new Promise((resolve) => {
      proc.on("exit", (code) => resolve(code ?? 1));
    });
    const client = {
      name: key,
      cwd,
      proc: {
        stdin: proc.stdin,
        stdout: proc.stdout,
        stderr: proc.stderr,
        pid: proc.pid ?? 0,
        exitCode: null,
        exited: exitedPromise,
        kill: (signal) => proc.kill(signal)
      },
      config,
      requestId: 0,
      diagnostics: /* @__PURE__ */ new Map(),
      diagnosticsVersion: 0,
      openFiles: /* @__PURE__ */ new Map(),
      pendingRequests: /* @__PURE__ */ new Map(),
      messageBuffer: Buffer.alloc(0),
      isReading: false,
      lastActivity: Date.now(),
      stderrBuffer: ""
    };
    clients.set(key, client);
    exitedPromise.then((code) => {
      client.proc.exitCode = code;
      clients.delete(key);
      clientLocks.delete(key);
      if (client.pendingRequests.size > 0) {
        const stderr = client.stderrBuffer.trim();
        const err = new Error(
          stderr ? `LSP server exited (code ${code}): ${stderr}` : `LSP server exited unexpectedly (code ${code})`
        );
        for (const pending of client.pendingRequests.values()) {
          pending.reject(err);
        }
        client.pendingRequests.clear();
      }
    });
    startMessageReader(client);
    startStderrReader(client);
    try {
      const initResult = await sendRequest(
        client,
        "initialize",
        {
          processId: process.pid,
          rootUri: fileToUri(cwd),
          rootPath: cwd,
          capabilities: CLIENT_CAPABILITIES,
          initializationOptions: config.initOptions ?? {},
          workspaceFolders: [{ uri: fileToUri(cwd), name: cwd.split("/").pop() ?? "workspace" }]
        },
        void 0,
        // signal
        initTimeoutMs
      );
      if (!initResult) {
        throw new Error("Failed to initialize LSP: no response");
      }
      client.serverCapabilities = initResult.capabilities;
      await sendNotification(client, "initialized", {});
      return client;
    } catch (err) {
      clients.delete(key);
      clientLocks.delete(key);
      try {
        killProcessTree(proc.pid ?? 0);
      } catch {
        proc.kill();
      }
      throw err;
    } finally {
      clientLocks.delete(key);
    }
  })();
  clientLocks.set(key, clientPromise);
  return clientPromise;
}
async function ensureFileOpen(client, filePath, signal) {
  throwIfAborted(signal);
  const uri = fileToUri(filePath);
  const lockKey = `${client.name}:${uri}`;
  if (client.openFiles.has(uri)) {
    return;
  }
  const existingLock = fileOperationLocks.get(lockKey);
  if (existingLock) {
    await untilAborted(signal, () => existingLock);
    return;
  }
  const openPromise = (async () => {
    throwIfAborted(signal);
    if (client.openFiles.has(uri)) {
      return;
    }
    let content;
    try {
      content = await fsPromises.readFile(filePath, "utf-8");
      throwIfAborted(signal);
    } catch (err) {
      if (isEnoent(err)) return;
      throw err;
    }
    const languageId = detectLanguageId(filePath);
    throwIfAborted(signal);
    await sendNotification(client, "textDocument/didOpen", {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text: content
      }
    });
    client.openFiles.set(uri, { version: 1, languageId });
    client.lastActivity = Date.now();
  })();
  fileOperationLocks.set(lockKey, openPromise);
  try {
    await openPromise;
  } finally {
    fileOperationLocks.delete(lockKey);
  }
}
async function refreshFile(client, filePath, signal) {
  throwIfAborted(signal);
  const uri = fileToUri(filePath);
  const lockKey = `${client.name}:${uri}`;
  const existingLock = fileOperationLocks.get(lockKey);
  if (existingLock) {
    await untilAborted(signal, () => existingLock);
  }
  const refreshPromise = (async () => {
    throwIfAborted(signal);
    const info = client.openFiles.get(uri);
    if (!info) {
      await ensureFileOpen(client, filePath, signal);
      return;
    }
    let content;
    try {
      content = await fsPromises.readFile(filePath, "utf-8");
      throwIfAborted(signal);
    } catch (err) {
      if (isEnoent(err)) return;
      throw err;
    }
    const version = ++info.version;
    throwIfAborted(signal);
    await sendNotification(client, "textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text: content }]
    });
    throwIfAborted(signal);
    await sendNotification(client, "textDocument/didSave", {
      textDocument: { uri },
      text: content
    });
    client.lastActivity = Date.now();
  })();
  fileOperationLocks.set(lockKey, refreshPromise);
  try {
    await refreshPromise;
  } finally {
    fileOperationLocks.delete(lockKey);
  }
}
function notifyFileChanged(filePath) {
  const uri = fileToUri(filePath);
  for (const client of clients.values()) {
    if (client.openFiles.has(uri)) {
      refreshFile(client, filePath).catch(() => {
      });
    }
  }
}
function removeStreamHandlers(client) {
  const handlers = clientStreamHandlers.get(client.name);
  if (!handlers) return;
  if (handlers.stdoutData) client.proc.stdout?.removeListener("data", handlers.stdoutData);
  if (handlers.stdoutEnd) client.proc.stdout?.removeListener("end", handlers.stdoutEnd);
  if (handlers.stdoutError) client.proc.stdout?.removeListener("error", handlers.stdoutError);
  if (handlers.stderrData) client.proc.stderr?.removeListener("data", handlers.stderrData);
  if (handlers.stderrEnd) client.proc.stderr?.removeListener("end", handlers.stderrEnd);
  if (handlers.stderrError) client.proc.stderr?.removeListener("error", handlers.stderrError);
  clientStreamHandlers.delete(client.name);
}
function shutdownClient(key) {
  const client = clients.get(key);
  if (!client) return;
  for (const pending of Array.from(client.pendingRequests.values())) {
    pending.reject(new Error("LSP client shutdown"));
  }
  client.pendingRequests.clear();
  sendRequest(client, "shutdown", null).catch(() => {
  });
  removeStreamHandlers(client);
  try {
    killProcessTree(client.proc.pid);
  } catch {
    client.proc.kill();
  }
  clients.delete(key);
  clientLocks.delete(key);
  for (const lockKey of Array.from(fileOperationLocks.keys())) {
    if (lockKey.startsWith(`${key}:`)) {
      fileOperationLocks.delete(lockKey);
    }
  }
}
const DEFAULT_REQUEST_TIMEOUT_MS = 3e4;
async function sendRequest(client, method, params, signal, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  const id = ++client.requestId;
  if (signal?.aborted) {
    const reason = signal.reason instanceof Error ? signal.reason : new ToolAbortError();
    return Promise.reject(reason);
  }
  const request = {
    jsonrpc: "2.0",
    id,
    method,
    params
  };
  client.lastActivity = Date.now();
  const { promise, resolve, reject } = Promise.withResolvers();
  let timeout;
  const cleanup = () => {
    if (signal) {
      signal.removeEventListener("abort", abortHandler);
    }
  };
  const abortHandler = () => {
    if (client.pendingRequests.has(id)) {
      client.pendingRequests.delete(id);
    }
    void sendNotification(client, "$/cancelRequest", { id }).catch(() => {
    });
    if (timeout) clearTimeout(timeout);
    cleanup();
    const reason = signal?.reason instanceof Error ? signal.reason : new ToolAbortError();
    reject(reason);
  };
  timeout = setTimeout(() => {
    if (client.pendingRequests.has(id)) {
      client.pendingRequests.delete(id);
      const err = new Error(`LSP request ${method} timed out after ${timeoutMs}ms`);
      cleanup();
      reject(err);
    }
  }, timeoutMs);
  if (signal) {
    signal.addEventListener("abort", abortHandler, { once: true });
    if (signal.aborted) {
      abortHandler();
      return promise;
    }
  }
  client.pendingRequests.set(id, {
    resolve: (result) => {
      if (timeout) clearTimeout(timeout);
      cleanup();
      resolve(result);
    },
    reject: (err) => {
      if (timeout) clearTimeout(timeout);
      cleanup();
      reject(err);
    },
    method
  });
  writeMessage(client.proc.stdin, request).catch((err) => {
    if (timeout) clearTimeout(timeout);
    client.pendingRequests.delete(id);
    cleanup();
    reject(err);
  });
  return promise;
}
async function sendNotification(client, method, params) {
  const notification = {
    jsonrpc: "2.0",
    method,
    params
  };
  client.lastActivity = Date.now();
  try {
    await writeMessage(client.proc.stdin, notification);
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "EPIPE") {
      return;
    }
    throw err;
  }
}
function shutdownAll() {
  const clientsToShutdown = Array.from(clients.values());
  clients.clear();
  clientLocks.clear();
  fileOperationLocks.clear();
  stopIdleChecker();
  const err = new Error("LSP client shutdown");
  for (const client of clientsToShutdown) {
    const reqs = Array.from(client.pendingRequests.values());
    client.pendingRequests.clear();
    for (const pending of reqs) {
      pending.reject(err);
    }
    removeStreamHandlers(client);
    void (async () => {
      const timeout = new Promise((resolve) => setTimeout(resolve, 5e3));
      const result = sendRequest(client, "shutdown", null).catch(() => {
      });
      await Promise.race([result, timeout]);
      try {
        killProcessTree(client.proc.pid);
      } catch {
        client.proc.kill();
      }
    })().catch(() => {
    });
  }
}
function getActiveClients() {
  return Array.from(clients.values()).map((client) => ({
    name: client.config.command,
    status: "ready",
    fileTypes: client.config.fileTypes
  }));
}
const _beforeExitHandler = () => shutdownAll();
const _sigintHandler = () => {
  shutdownAll();
  process.exit(0);
};
const _sigtermHandler = () => {
  shutdownAll();
  process.exit(0);
};
if (typeof process !== "undefined") {
  process.on("beforeExit", _beforeExitHandler);
  process.on("SIGINT", _sigintHandler);
  process.on("SIGTERM", _sigtermHandler);
}
function removeProcessHandlers() {
  process.off("beforeExit", _beforeExitHandler);
  process.off("SIGINT", _sigintHandler);
  process.off("SIGTERM", _sigtermHandler);
}
export {
  WARMUP_TIMEOUT_MS,
  ensureFileOpen,
  getActiveClients,
  getOrCreateClient,
  notifyFileChanged,
  refreshFile,
  removeProcessHandlers,
  sendRequest,
  setIdleTimeout
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL2xzcC9jbGllbnQudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IHNwYXduIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0ICogYXMgZnNQcm9taXNlcyBmcm9tIFwibm9kZTpmcy9wcm9taXNlc1wiO1xuaW1wb3J0IHR5cGUgeyBXcml0YWJsZSB9IGZyb20gXCJub2RlOnN0cmVhbVwiO1xuaW1wb3J0IHsga2lsbFByb2Nlc3NUcmVlIH0gZnJvbSBcIi4uLy4uL3V0aWxzL3NoZWxsLmpzXCI7XG5pbXBvcnQgeyBUb29sQWJvcnRFcnJvciwgaXNFbm9lbnQsIHRocm93SWZBYm9ydGVkLCB1bnRpbEFib3J0ZWQgfSBmcm9tIFwiLi9oZWxwZXJzLmpzXCI7XG5pbXBvcnQgeyBhcHBseVdvcmtzcGFjZUVkaXQgfSBmcm9tIFwiLi9lZGl0cy5qc1wiO1xuaW1wb3J0IHsgZ2V0THNwbXV4Q29tbWFuZCwgaXNMc3BtdXhTdXBwb3J0ZWQgfSBmcm9tIFwiLi9sc3BtdXguanNcIjtcbmltcG9ydCB0eXBlIHtcblx0RGlhZ25vc3RpYyxcblx0THNwQ2xpZW50LFxuXHRMc3BKc29uUnBjTm90aWZpY2F0aW9uLFxuXHRMc3BKc29uUnBjUmVxdWVzdCxcblx0THNwSnNvblJwY1Jlc3BvbnNlLFxuXHRTZXJ2ZXJDb25maWcsXG5cdFdvcmtzcGFjZUVkaXQsXG59IGZyb20gXCIuL3R5cGVzLmpzXCI7XG5pbXBvcnQgeyBkZXRlY3RMYW5ndWFnZUlkLCBmaWxlVG9VcmkgfSBmcm9tIFwiLi91dGlscy5qc1wiO1xuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gQ2xpZW50IFN0YXRlXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5jb25zdCBjbGllbnRzID0gbmV3IE1hcDxzdHJpbmcsIExzcENsaWVudD4oKTtcbmNvbnN0IGNsaWVudExvY2tzID0gbmV3IE1hcDxzdHJpbmcsIFByb21pc2U8THNwQ2xpZW50Pj4oKTtcbmNvbnN0IGZpbGVPcGVyYXRpb25Mb2NrcyA9IG5ldyBNYXA8c3RyaW5nLCBQcm9taXNlPHZvaWQ+PigpO1xuXG4vKiogVHJhY2sgc3RyZWFtIGxpc3RlbmVycyBwZXIgY2xpZW50IHNvIHRoZXkgY2FuIGJlIHJlbW92ZWQgb24gc2h1dGRvd24uICovXG5pbnRlcmZhY2UgU3RyZWFtSGFuZGxlcnMge1xuXHRzdGRvdXREYXRhPzogKGNodW5rOiBCdWZmZXIpID0+IHZvaWQ7XG5cdHN0ZG91dEVuZD86ICgpID0+IHZvaWQ7XG5cdHN0ZG91dEVycm9yPzogKCkgPT4gdm9pZDtcblx0c3RkZXJyRGF0YT86IChjaHVuazogQnVmZmVyKSA9PiB2b2lkO1xuXHRzdGRlcnJFbmQ/OiAoKSA9PiB2b2lkO1xuXHRzdGRlcnJFcnJvcj86ICgpID0+IHZvaWQ7XG59XG5jb25zdCBjbGllbnRTdHJlYW1IYW5kbGVycyA9IG5ldyBNYXA8c3RyaW5nLCBTdHJlYW1IYW5kbGVycz4oKTtcblxuLy8gSWRsZSB0aW1lb3V0IGNvbmZpZ3VyYXRpb24gKGRpc2FibGVkIGJ5IGRlZmF1bHQpXG5sZXQgaWRsZVRpbWVvdXRNczogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5sZXQgaWRsZUNoZWNrSW50ZXJ2YWw6IFJldHVyblR5cGU8dHlwZW9mIHNldEludGVydmFsPiB8IG51bGwgPSBudWxsO1xuY29uc3QgSURMRV9DSEVDS19JTlRFUlZBTF9NUyA9IDYwICogMTAwMDtcblxuLyoqIE1heGltdW0gYWxsb3dlZCBzaXplIGZvciB0aGUgbWVzc2FnZSBidWZmZXIgKDEwIE1CKS4gKi9cbmNvbnN0IE1BWF9NRVNTQUdFX0JVRkZFUl9TSVpFID0gMTAgKiAxMDI0ICogMTAyNDtcblxuLyoqXG4gKiBDb25maWd1cmUgdGhlIGlkbGUgdGltZW91dCBmb3IgTFNQIGNsaWVudHMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZXRJZGxlVGltZW91dChtczogbnVtYmVyIHwgbnVsbCB8IHVuZGVmaW5lZCk6IHZvaWQge1xuXHRpZGxlVGltZW91dE1zID0gbXMgPz8gbnVsbDtcblxuXHRpZiAoaWRsZVRpbWVvdXRNcyAmJiBpZGxlVGltZW91dE1zID4gMCkge1xuXHRcdHN0YXJ0SWRsZUNoZWNrZXIoKTtcblx0fSBlbHNlIHtcblx0XHRzdG9wSWRsZUNoZWNrZXIoKTtcblx0fVxufVxuXG5mdW5jdGlvbiBzdGFydElkbGVDaGVja2VyKCk6IHZvaWQge1xuXHRpZiAoaWRsZUNoZWNrSW50ZXJ2YWwpIHJldHVybjtcblx0aWRsZUNoZWNrSW50ZXJ2YWwgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG5cdFx0aWYgKCFpZGxlVGltZW91dE1zKSByZXR1cm47XG5cdFx0Y29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcblx0XHRmb3IgKGNvbnN0IFtrZXksIGNsaWVudF0gb2YgQXJyYXkuZnJvbShjbGllbnRzLmVudHJpZXMoKSkpIHtcblx0XHRcdGlmIChub3cgLSBjbGllbnQubGFzdEFjdGl2aXR5ID4gaWRsZVRpbWVvdXRNcykge1xuXHRcdFx0XHRzaHV0ZG93bkNsaWVudChrZXkpO1xuXHRcdFx0fVxuXHRcdH1cblx0XHQvLyBTdG9wIHRoZSBjaGVja2VyIGlmIHRoZXJlIGFyZSBubyBtb3JlIGNsaWVudHMgdG8gbW9uaXRvclxuXHRcdGlmIChjbGllbnRzLnNpemUgPT09IDApIHtcblx0XHRcdHN0b3BJZGxlQ2hlY2tlcigpO1xuXHRcdH1cblx0fSwgSURMRV9DSEVDS19JTlRFUlZBTF9NUyk7XG59XG5cbmZ1bmN0aW9uIHN0b3BJZGxlQ2hlY2tlcigpOiB2b2lkIHtcblx0aWYgKGlkbGVDaGVja0ludGVydmFsKSB7XG5cdFx0Y2xlYXJJbnRlcnZhbChpZGxlQ2hlY2tJbnRlcnZhbCk7XG5cdFx0aWRsZUNoZWNrSW50ZXJ2YWwgPSBudWxsO1xuXHR9XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBDbGllbnQgQ2FwYWJpbGl0aWVzXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5jb25zdCBDTElFTlRfQ0FQQUJJTElUSUVTID0ge1xuXHR0ZXh0RG9jdW1lbnQ6IHtcblx0XHRzeW5jaHJvbml6YXRpb246IHtcblx0XHRcdGRpZFNhdmU6IHRydWUsXG5cdFx0XHRkeW5hbWljUmVnaXN0cmF0aW9uOiBmYWxzZSxcblx0XHRcdHdpbGxTYXZlOiBmYWxzZSxcblx0XHRcdHdpbGxTYXZlV2FpdFVudGlsOiBmYWxzZSxcblx0XHR9LFxuXHRcdGhvdmVyOiB7XG5cdFx0XHRjb250ZW50Rm9ybWF0OiBbXCJtYXJrZG93blwiLCBcInBsYWludGV4dFwiXSxcblx0XHRcdGR5bmFtaWNSZWdpc3RyYXRpb246IGZhbHNlLFxuXHRcdH0sXG5cdFx0ZGVmaW5pdGlvbjoge1xuXHRcdFx0ZHluYW1pY1JlZ2lzdHJhdGlvbjogZmFsc2UsXG5cdFx0XHRsaW5rU3VwcG9ydDogdHJ1ZSxcblx0XHR9LFxuXHRcdHR5cGVEZWZpbml0aW9uOiB7XG5cdFx0XHRkeW5hbWljUmVnaXN0cmF0aW9uOiBmYWxzZSxcblx0XHRcdGxpbmtTdXBwb3J0OiB0cnVlLFxuXHRcdH0sXG5cdFx0aW1wbGVtZW50YXRpb246IHtcblx0XHRcdGR5bmFtaWNSZWdpc3RyYXRpb246IGZhbHNlLFxuXHRcdFx0bGlua1N1cHBvcnQ6IHRydWUsXG5cdFx0fSxcblx0XHRyZWZlcmVuY2VzOiB7XG5cdFx0XHRkeW5hbWljUmVnaXN0cmF0aW9uOiBmYWxzZSxcblx0XHR9LFxuXHRcdGRvY3VtZW50U3ltYm9sOiB7XG5cdFx0XHRkeW5hbWljUmVnaXN0cmF0aW9uOiBmYWxzZSxcblx0XHRcdGhpZXJhcmNoaWNhbERvY3VtZW50U3ltYm9sU3VwcG9ydDogdHJ1ZSxcblx0XHRcdHN5bWJvbEtpbmQ6IHtcblx0XHRcdFx0dmFsdWVTZXQ6IFsxLCAyLCAzLCA0LCA1LCA2LCA3LCA4LCA5LCAxMCwgMTEsIDEyLCAxMywgMTQsIDE1LCAxNiwgMTcsIDE4LCAxOSwgMjAsIDIxLCAyMiwgMjMsIDI0LCAyNSwgMjZdLFxuXHRcdFx0fSxcblx0XHR9LFxuXHRcdHJlbmFtZToge1xuXHRcdFx0ZHluYW1pY1JlZ2lzdHJhdGlvbjogZmFsc2UsXG5cdFx0XHRwcmVwYXJlU3VwcG9ydDogdHJ1ZSxcblx0XHR9LFxuXHRcdGNvZGVBY3Rpb246IHtcblx0XHRcdGR5bmFtaWNSZWdpc3RyYXRpb246IGZhbHNlLFxuXHRcdFx0Y29kZUFjdGlvbkxpdGVyYWxTdXBwb3J0OiB7XG5cdFx0XHRcdGNvZGVBY3Rpb25LaW5kOiB7XG5cdFx0XHRcdFx0dmFsdWVTZXQ6IFtcblx0XHRcdFx0XHRcdFwicXVpY2tmaXhcIixcblx0XHRcdFx0XHRcdFwicmVmYWN0b3JcIixcblx0XHRcdFx0XHRcdFwicmVmYWN0b3IuZXh0cmFjdFwiLFxuXHRcdFx0XHRcdFx0XCJyZWZhY3Rvci5pbmxpbmVcIixcblx0XHRcdFx0XHRcdFwicmVmYWN0b3IucmV3cml0ZVwiLFxuXHRcdFx0XHRcdFx0XCJzb3VyY2VcIixcblx0XHRcdFx0XHRcdFwic291cmNlLm9yZ2FuaXplSW1wb3J0c1wiLFxuXHRcdFx0XHRcdFx0XCJzb3VyY2UuZml4QWxsXCIsXG5cdFx0XHRcdFx0XSxcblx0XHRcdFx0fSxcblx0XHRcdH0sXG5cdFx0XHRyZXNvbHZlU3VwcG9ydDoge1xuXHRcdFx0XHRwcm9wZXJ0aWVzOiBbXCJlZGl0XCJdLFxuXHRcdFx0fSxcblx0XHR9LFxuXHRcdGNhbGxIaWVyYXJjaHk6IHtcblx0XHRcdGR5bmFtaWNSZWdpc3RyYXRpb246IGZhbHNlLFxuXHRcdH0sXG5cdFx0c2lnbmF0dXJlSGVscDoge1xuXHRcdFx0ZHluYW1pY1JlZ2lzdHJhdGlvbjogZmFsc2UsXG5cdFx0XHRzaWduYXR1cmVJbmZvcm1hdGlvbjoge1xuXHRcdFx0XHRkb2N1bWVudGF0aW9uRm9ybWF0OiBbXCJtYXJrZG93blwiLCBcInBsYWludGV4dFwiXSxcblx0XHRcdFx0cGFyYW1ldGVySW5mb3JtYXRpb246IHtcblx0XHRcdFx0XHRsYWJlbE9mZnNldFN1cHBvcnQ6IHRydWUsXG5cdFx0XHRcdH0sXG5cdFx0XHR9LFxuXHRcdH0sXG5cdFx0Zm9ybWF0dGluZzoge1xuXHRcdFx0ZHluYW1pY1JlZ2lzdHJhdGlvbjogZmFsc2UsXG5cdFx0fSxcblx0XHRyYW5nZUZvcm1hdHRpbmc6IHtcblx0XHRcdGR5bmFtaWNSZWdpc3RyYXRpb246IGZhbHNlLFxuXHRcdH0sXG5cdFx0cHVibGlzaERpYWdub3N0aWNzOiB7XG5cdFx0XHRyZWxhdGVkSW5mb3JtYXRpb246IHRydWUsXG5cdFx0XHR2ZXJzaW9uU3VwcG9ydDogZmFsc2UsXG5cdFx0XHR0YWdTdXBwb3J0OiB7IHZhbHVlU2V0OiBbMSwgMl0gfSxcblx0XHRcdGNvZGVEZXNjcmlwdGlvblN1cHBvcnQ6IHRydWUsXG5cdFx0XHRkYXRhU3VwcG9ydDogdHJ1ZSxcblx0XHR9LFxuXHR9LFxuXHR3b3Jrc3BhY2U6IHtcblx0XHRhcHBseUVkaXQ6IHRydWUsXG5cdFx0d29ya3NwYWNlRWRpdDoge1xuXHRcdFx0ZG9jdW1lbnRDaGFuZ2VzOiB0cnVlLFxuXHRcdFx0cmVzb3VyY2VPcGVyYXRpb25zOiBbXCJjcmVhdGVcIiwgXCJyZW5hbWVcIiwgXCJkZWxldGVcIl0sXG5cdFx0XHRmYWlsdXJlSGFuZGxpbmc6IFwidGV4dE9ubHlUcmFuc2FjdGlvbmFsXCIsXG5cdFx0fSxcblx0XHRjb25maWd1cmF0aW9uOiB0cnVlLFxuXHRcdHN5bWJvbDoge1xuXHRcdFx0ZHluYW1pY1JlZ2lzdHJhdGlvbjogZmFsc2UsXG5cdFx0XHRzeW1ib2xLaW5kOiB7XG5cdFx0XHRcdHZhbHVlU2V0OiBbMSwgMiwgMywgNCwgNSwgNiwgNywgOCwgOSwgMTAsIDExLCAxMiwgMTMsIDE0LCAxNSwgMTYsIDE3LCAxOCwgMTksIDIwLCAyMSwgMjIsIDIzLCAyNCwgMjUsIDI2XSxcblx0XHRcdH0sXG5cdFx0fSxcblx0fSxcblx0ZXhwZXJpbWVudGFsOiB7XG5cdFx0c25pcHBldFRleHRFZGl0OiB0cnVlLFxuXHR9LFxufTtcblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIExTUCBNZXNzYWdlIFByb3RvY29sXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5mdW5jdGlvbiBwYXJzZU1lc3NhZ2UoXG5cdGJ1ZmZlcjogQnVmZmVyLFxuKTogeyBtZXNzYWdlOiBMc3BKc29uUnBjUmVzcG9uc2UgfCBMc3BKc29uUnBjTm90aWZpY2F0aW9uIHwgbnVsbDsgcmVtYWluaW5nOiBCdWZmZXIgfSB8IG51bGwge1xuXHRjb25zdCBoZWFkZXJFbmRJbmRleCA9IGZpbmRIZWFkZXJFbmQoYnVmZmVyKTtcblx0aWYgKGhlYWRlckVuZEluZGV4ID09PSAtMSkgcmV0dXJuIG51bGw7XG5cblx0Y29uc3QgaGVhZGVyVGV4dCA9IG5ldyBUZXh0RGVjb2RlcigpLmRlY29kZShidWZmZXIuc2xpY2UoMCwgaGVhZGVyRW5kSW5kZXgpKTtcblx0Y29uc3QgY29udGVudExlbmd0aE1hdGNoID0gaGVhZGVyVGV4dC5tYXRjaCgvQ29udGVudC1MZW5ndGg6IChcXGQrKS9pKTtcblx0aWYgKCFjb250ZW50TGVuZ3RoTWF0Y2gpIHJldHVybiBudWxsO1xuXG5cdGNvbnN0IGNvbnRlbnRMZW5ndGggPSBOdW1iZXIucGFyc2VJbnQoY29udGVudExlbmd0aE1hdGNoWzFdLCAxMCk7XG5cdGNvbnN0IG1lc3NhZ2VTdGFydCA9IGhlYWRlckVuZEluZGV4ICsgNDsgLy8gU2tpcCBcXHJcXG5cXHJcXG5cblx0Y29uc3QgbWVzc2FnZUVuZCA9IG1lc3NhZ2VTdGFydCArIGNvbnRlbnRMZW5ndGg7XG5cblx0aWYgKGJ1ZmZlci5sZW5ndGggPCBtZXNzYWdlRW5kKSByZXR1cm4gbnVsbDtcblxuXHRjb25zdCBtZXNzYWdlQnl0ZXMgPSBidWZmZXIuc3ViYXJyYXkobWVzc2FnZVN0YXJ0LCBtZXNzYWdlRW5kKTtcblx0Y29uc3QgbWVzc2FnZVRleHQgPSBuZXcgVGV4dERlY29kZXIoKS5kZWNvZGUobWVzc2FnZUJ5dGVzKTtcblx0Y29uc3QgcmVtYWluaW5nID0gQnVmZmVyLmZyb20oYnVmZmVyLnN1YmFycmF5KG1lc3NhZ2VFbmQpKTtcblxuXHRsZXQgbWVzc2FnZTogTHNwSnNvblJwY1Jlc3BvbnNlIHwgTHNwSnNvblJwY05vdGlmaWNhdGlvbjtcblx0dHJ5IHtcblx0XHRtZXNzYWdlID0gSlNPTi5wYXJzZShtZXNzYWdlVGV4dCk7XG5cdH0gY2F0Y2ggKGVycikge1xuXHRcdC8vIE1hbGZvcm1lZCBKU09OIGZyb20gTFNQIHNlcnZlciBcdTIwMTQgbG9nIGFuZCBza2lwIHRoaXMgbWVzc2FnZVxuXHRcdGlmIChwcm9jZXNzLmVudi5ERUJVRykge1xuXHRcdFx0Y29uc3QgcHJldmlldyA9IG1lc3NhZ2VUZXh0Lmxlbmd0aCA+IDIwMCA/IG1lc3NhZ2VUZXh0LnNsaWNlKDAsIDIwMCkgKyBcIi4uLlwiIDogbWVzc2FnZVRleHQ7XG5cdFx0XHRjb25zb2xlLmVycm9yKGBbbHNwXSBEcm9wcGVkIG1hbGZvcm1lZCBKU09OIG1lc3NhZ2U6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IGVycn0gXHUyMDE0ICR7cHJldmlld31gKTtcblx0XHR9XG5cdFx0cmV0dXJuIHsgbWVzc2FnZTogbnVsbCwgcmVtYWluaW5nIH07XG5cdH1cblxuXHRyZXR1cm4geyBtZXNzYWdlLCByZW1haW5pbmcgfTtcbn1cblxuZnVuY3Rpb24gZmluZEhlYWRlckVuZChidWZmZXI6IFVpbnQ4QXJyYXkpOiBudW1iZXIge1xuXHRmb3IgKGxldCBpID0gMDsgaSA8IGJ1ZmZlci5sZW5ndGggLSAzOyBpKyspIHtcblx0XHRpZiAoYnVmZmVyW2ldID09PSAxMyAmJiBidWZmZXJbaSArIDFdID09PSAxMCAmJiBidWZmZXJbaSArIDJdID09PSAxMyAmJiBidWZmZXJbaSArIDNdID09PSAxMCkge1xuXHRcdFx0cmV0dXJuIGk7XG5cdFx0fVxuXHR9XG5cdHJldHVybiAtMTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gd3JpdGVNZXNzYWdlKFxuXHRzdGRpbjogV3JpdGFibGUgfCBudWxsLFxuXHRtZXNzYWdlOiBMc3BKc29uUnBjUmVxdWVzdCB8IExzcEpzb25ScGNOb3RpZmljYXRpb24gfCBMc3BKc29uUnBjUmVzcG9uc2UsXG4pOiBQcm9taXNlPHZvaWQ+IHtcblx0aWYgKCFzdGRpbikge1xuXHRcdHRocm93IG5ldyBFcnJvcihcIkxTUCBwcm9jZXNzIHN0ZGluIGlzIG5vdCBhdmFpbGFibGVcIik7XG5cdH1cblx0Y29uc3QgY29udGVudCA9IEpTT04uc3RyaW5naWZ5KG1lc3NhZ2UpO1xuXHRjb25zdCBoZWFkZXIgPSBgQ29udGVudC1MZW5ndGg6ICR7QnVmZmVyLmJ5dGVMZW5ndGgoY29udGVudCwgXCJ1dGYtOFwiKX1cXHJcXG5cXHJcXG5gO1xuXHRyZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuXHRcdHN0ZGluLndyaXRlKGhlYWRlciArIGNvbnRlbnQsIChlcnI/OiBFcnJvciB8IG51bGwpID0+IHtcblx0XHRcdGlmIChlcnIpIHJlamVjdChlcnIpO1xuXHRcdFx0ZWxzZSByZXNvbHZlKCk7XG5cdFx0fSk7XG5cdH0pO1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gTWVzc2FnZSBSZWFkZXJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmFzeW5jIGZ1bmN0aW9uIHN0YXJ0TWVzc2FnZVJlYWRlcihjbGllbnQ6IExzcENsaWVudCk6IFByb21pc2U8dm9pZD4ge1xuXHRpZiAoY2xpZW50LmlzUmVhZGluZykgcmV0dXJuO1xuXHRjbGllbnQuaXNSZWFkaW5nID0gdHJ1ZTtcblxuXHRjb25zdCBzdGRvdXQgPSBjbGllbnQucHJvYy5zdGRvdXQ7XG5cdGlmICghc3Rkb3V0KSB7XG5cdFx0Y2xpZW50LmlzUmVhZGluZyA9IGZhbHNlO1xuXHRcdHJldHVybjtcblx0fVxuXG5cdHJldHVybiBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4ge1xuXHRcdGNvbnN0IGhhbmRsZXJzID0gY2xpZW50U3RyZWFtSGFuZGxlcnMuZ2V0KGNsaWVudC5uYW1lKSA/PyB7fTtcblxuXHRcdGhhbmRsZXJzLnN0ZG91dERhdGEgPSBhc3luYyAoY2h1bms6IEJ1ZmZlcikgPT4ge1xuXHRcdFx0Y29uc3QgY3VycmVudEJ1ZmZlcjogQnVmZmVyID0gQnVmZmVyLmNvbmNhdChbY2xpZW50Lm1lc3NhZ2VCdWZmZXIsIGNodW5rXSk7XG5cblx0XHRcdGlmIChjdXJyZW50QnVmZmVyLmxlbmd0aCA+IE1BWF9NRVNTQUdFX0JVRkZFUl9TSVpFKSB7XG5cdFx0XHRcdGlmIChwcm9jZXNzLmVudi5ERUJVRykge1xuXHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoXG5cdFx0XHRcdFx0XHRgW2xzcF0gTWVzc2FnZSBidWZmZXIgZXhjZWVkZWQgJHtNQVhfTUVTU0FHRV9CVUZGRVJfU0laRX0gYnl0ZXMgKCR7Y3VycmVudEJ1ZmZlci5sZW5ndGh9KSwgZGlzY2FyZGluZ2AsXG5cdFx0XHRcdFx0KTtcblx0XHRcdFx0fVxuXHRcdFx0XHRjbGllbnQubWVzc2FnZUJ1ZmZlciA9IEJ1ZmZlci5hbGxvYygwKTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXG5cdFx0XHRjbGllbnQubWVzc2FnZUJ1ZmZlciA9IGN1cnJlbnRCdWZmZXI7XG5cblx0XHRcdGxldCB3b3JraW5nQnVmZmVyID0gY3VycmVudEJ1ZmZlcjtcblx0XHRcdGxldCBwYXJzZWQgPSBwYXJzZU1lc3NhZ2Uod29ya2luZ0J1ZmZlcik7XG5cdFx0XHR3aGlsZSAocGFyc2VkKSB7XG5cdFx0XHRcdGNvbnN0IHsgbWVzc2FnZSwgcmVtYWluaW5nIH0gPSBwYXJzZWQ7XG5cdFx0XHRcdHdvcmtpbmdCdWZmZXIgPSByZW1haW5pbmc7XG5cblx0XHRcdFx0aWYgKCFtZXNzYWdlKSB7XG5cdFx0XHRcdFx0cGFyc2VkID0gcGFyc2VNZXNzYWdlKHdvcmtpbmdCdWZmZXIpO1xuXHRcdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0aWYgKFwiaWRcIiBpbiBtZXNzYWdlICYmIG1lc3NhZ2UuaWQgIT09IHVuZGVmaW5lZCkge1xuXHRcdFx0XHRcdGNvbnN0IHBlbmRpbmcgPSBjbGllbnQucGVuZGluZ1JlcXVlc3RzLmdldChtZXNzYWdlLmlkKTtcblx0XHRcdFx0XHRpZiAocGVuZGluZykge1xuXHRcdFx0XHRcdFx0Y2xpZW50LnBlbmRpbmdSZXF1ZXN0cy5kZWxldGUobWVzc2FnZS5pZCk7XG5cdFx0XHRcdFx0XHRpZiAoXCJlcnJvclwiIGluIG1lc3NhZ2UgJiYgbWVzc2FnZS5lcnJvcikge1xuXHRcdFx0XHRcdFx0XHRwZW5kaW5nLnJlamVjdChuZXcgRXJyb3IoYExTUCBlcnJvcjogJHttZXNzYWdlLmVycm9yLm1lc3NhZ2V9YCkpO1xuXHRcdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdFx0cGVuZGluZy5yZXNvbHZlKG1lc3NhZ2UucmVzdWx0KTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9IGVsc2UgaWYgKFwibWV0aG9kXCIgaW4gbWVzc2FnZSkge1xuXHRcdFx0XHRcdFx0YXdhaXQgaGFuZGxlU2VydmVyUmVxdWVzdChjbGllbnQsIG1lc3NhZ2UgYXMgTHNwSnNvblJwY1JlcXVlc3QpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fSBlbHNlIGlmIChcIm1ldGhvZFwiIGluIG1lc3NhZ2UpIHtcblx0XHRcdFx0XHRpZiAobWVzc2FnZS5tZXRob2QgPT09IFwidGV4dERvY3VtZW50L3B1Ymxpc2hEaWFnbm9zdGljc1wiICYmIG1lc3NhZ2UucGFyYW1zKSB7XG5cdFx0XHRcdFx0XHRjb25zdCBwYXJhbXMgPSBtZXNzYWdlLnBhcmFtcyBhcyB7IHVyaTogc3RyaW5nOyBkaWFnbm9zdGljczogRGlhZ25vc3RpY1tdIH07XG5cdFx0XHRcdFx0XHRjbGllbnQuZGlhZ25vc3RpY3Muc2V0KHBhcmFtcy51cmksIHBhcmFtcy5kaWFnbm9zdGljcyk7XG5cdFx0XHRcdFx0XHRjbGllbnQuZGlhZ25vc3RpY3NWZXJzaW9uICs9IDE7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cblx0XHRcdFx0cGFyc2VkID0gcGFyc2VNZXNzYWdlKHdvcmtpbmdCdWZmZXIpO1xuXHRcdFx0fVxuXG5cdFx0XHRjbGllbnQubWVzc2FnZUJ1ZmZlciA9IHdvcmtpbmdCdWZmZXI7XG5cdFx0fTtcblx0XHRzdGRvdXQub24oXCJkYXRhXCIsIGhhbmRsZXJzLnN0ZG91dERhdGEpO1xuXG5cdFx0aGFuZGxlcnMuc3Rkb3V0RW5kID0gKCkgPT4ge1xuXHRcdFx0Y2xpZW50LmlzUmVhZGluZyA9IGZhbHNlO1xuXHRcdFx0cmVzb2x2ZSgpO1xuXHRcdH07XG5cdFx0c3Rkb3V0Lm9uKFwiZW5kXCIsIGhhbmRsZXJzLnN0ZG91dEVuZCk7XG5cblx0XHRoYW5kbGVycy5zdGRvdXRFcnJvciA9ICgpID0+IHtcblx0XHRcdGNsaWVudC5pc1JlYWRpbmcgPSBmYWxzZTtcblx0XHRcdHJlc29sdmUoKTtcblx0XHR9O1xuXHRcdHN0ZG91dC5vbihcImVycm9yXCIsIGhhbmRsZXJzLnN0ZG91dEVycm9yKTtcblxuXHRcdGNsaWVudFN0cmVhbUhhbmRsZXJzLnNldChjbGllbnQubmFtZSwgaGFuZGxlcnMpO1xuXHR9KTtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFNlcnZlciBSZXF1ZXN0IEhhbmRsZXJzXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVDb25maWd1cmF0aW9uUmVxdWVzdChjbGllbnQ6IExzcENsaWVudCwgbWVzc2FnZTogTHNwSnNvblJwY1JlcXVlc3QpOiBQcm9taXNlPHZvaWQ+IHtcblx0aWYgKHR5cGVvZiBtZXNzYWdlLmlkICE9PSBcIm51bWJlclwiKSByZXR1cm47XG5cdGNvbnN0IHBhcmFtcyA9IG1lc3NhZ2UucGFyYW1zIGFzIHsgaXRlbXM/OiBBcnJheTx7IHNlY3Rpb24/OiBzdHJpbmcgfT4gfTtcblx0Y29uc3QgaXRlbXMgPSBwYXJhbXM/Lml0ZW1zID8/IFtdO1xuXHRjb25zdCByZXN1bHQgPSBpdGVtcy5tYXAoaXRlbSA9PiB7XG5cdFx0Y29uc3Qgc2VjdGlvbiA9IGl0ZW0uc2VjdGlvbiA/PyBcIlwiO1xuXHRcdHJldHVybiBjbGllbnQuY29uZmlnLnNldHRpbmdzPy5bc2VjdGlvbl0gPz8ge307XG5cdH0pO1xuXHRhd2FpdCBzZW5kUmVzcG9uc2UoY2xpZW50LCBtZXNzYWdlLmlkLCByZXN1bHQsIFwid29ya3NwYWNlL2NvbmZpZ3VyYXRpb25cIik7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZUFwcGx5RWRpdFJlcXVlc3QoY2xpZW50OiBMc3BDbGllbnQsIG1lc3NhZ2U6IExzcEpzb25ScGNSZXF1ZXN0KTogUHJvbWlzZTx2b2lkPiB7XG5cdGlmICh0eXBlb2YgbWVzc2FnZS5pZCAhPT0gXCJudW1iZXJcIikgcmV0dXJuO1xuXHRjb25zdCBwYXJhbXMgPSBtZXNzYWdlLnBhcmFtcyBhcyB7IGVkaXQ/OiBXb3Jrc3BhY2VFZGl0IH07XG5cdGlmICghcGFyYW1zPy5lZGl0KSB7XG5cdFx0YXdhaXQgc2VuZFJlc3BvbnNlKFxuXHRcdFx0Y2xpZW50LFxuXHRcdFx0bWVzc2FnZS5pZCxcblx0XHRcdHsgYXBwbGllZDogZmFsc2UsIGZhaWx1cmVSZWFzb246IFwiTm8gZWRpdCBwcm92aWRlZFwiIH0sXG5cdFx0XHRcIndvcmtzcGFjZS9hcHBseUVkaXRcIixcblx0XHQpO1xuXHRcdHJldHVybjtcblx0fVxuXG5cdHRyeSB7XG5cdFx0YXdhaXQgYXBwbHlXb3Jrc3BhY2VFZGl0KHBhcmFtcy5lZGl0LCBjbGllbnQuY3dkKTtcblx0XHRhd2FpdCBzZW5kUmVzcG9uc2UoY2xpZW50LCBtZXNzYWdlLmlkLCB7IGFwcGxpZWQ6IHRydWUgfSwgXCJ3b3Jrc3BhY2UvYXBwbHlFZGl0XCIpO1xuXHR9IGNhdGNoIChlcnI6IHVua25vd24pIHtcblx0XHRhd2FpdCBzZW5kUmVzcG9uc2UoY2xpZW50LCBtZXNzYWdlLmlkLCB7IGFwcGxpZWQ6IGZhbHNlLCBmYWlsdXJlUmVhc29uOiBTdHJpbmcoZXJyKSB9LCBcIndvcmtzcGFjZS9hcHBseUVkaXRcIik7XG5cdH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gaGFuZGxlU2VydmVyUmVxdWVzdChjbGllbnQ6IExzcENsaWVudCwgbWVzc2FnZTogTHNwSnNvblJwY1JlcXVlc3QpOiBQcm9taXNlPHZvaWQ+IHtcblx0aWYgKG1lc3NhZ2UubWV0aG9kID09PSBcIndvcmtzcGFjZS9jb25maWd1cmF0aW9uXCIpIHtcblx0XHRhd2FpdCBoYW5kbGVDb25maWd1cmF0aW9uUmVxdWVzdChjbGllbnQsIG1lc3NhZ2UpO1xuXHRcdHJldHVybjtcblx0fVxuXHRpZiAobWVzc2FnZS5tZXRob2QgPT09IFwid29ya3NwYWNlL2FwcGx5RWRpdFwiKSB7XG5cdFx0YXdhaXQgaGFuZGxlQXBwbHlFZGl0UmVxdWVzdChjbGllbnQsIG1lc3NhZ2UpO1xuXHRcdHJldHVybjtcblx0fVxuXHRpZiAodHlwZW9mIG1lc3NhZ2UuaWQgIT09IFwibnVtYmVyXCIpIHJldHVybjtcblx0YXdhaXQgc2VuZFJlc3BvbnNlKGNsaWVudCwgbWVzc2FnZS5pZCwgbnVsbCwgbWVzc2FnZS5tZXRob2QsIHtcblx0XHRjb2RlOiAtMzI2MDEsXG5cdFx0bWVzc2FnZTogYE1ldGhvZCBub3QgZm91bmQ6ICR7bWVzc2FnZS5tZXRob2R9YCxcblx0fSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHNlbmRSZXNwb25zZShcblx0Y2xpZW50OiBMc3BDbGllbnQsXG5cdGlkOiBudW1iZXIsXG5cdHJlc3VsdDogdW5rbm93bixcblx0X21ldGhvZDogc3RyaW5nLFxuXHRlcnJvcj86IHsgY29kZTogbnVtYmVyOyBtZXNzYWdlOiBzdHJpbmc7IGRhdGE/OiB1bmtub3duIH0sXG4pOiBQcm9taXNlPHZvaWQ+IHtcblx0Y29uc3QgcmVzcG9uc2U6IExzcEpzb25ScGNSZXNwb25zZSA9IHtcblx0XHRqc29ucnBjOiBcIjIuMFwiLFxuXHRcdGlkLFxuXHRcdC4uLihlcnJvciA/IHsgZXJyb3IgfSA6IHsgcmVzdWx0IH0pLFxuXHR9O1xuXG5cdHRyeSB7XG5cdFx0YXdhaXQgd3JpdGVNZXNzYWdlKGNsaWVudC5wcm9jLnN0ZGluLCByZXNwb25zZSk7XG5cdH0gY2F0Y2gge1xuXHRcdC8vIEZhaWxlZCB0byByZXNwb25kIHRvIHNlcnZlciByZXF1ZXN0XG5cdH1cbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFN0ZGVyciBCdWZmZXJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmFzeW5jIGZ1bmN0aW9uIHN0YXJ0U3RkZXJyUmVhZGVyKGNsaWVudDogTHNwQ2xpZW50KTogUHJvbWlzZTx2b2lkPiB7XG5cdGNvbnN0IHN0ZGVyciA9IGNsaWVudC5wcm9jLnN0ZGVycjtcblx0aWYgKCFzdGRlcnIpIHJldHVybjtcblxuXHRyZXR1cm4gbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUpID0+IHtcblx0XHRjb25zdCBoYW5kbGVycyA9IGNsaWVudFN0cmVhbUhhbmRsZXJzLmdldChjbGllbnQubmFtZSkgPz8ge307XG5cblx0XHRoYW5kbGVycy5zdGRlcnJEYXRhID0gKGNodW5rOiBCdWZmZXIpID0+IHtcblx0XHRcdGNvbnN0IHRleHQgPSBjaHVuay50b1N0cmluZyhcInV0Zi04XCIpO1xuXHRcdFx0Y2xpZW50LnN0ZGVyckJ1ZmZlciArPSB0ZXh0O1xuXHRcdFx0aWYgKGNsaWVudC5zdGRlcnJCdWZmZXIubGVuZ3RoID4gNDA5Nikge1xuXHRcdFx0XHRjbGllbnQuc3RkZXJyQnVmZmVyID0gY2xpZW50LnN0ZGVyckJ1ZmZlci5zbGljZSgtNDA5Nik7XG5cdFx0XHR9XG5cdFx0fTtcblx0XHRzdGRlcnIub24oXCJkYXRhXCIsIGhhbmRsZXJzLnN0ZGVyckRhdGEpO1xuXG5cdFx0aGFuZGxlcnMuc3RkZXJyRW5kID0gKCkgPT4ge1xuXHRcdFx0cmVzb2x2ZSgpO1xuXHRcdH07XG5cdFx0c3RkZXJyLm9uKFwiZW5kXCIsIGhhbmRsZXJzLnN0ZGVyckVuZCk7XG5cblx0XHRoYW5kbGVycy5zdGRlcnJFcnJvciA9ICgpID0+IHtcblx0XHRcdHJlc29sdmUoKTtcblx0XHR9O1xuXHRcdHN0ZGVyci5vbihcImVycm9yXCIsIGhhbmRsZXJzLnN0ZGVyckVycm9yKTtcblxuXHRcdGNsaWVudFN0cmVhbUhhbmRsZXJzLnNldChjbGllbnQubmFtZSwgaGFuZGxlcnMpO1xuXHR9KTtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIENsaWVudCBNYW5hZ2VtZW50XG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4vKiogVGltZW91dCBmb3Igd2FybXVwIGluaXRpYWxpemUgcmVxdWVzdHMgKDUgc2Vjb25kcykgKi9cbmV4cG9ydCBjb25zdCBXQVJNVVBfVElNRU9VVF9NUyA9IDUwMDA7XG5cbi8qKlxuICogR2V0IG9yIGNyZWF0ZSBhbiBMU1AgY2xpZW50IGZvciB0aGUgZ2l2ZW4gc2VydmVyIGNvbmZpZ3VyYXRpb24gYW5kIHdvcmtpbmcgZGlyZWN0b3J5LlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2V0T3JDcmVhdGVDbGllbnQoY29uZmlnOiBTZXJ2ZXJDb25maWcsIGN3ZDogc3RyaW5nLCBpbml0VGltZW91dE1zPzogbnVtYmVyKTogUHJvbWlzZTxMc3BDbGllbnQ+IHtcblx0Y29uc3QgbWF4UmV0cmllcyA9IDI7XG5cdGxldCBsYXN0RXJyOiB1bmtub3duO1xuXHRmb3IgKGxldCBhdHRlbXB0ID0gMDsgYXR0ZW1wdCA8PSBtYXhSZXRyaWVzOyBhdHRlbXB0KyspIHtcblx0XHR0cnkge1xuXHRcdFx0cmV0dXJuIGF3YWl0IGdldE9yQ3JlYXRlQ2xpZW50T25jZShjb25maWcsIGN3ZCwgaW5pdFRpbWVvdXRNcyk7XG5cdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHRsYXN0RXJyID0gZXJyO1xuXHRcdFx0aWYgKGF0dGVtcHQgPCBtYXhSZXRyaWVzKSB7XG5cdFx0XHRcdGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIDEwMDAgKiAoYXR0ZW1wdCArIDEpKSk7XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG5cdHRocm93IGxhc3RFcnI7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGdldE9yQ3JlYXRlQ2xpZW50T25jZShjb25maWc6IFNlcnZlckNvbmZpZywgY3dkOiBzdHJpbmcsIGluaXRUaW1lb3V0TXM/OiBudW1iZXIpOiBQcm9taXNlPExzcENsaWVudD4ge1xuXHRjb25zdCBrZXkgPSBgJHtjb25maWcuY29tbWFuZH06JHtjd2R9YDtcblxuXHRjb25zdCBleGlzdGluZ0NsaWVudCA9IGNsaWVudHMuZ2V0KGtleSk7XG5cdGlmIChleGlzdGluZ0NsaWVudCkge1xuXHRcdGV4aXN0aW5nQ2xpZW50Lmxhc3RBY3Rpdml0eSA9IERhdGUubm93KCk7XG5cdFx0cmV0dXJuIGV4aXN0aW5nQ2xpZW50O1xuXHR9XG5cblx0Y29uc3QgZXhpc3RpbmdMb2NrID0gY2xpZW50TG9ja3MuZ2V0KGtleSk7XG5cdGlmIChleGlzdGluZ0xvY2spIHtcblx0XHRyZXR1cm4gZXhpc3RpbmdMb2NrO1xuXHR9XG5cblx0Y29uc3QgY2xpZW50UHJvbWlzZSA9IChhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3QgYmFzZUNvbW1hbmQgPSBjb25maWcucmVzb2x2ZWRDb21tYW5kID8/IGNvbmZpZy5jb21tYW5kO1xuXHRcdGNvbnN0IGJhc2VBcmdzID0gY29uZmlnLmFyZ3MgPz8gW107XG5cblx0XHQvLyBXcmFwIHdpdGggbHNwbXV4IGlmIGF2YWlsYWJsZSBhbmQgc3VwcG9ydGVkXG5cdFx0Y29uc3QgeyBjb21tYW5kLCBhcmdzLCBlbnYgfSA9IGlzTHNwbXV4U3VwcG9ydGVkKGJhc2VDb21tYW5kKVxuXHRcdFx0PyBhd2FpdCBnZXRMc3BtdXhDb21tYW5kKGJhc2VDb21tYW5kLCBiYXNlQXJncylcblx0XHRcdDogeyBjb21tYW5kOiBiYXNlQ29tbWFuZCwgYXJnczogYmFzZUFyZ3MgfTtcblxuXHRcdGNvbnN0IHByb2MgPSBzcGF3bihjb21tYW5kLCBhcmdzLCB7XG5cdFx0XHRjd2QsXG5cdFx0XHRzdGRpbzogW1wicGlwZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdLFxuXHRcdFx0ZW52OiBlbnYgPyB7IC4uLnByb2Nlc3MuZW52LCAuLi5lbnYgfSA6IHVuZGVmaW5lZCxcblx0XHRcdC8vIE9uIFdpbmRvd3MsIGV4ZWN1dGFibGVzIGxpa2UgbnB4L3RzYyBhcmUgLmNtZCBzY3JpcHRzIHRoYXQgbmVlZFxuXHRcdFx0Ly8gc2hlbGwgcmVzb2x1dGlvbi4gV2l0aG91dCB0aGlzLCBzcGF3biBmYWlscyB3aXRoIEVOT0VOVCAoIzEyMjIpLlxuXHRcdFx0c2hlbGw6IHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIixcblx0XHR9KTtcblxuXHRcdC8vIEhhbmRsZSBzcGF3biBmYWlsdXJlIChlLmcuLCBFTk9FTlQgd2hlbiB0aGUgY29tbWFuZCBkb2Vzbid0IGV4aXN0KS5cblx0XHQvLyBXaXRob3V0IHRoaXMsIHRoZSBlcnJvciBidWJibGVzIHVwIGFuZCBjYW4gY3Jhc2ggYXV0by1tb2RlICgjOTAxKS5cblx0XHRwcm9jLm9uKFwiZXJyb3JcIiwgKGVycjogTm9kZUpTLkVycm5vRXhjZXB0aW9uKSA9PiB7XG5cdFx0XHRpZiAoZXJyLmNvZGUgPT09IFwiRU5PRU5UXCIpIHtcblx0XHRcdFx0cHJvYy5lbWl0KFwiZXhpdFwiLCAxKTtcblx0XHRcdH1cblx0XHR9KTtcblxuXHRcdGNvbnN0IGV4aXRlZFByb21pc2UgPSBuZXcgUHJvbWlzZTxudW1iZXI+KChyZXNvbHZlKSA9PiB7XG5cdFx0XHRwcm9jLm9uKFwiZXhpdFwiLCAoY29kZTogbnVtYmVyIHwgbnVsbCkgPT4gcmVzb2x2ZShjb2RlID8/IDEpKTtcblx0XHR9KTtcblxuXHRcdGNvbnN0IGNsaWVudDogTHNwQ2xpZW50ID0ge1xuXHRcdFx0bmFtZToga2V5LFxuXHRcdFx0Y3dkLFxuXHRcdFx0cHJvYzoge1xuXHRcdFx0XHRzdGRpbjogcHJvYy5zdGRpbixcblx0XHRcdFx0c3Rkb3V0OiBwcm9jLnN0ZG91dCxcblx0XHRcdFx0c3RkZXJyOiBwcm9jLnN0ZGVycixcblx0XHRcdFx0cGlkOiBwcm9jLnBpZCA/PyAwLFxuXHRcdFx0XHRleGl0Q29kZTogbnVsbCxcblx0XHRcdFx0ZXhpdGVkOiBleGl0ZWRQcm9taXNlLFxuXHRcdFx0XHRraWxsOiAoc2lnbmFsPzogbnVtYmVyKSA9PiBwcm9jLmtpbGwoc2lnbmFsKSxcblx0XHRcdH0sXG5cdFx0XHRjb25maWcsXG5cdFx0XHRyZXF1ZXN0SWQ6IDAsXG5cdFx0XHRkaWFnbm9zdGljczogbmV3IE1hcCgpLFxuXHRcdFx0ZGlhZ25vc3RpY3NWZXJzaW9uOiAwLFxuXHRcdFx0b3BlbkZpbGVzOiBuZXcgTWFwKCksXG5cdFx0XHRwZW5kaW5nUmVxdWVzdHM6IG5ldyBNYXAoKSxcblx0XHRcdG1lc3NhZ2VCdWZmZXI6IEJ1ZmZlci5hbGxvYygwKSxcblx0XHRcdGlzUmVhZGluZzogZmFsc2UsXG5cdFx0XHRsYXN0QWN0aXZpdHk6IERhdGUubm93KCksXG5cdFx0XHRzdGRlcnJCdWZmZXI6IFwiXCIsXG5cdFx0fTtcblx0XHRjbGllbnRzLnNldChrZXksIGNsaWVudCk7XG5cblx0XHQvLyBSZWdpc3RlciBjcmFzaCByZWNvdmVyeVxuXHRcdGV4aXRlZFByb21pc2UudGhlbigoY29kZTogbnVtYmVyKSA9PiB7XG5cdFx0XHRjbGllbnQucHJvYy5leGl0Q29kZSA9IGNvZGU7XG5cdFx0XHRjbGllbnRzLmRlbGV0ZShrZXkpO1xuXHRcdFx0Y2xpZW50TG9ja3MuZGVsZXRlKGtleSk7XG5cblx0XHRcdGlmIChjbGllbnQucGVuZGluZ1JlcXVlc3RzLnNpemUgPiAwKSB7XG5cdFx0XHRcdGNvbnN0IHN0ZGVyciA9IGNsaWVudC5zdGRlcnJCdWZmZXIudHJpbSgpO1xuXHRcdFx0XHRjb25zdCBlcnIgPSBuZXcgRXJyb3IoXG5cdFx0XHRcdFx0c3RkZXJyID8gYExTUCBzZXJ2ZXIgZXhpdGVkIChjb2RlICR7Y29kZX0pOiAke3N0ZGVycn1gIDogYExTUCBzZXJ2ZXIgZXhpdGVkIHVuZXhwZWN0ZWRseSAoY29kZSAke2NvZGV9KWAsXG5cdFx0XHRcdCk7XG5cdFx0XHRcdGZvciAoY29uc3QgcGVuZGluZyBvZiBjbGllbnQucGVuZGluZ1JlcXVlc3RzLnZhbHVlcygpKSB7XG5cdFx0XHRcdFx0cGVuZGluZy5yZWplY3QoZXJyKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRjbGllbnQucGVuZGluZ1JlcXVlc3RzLmNsZWFyKCk7XG5cdFx0XHR9XG5cdFx0fSk7XG5cblx0XHQvLyBTdGFydCBiYWNrZ3JvdW5kIHJlYWRlcnNcblx0XHRzdGFydE1lc3NhZ2VSZWFkZXIoY2xpZW50KTtcblx0XHRzdGFydFN0ZGVyclJlYWRlcihjbGllbnQpO1xuXG5cdFx0dHJ5IHtcblx0XHRcdGNvbnN0IGluaXRSZXN1bHQgPSAoYXdhaXQgc2VuZFJlcXVlc3QoXG5cdFx0XHRcdGNsaWVudCxcblx0XHRcdFx0XCJpbml0aWFsaXplXCIsXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRwcm9jZXNzSWQ6IHByb2Nlc3MucGlkLFxuXHRcdFx0XHRcdHJvb3RVcmk6IGZpbGVUb1VyaShjd2QpLFxuXHRcdFx0XHRcdHJvb3RQYXRoOiBjd2QsXG5cdFx0XHRcdFx0Y2FwYWJpbGl0aWVzOiBDTElFTlRfQ0FQQUJJTElUSUVTLFxuXHRcdFx0XHRcdGluaXRpYWxpemF0aW9uT3B0aW9uczogY29uZmlnLmluaXRPcHRpb25zID8/IHt9LFxuXHRcdFx0XHRcdHdvcmtzcGFjZUZvbGRlcnM6IFt7IHVyaTogZmlsZVRvVXJpKGN3ZCksIG5hbWU6IGN3ZC5zcGxpdChcIi9cIikucG9wKCkgPz8gXCJ3b3Jrc3BhY2VcIiB9XSxcblx0XHRcdFx0fSxcblx0XHRcdFx0dW5kZWZpbmVkLCAvLyBzaWduYWxcblx0XHRcdFx0aW5pdFRpbWVvdXRNcyxcblx0XHRcdCkpIGFzIHsgY2FwYWJpbGl0aWVzPzogdW5rbm93biB9O1xuXG5cdFx0XHRpZiAoIWluaXRSZXN1bHQpIHtcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKFwiRmFpbGVkIHRvIGluaXRpYWxpemUgTFNQOiBubyByZXNwb25zZVwiKTtcblx0XHRcdH1cblxuXHRcdFx0Y2xpZW50LnNlcnZlckNhcGFiaWxpdGllcyA9IGluaXRSZXN1bHQuY2FwYWJpbGl0aWVzIGFzIExzcENsaWVudFtcInNlcnZlckNhcGFiaWxpdGllc1wiXTtcblxuXHRcdFx0YXdhaXQgc2VuZE5vdGlmaWNhdGlvbihjbGllbnQsIFwiaW5pdGlhbGl6ZWRcIiwge30pO1xuXG5cdFx0XHRyZXR1cm4gY2xpZW50O1xuXHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0Y2xpZW50cy5kZWxldGUoa2V5KTtcblx0XHRcdGNsaWVudExvY2tzLmRlbGV0ZShrZXkpO1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0a2lsbFByb2Nlc3NUcmVlKHByb2MucGlkID8/IDApO1xuXHRcdFx0fSBjYXRjaCB7XG5cdFx0XHRcdHByb2Mua2lsbCgpO1xuXHRcdFx0fVxuXHRcdFx0dGhyb3cgZXJyO1xuXHRcdH0gZmluYWxseSB7XG5cdFx0XHRjbGllbnRMb2Nrcy5kZWxldGUoa2V5KTtcblx0XHR9XG5cdH0pKCk7XG5cblx0Y2xpZW50TG9ja3Muc2V0KGtleSwgY2xpZW50UHJvbWlzZSk7XG5cdHJldHVybiBjbGllbnRQcm9taXNlO1xufVxuXG4vKipcbiAqIEVuc3VyZSBhIGZpbGUgaXMgb3BlbmVkIGluIHRoZSBMU1AgY2xpZW50LlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZW5zdXJlRmlsZU9wZW4oY2xpZW50OiBMc3BDbGllbnQsIGZpbGVQYXRoOiBzdHJpbmcsIHNpZ25hbD86IEFib3J0U2lnbmFsKTogUHJvbWlzZTx2b2lkPiB7XG5cdHRocm93SWZBYm9ydGVkKHNpZ25hbCk7XG5cdGNvbnN0IHVyaSA9IGZpbGVUb1VyaShmaWxlUGF0aCk7XG5cdGNvbnN0IGxvY2tLZXkgPSBgJHtjbGllbnQubmFtZX06JHt1cml9YDtcblxuXHRpZiAoY2xpZW50Lm9wZW5GaWxlcy5oYXModXJpKSkge1xuXHRcdHJldHVybjtcblx0fVxuXG5cdGNvbnN0IGV4aXN0aW5nTG9jayA9IGZpbGVPcGVyYXRpb25Mb2Nrcy5nZXQobG9ja0tleSk7XG5cdGlmIChleGlzdGluZ0xvY2spIHtcblx0XHRhd2FpdCB1bnRpbEFib3J0ZWQoc2lnbmFsLCAoKSA9PiBleGlzdGluZ0xvY2spO1xuXHRcdHJldHVybjtcblx0fVxuXG5cdGNvbnN0IG9wZW5Qcm9taXNlID0gKGFzeW5jICgpID0+IHtcblx0XHR0aHJvd0lmQWJvcnRlZChzaWduYWwpO1xuXHRcdGlmIChjbGllbnQub3BlbkZpbGVzLmhhcyh1cmkpKSB7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0bGV0IGNvbnRlbnQ6IHN0cmluZztcblx0XHR0cnkge1xuXHRcdFx0Y29udGVudCA9IGF3YWl0IGZzUHJvbWlzZXMucmVhZEZpbGUoZmlsZVBhdGgsIFwidXRmLThcIik7XG5cdFx0XHR0aHJvd0lmQWJvcnRlZChzaWduYWwpO1xuXHRcdH0gY2F0Y2ggKGVycjogdW5rbm93bikge1xuXHRcdFx0aWYgKGlzRW5vZW50KGVycikpIHJldHVybjtcblx0XHRcdHRocm93IGVycjtcblx0XHR9XG5cdFx0Y29uc3QgbGFuZ3VhZ2VJZCA9IGRldGVjdExhbmd1YWdlSWQoZmlsZVBhdGgpO1xuXHRcdHRocm93SWZBYm9ydGVkKHNpZ25hbCk7XG5cblx0XHRhd2FpdCBzZW5kTm90aWZpY2F0aW9uKGNsaWVudCwgXCJ0ZXh0RG9jdW1lbnQvZGlkT3BlblwiLCB7XG5cdFx0XHR0ZXh0RG9jdW1lbnQ6IHtcblx0XHRcdFx0dXJpLFxuXHRcdFx0XHRsYW5ndWFnZUlkLFxuXHRcdFx0XHR2ZXJzaW9uOiAxLFxuXHRcdFx0XHR0ZXh0OiBjb250ZW50LFxuXHRcdFx0fSxcblx0XHR9KTtcblxuXHRcdGNsaWVudC5vcGVuRmlsZXMuc2V0KHVyaSwgeyB2ZXJzaW9uOiAxLCBsYW5ndWFnZUlkIH0pO1xuXHRcdGNsaWVudC5sYXN0QWN0aXZpdHkgPSBEYXRlLm5vdygpO1xuXHR9KSgpO1xuXG5cdGZpbGVPcGVyYXRpb25Mb2Nrcy5zZXQobG9ja0tleSwgb3BlblByb21pc2UpO1xuXHR0cnkge1xuXHRcdGF3YWl0IG9wZW5Qcm9taXNlO1xuXHR9IGZpbmFsbHkge1xuXHRcdGZpbGVPcGVyYXRpb25Mb2Nrcy5kZWxldGUobG9ja0tleSk7XG5cdH1cbn1cblxuXG4vKipcbiAqIFJlZnJlc2ggYSBmaWxlIGluIHRoZSBMU1AgY2xpZW50LlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVmcmVzaEZpbGUoY2xpZW50OiBMc3BDbGllbnQsIGZpbGVQYXRoOiBzdHJpbmcsIHNpZ25hbD86IEFib3J0U2lnbmFsKTogUHJvbWlzZTx2b2lkPiB7XG5cdHRocm93SWZBYm9ydGVkKHNpZ25hbCk7XG5cdGNvbnN0IHVyaSA9IGZpbGVUb1VyaShmaWxlUGF0aCk7XG5cdGNvbnN0IGxvY2tLZXkgPSBgJHtjbGllbnQubmFtZX06JHt1cml9YDtcblxuXHRjb25zdCBleGlzdGluZ0xvY2sgPSBmaWxlT3BlcmF0aW9uTG9ja3MuZ2V0KGxvY2tLZXkpO1xuXHRpZiAoZXhpc3RpbmdMb2NrKSB7XG5cdFx0YXdhaXQgdW50aWxBYm9ydGVkKHNpZ25hbCwgKCkgPT4gZXhpc3RpbmdMb2NrKTtcblx0fVxuXG5cdGNvbnN0IHJlZnJlc2hQcm9taXNlID0gKGFzeW5jICgpID0+IHtcblx0XHR0aHJvd0lmQWJvcnRlZChzaWduYWwpO1xuXHRcdGNvbnN0IGluZm8gPSBjbGllbnQub3BlbkZpbGVzLmdldCh1cmkpO1xuXG5cdFx0aWYgKCFpbmZvKSB7XG5cdFx0XHRhd2FpdCBlbnN1cmVGaWxlT3BlbihjbGllbnQsIGZpbGVQYXRoLCBzaWduYWwpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGxldCBjb250ZW50OiBzdHJpbmc7XG5cdFx0dHJ5IHtcblx0XHRcdGNvbnRlbnQgPSBhd2FpdCBmc1Byb21pc2VzLnJlYWRGaWxlKGZpbGVQYXRoLCBcInV0Zi04XCIpO1xuXHRcdFx0dGhyb3dJZkFib3J0ZWQoc2lnbmFsKTtcblx0XHR9IGNhdGNoIChlcnI6IHVua25vd24pIHtcblx0XHRcdGlmIChpc0Vub2VudChlcnIpKSByZXR1cm47XG5cdFx0XHR0aHJvdyBlcnI7XG5cdFx0fVxuXHRcdGNvbnN0IHZlcnNpb24gPSArK2luZm8udmVyc2lvbjtcblx0XHR0aHJvd0lmQWJvcnRlZChzaWduYWwpO1xuXG5cdFx0YXdhaXQgc2VuZE5vdGlmaWNhdGlvbihjbGllbnQsIFwidGV4dERvY3VtZW50L2RpZENoYW5nZVwiLCB7XG5cdFx0XHR0ZXh0RG9jdW1lbnQ6IHsgdXJpLCB2ZXJzaW9uIH0sXG5cdFx0XHRjb250ZW50Q2hhbmdlczogW3sgdGV4dDogY29udGVudCB9XSxcblx0XHR9KTtcblx0XHR0aHJvd0lmQWJvcnRlZChzaWduYWwpO1xuXG5cdFx0YXdhaXQgc2VuZE5vdGlmaWNhdGlvbihjbGllbnQsIFwidGV4dERvY3VtZW50L2RpZFNhdmVcIiwge1xuXHRcdFx0dGV4dERvY3VtZW50OiB7IHVyaSB9LFxuXHRcdFx0dGV4dDogY29udGVudCxcblx0XHR9KTtcblxuXHRcdGNsaWVudC5sYXN0QWN0aXZpdHkgPSBEYXRlLm5vdygpO1xuXHR9KSgpO1xuXG5cdGZpbGVPcGVyYXRpb25Mb2Nrcy5zZXQobG9ja0tleSwgcmVmcmVzaFByb21pc2UpO1xuXHR0cnkge1xuXHRcdGF3YWl0IHJlZnJlc2hQcm9taXNlO1xuXHR9IGZpbmFsbHkge1xuXHRcdGZpbGVPcGVyYXRpb25Mb2Nrcy5kZWxldGUobG9ja0tleSk7XG5cdH1cbn1cblxuLyoqXG4gKiBOb3RpZnkgYWxsIExTUCBjbGllbnRzIHRoYXQgaGF2ZSB0aGUgZmlsZSBvcGVuIHRoYXQgaXQgY2hhbmdlZCBvbiBkaXNrLlxuICogU3luY2hyb25vdXMgZW50cnkgcG9pbnQgXHUyMDE0IGFzeW5jIHJlZnJlc2ggcnVucyBpbiBiYWNrZ3JvdW5kLlxuICogU3dhbGxvd3MgZXJyb3JzIHNvIGVkaXRpbmcgbmV2ZXIgZmFpbHMgYmVjYXVzZSBvZiBMU1AuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBub3RpZnlGaWxlQ2hhbmdlZChmaWxlUGF0aDogc3RyaW5nKTogdm9pZCB7XG5cdGNvbnN0IHVyaSA9IGZpbGVUb1VyaShmaWxlUGF0aCk7XG5cdGZvciAoY29uc3QgY2xpZW50IG9mIGNsaWVudHMudmFsdWVzKCkpIHtcblx0XHRpZiAoY2xpZW50Lm9wZW5GaWxlcy5oYXModXJpKSkge1xuXHRcdFx0cmVmcmVzaEZpbGUoY2xpZW50LCBmaWxlUGF0aCkuY2F0Y2goKCkgPT4ge30pO1xuXHRcdH1cblx0fVxufVxuXG4vKipcbiAqIFJlbW92ZSBzdGRvdXQvc3RkZXJyIHN0cmVhbSBsaXN0ZW5lcnMgZm9yIGEgY2xpZW50IHRvIHByZXZlbnQgbGVha3MuXG4gKi9cbmZ1bmN0aW9uIHJlbW92ZVN0cmVhbUhhbmRsZXJzKGNsaWVudDogTHNwQ2xpZW50KTogdm9pZCB7XG5cdGNvbnN0IGhhbmRsZXJzID0gY2xpZW50U3RyZWFtSGFuZGxlcnMuZ2V0KGNsaWVudC5uYW1lKTtcblx0aWYgKCFoYW5kbGVycykgcmV0dXJuO1xuXG5cdGlmIChoYW5kbGVycy5zdGRvdXREYXRhKSBjbGllbnQucHJvYy5zdGRvdXQ/LnJlbW92ZUxpc3RlbmVyKFwiZGF0YVwiLCBoYW5kbGVycy5zdGRvdXREYXRhKTtcblx0aWYgKGhhbmRsZXJzLnN0ZG91dEVuZCkgY2xpZW50LnByb2Muc3Rkb3V0Py5yZW1vdmVMaXN0ZW5lcihcImVuZFwiLCBoYW5kbGVycy5zdGRvdXRFbmQpO1xuXHRpZiAoaGFuZGxlcnMuc3Rkb3V0RXJyb3IpIGNsaWVudC5wcm9jLnN0ZG91dD8ucmVtb3ZlTGlzdGVuZXIoXCJlcnJvclwiLCBoYW5kbGVycy5zdGRvdXRFcnJvcik7XG5cdGlmIChoYW5kbGVycy5zdGRlcnJEYXRhKSBjbGllbnQucHJvYy5zdGRlcnI/LnJlbW92ZUxpc3RlbmVyKFwiZGF0YVwiLCBoYW5kbGVycy5zdGRlcnJEYXRhKTtcblx0aWYgKGhhbmRsZXJzLnN0ZGVyckVuZCkgY2xpZW50LnByb2Muc3RkZXJyPy5yZW1vdmVMaXN0ZW5lcihcImVuZFwiLCBoYW5kbGVycy5zdGRlcnJFbmQpO1xuXHRpZiAoaGFuZGxlcnMuc3RkZXJyRXJyb3IpIGNsaWVudC5wcm9jLnN0ZGVycj8ucmVtb3ZlTGlzdGVuZXIoXCJlcnJvclwiLCBoYW5kbGVycy5zdGRlcnJFcnJvcik7XG5cblx0Y2xpZW50U3RyZWFtSGFuZGxlcnMuZGVsZXRlKGNsaWVudC5uYW1lKTtcbn1cblxuLyoqXG4gKiBTaHV0ZG93biBhIHNwZWNpZmljIGNsaWVudCBieSBrZXkuXG4gKi9cbmZ1bmN0aW9uIHNodXRkb3duQ2xpZW50KGtleTogc3RyaW5nKTogdm9pZCB7XG5cdGNvbnN0IGNsaWVudCA9IGNsaWVudHMuZ2V0KGtleSk7XG5cdGlmICghY2xpZW50KSByZXR1cm47XG5cblx0Zm9yIChjb25zdCBwZW5kaW5nIG9mIEFycmF5LmZyb20oY2xpZW50LnBlbmRpbmdSZXF1ZXN0cy52YWx1ZXMoKSkpIHtcblx0XHRwZW5kaW5nLnJlamVjdChuZXcgRXJyb3IoXCJMU1AgY2xpZW50IHNodXRkb3duXCIpKTtcblx0fVxuXHRjbGllbnQucGVuZGluZ1JlcXVlc3RzLmNsZWFyKCk7XG5cblx0c2VuZFJlcXVlc3QoY2xpZW50LCBcInNodXRkb3duXCIsIG51bGwpLmNhdGNoKCgpID0+IHt9KTtcblxuXHQvLyBSZW1vdmUgc3RyZWFtIGxpc3RlbmVycyBiZWZvcmUga2lsbGluZyB0aGUgcHJvY2Vzc1xuXHRyZW1vdmVTdHJlYW1IYW5kbGVycyhjbGllbnQpO1xuXG5cdHRyeSB7XG5cdFx0a2lsbFByb2Nlc3NUcmVlKGNsaWVudC5wcm9jLnBpZCk7XG5cdH0gY2F0Y2gge1xuXHRcdGNsaWVudC5wcm9jLmtpbGwoKTtcblx0fVxuXHRjbGllbnRzLmRlbGV0ZShrZXkpO1xuXHRjbGllbnRMb2Nrcy5kZWxldGUoa2V5KTtcblxuXHQvLyBDbGVhbiB1cCBhbnkgZmlsZSBvcGVyYXRpb24gbG9ja3MgYXNzb2NpYXRlZCB3aXRoIHRoaXMgY2xpZW50XG5cdGZvciAoY29uc3QgbG9ja0tleSBvZiBBcnJheS5mcm9tKGZpbGVPcGVyYXRpb25Mb2Nrcy5rZXlzKCkpKSB7XG5cdFx0aWYgKGxvY2tLZXkuc3RhcnRzV2l0aChgJHtrZXl9OmApKSB7XG5cdFx0XHRmaWxlT3BlcmF0aW9uTG9ja3MuZGVsZXRlKGxvY2tLZXkpO1xuXHRcdH1cblx0fVxufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gTFNQIFByb3RvY29sIE1ldGhvZHNcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmNvbnN0IERFRkFVTFRfUkVRVUVTVF9USU1FT1VUX01TID0gMzAwMDA7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzZW5kUmVxdWVzdChcblx0Y2xpZW50OiBMc3BDbGllbnQsXG5cdG1ldGhvZDogc3RyaW5nLFxuXHRwYXJhbXM6IHVua25vd24sXG5cdHNpZ25hbD86IEFib3J0U2lnbmFsLFxuXHR0aW1lb3V0TXM6IG51bWJlciA9IERFRkFVTFRfUkVRVUVTVF9USU1FT1VUX01TLFxuKTogUHJvbWlzZTx1bmtub3duPiB7XG5cdGNvbnN0IGlkID0gKytjbGllbnQucmVxdWVzdElkO1xuXHRpZiAoc2lnbmFsPy5hYm9ydGVkKSB7XG5cdFx0Y29uc3QgcmVhc29uID0gc2lnbmFsLnJlYXNvbiBpbnN0YW5jZW9mIEVycm9yID8gc2lnbmFsLnJlYXNvbiA6IG5ldyBUb29sQWJvcnRFcnJvcigpO1xuXHRcdHJldHVybiBQcm9taXNlLnJlamVjdChyZWFzb24pO1xuXHR9XG5cblx0Y29uc3QgcmVxdWVzdDogTHNwSnNvblJwY1JlcXVlc3QgPSB7XG5cdFx0anNvbnJwYzogXCIyLjBcIixcblx0XHRpZCxcblx0XHRtZXRob2QsXG5cdFx0cGFyYW1zLFxuXHR9O1xuXG5cdGNsaWVudC5sYXN0QWN0aXZpdHkgPSBEYXRlLm5vdygpO1xuXG5cdGNvbnN0IHsgcHJvbWlzZSwgcmVzb2x2ZSwgcmVqZWN0IH0gPSBQcm9taXNlLndpdGhSZXNvbHZlcnM8dW5rbm93bj4oKTtcblx0bGV0IHRpbWVvdXQ6IE5vZGVKUy5UaW1lb3V0IHwgdW5kZWZpbmVkO1xuXHRjb25zdCBjbGVhbnVwID0gKCkgPT4ge1xuXHRcdGlmIChzaWduYWwpIHtcblx0XHRcdHNpZ25hbC5yZW1vdmVFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgYWJvcnRIYW5kbGVyKTtcblx0XHR9XG5cdH07XG5cdGNvbnN0IGFib3J0SGFuZGxlciA9ICgpID0+IHtcblx0XHRpZiAoY2xpZW50LnBlbmRpbmdSZXF1ZXN0cy5oYXMoaWQpKSB7XG5cdFx0XHRjbGllbnQucGVuZGluZ1JlcXVlc3RzLmRlbGV0ZShpZCk7XG5cdFx0fVxuXHRcdHZvaWQgc2VuZE5vdGlmaWNhdGlvbihjbGllbnQsIFwiJC9jYW5jZWxSZXF1ZXN0XCIsIHsgaWQgfSkuY2F0Y2goKCkgPT4ge30pO1xuXHRcdGlmICh0aW1lb3V0KSBjbGVhclRpbWVvdXQodGltZW91dCk7XG5cdFx0Y2xlYW51cCgpO1xuXHRcdGNvbnN0IHJlYXNvbiA9IHNpZ25hbD8ucmVhc29uIGluc3RhbmNlb2YgRXJyb3IgPyBzaWduYWwucmVhc29uIDogbmV3IFRvb2xBYm9ydEVycm9yKCk7XG5cdFx0cmVqZWN0KHJlYXNvbik7XG5cdH07XG5cblx0dGltZW91dCA9IHNldFRpbWVvdXQoKCkgPT4ge1xuXHRcdGlmIChjbGllbnQucGVuZGluZ1JlcXVlc3RzLmhhcyhpZCkpIHtcblx0XHRcdGNsaWVudC5wZW5kaW5nUmVxdWVzdHMuZGVsZXRlKGlkKTtcblx0XHRcdGNvbnN0IGVyciA9IG5ldyBFcnJvcihgTFNQIHJlcXVlc3QgJHttZXRob2R9IHRpbWVkIG91dCBhZnRlciAke3RpbWVvdXRNc31tc2ApO1xuXHRcdFx0Y2xlYW51cCgpO1xuXHRcdFx0cmVqZWN0KGVycik7XG5cdFx0fVxuXHR9LCB0aW1lb3V0TXMpO1xuXHRpZiAoc2lnbmFsKSB7XG5cdFx0c2lnbmFsLmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBhYm9ydEhhbmRsZXIsIHsgb25jZTogdHJ1ZSB9KTtcblx0XHRpZiAoc2lnbmFsLmFib3J0ZWQpIHtcblx0XHRcdGFib3J0SGFuZGxlcigpO1xuXHRcdFx0cmV0dXJuIHByb21pc2U7XG5cdFx0fVxuXHR9XG5cblx0Y2xpZW50LnBlbmRpbmdSZXF1ZXN0cy5zZXQoaWQsIHtcblx0XHRyZXNvbHZlOiAocmVzdWx0OiB1bmtub3duKSA9PiB7XG5cdFx0XHRpZiAodGltZW91dCkgY2xlYXJUaW1lb3V0KHRpbWVvdXQpO1xuXHRcdFx0Y2xlYW51cCgpO1xuXHRcdFx0cmVzb2x2ZShyZXN1bHQpO1xuXHRcdH0sXG5cdFx0cmVqZWN0OiAoZXJyOiBFcnJvcikgPT4ge1xuXHRcdFx0aWYgKHRpbWVvdXQpIGNsZWFyVGltZW91dCh0aW1lb3V0KTtcblx0XHRcdGNsZWFudXAoKTtcblx0XHRcdHJlamVjdChlcnIpO1xuXHRcdH0sXG5cdFx0bWV0aG9kLFxuXHR9KTtcblxuXHR3cml0ZU1lc3NhZ2UoY2xpZW50LnByb2Muc3RkaW4sIHJlcXVlc3QpLmNhdGNoKChlcnI6IEVycm9yKSA9PiB7XG5cdFx0aWYgKHRpbWVvdXQpIGNsZWFyVGltZW91dCh0aW1lb3V0KTtcblx0XHRjbGllbnQucGVuZGluZ1JlcXVlc3RzLmRlbGV0ZShpZCk7XG5cdFx0Y2xlYW51cCgpO1xuXHRcdHJlamVjdChlcnIpO1xuXHR9KTtcblx0cmV0dXJuIHByb21pc2U7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHNlbmROb3RpZmljYXRpb24oY2xpZW50OiBMc3BDbGllbnQsIG1ldGhvZDogc3RyaW5nLCBwYXJhbXM6IHVua25vd24pOiBQcm9taXNlPHZvaWQ+IHtcblx0Y29uc3Qgbm90aWZpY2F0aW9uOiBMc3BKc29uUnBjTm90aWZpY2F0aW9uID0ge1xuXHRcdGpzb25ycGM6IFwiMi4wXCIsXG5cdFx0bWV0aG9kLFxuXHRcdHBhcmFtcyxcblx0fTtcblxuXHRjbGllbnQubGFzdEFjdGl2aXR5ID0gRGF0ZS5ub3coKTtcblx0dHJ5IHtcblx0XHRhd2FpdCB3cml0ZU1lc3NhZ2UoY2xpZW50LnByb2Muc3RkaW4sIG5vdGlmaWNhdGlvbik7XG5cdH0gY2F0Y2ggKGVycjogdW5rbm93bikge1xuXHRcdC8vIEVQSVBFIG1lYW5zIHRoZSBMU1AgcHJvY2VzcyBkaWVkIChlLmcuIGFmdGVyIGxzcC5yZWxvYWQga2lsbGVkIGl0KS5cblx0XHQvLyBTd2FsbG93IHNvIGNhbGxlcnMgZG9uJ3QgY3Jhc2ggXHUyMDE0IHRoZSBuZXh0IGdldE9yQ3JlYXRlQ2xpZW50IGNhbGxcblx0XHQvLyB3aWxsIHNwYXduIGEgZnJlc2ggc2VydmVyICgjODE1KS5cblx0XHRpZiAoZXJyIGluc3RhbmNlb2YgRXJyb3IgJiYgJ2NvZGUnIGluIGVyciAmJiAoZXJyIGFzIE5vZGVKUy5FcnJub0V4Y2VwdGlvbikuY29kZSA9PT0gJ0VQSVBFJykge1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblx0XHR0aHJvdyBlcnI7XG5cdH1cbn1cblxuLyoqXG4gKiBTaHV0ZG93biBhbGwgTFNQIGNsaWVudHMuXG4gKi9cbmZ1bmN0aW9uIHNodXRkb3duQWxsKCk6IHZvaWQge1xuXHRjb25zdCBjbGllbnRzVG9TaHV0ZG93biA9IEFycmF5LmZyb20oY2xpZW50cy52YWx1ZXMoKSk7XG5cdGNsaWVudHMuY2xlYXIoKTtcblx0Y2xpZW50TG9ja3MuY2xlYXIoKTtcblx0ZmlsZU9wZXJhdGlvbkxvY2tzLmNsZWFyKCk7XG5cdHN0b3BJZGxlQ2hlY2tlcigpO1xuXG5cdGNvbnN0IGVyciA9IG5ldyBFcnJvcihcIkxTUCBjbGllbnQgc2h1dGRvd25cIik7XG5cdGZvciAoY29uc3QgY2xpZW50IG9mIGNsaWVudHNUb1NodXRkb3duKSB7XG5cdFx0Y29uc3QgcmVxcyA9IEFycmF5LmZyb20oY2xpZW50LnBlbmRpbmdSZXF1ZXN0cy52YWx1ZXMoKSk7XG5cdFx0Y2xpZW50LnBlbmRpbmdSZXF1ZXN0cy5jbGVhcigpO1xuXHRcdGZvciAoY29uc3QgcGVuZGluZyBvZiByZXFzKSB7XG5cdFx0XHRwZW5kaW5nLnJlamVjdChlcnIpO1xuXHRcdH1cblxuXHRcdC8vIFJlbW92ZSBzdHJlYW0gbGlzdGVuZXJzIGJlZm9yZSBraWxsaW5nIHRoZSBwcm9jZXNzXG5cdFx0cmVtb3ZlU3RyZWFtSGFuZGxlcnMoY2xpZW50KTtcblxuXHRcdHZvaWQgKGFzeW5jICgpID0+IHtcblx0XHRcdGNvbnN0IHRpbWVvdXQgPSBuZXcgUHJvbWlzZTx2b2lkPihyZXNvbHZlID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgNV8wMDApKTtcblx0XHRcdGNvbnN0IHJlc3VsdCA9IHNlbmRSZXF1ZXN0KGNsaWVudCwgXCJzaHV0ZG93blwiLCBudWxsKS5jYXRjaCgoKSA9PiB7fSk7XG5cdFx0XHRhd2FpdCBQcm9taXNlLnJhY2UoW3Jlc3VsdCwgdGltZW91dF0pO1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0a2lsbFByb2Nlc3NUcmVlKGNsaWVudC5wcm9jLnBpZCk7XG5cdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0Y2xpZW50LnByb2Mua2lsbCgpO1xuXHRcdFx0fVxuXHRcdH0pKCkuY2F0Y2goKCkgPT4ge30pO1xuXHR9XG59XG5cbi8qKiBTdGF0dXMgb2YgYW4gTFNQIHNlcnZlciAqL1xuZXhwb3J0IGludGVyZmFjZSBMc3BTZXJ2ZXJTdGF0dXMge1xuXHRuYW1lOiBzdHJpbmc7XG5cdHN0YXR1czogXCJjb25uZWN0aW5nXCIgfCBcInJlYWR5XCIgfCBcImVycm9yXCI7XG5cdGZpbGVUeXBlczogc3RyaW5nW107XG5cdGVycm9yPzogc3RyaW5nO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0QWN0aXZlQ2xpZW50cygpOiBMc3BTZXJ2ZXJTdGF0dXNbXSB7XG5cdHJldHVybiBBcnJheS5mcm9tKGNsaWVudHMudmFsdWVzKCkpLm1hcChjbGllbnQgPT4gKHtcblx0XHRuYW1lOiBjbGllbnQuY29uZmlnLmNvbW1hbmQsXG5cdFx0c3RhdHVzOiBcInJlYWR5XCIgYXMgY29uc3QsXG5cdFx0ZmlsZVR5cGVzOiBjbGllbnQuY29uZmlnLmZpbGVUeXBlcyxcblx0fSkpO1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gUHJvY2VzcyBDbGVhbnVwXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5jb25zdCBfYmVmb3JlRXhpdEhhbmRsZXIgPSAoKSA9PiBzaHV0ZG93bkFsbCgpO1xuY29uc3QgX3NpZ2ludEhhbmRsZXIgPSAoKSA9PiB7XG5cdHNodXRkb3duQWxsKCk7XG5cdHByb2Nlc3MuZXhpdCgwKTtcbn07XG5jb25zdCBfc2lndGVybUhhbmRsZXIgPSAoKSA9PiB7XG5cdHNodXRkb3duQWxsKCk7XG5cdHByb2Nlc3MuZXhpdCgwKTtcbn07XG5cbmlmICh0eXBlb2YgcHJvY2VzcyAhPT0gXCJ1bmRlZmluZWRcIikge1xuXHRwcm9jZXNzLm9uKFwiYmVmb3JlRXhpdFwiLCBfYmVmb3JlRXhpdEhhbmRsZXIpO1xuXHRwcm9jZXNzLm9uKFwiU0lHSU5UXCIsIF9zaWdpbnRIYW5kbGVyKTtcblx0cHJvY2Vzcy5vbihcIlNJR1RFUk1cIiwgX3NpZ3Rlcm1IYW5kbGVyKTtcbn1cblxuLyoqXG4gKiBSZW1vdmUgcHJvY2Vzcy1sZXZlbCBzaWduYWwgaGFuZGxlcnMgcmVnaXN0ZXJlZCBhdCBtb2R1bGUgbG9hZC5cbiAqIENhbGwgdGhpcyBkdXJpbmcgZ3JhY2VmdWwgdGVhcmRvd24gdG8gcHJldmVudCBsZWFrZWQgbGlzdGVuZXJzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVtb3ZlUHJvY2Vzc0hhbmRsZXJzKCk6IHZvaWQge1xuXHRwcm9jZXNzLm9mZihcImJlZm9yZUV4aXRcIiwgX2JlZm9yZUV4aXRIYW5kbGVyKTtcblx0cHJvY2Vzcy5vZmYoXCJTSUdJTlRcIiwgX3NpZ2ludEhhbmRsZXIpO1xuXHRwcm9jZXNzLm9mZihcIlNJR1RFUk1cIiwgX3NpZ3Rlcm1IYW5kbGVyKTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFNBQVMsYUFBYTtBQUN0QixZQUFZLGdCQUFnQjtBQUU1QixTQUFTLHVCQUF1QjtBQUNoQyxTQUFTLGdCQUFn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
