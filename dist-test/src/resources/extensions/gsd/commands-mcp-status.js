import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ensureProjectWorkflowMcpConfig } from "./mcp-project-config.js";
import { gsdHome } from "./gsd-home.js";
function formatMcpInitResult(status, configPath, targetPath) {
  const summary = status === "created" ? "Created project MCP config." : status === "updated" ? "Updated project MCP config." : "Project MCP config is already up to date.";
  return [
    summary,
    "",
    `Project: ${targetPath}`,
    `Config:   ${configPath}`,
    "",
    "Claude Code can now load the GSD workflow MCP server from this folder."
  ].join("\n");
}
function readMcpConfigs() {
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
        servers.push({
          name,
          transport,
          ...hasCommand && {
            command: config.command,
            args: Array.isArray(config.args) ? config.args : void 0
          },
          ...hasUrl && { url: config.url }
        });
      }
    } catch {
    }
  }
  return servers;
}
function formatMcpStatusReport(servers) {
  if (servers.length === 0) {
    return [
      "No MCP servers configured.",
      "",
      "Add servers to .mcp.json, .gsd/mcp.json, or $GSD_HOME/mcp.json (default: ~/.gsd/mcp.json) to enable MCP integrations.",
      "Tip: run /gsd mcp init . to write the local GSD workflow MCP config.",
      "See: https://modelcontextprotocol.io/quickstart"
    ].join("\n");
  }
  const lines = [`MCP Server Status \u2014 ${servers.length} server(s)
`];
  for (const s of servers) {
    const icon = s.error ? "\u2717" : s.connected ? "\u2713" : "\u25CB";
    const status = s.error ? `error: ${s.error}` : s.connected ? `connected \u2014 ${s.toolCount} tools` : "disconnected";
    lines.push(`  ${icon} ${s.name} (${s.transport}) \u2014 ${status}`);
  }
  lines.push("");
  lines.push("Use /gsd mcp check <server> for details on a specific server.");
  lines.push("Use mcp_discover to connect and list tools for a server.");
  return lines.join("\n");
}
function formatMcpServerDetail(server) {
  const lines = [`MCP Server: ${server.name}
`];
  lines.push(`  Transport: ${server.transport}`);
  if (server.error) {
    lines.push(`  Status:    error`);
    lines.push(`  Error:     ${server.error}`);
  } else if (server.connected) {
    lines.push(`  Status:    connected`);
    lines.push(`  Tools:     ${server.toolCount}`);
    if (server.tools.length > 0) {
      lines.push("");
      lines.push("  Available tools:");
      for (const tool of server.tools) {
        lines.push(`    - ${tool}`);
      }
    }
  } else {
    lines.push(`  Status:    disconnected`);
    lines.push("");
    lines.push(`  Run mcp_discover("${server.name}") to connect and list tools.`);
  }
  return lines.join("\n");
}
async function handleMcpStatus(args, ctx) {
  const trimmed = args.trim();
  const lowered = trimmed.toLowerCase();
  const configs = readMcpConfigs();
  if (!lowered || lowered === "status") {
  } else if (lowered === "init" || lowered.startsWith("init ")) {
    const rawPath = trimmed.slice("init".length).trim();
    const targetPath = resolve(rawPath || ".");
    try {
      const result = ensureProjectWorkflowMcpConfig(targetPath);
      ctx.ui.notify(formatMcpInitResult(result.status, result.configPath, targetPath), "info");
    } catch (err) {
      ctx.ui.notify(
        `Failed to prepare MCP config for ${targetPath}: ${err instanceof Error ? err.message : String(err)}`,
        "error"
      );
    }
    return;
  }
  if (lowered.startsWith("check ")) {
    const serverName = trimmed.slice("check ".length).trim();
    const config = configs.find((c) => c.name === serverName);
    if (!config) {
      const available = configs.map((c) => c.name).join(", ") || "(none)";
      ctx.ui.notify(
        `Unknown MCP server: "${serverName}"

Available: ${available}`,
        "warning"
      );
      return;
    }
    let connected = false;
    let toolNames = [];
    let error;
    try {
      const mcpClient = await import("../mcp-client/index.js");
      const mod = mcpClient;
      if (typeof mod.getConnectionStatus === "function") {
        const status = mod.getConnectionStatus(serverName);
        connected = status.connected;
        toolNames = status.tools;
        error = status.error;
      }
    } catch {
    }
    ctx.ui.notify(
      formatMcpServerDetail({
        name: config.name,
        transport: config.transport,
        connected,
        toolCount: toolNames.length,
        tools: toolNames,
        error
      }),
      "info"
    );
    return;
  }
  if (!lowered || lowered === "status") {
    const statuses = [];
    for (const config of configs) {
      let connected = false;
      let toolCount = 0;
      let error;
      try {
        const mcpClient = await import("../mcp-client/index.js");
        const mod = mcpClient;
        if (typeof mod.getConnectionStatus === "function") {
          const status = mod.getConnectionStatus(config.name);
          connected = status.connected;
          toolCount = status.tools.length;
          error = status.error;
        }
      } catch {
      }
      statuses.push({
        name: config.name,
        transport: config.transport,
        connected,
        toolCount,
        error
      });
    }
    ctx.ui.notify(formatMcpStatusReport(statuses), "info");
    return;
  }
  ctx.ui.notify(
    "Usage: /gsd mcp [status|check <server>|init [dir]]\n\n  status           Show all MCP server statuses (default)\n  check <server>   Detailed status for a specific server\n  init [dir]       Write .mcp.json for the local GSD workflow MCP server",
    "warning"
  );
}
export {
  formatMcpInitResult,
  formatMcpServerDetail,
  formatMcpStatusReport,
  handleMcpStatus
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9jb21tYW5kcy1tY3Atc3RhdHVzLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIE1DUCBTdGF0dXMgXHUyMDE0IGAvZ3NkIG1jcGAgY29tbWFuZCBoYW5kbGVyLlxuICpcbiAqIFNob3dzIGNvbmZpZ3VyZWQgTUNQIHNlcnZlcnMsIHRoZWlyIGNvbm5lY3Rpb24gc3RhdHVzLCBhbmQgYXZhaWxhYmxlIHRvb2xzLlxuICpcbiAqIFN1YmNvbW1hbmRzOlxuICogICAvZ3NkIG1jcCAgICAgICAgICAgICBcdTIwMTQgT3ZlcnZpZXcgb2YgYWxsIHNlcnZlcnMgKGFsaWFzOiAvZ3NkIG1jcCBzdGF0dXMpXG4gKiAgIC9nc2QgbWNwIHN0YXR1cyAgICAgIFx1MjAxNCBTYW1lIGFzIGJhcmUgL2dzZCBtY3BcbiAqICAgL2dzZCBtY3AgY2hlY2sgPHNydj4gXHUyMDE0IERldGFpbGVkIHN0YXR1cyBmb3IgYSBzcGVjaWZpYyBzZXJ2ZXJcbiAqICAgL2dzZCBtY3AgaW5pdCBbZGlyXSAgXHUyMDE0IFdyaXRlIHByb2plY3QtbG9jYWwgR1NEIHdvcmtmbG93IE1DUCBjb25maWdcbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0IH0gZnJvbSBcIkBnc2QvcGktY29kaW5nLWFnZW50XCI7XG5cbmltcG9ydCB7IGV4aXN0c1N5bmMsIHJlYWRGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luLCByZXNvbHZlIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuXG5pbXBvcnQgeyBlbnN1cmVQcm9qZWN0V29ya2Zsb3dNY3BDb25maWcgfSBmcm9tIFwiLi9tY3AtcHJvamVjdC1jb25maWcuanNcIjtcbmltcG9ydCB7IGdzZEhvbWUgfSBmcm9tIFwiLi9nc2QtaG9tZS5qc1wiO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVHlwZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBpbnRlcmZhY2UgTWNwU2VydmVyU3RhdHVzIHtcbiAgbmFtZTogc3RyaW5nO1xuICB0cmFuc3BvcnQ6IFwic3RkaW9cIiB8IFwiaHR0cFwiIHwgXCJ1bmtub3duXCI7XG4gIGNvbm5lY3RlZDogYm9vbGVhbjtcbiAgdG9vbENvdW50OiBudW1iZXI7XG4gIGVycm9yOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgTWNwU2VydmVyRGV0YWlsIGV4dGVuZHMgTWNwU2VydmVyU3RhdHVzIHtcbiAgdG9vbHM6IHN0cmluZ1tdO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0TWNwSW5pdFJlc3VsdChcbiAgc3RhdHVzOiBcImNyZWF0ZWRcIiB8IFwidXBkYXRlZFwiIHwgXCJ1bmNoYW5nZWRcIixcbiAgY29uZmlnUGF0aDogc3RyaW5nLFxuICB0YXJnZXRQYXRoOiBzdHJpbmcsXG4pOiBzdHJpbmcge1xuICBjb25zdCBzdW1tYXJ5ID1cbiAgICBzdGF0dXMgPT09IFwiY3JlYXRlZFwiXG4gICAgICA/IFwiQ3JlYXRlZCBwcm9qZWN0IE1DUCBjb25maWcuXCJcbiAgICAgIDogc3RhdHVzID09PSBcInVwZGF0ZWRcIlxuICAgICAgICA/IFwiVXBkYXRlZCBwcm9qZWN0IE1DUCBjb25maWcuXCJcbiAgICAgICAgOiBcIlByb2plY3QgTUNQIGNvbmZpZyBpcyBhbHJlYWR5IHVwIHRvIGRhdGUuXCI7XG5cbiAgcmV0dXJuIFtcbiAgICBzdW1tYXJ5LFxuICAgIFwiXCIsXG4gICAgYFByb2plY3Q6ICR7dGFyZ2V0UGF0aH1gLFxuICAgIGBDb25maWc6ICAgJHtjb25maWdQYXRofWAsXG4gICAgXCJcIixcbiAgICBcIkNsYXVkZSBDb2RlIGNhbiBub3cgbG9hZCB0aGUgR1NEIHdvcmtmbG93IE1DUCBzZXJ2ZXIgZnJvbSB0aGlzIGZvbGRlci5cIixcbiAgXS5qb2luKFwiXFxuXCIpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQ29uZmlnIHJlYWRlciAoc3RhbmRhbG9uZSBcdTIwMTQgZG9lcyBub3QgaW1wb3J0IG1jcC1jbGllbnQgaW50ZXJuYWxzKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuaW50ZXJmYWNlIE1jcFNlcnZlclJhd0NvbmZpZyB7XG4gIG5hbWU6IHN0cmluZztcbiAgdHJhbnNwb3J0OiBcInN0ZGlvXCIgfCBcImh0dHBcIiB8IFwidW5rbm93blwiO1xuICBjb21tYW5kPzogc3RyaW5nO1xuICBhcmdzPzogc3RyaW5nW107XG4gIHVybD86IHN0cmluZztcbn1cblxuZnVuY3Rpb24gcmVhZE1jcENvbmZpZ3MoKTogTWNwU2VydmVyUmF3Q29uZmlnW10ge1xuICBjb25zdCBzZXJ2ZXJzOiBNY3BTZXJ2ZXJSYXdDb25maWdbXSA9IFtdO1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IGNvbmZpZ1BhdGhzID0gW1xuICAgIGpvaW4ocHJvY2Vzcy5jd2QoKSwgXCIubWNwLmpzb25cIiksXG4gICAgam9pbihwcm9jZXNzLmN3ZCgpLCBcIi5nc2RcIiwgXCJtY3AuanNvblwiKSxcbiAgICBqb2luKGdzZEhvbWUoKSwgXCJtY3AuanNvblwiKSxcbiAgXTtcblxuICBmb3IgKGNvbnN0IGNvbmZpZ1BhdGggb2YgY29uZmlnUGF0aHMpIHtcbiAgICB0cnkge1xuICAgICAgaWYgKCFleGlzdHNTeW5jKGNvbmZpZ1BhdGgpKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IHJhdyA9IHJlYWRGaWxlU3luYyhjb25maWdQYXRoLCBcInV0Zi04XCIpO1xuICAgICAgY29uc3QgZGF0YSA9IEpTT04ucGFyc2UocmF3KSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgIGNvbnN0IG1jcFNlcnZlcnMgPSAoZGF0YS5tY3BTZXJ2ZXJzID8/IGRhdGEuc2VydmVycykgYXNcbiAgICAgICAgfCBSZWNvcmQ8c3RyaW5nLCBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj5cbiAgICAgICAgfCB1bmRlZmluZWQ7XG4gICAgICBpZiAoIW1jcFNlcnZlcnMgfHwgdHlwZW9mIG1jcFNlcnZlcnMgIT09IFwib2JqZWN0XCIpIGNvbnRpbnVlO1xuXG4gICAgICBmb3IgKGNvbnN0IFtuYW1lLCBjb25maWddIG9mIE9iamVjdC5lbnRyaWVzKG1jcFNlcnZlcnMpKSB7XG4gICAgICAgIGlmIChzZWVuLmhhcyhuYW1lKSkgY29udGludWU7XG4gICAgICAgIHNlZW4uYWRkKG5hbWUpO1xuXG4gICAgICAgIGNvbnN0IGhhc0NvbW1hbmQgPSB0eXBlb2YgY29uZmlnLmNvbW1hbmQgPT09IFwic3RyaW5nXCI7XG4gICAgICAgIGNvbnN0IGhhc1VybCA9IHR5cGVvZiBjb25maWcudXJsID09PSBcInN0cmluZ1wiO1xuICAgICAgICBjb25zdCB0cmFuc3BvcnQ6IE1jcFNlcnZlclJhd0NvbmZpZ1tcInRyYW5zcG9ydFwiXSA9IGhhc0NvbW1hbmRcbiAgICAgICAgICA/IFwic3RkaW9cIlxuICAgICAgICAgIDogaGFzVXJsXG4gICAgICAgICAgICA/IFwiaHR0cFwiXG4gICAgICAgICAgICA6IFwidW5rbm93blwiO1xuXG4gICAgICAgIHNlcnZlcnMucHVzaCh7XG4gICAgICAgICAgbmFtZSxcbiAgICAgICAgICB0cmFuc3BvcnQsXG4gICAgICAgICAgLi4uKGhhc0NvbW1hbmQgJiYge1xuICAgICAgICAgICAgY29tbWFuZDogY29uZmlnLmNvbW1hbmQgYXMgc3RyaW5nLFxuICAgICAgICAgICAgYXJnczogQXJyYXkuaXNBcnJheShjb25maWcuYXJncykgPyAoY29uZmlnLmFyZ3MgYXMgc3RyaW5nW10pIDogdW5kZWZpbmVkLFxuICAgICAgICAgIH0pLFxuICAgICAgICAgIC4uLihoYXNVcmwgJiYgeyB1cmw6IGNvbmZpZy51cmwgYXMgc3RyaW5nIH0pLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIE5vbi1mYXRhbCBcdTIwMTQgY29uZmlnIGZpbGUgbWF5IG5vdCBleGlzdCBvciBiZSBtYWxmb3JtZWRcbiAgICB9XG4gIH1cblxuICByZXR1cm4gc2VydmVycztcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEZvcm1hdHRlcnMgKGV4cG9ydGVkIGZvciB0ZXN0aW5nKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdE1jcFN0YXR1c1JlcG9ydChzZXJ2ZXJzOiBNY3BTZXJ2ZXJTdGF0dXNbXSk6IHN0cmluZyB7XG4gIGlmIChzZXJ2ZXJzLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiBbXG4gICAgICBcIk5vIE1DUCBzZXJ2ZXJzIGNvbmZpZ3VyZWQuXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCJBZGQgc2VydmVycyB0byAubWNwLmpzb24sIC5nc2QvbWNwLmpzb24sIG9yICRHU0RfSE9NRS9tY3AuanNvbiAoZGVmYXVsdDogfi8uZ3NkL21jcC5qc29uKSB0byBlbmFibGUgTUNQIGludGVncmF0aW9ucy5cIixcbiAgICAgIFwiVGlwOiBydW4gL2dzZCBtY3AgaW5pdCAuIHRvIHdyaXRlIHRoZSBsb2NhbCBHU0Qgd29ya2Zsb3cgTUNQIGNvbmZpZy5cIixcbiAgICAgIFwiU2VlOiBodHRwczovL21vZGVsY29udGV4dHByb3RvY29sLmlvL3F1aWNrc3RhcnRcIixcbiAgICBdLmpvaW4oXCJcXG5cIik7XG4gIH1cblxuICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbYE1DUCBTZXJ2ZXIgU3RhdHVzIFx1MjAxNCAke3NlcnZlcnMubGVuZ3RofSBzZXJ2ZXIocylcXG5gXTtcblxuICBmb3IgKGNvbnN0IHMgb2Ygc2VydmVycykge1xuICAgIGNvbnN0IGljb24gPSBzLmVycm9yID8gXCJcdTI3MTdcIiA6IHMuY29ubmVjdGVkID8gXCJcdTI3MTNcIiA6IFwiXHUyNUNCXCI7XG4gICAgY29uc3Qgc3RhdHVzID0gcy5lcnJvclxuICAgICAgPyBgZXJyb3I6ICR7cy5lcnJvcn1gXG4gICAgICA6IHMuY29ubmVjdGVkXG4gICAgICAgID8gYGNvbm5lY3RlZCBcdTIwMTQgJHtzLnRvb2xDb3VudH0gdG9vbHNgXG4gICAgICAgIDogXCJkaXNjb25uZWN0ZWRcIjtcbiAgICBsaW5lcy5wdXNoKGAgICR7aWNvbn0gJHtzLm5hbWV9ICgke3MudHJhbnNwb3J0fSkgXHUyMDE0ICR7c3RhdHVzfWApO1xuICB9XG5cbiAgbGluZXMucHVzaChcIlwiKTtcbiAgbGluZXMucHVzaChcIlVzZSAvZ3NkIG1jcCBjaGVjayA8c2VydmVyPiBmb3IgZGV0YWlscyBvbiBhIHNwZWNpZmljIHNlcnZlci5cIik7XG4gIGxpbmVzLnB1c2goXCJVc2UgbWNwX2Rpc2NvdmVyIHRvIGNvbm5lY3QgYW5kIGxpc3QgdG9vbHMgZm9yIGEgc2VydmVyLlwiKTtcblxuICByZXR1cm4gbGluZXMuam9pbihcIlxcblwiKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdE1jcFNlcnZlckRldGFpbChzZXJ2ZXI6IE1jcFNlcnZlckRldGFpbCk6IHN0cmluZyB7XG4gIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtgTUNQIFNlcnZlcjogJHtzZXJ2ZXIubmFtZX1cXG5gXTtcblxuICBsaW5lcy5wdXNoKGAgIFRyYW5zcG9ydDogJHtzZXJ2ZXIudHJhbnNwb3J0fWApO1xuXG4gIGlmIChzZXJ2ZXIuZXJyb3IpIHtcbiAgICBsaW5lcy5wdXNoKGAgIFN0YXR1czogICAgZXJyb3JgKTtcbiAgICBsaW5lcy5wdXNoKGAgIEVycm9yOiAgICAgJHtzZXJ2ZXIuZXJyb3J9YCk7XG4gIH0gZWxzZSBpZiAoc2VydmVyLmNvbm5lY3RlZCkge1xuICAgIGxpbmVzLnB1c2goYCAgU3RhdHVzOiAgICBjb25uZWN0ZWRgKTtcbiAgICBsaW5lcy5wdXNoKGAgIFRvb2xzOiAgICAgJHtzZXJ2ZXIudG9vbENvdW50fWApO1xuICAgIGlmIChzZXJ2ZXIudG9vbHMubGVuZ3RoID4gMCkge1xuICAgICAgbGluZXMucHVzaChcIlwiKTtcbiAgICAgIGxpbmVzLnB1c2goXCIgIEF2YWlsYWJsZSB0b29sczpcIik7XG4gICAgICBmb3IgKGNvbnN0IHRvb2wgb2Ygc2VydmVyLnRvb2xzKSB7XG4gICAgICAgIGxpbmVzLnB1c2goYCAgICAtICR7dG9vbH1gKTtcbiAgICAgIH1cbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgbGluZXMucHVzaChgICBTdGF0dXM6ICAgIGRpc2Nvbm5lY3RlZGApO1xuICAgIGxpbmVzLnB1c2goXCJcIik7XG4gICAgbGluZXMucHVzaChgICBSdW4gbWNwX2Rpc2NvdmVyKFwiJHtzZXJ2ZXIubmFtZX1cIikgdG8gY29ubmVjdCBhbmQgbGlzdCB0b29scy5gKTtcbiAgfVxuXG4gIHJldHVybiBsaW5lcy5qb2luKFwiXFxuXCIpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQ29tbWFuZCBoYW5kbGVyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIEhhbmRsZSBgL2dzZCBtY3AgW3N0YXR1c3xjaGVjayA8c2VydmVyPl1gLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlTWNwU3RhdHVzKFxuICBhcmdzOiBzdHJpbmcsXG4gIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgdHJpbW1lZCA9IGFyZ3MudHJpbSgpO1xuICBjb25zdCBsb3dlcmVkID0gdHJpbW1lZC50b0xvd2VyQ2FzZSgpO1xuICBjb25zdCBjb25maWdzID0gcmVhZE1jcENvbmZpZ3MoKTtcblxuICAvLyAvZ3NkIG1jcCBpbml0IFtkaXJdXG4gIGlmICghbG93ZXJlZCB8fCBsb3dlcmVkID09PSBcInN0YXR1c1wiKSB7XG4gICAgLy8gaGFuZGxlZCBiZWxvd1xuICB9IGVsc2UgaWYgKGxvd2VyZWQgPT09IFwiaW5pdFwiIHx8IGxvd2VyZWQuc3RhcnRzV2l0aChcImluaXQgXCIpKSB7XG4gICAgY29uc3QgcmF3UGF0aCA9IHRyaW1tZWQuc2xpY2UoXCJpbml0XCIubGVuZ3RoKS50cmltKCk7XG4gICAgY29uc3QgdGFyZ2V0UGF0aCA9IHJlc29sdmUocmF3UGF0aCB8fCBcIi5cIik7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGVuc3VyZVByb2plY3RXb3JrZmxvd01jcENvbmZpZyh0YXJnZXRQYXRoKTtcbiAgICAgIGN0eC51aS5ub3RpZnkoZm9ybWF0TWNwSW5pdFJlc3VsdChyZXN1bHQuc3RhdHVzLCByZXN1bHQuY29uZmlnUGF0aCwgdGFyZ2V0UGF0aCksIFwiaW5mb1wiKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgIGBGYWlsZWQgdG8gcHJlcGFyZSBNQ1AgY29uZmlnIGZvciAke3RhcmdldFBhdGh9OiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gLFxuICAgICAgICBcImVycm9yXCIsXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm47XG4gIH1cblxuICAvLyAvZ3NkIG1jcCBjaGVjayA8c2VydmVyPlxuICBpZiAobG93ZXJlZC5zdGFydHNXaXRoKFwiY2hlY2sgXCIpKSB7XG4gICAgY29uc3Qgc2VydmVyTmFtZSA9IHRyaW1tZWQuc2xpY2UoXCJjaGVjayBcIi5sZW5ndGgpLnRyaW0oKTtcbiAgICBjb25zdCBjb25maWcgPSBjb25maWdzLmZpbmQoKGMpID0+IGMubmFtZSA9PT0gc2VydmVyTmFtZSk7XG4gICAgaWYgKCFjb25maWcpIHtcbiAgICAgIGNvbnN0IGF2YWlsYWJsZSA9IGNvbmZpZ3MubWFwKChjKSA9PiBjLm5hbWUpLmpvaW4oXCIsIFwiKSB8fCBcIihub25lKVwiO1xuICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgYFVua25vd24gTUNQIHNlcnZlcjogXCIke3NlcnZlck5hbWV9XCJcXG5cXG5BdmFpbGFibGU6ICR7YXZhaWxhYmxlfWAsXG4gICAgICAgIFwid2FybmluZ1wiLFxuICAgICAgKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBUcnkgdG8gZ2V0IGNvbm5lY3Rpb24vdG9vbCBpbmZvIGZyb20gdGhlIG1jcC1jbGllbnQgbW9kdWxlIGlmIGF2YWlsYWJsZVxuICAgIGxldCBjb25uZWN0ZWQgPSBmYWxzZTtcbiAgICBsZXQgdG9vbE5hbWVzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGxldCBlcnJvcjogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBtY3BDbGllbnQgPSBhd2FpdCBpbXBvcnQoXCIuLi9tY3AtY2xpZW50L2luZGV4LmpzXCIpO1xuICAgICAgLy8gQWNjZXNzIHRoZSBtb2R1bGUncyBjb25uZWN0aW9uIHN0YXRlIGlmIGV4cG9ydGVkOyBmYWxsIGJhY2sgZ3JhY2VmdWxseVxuICAgICAgY29uc3QgbW9kID0gbWNwQ2xpZW50IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgaWYgKHR5cGVvZiBtb2QuZ2V0Q29ubmVjdGlvblN0YXR1cyA9PT0gXCJmdW5jdGlvblwiKSB7XG4gICAgICAgIGNvbnN0IHN0YXR1cyA9IChtb2QuZ2V0Q29ubmVjdGlvblN0YXR1cyBhcyAobmFtZTogc3RyaW5nKSA9PiB7IGNvbm5lY3RlZDogYm9vbGVhbjsgdG9vbHM6IHN0cmluZ1tdOyBlcnJvcj86IHN0cmluZyB9KShzZXJ2ZXJOYW1lKTtcbiAgICAgICAgY29ubmVjdGVkID0gc3RhdHVzLmNvbm5lY3RlZDtcbiAgICAgICAgdG9vbE5hbWVzID0gc3RhdHVzLnRvb2xzO1xuICAgICAgICBlcnJvciA9IHN0YXR1cy5lcnJvcjtcbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIG1jcC1jbGllbnQgbWF5IG5vdCBleHBvc2Ugc3RhdHVzIGhlbHBlcnMgXHUyMDE0IHRoYXQncyBmaW5lXG4gICAgfVxuXG4gICAgY3R4LnVpLm5vdGlmeShcbiAgICAgIGZvcm1hdE1jcFNlcnZlckRldGFpbCh7XG4gICAgICAgIG5hbWU6IGNvbmZpZy5uYW1lLFxuICAgICAgICB0cmFuc3BvcnQ6IGNvbmZpZy50cmFuc3BvcnQsXG4gICAgICAgIGNvbm5lY3RlZCxcbiAgICAgICAgdG9vbENvdW50OiB0b29sTmFtZXMubGVuZ3RoLFxuICAgICAgICB0b29sczogdG9vbE5hbWVzLFxuICAgICAgICBlcnJvcixcbiAgICAgIH0pLFxuICAgICAgXCJpbmZvXCIsXG4gICAgKTtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyAvZ3NkIG1jcCBvciAvZ3NkIG1jcCBzdGF0dXNcbiAgaWYgKCFsb3dlcmVkIHx8IGxvd2VyZWQgPT09IFwic3RhdHVzXCIpIHtcbiAgICAvLyBCdWlsZCBzdGF0dXMgZm9yIGVhY2ggc2VydmVyXG4gICAgY29uc3Qgc3RhdHVzZXM6IE1jcFNlcnZlclN0YXR1c1tdID0gW107XG5cbiAgICBmb3IgKGNvbnN0IGNvbmZpZyBvZiBjb25maWdzKSB7XG4gICAgICBsZXQgY29ubmVjdGVkID0gZmFsc2U7XG4gICAgICBsZXQgdG9vbENvdW50ID0gMDtcbiAgICAgIGxldCBlcnJvcjogc3RyaW5nIHwgdW5kZWZpbmVkO1xuXG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBtY3BDbGllbnQgPSBhd2FpdCBpbXBvcnQoXCIuLi9tY3AtY2xpZW50L2luZGV4LmpzXCIpO1xuICAgICAgICBjb25zdCBtb2QgPSBtY3BDbGllbnQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICAgIGlmICh0eXBlb2YgbW9kLmdldENvbm5lY3Rpb25TdGF0dXMgPT09IFwiZnVuY3Rpb25cIikge1xuICAgICAgICAgIGNvbnN0IHN0YXR1cyA9IChtb2QuZ2V0Q29ubmVjdGlvblN0YXR1cyBhcyAobmFtZTogc3RyaW5nKSA9PiB7IGNvbm5lY3RlZDogYm9vbGVhbjsgdG9vbHM6IHN0cmluZ1tdOyBlcnJvcj86IHN0cmluZyB9KShjb25maWcubmFtZSk7XG4gICAgICAgICAgY29ubmVjdGVkID0gc3RhdHVzLmNvbm5lY3RlZDtcbiAgICAgICAgICB0b29sQ291bnQgPSBzdGF0dXMudG9vbHMubGVuZ3RoO1xuICAgICAgICAgIGVycm9yID0gc3RhdHVzLmVycm9yO1xuICAgICAgICB9XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLy8gRmFsbCBiYWNrIHRvIHVua25vd24gc3RhdGVcbiAgICAgIH1cblxuICAgICAgc3RhdHVzZXMucHVzaCh7XG4gICAgICAgIG5hbWU6IGNvbmZpZy5uYW1lLFxuICAgICAgICB0cmFuc3BvcnQ6IGNvbmZpZy50cmFuc3BvcnQsXG4gICAgICAgIGNvbm5lY3RlZCxcbiAgICAgICAgdG9vbENvdW50LFxuICAgICAgICBlcnJvcixcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGN0eC51aS5ub3RpZnkoZm9ybWF0TWNwU3RhdHVzUmVwb3J0KHN0YXR1c2VzKSwgXCJpbmZvXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFVua25vd24gc3ViY29tbWFuZFxuICBjdHgudWkubm90aWZ5KFxuICAgIFwiVXNhZ2U6IC9nc2QgbWNwIFtzdGF0dXN8Y2hlY2sgPHNlcnZlcj58aW5pdCBbZGlyXV1cXG5cXG5cIiArXG4gICAgXCIgIHN0YXR1cyAgICAgICAgICAgU2hvdyBhbGwgTUNQIHNlcnZlciBzdGF0dXNlcyAoZGVmYXVsdClcXG5cIiArXG4gICAgXCIgIGNoZWNrIDxzZXJ2ZXI+ICAgRGV0YWlsZWQgc3RhdHVzIGZvciBhIHNwZWNpZmljIHNlcnZlclxcblwiICtcbiAgICBcIiAgaW5pdCBbZGlyXSAgICAgICBXcml0ZSAubWNwLmpzb24gZm9yIHRoZSBsb2NhbCBHU0Qgd29ya2Zsb3cgTUNQIHNlcnZlclwiLFxuICAgIFwid2FybmluZ1wiLFxuICApO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBY0EsU0FBUyxZQUFZLG9CQUFvQjtBQUN6QyxTQUFTLE1BQU0sZUFBZTtBQUU5QixTQUFTLHNDQUFzQztBQUMvQyxTQUFTLGVBQWU7QUFnQmpCLFNBQVMsb0JBQ2QsUUFDQSxZQUNBLFlBQ1E7QUFDUixRQUFNLFVBQ0osV0FBVyxZQUNQLGdDQUNBLFdBQVcsWUFDVCxnQ0FDQTtB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
