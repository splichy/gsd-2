import {
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize
} from "@gsd/pi-coding-agent";
import { Text } from "@gsd/pi-tui";
import { Type } from "@sinclair/typebox";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildHttpTransportOpts } from "./auth.js";
import { gsdHome } from "../gsd/gsd-home.js";
const connections = /* @__PURE__ */ new Map();
const pendingConnections = /* @__PURE__ */ new Map();
let configCache = null;
const toolCache = /* @__PURE__ */ new Map();
const trustedStdioServers = /* @__PURE__ */ new Set();
const CHILD_ENV_ALLOWLIST = /* @__PURE__ */ new Set([
  "PATH",
  "Path",
  "HOME",
  "USER",
  "USERNAME",
  "USERPROFILE",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "WINDIR",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME"
]);
function stdioTrustKey(config) {
  return JSON.stringify({
    name: config.name,
    sourcePath: config.sourcePath,
    command: config.command,
    args: config.args ?? [],
    cwd: config.cwd,
    env: config.env ?? {}
  });
}
function readConfigs() {
  if (configCache) return configCache;
  const servers = [];
  const seen = /* @__PURE__ */ new Set();
  const configPaths = [
    join(process.cwd(), ".mcp.json"),
    join(process.cwd(), ".gsd", "mcp.json"),
    join(gsdHome(), "mcp.json")
  ];
  for (const configPath of configPaths) {
    try {
      if (!existsSync(configPath)) continue;
      const raw = readFileSync(configPath, "utf-8");
      const data = JSON.parse(raw);
      const mcpServers = data.mcpServers ?? data.servers;
      if (!mcpServers || typeof mcpServers !== "object") continue;
      for (const [name, config] of Object.entries(mcpServers)) {
        if (seen.has(name)) continue;
        seen.add(name);
        const hasCommand = typeof config.command === "string";
        const hasUrl = typeof config.url === "string";
        const transport = hasCommand ? "stdio" : hasUrl ? "http" : "unknown";
        const hasHeaders = hasUrl && config.headers && typeof config.headers === "object";
        const hasOAuth = hasUrl && config.oauth && typeof config.oauth === "object";
        servers.push({
          name,
          transport,
          sourcePath: configPath,
          ...hasCommand && {
            command: config.command,
            args: Array.isArray(config.args) ? config.args : void 0,
            env: config.env && typeof config.env === "object" ? config.env : void 0,
            cwd: typeof config.cwd === "string" ? config.cwd : void 0
          },
          ...hasUrl && { url: config.url },
          headers: hasHeaders ? config.headers : void 0,
          oauth: hasOAuth ? config.oauth : void 0
        });
      }
    } catch {
    }
  }
  configCache = servers;
  return servers;
}
function _buildMcpChildEnvForTest(configEnv) {
  const childEnv = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === "string") childEnv[key] = value;
  }
  return {
    ...childEnv,
    ...configEnv ? resolveEnv(configEnv) : {}
  };
}
function _buildMcpTrustConfirmOptionsForTest(signal) {
  return signal ? { timeout: 12e4, signal } : { timeout: 12e4 };
}
async function assertTrustedStdioServer(config, ctx, signal) {
  if (config.transport !== "stdio") return void 0;
  const trustKey = stdioTrustKey(config);
  if (trustedStdioServers.has(trustKey)) return void 0;
  if (!ctx?.hasUI) {
    throw new Error(
      `MCP server "${config.name}" is a project-local stdio command from ${config.sourcePath}. Run this from an interactive GSD session and approve the server before use.`
    );
  }
  const commandLine = [config.command, ...config.args ?? []].filter(Boolean).join(" ");
  const envKeys = Object.keys(config.env ?? {});
  const envSummary = envKeys.length > 0 ? `

Configured environment keys: ${envKeys.join(", ")}` : "\n\nNo explicit environment keys configured.";
  const approved = await ctx.ui.confirm(
    `Trust MCP server "${config.name}"?`,
    `Project config ${config.sourcePath} wants to start:

${commandLine}${envSummary}

Only approve MCP servers you trust.`,
    _buildMcpTrustConfirmOptionsForTest(signal)
  );
  if (!approved) {
    throw new Error(`MCP server "${config.name}" was not approved by the user.`);
  }
  return trustKey;
}
function getServerConfig(name) {
  const trimmed = name.trim();
  return readConfigs().find(
    (s) => s.name === trimmed || s.name.toLowerCase() === trimmed.toLowerCase()
  );
}
function resolveEnv(env) {
  const resolved = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      resolved[key] = value.replace(
        /\$\{([^}]+)\}/g,
        (_match, varName) => process.env[varName] ?? ""
      );
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}
async function getOrConnect(name, signal, ctx) {
  const config = getServerConfig(name);
  if (!config) throw new Error(`Unknown MCP server: "${name}". Use mcp_servers to list available servers.`);
  const existing = connections.get(config.name);
  if (existing) return existing.client;
  const pending = pendingConnections.get(config.name);
  if (pending) return pending;
  const connectionPromise = connectServer(config, signal, ctx);
  pendingConnections.set(config.name, connectionPromise);
  try {
    return await connectionPromise;
  } finally {
    pendingConnections.delete(config.name);
  }
}
async function connectServer(config, signal, ctx) {
  const client = new Client({ name: "gsd", version: "1.0.0" });
  let transport;
  let approvedTrustKey;
  if (config.transport === "stdio" && config.command) {
    approvedTrustKey = await assertTrustedStdioServer(config, ctx, signal);
    transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: _buildMcpChildEnvForTest(config.env),
      cwd: config.cwd,
      stderr: "pipe"
    });
  } else if (config.transport === "http" && config.url) {
    const resolvedUrl = config.url.replace(
      /\$\{([^}]+)\}/g,
      (_, varName) => process.env[varName] ?? ""
    );
    const httpOpts = buildHttpTransportOpts({
      headers: config.headers,
      oauth: config.oauth
    });
    transport = new StreamableHTTPClientTransport(new URL(resolvedUrl), httpOpts);
  } else {
    throw new Error(`Server "${config.name}" has unsupported transport: ${config.transport}`);
  }
  try {
    await client.connect(transport, { signal, timeout: 3e4 });
    if (approvedTrustKey) trustedStdioServers.add(approvedTrustKey);
    connections.set(config.name, { client, transport });
    return client;
  } catch (err) {
    try {
      await transport.close();
    } catch {
    }
    try {
      await client.close();
    } catch {
    }
    throw err;
  }
}
async function closeAll() {
  const closing = Array.from(connections.entries()).map(async ([name, conn]) => {
    try {
      await conn.client.close();
    } catch {
    }
    try {
      await conn.transport.close();
    } catch {
    }
    connections.delete(name);
  });
  await Promise.allSettled(closing);
  pendingConnections.clear();
  trustedStdioServers.clear();
  toolCache.clear();
}
function formatServerList(servers) {
  if (servers.length === 0) return "No MCP servers configured. Add servers to .mcp.json, .gsd/mcp.json, or $GSD_HOME/mcp.json (default: ~/.gsd/mcp.json).";
  const lines = [`${servers.length} MCP servers configured:
`];
  for (const s of servers) {
    const connected = connections.has(s.name) ? "\u2713" : "\u25CB";
    const cached = toolCache.get(s.name);
    const toolCount = cached ? ` \u2014 ${cached.length} tools` : "";
    lines.push(`${connected} ${s.name} (${s.transport})${toolCount}`);
  }
  lines.push("\nUse mcp_discover to see full tool schemas for a specific server.");
  lines.push("Use mcp_call to invoke a tool: mcp_call(server, tool, args).");
  return lines.join("\n");
}
function formatToolList(serverName, tools) {
  const lines = [`${serverName} \u2014 ${tools.length} tools:
`];
  for (const tool of tools) {
    lines.push(`## ${tool.name}`);
    if (tool.description) lines.push(tool.description);
    if (tool.inputSchema) {
      lines.push("```json");
      lines.push(JSON.stringify(tool.inputSchema, null, 2));
      lines.push("```");
    }
    lines.push("");
  }
  lines.push(`Call with: mcp_call(server="${serverName}", tool="<tool_name>", args={...})`);
  return lines.join("\n");
}
function getConnectionStatus(name) {
  const conn = connections.get(name);
  const cached = toolCache.get(name);
  return {
    connected: !!conn,
    tools: cached ? cached.map((t) => t.name) : [],
    error: void 0
  };
}
function mcp_client_default(pi) {
  pi.registerTool({
    name: "mcp_servers",
    label: "MCP Servers",
    description: "List all available MCP servers configured in project files (.mcp.json, .gsd/mcp.json) or globally ($GSD_HOME/mcp.json, default: ~/.gsd/mcp.json). Shows server names, transport type, and connection status. Use mcp_discover to get full tool schemas for a server.",
    promptSnippet: "List available MCP servers from project configuration",
    promptGuidelines: [
      "Call mcp_servers to see what MCP servers are available before trying to use one.",
      "MCP servers provide external integrations (Twitter, Linear, Railway, etc.) via the Model Context Protocol.",
      "After listing, use mcp_discover(server) to get tool schemas, then mcp_call(server, tool, args) to invoke."
    ],
    parameters: Type.Object({
      refresh: Type.Optional(
        Type.Boolean({ description: "Force refresh the server list (default: use cache)" })
      )
    }),
    async execute(_id, params) {
      if (params.refresh) configCache = null;
      const servers = readConfigs();
      return {
        content: [{ type: "text", text: formatServerList(servers) }],
        details: {
          serverCount: servers.length,
          cached: !params.refresh && configCache !== null
        }
      };
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("mcp_servers"));
      if (args.refresh) text += theme.fg("warning", " (refresh)");
      return new Text(text, 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Reading MCP config..."), 0, 0);
      const d = result.details;
      return new Text(
        theme.fg("success", `${d?.serverCount ?? 0} servers configured`),
        0,
        0
      );
    }
  });
  pi.registerTool({
    name: "mcp_discover",
    label: "MCP Discover",
    description: "Get detailed tool signatures and JSON schemas for a specific MCP server. Connects to the server on first call (lazy connection). Use this to understand what tools a server provides and what arguments they accept before calling them with mcp_call.",
    promptSnippet: "Get tool schemas for a specific MCP server before calling its tools",
    promptGuidelines: [
      "Call mcp_discover with a server name to see the full tool signatures before calling mcp_call.",
      "The schemas show required and optional parameters with types and descriptions."
    ],
    parameters: Type.Object({
      server: Type.String({
        description: "MCP server name (from mcp_servers output), e.g. 'railway', 'twitter-mcp', 'linear'"
      })
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      try {
        const cached = toolCache.get(params.server);
        if (cached) {
          const text2 = formatToolList(params.server, cached);
          const truncation2 = truncateHead(text2, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
          let finalText2 = truncation2.content;
          if (truncation2.truncated) {
            finalText2 += `

[Truncated: ${truncation2.outputLines}/${truncation2.totalLines} lines (${formatSize(truncation2.outputBytes)} of ${formatSize(truncation2.totalBytes)})]`;
          }
          return {
            content: [{ type: "text", text: finalText2 }],
            details: { server: params.server, toolCount: cached.length, cached: true }
          };
        }
        const client = await getOrConnect(params.server, signal, ctx);
        const result = await client.listTools(void 0, { signal, timeout: 3e4 });
        const tools = (result.tools ?? []).map((t) => ({
          name: t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema
        }));
        toolCache.set(params.server, tools);
        const text = formatToolList(params.server, tools);
        const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
        let finalText = truncation.content;
        if (truncation.truncated) {
          finalText += `

[Truncated: ${truncation.outputLines}/${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
        }
        return {
          content: [{ type: "text", text: finalText }],
          details: { server: params.server, toolCount: tools.length, cached: false }
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to discover tools for "${params.server}": ${msg}`);
      }
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("mcp_discover "));
      text += theme.fg("accent", args.server);
      return new Text(text, 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial)
        return new Text(theme.fg("warning", "Discovering tools..."), 0, 0);
      const d = result.details;
      return new Text(
        theme.fg("success", `${d?.toolCount ?? 0} tools`) + theme.fg("dim", ` \xB7 ${d?.server}`),
        0,
        0
      );
    }
  });
  pi.registerTool({
    name: "mcp_call",
    label: "MCP Call",
    description: "Call a tool on an MCP server. Provide the server name, tool name, and arguments. Connects to the server on first call (lazy connection). Use mcp_discover first to see available tools and their required arguments.",
    promptSnippet: "Call a tool on an MCP server",
    promptGuidelines: [
      "Always use mcp_discover first to understand the tool's parameters before calling mcp_call.",
      "Arguments are passed as a JSON object matching the tool's input schema."
    ],
    parameters: Type.Object({
      server: Type.String({
        description: "MCP server name, e.g. 'railway', 'twitter-mcp'"
      }),
      tool: Type.String({
        description: "Tool name on that server, e.g. 'railway_list_projects'"
      }),
      args: Type.Optional(
        Type.Object({}, {
          additionalProperties: true,
          description: "Tool arguments as key-value pairs matching the tool's input schema"
        })
      )
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      try {
        const client = await getOrConnect(params.server, signal, ctx);
        const result = await client.callTool(
          { name: params.tool, arguments: params.args ?? {} },
          void 0,
          { signal, timeout: 6e4 }
        );
        const contentItems = result.content;
        const raw = contentItems.map((c) => c.type === "text" ? c.text ?? "" : JSON.stringify(c)).join("\n");
        const truncation = truncateHead(raw, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
        let finalText = truncation.content;
        if (truncation.truncated) {
          finalText += `

[Output truncated: ${truncation.outputLines}/${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
        }
        return {
          content: [{ type: "text", text: finalText }],
          details: {
            server: params.server,
            tool: params.tool,
            charCount: finalText.length,
            truncated: truncation.truncated
          }
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`MCP call failed: ${params.server}.${params.tool}
${msg}`);
      }
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("mcp_call "));
      text += theme.fg("accent", `${args.server}.${args.tool}`);
      if (args.args && Object.keys(args.args).length > 0) {
        const preview = Object.entries(args.args).slice(0, 3).map(([k, v]) => {
          const val = typeof v === "string" ? v : JSON.stringify(v);
          return `${k}:${val.length > 30 ? val.slice(0, 30) + "\u2026" : val}`;
        }).join(" ");
        text += " " + theme.fg("muted", preview);
      }
      return new Text(text, 0, 0);
    },
    renderResult(result, { isPartial, expanded }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Calling MCP tool..."), 0, 0);
      const d = result.details;
      let text = theme.fg("success", `\u2713 ${d?.server}.${d?.tool}`);
      text += theme.fg("dim", ` \xB7 ${(d?.charCount ?? 0).toLocaleString()} chars`);
      if (d?.truncated) text += theme.fg("warning", " \xB7 truncated");
      if (expanded) {
        const content = result.content[0];
        if (content?.type === "text") {
          const preview = content.text.split("\n").slice(0, 15).join("\n");
          text += "\n\n" + theme.fg("dim", preview);
        }
      }
      return new Text(text, 0, 0);
    }
  });
  pi.on("session_shutdown", async () => {
    await closeAll();
  });
  pi.on("session_switch", async () => {
    await closeAll();
    configCache = null;
  });
}
export {
  _buildMcpChildEnvForTest,
  _buildMcpTrustConfirmOptionsForTest,
  mcp_client_default as default,
  getConnectionStatus,
  getServerConfig
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL21jcC1jbGllbnQvaW5kZXgudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogTUNQIENsaWVudCBFeHRlbnNpb24gXHUyMDE0IE5hdGl2ZSBNQ1Agc2VydmVyIGludGVncmF0aW9uIGZvciBwaVxuICpcbiAqIFByb3ZpZGVzIG9uLWRlbWFuZCBhY2Nlc3MgdG8gTUNQIHNlcnZlcnMgY29uZmlndXJlZCBpbiBwcm9qZWN0IGZpbGVzXG4gKiAoLm1jcC5qc29uLCAuZ3NkL21jcC5qc29uKSBhbmQgdGhlIGdsb2JhbCB+Ly5nc2QvbWNwLmpzb24gKG9yXG4gKiAkR1NEX0hPTUUvbWNwLmpzb24pIHVzaW5nIHRoZSBAbW9kZWxjb250ZXh0cHJvdG9jb2wvc2RrIENsaWVudFxuICogZGlyZWN0bHkgXHUyMDE0IG5vIGV4dGVybmFsIENMSSBkZXBlbmRlbmN5IHJlcXVpcmVkLlxuICpcbiAqIFRocmVlIHRvb2xzOlxuICogICBtY3Bfc2VydmVycyAgIFx1MjAxNCBMaXN0IGF2YWlsYWJsZSBNQ1Agc2VydmVycyBmcm9tIGNvbmZpZyBmaWxlc1xuICogICBtY3BfZGlzY292ZXIgIFx1MjAxNCBHZXQgdG9vbCBzaWduYXR1cmVzIGZvciBhIHNwZWNpZmljIHNlcnZlciAobGF6eSBjb25uZWN0KVxuICogICBtY3BfY2FsbCAgICAgIFx1MjAxNCBDYWxsIGEgdG9vbCBvbiBhbiBNQ1Agc2VydmVyIChsYXp5IGNvbm5lY3QpXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBFeHRlbnNpb25BUEksIEV4dGVuc2lvbkNvbnRleHQgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB7XG5cdHRydW5jYXRlSGVhZCxcblx0REVGQVVMVF9NQVhfQllURVMsXG5cdERFRkFVTFRfTUFYX0xJTkVTLFxuXHRmb3JtYXRTaXplLFxufSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB7IFRleHQgfSBmcm9tIFwiQGdzZC9waS10dWlcIjtcbmltcG9ydCB7IFR5cGUgfSBmcm9tIFwiQHNpbmNsYWlyL3R5cGVib3hcIjtcbmltcG9ydCB7IENsaWVudCB9IGZyb20gXCJAbW9kZWxjb250ZXh0cHJvdG9jb2wvc2RrL2NsaWVudFwiO1xuaW1wb3J0IHsgU3RkaW9DbGllbnRUcmFuc3BvcnQgfSBmcm9tIFwiQG1vZGVsY29udGV4dHByb3RvY29sL3Nkay9jbGllbnQvc3RkaW8uanNcIjtcbmltcG9ydCB7IFN0cmVhbWFibGVIVFRQQ2xpZW50VHJhbnNwb3J0IH0gZnJvbSBcIkBtb2RlbGNvbnRleHRwcm90b2NvbC9zZGsvY2xpZW50L3N0cmVhbWFibGVIdHRwLmpzXCI7XG5pbXBvcnQgeyByZWFkRmlsZVN5bmMsIGV4aXN0c1N5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGJ1aWxkSHR0cFRyYW5zcG9ydE9wdHMgfSBmcm9tIFwiLi9hdXRoLmpzXCI7XG5pbXBvcnQgdHlwZSB7IE1jcEh0dHBBdXRoQ29uZmlnIH0gZnJvbSBcIi4vYXV0aC5qc1wiO1xuaW1wb3J0IHsgZ3NkSG9tZSB9IGZyb20gXCIuLi9nc2QvZ3NkLWhvbWUuanNcIjtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFR5cGVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5pbnRlcmZhY2UgTWNwU2VydmVyQ29uZmlnIHtcblx0bmFtZTogc3RyaW5nO1xuXHR0cmFuc3BvcnQ6IFwic3RkaW9cIiB8IFwiaHR0cFwiIHwgXCJ1bmtub3duXCI7XG5cdHNvdXJjZVBhdGg6IHN0cmluZztcblx0Y29tbWFuZD86IHN0cmluZztcblx0YXJncz86IHN0cmluZ1tdO1xuXHRlbnY/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuXHR1cmw/OiBzdHJpbmc7XG5cdGN3ZD86IHN0cmluZztcblx0LyoqIFN0YXRpYyBoZWFkZXJzIGZvciBIVFRQIHRyYW5zcG9ydCAoc3VwcG9ydHMgJHtWQVJ9IGVudiByZXNvbHV0aW9uKS4gKi9cblx0aGVhZGVycz86IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG5cdC8qKiBPQXV0aCBjb25maWcgZm9yIEhUVFAgdHJhbnNwb3J0LiAqL1xuXHRvYXV0aD86IE1jcEh0dHBBdXRoQ29uZmlnW1wib2F1dGhcIl07XG59XG5cbmludGVyZmFjZSBNY3BUb29sU2NoZW1hIHtcblx0bmFtZTogc3RyaW5nO1xuXHRkZXNjcmlwdGlvbjogc3RyaW5nO1xuXHRpbnB1dFNjaGVtYT86IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xufVxuXG5pbnRlcmZhY2UgTWFuYWdlZENvbm5lY3Rpb24ge1xuXHRjbGllbnQ6IENsaWVudDtcblx0dHJhbnNwb3J0OiBTdGRpb0NsaWVudFRyYW5zcG9ydCB8IFN0cmVhbWFibGVIVFRQQ2xpZW50VHJhbnNwb3J0O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQ29ubmVjdGlvbiBNYW5hZ2VyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5jb25zdCBjb25uZWN0aW9ucyA9IG5ldyBNYXA8c3RyaW5nLCBNYW5hZ2VkQ29ubmVjdGlvbj4oKTtcbmNvbnN0IHBlbmRpbmdDb25uZWN0aW9ucyA9IG5ldyBNYXA8c3RyaW5nLCBQcm9taXNlPENsaWVudD4+KCk7XG5sZXQgY29uZmlnQ2FjaGU6IE1jcFNlcnZlckNvbmZpZ1tdIHwgbnVsbCA9IG51bGw7XG5jb25zdCB0b29sQ2FjaGUgPSBuZXcgTWFwPHN0cmluZywgTWNwVG9vbFNjaGVtYVtdPigpO1xuY29uc3QgdHJ1c3RlZFN0ZGlvU2VydmVycyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG5jb25zdCBDSElMRF9FTlZfQUxMT1dMSVNUID0gbmV3IFNldChbXG5cdFwiUEFUSFwiLFxuXHRcIlBhdGhcIixcblx0XCJIT01FXCIsXG5cdFwiVVNFUlwiLFxuXHRcIlVTRVJOQU1FXCIsXG5cdFwiVVNFUlBST0ZJTEVcIixcblx0XCJTSEVMTFwiLFxuXHRcIlRNUERJUlwiLFxuXHRcIlRFTVBcIixcblx0XCJUTVBcIixcblx0XCJTeXN0ZW1Sb290XCIsXG5cdFwiV0lORElSXCIsXG5cdFwiQVBQREFUQVwiLFxuXHRcIkxPQ0FMQVBQREFUQVwiLFxuXHRcIlhER19DT05GSUdfSE9NRVwiLFxuXHRcIlhER19DQUNIRV9IT01FXCIsXG5dKTtcblxuZnVuY3Rpb24gc3RkaW9UcnVzdEtleShjb25maWc6IE1jcFNlcnZlckNvbmZpZyk6IHN0cmluZyB7XG5cdHJldHVybiBKU09OLnN0cmluZ2lmeSh7XG5cdFx0bmFtZTogY29uZmlnLm5hbWUsXG5cdFx0c291cmNlUGF0aDogY29uZmlnLnNvdXJjZVBhdGgsXG5cdFx0Y29tbWFuZDogY29uZmlnLmNvbW1hbmQsXG5cdFx0YXJnczogY29uZmlnLmFyZ3MgPz8gW10sXG5cdFx0Y3dkOiBjb25maWcuY3dkLFxuXHRcdGVudjogY29uZmlnLmVudiA/PyB7fSxcblx0fSk7XG59XG5cbmZ1bmN0aW9uIHJlYWRDb25maWdzKCk6IE1jcFNlcnZlckNvbmZpZ1tdIHtcblx0aWYgKGNvbmZpZ0NhY2hlKSByZXR1cm4gY29uZmlnQ2FjaGU7XG5cblx0Y29uc3Qgc2VydmVyczogTWNwU2VydmVyQ29uZmlnW10gPSBbXTtcblx0Y29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXHRjb25zdCBjb25maWdQYXRocyA9IFtcblx0XHRqb2luKHByb2Nlc3MuY3dkKCksIFwiLm1jcC5qc29uXCIpLFxuXHRcdGpvaW4ocHJvY2Vzcy5jd2QoKSwgXCIuZ3NkXCIsIFwibWNwLmpzb25cIiksXG5cdFx0am9pbihnc2RIb21lKCksIFwibWNwLmpzb25cIiksXG5cdF07XG5cblx0Zm9yIChjb25zdCBjb25maWdQYXRoIG9mIGNvbmZpZ1BhdGhzKSB7XG5cdFx0dHJ5IHtcblx0XHRcdGlmICghZXhpc3RzU3luYyhjb25maWdQYXRoKSkgY29udGludWU7XG5cdFx0XHRjb25zdCByYXcgPSByZWFkRmlsZVN5bmMoY29uZmlnUGF0aCwgXCJ1dGYtOFwiKTtcblx0XHRcdGNvbnN0IGRhdGEgPSBKU09OLnBhcnNlKHJhdykgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG5cdFx0XHRjb25zdCBtY3BTZXJ2ZXJzID0gKGRhdGEubWNwU2VydmVycyA/PyBkYXRhLnNlcnZlcnMpIGFzXG5cdFx0XHRcdHwgUmVjb3JkPHN0cmluZywgUmVjb3JkPHN0cmluZywgdW5rbm93bj4+XG5cdFx0XHRcdHwgdW5kZWZpbmVkO1xuXHRcdFx0aWYgKCFtY3BTZXJ2ZXJzIHx8IHR5cGVvZiBtY3BTZXJ2ZXJzICE9PSBcIm9iamVjdFwiKSBjb250aW51ZTtcblxuXHRcdFx0Zm9yIChjb25zdCBbbmFtZSwgY29uZmlnXSBvZiBPYmplY3QuZW50cmllcyhtY3BTZXJ2ZXJzKSkge1xuXHRcdFx0XHRpZiAoc2Vlbi5oYXMobmFtZSkpIGNvbnRpbnVlO1xuXHRcdFx0XHRzZWVuLmFkZChuYW1lKTtcblxuXHRcdFx0XHRjb25zdCBoYXNDb21tYW5kID0gdHlwZW9mIGNvbmZpZy5jb21tYW5kID09PSBcInN0cmluZ1wiO1xuXHRcdFx0XHRjb25zdCBoYXNVcmwgPSB0eXBlb2YgY29uZmlnLnVybCA9PT0gXCJzdHJpbmdcIjtcblx0XHRcdFx0Y29uc3QgdHJhbnNwb3J0OiBNY3BTZXJ2ZXJDb25maWdbXCJ0cmFuc3BvcnRcIl0gPSBoYXNDb21tYW5kXG5cdFx0XHRcdFx0PyBcInN0ZGlvXCJcblx0XHRcdFx0XHQ6IGhhc1VybFxuXHRcdFx0XHRcdFx0PyBcImh0dHBcIlxuXHRcdFx0XHRcdFx0OiBcInVua25vd25cIjtcblxuXHRcdFx0XHRjb25zdCBoYXNIZWFkZXJzID0gaGFzVXJsICYmIGNvbmZpZy5oZWFkZXJzICYmIHR5cGVvZiBjb25maWcuaGVhZGVycyA9PT0gXCJvYmplY3RcIjtcblx0XHRcdFx0Y29uc3QgaGFzT0F1dGggPSBoYXNVcmwgJiYgY29uZmlnLm9hdXRoICYmIHR5cGVvZiBjb25maWcub2F1dGggPT09IFwib2JqZWN0XCI7XG5cblx0XHRcdFx0c2VydmVycy5wdXNoKHtcblx0XHRcdFx0XHRuYW1lLFxuXHRcdFx0XHRcdHRyYW5zcG9ydCxcblx0XHRcdFx0XHRzb3VyY2VQYXRoOiBjb25maWdQYXRoLFxuXHRcdFx0XHRcdC4uLihoYXNDb21tYW5kICYmIHtcblx0XHRcdFx0XHRcdGNvbW1hbmQ6IGNvbmZpZy5jb21tYW5kIGFzIHN0cmluZyxcblx0XHRcdFx0XHRcdGFyZ3M6IEFycmF5LmlzQXJyYXkoY29uZmlnLmFyZ3MpID8gKGNvbmZpZy5hcmdzIGFzIHN0cmluZ1tdKSA6IHVuZGVmaW5lZCxcblx0XHRcdFx0XHRcdGVudjogY29uZmlnLmVudiAmJiB0eXBlb2YgY29uZmlnLmVudiA9PT0gXCJvYmplY3RcIlxuXHRcdFx0XHRcdFx0XHQ/IChjb25maWcuZW52IGFzIFJlY29yZDxzdHJpbmcsIHN0cmluZz4pXG5cdFx0XHRcdFx0XHRcdDogdW5kZWZpbmVkLFxuXHRcdFx0XHRcdFx0Y3dkOiB0eXBlb2YgY29uZmlnLmN3ZCA9PT0gXCJzdHJpbmdcIiA/IGNvbmZpZy5jd2QgOiB1bmRlZmluZWQsXG5cdFx0XHRcdFx0fSksXG5cdFx0XHRcdFx0Li4uKGhhc1VybCAmJiB7IHVybDogY29uZmlnLnVybCBhcyBzdHJpbmcgfSksXG5cdFx0XHRcdFx0aGVhZGVyczogaGFzSGVhZGVycyA/IGNvbmZpZy5oZWFkZXJzIGFzIFJlY29yZDxzdHJpbmcsIHN0cmluZz4gOiB1bmRlZmluZWQsXG5cdFx0XHRcdFx0b2F1dGg6IGhhc09BdXRoID8gY29uZmlnLm9hdXRoIGFzIE1jcEh0dHBBdXRoQ29uZmlnW1wib2F1dGhcIl0gOiB1bmRlZmluZWQsXG5cdFx0XHRcdH0pO1xuXHRcdFx0fVxuXHRcdH0gY2F0Y2gge1xuXHRcdFx0Ly8gTm9uLWZhdGFsIFx1MjAxNCBjb25maWcgZmlsZSBtYXkgbm90IGV4aXN0IG9yIGJlIG1hbGZvcm1lZFxuXHRcdH1cblx0fVxuXG5cdGNvbmZpZ0NhY2hlID0gc2VydmVycztcblx0cmV0dXJuIHNlcnZlcnM7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBfYnVpbGRNY3BDaGlsZEVudkZvclRlc3QoY29uZmlnRW52OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IHwgdW5kZWZpbmVkKTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB7XG5cdGNvbnN0IGNoaWxkRW52OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XG5cdGZvciAoY29uc3Qga2V5IG9mIENISUxEX0VOVl9BTExPV0xJU1QpIHtcblx0XHRjb25zdCB2YWx1ZSA9IHByb2Nlc3MuZW52W2tleV07XG5cdFx0aWYgKHR5cGVvZiB2YWx1ZSA9PT0gXCJzdHJpbmdcIikgY2hpbGRFbnZba2V5XSA9IHZhbHVlO1xuXHR9XG5cdHJldHVybiB7XG5cdFx0Li4uY2hpbGRFbnYsXG5cdFx0Li4uKGNvbmZpZ0VudiA/IHJlc29sdmVFbnYoY29uZmlnRW52KSA6IHt9KSxcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIF9idWlsZE1jcFRydXN0Q29uZmlybU9wdGlvbnNGb3JUZXN0KHNpZ25hbD86IEFib3J0U2lnbmFsKTogeyB0aW1lb3V0OiBudW1iZXI7IHNpZ25hbD86IEFib3J0U2lnbmFsIH0ge1xuXHRyZXR1cm4gc2lnbmFsID8geyB0aW1lb3V0OiAxMjBfMDAwLCBzaWduYWwgfSA6IHsgdGltZW91dDogMTIwXzAwMCB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBhc3NlcnRUcnVzdGVkU3RkaW9TZXJ2ZXIoXG5cdGNvbmZpZzogTWNwU2VydmVyQ29uZmlnLFxuXHRjdHg/OiBFeHRlbnNpb25Db250ZXh0LFxuXHRzaWduYWw/OiBBYm9ydFNpZ25hbCxcbik6IFByb21pc2U8c3RyaW5nIHwgdW5kZWZpbmVkPiB7XG5cdGlmIChjb25maWcudHJhbnNwb3J0ICE9PSBcInN0ZGlvXCIpIHJldHVybiB1bmRlZmluZWQ7XG5cdGNvbnN0IHRydXN0S2V5ID0gc3RkaW9UcnVzdEtleShjb25maWcpO1xuXHRpZiAodHJ1c3RlZFN0ZGlvU2VydmVycy5oYXModHJ1c3RLZXkpKSByZXR1cm4gdW5kZWZpbmVkO1xuXG5cdGlmICghY3R4Py5oYXNVSSkge1xuXHRcdHRocm93IG5ldyBFcnJvcihcblx0XHRcdGBNQ1Agc2VydmVyIFwiJHtjb25maWcubmFtZX1cIiBpcyBhIHByb2plY3QtbG9jYWwgc3RkaW8gY29tbWFuZCBmcm9tICR7Y29uZmlnLnNvdXJjZVBhdGh9LiBgICtcblx0XHRcdFwiUnVuIHRoaXMgZnJvbSBhbiBpbnRlcmFjdGl2ZSBHU0Qgc2Vzc2lvbiBhbmQgYXBwcm92ZSB0aGUgc2VydmVyIGJlZm9yZSB1c2UuXCIsXG5cdFx0KTtcblx0fVxuXG5cdGNvbnN0IGNvbW1hbmRMaW5lID0gW2NvbmZpZy5jb21tYW5kLCAuLi4oY29uZmlnLmFyZ3MgPz8gW10pXS5maWx0ZXIoQm9vbGVhbikuam9pbihcIiBcIik7XG5cdGNvbnN0IGVudktleXMgPSBPYmplY3Qua2V5cyhjb25maWcuZW52ID8/IHt9KTtcblx0Y29uc3QgZW52U3VtbWFyeSA9IGVudktleXMubGVuZ3RoID4gMFxuXHRcdD8gYFxcblxcbkNvbmZpZ3VyZWQgZW52aXJvbm1lbnQga2V5czogJHtlbnZLZXlzLmpvaW4oXCIsIFwiKX1gXG5cdFx0OiBcIlxcblxcbk5vIGV4cGxpY2l0IGVudmlyb25tZW50IGtleXMgY29uZmlndXJlZC5cIjtcblx0Y29uc3QgYXBwcm92ZWQgPSBhd2FpdCBjdHgudWkuY29uZmlybShcblx0XHRgVHJ1c3QgTUNQIHNlcnZlciBcIiR7Y29uZmlnLm5hbWV9XCI/YCxcblx0XHRgUHJvamVjdCBjb25maWcgJHtjb25maWcuc291cmNlUGF0aH0gd2FudHMgdG8gc3RhcnQ6XFxuXFxuJHtjb21tYW5kTGluZX0ke2VudlN1bW1hcnl9XFxuXFxuT25seSBhcHByb3ZlIE1DUCBzZXJ2ZXJzIHlvdSB0cnVzdC5gLFxuXHRcdF9idWlsZE1jcFRydXN0Q29uZmlybU9wdGlvbnNGb3JUZXN0KHNpZ25hbCksXG5cdCk7XG5cdGlmICghYXBwcm92ZWQpIHtcblx0XHR0aHJvdyBuZXcgRXJyb3IoYE1DUCBzZXJ2ZXIgXCIke2NvbmZpZy5uYW1lfVwiIHdhcyBub3QgYXBwcm92ZWQgYnkgdGhlIHVzZXIuYCk7XG5cdH1cblx0cmV0dXJuIHRydXN0S2V5O1xufVxuXG4vLyBFeHBvcnRlZCBmb3IgdGVzdHMgKHNlZSB0ZXN0cy9zZXJ2ZXItbmFtZS1zcGFjZXMudGVzdC50cykuXG4vLyBQcm9kdWN0aW9uIGNhbGwgc2l0ZXMgdHJlYXQgdGhpcyBhcyBtb2R1bGUtcHJpdmF0ZS5cbmV4cG9ydCBmdW5jdGlvbiBnZXRTZXJ2ZXJDb25maWcobmFtZTogc3RyaW5nKTogTWNwU2VydmVyQ29uZmlnIHwgdW5kZWZpbmVkIHtcblx0Y29uc3QgdHJpbW1lZCA9IG5hbWUudHJpbSgpO1xuXHRyZXR1cm4gcmVhZENvbmZpZ3MoKS5maW5kKChzKSA9PlxuXHRcdHMubmFtZSA9PT0gdHJpbW1lZCB8fFxuXHRcdHMubmFtZS50b0xvd2VyQ2FzZSgpID09PSB0cmltbWVkLnRvTG93ZXJDYXNlKCksXG5cdCk7XG59XG5cbi8qKiBSZXNvbHZlICR7VkFSfSByZWZlcmVuY2VzIGluIGVudiB2YWx1ZXMgYWdhaW5zdCBwcm9jZXNzLmVudi4gKi9cbmZ1bmN0aW9uIHJlc29sdmVFbnYoZW52OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+KTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB7XG5cdGNvbnN0IHJlc29sdmVkOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XG5cdGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKGVudikpIHtcblx0XHRpZiAodHlwZW9mIHZhbHVlID09PSBcInN0cmluZ1wiKSB7XG5cdFx0XHRyZXNvbHZlZFtrZXldID0gdmFsdWUucmVwbGFjZShcblx0XHRcdFx0L1xcJFxceyhbXn1dKylcXH0vZyxcblx0XHRcdFx0KF9tYXRjaCwgdmFyTmFtZSkgPT4gcHJvY2Vzcy5lbnZbdmFyTmFtZV0gPz8gXCJcIixcblx0XHRcdCk7XG5cdFx0fSBlbHNlIHtcblx0XHRcdHJlc29sdmVkW2tleV0gPSB2YWx1ZTtcblx0XHR9XG5cdH1cblx0cmV0dXJuIHJlc29sdmVkO1xufVxuXG5hc3luYyBmdW5jdGlvbiBnZXRPckNvbm5lY3QobmFtZTogc3RyaW5nLCBzaWduYWw/OiBBYm9ydFNpZ25hbCwgY3R4PzogRXh0ZW5zaW9uQ29udGV4dCk6IFByb21pc2U8Q2xpZW50PiB7XG5cdGNvbnN0IGNvbmZpZyA9IGdldFNlcnZlckNvbmZpZyhuYW1lKTtcblx0aWYgKCFjb25maWcpIHRocm93IG5ldyBFcnJvcihgVW5rbm93biBNQ1Agc2VydmVyOiBcIiR7bmFtZX1cIi4gVXNlIG1jcF9zZXJ2ZXJzIHRvIGxpc3QgYXZhaWxhYmxlIHNlcnZlcnMuYCk7XG5cblx0Ly8gQWx3YXlzIHVzZSBjb25maWcubmFtZSBhcyB0aGUgY2Fub25pY2FsIGNhY2hlIGtleSBzbyB0aGF0IHZhcmlhbnRcblx0Ly8gY2FzaW5nIC8gd2hpdGVzcGFjZSBzdGlsbCBoaXRzIHRoZSBzYW1lIGNvbm5lY3Rpb24uXG5cdGNvbnN0IGV4aXN0aW5nID0gY29ubmVjdGlvbnMuZ2V0KGNvbmZpZy5uYW1lKTtcblx0aWYgKGV4aXN0aW5nKSByZXR1cm4gZXhpc3RpbmcuY2xpZW50O1xuXG5cdGNvbnN0IHBlbmRpbmcgPSBwZW5kaW5nQ29ubmVjdGlvbnMuZ2V0KGNvbmZpZy5uYW1lKTtcblx0aWYgKHBlbmRpbmcpIHJldHVybiBwZW5kaW5nO1xuXG5cdGNvbnN0IGNvbm5lY3Rpb25Qcm9taXNlID0gY29ubmVjdFNlcnZlcihjb25maWcsIHNpZ25hbCwgY3R4KTtcblx0cGVuZGluZ0Nvbm5lY3Rpb25zLnNldChjb25maWcubmFtZSwgY29ubmVjdGlvblByb21pc2UpO1xuXHR0cnkge1xuXHRcdHJldHVybiBhd2FpdCBjb25uZWN0aW9uUHJvbWlzZTtcblx0fSBmaW5hbGx5IHtcblx0XHRwZW5kaW5nQ29ubmVjdGlvbnMuZGVsZXRlKGNvbmZpZy5uYW1lKTtcblx0fVxufVxuXG5hc3luYyBmdW5jdGlvbiBjb25uZWN0U2VydmVyKGNvbmZpZzogTWNwU2VydmVyQ29uZmlnLCBzaWduYWw/OiBBYm9ydFNpZ25hbCwgY3R4PzogRXh0ZW5zaW9uQ29udGV4dCk6IFByb21pc2U8Q2xpZW50PiB7XG5cdGNvbnN0IGNsaWVudCA9IG5ldyBDbGllbnQoeyBuYW1lOiBcImdzZFwiLCB2ZXJzaW9uOiBcIjEuMC4wXCIgfSk7XG5cdGxldCB0cmFuc3BvcnQ6IFN0ZGlvQ2xpZW50VHJhbnNwb3J0IHwgU3RyZWFtYWJsZUhUVFBDbGllbnRUcmFuc3BvcnQ7XG5cdGxldCBhcHByb3ZlZFRydXN0S2V5OiBzdHJpbmcgfCB1bmRlZmluZWQ7XG5cblx0aWYgKGNvbmZpZy50cmFuc3BvcnQgPT09IFwic3RkaW9cIiAmJiBjb25maWcuY29tbWFuZCkge1xuXHRcdGFwcHJvdmVkVHJ1c3RLZXkgPSBhd2FpdCBhc3NlcnRUcnVzdGVkU3RkaW9TZXJ2ZXIoY29uZmlnLCBjdHgsIHNpZ25hbCk7XG5cdFx0dHJhbnNwb3J0ID0gbmV3IFN0ZGlvQ2xpZW50VHJhbnNwb3J0KHtcblx0XHRcdGNvbW1hbmQ6IGNvbmZpZy5jb21tYW5kLFxuXHRcdFx0YXJnczogY29uZmlnLmFyZ3MsXG5cdFx0XHRlbnY6IF9idWlsZE1jcENoaWxkRW52Rm9yVGVzdChjb25maWcuZW52KSxcblx0XHRcdGN3ZDogY29uZmlnLmN3ZCxcblx0XHRcdHN0ZGVycjogXCJwaXBlXCIsXG5cdFx0fSk7XG5cdH0gZWxzZSBpZiAoY29uZmlnLnRyYW5zcG9ydCA9PT0gXCJodHRwXCIgJiYgY29uZmlnLnVybCkge1xuXHRcdGNvbnN0IHJlc29sdmVkVXJsID0gY29uZmlnLnVybC5yZXBsYWNlKFxuXHRcdFx0L1xcJFxceyhbXn1dKylcXH0vZyxcblx0XHRcdChfLCB2YXJOYW1lKSA9PiBwcm9jZXNzLmVudlt2YXJOYW1lXSA/PyBcIlwiLFxuXHRcdCk7XG5cdFx0Y29uc3QgaHR0cE9wdHMgPSBidWlsZEh0dHBUcmFuc3BvcnRPcHRzKHtcblx0XHRcdGhlYWRlcnM6IGNvbmZpZy5oZWFkZXJzLFxuXHRcdFx0b2F1dGg6IGNvbmZpZy5vYXV0aCxcblx0XHR9KTtcblx0XHR0cmFuc3BvcnQgPSBuZXcgU3RyZWFtYWJsZUhUVFBDbGllbnRUcmFuc3BvcnQobmV3IFVSTChyZXNvbHZlZFVybCksIGh0dHBPcHRzKTtcblx0fSBlbHNlIHtcblx0XHR0aHJvdyBuZXcgRXJyb3IoYFNlcnZlciBcIiR7Y29uZmlnLm5hbWV9XCIgaGFzIHVuc3VwcG9ydGVkIHRyYW5zcG9ydDogJHtjb25maWcudHJhbnNwb3J0fWApO1xuXHR9XG5cblx0dHJ5IHtcblx0XHRhd2FpdCBjbGllbnQuY29ubmVjdCh0cmFuc3BvcnQsIHsgc2lnbmFsLCB0aW1lb3V0OiAzMDAwMCB9KTtcblx0XHRpZiAoYXBwcm92ZWRUcnVzdEtleSkgdHJ1c3RlZFN0ZGlvU2VydmVycy5hZGQoYXBwcm92ZWRUcnVzdEtleSk7XG5cdFx0Y29ubmVjdGlvbnMuc2V0KGNvbmZpZy5uYW1lLCB7IGNsaWVudCwgdHJhbnNwb3J0IH0pO1xuXHRcdHJldHVybiBjbGllbnQ7XG5cdH0gY2F0Y2ggKGVycikge1xuXHRcdHRyeSB7XG5cdFx0XHRhd2FpdCB0cmFuc3BvcnQuY2xvc2UoKTtcblx0XHR9IGNhdGNoIHtcblx0XHRcdC8vIEJlc3QtZWZmb3J0IGNsZWFudXAgYWZ0ZXIgYSBmYWlsZWQgb3IgYWJvcnRlZCBjb25uZWN0aW9uIGF0dGVtcHQuXG5cdFx0fVxuXHRcdHRyeSB7XG5cdFx0XHRhd2FpdCBjbGllbnQuY2xvc2UoKTtcblx0XHR9IGNhdGNoIHtcblx0XHRcdC8vIEJlc3QtZWZmb3J0IGNsZWFudXAgYWZ0ZXIgYSBmYWlsZWQgb3IgYWJvcnRlZCBjb25uZWN0aW9uIGF0dGVtcHQuXG5cdFx0fVxuXHRcdHRocm93IGVycjtcblx0fVxufVxuXG5hc3luYyBmdW5jdGlvbiBjbG9zZUFsbCgpOiBQcm9taXNlPHZvaWQ+IHtcblx0Y29uc3QgY2xvc2luZyA9IEFycmF5LmZyb20oY29ubmVjdGlvbnMuZW50cmllcygpKS5tYXAoYXN5bmMgKFtuYW1lLCBjb25uXSkgPT4ge1xuXHRcdHRyeSB7XG5cdFx0XHRhd2FpdCBjb25uLmNsaWVudC5jbG9zZSgpO1xuXHRcdH0gY2F0Y2gge1xuXHRcdFx0Ly8gQmVzdC1lZmZvcnQgY2xlYW51cFxuXHRcdH1cblx0XHR0cnkge1xuXHRcdFx0YXdhaXQgY29ubi50cmFuc3BvcnQuY2xvc2UoKTtcblx0XHR9IGNhdGNoIHtcblx0XHRcdC8vIEJlc3QtZWZmb3J0IGNsZWFudXBcblx0XHR9XG5cdFx0Y29ubmVjdGlvbnMuZGVsZXRlKG5hbWUpO1xuXHR9KTtcblx0YXdhaXQgUHJvbWlzZS5hbGxTZXR0bGVkKGNsb3NpbmcpO1xuXHRwZW5kaW5nQ29ubmVjdGlvbnMuY2xlYXIoKTtcblx0dHJ1c3RlZFN0ZGlvU2VydmVycy5jbGVhcigpO1xuXHR0b29sQ2FjaGUuY2xlYXIoKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEZvcm1hdHRlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIGZvcm1hdFNlcnZlckxpc3Qoc2VydmVyczogTWNwU2VydmVyQ29uZmlnW10pOiBzdHJpbmcge1xuXHRpZiAoc2VydmVycy5sZW5ndGggPT09IDApIHJldHVybiBcIk5vIE1DUCBzZXJ2ZXJzIGNvbmZpZ3VyZWQuIEFkZCBzZXJ2ZXJzIHRvIC5tY3AuanNvbiwgLmdzZC9tY3AuanNvbiwgb3IgJEdTRF9IT01FL21jcC5qc29uIChkZWZhdWx0OiB+Ly5nc2QvbWNwLmpzb24pLlwiO1xuXG5cdGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtgJHtzZXJ2ZXJzLmxlbmd0aH0gTUNQIHNlcnZlcnMgY29uZmlndXJlZDpcXG5gXTtcblxuXHRmb3IgKGNvbnN0IHMgb2Ygc2VydmVycykge1xuXHRcdGNvbnN0IGNvbm5lY3RlZCA9IGNvbm5lY3Rpb25zLmhhcyhzLm5hbWUpID8gXCJcdTI3MTNcIiA6IFwiXHUyNUNCXCI7XG5cdFx0Y29uc3QgY2FjaGVkID0gdG9vbENhY2hlLmdldChzLm5hbWUpO1xuXHRcdGNvbnN0IHRvb2xDb3VudCA9IGNhY2hlZCA/IGAgXHUyMDE0ICR7Y2FjaGVkLmxlbmd0aH0gdG9vbHNgIDogXCJcIjtcblx0XHRsaW5lcy5wdXNoKGAke2Nvbm5lY3RlZH0gJHtzLm5hbWV9ICgke3MudHJhbnNwb3J0fSkke3Rvb2xDb3VudH1gKTtcblx0fVxuXG5cdGxpbmVzLnB1c2goXCJcXG5Vc2UgbWNwX2Rpc2NvdmVyIHRvIHNlZSBmdWxsIHRvb2wgc2NoZW1hcyBmb3IgYSBzcGVjaWZpYyBzZXJ2ZXIuXCIpO1xuXHRsaW5lcy5wdXNoKFwiVXNlIG1jcF9jYWxsIHRvIGludm9rZSBhIHRvb2w6IG1jcF9jYWxsKHNlcnZlciwgdG9vbCwgYXJncykuXCIpO1xuXHRyZXR1cm4gbGluZXMuam9pbihcIlxcblwiKTtcbn1cblxuZnVuY3Rpb24gZm9ybWF0VG9vbExpc3Qoc2VydmVyTmFtZTogc3RyaW5nLCB0b29sczogTWNwVG9vbFNjaGVtYVtdKTogc3RyaW5nIHtcblx0Y29uc3QgbGluZXM6IHN0cmluZ1tdID0gW2Ake3NlcnZlck5hbWV9IFx1MjAxNCAke3Rvb2xzLmxlbmd0aH0gdG9vbHM6XFxuYF07XG5cblx0Zm9yIChjb25zdCB0b29sIG9mIHRvb2xzKSB7XG5cdFx0bGluZXMucHVzaChgIyMgJHt0b29sLm5hbWV9YCk7XG5cdFx0aWYgKHRvb2wuZGVzY3JpcHRpb24pIGxpbmVzLnB1c2godG9vbC5kZXNjcmlwdGlvbik7XG5cdFx0aWYgKHRvb2wuaW5wdXRTY2hlbWEpIHtcblx0XHRcdGxpbmVzLnB1c2goXCJgYGBqc29uXCIpO1xuXHRcdFx0bGluZXMucHVzaChKU09OLnN0cmluZ2lmeSh0b29sLmlucHV0U2NoZW1hLCBudWxsLCAyKSk7XG5cdFx0XHRsaW5lcy5wdXNoKFwiYGBgXCIpO1xuXHRcdH1cblx0XHRsaW5lcy5wdXNoKFwiXCIpO1xuXHR9XG5cblx0bGluZXMucHVzaChgQ2FsbCB3aXRoOiBtY3BfY2FsbChzZXJ2ZXI9XCIke3NlcnZlck5hbWV9XCIsIHRvb2w9XCI8dG9vbF9uYW1lPlwiLCBhcmdzPXsuLi59KWApO1xuXHRyZXR1cm4gbGluZXMuam9pbihcIlxcblwiKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFN0YXR1cyBoZWxwZXIgKGNvbnN1bWVkIGJ5IC9nc2QgbWNwKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBSZXR1cm4gdGhlIGxpdmUgY29ubmVjdGlvbiBzdGF0dXMgZm9yIGEgbmFtZWQgTUNQIHNlcnZlci5cbiAqIFNhZmUgdG8gY2FsbCBldmVuIHdoZW4gdGhlIHNlcnZlciBoYXMgbmV2ZXIgYmVlbiBjb25uZWN0ZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRDb25uZWN0aW9uU3RhdHVzKG5hbWU6IHN0cmluZyk6IHtcblx0Y29ubmVjdGVkOiBib29sZWFuO1xuXHR0b29sczogc3RyaW5nW107XG5cdGVycm9yPzogc3RyaW5nO1xufSB7XG5cdGNvbnN0IGNvbm4gPSBjb25uZWN0aW9ucy5nZXQobmFtZSk7XG5cdGNvbnN0IGNhY2hlZCA9IHRvb2xDYWNoZS5nZXQobmFtZSk7XG5cdHJldHVybiB7XG5cdFx0Y29ubmVjdGVkOiAhIWNvbm4sXG5cdFx0dG9vbHM6IGNhY2hlZCA/IGNhY2hlZC5tYXAoKHQpID0+IHQubmFtZSkgOiBbXSxcblx0XHRlcnJvcjogdW5kZWZpbmVkLFxuXHR9O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRXh0ZW5zaW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgZGVmYXVsdCBmdW5jdGlvbiAocGk6IEV4dGVuc2lvbkFQSSkge1xuXHQvLyBcdTI1MDBcdTI1MDAgbWNwX3NlcnZlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cblx0cGkucmVnaXN0ZXJUb29sKHtcblx0XHRuYW1lOiBcIm1jcF9zZXJ2ZXJzXCIsXG5cdFx0bGFiZWw6IFwiTUNQIFNlcnZlcnNcIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiTGlzdCBhbGwgYXZhaWxhYmxlIE1DUCBzZXJ2ZXJzIGNvbmZpZ3VyZWQgaW4gcHJvamVjdCBmaWxlcyAoLm1jcC5qc29uLCAuZ3NkL21jcC5qc29uKSBvciBnbG9iYWxseSAoJEdTRF9IT01FL21jcC5qc29uLCBkZWZhdWx0OiB+Ly5nc2QvbWNwLmpzb24pLiBcIiArXG5cdFx0XHRcIlNob3dzIHNlcnZlciBuYW1lcywgdHJhbnNwb3J0IHR5cGUsIGFuZCBjb25uZWN0aW9uIHN0YXR1cy4gVXNlIG1jcF9kaXNjb3ZlciB0byBnZXQgZnVsbCB0b29sIHNjaGVtYXMgZm9yIGEgc2VydmVyLlwiLFxuXHRcdHByb21wdFNuaXBwZXQ6XG5cdFx0XHRcIkxpc3QgYXZhaWxhYmxlIE1DUCBzZXJ2ZXJzIGZyb20gcHJvamVjdCBjb25maWd1cmF0aW9uXCIsXG5cdFx0cHJvbXB0R3VpZGVsaW5lczogW1xuXHRcdFx0XCJDYWxsIG1jcF9zZXJ2ZXJzIHRvIHNlZSB3aGF0IE1DUCBzZXJ2ZXJzIGFyZSBhdmFpbGFibGUgYmVmb3JlIHRyeWluZyB0byB1c2Ugb25lLlwiLFxuXHRcdFx0XCJNQ1Agc2VydmVycyBwcm92aWRlIGV4dGVybmFsIGludGVncmF0aW9ucyAoVHdpdHRlciwgTGluZWFyLCBSYWlsd2F5LCBldGMuKSB2aWEgdGhlIE1vZGVsIENvbnRleHQgUHJvdG9jb2wuXCIsXG5cdFx0XHRcIkFmdGVyIGxpc3RpbmcsIHVzZSBtY3BfZGlzY292ZXIoc2VydmVyKSB0byBnZXQgdG9vbCBzY2hlbWFzLCB0aGVuIG1jcF9jYWxsKHNlcnZlciwgdG9vbCwgYXJncykgdG8gaW52b2tlLlwiLFxuXHRcdF0sXG5cdFx0cGFyYW1ldGVyczogVHlwZS5PYmplY3Qoe1xuXHRcdFx0cmVmcmVzaDogVHlwZS5PcHRpb25hbChcblx0XHRcdFx0VHlwZS5Cb29sZWFuKHsgZGVzY3JpcHRpb246IFwiRm9yY2UgcmVmcmVzaCB0aGUgc2VydmVyIGxpc3QgKGRlZmF1bHQ6IHVzZSBjYWNoZSlcIiB9KSxcblx0XHRcdCksXG5cdFx0fSksXG5cblx0XHRhc3luYyBleGVjdXRlKF9pZCwgcGFyYW1zKSB7XG5cdFx0XHRpZiAocGFyYW1zLnJlZnJlc2gpIGNvbmZpZ0NhY2hlID0gbnVsbDtcblxuXHRcdFx0Y29uc3Qgc2VydmVycyA9IHJlYWRDb25maWdzKCk7XG5cdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogZm9ybWF0U2VydmVyTGlzdChzZXJ2ZXJzKSB9XSxcblx0XHRcdFx0ZGV0YWlsczoge1xuXHRcdFx0XHRcdHNlcnZlckNvdW50OiBzZXJ2ZXJzLmxlbmd0aCxcblx0XHRcdFx0XHRjYWNoZWQ6ICFwYXJhbXMucmVmcmVzaCAmJiBjb25maWdDYWNoZSAhPT0gbnVsbCxcblx0XHRcdFx0fSxcblx0XHRcdH07XG5cdFx0fSxcblxuXHRcdHJlbmRlckNhbGwoYXJncywgdGhlbWUpIHtcblx0XHRcdGxldCB0ZXh0ID0gdGhlbWUuZmcoXCJ0b29sVGl0bGVcIiwgdGhlbWUuYm9sZChcIm1jcF9zZXJ2ZXJzXCIpKTtcblx0XHRcdGlmIChhcmdzLnJlZnJlc2gpIHRleHQgKz0gdGhlbWUuZmcoXCJ3YXJuaW5nXCIsIFwiIChyZWZyZXNoKVwiKTtcblx0XHRcdHJldHVybiBuZXcgVGV4dCh0ZXh0LCAwLCAwKTtcblx0XHR9LFxuXG5cdFx0cmVuZGVyUmVzdWx0KHJlc3VsdCwgeyBpc1BhcnRpYWwgfSwgdGhlbWUpIHtcblx0XHRcdGlmIChpc1BhcnRpYWwpIHJldHVybiBuZXcgVGV4dCh0aGVtZS5mZyhcIndhcm5pbmdcIiwgXCJSZWFkaW5nIE1DUCBjb25maWcuLi5cIiksIDAsIDApO1xuXHRcdFx0Y29uc3QgZCA9IHJlc3VsdC5kZXRhaWxzIGFzIHsgc2VydmVyQ291bnQ6IG51bWJlciB9IHwgdW5kZWZpbmVkO1xuXHRcdFx0cmV0dXJuIG5ldyBUZXh0KFxuXHRcdFx0XHR0aGVtZS5mZyhcInN1Y2Nlc3NcIiwgYCR7ZD8uc2VydmVyQ291bnQgPz8gMH0gc2VydmVycyBjb25maWd1cmVkYCksXG5cdFx0XHRcdDAsXG5cdFx0XHRcdDAsXG5cdFx0XHQpO1xuXHRcdH0sXG5cdH0pO1xuXG5cdC8vIFx1MjUwMFx1MjUwMCBtY3BfZGlzY292ZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cblx0cGkucmVnaXN0ZXJUb29sKHtcblx0XHRuYW1lOiBcIm1jcF9kaXNjb3ZlclwiLFxuXHRcdGxhYmVsOiBcIk1DUCBEaXNjb3ZlclwiLFxuXHRcdGRlc2NyaXB0aW9uOlxuXHRcdFx0XCJHZXQgZGV0YWlsZWQgdG9vbCBzaWduYXR1cmVzIGFuZCBKU09OIHNjaGVtYXMgZm9yIGEgc3BlY2lmaWMgTUNQIHNlcnZlci4gXCIgK1xuXHRcdFx0XCJDb25uZWN0cyB0byB0aGUgc2VydmVyIG9uIGZpcnN0IGNhbGwgKGxhenkgY29ubmVjdGlvbikuIFwiICtcblx0XHRcdFwiVXNlIHRoaXMgdG8gdW5kZXJzdGFuZCB3aGF0IHRvb2xzIGEgc2VydmVyIHByb3ZpZGVzIGFuZCB3aGF0IGFyZ3VtZW50cyB0aGV5IGFjY2VwdCBcIiArXG5cdFx0XHRcImJlZm9yZSBjYWxsaW5nIHRoZW0gd2l0aCBtY3BfY2FsbC5cIixcblx0XHRwcm9tcHRTbmlwcGV0OlxuXHRcdFx0XCJHZXQgdG9vbCBzY2hlbWFzIGZvciBhIHNwZWNpZmljIE1DUCBzZXJ2ZXIgYmVmb3JlIGNhbGxpbmcgaXRzIHRvb2xzXCIsXG5cdFx0cHJvbXB0R3VpZGVsaW5lczogW1xuXHRcdFx0XCJDYWxsIG1jcF9kaXNjb3ZlciB3aXRoIGEgc2VydmVyIG5hbWUgdG8gc2VlIHRoZSBmdWxsIHRvb2wgc2lnbmF0dXJlcyBiZWZvcmUgY2FsbGluZyBtY3BfY2FsbC5cIixcblx0XHRcdFwiVGhlIHNjaGVtYXMgc2hvdyByZXF1aXJlZCBhbmQgb3B0aW9uYWwgcGFyYW1ldGVycyB3aXRoIHR5cGVzIGFuZCBkZXNjcmlwdGlvbnMuXCIsXG5cdFx0XSxcblx0XHRwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG5cdFx0XHRzZXJ2ZXI6IFR5cGUuU3RyaW5nKHtcblx0XHRcdFx0ZGVzY3JpcHRpb246XG5cdFx0XHRcdFx0XCJNQ1Agc2VydmVyIG5hbWUgKGZyb20gbWNwX3NlcnZlcnMgb3V0cHV0KSwgZS5nLiAncmFpbHdheScsICd0d2l0dGVyLW1jcCcsICdsaW5lYXInXCIsXG5cdFx0XHR9KSxcblx0XHR9KSxcblxuXHRcdGFzeW5jIGV4ZWN1dGUoX2lkLCBwYXJhbXMsIHNpZ25hbCwgX29uVXBkYXRlLCBjdHgpIHtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdC8vIFJldHVybiBjYWNoZWQgdG9vbHMgaWYgYXZhaWxhYmxlXG5cdFx0XHRcdGNvbnN0IGNhY2hlZCA9IHRvb2xDYWNoZS5nZXQocGFyYW1zLnNlcnZlcik7XG5cdFx0XHRcdGlmIChjYWNoZWQpIHtcblx0XHRcdFx0XHRjb25zdCB0ZXh0ID0gZm9ybWF0VG9vbExpc3QocGFyYW1zLnNlcnZlciwgY2FjaGVkKTtcblx0XHRcdFx0XHRjb25zdCB0cnVuY2F0aW9uID0gdHJ1bmNhdGVIZWFkKHRleHQsIHsgbWF4TGluZXM6IERFRkFVTFRfTUFYX0xJTkVTLCBtYXhCeXRlczogREVGQVVMVF9NQVhfQllURVMgfSk7XG5cdFx0XHRcdFx0bGV0IGZpbmFsVGV4dCA9IHRydW5jYXRpb24uY29udGVudDtcblx0XHRcdFx0XHRpZiAodHJ1bmNhdGlvbi50cnVuY2F0ZWQpIHtcblx0XHRcdFx0XHRcdGZpbmFsVGV4dCArPSBgXFxuXFxuW1RydW5jYXRlZDogJHt0cnVuY2F0aW9uLm91dHB1dExpbmVzfS8ke3RydW5jYXRpb24udG90YWxMaW5lc30gbGluZXMgKCR7Zm9ybWF0U2l6ZSh0cnVuY2F0aW9uLm91dHB1dEJ5dGVzKX0gb2YgJHtmb3JtYXRTaXplKHRydW5jYXRpb24udG90YWxCeXRlcyl9KV1gO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGZpbmFsVGV4dCB9XSxcblx0XHRcdFx0XHRcdGRldGFpbHM6IHsgc2VydmVyOiBwYXJhbXMuc2VydmVyLCB0b29sQ291bnQ6IGNhY2hlZC5sZW5ndGgsIGNhY2hlZDogdHJ1ZSB9LFxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRjb25zdCBjbGllbnQgPSBhd2FpdCBnZXRPckNvbm5lY3QocGFyYW1zLnNlcnZlciwgc2lnbmFsLCBjdHgpO1xuXHRcdFx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCBjbGllbnQubGlzdFRvb2xzKHVuZGVmaW5lZCwgeyBzaWduYWwsIHRpbWVvdXQ6IDMwMDAwIH0pO1xuXHRcdFx0XHRjb25zdCB0b29sczogTWNwVG9vbFNjaGVtYVtdID0gKHJlc3VsdC50b29scyA/PyBbXSkubWFwKCh0KSA9PiAoe1xuXHRcdFx0XHRcdG5hbWU6IHQubmFtZSxcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjogdC5kZXNjcmlwdGlvbiA/PyBcIlwiLFxuXHRcdFx0XHRcdGlucHV0U2NoZW1hOiB0LmlucHV0U2NoZW1hIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkLFxuXHRcdFx0XHR9KSk7XG5cdFx0XHRcdHRvb2xDYWNoZS5zZXQocGFyYW1zLnNlcnZlciwgdG9vbHMpO1xuXG5cdFx0XHRcdGNvbnN0IHRleHQgPSBmb3JtYXRUb29sTGlzdChwYXJhbXMuc2VydmVyLCB0b29scyk7XG5cdFx0XHRcdGNvbnN0IHRydW5jYXRpb24gPSB0cnVuY2F0ZUhlYWQodGV4dCwgeyBtYXhMaW5lczogREVGQVVMVF9NQVhfTElORVMsIG1heEJ5dGVzOiBERUZBVUxUX01BWF9CWVRFUyB9KTtcblx0XHRcdFx0bGV0IGZpbmFsVGV4dCA9IHRydW5jYXRpb24uY29udGVudDtcblx0XHRcdFx0aWYgKHRydW5jYXRpb24udHJ1bmNhdGVkKSB7XG5cdFx0XHRcdFx0ZmluYWxUZXh0ICs9IGBcXG5cXG5bVHJ1bmNhdGVkOiAke3RydW5jYXRpb24ub3V0cHV0TGluZXN9LyR7dHJ1bmNhdGlvbi50b3RhbExpbmVzfSBsaW5lcyAoJHtmb3JtYXRTaXplKHRydW5jYXRpb24ub3V0cHV0Qnl0ZXMpfSBvZiAke2Zvcm1hdFNpemUodHJ1bmNhdGlvbi50b3RhbEJ5dGVzKX0pXWA7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBmaW5hbFRleHQgfV0sXG5cdFx0XHRcdFx0ZGV0YWlsczogeyBzZXJ2ZXI6IHBhcmFtcy5zZXJ2ZXIsIHRvb2xDb3VudDogdG9vbHMubGVuZ3RoLCBjYWNoZWQ6IGZhbHNlIH0sXG5cdFx0XHRcdH07XG5cdFx0XHR9IGNhdGNoIChlcnI6IHVua25vd24pIHtcblx0XHRcdFx0Y29uc3QgbXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoYEZhaWxlZCB0byBkaXNjb3ZlciB0b29scyBmb3IgXCIke3BhcmFtcy5zZXJ2ZXJ9XCI6ICR7bXNnfWApO1xuXHRcdFx0fVxuXHRcdH0sXG5cblx0XHRyZW5kZXJDYWxsKGFyZ3MsIHRoZW1lKSB7XG5cdFx0XHRsZXQgdGV4dCA9IHRoZW1lLmZnKFwidG9vbFRpdGxlXCIsIHRoZW1lLmJvbGQoXCJtY3BfZGlzY292ZXIgXCIpKTtcblx0XHRcdHRleHQgKz0gdGhlbWUuZmcoXCJhY2NlbnRcIiwgYXJncy5zZXJ2ZXIpO1xuXHRcdFx0cmV0dXJuIG5ldyBUZXh0KHRleHQsIDAsIDApO1xuXHRcdH0sXG5cblx0XHRyZW5kZXJSZXN1bHQocmVzdWx0LCB7IGlzUGFydGlhbCB9LCB0aGVtZSkge1xuXHRcdFx0aWYgKGlzUGFydGlhbClcblx0XHRcdFx0cmV0dXJuIG5ldyBUZXh0KHRoZW1lLmZnKFwid2FybmluZ1wiLCBcIkRpc2NvdmVyaW5nIHRvb2xzLi4uXCIpLCAwLCAwKTtcblx0XHRcdGNvbnN0IGQgPSByZXN1bHQuZGV0YWlscyBhcyB7IHNlcnZlcjogc3RyaW5nOyB0b29sQ291bnQ6IG51bWJlciB9IHwgdW5kZWZpbmVkO1xuXHRcdFx0cmV0dXJuIG5ldyBUZXh0KFxuXHRcdFx0XHR0aGVtZS5mZyhcInN1Y2Nlc3NcIiwgYCR7ZD8udG9vbENvdW50ID8/IDB9IHRvb2xzYCkgK1xuXHRcdFx0XHRcdHRoZW1lLmZnKFwiZGltXCIsIGAgXHUwMEI3ICR7ZD8uc2VydmVyfWApLFxuXHRcdFx0XHQwLFxuXHRcdFx0XHQwLFxuXHRcdFx0KTtcblx0XHR9LFxuXHR9KTtcblxuXHQvLyBcdTI1MDBcdTI1MDAgbWNwX2NhbGwgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cblx0cGkucmVnaXN0ZXJUb29sKHtcblx0XHRuYW1lOiBcIm1jcF9jYWxsXCIsXG5cdFx0bGFiZWw6IFwiTUNQIENhbGxcIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiQ2FsbCBhIHRvb2wgb24gYW4gTUNQIHNlcnZlci4gUHJvdmlkZSB0aGUgc2VydmVyIG5hbWUsIHRvb2wgbmFtZSwgYW5kIGFyZ3VtZW50cy4gXCIgK1xuXHRcdFx0XCJDb25uZWN0cyB0byB0aGUgc2VydmVyIG9uIGZpcnN0IGNhbGwgKGxhenkgY29ubmVjdGlvbikuIFwiICtcblx0XHRcdFwiVXNlIG1jcF9kaXNjb3ZlciBmaXJzdCB0byBzZWUgYXZhaWxhYmxlIHRvb2xzIGFuZCB0aGVpciByZXF1aXJlZCBhcmd1bWVudHMuXCIsXG5cdFx0cHJvbXB0U25pcHBldDogXCJDYWxsIGEgdG9vbCBvbiBhbiBNQ1Agc2VydmVyXCIsXG5cdFx0cHJvbXB0R3VpZGVsaW5lczogW1xuXHRcdFx0XCJBbHdheXMgdXNlIG1jcF9kaXNjb3ZlciBmaXJzdCB0byB1bmRlcnN0YW5kIHRoZSB0b29sJ3MgcGFyYW1ldGVycyBiZWZvcmUgY2FsbGluZyBtY3BfY2FsbC5cIixcblx0XHRcdFwiQXJndW1lbnRzIGFyZSBwYXNzZWQgYXMgYSBKU09OIG9iamVjdCBtYXRjaGluZyB0aGUgdG9vbCdzIGlucHV0IHNjaGVtYS5cIixcblx0XHRdLFxuXHRcdHBhcmFtZXRlcnM6IFR5cGUuT2JqZWN0KHtcblx0XHRcdHNlcnZlcjogVHlwZS5TdHJpbmcoe1xuXHRcdFx0XHRkZXNjcmlwdGlvbjogXCJNQ1Agc2VydmVyIG5hbWUsIGUuZy4gJ3JhaWx3YXknLCAndHdpdHRlci1tY3AnXCIsXG5cdFx0XHR9KSxcblx0XHRcdHRvb2w6IFR5cGUuU3RyaW5nKHtcblx0XHRcdFx0ZGVzY3JpcHRpb246IFwiVG9vbCBuYW1lIG9uIHRoYXQgc2VydmVyLCBlLmcuICdyYWlsd2F5X2xpc3RfcHJvamVjdHMnXCIsXG5cdFx0XHR9KSxcblx0XHRcdGFyZ3M6IFR5cGUuT3B0aW9uYWwoXG5cdFx0XHRcdFR5cGUuT2JqZWN0KHt9LCB7XG5cdFx0XHRcdFx0YWRkaXRpb25hbFByb3BlcnRpZXM6IHRydWUsXG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246XG5cdFx0XHRcdFx0XHRcIlRvb2wgYXJndW1lbnRzIGFzIGtleS12YWx1ZSBwYWlycyBtYXRjaGluZyB0aGUgdG9vbCdzIGlucHV0IHNjaGVtYVwiLFxuXHRcdFx0XHR9KSxcblx0XHRcdCksXG5cdFx0fSksXG5cblx0XHRhc3luYyBleGVjdXRlKF9pZCwgcGFyYW1zLCBzaWduYWwsIF9vblVwZGF0ZSwgY3R4KSB7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCBjbGllbnQgPSBhd2FpdCBnZXRPckNvbm5lY3QocGFyYW1zLnNlcnZlciwgc2lnbmFsLCBjdHgpO1xuXHRcdFx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCBjbGllbnQuY2FsbFRvb2woXG5cdFx0XHRcdFx0eyBuYW1lOiBwYXJhbXMudG9vbCwgYXJndW1lbnRzOiBwYXJhbXMuYXJncyA/PyB7fSB9LFxuXHRcdFx0XHRcdHVuZGVmaW5lZCxcblx0XHRcdFx0XHR7IHNpZ25hbCwgdGltZW91dDogNjAwMDAgfSxcblx0XHRcdFx0KTtcblxuXHRcdFx0XHQvLyBTZXJpYWxpemUgcmVzdWx0IGNvbnRlbnQgdG8gdGV4dFxuXHRcdFx0XHRjb25zdCBjb250ZW50SXRlbXMgPSByZXN1bHQuY29udGVudCBhcyBBcnJheTx7IHR5cGU6IHN0cmluZzsgdGV4dD86IHN0cmluZyB9Pjtcblx0XHRcdFx0Y29uc3QgcmF3ID0gY29udGVudEl0ZW1zXG5cdFx0XHRcdFx0Lm1hcCgoYykgPT4gKGMudHlwZSA9PT0gXCJ0ZXh0XCIgPyBjLnRleHQgPz8gXCJcIiA6IEpTT04uc3RyaW5naWZ5KGMpKSlcblx0XHRcdFx0XHQuam9pbihcIlxcblwiKTtcblxuXHRcdFx0XHRjb25zdCB0cnVuY2F0aW9uID0gdHJ1bmNhdGVIZWFkKHJhdywgeyBtYXhMaW5lczogREVGQVVMVF9NQVhfTElORVMsIG1heEJ5dGVzOiBERUZBVUxUX01BWF9CWVRFUyB9KTtcblx0XHRcdFx0bGV0IGZpbmFsVGV4dCA9IHRydW5jYXRpb24uY29udGVudDtcblx0XHRcdFx0aWYgKHRydW5jYXRpb24udHJ1bmNhdGVkKSB7XG5cdFx0XHRcdFx0ZmluYWxUZXh0ICs9IGBcXG5cXG5bT3V0cHV0IHRydW5jYXRlZDogJHt0cnVuY2F0aW9uLm91dHB1dExpbmVzfS8ke3RydW5jYXRpb24udG90YWxMaW5lc30gbGluZXMgKCR7Zm9ybWF0U2l6ZSh0cnVuY2F0aW9uLm91dHB1dEJ5dGVzKX0gb2YgJHtmb3JtYXRTaXplKHRydW5jYXRpb24udG90YWxCeXRlcyl9KV1gO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogZmluYWxUZXh0IH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IHtcblx0XHRcdFx0XHRcdHNlcnZlcjogcGFyYW1zLnNlcnZlcixcblx0XHRcdFx0XHRcdHRvb2w6IHBhcmFtcy50b29sLFxuXHRcdFx0XHRcdFx0Y2hhckNvdW50OiBmaW5hbFRleHQubGVuZ3RoLFxuXHRcdFx0XHRcdFx0dHJ1bmNhdGVkOiB0cnVuY2F0aW9uLnRydW5jYXRlZCxcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHR9O1xuXHRcdFx0fSBjYXRjaCAoZXJyOiB1bmtub3duKSB7XG5cdFx0XHRcdGNvbnN0IG1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKGBNQ1AgY2FsbCBmYWlsZWQ6ICR7cGFyYW1zLnNlcnZlcn0uJHtwYXJhbXMudG9vbH1cXG4ke21zZ31gKTtcblx0XHRcdH1cblx0XHR9LFxuXG5cdFx0cmVuZGVyQ2FsbChhcmdzLCB0aGVtZSkge1xuXHRcdFx0bGV0IHRleHQgPSB0aGVtZS5mZyhcInRvb2xUaXRsZVwiLCB0aGVtZS5ib2xkKFwibWNwX2NhbGwgXCIpKTtcblx0XHRcdHRleHQgKz0gdGhlbWUuZmcoXCJhY2NlbnRcIiwgYCR7YXJncy5zZXJ2ZXJ9LiR7YXJncy50b29sfWApO1xuXHRcdFx0aWYgKGFyZ3MuYXJncyAmJiBPYmplY3Qua2V5cyhhcmdzLmFyZ3MpLmxlbmd0aCA+IDApIHtcblx0XHRcdFx0Y29uc3QgcHJldmlldyA9IE9iamVjdC5lbnRyaWVzKGFyZ3MuYXJncylcblx0XHRcdFx0XHQuc2xpY2UoMCwgMylcblx0XHRcdFx0XHQubWFwKChbaywgdl0pID0+IHtcblx0XHRcdFx0XHRcdGNvbnN0IHZhbCA9IHR5cGVvZiB2ID09PSBcInN0cmluZ1wiID8gdiA6IEpTT04uc3RyaW5naWZ5KHYpO1xuXHRcdFx0XHRcdFx0cmV0dXJuIGAke2t9OiR7dmFsLmxlbmd0aCA+IDMwID8gdmFsLnNsaWNlKDAsIDMwKSArIFwiXHUyMDI2XCIgOiB2YWx9YDtcblx0XHRcdFx0XHR9KVxuXHRcdFx0XHRcdC5qb2luKFwiIFwiKTtcblx0XHRcdFx0dGV4dCArPSBcIiBcIiArIHRoZW1lLmZnKFwibXV0ZWRcIiwgcHJldmlldyk7XG5cdFx0XHR9XG5cdFx0XHRyZXR1cm4gbmV3IFRleHQodGV4dCwgMCwgMCk7XG5cdFx0fSxcblxuXHRcdHJlbmRlclJlc3VsdChyZXN1bHQsIHsgaXNQYXJ0aWFsLCBleHBhbmRlZCB9LCB0aGVtZSkge1xuXHRcdFx0aWYgKGlzUGFydGlhbCkgcmV0dXJuIG5ldyBUZXh0KHRoZW1lLmZnKFwid2FybmluZ1wiLCBcIkNhbGxpbmcgTUNQIHRvb2wuLi5cIiksIDAsIDApO1xuXG5cdFx0XHRjb25zdCBkID0gcmVzdWx0LmRldGFpbHMgYXMge1xuXHRcdFx0XHRzZXJ2ZXI6IHN0cmluZztcblx0XHRcdFx0dG9vbDogc3RyaW5nO1xuXHRcdFx0XHRjaGFyQ291bnQ6IG51bWJlcjtcblx0XHRcdFx0dHJ1bmNhdGVkOiBib29sZWFuO1xuXHRcdFx0fSB8IHVuZGVmaW5lZDtcblxuXHRcdFx0bGV0IHRleHQgPSB0aGVtZS5mZyhcInN1Y2Nlc3NcIiwgYFx1MjcxMyAke2Q/LnNlcnZlcn0uJHtkPy50b29sfWApO1xuXHRcdFx0dGV4dCArPSB0aGVtZS5mZyhcImRpbVwiLCBgIFx1MDBCNyAkeyhkPy5jaGFyQ291bnQgPz8gMCkudG9Mb2NhbGVTdHJpbmcoKX0gY2hhcnNgKTtcblx0XHRcdGlmIChkPy50cnVuY2F0ZWQpIHRleHQgKz0gdGhlbWUuZmcoXCJ3YXJuaW5nXCIsIFwiIFx1MDBCNyB0cnVuY2F0ZWRcIik7XG5cblx0XHRcdGlmIChleHBhbmRlZCkge1xuXHRcdFx0XHRjb25zdCBjb250ZW50ID0gcmVzdWx0LmNvbnRlbnRbMF07XG5cdFx0XHRcdGlmIChjb250ZW50Py50eXBlID09PSBcInRleHRcIikge1xuXHRcdFx0XHRcdGNvbnN0IHByZXZpZXcgPSBjb250ZW50LnRleHQuc3BsaXQoXCJcXG5cIikuc2xpY2UoMCwgMTUpLmpvaW4oXCJcXG5cIik7XG5cdFx0XHRcdFx0dGV4dCArPSBcIlxcblxcblwiICsgdGhlbWUuZmcoXCJkaW1cIiwgcHJldmlldyk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0cmV0dXJuIG5ldyBUZXh0KHRleHQsIDAsIDApO1xuXHRcdH0sXG5cdH0pO1xuXG5cdC8vIFx1MjUwMFx1MjUwMCBMaWZlY3ljbGUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cblx0cGkub24oXCJzZXNzaW9uX3NodXRkb3duXCIsIGFzeW5jICgpID0+IHtcblx0XHRhd2FpdCBjbG9zZUFsbCgpO1xuXHR9KTtcblxuXHRwaS5vbihcInNlc3Npb25fc3dpdGNoXCIsIGFzeW5jICgpID0+IHtcblx0XHRhd2FpdCBjbG9zZUFsbCgpO1xuXHRcdGNvbmZpZ0NhY2hlID0gbnVsbDtcblx0fSk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFlQTtBQUFBLEVBQ0M7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNNO0FBQ1AsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFDdkIsU0FBUyw0QkFBNEI7QUFDckMsU0FBUyxxQ0FBcUM7QUFDOUMsU0FBUyxjQUFjLGtCQUFrQjtBQUN6QyxTQUFTLFlBQVk7QUFDckIsU0FBUyw4QkFBOEI7QUFFdkMsU0FBUyxlQUFlO0FBZ0N4QixNQUFNLGNBQWMsb0JBQUksSUFBK0I7QUFDdkQsTUFBTSxxQkFBcUIsb0JBQUksSUFBNkI7QUFDNUQsSUFBSSxjQUF3QztBQUM1QyxNQUFNLFlBQVksb0JBQUksSUFBNkI7QUFDbkQsTUFBTSxzQkFBc0Isb0JBQUksSUFBWTtBQUU1QyxNQUFNLHNCQUFzQixvQkFBSSxJQUFJO0FBQUEsRUFDbkM7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7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QUFLLElBQUksRUFBRTtBQUN4RCxVQUFJLEtBQUssUUFBUSxPQUFPLEtBQUssS0FBSyxJQUFJLEVBQUUsU0FBUyxHQUFHO0FBQ25ELGNBQU0sVUFBVSxPQUFPLFFBQVEsS0FBSyxJQUFJLEVBQ3RDLE1BQU0sR0FBRyxDQUFDLEVBQ1YsSUFBSSxDQUFDLENBQUMsR0FBRyxDQUFDLE1BQU07QUFDaEIsZ0JBQU0sTUFBTSxPQUFPLE1BQU0sV0FBVyxJQUFJLEtBQUssVUFBVSxDQUFDO0FBQ3hELGlCQUFPLEdBQUcsQ0FBQyxJQUFJLElBQUksU0FBUyxLQUFLLElBQUksTUFBTSxHQUFHLEVBQUUsSUFBSSxXQUFNLEdBQUc7QUFBQSxRQUM5RCxDQUFDLEVBQ0EsS0FBSyxHQUFHO0FBQ1YsZ0JBQVEsTUFBTSxNQUFNLEdBQUcsU0FBUyxPQUFPO0FBQUEsTUFDeEM7QUFDQSxhQUFPLElBQUksS0FBSyxNQUFNLEdBQUcsQ0FBQztBQUFBLElBQzNCO0FBQUEsSUFFQSxhQUFhLFFBQVEsRUFBRSxXQUFXLFNBQVMsR0FBRyxPQUFPO0FBQ3BELFVBQUksVUFBVyxRQUFPLElBQUksS0FBSyxNQUFNLEdBQUcsV0FBVyxxQkFBcUIsR0FBRyxHQUFHLENBQUM7QUFFL0UsWUFBTSxJQUFJLE9BQU87QUFPakIsVUFBSSxPQUFPLE1BQU0sR0FBRyxXQUFXLFVBQUssR0FBRyxNQUFNLElBQUksR0FBRyxJQUFJLEVBQUU7QUFDMUQsY0FBUSxNQUFNLEdBQUcsT0FBTyxVQUFPLEdBQUcsYUFBYSxHQUFHLGVBQWUsQ0FBQyxRQUFRO0FBQzFFLFVBQUksR0FBRyxVQUFXLFNBQVEsTUFBTSxHQUFHLFdBQVcsaUJBQWM7QUFFNUQsVUFBSSxVQUFVO0FBQ2IsY0FBTSxVQUFVLE9BQU8sUUFBUSxDQUFDO0FBQ2hDLFlBQUksU0FBUyxTQUFTLFFBQVE7QUFDN0IsZ0JBQU0sVUFBVSxRQUFRLEtBQUssTUFBTSxJQUFJLEVBQUUsTUFBTSxHQUFHLEVBQUUsRUFBRSxLQUFLLElBQUk7QUFDL0Qsa0JBQVEsU0FBUyxNQUFNLEdBQUcsT0FBTyxPQUFPO0FBQUEsUUFDekM7QUFBQSxNQUNEO0FBRUEsYUFBTyxJQUFJLEtBQUssTUFBTSxHQUFHLENBQUM7QUFBQSxJQUMzQjtBQUFBLEVBQ0QsQ0FBQztBQUlELEtBQUcsR0FBRyxvQkFBb0IsWUFBWTtBQUNyQyxVQUFNLFNBQVM7QUFBQSxFQUNoQixDQUFDO0FBRUQsS0FBRyxHQUFHLGtCQUFrQixZQUFZO0FBQ25DLFVBQU0sU0FBUztBQUNmLGtCQUFjO0FBQUEsRUFDZixDQUFDO0FBQ0Y7IiwKICAibmFtZXMiOiBbInRleHQiLCAidHJ1bmNhdGlvbiIsICJmaW5hbFRleHQiXQp9Cg==
