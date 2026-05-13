import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "../config.js";
const TRUST_MARKER = "hooks.trusted";
const DEFAULT_TIMEOUT_MS = 3e4;
function isProjectHooksTrusted(cwd) {
  return existsSync(join(cwd, CONFIG_DIR_NAME, TRUST_MARKER));
}
function collectHooks(name, globalSettings, projectSettings, cwd) {
  const result = [];
  for (const entry of globalSettings.hooks?.[name] ?? []) {
    result.push({ ...entry, scope: "global" });
  }
  if (projectSettings.hooks?.[name]?.length && isProjectHooksTrusted(cwd)) {
    for (const entry of projectSettings.hooks[name] ?? []) {
      result.push({ ...entry, scope: "project" });
    }
  }
  return result;
}
function matchesFilter(entry, payload) {
  const filter = entry.match;
  if (!filter) return true;
  if (filter.tool !== void 0) {
    const names = Array.isArray(filter.tool) ? filter.tool : [filter.tool];
    const toolName = payload.toolName ?? payload.tool;
    if (typeof toolName !== "string" || !names.includes(toolName)) return false;
  }
  if (filter.command !== void 0) {
    const cmd = payload.input?.command ?? payload.command;
    if (typeof cmd !== "string" || !cmd.startsWith(filter.command)) return false;
  }
  return true;
}
async function runOne(name, hook, payload, cwd) {
  const timeout = hook.timeout ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(hook.command, {
      cwd,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...hook.env, GSD_HOOK_EVENT: name, GSD_HOOK_SCOPE: hook.scope }
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 2e3);
    }, timeout);
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        name,
        scope: hook.scope,
        command: hook.command,
        exitCode: 1,
        stdout,
        stderr: stderr || String(err),
        durationMs: Date.now() - startedAt,
        timedOut: false
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let parsed;
      const trimmed = stdout.trim();
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
          parsed = JSON.parse(trimmed);
        } catch {
        }
      }
      resolve({
        name,
        scope: hook.scope,
        command: hook.command,
        exitCode: code ?? -1,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
        parsed
      });
    });
    child.stdin.on("error", () => {
    });
    try {
      child.stdin.write(JSON.stringify(payload), () => {
        try {
          child.stdin.end();
        } catch {
        }
      });
    } catch {
    }
  });
}
async function runChain(name, payload, hooks, cwd, onInvocation) {
  let merged;
  for (const hook of hooks) {
    if (!matchesFilter(hook, payload)) continue;
    const invocation = await runOne(name, hook, payload, cwd);
    onInvocation?.(invocation);
    if (invocation.exitCode !== 0 && hook.blocking !== false) {
      const reason = invocation.parsed?.reason ?? (invocation.stderr.trim() || `Hook ${hook.command} exited with code ${invocation.exitCode}`);
      return { ...merged ?? {}, block: true, reason };
    }
    if (invocation.parsed) {
      if (invocation.parsed.block) return { ...merged ?? {}, ...invocation.parsed };
      merged = { ...merged ?? {}, ...invocation.parsed };
    }
  }
  return merged;
}
function createHooksRunner(options) {
  const { extensionRunner, cwd, onInvocation } = options;
  const dispatch = async (name, payload) => {
    const hooks = collectHooks(
      name,
      options.getGlobalSettings(),
      options.getProjectSettings(),
      cwd
    );
    if (hooks.length === 0) return void 0;
    return runChain(name, payload, hooks, cwd, onInvocation);
  };
  const handlers = /* @__PURE__ */ new Map();
  handlers.set("input", [async (event) => {
    const e = event;
    const result = await dispatch("UserPromptSubmit", { text: e.text, source: e.source });
    if (result?.block) return { action: "handled" };
    return void 0;
  }]);
  handlers.set("tool_call", [async (event) => {
    const e = event;
    const result = await dispatch("PreToolUse", {
      toolCallId: e.toolCallId,
      toolName: e.toolName,
      input: e.input
    });
    if (result?.block) return { block: true, reason: result.reason };
    return void 0;
  }]);
  handlers.set("tool_result", [async (event) => {
    const e = event;
    await dispatch("PostToolUse", {
      toolCallId: e.toolCallId,
      toolName: e.toolName,
      input: e.input,
      content: e.content,
      isError: e.isError,
      details: e.details
    });
    return void 0;
  }]);
  handlers.set("stop", [async (event) => {
    const e = event;
    await dispatch("Stop", { reason: e.reason });
    return void 0;
  }]);
  handlers.set("notification", [async (event) => {
    const e = event;
    await dispatch("Notification", { kind: e.kind, message: e.message, details: e.details });
    if (e.kind === "blocked") {
      await dispatch("Blocked", { message: e.message, details: e.details });
    }
    return void 0;
  }]);
  handlers.set("session_end", [async (event) => {
    const e = event;
    await dispatch("SessionEnd", { reason: e.reason, sessionFile: e.sessionFile });
    return void 0;
  }]);
  handlers.set("before_commit", [async (event) => {
    const e = event;
    const result = await dispatch("PreCommit", { message: e.message, files: e.files, cwd: e.cwd, author: e.author });
    if (!result) return void 0;
    if (result.block) return { cancel: true, reason: result.reason };
    if (result.message !== void 0) return { message: result.message };
    return void 0;
  }]);
  handlers.set("commit", [async (event) => {
    const e = event;
    await dispatch("PostCommit", { sha: e.sha, message: e.message, files: e.files, cwd: e.cwd });
    return void 0;
  }]);
  handlers.set("before_push", [async (event) => {
    const e = event;
    const result = await dispatch("PrePush", { remote: e.remote, branch: e.branch, cwd: e.cwd });
    if (result?.block) return { cancel: true, reason: result.reason };
    return void 0;
  }]);
  handlers.set("push", [async (event) => {
    const e = event;
    await dispatch("PostPush", { remote: e.remote, branch: e.branch, cwd: e.cwd });
    return void 0;
  }]);
  handlers.set("before_pr", [async (event) => {
    const e = event;
    const result = await dispatch("PrePr", {
      branch: e.branch,
      targetBranch: e.targetBranch,
      title: e.title,
      body: e.body,
      cwd: e.cwd
    });
    if (!result) return void 0;
    if (result.block) return { cancel: true, reason: result.reason };
    if (result.title !== void 0 || result.body !== void 0) {
      return { title: result.title, body: result.body };
    }
    return void 0;
  }]);
  handlers.set("pr_opened", [async (event) => {
    const e = event;
    await dispatch("PostPr", { url: e.url, branch: e.branch, targetBranch: e.targetBranch, cwd: e.cwd });
    return void 0;
  }]);
  handlers.set("before_verify", [async (event) => {
    const e = event;
    const result = await dispatch("PreVerify", { unitType: e.unitType, unitId: e.unitId, cwd: e.cwd });
    if (result?.block) return { cancel: true, reason: result.reason };
    return void 0;
  }]);
  handlers.set("verify_result", [async (event) => {
    const e = event;
    await dispatch("PostVerify", {
      passed: e.passed,
      failures: e.failures,
      unitType: e.unitType,
      unitId: e.unitId,
      cwd: e.cwd
    });
    return void 0;
  }]);
  handlers.set("budget_threshold", [async (event) => {
    const e = event;
    const result = await dispatch("BudgetThreshold", {
      fraction: e.fraction,
      spent: e.spent,
      limit: e.limit,
      currency: e.currency
    });
    if (result?.action) return { action: result.action };
    return void 0;
  }]);
  handlers.set("milestone_start", [async (event) => {
    const e = event;
    await dispatch("PreMilestone", { milestoneId: e.milestoneId, title: e.title, cwd: e.cwd });
    return void 0;
  }]);
  handlers.set("milestone_end", [async (event) => {
    const e = event;
    await dispatch("PostMilestone", { milestoneId: e.milestoneId, status: e.status, cwd: e.cwd });
    return void 0;
  }]);
  handlers.set("unit_start", [async (event) => {
    const e = event;
    await dispatch("PreUnit", {
      unitType: e.unitType,
      unitId: e.unitId,
      milestoneId: e.milestoneId,
      cwd: e.cwd
    });
    return void 0;
  }]);
  handlers.set("unit_end", [async (event) => {
    const e = event;
    await dispatch("PostUnit", {
      unitType: e.unitType,
      unitId: e.unitId,
      milestoneId: e.milestoneId,
      status: e.status,
      cwd: e.cwd
    });
    return void 0;
  }]);
  handlers.set("session_before_compact", [async (event) => {
    const e = event;
    const result = await dispatch("PreCompact", { branchEntries: e.branchEntries.length });
    if (result?.block) return { cancel: true };
    return void 0;
  }]);
  handlers.set("session_compact", [async (event) => {
    const e = event;
    await dispatch("PostCompact", { fromExtension: e.fromExtension });
    return void 0;
  }]);
  const dispose = extensionRunner.installHookBridge("__hooks__", handlers);
  return {
    dispose,
    async fireSessionStart() {
      const payload = { type: "session_start" };
      await dispatch("SessionStart", { cwd, type: payload.type });
    },
    async fireSessionEnd(reason) {
      await dispatch("SessionEnd", { reason });
    }
  };
}
export {
  createHooksRunner,
  isProjectHooksTrusted
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL2hvb2tzLXJ1bm5lci50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBMYXllciAwIHNoZWxsLWhvb2sgcnVubmVyLlxuICpcbiAqIEJyaWRnZXMgdGhlIExheWVyIDIgZXh0ZW5zaW9uIGV2ZW50IGJ1cyB0byB1c2VyLWNvbmZpZ3VyZWQgc2hlbGwgY29tbWFuZHNcbiAqIGRlY2xhcmVkIGluIGBzZXR0aW5ncy5qc29uYCB1bmRlciB0aGUgYGhvb2tzYCBrZXkuIEVhY2ggaG9vayBlbnRyeSByZWNlaXZlc1xuICogdGhlIGV2ZW50IHBheWxvYWQgYXMgSlNPTiBvbiBzdGRpbiBhbmQgY2FuIG11dGF0ZSB0aGUgcGVuZGluZyBhY3Rpb24gYnlcbiAqIHdyaXRpbmcgYSBKU09OIHJlc3BvbnNlIHRvIHN0ZG91dC5cbiAqXG4gKiBUcnVzdCBtb2RlbDogaG9va3MgbG9hZGVkIGZyb20gcHJvamVjdC1zY29wZWQgc2V0dGluZ3MgYXJlIGRyb3BwZWQgdW5sZXNzXG4gKiB0aGUgdXNlciBoYXMgb3B0ZWQgaW4gYnkgY3JlYXRpbmcgYC5waS9ob29rcy50cnVzdGVkYCBpbiB0aGUgcHJvamVjdCByb290LlxuICogVGhpcyBwcmV2ZW50cyBhIGNsb25lZCByZXBvc2l0b3J5IGZyb20gZXhlY3V0aW5nIGFyYml0cmFyeSBzaGVsbCBjb21tYW5kcy5cbiAqL1xuXG5pbXBvcnQgeyBzcGF3biB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IENPTkZJR19ESVJfTkFNRSB9IGZyb20gXCIuLi9jb25maWcuanNcIjtcbmltcG9ydCB0eXBlIHsgRXh0ZW5zaW9uUnVubmVyIH0gZnJvbSBcIi4vZXh0ZW5zaW9ucy9ydW5uZXIuanNcIjtcbmltcG9ydCB0eXBlIHtcblx0QmVmb3JlQ29tbWl0RXZlbnRSZXN1bHQsXG5cdEJlZm9yZVByRXZlbnRSZXN1bHQsXG5cdEJlZm9yZVB1c2hFdmVudFJlc3VsdCxcblx0QmVmb3JlVmVyaWZ5RXZlbnRSZXN1bHQsXG5cdEJ1ZGdldFRocmVzaG9sZEV2ZW50UmVzdWx0LFxuXHRDb21taXRFdmVudCxcblx0SW5wdXRFdmVudFJlc3VsdCxcblx0Tm90aWZpY2F0aW9uRXZlbnQsXG5cdFByT3BlbmVkRXZlbnQsXG5cdFB1c2hFdmVudCxcblx0U2Vzc2lvbkVuZEV2ZW50LFxuXHRTZXNzaW9uU3RhcnRFdmVudCxcblx0U3RvcEV2ZW50LFxuXHRUb29sQ2FsbEV2ZW50LFxuXHRUb29sQ2FsbEV2ZW50UmVzdWx0LFxuXHRUb29sUmVzdWx0RXZlbnQsXG5cdFRvb2xSZXN1bHRFdmVudFJlc3VsdCxcblx0QmVmb3JlQ29tbWl0RXZlbnQsXG5cdEJlZm9yZVByRXZlbnQsXG5cdEJlZm9yZVB1c2hFdmVudCxcblx0QmVmb3JlVmVyaWZ5RXZlbnQsXG5cdEJ1ZGdldFRocmVzaG9sZEV2ZW50LFxuXHRJbnB1dEV2ZW50LFxuXHRNaWxlc3RvbmVFbmRFdmVudCxcblx0TWlsZXN0b25lU3RhcnRFdmVudCxcblx0U2Vzc2lvbkJlZm9yZUNvbXBhY3RFdmVudCxcblx0U2Vzc2lvbkJlZm9yZUNvbXBhY3RSZXN1bHQsXG5cdFNlc3Npb25Db21wYWN0RXZlbnQsXG5cdFVuaXRFbmRFdmVudCxcblx0VW5pdFN0YXJ0RXZlbnQsXG5cdFZlcmlmeVJlc3VsdEV2ZW50LFxufSBmcm9tIFwiLi9leHRlbnNpb25zL3R5cGVzLmpzXCI7XG5pbXBvcnQgdHlwZSB7IEhvb2tFbnRyeSwgSG9va3NTZXR0aW5ncywgU2V0dGluZ3MgfSBmcm9tIFwiLi9zZXR0aW5ncy1tYW5hZ2VyLmpzXCI7XG5cbmNvbnN0IFRSVVNUX01BUktFUiA9IFwiaG9va3MudHJ1c3RlZFwiO1xuY29uc3QgREVGQVVMVF9USU1FT1VUX01TID0gMzBfMDAwO1xuXG5leHBvcnQgdHlwZSBIb29rTmFtZSA9IGtleW9mIEhvb2tzU2V0dGluZ3M7XG5leHBvcnQgdHlwZSBIb29rU2NvcGUgPSBcImdsb2JhbFwiIHwgXCJwcm9qZWN0XCI7XG5cbmludGVyZmFjZSBTY29wZWRIb29rIGV4dGVuZHMgSG9va0VudHJ5IHtcblx0c2NvcGU6IEhvb2tTY29wZTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBIb29rU3Rkb3V0UmVzdWx0IHtcblx0YmxvY2s/OiBib29sZWFuO1xuXHRyZWFzb24/OiBzdHJpbmc7XG5cdG1lc3NhZ2U/OiBzdHJpbmc7XG5cdHRpdGxlPzogc3RyaW5nO1xuXHRib2R5Pzogc3RyaW5nO1xuXHRhY3Rpb24/OiBcInBhdXNlXCIgfCBcImRvd25ncmFkZVwiIHwgXCJjb250aW51ZVwiO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEhvb2tJbnZvY2F0aW9uIHtcblx0bmFtZTogSG9va05hbWU7XG5cdHNjb3BlOiBIb29rU2NvcGU7XG5cdGNvbW1hbmQ6IHN0cmluZztcblx0ZXhpdENvZGU6IG51bWJlcjtcblx0c3Rkb3V0OiBzdHJpbmc7XG5cdHN0ZGVycjogc3RyaW5nO1xuXHRkdXJhdGlvbk1zOiBudW1iZXI7XG5cdHRpbWVkT3V0OiBib29sZWFuO1xuXHRwYXJzZWQ/OiBIb29rU3Rkb3V0UmVzdWx0O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaXNQcm9qZWN0SG9va3NUcnVzdGVkKGN3ZDogc3RyaW5nKTogYm9vbGVhbiB7XG5cdHJldHVybiBleGlzdHNTeW5jKGpvaW4oY3dkLCBDT05GSUdfRElSX05BTUUsIFRSVVNUX01BUktFUikpO1xufVxuXG5mdW5jdGlvbiBjb2xsZWN0SG9va3MoXG5cdG5hbWU6IEhvb2tOYW1lLFxuXHRnbG9iYWxTZXR0aW5nczogU2V0dGluZ3MsXG5cdHByb2plY3RTZXR0aW5nczogU2V0dGluZ3MsXG5cdGN3ZDogc3RyaW5nLFxuKTogU2NvcGVkSG9va1tdIHtcblx0Y29uc3QgcmVzdWx0OiBTY29wZWRIb29rW10gPSBbXTtcblx0Zm9yIChjb25zdCBlbnRyeSBvZiBnbG9iYWxTZXR0aW5ncy5ob29rcz8uW25hbWVdID8/IFtdKSB7XG5cdFx0cmVzdWx0LnB1c2goeyAuLi5lbnRyeSwgc2NvcGU6IFwiZ2xvYmFsXCIgfSk7XG5cdH1cblx0aWYgKHByb2plY3RTZXR0aW5ncy5ob29rcz8uW25hbWVdPy5sZW5ndGggJiYgaXNQcm9qZWN0SG9va3NUcnVzdGVkKGN3ZCkpIHtcblx0XHRmb3IgKGNvbnN0IGVudHJ5IG9mIHByb2plY3RTZXR0aW5ncy5ob29rc1tuYW1lXSA/PyBbXSkge1xuXHRcdFx0cmVzdWx0LnB1c2goeyAuLi5lbnRyeSwgc2NvcGU6IFwicHJvamVjdFwiIH0pO1xuXHRcdH1cblx0fVxuXHRyZXR1cm4gcmVzdWx0O1xufVxuXG5mdW5jdGlvbiBtYXRjaGVzRmlsdGVyKGVudHJ5OiBIb29rRW50cnksIHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogYm9vbGVhbiB7XG5cdGNvbnN0IGZpbHRlciA9IGVudHJ5Lm1hdGNoO1xuXHRpZiAoIWZpbHRlcikgcmV0dXJuIHRydWU7XG5cblx0aWYgKGZpbHRlci50b29sICE9PSB1bmRlZmluZWQpIHtcblx0XHRjb25zdCBuYW1lcyA9IEFycmF5LmlzQXJyYXkoZmlsdGVyLnRvb2wpID8gZmlsdGVyLnRvb2wgOiBbZmlsdGVyLnRvb2xdO1xuXHRcdGNvbnN0IHRvb2xOYW1lID0gcGF5bG9hZC50b29sTmFtZSA/PyAocGF5bG9hZCBhcyB7IHRvb2w/OiBzdHJpbmcgfSkudG9vbDtcblx0XHRpZiAodHlwZW9mIHRvb2xOYW1lICE9PSBcInN0cmluZ1wiIHx8ICFuYW1lcy5pbmNsdWRlcyh0b29sTmFtZSkpIHJldHVybiBmYWxzZTtcblx0fVxuXG5cdGlmIChmaWx0ZXIuY29tbWFuZCAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0Y29uc3QgY21kID0gKHBheWxvYWQuaW5wdXQgYXMgeyBjb21tYW5kPzogdW5rbm93biB9IHwgdW5kZWZpbmVkKT8uY29tbWFuZFxuXHRcdFx0Pz8gKHBheWxvYWQgYXMgeyBjb21tYW5kPzogdW5rbm93biB9KS5jb21tYW5kO1xuXHRcdGlmICh0eXBlb2YgY21kICE9PSBcInN0cmluZ1wiIHx8ICFjbWQuc3RhcnRzV2l0aChmaWx0ZXIuY29tbWFuZCkpIHJldHVybiBmYWxzZTtcblx0fVxuXG5cdHJldHVybiB0cnVlO1xufVxuXG5hc3luYyBmdW5jdGlvbiBydW5PbmUoXG5cdG5hbWU6IEhvb2tOYW1lLFxuXHRob29rOiBTY29wZWRIb29rLFxuXHRwYXlsb2FkOiB1bmtub3duLFxuXHRjd2Q6IHN0cmluZyxcbik6IFByb21pc2U8SG9va0ludm9jYXRpb24+IHtcblx0Y29uc3QgdGltZW91dCA9IGhvb2sudGltZW91dCA/PyBERUZBVUxUX1RJTUVPVVRfTVM7XG5cdGNvbnN0IHN0YXJ0ZWRBdCA9IERhdGUubm93KCk7XG5cblx0cmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG5cdFx0Y29uc3QgY2hpbGQgPSBzcGF3bihob29rLmNvbW1hbmQsIHtcblx0XHRcdGN3ZCxcblx0XHRcdHNoZWxsOiB0cnVlLFxuXHRcdFx0c3RkaW86IFtcInBpcGVcIiwgXCJwaXBlXCIsIFwicGlwZVwiXSxcblx0XHRcdGVudjogeyAuLi5wcm9jZXNzLmVudiwgLi4uaG9vay5lbnYsIEdTRF9IT09LX0VWRU5UOiBuYW1lLCBHU0RfSE9PS19TQ09QRTogaG9vay5zY29wZSB9LFxuXHRcdH0pO1xuXG5cdFx0bGV0IHN0ZG91dCA9IFwiXCI7XG5cdFx0bGV0IHN0ZGVyciA9IFwiXCI7XG5cdFx0bGV0IHRpbWVkT3V0ID0gZmFsc2U7XG5cblx0XHRjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuXHRcdFx0dGltZWRPdXQgPSB0cnVlO1xuXHRcdFx0Y2hpbGQua2lsbChcIlNJR1RFUk1cIik7XG5cdFx0XHRzZXRUaW1lb3V0KCgpID0+IHtcblx0XHRcdFx0aWYgKGNoaWxkLmV4aXRDb2RlID09PSBudWxsKSBjaGlsZC5raWxsKFwiU0lHS0lMTFwiKTtcblx0XHRcdH0sIDJfMDAwKTtcblx0XHR9LCB0aW1lb3V0KTtcblxuXHRcdGNoaWxkLnN0ZG91dC5vbihcImRhdGFcIiwgKGQpID0+IHsgc3Rkb3V0ICs9IGQudG9TdHJpbmcoKTsgfSk7XG5cdFx0Y2hpbGQuc3RkZXJyLm9uKFwiZGF0YVwiLCAoZCkgPT4geyBzdGRlcnIgKz0gZC50b1N0cmluZygpOyB9KTtcblxuXHRcdGNoaWxkLm9uKFwiZXJyb3JcIiwgKGVycikgPT4ge1xuXHRcdFx0Y2xlYXJUaW1lb3V0KHRpbWVyKTtcblx0XHRcdHJlc29sdmUoe1xuXHRcdFx0XHRuYW1lLFxuXHRcdFx0XHRzY29wZTogaG9vay5zY29wZSxcblx0XHRcdFx0Y29tbWFuZDogaG9vay5jb21tYW5kLFxuXHRcdFx0XHRleGl0Q29kZTogMSxcblx0XHRcdFx0c3Rkb3V0LFxuXHRcdFx0XHRzdGRlcnI6IHN0ZGVyciB8fCBTdHJpbmcoZXJyKSxcblx0XHRcdFx0ZHVyYXRpb25NczogRGF0ZS5ub3coKSAtIHN0YXJ0ZWRBdCxcblx0XHRcdFx0dGltZWRPdXQ6IGZhbHNlLFxuXHRcdFx0fSk7XG5cdFx0fSk7XG5cblx0XHRjaGlsZC5vbihcImNsb3NlXCIsIChjb2RlKSA9PiB7XG5cdFx0XHRjbGVhclRpbWVvdXQodGltZXIpO1xuXHRcdFx0bGV0IHBhcnNlZDogSG9va1N0ZG91dFJlc3VsdCB8IHVuZGVmaW5lZDtcblx0XHRcdGNvbnN0IHRyaW1tZWQgPSBzdGRvdXQudHJpbSgpO1xuXHRcdFx0aWYgKHRyaW1tZWQuc3RhcnRzV2l0aChcIntcIikgJiYgdHJpbW1lZC5lbmRzV2l0aChcIn1cIikpIHtcblx0XHRcdFx0dHJ5IHsgcGFyc2VkID0gSlNPTi5wYXJzZSh0cmltbWVkKSBhcyBIb29rU3Rkb3V0UmVzdWx0OyB9IGNhdGNoIHsgLyogdG9sZXJhdGUgbm9uLUpTT04gc3Rkb3V0ICovIH1cblx0XHRcdH1cblx0XHRcdHJlc29sdmUoe1xuXHRcdFx0XHRuYW1lLFxuXHRcdFx0XHRzY29wZTogaG9vay5zY29wZSxcblx0XHRcdFx0Y29tbWFuZDogaG9vay5jb21tYW5kLFxuXHRcdFx0XHRleGl0Q29kZTogY29kZSA/PyAtMSxcblx0XHRcdFx0c3Rkb3V0LFxuXHRcdFx0XHRzdGRlcnIsXG5cdFx0XHRcdGR1cmF0aW9uTXM6IERhdGUubm93KCkgLSBzdGFydGVkQXQsXG5cdFx0XHRcdHRpbWVkT3V0LFxuXHRcdFx0XHRwYXJzZWQsXG5cdFx0XHR9KTtcblx0XHR9KTtcblxuXHRcdC8vIFNpbGVuY2UgRVBJUEUgaWYgdGhlIGNoaWxkIGV4aXRzIGJlZm9yZSBjb25zdW1pbmcgc3RkaW4uXG5cdFx0Y2hpbGQuc3RkaW4ub24oXCJlcnJvclwiLCAoKSA9PiB7IC8qIG5vLW9wICovIH0pO1xuXHRcdHRyeSB7XG5cdFx0XHRjaGlsZC5zdGRpbi53cml0ZShKU09OLnN0cmluZ2lmeShwYXlsb2FkKSwgKCkgPT4ge1xuXHRcdFx0XHR0cnkgeyBjaGlsZC5zdGRpbi5lbmQoKTsgfSBjYXRjaCB7IC8qIGlnbm9yZSAqLyB9XG5cdFx0XHR9KTtcblx0XHR9IGNhdGNoIHsgLyogY2hpbGQgbWF5IGhhdmUgYWxyZWFkeSBleGl0ZWQgKi8gfVxuXHR9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcnVuQ2hhaW4oXG5cdG5hbWU6IEhvb2tOYW1lLFxuXHRwYXlsb2FkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcblx0aG9va3M6IFNjb3BlZEhvb2tbXSxcblx0Y3dkOiBzdHJpbmcsXG5cdG9uSW52b2NhdGlvbj86IChpOiBIb29rSW52b2NhdGlvbikgPT4gdm9pZCxcbik6IFByb21pc2U8SG9va1N0ZG91dFJlc3VsdCB8IHVuZGVmaW5lZD4ge1xuXHRsZXQgbWVyZ2VkOiBIb29rU3Rkb3V0UmVzdWx0IHwgdW5kZWZpbmVkO1xuXHRmb3IgKGNvbnN0IGhvb2sgb2YgaG9va3MpIHtcblx0XHRpZiAoIW1hdGNoZXNGaWx0ZXIoaG9vaywgcGF5bG9hZCkpIGNvbnRpbnVlO1xuXHRcdGNvbnN0IGludm9jYXRpb24gPSBhd2FpdCBydW5PbmUobmFtZSwgaG9vaywgcGF5bG9hZCwgY3dkKTtcblx0XHRvbkludm9jYXRpb24/LihpbnZvY2F0aW9uKTtcblxuXHRcdGlmIChpbnZvY2F0aW9uLmV4aXRDb2RlICE9PSAwICYmIGhvb2suYmxvY2tpbmcgIT09IGZhbHNlKSB7XG5cdFx0XHRjb25zdCByZWFzb24gPSBpbnZvY2F0aW9uLnBhcnNlZD8ucmVhc29uXG5cdFx0XHRcdD8/IChpbnZvY2F0aW9uLnN0ZGVyci50cmltKClcblx0XHRcdFx0XHR8fCBgSG9vayAke2hvb2suY29tbWFuZH0gZXhpdGVkIHdpdGggY29kZSAke2ludm9jYXRpb24uZXhpdENvZGV9YCk7XG5cdFx0XHRyZXR1cm4geyAuLi4obWVyZ2VkID8/IHt9KSwgYmxvY2s6IHRydWUsIHJlYXNvbiB9O1xuXHRcdH1cblxuXHRcdGlmIChpbnZvY2F0aW9uLnBhcnNlZCkge1xuXHRcdFx0aWYgKGludm9jYXRpb24ucGFyc2VkLmJsb2NrKSByZXR1cm4geyAuLi4obWVyZ2VkID8/IHt9KSwgLi4uaW52b2NhdGlvbi5wYXJzZWQgfTtcblx0XHRcdG1lcmdlZCA9IHsgLi4uKG1lcmdlZCA/PyB7fSksIC4uLmludm9jYXRpb24ucGFyc2VkIH07XG5cdFx0fVxuXHR9XG5cdHJldHVybiBtZXJnZWQ7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBQdWJsaWMgQVBJIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgaW50ZXJmYWNlIEhvb2tzUnVubmVyT3B0aW9ucyB7XG5cdGV4dGVuc2lvblJ1bm5lcjogRXh0ZW5zaW9uUnVubmVyO1xuXHRnZXRHbG9iYWxTZXR0aW5nczogKCkgPT4gU2V0dGluZ3M7XG5cdGdldFByb2plY3RTZXR0aW5nczogKCkgPT4gU2V0dGluZ3M7XG5cdGN3ZDogc3RyaW5nO1xuXHRvbkludm9jYXRpb24/OiAoaW52b2NhdGlvbjogSG9va0ludm9jYXRpb24pID0+IHZvaWQ7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgSG9va3NSdW5uZXIge1xuXHRkaXNwb3NlKCk6IHZvaWQ7XG5cdC8qKiBGaXJlIFNlc3Npb25TdGFydCBvbmNlIGR1cmluZyBib290c3RyYXAuICovXG5cdGZpcmVTZXNzaW9uU3RhcnQoKTogUHJvbWlzZTx2b2lkPjtcblx0LyoqIEZpcmUgU2Vzc2lvbkVuZCBkdXJpbmcgc2Vzc2lvbiB0ZWFyZG93bi4gKi9cblx0ZmlyZVNlc3Npb25FbmQocmVhc29uOiBTZXNzaW9uRW5kRXZlbnRbXCJyZWFzb25cIl0pOiBQcm9taXNlPHZvaWQ+O1xufVxuXG50eXBlIEhhbmRsZXJGbiA9IChldmVudDogdW5rbm93biwgY3R4OiB1bmtub3duKSA9PiBQcm9taXNlPHVua25vd24+O1xuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlSG9va3NSdW5uZXIob3B0aW9uczogSG9va3NSdW5uZXJPcHRpb25zKTogSG9va3NSdW5uZXIge1xuXHRjb25zdCB7IGV4dGVuc2lvblJ1bm5lciwgY3dkLCBvbkludm9jYXRpb24gfSA9IG9wdGlvbnM7XG5cblx0Y29uc3QgZGlzcGF0Y2ggPSBhc3luYyAobmFtZTogSG9va05hbWUsIHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiB7XG5cdFx0Y29uc3QgaG9va3MgPSBjb2xsZWN0SG9va3MoXG5cdFx0XHRuYW1lLFxuXHRcdFx0b3B0aW9ucy5nZXRHbG9iYWxTZXR0aW5ncygpLFxuXHRcdFx0b3B0aW9ucy5nZXRQcm9qZWN0U2V0dGluZ3MoKSxcblx0XHRcdGN3ZCxcblx0XHQpO1xuXHRcdGlmIChob29rcy5sZW5ndGggPT09IDApIHJldHVybiB1bmRlZmluZWQ7XG5cdFx0cmV0dXJuIHJ1bkNoYWluKG5hbWUsIHBheWxvYWQsIGhvb2tzLCBjd2QsIG9uSW52b2NhdGlvbik7XG5cdH07XG5cblx0Y29uc3QgaGFuZGxlcnMgPSBuZXcgTWFwPHN0cmluZywgSGFuZGxlckZuW10+KCk7XG5cblx0aGFuZGxlcnMuc2V0KFwiaW5wdXRcIiwgW2FzeW5jIChldmVudDogdW5rbm93bik6IFByb21pc2U8SW5wdXRFdmVudFJlc3VsdCB8IHVuZGVmaW5lZD4gPT4ge1xuXHRcdGNvbnN0IGUgPSBldmVudCBhcyBJbnB1dEV2ZW50O1xuXHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRpc3BhdGNoKFwiVXNlclByb21wdFN1Ym1pdFwiLCB7IHRleHQ6IGUudGV4dCwgc291cmNlOiBlLnNvdXJjZSB9KTtcblx0XHRpZiAocmVzdWx0Py5ibG9jaykgcmV0dXJuIHsgYWN0aW9uOiBcImhhbmRsZWRcIiB9O1xuXHRcdHJldHVybiB1bmRlZmluZWQ7XG5cdH1dKTtcblxuXHRoYW5kbGVycy5zZXQoXCJ0b29sX2NhbGxcIiwgW2FzeW5jIChldmVudDogdW5rbm93bik6IFByb21pc2U8VG9vbENhbGxFdmVudFJlc3VsdCB8IHVuZGVmaW5lZD4gPT4ge1xuXHRcdGNvbnN0IGUgPSBldmVudCBhcyBUb29sQ2FsbEV2ZW50O1xuXHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRpc3BhdGNoKFwiUHJlVG9vbFVzZVwiLCB7XG5cdFx0XHR0b29sQ2FsbElkOiBlLnRvb2xDYWxsSWQsXG5cdFx0XHR0b29sTmFtZTogZS50b29sTmFtZSxcblx0XHRcdGlucHV0OiBlLmlucHV0LFxuXHRcdH0pO1xuXHRcdGlmIChyZXN1bHQ/LmJsb2NrKSByZXR1cm4geyBibG9jazogdHJ1ZSwgcmVhc29uOiByZXN1bHQucmVhc29uIH07XG5cdFx0cmV0dXJuIHVuZGVmaW5lZDtcblx0fV0pO1xuXG5cdGhhbmRsZXJzLnNldChcInRvb2xfcmVzdWx0XCIsIFthc3luYyAoZXZlbnQ6IHVua25vd24pOiBQcm9taXNlPFRvb2xSZXN1bHRFdmVudFJlc3VsdCB8IHVuZGVmaW5lZD4gPT4ge1xuXHRcdGNvbnN0IGUgPSBldmVudCBhcyBUb29sUmVzdWx0RXZlbnQ7XG5cdFx0YXdhaXQgZGlzcGF0Y2goXCJQb3N0VG9vbFVzZVwiLCB7XG5cdFx0XHR0b29sQ2FsbElkOiBlLnRvb2xDYWxsSWQsXG5cdFx0XHR0b29sTmFtZTogZS50b29sTmFtZSxcblx0XHRcdGlucHV0OiBlLmlucHV0LFxuXHRcdFx0Y29udGVudDogZS5jb250ZW50LFxuXHRcdFx0aXNFcnJvcjogZS5pc0Vycm9yLFxuXHRcdFx0ZGV0YWlsczogZS5kZXRhaWxzLFxuXHRcdH0pO1xuXHRcdHJldHVybiB1bmRlZmluZWQ7XG5cdH1dKTtcblxuXHRoYW5kbGVycy5zZXQoXCJzdG9wXCIsIFthc3luYyAoZXZlbnQ6IHVua25vd24pID0+IHtcblx0XHRjb25zdCBlID0gZXZlbnQgYXMgU3RvcEV2ZW50O1xuXHRcdGF3YWl0IGRpc3BhdGNoKFwiU3RvcFwiLCB7IHJlYXNvbjogZS5yZWFzb24gfSk7XG5cdFx0cmV0dXJuIHVuZGVmaW5lZDtcblx0fV0pO1xuXG5cdGhhbmRsZXJzLnNldChcIm5vdGlmaWNhdGlvblwiLCBbYXN5bmMgKGV2ZW50OiB1bmtub3duKSA9PiB7XG5cdFx0Y29uc3QgZSA9IGV2ZW50IGFzIE5vdGlmaWNhdGlvbkV2ZW50O1xuXHRcdGF3YWl0IGRpc3BhdGNoKFwiTm90aWZpY2F0aW9uXCIsIHsga2luZDogZS5raW5kLCBtZXNzYWdlOiBlLm1lc3NhZ2UsIGRldGFpbHM6IGUuZGV0YWlscyB9KTtcblx0XHRpZiAoZS5raW5kID09PSBcImJsb2NrZWRcIikge1xuXHRcdFx0YXdhaXQgZGlzcGF0Y2goXCJCbG9ja2VkXCIsIHsgbWVzc2FnZTogZS5tZXNzYWdlLCBkZXRhaWxzOiBlLmRldGFpbHMgfSk7XG5cdFx0fVxuXHRcdHJldHVybiB1bmRlZmluZWQ7XG5cdH1dKTtcblxuXHRoYW5kbGVycy5zZXQoXCJzZXNzaW9uX2VuZFwiLCBbYXN5bmMgKGV2ZW50OiB1bmtub3duKSA9PiB7XG5cdFx0Y29uc3QgZSA9IGV2ZW50IGFzIFNlc3Npb25FbmRFdmVudDtcblx0XHRhd2FpdCBkaXNwYXRjaChcIlNlc3Npb25FbmRcIiwgeyByZWFzb246IGUucmVhc29uLCBzZXNzaW9uRmlsZTogZS5zZXNzaW9uRmlsZSB9KTtcblx0XHRyZXR1cm4gdW5kZWZpbmVkO1xuXHR9XSk7XG5cblx0aGFuZGxlcnMuc2V0KFwiYmVmb3JlX2NvbW1pdFwiLCBbYXN5bmMgKGV2ZW50OiB1bmtub3duKTogUHJvbWlzZTxCZWZvcmVDb21taXRFdmVudFJlc3VsdCB8IHVuZGVmaW5lZD4gPT4ge1xuXHRcdGNvbnN0IGUgPSBldmVudCBhcyBCZWZvcmVDb21taXRFdmVudDtcblx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCBkaXNwYXRjaChcIlByZUNvbW1pdFwiLCB7IG1lc3NhZ2U6IGUubWVzc2FnZSwgZmlsZXM6IGUuZmlsZXMsIGN3ZDogZS5jd2QsIGF1dGhvcjogZS5hdXRob3IgfSk7XG5cdFx0aWYgKCFyZXN1bHQpIHJldHVybiB1bmRlZmluZWQ7XG5cdFx0aWYgKHJlc3VsdC5ibG9jaykgcmV0dXJuIHsgY2FuY2VsOiB0cnVlLCByZWFzb246IHJlc3VsdC5yZWFzb24gfTtcblx0XHRpZiAocmVzdWx0Lm1lc3NhZ2UgIT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgbWVzc2FnZTogcmVzdWx0Lm1lc3NhZ2UgfTtcblx0XHRyZXR1cm4gdW5kZWZpbmVkO1xuXHR9XSk7XG5cblx0aGFuZGxlcnMuc2V0KFwiY29tbWl0XCIsIFthc3luYyAoZXZlbnQ6IHVua25vd24pID0+IHtcblx0XHRjb25zdCBlID0gZXZlbnQgYXMgQ29tbWl0RXZlbnQ7XG5cdFx0YXdhaXQgZGlzcGF0Y2goXCJQb3N0Q29tbWl0XCIsIHsgc2hhOiBlLnNoYSwgbWVzc2FnZTogZS5tZXNzYWdlLCBmaWxlczogZS5maWxlcywgY3dkOiBlLmN3ZCB9KTtcblx0XHRyZXR1cm4gdW5kZWZpbmVkO1xuXHR9XSk7XG5cblx0aGFuZGxlcnMuc2V0KFwiYmVmb3JlX3B1c2hcIiwgW2FzeW5jIChldmVudDogdW5rbm93bik6IFByb21pc2U8QmVmb3JlUHVzaEV2ZW50UmVzdWx0IHwgdW5kZWZpbmVkPiA9PiB7XG5cdFx0Y29uc3QgZSA9IGV2ZW50IGFzIEJlZm9yZVB1c2hFdmVudDtcblx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCBkaXNwYXRjaChcIlByZVB1c2hcIiwgeyByZW1vdGU6IGUucmVtb3RlLCBicmFuY2g6IGUuYnJhbmNoLCBjd2Q6IGUuY3dkIH0pO1xuXHRcdGlmIChyZXN1bHQ/LmJsb2NrKSByZXR1cm4geyBjYW5jZWw6IHRydWUsIHJlYXNvbjogcmVzdWx0LnJlYXNvbiB9O1xuXHRcdHJldHVybiB1bmRlZmluZWQ7XG5cdH1dKTtcblxuXHRoYW5kbGVycy5zZXQoXCJwdXNoXCIsIFthc3luYyAoZXZlbnQ6IHVua25vd24pID0+IHtcblx0XHRjb25zdCBlID0gZXZlbnQgYXMgUHVzaEV2ZW50O1xuXHRcdGF3YWl0IGRpc3BhdGNoKFwiUG9zdFB1c2hcIiwgeyByZW1vdGU6IGUucmVtb3RlLCBicmFuY2g6IGUuYnJhbmNoLCBjd2Q6IGUuY3dkIH0pO1xuXHRcdHJldHVybiB1bmRlZmluZWQ7XG5cdH1dKTtcblxuXHRoYW5kbGVycy5zZXQoXCJiZWZvcmVfcHJcIiwgW2FzeW5jIChldmVudDogdW5rbm93bik6IFByb21pc2U8QmVmb3JlUHJFdmVudFJlc3VsdCB8IHVuZGVmaW5lZD4gPT4ge1xuXHRcdGNvbnN0IGUgPSBldmVudCBhcyBCZWZvcmVQckV2ZW50O1xuXHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRpc3BhdGNoKFwiUHJlUHJcIiwge1xuXHRcdFx0YnJhbmNoOiBlLmJyYW5jaCxcblx0XHRcdHRhcmdldEJyYW5jaDogZS50YXJnZXRCcmFuY2gsXG5cdFx0XHR0aXRsZTogZS50aXRsZSxcblx0XHRcdGJvZHk6IGUuYm9keSxcblx0XHRcdGN3ZDogZS5jd2QsXG5cdFx0fSk7XG5cdFx0aWYgKCFyZXN1bHQpIHJldHVybiB1bmRlZmluZWQ7XG5cdFx0aWYgKHJlc3VsdC5ibG9jaykgcmV0dXJuIHsgY2FuY2VsOiB0cnVlLCByZWFzb246IHJlc3VsdC5yZWFzb24gfTtcblx0XHRpZiAocmVzdWx0LnRpdGxlICE9PSB1bmRlZmluZWQgfHwgcmVzdWx0LmJvZHkgIT09IHVuZGVmaW5lZCkge1xuXHRcdFx0cmV0dXJuIHsgdGl0bGU6IHJlc3VsdC50aXRsZSwgYm9keTogcmVzdWx0LmJvZHkgfTtcblx0XHR9XG5cdFx0cmV0dXJuIHVuZGVmaW5lZDtcblx0fV0pO1xuXG5cdGhhbmRsZXJzLnNldChcInByX29wZW5lZFwiLCBbYXN5bmMgKGV2ZW50OiB1bmtub3duKSA9PiB7XG5cdFx0Y29uc3QgZSA9IGV2ZW50IGFzIFByT3BlbmVkRXZlbnQ7XG5cdFx0YXdhaXQgZGlzcGF0Y2goXCJQb3N0UHJcIiwgeyB1cmw6IGUudXJsLCBicmFuY2g6IGUuYnJhbmNoLCB0YXJnZXRCcmFuY2g6IGUudGFyZ2V0QnJhbmNoLCBjd2Q6IGUuY3dkIH0pO1xuXHRcdHJldHVybiB1bmRlZmluZWQ7XG5cdH1dKTtcblxuXHRoYW5kbGVycy5zZXQoXCJiZWZvcmVfdmVyaWZ5XCIsIFthc3luYyAoZXZlbnQ6IHVua25vd24pOiBQcm9taXNlPEJlZm9yZVZlcmlmeUV2ZW50UmVzdWx0IHwgdW5kZWZpbmVkPiA9PiB7XG5cdFx0Y29uc3QgZSA9IGV2ZW50IGFzIEJlZm9yZVZlcmlmeUV2ZW50O1xuXHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRpc3BhdGNoKFwiUHJlVmVyaWZ5XCIsIHsgdW5pdFR5cGU6IGUudW5pdFR5cGUsIHVuaXRJZDogZS51bml0SWQsIGN3ZDogZS5jd2QgfSk7XG5cdFx0aWYgKHJlc3VsdD8uYmxvY2spIHJldHVybiB7IGNhbmNlbDogdHJ1ZSwgcmVhc29uOiByZXN1bHQucmVhc29uIH07XG5cdFx0cmV0dXJuIHVuZGVmaW5lZDtcblx0fV0pO1xuXG5cdGhhbmRsZXJzLnNldChcInZlcmlmeV9yZXN1bHRcIiwgW2FzeW5jIChldmVudDogdW5rbm93bikgPT4ge1xuXHRcdGNvbnN0IGUgPSBldmVudCBhcyBWZXJpZnlSZXN1bHRFdmVudDtcblx0XHRhd2FpdCBkaXNwYXRjaChcIlBvc3RWZXJpZnlcIiwge1xuXHRcdFx0cGFzc2VkOiBlLnBhc3NlZCxcblx0XHRcdGZhaWx1cmVzOiBlLmZhaWx1cmVzLFxuXHRcdFx0dW5pdFR5cGU6IGUudW5pdFR5cGUsXG5cdFx0XHR1bml0SWQ6IGUudW5pdElkLFxuXHRcdFx0Y3dkOiBlLmN3ZCxcblx0XHR9KTtcblx0XHRyZXR1cm4gdW5kZWZpbmVkO1xuXHR9XSk7XG5cblx0aGFuZGxlcnMuc2V0KFwiYnVkZ2V0X3RocmVzaG9sZFwiLCBbYXN5bmMgKGV2ZW50OiB1bmtub3duKTogUHJvbWlzZTxCdWRnZXRUaHJlc2hvbGRFdmVudFJlc3VsdCB8IHVuZGVmaW5lZD4gPT4ge1xuXHRcdGNvbnN0IGUgPSBldmVudCBhcyBCdWRnZXRUaHJlc2hvbGRFdmVudDtcblx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCBkaXNwYXRjaChcIkJ1ZGdldFRocmVzaG9sZFwiLCB7XG5cdFx0XHRmcmFjdGlvbjogZS5mcmFjdGlvbixcblx0XHRcdHNwZW50OiBlLnNwZW50LFxuXHRcdFx0bGltaXQ6IGUubGltaXQsXG5cdFx0XHRjdXJyZW5jeTogZS5jdXJyZW5jeSxcblx0XHR9KTtcblx0XHRpZiAocmVzdWx0Py5hY3Rpb24pIHJldHVybiB7IGFjdGlvbjogcmVzdWx0LmFjdGlvbiB9O1xuXHRcdHJldHVybiB1bmRlZmluZWQ7XG5cdH1dKTtcblxuXHRoYW5kbGVycy5zZXQoXCJtaWxlc3RvbmVfc3RhcnRcIiwgW2FzeW5jIChldmVudDogdW5rbm93bikgPT4ge1xuXHRcdGNvbnN0IGUgPSBldmVudCBhcyBNaWxlc3RvbmVTdGFydEV2ZW50O1xuXHRcdGF3YWl0IGRpc3BhdGNoKFwiUHJlTWlsZXN0b25lXCIsIHsgbWlsZXN0b25lSWQ6IGUubWlsZXN0b25lSWQsIHRpdGxlOiBlLnRpdGxlLCBjd2Q6IGUuY3dkIH0pO1xuXHRcdHJldHVybiB1bmRlZmluZWQ7XG5cdH1dKTtcblxuXHRoYW5kbGVycy5zZXQoXCJtaWxlc3RvbmVfZW5kXCIsIFthc3luYyAoZXZlbnQ6IHVua25vd24pID0+IHtcblx0XHRjb25zdCBlID0gZXZlbnQgYXMgTWlsZXN0b25lRW5kRXZlbnQ7XG5cdFx0YXdhaXQgZGlzcGF0Y2goXCJQb3N0TWlsZXN0b25lXCIsIHsgbWlsZXN0b25lSWQ6IGUubWlsZXN0b25lSWQsIHN0YXR1czogZS5zdGF0dXMsIGN3ZDogZS5jd2QgfSk7XG5cdFx0cmV0dXJuIHVuZGVmaW5lZDtcblx0fV0pO1xuXG5cdGhhbmRsZXJzLnNldChcInVuaXRfc3RhcnRcIiwgW2FzeW5jIChldmVudDogdW5rbm93bikgPT4ge1xuXHRcdGNvbnN0IGUgPSBldmVudCBhcyBVbml0U3RhcnRFdmVudDtcblx0XHRhd2FpdCBkaXNwYXRjaChcIlByZVVuaXRcIiwge1xuXHRcdFx0dW5pdFR5cGU6IGUudW5pdFR5cGUsXG5cdFx0XHR1bml0SWQ6IGUudW5pdElkLFxuXHRcdFx0bWlsZXN0b25lSWQ6IGUubWlsZXN0b25lSWQsXG5cdFx0XHRjd2Q6IGUuY3dkLFxuXHRcdH0pO1xuXHRcdHJldHVybiB1bmRlZmluZWQ7XG5cdH1dKTtcblxuXHRoYW5kbGVycy5zZXQoXCJ1bml0X2VuZFwiLCBbYXN5bmMgKGV2ZW50OiB1bmtub3duKSA9PiB7XG5cdFx0Y29uc3QgZSA9IGV2ZW50IGFzIFVuaXRFbmRFdmVudDtcblx0XHRhd2FpdCBkaXNwYXRjaChcIlBvc3RVbml0XCIsIHtcblx0XHRcdHVuaXRUeXBlOiBlLnVuaXRUeXBlLFxuXHRcdFx0dW5pdElkOiBlLnVuaXRJZCxcblx0XHRcdG1pbGVzdG9uZUlkOiBlLm1pbGVzdG9uZUlkLFxuXHRcdFx0c3RhdHVzOiBlLnN0YXR1cyxcblx0XHRcdGN3ZDogZS5jd2QsXG5cdFx0fSk7XG5cdFx0cmV0dXJuIHVuZGVmaW5lZDtcblx0fV0pO1xuXG5cdGhhbmRsZXJzLnNldChcInNlc3Npb25fYmVmb3JlX2NvbXBhY3RcIiwgW2FzeW5jIChldmVudDogdW5rbm93bik6IFByb21pc2U8U2Vzc2lvbkJlZm9yZUNvbXBhY3RSZXN1bHQgfCB1bmRlZmluZWQ+ID0+IHtcblx0XHRjb25zdCBlID0gZXZlbnQgYXMgU2Vzc2lvbkJlZm9yZUNvbXBhY3RFdmVudDtcblx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCBkaXNwYXRjaChcIlByZUNvbXBhY3RcIiwgeyBicmFuY2hFbnRyaWVzOiBlLmJyYW5jaEVudHJpZXMubGVuZ3RoIH0pO1xuXHRcdGlmIChyZXN1bHQ/LmJsb2NrKSByZXR1cm4geyBjYW5jZWw6IHRydWUgfTtcblx0XHRyZXR1cm4gdW5kZWZpbmVkO1xuXHR9XSk7XG5cblx0aGFuZGxlcnMuc2V0KFwic2Vzc2lvbl9jb21wYWN0XCIsIFthc3luYyAoZXZlbnQ6IHVua25vd24pID0+IHtcblx0XHRjb25zdCBlID0gZXZlbnQgYXMgU2Vzc2lvbkNvbXBhY3RFdmVudDtcblx0XHRhd2FpdCBkaXNwYXRjaChcIlBvc3RDb21wYWN0XCIsIHsgZnJvbUV4dGVuc2lvbjogZS5mcm9tRXh0ZW5zaW9uIH0pO1xuXHRcdHJldHVybiB1bmRlZmluZWQ7XG5cdH1dKTtcblxuXHRjb25zdCBkaXNwb3NlID0gZXh0ZW5zaW9uUnVubmVyLmluc3RhbGxIb29rQnJpZGdlKFwiX19ob29rc19fXCIsIGhhbmRsZXJzKTtcblxuXHRyZXR1cm4ge1xuXHRcdGRpc3Bvc2UsXG5cdFx0YXN5bmMgZmlyZVNlc3Npb25TdGFydCgpIHtcblx0XHRcdGNvbnN0IHBheWxvYWQ6IFNlc3Npb25TdGFydEV2ZW50ID0geyB0eXBlOiBcInNlc3Npb25fc3RhcnRcIiB9O1xuXHRcdFx0YXdhaXQgZGlzcGF0Y2goXCJTZXNzaW9uU3RhcnRcIiwgeyBjd2QsIHR5cGU6IHBheWxvYWQudHlwZSB9KTtcblx0XHR9LFxuXHRcdGFzeW5jIGZpcmVTZXNzaW9uRW5kKHJlYXNvbikge1xuXHRcdFx0YXdhaXQgZGlzcGF0Y2goXCJTZXNzaW9uRW5kXCIsIHsgcmVhc29uIH0pO1xuXHRcdH0sXG5cdH07XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFhQSxTQUFTLGFBQWE7QUFDdEIsU0FBUyxrQkFBa0I7QUFDM0IsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsdUJBQXVCO0FBcUNoQyxNQUFNLGVBQWU7QUFDckIsTUFBTSxxQkFBcUI7QUE4QnBCLFNBQVMsc0JBQXNCLEtBQXNCO0FBQzNELFNBQU8sV0FBVyxLQUFLLEtBQUssaUJBQWlCLFlBQVksQ0FBQztBQUMzRDtBQUVBLFNBQVMsYUFDUixNQUNBLGdCQUNBLGlCQUNBLEtBQ2U7QUFDZixRQUFNLFNBQXVCLENBQUM7QUFDOUIsYUFBVyxTQUFTLGVBQWUsUUFBUSxJQUFJLEtBQUssQ0FBQyxHQUFHO0FBQ3ZELFdBQU8sS0FBSyxFQUFFLEdBQUcsT0FBTyxPQUFPLFNBQVMsQ0FBQztBQUFBLEVBQzFDO0FBQ0EsTUFBSSxnQkFBZ0IsUUFBUSxJQUFJLEdBQUcsVUFBVSxzQkFBc0IsR0FBRyxHQUFHO0FBQ3hFLGVBQVcsU0FBUyxnQkFBZ0IsTUFBTSxJQUFJLEtBQUssQ0FBQyxHQUFHO0FBQ3RELGFBQU8sS0FBSyxFQUFFLEdBQUcsT0FBTyxPQUFPLFVBQVUsQ0FBQztBQUFBLElBQzNDO0FBQUEsRUFDRDtBQUNBLFNBQU87QUFDUjtBQUVBLFNBQVMsY0FBYyxPQUFrQixTQUEyQztBQUNuRixRQUFNLFNBQVMsTUFBTTtBQUNyQixNQUFJLENBQUMsT0FBUSxRQUFPO0FBRXBCLE1BQUksT0FBTyxTQUFTLFFBQVc7QUFDOUIsVUFBTSxRQUFRLE1BQU0sUUFBUSxPQUFPLElBQUksSUFBSSxP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
