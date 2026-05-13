import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gsdRoot } from "./paths.js";
import { parse as parseYaml } from "yaml";
import { normalizeStringArray } from "../shared/format-utils.js";
import { logWarning } from "./workflow-logger.js";
import { resolveProfileDefaults as _resolveProfileDefaults } from "./preferences-models.js";
import { nativeHasCommittedHead, nativeIsRepo } from "./native-git-bridge.js";
import {
  KNOWN_PREFERENCE_KEYS,
  MODE_DEFAULTS,
  formatSkillRef
} from "./preferences-types.js";
import { validatePreferences } from "./preferences-validation.js";
import { gsdHome } from "./gsd-home.js";
import { validatePreferences as validatePreferences2 } from "./preferences-validation.js";
import { resolveAllSkillReferences } from "./preferences-skills.js";
function resolveSkillDiscoveryMode(basePath) {
  const prefs = loadEffectiveGSDPreferences(basePath);
  return prefs?.preferences.skill_discovery ?? "suggest";
}
function resolveSkillStalenessDays(basePath) {
  const prefs = loadEffectiveGSDPreferences(basePath);
  return prefs?.preferences.skill_staleness_days ?? 60;
}
import {
  resolveModelForUnit,
  resolveModelWithFallbacksForUnit,
  getNextFallbackModel,
  isTransientNetworkError,
  validateModelId,
  updatePreferencesModels,
  resolveDynamicRoutingConfig,
  resolveAutoSupervisorConfig,
  resolveProfileDefaults,
  getProfileTierMap,
  resolveEffectiveProfile,
  resolveInlineLevel,
  resolveContextSelection,
  resolveSearchProviderFromPreferences,
  resolveDisabledModelProvidersFromPreferences
} from "./preferences-models.js";
import { resolveModelMcpConfig } from "./preferences-mcp.js";
function globalPreferencesPath() {
  return join(gsdHome(), "PREFERENCES.md");
}
function legacyGlobalPreferencesPath() {
  return join(homedir(), ".pi", "agent", "gsd-preferences.md");
}
function projectPreferencesPath(basePath = process.cwd()) {
  return join(gsdRoot(basePath), "PREFERENCES.md");
}
function legacyGlobalPreferencesPathLowercase() {
  return join(gsdHome(), "preferences.md");
}
function legacyProjectPreferencesPathLowercase(basePath = process.cwd()) {
  return join(gsdRoot(basePath), "preferences.md");
}
function getGlobalGSDPreferencesPath() {
  return globalPreferencesPath();
}
function getLegacyGlobalGSDPreferencesPath() {
  return legacyGlobalPreferencesPath();
}
function getProjectGSDPreferencesPath(basePath) {
  return projectPreferencesPath(basePath);
}
function loadGlobalGSDPreferences() {
  return loadPreferencesFile(globalPreferencesPath(), "global") ?? loadPreferencesFile(legacyGlobalPreferencesPathLowercase(), "global") ?? loadPreferencesFile(legacyGlobalPreferencesPath(), "global");
}
function loadProjectGSDPreferences(basePath) {
  return loadPreferencesFile(projectPreferencesPath(basePath), "project") ?? loadPreferencesFile(legacyProjectPreferencesPathLowercase(basePath), "project");
}
function loadEffectiveGSDPreferences(basePath, opts) {
  const globalPreferences = loadGlobalGSDPreferences();
  const projectPreferences = loadProjectGSDPreferences(basePath);
  const projectHasPlanningDepth = projectPreferences?.preferences.planning_depth !== void 0;
  if (!globalPreferences && !projectPreferences) return null;
  let result;
  if (!globalPreferences) {
    result = projectPreferences;
  } else if (!projectPreferences) {
    result = globalPreferences;
  } else {
    const mergedWarnings = [
      ...globalPreferences.warnings ?? [],
      ...projectPreferences.warnings ?? []
    ];
    result = {
      path: projectPreferences.path,
      scope: "project",
      preferences: mergePreferences(globalPreferences.preferences, projectPreferences.preferences),
      ...mergedWarnings.length > 0 ? { warnings: mergedWarnings } : {}
    };
  }
  const profile = result.preferences.token_profile;
  if (profile) {
    const profileDefaults = _resolveProfileDefaults(
      profile,
      opts?.availableModelIds,
      result.preferences.dynamic_routing
    );
    result = {
      ...result,
      preferences: mergePreferences(profileDefaults, result.preferences)
    };
  }
  if (result.preferences.mode) {
    result = {
      ...result,
      preferences: applyModeDefaults(result.preferences.mode, result.preferences)
    };
  }
  result = stripInheritedPlanningDepth(result, projectHasPlanningDepth);
  return result;
}
function stripInheritedPlanningDepth(loaded, projectHasPlanningDepth) {
  if (projectHasPlanningDepth || loaded.preferences.planning_depth === void 0) {
    return loaded;
  }
  const preferences = { ...loaded.preferences };
  delete preferences.planning_depth;
  return { ...loaded, preferences };
}
function loadPreferencesFile(path, scope) {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  const preferences = parsePreferencesMarkdown(raw);
  if (!preferences) return null;
  const validation = validatePreferences(preferences);
  const allWarnings = [...validation.warnings, ...validation.errors];
  return {
    path,
    scope,
    preferences: validation.preferences,
    ...allWarnings.length > 0 ? { warnings: allWarnings } : {}
  };
}
let _warnedUnrecognizedFormat = false;
let _warnedSectionParse = false;
function _resetParseWarningFlag() {
  _warnedUnrecognizedFormat = false;
  _warnedFrontmatterParse = false;
  _warnedSectionParse = false;
}
function parsePreferencesMarkdown(content) {
  const startMarker = content.startsWith("---\r\n") ? "---\r\n" : "---\n";
  if (content.startsWith(startMarker)) {
    const searchStart = startMarker.length;
    const endIdx = content.indexOf("\n---", searchStart);
    if (endIdx === -1) return null;
    const block = content.slice(searchStart, endIdx);
    return parseFrontmatterBlock(block.replace(/\r/g, ""));
  }
  if (/^##\s+\w/m.test(content)) {
    return parseHeadingListFormat(content);
  }
  if (content.trim().length > 0 && !_warnedUnrecognizedFormat) {
    _warnedUnrecognizedFormat = true;
    console.warn(
      "[GSD] Warning: preferences file has unrecognized format \u2014 content does not use YAML frontmatter delimiters (---). Wrap your preferences in --- fences. See https://github.com/gsd-build/gsd-2/issues/2036"
    );
  }
  return null;
}
let _warnedFrontmatterParse = false;
function parseFrontmatterBlock(frontmatter) {
  try {
    const parsed = parseYaml(frontmatter);
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }
    return parsed;
  } catch (e) {
    if (!_warnedFrontmatterParse) {
      _warnedFrontmatterParse = true;
      logWarning("guided", `YAML parse error in preferences frontmatter (suppressing further): ${e.message}`);
    }
    return {};
  }
}
function parseHeadingListFormat(content) {
  const result = {};
  let currentSection = null;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const headingMatch = line.match(/^##\s+(.+)$/);
    if (headingMatch) {
      currentSection = headingMatch[1].trim().toLowerCase().replace(/\s+/g, "_");
      if (!result[currentSection]) result[currentSection] = [];
      continue;
    }
    if (currentSection && line.trim() && !line.trimStart().startsWith("#")) {
      result[currentSection].push(line);
    }
  }
  const typed = {};
  for (const [section, lines] of Object.entries(result)) {
    if (lines.length === 0) continue;
    const usesLegacyListItems = lines.every((line) => /^\s*-\s+[^:]+:\s*.*$/.test(line));
    const yamlBlock = usesLegacyListItems ? lines.map((line) => line.replace(/^\s*-\s+/, "")).join("\n") : lines.join("\n");
    try {
      const parsed = parseYaml(yamlBlock);
      if (typeof parsed !== "object" || parsed === null) continue;
      let targetSection = section;
      let value = parsed;
      if (!Array.isArray(parsed)) {
        const keys = Object.keys(parsed);
        if (keys.length === 1) {
          const [onlyKey] = keys;
          if (onlyKey === section || !KNOWN_PREFERENCE_KEYS.has(section) && KNOWN_PREFERENCE_KEYS.has(onlyKey)) {
            targetSection = onlyKey;
            value = parsed[onlyKey];
          }
        }
      }
      typed[targetSection] = value;
    } catch (e) {
      if (!_warnedSectionParse) {
        _warnedSectionParse = true;
        logWarning("guided", `preferences section parse failed: ${e.message}`);
      }
    }
  }
  return typed;
}
function applyModeDefaults(mode, prefs) {
  const defaults = MODE_DEFAULTS[mode];
  if (!defaults) return prefs;
  return mergePreferences(defaults, prefs);
}
function mergePreferences(base, override) {
  return {
    version: override.version ?? base.version,
    mode: override.mode ?? base.mode,
    always_use_skills: mergeStringLists(base.always_use_skills, override.always_use_skills),
    prefer_skills: mergeStringLists(base.prefer_skills, override.prefer_skills),
    avoid_skills: mergeStringLists(base.avoid_skills, override.avoid_skills),
    skill_rules: [...base.skill_rules ?? [], ...override.skill_rules ?? []],
    custom_instructions: mergeStringLists(base.custom_instructions, override.custom_instructions),
    models: { ...base.models ?? {}, ...override.models ?? {} },
    skill_discovery: override.skill_discovery ?? base.skill_discovery,
    skill_staleness_days: override.skill_staleness_days ?? base.skill_staleness_days,
    auto_supervisor: { ...base.auto_supervisor ?? {}, ...override.auto_supervisor ?? {} },
    uat_dispatch: override.uat_dispatch ?? base.uat_dispatch,
    unique_milestone_ids: override.unique_milestone_ids ?? base.unique_milestone_ids,
    budget_ceiling: override.budget_ceiling ?? base.budget_ceiling,
    budget_enforcement: override.budget_enforcement ?? base.budget_enforcement,
    context_pause_threshold: override.context_pause_threshold ?? base.context_pause_threshold,
    notifications: base.notifications || override.notifications ? { ...base.notifications ?? {}, ...override.notifications ?? {} } : void 0,
    cmux: base.cmux || override.cmux ? { ...base.cmux ?? {}, ...override.cmux ?? {} } : void 0,
    remote_questions: override.remote_questions ? { ...base.remote_questions ?? {}, ...override.remote_questions } : base.remote_questions,
    git: base.git || override.git ? { ...base.git ?? {}, ...override.git ?? {} } : void 0,
    post_unit_hooks: mergePostUnitHooks(base.post_unit_hooks, override.post_unit_hooks),
    pre_dispatch_hooks: mergePreDispatchHooks(base.pre_dispatch_hooks, override.pre_dispatch_hooks),
    dynamic_routing: base.dynamic_routing || override.dynamic_routing ? { ...base.dynamic_routing ?? {}, ...override.dynamic_routing ?? {} } : void 0,
    disabled_model_providers: mergeStringLists(
      base.disabled_model_providers,
      override.disabled_model_providers
    ),
    uok: base.uok || override.uok ? {
      enabled: override.uok?.enabled ?? base.uok?.enabled,
      legacy_fallback: base.uok?.legacy_fallback || override.uok?.legacy_fallback ? { ...base.uok?.legacy_fallback ?? {}, ...override.uok?.legacy_fallback ?? {} } : void 0,
      gates: base.uok?.gates || override.uok?.gates ? { ...base.uok?.gates ?? {}, ...override.uok?.gates ?? {} } : void 0,
      model_policy: base.uok?.model_policy || override.uok?.model_policy ? { ...base.uok?.model_policy ?? {}, ...override.uok?.model_policy ?? {} } : void 0,
      execution_graph: base.uok?.execution_graph || override.uok?.execution_graph ? { ...base.uok?.execution_graph ?? {}, ...override.uok?.execution_graph ?? {} } : void 0,
      gitops: base.uok?.gitops || override.uok?.gitops ? { ...base.uok?.gitops ?? {}, ...override.uok?.gitops ?? {} } : void 0,
      audit_unified: base.uok?.audit_unified || override.uok?.audit_unified ? { ...base.uok?.audit_unified ?? {}, ...override.uok?.audit_unified ?? {} } : void 0,
      plan_v2: base.uok?.plan_v2 || override.uok?.plan_v2 ? { ...base.uok?.plan_v2 ?? {}, ...override.uok?.plan_v2 ?? {} } : void 0
    } : void 0,
    token_profile: override.token_profile ?? base.token_profile,
    phases: base.phases || override.phases ? { ...base.phases ?? {}, ...override.phases ?? {} } : void 0,
    parallel: base.parallel || override.parallel ? { ...base.parallel ?? {}, ...override.parallel ?? {} } : void 0,
    verification_commands: mergeStringLists(base.verification_commands, override.verification_commands),
    verification_auto_fix: override.verification_auto_fix ?? base.verification_auto_fix,
    verification_max_retries: override.verification_max_retries ?? base.verification_max_retries,
    enhanced_verification: override.enhanced_verification ?? base.enhanced_verification,
    enhanced_verification_pre: override.enhanced_verification_pre ?? base.enhanced_verification_pre,
    enhanced_verification_post: override.enhanced_verification_post ?? base.enhanced_verification_post,
    enhanced_verification_strict: override.enhanced_verification_strict ?? base.enhanced_verification_strict,
    search_provider: override.search_provider ?? base.search_provider,
    context_selection: override.context_selection ?? base.context_selection,
    auto_visualize: override.auto_visualize ?? base.auto_visualize,
    auto_report: override.auto_report ?? base.auto_report,
    github: base.github || override.github ? { ...base.github ?? {}, ...override.github ?? {} } : void 0,
    experimental: base.experimental || override.experimental ? { ...base.experimental ?? {}, ...override.experimental ?? {} } : void 0,
    service_tier: override.service_tier ?? base.service_tier,
    forensics_dedup: override.forensics_dedup ?? base.forensics_dedup,
    show_token_cost: override.show_token_cost ?? base.show_token_cost,
    min_request_interval_ms: override.min_request_interval_ms ?? base.min_request_interval_ms,
    codebase: base.codebase || override.codebase ? {
      ...base.codebase ?? {},
      ...override.codebase ?? {},
      // Merge exclude_patterns arrays rather than overriding
      exclude_patterns: [
        ...base.codebase?.exclude_patterns ?? [],
        ...override.codebase?.exclude_patterns ?? []
      ].filter(Boolean)
    } : void 0,
    slice_parallel: base.slice_parallel || override.slice_parallel ? { ...base.slice_parallel ?? {}, ...override.slice_parallel ?? {} } : void 0,
    language: override.language ?? base.language,
    planning_depth: override.planning_depth ?? base.planning_depth
  };
}
function mergeStringLists(base, override) {
  const merged = [
    ...normalizeStringArray(base),
    ...normalizeStringArray(override)
  ].map((item) => item.trim()).filter(Boolean);
  return merged.length > 0 ? Array.from(new Set(merged)) : void 0;
}
function mergePostUnitHooks(base, override) {
  if (!base?.length && !override?.length) return void 0;
  const merged = [...base ?? []];
  for (const hook of override ?? []) {
    const idx = merged.findIndex((h) => h.name === hook.name);
    if (idx >= 0) {
      merged[idx] = hook;
    } else {
      merged.push(hook);
    }
  }
  return merged.length > 0 ? merged : void 0;
}
function mergePreDispatchHooks(base, override) {
  if (!base?.length && !override?.length) return void 0;
  const merged = [...base ?? []];
  for (const hook of override ?? []) {
    const idx = merged.findIndex((h) => h.name === hook.name);
    if (idx >= 0) {
      merged[idx] = hook;
    } else {
      merged.push(hook);
    }
  }
  return merged.length > 0 ? merged : void 0;
}
function renderPreferencesForSystemPrompt(preferences, resolutions) {
  const validated = validatePreferences(preferences);
  const lines = ["## GSD Skill Preferences"];
  if (validated.errors.length > 0) {
    lines.push("- Validation: some preference values were ignored because they were invalid.");
  }
  for (const warning of validated.warnings) {
    lines.push(`- Deprecation: ${warning}`);
  }
  preferences = validated.preferences;
  lines.push(
    "- Treat these as explicit skill-selection policy for GSD work.",
    "- If a listed skill exists and is relevant, load and follow it instead of treating it as a vague suggestion.",
    "- Current user instructions still override these defaults."
  );
  const fmt = (ref) => resolutions ? formatSkillRef(ref, resolutions) : ref;
  if (preferences.always_use_skills && preferences.always_use_skills.length > 0) {
    lines.push("- Always use these skills when relevant:");
    for (const skill of preferences.always_use_skills) {
      lines.push(`  - ${fmt(skill)}`);
    }
  }
  if (preferences.prefer_skills && preferences.prefer_skills.length > 0) {
    lines.push("- Prefer these skills when relevant:");
    for (const skill of preferences.prefer_skills) {
      lines.push(`  - ${fmt(skill)}`);
    }
  }
  if (preferences.avoid_skills && preferences.avoid_skills.length > 0) {
    lines.push("- Avoid these skills unless clearly needed:");
    for (const skill of preferences.avoid_skills) {
      lines.push(`  - ${fmt(skill)}`);
    }
  }
  if (preferences.skill_rules && preferences.skill_rules.length > 0) {
    lines.push("- Situational rules:");
    for (const rule of preferences.skill_rules) {
      lines.push(`  - When ${rule.when}:`);
      if (rule.use && rule.use.length > 0) {
        lines.push(`    - use: ${rule.use.map(fmt).join(", ")}`);
      }
      if (rule.prefer && rule.prefer.length > 0) {
        lines.push(`    - prefer: ${rule.prefer.map(fmt).join(", ")}`);
      }
      if (rule.avoid && rule.avoid.length > 0) {
        lines.push(`    - avoid: ${rule.avoid.map(fmt).join(", ")}`);
      }
    }
  }
  if (preferences.custom_instructions && preferences.custom_instructions.length > 0) {
    lines.push("- Additional instructions:");
    for (const instruction of preferences.custom_instructions) {
      lines.push(`  - ${instruction}`);
    }
  }
  if (preferences.language) {
    const safeLang = preferences.language.replace(/[\r\n]/g, " ").slice(0, 50);
    lines.push(`- Language: Always respond in ${safeLang}.`);
  }
  return lines.join("\n");
}
function resolvePostUnitHooks() {
  const prefs = loadEffectiveGSDPreferences();
  return (prefs?.preferences.post_unit_hooks ?? []).filter((h) => h.enabled !== false);
}
function resolvePreDispatchHooks() {
  const prefs = loadEffectiveGSDPreferences();
  return (prefs?.preferences.pre_dispatch_hooks ?? []).filter((h) => h.enabled !== false);
}
function getIsolationMode(basePath) {
  const prefs = loadEffectiveGSDPreferences(basePath)?.preferences?.git;
  if (prefs?.isolation === "worktree") {
    if (basePath && nativeIsRepo(basePath) && !nativeHasCommittedHead(basePath)) return "none";
    return "worktree";
  }
  if (prefs?.isolation === "branch") return "branch";
  return "none";
}
function resolveParallelConfig(prefs) {
  return {
    enabled: prefs?.parallel?.enabled ?? false,
    max_workers: Math.max(1, Math.min(4, prefs?.parallel?.max_workers ?? 2)),
    budget_ceiling: prefs?.parallel?.budget_ceiling,
    merge_strategy: prefs?.parallel?.merge_strategy ?? "per-milestone",
    auto_merge: prefs?.parallel?.auto_merge ?? "confirm",
    worker_model: prefs?.parallel?.worker_model
  };
}
export {
  _resetParseWarningFlag,
  applyModeDefaults,
  getGlobalGSDPreferencesPath,
  getIsolationMode,
  getLegacyGlobalGSDPreferencesPath,
  getNextFallbackModel,
  getProfileTierMap,
  getProjectGSDPreferencesPath,
  isTransientNetworkError,
  loadEffectiveGSDPreferences,
  loadGlobalGSDPreferences,
  loadProjectGSDPreferences,
  parsePreferencesMarkdown,
  renderPreferencesForSystemPrompt,
  resolveAllSkillReferences,
  resolveAutoSupervisorConfig,
  resolveContextSelection,
  resolveDisabledModelProvidersFromPreferences,
  resolveDynamicRoutingConfig,
  resolveEffectiveProfile,
  resolveInlineLevel,
  resolveModelForUnit,
  resolveModelMcpConfig,
  resolveModelWithFallbacksForUnit,
  resolveParallelConfig,
  resolvePostUnitHooks,
  resolvePreDispatchHooks,
  resolveProfileDefaults,
  resolveSearchProviderFromPreferences,
  resolveSkillDiscoveryMode,
  resolveSkillStalenessDays,
  updatePreferencesModels,
  validateModelId,
  validatePreferences2 as validatePreferences
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9wcmVmZXJlbmNlcy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBHU0QgUHJlZmVyZW5jZXMgLS0gbG9hZGluZywgbWVyZ2luZywgYW5kIHJlbmRlcmluZy5cbiAqXG4gKiBUaGlzIG1vZHVsZSBpcyB0aGUgcHJpbWFyeSBlbnRyeSBwb2ludCBmb3IgcHJlZmVyZW5jZSBvcGVyYXRpb25zLlxuICogVHlwZSBkZWZpbml0aW9ucyBsaXZlIGluIC4vcHJlZmVyZW5jZXMtdHlwZXMuanMsIHZhbGlkYXRpb24gaW5cbiAqIC4vcHJlZmVyZW5jZXMtdmFsaWRhdGlvbi5qcywgc2tpbGwgbG9naWMgaW4gLi9wcmVmZXJlbmNlcy1za2lsbHMuanMsXG4gKiBhbmQgbW9kZWwgbG9naWMgaW4gLi9wcmVmZXJlbmNlcy1tb2RlbHMuanMuXG4gKlxuICogQWxsIHN5bWJvbHMgYXJlIHJlLWV4cG9ydGVkIGhlcmUgc28gdGhhdCBleGlzdGluZyBgaW1wb3J0IHsgLi4uIH0gZnJvbSBcIi4vcHJlZmVyZW5jZXMuanNcImBcbiAqIHN0YXRlbWVudHMgY29udGludWUgdG8gd29yayB3aXRob3V0IG1vZGlmaWNhdGlvbi5cbiAqL1xuXG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgaG9tZWRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuXG5pbXBvcnQgeyBnc2RSb290IH0gZnJvbSBcIi4vcGF0aHMuanNcIjtcbmltcG9ydCB7IHBhcnNlIGFzIHBhcnNlWWFtbCB9IGZyb20gXCJ5YW1sXCI7XG5pbXBvcnQgdHlwZSB7IFBvc3RVbml0SG9va0NvbmZpZywgUHJlRGlzcGF0Y2hIb29rQ29uZmlnLCBUb2tlblByb2ZpbGUgfSBmcm9tIFwiLi90eXBlcy5qc1wiO1xuaW1wb3J0IHR5cGUgeyBEeW5hbWljUm91dGluZ0NvbmZpZyB9IGZyb20gXCIuL21vZGVsLXJvdXRlci5qc1wiO1xuaW1wb3J0IHsgbm9ybWFsaXplU3RyaW5nQXJyYXkgfSBmcm9tIFwiLi4vc2hhcmVkL2Zvcm1hdC11dGlscy5qc1wiO1xuaW1wb3J0IHsgbG9nV2FybmluZyB9IGZyb20gXCIuL3dvcmtmbG93LWxvZ2dlci5qc1wiO1xuaW1wb3J0IHsgcmVzb2x2ZVByb2ZpbGVEZWZhdWx0cyBhcyBfcmVzb2x2ZVByb2ZpbGVEZWZhdWx0cyB9IGZyb20gXCIuL3ByZWZlcmVuY2VzLW1vZGVscy5qc1wiO1xuaW1wb3J0IHsgbmF0aXZlSGFzQ29tbWl0dGVkSGVhZCwgbmF0aXZlSXNSZXBvIH0gZnJvbSBcIi4vbmF0aXZlLWdpdC1icmlkZ2UuanNcIjtcblxuaW1wb3J0IHtcbiAgS05PV05fUFJFRkVSRU5DRV9LRVlTLFxuICBNT0RFX0RFRkFVTFRTLFxuICB0eXBlIFdvcmtmbG93TW9kZSxcbiAgdHlwZSBHU0RQcmVmZXJlbmNlcyxcbiAgdHlwZSBMb2FkZWRHU0RQcmVmZXJlbmNlcyxcbiAgdHlwZSBTa2lsbFJlc29sdXRpb24sXG4gIHR5cGUgU2tpbGxEaXNjb3ZlcnlNb2RlLFxuICBmb3JtYXRTa2lsbFJlZixcbn0gZnJvbSBcIi4vcHJlZmVyZW5jZXMtdHlwZXMuanNcIjtcbmltcG9ydCB7IHZhbGlkYXRlUHJlZmVyZW5jZXMgfSBmcm9tIFwiLi9wcmVmZXJlbmNlcy12YWxpZGF0aW9uLmpzXCI7XG5pbXBvcnQgeyBnc2RIb21lIH0gZnJvbSBcIi4vZ3NkLWhvbWUuanNcIjtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFJlLWV4cG9ydHM6IHR5cGVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuLy8gRXZlcnkgdHlwZS9pbnRlcmZhY2UgdGhhdCB3YXMgcHJldmlvdXNseSBleHBvcnRlZCBmcm9tIHRoaXMgZmlsZSBpc1xuLy8gcmUtZXhwb3J0ZWQgc28gdGhhdCBkb3duc3RyZWFtIGBpbXBvcnQgeyBGb28gfSBmcm9tIFwiLi9wcmVmZXJlbmNlcy5qc1wiYFxuLy8gc3RhdGVtZW50cyBrZWVwIGNvbXBpbGluZy5cblxuZXhwb3J0IHR5cGUge1xuICBXb3JrZmxvd01vZGUsXG4gIEdTRFNraWxsUnVsZSxcbiAgR1NEUGhhc2VNb2RlbENvbmZpZyxcbiAgR1NETW9kZWxDb25maWcsXG4gIEdTRE1vZGVsQ29uZmlnVjIsXG4gIFJlc29sdmVkTW9kZWxDb25maWcsXG4gIFNraWxsRGlzY292ZXJ5TW9kZSxcbiAgQXV0b1N1cGVydmlzb3JDb25maWcsXG4gIFJlbW90ZVF1ZXN0aW9uc0NvbmZpZyxcbiAgQ211eFByZWZlcmVuY2VzLFxuICBVb2tUdXJuQWN0aW9uTW9kZSxcbiAgVW9rUHJlZmVyZW5jZXMsXG4gIENvZGViYXNlTWFwUHJlZmVyZW5jZXMsXG4gIENsYXVkZUNvZGVNY3BQZXJNb2RlbEVudHJ5LFxuICBDbGF1ZGVDb2RlTWNwQ29uZmlnLFxuICBHU0RQcmVmZXJlbmNlcyxcbiAgTG9hZGVkR1NEUHJlZmVyZW5jZXMsXG4gIFNraWxsUmVzb2x1dGlvbixcbiAgU2tpbGxSZXNvbHV0aW9uUmVwb3J0LFxufSBmcm9tIFwiLi9wcmVmZXJlbmNlcy10eXBlcy5qc1wiO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUmUtZXhwb3J0czogdmFsaWRhdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbmV4cG9ydCB7IHZhbGlkYXRlUHJlZmVyZW5jZXMgfSBmcm9tIFwiLi9wcmVmZXJlbmNlcy12YWxpZGF0aW9uLmpzXCI7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBSZS1leHBvcnRzOiBza2lsbHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5leHBvcnQgeyByZXNvbHZlQWxsU2tpbGxSZWZlcmVuY2VzIH0gZnJvbSBcIi4vcHJlZmVyZW5jZXMtc2tpbGxzLmpzXCI7XG5cbi8vIFRoZXNlIGxpdmVkIGluIHByZWZlcmVuY2VzLXNraWxscy50cyBidXQgaW1wb3J0ZWQgbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzXG4vLyBiYWNrIGZyb20gdGhpcyBmaWxlLCBjcmVhdGluZyBhIGNpcmN1bGFyIGRlcGVuZGVuY3kuIE1vdmVkIGhlcmUgc2luY2UgdGhleVxuLy8gYXJlIHRyaXZpYWwgd3JhcHBlcnMgb3ZlciBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMuXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZVNraWxsRGlzY292ZXJ5TW9kZShiYXNlUGF0aD86IHN0cmluZyk6IFNraWxsRGlzY292ZXJ5TW9kZSB7XG4gIGNvbnN0IHByZWZzID0gbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzKGJhc2VQYXRoKTtcbiAgcmV0dXJuIHByZWZzPy5wcmVmZXJlbmNlcy5za2lsbF9kaXNjb3ZlcnkgPz8gXCJzdWdnZXN0XCI7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlU2tpbGxTdGFsZW5lc3NEYXlzKGJhc2VQYXRoPzogc3RyaW5nKTogbnVtYmVyIHtcbiAgY29uc3QgcHJlZnMgPSBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMoYmFzZVBhdGgpO1xuICByZXR1cm4gcHJlZnM/LnByZWZlcmVuY2VzLnNraWxsX3N0YWxlbmVzc19kYXlzID8/IDYwO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUmUtZXhwb3J0czogbW9kZWxzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuZXhwb3J0IHtcbiAgcmVzb2x2ZU1vZGVsRm9yVW5pdCxcbiAgcmVzb2x2ZU1vZGVsV2l0aEZhbGxiYWNrc0ZvclVuaXQsXG4gIGdldE5leHRGYWxsYmFja01vZGVsLFxuICBpc1RyYW5zaWVudE5ldHdvcmtFcnJvcixcbiAgdmFsaWRhdGVNb2RlbElkLFxuICB1cGRhdGVQcmVmZXJlbmNlc01vZGVscyxcbiAgcmVzb2x2ZUR5bmFtaWNSb3V0aW5nQ29uZmlnLFxuICByZXNvbHZlQXV0b1N1cGVydmlzb3JDb25maWcsXG4gIHJlc29sdmVQcm9maWxlRGVmYXVsdHMsXG4gIGdldFByb2ZpbGVUaWVyTWFwLFxuICByZXNvbHZlRWZmZWN0aXZlUHJvZmlsZSxcbiAgcmVzb2x2ZUlubGluZUxldmVsLFxuICByZXNvbHZlQ29udGV4dFNlbGVjdGlvbixcbiAgcmVzb2x2ZVNlYXJjaFByb3ZpZGVyRnJvbVByZWZlcmVuY2VzLFxuICByZXNvbHZlRGlzYWJsZWRNb2RlbFByb3ZpZGVyc0Zyb21QcmVmZXJlbmNlcyxcbn0gZnJvbSBcIi4vcHJlZmVyZW5jZXMtbW9kZWxzLmpzXCI7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBSZS1leHBvcnRzOiBNQ1AgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5leHBvcnQgeyByZXNvbHZlTW9kZWxNY3BDb25maWcgfSBmcm9tIFwiLi9wcmVmZXJlbmNlcy1tY3AuanNcIjtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFBhdGggQ29uc3RhbnRzICYgR2V0dGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gZ2xvYmFsUHJlZmVyZW5jZXNQYXRoKCk6IHN0cmluZyB7XG4gIHJldHVybiBqb2luKGdzZEhvbWUoKSwgXCJQUkVGRVJFTkNFUy5tZFwiKTtcbn1cblxuZnVuY3Rpb24gbGVnYWN5R2xvYmFsUHJlZmVyZW5jZXNQYXRoKCk6IHN0cmluZyB7XG4gIHJldHVybiBqb2luKGhvbWVkaXIoKSwgXCIucGlcIiwgXCJhZ2VudFwiLCBcImdzZC1wcmVmZXJlbmNlcy5tZFwiKTtcbn1cblxuZnVuY3Rpb24gcHJvamVjdFByZWZlcmVuY2VzUGF0aChiYXNlUGF0aDogc3RyaW5nID0gcHJvY2Vzcy5jd2QoKSk6IHN0cmluZyB7XG4gIHJldHVybiBqb2luKGdzZFJvb3QoYmFzZVBhdGgpLCBcIlBSRUZFUkVOQ0VTLm1kXCIpO1xufVxuLy8gTGVnYWN5IGxvd2VyY2FzZSBmaWxlcyBjYW4gc3RpbGwgZXhpc3QgaW4gb2xkZXIgcHJvamVjdHMuIEtlZXAgdGhlbSBhcyBhXG4vLyBjb21wYXRpYmlsaXR5LW9ubHkgZmFsbGJhY2ssIGJ1dCByb3V0ZSBuZXcgcmVhZHMvd3JpdGVzIHRocm91Z2ggUFJFRkVSRU5DRVMubWQuXG5mdW5jdGlvbiBsZWdhY3lHbG9iYWxQcmVmZXJlbmNlc1BhdGhMb3dlcmNhc2UoKTogc3RyaW5nIHtcbiAgcmV0dXJuIGpvaW4oZ3NkSG9tZSgpLCBcInByZWZlcmVuY2VzLm1kXCIpO1xufVxuZnVuY3Rpb24gbGVnYWN5UHJvamVjdFByZWZlcmVuY2VzUGF0aExvd2VyY2FzZShiYXNlUGF0aDogc3RyaW5nID0gcHJvY2Vzcy5jd2QoKSk6IHN0cmluZyB7XG4gIHJldHVybiBqb2luKGdzZFJvb3QoYmFzZVBhdGgpLCBcInByZWZlcmVuY2VzLm1kXCIpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0R2xvYmFsR1NEUHJlZmVyZW5jZXNQYXRoKCk6IHN0cmluZyB7XG4gIHJldHVybiBnbG9iYWxQcmVmZXJlbmNlc1BhdGgoKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldExlZ2FjeUdsb2JhbEdTRFByZWZlcmVuY2VzUGF0aCgpOiBzdHJpbmcge1xuICByZXR1cm4gbGVnYWN5R2xvYmFsUHJlZmVyZW5jZXNQYXRoKCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRQcm9qZWN0R1NEUHJlZmVyZW5jZXNQYXRoKGJhc2VQYXRoPzogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHByb2plY3RQcmVmZXJlbmNlc1BhdGgoYmFzZVBhdGgpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgTG9hZGluZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGZ1bmN0aW9uIGxvYWRHbG9iYWxHU0RQcmVmZXJlbmNlcygpOiBMb2FkZWRHU0RQcmVmZXJlbmNlcyB8IG51bGwge1xuICByZXR1cm4gbG9hZFByZWZlcmVuY2VzRmlsZShnbG9iYWxQcmVmZXJlbmNlc1BhdGgoKSwgXCJnbG9iYWxcIilcbiAgICA/PyBsb2FkUHJlZmVyZW5jZXNGaWxlKGxlZ2FjeUdsb2JhbFByZWZlcmVuY2VzUGF0aExvd2VyY2FzZSgpLCBcImdsb2JhbFwiKVxuICAgID8/IGxvYWRQcmVmZXJlbmNlc0ZpbGUobGVnYWN5R2xvYmFsUHJlZmVyZW5jZXNQYXRoKCksIFwiZ2xvYmFsXCIpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbG9hZFByb2plY3RHU0RQcmVmZXJlbmNlcyhiYXNlUGF0aD86IHN0cmluZyk6IExvYWRlZEdTRFByZWZlcmVuY2VzIHwgbnVsbCB7XG4gIHJldHVybiBsb2FkUHJlZmVyZW5jZXNGaWxlKHByb2plY3RQcmVmZXJlbmNlc1BhdGgoYmFzZVBhdGgpLCBcInByb2plY3RcIilcbiAgICA/PyBsb2FkUHJlZmVyZW5jZXNGaWxlKGxlZ2FjeVByb2plY3RQcmVmZXJlbmNlc1BhdGhMb3dlcmNhc2UoYmFzZVBhdGgpLCBcInByb2plY3RcIik7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMoXG4gIGJhc2VQYXRoPzogc3RyaW5nLFxuICBvcHRzPzogeyBhdmFpbGFibGVNb2RlbElkcz86IHN0cmluZ1tdIH0sXG4pOiBMb2FkZWRHU0RQcmVmZXJlbmNlcyB8IG51bGwge1xuICBjb25zdCBnbG9iYWxQcmVmZXJlbmNlcyA9IGxvYWRHbG9iYWxHU0RQcmVmZXJlbmNlcygpO1xuICBjb25zdCBwcm9qZWN0UHJlZmVyZW5jZXMgPSBsb2FkUHJvamVjdEdTRFByZWZlcmVuY2VzKGJhc2VQYXRoKTtcbiAgY29uc3QgcHJvamVjdEhhc1BsYW5uaW5nRGVwdGggPSBwcm9qZWN0UHJlZmVyZW5jZXM/LnByZWZlcmVuY2VzLnBsYW5uaW5nX2RlcHRoICE9PSB1bmRlZmluZWQ7XG5cbiAgaWYgKCFnbG9iYWxQcmVmZXJlbmNlcyAmJiAhcHJvamVjdFByZWZlcmVuY2VzKSByZXR1cm4gbnVsbDtcblxuICBsZXQgcmVzdWx0OiBMb2FkZWRHU0RQcmVmZXJlbmNlcztcbiAgaWYgKCFnbG9iYWxQcmVmZXJlbmNlcykge1xuICAgIHJlc3VsdCA9IHByb2plY3RQcmVmZXJlbmNlcyE7XG4gIH0gZWxzZSBpZiAoIXByb2plY3RQcmVmZXJlbmNlcykge1xuICAgIHJlc3VsdCA9IGdsb2JhbFByZWZlcmVuY2VzO1xuICB9IGVsc2Uge1xuICAgIGNvbnN0IG1lcmdlZFdhcm5pbmdzID0gW1xuICAgICAgLi4uKGdsb2JhbFByZWZlcmVuY2VzLndhcm5pbmdzID8/IFtdKSxcbiAgICAgIC4uLihwcm9qZWN0UHJlZmVyZW5jZXMud2FybmluZ3MgPz8gW10pLFxuICAgIF07XG4gICAgcmVzdWx0ID0ge1xuICAgICAgcGF0aDogcHJvamVjdFByZWZlcmVuY2VzLnBhdGgsXG4gICAgICBzY29wZTogXCJwcm9qZWN0XCIsXG4gICAgICBwcmVmZXJlbmNlczogbWVyZ2VQcmVmZXJlbmNlcyhnbG9iYWxQcmVmZXJlbmNlcy5wcmVmZXJlbmNlcywgcHJvamVjdFByZWZlcmVuY2VzLnByZWZlcmVuY2VzKSxcbiAgICAgIC4uLihtZXJnZWRXYXJuaW5ncy5sZW5ndGggPiAwID8geyB3YXJuaW5nczogbWVyZ2VkV2FybmluZ3MgfSA6IHt9KSxcbiAgICB9O1xuICB9XG5cbiAgLy8gQXBwbHkgdG9rZW4tcHJvZmlsZSBkZWZhdWx0cyBhcyB0aGUgbG93ZXN0LXByaW9yaXR5IGxheWVyIHNvIHRoYXRcbiAgLy8gYHRva2VuX3Byb2ZpbGU6IGJ1ZGdldGAgc2V0cyBtb2RlbHMgYW5kIHBoYXNlLXNraXBzIGF1dG9tYXRpY2FsbHkuXG4gIC8vIEV4cGxpY2l0IHVzZXIgcHJlZmVyZW5jZXMgYWx3YXlzIG92ZXJyaWRlIHByb2ZpbGUgZGVmYXVsdHMuXG4gIGNvbnN0IHByb2ZpbGUgPSByZXN1bHQucHJlZmVyZW5jZXMudG9rZW5fcHJvZmlsZSBhcyBUb2tlblByb2ZpbGUgfCB1bmRlZmluZWQ7XG4gIGlmIChwcm9maWxlKSB7XG4gICAgY29uc3QgcHJvZmlsZURlZmF1bHRzID0gX3Jlc29sdmVQcm9maWxlRGVmYXVsdHMoXG4gICAgICBwcm9maWxlLFxuICAgICAgb3B0cz8uYXZhaWxhYmxlTW9kZWxJZHMsXG4gICAgICByZXN1bHQucHJlZmVyZW5jZXMuZHluYW1pY19yb3V0aW5nLFxuICAgICk7XG4gICAgcmVzdWx0ID0ge1xuICAgICAgLi4ucmVzdWx0LFxuICAgICAgcHJlZmVyZW5jZXM6IG1lcmdlUHJlZmVyZW5jZXMocHJvZmlsZURlZmF1bHRzIGFzIEdTRFByZWZlcmVuY2VzLCByZXN1bHQucHJlZmVyZW5jZXMpLFxuICAgIH07XG4gIH1cblxuICAvLyBBcHBseSBtb2RlIGRlZmF1bHRzIGFzIHRoZSBsb3dlc3QtcHJpb3JpdHkgbGF5ZXJcbiAgaWYgKHJlc3VsdC5wcmVmZXJlbmNlcy5tb2RlKSB7XG4gICAgcmVzdWx0ID0ge1xuICAgICAgLi4ucmVzdWx0LFxuICAgICAgcHJlZmVyZW5jZXM6IGFwcGx5TW9kZURlZmF1bHRzKHJlc3VsdC5wcmVmZXJlbmNlcy5tb2RlLCByZXN1bHQucHJlZmVyZW5jZXMpLFxuICAgIH07XG4gIH1cblxuICByZXN1bHQgPSBzdHJpcEluaGVyaXRlZFBsYW5uaW5nRGVwdGgocmVzdWx0LCBwcm9qZWN0SGFzUGxhbm5pbmdEZXB0aCk7XG5cbiAgcmV0dXJuIHJlc3VsdDtcbn1cblxuZnVuY3Rpb24gc3RyaXBJbmhlcml0ZWRQbGFubmluZ0RlcHRoKFxuICBsb2FkZWQ6IExvYWRlZEdTRFByZWZlcmVuY2VzLFxuICBwcm9qZWN0SGFzUGxhbm5pbmdEZXB0aDogYm9vbGVhbixcbik6IExvYWRlZEdTRFByZWZlcmVuY2VzIHtcbiAgaWYgKHByb2plY3RIYXNQbGFubmluZ0RlcHRoIHx8IGxvYWRlZC5wcmVmZXJlbmNlcy5wbGFubmluZ19kZXB0aCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIGxvYWRlZDtcbiAgfVxuXG4gIC8vIHBsYW5uaW5nX2RlcHRoIGlzIGEgcHJvamVjdCBib290c3RyYXAgcm91dGluZyBmbGFnLCBub3QgYSB1c2VyLWdsb2JhbFxuICAvLyBwcmVmZXJlbmNlLiBBIGdsb2JhbCB+Ly5nc2QvUFJFRkVSRU5DRVMubWQgdmFsdWUgc2hvdWxkIG5vdCBtYWtlIGV2ZXJ5XG4gIC8vIGZyZXNoIHJlcG8gYmVoYXZlIGxpa2UgYC9nc2QgbmV3LXByb2plY3QgLS1kZWVwYC5cbiAgY29uc3QgcHJlZmVyZW5jZXM6IEdTRFByZWZlcmVuY2VzID0geyAuLi5sb2FkZWQucHJlZmVyZW5jZXMgfTtcbiAgZGVsZXRlIHByZWZlcmVuY2VzLnBsYW5uaW5nX2RlcHRoO1xuICByZXR1cm4geyAuLi5sb2FkZWQsIHByZWZlcmVuY2VzIH07XG59XG5cbmZ1bmN0aW9uIGxvYWRQcmVmZXJlbmNlc0ZpbGUocGF0aDogc3RyaW5nLCBzY29wZTogXCJnbG9iYWxcIiB8IFwicHJvamVjdFwiKTogTG9hZGVkR1NEUHJlZmVyZW5jZXMgfCBudWxsIHtcbiAgaWYgKCFleGlzdHNTeW5jKHBhdGgpKSByZXR1cm4gbnVsbDtcblxuICBjb25zdCByYXcgPSByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGYtOFwiKTtcbiAgY29uc3QgcHJlZmVyZW5jZXMgPSBwYXJzZVByZWZlcmVuY2VzTWFya2Rvd24ocmF3KTtcbiAgaWYgKCFwcmVmZXJlbmNlcykgcmV0dXJuIG51bGw7XG5cbiAgY29uc3QgdmFsaWRhdGlvbiA9IHZhbGlkYXRlUHJlZmVyZW5jZXMocHJlZmVyZW5jZXMpO1xuICBjb25zdCBhbGxXYXJuaW5ncyA9IFsuLi52YWxpZGF0aW9uLndhcm5pbmdzLCAuLi52YWxpZGF0aW9uLmVycm9yc107XG5cbiAgcmV0dXJuIHtcbiAgICBwYXRoLFxuICAgIHNjb3BlLFxuICAgIHByZWZlcmVuY2VzOiB2YWxpZGF0aW9uLnByZWZlcmVuY2VzLFxuICAgIC4uLihhbGxXYXJuaW5ncy5sZW5ndGggPiAwID8geyB3YXJuaW5nczogYWxsV2FybmluZ3MgfSA6IHt9KSxcbiAgfTtcbn1cblxubGV0IF93YXJuZWRVbnJlY29nbml6ZWRGb3JtYXQgPSBmYWxzZTtcbmxldCBfd2FybmVkU2VjdGlvblBhcnNlID0gZmFsc2U7XG5cbi8qKiBAaW50ZXJuYWwgUmVzZXQgdGhlIHdhcm4tb25jZSBmbGFncyBcdTIwMTQgZXhwb3J0ZWQgZm9yIHRlc3Rpbmcgb25seS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBfcmVzZXRQYXJzZVdhcm5pbmdGbGFnKCk6IHZvaWQge1xuICBfd2FybmVkVW5yZWNvZ25pemVkRm9ybWF0ID0gZmFsc2U7XG4gIF93YXJuZWRGcm9udG1hdHRlclBhcnNlID0gZmFsc2U7XG4gIF93YXJuZWRTZWN0aW9uUGFyc2UgPSBmYWxzZTtcbn1cblxuLyoqIEBpbnRlcm5hbCBFeHBvcnRlZCBmb3IgdGVzdGluZyBvbmx5ICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VQcmVmZXJlbmNlc01hcmtkb3duKGNvbnRlbnQ6IHN0cmluZyk6IEdTRFByZWZlcmVuY2VzIHwgbnVsbCB7XG4gIC8vIFVzZSBpbmRleE9mIGluc3RlYWQgb2YgW1xcc1xcU10qPyByZWdleCB0byBhdm9pZCBiYWNrdHJhY2tpbmcgKCM0NjgpXG4gIGNvbnN0IHN0YXJ0TWFya2VyID0gY29udGVudC5zdGFydHNXaXRoKCctLS1cXHJcXG4nKSA/ICctLS1cXHJcXG4nIDogJy0tLVxcbic7XG4gIGlmIChjb250ZW50LnN0YXJ0c1dpdGgoc3RhcnRNYXJrZXIpKSB7XG4gICAgY29uc3Qgc2VhcmNoU3RhcnQgPSBzdGFydE1hcmtlci5sZW5ndGg7XG4gICAgY29uc3QgZW5kSWR4ID0gY29udGVudC5pbmRleE9mKCdcXG4tLS0nLCBzZWFyY2hTdGFydCk7XG4gICAgaWYgKGVuZElkeCA9PT0gLTEpIHJldHVybiBudWxsO1xuICAgIGNvbnN0IGJsb2NrID0gY29udGVudC5zbGljZShzZWFyY2hTdGFydCwgZW5kSWR4KTtcbiAgICByZXR1cm4gcGFyc2VGcm9udG1hdHRlckJsb2NrKGJsb2NrLnJlcGxhY2UoL1xcci9nLCAnJykpO1xuICB9XG5cbiAgLy8gRmFsbGJhY2s6IGhlYWRpbmcrbGlzdCBmb3JtYXQgKGUuZy4gXCIjIyBHaXRcXG4tIGlzb2xhdGlvbjogbm9uZVwiKSAoIzIwMzYpXG4gIC8vIEdTRCBhZ2VudHMgbWF5IHdyaXRlIHByZWZlcmVuY2VzIGZpbGVzIHdpdGhvdXQgZnJvbnRtYXR0ZXIgZGVsaW1pdGVycy5cbiAgaWYgKC9eIyNcXHMrXFx3L20udGVzdChjb250ZW50KSkge1xuICAgIHJldHVybiBwYXJzZUhlYWRpbmdMaXN0Rm9ybWF0KGNvbnRlbnQpO1xuICB9XG5cbiAgLy8gV2FybiB3aGVuIGEgbm9uLWVtcHR5IGZpbGUgZXhpc3RzIGJ1dCBsYWNrcyBmcm9udG1hdHRlciBkZWxpbWl0ZXJzICgjMjAzNikuXG4gIGlmIChjb250ZW50LnRyaW0oKS5sZW5ndGggPiAwICYmICFfd2FybmVkVW5yZWNvZ25pemVkRm9ybWF0KSB7XG4gICAgX3dhcm5lZFVucmVjb2duaXplZEZvcm1hdCA9IHRydWU7XG4gICAgY29uc29sZS53YXJuKFxuICAgICAgXCJbR1NEXSBXYXJuaW5nOiBwcmVmZXJlbmNlcyBmaWxlIGhhcyB1bnJlY29nbml6ZWQgZm9ybWF0IFx1MjAxNCBjb250ZW50IGRvZXMgbm90IHVzZSBZQU1MIGZyb250bWF0dGVyIGRlbGltaXRlcnMgKC0tLSkuIFwiICtcbiAgICAgIFwiV3JhcCB5b3VyIHByZWZlcmVuY2VzIGluIC0tLSBmZW5jZXMuIFNlZSBodHRwczovL2dpdGh1Yi5jb20vZ3NkLWJ1aWxkL2dzZC0yL2lzc3Vlcy8yMDM2XCIsXG4gICAgKTtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxubGV0IF93YXJuZWRGcm9udG1hdHRlclBhcnNlID0gZmFsc2U7XG5mdW5jdGlvbiBwYXJzZUZyb250bWF0dGVyQmxvY2soZnJvbnRtYXR0ZXI6IHN0cmluZyk6IEdTRFByZWZlcmVuY2VzIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVlhbWwoZnJvbnRtYXR0ZXIpO1xuICAgIGlmICh0eXBlb2YgcGFyc2VkICE9PSAnb2JqZWN0JyB8fCBwYXJzZWQgPT09IG51bGwpIHtcbiAgICAgIHJldHVybiB7fSBhcyBHU0RQcmVmZXJlbmNlcztcbiAgICB9XG4gICAgcmV0dXJuIHBhcnNlZCBhcyBHU0RQcmVmZXJlbmNlcztcbiAgfSBjYXRjaCAoZSkge1xuICAgIC8vIFdhcm4gYXQgbW9zdCBvbmNlIHBlciBzZXNzaW9uIHRvIGF2b2lkIGZsb29kaW5nIFRVSSAoIzMzNzYpXG4gICAgaWYgKCFfd2FybmVkRnJvbnRtYXR0ZXJQYXJzZSkge1xuICAgICAgX3dhcm5lZEZyb250bWF0dGVyUGFyc2UgPSB0cnVlO1xuICAgICAgbG9nV2FybmluZyhcImd1aWRlZFwiLCBgWUFNTCBwYXJzZSBlcnJvciBpbiBwcmVmZXJlbmNlcyBmcm9udG1hdHRlciAoc3VwcHJlc3NpbmcgZnVydGhlcik6ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgfVxuICAgIHJldHVybiB7fSBhcyBHU0RQcmVmZXJlbmNlcztcbiAgfVxufVxuXG4vKipcbiAqIFBhcnNlIGhlYWRpbmcrbGlzdCBmb3JtYXQgaW50byBhIG5lc3RlZCBvYmplY3QsIHRoZW4gY2FzdCB0byBHU0RQcmVmZXJlbmNlcy5cbiAqIEhhbmRsZXMgbWFya2Rvd24gbGlrZTpcbiAqICAgIyMgR2l0XG4gKiAgIC0gaXNvbGF0aW9uOiBub25lXG4gKiAgIC0gY29tbWl0X2RvY3M6IHRydWVcbiAqICAgIyMgTW9kZWxzXG4gKiAgIC0gcGxhbm5lcjogc29ubmV0XG4gKi9cbmZ1bmN0aW9uIHBhcnNlSGVhZGluZ0xpc3RGb3JtYXQoY29udGVudDogc3RyaW5nKTogR1NEUHJlZmVyZW5jZXMge1xuICBjb25zdCByZXN1bHQ6IFJlY29yZDxzdHJpbmcsIHN0cmluZ1tdPiA9IHt9O1xuICBsZXQgY3VycmVudFNlY3Rpb246IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG4gIGZvciAoY29uc3QgcmF3TGluZSBvZiBjb250ZW50LnNwbGl0KCdcXG4nKSkge1xuICAgIGNvbnN0IGxpbmUgPSByYXdMaW5lLnJlcGxhY2UoL1xcciQvLCAnJyk7XG4gICAgY29uc3QgaGVhZGluZ01hdGNoID0gbGluZS5tYXRjaCgvXiMjXFxzKyguKykkLyk7XG4gICAgaWYgKGhlYWRpbmdNYXRjaCkge1xuICAgICAgY3VycmVudFNlY3Rpb24gPSBoZWFkaW5nTWF0Y2hbMV0udHJpbSgpLnRvTG93ZXJDYXNlKCkucmVwbGFjZSgvXFxzKy9nLCAnXycpO1xuICAgICAgaWYgKCFyZXN1bHRbY3VycmVudFNlY3Rpb25dKSByZXN1bHRbY3VycmVudFNlY3Rpb25dID0gW107XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGN1cnJlbnRTZWN0aW9uICYmIGxpbmUudHJpbSgpICYmICFsaW5lLnRyaW1TdGFydCgpLnN0YXJ0c1dpdGgoJyMnKSkge1xuICAgICAgcmVzdWx0W2N1cnJlbnRTZWN0aW9uXS5wdXNoKGxpbmUpO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IHR5cGVkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuICBmb3IgKGNvbnN0IFtzZWN0aW9uLCBsaW5lc10gb2YgT2JqZWN0LmVudHJpZXMocmVzdWx0KSkge1xuICAgIGlmIChsaW5lcy5sZW5ndGggPT09IDApIGNvbnRpbnVlO1xuXG4gICAgY29uc3QgdXNlc0xlZ2FjeUxpc3RJdGVtcyA9IGxpbmVzLmV2ZXJ5KChsaW5lKSA9PiAvXlxccyotXFxzK1teOl0rOlxccyouKiQvLnRlc3QobGluZSkpO1xuICAgIGNvbnN0IHlhbWxCbG9jayA9IHVzZXNMZWdhY3lMaXN0SXRlbXNcbiAgICAgID8gbGluZXMubWFwKChsaW5lKSA9PiBsaW5lLnJlcGxhY2UoL15cXHMqLVxccysvLCAnJykpLmpvaW4oJ1xcbicpXG4gICAgICA6IGxpbmVzLmpvaW4oJ1xcbicpO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlWWFtbCh5YW1sQmxvY2spO1xuICAgICAgaWYgKHR5cGVvZiBwYXJzZWQgIT09ICdvYmplY3QnIHx8IHBhcnNlZCA9PT0gbnVsbCkgY29udGludWU7XG5cbiAgICAgIGxldCB0YXJnZXRTZWN0aW9uID0gc2VjdGlvbjtcbiAgICAgIGxldCB2YWx1ZTogdW5rbm93biA9IHBhcnNlZDtcblxuICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHBhcnNlZCkpIHtcbiAgICAgICAgY29uc3Qga2V5cyA9IE9iamVjdC5rZXlzKHBhcnNlZCk7XG4gICAgICAgIGlmIChrZXlzLmxlbmd0aCA9PT0gMSkge1xuICAgICAgICAgIGNvbnN0IFtvbmx5S2V5XSA9IGtleXM7XG4gICAgICAgICAgaWYgKG9ubHlLZXkgPT09IHNlY3Rpb24gfHwgKCFLTk9XTl9QUkVGRVJFTkNFX0tFWVMuaGFzKHNlY3Rpb24pICYmIEtOT1dOX1BSRUZFUkVOQ0VfS0VZUy5oYXMob25seUtleSkpKSB7XG4gICAgICAgICAgICB0YXJnZXRTZWN0aW9uID0gb25seUtleTtcbiAgICAgICAgICAgIHZhbHVlID0gKHBhcnNlZCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPilbb25seUtleV07XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIHR5cGVkW3RhcmdldFNlY3Rpb25dID0gdmFsdWU7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgaWYgKCFfd2FybmVkU2VjdGlvblBhcnNlKSB7XG4gICAgICAgIF93YXJuZWRTZWN0aW9uUGFyc2UgPSB0cnVlO1xuICAgICAgICBsb2dXYXJuaW5nKFwiZ3VpZGVkXCIsIGBwcmVmZXJlbmNlcyBzZWN0aW9uIHBhcnNlIGZhaWxlZDogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4gdHlwZWQgYXMgR1NEUHJlZmVyZW5jZXM7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBNZXJnaW5nIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIEFwcGx5IG1vZGUgZGVmYXVsdHMgYXMgdGhlIGxvd2VzdC1wcmlvcml0eSBsYXllci5cbiAqIE1vZGUgZGVmYXVsdHMgZmlsbCBpbiB1bmRlZmluZWQgZmllbGRzOyBhbnkgZXhwbGljaXQgdXNlciB2YWx1ZSB3aW5zLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYXBwbHlNb2RlRGVmYXVsdHMobW9kZTogV29ya2Zsb3dNb2RlLCBwcmVmczogR1NEUHJlZmVyZW5jZXMpOiBHU0RQcmVmZXJlbmNlcyB7XG4gIGNvbnN0IGRlZmF1bHRzID0gTU9ERV9ERUZBVUxUU1ttb2RlXTtcbiAgaWYgKCFkZWZhdWx0cykgcmV0dXJuIHByZWZzO1xuICByZXR1cm4gbWVyZ2VQcmVmZXJlbmNlcyhkZWZhdWx0cywgcHJlZnMpO1xufVxuXG5mdW5jdGlvbiBtZXJnZVByZWZlcmVuY2VzKGJhc2U6IEdTRFByZWZlcmVuY2VzLCBvdmVycmlkZTogR1NEUHJlZmVyZW5jZXMpOiBHU0RQcmVmZXJlbmNlcyB7XG4gIHJldHVybiB7XG4gICAgdmVyc2lvbjogb3ZlcnJpZGUudmVyc2lvbiA/PyBiYXNlLnZlcnNpb24sXG4gICAgbW9kZTogb3ZlcnJpZGUubW9kZSA/PyBiYXNlLm1vZGUsXG4gICAgYWx3YXlzX3VzZV9za2lsbHM6IG1lcmdlU3RyaW5nTGlzdHMoYmFzZS5hbHdheXNfdXNlX3NraWxscywgb3ZlcnJpZGUuYWx3YXlzX3VzZV9za2lsbHMpLFxuICAgIHByZWZlcl9za2lsbHM6IG1lcmdlU3RyaW5nTGlzdHMoYmFzZS5wcmVmZXJfc2tpbGxzLCBvdmVycmlkZS5wcmVmZXJfc2tpbGxzKSxcbiAgICBhdm9pZF9za2lsbHM6IG1lcmdlU3RyaW5nTGlzdHMoYmFzZS5hdm9pZF9za2lsbHMsIG92ZXJyaWRlLmF2b2lkX3NraWxscyksXG4gICAgc2tpbGxfcnVsZXM6IFsuLi4oYmFzZS5za2lsbF9ydWxlcyA/PyBbXSksIC4uLihvdmVycmlkZS5za2lsbF9ydWxlcyA/PyBbXSldLFxuICAgIGN1c3RvbV9pbnN0cnVjdGlvbnM6IG1lcmdlU3RyaW5nTGlzdHMoYmFzZS5jdXN0b21faW5zdHJ1Y3Rpb25zLCBvdmVycmlkZS5jdXN0b21faW5zdHJ1Y3Rpb25zKSxcbiAgICBtb2RlbHM6IHsgLi4uKGJhc2UubW9kZWxzID8/IHt9KSwgLi4uKG92ZXJyaWRlLm1vZGVscyA/PyB7fSkgfSxcbiAgICBza2lsbF9kaXNjb3Zlcnk6IG92ZXJyaWRlLnNraWxsX2Rpc2NvdmVyeSA/PyBiYXNlLnNraWxsX2Rpc2NvdmVyeSxcbiAgICBza2lsbF9zdGFsZW5lc3NfZGF5czogb3ZlcnJpZGUuc2tpbGxfc3RhbGVuZXNzX2RheXMgPz8gYmFzZS5za2lsbF9zdGFsZW5lc3NfZGF5cyxcbiAgICBhdXRvX3N1cGVydmlzb3I6IHsgLi4uKGJhc2UuYXV0b19zdXBlcnZpc29yID8/IHt9KSwgLi4uKG92ZXJyaWRlLmF1dG9fc3VwZXJ2aXNvciA/PyB7fSkgfSxcbiAgICB1YXRfZGlzcGF0Y2g6IG92ZXJyaWRlLnVhdF9kaXNwYXRjaCA/PyBiYXNlLnVhdF9kaXNwYXRjaCxcbiAgICB1bmlxdWVfbWlsZXN0b25lX2lkczogb3ZlcnJpZGUudW5pcXVlX21pbGVzdG9uZV9pZHMgPz8gYmFzZS51bmlxdWVfbWlsZXN0b25lX2lkcyxcbiAgICBidWRnZXRfY2VpbGluZzogb3ZlcnJpZGUuYnVkZ2V0X2NlaWxpbmcgPz8gYmFzZS5idWRnZXRfY2VpbGluZyxcbiAgICBidWRnZXRfZW5mb3JjZW1lbnQ6IG92ZXJyaWRlLmJ1ZGdldF9lbmZvcmNlbWVudCA/PyBiYXNlLmJ1ZGdldF9lbmZvcmNlbWVudCxcbiAgICBjb250ZXh0X3BhdXNlX3RocmVzaG9sZDogb3ZlcnJpZGUuY29udGV4dF9wYXVzZV90aHJlc2hvbGQgPz8gYmFzZS5jb250ZXh0X3BhdXNlX3RocmVzaG9sZCxcbiAgICBub3RpZmljYXRpb25zOiAoYmFzZS5ub3RpZmljYXRpb25zIHx8IG92ZXJyaWRlLm5vdGlmaWNhdGlvbnMpXG4gICAgICA/IHsgLi4uKGJhc2Uubm90aWZpY2F0aW9ucyA/PyB7fSksIC4uLihvdmVycmlkZS5ub3RpZmljYXRpb25zID8/IHt9KSB9XG4gICAgICA6IHVuZGVmaW5lZCxcbiAgICBjbXV4OiAoYmFzZS5jbXV4IHx8IG92ZXJyaWRlLmNtdXgpXG4gICAgICA/IHsgLi4uKGJhc2UuY211eCA/PyB7fSksIC4uLihvdmVycmlkZS5jbXV4ID8/IHt9KSB9XG4gICAgICA6IHVuZGVmaW5lZCxcbiAgICByZW1vdGVfcXVlc3Rpb25zOiBvdmVycmlkZS5yZW1vdGVfcXVlc3Rpb25zXG4gICAgICA/IHsgLi4uKGJhc2UucmVtb3RlX3F1ZXN0aW9ucyA/PyB7fSksIC4uLm92ZXJyaWRlLnJlbW90ZV9xdWVzdGlvbnMgfVxuICAgICAgOiBiYXNlLnJlbW90ZV9xdWVzdGlvbnMsXG4gICAgZ2l0OiAoYmFzZS5naXQgfHwgb3ZlcnJpZGUuZ2l0KVxuICAgICAgPyB7IC4uLihiYXNlLmdpdCA/PyB7fSksIC4uLihvdmVycmlkZS5naXQgPz8ge30pIH1cbiAgICAgIDogdW5kZWZpbmVkLFxuICAgIHBvc3RfdW5pdF9ob29rczogbWVyZ2VQb3N0VW5pdEhvb2tzKGJhc2UucG9zdF91bml0X2hvb2tzLCBvdmVycmlkZS5wb3N0X3VuaXRfaG9va3MpLFxuICAgIHByZV9kaXNwYXRjaF9ob29rczogbWVyZ2VQcmVEaXNwYXRjaEhvb2tzKGJhc2UucHJlX2Rpc3BhdGNoX2hvb2tzLCBvdmVycmlkZS5wcmVfZGlzcGF0Y2hfaG9va3MpLFxuICAgIGR5bmFtaWNfcm91dGluZzogKGJhc2UuZHluYW1pY19yb3V0aW5nIHx8IG92ZXJyaWRlLmR5bmFtaWNfcm91dGluZylcbiAgICAgID8geyAuLi4oYmFzZS5keW5hbWljX3JvdXRpbmcgPz8ge30pLCAuLi4ob3ZlcnJpZGUuZHluYW1pY19yb3V0aW5nID8/IHt9KSB9IGFzIER5bmFtaWNSb3V0aW5nQ29uZmlnXG4gICAgICA6IHVuZGVmaW5lZCxcbiAgICBkaXNhYmxlZF9tb2RlbF9wcm92aWRlcnM6IG1lcmdlU3RyaW5nTGlzdHMoXG4gICAgICBiYXNlLmRpc2FibGVkX21vZGVsX3Byb3ZpZGVycyxcbiAgICAgIG92ZXJyaWRlLmRpc2FibGVkX21vZGVsX3Byb3ZpZGVycyxcbiAgICApLFxuICAgIHVvazogKGJhc2UudW9rIHx8IG92ZXJyaWRlLnVvaylcbiAgICAgID8ge1xuICAgICAgICAgIGVuYWJsZWQ6IG92ZXJyaWRlLnVvaz8uZW5hYmxlZCA/PyBiYXNlLnVvaz8uZW5hYmxlZCxcbiAgICAgICAgICBsZWdhY3lfZmFsbGJhY2s6IChiYXNlLnVvaz8ubGVnYWN5X2ZhbGxiYWNrIHx8IG92ZXJyaWRlLnVvaz8ubGVnYWN5X2ZhbGxiYWNrKVxuICAgICAgICAgICAgPyB7IC4uLihiYXNlLnVvaz8ubGVnYWN5X2ZhbGxiYWNrID8/IHt9KSwgLi4uKG92ZXJyaWRlLnVvaz8ubGVnYWN5X2ZhbGxiYWNrID8/IHt9KSB9XG4gICAgICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICAgICAgICBnYXRlczogKGJhc2UudW9rPy5nYXRlcyB8fCBvdmVycmlkZS51b2s/LmdhdGVzKVxuICAgICAgICAgICAgPyB7IC4uLihiYXNlLnVvaz8uZ2F0ZXMgPz8ge30pLCAuLi4ob3ZlcnJpZGUudW9rPy5nYXRlcyA/PyB7fSkgfVxuICAgICAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgICAgICAgbW9kZWxfcG9saWN5OiAoYmFzZS51b2s/Lm1vZGVsX3BvbGljeSB8fCBvdmVycmlkZS51b2s/Lm1vZGVsX3BvbGljeSlcbiAgICAgICAgICAgID8geyAuLi4oYmFzZS51b2s/Lm1vZGVsX3BvbGljeSA/PyB7fSksIC4uLihvdmVycmlkZS51b2s/Lm1vZGVsX3BvbGljeSA/PyB7fSkgfVxuICAgICAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgICAgICAgZXhlY3V0aW9uX2dyYXBoOiAoYmFzZS51b2s/LmV4ZWN1dGlvbl9ncmFwaCB8fCBvdmVycmlkZS51b2s/LmV4ZWN1dGlvbl9ncmFwaClcbiAgICAgICAgICAgID8geyAuLi4oYmFzZS51b2s/LmV4ZWN1dGlvbl9ncmFwaCA/PyB7fSksIC4uLihvdmVycmlkZS51b2s/LmV4ZWN1dGlvbl9ncmFwaCA/PyB7fSkgfVxuICAgICAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgICAgICAgZ2l0b3BzOiAoYmFzZS51b2s/LmdpdG9wcyB8fCBvdmVycmlkZS51b2s/LmdpdG9wcylcbiAgICAgICAgICAgID8geyAuLi4oYmFzZS51b2s/LmdpdG9wcyA/PyB7fSksIC4uLihvdmVycmlkZS51b2s/LmdpdG9wcyA/PyB7fSkgfVxuICAgICAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgICAgICAgYXVkaXRfdW5pZmllZDogKGJhc2UudW9rPy5hdWRpdF91bmlmaWVkIHx8IG92ZXJyaWRlLnVvaz8uYXVkaXRfdW5pZmllZClcbiAgICAgICAgICAgID8geyAuLi4oYmFzZS51b2s/LmF1ZGl0X3VuaWZpZWQgPz8ge30pLCAuLi4ob3ZlcnJpZGUudW9rPy5hdWRpdF91bmlmaWVkID8/IHt9KSB9XG4gICAgICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICAgICAgICBwbGFuX3YyOiAoYmFzZS51b2s/LnBsYW5fdjIgfHwgb3ZlcnJpZGUudW9rPy5wbGFuX3YyKVxuICAgICAgICAgICAgPyB7IC4uLihiYXNlLnVvaz8ucGxhbl92MiA/PyB7fSksIC4uLihvdmVycmlkZS51b2s/LnBsYW5fdjIgPz8ge30pIH1cbiAgICAgICAgICAgIDogdW5kZWZpbmVkLFxuICAgICAgICB9XG4gICAgICA6IHVuZGVmaW5lZCxcbiAgICB0b2tlbl9wcm9maWxlOiBvdmVycmlkZS50b2tlbl9wcm9maWxlID8/IGJhc2UudG9rZW5fcHJvZmlsZSxcbiAgICBwaGFzZXM6IChiYXNlLnBoYXNlcyB8fCBvdmVycmlkZS5waGFzZXMpXG4gICAgICA/IHsgLi4uKGJhc2UucGhhc2VzID8/IHt9KSwgLi4uKG92ZXJyaWRlLnBoYXNlcyA/PyB7fSkgfVxuICAgICAgOiB1bmRlZmluZWQsXG4gICAgcGFyYWxsZWw6IChiYXNlLnBhcmFsbGVsIHx8IG92ZXJyaWRlLnBhcmFsbGVsKVxuICAgICAgPyB7IC4uLihiYXNlLnBhcmFsbGVsID8/IHt9KSwgLi4uKG92ZXJyaWRlLnBhcmFsbGVsID8/IHt9KSB9IGFzIGltcG9ydChcIi4vdHlwZXMuanNcIikuUGFyYWxsZWxDb25maWdcbiAgICAgIDogdW5kZWZpbmVkLFxuICAgIHZlcmlmaWNhdGlvbl9jb21tYW5kczogbWVyZ2VTdHJpbmdMaXN0cyhiYXNlLnZlcmlmaWNhdGlvbl9jb21tYW5kcywgb3ZlcnJpZGUudmVyaWZpY2F0aW9uX2NvbW1hbmRzKSxcbiAgICB2ZXJpZmljYXRpb25fYXV0b19maXg6IG92ZXJyaWRlLnZlcmlmaWNhdGlvbl9hdXRvX2ZpeCA/PyBiYXNlLnZlcmlmaWNhdGlvbl9hdXRvX2ZpeCxcbiAgICB2ZXJpZmljYXRpb25fbWF4X3JldHJpZXM6IG92ZXJyaWRlLnZlcmlmaWNhdGlvbl9tYXhfcmV0cmllcyA/PyBiYXNlLnZlcmlmaWNhdGlvbl9tYXhfcmV0cmllcyxcbiAgICBlbmhhbmNlZF92ZXJpZmljYXRpb246IG92ZXJyaWRlLmVuaGFuY2VkX3ZlcmlmaWNhdGlvbiA/PyBiYXNlLmVuaGFuY2VkX3ZlcmlmaWNhdGlvbixcbiAgICBlbmhhbmNlZF92ZXJpZmljYXRpb25fcHJlOiBvdmVycmlkZS5lbmhhbmNlZF92ZXJpZmljYXRpb25fcHJlID8/IGJhc2UuZW5oYW5jZWRfdmVyaWZpY2F0aW9uX3ByZSxcbiAgICBlbmhhbmNlZF92ZXJpZmljYXRpb25fcG9zdDogb3ZlcnJpZGUuZW5oYW5jZWRfdmVyaWZpY2F0aW9uX3Bvc3QgPz8gYmFzZS5lbmhhbmNlZF92ZXJpZmljYXRpb25fcG9zdCxcbiAgICBlbmhhbmNlZF92ZXJpZmljYXRpb25fc3RyaWN0OiBvdmVycmlkZS5lbmhhbmNlZF92ZXJpZmljYXRpb25fc3RyaWN0ID8/IGJhc2UuZW5oYW5jZWRfdmVyaWZpY2F0aW9uX3N0cmljdCxcbiAgICBzZWFyY2hfcHJvdmlkZXI6IG92ZXJyaWRlLnNlYXJjaF9wcm92aWRlciA/PyBiYXNlLnNlYXJjaF9wcm92aWRlcixcbiAgICBjb250ZXh0X3NlbGVjdGlvbjogb3ZlcnJpZGUuY29udGV4dF9zZWxlY3Rpb24gPz8gYmFzZS5jb250ZXh0X3NlbGVjdGlvbixcbiAgICBhdXRvX3Zpc3VhbGl6ZTogb3ZlcnJpZGUuYXV0b192aXN1YWxpemUgPz8gYmFzZS5hdXRvX3Zpc3VhbGl6ZSxcbiAgICBhdXRvX3JlcG9ydDogb3ZlcnJpZGUuYXV0b19yZXBvcnQgPz8gYmFzZS5hdXRvX3JlcG9ydCxcbiAgICBnaXRodWI6IChiYXNlLmdpdGh1YiB8fCBvdmVycmlkZS5naXRodWIpXG4gICAgICA/IHsgLi4uKGJhc2UuZ2l0aHViID8/IHt9KSwgLi4uKG92ZXJyaWRlLmdpdGh1YiA/PyB7fSkgfSBhcyBpbXBvcnQoXCIuLi9naXRodWItc3luYy90eXBlcy5qc1wiKS5HaXRIdWJTeW5jQ29uZmlnXG4gICAgICA6IHVuZGVmaW5lZCxcbiAgICBleHBlcmltZW50YWw6IChiYXNlLmV4cGVyaW1lbnRhbCB8fCBvdmVycmlkZS5leHBlcmltZW50YWwpXG4gICAgICA/IHsgLi4uKGJhc2UuZXhwZXJpbWVudGFsID8/IHt9KSwgLi4uKG92ZXJyaWRlLmV4cGVyaW1lbnRhbCA/PyB7fSkgfVxuICAgICAgOiB1bmRlZmluZWQsXG4gICAgc2VydmljZV90aWVyOiBvdmVycmlkZS5zZXJ2aWNlX3RpZXIgPz8gYmFzZS5zZXJ2aWNlX3RpZXIsXG4gICAgZm9yZW5zaWNzX2RlZHVwOiBvdmVycmlkZS5mb3JlbnNpY3NfZGVkdXAgPz8gYmFzZS5mb3JlbnNpY3NfZGVkdXAsXG4gICAgc2hvd190b2tlbl9jb3N0OiBvdmVycmlkZS5zaG93X3Rva2VuX2Nvc3QgPz8gYmFzZS5zaG93X3Rva2VuX2Nvc3QsXG4gICAgbWluX3JlcXVlc3RfaW50ZXJ2YWxfbXM6IG92ZXJyaWRlLm1pbl9yZXF1ZXN0X2ludGVydmFsX21zID8/IGJhc2UubWluX3JlcXVlc3RfaW50ZXJ2YWxfbXMsXG4gICAgY29kZWJhc2U6IChiYXNlLmNvZGViYXNlIHx8IG92ZXJyaWRlLmNvZGViYXNlKVxuICAgICAgPyB7XG4gICAgICAgICAgLi4uKGJhc2UuY29kZWJhc2UgPz8ge30pLFxuICAgICAgICAgIC4uLihvdmVycmlkZS5jb2RlYmFzZSA/PyB7fSksXG4gICAgICAgICAgLy8gTWVyZ2UgZXhjbHVkZV9wYXR0ZXJucyBhcnJheXMgcmF0aGVyIHRoYW4gb3ZlcnJpZGluZ1xuICAgICAgICAgIGV4Y2x1ZGVfcGF0dGVybnM6IFtcbiAgICAgICAgICAgIC4uLigoYmFzZS5jb2RlYmFzZT8uZXhjbHVkZV9wYXR0ZXJucykgPz8gW10pLFxuICAgICAgICAgICAgLi4uKChvdmVycmlkZS5jb2RlYmFzZT8uZXhjbHVkZV9wYXR0ZXJucykgPz8gW10pLFxuICAgICAgICAgIF0uZmlsdGVyKEJvb2xlYW4pLFxuICAgICAgICB9XG4gICAgICA6IHVuZGVmaW5lZCxcbiAgICBzbGljZV9wYXJhbGxlbDogKGJhc2Uuc2xpY2VfcGFyYWxsZWwgfHwgb3ZlcnJpZGUuc2xpY2VfcGFyYWxsZWwpXG4gICAgICA/IHsgLi4uKGJhc2Uuc2xpY2VfcGFyYWxsZWwgPz8ge30pLCAuLi4ob3ZlcnJpZGUuc2xpY2VfcGFyYWxsZWwgPz8ge30pIH1cbiAgICAgIDogdW5kZWZpbmVkLFxuICAgIGxhbmd1YWdlOiBvdmVycmlkZS5sYW5ndWFnZSA/PyBiYXNlLmxhbmd1YWdlLFxuICAgIHBsYW5uaW5nX2RlcHRoOiBvdmVycmlkZS5wbGFubmluZ19kZXB0aCA/PyBiYXNlLnBsYW5uaW5nX2RlcHRoLFxuICB9O1xufVxuXG5mdW5jdGlvbiBtZXJnZVN0cmluZ0xpc3RzKGJhc2U/OiB1bmtub3duLCBvdmVycmlkZT86IHVua25vd24pOiBzdHJpbmdbXSB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IG1lcmdlZCA9IFtcbiAgICAuLi5ub3JtYWxpemVTdHJpbmdBcnJheShiYXNlKSxcbiAgICAuLi5ub3JtYWxpemVTdHJpbmdBcnJheShvdmVycmlkZSksXG4gIF1cbiAgICAubWFwKChpdGVtKSA9PiBpdGVtLnRyaW0oKSlcbiAgICAuZmlsdGVyKEJvb2xlYW4pO1xuICByZXR1cm4gbWVyZ2VkLmxlbmd0aCA+IDAgPyBBcnJheS5mcm9tKG5ldyBTZXQobWVyZ2VkKSkgOiB1bmRlZmluZWQ7XG59XG5cbmZ1bmN0aW9uIG1lcmdlUG9zdFVuaXRIb29rcyhcbiAgYmFzZT86IFBvc3RVbml0SG9va0NvbmZpZ1tdLFxuICBvdmVycmlkZT86IFBvc3RVbml0SG9va0NvbmZpZ1tdLFxuKTogUG9zdFVuaXRIb29rQ29uZmlnW10gfCB1bmRlZmluZWQge1xuICBpZiAoIWJhc2U/Lmxlbmd0aCAmJiAhb3ZlcnJpZGU/Lmxlbmd0aCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgY29uc3QgbWVyZ2VkID0gWy4uLihiYXNlID8/IFtdKV07XG4gIGZvciAoY29uc3QgaG9vayBvZiBvdmVycmlkZSA/PyBbXSkge1xuICAgIC8vIE92ZXJyaWRlIGhvb2tzIHdpdGggc2FtZSBuYW1lIHJlcGxhY2UgYmFzZSBob29rc1xuICAgIGNvbnN0IGlkeCA9IG1lcmdlZC5maW5kSW5kZXgoaCA9PiBoLm5hbWUgPT09IGhvb2submFtZSk7XG4gICAgaWYgKGlkeCA+PSAwKSB7XG4gICAgICBtZXJnZWRbaWR4XSA9IGhvb2s7XG4gICAgfSBlbHNlIHtcbiAgICAgIG1lcmdlZC5wdXNoKGhvb2spO1xuICAgIH1cbiAgfVxuICByZXR1cm4gbWVyZ2VkLmxlbmd0aCA+IDAgPyBtZXJnZWQgOiB1bmRlZmluZWQ7XG59XG5cbmZ1bmN0aW9uIG1lcmdlUHJlRGlzcGF0Y2hIb29rcyhcbiAgYmFzZT86IFByZURpc3BhdGNoSG9va0NvbmZpZ1tdLFxuICBvdmVycmlkZT86IFByZURpc3BhdGNoSG9va0NvbmZpZ1tdLFxuKTogUHJlRGlzcGF0Y2hIb29rQ29uZmlnW10gfCB1bmRlZmluZWQge1xuICBpZiAoIWJhc2U/Lmxlbmd0aCAmJiAhb3ZlcnJpZGU/Lmxlbmd0aCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgY29uc3QgbWVyZ2VkID0gWy4uLihiYXNlID8/IFtdKV07XG4gIGZvciAoY29uc3QgaG9vayBvZiBvdmVycmlkZSA/PyBbXSkge1xuICAgIGNvbnN0IGlkeCA9IG1lcmdlZC5maW5kSW5kZXgoaCA9PiBoLm5hbWUgPT09IGhvb2submFtZSk7XG4gICAgaWYgKGlkeCA+PSAwKSB7XG4gICAgICBtZXJnZWRbaWR4XSA9IGhvb2s7XG4gICAgfSBlbHNlIHtcbiAgICAgIG1lcmdlZC5wdXNoKGhvb2spO1xuICAgIH1cbiAgfVxuICByZXR1cm4gbWVyZ2VkLmxlbmd0aCA+IDAgPyBtZXJnZWQgOiB1bmRlZmluZWQ7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTeXN0ZW0gUHJvbXB0IFJlbmRlcmluZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlclByZWZlcmVuY2VzRm9yU3lzdGVtUHJvbXB0KHByZWZlcmVuY2VzOiBHU0RQcmVmZXJlbmNlcywgcmVzb2x1dGlvbnM/OiBNYXA8c3RyaW5nLCBTa2lsbFJlc29sdXRpb24+KTogc3RyaW5nIHtcbiAgY29uc3QgdmFsaWRhdGVkID0gdmFsaWRhdGVQcmVmZXJlbmNlcyhwcmVmZXJlbmNlcyk7XG4gIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtcIiMjIEdTRCBTa2lsbCBQcmVmZXJlbmNlc1wiXTtcblxuICBpZiAodmFsaWRhdGVkLmVycm9ycy5sZW5ndGggPiAwKSB7XG4gICAgbGluZXMucHVzaChcIi0gVmFsaWRhdGlvbjogc29tZSBwcmVmZXJlbmNlIHZhbHVlcyB3ZXJlIGlnbm9yZWQgYmVjYXVzZSB0aGV5IHdlcmUgaW52YWxpZC5cIik7XG4gIH1cbiAgZm9yIChjb25zdCB3YXJuaW5nIG9mIHZhbGlkYXRlZC53YXJuaW5ncykge1xuICAgIGxpbmVzLnB1c2goYC0gRGVwcmVjYXRpb246ICR7d2FybmluZ31gKTtcbiAgfVxuXG4gIHByZWZlcmVuY2VzID0gdmFsaWRhdGVkLnByZWZlcmVuY2VzO1xuXG4gIGxpbmVzLnB1c2goXG4gICAgXCItIFRyZWF0IHRoZXNlIGFzIGV4cGxpY2l0IHNraWxsLXNlbGVjdGlvbiBwb2xpY3kgZm9yIEdTRCB3b3JrLlwiLFxuICAgIFwiLSBJZiBhIGxpc3RlZCBza2lsbCBleGlzdHMgYW5kIGlzIHJlbGV2YW50LCBsb2FkIGFuZCBmb2xsb3cgaXQgaW5zdGVhZCBvZiB0cmVhdGluZyBpdCBhcyBhIHZhZ3VlIHN1Z2dlc3Rpb24uXCIsXG4gICAgXCItIEN1cnJlbnQgdXNlciBpbnN0cnVjdGlvbnMgc3RpbGwgb3ZlcnJpZGUgdGhlc2UgZGVmYXVsdHMuXCIsXG4gICk7XG5cbiAgY29uc3QgZm10ID0gKHJlZjogc3RyaW5nKSA9PiByZXNvbHV0aW9ucyA/IGZvcm1hdFNraWxsUmVmKHJlZiwgcmVzb2x1dGlvbnMpIDogcmVmO1xuXG4gIGlmIChwcmVmZXJlbmNlcy5hbHdheXNfdXNlX3NraWxscyAmJiBwcmVmZXJlbmNlcy5hbHdheXNfdXNlX3NraWxscy5sZW5ndGggPiAwKSB7XG4gICAgbGluZXMucHVzaChcIi0gQWx3YXlzIHVzZSB0aGVzZSBza2lsbHMgd2hlbiByZWxldmFudDpcIik7XG4gICAgZm9yIChjb25zdCBza2lsbCBvZiBwcmVmZXJlbmNlcy5hbHdheXNfdXNlX3NraWxscykge1xuICAgICAgbGluZXMucHVzaChgICAtICR7Zm10KHNraWxsKX1gKTtcbiAgICB9XG4gIH1cblxuICBpZiAocHJlZmVyZW5jZXMucHJlZmVyX3NraWxscyAmJiBwcmVmZXJlbmNlcy5wcmVmZXJfc2tpbGxzLmxlbmd0aCA+IDApIHtcbiAgICBsaW5lcy5wdXNoKFwiLSBQcmVmZXIgdGhlc2Ugc2tpbGxzIHdoZW4gcmVsZXZhbnQ6XCIpO1xuICAgIGZvciAoY29uc3Qgc2tpbGwgb2YgcHJlZmVyZW5jZXMucHJlZmVyX3NraWxscykge1xuICAgICAgbGluZXMucHVzaChgICAtICR7Zm10KHNraWxsKX1gKTtcbiAgICB9XG4gIH1cblxuICBpZiAocHJlZmVyZW5jZXMuYXZvaWRfc2tpbGxzICYmIHByZWZlcmVuY2VzLmF2b2lkX3NraWxscy5sZW5ndGggPiAwKSB7XG4gICAgbGluZXMucHVzaChcIi0gQXZvaWQgdGhlc2Ugc2tpbGxzIHVubGVzcyBjbGVhcmx5IG5lZWRlZDpcIik7XG4gICAgZm9yIChjb25zdCBza2lsbCBvZiBwcmVmZXJlbmNlcy5hdm9pZF9za2lsbHMpIHtcbiAgICAgIGxpbmVzLnB1c2goYCAgLSAke2ZtdChza2lsbCl9YCk7XG4gICAgfVxuICB9XG5cbiAgaWYgKHByZWZlcmVuY2VzLnNraWxsX3J1bGVzICYmIHByZWZlcmVuY2VzLnNraWxsX3J1bGVzLmxlbmd0aCA+IDApIHtcbiAgICBsaW5lcy5wdXNoKFwiLSBTaXR1YXRpb25hbCBydWxlczpcIik7XG4gICAgZm9yIChjb25zdCBydWxlIG9mIHByZWZlcmVuY2VzLnNraWxsX3J1bGVzKSB7XG4gICAgICBsaW5lcy5wdXNoKGAgIC0gV2hlbiAke3J1bGUud2hlbn06YCk7XG4gICAgICBpZiAocnVsZS51c2UgJiYgcnVsZS51c2UubGVuZ3RoID4gMCkge1xuICAgICAgICBsaW5lcy5wdXNoKGAgICAgLSB1c2U6ICR7cnVsZS51c2UubWFwKGZtdCkuam9pbihcIiwgXCIpfWApO1xuICAgICAgfVxuICAgICAgaWYgKHJ1bGUucHJlZmVyICYmIHJ1bGUucHJlZmVyLmxlbmd0aCA+IDApIHtcbiAgICAgICAgbGluZXMucHVzaChgICAgIC0gcHJlZmVyOiAke3J1bGUucHJlZmVyLm1hcChmbXQpLmpvaW4oXCIsIFwiKX1gKTtcbiAgICAgIH1cbiAgICAgIGlmIChydWxlLmF2b2lkICYmIHJ1bGUuYXZvaWQubGVuZ3RoID4gMCkge1xuICAgICAgICBsaW5lcy5wdXNoKGAgICAgLSBhdm9pZDogJHtydWxlLmF2b2lkLm1hcChmbXQpLmpvaW4oXCIsIFwiKX1gKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBpZiAocHJlZmVyZW5jZXMuY3VzdG9tX2luc3RydWN0aW9ucyAmJiBwcmVmZXJlbmNlcy5jdXN0b21faW5zdHJ1Y3Rpb25zLmxlbmd0aCA+IDApIHtcbiAgICBsaW5lcy5wdXNoKFwiLSBBZGRpdGlvbmFsIGluc3RydWN0aW9uczpcIik7XG4gICAgZm9yIChjb25zdCBpbnN0cnVjdGlvbiBvZiBwcmVmZXJlbmNlcy5jdXN0b21faW5zdHJ1Y3Rpb25zKSB7XG4gICAgICBsaW5lcy5wdXNoKGAgIC0gJHtpbnN0cnVjdGlvbn1gKTtcbiAgICB9XG4gIH1cblxuICBpZiAocHJlZmVyZW5jZXMubGFuZ3VhZ2UpIHtcbiAgICBjb25zdCBzYWZlTGFuZyA9IHByZWZlcmVuY2VzLmxhbmd1YWdlLnJlcGxhY2UoL1tcXHJcXG5dL2csIFwiIFwiKS5zbGljZSgwLCA1MCk7XG4gICAgbGluZXMucHVzaChgLSBMYW5ndWFnZTogQWx3YXlzIHJlc3BvbmQgaW4gJHtzYWZlTGFuZ30uYCk7XG4gIH1cblxuICByZXR1cm4gbGluZXMuam9pbihcIlxcblwiKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEhvb2sgUmVzb2x1dGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBSZXNvbHZlIGVuYWJsZWQgcG9zdC11bml0IGhvb2tzIGZyb20gZWZmZWN0aXZlIHByZWZlcmVuY2VzLlxuICogUmV0dXJucyBhbiBlbXB0eSBhcnJheSB3aGVuIG5vIGhvb2tzIGFyZSBjb25maWd1cmVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZVBvc3RVbml0SG9va3MoKTogUG9zdFVuaXRIb29rQ29uZmlnW10ge1xuICBjb25zdCBwcmVmcyA9IGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcygpO1xuICByZXR1cm4gKHByZWZzPy5wcmVmZXJlbmNlcy5wb3N0X3VuaXRfaG9va3MgPz8gW10pXG4gICAgLmZpbHRlcihoID0+IGguZW5hYmxlZCAhPT0gZmFsc2UpO1xufVxuXG4vKipcbiAqIFJlc29sdmUgZW5hYmxlZCBwcmUtZGlzcGF0Y2ggaG9va3MgZnJvbSBlZmZlY3RpdmUgcHJlZmVyZW5jZXMuXG4gKiBSZXR1cm5zIGFuIGVtcHR5IGFycmF5IHdoZW4gbm8gaG9va3MgYXJlIGNvbmZpZ3VyZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlUHJlRGlzcGF0Y2hIb29rcygpOiBQcmVEaXNwYXRjaEhvb2tDb25maWdbXSB7XG4gIGNvbnN0IHByZWZzID0gbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzKCk7XG4gIHJldHVybiAocHJlZnM/LnByZWZlcmVuY2VzLnByZV9kaXNwYXRjaF9ob29rcyA/PyBbXSlcbiAgICAuZmlsdGVyKGggPT4gaC5lbmFibGVkICE9PSBmYWxzZSk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBJc29sYXRpb24gJiBQYXJhbGxlbCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBSZXNvbHZlIHRoZSBlZmZlY3RpdmUgZ2l0IGlzb2xhdGlvbiBtb2RlIGZyb20gcHJlZmVyZW5jZXMuXG4gKiBSZXR1cm5zIFwibm9uZVwiIChkZWZhdWx0KSwgXCJ3b3JrdHJlZVwiLCBvciBcImJyYW5jaFwiLlxuICpcbiAqIERlZmF1bHQgaXMgXCJub25lXCIgc28gR1NEIHdvcmtzIG91dCBvZiB0aGUgYm94IHdpdGhvdXQgcHJlZmVyZW5jZXMubWQuXG4gKiBXb3JrdHJlZSBpc29sYXRpb24gcmVxdWlyZXMgZXhwbGljaXQgb3B0LWluIGJlY2F1c2UgaXQgZGVwZW5kcyBvbiBnaXRcbiAqIGJyYW5jaCBpbmZyYXN0cnVjdHVyZSB0aGF0IG11c3QgYmUgc2V0IHVwIGJlZm9yZSB1c2UuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRJc29sYXRpb25Nb2RlKGJhc2VQYXRoPzogc3RyaW5nKTogXCJub25lXCIgfCBcIndvcmt0cmVlXCIgfCBcImJyYW5jaFwiIHtcbiAgY29uc3QgcHJlZnMgPSBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMoYmFzZVBhdGgpPy5wcmVmZXJlbmNlcz8uZ2l0O1xuICBpZiAocHJlZnM/Lmlzb2xhdGlvbiA9PT0gXCJ3b3JrdHJlZVwiKSB7XG4gICAgaWYgKGJhc2VQYXRoICYmIG5hdGl2ZUlzUmVwbyhiYXNlUGF0aCkgJiYgIW5hdGl2ZUhhc0NvbW1pdHRlZEhlYWQoYmFzZVBhdGgpKSByZXR1cm4gXCJub25lXCI7XG4gICAgcmV0dXJuIFwid29ya3RyZWVcIjtcbiAgfVxuICBpZiAocHJlZnM/Lmlzb2xhdGlvbiA9PT0gXCJicmFuY2hcIikgcmV0dXJuIFwiYnJhbmNoXCI7XG4gIHJldHVybiBcIm5vbmVcIjsgLy8gZGVmYXVsdCBcdTIwMTQgbm8gaXNvbGF0aW9uLCB3b3JrIG9uIGN1cnJlbnQgYnJhbmNoXG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlUGFyYWxsZWxDb25maWcocHJlZnM6IEdTRFByZWZlcmVuY2VzIHwgdW5kZWZpbmVkKTogaW1wb3J0KFwiLi90eXBlcy5qc1wiKS5QYXJhbGxlbENvbmZpZyB7XG4gIHJldHVybiB7XG4gICAgZW5hYmxlZDogcHJlZnM/LnBhcmFsbGVsPy5lbmFibGVkID8/IGZhbHNlLFxuICAgIG1heF93b3JrZXJzOiBNYXRoLm1heCgxLCBNYXRoLm1pbig0LCBwcmVmcz8ucGFyYWxsZWw/Lm1heF93b3JrZXJzID8/IDIpKSxcbiAgICBidWRnZXRfY2VpbGluZzogcHJlZnM/LnBhcmFsbGVsPy5idWRnZXRfY2VpbGluZyxcbiAgICBtZXJnZV9zdHJhdGVneTogcHJlZnM/LnBhcmFsbGVsPy5tZXJnZV9zdHJhdGVneSA/PyBcInBlci1taWxlc3RvbmVcIixcbiAgICBhdXRvX21lcmdlOiBwcmVmcz8ucGFyYWxsZWw/LmF1dG9fbWVyZ2UgPz8gXCJjb25maXJtXCIsXG4gICAgd29ya2VyX21vZGVsOiBwcmVmcz8ucGFyYWxsZWw/Lndvcmtlcl9tb2RlbCxcbiAgfTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQVlBLFNBQVMsWUFBWSxvQkFBb0I7QUFDekMsU0FBUyxlQUFlO0FBQ3hCLFNBQVMsWUFBWTtBQUVyQixTQUFTLGVBQWU7QUFDeEIsU0FBUyxTQUFTLGlCQUFpQjtBQUduQyxTQUFTLDRCQUE0QjtBQUNyQyxTQUFTLGtCQUFrQjtBQUMzQixTQUFTLDBCQUEwQiwrQkFBK0I7QUFDbEUsU0FBUyx3QkFBd0Isb0JBQW9CO0FBRXJEO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQU1BO0FBQUEsT0FDSztBQUNQLFNBQVMsMkJBQTJCO0FBQ3BDLFNBQVMsZUFBZTtBQThCeEIsU0FBUyx1QkFBQUEsNEJBQTJCO0FBR3BDLFNBQVMsaUNBQWlDO0FBS25DLFNBQVMsMEJBQTBCLFVBQXVDO0FBQy9FLFFBQU0sUUFBUSw0QkFBNEIsUUFBUTtBQUNsRCxTQUFPLE9BQU8sWUFBWSxtQkFBbUI7QUFDL0M7QUFFTyxTQUFTLDBCQUEwQixVQUEyQjtBQUNuRSxRQUFNLFFBQVEsNEJBQTRCLFFBQVE7QUFDbEQsU0FBTyxPQUFPLFlBQVksd0JBQXdCO0FBQ3BEO0FBR0E7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtB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
