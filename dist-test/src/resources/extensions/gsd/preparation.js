import { readdirSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { readdirSync as readdirSyncNode } from "node:fs";
import {
  detectProjectSignals,
  scanProjectFiles
} from "./detection.js";
import { loadFile } from "./files.js";
const MAX_CODEBASE_BRIEF_CHARS = 3e3;
const SAMPLE_FILE_COUNT = 5;
const MAX_FILE_SAMPLE_BYTES = 8192;
const SKIP_DIRS = /* @__PURE__ */ new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  "coverage",
  ".next",
  ".nuxt",
  "target",
  ".turbo",
  "vendor",
  "__pycache__",
  ".venv",
  "venv"
]);
const EXCLUDE_PATTERNS = [
  /\.test\.(ts|tsx|js|jsx|mjs|cjs)$/,
  /\.spec\.(ts|tsx|js|jsx|mjs|cjs)$/,
  /\.d\.ts$/,
  /test-.*\.(ts|tsx|js|jsx)$/,
  /.*\.min\.(js|css)$/
];
const SAMPLE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const UNIVERSAL_SOURCE_EXTENSIONS = [
  // JavaScript/TypeScript
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  // Python
  ".py",
  ".pyw",
  ".pyi",
  // Ruby
  ".rb",
  ".rake",
  ".gemspec",
  // Go
  ".go",
  // Rust
  ".rs",
  // Java/Kotlin
  ".java",
  ".kt",
  ".kts",
  // C/C++
  ".c",
  ".cpp",
  ".cc",
  ".cxx",
  ".h",
  ".hpp",
  // C#
  ".cs",
  // Swift
  ".swift",
  // PHP
  ".php",
  // Scala
  ".scala",
  // Elixir/Erlang
  ".ex",
  ".exs",
  ".erl",
  // Haskell
  ".hs",
  ".lhs",
  // Shell
  ".sh",
  ".bash",
  ".zsh",
  // Lua
  ".lua",
  // Dart
  ".dart"
];
const ASYNC_AWAIT_RE = /\basync\s+function\b|\basync\s*\(|\bawait\s+/g;
const CALLBACK_RE = /\b(callback|cb|done)\s*\(|\bfunction\s*\([^)]*\bfunction\b/g;
const PROMISE_RE = /\.then\s*\(|\.catch\s*\(|\bnew\s+Promise\s*\(/g;
const TRY_CATCH_RE = /\btry\s*\{[\s\S]*?\bcatch\s*\(/g;
const ERROR_CALLBACK_RE = /\bif\s*\(\s*(err|error)\s*\)|\(err(or)?\s*,/g;
const RESULT_TYPE_RE = /\bResult<|\bEither<|\bisOk\(|\bisErr\(|\b(Ok|Err)\(/g;
const CAMEL_CASE_RE = /\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g;
const SNAKE_CASE_RE = /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/g;
const PASCAL_CASE_RE = /\bclass\s+[A-Z][a-zA-Z0-9]*|\binterface\s+[A-Z][a-zA-Z0-9]*|\btype\s+[A-Z][a-zA-Z0-9]*/g;
const LANGUAGE_PATTERNS = {
  "javascript/typescript": {
    displayName: "JavaScript/TypeScript",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    asyncStyle: {
      modern: /\basync\s+function\b|\basync\s*\(|\bawait\s+/g,
      modernLabel: "async/await",
      legacy: /\.then\s*\(|\.catch\s*\(|\bnew\s+Promise\s*\(/g,
      legacyLabel: "promises"
    },
    errorHandling: {
      structured: /\btry\s*\{[\s\S]*?\bcatch\s*\(/g,
      structuredLabel: "try/catch",
      inline: /\bif\s*\(\s*(err|error)\s*\)|\(err(or)?\s*,/g,
      inlineLabel: "error-callbacks"
    }
  },
  python: {
    displayName: "Python",
    extensions: [".py", ".pyw", ".pyi"],
    asyncStyle: {
      modern: /\basync\s+def\b|\bawait\s+/g,
      modernLabel: "async/await",
      legacy: /\.add_done_callback\(|ThreadPoolExecutor|ProcessPoolExecutor/g,
      legacyLabel: "futures/executors"
    },
    errorHandling: {
      structured: /\btry\s*:[\s\S]*?\bexcept\b/g,
      structuredLabel: "try/except",
      inline: /\braise\s+\w+Error|\bassert\s+/g,
      inlineLabel: "raise/assert"
    }
  },
  rust: {
    displayName: "Rust",
    extensions: [".rs"],
    asyncStyle: {
      modern: /\basync\s+fn\b|\.await\b/g,
      modernLabel: "async/await",
      legacy: /\bthread::spawn\(|\bmpsc::/g,
      legacyLabel: "threads/channels"
    },
    errorHandling: {
      structured: /\bResult<|\bOption<|\?\s*;/g,
      structuredLabel: "Result/Option",
      inline: /\bunwrap\(\)|\bexpect\(/g,
      inlineLabel: "unwrap/expect"
    }
  },
  go: {
    displayName: "Go",
    extensions: [".go"],
    asyncStyle: {
      modern: /\bgo\s+func\b|\bgo\s+\w+\(/g,
      modernLabel: "goroutines",
      legacy: /\bchan\s+\w+|<-\s*\w+|\w+\s*<-/g,
      legacyLabel: "channels"
    },
    errorHandling: {
      structured: /\bif\s+err\s*!=\s*nil\b/g,
      structuredLabel: "if err != nil",
      inline: /\bpanic\(|\brecover\(\)/g,
      inlineLabel: "panic/recover"
    }
  },
  java: {
    displayName: "Java",
    extensions: [".java"],
    asyncStyle: {
      modern: /\bCompletableFuture<|\bCompletionStage<|\bthenApply\(/g,
      modernLabel: "CompletableFuture",
      legacy: /\bThread\s+\w+\s*=|\bnew\s+Thread\(|\bExecutorService\b/g,
      legacyLabel: "threads/executors"
    },
    errorHandling: {
      structured: /\btry\s*\{[\s\S]*?\bcatch\s*\(/g,
      structuredLabel: "try/catch",
      inline: /\bthrows\s+\w+Exception|\bthrow\s+new\s+\w+Exception/g,
      inlineLabel: "throws/throw"
    }
  },
  "java/kotlin": {
    displayName: "Java/Kotlin",
    extensions: [".java", ".kt", ".kts"],
    asyncStyle: {
      modern: /\bsuspend\s+fun\b|\blaunch\s*\{|\basync\s*\{|\bwithContext\(/g,
      modernLabel: "coroutines",
      legacy: /\bThread\s+\w+\s*=|\bnew\s+Thread\(|\bExecutorService\b|\bCompletableFuture</g,
      legacyLabel: "threads/futures"
    },
    errorHandling: {
      structured: /\btry\s*\{[\s\S]*?\bcatch\s*\(/g,
      structuredLabel: "try/catch",
      inline: /\bthrows\s+\w+Exception|\bthrow\s+\w+Exception|\brunCatching\s*\{/g,
      inlineLabel: "throws/runCatching"
    }
  }
};
async function analyzeCodebase(basePath) {
  const signals = detectProjectSignals(basePath);
  const moduleStructure = detectModuleStructure(basePath);
  const sampledFiles = sampleSourceFiles(basePath, signals.primaryLanguage);
  const patterns = extractPatterns(basePath, sampledFiles, signals.primaryLanguage);
  return {
    techStack: {
      primaryLanguage: signals.primaryLanguage,
      detectedFiles: signals.detectedFiles,
      packageManager: signals.packageManager,
      isMonorepo: signals.isMonorepo,
      hasTests: signals.hasTests,
      hasCI: signals.hasCI
    },
    moduleStructure,
    patterns,
    sampledFiles
  };
}
function detectModuleStructure(basePath) {
  const topLevelDirs = [];
  const srcSubdirs = [];
  try {
    const entries = readdirSync(basePath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name)) {
        topLevelDirs.push(entry.name);
      }
    }
  } catch {
  }
  for (const srcDir of ["src", "lib", "app"]) {
    const srcPath = join(basePath, srcDir);
    try {
      const entries = readdirSync(srcPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name)) {
          srcSubdirs.push(entry.name);
        }
      }
    } catch {
    }
  }
  return {
    topLevelDirs,
    srcSubdirs: [...new Set(srcSubdirs)],
    // Dedupe
    totalFilesSampled: 0
    // Will be set after sampling
  };
}
function sampleSourceFiles(basePath, primaryLanguage) {
  const allFiles = scanProjectFiles(basePath);
  const languageEntry = primaryLanguage ? LANGUAGE_PATTERNS[primaryLanguage] : void 0;
  let extensionsToSample;
  if (languageEntry) {
    extensionsToSample = languageEntry.extensions;
  } else if (primaryLanguage === void 0) {
    extensionsToSample = SAMPLE_EXTENSIONS;
  } else {
    extensionsToSample = UNIVERSAL_SOURCE_EXTENSIONS;
  }
  const candidates = allFiles.filter((file) => {
    const hasValidExtension = extensionsToSample.some((ext) => file.endsWith(ext));
    if (!hasValidExtension) return false;
    for (const pattern of EXCLUDE_PATTERNS) {
      if (pattern.test(file)) return false;
    }
    const parts = file.split(/[/\\]/);
    for (const part of parts) {
      if (SKIP_DIRS.has(part)) return false;
    }
    return true;
  });
  const srcFiles = candidates.filter((f) => f.startsWith("src/") || f.startsWith("src\\"));
  const otherFiles = candidates.filter((f) => !f.startsWith("src/") && !f.startsWith("src\\"));
  const sampled = [];
  for (const file of srcFiles) {
    if (sampled.length >= SAMPLE_FILE_COUNT) break;
    sampled.push(file);
  }
  for (const file of otherFiles) {
    if (sampled.length >= SAMPLE_FILE_COUNT) break;
    sampled.push(file);
  }
  return sampled;
}
function extractPatterns(basePath, sampledFiles, primaryLanguage) {
  const evidence = {
    asyncStyle: [],
    errorHandling: [],
    namingConvention: []
  };
  const counts = {
    asyncAwait: 0,
    callbacks: 0,
    promises: 0,
    tryCatch: 0,
    errorCallbacks: 0,
    resultTypes: 0,
    camelCase: 0,
    snakeCase: 0,
    pascalCase: 0
  };
  const fileCounts = {
    asyncAwait: 0,
    promises: 0,
    callbacks: 0,
    tryCatch: 0,
    errorCallbacks: 0,
    resultTypes: 0
  };
  const languageEntry = primaryLanguage ? LANGUAGE_PATTERNS[primaryLanguage] : LANGUAGE_PATTERNS["javascript/typescript"];
  const languageUnsupported = primaryLanguage !== void 0 && !LANGUAGE_PATTERNS[primaryLanguage];
  if (languageUnsupported) {
    evidence.asyncStyle.push(`Language "${primaryLanguage}" not in pattern registry \u2014 async style detection not available`);
    evidence.errorHandling.push(`Language "${primaryLanguage}" not in pattern registry \u2014 error handling detection not available`);
  }
  for (const file of sampledFiles) {
    let content;
    try {
      const fullPath = join(basePath, file);
      const buffer = Buffer.alloc(MAX_FILE_SAMPLE_BYTES);
      const fd = openSync(fullPath, "r");
      try {
        const bytesRead = readSync(fd, buffer, 0, MAX_FILE_SAMPLE_BYTES, 0);
        content = buffer.toString("utf-8", 0, bytesRead);
      } finally {
        closeSync(fd);
      }
    } catch {
      continue;
    }
    if (!languageUnsupported && languageEntry) {
      const asyncModernMatches = content.match(languageEntry.asyncStyle.modern) || [];
      counts.asyncAwait += asyncModernMatches.length;
      if (asyncModernMatches.length > 0) {
        fileCounts.asyncAwait++;
        if (evidence.asyncStyle.length < 3) {
          evidence.asyncStyle.push(`${file}: ${languageEntry.asyncStyle.modernLabel} (${asyncModernMatches.length} occurrences)`);
        }
      }
      if (primaryLanguage === "javascript/typescript") {
        const callbackMatches = content.match(CALLBACK_RE) || [];
        counts.callbacks += callbackMatches.length;
        if (callbackMatches.length > 0) {
          fileCounts.callbacks++;
          if (evidence.asyncStyle.length < 3) {
            evidence.asyncStyle.push(`${file}: callbacks (${callbackMatches.length} occurrences)`);
          }
        }
      }
      const asyncLegacyMatches = content.match(languageEntry.asyncStyle.legacy) || [];
      counts.promises += asyncLegacyMatches.length;
      if (asyncLegacyMatches.length > 0) {
        fileCounts.promises++;
        if (evidence.asyncStyle.length < 3) {
          evidence.asyncStyle.push(`${file}: ${languageEntry.asyncStyle.legacyLabel} (${asyncLegacyMatches.length} occurrences)`);
        }
      }
      const errorStructuredMatches = content.match(languageEntry.errorHandling.structured) || [];
      counts.tryCatch += errorStructuredMatches.length;
      if (errorStructuredMatches.length > 0) {
        fileCounts.tryCatch++;
        if (evidence.errorHandling.length < 3) {
          evidence.errorHandling.push(`${file}: ${languageEntry.errorHandling.structuredLabel} (${errorStructuredMatches.length} occurrences)`);
        }
      }
      const errorInlineMatches = content.match(languageEntry.errorHandling.inline) || [];
      counts.errorCallbacks += errorInlineMatches.length;
      if (errorInlineMatches.length > 0) {
        fileCounts.errorCallbacks++;
        if (evidence.errorHandling.length < 3) {
          evidence.errorHandling.push(`${file}: ${languageEntry.errorHandling.inlineLabel} (${errorInlineMatches.length} occurrences)`);
        }
      }
      const resultTypeMatches = content.match(RESULT_TYPE_RE) || [];
      counts.resultTypes += resultTypeMatches.length;
      if (resultTypeMatches.length > 0) {
        fileCounts.resultTypes++;
        if (evidence.errorHandling.length < 3) {
          evidence.errorHandling.push(`${file}: result-types (${resultTypeMatches.length} occurrences)`);
        }
      }
    }
    const camelMatches = content.match(CAMEL_CASE_RE) || [];
    counts.camelCase += camelMatches.length;
    const snakeMatches = content.match(SNAKE_CASE_RE) || [];
    counts.snakeCase += snakeMatches.length;
    const pascalMatches = content.match(PASCAL_CASE_RE) || [];
    counts.pascalCase += pascalMatches.length;
  }
  if (counts.camelCase > 0) {
    evidence.namingConvention.push(`camelCase: ${counts.camelCase} occurrences`);
  }
  if (counts.snakeCase > 0) {
    evidence.namingConvention.push(`snake_case: ${counts.snakeCase} occurrences`);
  }
  if (counts.pascalCase > 0) {
    evidence.namingConvention.push(`PascalCase: ${counts.pascalCase} occurrences`);
  }
  if (languageUnsupported) {
    return {
      asyncStyle: "unknown",
      errorHandling: "unknown",
      namingConvention: determineNamingConvention(counts),
      evidence,
      fileCounts
    };
  }
  return {
    asyncStyle: determineAsyncStyle(counts),
    errorHandling: determineErrorHandling(counts),
    namingConvention: determineNamingConvention(counts),
    evidence,
    fileCounts
  };
}
function determineAsyncStyle(counts) {
  const total = counts.asyncAwait + counts.callbacks + counts.promises;
  if (total === 0) return "unknown";
  const asyncAwaitRatio = counts.asyncAwait / total;
  const callbackRatio = counts.callbacks / total;
  const promiseRatio = counts.promises / total;
  if (asyncAwaitRatio > 0.6) return "async/await";
  if (callbackRatio > 0.6) return "callbacks";
  if (promiseRatio > 0.6) return "promises";
  return "mixed";
}
function determineErrorHandling(counts) {
  const total = counts.tryCatch + counts.errorCallbacks + counts.resultTypes;
  if (total === 0) return "unknown";
  const tryCatchRatio = counts.tryCatch / total;
  const errorCallbackRatio = counts.errorCallbacks / total;
  const resultTypeRatio = counts.resultTypes / total;
  if (tryCatchRatio > 0.6) return "try/catch";
  if (errorCallbackRatio > 0.6) return "error-callbacks";
  if (resultTypeRatio > 0.6) return "result-types";
  return "mixed";
}
function determineNamingConvention(counts) {
  const total = counts.camelCase + counts.snakeCase + counts.pascalCase;
  if (total === 0) return "unknown";
  const camelRatio = counts.camelCase / total;
  const snakeRatio = counts.snakeCase / total;
  if (camelRatio > 0.6) return "camelCase";
  if (snakeRatio > 0.6) return "snake_case";
  if (counts.pascalCase > counts.camelCase && counts.pascalCase > counts.snakeCase) return "PascalCase";
  return "mixed";
}
function formatCodebaseBrief(brief) {
  const sections = [];
  sections.push("## Tech Stack");
  if (brief.techStack.primaryLanguage) {
    sections.push(`- **Language:** ${brief.techStack.primaryLanguage}`);
  }
  if (brief.techStack.packageManager) {
    sections.push(`- **Package Manager:** ${brief.techStack.packageManager}`);
  }
  if (brief.techStack.detectedFiles.length > 0) {
    const files = brief.techStack.detectedFiles.slice(0, 10).join(", ");
    sections.push(`- **Project Files:** ${files}`);
  }
  sections.push(`- **Monorepo:** ${brief.techStack.isMonorepo ? "Yes" : "No"}`);
  sections.push(`- **Has Tests:** ${brief.techStack.hasTests ? "Yes" : "No"}`);
  sections.push(`- **Has CI:** ${brief.techStack.hasCI ? "Yes" : "No"}`);
  sections.push("");
  sections.push("## Module Structure");
  if (brief.moduleStructure.topLevelDirs.length > 0) {
    sections.push(`- **Top-level dirs:** ${brief.moduleStructure.topLevelDirs.join(", ")}`);
  }
  if (brief.moduleStructure.srcSubdirs.length > 0) {
    sections.push(`- **Source subdirs:** ${brief.moduleStructure.srcSubdirs.join(", ")}`);
  }
  sections.push("");
  sections.push("## Code Patterns");
  const fc = brief.patterns.fileCounts;
  if (brief.patterns.asyncStyle === "unknown") {
    sections.push(`- **Async Style:** ${brief.patterns.asyncStyle}`);
  } else {
    const asyncParts = [];
    if (fc.asyncAwait > 0) asyncParts.push(`${fc.asyncAwait} async/await`);
    if (fc.promises > 0) asyncParts.push(`${fc.promises} .then()`);
    if (fc.callbacks > 0) asyncParts.push(`${fc.callbacks} callback`);
    const asyncDetail = asyncParts.length > 0 ? ` (${asyncParts.map((p) => p + " files").join(" vs ")})` : "";
    sections.push(`- **Async Style:** ${brief.patterns.asyncStyle}${asyncDetail}`);
  }
  if (brief.patterns.errorHandling === "unknown") {
    sections.push(`- **Error Handling:** ${brief.patterns.errorHandling}`);
  } else {
    const errorParts = [];
    if (fc.tryCatch > 0) errorParts.push(`${fc.tryCatch} try/catch`);
    if (fc.errorCallbacks > 0) errorParts.push(`${fc.errorCallbacks} error-callback`);
    if (fc.resultTypes > 0) errorParts.push(`${fc.resultTypes} result-type`);
    const errorDetail = errorParts.length > 0 ? ` (${errorParts.map((p) => p + " files").join(" vs ")})` : "";
    sections.push(`- **Error Handling:** ${brief.patterns.errorHandling}${errorDetail}`);
  }
  sections.push(`- **Naming Convention:** ${brief.patterns.namingConvention}`);
  let result = sections.join("\n");
  if (result.length > MAX_CODEBASE_BRIEF_CHARS) {
    result = result.slice(0, MAX_CODEBASE_BRIEF_CHARS - 3) + "...";
  }
  return result;
}
const MAX_SECTION_CHARS = 2e3;
const MAX_PRIOR_CONTEXT_CHARS = 6e3;
async function aggregatePriorContext(basePath) {
  const gsdPath = join(basePath, ".gsd");
  const decisionsContent = await loadFile(join(gsdPath, "DECISIONS.md"));
  const decisions = parseDecisions(decisionsContent);
  const requirementsContent = await loadFile(join(gsdPath, "REQUIREMENTS.md"));
  const requirements = parseRequirements(requirementsContent);
  const knowledgeContent = await loadFile(join(gsdPath, "KNOWLEDGE.md"));
  const knowledge = truncateSection(knowledgeContent || "", MAX_SECTION_CHARS);
  const summaries = await loadMilestoneSummaries(gsdPath);
  return {
    decisions,
    requirements,
    knowledge: knowledge || "No prior knowledge recorded.",
    summaries: summaries || "No prior milestone summaries."
  };
}
function parseDecisions(content) {
  const byScope = /* @__PURE__ */ new Map();
  if (!content) {
    return { byScope, totalCount: 0 };
  }
  const lines = content.split("\n");
  let totalCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    if (trimmed.startsWith("| #") || trimmed.startsWith("|---") || trimmed.startsWith("| -")) continue;
    const cells = trimmed.split("|").map((c) => c.trim()).filter((c) => c.length > 0);
    if (cells.length < 6) continue;
    const id = cells[0];
    if (!id.match(/^D\d+$/)) continue;
    const scope = cells[2];
    const decision = cells[3];
    const choice = cells[4];
    const rationale = cells[5];
    const entry = { id, scope, decision, choice, rationale };
    if (!byScope.has(scope)) {
      byScope.set(scope, []);
    }
    byScope.get(scope).push(entry);
    totalCount++;
  }
  return { byScope, totalCount };
}
function parseRequirements(content) {
  const result = {
    active: [],
    validated: [],
    deferred: [],
    totalCount: 0
  };
  if (!content) {
    return result;
  }
  const reqBlocks = content.split(/(?=^### R\d+)/m);
  for (const block of reqBlocks) {
    const idMatch = block.match(/^### (R\d+)\s*—\s*(.+)/m);
    if (!idMatch) continue;
    const id = idMatch[1];
    const description = idMatch[2].trim();
    const statusMatch = block.match(/^-\s*Status:\s*(\w+)/m);
    const statusRaw = statusMatch ? statusMatch[1].toLowerCase() : "active";
    let status = "active";
    if (statusRaw === "validated") status = "validated";
    else if (statusRaw === "deferred") status = "deferred";
    else if (statusRaw === "out-of-scope" || statusRaw === "outofscope") status = "out-of-scope";
    const entry = { id, description, status };
    if (status === "active") result.active.push(entry);
    else if (status === "validated") result.validated.push(entry);
    else if (status === "deferred") result.deferred.push(entry);
    result.totalCount++;
  }
  return result;
}
async function loadMilestoneSummaries(gsdPath) {
  const milestonesPath = join(gsdPath, "milestones");
  const summaries = [];
  try {
    const entries = readdirSyncNode(milestonesPath, { withFileTypes: true });
    const milestoneIds = entries.filter((e) => e.isDirectory() && e.name.match(/^M\d+/)).map((e) => e.name).sort();
    for (const mid of milestoneIds) {
      const summaryPath = join(milestonesPath, mid, "MILESTONE-SUMMARY.md");
      const content = await loadFile(summaryPath);
      if (content) {
        const oneLiner = extractOneLiner(content);
        summaries.push(`### ${mid}
${oneLiner}`);
      }
    }
  } catch {
  }
  if (summaries.length === 0) {
    return "";
  }
  return truncateSection(summaries.join("\n\n"), MAX_SECTION_CHARS);
}
function extractOneLiner(content) {
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("**") && trimmed.endsWith("**") && trimmed.length > 4) {
      return trimmed.slice(2, -2);
    }
  }
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("---")) {
      return trimmed.slice(0, 200);
    }
  }
  return "Summary available";
}
function truncateSection(content, maxChars) {
  if (content.length <= maxChars) {
    return content;
  }
  const SECTION_SUFFIX = "\n\n[truncated]";
  const WORD_SUFFIX = "... [truncated]";
  const sectionMaxSlice = maxChars - SECTION_SUFFIX.length;
  const wordMaxSlice = maxChars - WORD_SUFFIX.length;
  const truncated = content.slice(0, sectionMaxSlice);
  const lastSection = truncated.lastIndexOf("\n## ");
  if (lastSection > sectionMaxSlice * 0.5) {
    return truncated.slice(0, lastSection).trim() + SECTION_SUFFIX;
  }
  const lastPara = truncated.lastIndexOf("\n\n");
  if (lastPara > sectionMaxSlice * 0.5) {
    return truncated.slice(0, lastPara).trim() + SECTION_SUFFIX;
  }
  const wordTruncated = content.slice(0, wordMaxSlice);
  const lastSpace = wordTruncated.lastIndexOf(" ");
  if (lastSpace > wordMaxSlice * 0.8) {
    return wordTruncated.slice(0, lastSpace).trim() + WORD_SUFFIX;
  }
  return content.slice(0, wordMaxSlice) + WORD_SUFFIX;
}
function formatPriorContextBrief(brief) {
  const sections = [];
  sections.push("## Prior Decisions");
  if (brief.decisions.totalCount === 0) {
    sections.push("No prior decisions recorded.");
  } else {
    sections.push(`${brief.decisions.totalCount} decisions recorded.`);
    sections.push("");
    for (const [scope, entries] of brief.decisions.byScope) {
      sections.push(`### ${scope}`);
      for (const entry of entries.slice(0, 5)) {
        sections.push(`- **${entry.id}:** ${entry.decision} \u2192 ${entry.choice}`);
      }
      if (entries.length > 5) {
        sections.push(`- _(${entries.length - 5} more in this scope)_`);
      }
      sections.push("");
    }
  }
  sections.push("## Prior Requirements");
  const reqTotal = brief.requirements.totalCount;
  if (reqTotal === 0) {
    sections.push("No prior requirements recorded.");
  } else {
    sections.push(
      `${reqTotal} requirements: ${brief.requirements.active.length} active, ${brief.requirements.validated.length} validated, ${brief.requirements.deferred.length} deferred.`
    );
    sections.push("");
    if (brief.requirements.active.length > 0) {
      sections.push("### Active");
      for (const req of brief.requirements.active.slice(0, 10)) {
        sections.push(`- **${req.id}:** ${req.description}`);
      }
      if (brief.requirements.active.length > 10) {
        sections.push(`- _(${brief.requirements.active.length - 10} more active)_`);
      }
      sections.push("");
    }
    if (brief.requirements.validated.length > 0) {
      sections.push("### Validated");
      for (const req of brief.requirements.validated.slice(0, 5)) {
        sections.push(`- **${req.id}:** ${req.description}`);
      }
      if (brief.requirements.validated.length > 5) {
        sections.push(`- _(${brief.requirements.validated.length - 5} more validated)_`);
      }
      sections.push("");
    }
  }
  sections.push("## Prior Knowledge");
  if (brief.knowledge === "No prior knowledge recorded.") {
    sections.push(brief.knowledge);
  } else {
    sections.push(truncateSection(brief.knowledge, MAX_SECTION_CHARS));
  }
  sections.push("");
  sections.push("## Prior Milestone Summaries");
  if (brief.summaries === "No prior milestone summaries.") {
    sections.push(brief.summaries);
  } else {
    sections.push(truncateSection(brief.summaries, MAX_SECTION_CHARS));
  }
  let result = sections.join("\n");
  if (result.length > MAX_PRIOR_CONTEXT_CHARS) {
    result = truncateSection(result, MAX_PRIOR_CONTEXT_CHARS);
  }
  return result;
}
const MAX_ECOSYSTEM_BRIEF_CHARS = 4e3;
async function researchEcosystem(_techStack, _basePath) {
  return {
    available: false,
    queries: [],
    findings: [],
    skippedReason: "Ecosystem research is performed during the discussion using web search tools, not during preparation."
  };
}
async function runPreparation(basePath, ui, prefs) {
  const startTime = performance.now();
  const preparationEnabled = prefs.discuss_preparation !== false;
  if (!preparationEnabled) {
    const emptyCodebase = {
      techStack: {
        primaryLanguage: void 0,
        detectedFiles: [],
        packageManager: void 0,
        isMonorepo: false,
        hasTests: false,
        hasCI: false
      },
      moduleStructure: {
        topLevelDirs: [],
        srcSubdirs: [],
        totalFilesSampled: 0
      },
      patterns: {
        asyncStyle: "unknown",
        errorHandling: "unknown",
        namingConvention: "unknown",
        evidence: {
          asyncStyle: [],
          errorHandling: [],
          namingConvention: []
        },
        fileCounts: {
          asyncAwait: 0,
          promises: 0,
          callbacks: 0,
          tryCatch: 0,
          errorCallbacks: 0,
          resultTypes: 0
        }
      },
      sampledFiles: []
    };
    const emptyPriorContext = {
      decisions: {
        byScope: /* @__PURE__ */ new Map(),
        totalCount: 0
      },
      requirements: {
        active: [],
        validated: [],
        deferred: [],
        totalCount: 0
      },
      knowledge: "No prior knowledge recorded.",
      summaries: "No prior milestone summaries."
    };
    const emptyEcosystem = {
      available: false,
      queries: [],
      findings: [],
      skippedReason: "Preparation phase disabled."
    };
    return {
      codebase: emptyCodebase,
      codebaseBrief: "",
      priorContext: emptyPriorContext,
      priorContextBrief: "",
      ecosystem: emptyEcosystem,
      ecosystemBrief: "",
      enabled: false,
      ecosystemResearchPerformed: false,
      durationMs: performance.now() - startTime
    };
  }
  ui?.notify("Analyzing codebase...", "info");
  const codebase = await analyzeCodebase(basePath);
  const codebaseBrief = formatCodebaseBrief(codebase);
  ui?.notify("\u2713 Analyzed codebase", "success");
  ui?.notify("Reviewing prior context...", "info");
  const priorContext = await aggregatePriorContext(basePath);
  const priorContextBrief = formatPriorContextBrief(priorContext);
  ui?.notify("\u2713 Reviewed prior context", "success");
  const ecosystem = await researchEcosystem([], basePath);
  const ecosystemBrief = formatEcosystemBrief(ecosystem);
  return {
    codebase,
    codebaseBrief,
    priorContext,
    priorContextBrief,
    ecosystem,
    ecosystemBrief,
    enabled: true,
    ecosystemResearchPerformed: false,
    durationMs: performance.now() - startTime
  };
}
function formatEcosystemBrief(_brief) {
  return "## Ecosystem Research\n\nEcosystem research is performed during the discussion using web search tools.";
}
export {
  LANGUAGE_PATTERNS,
  aggregatePriorContext,
  analyzeCodebase,
  formatCodebaseBrief,
  formatEcosystemBrief,
  formatPriorContextBrief,
  researchEcosystem,
  runPreparation
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9wcmVwYXJhdGlvbi50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBHU0QgUHJlcGFyYXRpb24gXHUyMDE0IFN0cnVjdHVyZWQgYnJpZWYgZ2VuZXJhdGlvbiBmb3IgZGlzY3Vzc2lvbiBMTE0gc2Vzc2lvbnMuXG4gKlxuICogUHJvZHVjZXMgc3RydWN0dXJlZCBicmllZnMgKGNvZGViYXNlLCBwcmlvciBjb250ZXh0LCBlY29zeXN0ZW0pIGJlZm9yZVxuICogdGhlIGRpc2N1c3Npb24gTExNIHNlc3Npb24gc3RhcnRzLlxuICpcbiAqIFB1cmUgZnVuY3Rpb25zLCB6ZXJvIFVJIGRlcGVuZGVuY2llcyAoZXhjZXB0IGZvciBydW5QcmVwYXJhdGlvbiBvcmNoZXN0cmF0b3IpLlxuICovXG5cbmltcG9ydCB7IHJlYWRkaXJTeW5jLCByZWFkRmlsZVN5bmMsIHN0YXRTeW5jLCBvcGVuU3luYywgcmVhZFN5bmMsIGNsb3NlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luLCByZWxhdGl2ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHJlYWRkaXJTeW5jIGFzIHJlYWRkaXJTeW5jTm9kZSB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQge1xuICBkZXRlY3RQcm9qZWN0U2lnbmFscyxcbiAgc2NhblByb2plY3RGaWxlcyxcbiAgUFJPSkVDVF9GSUxFUyxcbiAgdHlwZSBQcm9qZWN0U2lnbmFscyxcbn0gZnJvbSBcIi4vZGV0ZWN0aW9uLmpzXCI7XG5pbXBvcnQgeyBsb2FkRmlsZSB9IGZyb20gXCIuL2ZpbGVzLmpzXCI7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUeXBlcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqIERldGVjdGVkIHBhdHRlcm5zIGluIHRoZSBjb2RlYmFzZS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQ29kZVBhdHRlcm5zIHtcbiAgLyoqIFByaW1hcnkgYXN5bmMgc3R5bGU6IFwiYXN5bmMvYXdhaXRcIiB8IFwiY2FsbGJhY2tzXCIgfCBcInByb21pc2VzXCIgfCBcIm1peGVkXCIgKi9cbiAgYXN5bmNTdHlsZTogXCJhc3luYy9hd2FpdFwiIHwgXCJjYWxsYmFja3NcIiB8IFwicHJvbWlzZXNcIiB8IFwibWl4ZWRcIiB8IFwidW5rbm93blwiO1xuICAvKiogUHJpbWFyeSBlcnJvciBoYW5kbGluZzogXCJ0cnkvY2F0Y2hcIiB8IFwiZXJyb3ItY2FsbGJhY2tzXCIgfCBcInJlc3VsdC10eXBlc1wiIHwgXCJtaXhlZFwiICovXG4gIGVycm9ySGFuZGxpbmc6IFwidHJ5L2NhdGNoXCIgfCBcImVycm9yLWNhbGxiYWNrc1wiIHwgXCJyZXN1bHQtdHlwZXNcIiB8IFwibWl4ZWRcIiB8IFwidW5rbm93blwiO1xuICAvKiogUHJpbWFyeSBuYW1pbmcgY29udmVudGlvbjogXCJjYW1lbENhc2VcIiB8IFwic25ha2VfY2FzZVwiIHwgXCJQYXNjYWxDYXNlXCIgfCBcIm1peGVkXCIgKi9cbiAgbmFtaW5nQ29udmVudGlvbjogXCJjYW1lbENhc2VcIiB8IFwic25ha2VfY2FzZVwiIHwgXCJQYXNjYWxDYXNlXCIgfCBcIm1peGVkXCIgfCBcInVua25vd25cIjtcbiAgLyoqIFNhbXBsZSBldmlkZW5jZSBzdHJpbmdzIGZvciBlYWNoIHBhdHRlcm4gKGZvciBkZWJ1Z2dpbmcvdHJhbnNwYXJlbmN5KSAqL1xuICBldmlkZW5jZToge1xuICAgIGFzeW5jU3R5bGU6IHN0cmluZ1tdO1xuICAgIGVycm9ySGFuZGxpbmc6IHN0cmluZ1tdO1xuICAgIG5hbWluZ0NvbnZlbnRpb246IHN0cmluZ1tdO1xuICB9O1xuICAvKiogRmlsZSBjb3VudHMgZm9yIGVhY2ggcGF0dGVybiB0eXBlIChmb3IgZm9ybWF0dGVkIG91dHB1dCkgKi9cbiAgZmlsZUNvdW50czoge1xuICAgIGFzeW5jQXdhaXQ6IG51bWJlcjtcbiAgICBwcm9taXNlczogbnVtYmVyO1xuICAgIGNhbGxiYWNrczogbnVtYmVyO1xuICAgIHRyeUNhdGNoOiBudW1iZXI7XG4gICAgZXJyb3JDYWxsYmFja3M6IG51bWJlcjtcbiAgICByZXN1bHRUeXBlczogbnVtYmVyO1xuICB9O1xufVxuXG4vKiogTGFuZ3VhZ2Utc3BlY2lmaWMgcGF0dGVybiBkZXRlY3Rpb24gY29uZmlndXJhdGlvbi4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgTGFuZ3VhZ2VQYXR0ZXJuRW50cnkge1xuICAvKiogRGlzcGxheSBuYW1lIGZvciB0aGUgbGFuZ3VhZ2UgKGUuZy4sIFwiSmF2YVNjcmlwdC9UeXBlU2NyaXB0XCIpICovXG4gIGRpc3BsYXlOYW1lOiBzdHJpbmc7XG4gIC8qKiBGaWxlIGV4dGVuc2lvbnMgdG8gc2FtcGxlIGZvciB0aGlzIGxhbmd1YWdlICovXG4gIGV4dGVuc2lvbnM6IHN0cmluZ1tdO1xuICAvKiogQXN5bmMgc3R5bGUgZGV0ZWN0aW9uIHBhdHRlcm5zICovXG4gIGFzeW5jU3R5bGU6IHtcbiAgICBtb2Rlcm46IFJlZ0V4cDtcbiAgICBtb2Rlcm5MYWJlbDogc3RyaW5nO1xuICAgIGxlZ2FjeTogUmVnRXhwO1xuICAgIGxlZ2FjeUxhYmVsOiBzdHJpbmc7XG4gIH07XG4gIC8qKiBFcnJvciBoYW5kbGluZyBkZXRlY3Rpb24gcGF0dGVybnMgKi9cbiAgZXJyb3JIYW5kbGluZzoge1xuICAgIHN0cnVjdHVyZWQ6IFJlZ0V4cDtcbiAgICBzdHJ1Y3R1cmVkTGFiZWw6IHN0cmluZztcbiAgICBpbmxpbmU6IFJlZ0V4cDtcbiAgICBpbmxpbmVMYWJlbDogc3RyaW5nO1xuICB9O1xufVxuXG4vKiogTW9kdWxlIHN0cnVjdHVyZSBkZXRlY3RlZCBpbiB0aGUgY29kZWJhc2UuICovXG5leHBvcnQgaW50ZXJmYWNlIE1vZHVsZVN0cnVjdHVyZSB7XG4gIC8qKiBUb3AtbGV2ZWwgZGlyZWN0b3JpZXMgZm91bmQgKGUuZy4sIFtcInNyY1wiLCBcImxpYlwiLCBcInRlc3RcIl0pICovXG4gIHRvcExldmVsRGlyczogc3RyaW5nW107XG4gIC8qKiBTdWJkaXJlY3RvcmllcyB3aXRoaW4gc3JjLyBvciBsaWIvIChlLmcuLCBbXCJjb21wb25lbnRzXCIsIFwidXRpbHNcIiwgXCJob29rc1wiXSkgKi9cbiAgc3JjU3ViZGlyczogc3RyaW5nW107XG4gIC8qKiBUb3RhbCBmaWxlIGNvdW50IHNhbXBsZWQgKi9cbiAgdG90YWxGaWxlc1NhbXBsZWQ6IG51bWJlcjtcbn1cblxuLyoqIEEgc2luZ2xlIGRlY2lzaW9uIGVudHJ5IHBhcnNlZCBmcm9tIERFQ0lTSU9OUy5tZC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgRGVjaXNpb25FbnRyeSB7XG4gIGlkOiBzdHJpbmc7XG4gIHNjb3BlOiBzdHJpbmc7XG4gIGRlY2lzaW9uOiBzdHJpbmc7XG4gIGNob2ljZTogc3RyaW5nO1xuICByYXRpb25hbGU6IHN0cmluZztcbn1cblxuLyoqIEEgc2luZ2xlIHJlcXVpcmVtZW50IGVudHJ5IHBhcnNlZCBmcm9tIFJFUVVJUkVNRU5UUy5tZC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUmVxdWlyZW1lbnRFbnRyeSB7XG4gIGlkOiBzdHJpbmc7XG4gIGRlc2NyaXB0aW9uOiBzdHJpbmc7XG4gIHN0YXR1czogXCJhY3RpdmVcIiB8IFwidmFsaWRhdGVkXCIgfCBcImRlZmVycmVkXCIgfCBcIm91dC1vZi1zY29wZVwiO1xufVxuXG4vKiogUHJpb3IgY29udGV4dCBicmllZiBhZ2dyZWdhdGVkIGZyb20gR1NEIGFydGlmYWN0cy4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUHJpb3JDb250ZXh0QnJpZWYge1xuICAvKiogRGVjaXNpb25zIGdyb3VwZWQgYnkgc2NvcGUuICovXG4gIGRlY2lzaW9uczoge1xuICAgIGJ5U2NvcGU6IE1hcDxzdHJpbmcsIERlY2lzaW9uRW50cnlbXT47XG4gICAgdG90YWxDb3VudDogbnVtYmVyO1xuICB9O1xuICAvKiogUmVxdWlyZW1lbnRzIGdyb3VwZWQgYnkgc3RhdHVzLiAqL1xuICByZXF1aXJlbWVudHM6IHtcbiAgICBhY3RpdmU6IFJlcXVpcmVtZW50RW50cnlbXTtcbiAgICB2YWxpZGF0ZWQ6IFJlcXVpcmVtZW50RW50cnlbXTtcbiAgICBkZWZlcnJlZDogUmVxdWlyZW1lbnRFbnRyeVtdO1xuICAgIHRvdGFsQ291bnQ6IG51bWJlcjtcbiAgfTtcbiAgLyoqIEtub3dsZWRnZSBlbnRyaWVzIChyYXcgY29udGVudCwgdHJ1bmNhdGVkKS4gKi9cbiAga25vd2xlZGdlOiBzdHJpbmc7XG4gIC8qKiBQcmlvciBtaWxlc3RvbmUgc3VtbWFyaWVzIChjb21iaW5lZCwgdHJ1bmNhdGVkKS4gKi9cbiAgc3VtbWFyaWVzOiBzdHJpbmc7XG59XG5cbi8qKiBDb2RlYmFzZSBhbmFseXNpcyBicmllZi4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQ29kZWJhc2VCcmllZiB7XG4gIC8qKiBUZWNoIHN0YWNrIGFuZCBsYW5ndWFnZSBmcm9tIGRldGVjdFByb2plY3RTaWduYWxzICovXG4gIHRlY2hTdGFjazoge1xuICAgIHByaW1hcnlMYW5ndWFnZT86IHN0cmluZztcbiAgICBkZXRlY3RlZEZpbGVzOiBzdHJpbmdbXTtcbiAgICBwYWNrYWdlTWFuYWdlcj86IHN0cmluZztcbiAgICBpc01vbm9yZXBvOiBib29sZWFuO1xuICAgIGhhc1Rlc3RzOiBib29sZWFuO1xuICAgIGhhc0NJOiBib29sZWFuO1xuICB9O1xuICAvKiogTW9kdWxlIHN0cnVjdHVyZSAqL1xuICBtb2R1bGVTdHJ1Y3R1cmU6IE1vZHVsZVN0cnVjdHVyZTtcbiAgLyoqIERldGVjdGVkIGNvZGUgcGF0dGVybnMgKi9cbiAgcGF0dGVybnM6IENvZGVQYXR0ZXJucztcbiAgLyoqIFNvdXJjZSBmaWxlcyB0aGF0IHdlcmUgc2FtcGxlZCBmb3IgcGF0dGVybiBleHRyYWN0aW9uICovXG4gIHNhbXBsZWRGaWxlczogc3RyaW5nW107XG59XG5cbi8qKiBBIHNpbmdsZSBlY29zeXN0ZW0gcmVzZWFyY2ggZmluZGluZy4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgRWNvc3lzdGVtRmluZGluZyB7XG4gIC8qKiBRdWVyeSB0aGF0IHByb2R1Y2VkIHRoaXMgZmluZGluZyAqL1xuICBxdWVyeTogc3RyaW5nO1xuICAvKiogVGl0bGUgb3Igc25pcHBldCBmcm9tIHNlYXJjaCByZXN1bHQgKi9cbiAgdGl0bGU6IHN0cmluZztcbiAgLyoqIFVSTCBzb3VyY2UgKi9cbiAgdXJsPzogc3RyaW5nO1xuICAvKiogQnJpZWYgY29udGVudCBzbmlwcGV0ICovXG4gIHNuaXBwZXQ6IHN0cmluZztcbn1cblxuLyoqIEVjb3N5c3RlbSByZXNlYXJjaCBicmllZiBmcm9tIHdlYiBzZWFyY2guICovXG5leHBvcnQgaW50ZXJmYWNlIEVjb3N5c3RlbUJyaWVmIHtcbiAgLyoqIFdoZXRoZXIgZWNvc3lzdGVtIHJlc2VhcmNoIHdhcyBwZXJmb3JtZWQgKi9cbiAgYXZhaWxhYmxlOiBib29sZWFuO1xuICAvKiogU2VhcmNoIHF1ZXJpZXMgdGhhdCB3ZXJlIGV4ZWN1dGVkICovXG4gIHF1ZXJpZXM6IHN0cmluZ1tdO1xuICAvKiogQWdncmVnYXRlZCBmaW5kaW5ncyBmcm9tIHNlYXJjaCByZXN1bHRzICovXG4gIGZpbmRpbmdzOiBFY29zeXN0ZW1GaW5kaW5nW107XG4gIC8qKiBSZWFzb24gd2h5IHJlc2VhcmNoIHdhcyBza2lwcGVkIChpZiBhdmFpbGFibGUgPT09IGZhbHNlKSAqL1xuICBza2lwcGVkUmVhc29uPzogc3RyaW5nO1xuICAvKiogV2hpY2ggc2VhcmNoIHByb3ZpZGVyIHdhcyB1c2VkICovXG4gIHByb3ZpZGVyPzogc3RyaW5nO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQ29uc3RhbnRzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKiogTWF4aW11bSBjaGFyYWN0ZXJzIGZvciB0aGUgY29kZWJhc2Ugc2VjdGlvbi4gKi9cbmNvbnN0IE1BWF9DT0RFQkFTRV9CUklFRl9DSEFSUyA9IDMwMDA7XG5cbi8qKiBOdW1iZXIgb2YgZmlsZXMgdG8gc2FtcGxlIGZvciBwYXR0ZXJuIGV4dHJhY3Rpb24uICovXG5jb25zdCBTQU1QTEVfRklMRV9DT1VOVCA9IDU7XG5cbi8qKiBNYXhpbXVtIGJ5dGVzIHRvIHJlYWQgZnJvbSBlYWNoIHNhbXBsZWQgZmlsZS4gKi9cbmNvbnN0IE1BWF9GSUxFX1NBTVBMRV9CWVRFUyA9IDgxOTI7XG5cbi8qKiBEaXJlY3RvcmllcyB0byBza2lwIHdoZW4gc2FtcGxpbmcuICovXG5jb25zdCBTS0lQX0RJUlMgPSBuZXcgU2V0KFtcbiAgXCJub2RlX21vZHVsZXNcIixcbiAgXCJkaXN0XCIsXG4gIFwiYnVpbGRcIixcbiAgXCIuZ2l0XCIsXG4gIFwiY292ZXJhZ2VcIixcbiAgXCIubmV4dFwiLFxuICBcIi5udXh0XCIsXG4gIFwidGFyZ2V0XCIsXG4gIFwiLnR1cmJvXCIsXG4gIFwidmVuZG9yXCIsXG4gIFwiX19weWNhY2hlX19cIixcbiAgXCIudmVudlwiLFxuICBcInZlbnZcIixcbl0pO1xuXG4vKiogRmlsZSBwYXR0ZXJucyB0byBleGNsdWRlIHdoZW4gc2FtcGxpbmcuICovXG5jb25zdCBFWENMVURFX1BBVFRFUk5TID0gW1xuICAvXFwudGVzdFxcLih0c3x0c3h8anN8anN4fG1qc3xjanMpJC8sXG4gIC9cXC5zcGVjXFwuKHRzfHRzeHxqc3xqc3h8bWpzfGNqcykkLyxcbiAgL1xcLmRcXC50cyQvLFxuICAvdGVzdC0uKlxcLih0c3x0c3h8anN8anN4KSQvLFxuICAvLipcXC5taW5cXC4oanN8Y3NzKSQvLFxuXTtcblxuLyoqIEZpbGUgZXh0ZW5zaW9ucyB0byBzYW1wbGUgZm9yIHBhdHRlcm4gZXh0cmFjdGlvbiAoSlMvVFMgZGVmYXVsdCkuICovXG5jb25zdCBTQU1QTEVfRVhURU5TSU9OUyA9IFtcIi50c1wiLCBcIi50c3hcIiwgXCIuanNcIiwgXCIuanN4XCIsIFwiLm1qc1wiLCBcIi5janNcIl07XG5cbi8qKiBDb21tb24gc291cmNlIGZpbGUgZXh0ZW5zaW9ucyBmb3IgdW5pdmVyc2FsIHBhdHRlcm4gZGV0ZWN0aW9uIChuYW1pbmcgY29udmVudGlvbikuXG4gKiAgVXNlZCB3aGVuIHRoZSBsYW5ndWFnZSBpcyBub3QgaW4gTEFOR1VBR0VfUEFUVEVSTlMgYnV0IHdlIHN0aWxsIHdhbnQgdG8gZGV0ZWN0IGNhbWVsQ2FzZS9zbmFrZV9jYXNlLiAqL1xuY29uc3QgVU5JVkVSU0FMX1NPVVJDRV9FWFRFTlNJT05TID0gW1xuICAvLyBKYXZhU2NyaXB0L1R5cGVTY3JpcHRcbiAgXCIudHNcIiwgXCIudHN4XCIsIFwiLmpzXCIsIFwiLmpzeFwiLCBcIi5tanNcIiwgXCIuY2pzXCIsXG4gIC8vIFB5dGhvblxuICBcIi5weVwiLCBcIi5weXdcIiwgXCIucHlpXCIsXG4gIC8vIFJ1YnlcbiAgXCIucmJcIiwgXCIucmFrZVwiLCBcIi5nZW1zcGVjXCIsXG4gIC8vIEdvXG4gIFwiLmdvXCIsXG4gIC8vIFJ1c3RcbiAgXCIucnNcIixcbiAgLy8gSmF2YS9Lb3RsaW5cbiAgXCIuamF2YVwiLCBcIi5rdFwiLCBcIi5rdHNcIixcbiAgLy8gQy9DKytcbiAgXCIuY1wiLCBcIi5jcHBcIiwgXCIuY2NcIiwgXCIuY3h4XCIsIFwiLmhcIiwgXCIuaHBwXCIsXG4gIC8vIEMjXG4gIFwiLmNzXCIsXG4gIC8vIFN3aWZ0XG4gIFwiLnN3aWZ0XCIsXG4gIC8vIFBIUFxuICBcIi5waHBcIixcbiAgLy8gU2NhbGFcbiAgXCIuc2NhbGFcIixcbiAgLy8gRWxpeGlyL0VybGFuZ1xuICBcIi5leFwiLCBcIi5leHNcIiwgXCIuZXJsXCIsXG4gIC8vIEhhc2tlbGxcbiAgXCIuaHNcIiwgXCIubGhzXCIsXG4gIC8vIFNoZWxsXG4gIFwiLnNoXCIsIFwiLmJhc2hcIiwgXCIuenNoXCIsXG4gIC8vIEx1YVxuICBcIi5sdWFcIixcbiAgLy8gRGFydFxuICBcIi5kYXJ0XCIsXG5dO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUGF0dGVybiBEZXRlY3Rpb24gUmVnZXhlcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqIEFzeW5jL2F3YWl0IHVzYWdlIHBhdHRlcm5zLiAqL1xuY29uc3QgQVNZTkNfQVdBSVRfUkUgPSAvXFxiYXN5bmNcXHMrZnVuY3Rpb25cXGJ8XFxiYXN5bmNcXHMqXFwofFxcYmF3YWl0XFxzKy9nO1xuXG4vKiogQ2FsbGJhY2stc3R5bGUgcGF0dGVybnMgKGNvbW1vbiBwYXR0ZXJucyBsaWtlIGRvbmUsIGNhbGxiYWNrLCBjYikuICovXG5jb25zdCBDQUxMQkFDS19SRSA9IC9cXGIoY2FsbGJhY2t8Y2J8ZG9uZSlcXHMqXFwofFxcYmZ1bmN0aW9uXFxzKlxcKFteKV0qXFxiZnVuY3Rpb25cXGIvZztcblxuLyoqIFByb21pc2UgcGF0dGVybnMgKC50aGVuLCAuY2F0Y2gsIG5ldyBQcm9taXNlKS4gKi9cbmNvbnN0IFBST01JU0VfUkUgPSAvXFwudGhlblxccypcXCh8XFwuY2F0Y2hcXHMqXFwofFxcYm5ld1xccytQcm9taXNlXFxzKlxcKC9nO1xuXG4vKiogVHJ5L2NhdGNoIHBhdHRlcm5zLiAqL1xuY29uc3QgVFJZX0NBVENIX1JFID0gL1xcYnRyeVxccypcXHtbXFxzXFxTXSo/XFxiY2F0Y2hcXHMqXFwoL2c7XG5cbi8qKiBFcnJvci1maXJzdCBjYWxsYmFjayBwYXR0ZXJucy4gKi9cbmNvbnN0IEVSUk9SX0NBTExCQUNLX1JFID0gL1xcYmlmXFxzKlxcKFxccyooZXJyfGVycm9yKVxccypcXCl8XFwoZXJyKG9yKT9cXHMqLC9nO1xuXG4vKiogUmVzdWx0IHR5cGUgcGF0dGVybnMgKFJ1c3Qtc3R5bGUsIGZwLXRzLCBldGMuKS4gKi9cbmNvbnN0IFJFU1VMVF9UWVBFX1JFID0gL1xcYlJlc3VsdDx8XFxiRWl0aGVyPHxcXGJpc09rXFwofFxcYmlzRXJyXFwofFxcYihPa3xFcnIpXFwoL2c7XG5cbi8qKiBjYW1lbENhc2UgaWRlbnRpZmllciBwYXR0ZXJucy4gKi9cbmNvbnN0IENBTUVMX0NBU0VfUkUgPSAvXFxiW2Etel1bYS16QS1aMC05XSpbQS1aXVthLXpBLVowLTldKlxcYi9nO1xuXG4vKiogc25ha2VfY2FzZSBpZGVudGlmaWVyIHBhdHRlcm5zLiAqL1xuY29uc3QgU05BS0VfQ0FTRV9SRSA9IC9cXGJbYS16XVthLXowLTldKl9bYS16MC05X10rXFxiL2c7XG5cbi8qKiBQYXNjYWxDYXNlIGlkZW50aWZpZXIgcGF0dGVybnMgKGZvciB0eXBlcy9jbGFzc2VzKS4gKi9cbmNvbnN0IFBBU0NBTF9DQVNFX1JFID0gL1xcYmNsYXNzXFxzK1tBLVpdW2EtekEtWjAtOV0qfFxcYmludGVyZmFjZVxccytbQS1aXVthLXpBLVowLTldKnxcXGJ0eXBlXFxzK1tBLVpdW2EtekEtWjAtOV0qL2c7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBMYW5ndWFnZSBQYXR0ZXJuIFJlZ2lzdHJ5IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFJlZ2lzdHJ5IG9mIGxhbmd1YWdlLXNwZWNpZmljIHBhdHRlcm5zIGZvciBjb2RlIGFuYWx5c2lzLlxuICogS2V5cyBNVVNUIG1hdGNoIGRldGVjdGlvbi50cyBMQU5HVUFHRV9NQVAgdmFsdWVzIGV4YWN0bHkuXG4gKi9cbmV4cG9ydCBjb25zdCBMQU5HVUFHRV9QQVRURVJOUzogUmVjb3JkPHN0cmluZywgTGFuZ3VhZ2VQYXR0ZXJuRW50cnk+ID0ge1xuICBcImphdmFzY3JpcHQvdHlwZXNjcmlwdFwiOiB7XG4gICAgZGlzcGxheU5hbWU6IFwiSmF2YVNjcmlwdC9UeXBlU2NyaXB0XCIsXG4gICAgZXh0ZW5zaW9uczogW1wiLnRzXCIsIFwiLnRzeFwiLCBcIi5qc1wiLCBcIi5qc3hcIiwgXCIubWpzXCIsIFwiLmNqc1wiXSxcbiAgICBhc3luY1N0eWxlOiB7XG4gICAgICBtb2Rlcm46IC9cXGJhc3luY1xccytmdW5jdGlvblxcYnxcXGJhc3luY1xccypcXCh8XFxiYXdhaXRcXHMrL2csXG4gICAgICBtb2Rlcm5MYWJlbDogXCJhc3luYy9hd2FpdFwiLFxuICAgICAgbGVnYWN5OiAvXFwudGhlblxccypcXCh8XFwuY2F0Y2hcXHMqXFwofFxcYm5ld1xccytQcm9taXNlXFxzKlxcKC9nLFxuICAgICAgbGVnYWN5TGFiZWw6IFwicHJvbWlzZXNcIixcbiAgICB9LFxuICAgIGVycm9ySGFuZGxpbmc6IHtcbiAgICAgIHN0cnVjdHVyZWQ6IC9cXGJ0cnlcXHMqXFx7W1xcc1xcU10qP1xcYmNhdGNoXFxzKlxcKC9nLFxuICAgICAgc3RydWN0dXJlZExhYmVsOiBcInRyeS9jYXRjaFwiLFxuICAgICAgaW5saW5lOiAvXFxiaWZcXHMqXFwoXFxzKihlcnJ8ZXJyb3IpXFxzKlxcKXxcXChlcnIob3IpP1xccyosL2csXG4gICAgICBpbmxpbmVMYWJlbDogXCJlcnJvci1jYWxsYmFja3NcIixcbiAgICB9LFxuICB9LFxuICBweXRob246IHtcbiAgICBkaXNwbGF5TmFtZTogXCJQeXRob25cIixcbiAgICBleHRlbnNpb25zOiBbXCIucHlcIiwgXCIucHl3XCIsIFwiLnB5aVwiXSxcbiAgICBhc3luY1N0eWxlOiB7XG4gICAgICBtb2Rlcm46IC9cXGJhc3luY1xccytkZWZcXGJ8XFxiYXdhaXRcXHMrL2csXG4gICAgICBtb2Rlcm5MYWJlbDogXCJhc3luYy9hd2FpdFwiLFxuICAgICAgbGVnYWN5OiAvXFwuYWRkX2RvbmVfY2FsbGJhY2tcXCh8VGhyZWFkUG9vbEV4ZWN1dG9yfFByb2Nlc3NQb29sRXhlY3V0b3IvZyxcbiAgICAgIGxlZ2FjeUxhYmVsOiBcImZ1dHVyZXMvZXhlY3V0b3JzXCIsXG4gICAgfSxcbiAgICBlcnJvckhhbmRsaW5nOiB7XG4gICAgICBzdHJ1Y3R1cmVkOiAvXFxidHJ5XFxzKjpbXFxzXFxTXSo/XFxiZXhjZXB0XFxiL2csXG4gICAgICBzdHJ1Y3R1cmVkTGFiZWw6IFwidHJ5L2V4Y2VwdFwiLFxuICAgICAgaW5saW5lOiAvXFxicmFpc2VcXHMrXFx3K0Vycm9yfFxcYmFzc2VydFxccysvZyxcbiAgICAgIGlubGluZUxhYmVsOiBcInJhaXNlL2Fzc2VydFwiLFxuICAgIH0sXG4gIH0sXG4gIHJ1c3Q6IHtcbiAgICBkaXNwbGF5TmFtZTogXCJSdXN0XCIsXG4gICAgZXh0ZW5zaW9uczogW1wiLnJzXCJdLFxuICAgIGFzeW5jU3R5bGU6IHtcbiAgICAgIG1vZGVybjogL1xcYmFzeW5jXFxzK2ZuXFxifFxcLmF3YWl0XFxiL2csXG4gICAgICBtb2Rlcm5MYWJlbDogXCJhc3luYy9hd2FpdFwiLFxuICAgICAgbGVnYWN5OiAvXFxidGhyZWFkOjpzcGF3blxcKHxcXGJtcHNjOjovZyxcbiAgICAgIGxlZ2FjeUxhYmVsOiBcInRocmVhZHMvY2hhbm5lbHNcIixcbiAgICB9LFxuICAgIGVycm9ySGFuZGxpbmc6IHtcbiAgICAgIHN0cnVjdHVyZWQ6IC9cXGJSZXN1bHQ8fFxcYk9wdGlvbjx8XFw/XFxzKjsvZyxcbiAgICAgIHN0cnVjdHVyZWRMYWJlbDogXCJSZXN1bHQvT3B0aW9uXCIsXG4gICAgICBpbmxpbmU6IC9cXGJ1bndyYXBcXChcXCl8XFxiZXhwZWN0XFwoL2csXG4gICAgICBpbmxpbmVMYWJlbDogXCJ1bndyYXAvZXhwZWN0XCIsXG4gICAgfSxcbiAgfSxcbiAgZ286IHtcbiAgICBkaXNwbGF5TmFtZTogXCJHb1wiLFxuICAgIGV4dGVuc2lvbnM6IFtcIi5nb1wiXSxcbiAgICBhc3luY1N0eWxlOiB7XG4gICAgICBtb2Rlcm46IC9cXGJnb1xccytmdW5jXFxifFxcYmdvXFxzK1xcdytcXCgvZyxcbiAgICAgIG1vZGVybkxhYmVsOiBcImdvcm91dGluZXNcIixcbiAgICAgIGxlZ2FjeTogL1xcYmNoYW5cXHMrXFx3K3w8LVxccypcXHcrfFxcdytcXHMqPC0vZyxcbiAgICAgIGxlZ2FjeUxhYmVsOiBcImNoYW5uZWxzXCIsXG4gICAgfSxcbiAgICBlcnJvckhhbmRsaW5nOiB7XG4gICAgICBzdHJ1Y3R1cmVkOiAvXFxiaWZcXHMrZXJyXFxzKiE9XFxzKm5pbFxcYi9nLFxuICAgICAgc3RydWN0dXJlZExhYmVsOiBcImlmIGVyciAhPSBuaWxcIixcbiAgICAgIGlubGluZTogL1xcYnBhbmljXFwofFxcYnJlY292ZXJcXChcXCkvZyxcbiAgICAgIGlubGluZUxhYmVsOiBcInBhbmljL3JlY292ZXJcIixcbiAgICB9LFxuICB9LFxuICBqYXZhOiB7XG4gICAgZGlzcGxheU5hbWU6IFwiSmF2YVwiLFxuICAgIGV4dGVuc2lvbnM6IFtcIi5qYXZhXCJdLFxuICAgIGFzeW5jU3R5bGU6IHtcbiAgICAgIG1vZGVybjogL1xcYkNvbXBsZXRhYmxlRnV0dXJlPHxcXGJDb21wbGV0aW9uU3RhZ2U8fFxcYnRoZW5BcHBseVxcKC9nLFxuICAgICAgbW9kZXJuTGFiZWw6IFwiQ29tcGxldGFibGVGdXR1cmVcIixcbiAgICAgIGxlZ2FjeTogL1xcYlRocmVhZFxccytcXHcrXFxzKj18XFxibmV3XFxzK1RocmVhZFxcKHxcXGJFeGVjdXRvclNlcnZpY2VcXGIvZyxcbiAgICAgIGxlZ2FjeUxhYmVsOiBcInRocmVhZHMvZXhlY3V0b3JzXCIsXG4gICAgfSxcbiAgICBlcnJvckhhbmRsaW5nOiB7XG4gICAgICBzdHJ1Y3R1cmVkOiAvXFxidHJ5XFxzKlxce1tcXHNcXFNdKj9cXGJjYXRjaFxccypcXCgvZyxcbiAgICAgIHN0cnVjdHVyZWRMYWJlbDogXCJ0cnkvY2F0Y2hcIixcbiAgICAgIGlubGluZTogL1xcYnRocm93c1xccytcXHcrRXhjZXB0aW9ufFxcYnRocm93XFxzK25ld1xccytcXHcrRXhjZXB0aW9uL2csXG4gICAgICBpbmxpbmVMYWJlbDogXCJ0aHJvd3MvdGhyb3dcIixcbiAgICB9LFxuICB9LFxuICBcImphdmEva290bGluXCI6IHtcbiAgICBkaXNwbGF5TmFtZTogXCJKYXZhL0tvdGxpblwiLFxuICAgIGV4dGVuc2lvbnM6IFtcIi5qYXZhXCIsIFwiLmt0XCIsIFwiLmt0c1wiXSxcbiAgICBhc3luY1N0eWxlOiB7XG4gICAgICBtb2Rlcm46IC9cXGJzdXNwZW5kXFxzK2Z1blxcYnxcXGJsYXVuY2hcXHMqXFx7fFxcYmFzeW5jXFxzKlxce3xcXGJ3aXRoQ29udGV4dFxcKC9nLFxuICAgICAgbW9kZXJuTGFiZWw6IFwiY29yb3V0aW5lc1wiLFxuICAgICAgbGVnYWN5OiAvXFxiVGhyZWFkXFxzK1xcdytcXHMqPXxcXGJuZXdcXHMrVGhyZWFkXFwofFxcYkV4ZWN1dG9yU2VydmljZVxcYnxcXGJDb21wbGV0YWJsZUZ1dHVyZTwvZyxcbiAgICAgIGxlZ2FjeUxhYmVsOiBcInRocmVhZHMvZnV0dXJlc1wiLFxuICAgIH0sXG4gICAgZXJyb3JIYW5kbGluZzoge1xuICAgICAgc3RydWN0dXJlZDogL1xcYnRyeVxccypcXHtbXFxzXFxTXSo/XFxiY2F0Y2hcXHMqXFwoL2csXG4gICAgICBzdHJ1Y3R1cmVkTGFiZWw6IFwidHJ5L2NhdGNoXCIsXG4gICAgICBpbmxpbmU6IC9cXGJ0aHJvd3NcXHMrXFx3K0V4Y2VwdGlvbnxcXGJ0aHJvd1xccytcXHcrRXhjZXB0aW9ufFxcYnJ1bkNhdGNoaW5nXFxzKlxcey9nLFxuICAgICAgaW5saW5lTGFiZWw6IFwidGhyb3dzL3J1bkNhdGNoaW5nXCIsXG4gICAgfSxcbiAgfSxcbn07XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBDb3JlIEZ1bmN0aW9ucyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBBbmFseXplIHRoZSBjb2RlYmFzZSBhbmQgcHJvZHVjZSBhIHN0cnVjdHVyZWQgYnJpZWYuXG4gKlxuICogQHBhcmFtIGJhc2VQYXRoIC0gUm9vdCBkaXJlY3Rvcnkgb2YgdGhlIHByb2plY3RcbiAqIEByZXR1cm5zIENvZGViYXNlQnJpZWYgd2l0aCB0ZWNoIHN0YWNrLCBtb2R1bGUgc3RydWN0dXJlLCBhbmQgcGF0dGVybnNcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGFuYWx5emVDb2RlYmFzZShiYXNlUGF0aDogc3RyaW5nKTogUHJvbWlzZTxDb2RlYmFzZUJyaWVmPiB7XG4gIC8vIEdldCBwcm9qZWN0IHNpZ25hbHMgZnJvbSBkZXRlY3Rpb24udHNcbiAgY29uc3Qgc2lnbmFscyA9IGRldGVjdFByb2plY3RTaWduYWxzKGJhc2VQYXRoKTtcblxuICAvLyBEZXRlY3QgbW9kdWxlIHN0cnVjdHVyZVxuICBjb25zdCBtb2R1bGVTdHJ1Y3R1cmUgPSBkZXRlY3RNb2R1bGVTdHJ1Y3R1cmUoYmFzZVBhdGgpO1xuXG4gIC8vIFNhbXBsZSBmaWxlcyBhbmQgZXh0cmFjdCBwYXR0ZXJucywgcGFzc2luZyBwcmltYXJ5IGxhbmd1YWdlIGZvciBsYW5ndWFnZS1hd2FyZSBkZXRlY3Rpb25cbiAgY29uc3Qgc2FtcGxlZEZpbGVzID0gc2FtcGxlU291cmNlRmlsZXMoYmFzZVBhdGgsIHNpZ25hbHMucHJpbWFyeUxhbmd1YWdlKTtcbiAgY29uc3QgcGF0dGVybnMgPSBleHRyYWN0UGF0dGVybnMoYmFzZVBhdGgsIHNhbXBsZWRGaWxlcywgc2lnbmFscy5wcmltYXJ5TGFuZ3VhZ2UpO1xuXG4gIHJldHVybiB7XG4gICAgdGVjaFN0YWNrOiB7XG4gICAgICBwcmltYXJ5TGFuZ3VhZ2U6IHNpZ25hbHMucHJpbWFyeUxhbmd1YWdlLFxuICAgICAgZGV0ZWN0ZWRGaWxlczogc2lnbmFscy5kZXRlY3RlZEZpbGVzLFxuICAgICAgcGFja2FnZU1hbmFnZXI6IHNpZ25hbHMucGFja2FnZU1hbmFnZXIsXG4gICAgICBpc01vbm9yZXBvOiBzaWduYWxzLmlzTW9ub3JlcG8sXG4gICAgICBoYXNUZXN0czogc2lnbmFscy5oYXNUZXN0cyxcbiAgICAgIGhhc0NJOiBzaWduYWxzLmhhc0NJLFxuICAgIH0sXG4gICAgbW9kdWxlU3RydWN0dXJlLFxuICAgIHBhdHRlcm5zLFxuICAgIHNhbXBsZWRGaWxlcyxcbiAgfTtcbn1cblxuLyoqXG4gKiBEZXRlY3QgdGhlIG1vZHVsZSBzdHJ1Y3R1cmUgb2YgdGhlIGNvZGViYXNlLlxuICpcbiAqIEBwYXJhbSBiYXNlUGF0aCAtIFJvb3QgZGlyZWN0b3J5IG9mIHRoZSBwcm9qZWN0XG4gKiBAcmV0dXJucyBNb2R1bGVTdHJ1Y3R1cmUgd2l0aCB0b3AtbGV2ZWwgYW5kIHNyYyBzdWJkaXJzXG4gKi9cbmZ1bmN0aW9uIGRldGVjdE1vZHVsZVN0cnVjdHVyZShiYXNlUGF0aDogc3RyaW5nKTogTW9kdWxlU3RydWN0dXJlIHtcbiAgY29uc3QgdG9wTGV2ZWxEaXJzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBzcmNTdWJkaXJzOiBzdHJpbmdbXSA9IFtdO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgZW50cmllcyA9IHJlYWRkaXJTeW5jKGJhc2VQYXRoLCB7IHdpdGhGaWxlVHlwZXM6IHRydWUgfSk7XG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSB7XG4gICAgICBpZiAoZW50cnkuaXNEaXJlY3RvcnkoKSAmJiAhZW50cnkubmFtZS5zdGFydHNXaXRoKFwiLlwiKSAmJiAhU0tJUF9ESVJTLmhhcyhlbnRyeS5uYW1lKSkge1xuICAgICAgICB0b3BMZXZlbERpcnMucHVzaChlbnRyeS5uYW1lKTtcbiAgICAgIH1cbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIERpcmVjdG9yeSBub3QgcmVhZGFibGVcbiAgfVxuXG4gIC8vIFNjYW4gZm9yIHN1YmRpcnMgaW4gc3JjLyBvciBsaWIvXG4gIGZvciAoY29uc3Qgc3JjRGlyIG9mIFtcInNyY1wiLCBcImxpYlwiLCBcImFwcFwiXSkge1xuICAgIGNvbnN0IHNyY1BhdGggPSBqb2luKGJhc2VQYXRoLCBzcmNEaXIpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBlbnRyaWVzID0gcmVhZGRpclN5bmMoc3JjUGF0aCwgeyB3aXRoRmlsZVR5cGVzOiB0cnVlIH0pO1xuICAgICAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSB7XG4gICAgICAgIGlmIChlbnRyeS5pc0RpcmVjdG9yeSgpICYmICFlbnRyeS5uYW1lLnN0YXJ0c1dpdGgoXCIuXCIpICYmICFTS0lQX0RJUlMuaGFzKGVudHJ5Lm5hbWUpKSB7XG4gICAgICAgICAgc3JjU3ViZGlycy5wdXNoKGVudHJ5Lm5hbWUpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBEaXJlY3RvcnkgZG9lc24ndCBleGlzdCBvciBub3QgcmVhZGFibGVcbiAgICB9XG4gIH1cblxuICByZXR1cm4ge1xuICAgIHRvcExldmVsRGlycyxcbiAgICBzcmNTdWJkaXJzOiBbLi4ubmV3IFNldChzcmNTdWJkaXJzKV0sIC8vIERlZHVwZVxuICAgIHRvdGFsRmlsZXNTYW1wbGVkOiAwLCAvLyBXaWxsIGJlIHNldCBhZnRlciBzYW1wbGluZ1xuICB9O1xufVxuXG4vKipcbiAqIFNhbXBsZSBzb3VyY2UgZmlsZXMgZnJvbSB0aGUgY29kZWJhc2UgZm9yIHBhdHRlcm4gZXh0cmFjdGlvbi5cbiAqXG4gKiBQcmVmZXJzIGZpbGVzIGluIHNyYy8gZGlyZWN0b3J5LCBleGNsdWRlcyB0ZXN0IGZpbGVzIGFuZCBub2RlX21vZHVsZXMuXG4gKiBFeHRlbnNpb24gc2VsZWN0aW9uOlxuICogLSBJZiBsYW5ndWFnZSBpcyBpbiBMQU5HVUFHRV9QQVRURVJOUzogdXNlIGxhbmd1YWdlLXNwZWNpZmljIGV4dGVuc2lvbnNcbiAqIC0gSWYgbGFuZ3VhZ2UgaXMgdW5kZWZpbmVkIChubyBtYW5pZmVzdCk6IHVzZSBKUy9UUyBkZWZhdWx0cyAoY29tbW9uIGNhc2UpXG4gKiAtIElmIGxhbmd1YWdlIGlzIHNldCBidXQgbm90IGluIExBTkdVQUdFX1BBVFRFUk5TOiB1c2UgVU5JVkVSU0FMX1NPVVJDRV9FWFRFTlNJT05TXG4gKiAgIHNvIHdlIGNhbiBzdGlsbCBkZXRlY3QgbmFtaW5nIGNvbnZlbnRpb25zIGV2ZW4gZm9yIHVucmVjb2duaXplZCBsYW5ndWFnZXNcbiAqXG4gKiBAcGFyYW0gYmFzZVBhdGggLSBSb290IGRpcmVjdG9yeSBvZiB0aGUgcHJvamVjdFxuICogQHBhcmFtIHByaW1hcnlMYW5ndWFnZSAtIE9wdGlvbmFsIHByaW1hcnkgbGFuZ3VhZ2UgaWRlbnRpZmllciBmcm9tIGRldGVjdGlvbi50cyBMQU5HVUFHRV9NQVBcbiAqIEByZXR1cm5zIEFycmF5IG9mIHJlbGF0aXZlIGZpbGUgcGF0aHMgdG8gc2FtcGxlZCBmaWxlc1xuICovXG5mdW5jdGlvbiBzYW1wbGVTb3VyY2VGaWxlcyhiYXNlUGF0aDogc3RyaW5nLCBwcmltYXJ5TGFuZ3VhZ2U/OiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIC8vIFVzZSBzY2FuUHJvamVjdEZpbGVzIGZyb20gZGV0ZWN0aW9uLnRzIGZvciBib3VuZGVkIHJlY3Vyc2lvblxuICBjb25zdCBhbGxGaWxlcyA9IHNjYW5Qcm9qZWN0RmlsZXMoYmFzZVBhdGgpO1xuXG4gIC8vIEdldCBleHRlbnNpb25zIHRvIHNhbXBsZSBiYXNlZCBvbiBsYW5ndWFnZSBkZXRlY3Rpb24gc3RhdHVzXG4gIGNvbnN0IGxhbmd1YWdlRW50cnkgPSBwcmltYXJ5TGFuZ3VhZ2UgPyBMQU5HVUFHRV9QQVRURVJOU1twcmltYXJ5TGFuZ3VhZ2VdIDogdW5kZWZpbmVkO1xuICBsZXQgZXh0ZW5zaW9uc1RvU2FtcGxlOiBzdHJpbmdbXTtcbiAgXG4gIGlmIChsYW5ndWFnZUVudHJ5KSB7XG4gICAgLy8gTGFuZ3VhZ2UgaXMgaW4gcmVnaXN0cnkgXHUyMDE0IHVzZSBpdHMgc3BlY2lmaWMgZXh0ZW5zaW9uc1xuICAgIGV4dGVuc2lvbnNUb1NhbXBsZSA9IGxhbmd1YWdlRW50cnkuZXh0ZW5zaW9ucztcbiAgfSBlbHNlIGlmIChwcmltYXJ5TGFuZ3VhZ2UgPT09IHVuZGVmaW5lZCkge1xuICAgIC8vIE5vIGxhbmd1YWdlIGRldGVjdGVkIChubyBtYW5pZmVzdCkgXHUyMDE0IHVzZSBKUy9UUyBkZWZhdWx0c1xuICAgIGV4dGVuc2lvbnNUb1NhbXBsZSA9IFNBTVBMRV9FWFRFTlNJT05TO1xuICB9IGVsc2Uge1xuICAgIC8vIExhbmd1YWdlIGRldGVjdGVkIGJ1dCBub3QgaW4gcmVnaXN0cnkgKGUuZy4sIFJ1YnksIEhhc2tlbGwpXG4gICAgLy8gVXNlIHVuaXZlcnNhbCBleHRlbnNpb25zIHNvIHdlIGNhbiBzdGlsbCBkZXRlY3QgbmFtaW5nIGNvbnZlbnRpb25zXG4gICAgZXh0ZW5zaW9uc1RvU2FtcGxlID0gVU5JVkVSU0FMX1NPVVJDRV9FWFRFTlNJT05TO1xuICB9XG5cbiAgLy8gRmlsdGVyIHRvIHRhcmdldCBsYW5ndWFnZSBmaWxlcywgZXhjbHVkaW5nIHRlc3RzIGFuZCBkaXN0XG4gIGNvbnN0IGNhbmRpZGF0ZXMgPSBhbGxGaWxlcy5maWx0ZXIoKGZpbGUpID0+IHtcbiAgICAvLyBDaGVjayBleHRlbnNpb25cbiAgICBjb25zdCBoYXNWYWxpZEV4dGVuc2lvbiA9IGV4dGVuc2lvbnNUb1NhbXBsZS5zb21lKChleHQpID0+IGZpbGUuZW5kc1dpdGgoZXh0KSk7XG4gICAgaWYgKCFoYXNWYWxpZEV4dGVuc2lvbikgcmV0dXJuIGZhbHNlO1xuXG4gICAgLy8gQ2hlY2sgZXhjbHVzaW9uIHBhdHRlcm5zXG4gICAgZm9yIChjb25zdCBwYXR0ZXJuIG9mIEVYQ0xVREVfUEFUVEVSTlMpIHtcbiAgICAgIGlmIChwYXR0ZXJuLnRlc3QoZmlsZSkpIHJldHVybiBmYWxzZTtcbiAgICB9XG5cbiAgICAvLyBDaGVjayBmb3IgZXhjbHVkZWQgZGlyZWN0b3JpZXMgaW4gcGF0aFxuICAgIGNvbnN0IHBhcnRzID0gZmlsZS5zcGxpdCgvWy9cXFxcXS8pO1xuICAgIGZvciAoY29uc3QgcGFydCBvZiBwYXJ0cykge1xuICAgICAgaWYgKFNLSVBfRElSUy5oYXMocGFydCkpIHJldHVybiBmYWxzZTtcbiAgICB9XG5cbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSk7XG5cbiAgLy8gUHJpb3JpdGl6ZSBmaWxlcyBpbiBzcmMvIGRpcmVjdG9yeVxuICBjb25zdCBzcmNGaWxlcyA9IGNhbmRpZGF0ZXMuZmlsdGVyKChmKSA9PiBmLnN0YXJ0c1dpdGgoXCJzcmMvXCIpIHx8IGYuc3RhcnRzV2l0aChcInNyY1xcXFxcIikpO1xuICBjb25zdCBvdGhlckZpbGVzID0gY2FuZGlkYXRlcy5maWx0ZXIoKGYpID0+ICFmLnN0YXJ0c1dpdGgoXCJzcmMvXCIpICYmICFmLnN0YXJ0c1dpdGgoXCJzcmNcXFxcXCIpKTtcblxuICAvLyBUYWtlIFNBTVBMRV9GSUxFX0NPVU5UIGZpbGVzLCBwcmVmZXJyaW5nIHNyYy9cbiAgY29uc3Qgc2FtcGxlZDogc3RyaW5nW10gPSBbXTtcblxuICAvLyBGaXJzdCwgYWRkIHNyYyBmaWxlc1xuICBmb3IgKGNvbnN0IGZpbGUgb2Ygc3JjRmlsZXMpIHtcbiAgICBpZiAoc2FtcGxlZC5sZW5ndGggPj0gU0FNUExFX0ZJTEVfQ09VTlQpIGJyZWFrO1xuICAgIHNhbXBsZWQucHVzaChmaWxlKTtcbiAgfVxuXG4gIC8vIFRoZW4gYWRkIG90aGVyIGZpbGVzIGlmIG5lZWRlZFxuICBmb3IgKGNvbnN0IGZpbGUgb2Ygb3RoZXJGaWxlcykge1xuICAgIGlmIChzYW1wbGVkLmxlbmd0aCA+PSBTQU1QTEVfRklMRV9DT1VOVCkgYnJlYWs7XG4gICAgc2FtcGxlZC5wdXNoKGZpbGUpO1xuICB9XG5cbiAgcmV0dXJuIHNhbXBsZWQ7XG59XG5cbi8qKlxuICogRXh0cmFjdCBjb2RlIHBhdHRlcm5zIGZyb20gc2FtcGxlZCBmaWxlcy5cbiAqXG4gKiBQYXR0ZXJuIGRldGVjdGlvbiBiZWhhdmlvcjpcbiAqIDEuIFdoZW4gcHJpbWFyeUxhbmd1YWdlIGV4aXN0cyBpbiBMQU5HVUFHRV9QQVRURVJOUyBcdTIxOTIgdXNlcyBsYW5ndWFnZS1zcGVjaWZpYyBwYXR0ZXJuc1xuICogMi4gV2hlbiBwcmltYXJ5TGFuZ3VhZ2UgaXMgdW5kZWZpbmVkIChubyBtYW5pZmVzdCkgXHUyMTkyIGZhbGxzIGJhY2sgdG8gSlMvVFMgcGF0dGVybnNcbiAqICAgIHNpbmNlIHRoZSBzYW1wbGVkIGZpbGVzIGFyZSBmaWx0ZXJlZCBieSBKUy9UUyBleHRlbnNpb25zIGFueXdheVxuICogMy4gV2hlbiBwcmltYXJ5TGFuZ3VhZ2UgaXMgYSBrbm93biB2YWx1ZSBOT1QgaW4gTEFOR1VBR0VfUEFUVEVSTlMgKGUuZy4sIFwiaGFza2VsbFwiLFxuICogICAgXCJlbGl4aXJcIikgXHUyMTkyIHJldHVybnMgXCJ1bmtub3duXCIgZm9yIGxhbmd1YWdlLXNwZWNpZmljIHBhdHRlcm5zIGluc3RlYWQgb2YgcnVubmluZ1xuICogICAgSlMvVFMgcGF0dGVybnMgd2hpY2ggd291bGQgcHJvZHVjZSBtaXNsZWFkaW5nIHJlc3VsdHNcbiAqXG4gKiBVbml2ZXJzYWwgcGF0dGVybnMgKG5hbWluZyBjb252ZW50aW9uKSBhbHdheXMgcnVuIHJlZ2FyZGxlc3Mgb2YgbGFuZ3VhZ2UuXG4gKlxuICogQHBhcmFtIGJhc2VQYXRoIC0gUm9vdCBkaXJlY3Rvcnkgb2YgdGhlIHByb2plY3RcbiAqIEBwYXJhbSBzYW1wbGVkRmlsZXMgLSBBcnJheSBvZiByZWxhdGl2ZSBmaWxlIHBhdGhzXG4gKiBAcGFyYW0gcHJpbWFyeUxhbmd1YWdlIC0gT3B0aW9uYWwgcHJpbWFyeSBsYW5ndWFnZSBpZGVudGlmaWVyIGZyb20gZGV0ZWN0aW9uLnRzIExBTkdVQUdFX01BUFxuICogQHJldHVybnMgQ29kZVBhdHRlcm5zIHdpdGggZGV0ZWN0ZWQgcGF0dGVybnMgYW5kIGV2aWRlbmNlXG4gKi9cbmZ1bmN0aW9uIGV4dHJhY3RQYXR0ZXJucyhiYXNlUGF0aDogc3RyaW5nLCBzYW1wbGVkRmlsZXM6IHN0cmluZ1tdLCBwcmltYXJ5TGFuZ3VhZ2U/OiBzdHJpbmcpOiBDb2RlUGF0dGVybnMge1xuICBjb25zdCBldmlkZW5jZSA9IHtcbiAgICBhc3luY1N0eWxlOiBbXSBhcyBzdHJpbmdbXSxcbiAgICBlcnJvckhhbmRsaW5nOiBbXSBhcyBzdHJpbmdbXSxcbiAgICBuYW1pbmdDb252ZW50aW9uOiBbXSBhcyBzdHJpbmdbXSxcbiAgfTtcblxuICBjb25zdCBjb3VudHMgPSB7XG4gICAgYXN5bmNBd2FpdDogMCxcbiAgICBjYWxsYmFja3M6IDAsXG4gICAgcHJvbWlzZXM6IDAsXG4gICAgdHJ5Q2F0Y2g6IDAsXG4gICAgZXJyb3JDYWxsYmFja3M6IDAsXG4gICAgcmVzdWx0VHlwZXM6IDAsXG4gICAgY2FtZWxDYXNlOiAwLFxuICAgIHNuYWtlQ2FzZTogMCxcbiAgICBwYXNjYWxDYXNlOiAwLFxuICB9O1xuXG4gIC8vIFRyYWNrIGhvdyBtYW55IGZpbGVzIGNvbnRhaW4gZWFjaCBwYXR0ZXJuIHR5cGUgKGZvciBmb3JtYXR0ZWQgb3V0cHV0KVxuICBjb25zdCBmaWxlQ291bnRzID0ge1xuICAgIGFzeW5jQXdhaXQ6IDAsXG4gICAgcHJvbWlzZXM6IDAsXG4gICAgY2FsbGJhY2tzOiAwLFxuICAgIHRyeUNhdGNoOiAwLFxuICAgIGVycm9yQ2FsbGJhY2tzOiAwLFxuICAgIHJlc3VsdFR5cGVzOiAwLFxuICB9O1xuXG4gIC8vIEdldCBsYW5ndWFnZS1zcGVjaWZpYyBwYXR0ZXJucyBpZiBhdmFpbGFibGVcbiAgLy8gV2hlbiBwcmltYXJ5TGFuZ3VhZ2UgaXMgdW5kZWZpbmVkLCBmYWxsIGJhY2sgdG8gSlMvVFMgKHNhbXBsZWQgZmlsZXMgYXJlIEpTL1RTIGV4dGVuc2lvbnMpXG4gIC8vIFdoZW4gcHJpbWFyeUxhbmd1YWdlIGlzIHNldCBidXQgbm90IGluIHJlZ2lzdHJ5LCBza2lwIGxhbmd1YWdlLXNwZWNpZmljIHBhdHRlcm5zIGVudGlyZWx5XG4gIGNvbnN0IGxhbmd1YWdlRW50cnkgPSBwcmltYXJ5TGFuZ3VhZ2UgXG4gICAgPyBMQU5HVUFHRV9QQVRURVJOU1twcmltYXJ5TGFuZ3VhZ2VdIFxuICAgIDogTEFOR1VBR0VfUEFUVEVSTlNbXCJqYXZhc2NyaXB0L3R5cGVzY3JpcHRcIl07IC8vIEZhbGxiYWNrIGZvciB1bmRlZmluZWQgb25seVxuICBcbiAgLy8gTGFuZ3VhZ2UgaXMgXCJ1bnN1cHBvcnRlZFwiIG9ubHkgd2hlbiBpdCdzIGV4cGxpY2l0bHkgc2V0IGJ1dCBub3QgaW4gb3VyIHJlZ2lzdHJ5XG4gIC8vIHVuZGVmaW5lZCBcdTIxOTIgdXNlIEpTL1RTIGZhbGxiYWNrICh0aGUgc2FtcGxlZCBmaWxlcyBhcmUgLnRzLy5qcyBhbnl3YXkpXG4gIC8vIFwiaGFza2VsbFwiIFx1MjE5MiB1bnN1cHBvcnRlZCwgZG9uJ3QgcnVuIEpTIHBhdHRlcm5zIGFnYWluc3QgSGFza2VsbCBjb2RlXG4gIGNvbnN0IGxhbmd1YWdlVW5zdXBwb3J0ZWQgPSBwcmltYXJ5TGFuZ3VhZ2UgIT09IHVuZGVmaW5lZCAmJiAhTEFOR1VBR0VfUEFUVEVSTlNbcHJpbWFyeUxhbmd1YWdlXTtcblxuICAvLyBJZiBsYW5ndWFnZSBpcyBleHBsaWNpdGx5IHNldCBidXQgbm90IGluIHJlZ2lzdHJ5LCBhZGQgZXZpZGVuY2UgZXhwbGFpbmluZyB3aHkgcGF0dGVybnMgYXJlbid0IGF2YWlsYWJsZVxuICBpZiAobGFuZ3VhZ2VVbnN1cHBvcnRlZCkge1xuICAgIGV2aWRlbmNlLmFzeW5jU3R5bGUucHVzaChgTGFuZ3VhZ2UgXCIke3ByaW1hcnlMYW5ndWFnZX1cIiBub3QgaW4gcGF0dGVybiByZWdpc3RyeSBcdTIwMTQgYXN5bmMgc3R5bGUgZGV0ZWN0aW9uIG5vdCBhdmFpbGFibGVgKTtcbiAgICBldmlkZW5jZS5lcnJvckhhbmRsaW5nLnB1c2goYExhbmd1YWdlIFwiJHtwcmltYXJ5TGFuZ3VhZ2V9XCIgbm90IGluIHBhdHRlcm4gcmVnaXN0cnkgXHUyMDE0IGVycm9yIGhhbmRsaW5nIGRldGVjdGlvbiBub3QgYXZhaWxhYmxlYCk7XG4gIH1cblxuICBmb3IgKGNvbnN0IGZpbGUgb2Ygc2FtcGxlZEZpbGVzKSB7XG4gICAgbGV0IGNvbnRlbnQ6IHN0cmluZztcbiAgICB0cnkge1xuICAgICAgY29uc3QgZnVsbFBhdGggPSBqb2luKGJhc2VQYXRoLCBmaWxlKTtcbiAgICAgIGNvbnN0IGJ1ZmZlciA9IEJ1ZmZlci5hbGxvYyhNQVhfRklMRV9TQU1QTEVfQllURVMpO1xuICAgICAgY29uc3QgZmQgPSBvcGVuU3luYyhmdWxsUGF0aCwgXCJyXCIpO1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgYnl0ZXNSZWFkID0gcmVhZFN5bmMoZmQsIGJ1ZmZlciwgMCwgTUFYX0ZJTEVfU0FNUExFX0JZVEVTLCAwKTtcbiAgICAgICAgY29udGVudCA9IGJ1ZmZlci50b1N0cmluZyhcInV0Zi04XCIsIDAsIGJ5dGVzUmVhZCk7XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICBjbG9zZVN5bmMoZmQpO1xuICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgY29udGludWU7IC8vIFNraXAgdW5yZWFkYWJsZSBmaWxlc1xuICAgIH1cblxuICAgIC8vIE9ubHkgcnVuIGxhbmd1YWdlLXNwZWNpZmljIHBhdHRlcm5zIGlmIHdlIGhhdmUgYSB2YWxpZCBsYW5ndWFnZSBlbnRyeVxuICAgIC8vIFRoaXMgcHJldmVudHMgbWlzbGVhZGluZyByZXN1bHRzIGZyb20gcnVubmluZyBKUy9UUyBwYXR0ZXJucyBhZ2FpbnN0IEhhc2tlbGwsIGV0Yy5cbiAgICBpZiAoIWxhbmd1YWdlVW5zdXBwb3J0ZWQgJiYgbGFuZ3VhZ2VFbnRyeSkge1xuICAgICAgLy8gQ291bnQgYXN5bmMgcGF0dGVybnMgdXNpbmcgbGFuZ3VhZ2UtYXBwcm9wcmlhdGUgcGF0dGVybnNcbiAgICAgIC8vIFVzZSBTdHJpbmcubWF0Y2goKSB0byBhdm9pZCBtdXRhdGluZyBsYXN0SW5kZXggb24gcmVnZXggd2l0aCAvZyBmbGFnXG4gICAgICBjb25zdCBhc3luY01vZGVybk1hdGNoZXMgPSBjb250ZW50Lm1hdGNoKGxhbmd1YWdlRW50cnkuYXN5bmNTdHlsZS5tb2Rlcm4pIHx8IFtdO1xuICAgICAgY291bnRzLmFzeW5jQXdhaXQgKz0gYXN5bmNNb2Rlcm5NYXRjaGVzLmxlbmd0aDtcbiAgICAgIGlmIChhc3luY01vZGVybk1hdGNoZXMubGVuZ3RoID4gMCkge1xuICAgICAgICBmaWxlQ291bnRzLmFzeW5jQXdhaXQrKztcbiAgICAgICAgaWYgKGV2aWRlbmNlLmFzeW5jU3R5bGUubGVuZ3RoIDwgMykge1xuICAgICAgICAgIGV2aWRlbmNlLmFzeW5jU3R5bGUucHVzaChgJHtmaWxlfTogJHtsYW5ndWFnZUVudHJ5LmFzeW5jU3R5bGUubW9kZXJuTGFiZWx9ICgke2FzeW5jTW9kZXJuTWF0Y2hlcy5sZW5ndGh9IG9jY3VycmVuY2VzKWApO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIEZvciBKUy9UUywgYWxzbyBjaGVjayBjYWxsYmFja3MgKHVuaXZlcnNhbCBwYXR0ZXJuKVxuICAgICAgaWYgKHByaW1hcnlMYW5ndWFnZSA9PT0gXCJqYXZhc2NyaXB0L3R5cGVzY3JpcHRcIikge1xuICAgICAgICBjb25zdCBjYWxsYmFja01hdGNoZXMgPSBjb250ZW50Lm1hdGNoKENBTExCQUNLX1JFKSB8fCBbXTtcbiAgICAgICAgY291bnRzLmNhbGxiYWNrcyArPSBjYWxsYmFja01hdGNoZXMubGVuZ3RoO1xuICAgICAgICBpZiAoY2FsbGJhY2tNYXRjaGVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICBmaWxlQ291bnRzLmNhbGxiYWNrcysrO1xuICAgICAgICAgIGlmIChldmlkZW5jZS5hc3luY1N0eWxlLmxlbmd0aCA8IDMpIHtcbiAgICAgICAgICAgIGV2aWRlbmNlLmFzeW5jU3R5bGUucHVzaChgJHtmaWxlfTogY2FsbGJhY2tzICgke2NhbGxiYWNrTWF0Y2hlcy5sZW5ndGh9IG9jY3VycmVuY2VzKWApO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBjb25zdCBhc3luY0xlZ2FjeU1hdGNoZXMgPSBjb250ZW50Lm1hdGNoKGxhbmd1YWdlRW50cnkuYXN5bmNTdHlsZS5sZWdhY3kpIHx8IFtdO1xuICAgICAgY291bnRzLnByb21pc2VzICs9IGFzeW5jTGVnYWN5TWF0Y2hlcy5sZW5ndGg7XG4gICAgICBpZiAoYXN5bmNMZWdhY3lNYXRjaGVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgZmlsZUNvdW50cy5wcm9taXNlcysrO1xuICAgICAgICBpZiAoZXZpZGVuY2UuYXN5bmNTdHlsZS5sZW5ndGggPCAzKSB7XG4gICAgICAgICAgZXZpZGVuY2UuYXN5bmNTdHlsZS5wdXNoKGAke2ZpbGV9OiAke2xhbmd1YWdlRW50cnkuYXN5bmNTdHlsZS5sZWdhY3lMYWJlbH0gKCR7YXN5bmNMZWdhY3lNYXRjaGVzLmxlbmd0aH0gb2NjdXJyZW5jZXMpYCk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gQ291bnQgZXJyb3IgaGFuZGxpbmcgcGF0dGVybnMgdXNpbmcgbGFuZ3VhZ2UtYXBwcm9wcmlhdGUgcGF0dGVybnNcbiAgICAgIGNvbnN0IGVycm9yU3RydWN0dXJlZE1hdGNoZXMgPSBjb250ZW50Lm1hdGNoKGxhbmd1YWdlRW50cnkuZXJyb3JIYW5kbGluZy5zdHJ1Y3R1cmVkKSB8fCBbXTtcbiAgICAgIGNvdW50cy50cnlDYXRjaCArPSBlcnJvclN0cnVjdHVyZWRNYXRjaGVzLmxlbmd0aDtcbiAgICAgIGlmIChlcnJvclN0cnVjdHVyZWRNYXRjaGVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgZmlsZUNvdW50cy50cnlDYXRjaCsrO1xuICAgICAgICBpZiAoZXZpZGVuY2UuZXJyb3JIYW5kbGluZy5sZW5ndGggPCAzKSB7XG4gICAgICAgICAgZXZpZGVuY2UuZXJyb3JIYW5kbGluZy5wdXNoKGAke2ZpbGV9OiAke2xhbmd1YWdlRW50cnkuZXJyb3JIYW5kbGluZy5zdHJ1Y3R1cmVkTGFiZWx9ICgke2Vycm9yU3RydWN0dXJlZE1hdGNoZXMubGVuZ3RofSBvY2N1cnJlbmNlcylgKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBjb25zdCBlcnJvcklubGluZU1hdGNoZXMgPSBjb250ZW50Lm1hdGNoKGxhbmd1YWdlRW50cnkuZXJyb3JIYW5kbGluZy5pbmxpbmUpIHx8IFtdO1xuICAgICAgY291bnRzLmVycm9yQ2FsbGJhY2tzICs9IGVycm9ySW5saW5lTWF0Y2hlcy5sZW5ndGg7XG4gICAgICBpZiAoZXJyb3JJbmxpbmVNYXRjaGVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgZmlsZUNvdW50cy5lcnJvckNhbGxiYWNrcysrO1xuICAgICAgICBpZiAoZXZpZGVuY2UuZXJyb3JIYW5kbGluZy5sZW5ndGggPCAzKSB7XG4gICAgICAgICAgZXZpZGVuY2UuZXJyb3JIYW5kbGluZy5wdXNoKGAke2ZpbGV9OiAke2xhbmd1YWdlRW50cnkuZXJyb3JIYW5kbGluZy5pbmxpbmVMYWJlbH0gKCR7ZXJyb3JJbmxpbmVNYXRjaGVzLmxlbmd0aH0gb2NjdXJyZW5jZXMpYCk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gUmVzdWx0IHR5cGVzIGFyZSBzdGlsbCB1c2VmdWwgZm9yIHNvbWUgbGFuZ3VhZ2VzIChSdXN0LCBmcC10cylcbiAgICAgIGNvbnN0IHJlc3VsdFR5cGVNYXRjaGVzID0gY29udGVudC5tYXRjaChSRVNVTFRfVFlQRV9SRSkgfHwgW107XG4gICAgICBjb3VudHMucmVzdWx0VHlwZXMgKz0gcmVzdWx0VHlwZU1hdGNoZXMubGVuZ3RoO1xuICAgICAgaWYgKHJlc3VsdFR5cGVNYXRjaGVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgZmlsZUNvdW50cy5yZXN1bHRUeXBlcysrO1xuICAgICAgICBpZiAoZXZpZGVuY2UuZXJyb3JIYW5kbGluZy5sZW5ndGggPCAzKSB7XG4gICAgICAgICAgZXZpZGVuY2UuZXJyb3JIYW5kbGluZy5wdXNoKGAke2ZpbGV9OiByZXN1bHQtdHlwZXMgKCR7cmVzdWx0VHlwZU1hdGNoZXMubGVuZ3RofSBvY2N1cnJlbmNlcylgKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIC8vIENvdW50IG5hbWluZyBjb252ZW50aW9uIHBhdHRlcm5zICh1bml2ZXJzYWwgYWNyb3NzIGFsbCBsYW5ndWFnZXMpXG4gICAgLy8gVGhlc2UgcGF0dGVybnMgd29yayByZWdhcmRsZXNzIG9mIHdoZXRoZXIgdGhlIGxhbmd1YWdlIGlzIGluIHRoZSByZWdpc3RyeVxuICAgIGNvbnN0IGNhbWVsTWF0Y2hlcyA9IGNvbnRlbnQubWF0Y2goQ0FNRUxfQ0FTRV9SRSkgfHwgW107XG4gICAgY291bnRzLmNhbWVsQ2FzZSArPSBjYW1lbE1hdGNoZXMubGVuZ3RoO1xuXG4gICAgY29uc3Qgc25ha2VNYXRjaGVzID0gY29udGVudC5tYXRjaChTTkFLRV9DQVNFX1JFKSB8fCBbXTtcbiAgICBjb3VudHMuc25ha2VDYXNlICs9IHNuYWtlTWF0Y2hlcy5sZW5ndGg7XG5cbiAgICBjb25zdCBwYXNjYWxNYXRjaGVzID0gY29udGVudC5tYXRjaChQQVNDQUxfQ0FTRV9SRSkgfHwgW107XG4gICAgY291bnRzLnBhc2NhbENhc2UgKz0gcGFzY2FsTWF0Y2hlcy5sZW5ndGg7XG4gIH1cblxuICAvLyBBZGQgbmFtaW5nIGV2aWRlbmNlXG4gIGlmIChjb3VudHMuY2FtZWxDYXNlID4gMCkge1xuICAgIGV2aWRlbmNlLm5hbWluZ0NvbnZlbnRpb24ucHVzaChgY2FtZWxDYXNlOiAke2NvdW50cy5jYW1lbENhc2V9IG9jY3VycmVuY2VzYCk7XG4gIH1cbiAgaWYgKGNvdW50cy5zbmFrZUNhc2UgPiAwKSB7XG4gICAgZXZpZGVuY2UubmFtaW5nQ29udmVudGlvbi5wdXNoKGBzbmFrZV9jYXNlOiAke2NvdW50cy5zbmFrZUNhc2V9IG9jY3VycmVuY2VzYCk7XG4gIH1cbiAgaWYgKGNvdW50cy5wYXNjYWxDYXNlID4gMCkge1xuICAgIGV2aWRlbmNlLm5hbWluZ0NvbnZlbnRpb24ucHVzaChgUGFzY2FsQ2FzZTogJHtjb3VudHMucGFzY2FsQ2FzZX0gb2NjdXJyZW5jZXNgKTtcbiAgfVxuXG4gIC8vIEZvciBleHBsaWNpdGx5IHNldCBidXQgdW5yZWNvZ25pemVkIGxhbmd1YWdlcywgcmV0dXJuIFwidW5rbm93blwiIGZvciBsYW5ndWFnZS1zcGVjaWZpYyBwYXR0ZXJuc1xuICAvLyBidXQgc3RpbGwgcHJvdmlkZSBuYW1pbmcgY29udmVudGlvbiBkZXRlY3Rpb24gKHdoaWNoIGlzIHVuaXZlcnNhbClcbiAgaWYgKGxhbmd1YWdlVW5zdXBwb3J0ZWQpIHtcbiAgICByZXR1cm4ge1xuICAgICAgYXN5bmNTdHlsZTogXCJ1bmtub3duXCIsXG4gICAgICBlcnJvckhhbmRsaW5nOiBcInVua25vd25cIixcbiAgICAgIG5hbWluZ0NvbnZlbnRpb246IGRldGVybWluZU5hbWluZ0NvbnZlbnRpb24oY291bnRzKSxcbiAgICAgIGV2aWRlbmNlLFxuICAgICAgZmlsZUNvdW50cyxcbiAgICB9O1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBhc3luY1N0eWxlOiBkZXRlcm1pbmVBc3luY1N0eWxlKGNvdW50cyksXG4gICAgZXJyb3JIYW5kbGluZzogZGV0ZXJtaW5lRXJyb3JIYW5kbGluZyhjb3VudHMpLFxuICAgIG5hbWluZ0NvbnZlbnRpb246IGRldGVybWluZU5hbWluZ0NvbnZlbnRpb24oY291bnRzKSxcbiAgICBldmlkZW5jZSxcbiAgICBmaWxlQ291bnRzLFxuICB9O1xufVxuXG4vKipcbiAqIERldGVybWluZSB0aGUgcHJpbWFyeSBhc3luYyBzdHlsZSBiYXNlZCBvbiBwYXR0ZXJuIGNvdW50cy5cbiAqL1xuZnVuY3Rpb24gZGV0ZXJtaW5lQXN5bmNTdHlsZShjb3VudHM6IHtcbiAgYXN5bmNBd2FpdDogbnVtYmVyO1xuICBjYWxsYmFja3M6IG51bWJlcjtcbiAgcHJvbWlzZXM6IG51bWJlcjtcbn0pOiBDb2RlUGF0dGVybnNbXCJhc3luY1N0eWxlXCJdIHtcbiAgY29uc3QgdG90YWwgPSBjb3VudHMuYXN5bmNBd2FpdCArIGNvdW50cy5jYWxsYmFja3MgKyBjb3VudHMucHJvbWlzZXM7XG4gIGlmICh0b3RhbCA9PT0gMCkgcmV0dXJuIFwidW5rbm93blwiO1xuXG4gIGNvbnN0IGFzeW5jQXdhaXRSYXRpbyA9IGNvdW50cy5hc3luY0F3YWl0IC8gdG90YWw7XG4gIGNvbnN0IGNhbGxiYWNrUmF0aW8gPSBjb3VudHMuY2FsbGJhY2tzIC8gdG90YWw7XG4gIGNvbnN0IHByb21pc2VSYXRpbyA9IGNvdW50cy5wcm9taXNlcyAvIHRvdGFsO1xuXG4gIC8vIElmIG9uZSBzdHlsZSBkb21pbmF0ZXMgKD42MCUpLCByZXBvcnQgaXRcbiAgaWYgKGFzeW5jQXdhaXRSYXRpbyA+IDAuNikgcmV0dXJuIFwiYXN5bmMvYXdhaXRcIjtcbiAgaWYgKGNhbGxiYWNrUmF0aW8gPiAwLjYpIHJldHVybiBcImNhbGxiYWNrc1wiO1xuICBpZiAocHJvbWlzZVJhdGlvID4gMC42KSByZXR1cm4gXCJwcm9taXNlc1wiO1xuXG4gIHJldHVybiBcIm1peGVkXCI7XG59XG5cbi8qKlxuICogRGV0ZXJtaW5lIHRoZSBwcmltYXJ5IGVycm9yIGhhbmRsaW5nIHN0eWxlIGJhc2VkIG9uIHBhdHRlcm4gY291bnRzLlxuICovXG5mdW5jdGlvbiBkZXRlcm1pbmVFcnJvckhhbmRsaW5nKGNvdW50czoge1xuICB0cnlDYXRjaDogbnVtYmVyO1xuICBlcnJvckNhbGxiYWNrczogbnVtYmVyO1xuICByZXN1bHRUeXBlczogbnVtYmVyO1xufSk6IENvZGVQYXR0ZXJuc1tcImVycm9ySGFuZGxpbmdcIl0ge1xuICBjb25zdCB0b3RhbCA9IGNvdW50cy50cnlDYXRjaCArIGNvdW50cy5lcnJvckNhbGxiYWNrcyArIGNvdW50cy5yZXN1bHRUeXBlcztcbiAgaWYgKHRvdGFsID09PSAwKSByZXR1cm4gXCJ1bmtub3duXCI7XG5cbiAgY29uc3QgdHJ5Q2F0Y2hSYXRpbyA9IGNvdW50cy50cnlDYXRjaCAvIHRvdGFsO1xuICBjb25zdCBlcnJvckNhbGxiYWNrUmF0aW8gPSBjb3VudHMuZXJyb3JDYWxsYmFja3MgLyB0b3RhbDtcbiAgY29uc3QgcmVzdWx0VHlwZVJhdGlvID0gY291bnRzLnJlc3VsdFR5cGVzIC8gdG90YWw7XG5cbiAgaWYgKHRyeUNhdGNoUmF0aW8gPiAwLjYpIHJldHVybiBcInRyeS9jYXRjaFwiO1xuICBpZiAoZXJyb3JDYWxsYmFja1JhdGlvID4gMC42KSByZXR1cm4gXCJlcnJvci1jYWxsYmFja3NcIjtcbiAgaWYgKHJlc3VsdFR5cGVSYXRpbyA+IDAuNikgcmV0dXJuIFwicmVzdWx0LXR5cGVzXCI7XG5cbiAgcmV0dXJuIFwibWl4ZWRcIjtcbn1cblxuLyoqXG4gKiBEZXRlcm1pbmUgdGhlIHByaW1hcnkgbmFtaW5nIGNvbnZlbnRpb24gYmFzZWQgb24gcGF0dGVybiBjb3VudHMuXG4gKi9cbmZ1bmN0aW9uIGRldGVybWluZU5hbWluZ0NvbnZlbnRpb24oY291bnRzOiB7XG4gIGNhbWVsQ2FzZTogbnVtYmVyO1xuICBzbmFrZUNhc2U6IG51bWJlcjtcbiAgcGFzY2FsQ2FzZTogbnVtYmVyO1xufSk6IENvZGVQYXR0ZXJuc1tcIm5hbWluZ0NvbnZlbnRpb25cIl0ge1xuICBjb25zdCB0b3RhbCA9IGNvdW50cy5jYW1lbENhc2UgKyBjb3VudHMuc25ha2VDYXNlICsgY291bnRzLnBhc2NhbENhc2U7XG4gIGlmICh0b3RhbCA9PT0gMCkgcmV0dXJuIFwidW5rbm93blwiO1xuXG4gIC8vIFBhc2NhbENhc2UgaXMgdXN1YWxseSBmb3IgdHlwZXMvY2xhc3Nlcywgc28gd2UgY29tcGFyZSBjYW1lbENhc2UgdnMgc25ha2VfY2FzZVxuICBjb25zdCBjYW1lbFJhdGlvID0gY291bnRzLmNhbWVsQ2FzZSAvIHRvdGFsO1xuICBjb25zdCBzbmFrZVJhdGlvID0gY291bnRzLnNuYWtlQ2FzZSAvIHRvdGFsO1xuXG4gIGlmIChjYW1lbFJhdGlvID4gMC42KSByZXR1cm4gXCJjYW1lbENhc2VcIjtcbiAgaWYgKHNuYWtlUmF0aW8gPiAwLjYpIHJldHVybiBcInNuYWtlX2Nhc2VcIjtcbiAgaWYgKGNvdW50cy5wYXNjYWxDYXNlID4gY291bnRzLmNhbWVsQ2FzZSAmJiBjb3VudHMucGFzY2FsQ2FzZSA+IGNvdW50cy5zbmFrZUNhc2UpIHJldHVybiBcIlBhc2NhbENhc2VcIjtcblxuICByZXR1cm4gXCJtaXhlZFwiO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRm9ybWF0dGluZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBGb3JtYXQgYSBDb2RlYmFzZUJyaWVmIGFzIExMTS1yZWFkYWJsZSBtYXJrZG93bi5cbiAqXG4gKiBAcGFyYW0gYnJpZWYgLSBUaGUgY29kZWJhc2UgYnJpZWYgdG8gZm9ybWF0XG4gKiBAcmV0dXJucyBNYXJrZG93biBzdHJpbmcgY2FwcGVkIGF0IE1BWF9DT0RFQkFTRV9CUklFRl9DSEFSU1xuICovXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0Q29kZWJhc2VCcmllZihicmllZjogQ29kZWJhc2VCcmllZik6IHN0cmluZyB7XG4gIGNvbnN0IHNlY3Rpb25zOiBzdHJpbmdbXSA9IFtdO1xuXG4gIC8vIFRlY2ggU3RhY2sgc2VjdGlvblxuICBzZWN0aW9ucy5wdXNoKFwiIyMgVGVjaCBTdGFja1wiKTtcbiAgaWYgKGJyaWVmLnRlY2hTdGFjay5wcmltYXJ5TGFuZ3VhZ2UpIHtcbiAgICBzZWN0aW9ucy5wdXNoKGAtICoqTGFuZ3VhZ2U6KiogJHticmllZi50ZWNoU3RhY2sucHJpbWFyeUxhbmd1YWdlfWApO1xuICB9XG4gIGlmIChicmllZi50ZWNoU3RhY2sucGFja2FnZU1hbmFnZXIpIHtcbiAgICBzZWN0aW9ucy5wdXNoKGAtICoqUGFja2FnZSBNYW5hZ2VyOioqICR7YnJpZWYudGVjaFN0YWNrLnBhY2thZ2VNYW5hZ2VyfWApO1xuICB9XG4gIGlmIChicmllZi50ZWNoU3RhY2suZGV0ZWN0ZWRGaWxlcy5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgZmlsZXMgPSBicmllZi50ZWNoU3RhY2suZGV0ZWN0ZWRGaWxlcy5zbGljZSgwLCAxMCkuam9pbihcIiwgXCIpO1xuICAgIHNlY3Rpb25zLnB1c2goYC0gKipQcm9qZWN0IEZpbGVzOioqICR7ZmlsZXN9YCk7XG4gIH1cbiAgc2VjdGlvbnMucHVzaChgLSAqKk1vbm9yZXBvOioqICR7YnJpZWYudGVjaFN0YWNrLmlzTW9ub3JlcG8gPyBcIlllc1wiIDogXCJOb1wifWApO1xuICBzZWN0aW9ucy5wdXNoKGAtICoqSGFzIFRlc3RzOioqICR7YnJpZWYudGVjaFN0YWNrLmhhc1Rlc3RzID8gXCJZZXNcIiA6IFwiTm9cIn1gKTtcbiAgc2VjdGlvbnMucHVzaChgLSAqKkhhcyBDSToqKiAke2JyaWVmLnRlY2hTdGFjay5oYXNDSSA/IFwiWWVzXCIgOiBcIk5vXCJ9YCk7XG5cbiAgLy8gTW9kdWxlIFN0cnVjdHVyZSBzZWN0aW9uXG4gIHNlY3Rpb25zLnB1c2goXCJcIik7XG4gIHNlY3Rpb25zLnB1c2goXCIjIyBNb2R1bGUgU3RydWN0dXJlXCIpO1xuICBpZiAoYnJpZWYubW9kdWxlU3RydWN0dXJlLnRvcExldmVsRGlycy5sZW5ndGggPiAwKSB7XG4gICAgc2VjdGlvbnMucHVzaChgLSAqKlRvcC1sZXZlbCBkaXJzOioqICR7YnJpZWYubW9kdWxlU3RydWN0dXJlLnRvcExldmVsRGlycy5qb2luKFwiLCBcIil9YCk7XG4gIH1cbiAgaWYgKGJyaWVmLm1vZHVsZVN0cnVjdHVyZS5zcmNTdWJkaXJzLmxlbmd0aCA+IDApIHtcbiAgICBzZWN0aW9ucy5wdXNoKGAtICoqU291cmNlIHN1YmRpcnM6KiogJHticmllZi5tb2R1bGVTdHJ1Y3R1cmUuc3JjU3ViZGlycy5qb2luKFwiLCBcIil9YCk7XG4gIH1cblxuICAvLyBDb2RlIFBhdHRlcm5zIHNlY3Rpb25cbiAgc2VjdGlvbnMucHVzaChcIlwiKTtcbiAgc2VjdGlvbnMucHVzaChcIiMjIENvZGUgUGF0dGVybnNcIik7XG4gIFxuICAvLyBGb3JtYXQgYXN5bmMgc3R5bGUgd2l0aCBmaWxlIGNvdW50c1xuICBjb25zdCBmYyA9IGJyaWVmLnBhdHRlcm5zLmZpbGVDb3VudHM7XG4gIGlmIChicmllZi5wYXR0ZXJucy5hc3luY1N0eWxlID09PSBcInVua25vd25cIikge1xuICAgIHNlY3Rpb25zLnB1c2goYC0gKipBc3luYyBTdHlsZToqKiAke2JyaWVmLnBhdHRlcm5zLmFzeW5jU3R5bGV9YCk7XG4gIH0gZWxzZSB7XG4gICAgY29uc3QgYXN5bmNQYXJ0czogc3RyaW5nW10gPSBbXTtcbiAgICBpZiAoZmMuYXN5bmNBd2FpdCA+IDApIGFzeW5jUGFydHMucHVzaChgJHtmYy5hc3luY0F3YWl0fSBhc3luYy9hd2FpdGApO1xuICAgIGlmIChmYy5wcm9taXNlcyA+IDApIGFzeW5jUGFydHMucHVzaChgJHtmYy5wcm9taXNlc30gLnRoZW4oKWApO1xuICAgIGlmIChmYy5jYWxsYmFja3MgPiAwKSBhc3luY1BhcnRzLnB1c2goYCR7ZmMuY2FsbGJhY2tzfSBjYWxsYmFja2ApO1xuICAgIGNvbnN0IGFzeW5jRGV0YWlsID0gYXN5bmNQYXJ0cy5sZW5ndGggPiAwID8gYCAoJHthc3luY1BhcnRzLm1hcChwID0+IHAgKyBcIiBmaWxlc1wiKS5qb2luKFwiIHZzIFwiKX0pYCA6IFwiXCI7XG4gICAgc2VjdGlvbnMucHVzaChgLSAqKkFzeW5jIFN0eWxlOioqICR7YnJpZWYucGF0dGVybnMuYXN5bmNTdHlsZX0ke2FzeW5jRGV0YWlsfWApO1xuICB9XG4gIFxuICAvLyBGb3JtYXQgZXJyb3IgaGFuZGxpbmcgd2l0aCBmaWxlIGNvdW50c1xuICBpZiAoYnJpZWYucGF0dGVybnMuZXJyb3JIYW5kbGluZyA9PT0gXCJ1bmtub3duXCIpIHtcbiAgICBzZWN0aW9ucy5wdXNoKGAtICoqRXJyb3IgSGFuZGxpbmc6KiogJHticmllZi5wYXR0ZXJucy5lcnJvckhhbmRsaW5nfWApO1xuICB9IGVsc2Uge1xuICAgIGNvbnN0IGVycm9yUGFydHM6IHN0cmluZ1tdID0gW107XG4gICAgaWYgKGZjLnRyeUNhdGNoID4gMCkgZXJyb3JQYXJ0cy5wdXNoKGAke2ZjLnRyeUNhdGNofSB0cnkvY2F0Y2hgKTtcbiAgICBpZiAoZmMuZXJyb3JDYWxsYmFja3MgPiAwKSBlcnJvclBhcnRzLnB1c2goYCR7ZmMuZXJyb3JDYWxsYmFja3N9IGVycm9yLWNhbGxiYWNrYCk7XG4gICAgaWYgKGZjLnJlc3VsdFR5cGVzID4gMCkgZXJyb3JQYXJ0cy5wdXNoKGAke2ZjLnJlc3VsdFR5cGVzfSByZXN1bHQtdHlwZWApO1xuICAgIGNvbnN0IGVycm9yRGV0YWlsID0gZXJyb3JQYXJ0cy5sZW5ndGggPiAwID8gYCAoJHtlcnJvclBhcnRzLm1hcChwID0+IHAgKyBcIiBmaWxlc1wiKS5qb2luKFwiIHZzIFwiKX0pYCA6IFwiXCI7XG4gICAgc2VjdGlvbnMucHVzaChgLSAqKkVycm9yIEhhbmRsaW5nOioqICR7YnJpZWYucGF0dGVybnMuZXJyb3JIYW5kbGluZ30ke2Vycm9yRGV0YWlsfWApO1xuICB9XG4gIFxuICBzZWN0aW9ucy5wdXNoKGAtICoqTmFtaW5nIENvbnZlbnRpb246KiogJHticmllZi5wYXR0ZXJucy5uYW1pbmdDb252ZW50aW9ufWApO1xuXG4gIGxldCByZXN1bHQgPSBzZWN0aW9ucy5qb2luKFwiXFxuXCIpO1xuXG4gIC8vIFRydW5jYXRlIGlmIG5lY2Vzc2FyeVxuICBpZiAocmVzdWx0Lmxlbmd0aCA+IE1BWF9DT0RFQkFTRV9CUklFRl9DSEFSUykge1xuICAgIHJlc3VsdCA9IHJlc3VsdC5zbGljZSgwLCBNQVhfQ09ERUJBU0VfQlJJRUZfQ0hBUlMgLSAzKSArIFwiLi4uXCI7XG4gIH1cblxuICByZXR1cm4gcmVzdWx0O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUHJpb3IgQ29udGV4dCBBZ2dyZWdhdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqIE1heGltdW0gY2hhcmFjdGVycyBwZXIgc2VjdGlvbiBpbiB0aGUgcHJpb3IgY29udGV4dCBicmllZi4gKi9cbmNvbnN0IE1BWF9TRUNUSU9OX0NIQVJTID0gMjAwMDtcblxuLyoqIE1heGltdW0gdG90YWwgY2hhcmFjdGVycyBmb3IgdGhlIHByaW9yIGNvbnRleHQgYnJpZWYuICovXG5jb25zdCBNQVhfUFJJT1JfQ09OVEVYVF9DSEFSUyA9IDYwMDA7XG5cbi8qKlxuICogQWdncmVnYXRlIHByaW9yIGNvbnRleHQgZnJvbSBHU0QgYXJ0aWZhY3RzLlxuICpcbiAqIFJlYWRzIERFQ0lTSU9OUy5tZCwgUkVRVUlSRU1FTlRTLm1kLCBLTk9XTEVER0UubWQgZnJvbSB0aGUgLmdzZCBkaXJlY3RvcnlcbiAqIGFuZCBtaWxlc3RvbmUgc3VtbWFyaWVzIGZyb20gZWFjaCBtaWxlc3RvbmUncyBNSUxFU1RPTkUtU1VNTUFSWS5tZCBmaWxlLlxuICpcbiAqIEBwYXJhbSBiYXNlUGF0aCAtIFJvb3QgZGlyZWN0b3J5IG9mIHRoZSBwcm9qZWN0IChjb250YWlucyAuZ3NkLylcbiAqIEByZXR1cm5zIFByaW9yQ29udGV4dEJyaWVmIHdpdGggYWdncmVnYXRlZCBjb250ZXh0XG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBhZ2dyZWdhdGVQcmlvckNvbnRleHQoYmFzZVBhdGg6IHN0cmluZyk6IFByb21pc2U8UHJpb3JDb250ZXh0QnJpZWY+IHtcbiAgY29uc3QgZ3NkUGF0aCA9IGpvaW4oYmFzZVBhdGgsIFwiLmdzZFwiKTtcblxuICAvLyBMb2FkIGRlY2lzaW9uc1xuICBjb25zdCBkZWNpc2lvbnNDb250ZW50ID0gYXdhaXQgbG9hZEZpbGUoam9pbihnc2RQYXRoLCBcIkRFQ0lTSU9OUy5tZFwiKSk7XG4gIGNvbnN0IGRlY2lzaW9ucyA9IHBhcnNlRGVjaXNpb25zKGRlY2lzaW9uc0NvbnRlbnQpO1xuXG4gIC8vIExvYWQgcmVxdWlyZW1lbnRzXG4gIGNvbnN0IHJlcXVpcmVtZW50c0NvbnRlbnQgPSBhd2FpdCBsb2FkRmlsZShqb2luKGdzZFBhdGgsIFwiUkVRVUlSRU1FTlRTLm1kXCIpKTtcbiAgY29uc3QgcmVxdWlyZW1lbnRzID0gcGFyc2VSZXF1aXJlbWVudHMocmVxdWlyZW1lbnRzQ29udGVudCk7XG5cbiAgLy8gTG9hZCBrbm93bGVkZ2VcbiAgY29uc3Qga25vd2xlZGdlQ29udGVudCA9IGF3YWl0IGxvYWRGaWxlKGpvaW4oZ3NkUGF0aCwgXCJLTk9XTEVER0UubWRcIikpO1xuICBjb25zdCBrbm93bGVkZ2UgPSB0cnVuY2F0ZVNlY3Rpb24oa25vd2xlZGdlQ29udGVudCB8fCBcIlwiLCBNQVhfU0VDVElPTl9DSEFSUyk7XG5cbiAgLy8gTG9hZCBtaWxlc3RvbmUgc3VtbWFyaWVzXG4gIGNvbnN0IHN1bW1hcmllcyA9IGF3YWl0IGxvYWRNaWxlc3RvbmVTdW1tYXJpZXMoZ3NkUGF0aCk7XG5cbiAgcmV0dXJuIHtcbiAgICBkZWNpc2lvbnMsXG4gICAgcmVxdWlyZW1lbnRzLFxuICAgIGtub3dsZWRnZToga25vd2xlZGdlIHx8IFwiTm8gcHJpb3Iga25vd2xlZGdlIHJlY29yZGVkLlwiLFxuICAgIHN1bW1hcmllczogc3VtbWFyaWVzIHx8IFwiTm8gcHJpb3IgbWlsZXN0b25lIHN1bW1hcmllcy5cIixcbiAgfTtcbn1cblxuLyoqXG4gKiBQYXJzZSBkZWNpc2lvbnMgZnJvbSBERUNJU0lPTlMubWQgY29udGVudC5cbiAqXG4gKiBHcm91cHMgZGVjaXNpb25zIGJ5IHNjb3BlIChlLmcuLCBcInBhdHRlcm5cIiwgXCJhcmNoaXRlY3R1cmVcIikuXG4gKi9cbmZ1bmN0aW9uIHBhcnNlRGVjaXNpb25zKGNvbnRlbnQ6IHN0cmluZyB8IG51bGwpOiBQcmlvckNvbnRleHRCcmllZltcImRlY2lzaW9uc1wiXSB7XG4gIGNvbnN0IGJ5U2NvcGUgPSBuZXcgTWFwPHN0cmluZywgRGVjaXNpb25FbnRyeVtdPigpO1xuXG4gIGlmICghY29udGVudCkge1xuICAgIHJldHVybiB7IGJ5U2NvcGUsIHRvdGFsQ291bnQ6IDAgfTtcbiAgfVxuXG4gIC8vIFBhcnNlIHRhYmxlIHJvd3M6IHwgRDAwMSB8IE0wMDEvUzAxIHwgcGF0dGVybiB8IC4uLiB8XG4gIC8vIFNraXAgaGVhZGVyIHJvd3MgKHN0YXJ0IHdpdGggfCAjIG9yIHwtLS0pXG4gIGNvbnN0IGxpbmVzID0gY29udGVudC5zcGxpdChcIlxcblwiKTtcbiAgbGV0IHRvdGFsQ291bnQgPSAwO1xuXG4gIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xuICAgIGNvbnN0IHRyaW1tZWQgPSBsaW5lLnRyaW0oKTtcblxuICAgIC8vIFNraXAgbm9uLXRhYmxlIGxpbmVzLCBoZWFkZXIsIGFuZCBzZXBhcmF0b3Igcm93c1xuICAgIGlmICghdHJpbW1lZC5zdGFydHNXaXRoKFwifFwiKSkgY29udGludWU7XG4gICAgaWYgKHRyaW1tZWQuc3RhcnRzV2l0aChcInwgI1wiKSB8fCB0cmltbWVkLnN0YXJ0c1dpdGgoXCJ8LS0tXCIpIHx8IHRyaW1tZWQuc3RhcnRzV2l0aChcInwgLVwiKSkgY29udGludWU7XG5cbiAgICAvLyBQYXJzZTogfCBEMDAxIHwgTTAwMS9TMDEgfCBwYXR0ZXJuIHwgRGVjaXNpb24gfCBDaG9pY2UgfCBSYXRpb25hbGUgfCBSZXZpc2FibGU/IHwgTWFkZSBCeSB8XG4gICAgY29uc3QgY2VsbHMgPSB0cmltbWVkXG4gICAgICAuc3BsaXQoXCJ8XCIpXG4gICAgICAubWFwKChjKSA9PiBjLnRyaW0oKSlcbiAgICAgIC5maWx0ZXIoKGMpID0+IGMubGVuZ3RoID4gMCk7XG5cbiAgICBpZiAoY2VsbHMubGVuZ3RoIDwgNikgY29udGludWU7XG5cbiAgICBjb25zdCBpZCA9IGNlbGxzWzBdOyAvLyBEMDAxXG4gICAgaWYgKCFpZC5tYXRjaCgvXkRcXGQrJC8pKSBjb250aW51ZTsgLy8gTXVzdCBiZSBhIGRlY2lzaW9uIElEXG5cbiAgICBjb25zdCBzY29wZSA9IGNlbGxzWzJdOyAvLyBwYXR0ZXJuLCBhcmNoaXRlY3R1cmUsIGV0Yy5cbiAgICBjb25zdCBkZWNpc2lvbiA9IGNlbGxzWzNdO1xuICAgIGNvbnN0IGNob2ljZSA9IGNlbGxzWzRdO1xuICAgIGNvbnN0IHJhdGlvbmFsZSA9IGNlbGxzWzVdO1xuXG4gICAgY29uc3QgZW50cnk6IERlY2lzaW9uRW50cnkgPSB7IGlkLCBzY29wZSwgZGVjaXNpb24sIGNob2ljZSwgcmF0aW9uYWxlIH07XG5cbiAgICBpZiAoIWJ5U2NvcGUuaGFzKHNjb3BlKSkge1xuICAgICAgYnlTY29wZS5zZXQoc2NvcGUsIFtdKTtcbiAgICB9XG4gICAgYnlTY29wZS5nZXQoc2NvcGUpIS5wdXNoKGVudHJ5KTtcbiAgICB0b3RhbENvdW50Kys7XG4gIH1cblxuICByZXR1cm4geyBieVNjb3BlLCB0b3RhbENvdW50IH07XG59XG5cbi8qKlxuICogUGFyc2UgcmVxdWlyZW1lbnRzIGZyb20gUkVRVUlSRU1FTlRTLm1kIGNvbnRlbnQuXG4gKlxuICogR3JvdXBzIHJlcXVpcmVtZW50cyBieSBzdGF0dXMgKGFjdGl2ZSwgdmFsaWRhdGVkLCBkZWZlcnJlZCkuXG4gKi9cbmZ1bmN0aW9uIHBhcnNlUmVxdWlyZW1lbnRzKGNvbnRlbnQ6IHN0cmluZyB8IG51bGwpOiBQcmlvckNvbnRleHRCcmllZltcInJlcXVpcmVtZW50c1wiXSB7XG4gIGNvbnN0IHJlc3VsdDogUHJpb3JDb250ZXh0QnJpZWZbXCJyZXF1aXJlbWVudHNcIl0gPSB7XG4gICAgYWN0aXZlOiBbXSxcbiAgICB2YWxpZGF0ZWQ6IFtdLFxuICAgIGRlZmVycmVkOiBbXSxcbiAgICB0b3RhbENvdW50OiAwLFxuICB9O1xuXG4gIGlmICghY29udGVudCkge1xuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cblxuICAvLyBQYXJzZSByZXF1aXJlbWVudCBlbnRyaWVzOiAjIyMgUjEwMSBcdTIwMTQgRGVzY3JpcHRpb25cbiAgLy8gTG9vayBmb3IgU3RhdHVzOiBsaW5lIHRvIGRldGVybWluZSBzdGF0dXNcbiAgY29uc3QgcmVxQmxvY2tzID0gY29udGVudC5zcGxpdCgvKD89XiMjIyBSXFxkKykvbSk7XG5cbiAgZm9yIChjb25zdCBibG9jayBvZiByZXFCbG9ja3MpIHtcbiAgICBjb25zdCBpZE1hdGNoID0gYmxvY2subWF0Y2goL14jIyMgKFJcXGQrKVxccypcdTIwMTRcXHMqKC4rKS9tKTtcbiAgICBpZiAoIWlkTWF0Y2gpIGNvbnRpbnVlO1xuXG4gICAgY29uc3QgaWQgPSBpZE1hdGNoWzFdO1xuICAgIGNvbnN0IGRlc2NyaXB0aW9uID0gaWRNYXRjaFsyXS50cmltKCk7XG5cbiAgICAvLyBFeHRyYWN0IHN0YXR1cyBmcm9tIFwiLSBTdGF0dXM6IGFjdGl2ZVwiIGxpbmVcbiAgICBjb25zdCBzdGF0dXNNYXRjaCA9IGJsb2NrLm1hdGNoKC9eLVxccypTdGF0dXM6XFxzKihcXHcrKS9tKTtcbiAgICBjb25zdCBzdGF0dXNSYXcgPSBzdGF0dXNNYXRjaCA/IHN0YXR1c01hdGNoWzFdLnRvTG93ZXJDYXNlKCkgOiBcImFjdGl2ZVwiO1xuXG4gICAgbGV0IHN0YXR1czogUmVxdWlyZW1lbnRFbnRyeVtcInN0YXR1c1wiXSA9IFwiYWN0aXZlXCI7XG4gICAgaWYgKHN0YXR1c1JhdyA9PT0gXCJ2YWxpZGF0ZWRcIikgc3RhdHVzID0gXCJ2YWxpZGF0ZWRcIjtcbiAgICBlbHNlIGlmIChzdGF0dXNSYXcgPT09IFwiZGVmZXJyZWRcIikgc3RhdHVzID0gXCJkZWZlcnJlZFwiO1xuICAgIGVsc2UgaWYgKHN0YXR1c1JhdyA9PT0gXCJvdXQtb2Ytc2NvcGVcIiB8fCBzdGF0dXNSYXcgPT09IFwib3V0b2ZzY29wZVwiKSBzdGF0dXMgPSBcIm91dC1vZi1zY29wZVwiO1xuXG4gICAgY29uc3QgZW50cnk6IFJlcXVpcmVtZW50RW50cnkgPSB7IGlkLCBkZXNjcmlwdGlvbiwgc3RhdHVzIH07XG5cbiAgICBpZiAoc3RhdHVzID09PSBcImFjdGl2ZVwiKSByZXN1bHQuYWN0aXZlLnB1c2goZW50cnkpO1xuICAgIGVsc2UgaWYgKHN0YXR1cyA9PT0gXCJ2YWxpZGF0ZWRcIikgcmVzdWx0LnZhbGlkYXRlZC5wdXNoKGVudHJ5KTtcbiAgICBlbHNlIGlmIChzdGF0dXMgPT09IFwiZGVmZXJyZWRcIikgcmVzdWx0LmRlZmVycmVkLnB1c2goZW50cnkpO1xuXG4gICAgcmVzdWx0LnRvdGFsQ291bnQrKztcbiAgfVxuXG4gIHJldHVybiByZXN1bHQ7XG59XG5cbi8qKlxuICogTG9hZCBhbmQgY29tYmluZSBtaWxlc3RvbmUgc3VtbWFyaWVzIGZyb20gZWFjaCBtaWxlc3RvbmUgZGlyZWN0b3J5LlxuICpcbiAqIFJldHVybnMgY29tYmluZWQgY29udGVudCwgdHJ1bmNhdGVkIHRvIE1BWF9TRUNUSU9OX0NIQVJTLlxuICovXG5hc3luYyBmdW5jdGlvbiBsb2FkTWlsZXN0b25lU3VtbWFyaWVzKGdzZFBhdGg6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IG1pbGVzdG9uZXNQYXRoID0gam9pbihnc2RQYXRoLCBcIm1pbGVzdG9uZXNcIik7XG4gIGNvbnN0IHN1bW1hcmllczogc3RyaW5nW10gPSBbXTtcblxuICB0cnkge1xuICAgIGNvbnN0IGVudHJpZXMgPSByZWFkZGlyU3luY05vZGUobWlsZXN0b25lc1BhdGgsIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KTtcbiAgICBjb25zdCBtaWxlc3RvbmVJZHMgPSBlbnRyaWVzXG4gICAgICAuZmlsdGVyKChlKSA9PiBlLmlzRGlyZWN0b3J5KCkgJiYgZS5uYW1lLm1hdGNoKC9eTVxcZCsvKSlcbiAgICAgIC5tYXAoKGUpID0+IGUubmFtZSlcbiAgICAgIC5zb3J0KCk7IC8vIFNvcnQgYnkgbWlsZXN0b25lIElEXG5cbiAgICBmb3IgKGNvbnN0IG1pZCBvZiBtaWxlc3RvbmVJZHMpIHtcbiAgICAgIGNvbnN0IHN1bW1hcnlQYXRoID0gam9pbihtaWxlc3RvbmVzUGF0aCwgbWlkLCBcIk1JTEVTVE9ORS1TVU1NQVJZLm1kXCIpO1xuICAgICAgY29uc3QgY29udGVudCA9IGF3YWl0IGxvYWRGaWxlKHN1bW1hcnlQYXRoKTtcbiAgICAgIGlmIChjb250ZW50KSB7XG4gICAgICAgIC8vIEV4dHJhY3QgdGhlIG9uZS1saW5lciBhbmQgZmlyc3Qgc2VjdGlvbiBmb3IgYnJldml0eVxuICAgICAgICBjb25zdCBvbmVMaW5lciA9IGV4dHJhY3RPbmVMaW5lcihjb250ZW50KTtcbiAgICAgICAgc3VtbWFyaWVzLnB1c2goYCMjIyAke21pZH1cXG4ke29uZUxpbmVyfWApO1xuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gTWlsZXN0b25lcyBkaXJlY3RvcnkgZG9lc24ndCBleGlzdCBvciBub3QgcmVhZGFibGVcbiAgfVxuXG4gIGlmIChzdW1tYXJpZXMubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIFwiXCI7XG4gIH1cblxuICByZXR1cm4gdHJ1bmNhdGVTZWN0aW9uKHN1bW1hcmllcy5qb2luKFwiXFxuXFxuXCIpLCBNQVhfU0VDVElPTl9DSEFSUyk7XG59XG5cbi8qKlxuICogRXh0cmFjdCB0aGUgb25lLWxpbmVyIHN1bW1hcnkgZnJvbSBhIE1JTEVTVE9ORS1TVU1NQVJZLm1kLlxuICpcbiAqIExvb2tzIGZvciBib2xkIHRleHQgb24gYSBsaW5lIGJ5IGl0c2VsZiAoZS5nLiwgXCIqKkNvbXBsZXRlZCBYIGFuZCBZKipcIikuXG4gKi9cbmZ1bmN0aW9uIGV4dHJhY3RPbmVMaW5lcihjb250ZW50OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBsaW5lcyA9IGNvbnRlbnQuc3BsaXQoXCJcXG5cIik7XG4gIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xuICAgIGNvbnN0IHRyaW1tZWQgPSBsaW5lLnRyaW0oKTtcbiAgICAvLyBMb29rIGZvciAqKmJvbGQgdGV4dCoqIHRoYXQncyB0aGUgd2hvbGUgbGluZVxuICAgIGlmICh0cmltbWVkLnN0YXJ0c1dpdGgoXCIqKlwiKSAmJiB0cmltbWVkLmVuZHNXaXRoKFwiKipcIikgJiYgdHJpbW1lZC5sZW5ndGggPiA0KSB7XG4gICAgICByZXR1cm4gdHJpbW1lZC5zbGljZSgyLCAtMik7XG4gICAgfVxuICB9XG4gIC8vIEZhbGxiYWNrOiByZXR1cm4gZmlyc3Qgbm9uLWVtcHR5LCBub24taGVhZGluZyBsaW5lXG4gIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xuICAgIGNvbnN0IHRyaW1tZWQgPSBsaW5lLnRyaW0oKTtcbiAgICBpZiAodHJpbW1lZCAmJiAhdHJpbW1lZC5zdGFydHNXaXRoKFwiI1wiKSAmJiAhdHJpbW1lZC5zdGFydHNXaXRoKFwiLS0tXCIpKSB7XG4gICAgICByZXR1cm4gdHJpbW1lZC5zbGljZSgwLCAyMDApO1xuICAgIH1cbiAgfVxuICByZXR1cm4gXCJTdW1tYXJ5IGF2YWlsYWJsZVwiO1xufVxuXG4vKipcbiAqIFRydW5jYXRlIGNvbnRlbnQgdG8gbWF4Q2hhcnMgd2l0aG91dCBjdXR0aW5nIG1pZC1zZWN0aW9uLlxuICpcbiAqIFByZWZlcnMgdG8gY3V0IGF0IHNlY3Rpb24gYm91bmRhcmllcyAoIyMgaGVhZGluZ3MpIG9yIHBhcmFncmFwaCBicmVha3MuXG4gKi9cbmZ1bmN0aW9uIHRydW5jYXRlU2VjdGlvbihjb250ZW50OiBzdHJpbmcsIG1heENoYXJzOiBudW1iZXIpOiBzdHJpbmcge1xuICBpZiAoY29udGVudC5sZW5ndGggPD0gbWF4Q2hhcnMpIHtcbiAgICByZXR1cm4gY29udGVudDtcbiAgfVxuXG4gIGNvbnN0IFNFQ1RJT05fU1VGRklYID0gXCJcXG5cXG5bdHJ1bmNhdGVkXVwiOyAvLyAxNCBjaGFyc1xuICBjb25zdCBXT1JEX1NVRkZJWCA9IFwiLi4uIFt0cnVuY2F0ZWRdXCI7IC8vIDE1IGNoYXJzXG5cbiAgLy8gUmVzZXJ2ZSBzcGFjZSBmb3Igc3VmZml4IGluIGFsbCBzbGljaW5nIG9wZXJhdGlvbnNcbiAgY29uc3Qgc2VjdGlvbk1heFNsaWNlID0gbWF4Q2hhcnMgLSBTRUNUSU9OX1NVRkZJWC5sZW5ndGg7XG4gIGNvbnN0IHdvcmRNYXhTbGljZSA9IG1heENoYXJzIC0gV09SRF9TVUZGSVgubGVuZ3RoO1xuXG4gIC8vIFRyeSB0byBjdXQgYXQgYSBzZWN0aW9uIGJvdW5kYXJ5XG4gIGNvbnN0IHRydW5jYXRlZCA9IGNvbnRlbnQuc2xpY2UoMCwgc2VjdGlvbk1heFNsaWNlKTtcbiAgY29uc3QgbGFzdFNlY3Rpb24gPSB0cnVuY2F0ZWQubGFzdEluZGV4T2YoXCJcXG4jIyBcIik7XG4gIGlmIChsYXN0U2VjdGlvbiA+IHNlY3Rpb25NYXhTbGljZSAqIDAuNSkge1xuICAgIHJldHVybiB0cnVuY2F0ZWQuc2xpY2UoMCwgbGFzdFNlY3Rpb24pLnRyaW0oKSArIFNFQ1RJT05fU1VGRklYO1xuICB9XG5cbiAgLy8gVHJ5IHRvIGN1dCBhdCBhIHBhcmFncmFwaCBicmVha1xuICBjb25zdCBsYXN0UGFyYSA9IHRydW5jYXRlZC5sYXN0SW5kZXhPZihcIlxcblxcblwiKTtcbiAgaWYgKGxhc3RQYXJhID4gc2VjdGlvbk1heFNsaWNlICogMC41KSB7XG4gICAgcmV0dXJuIHRydW5jYXRlZC5zbGljZSgwLCBsYXN0UGFyYSkudHJpbSgpICsgU0VDVElPTl9TVUZGSVg7XG4gIH1cblxuICAvLyBMYXN0IHJlc29ydDogY3V0IGF0IHdvcmQgYm91bmRhcnlcbiAgY29uc3Qgd29yZFRydW5jYXRlZCA9IGNvbnRlbnQuc2xpY2UoMCwgd29yZE1heFNsaWNlKTtcbiAgY29uc3QgbGFzdFNwYWNlID0gd29yZFRydW5jYXRlZC5sYXN0SW5kZXhPZihcIiBcIik7XG4gIGlmIChsYXN0U3BhY2UgPiB3b3JkTWF4U2xpY2UgKiAwLjgpIHtcbiAgICByZXR1cm4gd29yZFRydW5jYXRlZC5zbGljZSgwLCBsYXN0U3BhY2UpLnRyaW0oKSArIFdPUkRfU1VGRklYO1xuICB9XG5cbiAgcmV0dXJuIGNvbnRlbnQuc2xpY2UoMCwgd29yZE1heFNsaWNlKSArIFdPUkRfU1VGRklYO1xufVxuXG4vKipcbiAqIEZvcm1hdCBhIFByaW9yQ29udGV4dEJyaWVmIGFzIExMTS1yZWFkYWJsZSBtYXJrZG93bi5cbiAqXG4gKiBAcGFyYW0gYnJpZWYgLSBUaGUgcHJpb3IgY29udGV4dCBicmllZiB0byBmb3JtYXRcbiAqIEByZXR1cm5zIE1hcmtkb3duIHN0cmluZyBjYXBwZWQgYXQgTUFYX1BSSU9SX0NPTlRFWFRfQ0hBUlNcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdFByaW9yQ29udGV4dEJyaWVmKGJyaWVmOiBQcmlvckNvbnRleHRCcmllZik6IHN0cmluZyB7XG4gIGNvbnN0IHNlY3Rpb25zOiBzdHJpbmdbXSA9IFtdO1xuXG4gIC8vIERlY2lzaW9ucyBzZWN0aW9uXG4gIHNlY3Rpb25zLnB1c2goXCIjIyBQcmlvciBEZWNpc2lvbnNcIik7XG4gIGlmIChicmllZi5kZWNpc2lvbnMudG90YWxDb3VudCA9PT0gMCkge1xuICAgIHNlY3Rpb25zLnB1c2goXCJObyBwcmlvciBkZWNpc2lvbnMgcmVjb3JkZWQuXCIpO1xuICB9IGVsc2Uge1xuICAgIHNlY3Rpb25zLnB1c2goYCR7YnJpZWYuZGVjaXNpb25zLnRvdGFsQ291bnR9IGRlY2lzaW9ucyByZWNvcmRlZC5gKTtcbiAgICBzZWN0aW9ucy5wdXNoKFwiXCIpO1xuXG4gICAgLy8gR3JvdXAgYnkgc2NvcGVcbiAgICBmb3IgKGNvbnN0IFtzY29wZSwgZW50cmllc10gb2YgYnJpZWYuZGVjaXNpb25zLmJ5U2NvcGUpIHtcbiAgICAgIHNlY3Rpb25zLnB1c2goYCMjIyAke3Njb3BlfWApO1xuICAgICAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzLnNsaWNlKDAsIDUpKSB7IC8vIExpbWl0IHBlciBzY29wZVxuICAgICAgICBzZWN0aW9ucy5wdXNoKGAtICoqJHtlbnRyeS5pZH06KiogJHtlbnRyeS5kZWNpc2lvbn0gXHUyMTkyICR7ZW50cnkuY2hvaWNlfWApO1xuICAgICAgfVxuICAgICAgaWYgKGVudHJpZXMubGVuZ3RoID4gNSkge1xuICAgICAgICBzZWN0aW9ucy5wdXNoKGAtIF8oJHtlbnRyaWVzLmxlbmd0aCAtIDV9IG1vcmUgaW4gdGhpcyBzY29wZSlfYCk7XG4gICAgICB9XG4gICAgICBzZWN0aW9ucy5wdXNoKFwiXCIpO1xuICAgIH1cbiAgfVxuXG4gIC8vIFJlcXVpcmVtZW50cyBzZWN0aW9uXG4gIHNlY3Rpb25zLnB1c2goXCIjIyBQcmlvciBSZXF1aXJlbWVudHNcIik7XG4gIGNvbnN0IHJlcVRvdGFsID0gYnJpZWYucmVxdWlyZW1lbnRzLnRvdGFsQ291bnQ7XG4gIGlmIChyZXFUb3RhbCA9PT0gMCkge1xuICAgIHNlY3Rpb25zLnB1c2goXCJObyBwcmlvciByZXF1aXJlbWVudHMgcmVjb3JkZWQuXCIpO1xuICB9IGVsc2Uge1xuICAgIHNlY3Rpb25zLnB1c2goXG4gICAgICBgJHtyZXFUb3RhbH0gcmVxdWlyZW1lbnRzOiAke2JyaWVmLnJlcXVpcmVtZW50cy5hY3RpdmUubGVuZ3RofSBhY3RpdmUsIGAgK1xuICAgICAgICBgJHticmllZi5yZXF1aXJlbWVudHMudmFsaWRhdGVkLmxlbmd0aH0gdmFsaWRhdGVkLCBgICtcbiAgICAgICAgYCR7YnJpZWYucmVxdWlyZW1lbnRzLmRlZmVycmVkLmxlbmd0aH0gZGVmZXJyZWQuYCxcbiAgICApO1xuICAgIHNlY3Rpb25zLnB1c2goXCJcIik7XG5cbiAgICAvLyBTaG93IGFjdGl2ZSByZXF1aXJlbWVudHMgKG1vc3QgcmVsZXZhbnQpXG4gICAgaWYgKGJyaWVmLnJlcXVpcmVtZW50cy5hY3RpdmUubGVuZ3RoID4gMCkge1xuICAgICAgc2VjdGlvbnMucHVzaChcIiMjIyBBY3RpdmVcIik7XG4gICAgICBmb3IgKGNvbnN0IHJlcSBvZiBicmllZi5yZXF1aXJlbWVudHMuYWN0aXZlLnNsaWNlKDAsIDEwKSkge1xuICAgICAgICBzZWN0aW9ucy5wdXNoKGAtICoqJHtyZXEuaWR9OioqICR7cmVxLmRlc2NyaXB0aW9ufWApO1xuICAgICAgfVxuICAgICAgaWYgKGJyaWVmLnJlcXVpcmVtZW50cy5hY3RpdmUubGVuZ3RoID4gMTApIHtcbiAgICAgICAgc2VjdGlvbnMucHVzaChgLSBfKCR7YnJpZWYucmVxdWlyZW1lbnRzLmFjdGl2ZS5sZW5ndGggLSAxMH0gbW9yZSBhY3RpdmUpX2ApO1xuICAgICAgfVxuICAgICAgc2VjdGlvbnMucHVzaChcIlwiKTtcbiAgICB9XG5cbiAgICAvLyBTaG93IHZhbGlkYXRlZCAocmVjZW50bHkgY29tcGxldGVkKVxuICAgIGlmIChicmllZi5yZXF1aXJlbWVudHMudmFsaWRhdGVkLmxlbmd0aCA+IDApIHtcbiAgICAgIHNlY3Rpb25zLnB1c2goXCIjIyMgVmFsaWRhdGVkXCIpO1xuICAgICAgZm9yIChjb25zdCByZXEgb2YgYnJpZWYucmVxdWlyZW1lbnRzLnZhbGlkYXRlZC5zbGljZSgwLCA1KSkge1xuICAgICAgICBzZWN0aW9ucy5wdXNoKGAtICoqJHtyZXEuaWR9OioqICR7cmVxLmRlc2NyaXB0aW9ufWApO1xuICAgICAgfVxuICAgICAgaWYgKGJyaWVmLnJlcXVpcmVtZW50cy52YWxpZGF0ZWQubGVuZ3RoID4gNSkge1xuICAgICAgICBzZWN0aW9ucy5wdXNoKGAtIF8oJHticmllZi5yZXF1aXJlbWVudHMudmFsaWRhdGVkLmxlbmd0aCAtIDV9IG1vcmUgdmFsaWRhdGVkKV9gKTtcbiAgICAgIH1cbiAgICAgIHNlY3Rpb25zLnB1c2goXCJcIik7XG4gICAgfVxuICB9XG5cbiAgLy8gS25vd2xlZGdlIHNlY3Rpb25cbiAgc2VjdGlvbnMucHVzaChcIiMjIFByaW9yIEtub3dsZWRnZVwiKTtcbiAgaWYgKGJyaWVmLmtub3dsZWRnZSA9PT0gXCJObyBwcmlvciBrbm93bGVkZ2UgcmVjb3JkZWQuXCIpIHtcbiAgICBzZWN0aW9ucy5wdXNoKGJyaWVmLmtub3dsZWRnZSk7XG4gIH0gZWxzZSB7XG4gICAgc2VjdGlvbnMucHVzaCh0cnVuY2F0ZVNlY3Rpb24oYnJpZWYua25vd2xlZGdlLCBNQVhfU0VDVElPTl9DSEFSUykpO1xuICB9XG4gIHNlY3Rpb25zLnB1c2goXCJcIik7XG5cbiAgLy8gU3VtbWFyaWVzIHNlY3Rpb25cbiAgc2VjdGlvbnMucHVzaChcIiMjIFByaW9yIE1pbGVzdG9uZSBTdW1tYXJpZXNcIik7XG4gIGlmIChicmllZi5zdW1tYXJpZXMgPT09IFwiTm8gcHJpb3IgbWlsZXN0b25lIHN1bW1hcmllcy5cIikge1xuICAgIHNlY3Rpb25zLnB1c2goYnJpZWYuc3VtbWFyaWVzKTtcbiAgfSBlbHNlIHtcbiAgICBzZWN0aW9ucy5wdXNoKHRydW5jYXRlU2VjdGlvbihicmllZi5zdW1tYXJpZXMsIE1BWF9TRUNUSU9OX0NIQVJTKSk7XG4gIH1cblxuICBsZXQgcmVzdWx0ID0gc2VjdGlvbnMuam9pbihcIlxcblwiKTtcblxuICAvLyBGaW5hbCB0cnVuY2F0aW9uIGlmIHRvdGFsIGV4Y2VlZHMgbWF4XG4gIGlmIChyZXN1bHQubGVuZ3RoID4gTUFYX1BSSU9SX0NPTlRFWFRfQ0hBUlMpIHtcbiAgICByZXN1bHQgPSB0cnVuY2F0ZVNlY3Rpb24ocmVzdWx0LCBNQVhfUFJJT1JfQ09OVEVYVF9DSEFSUyk7XG4gIH1cblxuICByZXR1cm4gcmVzdWx0O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRWNvc3lzdGVtIFJlc2VhcmNoIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKiogTWF4aW11bSBjaGFyYWN0ZXJzIGZvciB0aGUgZWNvc3lzdGVtIGJyaWVmLiAqL1xuY29uc3QgTUFYX0VDT1NZU1RFTV9CUklFRl9DSEFSUyA9IDQwMDA7XG5cbi8qKlxuICogUmVzZWFyY2ggdGhlIGVjb3N5c3RlbSBmb3IgYmVzdCBwcmFjdGljZXMgYW5kIGtub3duIGlzc3Vlcy5cbiAqXG4gKiBFY29zeXN0ZW0gcmVzZWFyY2ggaXMgbm93IHBlcmZvcm1lZCBkdXJpbmcgdGhlIGRpc2N1c3Npb24gc2Vzc2lvbiAoYmV0d2VlblxuICogTGF5ZXIgMSBhbmQgTGF5ZXIgMikgdXNpbmcgd2hhdGV2ZXIgd2ViIHNlYXJjaCB0b29scyBhcmUgYXZhaWxhYmxlIHRvIHRoZVxuICogTExNIFx1MjAxNCBuYXRpdmUgQW50aHJvcGljIHdlYiBzZWFyY2ggZm9yIENsYXVkZSwgc2VhcmNoLXRoZS13ZWIgZm9yIG90aGVyXG4gKiBwcm92aWRlcnMuIFRoZSBwcmVwYXJhdGlvbiBwaGFzZSBmb2N1c2VzIG9uIG1lY2hhbmljYWwgd29yayBvbmx5LlxuICpcbiAqIEBwYXJhbSBfdGVjaFN0YWNrIC0gQXJyYXkgb2YgdGVjaG5vbG9neSBuYW1lcyBmcm9tIGNvZGViYXNlIGFuYWx5c2lzICh1bnVzZWQpXG4gKiBAcGFyYW0gX2Jhc2VQYXRoIC0gUm9vdCBkaXJlY3Rvcnkgb2YgdGhlIHByb2plY3QgKHVudXNlZClcbiAqIEByZXR1cm5zIEVjb3N5c3RlbUJyaWVmIGluZGljYXRpbmcgcmVzZWFyY2ggaGFwcGVucyBkdXJpbmcgZGlzY3Vzc2lvblxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVzZWFyY2hFY29zeXN0ZW0oXG4gIF90ZWNoU3RhY2s6IHN0cmluZ1tdLFxuICBfYmFzZVBhdGg6IHN0cmluZyxcbik6IFByb21pc2U8RWNvc3lzdGVtQnJpZWY+IHtcbiAgcmV0dXJuIHtcbiAgICBhdmFpbGFibGU6IGZhbHNlLFxuICAgIHF1ZXJpZXM6IFtdLFxuICAgIGZpbmRpbmdzOiBbXSxcbiAgICBza2lwcGVkUmVhc29uOiBcIkVjb3N5c3RlbSByZXNlYXJjaCBpcyBwZXJmb3JtZWQgZHVyaW5nIHRoZSBkaXNjdXNzaW9uIHVzaW5nIHdlYiBzZWFyY2ggdG9vbHMsIG5vdCBkdXJpbmcgcHJlcGFyYXRpb24uXCIsXG4gIH07XG59XG5cbi8qKlxuICogRm9ybWF0IGFuIEVjb3N5c3RlbUJyaWVmIGFzIExMTS1yZWFkYWJsZSBtYXJrZG93bi5cbiAqXG4gKiBAcGFyYW0gYnJpZWYgLSBUaGUgZWNvc3lzdGVtIGJyaWVmIHRvIGZvcm1hdFxuICogQHJldHVybnMgTWFya2Rvd24gc3RyaW5nIGNhcHBlZCBhdCBNQVhfRUNPU1lTVEVNX0JSSUVGX0NIQVJTXG4gKi9cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBQcmVwYXJhdGlvbiBSZXN1bHQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogQ29tYmluZWQgcmVzdWx0IGZyb20gdGhlIHByZXBhcmF0aW9uIHBoYXNlLlxuICogSW5jbHVkZXMgYnJpZWZzIGZyb20gYWxsIHRocmVlIGFuYWx5emVycywgcGx1cyBtZXRhZGF0YSBhYm91dCB0aGUgcnVuLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIFByZXBhcmF0aW9uUmVzdWx0IHtcbiAgLyoqIENvZGViYXNlIGFuYWx5c2lzIGJyaWVmLiAqL1xuICBjb2RlYmFzZTogQ29kZWJhc2VCcmllZjtcbiAgLyoqIEZvcm1hdHRlZCBjb2RlYmFzZSBicmllZiBhcyBtYXJrZG93bi4gKi9cbiAgY29kZWJhc2VCcmllZjogc3RyaW5nO1xuICAvKiogUHJpb3IgY29udGV4dCBicmllZi4gKi9cbiAgcHJpb3JDb250ZXh0OiBQcmlvckNvbnRleHRCcmllZjtcbiAgLyoqIEZvcm1hdHRlZCBwcmlvciBjb250ZXh0IGJyaWVmIGFzIG1hcmtkb3duLiAqL1xuICBwcmlvckNvbnRleHRCcmllZjogc3RyaW5nO1xuICAvKiogRWNvc3lzdGVtIHJlc2VhcmNoIGJyaWVmLiAqL1xuICBlY29zeXN0ZW06IEVjb3N5c3RlbUJyaWVmO1xuICAvKiogRm9ybWF0dGVkIGVjb3N5c3RlbSBicmllZiBhcyBtYXJrZG93bi4gKi9cbiAgZWNvc3lzdGVtQnJpZWY6IHN0cmluZztcbiAgLyoqIFdoZXRoZXIgcHJlcGFyYXRpb24gd2FzIGVuYWJsZWQuICovXG4gIGVuYWJsZWQ6IGJvb2xlYW47XG4gIC8qKiBXaGV0aGVyIGVjb3N5c3RlbSByZXNlYXJjaCB3YXMgcGVyZm9ybWVkLiAqL1xuICBlY29zeXN0ZW1SZXNlYXJjaFBlcmZvcm1lZDogYm9vbGVhbjtcbiAgLyoqIFRvdGFsIGR1cmF0aW9uIG9mIHByZXBhcmF0aW9uIGluIG1pbGxpc2Vjb25kcy4gKi9cbiAgZHVyYXRpb25NczogbnVtYmVyO1xufVxuXG4vKipcbiAqIE1pbmltYWwgVUkgY29udGV4dCBpbnRlcmZhY2UgZm9yIHByZXBhcmF0aW9uIHBoYXNlLlxuICogTWlycm9ycyB0aGUgbm90aWZ5IG1ldGhvZCBmcm9tIEV4dGVuc2lvblVJQ29udGV4dC5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBQcmVwYXJhdGlvblVJQ29udGV4dCB7XG4gIG5vdGlmeShtZXNzYWdlOiBzdHJpbmcsIHR5cGU/OiBcImluZm9cIiB8IFwid2FybmluZ1wiIHwgXCJlcnJvclwiIHwgXCJzdWNjZXNzXCIpOiB2b2lkO1xufVxuXG4vKipcbiAqIE1pbmltYWwgcHJlZmVyZW5jZXMgaW50ZXJmYWNlIGZvciBwcmVwYXJhdGlvbiBwaGFzZS5cbiAqIE9ubHkgaW5jbHVkZXMgdGhlIHByZWZlcmVuY2VzIG5lZWRlZCBieSBydW5QcmVwYXJhdGlvbi5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBQcmVwYXJhdGlvblByZWZlcmVuY2VzIHtcbiAgLyoqIEVuYWJsZSB0aGUgcHJlcGFyYXRpb24gcGhhc2UuIERlZmF1bHQ6IHRydWUuICovXG4gIGRpc2N1c3NfcHJlcGFyYXRpb24/OiBib29sZWFuO1xuICAvKiogRW5hYmxlIHdlYiByZXNlYXJjaCBkdXJpbmcgcHJlcGFyYXRpb24uIERlZmF1bHQ6IHRydWUuICovXG4gIGRpc2N1c3Nfd2ViX3Jlc2VhcmNoPzogYm9vbGVhbjtcbiAgLyoqIERlcHRoIG9mIGFuYWx5c2lzLiBEZWZhdWx0OiBcInN0YW5kYXJkXCIuICovXG4gIGRpc2N1c3NfZGVwdGg/OiBcInF1aWNrXCIgfCBcInN0YW5kYXJkXCIgfCBcInRob3JvdWdoXCI7XG59XG5cbi8qKlxuICogUnVuIHRoZSBwcmVwYXJhdGlvbiBwaGFzZSBiZWZvcmUgYSBkaXNjdXNzaW9uIHNlc3Npb24uXG4gKlxuICogT3JjaGVzdHJhdGVzIGFsbCB0aHJlZSBhbmFseXplcnMgKGNvZGViYXNlLCBwcmlvciBjb250ZXh0LCBlY29zeXN0ZW0pXG4gKiB3aXRoIFRVSSBwcm9ncmVzcyB1cGRhdGVzLiBSZXR1cm5zIGVhcmx5IGlmIHByZXBhcmF0aW9uIGlzIGRpc2FibGVkLlxuICpcbiAqIEBwYXJhbSBiYXNlUGF0aCAtIFJvb3QgZGlyZWN0b3J5IG9mIHRoZSBwcm9qZWN0XG4gKiBAcGFyYW0gdWkgLSBVSSBjb250ZXh0IGZvciBwcm9ncmVzcyBub3RpZmljYXRpb25zIChudWxsID0gc2lsZW50IG1vZGUpXG4gKiBAcGFyYW0gcHJlZnMgLSBQcmVmZXJlbmNlcyBjb250cm9sbGluZyBwcmVwYXJhdGlvbiBiZWhhdmlvclxuICogQHJldHVybnMgUHJlcGFyYXRpb25SZXN1bHQgd2l0aCBhbGwgYnJpZWZzIGFuZCBtZXRhZGF0YVxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuUHJlcGFyYXRpb24oXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIHVpOiBQcmVwYXJhdGlvblVJQ29udGV4dCB8IG51bGwsXG4gIHByZWZzOiBQcmVwYXJhdGlvblByZWZlcmVuY2VzLFxuKTogUHJvbWlzZTxQcmVwYXJhdGlvblJlc3VsdD4ge1xuICBjb25zdCBzdGFydFRpbWUgPSBwZXJmb3JtYW5jZS5ub3coKTtcblxuICAvLyBDaGVjayBpZiBwcmVwYXJhdGlvbiBpcyBkaXNhYmxlZFxuICBjb25zdCBwcmVwYXJhdGlvbkVuYWJsZWQgPSBwcmVmcy5kaXNjdXNzX3ByZXBhcmF0aW9uICE9PSBmYWxzZTsgLy8gRGVmYXVsdDogdHJ1ZVxuXG4gIGlmICghcHJlcGFyYXRpb25FbmFibGVkKSB7XG4gICAgLy8gUmV0dXJuIG1pbmltYWwgcmVzdWx0IHdpdGggZW1wdHkgYnJpZWZzXG4gICAgY29uc3QgZW1wdHlDb2RlYmFzZTogQ29kZWJhc2VCcmllZiA9IHtcbiAgICAgIHRlY2hTdGFjazoge1xuICAgICAgICBwcmltYXJ5TGFuZ3VhZ2U6IHVuZGVmaW5lZCxcbiAgICAgICAgZGV0ZWN0ZWRGaWxlczogW10sXG4gICAgICAgIHBhY2thZ2VNYW5hZ2VyOiB1bmRlZmluZWQsXG4gICAgICAgIGlzTW9ub3JlcG86IGZhbHNlLFxuICAgICAgICBoYXNUZXN0czogZmFsc2UsXG4gICAgICAgIGhhc0NJOiBmYWxzZSxcbiAgICAgIH0sXG4gICAgICBtb2R1bGVTdHJ1Y3R1cmU6IHtcbiAgICAgICAgdG9wTGV2ZWxEaXJzOiBbXSxcbiAgICAgICAgc3JjU3ViZGlyczogW10sXG4gICAgICAgIHRvdGFsRmlsZXNTYW1wbGVkOiAwLFxuICAgICAgfSxcbiAgICAgIHBhdHRlcm5zOiB7XG4gICAgICAgIGFzeW5jU3R5bGU6IFwidW5rbm93blwiLFxuICAgICAgICBlcnJvckhhbmRsaW5nOiBcInVua25vd25cIixcbiAgICAgICAgbmFtaW5nQ29udmVudGlvbjogXCJ1bmtub3duXCIsXG4gICAgICAgIGV2aWRlbmNlOiB7XG4gICAgICAgICAgYXN5bmNTdHlsZTogW10sXG4gICAgICAgICAgZXJyb3JIYW5kbGluZzogW10sXG4gICAgICAgICAgbmFtaW5nQ29udmVudGlvbjogW10sXG4gICAgICAgIH0sXG4gICAgICAgIGZpbGVDb3VudHM6IHtcbiAgICAgICAgICBhc3luY0F3YWl0OiAwLFxuICAgICAgICAgIHByb21pc2VzOiAwLFxuICAgICAgICAgIGNhbGxiYWNrczogMCxcbiAgICAgICAgICB0cnlDYXRjaDogMCxcbiAgICAgICAgICBlcnJvckNhbGxiYWNrczogMCxcbiAgICAgICAgICByZXN1bHRUeXBlczogMCxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgICBzYW1wbGVkRmlsZXM6IFtdLFxuICAgIH07XG5cbiAgICBjb25zdCBlbXB0eVByaW9yQ29udGV4dDogUHJpb3JDb250ZXh0QnJpZWYgPSB7XG4gICAgICBkZWNpc2lvbnM6IHtcbiAgICAgICAgYnlTY29wZTogbmV3IE1hcCgpLFxuICAgICAgICB0b3RhbENvdW50OiAwLFxuICAgICAgfSxcbiAgICAgIHJlcXVpcmVtZW50czoge1xuICAgICAgICBhY3RpdmU6IFtdLFxuICAgICAgICB2YWxpZGF0ZWQ6IFtdLFxuICAgICAgICBkZWZlcnJlZDogW10sXG4gICAgICAgIHRvdGFsQ291bnQ6IDAsXG4gICAgICB9LFxuICAgICAga25vd2xlZGdlOiBcIk5vIHByaW9yIGtub3dsZWRnZSByZWNvcmRlZC5cIixcbiAgICAgIHN1bW1hcmllczogXCJObyBwcmlvciBtaWxlc3RvbmUgc3VtbWFyaWVzLlwiLFxuICAgIH07XG5cbiAgICBjb25zdCBlbXB0eUVjb3N5c3RlbTogRWNvc3lzdGVtQnJpZWYgPSB7XG4gICAgICBhdmFpbGFibGU6IGZhbHNlLFxuICAgICAgcXVlcmllczogW10sXG4gICAgICBmaW5kaW5nczogW10sXG4gICAgICBza2lwcGVkUmVhc29uOiBcIlByZXBhcmF0aW9uIHBoYXNlIGRpc2FibGVkLlwiLFxuICAgIH07XG5cbiAgICByZXR1cm4ge1xuICAgICAgY29kZWJhc2U6IGVtcHR5Q29kZWJhc2UsXG4gICAgICBjb2RlYmFzZUJyaWVmOiBcIlwiLFxuICAgICAgcHJpb3JDb250ZXh0OiBlbXB0eVByaW9yQ29udGV4dCxcbiAgICAgIHByaW9yQ29udGV4dEJyaWVmOiBcIlwiLFxuICAgICAgZWNvc3lzdGVtOiBlbXB0eUVjb3N5c3RlbSxcbiAgICAgIGVjb3N5c3RlbUJyaWVmOiBcIlwiLFxuICAgICAgZW5hYmxlZDogZmFsc2UsXG4gICAgICBlY29zeXN0ZW1SZXNlYXJjaFBlcmZvcm1lZDogZmFsc2UsXG4gICAgICBkdXJhdGlvbk1zOiBwZXJmb3JtYW5jZS5ub3coKSAtIHN0YXJ0VGltZSxcbiAgICB9O1xuICB9XG5cbiAgLy8gLS0tIFBoYXNlIDE6IEFuYWx5emUgY29kZWJhc2UgLS0tXG4gIHVpPy5ub3RpZnkoXCJBbmFseXppbmcgY29kZWJhc2UuLi5cIiwgXCJpbmZvXCIpO1xuICBjb25zdCBjb2RlYmFzZSA9IGF3YWl0IGFuYWx5emVDb2RlYmFzZShiYXNlUGF0aCk7XG4gIGNvbnN0IGNvZGViYXNlQnJpZWYgPSBmb3JtYXRDb2RlYmFzZUJyaWVmKGNvZGViYXNlKTtcbiAgdWk/Lm5vdGlmeShcIlx1MjcxMyBBbmFseXplZCBjb2RlYmFzZVwiLCBcInN1Y2Nlc3NcIik7XG5cbiAgLy8gLS0tIFBoYXNlIDI6IFJldmlldyBwcmlvciBjb250ZXh0IC0tLVxuICB1aT8ubm90aWZ5KFwiUmV2aWV3aW5nIHByaW9yIGNvbnRleHQuLi5cIiwgXCJpbmZvXCIpO1xuICBjb25zdCBwcmlvckNvbnRleHQgPSBhd2FpdCBhZ2dyZWdhdGVQcmlvckNvbnRleHQoYmFzZVBhdGgpO1xuICBjb25zdCBwcmlvckNvbnRleHRCcmllZiA9IGZvcm1hdFByaW9yQ29udGV4dEJyaWVmKHByaW9yQ29udGV4dCk7XG4gIHVpPy5ub3RpZnkoXCJcdTI3MTMgUmV2aWV3ZWQgcHJpb3IgY29udGV4dFwiLCBcInN1Y2Nlc3NcIik7XG5cbiAgLy8gLS0tIEVjb3N5c3RlbSByZXNlYXJjaCAtLS1cbiAgLy8gRWNvc3lzdGVtIHJlc2VhcmNoIGlzIG5vdyBwZXJmb3JtZWQgZHVyaW5nIHRoZSBkaXNjdXNzaW9uIHNlc3Npb24gKGJldHdlZW5cbiAgLy8gTGF5ZXIgMSBhbmQgTGF5ZXIgMikgdXNpbmcgYXZhaWxhYmxlIHdlYiBzZWFyY2ggdG9vbHMuIFRoZSBwcmVwYXJhdGlvblxuICAvLyBwaGFzZSBmb2N1c2VzIG9uIG1lY2hhbmljYWwgd29yayBvbmx5LlxuICBjb25zdCBlY29zeXN0ZW06IEVjb3N5c3RlbUJyaWVmID0gYXdhaXQgcmVzZWFyY2hFY29zeXN0ZW0oW10sIGJhc2VQYXRoKTtcbiAgY29uc3QgZWNvc3lzdGVtQnJpZWYgPSBmb3JtYXRFY29zeXN0ZW1CcmllZihlY29zeXN0ZW0pO1xuXG4gIHJldHVybiB7XG4gICAgY29kZWJhc2UsXG4gICAgY29kZWJhc2VCcmllZixcbiAgICBwcmlvckNvbnRleHQsXG4gICAgcHJpb3JDb250ZXh0QnJpZWYsXG4gICAgZWNvc3lzdGVtLFxuICAgIGVjb3N5c3RlbUJyaWVmLFxuICAgIGVuYWJsZWQ6IHRydWUsXG4gICAgZWNvc3lzdGVtUmVzZWFyY2hQZXJmb3JtZWQ6IGZhbHNlLFxuICAgIGR1cmF0aW9uTXM6IHBlcmZvcm1hbmNlLm5vdygpIC0gc3RhcnRUaW1lLFxuICB9O1xufVxuXG4vKipcbiAqIEZvcm1hdCBhbiBFY29zeXN0ZW1CcmllZiBhcyBMTE0tcmVhZGFibGUgbWFya2Rvd24uXG4gKlxuICogU2luY2UgZWNvc3lzdGVtIHJlc2VhcmNoIG5vdyBhbHdheXMgcmV0dXJucyB1bmF2YWlsYWJsZSBmcm9tIHRoZSBwcmVwYXJhdGlvblxuICogcGhhc2UgKHJlc2VhcmNoIGhhcHBlbnMgZHVyaW5nIGRpc2N1c3Npb24gdXNpbmcgd2ViIHNlYXJjaCB0b29scyksIHRoaXNcbiAqIGZ1bmN0aW9uIHJldHVybnMgYSBzaW1wbGUgZml4ZWQgbWVzc2FnZS5cbiAqXG4gKiBAcGFyYW0gX2JyaWVmIC0gVGhlIGVjb3N5c3RlbSBicmllZiAodW51c2VkLCBhbHdheXMgdW5hdmFpbGFibGUgZnJvbSBwcmVwYXJhdGlvbilcbiAqIEByZXR1cm5zIE1hcmtkb3duIHN0cmluZyBkaXJlY3RpbmcgdGhlIExMTSB0byBwZXJmb3JtIHJlc2VhcmNoIGR1cmluZyBkaXNjdXNzaW9uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXRFY29zeXN0ZW1CcmllZihfYnJpZWY6IEVjb3N5c3RlbUJyaWVmKTogc3RyaW5nIHtcbiAgcmV0dXJuIFwiIyMgRWNvc3lzdGVtIFJlc2VhcmNoXFxuXFxuRWNvc3lzdGVtIHJlc2VhcmNoIGlzIHBlcmZvcm1lZCBkdXJpbmcgdGhlIGRpc2N1c3Npb24gdXNpbmcgd2ViIHNlYXJjaCB0b29scy5cIjtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQVNBLFNBQVMsYUFBcUMsVUFBVSxVQUFVLGlCQUFpQjtBQUNuRixTQUFTLFlBQXNCO0FBQy9CLFNBQVMsZUFBZSx1QkFBdUI7QUFDL0M7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLE9BR0s7QUFDUCxTQUFTLGdCQUFnQjtBQWlKekIsTUFBTSwyQkFBMkI7QUFHakMsTUFBTSxvQkFBb0I7QUFHMUIsTUFBTSx3QkFBd0I7QUFHOUIsTUFBTSxZQUFZLG9CQUFJLElBQUk7QUFBQSxFQUN4QjtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUNGLENBQUM7QUFHRCxNQUFNLG1CQUFtQjtBQUFBLEVBQ3ZCO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUNGO0FBR0EsTUFBTSxvQkFBb0IsQ0FBQyxPQUFPLFFBQVEsT0FBTyxRQUFRLFFBQVEsTUFBTTtBQUl2RSxNQUFNLDhCQUE4QjtBQUFBO0FBQUEsRUFFbEM7QUFBQSxFQUFPO0FBQUEsRUFBUTtBQUFBLEVBQU87QUFBQSxFQUFRO0FBQUEsRUFBUTtBQUFBO0FBQUEsRUFFdEM7QUFBQSxFQUFPO0FBQUEsRUFBUTtBQUFBO0FB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
