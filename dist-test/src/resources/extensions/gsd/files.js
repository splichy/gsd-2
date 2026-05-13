import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { atomicWriteAsync } from "./atomic-write.js";
import { resolveMilestoneFile, relMilestoneFile, resolveGsdRootFile } from "./paths.js";
import { findMilestoneIds } from "./milestone-ids.js";
import { checkExistingEnvKeys } from "./env-utils.js";
import { nativeExtractSection, nativeParseSummaryFile, NATIVE_UNAVAILABLE } from "./native-parser-bridge.js";
import { CACHE_MAX } from "./constants.js";
import { splitFrontmatter, parseFrontmatterMap } from "../shared/frontmatter.js";
function cacheKey(content) {
  const len = content.length;
  const head = content.slice(0, 100);
  const midStart = Math.max(0, Math.floor(len / 2) - 50);
  const mid = len > 200 ? content.slice(midStart, midStart + 100) : "";
  const tail = len > 100 ? content.slice(-100) : "";
  return `${len}:${head}:${mid}:${tail}`;
}
const _parseCache = /* @__PURE__ */ new Map();
function cachedParse(content, tag, parseFn) {
  const key = tag + "|" + cacheKey(content);
  if (_parseCache.has(key)) return _parseCache.get(key);
  if (_parseCache.size >= CACHE_MAX) _parseCache.clear();
  const result = parseFn(content);
  _parseCache.set(key, result);
  return result;
}
const _cacheClearCallbacks = [];
function registerCacheClearCallback(cb) {
  _cacheClearCallbacks.push(cb);
}
function clearParseCache() {
  _parseCache.clear();
  for (const cb of _cacheClearCallbacks) cb();
}
const IS_MAC = process.platform === "darwin";
function formatShortcut(combo) {
  if (!IS_MAC) return combo;
  return combo.replace(/Ctrl\+Alt\+/i, "\u2303\u2325").replace(/Ctrl\+/i, "\u2303").replace(/Alt\+/i, "\u2325").replace(/Shift\+/i, "\u21E7").replace(/Cmd\+/i, "\u2318");
}
function extractSection(body, heading, level = 2) {
  const nativeResult = nativeExtractSection(body, heading, level);
  if (nativeResult !== NATIVE_UNAVAILABLE) return nativeResult;
  const prefix = "#".repeat(level) + " ";
  const regex = new RegExp(`^${prefix}${escapeRegex(heading)}\\s*$`, "m");
  const match = regex.exec(body);
  if (!match) return null;
  const start = match.index + match[0].length;
  const rest = body.slice(start);
  const nextHeading = rest.match(new RegExp(`^#{1,${level}} `, "m"));
  const end = nextHeading ? nextHeading.index : rest.length;
  return rest.slice(0, end).trim();
}
function extractAllSections(body, level = 2) {
  const prefix = "#".repeat(level) + " ";
  const regex = new RegExp(`^${prefix}(.+)$`, "gm");
  const sections = /* @__PURE__ */ new Map();
  const matches = [...body.matchAll(regex)];
  for (let i = 0; i < matches.length; i++) {
    const heading = matches[i][1].trim();
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : body.length;
    sections.set(heading, body.slice(start, end).trim());
  }
  return sections;
}
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function normalizePlannedFileReference(value) {
  const trimmed = value.trim().replace(/`/g, "");
  const match = /^(.*?)(?:\s+(?:—|-)\s+)(.+)$/.exec(trimmed);
  if (!match) return trimmed;
  const pathCandidate = match[1].trim();
  if (pathCandidate.includes("/") || pathCandidate.includes("\\") || pathCandidate.includes(".")) {
    return pathCandidate;
  }
  return trimmed;
}
function parseBullets(text) {
  return text.split("\n").map((l) => l.replace(/^\s*[-*]\s+/, "").trim()).filter((l) => l.length > 0 && !l.startsWith("#"));
}
function extractBoldField(text, key) {
  const regex = new RegExp(`^\\*\\*${escapeRegex(key)}:\\*\\*\\s*(.+)$`, "m");
  const match = regex.exec(text);
  return match ? match[1].trim() : null;
}
const VALID_STATUSES = /* @__PURE__ */ new Set(["pending", "collected", "skipped"]);
function parseSecretsManifest(content) {
  const milestone = extractBoldField(content, "Milestone") || "";
  const generatedAt = extractBoldField(content, "Generated") || "";
  const h3Sections = extractAllSections(content, 3);
  const entries = [];
  for (const [heading, sectionContent] of h3Sections) {
    const key = heading.trim();
    if (!key) continue;
    const service = extractBoldField(sectionContent, "Service") || "";
    const dashboardUrl = extractBoldField(sectionContent, "Dashboard") || "";
    const formatHint = extractBoldField(sectionContent, "Format hint") || "";
    const rawStatus = (extractBoldField(sectionContent, "Status") || "pending").toLowerCase().trim();
    const status = VALID_STATUSES.has(rawStatus) ? rawStatus : "pending";
    const destination = extractBoldField(sectionContent, "Destination") || "dotenv";
    const guidance = [];
    for (const line of sectionContent.split("\n")) {
      const numMatch = line.match(/^\s*\d+\.\s+(.+)/);
      if (numMatch) {
        guidance.push(numMatch[1].trim());
      }
    }
    entries.push({ key, service, dashboardUrl, guidance, formatHint, status, destination });
  }
  return { milestone, generatedAt, entries };
}
function formatSecretsManifest(manifest) {
  const lines = [];
  lines.push("# Secrets Manifest");
  lines.push("");
  lines.push(`**Milestone:** ${manifest.milestone}`);
  lines.push(`**Generated:** ${manifest.generatedAt}`);
  for (const entry of manifest.entries) {
    lines.push("");
    lines.push(`### ${entry.key}`);
    lines.push("");
    lines.push(`**Service:** ${entry.service}`);
    if (entry.dashboardUrl) {
      lines.push(`**Dashboard:** ${entry.dashboardUrl}`);
    }
    if (entry.formatHint) {
      lines.push(`**Format hint:** ${entry.formatHint}`);
    }
    lines.push(`**Status:** ${entry.status}`);
    lines.push(`**Destination:** ${entry.destination}`);
    lines.push("");
    for (let i = 0; i < entry.guidance.length; i++) {
      lines.push(`${i + 1}. ${entry.guidance[i]}`);
    }
  }
  return lines.join("\n") + "\n";
}
function normalizeTaskPlanFrontmatter(frontmatter) {
  const estimatedStepsRaw = frontmatter.estimated_steps;
  const estimatedFilesRaw = frontmatter.estimated_files;
  const skillsUsedRaw = frontmatter.skills_used;
  const parseOptionalNumber = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = parseInt(value, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
    return void 0;
  };
  const estimated_steps = parseOptionalNumber(estimatedStepsRaw);
  const estimated_files = parseOptionalNumber(estimatedFilesRaw);
  const skills_used = Array.isArray(skillsUsedRaw) ? skillsUsedRaw.map((v) => String(v).trim()).filter(Boolean) : typeof skillsUsedRaw === "string" && skillsUsedRaw.trim() ? [skillsUsedRaw.trim()] : [];
  return {
    ...estimated_steps !== void 0 ? { estimated_steps } : {},
    ...estimated_files !== void 0 ? { estimated_files } : {},
    skills_used
  };
}
function parseTaskPlanFile(content) {
  const [fmLines] = splitFrontmatter(content);
  const fm = fmLines ? parseFrontmatterMap(fmLines) : {};
  return {
    frontmatter: normalizeTaskPlanFrontmatter(fm)
  };
}
function parseSummary(content) {
  return cachedParse(content, "summary", _parseSummaryImpl);
}
function _parseSummaryImpl(content) {
  const nativeResult = nativeParseSummaryFile(content);
  if (nativeResult) {
    const nfm = nativeResult.frontmatter;
    return {
      frontmatter: {
        id: nfm.id,
        parent: nfm.parent,
        milestone: nfm.milestone,
        provides: nfm.provides,
        requires: nfm.requires,
        affects: nfm.affects,
        key_files: nfm.keyFiles,
        key_decisions: nfm.keyDecisions,
        patterns_established: nfm.patternsEstablished,
        drill_down_paths: nfm.drillDownPaths,
        observability_surfaces: nfm.observabilitySurfaces,
        duration: nfm.duration,
        verification_result: nfm.verificationResult,
        completed_at: nfm.completedAt,
        blocker_discovered: nfm.blockerDiscovered
      },
      title: nativeResult.title,
      oneLiner: nativeResult.oneLiner,
      whatHappened: nativeResult.whatHappened,
      deviations: nativeResult.deviations,
      filesModified: nativeResult.filesModified,
      followUps: extractSection(content, "Follow-ups") ?? "",
      knownLimitations: extractSection(content, "Known Limitations") ?? ""
    };
  }
  const [fmLines, body] = splitFrontmatter(content);
  const fm = fmLines ? parseFrontmatterMap(fmLines) : {};
  const asStringArray = (v) => Array.isArray(v) ? v : typeof v === "string" && v ? [v] : [];
  const frontmatter = {
    id: fm.id || "",
    parent: fm.parent || "",
    milestone: fm.milestone || "",
    provides: asStringArray(fm.provides),
    requires: (fm.requires || []).map((r) => ({
      slice: r.slice || "",
      provides: r.provides || ""
    })),
    affects: asStringArray(fm.affects),
    key_files: asStringArray(fm.key_files),
    key_decisions: asStringArray(fm.key_decisions),
    patterns_established: asStringArray(fm.patterns_established),
    drill_down_paths: asStringArray(fm.drill_down_paths),
    observability_surfaces: asStringArray(fm.observability_surfaces),
    duration: fm.duration || "",
    verification_result: fm.verification_result || "untested",
    completed_at: fm.completed_at || "",
    blocker_discovered: fm.blocker_discovered === "true" || fm.blocker_discovered === true
  };
  const bodyLines = body.split("\n");
  const h1 = bodyLines.find((l) => l.startsWith("# "));
  const title = h1 ? h1.slice(2).trim() : "";
  const h1Idx = bodyLines.indexOf(h1 || "");
  let oneLiner = "";
  for (let i = h1Idx + 1; i < bodyLines.length; i++) {
    const line = bodyLines[i].trim();
    if (!line) continue;
    if (line.startsWith("**") && line.endsWith("**")) {
      oneLiner = line.slice(2, -2);
    }
    break;
  }
  const whatHappened = extractSection(body, "What Happened") || "";
  const deviations = extractSection(body, "Deviations") || "";
  const filesSection = extractSection(body, "Files Created/Modified") || extractSection(body, "Files Modified");
  const filesModified = [];
  if (filesSection) {
    for (const line of filesSection.split("\n")) {
      const trimmed = line.replace(/^\s*[-*]\s+/, "").trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const fileMatch = trimmed.match(/^`([^`]+)`\s*[—–-]\s*(.+)/);
      if (fileMatch) {
        filesModified.push({ path: fileMatch[1], description: fileMatch[2].trim() });
      }
    }
  }
  const followUps = extractSection(body, "Follow-ups") ?? "";
  const knownLimitations = extractSection(body, "Known Limitations") ?? "";
  return { frontmatter, title, oneLiner, whatHappened, deviations, filesModified, followUps, knownLimitations };
}
function parseContinue(content) {
  return cachedParse(content, "continue", _parseContinueImpl);
}
function _parseContinueImpl(content) {
  const [fmLines, body] = splitFrontmatter(content);
  const fm = fmLines ? parseFrontmatterMap(fmLines) : {};
  const frontmatter = {
    milestone: fm.milestone || "",
    slice: fm.slice || "",
    task: fm.task || "",
    step: typeof fm.step === "string" ? parseInt(fm.step) : fm.step || 0,
    totalSteps: typeof fm.total_steps === "string" ? parseInt(fm.total_steps) : fm.total_steps || (typeof fm.totalSteps === "string" ? parseInt(fm.totalSteps) : fm.totalSteps || 0),
    status: fm.status || "in_progress",
    savedAt: fm.saved_at || fm.savedAt || ""
  };
  const completedWork = extractSection(body, "Completed Work") || "";
  const remainingWork = extractSection(body, "Remaining Work") || "";
  const decisions = extractSection(body, "Decisions Made") || "";
  const context = extractSection(body, "Context") || "";
  const nextAction = extractSection(body, "Next Action") || "";
  return { frontmatter, completedWork, remainingWork, decisions, context, nextAction };
}
function formatFrontmatter(data) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(data)) {
    if (value === void 0 || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else if (typeof value[0] === "object" && value[0] !== null) {
        lines.push(`${key}:`);
        for (const obj of value) {
          const entries = Object.entries(obj);
          if (entries.length > 0) {
            lines.push(`  - ${entries[0][0]}: ${entries[0][1]}`);
            for (let i = 1; i < entries.length; i++) {
              lines.push(`    ${entries[i][0]}: ${entries[i][1]}`);
            }
          }
        }
      } else {
        lines.push(`${key}:`);
        for (const item of value) {
          lines.push(`  - ${item}`);
        }
      }
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}
function formatContinue(cont) {
  const fm = cont.frontmatter;
  const fmData = {
    milestone: fm.milestone,
    slice: fm.slice,
    task: fm.task,
    step: fm.step,
    total_steps: fm.totalSteps,
    status: fm.status,
    saved_at: fm.savedAt
  };
  const lines = [];
  lines.push(formatFrontmatter(fmData));
  lines.push("");
  lines.push("## Completed Work");
  lines.push(cont.completedWork);
  lines.push("");
  lines.push("## Remaining Work");
  lines.push(cont.remainingWork);
  lines.push("");
  lines.push("## Decisions Made");
  lines.push(cont.decisions);
  lines.push("");
  lines.push("## Context");
  lines.push(cont.context);
  lines.push("");
  lines.push("## Next Action");
  lines.push(cont.nextAction);
  return lines.join("\n");
}
async function loadFile(path) {
  try {
    return await fs.readFile(path, "utf-8");
  } catch (err) {
    const code = err.code;
    if (code === "ENOENT" || code === "EISDIR") return null;
    throw err;
  }
}
async function saveFile(path, content) {
  await atomicWriteAsync(path, content);
}
function parseRequirementCounts(content) {
  const counts = {
    active: 0,
    validated: 0,
    deferred: 0,
    outOfScope: 0,
    blocked: 0,
    total: 0
  };
  if (!content) return counts;
  const sections = [
    { key: "active", heading: "Active" },
    { key: "validated", heading: "Validated" },
    { key: "deferred", heading: "Deferred" },
    { key: "outOfScope", heading: "Out of Scope" }
  ];
  for (const section of sections) {
    const text = extractSection(content, section.heading, 2);
    if (!text) continue;
    const matches = text.match(/^###\s+[A-Z][\w-]*\d+\s+—/gm);
    counts[section.key] = matches ? matches.length : 0;
  }
  const blockedMatches = content.match(/^-\s+Status:\s+blocked\s*$/gim);
  counts.blocked = blockedMatches ? blockedMatches.length : 0;
  counts.total = counts.active + counts.validated + counts.deferred + counts.outOfScope;
  return counts;
}
function parseTaskPlanMustHaves(content) {
  const [, body] = splitFrontmatter(content);
  const sectionText = extractSection(body, "Must-Haves");
  if (!sectionText) return [];
  const bullets = parseBullets(sectionText);
  if (bullets.length === 0) return [];
  return bullets.map((line) => {
    const cbMatch = line.match(/^\[([xX ])\]\s+(.+)/);
    if (cbMatch) {
      return {
        text: cbMatch[2].trim(),
        checked: cbMatch[1].toLowerCase() === "x"
      };
    }
    return { text: line.trim(), checked: false };
  });
}
const COMMON_WORDS = /* @__PURE__ */ new Set([
  "the",
  "and",
  "for",
  "are",
  "but",
  "not",
  "you",
  "all",
  "can",
  "had",
  "her",
  "was",
  "one",
  "our",
  "out",
  "has",
  "its",
  "let",
  "say",
  "she",
  "too",
  "use",
  "with",
  "have",
  "from",
  "this",
  "that",
  "they",
  "been",
  "each",
  "when",
  "will",
  "does",
  "into",
  "also",
  "than",
  "them",
  "then",
  "some",
  "what",
  "only",
  "just",
  "more",
  "make",
  "like",
  "made",
  "over",
  "such",
  "take",
  "most",
  "very",
  "must",
  "file",
  "test",
  "tests",
  "task",
  "new",
  "add",
  "added",
  "existing"
]);
function countMustHavesMentionedInSummary(mustHaves, summaryContent) {
  if (!summaryContent || mustHaves.length === 0) return 0;
  const summaryLower = summaryContent.toLowerCase();
  let count = 0;
  for (const mh of mustHaves) {
    const codeTokens = [];
    const codeRegex = /`([^`]+)`/g;
    let match;
    while ((match = codeRegex.exec(mh.text)) !== null) {
      codeTokens.push(match[1]);
    }
    if (codeTokens.length > 0) {
      const found = codeTokens.some((token) => summaryLower.includes(token.toLowerCase()));
      if (found) count++;
    } else {
      const words = mh.text.replace(/[^\w\s]/g, " ").split(/\s+/).filter(
        (w) => w.length >= 4 && !COMMON_WORDS.has(w.toLowerCase())
      );
      const found = words.some((word) => summaryLower.includes(word.toLowerCase()));
      if (found) count++;
    }
  }
  return count;
}
function parseTaskPlanIO(content) {
  const backtickPathRegex = /`([^`]+)`/g;
  function extractPaths(sectionText) {
    if (!sectionText) return [];
    const paths = [];
    for (const line of sectionText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      let match;
      backtickPathRegex.lastIndex = 0;
      while ((match = backtickPathRegex.exec(trimmed)) !== null) {
        const candidate = normalizePlannedFileReference(match[1]);
        if (candidate.includes("/") || candidate.includes("\\") || candidate.includes(".")) {
          paths.push(candidate);
        }
      }
    }
    return paths;
  }
  const [, body] = splitFrontmatter(content);
  const inputSection = extractSection(body, "Inputs");
  const outputSection = extractSection(body, "Expected Output");
  return {
    inputFiles: extractPaths(inputSection),
    outputFiles: extractPaths(outputSection)
  };
}
function extractUatType(content) {
  const sectionText = extractSection(content, "UAT Type");
  if (!sectionText) return void 0;
  const bullets = parseBullets(sectionText);
  const modeBullet = bullets.find((b) => b.startsWith("UAT mode:"));
  if (!modeBullet) return void 0;
  const rawValue = modeBullet.slice("UAT mode:".length).trim().toLowerCase();
  if (rawValue.startsWith("artifact-driven")) return "artifact-driven";
  if (rawValue.startsWith("browser-executable")) return "browser-executable";
  if (rawValue.startsWith("runtime-executable")) return "runtime-executable";
  if (rawValue.startsWith("live-runtime")) return "live-runtime";
  if (rawValue.startsWith("human-experience")) return "human-experience";
  if (rawValue.startsWith("mixed")) return "mixed";
  return void 0;
}
function parseContextDependsOn(content) {
  if (!content) return [];
  const [fmLines] = splitFrontmatter(content);
  if (!fmLines) return [];
  const fm = parseFrontmatterMap(fmLines);
  const raw = fm["depends_on"];
  if (!Array.isArray(raw) || raw.length === 0) return [];
  return raw.map((s) => String(s).trim()).filter(Boolean);
}
async function inlinePriorMilestoneSummary(mid, base) {
  const sorted = findMilestoneIds(base);
  if (sorted.length === 0) return null;
  const idx = sorted.indexOf(mid);
  if (idx <= 0) return null;
  const prevMid = sorted[idx - 1];
  const absPath = resolveMilestoneFile(base, prevMid, "SUMMARY");
  const relPath = relMilestoneFile(base, prevMid, "SUMMARY");
  const content = absPath ? await loadFile(absPath) : null;
  if (!content) return null;
  return `### Prior Milestone Summary
Source: \`${relPath}\`

${content.trim()}`;
}
async function getManifestStatus(base, milestoneId, projectRoot) {
  const resolvedPath = resolveMilestoneFile(base, milestoneId, "SECRETS");
  if (!resolvedPath) return null;
  const content = await loadFile(resolvedPath);
  if (!content) return null;
  const manifest = parseSecretsManifest(content);
  const keys = manifest.entries.map((e) => e.key);
  const existingKeys = await checkExistingEnvKeys(keys, resolve(base, ".env"));
  const existingSet = new Set(existingKeys);
  if (projectRoot && projectRoot !== base) {
    const rootKeys = await checkExistingEnvKeys(keys, resolve(projectRoot, ".env"));
    for (const k of rootKeys) existingSet.add(k);
  }
  const result = {
    pending: [],
    collected: [],
    skipped: [],
    existing: []
  };
  for (const entry of manifest.entries) {
    if (existingSet.has(entry.key)) {
      result.existing.push(entry.key);
    } else {
      result[entry.status].push(entry.key);
    }
  }
  return result;
}
async function appendOverride(basePath, change, appliedAt) {
  const overridesPath = resolveGsdRootFile(basePath, "OVERRIDES");
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  const entry = [
    `## Override: ${timestamp}`,
    "",
    `**Change:** ${change}`,
    `**Scope:** active`,
    `**Applied-at:** ${appliedAt}`,
    "",
    "---",
    ""
  ].join("\n");
  const existing = await loadFile(overridesPath);
  if (existing) {
    await saveFile(overridesPath, existing.trimEnd() + "\n\n" + entry);
  } else {
    const header = [
      "# GSD Overrides",
      "",
      "User-issued overrides that supersede plan document content.",
      "",
      "---",
      ""
    ].join("\n");
    await saveFile(overridesPath, header + entry);
  }
}
async function appendKnowledge(basePath, type, entry, scope) {
  const knowledgePath = resolveGsdRootFile(basePath, "KNOWLEDGE");
  const existing = await loadFile(knowledgePath);
  if (existing) {
    const prefix = type === "rule" ? "K" : type === "pattern" ? "P" : "L";
    const idPattern = new RegExp(`^\\| ${prefix}(\\d+)`, "gm");
    let maxId = 0;
    let match;
    while ((match = idPattern.exec(existing)) !== null) {
      const num = parseInt(match[1], 10);
      if (num > maxId) maxId = num;
    }
    const nextId = `${prefix}${String(maxId + 1).padStart(3, "0")}`;
    let row;
    if (type === "rule") {
      row = `| ${nextId} | ${scope} | ${entry} | \u2014 | manual |`;
    } else if (type === "pattern") {
      row = `| ${nextId} | ${entry} | \u2014 | ${scope} |`;
    } else {
      row = `| ${nextId} | ${entry} | \u2014 | \u2014 | ${scope} |`;
    }
    const sectionHeading = type === "rule" ? "## Rules" : type === "pattern" ? "## Patterns" : "## Lessons Learned";
    const sectionIdx = existing.indexOf(sectionHeading);
    if (sectionIdx !== -1) {
      const afterHeading = existing.indexOf("\n", sectionIdx);
      const nextSection = existing.indexOf("\n## ", afterHeading + 1);
      const insertPoint = nextSection !== -1 ? nextSection : existing.length;
      const before = existing.slice(0, insertPoint).trimEnd();
      const after = existing.slice(insertPoint);
      await saveFile(knowledgePath, before + "\n" + row + "\n" + after);
    } else {
      await saveFile(knowledgePath, existing.trimEnd() + "\n\n" + row + "\n");
    }
  } else {
    const header = [
      "# Project Knowledge",
      "",
      "Append-only register of project-specific rules, patterns, and lessons learned.",
      "Agents read this before every unit. Add entries when you discover something worth remembering.",
      ""
    ].join("\n");
    let content;
    if (type === "rule") {
      content = header + [
        "## Rules",
        "",
        "| # | Scope | Rule | Why | Added |",
        "|---|-------|------|-----|-------|",
        `| K001 | ${scope} | ${entry} | \u2014 | manual |`,
        "",
        "## Patterns",
        "",
        "| # | Pattern | Where | Notes |",
        "|---|---------|-------|-------|",
        "",
        "## Lessons Learned",
        "",
        "| # | What Happened | Root Cause | Fix | Scope |",
        "|---|--------------|------------|-----|-------|",
        ""
      ].join("\n");
    } else if (type === "pattern") {
      content = header + [
        "## Rules",
        "",
        "| # | Scope | Rule | Why | Added |",
        "|---|-------|------|-----|-------|",
        "",
        "## Patterns",
        "",
        "| # | Pattern | Where | Notes |",
        "|---|---------|-------|-------|",
        `| P001 | ${entry} | \u2014 | ${scope} |`,
        "",
        "## Lessons Learned",
        "",
        "| # | What Happened | Root Cause | Fix | Scope |",
        "|---|--------------|------------|-----|-------|",
        ""
      ].join("\n");
    } else {
      content = header + [
        "## Rules",
        "",
        "| # | Scope | Rule | Why | Added |",
        "|---|-------|------|-----|-------|",
        "",
        "## Patterns",
        "",
        "| # | Pattern | Where | Notes |",
        "|---|---------|-------|-------|",
        "",
        "## Lessons Learned",
        "",
        "| # | What Happened | Root Cause | Fix | Scope |",
        "|---|--------------|------------|-----|-------|",
        `| L001 | ${entry} | \u2014 | \u2014 | ${scope} |`,
        ""
      ].join("\n");
    }
    await saveFile(knowledgePath, content);
  }
}
async function loadActiveOverrides(basePath) {
  const overridesPath = resolveGsdRootFile(basePath, "OVERRIDES");
  const content = await loadFile(overridesPath);
  if (!content) return [];
  return parseOverrides(content).filter((o) => o.scope === "active");
}
function parseOverrides(content) {
  const overrides = [];
  const blocks = content.split(/^## Override: /m).slice(1);
  for (const block of blocks) {
    const lines = block.split("\n");
    const timestamp = lines[0]?.trim() ?? "";
    let change = "";
    let scope = "active";
    let appliedAt = "";
    for (const line of lines) {
      const changeMatch = line.match(/^\*\*Change:\*\*\s*(.+)$/);
      if (changeMatch) change = changeMatch[1].trim();
      const scopeMatch = line.match(/^\*\*Scope:\*\*\s*(.+)$/);
      if (scopeMatch) scope = scopeMatch[1].trim();
      const appliedMatch = line.match(/^\*\*Applied-at:\*\*\s*(.+)$/);
      if (appliedMatch) appliedAt = appliedMatch[1].trim();
    }
    if (change) {
      overrides.push({ timestamp, change, scope, appliedAt });
    }
  }
  return overrides;
}
function formatOverridesSection(overrides) {
  if (overrides.length === 0) return "";
  const entries = overrides.map((o, i) => [
    `${i + 1}. **${o.change}**`,
    `   _Issued: ${o.timestamp} during ${o.appliedAt}_`
  ].join("\n")).join("\n");
  return [
    "## Active Overrides (supersede plan content)",
    "",
    "The following overrides were issued by the user and supersede any conflicting content in plan documents below. Follow these overrides even if they contradict the inlined task plan.",
    "",
    entries,
    ""
  ].join("\n");
}
async function resolveAllOverrides(basePath) {
  const overridesPath = resolveGsdRootFile(basePath, "OVERRIDES");
  const content = await loadFile(overridesPath);
  if (!content) return;
  const updated = content.replace(/\*\*Scope:\*\* active/g, "**Scope:** resolved");
  await saveFile(overridesPath, updated);
}
export {
  appendKnowledge,
  appendOverride,
  clearParseCache,
  countMustHavesMentionedInSummary,
  extractAllSections,
  extractBoldField,
  extractSection,
  extractUatType,
  formatContinue,
  formatOverridesSection,
  formatSecretsManifest,
  formatShortcut,
  getManifestStatus,
  inlinePriorMilestoneSummary,
  loadActiveOverrides,
  loadFile,
  normalizePlannedFileReference,
  parseBullets,
  parseContextDependsOn,
  parseContinue,
  parseFrontmatterMap,
  parseOverrides,
  parseRequirementCounts,
  parseSecretsManifest,
  parseSummary,
  parseTaskPlanFile,
  parseTaskPlanIO,
  parseTaskPlanMustHaves,
  registerCacheClearCallback,
  resolveAllOverrides,
  saveFile,
  splitFrontmatter
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9maWxlcy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NEIEV4dGVuc2lvbiAtIEZpbGUgUGFyc2luZyBhbmQgSS9PXG4vLyBQYXJzZXJzIGZvciByb2FkbWFwLCBwbGFuLCBzdW1tYXJ5LCBhbmQgY29udGludWUgZmlsZXMuXG4vLyBVc2VkIGJ5IHN0YXRlIGRlcml2YXRpb24gYW5kIHRoZSBzdGF0dXMgd2lkZ2V0LlxuLy8gUHVyZSBmdW5jdGlvbnMsIHplcm8gUGkgZGVwZW5kZW5jaWVzIC0gdXNlcyBvbmx5IE5vZGUgYnVpbHQtaW5zLlxuXG5pbXBvcnQgeyBwcm9taXNlcyBhcyBmcyB9IGZyb20gJ25vZGU6ZnMnO1xuaW1wb3J0IHsgcmVzb2x2ZSB9IGZyb20gJ25vZGU6cGF0aCc7XG5pbXBvcnQgeyBhdG9taWNXcml0ZUFzeW5jIH0gZnJvbSAnLi9hdG9taWMtd3JpdGUuanMnO1xuaW1wb3J0IHsgcmVzb2x2ZU1pbGVzdG9uZUZpbGUsIHJlbE1pbGVzdG9uZUZpbGUsIHJlc29sdmVHc2RSb290RmlsZSB9IGZyb20gJy4vcGF0aHMuanMnO1xuaW1wb3J0IHsgbWlsZXN0b25lSWRTb3J0LCBmaW5kTWlsZXN0b25lSWRzIH0gZnJvbSAnLi9taWxlc3RvbmUtaWRzLmpzJztcblxuaW1wb3J0IHR5cGUge1xuICBUYXNrUGxhbkZpbGUsIFRhc2tQbGFuRnJvbnRtYXR0ZXIsXG4gIFN1bW1hcnksIFN1bW1hcnlGcm9udG1hdHRlciwgU3VtbWFyeVJlcXVpcmVzLCBGaWxlTW9kaWZpZWQsXG4gIENvbnRpbnVlLCBDb250aW51ZUZyb250bWF0dGVyLCBDb250aW51ZVN0YXR1cyxcbiAgUmVxdWlyZW1lbnRDb3VudHMsXG4gIFRhc2tJTyxcbiAgU2VjcmV0c01hbmlmZXN0LCBTZWNyZXRzTWFuaWZlc3RFbnRyeSwgU2VjcmV0c01hbmlmZXN0RW50cnlTdGF0dXMsXG4gIE1hbmlmZXN0U3RhdHVzLFxufSBmcm9tICcuL3R5cGVzLmpzJztcblxuaW1wb3J0IHsgY2hlY2tFeGlzdGluZ0VudktleXMgfSBmcm9tICcuL2Vudi11dGlscy5qcyc7XG5pbXBvcnQgeyBuYXRpdmVFeHRyYWN0U2VjdGlvbiwgbmF0aXZlUGFyc2VTdW1tYXJ5RmlsZSwgTkFUSVZFX1VOQVZBSUxBQkxFIH0gZnJvbSAnLi9uYXRpdmUtcGFyc2VyLWJyaWRnZS5qcyc7XG5pbXBvcnQgeyBDQUNIRV9NQVggfSBmcm9tICcuL2NvbnN0YW50cy5qcyc7XG5pbXBvcnQgeyBzcGxpdEZyb250bWF0dGVyLCBwYXJzZUZyb250bWF0dGVyTWFwIH0gZnJvbSAnLi4vc2hhcmVkL2Zyb250bWF0dGVyLmpzJztcblxuLy8gUmUtZXhwb3J0IGZvciBkb3duc3RyZWFtIGNvbnN1bWVyc1xuZXhwb3J0IHsgc3BsaXRGcm9udG1hdHRlciwgcGFyc2VGcm9udG1hdHRlck1hcCB9O1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUGFyc2UgQ2FjaGUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKiBGYXN0IGNvbXBvc2l0ZSBrZXk6IGxlbmd0aCArIGZpcnN0L21pZC9sYXN0IDEwMCBjaGFycy4gVGhlIG1pZGRsZSBzYW1wbGVcbiAqICBwcmV2ZW50cyBjb2xsaXNpb25zIHdoZW4gb25seSBhIGZldyBjaGFyYWN0ZXJzIGNoYW5nZSBpbiB0aGUgaW50ZXJpb3Igb2ZcbiAqICBhIGZpbGUgKGUuZy4sIGEgY2hlY2tib3ggWyBdIFx1MjE5MiBbeF0gdGhhdCBkb2Vzbid0IGFsdGVyIGxlbmd0aCBvciBlbmRwb2ludHMpLiAqL1xuZnVuY3Rpb24gY2FjaGVLZXkoY29udGVudDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgbGVuID0gY29udGVudC5sZW5ndGg7XG4gIGNvbnN0IGhlYWQgPSBjb250ZW50LnNsaWNlKDAsIDEwMCk7XG4gIGNvbnN0IG1pZFN0YXJ0ID0gTWF0aC5tYXgoMCwgTWF0aC5mbG9vcihsZW4gLyAyKSAtIDUwKTtcbiAgY29uc3QgbWlkID0gbGVuID4gMjAwID8gY29udGVudC5zbGljZShtaWRTdGFydCwgbWlkU3RhcnQgKyAxMDApIDogJyc7XG4gIGNvbnN0IHRhaWwgPSBsZW4gPiAxMDAgPyBjb250ZW50LnNsaWNlKC0xMDApIDogJyc7XG4gIHJldHVybiBgJHtsZW59OiR7aGVhZH06JHttaWR9OiR7dGFpbH1gO1xufVxuXG5jb25zdCBfcGFyc2VDYWNoZSA9IG5ldyBNYXA8c3RyaW5nLCB1bmtub3duPigpO1xuXG5mdW5jdGlvbiBjYWNoZWRQYXJzZTxUPihjb250ZW50OiBzdHJpbmcsIHRhZzogc3RyaW5nLCBwYXJzZUZuOiAoYzogc3RyaW5nKSA9PiBUKTogVCB7XG4gIGNvbnN0IGtleSA9IHRhZyArICd8JyArIGNhY2hlS2V5KGNvbnRlbnQpO1xuICBpZiAoX3BhcnNlQ2FjaGUuaGFzKGtleSkpIHJldHVybiBfcGFyc2VDYWNoZS5nZXQoa2V5KSBhcyBUO1xuICBpZiAoX3BhcnNlQ2FjaGUuc2l6ZSA+PSBDQUNIRV9NQVgpIF9wYXJzZUNhY2hlLmNsZWFyKCk7XG4gIGNvbnN0IHJlc3VsdCA9IHBhcnNlRm4oY29udGVudCk7XG4gIF9wYXJzZUNhY2hlLnNldChrZXksIHJlc3VsdCk7XG4gIHJldHVybiByZXN1bHQ7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBDcm9zcy1tb2R1bGUgY2FjaGUgY2xlYXIgcmVnaXN0cnkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4vLyBwYXJzZXJzLWxlZ2FjeS50cyByZWdpc3RlcnMgaXRzIGNhY2hlLWNsZWFyIGNhbGxiYWNrIGhlcmUgYXQgbW9kdWxlIGluaXRcbi8vIHRvIGF2b2lkIGNpcmN1bGFyIGltcG9ydHMuIGNsZWFyUGFyc2VDYWNoZSgpIGNhbGxzIGFsbCByZWdpc3RlcmVkIGNhbGxiYWNrcy5cbmNvbnN0IF9jYWNoZUNsZWFyQ2FsbGJhY2tzOiAoKCkgPT4gdm9pZClbXSA9IFtdO1xuXG4vKiogUmVnaXN0ZXIgYSBjYWxsYmFjayB0byBiZSBpbnZva2VkIHdoZW4gY2xlYXJQYXJzZUNhY2hlKCkgaXMgY2FsbGVkLlxuICogIFVzZWQgYnkgcGFyc2Vycy1sZWdhY3kudHMgdG8gc3luY2hyb25vdXNseSBjbGVhciBpdHMgb3duIGNhY2hlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVyQ2FjaGVDbGVhckNhbGxiYWNrKGNiOiAoKSA9PiB2b2lkKTogdm9pZCB7XG4gIF9jYWNoZUNsZWFyQ2FsbGJhY2tzLnB1c2goY2IpO1xufVxuXG4vKiogQ2xlYXIgdGhlIG1vZHVsZS1zY29wZWQgcGFyc2UgY2FjaGUuIENhbGwgd2hlbiBmaWxlcyBjaGFuZ2Ugb24gZGlzay5cbiAqICBBbHNvIGNsZWFycyBhbnkgcmVnaXN0ZXJlZCBleHRlcm5hbCBjYWNoZXMgKGUuZy4gcGFyc2Vycy1sZWdhY3kudHMpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNsZWFyUGFyc2VDYWNoZSgpOiB2b2lkIHtcbiAgX3BhcnNlQ2FjaGUuY2xlYXIoKTtcbiAgZm9yIChjb25zdCBjYiBvZiBfY2FjaGVDbGVhckNhbGxiYWNrcykgY2IoKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFBsYXRmb3JtIHNob3J0Y3V0cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuY29uc3QgSVNfTUFDID0gcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJkYXJ3aW5cIjtcblxuLyoqXG4gKiBGb3JtYXQgYSBrZXlib2FyZCBzaG9ydGN1dCBmb3IgdGhlIGN1cnJlbnQgT1MuXG4gKiBJbnB1dDogbW9kaWZpZXIga2V5IGNvbWJvIGxpa2UgXCJDdHJsK0FsdCtHXCJcbiAqIE91dHB1dDogXCJcdTIzMDNcdTIzMjVHXCIgb24gbWFjT1MsIFwiQ3RybCtBbHQrR1wiIG9uIFdpbmRvd3MvTGludXguXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXRTaG9ydGN1dChjb21ibzogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKCFJU19NQUMpIHJldHVybiBjb21ibztcbiAgcmV0dXJuIGNvbWJvXG4gICAgLnJlcGxhY2UoL0N0cmxcXCtBbHRcXCsvaSwgXCJcdTIzMDNcdTIzMjVcIilcbiAgICAucmVwbGFjZSgvQ3RybFxcKy9pLCBcIlx1MjMwM1wiKVxuICAgIC5yZXBsYWNlKC9BbHRcXCsvaSwgXCJcdTIzMjVcIilcbiAgICAucmVwbGFjZSgvU2hpZnRcXCsvaSwgXCJcdTIxRTdcIilcbiAgICAucmVwbGFjZSgvQ21kXFwrL2ksIFwiXHUyMzE4XCIpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgSGVscGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqIEV4dHJhY3QgdGhlIHRleHQgYWZ0ZXIgYSBoZWFkaW5nIGF0IGEgZ2l2ZW4gbGV2ZWwsIHVwIHRvIHRoZSBuZXh0IGhlYWRpbmcgb2Ygc2FtZSBvciBoaWdoZXIgbGV2ZWwuICovXG5leHBvcnQgZnVuY3Rpb24gZXh0cmFjdFNlY3Rpb24oYm9keTogc3RyaW5nLCBoZWFkaW5nOiBzdHJpbmcsIGxldmVsOiBudW1iZXIgPSAyKTogc3RyaW5nIHwgbnVsbCB7XG4gIC8vIFRyeSBuYXRpdmUgcGFyc2VyIGZpcnN0IGZvciBiZXR0ZXIgcGVyZm9ybWFuY2Ugb24gbGFyZ2UgZmlsZXNcbiAgY29uc3QgbmF0aXZlUmVzdWx0ID0gbmF0aXZlRXh0cmFjdFNlY3Rpb24oYm9keSwgaGVhZGluZywgbGV2ZWwpO1xuICBpZiAobmF0aXZlUmVzdWx0ICE9PSBOQVRJVkVfVU5BVkFJTEFCTEUpIHJldHVybiBuYXRpdmVSZXN1bHQgYXMgc3RyaW5nIHwgbnVsbDtcblxuICBjb25zdCBwcmVmaXggPSAnIycucmVwZWF0KGxldmVsKSArICcgJztcbiAgY29uc3QgcmVnZXggPSBuZXcgUmVnRXhwKGBeJHtwcmVmaXh9JHtlc2NhcGVSZWdleChoZWFkaW5nKX1cXFxccyokYCwgJ20nKTtcbiAgY29uc3QgbWF0Y2ggPSByZWdleC5leGVjKGJvZHkpO1xuICBpZiAoIW1hdGNoKSByZXR1cm4gbnVsbDtcblxuICBjb25zdCBzdGFydCA9IG1hdGNoLmluZGV4ICsgbWF0Y2hbMF0ubGVuZ3RoO1xuICBjb25zdCByZXN0ID0gYm9keS5zbGljZShzdGFydCk7XG5cbiAgY29uc3QgbmV4dEhlYWRpbmcgPSByZXN0Lm1hdGNoKG5ldyBSZWdFeHAoYF4jezEsJHtsZXZlbH19IGAsICdtJykpO1xuICBjb25zdCBlbmQgPSBuZXh0SGVhZGluZyA/IG5leHRIZWFkaW5nLmluZGV4ISA6IHJlc3QubGVuZ3RoO1xuXG4gIHJldHVybiByZXN0LnNsaWNlKDAsIGVuZCkudHJpbSgpO1xufVxuXG4vKiogRXh0cmFjdCBhbGwgc2VjdGlvbnMgYXQgYSBnaXZlbiBsZXZlbCwgcmV0dXJuaW5nIGhlYWRpbmcgXHUyMTkyIGNvbnRlbnQgbWFwLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGV4dHJhY3RBbGxTZWN0aW9ucyhib2R5OiBzdHJpbmcsIGxldmVsOiBudW1iZXIgPSAyKTogTWFwPHN0cmluZywgc3RyaW5nPiB7XG4gIGNvbnN0IHByZWZpeCA9ICcjJy5yZXBlYXQobGV2ZWwpICsgJyAnO1xuICBjb25zdCByZWdleCA9IG5ldyBSZWdFeHAoYF4ke3ByZWZpeH0oLispJGAsICdnbScpO1xuICBjb25zdCBzZWN0aW9ucyA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gIGNvbnN0IG1hdGNoZXMgPSBbLi4uYm9keS5tYXRjaEFsbChyZWdleCldO1xuXG4gIGZvciAobGV0IGkgPSAwOyBpIDwgbWF0Y2hlcy5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IGhlYWRpbmcgPSBtYXRjaGVzW2ldWzFdLnRyaW0oKTtcbiAgICBjb25zdCBzdGFydCA9IG1hdGNoZXNbaV0uaW5kZXghICsgbWF0Y2hlc1tpXVswXS5sZW5ndGg7XG4gICAgY29uc3QgZW5kID0gaSArIDEgPCBtYXRjaGVzLmxlbmd0aCA/IG1hdGNoZXNbaSArIDFdLmluZGV4ISA6IGJvZHkubGVuZ3RoO1xuICAgIHNlY3Rpb25zLnNldChoZWFkaW5nLCBib2R5LnNsaWNlKHN0YXJ0LCBlbmQpLnRyaW0oKSk7XG4gIH1cblxuICByZXR1cm4gc2VjdGlvbnM7XG59XG5cbmZ1bmN0aW9uIGVzY2FwZVJlZ2V4KHM6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBzLnJlcGxhY2UoL1suKis/XiR7fSgpfFtcXF1cXFxcXS9nLCAnXFxcXCQmJyk7XG59XG5cbi8qKlxuICogTm9ybWFsaXplIGEgdGFzay1wbGFuIGZpbGUgcmVmZXJlbmNlIHRoYXQgbWF5IGluY2x1ZGUgaW5saW5lIGRlc2NyaXB0aW9uIHRleHRcbiAqIGFmdGVyIHRoZSBwYXRoLCBmb3IgZXhhbXBsZTpcbiAqICAgXCJkb2NzL2ZpbGUubWQgXHUyMDE0IGV4cGxhbmF0aW9uXCJcbiAqICAgXCJkb2NzL2ZpbGUubWQgLSBleHBsYW5hdGlvblwiXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemVQbGFubmVkRmlsZVJlZmVyZW5jZSh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgdHJpbW1lZCA9IHZhbHVlLnRyaW0oKS5yZXBsYWNlKC9gL2csIFwiXCIpO1xuICBjb25zdCBtYXRjaCA9IC9eKC4qPykoPzpcXHMrKD86XHUyMDE0fC0pXFxzKykoLispJC8uZXhlYyh0cmltbWVkKTtcbiAgaWYgKCFtYXRjaCkgcmV0dXJuIHRyaW1tZWQ7XG5cbiAgY29uc3QgcGF0aENhbmRpZGF0ZSA9IG1hdGNoWzFdLnRyaW0oKTtcbiAgaWYgKHBhdGhDYW5kaWRhdGUuaW5jbHVkZXMoXCIvXCIpIHx8IHBhdGhDYW5kaWRhdGUuaW5jbHVkZXMoXCJcXFxcXCIpIHx8IHBhdGhDYW5kaWRhdGUuaW5jbHVkZXMoXCIuXCIpKSB7XG4gICAgcmV0dXJuIHBhdGhDYW5kaWRhdGU7XG4gIH1cblxuICByZXR1cm4gdHJpbW1lZDtcbn1cblxuLyoqIFBhcnNlIGJ1bGxldCBsaXN0IGl0ZW1zIGZyb20gYSB0ZXh0IGJsb2NrLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQnVsbGV0cyh0ZXh0OiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIHJldHVybiB0ZXh0LnNwbGl0KCdcXG4nKVxuICAgIC5tYXAobCA9PiBsLnJlcGxhY2UoL15cXHMqWy0qXVxccysvLCAnJykudHJpbSgpKVxuICAgIC5maWx0ZXIobCA9PiBsLmxlbmd0aCA+IDAgJiYgIWwuc3RhcnRzV2l0aCgnIycpKTtcbn1cblxuLyoqIEV4dHJhY3Qga2V5OiB2YWx1ZSBmcm9tIGJvbGQtcHJlZml4ZWQgbGluZXMgbGlrZSBcIioqS2V5OioqIFZhbHVlXCIgKi9cbmV4cG9ydCBmdW5jdGlvbiBleHRyYWN0Qm9sZEZpZWxkKHRleHQ6IHN0cmluZywga2V5OiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3QgcmVnZXggPSBuZXcgUmVnRXhwKGBeXFxcXCpcXFxcKiR7ZXNjYXBlUmVnZXgoa2V5KX06XFxcXCpcXFxcKlxcXFxzKiguKykkYCwgJ20nKTtcbiAgY29uc3QgbWF0Y2ggPSByZWdleC5leGVjKHRleHQpO1xuICByZXR1cm4gbWF0Y2ggPyBtYXRjaFsxXS50cmltKCkgOiBudWxsO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU2VjcmV0cyBNYW5pZmVzdCBQYXJzZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmNvbnN0IFZBTElEX1NUQVRVU0VTID0gbmV3IFNldDxTZWNyZXRzTWFuaWZlc3RFbnRyeVN0YXR1cz4oWydwZW5kaW5nJywgJ2NvbGxlY3RlZCcsICdza2lwcGVkJ10pO1xuXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VTZWNyZXRzTWFuaWZlc3QoY29udGVudDogc3RyaW5nKTogU2VjcmV0c01hbmlmZXN0IHtcbiAgY29uc3QgbWlsZXN0b25lID0gZXh0cmFjdEJvbGRGaWVsZChjb250ZW50LCAnTWlsZXN0b25lJykgfHwgJyc7XG4gIGNvbnN0IGdlbmVyYXRlZEF0ID0gZXh0cmFjdEJvbGRGaWVsZChjb250ZW50LCAnR2VuZXJhdGVkJykgfHwgJyc7XG5cbiAgY29uc3QgaDNTZWN0aW9ucyA9IGV4dHJhY3RBbGxTZWN0aW9ucyhjb250ZW50LCAzKTtcbiAgY29uc3QgZW50cmllczogU2VjcmV0c01hbmlmZXN0RW50cnlbXSA9IFtdO1xuXG4gIGZvciAoY29uc3QgW2hlYWRpbmcsIHNlY3Rpb25Db250ZW50XSBvZiBoM1NlY3Rpb25zKSB7XG4gICAgY29uc3Qga2V5ID0gaGVhZGluZy50cmltKCk7XG4gICAgaWYgKCFrZXkpIGNvbnRpbnVlO1xuXG4gICAgY29uc3Qgc2VydmljZSA9IGV4dHJhY3RCb2xkRmllbGQoc2VjdGlvbkNvbnRlbnQsICdTZXJ2aWNlJykgfHwgJyc7XG4gICAgY29uc3QgZGFzaGJvYXJkVXJsID0gZXh0cmFjdEJvbGRGaWVsZChzZWN0aW9uQ29udGVudCwgJ0Rhc2hib2FyZCcpIHx8ICcnO1xuICAgIGNvbnN0IGZvcm1hdEhpbnQgPSBleHRyYWN0Qm9sZEZpZWxkKHNlY3Rpb25Db250ZW50LCAnRm9ybWF0IGhpbnQnKSB8fCAnJztcbiAgICBjb25zdCByYXdTdGF0dXMgPSAoZXh0cmFjdEJvbGRGaWVsZChzZWN0aW9uQ29udGVudCwgJ1N0YXR1cycpIHx8ICdwZW5kaW5nJykudG9Mb3dlckNhc2UoKS50cmltKCkgYXMgU2VjcmV0c01hbmlmZXN0RW50cnlTdGF0dXM7XG4gICAgY29uc3Qgc3RhdHVzOiBTZWNyZXRzTWFuaWZlc3RFbnRyeVN0YXR1cyA9IFZBTElEX1NUQVRVU0VTLmhhcyhyYXdTdGF0dXMpID8gcmF3U3RhdHVzIDogJ3BlbmRpbmcnO1xuICAgIGNvbnN0IGRlc3RpbmF0aW9uID0gZXh0cmFjdEJvbGRGaWVsZChzZWN0aW9uQ29udGVudCwgJ0Rlc3RpbmF0aW9uJykgfHwgJ2RvdGVudic7XG5cbiAgICAvLyBFeHRyYWN0IG51bWJlcmVkIGd1aWRhbmNlIGxpc3QgKGxpbmVzIG1hdGNoaW5nIFwiMS4gLi4uXCIsIFwiMi4gLi4uXCIsIGV0Yy4pXG4gICAgY29uc3QgZ3VpZGFuY2U6IHN0cmluZ1tdID0gW107XG4gICAgZm9yIChjb25zdCBsaW5lIG9mIHNlY3Rpb25Db250ZW50LnNwbGl0KCdcXG4nKSkge1xuICAgICAgY29uc3QgbnVtTWF0Y2ggPSBsaW5lLm1hdGNoKC9eXFxzKlxcZCtcXC5cXHMrKC4rKS8pO1xuICAgICAgaWYgKG51bU1hdGNoKSB7XG4gICAgICAgIGd1aWRhbmNlLnB1c2gobnVtTWF0Y2hbMV0udHJpbSgpKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBlbnRyaWVzLnB1c2goeyBrZXksIHNlcnZpY2UsIGRhc2hib2FyZFVybCwgZ3VpZGFuY2UsIGZvcm1hdEhpbnQsIHN0YXR1cywgZGVzdGluYXRpb24gfSk7XG4gIH1cblxuICByZXR1cm4geyBtaWxlc3RvbmUsIGdlbmVyYXRlZEF0LCBlbnRyaWVzIH07XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTZWNyZXRzIE1hbmlmZXN0IEZvcm1hdHRlciBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdFNlY3JldHNNYW5pZmVzdChtYW5pZmVzdDogU2VjcmV0c01hbmlmZXN0KTogc3RyaW5nIHtcbiAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG5cbiAgbGluZXMucHVzaCgnIyBTZWNyZXRzIE1hbmlmZXN0Jyk7XG4gIGxpbmVzLnB1c2goJycpO1xuICBsaW5lcy5wdXNoKGAqKk1pbGVzdG9uZToqKiAke21hbmlmZXN0Lm1pbGVzdG9uZX1gKTtcbiAgbGluZXMucHVzaChgKipHZW5lcmF0ZWQ6KiogJHttYW5pZmVzdC5nZW5lcmF0ZWRBdH1gKTtcblxuICBmb3IgKGNvbnN0IGVudHJ5IG9mIG1hbmlmZXN0LmVudHJpZXMpIHtcbiAgICBsaW5lcy5wdXNoKCcnKTtcbiAgICBsaW5lcy5wdXNoKGAjIyMgJHtlbnRyeS5rZXl9YCk7XG4gICAgbGluZXMucHVzaCgnJyk7XG4gICAgbGluZXMucHVzaChgKipTZXJ2aWNlOioqICR7ZW50cnkuc2VydmljZX1gKTtcbiAgICBpZiAoZW50cnkuZGFzaGJvYXJkVXJsKSB7XG4gICAgICBsaW5lcy5wdXNoKGAqKkRhc2hib2FyZDoqKiAke2VudHJ5LmRhc2hib2FyZFVybH1gKTtcbiAgICB9XG4gICAgaWYgKGVudHJ5LmZvcm1hdEhpbnQpIHtcbiAgICAgIGxpbmVzLnB1c2goYCoqRm9ybWF0IGhpbnQ6KiogJHtlbnRyeS5mb3JtYXRIaW50fWApO1xuICAgIH1cbiAgICBsaW5lcy5wdXNoKGAqKlN0YXR1czoqKiAke2VudHJ5LnN0YXR1c31gKTtcbiAgICBsaW5lcy5wdXNoKGAqKkRlc3RpbmF0aW9uOioqICR7ZW50cnkuZGVzdGluYXRpb259YCk7XG4gICAgbGluZXMucHVzaCgnJyk7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBlbnRyeS5ndWlkYW5jZS5sZW5ndGg7IGkrKykge1xuICAgICAgbGluZXMucHVzaChgJHtpICsgMX0uICR7ZW50cnkuZ3VpZGFuY2VbaV19YCk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGxpbmVzLmpvaW4oJ1xcbicpICsgJ1xcbic7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTbGljZSBQbGFuIFBhcnNlciBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gbm9ybWFsaXplVGFza1BsYW5Gcm9udG1hdHRlcihmcm9udG1hdHRlcjogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBUYXNrUGxhbkZyb250bWF0dGVyIHtcbiAgY29uc3QgZXN0aW1hdGVkU3RlcHNSYXcgPSBmcm9udG1hdHRlci5lc3RpbWF0ZWRfc3RlcHM7XG4gIGNvbnN0IGVzdGltYXRlZEZpbGVzUmF3ID0gZnJvbnRtYXR0ZXIuZXN0aW1hdGVkX2ZpbGVzO1xuICBjb25zdCBza2lsbHNVc2VkUmF3ID0gZnJvbnRtYXR0ZXIuc2tpbGxzX3VzZWQ7XG5cbiAgY29uc3QgcGFyc2VPcHRpb25hbE51bWJlciA9ICh2YWx1ZTogdW5rbm93bik6IG51bWJlciB8IHVuZGVmaW5lZCA9PiB7XG4gICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKHZhbHVlKSkgcmV0dXJuIHZhbHVlO1xuICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnICYmIHZhbHVlLnRyaW0oKSkge1xuICAgICAgY29uc3QgcGFyc2VkID0gcGFyc2VJbnQodmFsdWUsIDEwKTtcbiAgICAgIGlmIChOdW1iZXIuaXNGaW5pdGUocGFyc2VkKSkgcmV0dXJuIHBhcnNlZDtcbiAgICB9XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfTtcblxuICBjb25zdCBlc3RpbWF0ZWRfc3RlcHMgPSBwYXJzZU9wdGlvbmFsTnVtYmVyKGVzdGltYXRlZFN0ZXBzUmF3KTtcbiAgY29uc3QgZXN0aW1hdGVkX2ZpbGVzID0gcGFyc2VPcHRpb25hbE51bWJlcihlc3RpbWF0ZWRGaWxlc1Jhdyk7XG4gIGNvbnN0IHNraWxsc191c2VkID0gQXJyYXkuaXNBcnJheShza2lsbHNVc2VkUmF3KVxuICAgID8gc2tpbGxzVXNlZFJhdy5tYXAodiA9PiBTdHJpbmcodikudHJpbSgpKS5maWx0ZXIoQm9vbGVhbilcbiAgICA6IHR5cGVvZiBza2lsbHNVc2VkUmF3ID09PSAnc3RyaW5nJyAmJiBza2lsbHNVc2VkUmF3LnRyaW0oKVxuICAgICAgPyBbc2tpbGxzVXNlZFJhdy50cmltKCldXG4gICAgICA6IFtdO1xuXG4gIHJldHVybiB7XG4gICAgLi4uKGVzdGltYXRlZF9zdGVwcyAhPT0gdW5kZWZpbmVkID8geyBlc3RpbWF0ZWRfc3RlcHMgfSA6IHt9KSxcbiAgICAuLi4oZXN0aW1hdGVkX2ZpbGVzICE9PSB1bmRlZmluZWQgPyB7IGVzdGltYXRlZF9maWxlcyB9IDoge30pLFxuICAgIHNraWxsc191c2VkLFxuICB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VUYXNrUGxhbkZpbGUoY29udGVudDogc3RyaW5nKTogVGFza1BsYW5GaWxlIHtcbiAgY29uc3QgW2ZtTGluZXNdID0gc3BsaXRGcm9udG1hdHRlcihjb250ZW50KTtcbiAgY29uc3QgZm0gPSBmbUxpbmVzID8gcGFyc2VGcm9udG1hdHRlck1hcChmbUxpbmVzKSA6IHt9O1xuICByZXR1cm4ge1xuICAgIGZyb250bWF0dGVyOiBub3JtYWxpemVUYXNrUGxhbkZyb250bWF0dGVyKGZtKSxcbiAgfTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFN1bW1hcnkgUGFyc2VyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VTdW1tYXJ5KGNvbnRlbnQ6IHN0cmluZyk6IFN1bW1hcnkge1xuICByZXR1cm4gY2FjaGVkUGFyc2UoY29udGVudCwgJ3N1bW1hcnknLCBfcGFyc2VTdW1tYXJ5SW1wbCk7XG59XG5cbmZ1bmN0aW9uIF9wYXJzZVN1bW1hcnlJbXBsKGNvbnRlbnQ6IHN0cmluZyk6IFN1bW1hcnkge1xuICAvLyBUcnkgbmF0aXZlIHBhcnNlciBmaXJzdCBmb3IgYmV0dGVyIHBlcmZvcm1hbmNlXG4gIGNvbnN0IG5hdGl2ZVJlc3VsdCA9IG5hdGl2ZVBhcnNlU3VtbWFyeUZpbGUoY29udGVudCk7XG4gIGlmIChuYXRpdmVSZXN1bHQpIHtcbiAgICBjb25zdCBuZm0gPSBuYXRpdmVSZXN1bHQuZnJvbnRtYXR0ZXI7XG4gICAgcmV0dXJuIHtcbiAgICAgIGZyb250bWF0dGVyOiB7XG4gICAgICAgIGlkOiBuZm0uaWQsXG4gICAgICAgIHBhcmVudDogbmZtLnBhcmVudCxcbiAgICAgICAgbWlsZXN0b25lOiBuZm0ubWlsZXN0b25lLFxuICAgICAgICBwcm92aWRlczogbmZtLnByb3ZpZGVzLFxuICAgICAgICByZXF1aXJlczogbmZtLnJlcXVpcmVzLFxuICAgICAgICBhZmZlY3RzOiBuZm0uYWZmZWN0cyxcbiAgICAgICAga2V5X2ZpbGVzOiBuZm0ua2V5RmlsZXMsXG4gICAgICAgIGtleV9kZWNpc2lvbnM6IG5mbS5rZXlEZWNpc2lvbnMsXG4gICAgICAgIHBhdHRlcm5zX2VzdGFibGlzaGVkOiBuZm0ucGF0dGVybnNFc3RhYmxpc2hlZCxcbiAgICAgICAgZHJpbGxfZG93bl9wYXRoczogbmZtLmRyaWxsRG93blBhdGhzLFxuICAgICAgICBvYnNlcnZhYmlsaXR5X3N1cmZhY2VzOiBuZm0ub2JzZXJ2YWJpbGl0eVN1cmZhY2VzLFxuICAgICAgICBkdXJhdGlvbjogbmZtLmR1cmF0aW9uLFxuICAgICAgICB2ZXJpZmljYXRpb25fcmVzdWx0OiBuZm0udmVyaWZpY2F0aW9uUmVzdWx0LFxuICAgICAgICBjb21wbGV0ZWRfYXQ6IG5mbS5jb21wbGV0ZWRBdCxcbiAgICAgICAgYmxvY2tlcl9kaXNjb3ZlcmVkOiBuZm0uYmxvY2tlckRpc2NvdmVyZWQsXG4gICAgICB9LFxuICAgICAgdGl0bGU6IG5hdGl2ZVJlc3VsdC50aXRsZSxcbiAgICAgIG9uZUxpbmVyOiBuYXRpdmVSZXN1bHQub25lTGluZXIsXG4gICAgICB3aGF0SGFwcGVuZWQ6IG5hdGl2ZVJlc3VsdC53aGF0SGFwcGVuZWQsXG4gICAgICBkZXZpYXRpb25zOiBuYXRpdmVSZXN1bHQuZGV2aWF0aW9ucyxcbiAgICAgIGZpbGVzTW9kaWZpZWQ6IG5hdGl2ZVJlc3VsdC5maWxlc01vZGlmaWVkLFxuICAgICAgZm9sbG93VXBzOiBleHRyYWN0U2VjdGlvbihjb250ZW50LCAnRm9sbG93LXVwcycpID8/ICcnLFxuICAgICAga25vd25MaW1pdGF0aW9uczogZXh0cmFjdFNlY3Rpb24oY29udGVudCwgJ0tub3duIExpbWl0YXRpb25zJykgPz8gJycsXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IFtmbUxpbmVzLCBib2R5XSA9IHNwbGl0RnJvbnRtYXR0ZXIoY29udGVudCk7XG5cbiAgY29uc3QgZm0gPSBmbUxpbmVzID8gcGFyc2VGcm9udG1hdHRlck1hcChmbUxpbmVzKSA6IHt9O1xuICBjb25zdCBhc1N0cmluZ0FycmF5ID0gKHY6IHVua25vd24pOiBzdHJpbmdbXSA9PlxuICAgIEFycmF5LmlzQXJyYXkodikgPyB2IDogKHR5cGVvZiB2ID09PSAnc3RyaW5nJyAmJiB2ID8gW3ZdIDogW10pO1xuICBjb25zdCBmcm9udG1hdHRlcjogU3VtbWFyeUZyb250bWF0dGVyID0ge1xuICAgIGlkOiAoZm0uaWQgYXMgc3RyaW5nKSB8fCAnJyxcbiAgICBwYXJlbnQ6IChmbS5wYXJlbnQgYXMgc3RyaW5nKSB8fCAnJyxcbiAgICBtaWxlc3RvbmU6IChmbS5taWxlc3RvbmUgYXMgc3RyaW5nKSB8fCAnJyxcbiAgICBwcm92aWRlczogYXNTdHJpbmdBcnJheShmbS5wcm92aWRlcyksXG4gICAgcmVxdWlyZXM6ICgoZm0ucmVxdWlyZXMgYXMgQXJyYXk8UmVjb3JkPHN0cmluZywgc3RyaW5nPj4pIHx8IFtdKS5tYXAociA9PiAoe1xuICAgICAgc2xpY2U6IHIuc2xpY2UgfHwgJycsXG4gICAgICBwcm92aWRlczogci5wcm92aWRlcyB8fCAnJyxcbiAgICB9KSksXG4gICAgYWZmZWN0czogYXNTdHJpbmdBcnJheShmbS5hZmZlY3RzKSxcbiAgICBrZXlfZmlsZXM6IGFzU3RyaW5nQXJyYXkoZm0ua2V5X2ZpbGVzKSxcbiAgICBrZXlfZGVjaXNpb25zOiBhc1N0cmluZ0FycmF5KGZtLmtleV9kZWNpc2lvbnMpLFxuICAgIHBhdHRlcm5zX2VzdGFibGlzaGVkOiBhc1N0cmluZ0FycmF5KGZtLnBhdHRlcm5zX2VzdGFibGlzaGVkKSxcbiAgICBkcmlsbF9kb3duX3BhdGhzOiBhc1N0cmluZ0FycmF5KGZtLmRyaWxsX2Rvd25fcGF0aHMpLFxuICAgIG9ic2VydmFiaWxpdHlfc3VyZmFjZXM6IGFzU3RyaW5nQXJyYXkoZm0ub2JzZXJ2YWJpbGl0eV9zdXJmYWNlcyksXG4gICAgZHVyYXRpb246IChmbS5kdXJhdGlvbiBhcyBzdHJpbmcpIHx8ICcnLFxuICAgIHZlcmlmaWNhdGlvbl9yZXN1bHQ6IChmbS52ZXJpZmljYXRpb25fcmVzdWx0IGFzIHN0cmluZykgfHwgJ3VudGVzdGVkJyxcbiAgICBjb21wbGV0ZWRfYXQ6IChmbS5jb21wbGV0ZWRfYXQgYXMgc3RyaW5nKSB8fCAnJyxcbiAgICBibG9ja2VyX2Rpc2NvdmVyZWQ6IGZtLmJsb2NrZXJfZGlzY292ZXJlZCA9PT0gJ3RydWUnIHx8IGZtLmJsb2NrZXJfZGlzY292ZXJlZCA9PT0gdHJ1ZSxcbiAgfTtcblxuICBjb25zdCBib2R5TGluZXMgPSBib2R5LnNwbGl0KCdcXG4nKTtcbiAgY29uc3QgaDEgPSBib2R5TGluZXMuZmluZChsID0+IGwuc3RhcnRzV2l0aCgnIyAnKSk7XG4gIGNvbnN0IHRpdGxlID0gaDEgPyBoMS5zbGljZSgyKS50cmltKCkgOiAnJztcblxuICBjb25zdCBoMUlkeCA9IGJvZHlMaW5lcy5pbmRleE9mKGgxIHx8ICcnKTtcbiAgbGV0IG9uZUxpbmVyID0gJyc7XG4gIGZvciAobGV0IGkgPSBoMUlkeCArIDE7IGkgPCBib2R5TGluZXMubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBsaW5lID0gYm9keUxpbmVzW2ldLnRyaW0oKTtcbiAgICBpZiAoIWxpbmUpIGNvbnRpbnVlO1xuICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoJyoqJykgJiYgbGluZS5lbmRzV2l0aCgnKionKSkge1xuICAgICAgb25lTGluZXIgPSBsaW5lLnNsaWNlKDIsIC0yKTtcbiAgICB9XG4gICAgYnJlYWs7XG4gIH1cblxuICBjb25zdCB3aGF0SGFwcGVuZWQgPSBleHRyYWN0U2VjdGlvbihib2R5LCAnV2hhdCBIYXBwZW5lZCcpIHx8ICcnO1xuICBjb25zdCBkZXZpYXRpb25zID0gZXh0cmFjdFNlY3Rpb24oYm9keSwgJ0RldmlhdGlvbnMnKSB8fCAnJztcblxuICBjb25zdCBmaWxlc1NlY3Rpb24gPSBleHRyYWN0U2VjdGlvbihib2R5LCAnRmlsZXMgQ3JlYXRlZC9Nb2RpZmllZCcpIHx8IGV4dHJhY3RTZWN0aW9uKGJvZHksICdGaWxlcyBNb2RpZmllZCcpO1xuICBjb25zdCBmaWxlc01vZGlmaWVkOiBGaWxlTW9kaWZpZWRbXSA9IFtdO1xuICBpZiAoZmlsZXNTZWN0aW9uKSB7XG4gICAgZm9yIChjb25zdCBsaW5lIG9mIGZpbGVzU2VjdGlvbi5zcGxpdCgnXFxuJykpIHtcbiAgICAgIGNvbnN0IHRyaW1tZWQgPSBsaW5lLnJlcGxhY2UoL15cXHMqWy0qXVxccysvLCAnJykudHJpbSgpO1xuICAgICAgaWYgKCF0cmltbWVkIHx8IHRyaW1tZWQuc3RhcnRzV2l0aCgnIycpKSBjb250aW51ZTtcblxuICAgICAgY29uc3QgZmlsZU1hdGNoID0gdHJpbW1lZC5tYXRjaCgvXmAoW15gXSspYFxccypbXHUyMDE0XHUyMDEzLV1cXHMqKC4rKS8pO1xuICAgICAgaWYgKGZpbGVNYXRjaCkge1xuICAgICAgICBmaWxlc01vZGlmaWVkLnB1c2goeyBwYXRoOiBmaWxlTWF0Y2hbMV0sIGRlc2NyaXB0aW9uOiBmaWxlTWF0Y2hbMl0udHJpbSgpIH0pO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGNvbnN0IGZvbGxvd1VwcyA9IGV4dHJhY3RTZWN0aW9uKGJvZHksICdGb2xsb3ctdXBzJykgPz8gJyc7XG4gIGNvbnN0IGtub3duTGltaXRhdGlvbnMgPSBleHRyYWN0U2VjdGlvbihib2R5LCAnS25vd24gTGltaXRhdGlvbnMnKSA/PyAnJztcblxuICByZXR1cm4geyBmcm9udG1hdHRlciwgdGl0bGUsIG9uZUxpbmVyLCB3aGF0SGFwcGVuZWQsIGRldmlhdGlvbnMsIGZpbGVzTW9kaWZpZWQsIGZvbGxvd1Vwcywga25vd25MaW1pdGF0aW9ucyB9O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQ29udGludWUgUGFyc2VyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VDb250aW51ZShjb250ZW50OiBzdHJpbmcpOiBDb250aW51ZSB7XG4gIHJldHVybiBjYWNoZWRQYXJzZShjb250ZW50LCAnY29udGludWUnLCBfcGFyc2VDb250aW51ZUltcGwpO1xufVxuXG5mdW5jdGlvbiBfcGFyc2VDb250aW51ZUltcGwoY29udGVudDogc3RyaW5nKTogQ29udGludWUge1xuICBjb25zdCBbZm1MaW5lcywgYm9keV0gPSBzcGxpdEZyb250bWF0dGVyKGNvbnRlbnQpO1xuXG4gIGNvbnN0IGZtID0gZm1MaW5lcyA/IHBhcnNlRnJvbnRtYXR0ZXJNYXAoZm1MaW5lcykgOiB7fTtcbiAgY29uc3QgZnJvbnRtYXR0ZXI6IENvbnRpbnVlRnJvbnRtYXR0ZXIgPSB7XG4gICAgbWlsZXN0b25lOiAoZm0ubWlsZXN0b25lIGFzIHN0cmluZykgfHwgJycsXG4gICAgc2xpY2U6IChmbS5zbGljZSBhcyBzdHJpbmcpIHx8ICcnLFxuICAgIHRhc2s6IChmbS50YXNrIGFzIHN0cmluZykgfHwgJycsXG4gICAgc3RlcDogdHlwZW9mIGZtLnN0ZXAgPT09ICdzdHJpbmcnID8gcGFyc2VJbnQoZm0uc3RlcCkgOiAoZm0uc3RlcCBhcyBudW1iZXIpIHx8IDAsXG4gICAgdG90YWxTdGVwczogdHlwZW9mIGZtLnRvdGFsX3N0ZXBzID09PSAnc3RyaW5nJyA/IHBhcnNlSW50KGZtLnRvdGFsX3N0ZXBzKSA6IChmbS50b3RhbF9zdGVwcyBhcyBudW1iZXIpIHx8XG4gICAgICAodHlwZW9mIGZtLnRvdGFsU3RlcHMgPT09ICdzdHJpbmcnID8gcGFyc2VJbnQoZm0udG90YWxTdGVwcykgOiAoZm0udG90YWxTdGVwcyBhcyBudW1iZXIpIHx8IDApLFxuICAgIHN0YXR1czogKChmbS5zdGF0dXMgYXMgc3RyaW5nKSB8fCAnaW5fcHJvZ3Jlc3MnKSBhcyBDb250aW51ZVN0YXR1cyxcbiAgICBzYXZlZEF0OiAoZm0uc2F2ZWRfYXQgYXMgc3RyaW5nKSB8fCAoZm0uc2F2ZWRBdCBhcyBzdHJpbmcpIHx8ICcnLFxuICB9O1xuXG4gIGNvbnN0IGNvbXBsZXRlZFdvcmsgPSBleHRyYWN0U2VjdGlvbihib2R5LCAnQ29tcGxldGVkIFdvcmsnKSB8fCAnJztcbiAgY29uc3QgcmVtYWluaW5nV29yayA9IGV4dHJhY3RTZWN0aW9uKGJvZHksICdSZW1haW5pbmcgV29yaycpIHx8ICcnO1xuICBjb25zdCBkZWNpc2lvbnMgPSBleHRyYWN0U2VjdGlvbihib2R5LCAnRGVjaXNpb25zIE1hZGUnKSB8fCAnJztcbiAgY29uc3QgY29udGV4dCA9IGV4dHJhY3RTZWN0aW9uKGJvZHksICdDb250ZXh0JykgfHwgJyc7XG4gIGNvbnN0IG5leHRBY3Rpb24gPSBleHRyYWN0U2VjdGlvbihib2R5LCAnTmV4dCBBY3Rpb24nKSB8fCAnJztcblxuICByZXR1cm4geyBmcm9udG1hdHRlciwgY29tcGxldGVkV29yaywgcmVtYWluaW5nV29yaywgZGVjaXNpb25zLCBjb250ZXh0LCBuZXh0QWN0aW9uIH07XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBDb250aW51ZSBGb3JtYXR0ZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIGZvcm1hdEZyb250bWF0dGVyKGRhdGE6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogc3RyaW5nIHtcbiAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gWyctLS0nXTtcblxuICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhkYXRhKSkge1xuICAgIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkIHx8IHZhbHVlID09PSBudWxsKSBjb250aW51ZTtcblxuICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgaWYgKHZhbHVlLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICBsaW5lcy5wdXNoKGAke2tleX06IFtdYCk7XG4gICAgICB9IGVsc2UgaWYgKHR5cGVvZiB2YWx1ZVswXSA9PT0gJ29iamVjdCcgJiYgdmFsdWVbMF0gIT09IG51bGwpIHtcbiAgICAgICAgbGluZXMucHVzaChgJHtrZXl9OmApO1xuICAgICAgICBmb3IgKGNvbnN0IG9iaiBvZiB2YWx1ZSkge1xuICAgICAgICAgIGNvbnN0IGVudHJpZXMgPSBPYmplY3QuZW50cmllcyhvYmogYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pO1xuICAgICAgICAgIGlmIChlbnRyaWVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIGxpbmVzLnB1c2goYCAgLSAke2VudHJpZXNbMF1bMF19OiAke2VudHJpZXNbMF1bMV19YCk7XG4gICAgICAgICAgICBmb3IgKGxldCBpID0gMTsgaSA8IGVudHJpZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICAgICAgbGluZXMucHVzaChgICAgICR7ZW50cmllc1tpXVswXX06ICR7ZW50cmllc1tpXVsxXX1gKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGxpbmVzLnB1c2goYCR7a2V5fTpgKTtcbiAgICAgICAgZm9yIChjb25zdCBpdGVtIG9mIHZhbHVlKSB7XG4gICAgICAgICAgbGluZXMucHVzaChgICAtICR7aXRlbX1gKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBsaW5lcy5wdXNoKGAke2tleX06ICR7dmFsdWV9YCk7XG4gICAgfVxuICB9XG5cbiAgbGluZXMucHVzaCgnLS0tJyk7XG4gIHJldHVybiBsaW5lcy5qb2luKCdcXG4nKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdENvbnRpbnVlKGNvbnQ6IENvbnRpbnVlKTogc3RyaW5nIHtcbiAgY29uc3QgZm0gPSBjb250LmZyb250bWF0dGVyO1xuICBjb25zdCBmbURhdGE6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgIG1pbGVzdG9uZTogZm0ubWlsZXN0b25lLFxuICAgIHNsaWNlOiBmbS5zbGljZSxcbiAgICB0YXNrOiBmbS50YXNrLFxuICAgIHN0ZXA6IGZtLnN0ZXAsXG4gICAgdG90YWxfc3RlcHM6IGZtLnRvdGFsU3RlcHMsXG4gICAgc3RhdHVzOiBmbS5zdGF0dXMsXG4gICAgc2F2ZWRfYXQ6IGZtLnNhdmVkQXQsXG4gIH07XG5cbiAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG4gIGxpbmVzLnB1c2goZm9ybWF0RnJvbnRtYXR0ZXIoZm1EYXRhKSk7XG4gIGxpbmVzLnB1c2goJycpO1xuICBsaW5lcy5wdXNoKCcjIyBDb21wbGV0ZWQgV29yaycpO1xuICBsaW5lcy5wdXNoKGNvbnQuY29tcGxldGVkV29yayk7XG4gIGxpbmVzLnB1c2goJycpO1xuICBsaW5lcy5wdXNoKCcjIyBSZW1haW5pbmcgV29yaycpO1xuICBsaW5lcy5wdXNoKGNvbnQucmVtYWluaW5nV29yayk7XG4gIGxpbmVzLnB1c2goJycpO1xuICBsaW5lcy5wdXNoKCcjIyBEZWNpc2lvbnMgTWFkZScpO1xuICBsaW5lcy5wdXNoKGNvbnQuZGVjaXNpb25zKTtcbiAgbGluZXMucHVzaCgnJyk7XG4gIGxpbmVzLnB1c2goJyMjIENvbnRleHQnKTtcbiAgbGluZXMucHVzaChjb250LmNvbnRleHQpO1xuICBsaW5lcy5wdXNoKCcnKTtcbiAgbGluZXMucHVzaCgnIyMgTmV4dCBBY3Rpb24nKTtcbiAgbGluZXMucHVzaChjb250Lm5leHRBY3Rpb24pO1xuXG4gIHJldHVybiBsaW5lcy5qb2luKCdcXG4nKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEZpbGUgSS9PIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIExvYWQgYSBmaWxlIGZyb20gZGlzay4gUmV0dXJucyBjb250ZW50IHN0cmluZyBvciBudWxsIGlmIGZpbGUgZG9lc24ndCBleGlzdC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGxvYWRGaWxlKHBhdGg6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICB0cnkge1xuICAgIHJldHVybiBhd2FpdCBmcy5yZWFkRmlsZShwYXRoLCAndXRmLTgnKTtcbiAgfSBjYXRjaCAoZXJyOiB1bmtub3duKSB7XG4gICAgY29uc3QgY29kZSA9IChlcnIgYXMgTm9kZUpTLkVycm5vRXhjZXB0aW9uKS5jb2RlO1xuICAgIGlmIChjb2RlID09PSAnRU5PRU5UJyB8fCBjb2RlID09PSAnRUlTRElSJykgcmV0dXJuIG51bGw7XG4gICAgdGhyb3cgZXJyO1xuICB9XG59XG5cbi8qKlxuICogU2F2ZSBjb250ZW50IHRvIGEgZmlsZSBhdG9taWNhbGx5ICh3cml0ZSB0byB0ZW1wLCB0aGVuIHJlbmFtZSkuXG4gKiBDcmVhdGVzIHBhcmVudCBkaXJlY3RvcmllcyBpZiBuZWVkZWQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzYXZlRmlsZShwYXRoOiBzdHJpbmcsIGNvbnRlbnQ6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBhd2FpdCBhdG9taWNXcml0ZUFzeW5jKHBhdGgsIGNvbnRlbnQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VSZXF1aXJlbWVudENvdW50cyhjb250ZW50OiBzdHJpbmcgfCBudWxsKTogUmVxdWlyZW1lbnRDb3VudHMge1xuICBjb25zdCBjb3VudHM6IFJlcXVpcmVtZW50Q291bnRzID0ge1xuICAgIGFjdGl2ZTogMCxcbiAgICB2YWxpZGF0ZWQ6IDAsXG4gICAgZGVmZXJyZWQ6IDAsXG4gICAgb3V0T2ZTY29wZTogMCxcbiAgICBibG9ja2VkOiAwLFxuICAgIHRvdGFsOiAwLFxuICB9O1xuXG4gIGlmICghY29udGVudCkgcmV0dXJuIGNvdW50cztcblxuICBjb25zdCBzZWN0aW9ucyA9IFtcbiAgICB7IGtleTogJ2FjdGl2ZScsIGhlYWRpbmc6ICdBY3RpdmUnIH0sXG4gICAgeyBrZXk6ICd2YWxpZGF0ZWQnLCBoZWFkaW5nOiAnVmFsaWRhdGVkJyB9LFxuICAgIHsga2V5OiAnZGVmZXJyZWQnLCBoZWFkaW5nOiAnRGVmZXJyZWQnIH0sXG4gICAgeyBrZXk6ICdvdXRPZlNjb3BlJywgaGVhZGluZzogJ091dCBvZiBTY29wZScgfSxcbiAgXSBhcyBjb25zdDtcblxuICBmb3IgKGNvbnN0IHNlY3Rpb24gb2Ygc2VjdGlvbnMpIHtcbiAgICBjb25zdCB0ZXh0ID0gZXh0cmFjdFNlY3Rpb24oY29udGVudCwgc2VjdGlvbi5oZWFkaW5nLCAyKTtcbiAgICBpZiAoIXRleHQpIGNvbnRpbnVlO1xuICAgIGNvbnN0IG1hdGNoZXMgPSB0ZXh0Lm1hdGNoKC9eIyMjXFxzK1tBLVpdW1xcdy1dKlxcZCtcXHMrXHUyMDE0L2dtKTtcbiAgICBjb3VudHNbc2VjdGlvbi5rZXldID0gbWF0Y2hlcyA/IG1hdGNoZXMubGVuZ3RoIDogMDtcbiAgfVxuXG4gIGNvbnN0IGJsb2NrZWRNYXRjaGVzID0gY29udGVudC5tYXRjaCgvXi1cXHMrU3RhdHVzOlxccytibG9ja2VkXFxzKiQvZ2ltKTtcbiAgY291bnRzLmJsb2NrZWQgPSBibG9ja2VkTWF0Y2hlcyA/IGJsb2NrZWRNYXRjaGVzLmxlbmd0aCA6IDA7XG4gIGNvdW50cy50b3RhbCA9IGNvdW50cy5hY3RpdmUgKyBjb3VudHMudmFsaWRhdGVkICsgY291bnRzLmRlZmVycmVkICsgY291bnRzLm91dE9mU2NvcGU7XG4gIHJldHVybiBjb3VudHM7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUYXNrIFBsYW4gTXVzdC1IYXZlcyBQYXJzZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogUGFyc2UgbXVzdC1oYXZlIGl0ZW1zIGZyb20gYSB0YXNrIHBsYW4ncyBgIyMgTXVzdC1IYXZlc2Agc2VjdGlvbi5cbiAqIFJldHVybnMgc3RydWN0dXJlZCBpdGVtcyB3aXRoIGNoZWNrYm94IHN0YXRlLiBIYW5kbGVzIFlBTUwgZnJvbnRtYXR0ZXIsXG4gKiBhbGwgY29tbW9uIGNoZWNrYm94IHZhcmlhbnRzIChgWyBdYCwgYFt4XWAsIGBbWF1gKSwgcGxhaW4gYnVsbGV0cyAobm8gY2hlY2tib3gpLFxuICogYW5kIGluZGVudGVkIHZhcmlhbnRzLiBSZXR1cm5zIGVtcHR5IGFycmF5IHdoZW4gdGhlIHNlY3Rpb24gaXMgbWlzc2luZyBvciBlbXB0eS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlVGFza1BsYW5NdXN0SGF2ZXMoY29udGVudDogc3RyaW5nKTogQXJyYXk8eyB0ZXh0OiBzdHJpbmc7IGNoZWNrZWQ6IGJvb2xlYW4gfT4ge1xuICBjb25zdCBbLCBib2R5XSA9IHNwbGl0RnJvbnRtYXR0ZXIoY29udGVudCk7XG4gIGNvbnN0IHNlY3Rpb25UZXh0ID0gZXh0cmFjdFNlY3Rpb24oYm9keSwgJ011c3QtSGF2ZXMnKTtcbiAgaWYgKCFzZWN0aW9uVGV4dCkgcmV0dXJuIFtdO1xuXG4gIGNvbnN0IGJ1bGxldHMgPSBwYXJzZUJ1bGxldHMoc2VjdGlvblRleHQpO1xuICBpZiAoYnVsbGV0cy5sZW5ndGggPT09IDApIHJldHVybiBbXTtcblxuICByZXR1cm4gYnVsbGV0cy5tYXAobGluZSA9PiB7XG4gICAgY29uc3QgY2JNYXRjaCA9IGxpbmUubWF0Y2goL15cXFsoW3hYIF0pXFxdXFxzKyguKykvKTtcbiAgICBpZiAoY2JNYXRjaCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdGV4dDogY2JNYXRjaFsyXS50cmltKCksXG4gICAgICAgIGNoZWNrZWQ6IGNiTWF0Y2hbMV0udG9Mb3dlckNhc2UoKSA9PT0gJ3gnLFxuICAgICAgfTtcbiAgICB9XG4gICAgLy8gTm8gY2hlY2tib3ggLSB0cmVhdCBhcyB1bmNoZWNrZWQgd2l0aCBmdWxsIGxpbmUgYXMgdGV4dFxuICAgIHJldHVybiB7IHRleHQ6IGxpbmUudHJpbSgpLCBjaGVja2VkOiBmYWxzZSB9O1xuICB9KTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIE11c3QtSGF2ZSBTdW1tYXJ5IE1hdGNoaW5nIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKiogQ29tbW9uIHNob3J0IHdvcmRzIHRvIGV4Y2x1ZGUgZnJvbSBzdWJzdHJpbmcgbWF0Y2hpbmcuICovXG5jb25zdCBDT01NT05fV09SRFMgPSBuZXcgU2V0KFtcbiAgJ3RoZScsICdhbmQnLCAnZm9yJywgJ2FyZScsICdidXQnLCAnbm90JywgJ3lvdScsICdhbGwnLCAnY2FuJywgJ2hhZCcsICdoZXInLFxuICAnd2FzJywgJ29uZScsICdvdXInLCAnb3V0JywgJ2hhcycsICdpdHMnLCAnbGV0JywgJ3NheScsICdzaGUnLCAndG9vJywgJ3VzZScsXG4gICd3aXRoJywgJ2hhdmUnLCAnZnJvbScsICd0aGlzJywgJ3RoYXQnLCAndGhleScsICdiZWVuJywgJ2VhY2gnLCAnd2hlbicsICd3aWxsJyxcbiAgJ2RvZXMnLCAnaW50bycsICdhbHNvJywgJ3RoYW4nLCAndGhlbScsICd0aGVuJywgJ3NvbWUnLCAnd2hhdCcsICdvbmx5JywgJ2p1c3QnLFxuICAnbW9yZScsICdtYWtlJywgJ2xpa2UnLCAnbWFkZScsICdvdmVyJywgJ3N1Y2gnLCAndGFrZScsICdtb3N0JywgJ3ZlcnknLCAnbXVzdCcsXG4gICdmaWxlJywgJ3Rlc3QnLCAndGVzdHMnLCAndGFzaycsICduZXcnLCAnYWRkJywgJ2FkZGVkJywgJ2V4aXN0aW5nJyxcbl0pO1xuXG4vKipcbiAqIENvdW50IGhvdyBtYW55IG11c3QtaGF2ZSBpdGVtcyBhcmUgbWVudGlvbmVkIGluIGEgc3VtbWFyeS5cbiAqXG4gKiBNYXRjaGluZyBoZXVyaXN0aWMgcGVyIG11c3QtaGF2ZTpcbiAqIDEuIEV4dHJhY3QgYWxsIGJhY2t0aWNrLWVuY2xvc2VkIGNvZGUgdG9rZW5zIChlLmcuIGBpbnNwZWN0Rm9vYCkuXG4gKiAgICBJZiBhbnkgY29kZSB0b2tlbiBhcHBlYXJzIGNhc2UtaW5zZW5zaXRpdmVseSBpbiB0aGUgc3VtbWFyeSwgY291bnQgYXMgbWVudGlvbmVkLlxuICogMi4gSWYgbm8gY29kZSB0b2tlbnMgZXhpc3QsIGNoZWNrIGlmIGFueSBzaWduaWZpY2FudCB3b3JkIChcdTIyNjU0IGNoYXJzLCBub3QgYSBjb21tb24gd29yZClcbiAqICAgIGZyb20gdGhlIG11c3QtaGF2ZSB0ZXh0IGFwcGVhcnMgaW4gdGhlIHN1bW1hcnkgKGNhc2UtaW5zZW5zaXRpdmUpLlxuICpcbiAqIFJldHVybnMgdGhlIGNvdW50IG9mIG11c3QtaGF2ZXMgdGhhdCBoYWQgYXQgbGVhc3Qgb25lIG1hdGNoLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY291bnRNdXN0SGF2ZXNNZW50aW9uZWRJblN1bW1hcnkoXG4gIG11c3RIYXZlczogQXJyYXk8eyB0ZXh0OiBzdHJpbmc7IGNoZWNrZWQ6IGJvb2xlYW4gfT4sXG4gIHN1bW1hcnlDb250ZW50OiBzdHJpbmcsXG4pOiBudW1iZXIge1xuICBpZiAoIXN1bW1hcnlDb250ZW50IHx8IG11c3RIYXZlcy5sZW5ndGggPT09IDApIHJldHVybiAwO1xuXG4gIGNvbnN0IHN1bW1hcnlMb3dlciA9IHN1bW1hcnlDb250ZW50LnRvTG93ZXJDYXNlKCk7XG4gIGxldCBjb3VudCA9IDA7XG5cbiAgZm9yIChjb25zdCBtaCBvZiBtdXN0SGF2ZXMpIHtcbiAgICAvLyBFeHRyYWN0IGJhY2t0aWNrLWVuY2xvc2VkIGNvZGUgdG9rZW5zXG4gICAgY29uc3QgY29kZVRva2Vuczogc3RyaW5nW10gPSBbXTtcbiAgICBjb25zdCBjb2RlUmVnZXggPSAvYChbXmBdKylgL2c7XG4gICAgbGV0IG1hdGNoOiBSZWdFeHBFeGVjQXJyYXkgfCBudWxsO1xuICAgIHdoaWxlICgobWF0Y2ggPSBjb2RlUmVnZXguZXhlYyhtaC50ZXh0KSkgIT09IG51bGwpIHtcbiAgICAgIGNvZGVUb2tlbnMucHVzaChtYXRjaFsxXSk7XG4gICAgfVxuXG4gICAgaWYgKGNvZGVUb2tlbnMubGVuZ3RoID4gMCkge1xuICAgICAgLy8gU3RyYXRlZ3kgMTogYW55IGNvZGUgdG9rZW4gZm91bmQgaW4gc3VtbWFyeSAoY2FzZS1pbnNlbnNpdGl2ZSlcbiAgICAgIGNvbnN0IGZvdW5kID0gY29kZVRva2Vucy5zb21lKHRva2VuID0+IHN1bW1hcnlMb3dlci5pbmNsdWRlcyh0b2tlbi50b0xvd2VyQ2FzZSgpKSk7XG4gICAgICBpZiAoZm91bmQpIGNvdW50Kys7XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIFN0cmF0ZWd5IDI6IHNpZ25pZmljYW50IHN1YnN0cmluZyBtYXRjaGluZ1xuICAgICAgLy8gU3BsaXQgaW50byB3b3Jkcywga2VlcCB3b3JkcyBcdTIyNjU0IGNoYXJzIHRoYXQgYXJlbid0IGNvbW1vblxuICAgICAgY29uc3Qgd29yZHMgPSBtaC50ZXh0LnJlcGxhY2UoL1teXFx3XFxzXS9nLCAnICcpLnNwbGl0KC9cXHMrLykuZmlsdGVyKHcgPT5cbiAgICAgICAgdy5sZW5ndGggPj0gNCAmJiAhQ09NTU9OX1dPUkRTLmhhcyh3LnRvTG93ZXJDYXNlKCkpXG4gICAgICApO1xuICAgICAgY29uc3QgZm91bmQgPSB3b3Jkcy5zb21lKHdvcmQgPT4gc3VtbWFyeUxvd2VyLmluY2x1ZGVzKHdvcmQudG9Mb3dlckNhc2UoKSkpO1xuICAgICAgaWYgKGZvdW5kKSBjb3VudCsrO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiBjb3VudDtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRhc2sgUGxhbiBJTyBFeHRyYWN0b3IgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogRXh0cmFjdCBpbnB1dCBhbmQgb3V0cHV0IGZpbGUgcGF0aHMgZnJvbSBhIHRhc2sgcGxhbidzIGAjIyBJbnB1dHNgIGFuZFxuICogYCMjIEV4cGVjdGVkIE91dHB1dGAgc2VjdGlvbnMuIExvb2tzIGZvciBiYWNrdGljay13cmFwcGVkIGZpbGUgcGF0aHMgb25cbiAqIGVhY2ggbGluZSAoZS5nLiBgYCBgc3JjL2Zvby50c2AgYGApLlxuICpcbiAqIFJldHVybnMgZW1wdHkgYXJyYXlzIGZvciBtaXNzaW5nL2VtcHR5IHNlY3Rpb25zIFx1MjAxNCBjYWxsZXJzIHNob3VsZCB0cmVhdFxuICogdGFza3Mgd2l0aCBubyBJTyBhcyBhbWJpZ3VvdXMgKHNlcXVlbnRpYWwgZmFsbGJhY2sgdHJpZ2dlcikuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVRhc2tQbGFuSU8oY29udGVudDogc3RyaW5nKTogeyBpbnB1dEZpbGVzOiBzdHJpbmdbXTsgb3V0cHV0RmlsZXM6IHN0cmluZ1tdIH0ge1xuICBjb25zdCBiYWNrdGlja1BhdGhSZWdleCA9IC9gKFteYF0rKWAvZztcblxuICBmdW5jdGlvbiBleHRyYWN0UGF0aHMoc2VjdGlvblRleHQ6IHN0cmluZyB8IG51bGwpOiBzdHJpbmdbXSB7XG4gICAgaWYgKCFzZWN0aW9uVGV4dCkgcmV0dXJuIFtdO1xuICAgIGNvbnN0IHBhdGhzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgbGluZSBvZiBzZWN0aW9uVGV4dC5zcGxpdChcIlxcblwiKSkge1xuICAgICAgY29uc3QgdHJpbW1lZCA9IGxpbmUudHJpbSgpO1xuICAgICAgaWYgKCF0cmltbWVkIHx8IHRyaW1tZWQuc3RhcnRzV2l0aChcIiNcIikpIGNvbnRpbnVlO1xuICAgICAgbGV0IG1hdGNoOiBSZWdFeHBFeGVjQXJyYXkgfCBudWxsO1xuICAgICAgYmFja3RpY2tQYXRoUmVnZXgubGFzdEluZGV4ID0gMDtcbiAgICAgIHdoaWxlICgobWF0Y2ggPSBiYWNrdGlja1BhdGhSZWdleC5leGVjKHRyaW1tZWQpKSAhPT0gbnVsbCkge1xuICAgICAgICBjb25zdCBjYW5kaWRhdGUgPSBub3JtYWxpemVQbGFubmVkRmlsZVJlZmVyZW5jZShtYXRjaFsxXSk7XG4gICAgICAgIC8vIEZpbHRlciBvdXQgdGhpbmdzIHRoYXQgbG9vayBsaWtlIGNvZGUgdG9rZW5zIHJhdGhlciB0aGFuIGZpbGUgcGF0aHNcbiAgICAgICAgLy8gKGUuZy4gYHRydWVgLCBgZmFsc2VgLCBgbnBtIHJ1biB0ZXN0YCkuIEEgZmlsZSBwYXRoIGhhcyBhdCBsZWFzdCBvbmVcbiAgICAgICAgLy8gZG90IG9yIHNsYXNoLlxuICAgICAgICBpZiAoY2FuZGlkYXRlLmluY2x1ZGVzKFwiL1wiKSB8fCBjYW5kaWRhdGUuaW5jbHVkZXMoXCJcXFxcXCIpIHx8IGNhbmRpZGF0ZS5pbmNsdWRlcyhcIi5cIikpIHtcbiAgICAgICAgICBwYXRocy5wdXNoKGNhbmRpZGF0ZSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHBhdGhzO1xuICB9XG5cbiAgY29uc3QgWywgYm9keV0gPSBzcGxpdEZyb250bWF0dGVyKGNvbnRlbnQpO1xuICBjb25zdCBpbnB1dFNlY3Rpb24gPSBleHRyYWN0U2VjdGlvbihib2R5LCBcIklucHV0c1wiKTtcbiAgY29uc3Qgb3V0cHV0U2VjdGlvbiA9IGV4dHJhY3RTZWN0aW9uKGJvZHksIFwiRXhwZWN0ZWQgT3V0cHV0XCIpO1xuXG4gIHJldHVybiB7XG4gICAgaW5wdXRGaWxlczogZXh0cmFjdFBhdGhzKGlucHV0U2VjdGlvbiksXG4gICAgb3V0cHV0RmlsZXM6IGV4dHJhY3RQYXRocyhvdXRwdXRTZWN0aW9uKSxcbiAgfTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFVBVCBUeXBlIEV4dHJhY3RvciBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBUaGUgZm91ciBVQVQgY2xhc3NpZmljYXRpb24gdHlwZXMgcmVjb2duaXNlZCBieSBHU0QgYXV0by1tb2RlLlxuICogYHVuZGVmaW5lZGAgaXMgcmV0dXJuZWQgKG5vdCB0aGlzIHVuaW9uKSB3aGVuIG5vIHR5cGUgY2FuIGJlIGRldGVybWluZWQuXG4gKi9cbmV4cG9ydCB0eXBlIFVhdFR5cGUgPSAnYXJ0aWZhY3QtZHJpdmVuJyB8ICdsaXZlLXJ1bnRpbWUnIHwgJ2h1bWFuLWV4cGVyaWVuY2UnIHwgJ21peGVkJyB8ICdicm93c2VyLWV4ZWN1dGFibGUnIHwgJ3J1bnRpbWUtZXhlY3V0YWJsZSc7XG5cbi8qKlxuICogRXh0cmFjdCB0aGUgVUFUIHR5cGUgZnJvbSBhIFVBVCBmaWxlJ3MgcmF3IGNvbnRlbnQuXG4gKlxuICogVUFUIGZpbGVzIGhhdmUgbm8gWUFNTCBmcm9udG1hdHRlciAtIHBhc3MgcmF3IGZpbGUgY29udGVudCBkaXJlY3RseS5cbiAqIENsYXNzaWZpY2F0aW9uIGlzIGxlYWRpbmcta2V5d29yZC1vbmx5OiBlLmcuIGBtaXhlZCAoYXJ0aWZhY3QtZHJpdmVuICsgbGl2ZS1ydW50aW1lKWAgXHUyMTkyIGAnbWl4ZWQnYC5cbiAqXG4gKiBSZXR1cm5zIGB1bmRlZmluZWRgIHdoZW46XG4gKiAtIHRoZSBgIyMgVUFUIFR5cGVgIHNlY3Rpb24gaXMgYWJzZW50XG4gKiAtIG5vIGBVQVQgbW9kZTpgIGJ1bGxldCBpcyBmb3VuZCBpbiB0aGUgc2VjdGlvblxuICogLSB0aGUgdmFsdWUgZG9lcyBub3Qgc3RhcnQgd2l0aCBhIHJlY29nbmlzZWQga2V5d29yZFxuICovXG5leHBvcnQgZnVuY3Rpb24gZXh0cmFjdFVhdFR5cGUoY29udGVudDogc3RyaW5nKTogVWF0VHlwZSB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IHNlY3Rpb25UZXh0ID0gZXh0cmFjdFNlY3Rpb24oY29udGVudCwgJ1VBVCBUeXBlJyk7XG4gIGlmICghc2VjdGlvblRleHQpIHJldHVybiB1bmRlZmluZWQ7XG5cbiAgY29uc3QgYnVsbGV0cyA9IHBhcnNlQnVsbGV0cyhzZWN0aW9uVGV4dCk7XG4gIGNvbnN0IG1vZGVCdWxsZXQgPSBidWxsZXRzLmZpbmQoYiA9PiBiLnN0YXJ0c1dpdGgoJ1VBVCBtb2RlOicpKTtcbiAgaWYgKCFtb2RlQnVsbGV0KSByZXR1cm4gdW5kZWZpbmVkO1xuXG4gIGNvbnN0IHJhd1ZhbHVlID0gbW9kZUJ1bGxldC5zbGljZSgnVUFUIG1vZGU6Jy5sZW5ndGgpLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuXG4gIGlmIChyYXdWYWx1ZS5zdGFydHNXaXRoKCdhcnRpZmFjdC1kcml2ZW4nKSkgcmV0dXJuICdhcnRpZmFjdC1kcml2ZW4nO1xuICBpZiAocmF3VmFsdWUuc3RhcnRzV2l0aCgnYnJvd3Nlci1leGVjdXRhYmxlJykpIHJldHVybiAnYnJvd3Nlci1leGVjdXRhYmxlJztcbiAgaWYgKHJhd1ZhbHVlLnN0YXJ0c1dpdGgoJ3J1bnRpbWUtZXhlY3V0YWJsZScpKSByZXR1cm4gJ3J1bnRpbWUtZXhlY3V0YWJsZSc7XG4gIGlmIChyYXdWYWx1ZS5zdGFydHNXaXRoKCdsaXZlLXJ1bnRpbWUnKSkgcmV0dXJuICdsaXZlLXJ1bnRpbWUnO1xuICBpZiAocmF3VmFsdWUuc3RhcnRzV2l0aCgnaHVtYW4tZXhwZXJpZW5jZScpKSByZXR1cm4gJ2h1bWFuLWV4cGVyaWVuY2UnO1xuICBpZiAocmF3VmFsdWUuc3RhcnRzV2l0aCgnbWl4ZWQnKSkgcmV0dXJuICdtaXhlZCc7XG5cbiAgcmV0dXJuIHVuZGVmaW5lZDtcbn1cblxuLyoqXG4gKiBFeHRyYWN0IHRoZSBgZGVwZW5kc19vbmAgbGlzdCBmcm9tIE0wMHgtQ09OVEVYVC5tZCBZQU1MIGZyb250bWF0dGVyLlxuICogUmV0dXJucyBbXSB3aGVuOiBjb250ZW50IGlzIG51bGwsIG5vIGZyb250bWF0dGVyIGJsb2NrLCBmaWVsZCBhYnNlbnQsIG9yIGZpZWxkIGlzIGVtcHR5LlxuICogTm9ybWFsaXplcyBlYWNoIGRlcCBJRCB0byB1cHBlcmNhc2UgKGUuZy4gJ20wMDEnIFx1MjE5MiAnTTAwMScpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VDb250ZXh0RGVwZW5kc09uKGNvbnRlbnQ6IHN0cmluZyB8IG51bGwpOiBzdHJpbmdbXSB7XG4gIGlmICghY29udGVudCkgcmV0dXJuIFtdO1xuICBjb25zdCBbZm1MaW5lc10gPSBzcGxpdEZyb250bWF0dGVyKGNvbnRlbnQpO1xuICBpZiAoIWZtTGluZXMpIHJldHVybiBbXTtcbiAgY29uc3QgZm0gPSBwYXJzZUZyb250bWF0dGVyTWFwKGZtTGluZXMpO1xuICBjb25zdCByYXcgPSBmbVsnZGVwZW5kc19vbiddO1xuICBpZiAoIUFycmF5LmlzQXJyYXkocmF3KSB8fCByYXcubGVuZ3RoID09PSAwKSByZXR1cm4gW107XG4gIHJldHVybiAocmF3IGFzIHN0cmluZ1tdKS5tYXAocyA9PiBTdHJpbmcocykudHJpbSgpKS5maWx0ZXIoQm9vbGVhbik7XG59XG5cbi8qKlxuICogSW5saW5lIHRoZSBwcmlvciBtaWxlc3RvbmUncyBTVU1NQVJZLm1kIGFzIGNvbnRleHQgZm9yIHRoZSBjdXJyZW50IG1pbGVzdG9uZSdzIHBsYW5uaW5nIHByb21wdC5cbiAqIFJldHVybnMgbnVsbCB3aGVuOiAoMSkgYG1pZGAgaXMgdGhlIGZpcnN0IG1pbGVzdG9uZSwgKDIpIHByaW9yIG1pbGVzdG9uZSBoYXMgbm8gU1VNTUFSWSBmaWxlLlxuICpcbiAqIFVzZXMgdGhlIHNoYXJlZCBmaW5kTWlsZXN0b25lSWRzIHRvIHNjYW4gdGhlIG1pbGVzdG9uZXMgZGlyZWN0b3J5LlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaW5saW5lUHJpb3JNaWxlc3RvbmVTdW1tYXJ5KG1pZDogc3RyaW5nLCBiYXNlOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgY29uc3Qgc29ydGVkID0gZmluZE1pbGVzdG9uZUlkcyhiYXNlKTtcbiAgaWYgKHNvcnRlZC5sZW5ndGggPT09IDApIHJldHVybiBudWxsO1xuICBjb25zdCBpZHggPSBzb3J0ZWQuaW5kZXhPZihtaWQpO1xuICBpZiAoaWR4IDw9IDApIHJldHVybiBudWxsO1xuICBjb25zdCBwcmV2TWlkID0gc29ydGVkW2lkeCAtIDFdO1xuICBjb25zdCBhYnNQYXRoID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZSwgcHJldk1pZCwgXCJTVU1NQVJZXCIpO1xuICBjb25zdCByZWxQYXRoID0gcmVsTWlsZXN0b25lRmlsZShiYXNlLCBwcmV2TWlkLCBcIlNVTU1BUllcIik7XG4gIGNvbnN0IGNvbnRlbnQgPSBhYnNQYXRoID8gYXdhaXQgbG9hZEZpbGUoYWJzUGF0aCkgOiBudWxsO1xuICBpZiAoIWNvbnRlbnQpIHJldHVybiBudWxsO1xuICByZXR1cm4gYCMjIyBQcmlvciBNaWxlc3RvbmUgU3VtbWFyeVxcblNvdXJjZTogXFxgJHtyZWxQYXRofVxcYFxcblxcbiR7Y29udGVudC50cmltKCl9YDtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIE1hbmlmZXN0IFN0YXR1cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBSZWFkIGEgc2VjcmV0cyBtYW5pZmVzdCBmcm9tIGRpc2sgYW5kIGNyb3NzLXJlZmVyZW5jZSBlYWNoIGVudHJ5J3Mgc3RhdHVzXG4gKiB3aXRoIHRoZSBjdXJyZW50IGVudmlyb25tZW50ICguZW52ICsgcHJvY2Vzcy5lbnYpLlxuICpcbiAqIFJldHVybnMgYG51bGxgIHdoZW4gbm8gbWFuaWZlc3QgZmlsZSBleGlzdHMgKHBhdGggcmVzb2x1dGlvbiBmYWlsdXJlIG9yXG4gKiBmaWxlIG5vdCBvbiBkaXNrKSAtIGNhbGxlcnMgY2FuIGRpc3Rpbmd1aXNoIFwibm8gbWFuaWZlc3RcIiBmcm9tIFwiZW1wdHkgbWFuaWZlc3RcIi5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldE1hbmlmZXN0U3RhdHVzKFxuICBiYXNlOiBzdHJpbmcsIG1pbGVzdG9uZUlkOiBzdHJpbmcsIHByb2plY3RSb290Pzogc3RyaW5nLFxuKTogUHJvbWlzZTxNYW5pZmVzdFN0YXR1cyB8IG51bGw+IHtcbiAgY29uc3QgcmVzb2x2ZWRQYXRoID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZSwgbWlsZXN0b25lSWQsICdTRUNSRVRTJyk7XG4gIGlmICghcmVzb2x2ZWRQYXRoKSByZXR1cm4gbnVsbDtcblxuICBjb25zdCBjb250ZW50ID0gYXdhaXQgbG9hZEZpbGUocmVzb2x2ZWRQYXRoKTtcbiAgaWYgKCFjb250ZW50KSByZXR1cm4gbnVsbDtcblxuICBjb25zdCBtYW5pZmVzdCA9IHBhcnNlU2VjcmV0c01hbmlmZXN0KGNvbnRlbnQpO1xuICBjb25zdCBrZXlzID0gbWFuaWZlc3QuZW50cmllcy5tYXAoZSA9PiBlLmtleSk7XG5cbiAgLy8gQ2hlY2sgYm90aCB0aGUgYmFzZSBwYXRoIC5lbnYgQU5EIHRoZSBwcm9qZWN0IHJvb3QgLmVudiAoIzEzODcpLlxuICAvLyBJbiB3b3JrdHJlZSBtb2RlLCBiYXNlIGlzIHRoZSB3b3JrdHJlZSBwYXRoIHdoaWNoIG1heSBub3QgaGF2ZSAuZW52LlxuICAvLyBUaGUgcHJvamVjdCByb290J3MgLmVudiBpcyB3aGVyZSB0aGUgdXNlciBhY3R1YWxseSBkZWZpbmVkIHRoZWlyIGtleXMuXG4gIGNvbnN0IGV4aXN0aW5nS2V5cyA9IGF3YWl0IGNoZWNrRXhpc3RpbmdFbnZLZXlzKGtleXMsIHJlc29sdmUoYmFzZSwgJy5lbnYnKSk7XG4gIGNvbnN0IGV4aXN0aW5nU2V0ID0gbmV3IFNldChleGlzdGluZ0tleXMpO1xuXG4gIGlmIChwcm9qZWN0Um9vdCAmJiBwcm9qZWN0Um9vdCAhPT0gYmFzZSkge1xuICAgIGNvbnN0IHJvb3RLZXlzID0gYXdhaXQgY2hlY2tFeGlzdGluZ0VudktleXMoa2V5cywgcmVzb2x2ZShwcm9qZWN0Um9vdCwgJy5lbnYnKSk7XG4gICAgZm9yIChjb25zdCBrIG9mIHJvb3RLZXlzKSBleGlzdGluZ1NldC5hZGQoayk7XG4gIH1cblxuICBjb25zdCByZXN1bHQ6IE1hbmlmZXN0U3RhdHVzID0ge1xuICAgIHBlbmRpbmc6IFtdLFxuICAgIGNvbGxlY3RlZDogW10sXG4gICAgc2tpcHBlZDogW10sXG4gICAgZXhpc3Rpbmc6IFtdLFxuICB9O1xuXG4gIGZvciAoY29uc3QgZW50cnkgb2YgbWFuaWZlc3QuZW50cmllcykge1xuICAgIGlmIChleGlzdGluZ1NldC5oYXMoZW50cnkua2V5KSkge1xuICAgICAgcmVzdWx0LmV4aXN0aW5nLnB1c2goZW50cnkua2V5KTtcbiAgICB9IGVsc2Uge1xuICAgICAgcmVzdWx0W2VudHJ5LnN0YXR1c10ucHVzaChlbnRyeS5rZXkpO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiByZXN1bHQ7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBPdmVycmlkZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBpbnRlcmZhY2UgT3ZlcnJpZGUge1xuICB0aW1lc3RhbXA6IHN0cmluZztcbiAgY2hhbmdlOiBzdHJpbmc7XG4gIHNjb3BlOiBcImFjdGl2ZVwiIHwgXCJyZXNvbHZlZFwiO1xuICBhcHBsaWVkQXQ6IHN0cmluZztcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGFwcGVuZE92ZXJyaWRlKGJhc2VQYXRoOiBzdHJpbmcsIGNoYW5nZTogc3RyaW5nLCBhcHBsaWVkQXQ6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBvdmVycmlkZXNQYXRoID0gcmVzb2x2ZUdzZFJvb3RGaWxlKGJhc2VQYXRoLCBcIk9WRVJSSURFU1wiKTtcbiAgY29uc3QgdGltZXN0YW1wID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuICBjb25zdCBlbnRyeSA9IFtcbiAgICBgIyMgT3ZlcnJpZGU6ICR7dGltZXN0YW1wfWAsXG4gICAgXCJcIixcbiAgICBgKipDaGFuZ2U6KiogJHtjaGFuZ2V9YCxcbiAgICBgKipTY29wZToqKiBhY3RpdmVgLFxuICAgIGAqKkFwcGxpZWQtYXQ6KiogJHthcHBsaWVkQXR9YCxcbiAgICBcIlwiLFxuICAgIFwiLS0tXCIsXG4gICAgXCJcIixcbiAgXS5qb2luKFwiXFxuXCIpO1xuXG4gIGNvbnN0IGV4aXN0aW5nID0gYXdhaXQgbG9hZEZpbGUob3ZlcnJpZGVzUGF0aCk7XG4gIGlmIChleGlzdGluZykge1xuICAgIGF3YWl0IHNhdmVGaWxlKG92ZXJyaWRlc1BhdGgsIGV4aXN0aW5nLnRyaW1FbmQoKSArIFwiXFxuXFxuXCIgKyBlbnRyeSk7XG4gIH0gZWxzZSB7XG4gICAgY29uc3QgaGVhZGVyID0gW1xuICAgICAgXCIjIEdTRCBPdmVycmlkZXNcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIlVzZXItaXNzdWVkIG92ZXJyaWRlcyB0aGF0IHN1cGVyc2VkZSBwbGFuIGRvY3VtZW50IGNvbnRlbnQuXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCItLS1cIixcbiAgICAgIFwiXCIsXG4gICAgXS5qb2luKFwiXFxuXCIpO1xuICAgIGF3YWl0IHNhdmVGaWxlKG92ZXJyaWRlc1BhdGgsIGhlYWRlciArIGVudHJ5KTtcbiAgfVxufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gYXBwZW5kS25vd2xlZGdlKFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICB0eXBlOiBcInJ1bGVcIiB8IFwicGF0dGVyblwiIHwgXCJsZXNzb25cIixcbiAgZW50cnk6IHN0cmluZyxcbiAgc2NvcGU6IHN0cmluZyxcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBrbm93bGVkZ2VQYXRoID0gcmVzb2x2ZUdzZFJvb3RGaWxlKGJhc2VQYXRoLCBcIktOT1dMRURHRVwiKTtcbiAgY29uc3QgZXhpc3RpbmcgPSBhd2FpdCBsb2FkRmlsZShrbm93bGVkZ2VQYXRoKTtcblxuICBpZiAoZXhpc3RpbmcpIHtcbiAgICAvLyBGaW5kIHRoZSBuZXh0IElEIGZvciB0aGlzIHR5cGVcbiAgICBjb25zdCBwcmVmaXggPSB0eXBlID09PSBcInJ1bGVcIiA/IFwiS1wiIDogdHlwZSA9PT0gXCJwYXR0ZXJuXCIgPyBcIlBcIiA6IFwiTFwiO1xuICAgIGNvbnN0IGlkUGF0dGVybiA9IG5ldyBSZWdFeHAoYF5cXFxcfCAke3ByZWZpeH0oXFxcXGQrKWAsIFwiZ21cIik7XG4gICAgbGV0IG1heElkID0gMDtcbiAgICBsZXQgbWF0Y2g7XG4gICAgd2hpbGUgKChtYXRjaCA9IGlkUGF0dGVybi5leGVjKGV4aXN0aW5nKSkgIT09IG51bGwpIHtcbiAgICAgIGNvbnN0IG51bSA9IHBhcnNlSW50KG1hdGNoWzFdLCAxMCk7XG4gICAgICBpZiAobnVtID4gbWF4SWQpIG1heElkID0gbnVtO1xuICAgIH1cbiAgICBjb25zdCBuZXh0SWQgPSBgJHtwcmVmaXh9JHtTdHJpbmcobWF4SWQgKyAxKS5wYWRTdGFydCgzLCBcIjBcIil9YDtcblxuICAgIC8vIEJ1aWxkIHRoZSB0YWJsZSByb3dcbiAgICBsZXQgcm93OiBzdHJpbmc7XG4gICAgaWYgKHR5cGUgPT09IFwicnVsZVwiKSB7XG4gICAgICByb3cgPSBgfCAke25leHRJZH0gfCAke3Njb3BlfSB8ICR7ZW50cnl9IHwgXHUyMDE0IHwgbWFudWFsIHxgO1xuICAgIH0gZWxzZSBpZiAodHlwZSA9PT0gXCJwYXR0ZXJuXCIpIHtcbiAgICAgIHJvdyA9IGB8ICR7bmV4dElkfSB8ICR7ZW50cnl9IHwgXHUyMDE0IHwgJHtzY29wZX0gfGA7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJvdyA9IGB8ICR7bmV4dElkfSB8ICR7ZW50cnl9IHwgXHUyMDE0IHwgXHUyMDE0IHwgJHtzY29wZX0gfGA7XG4gICAgfVxuXG4gICAgLy8gRmluZCB0aGUgcmlnaHQgc2VjdGlvbiBhbmQgYXBwZW5kIGFmdGVyIHRoZSB0YWJsZSBoZWFkZXJcbiAgICBjb25zdCBzZWN0aW9uSGVhZGluZyA9IHR5cGUgPT09IFwicnVsZVwiID8gXCIjIyBSdWxlc1wiIDogdHlwZSA9PT0gXCJwYXR0ZXJuXCIgPyBcIiMjIFBhdHRlcm5zXCIgOiBcIiMjIExlc3NvbnMgTGVhcm5lZFwiO1xuICAgIGNvbnN0IHNlY3Rpb25JZHggPSBleGlzdGluZy5pbmRleE9mKHNlY3Rpb25IZWFkaW5nKTtcbiAgICBpZiAoc2VjdGlvbklkeCAhPT0gLTEpIHtcbiAgICAgIC8vIEZpbmQgdGhlIGVuZCBvZiB0aGUgdGFibGUgaGVhZGVyIHJvdyAodGhlIHwtLS18Li4ufCBsaW5lKVxuICAgICAgY29uc3QgYWZ0ZXJIZWFkaW5nID0gZXhpc3RpbmcuaW5kZXhPZihcIlxcblwiLCBzZWN0aW9uSWR4KTtcbiAgICAgIC8vIEZpbmQgdGhlIG5leHQgc2VjdGlvbiBvciBlbmRcbiAgICAgIGNvbnN0IG5leHRTZWN0aW9uID0gZXhpc3RpbmcuaW5kZXhPZihcIlxcbiMjIFwiLCBhZnRlckhlYWRpbmcgKyAxKTtcbiAgICAgIGNvbnN0IGluc2VydFBvaW50ID0gbmV4dFNlY3Rpb24gIT09IC0xID8gbmV4dFNlY3Rpb24gOiBleGlzdGluZy5sZW5ndGg7XG5cbiAgICAgIC8vIEluc2VydCByb3cgYmVmb3JlIHRoZSBuZXh0IHNlY3Rpb24gKG9yIGF0IGVuZClcbiAgICAgIGNvbnN0IGJlZm9yZSA9IGV4aXN0aW5nLnNsaWNlKDAsIGluc2VydFBvaW50KS50cmltRW5kKCk7XG4gICAgICBjb25zdCBhZnRlciA9IGV4aXN0aW5nLnNsaWNlKGluc2VydFBvaW50KTtcbiAgICAgIGF3YWl0IHNhdmVGaWxlKGtub3dsZWRnZVBhdGgsIGJlZm9yZSArIFwiXFxuXCIgKyByb3cgKyBcIlxcblwiICsgYWZ0ZXIpO1xuICAgIH0gZWxzZSB7XG4gICAgICAvLyBTZWN0aW9uIG5vdCBmb3VuZCBcdTIwMTQgYXBwZW5kIGF0IGVuZFxuICAgICAgYXdhaXQgc2F2ZUZpbGUoa25vd2xlZGdlUGF0aCwgZXhpc3RpbmcudHJpbUVuZCgpICsgXCJcXG5cXG5cIiArIHJvdyArIFwiXFxuXCIpO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICAvLyBDcmVhdGUgZmlsZSBmcm9tIHNjcmF0Y2ggd2l0aCB0ZW1wbGF0ZSBoZWFkZXJcbiAgICBjb25zdCBoZWFkZXIgPSBbXG4gICAgICBcIiMgUHJvamVjdCBLbm93bGVkZ2VcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIkFwcGVuZC1vbmx5IHJlZ2lzdGVyIG9mIHByb2plY3Qtc3BlY2lmaWMgcnVsZXMsIHBhdHRlcm5zLCBhbmQgbGVzc29ucyBsZWFybmVkLlwiLFxuICAgICAgXCJBZ2VudHMgcmVhZCB0aGlzIGJlZm9yZSBldmVyeSB1bml0LiBBZGQgZW50cmllcyB3aGVuIHlvdSBkaXNjb3ZlciBzb21ldGhpbmcgd29ydGggcmVtZW1iZXJpbmcuXCIsXG4gICAgICBcIlwiLFxuICAgIF0uam9pbihcIlxcblwiKTtcblxuICAgIGxldCBjb250ZW50OiBzdHJpbmc7XG4gICAgaWYgKHR5cGUgPT09IFwicnVsZVwiKSB7XG4gICAgICBjb250ZW50ID0gaGVhZGVyICsgW1xuICAgICAgICBcIiMjIFJ1bGVzXCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwifCAjIHwgU2NvcGUgfCBSdWxlIHwgV2h5IHwgQWRkZWQgfFwiLFxuICAgICAgICBcInwtLS18LS0tLS0tLXwtLS0tLS18LS0tLS18LS0tLS0tLXxcIixcbiAgICAgICAgYHwgSzAwMSB8ICR7c2NvcGV9IHwgJHtlbnRyeX0gfCBcdTIwMTQgfCBtYW51YWwgfGAsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiIyMgUGF0dGVybnNcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCJ8ICMgfCBQYXR0ZXJuIHwgV2hlcmUgfCBOb3RlcyB8XCIsXG4gICAgICAgIFwifC0tLXwtLS0tLS0tLS18LS0tLS0tLXwtLS0tLS0tfFwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIiMjIExlc3NvbnMgTGVhcm5lZFwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcInwgIyB8IFdoYXQgSGFwcGVuZWQgfCBSb290IENhdXNlIHwgRml4IHwgU2NvcGUgfFwiLFxuICAgICAgICBcInwtLS18LS0tLS0tLS0tLS0tLS18LS0tLS0tLS0tLS0tfC0tLS0tfC0tLS0tLS18XCIsXG4gICAgICAgIFwiXCIsXG4gICAgICBdLmpvaW4oXCJcXG5cIik7XG4gICAgfSBlbHNlIGlmICh0eXBlID09PSBcInBhdHRlcm5cIikge1xuICAgICAgY29udGVudCA9IGhlYWRlciArIFtcbiAgICAgICAgXCIjIyBSdWxlc1wiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcInwgIyB8IFNjb3BlIHwgUnVsZSB8IFdoeSB8IEFkZGVkIHxcIixcbiAgICAgICAgXCJ8LS0tfC0tLS0tLS18LS0tLS0tfC0tLS0tfC0tLS0tLS18XCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiIyMgUGF0dGVybnNcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCJ8ICMgfCBQYXR0ZXJuIHwgV2hlcmUgfCBOb3RlcyB8XCIsXG4gICAgICAgIFwifC0tLXwtLS0tLS0tLS18LS0tLS0tLXwtLS0tLS0tfFwiLFxuICAgICAgICBgfCBQMDAxIHwgJHtlbnRyeX0gfCBcdTIwMTQgfCAke3Njb3BlfSB8YCxcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCIjIyBMZXNzb25zIExlYXJuZWRcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCJ8ICMgfCBXaGF0IEhhcHBlbmVkIHwgUm9vdCBDYXVzZSB8IEZpeCB8IFNjb3BlIHxcIixcbiAgICAgICAgXCJ8LS0tfC0tLS0tLS0tLS0tLS0tfC0tLS0tLS0tLS0tLXwtLS0tLXwtLS0tLS0tfFwiLFxuICAgICAgICBcIlwiLFxuICAgICAgXS5qb2luKFwiXFxuXCIpO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb250ZW50ID0gaGVhZGVyICsgW1xuICAgICAgICBcIiMjIFJ1bGVzXCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwifCAjIHwgU2NvcGUgfCBSdWxlIHwgV2h5IHwgQWRkZWQgfFwiLFxuICAgICAgICBcInwtLS18LS0tLS0tLXwtLS0tLS18LS0tLS18LS0tLS0tLXxcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCIjIyBQYXR0ZXJuc1wiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcInwgIyB8IFBhdHRlcm4gfCBXaGVyZSB8IE5vdGVzIHxcIixcbiAgICAgICAgXCJ8LS0tfC0tLS0tLS0tLXwtLS0tLS0tfC0tLS0tLS18XCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiIyMgTGVzc29ucyBMZWFybmVkXCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwifCAjIHwgV2hhdCBIYXBwZW5lZCB8IFJvb3QgQ2F1c2UgfCBGaXggfCBTY29wZSB8XCIsXG4gICAgICAgIFwifC0tLXwtLS0tLS0tLS0tLS0tLXwtLS0tLS0tLS0tLS18LS0tLS18LS0tLS0tLXxcIixcbiAgICAgICAgYHwgTDAwMSB8ICR7ZW50cnl9IHwgXHUyMDE0IHwgXHUyMDE0IHwgJHtzY29wZX0gfGAsXG4gICAgICAgIFwiXCIsXG4gICAgICBdLmpvaW4oXCJcXG5cIik7XG4gICAgfVxuICAgIGF3YWl0IHNhdmVGaWxlKGtub3dsZWRnZVBhdGgsIGNvbnRlbnQpO1xuICB9XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsb2FkQWN0aXZlT3ZlcnJpZGVzKGJhc2VQYXRoOiBzdHJpbmcpOiBQcm9taXNlPE92ZXJyaWRlW10+IHtcbiAgY29uc3Qgb3ZlcnJpZGVzUGF0aCA9IHJlc29sdmVHc2RSb290RmlsZShiYXNlUGF0aCwgXCJPVkVSUklERVNcIik7XG4gIGNvbnN0IGNvbnRlbnQgPSBhd2FpdCBsb2FkRmlsZShvdmVycmlkZXNQYXRoKTtcbiAgaWYgKCFjb250ZW50KSByZXR1cm4gW107XG4gIHJldHVybiBwYXJzZU92ZXJyaWRlcyhjb250ZW50KS5maWx0ZXIobyA9PiBvLnNjb3BlID09PSBcImFjdGl2ZVwiKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlT3ZlcnJpZGVzKGNvbnRlbnQ6IHN0cmluZyk6IE92ZXJyaWRlW10ge1xuICBjb25zdCBvdmVycmlkZXM6IE92ZXJyaWRlW10gPSBbXTtcbiAgY29uc3QgYmxvY2tzID0gY29udGVudC5zcGxpdCgvXiMjIE92ZXJyaWRlOiAvbSkuc2xpY2UoMSk7XG5cbiAgZm9yIChjb25zdCBibG9jayBvZiBibG9ja3MpIHtcbiAgICBjb25zdCBsaW5lcyA9IGJsb2NrLnNwbGl0KFwiXFxuXCIpO1xuICAgIGNvbnN0IHRpbWVzdGFtcCA9IGxpbmVzWzBdPy50cmltKCkgPz8gXCJcIjtcbiAgICBsZXQgY2hhbmdlID0gXCJcIjtcbiAgICBsZXQgc2NvcGU6IFwiYWN0aXZlXCIgfCBcInJlc29sdmVkXCIgPSBcImFjdGl2ZVwiO1xuICAgIGxldCBhcHBsaWVkQXQgPSBcIlwiO1xuXG4gICAgZm9yIChjb25zdCBsaW5lIG9mIGxpbmVzKSB7XG4gICAgICBjb25zdCBjaGFuZ2VNYXRjaCA9IGxpbmUubWF0Y2goL15cXCpcXCpDaGFuZ2U6XFwqXFwqXFxzKiguKykkLyk7XG4gICAgICBpZiAoY2hhbmdlTWF0Y2gpIGNoYW5nZSA9IGNoYW5nZU1hdGNoWzFdLnRyaW0oKTtcbiAgICAgIGNvbnN0IHNjb3BlTWF0Y2ggPSBsaW5lLm1hdGNoKC9eXFwqXFwqU2NvcGU6XFwqXFwqXFxzKiguKykkLyk7XG4gICAgICBpZiAoc2NvcGVNYXRjaCkgc2NvcGUgPSBzY29wZU1hdGNoWzFdLnRyaW0oKSBhcyBcImFjdGl2ZVwiIHwgXCJyZXNvbHZlZFwiO1xuICAgICAgY29uc3QgYXBwbGllZE1hdGNoID0gbGluZS5tYXRjaCgvXlxcKlxcKkFwcGxpZWQtYXQ6XFwqXFwqXFxzKiguKykkLyk7XG4gICAgICBpZiAoYXBwbGllZE1hdGNoKSBhcHBsaWVkQXQgPSBhcHBsaWVkTWF0Y2hbMV0udHJpbSgpO1xuICAgIH1cblxuICAgIGlmIChjaGFuZ2UpIHtcbiAgICAgIG92ZXJyaWRlcy5wdXNoKHsgdGltZXN0YW1wLCBjaGFuZ2UsIHNjb3BlLCBhcHBsaWVkQXQgfSk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIG92ZXJyaWRlcztcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdE92ZXJyaWRlc1NlY3Rpb24ob3ZlcnJpZGVzOiBPdmVycmlkZVtdKTogc3RyaW5nIHtcbiAgaWYgKG92ZXJyaWRlcy5sZW5ndGggPT09IDApIHJldHVybiBcIlwiO1xuXG4gIGNvbnN0IGVudHJpZXMgPSBvdmVycmlkZXMubWFwKChvLCBpKSA9PiBbXG4gICAgYCR7aSArIDF9LiAqKiR7by5jaGFuZ2V9KipgLFxuICAgIGAgICBfSXNzdWVkOiAke28udGltZXN0YW1wfSBkdXJpbmcgJHtvLmFwcGxpZWRBdH1fYCxcbiAgXS5qb2luKFwiXFxuXCIpKS5qb2luKFwiXFxuXCIpO1xuXG4gIHJldHVybiBbXG4gICAgXCIjIyBBY3RpdmUgT3ZlcnJpZGVzIChzdXBlcnNlZGUgcGxhbiBjb250ZW50KVwiLFxuICAgIFwiXCIsXG4gICAgXCJUaGUgZm9sbG93aW5nIG92ZXJyaWRlcyB3ZXJlIGlzc3VlZCBieSB0aGUgdXNlciBhbmQgc3VwZXJzZWRlIGFueSBjb25mbGljdGluZyBjb250ZW50IGluIHBsYW4gZG9jdW1lbnRzIGJlbG93LiBGb2xsb3cgdGhlc2Ugb3ZlcnJpZGVzIGV2ZW4gaWYgdGhleSBjb250cmFkaWN0IHRoZSBpbmxpbmVkIHRhc2sgcGxhbi5cIixcbiAgICBcIlwiLFxuICAgIGVudHJpZXMsXG4gICAgXCJcIixcbiAgXS5qb2luKFwiXFxuXCIpO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZUFsbE92ZXJyaWRlcyhiYXNlUGF0aDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IG92ZXJyaWRlc1BhdGggPSByZXNvbHZlR3NkUm9vdEZpbGUoYmFzZVBhdGgsIFwiT1ZFUlJJREVTXCIpO1xuICBjb25zdCBjb250ZW50ID0gYXdhaXQgbG9hZEZpbGUob3ZlcnJpZGVzUGF0aCk7XG4gIGlmICghY29udGVudCkgcmV0dXJuO1xuICBjb25zdCB1cGRhdGVkID0gY29udGVudC5yZXBsYWNlKC9cXCpcXCpTY29wZTpcXCpcXCogYWN0aXZlL2csIFwiKipTY29wZToqKiByZXNvbHZlZFwiKTtcbiAgYXdhaXQgc2F2ZUZpbGUob3ZlcnJpZGVzUGF0aCwgdXBkYXRlZCk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFLQSxTQUFTLFlBQVksVUFBVTtBQUMvQixTQUFTLGVBQWU7QUFDeEIsU0FBUyx3QkFBd0I7QUFDakMsU0FBUyxzQkFBc0Isa0JBQWtCLDBCQUEwQjtBQUMzRSxTQUEwQix3QkFBd0I7QUFZbEQsU0FBUyw0QkFBNEI7QUFDckMsU0FBUyxzQkFBc0Isd0JBQXdCLDBCQUEwQjtBQUNqRixTQUFTLGlCQUFpQjtBQUMxQixTQUFTLGtCQUFrQiwyQkFBMkI7QUFVdEQsU0FBUyxTQUFTLFNBQXlCO0FBQ3pDLFFBQU0sTUFBTSxRQUFRO0FBQ3BCLFFBQU0sT0FBTyxRQUFRLE1BQU0sR0FBRyxHQUFHO0FBQ2pDLFFBQU0sV0FBVyxLQUFLLElBQUksR0FBRyxLQUFLLE1BQU0sTUFBTSxDQUFDLElBQUksRUFBRTtB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
