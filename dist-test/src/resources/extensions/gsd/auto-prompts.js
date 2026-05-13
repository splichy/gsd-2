import { loadFile, parseContinue, parseSummary, loadActiveOverrides, formatOverridesSection, parseTaskPlanFile } from "./files.js";
import { hasVerdict, getUatType, extractVerdict } from "./verdict-parser.js";
import { loadPrompt, inlineTemplate } from "./prompt-loader.js";
import {
  resolveMilestoneFile,
  resolveSliceFile,
  resolveSlicePath,
  resolveTasksDir,
  resolveTaskFiles,
  resolveTaskFile,
  relMilestoneFile,
  relSliceFile,
  relSlicePath,
  relMilestonePath,
  resolveGsdRootFile,
  relGsdRootFile,
  resolveRuntimeFile
} from "./paths.js";
import { resolveSkillDiscoveryMode, resolveInlineLevel, loadEffectiveGSDPreferences, resolveAllSkillReferences } from "./preferences.js";
import { isContextModeEnabled } from "./preferences-types.js";
import { parseRoadmap } from "./parsers-legacy.js";
import { getLoadedSkills } from "@gsd/pi-coding-agent";
import { join, basename } from "node:path";
import { existsSync } from "node:fs";
import { computeBudgets, resolveExecutorContextWindow, truncateAtSectionBoundary } from "./context-budget.js";
import { getPendingGatesForTurn } from "./gsd-db.js";
import {
  assertGateCoverage,
  getGatesForTurn
} from "./gate-registry.js";
import { formatDecisionsCompact, formatRequirementsCompact } from "./structured-data-formatter.js";
import { readPhaseAnchor, formatAnchorForPrompt } from "./phase-anchor.js";
import { composeContextModeInstructions, composeInlinedContext } from "./unit-context-composer.js";
import { readCompactionSnapshot } from "./compaction-snapshot.js";
import { logWarning } from "./workflow-logger.js";
import { inlineGraphSubgraph } from "./graph-context.js";
import { buildExtractionStepsBlock } from "./commands-extract-learnings.js";
import { resolveSkillManifest, warnIfManifestHasMissingSkills } from "./skill-manifest.js";
import { classifyProject } from "./detection.js";
const MAX_PREAMBLE_CHARS = 2e4;
function resolvePromptBudgets() {
  try {
    const prefs = loadEffectiveGSDPreferences();
    const sessionWindow = prefs?.preferences.context_window_override;
    const windowTokens = resolveExecutorContextWindow(void 0, prefs?.preferences, sessionWindow);
    return computeBudgets(windowTokens);
  } catch (e) {
    logWarning("prompt", `resolvePromptBudgets failed: ${e.message}`);
    return computeBudgets(2e5);
  }
}
function resolveSummaryBudgetChars() {
  return resolvePromptBudgets().summaryBudgetChars;
}
function formatProjectClassificationForPlanning(classification) {
  const sampleFiles = classification.contentFiles.slice(0, 8);
  const sample = sampleFiles.length > 0 ? sampleFiles.map((file) => `\`${file}\``).join(", ") : "(none)";
  const lines = [
    "### Project Classification",
    "",
    `- **Kind:** ${classification.kind}`,
    `- **Content files:** ${classification.contentFiles.length}`,
    `- **Sample files:** ${sample}`,
    `- **Reason:** ${classification.reason}`,
    ""
  ];
  if (classification.kind === "untyped-existing") {
    if (classification.contentFiles.length <= 2) {
      lines.push(
        "**Workflow sizing:** This is a tiny existing untyped project. Prefer exactly one slice unless the milestone request clearly spans multiple independent user-visible capabilities."
      );
    } else if (classification.contentFiles.length <= 5) {
      lines.push(
        "**Workflow sizing:** This is a small existing untyped project. Prefer 1-2 slices unless the milestone request clearly spans multiple independent user-visible capabilities."
      );
    } else {
      lines.push(
        "**Workflow sizing:** Existing untyped project. Use generic file-level workflow guidance and size slices by real capability boundaries, not by missing tooling markers."
      );
    }
  } else if (classification.kind === "greenfield") {
    lines.push("**Workflow sizing:** No project content exists yet. Use normal greenfield sizing for the requested scope.");
  } else if (classification.kind === "typed-existing") {
    lines.push("**Workflow sizing:** Known project markers exist. Use normal ecosystem-aware planning guidance.");
  } else {
    lines.push("**Workflow sizing:** Invalid repository state. Planning should surface this as a blocker rather than inventing project structure.");
  }
  return lines.join("\n");
}
function normalizeArtifactRef(value) {
  return value.trim().replace(/^[-\s]+/, "").replace(/^["'`]+|["'`]+$/g, "").replaceAll("\\", "/").replace(/^\.\//, "");
}
function parseCoveredArtifacts(validationContent) {
  const covered = /* @__PURE__ */ new Set();
  const lines = validationContent.split(/\r?\n/);
  let inCoveredArtifacts = false;
  for (const line of lines) {
    if (/^\s*covered[-_]?artifacts\s*:/i.test(line)) {
      inCoveredArtifacts = true;
      const inline = line.split(/covered[-_]?artifacts\s*:/i)[1]?.trim();
      if (inline && inline !== "[]") {
        inline.replace(/^\[|\]$/g, "").split(",").map(normalizeArtifactRef).filter(Boolean).forEach((item2) => covered.add(item2));
      }
      continue;
    }
    if (!inCoveredArtifacts) continue;
    if (/^\S/.test(line) && !/^\s*-/.test(line)) break;
    const item = line.match(/^\s*-\s*(.+)$/)?.[1];
    if (item) covered.add(normalizeArtifactRef(item));
  }
  return covered;
}
function isValidationFreshOrApplicable(validationContent, currentArtifacts) {
  if (!validationContent) return false;
  if (!/validation_metadata:/i.test(validationContent)) return false;
  const coveredArtifacts = parseCoveredArtifacts(validationContent);
  if (coveredArtifacts.size === 0) return false;
  return currentArtifacts.map(normalizeArtifactRef).filter(Boolean).every((artifact) => coveredArtifacts.has(artifact));
}
function formatCloseoutReviewInstructions(validationContent, validationRel, currentArtifacts) {
  const verdict = validationContent ? extractVerdict(validationContent) : null;
  const validationFresh = isValidationFreshOrApplicable(validationContent, currentArtifacts);
  if (verdict === "pass" && validationFresh) {
    return [
      "### Passing Validation Artifact",
      "",
      `A passing validation artifact is present at \`${validationRel}\`. Treat it as authoritative for success criteria, requirement coverage, verification classes, and cross-slice integration.`,
      "",
      "Do not delegate fresh reviewer/security/tester audits and do not redo the validation evidence review unless the artifact is internally inconsistent with the inlined summaries. Focus this unit on final milestone narrative, learnings, PROJECT/requirements updates, and `gsd_complete_milestone`."
    ].join("\n");
  }
  if (verdict) {
    return [
      "### Validation Requires Attention",
      "",
      `A validation artifact is present at \`${validationRel}\` with verdict \`${verdict}\`, but it is missing freshness metadata or does not cover current milestone artifacts. Do not treat the milestone as complete unless the issues are resolved and evidence supports completion.`
    ].join("\n");
  }
  return [
    "### No Passing Validation Artifact",
    "",
    `No passing validation artifact was found at \`${validationRel}\`. Use the full closeout review path before completion.`
  ].join("\n");
}
function capPreamble(preamble) {
  const budget = Math.min(MAX_PREAMBLE_CHARS, resolvePromptBudgets().inlineContextBudgetChars);
  if (preamble.length <= budget) return preamble;
  return truncateAtSectionBoundary(preamble, budget).content;
}
function renderContextModeForPrompt(unitType, base, renderMode = "standalone") {
  const effectivePrefs = loadEffectiveGSDPreferences(base)?.preferences;
  return composeContextModeInstructions(unitType, {
    enabled: isContextModeEnabled(effectivePrefs),
    renderMode
  });
}
function renderContextModeBlockForPrompt(unitType, base, renderMode = "standalone") {
  const contextMode = renderContextModeForPrompt(unitType, base, renderMode);
  if (!contextMode) return "";
  if (renderMode === "nested") return contextMode;
  const snapshot = readCompactionSnapshot(base);
  if (!snapshot?.trim()) return contextMode;
  return `${contextMode}

## Context Snapshot
Source: \`.gsd/last-snapshot.md\`

${snapshot.trimEnd()}`;
}
function prependContextModeToBlock(unitType, base, block, renderMode = "standalone") {
  const contextMode = renderContextModeBlockForPrompt(unitType, base, renderMode);
  if (!contextMode) return block;
  if (!block.trim()) return contextMode;
  return `${contextMode}

${block}`;
}
function formatExecutorConstraints(sessionContextWindow, modelRegistry, sessionProvider) {
  let windowTokens;
  try {
    const prefs = loadEffectiveGSDPreferences();
    windowTokens = resolveExecutorContextWindow(modelRegistry, prefs?.preferences, sessionContextWindow, sessionProvider);
  } catch (e) {
    logWarning("prompt", `resolveExecutorContextWindow failed: ${e.message}`);
    windowTokens = resolveExecutorContextWindow(void 0, void 0, sessionContextWindow, sessionProvider);
  }
  const budgets = computeBudgets(windowTokens);
  const { min, max } = budgets.taskCountRange;
  const execWindowK = Math.round(windowTokens / 1e3);
  const perTaskBudgetK = Math.round(budgets.inlineContextBudgetChars / 1e3);
  return [
    `## Executor Context Constraints`,
    ``,
    `The agent that executes each task has a **${execWindowK}K token** context window.`,
    `- Recommended task count for this slice: **${min}\u2013${max} tasks**`,
    `- Each task gets ~${perTaskBudgetK}K chars of inline context (plans, code, decisions)`,
    `- Keep individual tasks completable within a single context window \u2014 if a task needs more context than fits, split it`
  ].join("\n");
}
function buildSourceFilePaths(base, mid, sid) {
  const paths = [];
  const projectPath = resolveGsdRootFile(base, "PROJECT");
  if (existsSync(projectPath)) {
    paths.push(`- **Project**: \`${relGsdRootFile("PROJECT")}\``);
  }
  const requirementsPath = resolveGsdRootFile(base, "REQUIREMENTS");
  if (existsSync(requirementsPath)) {
    paths.push(`- **Requirements**: \`${relGsdRootFile("REQUIREMENTS")}\``);
  }
  const decisionsPath = resolveGsdRootFile(base, "DECISIONS");
  if (existsSync(decisionsPath)) {
    paths.push(`- **Decisions**: \`${relGsdRootFile("DECISIONS")}\``);
  }
  const queuePath = resolveGsdRootFile(base, "QUEUE");
  if (existsSync(queuePath)) {
    paths.push(`- **Queue**: \`${relGsdRootFile("QUEUE")}\``);
  }
  const contextPath = resolveMilestoneFile(base, mid, "CONTEXT");
  if (contextPath) {
    paths.push(`- **Milestone Context**: \`${relMilestoneFile(base, mid, "CONTEXT")}\``);
  }
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  if (roadmapPath) {
    paths.push(`- **Roadmap**: \`${relMilestoneFile(base, mid, "ROADMAP")}\``);
  }
  if (sid) {
    const researchPath = resolveSliceFile(base, mid, sid, "RESEARCH");
    if (researchPath) {
      paths.push(`- **Slice Research**: \`${relSliceFile(base, mid, sid, "RESEARCH")}\``);
    }
  } else {
    const researchPath = resolveMilestoneFile(base, mid, "RESEARCH");
    if (researchPath) {
      paths.push(`- **Milestone Research**: \`${relMilestoneFile(base, mid, "RESEARCH")}\``);
    }
  }
  return paths.length > 0 ? paths.join("\n") : "- Use the Grep/Glob/Read tools to identify the relevant source files before planning.";
}
async function inlineFile(absPath, relPath, label) {
  const content = absPath ? await loadFile(absPath) : null;
  if (!content) {
    return `### ${label}
Source: \`${relPath}\`

_(not found \u2014 file does not exist yet)_`;
  }
  return `### ${label}
Source: \`${relPath}\`

${content.trim()}`;
}
async function inlineFileOptional(absPath, relPath, label) {
  const content = absPath ? await loadFile(absPath) : null;
  if (!content) return null;
  return `### ${label}
Source: \`${relPath}\`

${content.trim()}`;
}
async function inlineFileSmart(absPath, relPath, label, query, threshold = 3e3) {
  const content = absPath ? await loadFile(absPath) : null;
  if (!content) {
    return `### ${label}
Source: \`${relPath}\`

_(not found \u2014 file does not exist yet)_`;
  }
  if (content.length <= threshold || !query) {
    return `### ${label}
Source: \`${relPath}\`

${content.trim()}`;
  }
  const truncated = truncateAtSectionBoundary(content, threshold).content;
  return `### ${label}
Source: \`${relPath}\`

${truncated}`;
}
function inlineCompactTemplate(name, label) {
  const compact = {
    plan: [
      "# {{sliceId}}: {{sliceTitle}}",
      "",
      "**Goal:** {{goal}}",
      "**Demo:** {{demo}}",
      "",
      "## Must-Haves",
      "- {{mustHave}}",
      "",
      "## Threat Surface",
      "- Abuse: {{abuseScenarios}}",
      "- Data exposure: {{sensitiveDataAccessible}}",
      "- Input trust: {{untrustedInput}}",
      "",
      "## Requirement Impact",
      "- Requirements touched: {{requirementIds}}",
      "- Re-verify: {{whatMustBeRetested}}",
      "- Decisions revisited: {{decisionIds}}",
      "",
      "## Proof Level",
      "- This slice proves: {{contract | integration | operational | final-assembly}}",
      "- Real runtime required: {{yes/no}}",
      "- Human/UAT required: {{yes/no}}",
      "",
      "## Verification",
      "- {{testFileOrCommand}}",
      "",
      "## Observability / Diagnostics",
      "- Runtime signals: {{signalOrNone}}",
      "- Inspection surfaces: {{surfaceOrNone}}",
      "- Failure visibility: {{failureSignalOrNone}}",
      "- Redaction constraints: {{secretOrPiiBoundaryOrNone}}",
      "",
      "## Integration Closure",
      "- Upstream surfaces consumed: {{filesModulesContracts}}",
      "- New wiring introduced: {{entrypointOrNone}}",
      "- Remaining end-to-end work: {{listOrNothing}}",
      "",
      "## Tasks",
      "- [ ] **T01: {{taskTitle}}** `est:{{estimate}}`",
      "  - Why: {{whyThisTaskExists}}",
      "  - Files: `{{filePath}}`",
      "  - Do: {{specificImplementationStepsAndConstraints}}",
      "  - Verify: {{testCommandOrRuntimeCheck}}",
      "  - Done when: {{measurableAcceptanceCondition}}",
      "",
      "## Files Likely Touched",
      "- `{{filePath}}`"
    ].join("\n"),
    "task-summary": [
      "---",
      "id: {{taskId}}",
      "parent: {{sliceId}}",
      "milestone: {{milestoneId}}",
      "provides: [{{whatThisTaskProvides}}]",
      "key_files: [{{filePath}}]",
      "key_decisions: [{{decision}}]",
      "patterns_established: [{{pattern}}]",
      "observability_surfaces: [{{diagnosticOrNone}}]",
      "duration: {{duration}}",
      "verification_result: passed",
      "completed_at: {{date}}",
      "blocker_discovered: false",
      "---",
      "",
      "# {{taskId}}: {{taskTitle}}",
      "**{{oneLiner}}**",
      "",
      "## What Happened",
      "{{narrative}}",
      "",
      "## Verification",
      "{{whatWasVerifiedAndHow}}",
      "",
      "## Verification Evidence",
      "| # | Command | Exit Code | Verdict | Duration |",
      "|---|---------|-----------|---------|----------|",
      "| {{row}} | {{command}} | {{exitCode}} | {{verdict}} | {{duration}} |",
      "",
      "## Diagnostics",
      "{{diagnosticsOrNone}}",
      "",
      "## Deviations",
      "{{deviationsFromPlan_OR_none}}",
      "",
      "## Known Issues",
      "{{issuesDiscoveredButNotFixed_OR_none}}",
      "",
      "## Files Created/Modified",
      "- `{{filePath}}` - {{description}}"
    ].join("\n"),
    "slice-summary": [
      "---",
      "id: {{sliceId}}",
      "parent: {{milestoneId}}",
      "milestone: {{milestoneId}}",
      "provides: [{{whatThisSliceProvides}}]",
      "requires: []",
      "affects: []",
      "key_files: [{{filePath}}]",
      "key_decisions: [{{decision}}]",
      "patterns_established: [{{pattern}}]",
      "observability_surfaces: [{{diagnosticOrNone}}]",
      "drill_down_paths: [{{pathToTaskSummary}}]",
      "duration: {{duration}}",
      "verification_result: passed",
      "completed_at: {{date}}",
      "---",
      "",
      "# {{sliceId}}: {{sliceTitle}}",
      "**{{oneLiner}}**",
      "",
      "## What Happened",
      "{{narrative}}",
      "",
      "## Verification",
      "{{whatWasVerifiedAcrossAllTasks}}",
      "",
      "## Requirements Advanced",
      "- {{requirementId}} - {{howThisSliceAdvancedIt}}",
      "",
      "## Requirements Validated",
      "- {{requirementId}} - {{whatProofNowMakesItValidated}}",
      "",
      "## New Requirements Surfaced",
      "- {{newRequirementOr_none}}",
      "",
      "## Requirements Invalidated or Re-scoped",
      "- {{requirementIdOr_none}} - {{whatChanged}}",
      "",
      "## Operational Readiness",
      "- Health signal: {{healthSignalOrNA}}",
      "- Failure signal: {{failureSignalOrNA}}",
      "- Recovery: {{recoveryOrNA}}",
      "- Monitoring gaps: {{gapsOrNone}}",
      "",
      "## Deviations",
      "{{deviationsFromPlan_OR_none}}",
      "",
      "## Known Limitations",
      "{{whatDoesntWorkYet_OR_whatWasDeferredToLaterSlices}}",
      "",
      "## Follow-ups",
      "{{workDeferredOrDiscoveredDuringExecution_OR_none}}",
      "",
      "## Files Created/Modified",
      "- `{{filePath}}` - {{description}}",
      "",
      "## Forward Intelligence",
      "### What the next slice should know",
      "- {{insightThatWouldHelpDownstreamWork}}",
      "### What's fragile",
      "- {{fragileAreaOrThinImplementation}} - {{whyItMatters}}",
      "### Authoritative diagnostics",
      "- {{whereAFutureAgentShouldLookFirst}} - {{whyThisSignalIsTrustworthy}}",
      "### What assumptions changed",
      "- {{originalAssumption}} - {{whatActuallyHappened}}"
    ].join("\n")
  };
  return `${compact[name]}

### Output Template: ${label}
Source: \`templates/${name}.md\``;
}
async function buildSliceSummaryExcerpt(absPath, relPath, sid) {
  const header = `### ${sid} Summary (excerpt)
Source: \`${relPath}\``;
  const content = absPath ? await loadFile(absPath) : null;
  if (!content) {
    return `${header}

_(not found \u2014 file does not exist yet)_`;
  }
  try {
    const s = parseSummary(content);
    if (!s.frontmatter.id) {
      return `### ${sid} Summary
Source: \`${relPath}\`

${content.trim()}`;
    }
    const lines = [header, ""];
    if (s.title) lines.push(`**Title:** ${s.title}`);
    if (s.oneLiner) lines.push(`**One-liner:** ${s.oneLiner}`);
    if (s.frontmatter.verification_result) {
      lines.push(`**Verification:** \`${s.frontmatter.verification_result}\``);
    }
    lines.push(`**Blockers:** ${s.frontmatter.blocker_discovered ? "\u26A0\uFE0F blocker recorded \u2014 Read full summary" : "none"}`);
    if (s.frontmatter.duration) lines.push(`**Duration:** ${s.frontmatter.duration}`);
    if (s.frontmatter.provides.length > 0) lines.push(`**Provides:** ${s.frontmatter.provides.join("; ")}`);
    if (s.frontmatter.affects.length > 0) lines.push(`**Affects:** ${s.frontmatter.affects.join("; ")}`);
    if (s.frontmatter.key_decisions.length > 0) lines.push(`**Key decisions:** ${s.frontmatter.key_decisions.join("; ")}`);
    if (s.frontmatter.patterns_established.length > 0) lines.push(`**Patterns established:** ${s.frontmatter.patterns_established.join("; ")}`);
    if (s.frontmatter.key_files.length > 0) {
      const files = s.frontmatter.key_files.slice(0, 8);
      const more = s.frontmatter.key_files.length > files.length ? ` (+${s.frontmatter.key_files.length - files.length} more)` : "";
      lines.push(`**Key files:** ${files.join(", ")}${more}`);
    }
    const SECTION_CAP_CHARS = 800;
    const capSection = (body) => {
      const trimmed = body.trim();
      if (trimmed.length <= SECTION_CAP_CHARS) return trimmed;
      return `${trimmed.slice(0, SECTION_CAP_CHARS)}
\u2026 (truncated \u2014 see full \`${relPath}\`)`;
    };
    if (s.deviations && s.deviations.trim()) {
      lines.push("", "#### Deviations", capSection(s.deviations));
    }
    if (s.knownLimitations && s.knownLimitations.trim()) {
      lines.push("", "#### Known limitations", capSection(s.knownLimitations));
    }
    if (s.followUps && s.followUps.trim()) {
      lines.push("", "#### Follow-ups", capSection(s.followUps));
    }
    lines.push(
      "",
      `> **On-demand:** read \`${relPath}\` for the full "What Happened" narrative, integration notes, and detailed file-change list when drafting LEARNINGS, the Decision Re-evaluation table, or cross-slice synthesis.`
    );
    return lines.join("\n");
  } catch {
    return `### ${sid} Summary
Source: \`${relPath}\`

${capMalformedSummary(content, relPath)}`;
  }
}
async function buildTaskSummaryExcerpt(absPath, relPath, tid, options) {
  const label = options?.blocker ? "Blocker Task Summary" : "Task Summary";
  const header = `### ${label}: ${tid} (excerpt)
Source: \`${relPath}\``;
  const content = absPath ? await loadFile(absPath) : null;
  if (!content) {
    return `${header}

_(not found \u2014 file does not exist yet)_`;
  }
  try {
    const s = parseSummary(content);
    if (!s.frontmatter.id) {
      return `### ${label}: ${tid}
Source: \`${relPath}\`

${capMalformedSummary(content, relPath)}`;
    }
    const lines = [header, ""];
    if (s.title) lines.push(`**Title:** ${s.title}`);
    if (s.oneLiner) lines.push(`**One-liner:** ${s.oneLiner}`);
    if (s.frontmatter.verification_result) {
      lines.push(`**Verification:** \`${s.frontmatter.verification_result}\``);
    }
    lines.push(`**Blocker discovered:** ${s.frontmatter.blocker_discovered ? "yes \u2014 read full summary if blocker details are insufficient" : "no"}`);
    if (s.frontmatter.provides.length > 0) lines.push(`**Provides:** ${s.frontmatter.provides.slice(0, 4).join("; ")}`);
    if (s.frontmatter.key_decisions.length > 0) lines.push(`**Key decisions:** ${s.frontmatter.key_decisions.slice(0, 4).join("; ")}`);
    if (s.frontmatter.patterns_established.length > 0) lines.push(`**Patterns established:** ${s.frontmatter.patterns_established.slice(0, 4).join("; ")}`);
    if (s.frontmatter.key_files.length > 0) {
      const files = s.frontmatter.key_files.slice(0, 6);
      const more = s.frontmatter.key_files.length > files.length ? ` (+${s.frontmatter.key_files.length - files.length} more)` : "";
      lines.push(`**Key files:** ${files.join(", ")}${more}`);
    }
    const SECTION_CAP_CHARS = 500;
    const capSection = (body) => {
      const trimmed = body.trim();
      if (trimmed.length <= SECTION_CAP_CHARS) return trimmed;
      return `${trimmed.slice(0, SECTION_CAP_CHARS)}
\u2026 (truncated \u2014 see full \`${relPath}\`)`;
    };
    const verification = extractMarkdownSection(content, "Verification");
    const diagnostics = extractMarkdownSection(content, "Diagnostics");
    const knownIssues = extractMarkdownSection(content, "Known Issues");
    if (verification && verification.trim()) {
      lines.push("", "#### Verification", capSection(verification));
    }
    if (diagnostics && diagnostics.trim()) {
      lines.push("", "#### Diagnostics", capSection(diagnostics));
    }
    if (s.deviations && s.deviations.trim()) {
      lines.push("", "#### Deviations", capSection(s.deviations));
    }
    if (knownIssues && knownIssues.trim()) {
      lines.push("", "#### Known issues", capSection(knownIssues));
    }
    lines.push(
      "",
      `> **On-demand:** read \`${relPath}\` only when this excerpt is absent/truncated or you need fuller blocker, implementation, or file-change evidence.`
    );
    return lines.join("\n");
  } catch {
    return `### ${label}: ${tid}
Source: \`${relPath}\`

${capMalformedSummary(content, relPath)}`;
  }
}
function capMalformedSummary(content, relPath) {
  const trimmed = content.trim();
  const limit = 1500;
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit).trimEnd()}

[Truncated malformed summary \u2014 read \`${relPath}\` for full details.]`;
}
async function inlineDependencySummaries(mid, sid, base, budgetChars) {
  let depends = null;
  try {
    const { isDbAvailable, getSlice } = await import("./gsd-db.js");
    if (isDbAvailable()) {
      const slice = getSlice(mid, sid);
      if (slice) {
        if (slice.depends.length === 0) return "- (no dependencies)";
        depends = slice.depends;
      }
    }
  } catch (err) {
    logWarning("prompt", `inlineDependencySummaries DB lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!depends) {
    const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
    if (roadmapPath) {
      const roadmapContent = await loadFile(roadmapPath);
      if (roadmapContent) {
        const parsed = parseRoadmap(roadmapContent);
        const slice = parsed.slices.find((s) => s.id === sid);
        if (slice && slice.depends.length > 0) {
          depends = slice.depends;
        }
      }
    }
    if (!depends) {
      return "- (no dependencies)";
    }
  }
  const sections = [];
  const seen = /* @__PURE__ */ new Set();
  for (const dep of depends) {
    if (seen.has(dep)) continue;
    seen.add(dep);
    const summaryFile = resolveSliceFile(base, mid, dep, "SUMMARY");
    const summaryContent = summaryFile ? await loadFile(summaryFile) : null;
    const relPath = relSliceFile(base, mid, dep, "SUMMARY");
    if (summaryContent) {
      sections.push(`#### ${dep} Summary
Source: \`${relPath}\`

${summaryContent.trim()}`);
    } else {
      sections.push(`- \`${relPath}\` _(not found)_`);
    }
  }
  const result = sections.join("\n\n");
  if (budgetChars !== void 0 && result.length > budgetChars) {
    return truncateAtSectionBoundary(result, budgetChars).content;
  }
  return result;
}
async function inlineGsdRootFile(base, filename, label) {
  const key = filename.replace(/\.md$/i, "").toUpperCase();
  const absPath = resolveGsdRootFile(base, key);
  if (!existsSync(absPath)) return null;
  return inlineFileOptional(absPath, relGsdRootFile(key), label);
}
async function inlineDecisionsFromDb(base, milestoneId, scope, level) {
  const inlineLevel = level ?? resolveInlineLevel();
  try {
    const { isDbAvailable } = await import("./gsd-db.js");
    if (isDbAvailable()) {
      const { queryDecisionsFromMemories, formatDecisionsForPrompt } = await import("./context-store.js");
      let decisions = queryDecisionsFromMemories({ milestoneId, scope });
      if (decisions.length === 0 && scope) {
        decisions = queryDecisionsFromMemories({ milestoneId });
      }
      if (decisions.length > 0) {
        const formatted = inlineLevel !== "full" ? formatDecisionsCompact(decisions) : formatDecisionsForPrompt(decisions);
        return `### Decisions
Source: \`.gsd/DECISIONS.md\`

${formatted}`;
      }
      return null;
    }
  } catch (err) {
    logWarning("prompt", `inlineDecisionsFromDb failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return inlineGsdRootFile(base, "decisions.md", "Decisions");
}
async function inlineRequirementsFromDb(base, milestoneId, sliceId, level) {
  const inlineLevel = level ?? resolveInlineLevel();
  try {
    const { isDbAvailable } = await import("./gsd-db.js");
    if (isDbAvailable()) {
      const { queryRequirements, formatRequirementsForPrompt } = await import("./context-store.js");
      const requirements = queryRequirements({ milestoneId, sliceId });
      if (requirements.length > 0) {
        const formatted = inlineLevel !== "full" ? formatRequirementsCompact(requirements) : formatRequirementsForPrompt(requirements);
        return `### Requirements
Source: \`.gsd/REQUIREMENTS.md\`

${formatted}`;
      }
    }
  } catch (err) {
    logWarning("prompt", `inlineRequirementsFromDb failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return inlineGsdRootFile(base, "requirements.md", "Requirements");
}
async function inlineProjectFromDb(base) {
  try {
    const { isDbAvailable } = await import("./gsd-db.js");
    if (isDbAvailable()) {
      const { queryProject } = await import("./context-store.js");
      const content = queryProject();
      if (content) {
        return `### Project
Source: \`.gsd/PROJECT.md\`

${content}`;
      }
    }
  } catch (err) {
    logWarning("prompt", `inlineProjectFromDb failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return inlineGsdRootFile(base, "project.md", "Project");
}
const STOPWORDS = /* @__PURE__ */ new Set(["of", "the", "and", "a", "for", "+", "-", "to", "in", "on", "with", "is", "as", "by"]);
const GENERIC_WORDS = /* @__PURE__ */ new Set([
  "setup",
  "integration",
  "implementation",
  "testing",
  "test",
  "tests",
  "config",
  "configuration",
  "init",
  "initial",
  "basic",
  "core",
  "main",
  "primary",
  "final",
  "complete",
  "finish",
  "end",
  "start",
  "begin",
  "first",
  "last",
  "update",
  "updates",
  "fix",
  "fixes",
  "add",
  "adds",
  "remove",
  "removes",
  "create",
  "creates",
  "build",
  "builds",
  "deploy",
  "deployment",
  "refactor",
  "refactoring",
  "cleanup",
  "polish",
  "review",
  // Process/activity words that describe what you're doing, not what domain
  "hardening",
  "validation",
  "verification",
  "optimization",
  "improvement",
  "enhancement",
  "infrastructure"
]);
const UNIT_ID_PATTERN = /^[smt]\d+$/i;
function deriveSliceScope(sliceTitle, sliceDescription) {
  const combinedText = sliceDescription ? `${sliceTitle} ${sliceDescription}` : sliceTitle;
  const words = combinedText.split(/[\s&+,;:|/\\()-]+/).map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, "")).filter((w) => w.length >= 2);
  for (const word of words) {
    if (STOPWORDS.has(word)) continue;
    if (GENERIC_WORDS.has(word)) continue;
    if (UNIT_ID_PATTERN.test(word)) continue;
    if (word.length < 3) continue;
    return word;
  }
  return void 0;
}
function extractKeywords(title) {
  return title.split(/\s+/).map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, "")).filter((w) => w.length > 0 && !STOPWORDS.has(w));
}
async function inlineKnowledgeScoped(base, keywords) {
  const knowledgePath = resolveGsdRootFile(base, "KNOWLEDGE");
  if (!existsSync(knowledgePath)) return null;
  const content = await loadFile(knowledgePath);
  if (!content) return null;
  const { queryKnowledge } = await import("./context-store.js");
  const scoped = await queryKnowledge(content, keywords);
  if (!scoped) return null;
  return `### Project Knowledge (scoped)
Source: \`${relGsdRootFile("KNOWLEDGE")}\`

${scoped.trim()}`;
}
async function inlineKnowledgeBudgeted(base, keywords, options) {
  const DEFAULT_MAX_CHARS = 12e3;
  const HARD_MAX_CHARS = 1e5;
  const raw = Number(options?.maxChars ?? DEFAULT_MAX_CHARS);
  const maxChars = Number.isFinite(raw) ? Math.max(0, Math.min(Math.floor(raw), HARD_MAX_CHARS)) : DEFAULT_MAX_CHARS;
  const knowledgePath = resolveGsdRootFile(base, "KNOWLEDGE");
  if (!existsSync(knowledgePath)) return null;
  const content = await loadFile(knowledgePath);
  if (!content) return null;
  const { queryKnowledge } = await import("./context-store.js");
  const scoped = await queryKnowledge(content, keywords);
  if (!scoped) return null;
  const trimmed = scoped.trim();
  const truncated = trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}

[...truncated ${trimmed.length - maxChars} chars; rerun with narrower scope if needed]` : trimmed;
  return `### Project Knowledge (scoped)
Source: \`${relGsdRootFile("KNOWLEDGE")}\`

${truncated}`;
}
async function inlineRoadmapExcerpt(base, mid, sid) {
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  if (!roadmapPath || !existsSync(roadmapPath)) return null;
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");
  const content = await loadFile(roadmapPath);
  if (!content) return null;
  const { formatRoadmapExcerpt } = await import("./context-store.js");
  const excerpt = formatRoadmapExcerpt(content, sid, roadmapRel);
  if (!excerpt) return null;
  return `### Milestone Roadmap (excerpt)
Source: \`${roadmapRel}\`

${excerpt}`;
}
function normalizeSkillReference(ref) {
  const normalized = ref.replace(/\\/g, "/").trim();
  const base = basename(normalized).replace(/\.md$/i, "");
  const name = /^SKILL$/i.test(base) ? basename(normalized.replace(/\/SKILL(?:\.md)?$/i, "")) : base;
  return name.trim().toLowerCase();
}
function tokenizeSkillContext(...parts) {
  const tokens = /* @__PURE__ */ new Set();
  const addVariants = (raw) => {
    const value = raw.trim().toLowerCase();
    if (!value || value.length < 2) return;
    tokens.add(value);
    tokens.add(value.replace(/[-_]+/g, " "));
    tokens.add(value.replace(/\s+/g, "-"));
    tokens.add(value.replace(/\s+/g, ""));
  };
  for (const part of parts) {
    if (!part) continue;
    const text = part.toLowerCase();
    const phraseMatches = text.match(/[a-z0-9][a-z0-9+.#/_-]{1,}/g) ?? [];
    for (const match of phraseMatches) {
      addVariants(match);
      for (const piece of match.split(/[^a-z0-9+.#]+/g)) {
        if (piece.length >= 3) addVariants(piece);
      }
    }
  }
  return tokens;
}
function skillMatchesContext(skill, contextTokens) {
  const haystacks = [
    skill.name.toLowerCase(),
    skill.name.toLowerCase().replace(/[-_]+/g, " "),
    skill.description.toLowerCase()
  ];
  return [...contextTokens].some(
    (token) => token.length >= 3 && haystacks.some((haystack) => haystack.includes(token))
  );
}
function resolvePreferenceSkillNames(refs, base) {
  if (refs.length === 0) return [];
  const prefs = { always_use_skills: refs };
  const report = resolveAllSkillReferences(prefs, base);
  return refs.map((ref) => {
    const resolution = report.resolutions.get(ref);
    return normalizeSkillReference(resolution?.resolvedPath ?? ref);
  }).filter(Boolean);
}
function ruleMatchesContext(when, contextTokens) {
  const whenTokens = tokenizeSkillContext(when);
  return [...whenTokens].some(
    (token) => contextTokens.has(token) || [...contextTokens].some((ctx) => ctx.includes(token) || token.includes(ctx))
  );
}
function resolveSkillRuleMatches(prefs, contextTokens, base) {
  if (!prefs?.skill_rules?.length) return { include: [], avoid: [] };
  const include = [];
  const avoid = [];
  for (const rule of prefs.skill_rules) {
    if (!ruleMatchesContext(rule.when, contextTokens)) continue;
    include.push(...resolvePreferenceSkillNames([...rule.use ?? [], ...rule.prefer ?? []], base));
    avoid.push(...resolvePreferenceSkillNames(rule.avoid ?? [], base));
  }
  return { include, avoid };
}
function resolvePreferredSkillNames(prefs, visibleSkills, contextTokens, base) {
  if (!prefs?.prefer_skills?.length) return [];
  const preferred = new Set(resolvePreferenceSkillNames(prefs.prefer_skills, base));
  return visibleSkills.filter((skill) => preferred.has(normalizeSkillReference(skill.name)) && skillMatchesContext(skill, contextTokens)).map((skill) => normalizeSkillReference(skill.name));
}
const SAFE_SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;
function formatSkillActivationBlock(skillNames) {
  const safe = skillNames.filter((name) => SAFE_SKILL_NAME.test(name));
  if (safe.length === 0) return "";
  const calls = safe.map((name) => `Call Skill({ skill: '${name}' })`).join(". ");
  return `<skill_activation>${calls}.</skill_activation>`;
}
function formatSkillRecommendationsBlock(unitType, skillNames) {
  if (!unitType) return "";
  const safe = skillNames.filter((name) => SAFE_SKILL_NAME.test(name));
  if (safe.length === 0) return "";
  return `<skill_recommendations unit="${unitType}">For this unit type, also consider invoking: ${safe.join(", ")}. Use Skill({ skill: 'name' }) when relevant \u2014 these are recommendations, not requirements.</skill_recommendations>`;
}
function buildSkillActivationBlock(params) {
  const prefs = params.preferences ?? loadEffectiveGSDPreferences(params.base)?.preferences;
  const contextTokens = tokenizeSkillContext(
    params.milestoneId,
    params.milestoneTitle,
    params.sliceId,
    params.sliceTitle,
    params.taskId,
    params.taskTitle
  );
  const loaded = (typeof getLoadedSkills === "function" ? getLoadedSkills() : []).filter((skill) => !skill.disableModelInvocation);
  const visibleSkills = loaded;
  const installedNames = new Set(visibleSkills.map((skill) => normalizeSkillReference(skill.name)));
  warnIfManifestHasMissingSkills(params.unitType, installedNames);
  const avoided = new Set(resolvePreferenceSkillNames(prefs?.avoid_skills ?? [], params.base));
  const matched = /* @__PURE__ */ new Set();
  for (const name of resolvePreferenceSkillNames(prefs?.always_use_skills ?? [], params.base)) {
    matched.add(name);
  }
  const ruleMatches = resolveSkillRuleMatches(prefs, contextTokens, params.base);
  for (const name of ruleMatches.include) matched.add(name);
  for (const name of ruleMatches.avoid) avoided.add(name);
  for (const name of resolvePreferredSkillNames(prefs, visibleSkills, contextTokens, params.base)) {
    matched.add(name);
  }
  if (params.taskPlanContent) {
    try {
      const taskPlan = parseTaskPlanFile(params.taskPlanContent);
      for (const skillName of taskPlan.frontmatter.skills_used) {
        matched.add(normalizeSkillReference(skillName));
      }
    } catch (err) {
      logWarning("prompt", `parseTaskPlanFile failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if ((prefs?.skill_discovery ?? "suggest") === "auto") {
    const manifestAllow = resolveSkillManifest(params.unitType);
    const allowSet = manifestAllow ? new Set(manifestAllow) : null;
    for (const skill of visibleSkills) {
      const normalized = normalizeSkillReference(skill.name);
      if (matched.has(normalized) || avoided.has(normalized)) continue;
      if (allowSet && !allowSet.has(normalized)) continue;
      if (skillMatchesContext(skill, contextTokens)) {
        matched.add(normalized);
      }
    }
  }
  const ordered = [...matched].filter((name) => installedNames.has(name) && !avoided.has(name)).sort();
  const activationBlock = formatSkillActivationBlock(ordered);
  const matchedSet = new Set(ordered);
  const manifestList = resolveSkillManifest(params.unitType);
  const recommendations = (manifestList ?? []).filter((name) => installedNames.has(name) && !avoided.has(name) && !matchedSet.has(name)).sort();
  const recommendationsBlock = formatSkillRecommendationsBlock(params.unitType, recommendations);
  if (!activationBlock && !recommendationsBlock) return "";
  if (!activationBlock) return recommendationsBlock;
  if (!recommendationsBlock) return activationBlock;
  return `${activationBlock}
${recommendationsBlock}`;
}
function buildSkillDiscoveryVars() {
  const mode = resolveSkillDiscoveryMode();
  if (mode === "off") {
    return {
      skillDiscoveryMode: "off",
      skillDiscoveryInstructions: " Skill discovery is disabled. Skip this step."
    };
  }
  const autoInstall = mode === "auto";
  const instructions = `
   Identify the key technologies, frameworks, and services this work depends on (e.g. Stripe, Clerk, Supabase, JUCE, SwiftUI).
   For each, check if a professional agent skill already exists:
   - First check \`<available_skills>\` in your system prompt \u2014 a skill may already be installed.
   - For technologies without an installed skill, run: \`npx skills find "<technology>"\`
   - Only consider skills that are **directly relevant** to core technologies \u2014 not tangentially related.
   - Evaluate results by install count and relevance to the actual work.${autoInstall ? `
   - Install relevant skills: \`npx skills add <owner/repo@skill> -g -y\`
   - Record installed skills in the "Skills Discovered" section of your research output.
   - Installed skills will automatically appear in subsequent units' system prompts \u2014 no manual steps needed.` : `
   - Note promising skills in your research output with their install commands, but do NOT install them.
   - The user will decide which to install.`}`;
  return {
    skillDiscoveryMode: mode,
    skillDiscoveryInstructions: instructions
  };
}
function extractMarkdownSection(content, heading) {
  const match = new RegExp(`^## ${escapeRegExp(heading)}\\s*$`, "m").exec(content);
  if (!match) return null;
  const start = match.index + match[0].length;
  const rest = content.slice(start);
  const nextHeading = rest.match(/^##\s+/m);
  const end = nextHeading?.index ?? rest.length;
  return rest.slice(0, end).trim();
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function oneLine(text) {
  return text.replace(/\s+/g, " ").trim();
}
function buildResumeSection(continueContent, legacyContinueContent, continueRelPath, legacyContinueRelPath) {
  const resolvedContent = continueContent ?? legacyContinueContent;
  const resolvedRelPath = continueContent ? continueRelPath : legacyContinueRelPath;
  if (!resolvedContent || !resolvedRelPath) {
    return ["## Resume State", "- No continue file present. Start from the top of the task plan."].join("\n");
  }
  const cont = parseContinue(resolvedContent);
  const lines = [
    "## Resume State",
    `Source: \`${resolvedRelPath}\``,
    `- Status: ${cont.frontmatter.status || "in_progress"}`
  ];
  if (cont.frontmatter.step && cont.frontmatter.totalSteps) {
    lines.push(`- Progress: step ${cont.frontmatter.step} of ${cont.frontmatter.totalSteps}`);
  }
  if (cont.completedWork) lines.push(`- Completed: ${oneLine(cont.completedWork)}`);
  if (cont.remainingWork) lines.push(`- Remaining: ${oneLine(cont.remainingWork)}`);
  if (cont.decisions) lines.push(`- Decisions: ${oneLine(cont.decisions)}`);
  if (cont.nextAction) lines.push(`- Next action: ${oneLine(cont.nextAction)}`);
  return lines.join("\n");
}
async function buildCarryForwardSection(priorSummaryPaths, base) {
  if (priorSummaryPaths.length === 0) {
    return ["## Carry-Forward Context", "- No prior task summaries in this slice."].join("\n");
  }
  const items = await Promise.all(priorSummaryPaths.map(async (relPath) => {
    const absPath = join(base, relPath);
    const content = await loadFile(absPath);
    if (!content) return `- \`${relPath}\``;
    const summary = parseSummary(content);
    const provided = summary.frontmatter.provides.slice(0, 2).join("; ");
    const decisions = summary.frontmatter.key_decisions.slice(0, 2).join("; ");
    const patterns = summary.frontmatter.patterns_established.slice(0, 2).join("; ");
    const keyFiles = summary.frontmatter.key_files.slice(0, 3).join("; ");
    const diagnostics = extractMarkdownSection(content, "Diagnostics");
    const parts = [summary.title || relPath];
    if (summary.oneLiner) parts.push(summary.oneLiner);
    if (provided) parts.push(`provides: ${provided}`);
    if (decisions) parts.push(`decisions: ${decisions}`);
    if (patterns) parts.push(`patterns: ${patterns}`);
    if (keyFiles) parts.push(`key_files: ${keyFiles}`);
    if (diagnostics) parts.push(`diagnostics: ${oneLine(diagnostics)}`);
    return `- \`${relPath}\` \u2014 ${parts.join(" | ")}`;
  }));
  return ["## Carry-Forward Context", ...items].join("\n");
}
function extractSliceExecutionExcerpt(content, relPath) {
  if (!content) {
    return [
      "## Slice Plan Excerpt",
      `Slice plan not found at dispatch time. Read \`${relPath}\` before running slice-level verification.`
    ].join("\n");
  }
  const lines = content.split("\n");
  const goalLine = lines.find((l) => l.startsWith("**Goal:**"))?.trim();
  const demoLine = lines.find((l) => l.startsWith("**Demo:**"))?.trim();
  const verification = extractMarkdownSection(content, "Verification");
  const observability = extractMarkdownSection(content, "Observability / Diagnostics");
  const parts = ["## Slice Plan Excerpt", `Source: \`${relPath}\``];
  if (goalLine) parts.push(goalLine);
  if (demoLine) parts.push(demoLine);
  if (verification) {
    parts.push("", "### Slice Verification", verification.trim());
  }
  if (observability) {
    parts.push("", "### Slice Observability / Diagnostics", observability.trim());
  }
  return parts.join("\n");
}
async function getPriorTaskSummaryPaths(mid, sid, currentTid, base) {
  const tDir = resolveTasksDir(base, mid, sid);
  if (!tDir) return [];
  const summaryFiles = resolveTaskFiles(tDir, "SUMMARY");
  const currentNum = parseInt(currentTid.replace(/^T/, ""), 10);
  const sRel = relSlicePath(base, mid, sid);
  return summaryFiles.filter((f) => {
    const num = parseInt(f.replace(/^T/, ""), 10);
    return num < currentNum;
  }).map((f) => `${sRel}/tasks/${f}`);
}
async function getDependencyTaskSummaryPaths(mid, sid, currentTid, dependsOn, base) {
  if (dependsOn.length === 0) {
    return getPriorTaskSummaryPaths(mid, sid, currentTid, base);
  }
  const tDir = resolveTasksDir(base, mid, sid);
  if (!tDir) return [];
  const summaryFiles = resolveTaskFiles(tDir, "SUMMARY");
  const sRel = relSlicePath(base, mid, sid);
  const depSet = new Set(dependsOn.map((d) => d.toUpperCase()));
  return summaryFiles.filter((f) => {
    const tid = f.replace(/-SUMMARY\.md$/i, "").toUpperCase();
    return depSet.has(tid);
  }).map((f) => `${sRel}/tasks/${f}`);
}
async function checkNeedsReassessment(base, mid, state) {
  try {
    const { isDbAvailable, getMilestoneSlices } = await import("./gsd-db.js");
    if (isDbAvailable()) {
      const slices = getMilestoneSlices(mid);
      if (slices.length > 0) {
        const completedSliceIds = slices.filter((s) => s.status === "complete").map((s) => s.id);
        const hasIncomplete = slices.some((s) => s.status !== "complete");
        if (completedSliceIds.length === 0 || !hasIncomplete) return null;
        const lastCompleted = completedSliceIds[completedSliceIds.length - 1];
        const assessmentFile = resolveSliceFile(base, mid, lastCompleted, "ASSESSMENT");
        const hasAssessment = !!(assessmentFile && await loadFile(assessmentFile));
        if (hasAssessment) return null;
        const summaryFile = resolveSliceFile(base, mid, lastCompleted, "SUMMARY");
        const hasSummary = !!(summaryFile && await loadFile(summaryFile));
        if (!hasSummary) return null;
        return { sliceId: lastCompleted };
      }
    }
  } catch (err) {
    logWarning("prompt", `checkNeedsReassessment DB lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  if (!roadmapPath) return null;
  const roadmapContent = await loadFile(roadmapPath);
  if (!roadmapContent) return null;
  const parsed = parseRoadmap(roadmapContent);
  const fileCompletedIds = parsed.slices.filter((s) => s.done).map((s) => s.id);
  const fileHasIncomplete = parsed.slices.some((s) => !s.done);
  if (fileCompletedIds.length === 0 || !fileHasIncomplete) return null;
  const lastDone = fileCompletedIds[fileCompletedIds.length - 1];
  const assessFile = resolveSliceFile(base, mid, lastDone, "ASSESSMENT");
  const hasAssess = !!(assessFile && await loadFile(assessFile));
  if (hasAssess) return null;
  const summFile = resolveSliceFile(base, mid, lastDone, "SUMMARY");
  const hasSumm = !!(summFile && await loadFile(summFile));
  if (!hasSumm) return null;
  return { sliceId: lastDone };
}
async function checkNeedsRunUat(base, mid, state, prefs) {
  try {
    const { isDbAvailable, getMilestoneSlices } = await import("./gsd-db.js");
    if (isDbAvailable()) {
      const slices = getMilestoneSlices(mid);
      if (slices.length > 0) {
        const completedSlices = slices.filter((s) => s.status === "complete");
        const incompleteSlices = slices.filter((s) => s.status !== "complete");
        if (completedSlices.length === 0) return null;
        if (incompleteSlices.length === 0) return null;
        if (!prefs?.uat_dispatch) return null;
        const lastCompleted = completedSlices[completedSlices.length - 1];
        const sid = lastCompleted.id;
        const uatFile = resolveSliceFile(base, mid, sid, "UAT");
        if (!uatFile) return null;
        const uatContent = await loadFile(uatFile);
        if (!uatContent) return null;
        if (hasVerdict(uatContent)) return null;
        const assessmentFile = resolveSliceFile(base, mid, sid, "ASSESSMENT");
        if (assessmentFile) {
          const assessmentContent = await loadFile(assessmentFile);
          if (assessmentContent && hasVerdict(assessmentContent)) return null;
        }
        const uatType = getUatType(uatContent);
        return { sliceId: sid, uatType };
      }
    }
  } catch (err) {
    logWarning("prompt", `checkNeedsRunUat DB lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!prefs?.uat_dispatch) return null;
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  if (!roadmapPath) return null;
  const roadmapContent = await loadFile(roadmapPath);
  if (!roadmapContent) return null;
  const parsed = parseRoadmap(roadmapContent);
  const completedFileSlices = parsed.slices.filter((s) => s.done);
  const incompleteFileSlices = parsed.slices.filter((s) => !s.done);
  if (completedFileSlices.length === 0 || incompleteFileSlices.length === 0) return null;
  const lastCompletedFile = completedFileSlices[completedFileSlices.length - 1];
  const uatSid = lastCompletedFile.id;
  const uatFileFb = resolveSliceFile(base, mid, uatSid, "UAT");
  if (!uatFileFb) return null;
  const uatContentFb = await loadFile(uatFileFb);
  if (!uatContentFb) return null;
  if (hasVerdict(uatContentFb)) return null;
  const assessmentFileFb = resolveSliceFile(base, mid, uatSid, "ASSESSMENT");
  if (assessmentFileFb) {
    const assessmentContentFb = await loadFile(assessmentFileFb);
    if (assessmentContentFb && hasVerdict(assessmentContentFb)) return null;
  }
  const uatTypeFb = getUatType(uatContentFb);
  return { sliceId: uatSid, uatType: uatTypeFb };
}
async function buildDiscussMilestonePrompt(mid, midTitle, base, structuredQuestionsAvailable = "false") {
  const discussTemplates = inlineTemplate("context", "Context");
  const contextModeInstructions = renderContextModeForPrompt("discuss-milestone", base);
  const basePrompt = loadPrompt("guided-discuss-milestone", {
    workingDirectory: base,
    milestoneId: mid,
    milestoneTitle: midTitle,
    inlinedTemplates: discussTemplates,
    structuredQuestionsAvailable,
    commitInstruction: "Do not commit planning artifacts \u2014 .gsd/ is managed externally.",
    fastPathInstruction: ""
  });
  const promptWithContextMode = prependContextModeToBlock("discuss-milestone", base, basePrompt);
  const draftPath = resolveMilestoneFile(base, mid, "CONTEXT-DRAFT");
  const draftContent = draftPath ? await loadFile(draftPath) : null;
  if (draftContent) {
    return `${promptWithContextMode}

## Prior Discussion (Draft Seed)

The following draft was captured from a prior multi-milestone discussion. Use it as seed material \u2014 the user has already provided this context. Start with a brief reflection on what the draft covers, then probe for any gaps or open questions before writing the full CONTEXT.md.

${draftContent}`;
  }
  return contextModeInstructions ? promptWithContextMode : basePrompt;
}
async function buildWorkflowPreferencesPrompt(base, structuredQuestionsAvailable = "false") {
  return prependContextModeToBlock("workflow-preferences", base, loadPrompt("guided-workflow-preferences", {
    workingDirectory: base,
    structuredQuestionsAvailable
  }));
}
async function buildResearchProjectPrompt(base, structuredQuestionsAvailable = "false") {
  return prependContextModeToBlock("research-project", base, loadPrompt("guided-research-project", {
    workingDirectory: base,
    structuredQuestionsAvailable
  }));
}
async function buildResearchDecisionPrompt(base, structuredQuestionsAvailable = "false") {
  return prependContextModeToBlock("research-decision", base, loadPrompt("guided-research-decision", {
    workingDirectory: base,
    structuredQuestionsAvailable
  }));
}
async function buildDiscussProjectPrompt(base, structuredQuestionsAvailable = "false") {
  const inlinedTemplates = inlineTemplate("project", "Project");
  return prependContextModeToBlock("discuss-project", base, loadPrompt("guided-discuss-project", {
    workingDirectory: base,
    inlinedTemplates,
    structuredQuestionsAvailable,
    commitInstruction: "Do not commit planning artifacts \u2014 .gsd/ is managed externally."
  }));
}
async function buildDiscussRequirementsPrompt(base, structuredQuestionsAvailable = "false") {
  const inlinedTemplates = inlineTemplate("requirements", "Requirements");
  return prependContextModeToBlock("discuss-requirements", base, loadPrompt("guided-discuss-requirements", {
    workingDirectory: base,
    inlinedTemplates,
    structuredQuestionsAvailable,
    commitInstruction: "Do not commit planning artifacts \u2014 .gsd/ is managed externally."
  }));
}
async function buildResearchMilestonePrompt(mid, midTitle, base) {
  const resolveArtifact = async (key) => {
    switch (key) {
      case "milestone-context": {
        const p = resolveMilestoneFile(base, mid, "CONTEXT");
        const r = relMilestoneFile(base, mid, "CONTEXT");
        return await inlineFile(p, r, "Milestone Context");
      }
      case "project":
        return await inlineProjectFromDb(base);
      case "requirements":
        return await inlineRequirementsFromDb(base, mid);
      case "decisions":
        return await inlineDecisionsFromDb(base, mid);
      case "templates":
        return inlineTemplate("research", "Research");
      default:
        return null;
    }
  };
  const composed = await composeInlinedContext("research-milestone", resolveArtifact);
  const knowledgeInlineRM = await inlineKnowledgeBudgeted(base, extractKeywords(midTitle));
  const parts = [];
  if (knowledgeInlineRM && composed) {
    const idx = composed.lastIndexOf("### Output Template:");
    if (idx > 0) {
      const before = composed.slice(0, idx).replace(/\n\n---\n\n$/, "");
      const after = composed.slice(idx);
      parts.push(before, knowledgeInlineRM, after);
    } else {
      parts.push(composed, knowledgeInlineRM);
    }
  } else if (composed) {
    parts.push(composed);
    if (knowledgeInlineRM) parts.push(knowledgeInlineRM);
  }
  const inlinedContext = prependContextModeToBlock(
    "research-milestone",
    base,
    capPreamble(`## Inlined Context (preloaded \u2014 do not re-read these files)

${parts.join("\n\n---\n\n")}`)
  );
  const outputRelPath = relMilestoneFile(base, mid, "RESEARCH");
  return loadPrompt("research-milestone", {
    workingDirectory: base,
    milestoneId: mid,
    milestoneTitle: midTitle,
    milestonePath: relMilestonePath(base, mid),
    contextPath: relMilestoneFile(base, mid, "CONTEXT"),
    outputPath: join(base, outputRelPath),
    inlinedContext,
    skillActivation: buildSkillActivationBlock({
      base,
      milestoneId: mid,
      milestoneTitle: midTitle,
      extraContext: [inlinedContext],
      unitType: "research-milestone"
    }),
    ...buildSkillDiscoveryVars()
  });
}
async function buildPlanMilestonePrompt(mid, midTitle, base, level) {
  const inlineLevel = level ?? resolveInlineLevel();
  const contextPath = resolveMilestoneFile(base, mid, "CONTEXT");
  const contextRel = relMilestoneFile(base, mid, "CONTEXT");
  const researchPath = resolveMilestoneFile(base, mid, "RESEARCH");
  const researchRel = relMilestoneFile(base, mid, "RESEARCH");
  const inlined = [];
  const researchAnchor = readPhaseAnchor(base, mid, "research-milestone");
  if (researchAnchor) inlined.push(formatAnchorForPrompt(researchAnchor));
  inlined.push(formatProjectClassificationForPlanning(classifyProject(base)));
  inlined.push(await inlineFile(contextPath, contextRel, "Milestone Context"));
  const researchInline = await inlineFileOptional(researchPath, researchRel, "Milestone Research");
  if (researchInline) inlined.push(researchInline);
  const { inlinePriorMilestoneSummary } = await import("./files.js");
  const priorSummaryInline = await inlinePriorMilestoneSummary(mid, base);
  if (priorSummaryInline) inlined.push(priorSummaryInline);
  if (inlineLevel !== "minimal") {
    const projectInline = await inlineProjectFromDb(base);
    if (projectInline) inlined.push(projectInline);
    const requirementsInline = await inlineRequirementsFromDb(base, mid, void 0, inlineLevel);
    if (requirementsInline) inlined.push(requirementsInline);
    const decisionsInline = await inlineDecisionsFromDb(base, mid, void 0, inlineLevel);
    if (decisionsInline) inlined.push(decisionsInline);
  }
  const queuePath = resolveGsdRootFile(base, "QUEUE");
  if (existsSync(queuePath)) {
    const queueInline = await inlineFileSmart(
      queuePath,
      relGsdRootFile("QUEUE"),
      "Project Queue",
      `${mid} ${midTitle}`
    );
    inlined.push(queueInline);
  }
  const knowledgeInlinePM = await inlineKnowledgeBudgeted(base, extractKeywords(midTitle));
  if (knowledgeInlinePM) inlined.push(knowledgeInlinePM);
  inlined.push(inlineTemplate("roadmap", "Roadmap"));
  if (inlineLevel === "full") {
    inlined.push(inlineTemplate("decisions", "Decisions"));
    inlined.push(inlineTemplate("plan", "Slice Plan"));
    inlined.push(inlineTemplate("task-plan", "Task Plan"));
    inlined.push(inlineTemplate("secrets-manifest", "Secrets Manifest"));
  } else if (inlineLevel === "standard") {
    inlined.push(inlineTemplate("decisions", "Decisions"));
    inlined.push(inlineTemplate("plan", "Slice Plan"));
    inlined.push(inlineTemplate("task-plan", "Task Plan"));
  }
  const inlinedContext = prependContextModeToBlock(
    "plan-milestone",
    base,
    capPreamble(`## Inlined Context (preloaded \u2014 do not re-read these files)

${inlined.join("\n\n---\n\n")}`)
  );
  const outputRelPath = relMilestoneFile(base, mid, "ROADMAP");
  const researchOutputPath = join(base, relMilestoneFile(base, mid, "RESEARCH"));
  const secretsOutputPath = join(base, relMilestoneFile(base, mid, "SECRETS"));
  return loadPrompt("plan-milestone", {
    workingDirectory: base,
    milestoneId: mid,
    milestoneTitle: midTitle,
    milestonePath: relMilestonePath(base, mid),
    contextPath: contextRel,
    researchPath: researchRel,
    researchOutputPath,
    outputPath: join(base, outputRelPath),
    secretsOutputPath,
    inlinedContext,
    sourceFilePaths: buildSourceFilePaths(base, mid),
    skillActivation: buildSkillActivationBlock({
      base,
      milestoneId: mid,
      milestoneTitle: midTitle,
      extraContext: [inlinedContext],
      unitType: "plan-milestone"
    }),
    ...buildSkillDiscoveryVars()
  });
}
async function buildResearchSlicePrompt(mid, _midTitle, sid, sTitle, base, options) {
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");
  const contextPath = resolveMilestoneFile(base, mid, "CONTEXT");
  const contextRel = relMilestoneFile(base, mid, "CONTEXT");
  const milestoneResearchPath = resolveMilestoneFile(base, mid, "RESEARCH");
  const milestoneResearchRel = relMilestoneFile(base, mid, "RESEARCH");
  const sliceContextPath = resolveSliceFile(base, mid, sid, "CONTEXT");
  const sliceContextRel = relSliceFile(base, mid, sid, "CONTEXT");
  const inlined = [];
  const roadmapExcerptRS = await inlineRoadmapExcerpt(base, mid, sid);
  if (roadmapExcerptRS) {
    inlined.push(roadmapExcerptRS);
  } else {
    inlined.push(await inlineFile(roadmapPath, roadmapRel, "Milestone Roadmap"));
  }
  const contextInline = await inlineFileOptional(contextPath, contextRel, "Milestone Context");
  if (contextInline) inlined.push(contextInline);
  const sliceCtxInline = await inlineFileOptional(sliceContextPath, sliceContextRel, "Slice Context (from discussion)");
  if (sliceCtxInline) inlined.push(sliceCtxInline);
  const researchInline = await inlineFileOptional(milestoneResearchPath, milestoneResearchRel, "Milestone Research");
  if (researchInline) inlined.push(researchInline);
  const derivedScope = deriveSliceScope(sTitle);
  const decisionsInline = await inlineDecisionsFromDb(base, mid, derivedScope);
  if (decisionsInline) inlined.push(decisionsInline);
  const requirementsInline = await inlineRequirementsFromDb(base, mid, sid);
  if (requirementsInline) inlined.push(requirementsInline);
  const keywords = extractKeywords(sTitle);
  const knowledgeInlineRS = await inlineKnowledgeScoped(base, keywords);
  if (knowledgeInlineRS) inlined.push(knowledgeInlineRS);
  const graphBlockRS = await inlineGraphSubgraph(base, `${sid} ${sTitle}`, { budget: 3e3 });
  if (graphBlockRS) inlined.push(graphBlockRS);
  inlined.push(inlineTemplate("research", "Research"));
  const depContent = await inlineDependencySummaries(mid, sid, base, resolveSummaryBudgetChars());
  const activeOverrides = await loadActiveOverrides(base);
  const overridesInline = formatOverridesSection(activeOverrides);
  if (overridesInline) inlined.unshift(overridesInline);
  const inlinedContext = prependContextModeToBlock(
    "research-slice",
    base,
    capPreamble(`## Inlined Context (preloaded \u2014 do not re-read these files)

${inlined.join("\n\n---\n\n")}`),
    options?.contextModeRenderMode
  );
  const outputRelPath = relSliceFile(base, mid, sid, "RESEARCH");
  return loadPrompt("research-slice", {
    workingDirectory: base,
    milestoneId: mid,
    sliceId: sid,
    sliceTitle: sTitle,
    slicePath: relSlicePath(base, mid, sid),
    roadmapPath: roadmapRel,
    contextPath: contextRel,
    milestoneResearchPath: milestoneResearchRel,
    outputPath: join(base, outputRelPath),
    inlinedContext,
    dependencySummaries: depContent,
    skillActivation: buildSkillActivationBlock({
      base,
      milestoneId: mid,
      sliceId: sid,
      sliceTitle: sTitle,
      extraContext: [inlinedContext, depContent],
      unitType: "research-slice"
    }),
    ...buildSkillDiscoveryVars()
  });
}
async function renderSlicePrompt(options) {
  const {
    mid,
    sid,
    sTitle,
    base,
    level,
    promptTemplate,
    prependBlocks = [],
    extraVars = {},
    sessionContextWindow,
    modelRegistry,
    sessionProvider
  } = options;
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");
  const researchPath = resolveSliceFile(base, mid, sid, "RESEARCH");
  const researchRel = relSliceFile(base, mid, sid, "RESEARCH");
  const sliceContextPath = resolveSliceFile(base, mid, sid, "CONTEXT");
  const sliceContextRel = relSliceFile(base, mid, sid, "CONTEXT");
  const inlined = [...prependBlocks];
  const researchSliceAnchor = readPhaseAnchor(base, mid, "research-slice");
  if (researchSliceAnchor) inlined.push(formatAnchorForPrompt(researchSliceAnchor));
  const roadmapExcerpt = await inlineRoadmapExcerpt(base, mid, sid);
  if (roadmapExcerpt) {
    inlined.push(roadmapExcerpt);
  } else {
    inlined.push(await inlineFile(roadmapPath, roadmapRel, "Milestone Roadmap"));
  }
  const sliceCtxInline = await inlineFileOptional(sliceContextPath, sliceContextRel, "Slice Context (from discussion)");
  if (sliceCtxInline) inlined.push(sliceCtxInline);
  const researchInline = await inlineFileOptional(researchPath, researchRel, "Slice Research");
  if (researchInline) inlined.push(researchInline);
  if (level !== "minimal") {
    const derivedScope = deriveSliceScope(sTitle);
    const decisionsInline = await inlineDecisionsFromDb(base, mid, derivedScope, level);
    if (decisionsInline) inlined.push(decisionsInline);
    const requirementsInline = await inlineRequirementsFromDb(base, mid, sid, level);
    if (requirementsInline) inlined.push(requirementsInline);
  }
  const knowledgeInline = await inlineKnowledgeScoped(base, extractKeywords(sTitle));
  if (knowledgeInline) inlined.push(knowledgeInline);
  const graphBlock = await inlineGraphSubgraph(base, `${sid} ${sTitle}`, { budget: 3e3 });
  if (graphBlock) inlined.push(graphBlock);
  inlined.push(level === "minimal" ? inlineCompactTemplate("plan", "Slice Plan") : inlineTemplate("plan", "Slice Plan"));
  if (level === "full") {
    inlined.push(inlineTemplate("task-plan", "Task Plan"));
  }
  const depContent = await inlineDependencySummaries(mid, sid, base, resolveSummaryBudgetChars());
  const overridesInline = formatOverridesSection(await loadActiveOverrides(base));
  if (overridesInline) inlined.unshift(overridesInline);
  const inlinedContext = prependContextModeToBlock(
    promptTemplate,
    base,
    capPreamble(`## Inlined Context (preloaded \u2014 do not re-read these files)

${inlined.join("\n\n---\n\n")}`),
    options.contextModeRenderMode
  );
  const executorContextConstraints = formatExecutorConstraints(sessionContextWindow, modelRegistry, sessionProvider);
  const outputRelPath = relSliceFile(base, mid, sid, "PLAN");
  const commitInstruction = "Do not commit \u2014 .gsd/ planning docs are managed externally and not tracked in git.";
  return loadPrompt(promptTemplate, {
    workingDirectory: base,
    milestoneId: mid,
    sliceId: sid,
    sliceTitle: sTitle,
    slicePath: relSlicePath(base, mid, sid),
    roadmapPath: roadmapRel,
    researchPath: researchRel,
    outputPath: join(base, outputRelPath),
    inlinedContext,
    dependencySummaries: depContent,
    sourceFilePaths: buildSourceFilePaths(base, mid, sid),
    executorContextConstraints,
    commitInstruction,
    skillActivation: buildSkillActivationBlock({
      base,
      milestoneId: mid,
      sliceId: sid,
      sliceTitle: sTitle,
      extraContext: [inlinedContext, depContent],
      unitType: promptTemplate
    }),
    ...extraVars
  });
}
async function buildPlanSlicePrompt(mid, _midTitle, sid, sTitle, base, level, options) {
  const prependBlocks = [];
  if (options?.softScopeHint && options.softScopeHint.trim().length > 0) {
    prependBlocks.push(
      `## Prior Sketch Scope (soft hint \u2014 non-binding)

${options.softScopeHint.trim()}

This scope was captured during an earlier progressive-planning pass that was later disabled. Treat it as context only \u2014 you may plan beyond it if the work genuinely requires more scope. Do NOT treat this as a hard boundary.`
    );
  }
  if (options?.priorPreExecFailure) {
    const { blockingFindings, verdictExcerpt } = options.priorPreExecFailure;
    const findingsList = blockingFindings.length > 0 ? blockingFindings.map((f) => `- ${f}`).join("\n") : "- (no specific findings recorded)";
    prependBlocks.push(
      `## Fix these specific issues from the prior pre-exec check

The previous plan-slice attempt was blocked by pre-execution validation.
Gate verdict: ${verdictExcerpt}

Blocked references that must be resolved in this plan:
${findingsList}

**How to fix each type of issue:**
- **"[file] X doesn't exist and isn't created by prior or same-task outputs"**: Either (a) add an earlier task that creates X on disk before the task that needs it, or (b) if this task IS the one that creates X, move X from inputs to expected_output. Do NOT put X in a task's expected_output if that task only reads or verifies X \u2014 only tasks that actually write X to disk should list it in expected_output.
- **"[file] X: Task T_early reads X but it's created by task T_late (sequence violation)"**: Either (a) reorder tasks so T_late (the creator) runs before T_early (the reader), or (b) if T_late doesn't actually create X (it only reads/tests it), remove X from T_late's expected_output entirely.
- **"[package] P not found on npm"**: Either remove the npm install for P, or use the correct package name.

Every file listed in a task's inputs must either exist on disk already or appear in an earlier task's expected_output. A task's expected_output must only list files it actually writes to disk.`
    );
  }
  return renderSlicePrompt({
    mid,
    sid,
    sTitle,
    base,
    level: level ?? resolveInlineLevel(),
    promptTemplate: "plan-slice",
    prependBlocks,
    sessionContextWindow: options?.sessionContextWindow,
    modelRegistry: options?.modelRegistry,
    sessionProvider: options?.sessionProvider
  });
}
async function buildRefineSlicePrompt(mid, _midTitle, sid, sTitle, base, level, options) {
  let sketchScope = "";
  try {
    const { isDbAvailable, getSlice } = await import("./gsd-db.js");
    if (isDbAvailable()) {
      sketchScope = getSlice(mid, sid)?.sketch_scope ?? "";
    }
  } catch {
    sketchScope = "";
  }
  const prependBlocks = [];
  if (sketchScope.trim().length > 0) {
    prependBlocks.push(
      `## Sketch Scope (hard constraint)

${sketchScope.trim()}

Treat this as the authoritative boundary for the slice. Do not plan work outside this scope; if the scope is too narrow, surface it as a deviation rather than expanding silently.`
    );
  }
  return renderSlicePrompt({
    mid,
    sid,
    sTitle,
    base,
    level: level ?? resolveInlineLevel(),
    promptTemplate: "refine-slice",
    prependBlocks,
    extraVars: { sketchScope },
    sessionContextWindow: options?.sessionContextWindow,
    modelRegistry: options?.modelRegistry,
    sessionProvider: options?.sessionProvider
  });
}
async function buildExecuteTaskPrompt(mid, sid, sTitle, tid, tTitle, base, level) {
  const opts = typeof level === "object" && level !== null && !Array.isArray(level) ? level : { level };
  const inlineLevel = opts.level ?? resolveInlineLevel();
  const planAnchor = readPhaseAnchor(base, mid, "plan-slice");
  const priorSummaries = opts.carryForwardPaths ?? await getPriorTaskSummaryPaths(mid, sid, tid, base);
  const priorLines = priorSummaries.length > 0 ? priorSummaries.map((p) => `- \`${p}\``).join("\n") : "- (no prior tasks)";
  const taskPlanPath = resolveTaskFile(base, mid, sid, tid, "PLAN");
  const taskPlanContent = taskPlanPath ? await loadFile(taskPlanPath) : null;
  const taskPlanRelPath = relSlicePath(base, mid, sid) + `/tasks/${tid}-PLAN.md`;
  const taskPlanInline = taskPlanContent ? [
    "## Inlined Task Plan (authoritative local execution contract)",
    `Source: \`${taskPlanRelPath}\``,
    "",
    taskPlanContent.trim()
  ].join("\n") : [
    "## Inlined Task Plan (authoritative local execution contract)",
    `Task plan not found at dispatch time. Read \`${taskPlanRelPath}\` before executing.`
  ].join("\n");
  const slicePlanPath = resolveSliceFile(base, mid, sid, "PLAN");
  const slicePlanContent = slicePlanPath ? await loadFile(slicePlanPath) : null;
  const slicePlanExcerpt = extractSliceExecutionExcerpt(slicePlanContent, relSliceFile(base, mid, sid, "PLAN"));
  const continueFile = resolveSliceFile(base, mid, sid, "CONTINUE");
  const legacyContinueDir = resolveSlicePath(base, mid, sid);
  const legacyContinuePath = legacyContinueDir ? join(legacyContinueDir, "continue.md") : null;
  const continueContent = continueFile ? await loadFile(continueFile) : null;
  const legacyContinueContent = !continueContent && legacyContinuePath ? await loadFile(legacyContinuePath) : null;
  const continueRelPath = relSliceFile(base, mid, sid, "CONTINUE");
  const resumeSection = buildResumeSection(
    continueContent,
    legacyContinueContent,
    continueRelPath,
    legacyContinuePath ? `${relSlicePath(base, mid, sid)}/continue.md` : null
  );
  const effectivePriorSummaries = inlineLevel === "minimal" && priorSummaries.length > 1 ? priorSummaries.slice(-1) : priorSummaries;
  const carryForwardSection = await buildCarryForwardSection(effectivePriorSummaries, base);
  const knowledgeAbsPath = resolveGsdRootFile(base, "KNOWLEDGE");
  const knowledgeInlineET = existsSync(knowledgeAbsPath) ? await inlineFileSmart(
    knowledgeAbsPath,
    relGsdRootFile("KNOWLEDGE"),
    "Project Knowledge",
    `${tTitle} ${sTitle}`
    // use task + slice title as relevance query
  ) : null;
  const knowledgeContent = knowledgeInlineET && !knowledgeInlineET.includes("not found") ? knowledgeInlineET : null;
  const graphBlockET = await inlineGraphSubgraph(base, `${tid} ${tTitle}`, { budget: 2e3 });
  const inlinedTemplates = inlineLevel === "minimal" ? inlineCompactTemplate("task-summary", "Task Summary") : [
    inlineTemplate("task-summary", "Task Summary"),
    inlineTemplate("decisions", "Decisions"),
    ...knowledgeContent ? [knowledgeContent] : [],
    ...graphBlockET ? [graphBlockET] : []
  ].join("\n\n---\n\n");
  const taskSummaryPath = join(base, `${relSlicePath(base, mid, sid)}/tasks/${tid}-SUMMARY.md`);
  const activeOverrides = await loadActiveOverrides(base);
  const overridesSection = formatOverridesSection(activeOverrides);
  const prefs = loadEffectiveGSDPreferences();
  const contextWindow = resolveExecutorContextWindow(opts.modelRegistry, prefs?.preferences, opts.sessionContextWindow, opts.sessionProvider);
  const budgets = computeBudgets(contextWindow);
  const verificationBudget = `~${Math.round(budgets.verificationBudgetChars / 1e3)}K chars`;
  const carryForwardBudget = Math.floor(budgets.inlineContextBudgetChars * 0.4);
  let finalCarryForward = carryForwardSection;
  if (carryForwardSection.length > carryForwardBudget) {
    finalCarryForward = truncateAtSectionBoundary(carryForwardSection, carryForwardBudget).content;
  }
  const runtimePath = resolveRuntimeFile(base);
  const runtimeContent = existsSync(runtimePath) ? await loadFile(runtimePath) : null;
  const runtimeContext = runtimeContent ? `### Runtime Context
Source: \`.gsd/RUNTIME.md\`

${runtimeContent.trim()}` : "";
  let phaseAnchorSection = planAnchor ? formatAnchorForPrompt(planAnchor) : "";
  if (prefs?.preferences?.phases?.mid_execution_escalation === true) {
    try {
      const { claimOverrideForInjection } = await import("./escalation.js");
      const claimed = claimOverrideForInjection(base, mid, sid);
      if (claimed) {
        const block = claimed.injectionBlock + "\n\n---\n\n";
        phaseAnchorSection = phaseAnchorSection ? `${block}${phaseAnchorSection}` : block;
      }
    } catch (escalationErr) {
      logWarning("prompt", `escalation override injection failed: ${escalationErr.message}`);
    }
  }
  const etPending = getPendingGatesForTurn(mid, sid, "execute-task", tid);
  assertGateCoverage(etPending, "execute-task", { requireAll: false });
  const gatesToClose = renderGatesToCloseBlock(
    getGatesForTurn("execute-task"),
    { pending: new Set(etPending.map((g) => g.gate_id)), allowOmit: true }
  );
  phaseAnchorSection = prependContextModeToBlock("execute-task", base, phaseAnchorSection, opts.contextModeRenderMode);
  return loadPrompt("execute-task", {
    overridesSection,
    runtimeContext,
    phaseAnchorSection,
    workingDirectory: base,
    milestoneId: mid,
    sliceId: sid,
    sliceTitle: sTitle,
    taskId: tid,
    taskTitle: tTitle,
    planPath: join(base, relSliceFile(base, mid, sid, "PLAN")),
    slicePath: relSlicePath(base, mid, sid),
    taskPlanPath: taskPlanRelPath,
    taskPlanInline,
    slicePlanExcerpt,
    carryForwardSection: finalCarryForward,
    resumeSection,
    priorTaskLines: priorLines,
    taskSummaryPath,
    inlinedTemplates,
    verificationBudget,
    gatesToClose,
    skillActivation: buildSkillActivationBlock({
      base,
      milestoneId: mid,
      sliceId: sid,
      sliceTitle: sTitle,
      taskId: tid,
      taskTitle: tTitle,
      taskPlanContent,
      extraContext: [taskPlanInline, slicePlanExcerpt, finalCarryForward, resumeSection],
      unitType: "execute-task"
    })
  });
}
async function buildCompleteSlicePrompt(mid, midTitle, sid, sTitle, base, level) {
  const inlineLevel = level ?? resolveInlineLevel();
  const resolveArtifact = async (key) => {
    switch (key) {
      case "roadmap": {
        const p = resolveMilestoneFile(base, mid, "ROADMAP");
        const r = relMilestoneFile(base, mid, "ROADMAP");
        return await inlineFile(p, r, "Milestone Roadmap");
      }
      case "slice-context": {
        const p = resolveSliceFile(base, mid, sid, "CONTEXT");
        const r = relSliceFile(base, mid, sid, "CONTEXT");
        return await inlineFileOptional(p, r, "Slice Context (from discussion)");
      }
      case "slice-plan": {
        const p = resolveSliceFile(base, mid, sid, "PLAN");
        const r = relSliceFile(base, mid, sid, "PLAN");
        return await inlineFile(p, r, "Slice Plan");
      }
      case "requirements":
        if (inlineLevel === "minimal") return null;
        return await inlineRequirementsFromDb(base, mid, sid, inlineLevel);
      case "prior-task-summaries": {
        const tDir = resolveTasksDir(base, mid, sid);
        if (!tDir) return null;
        const summaryFiles = resolveTaskFiles(tDir, "SUMMARY").sort();
        const sRel = relSlicePath(base, mid, sid);
        const blocks = [];
        for (const file of summaryFiles) {
          const absPath = join(tDir, file);
          const relPath = `${sRel}/tasks/${file}`;
          const taskId = file.replace(/-SUMMARY\.md$/i, "");
          blocks.push(await buildTaskSummaryExcerpt(absPath, relPath, taskId));
        }
        return blocks.length > 0 ? blocks.join("\n\n---\n\n") : null;
      }
      case "templates": {
        const parts = [inlineLevel === "minimal" ? inlineCompactTemplate("slice-summary", "Slice Summary") : inlineTemplate("slice-summary", "Slice Summary")];
        if (inlineLevel !== "minimal") {
          parts.push(inlineTemplate("uat", "UAT"));
        }
        return parts.join("\n\n---\n\n");
      }
      default:
        return null;
    }
  };
  const composed = await composeInlinedContext("complete-slice", resolveArtifact);
  const knowledgeInlineCS = await inlineKnowledgeBudgeted(
    base,
    [...extractKeywords(midTitle), ...extractKeywords(sTitle)]
  );
  let body = composed;
  if (knowledgeInlineCS && body) {
    const taskIdx = body.indexOf("### Task Summary:");
    const templatesIdx = body.lastIndexOf("### Output Template: Slice Summary");
    const spliceIdx = taskIdx > -1 ? taskIdx : templatesIdx;
    if (spliceIdx > 0) {
      const before = body.slice(0, spliceIdx).replace(/\n\n---\n\n$/, "");
      const after = body.slice(spliceIdx);
      body = [before, knowledgeInlineCS, after].join("\n\n---\n\n");
    } else {
      body = `${body}

---

${knowledgeInlineCS}`;
    }
  }
  const completeActiveOverrides = await loadActiveOverrides(base);
  const completeOverridesInline = formatOverridesSection(completeActiveOverrides);
  const finalBody = completeOverridesInline ? `${completeOverridesInline}

---

${body}` : body;
  const inlinedContext = prependContextModeToBlock(
    "complete-slice",
    base,
    capPreamble(`## Inlined Context (preloaded \u2014 do not re-read these files)

${finalBody}`)
  );
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");
  const sliceRel = relSlicePath(base, mid, sid);
  const sliceSummaryPath = join(base, `${sliceRel}/${sid}-SUMMARY.md`);
  const sliceUatPath = join(base, `${sliceRel}/${sid}-UAT.md`);
  const csPending = getPendingGatesForTurn(mid, sid, "complete-slice");
  assertGateCoverage(csPending, "complete-slice", { requireAll: false });
  const gatesToClose = renderGatesToCloseBlock(
    getGatesForTurn("complete-slice"),
    { pending: new Set(csPending.map((g) => g.gate_id)), allowOmit: true }
  );
  return loadPrompt("complete-slice", {
    workingDirectory: base,
    milestoneId: mid,
    sliceId: sid,
    sliceTitle: sTitle,
    slicePath: sliceRel,
    roadmapPath: join(base, roadmapRel),
    inlinedContext,
    sliceSummaryPath,
    sliceUatPath,
    gatesToClose
  });
}
async function buildCompleteMilestonePrompt(mid, midTitle, base, level) {
  const inlineLevel = level ?? resolveInlineLevel();
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");
  const validationPath = resolveMilestoneFile(base, mid, "VALIDATION");
  const validationRel = relMilestoneFile(base, mid, "VALIDATION");
  const validationContent = validationPath ? await loadFile(validationPath) : null;
  const inlined = [];
  inlined.push(await inlineFile(roadmapPath, roadmapRel, "Milestone Roadmap"));
  let sliceIds = [];
  try {
    const { isDbAvailable, getMilestoneSlices } = await import("./gsd-db.js");
    if (isDbAvailable()) {
      sliceIds = getMilestoneSlices(mid).filter((s) => s.status !== "skipped").map((s) => s.id);
    }
  } catch (err) {
    logWarning("prompt", `buildCompleteMilestonePrompt DB lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (sliceIds.length === 0 && roadmapPath) {
    const roadmapContent = await loadFile(roadmapPath);
    if (roadmapContent) {
      sliceIds = parseRoadmap(roadmapContent).slices.map((s) => s.id);
    }
  }
  const seenSlices = /* @__PURE__ */ new Set();
  const summaryRelPaths = [];
  for (const sid of sliceIds) {
    if (seenSlices.has(sid)) continue;
    seenSlices.add(sid);
    const summaryPath = resolveSliceFile(base, mid, sid, "SUMMARY");
    const summaryRel = relSliceFile(base, mid, sid, "SUMMARY");
    summaryRelPaths.push(summaryRel);
    inlined.push(await buildSliceSummaryExcerpt(summaryPath, summaryRel, sid));
  }
  if (summaryRelPaths.length > 0) {
    const pathList = summaryRelPaths.map((p) => `- \`${p}\``).join("\n");
    inlined.push(
      `### On-demand Slice Summaries

Excerpted above. Read the full file for any slice when the excerpt's section heads don't carry enough narrative for the milestone summary you're drafting:

${pathList}`
    );
  }
  const validationContext = [
    formatCloseoutReviewInstructions(validationContent, validationRel, [validationRel, roadmapRel, ...summaryRelPaths])
  ];
  if (validationContent) {
    validationContext.push(`### Milestone Validation
Source: \`${validationRel}\`

${validationContent.trim()}`);
  }
  inlined.unshift(...validationContext);
  if (inlineLevel !== "minimal") {
    const requirementsInline = await inlineRequirementsFromDb(base, mid, void 0, inlineLevel);
    if (requirementsInline) inlined.push(requirementsInline);
    const decisionsInline = await inlineDecisionsFromDb(base, mid, void 0, inlineLevel);
    if (decisionsInline) inlined.push(decisionsInline);
    const projectInline = await inlineProjectFromDb(base);
    if (projectInline) inlined.push(projectInline);
  }
  const knowledgeInlineCM = await inlineKnowledgeBudgeted(base, extractKeywords(midTitle));
  if (knowledgeInlineCM) inlined.push(knowledgeInlineCM);
  const contextPath = resolveMilestoneFile(base, mid, "CONTEXT");
  const contextRel = relMilestoneFile(base, mid, "CONTEXT");
  const contextInline = await inlineFileOptional(contextPath, contextRel, "Milestone Context");
  if (contextInline) inlined.push(contextInline);
  inlined.push(inlineTemplate("milestone-summary", "Milestone Summary"));
  const inlinedContext = prependContextModeToBlock(
    "complete-milestone",
    base,
    capPreamble(`## Inlined Context (preloaded \u2014 do not re-read these files)

${inlined.join("\n\n---\n\n")}`)
  );
  const milestoneSummaryPath = join(base, `${relMilestonePath(base, mid)}/${mid}-SUMMARY.md`);
  const learningsRelPath = join(relMilestonePath(base, mid), `${mid}-LEARNINGS.md`);
  const learningsAbsPath = join(base, learningsRelPath);
  const extractLearningsSteps = buildExtractionStepsBlock({
    milestoneId: mid,
    outputPath: learningsAbsPath,
    relativeOutputPath: learningsRelPath
  });
  return loadPrompt("complete-milestone", {
    workingDirectory: base,
    milestoneId: mid,
    milestoneTitle: midTitle,
    roadmapPath: roadmapRel,
    inlinedContext,
    milestoneSummaryPath,
    extractLearningsSteps,
    skillActivation: buildSkillActivationBlock({
      base,
      milestoneId: mid,
      milestoneTitle: midTitle,
      extraContext: [inlinedContext],
      unitType: "complete-milestone"
    })
  });
}
async function buildValidateMilestonePrompt(mid, midTitle, base, level) {
  const inlineLevel = level ?? resolveInlineLevel();
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");
  const inlined = [];
  inlined.push(await inlineFile(roadmapPath, roadmapRel, "Milestone Roadmap"));
  try {
    const { isDbAvailable, getMilestone } = await import("./gsd-db.js");
    if (isDbAvailable()) {
      const milestone = getMilestone(mid);
      if (milestone) {
        const classes = [];
        if (milestone.verification_contract) classes.push(`- **Contract:** ${milestone.verification_contract}`);
        if (milestone.verification_integration) classes.push(`- **Integration:** ${milestone.verification_integration}`);
        if (milestone.verification_operational) classes.push(`- **Operational:** ${milestone.verification_operational}`);
        if (milestone.verification_uat) classes.push(`- **UAT:** ${milestone.verification_uat}`);
        if (classes.length > 0) {
          inlined.push(`### Verification Classes (from planning)

These verification tiers were defined during milestone planning. Each non-empty class must be checked for evidence during validation.

${classes.join("\n")}`);
        }
      }
    }
  } catch (err) {
    logWarning("prompt", `buildValidateMilestonePrompt verification classes lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  let valSliceIds = [];
  try {
    const { isDbAvailable, getMilestoneSlices } = await import("./gsd-db.js");
    if (isDbAvailable()) {
      valSliceIds = getMilestoneSlices(mid).filter((s) => s.status !== "skipped").map((s) => s.id);
    }
  } catch (err) {
    logWarning("prompt", `buildValidateMilestonePrompt slice IDs lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (valSliceIds.length === 0 && roadmapPath) {
    const roadmapContent = await loadFile(roadmapPath);
    if (roadmapContent) {
      valSliceIds = parseRoadmap(roadmapContent).slices.map((s) => s.id);
    }
  }
  const seenValSlices = /* @__PURE__ */ new Set();
  for (const sid of valSliceIds) {
    if (seenValSlices.has(sid)) continue;
    seenValSlices.add(sid);
    const summaryPath = resolveSliceFile(base, mid, sid, "SUMMARY");
    const summaryRel = relSliceFile(base, mid, sid, "SUMMARY");
    inlined.push(await inlineFile(summaryPath, summaryRel, `${sid} Summary`));
    const assessmentPath = resolveSliceFile(base, mid, sid, "ASSESSMENT");
    const assessmentRel = relSliceFile(base, mid, sid, "ASSESSMENT");
    const assessmentInline = await inlineFileOptional(assessmentPath, assessmentRel, `${sid} Assessment`);
    if (assessmentInline) inlined.push(assessmentInline);
  }
  const outstandingItems = [];
  for (const sid of valSliceIds) {
    const summaryPath = resolveSliceFile(base, mid, sid, "SUMMARY");
    if (!summaryPath) continue;
    const content = await loadFile(summaryPath);
    if (!content) continue;
    const summary = parseSummary(content);
    if (summary.followUps) outstandingItems.push(`- **${sid} Follow-ups:** ${summary.followUps.trim()}`);
    if (summary.knownLimitations) outstandingItems.push(`- **${sid} Known Limitations:** ${summary.knownLimitations.trim()}`);
  }
  if (outstandingItems.length > 0) {
    inlined.push(`### Outstanding Items (aggregated from slice summaries)

These follow-ups and known limitations were documented during slice completion but have not been resolved.

${outstandingItems.join("\n")}`);
  }
  const validationPath = resolveMilestoneFile(base, mid, "VALIDATION");
  const validationRel = relMilestoneFile(base, mid, "VALIDATION");
  const validationContent = validationPath ? await loadFile(validationPath) : null;
  let remediationRound = 0;
  if (validationContent) {
    const roundMatch = validationContent.match(/remediation_round:\s*(\d+)/);
    remediationRound = roundMatch ? parseInt(roundMatch[1], 10) + 1 : 1;
    inlined.push(`### Previous Validation (re-validation round ${remediationRound})
Source: \`${validationRel}\`

${validationContent.trim()}`);
  }
  if (inlineLevel !== "minimal") {
    const requirementsInline = await inlineRequirementsFromDb(base, mid, void 0, inlineLevel);
    if (requirementsInline) inlined.push(requirementsInline);
    const decisionsInline = await inlineDecisionsFromDb(base, mid, void 0, inlineLevel);
    if (decisionsInline) inlined.push(decisionsInline);
    const projectInline = await inlineProjectFromDb(base);
    if (projectInline) inlined.push(projectInline);
  }
  const knowledgeInline = await inlineKnowledgeBudgeted(base, extractKeywords(midTitle));
  if (knowledgeInline) inlined.push(knowledgeInline);
  const contextPath = resolveMilestoneFile(base, mid, "CONTEXT");
  const contextRel = relMilestoneFile(base, mid, "CONTEXT");
  const contextInline = await inlineFileOptional(contextPath, contextRel, "Milestone Context");
  if (contextInline) inlined.push(contextInline);
  const inlinedContext = prependContextModeToBlock(
    "validate-milestone",
    base,
    capPreamble(`## Inlined Context (preloaded \u2014 do not re-read these files)

${inlined.join("\n\n---\n\n")}`)
  );
  const validationOutputPath = join(base, `${relMilestonePath(base, mid)}/${mid}-VALIDATION.md`);
  const roadmapOutputPath = `${relMilestonePath(base, mid)}/${mid}-ROADMAP.md`;
  const mvGates = getGatesForTurn("validate-milestone");
  const gatesToEvaluate = renderGatesToCloseBlock(mvGates, {
    pending: new Set(mvGates.map((g) => g.id)),
    allowOmit: false
  });
  return loadPrompt("validate-milestone", {
    workingDirectory: base,
    milestoneId: mid,
    milestoneTitle: midTitle,
    roadmapPath: roadmapOutputPath,
    inlinedContext,
    validationPath: validationOutputPath,
    remediationRound: String(remediationRound),
    gatesToEvaluate,
    skillActivation: buildSkillActivationBlock({
      base,
      milestoneId: mid,
      milestoneTitle: midTitle,
      extraContext: [inlinedContext],
      unitType: "validate-milestone"
    })
  });
}
async function buildReplanSlicePrompt(mid, midTitle, sid, sTitle, base) {
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");
  const slicePlanPath = resolveSliceFile(base, mid, sid, "PLAN");
  const slicePlanRel = relSliceFile(base, mid, sid, "PLAN");
  const sliceContextPath = resolveSliceFile(base, mid, sid, "CONTEXT");
  const sliceContextRel = relSliceFile(base, mid, sid, "CONTEXT");
  const inlined = [];
  inlined.push(await inlineFile(roadmapPath, roadmapRel, "Milestone Roadmap"));
  const sliceCtxInline = await inlineFileOptional(sliceContextPath, sliceContextRel, "Slice Context (from discussion)");
  if (sliceCtxInline) inlined.push(sliceCtxInline);
  inlined.push(await inlineFile(slicePlanPath, slicePlanRel, "Current Slice Plan"));
  let blockerTaskId = "";
  const tDir = resolveTasksDir(base, mid, sid);
  if (tDir) {
    const summaryFiles = resolveTaskFiles(tDir, "SUMMARY").sort();
    for (const file of summaryFiles) {
      const absPath = join(tDir, file);
      const content = await loadFile(absPath);
      if (!content) continue;
      const summary = parseSummary(content);
      const sRel = relSlicePath(base, mid, sid);
      const relPath = `${sRel}/tasks/${file}`;
      if (summary.frontmatter.blocker_discovered) {
        blockerTaskId = summary.frontmatter.id || file.replace(/-SUMMARY\.md$/i, "");
        inlined.push(await buildTaskSummaryExcerpt(absPath, relPath, blockerTaskId, { blocker: true }));
      }
    }
  }
  const decisionsInline = await inlineDecisionsFromDb(base, mid);
  if (decisionsInline) inlined.push(decisionsInline);
  const replanActiveOverrides = await loadActiveOverrides(base);
  const replanOverridesInline = formatOverridesSection(replanActiveOverrides);
  if (replanOverridesInline) inlined.unshift(replanOverridesInline);
  const inlinedContext = prependContextModeToBlock(
    "replan-slice",
    base,
    capPreamble(`## Inlined Context (preloaded \u2014 do not re-read these files)

${inlined.join("\n\n---\n\n")}`)
  );
  const replanPath = join(base, `${relSlicePath(base, mid, sid)}/${sid}-REPLAN.md`);
  let captureContext = "(none)";
  try {
    const { loadReplanCaptures } = await import("./triage-resolution.js");
    const replanCaptures = loadReplanCaptures(base);
    if (replanCaptures.length > 0) {
      captureContext = replanCaptures.map(
        (c) => `- **${c.id}**: "${c.text}" \u2014 ${c.rationale ?? "no rationale"}`
      ).join("\n");
    }
  } catch (err) {
    logWarning("prompt", `loadReplanCaptures failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return loadPrompt("replan-slice", {
    workingDirectory: base,
    milestoneId: mid,
    sliceId: sid,
    sliceTitle: sTitle,
    slicePath: relSlicePath(base, mid, sid),
    planPath: join(base, slicePlanRel),
    blockerTaskId,
    inlinedContext,
    replanPath,
    captureContext,
    skillActivation: buildSkillActivationBlock({
      base,
      milestoneId: mid,
      milestoneTitle: midTitle,
      sliceId: sid,
      sliceTitle: sTitle,
      extraContext: [inlinedContext, captureContext],
      unitType: "replan-slice"
    })
  });
}
async function buildRunUatPrompt(mid, sliceId, uatPath, uatContent, base) {
  const resolveArtifact = async (key) => {
    switch (key) {
      case "slice-uat": {
        const trimmed = uatContent.trim();
        if (!trimmed) {
          return `### ${sliceId} UAT
Source: \`${uatPath}\`

_(not found \u2014 file does not exist yet)_`;
        }
        return `### ${sliceId} UAT
Source: \`${uatPath}\`

${trimmed}`;
      }
      case "slice-summary": {
        const p = resolveSliceFile(base, mid, sliceId, "SUMMARY");
        if (!p) return null;
        const r = relSliceFile(base, mid, sliceId, "SUMMARY");
        return await inlineFileOptional(p, r, `${sliceId} Summary`);
      }
      case "project":
        return await inlineProjectFromDb(base);
      default:
        return null;
    }
  };
  const composed = await composeInlinedContext("run-uat", resolveArtifact);
  const inlinedContext = prependContextModeToBlock(
    "run-uat",
    base,
    capPreamble(`## Inlined Context (preloaded \u2014 do not re-read these files)

${composed}`)
  );
  const uatResultPath = join(base, relSliceFile(base, mid, sliceId, "ASSESSMENT"));
  const uatType = getUatType(uatContent);
  return loadPrompt("run-uat", {
    workingDirectory: base,
    milestoneId: mid,
    sliceId,
    uatPath,
    uatResultPath,
    uatType,
    inlinedContext,
    skillActivation: buildSkillActivationBlock({
      base,
      milestoneId: mid,
      sliceId,
      extraContext: [inlinedContext],
      unitType: "run-uat"
    })
  });
}
async function buildReassessRoadmapPrompt(mid, midTitle, completedSliceId, base, level) {
  const inlineLevel = level ?? resolveInlineLevel();
  const resolveArtifact = async (key) => {
    switch (key) {
      case "roadmap": {
        const p = resolveMilestoneFile(base, mid, "ROADMAP");
        const r = relMilestoneFile(base, mid, "ROADMAP");
        return await inlineFile(p, r, "Current Roadmap");
      }
      case "slice-context": {
        const p = resolveSliceFile(base, mid, completedSliceId, "CONTEXT");
        const r = relSliceFile(base, mid, completedSliceId, "CONTEXT");
        return await inlineFileOptional(p, r, "Slice Context (from discussion)");
      }
      case "slice-summary": {
        const p = resolveSliceFile(base, mid, completedSliceId, "SUMMARY");
        const r = relSliceFile(base, mid, completedSliceId, "SUMMARY");
        return await inlineFile(p, r, `${completedSliceId} Summary`);
      }
      case "project":
        if (inlineLevel === "minimal") return null;
        return await inlineProjectFromDb(base);
      case "requirements":
        if (inlineLevel === "minimal") return null;
        return await inlineRequirementsFromDb(base, mid, void 0, inlineLevel);
      case "decisions":
        if (inlineLevel === "minimal") return null;
        return await inlineDecisionsFromDb(base, mid, void 0, inlineLevel);
      default:
        return null;
    }
  };
  const composed = await composeInlinedContext("reassess-roadmap", resolveArtifact);
  const parts = [];
  if (composed) parts.push(composed);
  const knowledgeInlineRA = await inlineKnowledgeBudgeted(base, extractKeywords(midTitle));
  if (knowledgeInlineRA) parts.push(knowledgeInlineRA);
  const inlinedContext = prependContextModeToBlock(
    "reassess-roadmap",
    base,
    capPreamble(`## Inlined Context (preloaded \u2014 do not re-read these files)

${parts.join("\n\n---\n\n")}`)
  );
  const assessmentPath = join(base, relSliceFile(base, mid, completedSliceId, "ASSESSMENT"));
  let deferredCaptures = "(none)";
  try {
    const { loadDeferredCaptures } = await import("./triage-resolution.js");
    const deferred = loadDeferredCaptures(base);
    if (deferred.length > 0) {
      deferredCaptures = deferred.map(
        (c) => `- **${c.id}**: "${c.text}" \u2014 ${c.rationale ?? "deferred during triage"}`
      ).join("\n");
    }
  } catch (err) {
    logWarning("prompt", `loadDeferredCaptures failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const reassessCommitInstruction = "Do not commit \u2014 .gsd/ planning docs are managed externally and not tracked in git.";
  return loadPrompt("reassess-roadmap", {
    workingDirectory: base,
    milestoneId: mid,
    milestoneTitle: midTitle,
    completedSliceId,
    roadmapPath: relMilestoneFile(base, mid, "ROADMAP"),
    assessmentPath,
    inlinedContext,
    deferredCaptures,
    commitInstruction: reassessCommitInstruction,
    skillActivation: buildSkillActivationBlock({
      base,
      milestoneId: mid,
      milestoneTitle: midTitle,
      extraContext: [inlinedContext, deferredCaptures],
      unitType: "reassess-roadmap"
    })
  });
}
async function buildReactiveExecutePrompt(mid, midTitle, sid, sTitle, readyTaskIds, base, subagentModel, opts) {
  const { loadSliceTaskIO, deriveTaskGraph, graphMetrics } = await import("./reactive-graph.js");
  const taskIO = await loadSliceTaskIO(base, mid, sid);
  const graph = deriveTaskGraph(taskIO);
  const metrics = graphMetrics(graph);
  const graphLines = [];
  for (const node of graph) {
    const status = node.done ? "\u2705 done" : readyTaskIds.includes(node.id) ? "\u{1F7E2} ready" : "\u23F3 waiting";
    const deps = node.dependsOn.length > 0 ? ` (depends on: ${node.dependsOn.join(", ")})` : "";
    graphLines.push(`- **${node.id}: ${node.title}** \u2014 ${status}${deps}`);
    if (node.outputFiles.length > 0) {
      graphLines.push(`  - Outputs: ${node.outputFiles.map((f) => `\`${f}\``).join(", ")}`);
    }
  }
  const graphContext = [
    `Tasks: ${metrics.taskCount}, Edges: ${metrics.edgeCount}, Ready: ${metrics.readySetSize}`,
    "",
    ...graphLines
  ].join("\n");
  const subagentSections = [];
  const readyTaskListLines = [];
  for (const tid of readyTaskIds) {
    const node = graph.find((n) => n.id === tid);
    const tTitle = node?.title ?? tid;
    readyTaskListLines.push(`- **${tid}: ${tTitle}**`);
    const depPaths = await getDependencyTaskSummaryPaths(
      mid,
      sid,
      tid,
      node?.dependsOn ?? [],
      base
    );
    const taskPrompt = await buildExecuteTaskPrompt(
      mid,
      sid,
      sTitle,
      tid,
      tTitle,
      base,
      {
        carryForwardPaths: depPaths,
        sessionContextWindow: opts?.sessionContextWindow,
        modelRegistry: opts?.modelRegistry,
        sessionProvider: opts?.sessionProvider,
        contextModeRenderMode: "nested"
      }
    );
    const modelSuffix = subagentModel ? ` with model: "${subagentModel}"` : "";
    subagentSections.push([
      `### ${tid}: ${tTitle}`,
      "",
      `Use this as the prompt for a \`subagent\` call${modelSuffix}:`,
      "",
      "```",
      taskPrompt,
      "```"
    ].join("\n"));
  }
  const inlinedTemplates = inlineTemplate("task-summary", "Task Summary");
  return loadPrompt("reactive-execute", {
    workingDirectory: base,
    milestoneId: mid,
    milestoneTitle: midTitle,
    sliceId: sid,
    sliceTitle: sTitle,
    graphContext: prependContextModeToBlock("reactive-execute", base, graphContext),
    readyTaskCount: String(readyTaskIds.length),
    readyTaskList: readyTaskListLines.join("\n"),
    subagentPrompts: subagentSections.join("\n\n---\n\n"),
    inlinedTemplates
  });
}
function renderGatesToCloseBlock(gates, opts) {
  const applicable = gates.filter((g) => opts.pending.has(g.id));
  if (applicable.length === 0) return "";
  const lines = [];
  lines.push("## Gates to Close");
  lines.push("");
  lines.push(
    "These quality gates are still pending for this unit. You MUST address every one before calling the closing tool \u2014 the handler closes the DB row based on whether the corresponding artifact section is present."
  );
  lines.push("");
  for (const def of applicable) {
    lines.push(`### ${def.id} \u2014 ${def.promptSection}`);
    lines.push("");
    lines.push(`**Question:** ${def.question}`);
    lines.push("");
    lines.push(def.guidance);
    if (opts.allowOmit) {
      lines.push("");
      lines.push(
        `If this gate genuinely does not apply to this unit, leave the **${def.promptSection}** section empty and the handler will record it as \`omitted\`. Otherwise, fill the section with concrete evidence.`
      );
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
async function buildParallelResearchSlicesPrompt(mid, midTitle, slices, basePath, subagentModel) {
  const subagentSections = [];
  const modelSuffix = subagentModel ? ` with model: "${subagentModel}"` : "";
  for (const slice of slices) {
    const slicePrompt = await buildResearchSlicePrompt(mid, midTitle, slice.id, slice.title, basePath, { contextModeRenderMode: "nested" });
    subagentSections.push([
      `### ${slice.id}: ${slice.title}`,
      "",
      `Use this as the prompt for a \`subagent\` call${modelSuffix} (agent: \`scout\`):`,
      "",
      "```",
      slicePrompt,
      "```"
    ].join("\n"));
  }
  return loadPrompt("parallel-research-slices", {
    workingDirectory: basePath,
    mid,
    midTitle,
    sliceCount: String(slices.length),
    sliceList: slices.map((s) => `- **${s.id}**: ${s.title}`).join("\n"),
    subagentPrompts: subagentSections.join("\n\n---\n\n")
  });
}
async function buildGateEvaluatePrompt(mid, midTitle, sid, sTitle, base, subagentModel) {
  const pending = getPendingGatesForTurn(mid, sid, "gate-evaluate");
  assertGateCoverage(pending, "gate-evaluate", { requireAll: false });
  const planFile = resolveSliceFile(base, mid, sid, "PLAN");
  const planContent = planFile ? await loadFile(planFile) ?? "(plan file empty)" : "(plan file not found)";
  const pendingIds = new Set(pending.map((g) => g.gate_id));
  const gateDefs = getGatesForTurn("gate-evaluate").filter((def) => pendingIds.has(def.id));
  const subagentSections = [];
  const gateListLines = [];
  const normalizedBase = base.replaceAll("\\", "/");
  for (const def of gateDefs) {
    gateListLines.push(`- **${def.id}**: ${def.question}`);
    const subPrompt = [
      renderContextModeForPrompt("gate-evaluate", base, "nested"),
      "",
      `You are evaluating quality gate **${def.id}** for slice ${sid} (${sTitle}).`,
      "",
      `**Working directory:** \`${normalizedBase}\`. All file reads, writes, and shell commands MUST operate relative to this directory. Do NOT \`cd\` to any other directory.`,
      "",
      `## Question: ${def.question}`,
      "",
      def.guidance,
      "",
      "## Slice Plan",
      "",
      planContent,
      "",
      "## Instructions",
      "",
      "Analyze the slice plan above and answer the gate question.",
      `Call the \`gsd_save_gate_result\` tool with:`,
      `- \`milestoneId\`: "${mid}"`,
      `- \`sliceId\`: "${sid}"`,
      `- \`gateId\`: "${def.id}"`,
      '- `verdict`: "pass" (no concerns), "flag" (concerns found), or "omitted" (not applicable)',
      "- `rationale`: one-sentence justification",
      "- `findings`: detailed markdown findings (or empty if omitted)"
    ].join("\n");
    const modelSuffix = subagentModel ? ` with model: "${subagentModel}"` : "";
    subagentSections.push([
      `### ${def.id}: ${def.question}`,
      "",
      `Use this as the prompt for a \`subagent\` call${modelSuffix} (agent: \`tester\`):`,
      "",
      "```",
      subPrompt,
      "```"
    ].join("\n"));
  }
  return loadPrompt("gate-evaluate", {
    workingDirectory: base,
    milestoneId: mid,
    milestoneTitle: midTitle,
    sliceId: sid,
    sliceTitle: sTitle,
    slicePlanContent: prependContextModeToBlock("gate-evaluate", base, planContent),
    gateCount: String(pending.length),
    gateList: gateListLines.join("\n"),
    subagentPrompts: subagentSections.join("\n\n---\n\n")
  });
}
async function buildRewriteDocsPrompt(mid, midTitle, activeSlice, base, overrides) {
  const sid = activeSlice?.id;
  const sTitle = activeSlice?.title ?? "";
  const docList = [];
  if (sid) {
    const slicePlanPath = resolveSliceFile(base, mid, sid, "PLAN");
    const slicePlanRel = relSliceFile(base, mid, sid, "PLAN");
    if (slicePlanPath) {
      docList.push(`- Slice plan: \`${slicePlanRel}\``);
      const tDir = resolveTasksDir(base, mid, sid);
      if (tDir) {
        let incompleteTasks = null;
        try {
          const { isDbAvailable, getSliceTasks } = await import("./gsd-db.js");
          if (isDbAvailable()) {
            incompleteTasks = getSliceTasks(mid, sid).filter((t) => t.status !== "complete" && t.status !== "done").map((t) => ({ id: t.id }));
          }
        } catch (err) {
          logWarning("prompt", `buildRewriteDocsPrompt DB task lookup failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (!incompleteTasks) {
          incompleteTasks = [];
        }
        if (incompleteTasks) {
          for (const task of incompleteTasks) {
            const taskPlanPath = resolveTaskFile(base, mid, sid, task.id, "PLAN");
            if (taskPlanPath) {
              const taskRelPath = `${relSlicePath(base, mid, sid)}/tasks/${task.id}-PLAN.md`;
              docList.push(`- Task plan: \`${taskRelPath}\``);
            }
          }
        }
      }
    }
  }
  const decisionsPath = resolveGsdRootFile(base, "DECISIONS");
  if (existsSync(decisionsPath)) docList.push(`- Decisions: \`${relGsdRootFile("DECISIONS")}\``);
  const requirementsPath = resolveGsdRootFile(base, "REQUIREMENTS");
  if (existsSync(requirementsPath)) docList.push(`- Requirements: \`${relGsdRootFile("REQUIREMENTS")}\``);
  const projectPath = resolveGsdRootFile(base, "PROJECT");
  if (existsSync(projectPath)) docList.push(`- Project: \`${relGsdRootFile("PROJECT")}\``);
  const contextPath = resolveMilestoneFile(base, mid, "CONTEXT");
  const contextRel = relMilestoneFile(base, mid, "CONTEXT");
  if (contextPath) docList.push(`- Milestone context (reference only): \`${contextRel}\``);
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");
  if (roadmapPath) docList.push(`- Roadmap: \`${roadmapRel}\``);
  const overrideContent = overrides.map((o, i) => [
    `### Override ${i + 1}`,
    `**Change:** ${o.change}`,
    `**Issued:** ${o.timestamp}`,
    `**During:** ${o.appliedAt}`
  ].join("\n")).join("\n\n");
  const documentList = docList.length > 0 ? docList.join("\n") : "- No active plan documents found.";
  return prependContextModeToBlock("rewrite-docs", base, loadPrompt("rewrite-docs", {
    workingDirectory: base,
    milestoneId: mid,
    milestoneTitle: midTitle,
    sliceId: sid ?? "none",
    sliceTitle: sTitle,
    overrideContent,
    documentList,
    overridesPath: relGsdRootFile("OVERRIDES")
  }));
}
export {
  buildCarryForwardSection,
  buildCompleteMilestonePrompt,
  buildCompleteSlicePrompt,
  buildDiscussMilestonePrompt,
  buildDiscussProjectPrompt,
  buildDiscussRequirementsPrompt,
  buildExecuteTaskPrompt,
  buildGateEvaluatePrompt,
  buildParallelResearchSlicesPrompt,
  buildPlanMilestonePrompt,
  buildPlanSlicePrompt,
  buildReactiveExecutePrompt,
  buildReassessRoadmapPrompt,
  buildRefineSlicePrompt,
  buildReplanSlicePrompt,
  buildResearchDecisionPrompt,
  buildResearchMilestonePrompt,
  buildResearchProjectPrompt,
  buildResearchSlicePrompt,
  buildResumeSection,
  buildRewriteDocsPrompt,
  buildRunUatPrompt,
  buildSkillActivationBlock,
  buildSkillDiscoveryVars,
  buildSliceSummaryExcerpt,
  buildSourceFilePaths,
  buildTaskSummaryExcerpt,
  buildValidateMilestonePrompt,
  buildWorkflowPreferencesPrompt,
  checkNeedsReassessment,
  checkNeedsRunUat,
  deriveSliceScope,
  escapeRegExp,
  extractMarkdownSection,
  extractSliceExecutionExcerpt,
  getDependencyTaskSummaryPaths,
  getPriorTaskSummaryPaths,
  inlineDecisionsFromDb,
  inlineDependencySummaries,
  inlineFile,
  inlineFileOptional,
  inlineFileSmart,
  inlineGsdRootFile,
  inlineKnowledgeBudgeted,
  inlineKnowledgeScoped,
  inlineProjectFromDb,
  inlineRequirementsFromDb,
  inlineRoadmapExcerpt
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9hdXRvLXByb21wdHMudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogQXV0by1tb2RlIFByb21wdCBCdWlsZGVycyBcdTIwMTQgY29uc3RydWN0IGRpc3BhdGNoIHByb21wdHMgZm9yIGVhY2ggdW5pdCB0eXBlLlxuICpcbiAqIFB1cmUgYXN5bmMgZnVuY3Rpb25zIHRoYXQgbG9hZCB0ZW1wbGF0ZXMgYW5kIGlubGluZSBmaWxlIGNvbnRlbnQuIE5vIG1vZHVsZS1sZXZlbFxuICogc3RhdGUsIG5vIGdsb2JhbHMgXHUyMDE0IGV2ZXJ5IGRlcGVuZGVuY3kgaXMgcGFzc2VkIGFzIGEgcGFyYW1ldGVyIG9yIGltcG9ydGVkIGFzIGFcbiAqIHV0aWxpdHkuXG4gKi9cblxuaW1wb3J0IHsgbG9hZEZpbGUsIHBhcnNlQ29udGludWUsIHBhcnNlU3VtbWFyeSwgbG9hZEFjdGl2ZU92ZXJyaWRlcywgZm9ybWF0T3ZlcnJpZGVzU2VjdGlvbiwgcGFyc2VUYXNrUGxhbkZpbGUgfSBmcm9tIFwiLi9maWxlcy5qc1wiO1xuaW1wb3J0IHR5cGUgeyBPdmVycmlkZSwgVWF0VHlwZSB9IGZyb20gXCIuL2ZpbGVzLmpzXCI7XG5pbXBvcnQgeyBoYXNWZXJkaWN0LCBnZXRVYXRUeXBlLCBleHRyYWN0VmVyZGljdCB9IGZyb20gXCIuL3ZlcmRpY3QtcGFyc2VyLmpzXCI7XG5pbXBvcnQgeyBsb2FkUHJvbXB0LCBpbmxpbmVUZW1wbGF0ZSB9IGZyb20gXCIuL3Byb21wdC1sb2FkZXIuanNcIjtcbmltcG9ydCB7XG4gIHJlc29sdmVNaWxlc3RvbmVGaWxlLCByZXNvbHZlU2xpY2VGaWxlLCByZXNvbHZlU2xpY2VQYXRoLFxuICByZXNvbHZlVGFza3NEaXIsIHJlc29sdmVUYXNrRmlsZXMsIHJlc29sdmVUYXNrRmlsZSxcbiAgcmVsTWlsZXN0b25lRmlsZSwgcmVsU2xpY2VGaWxlLCByZWxTbGljZVBhdGgsIHJlbE1pbGVzdG9uZVBhdGgsXG4gIHJlc29sdmVHc2RSb290RmlsZSwgcmVsR3NkUm9vdEZpbGUsIHJlc29sdmVSdW50aW1lRmlsZSxcbn0gZnJvbSBcIi4vcGF0aHMuanNcIjtcbmltcG9ydCB7IHJlc29sdmVTa2lsbERpc2NvdmVyeU1vZGUsIHJlc29sdmVJbmxpbmVMZXZlbCwgbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzLCByZXNvbHZlQWxsU2tpbGxSZWZlcmVuY2VzIH0gZnJvbSBcIi4vcHJlZmVyZW5jZXMuanNcIjtcbmltcG9ydCB7IGlzQ29udGV4dE1vZGVFbmFibGVkIH0gZnJvbSBcIi4vcHJlZmVyZW5jZXMtdHlwZXMuanNcIjtcbmltcG9ydCB7IHBhcnNlUm9hZG1hcCB9IGZyb20gXCIuL3BhcnNlcnMtbGVnYWN5LmpzXCI7XG5pbXBvcnQgdHlwZSB7IEdTRFN0YXRlLCBJbmxpbmVMZXZlbCB9IGZyb20gXCIuL3R5cGVzLmpzXCI7XG5pbXBvcnQgdHlwZSB7IEdTRFByZWZlcmVuY2VzIH0gZnJvbSBcIi4vcHJlZmVyZW5jZXMuanNcIjtcbmltcG9ydCB7IGdldExvYWRlZFNraWxscywgdHlwZSBTa2lsbCB9IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuaW1wb3J0IHsgam9pbiwgYmFzZW5hbWUgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGNvbXB1dGVCdWRnZXRzLCByZXNvbHZlRXhlY3V0b3JDb250ZXh0V2luZG93LCB0cnVuY2F0ZUF0U2VjdGlvbkJvdW5kYXJ5LCB0eXBlIE1pbmltYWxNb2RlbFJlZ2lzdHJ5IH0gZnJvbSBcIi4vY29udGV4dC1idWRnZXQuanNcIjtcbmltcG9ydCB7IGdldFBlbmRpbmdHYXRlcywgZ2V0UGVuZGluZ0dhdGVzRm9yVHVybiB9IGZyb20gXCIuL2dzZC1kYi5qc1wiO1xuaW1wb3J0IHtcbiAgR0FURV9SRUdJU1RSWSxcbiAgYXNzZXJ0R2F0ZUNvdmVyYWdlLFxuICBnZXRHYXRlc0ZvclR1cm4sXG4gIHR5cGUgR2F0ZURlZmluaXRpb24sXG59IGZyb20gXCIuL2dhdGUtcmVnaXN0cnkuanNcIjtcbmltcG9ydCB7IGZvcm1hdERlY2lzaW9uc0NvbXBhY3QsIGZvcm1hdFJlcXVpcmVtZW50c0NvbXBhY3QgfSBmcm9tIFwiLi9zdHJ1Y3R1cmVkLWRhdGEtZm9ybWF0dGVyLmpzXCI7XG5pbXBvcnQgeyByZWFkUGhhc2VBbmNob3IsIGZvcm1hdEFuY2hvckZvclByb21wdCB9IGZyb20gXCIuL3BoYXNlLWFuY2hvci5qc1wiO1xuaW1wb3J0IHsgY29tcG9zZUNvbnRleHRNb2RlSW5zdHJ1Y3Rpb25zLCBjb21wb3NlSW5saW5lZENvbnRleHQsIHR5cGUgQXJ0aWZhY3RSZXNvbHZlciwgdHlwZSBDb250ZXh0TW9kZVJlbmRlck1vZGUgfSBmcm9tIFwiLi91bml0LWNvbnRleHQtY29tcG9zZXIuanNcIjtcbmltcG9ydCB7IHJlYWRDb21wYWN0aW9uU25hcHNob3QgfSBmcm9tIFwiLi9jb21wYWN0aW9uLXNuYXBzaG90LmpzXCI7XG5pbXBvcnQgeyBsb2dXYXJuaW5nIH0gZnJvbSBcIi4vd29ya2Zsb3ctbG9nZ2VyLmpzXCI7XG5pbXBvcnQgeyBpbmxpbmVHcmFwaFN1YmdyYXBoIH0gZnJvbSBcIi4vZ3JhcGgtY29udGV4dC5qc1wiO1xuaW1wb3J0IHsgYnVpbGRFeHRyYWN0aW9uU3RlcHNCbG9jayB9IGZyb20gXCIuL2NvbW1hbmRzLWV4dHJhY3QtbGVhcm5pbmdzLmpzXCI7XG5pbXBvcnQgeyByZXNvbHZlU2tpbGxNYW5pZmVzdCwgd2FybklmTWFuaWZlc3RIYXNNaXNzaW5nU2tpbGxzIH0gZnJvbSBcIi4vc2tpbGwtbWFuaWZlc3QuanNcIjtcbmltcG9ydCB7IGNsYXNzaWZ5UHJvamVjdCwgdHlwZSBQcm9qZWN0Q2xhc3NpZmljYXRpb24gfSBmcm9tIFwiLi9kZXRlY3Rpb24uanNcIjtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFByZWFtYmxlIENhcCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBTdGF0aWMgY2VpbGluZyBmb3IgdGhlIHByZWFtYmxlIGNhcC4gS2VwdCBhcyBhbiB1cHBlciBib3VuZCBldmVuXG4gKiBhZnRlciBjb250ZXh0LXdpbmRvdy1hd2FyZSBzaXppbmcgc28gbGFyZ2Utd2luZG93IHVzZXJzIGRvbid0IHN1ZGRlbmx5IHNlZVxuICogMTBcdTAwRDcgbG9vc2VyIGNhcHMgdGhhbiBuZWVkZWQuIFNtYWxsLXdpbmRvdyB1c2VycyBnZXQgYSB0aWdodGVyIGNhcCBkZXJpdmVkXG4gKiBmcm9tIHRoZWlyIGNvbmZpZ3VyZWQgZXhlY3V0b3Igd2luZG93LlxuICovXG5jb25zdCBNQVhfUFJFQU1CTEVfQ0hBUlMgPSAyMF8wMDA7XG5cbi8qKlxuICogUmVzb2x2ZSBwcm9tcHQgYnVkZ2V0cyBmcm9tIHRoZSBjb25maWd1cmVkIGV4ZWN1dG9yIGNvbnRleHQgd2luZG93LlxuICpcbiAqIFRoZSBwcm9tcHQgYnVpbGRlcnMgaGVyZSBkb24ndCBoYXZlIGFjY2VzcyB0byB0aGUgcnVudGltZSBtb2RlbCByZWdpc3RyeVxuICogKHRoZXkncmUgY2FsbGVkIGZyb20gbWFueSBub24tY3R4IHNpdGVzKSwgc28gYHJlc29sdmVFeGVjdXRvckNvbnRleHRXaW5kb3dgXG4gKiBpcyBmZWQgdGhlIHVzZXItY29uZmlndXJhYmxlIGBjb250ZXh0X3dpbmRvd19vdmVycmlkZWAgcHJlZmVyZW5jZSBhcyB0aGVcbiAqIGBzZXNzaW9uQ29udGV4dFdpbmRvd2AgZmFsbGJhY2suIFRoYXQgcHJlZmVyZW5jZSBleGlzdHMgc3BlY2lmaWNhbGx5IHRvXG4gKiBjb3ZlciBzbWFsbC13aW5kb3cgbG9jYWwgbW9kZWxzIChlLmcuIDMySyBsZW1vbmFkZS9sbGFtYS5jcHAgc2VydmVycykgd2hvc2VcbiAqIG5fY3R4IGlzIG5vdCBkaXNjb3ZlcmFibGUgdGhyb3VnaCB0aGUgbW9kZWwgcmVnaXN0cnkuIElzc3VlICM0NDM1LlxuICovXG5mdW5jdGlvbiByZXNvbHZlUHJvbXB0QnVkZ2V0cygpOiBSZXR1cm5UeXBlPHR5cGVvZiBjb21wdXRlQnVkZ2V0cz4ge1xuICB0cnkge1xuICAgIGNvbnN0IHByZWZzID0gbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzKCk7XG4gICAgY29uc3Qgc2Vzc2lvbldpbmRvdyA9IHByZWZzPy5wcmVmZXJlbmNlcy5jb250ZXh0X3dpbmRvd19vdmVycmlkZTtcbiAgICBjb25zdCB3aW5kb3dUb2tlbnMgPSByZXNvbHZlRXhlY3V0b3JDb250ZXh0V2luZG93KHVuZGVmaW5lZCwgcHJlZnM/LnByZWZlcmVuY2VzLCBzZXNzaW9uV2luZG93KTtcbiAgICByZXR1cm4gY29tcHV0ZUJ1ZGdldHMod2luZG93VG9rZW5zKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGxvZ1dhcm5pbmcoXCJwcm9tcHRcIiwgYHJlc29sdmVQcm9tcHRCdWRnZXRzIGZhaWxlZDogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICByZXR1cm4gY29tcHV0ZUJ1ZGdldHMoMjAwXzAwMCk7XG4gIH1cbn1cblxuLyoqXG4gKiBDaGFyYWN0ZXIgYnVkZ2V0IGZvciBkZXBlbmRlbmN5L3ByaW9yIHNsaWNlIHN1bW1hcmllcyBpbmplY3RlZCBpbnRvIGRpc3BhdGNoXG4gKiBwcm9tcHRzLiBTY2FsZXMgd2l0aCB0aGUgZXhlY3V0b3IncyBjb25maWd1cmVkIGNvbnRleHQgd2luZG93IChpc3N1ZSAjNDQzNSkuXG4gKi9cbmZ1bmN0aW9uIHJlc29sdmVTdW1tYXJ5QnVkZ2V0Q2hhcnMoKTogbnVtYmVyIHtcbiAgcmV0dXJuIHJlc29sdmVQcm9tcHRCdWRnZXRzKCkuc3VtbWFyeUJ1ZGdldENoYXJzO1xufVxuXG5mdW5jdGlvbiBmb3JtYXRQcm9qZWN0Q2xhc3NpZmljYXRpb25Gb3JQbGFubmluZyhjbGFzc2lmaWNhdGlvbjogUHJvamVjdENsYXNzaWZpY2F0aW9uKTogc3RyaW5nIHtcbiAgY29uc3Qgc2FtcGxlRmlsZXMgPSBjbGFzc2lmaWNhdGlvbi5jb250ZW50RmlsZXMuc2xpY2UoMCwgOCk7XG4gIGNvbnN0IHNhbXBsZSA9IHNhbXBsZUZpbGVzLmxlbmd0aCA+IDAgPyBzYW1wbGVGaWxlcy5tYXAoKGZpbGUpID0+IGBcXGAke2ZpbGV9XFxgYCkuam9pbihcIiwgXCIpIDogXCIobm9uZSlcIjtcbiAgY29uc3QgbGluZXMgPSBbXG4gICAgXCIjIyMgUHJvamVjdCBDbGFzc2lmaWNhdGlvblwiLFxuICAgIFwiXCIsXG4gICAgYC0gKipLaW5kOioqICR7Y2xhc3NpZmljYXRpb24ua2luZH1gLFxuICAgIGAtICoqQ29udGVudCBmaWxlczoqKiAke2NsYXNzaWZpY2F0aW9uLmNvbnRlbnRGaWxlcy5sZW5ndGh9YCxcbiAgICBgLSAqKlNhbXBsZSBmaWxlczoqKiAke3NhbXBsZX1gLFxuICAgIGAtICoqUmVhc29uOioqICR7Y2xhc3NpZmljYXRpb24ucmVhc29ufWAsXG4gICAgXCJcIixcbiAgXTtcblxuICBpZiAoY2xhc3NpZmljYXRpb24ua2luZCA9PT0gXCJ1bnR5cGVkLWV4aXN0aW5nXCIpIHtcbiAgICBpZiAoY2xhc3NpZmljYXRpb24uY29udGVudEZpbGVzLmxlbmd0aCA8PSAyKSB7XG4gICAgICBsaW5lcy5wdXNoKFxuICAgICAgICBcIioqV29ya2Zsb3cgc2l6aW5nOioqIFRoaXMgaXMgYSB0aW55IGV4aXN0aW5nIHVudHlwZWQgcHJvamVjdC4gUHJlZmVyIGV4YWN0bHkgb25lIHNsaWNlIHVubGVzcyB0aGUgbWlsZXN0b25lIHJlcXVlc3QgY2xlYXJseSBzcGFucyBtdWx0aXBsZSBpbmRlcGVuZGVudCB1c2VyLXZpc2libGUgY2FwYWJpbGl0aWVzLlwiLFxuICAgICAgKTtcbiAgICB9IGVsc2UgaWYgKGNsYXNzaWZpY2F0aW9uLmNvbnRlbnRGaWxlcy5sZW5ndGggPD0gNSkge1xuICAgICAgbGluZXMucHVzaChcbiAgICAgICAgXCIqKldvcmtmbG93IHNpemluZzoqKiBUaGlzIGlzIGEgc21hbGwgZXhpc3RpbmcgdW50eXBlZCBwcm9qZWN0LiBQcmVmZXIgMS0yIHNsaWNlcyB1bmxlc3MgdGhlIG1pbGVzdG9uZSByZXF1ZXN0IGNsZWFybHkgc3BhbnMgbXVsdGlwbGUgaW5kZXBlbmRlbnQgdXNlci12aXNpYmxlIGNhcGFiaWxpdGllcy5cIixcbiAgICAgICk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGxpbmVzLnB1c2goXG4gICAgICAgIFwiKipXb3JrZmxvdyBzaXppbmc6KiogRXhpc3RpbmcgdW50eXBlZCBwcm9qZWN0LiBVc2UgZ2VuZXJpYyBmaWxlLWxldmVsIHdvcmtmbG93IGd1aWRhbmNlIGFuZCBzaXplIHNsaWNlcyBieSByZWFsIGNhcGFiaWxpdHkgYm91bmRhcmllcywgbm90IGJ5IG1pc3NpbmcgdG9vbGluZyBtYXJrZXJzLlwiLFxuICAgICAgKTtcbiAgICB9XG4gIH0gZWxzZSBpZiAoY2xhc3NpZmljYXRpb24ua2luZCA9PT0gXCJncmVlbmZpZWxkXCIpIHtcbiAgICBsaW5lcy5wdXNoKFwiKipXb3JrZmxvdyBzaXppbmc6KiogTm8gcHJvamVjdCBjb250ZW50IGV4aXN0cyB5ZXQuIFVzZSBub3JtYWwgZ3JlZW5maWVsZCBzaXppbmcgZm9yIHRoZSByZXF1ZXN0ZWQgc2NvcGUuXCIpO1xuICB9IGVsc2UgaWYgKGNsYXNzaWZpY2F0aW9uLmtpbmQgPT09IFwidHlwZWQtZXhpc3RpbmdcIikge1xuICAgIGxpbmVzLnB1c2goXCIqKldvcmtmbG93IHNpemluZzoqKiBLbm93biBwcm9qZWN0IG1hcmtlcnMgZXhpc3QuIFVzZSBub3JtYWwgZWNvc3lzdGVtLWF3YXJlIHBsYW5uaW5nIGd1aWRhbmNlLlwiKTtcbiAgfSBlbHNlIHtcbiAgICBsaW5lcy5wdXNoKFwiKipXb3JrZmxvdyBzaXppbmc6KiogSW52YWxpZCByZXBvc2l0b3J5IHN0YXRlLiBQbGFubmluZyBzaG91bGQgc3VyZmFjZSB0aGlzIGFzIGEgYmxvY2tlciByYXRoZXIgdGhhbiBpbnZlbnRpbmcgcHJvamVjdCBzdHJ1Y3R1cmUuXCIpO1xuICB9XG5cbiAgcmV0dXJuIGxpbmVzLmpvaW4oXCJcXG5cIik7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUFydGlmYWN0UmVmKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdmFsdWUudHJpbSgpLnJlcGxhY2UoL15bLVxcc10rLywgXCJcIikucmVwbGFjZSgvXltcIidgXSt8W1wiJ2BdKyQvZywgXCJcIikucmVwbGFjZUFsbChcIlxcXFxcIiwgXCIvXCIpLnJlcGxhY2UoL15cXC5cXC8vLCBcIlwiKTtcbn1cblxuZnVuY3Rpb24gcGFyc2VDb3ZlcmVkQXJ0aWZhY3RzKHZhbGlkYXRpb25Db250ZW50OiBzdHJpbmcpOiBTZXQ8c3RyaW5nPiB7XG4gIGNvbnN0IGNvdmVyZWQgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgY29uc3QgbGluZXMgPSB2YWxpZGF0aW9uQ29udGVudC5zcGxpdCgvXFxyP1xcbi8pO1xuICBsZXQgaW5Db3ZlcmVkQXJ0aWZhY3RzID0gZmFsc2U7XG4gIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xuICAgIGlmICgvXlxccypjb3ZlcmVkWy1fXT9hcnRpZmFjdHNcXHMqOi9pLnRlc3QobGluZSkpIHtcbiAgICAgIGluQ292ZXJlZEFydGlmYWN0cyA9IHRydWU7XG4gICAgICBjb25zdCBpbmxpbmUgPSBsaW5lLnNwbGl0KC9jb3ZlcmVkWy1fXT9hcnRpZmFjdHNcXHMqOi9pKVsxXT8udHJpbSgpO1xuICAgICAgaWYgKGlubGluZSAmJiBpbmxpbmUgIT09IFwiW11cIikge1xuICAgICAgICBpbmxpbmUucmVwbGFjZSgvXlxcW3xcXF0kL2csIFwiXCIpLnNwbGl0KFwiLFwiKS5tYXAobm9ybWFsaXplQXJ0aWZhY3RSZWYpLmZpbHRlcihCb29sZWFuKS5mb3JFYWNoKChpdGVtKSA9PiBjb3ZlcmVkLmFkZChpdGVtKSk7XG4gICAgICB9XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKCFpbkNvdmVyZWRBcnRpZmFjdHMpIGNvbnRpbnVlO1xuICAgIGlmICgvXlxcUy8udGVzdChsaW5lKSAmJiAhL15cXHMqLS8udGVzdChsaW5lKSkgYnJlYWs7XG4gICAgY29uc3QgaXRlbSA9IGxpbmUubWF0Y2goL15cXHMqLVxccyooLispJC8pPy5bMV07XG4gICAgaWYgKGl0ZW0pIGNvdmVyZWQuYWRkKG5vcm1hbGl6ZUFydGlmYWN0UmVmKGl0ZW0pKTtcbiAgfVxuICByZXR1cm4gY292ZXJlZDtcbn1cblxuZnVuY3Rpb24gaXNWYWxpZGF0aW9uRnJlc2hPckFwcGxpY2FibGUodmFsaWRhdGlvbkNvbnRlbnQ6IHN0cmluZyB8IG51bGwsIGN1cnJlbnRBcnRpZmFjdHM6IHN0cmluZ1tdKTogYm9vbGVhbiB7XG4gIGlmICghdmFsaWRhdGlvbkNvbnRlbnQpIHJldHVybiBmYWxzZTtcbiAgaWYgKCEvdmFsaWRhdGlvbl9tZXRhZGF0YTovaS50ZXN0KHZhbGlkYXRpb25Db250ZW50KSkgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBjb3ZlcmVkQXJ0aWZhY3RzID0gcGFyc2VDb3ZlcmVkQXJ0aWZhY3RzKHZhbGlkYXRpb25Db250ZW50KTtcbiAgaWYgKGNvdmVyZWRBcnRpZmFjdHMuc2l6ZSA9PT0gMCkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gY3VycmVudEFydGlmYWN0c1xuICAgIC5tYXAobm9ybWFsaXplQXJ0aWZhY3RSZWYpXG4gICAgLmZpbHRlcihCb29sZWFuKVxuICAgIC5ldmVyeSgoYXJ0aWZhY3QpID0+IGNvdmVyZWRBcnRpZmFjdHMuaGFzKGFydGlmYWN0KSk7XG59XG5cbmZ1bmN0aW9uIGZvcm1hdENsb3Nlb3V0UmV2aWV3SW5zdHJ1Y3Rpb25zKHZhbGlkYXRpb25Db250ZW50OiBzdHJpbmcgfCBudWxsLCB2YWxpZGF0aW9uUmVsOiBzdHJpbmcsIGN1cnJlbnRBcnRpZmFjdHM6IHN0cmluZ1tdKTogc3RyaW5nIHtcbiAgY29uc3QgdmVyZGljdCA9IHZhbGlkYXRpb25Db250ZW50ID8gZXh0cmFjdFZlcmRpY3QodmFsaWRhdGlvbkNvbnRlbnQpIDogbnVsbDtcbiAgY29uc3QgdmFsaWRhdGlvbkZyZXNoID0gaXNWYWxpZGF0aW9uRnJlc2hPckFwcGxpY2FibGUodmFsaWRhdGlvbkNvbnRlbnQsIGN1cnJlbnRBcnRpZmFjdHMpO1xuICBpZiAodmVyZGljdCA9PT0gXCJwYXNzXCIgJiYgdmFsaWRhdGlvbkZyZXNoKSB7XG4gICAgcmV0dXJuIFtcbiAgICAgIFwiIyMjIFBhc3NpbmcgVmFsaWRhdGlvbiBBcnRpZmFjdFwiLFxuICAgICAgXCJcIixcbiAgICAgIGBBIHBhc3NpbmcgdmFsaWRhdGlvbiBhcnRpZmFjdCBpcyBwcmVzZW50IGF0IFxcYCR7dmFsaWRhdGlvblJlbH1cXGAuIFRyZWF0IGl0IGFzIGF1dGhvcml0YXRpdmUgZm9yIHN1Y2Nlc3MgY3JpdGVyaWEsIHJlcXVpcmVtZW50IGNvdmVyYWdlLCB2ZXJpZmljYXRpb24gY2xhc3NlcywgYW5kIGNyb3NzLXNsaWNlIGludGVncmF0aW9uLmAsXG4gICAgICBcIlwiLFxuICAgICAgXCJEbyBub3QgZGVsZWdhdGUgZnJlc2ggcmV2aWV3ZXIvc2VjdXJpdHkvdGVzdGVyIGF1ZGl0cyBhbmQgZG8gbm90IHJlZG8gdGhlIHZhbGlkYXRpb24gZXZpZGVuY2UgcmV2aWV3IHVubGVzcyB0aGUgYXJ0aWZhY3QgaXMgaW50ZXJuYWxseSBpbmNvbnNpc3RlbnQgd2l0aCB0aGUgaW5saW5lZCBzdW1tYXJpZXMuIEZvY3VzIHRoaXMgdW5pdCBvbiBmaW5hbCBtaWxlc3RvbmUgbmFycmF0aXZlLCBsZWFybmluZ3MsIFBST0pFQ1QvcmVxdWlyZW1lbnRzIHVwZGF0ZXMsIGFuZCBgZ3NkX2NvbXBsZXRlX21pbGVzdG9uZWAuXCIsXG4gICAgXS5qb2luKFwiXFxuXCIpO1xuICB9XG5cbiAgaWYgKHZlcmRpY3QpIHtcbiAgICByZXR1cm4gW1xuICAgICAgXCIjIyMgVmFsaWRhdGlvbiBSZXF1aXJlcyBBdHRlbnRpb25cIixcbiAgICAgIFwiXCIsXG4gICAgICBgQSB2YWxpZGF0aW9uIGFydGlmYWN0IGlzIHByZXNlbnQgYXQgXFxgJHt2YWxpZGF0aW9uUmVsfVxcYCB3aXRoIHZlcmRpY3QgXFxgJHt2ZXJkaWN0fVxcYCwgYnV0IGl0IGlzIG1pc3NpbmcgZnJlc2huZXNzIG1ldGFkYXRhIG9yIGRvZXMgbm90IGNvdmVyIGN1cnJlbnQgbWlsZXN0b25lIGFydGlmYWN0cy4gRG8gbm90IHRyZWF0IHRoZSBtaWxlc3RvbmUgYXMgY29tcGxldGUgdW5sZXNzIHRoZSBpc3N1ZXMgYXJlIHJlc29sdmVkIGFuZCBldmlkZW5jZSBzdXBwb3J0cyBjb21wbGV0aW9uLmAsXG4gICAgXS5qb2luKFwiXFxuXCIpO1xuICB9XG5cbiAgcmV0dXJuIFtcbiAgICBcIiMjIyBObyBQYXNzaW5nIFZhbGlkYXRpb24gQXJ0aWZhY3RcIixcbiAgICBcIlwiLFxuICAgIGBObyBwYXNzaW5nIHZhbGlkYXRpb24gYXJ0aWZhY3Qgd2FzIGZvdW5kIGF0IFxcYCR7dmFsaWRhdGlvblJlbH1cXGAuIFVzZSB0aGUgZnVsbCBjbG9zZW91dCByZXZpZXcgcGF0aCBiZWZvcmUgY29tcGxldGlvbi5gLFxuICBdLmpvaW4oXCJcXG5cIik7XG59XG5cbmZ1bmN0aW9uIGNhcFByZWFtYmxlKHByZWFtYmxlOiBzdHJpbmcpOiBzdHJpbmcge1xuICAvLyBDYXAgaW5saW5lZCBjb250ZXh0IGF0IG1pbihzdGF0aWMgY2VpbGluZywgc2NhbGVkIGlubGluZSBidWRnZXQpLlxuICAvLyBUaGUgY2VpbGluZyBib3VuZHMgcmVwZWF0ZWQgYXV0byBwcm9tcHQgcGF5bG9hZHM7IHRoZSBzY2FsZWRcbiAgLy8gYnVkZ2V0IHRpZ2h0ZW5zIHRoZSBjYXAgZm9yIHNtYWxsLXdpbmRvdyB1c2VycyB3aG9zZSB0cnVlIHNhZmUgbGltaXQgaXNcbiAgLy8gYmVsb3cgMzBLLiBgY29tcHV0ZUJ1ZGdldHNgIGFsbG9jYXRlcyA0MCUgb2YgdG90YWwgY2hhcnMgdG8gaW5saW5lIGNvbnRleHQuXG4gIGNvbnN0IGJ1ZGdldCA9IE1hdGgubWluKE1BWF9QUkVBTUJMRV9DSEFSUywgcmVzb2x2ZVByb21wdEJ1ZGdldHMoKS5pbmxpbmVDb250ZXh0QnVkZ2V0Q2hhcnMpO1xuICBpZiAocHJlYW1ibGUubGVuZ3RoIDw9IGJ1ZGdldCkgcmV0dXJuIHByZWFtYmxlO1xuICByZXR1cm4gdHJ1bmNhdGVBdFNlY3Rpb25Cb3VuZGFyeShwcmVhbWJsZSwgYnVkZ2V0KS5jb250ZW50O1xufVxuXG5mdW5jdGlvbiByZW5kZXJDb250ZXh0TW9kZUZvclByb21wdChcbiAgdW5pdFR5cGU6IHN0cmluZyxcbiAgYmFzZTogc3RyaW5nLFxuICByZW5kZXJNb2RlOiBDb250ZXh0TW9kZVJlbmRlck1vZGUgPSBcInN0YW5kYWxvbmVcIixcbik6IHN0cmluZyB7XG4gIGNvbnN0IGVmZmVjdGl2ZVByZWZzID0gbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzKGJhc2UpPy5wcmVmZXJlbmNlcztcbiAgcmV0dXJuIGNvbXBvc2VDb250ZXh0TW9kZUluc3RydWN0aW9ucyh1bml0VHlwZSwge1xuICAgIGVuYWJsZWQ6IGlzQ29udGV4dE1vZGVFbmFibGVkKGVmZmVjdGl2ZVByZWZzKSxcbiAgICByZW5kZXJNb2RlLFxuICB9KTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyQ29udGV4dE1vZGVCbG9ja0ZvclByb21wdChcbiAgdW5pdFR5cGU6IHN0cmluZyxcbiAgYmFzZTogc3RyaW5nLFxuICByZW5kZXJNb2RlOiBDb250ZXh0TW9kZVJlbmRlck1vZGUgPSBcInN0YW5kYWxvbmVcIixcbik6IHN0cmluZyB7XG4gIGNvbnN0IGNvbnRleHRNb2RlID0gcmVuZGVyQ29udGV4dE1vZGVGb3JQcm9tcHQodW5pdFR5cGUsIGJhc2UsIHJlbmRlck1vZGUpO1xuICBpZiAoIWNvbnRleHRNb2RlKSByZXR1cm4gXCJcIjtcbiAgaWYgKHJlbmRlck1vZGUgPT09IFwibmVzdGVkXCIpIHJldHVybiBjb250ZXh0TW9kZTtcblxuICBjb25zdCBzbmFwc2hvdCA9IHJlYWRDb21wYWN0aW9uU25hcHNob3QoYmFzZSk7XG4gIGlmICghc25hcHNob3Q/LnRyaW0oKSkgcmV0dXJuIGNvbnRleHRNb2RlO1xuXG4gIHJldHVybiBgJHtjb250ZXh0TW9kZX1cXG5cXG4jIyBDb250ZXh0IFNuYXBzaG90XFxuU291cmNlOiBcXGAuZ3NkL2xhc3Qtc25hcHNob3QubWRcXGBcXG5cXG4ke3NuYXBzaG90LnRyaW1FbmQoKX1gO1xufVxuXG5mdW5jdGlvbiBwcmVwZW5kQ29udGV4dE1vZGVUb0Jsb2NrKFxuICB1bml0VHlwZTogc3RyaW5nLFxuICBiYXNlOiBzdHJpbmcsXG4gIGJsb2NrOiBzdHJpbmcsXG4gIHJlbmRlck1vZGU6IENvbnRleHRNb2RlUmVuZGVyTW9kZSA9IFwic3RhbmRhbG9uZVwiLFxuKTogc3RyaW5nIHtcbiAgY29uc3QgY29udGV4dE1vZGUgPSByZW5kZXJDb250ZXh0TW9kZUJsb2NrRm9yUHJvbXB0KHVuaXRUeXBlLCBiYXNlLCByZW5kZXJNb2RlKTtcbiAgaWYgKCFjb250ZXh0TW9kZSkgcmV0dXJuIGJsb2NrO1xuICBpZiAoIWJsb2NrLnRyaW0oKSkgcmV0dXJuIGNvbnRleHRNb2RlO1xuICByZXR1cm4gYCR7Y29udGV4dE1vZGV9XFxuXFxuJHtibG9ja31gO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRXhlY3V0b3IgQ29uc3RyYWludHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogRm9ybWF0IGV4ZWN1dG9yIGNvbnRleHQgY29uc3RyYWludHMgZm9yIGluamVjdGlvbiBpbnRvIHRoZSBwbGFuLXNsaWNlIHByb21wdC5cbiAqIFVzZXMgdGhlIGJ1ZGdldCBlbmdpbmUgdG8gY29tcHV0ZSB0YXNrIGNvdW50IHJhbmdlcyBhbmQgaW5saW5lIGNvbnRleHQgYnVkZ2V0c1xuICogYmFzZWQgb24gdGhlIGNvbmZpZ3VyZWQgZXhlY3V0b3IgbW9kZWwncyBjb250ZXh0IHdpbmRvdy5cbiAqL1xuZnVuY3Rpb24gZm9ybWF0RXhlY3V0b3JDb25zdHJhaW50cyhcbiAgc2Vzc2lvbkNvbnRleHRXaW5kb3c/OiBudW1iZXIsXG4gIG1vZGVsUmVnaXN0cnk/OiBNaW5pbWFsTW9kZWxSZWdpc3RyeSxcbiAgc2Vzc2lvblByb3ZpZGVyPzogc3RyaW5nLFxuKTogc3RyaW5nIHtcbiAgbGV0IHdpbmRvd1Rva2VuczogbnVtYmVyO1xuICB0cnkge1xuICAgIGNvbnN0IHByZWZzID0gbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzKCk7XG4gICAgd2luZG93VG9rZW5zID0gcmVzb2x2ZUV4ZWN1dG9yQ29udGV4dFdpbmRvdyhtb2RlbFJlZ2lzdHJ5LCBwcmVmcz8ucHJlZmVyZW5jZXMsIHNlc3Npb25Db250ZXh0V2luZG93LCBzZXNzaW9uUHJvdmlkZXIpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgbG9nV2FybmluZyhcInByb21wdFwiLCBgcmVzb2x2ZUV4ZWN1dG9yQ29udGV4dFdpbmRvdyBmYWlsZWQ6ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgLy8gRGVsZWdhdGUgdG8gdGhlIGJ1ZGdldCBlbmdpbmUgd2l0aG91dCBwcmVmcyAodGhlIHBhdGggdGhhdCBqdXN0IHRocmV3KVxuICAgIC8vIHNvIERFRkFVTFRfQ09OVEVYVF9XSU5ET1cgc3RheXMgdGhlIHNpbmdsZSBzb3VyY2Ugb2YgdHJ1dGguXG4gICAgd2luZG93VG9rZW5zID0gcmVzb2x2ZUV4ZWN1dG9yQ29udGV4dFdpbmRvdyh1bmRlZmluZWQsIHVuZGVmaW5lZCwgc2Vzc2lvbkNvbnRleHRXaW5kb3csIHNlc3Npb25Qcm92aWRlcik7XG4gIH1cbiAgY29uc3QgYnVkZ2V0cyA9IGNvbXB1dGVCdWRnZXRzKHdpbmRvd1Rva2Vucyk7XG4gIGNvbnN0IHsgbWluLCBtYXggfSA9IGJ1ZGdldHMudGFza0NvdW50UmFuZ2U7XG4gIGNvbnN0IGV4ZWNXaW5kb3dLID0gTWF0aC5yb3VuZCh3aW5kb3dUb2tlbnMgLyAxMDAwKTtcbiAgY29uc3QgcGVyVGFza0J1ZGdldEsgPSBNYXRoLnJvdW5kKGJ1ZGdldHMuaW5saW5lQ29udGV4dEJ1ZGdldENoYXJzIC8gMTAwMCk7XG4gIHJldHVybiBbXG4gICAgYCMjIEV4ZWN1dG9yIENvbnRleHQgQ29uc3RyYWludHNgLFxuICAgIGBgLFxuICAgIGBUaGUgYWdlbnQgdGhhdCBleGVjdXRlcyBlYWNoIHRhc2sgaGFzIGEgKioke2V4ZWNXaW5kb3dLfUsgdG9rZW4qKiBjb250ZXh0IHdpbmRvdy5gLFxuICAgIGAtIFJlY29tbWVuZGVkIHRhc2sgY291bnQgZm9yIHRoaXMgc2xpY2U6ICoqJHttaW59XHUyMDEzJHttYXh9IHRhc2tzKipgLFxuICAgIGAtIEVhY2ggdGFzayBnZXRzIH4ke3BlclRhc2tCdWRnZXRLfUsgY2hhcnMgb2YgaW5saW5lIGNvbnRleHQgKHBsYW5zLCBjb2RlLCBkZWNpc2lvbnMpYCxcbiAgICBgLSBLZWVwIGluZGl2aWR1YWwgdGFza3MgY29tcGxldGFibGUgd2l0aGluIGEgc2luZ2xlIGNvbnRleHQgd2luZG93IFx1MjAxNCBpZiBhIHRhc2sgbmVlZHMgbW9yZSBjb250ZXh0IHRoYW4gZml0cywgc3BsaXQgaXRgLFxuICBdLmpvaW4oXCJcXG5cIik7XG59XG5cbi8qKlxuICogUmV0dXJucyBhIG1hcmtkb3duIGJ1bGxldCBsaXN0IG9mIGtub3duIGNvbnRleHQgZmlsZSBwYXRocyBmb3IgdGhlIGdpdmVuXG4gKiBtaWxlc3RvbmUgKGFuZCBvcHRpb25hbGx5IHNsaWNlKS4gRmFsbHMgYmFjayB0byBhIGdlbmVyaWMgdG9vbC1hZ25vc3RpY1xuICogaW5zdHJ1Y3Rpb24gd2hlbiBubyBHU0QgYXJ0aWZhY3RzIGFyZSBmb3VuZC5cbiAqXG4gKiBAcGFyYW0gYmFzZSAtIEFic29sdXRlIHBhdGggdG8gdGhlIHByb2plY3Qgcm9vdC5cbiAqIEBwYXJhbSBtaWQgIC0gTWlsZXN0b25lIElEIChlLmcuIGBcIk0wMDFcImApLlxuICogQHBhcmFtIHNpZCAgLSBPcHRpb25hbCBzbGljZSBJRCAoZS5nLiBgXCJTMDFcImApLiBXaGVuIHByb3ZpZGVkLCB0aGUgc2xpY2VcbiAqICAgUkVTRUFSQ0ggZmlsZSBpcyBwcmVmZXJyZWQgb3ZlciB0aGUgbWlsZXN0b25lLWxldmVsIG9uZS5cbiAqIEByZXR1cm5zIE1hcmtkb3duIHN0cmluZyBvZiBmaWxlIHBhdGggYnVsbGV0cywgb3IgYSBmYWxsYmFjayBpbnN0cnVjdGlvbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkU291cmNlRmlsZVBhdGhzKFxuICBiYXNlOiBzdHJpbmcsXG4gIG1pZDogc3RyaW5nLFxuICBzaWQ/OiBzdHJpbmcsXG4pOiBzdHJpbmcge1xuICBjb25zdCBwYXRoczogc3RyaW5nW10gPSBbXTtcblxuICBjb25zdCBwcm9qZWN0UGF0aCA9IHJlc29sdmVHc2RSb290RmlsZShiYXNlLCBcIlBST0pFQ1RcIik7XG4gIGlmIChleGlzdHNTeW5jKHByb2plY3RQYXRoKSkge1xuICAgIHBhdGhzLnB1c2goYC0gKipQcm9qZWN0Kio6IFxcYCR7cmVsR3NkUm9vdEZpbGUoXCJQUk9KRUNUXCIpfVxcYGApO1xuICB9XG5cbiAgY29uc3QgcmVxdWlyZW1lbnRzUGF0aCA9IHJlc29sdmVHc2RSb290RmlsZShiYXNlLCBcIlJFUVVJUkVNRU5UU1wiKTtcbiAgaWYgKGV4aXN0c1N5bmMocmVxdWlyZW1lbnRzUGF0aCkpIHtcbiAgICBwYXRocy5wdXNoKGAtICoqUmVxdWlyZW1lbnRzKio6IFxcYCR7cmVsR3NkUm9vdEZpbGUoXCJSRVFVSVJFTUVOVFNcIil9XFxgYCk7XG4gIH1cblxuICBjb25zdCBkZWNpc2lvbnNQYXRoID0gcmVzb2x2ZUdzZFJvb3RGaWxlKGJhc2UsIFwiREVDSVNJT05TXCIpO1xuICBpZiAoZXhpc3RzU3luYyhkZWNpc2lvbnNQYXRoKSkge1xuICAgIHBhdGhzLnB1c2goYC0gKipEZWNpc2lvbnMqKjogXFxgJHtyZWxHc2RSb290RmlsZShcIkRFQ0lTSU9OU1wiKX1cXGBgKTtcbiAgfVxuXG4gIGNvbnN0IHF1ZXVlUGF0aCA9IHJlc29sdmVHc2RSb290RmlsZShiYXNlLCBcIlFVRVVFXCIpO1xuICBpZiAoZXhpc3RzU3luYyhxdWV1ZVBhdGgpKSB7XG4gICAgcGF0aHMucHVzaChgLSAqKlF1ZXVlKio6IFxcYCR7cmVsR3NkUm9vdEZpbGUoXCJRVUVVRVwiKX1cXGBgKTtcbiAgfVxuXG4gIGNvbnN0IGNvbnRleHRQYXRoID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZSwgbWlkLCBcIkNPTlRFWFRcIik7XG4gIGlmIChjb250ZXh0UGF0aCkge1xuICAgIHBhdGhzLnB1c2goYC0gKipNaWxlc3RvbmUgQ29udGV4dCoqOiBcXGAke3JlbE1pbGVzdG9uZUZpbGUoYmFzZSwgbWlkLCBcIkNPTlRFWFRcIil9XFxgYCk7XG4gIH1cblxuICBjb25zdCByb2FkbWFwUGF0aCA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2UsIG1pZCwgXCJST0FETUFQXCIpO1xuICBpZiAocm9hZG1hcFBhdGgpIHtcbiAgICBwYXRocy5wdXNoKGAtICoqUm9hZG1hcCoqOiBcXGAke3JlbE1pbGVzdG9uZUZpbGUoYmFzZSwgbWlkLCBcIlJPQURNQVBcIil9XFxgYCk7XG4gIH1cblxuICBpZiAoc2lkKSB7XG4gICAgY29uc3QgcmVzZWFyY2hQYXRoID0gcmVzb2x2ZVNsaWNlRmlsZShiYXNlLCBtaWQsIHNpZCwgXCJSRVNFQVJDSFwiKTtcbiAgICBpZiAocmVzZWFyY2hQYXRoKSB7XG4gICAgICBwYXRocy5wdXNoKGAtICoqU2xpY2UgUmVzZWFyY2gqKjogXFxgJHtyZWxTbGljZUZpbGUoYmFzZSwgbWlkLCBzaWQsIFwiUkVTRUFSQ0hcIil9XFxgYCk7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIGNvbnN0IHJlc2VhcmNoUGF0aCA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2UsIG1pZCwgXCJSRVNFQVJDSFwiKTtcbiAgICBpZiAocmVzZWFyY2hQYXRoKSB7XG4gICAgICBwYXRocy5wdXNoKGAtICoqTWlsZXN0b25lIFJlc2VhcmNoKio6IFxcYCR7cmVsTWlsZXN0b25lRmlsZShiYXNlLCBtaWQsIFwiUkVTRUFSQ0hcIil9XFxgYCk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHBhdGhzLmxlbmd0aCA+IDBcbiAgICA/IHBhdGhzLmpvaW4oXCJcXG5cIilcbiAgICA6IFwiLSBVc2UgdGhlIEdyZXAvR2xvYi9SZWFkIHRvb2xzIHRvIGlkZW50aWZ5IHRoZSByZWxldmFudCBzb3VyY2UgZmlsZXMgYmVmb3JlIHBsYW5uaW5nLlwiO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgSW5saW5lIEhlbHBlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogTG9hZCBhIGZpbGUgYW5kIGZvcm1hdCBpdCBmb3IgaW5saW5pbmcgaW50byBhIHByb21wdC5cbiAqIFJldHVybnMgdGhlIGNvbnRlbnQgd3JhcHBlZCB3aXRoIGEgc291cmNlIHBhdGggaGVhZGVyLCBvciBhIGZhbGxiYWNrXG4gKiBtZXNzYWdlIGlmIHRoZSBmaWxlIGRvZXNuJ3QgZXhpc3QuIFRoaXMgZWxpbWluYXRlcyB0b29sIGNhbGxzIFx1MjAxNCB0aGUgTExNXG4gKiBnZXRzIHRoZSBjb250ZW50IGRpcmVjdGx5IGluc3RlYWQgb2YgXCJSZWFkIHRoaXMgZmlsZTpcIi5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGlubGluZUZpbGUoXG4gIGFic1BhdGg6IHN0cmluZyB8IG51bGwsIHJlbFBhdGg6IHN0cmluZywgbGFiZWw6IHN0cmluZyxcbik6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IGNvbnRlbnQgPSBhYnNQYXRoID8gYXdhaXQgbG9hZEZpbGUoYWJzUGF0aCkgOiBudWxsO1xuICBpZiAoIWNvbnRlbnQpIHtcbiAgICByZXR1cm4gYCMjIyAke2xhYmVsfVxcblNvdXJjZTogXFxgJHtyZWxQYXRofVxcYFxcblxcbl8obm90IGZvdW5kIFx1MjAxNCBmaWxlIGRvZXMgbm90IGV4aXN0IHlldClfYDtcbiAgfVxuICByZXR1cm4gYCMjIyAke2xhYmVsfVxcblNvdXJjZTogXFxgJHtyZWxQYXRofVxcYFxcblxcbiR7Y29udGVudC50cmltKCl9YDtcbn1cblxuLyoqXG4gKiBMb2FkIGEgZmlsZSBmb3IgaW5saW5pbmcsIHJldHVybmluZyBudWxsIGlmIGl0IGRvZXNuJ3QgZXhpc3QuXG4gKiBVc2Ugd2hlbiB0aGUgZmlsZSBpcyBvcHRpb25hbCBhbmQgc2hvdWxkIGJlIG9taXR0ZWQgZW50aXJlbHkgaWYgYWJzZW50LlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaW5saW5lRmlsZU9wdGlvbmFsKFxuICBhYnNQYXRoOiBzdHJpbmcgfCBudWxsLCByZWxQYXRoOiBzdHJpbmcsIGxhYmVsOiBzdHJpbmcsXG4pOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgY29uc3QgY29udGVudCA9IGFic1BhdGggPyBhd2FpdCBsb2FkRmlsZShhYnNQYXRoKSA6IG51bGw7XG4gIGlmICghY29udGVudCkgcmV0dXJuIG51bGw7XG4gIHJldHVybiBgIyMjICR7bGFiZWx9XFxuU291cmNlOiBcXGAke3JlbFBhdGh9XFxgXFxuXFxuJHtjb250ZW50LnRyaW0oKX1gO1xufVxuXG4vKipcbiAqIFNtYXJ0IGZpbGUgaW5saW5pbmcgXHUyMDE0IGZvciBsYXJnZSBmaWxlcywgdXNlIHNlbWFudGljIGNodW5raW5nIHRvIGluY2x1ZGVcbiAqIG9ubHkgdGhlIG1vc3QgcmVsZXZhbnQgcG9ydGlvbnMgYmFzZWQgb24gdGhlIHRhc2sgY29udGV4dC5cbiAqIEZhbGxzIGJhY2sgdG8gZnVsbCBjb250ZW50IGZvciBzbWFsbCBmaWxlcyBvciB3aGVuIG5vIHF1ZXJ5IGlzIHByb3ZpZGVkLlxuICpcbiAqIEBwYXJhbSBhYnNQYXRoIEFic29sdXRlIGZpbGUgcGF0aFxuICogQHBhcmFtIHJlbFBhdGggUmVsYXRpdmUgZGlzcGxheSBwYXRoXG4gKiBAcGFyYW0gbGFiZWwgU2VjdGlvbiBsYWJlbFxuICogQHBhcmFtIHF1ZXJ5IFRhc2sgZGVzY3JpcHRpb24gZm9yIHJlbGV2YW5jZSBzY29yaW5nIChvcHRpb25hbClcbiAqIEBwYXJhbSB0aHJlc2hvbGQgQ2hhcmFjdGVyIHRocmVzaG9sZCBmb3IgY2h1bmtpbmcgKGRlZmF1bHQ6IDMwMDApXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBpbmxpbmVGaWxlU21hcnQoXG4gIGFic1BhdGg6IHN0cmluZyB8IG51bGwsIHJlbFBhdGg6IHN0cmluZywgbGFiZWw6IHN0cmluZyxcbiAgcXVlcnk/OiBzdHJpbmcsIHRocmVzaG9sZCA9IDMwMDAsXG4pOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCBjb250ZW50ID0gYWJzUGF0aCA/IGF3YWl0IGxvYWRGaWxlKGFic1BhdGgpIDogbnVsbDtcbiAgaWYgKCFjb250ZW50KSB7XG4gICAgcmV0dXJuIGAjIyMgJHtsYWJlbH1cXG5Tb3VyY2U6IFxcYCR7cmVsUGF0aH1cXGBcXG5cXG5fKG5vdCBmb3VuZCBcdTIwMTQgZmlsZSBkb2VzIG5vdCBleGlzdCB5ZXQpX2A7XG4gIH1cblxuICAvLyBGb3Igc21hbGwgZmlsZXMgb3Igbm8gcXVlcnksIGluY2x1ZGUgZnVsbCBjb250ZW50XG4gIGlmIChjb250ZW50Lmxlbmd0aCA8PSB0aHJlc2hvbGQgfHwgIXF1ZXJ5KSB7XG4gICAgcmV0dXJuIGAjIyMgJHtsYWJlbH1cXG5Tb3VyY2U6IFxcYCR7cmVsUGF0aH1cXGBcXG5cXG4ke2NvbnRlbnQudHJpbSgpfWA7XG4gIH1cblxuICAvLyBGb3IgbGFyZ2UgZmlsZXMsIHRydW5jYXRlIGF0IHNlY3Rpb24gYm91bmRhcnlcbiAgY29uc3QgdHJ1bmNhdGVkID0gdHJ1bmNhdGVBdFNlY3Rpb25Cb3VuZGFyeShjb250ZW50LCB0aHJlc2hvbGQpLmNvbnRlbnQ7XG4gIHJldHVybiBgIyMjICR7bGFiZWx9XFxuU291cmNlOiBcXGAke3JlbFBhdGh9XFxgXFxuXFxuJHt0cnVuY2F0ZWR9YDtcbn1cblxuZnVuY3Rpb24gaW5saW5lQ29tcGFjdFRlbXBsYXRlKG5hbWU6IFwicGxhblwiIHwgXCJ0YXNrLXN1bW1hcnlcIiB8IFwic2xpY2Utc3VtbWFyeVwiLCBsYWJlbDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgY29tcGFjdDogUmVjb3JkPHR5cGVvZiBuYW1lLCBzdHJpbmc+ID0ge1xuICAgIHBsYW46IFtcbiAgICAgIFwiIyB7e3NsaWNlSWR9fToge3tzbGljZVRpdGxlfX1cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIioqR29hbDoqKiB7e2dvYWx9fVwiLFxuICAgICAgXCIqKkRlbW86Kioge3tkZW1vfX1cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIE11c3QtSGF2ZXNcIixcbiAgICAgIFwiLSB7e211c3RIYXZlfX1cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIFRocmVhdCBTdXJmYWNlXCIsXG4gICAgICBcIi0gQWJ1c2U6IHt7YWJ1c2VTY2VuYXJpb3N9fVwiLFxuICAgICAgXCItIERhdGEgZXhwb3N1cmU6IHt7c2Vuc2l0aXZlRGF0YUFjY2Vzc2libGV9fVwiLFxuICAgICAgXCItIElucHV0IHRydXN0OiB7e3VudHJ1c3RlZElucHV0fX1cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIFJlcXVpcmVtZW50IEltcGFjdFwiLFxuICAgICAgXCItIFJlcXVpcmVtZW50cyB0b3VjaGVkOiB7e3JlcXVpcmVtZW50SWRzfX1cIixcbiAgICAgIFwiLSBSZS12ZXJpZnk6IHt7d2hhdE11c3RCZVJldGVzdGVkfX1cIixcbiAgICAgIFwiLSBEZWNpc2lvbnMgcmV2aXNpdGVkOiB7e2RlY2lzaW9uSWRzfX1cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIFByb29mIExldmVsXCIsXG4gICAgICBcIi0gVGhpcyBzbGljZSBwcm92ZXM6IHt7Y29udHJhY3QgfCBpbnRlZ3JhdGlvbiB8IG9wZXJhdGlvbmFsIHwgZmluYWwtYXNzZW1ibHl9fVwiLFxuICAgICAgXCItIFJlYWwgcnVudGltZSByZXF1aXJlZDoge3t5ZXMvbm99fVwiLFxuICAgICAgXCItIEh1bWFuL1VBVCByZXF1aXJlZDoge3t5ZXMvbm99fVwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyMgVmVyaWZpY2F0aW9uXCIsXG4gICAgICBcIi0ge3t0ZXN0RmlsZU9yQ29tbWFuZH19XCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBPYnNlcnZhYmlsaXR5IC8gRGlhZ25vc3RpY3NcIixcbiAgICAgIFwiLSBSdW50aW1lIHNpZ25hbHM6IHt7c2lnbmFsT3JOb25lfX1cIixcbiAgICAgIFwiLSBJbnNwZWN0aW9uIHN1cmZhY2VzOiB7e3N1cmZhY2VPck5vbmV9fVwiLFxuICAgICAgXCItIEZhaWx1cmUgdmlzaWJpbGl0eToge3tmYWlsdXJlU2lnbmFsT3JOb25lfX1cIixcbiAgICAgIFwiLSBSZWRhY3Rpb24gY29uc3RyYWludHM6IHt7c2VjcmV0T3JQaWlCb3VuZGFyeU9yTm9uZX19XCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBJbnRlZ3JhdGlvbiBDbG9zdXJlXCIsXG4gICAgICBcIi0gVXBzdHJlYW0gc3VyZmFjZXMgY29uc3VtZWQ6IHt7ZmlsZXNNb2R1bGVzQ29udHJhY3RzfX1cIixcbiAgICAgIFwiLSBOZXcgd2lyaW5nIGludHJvZHVjZWQ6IHt7ZW50cnlwb2ludE9yTm9uZX19XCIsXG4gICAgICBcIi0gUmVtYWluaW5nIGVuZC10by1lbmQgd29yazoge3tsaXN0T3JOb3RoaW5nfX1cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIFRhc2tzXCIsXG4gICAgICBcIi0gWyBdICoqVDAxOiB7e3Rhc2tUaXRsZX19KiogYGVzdDp7e2VzdGltYXRlfX1gXCIsXG4gICAgICBcIiAgLSBXaHk6IHt7d2h5VGhpc1Rhc2tFeGlzdHN9fVwiLFxuICAgICAgXCIgIC0gRmlsZXM6IGB7e2ZpbGVQYXRofX1gXCIsXG4gICAgICBcIiAgLSBEbzoge3tzcGVjaWZpY0ltcGxlbWVudGF0aW9uU3RlcHNBbmRDb25zdHJhaW50c319XCIsXG4gICAgICBcIiAgLSBWZXJpZnk6IHt7dGVzdENvbW1hbmRPclJ1bnRpbWVDaGVja319XCIsXG4gICAgICBcIiAgLSBEb25lIHdoZW46IHt7bWVhc3VyYWJsZUFjY2VwdGFuY2VDb25kaXRpb259fVwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyMgRmlsZXMgTGlrZWx5IFRvdWNoZWRcIixcbiAgICAgIFwiLSBge3tmaWxlUGF0aH19YFwiLFxuICAgIF0uam9pbihcIlxcblwiKSxcbiAgICBcInRhc2stc3VtbWFyeVwiOiBbXG4gICAgICBcIi0tLVwiLFxuICAgICAgXCJpZDoge3t0YXNrSWR9fVwiLFxuICAgICAgXCJwYXJlbnQ6IHt7c2xpY2VJZH19XCIsXG4gICAgICBcIm1pbGVzdG9uZToge3ttaWxlc3RvbmVJZH19XCIsXG4gICAgICBcInByb3ZpZGVzOiBbe3t3aGF0VGhpc1Rhc2tQcm92aWRlc319XVwiLFxuICAgICAgXCJrZXlfZmlsZXM6IFt7e2ZpbGVQYXRofX1dXCIsXG4gICAgICBcImtleV9kZWNpc2lvbnM6IFt7e2RlY2lzaW9ufX1dXCIsXG4gICAgICBcInBhdHRlcm5zX2VzdGFibGlzaGVkOiBbe3twYXR0ZXJufX1dXCIsXG4gICAgICBcIm9ic2VydmFiaWxpdHlfc3VyZmFjZXM6IFt7e2RpYWdub3N0aWNPck5vbmV9fV1cIixcbiAgICAgIFwiZHVyYXRpb246IHt7ZHVyYXRpb259fVwiLFxuICAgICAgXCJ2ZXJpZmljYXRpb25fcmVzdWx0OiBwYXNzZWRcIixcbiAgICAgIFwiY29tcGxldGVkX2F0OiB7e2RhdGV9fVwiLFxuICAgICAgXCJibG9ja2VyX2Rpc2NvdmVyZWQ6IGZhbHNlXCIsXG4gICAgICBcIi0tLVwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyB7e3Rhc2tJZH19OiB7e3Rhc2tUaXRsZX19XCIsXG4gICAgICBcIioqe3tvbmVMaW5lcn19KipcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIFdoYXQgSGFwcGVuZWRcIixcbiAgICAgIFwie3tuYXJyYXRpdmV9fVwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyMgVmVyaWZpY2F0aW9uXCIsXG4gICAgICBcInt7d2hhdFdhc1ZlcmlmaWVkQW5kSG93fX1cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIFZlcmlmaWNhdGlvbiBFdmlkZW5jZVwiLFxuICAgICAgXCJ8ICMgfCBDb21tYW5kIHwgRXhpdCBDb2RlIHwgVmVyZGljdCB8IER1cmF0aW9uIHxcIixcbiAgICAgIFwifC0tLXwtLS0tLS0tLS18LS0tLS0tLS0tLS18LS0tLS0tLS0tfC0tLS0tLS0tLS18XCIsXG4gICAgICBcInwge3tyb3d9fSB8IHt7Y29tbWFuZH19IHwge3tleGl0Q29kZX19IHwge3t2ZXJkaWN0fX0gfCB7e2R1cmF0aW9ufX0gfFwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyMgRGlhZ25vc3RpY3NcIixcbiAgICAgIFwie3tkaWFnbm9zdGljc09yTm9uZX19XCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBEZXZpYXRpb25zXCIsXG4gICAgICBcInt7ZGV2aWF0aW9uc0Zyb21QbGFuX09SX25vbmV9fVwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyMgS25vd24gSXNzdWVzXCIsXG4gICAgICBcInt7aXNzdWVzRGlzY292ZXJlZEJ1dE5vdEZpeGVkX09SX25vbmV9fVwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyMgRmlsZXMgQ3JlYXRlZC9Nb2RpZmllZFwiLFxuICAgICAgXCItIGB7e2ZpbGVQYXRofX1gIC0ge3tkZXNjcmlwdGlvbn19XCIsXG4gICAgXS5qb2luKFwiXFxuXCIpLFxuICAgIFwic2xpY2Utc3VtbWFyeVwiOiBbXG4gICAgICBcIi0tLVwiLFxuICAgICAgXCJpZDoge3tzbGljZUlkfX1cIixcbiAgICAgIFwicGFyZW50OiB7e21pbGVzdG9uZUlkfX1cIixcbiAgICAgIFwibWlsZXN0b25lOiB7e21pbGVzdG9uZUlkfX1cIixcbiAgICAgIFwicHJvdmlkZXM6IFt7e3doYXRUaGlzU2xpY2VQcm92aWRlc319XVwiLFxuICAgICAgXCJyZXF1aXJlczogW11cIixcbiAgICAgIFwiYWZmZWN0czogW11cIixcbiAgICAgIFwia2V5X2ZpbGVzOiBbe3tmaWxlUGF0aH19XVwiLFxuICAgICAgXCJrZXlfZGVjaXNpb25zOiBbe3tkZWNpc2lvbn19XVwiLFxuICAgICAgXCJwYXR0ZXJuc19lc3RhYmxpc2hlZDogW3t7cGF0dGVybn19XVwiLFxuICAgICAgXCJvYnNlcnZhYmlsaXR5X3N1cmZhY2VzOiBbe3tkaWFnbm9zdGljT3JOb25lfX1dXCIsXG4gICAgICBcImRyaWxsX2Rvd25fcGF0aHM6IFt7e3BhdGhUb1Rhc2tTdW1tYXJ5fX1dXCIsXG4gICAgICBcImR1cmF0aW9uOiB7e2R1cmF0aW9ufX1cIixcbiAgICAgIFwidmVyaWZpY2F0aW9uX3Jlc3VsdDogcGFzc2VkXCIsXG4gICAgICBcImNvbXBsZXRlZF9hdDoge3tkYXRlfX1cIixcbiAgICAgIFwiLS0tXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIHt7c2xpY2VJZH19OiB7e3NsaWNlVGl0bGV9fVwiLFxuICAgICAgXCIqKnt7b25lTGluZXJ9fSoqXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBXaGF0IEhhcHBlbmVkXCIsXG4gICAgICBcInt7bmFycmF0aXZlfX1cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIFZlcmlmaWNhdGlvblwiLFxuICAgICAgXCJ7e3doYXRXYXNWZXJpZmllZEFjcm9zc0FsbFRhc2tzfX1cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIFJlcXVpcmVtZW50cyBBZHZhbmNlZFwiLFxuICAgICAgXCItIHt7cmVxdWlyZW1lbnRJZH19IC0ge3tob3dUaGlzU2xpY2VBZHZhbmNlZEl0fX1cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIFJlcXVpcmVtZW50cyBWYWxpZGF0ZWRcIixcbiAgICAgIFwiLSB7e3JlcXVpcmVtZW50SWR9fSAtIHt7d2hhdFByb29mTm93TWFrZXNJdFZhbGlkYXRlZH19XCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBOZXcgUmVxdWlyZW1lbnRzIFN1cmZhY2VkXCIsXG4gICAgICBcIi0ge3tuZXdSZXF1aXJlbWVudE9yX25vbmV9fVwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyMgUmVxdWlyZW1lbnRzIEludmFsaWRhdGVkIG9yIFJlLXNjb3BlZFwiLFxuICAgICAgXCItIHt7cmVxdWlyZW1lbnRJZE9yX25vbmV9fSAtIHt7d2hhdENoYW5nZWR9fVwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyMgT3BlcmF0aW9uYWwgUmVhZGluZXNzXCIsXG4gICAgICBcIi0gSGVhbHRoIHNpZ25hbDoge3toZWFsdGhTaWduYWxPck5BfX1cIixcbiAgICAgIFwiLSBGYWlsdXJlIHNpZ25hbDoge3tmYWlsdXJlU2lnbmFsT3JOQX19XCIsXG4gICAgICBcIi0gUmVjb3Zlcnk6IHt7cmVjb3ZlcnlPck5BfX1cIixcbiAgICAgIFwiLSBNb25pdG9yaW5nIGdhcHM6IHt7Z2Fwc09yTm9uZX19XCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBEZXZpYXRpb25zXCIsXG4gICAgICBcInt7ZGV2aWF0aW9uc0Zyb21QbGFuX09SX25vbmV9fVwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyMgS25vd24gTGltaXRhdGlvbnNcIixcbiAgICAgIFwie3t3aGF0RG9lc250V29ya1lldF9PUl93aGF0V2FzRGVmZXJyZWRUb0xhdGVyU2xpY2VzfX1cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIEZvbGxvdy11cHNcIixcbiAgICAgIFwie3t3b3JrRGVmZXJyZWRPckRpc2NvdmVyZWREdXJpbmdFeGVjdXRpb25fT1Jfbm9uZX19XCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBGaWxlcyBDcmVhdGVkL01vZGlmaWVkXCIsXG4gICAgICBcIi0gYHt7ZmlsZVBhdGh9fWAgLSB7e2Rlc2NyaXB0aW9ufX1cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIEZvcndhcmQgSW50ZWxsaWdlbmNlXCIsXG4gICAgICBcIiMjIyBXaGF0IHRoZSBuZXh0IHNsaWNlIHNob3VsZCBrbm93XCIsXG4gICAgICBcIi0ge3tpbnNpZ2h0VGhhdFdvdWxkSGVscERvd25zdHJlYW1Xb3JrfX1cIixcbiAgICAgIFwiIyMjIFdoYXQncyBmcmFnaWxlXCIsXG4gICAgICBcIi0ge3tmcmFnaWxlQXJlYU9yVGhpbkltcGxlbWVudGF0aW9ufX0gLSB7e3doeUl0TWF0dGVyc319XCIsXG4gICAgICBcIiMjIyBBdXRob3JpdGF0aXZlIGRpYWdub3N0aWNzXCIsXG4gICAgICBcIi0ge3t3aGVyZUFGdXR1cmVBZ2VudFNob3VsZExvb2tGaXJzdH19IC0ge3t3aHlUaGlzU2lnbmFsSXNUcnVzdHdvcnRoeX19XCIsXG4gICAgICBcIiMjIyBXaGF0IGFzc3VtcHRpb25zIGNoYW5nZWRcIixcbiAgICAgIFwiLSB7e29yaWdpbmFsQXNzdW1wdGlvbn19IC0ge3t3aGF0QWN0dWFsbHlIYXBwZW5lZH19XCIsXG4gICAgXS5qb2luKFwiXFxuXCIpLFxuICB9O1xuXG4gIHJldHVybiBgJHtjb21wYWN0W25hbWVdfVxcblxcbiMjIyBPdXRwdXQgVGVtcGxhdGU6ICR7bGFiZWx9XFxuU291cmNlOiBcXGB0ZW1wbGF0ZXMvJHtuYW1lfS5tZFxcYGA7XG59XG5cbi8qKlxuICogQ29tcGFjdCBzbGljZS1zdW1tYXJ5IGV4Y2VycHQgZm9yIG1pbGVzdG9uZS1sZXZlbCBjbG9zZXJzICgjNDc4MCkuXG4gKlxuICogRW1pdHMgdGhlIGZyb250bWF0dGVyIGZpZWxkcyArIHNob3J0IGJvZHkgc2VjdGlvbiBoZWFkcyByYXRoZXIgdGhhbiB0aGVcbiAqIGZ1bGwgU1VNTUFSWS5tZCBib2R5LCBhbmQga2VlcHMgdGhlIHNvdXJjZSBwYXRoIGluIHRoZSBoZWFkZXIgc28gdGhlXG4gKiBjbG9zZXIgYWdlbnQgY2FuIFJlYWQgdGhlIGZ1bGwgZmlsZSBvbiBkZW1hbmQgd2hlbiBkcmFmdGluZyBMRUFSTklOR1MuXG4gKlxuICogU2NvcGU6IGRlc2lnbmVkIGZvciBgYnVpbGRDb21wbGV0ZU1pbGVzdG9uZVByb21wdGAsIHdoaWNoIHByZXZpb3VzbHlcbiAqIGlubGluZWQgdGhlIGZ1bGwgU1VNTUFSWSBwZXIgc2xpY2UgYW5kIHJvdXRpbmVseSBwYWlkIH4zMDBcdTIwMTM1MDBLIHRva2Vuc1xuICogcGVyIGNsb3NlIHdoZW4gdGhlIG5hcnJhdGl2ZSB3YXMgbmV2ZXIgc3ludGhlc2l6ZWQuIE5vdCB1c2VkIGJ5XG4gKiBgYnVpbGRWYWxpZGF0ZU1pbGVzdG9uZVByb21wdGAgeWV0IFx1MjAxNCB2YWxpZGF0ZSBuZWVkcyBmdWxsZXIgdmVyaWZpY2F0aW9uXG4gKiBldmlkZW5jZTsgZm9sbG93LXVwIFBSIGNhbiBleHRlbmQgb3IgcGFyYW1ldGVyaXplLlxuICpcbiAqIElmIHBhcnNpbmcgZmFpbHMgKHVucmVjb2duaXphYmxlIGZyb250bWF0dGVyLCBtaXNzaW5nIGlkLCBldGMuKSB0aGVcbiAqIGZ1bmN0aW9uIGZhbGxzIGJhY2sgdG8gYGlubGluZUZpbGVgIHNvIHRoZSBjbG9zZXIgbG9zZXMgbm8gaW5mb3JtYXRpb24uXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBidWlsZFNsaWNlU3VtbWFyeUV4Y2VycHQoXG4gIGFic1BhdGg6IHN0cmluZyB8IG51bGwsIHJlbFBhdGg6IHN0cmluZywgc2lkOiBzdHJpbmcsXG4pOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCBoZWFkZXIgPSBgIyMjICR7c2lkfSBTdW1tYXJ5IChleGNlcnB0KVxcblNvdXJjZTogXFxgJHtyZWxQYXRofVxcYGA7XG4gIGNvbnN0IGNvbnRlbnQgPSBhYnNQYXRoID8gYXdhaXQgbG9hZEZpbGUoYWJzUGF0aCkgOiBudWxsO1xuICBpZiAoIWNvbnRlbnQpIHtcbiAgICByZXR1cm4gYCR7aGVhZGVyfVxcblxcbl8obm90IGZvdW5kIFx1MjAxNCBmaWxlIGRvZXMgbm90IGV4aXN0IHlldClfYDtcbiAgfVxuICB0cnkge1xuICAgIGNvbnN0IHMgPSBwYXJzZVN1bW1hcnkoY29udGVudCk7XG4gICAgaWYgKCFzLmZyb250bWF0dGVyLmlkKSB7XG4gICAgICAvLyBVbnJlY29nbml6YWJsZSBcdTIwMTQgZmFsbCBiYWNrIHRvIGZ1bGwgZmlsZSBzbyBubyBjb250ZXh0IGlzIGxvc3QuXG4gICAgICByZXR1cm4gYCMjIyAke3NpZH0gU3VtbWFyeVxcblNvdXJjZTogXFxgJHtyZWxQYXRofVxcYFxcblxcbiR7Y29udGVudC50cmltKCl9YDtcbiAgICB9XG4gICAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW2hlYWRlciwgXCJcIl07XG4gICAgaWYgKHMudGl0bGUpIGxpbmVzLnB1c2goYCoqVGl0bGU6KiogJHtzLnRpdGxlfWApO1xuICAgIGlmIChzLm9uZUxpbmVyKSBsaW5lcy5wdXNoKGAqKk9uZS1saW5lcjoqKiAke3Mub25lTGluZXJ9YCk7XG4gICAgaWYgKHMuZnJvbnRtYXR0ZXIudmVyaWZpY2F0aW9uX3Jlc3VsdCkge1xuICAgICAgbGluZXMucHVzaChgKipWZXJpZmljYXRpb246KiogXFxgJHtzLmZyb250bWF0dGVyLnZlcmlmaWNhdGlvbl9yZXN1bHR9XFxgYCk7XG4gICAgfVxuICAgIGxpbmVzLnB1c2goYCoqQmxvY2tlcnM6KiogJHtzLmZyb250bWF0dGVyLmJsb2NrZXJfZGlzY292ZXJlZCA/IFwiXHUyNkEwXHVGRTBGIGJsb2NrZXIgcmVjb3JkZWQgXHUyMDE0IFJlYWQgZnVsbCBzdW1tYXJ5XCIgOiBcIm5vbmVcIn1gKTtcbiAgICBpZiAocy5mcm9udG1hdHRlci5kdXJhdGlvbikgbGluZXMucHVzaChgKipEdXJhdGlvbjoqKiAke3MuZnJvbnRtYXR0ZXIuZHVyYXRpb259YCk7XG4gICAgaWYgKHMuZnJvbnRtYXR0ZXIucHJvdmlkZXMubGVuZ3RoID4gMCkgbGluZXMucHVzaChgKipQcm92aWRlczoqKiAke3MuZnJvbnRtYXR0ZXIucHJvdmlkZXMuam9pbihcIjsgXCIpfWApO1xuICAgIGlmIChzLmZyb250bWF0dGVyLmFmZmVjdHMubGVuZ3RoID4gMCkgbGluZXMucHVzaChgKipBZmZlY3RzOioqICR7cy5mcm9udG1hdHRlci5hZmZlY3RzLmpvaW4oXCI7IFwiKX1gKTtcbiAgICBpZiAocy5mcm9udG1hdHRlci5rZXlfZGVjaXNpb25zLmxlbmd0aCA+IDApIGxpbmVzLnB1c2goYCoqS2V5IGRlY2lzaW9uczoqKiAke3MuZnJvbnRtYXR0ZXIua2V5X2RlY2lzaW9ucy5qb2luKFwiOyBcIil9YCk7XG4gICAgaWYgKHMuZnJvbnRtYXR0ZXIucGF0dGVybnNfZXN0YWJsaXNoZWQubGVuZ3RoID4gMCkgbGluZXMucHVzaChgKipQYXR0ZXJucyBlc3RhYmxpc2hlZDoqKiAke3MuZnJvbnRtYXR0ZXIucGF0dGVybnNfZXN0YWJsaXNoZWQuam9pbihcIjsgXCIpfWApO1xuICAgIGlmIChzLmZyb250bWF0dGVyLmtleV9maWxlcy5sZW5ndGggPiAwKSB7XG4gICAgICBjb25zdCBmaWxlcyA9IHMuZnJvbnRtYXR0ZXIua2V5X2ZpbGVzLnNsaWNlKDAsIDgpO1xuICAgICAgY29uc3QgbW9yZSA9IHMuZnJvbnRtYXR0ZXIua2V5X2ZpbGVzLmxlbmd0aCA+IGZpbGVzLmxlbmd0aCA/IGAgKCske3MuZnJvbnRtYXR0ZXIua2V5X2ZpbGVzLmxlbmd0aCAtIGZpbGVzLmxlbmd0aH0gbW9yZSlgIDogXCJcIjtcbiAgICAgIGxpbmVzLnB1c2goYCoqS2V5IGZpbGVzOioqICR7ZmlsZXMuam9pbihcIiwgXCIpfSR7bW9yZX1gKTtcbiAgICB9XG5cbiAgICAvLyBDYXAgc2VjdGlvbiBib2RpZXMgKGNvZGVyYWJiaXQgcmV2aWV3IG9uICM0OTA4KTogaWYgYW55IG9mIHRoZXNlXG4gICAgLy8gbmFycmF0aXZlIHNlY3Rpb25zIGJhbGxvb24sIGV4Y2VycHQgbW9kZSBzdGlsbCBpbmZsYXRlcyBhbmRcbiAgICAvLyB1bmRlcm1pbmVzIHRoZSB0b2tlbi1yZWR1Y3Rpb24gZ29hbC4gODAwIGNoYXJzICh+MjAwIHRva2VucykgaXNcbiAgICAvLyBlbm91Z2ggdG8gY2FycnkgaW50ZW50OyB0aGUgY2xvc2VyIGFnZW50IFJlYWRzIHRoZSBmdWxsIGZpbGUgd2hlblxuICAgIC8vIGl0IG5lZWRzIHJpY2hlciBjb250ZXh0IGZvciBMRUFSTklOR1Mgc3ludGhlc2lzLlxuICAgIGNvbnN0IFNFQ1RJT05fQ0FQX0NIQVJTID0gODAwO1xuICAgIGNvbnN0IGNhcFNlY3Rpb24gPSAoYm9keTogc3RyaW5nKTogc3RyaW5nID0+IHtcbiAgICAgIGNvbnN0IHRyaW1tZWQgPSBib2R5LnRyaW0oKTtcbiAgICAgIGlmICh0cmltbWVkLmxlbmd0aCA8PSBTRUNUSU9OX0NBUF9DSEFSUykgcmV0dXJuIHRyaW1tZWQ7XG4gICAgICByZXR1cm4gYCR7dHJpbW1lZC5zbGljZSgwLCBTRUNUSU9OX0NBUF9DSEFSUyl9XFxuXHUyMDI2ICh0cnVuY2F0ZWQgXHUyMDE0IHNlZSBmdWxsIFxcYCR7cmVsUGF0aH1cXGApYDtcbiAgICB9O1xuXG4gICAgaWYgKHMuZGV2aWF0aW9ucyAmJiBzLmRldmlhdGlvbnMudHJpbSgpKSB7XG4gICAgICBsaW5lcy5wdXNoKFwiXCIsIFwiIyMjIyBEZXZpYXRpb25zXCIsIGNhcFNlY3Rpb24ocy5kZXZpYXRpb25zKSk7XG4gICAgfVxuICAgIGlmIChzLmtub3duTGltaXRhdGlvbnMgJiYgcy5rbm93bkxpbWl0YXRpb25zLnRyaW0oKSkge1xuICAgICAgbGluZXMucHVzaChcIlwiLCBcIiMjIyMgS25vd24gbGltaXRhdGlvbnNcIiwgY2FwU2VjdGlvbihzLmtub3duTGltaXRhdGlvbnMpKTtcbiAgICB9XG4gICAgaWYgKHMuZm9sbG93VXBzICYmIHMuZm9sbG93VXBzLnRyaW0oKSkge1xuICAgICAgbGluZXMucHVzaChcIlwiLCBcIiMjIyMgRm9sbG93LXVwc1wiLCBjYXBTZWN0aW9uKHMuZm9sbG93VXBzKSk7XG4gICAgfVxuXG4gICAgbGluZXMucHVzaChcbiAgICAgIFwiXCIsXG4gICAgICBgPiAqKk9uLWRlbWFuZDoqKiByZWFkIFxcYCR7cmVsUGF0aH1cXGAgZm9yIHRoZSBmdWxsIFwiV2hhdCBIYXBwZW5lZFwiIG5hcnJhdGl2ZSwgaW50ZWdyYXRpb24gbm90ZXMsIGFuZCBkZXRhaWxlZCBmaWxlLWNoYW5nZSBsaXN0IHdoZW4gZHJhZnRpbmcgTEVBUk5JTkdTLCB0aGUgRGVjaXNpb24gUmUtZXZhbHVhdGlvbiB0YWJsZSwgb3IgY3Jvc3Mtc2xpY2Ugc3ludGhlc2lzLmAsXG4gICAgKTtcbiAgICByZXR1cm4gbGluZXMuam9pbihcIlxcblwiKTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gRGVmZW5zaXZlIFx1MjAxNCBhbnkgcGFyc2UgZmFpbHVyZSBmYWxscyBiYWNrIHRvIGZ1bGwgaW5saW5lLlxuICAgIHJldHVybiBgIyMjICR7c2lkfSBTdW1tYXJ5XFxuU291cmNlOiBcXGAke3JlbFBhdGh9XFxgXFxuXFxuJHtjYXBNYWxmb3JtZWRTdW1tYXJ5KGNvbnRlbnQsIHJlbFBhdGgpfWA7XG4gIH1cbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGJ1aWxkVGFza1N1bW1hcnlFeGNlcnB0KFxuICBhYnNQYXRoOiBzdHJpbmcgfCBudWxsLCByZWxQYXRoOiBzdHJpbmcsIHRpZDogc3RyaW5nLCBvcHRpb25zPzogeyBibG9ja2VyPzogYm9vbGVhbiB9LFxuKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgY29uc3QgbGFiZWwgPSBvcHRpb25zPy5ibG9ja2VyID8gXCJCbG9ja2VyIFRhc2sgU3VtbWFyeVwiIDogXCJUYXNrIFN1bW1hcnlcIjtcbiAgY29uc3QgaGVhZGVyID0gYCMjIyAke2xhYmVsfTogJHt0aWR9IChleGNlcnB0KVxcblNvdXJjZTogXFxgJHtyZWxQYXRofVxcYGA7XG4gIGNvbnN0IGNvbnRlbnQgPSBhYnNQYXRoID8gYXdhaXQgbG9hZEZpbGUoYWJzUGF0aCkgOiBudWxsO1xuICBpZiAoIWNvbnRlbnQpIHtcbiAgICByZXR1cm4gYCR7aGVhZGVyfVxcblxcbl8obm90IGZvdW5kIFx1MjAxNCBmaWxlIGRvZXMgbm90IGV4aXN0IHlldClfYDtcbiAgfVxuXG4gIHRyeSB7XG4gICAgY29uc3QgcyA9IHBhcnNlU3VtbWFyeShjb250ZW50KTtcbiAgICBpZiAoIXMuZnJvbnRtYXR0ZXIuaWQpIHtcbiAgICAgIHJldHVybiBgIyMjICR7bGFiZWx9OiAke3RpZH1cXG5Tb3VyY2U6IFxcYCR7cmVsUGF0aH1cXGBcXG5cXG4ke2NhcE1hbGZvcm1lZFN1bW1hcnkoY29udGVudCwgcmVsUGF0aCl9YDtcbiAgICB9XG5cbiAgICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbaGVhZGVyLCBcIlwiXTtcbiAgICBpZiAocy50aXRsZSkgbGluZXMucHVzaChgKipUaXRsZToqKiAke3MudGl0bGV9YCk7XG4gICAgaWYgKHMub25lTGluZXIpIGxpbmVzLnB1c2goYCoqT25lLWxpbmVyOioqICR7cy5vbmVMaW5lcn1gKTtcbiAgICBpZiAocy5mcm9udG1hdHRlci52ZXJpZmljYXRpb25fcmVzdWx0KSB7XG4gICAgICBsaW5lcy5wdXNoKGAqKlZlcmlmaWNhdGlvbjoqKiBcXGAke3MuZnJvbnRtYXR0ZXIudmVyaWZpY2F0aW9uX3Jlc3VsdH1cXGBgKTtcbiAgICB9XG4gICAgbGluZXMucHVzaChgKipCbG9ja2VyIGRpc2NvdmVyZWQ6KiogJHtzLmZyb250bWF0dGVyLmJsb2NrZXJfZGlzY292ZXJlZCA/IFwieWVzIFx1MjAxNCByZWFkIGZ1bGwgc3VtbWFyeSBpZiBibG9ja2VyIGRldGFpbHMgYXJlIGluc3VmZmljaWVudFwiIDogXCJub1wifWApO1xuICAgIGlmIChzLmZyb250bWF0dGVyLnByb3ZpZGVzLmxlbmd0aCA+IDApIGxpbmVzLnB1c2goYCoqUHJvdmlkZXM6KiogJHtzLmZyb250bWF0dGVyLnByb3ZpZGVzLnNsaWNlKDAsIDQpLmpvaW4oXCI7IFwiKX1gKTtcbiAgICBpZiAocy5mcm9udG1hdHRlci5rZXlfZGVjaXNpb25zLmxlbmd0aCA+IDApIGxpbmVzLnB1c2goYCoqS2V5IGRlY2lzaW9uczoqKiAke3MuZnJvbnRtYXR0ZXIua2V5X2RlY2lzaW9ucy5zbGljZSgwLCA0KS5qb2luKFwiOyBcIil9YCk7XG4gICAgaWYgKHMuZnJvbnRtYXR0ZXIucGF0dGVybnNfZXN0YWJsaXNoZWQubGVuZ3RoID4gMCkgbGluZXMucHVzaChgKipQYXR0ZXJucyBlc3RhYmxpc2hlZDoqKiAke3MuZnJvbnRtYXR0ZXIucGF0dGVybnNfZXN0YWJsaXNoZWQuc2xpY2UoMCwgNCkuam9pbihcIjsgXCIpfWApO1xuICAgIGlmIChzLmZyb250bWF0dGVyLmtleV9maWxlcy5sZW5ndGggPiAwKSB7XG4gICAgICBjb25zdCBmaWxlcyA9IHMuZnJvbnRtYXR0ZXIua2V5X2ZpbGVzLnNsaWNlKDAsIDYpO1xuICAgICAgY29uc3QgbW9yZSA9IHMuZnJvbnRtYXR0ZXIua2V5X2ZpbGVzLmxlbmd0aCA+IGZpbGVzLmxlbmd0aCA/IGAgKCske3MuZnJvbnRtYXR0ZXIua2V5X2ZpbGVzLmxlbmd0aCAtIGZpbGVzLmxlbmd0aH0gbW9yZSlgIDogXCJcIjtcbiAgICAgIGxpbmVzLnB1c2goYCoqS2V5IGZpbGVzOioqICR7ZmlsZXMuam9pbihcIiwgXCIpfSR7bW9yZX1gKTtcbiAgICB9XG5cbiAgICBjb25zdCBTRUNUSU9OX0NBUF9DSEFSUyA9IDUwMDtcbiAgICBjb25zdCBjYXBTZWN0aW9uID0gKGJvZHk6IHN0cmluZyk6IHN0cmluZyA9PiB7XG4gICAgICBjb25zdCB0cmltbWVkID0gYm9keS50cmltKCk7XG4gICAgICBpZiAodHJpbW1lZC5sZW5ndGggPD0gU0VDVElPTl9DQVBfQ0hBUlMpIHJldHVybiB0cmltbWVkO1xuICAgICAgcmV0dXJuIGAke3RyaW1tZWQuc2xpY2UoMCwgU0VDVElPTl9DQVBfQ0hBUlMpfVxcblx1MjAyNiAodHJ1bmNhdGVkIFx1MjAxNCBzZWUgZnVsbCBcXGAke3JlbFBhdGh9XFxgKWA7XG4gICAgfTtcblxuICAgIGNvbnN0IHZlcmlmaWNhdGlvbiA9IGV4dHJhY3RNYXJrZG93blNlY3Rpb24oY29udGVudCwgXCJWZXJpZmljYXRpb25cIik7XG4gICAgY29uc3QgZGlhZ25vc3RpY3MgPSBleHRyYWN0TWFya2Rvd25TZWN0aW9uKGNvbnRlbnQsIFwiRGlhZ25vc3RpY3NcIik7XG4gICAgY29uc3Qga25vd25Jc3N1ZXMgPSBleHRyYWN0TWFya2Rvd25TZWN0aW9uKGNvbnRlbnQsIFwiS25vd24gSXNzdWVzXCIpO1xuXG4gICAgaWYgKHZlcmlmaWNhdGlvbiAmJiB2ZXJpZmljYXRpb24udHJpbSgpKSB7XG4gICAgICBsaW5lcy5wdXNoKFwiXCIsIFwiIyMjIyBWZXJpZmljYXRpb25cIiwgY2FwU2VjdGlvbih2ZXJpZmljYXRpb24pKTtcbiAgICB9XG4gICAgaWYgKGRpYWdub3N0aWNzICYmIGRpYWdub3N0aWNzLnRyaW0oKSkge1xuICAgICAgbGluZXMucHVzaChcIlwiLCBcIiMjIyMgRGlhZ25vc3RpY3NcIiwgY2FwU2VjdGlvbihkaWFnbm9zdGljcykpO1xuICAgIH1cbiAgICBpZiAocy5kZXZpYXRpb25zICYmIHMuZGV2aWF0aW9ucy50cmltKCkpIHtcbiAgICAgIGxpbmVzLnB1c2goXCJcIiwgXCIjIyMjIERldmlhdGlvbnNcIiwgY2FwU2VjdGlvbihzLmRldmlhdGlvbnMpKTtcbiAgICB9XG4gICAgaWYgKGtub3duSXNzdWVzICYmIGtub3duSXNzdWVzLnRyaW0oKSkge1xuICAgICAgbGluZXMucHVzaChcIlwiLCBcIiMjIyMgS25vd24gaXNzdWVzXCIsIGNhcFNlY3Rpb24oa25vd25Jc3N1ZXMpKTtcbiAgICB9XG5cbiAgICBsaW5lcy5wdXNoKFxuICAgICAgXCJcIixcbiAgICAgIGA+ICoqT24tZGVtYW5kOioqIHJlYWQgXFxgJHtyZWxQYXRofVxcYCBvbmx5IHdoZW4gdGhpcyBleGNlcnB0IGlzIGFic2VudC90cnVuY2F0ZWQgb3IgeW91IG5lZWQgZnVsbGVyIGJsb2NrZXIsIGltcGxlbWVudGF0aW9uLCBvciBmaWxlLWNoYW5nZSBldmlkZW5jZS5gLFxuICAgICk7XG4gICAgcmV0dXJuIGxpbmVzLmpvaW4oXCJcXG5cIik7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBgIyMjICR7bGFiZWx9OiAke3RpZH1cXG5Tb3VyY2U6IFxcYCR7cmVsUGF0aH1cXGBcXG5cXG4ke2NhcE1hbGZvcm1lZFN1bW1hcnkoY29udGVudCwgcmVsUGF0aCl9YDtcbiAgfVxufVxuXG5mdW5jdGlvbiBjYXBNYWxmb3JtZWRTdW1tYXJ5KGNvbnRlbnQ6IHN0cmluZywgcmVsUGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgdHJpbW1lZCA9IGNvbnRlbnQudHJpbSgpO1xuICBjb25zdCBsaW1pdCA9IDFfNTAwO1xuICBpZiAodHJpbW1lZC5sZW5ndGggPD0gbGltaXQpIHJldHVybiB0cmltbWVkO1xuICByZXR1cm4gYCR7dHJpbW1lZC5zbGljZSgwLCBsaW1pdCkudHJpbUVuZCgpfVxcblxcbltUcnVuY2F0ZWQgbWFsZm9ybWVkIHN1bW1hcnkgXHUyMDE0IHJlYWQgXFxgJHtyZWxQYXRofVxcYCBmb3IgZnVsbCBkZXRhaWxzLl1gO1xufVxuXG4vKipcbiAqIExvYWQgYW5kIGlubGluZSBkZXBlbmRlbmN5IHNsaWNlIHN1bW1hcmllcyAoZnVsbCBjb250ZW50LCBub3QganVzdCBwYXRocykuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBpbmxpbmVEZXBlbmRlbmN5U3VtbWFyaWVzKFxuICBtaWQ6IHN0cmluZywgc2lkOiBzdHJpbmcsIGJhc2U6IHN0cmluZywgYnVkZ2V0Q2hhcnM/OiBudW1iZXIsXG4pOiBQcm9taXNlPHN0cmluZz4ge1xuICAvLyBEQiBwcmltYXJ5IHBhdGggXHUyMDE0IGdldCBzbGljZSBkZXBlbmRzIGRpcmVjdGx5XG4gIGxldCBkZXBlbmRzOiBzdHJpbmdbXSB8IG51bGwgPSBudWxsO1xuICB0cnkge1xuICAgIGNvbnN0IHsgaXNEYkF2YWlsYWJsZSwgZ2V0U2xpY2UgfSA9IGF3YWl0IGltcG9ydChcIi4vZ3NkLWRiLmpzXCIpO1xuICAgIGlmIChpc0RiQXZhaWxhYmxlKCkpIHtcbiAgICAgIGNvbnN0IHNsaWNlID0gZ2V0U2xpY2UobWlkLCBzaWQpO1xuICAgICAgaWYgKHNsaWNlKSB7XG4gICAgICAgIGlmIChzbGljZS5kZXBlbmRzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIFwiLSAobm8gZGVwZW5kZW5jaWVzKVwiO1xuICAgICAgICBkZXBlbmRzID0gc2xpY2UuZGVwZW5kcyBhcyBzdHJpbmdbXTtcbiAgICAgIH1cbiAgICAgIC8vIElmIHNsaWNlIG5vdCBmb3VuZCBpbiBEQiwgZmFsbCB0aHJvdWdoIHRvIGZpbGUtYmFzZWQgcGFyc2luZ1xuICAgIH1cbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgbG9nV2FybmluZyhcInByb21wdFwiLCBgaW5saW5lRGVwZW5kZW5jeVN1bW1hcmllcyBEQiBsb29rdXAgZmFpbGVkOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gKTtcbiAgfVxuXG4gIC8vIElmIERCIGRpZG4ndCBwcm92aWRlIGRlcGVuZHMsIGZhbGwgYmFjayB0byByb2FkbWFwIHBhcnNpbmdcbiAgaWYgKCFkZXBlbmRzKSB7XG4gICAgY29uc3Qgcm9hZG1hcFBhdGggPSByZXNvbHZlTWlsZXN0b25lRmlsZShiYXNlLCBtaWQsIFwiUk9BRE1BUFwiKTtcbiAgICBpZiAocm9hZG1hcFBhdGgpIHtcbiAgICAgIGNvbnN0IHJvYWRtYXBDb250ZW50ID0gYXdhaXQgbG9hZEZpbGUocm9hZG1hcFBhdGgpO1xuICAgICAgaWYgKHJvYWRtYXBDb250ZW50KSB7XG4gICAgICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlUm9hZG1hcChyb2FkbWFwQ29udGVudCk7XG4gICAgICAgIGNvbnN0IHNsaWNlID0gcGFyc2VkLnNsaWNlcy5maW5kKHMgPT4gcy5pZCA9PT0gc2lkKTtcbiAgICAgICAgaWYgKHNsaWNlICYmIHNsaWNlLmRlcGVuZHMubGVuZ3RoID4gMCkge1xuICAgICAgICAgIGRlcGVuZHMgPSBzbGljZS5kZXBlbmRzO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIGlmICghZGVwZW5kcykge1xuICAgICAgcmV0dXJuIFwiLSAobm8gZGVwZW5kZW5jaWVzKVwiO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IHNlY3Rpb25zOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGZvciAoY29uc3QgZGVwIG9mIGRlcGVuZHMpIHtcbiAgICBpZiAoc2Vlbi5oYXMoZGVwKSkgY29udGludWU7XG4gICAgc2Vlbi5hZGQoZGVwKTtcbiAgICBjb25zdCBzdW1tYXJ5RmlsZSA9IHJlc29sdmVTbGljZUZpbGUoYmFzZSwgbWlkLCBkZXAsIFwiU1VNTUFSWVwiKTtcbiAgICBjb25zdCBzdW1tYXJ5Q29udGVudCA9IHN1bW1hcnlGaWxlID8gYXdhaXQgbG9hZEZpbGUoc3VtbWFyeUZpbGUpIDogbnVsbDtcbiAgICBjb25zdCByZWxQYXRoID0gcmVsU2xpY2VGaWxlKGJhc2UsIG1pZCwgZGVwLCBcIlNVTU1BUllcIik7XG4gICAgaWYgKHN1bW1hcnlDb250ZW50KSB7XG4gICAgICBzZWN0aW9ucy5wdXNoKGAjIyMjICR7ZGVwfSBTdW1tYXJ5XFxuU291cmNlOiBcXGAke3JlbFBhdGh9XFxgXFxuXFxuJHtzdW1tYXJ5Q29udGVudC50cmltKCl9YCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHNlY3Rpb25zLnB1c2goYC0gXFxgJHtyZWxQYXRofVxcYCBfKG5vdCBmb3VuZClfYCk7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgcmVzdWx0ID0gc2VjdGlvbnMuam9pbihcIlxcblxcblwiKTtcbiAgaWYgKGJ1ZGdldENoYXJzICE9PSB1bmRlZmluZWQgJiYgcmVzdWx0Lmxlbmd0aCA+IGJ1ZGdldENoYXJzKSB7XG4gICAgcmV0dXJuIHRydW5jYXRlQXRTZWN0aW9uQm91bmRhcnkocmVzdWx0LCBidWRnZXRDaGFycykuY29udGVudDtcbiAgfVxuICByZXR1cm4gcmVzdWx0O1xufVxuXG4vKipcbiAqIExvYWQgYSB3ZWxsLWtub3duIC5nc2QvIHJvb3QgZmlsZSBmb3Igb3B0aW9uYWwgaW5saW5pbmcuXG4gKiBIYW5kbGVzIHRoZSBleGlzdHNTeW5jIGNoZWNrIGludGVybmFsbHkuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBpbmxpbmVHc2RSb290RmlsZShcbiAgYmFzZTogc3RyaW5nLCBmaWxlbmFtZTogc3RyaW5nLCBsYWJlbDogc3RyaW5nLFxuKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG4gIGNvbnN0IGtleSA9IGZpbGVuYW1lLnJlcGxhY2UoL1xcLm1kJC9pLCBcIlwiKS50b1VwcGVyQ2FzZSgpIGFzIFwiUFJPSkVDVFwiIHwgXCJERUNJU0lPTlNcIiB8IFwiUVVFVUVcIiB8IFwiU1RBVEVcIiB8IFwiUkVRVUlSRU1FTlRTXCIgfCBcIktOT1dMRURHRVwiO1xuICBjb25zdCBhYnNQYXRoID0gcmVzb2x2ZUdzZFJvb3RGaWxlKGJhc2UsIGtleSk7XG4gIGlmICghZXhpc3RzU3luYyhhYnNQYXRoKSkgcmV0dXJuIG51bGw7XG4gIHJldHVybiBpbmxpbmVGaWxlT3B0aW9uYWwoYWJzUGF0aCwgcmVsR3NkUm9vdEZpbGUoa2V5KSwgbGFiZWwpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgREItQXdhcmUgSW5saW5lIEhlbHBlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogSW5saW5lIGRlY2lzaW9ucyB3aXRoIG9wdGlvbmFsIG1pbGVzdG9uZSBzY29waW5nIGZyb20gdGhlIERCLlxuICogRmFsbHMgYmFjayB0byBmaWxlc3lzdGVtIHZpYSBpbmxpbmVHc2RSb290RmlsZSBvbmx5IHdoZW4gREIgaXMgdW5hdmFpbGFibGUuXG4gKlxuICogQ2FzY2FkZSBsb2dpYyAoUjAwNSk6XG4gKiAxLiBRdWVyeSB3aXRoIHsgbWlsZXN0b25lSWQsIHNjb3BlIH0gaWYgc2NvcGUgcHJvdmlkZWRcbiAqIDIuIElmIGVtcHR5IEFORCBzY29wZSB3YXMgcHJvdmlkZWQsIHJldHJ5IHdpdGggeyBtaWxlc3RvbmVJZCB9IG9ubHkgKGRyb3Agc2NvcGUpXG4gKiAzLiBJZiBzdGlsbCBlbXB0eSwgcmV0dXJuIG51bGwgKGludGVudGlvbmFsIHBlciBEMDIwKVxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaW5saW5lRGVjaXNpb25zRnJvbURiKFxuICBiYXNlOiBzdHJpbmcsIG1pbGVzdG9uZUlkPzogc3RyaW5nLCBzY29wZT86IHN0cmluZywgbGV2ZWw/OiBJbmxpbmVMZXZlbCxcbik6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICBjb25zdCBpbmxpbmVMZXZlbCA9IGxldmVsID8/IHJlc29sdmVJbmxpbmVMZXZlbCgpO1xuICB0cnkge1xuICAgIGNvbnN0IHsgaXNEYkF2YWlsYWJsZSB9ID0gYXdhaXQgaW1wb3J0KFwiLi9nc2QtZGIuanNcIik7XG4gICAgaWYgKGlzRGJBdmFpbGFibGUoKSkge1xuICAgICAgLy8gQURSLTAxMyBQaGFzZSA2IGN1dG92ZXIgKFN0YWdlIDEpOiByZWFkIGRlY2lzaW9ucyBmcm9tIHRoZSBgbWVtb3JpZXNgXG4gICAgICAvLyB0YWJsZS4gQm90aCBgcXVlcnlEZWNpc2lvbnNgIChsZWdhY3kpIGFuZCBgcXVlcnlEZWNpc2lvbnNGcm9tTWVtb3JpZXNgXG4gICAgICAvLyByZXR1cm4gaWRlbnRpY2FsIERlY2lzaW9uW10gZm9yIGFjdGl2ZSByb3dzIG9uY2UgUGhhc2UgNSBkdWFsLXdyaXRlIGlzXG4gICAgICAvLyBjYXVnaHQgdXAuIFN3aXRjaGluZyB0aGUgcmVhZCBoZXJlIGxldHMgdGhlIGRlc3RydWN0aXZlIFBoYXNlIDYgc3RlcFxuICAgICAgLy8gKCM1NzU1KSByZXRpcmUgdGhlIGxlZ2FjeSBgZGVjaXNpb25zYCB0YWJsZSB3aXRob3V0IGNoYW5naW5nIHByb21wdFxuICAgICAgLy8gY29udGVudHMuIFByb2plY3Rpb24gcmVnZW4gKGBERUNJU0lPTlMubWRgKSBzdGlsbCBzb3VyY2VzIGZyb20gdGhlXG4gICAgICAvLyBsZWdhY3kgdGFibGUgXHUyMDE0IHRoYXQgc3dpdGNoIGxhbmRzIHNlcGFyYXRlbHkgdG8gaGFuZGxlIHN1cGVyc2VkZWRcbiAgICAgIC8vIGhpc3RvcnkgY2xlYW5seS5cbiAgICAgIGNvbnN0IHsgcXVlcnlEZWNpc2lvbnNGcm9tTWVtb3JpZXMsIGZvcm1hdERlY2lzaW9uc0ZvclByb21wdCB9ID0gYXdhaXQgaW1wb3J0KFwiLi9jb250ZXh0LXN0b3JlLmpzXCIpO1xuXG4gICAgICAvLyBGaXJzdCBxdWVyeTogdHJ5IHdpdGggYm90aCBtaWxlc3RvbmVJZCBhbmQgc2NvcGUgKGlmIHNjb3BlIHByb3ZpZGVkKVxuICAgICAgbGV0IGRlY2lzaW9ucyA9IHF1ZXJ5RGVjaXNpb25zRnJvbU1lbW9yaWVzKHsgbWlsZXN0b25lSWQsIHNjb3BlIH0pO1xuXG4gICAgICAvLyBDYXNjYWRlOiBpZiBlbXB0eSBBTkQgc2NvcGUgd2FzIHByb3ZpZGVkLCByZXRyeSB3aXRob3V0IHNjb3BlXG4gICAgICBpZiAoZGVjaXNpb25zLmxlbmd0aCA9PT0gMCAmJiBzY29wZSkge1xuICAgICAgICBkZWNpc2lvbnMgPSBxdWVyeURlY2lzaW9uc0Zyb21NZW1vcmllcyh7IG1pbGVzdG9uZUlkIH0pO1xuICAgICAgfVxuXG4gICAgICBpZiAoZGVjaXNpb25zLmxlbmd0aCA+IDApIHtcbiAgICAgICAgLy8gVXNlIGNvbXBhY3QgZm9ybWF0IGZvciBub24tZnVsbCBsZXZlbHMgdG8gc2F2ZSB+MzUlIHRva2Vuc1xuICAgICAgICBjb25zdCBmb3JtYXR0ZWQgPSBpbmxpbmVMZXZlbCAhPT0gXCJmdWxsXCJcbiAgICAgICAgICA/IGZvcm1hdERlY2lzaW9uc0NvbXBhY3QoZGVjaXNpb25zKVxuICAgICAgICAgIDogZm9ybWF0RGVjaXNpb25zRm9yUHJvbXB0KGRlY2lzaW9ucyk7XG4gICAgICAgIHJldHVybiBgIyMjIERlY2lzaW9uc1xcblNvdXJjZTogXFxgLmdzZC9ERUNJU0lPTlMubWRcXGBcXG5cXG4ke2Zvcm1hdHRlZH1gO1xuICAgICAgfVxuICAgICAgLy8gREIgYXZhaWxhYmxlIGJ1dCBjYXNjYWRlIHJldHVybmVkIGVtcHR5IFx1MjAxNCBpbnRlbnRpb25hbCBwZXIgRDAyMCwgZG9uJ3QgZmFsbCBiYWNrIHRvIGZpbGVcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgbG9nV2FybmluZyhcInByb21wdFwiLCBgaW5saW5lRGVjaXNpb25zRnJvbURiIGZhaWxlZDogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCk7XG4gIH1cbiAgLy8gREIgdW5hdmFpbGFibGUgXHUyMDE0IGZhbGwgYmFjayB0byBmaWxlc3lzdGVtXG4gIHJldHVybiBpbmxpbmVHc2RSb290RmlsZShiYXNlLCBcImRlY2lzaW9ucy5tZFwiLCBcIkRlY2lzaW9uc1wiKTtcbn1cblxuLyoqXG4gKiBJbmxpbmUgcmVxdWlyZW1lbnRzIHdpdGggb3B0aW9uYWwgbWlsZXN0b25lIGFuZCBzbGljZSBzY29waW5nIGZyb20gdGhlIERCLlxuICogRmFsbHMgYmFjayB0byBmaWxlc3lzdGVtIHZpYSBpbmxpbmVHc2RSb290RmlsZSB3aGVuIERCIHVuYXZhaWxhYmxlIG9yIGVtcHR5LlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaW5saW5lUmVxdWlyZW1lbnRzRnJvbURiKFxuICBiYXNlOiBzdHJpbmcsIG1pbGVzdG9uZUlkPzogc3RyaW5nLCBzbGljZUlkPzogc3RyaW5nLCBsZXZlbD86IElubGluZUxldmVsLFxuKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG4gIGNvbnN0IGlubGluZUxldmVsID0gbGV2ZWwgPz8gcmVzb2x2ZUlubGluZUxldmVsKCk7XG4gIHRyeSB7XG4gICAgY29uc3QgeyBpc0RiQXZhaWxhYmxlIH0gPSBhd2FpdCBpbXBvcnQoXCIuL2dzZC1kYi5qc1wiKTtcbiAgICBpZiAoaXNEYkF2YWlsYWJsZSgpKSB7XG4gICAgICBjb25zdCB7IHF1ZXJ5UmVxdWlyZW1lbnRzLCBmb3JtYXRSZXF1aXJlbWVudHNGb3JQcm9tcHQgfSA9IGF3YWl0IGltcG9ydChcIi4vY29udGV4dC1zdG9yZS5qc1wiKTtcbiAgICAgIGNvbnN0IHJlcXVpcmVtZW50cyA9IHF1ZXJ5UmVxdWlyZW1lbnRzKHsgbWlsZXN0b25lSWQsIHNsaWNlSWQgfSk7XG4gICAgICBpZiAocmVxdWlyZW1lbnRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgLy8gVXNlIGNvbXBhY3QgZm9ybWF0IGZvciBub24tZnVsbCBsZXZlbHMgdG8gc2F2ZSB+NDAlIHRva2Vuc1xuICAgICAgICBjb25zdCBmb3JtYXR0ZWQgPSBpbmxpbmVMZXZlbCAhPT0gXCJmdWxsXCJcbiAgICAgICAgICA/IGZvcm1hdFJlcXVpcmVtZW50c0NvbXBhY3QocmVxdWlyZW1lbnRzKVxuICAgICAgICAgIDogZm9ybWF0UmVxdWlyZW1lbnRzRm9yUHJvbXB0KHJlcXVpcmVtZW50cyk7XG4gICAgICAgIHJldHVybiBgIyMjIFJlcXVpcmVtZW50c1xcblNvdXJjZTogXFxgLmdzZC9SRVFVSVJFTUVOVFMubWRcXGBcXG5cXG4ke2Zvcm1hdHRlZH1gO1xuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgbG9nV2FybmluZyhcInByb21wdFwiLCBgaW5saW5lUmVxdWlyZW1lbnRzRnJvbURiIGZhaWxlZDogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCk7XG4gIH1cbiAgcmV0dXJuIGlubGluZUdzZFJvb3RGaWxlKGJhc2UsIFwicmVxdWlyZW1lbnRzLm1kXCIsIFwiUmVxdWlyZW1lbnRzXCIpO1xufVxuXG4vKipcbiAqIElubGluZSBwcm9qZWN0IGNvbnRleHQgZnJvbSB0aGUgREIuXG4gKiBGYWxscyBiYWNrIHRvIGZpbGVzeXN0ZW0gdmlhIGlubGluZUdzZFJvb3RGaWxlIHdoZW4gREIgdW5hdmFpbGFibGUgb3IgZW1wdHkuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBpbmxpbmVQcm9qZWN0RnJvbURiKFxuICBiYXNlOiBzdHJpbmcsXG4pOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCB7IGlzRGJBdmFpbGFibGUgfSA9IGF3YWl0IGltcG9ydChcIi4vZ3NkLWRiLmpzXCIpO1xuICAgIGlmIChpc0RiQXZhaWxhYmxlKCkpIHtcbiAgICAgIGNvbnN0IHsgcXVlcnlQcm9qZWN0IH0gPSBhd2FpdCBpbXBvcnQoXCIuL2NvbnRleHQtc3RvcmUuanNcIik7XG4gICAgICBjb25zdCBjb250ZW50ID0gcXVlcnlQcm9qZWN0KCk7XG4gICAgICBpZiAoY29udGVudCkge1xuICAgICAgICByZXR1cm4gYCMjIyBQcm9qZWN0XFxuU291cmNlOiBcXGAuZ3NkL1BST0pFQ1QubWRcXGBcXG5cXG4ke2NvbnRlbnR9YDtcbiAgICAgIH1cbiAgICB9XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGxvZ1dhcm5pbmcoXCJwcm9tcHRcIiwgYGlubGluZVByb2plY3RGcm9tRGIgZmFpbGVkOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gKTtcbiAgfVxuICByZXR1cm4gaW5saW5lR3NkUm9vdEZpbGUoYmFzZSwgXCJwcm9qZWN0Lm1kXCIsIFwiUHJvamVjdFwiKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFN0b3B3b3JkcyBmb3Iga2V5d29yZCBleHRyYWN0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuY29uc3QgU1RPUFdPUkRTID0gbmV3IFNldChbJ29mJywgJ3RoZScsICdhbmQnLCAnYScsICdmb3InLCAnKycsICctJywgJ3RvJywgJ2luJywgJ29uJywgJ3dpdGgnLCAnaXMnLCAnYXMnLCAnYnknXSk7XG5cbi8vIEdlbmVyaWMgd29yZHMgdGhhdCBkb24ndCBwcm92aWRlIG1lYW5pbmdmdWwgc2NvcGUgZGlmZmVyZW50aWF0aW9uXG5jb25zdCBHRU5FUklDX1dPUkRTID0gbmV3IFNldChbXG4gICdzZXR1cCcsICdpbnRlZ3JhdGlvbicsICdpbXBsZW1lbnRhdGlvbicsICd0ZXN0aW5nJywgJ3Rlc3QnLCAndGVzdHMnLFxuICAnY29uZmlnJywgJ2NvbmZpZ3VyYXRpb24nLCAnaW5pdCcsICdpbml0aWFsJywgJ2Jhc2ljJywgJ2NvcmUnLFxuICAnbWFpbicsICdwcmltYXJ5JywgJ2ZpbmFsJywgJ2NvbXBsZXRlJywgJ2ZpbmlzaCcsICdlbmQnLFxuICAnc3RhcnQnLCAnYmVnaW4nLCAnZmlyc3QnLCAnbGFzdCcsICd1cGRhdGUnLCAndXBkYXRlcycsXG4gICdmaXgnLCAnZml4ZXMnLCAnYWRkJywgJ2FkZHMnLCAncmVtb3ZlJywgJ3JlbW92ZXMnLFxuICAnY3JlYXRlJywgJ2NyZWF0ZXMnLCAnYnVpbGQnLCAnYnVpbGRzJywgJ2RlcGxveScsICdkZXBsb3ltZW50JyxcbiAgJ3JlZmFjdG9yJywgJ3JlZmFjdG9yaW5nJywgJ2NsZWFudXAnLCAncG9saXNoJywgJ3JldmlldycsXG4gIC8vIFByb2Nlc3MvYWN0aXZpdHkgd29yZHMgdGhhdCBkZXNjcmliZSB3aGF0IHlvdSdyZSBkb2luZywgbm90IHdoYXQgZG9tYWluXG4gICdoYXJkZW5pbmcnLCAndmFsaWRhdGlvbicsICd2ZXJpZmljYXRpb24nLCAnb3B0aW1pemF0aW9uJyxcbiAgJ2ltcHJvdmVtZW50JywgJ2VuaGFuY2VtZW50JywgJ2luZnJhc3RydWN0dXJlJyxcbl0pO1xuXG4vLyBQYXR0ZXJuIHRvIG1hdGNoIHNsaWNlL21pbGVzdG9uZS90YXNrIElEcyAoZS5nLiwgUzAxLCBNMDAxLCBUMDMpXG5jb25zdCBVTklUX0lEX1BBVFRFUk4gPSAvXltzbXRdXFxkKyQvaTtcblxuLyoqXG4gKiBEZXJpdmUgYSBzY29wZSBrZXl3b3JkIGZyb20gc2xpY2UgdGl0bGUgYW5kIG9wdGlvbmFsIGRlc2NyaXB0aW9uLlxuICogUmV0dXJucyB0aGUgbW9zdCBzcGVjaWZpYyBub3VuIChmaXJzdCBub24tZ2VuZXJpYyBrZXl3b3JkKSBmb3IgZGVjaXNpb24gc2NvcGluZy5cbiAqXG4gKiBFeGFtcGxlczpcbiAqIC0gXCJBdXRoIE1pZGRsZXdhcmUgJiBQcm90ZWN0ZWQgUm91dGVcIiBcdTIxOTIgXCJhdXRoXCJcbiAqIC0gXCJEYXRhYmFzZSAmIFVzZXIgTW9kZWwgU2V0dXBcIiBcdTIxOTIgXCJkYXRhYmFzZVwiXG4gKiAtIFwiSW50ZWdyYXRpb24gVGVzdGluZ1wiIFx1MjE5MiB1bmRlZmluZWQgKHRvbyBnZW5lcmljKVxuICogLSBcIkFQSSBSYXRlIExpbWl0aW5nXCIgXHUyMTkyIFwiYXBpXCJcbiAqXG4gKiBAcGFyYW0gc2xpY2VUaXRsZSAtIFRoZSBzbGljZSB0aXRsZVxuICogQHBhcmFtIHNsaWNlRGVzY3JpcHRpb24gLSBPcHRpb25hbCByb2FkbWFwIGRlc2NyaXB0aW9uIChkZW1vIHRleHQpXG4gKiBAcmV0dXJucyBBIHNpbmdsZSBsb3dlcmNhc2Uga2V5d29yZCBvciB1bmRlZmluZWQgaWYgbm8gbWVhbmluZ2Z1bCBzY29wZVxuICovXG5leHBvcnQgZnVuY3Rpb24gZGVyaXZlU2xpY2VTY29wZShzbGljZVRpdGxlOiBzdHJpbmcsIHNsaWNlRGVzY3JpcHRpb24/OiBzdHJpbmcpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICAvLyBDb21iaW5lIHRpdGxlIGFuZCBkZXNjcmlwdGlvbiBmb3Iga2V5d29yZCBleHRyYWN0aW9uXG4gIGNvbnN0IGNvbWJpbmVkVGV4dCA9IHNsaWNlRGVzY3JpcHRpb25cbiAgICA/IGAke3NsaWNlVGl0bGV9ICR7c2xpY2VEZXNjcmlwdGlvbn1gXG4gICAgOiBzbGljZVRpdGxlO1xuXG4gIC8vIEV4dHJhY3QgYWxsIHdvcmRzLCBsb3dlcmNhc2UsIHJlbW92ZSBwdW5jdHVhdGlvblxuICBjb25zdCB3b3JkcyA9IGNvbWJpbmVkVGV4dFxuICAgIC5zcGxpdCgvW1xccyYrLDs6fC9cXFxcKCktXSsvKVxuICAgIC5tYXAodyA9PiB3LnRvTG93ZXJDYXNlKCkucmVwbGFjZSgvW15hLXowLTldL2csICcnKSlcbiAgICAuZmlsdGVyKHcgPT4gdy5sZW5ndGggPj0gMik7XG5cbiAgLy8gRmluZCB0aGUgZmlyc3Qgd29yZCB0aGF0IGlzOlxuICAvLyAxLiBOb3QgYSBzdG9wd29yZFxuICAvLyAyLiBOb3QgYSBnZW5lcmljIHdvcmRcbiAgLy8gMy4gTm90IGEgdW5pdCBJRCAoUzAxLCBNMDAxLCBUMDMpXG4gIC8vIDQuIEF0IGxlYXN0IDMgY2hhcmFjdGVycyAobWVhbmluZ2Z1bCBzY29wZSlcbiAgZm9yIChjb25zdCB3b3JkIG9mIHdvcmRzKSB7XG4gICAgaWYgKFNUT1BXT1JEUy5oYXMod29yZCkpIGNvbnRpbnVlO1xuICAgIGlmIChHRU5FUklDX1dPUkRTLmhhcyh3b3JkKSkgY29udGludWU7XG4gICAgaWYgKFVOSVRfSURfUEFUVEVSTi50ZXN0KHdvcmQpKSBjb250aW51ZTtcbiAgICBpZiAod29yZC5sZW5ndGggPCAzKSBjb250aW51ZTtcbiAgICByZXR1cm4gd29yZDtcbiAgfVxuXG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG4vKipcbiAqIEV4dHJhY3Qga2V5d29yZHMgZnJvbSBhIHNsaWNlIHRpdGxlIGZvciBzY29wZWQga25vd2xlZGdlIHF1ZXJpZXMuXG4gKiBTcGxpdHMgb24gd2hpdGVzcGFjZSwgZmlsdGVycyBzdG9wd29yZHMsIGxvd2VyY2FzZXMuXG4gKiBFeGFtcGxlOiAnS05PV0xFREdFIHNjb3BpbmcgKyByb2FkbWFwIGV4Y2VycHQnIFx1MjE5MiBbJ2tub3dsZWRnZScsICdzY29waW5nJywgJ3JvYWRtYXAnLCAnZXhjZXJwdCddXG4gKi9cbmZ1bmN0aW9uIGV4dHJhY3RLZXl3b3Jkcyh0aXRsZTogc3RyaW5nKTogc3RyaW5nW10ge1xuICByZXR1cm4gdGl0bGVcbiAgICAuc3BsaXQoL1xccysvKVxuICAgIC5tYXAodyA9PiB3LnRvTG93ZXJDYXNlKCkucmVwbGFjZSgvW15hLXowLTldL2csICcnKSlcbiAgICAuZmlsdGVyKHcgPT4gdy5sZW5ndGggPiAwICYmICFTVE9QV09SRFMuaGFzKHcpKTtcbn1cblxuLyoqXG4gKiBJbmxpbmUgc2NvcGVkIEtOT1dMRURHRS5tZCBjb250ZW50IGJhc2VkIG9uIGtleXdvcmRzIGZyb20gc2xpY2UgdGl0bGUuXG4gKiBSZWFkcyBLTk9XTEVER0UubWQsIGZpbHRlcnMgdG8gc2VjdGlvbnMgbWF0Y2hpbmcga2V5d29yZHMsIGZvcm1hdHMgd2l0aCBoZWFkZXIuXG4gKiBSZXR1cm5zIG51bGwgaWYgbm8gS05PV0xFREdFLm1kIGV4aXN0cyBvciBubyBzZWN0aW9ucyBtYXRjaC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGlubGluZUtub3dsZWRnZVNjb3BlZChcbiAgYmFzZTogc3RyaW5nLFxuICBrZXl3b3Jkczogc3RyaW5nW10sXG4pOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgY29uc3Qga25vd2xlZGdlUGF0aCA9IHJlc29sdmVHc2RSb290RmlsZShiYXNlLCBcIktOT1dMRURHRVwiKTtcbiAgaWYgKCFleGlzdHNTeW5jKGtub3dsZWRnZVBhdGgpKSByZXR1cm4gbnVsbDtcblxuICBjb25zdCBjb250ZW50ID0gYXdhaXQgbG9hZEZpbGUoa25vd2xlZGdlUGF0aCk7XG4gIGlmICghY29udGVudCkgcmV0dXJuIG51bGw7XG5cbiAgLy8gSW1wb3J0IHF1ZXJ5S25vd2xlZGdlIGZyb20gY29udGV4dC1zdG9yZVxuICBjb25zdCB7IHF1ZXJ5S25vd2xlZGdlIH0gPSBhd2FpdCBpbXBvcnQoXCIuL2NvbnRleHQtc3RvcmUuanNcIik7XG4gIGNvbnN0IHNjb3BlZCA9IGF3YWl0IHF1ZXJ5S25vd2xlZGdlKGNvbnRlbnQsIGtleXdvcmRzKTtcblxuICAvLyBSZXR1cm4gbnVsbCBpZiBubyBzZWN0aW9ucyBtYXRjaGVkIChlbXB0eSBzdHJpbmcgZnJvbSBxdWVyeUtub3dsZWRnZSlcbiAgaWYgKCFzY29wZWQpIHJldHVybiBudWxsO1xuXG4gIHJldHVybiBgIyMjIFByb2plY3QgS25vd2xlZGdlIChzY29wZWQpXFxuU291cmNlOiBcXGAke3JlbEdzZFJvb3RGaWxlKFwiS05PV0xFREdFXCIpfVxcYFxcblxcbiR7c2NvcGVkLnRyaW0oKX1gO1xufVxuXG4vKipcbiAqIEJ1ZGdldC1jYXBwZWQga25vd2xlZGdlIGlubGluZSBmb3IgbWlsZXN0b25lLWxldmVsIHByb21wdCBhc3NlbWJseS5cbiAqXG4gKiBBZGRyZXNzZXMgaXNzdWUgIzQ3MTk6IHRoZSBzaXggbWlsZXN0b25lLXBoYXNlIHByb21wdHMgKHJlc2VhcmNoLW1pbGVzdG9uZSxcbiAqIHBsYW4tbWlsZXN0b25lLCBjb21wbGV0ZS1zbGljZSwgY29tcGxldGUtbWlsZXN0b25lLCB2YWxpZGF0ZS1taWxlc3RvbmUsXG4gKiByZWFzc2Vzcy1yb2FkbWFwKSBwcmV2aW91c2x5IGluamVjdGVkIHRoZSBmdWxsIEtOT1dMRURHRS5tZCAofjIyNktCIGZvciBhXG4gKiByZWFsIHByb2plY3QpIG9uIGV2ZXJ5IGludm9jYXRpb24uIFRoaXMgaGVscGVyIHNjb3BlcyBieSBjYWxsZXItc3VwcGxpZWRcbiAqIGtleXdvcmRzIGFuZCBjYXBzIHRoZSBwYXlsb2FkIGF0IGBtYXhDaGFyc2AgKGRlZmF1bHQgMTIsMDAwIGNoYXJzKS5cbiAqXG4gKiBSZXR1cm5zIG51bGwgd2hlbiBubyBLTk9XTEVER0UubWQgZXhpc3RzIG9yIG5vIGVudHJpZXMgbWF0Y2ggYW55IGtleXdvcmQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBpbmxpbmVLbm93bGVkZ2VCdWRnZXRlZChcbiAgYmFzZTogc3RyaW5nLFxuICBrZXl3b3Jkczogc3RyaW5nW10sXG4gIG9wdGlvbnM/OiB7IG1heENoYXJzPzogbnVtYmVyIH0sXG4pOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgY29uc3QgREVGQVVMVF9NQVhfQ0hBUlMgPSAxMl8wMDA7XG4gIGNvbnN0IEhBUkRfTUFYX0NIQVJTID0gMTAwXzAwMDtcbiAgY29uc3QgcmF3ID0gTnVtYmVyKG9wdGlvbnM/Lm1heENoYXJzID8/IERFRkFVTFRfTUFYX0NIQVJTKTtcbiAgY29uc3QgbWF4Q2hhcnMgPSBOdW1iZXIuaXNGaW5pdGUocmF3KVxuICAgID8gTWF0aC5tYXgoMCwgTWF0aC5taW4oTWF0aC5mbG9vcihyYXcpLCBIQVJEX01BWF9DSEFSUykpXG4gICAgOiBERUZBVUxUX01BWF9DSEFSUztcblxuICBjb25zdCBrbm93bGVkZ2VQYXRoID0gcmVzb2x2ZUdzZFJvb3RGaWxlKGJhc2UsIFwiS05PV0xFREdFXCIpO1xuICBpZiAoIWV4aXN0c1N5bmMoa25vd2xlZGdlUGF0aCkpIHJldHVybiBudWxsO1xuXG4gIGNvbnN0IGNvbnRlbnQgPSBhd2FpdCBsb2FkRmlsZShrbm93bGVkZ2VQYXRoKTtcbiAgaWYgKCFjb250ZW50KSByZXR1cm4gbnVsbDtcblxuICBjb25zdCB7IHF1ZXJ5S25vd2xlZGdlIH0gPSBhd2FpdCBpbXBvcnQoXCIuL2NvbnRleHQtc3RvcmUuanNcIik7XG4gIGNvbnN0IHNjb3BlZCA9IGF3YWl0IHF1ZXJ5S25vd2xlZGdlKGNvbnRlbnQsIGtleXdvcmRzKTtcbiAgaWYgKCFzY29wZWQpIHJldHVybiBudWxsO1xuXG4gIGNvbnN0IHRyaW1tZWQgPSBzY29wZWQudHJpbSgpO1xuICBjb25zdCB0cnVuY2F0ZWQgPVxuICAgIHRyaW1tZWQubGVuZ3RoID4gbWF4Q2hhcnNcbiAgICAgID8gYCR7dHJpbW1lZC5zbGljZSgwLCBtYXhDaGFycyl9XFxuXFxuWy4uLnRydW5jYXRlZCAke3RyaW1tZWQubGVuZ3RoIC0gbWF4Q2hhcnN9IGNoYXJzOyByZXJ1biB3aXRoIG5hcnJvd2VyIHNjb3BlIGlmIG5lZWRlZF1gXG4gICAgICA6IHRyaW1tZWQ7XG5cbiAgcmV0dXJuIGAjIyMgUHJvamVjdCBLbm93bGVkZ2UgKHNjb3BlZClcXG5Tb3VyY2U6IFxcYCR7cmVsR3NkUm9vdEZpbGUoXCJLTk9XTEVER0VcIil9XFxgXFxuXFxuJHt0cnVuY2F0ZWR9YDtcbn1cblxuLyoqXG4gKiBJbmxpbmUgYSByb2FkbWFwIGV4Y2VycHQgZm9yIGEgc3BlY2lmaWMgc2xpY2UuXG4gKiBSZWFkcyBmdWxsIHJvYWRtYXAsIGV4dHJhY3RzIG1pbmltYWwgZXhjZXJwdCB3aXRoIGhlYWRlciArIHByZWRlY2Vzc29yICsgdGFyZ2V0IHJvdy5cbiAqIFJldHVybnMgbnVsbCBpZiByb2FkbWFwIGRvZXNuJ3QgZXhpc3Qgb3Igc2xpY2Ugbm90IGZvdW5kLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaW5saW5lUm9hZG1hcEV4Y2VycHQoXG4gIGJhc2U6IHN0cmluZyxcbiAgbWlkOiBzdHJpbmcsXG4gIHNpZDogc3RyaW5nLFxuKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG4gIGNvbnN0IHJvYWRtYXBQYXRoID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZSwgbWlkLCBcIlJPQURNQVBcIik7XG4gIGlmICghcm9hZG1hcFBhdGggfHwgIWV4aXN0c1N5bmMocm9hZG1hcFBhdGgpKSByZXR1cm4gbnVsbDtcblxuICBjb25zdCByb2FkbWFwUmVsID0gcmVsTWlsZXN0b25lRmlsZShiYXNlLCBtaWQsIFwiUk9BRE1BUFwiKTtcbiAgY29uc3QgY29udGVudCA9IGF3YWl0IGxvYWRGaWxlKHJvYWRtYXBQYXRoKTtcbiAgaWYgKCFjb250ZW50KSByZXR1cm4gbnVsbDtcblxuICAvLyBJbXBvcnQgZm9ybWF0Um9hZG1hcEV4Y2VycHQgZnJvbSBjb250ZXh0LXN0b3JlXG4gIGNvbnN0IHsgZm9ybWF0Um9hZG1hcEV4Y2VycHQgfSA9IGF3YWl0IGltcG9ydChcIi4vY29udGV4dC1zdG9yZS5qc1wiKTtcbiAgY29uc3QgZXhjZXJwdCA9IGZvcm1hdFJvYWRtYXBFeGNlcnB0KGNvbnRlbnQsIHNpZCwgcm9hZG1hcFJlbCk7XG5cbiAgLy8gUmV0dXJuIG51bGwgaWYgc2xpY2Ugbm90IGZvdW5kIGluIHJvYWRtYXBcbiAgaWYgKCFleGNlcnB0KSByZXR1cm4gbnVsbDtcblxuICByZXR1cm4gYCMjIyBNaWxlc3RvbmUgUm9hZG1hcCAoZXhjZXJwdClcXG5Tb3VyY2U6IFxcYCR7cm9hZG1hcFJlbH1cXGBcXG5cXG4ke2V4Y2VycHR9YDtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFNraWxsIEFjdGl2YXRpb24gJiBEaXNjb3ZlcnkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVNraWxsUmVmZXJlbmNlKHJlZjogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3Qgbm9ybWFsaXplZCA9IHJlZi5yZXBsYWNlKC9cXFxcL2csIFwiL1wiKS50cmltKCk7XG4gIGNvbnN0IGJhc2UgPSBiYXNlbmFtZShub3JtYWxpemVkKS5yZXBsYWNlKC9cXC5tZCQvaSwgXCJcIik7XG4gIGNvbnN0IG5hbWUgPSAvXlNLSUxMJC9pLnRlc3QoYmFzZSlcbiAgICA/IGJhc2VuYW1lKG5vcm1hbGl6ZWQucmVwbGFjZSgvXFwvU0tJTEwoPzpcXC5tZCk/JC9pLCBcIlwiKSlcbiAgICA6IGJhc2U7XG4gIHJldHVybiBuYW1lLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xufVxuXG5mdW5jdGlvbiB0b2tlbml6ZVNraWxsQ29udGV4dCguLi5wYXJ0czogQXJyYXk8c3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZD4pOiBTZXQ8c3RyaW5nPiB7XG4gIGNvbnN0IHRva2VucyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBjb25zdCBhZGRWYXJpYW50cyA9IChyYXc6IHN0cmluZykgPT4ge1xuICAgIGNvbnN0IHZhbHVlID0gcmF3LnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuICAgIGlmICghdmFsdWUgfHwgdmFsdWUubGVuZ3RoIDwgMikgcmV0dXJuO1xuICAgIHRva2Vucy5hZGQodmFsdWUpO1xuICAgIHRva2Vucy5hZGQodmFsdWUucmVwbGFjZSgvWy1fXSsvZywgXCIgXCIpKTtcbiAgICB0b2tlbnMuYWRkKHZhbHVlLnJlcGxhY2UoL1xccysvZywgXCItXCIpKTtcbiAgICB0b2tlbnMuYWRkKHZhbHVlLnJlcGxhY2UoL1xccysvZywgXCJcIikpO1xuICB9O1xuXG4gIGZvciAoY29uc3QgcGFydCBvZiBwYXJ0cykge1xuICAgIGlmICghcGFydCkgY29udGludWU7XG4gICAgY29uc3QgdGV4dCA9IHBhcnQudG9Mb3dlckNhc2UoKTtcbiAgICBjb25zdCBwaHJhc2VNYXRjaGVzID0gdGV4dC5tYXRjaCgvW2EtejAtOV1bYS16MC05Ky4jL18tXXsxLH0vZykgPz8gW107XG4gICAgZm9yIChjb25zdCBtYXRjaCBvZiBwaHJhc2VNYXRjaGVzKSB7XG4gICAgICBhZGRWYXJpYW50cyhtYXRjaCk7XG4gICAgICBmb3IgKGNvbnN0IHBpZWNlIG9mIG1hdGNoLnNwbGl0KC9bXmEtejAtOSsuI10rL2cpKSB7XG4gICAgICAgIGlmIChwaWVjZS5sZW5ndGggPj0gMykgYWRkVmFyaWFudHMocGllY2UpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiB0b2tlbnM7XG59XG5cbmZ1bmN0aW9uIHNraWxsTWF0Y2hlc0NvbnRleHQoc2tpbGw6IFNraWxsLCBjb250ZXh0VG9rZW5zOiBTZXQ8c3RyaW5nPik6IGJvb2xlYW4ge1xuICBjb25zdCBoYXlzdGFja3MgPSBbXG4gICAgc2tpbGwubmFtZS50b0xvd2VyQ2FzZSgpLFxuICAgIHNraWxsLm5hbWUudG9Mb3dlckNhc2UoKS5yZXBsYWNlKC9bLV9dKy9nLCBcIiBcIiksXG4gICAgc2tpbGwuZGVzY3JpcHRpb24udG9Mb3dlckNhc2UoKSxcbiAgXTtcblxuICByZXR1cm4gWy4uLmNvbnRleHRUb2tlbnNdLnNvbWUodG9rZW4gPT5cbiAgICB0b2tlbi5sZW5ndGggPj0gMyAmJiBoYXlzdGFja3Muc29tZShoYXlzdGFjayA9PiBoYXlzdGFjay5pbmNsdWRlcyh0b2tlbikpLFxuICApO1xufVxuXG5mdW5jdGlvbiByZXNvbHZlUHJlZmVyZW5jZVNraWxsTmFtZXMocmVmczogc3RyaW5nW10sIGJhc2U6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgaWYgKHJlZnMubGVuZ3RoID09PSAwKSByZXR1cm4gW107XG4gIGNvbnN0IHByZWZzOiBHU0RQcmVmZXJlbmNlcyA9IHsgYWx3YXlzX3VzZV9za2lsbHM6IHJlZnMgfTtcbiAgY29uc3QgcmVwb3J0ID0gcmVzb2x2ZUFsbFNraWxsUmVmZXJlbmNlcyhwcmVmcywgYmFzZSk7XG4gIHJldHVybiByZWZzLm1hcChyZWYgPT4ge1xuICAgIGNvbnN0IHJlc29sdXRpb24gPSByZXBvcnQucmVzb2x1dGlvbnMuZ2V0KHJlZik7XG4gICAgcmV0dXJuIG5vcm1hbGl6ZVNraWxsUmVmZXJlbmNlKHJlc29sdXRpb24/LnJlc29sdmVkUGF0aCA/PyByZWYpO1xuICB9KS5maWx0ZXIoQm9vbGVhbik7XG59XG5cbmZ1bmN0aW9uIHJ1bGVNYXRjaGVzQ29udGV4dCh3aGVuOiBzdHJpbmcsIGNvbnRleHRUb2tlbnM6IFNldDxzdHJpbmc+KTogYm9vbGVhbiB7XG4gIGNvbnN0IHdoZW5Ub2tlbnMgPSB0b2tlbml6ZVNraWxsQ29udGV4dCh3aGVuKTtcbiAgcmV0dXJuIFsuLi53aGVuVG9rZW5zXS5zb21lKHRva2VuID0+XG4gICAgY29udGV4dFRva2Vucy5oYXModG9rZW4pIHx8IFsuLi5jb250ZXh0VG9rZW5zXS5zb21lKGN0eCA9PiBjdHguaW5jbHVkZXModG9rZW4pIHx8IHRva2VuLmluY2x1ZGVzKGN0eCkpLFxuICApO1xufVxuXG5mdW5jdGlvbiByZXNvbHZlU2tpbGxSdWxlTWF0Y2hlcyhcbiAgcHJlZnM6IEdTRFByZWZlcmVuY2VzIHwgdW5kZWZpbmVkLFxuICBjb250ZXh0VG9rZW5zOiBTZXQ8c3RyaW5nPixcbiAgYmFzZTogc3RyaW5nLFxuKTogeyBpbmNsdWRlOiBzdHJpbmdbXTsgYXZvaWQ6IHN0cmluZ1tdIH0ge1xuICBpZiAoIXByZWZzPy5za2lsbF9ydWxlcz8ubGVuZ3RoKSByZXR1cm4geyBpbmNsdWRlOiBbXSwgYXZvaWQ6IFtdIH07XG5cbiAgY29uc3QgaW5jbHVkZTogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgYXZvaWQ6IHN0cmluZ1tdID0gW107XG4gIGZvciAoY29uc3QgcnVsZSBvZiBwcmVmcy5za2lsbF9ydWxlcykge1xuICAgIGlmICghcnVsZU1hdGNoZXNDb250ZXh0KHJ1bGUud2hlbiwgY29udGV4dFRva2VucykpIGNvbnRpbnVlO1xuICAgIGluY2x1ZGUucHVzaCguLi5yZXNvbHZlUHJlZmVyZW5jZVNraWxsTmFtZXMoWy4uLihydWxlLnVzZSA/PyBbXSksIC4uLihydWxlLnByZWZlciA/PyBbXSldLCBiYXNlKSk7XG4gICAgYXZvaWQucHVzaCguLi5yZXNvbHZlUHJlZmVyZW5jZVNraWxsTmFtZXMocnVsZS5hdm9pZCA/PyBbXSwgYmFzZSkpO1xuICB9XG4gIHJldHVybiB7IGluY2x1ZGUsIGF2b2lkIH07XG59XG5cbmZ1bmN0aW9uIHJlc29sdmVQcmVmZXJyZWRTa2lsbE5hbWVzKFxuICBwcmVmczogR1NEUHJlZmVyZW5jZXMgfCB1bmRlZmluZWQsXG4gIHZpc2libGVTa2lsbHM6IFNraWxsW10sXG4gIGNvbnRleHRUb2tlbnM6IFNldDxzdHJpbmc+LFxuICBiYXNlOiBzdHJpbmcsXG4pOiBzdHJpbmdbXSB7XG4gIGlmICghcHJlZnM/LnByZWZlcl9za2lsbHM/Lmxlbmd0aCkgcmV0dXJuIFtdO1xuICBjb25zdCBwcmVmZXJyZWQgPSBuZXcgU2V0KHJlc29sdmVQcmVmZXJlbmNlU2tpbGxOYW1lcyhwcmVmcy5wcmVmZXJfc2tpbGxzLCBiYXNlKSk7XG4gIHJldHVybiB2aXNpYmxlU2tpbGxzXG4gICAgLmZpbHRlcihza2lsbCA9PiBwcmVmZXJyZWQuaGFzKG5vcm1hbGl6ZVNraWxsUmVmZXJlbmNlKHNraWxsLm5hbWUpKSAmJiBza2lsbE1hdGNoZXNDb250ZXh0KHNraWxsLCBjb250ZXh0VG9rZW5zKSlcbiAgICAubWFwKHNraWxsID0+IG5vcm1hbGl6ZVNraWxsUmVmZXJlbmNlKHNraWxsLm5hbWUpKTtcbn1cblxuLyoqIFNraWxsIG5hbWVzIG11c3QgYmUgbG93ZXJjYXNlIGFscGhhbnVtZXJpYyB3aXRoIGh5cGhlbnMgXHUyMDE0IHJlamVjdCBhbnl0aGluZyBlbHNlXG4gKiAgdG8gcHJldmVudCBwcm9tcHQgaW5qZWN0aW9uIHZpYSBjcmFmdGVkIGRpcmVjdG9yeSBuYW1lcy4gKi9cbmNvbnN0IFNBRkVfU0tJTExfTkFNRSA9IC9eW2EtejAtOV1bYS16MC05LV0qJC87XG5cbmZ1bmN0aW9uIGZvcm1hdFNraWxsQWN0aXZhdGlvbkJsb2NrKHNraWxsTmFtZXM6IHN0cmluZ1tdKTogc3RyaW5nIHtcbiAgY29uc3Qgc2FmZSA9IHNraWxsTmFtZXMuZmlsdGVyKG5hbWUgPT4gU0FGRV9TS0lMTF9OQU1FLnRlc3QobmFtZSkpO1xuICBpZiAoc2FmZS5sZW5ndGggPT09IDApIHJldHVybiBcIlwiO1xuICAvLyBVc2UgZXhwbGljaXQgcGFyYW1ldGVyIHN5bnRheCBzbyBMTE1zIHBhc3MgeyBza2lsbDogXCIuLi5cIiB9IGluc3RlYWQgb2YgeyBuYW1lOiBcIi4uLlwiIH0uXG4gIC8vIFRoZSBmdW5jdGlvbi1jYWxsLWxpa2Ugc3ludGF4IGBTa2lsbCgnbmFtZScpYCBsZWQgTExNcyB0byBpbmZlciBhIHBvc2l0aW9uYWxcbiAgLy8gcGFyYW1ldGVyIG5hbWUsIGNhdXNpbmcgdG9vbCB2YWxpZGF0aW9uIGZhaWx1cmVzIFx1MjAxNCBzZWUgIzIyMjQuXG4gIGNvbnN0IGNhbGxzID0gc2FmZS5tYXAobmFtZSA9PiBgQ2FsbCBTa2lsbCh7IHNraWxsOiAnJHtuYW1lfScgfSlgKS5qb2luKCcuICcpO1xuICByZXR1cm4gYDxza2lsbF9hY3RpdmF0aW9uPiR7Y2FsbHN9Ljwvc2tpbGxfYWN0aXZhdGlvbj5gO1xufVxuXG4vKipcbiAqIE1hbmlmZXN0LWRyaXZlbiByZWNvbW1lbmRhdGlvbnMgYmxvY2sgXHUyMDE0IGluZm9ybWF0aW9uYWwgb25seSwgZG9lcyBOT1RcbiAqIGF1dG8taW52b2tlLiBMaXN0cyBwZXItdW5pdC10eXBlIHNraWxscyB0aGF0IGFyZSBpbnN0YWxsZWQgYnV0IG5vdCBhbHJlYWR5XG4gKiBhY3RpdmF0ZWQgYnkgZXhwbGljaXQgdXNlciBpbnRlbnQgKGFsd2F5c191c2Vfc2tpbGxzIC8gcHJlZmVyX3NraWxscyAvXG4gKiBza2lsbF9ydWxlcyAvIHRhc2stcGxhbiBza2lsbHNfdXNlZCkuIFN1cmZhY2VzIHJlbGV2YW50IHNraWxscyB0byB0aGVcbiAqIG1vZGVsIHNvIHRoZXkgY2FuIGJlIGludm9rZWQgd2hlbiB0aGUgbW9kZWwganVkZ2VzIHRoZW0gdXNlZnVsLlxuICpcbiAqIFRoaXMgaXMgdGhlIGFkZGl0aXZlIGNvbXBsZW1lbnQgdG8gdGhlIGV4aXN0aW5nIGFjdGl2YXRpb24gZGlyZWN0aXZlOlxuICogYWN0aXZhdGlvbiBmb3JjZS1pbnZva2VzIChleHBsaWNpdCBpbnRlbnQpLCByZWNvbW1lbmRhdGlvbnMgcmVtaW5kXG4gKiAobWFuaWZlc3QgZGVmYXVsdHMpLiBVc2VyIGludGVudCBpcyBwcmVzZXJ2ZWQgYXMgdGhlIHN0cm9uZ2VyIHNpZ25hbFxuICogKFJGQyAjNDc3OSBkZXNpZ24gcHJpbmNpcGxlKTsgdGhpcyBibG9jayBvbmx5IGFkZHMgdmlzaWJpbGl0eS5cbiAqL1xuZnVuY3Rpb24gZm9ybWF0U2tpbGxSZWNvbW1lbmRhdGlvbnNCbG9jayh1bml0VHlwZTogc3RyaW5nIHwgdW5kZWZpbmVkLCBza2lsbE5hbWVzOiBzdHJpbmdbXSk6IHN0cmluZyB7XG4gIGlmICghdW5pdFR5cGUpIHJldHVybiBcIlwiO1xuICBjb25zdCBzYWZlID0gc2tpbGxOYW1lcy5maWx0ZXIobmFtZSA9PiBTQUZFX1NLSUxMX05BTUUudGVzdChuYW1lKSk7XG4gIGlmIChzYWZlLmxlbmd0aCA9PT0gMCkgcmV0dXJuIFwiXCI7XG4gIHJldHVybiBgPHNraWxsX3JlY29tbWVuZGF0aW9ucyB1bml0PVwiJHt1bml0VHlwZX1cIj5Gb3IgdGhpcyB1bml0IHR5cGUsIGFsc28gY29uc2lkZXIgaW52b2tpbmc6ICR7c2FmZS5qb2luKFwiLCBcIil9LiBVc2UgU2tpbGwoeyBza2lsbDogJ25hbWUnIH0pIHdoZW4gcmVsZXZhbnQgXHUyMDE0IHRoZXNlIGFyZSByZWNvbW1lbmRhdGlvbnMsIG5vdCByZXF1aXJlbWVudHMuPC9za2lsbF9yZWNvbW1lbmRhdGlvbnM+YDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkU2tpbGxBY3RpdmF0aW9uQmxvY2socGFyYW1zOiB7XG4gIGJhc2U6IHN0cmluZztcbiAgbWlsZXN0b25lSWQ6IHN0cmluZztcbiAgbWlsZXN0b25lVGl0bGU/OiBzdHJpbmc7XG4gIHNsaWNlSWQ/OiBzdHJpbmc7XG4gIHNsaWNlVGl0bGU/OiBzdHJpbmc7XG4gIHRhc2tJZD86IHN0cmluZztcbiAgdGFza1RpdGxlPzogc3RyaW5nO1xuICBleHRyYUNvbnRleHQ/OiBzdHJpbmdbXTtcbiAgdGFza1BsYW5Db250ZW50Pzogc3RyaW5nIHwgbnVsbDtcbiAgcHJlZmVyZW5jZXM/OiBHU0RQcmVmZXJlbmNlcztcbiAgLyoqXG4gICAqIFVuaXQgdHlwZSBkaXNwYXRjaGluZyB0aGlzIHByb21wdC4gV2hlbiBwcm92aWRlZCwgc2tpbGxzIGFyZSBmaWx0ZXJlZFxuICAgKiB0aHJvdWdoIHRoZSBwZXItdW5pdC10eXBlIG1hbmlmZXN0IChzZWUgYHNraWxsLW1hbmlmZXN0LnRzYCkuIFVua25vd25cbiAgICogb3Igb21pdHRlZCB2YWx1ZXMgcmV0YWluIHRoZSBwcmUtbWFuaWZlc3QgYmVoYXZpb3IgKGFsbCBza2lsbHMgZWxpZ2libGUpLlxuICAgKi9cbiAgdW5pdFR5cGU/OiBzdHJpbmc7XG59KTogc3RyaW5nIHtcbiAgY29uc3QgcHJlZnMgPSBwYXJhbXMucHJlZmVyZW5jZXMgPz8gbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzKHBhcmFtcy5iYXNlKT8ucHJlZmVyZW5jZXM7XG4gIGNvbnN0IGNvbnRleHRUb2tlbnMgPSB0b2tlbml6ZVNraWxsQ29udGV4dChcbiAgICBwYXJhbXMubWlsZXN0b25lSWQsXG4gICAgcGFyYW1zLm1pbGVzdG9uZVRpdGxlLFxuICAgIHBhcmFtcy5zbGljZUlkLFxuICAgIHBhcmFtcy5zbGljZVRpdGxlLFxuICAgIHBhcmFtcy50YXNrSWQsXG4gICAgcGFyYW1zLnRhc2tUaXRsZSxcbiAgKTtcblxuICBjb25zdCBsb2FkZWQgPSAodHlwZW9mIGdldExvYWRlZFNraWxscyA9PT0gJ2Z1bmN0aW9uJyA/IGdldExvYWRlZFNraWxscygpIDogW10pLmZpbHRlcihza2lsbCA9PiAhc2tpbGwuZGlzYWJsZU1vZGVsSW52b2NhdGlvbik7XG5cbiAgLy8gU2tpbGwgYWN0aXZhdGlvbiBoZXJlIGlzIGRyaXZlbiBlbnRpcmVseSBieSBleHBsaWNpdCBzb3VyY2VzXG4gIC8vIChhbHdheXNfdXNlX3NraWxscywgcHJlZmVyX3NraWxscywgc2tpbGxfcnVsZXMsIHRhc2stcGxhbiBza2lsbHNfdXNlZCkuXG4gIC8vIEV2ZXJ5IG1hdGNoIGlzIGFuIGV4cGxpY2l0IHVzZXIvcHJvamVjdCBpbnRlbnQgYW5kIG11c3Qgbm90IGJlIGRyb3BwZWRcbiAgLy8gYnkgdGhlIHVuaXQtdHlwZSBtYW5pZmVzdCBcdTIwMTQgdXNlciBpbnRlbnQgaXMgc3Ryb25nZXIgc2lnbmFsIHRoYW5cbiAgLy8gZGVmYXVsdHMuIFRoZSBtYW5pZmVzdCdzIHJlYWwgaG9tZSBpcyB0aGUgc2tpbGwgY2F0YWxvZyByZW5kZXJpbmdcbiAgLy8gbGF5ZXIgKHBpLWNvZGluZy1hZ2VudCBgZm9ybWF0U2tpbGxzRm9yUHJvbXB0YCk7IHRoYXQgd2lyaW5nIGlzIHRyYWNrZWRcbiAgLy8gYXMgdGhlIFwibG9hZC10aW1lIHNob3J0LWNpcmN1aXRcIiBmb2xsb3ctdXAgdG8gUkZDICM0Nzc5LlxuICAvL1xuICAvLyBgdW5pdFR5cGVgIHN0YXlzIHBsdW1iZWQgc28gdGhlIHN0cmljdC1tb2RlIHdhcm5pbmcgY2FuIHN1cmZhY2VcbiAgLy8gbWFuaWZlc3QgZW50cmllcyB0aGF0IHJlZmVyZW5jZSB1bmluc3RhbGxlZCBza2lsbHMsIGFuZCBzbyB0aGVcbiAgLy8gYWN0aXZhdGlvbi1ibG9jayBzaXRlIGlzIHJlYWR5IHRvIG9wdCBpbiBvbmNlIFBSIEIgbGFuZHMuXG4gIGNvbnN0IHZpc2libGVTa2lsbHMgPSBsb2FkZWQ7XG4gIGNvbnN0IGluc3RhbGxlZE5hbWVzID0gbmV3IFNldCh2aXNpYmxlU2tpbGxzLm1hcChza2lsbCA9PiBub3JtYWxpemVTa2lsbFJlZmVyZW5jZShza2lsbC5uYW1lKSkpO1xuICB3YXJuSWZNYW5pZmVzdEhhc01pc3NpbmdTa2lsbHMocGFyYW1zLnVuaXRUeXBlLCBpbnN0YWxsZWROYW1lcyk7XG4gIGNvbnN0IGF2b2lkZWQgPSBuZXcgU2V0KHJlc29sdmVQcmVmZXJlbmNlU2tpbGxOYW1lcyhwcmVmcz8uYXZvaWRfc2tpbGxzID8/IFtdLCBwYXJhbXMuYmFzZSkpO1xuICBjb25zdCBtYXRjaGVkID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cbiAgZm9yIChjb25zdCBuYW1lIG9mIHJlc29sdmVQcmVmZXJlbmNlU2tpbGxOYW1lcyhwcmVmcz8uYWx3YXlzX3VzZV9za2lsbHMgPz8gW10sIHBhcmFtcy5iYXNlKSkge1xuICAgIG1hdGNoZWQuYWRkKG5hbWUpO1xuICB9XG5cbiAgY29uc3QgcnVsZU1hdGNoZXMgPSByZXNvbHZlU2tpbGxSdWxlTWF0Y2hlcyhwcmVmcywgY29udGV4dFRva2VucywgcGFyYW1zLmJhc2UpO1xuICBmb3IgKGNvbnN0IG5hbWUgb2YgcnVsZU1hdGNoZXMuaW5jbHVkZSkgbWF0Y2hlZC5hZGQobmFtZSk7XG4gIGZvciAoY29uc3QgbmFtZSBvZiBydWxlTWF0Y2hlcy5hdm9pZCkgYXZvaWRlZC5hZGQobmFtZSk7XG5cbiAgZm9yIChjb25zdCBuYW1lIG9mIHJlc29sdmVQcmVmZXJyZWRTa2lsbE5hbWVzKHByZWZzLCB2aXNpYmxlU2tpbGxzLCBjb250ZXh0VG9rZW5zLCBwYXJhbXMuYmFzZSkpIHtcbiAgICBtYXRjaGVkLmFkZChuYW1lKTtcbiAgfVxuXG4gIGlmIChwYXJhbXMudGFza1BsYW5Db250ZW50KSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHRhc2tQbGFuID0gcGFyc2VUYXNrUGxhbkZpbGUocGFyYW1zLnRhc2tQbGFuQ29udGVudCk7XG4gICAgICBmb3IgKGNvbnN0IHNraWxsTmFtZSBvZiB0YXNrUGxhbi5mcm9udG1hdHRlci5za2lsbHNfdXNlZCkge1xuICAgICAgICBtYXRjaGVkLmFkZChub3JtYWxpemVTa2lsbFJlZmVyZW5jZShza2lsbE5hbWUpKTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGxvZ1dhcm5pbmcoXCJwcm9tcHRcIiwgYHBhcnNlVGFza1BsYW5GaWxlIGZhaWxlZDogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCk7XG4gICAgfVxuICB9XG5cbiAgLy8gSGV1cmlzdGljIGF1dG8tbWF0Y2ggKGdhdGVkIG9uIHNraWxsX2Rpc2NvdmVyeTogXCJhdXRvXCIpLlxuICAvLyBGb3IgZWFjaCBpbnN0YWxsZWQgc2tpbGwsIGNoZWNrIGlmIGl0cyBuYW1lIG9yIGRlc2NyaXB0aW9uIGFwcGVhcnMgaW4gdGhlXG4gIC8vIHVuaXQncyBjb250ZXh0IHRva2VucyAobWlsZXN0b25lL3NsaWNlL3Rhc2sgdGl0bGVzKS4gT25seSBjb25zaWRlciBza2lsbHNcbiAgLy8gYWxyZWFkeSBvbiB0aGUgdW5pdC10eXBlIG1hbmlmZXN0IGFsbG93bGlzdCBcdTIwMTQgdGhpcyBrZWVwcyB0aGUgaGV1cmlzdGljXG4gIC8vIG5hcnJvdyBhbmQgYXZvaWRzIHdpbGRseSBvZmYtdG9waWMgYWN0aXZhdGlvbnMuXG4gIC8vIFVzZXJzIHdobyBzZXQgYHNraWxsX2Rpc2NvdmVyeTogXCJvZmZcImAgb3IgXCJzdWdnZXN0XCIgZG8gbm90IGdldFxuICAvLyBhdXRvLW1hdGNoZWQgc2tpbGxzICh0aGUgcmVjb21tZW5kYXRpb25zIGJsb2NrIHN0aWxsIHN1cmZhY2VzIG1hbmlmZXN0XG4gIC8vIHNraWxscyBwYXNzaXZlbHkpOyBvbmx5IFwiYXV0b1wiIGFjdHVhbGx5IGFkZHMgdGhlbSB0byB0aGUgYWN0aXZhdGlvblxuICAvLyBkaXJlY3RpdmUgc2V0LiBEZWZhdWx0IGBza2lsbF9kaXNjb3ZlcnlgIGlzIFwic3VnZ2VzdFwiLCBzbyB0aGlzIGlzIG9wdC1pbi5cbiAgaWYgKChwcmVmcz8uc2tpbGxfZGlzY292ZXJ5ID8/IFwic3VnZ2VzdFwiKSA9PT0gXCJhdXRvXCIpIHtcbiAgICBjb25zdCBtYW5pZmVzdEFsbG93ID0gcmVzb2x2ZVNraWxsTWFuaWZlc3QocGFyYW1zLnVuaXRUeXBlKTtcbiAgICBjb25zdCBhbGxvd1NldCA9IG1hbmlmZXN0QWxsb3cgPyBuZXcgU2V0KG1hbmlmZXN0QWxsb3cpIDogbnVsbDtcbiAgICBmb3IgKGNvbnN0IHNraWxsIG9mIHZpc2libGVTa2lsbHMpIHtcbiAgICAgIGNvbnN0IG5vcm1hbGl6ZWQgPSBub3JtYWxpemVTa2lsbFJlZmVyZW5jZShza2lsbC5uYW1lKTtcbiAgICAgIGlmIChtYXRjaGVkLmhhcyhub3JtYWxpemVkKSB8fCBhdm9pZGVkLmhhcyhub3JtYWxpemVkKSkgY29udGludWU7XG4gICAgICAvLyBSZXNwZWN0IHRoZSBtYW5pZmVzdCBhbGxvd2xpc3Qgd2hlbiBwcmVzZW50OyB3aWxkY2FyZCAobnVsbCkgbGV0cyBhbGxcbiAgICAgIC8vIGluc3RhbGxlZCBza2lsbHMgY29tcGV0ZSBmb3Iga2V5d29yZCBtYXRjaC5cbiAgICAgIGlmIChhbGxvd1NldCAmJiAhYWxsb3dTZXQuaGFzKG5vcm1hbGl6ZWQpKSBjb250aW51ZTtcbiAgICAgIGlmIChza2lsbE1hdGNoZXNDb250ZXh0KHNraWxsLCBjb250ZXh0VG9rZW5zKSkge1xuICAgICAgICBtYXRjaGVkLmFkZChub3JtYWxpemVkKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBjb25zdCBvcmRlcmVkID0gWy4uLm1hdGNoZWRdXG4gICAgLmZpbHRlcihuYW1lID0+IGluc3RhbGxlZE5hbWVzLmhhcyhuYW1lKSAmJiAhYXZvaWRlZC5oYXMobmFtZSkpXG4gICAgLnNvcnQoKTtcbiAgY29uc3QgYWN0aXZhdGlvbkJsb2NrID0gZm9ybWF0U2tpbGxBY3RpdmF0aW9uQmxvY2sob3JkZXJlZCk7XG5cbiAgLy8gTWFuaWZlc3QtZHJpdmVuIHJlY29tbWVuZGF0aW9ucyAoYWRkaXRpdmUsIGRvZXMgbm90IG92ZXJyaWRlIGV4cGxpY2l0IGludGVudCkuXG4gIC8vIE9ubHkgc3VyZmFjZSBza2lsbHMgdGhlIG1hbmlmZXN0IGRlY2xhcmVzIGZvciB0aGlzIHVuaXQgdHlwZSB0aGF0IGFyZVxuICAvLyBpbnN0YWxsZWQgYW5kIG5vdCBhbHJlYWR5IGluIG1hdGNoZWQvYXZvaWRlZC5cbiAgY29uc3QgbWF0Y2hlZFNldCA9IG5ldyBTZXQob3JkZXJlZCk7XG4gIGNvbnN0IG1hbmlmZXN0TGlzdCA9IHJlc29sdmVTa2lsbE1hbmlmZXN0KHBhcmFtcy51bml0VHlwZSk7XG4gIGNvbnN0IHJlY29tbWVuZGF0aW9ucyA9IChtYW5pZmVzdExpc3QgPz8gW10pXG4gICAgLmZpbHRlcihuYW1lID0+IGluc3RhbGxlZE5hbWVzLmhhcyhuYW1lKSAmJiAhYXZvaWRlZC5oYXMobmFtZSkgJiYgIW1hdGNoZWRTZXQuaGFzKG5hbWUpKVxuICAgIC5zb3J0KCk7XG4gIGNvbnN0IHJlY29tbWVuZGF0aW9uc0Jsb2NrID0gZm9ybWF0U2tpbGxSZWNvbW1lbmRhdGlvbnNCbG9jayhwYXJhbXMudW5pdFR5cGUsIHJlY29tbWVuZGF0aW9ucyk7XG5cbiAgaWYgKCFhY3RpdmF0aW9uQmxvY2sgJiYgIXJlY29tbWVuZGF0aW9uc0Jsb2NrKSByZXR1cm4gXCJcIjtcbiAgaWYgKCFhY3RpdmF0aW9uQmxvY2spIHJldHVybiByZWNvbW1lbmRhdGlvbnNCbG9jaztcbiAgaWYgKCFyZWNvbW1lbmRhdGlvbnNCbG9jaykgcmV0dXJuIGFjdGl2YXRpb25CbG9jaztcbiAgcmV0dXJuIGAke2FjdGl2YXRpb25CbG9ja31cXG4ke3JlY29tbWVuZGF0aW9uc0Jsb2NrfWA7XG59XG5cbi8qKlxuICogQnVpbGQgdGhlIHNraWxsIGRpc2NvdmVyeSB0ZW1wbGF0ZSB2YXJpYWJsZXMgZm9yIHJlc2VhcmNoIHByb21wdHMuXG4gKiBSZXR1cm5zIHsgc2tpbGxEaXNjb3ZlcnlNb2RlLCBza2lsbERpc2NvdmVyeUluc3RydWN0aW9ucyB9IGZvciB0ZW1wbGF0ZSBzdWJzdGl0dXRpb24uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZFNraWxsRGlzY292ZXJ5VmFycygpOiB7IHNraWxsRGlzY292ZXJ5TW9kZTogc3RyaW5nOyBza2lsbERpc2NvdmVyeUluc3RydWN0aW9uczogc3RyaW5nIH0ge1xuICBjb25zdCBtb2RlID0gcmVzb2x2ZVNraWxsRGlzY292ZXJ5TW9kZSgpO1xuXG4gIGlmIChtb2RlID09PSBcIm9mZlwiKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHNraWxsRGlzY292ZXJ5TW9kZTogXCJvZmZcIixcbiAgICAgIHNraWxsRGlzY292ZXJ5SW5zdHJ1Y3Rpb25zOiBcIiBTa2lsbCBkaXNjb3ZlcnkgaXMgZGlzYWJsZWQuIFNraXAgdGhpcyBzdGVwLlwiLFxuICAgIH07XG4gIH1cblxuICBjb25zdCBhdXRvSW5zdGFsbCA9IG1vZGUgPT09IFwiYXV0b1wiO1xuICBjb25zdCBpbnN0cnVjdGlvbnMgPSBgXG4gICBJZGVudGlmeSB0aGUga2V5IHRlY2hub2xvZ2llcywgZnJhbWV3b3JrcywgYW5kIHNlcnZpY2VzIHRoaXMgd29yayBkZXBlbmRzIG9uIChlLmcuIFN0cmlwZSwgQ2xlcmssIFN1cGFiYXNlLCBKVUNFLCBTd2lmdFVJKS5cbiAgIEZvciBlYWNoLCBjaGVjayBpZiBhIHByb2Zlc3Npb25hbCBhZ2VudCBza2lsbCBhbHJlYWR5IGV4aXN0czpcbiAgIC0gRmlyc3QgY2hlY2sgXFxgPGF2YWlsYWJsZV9za2lsbHM+XFxgIGluIHlvdXIgc3lzdGVtIHByb21wdCBcdTIwMTQgYSBza2lsbCBtYXkgYWxyZWFkeSBiZSBpbnN0YWxsZWQuXG4gICAtIEZvciB0ZWNobm9sb2dpZXMgd2l0aG91dCBhbiBpbnN0YWxsZWQgc2tpbGwsIHJ1bjogXFxgbnB4IHNraWxscyBmaW5kIFwiPHRlY2hub2xvZ3k+XCJcXGBcbiAgIC0gT25seSBjb25zaWRlciBza2lsbHMgdGhhdCBhcmUgKipkaXJlY3RseSByZWxldmFudCoqIHRvIGNvcmUgdGVjaG5vbG9naWVzIFx1MjAxNCBub3QgdGFuZ2VudGlhbGx5IHJlbGF0ZWQuXG4gICAtIEV2YWx1YXRlIHJlc3VsdHMgYnkgaW5zdGFsbCBjb3VudCBhbmQgcmVsZXZhbmNlIHRvIHRoZSBhY3R1YWwgd29yay4ke2F1dG9JbnN0YWxsXG4gICAgPyBgXG4gICAtIEluc3RhbGwgcmVsZXZhbnQgc2tpbGxzOiBcXGBucHggc2tpbGxzIGFkZCA8b3duZXIvcmVwb0Bza2lsbD4gLWcgLXlcXGBcbiAgIC0gUmVjb3JkIGluc3RhbGxlZCBza2lsbHMgaW4gdGhlIFwiU2tpbGxzIERpc2NvdmVyZWRcIiBzZWN0aW9uIG9mIHlvdXIgcmVzZWFyY2ggb3V0cHV0LlxuICAgLSBJbnN0YWxsZWQgc2tpbGxzIHdpbGwgYXV0b21hdGljYWxseSBhcHBlYXIgaW4gc3Vic2VxdWVudCB1bml0cycgc3lzdGVtIHByb21wdHMgXHUyMDE0IG5vIG1hbnVhbCBzdGVwcyBuZWVkZWQuYFxuICAgIDogYFxuICAgLSBOb3RlIHByb21pc2luZyBza2lsbHMgaW4geW91ciByZXNlYXJjaCBvdXRwdXQgd2l0aCB0aGVpciBpbnN0YWxsIGNvbW1hbmRzLCBidXQgZG8gTk9UIGluc3RhbGwgdGhlbS5cbiAgIC0gVGhlIHVzZXIgd2lsbCBkZWNpZGUgd2hpY2ggdG8gaW5zdGFsbC5gXG4gIH1gO1xuXG4gIHJldHVybiB7XG4gICAgc2tpbGxEaXNjb3ZlcnlNb2RlOiBtb2RlLFxuICAgIHNraWxsRGlzY292ZXJ5SW5zdHJ1Y3Rpb25zOiBpbnN0cnVjdGlvbnMsXG4gIH07XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUZXh0IEhlbHBlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBmdW5jdGlvbiBleHRyYWN0TWFya2Rvd25TZWN0aW9uKGNvbnRlbnQ6IHN0cmluZywgaGVhZGluZzogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IG1hdGNoID0gbmV3IFJlZ0V4cChgXiMjICR7ZXNjYXBlUmVnRXhwKGhlYWRpbmcpfVxcXFxzKiRgLCBcIm1cIikuZXhlYyhjb250ZW50KTtcbiAgaWYgKCFtYXRjaCkgcmV0dXJuIG51bGw7XG5cbiAgY29uc3Qgc3RhcnQgPSBtYXRjaC5pbmRleCArIG1hdGNoWzBdLmxlbmd0aDtcbiAgY29uc3QgcmVzdCA9IGNvbnRlbnQuc2xpY2Uoc3RhcnQpO1xuICBjb25zdCBuZXh0SGVhZGluZyA9IHJlc3QubWF0Y2goL14jI1xccysvbSk7XG4gIGNvbnN0IGVuZCA9IG5leHRIZWFkaW5nPy5pbmRleCA/PyByZXN0Lmxlbmd0aDtcbiAgcmV0dXJuIHJlc3Quc2xpY2UoMCwgZW5kKS50cmltKCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBlc2NhcGVSZWdFeHAodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiB2YWx1ZS5yZXBsYWNlKC9bLiorP14ke30oKXxbXFxdXFxcXF0vZywgXCJcXFxcJCZcIik7XG59XG5cbmZ1bmN0aW9uIG9uZUxpbmUodGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHRleHQucmVwbGFjZSgvXFxzKy9nLCBcIiBcIikudHJpbSgpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU2VjdGlvbiBCdWlsZGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkUmVzdW1lU2VjdGlvbihcbiAgY29udGludWVDb250ZW50OiBzdHJpbmcgfCBudWxsLFxuICBsZWdhY3lDb250aW51ZUNvbnRlbnQ6IHN0cmluZyB8IG51bGwsXG4gIGNvbnRpbnVlUmVsUGF0aDogc3RyaW5nLFxuICBsZWdhY3lDb250aW51ZVJlbFBhdGg6IHN0cmluZyB8IG51bGwsXG4pOiBzdHJpbmcge1xuICBjb25zdCByZXNvbHZlZENvbnRlbnQgPSBjb250aW51ZUNvbnRlbnQgPz8gbGVnYWN5Q29udGludWVDb250ZW50O1xuICBjb25zdCByZXNvbHZlZFJlbFBhdGggPSBjb250aW51ZUNvbnRlbnQgPyBjb250aW51ZVJlbFBhdGggOiBsZWdhY3lDb250aW51ZVJlbFBhdGg7XG5cbiAgaWYgKCFyZXNvbHZlZENvbnRlbnQgfHwgIXJlc29sdmVkUmVsUGF0aCkge1xuICAgIHJldHVybiBbXCIjIyBSZXN1bWUgU3RhdGVcIiwgXCItIE5vIGNvbnRpbnVlIGZpbGUgcHJlc2VudC4gU3RhcnQgZnJvbSB0aGUgdG9wIG9mIHRoZSB0YXNrIHBsYW4uXCJdLmpvaW4oXCJcXG5cIik7XG4gIH1cblxuICBjb25zdCBjb250ID0gcGFyc2VDb250aW51ZShyZXNvbHZlZENvbnRlbnQpO1xuICBjb25zdCBsaW5lcyA9IFtcbiAgICBcIiMjIFJlc3VtZSBTdGF0ZVwiLFxuICAgIGBTb3VyY2U6IFxcYCR7cmVzb2x2ZWRSZWxQYXRofVxcYGAsXG4gICAgYC0gU3RhdHVzOiAke2NvbnQuZnJvbnRtYXR0ZXIuc3RhdHVzIHx8IFwiaW5fcHJvZ3Jlc3NcIn1gLFxuICBdO1xuXG4gIGlmIChjb250LmZyb250bWF0dGVyLnN0ZXAgJiYgY29udC5mcm9udG1hdHRlci50b3RhbFN0ZXBzKSB7XG4gICAgbGluZXMucHVzaChgLSBQcm9ncmVzczogc3RlcCAke2NvbnQuZnJvbnRtYXR0ZXIuc3RlcH0gb2YgJHtjb250LmZyb250bWF0dGVyLnRvdGFsU3RlcHN9YCk7XG4gIH1cbiAgaWYgKGNvbnQuY29tcGxldGVkV29yaykgbGluZXMucHVzaChgLSBDb21wbGV0ZWQ6ICR7b25lTGluZShjb250LmNvbXBsZXRlZFdvcmspfWApO1xuICBpZiAoY29udC5yZW1haW5pbmdXb3JrKSBsaW5lcy5wdXNoKGAtIFJlbWFpbmluZzogJHtvbmVMaW5lKGNvbnQucmVtYWluaW5nV29yayl9YCk7XG4gIGlmIChjb250LmRlY2lzaW9ucykgbGluZXMucHVzaChgLSBEZWNpc2lvbnM6ICR7b25lTGluZShjb250LmRlY2lzaW9ucyl9YCk7XG4gIGlmIChjb250Lm5leHRBY3Rpb24pIGxpbmVzLnB1c2goYC0gTmV4dCBhY3Rpb246ICR7b25lTGluZShjb250Lm5leHRBY3Rpb24pfWApO1xuXG4gIHJldHVybiBsaW5lcy5qb2luKFwiXFxuXCIpO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gYnVpbGRDYXJyeUZvcndhcmRTZWN0aW9uKHByaW9yU3VtbWFyeVBhdGhzOiBzdHJpbmdbXSwgYmFzZTogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgaWYgKHByaW9yU3VtbWFyeVBhdGhzLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiBbXCIjIyBDYXJyeS1Gb3J3YXJkIENvbnRleHRcIiwgXCItIE5vIHByaW9yIHRhc2sgc3VtbWFyaWVzIGluIHRoaXMgc2xpY2UuXCJdLmpvaW4oXCJcXG5cIik7XG4gIH1cblxuICBjb25zdCBpdGVtcyA9IGF3YWl0IFByb21pc2UuYWxsKHByaW9yU3VtbWFyeVBhdGhzLm1hcChhc3luYyAocmVsUGF0aCkgPT4ge1xuICAgIGNvbnN0IGFic1BhdGggPSBqb2luKGJhc2UsIHJlbFBhdGgpO1xuICAgIGNvbnN0IGNvbnRlbnQgPSBhd2FpdCBsb2FkRmlsZShhYnNQYXRoKTtcbiAgICBpZiAoIWNvbnRlbnQpIHJldHVybiBgLSBcXGAke3JlbFBhdGh9XFxgYDtcblxuICAgIGNvbnN0IHN1bW1hcnkgPSBwYXJzZVN1bW1hcnkoY29udGVudCk7XG4gICAgY29uc3QgcHJvdmlkZWQgPSBzdW1tYXJ5LmZyb250bWF0dGVyLnByb3ZpZGVzLnNsaWNlKDAsIDIpLmpvaW4oXCI7IFwiKTtcbiAgICBjb25zdCBkZWNpc2lvbnMgPSBzdW1tYXJ5LmZyb250bWF0dGVyLmtleV9kZWNpc2lvbnMuc2xpY2UoMCwgMikuam9pbihcIjsgXCIpO1xuICAgIGNvbnN0IHBhdHRlcm5zID0gc3VtbWFyeS5mcm9udG1hdHRlci5wYXR0ZXJuc19lc3RhYmxpc2hlZC5zbGljZSgwLCAyKS5qb2luKFwiOyBcIik7XG4gICAgY29uc3Qga2V5RmlsZXMgPSBzdW1tYXJ5LmZyb250bWF0dGVyLmtleV9maWxlcy5zbGljZSgwLCAzKS5qb2luKFwiOyBcIik7XG4gICAgY29uc3QgZGlhZ25vc3RpY3MgPSBleHRyYWN0TWFya2Rvd25TZWN0aW9uKGNvbnRlbnQsIFwiRGlhZ25vc3RpY3NcIik7XG5cbiAgICBjb25zdCBwYXJ0cyA9IFtzdW1tYXJ5LnRpdGxlIHx8IHJlbFBhdGhdO1xuICAgIGlmIChzdW1tYXJ5Lm9uZUxpbmVyKSBwYXJ0cy5wdXNoKHN1bW1hcnkub25lTGluZXIpO1xuICAgIGlmIChwcm92aWRlZCkgcGFydHMucHVzaChgcHJvdmlkZXM6ICR7cHJvdmlkZWR9YCk7XG4gICAgaWYgKGRlY2lzaW9ucykgcGFydHMucHVzaChgZGVjaXNpb25zOiAke2RlY2lzaW9uc31gKTtcbiAgICBpZiAocGF0dGVybnMpIHBhcnRzLnB1c2goYHBhdHRlcm5zOiAke3BhdHRlcm5zfWApO1xuICAgIGlmIChrZXlGaWxlcykgcGFydHMucHVzaChga2V5X2ZpbGVzOiAke2tleUZpbGVzfWApO1xuICAgIGlmIChkaWFnbm9zdGljcykgcGFydHMucHVzaChgZGlhZ25vc3RpY3M6ICR7b25lTGluZShkaWFnbm9zdGljcyl9YCk7XG5cbiAgICByZXR1cm4gYC0gXFxgJHtyZWxQYXRofVxcYCBcdTIwMTQgJHtwYXJ0cy5qb2luKFwiIHwgXCIpfWA7XG4gIH0pKTtcblxuICByZXR1cm4gW1wiIyMgQ2FycnktRm9yd2FyZCBDb250ZXh0XCIsIC4uLml0ZW1zXS5qb2luKFwiXFxuXCIpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZXh0cmFjdFNsaWNlRXhlY3V0aW9uRXhjZXJwdChjb250ZW50OiBzdHJpbmcgfCBudWxsLCByZWxQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAoIWNvbnRlbnQpIHtcbiAgICByZXR1cm4gW1xuICAgICAgXCIjIyBTbGljZSBQbGFuIEV4Y2VycHRcIixcbiAgICAgIGBTbGljZSBwbGFuIG5vdCBmb3VuZCBhdCBkaXNwYXRjaCB0aW1lLiBSZWFkIFxcYCR7cmVsUGF0aH1cXGAgYmVmb3JlIHJ1bm5pbmcgc2xpY2UtbGV2ZWwgdmVyaWZpY2F0aW9uLmAsXG4gICAgXS5qb2luKFwiXFxuXCIpO1xuICB9XG5cbiAgY29uc3QgbGluZXMgPSBjb250ZW50LnNwbGl0KFwiXFxuXCIpO1xuICBjb25zdCBnb2FsTGluZSA9IGxpbmVzLmZpbmQobCA9PiBsLnN0YXJ0c1dpdGgoXCIqKkdvYWw6KipcIikpPy50cmltKCk7XG4gIGNvbnN0IGRlbW9MaW5lID0gbGluZXMuZmluZChsID0+IGwuc3RhcnRzV2l0aChcIioqRGVtbzoqKlwiKSk/LnRyaW0oKTtcblxuICBjb25zdCB2ZXJpZmljYXRpb24gPSBleHRyYWN0TWFya2Rvd25TZWN0aW9uKGNvbnRlbnQsIFwiVmVyaWZpY2F0aW9uXCIpO1xuICBjb25zdCBvYnNlcnZhYmlsaXR5ID0gZXh0cmFjdE1hcmtkb3duU2VjdGlvbihjb250ZW50LCBcIk9ic2VydmFiaWxpdHkgLyBEaWFnbm9zdGljc1wiKTtcblxuICBjb25zdCBwYXJ0cyA9IFtcIiMjIFNsaWNlIFBsYW4gRXhjZXJwdFwiLCBgU291cmNlOiBcXGAke3JlbFBhdGh9XFxgYF07XG4gIGlmIChnb2FsTGluZSkgcGFydHMucHVzaChnb2FsTGluZSk7XG4gIGlmIChkZW1vTGluZSkgcGFydHMucHVzaChkZW1vTGluZSk7XG4gIGlmICh2ZXJpZmljYXRpb24pIHtcbiAgICBwYXJ0cy5wdXNoKFwiXCIsIFwiIyMjIFNsaWNlIFZlcmlmaWNhdGlvblwiLCB2ZXJpZmljYXRpb24udHJpbSgpKTtcbiAgfVxuICBpZiAob2JzZXJ2YWJpbGl0eSkge1xuICAgIHBhcnRzLnB1c2goXCJcIiwgXCIjIyMgU2xpY2UgT2JzZXJ2YWJpbGl0eSAvIERpYWdub3N0aWNzXCIsIG9ic2VydmFiaWxpdHkudHJpbSgpKTtcbiAgfVxuXG4gIHJldHVybiBwYXJ0cy5qb2luKFwiXFxuXCIpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUHJpb3IgVGFzayBTdW1tYXJpZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRQcmlvclRhc2tTdW1tYXJ5UGF0aHMoXG4gIG1pZDogc3RyaW5nLCBzaWQ6IHN0cmluZywgY3VycmVudFRpZDogc3RyaW5nLCBiYXNlOiBzdHJpbmcsXG4pOiBQcm9taXNlPHN0cmluZ1tdPiB7XG4gIGNvbnN0IHREaXIgPSByZXNvbHZlVGFza3NEaXIoYmFzZSwgbWlkLCBzaWQpO1xuICBpZiAoIXREaXIpIHJldHVybiBbXTtcblxuICBjb25zdCBzdW1tYXJ5RmlsZXMgPSByZXNvbHZlVGFza0ZpbGVzKHREaXIsIFwiU1VNTUFSWVwiKTtcbiAgY29uc3QgY3VycmVudE51bSA9IHBhcnNlSW50KGN1cnJlbnRUaWQucmVwbGFjZSgvXlQvLCBcIlwiKSwgMTApO1xuICBjb25zdCBzUmVsID0gcmVsU2xpY2VQYXRoKGJhc2UsIG1pZCwgc2lkKTtcblxuICByZXR1cm4gc3VtbWFyeUZpbGVzXG4gICAgLmZpbHRlcihmID0+IHtcbiAgICAgIGNvbnN0IG51bSA9IHBhcnNlSW50KGYucmVwbGFjZSgvXlQvLCBcIlwiKSwgMTApO1xuICAgICAgcmV0dXJuIG51bSA8IGN1cnJlbnROdW07XG4gICAgfSlcbiAgICAubWFwKGYgPT4gYCR7c1JlbH0vdGFza3MvJHtmfWApO1xufVxuXG4vKipcbiAqIEdldCBjYXJyeS1mb3J3YXJkIHN1bW1hcnkgcGF0aHMgc2NvcGVkIHRvIGEgdGFzaydzIGRlcml2ZWQgZGVwZW5kZW5jaWVzLlxuICpcbiAqIEluc3RlYWQgb2YgYWxsIHByaW9yIHRhc2tzIChvcmRlci1iYXNlZCksIHJldHVybnMgb25seSBzdW1tYXJpZXMgZm9yIHRhc2tcbiAqIElEcyBpbiBgZGVwZW5kc09uYC4gVXNlZCBieSByZWFjdGl2ZS1leGVjdXRlIHRvIGdpdmUgZWFjaCBzdWJhZ2VudCBvbmx5XG4gKiB0aGUgY29udGV4dCBpdCBhY3R1YWxseSBuZWVkcyBcdTIwMTQgbm90IHNpYmxpbmcgdGFza3MgZnJvbSBhIHBhcmFsbGVsIGJhdGNoLlxuICpcbiAqIEZhbGxzIGJhY2sgdG8gb3JkZXItYmFzZWQgd2hlbiBkZXBlbmRzT24gaXMgZW1wdHkgKHJvb3QgdGFza3Mgc3RpbGwgZ2V0XG4gKiBhbnkgYXZhaWxhYmxlIHByaW9yIHN1bW1hcmllcyBmb3IgY29udGludWl0eSkuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXREZXBlbmRlbmN5VGFza1N1bW1hcnlQYXRocyhcbiAgbWlkOiBzdHJpbmcsIHNpZDogc3RyaW5nLCBjdXJyZW50VGlkOiBzdHJpbmcsXG4gIGRlcGVuZHNPbjogc3RyaW5nW10sIGJhc2U6IHN0cmluZyxcbik6IFByb21pc2U8c3RyaW5nW10+IHtcbiAgLy8gSWYgbm8gZGVwZW5kZW5jaWVzLCBmYWxsIGJhY2sgdG8gb3JkZXItYmFzZWQgZm9yIHJvb3QgdGFza3NcbiAgaWYgKGRlcGVuZHNPbi5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm4gZ2V0UHJpb3JUYXNrU3VtbWFyeVBhdGhzKG1pZCwgc2lkLCBjdXJyZW50VGlkLCBiYXNlKTtcbiAgfVxuXG4gIGNvbnN0IHREaXIgPSByZXNvbHZlVGFza3NEaXIoYmFzZSwgbWlkLCBzaWQpO1xuICBpZiAoIXREaXIpIHJldHVybiBbXTtcblxuICBjb25zdCBzdW1tYXJ5RmlsZXMgPSByZXNvbHZlVGFza0ZpbGVzKHREaXIsIFwiU1VNTUFSWVwiKTtcbiAgY29uc3Qgc1JlbCA9IHJlbFNsaWNlUGF0aChiYXNlLCBtaWQsIHNpZCk7XG4gIGNvbnN0IGRlcFNldCA9IG5ldyBTZXQoZGVwZW5kc09uLm1hcCgoZCkgPT4gZC50b1VwcGVyQ2FzZSgpKSk7XG5cbiAgcmV0dXJuIHN1bW1hcnlGaWxlc1xuICAgIC5maWx0ZXIoKGYpID0+IHtcbiAgICAgIC8vIEV4dHJhY3QgdGFzayBJRCBmcm9tIGZpbGVuYW1lOiBcIlQwMi1TVU1NQVJZLm1kXCIgXHUyMTkyIFwiVDAyXCJcbiAgICAgIGNvbnN0IHRpZCA9IGYucmVwbGFjZSgvLVNVTU1BUllcXC5tZCQvaSwgXCJcIikudG9VcHBlckNhc2UoKTtcbiAgICAgIHJldHVybiBkZXBTZXQuaGFzKHRpZCk7XG4gICAgfSlcbiAgICAubWFwKChmKSA9PiBgJHtzUmVsfS90YXNrcy8ke2Z9YCk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBBZGFwdGl2ZSBSZXBsYW5uaW5nIENoZWNrcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBDaGVjayBpZiB0aGUgbW9zdCByZWNlbnRseSBjb21wbGV0ZWQgc2xpY2UgbmVlZHMgcmVhc3Nlc3NtZW50LlxuICogUmV0dXJucyB7IHNsaWNlSWQgfSBpZiByZWFzc2Vzc21lbnQgaXMgbmVlZGVkLCBudWxsIG90aGVyd2lzZS5cbiAqXG4gKiBTa2lwcyByZWFzc2Vzc21lbnQgd2hlbjpcbiAqIC0gTm8gcm9hZG1hcCBleGlzdHMgeWV0XG4gKiAtIE5vIHNsaWNlcyBhcmUgY29tcGxldGVkXG4gKiAtIFRoZSBsYXN0IGNvbXBsZXRlZCBzbGljZSBhbHJlYWR5IGhhcyBhbiBhc3Nlc3NtZW50IGZpbGVcbiAqIC0gQWxsIHNsaWNlcyBhcmUgY29tcGxldGUgKG1pbGVzdG9uZSBkb25lIFx1MjAxNCBubyBwb2ludCByZWFzc2Vzc2luZylcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNoZWNrTmVlZHNSZWFzc2Vzc21lbnQoXG4gIGJhc2U6IHN0cmluZywgbWlkOiBzdHJpbmcsIHN0YXRlOiBHU0RTdGF0ZSxcbik6IFByb21pc2U8eyBzbGljZUlkOiBzdHJpbmcgfSB8IG51bGw+IHtcbiAgLy8gREIgcHJpbWFyeSBwYXRoIFx1MjAxNCBmYWxsIHRocm91Z2ggdG8gZmlsZS1iYXNlZCB3aGVuIERCIGhhcyBubyBkYXRhIGZvciB0aGlzIG1pbGVzdG9uZVxuICB0cnkge1xuICAgIGNvbnN0IHsgaXNEYkF2YWlsYWJsZSwgZ2V0TWlsZXN0b25lU2xpY2VzIH0gPSBhd2FpdCBpbXBvcnQoXCIuL2dzZC1kYi5qc1wiKTtcbiAgICBpZiAoaXNEYkF2YWlsYWJsZSgpKSB7XG4gICAgICBjb25zdCBzbGljZXMgPSBnZXRNaWxlc3RvbmVTbGljZXMobWlkKTtcbiAgICAgIGlmIChzbGljZXMubGVuZ3RoID4gMCkge1xuICAgICAgICBjb25zdCBjb21wbGV0ZWRTbGljZUlkcyA9IHNsaWNlcy5maWx0ZXIocyA9PiBzLnN0YXR1cyA9PT0gXCJjb21wbGV0ZVwiKS5tYXAocyA9PiBzLmlkKTtcbiAgICAgICAgY29uc3QgaGFzSW5jb21wbGV0ZSA9IHNsaWNlcy5zb21lKHMgPT4gcy5zdGF0dXMgIT09IFwiY29tcGxldGVcIik7XG4gICAgICAgIGlmIChjb21wbGV0ZWRTbGljZUlkcy5sZW5ndGggPT09IDAgfHwgIWhhc0luY29tcGxldGUpIHJldHVybiBudWxsO1xuICAgICAgICBjb25zdCBsYXN0Q29tcGxldGVkID0gY29tcGxldGVkU2xpY2VJZHNbY29tcGxldGVkU2xpY2VJZHMubGVuZ3RoIC0gMV07XG4gICAgICAgIGNvbnN0IGFzc2Vzc21lbnRGaWxlID0gcmVzb2x2ZVNsaWNlRmlsZShiYXNlLCBtaWQsIGxhc3RDb21wbGV0ZWQsIFwiQVNTRVNTTUVOVFwiKTtcbiAgICAgICAgY29uc3QgaGFzQXNzZXNzbWVudCA9ICEhKGFzc2Vzc21lbnRGaWxlICYmIGF3YWl0IGxvYWRGaWxlKGFzc2Vzc21lbnRGaWxlKSk7XG4gICAgICAgIGlmIChoYXNBc3Nlc3NtZW50KSByZXR1cm4gbnVsbDtcbiAgICAgICAgY29uc3Qgc3VtbWFyeUZpbGUgPSByZXNvbHZlU2xpY2VGaWxlKGJhc2UsIG1pZCwgbGFzdENvbXBsZXRlZCwgXCJTVU1NQVJZXCIpO1xuICAgICAgICBjb25zdCBoYXNTdW1tYXJ5ID0gISEoc3VtbWFyeUZpbGUgJiYgYXdhaXQgbG9hZEZpbGUoc3VtbWFyeUZpbGUpKTtcbiAgICAgICAgaWYgKCFoYXNTdW1tYXJ5KSByZXR1cm4gbnVsbDtcbiAgICAgICAgcmV0dXJuIHsgc2xpY2VJZDogbGFzdENvbXBsZXRlZCB9O1xuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgbG9nV2FybmluZyhcInByb21wdFwiLCBgY2hlY2tOZWVkc1JlYXNzZXNzbWVudCBEQiBsb29rdXAgZmFpbGVkOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gKTtcbiAgfVxuXG4gIC8vIEZpbGUtYmFzZWQgZmFsbGJhY2sgdXNpbmcgcm9hZG1hcCBjaGVja2JveGVzXG4gIGNvbnN0IHJvYWRtYXBQYXRoID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZSwgbWlkLCBcIlJPQURNQVBcIik7XG4gIGlmICghcm9hZG1hcFBhdGgpIHJldHVybiBudWxsO1xuICBjb25zdCByb2FkbWFwQ29udGVudCA9IGF3YWl0IGxvYWRGaWxlKHJvYWRtYXBQYXRoKTtcbiAgaWYgKCFyb2FkbWFwQ29udGVudCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHBhcnNlZCA9IHBhcnNlUm9hZG1hcChyb2FkbWFwQ29udGVudCk7XG4gIGNvbnN0IGZpbGVDb21wbGV0ZWRJZHMgPSBwYXJzZWQuc2xpY2VzLmZpbHRlcihzID0+IHMuZG9uZSkubWFwKHMgPT4gcy5pZCk7XG4gIGNvbnN0IGZpbGVIYXNJbmNvbXBsZXRlID0gcGFyc2VkLnNsaWNlcy5zb21lKHMgPT4gIXMuZG9uZSk7XG4gIGlmIChmaWxlQ29tcGxldGVkSWRzLmxlbmd0aCA9PT0gMCB8fCAhZmlsZUhhc0luY29tcGxldGUpIHJldHVybiBudWxsO1xuICBjb25zdCBsYXN0RG9uZSA9IGZpbGVDb21wbGV0ZWRJZHNbZmlsZUNvbXBsZXRlZElkcy5sZW5ndGggLSAxXTtcbiAgY29uc3QgYXNzZXNzRmlsZSA9IHJlc29sdmVTbGljZUZpbGUoYmFzZSwgbWlkLCBsYXN0RG9uZSwgXCJBU1NFU1NNRU5UXCIpO1xuICBjb25zdCBoYXNBc3Nlc3MgPSAhIShhc3Nlc3NGaWxlICYmIGF3YWl0IGxvYWRGaWxlKGFzc2Vzc0ZpbGUpKTtcbiAgaWYgKGhhc0Fzc2VzcykgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHN1bW1GaWxlID0gcmVzb2x2ZVNsaWNlRmlsZShiYXNlLCBtaWQsIGxhc3REb25lLCBcIlNVTU1BUllcIik7XG4gIGNvbnN0IGhhc1N1bW0gPSAhIShzdW1tRmlsZSAmJiBhd2FpdCBsb2FkRmlsZShzdW1tRmlsZSkpO1xuICBpZiAoIWhhc1N1bW0pIHJldHVybiBudWxsO1xuICByZXR1cm4geyBzbGljZUlkOiBsYXN0RG9uZSB9O1xufVxuXG4vKipcbiAqIENoZWNrIGlmIHRoZSBtb3N0IHJlY2VudGx5IGNvbXBsZXRlZCBzbGljZSBuZWVkcyBhIFVBVCBydW4uXG4gKiBSZXR1cm5zIHsgc2xpY2VJZCwgdWF0VHlwZSB9IGlmIFVBVCBzaG91bGQgYmUgZGlzcGF0Y2hlZCwgbnVsbCBvdGhlcndpc2UuXG4gKlxuICogU2tpcHMgd2hlbjpcbiAqIC0gTm8gcm9hZG1hcCBvciBubyBjb21wbGV0ZWQgc2xpY2VzXG4gKiAtIEFsbCBzbGljZXMgYXJlIGRvbmUgKG1pbGVzdG9uZSBjb21wbGV0ZSBwYXRoIFx1MjAxNCByZWFzc2Vzc21lbnQgaGFuZGxlcyBpdClcbiAqIC0gdWF0X2Rpc3BhdGNoIHByZWZlcmVuY2UgaXMgbm90IGVuYWJsZWRcbiAqIC0gTm8gVUFUIGZpbGUgZXhpc3RzIGZvciB0aGUgc2xpY2VcbiAqIC0gVUFUIHJlc3VsdCBmaWxlIGFscmVhZHkgZXhpc3RzIChpZGVtcG90ZW50IFx1MjAxNCBhbHJlYWR5IHJhbilcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNoZWNrTmVlZHNSdW5VYXQoXG4gIGJhc2U6IHN0cmluZywgbWlkOiBzdHJpbmcsIHN0YXRlOiBHU0RTdGF0ZSwgcHJlZnM6IEdTRFByZWZlcmVuY2VzIHwgdW5kZWZpbmVkLFxuKTogUHJvbWlzZTx7IHNsaWNlSWQ6IHN0cmluZzsgdWF0VHlwZTogVWF0VHlwZSB9IHwgbnVsbD4ge1xuICAvLyBEQiBwcmltYXJ5IHBhdGggXHUyMDE0IGZhbGwgdGhyb3VnaCB0byBmaWxlLWJhc2VkIHdoZW4gREIgaGFzIG5vIGRhdGEgZm9yIHRoaXMgbWlsZXN0b25lXG4gIHRyeSB7XG4gICAgY29uc3QgeyBpc0RiQXZhaWxhYmxlLCBnZXRNaWxlc3RvbmVTbGljZXMgfSA9IGF3YWl0IGltcG9ydChcIi4vZ3NkLWRiLmpzXCIpO1xuICAgIGlmIChpc0RiQXZhaWxhYmxlKCkpIHtcbiAgICAgIGNvbnN0IHNsaWNlcyA9IGdldE1pbGVzdG9uZVNsaWNlcyhtaWQpO1xuICAgICAgaWYgKHNsaWNlcy5sZW5ndGggPiAwKSB7XG4gICAgICAgIGNvbnN0IGNvbXBsZXRlZFNsaWNlcyA9IHNsaWNlcy5maWx0ZXIocyA9PiBzLnN0YXR1cyA9PT0gXCJjb21wbGV0ZVwiKTtcbiAgICAgICAgY29uc3QgaW5jb21wbGV0ZVNsaWNlcyA9IHNsaWNlcy5maWx0ZXIocyA9PiBzLnN0YXR1cyAhPT0gXCJjb21wbGV0ZVwiKTtcbiAgICAgICAgaWYgKGNvbXBsZXRlZFNsaWNlcy5sZW5ndGggPT09IDApIHJldHVybiBudWxsO1xuICAgICAgICBpZiAoaW5jb21wbGV0ZVNsaWNlcy5sZW5ndGggPT09IDApIHJldHVybiBudWxsO1xuICAgICAgICBpZiAoIXByZWZzPy51YXRfZGlzcGF0Y2gpIHJldHVybiBudWxsO1xuICAgICAgICBjb25zdCBsYXN0Q29tcGxldGVkID0gY29tcGxldGVkU2xpY2VzW2NvbXBsZXRlZFNsaWNlcy5sZW5ndGggLSAxXTtcbiAgICAgICAgY29uc3Qgc2lkID0gbGFzdENvbXBsZXRlZC5pZDtcbiAgICAgICAgY29uc3QgdWF0RmlsZSA9IHJlc29sdmVTbGljZUZpbGUoYmFzZSwgbWlkLCBzaWQsIFwiVUFUXCIpO1xuICAgICAgICBpZiAoIXVhdEZpbGUpIHJldHVybiBudWxsO1xuICAgICAgICBjb25zdCB1YXRDb250ZW50ID0gYXdhaXQgbG9hZEZpbGUodWF0RmlsZSk7XG4gICAgICAgIGlmICghdWF0Q29udGVudCkgcmV0dXJuIG51bGw7XG4gICAgICAgIC8vIElmIHRoZSBVQVQgZmlsZSBhbHJlYWR5IGNvbnRhaW5zIGEgdmVyZGljdCwgVUFUIGhhcyBiZWVuIHJ1biBcdTIwMTQgc2tpcFxuICAgICAgICBpZiAoaGFzVmVyZGljdCh1YXRDb250ZW50KSkgcmV0dXJuIG51bGw7XG4gICAgICAgIC8vIEFsc28gY2hlY2sgdGhlIEFTU0VTU01FTlQgZmlsZSBcdTIwMTQgdGhlIHJ1bi11YXQgcHJvbXB0IHdyaXRlcyB0aGUgdmVyZGljdFxuICAgICAgICAvLyB0aGVyZSAodmlhIGdzZF9zdW1tYXJ5X3NhdmUgYXJ0aWZhY3RfdHlwZTpcIkFTU0VTU01FTlRcIiksIG5vdCBpbnRvIHRoZVxuICAgICAgICAvLyBVQVQgc3BlYyBmaWxlLiBXaXRob3V0IHRoaXMgY2hlY2sgdGhlIHVuaXQgcmUtZGlzcGF0Y2hlcyBpbmRlZmluaXRlbHkuXG4gICAgICAgIGNvbnN0IGFzc2Vzc21lbnRGaWxlID0gcmVzb2x2ZVNsaWNlRmlsZShiYXNlLCBtaWQsIHNpZCwgXCJBU1NFU1NNRU5UXCIpO1xuICAgICAgICBpZiAoYXNzZXNzbWVudEZpbGUpIHtcbiAgICAgICAgICBjb25zdCBhc3Nlc3NtZW50Q29udGVudCA9IGF3YWl0IGxvYWRGaWxlKGFzc2Vzc21lbnRGaWxlKTtcbiAgICAgICAgICBpZiAoYXNzZXNzbWVudENvbnRlbnQgJiYgaGFzVmVyZGljdChhc3Nlc3NtZW50Q29udGVudCkpIHJldHVybiBudWxsO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHVhdFR5cGUgPSBnZXRVYXRUeXBlKHVhdENvbnRlbnQpO1xuICAgICAgICByZXR1cm4geyBzbGljZUlkOiBzaWQsIHVhdFR5cGUgfTtcbiAgICAgIH1cbiAgICB9XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGxvZ1dhcm5pbmcoXCJwcm9tcHRcIiwgYGNoZWNrTmVlZHNSdW5VYXQgREIgbG9va3VwIGZhaWxlZDogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCk7XG4gIH1cblxuICAvLyBGaWxlLWJhc2VkIGZhbGxiYWNrIHVzaW5nIHJvYWRtYXAgY2hlY2tib3hlc1xuICBpZiAoIXByZWZzPy51YXRfZGlzcGF0Y2gpIHJldHVybiBudWxsO1xuICBjb25zdCByb2FkbWFwUGF0aCA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2UsIG1pZCwgXCJST0FETUFQXCIpO1xuICBpZiAoIXJvYWRtYXBQYXRoKSByZXR1cm4gbnVsbDtcbiAgY29uc3Qgcm9hZG1hcENvbnRlbnQgPSBhd2FpdCBsb2FkRmlsZShyb2FkbWFwUGF0aCk7XG4gIGlmICghcm9hZG1hcENvbnRlbnQpIHJldHVybiBudWxsO1xuICBjb25zdCBwYXJzZWQgPSBwYXJzZVJvYWRtYXAocm9hZG1hcENvbnRlbnQpO1xuICBjb25zdCBjb21wbGV0ZWRGaWxlU2xpY2VzID0gcGFyc2VkLnNsaWNlcy5maWx0ZXIocyA9PiBzLmRvbmUpO1xuICBjb25zdCBpbmNvbXBsZXRlRmlsZVNsaWNlcyA9IHBhcnNlZC5zbGljZXMuZmlsdGVyKHMgPT4gIXMuZG9uZSk7XG4gIGlmIChjb21wbGV0ZWRGaWxlU2xpY2VzLmxlbmd0aCA9PT0gMCB8fCBpbmNvbXBsZXRlRmlsZVNsaWNlcy5sZW5ndGggPT09IDApIHJldHVybiBudWxsO1xuICBjb25zdCBsYXN0Q29tcGxldGVkRmlsZSA9IGNvbXBsZXRlZEZpbGVTbGljZXNbY29tcGxldGVkRmlsZVNsaWNlcy5sZW5ndGggLSAxXTtcbiAgY29uc3QgdWF0U2lkID0gbGFzdENvbXBsZXRlZEZpbGUuaWQ7XG4gIGNvbnN0IHVhdEZpbGVGYiA9IHJlc29sdmVTbGljZUZpbGUoYmFzZSwgbWlkLCB1YXRTaWQsIFwiVUFUXCIpO1xuICBpZiAoIXVhdEZpbGVGYikgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHVhdENvbnRlbnRGYiA9IGF3YWl0IGxvYWRGaWxlKHVhdEZpbGVGYik7XG4gIGlmICghdWF0Q29udGVudEZiKSByZXR1cm4gbnVsbDtcbiAgLy8gSWYgdGhlIFVBVCBmaWxlIGFscmVhZHkgY29udGFpbnMgYSB2ZXJkaWN0LCBVQVQgaGFzIGJlZW4gcnVuIFx1MjAxNCBza2lwXG4gIGlmIChoYXNWZXJkaWN0KHVhdENvbnRlbnRGYikpIHJldHVybiBudWxsO1xuICAvLyBBbHNvIGNoZWNrIHRoZSBBU1NFU1NNRU5UIGZpbGUgZm9yIHRoZSBmaWxlLWJhc2VkIGZhbGxiYWNrIHBhdGggKHNhbWVcbiAgLy8gcmVhc29uIGFzIHRoZSBEQiBwYXRoIGFib3ZlIFx1MjAxNCB2ZXJkaWN0IGxpdmVzIGluIEFTU0VTU01FTlQsIG5vdCBVQVQpLlxuICBjb25zdCBhc3Nlc3NtZW50RmlsZUZiID0gcmVzb2x2ZVNsaWNlRmlsZShiYXNlLCBtaWQsIHVhdFNpZCwgXCJBU1NFU1NNRU5UXCIpO1xuICBpZiAoYXNzZXNzbWVudEZpbGVGYikge1xuICAgIGNvbnN0IGFzc2Vzc21lbnRDb250ZW50RmIgPSBhd2FpdCBsb2FkRmlsZShhc3Nlc3NtZW50RmlsZUZiKTtcbiAgICBpZiAoYXNzZXNzbWVudENvbnRlbnRGYiAmJiBoYXNWZXJkaWN0KGFzc2Vzc21lbnRDb250ZW50RmIpKSByZXR1cm4gbnVsbDtcbiAgfVxuICBjb25zdCB1YXRUeXBlRmIgPSBnZXRVYXRUeXBlKHVhdENvbnRlbnRGYik7XG4gIHJldHVybiB7IHNsaWNlSWQ6IHVhdFNpZCwgdWF0VHlwZTogdWF0VHlwZUZiIH07XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBQcm9tcHQgQnVpbGRlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogQnVpbGQgYSBwcm9tcHQgZm9yIHRoZSBkaXNjdXNzLW1pbGVzdG9uZSB1bml0IHR5cGUuXG4gKiBMb2FkcyB0aGUgZ3VpZGVkLWRpc2N1c3MtbWlsZXN0b25lIHRlbXBsYXRlIGFuZCBpbmxpbmVzIHRoZSBDT05URVhULURSQUZUXG4gKiBhcyBhIHNlZWQgd2hlbiBwcmVzZW50LiBUaGUgZGlzY3Vzc2lvbiBhZ2VudCBpbnRlcnZpZXdzIHRoZSB1c2VyLCB3cml0ZXNcbiAqIGEgZnVsbCBDT05URVhULm1kLCBhbmQgdGhlIHBoYXNlIHRyYW5zaXRpb25zIHRvIHByZS1wbGFubmluZyBhdXRvbWF0aWNhbGx5LlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gYnVpbGREaXNjdXNzTWlsZXN0b25lUHJvbXB0KFxuICBtaWQ6IHN0cmluZyxcbiAgbWlkVGl0bGU6IHN0cmluZyxcbiAgYmFzZTogc3RyaW5nLFxuICBzdHJ1Y3R1cmVkUXVlc3Rpb25zQXZhaWxhYmxlID0gXCJmYWxzZVwiLFxuKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgY29uc3QgZGlzY3Vzc1RlbXBsYXRlcyA9IGlubGluZVRlbXBsYXRlKFwiY29udGV4dFwiLCBcIkNvbnRleHRcIik7XG4gIGNvbnN0IGNvbnRleHRNb2RlSW5zdHJ1Y3Rpb25zID0gcmVuZGVyQ29udGV4dE1vZGVGb3JQcm9tcHQoXCJkaXNjdXNzLW1pbGVzdG9uZVwiLCBiYXNlKTtcblxuICBjb25zdCBiYXNlUHJvbXB0ID0gbG9hZFByb21wdChcImd1aWRlZC1kaXNjdXNzLW1pbGVzdG9uZVwiLCB7XG4gICAgd29ya2luZ0RpcmVjdG9yeTogYmFzZSxcbiAgICBtaWxlc3RvbmVJZDogbWlkLFxuICAgIG1pbGVzdG9uZVRpdGxlOiBtaWRUaXRsZSxcbiAgICBpbmxpbmVkVGVtcGxhdGVzOiBkaXNjdXNzVGVtcGxhdGVzLFxuICAgIHN0cnVjdHVyZWRRdWVzdGlvbnNBdmFpbGFibGUsXG4gICAgY29tbWl0SW5zdHJ1Y3Rpb246IFwiRG8gbm90IGNvbW1pdCBwbGFubmluZyBhcnRpZmFjdHMgXHUyMDE0IC5nc2QvIGlzIG1hbmFnZWQgZXh0ZXJuYWxseS5cIixcbiAgICBmYXN0UGF0aEluc3RydWN0aW9uOiBcIlwiLFxuICB9KTtcbiAgY29uc3QgcHJvbXB0V2l0aENvbnRleHRNb2RlID0gcHJlcGVuZENvbnRleHRNb2RlVG9CbG9jayhcImRpc2N1c3MtbWlsZXN0b25lXCIsIGJhc2UsIGJhc2VQcm9tcHQpO1xuXG4gIC8vIElmIGEgQ09OVEVYVC1EUkFGVC5tZCBleGlzdHMsIGFwcGVuZCBpdCBhcyBzZWVkIG1hdGVyaWFsXG4gIGNvbnN0IGRyYWZ0UGF0aCA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2UsIG1pZCwgXCJDT05URVhULURSQUZUXCIpO1xuICBjb25zdCBkcmFmdENvbnRlbnQgPSBkcmFmdFBhdGggPyBhd2FpdCBsb2FkRmlsZShkcmFmdFBhdGgpIDogbnVsbDtcblxuICBpZiAoZHJhZnRDb250ZW50KSB7XG4gICAgcmV0dXJuIGAke3Byb21wdFdpdGhDb250ZXh0TW9kZX1cXG5cXG4jIyBQcmlvciBEaXNjdXNzaW9uIChEcmFmdCBTZWVkKVxcblxcblRoZSBmb2xsb3dpbmcgZHJhZnQgd2FzIGNhcHR1cmVkIGZyb20gYSBwcmlvciBtdWx0aS1taWxlc3RvbmUgZGlzY3Vzc2lvbi4gVXNlIGl0IGFzIHNlZWQgbWF0ZXJpYWwgXHUyMDE0IHRoZSB1c2VyIGhhcyBhbHJlYWR5IHByb3ZpZGVkIHRoaXMgY29udGV4dC4gU3RhcnQgd2l0aCBhIGJyaWVmIHJlZmxlY3Rpb24gb24gd2hhdCB0aGUgZHJhZnQgY292ZXJzLCB0aGVuIHByb2JlIGZvciBhbnkgZ2FwcyBvciBvcGVuIHF1ZXN0aW9ucyBiZWZvcmUgd3JpdGluZyB0aGUgZnVsbCBDT05URVhULm1kLlxcblxcbiR7ZHJhZnRDb250ZW50fWA7XG4gIH1cblxuICByZXR1cm4gY29udGV4dE1vZGVJbnN0cnVjdGlvbnMgPyBwcm9tcHRXaXRoQ29udGV4dE1vZGUgOiBiYXNlUHJvbXB0O1xufVxuXG4vKipcbiAqIEJ1aWxkIGEgcHJvbXB0IGZvciB0aGUgd29ya2Zsb3ctcHJlZmVyZW5jZXMgdW5pdCB0eXBlIChkZWVwIG1vZGUpLlxuICogRGVmYXVsdC13cml0aW5nIHN0YWdlOiByZWNvcmRzIGhpZ2gtaW1wYWN0IHdvcmtmbG93IGRlZmF1bHRzIGluXG4gKiAuZ3NkL1BSRUZFUkVOQ0VTLm1kLiBSdW5zIE9OQ0UgcGVyIHByb2plY3QsIGVhcmx5XG4gKiBpbiBkZWVwLW1vZGUgYm9vdHN0cmFwIGJlZm9yZSBkaXNjdXNzLXByb2plY3QuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBidWlsZFdvcmtmbG93UHJlZmVyZW5jZXNQcm9tcHQoXG4gIGJhc2U6IHN0cmluZyxcbiAgc3RydWN0dXJlZFF1ZXN0aW9uc0F2YWlsYWJsZSA9IFwiZmFsc2VcIixcbik6IFByb21pc2U8c3RyaW5nPiB7XG4gIHJldHVybiBwcmVwZW5kQ29udGV4dE1vZGVUb0Jsb2NrKFwid29ya2Zsb3ctcHJlZmVyZW5jZXNcIiwgYmFzZSwgbG9hZFByb21wdChcImd1aWRlZC13b3JrZmxvdy1wcmVmZXJlbmNlc1wiLCB7XG4gICAgd29ya2luZ0RpcmVjdG9yeTogYmFzZSxcbiAgICBzdHJ1Y3R1cmVkUXVlc3Rpb25zQXZhaWxhYmxlLFxuICB9KSk7XG59XG5cbi8qKlxuICogQnVpbGQgYSBwcm9tcHQgZm9yIHRoZSByZXNlYXJjaC1wcm9qZWN0IChwYXJhbGxlbCkgdW5pdCB0eXBlIChkZWVwIG1vZGUpLlxuICogT3JjaGVzdHJhdG9yIHRoYXQgc3Bhd25zIDQgcGFyYWxsZWwgVGFzaygpIGNhbGxzIGNvdmVyaW5nIHN0YWNrLCBmZWF0dXJlcyxcbiAqIGFyY2hpdGVjdHVyZSwgYW5kIHBpdGZhbGxzLiBFYWNoIHN1YmFnZW50IHdyaXRlcyBpdHMgZmluZGluZ3MgdG8gLmdzZC9yZXNlYXJjaC8uXG4gKiBGaXJlcyBhZnRlciByZXNlYXJjaC1kZWNpc2lvbiBtYXJrZXIgc2F5cyBcInJlc2VhcmNoXCIgYW5kIHByb2plY3QgcmVzZWFyY2ggZmlsZXNcbiAqIGFyZSBtaXNzaW5nLiBTa2lwcGVkIGVudGlyZWx5IGlmIHVzZXIgcGlja2VkIFwic2tpcFwiLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gYnVpbGRSZXNlYXJjaFByb2plY3RQcm9tcHQoXG4gIGJhc2U6IHN0cmluZyxcbiAgc3RydWN0dXJlZFF1ZXN0aW9uc0F2YWlsYWJsZSA9IFwiZmFsc2VcIixcbik6IFByb21pc2U8c3RyaW5nPiB7XG4gIHJldHVybiBwcmVwZW5kQ29udGV4dE1vZGVUb0Jsb2NrKFwicmVzZWFyY2gtcHJvamVjdFwiLCBiYXNlLCBsb2FkUHJvbXB0KFwiZ3VpZGVkLXJlc2VhcmNoLXByb2plY3RcIiwge1xuICAgIHdvcmtpbmdEaXJlY3Rvcnk6IGJhc2UsXG4gICAgc3RydWN0dXJlZFF1ZXN0aW9uc0F2YWlsYWJsZSxcbiAgfSkpO1xufVxuXG4vKipcbiAqIEJ1aWxkIGEgcHJvbXB0IGZvciB0aGUgcmVzZWFyY2gtZGVjaXNpb24gdW5pdCB0eXBlIChkZWVwIG1vZGUpLlxuICogRml4ZWQtcXVlc3Rpb24gc3RhZ2U6IGFza3MgXCJyZXNlYXJjaCBmaXJzdCBvciBza2lwP1wiIHZpYSBhc2tfdXNlcl9xdWVzdGlvbnNcbiAqIGFuZCB3cml0ZXMgLmdzZC9ydW50aW1lL3Jlc2VhcmNoLWRlY2lzaW9uLmpzb24uIEZpcmVzIGFmdGVyIGRpc2N1c3MtcmVxdWlyZW1lbnRzXG4gKiBhbmQgYmVmb3JlIHJlc2VhcmNoLXByb2plY3QtcGFyYWxsZWwuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBidWlsZFJlc2VhcmNoRGVjaXNpb25Qcm9tcHQoXG4gIGJhc2U6IHN0cmluZyxcbiAgc3RydWN0dXJlZFF1ZXN0aW9uc0F2YWlsYWJsZSA9IFwiZmFsc2VcIixcbik6IFByb21pc2U8c3RyaW5nPiB7XG4gIHJldHVybiBwcmVwZW5kQ29udGV4dE1vZGVUb0Jsb2NrKFwicmVzZWFyY2gtZGVjaXNpb25cIiwgYmFzZSwgbG9hZFByb21wdChcImd1aWRlZC1yZXNlYXJjaC1kZWNpc2lvblwiLCB7XG4gICAgd29ya2luZ0RpcmVjdG9yeTogYmFzZSxcbiAgICBzdHJ1Y3R1cmVkUXVlc3Rpb25zQXZhaWxhYmxlLFxuICB9KSk7XG59XG5cbi8qKlxuICogQnVpbGQgYSBwcm9tcHQgZm9yIHRoZSBkaXNjdXNzLXByb2plY3QgdW5pdCB0eXBlIChkZWVwIG1vZGUpLlxuICogUHJvamVjdC1sZXZlbCBpbnRlcnZpZXc6IHByb2R1Y2VzIC5nc2QvUFJPSkVDVC5tZC5cbiAqIEZpcmVzIGJlZm9yZSBhbnkgbWlsZXN0b25lLWxldmVsIHdvcmsgd2hlbiBwbGFubmluZ19kZXB0aCA9PT0gXCJkZWVwXCIgYW5kXG4gKiBQUk9KRUNULm1kIGlzIG1pc3NpbmcuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBidWlsZERpc2N1c3NQcm9qZWN0UHJvbXB0KFxuICBiYXNlOiBzdHJpbmcsXG4gIHN0cnVjdHVyZWRRdWVzdGlvbnNBdmFpbGFibGUgPSBcImZhbHNlXCIsXG4pOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCBpbmxpbmVkVGVtcGxhdGVzID0gaW5saW5lVGVtcGxhdGUoXCJwcm9qZWN0XCIsIFwiUHJvamVjdFwiKTtcblxuICByZXR1cm4gcHJlcGVuZENvbnRleHRNb2RlVG9CbG9jayhcImRpc2N1c3MtcHJvamVjdFwiLCBiYXNlLCBsb2FkUHJvbXB0KFwiZ3VpZGVkLWRpc2N1c3MtcHJvamVjdFwiLCB7XG4gICAgd29ya2luZ0RpcmVjdG9yeTogYmFzZSxcbiAgICBpbmxpbmVkVGVtcGxhdGVzLFxuICAgIHN0cnVjdHVyZWRRdWVzdGlvbnNBdmFpbGFibGUsXG4gICAgY29tbWl0SW5zdHJ1Y3Rpb246IFwiRG8gbm90IGNvbW1pdCBwbGFubmluZyBhcnRpZmFjdHMgXHUyMDE0IC5nc2QvIGlzIG1hbmFnZWQgZXh0ZXJuYWxseS5cIixcbiAgfSkpO1xufVxuXG4vKipcbiAqIEJ1aWxkIGEgcHJvbXB0IGZvciB0aGUgZGlzY3Vzcy1yZXF1aXJlbWVudHMgdW5pdCB0eXBlIChkZWVwIG1vZGUpLlxuICogUmVxdWlyZW1lbnRzLWxldmVsIGludGVydmlldzogcHJvZHVjZXMgLmdzZC9SRVFVSVJFTUVOVFMubWQgdXNpbmcgdGhlXG4gKiBzdHJ1Y3R1cmVkIFIjIyMgZm9ybWF0LiBSZWFkcyBQUk9KRUNULm1kIGFzIGF1dGhvcml0YXRpdmUgY29udGV4dC5cbiAqIEZpcmVzIHdoZW4gcGxhbm5pbmdfZGVwdGggPT09IFwiZGVlcFwiLCBQUk9KRUNULm1kIGV4aXN0cywgYW5kIFJFUVVJUkVNRU5UUy5tZCBpcyBtaXNzaW5nLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gYnVpbGREaXNjdXNzUmVxdWlyZW1lbnRzUHJvbXB0KFxuICBiYXNlOiBzdHJpbmcsXG4gIHN0cnVjdHVyZWRRdWVzdGlvbnNBdmFpbGFibGUgPSBcImZhbHNlXCIsXG4pOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCBpbmxpbmVkVGVtcGxhdGVzID0gaW5saW5lVGVtcGxhdGUoXCJyZXF1aXJlbWVudHNcIiwgXCJSZXF1aXJlbWVudHNcIik7XG5cbiAgcmV0dXJuIHByZXBlbmRDb250ZXh0TW9kZVRvQmxvY2soXCJkaXNjdXNzLXJlcXVpcmVtZW50c1wiLCBiYXNlLCBsb2FkUHJvbXB0KFwiZ3VpZGVkLWRpc2N1c3MtcmVxdWlyZW1lbnRzXCIsIHtcbiAgICB3b3JraW5nRGlyZWN0b3J5OiBiYXNlLFxuICAgIGlubGluZWRUZW1wbGF0ZXMsXG4gICAgc3RydWN0dXJlZFF1ZXN0aW9uc0F2YWlsYWJsZSxcbiAgICBjb21taXRJbnN0cnVjdGlvbjogXCJEbyBub3QgY29tbWl0IHBsYW5uaW5nIGFydGlmYWN0cyBcdTIwMTQgLmdzZC8gaXMgbWFuYWdlZCBleHRlcm5hbGx5LlwiLFxuICB9KSk7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBidWlsZFJlc2VhcmNoTWlsZXN0b25lUHJvbXB0KG1pZDogc3RyaW5nLCBtaWRUaXRsZTogc3RyaW5nLCBiYXNlOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZz4ge1xuICAvLyAjNDc4MiBwaGFzZSAzOiByZXNlYXJjaC1taWxlc3RvbmUgbWlncmF0ZWQgdGhyb3VnaCB0aGUgY29tcG9zZXIuXG4gIC8vIERlY2xhcmVkIGlubGluZSBvcmRlcjogbWlsZXN0b25lLWNvbnRleHQsIHByb2plY3QsIHJlcXVpcmVtZW50cyxcbiAgLy8gZGVjaXNpb25zLCB0ZW1wbGF0ZXMuIEtub3dsZWRnZSBzdGF5cyBvdXRzaWRlIHRoZSBjb21wb3NlclxuICAvLyAoYnVkZ2V0LWRyaXZlbiwgc2NvcGVkIGJ5IGtleXdvcmQgZXh0cmFjdGlvbiBcdTIwMTQgZnV0dXJlIHBoYXNlIGZvbGRzXG4gIC8vIHBvbGljeS1kcml2ZW4gYmxvY2tzIGluKS5cbiAgY29uc3QgcmVzb2x2ZUFydGlmYWN0OiBBcnRpZmFjdFJlc29sdmVyID0gYXN5bmMgKGtleSkgPT4ge1xuICAgIHN3aXRjaCAoa2V5KSB7XG4gICAgICBjYXNlIFwibWlsZXN0b25lLWNvbnRleHRcIjoge1xuICAgICAgICBjb25zdCBwID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZSwgbWlkLCBcIkNPTlRFWFRcIik7XG4gICAgICAgIGNvbnN0IHIgPSByZWxNaWxlc3RvbmVGaWxlKGJhc2UsIG1pZCwgXCJDT05URVhUXCIpO1xuICAgICAgICByZXR1cm4gYXdhaXQgaW5saW5lRmlsZShwLCByLCBcIk1pbGVzdG9uZSBDb250ZXh0XCIpO1xuICAgICAgfVxuICAgICAgY2FzZSBcInByb2plY3RcIjpcbiAgICAgICAgcmV0dXJuIGF3YWl0IGlubGluZVByb2plY3RGcm9tRGIoYmFzZSk7XG4gICAgICBjYXNlIFwicmVxdWlyZW1lbnRzXCI6XG4gICAgICAgIHJldHVybiBhd2FpdCBpbmxpbmVSZXF1aXJlbWVudHNGcm9tRGIoYmFzZSwgbWlkKTtcbiAgICAgIGNhc2UgXCJkZWNpc2lvbnNcIjpcbiAgICAgICAgcmV0dXJuIGF3YWl0IGlubGluZURlY2lzaW9uc0Zyb21EYihiYXNlLCBtaWQpO1xuICAgICAgY2FzZSBcInRlbXBsYXRlc1wiOlxuICAgICAgICByZXR1cm4gaW5saW5lVGVtcGxhdGUoXCJyZXNlYXJjaFwiLCBcIlJlc2VhcmNoXCIpO1xuICAgICAgZGVmYXVsdDpcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IGNvbXBvc2VkID0gYXdhaXQgY29tcG9zZUlubGluZWRDb250ZXh0KFwicmVzZWFyY2gtbWlsZXN0b25lXCIsIHJlc29sdmVBcnRpZmFjdCk7XG5cbiAgLy8gS25vd2xlZGdlIGJsb2NrIHN0YXlzIG91dHNpZGUgdGhlIGNvbXBvc2VyIFx1MjAxNCBidWRnZXRlZCwgc2NvcGVkIHZpYVxuICAvLyBrZXl3b3JkIGV4dHJhY3Rpb24gKCM0NzE5KS4gSW5zZXJ0ZWQgYmV0d2VlbiBkZWNpc2lvbnMgYW5kIHRoZVxuICAvLyB0ZW1wbGF0ZXMgYmxvY2sgdG8gbWF0Y2ggdGhlIHByZS1taWdyYXRpb24gb3V0cHV0IG9yZGVyLiBXZSBzcGxpdFxuICAvLyB0aGUgY29tcG9zZXIgb3V0cHV0IGFyb3VuZCB0aGUgdGVtcGxhdGVzIHNlY3Rpb24gdG8gcHJlc2VydmUgdGhhdFxuICAvLyBvcmRlcmluZy5cbiAgY29uc3Qga25vd2xlZGdlSW5saW5lUk0gPSBhd2FpdCBpbmxpbmVLbm93bGVkZ2VCdWRnZXRlZChiYXNlLCBleHRyYWN0S2V5d29yZHMobWlkVGl0bGUpKTtcbiAgY29uc3QgcGFydHM6IHN0cmluZ1tdID0gW107XG4gIGlmIChrbm93bGVkZ2VJbmxpbmVSTSAmJiBjb21wb3NlZCkge1xuICAgIC8vIEluc2VydCBrbm93bGVkZ2UgYmVmb3JlIHRoZSB0ZW1wbGF0ZSBibG9jayBzbyB0aGUgb3ZlcmFsbCBvcmRlciBpczpcbiAgICAvLyAgIG1pbGVzdG9uZS1jb250ZXh0IFx1MjE5MiBwcm9qZWN0IFx1MjE5MiByZXF1aXJlbWVudHMgXHUyMTkyIGRlY2lzaW9ucyBcdTIxOTIgS05PV0xFREdFIFx1MjE5MiByZXNlYXJjaCB0ZW1wbGF0ZVxuICAgIGNvbnN0IGlkeCA9IGNvbXBvc2VkLmxhc3RJbmRleE9mKFwiIyMjIE91dHB1dCBUZW1wbGF0ZTpcIik7XG4gICAgaWYgKGlkeCA+IDApIHtcbiAgICAgIGNvbnN0IGJlZm9yZSA9IGNvbXBvc2VkLnNsaWNlKDAsIGlkeCkucmVwbGFjZSgvXFxuXFxuLS0tXFxuXFxuJC8sIFwiXCIpO1xuICAgICAgY29uc3QgYWZ0ZXIgPSBjb21wb3NlZC5zbGljZShpZHgpO1xuICAgICAgcGFydHMucHVzaChiZWZvcmUsIGtub3dsZWRnZUlubGluZVJNLCBhZnRlcik7XG4gICAgfSBlbHNlIHtcbiAgICAgIHBhcnRzLnB1c2goY29tcG9zZWQsIGtub3dsZWRnZUlubGluZVJNKTtcbiAgICB9XG4gIH0gZWxzZSBpZiAoY29tcG9zZWQpIHtcbiAgICBwYXJ0cy5wdXNoKGNvbXBvc2VkKTtcbiAgICBpZiAoa25vd2xlZGdlSW5saW5lUk0pIHBhcnRzLnB1c2goa25vd2xlZGdlSW5saW5lUk0pO1xuICB9XG5cbiAgY29uc3QgaW5saW5lZENvbnRleHQgPSBwcmVwZW5kQ29udGV4dE1vZGVUb0Jsb2NrKFxuICAgIFwicmVzZWFyY2gtbWlsZXN0b25lXCIsXG4gICAgYmFzZSxcbiAgICBjYXBQcmVhbWJsZShgIyMgSW5saW5lZCBDb250ZXh0IChwcmVsb2FkZWQgXHUyMDE0IGRvIG5vdCByZS1yZWFkIHRoZXNlIGZpbGVzKVxcblxcbiR7cGFydHMuam9pbihcIlxcblxcbi0tLVxcblxcblwiKX1gKSxcbiAgKTtcblxuICBjb25zdCBvdXRwdXRSZWxQYXRoID0gcmVsTWlsZXN0b25lRmlsZShiYXNlLCBtaWQsIFwiUkVTRUFSQ0hcIik7XG4gIHJldHVybiBsb2FkUHJvbXB0KFwicmVzZWFyY2gtbWlsZXN0b25lXCIsIHtcbiAgICB3b3JraW5nRGlyZWN0b3J5OiBiYXNlLFxuICAgIG1pbGVzdG9uZUlkOiBtaWQsIG1pbGVzdG9uZVRpdGxlOiBtaWRUaXRsZSxcbiAgICBtaWxlc3RvbmVQYXRoOiByZWxNaWxlc3RvbmVQYXRoKGJhc2UsIG1pZCksXG4gICAgY29udGV4dFBhdGg6IHJlbE1pbGVzdG9uZUZpbGUoYmFzZSwgbWlkLCBcIkNPTlRFWFRcIiksXG4gICAgb3V0cHV0UGF0aDogam9pbihiYXNlLCBvdXRwdXRSZWxQYXRoKSxcbiAgICBpbmxpbmVkQ29udGV4dCxcbiAgICBza2lsbEFjdGl2YXRpb246IGJ1aWxkU2tpbGxBY3RpdmF0aW9uQmxvY2soe1xuICAgICAgYmFzZSxcbiAgICAgIG1pbGVzdG9uZUlkOiBtaWQsXG4gICAgICBtaWxlc3RvbmVUaXRsZTogbWlkVGl0bGUsXG4gICAgICBleHRyYUNvbnRleHQ6IFtpbmxpbmVkQ29udGV4dF0sXG4gICAgICB1bml0VHlwZTogXCJyZXNlYXJjaC1taWxlc3RvbmVcIixcbiAgICB9KSxcbiAgICAuLi5idWlsZFNraWxsRGlzY292ZXJ5VmFycygpLFxuICB9KTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGJ1aWxkUGxhbk1pbGVzdG9uZVByb21wdChtaWQ6IHN0cmluZywgbWlkVGl0bGU6IHN0cmluZywgYmFzZTogc3RyaW5nLCBsZXZlbD86IElubGluZUxldmVsKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgY29uc3QgaW5saW5lTGV2ZWwgPSBsZXZlbCA/PyByZXNvbHZlSW5saW5lTGV2ZWwoKTtcbiAgY29uc3QgY29udGV4dFBhdGggPSByZXNvbHZlTWlsZXN0b25lRmlsZShiYXNlLCBtaWQsIFwiQ09OVEVYVFwiKTtcbiAgY29uc3QgY29udGV4dFJlbCA9IHJlbE1pbGVzdG9uZUZpbGUoYmFzZSwgbWlkLCBcIkNPTlRFWFRcIik7XG4gIGNvbnN0IHJlc2VhcmNoUGF0aCA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2UsIG1pZCwgXCJSRVNFQVJDSFwiKTtcbiAgY29uc3QgcmVzZWFyY2hSZWwgPSByZWxNaWxlc3RvbmVGaWxlKGJhc2UsIG1pZCwgXCJSRVNFQVJDSFwiKTtcblxuICBjb25zdCBpbmxpbmVkOiBzdHJpbmdbXSA9IFtdO1xuXG4gIC8vIEluamVjdCBwaGFzZSBoYW5kb2ZmIGFuY2hvciBmcm9tIHJlc2VhcmNoIHBoYXNlIChpZiBhdmFpbGFibGUpXG4gIGNvbnN0IHJlc2VhcmNoQW5jaG9yID0gcmVhZFBoYXNlQW5jaG9yKGJhc2UsIG1pZCwgXCJyZXNlYXJjaC1taWxlc3RvbmVcIik7XG4gIGlmIChyZXNlYXJjaEFuY2hvcikgaW5saW5lZC5wdXNoKGZvcm1hdEFuY2hvckZvclByb21wdChyZXNlYXJjaEFuY2hvcikpO1xuXG4gIGlubGluZWQucHVzaChmb3JtYXRQcm9qZWN0Q2xhc3NpZmljYXRpb25Gb3JQbGFubmluZyhjbGFzc2lmeVByb2plY3QoYmFzZSkpKTtcblxuICBpbmxpbmVkLnB1c2goYXdhaXQgaW5saW5lRmlsZShjb250ZXh0UGF0aCwgY29udGV4dFJlbCwgXCJNaWxlc3RvbmUgQ29udGV4dFwiKSk7XG4gIGNvbnN0IHJlc2VhcmNoSW5saW5lID0gYXdhaXQgaW5saW5lRmlsZU9wdGlvbmFsKHJlc2VhcmNoUGF0aCwgcmVzZWFyY2hSZWwsIFwiTWlsZXN0b25lIFJlc2VhcmNoXCIpO1xuICBpZiAocmVzZWFyY2hJbmxpbmUpIGlubGluZWQucHVzaChyZXNlYXJjaElubGluZSk7XG4gIGNvbnN0IHsgaW5saW5lUHJpb3JNaWxlc3RvbmVTdW1tYXJ5IH0gPSBhd2FpdCBpbXBvcnQoXCIuL2ZpbGVzLmpzXCIpO1xuICBjb25zdCBwcmlvclN1bW1hcnlJbmxpbmUgPSBhd2FpdCBpbmxpbmVQcmlvck1pbGVzdG9uZVN1bW1hcnkobWlkLCBiYXNlKTtcbiAgaWYgKHByaW9yU3VtbWFyeUlubGluZSkgaW5saW5lZC5wdXNoKHByaW9yU3VtbWFyeUlubGluZSk7XG4gIGlmIChpbmxpbmVMZXZlbCAhPT0gXCJtaW5pbWFsXCIpIHtcbiAgICBjb25zdCBwcm9qZWN0SW5saW5lID0gYXdhaXQgaW5saW5lUHJvamVjdEZyb21EYihiYXNlKTtcbiAgICBpZiAocHJvamVjdElubGluZSkgaW5saW5lZC5wdXNoKHByb2plY3RJbmxpbmUpO1xuICAgIGNvbnN0IHJlcXVpcmVtZW50c0lubGluZSA9IGF3YWl0IGlubGluZVJlcXVpcmVtZW50c0Zyb21EYihiYXNlLCBtaWQsIHVuZGVmaW5lZCwgaW5saW5lTGV2ZWwpO1xuICAgIGlmIChyZXF1aXJlbWVudHNJbmxpbmUpIGlubGluZWQucHVzaChyZXF1aXJlbWVudHNJbmxpbmUpO1xuICAgIGNvbnN0IGRlY2lzaW9uc0lubGluZSA9IGF3YWl0IGlubGluZURlY2lzaW9uc0Zyb21EYihiYXNlLCBtaWQsIHVuZGVmaW5lZCwgaW5saW5lTGV2ZWwpO1xuICAgIGlmIChkZWNpc2lvbnNJbmxpbmUpIGlubGluZWQucHVzaChkZWNpc2lvbnNJbmxpbmUpO1xuICB9XG4gIGNvbnN0IHF1ZXVlUGF0aCA9IHJlc29sdmVHc2RSb290RmlsZShiYXNlLCBcIlFVRVVFXCIpO1xuICBpZiAoZXhpc3RzU3luYyhxdWV1ZVBhdGgpKSB7XG4gICAgY29uc3QgcXVldWVJbmxpbmUgPSBhd2FpdCBpbmxpbmVGaWxlU21hcnQoXG4gICAgICBxdWV1ZVBhdGgsXG4gICAgICByZWxHc2RSb290RmlsZShcIlFVRVVFXCIpLFxuICAgICAgXCJQcm9qZWN0IFF1ZXVlXCIsXG4gICAgICBgJHttaWR9ICR7bWlkVGl0bGV9YCxcbiAgICApO1xuICAgIGlubGluZWQucHVzaChxdWV1ZUlubGluZSk7XG4gIH1cbiAgLy8gU2NvcGVkICsgYnVkZ2V0ZWQgXHUyMDE0IHNlZSBpc3N1ZSAjNDcxOVxuICBjb25zdCBrbm93bGVkZ2VJbmxpbmVQTSA9IGF3YWl0IGlubGluZUtub3dsZWRnZUJ1ZGdldGVkKGJhc2UsIGV4dHJhY3RLZXl3b3JkcyhtaWRUaXRsZSkpO1xuICBpZiAoa25vd2xlZGdlSW5saW5lUE0pIGlubGluZWQucHVzaChrbm93bGVkZ2VJbmxpbmVQTSk7XG4gIGlubGluZWQucHVzaChpbmxpbmVUZW1wbGF0ZShcInJvYWRtYXBcIiwgXCJSb2FkbWFwXCIpKTtcbiAgaWYgKGlubGluZUxldmVsID09PSBcImZ1bGxcIikge1xuICAgIGlubGluZWQucHVzaChpbmxpbmVUZW1wbGF0ZShcImRlY2lzaW9uc1wiLCBcIkRlY2lzaW9uc1wiKSk7XG4gICAgaW5saW5lZC5wdXNoKGlubGluZVRlbXBsYXRlKFwicGxhblwiLCBcIlNsaWNlIFBsYW5cIikpO1xuICAgIGlubGluZWQucHVzaChpbmxpbmVUZW1wbGF0ZShcInRhc2stcGxhblwiLCBcIlRhc2sgUGxhblwiKSk7XG4gICAgaW5saW5lZC5wdXNoKGlubGluZVRlbXBsYXRlKFwic2VjcmV0cy1tYW5pZmVzdFwiLCBcIlNlY3JldHMgTWFuaWZlc3RcIikpO1xuICB9IGVsc2UgaWYgKGlubGluZUxldmVsID09PSBcInN0YW5kYXJkXCIpIHtcbiAgICBpbmxpbmVkLnB1c2goaW5saW5lVGVtcGxhdGUoXCJkZWNpc2lvbnNcIiwgXCJEZWNpc2lvbnNcIikpO1xuICAgIGlubGluZWQucHVzaChpbmxpbmVUZW1wbGF0ZShcInBsYW5cIiwgXCJTbGljZSBQbGFuXCIpKTtcbiAgICBpbmxpbmVkLnB1c2goaW5saW5lVGVtcGxhdGUoXCJ0YXNrLXBsYW5cIiwgXCJUYXNrIFBsYW5cIikpO1xuICB9XG5cbiAgY29uc3QgaW5saW5lZENvbnRleHQgPSBwcmVwZW5kQ29udGV4dE1vZGVUb0Jsb2NrKFxuICAgIFwicGxhbi1taWxlc3RvbmVcIixcbiAgICBiYXNlLFxuICAgIGNhcFByZWFtYmxlKGAjIyBJbmxpbmVkIENvbnRleHQgKHByZWxvYWRlZCBcdTIwMTQgZG8gbm90IHJlLXJlYWQgdGhlc2UgZmlsZXMpXFxuXFxuJHtpbmxpbmVkLmpvaW4oXCJcXG5cXG4tLS1cXG5cXG5cIil9YCksXG4gICk7XG5cbiAgY29uc3Qgb3V0cHV0UmVsUGF0aCA9IHJlbE1pbGVzdG9uZUZpbGUoYmFzZSwgbWlkLCBcIlJPQURNQVBcIik7XG4gIGNvbnN0IHJlc2VhcmNoT3V0cHV0UGF0aCA9IGpvaW4oYmFzZSwgcmVsTWlsZXN0b25lRmlsZShiYXNlLCBtaWQsIFwiUkVTRUFSQ0hcIikpO1xuICBjb25zdCBzZWNyZXRzT3V0cHV0UGF0aCA9IGpvaW4oYmFzZSwgcmVsTWlsZXN0b25lRmlsZShiYXNlLCBtaWQsIFwiU0VDUkVUU1wiKSk7XG4gIHJldHVybiBsb2FkUHJvbXB0KFwicGxhbi1taWxlc3RvbmVcIiwge1xuICAgIHdvcmtpbmdEaXJlY3Rvcnk6IGJhc2UsXG4gICAgbWlsZXN0b25lSWQ6IG1pZCwgbWlsZXN0b25lVGl0bGU6IG1pZFRpdGxlLFxuICAgIG1pbGVzdG9uZVBhdGg6IHJlbE1pbGVzdG9uZVBhdGgoYmFzZSwgbWlkKSxcbiAgICBjb250ZXh0UGF0aDogY29udGV4dFJlbCxcbiAgICByZXNlYXJjaFBhdGg6IHJlc2VhcmNoUmVsLFxuICAgIHJlc2VhcmNoT3V0cHV0UGF0aCxcbiAgICBvdXRwdXRQYXRoOiBqb2luKGJhc2UsIG91dHB1dFJlbFBhdGgpLFxuICAgIHNlY3JldHNPdXRwdXRQYXRoLFxuICAgIGlubGluZWRDb250ZXh0LFxuICAgIHNvdXJjZUZpbGVQYXRoczogYnVpbGRTb3VyY2VGaWxlUGF0aHMoYmFzZSwgbWlkKSxcbiAgICBza2lsbEFjdGl2YXRpb246IGJ1aWxkU2tpbGxBY3RpdmF0aW9uQmxvY2soe1xuICAgICAgYmFzZSxcbiAgICAgIG1pbGVzdG9uZUlkOiBtaWQsXG4gICAgICBtaWxlc3RvbmVUaXRsZTogbWlkVGl0bGUsXG4gICAgICBleHRyYUNvbnRleHQ6IFtpbmxpbmVkQ29udGV4dF0sXG4gICAgICB1bml0VHlwZTogXCJwbGFuLW1pbGVzdG9uZVwiLFxuICAgIH0pLFxuICAgIC4uLmJ1aWxkU2tpbGxEaXNjb3ZlcnlWYXJzKCksXG4gIH0pO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gYnVpbGRSZXNlYXJjaFNsaWNlUHJvbXB0KFxuICBtaWQ6IHN0cmluZywgX21pZFRpdGxlOiBzdHJpbmcsIHNpZDogc3RyaW5nLCBzVGl0bGU6IHN0cmluZywgYmFzZTogc3RyaW5nLFxuICBvcHRpb25zPzogeyBjb250ZXh0TW9kZVJlbmRlck1vZGU/OiBDb250ZXh0TW9kZVJlbmRlck1vZGUgfSxcbik6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IHJvYWRtYXBQYXRoID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZSwgbWlkLCBcIlJPQURNQVBcIik7XG4gIGNvbnN0IHJvYWRtYXBSZWwgPSByZWxNaWxlc3RvbmVGaWxlKGJhc2UsIG1pZCwgXCJST0FETUFQXCIpO1xuICBjb25zdCBjb250ZXh0UGF0aCA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2UsIG1pZCwgXCJDT05URVhUXCIpO1xuICBjb25zdCBjb250ZXh0UmVsID0gcmVsTWlsZXN0b25lRmlsZShiYXNlLCBtaWQsIFwiQ09OVEVYVFwiKTtcbiAgY29uc3QgbWlsZXN0b25lUmVzZWFyY2hQYXRoID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZSwgbWlkLCBcIlJFU0VBUkNIXCIpO1xuICBjb25zdCBtaWxlc3RvbmVSZXNlYXJjaFJlbCA9IHJlbE1pbGVzdG9uZUZpbGUoYmFzZSwgbWlkLCBcIlJFU0VBUkNIXCIpO1xuXG4gIGNvbnN0IHNsaWNlQ29udGV4dFBhdGggPSByZXNvbHZlU2xpY2VGaWxlKGJhc2UsIG1pZCwgc2lkLCBcIkNPTlRFWFRcIik7XG4gIGNvbnN0IHNsaWNlQ29udGV4dFJlbCA9IHJlbFNsaWNlRmlsZShiYXNlLCBtaWQsIHNpZCwgXCJDT05URVhUXCIpO1xuXG4gIGNvbnN0IGlubGluZWQ6IHN0cmluZ1tdID0gW107XG5cbiAgLy8gVXNlIHJvYWRtYXAgZXhjZXJwdCBpbnN0ZWFkIG9mIGZ1bGwgcm9hZG1hcCBmb3IgY29udGV4dCByZWR1Y3Rpb25cbiAgY29uc3Qgcm9hZG1hcEV4Y2VycHRSUyA9IGF3YWl0IGlubGluZVJvYWRtYXBFeGNlcnB0KGJhc2UsIG1pZCwgc2lkKTtcbiAgaWYgKHJvYWRtYXBFeGNlcnB0UlMpIHtcbiAgICBpbmxpbmVkLnB1c2gocm9hZG1hcEV4Y2VycHRSUyk7XG4gIH0gZWxzZSB7XG4gICAgLy8gRmFsbCBiYWNrIHRvIGZ1bGwgcm9hZG1hcCBpZiBleGNlcnB0IGZhaWxzXG4gICAgaW5saW5lZC5wdXNoKGF3YWl0IGlubGluZUZpbGUocm9hZG1hcFBhdGgsIHJvYWRtYXBSZWwsIFwiTWlsZXN0b25lIFJvYWRtYXBcIikpO1xuICB9XG5cbiAgY29uc3QgY29udGV4dElubGluZSA9IGF3YWl0IGlubGluZUZpbGVPcHRpb25hbChjb250ZXh0UGF0aCwgY29udGV4dFJlbCwgXCJNaWxlc3RvbmUgQ29udGV4dFwiKTtcbiAgaWYgKGNvbnRleHRJbmxpbmUpIGlubGluZWQucHVzaChjb250ZXh0SW5saW5lKTtcbiAgY29uc3Qgc2xpY2VDdHhJbmxpbmUgPSBhd2FpdCBpbmxpbmVGaWxlT3B0aW9uYWwoc2xpY2VDb250ZXh0UGF0aCwgc2xpY2VDb250ZXh0UmVsLCBcIlNsaWNlIENvbnRleHQgKGZyb20gZGlzY3Vzc2lvbilcIik7XG4gIGlmIChzbGljZUN0eElubGluZSkgaW5saW5lZC5wdXNoKHNsaWNlQ3R4SW5saW5lKTtcbiAgY29uc3QgcmVzZWFyY2hJbmxpbmUgPSBhd2FpdCBpbmxpbmVGaWxlT3B0aW9uYWwobWlsZXN0b25lUmVzZWFyY2hQYXRoLCBtaWxlc3RvbmVSZXNlYXJjaFJlbCwgXCJNaWxlc3RvbmUgUmVzZWFyY2hcIik7XG4gIGlmIChyZXNlYXJjaElubGluZSkgaW5saW5lZC5wdXNoKHJlc2VhcmNoSW5saW5lKTtcblxuICAvLyBEZXJpdmUgc2NvcGUgZnJvbSBzbGljZSB0aXRsZSBmb3IgZGVjaXNpb24gZmlsdGVyaW5nIChSMDA1KVxuICBjb25zdCBkZXJpdmVkU2NvcGUgPSBkZXJpdmVTbGljZVNjb3BlKHNUaXRsZSk7XG4gIGNvbnN0IGRlY2lzaW9uc0lubGluZSA9IGF3YWl0IGlubGluZURlY2lzaW9uc0Zyb21EYihiYXNlLCBtaWQsIGRlcml2ZWRTY29wZSk7XG4gIGlmIChkZWNpc2lvbnNJbmxpbmUpIGlubGluZWQucHVzaChkZWNpc2lvbnNJbmxpbmUpO1xuICBjb25zdCByZXF1aXJlbWVudHNJbmxpbmUgPSBhd2FpdCBpbmxpbmVSZXF1aXJlbWVudHNGcm9tRGIoYmFzZSwgbWlkLCBzaWQpO1xuICBpZiAocmVxdWlyZW1lbnRzSW5saW5lKSBpbmxpbmVkLnB1c2gocmVxdWlyZW1lbnRzSW5saW5lKTtcblxuICAvLyBVc2Ugc2NvcGVkIGtub3dsZWRnZSBiYXNlZCBvbiBzbGljZSB0aXRsZSBrZXl3b3Jkc1xuICBjb25zdCBrZXl3b3JkcyA9IGV4dHJhY3RLZXl3b3JkcyhzVGl0bGUpO1xuICBjb25zdCBrbm93bGVkZ2VJbmxpbmVSUyA9IGF3YWl0IGlubGluZUtub3dsZWRnZVNjb3BlZChiYXNlLCBrZXl3b3Jkcyk7XG4gIGlmIChrbm93bGVkZ2VJbmxpbmVSUykgaW5saW5lZC5wdXNoKGtub3dsZWRnZUlubGluZVJTKTtcblxuICAvLyBLbm93bGVkZ2UgZ3JhcGg6IHN1YmdyYXBoIGZvciB0aGlzIHNsaWNlIChncmFjZWZ1bCBcdTIwMTQgc2tpcHBlZCBpZiBubyBncmFwaC5qc29uKVxuICBjb25zdCBncmFwaEJsb2NrUlMgPSBhd2FpdCBpbmxpbmVHcmFwaFN1YmdyYXBoKGJhc2UsIGAke3NpZH0gJHtzVGl0bGV9YCwgeyBidWRnZXQ6IDMwMDAgfSk7XG4gIGlmIChncmFwaEJsb2NrUlMpIGlubGluZWQucHVzaChncmFwaEJsb2NrUlMpO1xuXG4gIGlubGluZWQucHVzaChpbmxpbmVUZW1wbGF0ZShcInJlc2VhcmNoXCIsIFwiUmVzZWFyY2hcIikpO1xuXG4gIGNvbnN0IGRlcENvbnRlbnQgPSBhd2FpdCBpbmxpbmVEZXBlbmRlbmN5U3VtbWFyaWVzKG1pZCwgc2lkLCBiYXNlLCByZXNvbHZlU3VtbWFyeUJ1ZGdldENoYXJzKCkpO1xuICBjb25zdCBhY3RpdmVPdmVycmlkZXMgPSBhd2FpdCBsb2FkQWN0aXZlT3ZlcnJpZGVzKGJhc2UpO1xuICBjb25zdCBvdmVycmlkZXNJbmxpbmUgPSBmb3JtYXRPdmVycmlkZXNTZWN0aW9uKGFjdGl2ZU92ZXJyaWRlcyk7XG4gIGlmIChvdmVycmlkZXNJbmxpbmUpIGlubGluZWQudW5zaGlmdChvdmVycmlkZXNJbmxpbmUpO1xuXG4gIGNvbnN0IGlubGluZWRDb250ZXh0ID0gcHJlcGVuZENvbnRleHRNb2RlVG9CbG9jayhcbiAgICBcInJlc2VhcmNoLXNsaWNlXCIsXG4gICAgYmFzZSxcbiAgICBjYXBQcmVhbWJsZShgIyMgSW5saW5lZCBDb250ZXh0IChwcmVsb2FkZWQgXHUyMDE0IGRvIG5vdCByZS1yZWFkIHRoZXNlIGZpbGVzKVxcblxcbiR7aW5saW5lZC5qb2luKFwiXFxuXFxuLS0tXFxuXFxuXCIpfWApLFxuICAgIG9wdGlvbnM/LmNvbnRleHRNb2RlUmVuZGVyTW9kZSxcbiAgKTtcblxuICBjb25zdCBvdXRwdXRSZWxQYXRoID0gcmVsU2xpY2VGaWxlKGJhc2UsIG1pZCwgc2lkLCBcIlJFU0VBUkNIXCIpO1xuICByZXR1cm4gbG9hZFByb21wdChcInJlc2VhcmNoLXNsaWNlXCIsIHtcbiAgICB3b3JraW5nRGlyZWN0b3J5OiBiYXNlLFxuICAgIG1pbGVzdG9uZUlkOiBtaWQsIHNsaWNlSWQ6IHNpZCwgc2xpY2VUaXRsZTogc1RpdGxlLFxuICAgIHNsaWNlUGF0aDogcmVsU2xpY2VQYXRoKGJhc2UsIG1pZCwgc2lkKSxcbiAgICByb2FkbWFwUGF0aDogcm9hZG1hcFJlbCxcbiAgICBjb250ZXh0UGF0aDogY29udGV4dFJlbCxcbiAgICBtaWxlc3RvbmVSZXNlYXJjaFBhdGg6IG1pbGVzdG9uZVJlc2VhcmNoUmVsLFxuICAgIG91dHB1dFBhdGg6IGpvaW4oYmFzZSwgb3V0cHV0UmVsUGF0aCksXG4gICAgaW5saW5lZENvbnRleHQsXG4gICAgZGVwZW5kZW5jeVN1bW1hcmllczogZGVwQ29udGVudCxcbiAgICBza2lsbEFjdGl2YXRpb246IGJ1aWxkU2tpbGxBY3RpdmF0aW9uQmxvY2soe1xuICAgICAgYmFzZSxcbiAgICAgIG1pbGVzdG9uZUlkOiBtaWQsXG4gICAgICBzbGljZUlkOiBzaWQsXG4gICAgICBzbGljZVRpdGxlOiBzVGl0bGUsXG4gICAgICBleHRyYUNvbnRleHQ6IFtpbmxpbmVkQ29udGV4dCwgZGVwQ29udGVudF0sXG4gICAgICB1bml0VHlwZTogXCJyZXNlYXJjaC1zbGljZVwiLFxuICAgIH0pLFxuICAgIC4uLmJ1aWxkU2tpbGxEaXNjb3ZlcnlWYXJzKCksXG4gIH0pO1xufVxuXG4vKipcbiAqIFNoYXJlZCBhc3NlbWJseSBmb3IgcGxhbi1zbGljZSBhbmQgcmVmaW5lLXNsaWNlIHByb21wdHMuIEJvdGggYnVpbGRlcnMgbmVlZFxuICogdGhlIHNhbWUgaW5saW5lZCBjb250ZXh0IChyb2FkbWFwIGV4Y2VycHQsIHNsaWNlIGNvbnRleHQsIHJlc2VhcmNoLCBkZWNpc2lvbnMsXG4gKiByZXF1aXJlbWVudHMsIGtub3dsZWRnZSwgZ3JhcGggc3ViZ3JhcGgsIHRlbXBsYXRlcywgZGVwZW5kZW5jeSBzdW1tYXJpZXMsXG4gKiBvdmVycmlkZXMpLiBFeHRyYWN0ZWQgdG8gcHJldmVudCBkcmlmdCBiZXR3ZWVuIHRoZSB0d28gc2l0ZXMuXG4gKlxuICogYHByZXBlbmRCbG9ja3NgIGFyZSBwdXNoZWQgb250byB0aGUgc3RhcnQgb2YgdGhlIGlubGluZWQgYXJyYXkgQkVGT1JFIGFueVxuICogc2hhcmVkIGNvbnRlbnQsIHNvIGNhbGxlcnMgY2FuIGFkZCB1bml0LXNwZWNpZmljIGhlYWRlcnMgKGUuZy4sIHRoZSByZWZpbmVcbiAqIHNrZXRjaC1zY29wZSBjb25zdHJhaW50KS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gcmVuZGVyU2xpY2VQcm9tcHQob3B0aW9uczoge1xuICBtaWQ6IHN0cmluZztcbiAgc2lkOiBzdHJpbmc7XG4gIHNUaXRsZTogc3RyaW5nO1xuICBiYXNlOiBzdHJpbmc7XG4gIGxldmVsOiBJbmxpbmVMZXZlbDtcbiAgcHJvbXB0VGVtcGxhdGU6IFwicGxhbi1zbGljZVwiIHwgXCJyZWZpbmUtc2xpY2VcIjtcbiAgcHJlcGVuZEJsb2Nrcz86IHN0cmluZ1tdO1xuICBleHRyYVZhcnM/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuICBzZXNzaW9uQ29udGV4dFdpbmRvdz86IG51bWJlcjtcbiAgbW9kZWxSZWdpc3RyeT86IE1pbmltYWxNb2RlbFJlZ2lzdHJ5O1xuICBzZXNzaW9uUHJvdmlkZXI/OiBzdHJpbmc7XG4gIGNvbnRleHRNb2RlUmVuZGVyTW9kZT86IENvbnRleHRNb2RlUmVuZGVyTW9kZTtcbn0pOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCB7XG4gICAgbWlkLCBzaWQsIHNUaXRsZSwgYmFzZSwgbGV2ZWwsIHByb21wdFRlbXBsYXRlLCBwcmVwZW5kQmxvY2tzID0gW10sIGV4dHJhVmFycyA9IHt9LFxuICAgIHNlc3Npb25Db250ZXh0V2luZG93LCBtb2RlbFJlZ2lzdHJ5LCBzZXNzaW9uUHJvdmlkZXIsXG4gIH0gPSBvcHRpb25zO1xuXG4gIGNvbnN0IHJvYWRtYXBQYXRoID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZSwgbWlkLCBcIlJPQURNQVBcIik7XG4gIGNvbnN0IHJvYWRtYXBSZWwgPSByZWxNaWxlc3RvbmVGaWxlKGJhc2UsIG1pZCwgXCJST0FETUFQXCIpO1xuICBjb25zdCByZXNlYXJjaFBhdGggPSByZXNvbHZlU2xpY2VGaWxlKGJhc2UsIG1pZCwgc2lkLCBcIlJFU0VBUkNIXCIpO1xuICBjb25zdCByZXNlYXJjaFJlbCA9IHJlbFNsaWNlRmlsZShiYXNlLCBtaWQsIHNpZCwgXCJSRVNFQVJDSFwiKTtcbiAgY29uc3Qgc2xpY2VDb250ZXh0UGF0aCA9IHJlc29sdmVTbGljZUZpbGUoYmFzZSwgbWlkLCBzaWQsIFwiQ09OVEVYVFwiKTtcbiAgY29uc3Qgc2xpY2VDb250ZXh0UmVsID0gcmVsU2xpY2VGaWxlKGJhc2UsIG1pZCwgc2lkLCBcIkNPTlRFWFRcIik7XG5cbiAgY29uc3QgaW5saW5lZDogc3RyaW5nW10gPSBbLi4ucHJlcGVuZEJsb2Nrc107XG5cbiAgLy8gUGhhc2UgaGFuZG9mZiBhbmNob3IgZnJvbSByZXNlYXJjaCBwaGFzZSAoaWYgYXZhaWxhYmxlKVxuICBjb25zdCByZXNlYXJjaFNsaWNlQW5jaG9yID0gcmVhZFBoYXNlQW5jaG9yKGJhc2UsIG1pZCwgXCJyZXNlYXJjaC1zbGljZVwiKTtcbiAgaWYgKHJlc2VhcmNoU2xpY2VBbmNob3IpIGlubGluZWQucHVzaChmb3JtYXRBbmNob3JGb3JQcm9tcHQocmVzZWFyY2hTbGljZUFuY2hvcikpO1xuXG4gIC8vIFJvYWRtYXAgZXhjZXJwdCB3aXRoIGZ1bGwtcm9hZG1hcCBmYWxsYmFja1xuICBjb25zdCByb2FkbWFwRXhjZXJwdCA9IGF3YWl0IGlubGluZVJvYWRtYXBFeGNlcnB0KGJhc2UsIG1pZCwgc2lkKTtcbiAgaWYgKHJvYWRtYXBFeGNlcnB0KSB7XG4gICAgaW5saW5lZC5wdXNoKHJvYWRtYXBFeGNlcnB0KTtcbiAgfSBlbHNlIHtcbiAgICBpbmxpbmVkLnB1c2goYXdhaXQgaW5saW5lRmlsZShyb2FkbWFwUGF0aCwgcm9hZG1hcFJlbCwgXCJNaWxlc3RvbmUgUm9hZG1hcFwiKSk7XG4gIH1cblxuICBjb25zdCBzbGljZUN0eElubGluZSA9IGF3YWl0IGlubGluZUZpbGVPcHRpb25hbChzbGljZUNvbnRleHRQYXRoLCBzbGljZUNvbnRleHRSZWwsIFwiU2xpY2UgQ29udGV4dCAoZnJvbSBkaXNjdXNzaW9uKVwiKTtcbiAgaWYgKHNsaWNlQ3R4SW5saW5lKSBpbmxpbmVkLnB1c2goc2xpY2VDdHhJbmxpbmUpO1xuICBjb25zdCByZXNlYXJjaElubGluZSA9IGF3YWl0IGlubGluZUZpbGVPcHRpb25hbChyZXNlYXJjaFBhdGgsIHJlc2VhcmNoUmVsLCBcIlNsaWNlIFJlc2VhcmNoXCIpO1xuICBpZiAocmVzZWFyY2hJbmxpbmUpIGlubGluZWQucHVzaChyZXNlYXJjaElubGluZSk7XG5cbiAgaWYgKGxldmVsICE9PSBcIm1pbmltYWxcIikge1xuICAgIGNvbnN0IGRlcml2ZWRTY29wZSA9IGRlcml2ZVNsaWNlU2NvcGUoc1RpdGxlKTtcbiAgICBjb25zdCBkZWNpc2lvbnNJbmxpbmUgPSBhd2FpdCBpbmxpbmVEZWNpc2lvbnNGcm9tRGIoYmFzZSwgbWlkLCBkZXJpdmVkU2NvcGUsIGxldmVsKTtcbiAgICBpZiAoZGVjaXNpb25zSW5saW5lKSBpbmxpbmVkLnB1c2goZGVjaXNpb25zSW5saW5lKTtcbiAgICBjb25zdCByZXF1aXJlbWVudHNJbmxpbmUgPSBhd2FpdCBpbmxpbmVSZXF1aXJlbWVudHNGcm9tRGIoYmFzZSwgbWlkLCBzaWQsIGxldmVsKTtcbiAgICBpZiAocmVxdWlyZW1lbnRzSW5saW5lKSBpbmxpbmVkLnB1c2gocmVxdWlyZW1lbnRzSW5saW5lKTtcbiAgfVxuXG4gIGNvbnN0IGtub3dsZWRnZUlubGluZSA9IGF3YWl0IGlubGluZUtub3dsZWRnZVNjb3BlZChiYXNlLCBleHRyYWN0S2V5d29yZHMoc1RpdGxlKSk7XG4gIGlmIChrbm93bGVkZ2VJbmxpbmUpIGlubGluZWQucHVzaChrbm93bGVkZ2VJbmxpbmUpO1xuXG4gIGNvbnN0IGdyYXBoQmxvY2sgPSBhd2FpdCBpbmxpbmVHcmFwaFN1YmdyYXBoKGJhc2UsIGAke3NpZH0gJHtzVGl0bGV9YCwgeyBidWRnZXQ6IDMwMDAgfSk7XG4gIGlmIChncmFwaEJsb2NrKSBpbmxpbmVkLnB1c2goZ3JhcGhCbG9jayk7XG5cbiAgaW5saW5lZC5wdXNoKGxldmVsID09PSBcIm1pbmltYWxcIiA/IGlubGluZUNvbXBhY3RUZW1wbGF0ZShcInBsYW5cIiwgXCJTbGljZSBQbGFuXCIpIDogaW5saW5lVGVtcGxhdGUoXCJwbGFuXCIsIFwiU2xpY2UgUGxhblwiKSk7XG4gIGlmIChsZXZlbCA9PT0gXCJmdWxsXCIpIHtcbiAgICBpbmxpbmVkLnB1c2goaW5saW5lVGVtcGxhdGUoXCJ0YXNrLXBsYW5cIiwgXCJUYXNrIFBsYW5cIikpO1xuICB9XG5cbiAgY29uc3QgZGVwQ29udGVudCA9IGF3YWl0IGlubGluZURlcGVuZGVuY3lTdW1tYXJpZXMobWlkLCBzaWQsIGJhc2UsIHJlc29sdmVTdW1tYXJ5QnVkZ2V0Q2hhcnMoKSk7XG4gIGNvbnN0IG92ZXJyaWRlc0lubGluZSA9IGZvcm1hdE92ZXJyaWRlc1NlY3Rpb24oYXdhaXQgbG9hZEFjdGl2ZU92ZXJyaWRlcyhiYXNlKSk7XG4gIGlmIChvdmVycmlkZXNJbmxpbmUpIGlubGluZWQudW5zaGlmdChvdmVycmlkZXNJbmxpbmUpO1xuXG4gIGNvbnN0IGlubGluZWRDb250ZXh0ID0gcHJlcGVuZENvbnRleHRNb2RlVG9CbG9jayhcbiAgICBwcm9tcHRUZW1wbGF0ZSxcbiAgICBiYXNlLFxuICAgIGNhcFByZWFtYmxlKGAjIyBJbmxpbmVkIENvbnRleHQgKHByZWxvYWRlZCBcdTIwMTQgZG8gbm90IHJlLXJlYWQgdGhlc2UgZmlsZXMpXFxuXFxuJHtpbmxpbmVkLmpvaW4oXCJcXG5cXG4tLS1cXG5cXG5cIil9YCksXG4gICAgb3B0aW9ucy5jb250ZXh0TW9kZVJlbmRlck1vZGUsXG4gICk7XG4gIGNvbnN0IGV4ZWN1dG9yQ29udGV4dENvbnN0cmFpbnRzID0gZm9ybWF0RXhlY3V0b3JDb25zdHJhaW50cyhzZXNzaW9uQ29udGV4dFdpbmRvdywgbW9kZWxSZWdpc3RyeSwgc2Vzc2lvblByb3ZpZGVyKTtcbiAgY29uc3Qgb3V0cHV0UmVsUGF0aCA9IHJlbFNsaWNlRmlsZShiYXNlLCBtaWQsIHNpZCwgXCJQTEFOXCIpO1xuICBjb25zdCBjb21taXRJbnN0cnVjdGlvbiA9IFwiRG8gbm90IGNvbW1pdCBcdTIwMTQgLmdzZC8gcGxhbm5pbmcgZG9jcyBhcmUgbWFuYWdlZCBleHRlcm5hbGx5IGFuZCBub3QgdHJhY2tlZCBpbiBnaXQuXCI7XG5cbiAgcmV0dXJuIGxvYWRQcm9tcHQocHJvbXB0VGVtcGxhdGUsIHtcbiAgICB3b3JraW5nRGlyZWN0b3J5OiBiYXNlLFxuICAgIG1pbGVzdG9uZUlkOiBtaWQsIHNsaWNlSWQ6IHNpZCwgc2xpY2VUaXRsZTogc1RpdGxlLFxuICAgIHNsaWNlUGF0aDogcmVsU2xpY2VQYXRoKGJhc2UsIG1pZCwgc2lkKSxcbiAgICByb2FkbWFwUGF0aDogcm9hZG1hcFJlbCxcbiAgICByZXNlYXJjaFBhdGg6IHJlc2VhcmNoUmVsLFxuICAgIG91dHB1dFBhdGg6IGpvaW4oYmFzZSwgb3V0cHV0UmVsUGF0aCksXG4gICAgaW5saW5lZENvbnRleHQsXG4gICAgZGVwZW5kZW5jeVN1bW1hcmllczogZGVwQ29udGVudCxcbiAgICBzb3VyY2VGaWxlUGF0aHM6IGJ1aWxkU291cmNlRmlsZVBhdGhzKGJhc2UsIG1pZCwgc2lkKSxcbiAgICBleGVjdXRvckNvbnRleHRDb25zdHJhaW50cyxcbiAgICBjb21taXRJbnN0cnVjdGlvbixcbiAgICBza2lsbEFjdGl2YXRpb246IGJ1aWxkU2tpbGxBY3RpdmF0aW9uQmxvY2soe1xuICAgICAgYmFzZSxcbiAgICAgIG1pbGVzdG9uZUlkOiBtaWQsXG4gICAgICBzbGljZUlkOiBzaWQsXG4gICAgICBzbGljZVRpdGxlOiBzVGl0bGUsXG4gICAgICBleHRyYUNvbnRleHQ6IFtpbmxpbmVkQ29udGV4dCwgZGVwQ29udGVudF0sXG4gICAgICB1bml0VHlwZTogcHJvbXB0VGVtcGxhdGUsXG4gICAgfSksXG4gICAgLi4uZXh0cmFWYXJzLFxuICB9KTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGJ1aWxkUGxhblNsaWNlUHJvbXB0KFxuICBtaWQ6IHN0cmluZywgX21pZFRpdGxlOiBzdHJpbmcsIHNpZDogc3RyaW5nLCBzVGl0bGU6IHN0cmluZywgYmFzZTogc3RyaW5nLCBsZXZlbD86IElubGluZUxldmVsLFxuICBvcHRpb25zPzoge1xuICAgIHNvZnRTY29wZUhpbnQ/OiBzdHJpbmc7XG4gICAgc2Vzc2lvbkNvbnRleHRXaW5kb3c/OiBudW1iZXI7XG4gICAgbW9kZWxSZWdpc3RyeT86IE1pbmltYWxNb2RlbFJlZ2lzdHJ5O1xuICAgIHNlc3Npb25Qcm92aWRlcj86IHN0cmluZztcbiAgICAvKiogRmFpbHVyZSBjb250ZXh0IGZyb20gYSBwcmlvciBwcmUtZXhlYyBnYXRlIHJ1biAoIzQ1NTEpLiBXaGVuIHByZXNlbnQsIGFcbiAgICAgKiAgXCJGaXggdGhlc2Ugc3BlY2lmaWMgaXNzdWVzXCIgc2VjdGlvbiBpcyBhcHBlbmRlZCBzbyB0aGUgTExNIGFkZHJlc3NlcyB0aGVcbiAgICAgKiAgZXhhY3QgcHJvYmxlbXMgaW5zdGVhZCBvZiBwcm9kdWNpbmcgYW4gaWRlbnRpY2FsIHBsYW4gdGhhdCBmYWlscyBhZ2Fpbi4gKi9cbiAgICBwcmlvclByZUV4ZWNGYWlsdXJlPzoge1xuICAgICAgYmxvY2tpbmdGaW5kaW5nczogc3RyaW5nW107XG4gICAgICB2ZXJkaWN0RXhjZXJwdDogc3RyaW5nO1xuICAgIH07XG4gIH0sXG4pOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCBwcmVwZW5kQmxvY2tzOiBzdHJpbmdbXSA9IFtdO1xuICAvLyBBRFItMDExOiB3aGVuIHRoZSByZWZpbmluZy1waGFzZSBkaXNwYXRjaCBydWxlIGdyYWNlZnVsbHkgZG93bmdyYWRlcyB0b1xuICAvLyBwbGFuLXNsaWNlIChwcm9ncmVzc2l2ZV9wbGFubmluZyB3YXMgdG9nZ2xlZCBvZmYgbWlkLW1pbGVzdG9uZSksIGl0XG4gIC8vIGZvcndhcmRzIHRoZSBzdG9yZWQgc2tldGNoX3Njb3BlIGFzIGEgU09GVCBoaW50IFx1MjAxNCBjb250ZXh0LCBub3QgYSBoYXJkXG4gIC8vIGNvbnN0cmFpbnQuIFRoZSBwbGFubmVyIGlzIGZyZWUgdG8gZXhwYW5kIGJleW9uZCBpdC5cbiAgaWYgKG9wdGlvbnM/LnNvZnRTY29wZUhpbnQgJiYgb3B0aW9ucy5zb2Z0U2NvcGVIaW50LnRyaW0oKS5sZW5ndGggPiAwKSB7XG4gICAgcHJlcGVuZEJsb2Nrcy5wdXNoKFxuICAgICAgYCMjIFByaW9yIFNrZXRjaCBTY29wZSAoc29mdCBoaW50IFx1MjAxNCBub24tYmluZGluZylcXG5cXG4ke29wdGlvbnMuc29mdFNjb3BlSGludC50cmltKCl9XFxuXFxuYCArXG4gICAgICBgVGhpcyBzY29wZSB3YXMgY2FwdHVyZWQgZHVyaW5nIGFuIGVhcmxpZXIgcHJvZ3Jlc3NpdmUtcGxhbm5pbmcgcGFzcyB0aGF0IHdhcyBsYXRlciBkaXNhYmxlZC4gVHJlYXQgaXQgYXMgY29udGV4dCBvbmx5IFx1MjAxNCB5b3UgbWF5IHBsYW4gYmV5b25kIGl0IGlmIHRoZSB3b3JrIGdlbnVpbmVseSByZXF1aXJlcyBtb3JlIHNjb3BlLiBEbyBOT1QgdHJlYXQgdGhpcyBhcyBhIGhhcmQgYm91bmRhcnkuYCxcbiAgICApO1xuICB9XG4gIC8vICM0NTUxOiBpbmplY3QgcHJlLWV4ZWMgZmFpbHVyZSBjb250ZXh0IHNvIHRoZSByZS1kaXNwYXRjaGVkIHBsYW4tc2xpY2VcbiAgLy8gYWRkcmVzc2VzIHRoZSBleGFjdCBibG9ja2VkIHJlZmVyZW5jZXMgcmF0aGVyIHRoYW4gcmVwcm9kdWNpbmcgdGhlIHNhbWUgcGxhbi5cbiAgaWYgKG9wdGlvbnM/LnByaW9yUHJlRXhlY0ZhaWx1cmUpIHtcbiAgICBjb25zdCB7IGJsb2NraW5nRmluZGluZ3MsIHZlcmRpY3RFeGNlcnB0IH0gPSBvcHRpb25zLnByaW9yUHJlRXhlY0ZhaWx1cmU7XG4gICAgY29uc3QgZmluZGluZ3NMaXN0ID0gYmxvY2tpbmdGaW5kaW5ncy5sZW5ndGggPiAwXG4gICAgICA/IGJsb2NraW5nRmluZGluZ3MubWFwKGYgPT4gYC0gJHtmfWApLmpvaW4oXCJcXG5cIilcbiAgICAgIDogXCItIChubyBzcGVjaWZpYyBmaW5kaW5ncyByZWNvcmRlZClcIjtcbiAgICBwcmVwZW5kQmxvY2tzLnB1c2goXG4gICAgICBgIyMgRml4IHRoZXNlIHNwZWNpZmljIGlzc3VlcyBmcm9tIHRoZSBwcmlvciBwcmUtZXhlYyBjaGVja1xcblxcbmAgK1xuICAgICAgYFRoZSBwcmV2aW91cyBwbGFuLXNsaWNlIGF0dGVtcHQgd2FzIGJsb2NrZWQgYnkgcHJlLWV4ZWN1dGlvbiB2YWxpZGF0aW9uLlxcbmAgK1xuICAgICAgYEdhdGUgdmVyZGljdDogJHt2ZXJkaWN0RXhjZXJwdH1cXG5cXG5gICtcbiAgICAgIGBCbG9ja2VkIHJlZmVyZW5jZXMgdGhhdCBtdXN0IGJlIHJlc29sdmVkIGluIHRoaXMgcGxhbjpcXG4ke2ZpbmRpbmdzTGlzdH1cXG5cXG5gICtcbiAgICAgIGAqKkhvdyB0byBmaXggZWFjaCB0eXBlIG9mIGlzc3VlOioqXFxuYCArXG4gICAgICBgLSAqKlwiW2ZpbGVdIFggZG9lc24ndCBleGlzdCBhbmQgaXNuJ3QgY3JlYXRlZCBieSBwcmlvciBvciBzYW1lLXRhc2sgb3V0cHV0c1wiKio6IGAgK1xuICAgICAgYEVpdGhlciAoYSkgYWRkIGFuIGVhcmxpZXIgdGFzayB0aGF0IGNyZWF0ZXMgWCBvbiBkaXNrIGJlZm9yZSB0aGUgdGFzayB0aGF0IG5lZWRzIGl0LCBgICtcbiAgICAgIGBvciAoYikgaWYgdGhpcyB0YXNrIElTIHRoZSBvbmUgdGhhdCBjcmVhdGVzIFgsIG1vdmUgWCBmcm9tIGlucHV0cyB0byBleHBlY3RlZF9vdXRwdXQuIGAgK1xuICAgICAgYERvIE5PVCBwdXQgWCBpbiBhIHRhc2sncyBleHBlY3RlZF9vdXRwdXQgaWYgdGhhdCB0YXNrIG9ubHkgcmVhZHMgb3IgdmVyaWZpZXMgWCBcdTIwMTQgb25seSB0YXNrcyB0aGF0IGFjdHVhbGx5IHdyaXRlIFggdG8gZGlzayBzaG91bGQgbGlzdCBpdCBpbiBleHBlY3RlZF9vdXRwdXQuXFxuYCArXG4gICAgICBgLSAqKlwiW2ZpbGVdIFg6IFRhc2sgVF9lYXJseSByZWFkcyBYIGJ1dCBpdCdzIGNyZWF0ZWQgYnkgdGFzayBUX2xhdGUgKHNlcXVlbmNlIHZpb2xhdGlvbilcIioqOiBgICtcbiAgICAgIGBFaXRoZXIgKGEpIHJlb3JkZXIgdGFza3Mgc28gVF9sYXRlICh0aGUgY3JlYXRvcikgcnVucyBiZWZvcmUgVF9lYXJseSAodGhlIHJlYWRlciksIGAgK1xuICAgICAgYG9yIChiKSBpZiBUX2xhdGUgZG9lc24ndCBhY3R1YWxseSBjcmVhdGUgWCAoaXQgb25seSByZWFkcy90ZXN0cyBpdCksIHJlbW92ZSBYIGZyb20gVF9sYXRlJ3MgZXhwZWN0ZWRfb3V0cHV0IGVudGlyZWx5LlxcbmAgK1xuICAgICAgYC0gKipcIltwYWNrYWdlXSBQIG5vdCBmb3VuZCBvbiBucG1cIioqOiBFaXRoZXIgcmVtb3ZlIHRoZSBucG0gaW5zdGFsbCBmb3IgUCwgb3IgdXNlIHRoZSBjb3JyZWN0IHBhY2thZ2UgbmFtZS5cXG5cXG5gICtcbiAgICAgIGBFdmVyeSBmaWxlIGxpc3RlZCBpbiBhIHRhc2sncyBpbnB1dHMgbXVzdCBlaXRoZXIgZXhpc3Qgb24gZGlzayBhbHJlYWR5IG9yIGFwcGVhciBpbiBhbiBlYXJsaWVyIHRhc2sncyBleHBlY3RlZF9vdXRwdXQuIGAgK1xuICAgICAgYEEgdGFzaydzIGV4cGVjdGVkX291dHB1dCBtdXN0IG9ubHkgbGlzdCBmaWxlcyBpdCBhY3R1YWxseSB3cml0ZXMgdG8gZGlzay5gLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHJlbmRlclNsaWNlUHJvbXB0KHtcbiAgICBtaWQsIHNpZCwgc1RpdGxlLCBiYXNlLFxuICAgIGxldmVsOiBsZXZlbCA/PyByZXNvbHZlSW5saW5lTGV2ZWwoKSxcbiAgICBwcm9tcHRUZW1wbGF0ZTogXCJwbGFuLXNsaWNlXCIsXG4gICAgcHJlcGVuZEJsb2NrcyxcbiAgICBzZXNzaW9uQ29udGV4dFdpbmRvdzogb3B0aW9ucz8uc2Vzc2lvbkNvbnRleHRXaW5kb3csXG4gICAgbW9kZWxSZWdpc3RyeTogb3B0aW9ucz8ubW9kZWxSZWdpc3RyeSxcbiAgICBzZXNzaW9uUHJvdmlkZXI6IG9wdGlvbnM/LnNlc3Npb25Qcm92aWRlcixcbiAgfSk7XG59XG5cbi8qKlxuICogQURSLTAxMSByZWZpbmUtc2xpY2U6IGV4cGFuZCBhIHNrZXRjaCBpbnRvIGEgZnVsbCBwbGFuIHVzaW5nIHRoZSBjdXJyZW50XG4gKiBjb2RlYmFzZSBzdGF0ZSBhbmQgcHJpb3Igc2xpY2Ugc3VtbWFyeS4gTWVjaGFuaWNhbGx5IHNpbWlsYXIgdG8gcGxhbi1zbGljZVxuICogYnV0IGZyYW1lZCBhcyBhICp0cmFuc2Zvcm1hdGlvbiogKHNrZXRjaCBcdTIxOTIgZnVsbCBwbGFuKSByYXRoZXIgdGhhbiBhXG4gKiBibGFuay1zaGVldCBwbGFubmluZyBwYXNzLiBSZXVzZXMgaW5saW5lRGVwZW5kZW5jeVN1bW1hcmllcyBmb3IgcHJpb3JcbiAqIHNsaWNlIFNVTU1BUlkgYW5kIGlubGluZXMgdGhlIHN0b3JlZCBza2V0Y2hfc2NvcGUgYXMgYSBoYXJkIGNvbnN0cmFpbnQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBidWlsZFJlZmluZVNsaWNlUHJvbXB0KFxuICBtaWQ6IHN0cmluZywgX21pZFRpdGxlOiBzdHJpbmcsIHNpZDogc3RyaW5nLCBzVGl0bGU6IHN0cmluZywgYmFzZTogc3RyaW5nLCBsZXZlbD86IElubGluZUxldmVsLFxuICBvcHRpb25zPzogeyBzZXNzaW9uQ29udGV4dFdpbmRvdz86IG51bWJlcjsgbW9kZWxSZWdpc3RyeT86IE1pbmltYWxNb2RlbFJlZ2lzdHJ5OyBzZXNzaW9uUHJvdmlkZXI/OiBzdHJpbmcgfSxcbik6IFByb21pc2U8c3RyaW5nPiB7XG4gIC8vIFB1bGwgdGhlIHN0b3JlZCBza2V0Y2ggc2NvcGUgZnJvbSB0aGUgREIgXHUyMDE0IHRoZSBoYXJkIGNvbnN0cmFpbnQgd2UgcGxhbiB3aXRoaW4uXG4gIGxldCBza2V0Y2hTY29wZSA9IFwiXCI7XG4gIHRyeSB7XG4gICAgY29uc3QgeyBpc0RiQXZhaWxhYmxlLCBnZXRTbGljZSB9ID0gYXdhaXQgaW1wb3J0KFwiLi9nc2QtZGIuanNcIik7XG4gICAgaWYgKGlzRGJBdmFpbGFibGUoKSkge1xuICAgICAgc2tldGNoU2NvcGUgPSBnZXRTbGljZShtaWQsIHNpZCk/LnNrZXRjaF9zY29wZSA/PyBcIlwiO1xuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgc2tldGNoU2NvcGUgPSBcIlwiO1xuICB9XG5cbiAgY29uc3QgcHJlcGVuZEJsb2Nrczogc3RyaW5nW10gPSBbXTtcbiAgaWYgKHNrZXRjaFNjb3BlLnRyaW0oKS5sZW5ndGggPiAwKSB7XG4gICAgcHJlcGVuZEJsb2Nrcy5wdXNoKFxuICAgICAgYCMjIFNrZXRjaCBTY29wZSAoaGFyZCBjb25zdHJhaW50KVxcblxcbiR7c2tldGNoU2NvcGUudHJpbSgpfVxcblxcbmAgK1xuICAgICAgYFRyZWF0IHRoaXMgYXMgdGhlIGF1dGhvcml0YXRpdmUgYm91bmRhcnkgZm9yIHRoZSBzbGljZS4gRG8gbm90IHBsYW4gd29yayBvdXRzaWRlIHRoaXMgc2NvcGU7IGlmIHRoZSBzY29wZSBpcyB0b28gbmFycm93LCBzdXJmYWNlIGl0IGFzIGEgZGV2aWF0aW9uIHJhdGhlciB0aGFuIGV4cGFuZGluZyBzaWxlbnRseS5gLFxuICAgICk7XG4gIH1cblxuICByZXR1cm4gcmVuZGVyU2xpY2VQcm9tcHQoe1xuICAgIG1pZCwgc2lkLCBzVGl0bGUsIGJhc2UsXG4gICAgbGV2ZWw6IGxldmVsID8/IHJlc29sdmVJbmxpbmVMZXZlbCgpLFxuICAgIHByb21wdFRlbXBsYXRlOiBcInJlZmluZS1zbGljZVwiLFxuICAgIHByZXBlbmRCbG9ja3MsXG4gICAgZXh0cmFWYXJzOiB7IHNrZXRjaFNjb3BlIH0sXG4gICAgc2Vzc2lvbkNvbnRleHRXaW5kb3c6IG9wdGlvbnM/LnNlc3Npb25Db250ZXh0V2luZG93LFxuICAgIG1vZGVsUmVnaXN0cnk6IG9wdGlvbnM/Lm1vZGVsUmVnaXN0cnksXG4gICAgc2Vzc2lvblByb3ZpZGVyOiBvcHRpb25zPy5zZXNzaW9uUHJvdmlkZXIsXG4gIH0pO1xufVxuXG4vKiogT3B0aW9ucyBmb3IgY3VzdG9taXppbmcgZXhlY3V0ZS10YXNrIHByb21wdCBjb25zdHJ1Y3Rpb24uICovXG5leHBvcnQgaW50ZXJmYWNlIEV4ZWN1dGVUYXNrUHJvbXB0T3B0aW9ucyB7XG4gIGxldmVsPzogSW5saW5lTGV2ZWw7XG4gIC8qKiBPdmVycmlkZSBjYXJyeS1mb3J3YXJkIHBhdGhzIChkZXBlbmRlbmN5LWJhc2VkIGluc3RlYWQgb2Ygb3JkZXItYmFzZWQpLiAqL1xuICBjYXJyeUZvcndhcmRQYXRocz86IHN0cmluZ1tdO1xuICAvKiogU2Vzc2lvbiBtb2RlbCBjb250ZXh0IHdpbmRvdyBpbiB0b2tlbnMsIGZvcndhcmRlZCB0byB0aGUgYnVkZ2V0IGVuZ2luZS4gKi9cbiAgc2Vzc2lvbkNvbnRleHRXaW5kb3c/OiBudW1iZXI7XG4gIC8qKiBNb2RlbCByZWdpc3RyeSBmb3J3YXJkZWQgdG8gdGhlIGJ1ZGdldCBlbmdpbmUgZm9yIGV4ZWN1dG9yLW1vZGVsIGxvb2t1cC4gKi9cbiAgbW9kZWxSZWdpc3RyeT86IE1pbmltYWxNb2RlbFJlZ2lzdHJ5O1xuICAvKiogU2Vzc2lvbiBtb2RlbCBwcm92aWRlciwgdXNlZCBmb3IgcHJvdmlkZXItc3BlY2lmaWMgZWZmZWN0aXZlIGNvbnRleHQgd2luZG93cy4gKi9cbiAgc2Vzc2lvblByb3ZpZGVyPzogc3RyaW5nO1xuICAvKiogUmVuZGVyIGNvbXBhY3QgQ29udGV4dCBNb2RlIGd1aWRhbmNlIHdoZW4gZW1iZWRkZWQgaW5zaWRlIGFub3RoZXIgcHJvbXB0LiAqL1xuICBjb250ZXh0TW9kZVJlbmRlck1vZGU/OiBDb250ZXh0TW9kZVJlbmRlck1vZGU7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBidWlsZEV4ZWN1dGVUYXNrUHJvbXB0KFxuICBtaWQ6IHN0cmluZywgc2lkOiBzdHJpbmcsIHNUaXRsZTogc3RyaW5nLFxuICB0aWQ6IHN0cmluZywgdFRpdGxlOiBzdHJpbmcsIGJhc2U6IHN0cmluZyxcbiAgbGV2ZWw/OiBJbmxpbmVMZXZlbCB8IEV4ZWN1dGVUYXNrUHJvbXB0T3B0aW9ucyxcbik6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IG9wdHM6IEV4ZWN1dGVUYXNrUHJvbXB0T3B0aW9ucyA9IHR5cGVvZiBsZXZlbCA9PT0gXCJvYmplY3RcIiAmJiBsZXZlbCAhPT0gbnVsbCAmJiAhQXJyYXkuaXNBcnJheShsZXZlbClcbiAgICA/IGxldmVsXG4gICAgOiB7IGxldmVsOiBsZXZlbCBhcyBJbmxpbmVMZXZlbCB8IHVuZGVmaW5lZCB9O1xuICBjb25zdCBpbmxpbmVMZXZlbCA9IG9wdHMubGV2ZWwgPz8gcmVzb2x2ZUlubGluZUxldmVsKCk7XG5cbiAgLy8gSW5qZWN0IHBoYXNlIGhhbmRvZmYgYW5jaG9yIGZyb20gcGxhbm5pbmcgcGhhc2UgKGlmIGF2YWlsYWJsZSlcbiAgY29uc3QgcGxhbkFuY2hvciA9IHJlYWRQaGFzZUFuY2hvcihiYXNlLCBtaWQsIFwicGxhbi1zbGljZVwiKTtcblxuICBjb25zdCBwcmlvclN1bW1hcmllcyA9IG9wdHMuY2FycnlGb3J3YXJkUGF0aHMgPz8gYXdhaXQgZ2V0UHJpb3JUYXNrU3VtbWFyeVBhdGhzKG1pZCwgc2lkLCB0aWQsIGJhc2UpO1xuICBjb25zdCBwcmlvckxpbmVzID0gcHJpb3JTdW1tYXJpZXMubGVuZ3RoID4gMFxuICAgID8gcHJpb3JTdW1tYXJpZXMubWFwKHAgPT4gYC0gXFxgJHtwfVxcYGApLmpvaW4oXCJcXG5cIilcbiAgICA6IFwiLSAobm8gcHJpb3IgdGFza3MpXCI7XG5cbiAgY29uc3QgdGFza1BsYW5QYXRoID0gcmVzb2x2ZVRhc2tGaWxlKGJhc2UsIG1pZCwgc2lkLCB0aWQsIFwiUExBTlwiKTtcbiAgY29uc3QgdGFza1BsYW5Db250ZW50ID0gdGFza1BsYW5QYXRoID8gYXdhaXQgbG9hZEZpbGUodGFza1BsYW5QYXRoKSA6IG51bGw7XG4gIGNvbnN0IHRhc2tQbGFuUmVsUGF0aCA9IHJlbFNsaWNlUGF0aChiYXNlLCBtaWQsIHNpZCkgKyBgL3Rhc2tzLyR7dGlkfS1QTEFOLm1kYDtcbiAgY29uc3QgdGFza1BsYW5JbmxpbmUgPSB0YXNrUGxhbkNvbnRlbnRcbiAgICA/IFtcbiAgICAgIFwiIyMgSW5saW5lZCBUYXNrIFBsYW4gKGF1dGhvcml0YXRpdmUgbG9jYWwgZXhlY3V0aW9uIGNvbnRyYWN0KVwiLFxuICAgICAgYFNvdXJjZTogXFxgJHt0YXNrUGxhblJlbFBhdGh9XFxgYCxcbiAgICAgIFwiXCIsXG4gICAgICB0YXNrUGxhbkNvbnRlbnQudHJpbSgpLFxuICAgIF0uam9pbihcIlxcblwiKVxuICAgIDogW1xuICAgICAgXCIjIyBJbmxpbmVkIFRhc2sgUGxhbiAoYXV0aG9yaXRhdGl2ZSBsb2NhbCBleGVjdXRpb24gY29udHJhY3QpXCIsXG4gICAgICBgVGFzayBwbGFuIG5vdCBmb3VuZCBhdCBkaXNwYXRjaCB0aW1lLiBSZWFkIFxcYCR7dGFza1BsYW5SZWxQYXRofVxcYCBiZWZvcmUgZXhlY3V0aW5nLmAsXG4gICAgXS5qb2luKFwiXFxuXCIpO1xuXG4gIGNvbnN0IHNsaWNlUGxhblBhdGggPSByZXNvbHZlU2xpY2VGaWxlKGJhc2UsIG1pZCwgc2lkLCBcIlBMQU5cIik7XG4gIGNvbnN0IHNsaWNlUGxhbkNvbnRlbnQgPSBzbGljZVBsYW5QYXRoID8gYXdhaXQgbG9hZEZpbGUoc2xpY2VQbGFuUGF0aCkgOiBudWxsO1xuICBjb25zdCBzbGljZVBsYW5FeGNlcnB0ID0gZXh0cmFjdFNsaWNlRXhlY3V0aW9uRXhjZXJwdChzbGljZVBsYW5Db250ZW50LCByZWxTbGljZUZpbGUoYmFzZSwgbWlkLCBzaWQsIFwiUExBTlwiKSk7XG5cbiAgLy8gQ2hlY2sgZm9yIGNvbnRpbnVlIGZpbGUgKG5ldyBuYW1pbmcgb3IgbGVnYWN5KVxuICBjb25zdCBjb250aW51ZUZpbGUgPSByZXNvbHZlU2xpY2VGaWxlKGJhc2UsIG1pZCwgc2lkLCBcIkNPTlRJTlVFXCIpO1xuICBjb25zdCBsZWdhY3lDb250aW51ZURpciA9IHJlc29sdmVTbGljZVBhdGgoYmFzZSwgbWlkLCBzaWQpO1xuICBjb25zdCBsZWdhY3lDb250aW51ZVBhdGggPSBsZWdhY3lDb250aW51ZURpciA/IGpvaW4obGVnYWN5Q29udGludWVEaXIsIFwiY29udGludWUubWRcIikgOiBudWxsO1xuICBjb25zdCBjb250aW51ZUNvbnRlbnQgPSBjb250aW51ZUZpbGUgPyBhd2FpdCBsb2FkRmlsZShjb250aW51ZUZpbGUpIDogbnVsbDtcbiAgY29uc3QgbGVnYWN5Q29udGludWVDb250ZW50ID0gIWNvbnRpbnVlQ29udGVudCAmJiBsZWdhY3lDb250aW51ZVBhdGggPyBhd2FpdCBsb2FkRmlsZShsZWdhY3lDb250aW51ZVBhdGgpIDogbnVsbDtcbiAgY29uc3QgY29udGludWVSZWxQYXRoID0gcmVsU2xpY2VGaWxlKGJhc2UsIG1pZCwgc2lkLCBcIkNPTlRJTlVFXCIpO1xuICBjb25zdCByZXN1bWVTZWN0aW9uID0gYnVpbGRSZXN1bWVTZWN0aW9uKFxuICAgIGNvbnRpbnVlQ29udGVudCxcbiAgICBsZWdhY3lDb250aW51ZUNvbnRlbnQsXG4gICAgY29udGludWVSZWxQYXRoLFxuICAgIGxlZ2FjeUNvbnRpbnVlUGF0aCA/IGAke3JlbFNsaWNlUGF0aChiYXNlLCBtaWQsIHNpZCl9L2NvbnRpbnVlLm1kYCA6IG51bGwsXG4gICk7XG5cbiAgLy8gRm9yIG1pbmltYWwgaW5saW5lIGxldmVsLCBvbmx5IGNhcnJ5IGZvcndhcmQgdGhlIG1vc3QgcmVjZW50IHByaW9yIHN1bW1hcnlcbiAgY29uc3QgZWZmZWN0aXZlUHJpb3JTdW1tYXJpZXMgPSBpbmxpbmVMZXZlbCA9PT0gXCJtaW5pbWFsXCIgJiYgcHJpb3JTdW1tYXJpZXMubGVuZ3RoID4gMVxuICAgID8gcHJpb3JTdW1tYXJpZXMuc2xpY2UoLTEpXG4gICAgOiBwcmlvclN1bW1hcmllcztcbiAgY29uc3QgY2FycnlGb3J3YXJkU2VjdGlvbiA9IGF3YWl0IGJ1aWxkQ2FycnlGb3J3YXJkU2VjdGlvbihlZmZlY3RpdmVQcmlvclN1bW1hcmllcywgYmFzZSk7XG5cbiAgLy8gSW5saW5lIHByb2plY3Qga25vd2xlZGdlIGlmIGF2YWlsYWJsZSAoc21hcnQtY2h1bmtlZCBmb3IgcmVsZXZhbmNlKVxuICBjb25zdCBrbm93bGVkZ2VBYnNQYXRoID0gcmVzb2x2ZUdzZFJvb3RGaWxlKGJhc2UsIFwiS05PV0xFREdFXCIpO1xuICBjb25zdCBrbm93bGVkZ2VJbmxpbmVFVCA9IGV4aXN0c1N5bmMoa25vd2xlZGdlQWJzUGF0aClcbiAgICA/IGF3YWl0IGlubGluZUZpbGVTbWFydChcbiAgICAgICAga25vd2xlZGdlQWJzUGF0aCxcbiAgICAgICAgcmVsR3NkUm9vdEZpbGUoXCJLTk9XTEVER0VcIiksXG4gICAgICAgIFwiUHJvamVjdCBLbm93bGVkZ2VcIixcbiAgICAgICAgYCR7dFRpdGxlfSAke3NUaXRsZX1gLCAgLy8gdXNlIHRhc2sgKyBzbGljZSB0aXRsZSBhcyByZWxldmFuY2UgcXVlcnlcbiAgICAgIClcbiAgICA6IG51bGw7XG4gIC8vIE9ubHkgaW5jbHVkZSBpZiBpdCBoYXMgY29udGVudCAobm90IGEgXCJub3QgZm91bmRcIiByZXN1bHQpXG4gIGNvbnN0IGtub3dsZWRnZUNvbnRlbnQgPSBrbm93bGVkZ2VJbmxpbmVFVCAmJiAha25vd2xlZGdlSW5saW5lRVQuaW5jbHVkZXMoXCJub3QgZm91bmRcIikgPyBrbm93bGVkZ2VJbmxpbmVFVCA6IG51bGw7XG5cbiAgLy8gS25vd2xlZGdlIGdyYXBoOiB0aWdodCBzdWJncmFwaCBmb3IgdGhpcyB0YXNrIChncmFjZWZ1bCBcdTIwMTQgc2tpcHBlZCBpZiBubyBncmFwaC5qc29uKVxuICBjb25zdCBncmFwaEJsb2NrRVQgPSBhd2FpdCBpbmxpbmVHcmFwaFN1YmdyYXBoKGJhc2UsIGAke3RpZH0gJHt0VGl0bGV9YCwgeyBidWRnZXQ6IDIwMDAgfSk7XG5cbiAgY29uc3QgaW5saW5lZFRlbXBsYXRlcyA9IGlubGluZUxldmVsID09PSBcIm1pbmltYWxcIlxuICAgID8gaW5saW5lQ29tcGFjdFRlbXBsYXRlKFwidGFzay1zdW1tYXJ5XCIsIFwiVGFzayBTdW1tYXJ5XCIpXG4gICAgOiBbXG4gICAgICAgIGlubGluZVRlbXBsYXRlKFwidGFzay1zdW1tYXJ5XCIsIFwiVGFzayBTdW1tYXJ5XCIpLFxuICAgICAgICBpbmxpbmVUZW1wbGF0ZShcImRlY2lzaW9uc1wiLCBcIkRlY2lzaW9uc1wiKSxcbiAgICAgICAgLi4uKGtub3dsZWRnZUNvbnRlbnQgPyBba25vd2xlZGdlQ29udGVudF0gOiBbXSksXG4gICAgICAgIC4uLihncmFwaEJsb2NrRVQgPyBbZ3JhcGhCbG9ja0VUXSA6IFtdKSxcbiAgICAgIF0uam9pbihcIlxcblxcbi0tLVxcblxcblwiKTtcblxuICBjb25zdCB0YXNrU3VtbWFyeVBhdGggPSBqb2luKGJhc2UsIGAke3JlbFNsaWNlUGF0aChiYXNlLCBtaWQsIHNpZCl9L3Rhc2tzLyR7dGlkfS1TVU1NQVJZLm1kYCk7XG5cbiAgY29uc3QgYWN0aXZlT3ZlcnJpZGVzID0gYXdhaXQgbG9hZEFjdGl2ZU92ZXJyaWRlcyhiYXNlKTtcbiAgY29uc3Qgb3ZlcnJpZGVzU2VjdGlvbiA9IGZvcm1hdE92ZXJyaWRlc1NlY3Rpb24oYWN0aXZlT3ZlcnJpZGVzKTtcblxuICAvLyBDb21wdXRlIHZlcmlmaWNhdGlvbiBidWRnZXQgZm9yIHRoZSBleGVjdXRvcidzIGNvbnRleHQgd2luZG93IChpc3N1ZSAjNzA3KVxuICBjb25zdCBwcmVmcyA9IGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcygpO1xuICBjb25zdCBjb250ZXh0V2luZG93ID0gcmVzb2x2ZUV4ZWN1dG9yQ29udGV4dFdpbmRvdyhvcHRzLm1vZGVsUmVnaXN0cnksIHByZWZzPy5wcmVmZXJlbmNlcywgb3B0cy5zZXNzaW9uQ29udGV4dFdpbmRvdywgb3B0cy5zZXNzaW9uUHJvdmlkZXIpO1xuICBjb25zdCBidWRnZXRzID0gY29tcHV0ZUJ1ZGdldHMoY29udGV4dFdpbmRvdyk7XG4gIGNvbnN0IHZlcmlmaWNhdGlvbkJ1ZGdldCA9IGB+JHtNYXRoLnJvdW5kKGJ1ZGdldHMudmVyaWZpY2F0aW9uQnVkZ2V0Q2hhcnMgLyAxMDAwKX1LIGNoYXJzYDtcblxuICAvLyBUcnVuY2F0ZSBjYXJyeS1mb3J3YXJkIHNlY3Rpb24gd2hlbiBpdCBleGNlZWRzIDQwJSBvZiBpbmxpbmUgY29udGV4dCBidWRnZXQuXG4gIGNvbnN0IGNhcnJ5Rm9yd2FyZEJ1ZGdldCA9IE1hdGguZmxvb3IoYnVkZ2V0cy5pbmxpbmVDb250ZXh0QnVkZ2V0Q2hhcnMgKiAwLjQpO1xuICBsZXQgZmluYWxDYXJyeUZvcndhcmQgPSBjYXJyeUZvcndhcmRTZWN0aW9uO1xuICBpZiAoY2FycnlGb3J3YXJkU2VjdGlvbi5sZW5ndGggPiBjYXJyeUZvcndhcmRCdWRnZXQpIHtcbiAgICBmaW5hbENhcnJ5Rm9yd2FyZCA9IHRydW5jYXRlQXRTZWN0aW9uQm91bmRhcnkoY2FycnlGb3J3YXJkU2VjdGlvbiwgY2FycnlGb3J3YXJkQnVkZ2V0KS5jb250ZW50O1xuICB9XG5cbiAgLy8gSW5saW5lIFJVTlRJTUUubWQgaWYgcHJlc2VudFxuICBjb25zdCBydW50aW1lUGF0aCA9IHJlc29sdmVSdW50aW1lRmlsZShiYXNlKTtcbiAgY29uc3QgcnVudGltZUNvbnRlbnQgPSBleGlzdHNTeW5jKHJ1bnRpbWVQYXRoKSA/IGF3YWl0IGxvYWRGaWxlKHJ1bnRpbWVQYXRoKSA6IG51bGw7XG4gIGNvbnN0IHJ1bnRpbWVDb250ZXh0ID0gcnVudGltZUNvbnRlbnRcbiAgICA/IGAjIyMgUnVudGltZSBDb250ZXh0XFxuU291cmNlOiBcXGAuZ3NkL1JVTlRJTUUubWRcXGBcXG5cXG4ke3J1bnRpbWVDb250ZW50LnRyaW0oKX1gXG4gICAgOiBcIlwiO1xuXG4gIGxldCBwaGFzZUFuY2hvclNlY3Rpb24gPSBwbGFuQW5jaG9yID8gZm9ybWF0QW5jaG9yRm9yUHJvbXB0KHBsYW5BbmNob3IpIDogXCJcIjtcblxuICAvLyBBRFItMDExIFBoYXNlIDI6IGluamVjdCBhbnkgcmVzb2x2ZWQtYnV0LXVuYXBwbGllZCBlc2NhbGF0aW9uIG92ZXJyaWRlXG4gIC8vIGludG8gdGhpcyB0YXNrJ3MgcHJvbXB0LiBDbGFpbSBpcyBhdG9taWMgdmlhIERCIFVQREFURSBXSEVSRSBJUyBOVUxMLCBzb1xuICAvLyBpZiBhIHBhcmFsbGVsIGJ1aWxkIGFscmVhZHkgaW5qZWN0ZWQgaXQsIHdlIHNraXAuIEZlYXR1cmUtZ2F0ZWQgYnlcbiAgLy8gcGhhc2VzLm1pZF9leGVjdXRpb25fZXNjYWxhdGlvbi4gUHJlcGVuZGVkIHRvIHBoYXNlQW5jaG9yU2VjdGlvbiBzbyBpdFxuICAvLyBhcHBlYXJzIG5lYXIgdGhlIHRvcCBvZiB0aGUgcHJvbXB0IGFib3ZlIHBsYW5uaW5nIGFuY2hvcnMuXG4gIGlmIChwcmVmcz8ucHJlZmVyZW5jZXM/LnBoYXNlcz8ubWlkX2V4ZWN1dGlvbl9lc2NhbGF0aW9uID09PSB0cnVlKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHsgY2xhaW1PdmVycmlkZUZvckluamVjdGlvbiB9ID0gYXdhaXQgaW1wb3J0KFwiLi9lc2NhbGF0aW9uLmpzXCIpO1xuICAgICAgY29uc3QgY2xhaW1lZCA9IGNsYWltT3ZlcnJpZGVGb3JJbmplY3Rpb24oYmFzZSwgbWlkLCBzaWQpO1xuICAgICAgaWYgKGNsYWltZWQpIHtcbiAgICAgICAgY29uc3QgYmxvY2sgPSBjbGFpbWVkLmluamVjdGlvbkJsb2NrICsgXCJcXG5cXG4tLS1cXG5cXG5cIjtcbiAgICAgICAgcGhhc2VBbmNob3JTZWN0aW9uID0gcGhhc2VBbmNob3JTZWN0aW9uXG4gICAgICAgICAgPyBgJHtibG9ja30ke3BoYXNlQW5jaG9yU2VjdGlvbn1gXG4gICAgICAgICAgOiBibG9jaztcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlc2NhbGF0aW9uRXJyKSB7XG4gICAgICAvLyBFc2NhbGF0aW9uIG1vZHVsZSB1bmF2YWlsYWJsZSBvciB0aHJldyBcdTIwMTQgbG9nIGFuZCBwcm9jZWVkLlxuICAgICAgbG9nV2FybmluZyhcInByb21wdFwiLCBgZXNjYWxhdGlvbiBvdmVycmlkZSBpbmplY3Rpb24gZmFpbGVkOiAkeyhlc2NhbGF0aW9uRXJyIGFzIEVycm9yKS5tZXNzYWdlfWApO1xuICAgIH1cbiAgfVxuXG4gIC8vIFRhc2stc2NvcGVkIGdhdGVzIG93bmVkIGJ5IGV4ZWN1dGUtdGFzayAoUTUvUTYvUTcpLiBQdWxsIG9ubHkgdGhlXG4gIC8vIGdhdGVzIHRoYXQgcGxhbi1zbGljZSBhY3R1YWxseSBzZWVkZWQgZm9yIHRoaXMgdGFzayBcdTIwMTQgdGFza3Mgd2l0aCBub1xuICAvLyBleHRlcm5hbCBkZXBlbmRlbmNpZXMgbGVnaXRpbWF0ZWx5IHNraXAgUTUsIHRhc2tzIHdpdGggbm8gcnVudGltZVxuICAvLyBsb2FkIGRpbWVuc2lvbiBza2lwIFE2LCBldGMuXG4gIGNvbnN0IGV0UGVuZGluZyA9IGdldFBlbmRpbmdHYXRlc0ZvclR1cm4obWlkLCBzaWQsIFwiZXhlY3V0ZS10YXNrXCIsIHRpZCk7XG4gIGFzc2VydEdhdGVDb3ZlcmFnZShldFBlbmRpbmcsIFwiZXhlY3V0ZS10YXNrXCIsIHsgcmVxdWlyZUFsbDogZmFsc2UgfSk7XG4gIGNvbnN0IGdhdGVzVG9DbG9zZSA9IHJlbmRlckdhdGVzVG9DbG9zZUJsb2NrKFxuICAgIGdldEdhdGVzRm9yVHVybihcImV4ZWN1dGUtdGFza1wiKSxcbiAgICB7IHBlbmRpbmc6IG5ldyBTZXQoZXRQZW5kaW5nLm1hcCgoZykgPT4gZy5nYXRlX2lkKSksIGFsbG93T21pdDogdHJ1ZSB9LFxuICApO1xuICBwaGFzZUFuY2hvclNlY3Rpb24gPSBwcmVwZW5kQ29udGV4dE1vZGVUb0Jsb2NrKFwiZXhlY3V0ZS10YXNrXCIsIGJhc2UsIHBoYXNlQW5jaG9yU2VjdGlvbiwgb3B0cy5jb250ZXh0TW9kZVJlbmRlck1vZGUpO1xuXG4gIHJldHVybiBsb2FkUHJvbXB0KFwiZXhlY3V0ZS10YXNrXCIsIHtcbiAgICBvdmVycmlkZXNTZWN0aW9uLFxuICAgIHJ1bnRpbWVDb250ZXh0LFxuICAgIHBoYXNlQW5jaG9yU2VjdGlvbixcbiAgICB3b3JraW5nRGlyZWN0b3J5OiBiYXNlLFxuICAgIG1pbGVzdG9uZUlkOiBtaWQsIHNsaWNlSWQ6IHNpZCwgc2xpY2VUaXRsZTogc1RpdGxlLCB0YXNrSWQ6IHRpZCwgdGFza1RpdGxlOiB0VGl0bGUsXG4gICAgcGxhblBhdGg6IGpvaW4oYmFzZSwgcmVsU2xpY2VGaWxlKGJhc2UsIG1pZCwgc2lkLCBcIlBMQU5cIikpLFxuICAgIHNsaWNlUGF0aDogcmVsU2xpY2VQYXRoKGJhc2UsIG1pZCwgc2lkKSxcbiAgICB0YXNrUGxhblBhdGg6IHRhc2tQbGFuUmVsUGF0aCxcbiAgICB0YXNrUGxhbklubGluZSxcbiAgICBzbGljZVBsYW5FeGNlcnB0LFxuICAgIGNhcnJ5Rm9yd2FyZFNlY3Rpb246IGZpbmFsQ2FycnlGb3J3YXJkLFxuICAgIHJlc3VtZVNlY3Rpb24sXG4gICAgcHJpb3JUYXNrTGluZXM6IHByaW9yTGluZXMsXG4gICAgdGFza1N1bW1hcnlQYXRoLFxuICAgIGlubGluZWRUZW1wbGF0ZXMsXG4gICAgdmVyaWZpY2F0aW9uQnVkZ2V0LFxuICAgIGdhdGVzVG9DbG9zZSxcbiAgICBza2lsbEFjdGl2YXRpb246IGJ1aWxkU2tpbGxBY3RpdmF0aW9uQmxvY2soe1xuICAgICAgYmFzZSxcbiAgICAgIG1pbGVzdG9uZUlkOiBtaWQsXG4gICAgICBzbGljZUlkOiBzaWQsXG4gICAgICBzbGljZVRpdGxlOiBzVGl0bGUsXG4gICAgICB0YXNrSWQ6IHRpZCxcbiAgICAgIHRhc2tUaXRsZTogdFRpdGxlLFxuICAgICAgdGFza1BsYW5Db250ZW50LFxuICAgICAgZXh0cmFDb250ZXh0OiBbdGFza1BsYW5JbmxpbmUsIHNsaWNlUGxhbkV4Y2VycHQsIGZpbmFsQ2FycnlGb3J3YXJkLCByZXN1bWVTZWN0aW9uXSxcbiAgICAgIHVuaXRUeXBlOiBcImV4ZWN1dGUtdGFza1wiLFxuICAgIH0pLFxuICB9KTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGJ1aWxkQ29tcGxldGVTbGljZVByb21wdChcbiAgbWlkOiBzdHJpbmcsIG1pZFRpdGxlOiBzdHJpbmcsIHNpZDogc3RyaW5nLCBzVGl0bGU6IHN0cmluZywgYmFzZTogc3RyaW5nLCBsZXZlbD86IElubGluZUxldmVsLFxuKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgY29uc3QgaW5saW5lTGV2ZWwgPSBsZXZlbCA/PyByZXNvbHZlSW5saW5lTGV2ZWwoKTtcblxuICAvLyAjNDc4MiBwaGFzZSAzOiBjb21wbGV0ZS1zbGljZSBtaWdyYXRlZCB0aHJvdWdoIGNvbXBvc2VyLiBNYW5pZmVzdFxuICAvLyBkZWNsYXJlcyBbcm9hZG1hcCwgc2xpY2UtY29udGV4dCwgc2xpY2UtcGxhbiwgcmVxdWlyZW1lbnRzLFxuICAvLyBwcmlvci10YXNrLXN1bW1hcmllcywgdGVtcGxhdGVzXS4gT3ZlcnJpZGVzIHByZXBlbmQgYW5kIGtub3dsZWRnZVxuICAvLyBzcGxpY2Ugc3RheSBpbXBlcmF0aXZlIFx1MjAxNCB0aGV5IG5lZWQgdGhlIGNvbXBvc2VyIHYyIGNvbnRyYWN0XG4gIC8vIChjb21wdXRlZCArIHByZXBlbmQgYmxvY2tzOyBzZWUgUkZDICM0OTI0KS5cbiAgY29uc3QgcmVzb2x2ZUFydGlmYWN0OiBBcnRpZmFjdFJlc29sdmVyID0gYXN5bmMgKGtleSkgPT4ge1xuICAgIHN3aXRjaCAoa2V5KSB7XG4gICAgICBjYXNlIFwicm9hZG1hcFwiOiB7XG4gICAgICAgIGNvbnN0IHAgPSByZXNvbHZlTWlsZXN0b25lRmlsZShiYXNlLCBtaWQsIFwiUk9BRE1BUFwiKTtcbiAgICAgICAgY29uc3QgciA9IHJlbE1pbGVzdG9uZUZpbGUoYmFzZSwgbWlkLCBcIlJPQURNQVBcIik7XG4gICAgICAgIHJldHVybiBhd2FpdCBpbmxpbmVGaWxlKHAsIHIsIFwiTWlsZXN0b25lIFJvYWRtYXBcIik7XG4gICAgICB9XG4gICAgICBjYXNlIFwic2xpY2UtY29udGV4dFwiOiB7XG4gICAgICAgIGNvbnN0IHAgPSByZXNvbHZlU2xpY2VGaWxlKGJhc2UsIG1pZCwgc2lkLCBcIkNPTlRFWFRcIik7XG4gICAgICAgIGNvbnN0IHIgPSByZWxTbGljZUZpbGUoYmFzZSwgbWlkLCBzaWQsIFwiQ09OVEVYVFwiKTtcbiAgICAgICAgcmV0dXJuIGF3YWl0IGlubGluZUZpbGVPcHRpb25hbChwLCByLCBcIlNsaWNlIENvbnRleHQgKGZyb20gZGlzY3Vzc2lvbilcIik7XG4gICAgICB9XG4gICAgICBjYXNlIFwic2xpY2UtcGxhblwiOiB7XG4gICAgICAgIGNvbnN0IHAgPSByZXNvbHZlU2xpY2VGaWxlKGJhc2UsIG1pZCwgc2lkLCBcIlBMQU5cIik7XG4gICAgICAgIGNvbnN0IHIgPSByZWxTbGljZUZpbGUoYmFzZSwgbWlkLCBzaWQsIFwiUExBTlwiKTtcbiAgICAgICAgcmV0dXJuIGF3YWl0IGlubGluZUZpbGUocCwgciwgXCJTbGljZSBQbGFuXCIpO1xuICAgICAgfVxuICAgICAgY2FzZSBcInJlcXVpcmVtZW50c1wiOlxuICAgICAgICBpZiAoaW5saW5lTGV2ZWwgPT09IFwibWluaW1hbFwiKSByZXR1cm4gbnVsbDtcbiAgICAgICAgcmV0dXJuIGF3YWl0IGlubGluZVJlcXVpcmVtZW50c0Zyb21EYihiYXNlLCBtaWQsIHNpZCwgaW5saW5lTGV2ZWwpO1xuICAgICAgY2FzZSBcInByaW9yLXRhc2stc3VtbWFyaWVzXCI6IHtcbiAgICAgICAgY29uc3QgdERpciA9IHJlc29sdmVUYXNrc0RpcihiYXNlLCBtaWQsIHNpZCk7XG4gICAgICAgIGlmICghdERpcikgcmV0dXJuIG51bGw7XG4gICAgICAgIGNvbnN0IHN1bW1hcnlGaWxlcyA9IHJlc29sdmVUYXNrRmlsZXModERpciwgXCJTVU1NQVJZXCIpLnNvcnQoKTtcbiAgICAgICAgY29uc3Qgc1JlbCA9IHJlbFNsaWNlUGF0aChiYXNlLCBtaWQsIHNpZCk7XG4gICAgICAgIGNvbnN0IGJsb2Nrczogc3RyaW5nW10gPSBbXTtcbiAgICAgICAgZm9yIChjb25zdCBmaWxlIG9mIHN1bW1hcnlGaWxlcykge1xuICAgICAgICAgIGNvbnN0IGFic1BhdGggPSBqb2luKHREaXIsIGZpbGUpO1xuICAgICAgICAgIGNvbnN0IHJlbFBhdGggPSBgJHtzUmVsfS90YXNrcy8ke2ZpbGV9YDtcbiAgICAgICAgICBjb25zdCB0YXNrSWQgPSBmaWxlLnJlcGxhY2UoLy1TVU1NQVJZXFwubWQkL2ksIFwiXCIpO1xuICAgICAgICAgIGJsb2Nrcy5wdXNoKGF3YWl0IGJ1aWxkVGFza1N1bW1hcnlFeGNlcnB0KGFic1BhdGgsIHJlbFBhdGgsIHRhc2tJZCkpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBibG9ja3MubGVuZ3RoID4gMCA/IGJsb2Nrcy5qb2luKFwiXFxuXFxuLS0tXFxuXFxuXCIpIDogbnVsbDtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ0ZW1wbGF0ZXNcIjoge1xuICAgICAgICBjb25zdCBwYXJ0cyA9IFtpbmxpbmVMZXZlbCA9PT0gXCJtaW5pbWFsXCJcbiAgICAgICAgICA/IGlubGluZUNvbXBhY3RUZW1wbGF0ZShcInNsaWNlLXN1bW1hcnlcIiwgXCJTbGljZSBTdW1tYXJ5XCIpXG4gICAgICAgICAgOiBpbmxpbmVUZW1wbGF0ZShcInNsaWNlLXN1bW1hcnlcIiwgXCJTbGljZSBTdW1tYXJ5XCIpXTtcbiAgICAgICAgaWYgKGlubGluZUxldmVsICE9PSBcIm1pbmltYWxcIikge1xuICAgICAgICAgIHBhcnRzLnB1c2goaW5saW5lVGVtcGxhdGUoXCJ1YXRcIiwgXCJVQVRcIikpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBwYXJ0cy5qb2luKFwiXFxuXFxuLS0tXFxuXFxuXCIpO1xuICAgICAgfVxuICAgICAgZGVmYXVsdDpcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IGNvbXBvc2VkID0gYXdhaXQgY29tcG9zZUlubGluZWRDb250ZXh0KFwiY29tcGxldGUtc2xpY2VcIiwgcmVzb2x2ZUFydGlmYWN0KTtcblxuICAvLyBLbm93bGVkZ2Ugc3BsaWNlcyBpbiBiZXR3ZWVuIHJlcXVpcmVtZW50cyBhbmQgcHJpb3ItdGFzay1zdW1tYXJpZXNcbiAgLy8gc28gb3ZlcmFsbCBvcmRlciBtYXRjaGVzIHByZS1taWdyYXRpb246IHJvYWRtYXAgXHUyMTkyIHNsaWNlLWNvbnRleHQgXHUyMTkyXG4gIC8vIHNsaWNlLXBsYW4gXHUyMTkyIHJlcXVpcmVtZW50cyBcdTIxOTIgS05PV0xFREdFIFx1MjE5MiB0YXNrIHN1bW1hcmllcyBcdTIxOTIgdGVtcGxhdGVzLlxuICBjb25zdCBrbm93bGVkZ2VJbmxpbmVDUyA9IGF3YWl0IGlubGluZUtub3dsZWRnZUJ1ZGdldGVkKFxuICAgIGJhc2UsXG4gICAgWy4uLmV4dHJhY3RLZXl3b3JkcyhtaWRUaXRsZSksIC4uLmV4dHJhY3RLZXl3b3JkcyhzVGl0bGUpXSxcbiAgKTtcblxuICBsZXQgYm9keSA9IGNvbXBvc2VkO1xuICBpZiAoa25vd2xlZGdlSW5saW5lQ1MgJiYgYm9keSkge1xuICAgIC8vIFNwbGljZSBrbm93bGVkZ2UgcmlnaHQgYmVmb3JlIHRoZSBmaXJzdCBcIiMjIyBUYXNrIFN1bW1hcnk6XCIgYmxvY2tcbiAgICAvLyB0byBwcmVzZXJ2ZSBwcmUtbWlncmF0aW9uIG9yZGVyaW5nLiBJZiBubyB0YXNrIHN1bW1hcmllcyBleGlzdCxcbiAgICAvLyBzcGxpY2UgYmVmb3JlIHRoZSB0ZW1wbGF0ZXMgYmxvY2sgKHdoaWNoIGlubGluZVRlbXBsYXRlIGVtaXRzIGFzXG4gICAgLy8gXCIjIyMgT3V0cHV0IFRlbXBsYXRlOiBTbGljZSBTdW1tYXJ5XCIpLlxuICAgIGNvbnN0IHRhc2tJZHggPSBib2R5LmluZGV4T2YoXCIjIyMgVGFzayBTdW1tYXJ5OlwiKTtcbiAgICBjb25zdCB0ZW1wbGF0ZXNJZHggPSBib2R5Lmxhc3RJbmRleE9mKFwiIyMjIE91dHB1dCBUZW1wbGF0ZTogU2xpY2UgU3VtbWFyeVwiKTtcbiAgICBjb25zdCBzcGxpY2VJZHggPSB0YXNrSWR4ID4gLTEgPyB0YXNrSWR4IDogdGVtcGxhdGVzSWR4O1xuICAgIGlmIChzcGxpY2VJZHggPiAwKSB7XG4gICAgICBjb25zdCBiZWZvcmUgPSBib2R5LnNsaWNlKDAsIHNwbGljZUlkeCkucmVwbGFjZSgvXFxuXFxuLS0tXFxuXFxuJC8sIFwiXCIpO1xuICAgICAgY29uc3QgYWZ0ZXIgPSBib2R5LnNsaWNlKHNwbGljZUlkeCk7XG4gICAgICBib2R5ID0gW2JlZm9yZSwga25vd2xlZGdlSW5saW5lQ1MsIGFmdGVyXS5qb2luKFwiXFxuXFxuLS0tXFxuXFxuXCIpO1xuICAgIH0gZWxzZSB7XG4gICAgICBib2R5ID0gYCR7Ym9keX1cXG5cXG4tLS1cXG5cXG4ke2tub3dsZWRnZUlubGluZUNTfWA7XG4gICAgfVxuICB9XG5cbiAgLy8gT3ZlcnJpZGVzIHNlY3Rpb24gcHJlcGVuZHMgdG8gdGhlIHRvcCBvZiB0aGUgaW5saW5lZCBjb250ZXh0IFx1MjAxNFxuICAvLyBzdGFuZGFyZCBwYXR0ZXJuIGZvciBzbGljZS1sZXZlbCBidWlsZGVycyAodW50aWwgY29tcG9zZXIgdjIgbGFuZHNcbiAgLy8gdGhlIHByZXBlbmQgY29udHJhY3QpLlxuICBjb25zdCBjb21wbGV0ZUFjdGl2ZU92ZXJyaWRlcyA9IGF3YWl0IGxvYWRBY3RpdmVPdmVycmlkZXMoYmFzZSk7XG4gIGNvbnN0IGNvbXBsZXRlT3ZlcnJpZGVzSW5saW5lID0gZm9ybWF0T3ZlcnJpZGVzU2VjdGlvbihjb21wbGV0ZUFjdGl2ZU92ZXJyaWRlcyk7XG4gIGNvbnN0IGZpbmFsQm9keSA9IGNvbXBsZXRlT3ZlcnJpZGVzSW5saW5lXG4gICAgPyBgJHtjb21wbGV0ZU92ZXJyaWRlc0lubGluZX1cXG5cXG4tLS1cXG5cXG4ke2JvZHl9YFxuICAgIDogYm9keTtcblxuICBjb25zdCBpbmxpbmVkQ29udGV4dCA9IHByZXBlbmRDb250ZXh0TW9kZVRvQmxvY2soXG4gICAgXCJjb21wbGV0ZS1zbGljZVwiLFxuICAgIGJhc2UsXG4gICAgY2FwUHJlYW1ibGUoYCMjIElubGluZWQgQ29udGV4dCAocHJlbG9hZGVkIFx1MjAxNCBkbyBub3QgcmUtcmVhZCB0aGVzZSBmaWxlcylcXG5cXG4ke2ZpbmFsQm9keX1gKSxcbiAgKTtcbiAgY29uc3Qgcm9hZG1hcFJlbCA9IHJlbE1pbGVzdG9uZUZpbGUoYmFzZSwgbWlkLCBcIlJPQURNQVBcIik7XG5cbiAgY29uc3Qgc2xpY2VSZWwgPSByZWxTbGljZVBhdGgoYmFzZSwgbWlkLCBzaWQpO1xuICBjb25zdCBzbGljZVN1bW1hcnlQYXRoID0gam9pbihiYXNlLCBgJHtzbGljZVJlbH0vJHtzaWR9LVNVTU1BUlkubWRgKTtcbiAgY29uc3Qgc2xpY2VVYXRQYXRoID0gam9pbihiYXNlLCBgJHtzbGljZVJlbH0vJHtzaWR9LVVBVC5tZGApO1xuXG4gIC8vIEdhdGVzIG93bmVkIGJ5IGNvbXBsZXRlLXNsaWNlIChlLmcuIFE4KS4gUHVsbCBmcm9tIHRoZSBEQiBzbyB0aGVcbiAgLy8gcHJvbXB0IG9ubHkgcHJvbXB0cyBmb3IgZ2F0ZXMgdGhlIHBsYW4gYWN0dWFsbHkgc2VlZGVkLiBUaGUgdG9vbFxuICAvLyBoYW5kbGVyIGNsb3NlcyBlYWNoIGdhdGUgYmFzZWQgb24gdGhlIFNVTU1BUlkubWQgc2VjdGlvbiBjb250ZW50XG4gIC8vIGFmdGVyIHRoZSBhc3Npc3RhbnQgY2FsbHMgZ3NkX2NvbXBsZXRlX3NsaWNlLlxuICBjb25zdCBjc1BlbmRpbmcgPSBnZXRQZW5kaW5nR2F0ZXNGb3JUdXJuKG1pZCwgc2lkLCBcImNvbXBsZXRlLXNsaWNlXCIpO1xuICAvLyBjb3ZlcmFnZSBjaGVjazogZXZlcnkgcGVuZGluZyByb3cgbXVzdCBiZSBvd25lZCBieSBjb21wbGV0ZS1zbGljZS5cbiAgLy8gcmVxdWlyZUFsbDpmYWxzZSBiZWNhdXNlIGEgc2xpY2UgbWF5IGhhdmUgYWxyZWFkeSBjbG9zZWQgc29tZSBnYXRlcy5cbiAgYXNzZXJ0R2F0ZUNvdmVyYWdlKGNzUGVuZGluZywgXCJjb21wbGV0ZS1zbGljZVwiLCB7IHJlcXVpcmVBbGw6IGZhbHNlIH0pO1xuICBjb25zdCBnYXRlc1RvQ2xvc2UgPSByZW5kZXJHYXRlc1RvQ2xvc2VCbG9jayhcbiAgICBnZXRHYXRlc0ZvclR1cm4oXCJjb21wbGV0ZS1zbGljZVwiKSxcbiAgICB7IHBlbmRpbmc6IG5ldyBTZXQoY3NQZW5kaW5nLm1hcCgoZykgPT4gZy5nYXRlX2lkKSksIGFsbG93T21pdDogdHJ1ZSB9LFxuICApO1xuXG4gIHJldHVybiBsb2FkUHJvbXB0KFwiY29tcGxldGUtc2xpY2VcIiwge1xuICAgIHdvcmtpbmdEaXJlY3Rvcnk6IGJhc2UsXG4gICAgbWlsZXN0b25lSWQ6IG1pZCwgc2xpY2VJZDogc2lkLCBzbGljZVRpdGxlOiBzVGl0bGUsXG4gICAgc2xpY2VQYXRoOiBzbGljZVJlbCxcbiAgICByb2FkbWFwUGF0aDogam9pbihiYXNlLCByb2FkbWFwUmVsKSxcbiAgICBpbmxpbmVkQ29udGV4dCxcbiAgICBzbGljZVN1bW1hcnlQYXRoLFxuICAgIHNsaWNlVWF0UGF0aCxcbiAgICBnYXRlc1RvQ2xvc2UsXG4gIH0pO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gYnVpbGRDb21wbGV0ZU1pbGVzdG9uZVByb21wdChcbiAgbWlkOiBzdHJpbmcsIG1pZFRpdGxlOiBzdHJpbmcsIGJhc2U6IHN0cmluZywgbGV2ZWw/OiBJbmxpbmVMZXZlbCxcbik6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IGlubGluZUxldmVsID0gbGV2ZWwgPz8gcmVzb2x2ZUlubGluZUxldmVsKCk7XG4gIGNvbnN0IHJvYWRtYXBQYXRoID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZSwgbWlkLCBcIlJPQURNQVBcIik7XG4gIGNvbnN0IHJvYWRtYXBSZWwgPSByZWxNaWxlc3RvbmVGaWxlKGJhc2UsIG1pZCwgXCJST0FETUFQXCIpO1xuICBjb25zdCB2YWxpZGF0aW9uUGF0aCA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2UsIG1pZCwgXCJWQUxJREFUSU9OXCIpO1xuICBjb25zdCB2YWxpZGF0aW9uUmVsID0gcmVsTWlsZXN0b25lRmlsZShiYXNlLCBtaWQsIFwiVkFMSURBVElPTlwiKTtcbiAgY29uc3QgdmFsaWRhdGlvbkNvbnRlbnQgPSB2YWxpZGF0aW9uUGF0aCA/IGF3YWl0IGxvYWRGaWxlKHZhbGlkYXRpb25QYXRoKSA6IG51bGw7XG5cbiAgY29uc3QgaW5saW5lZDogc3RyaW5nW10gPSBbXTtcbiAgaW5saW5lZC5wdXNoKGF3YWl0IGlubGluZUZpbGUocm9hZG1hcFBhdGgsIHJvYWRtYXBSZWwsIFwiTWlsZXN0b25lIFJvYWRtYXBcIikpO1xuXG4gIC8vIElubGluZSBhbGwgc2xpY2Ugc3VtbWFyaWVzIChkZWR1cGxpY2F0ZWQgYnkgc2xpY2UgSUQpXG4gIGxldCBzbGljZUlkczogc3RyaW5nW10gPSBbXTtcbiAgdHJ5IHtcbiAgICBjb25zdCB7IGlzRGJBdmFpbGFibGUsIGdldE1pbGVzdG9uZVNsaWNlcyB9ID0gYXdhaXQgaW1wb3J0KFwiLi9nc2QtZGIuanNcIik7XG4gICAgaWYgKGlzRGJBdmFpbGFibGUoKSkge1xuICAgICAgc2xpY2VJZHMgPSBnZXRNaWxlc3RvbmVTbGljZXMobWlkKVxuICAgICAgICAuZmlsdGVyKHMgPT4gcy5zdGF0dXMgIT09IFwic2tpcHBlZFwiKVxuICAgICAgICAubWFwKHMgPT4gcy5pZCk7XG4gICAgfVxuICB9IGNhdGNoIChlcnIpIHtcbiAgICBsb2dXYXJuaW5nKFwicHJvbXB0XCIsIGBidWlsZENvbXBsZXRlTWlsZXN0b25lUHJvbXB0IERCIGxvb2t1cCBmYWlsZWQ6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWApO1xuICB9XG4gIC8vIEZpbGUtYmFzZWQgZmFsbGJhY2s6IHBhcnNlIHJvYWRtYXAgZm9yIHNsaWNlIElEcyB3aGVuIERCIGhhcyBubyBkYXRhXG4gIGlmIChzbGljZUlkcy5sZW5ndGggPT09IDAgJiYgcm9hZG1hcFBhdGgpIHtcbiAgICBjb25zdCByb2FkbWFwQ29udGVudCA9IGF3YWl0IGxvYWRGaWxlKHJvYWRtYXBQYXRoKTtcbiAgICBpZiAocm9hZG1hcENvbnRlbnQpIHtcbiAgICAgIHNsaWNlSWRzID0gcGFyc2VSb2FkbWFwKHJvYWRtYXBDb250ZW50KS5zbGljZXMubWFwKHMgPT4gcy5pZCk7XG4gICAgfVxuICB9XG4gIGNvbnN0IHNlZW5TbGljZXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgY29uc3Qgc3VtbWFyeVJlbFBhdGhzOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IHNpZCBvZiBzbGljZUlkcykge1xuICAgIGlmIChzZWVuU2xpY2VzLmhhcyhzaWQpKSBjb250aW51ZTtcbiAgICBzZWVuU2xpY2VzLmFkZChzaWQpO1xuICAgIGNvbnN0IHN1bW1hcnlQYXRoID0gcmVzb2x2ZVNsaWNlRmlsZShiYXNlLCBtaWQsIHNpZCwgXCJTVU1NQVJZXCIpO1xuICAgIGNvbnN0IHN1bW1hcnlSZWwgPSByZWxTbGljZUZpbGUoYmFzZSwgbWlkLCBzaWQsIFwiU1VNTUFSWVwiKTtcbiAgICBzdW1tYXJ5UmVsUGF0aHMucHVzaChzdW1tYXJ5UmVsKTtcbiAgICAvLyBDb21wYWN0IGV4Y2VycHQgaW5zdGVhZCBvZiBmdWxsIGlubGluZSAoIzQ3ODApLiBDbG9zZXIgUmVhZHMgdGhlXG4gICAgLy8gZnVsbCBmaWxlIG9uLWRlbWFuZCB3aGVuIHN5bnRoZXNpemluZyBMRUFSTklOR1MgbmFycmF0aXZlLlxuICAgIGlubGluZWQucHVzaChhd2FpdCBidWlsZFNsaWNlU3VtbWFyeUV4Y2VycHQoc3VtbWFyeVBhdGgsIHN1bW1hcnlSZWwsIHNpZCkpO1xuICB9XG4gIGlmIChzdW1tYXJ5UmVsUGF0aHMubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IHBhdGhMaXN0ID0gc3VtbWFyeVJlbFBhdGhzLm1hcChwID0+IGAtIFxcYCR7cH1cXGBgKS5qb2luKFwiXFxuXCIpO1xuICAgIGlubGluZWQucHVzaChcbiAgICAgIGAjIyMgT24tZGVtYW5kIFNsaWNlIFN1bW1hcmllc1xcblxcbkV4Y2VycHRlZCBhYm92ZS4gUmVhZCB0aGUgZnVsbCBmaWxlIGZvciBhbnkgc2xpY2Ugd2hlbiB0aGUgZXhjZXJwdCdzIHNlY3Rpb24gaGVhZHMgZG9uJ3QgY2FycnkgZW5vdWdoIG5hcnJhdGl2ZSBmb3IgdGhlIG1pbGVzdG9uZSBzdW1tYXJ5IHlvdSdyZSBkcmFmdGluZzpcXG5cXG4ke3BhdGhMaXN0fWAsXG4gICAgKTtcbiAgfVxuICBjb25zdCB2YWxpZGF0aW9uQ29udGV4dCA9IFtcbiAgICBmb3JtYXRDbG9zZW91dFJldmlld0luc3RydWN0aW9ucyh2YWxpZGF0aW9uQ29udGVudCwgdmFsaWRhdGlvblJlbCwgW3ZhbGlkYXRpb25SZWwsIHJvYWRtYXBSZWwsIC4uLnN1bW1hcnlSZWxQYXRoc10pLFxuICBdO1xuICBpZiAodmFsaWRhdGlvbkNvbnRlbnQpIHtcbiAgICB2YWxpZGF0aW9uQ29udGV4dC5wdXNoKGAjIyMgTWlsZXN0b25lIFZhbGlkYXRpb25cXG5Tb3VyY2U6IFxcYCR7dmFsaWRhdGlvblJlbH1cXGBcXG5cXG4ke3ZhbGlkYXRpb25Db250ZW50LnRyaW0oKX1gKTtcbiAgfVxuICBpbmxpbmVkLnVuc2hpZnQoLi4udmFsaWRhdGlvbkNvbnRleHQpO1xuXG4gIC8vIElubGluZSByb290IEdTRCBmaWxlcyAoc2tpcCBmb3IgbWluaW1hbCBcdTIwMTQgY29tcGxldGlvbiBjYW4gcmVhZCB0aGVzZSBpZiBuZWVkZWQpXG4gIGlmIChpbmxpbmVMZXZlbCAhPT0gXCJtaW5pbWFsXCIpIHtcbiAgICBjb25zdCByZXF1aXJlbWVudHNJbmxpbmUgPSBhd2FpdCBpbmxpbmVSZXF1aXJlbWVudHNGcm9tRGIoYmFzZSwgbWlkLCB1bmRlZmluZWQsIGlubGluZUxldmVsKTtcbiAgICBpZiAocmVxdWlyZW1lbnRzSW5saW5lKSBpbmxpbmVkLnB1c2gocmVxdWlyZW1lbnRzSW5saW5lKTtcbiAgICBjb25zdCBkZWNpc2lvbnNJbmxpbmUgPSBhd2FpdCBpbmxpbmVEZWNpc2lvbnNGcm9tRGIoYmFzZSwgbWlkLCB1bmRlZmluZWQsIGlubGluZUxldmVsKTtcbiAgICBpZiAoZGVjaXNpb25zSW5saW5lKSBpbmxpbmVkLnB1c2goZGVjaXNpb25zSW5saW5lKTtcbiAgICBjb25zdCBwcm9qZWN0SW5saW5lID0gYXdhaXQgaW5saW5lUHJvamVjdEZyb21EYihiYXNlKTtcbiAgICBpZiAocHJvamVjdElubGluZSkgaW5saW5lZC5wdXNoKHByb2plY3RJbmxpbmUpO1xuICB9XG4gIC8vIFNjb3BlZCArIGJ1ZGdldGVkIFx1MjAxNCBzZWUgaXNzdWUgIzQ3MTlcbiAgY29uc3Qga25vd2xlZGdlSW5saW5lQ00gPSBhd2FpdCBpbmxpbmVLbm93bGVkZ2VCdWRnZXRlZChiYXNlLCBleHRyYWN0S2V5d29yZHMobWlkVGl0bGUpKTtcbiAgaWYgKGtub3dsZWRnZUlubGluZUNNKSBpbmxpbmVkLnB1c2goa25vd2xlZGdlSW5saW5lQ00pO1xuICAvLyBJbmxpbmUgbWlsZXN0b25lIGNvbnRleHQgZmlsZSAobWlsZXN0b25lLWxldmVsLCBub3QgR1NEIHJvb3QpXG4gIGNvbnN0IGNvbnRleHRQYXRoID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZSwgbWlkLCBcIkNPTlRFWFRcIik7XG4gIGNvbnN0IGNvbnRleHRSZWwgPSByZWxNaWxlc3RvbmVGaWxlKGJhc2UsIG1pZCwgXCJDT05URVhUXCIpO1xuICBjb25zdCBjb250ZXh0SW5saW5lID0gYXdhaXQgaW5saW5lRmlsZU9wdGlvbmFsKGNvbnRleHRQYXRoLCBjb250ZXh0UmVsLCBcIk1pbGVzdG9uZSBDb250ZXh0XCIpO1xuICBpZiAoY29udGV4dElubGluZSkgaW5saW5lZC5wdXNoKGNvbnRleHRJbmxpbmUpO1xuICBpbmxpbmVkLnB1c2goaW5saW5lVGVtcGxhdGUoXCJtaWxlc3RvbmUtc3VtbWFyeVwiLCBcIk1pbGVzdG9uZSBTdW1tYXJ5XCIpKTtcblxuICBjb25zdCBpbmxpbmVkQ29udGV4dCA9IHByZXBlbmRDb250ZXh0TW9kZVRvQmxvY2soXG4gICAgXCJjb21wbGV0ZS1taWxlc3RvbmVcIixcbiAgICBiYXNlLFxuICAgIGNhcFByZWFtYmxlKGAjIyBJbmxpbmVkIENvbnRleHQgKHByZWxvYWRlZCBcdTIwMTQgZG8gbm90IHJlLXJlYWQgdGhlc2UgZmlsZXMpXFxuXFxuJHtpbmxpbmVkLmpvaW4oXCJcXG5cXG4tLS1cXG5cXG5cIil9YCksXG4gICk7XG5cbiAgY29uc3QgbWlsZXN0b25lU3VtbWFyeVBhdGggPSBqb2luKGJhc2UsIGAke3JlbE1pbGVzdG9uZVBhdGgoYmFzZSwgbWlkKX0vJHttaWR9LVNVTU1BUlkubWRgKTtcblxuICBjb25zdCBsZWFybmluZ3NSZWxQYXRoID0gam9pbihyZWxNaWxlc3RvbmVQYXRoKGJhc2UsIG1pZCksIGAke21pZH0tTEVBUk5JTkdTLm1kYCk7XG4gIGNvbnN0IGxlYXJuaW5nc0Fic1BhdGggPSBqb2luKGJhc2UsIGxlYXJuaW5nc1JlbFBhdGgpO1xuICBjb25zdCBleHRyYWN0TGVhcm5pbmdzU3RlcHMgPSBidWlsZEV4dHJhY3Rpb25TdGVwc0Jsb2NrKHtcbiAgICBtaWxlc3RvbmVJZDogbWlkLFxuICAgIG91dHB1dFBhdGg6IGxlYXJuaW5nc0Fic1BhdGgsXG4gICAgcmVsYXRpdmVPdXRwdXRQYXRoOiBsZWFybmluZ3NSZWxQYXRoLFxuICB9KTtcblxuICByZXR1cm4gbG9hZFByb21wdChcImNvbXBsZXRlLW1pbGVzdG9uZVwiLCB7XG4gICAgd29ya2luZ0RpcmVjdG9yeTogYmFzZSxcbiAgICBtaWxlc3RvbmVJZDogbWlkLFxuICAgIG1pbGVzdG9uZVRpdGxlOiBtaWRUaXRsZSxcbiAgICByb2FkbWFwUGF0aDogcm9hZG1hcFJlbCxcbiAgICBpbmxpbmVkQ29udGV4dCxcbiAgICBtaWxlc3RvbmVTdW1tYXJ5UGF0aCxcbiAgICBleHRyYWN0TGVhcm5pbmdzU3RlcHMsXG4gICAgc2tpbGxBY3RpdmF0aW9uOiBidWlsZFNraWxsQWN0aXZhdGlvbkJsb2NrKHtcbiAgICAgIGJhc2UsXG4gICAgICBtaWxlc3RvbmVJZDogbWlkLFxuICAgICAgbWlsZXN0b25lVGl0bGU6IG1pZFRpdGxlLFxuICAgICAgZXh0cmFDb250ZXh0OiBbaW5saW5lZENvbnRleHRdLFxuICAgICAgdW5pdFR5cGU6IFwiY29tcGxldGUtbWlsZXN0b25lXCIsXG4gICAgfSksXG4gIH0pO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gYnVpbGRWYWxpZGF0ZU1pbGVzdG9uZVByb21wdChcbiAgbWlkOiBzdHJpbmcsIG1pZFRpdGxlOiBzdHJpbmcsIGJhc2U6IHN0cmluZywgbGV2ZWw/OiBJbmxpbmVMZXZlbCxcbik6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IGlubGluZUxldmVsID0gbGV2ZWwgPz8gcmVzb2x2ZUlubGluZUxldmVsKCk7XG4gIGNvbnN0IHJvYWRtYXBQYXRoID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZSwgbWlkLCBcIlJPQURNQVBcIik7XG4gIGNvbnN0IHJvYWRtYXBSZWwgPSByZWxNaWxlc3RvbmVGaWxlKGJhc2UsIG1pZCwgXCJST0FETUFQXCIpO1xuXG4gIGNvbnN0IGlubGluZWQ6IHN0cmluZ1tdID0gW107XG4gIGlubGluZWQucHVzaChhd2FpdCBpbmxpbmVGaWxlKHJvYWRtYXBQYXRoLCByb2FkbWFwUmVsLCBcIk1pbGVzdG9uZSBSb2FkbWFwXCIpKTtcblxuICAvLyBJbmxpbmUgdmVyaWZpY2F0aW9uIGNsYXNzZXMgZnJvbSBwbGFubmluZyAoaWYgYXZhaWxhYmxlIGluIERCKVxuICB0cnkge1xuICAgIGNvbnN0IHsgaXNEYkF2YWlsYWJsZSwgZ2V0TWlsZXN0b25lIH0gPSBhd2FpdCBpbXBvcnQoXCIuL2dzZC1kYi5qc1wiKTtcbiAgICBpZiAoaXNEYkF2YWlsYWJsZSgpKSB7XG4gICAgICBjb25zdCBtaWxlc3RvbmUgPSBnZXRNaWxlc3RvbmUobWlkKTtcbiAgICAgIGlmIChtaWxlc3RvbmUpIHtcbiAgICAgICAgY29uc3QgY2xhc3Nlczogc3RyaW5nW10gPSBbXTtcbiAgICAgICAgaWYgKG1pbGVzdG9uZS52ZXJpZmljYXRpb25fY29udHJhY3QpIGNsYXNzZXMucHVzaChgLSAqKkNvbnRyYWN0OioqICR7bWlsZXN0b25lLnZlcmlmaWNhdGlvbl9jb250cmFjdH1gKTtcbiAgICAgICAgaWYgKG1pbGVzdG9uZS52ZXJpZmljYXRpb25faW50ZWdyYXRpb24pIGNsYXNzZXMucHVzaChgLSAqKkludGVncmF0aW9uOioqICR7bWlsZXN0b25lLnZlcmlmaWNhdGlvbl9pbnRlZ3JhdGlvbn1gKTtcbiAgICAgICAgaWYgKG1pbGVzdG9uZS52ZXJpZmljYXRpb25fb3BlcmF0aW9uYWwpIGNsYXNzZXMucHVzaChgLSAqKk9wZXJhdGlvbmFsOioqICR7bWlsZXN0b25lLnZlcmlmaWNhdGlvbl9vcGVyYXRpb25hbH1gKTtcbiAgICAgICAgaWYgKG1pbGVzdG9uZS52ZXJpZmljYXRpb25fdWF0KSBjbGFzc2VzLnB1c2goYC0gKipVQVQ6KiogJHttaWxlc3RvbmUudmVyaWZpY2F0aW9uX3VhdH1gKTtcbiAgICAgICAgaWYgKGNsYXNzZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgIGlubGluZWQucHVzaChgIyMjIFZlcmlmaWNhdGlvbiBDbGFzc2VzIChmcm9tIHBsYW5uaW5nKVxcblxcblRoZXNlIHZlcmlmaWNhdGlvbiB0aWVycyB3ZXJlIGRlZmluZWQgZHVyaW5nIG1pbGVzdG9uZSBwbGFubmluZy4gRWFjaCBub24tZW1wdHkgY2xhc3MgbXVzdCBiZSBjaGVja2VkIGZvciBldmlkZW5jZSBkdXJpbmcgdmFsaWRhdGlvbi5cXG5cXG4ke2NsYXNzZXMuam9pbihcIlxcblwiKX1gKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgbG9nV2FybmluZyhcInByb21wdFwiLCBgYnVpbGRWYWxpZGF0ZU1pbGVzdG9uZVByb21wdCB2ZXJpZmljYXRpb24gY2xhc3NlcyBsb29rdXAgZmFpbGVkOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gKTtcbiAgfVxuXG4gIC8vIElubGluZSBhbGwgc2xpY2Ugc3VtbWFyaWVzIGFuZCBhc3Nlc3NtZW50IHJlc3VsdHNcbiAgbGV0IHZhbFNsaWNlSWRzOiBzdHJpbmdbXSA9IFtdO1xuICB0cnkge1xuICAgIGNvbnN0IHsgaXNEYkF2YWlsYWJsZSwgZ2V0TWlsZXN0b25lU2xpY2VzIH0gPSBhd2FpdCBpbXBvcnQoXCIuL2dzZC1kYi5qc1wiKTtcbiAgICBpZiAoaXNEYkF2YWlsYWJsZSgpKSB7XG4gICAgICB2YWxTbGljZUlkcyA9IGdldE1pbGVzdG9uZVNsaWNlcyhtaWQpXG4gICAgICAgIC5maWx0ZXIocyA9PiBzLnN0YXR1cyAhPT0gXCJza2lwcGVkXCIpXG4gICAgICAgIC5tYXAocyA9PiBzLmlkKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGxvZ1dhcm5pbmcoXCJwcm9tcHRcIiwgYGJ1aWxkVmFsaWRhdGVNaWxlc3RvbmVQcm9tcHQgc2xpY2UgSURzIGxvb2t1cCBmYWlsZWQ6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWApO1xuICB9XG4gIC8vIEZpbGUtYmFzZWQgZmFsbGJhY2s6IHBhcnNlIHJvYWRtYXAgZm9yIHNsaWNlIElEcyB3aGVuIERCIGhhcyBubyBkYXRhXG4gIGlmICh2YWxTbGljZUlkcy5sZW5ndGggPT09IDAgJiYgcm9hZG1hcFBhdGgpIHtcbiAgICBjb25zdCByb2FkbWFwQ29udGVudCA9IGF3YWl0IGxvYWRGaWxlKHJvYWRtYXBQYXRoKTtcbiAgICBpZiAocm9hZG1hcENvbnRlbnQpIHtcbiAgICAgIHZhbFNsaWNlSWRzID0gcGFyc2VSb2FkbWFwKHJvYWRtYXBDb250ZW50KS5zbGljZXMubWFwKHMgPT4gcy5pZCk7XG4gICAgfVxuICB9XG4gIGNvbnN0IHNlZW5WYWxTbGljZXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgZm9yIChjb25zdCBzaWQgb2YgdmFsU2xpY2VJZHMpIHtcbiAgICBpZiAoc2VlblZhbFNsaWNlcy5oYXMoc2lkKSkgY29udGludWU7XG4gICAgc2VlblZhbFNsaWNlcy5hZGQoc2lkKTtcbiAgICBjb25zdCBzdW1tYXJ5UGF0aCA9IHJlc29sdmVTbGljZUZpbGUoYmFzZSwgbWlkLCBzaWQsIFwiU1VNTUFSWVwiKTtcbiAgICBjb25zdCBzdW1tYXJ5UmVsID0gcmVsU2xpY2VGaWxlKGJhc2UsIG1pZCwgc2lkLCBcIlNVTU1BUllcIik7XG4gICAgaW5saW5lZC5wdXNoKGF3YWl0IGlubGluZUZpbGUoc3VtbWFyeVBhdGgsIHN1bW1hcnlSZWwsIGAke3NpZH0gU3VtbWFyeWApKTtcblxuICAgIGNvbnN0IGFzc2Vzc21lbnRQYXRoID0gcmVzb2x2ZVNsaWNlRmlsZShiYXNlLCBtaWQsIHNpZCwgXCJBU1NFU1NNRU5UXCIpO1xuICAgIGNvbnN0IGFzc2Vzc21lbnRSZWwgPSByZWxTbGljZUZpbGUoYmFzZSwgbWlkLCBzaWQsIFwiQVNTRVNTTUVOVFwiKTtcbiAgICBjb25zdCBhc3Nlc3NtZW50SW5saW5lID0gYXdhaXQgaW5saW5lRmlsZU9wdGlvbmFsKGFzc2Vzc21lbnRQYXRoLCBhc3Nlc3NtZW50UmVsLCBgJHtzaWR9IEFzc2Vzc21lbnRgKTtcbiAgICBpZiAoYXNzZXNzbWVudElubGluZSkgaW5saW5lZC5wdXNoKGFzc2Vzc21lbnRJbmxpbmUpO1xuICB9XG5cbiAgLy8gQWdncmVnYXRlIHVucmVzb2x2ZWQgZm9sbG93LXVwcyBhbmQga25vd24gbGltaXRhdGlvbnMgYWNyb3NzIHNsaWNlc1xuICBjb25zdCBvdXRzdGFuZGluZ0l0ZW1zOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IHNpZCBvZiB2YWxTbGljZUlkcykge1xuICAgIGNvbnN0IHN1bW1hcnlQYXRoID0gcmVzb2x2ZVNsaWNlRmlsZShiYXNlLCBtaWQsIHNpZCwgXCJTVU1NQVJZXCIpO1xuICAgIGlmICghc3VtbWFyeVBhdGgpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGNvbnRlbnQgPSBhd2FpdCBsb2FkRmlsZShzdW1tYXJ5UGF0aCk7XG4gICAgaWYgKCFjb250ZW50KSBjb250aW51ZTtcbiAgICBjb25zdCBzdW1tYXJ5ID0gcGFyc2VTdW1tYXJ5KGNvbnRlbnQpO1xuICAgIGlmIChzdW1tYXJ5LmZvbGxvd1Vwcykgb3V0c3RhbmRpbmdJdGVtcy5wdXNoKGAtICoqJHtzaWR9IEZvbGxvdy11cHM6KiogJHtzdW1tYXJ5LmZvbGxvd1Vwcy50cmltKCl9YCk7XG4gICAgaWYgKHN1bW1hcnkua25vd25MaW1pdGF0aW9ucykgb3V0c3RhbmRpbmdJdGVtcy5wdXNoKGAtICoqJHtzaWR9IEtub3duIExpbWl0YXRpb25zOioqICR7c3VtbWFyeS5rbm93bkxpbWl0YXRpb25zLnRyaW0oKX1gKTtcbiAgfVxuICBpZiAob3V0c3RhbmRpbmdJdGVtcy5sZW5ndGggPiAwKSB7XG4gICAgaW5saW5lZC5wdXNoKGAjIyMgT3V0c3RhbmRpbmcgSXRlbXMgKGFnZ3JlZ2F0ZWQgZnJvbSBzbGljZSBzdW1tYXJpZXMpXFxuXFxuVGhlc2UgZm9sbG93LXVwcyBhbmQga25vd24gbGltaXRhdGlvbnMgd2VyZSBkb2N1bWVudGVkIGR1cmluZyBzbGljZSBjb21wbGV0aW9uIGJ1dCBoYXZlIG5vdCBiZWVuIHJlc29sdmVkLlxcblxcbiR7b3V0c3RhbmRpbmdJdGVtcy5qb2luKCdcXG4nKX1gKTtcbiAgfVxuXG4gIC8vIElubGluZSBleGlzdGluZyBWQUxJREFUSU9OIGZpbGUgaWYgdGhpcyBpcyBhIHJlLXZhbGlkYXRpb24gcm91bmRcbiAgY29uc3QgdmFsaWRhdGlvblBhdGggPSByZXNvbHZlTWlsZXN0b25lRmlsZShiYXNlLCBtaWQsIFwiVkFMSURBVElPTlwiKTtcbiAgY29uc3QgdmFsaWRhdGlvblJlbCA9IHJlbE1pbGVzdG9uZUZpbGUoYmFzZSwgbWlkLCBcIlZBTElEQVRJT05cIik7XG4gIGNvbnN0IHZhbGlkYXRpb25Db250ZW50ID0gdmFsaWRhdGlvblBhdGggPyBhd2FpdCBsb2FkRmlsZSh2YWxpZGF0aW9uUGF0aCkgOiBudWxsO1xuICBsZXQgcmVtZWRpYXRpb25Sb3VuZCA9IDA7XG4gIGlmICh2YWxpZGF0aW9uQ29udGVudCkge1xuICAgIGNvbnN0IHJvdW5kTWF0Y2ggPSB2YWxpZGF0aW9uQ29udGVudC5tYXRjaCgvcmVtZWRpYXRpb25fcm91bmQ6XFxzKihcXGQrKS8pO1xuICAgIHJlbWVkaWF0aW9uUm91bmQgPSByb3VuZE1hdGNoID8gcGFyc2VJbnQocm91bmRNYXRjaFsxXSwgMTApICsgMSA6IDE7XG4gICAgaW5saW5lZC5wdXNoKGAjIyMgUHJldmlvdXMgVmFsaWRhdGlvbiAocmUtdmFsaWRhdGlvbiByb3VuZCAke3JlbWVkaWF0aW9uUm91bmR9KVxcblNvdXJjZTogXFxgJHt2YWxpZGF0aW9uUmVsfVxcYFxcblxcbiR7dmFsaWRhdGlvbkNvbnRlbnQudHJpbSgpfWApO1xuICB9XG5cbiAgLy8gSW5saW5lIHJvb3QgR1NEIGZpbGVzXG4gIGlmIChpbmxpbmVMZXZlbCAhPT0gXCJtaW5pbWFsXCIpIHtcbiAgICBjb25zdCByZXF1aXJlbWVudHNJbmxpbmUgPSBhd2FpdCBpbmxpbmVSZXF1aXJlbWVudHNGcm9tRGIoYmFzZSwgbWlkLCB1bmRlZmluZWQsIGlubGluZUxldmVsKTtcbiAgICBpZiAocmVxdWlyZW1lbnRzSW5saW5lKSBpbmxpbmVkLnB1c2gocmVxdWlyZW1lbnRzSW5saW5lKTtcbiAgICBjb25zdCBkZWNpc2lvbnNJbmxpbmUgPSBhd2FpdCBpbmxpbmVEZWNpc2lvbnNGcm9tRGIoYmFzZSwgbWlkLCB1bmRlZmluZWQsIGlubGluZUxldmVsKTtcbiAgICBpZiAoZGVjaXNpb25zSW5saW5lKSBpbmxpbmVkLnB1c2goZGVjaXNpb25zSW5saW5lKTtcbiAgICBjb25zdCBwcm9qZWN0SW5saW5lID0gYXdhaXQgaW5saW5lUHJvamVjdEZyb21EYihiYXNlKTtcbiAgICBpZiAocHJvamVjdElubGluZSkgaW5saW5lZC5wdXNoKHByb2plY3RJbmxpbmUpO1xuICB9XG4gIC8vIFNjb3BlZCArIGJ1ZGdldGVkIFx1MjAxNCBzZWUgaXNzdWUgIzQ3MTlcbiAgY29uc3Qga25vd2xlZGdlSW5saW5lID0gYXdhaXQgaW5saW5lS25vd2xlZGdlQnVkZ2V0ZWQoYmFzZSwgZXh0cmFjdEtleXdvcmRzKG1pZFRpdGxlKSk7XG4gIGlmIChrbm93bGVkZ2VJbmxpbmUpIGlubGluZWQucHVzaChrbm93bGVkZ2VJbmxpbmUpO1xuICAvLyBJbmxpbmUgbWlsZXN0b25lIGNvbnRleHQgZmlsZVxuICBjb25zdCBjb250ZXh0UGF0aCA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2UsIG1pZCwgXCJDT05URVhUXCIpO1xuICBjb25zdCBjb250ZXh0UmVsID0gcmVsTWlsZXN0b25lRmlsZShiYXNlLCBtaWQsIFwiQ09OVEVYVFwiKTtcbiAgY29uc3QgY29udGV4dElubGluZSA9IGF3YWl0IGlubGluZUZpbGVPcHRpb25hbChjb250ZXh0UGF0aCwgY29udGV4dFJlbCwgXCJNaWxlc3RvbmUgQ29udGV4dFwiKTtcbiAgaWYgKGNvbnRleHRJbmxpbmUpIGlubGluZWQucHVzaChjb250ZXh0SW5saW5lKTtcblxuICBjb25zdCBpbmxpbmVkQ29udGV4dCA9IHByZXBlbmRDb250ZXh0TW9kZVRvQmxvY2soXG4gICAgXCJ2YWxpZGF0ZS1taWxlc3RvbmVcIixcbiAgICBiYXNlLFxuICAgIGNhcFByZWFtYmxlKGAjIyBJbmxpbmVkIENvbnRleHQgKHByZWxvYWRlZCBcdTIwMTQgZG8gbm90IHJlLXJlYWQgdGhlc2UgZmlsZXMpXFxuXFxuJHtpbmxpbmVkLmpvaW4oXCJcXG5cXG4tLS1cXG5cXG5cIil9YCksXG4gICk7XG5cbiAgY29uc3QgdmFsaWRhdGlvbk91dHB1dFBhdGggPSBqb2luKGJhc2UsIGAke3JlbE1pbGVzdG9uZVBhdGgoYmFzZSwgbWlkKX0vJHttaWR9LVZBTElEQVRJT04ubWRgKTtcbiAgY29uc3Qgcm9hZG1hcE91dHB1dFBhdGggPSBgJHtyZWxNaWxlc3RvbmVQYXRoKGJhc2UsIG1pZCl9LyR7bWlkfS1ST0FETUFQLm1kYDtcblxuICAvLyBFdmVyeSBtaWxlc3RvbmUgdmFsaWRhdGlvbiB0dXJuIG93bnMgTVYwMVx1MjAxM01WMDQgdW5jb25kaXRpb25hbGx5OiB0aGVcbiAgLy8gcmVnaXN0cnkgaXMgdGhlIHNvdXJjZSBvZiB0cnV0aCBmb3Igd2hpY2ggZ2F0ZXMgdGhlIHZhbGlkYXRvciBtdXN0XG4gIC8vIGFkZHJlc3MsIGFuZCB0aGUgYmxvY2sgYmVsb3cgaXMgd2hhdCB0aGUgdGVtcGxhdGUgcmVuZGVycyBzbyB0aGVcbiAgLy8gYXNzaXN0YW50IGNhbiBuZXZlciBhY2NpZGVudGFsbHkgc2tpcCBvbmUuXG4gIGNvbnN0IG12R2F0ZXMgPSBnZXRHYXRlc0ZvclR1cm4oXCJ2YWxpZGF0ZS1taWxlc3RvbmVcIik7XG4gIGNvbnN0IGdhdGVzVG9FdmFsdWF0ZSA9IHJlbmRlckdhdGVzVG9DbG9zZUJsb2NrKG12R2F0ZXMsIHtcbiAgICBwZW5kaW5nOiBuZXcgU2V0KG12R2F0ZXMubWFwKChnKSA9PiBnLmlkKSksXG4gICAgYWxsb3dPbWl0OiBmYWxzZSxcbiAgfSk7XG5cbiAgcmV0dXJuIGxvYWRQcm9tcHQoXCJ2YWxpZGF0ZS1taWxlc3RvbmVcIiwge1xuICAgIHdvcmtpbmdEaXJlY3Rvcnk6IGJhc2UsXG4gICAgbWlsZXN0b25lSWQ6IG1pZCxcbiAgICBtaWxlc3RvbmVUaXRsZTogbWlkVGl0bGUsXG4gICAgcm9hZG1hcFBhdGg6IHJvYWRtYXBPdXRwdXRQYXRoLFxuICAgIGlubGluZWRDb250ZXh0LFxuICAgIHZhbGlkYXRpb25QYXRoOiB2YWxpZGF0aW9uT3V0cHV0UGF0aCxcbiAgICByZW1lZGlhdGlvblJvdW5kOiBTdHJpbmcocmVtZWRpYXRpb25Sb3VuZCksXG4gICAgZ2F0ZXNUb0V2YWx1YXRlLFxuICAgIHNraWxsQWN0aXZhdGlvbjogYnVpbGRTa2lsbEFjdGl2YXRpb25CbG9jayh7XG4gICAgICBiYXNlLFxuICAgICAgbWlsZXN0b25lSWQ6IG1pZCxcbiAgICAgIG1pbGVzdG9uZVRpdGxlOiBtaWRUaXRsZSxcbiAgICAgIGV4dHJhQ29udGV4dDogW2lubGluZWRDb250ZXh0XSxcbiAgICAgIHVuaXRUeXBlOiBcInZhbGlkYXRlLW1pbGVzdG9uZVwiLFxuICAgIH0pLFxuICB9KTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGJ1aWxkUmVwbGFuU2xpY2VQcm9tcHQoXG4gIG1pZDogc3RyaW5nLCBtaWRUaXRsZTogc3RyaW5nLCBzaWQ6IHN0cmluZywgc1RpdGxlOiBzdHJpbmcsIGJhc2U6IHN0cmluZyxcbik6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IHJvYWRtYXBQYXRoID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZSwgbWlkLCBcIlJPQURNQVBcIik7XG4gIGNvbnN0IHJvYWRtYXBSZWwgPSByZWxNaWxlc3RvbmVGaWxlKGJhc2UsIG1pZCwgXCJST0FETUFQXCIpO1xuICBjb25zdCBzbGljZVBsYW5QYXRoID0gcmVzb2x2ZVNsaWNlRmlsZShiYXNlLCBtaWQsIHNpZCwgXCJQTEFOXCIpO1xuICBjb25zdCBzbGljZVBsYW5SZWwgPSByZWxTbGljZUZpbGUoYmFzZSwgbWlkLCBzaWQsIFwiUExBTlwiKTtcbiAgY29uc3Qgc2xpY2VDb250ZXh0UGF0aCA9IHJlc29sdmVTbGljZUZpbGUoYmFzZSwgbWlkLCBzaWQsIFwiQ09OVEVYVFwiKTtcbiAgY29uc3Qgc2xpY2VDb250ZXh0UmVsID0gcmVsU2xpY2VGaWxlKGJhc2UsIG1pZCwgc2lkLCBcIkNPTlRFWFRcIik7XG5cbiAgY29uc3QgaW5saW5lZDogc3RyaW5nW10gPSBbXTtcbiAgaW5saW5lZC5wdXNoKGF3YWl0IGlubGluZUZpbGUocm9hZG1hcFBhdGgsIHJvYWRtYXBSZWwsIFwiTWlsZXN0b25lIFJvYWRtYXBcIikpO1xuICBjb25zdCBzbGljZUN0eElubGluZSA9IGF3YWl0IGlubGluZUZpbGVPcHRpb25hbChzbGljZUNvbnRleHRQYXRoLCBzbGljZUNvbnRleHRSZWwsIFwiU2xpY2UgQ29udGV4dCAoZnJvbSBkaXNjdXNzaW9uKVwiKTtcbiAgaWYgKHNsaWNlQ3R4SW5saW5lKSBpbmxpbmVkLnB1c2goc2xpY2VDdHhJbmxpbmUpO1xuICBpbmxpbmVkLnB1c2goYXdhaXQgaW5saW5lRmlsZShzbGljZVBsYW5QYXRoLCBzbGljZVBsYW5SZWwsIFwiQ3VycmVudCBTbGljZSBQbGFuXCIpKTtcblxuICAvLyBGaW5kIHRoZSBibG9ja2VyIHRhc2sgc3VtbWFyeSBcdTIwMTQgdGhlIGNvbXBsZXRlZCB0YXNrIHdpdGggYmxvY2tlcl9kaXNjb3ZlcmVkOiB0cnVlXG4gIGxldCBibG9ja2VyVGFza0lkID0gXCJcIjtcbiAgY29uc3QgdERpciA9IHJlc29sdmVUYXNrc0RpcihiYXNlLCBtaWQsIHNpZCk7XG4gIGlmICh0RGlyKSB7XG4gICAgY29uc3Qgc3VtbWFyeUZpbGVzID0gcmVzb2x2ZVRhc2tGaWxlcyh0RGlyLCBcIlNVTU1BUllcIikuc29ydCgpO1xuICAgIGZvciAoY29uc3QgZmlsZSBvZiBzdW1tYXJ5RmlsZXMpIHtcbiAgICAgIGNvbnN0IGFic1BhdGggPSBqb2luKHREaXIsIGZpbGUpO1xuICAgICAgY29uc3QgY29udGVudCA9IGF3YWl0IGxvYWRGaWxlKGFic1BhdGgpO1xuICAgICAgaWYgKCFjb250ZW50KSBjb250aW51ZTtcbiAgICAgIGNvbnN0IHN1bW1hcnkgPSBwYXJzZVN1bW1hcnkoY29udGVudCk7XG4gICAgICBjb25zdCBzUmVsID0gcmVsU2xpY2VQYXRoKGJhc2UsIG1pZCwgc2lkKTtcbiAgICAgIGNvbnN0IHJlbFBhdGggPSBgJHtzUmVsfS90YXNrcy8ke2ZpbGV9YDtcbiAgICAgIGlmIChzdW1tYXJ5LmZyb250bWF0dGVyLmJsb2NrZXJfZGlzY292ZXJlZCkge1xuICAgICAgICBibG9ja2VyVGFza0lkID0gc3VtbWFyeS5mcm9udG1hdHRlci5pZCB8fCBmaWxlLnJlcGxhY2UoLy1TVU1NQVJZXFwubWQkL2ksIFwiXCIpO1xuICAgICAgICBpbmxpbmVkLnB1c2goYXdhaXQgYnVpbGRUYXNrU3VtbWFyeUV4Y2VycHQoYWJzUGF0aCwgcmVsUGF0aCwgYmxvY2tlclRhc2tJZCwgeyBibG9ja2VyOiB0cnVlIH0pKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyBJbmxpbmUgZGVjaXNpb25zXG4gIGNvbnN0IGRlY2lzaW9uc0lubGluZSA9IGF3YWl0IGlubGluZURlY2lzaW9uc0Zyb21EYihiYXNlLCBtaWQpO1xuICBpZiAoZGVjaXNpb25zSW5saW5lKSBpbmxpbmVkLnB1c2goZGVjaXNpb25zSW5saW5lKTtcbiAgY29uc3QgcmVwbGFuQWN0aXZlT3ZlcnJpZGVzID0gYXdhaXQgbG9hZEFjdGl2ZU92ZXJyaWRlcyhiYXNlKTtcbiAgY29uc3QgcmVwbGFuT3ZlcnJpZGVzSW5saW5lID0gZm9ybWF0T3ZlcnJpZGVzU2VjdGlvbihyZXBsYW5BY3RpdmVPdmVycmlkZXMpO1xuICBpZiAocmVwbGFuT3ZlcnJpZGVzSW5saW5lKSBpbmxpbmVkLnVuc2hpZnQocmVwbGFuT3ZlcnJpZGVzSW5saW5lKTtcblxuICBjb25zdCBpbmxpbmVkQ29udGV4dCA9IHByZXBlbmRDb250ZXh0TW9kZVRvQmxvY2soXG4gICAgXCJyZXBsYW4tc2xpY2VcIixcbiAgICBiYXNlLFxuICAgIGNhcFByZWFtYmxlKGAjIyBJbmxpbmVkIENvbnRleHQgKHByZWxvYWRlZCBcdTIwMTQgZG8gbm90IHJlLXJlYWQgdGhlc2UgZmlsZXMpXFxuXFxuJHtpbmxpbmVkLmpvaW4oXCJcXG5cXG4tLS1cXG5cXG5cIil9YCksXG4gICk7XG5cbiAgY29uc3QgcmVwbGFuUGF0aCA9IGpvaW4oYmFzZSwgYCR7cmVsU2xpY2VQYXRoKGJhc2UsIG1pZCwgc2lkKX0vJHtzaWR9LVJFUExBTi5tZGApO1xuXG4gIC8vIEJ1aWxkIGNhcHR1cmUgY29udGV4dCBmb3IgcmVwbGFuIHByb21wdCAoY2FwdHVyZXMgdGhhdCB0cmlnZ2VyZWQgdGhpcyByZXBsYW4pXG4gIGxldCBjYXB0dXJlQ29udGV4dCA9IFwiKG5vbmUpXCI7XG4gIHRyeSB7XG4gICAgY29uc3QgeyBsb2FkUmVwbGFuQ2FwdHVyZXMgfSA9IGF3YWl0IGltcG9ydChcIi4vdHJpYWdlLXJlc29sdXRpb24uanNcIik7XG4gICAgY29uc3QgcmVwbGFuQ2FwdHVyZXMgPSBsb2FkUmVwbGFuQ2FwdHVyZXMoYmFzZSk7XG4gICAgaWYgKHJlcGxhbkNhcHR1cmVzLmxlbmd0aCA+IDApIHtcbiAgICAgIGNhcHR1cmVDb250ZXh0ID0gcmVwbGFuQ2FwdHVyZXMubWFwKGMgPT5cbiAgICAgICAgYC0gKioke2MuaWR9Kio6IFwiJHtjLnRleHR9XCIgXHUyMDE0ICR7Yy5yYXRpb25hbGUgPz8gXCJubyByYXRpb25hbGVcIn1gXG4gICAgICApLmpvaW4oXCJcXG5cIik7XG4gICAgfVxuICB9IGNhdGNoIChlcnIpIHtcbiAgICBsb2dXYXJuaW5nKFwicHJvbXB0XCIsIGBsb2FkUmVwbGFuQ2FwdHVyZXMgZmFpbGVkOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gKTtcbiAgfVxuXG4gIHJldHVybiBsb2FkUHJvbXB0KFwicmVwbGFuLXNsaWNlXCIsIHtcbiAgICB3b3JraW5nRGlyZWN0b3J5OiBiYXNlLFxuICAgIG1pbGVzdG9uZUlkOiBtaWQsXG4gICAgc2xpY2VJZDogc2lkLFxuICAgIHNsaWNlVGl0bGU6IHNUaXRsZSxcbiAgICBzbGljZVBhdGg6IHJlbFNsaWNlUGF0aChiYXNlLCBtaWQsIHNpZCksXG4gICAgcGxhblBhdGg6IGpvaW4oYmFzZSwgc2xpY2VQbGFuUmVsKSxcbiAgICBibG9ja2VyVGFza0lkLFxuICAgIGlubGluZWRDb250ZXh0LFxuICAgIHJlcGxhblBhdGgsXG4gICAgY2FwdHVyZUNvbnRleHQsXG4gICAgc2tpbGxBY3RpdmF0aW9uOiBidWlsZFNraWxsQWN0aXZhdGlvbkJsb2NrKHtcbiAgICAgIGJhc2UsXG4gICAgICBtaWxlc3RvbmVJZDogbWlkLFxuICAgICAgbWlsZXN0b25lVGl0bGU6IG1pZFRpdGxlLFxuICAgICAgc2xpY2VJZDogc2lkLFxuICAgICAgc2xpY2VUaXRsZTogc1RpdGxlLFxuICAgICAgZXh0cmFDb250ZXh0OiBbaW5saW5lZENvbnRleHQsIGNhcHR1cmVDb250ZXh0XSxcbiAgICAgIHVuaXRUeXBlOiBcInJlcGxhbi1zbGljZVwiLFxuICAgIH0pLFxuICB9KTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGJ1aWxkUnVuVWF0UHJvbXB0KFxuICBtaWQ6IHN0cmluZywgc2xpY2VJZDogc3RyaW5nLCB1YXRQYXRoOiBzdHJpbmcsIHVhdENvbnRlbnQ6IHN0cmluZywgYmFzZTogc3RyaW5nLFxuKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgLy8gIzQ3ODIgcGhhc2UgMzogcnVuLXVhdCBtaWdyYXRlZCB0byBjb21wb3NlIGl0cyBpbmxpbmVkIGNvbnRleHQgdmlhXG4gIC8vIHRoZSBtYW5pZmVzdC4gQmVoYXZpb3ItZXF1aXZhbGVudCBcdTIwMTQgcmVzb2x2ZXIgZGlzcGF0Y2hlcyB0byB0aGUgc2FtZVxuICAvLyBpbmxpbmUqIGhlbHBlcnMgYXMgdGhlIHByZS1taWdyYXRpb24gYnVpbGRlci5cbiAgY29uc3QgcmVzb2x2ZUFydGlmYWN0OiBBcnRpZmFjdFJlc29sdmVyID0gYXN5bmMgKGtleSkgPT4ge1xuICAgIHN3aXRjaCAoa2V5KSB7XG4gICAgICBjYXNlIFwic2xpY2UtdWF0XCI6IHtcbiAgICAgICAgLy8gVXNlIHRoZSBpbi1tZW1vcnkgc25hcHNob3QgdGhlIGNhbGxlciBhbHJlYWR5IGxvYWRlZCAoIzQ5MjUgcmV2aWV3KS5cbiAgICAgICAgLy8gUmUtcmVhZGluZyBmcm9tIGRpc2sgdmlhIGlubGluZUZpbGUocCwgdWF0UGF0aCwgLi4uKSB3b3VsZCByaXNrXG4gICAgICAgIC8vIGRyaWZ0IGJldHdlZW4gdGhlIGlubGluZWQgYm9keSBhbmQgdWF0VHlwZSAoY29tcHV0ZWQgZnJvbVxuICAgICAgICAvLyB1YXRDb250ZW50IGJlbG93KSBpZiB0aGUgZmlsZSBjaGFuZ2VzIG1pZC1kaXNwYXRjaC5cbiAgICAgICAgY29uc3QgdHJpbW1lZCA9IHVhdENvbnRlbnQudHJpbSgpO1xuICAgICAgICBpZiAoIXRyaW1tZWQpIHtcbiAgICAgICAgICByZXR1cm4gYCMjIyAke3NsaWNlSWR9IFVBVFxcblNvdXJjZTogXFxgJHt1YXRQYXRofVxcYFxcblxcbl8obm90IGZvdW5kIFx1MjAxNCBmaWxlIGRvZXMgbm90IGV4aXN0IHlldClfYDtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gYCMjIyAke3NsaWNlSWR9IFVBVFxcblNvdXJjZTogXFxgJHt1YXRQYXRofVxcYFxcblxcbiR7dHJpbW1lZH1gO1xuICAgICAgfVxuICAgICAgY2FzZSBcInNsaWNlLXN1bW1hcnlcIjoge1xuICAgICAgICBjb25zdCBwID0gcmVzb2x2ZVNsaWNlRmlsZShiYXNlLCBtaWQsIHNsaWNlSWQsIFwiU1VNTUFSWVwiKTtcbiAgICAgICAgaWYgKCFwKSByZXR1cm4gbnVsbDtcbiAgICAgICAgY29uc3QgciA9IHJlbFNsaWNlRmlsZShiYXNlLCBtaWQsIHNsaWNlSWQsIFwiU1VNTUFSWVwiKTtcbiAgICAgICAgcmV0dXJuIGF3YWl0IGlubGluZUZpbGVPcHRpb25hbChwLCByLCBgJHtzbGljZUlkfSBTdW1tYXJ5YCk7XG4gICAgICB9XG4gICAgICBjYXNlIFwicHJvamVjdFwiOlxuICAgICAgICByZXR1cm4gYXdhaXQgaW5saW5lUHJvamVjdEZyb21EYihiYXNlKTtcbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgfTtcblxuICBjb25zdCBjb21wb3NlZCA9IGF3YWl0IGNvbXBvc2VJbmxpbmVkQ29udGV4dChcInJ1bi11YXRcIiwgcmVzb2x2ZUFydGlmYWN0KTtcbiAgY29uc3QgaW5saW5lZENvbnRleHQgPSBwcmVwZW5kQ29udGV4dE1vZGVUb0Jsb2NrKFxuICAgIFwicnVuLXVhdFwiLFxuICAgIGJhc2UsXG4gICAgY2FwUHJlYW1ibGUoYCMjIElubGluZWQgQ29udGV4dCAocHJlbG9hZGVkIFx1MjAxNCBkbyBub3QgcmUtcmVhZCB0aGVzZSBmaWxlcylcXG5cXG4ke2NvbXBvc2VkfWApLFxuICApO1xuXG4gIGNvbnN0IHVhdFJlc3VsdFBhdGggPSBqb2luKGJhc2UsIHJlbFNsaWNlRmlsZShiYXNlLCBtaWQsIHNsaWNlSWQsIFwiQVNTRVNTTUVOVFwiKSk7XG4gIGNvbnN0IHVhdFR5cGUgPSBnZXRVYXRUeXBlKHVhdENvbnRlbnQpO1xuXG4gIHJldHVybiBsb2FkUHJvbXB0KFwicnVuLXVhdFwiLCB7XG4gICAgd29ya2luZ0RpcmVjdG9yeTogYmFzZSxcbiAgICBtaWxlc3RvbmVJZDogbWlkLFxuICAgIHNsaWNlSWQsXG4gICAgdWF0UGF0aCxcbiAgICB1YXRSZXN1bHRQYXRoLFxuICAgIHVhdFR5cGUsXG4gICAgaW5saW5lZENvbnRleHQsXG4gICAgc2tpbGxBY3RpdmF0aW9uOiBidWlsZFNraWxsQWN0aXZhdGlvbkJsb2NrKHtcbiAgICAgIGJhc2UsXG4gICAgICBtaWxlc3RvbmVJZDogbWlkLFxuICAgICAgc2xpY2VJZCxcbiAgICAgIGV4dHJhQ29udGV4dDogW2lubGluZWRDb250ZXh0XSxcbiAgICAgIHVuaXRUeXBlOiBcInJ1bi11YXRcIixcbiAgICB9KSxcbiAgfSk7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBidWlsZFJlYXNzZXNzUm9hZG1hcFByb21wdChcbiAgbWlkOiBzdHJpbmcsIG1pZFRpdGxlOiBzdHJpbmcsIGNvbXBsZXRlZFNsaWNlSWQ6IHN0cmluZywgYmFzZTogc3RyaW5nLCBsZXZlbD86IElubGluZUxldmVsLFxuKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgY29uc3QgaW5saW5lTGV2ZWwgPSBsZXZlbCA/PyByZXNvbHZlSW5saW5lTGV2ZWwoKTtcblxuICAvLyAjNDc4MiBwaGFzZSAyIHBpbG90OiByZWFzc2Vzcy1yb2FkbWFwIGlzIHRoZSBmaXJzdCB1bml0IHR5cGUgdG9cbiAgLy8gY29tcG9zZSBpdHMgaW5saW5lZCBjb250ZXh0IHRocm91Z2ggdGhlIG1hbmlmZXN0LWRyaXZlbiBjb21wb3Nlci5cbiAgLy8gVGhlIHJlc29sdmVyIGJlbG93IGRpc3BhdGNoZXMgYXJ0aWZhY3Qga2V5cyB0byB0aGUgZXhpc3RpbmcgaW5saW5lKlxuICAvLyBoZWxwZXJzLCBwcmVzZXJ2aW5nIGlkZW50aWNhbCBvdXRwdXQgc28gdGhlIG1pZ3JhdGlvbiBpc1xuICAvLyBvYnNlcnZhYmxlLWVxdWl2YWxlbnQuIEtub3dsZWRnZSBzdGF5cyBvdXRzaWRlIHRoZSBjb21wb3NlciAoaXQnc1xuICAvLyBidWRnZXQtZHJpdmVuLCBub3QgbWFuaWZlc3QtZHJpdmVuKSB1bnRpbCBhIGxhdGVyIHBoYXNlIGZvcm1hbGl6ZXNcbiAgLy8ga25vd2xlZGdlL21lbW9yeSBwb2xpY2llcyBhcyBjb21wb3NlciBpbnB1dHMuXG4gIGNvbnN0IHJlc29sdmVBcnRpZmFjdDogQXJ0aWZhY3RSZXNvbHZlciA9IGFzeW5jIChrZXkpID0+IHtcbiAgICBzd2l0Y2ggKGtleSkge1xuICAgICAgY2FzZSBcInJvYWRtYXBcIjoge1xuICAgICAgICBjb25zdCBwID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZSwgbWlkLCBcIlJPQURNQVBcIik7XG4gICAgICAgIGNvbnN0IHIgPSByZWxNaWxlc3RvbmVGaWxlKGJhc2UsIG1pZCwgXCJST0FETUFQXCIpO1xuICAgICAgICByZXR1cm4gYXdhaXQgaW5saW5lRmlsZShwLCByLCBcIkN1cnJlbnQgUm9hZG1hcFwiKTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJzbGljZS1jb250ZXh0XCI6IHtcbiAgICAgICAgY29uc3QgcCA9IHJlc29sdmVTbGljZUZpbGUoYmFzZSwgbWlkLCBjb21wbGV0ZWRTbGljZUlkLCBcIkNPTlRFWFRcIik7XG4gICAgICAgIGNvbnN0IHIgPSByZWxTbGljZUZpbGUoYmFzZSwgbWlkLCBjb21wbGV0ZWRTbGljZUlkLCBcIkNPTlRFWFRcIik7XG4gICAgICAgIHJldHVybiBhd2FpdCBpbmxpbmVGaWxlT3B0aW9uYWwocCwgciwgXCJTbGljZSBDb250ZXh0IChmcm9tIGRpc2N1c3Npb24pXCIpO1xuICAgICAgfVxuICAgICAgY2FzZSBcInNsaWNlLXN1bW1hcnlcIjoge1xuICAgICAgICBjb25zdCBwID0gcmVzb2x2ZVNsaWNlRmlsZShiYXNlLCBtaWQsIGNvbXBsZXRlZFNsaWNlSWQsIFwiU1VNTUFSWVwiKTtcbiAgICAgICAgY29uc3QgciA9IHJlbFNsaWNlRmlsZShiYXNlLCBtaWQsIGNvbXBsZXRlZFNsaWNlSWQsIFwiU1VNTUFSWVwiKTtcbiAgICAgICAgcmV0dXJuIGF3YWl0IGlubGluZUZpbGUocCwgciwgYCR7Y29tcGxldGVkU2xpY2VJZH0gU3VtbWFyeWApO1xuICAgICAgfVxuICAgICAgY2FzZSBcInByb2plY3RcIjpcbiAgICAgICAgaWYgKGlubGluZUxldmVsID09PSBcIm1pbmltYWxcIikgcmV0dXJuIG51bGw7XG4gICAgICAgIHJldHVybiBhd2FpdCBpbmxpbmVQcm9qZWN0RnJvbURiKGJhc2UpO1xuICAgICAgY2FzZSBcInJlcXVpcmVtZW50c1wiOlxuICAgICAgICBpZiAoaW5saW5lTGV2ZWwgPT09IFwibWluaW1hbFwiKSByZXR1cm4gbnVsbDtcbiAgICAgICAgcmV0dXJuIGF3YWl0IGlubGluZVJlcXVpcmVtZW50c0Zyb21EYihiYXNlLCBtaWQsIHVuZGVmaW5lZCwgaW5saW5lTGV2ZWwpO1xuICAgICAgY2FzZSBcImRlY2lzaW9uc1wiOlxuICAgICAgICBpZiAoaW5saW5lTGV2ZWwgPT09IFwibWluaW1hbFwiKSByZXR1cm4gbnVsbDtcbiAgICAgICAgcmV0dXJuIGF3YWl0IGlubGluZURlY2lzaW9uc0Zyb21EYihiYXNlLCBtaWQsIHVuZGVmaW5lZCwgaW5saW5lTGV2ZWwpO1xuICAgICAgZGVmYXVsdDpcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IGNvbXBvc2VkID0gYXdhaXQgY29tcG9zZUlubGluZWRDb250ZXh0KFwicmVhc3Nlc3Mtcm9hZG1hcFwiLCByZXNvbHZlQXJ0aWZhY3QpO1xuICBjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcbiAgaWYgKGNvbXBvc2VkKSBwYXJ0cy5wdXNoKGNvbXBvc2VkKTtcbiAgLy8gS25vd2xlZGdlIGJsb2NrIHN0YXlzIG91dHNpZGUgdGhlIGNvbXBvc2VyIFx1MjAxNCBidWRnZXRlZCwgc2NvcGVkIHZpYVxuICAvLyBrZXl3b3JkIGV4dHJhY3Rpb24gKCM0NzE5KS4gRnV0dXJlIHBoYXNlIGZvbGRzIGl0IGluLlxuICBjb25zdCBrbm93bGVkZ2VJbmxpbmVSQSA9IGF3YWl0IGlubGluZUtub3dsZWRnZUJ1ZGdldGVkKGJhc2UsIGV4dHJhY3RLZXl3b3JkcyhtaWRUaXRsZSkpO1xuICBpZiAoa25vd2xlZGdlSW5saW5lUkEpIHBhcnRzLnB1c2goa25vd2xlZGdlSW5saW5lUkEpO1xuXG4gIGNvbnN0IGlubGluZWRDb250ZXh0ID0gcHJlcGVuZENvbnRleHRNb2RlVG9CbG9jayhcbiAgICBcInJlYXNzZXNzLXJvYWRtYXBcIixcbiAgICBiYXNlLFxuICAgIGNhcFByZWFtYmxlKGAjIyBJbmxpbmVkIENvbnRleHQgKHByZWxvYWRlZCBcdTIwMTQgZG8gbm90IHJlLXJlYWQgdGhlc2UgZmlsZXMpXFxuXFxuJHtwYXJ0cy5qb2luKFwiXFxuXFxuLS0tXFxuXFxuXCIpfWApLFxuICApO1xuXG4gIGNvbnN0IGFzc2Vzc21lbnRQYXRoID0gam9pbihiYXNlLCByZWxTbGljZUZpbGUoYmFzZSwgbWlkLCBjb21wbGV0ZWRTbGljZUlkLCBcIkFTU0VTU01FTlRcIikpO1xuXG4gIC8vIEJ1aWxkIGRlZmVycmVkIGNhcHR1cmVzIGNvbnRleHQgZm9yIHJlYXNzZXNzIHByb21wdFxuICBsZXQgZGVmZXJyZWRDYXB0dXJlcyA9IFwiKG5vbmUpXCI7XG4gIHRyeSB7XG4gICAgY29uc3QgeyBsb2FkRGVmZXJyZWRDYXB0dXJlcyB9ID0gYXdhaXQgaW1wb3J0KFwiLi90cmlhZ2UtcmVzb2x1dGlvbi5qc1wiKTtcbiAgICBjb25zdCBkZWZlcnJlZCA9IGxvYWREZWZlcnJlZENhcHR1cmVzKGJhc2UpO1xuICAgIGlmIChkZWZlcnJlZC5sZW5ndGggPiAwKSB7XG4gICAgICBkZWZlcnJlZENhcHR1cmVzID0gZGVmZXJyZWQubWFwKGMgPT5cbiAgICAgICAgYC0gKioke2MuaWR9Kio6IFwiJHtjLnRleHR9XCIgXHUyMDE0ICR7Yy5yYXRpb25hbGUgPz8gXCJkZWZlcnJlZCBkdXJpbmcgdHJpYWdlXCJ9YFxuICAgICAgKS5qb2luKFwiXFxuXCIpO1xuICAgIH1cbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgbG9nV2FybmluZyhcInByb21wdFwiLCBgbG9hZERlZmVycmVkQ2FwdHVyZXMgZmFpbGVkOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gKTtcbiAgfVxuXG4gIGNvbnN0IHJlYXNzZXNzQ29tbWl0SW5zdHJ1Y3Rpb24gPSBcIkRvIG5vdCBjb21taXQgXHUyMDE0IC5nc2QvIHBsYW5uaW5nIGRvY3MgYXJlIG1hbmFnZWQgZXh0ZXJuYWxseSBhbmQgbm90IHRyYWNrZWQgaW4gZ2l0LlwiO1xuXG4gIHJldHVybiBsb2FkUHJvbXB0KFwicmVhc3Nlc3Mtcm9hZG1hcFwiLCB7XG4gICAgd29ya2luZ0RpcmVjdG9yeTogYmFzZSxcbiAgICBtaWxlc3RvbmVJZDogbWlkLFxuICAgIG1pbGVzdG9uZVRpdGxlOiBtaWRUaXRsZSxcbiAgICBjb21wbGV0ZWRTbGljZUlkLFxuICAgIHJvYWRtYXBQYXRoOiByZWxNaWxlc3RvbmVGaWxlKGJhc2UsIG1pZCwgXCJST0FETUFQXCIpLFxuICAgIGFzc2Vzc21lbnRQYXRoLFxuICAgIGlubGluZWRDb250ZXh0LFxuICAgIGRlZmVycmVkQ2FwdHVyZXMsXG4gICAgY29tbWl0SW5zdHJ1Y3Rpb246IHJlYXNzZXNzQ29tbWl0SW5zdHJ1Y3Rpb24sXG4gICAgc2tpbGxBY3RpdmF0aW9uOiBidWlsZFNraWxsQWN0aXZhdGlvbkJsb2NrKHtcbiAgICAgIGJhc2UsXG4gICAgICBtaWxlc3RvbmVJZDogbWlkLFxuICAgICAgbWlsZXN0b25lVGl0bGU6IG1pZFRpdGxlLFxuICAgICAgZXh0cmFDb250ZXh0OiBbaW5saW5lZENvbnRleHQsIGRlZmVycmVkQ2FwdHVyZXNdLFxuICAgICAgdW5pdFR5cGU6IFwicmVhc3Nlc3Mtcm9hZG1hcFwiLFxuICAgIH0pLFxuICB9KTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFJlYWN0aXZlIEV4ZWN1dGUgUHJvbXB0IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gYnVpbGRSZWFjdGl2ZUV4ZWN1dGVQcm9tcHQoXG4gIG1pZDogc3RyaW5nLCBtaWRUaXRsZTogc3RyaW5nLCBzaWQ6IHN0cmluZywgc1RpdGxlOiBzdHJpbmcsXG4gIHJlYWR5VGFza0lkczogc3RyaW5nW10sIGJhc2U6IHN0cmluZyxcbiAgc3ViYWdlbnRNb2RlbD86IHN0cmluZyxcbiAgb3B0cz86IHsgc2Vzc2lvbkNvbnRleHRXaW5kb3c/OiBudW1iZXI7IG1vZGVsUmVnaXN0cnk/OiBNaW5pbWFsTW9kZWxSZWdpc3RyeTsgc2Vzc2lvblByb3ZpZGVyPzogc3RyaW5nIH0sXG4pOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCB7IGxvYWRTbGljZVRhc2tJTywgZGVyaXZlVGFza0dyYXBoLCBncmFwaE1ldHJpY3MgfSA9IGF3YWl0IGltcG9ydChcIi4vcmVhY3RpdmUtZ3JhcGguanNcIik7XG5cbiAgLy8gQnVpbGQgZ3JhcGggZm9yIGNvbnRleHRcbiAgY29uc3QgdGFza0lPID0gYXdhaXQgbG9hZFNsaWNlVGFza0lPKGJhc2UsIG1pZCwgc2lkKTtcbiAgY29uc3QgZ3JhcGggPSBkZXJpdmVUYXNrR3JhcGgodGFza0lPKTtcbiAgY29uc3QgbWV0cmljcyA9IGdyYXBoTWV0cmljcyhncmFwaCk7XG5cbiAgLy8gQnVpbGQgZ3JhcGggY29udGV4dCBzZWN0aW9uXG4gIGNvbnN0IGdyYXBoTGluZXM6IHN0cmluZ1tdID0gW107XG4gIGZvciAoY29uc3Qgbm9kZSBvZiBncmFwaCkge1xuICAgIGNvbnN0IHN0YXR1cyA9IG5vZGUuZG9uZSA/IFwiXHUyNzA1IGRvbmVcIiA6IHJlYWR5VGFza0lkcy5pbmNsdWRlcyhub2RlLmlkKSA/IFwiXHVEODNEXHVERkUyIHJlYWR5XCIgOiBcIlx1MjNGMyB3YWl0aW5nXCI7XG4gICAgY29uc3QgZGVwcyA9IG5vZGUuZGVwZW5kc09uLmxlbmd0aCA+IDAgPyBgIChkZXBlbmRzIG9uOiAke25vZGUuZGVwZW5kc09uLmpvaW4oXCIsIFwiKX0pYCA6IFwiXCI7XG4gICAgZ3JhcGhMaW5lcy5wdXNoKGAtICoqJHtub2RlLmlkfTogJHtub2RlLnRpdGxlfSoqIFx1MjAxNCAke3N0YXR1c30ke2RlcHN9YCk7XG4gICAgaWYgKG5vZGUub3V0cHV0RmlsZXMubGVuZ3RoID4gMCkge1xuICAgICAgZ3JhcGhMaW5lcy5wdXNoKGAgIC0gT3V0cHV0czogJHtub2RlLm91dHB1dEZpbGVzLm1hcChmID0+IGBcXGAke2Z9XFxgYCkuam9pbihcIiwgXCIpfWApO1xuICAgIH1cbiAgfVxuICBjb25zdCBncmFwaENvbnRleHQgPSBbXG4gICAgYFRhc2tzOiAke21ldHJpY3MudGFza0NvdW50fSwgRWRnZXM6ICR7bWV0cmljcy5lZGdlQ291bnR9LCBSZWFkeTogJHttZXRyaWNzLnJlYWR5U2V0U2l6ZX1gLFxuICAgIFwiXCIsXG4gICAgLi4uZ3JhcGhMaW5lcyxcbiAgXS5qb2luKFwiXFxuXCIpO1xuXG4gIC8vIEJ1aWxkIGluZGl2aWR1YWwgc3ViYWdlbnQgcHJvbXB0cyBmb3IgZWFjaCByZWFkeSB0YXNrXG4gIGNvbnN0IHN1YmFnZW50U2VjdGlvbnM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IHJlYWR5VGFza0xpc3RMaW5lczogc3RyaW5nW10gPSBbXTtcblxuICBmb3IgKGNvbnN0IHRpZCBvZiByZWFkeVRhc2tJZHMpIHtcbiAgICBjb25zdCBub2RlID0gZ3JhcGguZmluZCgobikgPT4gbi5pZCA9PT0gdGlkKTtcbiAgICBjb25zdCB0VGl0bGUgPSBub2RlPy50aXRsZSA/PyB0aWQ7XG4gICAgcmVhZHlUYXNrTGlzdExpbmVzLnB1c2goYC0gKioke3RpZH06ICR7dFRpdGxlfSoqYCk7XG5cbiAgICAvLyBCdWlsZCBkZXBlbmRlbmN5LXNjb3BlZCBjYXJyeS1mb3J3YXJkIHBhdGhzIGZvciB0aGlzIHRhc2tcbiAgICBjb25zdCBkZXBQYXRocyA9IGF3YWl0IGdldERlcGVuZGVuY3lUYXNrU3VtbWFyeVBhdGhzKFxuICAgICAgbWlkLCBzaWQsIHRpZCwgbm9kZT8uZGVwZW5kc09uID8/IFtdLCBiYXNlLFxuICAgICk7XG5cbiAgICAvLyBCdWlsZCBhIGZ1bGwgZXhlY3V0ZS10YXNrIHByb21wdCB3aXRoIGRlcGVuZGVuY3ktYmFzZWQgY2FycnktZm9yd2FyZFxuICAgIGNvbnN0IHRhc2tQcm9tcHQgPSBhd2FpdCBidWlsZEV4ZWN1dGVUYXNrUHJvbXB0KFxuICAgICAgbWlkLCBzaWQsIHNUaXRsZSwgdGlkLCB0VGl0bGUsIGJhc2UsXG4gICAgICB7XG4gICAgICAgIGNhcnJ5Rm9yd2FyZFBhdGhzOiBkZXBQYXRocyxcbiAgICAgICAgc2Vzc2lvbkNvbnRleHRXaW5kb3c6IG9wdHM/LnNlc3Npb25Db250ZXh0V2luZG93LFxuICAgICAgICBtb2RlbFJlZ2lzdHJ5OiBvcHRzPy5tb2RlbFJlZ2lzdHJ5LFxuICAgICAgICBzZXNzaW9uUHJvdmlkZXI6IG9wdHM/LnNlc3Npb25Qcm92aWRlcixcbiAgICAgICAgY29udGV4dE1vZGVSZW5kZXJNb2RlOiBcIm5lc3RlZFwiLFxuICAgICAgfSxcbiAgICApO1xuXG4gICAgY29uc3QgbW9kZWxTdWZmaXggPSBzdWJhZ2VudE1vZGVsID8gYCB3aXRoIG1vZGVsOiBcIiR7c3ViYWdlbnRNb2RlbH1cImAgOiBcIlwiO1xuICAgIHN1YmFnZW50U2VjdGlvbnMucHVzaChbXG4gICAgICBgIyMjICR7dGlkfTogJHt0VGl0bGV9YCxcbiAgICAgIFwiXCIsXG4gICAgICBgVXNlIHRoaXMgYXMgdGhlIHByb21wdCBmb3IgYSBcXGBzdWJhZ2VudFxcYCBjYWxsJHttb2RlbFN1ZmZpeH06YCxcbiAgICAgIFwiXCIsXG4gICAgICBcImBgYFwiLFxuICAgICAgdGFza1Byb21wdCxcbiAgICAgIFwiYGBgXCIsXG4gICAgXS5qb2luKFwiXFxuXCIpKTtcbiAgfVxuXG4gIGNvbnN0IGlubGluZWRUZW1wbGF0ZXMgPSBpbmxpbmVUZW1wbGF0ZShcInRhc2stc3VtbWFyeVwiLCBcIlRhc2sgU3VtbWFyeVwiKTtcblxuICByZXR1cm4gbG9hZFByb21wdChcInJlYWN0aXZlLWV4ZWN1dGVcIiwge1xuICAgIHdvcmtpbmdEaXJlY3Rvcnk6IGJhc2UsXG4gICAgbWlsZXN0b25lSWQ6IG1pZCxcbiAgICBtaWxlc3RvbmVUaXRsZTogbWlkVGl0bGUsXG4gICAgc2xpY2VJZDogc2lkLFxuICAgIHNsaWNlVGl0bGU6IHNUaXRsZSxcbiAgICBncmFwaENvbnRleHQ6IHByZXBlbmRDb250ZXh0TW9kZVRvQmxvY2soXCJyZWFjdGl2ZS1leGVjdXRlXCIsIGJhc2UsIGdyYXBoQ29udGV4dCksXG4gICAgcmVhZHlUYXNrQ291bnQ6IFN0cmluZyhyZWFkeVRhc2tJZHMubGVuZ3RoKSxcbiAgICByZWFkeVRhc2tMaXN0OiByZWFkeVRhc2tMaXN0TGluZXMuam9pbihcIlxcblwiKSxcbiAgICBzdWJhZ2VudFByb21wdHM6IHN1YmFnZW50U2VjdGlvbnMuam9pbihcIlxcblxcbi0tLVxcblxcblwiKSxcbiAgICBpbmxpbmVkVGVtcGxhdGVzLFxuICB9KTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEdhdGUgRXZhbHVhdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbi8vXG4vLyBHYXRlIGRlZmluaXRpb25zIChxdWVzdGlvbiwgZ3VpZGFuY2UsIG93bmVyIHR1cm4pIG5vdyBsaXZlIGluXG4vLyBnYXRlLXJlZ2lzdHJ5LnRzIHNvIHRoYXQgcHJvbXB0IGJ1aWxkZXJzLCBkaXNwYXRjaCBydWxlcywgc3RhdGVcbi8vIGRlcml2YXRpb24sIGFuZCB0b29sIGhhbmRsZXJzIGFsbCBjb25zdWx0IHRoZSBzYW1lIHNvdXJjZSBvZiB0cnV0aC5cbi8vIFNlZSBnYXRlLXJlZ2lzdHJ5LnRzIGZvciB0aGUgZnVsbCBvd25lcnNoaXAgbWFwLlxuXG4vKipcbiAqIFJlbmRlciBhIFwiR2F0ZXMgdG8gQ2xvc2VcIiBibG9jayBmb3IgdHVybnMgbGlrZSBgY29tcGxldGUtc2xpY2VgIGFuZFxuICogYHZhbGlkYXRlLW1pbGVzdG9uZWAgdGhhdCBvd24gZ2F0ZXMgd2hpY2ggYXJlIGNsb3NlZCBhcyBhIHNpZGUtZWZmZWN0XG4gKiBvZiB3cml0aW5nIGFydGlmYWN0IHNlY3Rpb25zIChub3QgdmlhIGEgZGVkaWNhdGVkIGdhdGUtZXZhbHVhdGVcbiAqIHN1YmFnZW50IGxvb3ApLlxuICpcbiAqIFJldHVybnMgYSBwbGFpbi10ZXh0IGJsb2NrIG9yIGFuIGVtcHR5IHN0cmluZyBpZiB0aGVyZSBhcmUgbm8gZ2F0ZXMgdG9cbiAqIGNsb3NlLCBzbyBjYWxsZXJzIGNhbiBkcm9wIGl0IHN0cmFpZ2h0IGludG8gYSB0ZW1wbGF0ZSB2YXJpYWJsZS5cbiAqL1xuZnVuY3Rpb24gcmVuZGVyR2F0ZXNUb0Nsb3NlQmxvY2soXG4gIGdhdGVzOiBSZWFkb25seUFycmF5PEdhdGVEZWZpbml0aW9uPixcbiAgb3B0czogeyBwZW5kaW5nOiBSZWFkb25seVNldDxzdHJpbmc+OyBhbGxvd09taXQ6IGJvb2xlYW4gfSxcbik6IHN0cmluZyB7XG4gIGNvbnN0IGFwcGxpY2FibGUgPSBnYXRlcy5maWx0ZXIoKGcpID0+IG9wdHMucGVuZGluZy5oYXMoZy5pZCkpO1xuICBpZiAoYXBwbGljYWJsZS5sZW5ndGggPT09IDApIHJldHVybiBcIlwiO1xuXG4gIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICBsaW5lcy5wdXNoKFwiIyMgR2F0ZXMgdG8gQ2xvc2VcIik7XG4gIGxpbmVzLnB1c2goXCJcIik7XG4gIGxpbmVzLnB1c2goXG4gICAgXCJUaGVzZSBxdWFsaXR5IGdhdGVzIGFyZSBzdGlsbCBwZW5kaW5nIGZvciB0aGlzIHVuaXQuIFlvdSBNVVNUIGFkZHJlc3MgZXZlcnkgb25lIGJlZm9yZSBjYWxsaW5nIHRoZSBjbG9zaW5nIHRvb2wgXHUyMDE0IHRoZSBoYW5kbGVyIGNsb3NlcyB0aGUgREIgcm93IGJhc2VkIG9uIHdoZXRoZXIgdGhlIGNvcnJlc3BvbmRpbmcgYXJ0aWZhY3Qgc2VjdGlvbiBpcyBwcmVzZW50LlwiLFxuICApO1xuICBsaW5lcy5wdXNoKFwiXCIpO1xuICBmb3IgKGNvbnN0IGRlZiBvZiBhcHBsaWNhYmxlKSB7XG4gICAgbGluZXMucHVzaChgIyMjICR7ZGVmLmlkfSBcdTIwMTQgJHtkZWYucHJvbXB0U2VjdGlvbn1gKTtcbiAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICAgIGxpbmVzLnB1c2goYCoqUXVlc3Rpb246KiogJHtkZWYucXVlc3Rpb259YCk7XG4gICAgbGluZXMucHVzaChcIlwiKTtcbiAgICBsaW5lcy5wdXNoKGRlZi5ndWlkYW5jZSk7XG4gICAgaWYgKG9wdHMuYWxsb3dPbWl0KSB7XG4gICAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICAgICAgbGluZXMucHVzaChcbiAgICAgICAgYElmIHRoaXMgZ2F0ZSBnZW51aW5lbHkgZG9lcyBub3QgYXBwbHkgdG8gdGhpcyB1bml0LCBsZWF2ZSB0aGUgKioke2RlZi5wcm9tcHRTZWN0aW9ufSoqIHNlY3Rpb24gZW1wdHkgYW5kIHRoZSBoYW5kbGVyIHdpbGwgcmVjb3JkIGl0IGFzIFxcYG9taXR0ZWRcXGAuIE90aGVyd2lzZSwgZmlsbCB0aGUgc2VjdGlvbiB3aXRoIGNvbmNyZXRlIGV2aWRlbmNlLmAsXG4gICAgICApO1xuICAgIH1cbiAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICB9XG4gIHJldHVybiBsaW5lcy5qb2luKFwiXFxuXCIpLnRyaW1FbmQoKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGJ1aWxkUGFyYWxsZWxSZXNlYXJjaFNsaWNlc1Byb21wdChcbiAgbWlkOiBzdHJpbmcsXG4gIG1pZFRpdGxlOiBzdHJpbmcsXG4gIHNsaWNlczogQXJyYXk8eyBpZDogc3RyaW5nOyB0aXRsZTogc3RyaW5nIH0+LFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICBzdWJhZ2VudE1vZGVsPzogc3RyaW5nLFxuKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgLy8gQnVpbGQgaW5kaXZpZHVhbCByZXNlYXJjaC1zbGljZSBwcm9tcHRzIGZvciBlYWNoIHNsaWNlXG4gIGNvbnN0IHN1YmFnZW50U2VjdGlvbnM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IG1vZGVsU3VmZml4ID0gc3ViYWdlbnRNb2RlbCA/IGAgd2l0aCBtb2RlbDogXCIke3N1YmFnZW50TW9kZWx9XCJgIDogXCJcIjtcbiAgZm9yIChjb25zdCBzbGljZSBvZiBzbGljZXMpIHtcbiAgICBjb25zdCBzbGljZVByb21wdCA9IGF3YWl0IGJ1aWxkUmVzZWFyY2hTbGljZVByb21wdChtaWQsIG1pZFRpdGxlLCBzbGljZS5pZCwgc2xpY2UudGl0bGUsIGJhc2VQYXRoLCB7IGNvbnRleHRNb2RlUmVuZGVyTW9kZTogXCJuZXN0ZWRcIiB9KTtcbiAgICBzdWJhZ2VudFNlY3Rpb25zLnB1c2goW1xuICAgICAgYCMjIyAke3NsaWNlLmlkfTogJHtzbGljZS50aXRsZX1gLFxuICAgICAgXCJcIixcbiAgICAgIGBVc2UgdGhpcyBhcyB0aGUgcHJvbXB0IGZvciBhIFxcYHN1YmFnZW50XFxgIGNhbGwke21vZGVsU3VmZml4fSAoYWdlbnQ6IFxcYHNjb3V0XFxgKTpgLFxuICAgICAgXCJcIixcbiAgICAgIFwiYGBgXCIsXG4gICAgICBzbGljZVByb21wdCxcbiAgICAgIFwiYGBgXCIsXG4gICAgXS5qb2luKFwiXFxuXCIpKTtcbiAgfVxuXG4gIHJldHVybiBsb2FkUHJvbXB0KFwicGFyYWxsZWwtcmVzZWFyY2gtc2xpY2VzXCIsIHtcbiAgICB3b3JraW5nRGlyZWN0b3J5OiBiYXNlUGF0aCxcbiAgICBtaWQsXG4gICAgbWlkVGl0bGUsXG4gICAgc2xpY2VDb3VudDogU3RyaW5nKHNsaWNlcy5sZW5ndGgpLFxuICAgIHNsaWNlTGlzdDogc2xpY2VzLm1hcCgocykgPT4gYC0gKioke3MuaWR9Kio6ICR7cy50aXRsZX1gKS5qb2luKFwiXFxuXCIpLFxuICAgIHN1YmFnZW50UHJvbXB0czogc3ViYWdlbnRTZWN0aW9ucy5qb2luKFwiXFxuXFxuLS0tXFxuXFxuXCIpLFxuICB9KTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGJ1aWxkR2F0ZUV2YWx1YXRlUHJvbXB0KFxuICBtaWQ6IHN0cmluZywgbWlkVGl0bGU6IHN0cmluZywgc2lkOiBzdHJpbmcsIHNUaXRsZTogc3RyaW5nLFxuICBiYXNlOiBzdHJpbmcsXG4gIHN1YmFnZW50TW9kZWw/OiBzdHJpbmcsXG4pOiBQcm9taXNlPHN0cmluZz4ge1xuICAvLyBQdWxsIG9ubHkgdGhlIGdhdGVzIHRoaXMgdHVybiBhY3R1YWxseSBvd25zIChRMy9RNCkuIEZpbHRlciB2aWEgdGhlXG4gIC8vIHJlZ2lzdHJ5IHNvIHRoYXQgc2NvcGU6XCJzbGljZVwiIGdhdGVzIG93bmVkIGJ5IG90aGVyIHR1cm5zIChROCkgY2FuJ3RcbiAgLy8gbGVhayBpbnRvIHRoaXMgcHJvbXB0IGFuZCBjYW4ndCBibG9jayBkaXNwYXRjaCB2aWEgc2lsZW50IHNraXAuXG4gIGNvbnN0IHBlbmRpbmcgPSBnZXRQZW5kaW5nR2F0ZXNGb3JUdXJuKG1pZCwgc2lkLCBcImdhdGUtZXZhbHVhdGVcIik7XG5cbiAgLy8gRmFpbHMgbG91ZGx5IGlmIHRoZSBwZW5kaW5nIGxpc3QgY29udGFpbnMgYSBnYXRlIGlkIHRoZSByZWdpc3RyeVxuICAvLyBkb2Vzbid0IG93biBmb3IgdGhpcyB0dXJuLiBNaXNzaW5nIG93bmVkIGdhdGVzIGlzIGFsbG93ZWQgaGVyZSBcdTIwMTRcbiAgLy8gYGdhdGUtZXZhbHVhdGVgIGlzIGRpc3BhdGNoZWQgd2hlbmV2ZXIgKmFueSogb2YgaXRzIG93bmVkIGdhdGVzIGFyZVxuICAvLyBwZW5kaW5nLCBub3Qgb25seSB3aGVuIGFsbCBvZiB0aGVtIGFyZS5cbiAgYXNzZXJ0R2F0ZUNvdmVyYWdlKHBlbmRpbmcsIFwiZ2F0ZS1ldmFsdWF0ZVwiLCB7IHJlcXVpcmVBbGw6IGZhbHNlIH0pO1xuXG4gIC8vIExvYWQgdGhlIHNsaWNlIHBsYW4gZm9yIGNvbnRleHRcbiAgY29uc3QgcGxhbkZpbGUgPSByZXNvbHZlU2xpY2VGaWxlKGJhc2UsIG1pZCwgc2lkLCBcIlBMQU5cIik7XG4gIGNvbnN0IHBsYW5Db250ZW50ID0gcGxhbkZpbGUgPyAoYXdhaXQgbG9hZEZpbGUocGxhbkZpbGUpKSA/PyBcIihwbGFuIGZpbGUgZW1wdHkpXCIgOiBcIihwbGFuIGZpbGUgbm90IGZvdW5kKVwiO1xuXG4gIC8vIEJ1aWxkIHBlci1nYXRlIHN1YmFnZW50IHByb21wdHMgZnJvbSB0aGUgcGVuZGluZyByb3dzLiBCZWNhdXNlIHRoZVxuICAvLyByZWdpc3RyeSBoYXMgYWxyZWFkeSB2YWxpZGF0ZWQgZXZlcnkgcm93LCBgZ2V0R2F0ZURlZmluaXRpb25gIGNhbm5vdFxuICAvLyByZXR1cm4gdW5kZWZpbmVkIGhlcmUuXG4gIGNvbnN0IHBlbmRpbmdJZHMgPSBuZXcgU2V0KHBlbmRpbmcubWFwKChnKSA9PiBnLmdhdGVfaWQpKTtcbiAgY29uc3QgZ2F0ZURlZnMgPSBnZXRHYXRlc0ZvclR1cm4oXCJnYXRlLWV2YWx1YXRlXCIpLmZpbHRlcigoZGVmKSA9PiBwZW5kaW5nSWRzLmhhcyhkZWYuaWQpKTtcblxuICBjb25zdCBzdWJhZ2VudFNlY3Rpb25zOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBnYXRlTGlzdExpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBub3JtYWxpemVkQmFzZSA9IGJhc2UucmVwbGFjZUFsbChcIlxcXFxcIiwgXCIvXCIpO1xuXG4gIGZvciAoY29uc3QgZGVmIG9mIGdhdGVEZWZzKSB7XG4gICAgZ2F0ZUxpc3RMaW5lcy5wdXNoKGAtICoqJHtkZWYuaWR9Kio6ICR7ZGVmLnF1ZXN0aW9ufWApO1xuXG4gICAgY29uc3Qgc3ViUHJvbXB0ID0gW1xuICAgICAgcmVuZGVyQ29udGV4dE1vZGVGb3JQcm9tcHQoXCJnYXRlLWV2YWx1YXRlXCIsIGJhc2UsIFwibmVzdGVkXCIpLFxuICAgICAgXCJcIixcbiAgICAgIGBZb3UgYXJlIGV2YWx1YXRpbmcgcXVhbGl0eSBnYXRlICoqJHtkZWYuaWR9KiogZm9yIHNsaWNlICR7c2lkfSAoJHtzVGl0bGV9KS5gLFxuICAgICAgXCJcIixcbiAgICAgIGAqKldvcmtpbmcgZGlyZWN0b3J5OioqIFxcYCR7bm9ybWFsaXplZEJhc2V9XFxgLiBBbGwgZmlsZSByZWFkcywgd3JpdGVzLCBhbmQgc2hlbGwgY29tbWFuZHMgTVVTVCBvcGVyYXRlIHJlbGF0aXZlIHRvIHRoaXMgZGlyZWN0b3J5LiBEbyBOT1QgXFxgY2RcXGAgdG8gYW55IG90aGVyIGRpcmVjdG9yeS5gLFxuICAgICAgXCJcIixcbiAgICAgIGAjIyBRdWVzdGlvbjogJHtkZWYucXVlc3Rpb259YCxcbiAgICAgIFwiXCIsXG4gICAgICBkZWYuZ3VpZGFuY2UsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBTbGljZSBQbGFuXCIsXG4gICAgICBcIlwiLFxuICAgICAgcGxhbkNvbnRlbnQsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBJbnN0cnVjdGlvbnNcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIkFuYWx5emUgdGhlIHNsaWNlIHBsYW4gYWJvdmUgYW5kIGFuc3dlciB0aGUgZ2F0ZSBxdWVzdGlvbi5cIixcbiAgICAgIGBDYWxsIHRoZSBcXGBnc2Rfc2F2ZV9nYXRlX3Jlc3VsdFxcYCB0b29sIHdpdGg6YCxcbiAgICAgIGAtIFxcYG1pbGVzdG9uZUlkXFxgOiBcIiR7bWlkfVwiYCxcbiAgICAgIGAtIFxcYHNsaWNlSWRcXGA6IFwiJHtzaWR9XCJgLFxuICAgICAgYC0gXFxgZ2F0ZUlkXFxgOiBcIiR7ZGVmLmlkfVwiYCxcbiAgICAgIFwiLSBgdmVyZGljdGA6IFxcXCJwYXNzXFxcIiAobm8gY29uY2VybnMpLCBcXFwiZmxhZ1xcXCIgKGNvbmNlcm5zIGZvdW5kKSwgb3IgXFxcIm9taXR0ZWRcXFwiIChub3QgYXBwbGljYWJsZSlcIixcbiAgICAgIFwiLSBgcmF0aW9uYWxlYDogb25lLXNlbnRlbmNlIGp1c3RpZmljYXRpb25cIixcbiAgICAgIFwiLSBgZmluZGluZ3NgOiBkZXRhaWxlZCBtYXJrZG93biBmaW5kaW5ncyAob3IgZW1wdHkgaWYgb21pdHRlZClcIixcbiAgICBdLmpvaW4oXCJcXG5cIik7XG5cbiAgICBjb25zdCBtb2RlbFN1ZmZpeCA9IHN1YmFnZW50TW9kZWwgPyBgIHdpdGggbW9kZWw6IFwiJHtzdWJhZ2VudE1vZGVsfVwiYCA6IFwiXCI7XG4gICAgc3ViYWdlbnRTZWN0aW9ucy5wdXNoKFtcbiAgICAgIGAjIyMgJHtkZWYuaWR9OiAke2RlZi5xdWVzdGlvbn1gLFxuICAgICAgXCJcIixcbiAgICAgIGBVc2UgdGhpcyBhcyB0aGUgcHJvbXB0IGZvciBhIFxcYHN1YmFnZW50XFxgIGNhbGwke21vZGVsU3VmZml4fSAoYWdlbnQ6IFxcYHRlc3RlclxcYCk6YCxcbiAgICAgIFwiXCIsXG4gICAgICBcImBgYFwiLFxuICAgICAgc3ViUHJvbXB0LFxuICAgICAgXCJgYGBcIixcbiAgICBdLmpvaW4oXCJcXG5cIikpO1xuICB9XG5cbiAgcmV0dXJuIGxvYWRQcm9tcHQoXCJnYXRlLWV2YWx1YXRlXCIsIHtcbiAgICB3b3JraW5nRGlyZWN0b3J5OiBiYXNlLFxuICAgIG1pbGVzdG9uZUlkOiBtaWQsXG4gICAgbWlsZXN0b25lVGl0bGU6IG1pZFRpdGxlLFxuICAgIHNsaWNlSWQ6IHNpZCxcbiAgICBzbGljZVRpdGxlOiBzVGl0bGUsXG4gICAgc2xpY2VQbGFuQ29udGVudDogcHJlcGVuZENvbnRleHRNb2RlVG9CbG9jayhcImdhdGUtZXZhbHVhdGVcIiwgYmFzZSwgcGxhbkNvbnRlbnQpLFxuICAgIGdhdGVDb3VudDogU3RyaW5nKHBlbmRpbmcubGVuZ3RoKSxcbiAgICBnYXRlTGlzdDogZ2F0ZUxpc3RMaW5lcy5qb2luKFwiXFxuXCIpLFxuICAgIHN1YmFnZW50UHJvbXB0czogc3ViYWdlbnRTZWN0aW9ucy5qb2luKFwiXFxuXFxuLS0tXFxuXFxuXCIpLFxuICB9KTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGJ1aWxkUmV3cml0ZURvY3NQcm9tcHQoXG4gIG1pZDogc3RyaW5nLCBtaWRUaXRsZTogc3RyaW5nLFxuICBhY3RpdmVTbGljZTogeyBpZDogc3RyaW5nOyB0aXRsZTogc3RyaW5nIH0gfCBudWxsLFxuICBiYXNlOiBzdHJpbmcsXG4gIG92ZXJyaWRlczogT3ZlcnJpZGVbXSxcbik6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IHNpZCA9IGFjdGl2ZVNsaWNlPy5pZDtcbiAgY29uc3Qgc1RpdGxlID0gYWN0aXZlU2xpY2U/LnRpdGxlID8/IFwiXCI7XG4gIGNvbnN0IGRvY0xpc3Q6IHN0cmluZ1tdID0gW107XG5cbiAgaWYgKHNpZCkge1xuICAgIGNvbnN0IHNsaWNlUGxhblBhdGggPSByZXNvbHZlU2xpY2VGaWxlKGJhc2UsIG1pZCwgc2lkLCBcIlBMQU5cIik7XG4gICAgY29uc3Qgc2xpY2VQbGFuUmVsID0gcmVsU2xpY2VGaWxlKGJhc2UsIG1pZCwgc2lkLCBcIlBMQU5cIik7XG4gICAgaWYgKHNsaWNlUGxhblBhdGgpIHtcbiAgICAgIGRvY0xpc3QucHVzaChgLSBTbGljZSBwbGFuOiBcXGAke3NsaWNlUGxhblJlbH1cXGBgKTtcbiAgICAgIGNvbnN0IHREaXIgPSByZXNvbHZlVGFza3NEaXIoYmFzZSwgbWlkLCBzaWQpO1xuICAgICAgaWYgKHREaXIpIHtcbiAgICAgICAgLy8gREIgcHJpbWFyeSBwYXRoIFx1MjAxNCBnZXQgaW5jb21wbGV0ZSB0YXNrc1xuICAgICAgICBsZXQgaW5jb21wbGV0ZVRhc2tzOiB7IGlkOiBzdHJpbmcgfVtdIHwgbnVsbCA9IG51bGw7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgeyBpc0RiQXZhaWxhYmxlLCBnZXRTbGljZVRhc2tzIH0gPSBhd2FpdCBpbXBvcnQoXCIuL2dzZC1kYi5qc1wiKTtcbiAgICAgICAgICBpZiAoaXNEYkF2YWlsYWJsZSgpKSB7XG4gICAgICAgICAgICBpbmNvbXBsZXRlVGFza3MgPSBnZXRTbGljZVRhc2tzKG1pZCwgc2lkKVxuICAgICAgICAgICAgICAuZmlsdGVyKHQgPT4gdC5zdGF0dXMgIT09IFwiY29tcGxldGVcIiAmJiB0LnN0YXR1cyAhPT0gXCJkb25lXCIpXG4gICAgICAgICAgICAgIC5tYXAodCA9PiAoeyBpZDogdC5pZCB9KSk7XG4gICAgICAgICAgfVxuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICBsb2dXYXJuaW5nKFwicHJvbXB0XCIsIGBidWlsZFJld3JpdGVEb2NzUHJvbXB0IERCIHRhc2sgbG9va3VwIGZhaWxlZDogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIWluY29tcGxldGVUYXNrcykge1xuICAgICAgICAgIC8vIERCIHVuYXZhaWxhYmxlIFx1MjAxNCBubyB0YXNrIGRhdGEgdG8gaW5saW5lXG4gICAgICAgICAgaW5jb21wbGV0ZVRhc2tzID0gW107XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5jb21wbGV0ZVRhc2tzKSB7XG4gICAgICAgICAgZm9yIChjb25zdCB0YXNrIG9mIGluY29tcGxldGVUYXNrcykge1xuICAgICAgICAgICAgY29uc3QgdGFza1BsYW5QYXRoID0gcmVzb2x2ZVRhc2tGaWxlKGJhc2UsIG1pZCwgc2lkLCB0YXNrLmlkLCBcIlBMQU5cIik7XG4gICAgICAgICAgICBpZiAodGFza1BsYW5QYXRoKSB7XG4gICAgICAgICAgICAgIGNvbnN0IHRhc2tSZWxQYXRoID0gYCR7cmVsU2xpY2VQYXRoKGJhc2UsIG1pZCwgc2lkKX0vdGFza3MvJHt0YXNrLmlkfS1QTEFOLm1kYDtcbiAgICAgICAgICAgICAgZG9jTGlzdC5wdXNoKGAtIFRhc2sgcGxhbjogXFxgJHt0YXNrUmVsUGF0aH1cXGBgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBjb25zdCBkZWNpc2lvbnNQYXRoID0gcmVzb2x2ZUdzZFJvb3RGaWxlKGJhc2UsIFwiREVDSVNJT05TXCIpO1xuICBpZiAoZXhpc3RzU3luYyhkZWNpc2lvbnNQYXRoKSkgZG9jTGlzdC5wdXNoKGAtIERlY2lzaW9uczogXFxgJHtyZWxHc2RSb290RmlsZShcIkRFQ0lTSU9OU1wiKX1cXGBgKTtcbiAgY29uc3QgcmVxdWlyZW1lbnRzUGF0aCA9IHJlc29sdmVHc2RSb290RmlsZShiYXNlLCBcIlJFUVVJUkVNRU5UU1wiKTtcbiAgaWYgKGV4aXN0c1N5bmMocmVxdWlyZW1lbnRzUGF0aCkpIGRvY0xpc3QucHVzaChgLSBSZXF1aXJlbWVudHM6IFxcYCR7cmVsR3NkUm9vdEZpbGUoXCJSRVFVSVJFTUVOVFNcIil9XFxgYCk7XG4gIGNvbnN0IHByb2plY3RQYXRoID0gcmVzb2x2ZUdzZFJvb3RGaWxlKGJhc2UsIFwiUFJPSkVDVFwiKTtcbiAgaWYgKGV4aXN0c1N5bmMocHJvamVjdFBhdGgpKSBkb2NMaXN0LnB1c2goYC0gUHJvamVjdDogXFxgJHtyZWxHc2RSb290RmlsZShcIlBST0pFQ1RcIil9XFxgYCk7XG4gIGNvbnN0IGNvbnRleHRQYXRoID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZSwgbWlkLCBcIkNPTlRFWFRcIik7XG4gIGNvbnN0IGNvbnRleHRSZWwgPSByZWxNaWxlc3RvbmVGaWxlKGJhc2UsIG1pZCwgXCJDT05URVhUXCIpO1xuICBpZiAoY29udGV4dFBhdGgpIGRvY0xpc3QucHVzaChgLSBNaWxlc3RvbmUgY29udGV4dCAocmVmZXJlbmNlIG9ubHkpOiBcXGAke2NvbnRleHRSZWx9XFxgYCk7XG4gIGNvbnN0IHJvYWRtYXBQYXRoID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZSwgbWlkLCBcIlJPQURNQVBcIik7XG4gIGNvbnN0IHJvYWRtYXBSZWwgPSByZWxNaWxlc3RvbmVGaWxlKGJhc2UsIG1pZCwgXCJST0FETUFQXCIpO1xuICBpZiAocm9hZG1hcFBhdGgpIGRvY0xpc3QucHVzaChgLSBSb2FkbWFwOiBcXGAke3JvYWRtYXBSZWx9XFxgYCk7XG5cbiAgY29uc3Qgb3ZlcnJpZGVDb250ZW50ID0gb3ZlcnJpZGVzLm1hcCgobywgaSkgPT4gW1xuICAgIGAjIyMgT3ZlcnJpZGUgJHtpICsgMX1gLFxuICAgIGAqKkNoYW5nZToqKiAke28uY2hhbmdlfWAsXG4gICAgYCoqSXNzdWVkOioqICR7by50aW1lc3RhbXB9YCxcbiAgICBgKipEdXJpbmc6KiogJHtvLmFwcGxpZWRBdH1gLFxuICBdLmpvaW4oXCJcXG5cIikpLmpvaW4oXCJcXG5cXG5cIik7XG5cbiAgY29uc3QgZG9jdW1lbnRMaXN0ID0gZG9jTGlzdC5sZW5ndGggPiAwID8gZG9jTGlzdC5qb2luKFwiXFxuXCIpIDogXCItIE5vIGFjdGl2ZSBwbGFuIGRvY3VtZW50cyBmb3VuZC5cIjtcblxuICByZXR1cm4gcHJlcGVuZENvbnRleHRNb2RlVG9CbG9jayhcInJld3JpdGUtZG9jc1wiLCBiYXNlLCBsb2FkUHJvbXB0KFwicmV3cml0ZS1kb2NzXCIsIHtcbiAgICB3b3JraW5nRGlyZWN0b3J5OiBiYXNlLFxuICAgIG1pbGVzdG9uZUlkOiBtaWQsXG4gICAgbWlsZXN0b25lVGl0bGU6IG1pZFRpdGxlLFxuICAgIHNsaWNlSWQ6IHNpZCA/PyBcIm5vbmVcIixcbiAgICBzbGljZVRpdGxlOiBzVGl0bGUsXG4gICAgb3ZlcnJpZGVDb250ZW50LFxuICAgIGRvY3VtZW50TGlzdCxcbiAgICBvdmVycmlkZXNQYXRoOiByZWxHc2RSb290RmlsZShcIk9WRVJSSURFU1wiKSxcbiAgfSkpO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBUUEsU0FBUyxVQUFV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QUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRixFQUFFLEtBQUssSUFBSTtBQUFBLElBQ1gsZ0JBQWdCO0FBQUEsTUFDZDtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFB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RSxnQkFBSSxjQUFjO0FBQ2hCLG9CQUFNLGNBQWMsR0FBRyxhQUFhLE1BQU0sS0FBSyxHQUFHLENBQUMsVUFBVSxLQUFLLEVBQUU7QUFDcEUsc0JBQVEsS0FBSyxrQkFBa0IsV0FBVyxJQUFJO0FBQUEsWUFDaEQ7QUFBQSxVQUNGO0FBQUEsUUFDRjtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUVBLFFBQU0sZ0JBQWdCLG1CQUFtQixNQUFNLFdBQVc7QUFDMUQsTUFBSSxXQUFXLGFBQWEsRUFBRyxTQUFRLEtBQUssa0JBQWtCLGVBQWUsV0FBVyxDQUFDLElBQUk7QUFDN0YsUUFBTSxtQkFBbUIsbUJBQW1CLE1BQU0sY0FBYztBQUNoRSxNQUFJLFdBQVcsZ0JBQWdCLEVBQUcsU0FBUSxLQUFLLHFCQUFxQixlQUFlLGNBQWMsQ0FBQyxJQUFJO0FBQ3RHLFFBQU0sY0FBYyxtQkFBbUIsTUFBTSxTQUFTO0FBQ3RELE1BQUksV0FBVyxXQUFXLEVBQUcsU0FBUSxLQUFLLGdCQUFnQixlQUFlLFNBQVMsQ0FBQyxJQUFJO0FBQ3ZGLFFBQU0sY0FBYyxxQkFBcUIsTUFBTSxLQUFLLFNBQVM7QUFDN0QsUUFBTSxhQUFhLGlCQUFpQixNQUFNLEtBQUssU0FBUztBQUN4RCxNQUFJLFlBQWEsU0FBUSxLQUFLLDJDQUEyQyxVQUFVLElBQUk7QUFDdkYsUUFBTSxjQUFjLHFCQUFxQixNQUFNLEtBQUssU0FBUztBQUM3RCxRQUFNLGFBQWEsaUJBQWlCLE1BQU0sS0FBSyxTQUFTO0FBQ3hELE1BQUksWUFBYSxTQUFRLEtBQUssZ0JBQWdCLFVBQVUsSUFBSTtBQUU1RCxRQUFNLGtCQUFrQixVQUFVLElBQUksQ0FBQyxHQUFHLE1BQU07QUFBQSxJQUM5QyxnQkFBZ0IsSUFBSSxDQUFDO0FBQUEsSUFDckIsZUFBZSxFQUFFLE1BQU07QUFBQSxJQUN2QixlQUFlLEVBQUUsU0FBUztBQUFBLElBQzFCLGVBQWUsRUFBRSxTQUFTO0FBQUEsRUFDNUIsRUFBRSxLQUFLLElBQUksQ0FBQyxFQUFFLEtBQUssTUFBTTtBQUV6QixRQUFNLGVBQWUsUUFBUSxTQUFTLElBQUksUUFBUSxLQUFLLElBQUksSUFBSTtBQUUvRCxTQUFPLDBCQUEwQixnQkFBZ0IsTUFBTSxXQUFXLGdCQUFnQjtBQUFBLElBQ2hGLGtCQUFrQjtBQUFBLElBQ2xCLGFBQWE7QUFBQSxJQUNiLGdCQUFnQjtBQUFBLElBQ2hCLFNBQVMsT0FBTztBQUFBLElBQ2hCLFlBQVk7QUFBQSxJQUNaO0FBQUEsSUFDQTtBQUFBLElBQ0EsZUFBZSxlQUFlLFdBQVc7QUFBQSxFQUMzQyxDQUFDLENBQUM7QUFDSjsiLAogICJuYW1lcyI6IFsiaXRlbSJdCn0K
