import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { gsdRoot } from "./paths.js";
const CAPTURES_FILENAME = "CAPTURES.md";
const VALID_CLASSIFICATIONS = [
  "quick-task",
  "inject",
  "defer",
  "replan",
  "note",
  "stop",
  "backtrack"
];
function resolveCapturesPath(basePath) {
  const resolved = resolve(basePath);
  const worktreeMarker = `${sep}.gsd${sep}worktrees${sep}`;
  let idx = resolved.indexOf(worktreeMarker);
  if (idx === -1) {
    const symlinkRe = new RegExp(
      `\\${sep}\\.gsd\\${sep}projects\\${sep}[a-f0-9]+\\${sep}worktrees\\${sep}`
    );
    const match = resolved.match(symlinkRe);
    if (match && match.index !== void 0) idx = match.index;
  }
  if (idx !== -1) {
    const projectRoot = resolved.slice(0, idx);
    return join(projectRoot, ".gsd", CAPTURES_FILENAME);
  }
  return join(gsdRoot(basePath), CAPTURES_FILENAME);
}
function appendCapture(basePath, text) {
  const filePath = resolveCapturesPath(basePath);
  const dir = join(filePath, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const id = `CAP-${randomUUID().slice(0, 8)}`;
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  const entry = [
    `### ${id}`,
    `**Text:** ${text}`,
    `**Captured:** ${timestamp}`,
    `**Status:** pending`,
    ""
  ].join("\n");
  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, "utf-8");
    writeFileSync(filePath, existing.trimEnd() + "\n\n" + entry, "utf-8");
  } else {
    const header = `# Captures

`;
    writeFileSync(filePath, header + entry, "utf-8");
  }
  return id;
}
function loadAllCaptures(basePath) {
  const filePath = resolveCapturesPath(basePath);
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf-8");
  return parseCapturesContent(content);
}
function loadPendingCaptures(basePath) {
  return loadAllCaptures(basePath).filter((c) => c.status === "pending");
}
function hasPendingCaptures(basePath) {
  const filePath = resolveCapturesPath(basePath);
  if (!existsSync(filePath)) return false;
  try {
    const content = readFileSync(filePath, "utf-8");
    return /\*\*Status:\*\*\s*pending/i.test(content);
  } catch {
    return false;
  }
}
function countPendingCaptures(basePath) {
  const filePath = resolveCapturesPath(basePath);
  if (!existsSync(filePath)) return 0;
  try {
    const content = readFileSync(filePath, "utf-8");
    const matches = content.match(/\*\*Status:\*\*\s*pending/gi);
    return matches ? matches.length : 0;
  } catch {
    return 0;
  }
}
function markCaptureResolved(basePath, captureId, classification, resolution, rationale, milestoneId) {
  const filePath = resolveCapturesPath(basePath);
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf-8");
  const resolvedAt = (/* @__PURE__ */ new Date()).toISOString();
  const sectionRegex = new RegExp(
    `(### ${escapeRegex(captureId)}\\n(?:(?!### ).)*?)(?=### |$)`,
    "s"
  );
  const match = sectionRegex.exec(content);
  if (!match) return;
  let section = match[1];
  section = section.replace(
    /\*\*Status:\*\*\s*.+/,
    `**Status:** resolved`
  );
  const newFields = [
    `**Classification:** ${classification}`,
    `**Resolution:** ${resolution}`,
    `**Rationale:** ${rationale}`,
    `**Resolved:** ${resolvedAt}`
  ];
  if (milestoneId) {
    newFields.push(`**Milestone:** ${milestoneId}`);
  }
  section = section.replace(/\*\*Classification:\*\*\s*.+\n?/g, "");
  section = section.replace(/\*\*Resolution:\*\*\s*.+\n?/g, "");
  section = section.replace(/\*\*Rationale:\*\*\s*.+\n?/g, "");
  section = section.replace(/\*\*Resolved:\*\*\s*.+\n?/g, "");
  section = section.replace(/\*\*Milestone:\*\*\s*.+\n?/g, "");
  section = section.trimEnd() + "\n" + newFields.join("\n") + "\n";
  const updated = content.replace(sectionRegex, section);
  writeFileSync(filePath, updated, "utf-8");
}
function markCaptureExecuted(basePath, captureId) {
  const filePath = resolveCapturesPath(basePath);
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf-8");
  const executedAt = (/* @__PURE__ */ new Date()).toISOString();
  const sectionRegex = new RegExp(
    `(### ${escapeRegex(captureId)}\\n(?:(?!### ).)*?)(?=### |$)`,
    "s"
  );
  const match = sectionRegex.exec(content);
  if (!match) return;
  let section = match[1];
  section = section.replace(/\*\*Executed:\*\*\s*.+\n?/g, "");
  section = section.trimEnd() + `
**Executed:** ${executedAt}
`;
  const updated = content.replace(sectionRegex, section);
  writeFileSync(filePath, updated, "utf-8");
}
function loadActionableCaptures(basePath, currentMilestoneId) {
  return loadAllCaptures(basePath).filter(
    (c) => c.status === "resolved" && !c.executed && (c.classification === "inject" || c.classification === "replan" || c.classification === "quick-task") && // Staleness gate: exclude captures resolved in a different milestone (#2872)
    (!currentMilestoneId || !c.resolvedInMilestone || c.resolvedInMilestone === currentMilestoneId)
  );
}
function loadStopCaptures(basePath) {
  return loadAllCaptures(basePath).filter(
    (c) => c.status === "resolved" && !c.executed && (c.classification === "stop" || c.classification === "backtrack")
  );
}
function loadBacktrackCaptures(basePath) {
  return loadAllCaptures(basePath).filter(
    (c) => c.status === "resolved" && !c.executed && c.classification === "backtrack"
  );
}
function revertExecutorResolvedCaptures(basePath) {
  const filePath = resolveCapturesPath(basePath);
  if (!existsSync(filePath)) return 0;
  let content = readFileSync(filePath, "utf-8");
  let reverted = 0;
  const all = loadAllCaptures(basePath);
  for (const capture of all) {
    if (capture.status === "resolved" && !capture.classification) {
      const sectionRegex = new RegExp(
        `(### ${escapeRegex(capture.id)}\\n(?:(?!### ).)*?)(?=### |$)`,
        "s"
      );
      const match = sectionRegex.exec(content);
      if (match) {
        let section = match[1];
        section = section.replace(
          /\*\*Status:\*\*\s*resolved/i,
          "**Status:** pending"
        );
        content = content.replace(sectionRegex, section);
        reverted++;
      }
    }
  }
  if (reverted > 0) {
    writeFileSync(filePath, content, "utf-8");
  }
  return reverted;
}
function stampCaptureMilestone(basePath, captureId, milestoneId) {
  const filePath = resolveCapturesPath(basePath);
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf-8");
  const sectionRegex = new RegExp(
    `(### ${escapeRegex(captureId)}\\n(?:(?!### ).)*?)(?=### |$)`,
    "s"
  );
  const match = sectionRegex.exec(content);
  if (!match) return;
  let section = match[1];
  if (/\*\*Milestone:\*\*/.test(section)) return;
  const resolvedFieldEnd = section.search(/\*\*Resolved:\*\*\s*.+\n?/);
  if (resolvedFieldEnd !== -1) {
    const resolvedMatch = section.match(/\*\*Resolved:\*\*\s*.+\n?/);
    const insertPos = resolvedFieldEnd + (resolvedMatch?.[0]?.length ?? 0);
    section = section.slice(0, insertPos) + `**Milestone:** ${milestoneId}
` + section.slice(insertPos);
  } else {
    section = section.trimEnd() + `
**Milestone:** ${milestoneId}
`;
  }
  const updated = content.replace(sectionRegex, section);
  writeFileSync(filePath, updated, "utf-8");
}
function parseCapturesContent(content) {
  const entries = [];
  const sections = content.split(/^### /m).slice(1);
  for (const section of sections) {
    const lines = section.split("\n");
    const id = lines[0]?.trim();
    if (!id) continue;
    const body = lines.slice(1).join("\n");
    const text = extractBoldField(body, "Text");
    const timestamp = extractBoldField(body, "Captured");
    const statusRaw = extractBoldField(body, "Status");
    const classification = extractBoldField(body, "Classification");
    const resolution = extractBoldField(body, "Resolution");
    const rationale = extractBoldField(body, "Rationale");
    const resolvedAt = extractBoldField(body, "Resolved");
    const milestoneId = extractBoldField(body, "Milestone");
    const executedAt = extractBoldField(body, "Executed");
    if (!text || !timestamp) continue;
    const status = statusRaw === "resolved" || statusRaw === "triaged" ? statusRaw : "pending";
    entries.push({
      id,
      text,
      timestamp,
      status,
      ...classification && VALID_CLASSIFICATIONS.includes(classification) ? { classification } : {},
      ...resolution ? { resolution } : {},
      ...rationale ? { rationale } : {},
      ...resolvedAt ? { resolvedAt } : {},
      ...milestoneId ? { resolvedInMilestone: milestoneId } : {},
      ...executedAt ? { executed: true } : {}
    });
  }
  return entries;
}
function extractBoldField(text, key) {
  const regex = new RegExp(`^\\*\\*${escapeRegex(key)}:\\*\\*\\s*(.+)$`, "m");
  const match = regex.exec(text);
  return match ? match[1].trim() : null;
}
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function parseTriageOutput(llmResponse) {
  if (!llmResponse || !llmResponse.trim()) return [];
  const fenced = llmResponse.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  const jsonStr = fenced ? fenced[1] : extractJsonSubstring(llmResponse);
  if (!jsonStr) return [];
  try {
    const parsed = JSON.parse(jsonStr);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr.filter(isValidTriageResult).map(normalizeTriageResult);
  } catch {
    return [];
  }
}
function extractJsonSubstring(text) {
  const arrStart = text.indexOf("[");
  const objStart = text.indexOf("{");
  let start;
  let openChar;
  let closeChar;
  if (arrStart === -1 && objStart === -1) return null;
  if (arrStart === -1) {
    start = objStart;
    openChar = "{";
    closeChar = "}";
  } else if (objStart === -1) {
    start = arrStart;
    openChar = "[";
    closeChar = "]";
  } else {
    start = Math.min(arrStart, objStart);
    openChar = start === arrStart ? "[" : "{";
    closeChar = start === arrStart ? "]" : "}";
  }
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === openChar) depth++;
    if (ch === closeChar) depth--;
    if (depth === 0) {
      return text.slice(start, i + 1);
    }
  }
  return null;
}
function isValidTriageResult(obj) {
  if (!obj || typeof obj !== "object") return false;
  const o = obj;
  return typeof o.captureId === "string" && typeof o.classification === "string" && VALID_CLASSIFICATIONS.includes(o.classification) && typeof o.rationale === "string";
}
function normalizeTriageResult(obj) {
  return {
    captureId: obj.captureId,
    classification: obj.classification,
    rationale: obj.rationale,
    ...Array.isArray(obj.affectedFiles) ? { affectedFiles: obj.affectedFiles } : {},
    ...typeof obj.targetSlice === "string" ? { targetSlice: obj.targetSlice } : {}
  };
}
export {
  appendCapture,
  countPendingCaptures,
  hasPendingCaptures,
  loadActionableCaptures,
  loadAllCaptures,
  loadBacktrackCaptures,
  loadPendingCaptures,
  loadStopCaptures,
  markCaptureExecuted,
  markCaptureResolved,
  parseTriageOutput,
  resolveCapturesPath,
  revertExecutorResolvedCaptures,
  stampCaptureMilestone
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9jYXB0dXJlcy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBHU0QgQ2FwdHVyZXMgXHUyMDE0IEZpcmUtYW5kLWZvcmdldCB0aG91Z2h0IGNhcHR1cmUgd2l0aCB0cmlhZ2UgY2xhc3NpZmljYXRpb25cbiAqXG4gKiBBcHBlbmQtb25seSBjYXB0dXJlIGZpbGUgYXQgYC5nc2QvQ0FQVFVSRVMubWRgLiBFYWNoIGNhcHR1cmUgaXMgYW4gSDMgc2VjdGlvblxuICogd2l0aCBib2xkIG1ldGFkYXRhIGZpZWxkcywgcGFyc2VhYmxlIGJ5IHRoZSBzYW1lIHBhdHRlcm5zIHVzZWQgaW4gZmlsZXMudHMuXG4gKlxuICogV29ya3RyZWUtYXdhcmU6IGNhcHR1cmVzIGFsd2F5cyByZXNvbHZlIHRvIHRoZSBvcmlnaW5hbCBwcm9qZWN0IHJvb3Qnc1xuICogYC5nc2QvQ0FQVFVSRVMubWRgLCBub3QgdGhlIHdvcmt0cmVlJ3MgbG9jYWwgYC5nc2QvYC5cbiAqL1xuXG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkRmlsZVN5bmMsIHdyaXRlRmlsZVN5bmMsIG1rZGlyU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luLCByZXNvbHZlLCBzZXAgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSBcIm5vZGU6Y3J5cHRvXCI7XG5pbXBvcnQgeyBnc2RSb290IH0gZnJvbSBcIi4vcGF0aHMuanNcIjtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFR5cGVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgdHlwZSBDbGFzc2lmaWNhdGlvbiA9IFwicXVpY2stdGFza1wiIHwgXCJpbmplY3RcIiB8IFwiZGVmZXJcIiB8IFwicmVwbGFuXCIgfCBcIm5vdGVcIiB8IFwic3RvcFwiIHwgXCJiYWNrdHJhY2tcIjtcblxuZXhwb3J0IGludGVyZmFjZSBDYXB0dXJlRW50cnkge1xuICBpZDogc3RyaW5nO1xuICB0ZXh0OiBzdHJpbmc7XG4gIHRpbWVzdGFtcDogc3RyaW5nO1xuICBzdGF0dXM6IFwicGVuZGluZ1wiIHwgXCJ0cmlhZ2VkXCIgfCBcInJlc29sdmVkXCI7XG4gIGNsYXNzaWZpY2F0aW9uPzogQ2xhc3NpZmljYXRpb247XG4gIHJlc29sdXRpb24/OiBzdHJpbmc7XG4gIHJhdGlvbmFsZT86IHN0cmluZztcbiAgcmVzb2x2ZWRBdD86IHN0cmluZztcbiAgcmVzb2x2ZWRJbk1pbGVzdG9uZT86IHN0cmluZztcbiAgZXhlY3V0ZWQ/OiBib29sZWFuO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFRyaWFnZVJlc3VsdCB7XG4gIGNhcHR1cmVJZDogc3RyaW5nO1xuICBjbGFzc2lmaWNhdGlvbjogQ2xhc3NpZmljYXRpb247XG4gIHJhdGlvbmFsZTogc3RyaW5nO1xuICBhZmZlY3RlZEZpbGVzPzogc3RyaW5nW107XG4gIHRhcmdldFNsaWNlPzogc3RyaW5nO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQ29uc3RhbnRzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5jb25zdCBDQVBUVVJFU19GSUxFTkFNRSA9IFwiQ0FQVFVSRVMubWRcIjtcbmNvbnN0IFZBTElEX0NMQVNTSUZJQ0FUSU9OUzogcmVhZG9ubHkgc3RyaW5nW10gPSBbXG4gIFwicXVpY2stdGFza1wiLCBcImluamVjdFwiLCBcImRlZmVyXCIsIFwicmVwbGFuXCIsIFwibm90ZVwiLCBcInN0b3BcIiwgXCJiYWNrdHJhY2tcIixcbl07XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBQYXRoIFJlc29sdXRpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogUmVzb2x2ZSB0aGUgcGF0aCB0byBDQVBUVVJFUy5tZCwgYXdhcmUgb2Ygd29ya3RyZWUgY29udGV4dC5cbiAqXG4gKiBJbiB3b3JrdHJlZS1pc29sYXRlZCBtb2RlLCBiYXNlUGF0aCBpcyBgLmdzZC93b3JrdHJlZXMvPE1JRD4vYC5cbiAqIENhcHR1cmVzIG11c3QgcmVzb2x2ZSB0byB0aGUgKm9yaWdpbmFsKiBwcm9qZWN0IHJvb3QncyBgLmdzZC9DQVBUVVJFUy5tZGAsXG4gKiBub3QgdGhlIHdvcmt0cmVlLWxvY2FsIGAuZ3NkL2AuIFRoaXMgZW5zdXJlcyBhbGwgY2FwdHVyZXMgZ28gdG8gb25lIGZpbGVcbiAqIHJlZ2FyZGxlc3Mgb2Ygd2hpY2ggd29ya3RyZWUgdGhlIGFnZW50IGlzIHJ1bm5pbmcgaW4uXG4gKlxuICogRGV0ZWN0aW9uOiBpZiBiYXNlUGF0aCBjb250YWlucyBgLy5nc2Qvd29ya3RyZWVzL2AsIHdhbGsgdXAgdG8gdGhlXG4gKiBkaXJlY3RvcnkgdGhhdCBjb250YWlucyBgLmdzZC93b3JrdHJlZXMvYCBcdTIwMTQgdGhhdCdzIHRoZSBwcm9qZWN0IHJvb3QuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlQ2FwdHVyZXNQYXRoKGJhc2VQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCByZXNvbHZlZCA9IHJlc29sdmUoYmFzZVBhdGgpO1xuICAvLyBEaXJlY3QgbGF5b3V0OiAvLmdzZC93b3JrdHJlZXMvXG4gIGNvbnN0IHdvcmt0cmVlTWFya2VyID0gYCR7c2VwfS5nc2Qke3NlcH13b3JrdHJlZXMke3NlcH1gO1xuICBsZXQgaWR4ID0gcmVzb2x2ZWQuaW5kZXhPZih3b3JrdHJlZU1hcmtlcik7XG4gIGlmIChpZHggPT09IC0xKSB7XG4gICAgLy8gU3ltbGluay1yZXNvbHZlZCBsYXlvdXQ6IC8uZ3NkL3Byb2plY3RzLzxoYXNoPi93b3JrdHJlZXMvXG4gICAgY29uc3Qgc3ltbGlua1JlID0gbmV3IFJlZ0V4cChcbiAgICAgIGBcXFxcJHtzZXB9XFxcXC5nc2RcXFxcJHtzZXB9cHJvamVjdHNcXFxcJHtzZXB9W2EtZjAtOV0rXFxcXCR7c2VwfXdvcmt0cmVlc1xcXFwke3NlcH1gLFxuICAgICk7XG4gICAgY29uc3QgbWF0Y2ggPSByZXNvbHZlZC5tYXRjaChzeW1saW5rUmUpO1xuICAgIGlmIChtYXRjaCAmJiBtYXRjaC5pbmRleCAhPT0gdW5kZWZpbmVkKSBpZHggPSBtYXRjaC5pbmRleDtcbiAgfVxuICBpZiAoaWR4ICE9PSAtMSkge1xuICAgIC8vIGJhc2VQYXRoIGlzIGluc2lkZSBhIHdvcmt0cmVlIFx1MjAxNCByZXNvbHZlIHRvIHByb2plY3Qgcm9vdFxuICAgIGNvbnN0IHByb2plY3RSb290ID0gcmVzb2x2ZWQuc2xpY2UoMCwgaWR4KTtcbiAgICByZXR1cm4gam9pbihwcm9qZWN0Um9vdCwgXCIuZ3NkXCIsIENBUFRVUkVTX0ZJTEVOQU1FKTtcbiAgfVxuICByZXR1cm4gam9pbihnc2RSb290KGJhc2VQYXRoKSwgQ0FQVFVSRVNfRklMRU5BTUUpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRmlsZSBJL08gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogQXBwZW5kIGEgbmV3IGNhcHR1cmUgZW50cnkgdG8gQ0FQVFVSRVMubWQuXG4gKiBDcmVhdGVzIGAuZ3NkL2AgYW5kIHRoZSBmaWxlIGlmIHRoZXkgZG9uJ3QgZXhpc3QuXG4gKiBSZXR1cm5zIHRoZSBnZW5lcmF0ZWQgY2FwdHVyZSBJRC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFwcGVuZENhcHR1cmUoYmFzZVBhdGg6IHN0cmluZywgdGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgZmlsZVBhdGggPSByZXNvbHZlQ2FwdHVyZXNQYXRoKGJhc2VQYXRoKTtcbiAgY29uc3QgZGlyID0gam9pbihmaWxlUGF0aCwgXCIuLlwiKTtcbiAgaWYgKCFleGlzdHNTeW5jKGRpcikpIHtcbiAgICBta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgfVxuXG4gIGNvbnN0IGlkID0gYENBUC0ke3JhbmRvbVVVSUQoKS5zbGljZSgwLCA4KX1gO1xuICBjb25zdCB0aW1lc3RhbXAgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XG5cbiAgY29uc3QgZW50cnkgPSBbXG4gICAgYCMjIyAke2lkfWAsXG4gICAgYCoqVGV4dDoqKiAke3RleHR9YCxcbiAgICBgKipDYXB0dXJlZDoqKiAke3RpbWVzdGFtcH1gLFxuICAgIGAqKlN0YXR1czoqKiBwZW5kaW5nYCxcbiAgICBcIlwiLFxuICBdLmpvaW4oXCJcXG5cIik7XG5cbiAgaWYgKGV4aXN0c1N5bmMoZmlsZVBhdGgpKSB7XG4gICAgY29uc3QgZXhpc3RpbmcgPSByZWFkRmlsZVN5bmMoZmlsZVBhdGgsIFwidXRmLThcIik7XG4gICAgd3JpdGVGaWxlU3luYyhmaWxlUGF0aCwgZXhpc3RpbmcudHJpbUVuZCgpICsgXCJcXG5cXG5cIiArIGVudHJ5LCBcInV0Zi04XCIpO1xuICB9IGVsc2Uge1xuICAgIGNvbnN0IGhlYWRlciA9IGAjIENhcHR1cmVzXFxuXFxuYDtcbiAgICB3cml0ZUZpbGVTeW5jKGZpbGVQYXRoLCBoZWFkZXIgKyBlbnRyeSwgXCJ1dGYtOFwiKTtcbiAgfVxuXG4gIHJldHVybiBpZDtcbn1cblxuLyoqXG4gKiBQYXJzZSBhbGwgY2FwdHVyZSBlbnRyaWVzIGZyb20gQ0FQVFVSRVMubWQuXG4gKiBSZXR1cm5zIGVudHJpZXMgaW4gZmlsZSBvcmRlciAob2xkZXN0IGZpcnN0KS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxvYWRBbGxDYXB0dXJlcyhiYXNlUGF0aDogc3RyaW5nKTogQ2FwdHVyZUVudHJ5W10ge1xuICBjb25zdCBmaWxlUGF0aCA9IHJlc29sdmVDYXB0dXJlc1BhdGgoYmFzZVBhdGgpO1xuICBpZiAoIWV4aXN0c1N5bmMoZmlsZVBhdGgpKSByZXR1cm4gW107XG5cbiAgY29uc3QgY29udGVudCA9IHJlYWRGaWxlU3luYyhmaWxlUGF0aCwgXCJ1dGYtOFwiKTtcbiAgcmV0dXJuIHBhcnNlQ2FwdHVyZXNDb250ZW50KGNvbnRlbnQpO1xufVxuXG4vKipcbiAqIExvYWQgb25seSBwZW5kaW5nICh1bnJlc29sdmVkKSBjYXB0dXJlcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxvYWRQZW5kaW5nQ2FwdHVyZXMoYmFzZVBhdGg6IHN0cmluZyk6IENhcHR1cmVFbnRyeVtdIHtcbiAgcmV0dXJuIGxvYWRBbGxDYXB0dXJlcyhiYXNlUGF0aCkuZmlsdGVyKGMgPT4gYy5zdGF0dXMgPT09IFwicGVuZGluZ1wiKTtcbn1cblxuLyoqXG4gKiBGYXN0IGNoZWNrIGZvciBwZW5kaW5nIGNhcHR1cmVzIHdpdGhvdXQgZnVsbCBwYXJzZS5cbiAqIFJlYWRzIHRoZSBmaWxlIGFuZCBzY2FucyBmb3IgYCoqU3RhdHVzOioqIHBlbmRpbmdgIHZpYSByZWdleC5cbiAqIFJldHVybnMgZmFsc2UgaWYgdGhlIGZpbGUgZG9lc24ndCBleGlzdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhhc1BlbmRpbmdDYXB0dXJlcyhiYXNlUGF0aDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IGZpbGVQYXRoID0gcmVzb2x2ZUNhcHR1cmVzUGF0aChiYXNlUGF0aCk7XG4gIGlmICghZXhpc3RzU3luYyhmaWxlUGF0aCkpIHJldHVybiBmYWxzZTtcbiAgdHJ5IHtcbiAgICBjb25zdCBjb250ZW50ID0gcmVhZEZpbGVTeW5jKGZpbGVQYXRoLCBcInV0Zi04XCIpO1xuICAgIHJldHVybiAvXFwqXFwqU3RhdHVzOlxcKlxcKlxccypwZW5kaW5nL2kudGVzdChjb250ZW50KTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbi8qKlxuICogQ291bnQgcGVuZGluZyBjYXB0dXJlcyB3aXRob3V0IGZ1bGwgcGFyc2UgXHUyMDE0IHNpbmdsZSBmaWxlIHJlYWQuXG4gKiBVc2VzIHJlZ2V4IHRvIGNvdW50IGAqKlN0YXR1czoqKiBwZW5kaW5nYCBvY2N1cnJlbmNlcy5cbiAqIFJldHVybnMgMCBpZiBmaWxlIGRvZXNuJ3QgZXhpc3Qgb3Igb24gZXJyb3IuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb3VudFBlbmRpbmdDYXB0dXJlcyhiYXNlUGF0aDogc3RyaW5nKTogbnVtYmVyIHtcbiAgY29uc3QgZmlsZVBhdGggPSByZXNvbHZlQ2FwdHVyZXNQYXRoKGJhc2VQYXRoKTtcbiAgaWYgKCFleGlzdHNTeW5jKGZpbGVQYXRoKSkgcmV0dXJuIDA7XG4gIHRyeSB7XG4gICAgY29uc3QgY29udGVudCA9IHJlYWRGaWxlU3luYyhmaWxlUGF0aCwgXCJ1dGYtOFwiKTtcbiAgICBjb25zdCBtYXRjaGVzID0gY29udGVudC5tYXRjaCgvXFwqXFwqU3RhdHVzOlxcKlxcKlxccypwZW5kaW5nL2dpKTtcbiAgICByZXR1cm4gbWF0Y2hlcyA/IG1hdGNoZXMubGVuZ3RoIDogMDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIDA7XG4gIH1cbn1cblxuLyoqXG4gKiBNYXJrIGEgY2FwdHVyZSBhcyByZXNvbHZlZCB3aXRoIGNsYXNzaWZpY2F0aW9uIGFuZCByYXRpb25hbGUuXG4gKiBSZXdyaXRlcyB0aGUgZW50cnkgaW4gcGxhY2UsIHByZXNlcnZpbmcgb3RoZXIgZW50cmllcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG1hcmtDYXB0dXJlUmVzb2x2ZWQoXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIGNhcHR1cmVJZDogc3RyaW5nLFxuICBjbGFzc2lmaWNhdGlvbjogQ2xhc3NpZmljYXRpb24sXG4gIHJlc29sdXRpb246IHN0cmluZyxcbiAgcmF0aW9uYWxlOiBzdHJpbmcsXG4gIG1pbGVzdG9uZUlkPzogc3RyaW5nLFxuKTogdm9pZCB7XG4gIGNvbnN0IGZpbGVQYXRoID0gcmVzb2x2ZUNhcHR1cmVzUGF0aChiYXNlUGF0aCk7XG4gIGlmICghZXhpc3RzU3luYyhmaWxlUGF0aCkpIHJldHVybjtcblxuICBjb25zdCBjb250ZW50ID0gcmVhZEZpbGVTeW5jKGZpbGVQYXRoLCBcInV0Zi04XCIpO1xuICBjb25zdCByZXNvbHZlZEF0ID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuXG4gIC8vIEZpbmQgdGhlIHNlY3Rpb24gZm9yIHRoaXMgY2FwdHVyZSBJRCBhbmQgcmV3cml0ZSBpdHMgZmllbGRzXG4gIGNvbnN0IHNlY3Rpb25SZWdleCA9IG5ldyBSZWdFeHAoXG4gICAgYCgjIyMgJHtlc2NhcGVSZWdleChjYXB0dXJlSWQpfVxcXFxuKD86KD8hIyMjICkuKSo/KSg/PSMjIyB8JClgLFxuICAgIFwic1wiLFxuICApO1xuICBjb25zdCBtYXRjaCA9IHNlY3Rpb25SZWdleC5leGVjKGNvbnRlbnQpO1xuICBpZiAoIW1hdGNoKSByZXR1cm47XG5cbiAgbGV0IHNlY3Rpb24gPSBtYXRjaFsxXTtcblxuICAvLyBVcGRhdGUgU3RhdHVzIGZpZWxkXG4gIHNlY3Rpb24gPSBzZWN0aW9uLnJlcGxhY2UoXG4gICAgL1xcKlxcKlN0YXR1czpcXCpcXCpcXHMqLisvLFxuICAgIGAqKlN0YXR1czoqKiByZXNvbHZlZGAsXG4gICk7XG5cbiAgLy8gQXBwZW5kIGNsYXNzaWZpY2F0aW9uLCByZXNvbHV0aW9uLCByYXRpb25hbGUsIGFuZCB0aW1lc3RhbXAgaWYgbm90IHByZXNlbnRcbiAgY29uc3QgbmV3RmllbGRzID0gW1xuICAgIGAqKkNsYXNzaWZpY2F0aW9uOioqICR7Y2xhc3NpZmljYXRpb259YCxcbiAgICBgKipSZXNvbHV0aW9uOioqICR7cmVzb2x1dGlvbn1gLFxuICAgIGAqKlJhdGlvbmFsZToqKiAke3JhdGlvbmFsZX1gLFxuICAgIGAqKlJlc29sdmVkOioqICR7cmVzb2x2ZWRBdH1gLFxuICBdO1xuICBpZiAobWlsZXN0b25lSWQpIHtcbiAgICBuZXdGaWVsZHMucHVzaChgKipNaWxlc3RvbmU6KiogJHttaWxlc3RvbmVJZH1gKTtcbiAgfVxuXG4gIC8vIFJlbW92ZSBhbnkgZXhpc3RpbmcgY2xhc3NpZmljYXRpb24vcmVzb2x1dGlvbi9yYXRpb25hbGUvcmVzb2x2ZWQvbWlsZXN0b25lIGZpZWxkc1xuICAvLyAoaW4gY2FzZSBvZiByZS10cmlhZ2UpXG4gIHNlY3Rpb24gPSBzZWN0aW9uLnJlcGxhY2UoL1xcKlxcKkNsYXNzaWZpY2F0aW9uOlxcKlxcKlxccyouK1xcbj8vZywgXCJcIik7XG4gIHNlY3Rpb24gPSBzZWN0aW9uLnJlcGxhY2UoL1xcKlxcKlJlc29sdXRpb246XFwqXFwqXFxzKi4rXFxuPy9nLCBcIlwiKTtcbiAgc2VjdGlvbiA9IHNlY3Rpb24ucmVwbGFjZSgvXFwqXFwqUmF0aW9uYWxlOlxcKlxcKlxccyouK1xcbj8vZywgXCJcIik7XG4gIHNlY3Rpb24gPSBzZWN0aW9uLnJlcGxhY2UoL1xcKlxcKlJlc29sdmVkOlxcKlxcKlxccyouK1xcbj8vZywgXCJcIik7XG4gIHNlY3Rpb24gPSBzZWN0aW9uLnJlcGxhY2UoL1xcKlxcKk1pbGVzdG9uZTpcXCpcXCpcXHMqLitcXG4/L2csIFwiXCIpO1xuXG4gIC8vIEFkZCBuZXcgZmllbGRzIGFmdGVyIFN0YXR1cyBsaW5lXG4gIHNlY3Rpb24gPSBzZWN0aW9uLnRyaW1FbmQoKSArIFwiXFxuXCIgKyBuZXdGaWVsZHMuam9pbihcIlxcblwiKSArIFwiXFxuXCI7XG5cbiAgY29uc3QgdXBkYXRlZCA9IGNvbnRlbnQucmVwbGFjZShzZWN0aW9uUmVnZXgsIHNlY3Rpb24pO1xuICB3cml0ZUZpbGVTeW5jKGZpbGVQYXRoLCB1cGRhdGVkLCBcInV0Zi04XCIpO1xufVxuXG4vKipcbiAqIE1hcmsgYSByZXNvbHZlZCBjYXB0dXJlIGFzIGV4ZWN1dGVkIFx1MjAxNCBpdHMgcmVzb2x1dGlvbiBhY3Rpb24gd2FzIGNhcnJpZWQgb3V0LlxuICogQXBwZW5kcyBgKipFeGVjdXRlZDoqKiA8dGltZXN0YW1wPmAgdG8gdGhlIGNhcHR1cmUncyBzZWN0aW9uIGluIENBUFRVUkVTLm1kLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbWFya0NhcHR1cmVFeGVjdXRlZChiYXNlUGF0aDogc3RyaW5nLCBjYXB0dXJlSWQ6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBmaWxlUGF0aCA9IHJlc29sdmVDYXB0dXJlc1BhdGgoYmFzZVBhdGgpO1xuICBpZiAoIWV4aXN0c1N5bmMoZmlsZVBhdGgpKSByZXR1cm47XG5cbiAgY29uc3QgY29udGVudCA9IHJlYWRGaWxlU3luYyhmaWxlUGF0aCwgXCJ1dGYtOFwiKTtcbiAgY29uc3QgZXhlY3V0ZWRBdCA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcblxuICBjb25zdCBzZWN0aW9uUmVnZXggPSBuZXcgUmVnRXhwKFxuICAgIGAoIyMjICR7ZXNjYXBlUmVnZXgoY2FwdHVyZUlkKX1cXFxcbig/Oig/ISMjIyApLikqPykoPz0jIyMgfCQpYCxcbiAgICBcInNcIixcbiAgKTtcbiAgY29uc3QgbWF0Y2ggPSBzZWN0aW9uUmVnZXguZXhlYyhjb250ZW50KTtcbiAgaWYgKCFtYXRjaCkgcmV0dXJuO1xuXG4gIGxldCBzZWN0aW9uID0gbWF0Y2hbMV07XG5cbiAgLy8gUmVtb3ZlIGFueSBleGlzdGluZyBFeGVjdXRlZCBmaWVsZCAoaW4gY2FzZSBvZiByZS1leGVjdXRpb24pXG4gIHNlY3Rpb24gPSBzZWN0aW9uLnJlcGxhY2UoL1xcKlxcKkV4ZWN1dGVkOlxcKlxcKlxccyouK1xcbj8vZywgXCJcIik7XG5cbiAgLy8gQXBwZW5kIEV4ZWN1dGVkIHRpbWVzdGFtcFxuICBzZWN0aW9uID0gc2VjdGlvbi50cmltRW5kKCkgKyBcIlxcblwiICsgYCoqRXhlY3V0ZWQ6KiogJHtleGVjdXRlZEF0fWAgKyBcIlxcblwiO1xuXG4gIGNvbnN0IHVwZGF0ZWQgPSBjb250ZW50LnJlcGxhY2Uoc2VjdGlvblJlZ2V4LCBzZWN0aW9uKTtcbiAgd3JpdGVGaWxlU3luYyhmaWxlUGF0aCwgdXBkYXRlZCwgXCJ1dGYtOFwiKTtcbn1cblxuLyoqXG4gKiBMb2FkIHJlc29sdmVkIGNhcHR1cmVzIHRoYXQgaGF2ZSBhY3Rpb25hYmxlIGNsYXNzaWZpY2F0aW9ucyAoaW5qZWN0LCByZXBsYW4sXG4gKiBxdWljay10YXNrKSBidXQgaGF2ZSBOT1QgeWV0IGJlZW4gZXhlY3V0ZWQuXG4gKiBUaGVzZSBhcmUgY2FwdHVyZXMgd2hvc2UgcmVzb2x1dGlvbnMgbmVlZCB0byBiZSBjYXJyaWVkIG91dC5cbiAqXG4gKiBXaGVuIGBjdXJyZW50TWlsZXN0b25lSWRgIGlzIHByb3ZpZGVkLCBjYXB0dXJlcyByZXNvbHZlZCBpbiBhICpkaWZmZXJlbnQqXG4gKiBtaWxlc3RvbmUgYXJlIHRyZWF0ZWQgYXMgc3RhbGUgYW5kIGV4Y2x1ZGVkLiAgVGhpcyBwcmV2ZW50cyBxdWljay10YXNrXG4gKiBjYXB0dXJlcyBmcm9tIGEgcHJpb3IgbWlsZXN0b25lIHJlLWV4ZWN1dGluZyBhZnRlciB0aGUgdW5kZXJseWluZyBpc3N1ZXNcbiAqIHdlcmUgYWxyZWFkeSBmaXhlZCBieSBwbGFubmVkIG1pbGVzdG9uZSB3b3JrICgjMjg3MikuXG4gKlxuICogQ2FwdHVyZXMgdGhhdCBoYXZlIG5vIGByZXNvbHZlZEluTWlsZXN0b25lYCAobGVnYWN5IGNhcHR1cmVzIHJlc29sdmVkIGJlZm9yZVxuICogdGhpcyBmaWVsZCB3YXMgaW50cm9kdWNlZCkgYXJlIGFsd2F5cyBpbmNsdWRlZCBmb3IgYmFja3dhcmQgY29tcGF0aWJpbGl0eS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxvYWRBY3Rpb25hYmxlQ2FwdHVyZXMoYmFzZVBhdGg6IHN0cmluZywgY3VycmVudE1pbGVzdG9uZUlkPzogc3RyaW5nKTogQ2FwdHVyZUVudHJ5W10ge1xuICByZXR1cm4gbG9hZEFsbENhcHR1cmVzKGJhc2VQYXRoKS5maWx0ZXIoXG4gICAgYyA9PlxuICAgICAgYy5zdGF0dXMgPT09IFwicmVzb2x2ZWRcIiAmJlxuICAgICAgIWMuZXhlY3V0ZWQgJiZcbiAgICAgIChjLmNsYXNzaWZpY2F0aW9uID09PSBcImluamVjdFwiIHx8XG4gICAgICAgIGMuY2xhc3NpZmljYXRpb24gPT09IFwicmVwbGFuXCIgfHxcbiAgICAgICAgYy5jbGFzc2lmaWNhdGlvbiA9PT0gXCJxdWljay10YXNrXCIpICYmXG4gICAgICAvLyBTdGFsZW5lc3MgZ2F0ZTogZXhjbHVkZSBjYXB0dXJlcyByZXNvbHZlZCBpbiBhIGRpZmZlcmVudCBtaWxlc3RvbmUgKCMyODcyKVxuICAgICAgKCFjdXJyZW50TWlsZXN0b25lSWQgfHxcbiAgICAgICAgIWMucmVzb2x2ZWRJbk1pbGVzdG9uZSB8fFxuICAgICAgICBjLnJlc29sdmVkSW5NaWxlc3RvbmUgPT09IGN1cnJlbnRNaWxlc3RvbmVJZCksXG4gICk7XG59XG5cbi8qKlxuICogTG9hZCB1bmV4ZWN1dGVkIHN0b3AgY2FwdHVyZXMgXHUyMDE0IHVzZXIgZGlyZWN0aXZlcyB0byBoYWx0IGF1dG8tbW9kZS5cbiAqIFRoZXNlIGFyZSBjaGVja2VkIGluIHRoZSBwcmUtZGlzcGF0Y2ggZ3VhcmQgcGlwZWxpbmUgKHJ1bkd1YXJkcykgdG9cbiAqIHBhdXNlIGF1dG8tbW9kZSBiZWZvcmUgdGhlIG5leHQgdW5pdCBpcyBkaXNwYXRjaGVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbG9hZFN0b3BDYXB0dXJlcyhiYXNlUGF0aDogc3RyaW5nKTogQ2FwdHVyZUVudHJ5W10ge1xuICByZXR1cm4gbG9hZEFsbENhcHR1cmVzKGJhc2VQYXRoKS5maWx0ZXIoXG4gICAgYyA9PiBjLnN0YXR1cyA9PT0gXCJyZXNvbHZlZFwiICYmICFjLmV4ZWN1dGVkICYmXG4gICAgICAoYy5jbGFzc2lmaWNhdGlvbiA9PT0gXCJzdG9wXCIgfHwgYy5jbGFzc2lmaWNhdGlvbiA9PT0gXCJiYWNrdHJhY2tcIiksXG4gICk7XG59XG5cbi8qKlxuICogTG9hZCB1bmV4ZWN1dGVkIGJhY2t0cmFjayBjYXB0dXJlcyBzcGVjaWZpY2FsbHkgXHUyMDE0IGNhcHR1cmVzIGRpcmVjdGluZ1xuICogYXV0by1tb2RlIHRvIGFiYW5kb24gY3VycmVudCBtaWxlc3RvbmUgYW5kIHJldHVybiB0byBhIHByZXZpb3VzIG9uZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxvYWRCYWNrdHJhY2tDYXB0dXJlcyhiYXNlUGF0aDogc3RyaW5nKTogQ2FwdHVyZUVudHJ5W10ge1xuICByZXR1cm4gbG9hZEFsbENhcHR1cmVzKGJhc2VQYXRoKS5maWx0ZXIoXG4gICAgYyA9PiBjLnN0YXR1cyA9PT0gXCJyZXNvbHZlZFwiICYmICFjLmV4ZWN1dGVkICYmIGMuY2xhc3NpZmljYXRpb24gPT09IFwiYmFja3RyYWNrXCIsXG4gICk7XG59XG5cbi8qKlxuICogUmV2ZXJ0IGNhcHR1cmVzIHRoYXQgd2VyZSBzaWxlbmNlZCBieSBub24tdHJpYWdlIGFnZW50cy5cbiAqXG4gKiBXaGVuIGFuIGV4ZWN1dGUtdGFzayBvciBvdGhlciBub24tdHJpYWdlIGFnZW50IHdyaXRlcyBgKipTdGF0dXM6KiogcmVzb2x2ZWRgXG4gKiB0byBDQVBUVVJFUy5tZCwgaXQgYnlwYXNzZXMgdGhlIHRyaWFnZSBwaXBlbGluZSBlbnRpcmVseS4gVGhpcyBmdW5jdGlvblxuICogZGV0ZWN0cyBzdWNoIGNhcHR1cmVzIChyZXNvbHZlZCBidXQgbWlzc2luZyB0aGUgQ2xhc3NpZmljYXRpb24gZmllbGQgdGhhdFxuICogdHJpYWdlIGFsd2F5cyB3cml0ZXMpIGFuZCByZXZlcnRzIHRoZW0gdG8gcGVuZGluZyBzbyB0aGUgdHJpYWdlIHNpZGVjYXJcbiAqIHBpY2tzIHRoZW0gdXAgcHJvcGVybHkuXG4gKlxuICogUmV0dXJucyB0aGUgbnVtYmVyIG9mIGNhcHR1cmVzIHJldmVydGVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmV2ZXJ0RXhlY3V0b3JSZXNvbHZlZENhcHR1cmVzKGJhc2VQYXRoOiBzdHJpbmcpOiBudW1iZXIge1xuICBjb25zdCBmaWxlUGF0aCA9IHJlc29sdmVDYXB0dXJlc1BhdGgoYmFzZVBhdGgpO1xuICBpZiAoIWV4aXN0c1N5bmMoZmlsZVBhdGgpKSByZXR1cm4gMDtcblxuICBsZXQgY29udGVudCA9IHJlYWRGaWxlU3luYyhmaWxlUGF0aCwgXCJ1dGYtOFwiKTtcbiAgbGV0IHJldmVydGVkID0gMDtcblxuICBjb25zdCBhbGwgPSBsb2FkQWxsQ2FwdHVyZXMoYmFzZVBhdGgpO1xuICBmb3IgKGNvbnN0IGNhcHR1cmUgb2YgYWxsKSB7XG4gICAgLy8gQSBwcm9wZXJseSB0cmlhZ2VkIGNhcHR1cmUgaGFzIGJvdGggcmVzb2x2ZWQgc3RhdHVzIEFORCBhIGNsYXNzaWZpY2F0aW9uLlxuICAgIC8vIEFuIGV4ZWN1dG9yLXNpbGVuY2VkIGNhcHR1cmUgaGFzIHJlc29sdmVkIHN0YXR1cyBidXQgTk8gY2xhc3NpZmljYXRpb24uXG4gICAgaWYgKGNhcHR1cmUuc3RhdHVzID09PSBcInJlc29sdmVkXCIgJiYgIWNhcHR1cmUuY2xhc3NpZmljYXRpb24pIHtcbiAgICAgIGNvbnN0IHNlY3Rpb25SZWdleCA9IG5ldyBSZWdFeHAoXG4gICAgICAgIGAoIyMjICR7ZXNjYXBlUmVnZXgoY2FwdHVyZS5pZCl9XFxcXG4oPzooPyEjIyMgKS4pKj8pKD89IyMjIHwkKWAsXG4gICAgICAgIFwic1wiLFxuICAgICAgKTtcbiAgICAgIGNvbnN0IG1hdGNoID0gc2VjdGlvblJlZ2V4LmV4ZWMoY29udGVudCk7XG4gICAgICBpZiAobWF0Y2gpIHtcbiAgICAgICAgbGV0IHNlY3Rpb24gPSBtYXRjaFsxXTtcbiAgICAgICAgc2VjdGlvbiA9IHNlY3Rpb24ucmVwbGFjZShcbiAgICAgICAgICAvXFwqXFwqU3RhdHVzOlxcKlxcKlxccypyZXNvbHZlZC9pLFxuICAgICAgICAgIFwiKipTdGF0dXM6KiogcGVuZGluZ1wiLFxuICAgICAgICApO1xuICAgICAgICBjb250ZW50ID0gY29udGVudC5yZXBsYWNlKHNlY3Rpb25SZWdleCwgc2VjdGlvbik7XG4gICAgICAgIHJldmVydGVkKys7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgaWYgKHJldmVydGVkID4gMCkge1xuICAgIHdyaXRlRmlsZVN5bmMoZmlsZVBhdGgsIGNvbnRlbnQsIFwidXRmLThcIik7XG4gIH1cblxuICByZXR1cm4gcmV2ZXJ0ZWQ7XG59XG5cbi8qKlxuICogUmV0cm9hY3RpdmVseSBzdGFtcCBhIGNhcHR1cmUgd2l0aCBhIG1pbGVzdG9uZSBJRC5cbiAqXG4gKiBVc2VkIGJ5IGV4ZWN1dGVUcmlhZ2VSZXNvbHV0aW9ucygpIGFzIGEgc2FmZXR5IG5ldCB3aGVuIHRoZSB0cmlhZ2UgTExNXG4gKiByZXNvbHZlcyBhIGNhcHR1cmUgd2l0aG91dCB3cml0aW5nIHRoZSAqKk1pbGVzdG9uZToqKiBmaWVsZC4gIFRoaXMgZW5zdXJlc1xuICogdGhlIHN0YWxlbmVzcyBnYXRlIGluIGxvYWRBY3Rpb25hYmxlQ2FwdHVyZXMoKSB3b3JrcyBjb3JyZWN0bHkgZXZlbiBmb3JcbiAqIGNhcHR1cmVzIHJlc29sdmVkIGJlZm9yZSB0aGUgcHJvbXB0IHdhcyB1cGRhdGVkICgjMjg3MikuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdGFtcENhcHR1cmVNaWxlc3RvbmUoYmFzZVBhdGg6IHN0cmluZywgY2FwdHVyZUlkOiBzdHJpbmcsIG1pbGVzdG9uZUlkOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgZmlsZVBhdGggPSByZXNvbHZlQ2FwdHVyZXNQYXRoKGJhc2VQYXRoKTtcbiAgaWYgKCFleGlzdHNTeW5jKGZpbGVQYXRoKSkgcmV0dXJuO1xuXG4gIGNvbnN0IGNvbnRlbnQgPSByZWFkRmlsZVN5bmMoZmlsZVBhdGgsIFwidXRmLThcIik7XG5cbiAgY29uc3Qgc2VjdGlvblJlZ2V4ID0gbmV3IFJlZ0V4cChcbiAgICBgKCMjIyAke2VzY2FwZVJlZ2V4KGNhcHR1cmVJZCl9XFxcXG4oPzooPyEjIyMgKS4pKj8pKD89IyMjIHwkKWAsXG4gICAgXCJzXCIsXG4gICk7XG4gIGNvbnN0IG1hdGNoID0gc2VjdGlvblJlZ2V4LmV4ZWMoY29udGVudCk7XG4gIGlmICghbWF0Y2gpIHJldHVybjtcblxuICBsZXQgc2VjdGlvbiA9IG1hdGNoWzFdO1xuXG4gIC8vIE9ubHkgc3RhbXAgaWYgbm90IGFscmVhZHkgcHJlc2VudFxuICBpZiAoL1xcKlxcKk1pbGVzdG9uZTpcXCpcXCovLnRlc3Qoc2VjdGlvbikpIHJldHVybjtcblxuICAvLyBJbnNlcnQgYWZ0ZXIgdGhlIFJlc29sdmVkIGZpZWxkIChvciBhdCBlbmQgb2Ygc2VjdGlvbilcbiAgY29uc3QgcmVzb2x2ZWRGaWVsZEVuZCA9IHNlY3Rpb24uc2VhcmNoKC9cXCpcXCpSZXNvbHZlZDpcXCpcXCpcXHMqLitcXG4/Lyk7XG4gIGlmIChyZXNvbHZlZEZpZWxkRW5kICE9PSAtMSkge1xuICAgIGNvbnN0IHJlc29sdmVkTWF0Y2ggPSBzZWN0aW9uLm1hdGNoKC9cXCpcXCpSZXNvbHZlZDpcXCpcXCpcXHMqLitcXG4/Lyk7XG4gICAgY29uc3QgaW5zZXJ0UG9zID0gcmVzb2x2ZWRGaWVsZEVuZCArIChyZXNvbHZlZE1hdGNoPy5bMF0/Lmxlbmd0aCA/PyAwKTtcbiAgICBzZWN0aW9uID0gc2VjdGlvbi5zbGljZSgwLCBpbnNlcnRQb3MpICsgYCoqTWlsZXN0b25lOioqICR7bWlsZXN0b25lSWR9XFxuYCArIHNlY3Rpb24uc2xpY2UoaW5zZXJ0UG9zKTtcbiAgfSBlbHNlIHtcbiAgICBzZWN0aW9uID0gc2VjdGlvbi50cmltRW5kKCkgKyBcIlxcblwiICsgYCoqTWlsZXN0b25lOioqICR7bWlsZXN0b25lSWR9YCArIFwiXFxuXCI7XG4gIH1cblxuICBjb25zdCB1cGRhdGVkID0gY29udGVudC5yZXBsYWNlKHNlY3Rpb25SZWdleCwgc2VjdGlvbik7XG4gIHdyaXRlRmlsZVN5bmMoZmlsZVBhdGgsIHVwZGF0ZWQsIFwidXRmLThcIik7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBQYXJzZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogUGFyc2UgQ0FQVFVSRVMubWQgY29udGVudCBpbnRvIENhcHR1cmVFbnRyeSBhcnJheS5cbiAqL1xuZnVuY3Rpb24gcGFyc2VDYXB0dXJlc0NvbnRlbnQoY29udGVudDogc3RyaW5nKTogQ2FwdHVyZUVudHJ5W10ge1xuICBjb25zdCBlbnRyaWVzOiBDYXB0dXJlRW50cnlbXSA9IFtdO1xuXG4gIC8vIFNwbGl0IG9uIEgzIGhlYWRpbmdzXG4gIGNvbnN0IHNlY3Rpb25zID0gY29udGVudC5zcGxpdCgvXiMjIyAvbSkuc2xpY2UoMSk7IC8vIHNraXAgY29udGVudCBiZWZvcmUgZmlyc3QgSDNcblxuICBmb3IgKGNvbnN0IHNlY3Rpb24gb2Ygc2VjdGlvbnMpIHtcbiAgICBjb25zdCBsaW5lcyA9IHNlY3Rpb24uc3BsaXQoXCJcXG5cIik7XG4gICAgY29uc3QgaWQgPSBsaW5lc1swXT8udHJpbSgpO1xuICAgIGlmICghaWQpIGNvbnRpbnVlO1xuXG4gICAgY29uc3QgYm9keSA9IGxpbmVzLnNsaWNlKDEpLmpvaW4oXCJcXG5cIik7XG4gICAgY29uc3QgdGV4dCA9IGV4dHJhY3RCb2xkRmllbGQoYm9keSwgXCJUZXh0XCIpO1xuICAgIGNvbnN0IHRpbWVzdGFtcCA9IGV4dHJhY3RCb2xkRmllbGQoYm9keSwgXCJDYXB0dXJlZFwiKTtcbiAgICBjb25zdCBzdGF0dXNSYXcgPSBleHRyYWN0Qm9sZEZpZWxkKGJvZHksIFwiU3RhdHVzXCIpO1xuICAgIGNvbnN0IGNsYXNzaWZpY2F0aW9uID0gZXh0cmFjdEJvbGRGaWVsZChib2R5LCBcIkNsYXNzaWZpY2F0aW9uXCIpIGFzIENsYXNzaWZpY2F0aW9uIHwgbnVsbDtcbiAgICBjb25zdCByZXNvbHV0aW9uID0gZXh0cmFjdEJvbGRGaWVsZChib2R5LCBcIlJlc29sdXRpb25cIik7XG4gICAgY29uc3QgcmF0aW9uYWxlID0gZXh0cmFjdEJvbGRGaWVsZChib2R5LCBcIlJhdGlvbmFsZVwiKTtcbiAgICBjb25zdCByZXNvbHZlZEF0ID0gZXh0cmFjdEJvbGRGaWVsZChib2R5LCBcIlJlc29sdmVkXCIpO1xuICAgIGNvbnN0IG1pbGVzdG9uZUlkID0gZXh0cmFjdEJvbGRGaWVsZChib2R5LCBcIk1pbGVzdG9uZVwiKTtcbiAgICBjb25zdCBleGVjdXRlZEF0ID0gZXh0cmFjdEJvbGRGaWVsZChib2R5LCBcIkV4ZWN1dGVkXCIpO1xuXG4gICAgaWYgKCF0ZXh0IHx8ICF0aW1lc3RhbXApIGNvbnRpbnVlO1xuXG4gICAgY29uc3Qgc3RhdHVzID0gKHN0YXR1c1JhdyA9PT0gXCJyZXNvbHZlZFwiIHx8IHN0YXR1c1JhdyA9PT0gXCJ0cmlhZ2VkXCIpXG4gICAgICA/IHN0YXR1c1Jhd1xuICAgICAgOiBcInBlbmRpbmdcIjtcblxuICAgIGVudHJpZXMucHVzaCh7XG4gICAgICBpZCxcbiAgICAgIHRleHQsXG4gICAgICB0aW1lc3RhbXAsXG4gICAgICBzdGF0dXMsXG4gICAgICAuLi4oY2xhc3NpZmljYXRpb24gJiYgVkFMSURfQ0xBU1NJRklDQVRJT05TLmluY2x1ZGVzKGNsYXNzaWZpY2F0aW9uKSA/IHsgY2xhc3NpZmljYXRpb24gfSA6IHt9KSxcbiAgICAgIC4uLihyZXNvbHV0aW9uID8geyByZXNvbHV0aW9uIH0gOiB7fSksXG4gICAgICAuLi4ocmF0aW9uYWxlID8geyByYXRpb25hbGUgfSA6IHt9KSxcbiAgICAgIC4uLihyZXNvbHZlZEF0ID8geyByZXNvbHZlZEF0IH0gOiB7fSksXG4gICAgICAuLi4obWlsZXN0b25lSWQgPyB7IHJlc29sdmVkSW5NaWxlc3RvbmU6IG1pbGVzdG9uZUlkIH0gOiB7fSksXG4gICAgICAuLi4oZXhlY3V0ZWRBdCA/IHsgZXhlY3V0ZWQ6IHRydWUgfSA6IHt9KSxcbiAgICB9KTtcbiAgfVxuXG4gIHJldHVybiBlbnRyaWVzO1xufVxuXG4vKipcbiAqIEV4dHJhY3QgdmFsdWUgZnJvbSBhIGJvbGQtcHJlZml4ZWQgbGluZSBsaWtlIFwiKipLZXk6KiogVmFsdWVcIi5cbiAqIExvY2FsIGNvcHkgb2YgdGhlIHBhdHRlcm4gZnJvbSBmaWxlcy50cyB0byBrZWVwIHRoaXMgbW9kdWxlIHNlbGYtY29udGFpbmVkLlxuICovXG5mdW5jdGlvbiBleHRyYWN0Qm9sZEZpZWxkKHRleHQ6IHN0cmluZywga2V5OiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3QgcmVnZXggPSBuZXcgUmVnRXhwKGBeXFxcXCpcXFxcKiR7ZXNjYXBlUmVnZXgoa2V5KX06XFxcXCpcXFxcKlxcXFxzKiguKykkYCwgXCJtXCIpO1xuICBjb25zdCBtYXRjaCA9IHJlZ2V4LmV4ZWModGV4dCk7XG4gIHJldHVybiBtYXRjaCA/IG1hdGNoWzFdLnRyaW0oKSA6IG51bGw7XG59XG5cbmZ1bmN0aW9uIGVzY2FwZVJlZ2V4KHM6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBzLnJlcGxhY2UoL1suKis/XiR7fSgpfFtcXF1cXFxcXS9nLCBcIlxcXFwkJlwiKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRyaWFnZSBPdXRwdXQgUGFyc2VyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFBhcnNlIExMTSB0cmlhZ2Ugb3V0cHV0IGludG8gVHJpYWdlUmVzdWx0IGFycmF5LlxuICpcbiAqIEhhbmRsZXM6XG4gKiAtIENsZWFuIEpTT04gYXJyYXlcbiAqIC0gSlNPTiB3cmFwcGVkIGluIGZlbmNlZCBjb2RlIGJsb2NrIChgYGBqc29uIC4uLiBgYGApXG4gKiAtIEpTT04gd2l0aCBsZWFkaW5nL3RyYWlsaW5nIHByb3NlXG4gKiAtIFNpbmdsZSBvYmplY3QgKG5vdCBhcnJheSkgXHUyMDE0IHdyYXBzIGluIGFycmF5XG4gKiAtIE1hbGZvcm1lZCBKU09OIFx1MjAxNCByZXR1cm5zIGVtcHR5IGFycmF5IChjYWxsZXIgc2hvdWxkIGZhbGwgYmFjayB0byBub3RlKVxuICogLSBQYXJ0aWFsIHJlc3VsdHMgXHUyMDE0IHZhbGlkIGVudHJpZXMgYXJlIGtlcHQsIGludmFsaWQgc2tpcHBlZFxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VUcmlhZ2VPdXRwdXQobGxtUmVzcG9uc2U6IHN0cmluZyk6IFRyaWFnZVJlc3VsdFtdIHtcbiAgaWYgKCFsbG1SZXNwb25zZSB8fCAhbGxtUmVzcG9uc2UudHJpbSgpKSByZXR1cm4gW107XG5cbiAgLy8gVHJ5IHRvIGV4dHJhY3QgSlNPTiBmcm9tIGZlbmNlZCBjb2RlIGJsb2NrcyBmaXJzdFxuICBjb25zdCBmZW5jZWQgPSBsbG1SZXNwb25zZS5tYXRjaCgvYGBgKD86anNvbik/XFxzKlxcbj8oW1xcc1xcU10qPylcXG4/XFxzKmBgYC8pO1xuICBjb25zdCBqc29uU3RyID0gZmVuY2VkID8gZmVuY2VkWzFdIDogZXh0cmFjdEpzb25TdWJzdHJpbmcobGxtUmVzcG9uc2UpO1xuXG4gIGlmICghanNvblN0cikgcmV0dXJuIFtdO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShqc29uU3RyKTtcbiAgICBjb25zdCBhcnIgPSBBcnJheS5pc0FycmF5KHBhcnNlZCkgPyBwYXJzZWQgOiBbcGFyc2VkXTtcbiAgICByZXR1cm4gYXJyXG4gICAgICAuZmlsdGVyKGlzVmFsaWRUcmlhZ2VSZXN1bHQpXG4gICAgICAubWFwKG5vcm1hbGl6ZVRyaWFnZVJlc3VsdCk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBbXTtcbiAgfVxufVxuXG4vKipcbiAqIFRyeSB0byBmaW5kIGEgSlNPTiBhcnJheSBvciBvYmplY3Qgc3Vic3RyaW5nIGluIHByb3NlIHRleHQuXG4gKiBMb29rcyBmb3IgdGhlIGZpcnN0IFsgb3IgeyBhbmQgZmluZHMgaXRzIG1hdGNoaW5nIGJyYWNrZXQuXG4gKi9cbmZ1bmN0aW9uIGV4dHJhY3RKc29uU3Vic3RyaW5nKHRleHQ6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICAvLyBGaW5kIGZpcnN0IFsgb3Ige1xuICBjb25zdCBhcnJTdGFydCA9IHRleHQuaW5kZXhPZihcIltcIik7XG4gIGNvbnN0IG9ialN0YXJ0ID0gdGV4dC5pbmRleE9mKFwie1wiKTtcblxuICBsZXQgc3RhcnQ6IG51bWJlcjtcbiAgbGV0IG9wZW5DaGFyOiBzdHJpbmc7XG4gIGxldCBjbG9zZUNoYXI6IHN0cmluZztcblxuICBpZiAoYXJyU3RhcnQgPT09IC0xICYmIG9ialN0YXJ0ID09PSAtMSkgcmV0dXJuIG51bGw7XG4gIGlmIChhcnJTdGFydCA9PT0gLTEpIHtcbiAgICBzdGFydCA9IG9ialN0YXJ0O1xuICAgIG9wZW5DaGFyID0gXCJ7XCI7XG4gICAgY2xvc2VDaGFyID0gXCJ9XCI7XG4gIH0gZWxzZSBpZiAob2JqU3RhcnQgPT09IC0xKSB7XG4gICAgc3RhcnQgPSBhcnJTdGFydDtcbiAgICBvcGVuQ2hhciA9IFwiW1wiO1xuICAgIGNsb3NlQ2hhciA9IFwiXVwiO1xuICB9IGVsc2Uge1xuICAgIHN0YXJ0ID0gTWF0aC5taW4oYXJyU3RhcnQsIG9ialN0YXJ0KTtcbiAgICBvcGVuQ2hhciA9IHN0YXJ0ID09PSBhcnJTdGFydCA/IFwiW1wiIDogXCJ7XCI7XG4gICAgY2xvc2VDaGFyID0gc3RhcnQgPT09IGFyclN0YXJ0ID8gXCJdXCIgOiBcIn1cIjtcbiAgfVxuXG4gIC8vIEZpbmQgbWF0Y2hpbmcgYnJhY2tldFxuICBsZXQgZGVwdGggPSAwO1xuICBsZXQgaW5TdHJpbmcgPSBmYWxzZTtcbiAgbGV0IGVzY2FwZSA9IGZhbHNlO1xuXG4gIGZvciAobGV0IGkgPSBzdGFydDsgaSA8IHRleHQubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBjaCA9IHRleHRbaV07XG4gICAgaWYgKGVzY2FwZSkge1xuICAgICAgZXNjYXBlID0gZmFsc2U7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGNoID09PSBcIlxcXFxcIikge1xuICAgICAgZXNjYXBlID0gdHJ1ZTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoY2ggPT09ICdcIicpIHtcbiAgICAgIGluU3RyaW5nID0gIWluU3RyaW5nO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChpblN0cmluZykgY29udGludWU7XG4gICAgaWYgKGNoID09PSBvcGVuQ2hhcikgZGVwdGgrKztcbiAgICBpZiAoY2ggPT09IGNsb3NlQ2hhcikgZGVwdGgtLTtcbiAgICBpZiAoZGVwdGggPT09IDApIHtcbiAgICAgIHJldHVybiB0ZXh0LnNsaWNlKHN0YXJ0LCBpICsgMSk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIGlzVmFsaWRUcmlhZ2VSZXN1bHQob2JqOiB1bmtub3duKTogYm9vbGVhbiB7XG4gIGlmICghb2JqIHx8IHR5cGVvZiBvYmogIT09IFwib2JqZWN0XCIpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgbyA9IG9iaiBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgcmV0dXJuIChcbiAgICB0eXBlb2Ygby5jYXB0dXJlSWQgPT09IFwic3RyaW5nXCIgJiZcbiAgICB0eXBlb2Ygby5jbGFzc2lmaWNhdGlvbiA9PT0gXCJzdHJpbmdcIiAmJlxuICAgIFZBTElEX0NMQVNTSUZJQ0FUSU9OUy5pbmNsdWRlcyhvLmNsYXNzaWZpY2F0aW9uKSAmJlxuICAgIHR5cGVvZiBvLnJhdGlvbmFsZSA9PT0gXCJzdHJpbmdcIlxuICApO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVUcmlhZ2VSZXN1bHQob2JqOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IFRyaWFnZVJlc3VsdCB7XG4gIHJldHVybiB7XG4gICAgY2FwdHVyZUlkOiBvYmouY2FwdHVyZUlkIGFzIHN0cmluZyxcbiAgICBjbGFzc2lmaWNhdGlvbjogb2JqLmNsYXNzaWZpY2F0aW9uIGFzIENsYXNzaWZpY2F0aW9uLFxuICAgIHJhdGlvbmFsZTogb2JqLnJhdGlvbmFsZSBhcyBzdHJpbmcsXG4gICAgLi4uKEFycmF5LmlzQXJyYXkob2JqLmFmZmVjdGVkRmlsZXMpID8geyBhZmZlY3RlZEZpbGVzOiBvYmouYWZmZWN0ZWRGaWxlcyBhcyBzdHJpbmdbXSB9IDoge30pLFxuICAgIC4uLih0eXBlb2Ygb2JqLnRhcmdldFNsaWNlID09PSBcInN0cmluZ1wiID8geyB0YXJnZXRTbGljZTogb2JqLnRhcmdldFNsaWNlIH0gOiB7fSksXG4gIH07XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFVQSxTQUFTLFlBQVksY0FBYyxlQUFlLGlCQUFpQjtBQUNuRSxTQUFTLE1BQU0sU0FBUyxXQUFXO0FBQ25DLFNBQVMsa0JBQWtCO0FBQzNCLFNBQVMsZUFBZTtBQTZCeEIsTUFBTSxvQkFBb0I7QUFDMUIsTUFBTSx3QkFBMkM7QUFBQSxFQUMvQztBQUFBLEVBQWM7QUFBQSxFQUFVO0FBQUEsRUFBUztBQUFBLEVBQVU7QUFBQSxFQUFRO0FBQUEsRUFBUTtBQUM3RDtBQWVPLFNBQVMsb0JBQW9CLFVBQTBCO0FBQzVELFFBQU0sV0FBVyxRQUFRLFFBQVE7QUFFakMsUUFBTSxpQkFBaUIsR0FBRyxHQUFHLE9BQU8sR0FBRyxZQUFZLEdBQUc7QUFDdEQsTUFBSSxNQUFNLFNBQVMsUUFBUSxjQUFjO0FBQ3pDLE1BQUksUUFBUSxJQUFJO0FBRWQsVUFBTSxZQUFZLElBQUk7QUFBQSxNQUNwQixLQUFLLEdBQUcsV0FBVyxHQUFHLGFBQWEsR0FBRyxjQUFjLEdBQUcsY0FBYyxHQUFHO0FBQUEsSUFDMUU7QUFDQSxVQUFNLFFBQVEsU0FBUyxNQUFNLFNBQVM7QUFDdEMsUUFBSSxTQUFTLE1BQU0sVUFBVSxPQUFXLE9BQU0sTUFBTTtBQUFBLEVBQ3REO0FBQ0EsTUFBSSxRQUFRLElBQUk7QUFFZCxVQUFNLGNBQWMsU0FBUyxNQUFNLEdBQUcsR0FBRztBQUN6QyxXQUFPLEtBQUssYUFBYSxRQUFRLGlCQUFpQjtBQUFBLEVBQ3BEO0FBQ0EsU0FBTyxLQUFLLFFBQVEsUUFBUSxHQUFHLGlCQUFpQjtBQUNsRDtBQVNPLFNBQVMsY0FBYyxVQUFrQixNQUFzQjtBQUNwRSxRQUFNLFdBQVcsb0JBQW9CLFFBQVE7QUFDN0MsUUFBTSxNQUFNLEtBQUssVUFBVSxJQUFJO0FBQy9CLE1BQUksQ0FBQyxXQUFXLEdB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
