import { attachJsonlLineReader } from "@gsd/pi-coding-agent";
const _c = {
  reset: "\x1B[0m",
  bold: "\x1B[1m",
  dim: "\x1B[2m",
  italic: "\x1B[3m",
  red: "\x1B[31m",
  green: "\x1B[32m",
  yellow: "\x1B[33m",
  cyan: "\x1B[36m",
  gray: "\x1B[90m"
};
function noColor() {
  const nc = {};
  for (const k of Object.keys(_c)) nc[k] = "";
  return nc;
}
const colorsDisabled = !!process.env["NO_COLOR"] || !process.stderr.isTTY;
const c = colorsDisabled ? noColor() : _c;
function summarizeToolArgs(toolName, toolInput) {
  const name = String(toolName ?? "");
  const input = toolInput && typeof toolInput === "object" ? toolInput : {};
  const filePath = () => shortPath(input.path ?? input.file_path) || "";
  switch (name) {
    case "Read":
    case "read":
      return filePath();
    case "Write":
    case "write":
      return filePath();
    case "Edit":
    case "edit":
      return filePath();
    case "hashline_edit":
      return filePath();
    case "Bash":
    case "bash": {
      const cmd = String(input.command ?? "");
      return cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd;
    }
    case "async_bash": {
      const cmd = String(input.command ?? "");
      return cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd;
    }
    case "await_job": {
      const jobs = input.jobs;
      if (Array.isArray(jobs) && jobs.length > 0) return jobs.join(", ");
      return "";
    }
    case "cancel_job":
      return String(input.job_id ?? "");
    case "Glob":
    case "glob":
      return String(input.pattern ?? "");
    case "find": {
      const pat = String(input.pattern ?? "");
      const p = shortPath(input.path);
      return p ? `${pat} in ${p}` : pat;
    }
    case "Grep":
    case "grep":
    case "Search":
    case "search": {
      const pat = String(input.pattern ?? "");
      const g = input.glob ? ` ${input.glob}` : "";
      return `${pat}${g}`;
    }
    case "ls":
      return shortPath(input.path) || "";
    case "lsp": {
      const action = String(input.action ?? "");
      const file = shortPath(input.file);
      const sym = input.symbol ? ` ${input.symbol}` : "";
      return file ? `${action} ${file}${sym}` : action;
    }
    case "Task":
    case "task": {
      const desc = String(input.description ?? input.prompt ?? "");
      return desc.length > 60 ? desc.slice(0, 57) + "..." : desc;
    }
    case "subagent": {
      const agent = String(input.agent ?? "");
      const t = String(input.task ?? "");
      const summary = t.length > 50 ? t.slice(0, 47) + "..." : t;
      return agent ? `${agent}: ${summary}` : summary;
    }
    case "browser_navigate":
      return String(input.url ?? "");
    default: {
      if (name.startsWith("gsd_")) {
        return summarizeGsdTool(name, input);
      }
      for (const v of Object.values(input)) {
        if (typeof v === "string" && v.length > 0) {
          return v.length > 60 ? v.slice(0, 57) + "..." : v;
        }
      }
      return "";
    }
  }
}
function summarizeGsdTool(name, input) {
  const parts = [];
  if (input.milestoneId) parts.push(String(input.milestoneId));
  if (input.sliceId) parts.push(String(input.sliceId));
  if (input.taskId) parts.push(String(input.taskId));
  if (parts.length > 0) {
    const id = parts.join("/");
    if (name.includes("complete") && typeof input.oneLiner === "string") {
      const ol = input.oneLiner.length > 50 ? input.oneLiner.slice(0, 47) + "..." : input.oneLiner;
      return `${id} ${ol}`;
    }
    return id;
  }
  if (input.decision) {
    const d = String(input.decision);
    return d.length > 60 ? d.slice(0, 57) + "..." : d;
  }
  return "";
}
function shortPath(p) {
  if (typeof p !== "string") return "";
  const cwd = process.cwd();
  if (p.startsWith(cwd + "/")) return p.slice(cwd.length + 1);
  return p.replace(/^\/Users\/[^/]+\/Developer\//, "");
}
function formatDuration(ms) {
  if (ms < 1e3) return `${ms}ms`;
  const s = (ms / 1e3).toFixed(1);
  return `${s}s`;
}
function handleExtensionUIRequest(event, client) {
  const { id, method } = event;
  switch (method) {
    case "select": {
      const title = String(event.title ?? "");
      let selected = event.options?.[0] ?? "";
      if (title.includes("Auto-mode is running") && event.options) {
        const forceOption = event.options.find((o) => o.toLowerCase().includes("force start"));
        if (forceOption) selected = forceOption;
      }
      client.sendUIResponse(id, { value: selected });
      break;
    }
    case "confirm":
      client.sendUIResponse(id, { confirmed: true });
      break;
    case "input":
      client.sendUIResponse(id, { value: "" });
      break;
    case "editor":
      client.sendUIResponse(id, { value: event.prefill ?? "" });
      break;
    case "notify":
    case "setStatus":
    case "setWidget":
    case "setTitle":
    case "set_editor_text":
      client.sendUIResponse(id, { value: "" });
      break;
    default:
      process.stderr.write(`[headless] Warning: unknown extension_ui_request method "${method}", cancelling
`);
      client.sendUIResponse(id, { cancelled: true });
      break;
  }
}
function formatProgress(event, ctx) {
  const type = String(event.type ?? "");
  if (ctx.thinkingPreview) {
  }
  switch (type) {
    case "tool_execution_start": {
      if (!ctx.verbose) return null;
      const name = String(event.toolName ?? "unknown");
      const args = summarizeToolArgs(event.toolName, event.args);
      const argStr = args ? ` ${c.dim}${args}${c.reset}` : "";
      return `  ${c.dim}[tool]${c.reset}    ${name}${argStr}`;
    }
    case "tool_execution_end": {
      if (!ctx.verbose) return null;
      const name = String(event.toolName ?? "unknown");
      const durationStr = ctx.toolDuration != null ? ` ${c.dim}${formatDuration(ctx.toolDuration)}${c.reset}` : "";
      if (ctx.isError) {
        return `  ${c.red}[tool]    ${name} error${c.reset}${durationStr}`;
      }
      return `  ${c.dim}[tool]    ${name} done${c.reset}${durationStr}`;
    }
    case "agent_start":
      return `${c.dim}[agent]   Session started${c.reset}`;
    case "agent_end": {
      let line = `${c.dim}[agent]   Session ended${c.reset}`;
      if (ctx.lastCost) {
        const cost = `$${ctx.lastCost.costUsd.toFixed(4)}`;
        const tokens = `${ctx.lastCost.inputTokens + ctx.lastCost.outputTokens} tokens`;
        line += ` ${c.dim}(${cost}, ${tokens})${c.reset}`;
      }
      return line;
    }
    case "extension_ui_request": {
      const method = String(event.method ?? "");
      if (method === "notify") {
        const msg = String(event.message ?? "");
        if (!msg) return null;
        const isImportant = /^(committed:|verification gate:|milestone|blocked:)/i.test(msg);
        return isImportant ? `${c.bold}[gsd]     ${msg}${c.reset}` : `[gsd]     ${msg}`;
      }
      if (method === "setStatus") {
        const statusKey = String(event.statusKey ?? "");
        const msg = String(event.message ?? "");
        if (!statusKey && !msg) return null;
        if (statusKey) {
          const label = parsePhaseLabel(statusKey, msg);
          if (label) return `${c.cyan}[phase]   ${label}${c.reset}`;
        }
        if (msg) return `${c.cyan}[phase]   ${msg}${c.reset}`;
        return null;
      }
      return null;
    }
    default:
      return null;
  }
}
function formatThinkingLine(text) {
  const trimmed = text.replace(/\s+/g, " ").trim();
  const truncated = trimmed.length > 120 ? trimmed.slice(0, 117) + "..." : trimmed;
  return `${c.dim}${c.italic}[thinking] ${truncated}${c.reset}`;
}
function formatTextStart() {
  return `${c.dim}[text]${c.reset}`;
}
function formatTextEnd() {
  return "";
}
function formatThinkingStart() {
  return `${c.dim}${c.italic}[thinking]${c.reset}`;
}
function formatThinkingEnd() {
  return "";
}
function formatCostLine(costUsd, inputTokens, outputTokens) {
  return `${c.dim}[cost]    $${costUsd.toFixed(4)} (${inputTokens + outputTokens} tokens)${c.reset}`;
}
function parsePhaseLabel(statusKey, message) {
  const parts = statusKey.split(":");
  if (parts.length >= 2) {
    const [kind, value] = parts;
    switch (kind.toLowerCase()) {
      case "milestone":
        return `Milestone ${value}${message ? " -- " + message : ""}`;
      case "slice":
        return `Slice ${value}${message ? " -- " + message : ""}`;
      case "task":
        return `Task ${value}${message ? " -- " + message : ""}`;
      case "phase":
        return `Phase: ${value}${message ? " -- " + message : ""}`;
      default:
        return `${kind}: ${value}${message ? " -- " + message : ""}`;
    }
  }
  if (message) return `${statusKey}: ${message}`;
  return statusKey || null;
}
function startSupervisedStdinReader(client, onResponse) {
  return attachJsonlLineReader(process.stdin, (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stderr.write(`[headless] Warning: invalid JSON from orchestrator stdin, skipping
`);
      return;
    }
    const type = String(msg.type ?? "");
    switch (type) {
      case "extension_ui_response": {
        const id = String(msg.id ?? "");
        const value = msg.value !== void 0 ? String(msg.value) : void 0;
        const confirmed = typeof msg.confirmed === "boolean" ? msg.confirmed : void 0;
        const cancelled = typeof msg.cancelled === "boolean" ? msg.cancelled : void 0;
        client.sendUIResponse(id, { value, confirmed, cancelled });
        if (id) {
          onResponse(id);
        }
        break;
      }
      case "prompt":
        client.prompt(String(msg.message ?? ""));
        break;
      case "steer":
        client.steer(String(msg.message ?? ""));
        break;
      case "follow_up":
        client.followUp(String(msg.message ?? ""));
        break;
      default:
        process.stderr.write(`[headless] Warning: unknown message type "${type}" from orchestrator stdin
`);
        break;
    }
  });
}
export {
  formatCostLine,
  formatProgress,
  formatTextEnd,
  formatTextStart,
  formatThinkingEnd,
  formatThinkingLine,
  formatThinkingStart,
  handleExtensionUIRequest,
  startSupervisedStdinReader,
  summarizeToolArgs
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL2hlYWRsZXNzLXVpLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIEhlYWRsZXNzIFVJIEhhbmRsaW5nIFx1MjAxNCBhdXRvLXJlc3BvbnNlLCBwcm9ncmVzcyBmb3JtYXR0aW5nLCBhbmQgc3VwZXJ2aXNlZCBzdGRpblxuICpcbiAqIEhhbmRsZXMgZXh0ZW5zaW9uIFVJIHJlcXVlc3RzIChhdXRvLXJlc3BvbmRpbmcgaW4gaGVhZGxlc3MgbW9kZSksXG4gKiBmb3JtYXRzIHByb2dyZXNzIGV2ZW50cyBmb3Igc3RkZXJyIG91dHB1dCwgYW5kIHJlYWRzIG9yY2hlc3RyYXRvclxuICogY29tbWFuZHMgZnJvbSBzdGRpbiBpbiBzdXBlcnZpc2VkIG1vZGUuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBSZWFkYWJsZSB9IGZyb20gJ25vZGU6c3RyZWFtJ1xuXG5pbXBvcnQgeyBScGNDbGllbnQsIGF0dGFjaEpzb25sTGluZVJlYWRlciB9IGZyb20gJ0Bnc2QvcGktY29kaW5nLWFnZW50J1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFR5cGVzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuaW50ZXJmYWNlIEV4dGVuc2lvblVJUmVxdWVzdCB7XG4gIHR5cGU6ICdleHRlbnNpb25fdWlfcmVxdWVzdCdcbiAgaWQ6IHN0cmluZ1xuICBtZXRob2Q6IHN0cmluZ1xuICB0aXRsZT86IHN0cmluZ1xuICBvcHRpb25zPzogc3RyaW5nW11cbiAgbWVzc2FnZT86IHN0cmluZ1xuICBwcmVmaWxsPzogc3RyaW5nXG4gIHRpbWVvdXQ/OiBudW1iZXJcbiAgW2tleTogc3RyaW5nXTogdW5rbm93blxufVxuXG5leHBvcnQgdHlwZSB7IEV4dGVuc2lvblVJUmVxdWVzdCB9XG5cbi8qKiBDb250ZXh0IHBhc3NlZCBhbG9uZ3NpZGUgYW4gZXZlbnQgZm9yIHJpY2hlciBmb3JtYXR0aW5nLiAqL1xuZXhwb3J0IGludGVyZmFjZSBQcm9ncmVzc0NvbnRleHQge1xuICB2ZXJib3NlOiBib29sZWFuXG4gIHRvb2xEdXJhdGlvbj86IG51bWJlciAgICAgICAgICAgLy8gbXMsIGZvciB0b29sX2V4ZWN1dGlvbl9lbmRcbiAgbGFzdENvc3Q/OiB7IGNvc3RVc2Q6IG51bWJlcjsgaW5wdXRUb2tlbnM6IG51bWJlcjsgb3V0cHV0VG9rZW5zOiBudW1iZXIgfVxuICB0aGlua2luZ1ByZXZpZXc/OiBzdHJpbmcgICAgICAgIC8vIGFjY3VtdWxhdGVkIExMTSB0ZXh0IHRvIHNob3cgYmVmb3JlIHRvb2wgY2FsbHNcbiAgaXNFcnJvcj86IGJvb2xlYW4gICAgICAgICAgICAgICAvLyB0b29sIGV4ZWN1dGlvbiBlbmRlZCB3aXRoIGFuIGVycm9yXG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gQU5TSSBDb2xvciBIZWxwZXJzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuY29uc3QgX2MgPSB7XG4gIHJlc2V0OiAnXFx4MWJbMG0nLFxuICBib2xkOiAnXFx4MWJbMW0nLFxuICBkaW06ICdcXHgxYlsybScsXG4gIGl0YWxpYzogJ1xceDFiWzNtJyxcbiAgcmVkOiAnXFx4MWJbMzFtJyxcbiAgZ3JlZW46ICdcXHgxYlszMm0nLFxuICB5ZWxsb3c6ICdcXHgxYlszM20nLFxuICBjeWFuOiAnXFx4MWJbMzZtJyxcbiAgZ3JheTogJ1xceDFiWzkwbScsXG59XG5cbi8qKiBCdWlsZCBhIG5vLW9wIGNvbG9yIG1hcCAoYWxsIGNvZGVzIGVtcHR5KS4gKi9cbmZ1bmN0aW9uIG5vQ29sb3IoKTogdHlwZW9mIF9jIHtcbiAgY29uc3QgbmM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fVxuICBmb3IgKGNvbnN0IGsgb2YgT2JqZWN0LmtleXMoX2MpKSBuY1trXSA9ICcnXG4gIHJldHVybiBuYyBhcyB0eXBlb2YgX2Ncbn1cblxuY29uc3QgY29sb3JzRGlzYWJsZWQgPSAhIXByb2Nlc3MuZW52WydOT19DT0xPUiddIHx8ICFwcm9jZXNzLnN0ZGVyci5pc1RUWVxuY29uc3QgYzogdHlwZW9mIF9jID0gY29sb3JzRGlzYWJsZWQgPyBub0NvbG9yKCkgOiBfY1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFRvb2wtQXJnIFN1bW1hcml6ZXJcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKipcbiAqIFByb2R1Y2UgYSBzaG9ydCBodW1hbi1yZWFkYWJsZSBzdW1tYXJ5IG9mIHRvb2wgYXJndW1lbnRzLlxuICogUmV0dXJucyBhIHN0cmluZyBsaWtlIFwicGF0aC90by9maWxlLnRzXCIgb3IgXCJncmVwIHBhdHRlcm4gKi50c1wiIFx1MjAxNCBuZXZlciB0aGVcbiAqIGZ1bGwgSlNPTiBibG9iLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3VtbWFyaXplVG9vbEFyZ3ModG9vbE5hbWU6IHVua25vd24sIHRvb2xJbnB1dDogdW5rbm93bik6IHN0cmluZyB7XG4gIGNvbnN0IG5hbWUgPSBTdHJpbmcodG9vbE5hbWUgPz8gJycpXG4gIGNvbnN0IGlucHV0ID0gKHRvb2xJbnB1dCAmJiB0eXBlb2YgdG9vbElucHV0ID09PSAnb2JqZWN0JykgPyB0b29sSW5wdXQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gOiB7fVxuXG4gIC8vIEhlbHBlcjogZXh0cmFjdCBmaWxlIHBhdGggZnJvbSBlaXRoZXIgJ3BhdGgnIG9yICdmaWxlX3BhdGgnICh0b29scyB1c2UgYm90aClcbiAgY29uc3QgZmlsZVBhdGggPSAoKTogc3RyaW5nID0+IHNob3J0UGF0aChpbnB1dC5wYXRoID8/IGlucHV0LmZpbGVfcGF0aCkgfHwgJydcblxuICBzd2l0Y2ggKG5hbWUpIHtcbiAgICBjYXNlICdSZWFkJzpcbiAgICBjYXNlICdyZWFkJzpcbiAgICAgIHJldHVybiBmaWxlUGF0aCgpXG4gICAgY2FzZSAnV3JpdGUnOlxuICAgIGNhc2UgJ3dyaXRlJzpcbiAgICAgIHJldHVybiBmaWxlUGF0aCgpXG4gICAgY2FzZSAnRWRpdCc6XG4gICAgY2FzZSAnZWRpdCc6XG4gICAgICByZXR1cm4gZmlsZVBhdGgoKVxuICAgIGNhc2UgJ2hhc2hsaW5lX2VkaXQnOlxuICAgICAgcmV0dXJuIGZpbGVQYXRoKClcbiAgICBjYXNlICdCYXNoJzpcbiAgICBjYXNlICdiYXNoJzoge1xuICAgICAgY29uc3QgY21kID0gU3RyaW5nKGlucHV0LmNvbW1hbmQgPz8gJycpXG4gICAgICByZXR1cm4gY21kLmxlbmd0aCA+IDgwID8gY21kLnNsaWNlKDAsIDc3KSArICcuLi4nIDogY21kXG4gICAgfVxuICAgIGNhc2UgJ2FzeW5jX2Jhc2gnOiB7XG4gICAgICBjb25zdCBjbWQgPSBTdHJpbmcoaW5wdXQuY29tbWFuZCA/PyAnJylcbiAgICAgIHJldHVybiBjbWQubGVuZ3RoID4gODAgPyBjbWQuc2xpY2UoMCwgNzcpICsgJy4uLicgOiBjbWRcbiAgICB9XG4gICAgY2FzZSAnYXdhaXRfam9iJzoge1xuICAgICAgY29uc3Qgam9icyA9IGlucHV0LmpvYnNcbiAgICAgIGlmIChBcnJheS5pc0FycmF5KGpvYnMpICYmIGpvYnMubGVuZ3RoID4gMCkgcmV0dXJuIGpvYnMuam9pbignLCAnKVxuICAgICAgcmV0dXJuICcnXG4gICAgfVxuICAgIGNhc2UgJ2NhbmNlbF9qb2InOlxuICAgICAgcmV0dXJuIFN0cmluZyhpbnB1dC5qb2JfaWQgPz8gJycpXG4gICAgY2FzZSAnR2xvYic6XG4gICAgY2FzZSAnZ2xvYic6XG4gICAgICByZXR1cm4gU3RyaW5nKGlucHV0LnBhdHRlcm4gPz8gJycpXG4gICAgY2FzZSAnZmluZCc6IHtcbiAgICAgIGNvbnN0IHBhdCA9IFN0cmluZyhpbnB1dC5wYXR0ZXJuID8/ICcnKVxuICAgICAgY29uc3QgcCA9IHNob3J0UGF0aChpbnB1dC5wYXRoKVxuICAgICAgcmV0dXJuIHAgPyBgJHtwYXR9IGluICR7cH1gIDogcGF0XG4gICAgfVxuICAgIGNhc2UgJ0dyZXAnOlxuICAgIGNhc2UgJ2dyZXAnOlxuICAgIGNhc2UgJ1NlYXJjaCc6XG4gICAgY2FzZSAnc2VhcmNoJzoge1xuICAgICAgY29uc3QgcGF0ID0gU3RyaW5nKGlucHV0LnBhdHRlcm4gPz8gJycpXG4gICAgICBjb25zdCBnID0gaW5wdXQuZ2xvYiA/IGAgJHtpbnB1dC5nbG9ifWAgOiAnJ1xuICAgICAgcmV0dXJuIGAke3BhdH0ke2d9YFxuICAgIH1cbiAgICBjYXNlICdscyc6XG4gICAgICByZXR1cm4gc2hvcnRQYXRoKGlucHV0LnBhdGgpIHx8ICcnXG4gICAgY2FzZSAnbHNwJzoge1xuICAgICAgY29uc3QgYWN0aW9uID0gU3RyaW5nKGlucHV0LmFjdGlvbiA/PyAnJylcbiAgICAgIGNvbnN0IGZpbGUgPSBzaG9ydFBhdGgoaW5wdXQuZmlsZSlcbiAgICAgIGNvbnN0IHN5bSA9IGlucHV0LnN5bWJvbCA/IGAgJHtpbnB1dC5zeW1ib2x9YCA6ICcnXG4gICAgICByZXR1cm4gZmlsZSA/IGAke2FjdGlvbn0gJHtmaWxlfSR7c3ltfWAgOiBhY3Rpb25cbiAgICB9XG4gICAgY2FzZSAnVGFzayc6XG4gICAgY2FzZSAndGFzayc6IHtcbiAgICAgIGNvbnN0IGRlc2MgPSBTdHJpbmcoaW5wdXQuZGVzY3JpcHRpb24gPz8gaW5wdXQucHJvbXB0ID8/ICcnKVxuICAgICAgcmV0dXJuIGRlc2MubGVuZ3RoID4gNjAgPyBkZXNjLnNsaWNlKDAsIDU3KSArICcuLi4nIDogZGVzY1xuICAgIH1cbiAgICBjYXNlICdzdWJhZ2VudCc6IHtcbiAgICAgIGNvbnN0IGFnZW50ID0gU3RyaW5nKGlucHV0LmFnZW50ID8/ICcnKVxuICAgICAgY29uc3QgdCA9IFN0cmluZyhpbnB1dC50YXNrID8/ICcnKVxuICAgICAgY29uc3Qgc3VtbWFyeSA9IHQubGVuZ3RoID4gNTAgPyB0LnNsaWNlKDAsIDQ3KSArICcuLi4nIDogdFxuICAgICAgcmV0dXJuIGFnZW50ID8gYCR7YWdlbnR9OiAke3N1bW1hcnl9YCA6IHN1bW1hcnlcbiAgICB9XG4gICAgY2FzZSAnYnJvd3Nlcl9uYXZpZ2F0ZSc6XG4gICAgICByZXR1cm4gU3RyaW5nKGlucHV0LnVybCA/PyAnJylcbiAgICBkZWZhdWx0OiB7XG4gICAgICAvLyBHU0QgdG9vbHM6IHNob3cgbWlsZXN0b25lL3NsaWNlL3Rhc2sgSURzIHdoZW4gcHJlc2VudFxuICAgICAgaWYgKG5hbWUuc3RhcnRzV2l0aCgnZ3NkXycpKSB7XG4gICAgICAgIHJldHVybiBzdW1tYXJpemVHc2RUb29sKG5hbWUsIGlucHV0KVxuICAgICAgfVxuICAgICAgLy8gRmFsbGJhY2s6IHNob3cgZmlyc3Qgc3RyaW5nLXZhbHVlZCBrZXkgdXAgdG8gNjAgY2hhcnNcbiAgICAgIGZvciAoY29uc3QgdiBvZiBPYmplY3QudmFsdWVzKGlucHV0KSkge1xuICAgICAgICBpZiAodHlwZW9mIHYgPT09ICdzdHJpbmcnICYmIHYubGVuZ3RoID4gMCkge1xuICAgICAgICAgIHJldHVybiB2Lmxlbmd0aCA+IDYwID8gdi5zbGljZSgwLCA1NykgKyAnLi4uJyA6IHZcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmV0dXJuICcnXG4gICAgfVxuICB9XG59XG5cbi8qKiBTdW1tYXJpemUgR1NEIGV4dGVuc2lvbiB0b29sIGFyZ3MgaW50byBhIGNvbXBhY3QgaWRlbnRpZmllciBzdHJpbmcuICovXG5mdW5jdGlvbiBzdW1tYXJpemVHc2RUb29sKG5hbWU6IHN0cmluZywgaW5wdXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogc3RyaW5nIHtcbiAgY29uc3QgcGFydHM6IHN0cmluZ1tdID0gW11cbiAgaWYgKGlucHV0Lm1pbGVzdG9uZUlkKSBwYXJ0cy5wdXNoKFN0cmluZyhpbnB1dC5taWxlc3RvbmVJZCkpXG4gIGlmIChpbnB1dC5zbGljZUlkKSBwYXJ0cy5wdXNoKFN0cmluZyhpbnB1dC5zbGljZUlkKSlcbiAgaWYgKGlucHV0LnRhc2tJZCkgcGFydHMucHVzaChTdHJpbmcoaW5wdXQudGFza0lkKSlcbiAgaWYgKHBhcnRzLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCBpZCA9IHBhcnRzLmpvaW4oJy8nKVxuICAgIC8vIEZvciBjb21wbGV0aW9uIHRvb2xzLCBhZGQgdGhlIG9uZS1saW5lciBpZiBwcmVzZW50XG4gICAgaWYgKG5hbWUuaW5jbHVkZXMoJ2NvbXBsZXRlJykgJiYgdHlwZW9mIGlucHV0Lm9uZUxpbmVyID09PSAnc3RyaW5nJykge1xuICAgICAgY29uc3Qgb2wgPSBpbnB1dC5vbmVMaW5lci5sZW5ndGggPiA1MCA/IGlucHV0Lm9uZUxpbmVyLnNsaWNlKDAsIDQ3KSArICcuLi4nIDogaW5wdXQub25lTGluZXJcbiAgICAgIHJldHVybiBgJHtpZH0gJHtvbH1gXG4gICAgfVxuICAgIHJldHVybiBpZFxuICB9XG4gIC8vIEZhbGxiYWNrIGZvciBHU0QgdG9vbHMgd2l0aG91dCBJRHMgKGUuZy4gZ3NkX2RlY2lzaW9uX3NhdmUpXG4gIGlmIChpbnB1dC5kZWNpc2lvbikge1xuICAgIGNvbnN0IGQgPSBTdHJpbmcoaW5wdXQuZGVjaXNpb24pXG4gICAgcmV0dXJuIGQubGVuZ3RoID4gNjAgPyBkLnNsaWNlKDAsIDU3KSArICcuLi4nIDogZFxuICB9XG4gIHJldHVybiAnJ1xufVxuXG5mdW5jdGlvbiBzaG9ydFBhdGgocDogdW5rbm93bik6IHN0cmluZyB7XG4gIGlmICh0eXBlb2YgcCAhPT0gJ3N0cmluZycpIHJldHVybiAnJ1xuICAvLyBTdHJpcCBjb21tb24gQ1dEIHByZWZpeCB0byBzYXZlIHNwYWNlXG4gIGNvbnN0IGN3ZCA9IHByb2Nlc3MuY3dkKClcbiAgaWYgKHAuc3RhcnRzV2l0aChjd2QgKyAnLycpKSByZXR1cm4gcC5zbGljZShjd2QubGVuZ3RoICsgMSlcbiAgLy8gU3RyaXAgL1VzZXJzLyovRGV2ZWxvcGVyLyBwcmVmaXhcbiAgcmV0dXJuIHAucmVwbGFjZSgvXlxcL1VzZXJzXFwvW14vXStcXC9EZXZlbG9wZXJcXC8vLCAnJylcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBGb3JtYXQgRHVyYXRpb25cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5mdW5jdGlvbiBmb3JtYXREdXJhdGlvbihtczogbnVtYmVyKTogc3RyaW5nIHtcbiAgaWYgKG1zIDwgMTAwMCkgcmV0dXJuIGAke21zfW1zYFxuICBjb25zdCBzID0gKG1zIC8gMTAwMCkudG9GaXhlZCgxKVxuICByZXR1cm4gYCR7c31zYFxufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIEV4dGVuc2lvbiBVSSBBdXRvLVJlc3BvbmRlclxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmV4cG9ydCBmdW5jdGlvbiBoYW5kbGVFeHRlbnNpb25VSVJlcXVlc3QoXG4gIGV2ZW50OiBFeHRlbnNpb25VSVJlcXVlc3QsXG4gIGNsaWVudDogUnBjQ2xpZW50LFxuKTogdm9pZCB7XG4gIGNvbnN0IHsgaWQsIG1ldGhvZCB9ID0gZXZlbnRcblxuICBzd2l0Y2ggKG1ldGhvZCkge1xuICAgIGNhc2UgJ3NlbGVjdCc6IHtcbiAgICAgIC8vIExvY2stZ3VhcmQgcHJvbXB0cyBsaXN0IFwiVmlldyBzdGF0dXNcIiBmaXJzdCwgYnV0IGhlYWRsZXNzIG5lZWRzIFwiRm9yY2Ugc3RhcnRcIlxuICAgICAgLy8gdG8gcHJvY2VlZC4gRGV0ZWN0IGJ5IHRpdGxlIGFuZCBwaWNrIHRoZSBmb3JjZSBvcHRpb24uXG4gICAgICBjb25zdCB0aXRsZSA9IFN0cmluZyhldmVudC50aXRsZSA/PyAnJylcbiAgICAgIGxldCBzZWxlY3RlZCA9IGV2ZW50Lm9wdGlvbnM/LlswXSA/PyAnJ1xuICAgICAgaWYgKHRpdGxlLmluY2x1ZGVzKCdBdXRvLW1vZGUgaXMgcnVubmluZycpICYmIGV2ZW50Lm9wdGlvbnMpIHtcbiAgICAgICAgY29uc3QgZm9yY2VPcHRpb24gPSBldmVudC5vcHRpb25zLmZpbmQobyA9PiBvLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoJ2ZvcmNlIHN0YXJ0JykpXG4gICAgICAgIGlmIChmb3JjZU9wdGlvbikgc2VsZWN0ZWQgPSBmb3JjZU9wdGlvblxuICAgICAgfVxuICAgICAgY2xpZW50LnNlbmRVSVJlc3BvbnNlKGlkLCB7IHZhbHVlOiBzZWxlY3RlZCB9KVxuICAgICAgYnJlYWtcbiAgICB9XG4gICAgY2FzZSAnY29uZmlybSc6XG4gICAgICBjbGllbnQuc2VuZFVJUmVzcG9uc2UoaWQsIHsgY29uZmlybWVkOiB0cnVlIH0pXG4gICAgICBicmVha1xuICAgIGNhc2UgJ2lucHV0JzpcbiAgICAgIGNsaWVudC5zZW5kVUlSZXNwb25zZShpZCwgeyB2YWx1ZTogJycgfSlcbiAgICAgIGJyZWFrXG4gICAgY2FzZSAnZWRpdG9yJzpcbiAgICAgIGNsaWVudC5zZW5kVUlSZXNwb25zZShpZCwgeyB2YWx1ZTogZXZlbnQucHJlZmlsbCA/PyAnJyB9KVxuICAgICAgYnJlYWtcbiAgICBjYXNlICdub3RpZnknOlxuICAgIGNhc2UgJ3NldFN0YXR1cyc6XG4gICAgY2FzZSAnc2V0V2lkZ2V0JzpcbiAgICBjYXNlICdzZXRUaXRsZSc6XG4gICAgY2FzZSAnc2V0X2VkaXRvcl90ZXh0JzpcbiAgICAgIGNsaWVudC5zZW5kVUlSZXNwb25zZShpZCwgeyB2YWx1ZTogJycgfSlcbiAgICAgIGJyZWFrXG4gICAgZGVmYXVsdDpcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBbaGVhZGxlc3NdIFdhcm5pbmc6IHVua25vd24gZXh0ZW5zaW9uX3VpX3JlcXVlc3QgbWV0aG9kIFwiJHttZXRob2R9XCIsIGNhbmNlbGxpbmdcXG5gKVxuICAgICAgY2xpZW50LnNlbmRVSVJlc3BvbnNlKGlkLCB7IGNhbmNlbGxlZDogdHJ1ZSB9KVxuICAgICAgYnJlYWtcbiAgfVxufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFByb2dyZXNzIEZvcm1hdHRlclxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXRQcm9ncmVzcyhldmVudDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sIGN0eDogUHJvZ3Jlc3NDb250ZXh0KTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IHR5cGUgPSBTdHJpbmcoZXZlbnQudHlwZSA/PyAnJylcblxuICAvLyBFbWl0IGFjY3VtdWxhdGVkIHRoaW5raW5nIHByZXZpZXcgYmVmb3JlIHRvb2wgY2FsbHNcbiAgaWYgKGN0eC50aGlua2luZ1ByZXZpZXcpIHtcbiAgICAvLyB0aGlua2luZ1ByZXZpZXcgaXMgaGFuZGxlZCBieSB0aGUgY2FsbGVyIGluIGhlYWRsZXNzLnRzIFx1MjAxNCBpdCBwcmVwZW5kc1xuICAgIC8vIHRoZSB0aGlua2luZyBsaW5lIGJlZm9yZSB0aGUgY3VycmVudCBldmVudCdzIGxpbmUuIFdlIHJldHVybiB0aGUgdGhpbmtpbmdcbiAgICAvLyBsaW5lIGFzIGEgcHJlZml4IGpvaW5lZCB3aXRoIG5ld2xpbmUuXG4gIH1cblxuICBzd2l0Y2ggKHR5cGUpIHtcbiAgICBjYXNlICd0b29sX2V4ZWN1dGlvbl9zdGFydCc6IHtcbiAgICAgIGlmICghY3R4LnZlcmJvc2UpIHJldHVybiBudWxsXG4gICAgICBjb25zdCBuYW1lID0gU3RyaW5nKGV2ZW50LnRvb2xOYW1lID8/ICd1bmtub3duJylcbiAgICAgIGNvbnN0IGFyZ3MgPSBzdW1tYXJpemVUb29sQXJncyhldmVudC50b29sTmFtZSwgZXZlbnQuYXJncylcbiAgICAgIGNvbnN0IGFyZ1N0ciA9IGFyZ3MgPyBgICR7Yy5kaW19JHthcmdzfSR7Yy5yZXNldH1gIDogJydcbiAgICAgIHJldHVybiBgICAke2MuZGltfVt0b29sXSR7Yy5yZXNldH0gICAgJHtuYW1lfSR7YXJnU3RyfWBcbiAgICB9XG5cbiAgICBjYXNlICd0b29sX2V4ZWN1dGlvbl9lbmQnOiB7XG4gICAgICBpZiAoIWN0eC52ZXJib3NlKSByZXR1cm4gbnVsbFxuICAgICAgY29uc3QgbmFtZSA9IFN0cmluZyhldmVudC50b29sTmFtZSA/PyAndW5rbm93bicpXG4gICAgICBjb25zdCBkdXJhdGlvblN0ciA9IGN0eC50b29sRHVyYXRpb24gIT0gbnVsbCA/IGAgJHtjLmRpbX0ke2Zvcm1hdER1cmF0aW9uKGN0eC50b29sRHVyYXRpb24pfSR7Yy5yZXNldH1gIDogJydcbiAgICAgIGlmIChjdHguaXNFcnJvcikge1xuICAgICAgICByZXR1cm4gYCAgJHtjLnJlZH1bdG9vbF0gICAgJHtuYW1lfSBlcnJvciR7Yy5yZXNldH0ke2R1cmF0aW9uU3RyfWBcbiAgICAgIH1cbiAgICAgIHJldHVybiBgICAke2MuZGltfVt0b29sXSAgICAke25hbWV9IGRvbmUke2MucmVzZXR9JHtkdXJhdGlvblN0cn1gXG4gICAgfVxuXG4gICAgY2FzZSAnYWdlbnRfc3RhcnQnOlxuICAgICAgcmV0dXJuIGAke2MuZGltfVthZ2VudF0gICBTZXNzaW9uIHN0YXJ0ZWQke2MucmVzZXR9YFxuXG4gICAgY2FzZSAnYWdlbnRfZW5kJzoge1xuICAgICAgbGV0IGxpbmUgPSBgJHtjLmRpbX1bYWdlbnRdICAgU2Vzc2lvbiBlbmRlZCR7Yy5yZXNldH1gXG4gICAgICBpZiAoY3R4Lmxhc3RDb3N0KSB7XG4gICAgICAgIGNvbnN0IGNvc3QgPSBgJCR7Y3R4Lmxhc3RDb3N0LmNvc3RVc2QudG9GaXhlZCg0KX1gXG4gICAgICAgIGNvbnN0IHRva2VucyA9IGAke2N0eC5sYXN0Q29zdC5pbnB1dFRva2VucyArIGN0eC5sYXN0Q29zdC5vdXRwdXRUb2tlbnN9IHRva2Vuc2BcbiAgICAgICAgbGluZSArPSBgICR7Yy5kaW19KCR7Y29zdH0sICR7dG9rZW5zfSkke2MucmVzZXR9YFxuICAgICAgfVxuICAgICAgcmV0dXJuIGxpbmVcbiAgICB9XG5cbiAgICBjYXNlICdleHRlbnNpb25fdWlfcmVxdWVzdCc6IHtcbiAgICAgIGNvbnN0IG1ldGhvZCA9IFN0cmluZyhldmVudC5tZXRob2QgPz8gJycpXG5cbiAgICAgIGlmIChtZXRob2QgPT09ICdub3RpZnknKSB7XG4gICAgICAgIGNvbnN0IG1zZyA9IFN0cmluZyhldmVudC5tZXNzYWdlID8/ICcnKVxuICAgICAgICBpZiAoIW1zZykgcmV0dXJuIG51bGxcbiAgICAgICAgLy8gQm9sZCBpbXBvcnRhbnQgbm90aWZpY2F0aW9uc1xuICAgICAgICBjb25zdCBpc0ltcG9ydGFudCA9IC9eKGNvbW1pdHRlZDp8dmVyaWZpY2F0aW9uIGdhdGU6fG1pbGVzdG9uZXxibG9ja2VkOikvaS50ZXN0KG1zZylcbiAgICAgICAgcmV0dXJuIGlzSW1wb3J0YW50XG4gICAgICAgICAgPyBgJHtjLmJvbGR9W2dzZF0gICAgICR7bXNnfSR7Yy5yZXNldH1gXG4gICAgICAgICAgOiBgW2dzZF0gICAgICR7bXNnfWBcbiAgICAgIH1cblxuICAgICAgaWYgKG1ldGhvZCA9PT0gJ3NldFN0YXR1cycpIHtcbiAgICAgICAgLy8gUGFyc2Ugc3RhdHVzS2V5IGZvciBwaGFzZSB0cmFuc2l0aW9uc1xuICAgICAgICBjb25zdCBzdGF0dXNLZXkgPSBTdHJpbmcoZXZlbnQuc3RhdHVzS2V5ID8/ICcnKVxuICAgICAgICBjb25zdCBtc2cgPSBTdHJpbmcoZXZlbnQubWVzc2FnZSA/PyAnJylcbiAgICAgICAgaWYgKCFzdGF0dXNLZXkgJiYgIW1zZykgcmV0dXJuIG51bGwgIC8vIHN1cHByZXNzIGVtcHR5IHN0YXR1cyBsaW5lc1xuICAgICAgICAvLyBTaG93IG1lYW5pbmdmdWwgcGhhc2UgdHJhbnNpdGlvbnNcbiAgICAgICAgaWYgKHN0YXR1c0tleSkge1xuICAgICAgICAgIGNvbnN0IGxhYmVsID0gcGFyc2VQaGFzZUxhYmVsKHN0YXR1c0tleSwgbXNnKVxuICAgICAgICAgIGlmIChsYWJlbCkgcmV0dXJuIGAke2MuY3lhbn1bcGhhc2VdICAgJHtsYWJlbH0ke2MucmVzZXR9YFxuICAgICAgICB9XG4gICAgICAgIC8vIEZhbGxiYWNrOiBzaG93IG1lc3NhZ2UgaWYgbm9uLWVtcHR5XG4gICAgICAgIGlmIChtc2cpIHJldHVybiBgJHtjLmN5YW59W3BoYXNlXSAgICR7bXNnfSR7Yy5yZXNldH1gXG4gICAgICAgIHJldHVybiBudWxsXG4gICAgICB9XG5cbiAgICAgIHJldHVybiBudWxsXG4gICAgfVxuXG4gICAgZGVmYXVsdDpcbiAgICAgIHJldHVybiBudWxsXG4gIH1cbn1cblxuLyoqXG4gKiBGb3JtYXQgYSB0aGlua2luZyBwcmV2aWV3IGxpbmUgZnJvbSBhY2N1bXVsYXRlZCBMTE0gdGV4dCBkZWx0YXMuXG4gKiBVc2VkIGFzIGEgZmFsbGJhY2sgd2hlbiBzdHJlYW1pbmcgaXMgbm90IGVuYWJsZWQgXHUyMDE0IHNob3dzIGEgdHJ1bmNhdGVkIG9uZS1saW5lci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdFRoaW5raW5nTGluZSh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCB0cmltbWVkID0gdGV4dC5yZXBsYWNlKC9cXHMrL2csICcgJykudHJpbSgpXG4gIGNvbnN0IHRydW5jYXRlZCA9IHRyaW1tZWQubGVuZ3RoID4gMTIwID8gdHJpbW1lZC5zbGljZSgwLCAxMTcpICsgJy4uLicgOiB0cmltbWVkXG4gIHJldHVybiBgJHtjLmRpbX0ke2MuaXRhbGljfVt0aGlua2luZ10gJHt0cnVuY2F0ZWR9JHtjLnJlc2V0fWBcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBTdHJlYW1pbmcgVGV4dCAvIFRoaW5raW5nIEZvcm1hdHRlcnNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKipcbiAqIEZvcm1hdCBhIHRleHRfc3RhcnQgbWFya2VyIFx1MjAxNCBwcmludGVkIG9uY2Ugd2hlbiB0aGUgYXNzaXN0YW50IGJlZ2lucyBhIHRleHQgYmxvY2suXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXRUZXh0U3RhcnQoKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke2MuZGltfVt0ZXh0XSR7Yy5yZXNldH1gXG59XG5cbi8qKlxuICogRm9ybWF0IGEgdGV4dF9lbmQgbWFya2VyIFx1MjAxNCBwcmludGVkIGFmdGVyIHRoZSBsYXN0IHRleHRfZGVsdGEuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXRUZXh0RW5kKCk6IHN0cmluZyB7XG4gIHJldHVybiAnJyAvLyBlbXB0eSBcdTIwMTQgbmV3bGluZSBoYW5kbGVkIGJ5IGNhbGxlclxufVxuXG4vKipcbiAqIEZvcm1hdCBhIHRoaW5raW5nX3N0YXJ0IG1hcmtlci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdFRoaW5raW5nU3RhcnQoKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke2MuZGltfSR7Yy5pdGFsaWN9W3RoaW5raW5nXSR7Yy5yZXNldH1gXG59XG5cbi8qKlxuICogRm9ybWF0IGEgdGhpbmtpbmdfZW5kIG1hcmtlci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdFRoaW5raW5nRW5kKCk6IHN0cmluZyB7XG4gIHJldHVybiAnJyAvLyBlbXB0eSBcdTIwMTQgbmV3bGluZSBoYW5kbGVkIGJ5IGNhbGxlclxufVxuXG4vKipcbiAqIEZvcm1hdCBhIGNvc3QgbGluZSAodXNlZCBmb3IgcGVyaW9kaWMgY29zdCB1cGRhdGVzIGluIHZlcmJvc2UgbW9kZSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXRDb3N0TGluZShjb3N0VXNkOiBudW1iZXIsIGlucHV0VG9rZW5zOiBudW1iZXIsIG91dHB1dFRva2VuczogbnVtYmVyKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke2MuZGltfVtjb3N0XSAgICAkJHtjb3N0VXNkLnRvRml4ZWQoNCl9ICgke2lucHV0VG9rZW5zICsgb3V0cHV0VG9rZW5zfSB0b2tlbnMpJHtjLnJlc2V0fWBcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBQaGFzZSBMYWJlbCBQYXJzZXJcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKipcbiAqIFBhcnNlIGEgc3RhdHVzS2V5IGludG8gYSBodW1hbi1yZWFkYWJsZSBwaGFzZSBsYWJlbC5cbiAqIHN0YXR1c0tleSBmb3JtYXQgdmFyaWVzIGJ1dCBjb21tb24gcGF0dGVybnM6XG4gKiAgIFwibWlsZXN0b25lOk0xXCIsIFwic2xpY2U6UzEuMVwiLCBcInRhc2s6VDEuMS4xXCIsIFwicGhhc2U6ZGlzY3Vzc1wiLCBldGMuXG4gKi9cbmZ1bmN0aW9uIHBhcnNlUGhhc2VMYWJlbChzdGF0dXNLZXk6IHN0cmluZywgbWVzc2FnZTogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gIC8vIERpcmVjdCBwaGFzZS9taWxlc3RvbmUvc2xpY2UvdGFzayBrZXlzXG4gIGNvbnN0IHBhcnRzID0gc3RhdHVzS2V5LnNwbGl0KCc6JylcbiAgaWYgKHBhcnRzLmxlbmd0aCA+PSAyKSB7XG4gICAgY29uc3QgW2tpbmQsIHZhbHVlXSA9IHBhcnRzXG4gICAgc3dpdGNoIChraW5kLnRvTG93ZXJDYXNlKCkpIHtcbiAgICAgIGNhc2UgJ21pbGVzdG9uZSc6XG4gICAgICAgIHJldHVybiBgTWlsZXN0b25lICR7dmFsdWV9JHttZXNzYWdlID8gJyAtLSAnICsgbWVzc2FnZSA6ICcnfWBcbiAgICAgIGNhc2UgJ3NsaWNlJzpcbiAgICAgICAgcmV0dXJuIGBTbGljZSAke3ZhbHVlfSR7bWVzc2FnZSA/ICcgLS0gJyArIG1lc3NhZ2UgOiAnJ31gXG4gICAgICBjYXNlICd0YXNrJzpcbiAgICAgICAgcmV0dXJuIGBUYXNrICR7dmFsdWV9JHttZXNzYWdlID8gJyAtLSAnICsgbWVzc2FnZSA6ICcnfWBcbiAgICAgIGNhc2UgJ3BoYXNlJzpcbiAgICAgICAgcmV0dXJuIGBQaGFzZTogJHt2YWx1ZX0ke21lc3NhZ2UgPyAnIC0tICcgKyBtZXNzYWdlIDogJyd9YFxuICAgICAgZGVmYXVsdDpcbiAgICAgICAgcmV0dXJuIGAke2tpbmR9OiAke3ZhbHVlfSR7bWVzc2FnZSA/ICcgLS0gJyArIG1lc3NhZ2UgOiAnJ31gXG4gICAgfVxuICB9XG5cbiAgLy8gU2luZ2xlLXdvcmQgc3RhdHVzIGtleXMgd2l0aCBhIG1lc3NhZ2VcbiAgaWYgKG1lc3NhZ2UpIHJldHVybiBgJHtzdGF0dXNLZXl9OiAke21lc3NhZ2V9YFxuICByZXR1cm4gc3RhdHVzS2V5IHx8IG51bGxcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBTdXBlcnZpc2VkIFN0ZGluIFJlYWRlclxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmV4cG9ydCBmdW5jdGlvbiBzdGFydFN1cGVydmlzZWRTdGRpblJlYWRlcihcbiAgY2xpZW50OiBScGNDbGllbnQsXG4gIG9uUmVzcG9uc2U6IChpZDogc3RyaW5nKSA9PiB2b2lkLFxuKTogKCkgPT4gdm9pZCB7XG4gIHJldHVybiBhdHRhY2hKc29ubExpbmVSZWFkZXIocHJvY2Vzcy5zdGRpbiBhcyBSZWFkYWJsZSwgKGxpbmUpID0+IHtcbiAgICBsZXQgbXNnOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPlxuICAgIHRyeSB7XG4gICAgICBtc2cgPSBKU09OLnBhcnNlKGxpbmUpXG4gICAgfSBjYXRjaCB7XG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgW2hlYWRsZXNzXSBXYXJuaW5nOiBpbnZhbGlkIEpTT04gZnJvbSBvcmNoZXN0cmF0b3Igc3RkaW4sIHNraXBwaW5nXFxuYClcbiAgICAgIHJldHVyblxuICAgIH1cblxuICAgIGNvbnN0IHR5cGUgPSBTdHJpbmcobXNnLnR5cGUgPz8gJycpXG5cbiAgICBzd2l0Y2ggKHR5cGUpIHtcbiAgICAgIGNhc2UgJ2V4dGVuc2lvbl91aV9yZXNwb25zZSc6IHtcbiAgICAgICAgY29uc3QgaWQgPSBTdHJpbmcobXNnLmlkID8/ICcnKVxuICAgICAgICBjb25zdCB2YWx1ZSA9IG1zZy52YWx1ZSAhPT0gdW5kZWZpbmVkID8gU3RyaW5nKG1zZy52YWx1ZSkgOiB1bmRlZmluZWRcbiAgICAgICAgY29uc3QgY29uZmlybWVkID0gdHlwZW9mIG1zZy5jb25maXJtZWQgPT09ICdib29sZWFuJyA/IG1zZy5jb25maXJtZWQgOiB1bmRlZmluZWRcbiAgICAgICAgY29uc3QgY2FuY2VsbGVkID0gdHlwZW9mIG1zZy5jYW5jZWxsZWQgPT09ICdib29sZWFuJyA/IG1zZy5jYW5jZWxsZWQgOiB1bmRlZmluZWRcbiAgICAgICAgY2xpZW50LnNlbmRVSVJlc3BvbnNlKGlkLCB7IHZhbHVlLCBjb25maXJtZWQsIGNhbmNlbGxlZCB9KVxuICAgICAgICBpZiAoaWQpIHtcbiAgICAgICAgICBvblJlc3BvbnNlKGlkKVxuICAgICAgICB9XG4gICAgICAgIGJyZWFrXG4gICAgICB9XG4gICAgICBjYXNlICdwcm9tcHQnOlxuICAgICAgICBjbGllbnQucHJvbXB0KFN0cmluZyhtc2cubWVzc2FnZSA/PyAnJykpXG4gICAgICAgIGJyZWFrXG4gICAgICBjYXNlICdzdGVlcic6XG4gICAgICAgIGNsaWVudC5zdGVlcihTdHJpbmcobXNnLm1lc3NhZ2UgPz8gJycpKVxuICAgICAgICBicmVha1xuICAgICAgY2FzZSAnZm9sbG93X3VwJzpcbiAgICAgICAgY2xpZW50LmZvbGxvd1VwKFN0cmluZyhtc2cubWVzc2FnZSA/PyAnJykpXG4gICAgICAgIGJyZWFrXG4gICAgICBkZWZhdWx0OlxuICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgW2hlYWRsZXNzXSBXYXJuaW5nOiB1bmtub3duIG1lc3NhZ2UgdHlwZSBcIiR7dHlwZX1cIiBmcm9tIG9yY2hlc3RyYXRvciBzdGRpblxcbmApXG4gICAgICAgIGJyZWFrXG4gICAgfVxuICB9KVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBVUEsU0FBb0IsNkJBQTZCO0FBaUNqRCxNQUFNLEtBQUs7QUFBQSxFQUNULE9BQU87QUFBQSxFQUNQLE1BQU07QUFBQSxFQUNOLEtBQUs7QUFBQSxFQUNMLFFBQVE7QUFBQSxFQUNSLEtBQUs7QUFBQSxFQUNMLE9BQU87QUFBQSxFQUNQLFFBQVE7QUFBQSxFQUNSLE1BQU07QUFBQSxFQUNOLE1BQU07QUFDUjtBQUdBLFNBQVMsVUFBcUI7QUFDNUIsUUFBTSxLQUE2QixDQUFDO0FBQ3BDLGFBQVcsS0FBSyxPQUFPLEtBQUssRUFBRSxFQUFHLElBQUcsQ0FBQyxJQUFJO0FBQ3pDLFNBQU87QUFDVDtBQUVBLE1BQU0saUJBQWlCLENBQUMsQ0FBQyxRQUFRLElBQUksVUFBVSxLQUFLLENBQUMsUUFBUSxPQUFPO0FBQ3BFLE1BQU0sSUFBZSxpQkFBaUIsUUFBUSxJQUFJO0FBVzNDLFNBQVMsa0JBQWtCLFVBQW1CLFdBQTRCO0FBQy9FLFFBQU0sT0FBTyxPQUFPLFlBQVksRUFBRTtBQUNsQyxRQUFNLFFBQVMsYUFBYSxPQUFPLGNBQWMsV0FBWSxZQUF1QyxDQUFDO0FBR3JHLFFBQU0sV0FBVyxNQUFjLFVBQVUsTUFBTSxRQUFRLE1BQU0sU0FBUyxLQUFLO0FBRTNFLFVBQVEsTUFBTTtBQUFBLElBQ1osS0FBSztBQUFBLElBQ0wsS0FBSztBQUNILGFBQU8sU0FBUztBQUFBLElBQ2xCLEtBQUs7QUFBQSxJQUNMLEtBQUs7QUFDSCxhQUFPLFNBQVM7QUFBQSxJQUNsQixLQUFLO0FBQUEsSUFDTCxLQUFLO0FBQ0gsYUFBTyxTQUFTO0FBQUEsSUFDbEIsS0FBSztBQUNILGFBQU8sU0FBUztBQUFBLElBQ2xCLEtBQUs7QUFBQSxJQUNMLEtBQUssUUFBUTtBQUNYLFlBQU0sTUFBTSxPQUFPLE1BQU0sV0FBVyxFQUFFO0FBQ3RDLGFBQU8sSUFBSSxTQUFTLEtBQUssSUFBSSxNQUFNLEdBQUcsRUFBRSxJQUFJLFFBQVE7QUFBQSxJQUN0RDtBQUFBLElBQ0EsS0FBSyxjQUFjO0FBQ2pCLFlBQU0sTUFBTSxPQUFPLE1BQU0sV0FBVyxFQUFFO0FBQ3RDLGFBQU8sSUFBSSxTQUFTLEtBQUssSUFBSSxNQUFNLEdBQUcsRUFBRSxJQUFJLFFBQVE7QUFBQSxJQUN0RDtBQUFBLElBQ0EsS0FBSyxhQUFhO0FBQ2hCLFlBQU0sT0FBTyxNQUFNO0FBQ25CLFVBQUksTUFBTSxRQUFRLElBQUksS0FBSyxLQUFLLFNBQVMsRUFBRyxRQUFPLEtBQUssS0FBSyxJQUFJO0FBQ2pFLGFBQU87QUFBQSxJQUNUO0FBQUEsSUFDQSxLQUFLO0FBQ0gsYUFBTyxPQUFPLE1BQU0sVUFBVSxFQUFFO0FBQUEsSUFDbEMsS0FBSztBQUFBLElBQ0wsS0FBSztBQUNILGFBQU8sT0FBTyxNQUFNLFdBQVcsRUFBRTtBQUFBLElBQ25DLEtBQUssUUFBUTtBQUNYLFlBQU0sTUFBTSxPQUFPLE1BQU0sV0FBVyxFQUFFO0FBQ3RDLFlBQU0sSUFBSSxVQUFVLE1BQU0sSUFBSTtBQUM5QixhQUFPLElBQUksR0FBRyxHQUFHLE9BQU8sQ0FBQyxLQUFLO0FBQUEsSUFDaEM7QUFBQSxJQUNBLEtBQUs7QUFBQSxJQUNMLEtBQUs7QUFBQSxJQUNMLEtBQUs7QUFBQSxJQUNMLEtBQUssVUFBVTtBQUNiLFlBQU0sTUFBTSxPQUFPLE1BQU0sV0FBVyxFQUFFO0FBQ3RDLFlBQU0sSUFBSSxNQUFNLE9BQU8sSUFBSSxNQUFNLElBQUksS0FBSztBQUMxQyxhQUFPLEdBQUcsR0FBRyxHQUFHLENBQUM7QUFBQSxJQUNuQjtBQUFBLElBQ0EsS0FBSztBQUNILGFBQU8sVUFBVSxNQUFNLElBQUksS0FBSztBQUFBLElBQ2xDLEtBQUssT0FBTztBQUNWLFlBQU0sU0FBUyxPQUFPLE1BQU0sVUFBVSxFQUFFO0FBQ3hDLFlBQU0sT0FBTyxVQUFVLE1BQU0sSUFBSTtBQUNqQyxZQUFNLE1BQU0sTUFBTSxTQUFTLElBQUksTUFBTSxNQUFNLEtBQUs7QUFDaEQsYUFBTyxPQUFPLEdBQUcsTUFBTSxJQUFJLElBQUksR0FBRyxHQUFHLEtBQUs7QUFBQSxJQUM1QztBQUFBLElBQ0EsS0FBSztBQUFBLElBQ0wsS0FBSyxRQUFRO0FBQ1gsWUFBTSxPQUFPLE9BQU8sTUFBTSxlQUFlLE1BQU0sVUFBVSxFQUFFO0FBQzNELGFBQU8sS0FBSyxTQUFTLEtBQUssS0FBSyxNQUFNLEdBQUcsRUFBRSxJQUFJLFFBQVE7QUFBQSxJQUN4RDtBQUFBLElBQ0EsS0FBSyxZQUFZO0FBQ2YsWUFBTSxRQUFRLE9BQU8sTUFBTSxTQUFTLEVBQUU7QUFDdEMsWUFBTSxJQUFJLE9BQU8sTUFBTSxRQUFRLEVBQUU7QUFDakMsWUFBTSxVQUFVLEVBQUUsU0FBUyxLQUFLLEVBQUUsTUFBTSxHQUFHLEVBQUUsSUFBSSxRQUFRO0FBQ3pELGFBQU8sUUFBUSxHQUFHLEtBQUssS0FBSyxPQUFPLEtBQUs7QUFBQSxJQUMxQztBQUFBLElBQ0EsS0FBSztBQUNILGFBQU8sT0FBTyxNQUFNLE9BQU8sRUFBRTtBQUFBLElBQy9CLFNBQVM7QUFFUCxVQUFJLEtBQUssV0FBVyxNQUFNLEdBQUc7QUFDM0IsZUFBTyxpQkFBaUIsTUFBTSxLQUFLO0FBQUEsTUFDckM7QUFFQSxpQkFBVyxLQUFLLE9BQU8sT0FBTyxLQUFLLEdBQUc7QUFDcEMsWUFBSSxPQUFPLE1BQU0sWUFBWSxFQUFFLFNBQVMsR0FBRztBQUN6QyxpQkFBTyxFQUFFLFNBQVMsS0FBSyxFQUFFLE1BQU0sR0FBRyxFQUFFLElBQUksUUFBUTtBQUFBLFFBQ2xEO0FBQUEsTUFDRjtBQUNBLGFBQU87QUFBQSxJQUNUO0FBQUEsRUFDRjtBQUNGO0FBR0EsU0FBUyxpQkFBaUIsTUFBYyxPQUF3QztBQUM5RSxRQUFNLFFBQWtCLENBQUM7QUFDekIsTUFBSSxNQUFNLFlBQWEsT0FBTSxLQUFLLE9BQU8sTUFBTSxXQUFXLENBQUM7QUFDM0QsTUFBSSxNQUFNLFFBQVMsT0FBTSxLQUFLLE9BQU8sTUFBTSxPQUFPLENBQUM7QUFDbkQsTUFBSSxNQUFNLE9BQVEsT0FBTSxLQUFLLE9BQU8sTUFBTSxNQUFNLENBQUM7QUFDakQsTUFBSSxNQUFNLFNBQVMsR0FBRztBQUNwQixVQUFNLEtBQUssTUFBTSxLQUFLLEdBQUc7QUFFekIsUUFBSSxLQUFLLFNBQVMsVUFBVSxLQUFLLE9BQU8sTUFBTSxhQUFhLFVBQVU7QUFDbkUsWUFBTSxLQUFLLE1BQU0sU0FBUyxTQUFTLEtBQUssTUFBTSxTQUFTLE1BQU0sR0FBRyxFQUFFLElBQUksUUFBUSxNQUFNO0FBQ3BGLGFBQU8sR0FBRyxFQUFFLElBQUksRUFBRTtBQUFBLElBQ3BCO0FBQ0EsV0FBTztBQUFBLEVBQ1Q7QUFFQSxNQUFJLE1BQU0sVUFBVTtBQUNsQixVQUFNLElBQUksT0FBTyxNQUFNLFFBQVE7QUFDL0IsV0FBTyxFQUFFLFNBQVMsS0FBSyxFQUFFLE1BQU0sR0FBRyxFQUFFLElBQUksUUFBUTtBQUFBLEVBQ2xEO0FBQ0EsU0FBTztBQUNUO0FBRUEsU0FBUyxVQUFVLEdBQW9CO0FBQ3JDLE1BQUksT0FBTyxNQUFNLFNBQVUsUUFBTztBQUVsQyxRQUFNLE1BQU0sUUFBUSxJQUFJO0FBQ3hCLE1BQUksRUFBRSxXQUFXLE1BQU0sR0FBRyxFQUFHLFFBQU8sRUFBRSxNQUFNLElBQUksU0FBUyxDQUFDO0FBRTFELFNBQU8sRUFBRSxRQUFRLGdDQUFnQyxFQUFFO0FBQ3JEO0FBTUEsU0FBUyxlQUFlLElBQW9CO0FBQzFDLE1BQUksS0FBSyxJQUFNLFFBQU8sR0FBRyxFQUFFO0FBQzNCLFFBQU0sS0FBSyxLQUFLLEtBQU0sUUFBUSxDQUFDO0FBQy9CLFNBQU8sR0FBRyxDQUFDO0FBQ2I7QUFNTyxTQUFTLHlCQUNkLE9BQ0EsUUFDTTtBQUNOLFFBQU0sRUFBRSxJQUFJLE9BQU8sSUFBSTtBQUV2QixVQUFRLFFBQVE7QUFBQSxJQUNkLEtBQUssVUFBVTtBQUdiLFlBQU0sUUFBUSxPQUFPLE1BQU0sU0FBUyxFQUFFO0FBQ3RDLFVBQUksV0FBVyxNQUFNLFVBQVUsQ0FBQyxLQUFLO0FBQ3JDLFVBQUksTUFBTSxTQUFTLHNCQUFzQixLQUFLLE1BQU0sU0FBUztBQUMzRCxjQUFNLGNBQWMsTUFBTSxRQUFRLEtBQUssT0FBSyxFQUFFLFlBQVksRUFBRSxTQUFTLGFBQWEsQ0FBQztBQUNuRixZQUFJLFlBQWEsWUFBVztBQUFBLE1BQzlCO0FBQ0EsYUFBTyxlQUFlLElBQUksRUFBRSxPQUFPLFNBQVMsQ0FBQztBQUM3QztBQUFBLElBQ0Y7QUFBQSxJQUNBLEtBQUs7QUFDSCxhQUFPLGVBQWUsSUFBSSxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQzdDO0FBQUEsSUFDRixLQUFLO0FBQ0gsYUFBTyxlQUFlLElBQUksRUFBRSxPQUFPLEdBQUcsQ0FBQztBQUN2QztBQUFBLElBQ0YsS0FBSztBQUNILGFBQU8sZUFBZSxJQUFJLEVBQUUsT0FBTyxNQUFNLFdBQVcsR0FBRyxDQUFDO0FBQ3hEO0FBQUEsSUFDRixLQUFLO0FBQUEsSUFDTCxLQUFLO0FBQUEsSUFDTCxLQUFLO0FBQUEsSUFDTCxLQUFLO0FBQUEsSUFDTCxLQUFLO0FBQ0gsYUFBTyxlQUFlLElBQUksRUFBRSxPQUFPLEdBQUcsQ0FBQztBQUN2QztBQUFBLElBQ0Y7QUFDRSxjQUFRLE9BQU8sTUFBTSw0REFBNEQsTUFBTTtBQUFBLENBQWlCO0FBQ3hHLGFBQU8sZUFBZSxJQUFJLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDN0M7QUFBQSxFQUNKO0FBQ0Y7QUFNTyxTQUFTLGVBQWUsT0FBZ0MsS0FBcUM7QUFDbEcsUUFBTSxPQUFPLE9BQU8sTUFBTSxRQUFRLEVBQUU7QUFHcEMsTUFBSSxJQUFJLGlCQUFpQjtBQUFBLEVBSXpCO0FBRUEsVUFBUSxNQUFNO0FBQUEsSUFDWixLQUFLLHdCQUF3QjtBQUMzQixVQUFJLENBQUMsSUFBSSxRQUFTLFFBQU87QUFDekIsWUFBTSxPQUFPLE9BQU8sTUFBTSxZQUFZLFNBQVM7QUFDL0MsWUFBTSxPQUFPLGtCQUFrQixNQUFNLFVBQVUsTUFBTSxJQUFJO0FBQ3pELFlBQU0sU0FBUyxPQUFPLElBQUksRUFBRSxHQUFHLEdBQUcsSUFBSSxHQUFHLEVBQUUsS0FBSyxLQUFLO0FBQ3JELGFBQU8sS0FBSyxFQUFFLEdBQUcsU0FBUyxFQUFFLEtBQUssT0FBTyxJQUFJLEdBQUcsTUFBTTtBQUFBLElBQ3ZEO0FBQUEsSUFFQSxLQUFLLHNCQUFzQjtBQUN6QixVQUFJLENBQUMsSUFBSSxRQUFTLFFBQU87QUFDekIsWUFBTSxPQUFPLE9BQU8sTUFBTSxZQUFZLFNBQVM7QUFDL0MsWUFBTSxjQUFjLElBQUksZ0JBQWdCLE9BQU8sSUFBSSxFQUFFLEdBQUcsR0FBRyxlQUFlLElBQUksWUFBWSxDQUFDLEdBQUcsRUFBRSxLQUFLLEtBQUs7QUFDMUcsVUFBSSxJQUFJLFNBQVM7QUFDZixlQUFPLEtBQUssRUFBRSxHQUFHLGFBQWEsSUFBSSxTQUFTLEVBQUUsS0FBSyxHQUFHLFdBQVc7QUFBQSxNQUNsRTtBQUNBLGFBQU8sS0FBSyxFQUFFLEdBQUcsYUFBYSxJQUFJLFFBQVEsRUFBRSxLQUFLLEdBQUcsV0FBVztBQUFBLElBQ2pFO0FBQUEsSUFFQSxLQUFLO0FBQ0gsYUFBTyxHQUFHLEVBQUUsR0FBRyw0QkFBNEIsRUFBRSxLQUFLO0FBQUEsSUFFcEQsS0FBSyxhQUFhO0FBQ2hCLFVBQUksT0FBTyxHQUFHLEVBQUUsR0FBRywwQkFBMEIsRUFBRSxLQUFLO0FBQ3BELFVBQUksSUFBSSxVQUFVO0FBQ2hCLGNBQU0sT0FBTyxJQUFJLElBQUksU0FBUyxRQUFRLFFBQVEsQ0FBQyxDQUFDO0FBQ2hELGNBQU0sU0FBUyxHQUFHLElBQUksU0FBUyxjQUFjLElBQUksU0FBUyxZQUFZO0FBQ3RFLGdCQUFRLElBQUksRUFBRSxHQUFHLElBQUksSUFBSSxLQUFLLE1BQU0sSUFBSSxFQUFFLEtBQUs7QUFBQSxNQUNqRDtBQUNBLGFBQU87QUFBQSxJQUNUO0FBQUEsSUFFQSxLQUFLLHdCQUF3QjtBQUMzQixZQUFNLFNBQVMsT0FBTyxNQUFNLFVBQVUsRUFBRTtBQUV4QyxVQUFJLFdBQVcsVUFBVTtBQUN2QixjQUFNLE1BQU0sT0FBTyxNQUFNLFdBQVcsRUFBRTtBQUN0QyxZQUFJLENBQUMsSUFBSyxRQUFPO0FBRWpCLGNBQU0sY0FBYyx1REFBdUQsS0FBSyxHQUFHO0FBQ25GLGVBQU8sY0FDSCxHQUFHLEVBQUUsSUFBSSxhQUFhLEdBQUcsR0FBRyxFQUFFLEtBQUssS0FDbkMsYUFBYSxHQUFHO0FBQUEsTUFDdEI7QUFFQSxVQUFJLFdBQVcsYUFBYTtBQUUxQixjQUFNLFlBQVksT0FBTyxNQUFNLGFBQWEsRUFBRTtBQUM5QyxjQUFNLE1BQU0sT0FBTyxNQUFNLFdBQVcsRUFBRTtBQUN0QyxZQUFJLENBQUMsYUFBYSxDQUFDLElBQUssUUFBTztBQUUvQixZQUFJLFdBQVc7QUFDYixnQkFBTSxRQUFRLGdCQUFnQixXQUFXLEdBQUc7QUFDNUMsY0FBSSxNQUFPLFFBQU8sR0FBRyxFQUFFLElBQUksYUFBYSxLQUFLLEdBQUcsRUFBRSxLQUFLO0FBQUEsUUFDekQ7QUFFQSxZQUFJLElBQUssUUFBTyxHQUFHLEVBQUUsSUFBSSxhQUFhLEdBQUcsR0FBRyxFQUFFLEtBQUs7QUFDbkQsZUFBTztBQUFBLE1BQ1Q7QUFFQSxhQUFPO0FBQUEsSUFDVDtBQUFBLElBRUE7QUFDRSxhQUFPO0FBQUEsRUFDWDtBQUNGO0FBTU8sU0FBUyxtQkFBbUIsTUFBc0I7QUFDdkQsUUFBTSxVQUFVLEtBQUssUUFBUSxRQUFRLEdBQUcsRUFBRSxLQUFLO0FBQy9DLFFBQU0sWUFBWSxRQUFRLFNBQVMsTUFBTSxRQUFRLE1BQU0sR0FBRyxHQUFHLElBQUksUUFBUTtBQUN6RSxTQUFPLEdBQUcsRUFBRSxHQUFHLEdBQUcsRUFBRSxNQUFNLGNBQWMsU0FBUyxHQUFHLEVBQUUsS0FBSztBQUM3RDtBQVNPLFNBQVMsa0JBQTBCO0FBQ3hDLFNBQU8sR0FBRyxFQUFFLEdBQUcsU0FBUyxFQUFFLEtBQUs7QUFDakM7QUFLTyxTQUFTLGdCQUF3QjtBQUN0QyxTQUFPO0FBQ1Q7QUFLTyxTQUFTLHNCQUE4QjtBQUM1QyxTQUFPLEdBQUcsRUFBRSxHQUFHLEdBQUcsRUFBRSxNQUFNLGFBQWEsRUFBRSxLQUFLO0FBQ2hEO0FBS08sU0FBUyxvQkFBNEI7QUFDMUMsU0FBTztBQUNUO0FBS08sU0FBUyxlQUFlLFNBQWlCLGFBQXFCLGNBQThCO0FBQ2pHLFNBQU8sR0FBRyxFQUFFLEdBQUcsY0FBYyxRQUFRLFFBQVEsQ0FBQyxDQUFDLEtBQUssY0FBYyxZQUFZLFdBQVcsRUFBRSxLQUFLO0FBQ2xHO0FBV0EsU0FBUyxnQkFBZ0IsV0FBbUIsU0FBZ0M7QUFFMUUsUUFBTSxRQUFRLFVBQVUsTUFBTSxHQUFHO0FBQ2pDLE1BQUksTUFBTSxVQUFVLEdBQUc7QUFDckIsVUFBTSxDQUFDLE1BQU0sS0FBSyxJQUFJO0FBQ3RCLFlBQVEsS0FBSyxZQUFZLEdBQUc7QUFBQSxNQUMxQixLQUFLO0FBQ0gsZUFBTyxhQUFhLEtBQUssR0FBRyxVQUFVLFNBQVMsVUFBVSxFQUFFO0FBQUEsTUFDN0QsS0FBSztBQUNILGVBQU8sU0FBUyxLQUFLLEdBQUcsVUFBVSxTQUFTLFVBQVUsRUFBRTtBQUFBLE1BQ3pELEtBQUs7QUFDSCxlQUFPLFFBQVEsS0FBSyxHQUFHLFVBQVUsU0FBUyxVQUFVLEVBQUU7QUFBQSxNQUN4RCxLQUFLO0FBQ0gsZUFBTyxVQUFVLEtBQUssR0FBRyxVQUFVLFNBQVMsVUFBVSxFQUFFO0FBQUEsTUFDMUQ7QUFDRSxlQUFPLEdBQUcsSUFBSSxLQUFLLEtBQUssR0FBRyxVQUFVLFNBQVMsVUFBVSxFQUFFO0FBQUEsSUFDOUQ7QUFBQSxFQUNGO0FBR0EsTUFBSSxRQUFTLFFBQU8sR0FBRyxTQUFTLEtBQUssT0FBTztBQUM1QyxTQUFPLGFBQWE7QUFDdEI7QUFNTyxTQUFTLDJCQUNkLFFBQ0EsWUFDWTtBQUNaLFNBQU8sc0JBQXNCLFFBQVEsT0FBbUIsQ0FBQyxTQUFTO0FBQ2hFLFFBQUk7QUFDSixRQUFJO0FBQ0YsWUFBTSxLQUFLLE1BQU0sSUFBSTtBQUFBLElBQ3ZCLFFBQVE7QUFDTixjQUFRLE9BQU8sTUFBTTtBQUFBLENBQXNFO0FBQzNGO0FBQUEsSUFDRjtBQUVBLFVBQU0sT0FBTyxPQUFPLElBQUksUUFBUSxFQUFFO0FBRWxDLFlBQVEsTUFBTTtBQUFBLE1BQ1osS0FBSyx5QkFBeUI7QUFDNUIsY0FBTSxLQUFLLE9BQU8sSUFBSSxNQUFNLEVBQUU7QUFDOUIsY0FBTSxRQUFRLElBQUksVUFBVSxTQUFZLE9BQU8sSUFBSSxLQUFLLElBQUk7QUFDNUQsY0FBTSxZQUFZLE9BQU8sSUFBSSxjQUFjLFlBQVksSUFBSSxZQUFZO0FBQ3ZFLGNBQU0sWUFBWSxPQUFPLElBQUksY0FBYyxZQUFZLElBQUksWUFBWTtBQUN2RSxlQUFPLGVBQWUsSUFBSSxFQUFFLE9BQU8sV0FBVyxVQUFVLENBQUM7QUFDekQsWUFBSSxJQUFJO0FBQ04scUJBQVcsRUFBRTtBQUFBLFFBQ2Y7QUFDQTtBQUFBLE1BQ0Y7QUFBQSxNQUNBLEtBQUs7QUFDSCxlQUFPLE9BQU8sT0FBTyxJQUFJLFdBQVcsRUFBRSxDQUFDO0FBQ3ZDO0FBQUEsTUFDRixLQUFLO0FBQ0gsZUFBTyxNQUFNLE9BQU8sSUFBSSxXQUFXLEVBQUUsQ0FBQztBQUN0QztBQUFBLE1BQ0YsS0FBSztBQUNILGVBQU8sU0FBUyxPQUFPLElBQUksV0FBVyxFQUFFLENBQUM7QUFDekM7QUFBQSxNQUNGO0FBQ0UsZ0JBQVEsT0FBTyxNQUFNLDZDQUE2QyxJQUFJO0FBQUEsQ0FBNkI7QUFDbkc7QUFBQSxJQUNKO0FBQUEsRUFDRixDQUFDO0FBQ0g7IiwKICAibmFtZXMiOiBbXQp9Cg==
