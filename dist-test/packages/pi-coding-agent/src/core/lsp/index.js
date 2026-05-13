import * as fs from "node:fs";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ensureFileOpen,
  getActiveClients,
  getOrCreateClient,
  refreshFile,
  sendRequest,
  setIdleTimeout,
  WARMUP_TIMEOUT_MS
} from "./client.js";
import { getServerForFile, getServersForFile, loadConfig, hasRootMarkers, resolveCommand } from "./config.js";
import { applyTextEdits, applyWorkspaceEdit } from "./edits.js";
import { ToolAbortError, clampTimeout, throwIfAborted } from "./helpers.js";
import { detectLspmux } from "./lspmux.js";
import {
  lspSchema
} from "./types.js";
import {
  applyCodeAction,
  collectGlobMatches,
  dedupeWorkspaceSymbols,
  extractHoverText,
  fileToUri,
  filterWorkspaceSymbols,
  formatCallHierarchyItem,
  formatCodeAction,
  formatDiagnostic,
  formatDiagnosticsSummary,
  formatDocumentSymbol,
  formatGroupedDiagnosticMessages,
  formatLocation,
  formatSignatureHelp,
  formatSymbolInformation,
  formatWorkspaceEdit,
  hasGlobPattern,
  readLocationContext,
  resolveSymbolColumn,
  sortDiagnostics,
  symbolKindToIcon,
  uriToFile
} from "./utils.js";
import { lspSchema as lspSchema2 } from "./types.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const lspDescription = fsSync.readFileSync(path.join(__dirname, "lsp.md"), "utf-8");
async function warmupLspServers(cwd) {
  const config = loadConfig(cwd);
  setIdleTimeout(config.idleTimeoutMs);
  const servers = [];
  const lspServers = getLspServers(config);
  const results = await Promise.allSettled(
    lspServers.map(async ([name, serverConfig]) => {
      const client = await getOrCreateClient(serverConfig, cwd, serverConfig.warmupTimeoutMs ?? WARMUP_TIMEOUT_MS);
      return { name, client, fileTypes: serverConfig.fileTypes };
    })
  );
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const [name, serverConfig] = lspServers[i];
    if (result.status === "fulfilled") {
      servers.push({
        name: result.value.name,
        status: "ready",
        fileTypes: result.value.fileTypes
      });
    } else {
      servers.push({
        name,
        status: "error",
        fileTypes: serverConfig.fileTypes,
        error: result.reason?.message ?? String(result.reason)
      });
    }
  }
  return { servers };
}
function getLspStatus() {
  return getActiveClients();
}
const configCache = /* @__PURE__ */ new Map();
function getConfig(cwd) {
  let config = configCache.get(cwd);
  if (!config) {
    config = loadConfig(cwd);
    setIdleTimeout(config.idleTimeoutMs);
    configCache.set(cwd, config);
  }
  return config;
}
function getLspServers(config) {
  return Object.entries(config.servers);
}
const DIAGNOSTIC_MESSAGE_LIMIT = 50;
const SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS = 3e3;
const BATCH_DIAGNOSTICS_WAIT_TIMEOUT_MS = 400;
const MAX_GLOB_DIAGNOSTIC_TARGETS = 20;
const WORKSPACE_SYMBOL_LIMIT = 200;
function limitDiagnosticMessages(messages) {
  if (messages.length <= DIAGNOSTIC_MESSAGE_LIMIT) {
    return messages;
  }
  return messages.slice(0, DIAGNOSTIC_MESSAGE_LIMIT);
}
const LOCATION_CONTEXT_LINES = 1;
const REFERENCE_CONTEXT_LIMIT = 50;
function normalizeLocationResult(result) {
  if (!result) return [];
  const raw = Array.isArray(result) ? result : [result];
  return raw.flatMap((loc) => {
    if ("uri" in loc) {
      return [loc];
    }
    if ("targetUri" in loc) {
      const link = loc;
      return [{ uri: link.targetUri, range: link.targetSelectionRange ?? link.targetRange }];
    }
    return [];
  });
}
async function formatLocationWithContext(location, cwd) {
  const header = `  ${formatLocation(location, cwd)}`;
  const context = await readLocationContext(
    uriToFile(location.uri),
    location.range.start.line + 1,
    LOCATION_CONTEXT_LINES
  );
  if (context.length === 0) {
    return header;
  }
  return `${header}
${context.map((lineText) => `    ${lineText}`).join("\n")}`;
}
async function formatLocationResults(result, label, cwd) {
  const locations = normalizeLocationResult(result);
  if (locations.length === 0) {
    return `No ${label} found`;
  }
  const lines = await Promise.all(locations.map((location) => formatLocationWithContext(location, cwd)));
  return `Found ${locations.length} ${label}(s):
${lines.join("\n")}`;
}
async function formatCallHierarchyResults(client, position, uri, direction, cwd, signal) {
  const prepareResult = await sendRequest(
    client,
    "textDocument/prepareCallHierarchy",
    { textDocument: { uri }, position },
    signal
  );
  if (!prepareResult || prepareResult.length === 0) {
    return "No call hierarchy item found at this position";
  }
  const method = direction === "incoming" ? "callHierarchy/incomingCalls" : "callHierarchy/outgoingCalls";
  const callResult = await sendRequest(client, method, { item: prepareResult[0] }, signal);
  if (!callResult || callResult.length === 0) {
    const verb = direction === "incoming" ? "incoming calls" : "outgoing calls";
    const prep2 = direction === "incoming" ? "for" : "from";
    return `No ${verb} found ${prep2} ${prepareResult[0].name}`;
  }
  const lines = [];
  const limited = callResult.slice(0, REFERENCE_CONTEXT_LIMIT);
  for (const call of limited) {
    const item = "from" in call ? call.from : call.to;
    const header = formatCallHierarchyItem(item, cwd);
    const filePath = uriToFile(item.uri);
    const callLine = ("from" in call ? call.fromRanges[0]?.start.line : void 0) ?? item.selectionRange.start.line;
    const context = await readLocationContext(filePath, callLine + 1, LOCATION_CONTEXT_LINES);
    if (context.length > 0) {
      lines.push(`  ${header}
${context.map((l) => `    ${l}`).join("\n")}`);
    } else {
      lines.push(`  ${header}`);
    }
  }
  const noun = direction === "incoming" ? "caller" : "callee";
  const prep = direction === "incoming" ? "of" : "from";
  const truncation = callResult.length > REFERENCE_CONTEXT_LIMIT ? `
  ... ${callResult.length - REFERENCE_CONTEXT_LIMIT} additional ${noun}(s) omitted` : "";
  return `${callResult.length} ${noun}(s) ${prep} ${prepareResult[0].name}:
${lines.join("\n")}${truncation}`;
}
async function reloadServer(client, serverName, signal) {
  let output = `Restarted ${serverName}`;
  const reloadMethods = ["rust-analyzer/reloadWorkspace", "workspace/didChangeConfiguration"];
  for (const method of reloadMethods) {
    try {
      await sendRequest(client, method, method.includes("Configuration") ? { settings: {} } : null, signal);
      output = `Reloaded ${serverName}`;
      break;
    } catch {
    }
  }
  if (output.startsWith("Restarted")) {
    client.proc.kill();
    await Promise.race([
      client.proc.exited,
      new Promise((r) => setTimeout(r, 3e3))
    ]);
  }
  return output;
}
async function waitForDiagnostics(client, uri, timeoutMs = 3e3, signal, minVersion) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    throwIfAborted(signal);
    const diagnostics = client.diagnostics.get(uri);
    const versionOk = minVersion === void 0 || client.diagnosticsVersion > minVersion;
    if (diagnostics !== void 0 && versionOk) return diagnostics;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return client.diagnostics.get(uri) ?? [];
}
function detectProjectType(cwd) {
  if (fs.existsSync(path.join(cwd, "Cargo.toml"))) {
    return { type: "rust", command: ["cargo", "check", "--message-format=short"], description: "Rust (cargo check)" };
  }
  if (fs.existsSync(path.join(cwd, "tsconfig.json"))) {
    return { type: "typescript", command: ["npx", "tsc", "--noEmit"], description: "TypeScript (tsc --noEmit)" };
  }
  if (fs.existsSync(path.join(cwd, "go.mod"))) {
    return { type: "go", command: ["go", "build", "./..."], description: "Go (go build)" };
  }
  if (fs.existsSync(path.join(cwd, "pyproject.toml")) || fs.existsSync(path.join(cwd, "pyrightconfig.json"))) {
    return { type: "python", command: ["pyright"], description: "Python (pyright)" };
  }
  return { type: "unknown", description: "Unknown project type" };
}
async function runWorkspaceDiagnostics(cwd, signal) {
  throwIfAborted(signal);
  const projectType = detectProjectType(cwd);
  if (!projectType.command) {
    return {
      output: "Cannot detect project type. Supported: Rust (Cargo.toml), TypeScript (tsconfig.json), Go (go.mod), Python (pyproject.toml)",
      projectType
    };
  }
  const [cmd, ...cmdArgs] = projectType.command;
  const proc = spawn(cmd, cmdArgs, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    // On Windows, project-type commands (tsc, cargo, etc.) may be .cmd
    // wrappers that need shell resolution to avoid ENOENT/EINVAL (#2854).
    shell: process.platform === "win32"
  });
  const abortHandler = () => {
    proc.kill();
  };
  if (signal) {
    signal.addEventListener("abort", abortHandler, { once: true });
  }
  try {
    const stdoutChunks = [];
    const stderrChunks = [];
    proc.stdout?.on("data", (chunk) => stdoutChunks.push(chunk));
    proc.stderr?.on("data", (chunk) => stderrChunks.push(chunk));
    const exitCode = await new Promise((resolve) => {
      proc.on("exit", (code) => resolve(code ?? 1));
    });
    const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
    const stderr = Buffer.concat(stderrChunks).toString("utf-8");
    throwIfAborted(signal);
    const combined = (stdout + stderr).trim();
    if (!combined) {
      return { output: "No issues found", projectType };
    }
    const lines = combined.split("\n");
    if (lines.length > 50) {
      return { output: `${lines.slice(0, 50).join("\n")}
... and ${lines.length - 50} more lines`, projectType };
    }
    return { output: combined, projectType };
  } catch (e) {
    if (signal?.aborted) {
      throw new ToolAbortError();
    }
    return { output: `Failed to run ${projectType.command.join(" ")}: ${e}`, projectType };
  } finally {
    signal?.removeEventListener("abort", abortHandler);
  }
}
function resolveToCwd(file, cwd) {
  return path.resolve(cwd, file);
}
function createLspTool(cwd) {
  return {
    name: "lsp",
    label: "LSP",
    description: lspDescription,
    parameters: lspSchema,
    async execute(_toolCallId, params, signal, _onUpdate) {
      const { action, file, line, symbol, occurrence, query, new_name, apply, tab_size, insert_spaces, timeout } = params;
      const timeoutSec = clampTimeout(timeout);
      const timeoutSignal = AbortSignal.timeout(timeoutSec * 1e3);
      signal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      throwIfAborted(signal);
      const config = getConfig(cwd);
      if (action === "status") {
        const servers = Object.keys(config.servers);
        const lspmuxState = await detectLspmux();
        const lspmuxStatus = lspmuxState.available ? lspmuxState.running ? "lspmux: active (multiplexing enabled)" : "lspmux: installed but server not running" : "";
        let serverStatus;
        if (servers.length > 0) {
          serverStatus = `Active language servers: ${servers.join(", ")}`;
        } else {
          const DEFAULTS = (await import("./defaults.json", { with: { type: "json" } })).default;
          const diagnostics = ["No language servers configured for this project."];
          const matchedButMissing = [];
          const noMarkers = [];
          for (const [name, def] of Object.entries(DEFAULTS)) {
            if (hasRootMarkers(cwd, def.rootMarkers)) {
              const resolved = resolveCommand(def.command, cwd);
              if (!resolved) {
                matchedButMissing.push(`  ${name}: project detected (${def.rootMarkers[0]}) but '${def.command}' not found \u2014 install it with npm/pip/brew`);
              }
            }
          }
          if (matchedButMissing.length > 0) {
            diagnostics.push("\nDetected projects missing language servers:");
            diagnostics.push(...matchedButMissing);
            diagnostics.push("\nInstall the missing server command and restart GSD, or run: lsp reload");
          } else {
            diagnostics.push("No recognized project markers found in the working directory.");
            diagnostics.push("LSP auto-detects projects via files like package.json, Cargo.toml, go.mod, pyproject.toml, etc.");
          }
          serverStatus = diagnostics.join("\n");
        }
        const output = lspmuxStatus ? `${serverStatus}
${lspmuxStatus}` : serverStatus;
        return {
          content: [{ type: "text", text: output }],
          details: { action, success: true, request: params }
        };
      }
      if (action === "diagnostics") {
        if (!file) {
          const result = await runWorkspaceDiagnostics(cwd, signal);
          return {
            content: [
              {
                type: "text",
                text: `Workspace diagnostics (${result.projectType.description}):
${result.output}`
              }
            ],
            details: { action, success: true, request: params }
          };
        }
        let targets;
        let truncatedGlobTargets = false;
        if (hasGlobPattern(file)) {
          const globMatches = await collectGlobMatches(file, cwd, MAX_GLOB_DIAGNOSTIC_TARGETS);
          targets = globMatches.matches;
          truncatedGlobTargets = globMatches.truncated;
        } else {
          targets = [file];
        }
        if (targets.length === 0) {
          return {
            content: [{ type: "text", text: `No files matched pattern: ${file}` }],
            details: { action, success: true, request: params }
          };
        }
        const detailed = targets.length > 1 || truncatedGlobTargets;
        const diagnosticsWaitTimeoutMs = detailed ? Math.min(BATCH_DIAGNOSTICS_WAIT_TIMEOUT_MS, timeoutSec * 1e3) : Math.min(SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS, timeoutSec * 1e3);
        const results = [];
        const allServerNames = /* @__PURE__ */ new Set();
        if (truncatedGlobTargets) {
          results.push(
            `[W] Pattern matched more than ${MAX_GLOB_DIAGNOSTIC_TARGETS} files; showing first ${MAX_GLOB_DIAGNOSTIC_TARGETS}. Narrow the glob or use workspace diagnostics.`
          );
        }
        for (const target of targets) {
          throwIfAborted(signal);
          const resolved = resolveToCwd(target, cwd);
          const servers = getServersForFile(config, resolved);
          if (servers.length === 0) {
            results.push(`[E] ${target}: No language server found`);
            continue;
          }
          const uri = fileToUri(resolved);
          const relPath = path.relative(cwd, resolved);
          const allDiagnostics = [];
          for (const [serverName2, serverConfig2] of servers) {
            allServerNames.add(serverName2);
            try {
              throwIfAborted(signal);
              const client = await getOrCreateClient(serverConfig2, cwd);
              const minVersion = client.diagnosticsVersion;
              await refreshFile(client, resolved, signal);
              const diagnostics = await waitForDiagnostics(
                client,
                uri,
                diagnosticsWaitTimeoutMs,
                signal,
                minVersion
              );
              allDiagnostics.push(...diagnostics);
            } catch (err) {
              if (err instanceof ToolAbortError || signal?.aborted) {
                throw err;
              }
            }
          }
          const seen = /* @__PURE__ */ new Set();
          const uniqueDiagnostics = [];
          for (const d of allDiagnostics) {
            const key = `${d.range.start.line}:${d.range.start.character}:${d.range.end.line}:${d.range.end.character}:${d.message}`;
            if (!seen.has(key)) {
              seen.add(key);
              uniqueDiagnostics.push(d);
            }
          }
          sortDiagnostics(uniqueDiagnostics);
          if (!detailed && targets.length === 1) {
            if (uniqueDiagnostics.length === 0) {
              return {
                content: [{ type: "text", text: "No diagnostics" }],
                details: { action, serverName: Array.from(allServerNames).join(", "), success: true }
              };
            }
            const summary = formatDiagnosticsSummary(uniqueDiagnostics);
            const formatted = uniqueDiagnostics.map((d) => formatDiagnostic(d, relPath));
            const output = `${summary}:
${formatGroupedDiagnosticMessages(formatted)}`;
            return {
              content: [{ type: "text", text: output }],
              details: { action, serverName: Array.from(allServerNames).join(", "), success: true }
            };
          }
          if (uniqueDiagnostics.length === 0) {
            results.push(`OK ${relPath}: no issues`);
          } else {
            const summary = formatDiagnosticsSummary(uniqueDiagnostics);
            results.push(`[E] ${relPath}: ${summary}`);
            const formatted = uniqueDiagnostics.map((d) => formatDiagnostic(d, relPath));
            results.push(formatGroupedDiagnosticMessages(formatted));
          }
        }
        return {
          content: [{ type: "text", text: results.join("\n") }],
          details: { action, serverName: Array.from(allServerNames).join(", "), success: true }
        };
      }
      const requiresFile = !file && action !== "symbols" && action !== "reload";
      if (requiresFile) {
        return {
          content: [{ type: "text", text: "Error: file parameter required for this action" }],
          details: { action, success: false }
        };
      }
      const resolvedFile = file ? resolveToCwd(file, cwd) : null;
      if (action === "symbols" && !resolvedFile) {
        const normalizedQuery = query?.trim();
        if (!normalizedQuery) {
          return {
            content: [{ type: "text", text: "Error: query parameter required for workspace symbol search" }],
            details: { action, success: false, request: params }
          };
        }
        const servers = getLspServers(config);
        if (servers.length === 0) {
          return {
            content: [{ type: "text", text: "No language server found for this action" }],
            details: { action, success: false, request: params }
          };
        }
        const aggregatedSymbols = [];
        const respondingServers = /* @__PURE__ */ new Set();
        for (const [workspaceServerName, workspaceServerConfig] of servers) {
          throwIfAborted(signal);
          try {
            const workspaceClient = await getOrCreateClient(workspaceServerConfig, cwd);
            const workspaceResult = await sendRequest(
              workspaceClient,
              "workspace/symbol",
              { query: normalizedQuery },
              signal
            );
            if (!workspaceResult || workspaceResult.length === 0) {
              continue;
            }
            respondingServers.add(workspaceServerName);
            aggregatedSymbols.push(...filterWorkspaceSymbols(workspaceResult, normalizedQuery));
          } catch (err) {
            if (err instanceof ToolAbortError || signal?.aborted) {
              throw err;
            }
          }
        }
        const dedupedSymbols = dedupeWorkspaceSymbols(aggregatedSymbols);
        if (dedupedSymbols.length === 0) {
          return {
            content: [{ type: "text", text: `No symbols matching "${normalizedQuery}"` }],
            details: {
              action,
              serverName: Array.from(respondingServers).join(", "),
              success: true,
              request: params
            }
          };
        }
        const limitedSymbols = dedupedSymbols.slice(0, WORKSPACE_SYMBOL_LIMIT);
        const lines = limitedSymbols.map((s) => formatSymbolInformation(s, cwd));
        const truncationLine = dedupedSymbols.length > WORKSPACE_SYMBOL_LIMIT ? `
... ${dedupedSymbols.length - WORKSPACE_SYMBOL_LIMIT} additional symbol(s) omitted` : "";
        return {
          content: [
            {
              type: "text",
              text: `Found ${dedupedSymbols.length} symbol(s) matching "${normalizedQuery}":
${lines.map((l) => `  ${l}`).join("\n")}${truncationLine}`
            }
          ],
          details: {
            action,
            serverName: Array.from(respondingServers).join(", "),
            success: true,
            request: params
          }
        };
      }
      if (action === "reload" && !resolvedFile) {
        const servers = getLspServers(config);
        if (servers.length === 0) {
          return {
            content: [{ type: "text", text: "No language server found for this action" }],
            details: { action, success: false, request: params }
          };
        }
        const outputs = [];
        for (const [workspaceServerName, workspaceServerConfig] of servers) {
          throwIfAborted(signal);
          try {
            const workspaceClient = await getOrCreateClient(workspaceServerConfig, cwd);
            outputs.push(await reloadServer(workspaceClient, workspaceServerName, signal));
          } catch (err) {
            if (err instanceof ToolAbortError || signal?.aborted) {
              throw err;
            }
            const errorMessage = err instanceof Error ? err.message : String(err);
            outputs.push(`Failed to reload ${workspaceServerName}: ${errorMessage}`);
          }
        }
        return {
          content: [{ type: "text", text: outputs.join("\n") }],
          details: { action, serverName: servers.map(([name]) => name).join(", "), success: true, request: params }
        };
      }
      const serverInfo = resolvedFile ? getServerForFile(config, resolvedFile) : null;
      if (!serverInfo) {
        return {
          content: [{ type: "text", text: "No language server found for this action" }],
          details: { action, success: false }
        };
      }
      const [serverName, serverConfig] = serverInfo;
      try {
        const client = await getOrCreateClient(serverConfig, cwd);
        const targetFile = resolvedFile;
        if (targetFile) {
          await ensureFileOpen(client, targetFile, signal);
        }
        const uri = targetFile ? fileToUri(targetFile) : "";
        const resolvedLine = line ?? 1;
        const resolvedCharacter = targetFile ? await resolveSymbolColumn(targetFile, resolvedLine, symbol, occurrence) : 0;
        const position = { line: resolvedLine - 1, character: resolvedCharacter };
        let output;
        switch (action) {
          case "definition": {
            const result = await sendRequest(
              client,
              "textDocument/definition",
              { textDocument: { uri }, position },
              signal
            );
            output = await formatLocationResults(result, "definition", cwd);
            break;
          }
          case "type_definition": {
            const result = await sendRequest(
              client,
              "textDocument/typeDefinition",
              { textDocument: { uri }, position },
              signal
            );
            output = await formatLocationResults(result, "type definition", cwd);
            break;
          }
          case "implementation": {
            const result = await sendRequest(
              client,
              "textDocument/implementation",
              { textDocument: { uri }, position },
              signal
            );
            output = await formatLocationResults(result, "implementation", cwd);
            break;
          }
          case "references": {
            const result = await sendRequest(
              client,
              "textDocument/references",
              {
                textDocument: { uri },
                position,
                context: { includeDeclaration: true }
              },
              signal
            );
            if (!result || result.length === 0) {
              output = "No references found";
            } else {
              const contextualReferences = result.slice(0, REFERENCE_CONTEXT_LIMIT);
              const plainReferences = result.slice(REFERENCE_CONTEXT_LIMIT);
              const contextualLines = await Promise.all(
                contextualReferences.map((location) => formatLocationWithContext(location, cwd))
              );
              const plainLines = plainReferences.map((location) => `  ${formatLocation(location, cwd)}`);
              const lines = plainLines.length ? [
                ...contextualLines,
                `  ... ${plainLines.length} additional reference(s) shown without context`,
                ...plainLines
              ] : contextualLines;
              output = `Found ${result.length} reference(s):
${lines.join("\n")}`;
            }
            break;
          }
          case "hover": {
            const result = await sendRequest(
              client,
              "textDocument/hover",
              {
                textDocument: { uri },
                position
              },
              signal
            );
            if (!result || !result.contents) {
              output = "No hover information";
            } else {
              output = extractHoverText(result.contents);
            }
            break;
          }
          case "code_actions": {
            const diagnostics = client.diagnostics.get(uri) ?? [];
            const context = {
              diagnostics,
              only: !apply && query ? [query] : void 0,
              triggerKind: 1
            };
            const result = await sendRequest(
              client,
              "textDocument/codeAction",
              {
                textDocument: { uri },
                range: { start: position, end: position },
                context
              },
              signal
            );
            if (!result || result.length === 0) {
              output = "No code actions available";
              break;
            }
            if (apply === true && query) {
              const normalizedQuery = query.trim();
              if (normalizedQuery.length === 0) {
                output = "Error: query parameter required when apply=true for code_actions";
                break;
              }
              const parsedIndex = /^\d+$/.test(normalizedQuery) ? Number.parseInt(normalizedQuery, 10) : null;
              const selectedAction = result.find(
                (actionItem, index) => parsedIndex !== null && index === parsedIndex || actionItem.title.toLowerCase().includes(normalizedQuery.toLowerCase())
              );
              if (!selectedAction) {
                const actionLines2 = result.map((actionItem, index) => `  ${formatCodeAction(actionItem, index)}`);
                output = `No code action matches "${normalizedQuery}". Available actions:
${actionLines2.join("\n")}`;
                break;
              }
              const appliedAction = await applyCodeAction(selectedAction, {
                resolveCodeAction: async (actionItem) => await sendRequest(client, "codeAction/resolve", actionItem, signal),
                applyWorkspaceEdit: async (edit) => applyWorkspaceEdit(edit, cwd),
                executeCommand: async (commandItem) => {
                  await sendRequest(
                    client,
                    "workspace/executeCommand",
                    {
                      command: commandItem.command,
                      arguments: commandItem.arguments ?? []
                    },
                    signal
                  );
                }
              });
              if (!appliedAction) {
                output = `Action "${selectedAction.title}" has no workspace edit or command to apply`;
                break;
              }
              const summaryLines = [];
              if (appliedAction.edits.length > 0) {
                summaryLines.push("  Workspace edit:");
                summaryLines.push(...appliedAction.edits.map((item) => `    ${item}`));
              }
              if (appliedAction.executedCommands.length > 0) {
                summaryLines.push("  Executed command(s):");
                summaryLines.push(...appliedAction.executedCommands.map((commandName) => `    ${commandName}`));
              }
              output = `Applied "${appliedAction.title}":
${summaryLines.join("\n")}`;
              break;
            }
            const actionLines = result.map((actionItem, index) => `  ${formatCodeAction(actionItem, index)}`);
            output = `${result.length} code action(s):
${actionLines.join("\n")}`;
            break;
          }
          case "symbols": {
            if (!targetFile) {
              output = "Error: file parameter required for document symbols";
              break;
            }
            const result = await sendRequest(
              client,
              "textDocument/documentSymbol",
              {
                textDocument: { uri }
              },
              signal
            );
            if (!result || result.length === 0) {
              output = "No symbols found";
            } else {
              const relPath = path.relative(cwd, targetFile);
              if ("selectionRange" in result[0]) {
                const lines = result.flatMap((s) => formatDocumentSymbol(s));
                output = `Symbols in ${relPath}:
${lines.join("\n")}`;
              } else {
                const lines = result.map((s) => {
                  const line2 = s.location.range.start.line + 1;
                  const icon = symbolKindToIcon(s.kind);
                  return `${icon} ${s.name} @ line ${line2}`;
                });
                output = `Symbols in ${relPath}:
${lines.join("\n")}`;
              }
            }
            break;
          }
          case "incoming_calls": {
            output = await formatCallHierarchyResults(client, position, uri, "incoming", cwd, signal);
            break;
          }
          case "outgoing_calls": {
            output = await formatCallHierarchyResults(client, position, uri, "outgoing", cwd, signal);
            break;
          }
          case "format": {
            if (!targetFile) {
              output = "Error: file parameter required for format";
              break;
            }
            const formatResult = await sendRequest(
              client,
              "textDocument/formatting",
              {
                textDocument: { uri },
                options: {
                  tabSize: tab_size ?? 4,
                  insertSpaces: insert_spaces ?? true
                }
              },
              signal
            );
            if (!formatResult || formatResult.length === 0) {
              const relPath2 = path.relative(cwd, targetFile);
              output = `${relPath2}: already formatted (no changes)`;
              break;
            }
            await applyTextEdits(targetFile, formatResult);
            const relPath = path.relative(cwd, targetFile);
            output = `Formatted ${relPath}: ${formatResult.length} edit(s) applied`;
            break;
          }
          case "signature": {
            const sigResult = await sendRequest(
              client,
              "textDocument/signatureHelp",
              {
                textDocument: { uri },
                position
              },
              signal
            );
            if (!sigResult || !sigResult.signatures || sigResult.signatures.length === 0) {
              output = "No signature information at this position";
            } else {
              output = formatSignatureHelp(sigResult);
            }
            break;
          }
          case "rename": {
            if (!new_name) {
              return {
                content: [{ type: "text", text: "Error: new_name parameter required for rename" }],
                details: { action, serverName, success: false }
              };
            }
            const result = await sendRequest(
              client,
              "textDocument/rename",
              {
                textDocument: { uri },
                position,
                newName: new_name
              },
              signal
            );
            if (!result) {
              output = "Rename returned no edits";
            } else {
              const shouldApply = apply !== false;
              if (shouldApply) {
                const applied = await applyWorkspaceEdit(result, cwd);
                output = `Applied rename:
${applied.map((a) => `  ${a}`).join("\n")}`;
              } else {
                const preview = formatWorkspaceEdit(result, cwd);
                output = `Rename preview:
${preview.map((p) => `  ${p}`).join("\n")}`;
              }
            }
            break;
          }
          case "reload": {
            output = await reloadServer(client, serverName, signal);
            break;
          }
          default:
            output = `Unknown action: ${action}`;
        }
        return {
          content: [{ type: "text", text: output }],
          details: { serverName, action, success: true, request: params }
        };
      } catch (err) {
        if (err instanceof ToolAbortError || signal?.aborted) {
          throw new ToolAbortError();
        }
        const errorMessage = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `LSP error: ${errorMessage}` }],
          details: { serverName, action, success: false, request: params }
        };
      }
    }
  };
}
const lspTool = createLspTool(process.cwd());
export {
  createLspTool,
  getLspStatus,
  lspSchema2 as lspSchema,
  lspTool,
  warmupLspServers
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL2xzcC9pbmRleC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0ICogYXMgZnMgZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCAqIGFzIGZzU3luYyBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBzcGF3biB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tIFwibm9kZTp1cmxcIjtcbmltcG9ydCB0eXBlIHsgQWdlbnRUb29sLCBBZ2VudFRvb2xSZXN1bHQsIEFnZW50VG9vbFVwZGF0ZUNhbGxiYWNrIH0gZnJvbSBcIkBnc2QvcGktYWdlbnQtY29yZVwiO1xuaW1wb3J0IHtcblx0ZW5zdXJlRmlsZU9wZW4sXG5cdGdldEFjdGl2ZUNsaWVudHMsXG5cdGdldE9yQ3JlYXRlQ2xpZW50LFxuXHR0eXBlIExzcFNlcnZlclN0YXR1cyxcblx0cmVmcmVzaEZpbGUsXG5cdHNlbmRSZXF1ZXN0LFxuXHRzZXRJZGxlVGltZW91dCxcblx0V0FSTVVQX1RJTUVPVVRfTVMsXG59IGZyb20gXCIuL2NsaWVudC5qc1wiO1xuaW1wb3J0IHsgZ2V0U2VydmVyRm9yRmlsZSwgZ2V0U2VydmVyc0ZvckZpbGUsIHR5cGUgTHNwQ29uZmlnLCBsb2FkQ29uZmlnLCBoYXNSb290TWFya2VycywgcmVzb2x2ZUNvbW1hbmQgfSBmcm9tIFwiLi9jb25maWcuanNcIjtcbmltcG9ydCB7IGFwcGx5VGV4dEVkaXRzLCBhcHBseVdvcmtzcGFjZUVkaXQgfSBmcm9tIFwiLi9lZGl0cy5qc1wiO1xuaW1wb3J0IHsgVG9vbEFib3J0RXJyb3IsIGNsYW1wVGltZW91dCwgdGhyb3dJZkFib3J0ZWQgfSBmcm9tIFwiLi9oZWxwZXJzLmpzXCI7XG5pbXBvcnQgeyBkZXRlY3RMc3BtdXggfSBmcm9tIFwiLi9sc3BtdXguanNcIjtcbmltcG9ydCB7XG5cdHR5cGUgQ2FsbEhpZXJhcmNoeUluY29taW5nQ2FsbCxcblx0dHlwZSBDYWxsSGllcmFyY2h5SXRlbSxcblx0dHlwZSBDYWxsSGllcmFyY2h5T3V0Z29pbmdDYWxsLFxuXHR0eXBlIENvZGVBY3Rpb24sXG5cdHR5cGUgQ29kZUFjdGlvbkNvbnRleHQsXG5cdHR5cGUgQ29tbWFuZCxcblx0dHlwZSBEaWFnbm9zdGljLFxuXHR0eXBlIERvY3VtZW50U3ltYm9sLFxuXHR0eXBlIEhvdmVyLFxuXHR0eXBlIExvY2F0aW9uLFxuXHR0eXBlIExvY2F0aW9uTGluayxcblx0dHlwZSBMc3BDbGllbnQsXG5cdHR5cGUgTHNwUGFyYW1zLFxuXHR0eXBlIExzcFRvb2xEZXRhaWxzLFxuXHRsc3BTY2hlbWEsXG5cdHR5cGUgU2VydmVyQ29uZmlnLFxuXHR0eXBlIFNpZ25hdHVyZUhlbHAsXG5cdHR5cGUgU3ltYm9sSW5mb3JtYXRpb24sXG5cdHR5cGUgVGV4dEVkaXQsXG5cdHR5cGUgV29ya3NwYWNlRWRpdCxcbn0gZnJvbSBcIi4vdHlwZXMuanNcIjtcbmltcG9ydCB7XG5cdGFwcGx5Q29kZUFjdGlvbixcblx0Y29sbGVjdEdsb2JNYXRjaGVzLFxuXHRkZWR1cGVXb3Jrc3BhY2VTeW1ib2xzLFxuXHRleHRyYWN0SG92ZXJUZXh0LFxuXHRmaWxlVG9VcmksXG5cdGZpbHRlcldvcmtzcGFjZVN5bWJvbHMsXG5cdGZvcm1hdENhbGxIaWVyYXJjaHlJdGVtLFxuXHRmb3JtYXRDb2RlQWN0aW9uLFxuXHRmb3JtYXREaWFnbm9zdGljLFxuXHRmb3JtYXREaWFnbm9zdGljc1N1bW1hcnksXG5cdGZvcm1hdERvY3VtZW50U3ltYm9sLFxuXHRmb3JtYXRHcm91cGVkRGlhZ25vc3RpY01lc3NhZ2VzLFxuXHRmb3JtYXRMb2NhdGlvbixcblx0Zm9ybWF0U2lnbmF0dXJlSGVscCxcblx0Zm9ybWF0U3ltYm9sSW5mb3JtYXRpb24sXG5cdGZvcm1hdFdvcmtzcGFjZUVkaXQsXG5cdGhhc0dsb2JQYXR0ZXJuLFxuXHRyZWFkTG9jYXRpb25Db250ZXh0LFxuXHRyZXNvbHZlU3ltYm9sQ29sdW1uLFxuXHRzb3J0RGlhZ25vc3RpY3MsXG5cdHN5bWJvbEtpbmRUb0ljb24sXG5cdHVyaVRvRmlsZSxcbn0gZnJvbSBcIi4vdXRpbHMuanNcIjtcblxuZXhwb3J0IHR5cGUgeyBMc3BTZXJ2ZXJTdGF0dXMgfSBmcm9tIFwiLi9jbGllbnQuanNcIjtcbmV4cG9ydCB0eXBlIHsgTHNwVG9vbERldGFpbHMgfSBmcm9tIFwiLi90eXBlcy5qc1wiO1xuZXhwb3J0IHsgbHNwU2NoZW1hIH0gZnJvbSBcIi4vdHlwZXMuanNcIjtcblxuY29uc3QgX19kaXJuYW1lID0gcGF0aC5kaXJuYW1lKGZpbGVVUkxUb1BhdGgoaW1wb3J0Lm1ldGEudXJsKSk7XG5jb25zdCBsc3BEZXNjcmlwdGlvbiA9IGZzU3luYy5yZWFkRmlsZVN5bmMocGF0aC5qb2luKF9fZGlybmFtZSwgXCJsc3AubWRcIiksIFwidXRmLThcIik7XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBXYXJtdXAgQVBJXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5leHBvcnQgaW50ZXJmYWNlIExzcFdhcm11cFJlc3VsdCB7XG5cdHNlcnZlcnM6IEFycmF5PHtcblx0XHRuYW1lOiBzdHJpbmc7XG5cdFx0c3RhdHVzOiBcInJlYWR5XCIgfCBcImVycm9yXCI7XG5cdFx0ZmlsZVR5cGVzOiBzdHJpbmdbXTtcblx0XHRlcnJvcj86IHN0cmluZztcblx0fT47XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB3YXJtdXBMc3BTZXJ2ZXJzKGN3ZDogc3RyaW5nKTogUHJvbWlzZTxMc3BXYXJtdXBSZXN1bHQ+IHtcblx0Y29uc3QgY29uZmlnID0gbG9hZENvbmZpZyhjd2QpO1xuXHRzZXRJZGxlVGltZW91dChjb25maWcuaWRsZVRpbWVvdXRNcyk7XG5cdGNvbnN0IHNlcnZlcnM6IExzcFdhcm11cFJlc3VsdFtcInNlcnZlcnNcIl0gPSBbXTtcblx0Y29uc3QgbHNwU2VydmVycyA9IGdldExzcFNlcnZlcnMoY29uZmlnKTtcblxuXHRjb25zdCByZXN1bHRzID0gYXdhaXQgUHJvbWlzZS5hbGxTZXR0bGVkKFxuXHRcdGxzcFNlcnZlcnMubWFwKGFzeW5jIChbbmFtZSwgc2VydmVyQ29uZmlnXSkgPT4ge1xuXHRcdFx0Y29uc3QgY2xpZW50ID0gYXdhaXQgZ2V0T3JDcmVhdGVDbGllbnQoc2VydmVyQ29uZmlnLCBjd2QsIHNlcnZlckNvbmZpZy53YXJtdXBUaW1lb3V0TXMgPz8gV0FSTVVQX1RJTUVPVVRfTVMpO1xuXHRcdFx0cmV0dXJuIHsgbmFtZSwgY2xpZW50LCBmaWxlVHlwZXM6IHNlcnZlckNvbmZpZy5maWxlVHlwZXMgfTtcblx0XHR9KSxcblx0KTtcblxuXHRmb3IgKGxldCBpID0gMDsgaSA8IHJlc3VsdHMubGVuZ3RoOyBpKyspIHtcblx0XHRjb25zdCByZXN1bHQgPSByZXN1bHRzW2ldO1xuXHRcdGNvbnN0IFtuYW1lLCBzZXJ2ZXJDb25maWddID0gbHNwU2VydmVyc1tpXTtcblx0XHRpZiAocmVzdWx0LnN0YXR1cyA9PT0gXCJmdWxmaWxsZWRcIikge1xuXHRcdFx0c2VydmVycy5wdXNoKHtcblx0XHRcdFx0bmFtZTogcmVzdWx0LnZhbHVlLm5hbWUsXG5cdFx0XHRcdHN0YXR1czogXCJyZWFkeVwiLFxuXHRcdFx0XHRmaWxlVHlwZXM6IHJlc3VsdC52YWx1ZS5maWxlVHlwZXMsXG5cdFx0XHR9KTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0c2VydmVycy5wdXNoKHtcblx0XHRcdFx0bmFtZSxcblx0XHRcdFx0c3RhdHVzOiBcImVycm9yXCIsXG5cdFx0XHRcdGZpbGVUeXBlczogc2VydmVyQ29uZmlnLmZpbGVUeXBlcyxcblx0XHRcdFx0ZXJyb3I6IHJlc3VsdC5yZWFzb24/Lm1lc3NhZ2UgPz8gU3RyaW5nKHJlc3VsdC5yZWFzb24pLFxuXHRcdFx0fSk7XG5cdFx0fVxuXHR9XG5cblx0cmV0dXJuIHsgc2VydmVycyB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0THNwU3RhdHVzKCk6IExzcFNlcnZlclN0YXR1c1tdIHtcblx0cmV0dXJuIGdldEFjdGl2ZUNsaWVudHMoKTtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIEludGVybmFsIEhlbHBlcnNcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmNvbnN0IGNvbmZpZ0NhY2hlID0gbmV3IE1hcDxzdHJpbmcsIExzcENvbmZpZz4oKTtcblxuZnVuY3Rpb24gZ2V0Q29uZmlnKGN3ZDogc3RyaW5nKTogTHNwQ29uZmlnIHtcblx0bGV0IGNvbmZpZyA9IGNvbmZpZ0NhY2hlLmdldChjd2QpO1xuXHRpZiAoIWNvbmZpZykge1xuXHRcdGNvbmZpZyA9IGxvYWRDb25maWcoY3dkKTtcblx0XHRzZXRJZGxlVGltZW91dChjb25maWcuaWRsZVRpbWVvdXRNcyk7XG5cdFx0Y29uZmlnQ2FjaGUuc2V0KGN3ZCwgY29uZmlnKTtcblx0fVxuXHRyZXR1cm4gY29uZmlnO1xufVxuXG5mdW5jdGlvbiBnZXRMc3BTZXJ2ZXJzKGNvbmZpZzogTHNwQ29uZmlnKTogQXJyYXk8W3N0cmluZywgU2VydmVyQ29uZmlnXT4ge1xuXHRyZXR1cm4gT2JqZWN0LmVudHJpZXMoY29uZmlnLnNlcnZlcnMpIGFzIEFycmF5PFtzdHJpbmcsIFNlcnZlckNvbmZpZ10+O1xufVxuXG5jb25zdCBESUFHTk9TVElDX01FU1NBR0VfTElNSVQgPSA1MDtcbmNvbnN0IFNJTkdMRV9ESUFHTk9TVElDU19XQUlUX1RJTUVPVVRfTVMgPSAzMDAwO1xuY29uc3QgQkFUQ0hfRElBR05PU1RJQ1NfV0FJVF9USU1FT1VUX01TID0gNDAwO1xuY29uc3QgTUFYX0dMT0JfRElBR05PU1RJQ19UQVJHRVRTID0gMjA7XG5jb25zdCBXT1JLU1BBQ0VfU1lNQk9MX0xJTUlUID0gMjAwO1xuXG5mdW5jdGlvbiBsaW1pdERpYWdub3N0aWNNZXNzYWdlcyhtZXNzYWdlczogc3RyaW5nW10pOiBzdHJpbmdbXSB7XG5cdGlmIChtZXNzYWdlcy5sZW5ndGggPD0gRElBR05PU1RJQ19NRVNTQUdFX0xJTUlUKSB7XG5cdFx0cmV0dXJuIG1lc3NhZ2VzO1xuXHR9XG5cdHJldHVybiBtZXNzYWdlcy5zbGljZSgwLCBESUFHTk9TVElDX01FU1NBR0VfTElNSVQpO1xufVxuXG5jb25zdCBMT0NBVElPTl9DT05URVhUX0xJTkVTID0gMTtcbmNvbnN0IFJFRkVSRU5DRV9DT05URVhUX0xJTUlUID0gNTA7XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUxvY2F0aW9uUmVzdWx0KHJlc3VsdDogTG9jYXRpb24gfCBMb2NhdGlvbltdIHwgTG9jYXRpb25MaW5rIHwgTG9jYXRpb25MaW5rW10gfCBudWxsKTogTG9jYXRpb25bXSB7XG5cdGlmICghcmVzdWx0KSByZXR1cm4gW107XG5cdGNvbnN0IHJhdyA9IEFycmF5LmlzQXJyYXkocmVzdWx0KSA/IHJlc3VsdCA6IFtyZXN1bHRdO1xuXHRyZXR1cm4gcmF3LmZsYXRNYXAobG9jID0+IHtcblx0XHRpZiAoXCJ1cmlcIiBpbiBsb2MpIHtcblx0XHRcdHJldHVybiBbbG9jIGFzIExvY2F0aW9uXTtcblx0XHR9XG5cdFx0aWYgKFwidGFyZ2V0VXJpXCIgaW4gbG9jKSB7XG5cdFx0XHRjb25zdCBsaW5rID0gbG9jIGFzIExvY2F0aW9uTGluaztcblx0XHRcdHJldHVybiBbeyB1cmk6IGxpbmsudGFyZ2V0VXJpLCByYW5nZTogbGluay50YXJnZXRTZWxlY3Rpb25SYW5nZSA/PyBsaW5rLnRhcmdldFJhbmdlIH1dO1xuXHRcdH1cblx0XHRyZXR1cm4gW107XG5cdH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBmb3JtYXRMb2NhdGlvbldpdGhDb250ZXh0KGxvY2F0aW9uOiBMb2NhdGlvbiwgY3dkOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZz4ge1xuXHRjb25zdCBoZWFkZXIgPSBgICAke2Zvcm1hdExvY2F0aW9uKGxvY2F0aW9uLCBjd2QpfWA7XG5cdGNvbnN0IGNvbnRleHQgPSBhd2FpdCByZWFkTG9jYXRpb25Db250ZXh0KFxuXHRcdHVyaVRvRmlsZShsb2NhdGlvbi51cmkpLFxuXHRcdGxvY2F0aW9uLnJhbmdlLnN0YXJ0LmxpbmUgKyAxLFxuXHRcdExPQ0FUSU9OX0NPTlRFWFRfTElORVMsXG5cdCk7XG5cdGlmIChjb250ZXh0Lmxlbmd0aCA9PT0gMCkge1xuXHRcdHJldHVybiBoZWFkZXI7XG5cdH1cblx0cmV0dXJuIGAke2hlYWRlcn1cXG4ke2NvbnRleHQubWFwKGxpbmVUZXh0ID0+IGAgICAgJHtsaW5lVGV4dH1gKS5qb2luKFwiXFxuXCIpfWA7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGZvcm1hdExvY2F0aW9uUmVzdWx0cyhcblx0cmVzdWx0OiBMb2NhdGlvbiB8IExvY2F0aW9uW10gfCBMb2NhdGlvbkxpbmsgfCBMb2NhdGlvbkxpbmtbXSB8IG51bGwsXG5cdGxhYmVsOiBzdHJpbmcsXG5cdGN3ZDogc3RyaW5nLFxuKTogUHJvbWlzZTxzdHJpbmc+IHtcblx0Y29uc3QgbG9jYXRpb25zID0gbm9ybWFsaXplTG9jYXRpb25SZXN1bHQocmVzdWx0KTtcblx0aWYgKGxvY2F0aW9ucy5sZW5ndGggPT09IDApIHtcblx0XHRyZXR1cm4gYE5vICR7bGFiZWx9IGZvdW5kYDtcblx0fVxuXHRjb25zdCBsaW5lcyA9IGF3YWl0IFByb21pc2UuYWxsKGxvY2F0aW9ucy5tYXAobG9jYXRpb24gPT4gZm9ybWF0TG9jYXRpb25XaXRoQ29udGV4dChsb2NhdGlvbiwgY3dkKSkpO1xuXHRyZXR1cm4gYEZvdW5kICR7bG9jYXRpb25zLmxlbmd0aH0gJHtsYWJlbH0ocyk6XFxuJHtsaW5lcy5qb2luKFwiXFxuXCIpfWA7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGZvcm1hdENhbGxIaWVyYXJjaHlSZXN1bHRzKFxuXHRjbGllbnQ6IExzcENsaWVudCxcblx0cG9zaXRpb246IHsgbGluZTogbnVtYmVyOyBjaGFyYWN0ZXI6IG51bWJlciB9LFxuXHR1cmk6IHN0cmluZyxcblx0ZGlyZWN0aW9uOiBcImluY29taW5nXCIgfCBcIm91dGdvaW5nXCIsXG5cdGN3ZDogc3RyaW5nLFxuXHRzaWduYWw/OiBBYm9ydFNpZ25hbCxcbik6IFByb21pc2U8c3RyaW5nPiB7XG5cdGNvbnN0IHByZXBhcmVSZXN1bHQgPSAoYXdhaXQgc2VuZFJlcXVlc3QoXG5cdFx0Y2xpZW50LFxuXHRcdFwidGV4dERvY3VtZW50L3ByZXBhcmVDYWxsSGllcmFyY2h5XCIsXG5cdFx0eyB0ZXh0RG9jdW1lbnQ6IHsgdXJpIH0sIHBvc2l0aW9uIH0sXG5cdFx0c2lnbmFsLFxuXHQpKSBhcyBDYWxsSGllcmFyY2h5SXRlbVtdIHwgbnVsbDtcblxuXHRpZiAoIXByZXBhcmVSZXN1bHQgfHwgcHJlcGFyZVJlc3VsdC5sZW5ndGggPT09IDApIHtcblx0XHRyZXR1cm4gXCJObyBjYWxsIGhpZXJhcmNoeSBpdGVtIGZvdW5kIGF0IHRoaXMgcG9zaXRpb25cIjtcblx0fVxuXG5cdGNvbnN0IG1ldGhvZCA9IGRpcmVjdGlvbiA9PT0gXCJpbmNvbWluZ1wiID8gXCJjYWxsSGllcmFyY2h5L2luY29taW5nQ2FsbHNcIiA6IFwiY2FsbEhpZXJhcmNoeS9vdXRnb2luZ0NhbGxzXCI7XG5cdGNvbnN0IGNhbGxSZXN1bHQgPSAoYXdhaXQgc2VuZFJlcXVlc3QoY2xpZW50LCBtZXRob2QsIHsgaXRlbTogcHJlcGFyZVJlc3VsdFswXSB9LCBzaWduYWwpKSBhc1xuXHRcdHwgQ2FsbEhpZXJhcmNoeUluY29taW5nQ2FsbFtdXG5cdFx0fCBDYWxsSGllcmFyY2h5T3V0Z29pbmdDYWxsW11cblx0XHR8IG51bGw7XG5cblx0aWYgKCFjYWxsUmVzdWx0IHx8IGNhbGxSZXN1bHQubGVuZ3RoID09PSAwKSB7XG5cdFx0Y29uc3QgdmVyYiA9IGRpcmVjdGlvbiA9PT0gXCJpbmNvbWluZ1wiID8gXCJpbmNvbWluZyBjYWxsc1wiIDogXCJvdXRnb2luZyBjYWxsc1wiO1xuXHRcdGNvbnN0IHByZXAgPSBkaXJlY3Rpb24gPT09IFwiaW5jb21pbmdcIiA/IFwiZm9yXCIgOiBcImZyb21cIjtcblx0XHRyZXR1cm4gYE5vICR7dmVyYn0gZm91bmQgJHtwcmVwfSAke3ByZXBhcmVSZXN1bHRbMF0ubmFtZX1gO1xuXHR9XG5cblx0Y29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG5cdGNvbnN0IGxpbWl0ZWQgPSBjYWxsUmVzdWx0LnNsaWNlKDAsIFJFRkVSRU5DRV9DT05URVhUX0xJTUlUKTtcblx0Zm9yIChjb25zdCBjYWxsIG9mIGxpbWl0ZWQpIHtcblx0XHRjb25zdCBpdGVtID0gXCJmcm9tXCIgaW4gY2FsbCA/IGNhbGwuZnJvbSA6IGNhbGwudG87XG5cdFx0Y29uc3QgaGVhZGVyID0gZm9ybWF0Q2FsbEhpZXJhcmNoeUl0ZW0oaXRlbSwgY3dkKTtcblx0XHRjb25zdCBmaWxlUGF0aCA9IHVyaVRvRmlsZShpdGVtLnVyaSk7XG5cdFx0Y29uc3QgY2FsbExpbmUgPSAoXCJmcm9tXCIgaW4gY2FsbCA/IGNhbGwuZnJvbVJhbmdlc1swXT8uc3RhcnQubGluZSA6IHVuZGVmaW5lZCkgPz8gaXRlbS5zZWxlY3Rpb25SYW5nZS5zdGFydC5saW5lO1xuXHRcdGNvbnN0IGNvbnRleHQgPSBhd2FpdCByZWFkTG9jYXRpb25Db250ZXh0KGZpbGVQYXRoLCBjYWxsTGluZSArIDEsIExPQ0FUSU9OX0NPTlRFWFRfTElORVMpO1xuXHRcdGlmIChjb250ZXh0Lmxlbmd0aCA+IDApIHtcblx0XHRcdGxpbmVzLnB1c2goYCAgJHtoZWFkZXJ9XFxuJHtjb250ZXh0Lm1hcChsID0+IGAgICAgJHtsfWApLmpvaW4oXCJcXG5cIil9YCk7XG5cdFx0fSBlbHNlIHtcblx0XHRcdGxpbmVzLnB1c2goYCAgJHtoZWFkZXJ9YCk7XG5cdFx0fVxuXHR9XG5cblx0Y29uc3Qgbm91biA9IGRpcmVjdGlvbiA9PT0gXCJpbmNvbWluZ1wiID8gXCJjYWxsZXJcIiA6IFwiY2FsbGVlXCI7XG5cdGNvbnN0IHByZXAgPSBkaXJlY3Rpb24gPT09IFwiaW5jb21pbmdcIiA/IFwib2ZcIiA6IFwiZnJvbVwiO1xuXHRjb25zdCB0cnVuY2F0aW9uID0gY2FsbFJlc3VsdC5sZW5ndGggPiBSRUZFUkVOQ0VfQ09OVEVYVF9MSU1JVFxuXHRcdD8gYFxcbiAgLi4uICR7Y2FsbFJlc3VsdC5sZW5ndGggLSBSRUZFUkVOQ0VfQ09OVEVYVF9MSU1JVH0gYWRkaXRpb25hbCAke25vdW59KHMpIG9taXR0ZWRgXG5cdFx0OiBcIlwiO1xuXHRyZXR1cm4gYCR7Y2FsbFJlc3VsdC5sZW5ndGh9ICR7bm91bn0ocykgJHtwcmVwfSAke3ByZXBhcmVSZXN1bHRbMF0ubmFtZX06XFxuJHtsaW5lcy5qb2luKFwiXFxuXCIpfSR7dHJ1bmNhdGlvbn1gO1xufVxuXG5hc3luYyBmdW5jdGlvbiByZWxvYWRTZXJ2ZXIoY2xpZW50OiBMc3BDbGllbnQsIHNlcnZlck5hbWU6IHN0cmluZywgc2lnbmFsPzogQWJvcnRTaWduYWwpOiBQcm9taXNlPHN0cmluZz4ge1xuXHRsZXQgb3V0cHV0ID0gYFJlc3RhcnRlZCAke3NlcnZlck5hbWV9YDtcblx0Y29uc3QgcmVsb2FkTWV0aG9kcyA9IFtcInJ1c3QtYW5hbHl6ZXIvcmVsb2FkV29ya3NwYWNlXCIsIFwid29ya3NwYWNlL2RpZENoYW5nZUNvbmZpZ3VyYXRpb25cIl07XG5cdGZvciAoY29uc3QgbWV0aG9kIG9mIHJlbG9hZE1ldGhvZHMpIHtcblx0XHR0cnkge1xuXHRcdFx0YXdhaXQgc2VuZFJlcXVlc3QoY2xpZW50LCBtZXRob2QsIG1ldGhvZC5pbmNsdWRlcyhcIkNvbmZpZ3VyYXRpb25cIikgPyB7IHNldHRpbmdzOiB7fSB9IDogbnVsbCwgc2lnbmFsKTtcblx0XHRcdG91dHB1dCA9IGBSZWxvYWRlZCAke3NlcnZlck5hbWV9YDtcblx0XHRcdGJyZWFrO1xuXHRcdH0gY2F0Y2gge1xuXHRcdFx0Ly8gTWV0aG9kIG5vdCBzdXBwb3J0ZWQsIHRyeSBuZXh0XG5cdFx0fVxuXHR9XG5cdGlmIChvdXRwdXQuc3RhcnRzV2l0aChcIlJlc3RhcnRlZFwiKSkge1xuXHRcdGNsaWVudC5wcm9jLmtpbGwoKTtcblx0XHQvLyBXYWl0IGZvciB0aGUgcHJvY2VzcyB0byBhY3R1YWxseSBleGl0IHNvIHRoZSBjcmFzaCByZWNvdmVyeSBoYW5kbGVyXG5cdFx0Ly8gcmVtb3ZlcyB0aGUgY2xpZW50IGZyb20gdGhlIGNhY2hlLiBXaXRob3V0IHRoaXMsIHRoZSBuZXh0XG5cdFx0Ly8gZ2V0T3JDcmVhdGVDbGllbnQgY2FsbCBtYXkgcmV0dXJuIHRoZSBkZWFkIGNsaWVudCAoIzgxNSkuXG5cdFx0YXdhaXQgUHJvbWlzZS5yYWNlKFtcblx0XHRcdGNsaWVudC5wcm9jLmV4aXRlZCxcblx0XHRcdG5ldyBQcm9taXNlKHIgPT4gc2V0VGltZW91dChyLCAzMDAwKSksXG5cdFx0XSk7XG5cdH1cblx0cmV0dXJuIG91dHB1dDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gd2FpdEZvckRpYWdub3N0aWNzKFxuXHRjbGllbnQ6IExzcENsaWVudCxcblx0dXJpOiBzdHJpbmcsXG5cdHRpbWVvdXRNcyA9IDMwMDAsXG5cdHNpZ25hbD86IEFib3J0U2lnbmFsLFxuXHRtaW5WZXJzaW9uPzogbnVtYmVyLFxuKTogUHJvbWlzZTxEaWFnbm9zdGljW10+IHtcblx0Y29uc3Qgc3RhcnQgPSBEYXRlLm5vdygpO1xuXHR3aGlsZSAoRGF0ZS5ub3coKSAtIHN0YXJ0IDwgdGltZW91dE1zKSB7XG5cdFx0dGhyb3dJZkFib3J0ZWQoc2lnbmFsKTtcblx0XHRjb25zdCBkaWFnbm9zdGljcyA9IGNsaWVudC5kaWFnbm9zdGljcy5nZXQodXJpKTtcblx0XHRjb25zdCB2ZXJzaW9uT2sgPSBtaW5WZXJzaW9uID09PSB1bmRlZmluZWQgfHwgY2xpZW50LmRpYWdub3N0aWNzVmVyc2lvbiA+IG1pblZlcnNpb247XG5cdFx0aWYgKGRpYWdub3N0aWNzICE9PSB1bmRlZmluZWQgJiYgdmVyc2lvbk9rKSByZXR1cm4gZGlhZ25vc3RpY3M7XG5cdFx0YXdhaXQgbmV3IFByb21pc2U8dm9pZD4ocmVzb2x2ZSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIDEwMCkpO1xuXHR9XG5cdHJldHVybiBjbGllbnQuZGlhZ25vc3RpY3MuZ2V0KHVyaSkgPz8gW107XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBXb3Jrc3BhY2UgRGlhZ25vc3RpY3Ncbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmludGVyZmFjZSBQcm9qZWN0VHlwZSB7XG5cdHR5cGU6IFwicnVzdFwiIHwgXCJ0eXBlc2NyaXB0XCIgfCBcImdvXCIgfCBcInB5dGhvblwiIHwgXCJ1bmtub3duXCI7XG5cdGNvbW1hbmQ/OiBzdHJpbmdbXTtcblx0ZGVzY3JpcHRpb246IHN0cmluZztcbn1cblxuZnVuY3Rpb24gZGV0ZWN0UHJvamVjdFR5cGUoY3dkOiBzdHJpbmcpOiBQcm9qZWN0VHlwZSB7XG5cdGlmIChmcy5leGlzdHNTeW5jKHBhdGguam9pbihjd2QsIFwiQ2FyZ28udG9tbFwiKSkpIHtcblx0XHRyZXR1cm4geyB0eXBlOiBcInJ1c3RcIiwgY29tbWFuZDogW1wiY2FyZ29cIiwgXCJjaGVja1wiLCBcIi0tbWVzc2FnZS1mb3JtYXQ9c2hvcnRcIl0sIGRlc2NyaXB0aW9uOiBcIlJ1c3QgKGNhcmdvIGNoZWNrKVwiIH07XG5cdH1cblx0aWYgKGZzLmV4aXN0c1N5bmMocGF0aC5qb2luKGN3ZCwgXCJ0c2NvbmZpZy5qc29uXCIpKSkge1xuXHRcdHJldHVybiB7IHR5cGU6IFwidHlwZXNjcmlwdFwiLCBjb21tYW5kOiBbXCJucHhcIiwgXCJ0c2NcIiwgXCItLW5vRW1pdFwiXSwgZGVzY3JpcHRpb246IFwiVHlwZVNjcmlwdCAodHNjIC0tbm9FbWl0KVwiIH07XG5cdH1cblx0aWYgKGZzLmV4aXN0c1N5bmMocGF0aC5qb2luKGN3ZCwgXCJnby5tb2RcIikpKSB7XG5cdFx0cmV0dXJuIHsgdHlwZTogXCJnb1wiLCBjb21tYW5kOiBbXCJnb1wiLCBcImJ1aWxkXCIsIFwiLi8uLi5cIl0sIGRlc2NyaXB0aW9uOiBcIkdvIChnbyBidWlsZClcIiB9O1xuXHR9XG5cdGlmIChmcy5leGlzdHNTeW5jKHBhdGguam9pbihjd2QsIFwicHlwcm9qZWN0LnRvbWxcIikpIHx8IGZzLmV4aXN0c1N5bmMocGF0aC5qb2luKGN3ZCwgXCJweXJpZ2h0Y29uZmlnLmpzb25cIikpKSB7XG5cdFx0cmV0dXJuIHsgdHlwZTogXCJweXRob25cIiwgY29tbWFuZDogW1wicHlyaWdodFwiXSwgZGVzY3JpcHRpb246IFwiUHl0aG9uIChweXJpZ2h0KVwiIH07XG5cdH1cblx0cmV0dXJuIHsgdHlwZTogXCJ1bmtub3duXCIsIGRlc2NyaXB0aW9uOiBcIlVua25vd24gcHJvamVjdCB0eXBlXCIgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcnVuV29ya3NwYWNlRGlhZ25vc3RpY3MoXG5cdGN3ZDogc3RyaW5nLFxuXHRzaWduYWw/OiBBYm9ydFNpZ25hbCxcbik6IFByb21pc2U8eyBvdXRwdXQ6IHN0cmluZzsgcHJvamVjdFR5cGU6IFByb2plY3RUeXBlIH0+IHtcblx0dGhyb3dJZkFib3J0ZWQoc2lnbmFsKTtcblx0Y29uc3QgcHJvamVjdFR5cGUgPSBkZXRlY3RQcm9qZWN0VHlwZShjd2QpO1xuXHRpZiAoIXByb2plY3RUeXBlLmNvbW1hbmQpIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0b3V0cHV0OiBcIkNhbm5vdCBkZXRlY3QgcHJvamVjdCB0eXBlLiBTdXBwb3J0ZWQ6IFJ1c3QgKENhcmdvLnRvbWwpLCBUeXBlU2NyaXB0ICh0c2NvbmZpZy5qc29uKSwgR28gKGdvLm1vZCksIFB5dGhvbiAocHlwcm9qZWN0LnRvbWwpXCIsXG5cdFx0XHRwcm9qZWN0VHlwZSxcblx0XHR9O1xuXHR9XG5cdGNvbnN0IFtjbWQsIC4uLmNtZEFyZ3NdID0gcHJvamVjdFR5cGUuY29tbWFuZDtcblx0Y29uc3QgcHJvYyA9IHNwYXduKGNtZCwgY21kQXJncywge1xuXHRcdGN3ZCxcblx0XHRzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0sXG5cdFx0Ly8gT24gV2luZG93cywgcHJvamVjdC10eXBlIGNvbW1hbmRzICh0c2MsIGNhcmdvLCBldGMuKSBtYXkgYmUgLmNtZFxuXHRcdC8vIHdyYXBwZXJzIHRoYXQgbmVlZCBzaGVsbCByZXNvbHV0aW9uIHRvIGF2b2lkIEVOT0VOVC9FSU5WQUwgKCMyODU0KS5cblx0XHRzaGVsbDogcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiLFxuXHR9KTtcblx0Y29uc3QgYWJvcnRIYW5kbGVyID0gKCkgPT4ge1xuXHRcdHByb2Mua2lsbCgpO1xuXHR9O1xuXHRpZiAoc2lnbmFsKSB7XG5cdFx0c2lnbmFsLmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBhYm9ydEhhbmRsZXIsIHsgb25jZTogdHJ1ZSB9KTtcblx0fVxuXG5cdHRyeSB7XG5cdFx0Y29uc3Qgc3Rkb3V0Q2h1bmtzOiBCdWZmZXJbXSA9IFtdO1xuXHRcdGNvbnN0IHN0ZGVyckNodW5rczogQnVmZmVyW10gPSBbXTtcblxuXHRcdHByb2Muc3Rkb3V0Py5vbihcImRhdGFcIiwgKGNodW5rOiBCdWZmZXIpID0+IHN0ZG91dENodW5rcy5wdXNoKGNodW5rKSk7XG5cdFx0cHJvYy5zdGRlcnI/Lm9uKFwiZGF0YVwiLCAoY2h1bms6IEJ1ZmZlcikgPT4gc3RkZXJyQ2h1bmtzLnB1c2goY2h1bmspKTtcblxuXHRcdGNvbnN0IGV4aXRDb2RlID0gYXdhaXQgbmV3IFByb21pc2U8bnVtYmVyPigocmVzb2x2ZSkgPT4ge1xuXHRcdFx0cHJvYy5vbihcImV4aXRcIiwgKGNvZGU6IG51bWJlciB8IG51bGwpID0+IHJlc29sdmUoY29kZSA/PyAxKSk7XG5cdFx0fSk7XG5cblx0XHRjb25zdCBzdGRvdXQgPSBCdWZmZXIuY29uY2F0KHN0ZG91dENodW5rcykudG9TdHJpbmcoXCJ1dGYtOFwiKTtcblx0XHRjb25zdCBzdGRlcnIgPSBCdWZmZXIuY29uY2F0KHN0ZGVyckNodW5rcykudG9TdHJpbmcoXCJ1dGYtOFwiKTtcblxuXHRcdHRocm93SWZBYm9ydGVkKHNpZ25hbCk7XG5cdFx0Y29uc3QgY29tYmluZWQgPSAoc3Rkb3V0ICsgc3RkZXJyKS50cmltKCk7XG5cdFx0aWYgKCFjb21iaW5lZCkge1xuXHRcdFx0cmV0dXJuIHsgb3V0cHV0OiBcIk5vIGlzc3VlcyBmb3VuZFwiLCBwcm9qZWN0VHlwZSB9O1xuXHRcdH1cblx0XHRjb25zdCBsaW5lcyA9IGNvbWJpbmVkLnNwbGl0KFwiXFxuXCIpO1xuXHRcdGlmIChsaW5lcy5sZW5ndGggPiA1MCkge1xuXHRcdFx0cmV0dXJuIHsgb3V0cHV0OiBgJHtsaW5lcy5zbGljZSgwLCA1MCkuam9pbihcIlxcblwiKX1cXG4uLi4gYW5kICR7bGluZXMubGVuZ3RoIC0gNTB9IG1vcmUgbGluZXNgLCBwcm9qZWN0VHlwZSB9O1xuXHRcdH1cblx0XHRyZXR1cm4geyBvdXRwdXQ6IGNvbWJpbmVkLCBwcm9qZWN0VHlwZSB9O1xuXHR9IGNhdGNoIChlOiB1bmtub3duKSB7XG5cdFx0aWYgKHNpZ25hbD8uYWJvcnRlZCkge1xuXHRcdFx0dGhyb3cgbmV3IFRvb2xBYm9ydEVycm9yKCk7XG5cdFx0fVxuXHRcdHJldHVybiB7IG91dHB1dDogYEZhaWxlZCB0byBydW4gJHtwcm9qZWN0VHlwZS5jb21tYW5kLmpvaW4oXCIgXCIpfTogJHtlfWAsIHByb2plY3RUeXBlIH07XG5cdH0gZmluYWxseSB7XG5cdFx0c2lnbmFsPy5yZW1vdmVFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgYWJvcnRIYW5kbGVyKTtcblx0fVxufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gUGF0aCBSZXNvbHV0aW9uXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5mdW5jdGlvbiByZXNvbHZlVG9Dd2QoZmlsZTogc3RyaW5nLCBjd2Q6IHN0cmluZyk6IHN0cmluZyB7XG5cdHJldHVybiBwYXRoLnJlc29sdmUoY3dkLCBmaWxlKTtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFRvb2wgRmFjdG9yeVxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqXG4gKiBDcmVhdGUgYW4gTFNQIHRvb2wgY29uZmlndXJlZCBmb3IgYSBzcGVjaWZpYyB3b3JraW5nIGRpcmVjdG9yeS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZUxzcFRvb2woY3dkOiBzdHJpbmcpOiBBZ2VudFRvb2w8dHlwZW9mIGxzcFNjaGVtYSwgTHNwVG9vbERldGFpbHM+IHtcblx0cmV0dXJuIHtcblx0XHRuYW1lOiBcImxzcFwiLFxuXHRcdGxhYmVsOiBcIkxTUFwiLFxuXHRcdGRlc2NyaXB0aW9uOiBsc3BEZXNjcmlwdGlvbixcblx0XHRwYXJhbWV0ZXJzOiBsc3BTY2hlbWEsXG5cblx0XHRhc3luYyBleGVjdXRlKFxuXHRcdFx0X3Rvb2xDYWxsSWQ6IHN0cmluZyxcblx0XHRcdHBhcmFtczogTHNwUGFyYW1zLFxuXHRcdFx0c2lnbmFsPzogQWJvcnRTaWduYWwsXG5cdFx0XHRfb25VcGRhdGU/OiBBZ2VudFRvb2xVcGRhdGVDYWxsYmFjazxMc3BUb29sRGV0YWlscz4sXG5cdFx0KTogUHJvbWlzZTxBZ2VudFRvb2xSZXN1bHQ8THNwVG9vbERldGFpbHM+PiB7XG5cdFx0XHRjb25zdCB7IGFjdGlvbiwgZmlsZSwgbGluZSwgc3ltYm9sLCBvY2N1cnJlbmNlLCBxdWVyeSwgbmV3X25hbWUsIGFwcGx5LCB0YWJfc2l6ZSwgaW5zZXJ0X3NwYWNlcywgdGltZW91dCB9ID0gcGFyYW1zO1xuXHRcdFx0Y29uc3QgdGltZW91dFNlYyA9IGNsYW1wVGltZW91dCh0aW1lb3V0KTtcblx0XHRcdGNvbnN0IHRpbWVvdXRTaWduYWwgPSBBYm9ydFNpZ25hbC50aW1lb3V0KHRpbWVvdXRTZWMgKiAxMDAwKTtcblx0XHRcdHNpZ25hbCA9IHNpZ25hbCA/IEFib3J0U2lnbmFsLmFueShbc2lnbmFsLCB0aW1lb3V0U2lnbmFsXSkgOiB0aW1lb3V0U2lnbmFsO1xuXHRcdFx0dGhyb3dJZkFib3J0ZWQoc2lnbmFsKTtcblxuXHRcdFx0Y29uc3QgY29uZmlnID0gZ2V0Q29uZmlnKGN3ZCk7XG5cblx0XHRcdC8vIFN0YXR1cyBhY3Rpb24gZG9lc24ndCBuZWVkIGEgZmlsZVxuXHRcdFx0aWYgKGFjdGlvbiA9PT0gXCJzdGF0dXNcIikge1xuXHRcdFx0XHRjb25zdCBzZXJ2ZXJzID0gT2JqZWN0LmtleXMoY29uZmlnLnNlcnZlcnMpO1xuXHRcdFx0XHRjb25zdCBsc3BtdXhTdGF0ZSA9IGF3YWl0IGRldGVjdExzcG11eCgpO1xuXHRcdFx0XHRjb25zdCBsc3BtdXhTdGF0dXMgPSBsc3BtdXhTdGF0ZS5hdmFpbGFibGVcblx0XHRcdFx0XHQ/IGxzcG11eFN0YXRlLnJ1bm5pbmdcblx0XHRcdFx0XHRcdD8gXCJsc3BtdXg6IGFjdGl2ZSAobXVsdGlwbGV4aW5nIGVuYWJsZWQpXCJcblx0XHRcdFx0XHRcdDogXCJsc3BtdXg6IGluc3RhbGxlZCBidXQgc2VydmVyIG5vdCBydW5uaW5nXCJcblx0XHRcdFx0XHQ6IFwiXCI7XG5cblx0XHRcdFx0bGV0IHNlcnZlclN0YXR1czogc3RyaW5nO1xuXHRcdFx0XHRpZiAoc2VydmVycy5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdFx0c2VydmVyU3RhdHVzID0gYEFjdGl2ZSBsYW5ndWFnZSBzZXJ2ZXJzOiAke3NlcnZlcnMuam9pbihcIiwgXCIpfWA7XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0Ly8gRGlhZ25vc2Ugd2h5IG5vIHNlcnZlcnMgd2VyZSBkZXRlY3RlZFxuXHRcdFx0XHRcdGNvbnN0IERFRkFVTFRTID0gKGF3YWl0IGltcG9ydChcIi4vZGVmYXVsdHMuanNvblwiLCB7IHdpdGg6IHsgdHlwZTogXCJqc29uXCIgfSB9KSkuZGVmYXVsdCBhcyBSZWNvcmQ8c3RyaW5nLCB7IGNvbW1hbmQ6IHN0cmluZzsgcm9vdE1hcmtlcnM6IHN0cmluZ1tdIH0+O1xuXHRcdFx0XHRcdGNvbnN0IGRpYWdub3N0aWNzOiBzdHJpbmdbXSA9IFtcIk5vIGxhbmd1YWdlIHNlcnZlcnMgY29uZmlndXJlZCBmb3IgdGhpcyBwcm9qZWN0LlwiXTtcblx0XHRcdFx0XHRjb25zdCBtYXRjaGVkQnV0TWlzc2luZzogc3RyaW5nW10gPSBbXTtcblx0XHRcdFx0XHRjb25zdCBub01hcmtlcnM6IHN0cmluZ1tdID0gW107XG5cblx0XHRcdFx0XHRmb3IgKGNvbnN0IFtuYW1lLCBkZWZdIG9mIE9iamVjdC5lbnRyaWVzKERFRkFVTFRTKSkge1xuXHRcdFx0XHRcdFx0aWYgKGhhc1Jvb3RNYXJrZXJzKGN3ZCwgZGVmLnJvb3RNYXJrZXJzKSkge1xuXHRcdFx0XHRcdFx0XHRjb25zdCByZXNvbHZlZCA9IHJlc29sdmVDb21tYW5kKGRlZi5jb21tYW5kLCBjd2QpO1xuXHRcdFx0XHRcdFx0XHRpZiAoIXJlc29sdmVkKSB7XG5cdFx0XHRcdFx0XHRcdFx0bWF0Y2hlZEJ1dE1pc3NpbmcucHVzaChgICAke25hbWV9OiBwcm9qZWN0IGRldGVjdGVkICgke2RlZi5yb290TWFya2Vyc1swXX0pIGJ1dCAnJHtkZWYuY29tbWFuZH0nIG5vdCBmb3VuZCBcdTIwMTQgaW5zdGFsbCBpdCB3aXRoIG5wbS9waXAvYnJld2ApO1xuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0aWYgKG1hdGNoZWRCdXRNaXNzaW5nLmxlbmd0aCA+IDApIHtcblx0XHRcdFx0XHRcdGRpYWdub3N0aWNzLnB1c2goXCJcXG5EZXRlY3RlZCBwcm9qZWN0cyBtaXNzaW5nIGxhbmd1YWdlIHNlcnZlcnM6XCIpO1xuXHRcdFx0XHRcdFx0ZGlhZ25vc3RpY3MucHVzaCguLi5tYXRjaGVkQnV0TWlzc2luZyk7XG5cdFx0XHRcdFx0XHRkaWFnbm9zdGljcy5wdXNoKFwiXFxuSW5zdGFsbCB0aGUgbWlzc2luZyBzZXJ2ZXIgY29tbWFuZCBhbmQgcmVzdGFydCBHU0QsIG9yIHJ1bjogbHNwIHJlbG9hZFwiKTtcblx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0ZGlhZ25vc3RpY3MucHVzaChcIk5vIHJlY29nbml6ZWQgcHJvamVjdCBtYXJrZXJzIGZvdW5kIGluIHRoZSB3b3JraW5nIGRpcmVjdG9yeS5cIik7XG5cdFx0XHRcdFx0XHRkaWFnbm9zdGljcy5wdXNoKFwiTFNQIGF1dG8tZGV0ZWN0cyBwcm9qZWN0cyB2aWEgZmlsZXMgbGlrZSBwYWNrYWdlLmpzb24sIENhcmdvLnRvbWwsIGdvLm1vZCwgcHlwcm9qZWN0LnRvbWwsIGV0Yy5cIik7XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0c2VydmVyU3RhdHVzID0gZGlhZ25vc3RpY3Muam9pbihcIlxcblwiKTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGNvbnN0IG91dHB1dCA9IGxzcG11eFN0YXR1cyA/IGAke3NlcnZlclN0YXR1c31cXG4ke2xzcG11eFN0YXR1c31gIDogc2VydmVyU3RhdHVzO1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBvdXRwdXQgfV0sXG5cdFx0XHRcdFx0ZGV0YWlsczogeyBhY3Rpb24sIHN1Y2Nlc3M6IHRydWUsIHJlcXVlc3Q6IHBhcmFtcyB9LFxuXHRcdFx0XHR9O1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBEaWFnbm9zdGljcyBjYW4gYmUgYmF0Y2ggb3Igc2luZ2xlLWZpbGVcblx0XHRcdGlmIChhY3Rpb24gPT09IFwiZGlhZ25vc3RpY3NcIikge1xuXHRcdFx0XHRpZiAoIWZpbGUpIHtcblx0XHRcdFx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCBydW5Xb3Jrc3BhY2VEaWFnbm9zdGljcyhjd2QsIHNpZ25hbCk7XG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IFtcblx0XHRcdFx0XHRcdFx0e1xuXHRcdFx0XHRcdFx0XHRcdHR5cGU6IFwidGV4dFwiLFxuXHRcdFx0XHRcdFx0XHRcdHRleHQ6IGBXb3Jrc3BhY2UgZGlhZ25vc3RpY3MgKCR7cmVzdWx0LnByb2plY3RUeXBlLmRlc2NyaXB0aW9ufSk6XFxuJHtyZXN1bHQub3V0cHV0fWAsXG5cdFx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHRdLFxuXHRcdFx0XHRcdFx0ZGV0YWlsczogeyBhY3Rpb24sIHN1Y2Nlc3M6IHRydWUsIHJlcXVlc3Q6IHBhcmFtcyB9LFxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRsZXQgdGFyZ2V0czogc3RyaW5nW107XG5cdFx0XHRcdGxldCB0cnVuY2F0ZWRHbG9iVGFyZ2V0cyA9IGZhbHNlO1xuXHRcdFx0XHRpZiAoaGFzR2xvYlBhdHRlcm4oZmlsZSkpIHtcblx0XHRcdFx0XHRjb25zdCBnbG9iTWF0Y2hlcyA9IGF3YWl0IGNvbGxlY3RHbG9iTWF0Y2hlcyhmaWxlLCBjd2QsIE1BWF9HTE9CX0RJQUdOT1NUSUNfVEFSR0VUUyk7XG5cdFx0XHRcdFx0dGFyZ2V0cyA9IGdsb2JNYXRjaGVzLm1hdGNoZXM7XG5cdFx0XHRcdFx0dHJ1bmNhdGVkR2xvYlRhcmdldHMgPSBnbG9iTWF0Y2hlcy50cnVuY2F0ZWQ7XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0dGFyZ2V0cyA9IFtmaWxlXTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGlmICh0YXJnZXRzLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYE5vIGZpbGVzIG1hdGNoZWQgcGF0dGVybjogJHtmaWxlfWAgfV0sXG5cdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGFjdGlvbiwgc3VjY2VzczogdHJ1ZSwgcmVxdWVzdDogcGFyYW1zIH0sXG5cdFx0XHRcdFx0fTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGNvbnN0IGRldGFpbGVkID0gdGFyZ2V0cy5sZW5ndGggPiAxIHx8IHRydW5jYXRlZEdsb2JUYXJnZXRzO1xuXHRcdFx0XHRjb25zdCBkaWFnbm9zdGljc1dhaXRUaW1lb3V0TXMgPSBkZXRhaWxlZFxuXHRcdFx0XHRcdD8gTWF0aC5taW4oQkFUQ0hfRElBR05PU1RJQ1NfV0FJVF9USU1FT1VUX01TLCB0aW1lb3V0U2VjICogMTAwMClcblx0XHRcdFx0XHQ6IE1hdGgubWluKFNJTkdMRV9ESUFHTk9TVElDU19XQUlUX1RJTUVPVVRfTVMsIHRpbWVvdXRTZWMgKiAxMDAwKTtcblx0XHRcdFx0Y29uc3QgcmVzdWx0czogc3RyaW5nW10gPSBbXTtcblx0XHRcdFx0Y29uc3QgYWxsU2VydmVyTmFtZXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcblx0XHRcdFx0aWYgKHRydW5jYXRlZEdsb2JUYXJnZXRzKSB7XG5cdFx0XHRcdFx0cmVzdWx0cy5wdXNoKFxuXHRcdFx0XHRcdFx0YFtXXSBQYXR0ZXJuIG1hdGNoZWQgbW9yZSB0aGFuICR7TUFYX0dMT0JfRElBR05PU1RJQ19UQVJHRVRTfSBmaWxlczsgc2hvd2luZyBmaXJzdCAke01BWF9HTE9CX0RJQUdOT1NUSUNfVEFSR0VUU30uIE5hcnJvdyB0aGUgZ2xvYiBvciB1c2Ugd29ya3NwYWNlIGRpYWdub3N0aWNzLmAsXG5cdFx0XHRcdFx0KTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGZvciAoY29uc3QgdGFyZ2V0IG9mIHRhcmdldHMpIHtcblx0XHRcdFx0XHR0aHJvd0lmQWJvcnRlZChzaWduYWwpO1xuXHRcdFx0XHRcdGNvbnN0IHJlc29sdmVkID0gcmVzb2x2ZVRvQ3dkKHRhcmdldCwgY3dkKTtcblx0XHRcdFx0XHRjb25zdCBzZXJ2ZXJzID0gZ2V0U2VydmVyc0ZvckZpbGUoY29uZmlnLCByZXNvbHZlZCk7XG5cdFx0XHRcdFx0aWYgKHNlcnZlcnMubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRcdFx0XHRyZXN1bHRzLnB1c2goYFtFXSAke3RhcmdldH06IE5vIGxhbmd1YWdlIHNlcnZlciBmb3VuZGApO1xuXHRcdFx0XHRcdFx0Y29udGludWU7XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Y29uc3QgdXJpID0gZmlsZVRvVXJpKHJlc29sdmVkKTtcblx0XHRcdFx0XHRjb25zdCByZWxQYXRoID0gcGF0aC5yZWxhdGl2ZShjd2QsIHJlc29sdmVkKTtcblx0XHRcdFx0XHRjb25zdCBhbGxEaWFnbm9zdGljczogRGlhZ25vc3RpY1tdID0gW107XG5cblx0XHRcdFx0XHRmb3IgKGNvbnN0IFtzZXJ2ZXJOYW1lLCBzZXJ2ZXJDb25maWddIG9mIHNlcnZlcnMpIHtcblx0XHRcdFx0XHRcdGFsbFNlcnZlck5hbWVzLmFkZChzZXJ2ZXJOYW1lKTtcblx0XHRcdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0XHRcdHRocm93SWZBYm9ydGVkKHNpZ25hbCk7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IGNsaWVudCA9IGF3YWl0IGdldE9yQ3JlYXRlQ2xpZW50KHNlcnZlckNvbmZpZywgY3dkKTtcblx0XHRcdFx0XHRcdFx0Y29uc3QgbWluVmVyc2lvbiA9IGNsaWVudC5kaWFnbm9zdGljc1ZlcnNpb247XG5cdFx0XHRcdFx0XHRcdGF3YWl0IHJlZnJlc2hGaWxlKGNsaWVudCwgcmVzb2x2ZWQsIHNpZ25hbCk7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IGRpYWdub3N0aWNzID0gYXdhaXQgd2FpdEZvckRpYWdub3N0aWNzKFxuXHRcdFx0XHRcdFx0XHRcdGNsaWVudCxcblx0XHRcdFx0XHRcdFx0XHR1cmksXG5cdFx0XHRcdFx0XHRcdFx0ZGlhZ25vc3RpY3NXYWl0VGltZW91dE1zLFxuXHRcdFx0XHRcdFx0XHRcdHNpZ25hbCxcblx0XHRcdFx0XHRcdFx0XHRtaW5WZXJzaW9uLFxuXHRcdFx0XHRcdFx0XHQpO1xuXHRcdFx0XHRcdFx0XHRhbGxEaWFnbm9zdGljcy5wdXNoKC4uLmRpYWdub3N0aWNzKTtcblx0XHRcdFx0XHRcdH0gY2F0Y2ggKGVycjogdW5rbm93bikge1xuXHRcdFx0XHRcdFx0XHRpZiAoZXJyIGluc3RhbmNlb2YgVG9vbEFib3J0RXJyb3IgfHwgc2lnbmFsPy5hYm9ydGVkKSB7XG5cdFx0XHRcdFx0XHRcdFx0dGhyb3cgZXJyO1xuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Ly8gRGVkdXBsaWNhdGVcblx0XHRcdFx0XHRjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cdFx0XHRcdFx0Y29uc3QgdW5pcXVlRGlhZ25vc3RpY3M6IERpYWdub3N0aWNbXSA9IFtdO1xuXHRcdFx0XHRcdGZvciAoY29uc3QgZCBvZiBhbGxEaWFnbm9zdGljcykge1xuXHRcdFx0XHRcdFx0Y29uc3Qga2V5ID0gYCR7ZC5yYW5nZS5zdGFydC5saW5lfToke2QucmFuZ2Uuc3RhcnQuY2hhcmFjdGVyfToke2QucmFuZ2UuZW5kLmxpbmV9OiR7ZC5yYW5nZS5lbmQuY2hhcmFjdGVyfToke2QubWVzc2FnZX1gO1xuXHRcdFx0XHRcdFx0aWYgKCFzZWVuLmhhcyhrZXkpKSB7XG5cdFx0XHRcdFx0XHRcdHNlZW4uYWRkKGtleSk7XG5cdFx0XHRcdFx0XHRcdHVuaXF1ZURpYWdub3N0aWNzLnB1c2goZCk7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0c29ydERpYWdub3N0aWNzKHVuaXF1ZURpYWdub3N0aWNzKTtcblxuXHRcdFx0XHRcdGlmICghZGV0YWlsZWQgJiYgdGFyZ2V0cy5sZW5ndGggPT09IDEpIHtcblx0XHRcdFx0XHRcdGlmICh1bmlxdWVEaWFnbm9zdGljcy5sZW5ndGggPT09IDApIHtcblx0XHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJObyBkaWFnbm9zdGljc1wiIH1dLFxuXHRcdFx0XHRcdFx0XHRcdGRldGFpbHM6IHsgYWN0aW9uLCBzZXJ2ZXJOYW1lOiBBcnJheS5mcm9tKGFsbFNlcnZlck5hbWVzKS5qb2luKFwiLCBcIiksIHN1Y2Nlc3M6IHRydWUgfSxcblx0XHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0Y29uc3Qgc3VtbWFyeSA9IGZvcm1hdERpYWdub3N0aWNzU3VtbWFyeSh1bmlxdWVEaWFnbm9zdGljcyk7XG5cdFx0XHRcdFx0XHRjb25zdCBmb3JtYXR0ZWQgPSB1bmlxdWVEaWFnbm9zdGljcy5tYXAoZCA9PiBmb3JtYXREaWFnbm9zdGljKGQsIHJlbFBhdGgpKTtcblx0XHRcdFx0XHRcdGNvbnN0IG91dHB1dCA9IGAke3N1bW1hcnl9OlxcbiR7Zm9ybWF0R3JvdXBlZERpYWdub3N0aWNNZXNzYWdlcyhmb3JtYXR0ZWQpfWA7XG5cdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogb3V0cHV0IH1dLFxuXHRcdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGFjdGlvbiwgc2VydmVyTmFtZTogQXJyYXkuZnJvbShhbGxTZXJ2ZXJOYW1lcykuam9pbihcIiwgXCIpLCBzdWNjZXNzOiB0cnVlIH0sXG5cdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdGlmICh1bmlxdWVEaWFnbm9zdGljcy5sZW5ndGggPT09IDApIHtcblx0XHRcdFx0XHRcdHJlc3VsdHMucHVzaChgT0sgJHtyZWxQYXRofTogbm8gaXNzdWVzYCk7XG5cdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdGNvbnN0IHN1bW1hcnkgPSBmb3JtYXREaWFnbm9zdGljc1N1bW1hcnkodW5pcXVlRGlhZ25vc3RpY3MpO1xuXHRcdFx0XHRcdFx0cmVzdWx0cy5wdXNoKGBbRV0gJHtyZWxQYXRofTogJHtzdW1tYXJ5fWApO1xuXHRcdFx0XHRcdFx0Y29uc3QgZm9ybWF0dGVkID0gdW5pcXVlRGlhZ25vc3RpY3MubWFwKGQgPT4gZm9ybWF0RGlhZ25vc3RpYyhkLCByZWxQYXRoKSk7XG5cdFx0XHRcdFx0XHRyZXN1bHRzLnB1c2goZm9ybWF0R3JvdXBlZERpYWdub3N0aWNNZXNzYWdlcyhmb3JtYXR0ZWQpKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiByZXN1bHRzLmpvaW4oXCJcXG5cIikgfV0sXG5cdFx0XHRcdFx0ZGV0YWlsczogeyBhY3Rpb24sIHNlcnZlck5hbWU6IEFycmF5LmZyb20oYWxsU2VydmVyTmFtZXMpLmpvaW4oXCIsIFwiKSwgc3VjY2VzczogdHJ1ZSB9LFxuXHRcdFx0XHR9O1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCByZXF1aXJlc0ZpbGUgPSAhZmlsZSAmJiBhY3Rpb24gIT09IFwic3ltYm9sc1wiICYmIGFjdGlvbiAhPT0gXCJyZWxvYWRcIjtcblxuXHRcdFx0aWYgKHJlcXVpcmVzRmlsZSkge1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkVycm9yOiBmaWxlIHBhcmFtZXRlciByZXF1aXJlZCBmb3IgdGhpcyBhY3Rpb25cIiB9XSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7IGFjdGlvbiwgc3VjY2VzczogZmFsc2UgfSxcblx0XHRcdFx0fTtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgcmVzb2x2ZWRGaWxlID0gZmlsZSA/IHJlc29sdmVUb0N3ZChmaWxlLCBjd2QpIDogbnVsbDtcblxuXHRcdFx0Ly8gV29ya3NwYWNlIHN5bWJvbCBzZWFyY2ggKG5vIGZpbGUpXG5cdFx0XHRpZiAoYWN0aW9uID09PSBcInN5bWJvbHNcIiAmJiAhcmVzb2x2ZWRGaWxlKSB7XG5cdFx0XHRcdGNvbnN0IG5vcm1hbGl6ZWRRdWVyeSA9IHF1ZXJ5Py50cmltKCk7XG5cdFx0XHRcdGlmICghbm9ybWFsaXplZFF1ZXJ5KSB7XG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkVycm9yOiBxdWVyeSBwYXJhbWV0ZXIgcmVxdWlyZWQgZm9yIHdvcmtzcGFjZSBzeW1ib2wgc2VhcmNoXCIgfV0sXG5cdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGFjdGlvbiwgc3VjY2VzczogZmFsc2UsIHJlcXVlc3Q6IHBhcmFtcyB9LFxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdH1cblx0XHRcdFx0Y29uc3Qgc2VydmVycyA9IGdldExzcFNlcnZlcnMoY29uZmlnKTtcblx0XHRcdFx0aWYgKHNlcnZlcnMubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIk5vIGxhbmd1YWdlIHNlcnZlciBmb3VuZCBmb3IgdGhpcyBhY3Rpb25cIiB9XSxcblx0XHRcdFx0XHRcdGRldGFpbHM6IHsgYWN0aW9uLCBzdWNjZXNzOiBmYWxzZSwgcmVxdWVzdDogcGFyYW1zIH0sXG5cdFx0XHRcdFx0fTtcblx0XHRcdFx0fVxuXHRcdFx0XHRjb25zdCBhZ2dyZWdhdGVkU3ltYm9sczogU3ltYm9sSW5mb3JtYXRpb25bXSA9IFtdO1xuXHRcdFx0XHRjb25zdCByZXNwb25kaW5nU2VydmVycyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXHRcdFx0XHRmb3IgKGNvbnN0IFt3b3Jrc3BhY2VTZXJ2ZXJOYW1lLCB3b3Jrc3BhY2VTZXJ2ZXJDb25maWddIG9mIHNlcnZlcnMpIHtcblx0XHRcdFx0XHR0aHJvd0lmQWJvcnRlZChzaWduYWwpO1xuXHRcdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0XHRjb25zdCB3b3Jrc3BhY2VDbGllbnQgPSBhd2FpdCBnZXRPckNyZWF0ZUNsaWVudCh3b3Jrc3BhY2VTZXJ2ZXJDb25maWcsIGN3ZCk7XG5cdFx0XHRcdFx0XHRjb25zdCB3b3Jrc3BhY2VSZXN1bHQgPSAoYXdhaXQgc2VuZFJlcXVlc3QoXG5cdFx0XHRcdFx0XHRcdHdvcmtzcGFjZUNsaWVudCxcblx0XHRcdFx0XHRcdFx0XCJ3b3Jrc3BhY2Uvc3ltYm9sXCIsXG5cdFx0XHRcdFx0XHRcdHsgcXVlcnk6IG5vcm1hbGl6ZWRRdWVyeSB9LFxuXHRcdFx0XHRcdFx0XHRzaWduYWwsXG5cdFx0XHRcdFx0XHQpKSBhcyBTeW1ib2xJbmZvcm1hdGlvbltdIHwgbnVsbDtcblx0XHRcdFx0XHRcdGlmICghd29ya3NwYWNlUmVzdWx0IHx8IHdvcmtzcGFjZVJlc3VsdC5sZW5ndGggPT09IDApIHtcblx0XHRcdFx0XHRcdFx0Y29udGludWU7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRyZXNwb25kaW5nU2VydmVycy5hZGQod29ya3NwYWNlU2VydmVyTmFtZSk7XG5cdFx0XHRcdFx0XHRhZ2dyZWdhdGVkU3ltYm9scy5wdXNoKC4uLmZpbHRlcldvcmtzcGFjZVN5bWJvbHMod29ya3NwYWNlUmVzdWx0LCBub3JtYWxpemVkUXVlcnkpKTtcblx0XHRcdFx0XHR9IGNhdGNoIChlcnI6IHVua25vd24pIHtcblx0XHRcdFx0XHRcdGlmIChlcnIgaW5zdGFuY2VvZiBUb29sQWJvcnRFcnJvciB8fCBzaWduYWw/LmFib3J0ZWQpIHtcblx0XHRcdFx0XHRcdFx0dGhyb3cgZXJyO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXHRcdFx0XHRjb25zdCBkZWR1cGVkU3ltYm9scyA9IGRlZHVwZVdvcmtzcGFjZVN5bWJvbHMoYWdncmVnYXRlZFN5bWJvbHMpO1xuXHRcdFx0XHRpZiAoZGVkdXBlZFN5bWJvbHMubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgTm8gc3ltYm9scyBtYXRjaGluZyBcIiR7bm9ybWFsaXplZFF1ZXJ5fVwiYCB9XSxcblx0XHRcdFx0XHRcdGRldGFpbHM6IHtcblx0XHRcdFx0XHRcdFx0YWN0aW9uLFxuXHRcdFx0XHRcdFx0XHRzZXJ2ZXJOYW1lOiBBcnJheS5mcm9tKHJlc3BvbmRpbmdTZXJ2ZXJzKS5qb2luKFwiLCBcIiksXG5cdFx0XHRcdFx0XHRcdHN1Y2Nlc3M6IHRydWUsXG5cdFx0XHRcdFx0XHRcdHJlcXVlc3Q6IHBhcmFtcyxcblx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0fTtcblx0XHRcdFx0fVxuXHRcdFx0XHRjb25zdCBsaW1pdGVkU3ltYm9scyA9IGRlZHVwZWRTeW1ib2xzLnNsaWNlKDAsIFdPUktTUEFDRV9TWU1CT0xfTElNSVQpO1xuXHRcdFx0XHRjb25zdCBsaW5lcyA9IGxpbWl0ZWRTeW1ib2xzLm1hcChzID0+IGZvcm1hdFN5bWJvbEluZm9ybWF0aW9uKHMsIGN3ZCkpO1xuXHRcdFx0XHRjb25zdCB0cnVuY2F0aW9uTGluZSA9XG5cdFx0XHRcdFx0ZGVkdXBlZFN5bWJvbHMubGVuZ3RoID4gV09SS1NQQUNFX1NZTUJPTF9MSU1JVFxuXHRcdFx0XHRcdFx0PyBgXFxuLi4uICR7ZGVkdXBlZFN5bWJvbHMubGVuZ3RoIC0gV09SS1NQQUNFX1NZTUJPTF9MSU1JVH0gYWRkaXRpb25hbCBzeW1ib2wocykgb21pdHRlZGBcblx0XHRcdFx0XHRcdDogXCJcIjtcblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiBbXG5cdFx0XHRcdFx0XHR7XG5cdFx0XHRcdFx0XHRcdHR5cGU6IFwidGV4dFwiLFxuXHRcdFx0XHRcdFx0XHR0ZXh0OiBgRm91bmQgJHtkZWR1cGVkU3ltYm9scy5sZW5ndGh9IHN5bWJvbChzKSBtYXRjaGluZyBcIiR7bm9ybWFsaXplZFF1ZXJ5fVwiOlxcbiR7bGluZXMubWFwKGwgPT4gYCAgJHtsfWApLmpvaW4oXCJcXG5cIil9JHt0cnVuY2F0aW9uTGluZX1gLFxuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRdLFxuXHRcdFx0XHRcdGRldGFpbHM6IHtcblx0XHRcdFx0XHRcdGFjdGlvbixcblx0XHRcdFx0XHRcdHNlcnZlck5hbWU6IEFycmF5LmZyb20ocmVzcG9uZGluZ1NlcnZlcnMpLmpvaW4oXCIsIFwiKSxcblx0XHRcdFx0XHRcdHN1Y2Nlc3M6IHRydWUsXG5cdFx0XHRcdFx0XHRyZXF1ZXN0OiBwYXJhbXMsXG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0fTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gUmVsb2FkIGFsbCBzZXJ2ZXJzIChubyBmaWxlKVxuXHRcdFx0aWYgKGFjdGlvbiA9PT0gXCJyZWxvYWRcIiAmJiAhcmVzb2x2ZWRGaWxlKSB7XG5cdFx0XHRcdGNvbnN0IHNlcnZlcnMgPSBnZXRMc3BTZXJ2ZXJzKGNvbmZpZyk7XG5cdFx0XHRcdGlmIChzZXJ2ZXJzLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJObyBsYW5ndWFnZSBzZXJ2ZXIgZm91bmQgZm9yIHRoaXMgYWN0aW9uXCIgfV0sXG5cdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGFjdGlvbiwgc3VjY2VzczogZmFsc2UsIHJlcXVlc3Q6IHBhcmFtcyB9LFxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdH1cblx0XHRcdFx0Y29uc3Qgb3V0cHV0czogc3RyaW5nW10gPSBbXTtcblx0XHRcdFx0Zm9yIChjb25zdCBbd29ya3NwYWNlU2VydmVyTmFtZSwgd29ya3NwYWNlU2VydmVyQ29uZmlnXSBvZiBzZXJ2ZXJzKSB7XG5cdFx0XHRcdFx0dGhyb3dJZkFib3J0ZWQoc2lnbmFsKTtcblx0XHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdFx0Y29uc3Qgd29ya3NwYWNlQ2xpZW50ID0gYXdhaXQgZ2V0T3JDcmVhdGVDbGllbnQod29ya3NwYWNlU2VydmVyQ29uZmlnLCBjd2QpO1xuXHRcdFx0XHRcdFx0b3V0cHV0cy5wdXNoKGF3YWl0IHJlbG9hZFNlcnZlcih3b3Jrc3BhY2VDbGllbnQsIHdvcmtzcGFjZVNlcnZlck5hbWUsIHNpZ25hbCkpO1xuXHRcdFx0XHRcdH0gY2F0Y2ggKGVycjogdW5rbm93bikge1xuXHRcdFx0XHRcdFx0aWYgKGVyciBpbnN0YW5jZW9mIFRvb2xBYm9ydEVycm9yIHx8IHNpZ25hbD8uYWJvcnRlZCkge1xuXHRcdFx0XHRcdFx0XHR0aHJvdyBlcnI7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRjb25zdCBlcnJvck1lc3NhZ2UgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG5cdFx0XHRcdFx0XHRvdXRwdXRzLnB1c2goYEZhaWxlZCB0byByZWxvYWQgJHt3b3Jrc3BhY2VTZXJ2ZXJOYW1lfTogJHtlcnJvck1lc3NhZ2V9YCk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IG91dHB1dHMuam9pbihcIlxcblwiKSB9XSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7IGFjdGlvbiwgc2VydmVyTmFtZTogc2VydmVycy5tYXAoKFtuYW1lXSkgPT4gbmFtZSkuam9pbihcIiwgXCIpLCBzdWNjZXNzOiB0cnVlLCByZXF1ZXN0OiBwYXJhbXMgfSxcblx0XHRcdFx0fTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gRmlsZS1zcGVjaWZpYyBhY3Rpb25zXG5cdFx0XHRjb25zdCBzZXJ2ZXJJbmZvID0gcmVzb2x2ZWRGaWxlID8gZ2V0U2VydmVyRm9yRmlsZShjb25maWcsIHJlc29sdmVkRmlsZSkgOiBudWxsO1xuXHRcdFx0aWYgKCFzZXJ2ZXJJbmZvKSB7XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiTm8gbGFuZ3VhZ2Ugc2VydmVyIGZvdW5kIGZvciB0aGlzIGFjdGlvblwiIH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IHsgYWN0aW9uLCBzdWNjZXNzOiBmYWxzZSB9LFxuXHRcdFx0XHR9O1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCBbc2VydmVyTmFtZSwgc2VydmVyQ29uZmlnXSA9IHNlcnZlckluZm87XG5cblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnN0IGNsaWVudCA9IGF3YWl0IGdldE9yQ3JlYXRlQ2xpZW50KHNlcnZlckNvbmZpZywgY3dkKTtcblx0XHRcdFx0Y29uc3QgdGFyZ2V0RmlsZSA9IHJlc29sdmVkRmlsZTtcblxuXHRcdFx0XHRpZiAodGFyZ2V0RmlsZSkge1xuXHRcdFx0XHRcdGF3YWl0IGVuc3VyZUZpbGVPcGVuKGNsaWVudCwgdGFyZ2V0RmlsZSwgc2lnbmFsKTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGNvbnN0IHVyaSA9IHRhcmdldEZpbGUgPyBmaWxlVG9VcmkodGFyZ2V0RmlsZSkgOiBcIlwiO1xuXHRcdFx0XHRjb25zdCByZXNvbHZlZExpbmUgPSBsaW5lID8/IDE7XG5cdFx0XHRcdGNvbnN0IHJlc29sdmVkQ2hhcmFjdGVyID0gdGFyZ2V0RmlsZVxuXHRcdFx0XHRcdD8gYXdhaXQgcmVzb2x2ZVN5bWJvbENvbHVtbih0YXJnZXRGaWxlLCByZXNvbHZlZExpbmUsIHN5bWJvbCwgb2NjdXJyZW5jZSlcblx0XHRcdFx0XHQ6IDA7XG5cdFx0XHRcdGNvbnN0IHBvc2l0aW9uID0geyBsaW5lOiByZXNvbHZlZExpbmUgLSAxLCBjaGFyYWN0ZXI6IHJlc29sdmVkQ2hhcmFjdGVyIH07XG5cblx0XHRcdFx0bGV0IG91dHB1dDogc3RyaW5nO1xuXG5cdFx0XHRcdHN3aXRjaCAoYWN0aW9uKSB7XG5cdFx0XHRcdFx0Y2FzZSBcImRlZmluaXRpb25cIjoge1xuXHRcdFx0XHRcdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgc2VuZFJlcXVlc3QoXG5cdFx0XHRcdFx0XHRcdGNsaWVudCxcblx0XHRcdFx0XHRcdFx0XCJ0ZXh0RG9jdW1lbnQvZGVmaW5pdGlvblwiLFxuXHRcdFx0XHRcdFx0XHR7IHRleHREb2N1bWVudDogeyB1cmkgfSwgcG9zaXRpb24gfSxcblx0XHRcdFx0XHRcdFx0c2lnbmFsLFxuXHRcdFx0XHRcdFx0KTtcblx0XHRcdFx0XHRcdG91dHB1dCA9IGF3YWl0IGZvcm1hdExvY2F0aW9uUmVzdWx0cyhyZXN1bHQgYXMgTG9jYXRpb24gfCBMb2NhdGlvbltdIHwgTG9jYXRpb25MaW5rIHwgTG9jYXRpb25MaW5rW10gfCBudWxsLCBcImRlZmluaXRpb25cIiwgY3dkKTtcblx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdGNhc2UgXCJ0eXBlX2RlZmluaXRpb25cIjoge1xuXHRcdFx0XHRcdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgc2VuZFJlcXVlc3QoXG5cdFx0XHRcdFx0XHRcdGNsaWVudCxcblx0XHRcdFx0XHRcdFx0XCJ0ZXh0RG9jdW1lbnQvdHlwZURlZmluaXRpb25cIixcblx0XHRcdFx0XHRcdFx0eyB0ZXh0RG9jdW1lbnQ6IHsgdXJpIH0sIHBvc2l0aW9uIH0sXG5cdFx0XHRcdFx0XHRcdHNpZ25hbCxcblx0XHRcdFx0XHRcdCk7XG5cdFx0XHRcdFx0XHRvdXRwdXQgPSBhd2FpdCBmb3JtYXRMb2NhdGlvblJlc3VsdHMocmVzdWx0IGFzIExvY2F0aW9uIHwgTG9jYXRpb25bXSB8IExvY2F0aW9uTGluayB8IExvY2F0aW9uTGlua1tdIHwgbnVsbCwgXCJ0eXBlIGRlZmluaXRpb25cIiwgY3dkKTtcblx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdGNhc2UgXCJpbXBsZW1lbnRhdGlvblwiOiB7XG5cdFx0XHRcdFx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCBzZW5kUmVxdWVzdChcblx0XHRcdFx0XHRcdFx0Y2xpZW50LFxuXHRcdFx0XHRcdFx0XHRcInRleHREb2N1bWVudC9pbXBsZW1lbnRhdGlvblwiLFxuXHRcdFx0XHRcdFx0XHR7IHRleHREb2N1bWVudDogeyB1cmkgfSwgcG9zaXRpb24gfSxcblx0XHRcdFx0XHRcdFx0c2lnbmFsLFxuXHRcdFx0XHRcdFx0KTtcblx0XHRcdFx0XHRcdG91dHB1dCA9IGF3YWl0IGZvcm1hdExvY2F0aW9uUmVzdWx0cyhyZXN1bHQgYXMgTG9jYXRpb24gfCBMb2NhdGlvbltdIHwgTG9jYXRpb25MaW5rIHwgTG9jYXRpb25MaW5rW10gfCBudWxsLCBcImltcGxlbWVudGF0aW9uXCIsIGN3ZCk7XG5cdFx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRjYXNlIFwicmVmZXJlbmNlc1wiOiB7XG5cdFx0XHRcdFx0XHRjb25zdCByZXN1bHQgPSAoYXdhaXQgc2VuZFJlcXVlc3QoXG5cdFx0XHRcdFx0XHRcdGNsaWVudCxcblx0XHRcdFx0XHRcdFx0XCJ0ZXh0RG9jdW1lbnQvcmVmZXJlbmNlc1wiLFxuXHRcdFx0XHRcdFx0XHR7XG5cdFx0XHRcdFx0XHRcdFx0dGV4dERvY3VtZW50OiB7IHVyaSB9LFxuXHRcdFx0XHRcdFx0XHRcdHBvc2l0aW9uLFxuXHRcdFx0XHRcdFx0XHRcdGNvbnRleHQ6IHsgaW5jbHVkZURlY2xhcmF0aW9uOiB0cnVlIH0sXG5cdFx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHRcdHNpZ25hbCxcblx0XHRcdFx0XHRcdCkpIGFzIExvY2F0aW9uW10gfCBudWxsO1xuXG5cdFx0XHRcdFx0XHRpZiAoIXJlc3VsdCB8fCByZXN1bHQubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRcdFx0XHRcdG91dHB1dCA9IFwiTm8gcmVmZXJlbmNlcyBmb3VuZFwiO1xuXHRcdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdFx0Y29uc3QgY29udGV4dHVhbFJlZmVyZW5jZXMgPSByZXN1bHQuc2xpY2UoMCwgUkVGRVJFTkNFX0NPTlRFWFRfTElNSVQpO1xuXHRcdFx0XHRcdFx0XHRjb25zdCBwbGFpblJlZmVyZW5jZXMgPSByZXN1bHQuc2xpY2UoUkVGRVJFTkNFX0NPTlRFWFRfTElNSVQpO1xuXHRcdFx0XHRcdFx0XHRjb25zdCBjb250ZXh0dWFsTGluZXMgPSBhd2FpdCBQcm9taXNlLmFsbChcblx0XHRcdFx0XHRcdFx0XHRjb250ZXh0dWFsUmVmZXJlbmNlcy5tYXAobG9jYXRpb24gPT4gZm9ybWF0TG9jYXRpb25XaXRoQ29udGV4dChsb2NhdGlvbiwgY3dkKSksXG5cdFx0XHRcdFx0XHRcdCk7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IHBsYWluTGluZXMgPSBwbGFpblJlZmVyZW5jZXMubWFwKGxvY2F0aW9uID0+IGAgICR7Zm9ybWF0TG9jYXRpb24obG9jYXRpb24sIGN3ZCl9YCk7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IGxpbmVzID0gcGxhaW5MaW5lcy5sZW5ndGhcblx0XHRcdFx0XHRcdFx0XHQ/IFtcblx0XHRcdFx0XHRcdFx0XHRcdFx0Li4uY29udGV4dHVhbExpbmVzLFxuXHRcdFx0XHRcdFx0XHRcdFx0XHRgICAuLi4gJHtwbGFpbkxpbmVzLmxlbmd0aH0gYWRkaXRpb25hbCByZWZlcmVuY2Uocykgc2hvd24gd2l0aG91dCBjb250ZXh0YCxcblx0XHRcdFx0XHRcdFx0XHRcdFx0Li4ucGxhaW5MaW5lcyxcblx0XHRcdFx0XHRcdFx0XHRcdF1cblx0XHRcdFx0XHRcdFx0XHQ6IGNvbnRleHR1YWxMaW5lcztcblx0XHRcdFx0XHRcdFx0b3V0cHV0ID0gYEZvdW5kICR7cmVzdWx0Lmxlbmd0aH0gcmVmZXJlbmNlKHMpOlxcbiR7bGluZXMuam9pbihcIlxcblwiKX1gO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Y2FzZSBcImhvdmVyXCI6IHtcblx0XHRcdFx0XHRcdGNvbnN0IHJlc3VsdCA9IChhd2FpdCBzZW5kUmVxdWVzdChcblx0XHRcdFx0XHRcdFx0Y2xpZW50LFxuXHRcdFx0XHRcdFx0XHRcInRleHREb2N1bWVudC9ob3ZlclwiLFxuXHRcdFx0XHRcdFx0XHR7XG5cdFx0XHRcdFx0XHRcdFx0dGV4dERvY3VtZW50OiB7IHVyaSB9LFxuXHRcdFx0XHRcdFx0XHRcdHBvc2l0aW9uLFxuXHRcdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdFx0XHRzaWduYWwsXG5cdFx0XHRcdFx0XHQpKSBhcyBIb3ZlciB8IG51bGw7XG5cblx0XHRcdFx0XHRcdGlmICghcmVzdWx0IHx8ICFyZXN1bHQuY29udGVudHMpIHtcblx0XHRcdFx0XHRcdFx0b3V0cHV0ID0gXCJObyBob3ZlciBpbmZvcm1hdGlvblwiO1xuXHRcdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdFx0b3V0cHV0ID0gZXh0cmFjdEhvdmVyVGV4dChyZXN1bHQuY29udGVudHMpO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Y2FzZSBcImNvZGVfYWN0aW9uc1wiOiB7XG5cdFx0XHRcdFx0XHRjb25zdCBkaWFnbm9zdGljcyA9IGNsaWVudC5kaWFnbm9zdGljcy5nZXQodXJpKSA/PyBbXTtcblx0XHRcdFx0XHRcdGNvbnN0IGNvbnRleHQ6IENvZGVBY3Rpb25Db250ZXh0ID0ge1xuXHRcdFx0XHRcdFx0XHRkaWFnbm9zdGljcyxcblx0XHRcdFx0XHRcdFx0b25seTogIWFwcGx5ICYmIHF1ZXJ5ID8gW3F1ZXJ5XSA6IHVuZGVmaW5lZCxcblx0XHRcdFx0XHRcdFx0dHJpZ2dlcktpbmQ6IDEsXG5cdFx0XHRcdFx0XHR9O1xuXG5cdFx0XHRcdFx0XHRjb25zdCByZXN1bHQgPSAoYXdhaXQgc2VuZFJlcXVlc3QoXG5cdFx0XHRcdFx0XHRcdGNsaWVudCxcblx0XHRcdFx0XHRcdFx0XCJ0ZXh0RG9jdW1lbnQvY29kZUFjdGlvblwiLFxuXHRcdFx0XHRcdFx0XHR7XG5cdFx0XHRcdFx0XHRcdFx0dGV4dERvY3VtZW50OiB7IHVyaSB9LFxuXHRcdFx0XHRcdFx0XHRcdHJhbmdlOiB7IHN0YXJ0OiBwb3NpdGlvbiwgZW5kOiBwb3NpdGlvbiB9LFxuXHRcdFx0XHRcdFx0XHRcdGNvbnRleHQsXG5cdFx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHRcdHNpZ25hbCxcblx0XHRcdFx0XHRcdCkpIGFzIChDb2RlQWN0aW9uIHwgQ29tbWFuZClbXSB8IG51bGw7XG5cblx0XHRcdFx0XHRcdGlmICghcmVzdWx0IHx8IHJlc3VsdC5sZW5ndGggPT09IDApIHtcblx0XHRcdFx0XHRcdFx0b3V0cHV0ID0gXCJObyBjb2RlIGFjdGlvbnMgYXZhaWxhYmxlXCI7XG5cdFx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHRpZiAoYXBwbHkgPT09IHRydWUgJiYgcXVlcnkpIHtcblx0XHRcdFx0XHRcdFx0Y29uc3Qgbm9ybWFsaXplZFF1ZXJ5ID0gcXVlcnkudHJpbSgpO1xuXHRcdFx0XHRcdFx0XHRpZiAobm9ybWFsaXplZFF1ZXJ5Lmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0XHRcdFx0XHRcdG91dHB1dCA9IFwiRXJyb3I6IHF1ZXJ5IHBhcmFtZXRlciByZXF1aXJlZCB3aGVuIGFwcGx5PXRydWUgZm9yIGNvZGVfYWN0aW9uc1wiO1xuXHRcdFx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdGNvbnN0IHBhcnNlZEluZGV4ID0gL15cXGQrJC8udGVzdChub3JtYWxpemVkUXVlcnkpID8gTnVtYmVyLnBhcnNlSW50KG5vcm1hbGl6ZWRRdWVyeSwgMTApIDogbnVsbDtcblx0XHRcdFx0XHRcdFx0Y29uc3Qgc2VsZWN0ZWRBY3Rpb24gPSByZXN1bHQuZmluZChcblx0XHRcdFx0XHRcdFx0XHQoYWN0aW9uSXRlbSwgaW5kZXgpID0+XG5cdFx0XHRcdFx0XHRcdFx0XHQocGFyc2VkSW5kZXggIT09IG51bGwgJiYgaW5kZXggPT09IHBhcnNlZEluZGV4KSB8fFxuXHRcdFx0XHRcdFx0XHRcdFx0YWN0aW9uSXRlbS50aXRsZS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKG5vcm1hbGl6ZWRRdWVyeS50b0xvd2VyQ2FzZSgpKSxcblx0XHRcdFx0XHRcdFx0KTtcblxuXHRcdFx0XHRcdFx0XHRpZiAoIXNlbGVjdGVkQWN0aW9uKSB7XG5cdFx0XHRcdFx0XHRcdFx0Y29uc3QgYWN0aW9uTGluZXMgPSByZXN1bHQubWFwKChhY3Rpb25JdGVtLCBpbmRleCkgPT4gYCAgJHtmb3JtYXRDb2RlQWN0aW9uKGFjdGlvbkl0ZW0sIGluZGV4KX1gKTtcblx0XHRcdFx0XHRcdFx0XHRvdXRwdXQgPSBgTm8gY29kZSBhY3Rpb24gbWF0Y2hlcyBcIiR7bm9ybWFsaXplZFF1ZXJ5fVwiLiBBdmFpbGFibGUgYWN0aW9uczpcXG4ke2FjdGlvbkxpbmVzLmpvaW4oXCJcXG5cIil9YDtcblx0XHRcdFx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHRcdGNvbnN0IGFwcGxpZWRBY3Rpb24gPSBhd2FpdCBhcHBseUNvZGVBY3Rpb24oc2VsZWN0ZWRBY3Rpb24sIHtcblx0XHRcdFx0XHRcdFx0XHRyZXNvbHZlQ29kZUFjdGlvbjogYXN5bmMgKGFjdGlvbkl0ZW06IENvZGVBY3Rpb24pID0+XG5cdFx0XHRcdFx0XHRcdFx0XHQoYXdhaXQgc2VuZFJlcXVlc3QoY2xpZW50LCBcImNvZGVBY3Rpb24vcmVzb2x2ZVwiLCBhY3Rpb25JdGVtLCBzaWduYWwpKSBhcyBDb2RlQWN0aW9uLFxuXHRcdFx0XHRcdFx0XHRcdGFwcGx5V29ya3NwYWNlRWRpdDogYXN5bmMgKGVkaXQ6IFdvcmtzcGFjZUVkaXQpID0+IGFwcGx5V29ya3NwYWNlRWRpdChlZGl0LCBjd2QpLFxuXHRcdFx0XHRcdFx0XHRcdGV4ZWN1dGVDb21tYW5kOiBhc3luYyAoY29tbWFuZEl0ZW06IENvbW1hbmQpID0+IHtcblx0XHRcdFx0XHRcdFx0XHRcdGF3YWl0IHNlbmRSZXF1ZXN0KFxuXHRcdFx0XHRcdFx0XHRcdFx0XHRjbGllbnQsXG5cdFx0XHRcdFx0XHRcdFx0XHRcdFwid29ya3NwYWNlL2V4ZWN1dGVDb21tYW5kXCIsXG5cdFx0XHRcdFx0XHRcdFx0XHRcdHtcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRjb21tYW5kOiBjb21tYW5kSXRlbS5jb21tYW5kLFxuXHRcdFx0XHRcdFx0XHRcdFx0XHRcdGFyZ3VtZW50czogY29tbWFuZEl0ZW0uYXJndW1lbnRzID8/IFtdLFxuXHRcdFx0XHRcdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdFx0XHRcdFx0XHRzaWduYWwsXG5cdFx0XHRcdFx0XHRcdFx0XHQpO1xuXHRcdFx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHRcdH0pO1xuXG5cdFx0XHRcdFx0XHRcdGlmICghYXBwbGllZEFjdGlvbikge1xuXHRcdFx0XHRcdFx0XHRcdG91dHB1dCA9IGBBY3Rpb24gXCIke3NlbGVjdGVkQWN0aW9uLnRpdGxlfVwiIGhhcyBubyB3b3Jrc3BhY2UgZWRpdCBvciBjb21tYW5kIHRvIGFwcGx5YDtcblx0XHRcdFx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHRcdGNvbnN0IHN1bW1hcnlMaW5lczogc3RyaW5nW10gPSBbXTtcblx0XHRcdFx0XHRcdFx0aWYgKGFwcGxpZWRBY3Rpb24uZWRpdHMubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRcdFx0XHRcdHN1bW1hcnlMaW5lcy5wdXNoKFwiICBXb3Jrc3BhY2UgZWRpdDpcIik7XG5cdFx0XHRcdFx0XHRcdFx0c3VtbWFyeUxpbmVzLnB1c2goLi4uYXBwbGllZEFjdGlvbi5lZGl0cy5tYXAoaXRlbSA9PiBgICAgICR7aXRlbX1gKSk7XG5cdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0aWYgKGFwcGxpZWRBY3Rpb24uZXhlY3V0ZWRDb21tYW5kcy5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdFx0XHRcdFx0c3VtbWFyeUxpbmVzLnB1c2goXCIgIEV4ZWN1dGVkIGNvbW1hbmQocyk6XCIpO1xuXHRcdFx0XHRcdFx0XHRcdHN1bW1hcnlMaW5lcy5wdXNoKC4uLmFwcGxpZWRBY3Rpb24uZXhlY3V0ZWRDb21tYW5kcy5tYXAoY29tbWFuZE5hbWUgPT4gYCAgICAke2NvbW1hbmROYW1lfWApKTtcblx0XHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHRcdG91dHB1dCA9IGBBcHBsaWVkIFwiJHthcHBsaWVkQWN0aW9uLnRpdGxlfVwiOlxcbiR7c3VtbWFyeUxpbmVzLmpvaW4oXCJcXG5cIil9YDtcblx0XHRcdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdGNvbnN0IGFjdGlvbkxpbmVzID0gcmVzdWx0Lm1hcCgoYWN0aW9uSXRlbSwgaW5kZXgpID0+IGAgICR7Zm9ybWF0Q29kZUFjdGlvbihhY3Rpb25JdGVtLCBpbmRleCl9YCk7XG5cdFx0XHRcdFx0XHRvdXRwdXQgPSBgJHtyZXN1bHQubGVuZ3RofSBjb2RlIGFjdGlvbihzKTpcXG4ke2FjdGlvbkxpbmVzLmpvaW4oXCJcXG5cIil9YDtcblx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdGNhc2UgXCJzeW1ib2xzXCI6IHtcblx0XHRcdFx0XHRcdGlmICghdGFyZ2V0RmlsZSkge1xuXHRcdFx0XHRcdFx0XHRvdXRwdXQgPSBcIkVycm9yOiBmaWxlIHBhcmFtZXRlciByZXF1aXJlZCBmb3IgZG9jdW1lbnQgc3ltYm9sc1wiO1xuXHRcdFx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdGNvbnN0IHJlc3VsdCA9IChhd2FpdCBzZW5kUmVxdWVzdChcblx0XHRcdFx0XHRcdFx0Y2xpZW50LFxuXHRcdFx0XHRcdFx0XHRcInRleHREb2N1bWVudC9kb2N1bWVudFN5bWJvbFwiLFxuXHRcdFx0XHRcdFx0XHR7XG5cdFx0XHRcdFx0XHRcdFx0dGV4dERvY3VtZW50OiB7IHVyaSB9LFxuXHRcdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdFx0XHRzaWduYWwsXG5cdFx0XHRcdFx0XHQpKSBhcyAoRG9jdW1lbnRTeW1ib2wgfCBTeW1ib2xJbmZvcm1hdGlvbilbXSB8IG51bGw7XG5cblx0XHRcdFx0XHRcdGlmICghcmVzdWx0IHx8IHJlc3VsdC5sZW5ndGggPT09IDApIHtcblx0XHRcdFx0XHRcdFx0b3V0cHV0ID0gXCJObyBzeW1ib2xzIGZvdW5kXCI7XG5cdFx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0XHRjb25zdCByZWxQYXRoID0gcGF0aC5yZWxhdGl2ZShjd2QsIHRhcmdldEZpbGUpO1xuXHRcdFx0XHRcdFx0XHRpZiAoXCJzZWxlY3Rpb25SYW5nZVwiIGluIHJlc3VsdFswXSkge1xuXHRcdFx0XHRcdFx0XHRcdGNvbnN0IGxpbmVzID0gKHJlc3VsdCBhcyBEb2N1bWVudFN5bWJvbFtdKS5mbGF0TWFwKHMgPT4gZm9ybWF0RG9jdW1lbnRTeW1ib2wocykpO1xuXHRcdFx0XHRcdFx0XHRcdG91dHB1dCA9IGBTeW1ib2xzIGluICR7cmVsUGF0aH06XFxuJHtsaW5lcy5qb2luKFwiXFxuXCIpfWA7XG5cdFx0XHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHRcdFx0Y29uc3QgbGluZXMgPSAocmVzdWx0IGFzIFN5bWJvbEluZm9ybWF0aW9uW10pLm1hcChzID0+IHtcblx0XHRcdFx0XHRcdFx0XHRcdGNvbnN0IGxpbmUgPSBzLmxvY2F0aW9uLnJhbmdlLnN0YXJ0LmxpbmUgKyAxO1xuXHRcdFx0XHRcdFx0XHRcdFx0Y29uc3QgaWNvbiA9IHN5bWJvbEtpbmRUb0ljb24ocy5raW5kKTtcblx0XHRcdFx0XHRcdFx0XHRcdHJldHVybiBgJHtpY29ufSAke3MubmFtZX0gQCBsaW5lICR7bGluZX1gO1xuXHRcdFx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdFx0XHRcdG91dHB1dCA9IGBTeW1ib2xzIGluICR7cmVsUGF0aH06XFxuJHtsaW5lcy5qb2luKFwiXFxuXCIpfWA7XG5cdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdGNhc2UgXCJpbmNvbWluZ19jYWxsc1wiOiB7XG5cdFx0XHRcdFx0XHRvdXRwdXQgPSBhd2FpdCBmb3JtYXRDYWxsSGllcmFyY2h5UmVzdWx0cyhjbGllbnQsIHBvc2l0aW9uLCB1cmksIFwiaW5jb21pbmdcIiwgY3dkLCBzaWduYWwpO1xuXHRcdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Y2FzZSBcIm91dGdvaW5nX2NhbGxzXCI6IHtcblx0XHRcdFx0XHRcdG91dHB1dCA9IGF3YWl0IGZvcm1hdENhbGxIaWVyYXJjaHlSZXN1bHRzKGNsaWVudCwgcG9zaXRpb24sIHVyaSwgXCJvdXRnb2luZ1wiLCBjd2QsIHNpZ25hbCk7XG5cdFx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRjYXNlIFwiZm9ybWF0XCI6IHtcblx0XHRcdFx0XHRcdGlmICghdGFyZ2V0RmlsZSkge1xuXHRcdFx0XHRcdFx0XHRvdXRwdXQgPSBcIkVycm9yOiBmaWxlIHBhcmFtZXRlciByZXF1aXJlZCBmb3IgZm9ybWF0XCI7XG5cdFx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHRjb25zdCBmb3JtYXRSZXN1bHQgPSAoYXdhaXQgc2VuZFJlcXVlc3QoXG5cdFx0XHRcdFx0XHRcdGNsaWVudCxcblx0XHRcdFx0XHRcdFx0XCJ0ZXh0RG9jdW1lbnQvZm9ybWF0dGluZ1wiLFxuXHRcdFx0XHRcdFx0XHR7XG5cdFx0XHRcdFx0XHRcdFx0dGV4dERvY3VtZW50OiB7IHVyaSB9LFxuXHRcdFx0XHRcdFx0XHRcdG9wdGlvbnM6IHtcblx0XHRcdFx0XHRcdFx0XHRcdHRhYlNpemU6IHRhYl9zaXplID8/IDQsXG5cdFx0XHRcdFx0XHRcdFx0XHRpbnNlcnRTcGFjZXM6IGluc2VydF9zcGFjZXMgPz8gdHJ1ZSxcblx0XHRcdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdFx0XHRzaWduYWwsXG5cdFx0XHRcdFx0XHQpKSBhcyBUZXh0RWRpdFtdIHwgbnVsbDtcblxuXHRcdFx0XHRcdFx0aWYgKCFmb3JtYXRSZXN1bHQgfHwgZm9ybWF0UmVzdWx0Lmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0XHRcdFx0XHRjb25zdCByZWxQYXRoID0gcGF0aC5yZWxhdGl2ZShjd2QsIHRhcmdldEZpbGUpO1xuXHRcdFx0XHRcdFx0XHRvdXRwdXQgPSBgJHtyZWxQYXRofTogYWxyZWFkeSBmb3JtYXR0ZWQgKG5vIGNoYW5nZXMpYDtcblx0XHRcdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdGF3YWl0IGFwcGx5VGV4dEVkaXRzKHRhcmdldEZpbGUsIGZvcm1hdFJlc3VsdCk7XG5cdFx0XHRcdFx0XHRjb25zdCByZWxQYXRoID0gcGF0aC5yZWxhdGl2ZShjd2QsIHRhcmdldEZpbGUpO1xuXHRcdFx0XHRcdFx0b3V0cHV0ID0gYEZvcm1hdHRlZCAke3JlbFBhdGh9OiAke2Zvcm1hdFJlc3VsdC5sZW5ndGh9IGVkaXQocykgYXBwbGllZGA7XG5cdFx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRjYXNlIFwic2lnbmF0dXJlXCI6IHtcblx0XHRcdFx0XHRcdGNvbnN0IHNpZ1Jlc3VsdCA9IChhd2FpdCBzZW5kUmVxdWVzdChcblx0XHRcdFx0XHRcdFx0Y2xpZW50LFxuXHRcdFx0XHRcdFx0XHRcInRleHREb2N1bWVudC9zaWduYXR1cmVIZWxwXCIsXG5cdFx0XHRcdFx0XHRcdHtcblx0XHRcdFx0XHRcdFx0XHR0ZXh0RG9jdW1lbnQ6IHsgdXJpIH0sXG5cdFx0XHRcdFx0XHRcdFx0cG9zaXRpb24sXG5cdFx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHRcdHNpZ25hbCxcblx0XHRcdFx0XHRcdCkpIGFzIFNpZ25hdHVyZUhlbHAgfCBudWxsO1xuXG5cdFx0XHRcdFx0XHRpZiAoIXNpZ1Jlc3VsdCB8fCAhc2lnUmVzdWx0LnNpZ25hdHVyZXMgfHwgc2lnUmVzdWx0LnNpZ25hdHVyZXMubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRcdFx0XHRcdG91dHB1dCA9IFwiTm8gc2lnbmF0dXJlIGluZm9ybWF0aW9uIGF0IHRoaXMgcG9zaXRpb25cIjtcblx0XHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHRcdG91dHB1dCA9IGZvcm1hdFNpZ25hdHVyZUhlbHAoc2lnUmVzdWx0KTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdGNhc2UgXCJyZW5hbWVcIjoge1xuXHRcdFx0XHRcdFx0aWYgKCFuZXdfbmFtZSkge1xuXHRcdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkVycm9yOiBuZXdfbmFtZSBwYXJhbWV0ZXIgcmVxdWlyZWQgZm9yIHJlbmFtZVwiIH1dLFxuXHRcdFx0XHRcdFx0XHRcdGRldGFpbHM6IHsgYWN0aW9uLCBzZXJ2ZXJOYW1lLCBzdWNjZXNzOiBmYWxzZSB9LFxuXHRcdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHRjb25zdCByZXN1bHQgPSAoYXdhaXQgc2VuZFJlcXVlc3QoXG5cdFx0XHRcdFx0XHRcdGNsaWVudCxcblx0XHRcdFx0XHRcdFx0XCJ0ZXh0RG9jdW1lbnQvcmVuYW1lXCIsXG5cdFx0XHRcdFx0XHRcdHtcblx0XHRcdFx0XHRcdFx0XHR0ZXh0RG9jdW1lbnQ6IHsgdXJpIH0sXG5cdFx0XHRcdFx0XHRcdFx0cG9zaXRpb24sXG5cdFx0XHRcdFx0XHRcdFx0bmV3TmFtZTogbmV3X25hbWUsXG5cdFx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHRcdHNpZ25hbCxcblx0XHRcdFx0XHRcdCkpIGFzIFdvcmtzcGFjZUVkaXQgfCBudWxsO1xuXG5cdFx0XHRcdFx0XHRpZiAoIXJlc3VsdCkge1xuXHRcdFx0XHRcdFx0XHRvdXRwdXQgPSBcIlJlbmFtZSByZXR1cm5lZCBubyBlZGl0c1wiO1xuXHRcdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdFx0Y29uc3Qgc2hvdWxkQXBwbHkgPSBhcHBseSAhPT0gZmFsc2U7XG5cdFx0XHRcdFx0XHRcdGlmIChzaG91bGRBcHBseSkge1xuXHRcdFx0XHRcdFx0XHRcdGNvbnN0IGFwcGxpZWQgPSBhd2FpdCBhcHBseVdvcmtzcGFjZUVkaXQocmVzdWx0LCBjd2QpO1xuXHRcdFx0XHRcdFx0XHRcdG91dHB1dCA9IGBBcHBsaWVkIHJlbmFtZTpcXG4ke2FwcGxpZWQubWFwKGEgPT4gYCAgJHthfWApLmpvaW4oXCJcXG5cIil9YDtcblx0XHRcdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdFx0XHRjb25zdCBwcmV2aWV3ID0gZm9ybWF0V29ya3NwYWNlRWRpdChyZXN1bHQsIGN3ZCk7XG5cdFx0XHRcdFx0XHRcdFx0b3V0cHV0ID0gYFJlbmFtZSBwcmV2aWV3OlxcbiR7cHJldmlldy5tYXAocCA9PiBgICAke3B9YCkuam9pbihcIlxcblwiKX1gO1xuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRjYXNlIFwicmVsb2FkXCI6IHtcblx0XHRcdFx0XHRcdG91dHB1dCA9IGF3YWl0IHJlbG9hZFNlcnZlcihjbGllbnQsIHNlcnZlck5hbWUsIHNpZ25hbCk7XG5cdFx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRkZWZhdWx0OlxuXHRcdFx0XHRcdFx0b3V0cHV0ID0gYFVua25vd24gYWN0aW9uOiAke2FjdGlvbn1gO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogb3V0cHV0IH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IHsgc2VydmVyTmFtZSwgYWN0aW9uLCBzdWNjZXNzOiB0cnVlLCByZXF1ZXN0OiBwYXJhbXMgfSxcblx0XHRcdFx0fTtcblx0XHRcdH0gY2F0Y2ggKGVycjogdW5rbm93bikge1xuXHRcdFx0XHRpZiAoZXJyIGluc3RhbmNlb2YgVG9vbEFib3J0RXJyb3IgfHwgc2lnbmFsPy5hYm9ydGVkKSB7XG5cdFx0XHRcdFx0dGhyb3cgbmV3IFRvb2xBYm9ydEVycm9yKCk7XG5cdFx0XHRcdH1cblx0XHRcdFx0Y29uc3QgZXJyb3JNZXNzYWdlID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgTFNQIGVycm9yOiAke2Vycm9yTWVzc2FnZX1gIH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IHsgc2VydmVyTmFtZSwgYWN0aW9uLCBzdWNjZXNzOiBmYWxzZSwgcmVxdWVzdDogcGFyYW1zIH0sXG5cdFx0XHRcdH07XG5cdFx0XHR9XG5cdFx0fSxcblx0fTtcbn1cblxuLyoqXG4gKiBEZWZhdWx0IExTUCB0b29sIHVzaW5nIHByb2Nlc3MuY3dkKCkuXG4gKi9cbmV4cG9ydCBjb25zdCBsc3BUb29sID0gY3JlYXRlTHNwVG9vbChwcm9jZXNzLmN3ZCgpKTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFlBQVksUUFBUTtBQUNwQixZQUFZLFlBQVk7QUFDeEIsWUFBWSxVQUFVO0FBQ3RCLFNBQVMsYUFBYTtBQUN0QixTQUFTLHFCQUFxQjtBQUU5QjtBQUFBLEVBQ0M7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBRUE7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNNO0FBQ1AsU0FBUyxrQkFBa0IsbUJBQW1DLFlBQVksZ0JBQWdCLHNCQUFzQjtBQUNoSCxTQUFTLGdCQUFnQiwwQkFBMEI7QUFDbkQsU0FBUyxnQkFBZ0IsY0FBYyxzQkFBc0I7QUFDN0QsU0FBUyxvQkFBb0I7QUFDN0I7QUFBQSxFQWVDO0FBQUEsT0FNTTtBQUNQO0FBQUEsRUFDQztBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ007QUFJUCxTQUFTLGFBQUFBLGtCQUFpQjtBQUUxQixNQUFNLFlBQVksS0FBSyxRQUFRLGNBQWMsWUFBWSxHQUFHLENBQUM7QUFDN0QsTUFBTSxpQkFBaUIsT0FBTyxhQUFhLEtBQUssS0FBSyxXQUFXLFFBQVEsR0FBRyxPQUFPO0FBZWxGLGVBQXNCLGlCQUFpQixLQUF1QztBQUM3RSxRQUFNLFNBQVMsV0FBVyxHQUFHO0FBQzdCLGlCQUFlLE9BQU8sYUFBYTtBQUNuQyxRQUFNLFVBQXNDLENBQUM7QUFDN0MsUUFBTSxhQUFhLGNBQWMsTUFBTTtBQUV2QyxRQUFNLFVBQVUsTUFBTSxRQUFRO0FBQUEsSUFDN0IsV0FBVyxJQUFJLE9BQU8sQ0FBQyxNQUFNLFlBQVksTUFBTTtBQUM5QyxZQUFNLFNBQVMsTUFBTSxrQkFBa0IsY0FBYyxLQUFLLGFBQWEsbUJBQW1CLGlCQUFpQjtBQUMzRyxhQUFPLEVBQUUsTUFBTSxRQUFRLFdBQVcsYUFBYSxVQUFVO0FBQUEsSUFDMUQsQ0FBQztBQUFBLEVBQ0Y7QUFFQSxXQUFTLElBQUksR0FBRyxJQUFJLFFBQVEsUUFBUSxLQUFLO0FBQ3hDLFVBQU0sU0FBUyxRQUFRLENBQUM7QUFDeEIsVUFBTSxDQUFDLE1BQU0sWUFBWSxJQUFJLFdBQVcsQ0FBQztBQUN6QyxRQUFJLE9BQU8sV0FBVyxhQUFhO0FBQ2xDLGNBQVEsS0FBSztBQUFBLFFBQ1osTUFBTSxPQUFPLE1BQU07QUFBQSxRQUNuQixRQUFRO0FBQUEsUUFDUixXQUFXLE9BQU8sTUFBTTtBQUFBLE1BQ3pCLENBQUM7QUFBQSxJQUNGLE9BQU87QUFDTixjQUFRLEtBQUs7QUFBQSxRQUNaO0FBQUEsUUFDQSxRQUFRO0FBQUEsUUFDUixXQUFXLGFBQWE7QUFBQSxRQUN4QixPQUFPLE9BQU8sUUFBUSxXQUFXLE9BQU8sT0FBTyxNQUFNO0FBQUEsTUFDdEQsQ0FBQztBQUFBLElBQ0Y7QUFBQSxFQUNEO0FBRUEsU0FBTyxFQUFFLFFBQVE7QUFDbEI7QUFFTyxTQUFTLGVBQWtDO0FBQ2pELFNBQU8saUJBQWlCO0FBQ3pCO0FBTUEsTUFBTSxjQUFjLG9CQUFJLElBQXVCO0FBRS9DLFNBQVMsVUFBVSxLQUF3QjtBQUMxQyxNQUFJLFNBQVMsWUFBWSxJQUFJLEdBQUc7QUFDaEMsTUFBSSxDQUFDLFFBQVE7QUFDWixhQUFTLFdBQVcsR0FBRztBQUN2QixtQkFBZSxPQUFPLGFBQWE7QUFDbkMsZ0JBQVksSUFBSSxLQUFLLE1BQU07QUFBQSxFQUM1QjtBQUNBLFNBQU87QUFDUjtBQUVBLFNBQVMsY0FBYyxRQUFrRDtBQUN4RSxTQUFPLE9BQU8sUUFBUSxPQUFPLE9BQU87QUFDckM7QUFFQSxNQUFNLDJCQUEyQjtBQUNqQyxNQUFNLHFDQUFxQztBQUMzQyxNQUFNLG9DQUFvQztBQUMxQyxNQUFNLDhCQUE4QjtBQUNwQyxNQUFNLHlCQUF5QjtBQUUvQixTQUFTLHdCQUF3QixVQUE4QjtBQUM5RCxNQUFJLFNBQVMsVUFBVSwwQkFBMEI7QUFDaEQsV0FBTztBQUFBLEVBQ1I7QUFDQSxTQUFPLFNBQVMsTUFBTSxHQUFHLHdCQUF3QjtBQUNsRDtBQUVBLE1BQU0seUJBQXlCO0FBQy9CLE1BQU0sMEJBQTBCO0FBRWhDLFNBQVMsd0JBQXdCLFFBQWtGO0FBQ2xILE1BQUksQ0FBQyxPQUFRLFFBQU8sQ0FBQztBQUNyQixRQUFNLE1BQU0sTUFBTSxRQUFRLE1BQU0sSUFBSSxTQUFTLENBQUMsTUFBTTtBQUNwRCxTQUFPLElBQUksUUFBUSxTQUFPO0FBQ3pCLFFBQUksU0FBUyxLQUFLO0FBQ2pCLGFBQU8sQ0FBQyxHQUFlO0FBQUEsSUFDeEI7QUFDQSxRQUFJLGVBQWUsS0FBSztBQUN2QixZQUFNLE9BQU87QUFDYixhQUFPLENBQUMsRUFBRSxLQUFLLEtBQUssV0FBVyxPQUFPLEtBQUssd0JBQXdCLEtBQUssWUFBWSxDQUFDO0FBQUEsSUFDdEY7QUFDQSxXQUFPLENBQUM7QUFBQSxFQUNULENBQUM7QUFDRjtBQUVBLGVBQWUsMEJBQTBCLFVBQW9CLEtBQThCO0FBQzFGLFFBQU0sU0FBUyxLQUFLLGVBQWUsVUFBVSxHQUFHLENBQUM7QUFDakQsUUFBTSxVQUFVLE1BQU07QUFBQSxJQUNyQixVQUFVLFNBQVMsR0FBRztBQUFBLElBQ3RCLFNBQVMsTUFBTSxNQUFNLE9BQU87QUFBQSxJQUM1QjtBQUFBLEVBQ0Q7QUFDQSxNQUFJLFFBQVEsV0FBVyxHQUFHO0FBQ3pCLFdBQU87QUFBQSxFQUNSO0FBQ0EsU0FBTyxHQUFHLE1BQU07QUFBQSxFQUFLLFFBQVEsSUFBSSxjQUFZLE9BQU8sUUFBUSxFQUFFLEVBQUUsS0FBSyxJQUFJLENBQUM7QUFDM0U7QUFFQSxlQUFlLHNCQUNkLFFBQ0EsT0FDQSxLQUNrQjtBQUNsQixRQUFNLFlBQVksd0JBQXdCLE1BQU07QUFDaEQsTUFBSSxVQUFVLFdBQVcsR0FBRztBQUMzQixXQUFPLE1BQU0sS0FBSztBQUFBLEVBQ25CO0FBQ0EsUUFBTSxRQUFRLE1BQU0sUUFBUSxJQUFJLFVBQVUsSUFBSSxjQUFZLDBCQUEwQixVQUFVLEdBQUcsQ0FBQyxDQUFDO0FBQ25HLFNBQU8sU0FBUyxVQUFVLE1BQU0sSUFBSSxLQUFLO0FBQUEsRUFBUyxNQUFNLEtBQUssSUFBSSxDQUFDO0FBQ25FO0FBRUEsZUFBZSwyQkFDZCxRQUNBLFVBQ0EsS0FDQSxXQUNBLEtBQ0EsUUFDa0I7QUFDbEIsUUFBTSxnQkFBaUIsTUFBTTtBQUFBLElBQzVCO0FBQUEsSUFDQTtBQUFBLElBQ0EsRUFBRSxjQUFjLEVBQUUsSUFBSSxHQUFHLFNBQVM7QUFBQSxJQUNsQztBQUFBLEVBQ0Q7QUFFQSxNQUFJLENBQUMsaUJBQWlCLGNBQWMsV0FBVyxHQUFHO0FBQ2pELFdBQU87QUFBQSxFQUNSO0FBRUEsUUFBTSxTQUFTLGNBQWMsYUFBYSxnQ0FBZ0M7QUFDMUUsUUFBTSxhQUFjLE1BQU0sWUFBWSxRQUFRLFFBQVEsRUFBRSxNQUFNLGNBQWMsQ0FBQyxFQUFFLEdBQUcsTUFBTTtBQUt4RixNQUFJLENBQUMsY0FBYyxXQUFXLFdBQVcsR0FBRztBQUMzQyxVQUFNLE9BQU8sY0FBYyxhQUFhLG1CQUFtQjtBQUMzRCxVQUFNQyxRQUFPLGNBQWMsYUFBYSxRQUFRO0FBQ2hELFdBQU8sTUFBTSxJQUFJLFVBQVVBLEtBQUksSUFBSSxjQUFjLENBQUMsRUFBRSxJQUFJO0FBQUEsRUFDekQ7QUFFQSxRQUFNLFFBQWtCLENBQUM7QUFDekIsUUFBTSxVQUFVLFdBQVcsTUFBTSxHQUFHLHVCQUF1QjtBQUMzRCxhQUFXLFFBQVEsU0FBUztBQUMzQixVQUFNLE9BQU8sVUFBVSxPQUFPLEtBQUssT0FBTyxLQUFLO0FBQy9DLFVBQU0sU0FBUyx3QkFBd0IsTUFBTSxHQUFHO0FBQ2hELFVBQU0sV0FBVyxVQUFVLEtBQUssR0FBRztBQUNuQyxVQUFNLFlBQVksVUFBVSxPQUFPLEtBQUssV0FBVyxDQUFDLEdBQUcsTUFBTSxPQUFPLFdBQWMsS0FBSyxlQUFlLE1BQU07QUFDNUcsVUFBTSxVQUFVLE1BQU0sb0JBQW9CLFVBQVUsV0FBVyxHQUFHLHNCQUFzQjtBQUN4RixRQUFJLFFBQVEsU0FBUyxHQUFHO0FBQ3ZCLFlBQU0sS0FBSyxLQUFLLE1BQU07QUFBQSxFQUFLLFFBQVEsSUFBSSxPQUFLLE9BQU8sQ0FBQyxFQUFFLEVBQUUsS0FBSyxJQUFJLENBQUMsRUFBRTtBQUFBLElBQ3JFLE9BQU87QUFDTixZQUFNLEtBQUssS0FBSyxNQUFNLEVBQUU7QUFBQSxJQUN6QjtBQUFBLEVBQ0Q7QUFFQSxRQUFNLE9BQU8sY0FBYyxhQUFhLFdBQVc7QUFDbkQsUUFBTSxPQUFPLGNBQWMsYUFBYSxPQUFPO0FBQy9DLFFBQU0sYUFBYSxXQUFXLFNBQVMsMEJBQ3BDO0FBQUEsUUFBVyxXQUFXLFNBQVMsdUJBQXVCLGVBQWUsSUFBSSxnQkFDekU7QUFDSCxTQUFPLEdBQUcsV0FBVyxNQUFNLElBQUksSUFBSSxPQUFPLElBQUksSUFBSSxjQUFjLENBQUMsRUFBRSxJQUFJO0FBQUEsRUFBTSxNQUFNLEtBQUssSUFBSSxDQUFDLEdBQUcsVUFBVTtBQUMzRztBQUVBLGVBQWUsYUFBYSxRQUFtQixZQUFvQixRQUF1QztBQUN6RyxNQUFJLFNBQVMsYUFBYSxVQUFVO0FBQ3BDLFFBQU0sZ0JBQWdCLENBQUMsaUNBQWlDLGtDQUFrQztBQUMxRixhQUFXLFVBQVUsZUFBZTtBQUNuQyxRQUFJO0FBQ0gsWUFBTSxZQUFZLFFBQVEsUUFBUSxPQUFPLFNBQVMsZUFBZSxJQUFJLEVBQUUsVUFBVSxDQUFDLEVBQUUsSUFBSSxNQUFNLE1BQU07QUFDcEcsZUFBUyxZQUFZLFVBQVU7QUFDL0I7QUFBQSxJQUNELFFBQVE7QUFBQSxJQUVSO0FBQUEsRUFDRDtBQUNBLE1BQUksT0FBTyxXQUFXLFdBQVcsR0FBRztBQUNuQyxXQUFPLEtBQUssS0FBSztBQUlqQixVQUFNLFFBQVEsS0FBSztBQUFBLE1BQ2xCLE9BQU8sS0FBSztBQUFBLE1BQ1osSUFBSSxRQUFRLE9BQUssV0FBVyxHQUFHLEdBQUksQ0FBQztBQUFBLElBQ3JDLENBQUM7QUFBQSxFQUNGO0FBQ0EsU0FBTztBQUNSO0FBRUEsZUFBZSxtQkFDZCxRQUNBLEtBQ0EsWUFBWSxLQUNaLFFBQ0EsWUFDd0I7QUFDeEIsUUFBTSxRQUFRLEtBQUssSUFBSTtBQUN2QixTQUFPLEtBQUssSUFBSSxJQUFJLFFBQVEsV0FBVztBQUN0QyxtQkFBZSxNQUFNO0FBQ3JCLFVBQU0sY0FBYyxPQUFPLFlBQVksSUFBSSxHQUFHO0FBQzlDLFVBQU0sWUFBWSxlQUFlLFVBQWEsT0FBTyxxQkFBcUI7QUFDMUUsUUFBSSxnQkFBZ0IsVUFBYSxVQUFXLFFBQU87QUFDbkQsVUFBTSxJQUFJLFFBQWMsYUFBVyxXQUFXLFNBQVMsR0FBRyxDQUFDO0FBQUEsRUFDNUQ7QUFDQSxTQUFPLE9BQU8sWUFBWSxJQUFJLEdBQUcsS0FBSyxDQUFDO0FBQ3hDO0FBWUEsU0FBUyxrQkFBa0IsS0FBMEI7QUFDcEQsTUFBSSxHQUFHLFdBQVcsS0FBSyxLQUFLLEtBQUssWUFBWSxDQUFDLEdBQUc7QUFDaEQsV0FBTyxFQUFFLE1BQU0sUUFBUSxTQUFTLENBQUMsU0FBUyxTQUFTLHdCQUF3QixHQUFHLGFBQWEscUJBQXFCO0FBQUEsRUFDakg7QUFDQSxNQUFJLEdBQUcsV0FBVyxLQUFLLEtBQUssS0FBSyxlQUFlLENBQUMsR0FBRztBQUNuRCxXQUFPLEVBQUUsTUFBTSxjQUFjLFNBQVMsQ0FBQyxPQUFPLE9BQU8sVUFBVSxHQUFHLGFBQWEsNEJBQTRCO0FBQUEsRUFDNUc7QUFDQSxNQUFJLEdBQUcsV0FBVyxLQUFLLEtBQUssS0FBSyxRQUFRLENBQUMsR0FBRztBQUM1QyxXQUFPLEVBQUUsTUFBTSxNQUFNLFNBQVMsQ0FBQyxNQUFNLFNBQVMsT0FBTyxHQUFHLGFBQWEsZ0JBQWdCO0FBQUEsRUFDdEY7QUFDQSxNQUFJLEdBQUcsV0FBVyxLQUFLLEtBQUssS0FBSyxnQkFBZ0IsQ0FBQyxLQUFLLEdBQUcsV0FBVyxLQUFLLEtBQUssS0FBSyxvQkFBb0IsQ0FBQyxHQUFHO0FBQzNHLFdBQU8sRUFBRSxNQUFNLFVBQVUsU0FBUyxDQUFDLFNBQVMsR0FBRyxhQUFhLG1CQUFtQjtBQUFBLEVBQ2hGO0FBQ0EsU0FBTyxFQUFFLE1BQU0sV0FBVyxhQUFhLHVCQUF1QjtBQUMvRDtBQUVBLGVBQWUsd0JBQ2QsS0FDQSxRQUN3RDtBQUN4RCxpQkFBZSxNQUFNO0FBQ3JCLFFBQU0sY0FBYyxrQkFBa0IsR0FBRztBQUN6QyxNQUFJLENBQUMsWUFBWSxTQUFTO0FBQ3pCLFdBQU87QUFBQSxNQUNOLFFBQVE7QUFBQSxNQUNSO0FBQUEsSUFDRDtBQUFBLEVBQ0Q7QUFDQSxRQUFNLENBQUMsS0FBSyxHQUFHLE9BQU8sSUFBSSxZQUFZO0FBQ3RDLFFBQU0sT0FBTyxNQUFNLEtBQUssU0FBUztBQUFBLElBQ2hDO0FBQUEsSUFDQSxPQUFPLENBQUMsVUFBVSxRQUFRLE1BQU07QUFBQTtBQUFBO0FBQUEsSUFHaEMsT0FBTyxRQUFRLGFBQWE7QUFBQSxFQUM3QixDQUFDO0FBQ0QsUUFBTSxlQUFlLE1BQU07QUFDMUIsU0FBSyxLQUFLO0FBQUEsRUFDWDtBQUNBLE1BQUksUUFBUTtBQUNYLFdBQU8saUJBQWlCLFNBQVMsY0FBYyxFQUFFLE1BQU0sS0FBSyxDQUFDO0FBQUEsRUFDOUQ7QUFFQSxNQUFJO0FBQ0gsVUFBTSxlQUF5QixDQUFDO0FBQ2hDLFVBQU0sZUFBeUIsQ0FBQztBQUVoQyxTQUFLLFFBQVEsR0FBRyxRQUFRLENBQUMsVUFBa0IsYUFBYSxLQUFLLEtBQUssQ0FBQztBQUNuRSxTQUFLLFFBQVEsR0FBRyxRQUFRLENBQUMsVUFBa0IsYUFBYSxLQUFLLEtBQUssQ0FBQztBQUVuRSxVQUFNLFdBQVcsTUFBTSxJQUFJLFFBQWdCLENBQUMsWUFBWTtBQUN2RCxXQUFLLEdBQUcsUUFBUSxDQUFDLFNBQXdCLFFBQVEsUUFBUSxDQUFDLENBQUM7QUFBQSxJQUM1RCxDQUFDO0FBRUQsVUFBTSxTQUFTLE9BQU8sT0FBTyxZQUFZLEVBQUUsU0FBUyxPQUFPO0FBQzNELFVBQU0sU0FBUyxPQUFPLE9BQU8sWUFBWSxFQUFFLFNBQVMsT0FBTztBQUUzRCxtQkFBZSxNQUFNO0FBQ3JCLFVBQU0sWUFBWSxTQUFTLFFBQVEsS0FBSztBQUN4QyxRQUFJLENBQUMsVUFBVTtBQUNkLGFBQU8sRUFBRSxRQUFRLG1CQUFtQixZQUFZO0FBQUEsSUFDakQ7QUFDQSxVQUFNLFFBQVEsU0FBUyxNQUFNLElBQUk7QUFDakMsUUFBSSxNQUFNLFNBQVMsSUFBSTtBQUN0QixhQUFPLEVBQUUsUUFBUSxHQUFHLE1BQU0sTUFBTSxHQUFHLEVBQUUsRUFBRSxLQUFLLElBQUksQ0FBQztBQUFBLFVBQWEsTUFBTSxTQUFTLEVBQUUsZUFBZSxZQUFZO0FBQUEsSUFDM0c7QUFDQSxXQUFPLEVBQUUsUUFBUSxVQUFVLFlBQVk7QUFBQSxFQUN4QyxTQUFTLEdBQVk7QUFDcEIsUUFBSSxRQUFRLFNBQVM7QUFDcEIsWUFBTSxJQUFJLGVBQWU7QUFBQSxJQUMxQjtBQUNBLFdBQU8sRUFBRSxRQUFRLGlCQUFpQixZQUFZLFFBQVEsS0FBSyxHQUFHLENBQUMsS0FBSyxDQUFDLElBQUksWUFBWTtBQUFBLEVBQ3RGLFVBQUU7QUFDRCxZQUFRLG9CQUFvQixTQUFTLFlBQVk7QUFBQSxFQUNsRDtBQUNEO0FBTUEsU0FBUyxhQUFhLE1BQWMsS0FBcUI7QUFDeEQsU0FBTyxLQUFLLFFBQVEsS0FBSyxJQUFJO0FBQzlCO0FBU08sU0FBUyxjQUFjLEtBQTBEO0FBQ3ZGLFNBQU87QUFBQSxJQUNOLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLGFBQWE7QUFBQSxJQUNiLFlBQVk7QUFBQSxJQUVaLE1BQU0sUUFDTCxhQUNBLFFBQ0EsUUFDQSxXQUMyQztBQUMzQyxZQUFNLEVBQUUsUUFBUSxNQUFNLE1BQU0sUUFBUSxZQUFZLE9BQU8sVUFBVSxPQUFPLFVBQVUsZUFBZSxRQUFRLElBQUk7QUFDN0csWUFBTSxhQUFhLGFBQWEsT0FBTztBQUN2QyxZQUFNLGdCQUFnQixZQUFZLFFBQVEsYUFBYSxHQUFJO0FBQzNELGVBQVMsU0FBUyxZQUFZLElBQUksQ0FBQyxRQUFRLGFBQWEsQ0FBQyxJQUFJO0FBQzdELHFCQUFlLE1BQU07QUFFckIsWUFBTSxTQUFTLFVBQVUsR0FBRztBQUc1QixVQUFJLFdBQVcsVUFBVTtBQUN4QixjQUFNLFVBQVUsT0FBTyxLQUFLLE9BQU8sT0FBTztBQUMxQyxjQUFNLGNBQWMsTUFBTSxhQUFhO0FBQ3ZDLGNBQU0sZUFBZSxZQUFZLFlBQzlCLFlBQVksVUFDWCwwQ0FDQSw2Q0FDRDtBQUVILFlBQUk7QUFDSixZQUFJLFFBQVEsU0FBUyxHQUFHO0FBQ3ZCLHlCQUFlLDRCQUE0QixRQUFRLEtBQUssSUFBSSxDQUFDO0FBQUEsUUFDOUQsT0FBTztBQUVOLGdCQUFNLFlBQVksTUFBTSxPQUFPLG1CQUFtQixFQUFFLE1BQU0sRUFBRSxNQUFNLE9BQU8sRUFBRSxDQUFDLEdBQUc7QUFDL0UsZ0JBQU0sY0FBd0IsQ0FBQyxrREFBa0Q7QUFDakYsZ0JBQU0sb0JBQThCLENBQUM7QUFDckMsZ0JBQU0sWUFBc0IsQ0FBQztBQUU3QixxQkFBVyxDQUFDLE1BQU0sR0FBRyxLQUFLLE9BQU8sUUFBUSxRQUFRLEdBQUc7QUFDbkQsZ0JBQUksZUFBZSxLQUFLLElBQUksV0FBVyxHQUFHO0FBQ3pDLG9CQUFNLFdBQVcsZUFBZSxJQUFJLFNBQVMsR0FBRztBQUNoRCxrQkFBSSxDQUFDLFVBQVU7QUFDZCxrQ0FBa0IsS0FBSyxLQUFLLElBQUksdUJBQXVCLElBQUksWUFBWSxDQUFDLENBQUMsVUFBVSxJQUFJLE9BQU8saURBQTRDO0FBQUEsY0FDM0k7QUFBQSxZQUNEO0FBQUEsVUFDRDtBQUVBLGNBQUksa0JBQWtCLFNBQVMsR0FBRztBQUNqQyx3QkFBWSxLQUFLLCtDQUErQztBQUNoRSx3QkFBWSxLQUFLLEdBQUcsaUJBQWlCO0FBQ3JDLHdCQUFZLEtBQUssMEVBQTBFO0FBQUEsVUFDNUYsT0FBTztBQUNOLHdCQUFZLEtBQUssK0RBQStEO0FBQ2hGLHdCQUFZLEtBQUssaUdBQWlHO0FBQUEsVUFDbkg7QUFFQSx5QkFBZSxZQUFZLEtBQUssSUFBSTtBQUFBLFFBQ3JDO0FBRUEsY0FBTSxTQUFTLGVBQWUsR0FBRyxZQUFZO0FBQUEsRUFBSyxZQUFZLEtBQUs7QUFDbkUsZUFBTztBQUFBLFVBQ04sU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFRLE1BQU0sT0FBTyxDQUFDO0FBQUEsVUFDeEMsU0FBUyxFQUFFLFFBQVEsU0FBUyxNQUFNLFNBQVMsT0FBTztBQUFBLFFBQ25EO0FBQUEsTUFDRDtBQUdBLFVBQUksV0FBVyxlQUFlO0FBQzdCLFlBQUksQ0FBQyxNQUFNO0FBQ1YsZ0JBQU0sU0FBUyxNQUFNLHdCQUF3QixLQUFLLE1BQU07QUFDeEQsaUJBQU87QUFBQSxZQUNOLFNBQVM7QUFBQSxjQUNSO0FBQUEsZ0JBQ0MsTUFBTTtBQUFBLGdCQUNOLE1BQU0sMEJBQTBCLE9BQU8sWUFBWSxXQUFXO0FBQUEsRUFBTyxPQUFPLE1BQU07QUFBQSxjQUNuRjtBQUFBLFlBQ0Q7QUFBQSxZQUNBLFNBQVMsRUFBRSxRQUFRLFNBQVMsTUFBTSxTQUFTLE9BQU87QUFBQSxVQUNuRDtBQUFBLFFBQ0Q7QUFFQSxZQUFJO0FBQ0osWUFBSSx1QkFBdUI7QUFDM0IsWUFBSSxlQUFlLElBQUksR0FBRztBQUN6QixnQkFBTSxjQUFjLE1BQU0sbUJBQW1CLE1BQU0sS0FBSywyQkFBMkI7QUFDbkYsb0JBQVUsWUFBWTtBQUN0QixpQ0FBdUIsWUFBWTtBQUFBLFFBQ3BDLE9BQU87QUFDTixvQkFBVSxDQUFDLElBQUk7QUFBQSxRQUNoQjtBQUVBLFlBQUksUUFBUSxXQUFXLEdBQUc7QUFDekIsaUJBQU87QUFBQSxZQUNOLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBUSxNQUFNLDZCQUE2QixJQUFJLEdBQUcsQ0FBQztBQUFBLFlBQ3JFLFNBQVMsRUFBRSxRQUFRLFNBQVMsTUFBTSxTQUFTLE9BQU87QUFBQSxVQUNuRDtBQUFBLFFBQ0Q7QUFFQSxjQUFNLFdBQVcsUUFBUSxTQUFTLEtBQUs7QUFDdkMsY0FBTSwyQkFBMkIsV0FDOUIsS0FBSyxJQUFJLG1DQUFtQyxhQUFhLEdBQUksSUFDN0QsS0FBSyxJQUFJLG9DQUFvQyxhQUFhLEdBQUk7QUFDakUsY0FBTSxVQUFvQixDQUFDO0FBQzNCLGNBQU0saUJBQWlCLG9CQUFJLElBQVk7QUFDdkMsWUFBSSxzQkFBc0I7QUFDekIsa0JBQVE7QUFBQSxZQUNQLGlDQUFpQywyQkFBMkIseUJBQXlCLDJCQUEyQjtBQUFBLFVBQ2pIO0FBQUEsUUFDRDtBQUVBLG1CQUFXLFVBQVUsU0FBUztBQUM3Qix5QkFBZSxNQUFNO0FBQ3JCLGdCQUFNLFdBQVcsYUFBYSxRQUFRLEdBQUc7QUFDekMsZ0JBQU0sVUFBVSxrQkFBa0IsUUFBUSxRQUFRO0FBQ2xELGNBQUksUUFBUSxXQUFXLEdBQUc7QUFDekIsb0JBQVEsS0FBSyxPQUFPLE1BQU0sNEJBQTRCO0FBQ3REO0FBQUEsVUFDRDtBQUVBLGdCQUFNLE1BQU0sVUFBVSxRQUFRO0FBQzlCLGdCQUFNLFVBQVUsS0FBSyxTQUFTLEtBQUssUUFBUTtBQUMzQyxnQkFBTSxpQkFBK0IsQ0FBQztBQUV0QyxxQkFBVyxDQUFDQyxhQUFZQyxhQUFZLEtBQUssU0FBUztBQUNqRCwyQkFBZSxJQUFJRCxXQUFVO0FBQzdCLGdCQUFJO0FBQ0gsNkJBQWUsTUFBTTtBQUNyQixvQkFBTSxTQUFTLE1BQU0sa0JBQWtCQyxlQUFjLEdBQUc7QUFDeEQsb0JBQU0sYUFBYSxPQUFPO0FBQzFCLG9CQUFNLFlBQVksUUFBUSxVQUFVLE1BQU07QUFDMUMsb0JBQU0sY0FBYyxNQUFNO0FBQUEsZ0JBQ3pCO0FBQUEsZ0JBQ0E7QUFBQSxnQkFDQTtBQUFBLGdCQUNBO0FBQUEsZ0JBQ0E7QUFBQSxjQUNEO0FBQ0EsNkJBQWUsS0FBSyxHQUFHLFdBQVc7QUFBQSxZQUNuQyxTQUFTLEtBQWM7QUFDdEIsa0JBQUksZUFBZSxrQkFBa0IsUUFBUSxTQUFTO0FBQ3JELHNCQUFNO0FBQUEsY0FDUDtBQUFBLFlBQ0Q7QUFBQSxVQUNEO0FBR0EsZ0JBQU0sT0FBTyxvQkFBSSxJQUFZO0FBQzdCLGdCQUFNLG9CQUFrQyxDQUFDO0FBQ3pDLHFCQUFXLEtBQUssZ0JBQWdCO0FBQy9CLGtCQUFNLE1BQU0sR0FBRyxFQUFFLE1BQU0sTUFBTSxJQUFJLElBQUksRUFBRSxNQUFNLE1BQU0sU0FBUyxJQUFJLEVBQUUsTUFBTSxJQUFJLElBQUksSUFBSSxFQUFFLE1BQU0sSUFBSSxTQUFTLElBQUksRUFBRSxPQUFPO0FBQ3RILGdCQUFJLENBQUMsS0FBSyxJQUFJLEdBQUcsR0FBRztBQUNuQixtQkFBSyxJQUFJLEdBQUc7QUFDWixnQ0FBa0IsS0FBSyxDQUFDO0FBQUEsWUFDekI7QUFBQSxVQUNEO0FBRUEsMEJBQWdCLGlCQUFpQjtBQUVqQyxjQUFJLENBQUMsWUFBWSxRQUFRLFdBQVcsR0FBRztBQUN0QyxnQkFBSSxrQkFBa0IsV0FBVyxHQUFHO0FBQ25DLHFCQUFPO0FBQUEsZ0JBQ04sU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFRLE1BQU0saUJBQWlCLENBQUM7QUFBQSxnQkFDbEQsU0FBUyxFQUFFLFFBQVEsWUFBWSxNQUFNLEtBQUssY0FBYyxFQUFFLEtBQUssSUFBSSxHQUFHLFNBQVMsS0FBSztBQUFBLGNBQ3JGO0FBQUEsWUFDRDtBQUVBLGtCQUFNLFVBQVUseUJBQXlCLGlCQUFpQjtBQUMxRCxrQkFBTSxZQUFZLGtCQUFrQixJQUFJLE9BQUssaUJBQWlCLEdBQUcsT0FBTyxDQUFDO0FBQ3pFLGtCQUFNLFNBQVMsR0FBRyxPQUFPO0FBQUEsRUFBTSxnQ0FBZ0MsU0FBUyxDQUFDO0FBQ3pFLG1CQUFPO0FBQUEsY0FDTixTQUFTLENBQUMsRUFBRSxNQUFNLFFBQVEsTUFBTSxPQUFPLENBQUM7QUFBQSxjQUN4QyxTQUFTLEVBQUUsUUFBUSxZQUFZLE1BQU0sS0FBSyxjQUFjLEVBQUUsS0FBSyxJQUFJLEdBQUcsU0FBUyxLQUFLO0FBQUEsWUFDckY7QUFBQSxVQUNEO0FBRUEsY0FBSSxrQkFBa0IsV0FBVyxHQUFHO0FBQ25DLG9CQUFRLEtBQUssTUFBTSxPQUFPLGFBQWE7QUFBQSxVQUN4QyxPQUFPO0FBQ04sa0JBQU0sVUFBVSx5QkFBeUIsaUJBQWlCO0FBQzFELG9CQUFRLEtBQUssT0FBTyxPQUFPLEtBQUssT0FBTyxFQUFFO0FBQ3pDLGtCQUFNLFlBQVksa0JBQWtCLElBQUksT0FBSyxpQkFBaUIsR0FBRyxPQUFPLENBQUM7QUFDekUsb0JBQVEsS0FBSyxnQ0FBZ0MsU0FBUyxDQUFDO0FBQUEsVUFDeEQ7QUFBQSxRQUNEO0FBRUEsZUFBTztBQUFBLFVBQ04sU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFRLE1BQU0sUUFBUSxLQUFLLElBQUksRUFBRSxDQUFDO0FBQUEsVUFDcEQsU0FBUyxFQUFFLFFBQVEsWUFBWSxNQUFNLEtBQUssY0FBYyxFQUFFLEtBQUssSUFBSSxHQUFHLFNBQVMsS0FBSztBQUFBLFFBQ3JGO0FBQUEsTUFDRDtBQUVBLFlBQU0sZUFBZSxDQUFDLFFBQVEsV0FBVyxhQUFhLFdBQVc7QUFFakUsVUFBSSxjQUFjO0FBQ2pCLGVBQU87QUFBQSxVQUNOLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBUSxNQUFNLGlEQUFpRCxDQUFDO0FBQUEsVUFDbEYsU0FBUyxFQUFFLFFBQVEsU0FBUyxNQUFNO0FBQUEsUUFDbkM7QUFBQSxNQUNEO0FBRUEsWUFBTSxlQUFlLE9BQU8sYUFBYSxNQUFNLEdBQUcsSUFBSTtBQUd0RCxVQUFJLFdBQVcsYUFBYSxDQUFDLGNBQWM7QUFDMUMsY0FBTSxrQkFBa0IsT0FBTyxLQUFLO0FBQ3BDLFlBQUksQ0FBQyxpQkFBaUI7QUFDckIsaUJBQU87QUFBQSxZQUNOLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBUSxNQUFNLDhEQUE4RCxDQUFDO0FBQUEsWUFDL0YsU0FBUyxFQUFFLFFBQVEsU0FBUyxPQUFPLFNBQVMsT0FBTztBQUFBLFVBQ3BEO0FBQUEsUUFDRDtBQUNBLGNBQU0sVUFBVSxjQUFjLE1BQU07QUFDcEMsWUFBSSxRQUFRLFdBQVcsR0FBRztBQUN6QixpQkFBTztBQUFBLFlBQ04sU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFRLE1BQU0sMkNBQTJDLENBQUM7QUFBQSxZQUM1RSxTQUFTLEVBQUUsUUFBUSxTQUFTLE9BQU8sU0FBUyxPQUFPO0FBQUEsVUFDcEQ7QUFBQSxRQUNEO0FBQ0EsY0FBTSxvQkFBeUMsQ0FBQztBQUNoRCxjQUFNLG9CQUFvQixvQkFBSSxJQUFZO0FBQzFDLG1CQUFXLENBQUMscUJBQXFCLHFCQUFxQixLQUFLLFNBQVM7QUFDbkUseUJBQWUsTUFBTTtBQUNyQixjQUFJO0FBQ0gsa0JBQU0sa0JBQWtCLE1BQU0sa0JBQWtCLHVCQUF1QixHQUFHO0FBQzFFLGtCQUFNLGtCQUFtQixNQUFNO0FBQUEsY0FDOUI7QUFBQSxjQUNBO0FBQUEsY0FDQSxFQUFFLE9BQU8sZ0JBQWdCO0FBQUEsY0FDekI7QUFBQSxZQUNEO0FBQ0EsZ0JBQUksQ0FBQyxtQkFBbUIsZ0JBQWdCLFdBQVcsR0FBRztBQUNyRDtBQUFBLFlBQ0Q7QUFDQSw4QkFBa0IsSUFBSSxtQkFBbUI7QUFDekMsOEJBQWtCLEtBQUssR0FBRyx1QkFBdUIsaUJBQWlCLGVBQWUsQ0FBQztBQUFBLFVBQ25GLFNBQVMsS0FBYztBQUN0QixnQkFBSSxlQUFlLGtCQUFrQixRQUFRLFNBQVM7QUFDckQsb0JBQU07QUFBQSxZQUNQO0FBQUEsVUFDRDtBQUFBLFFBQ0Q7QUFDQSxjQUFNLGlCQUFpQix1QkFBdUIsaUJBQWlCO0FBQy9ELFlBQUksZUFBZSxXQUFXLEdBQUc7QUFDaEMsaUJBQU87QUFBQSxZQUNOLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBUSxNQUFNLHdCQUF3QixlQUFlLElBQUksQ0FBQztBQUFBLFlBQzVFLFNBQVM7QUFBQSxjQUNSO0FBQUEsY0FDQSxZQUFZLE1BQU0sS0FBSyxpQkFBaUIsRUFBRSxLQUFLLElBQUk7QUFBQSxjQUNuRCxTQUFTO0FBQUEsY0FDVCxTQUFTO0FBQUEsWUFDVjtBQUFBLFVBQ0Q7QUFBQSxRQUNEO0FBQ0EsY0FBTSxpQkFBaUIsZUFBZSxNQUFNLEdBQUcsc0JBQXNCO0FBQ3JFLGNBQU0sUUFBUSxlQUFlLElBQUksT0FBSyx3QkFBd0IsR0FBRyxHQUFHLENBQUM7QUFDckUsY0FBTSxpQkFDTCxlQUFlLFNBQVMseUJBQ3JCO0FBQUEsTUFBUyxlQUFlLFNBQVMsc0JBQXNCLGtDQUN2RDtBQUNKLGVBQU87QUFBQSxVQUNOLFNBQVM7QUFBQSxZQUNSO0FBQUEsY0FDQyxNQUFNO0FBQUEsY0FDTixNQUFNLFNBQVMsZUFBZSxNQUFNLHdCQUF3QixlQUFlO0FBQUEsRUFBTyxNQUFNLElBQUksT0FBSyxLQUFLLENBQUMsRUFBRSxFQUFFLEtBQUssSUFBSSxDQUFDLEdBQUcsY0FBYztBQUFBLFlBQ3ZJO0FBQUEsVUFDRDtBQUFBLFVBQ0EsU0FBUztBQUFBLFlBQ1I7QUFBQSxZQUNBLFlBQVksTUFBTSxLQUFLLGlCQUFpQixFQUFFLEtBQUssSUFBSTtBQUFBLFlBQ25ELFNBQVM7QUFBQSxZQUNULFNBQVM7QUFBQSxVQUNWO0FBQUEsUUFDRDtBQUFBLE1BQ0Q7QUFHQSxVQUFJLFdBQVcsWUFBWSxDQUFDLGNBQWM7QUFDekMsY0FBTSxVQUFVLGNBQWMsTUFBTTtBQUNwQyxZQUFJLFFBQVEsV0FBVyxHQUFHO0FBQ3pCLGlCQUFPO0FBQUEsWUFDTixTQUFTLENBQUMsRUFBRSxNQUFNLFFBQVEsTUFBTSwyQ0FBMkMsQ0FBQztBQUFBLFlBQzVFLFNBQVMsRUFBRSxRQUFRLFNBQVMsT0FBTyxTQUFTLE9BQU87QUFBQSxVQUNwRDtBQUFBLFFBQ0Q7QUFDQSxjQUFNLFVBQW9CLENBQUM7QUFDM0IsbUJBQVcsQ0FBQyxxQkFBcUIscUJBQXFCLEtBQUssU0FBUztBQUNuRSx5QkFBZSxNQUFNO0FBQ3JCLGNBQUk7QUFDSCxrQkFBTSxrQkFBa0IsTUFBTSxrQkFBa0IsdUJBQXVCLEdBQUc7QUFDMUUsb0JBQVEsS0FBSyxNQUFNLGFBQWEsaUJBQWlCLHFCQUFxQixNQUFNLENBQUM7QUFBQSxVQUM5RSxTQUFTLEtBQWM7QUFDdEIsZ0JBQUksZUFBZSxrQkFBa0IsUUFBUSxTQUFTO0FBQ3JELG9CQUFNO0FBQUEsWUFDUDtBQUNBLGtCQUFNLGVBQWUsZUFBZSxRQUFRLElBQUksVUFBVSxPQUFPLEdBQUc7QUFDcEUsb0JBQVEsS0FBSyxvQkFBb0IsbUJBQW1CLEtBQUssWUFBWSxFQUFFO0FBQUEsVUFDeEU7QUFBQSxRQUNEO0FBQ0EsZUFBTztBQUFBLFVBQ04sU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFRLE1BQU0sUUFBUSxLQUFLLElBQUksRUFBRSxDQUFDO0FBQUEsVUFDcEQsU0FBUyxFQUFFLFFBQVEsWUFBWSxRQUFRLElBQUksQ0FBQyxDQUFDLElBQUksTUFBTSxJQUFJLEVBQUUsS0FBSyxJQUFJLEdBQUcsU0FBUyxNQUFNLFNBQVMsT0FBTztBQUFBLFFBQ3pHO0FBQUEsTUFDRDtBQUdBLFlBQU0sYUFBYSxlQUFlLGlCQUFpQixRQUFRLFlBQVksSUFBSTtBQUMzRSxVQUFJLENBQUMsWUFBWTtBQUNoQixlQUFPO0FBQUEsVUFDTixTQUFTLENBQUMsRUFBRSxNQUFNLFFBQVEsTUFBTSwyQ0FBMkMsQ0FBQztBQUFBLFVBQzVFLFNBQVMsRUFBRSxRQUFRLFNBQVMsTUFBTTtBQUFBLFFBQ25DO0FBQUEsTUFDRDtBQUVBLFlBQU0sQ0FBQyxZQUFZLFlBQVksSUFBSTtBQUVuQyxVQUFJO0FBQ0gsY0FBTSxTQUFTLE1BQU0sa0JBQWtCLGNBQWMsR0FBRztBQUN4RCxjQUFNLGFBQWE7QUFFbkIsWUFBSSxZQUFZO0FBQ2YsZ0JBQU0sZUFBZSxRQUFRLFlBQVksTUFBTTtBQUFBLFFBQ2hEO0FBRUEsY0FBTSxNQUFNLGFBQWEsVUFBVSxVQUFVLElBQUk7QUFDakQsY0FBTSxlQUFlLFFBQVE7QUFDN0IsY0FBTSxvQkFBb0IsYUFDdkIsTUFBTSxvQkFBb0IsWUFBWSxjQUFjLFFBQVEsVUFBVSxJQUN0RTtBQUNILGNBQU0sV0FBVyxFQUFFLE1BQU0sZUFBZSxHQUFHLFdBQVcsa0JBQWtCO0FBRXhFLFlBQUk7QUFFSixnQkFBUSxRQUFRO0FBQUEsVUFDZixLQUFLLGNBQWM7QUFDbEIsa0JBQU0sU0FBUyxNQUFNO0FBQUEsY0FDcEI7QUFBQSxjQUNBO0FBQUEsY0FDQSxFQUFFLGNBQWMsRUFBRSxJQUFJLEdBQUcsU0FBUztBQUFBLGNBQ2xDO0FBQUEsWUFDRDtBQUNBLHFCQUFTLE1BQU0sc0JBQXNCLFFBQXdFLGNBQWMsR0FBRztBQUM5SDtBQUFBLFVBQ0Q7QUFBQSxVQUVBLEtBQUssbUJBQW1CO0FBQ3ZCLGtCQUFNLFNBQVMsTUFBTTtBQUFBLGNBQ3BCO0FBQUEsY0FDQTtBQUFBLGNBQ0EsRUFBRSxjQUFjLEVBQUUsSUFBSSxHQUFHLFNBQVM7QUFBQSxjQUNsQztBQUFBLFlBQ0Q7QUFDQSxxQkFBUyxNQUFNLHNCQUFzQixRQUF3RSxtQkFBbUIsR0FBRztBQUNuSTtBQUFBLFVBQ0Q7QUFBQSxVQUVBLEtBQUssa0JBQWtCO0FBQ3RCLGtCQUFNLFNBQVMsTUFBTTtBQUFBLGNBQ3BCO0FBQUEsY0FDQTtBQUFBLGNBQ0EsRUFBRSxjQUFjLEVBQUUsSUFBSSxHQUFHLFNBQVM7QUFBQSxjQUNsQztBQUFBLFlBQ0Q7QUFDQSxxQkFBUyxNQUFNLHNCQUFzQixRQUF3RSxrQkFBa0IsR0FBRztBQUNsSTtBQUFBLFVBQ0Q7QUFBQSxVQUVBLEtBQUssY0FBYztBQUNsQixrQkFBTSxTQUFVLE1BQU07QUFBQSxjQUNyQjtBQUFBLGNBQ0E7QUFBQSxjQUNBO0FBQUEsZ0JBQ0MsY0FBYyxFQUFFLElBQUk7QUFBQSxnQkFDcEI7QUFBQSxnQkFDQSxTQUFTLEVBQUUsb0JBQW9CLEtBQUs7QUFBQSxjQUNyQztBQUFBLGNBQ0E7QUFBQSxZQUNEO0FBRUEsZ0JBQUksQ0FBQyxVQUFVLE9BQU8sV0FBVyxHQUFHO0FBQ25DLHVCQUFTO0FBQUEsWUFDVixPQUFPO0FBQ04sb0JBQU0sdUJBQXVCLE9BQU8sTUFBTSxHQUFHLHVCQUF1QjtBQUNwRSxvQkFBTSxrQkFBa0IsT0FBTyxNQUFNLHVCQUF1QjtBQUM1RCxvQkFBTSxrQkFBa0IsTUFBTSxRQUFRO0FBQUEsZ0JBQ3JDLHFCQUFxQixJQUFJLGNBQVksMEJBQTBCLFVBQVUsR0FBRyxDQUFDO0FBQUEsY0FDOUU7QUFDQSxvQkFBTSxhQUFhLGdCQUFnQixJQUFJLGNBQVksS0FBSyxlQUFlLFVBQVUsR0FBRyxDQUFDLEVBQUU7QUFDdkYsb0JBQU0sUUFBUSxXQUFXLFNBQ3RCO0FBQUEsZ0JBQ0EsR0FBRztBQUFBLGdCQUNILFNBQVMsV0FBVyxNQUFNO0FBQUEsZ0JBQzFCLEdBQUc7QUFBQSxjQUNKLElBQ0M7QUFDSCx1QkFBUyxTQUFTLE9BQU8sTUFBTTtBQUFBLEVBQW1CLE1BQU0sS0FBSyxJQUFJLENBQUM7QUFBQSxZQUNuRTtBQUNBO0FBQUEsVUFDRDtBQUFBLFVBRUEsS0FBSyxTQUFTO0FBQ2Isa0JBQU0sU0FBVSxNQUFNO0FBQUEsY0FDckI7QUFBQSxjQUNBO0FBQUEsY0FDQTtBQUFBLGdCQUNDLGNBQWMsRUFBRSxJQUFJO0FBQUEsZ0JBQ3BCO0FBQUEsY0FDRDtBQUFBLGNBQ0E7QUFBQSxZQUNEO0FBRUEsZ0JBQUksQ0FBQyxVQUFVLENBQUMsT0FBTyxVQUFVO0FBQ2hDLHVCQUFTO0FBQUEsWUFDVixPQUFPO0FBQ04sdUJBQVMsaUJBQWlCLE9BQU8sUUFBUTtBQUFBLFlBQzFDO0FBQ0E7QUFBQSxVQUNEO0FBQUEsVUFFQSxLQUFLLGdCQUFnQjtBQUNwQixrQkFBTSxjQUFjLE9BQU8sWUFBWSxJQUFJLEdBQUcsS0FBSyxDQUFDO0FBQ3BELGtCQUFNLFVBQTZCO0FBQUEsY0FDbEM7QUFBQSxjQUNBLE1BQU0sQ0FBQyxTQUFTLFFBQVEsQ0FBQyxLQUFLLElBQUk7QUFBQSxjQUNsQyxhQUFhO0FBQUEsWUFDZDtBQUVBLGtCQUFNLFNBQVUsTUFBTTtBQUFBLGNBQ3JCO0FBQUEsY0FDQTtBQUFBLGNBQ0E7QUFBQSxnQkFDQyxjQUFjLEVBQUUsSUFBSTtBQUFBLGdCQUNwQixPQUFPLEVBQUUsT0FBTyxVQUFVLEtBQUssU0FBUztBQUFBLGdCQUN4QztBQUFBLGNBQ0Q7QUFBQSxjQUNBO0FBQUEsWUFDRDtBQUVBLGdCQUFJLENBQUMsVUFBVSxPQUFPLFdBQVcsR0FBRztBQUNuQyx1QkFBUztBQUNUO0FBQUEsWUFDRDtBQUVBLGdCQUFJLFVBQVUsUUFBUSxPQUFPO0FBQzVCLG9CQUFNLGtCQUFrQixNQUFNLEtBQUs7QUFDbkMsa0JBQUksZ0JBQWdCLFdBQVcsR0FBRztBQUNqQyx5QkFBUztBQUNUO0FBQUEsY0FDRDtBQUNBLG9CQUFNLGNBQWMsUUFBUSxLQUFLLGVBQWUsSUFBSSxPQUFPLFNBQVMsaUJBQWlCLEVBQUUsSUFBSTtBQUMzRixvQkFBTSxpQkFBaUIsT0FBTztBQUFBLGdCQUM3QixDQUFDLFlBQVksVUFDWCxnQkFBZ0IsUUFBUSxVQUFVLGVBQ25DLFdBQVcsTUFBTSxZQUFZLEVBQUUsU0FBUyxnQkFBZ0IsWUFBWSxDQUFDO0FBQUEsY0FDdkU7QUFFQSxrQkFBSSxDQUFDLGdCQUFnQjtBQUNwQixzQkFBTUMsZUFBYyxPQUFPLElBQUksQ0FBQyxZQUFZLFVBQVUsS0FBSyxpQkFBaUIsWUFBWSxLQUFLLENBQUMsRUFBRTtBQUNoRyx5QkFBUywyQkFBMkIsZUFBZTtBQUFBLEVBQTBCQSxhQUFZLEtBQUssSUFBSSxDQUFDO0FBQ25HO0FBQUEsY0FDRDtBQUVBLG9CQUFNLGdCQUFnQixNQUFNLGdCQUFnQixnQkFBZ0I7QUFBQSxnQkFDM0QsbUJBQW1CLE9BQU8sZUFDeEIsTUFBTSxZQUFZLFFBQVEsc0JBQXNCLFlBQVksTUFBTTtBQUFBLGdCQUNwRSxvQkFBb0IsT0FBTyxTQUF3QixtQkFBbUIsTUFBTSxHQUFHO0FBQUEsZ0JBQy9FLGdCQUFnQixPQUFPLGdCQUF5QjtBQUMvQyx3QkFBTTtBQUFBLG9CQUNMO0FBQUEsb0JBQ0E7QUFBQSxvQkFDQTtBQUFBLHNCQUNDLFNBQVMsWUFBWTtBQUFBLHNCQUNyQixXQUFXLFlBQVksYUFBYSxDQUFDO0FBQUEsb0JBQ3RDO0FBQUEsb0JBQ0E7QUFBQSxrQkFDRDtBQUFBLGdCQUNEO0FBQUEsY0FDRCxDQUFDO0FBRUQsa0JBQUksQ0FBQyxlQUFlO0FBQ25CLHlCQUFTLFdBQVcsZUFBZSxLQUFLO0FBQ3hDO0FBQUEsY0FDRDtBQUVBLG9CQUFNLGVBQXlCLENBQUM7QUFDaEMsa0JBQUksY0FBYyxNQUFNLFNBQVMsR0FBRztBQUNuQyw2QkFBYSxLQUFLLG1CQUFtQjtBQUNyQyw2QkFBYSxLQUFLLEdBQUcsY0FBYyxNQUFNLElBQUksVUFBUSxPQUFPLElBQUksRUFBRSxDQUFDO0FBQUEsY0FDcEU7QUFDQSxrQkFBSSxjQUFjLGlCQUFpQixTQUFTLEdBQUc7QUFDOUMsNkJBQWEsS0FBSyx3QkFBd0I7QUFDMUMsNkJBQWEsS0FBSyxHQUFHLGNBQWMsaUJBQWlCLElBQUksaUJBQWUsT0FBTyxXQUFXLEVBQUUsQ0FBQztBQUFBLGNBQzdGO0FBRUEsdUJBQVMsWUFBWSxjQUFjLEtBQUs7QUFBQSxFQUFPLGFBQWEsS0FBSyxJQUFJLENBQUM7QUFDdEU7QUFBQSxZQUNEO0FBRUEsa0JBQU0sY0FBYyxPQUFPLElBQUksQ0FBQyxZQUFZLFVBQVUsS0FBSyxpQkFBaUIsWUFBWSxLQUFLLENBQUMsRUFBRTtBQUNoRyxxQkFBUyxHQUFHLE9BQU8sTUFBTTtBQUFBLEVBQXFCLFlBQVksS0FBSyxJQUFJLENBQUM7QUFDcEU7QUFBQSxVQUNEO0FBQUEsVUFFQSxLQUFLLFdBQVc7QUFDZixnQkFBSSxDQUFDLFlBQVk7QUFDaEIsdUJBQVM7QUFDVDtBQUFBLFlBQ0Q7QUFDQSxrQkFBTSxTQUFVLE1BQU07QUFBQSxjQUNyQjtBQUFBLGNBQ0E7QUFBQSxjQUNBO0FBQUEsZ0JBQ0MsY0FBYyxFQUFFLElBQUk7QUFBQSxjQUNyQjtBQUFBLGNBQ0E7QUFBQSxZQUNEO0FBRUEsZ0JBQUksQ0FBQyxVQUFVLE9BQU8sV0FBVyxHQUFHO0FBQ25DLHVCQUFTO0FBQUEsWUFDVixPQUFPO0FBQ04sb0JBQU0sVUFBVSxLQUFLLFNBQVMsS0FBSyxVQUFVO0FBQzdDLGtCQUFJLG9CQUFvQixPQUFPLENBQUMsR0FBRztBQUNsQyxzQkFBTSxRQUFTLE9BQTRCLFFBQVEsT0FBSyxxQkFBcUIsQ0FBQyxDQUFDO0FBQy9FLHlCQUFTLGNBQWMsT0FBTztBQUFBLEVBQU0sTUFBTSxLQUFLLElBQUksQ0FBQztBQUFBLGNBQ3JELE9BQU87QUFDTixzQkFBTSxRQUFTLE9BQStCLElBQUksT0FBSztBQUN0RCx3QkFBTUMsUUFBTyxFQUFFLFNBQVMsTUFBTSxNQUFNLE9BQU87QUFDM0Msd0JBQU0sT0FBTyxpQkFBaUIsRUFBRSxJQUFJO0FBQ3BDLHlCQUFPLEdBQUcsSUFBSSxJQUFJLEVBQUUsSUFBSSxXQUFXQSxLQUFJO0FBQUEsZ0JBQ3hDLENBQUM7QUFDRCx5QkFBUyxjQUFjLE9BQU87QUFBQSxFQUFNLE1BQU0sS0FBSyxJQUFJLENBQUM7QUFBQSxjQUNyRDtBQUFBLFlBQ0Q7QUFDQTtBQUFBLFVBQ0Q7QUFBQSxVQUVBLEtBQUssa0JBQWtCO0FBQ3RCLHFCQUFTLE1BQU0sMkJBQTJCLFFBQVEsVUFBVSxLQUFLLFlBQVksS0FBSyxNQUFNO0FBQ3hGO0FBQUEsVUFDRDtBQUFBLFVBRUEsS0FBSyxrQkFBa0I7QUFDdEIscUJBQVMsTUFBTSwyQkFBMkIsUUFBUSxVQUFVLEtBQUssWUFBWSxLQUFLLE1BQU07QUFDeEY7QUFBQSxVQUNEO0FBQUEsVUFFQSxLQUFLLFVBQVU7QUFDZCxnQkFBSSxDQUFDLFlBQVk7QUFDaEIsdUJBQVM7QUFDVDtBQUFBLFlBQ0Q7QUFFQSxrQkFBTSxlQUFnQixNQUFNO0FBQUEsY0FDM0I7QUFBQSxjQUNBO0FBQUEsY0FDQTtBQUFBLGdCQUNDLGNBQWMsRUFBRSxJQUFJO0FBQUEsZ0JBQ3BCLFNBQVM7QUFBQSxrQkFDUixTQUFTLFlBQVk7QUFBQSxrQkFDckIsY0FBYyxpQkFBaUI7QUFBQSxnQkFDaEM7QUFBQSxjQUNEO0FBQUEsY0FDQTtBQUFBLFlBQ0Q7QUFFQSxnQkFBSSxDQUFDLGdCQUFnQixhQUFhLFdBQVcsR0FBRztBQUMvQyxvQkFBTUMsV0FBVSxLQUFLLFNBQVMsS0FBSyxVQUFVO0FBQzdDLHVCQUFTLEdBQUdBLFFBQU87QUFDbkI7QUFBQSxZQUNEO0FBRUEsa0JBQU0sZUFBZSxZQUFZLFlBQVk7QUFDN0Msa0JBQU0sVUFBVSxLQUFLLFNBQVMsS0FBSyxVQUFVO0FBQzdDLHFCQUFTLGFBQWEsT0FBTyxLQUFLLGFBQWEsTUFBTTtBQUNyRDtBQUFBLFVBQ0Q7QUFBQSxVQUVBLEtBQUssYUFBYTtBQUNqQixrQkFBTSxZQUFhLE1BQU07QUFBQSxjQUN4QjtBQUFBLGNBQ0E7QUFBQSxjQUNBO0FBQUEsZ0JBQ0MsY0FBYyxFQUFFLElBQUk7QUFBQSxnQkFDcEI7QUFBQSxjQUNEO0FBQUEsY0FDQTtBQUFBLFlBQ0Q7QUFFQSxnQkFBSSxDQUFDLGFBQWEsQ0FBQyxVQUFVLGNBQWMsVUFBVSxXQUFXLFdBQVcsR0FBRztBQUM3RSx1QkFBUztBQUFBLFlBQ1YsT0FBTztBQUNOLHVCQUFTLG9CQUFvQixTQUFTO0FBQUEsWUFDdkM7QUFDQTtBQUFBLFVBQ0Q7QUFBQSxVQUVBLEtBQUssVUFBVTtBQUNkLGdCQUFJLENBQUMsVUFBVTtBQUNkLHFCQUFPO0FBQUEsZ0JBQ04sU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFRLE1BQU0sZ0RBQWdELENBQUM7QUFBQSxnQkFDakYsU0FBUyxFQUFFLFFBQVEsWUFBWSxTQUFTLE1BQU07QUFBQSxjQUMvQztBQUFBLFlBQ0Q7QUFFQSxrQkFBTSxTQUFVLE1BQU07QUFBQSxjQUNyQjtBQUFBLGNBQ0E7QUFBQSxjQUNBO0FBQUEsZ0JBQ0MsY0FBYyxFQUFFLElBQUk7QUFBQSxnQkFDcEI7QUFBQSxnQkFDQSxTQUFTO0FBQUEsY0FDVjtBQUFBLGNBQ0E7QUFBQSxZQUNEO0FBRUEsZ0JBQUksQ0FBQyxRQUFRO0FBQ1osdUJBQVM7QUFBQSxZQUNWLE9BQU87QUFDTixvQkFBTSxjQUFjLFVBQVU7QUFDOUIsa0JBQUksYUFBYTtBQUNoQixzQkFBTSxVQUFVLE1BQU0sbUJBQW1CLFFBQVEsR0FBRztBQUNwRCx5QkFBUztBQUFBLEVBQW9CLFFBQVEsSUFBSSxPQUFLLEtBQUssQ0FBQyxFQUFFLEVBQUUsS0FBSyxJQUFJLENBQUM7QUFBQSxjQUNuRSxPQUFPO0FBQ04sc0JBQU0sVUFBVSxvQkFBb0IsUUFBUSxHQUFHO0FBQy9DLHlCQUFTO0FBQUEsRUFBb0IsUUFBUSxJQUFJLE9BQUssS0FBSyxDQUFDLEVBQUUsRUFBRSxLQUFLLElBQUksQ0FBQztBQUFBLGNBQ25FO0FBQUEsWUFDRDtBQUNBO0FBQUEsVUFDRDtBQUFBLFVBRUEsS0FBSyxVQUFVO0FBQ2QscUJBQVMsTUFBTSxhQUFhLFFBQVEsWUFBWSxNQUFNO0FBQ3REO0FBQUEsVUFDRDtBQUFBLFVBRUE7QUFDQyxxQkFBUyxtQkFBbUIsTUFBTTtBQUFBLFFBQ3BDO0FBRUEsZUFBTztBQUFBLFVBQ04sU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFRLE1BQU0sT0FBTyxDQUFDO0FBQUEsVUFDeEMsU0FBUyxFQUFFLFlBQVksUUFBUSxTQUFTLE1BQU0sU0FBUyxPQUFPO0FBQUEsUUFDL0Q7QUFBQSxNQUNELFNBQVMsS0FBYztBQUN0QixZQUFJLGVBQWUsa0JBQWtCLFFBQVEsU0FBUztBQUNyRCxnQkFBTSxJQUFJLGVBQWU7QUFBQSxRQUMxQjtBQUNBLGNBQU0sZUFBZSxlQUFlLFFBQVEsSUFBSSxVQUFVLE9BQU8sR0FBRztBQUNwRSxlQUFPO0FBQUEsVUFDTixTQUFTLENBQUMsRUFBRSxNQUFNLFFBQVEsTUFBTSxjQUFjLFlBQVksR0FBRyxDQUFDO0FBQUEsVUFDOUQsU0FBUyxFQUFFLFlBQVksUUFBUSxTQUFTLE9BQU8sU0FBUyxPQUFPO0FBQUEsUUFDaEU7QUFBQSxNQUNEO0FBQUEsSUFDRDtBQUFBLEVBQ0Q7QUFDRDtBQUtPLE1BQU0sVUFBVSxjQUFjLFFBQVEsSUFBSSxDQUFDOyIsCiAgIm5hbWVzIjogWyJsc3BTY2hlbWEiLCAicHJlcCIsICJzZXJ2ZXJOYW1lIiwgInNlcnZlckNvbmZpZyIsICJhY3Rpb25MaW5lcyIsICJsaW5lIiwgInJlbFBhdGgiXQp9Cg==
