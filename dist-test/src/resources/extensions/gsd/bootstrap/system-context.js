import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { logWarning } from "../workflow-logger.js";
import { debugTime } from "../debug-logger.js";
import { loadPrompt, getTemplatesDir } from "../prompt-loader.js";
import { readForensicsMarker } from "../forensics.js";
import { resolveAllSkillReferences, renderPreferencesForSystemPrompt, loadEffectiveGSDPreferences } from "../preferences.js";
import { resolveModelWithFallbacksForUnit } from "../preferences-models.js";
import { resolveSkillReference } from "../preferences-skills.js";
import { resolveGsdRootFile, resolveSliceFile, resolveSlicePath, resolveTaskFile, resolveTaskFiles, resolveTasksDir, relSliceFile, relSlicePath, relTaskFile } from "../paths.js";
import { extractIntroAndRules } from "../knowledge-parser.js";
import { ensureCodebaseMapFresh, readCodebaseMap } from "../codebase-generator.js";
import { hasSkillSnapshot, detectNewSkills, formatSkillsXml } from "../skill-discovery.js";
import { getActiveAutoWorktreeContext } from "../auto-worktree.js";
import { getActiveWorktreeName, getWorktreeOriginalCwd } from "../worktree-session-state.js";
import { deriveState } from "../state.js";
import { formatOverridesSection, formatShortcut, loadActiveOverrides, loadFile, parseContinue, parseSummary } from "../files.js";
import { toPosixPath } from "../../shared/mod.js";
import { autoEnableCmuxPreferences } from "../commands-cmux.js";
import { gsdHome } from "../gsd-home.js";
const DEFAULT_CONTEXT_MESSAGE_MAX_CHARS = 4e3;
const DEFAULT_KNOWLEDGE_MAX_CHARS = 12e3;
const DEFAULT_CODEBASE_MAX_CHARS = 8e3;
const MIN_CONTEXT_MESSAGE_MAX_CHARS = 1e3;
const MIN_KNOWLEDGE_MAX_CHARS = 1e3;
const BUNDLED_SKILL_TRIGGERS = [
  { trigger: "Frontend UI - web components, pages, landing pages, dashboards, React/HTML/CSS, styling", skill: "frontend-design" },
  { trigger: "macOS or iOS apps - SwiftUI, Xcode, App Store", skill: "swiftui" },
  { trigger: "Debugging - complex bugs, failing tests, root-cause investigation after standard approaches fail", skill: "debug-like-expert" },
  { trigger: "Code review - security, performance, bugs, quality review of staged/unstaged diffs or PRs", skill: "review" },
  { trigger: "Test generation or execution - auto-detect framework, generate tests, run suite, analyze failures", skill: "test" },
  { trigger: "Linting/formatting - run the detected linter/formatter with auto-fix, report remaining issues", skill: "lint" },
  { trigger: "Polishing UI details - animations, hover states, typography, borders, micro-interactions, optical alignment", skill: "make-interfaces-feel-better" },
  { trigger: "Accessibility audit - WCAG, screen reader, keyboard navigation, a11y review", skill: "accessibility" },
  { trigger: "Planning interviews - stress-test a plan, grill the user, resolve decision trees one branch at a time", skill: "grill-me" },
  { trigger: "Interface design - produce 3+ radically different designs for a module/API, compare in prose, synthesize", skill: "design-an-interface" },
  { trigger: "TDD - red-green-refactor vertical slices, never refactor while red, tests survive refactors", skill: "tdd" },
  { trigger: "Draft a milestone brief (M###-CONTEXT.md) or PRD from current conversation context", skill: "write-milestone-brief" },
  { trigger: "Break a plan into vertical-slice roadmap slices (M###-ROADMAP.md) or GitHub issues with dependency ordering", skill: "decompose-into-slices" },
  { trigger: "Package spike findings into a reusable project-local skill at .claude/skills/", skill: "spike-wrap-up" },
  { trigger: "Block completion claims until verification evidence has been produced in this message", skill: "verify-before-complete" },
  { trigger: "Create a Model Context Protocol (MCP) server \u2014 tool design, error handling, Inspector testing, evals", skill: "create-mcp-server" },
  { trigger: "Write documentation, proposals, specs, RFCs, or READMEs for a fresh reader", skill: "write-docs" },
  { trigger: "Post-mortem a failed GSD auto-mode run using .gsd/activity, .gsd/journal, and .gsd/metrics.json", skill: "forensics" },
  { trigger: "Prepare a clean cross-session handoff \u2014 continue.md + summary updates (pause/resume work)", skill: "handoff" },
  { trigger: "Security review with STRIDE threat modeling and exploit-scenario reporting", skill: "security-review" },
  { trigger: "HTTP/REST/GraphQL API design \u2014 verbs, status codes, pagination, errors, idempotency, versioning", skill: "api-design" },
  { trigger: "Dependency upgrades \u2014 risk-batched, verified between batches, one major per commit", skill: "dependency-upgrade" },
  { trigger: "Agent-first observability \u2014 structured logs, persisted failure state, health surfaces, explicit failure modes", skill: "observability" },
  { trigger: "React/Next.js performance \u2014 components, data fetching, bundle optimization, rendering patterns from Vercel Engineering", skill: "react-best-practices" },
  { trigger: "Core Web Vitals \u2014 fix LCP, CLS, INP; layout shifts; page experience optimization", skill: "core-web-vitals" },
  { trigger: "GitHub Actions CI/CD \u2014 write, run, and debug workflow files; live syntax and run monitoring", skill: "github-workflows" },
  { trigger: "Comprehensive web quality audit \u2014 performance, accessibility, SEO, and best-practices (Lighthouse-style)", skill: "web-quality-audit" },
  { trigger: "Browser automation \u2014 open sites, fill forms, click, screenshot, scrape, or test web apps programmatically", skill: "agent-browser" },
  { trigger: "Review UI code for Web Interface Guidelines compliance \u2014 UX, design, and accessibility patterns", skill: "web-design-guidelines" },
  { trigger: "UI/UX patterns reference \u2014 animations, CSS, typography, prefetching, icons (file:line findings)", skill: "userinterface-wiki" },
  { trigger: "Author or refine a GSD skill \u2014 SKILL.md structure, frontmatter, and best practices", skill: "create-skill" },
  { trigger: "Create or debug a GSD extension \u2014 tools, commands, event hooks, custom TUI, providers", skill: "create-gsd-extension" },
  { trigger: "Author a YAML workflow definition \u2014 steps, triggers, and templates", skill: "create-workflow" },
  { trigger: "Deep code optimization audit \u2014 perf anti-patterns, memory leaks, algorithmic complexity, bundle size, I/O, caching, dead code (parallel pattern-based hunt)", skill: "code-optimizer" }
];
function buildBundledSkillsTable() {
  const cwd = process.cwd();
  const rows = [];
  for (const { trigger, skill } of BUNDLED_SKILL_TRIGGERS) {
    const resolution = resolveSkillReference(skill, cwd);
    if (resolution.method === "unresolved") continue;
    rows.push(`| ${trigger} | \`${resolution.resolvedPath}\` |`);
  }
  if (rows.length === 0) {
    return "*No bundled skills found. Install skills to `~/.agents/skills/` or `~/.claude/skills/`.*";
  }
  return `| Trigger | Skill to load |
|---|---|
${rows.join("\n")}`;
}
function warnDeprecatedAgentInstructions() {
  const paths = [
    join(gsdHome(), "agent-instructions.md"),
    join(process.cwd(), ".gsd", "agent-instructions.md")
  ];
  for (const path of paths) {
    if (existsSync(path)) {
      console.warn(
        `[GSD] DEPRECATED: ${path} is no longer loaded. Migrate your instructions to AGENTS.md (or CLAUDE.md) in the same directory. See https://github.com/gsd-build/GSD-2/issues/1492`
      );
    }
  }
}
async function buildBeforeAgentStartResult(event, ctx) {
  if (!existsSync(join(process.cwd(), ".gsd"))) return void 0;
  const stopContextTimer = debugTime("context-inject");
  const systemContent = loadPrompt("system", {
    bundledSkillsTable: buildBundledSkillsTable(),
    templatesDir: getTemplatesDir(),
    shortcutDashboard: formatShortcut("Ctrl+Alt+G"),
    shortcutShell: formatShortcut("Ctrl+Alt+B")
  });
  let loadedPreferences = loadEffectiveGSDPreferences();
  try {
    const { markCmuxPromptShown, shouldPromptToEnableCmux } = await import("../../cmux/index.js");
    if (shouldPromptToEnableCmux(loadedPreferences?.preferences)) {
      markCmuxPromptShown();
      if (autoEnableCmuxPreferences()) {
        loadedPreferences = loadEffectiveGSDPreferences();
        ctx.ui.notify(
          "cmux detected \u2014 auto-enabled. Run /gsd cmux off to disable.",
          "info"
        );
      }
    }
  } catch (e) {
    logWarning("bootstrap", `cmux prompt setup skipped: ${e.message}`);
  }
  const ctxProjectRoot = ctx.projectRoot;
  const basePath = typeof ctxProjectRoot === "string" && ctxProjectRoot.length > 0 ? ctxProjectRoot : process.cwd();
  let preferenceBlock = "";
  if (loadedPreferences) {
    const cwd = basePath;
    const report = resolveAllSkillReferences(loadedPreferences.preferences, cwd);
    preferenceBlock = `

${renderPreferencesForSystemPrompt(loadedPreferences.preferences, report.resolutions)}`;
    if (report.warnings.length > 0) {
      ctx.ui.notify(
        `GSD skill preferences: ${report.warnings.length} unresolved skill${report.warnings.length === 1 ? "" : "s"}: ${report.warnings.join(", ")}`,
        "warning"
      );
    }
  }
  try {
    const { backfillDecisionsToMemories } = await import("../memory-backfill.js");
    const written = backfillDecisionsToMemories();
    if (written > 0) {
      ctx.ui.notify(`GSD: backfilled ${written} decision${written === 1 ? "" : "s"} into the memory store.`, "info");
    }
  } catch (e) {
    logWarning("bootstrap", `decisions backfill failed: ${e.message}`);
  }
  try {
    const { backfillKnowledgeToMemories } = await import("../knowledge-backfill.js");
    const writtenK = backfillKnowledgeToMemories(basePath);
    if (writtenK > 0) {
      ctx.ui.notify(`GSD: backfilled ${writtenK} KNOWLEDGE.md row${writtenK === 1 ? "" : "s"} into the memory store.`, "info");
    }
  } catch (e) {
    logWarning("bootstrap", `KNOWLEDGE.md backfill failed: ${e.message}`);
  }
  try {
    const { renderKnowledgeProjection } = await import("../knowledge-projection.js");
    renderKnowledgeProjection(basePath);
  } catch (e) {
    logWarning("bootstrap", `KNOWLEDGE.md projection render failed: ${e.message}`);
  }
  try {
    const { reportConsolidationGaps } = await import("../memory-consolidation-scanner.js");
    reportConsolidationGaps(basePath);
  } catch (e) {
    logWarning("bootstrap", `memory consolidation scan failed: ${e.message}`);
  }
  const { block: knowledgeBlock, globalSizeKb } = loadKnowledgeBlock(gsdHome(), basePath);
  if (globalSizeKb > 4) {
    ctx.ui.notify(
      `GSD: ~/.gsd/agent/KNOWLEDGE.md is ${globalSizeKb.toFixed(1)}KB \u2014 consider trimming to keep system prompt lean.`,
      "warning"
    );
  }
  let newSkillsBlock = "";
  if (hasSkillSnapshot()) {
    const newSkills = detectNewSkills();
    if (newSkills.length > 0) {
      newSkillsBlock = formatSkillsXml(newSkills);
    }
  }
  let codebaseBlock = "";
  try {
    const codebaseOptions = loadedPreferences?.preferences?.codebase ? {
      excludePatterns: loadedPreferences.preferences.codebase.exclude_patterns,
      maxFiles: loadedPreferences.preferences.codebase.max_files,
      collapseThreshold: loadedPreferences.preferences.codebase.collapse_threshold
    } : void 0;
    ensureCodebaseMapFresh(process.cwd(), codebaseOptions);
  } catch (e) {
    logWarning("bootstrap", `CODEBASE refresh failed: ${e.message}`);
  }
  const codebasePath = resolveGsdRootFile(process.cwd(), "CODEBASE");
  const rawCodebase = readCodebaseMap(process.cwd());
  if (existsSync(codebasePath) && rawCodebase) {
    try {
      const rawContent = rawCodebase.trim();
      if (rawContent) {
        const generatedMatch = rawContent.match(/Generated: (\S+)/);
        const generatedAt = generatedMatch?.[1] ?? "unknown";
        const content = rawContent.length > DEFAULT_CODEBASE_MAX_CHARS ? rawContent.slice(0, DEFAULT_CODEBASE_MAX_CHARS) + "\n\n*(truncated \u2014 see .gsd/CODEBASE.md for full map)*" : rawContent;
        codebaseBlock = `

[PROJECT CODEBASE \u2014 File structure and descriptions (generated ${generatedAt}, auto-refreshed when GSD detects tracked file changes; use /gsd codebase stats for status)]

${content}`;
      }
    } catch (e) {
      logWarning("bootstrap", `CODEBASE file read failed: ${e.message}`);
    }
  }
  warnDeprecatedAgentInstructions();
  const injection = await buildGuidedExecuteContextInjection(event.prompt, process.cwd());
  const memoryBlock = await loadMemoryBlock(event.prompt ?? "", {
    includePromptRelevant: !(injection && isLowEntropyResumePrompt(event.prompt ?? ""))
  });
  const forensicsInjection = !injection ? buildForensicsContextInjection(process.cwd(), event.prompt) : null;
  const worktreeBlock = buildWorktreeContextBlock();
  const subagentModelConfig = resolveModelWithFallbacksForUnit("subagent");
  const subagentModelBlock = subagentModelConfig ? `

## Subagent Model

When spawning subagents via the \`subagent\` tool, always pass \`model: "${subagentModelConfig.primary}"\` in the tool call parameters. Never omit this \u2014 always specify it explicitly.` : "";
  const fullSystem = `${event.systemPrompt}

[SYSTEM CONTEXT \u2014 GSD]

${systemContent}${preferenceBlock}${knowledgeBlock}${codebaseBlock}${newSkillsBlock}${worktreeBlock}${subagentModelBlock}`;
  stopContextTimer({
    systemPromptSize: fullSystem.length,
    injectionSize: injection?.length ?? forensicsInjection?.length ?? 0,
    hasPreferences: preferenceBlock.length > 0,
    hasNewSkills: newSkillsBlock.length > 0
  });
  const contextMessage = buildContextMessage({ memoryBlock, injection, forensicsInjection });
  return {
    systemPrompt: fullSystem,
    ...contextMessage ? { message: contextMessage } : {}
  };
}
function buildContextMessage(opts) {
  const contextCharLimit = getContextMessageCharLimit();
  const memoryContent = markMemoryContextSupplied(opts.memoryBlock.trim());
  if (opts.injection) {
    const content = limitContextMessageContent(
      memoryContent ? `${memoryContent}

${opts.injection}` : opts.injection,
      contextCharLimit
    );
    return { customType: "gsd-guided-context", content, display: false };
  }
  if (opts.forensicsInjection) {
    const content = limitContextMessageContent(
      memoryContent ? `${memoryContent}

${opts.forensicsInjection}` : opts.forensicsInjection,
      contextCharLimit
    );
    return { customType: "gsd-forensics", content, display: false };
  }
  if (memoryContent) {
    return {
      customType: "gsd-memory",
      content: limitContextMessageContent(memoryContent, contextCharLimit),
      display: false
    };
  }
  return null;
}
function getContextMessageCharLimit() {
  const raw = process.env.PI_GSD_CONTEXT_MAX_CHARS;
  if (!raw) return DEFAULT_CONTEXT_MESSAGE_MAX_CHARS;
  if (raw === "0") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < MIN_CONTEXT_MESSAGE_MAX_CHARS) {
    return DEFAULT_CONTEXT_MESSAGE_MAX_CHARS;
  }
  return Math.floor(parsed);
}
function limitContextMessageContent(content, limit) {
  if (!limit || content.length <= limit) return content;
  const suffix = "\n\n[GSD Context Truncated]\nFull context is available from the referenced .gsd files and tools; read on demand only if this excerpt lacks required evidence.";
  const headBudget = Math.max(0, limit - suffix.length);
  return `${content.slice(0, headBudget).trimEnd()}${suffix}`;
}
function markMemoryContextSupplied(memoryContent) {
  if (!memoryContent) return "";
  return `[GSD Context Metadata]
- Memory supplied: yes

${memoryContent}`;
}
async function loadMemoryBlock(userPrompt, opts = {}) {
  try {
    const { formatMemoriesForPrompt, getActiveMemoriesRanked, queryMemoriesRanked } = await import("../memory-store.js");
    const CRITICAL_CATEGORIES = /* @__PURE__ */ new Set(["gotcha", "environment", "convention", "architecture"]);
    const CRITICAL_CAP = 8;
    const QUERY_K = 10;
    const CHAR_BUDGET = 4e3;
    const allRanked = getActiveMemoriesRanked(80);
    const critical = allRanked.filter((m) => CRITICAL_CATEGORIES.has(m.category)).slice(0, CRITICAL_CAP);
    const criticalIds = new Set(critical.map((m) => m.id));
    let relevant = [];
    const trimmed = userPrompt.trim();
    if (trimmed && opts.includePromptRelevant !== false) {
      const hits = queryMemoriesRanked({ query: trimmed, k: QUERY_K });
      relevant = hits.map((h) => h.memory).filter((m) => !criticalIds.has(m.id));
    }
    const merged = [...critical, ...relevant];
    if (merged.length === 0) return "";
    const formatted = formatMemoriesForPrompt(merged, CHAR_BUDGET);
    if (!formatted) return "";
    return `

[MEMORY \u2014 Critical and prompt-relevant memories from the GSD memory store]

${formatted}`;
  } catch (e) {
    logWarning("bootstrap", `memory block fetch failed: ${e.message}`);
    return "";
  }
}
function loadKnowledgeBlock(gsdHomeDir, cwd) {
  let globalKnowledge = "";
  let globalSizeKb = 0;
  const globalKnowledgePath = join(gsdHomeDir, "agent", "KNOWLEDGE.md");
  if (existsSync(globalKnowledgePath)) {
    try {
      const content = readFileSync(globalKnowledgePath, "utf-8").trim();
      if (content) {
        globalSizeKb = Buffer.byteLength(content, "utf-8") / 1024;
        globalKnowledge = content;
      }
    } catch (e) {
      logWarning("bootstrap", `global knowledge file read failed: ${e.message}`);
    }
  }
  let projectKnowledge = "";
  const knowledgePath = resolveGsdRootFile(cwd, "KNOWLEDGE");
  if (existsSync(knowledgePath)) {
    try {
      const raw = readFileSync(knowledgePath, "utf-8").trim();
      if (raw) projectKnowledge = extractIntroAndRules(raw).trim();
    } catch (e) {
      logWarning("bootstrap", `project knowledge file read failed: ${e.message}`);
    }
  }
  if (!globalKnowledge && !projectKnowledge) {
    return { block: "", globalSizeKb: 0 };
  }
  const parts = [];
  if (globalKnowledge) {
    parts.push(`## Global Knowledge
Source: \`${globalKnowledgePath}\`

${globalKnowledge}`);
  }
  if (projectKnowledge) {
    parts.push(`## Project Knowledge
Source: \`${knowledgePath}\`

${projectKnowledge}`);
  }
  const body = limitKnowledgeBlock(parts.join("\n\n"), getKnowledgeCharLimit());
  return {
    block: `

[KNOWLEDGE \u2014 Rules from KNOWLEDGE.md (Patterns and Lessons reach the LLM via the memory block)]

${body}`,
    globalSizeKb
  };
}
function getKnowledgeCharLimit() {
  const raw = process.env.PI_GSD_KNOWLEDGE_MAX_CHARS;
  if (!raw) return DEFAULT_KNOWLEDGE_MAX_CHARS;
  if (raw === "0") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < MIN_KNOWLEDGE_MAX_CHARS) {
    return DEFAULT_KNOWLEDGE_MAX_CHARS;
  }
  return Math.floor(parsed);
}
function limitKnowledgeBlock(content, limit) {
  if (!limit || content.length <= limit) return content;
  const suffix = "\n\n[Knowledge Truncated]\nFull KNOWLEDGE.md content remains available at the source path(s) above; read on demand only if this excerpt lacks a required rule.";
  const headBudget = Math.max(0, limit - suffix.length);
  return `${content.slice(0, headBudget).trimEnd()}${suffix}`;
}
function buildWorktreeContextBlock() {
  const worktreeName = getActiveWorktreeName();
  const worktreeMainCwd = getWorktreeOriginalCwd();
  const autoWorktree = getActiveAutoWorktreeContext();
  if (worktreeName && worktreeMainCwd) {
    return [
      "",
      "",
      "[WORKTREE CONTEXT \u2014 OVERRIDES CURRENT WORKING DIRECTORY ABOVE]",
      `IMPORTANT: Ignore the "Current working directory" shown earlier in this prompt.`,
      `The actual current working directory is: ${toPosixPath(process.cwd())}`,
      "",
      `You are working inside a GSD worktree.`,
      `- Worktree name: ${worktreeName}`,
      `- Worktree path (this is the real cwd): ${toPosixPath(process.cwd())}`,
      `- Main project: ${toPosixPath(worktreeMainCwd)}`,
      `- Branch: worktree/${worktreeName}`,
      "",
      "All file operations, bash commands, and GSD state resolve against the worktree path above.",
      "Use /worktree merge to merge changes back. Use /worktree return to switch back to the main tree."
    ].join("\n");
  }
  if (autoWorktree) {
    return [
      "",
      "",
      "[WORKTREE CONTEXT \u2014 OVERRIDES CURRENT WORKING DIRECTORY ABOVE]",
      `IMPORTANT: Ignore the "Current working directory" shown earlier in this prompt.`,
      `The actual current working directory is: ${toPosixPath(process.cwd())}`,
      "",
      "You are working inside a GSD auto-worktree.",
      `- Milestone worktree: ${autoWorktree.worktreeName}`,
      `- Worktree path (this is the real cwd): ${toPosixPath(process.cwd())}`,
      `- Main project: ${toPosixPath(autoWorktree.originalBase)}`,
      `- Branch: ${autoWorktree.branch}`,
      "",
      "All file operations, bash commands, and GSD state resolve against the worktree path above.",
      "Write every .gsd artifact in the worktree path above, never in the main project tree."
    ].join("\n");
  }
  return "";
}
const RESUME_INTENT_PATTERNS = /^(continue|resume|ok|go|go ahead|proceed|keep going|carry on|next|yes|yeah|yep|sure|do it|let's go|pick up where you left off)$/;
function isLowEntropyResumePrompt(prompt) {
  const trimmed = prompt.trim().toLowerCase().replace(/[.!?,]+$/g, "");
  return RESUME_INTENT_PATTERNS.test(trimmed);
}
async function buildGuidedExecuteContextInjection(prompt, basePath) {
  const ensureStateDbOpen = async () => {
    const { ensureDbOpen } = await import("./dynamic-tools.js");
    await ensureDbOpen();
  };
  const executeMatch = prompt.match(/Execute the next task:\s+(T\d+)\s+\("([^"]+)"\)\s+in slice\s+(S\d+)\s+of milestone\s+(M\d+(?:-[a-z0-9]{6})?)/i);
  if (executeMatch) {
    const [, taskId, taskTitle, sliceId, milestoneId] = executeMatch;
    return buildTaskExecutionContextInjection(basePath, milestoneId, sliceId, taskId, taskTitle);
  }
  const resumeMatch = prompt.match(/Resume interrupted work\.[\s\S]*?slice\s+(S\d+)\s+of milestone\s+(M\d+(?:-[a-z0-9]{6})?)/i);
  if (resumeMatch) {
    const [, sliceId, milestoneId] = resumeMatch;
    await ensureStateDbOpen();
    const state = await deriveState(basePath);
    if (state.activeMilestone?.id === milestoneId && state.activeSlice?.id === sliceId && state.activeTask) {
      return buildTaskExecutionContextInjection(basePath, milestoneId, sliceId, state.activeTask.id, state.activeTask.title);
    }
  }
  if (isLowEntropyResumePrompt(prompt)) {
    await ensureStateDbOpen();
    const state = await deriveState(basePath);
    if (state.phase === "executing" && state.activeTask && state.activeMilestone && state.activeSlice) {
      return buildTaskExecutionContextInjection(
        basePath,
        state.activeMilestone.id,
        state.activeSlice.id,
        state.activeTask.id,
        state.activeTask.title
      );
    }
  }
  return null;
}
async function buildTaskExecutionContextInjection(basePath, milestoneId, sliceId, taskId, taskTitle) {
  const taskPlanPath = resolveTaskFile(basePath, milestoneId, sliceId, taskId, "PLAN");
  const taskPlanRelPath = relTaskFile(basePath, milestoneId, sliceId, taskId, "PLAN");
  const taskPlanContent = taskPlanPath ? await loadFile(taskPlanPath) : null;
  const taskPlanInline = taskPlanContent ? ["## Inlined Task Plan (authoritative local execution contract)", `Source: \`${taskPlanRelPath}\``, "", taskPlanContent.trim()].join("\n") : ["## Inlined Task Plan (authoritative local execution contract)", `Task plan not found at dispatch time. Read \`${taskPlanRelPath}\` before executing.`].join("\n");
  const slicePlanPath = resolveSliceFile(basePath, milestoneId, sliceId, "PLAN");
  const slicePlanRelPath = relSliceFile(basePath, milestoneId, sliceId, "PLAN");
  const slicePlanContent = slicePlanPath ? await loadFile(slicePlanPath) : null;
  const slicePlanExcerpt = extractSliceExecutionExcerpt(slicePlanContent, slicePlanRelPath);
  const priorTaskLines = await buildCarryForwardLines(basePath, milestoneId, sliceId, taskId);
  const resumeSection = await buildResumeSection(basePath, milestoneId, sliceId);
  const activeOverrides = await loadActiveOverrides(basePath);
  const overridesSection = formatOverridesSection(activeOverrides);
  return [
    "[GSD Guided Execute Context]",
    "Use this injected context as startup context for guided task execution. Treat the inlined task plan as the authoritative local execution contract. Use source artifacts to verify details and run checks.",
    overridesSection,
    "",
    "",
    resumeSection,
    "",
    "## Carry-Forward Context",
    ...priorTaskLines,
    "",
    taskPlanInline,
    "",
    slicePlanExcerpt,
    "",
    "## Backing Source Artifacts",
    `- Slice plan: \`${slicePlanRelPath}\``,
    `- Task plan source: \`${taskPlanRelPath}\``
  ].join("\n");
}
async function buildCarryForwardLines(basePath, milestoneId, sliceId, taskId) {
  const tasksDir = resolveTasksDir(basePath, milestoneId, sliceId);
  if (!tasksDir) return ["- No prior task summaries in this slice."];
  const currentNum = parseInt(taskId.replace(/^T/, ""), 10);
  const sliceRel = relSlicePath(basePath, milestoneId, sliceId);
  const summaryFiles = resolveTaskFiles(tasksDir, "SUMMARY").filter((file) => parseInt(file.replace(/^T/, ""), 10) < currentNum).sort();
  if (summaryFiles.length === 0) return ["- No prior task summaries in this slice."];
  return Promise.all(summaryFiles.map(async (file) => {
    const absPath = join(tasksDir, file);
    const content = await loadFile(absPath);
    const relPath = `${sliceRel}/tasks/${file}`;
    if (!content) return `- \`${relPath}\``;
    const summary = parseSummary(content);
    const provided = summary.frontmatter.provides.slice(0, 2).join("; ");
    const decisions = summary.frontmatter.key_decisions.slice(0, 2).join("; ");
    const patterns = summary.frontmatter.patterns_established.slice(0, 2).join("; ");
    const diagnostics = extractMarkdownSection(content, "Diagnostics");
    const parts = [summary.title || relPath];
    if (summary.oneLiner) parts.push(summary.oneLiner);
    if (provided) parts.push(`provides: ${provided}`);
    if (decisions) parts.push(`decisions: ${decisions}`);
    if (patterns) parts.push(`patterns: ${patterns}`);
    if (diagnostics) parts.push(`diagnostics: ${oneLine(diagnostics)}`);
    return `- \`${relPath}\` \u2014 ${parts.join(" | ")}`;
  }));
}
async function buildResumeSection(basePath, milestoneId, sliceId) {
  const continueFile = resolveSliceFile(basePath, milestoneId, sliceId, "CONTINUE");
  const legacyDir = resolveSlicePath(basePath, milestoneId, sliceId);
  const legacyPath = legacyDir ? join(legacyDir, "continue.md") : null;
  const continueContent = continueFile ? await loadFile(continueFile) : null;
  const legacyContent = !continueContent && legacyPath ? await loadFile(legacyPath) : null;
  const resolvedContent = continueContent ?? legacyContent;
  const resolvedRelPath = continueContent ? relSliceFile(basePath, milestoneId, sliceId, "CONTINUE") : legacyPath ? `${relSlicePath(basePath, milestoneId, sliceId)}/continue.md` : null;
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
function extractSliceExecutionExcerpt(content, relPath) {
  if (!content) {
    return ["## Slice Plan Excerpt", `Slice plan not found at dispatch time. Read \`${relPath}\` before running slice-level verification.`].join("\n");
  }
  const lines = content.split("\n");
  const goalLine = lines.find((line) => line.startsWith("**Goal:**"))?.trim();
  const demoLine = lines.find((line) => line.startsWith("**Demo:**"))?.trim();
  const verification = extractMarkdownSection(content, "Verification");
  const observability = extractMarkdownSection(content, "Observability / Diagnostics");
  const parts = ["## Slice Plan Excerpt", `Source: \`${relPath}\``];
  if (goalLine) parts.push(goalLine);
  if (demoLine) parts.push(demoLine);
  if (verification) parts.push("", "### Slice Verification", verification.trim());
  if (observability) parts.push("", "### Slice Observability / Diagnostics", observability.trim());
  return parts.join("\n");
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
function buildForensicsContextInjection(basePath, prompt) {
  const marker = readForensicsMarker(basePath);
  if (!marker) return null;
  const age = Date.now() - new Date(marker.createdAt).getTime();
  if (age > 2 * 60 * 60 * 1e3) {
    clearForensicsMarker(basePath);
    return null;
  }
  const trimmed = prompt.trim().toLowerCase().replace(/[.!?,]+$/g, "");
  if (trimmed && !RESUME_INTENT_PATTERNS.test(trimmed)) {
    clearForensicsMarker(basePath);
    return null;
  }
  return marker.promptContent;
}
function clearForensicsMarker(basePath) {
  const markerPath = join(basePath, ".gsd", "runtime", "active-forensics.json");
  if (existsSync(markerPath)) {
    try {
      unlinkSync(markerPath);
    } catch (e) {
      logWarning("bootstrap", `unlinkSync forensics marker failed: ${e.message}`);
    }
  }
}
export {
  BUNDLED_SKILL_TRIGGERS,
  buildBeforeAgentStartResult,
  buildContextMessage,
  buildForensicsContextInjection,
  clearForensicsMarker,
  isLowEntropyResumePrompt,
  loadKnowledgeBlock,
  loadMemoryBlock
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9ib290c3RyYXAvc3lzdGVtLWNvbnRleHQudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFByb2plY3QvQXBwOiBHU0QtMlxuLy8gRmlsZSBQdXJwb3NlOiBTeXN0ZW0gcHJvbXB0IGFuZCBoaWRkZW4gY29udGV4dCBib290c3RyYXAgZm9yIEdTRCBzZXNzaW9ucy5cbmltcG9ydCB7IGV4aXN0c1N5bmMsIHJlYWRGaWxlU3luYywgdW5saW5rU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuXG5pbXBvcnQgdHlwZSB7IEV4dGVuc2lvbkNvbnRleHQgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcblxuaW1wb3J0IHsgbG9nV2FybmluZyB9IGZyb20gXCIuLi93b3JrZmxvdy1sb2dnZXIuanNcIjtcbmltcG9ydCB7IGRlYnVnVGltZSB9IGZyb20gXCIuLi9kZWJ1Zy1sb2dnZXIuanNcIjtcbmltcG9ydCB7IGxvYWRQcm9tcHQsIGdldFRlbXBsYXRlc0RpciB9IGZyb20gXCIuLi9wcm9tcHQtbG9hZGVyLmpzXCI7XG5pbXBvcnQgeyByZWFkRm9yZW5zaWNzTWFya2VyIH0gZnJvbSBcIi4uL2ZvcmVuc2ljcy5qc1wiO1xuaW1wb3J0IHsgcmVzb2x2ZUFsbFNraWxsUmVmZXJlbmNlcywgcmVuZGVyUHJlZmVyZW5jZXNGb3JTeXN0ZW1Qcm9tcHQsIGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcyB9IGZyb20gXCIuLi9wcmVmZXJlbmNlcy5qc1wiO1xuaW1wb3J0IHsgcmVzb2x2ZU1vZGVsV2l0aEZhbGxiYWNrc0ZvclVuaXQgfSBmcm9tIFwiLi4vcHJlZmVyZW5jZXMtbW9kZWxzLmpzXCI7XG5pbXBvcnQgeyByZXNvbHZlU2tpbGxSZWZlcmVuY2UgfSBmcm9tIFwiLi4vcHJlZmVyZW5jZXMtc2tpbGxzLmpzXCI7XG5pbXBvcnQgeyByZXNvbHZlR3NkUm9vdEZpbGUsIHJlc29sdmVTbGljZUZpbGUsIHJlc29sdmVTbGljZVBhdGgsIHJlc29sdmVUYXNrRmlsZSwgcmVzb2x2ZVRhc2tGaWxlcywgcmVzb2x2ZVRhc2tzRGlyLCByZWxTbGljZUZpbGUsIHJlbFNsaWNlUGF0aCwgcmVsVGFza0ZpbGUgfSBmcm9tIFwiLi4vcGF0aHMuanNcIjtcbmltcG9ydCB7IGV4dHJhY3RJbnRyb0FuZFJ1bGVzIH0gZnJvbSBcIi4uL2tub3dsZWRnZS1wYXJzZXIuanNcIjtcbmltcG9ydCB7IGVuc3VyZUNvZGViYXNlTWFwRnJlc2gsIHJlYWRDb2RlYmFzZU1hcCB9IGZyb20gXCIuLi9jb2RlYmFzZS1nZW5lcmF0b3IuanNcIjtcbmltcG9ydCB7IGhhc1NraWxsU25hcHNob3QsIGRldGVjdE5ld1NraWxscywgZm9ybWF0U2tpbGxzWG1sIH0gZnJvbSBcIi4uL3NraWxsLWRpc2NvdmVyeS5qc1wiO1xuaW1wb3J0IHsgZ2V0QWN0aXZlQXV0b1dvcmt0cmVlQ29udGV4dCB9IGZyb20gXCIuLi9hdXRvLXdvcmt0cmVlLmpzXCI7XG5pbXBvcnQgeyBnZXRBY3RpdmVXb3JrdHJlZU5hbWUsIGdldFdvcmt0cmVlT3JpZ2luYWxDd2QgfSBmcm9tIFwiLi4vd29ya3RyZWUtc2Vzc2lvbi1zdGF0ZS5qc1wiO1xuaW1wb3J0IHsgZGVyaXZlU3RhdGUgfSBmcm9tIFwiLi4vc3RhdGUuanNcIjtcbmltcG9ydCB7IGZvcm1hdE92ZXJyaWRlc1NlY3Rpb24sIGZvcm1hdFNob3J0Y3V0LCBsb2FkQWN0aXZlT3ZlcnJpZGVzLCBsb2FkRmlsZSwgcGFyc2VDb250aW51ZSwgcGFyc2VTdW1tYXJ5IH0gZnJvbSBcIi4uL2ZpbGVzLmpzXCI7XG5pbXBvcnQgeyB0b1Bvc2l4UGF0aCB9IGZyb20gXCIuLi8uLi9zaGFyZWQvbW9kLmpzXCI7XG5pbXBvcnQgeyBhdXRvRW5hYmxlQ211eFByZWZlcmVuY2VzIH0gZnJvbSBcIi4uL2NvbW1hbmRzLWNtdXguanNcIjtcbmltcG9ydCB7IGdzZEhvbWUgfSBmcm9tIFwiLi4vZ3NkLWhvbWUuanNcIjtcblxuY29uc3QgREVGQVVMVF9DT05URVhUX01FU1NBR0VfTUFYX0NIQVJTID0gNF8wMDA7XG5jb25zdCBERUZBVUxUX0tOT1dMRURHRV9NQVhfQ0hBUlMgPSAxMl8wMDA7XG5jb25zdCBERUZBVUxUX0NPREVCQVNFX01BWF9DSEFSUyA9IDhfMDAwO1xuY29uc3QgTUlOX0NPTlRFWFRfTUVTU0FHRV9NQVhfQ0hBUlMgPSAxXzAwMDtcbmNvbnN0IE1JTl9LTk9XTEVER0VfTUFYX0NIQVJTID0gMV8wMDA7XG5cbi8qKlxuICogQnVuZGxlZCBza2lsbCB0cmlnZ2VycyBcdTIwMTQgcmVzb2x2ZWQgZHluYW1pY2FsbHkgYXQgcnVudGltZSBpbnN0ZWFkIG9mXG4gKiBoYXJkY29kaW5nIGFic29sdXRlIHBhdGhzIGluIHRoZSBzeXN0ZW0gcHJvbXB0IHRlbXBsYXRlLiBPbmx5IHNraWxsc1xuICogdGhhdCBhY3R1YWxseSBleGlzdCBvbiBkaXNrIGFyZSBpbmNsdWRlZCBpbiB0aGUgdGFibGUuICgjMzU3NSlcbiAqL1xuZXhwb3J0IGNvbnN0IEJVTkRMRURfU0tJTExfVFJJR0dFUlM6IEFycmF5PHsgdHJpZ2dlcjogc3RyaW5nOyBza2lsbDogc3RyaW5nIH0+ID0gW1xuICB7IHRyaWdnZXI6IFwiRnJvbnRlbmQgVUkgLSB3ZWIgY29tcG9uZW50cywgcGFnZXMsIGxhbmRpbmcgcGFnZXMsIGRhc2hib2FyZHMsIFJlYWN0L0hUTUwvQ1NTLCBzdHlsaW5nXCIsIHNraWxsOiBcImZyb250ZW5kLWRlc2lnblwiIH0sXG4gIHsgdHJpZ2dlcjogXCJtYWNPUyBvciBpT1MgYXBwcyAtIFN3aWZ0VUksIFhjb2RlLCBBcHAgU3RvcmVcIiwgc2tpbGw6IFwic3dpZnR1aVwiIH0sXG4gIHsgdHJpZ2dlcjogXCJEZWJ1Z2dpbmcgLSBjb21wbGV4IGJ1Z3MsIGZhaWxpbmcgdGVzdHMsIHJvb3QtY2F1c2UgaW52ZXN0aWdhdGlvbiBhZnRlciBzdGFuZGFyZCBhcHByb2FjaGVzIGZhaWxcIiwgc2tpbGw6IFwiZGVidWctbGlrZS1leHBlcnRcIiB9LFxuICB7IHRyaWdnZXI6IFwiQ29kZSByZXZpZXcgLSBzZWN1cml0eSwgcGVyZm9ybWFuY2UsIGJ1Z3MsIHF1YWxpdHkgcmV2aWV3IG9mIHN0YWdlZC91bnN0YWdlZCBkaWZmcyBvciBQUnNcIiwgc2tpbGw6IFwicmV2aWV3XCIgfSxcbiAgeyB0cmlnZ2VyOiBcIlRlc3QgZ2VuZXJhdGlvbiBvciBleGVjdXRpb24gLSBhdXRvLWRldGVjdCBmcmFtZXdvcmssIGdlbmVyYXRlIHRlc3RzLCBydW4gc3VpdGUsIGFuYWx5emUgZmFpbHVyZXNcIiwgc2tpbGw6IFwidGVzdFwiIH0sXG4gIHsgdHJpZ2dlcjogXCJMaW50aW5nL2Zvcm1hdHRpbmcgLSBydW4gdGhlIGRldGVjdGVkIGxpbnRlci9mb3JtYXR0ZXIgd2l0aCBhdXRvLWZpeCwgcmVwb3J0IHJlbWFpbmluZyBpc3N1ZXNcIiwgc2tpbGw6IFwibGludFwiIH0sXG4gIHsgdHJpZ2dlcjogXCJQb2xpc2hpbmcgVUkgZGV0YWlscyAtIGFuaW1hdGlvbnMsIGhvdmVyIHN0YXRlcywgdHlwb2dyYXBoeSwgYm9yZGVycywgbWljcm8taW50ZXJhY3Rpb25zLCBvcHRpY2FsIGFsaWdubWVudFwiLCBza2lsbDogXCJtYWtlLWludGVyZmFjZXMtZmVlbC1iZXR0ZXJcIiB9LFxuICB7IHRyaWdnZXI6IFwiQWNjZXNzaWJpbGl0eSBhdWRpdCAtIFdDQUcsIHNjcmVlbiByZWFkZXIsIGtleWJvYXJkIG5hdmlnYXRpb24sIGExMXkgcmV2aWV3XCIsIHNraWxsOiBcImFjY2Vzc2liaWxpdHlcIiB9LFxuICB7IHRyaWdnZXI6IFwiUGxhbm5pbmcgaW50ZXJ2aWV3cyAtIHN0cmVzcy10ZXN0IGEgcGxhbiwgZ3JpbGwgdGhlIHVzZXIsIHJlc29sdmUgZGVjaXNpb24gdHJlZXMgb25lIGJyYW5jaCBhdCBhIHRpbWVcIiwgc2tpbGw6IFwiZ3JpbGwtbWVcIiB9LFxuICB7IHRyaWdnZXI6IFwiSW50ZXJmYWNlIGRlc2lnbiAtIHByb2R1Y2UgMysgcmFkaWNhbGx5IGRpZmZlcmVudCBkZXNpZ25zIGZvciBhIG1vZHVsZS9BUEksIGNvbXBhcmUgaW4gcHJvc2UsIHN5bnRoZXNpemVcIiwgc2tpbGw6IFwiZGVzaWduLWFuLWludGVyZmFjZVwiIH0sXG4gIHsgdHJpZ2dlcjogXCJUREQgLSByZWQtZ3JlZW4tcmVmYWN0b3IgdmVydGljYWwgc2xpY2VzLCBuZXZlciByZWZhY3RvciB3aGlsZSByZWQsIHRlc3RzIHN1cnZpdmUgcmVmYWN0b3JzXCIsIHNraWxsOiBcInRkZFwiIH0sXG4gIHsgdHJpZ2dlcjogXCJEcmFmdCBhIG1pbGVzdG9uZSBicmllZiAoTSMjIy1DT05URVhULm1kKSBvciBQUkQgZnJvbSBjdXJyZW50IGNvbnZlcnNhdGlvbiBjb250ZXh0XCIsIHNraWxsOiBcIndyaXRlLW1pbGVzdG9uZS1icmllZlwiIH0sXG4gIHsgdHJpZ2dlcjogXCJCcmVhayBhIHBsYW4gaW50byB2ZXJ0aWNhbC1zbGljZSByb2FkbWFwIHNsaWNlcyAoTSMjIy1ST0FETUFQLm1kKSBvciBHaXRIdWIgaXNzdWVzIHdpdGggZGVwZW5kZW5jeSBvcmRlcmluZ1wiLCBza2lsbDogXCJkZWNvbXBvc2UtaW50by1zbGljZXNcIiB9LFxuICB7IHRyaWdnZXI6IFwiUGFja2FnZSBzcGlrZSBmaW5kaW5ncyBpbnRvIGEgcmV1c2FibGUgcHJvamVjdC1sb2NhbCBza2lsbCBhdCAuY2xhdWRlL3NraWxscy9cIiwgc2tpbGw6IFwic3Bpa2Utd3JhcC11cFwiIH0sXG4gIHsgdHJpZ2dlcjogXCJCbG9jayBjb21wbGV0aW9uIGNsYWltcyB1bnRpbCB2ZXJpZmljYXRpb24gZXZpZGVuY2UgaGFzIGJlZW4gcHJvZHVjZWQgaW4gdGhpcyBtZXNzYWdlXCIsIHNraWxsOiBcInZlcmlmeS1iZWZvcmUtY29tcGxldGVcIiB9LFxuICB7IHRyaWdnZXI6IFwiQ3JlYXRlIGEgTW9kZWwgQ29udGV4dCBQcm90b2NvbCAoTUNQKSBzZXJ2ZXIgXHUyMDE0IHRvb2wgZGVzaWduLCBlcnJvciBoYW5kbGluZywgSW5zcGVjdG9yIHRlc3RpbmcsIGV2YWxzXCIsIHNraWxsOiBcImNyZWF0ZS1tY3Atc2VydmVyXCIgfSxcbiAgeyB0cmlnZ2VyOiBcIldyaXRlIGRvY3VtZW50YXRpb24sIHByb3Bvc2Fscywgc3BlY3MsIFJGQ3MsIG9yIFJFQURNRXMgZm9yIGEgZnJlc2ggcmVhZGVyXCIsIHNraWxsOiBcIndyaXRlLWRvY3NcIiB9LFxuICB7IHRyaWdnZXI6IFwiUG9zdC1tb3J0ZW0gYSBmYWlsZWQgR1NEIGF1dG8tbW9kZSBydW4gdXNpbmcgLmdzZC9hY3Rpdml0eSwgLmdzZC9qb3VybmFsLCBhbmQgLmdzZC9tZXRyaWNzLmpzb25cIiwgc2tpbGw6IFwiZm9yZW5zaWNzXCIgfSxcbiAgeyB0cmlnZ2VyOiBcIlByZXBhcmUgYSBjbGVhbiBjcm9zcy1zZXNzaW9uIGhhbmRvZmYgXHUyMDE0IGNvbnRpbnVlLm1kICsgc3VtbWFyeSB1cGRhdGVzIChwYXVzZS9yZXN1bWUgd29yaylcIiwgc2tpbGw6IFwiaGFuZG9mZlwiIH0sXG4gIHsgdHJpZ2dlcjogXCJTZWN1cml0eSByZXZpZXcgd2l0aCBTVFJJREUgdGhyZWF0IG1vZGVsaW5nIGFuZCBleHBsb2l0LXNjZW5hcmlvIHJlcG9ydGluZ1wiLCBza2lsbDogXCJzZWN1cml0eS1yZXZpZXdcIiB9LFxuICB7IHRyaWdnZXI6IFwiSFRUUC9SRVNUL0dyYXBoUUwgQVBJIGRlc2lnbiBcdTIwMTQgdmVyYnMsIHN0YXR1cyBjb2RlcywgcGFnaW5hdGlvbiwgZXJyb3JzLCBpZGVtcG90ZW5jeSwgdmVyc2lvbmluZ1wiLCBza2lsbDogXCJhcGktZGVzaWduXCIgfSxcbiAgeyB0cmlnZ2VyOiBcIkRlcGVuZGVuY3kgdXBncmFkZXMgXHUyMDE0IHJpc2stYmF0Y2hlZCwgdmVyaWZpZWQgYmV0d2VlbiBiYXRjaGVzLCBvbmUgbWFqb3IgcGVyIGNvbW1pdFwiLCBza2lsbDogXCJkZXBlbmRlbmN5LXVwZ3JhZGVcIiB9LFxuICB7IHRyaWdnZXI6IFwiQWdlbnQtZmlyc3Qgb2JzZXJ2YWJpbGl0eSBcdTIwMTQgc3RydWN0dXJlZCBsb2dzLCBwZXJzaXN0ZWQgZmFpbHVyZSBzdGF0ZSwgaGVhbHRoIHN1cmZhY2VzLCBleHBsaWNpdCBmYWlsdXJlIG1vZGVzXCIsIHNraWxsOiBcIm9ic2VydmFiaWxpdHlcIiB9LFxuICB7IHRyaWdnZXI6IFwiUmVhY3QvTmV4dC5qcyBwZXJmb3JtYW5jZSBcdTIwMTQgY29tcG9uZW50cywgZGF0YSBmZXRjaGluZywgYnVuZGxlIG9wdGltaXphdGlvbiwgcmVuZGVyaW5nIHBhdHRlcm5zIGZyb20gVmVyY2VsIEVuZ2luZWVyaW5nXCIsIHNraWxsOiBcInJlYWN0LWJlc3QtcHJhY3RpY2VzXCIgfSxcbiAgeyB0cmlnZ2VyOiBcIkNvcmUgV2ViIFZpdGFscyBcdTIwMTQgZml4IExDUCwgQ0xTLCBJTlA7IGxheW91dCBzaGlmdHM7IHBhZ2UgZXhwZXJpZW5jZSBvcHRpbWl6YXRpb25cIiwgc2tpbGw6IFwiY29yZS13ZWItdml0YWxzXCIgfSxcbiAgeyB0cmlnZ2VyOiBcIkdpdEh1YiBBY3Rpb25zIENJL0NEIFx1MjAxNCB3cml0ZSwgcnVuLCBhbmQgZGVidWcgd29ya2Zsb3cgZmlsZXM7IGxpdmUgc3ludGF4IGFuZCBydW4gbW9uaXRvcmluZ1wiLCBza2lsbDogXCJnaXRodWItd29ya2Zsb3dzXCIgfSxcbiAgeyB0cmlnZ2VyOiBcIkNvbXByZWhlbnNpdmUgd2ViIHF1YWxpdHkgYXVkaXQgXHUyMDE0IHBlcmZvcm1hbmNlLCBhY2Nlc3NpYmlsaXR5LCBTRU8sIGFuZCBiZXN0LXByYWN0aWNlcyAoTGlnaHRob3VzZS1zdHlsZSlcIiwgc2tpbGw6IFwid2ViLXF1YWxpdHktYXVkaXRcIiB9LFxuICB7IHRyaWdnZXI6IFwiQnJvd3NlciBhdXRvbWF0aW9uIFx1MjAxNCBvcGVuIHNpdGVzLCBmaWxsIGZvcm1zLCBjbGljaywgc2NyZWVuc2hvdCwgc2NyYXBlLCBvciB0ZXN0IHdlYiBhcHBzIHByb2dyYW1tYXRpY2FsbHlcIiwgc2tpbGw6IFwiYWdlbnQtYnJvd3NlclwiIH0sXG4gIHsgdHJpZ2dlcjogXCJSZXZpZXcgVUkgY29kZSBmb3IgV2ViIEludGVyZmFjZSBHdWlkZWxpbmVzIGNvbXBsaWFuY2UgXHUyMDE0IFVYLCBkZXNpZ24sIGFuZCBhY2Nlc3NpYmlsaXR5IHBhdHRlcm5zXCIsIHNraWxsOiBcIndlYi1kZXNpZ24tZ3VpZGVsaW5lc1wiIH0sXG4gIHsgdHJpZ2dlcjogXCJVSS9VWCBwYXR0ZXJucyByZWZlcmVuY2UgXHUyMDE0IGFuaW1hdGlvbnMsIENTUywgdHlwb2dyYXBoeSwgcHJlZmV0Y2hpbmcsIGljb25zIChmaWxlOmxpbmUgZmluZGluZ3MpXCIsIHNraWxsOiBcInVzZXJpbnRlcmZhY2Utd2lraVwiIH0sXG4gIHsgdHJpZ2dlcjogXCJBdXRob3Igb3IgcmVmaW5lIGEgR1NEIHNraWxsIFx1MjAxNCBTS0lMTC5tZCBzdHJ1Y3R1cmUsIGZyb250bWF0dGVyLCBhbmQgYmVzdCBwcmFjdGljZXNcIiwgc2tpbGw6IFwiY3JlYXRlLXNraWxsXCIgfSxcbiAgeyB0cmlnZ2VyOiBcIkNyZWF0ZSBvciBkZWJ1ZyBhIEdTRCBleHRlbnNpb24gXHUyMDE0IHRvb2xzLCBjb21tYW5kcywgZXZlbnQgaG9va3MsIGN1c3RvbSBUVUksIHByb3ZpZGVyc1wiLCBza2lsbDogXCJjcmVhdGUtZ3NkLWV4dGVuc2lvblwiIH0sXG4gIHsgdHJpZ2dlcjogXCJBdXRob3IgYSBZQU1MIHdvcmtmbG93IGRlZmluaXRpb24gXHUyMDE0IHN0ZXBzLCB0cmlnZ2VycywgYW5kIHRlbXBsYXRlc1wiLCBza2lsbDogXCJjcmVhdGUtd29ya2Zsb3dcIiB9LFxuICB7IHRyaWdnZXI6IFwiRGVlcCBjb2RlIG9wdGltaXphdGlvbiBhdWRpdCBcdTIwMTQgcGVyZiBhbnRpLXBhdHRlcm5zLCBtZW1vcnkgbGVha3MsIGFsZ29yaXRobWljIGNvbXBsZXhpdHksIGJ1bmRsZSBzaXplLCBJL08sIGNhY2hpbmcsIGRlYWQgY29kZSAocGFyYWxsZWwgcGF0dGVybi1iYXNlZCBodW50KVwiLCBza2lsbDogXCJjb2RlLW9wdGltaXplclwiIH0sXG5dO1xuXG5mdW5jdGlvbiBidWlsZEJ1bmRsZWRTa2lsbHNUYWJsZSgpOiBzdHJpbmcge1xuICBjb25zdCBjd2QgPSBwcm9jZXNzLmN3ZCgpO1xuICBjb25zdCByb3dzOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IHsgdHJpZ2dlciwgc2tpbGwgfSBvZiBCVU5ETEVEX1NLSUxMX1RSSUdHRVJTKSB7XG4gICAgY29uc3QgcmVzb2x1dGlvbiA9IHJlc29sdmVTa2lsbFJlZmVyZW5jZShza2lsbCwgY3dkKTtcbiAgICBpZiAocmVzb2x1dGlvbi5tZXRob2QgPT09IFwidW5yZXNvbHZlZFwiKSBjb250aW51ZTsgLy8gc2tpbGwgbm90IGluc3RhbGxlZCBcdTIwMTQgb21pdCBmcm9tIHByb21wdFxuICAgIHJvd3MucHVzaChgfCAke3RyaWdnZXJ9IHwgXFxgJHtyZXNvbHV0aW9uLnJlc29sdmVkUGF0aH1cXGAgfGApO1xuICB9XG4gIGlmIChyb3dzLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiBcIipObyBidW5kbGVkIHNraWxscyBmb3VuZC4gSW5zdGFsbCBza2lsbHMgdG8gYH4vLmFnZW50cy9za2lsbHMvYCBvciBgfi8uY2xhdWRlL3NraWxscy9gLipcIjtcbiAgfVxuICByZXR1cm4gYHwgVHJpZ2dlciB8IFNraWxsIHRvIGxvYWQgfFxcbnwtLS18LS0tfFxcbiR7cm93cy5qb2luKFwiXFxuXCIpfWA7XG59XG5cbmZ1bmN0aW9uIHdhcm5EZXByZWNhdGVkQWdlbnRJbnN0cnVjdGlvbnMoKTogdm9pZCB7XG4gIGNvbnN0IHBhdGhzID0gW1xuICAgIGpvaW4oZ3NkSG9tZSgpLCBcImFnZW50LWluc3RydWN0aW9ucy5tZFwiKSxcbiAgICBqb2luKHByb2Nlc3MuY3dkKCksIFwiLmdzZFwiLCBcImFnZW50LWluc3RydWN0aW9ucy5tZFwiKSxcbiAgXTtcbiAgZm9yIChjb25zdCBwYXRoIG9mIHBhdGhzKSB7XG4gICAgaWYgKGV4aXN0c1N5bmMocGF0aCkpIHtcbiAgICAgIGNvbnNvbGUud2FybihcbiAgICAgICAgYFtHU0RdIERFUFJFQ0FURUQ6ICR7cGF0aH0gaXMgbm8gbG9uZ2VyIGxvYWRlZC4gYCArXG4gICAgICAgIGBNaWdyYXRlIHlvdXIgaW5zdHJ1Y3Rpb25zIHRvIEFHRU5UUy5tZCAob3IgQ0xBVURFLm1kKSBpbiB0aGUgc2FtZSBkaXJlY3RvcnkuIGAgK1xuICAgICAgICBgU2VlIGh0dHBzOi8vZ2l0aHViLmNvbS9nc2QtYnVpbGQvR1NELTIvaXNzdWVzLzE0OTJgLFxuICAgICAgKTtcbiAgICB9XG4gIH1cbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGJ1aWxkQmVmb3JlQWdlbnRTdGFydFJlc3VsdChcbiAgZXZlbnQ6IHsgcHJvbXB0OiBzdHJpbmc7IHN5c3RlbVByb21wdDogc3RyaW5nIH0sXG4gIGN0eDogRXh0ZW5zaW9uQ29udGV4dCxcbik6IFByb21pc2U8eyBzeXN0ZW1Qcm9tcHQ6IHN0cmluZzsgbWVzc2FnZT86IHsgY3VzdG9tVHlwZTogc3RyaW5nOyBjb250ZW50OiBzdHJpbmc7IGRpc3BsYXk6IGZhbHNlIH0gfSB8IHVuZGVmaW5lZD4ge1xuICBpZiAoIWV4aXN0c1N5bmMoam9pbihwcm9jZXNzLmN3ZCgpLCBcIi5nc2RcIikpKSByZXR1cm4gdW5kZWZpbmVkO1xuXG4gIGNvbnN0IHN0b3BDb250ZXh0VGltZXIgPSBkZWJ1Z1RpbWUoXCJjb250ZXh0LWluamVjdFwiKTtcbiAgY29uc3Qgc3lzdGVtQ29udGVudCA9IGxvYWRQcm9tcHQoXCJzeXN0ZW1cIiwge1xuICAgIGJ1bmRsZWRTa2lsbHNUYWJsZTogYnVpbGRCdW5kbGVkU2tpbGxzVGFibGUoKSxcbiAgICB0ZW1wbGF0ZXNEaXI6IGdldFRlbXBsYXRlc0RpcigpLFxuICAgIHNob3J0Y3V0RGFzaGJvYXJkOiBmb3JtYXRTaG9ydGN1dChcIkN0cmwrQWx0K0dcIiksXG4gICAgc2hvcnRjdXRTaGVsbDogZm9ybWF0U2hvcnRjdXQoXCJDdHJsK0FsdCtCXCIpLFxuICB9KTtcbiAgbGV0IGxvYWRlZFByZWZlcmVuY2VzID0gbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzKCk7XG4gIHRyeSB7XG4gICAgY29uc3QgeyBtYXJrQ211eFByb21wdFNob3duLCBzaG91bGRQcm9tcHRUb0VuYWJsZUNtdXggfSA9IGF3YWl0IGltcG9ydChcIi4uLy4uL2NtdXgvaW5kZXguanNcIik7XG4gICAgaWYgKHNob3VsZFByb21wdFRvRW5hYmxlQ211eChsb2FkZWRQcmVmZXJlbmNlcz8ucHJlZmVyZW5jZXMpKSB7XG4gICAgICBtYXJrQ211eFByb21wdFNob3duKCk7XG4gICAgICBpZiAoYXV0b0VuYWJsZUNtdXhQcmVmZXJlbmNlcygpKSB7XG4gICAgICAgIGxvYWRlZFByZWZlcmVuY2VzID0gbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzKCk7XG4gICAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgICAgXCJjbXV4IGRldGVjdGVkIFx1MjAxNCBhdXRvLWVuYWJsZWQuIFJ1biAvZ3NkIGNtdXggb2ZmIHRvIGRpc2FibGUuXCIsXG4gICAgICAgICAgXCJpbmZvXCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICB9IGNhdGNoIChlKSB7XG4gICAgbG9nV2FybmluZyhcImJvb3RzdHJhcFwiLCBgY211eCBwcm9tcHQgc2V0dXAgc2tpcHBlZDogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgfVxuXG4gIGNvbnN0IGN0eFByb2plY3RSb290ID0gKGN0eCBhcyB7IHByb2plY3RSb290PzogdW5rbm93biB9KS5wcm9qZWN0Um9vdDtcbiAgY29uc3QgYmFzZVBhdGggPSB0eXBlb2YgY3R4UHJvamVjdFJvb3QgPT09IFwic3RyaW5nXCIgJiYgY3R4UHJvamVjdFJvb3QubGVuZ3RoID4gMFxuICAgID8gY3R4UHJvamVjdFJvb3RcbiAgICA6IHByb2Nlc3MuY3dkKCk7XG5cbiAgbGV0IHByZWZlcmVuY2VCbG9jayA9IFwiXCI7XG4gIGlmIChsb2FkZWRQcmVmZXJlbmNlcykge1xuICAgIGNvbnN0IGN3ZCA9IGJhc2VQYXRoO1xuICAgIGNvbnN0IHJlcG9ydCA9IHJlc29sdmVBbGxTa2lsbFJlZmVyZW5jZXMobG9hZGVkUHJlZmVyZW5jZXMucHJlZmVyZW5jZXMsIGN3ZCk7XG4gICAgcHJlZmVyZW5jZUJsb2NrID0gYFxcblxcbiR7cmVuZGVyUHJlZmVyZW5jZXNGb3JTeXN0ZW1Qcm9tcHQobG9hZGVkUHJlZmVyZW5jZXMucHJlZmVyZW5jZXMsIHJlcG9ydC5yZXNvbHV0aW9ucyl9YDtcbiAgICBpZiAocmVwb3J0Lndhcm5pbmdzLmxlbmd0aCA+IDApIHtcbiAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgIGBHU0Qgc2tpbGwgcHJlZmVyZW5jZXM6ICR7cmVwb3J0Lndhcm5pbmdzLmxlbmd0aH0gdW5yZXNvbHZlZCBza2lsbCR7cmVwb3J0Lndhcm5pbmdzLmxlbmd0aCA9PT0gMSA/IFwiXCIgOiBcInNcIn06ICR7cmVwb3J0Lndhcm5pbmdzLmpvaW4oXCIsIFwiKX1gLFxuICAgICAgICBcIndhcm5pbmdcIixcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgLy8gQURSLTAxMyBzdGVwIDU6IG9wcG9ydHVuaXN0aWMgZGVjaXNpb25zLT5tZW1vcmllcyBiYWNrZmlsbC4gSWRlbXBvdGVudFxuICAvLyBhbmQgYmVzdC1lZmZvcnQgXHUyMDE0IGZpcnN0IHJ1biBhYnNvcmJzIHRoZSBleGlzdGluZyBkZWNpc2lvbnMgdGFibGUgaW50b1xuICAvLyB0aGUgbWVtb3J5IHN0b3JlOyBzdWJzZXF1ZW50IHJ1bnMgYXJlIGEgc2luZ2xlIHNlbnRpbmVsIFNFTEVDVC5cbiAgdHJ5IHtcbiAgICBjb25zdCB7IGJhY2tmaWxsRGVjaXNpb25zVG9NZW1vcmllcyB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vbWVtb3J5LWJhY2tmaWxsLmpzXCIpO1xuICAgIGNvbnN0IHdyaXR0ZW4gPSBiYWNrZmlsbERlY2lzaW9uc1RvTWVtb3JpZXMoKTtcbiAgICBpZiAod3JpdHRlbiA+IDApIHtcbiAgICAgIGN0eC51aS5ub3RpZnkoYEdTRDogYmFja2ZpbGxlZCAke3dyaXR0ZW59IGRlY2lzaW9uJHt3cml0dGVuID09PSAxID8gXCJcIiA6IFwic1wifSBpbnRvIHRoZSBtZW1vcnkgc3RvcmUuYCwgXCJpbmZvXCIpO1xuICAgIH1cbiAgfSBjYXRjaCAoZSkge1xuICAgIGxvZ1dhcm5pbmcoXCJib290c3RyYXBcIiwgYGRlY2lzaW9ucyBiYWNrZmlsbCBmYWlsZWQ6ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gIH1cblxuICAvLyBBRFItMDEzIFN0YWdlIDJiOiBLTk9XTEVER0UubWQgUGF0dGVybnMgKyBMZXNzb25zIGJhY2tmaWxsLCB0aGVuXG4gIC8vIHJlLXJlbmRlciB0aGUgaHlicmlkIHByb2plY3Rpb24gKG1hbnVhbCBSdWxlcyArIHByb2plY3RlZCBQYXR0ZXJucyArXG4gIC8vIHByb2plY3RlZCBMZXNzb25zKS4gQm90aCBhcmUgaWRlbXBvdGVudCBhbmQgYmVzdC1lZmZvcnQgXHUyMDE0IGZhaWx1cmVzIGhlcmVcbiAgLy8gY2FuJ3QgYmxvY2sgYWdlbnQgc3RhcnR1cC5cbiAgdHJ5IHtcbiAgICBjb25zdCB7IGJhY2tmaWxsS25vd2xlZGdlVG9NZW1vcmllcyB9ID0gYXdhaXQgaW1wb3J0KFwiLi4va25vd2xlZGdlLWJhY2tmaWxsLmpzXCIpO1xuICAgIGNvbnN0IHdyaXR0ZW5LID0gYmFja2ZpbGxLbm93bGVkZ2VUb01lbW9yaWVzKGJhc2VQYXRoKTtcbiAgICBpZiAod3JpdHRlbksgPiAwKSB7XG4gICAgICBjdHgudWkubm90aWZ5KGBHU0Q6IGJhY2tmaWxsZWQgJHt3cml0dGVuS30gS05PV0xFREdFLm1kIHJvdyR7d3JpdHRlbksgPT09IDEgPyBcIlwiIDogXCJzXCJ9IGludG8gdGhlIG1lbW9yeSBzdG9yZS5gLCBcImluZm9cIik7XG4gICAgfVxuICB9IGNhdGNoIChlKSB7XG4gICAgbG9nV2FybmluZyhcImJvb3RzdHJhcFwiLCBgS05PV0xFREdFLm1kIGJhY2tmaWxsIGZhaWxlZDogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgfVxuICB0cnkge1xuICAgIGNvbnN0IHsgcmVuZGVyS25vd2xlZGdlUHJvamVjdGlvbiB9ID0gYXdhaXQgaW1wb3J0KFwiLi4va25vd2xlZGdlLXByb2plY3Rpb24uanNcIik7XG4gICAgcmVuZGVyS25vd2xlZGdlUHJvamVjdGlvbihiYXNlUGF0aCk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBsb2dXYXJuaW5nKFwiYm9vdHN0cmFwXCIsIGBLTk9XTEVER0UubWQgcHJvamVjdGlvbiByZW5kZXIgZmFpbGVkOiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWApO1xuICB9XG5cbiAgLy8gQURSLTAxMyBzdGVwIDYgcHJlZmxpZ2h0OiB3YXJuIHdoZW4gZGVjaXNpb25zIC8gS05PV0xFREdFLm1kIHJvd3MgYXJlIG5vdFxuICAvLyB5ZXQgaW4gdGhlIG1lbW9yaWVzIHRhYmxlLiBSZWFkLW9ubHk7IG5ldmVyIHRocm93cy4gUnVucyBhZnRlciB0aGUgdHdvXG4gIC8vIGJhY2tmaWxscyBhYm92ZSBzbyB0aGUgZ2FwIHJlcG9ydCByZWZsZWN0cyBwb3N0LWJhY2tmaWxsIHN0YXRlLlxuICB0cnkge1xuICAgIGNvbnN0IHsgcmVwb3J0Q29uc29saWRhdGlvbkdhcHMgfSA9IGF3YWl0IGltcG9ydChcIi4uL21lbW9yeS1jb25zb2xpZGF0aW9uLXNjYW5uZXIuanNcIik7XG4gICAgcmVwb3J0Q29uc29saWRhdGlvbkdhcHMoYmFzZVBhdGgpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgbG9nV2FybmluZyhcImJvb3RzdHJhcFwiLCBgbWVtb3J5IGNvbnNvbGlkYXRpb24gc2NhbiBmYWlsZWQ6ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gIH1cblxuICBjb25zdCB7IGJsb2NrOiBrbm93bGVkZ2VCbG9jaywgZ2xvYmFsU2l6ZUtiIH0gPSBsb2FkS25vd2xlZGdlQmxvY2soZ3NkSG9tZSgpLCBiYXNlUGF0aCk7XG4gIGlmIChnbG9iYWxTaXplS2IgPiA0KSB7XG4gICAgY3R4LnVpLm5vdGlmeShcbiAgICAgIGBHU0Q6IH4vLmdzZC9hZ2VudC9LTk9XTEVER0UubWQgaXMgJHtnbG9iYWxTaXplS2IudG9GaXhlZCgxKX1LQiBcdTIwMTQgY29uc2lkZXIgdHJpbW1pbmcgdG8ga2VlcCBzeXN0ZW0gcHJvbXB0IGxlYW4uYCxcbiAgICAgIFwid2FybmluZ1wiLFxuICAgICk7XG4gIH1cblxuICBsZXQgbmV3U2tpbGxzQmxvY2sgPSBcIlwiO1xuICBpZiAoaGFzU2tpbGxTbmFwc2hvdCgpKSB7XG4gICAgY29uc3QgbmV3U2tpbGxzID0gZGV0ZWN0TmV3U2tpbGxzKCk7XG4gICAgaWYgKG5ld1NraWxscy5sZW5ndGggPiAwKSB7XG4gICAgICBuZXdTa2lsbHNCbG9jayA9IGZvcm1hdFNraWxsc1htbChuZXdTa2lsbHMpO1xuICAgIH1cbiAgfVxuXG4gIGxldCBjb2RlYmFzZUJsb2NrID0gXCJcIjtcbiAgdHJ5IHtcbiAgICBjb25zdCBjb2RlYmFzZU9wdGlvbnMgPSBsb2FkZWRQcmVmZXJlbmNlcz8ucHJlZmVyZW5jZXM/LmNvZGViYXNlXG4gICAgICA/IHtcbiAgICAgICAgICBleGNsdWRlUGF0dGVybnM6IGxvYWRlZFByZWZlcmVuY2VzLnByZWZlcmVuY2VzLmNvZGViYXNlLmV4Y2x1ZGVfcGF0dGVybnMsXG4gICAgICAgICAgbWF4RmlsZXM6IGxvYWRlZFByZWZlcmVuY2VzLnByZWZlcmVuY2VzLmNvZGViYXNlLm1heF9maWxlcyxcbiAgICAgICAgICBjb2xsYXBzZVRocmVzaG9sZDogbG9hZGVkUHJlZmVyZW5jZXMucHJlZmVyZW5jZXMuY29kZWJhc2UuY29sbGFwc2VfdGhyZXNob2xkLFxuICAgICAgICB9XG4gICAgICA6IHVuZGVmaW5lZDtcbiAgICBlbnN1cmVDb2RlYmFzZU1hcEZyZXNoKHByb2Nlc3MuY3dkKCksIGNvZGViYXNlT3B0aW9ucyk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBsb2dXYXJuaW5nKFwiYm9vdHN0cmFwXCIsIGBDT0RFQkFTRSByZWZyZXNoIGZhaWxlZDogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgfVxuXG4gIGNvbnN0IGNvZGViYXNlUGF0aCA9IHJlc29sdmVHc2RSb290RmlsZShwcm9jZXNzLmN3ZCgpLCBcIkNPREVCQVNFXCIpO1xuICBjb25zdCByYXdDb2RlYmFzZSA9IHJlYWRDb2RlYmFzZU1hcChwcm9jZXNzLmN3ZCgpKTtcbiAgaWYgKGV4aXN0c1N5bmMoY29kZWJhc2VQYXRoKSAmJiByYXdDb2RlYmFzZSkge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCByYXdDb250ZW50ID0gcmF3Q29kZWJhc2UudHJpbSgpO1xuICAgICAgaWYgKHJhd0NvbnRlbnQpIHtcbiAgICAgICAgLy8gQ2FwIGluamVjdGlvbiBzaXplIHRvIH4yIDAwMCB0b2tlbnMgdG8gYXZvaWQgYmxvYXRpbmcgZXZlcnkgcmVxdWVzdC5cbiAgICAgICAgLy8gRnVsbCBtYXAgaXMgYWx3YXlzIGF2YWlsYWJsZSBhdCAuZ3NkL0NPREVCQVNFLm1kLlxuICAgICAgICBjb25zdCBnZW5lcmF0ZWRNYXRjaCA9IHJhd0NvbnRlbnQubWF0Y2goL0dlbmVyYXRlZDogKFxcUyspLyk7XG4gICAgICAgIGNvbnN0IGdlbmVyYXRlZEF0ID0gZ2VuZXJhdGVkTWF0Y2g/LlsxXSA/PyBcInVua25vd25cIjtcbiAgICAgICAgY29uc3QgY29udGVudCA9IHJhd0NvbnRlbnQubGVuZ3RoID4gREVGQVVMVF9DT0RFQkFTRV9NQVhfQ0hBUlNcbiAgICAgICAgICA/IHJhd0NvbnRlbnQuc2xpY2UoMCwgREVGQVVMVF9DT0RFQkFTRV9NQVhfQ0hBUlMpICsgXCJcXG5cXG4qKHRydW5jYXRlZCBcdTIwMTQgc2VlIC5nc2QvQ09ERUJBU0UubWQgZm9yIGZ1bGwgbWFwKSpcIlxuICAgICAgICAgIDogcmF3Q29udGVudDtcbiAgICAgICAgY29kZWJhc2VCbG9jayA9IGBcXG5cXG5bUFJPSkVDVCBDT0RFQkFTRSBcdTIwMTQgRmlsZSBzdHJ1Y3R1cmUgYW5kIGRlc2NyaXB0aW9ucyAoZ2VuZXJhdGVkICR7Z2VuZXJhdGVkQXR9LCBhdXRvLXJlZnJlc2hlZCB3aGVuIEdTRCBkZXRlY3RzIHRyYWNrZWQgZmlsZSBjaGFuZ2VzOyB1c2UgL2dzZCBjb2RlYmFzZSBzdGF0cyBmb3Igc3RhdHVzKV1cXG5cXG4ke2NvbnRlbnR9YDtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBsb2dXYXJuaW5nKFwiYm9vdHN0cmFwXCIsIGBDT0RFQkFTRSBmaWxlIHJlYWQgZmFpbGVkOiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWApO1xuICAgIH1cbiAgfVxuXG4gIHdhcm5EZXByZWNhdGVkQWdlbnRJbnN0cnVjdGlvbnMoKTtcblxuICBjb25zdCBpbmplY3Rpb24gPSBhd2FpdCBidWlsZEd1aWRlZEV4ZWN1dGVDb250ZXh0SW5qZWN0aW9uKGV2ZW50LnByb21wdCwgcHJvY2Vzcy5jd2QoKSk7XG4gIGNvbnN0IG1lbW9yeUJsb2NrID0gYXdhaXQgbG9hZE1lbW9yeUJsb2NrKGV2ZW50LnByb21wdCA/PyBcIlwiLCB7XG4gICAgaW5jbHVkZVByb21wdFJlbGV2YW50OiAhKGluamVjdGlvbiAmJiBpc0xvd0VudHJvcHlSZXN1bWVQcm9tcHQoZXZlbnQucHJvbXB0ID8/IFwiXCIpKSxcbiAgfSk7XG5cbiAgLy8gUmUtaW5qZWN0IGZvcmVuc2ljcyBjb250ZXh0IG9uIGZvbGxvdy11cCB0dXJucyAoIzI5NDEpXG4gIGNvbnN0IGZvcmVuc2ljc0luamVjdGlvbiA9ICFpbmplY3Rpb24gPyBidWlsZEZvcmVuc2ljc0NvbnRleHRJbmplY3Rpb24ocHJvY2Vzcy5jd2QoKSwgZXZlbnQucHJvbXB0KSA6IG51bGw7XG5cbiAgY29uc3Qgd29ya3RyZWVCbG9jayA9IGJ1aWxkV29ya3RyZWVDb250ZXh0QmxvY2soKTtcblxuICBjb25zdCBzdWJhZ2VudE1vZGVsQ29uZmlnID0gcmVzb2x2ZU1vZGVsV2l0aEZhbGxiYWNrc0ZvclVuaXQoXCJzdWJhZ2VudFwiKTtcbiAgY29uc3Qgc3ViYWdlbnRNb2RlbEJsb2NrID0gc3ViYWdlbnRNb2RlbENvbmZpZ1xuICAgID8gYFxcblxcbiMjIFN1YmFnZW50IE1vZGVsXFxuXFxuV2hlbiBzcGF3bmluZyBzdWJhZ2VudHMgdmlhIHRoZSBcXGBzdWJhZ2VudFxcYCB0b29sLCBhbHdheXMgcGFzcyBcXGBtb2RlbDogXCIke3N1YmFnZW50TW9kZWxDb25maWcucHJpbWFyeX1cIlxcYCBpbiB0aGUgdG9vbCBjYWxsIHBhcmFtZXRlcnMuIE5ldmVyIG9taXQgdGhpcyBcdTIwMTQgYWx3YXlzIHNwZWNpZnkgaXQgZXhwbGljaXRseS5gXG4gICAgOiBcIlwiO1xuXG4gIC8vIG1lbW9yeUJsb2NrIGlzIEZUUy1xdWVyaWVkIGFnYWluc3QgdGhlIHVzZXIgcHJvbXB0IGFuZCBjaGFuZ2VzIHBlciBjYWxsLlxuICAvLyBLZWVwaW5nIGl0IG91dCBvZiBgZnVsbFN5c3RlbWAgcHJlc2VydmVzIHByb3ZpZGVyIHByb21wdC1jYWNoZSBzdGFiaWxpdHlcbiAgLy8gZm9yIHRoZSBzdGF0aWMgc3lzdGVtL3Rvb2wgcHJlZml4LiBUaGUgZHluYW1pYyBtZW1vcnkgYmxvY2sgcmlkZXMgdGhlXG4gIC8vIHZvbGF0aWxlIGNvbnRleHQgbWVzc2FnZSBpbnN0ZWFkLiAoIzUwMTkpXG4gIGNvbnN0IGZ1bGxTeXN0ZW0gPSBgJHtldmVudC5zeXN0ZW1Qcm9tcHR9XFxuXFxuW1NZU1RFTSBDT05URVhUIFx1MjAxNCBHU0RdXFxuXFxuJHtzeXN0ZW1Db250ZW50fSR7cHJlZmVyZW5jZUJsb2NrfSR7a25vd2xlZGdlQmxvY2t9JHtjb2RlYmFzZUJsb2NrfSR7bmV3U2tpbGxzQmxvY2t9JHt3b3JrdHJlZUJsb2NrfSR7c3ViYWdlbnRNb2RlbEJsb2NrfWA7XG5cbiAgc3RvcENvbnRleHRUaW1lcih7XG4gICAgc3lzdGVtUHJvbXB0U2l6ZTogZnVsbFN5c3RlbS5sZW5ndGgsXG4gICAgaW5qZWN0aW9uU2l6ZTogaW5qZWN0aW9uPy5sZW5ndGggPz8gZm9yZW5zaWNzSW5qZWN0aW9uPy5sZW5ndGggPz8gMCxcbiAgICBoYXNQcmVmZXJlbmNlczogcHJlZmVyZW5jZUJsb2NrLmxlbmd0aCA+IDAsXG4gICAgaGFzTmV3U2tpbGxzOiBuZXdTa2lsbHNCbG9jay5sZW5ndGggPiAwLFxuICB9KTtcblxuICBjb25zdCBjb250ZXh0TWVzc2FnZSA9IGJ1aWxkQ29udGV4dE1lc3NhZ2UoeyBtZW1vcnlCbG9jaywgaW5qZWN0aW9uLCBmb3JlbnNpY3NJbmplY3Rpb24gfSk7XG5cbiAgcmV0dXJuIHtcbiAgICBzeXN0ZW1Qcm9tcHQ6IGZ1bGxTeXN0ZW0sXG4gICAgLi4uKGNvbnRleHRNZXNzYWdlID8geyBtZXNzYWdlOiBjb250ZXh0TWVzc2FnZSB9IDoge30pLFxuICB9O1xufVxuXG4vKipcbiAqIFJvdXRlIHRoZSBwZXItY2FsbCBkeW5hbWljIGJsb2NrcyAobWVtb3J5LCBndWlkZWQtZXhlY3V0ZSwgZm9yZW5zaWNzKSBpbnRvIGFcbiAqIHNpbmdsZSB1c2VyLW1lc3NhZ2UgY29udGV4dCBwYXlsb2FkIHNvIHRoZXkgcmlkZSB0aGUgdm9sYXRpbGUgc3VmZml4IGluc3RlYWRcbiAqIG9mIHRoZSBjYWNoZWQgc3lzdGVtIHByZWZpeC4gUHJpb3JpdHkgd2hlbiBib3RoIG1lbW9yeSBhbmQgYW4gaW5qZWN0aW9uIGFyZVxuICogcHJlc2VudDogZ3VpZGVkID4gZm9yZW5zaWNzID4gbWVtb3J5LW9ubHkuICgjNTAxOSlcbiAqXG4gKiBFeHBvcnRlZCBmb3IgZGlyZWN0IHVuaXQgdGVzdGluZyBcdTIwMTQgdGhlIHN1cnJvdW5kaW5nIGJvb3RzdHJhcCBoYXMgdG9vIG1hbnlcbiAqIGZpbGVzeXN0ZW0gYW5kIERCIGRlcGVuZGVuY2llcyB0byBleGVyY2lzZSB0aGlzIHJvdXRpbmcgbG9naWMgaW4tcGxhY2UuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZENvbnRleHRNZXNzYWdlKG9wdHM6IHtcbiAgbWVtb3J5QmxvY2s6IHN0cmluZztcbiAgaW5qZWN0aW9uOiBzdHJpbmcgfCBudWxsO1xuICBmb3JlbnNpY3NJbmplY3Rpb246IHN0cmluZyB8IG51bGw7XG59KTogeyBjdXN0b21UeXBlOiBzdHJpbmc7IGNvbnRlbnQ6IHN0cmluZzsgZGlzcGxheTogZmFsc2UgfSB8IG51bGwge1xuICBjb25zdCBjb250ZXh0Q2hhckxpbWl0ID0gZ2V0Q29udGV4dE1lc3NhZ2VDaGFyTGltaXQoKTtcbiAgY29uc3QgbWVtb3J5Q29udGVudCA9IG1hcmtNZW1vcnlDb250ZXh0U3VwcGxpZWQob3B0cy5tZW1vcnlCbG9jay50cmltKCkpO1xuICBpZiAob3B0cy5pbmplY3Rpb24pIHtcbiAgICBjb25zdCBjb250ZW50ID0gbGltaXRDb250ZXh0TWVzc2FnZUNvbnRlbnQoXG4gICAgICBtZW1vcnlDb250ZW50ID8gYCR7bWVtb3J5Q29udGVudH1cXG5cXG4ke29wdHMuaW5qZWN0aW9ufWAgOiBvcHRzLmluamVjdGlvbixcbiAgICAgIGNvbnRleHRDaGFyTGltaXQsXG4gICAgKTtcbiAgICByZXR1cm4geyBjdXN0b21UeXBlOiBcImdzZC1ndWlkZWQtY29udGV4dFwiLCBjb250ZW50LCBkaXNwbGF5OiBmYWxzZSBhcyBjb25zdCB9O1xuICB9XG4gIGlmIChvcHRzLmZvcmVuc2ljc0luamVjdGlvbikge1xuICAgIGNvbnN0IGNvbnRlbnQgPSBsaW1pdENvbnRleHRNZXNzYWdlQ29udGVudChcbiAgICAgIG1lbW9yeUNvbnRlbnQgPyBgJHttZW1vcnlDb250ZW50fVxcblxcbiR7b3B0cy5mb3JlbnNpY3NJbmplY3Rpb259YCA6IG9wdHMuZm9yZW5zaWNzSW5qZWN0aW9uLFxuICAgICAgY29udGV4dENoYXJMaW1pdCxcbiAgICApO1xuICAgIHJldHVybiB7IGN1c3RvbVR5cGU6IFwiZ3NkLWZvcmVuc2ljc1wiLCBjb250ZW50LCBkaXNwbGF5OiBmYWxzZSBhcyBjb25zdCB9O1xuICB9XG4gIGlmIChtZW1vcnlDb250ZW50KSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGN1c3RvbVR5cGU6IFwiZ3NkLW1lbW9yeVwiLFxuICAgICAgY29udGVudDogbGltaXRDb250ZXh0TWVzc2FnZUNvbnRlbnQobWVtb3J5Q29udGVudCwgY29udGV4dENoYXJMaW1pdCksXG4gICAgICBkaXNwbGF5OiBmYWxzZSBhcyBjb25zdCxcbiAgICB9O1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBnZXRDb250ZXh0TWVzc2FnZUNoYXJMaW1pdCgpOiBudW1iZXIgfCBudWxsIHtcbiAgY29uc3QgcmF3ID0gcHJvY2Vzcy5lbnYuUElfR1NEX0NPTlRFWFRfTUFYX0NIQVJTO1xuICBpZiAoIXJhdykgcmV0dXJuIERFRkFVTFRfQ09OVEVYVF9NRVNTQUdFX01BWF9DSEFSUztcbiAgaWYgKHJhdyA9PT0gXCIwXCIpIHJldHVybiBudWxsO1xuICBjb25zdCBwYXJzZWQgPSBOdW1iZXIocmF3KTtcbiAgaWYgKCFOdW1iZXIuaXNGaW5pdGUocGFyc2VkKSB8fCBwYXJzZWQgPCBNSU5fQ09OVEVYVF9NRVNTQUdFX01BWF9DSEFSUykge1xuICAgIHJldHVybiBERUZBVUxUX0NPTlRFWFRfTUVTU0FHRV9NQVhfQ0hBUlM7XG4gIH1cbiAgcmV0dXJuIE1hdGguZmxvb3IocGFyc2VkKTtcbn1cblxuZnVuY3Rpb24gbGltaXRDb250ZXh0TWVzc2FnZUNvbnRlbnQoY29udGVudDogc3RyaW5nLCBsaW1pdDogbnVtYmVyIHwgbnVsbCk6IHN0cmluZyB7XG4gIGlmICghbGltaXQgfHwgY29udGVudC5sZW5ndGggPD0gbGltaXQpIHJldHVybiBjb250ZW50O1xuICBjb25zdCBzdWZmaXggPSBcIlxcblxcbltHU0QgQ29udGV4dCBUcnVuY2F0ZWRdXFxuRnVsbCBjb250ZXh0IGlzIGF2YWlsYWJsZSBmcm9tIHRoZSByZWZlcmVuY2VkIC5nc2QgZmlsZXMgYW5kIHRvb2xzOyByZWFkIG9uIGRlbWFuZCBvbmx5IGlmIHRoaXMgZXhjZXJwdCBsYWNrcyByZXF1aXJlZCBldmlkZW5jZS5cIjtcbiAgY29uc3QgaGVhZEJ1ZGdldCA9IE1hdGgubWF4KDAsIGxpbWl0IC0gc3VmZml4Lmxlbmd0aCk7XG4gIHJldHVybiBgJHtjb250ZW50LnNsaWNlKDAsIGhlYWRCdWRnZXQpLnRyaW1FbmQoKX0ke3N1ZmZpeH1gO1xufVxuXG5mdW5jdGlvbiBtYXJrTWVtb3J5Q29udGV4dFN1cHBsaWVkKG1lbW9yeUNvbnRlbnQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmICghbWVtb3J5Q29udGVudCkgcmV0dXJuIFwiXCI7XG4gIHJldHVybiBgW0dTRCBDb250ZXh0IE1ldGFkYXRhXVxcbi0gTWVtb3J5IHN1cHBsaWVkOiB5ZXNcXG5cXG4ke21lbW9yeUNvbnRlbnR9YDtcbn1cblxuLyoqXG4gKiBBRFItMDEzIHN0ZXAgNCBcdTIwMTQgYXV0by1pbmplY3Rpb24gcGFyaXR5IGZvciB0aGUgbWVtb3JpZXMgdGFibGUuXG4gKlxuICogTWlycm9ycyBsb2FkS25vd2xlZGdlQmxvY2sgYnkgcHJvZHVjaW5nIGEgbGFiZWxlZCwgZGV0ZXJtaW5pc3RpYyBibG9ja1xuICogY29tYmluaW5nIHR3byBtZW1vcnkgc2V0czpcbiAqXG4gKiAxLiBBbHdheXMtb24gXCJjcml0aWNhbFwiIHNldCBcdTIwMTQgdG9wLXJhbmtlZCBhY3RpdmUgbWVtb3JpZXMgaW4gY2F0ZWdvcmllc1xuICogICAgdGhhdCBmdXR1cmUgR1NEIHR1cm5zIGdlbmVyYWxseSB3YW50IHdpdGhvdXQgYXNraW5nLiBBZnRlciBBRFItMDEzXG4gKiAgICBleHBhbmRzIHRoaXMgdG8gaW5jbHVkZSBcImFyY2hpdGVjdHVyZVwiLCB0aGVzZSBtZW1vcmllcyBzZXJ2ZSBhcyB0aGVcbiAqICAgIGF1dG8taW5qZWN0ZWQgcmVwbGFjZW1lbnQgZm9yIGlubGluZURlY2lzaW9uc0Zyb21EYiB3aGVuIHRoZSBjdXRvdmVyXG4gKiAgICBpbiBzdGVwIDYgbGFuZHMuXG4gKiAyLiBQcm9tcHQtcmVsZXZhbmNlIHNldCBcdTIwMTQgRlRTNS9zZW1hbnRpYyBoaXRzIGFnYWluc3QgdGhlIGN1cnJlbnQgdXNlclxuICogICAgcHJvbXB0LCBkZWR1cGxpY2F0ZWQgYWdhaW5zdCB0aGUgY3JpdGljYWwgc2V0LlxuICpcbiAqIEJvdGggc2V0cyBhcmUgcmFua2VkLCBtZXJnZWQsIGFuZCByZW5kZXJlZCB2aWEgZm9ybWF0TWVtb3JpZXNGb3JQcm9tcHRcbiAqIHdpdGggYSB0b2tlbi1idWRnZXQgY2FwLiBGYWlsdXJlcyBkZWdyYWRlIGdyYWNlZnVsbHkgXHUyMDE0IHRoZSBmdW5jdGlvbiBuZXZlclxuICogdGhyb3dzIGFuZCByZXR1cm5zIFwiXCIgc28gdGhlIHN5c3RlbSBwcm9tcHQgY29uc3RydWN0aW9uIGNvbnRpbnVlcy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGxvYWRNZW1vcnlCbG9jayhcbiAgdXNlclByb21wdDogc3RyaW5nLFxuICBvcHRzOiB7IGluY2x1ZGVQcm9tcHRSZWxldmFudD86IGJvb2xlYW4gfSA9IHt9LFxuKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCB7IGZvcm1hdE1lbW9yaWVzRm9yUHJvbXB0LCBnZXRBY3RpdmVNZW1vcmllc1JhbmtlZCwgcXVlcnlNZW1vcmllc1JhbmtlZCB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vbWVtb3J5LXN0b3JlLmpzXCIpO1xuXG4gICAgLy8gQ2F0ZWdvcmllcyB0aGF0IGJlbG9uZyBpbiBldmVyeSB0dXJuLiBQcmUtQURSLTAxMyB0aGlzIHdhcyBqdXN0XG4gICAgLy8ge2dvdGNoYSwgZW52aXJvbm1lbnQsIGNvbnZlbnRpb259LiBBRFItMDEzIGFkZHMgXCJhcmNoaXRlY3R1cmVcIiBzb1xuICAgIC8vIGRlY2lzaW9uLWVxdWl2YWxlbnQgbWVtb3JpZXMgc3Vydml2ZSB0aGUgaW5saW5lRGVjaXNpb25zRnJvbURiIGN1dG92ZXJcbiAgICAvLyBpbiBzdGVwIDYuXG4gICAgY29uc3QgQ1JJVElDQUxfQ0FURUdPUklFUyA9IG5ldyBTZXQoW1wiZ290Y2hhXCIsIFwiZW52aXJvbm1lbnRcIiwgXCJjb252ZW50aW9uXCIsIFwiYXJjaGl0ZWN0dXJlXCJdKTtcbiAgICBjb25zdCBDUklUSUNBTF9DQVAgPSA4O1xuICAgIGNvbnN0IFFVRVJZX0sgPSAxMDtcbiAgICAvLyB+MSB0b2tlbiBcdTIyNDggNCBjaGFycy4gNDAwMCBjaGFycyBcdTIyNDggMTAwMCB0b2tlbnMgXHUyMDE0IGNvbWZvcnRhYmx5IHVuZGVyIHRoZVxuICAgIC8vIEtOT1dMRURHRS5tZCA0S0Igd2FybmluZyB0aHJlc2hvbGQgYW5kIHJvdWdobHkgdHdpY2UgdGhlIHByZS1BRFItMDEzXG4gICAgLy8gYnVkZ2V0IHNvIHRoZSBhYnNvcmJlZCBERUNJU0lPTlMgc3VyZmFjZSBmaXRzLlxuICAgIGNvbnN0IENIQVJfQlVER0VUID0gNDAwMDtcblxuICAgIGNvbnN0IGFsbFJhbmtlZCA9IGdldEFjdGl2ZU1lbW9yaWVzUmFua2VkKDgwKTtcbiAgICBjb25zdCBjcml0aWNhbCA9IGFsbFJhbmtlZC5maWx0ZXIoKG0pID0+IENSSVRJQ0FMX0NBVEVHT1JJRVMuaGFzKG0uY2F0ZWdvcnkpKS5zbGljZSgwLCBDUklUSUNBTF9DQVApO1xuICAgIGNvbnN0IGNyaXRpY2FsSWRzID0gbmV3IFNldChjcml0aWNhbC5tYXAoKG0pID0+IG0uaWQpKTtcblxuICAgIGxldCByZWxldmFudDogdHlwZW9mIGFsbFJhbmtlZCA9IFtdO1xuICAgIGNvbnN0IHRyaW1tZWQgPSB1c2VyUHJvbXB0LnRyaW0oKTtcbiAgICBpZiAodHJpbW1lZCAmJiBvcHRzLmluY2x1ZGVQcm9tcHRSZWxldmFudCAhPT0gZmFsc2UpIHtcbiAgICAgIGNvbnN0IGhpdHMgPSBxdWVyeU1lbW9yaWVzUmFua2VkKHsgcXVlcnk6IHRyaW1tZWQsIGs6IFFVRVJZX0sgfSk7XG4gICAgICByZWxldmFudCA9IGhpdHMubWFwKChoKSA9PiBoLm1lbW9yeSkuZmlsdGVyKChtKSA9PiAhY3JpdGljYWxJZHMuaGFzKG0uaWQpKTtcbiAgICB9XG5cbiAgICBjb25zdCBtZXJnZWQgPSBbLi4uY3JpdGljYWwsIC4uLnJlbGV2YW50XTtcbiAgICBpZiAobWVyZ2VkLmxlbmd0aCA9PT0gMCkgcmV0dXJuIFwiXCI7XG5cbiAgICBjb25zdCBmb3JtYXR0ZWQgPSBmb3JtYXRNZW1vcmllc0ZvclByb21wdChtZXJnZWQsIENIQVJfQlVER0VUKTtcbiAgICBpZiAoIWZvcm1hdHRlZCkgcmV0dXJuIFwiXCI7XG5cbiAgICByZXR1cm4gYFxcblxcbltNRU1PUlkgXHUyMDE0IENyaXRpY2FsIGFuZCBwcm9tcHQtcmVsZXZhbnQgbWVtb3JpZXMgZnJvbSB0aGUgR1NEIG1lbW9yeSBzdG9yZV1cXG5cXG4ke2Zvcm1hdHRlZH1gO1xuICB9IGNhdGNoIChlKSB7XG4gICAgbG9nV2FybmluZyhcImJvb3RzdHJhcFwiLCBgbWVtb3J5IGJsb2NrIGZldGNoIGZhaWxlZDogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICByZXR1cm4gXCJcIjtcbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gbG9hZEtub3dsZWRnZUJsb2NrKGdzZEhvbWVEaXI6IHN0cmluZywgY3dkOiBzdHJpbmcpOiB7IGJsb2NrOiBzdHJpbmc7IGdsb2JhbFNpemVLYjogbnVtYmVyIH0ge1xuICAvLyAxLiBHbG9iYWwga25vd2xlZGdlICh+Ly5nc2QvYWdlbnQvS05PV0xFREdFLm1kKSBcdTIwMTQgY3Jvc3MtcHJvamVjdCxcbiAgLy8gICAgdXNlci1tYWludGFpbmVkLiBOT1QgbWlncmF0ZWQgdG8gbWVtb3JpZXMgKHdoaWNoIGFyZSBwcm9qZWN0LXNjb3BlZCksXG4gIC8vICAgIHNvIHRoZSBmdWxsIGZpbGUgaXMgaW5qZWN0ZWQgdW5jaGFuZ2VkLlxuICBsZXQgZ2xvYmFsS25vd2xlZGdlID0gXCJcIjtcbiAgbGV0IGdsb2JhbFNpemVLYiA9IDA7XG4gIGNvbnN0IGdsb2JhbEtub3dsZWRnZVBhdGggPSBqb2luKGdzZEhvbWVEaXIsIFwiYWdlbnRcIiwgXCJLTk9XTEVER0UubWRcIik7XG4gIGlmIChleGlzdHNTeW5jKGdsb2JhbEtub3dsZWRnZVBhdGgpKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGNvbnRlbnQgPSByZWFkRmlsZVN5bmMoZ2xvYmFsS25vd2xlZGdlUGF0aCwgXCJ1dGYtOFwiKS50cmltKCk7XG4gICAgICBpZiAoY29udGVudCkge1xuICAgICAgICBnbG9iYWxTaXplS2IgPSBCdWZmZXIuYnl0ZUxlbmd0aChjb250ZW50LCBcInV0Zi04XCIpIC8gMTAyNDtcbiAgICAgICAgZ2xvYmFsS25vd2xlZGdlID0gY29udGVudDtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBsb2dXYXJuaW5nKFwiYm9vdHN0cmFwXCIsIGBnbG9iYWwga25vd2xlZGdlIGZpbGUgcmVhZCBmYWlsZWQ6ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgfVxuICB9XG5cbiAgLy8gMi4gUHJvamVjdCBrbm93bGVkZ2UgKC5nc2QvS05PV0xFREdFLm1kKSBcdTIwMTQgcHJvamVjdC1zcGVjaWZpYy5cbiAgLy8gICAgQURSLTAxMyBTdGFnZSAyYjogUGF0dGVybnMgYW5kIExlc3NvbnMgYXJlIHByb2plY3RlZCBmcm9tIHRoZVxuICAvLyAgICBtZW1vcmllcyB0YWJsZSBhbmQgYWxyZWFkeSByZWFjaCB0aGUgTExNIHZpYSBsb2FkTWVtb3J5QmxvY2suIEluamVjdFxuICAvLyAgICBvbmx5IHRoZSBpbnRybyBwcm9zZSArIGAjIyBSdWxlc2Agc2VjdGlvbiBoZXJlIHRvIGF2b2lkIGR1cGxpY2F0aW5nXG4gIC8vICAgIFBhdHRlcm5zL0xlc3NvbnMgY29udGVudCBpbiB0aGUgcHJvbXB0LiBSdWxlcyBzdGF5IG1hbnVhbCBwZXJcbiAgLy8gICAgQURSLTAxMyBsaW5lIDM5IGFuZCBoYXZlIG5vIG1lbW9yeSBlcXVpdmFsZW50LlxuICBsZXQgcHJvamVjdEtub3dsZWRnZSA9IFwiXCI7XG4gIGNvbnN0IGtub3dsZWRnZVBhdGggPSByZXNvbHZlR3NkUm9vdEZpbGUoY3dkLCBcIktOT1dMRURHRVwiKTtcbiAgaWYgKGV4aXN0c1N5bmMoa25vd2xlZGdlUGF0aCkpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKGtub3dsZWRnZVBhdGgsIFwidXRmLThcIikudHJpbSgpO1xuICAgICAgaWYgKHJhdykgcHJvamVjdEtub3dsZWRnZSA9IGV4dHJhY3RJbnRyb0FuZFJ1bGVzKHJhdykudHJpbSgpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGxvZ1dhcm5pbmcoXCJib290c3RyYXBcIiwgYHByb2plY3Qga25vd2xlZGdlIGZpbGUgcmVhZCBmYWlsZWQ6ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgfVxuICB9XG5cbiAgaWYgKCFnbG9iYWxLbm93bGVkZ2UgJiYgIXByb2plY3RLbm93bGVkZ2UpIHtcbiAgICByZXR1cm4geyBibG9jazogXCJcIiwgZ2xvYmFsU2l6ZUtiOiAwIH07XG4gIH1cblxuICBjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcbiAgaWYgKGdsb2JhbEtub3dsZWRnZSkge1xuICAgIHBhcnRzLnB1c2goYCMjIEdsb2JhbCBLbm93bGVkZ2VcXG5Tb3VyY2U6IFxcYCR7Z2xvYmFsS25vd2xlZGdlUGF0aH1cXGBcXG5cXG4ke2dsb2JhbEtub3dsZWRnZX1gKTtcbiAgfVxuICBpZiAocHJvamVjdEtub3dsZWRnZSkge1xuICAgIHBhcnRzLnB1c2goYCMjIFByb2plY3QgS25vd2xlZGdlXFxuU291cmNlOiBcXGAke2tub3dsZWRnZVBhdGh9XFxgXFxuXFxuJHtwcm9qZWN0S25vd2xlZGdlfWApO1xuICB9XG4gIGNvbnN0IGJvZHkgPSBsaW1pdEtub3dsZWRnZUJsb2NrKHBhcnRzLmpvaW4oXCJcXG5cXG5cIiksIGdldEtub3dsZWRnZUNoYXJMaW1pdCgpKTtcbiAgcmV0dXJuIHtcbiAgICBibG9jazogYFxcblxcbltLTk9XTEVER0UgXHUyMDE0IFJ1bGVzIGZyb20gS05PV0xFREdFLm1kIChQYXR0ZXJucyBhbmQgTGVzc29ucyByZWFjaCB0aGUgTExNIHZpYSB0aGUgbWVtb3J5IGJsb2NrKV1cXG5cXG4ke2JvZHl9YCxcbiAgICBnbG9iYWxTaXplS2IsXG4gIH07XG59XG5cbmZ1bmN0aW9uIGdldEtub3dsZWRnZUNoYXJMaW1pdCgpOiBudW1iZXIgfCBudWxsIHtcbiAgY29uc3QgcmF3ID0gcHJvY2Vzcy5lbnYuUElfR1NEX0tOT1dMRURHRV9NQVhfQ0hBUlM7XG4gIGlmICghcmF3KSByZXR1cm4gREVGQVVMVF9LTk9XTEVER0VfTUFYX0NIQVJTO1xuICBpZiAocmF3ID09PSBcIjBcIikgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHBhcnNlZCA9IE51bWJlcihyYXcpO1xuICBpZiAoIU51bWJlci5pc0Zpbml0ZShwYXJzZWQpIHx8IHBhcnNlZCA8IE1JTl9LTk9XTEVER0VfTUFYX0NIQVJTKSB7XG4gICAgcmV0dXJuIERFRkFVTFRfS05PV0xFREdFX01BWF9DSEFSUztcbiAgfVxuICByZXR1cm4gTWF0aC5mbG9vcihwYXJzZWQpO1xufVxuXG5mdW5jdGlvbiBsaW1pdEtub3dsZWRnZUJsb2NrKGNvbnRlbnQ6IHN0cmluZywgbGltaXQ6IG51bWJlciB8IG51bGwpOiBzdHJpbmcge1xuICBpZiAoIWxpbWl0IHx8IGNvbnRlbnQubGVuZ3RoIDw9IGxpbWl0KSByZXR1cm4gY29udGVudDtcbiAgY29uc3Qgc3VmZml4ID0gXCJcXG5cXG5bS25vd2xlZGdlIFRydW5jYXRlZF1cXG5GdWxsIEtOT1dMRURHRS5tZCBjb250ZW50IHJlbWFpbnMgYXZhaWxhYmxlIGF0IHRoZSBzb3VyY2UgcGF0aChzKSBhYm92ZTsgcmVhZCBvbiBkZW1hbmQgb25seSBpZiB0aGlzIGV4Y2VycHQgbGFja3MgYSByZXF1aXJlZCBydWxlLlwiO1xuICBjb25zdCBoZWFkQnVkZ2V0ID0gTWF0aC5tYXgoMCwgbGltaXQgLSBzdWZmaXgubGVuZ3RoKTtcbiAgcmV0dXJuIGAke2NvbnRlbnQuc2xpY2UoMCwgaGVhZEJ1ZGdldCkudHJpbUVuZCgpfSR7c3VmZml4fWA7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkV29ya3RyZWVDb250ZXh0QmxvY2soKTogc3RyaW5nIHtcbiAgY29uc3Qgd29ya3RyZWVOYW1lID0gZ2V0QWN0aXZlV29ya3RyZWVOYW1lKCk7XG4gIGNvbnN0IHdvcmt0cmVlTWFpbkN3ZCA9IGdldFdvcmt0cmVlT3JpZ2luYWxDd2QoKTtcbiAgY29uc3QgYXV0b1dvcmt0cmVlID0gZ2V0QWN0aXZlQXV0b1dvcmt0cmVlQ29udGV4dCgpO1xuXG4gIGlmICh3b3JrdHJlZU5hbWUgJiYgd29ya3RyZWVNYWluQ3dkKSB7XG4gICAgcmV0dXJuIFtcbiAgICAgIFwiXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCJbV09SS1RSRUUgQ09OVEVYVCBcdTIwMTQgT1ZFUlJJREVTIENVUlJFTlQgV09SS0lORyBESVJFQ1RPUlkgQUJPVkVdXCIsXG4gICAgICBgSU1QT1JUQU5UOiBJZ25vcmUgdGhlIFwiQ3VycmVudCB3b3JraW5nIGRpcmVjdG9yeVwiIHNob3duIGVhcmxpZXIgaW4gdGhpcyBwcm9tcHQuYCxcbiAgICAgIGBUaGUgYWN0dWFsIGN1cnJlbnQgd29ya2luZyBkaXJlY3RvcnkgaXM6ICR7dG9Qb3NpeFBhdGgocHJvY2Vzcy5jd2QoKSl9YCxcbiAgICAgIFwiXCIsXG4gICAgICBgWW91IGFyZSB3b3JraW5nIGluc2lkZSBhIEdTRCB3b3JrdHJlZS5gLFxuICAgICAgYC0gV29ya3RyZWUgbmFtZTogJHt3b3JrdHJlZU5hbWV9YCxcbiAgICAgIGAtIFdvcmt0cmVlIHBhdGggKHRoaXMgaXMgdGhlIHJlYWwgY3dkKTogJHt0b1Bvc2l4UGF0aChwcm9jZXNzLmN3ZCgpKX1gLFxuICAgICAgYC0gTWFpbiBwcm9qZWN0OiAke3RvUG9zaXhQYXRoKHdvcmt0cmVlTWFpbkN3ZCl9YCxcbiAgICAgIGAtIEJyYW5jaDogd29ya3RyZWUvJHt3b3JrdHJlZU5hbWV9YCxcbiAgICAgIFwiXCIsXG4gICAgICBcIkFsbCBmaWxlIG9wZXJhdGlvbnMsIGJhc2ggY29tbWFuZHMsIGFuZCBHU0Qgc3RhdGUgcmVzb2x2ZSBhZ2FpbnN0IHRoZSB3b3JrdHJlZSBwYXRoIGFib3ZlLlwiLFxuICAgICAgXCJVc2UgL3dvcmt0cmVlIG1lcmdlIHRvIG1lcmdlIGNoYW5nZXMgYmFjay4gVXNlIC93b3JrdHJlZSByZXR1cm4gdG8gc3dpdGNoIGJhY2sgdG8gdGhlIG1haW4gdHJlZS5cIixcbiAgICBdLmpvaW4oXCJcXG5cIik7XG4gIH1cblxuICBpZiAoYXV0b1dvcmt0cmVlKSB7XG4gICAgcmV0dXJuIFtcbiAgICAgIFwiXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCJbV09SS1RSRUUgQ09OVEVYVCBcdTIwMTQgT1ZFUlJJREVTIENVUlJFTlQgV09SS0lORyBESVJFQ1RPUlkgQUJPVkVdXCIsXG4gICAgICBgSU1QT1JUQU5UOiBJZ25vcmUgdGhlIFwiQ3VycmVudCB3b3JraW5nIGRpcmVjdG9yeVwiIHNob3duIGVhcmxpZXIgaW4gdGhpcyBwcm9tcHQuYCxcbiAgICAgIGBUaGUgYWN0dWFsIGN1cnJlbnQgd29ya2luZyBkaXJlY3RvcnkgaXM6ICR7dG9Qb3NpeFBhdGgocHJvY2Vzcy5jd2QoKSl9YCxcbiAgICAgIFwiXCIsXG4gICAgICBcIllvdSBhcmUgd29ya2luZyBpbnNpZGUgYSBHU0QgYXV0by13b3JrdHJlZS5cIixcbiAgICAgIGAtIE1pbGVzdG9uZSB3b3JrdHJlZTogJHthdXRvV29ya3RyZWUud29ya3RyZWVOYW1lfWAsXG4gICAgICBgLSBXb3JrdHJlZSBwYXRoICh0aGlzIGlzIHRoZSByZWFsIGN3ZCk6ICR7dG9Qb3NpeFBhdGgocHJvY2Vzcy5jd2QoKSl9YCxcbiAgICAgIGAtIE1haW4gcHJvamVjdDogJHt0b1Bvc2l4UGF0aChhdXRvV29ya3RyZWUub3JpZ2luYWxCYXNlKX1gLFxuICAgICAgYC0gQnJhbmNoOiAke2F1dG9Xb3JrdHJlZS5icmFuY2h9YCxcbiAgICAgIFwiXCIsXG4gICAgICBcIkFsbCBmaWxlIG9wZXJhdGlvbnMsIGJhc2ggY29tbWFuZHMsIGFuZCBHU0Qgc3RhdGUgcmVzb2x2ZSBhZ2FpbnN0IHRoZSB3b3JrdHJlZSBwYXRoIGFib3ZlLlwiLFxuICAgICAgXCJXcml0ZSBldmVyeSAuZ3NkIGFydGlmYWN0IGluIHRoZSB3b3JrdHJlZSBwYXRoIGFib3ZlLCBuZXZlciBpbiB0aGUgbWFpbiBwcm9qZWN0IHRyZWUuXCIsXG4gICAgXS5qb2luKFwiXFxuXCIpO1xuICB9XG5cbiAgcmV0dXJuIFwiXCI7XG59XG5cbi8qKlxuICogTG93LWVudHJvcHkgcmVzdW1lIGludGVudCBwYXR0ZXJucyBcdTIwMTQgc2hvcnQgcGhyYXNlcyBhIHVzZXIgdHlwZXMgdG9cbiAqIGNvbnRpbnVlIHdvcmsgYWZ0ZXIgYSBwYXVzZSwgcmF0ZSBsaW1pdCwgb3IgY29udGV4dCByZXNldCAoIzM2MTUpLlxuICogVGVzdGVkIGFnYWluc3QgdGhlIHRyaW1tZWQsIGxvd2VyY2FzZWQgcHJvbXB0IHdpdGggdHJhaWxpbmcgcHVuY3R1YXRpb24gc3RyaXBwZWQuXG4gKi9cbmNvbnN0IFJFU1VNRV9JTlRFTlRfUEFUVEVSTlMgPSAvXihjb250aW51ZXxyZXN1bWV8b2t8Z298Z28gYWhlYWR8cHJvY2VlZHxrZWVwIGdvaW5nfGNhcnJ5IG9ufG5leHR8eWVzfHllYWh8eWVwfHN1cmV8ZG8gaXR8bGV0J3MgZ298cGljayB1cCB3aGVyZSB5b3UgbGVmdCBvZmYpJC87XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0xvd0VudHJvcHlSZXN1bWVQcm9tcHQocHJvbXB0OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgdHJpbW1lZCA9IHByb21wdC50cmltKCkudG9Mb3dlckNhc2UoKS5yZXBsYWNlKC9bLiE/LF0rJC9nLCBcIlwiKTtcbiAgcmV0dXJuIFJFU1VNRV9JTlRFTlRfUEFUVEVSTlMudGVzdCh0cmltbWVkKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gYnVpbGRHdWlkZWRFeGVjdXRlQ29udGV4dEluamVjdGlvbihwcm9tcHQ6IHN0cmluZywgYmFzZVBhdGg6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICBjb25zdCBlbnN1cmVTdGF0ZURiT3BlbiA9IGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB7IGVuc3VyZURiT3BlbiB9ID0gYXdhaXQgaW1wb3J0KFwiLi9keW5hbWljLXRvb2xzLmpzXCIpO1xuICAgIGF3YWl0IGVuc3VyZURiT3BlbigpO1xuICB9O1xuXG4gIGNvbnN0IGV4ZWN1dGVNYXRjaCA9IHByb21wdC5tYXRjaCgvRXhlY3V0ZSB0aGUgbmV4dCB0YXNrOlxccysoVFxcZCspXFxzK1xcKFwiKFteXCJdKylcIlxcKVxccytpbiBzbGljZVxccysoU1xcZCspXFxzK29mIG1pbGVzdG9uZVxccysoTVxcZCsoPzotW2EtejAtOV17Nn0pPykvaSk7XG4gIGlmIChleGVjdXRlTWF0Y2gpIHtcbiAgICBjb25zdCBbLCB0YXNrSWQsIHRhc2tUaXRsZSwgc2xpY2VJZCwgbWlsZXN0b25lSWRdID0gZXhlY3V0ZU1hdGNoO1xuICAgIHJldHVybiBidWlsZFRhc2tFeGVjdXRpb25Db250ZXh0SW5qZWN0aW9uKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgc2xpY2VJZCwgdGFza0lkLCB0YXNrVGl0bGUpO1xuICB9XG5cbiAgY29uc3QgcmVzdW1lTWF0Y2ggPSBwcm9tcHQubWF0Y2goL1Jlc3VtZSBpbnRlcnJ1cHRlZCB3b3JrXFwuW1xcc1xcU10qP3NsaWNlXFxzKyhTXFxkKylcXHMrb2YgbWlsZXN0b25lXFxzKyhNXFxkKyg/Oi1bYS16MC05XXs2fSk/KS9pKTtcbiAgaWYgKHJlc3VtZU1hdGNoKSB7XG4gICAgY29uc3QgWywgc2xpY2VJZCwgbWlsZXN0b25lSWRdID0gcmVzdW1lTWF0Y2g7XG4gICAgYXdhaXQgZW5zdXJlU3RhdGVEYk9wZW4oKTtcbiAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2VQYXRoKTtcbiAgICBpZiAoc3RhdGUuYWN0aXZlTWlsZXN0b25lPy5pZCA9PT0gbWlsZXN0b25lSWQgJiYgc3RhdGUuYWN0aXZlU2xpY2U/LmlkID09PSBzbGljZUlkICYmIHN0YXRlLmFjdGl2ZVRhc2spIHtcbiAgICAgIHJldHVybiBidWlsZFRhc2tFeGVjdXRpb25Db250ZXh0SW5qZWN0aW9uKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgc2xpY2VJZCwgc3RhdGUuYWN0aXZlVGFzay5pZCwgc3RhdGUuYWN0aXZlVGFzay50aXRsZSk7XG4gICAgfVxuICB9XG5cbiAgLy8gRmFsbGJhY2s6IGxvdy1lbnRyb3B5IHJlc3VtZSBwcm9tcHQgKGUuZy4sIFwiY29udGludWVcIiwgXCJva1wiLCBcImdvIGFoZWFkXCIpXG4gIC8vIGR1cmluZyBhbiBhY3RpdmUgZXhlY3V0aW5nIHRhc2sgXHUyMDE0IGluamVjdCB0YXNrIGNvbnRleHQgc28gdGhlIGFnZW50XG4gIC8vIGRvZXNuJ3QgcmVidWlsZCBmcm9tIHNjcmF0Y2ggKCMzNjE1KS5cbiAgLy8gSW50ZW50LWdhdGVkOiBvbmx5IGZpcmUgZm9yIHNob3J0LCByZXN1bWUtbGlrZSBwcm9tcHRzIHRvIGF2b2lkIGhpamFja2luZ1xuICAvLyBjb250cm9sL2hlbHAvZGlhZ25vc3RpYyBwcm9tcHRzIHdpdGggdW5yZWxhdGVkIGV4ZWN1dGlvbiBjb250ZXh0LlxuICAvLyBQaGFzZS1nYXRlZDogb25seSBmaXJlIGR1cmluZyBcImV4ZWN1dGluZ1wiIHRvIGF2b2lkIG1pc3JvdXRpbmcgZHVyaW5nXG4gIC8vIHJlcGxhbm5pbmcsIGdhdGUgZXZhbHVhdGlvbiwgb3Igb3RoZXIgbm9uLWV4ZWN1dGlvbiBwaGFzZXMuXG4gIGlmIChpc0xvd0VudHJvcHlSZXN1bWVQcm9tcHQocHJvbXB0KSkge1xuICAgIGF3YWl0IGVuc3VyZVN0YXRlRGJPcGVuKCk7XG4gICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlUGF0aCk7XG4gICAgaWYgKHN0YXRlLnBoYXNlID09PSBcImV4ZWN1dGluZ1wiICYmIHN0YXRlLmFjdGl2ZVRhc2sgJiYgc3RhdGUuYWN0aXZlTWlsZXN0b25lICYmIHN0YXRlLmFjdGl2ZVNsaWNlKSB7XG4gICAgICByZXR1cm4gYnVpbGRUYXNrRXhlY3V0aW9uQ29udGV4dEluamVjdGlvbihcbiAgICAgICAgYmFzZVBhdGgsXG4gICAgICAgIHN0YXRlLmFjdGl2ZU1pbGVzdG9uZS5pZCxcbiAgICAgICAgc3RhdGUuYWN0aXZlU2xpY2UuaWQsXG4gICAgICAgIHN0YXRlLmFjdGl2ZVRhc2suaWQsXG4gICAgICAgIHN0YXRlLmFjdGl2ZVRhc2sudGl0bGUsXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiBudWxsO1xufVxuXG5hc3luYyBmdW5jdGlvbiBidWlsZFRhc2tFeGVjdXRpb25Db250ZXh0SW5qZWN0aW9uKFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICBtaWxlc3RvbmVJZDogc3RyaW5nLFxuICBzbGljZUlkOiBzdHJpbmcsXG4gIHRhc2tJZDogc3RyaW5nLFxuICB0YXNrVGl0bGU6IHN0cmluZyxcbik6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IHRhc2tQbGFuUGF0aCA9IHJlc29sdmVUYXNrRmlsZShiYXNlUGF0aCwgbWlsZXN0b25lSWQsIHNsaWNlSWQsIHRhc2tJZCwgXCJQTEFOXCIpO1xuICBjb25zdCB0YXNrUGxhblJlbFBhdGggPSByZWxUYXNrRmlsZShiYXNlUGF0aCwgbWlsZXN0b25lSWQsIHNsaWNlSWQsIHRhc2tJZCwgXCJQTEFOXCIpO1xuICBjb25zdCB0YXNrUGxhbkNvbnRlbnQgPSB0YXNrUGxhblBhdGggPyBhd2FpdCBsb2FkRmlsZSh0YXNrUGxhblBhdGgpIDogbnVsbDtcbiAgY29uc3QgdGFza1BsYW5JbmxpbmUgPSB0YXNrUGxhbkNvbnRlbnRcbiAgICA/IFtcIiMjIElubGluZWQgVGFzayBQbGFuIChhdXRob3JpdGF0aXZlIGxvY2FsIGV4ZWN1dGlvbiBjb250cmFjdClcIiwgYFNvdXJjZTogXFxgJHt0YXNrUGxhblJlbFBhdGh9XFxgYCwgXCJcIiwgdGFza1BsYW5Db250ZW50LnRyaW0oKV0uam9pbihcIlxcblwiKVxuICAgIDogW1wiIyMgSW5saW5lZCBUYXNrIFBsYW4gKGF1dGhvcml0YXRpdmUgbG9jYWwgZXhlY3V0aW9uIGNvbnRyYWN0KVwiLCBgVGFzayBwbGFuIG5vdCBmb3VuZCBhdCBkaXNwYXRjaCB0aW1lLiBSZWFkIFxcYCR7dGFza1BsYW5SZWxQYXRofVxcYCBiZWZvcmUgZXhlY3V0aW5nLmBdLmpvaW4oXCJcXG5cIik7XG5cbiAgY29uc3Qgc2xpY2VQbGFuUGF0aCA9IHJlc29sdmVTbGljZUZpbGUoYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBzbGljZUlkLCBcIlBMQU5cIik7XG4gIGNvbnN0IHNsaWNlUGxhblJlbFBhdGggPSByZWxTbGljZUZpbGUoYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBzbGljZUlkLCBcIlBMQU5cIik7XG4gIGNvbnN0IHNsaWNlUGxhbkNvbnRlbnQgPSBzbGljZVBsYW5QYXRoID8gYXdhaXQgbG9hZEZpbGUoc2xpY2VQbGFuUGF0aCkgOiBudWxsO1xuICBjb25zdCBzbGljZVBsYW5FeGNlcnB0ID0gZXh0cmFjdFNsaWNlRXhlY3V0aW9uRXhjZXJwdChzbGljZVBsYW5Db250ZW50LCBzbGljZVBsYW5SZWxQYXRoKTtcbiAgY29uc3QgcHJpb3JUYXNrTGluZXMgPSBhd2FpdCBidWlsZENhcnJ5Rm9yd2FyZExpbmVzKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgc2xpY2VJZCwgdGFza0lkKTtcbiAgY29uc3QgcmVzdW1lU2VjdGlvbiA9IGF3YWl0IGJ1aWxkUmVzdW1lU2VjdGlvbihiYXNlUGF0aCwgbWlsZXN0b25lSWQsIHNsaWNlSWQpO1xuICBjb25zdCBhY3RpdmVPdmVycmlkZXMgPSBhd2FpdCBsb2FkQWN0aXZlT3ZlcnJpZGVzKGJhc2VQYXRoKTtcbiAgY29uc3Qgb3ZlcnJpZGVzU2VjdGlvbiA9IGZvcm1hdE92ZXJyaWRlc1NlY3Rpb24oYWN0aXZlT3ZlcnJpZGVzKTtcblxuICByZXR1cm4gW1xuICAgIFwiW0dTRCBHdWlkZWQgRXhlY3V0ZSBDb250ZXh0XVwiLFxuICAgIFwiVXNlIHRoaXMgaW5qZWN0ZWQgY29udGV4dCBhcyBzdGFydHVwIGNvbnRleHQgZm9yIGd1aWRlZCB0YXNrIGV4ZWN1dGlvbi4gVHJlYXQgdGhlIGlubGluZWQgdGFzayBwbGFuIGFzIHRoZSBhdXRob3JpdGF0aXZlIGxvY2FsIGV4ZWN1dGlvbiBjb250cmFjdC4gVXNlIHNvdXJjZSBhcnRpZmFjdHMgdG8gdmVyaWZ5IGRldGFpbHMgYW5kIHJ1biBjaGVja3MuXCIsXG4gICAgb3ZlcnJpZGVzU2VjdGlvbiwgXCJcIixcbiAgICBcIlwiLFxuICAgIHJlc3VtZVNlY3Rpb24sXG4gICAgXCJcIixcbiAgICBcIiMjIENhcnJ5LUZvcndhcmQgQ29udGV4dFwiLFxuICAgIC4uLnByaW9yVGFza0xpbmVzLFxuICAgIFwiXCIsXG4gICAgdGFza1BsYW5JbmxpbmUsXG4gICAgXCJcIixcbiAgICBzbGljZVBsYW5FeGNlcnB0LFxuICAgIFwiXCIsXG4gICAgXCIjIyBCYWNraW5nIFNvdXJjZSBBcnRpZmFjdHNcIixcbiAgICBgLSBTbGljZSBwbGFuOiBcXGAke3NsaWNlUGxhblJlbFBhdGh9XFxgYCxcbiAgICBgLSBUYXNrIHBsYW4gc291cmNlOiBcXGAke3Rhc2tQbGFuUmVsUGF0aH1cXGBgLFxuICBdLmpvaW4oXCJcXG5cIik7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGJ1aWxkQ2FycnlGb3J3YXJkTGluZXMoXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIG1pbGVzdG9uZUlkOiBzdHJpbmcsXG4gIHNsaWNlSWQ6IHN0cmluZyxcbiAgdGFza0lkOiBzdHJpbmcsXG4pOiBQcm9taXNlPHN0cmluZ1tdPiB7XG4gIGNvbnN0IHRhc2tzRGlyID0gcmVzb2x2ZVRhc2tzRGlyKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgc2xpY2VJZCk7XG4gIGlmICghdGFza3NEaXIpIHJldHVybiBbXCItIE5vIHByaW9yIHRhc2sgc3VtbWFyaWVzIGluIHRoaXMgc2xpY2UuXCJdO1xuXG4gIGNvbnN0IGN1cnJlbnROdW0gPSBwYXJzZUludCh0YXNrSWQucmVwbGFjZSgvXlQvLCBcIlwiKSwgMTApO1xuICBjb25zdCBzbGljZVJlbCA9IHJlbFNsaWNlUGF0aChiYXNlUGF0aCwgbWlsZXN0b25lSWQsIHNsaWNlSWQpO1xuICBjb25zdCBzdW1tYXJ5RmlsZXMgPSByZXNvbHZlVGFza0ZpbGVzKHRhc2tzRGlyLCBcIlNVTU1BUllcIilcbiAgICAuZmlsdGVyKChmaWxlKSA9PiBwYXJzZUludChmaWxlLnJlcGxhY2UoL15ULywgXCJcIiksIDEwKSA8IGN1cnJlbnROdW0pXG4gICAgLnNvcnQoKTtcblxuICBpZiAoc3VtbWFyeUZpbGVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIFtcIi0gTm8gcHJpb3IgdGFzayBzdW1tYXJpZXMgaW4gdGhpcyBzbGljZS5cIl07XG5cbiAgcmV0dXJuIFByb21pc2UuYWxsKHN1bW1hcnlGaWxlcy5tYXAoYXN5bmMgKGZpbGUpID0+IHtcbiAgICBjb25zdCBhYnNQYXRoID0gam9pbih0YXNrc0RpciwgZmlsZSk7XG4gICAgY29uc3QgY29udGVudCA9IGF3YWl0IGxvYWRGaWxlKGFic1BhdGgpO1xuICAgIGNvbnN0IHJlbFBhdGggPSBgJHtzbGljZVJlbH0vdGFza3MvJHtmaWxlfWA7XG4gICAgaWYgKCFjb250ZW50KSByZXR1cm4gYC0gXFxgJHtyZWxQYXRofVxcYGA7XG5cbiAgICBjb25zdCBzdW1tYXJ5ID0gcGFyc2VTdW1tYXJ5KGNvbnRlbnQpO1xuICAgIGNvbnN0IHByb3ZpZGVkID0gc3VtbWFyeS5mcm9udG1hdHRlci5wcm92aWRlcy5zbGljZSgwLCAyKS5qb2luKFwiOyBcIik7XG4gICAgY29uc3QgZGVjaXNpb25zID0gc3VtbWFyeS5mcm9udG1hdHRlci5rZXlfZGVjaXNpb25zLnNsaWNlKDAsIDIpLmpvaW4oXCI7IFwiKTtcbiAgICBjb25zdCBwYXR0ZXJucyA9IHN1bW1hcnkuZnJvbnRtYXR0ZXIucGF0dGVybnNfZXN0YWJsaXNoZWQuc2xpY2UoMCwgMikuam9pbihcIjsgXCIpO1xuICAgIGNvbnN0IGRpYWdub3N0aWNzID0gZXh0cmFjdE1hcmtkb3duU2VjdGlvbihjb250ZW50LCBcIkRpYWdub3N0aWNzXCIpO1xuICAgIGNvbnN0IHBhcnRzID0gW3N1bW1hcnkudGl0bGUgfHwgcmVsUGF0aF07XG4gICAgaWYgKHN1bW1hcnkub25lTGluZXIpIHBhcnRzLnB1c2goc3VtbWFyeS5vbmVMaW5lcik7XG4gICAgaWYgKHByb3ZpZGVkKSBwYXJ0cy5wdXNoKGBwcm92aWRlczogJHtwcm92aWRlZH1gKTtcbiAgICBpZiAoZGVjaXNpb25zKSBwYXJ0cy5wdXNoKGBkZWNpc2lvbnM6ICR7ZGVjaXNpb25zfWApO1xuICAgIGlmIChwYXR0ZXJucykgcGFydHMucHVzaChgcGF0dGVybnM6ICR7cGF0dGVybnN9YCk7XG4gICAgaWYgKGRpYWdub3N0aWNzKSBwYXJ0cy5wdXNoKGBkaWFnbm9zdGljczogJHtvbmVMaW5lKGRpYWdub3N0aWNzKX1gKTtcbiAgICByZXR1cm4gYC0gXFxgJHtyZWxQYXRofVxcYCBcdTIwMTQgJHtwYXJ0cy5qb2luKFwiIHwgXCIpfWA7XG4gIH0pKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gYnVpbGRSZXN1bWVTZWN0aW9uKGJhc2VQYXRoOiBzdHJpbmcsIG1pbGVzdG9uZUlkOiBzdHJpbmcsIHNsaWNlSWQ6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IGNvbnRpbnVlRmlsZSA9IHJlc29sdmVTbGljZUZpbGUoYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBzbGljZUlkLCBcIkNPTlRJTlVFXCIpO1xuICBjb25zdCBsZWdhY3lEaXIgPSByZXNvbHZlU2xpY2VQYXRoKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgc2xpY2VJZCk7XG4gIGNvbnN0IGxlZ2FjeVBhdGggPSBsZWdhY3lEaXIgPyBqb2luKGxlZ2FjeURpciwgXCJjb250aW51ZS5tZFwiKSA6IG51bGw7XG4gIGNvbnN0IGNvbnRpbnVlQ29udGVudCA9IGNvbnRpbnVlRmlsZSA/IGF3YWl0IGxvYWRGaWxlKGNvbnRpbnVlRmlsZSkgOiBudWxsO1xuICBjb25zdCBsZWdhY3lDb250ZW50ID0gIWNvbnRpbnVlQ29udGVudCAmJiBsZWdhY3lQYXRoID8gYXdhaXQgbG9hZEZpbGUobGVnYWN5UGF0aCkgOiBudWxsO1xuICBjb25zdCByZXNvbHZlZENvbnRlbnQgPSBjb250aW51ZUNvbnRlbnQgPz8gbGVnYWN5Q29udGVudDtcbiAgY29uc3QgcmVzb2x2ZWRSZWxQYXRoID0gY29udGludWVDb250ZW50XG4gICAgPyByZWxTbGljZUZpbGUoYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBzbGljZUlkLCBcIkNPTlRJTlVFXCIpXG4gICAgOiAobGVnYWN5UGF0aCA/IGAke3JlbFNsaWNlUGF0aChiYXNlUGF0aCwgbWlsZXN0b25lSWQsIHNsaWNlSWQpfS9jb250aW51ZS5tZGAgOiBudWxsKTtcblxuICBpZiAoIXJlc29sdmVkQ29udGVudCB8fCAhcmVzb2x2ZWRSZWxQYXRoKSB7XG4gICAgcmV0dXJuIFtcIiMjIFJlc3VtZSBTdGF0ZVwiLCBcIi0gTm8gY29udGludWUgZmlsZSBwcmVzZW50LiBTdGFydCBmcm9tIHRoZSB0b3Agb2YgdGhlIHRhc2sgcGxhbi5cIl0uam9pbihcIlxcblwiKTtcbiAgfVxuXG4gIGNvbnN0IGNvbnQgPSBwYXJzZUNvbnRpbnVlKHJlc29sdmVkQ29udGVudCk7XG4gIGNvbnN0IGxpbmVzID0gW1xuICAgIFwiIyMgUmVzdW1lIFN0YXRlXCIsXG4gICAgYFNvdXJjZTogXFxgJHtyZXNvbHZlZFJlbFBhdGh9XFxgYCxcbiAgICBgLSBTdGF0dXM6ICR7Y29udC5mcm9udG1hdHRlci5zdGF0dXMgfHwgXCJpbl9wcm9ncmVzc1wifWAsXG4gIF07XG4gIGlmIChjb250LmZyb250bWF0dGVyLnN0ZXAgJiYgY29udC5mcm9udG1hdHRlci50b3RhbFN0ZXBzKSB7XG4gICAgbGluZXMucHVzaChgLSBQcm9ncmVzczogc3RlcCAke2NvbnQuZnJvbnRtYXR0ZXIuc3RlcH0gb2YgJHtjb250LmZyb250bWF0dGVyLnRvdGFsU3RlcHN9YCk7XG4gIH1cbiAgaWYgKGNvbnQuY29tcGxldGVkV29yaykgbGluZXMucHVzaChgLSBDb21wbGV0ZWQ6ICR7b25lTGluZShjb250LmNvbXBsZXRlZFdvcmspfWApO1xuICBpZiAoY29udC5yZW1haW5pbmdXb3JrKSBsaW5lcy5wdXNoKGAtIFJlbWFpbmluZzogJHtvbmVMaW5lKGNvbnQucmVtYWluaW5nV29yayl9YCk7XG4gIGlmIChjb250LmRlY2lzaW9ucykgbGluZXMucHVzaChgLSBEZWNpc2lvbnM6ICR7b25lTGluZShjb250LmRlY2lzaW9ucyl9YCk7XG4gIGlmIChjb250Lm5leHRBY3Rpb24pIGxpbmVzLnB1c2goYC0gTmV4dCBhY3Rpb246ICR7b25lTGluZShjb250Lm5leHRBY3Rpb24pfWApO1xuICByZXR1cm4gbGluZXMuam9pbihcIlxcblwiKTtcbn1cblxuZnVuY3Rpb24gZXh0cmFjdFNsaWNlRXhlY3V0aW9uRXhjZXJwdChjb250ZW50OiBzdHJpbmcgfCBudWxsLCByZWxQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAoIWNvbnRlbnQpIHtcbiAgICByZXR1cm4gW1wiIyMgU2xpY2UgUGxhbiBFeGNlcnB0XCIsIGBTbGljZSBwbGFuIG5vdCBmb3VuZCBhdCBkaXNwYXRjaCB0aW1lLiBSZWFkIFxcYCR7cmVsUGF0aH1cXGAgYmVmb3JlIHJ1bm5pbmcgc2xpY2UtbGV2ZWwgdmVyaWZpY2F0aW9uLmBdLmpvaW4oXCJcXG5cIik7XG4gIH1cbiAgY29uc3QgbGluZXMgPSBjb250ZW50LnNwbGl0KFwiXFxuXCIpO1xuICBjb25zdCBnb2FsTGluZSA9IGxpbmVzLmZpbmQoKGxpbmUpID0+IGxpbmUuc3RhcnRzV2l0aChcIioqR29hbDoqKlwiKSk/LnRyaW0oKTtcbiAgY29uc3QgZGVtb0xpbmUgPSBsaW5lcy5maW5kKChsaW5lKSA9PiBsaW5lLnN0YXJ0c1dpdGgoXCIqKkRlbW86KipcIikpPy50cmltKCk7XG4gIGNvbnN0IHZlcmlmaWNhdGlvbiA9IGV4dHJhY3RNYXJrZG93blNlY3Rpb24oY29udGVudCwgXCJWZXJpZmljYXRpb25cIik7XG4gIGNvbnN0IG9ic2VydmFiaWxpdHkgPSBleHRyYWN0TWFya2Rvd25TZWN0aW9uKGNvbnRlbnQsIFwiT2JzZXJ2YWJpbGl0eSAvIERpYWdub3N0aWNzXCIpO1xuICBjb25zdCBwYXJ0cyA9IFtcIiMjIFNsaWNlIFBsYW4gRXhjZXJwdFwiLCBgU291cmNlOiBcXGAke3JlbFBhdGh9XFxgYF07XG4gIGlmIChnb2FsTGluZSkgcGFydHMucHVzaChnb2FsTGluZSk7XG4gIGlmIChkZW1vTGluZSkgcGFydHMucHVzaChkZW1vTGluZSk7XG4gIGlmICh2ZXJpZmljYXRpb24pIHBhcnRzLnB1c2goXCJcIiwgXCIjIyMgU2xpY2UgVmVyaWZpY2F0aW9uXCIsIHZlcmlmaWNhdGlvbi50cmltKCkpO1xuICBpZiAob2JzZXJ2YWJpbGl0eSkgcGFydHMucHVzaChcIlwiLCBcIiMjIyBTbGljZSBPYnNlcnZhYmlsaXR5IC8gRGlhZ25vc3RpY3NcIiwgb2JzZXJ2YWJpbGl0eS50cmltKCkpO1xuICByZXR1cm4gcGFydHMuam9pbihcIlxcblwiKTtcbn1cblxuZnVuY3Rpb24gZXh0cmFjdE1hcmtkb3duU2VjdGlvbihjb250ZW50OiBzdHJpbmcsIGhlYWRpbmc6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCBtYXRjaCA9IG5ldyBSZWdFeHAoYF4jIyAke2VzY2FwZVJlZ0V4cChoZWFkaW5nKX1cXFxccyokYCwgXCJtXCIpLmV4ZWMoY29udGVudCk7XG4gIGlmICghbWF0Y2gpIHJldHVybiBudWxsO1xuICBjb25zdCBzdGFydCA9IG1hdGNoLmluZGV4ICsgbWF0Y2hbMF0ubGVuZ3RoO1xuICBjb25zdCByZXN0ID0gY29udGVudC5zbGljZShzdGFydCk7XG4gIGNvbnN0IG5leHRIZWFkaW5nID0gcmVzdC5tYXRjaCgvXiMjXFxzKy9tKTtcbiAgY29uc3QgZW5kID0gbmV4dEhlYWRpbmc/LmluZGV4ID8/IHJlc3QubGVuZ3RoO1xuICByZXR1cm4gcmVzdC5zbGljZSgwLCBlbmQpLnRyaW0oKTtcbn1cblxuZnVuY3Rpb24gZXNjYXBlUmVnRXhwKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdmFsdWUucmVwbGFjZSgvWy4qKz9eJHt9KCl8W1xcXVxcXFxdL2csIFwiXFxcXCQmXCIpO1xufVxuXG5mdW5jdGlvbiBvbmVMaW5lKHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiB0ZXh0LnJlcGxhY2UoL1xccysvZywgXCIgXCIpLnRyaW0oKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEZvcmVuc2ljcyBDb250ZXh0IFJlLWluamVjdGlvbiAoIzI5NDEpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIENoZWNrIGZvciBhbiBhY3RpdmUgZm9yZW5zaWNzIHNlc3Npb24gYW5kIHJldHVybiB0aGUgcHJvbXB0IGNvbnRlbnRcbiAqIHNvIGl0IGNhbiBiZSByZS1pbmplY3RlZCBvbiBmb2xsb3ctdXAgdHVybnMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZEZvcmVuc2ljc0NvbnRleHRJbmplY3Rpb24oYmFzZVBhdGg6IHN0cmluZywgcHJvbXB0OiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3QgbWFya2VyID0gcmVhZEZvcmVuc2ljc01hcmtlcihiYXNlUGF0aCk7XG4gIGlmICghbWFya2VyKSByZXR1cm4gbnVsbDtcblxuICAvLyBFeHBpcmUgbWFya2VycyBvbGRlciB0aGFuIDIgaG91cnMgdG8gYXZvaWQgc3RhbGUgY29udGV4dFxuICBjb25zdCBhZ2UgPSBEYXRlLm5vdygpIC0gbmV3IERhdGUobWFya2VyLmNyZWF0ZWRBdCkuZ2V0VGltZSgpO1xuICBpZiAoYWdlID4gMiAqIDYwICogNjAgKiAxMDAwKSB7XG4gICAgY2xlYXJGb3JlbnNpY3NNYXJrZXIoYmFzZVBhdGgpO1xuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgY29uc3QgdHJpbW1lZCA9IHByb21wdC50cmltKCkudG9Mb3dlckNhc2UoKS5yZXBsYWNlKC9bLiE/LF0rJC9nLCBcIlwiKTtcbiAgaWYgKHRyaW1tZWQgJiYgIVJFU1VNRV9JTlRFTlRfUEFUVEVSTlMudGVzdCh0cmltbWVkKSkge1xuICAgIGNsZWFyRm9yZW5zaWNzTWFya2VyKGJhc2VQYXRoKTtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIHJldHVybiBtYXJrZXIucHJvbXB0Q29udGVudDtcbn1cblxuLyoqXG4gKiBSZW1vdmUgdGhlIGFjdGl2ZSBmb3JlbnNpY3MgbWFya2VyIGZpbGUsIGUuZy4gd2hlbiB0aGUgaW52ZXN0aWdhdGlvblxuICogaXMgY29tcGxldGUgb3IgdGhlIHNlc3Npb24gZXhwaXJlcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNsZWFyRm9yZW5zaWNzTWFya2VyKGJhc2VQYXRoOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgbWFya2VyUGF0aCA9IGpvaW4oYmFzZVBhdGgsIFwiLmdzZFwiLCBcInJ1bnRpbWVcIiwgXCJhY3RpdmUtZm9yZW5zaWNzLmpzb25cIik7XG4gIGlmIChleGlzdHNTeW5jKG1hcmtlclBhdGgpKSB7XG4gICAgdHJ5IHtcbiAgICAgIHVubGlua1N5bmMobWFya2VyUGF0aCk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgbG9nV2FybmluZyhcImJvb3RzdHJhcFwiLCBgdW5saW5rU3luYyBmb3JlbnNpY3MgbWFya2VyIGZhaWxlZDogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICB9XG4gIH1cbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUVBLFNBQVMsWUFBWSxjQUFjLGtCQUFrQjtBQUNyRCxTQUFTLFlBQVk7QUFJckIsU0FBUyxr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
