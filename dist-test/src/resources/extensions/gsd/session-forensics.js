import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { gsdRoot } from "./paths.js";
import { truncateWithEllipsis } from "../shared/format-utils.js";
import { nativeParseJsonlTail } from "./native-parser-bridge.js";
import { MAX_JSONL_BYTES, parseJSONL } from "./jsonl-utils.js";
import { nativeWorkingTreeStatus, nativeDiffStat } from "./native-git-bridge.js";
function extractLastSession(entries) {
  let lastSessionIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "session") {
      lastSessionIdx = i;
      break;
    }
  }
  return lastSessionIdx >= 0 ? entries.slice(lastSessionIdx) : entries;
}
function extractTrace(entries) {
  const toolCalls = [];
  const filesWritten = [];
  const filesRead = [];
  const commandsRun = [];
  const errors = [];
  let lastReasoning = "";
  const pendingTools = /* @__PURE__ */ new Map();
  const seenWritten = /* @__PURE__ */ new Set();
  const seenRead = /* @__PURE__ */ new Set();
  for (const raw of entries) {
    const entry = raw;
    if (entry.type !== "message" || !entry.message) continue;
    const msg = entry.message;
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text" && part.text) {
          lastReasoning = String(part.text);
        }
        if (part.type === "toolCall") {
          const name = String(part.name || "unknown").toLowerCase();
          const input = part.arguments || part.input || {};
          const id = String(part.id || "");
          if (id) {
            pendingTools.set(id, { name, input });
          }
          const path = input.path ? String(input.path) : null;
          if (path) {
            if (name === "write" || name === "edit") {
              if (!seenWritten.has(path)) {
                seenWritten.add(path);
                filesWritten.push(path);
              }
            } else if (name === "read") {
              if (!seenRead.has(path)) {
                seenRead.add(path);
                filesRead.push(path);
              }
            }
          }
          if ((name === "bash" || name === "bg_shell") && input.command) {
            commandsRun.push({ command: String(input.command), failed: false });
          }
        }
      }
    }
    if (msg.role === "toolResult") {
      const id = String(msg.toolCallId || "");
      const isError = !!msg.isError;
      const resultText = extractResultText(msg);
      const pending = pendingTools.get(id);
      if (pending) {
        toolCalls.push({
          name: pending.name,
          input: redactInput(pending.name, pending.input),
          result: resultText.slice(0, 500),
          isError
        });
        pendingTools.delete(id);
        if (isError && (pending.name === "bash" || pending.name === "bg_shell")) {
          const lastCmd = findLast(commandsRun, (c) => c.command === String(pending.input.command));
          if (lastCmd) lastCmd.failed = true;
        }
      }
      if (isError && resultText) {
        const trimmed = resultText.trim();
        const isBenignNoMatch = pending?.name === "bash" && /^\(no output\)\s*\n\s*Command exited with code 1$/m.test(trimmed);
        const isUserSkip = /^Skipped due to queued user message/i.test(trimmed);
        if (!isBenignNoMatch && !isUserSkip) {
          errors.push(resultText.slice(0, 300));
        }
      }
    }
  }
  for (const [, pending] of pendingTools) {
    toolCalls.push({
      name: pending.name,
      input: redactInput(pending.name, pending.input),
      isError: false
    });
  }
  return {
    toolCalls,
    filesWritten,
    filesRead,
    commandsRun,
    errors,
    lastReasoning: lastReasoning.slice(-600).trim(),
    toolCallCount: toolCalls.length
  };
}
function getGitChanges(basePath) {
  try {
    const status = nativeWorkingTreeStatus(basePath);
    if (!status) return null;
    const diffStat = nativeDiffStat(basePath, "HEAD", "WORKDIR").summary;
    const stagedStat = nativeDiffStat(basePath, "HEAD", "INDEX").summary;
    const parts = [];
    if (status) parts.push(`Status:
${status}`);
    if (stagedStat) parts.push(`Staged:
${stagedStat}`);
    if (diffStat) parts.push(`Unstaged:
${diffStat}`);
    return parts.join("\n\n");
  } catch {
    return null;
  }
}
function synthesizeCrashRecovery(basePath, unitType, unitId, sessionFile, activityDir) {
  try {
    let trace = null;
    if (sessionFile && existsSync(sessionFile)) {
      const nativeResult = nativeParseJsonlTail(sessionFile, MAX_JSONL_BYTES);
      if (nativeResult) {
        const sessionEntries = extractLastSession(nativeResult.entries);
        trace = extractTrace(sessionEntries);
      } else {
        const stat = statSync(sessionFile, { throwIfNoEntry: false });
        const fileSize = stat?.size ?? 0;
        if (fileSize <= MAX_JSONL_BYTES * 2) {
          const raw = readFileSync(sessionFile, "utf-8");
          const allEntries = parseJSONL(raw);
          const sessionEntries = extractLastSession(allEntries);
          trace = extractTrace(sessionEntries);
        }
      }
    }
    if (!trace || trace.toolCallCount === 0) {
      const fallbackTrace = readLastActivityLog(activityDir);
      if (fallbackTrace && fallbackTrace.toolCallCount > 0) {
        trace = fallbackTrace;
      }
    }
    if (!trace) {
      trace = {
        toolCalls: [],
        filesWritten: [],
        filesRead: [],
        commandsRun: [],
        errors: [],
        lastReasoning: "",
        toolCallCount: 0
      };
    }
    const gitChanges = getGitChanges(basePath);
    const prompt = formatRecoveryPrompt(unitType, unitId, trace, gitChanges);
    return { unitType, unitId, trace, gitChanges, prompt };
  } catch {
    return null;
  }
}
function getDeepDiagnostic(basePath, worktreePath) {
  let trace = null;
  try {
    if (worktreePath) {
      const wtActivityDir = join(gsdRoot(worktreePath), "activity");
      trace = readLastActivityLog(wtActivityDir);
    }
  } catch {
  }
  if (!trace || trace.toolCallCount === 0) {
    const activityDir = join(gsdRoot(basePath), "activity");
    trace = readLastActivityLog(activityDir);
  }
  if (!trace || trace.toolCallCount === 0) return null;
  return formatTraceSummary(trace);
}
function readActiveMilestoneId(basePath) {
  try {
    const statePath = join(gsdRoot(basePath), "STATE.md");
    if (!existsSync(statePath)) return null;
    const content = readFileSync(statePath, "utf-8");
    const match = /\*\*Active Milestone:\*\*\s*(\S+)/i.exec(content);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}
function formatRecoveryPrompt(unitType, unitId, trace, gitChanges) {
  const sections = [];
  sections.push(
    "## Recovery Briefing",
    "",
    `You are resuming \`${unitType}\` for \`${unitId}\` after an interruption.`,
    `The previous session completed **${trace.toolCallCount} tool calls** before stopping.`,
    "Use this briefing to pick up exactly where it left off. Do NOT redo completed work."
  );
  if (trace.toolCalls.length > 0) {
    sections.push("", "### Completed Tool Calls");
    const summary = compressToolCallTrace(trace.toolCalls);
    sections.push(summary);
  }
  if (trace.filesWritten.length > 0) {
    sections.push(
      "",
      "### Files Already Written/Edited",
      ...trace.filesWritten.map((f) => `- \`${f}\``),
      "",
      "These files exist on disk from the previous run. Verify they look correct before continuing."
    );
  }
  const significantCommands = trace.commandsRun.filter(
    (c) => !c.command.startsWith("git ") || c.failed
  );
  if (significantCommands.length > 0) {
    sections.push("", "### Commands Already Run");
    for (const c of significantCommands.slice(-10)) {
      const status = c.failed ? " \u274C" : " \u2713";
      sections.push(`- \`${truncateWithEllipsis(c.command, 121)}\`${status}`);
    }
  }
  if (trace.errors.length > 0) {
    sections.push(
      "",
      "### Errors Before Interruption",
      ...trace.errors.slice(-3).map((e) => `- ${truncateWithEllipsis(e, 201)}`)
    );
  }
  if (gitChanges) {
    sections.push(
      "",
      "### Current Git State (filesystem truth)",
      "```",
      gitChanges,
      "```"
    );
  }
  if (trace.lastReasoning) {
    sections.push(
      "",
      "### Last Agent Reasoning Before Interruption",
      `> ${trace.lastReasoning.replace(/\n/g, "\n> ")}`
    );
  }
  sections.push(
    "",
    "### Resume Instructions",
    "1. Check the task plan for remaining work",
    "2. Verify files listed above exist and look correct on disk",
    "3. Continue from where the previous session left off",
    "4. Do NOT re-read files or re-run commands that already succeeded above"
  );
  return sections.join("\n");
}
function compressToolCallTrace(calls) {
  const lines = [];
  let readBatch = [];
  function flushReads() {
    if (readBatch.length === 0) return;
    if (readBatch.length <= 2) {
      for (const path of readBatch) lines.push(`  read \`${path}\``);
    } else {
      lines.push(`  read ${readBatch.length} files: ${readBatch.map((p) => `\`${basename(p)}\``).join(", ")}`);
    }
    readBatch = [];
  }
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    const num = i + 1;
    if (call.name === "read" && call.input.path) {
      readBatch.push(String(call.input.path));
      continue;
    }
    flushReads();
    const err = call.isError ? " \u274C" : "";
    if (call.name === "write" || call.name === "edit") {
      lines.push(`${num}. ${call.name} \`${call.input.path || "?"}\`${err}`);
    } else if (call.name === "bash" || call.name === "bg_shell") {
      const cmd = truncateWithEllipsis(String(call.input.command || ""), 81);
      lines.push(`${num}. ${call.name}: \`${cmd}\`${err}`);
    } else {
      lines.push(`${num}. ${call.name}${err}`);
    }
  }
  flushReads();
  return lines.join("\n");
}
function formatTraceSummary(trace) {
  const parts = [];
  parts.push(`Tool calls completed: ${trace.toolCallCount}`);
  if (trace.filesWritten.length > 0) {
    parts.push(`Files written: ${trace.filesWritten.map((f) => `\`${f}\``).join(", ")}`);
  }
  if (trace.commandsRun.length > 0) {
    const cmds = trace.commandsRun.slice(-5).map((c) => `\`${truncateWithEllipsis(c.command, 81)}\`${c.failed ? " \u274C" : ""}`);
    parts.push(`Commands run: ${cmds.join(", ")}`);
  }
  if (trace.errors.length > 0) {
    parts.push(`Errors: ${trace.errors.slice(-3).join("; ")}`);
  }
  return parts.join("\n");
}
function readLastActivityLog(activityDir) {
  if (!activityDir) return null;
  try {
    if (!existsSync(activityDir)) return null;
    const files = readdirSync(activityDir).filter((f) => f.endsWith(".jsonl")).sort();
    if (files.length === 0) return null;
    const lastFile = files[files.length - 1];
    const filePath = join(activityDir, lastFile);
    const nativeResult = nativeParseJsonlTail(filePath, MAX_JSONL_BYTES);
    if (nativeResult) {
      return extractTrace(nativeResult.entries);
    }
    const raw = readFileSync(filePath, "utf-8");
    return extractTrace(parseJSONL(raw));
  } catch {
    return null;
  }
}
function extractResultText(msg) {
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((p) => p.type === "text").map((p) => String(p.text || "")).join(" ");
  }
  return "";
}
function redactInput(name, input) {
  const safe = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "content" || key === "oldText" || key === "newText") {
      safe[key] = typeof value === "string" ? truncateWithEllipsis(value, 101) : "[redacted]";
    } else {
      safe[key] = value;
    }
  }
  return safe;
}
function findLast(arr, predicate) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i])) return arr[i];
  }
  return void 0;
}
export {
  extractTrace,
  getDeepDiagnostic,
  readActiveMilestoneId,
  synthesizeCrashRecovery
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9zZXNzaW9uLWZvcmVuc2ljcy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBHU0QgU2Vzc2lvbiBGb3JlbnNpY3MgXHUyMDE0IERlZXAgYW5hbHlzaXMgb2YgcGkgc2Vzc2lvbiBKU09OTCBmaWxlc1xuICpcbiAqIFBpJ3MgU2Vzc2lvbk1hbmFnZXIgcGVyc2lzdHMgZXZlcnkgZW50cnkgdG8gZGlzayB2aWEgYXBwZW5kRmlsZVN5bmMgYXMgaXRcbiAqIGhhcHBlbnMuIFdoZW4gYSBjcmFzaCBvY2N1cnMsIHRoZSBzZXNzaW9uIEpTT05MIG9uIGRpc2sgY29udGFpbnMgZXZlcnkgdG9vbFxuICogY2FsbCwgZXZlcnkgYXNzaXN0YW50IHJlc3BvbnNlLCBhbmQgZXZlcnkgZXJyb3IgdXAgdG8gdGhlIG1vbWVudCBvZiBkZWF0aC5cbiAqXG4gKiBUaGlzIG1vZHVsZSByZWFkcyB0aGF0IGZpbGUgYW5kIHJlY29uc3RydWN0cyBhIHN0cnVjdHVyZWQgZXhlY3V0aW9uIHRyYWNlXG4gKiB0aGF0IHRlbGxzIHRoZSByZWNvdmVyaW5nIGFnZW50IGV4YWN0bHkgd2hhdCBoYXBwZW5lZCwgd2hhdCBjaGFuZ2VkLCBhbmRcbiAqIHdoZXJlIHRvIHJlc3VtZS5cbiAqXG4gKiBVc2VkIGJ5OlxuICogLSBDcmFzaCByZWNvdmVyeSAocmVhZGluZyB0aGUgc3Vydml2aW5nIHBpIHNlc3Npb24gZmlsZSlcbiAqIC0gU3R1Y2stcmV0cnkgZGlhZ25vc3RpY3MgKHJlYWRpbmcgR1NEIGFjdGl2aXR5IGxvZyBjb3BpZXMpXG4gKlxuICogRW50cnkgZm9ybWF0ICh2ZXJpZmllZCBhZ2FpbnN0IHJlYWwgcGkgc2Vzc2lvbiBmaWxlcyk6XG4gKiAtIFRvb2wgY2FsbHM6IHsgdHlwZTogXCJ0b29sQ2FsbFwiLCBuYW1lOiBcImJhc2hcIiwgaWQ6IFwidG9vbHVfLi4uXCIsIGFyZ3VtZW50czogeyBjb21tYW5kOiBcIi4uLlwiIH0gfVxuICogLSBUb29sIHJlc3VsdHM6IHsgcm9sZTogXCJ0b29sUmVzdWx0XCIsIHRvb2xDYWxsSWQ6IFwidG9vbHVfLi4uXCIsIHRvb2xOYW1lOiBcImJhc2hcIiwgaXNFcnJvcjogYm9vbCwgY29udGVudDogLi4uIH1cbiAqL1xuXG5pbXBvcnQgeyByZWFkRmlsZVN5bmMsIHJlYWRkaXJTeW5jLCBleGlzdHNTeW5jLCBzdGF0U3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBiYXNlbmFtZSwgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGdzZFJvb3QgfSBmcm9tIFwiLi9wYXRocy5qc1wiO1xuaW1wb3J0IHsgdHJ1bmNhdGVXaXRoRWxsaXBzaXMgfSBmcm9tIFwiLi4vc2hhcmVkL2Zvcm1hdC11dGlscy5qc1wiO1xuaW1wb3J0IHsgbmF0aXZlUGFyc2VKc29ubFRhaWwgfSBmcm9tIFwiLi9uYXRpdmUtcGFyc2VyLWJyaWRnZS5qc1wiO1xuaW1wb3J0IHsgTUFYX0pTT05MX0JZVEVTLCBwYXJzZUpTT05MIH0gZnJvbSBcIi4vanNvbmwtdXRpbHMuanNcIjtcbmltcG9ydCB7IG5hdGl2ZVdvcmtpbmdUcmVlU3RhdHVzLCBuYXRpdmVEaWZmU3RhdCB9IGZyb20gXCIuL25hdGl2ZS1naXQtYnJpZGdlLmpzXCI7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUeXBlcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGludGVyZmFjZSBUb29sQ2FsbCB7XG4gIG5hbWU6IHN0cmluZztcbiAgaW5wdXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICByZXN1bHQ/OiBzdHJpbmc7XG4gIGlzRXJyb3I6IGJvb2xlYW47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRXhlY3V0aW9uVHJhY2Uge1xuICAvKiogT3JkZXJlZCBsaXN0IG9mIHRvb2wgY2FsbHMgd2l0aCByZXN1bHRzICovXG4gIHRvb2xDYWxsczogVG9vbENhbGxbXTtcbiAgLyoqIEZpbGVzIHdyaXR0ZW4gb3IgZWRpdGVkIChkZWR1cGxpY2F0ZWQsIG9yZGVyZWQgYnkgZmlyc3Qgb2NjdXJyZW5jZSkgKi9cbiAgZmlsZXNXcml0dGVuOiBzdHJpbmdbXTtcbiAgLyoqIEZpbGVzIHJlYWQgKGRlZHVwbGljYXRlZCkgKi9cbiAgZmlsZXNSZWFkOiBzdHJpbmdbXTtcbiAgLyoqIFNoZWxsIGNvbW1hbmRzIGV4ZWN1dGVkIHdpdGggZXhpdCBzdGF0dXMgKi9cbiAgY29tbWFuZHNSdW46IHsgY29tbWFuZDogc3RyaW5nOyBmYWlsZWQ6IGJvb2xlYW4gfVtdO1xuICAvKiogVG9vbCBlcnJvcnMgZW5jb3VudGVyZWQgKi9cbiAgZXJyb3JzOiBzdHJpbmdbXTtcbiAgLyoqIFRoZSBhZ2VudCdzIGxhc3QgcmVhc29uaW5nIC8gdGV4dCBvdXRwdXQgYmVmb3JlIGNyYXNoICovXG4gIGxhc3RSZWFzb25pbmc6IHN0cmluZztcbiAgLyoqIFRvdGFsIHRvb2wgY2FsbHMgY29tcGxldGVkIChoYXZlIG1hdGNoaW5nIHJlc3VsdHMpICovXG4gIHRvb2xDYWxsQ291bnQ6IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBSZWNvdmVyeUJyaWVmaW5nIHtcbiAgLyoqIFdoYXQgdGhlIGFnZW50IHdhcyBkb2luZyAqL1xuICB1bml0VHlwZTogc3RyaW5nO1xuICB1bml0SWQ6IHN0cmluZztcbiAgLyoqIFN0cnVjdHVyZWQgZXhlY3V0aW9uIHRyYWNlICovXG4gIHRyYWNlOiBFeGVjdXRpb25UcmFjZTtcbiAgLyoqIEdpdCBzdGF0ZTogZmlsZXMgbW9kaWZpZWQvYWRkZWQvZGVsZXRlZCBzaW5jZSB1bml0IHN0YXJ0ZWQgKi9cbiAgZ2l0Q2hhbmdlczogc3RyaW5nIHwgbnVsbDtcbiAgLyoqIEZvcm1hdHRlZCBwcm9tcHQgc2VjdGlvbiByZWFkeSBmb3IgaW5qZWN0aW9uICovXG4gIHByb21wdDogc3RyaW5nO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgSlNPTkwgUGFyc2luZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbi8vIE1BWF9KU09OTF9CWVRFUyBhbmQgcGFyc2VKU09OTCBhcmUgaW1wb3J0ZWQgZnJvbSAuL2pzb25sLXV0aWxzLmpzXG5cbi8qKlxuICogRmluZCB0aGUgZW50cmllcyBiZWxvbmdpbmcgdG8gdGhlIGxhc3Qgc2Vzc2lvbiBpbiBhIEpTT05MIGZpbGUuXG4gKiBBdXRvLW1vZGUgY3JlYXRlcyBhIG5ldyBzZXNzaW9uIHBlciB1bml0LCBzbyB0aGUgbGFzdCBzZXNzaW9uIGhlYWRlclxuICogbWFya3MgdGhlIHN0YXJ0IG9mIHRoZSBjcmFzaGVkIHVuaXQncyBlbnRyaWVzLlxuICovXG5mdW5jdGlvbiBleHRyYWN0TGFzdFNlc3Npb24oZW50cmllczogdW5rbm93bltdKTogdW5rbm93bltdIHtcbiAgbGV0IGxhc3RTZXNzaW9uSWR4ID0gLTE7XG4gIGZvciAobGV0IGkgPSBlbnRyaWVzLmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7XG4gICAgY29uc3QgZW50cnkgPSBlbnRyaWVzW2ldIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIGlmIChlbnRyeS50eXBlID09PSBcInNlc3Npb25cIikge1xuICAgICAgbGFzdFNlc3Npb25JZHggPSBpO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICB9XG4gIHJldHVybiBsYXN0U2Vzc2lvbklkeCA+PSAwID8gZW50cmllcy5zbGljZShsYXN0U2Vzc2lvbklkeCkgOiBlbnRyaWVzO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVHJhY2UgRXh0cmFjdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBFeHRyYWN0IGEgc3RydWN0dXJlZCBleGVjdXRpb24gdHJhY2UgZnJvbSByYXcgc2Vzc2lvbiBlbnRyaWVzLlxuICogV29ya3Mgd2l0aCBib3RoIHBpIHNlc3Npb24gSlNPTkwgYW5kIEdTRCBhY3Rpdml0eSBsb2cgSlNPTkwuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBleHRyYWN0VHJhY2UoZW50cmllczogdW5rbm93bltdKTogRXhlY3V0aW9uVHJhY2Uge1xuICBjb25zdCB0b29sQ2FsbHM6IFRvb2xDYWxsW10gPSBbXTtcbiAgY29uc3QgZmlsZXNXcml0dGVuOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBmaWxlc1JlYWQ6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IGNvbW1hbmRzUnVuOiB7IGNvbW1hbmQ6IHN0cmluZzsgZmFpbGVkOiBib29sZWFuIH1bXSA9IFtdO1xuICBjb25zdCBlcnJvcnM6IHN0cmluZ1tdID0gW107XG4gIGxldCBsYXN0UmVhc29uaW5nID0gXCJcIjtcblxuICAvLyBUcmFjayBwZW5kaW5nIHRvb2wgY2FsbHMgYnkgSUQgZm9yIG1hdGNoaW5nIHdpdGggcmVzdWx0c1xuICBjb25zdCBwZW5kaW5nVG9vbHMgPSBuZXcgTWFwPHN0cmluZywgeyBuYW1lOiBzdHJpbmc7IGlucHV0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB9PigpO1xuXG4gIGNvbnN0IHNlZW5Xcml0dGVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IHNlZW5SZWFkID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cbiAgZm9yIChjb25zdCByYXcgb2YgZW50cmllcykge1xuICAgIGNvbnN0IGVudHJ5ID0gcmF3IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIGlmIChlbnRyeS50eXBlICE9PSBcIm1lc3NhZ2VcIiB8fCAhZW50cnkubWVzc2FnZSkgY29udGludWU7XG4gICAgY29uc3QgbXNnID0gZW50cnkubWVzc2FnZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcblxuICAgIC8vIFx1MjUwMFx1MjUwMCBBc3Npc3RhbnQgbWVzc2FnZXM6IHRvb2wgY2FsbHMgKyByZWFzb25pbmcgXHUyNTAwXHUyNTAwXG4gICAgaWYgKG1zZy5yb2xlID09PSBcImFzc2lzdGFudFwiICYmIEFycmF5LmlzQXJyYXkobXNnLmNvbnRlbnQpKSB7XG4gICAgICBmb3IgKGNvbnN0IHBhcnQgb2YgbXNnLmNvbnRlbnQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj5bXSkge1xuICAgICAgICAvLyBUZXh0IHJlYXNvbmluZ1xuICAgICAgICBpZiAocGFydC50eXBlID09PSBcInRleHRcIiAmJiBwYXJ0LnRleHQpIHtcbiAgICAgICAgICBsYXN0UmVhc29uaW5nID0gU3RyaW5nKHBhcnQudGV4dCk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBUb29sIGNhbGwgaW5pdGlhdGlvblxuICAgICAgICAvLyBQaSBmb3JtYXQ6IHsgdHlwZTogXCJ0b29sQ2FsbFwiLCBuYW1lOiBcImJhc2hcIiwgaWQ6IFwidG9vbHVfLi4uXCIsIGFyZ3VtZW50czogeyBjb21tYW5kOiBcIi4uLlwiIH0gfVxuICAgICAgICBpZiAocGFydC50eXBlID09PSBcInRvb2xDYWxsXCIpIHtcbiAgICAgICAgICBjb25zdCBuYW1lID0gU3RyaW5nKHBhcnQubmFtZSB8fCBcInVua25vd25cIikudG9Mb3dlckNhc2UoKTtcbiAgICAgICAgICBjb25zdCBpbnB1dCA9IChwYXJ0LmFyZ3VtZW50cyB8fCBwYXJ0LmlucHV0IHx8IHt9KSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgICAgICBjb25zdCBpZCA9IFN0cmluZyhwYXJ0LmlkIHx8IFwiXCIpO1xuXG4gICAgICAgICAgaWYgKGlkKSB7XG4gICAgICAgICAgICBwZW5kaW5nVG9vbHMuc2V0KGlkLCB7IG5hbWUsIGlucHV0IH0pO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIC8vIFRyYWNrIGZpbGUgb3BlcmF0aW9uc1xuICAgICAgICAgIGNvbnN0IHBhdGggPSBpbnB1dC5wYXRoID8gU3RyaW5nKGlucHV0LnBhdGgpIDogbnVsbDtcbiAgICAgICAgICBpZiAocGF0aCkge1xuICAgICAgICAgICAgaWYgKG5hbWUgPT09IFwid3JpdGVcIiB8fCBuYW1lID09PSBcImVkaXRcIikge1xuICAgICAgICAgICAgICBpZiAoIXNlZW5Xcml0dGVuLmhhcyhwYXRoKSkgeyBzZWVuV3JpdHRlbi5hZGQocGF0aCk7IGZpbGVzV3JpdHRlbi5wdXNoKHBhdGgpOyB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKG5hbWUgPT09IFwicmVhZFwiKSB7XG4gICAgICAgICAgICAgIGlmICghc2VlblJlYWQuaGFzKHBhdGgpKSB7IHNlZW5SZWFkLmFkZChwYXRoKTsgZmlsZXNSZWFkLnB1c2gocGF0aCk7IH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyBUcmFjayBzaGVsbCBjb21tYW5kc1xuICAgICAgICAgIGlmICgobmFtZSA9PT0gXCJiYXNoXCIgfHwgbmFtZSA9PT0gXCJiZ19zaGVsbFwiKSAmJiBpbnB1dC5jb21tYW5kKSB7XG4gICAgICAgICAgICBjb21tYW5kc1J1bi5wdXNoKHsgY29tbWFuZDogU3RyaW5nKGlucHV0LmNvbW1hbmQpLCBmYWlsZWQ6IGZhbHNlIH0pO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIC8vIFx1MjUwMFx1MjUwMCBUb29sIHJlc3VsdHM6IG1hdGNoIHdpdGggcGVuZGluZyBjYWxscyBcdTI1MDBcdTI1MDBcbiAgICAvLyBQaSBmb3JtYXQ6IHsgcm9sZTogXCJ0b29sUmVzdWx0XCIsIHRvb2xDYWxsSWQ6IFwidG9vbHVfLi4uXCIsIHRvb2xOYW1lOiBcImJhc2hcIiwgaXNFcnJvcjogYm9vbCwgY29udGVudDogLi4uIH1cbiAgICBpZiAobXNnLnJvbGUgPT09IFwidG9vbFJlc3VsdFwiKSB7XG4gICAgICBjb25zdCBpZCA9IFN0cmluZyhtc2cudG9vbENhbGxJZCB8fCBcIlwiKTtcbiAgICAgIGNvbnN0IGlzRXJyb3IgPSAhIW1zZy5pc0Vycm9yO1xuICAgICAgY29uc3QgcmVzdWx0VGV4dCA9IGV4dHJhY3RSZXN1bHRUZXh0KG1zZyk7XG5cbiAgICAgIGNvbnN0IHBlbmRpbmcgPSBwZW5kaW5nVG9vbHMuZ2V0KGlkKTtcbiAgICAgIGlmIChwZW5kaW5nKSB7XG4gICAgICAgIHRvb2xDYWxscy5wdXNoKHtcbiAgICAgICAgICBuYW1lOiBwZW5kaW5nLm5hbWUsXG4gICAgICAgICAgaW5wdXQ6IHJlZGFjdElucHV0KHBlbmRpbmcubmFtZSwgcGVuZGluZy5pbnB1dCksXG4gICAgICAgICAgcmVzdWx0OiByZXN1bHRUZXh0LnNsaWNlKDAsIDUwMCksXG4gICAgICAgICAgaXNFcnJvcixcbiAgICAgICAgfSk7XG4gICAgICAgIHBlbmRpbmdUb29scy5kZWxldGUoaWQpO1xuXG4gICAgICAgIC8vIE1hcmsgZmFpbGVkIGNvbW1hbmRzXG4gICAgICAgIGlmIChpc0Vycm9yICYmIChwZW5kaW5nLm5hbWUgPT09IFwiYmFzaFwiIHx8IHBlbmRpbmcubmFtZSA9PT0gXCJiZ19zaGVsbFwiKSkge1xuICAgICAgICAgIGNvbnN0IGxhc3RDbWQgPSBmaW5kTGFzdChjb21tYW5kc1J1biwgYyA9PiBjLmNvbW1hbmQgPT09IFN0cmluZyhwZW5kaW5nLmlucHV0LmNvbW1hbmQpKTtcbiAgICAgICAgICBpZiAobGFzdENtZCkgbGFzdENtZC5mYWlsZWQgPSB0cnVlO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGlmIChpc0Vycm9yICYmIHJlc3VsdFRleHQpIHtcbiAgICAgICAgLy8gRmlsdGVyIG91dCBiZW5pZ24gXCJlcnJvcnNcIiB0aGF0IGFyZSBub3JtYWwgZHVyaW5nIGNvZGUgZXhwbG9yYXRpb246XG4gICAgICAgIC8vIC0gZ3JlcC9yZy9maW5kIHJldHVybmluZyBleGl0IGNvZGUgMSAobm8gbWF0Y2hlcykgaXMgZXhwZWN0ZWQgUE9TSVggYmVoYXZpb3JcbiAgICAgICAgLy8gLSBVc2VyIGludGVycnVwdHMgKEVzY2FwZS9za2lwKSBhcmUgaW50ZW50aW9uYWwsIG5vdCBmYWlsdXJlc1xuICAgICAgICBjb25zdCB0cmltbWVkID0gcmVzdWx0VGV4dC50cmltKCk7XG4gICAgICAgIGNvbnN0IGlzQmVuaWduTm9NYXRjaCA9IHBlbmRpbmc/Lm5hbWUgPT09IFwiYmFzaFwiICYmXG4gICAgICAgICAgL15cXChubyBvdXRwdXRcXClcXHMqXFxuXFxzKkNvbW1hbmQgZXhpdGVkIHdpdGggY29kZSAxJC9tLnRlc3QodHJpbW1lZCk7XG4gICAgICAgIGNvbnN0IGlzVXNlclNraXAgPSAvXlNraXBwZWQgZHVlIHRvIHF1ZXVlZCB1c2VyIG1lc3NhZ2UvaS50ZXN0KHRyaW1tZWQpO1xuXG4gICAgICAgIGlmICghaXNCZW5pZ25Ob01hdGNoICYmICFpc1VzZXJTa2lwKSB7XG4gICAgICAgICAgZXJyb3JzLnB1c2gocmVzdWx0VGV4dC5zbGljZSgwLCAzMDApKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8vIEZsdXNoIGFueSBwZW5kaW5nIHRvb2wgY2FsbHMgdGhhdCBuZXZlciBnb3QgcmVzdWx0cyAoY3Jhc2ggbWlkLXRvb2wpXG4gIGZvciAoY29uc3QgWywgcGVuZGluZ10gb2YgcGVuZGluZ1Rvb2xzKSB7XG4gICAgdG9vbENhbGxzLnB1c2goe1xuICAgICAgbmFtZTogcGVuZGluZy5uYW1lLFxuICAgICAgaW5wdXQ6IHJlZGFjdElucHV0KHBlbmRpbmcubmFtZSwgcGVuZGluZy5pbnB1dCksXG4gICAgICBpc0Vycm9yOiBmYWxzZSxcbiAgICB9KTtcbiAgfVxuXG4gIHJldHVybiB7XG4gICAgdG9vbENhbGxzLFxuICAgIGZpbGVzV3JpdHRlbixcbiAgICBmaWxlc1JlYWQsXG4gICAgY29tbWFuZHNSdW4sXG4gICAgZXJyb3JzLFxuICAgIGxhc3RSZWFzb25pbmc6IGxhc3RSZWFzb25pbmcuc2xpY2UoLTYwMCkudHJpbSgpLFxuICAgIHRvb2xDYWxsQ291bnQ6IHRvb2xDYWxscy5sZW5ndGgsXG4gIH07XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBHaXQgU3RhdGUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIGdldEdpdENoYW5nZXMoYmFzZVBhdGg6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICB0cnkge1xuICAgIGNvbnN0IHN0YXR1cyA9IG5hdGl2ZVdvcmtpbmdUcmVlU3RhdHVzKGJhc2VQYXRoKTtcbiAgICBpZiAoIXN0YXR1cykgcmV0dXJuIG51bGw7XG5cbiAgICBjb25zdCBkaWZmU3RhdCA9IG5hdGl2ZURpZmZTdGF0KGJhc2VQYXRoLCBcIkhFQURcIiwgXCJXT1JLRElSXCIpLnN1bW1hcnk7XG4gICAgY29uc3Qgc3RhZ2VkU3RhdCA9IG5hdGl2ZURpZmZTdGF0KGJhc2VQYXRoLCBcIkhFQURcIiwgXCJJTkRFWFwiKS5zdW1tYXJ5O1xuXG4gICAgY29uc3QgcGFydHM6IHN0cmluZ1tdID0gW107XG4gICAgaWYgKHN0YXR1cykgcGFydHMucHVzaChgU3RhdHVzOlxcbiR7c3RhdHVzfWApO1xuICAgIGlmIChzdGFnZWRTdGF0KSBwYXJ0cy5wdXNoKGBTdGFnZWQ6XFxuJHtzdGFnZWRTdGF0fWApO1xuICAgIGlmIChkaWZmU3RhdCkgcGFydHMucHVzaChgVW5zdGFnZWQ6XFxuJHtkaWZmU3RhdH1gKTtcbiAgICByZXR1cm4gcGFydHMuam9pbihcIlxcblxcblwiKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFJlY292ZXJ5IEJyaWVmaW5nIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFN5bnRoZXNpemUgYSBmdWxsIGNyYXNoIHJlY292ZXJ5IGJyaWVmaW5nLlxuICpcbiAqIFJlYWRzIHRoZSBzdXJ2aXZpbmcgcGkgc2Vzc2lvbiBmaWxlIChvciBmYWxscyBiYWNrIHRvIHRoZSBsYXN0IEdTRCBhY3Rpdml0eVxuICogbG9nKSwgZGVlcC1wYXJzZXMgaXQgaW50byBhbiBleGVjdXRpb24gdHJhY2UsIGNvbWJpbmVzIHdpdGggZ2l0IHN0YXRlLCBhbmRcbiAqIGZvcm1hdHMgYSBzdHJ1Y3R1cmVkIHByb21wdCBzZWN0aW9uIHJlYWR5IGZvciBpbmplY3Rpb24uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzeW50aGVzaXplQ3Jhc2hSZWNvdmVyeShcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgdW5pdFR5cGU6IHN0cmluZyxcbiAgdW5pdElkOiBzdHJpbmcsXG4gIHNlc3Npb25GaWxlPzogc3RyaW5nLFxuICBhY3Rpdml0eURpcj86IHN0cmluZyxcbik6IFJlY292ZXJ5QnJpZWZpbmcgfCBudWxsIHtcbiAgdHJ5IHtcbiAgICBsZXQgdHJhY2U6IEV4ZWN1dGlvblRyYWNlIHwgbnVsbCA9IG51bGw7XG5cbiAgICAvLyBQcmltYXJ5IHNvdXJjZTogc3Vydml2aW5nIHBpIHNlc3Npb24gZmlsZVxuICAgIGlmIChzZXNzaW9uRmlsZSAmJiBleGlzdHNTeW5jKHNlc3Npb25GaWxlKSkge1xuICAgICAgLy8gVHJ5IG5hdGl2ZSBKU09OTCBwYXJzZXIgZmlyc3QgKGhhbmRsZXMgYXJiaXRyYXJ5IGZpbGUgc2l6ZXMgd2l0aCBjb25zdGFudCBtZW1vcnkpXG4gICAgICBjb25zdCBuYXRpdmVSZXN1bHQgPSBuYXRpdmVQYXJzZUpzb25sVGFpbChzZXNzaW9uRmlsZSwgTUFYX0pTT05MX0JZVEVTKTtcbiAgICAgIGlmIChuYXRpdmVSZXN1bHQpIHtcbiAgICAgICAgY29uc3Qgc2Vzc2lvbkVudHJpZXMgPSBleHRyYWN0TGFzdFNlc3Npb24obmF0aXZlUmVzdWx0LmVudHJpZXMpO1xuICAgICAgICB0cmFjZSA9IGV4dHJhY3RUcmFjZShzZXNzaW9uRW50cmllcyk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zdCBzdGF0ID0gc3RhdFN5bmMoc2Vzc2lvbkZpbGUsIHsgdGhyb3dJZk5vRW50cnk6IGZhbHNlIH0pO1xuICAgICAgICBjb25zdCBmaWxlU2l6ZSA9IHN0YXQ/LnNpemUgPz8gMDtcbiAgICAgICAgLy8gU2tpcCBmaWxlcyB0aGF0IHdvdWxkIGJsb3cgdXAgbWVtb3J5OyBmYWxsIGJhY2sgdG8gYWN0aXZpdHkgbG9nXG4gICAgICAgIGlmIChmaWxlU2l6ZSA8PSBNQVhfSlNPTkxfQllURVMgKiAyKSB7XG4gICAgICAgICAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKHNlc3Npb25GaWxlLCBcInV0Zi04XCIpO1xuICAgICAgICAgIGNvbnN0IGFsbEVudHJpZXMgPSBwYXJzZUpTT05MKHJhdyk7XG4gICAgICAgICAgY29uc3Qgc2Vzc2lvbkVudHJpZXMgPSBleHRyYWN0TGFzdFNlc3Npb24oYWxsRW50cmllcyk7XG4gICAgICAgICAgdHJhY2UgPSBleHRyYWN0VHJhY2Uoc2Vzc2lvbkVudHJpZXMpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gRmFsbGJhY2s6IGxhc3QgR1NEIGFjdGl2aXR5IGxvZ1xuICAgIGlmICghdHJhY2UgfHwgdHJhY2UudG9vbENhbGxDb3VudCA9PT0gMCkge1xuICAgICAgY29uc3QgZmFsbGJhY2tUcmFjZSA9IHJlYWRMYXN0QWN0aXZpdHlMb2coYWN0aXZpdHlEaXIpO1xuICAgICAgaWYgKGZhbGxiYWNrVHJhY2UgJiYgZmFsbGJhY2tUcmFjZS50b29sQ2FsbENvdW50ID4gMCkge1xuICAgICAgICB0cmFjZSA9IGZhbGxiYWNrVHJhY2U7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gSWYgbm8gdHJhY2UgZnJvbSBlaXRoZXIgc291cmNlLCBzdGlsbCBwcm92aWRlIGdpdCBzdGF0ZVxuICAgIGlmICghdHJhY2UpIHtcbiAgICAgIHRyYWNlID0ge1xuICAgICAgICB0b29sQ2FsbHM6IFtdLCBmaWxlc1dyaXR0ZW46IFtdLCBmaWxlc1JlYWQ6IFtdLFxuICAgICAgICBjb21tYW5kc1J1bjogW10sIGVycm9yczogW10sIGxhc3RSZWFzb25pbmc6IFwiXCIsIHRvb2xDYWxsQ291bnQ6IDAsXG4gICAgICB9O1xuICAgIH1cblxuICAgIGNvbnN0IGdpdENoYW5nZXMgPSBnZXRHaXRDaGFuZ2VzKGJhc2VQYXRoKTtcbiAgICBjb25zdCBwcm9tcHQgPSBmb3JtYXRSZWNvdmVyeVByb21wdCh1bml0VHlwZSwgdW5pdElkLCB0cmFjZSwgZ2l0Q2hhbmdlcyk7XG5cbiAgICByZXR1cm4geyB1bml0VHlwZSwgdW5pdElkLCB0cmFjZSwgZ2l0Q2hhbmdlcywgcHJvbXB0IH07XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8qKlxuICogRGVlcCBkaWFnbm9zdGljIGZyb20gYW55IEpTT05MIHNvdXJjZSAoYWN0aXZpdHkgbG9nIG9yIHNlc3Npb24gZmlsZSkuXG4gKiBSZXBsYWNlcyB0aGUgb2xkIHNoYWxsb3cgZ2V0TGFzdEFjdGl2aXR5RGlhZ25vc3RpYygpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0RGVlcERpYWdub3N0aWMoYmFzZVBhdGg6IHN0cmluZywgd29ya3RyZWVQYXRoPzogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gIC8vIFRyeSB3b3JrdHJlZSBhY3Rpdml0eSBsb2dzIGZpcnN0IGlmIGEgd29ya3RyZWUgcGF0aCBpcyBwcm92aWRlZFxuICBsZXQgdHJhY2U6IEV4ZWN1dGlvblRyYWNlIHwgbnVsbCA9IG51bGw7XG4gIHRyeSB7XG4gICAgaWYgKHdvcmt0cmVlUGF0aCkge1xuICAgICAgY29uc3Qgd3RBY3Rpdml0eURpciA9IGpvaW4oZ3NkUm9vdCh3b3JrdHJlZVBhdGgpLCBcImFjdGl2aXR5XCIpO1xuICAgICAgdHJhY2UgPSByZWFkTGFzdEFjdGl2aXR5TG9nKHd0QWN0aXZpdHlEaXIpO1xuICAgIH1cbiAgfSBjYXRjaCB7IC8qIG5vbi1mYXRhbCBcdTIwMTQgZmFsbCB0aHJvdWdoIHRvIHJvb3QgKi8gfVxuXG4gIC8vIEZhbGwgYmFjayB0byByb290IGFjdGl2aXR5IGxvZ3NcbiAgaWYgKCF0cmFjZSB8fCB0cmFjZS50b29sQ2FsbENvdW50ID09PSAwKSB7XG4gICAgY29uc3QgYWN0aXZpdHlEaXIgPSBqb2luKGdzZFJvb3QoYmFzZVBhdGgpLCBcImFjdGl2aXR5XCIpO1xuICAgIHRyYWNlID0gcmVhZExhc3RBY3Rpdml0eUxvZyhhY3Rpdml0eURpcik7XG4gIH1cblxuICBpZiAoIXRyYWNlIHx8IHRyYWNlLnRvb2xDYWxsQ291bnQgPT09IDApIHJldHVybiBudWxsO1xuICByZXR1cm4gZm9ybWF0VHJhY2VTdW1tYXJ5KHRyYWNlKTtcbn1cblxuLyoqXG4gKiBSZWFkIHRoZSBhY3RpdmUgbWlsZXN0b25lIElEIGRpcmVjdGx5IGZyb20gU1RBVEUubWQgd2l0aG91dCBhc3luYyBkZXJpdmVTdGF0ZSgpLlxuICogTG9va3MgZm9yIGAqKkFjdGl2ZSBNaWxlc3RvbmU6KiogTTAwMWAgcGF0dGVybi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlYWRBY3RpdmVNaWxlc3RvbmVJZChiYXNlUGF0aDogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gIHRyeSB7XG4gICAgY29uc3Qgc3RhdGVQYXRoID0gam9pbihnc2RSb290KGJhc2VQYXRoKSwgXCJTVEFURS5tZFwiKTtcbiAgICBpZiAoIWV4aXN0c1N5bmMoc3RhdGVQYXRoKSkgcmV0dXJuIG51bGw7XG4gICAgY29uc3QgY29udGVudCA9IHJlYWRGaWxlU3luYyhzdGF0ZVBhdGgsIFwidXRmLThcIik7XG4gICAgY29uc3QgbWF0Y2ggPSAvXFwqXFwqQWN0aXZlIE1pbGVzdG9uZTpcXCpcXCpcXHMqKFxcUyspL2kuZXhlYyhjb250ZW50KTtcbiAgICByZXR1cm4gbWF0Y2g/LlsxXSA/PyBudWxsO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRm9ybWF0dGluZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gZm9ybWF0UmVjb3ZlcnlQcm9tcHQoXG4gIHVuaXRUeXBlOiBzdHJpbmcsXG4gIHVuaXRJZDogc3RyaW5nLFxuICB0cmFjZTogRXhlY3V0aW9uVHJhY2UsXG4gIGdpdENoYW5nZXM6IHN0cmluZyB8IG51bGwsXG4pOiBzdHJpbmcge1xuICBjb25zdCBzZWN0aW9uczogc3RyaW5nW10gPSBbXTtcblxuICBzZWN0aW9ucy5wdXNoKFxuICAgIFwiIyMgUmVjb3ZlcnkgQnJpZWZpbmdcIixcbiAgICBcIlwiLFxuICAgIGBZb3UgYXJlIHJlc3VtaW5nIFxcYCR7dW5pdFR5cGV9XFxgIGZvciBcXGAke3VuaXRJZH1cXGAgYWZ0ZXIgYW4gaW50ZXJydXB0aW9uLmAsXG4gICAgYFRoZSBwcmV2aW91cyBzZXNzaW9uIGNvbXBsZXRlZCAqKiR7dHJhY2UudG9vbENhbGxDb3VudH0gdG9vbCBjYWxscyoqIGJlZm9yZSBzdG9wcGluZy5gLFxuICAgIFwiVXNlIHRoaXMgYnJpZWZpbmcgdG8gcGljayB1cCBleGFjdGx5IHdoZXJlIGl0IGxlZnQgb2ZmLiBEbyBOT1QgcmVkbyBjb21wbGV0ZWQgd29yay5cIixcbiAgKTtcblxuICAvLyBUb29sIGNhbGwgdHJhY2UgXHUyMDE0IGNvbXBhY3Qgc3VtbWFyeVxuICBpZiAodHJhY2UudG9vbENhbGxzLmxlbmd0aCA+IDApIHtcbiAgICBzZWN0aW9ucy5wdXNoKFwiXCIsIFwiIyMjIENvbXBsZXRlZCBUb29sIENhbGxzXCIpO1xuICAgIGNvbnN0IHN1bW1hcnkgPSBjb21wcmVzc1Rvb2xDYWxsVHJhY2UodHJhY2UudG9vbENhbGxzKTtcbiAgICBzZWN0aW9ucy5wdXNoKHN1bW1hcnkpO1xuICB9XG5cbiAgLy8gRmlsZXMgd3JpdHRlblxuICBpZiAodHJhY2UuZmlsZXNXcml0dGVuLmxlbmd0aCA+IDApIHtcbiAgICBzZWN0aW9ucy5wdXNoKFxuICAgICAgXCJcIiwgXCIjIyMgRmlsZXMgQWxyZWFkeSBXcml0dGVuL0VkaXRlZFwiLFxuICAgICAgLi4udHJhY2UuZmlsZXNXcml0dGVuLm1hcChmID0+IGAtIFxcYCR7Zn1cXGBgKSxcbiAgICAgIFwiXCIsXG4gICAgICBcIlRoZXNlIGZpbGVzIGV4aXN0IG9uIGRpc2sgZnJvbSB0aGUgcHJldmlvdXMgcnVuLiBWZXJpZnkgdGhleSBsb29rIGNvcnJlY3QgYmVmb3JlIGNvbnRpbnVpbmcuXCIsXG4gICAgKTtcbiAgfVxuXG4gIC8vIENvbW1hbmRzIHJ1blxuICBjb25zdCBzaWduaWZpY2FudENvbW1hbmRzID0gdHJhY2UuY29tbWFuZHNSdW4uZmlsdGVyKGMgPT5cbiAgICAhYy5jb21tYW5kLnN0YXJ0c1dpdGgoXCJnaXQgXCIpIHx8IGMuZmFpbGVkLFxuICApO1xuICBpZiAoc2lnbmlmaWNhbnRDb21tYW5kcy5sZW5ndGggPiAwKSB7XG4gICAgc2VjdGlvbnMucHVzaChcIlwiLCBcIiMjIyBDb21tYW5kcyBBbHJlYWR5IFJ1blwiKTtcbiAgICBmb3IgKGNvbnN0IGMgb2Ygc2lnbmlmaWNhbnRDb21tYW5kcy5zbGljZSgtMTApKSB7XG4gICAgICBjb25zdCBzdGF0dXMgPSBjLmZhaWxlZCA/IFwiIFx1Mjc0Q1wiIDogXCIgXHUyNzEzXCI7XG4gICAgICBzZWN0aW9ucy5wdXNoKGAtIFxcYCR7dHJ1bmNhdGVXaXRoRWxsaXBzaXMoYy5jb21tYW5kLCAxMjEpfVxcYCR7c3RhdHVzfWApO1xuICAgIH1cbiAgfVxuXG4gIC8vIEVycm9yc1xuICBpZiAodHJhY2UuZXJyb3JzLmxlbmd0aCA+IDApIHtcbiAgICBzZWN0aW9ucy5wdXNoKFxuICAgICAgXCJcIiwgXCIjIyMgRXJyb3JzIEJlZm9yZSBJbnRlcnJ1cHRpb25cIixcbiAgICAgIC4uLnRyYWNlLmVycm9ycy5zbGljZSgtMykubWFwKGUgPT4gYC0gJHt0cnVuY2F0ZVdpdGhFbGxpcHNpcyhlLCAyMDEpfWApLFxuICAgICk7XG4gIH1cblxuICAvLyBHaXQgc3RhdGVcbiAgaWYgKGdpdENoYW5nZXMpIHtcbiAgICBzZWN0aW9ucy5wdXNoKFxuICAgICAgXCJcIiwgXCIjIyMgQ3VycmVudCBHaXQgU3RhdGUgKGZpbGVzeXN0ZW0gdHJ1dGgpXCIsXG4gICAgICBcImBgYFwiLCBnaXRDaGFuZ2VzLCBcImBgYFwiLFxuICAgICk7XG4gIH1cblxuICAvLyBMYXN0IHJlYXNvbmluZ1xuICBpZiAodHJhY2UubGFzdFJlYXNvbmluZykge1xuICAgIHNlY3Rpb25zLnB1c2goXG4gICAgICBcIlwiLCBcIiMjIyBMYXN0IEFnZW50IFJlYXNvbmluZyBCZWZvcmUgSW50ZXJydXB0aW9uXCIsXG4gICAgICBgPiAke3RyYWNlLmxhc3RSZWFzb25pbmcucmVwbGFjZSgvXFxuL2csIFwiXFxuPiBcIil9YCxcbiAgICApO1xuICB9XG5cbiAgc2VjdGlvbnMucHVzaChcbiAgICBcIlwiLFxuICAgIFwiIyMjIFJlc3VtZSBJbnN0cnVjdGlvbnNcIixcbiAgICBcIjEuIENoZWNrIHRoZSB0YXNrIHBsYW4gZm9yIHJlbWFpbmluZyB3b3JrXCIsXG4gICAgXCIyLiBWZXJpZnkgZmlsZXMgbGlzdGVkIGFib3ZlIGV4aXN0IGFuZCBsb29rIGNvcnJlY3Qgb24gZGlza1wiLFxuICAgIFwiMy4gQ29udGludWUgZnJvbSB3aGVyZSB0aGUgcHJldmlvdXMgc2Vzc2lvbiBsZWZ0IG9mZlwiLFxuICAgIFwiNC4gRG8gTk9UIHJlLXJlYWQgZmlsZXMgb3IgcmUtcnVuIGNvbW1hbmRzIHRoYXQgYWxyZWFkeSBzdWNjZWVkZWQgYWJvdmVcIixcbiAgKTtcblxuICByZXR1cm4gc2VjdGlvbnMuam9pbihcIlxcblwiKTtcbn1cblxuLyoqXG4gKiBDb21wcmVzcyBhIHRvb2wgY2FsbCB0cmFjZSBpbnRvIGEgcmVhZGFibGUgc3VtbWFyeS5cbiAqIEdyb3VwcyBjb25zZWN1dGl2ZSByZWFkcywgc2hvd3Mgd3JpdGUvZWRpdC9iYXNoIGluZGl2aWR1YWxseS5cbiAqL1xuZnVuY3Rpb24gY29tcHJlc3NUb29sQ2FsbFRyYWNlKGNhbGxzOiBUb29sQ2FsbFtdKTogc3RyaW5nIHtcbiAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG4gIGxldCByZWFkQmF0Y2g6IHN0cmluZ1tdID0gW107XG5cbiAgZnVuY3Rpb24gZmx1c2hSZWFkcygpIHtcbiAgICBpZiAocmVhZEJhdGNoLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuICAgIGlmIChyZWFkQmF0Y2gubGVuZ3RoIDw9IDIpIHtcbiAgICAgIGZvciAoY29uc3QgcGF0aCBvZiByZWFkQmF0Y2gpIGxpbmVzLnB1c2goYCAgcmVhZCBcXGAke3BhdGh9XFxgYCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGxpbmVzLnB1c2goYCAgcmVhZCAke3JlYWRCYXRjaC5sZW5ndGh9IGZpbGVzOiAke3JlYWRCYXRjaC5tYXAocCA9PiBgXFxgJHtiYXNlbmFtZShwKX1cXGBgKS5qb2luKFwiLCBcIil9YCk7XG4gICAgfVxuICAgIHJlYWRCYXRjaCA9IFtdO1xuICB9XG5cbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBjYWxscy5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IGNhbGwgPSBjYWxsc1tpXSE7XG4gICAgY29uc3QgbnVtID0gaSArIDE7XG5cbiAgICBpZiAoY2FsbC5uYW1lID09PSBcInJlYWRcIiAmJiBjYWxsLmlucHV0LnBhdGgpIHtcbiAgICAgIHJlYWRCYXRjaC5wdXNoKFN0cmluZyhjYWxsLmlucHV0LnBhdGgpKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGZsdXNoUmVhZHMoKTtcblxuICAgIGNvbnN0IGVyciA9IGNhbGwuaXNFcnJvciA/IFwiIFx1Mjc0Q1wiIDogXCJcIjtcblxuICAgIGlmIChjYWxsLm5hbWUgPT09IFwid3JpdGVcIiB8fCBjYWxsLm5hbWUgPT09IFwiZWRpdFwiKSB7XG4gICAgICBsaW5lcy5wdXNoKGAke251bX0uICR7Y2FsbC5uYW1lfSBcXGAke2NhbGwuaW5wdXQucGF0aCB8fCBcIj9cIn1cXGAke2Vycn1gKTtcbiAgICB9IGVsc2UgaWYgKGNhbGwubmFtZSA9PT0gXCJiYXNoXCIgfHwgY2FsbC5uYW1lID09PSBcImJnX3NoZWxsXCIpIHtcbiAgICAgIGNvbnN0IGNtZCA9IHRydW5jYXRlV2l0aEVsbGlwc2lzKFN0cmluZyhjYWxsLmlucHV0LmNvbW1hbmQgfHwgXCJcIiksIDgxKTtcbiAgICAgIGxpbmVzLnB1c2goYCR7bnVtfS4gJHtjYWxsLm5hbWV9OiBcXGAke2NtZH1cXGAke2Vycn1gKTtcbiAgICB9IGVsc2Uge1xuICAgICAgbGluZXMucHVzaChgJHtudW19LiAke2NhbGwubmFtZX0ke2Vycn1gKTtcbiAgICB9XG4gIH1cblxuICBmbHVzaFJlYWRzKCk7XG4gIHJldHVybiBsaW5lcy5qb2luKFwiXFxuXCIpO1xufVxuXG5mdW5jdGlvbiBmb3JtYXRUcmFjZVN1bW1hcnkodHJhY2U6IEV4ZWN1dGlvblRyYWNlKTogc3RyaW5nIHtcbiAgY29uc3QgcGFydHM6IHN0cmluZ1tdID0gW107XG4gIHBhcnRzLnB1c2goYFRvb2wgY2FsbHMgY29tcGxldGVkOiAke3RyYWNlLnRvb2xDYWxsQ291bnR9YCk7XG5cbiAgaWYgKHRyYWNlLmZpbGVzV3JpdHRlbi5sZW5ndGggPiAwKSB7XG4gICAgcGFydHMucHVzaChgRmlsZXMgd3JpdHRlbjogJHt0cmFjZS5maWxlc1dyaXR0ZW4ubWFwKGYgPT4gYFxcYCR7Zn1cXGBgKS5qb2luKFwiLCBcIil9YCk7XG4gIH1cbiAgaWYgKHRyYWNlLmNvbW1hbmRzUnVuLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCBjbWRzID0gdHJhY2UuY29tbWFuZHNSdW4uc2xpY2UoLTUpLm1hcChjID0+IGBcXGAke3RydW5jYXRlV2l0aEVsbGlwc2lzKGMuY29tbWFuZCwgODEpfVxcYCR7Yy5mYWlsZWQgPyBcIiBcdTI3NENcIiA6IFwiXCJ9YCk7XG4gICAgcGFydHMucHVzaChgQ29tbWFuZHMgcnVuOiAke2NtZHMuam9pbihcIiwgXCIpfWApO1xuICB9XG4gIGlmICh0cmFjZS5lcnJvcnMubGVuZ3RoID4gMCkge1xuICAgIHBhcnRzLnB1c2goYEVycm9yczogJHt0cmFjZS5lcnJvcnMuc2xpY2UoLTMpLmpvaW4oXCI7IFwiKX1gKTtcbiAgfVxuICAvLyBOT1RFOiBsYXN0UmVhc29uaW5nIGlzIGludGVudGlvbmFsbHkgZXhjbHVkZWQgZnJvbSB0aGUgcmV0cnkgZGlhZ25vc3RpYy5cbiAgLy8gVGhpcyBzdW1tYXJ5IGlzIGluamVjdGVkIGludG8gcmV0cnkgcHJvbXB0cyB2aWEgZ2V0RGVlcERpYWdub3N0aWMoKSBcdTIxOTJcbiAgLy8gcGhhc2VzLnRzLiBJbmNsdWRpbmcgcHJpb3IgYXNzaXN0YW50IGZyZWUtdGV4dCBjYXVzZXMgaGFsbHVjaW5hdGlvbiBsb29wc1xuICAvLyB3aGVuIHRoZSBwcmV2aW91cyB0dXJuIHdhcyB0cnVuY2F0ZWQgb3IgbWFsZm9ybWVkLiBDcmFzaCByZWNvdmVyeSBoYXMgaXRzXG4gIC8vIG93biBwYXRoIChmb3JtYXRDcmFzaFJlY292ZXJ5QnJpZWZpbmcpIHRoYXQgaGFuZGxlcyBsYXN0UmVhc29uaW5nIHNhZmVseVxuICAvLyB3aXRoIGV4cGxpY2l0IFwiTGFzdCBBZ2VudCBSZWFzb25pbmcgQmVmb3JlIEludGVycnVwdGlvblwiIGZyYW1pbmcuXG4gIC8vIFNlZTogaHR0cHM6Ly9naXRodWIuY29tL2dzZC1idWlsZC9nc2QtMi9pc3N1ZXMvMjE5NVxuICByZXR1cm4gcGFydHMuam9pbihcIlxcblwiKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEhlbHBlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIHJlYWRMYXN0QWN0aXZpdHlMb2coYWN0aXZpdHlEaXI/OiBzdHJpbmcpOiBFeGVjdXRpb25UcmFjZSB8IG51bGwge1xuICBpZiAoIWFjdGl2aXR5RGlyKSByZXR1cm4gbnVsbDtcbiAgdHJ5IHtcbiAgICBpZiAoIWV4aXN0c1N5bmMoYWN0aXZpdHlEaXIpKSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCBmaWxlcyA9IHJlYWRkaXJTeW5jKGFjdGl2aXR5RGlyKS5maWx0ZXIoZiA9PiBmLmVuZHNXaXRoKFwiLmpzb25sXCIpKS5zb3J0KCk7XG4gICAgaWYgKGZpbGVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG5cbiAgICBjb25zdCBsYXN0RmlsZSA9IGZpbGVzW2ZpbGVzLmxlbmd0aCAtIDFdITtcbiAgICBjb25zdCBmaWxlUGF0aCA9IGpvaW4oYWN0aXZpdHlEaXIsIGxhc3RGaWxlKTtcblxuICAgIC8vIFRyeSBuYXRpdmUgSlNPTkwgcGFyc2VyIGZpcnN0XG4gICAgY29uc3QgbmF0aXZlUmVzdWx0ID0gbmF0aXZlUGFyc2VKc29ubFRhaWwoZmlsZVBhdGgsIE1BWF9KU09OTF9CWVRFUyk7XG4gICAgaWYgKG5hdGl2ZVJlc3VsdCkge1xuICAgICAgcmV0dXJuIGV4dHJhY3RUcmFjZShuYXRpdmVSZXN1bHQuZW50cmllcyk7XG4gICAgfVxuXG4gICAgLy8gRmFsbCBiYWNrIHRvIEpTIHBhcnNpbmdcbiAgICBjb25zdCByYXcgPSByZWFkRmlsZVN5bmMoZmlsZVBhdGgsIFwidXRmLThcIik7XG4gICAgcmV0dXJuIGV4dHJhY3RUcmFjZShwYXJzZUpTT05MKHJhdykpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5mdW5jdGlvbiBleHRyYWN0UmVzdWx0VGV4dChtc2c6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogc3RyaW5nIHtcbiAgY29uc3QgY29udGVudCA9IG1zZy5jb250ZW50O1xuICBpZiAodHlwZW9mIGNvbnRlbnQgPT09IFwic3RyaW5nXCIpIHJldHVybiBjb250ZW50O1xuICBpZiAoQXJyYXkuaXNBcnJheShjb250ZW50KSkge1xuICAgIHJldHVybiBjb250ZW50XG4gICAgICAuZmlsdGVyKChwOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4gcC50eXBlID09PSBcInRleHRcIilcbiAgICAgIC5tYXAoKHA6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiBTdHJpbmcocC50ZXh0IHx8IFwiXCIpKVxuICAgICAgLmpvaW4oXCIgXCIpO1xuICB9XG4gIHJldHVybiBcIlwiO1xufVxuXG4vKipcbiAqIFJlZGFjdCBzZW5zaXRpdmUgZmllbGRzIGZyb20gdG9vbCBpbnB1dHMuXG4gKiBLZWVwIHBhdGhzIGFuZCBjb21tYW5kcywgZHJvcCBsYXJnZSBjb250ZW50IGJvZGllcy5cbiAqL1xuZnVuY3Rpb24gcmVkYWN0SW5wdXQobmFtZTogc3RyaW5nLCBpbnB1dDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gIGNvbnN0IHNhZmU6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKGlucHV0KSkge1xuICAgIGlmIChrZXkgPT09IFwiY29udGVudFwiIHx8IGtleSA9PT0gXCJvbGRUZXh0XCIgfHwga2V5ID09PSBcIm5ld1RleHRcIikge1xuICAgICAgc2FmZVtrZXldID0gdHlwZW9mIHZhbHVlID09PSBcInN0cmluZ1wiID8gdHJ1bmNhdGVXaXRoRWxsaXBzaXModmFsdWUsIDEwMSkgOiBcIltyZWRhY3RlZF1cIjtcbiAgICB9IGVsc2Uge1xuICAgICAgc2FmZVtrZXldID0gdmFsdWU7XG4gICAgfVxuICB9XG4gIHJldHVybiBzYWZlO1xufVxuXG4vKiogQXJyYXkuZmluZExhc3QgcG9seWZpbGwgZm9yIG9sZGVyIE5vZGUgdmVyc2lvbnMgKi9cbmZ1bmN0aW9uIGZpbmRMYXN0PFQ+KGFycjogVFtdLCBwcmVkaWNhdGU6IChpdGVtOiBUKSA9PiBib29sZWFuKTogVCB8IHVuZGVmaW5lZCB7XG4gIGZvciAobGV0IGkgPSBhcnIubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHtcbiAgICBpZiAocHJlZGljYXRlKGFycltpXSEpKSByZXR1cm4gYXJyW2ldO1xuICB9XG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbiJdLAogICJtYXBwaW5ncyI6ICJBQW9CQSxTQUFTLGNBQWMsYUFBYSxZQUFZLGdCQUFnQjtBQUNoRSxTQUFTLFVBQVUsWUFBWTtBQUMvQixTQUFTLGVBQWU7QUFDeEIsU0FBUyw0QkFBNEI7QUFDckMsU0FBUyw0QkFBNEI7QUFDckMsU0FBUyxpQkFBaUIsa0JBQWtCO0FBQzVDLFNBQVMseUJBQXlCLHNCQUFzQjtBQWdEeEQsU0FBUyxtQkFBbUIsU0FBK0I7QUFDekQsTUFBSSxpQkFBaUI7QUFDckIsV0FBUyxJQUFJLFFBQVEsU0FBUyxHQUFHLEtBQUssR0FBRyxLQUFLO0FBQzVDLFVBQU0sUUFBUSxRQUFRLENBQUM7QUFDdkIsUUFBSSxNQUFNLFNBQVMsV0FBVztBQUM1Qix1QkFBaUI7QUFDakI7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUNBLFNBQU8sa0JBQWtCLElBQUksUUFBUSxNQUFNLGNBQWMsSUFBSTtBQUMvRDtBQVFPLFNBQVMsYUFBYSxTQUFvQztBQUMvRCxRQUFNLFlBQXdCLENBQUM7QUFDL0IsUUFBTSxlQUF5QixDQUFDO0FBQ2hDLFFBQU0sWUFBc0IsQ0FBQztBQUM3QixRQUFNLGNBQXNELENBQUM7QUFDN0QsUUFBTSxTQUFtQixDQUFDO0FBQzFCLE1BQUksZ0JBQWdCO0FBR3BCLFFBQU0sZUFBZSxv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
