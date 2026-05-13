import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getGlobalGSDPreferencesPath,
  getLegacyGlobalGSDPreferencesPath,
  getProjectGSDPreferencesPath,
  loadGlobalGSDPreferences,
  loadProjectGSDPreferences,
  loadEffectiveGSDPreferences,
  resolveAllSkillReferences
} from "./preferences.js";
import { loadFile, saveFile, splitFrontmatter, parseFrontmatterMap } from "./files.js";
import { runClaudeImportFlow } from "./claude-import.js";
function extractBodyAfterFrontmatter(content) {
  const closingIdx = content.indexOf("\n---", content.indexOf("---"));
  if (closingIdx === -1) return null;
  const afterFrontmatter = content.slice(closingIdx + 4);
  return afterFrontmatter.trim() ? afterFrontmatter : null;
}
function tryParseInteger(val) {
  return /^\d+$/.test(val) ? Number(val) : null;
}
function tryParseNumber(val) {
  const n = Number(val);
  return !isNaN(n) && isFinite(n) ? n : null;
}
function tryParsePercentage(val) {
  const n = Number(val);
  return !isNaN(n) && n >= 0 && n <= 100 ? n : null;
}
async function promptBoolean(ctx, label, current, defaultVal) {
  const currentStr = typeof current === "boolean" ? String(current) : "";
  const suffix = currentStr ? ` (current: ${currentStr})` : defaultVal !== void 0 ? ` (default: ${defaultVal})` : "";
  const choice = await ctx.ui.select(`${label}${suffix}:`, ["true", "false", "(keep current)"]);
  if (!choice || choice === "(keep current)") return void 0;
  return choice === "true";
}
async function promptEnum(ctx, label, current, values, defaultVal) {
  const currentStr = typeof current === "string" ? current : "";
  const suffix = currentStr ? ` (current: ${currentStr})` : defaultVal ? ` (default: ${defaultVal})` : "";
  const options = [...values, "(keep current)"];
  const choice = await ctx.ui.select(`${label}${suffix}:`, options);
  if (!choice || typeof choice !== "string" || choice === "(keep current)") return void 0;
  return choice;
}
async function promptInteger(ctx, label, current, defaultVal) {
  const hadValue = current !== void 0 && current !== null;
  const currentStr = hadValue ? String(current) : "";
  const suffix = currentStr ? ` (current: ${currentStr})` : defaultVal ? ` (default: ${defaultVal})` : "";
  const input = await ctx.ui.input(`${label}${suffix}:`, currentStr || (defaultVal ?? ""));
  if (input === null || input === void 0) return void 0;
  const val = input.trim();
  if (!val) return hadValue ? "clear" : void 0;
  const parsed = tryParseInteger(val);
  if (parsed === null) {
    ctx.ui.notify(`Invalid value "${val}" for ${label} \u2014 must be a whole number. Keeping previous value.`, "warning");
    return void 0;
  }
  return parsed;
}
async function promptNumber(ctx, label, current, defaultVal) {
  const hadValue = current !== void 0 && current !== null;
  const currentStr = hadValue ? String(current) : "";
  const suffix = currentStr ? ` (current: ${currentStr})` : defaultVal ? ` (default: ${defaultVal})` : "";
  const input = await ctx.ui.input(`${label}${suffix}:`, currentStr || (defaultVal ?? ""));
  if (input === null || input === void 0) return void 0;
  const val = input.trim();
  if (!val) return hadValue ? "clear" : void 0;
  const parsed = tryParseNumber(val);
  if (parsed === null) {
    ctx.ui.notify(`Invalid value "${val}" for ${label} \u2014 must be a number. Keeping previous value.`, "warning");
    return void 0;
  }
  return parsed;
}
function applyNumber(prefs, key, result) {
  if (result === void 0) return;
  if (result === "clear") delete prefs[key];
  else prefs[key] = result;
}
async function promptString(ctx, label, current, defaultVal) {
  const currentStr = typeof current === "string" ? current : "";
  const suffix = currentStr ? ` (current: ${currentStr})` : defaultVal ? ` (default: ${defaultVal})` : "";
  const input = await ctx.ui.input(`${label}${suffix}:`, currentStr || (defaultVal ?? ""));
  if (input === null || input === void 0) return void 0;
  return input.trim();
}
function parseStringList(input) {
  return input.split(/[,\n]/).map((s) => s.trim()).filter((s) => s.length > 0);
}
async function editStringListField(ctx, prefs, key, label) {
  const current = Array.isArray(prefs[key]) ? [...prefs[key]] : [];
  let list = current;
  while (true) {
    const summary = list.length === 0 ? "(empty)" : `${list.length} item(s): ${list.slice(0, 3).join(", ")}${list.length > 3 ? "\u2026" : ""}`;
    const choice = await ctx.ui.select(
      `${label} \u2014 ${summary}`,
      ["Add entries", "Remove entry", "Clear all", "Done"]
    );
    const pick = typeof choice === "string" ? choice : "";
    if (!pick || pick === "Done") break;
    if (pick === "Add entries") {
      const input = await ctx.ui.input(`Add to ${label} (comma- or newline-separated):`, "");
      if (input) {
        for (const item of parseStringList(input)) {
          if (!list.includes(item)) list.push(item);
        }
      }
    } else if (pick === "Remove entry") {
      if (list.length === 0) continue;
      const removeChoice = await ctx.ui.select(`Remove which entry?`, [...list, "(cancel)"]);
      const removeStr = typeof removeChoice === "string" ? removeChoice : "";
      if (removeStr && removeStr !== "(cancel)") {
        list = list.filter((x) => x !== removeStr);
      }
    } else if (pick === "Clear all") {
      list = [];
    }
  }
  if (list.length > 0) {
    prefs[key] = list;
  } else if (prefs[key] !== void 0) {
    delete prefs[key];
  }
}
function setNested(parent, parentKey, childKey, value) {
  let child = parent[parentKey];
  if (!child || typeof child !== "object") child = {};
  if (value === void 0) return;
  child[childKey] = value;
  parent[parentKey] = child;
}
async function handlePrefs(args, ctx) {
  const trimmed = args.trim();
  if (trimmed === "" || trimmed === "global" || trimmed === "wizard" || trimmed === "setup" || trimmed === "wizard global" || trimmed === "setup global") {
    await ensurePreferencesFile(getGlobalGSDPreferencesPath(), ctx, "global");
    await handlePrefsWizard(ctx, "global");
    return;
  }
  if (trimmed === "project" || trimmed === "wizard project" || trimmed === "setup project") {
    await ensurePreferencesFile(getProjectGSDPreferencesPath(), ctx, "project");
    await handlePrefsWizard(ctx, "project");
    return;
  }
  if (trimmed === "import-claude" || trimmed === "import-claude global") {
    await handleImportClaude(ctx, "global");
    return;
  }
  if (trimmed === "import-claude project") {
    await handleImportClaude(ctx, "project");
    return;
  }
  if (trimmed === "status") {
    const globalPrefs = loadGlobalGSDPreferences();
    const projectPrefs = loadProjectGSDPreferences();
    const canonicalGlobal = getGlobalGSDPreferencesPath();
    const legacyGlobal = getLegacyGlobalGSDPreferencesPath();
    const globalStatus = globalPrefs ? `present: ${globalPrefs.path}${globalPrefs.path === legacyGlobal ? " (legacy fallback)" : ""}` : `missing: ${canonicalGlobal}`;
    const projectStatus = projectPrefs ? `present: ${projectPrefs.path}` : `missing: ${getProjectGSDPreferencesPath()}`;
    const lines = [`GSD skill prefs \u2014 global ${globalStatus}; project ${projectStatus}`];
    const effective = loadEffectiveGSDPreferences();
    let hasUnresolved = false;
    if (effective) {
      const report = resolveAllSkillReferences(effective.preferences, process.cwd());
      const resolved = [...report.resolutions.values()].filter((r) => r.method !== "unresolved");
      hasUnresolved = report.warnings.length > 0;
      if (resolved.length > 0 || hasUnresolved) {
        lines.push(`Skills: ${resolved.length} resolved, ${report.warnings.length} unresolved`);
      }
      if (hasUnresolved) {
        lines.push(`Unresolved: ${report.warnings.join(", ")}`);
      }
    }
    ctx.ui.notify(lines.join("\n"), hasUnresolved ? "warning" : "info");
    return;
  }
  ctx.ui.notify("Usage: /gsd prefs [global|project|status|wizard|setup|import-claude [global|project]]", "info");
}
async function handleImportClaude(ctx, scope) {
  const path = scope === "project" ? getProjectGSDPreferencesPath() : getGlobalGSDPreferencesPath();
  if (!existsSync(path)) {
    await ensurePreferencesFile(path, ctx, scope);
  }
  const readPrefs = () => {
    if (!existsSync(path)) return { version: 1 };
    const content = readFileSync(path, "utf-8");
    const [frontmatterLines] = splitFrontmatter(content);
    return frontmatterLines ? parseFrontmatterMap(frontmatterLines) : { version: 1 };
  };
  const writePrefs = async (prefs) => {
    prefs.version = prefs.version || 1;
    const frontmatter = serializePreferencesToFrontmatter(prefs);
    let body = "\n# GSD Skill Preferences\n\nSee `~/.gsd/agent/extensions/gsd/docs/preferences-reference.md` for full field documentation and examples.\n";
    if (existsSync(path)) {
      const preserved = extractBodyAfterFrontmatter(readFileSync(path, "utf-8"));
      if (preserved) body = preserved;
    }
    await saveFile(path, `---
${frontmatter}---${body}`);
  };
  await runClaudeImportFlow(ctx, scope, readPrefs, writePrefs);
}
async function handlePrefsMode(ctx, scope) {
  const path = scope === "project" ? getProjectGSDPreferencesPath() : getGlobalGSDPreferencesPath();
  const existing = scope === "project" ? loadProjectGSDPreferences() : loadGlobalGSDPreferences();
  const prefs = existing?.preferences ? { ...existing.preferences } : {};
  await configureMode(ctx, prefs);
  prefs.version = prefs.version || 1;
  const frontmatter = serializePreferencesToFrontmatter(prefs);
  let body = "\n# GSD Skill Preferences\n\nSee `~/.gsd/agent/extensions/gsd/docs/preferences-reference.md` for full field documentation and examples.\n";
  if (existsSync(path)) {
    const preserved = extractBodyAfterFrontmatter(readFileSync(path, "utf-8"));
    if (preserved) body = preserved;
  }
  const content = `---
${frontmatter}---${body}`;
  await saveFile(path, content);
  await ctx.waitForIdle();
  await ctx.reload();
  ctx.ui.notify(`Saved ${scope} preferences to ${path}`, "info");
}
function buildCategorySummaries(prefs) {
  const mode = prefs.mode;
  const modeSummary = mode ?? "(not set)";
  const models = prefs.models;
  const tokenProfile = prefs.token_profile;
  const serviceTier = prefs.service_tier;
  const flatRate = Array.isArray(prefs.flat_rate_providers) ? prefs.flat_rate_providers.length : 0;
  const dynRouting = prefs.dynamic_routing;
  let modelsSummary = "(not configured)";
  {
    const parts = [];
    if (models && Object.keys(models).length > 0) {
      parts.push(`${Object.keys(models).length} phase(s)`);
    }
    if (tokenProfile) parts.push(`profile: ${tokenProfile}`);
    if (serviceTier) parts.push(`tier: ${serviceTier}`);
    if (flatRate) parts.push(`flat-rate: ${flatRate}`);
    if (dynRouting?.enabled) parts.push("routing: on");
    if (parts.length > 0) modelsSummary = parts.join(", ");
  }
  const autoSup = prefs.auto_supervisor;
  let timeoutsSummary = "(defaults)";
  if (autoSup && Object.keys(autoSup).length > 0) {
    const soft = autoSup.soft_timeout_minutes ?? "20";
    const idle = autoSup.idle_timeout_minutes ?? "10";
    const hard = autoSup.hard_timeout_minutes ?? "30";
    timeoutsSummary = `soft: ${soft}m, idle: ${idle}m, hard: ${hard}m`;
  }
  const git = prefs.git;
  const staleThreshold = prefs.stale_commit_threshold_minutes;
  const absorbSnapshots = git?.absorb_snapshot_commits;
  let gitSummary = "(defaults)";
  {
    const parts = [];
    if (git && Object.keys(git).length > 0) {
      const branch = git.main_branch ?? "main";
      const push = git.auto_push ? "on" : "off";
      parts.push(`main: ${branch}, push: ${push}`);
    }
    if (staleThreshold !== void 0) {
      parts.push(`stale: ${staleThreshold === 0 ? "off" : `${staleThreshold}m`}`);
    }
    if (absorbSnapshots !== void 0) {
      parts.push(`absorb: ${absorbSnapshots ? "on" : "off"}`);
    }
    if (parts.length > 0) gitSummary = parts.join(", ");
  }
  const discovery = prefs.skill_discovery;
  const uat = prefs.uat_dispatch;
  const alwaysUse = Array.isArray(prefs.always_use_skills) ? prefs.always_use_skills.length : 0;
  const preferS = Array.isArray(prefs.prefer_skills) ? prefs.prefer_skills.length : 0;
  const avoidS = Array.isArray(prefs.avoid_skills) ? prefs.avoid_skills.length : 0;
  const rulesCount = Array.isArray(prefs.skill_rules) ? prefs.skill_rules.length : 0;
  const customInstr = Array.isArray(prefs.custom_instructions) ? prefs.custom_instructions.length : 0;
  let skillsSummary = "(not configured)";
  {
    const parts = [];
    if (discovery) parts.push(`discovery: ${discovery}`);
    if (uat !== void 0) parts.push(`uat: ${uat}`);
    if (alwaysUse) parts.push(`always: ${alwaysUse}`);
    if (preferS) parts.push(`prefer: ${preferS}`);
    if (avoidS) parts.push(`avoid: ${avoidS}`);
    if (rulesCount) parts.push(`rules: ${rulesCount}`);
    if (customInstr) parts.push(`custom: ${customInstr}`);
    if (prefs.skill_staleness_days !== void 0) parts.push(`stale: ${prefs.skill_staleness_days}d`);
    if (parts.length > 0) skillsSummary = parts.join(", ");
  }
  const ceiling = prefs.budget_ceiling;
  const enforcement = prefs.budget_enforcement;
  let budgetSummary = "(no limit)";
  if (ceiling !== void 0) {
    budgetSummary = `$${ceiling}`;
    if (enforcement) budgetSummary += ` / ${enforcement}`;
  } else if (enforcement) {
    budgetSummary = enforcement;
  }
  const notif = prefs.notifications;
  let notifSummary = "(defaults)";
  if (notif && Object.keys(notif).length > 0) {
    const allKeys = ["enabled", "on_complete", "on_error", "on_budget", "on_milestone", "on_attention"];
    const enabledCount = allKeys.filter((k) => notif[k] !== false).length;
    notifSummary = `${enabledCount}/${allKeys.length} enabled`;
  }
  const uniqueIds = prefs.unique_milestone_ids;
  const experimentalRtk = prefs.experimental?.rtk;
  let advancedSummary = "(defaults)";
  {
    const parts = [];
    if (uniqueIds !== void 0) parts.push(`unique: ${uniqueIds ? "on" : "off"}`);
    if (prefs.auto_visualize !== void 0) parts.push(`viz: ${prefs.auto_visualize ? "on" : "off"}`);
    if (prefs.auto_report !== void 0) parts.push(`report: ${prefs.auto_report ? "on" : "off"}`);
    if (prefs.show_token_cost) parts.push("cost-display");
    if (prefs.forensics_dedup) parts.push("forensics-dedup");
    if (prefs.widget_mode) parts.push(`widget: ${prefs.widget_mode}`);
    if (experimentalRtk) parts.push("rtk");
    if (parts.length > 0) advancedSummary = parts.join(", ");
  }
  const phases = prefs.phases;
  let phasesSummary = "(defaults)";
  if (phases && Object.keys(phases).length > 0) {
    const activeFlags = Object.entries(phases).filter(([, v]) => v === true).map(([k]) => k);
    phasesSummary = activeFlags.length === 0 ? "(no flags)" : `${activeFlags.length} flag(s): ${activeFlags.slice(0, 2).join(", ")}${activeFlags.length > 2 ? "\u2026" : ""}`;
  }
  const parallel = prefs.parallel;
  const sliceParallel = prefs.slice_parallel;
  let parallelismSummary = "(defaults)";
  {
    const parts = [];
    if (parallel?.enabled) parts.push(`milestone: ${parallel.max_workers ?? 2}w`);
    if (sliceParallel?.enabled) parts.push(`slice: ${sliceParallel.max_workers ?? 2}w`);
    if (parts.length > 0) parallelismSummary = parts.join(", ");
  }
  const verifyCmds = Array.isArray(prefs.verification_commands) ? prefs.verification_commands.length : 0;
  const safety = prefs.safety_harness;
  let verificationSummary = "(defaults)";
  {
    const parts = [];
    if (verifyCmds) parts.push(`${verifyCmds} cmd(s)`);
    if (prefs.verification_auto_fix) parts.push("auto-fix");
    if (prefs.enhanced_verification === false) parts.push("enhanced: off");
    if (prefs.enhanced_verification_strict) parts.push("strict");
    if (safety?.enabled === false) parts.push("harness: off");
    else if (safety && Object.keys(safety).length > 0) parts.push("harness: custom");
    if (parts.length > 0) verificationSummary = parts.join(", ");
  }
  let discussSummary = "(defaults)";
  {
    const parts = [];
    if (prefs.discuss_preparation === false) parts.push("prep: off");
    if (prefs.discuss_web_research === false) parts.push("web: off");
    if (prefs.discuss_depth) parts.push(`depth: ${prefs.discuss_depth}`);
    if (parts.length > 0) discussSummary = parts.join(", ");
  }
  const ctxMgmt = prefs.context_management;
  const codebase = prefs.codebase;
  let contextSummary = "(defaults)";
  {
    const parts = [];
    if (prefs.context_selection) parts.push(`selection: ${prefs.context_selection}`);
    if (ctxMgmt && Object.keys(ctxMgmt).length > 0) parts.push(`mgmt: ${Object.keys(ctxMgmt).length} field(s)`);
    if (prefs.context_window_override !== void 0) parts.push(`override: ${prefs.context_window_override}`);
    if (codebase && Object.keys(codebase).length > 0) parts.push("codebase: custom");
    if (parts.length > 0) contextSummary = parts.join(", ");
  }
  const reactive = prefs.reactive_execution;
  const gateEval = prefs.gate_evaluation;
  const postHooks = Array.isArray(prefs.post_unit_hooks) ? prefs.post_unit_hooks.length : 0;
  const preHooks = Array.isArray(prefs.pre_dispatch_hooks) ? prefs.pre_dispatch_hooks.length : 0;
  let hooksSummary = "(defaults)";
  {
    const parts = [];
    if (postHooks) parts.push(`post: ${postHooks}`);
    if (preHooks) parts.push(`pre: ${preHooks}`);
    if (reactive?.enabled) parts.push("reactive: on");
    if (gateEval?.enabled) parts.push("gate-eval: on");
    if (parts.length > 0) hooksSummary = parts.join(", ");
  }
  const uok = prefs.uok;
  let uokSummary = "(defaults)";
  if (uok && Object.keys(uok).length > 0) {
    if (uok.enabled === false) uokSummary = "off";
    else uokSummary = `${Object.keys(uok).length} setting(s)`;
  }
  const cmux = prefs.cmux;
  const remote = prefs.remote_questions;
  const github = prefs.github;
  let integrationsSummary = "(defaults)";
  {
    const parts = [];
    if (prefs.language) parts.push(`lang: ${prefs.language}`);
    if (prefs.search_provider) parts.push(`search: ${prefs.search_provider}`);
    if (cmux?.enabled) parts.push("cmux");
    if (remote?.channel) parts.push(`remote: ${remote.channel}`);
    if (github?.enabled) parts.push("github");
    if (parts.length > 0) integrationsSummary = parts.join(", ");
  }
  return {
    mode: modeSummary,
    models: modelsSummary,
    timeouts: timeoutsSummary,
    git: gitSummary,
    skills: skillsSummary,
    budget: budgetSummary,
    notifications: notifSummary,
    advanced: advancedSummary,
    phases: phasesSummary,
    parallelism: parallelismSummary,
    verification: verificationSummary,
    discuss: discussSummary,
    context: contextSummary,
    hooks: hooksSummary,
    uok: uokSummary,
    integrations: integrationsSummary
  };
}
function formatConfiguredModel(config) {
  if (typeof config === "string") return config;
  if (!config || typeof config !== "object") return "(invalid)";
  const maybeConfig = config;
  if (typeof maybeConfig.model !== "string" || maybeConfig.model.trim() === "") return "(invalid)";
  if (typeof maybeConfig.provider === "string" && maybeConfig.provider && !maybeConfig.model.includes("/")) {
    return `${maybeConfig.provider}/${maybeConfig.model}`;
  }
  return maybeConfig.model;
}
function toPersistedModelId(provider, modelId) {
  if (!provider.trim()) return modelId;
  const normalizedProvider = provider.trim();
  const normalizedModelId = modelId.trim();
  return normalizedModelId.startsWith(`${normalizedProvider}/`) ? normalizedModelId : `${normalizedProvider}/${normalizedModelId}`;
}
async function configureModels(ctx, prefs) {
  const modelPhases = [
    "research",
    "planning",
    "discuss",
    "execution",
    "execution_simple",
    "completion",
    "validation",
    "subagent"
  ];
  const models = prefs.models ?? {};
  const availableModels = ctx.modelRegistry.getAvailable();
  if (availableModels.length > 0) {
    const byProvider = /* @__PURE__ */ new Map();
    for (const m of availableModels) {
      let group = byProvider.get(m.provider);
      if (!group) {
        group = [];
        byProvider.set(m.provider, group);
      }
      group.push(m);
    }
    const providers = Array.from(byProvider.keys()).sort((a, b) => a.localeCompare(b));
    for (const group of byProvider.values()) {
      group.sort((a, b) => a.id.localeCompare(b.id));
    }
    const PROVIDER_DISPLAY_NAMES = { anthropic: "anthropic-api" };
    const displayName = (p) => PROVIDER_DISPLAY_NAMES[p] ?? p;
    const displayToReal = /* @__PURE__ */ new Map();
    const providerOptions = providers.map((p) => {
      const count = byProvider.get(p).length;
      const label = `${displayName(p)} (${count} models)`;
      displayToReal.set(label, p);
      return label;
    });
    providerOptions.push("(keep current)", "(clear)", "(type manually)");
    for (const phase of modelPhases) {
      const current = formatConfiguredModel(models[phase]);
      const phaseLabel = `Model for ${phase} phase${current ? ` (current: ${current})` : ""}`;
      const providerChoice = await ctx.ui.select(`${phaseLabel} \u2014 choose provider:`, providerOptions);
      if (!providerChoice || typeof providerChoice !== "string" || providerChoice === "(keep current)") continue;
      if (providerChoice === "(clear)") {
        delete models[phase];
        continue;
      }
      if (providerChoice === "(type manually)") {
        const input = await ctx.ui.input(
          `${phaseLabel} \u2014 enter model ID:`,
          current || "e.g. claude-sonnet-4-20250514"
        );
        if (input !== null && input !== void 0) {
          const val = input.trim();
          if (val) models[phase] = val;
        }
        continue;
      }
      const providerName = displayToReal.get(providerChoice) ?? providerChoice.replace(/ \(\d+ models?\)$/, "");
      const group = byProvider.get(providerName);
      if (!group) continue;
      const modelOptions = group.map((m) => m.id);
      modelOptions.push("(keep current)", "(clear)");
      const modelChoice = await ctx.ui.select(`${phaseLabel} \u2014 ${displayName(providerName)}:`, modelOptions);
      if (modelChoice && typeof modelChoice === "string" && modelChoice !== "(keep current)") {
        if (modelChoice === "(clear)") {
          delete models[phase];
        } else {
          models[phase] = toPersistedModelId(providerName, modelChoice);
        }
      }
    }
  } else {
    for (const phase of modelPhases) {
      const current = formatConfiguredModel(models[phase]);
      const input = await ctx.ui.input(
        `Model for ${phase} phase${current ? ` (current: ${current})` : ""}:`,
        current || "e.g. claude-sonnet-4-20250514"
      );
      if (input !== null && input !== void 0) {
        const val = input.trim();
        if (val) {
          models[phase] = val;
        } else if (current) {
          delete models[phase];
        }
      }
    }
  }
  if (Object.keys(models).length > 0) {
    prefs.models = models;
  } else {
    delete prefs.models;
  }
  const tokenProfile = await promptEnum(
    ctx,
    "Token profile (cost/quality tradeoff)",
    prefs.token_profile,
    ["budget", "balanced", "quality", "burn-max"]
  );
  if (tokenProfile !== void 0) prefs.token_profile = tokenProfile;
  const serviceTier = await promptEnum(
    ctx,
    "OpenAI service tier (gpt-5.4 only)",
    prefs.service_tier,
    ["priority", "flex"]
  );
  if (serviceTier !== void 0) prefs.service_tier = serviceTier;
  await editStringListField(ctx, prefs, "flat_rate_providers", "Flat-rate providers (suppress dynamic routing)");
  await configureDynamicRouting(ctx, prefs);
}
async function configureDynamicRouting(ctx, prefs) {
  const dr = prefs.dynamic_routing ?? {};
  const enabled = await promptBoolean(ctx, "Enable dynamic routing (tier-based model selection)", dr.enabled);
  if (enabled !== void 0) dr.enabled = enabled;
  if (dr.enabled !== true) {
  }
  const cap = await promptBoolean(ctx, "Capability-aware routing", dr.capability_routing, false);
  if (cap !== void 0) dr.capability_routing = cap;
  const escalate = await promptBoolean(ctx, "Escalate to heavier tier on failure", dr.escalate_on_failure, true);
  if (escalate !== void 0) dr.escalate_on_failure = escalate;
  const pressure = await promptBoolean(ctx, "Downgrade under budget pressure", dr.budget_pressure, true);
  if (pressure !== void 0) dr.budget_pressure = pressure;
  const cross = await promptBoolean(ctx, "Cross-provider routing", dr.cross_provider, true);
  if (cross !== void 0) dr.cross_provider = cross;
  const hooks = await promptBoolean(ctx, "Route hook sessions dynamically", dr.hooks, true);
  if (hooks !== void 0) dr.hooks = hooks;
  const flatRate = await promptBoolean(ctx, "Allow dynamic routing for flat-rate providers", dr.allow_flat_rate_providers, false);
  if (flatRate !== void 0) dr.allow_flat_rate_providers = flatRate;
  const tierModels = dr.tier_models ?? {};
  for (const tier of ["light", "standard", "heavy"]) {
    const current = typeof tierModels[tier] === "string" ? tierModels[tier] : "";
    const input = await promptString(ctx, `Model for ${tier} tier (e.g. claude-haiku-4-5)`, current);
    if (input === void 0) continue;
    if (input) tierModels[tier] = input;
    else if (current) delete tierModels[tier];
  }
  if (Object.keys(tierModels).length > 0) dr.tier_models = tierModels;
  else delete dr.tier_models;
  if (Object.keys(dr).length > 0) prefs.dynamic_routing = dr;
  else if (prefs.dynamic_routing !== void 0) delete prefs.dynamic_routing;
}
async function configureTimeouts(ctx, prefs) {
  const autoSup = prefs.auto_supervisor ?? {};
  const timeoutFields = [
    { key: "soft_timeout_minutes", label: "Soft timeout (minutes)", defaultVal: "20" },
    { key: "idle_timeout_minutes", label: "Idle timeout (minutes)", defaultVal: "10" },
    { key: "hard_timeout_minutes", label: "Hard timeout (minutes)", defaultVal: "30" }
  ];
  for (const field of timeoutFields) {
    const current = autoSup[field.key];
    const currentStr = current !== void 0 && current !== null ? String(current) : "";
    const input = await ctx.ui.input(
      `${field.label}${currentStr ? ` (current: ${currentStr})` : ` (default: ${field.defaultVal})`}:`,
      currentStr || field.defaultVal
    );
    if (input !== null && input !== void 0) {
      const val = input.trim();
      const parsed = tryParseInteger(val);
      if (val && parsed !== null) {
        autoSup[field.key] = parsed;
      } else if (val) {
        ctx.ui.notify(`Invalid value "${val}" for ${field.label} \u2014 must be a whole number. Keeping previous value.`, "warning");
      } else if (!val && currentStr) {
        delete autoSup[field.key];
      }
    }
  }
  if (Object.keys(autoSup).length > 0) {
    prefs.auto_supervisor = autoSup;
  }
}
async function configureGit(ctx, prefs) {
  const git = prefs.git ?? {};
  const currentBranch = git.main_branch ? String(git.main_branch) : "";
  const branchInput = await ctx.ui.input(
    `Git main branch${currentBranch ? ` (current: ${currentBranch})` : ""}:`,
    currentBranch || "main"
  );
  if (branchInput !== null && branchInput !== void 0) {
    const val = branchInput.trim();
    if (val) {
      git.main_branch = val;
    } else if (currentBranch) {
      delete git.main_branch;
    }
  }
  const gitBooleanFields = [
    { key: "auto_push", label: "Auto-push commits after committing", defaultVal: false },
    { key: "push_branches", label: "Push milestone branches to remote", defaultVal: false },
    { key: "snapshots", label: "Create WIP snapshot commits during long tasks", defaultVal: true }
  ];
  for (const field of gitBooleanFields) {
    const current = git[field.key];
    const currentStr = current !== void 0 ? String(current) : "";
    const choice = await ctx.ui.select(
      `${field.label}${currentStr ? ` (current: ${currentStr})` : ` (default: ${field.defaultVal})`}:`,
      ["true", "false", "(keep current)"]
    );
    if (choice && choice !== "(keep current)") {
      git[field.key] = choice === "true";
    }
  }
  const currentRemote = git.remote ? String(git.remote) : "";
  const remoteInput = await ctx.ui.input(
    `Git remote name${currentRemote ? ` (current: ${currentRemote})` : " (default: origin)"}:`,
    currentRemote || "origin"
  );
  if (remoteInput !== null && remoteInput !== void 0) {
    const val = remoteInput.trim();
    if (val && val !== "origin") {
      git.remote = val;
    } else if (!val && currentRemote) {
      delete git.remote;
    }
  }
  const currentPreMerge = git.pre_merge_check !== void 0 ? String(git.pre_merge_check) : "";
  const preMergeChoice = await ctx.ui.select(
    `Pre-merge check${currentPreMerge ? ` (current: ${currentPreMerge})` : " (default: auto)"}:`,
    ["true", "false", "auto", "(keep current)"]
  );
  if (preMergeChoice && preMergeChoice !== "(keep current)") {
    if (preMergeChoice === "auto") {
      git.pre_merge_check = "auto";
    } else {
      git.pre_merge_check = preMergeChoice === "true";
    }
  }
  const currentCommitType = git.commit_type ? String(git.commit_type) : "";
  const commitTypes = ["feat", "fix", "refactor", "docs", "test", "chore", "perf", "ci", "build", "style", "(inferred \u2014 default)", "(keep current)"];
  const commitChoice = await ctx.ui.select(
    `Default commit type${currentCommitType ? ` (current: ${currentCommitType})` : ""}:`,
    commitTypes
  );
  if (commitChoice && typeof commitChoice === "string" && commitChoice !== "(keep current)") {
    if (commitChoice.startsWith("(inferred")) {
      delete git.commit_type;
    } else {
      git.commit_type = commitChoice;
    }
  }
  const currentMerge = git.merge_strategy ? String(git.merge_strategy) : "";
  const mergeChoice = await ctx.ui.select(
    `Merge strategy${currentMerge ? ` (current: ${currentMerge})` : ""}:`,
    ["squash", "merge", "(keep current)"]
  );
  if (mergeChoice && mergeChoice !== "(keep current)") {
    git.merge_strategy = mergeChoice;
  }
  const currentIsolation = git.isolation ? String(git.isolation) : "";
  const isolationChoice = await ctx.ui.select(
    `Git isolation strategy${currentIsolation ? ` (current: ${currentIsolation})` : " (default: worktree)"}:`,
    ["worktree", "branch", "none", "(keep current)"]
  );
  if (isolationChoice && isolationChoice !== "(keep current)") {
    git.isolation = isolationChoice;
  }
  const currentAbsorb = git.absorb_snapshot_commits;
  const absorbStr = currentAbsorb !== void 0 ? String(currentAbsorb) : "";
  const absorbChoice = await ctx.ui.select(
    `Absorb snapshot commits into real commits${absorbStr ? ` (current: ${absorbStr})` : " (default: true)"}:`,
    ["true", "false", "(keep current)"]
  );
  if (absorbChoice && absorbChoice !== "(keep current)") {
    git.absorb_snapshot_commits = absorbChoice === "true";
  }
  if (Object.keys(git).length > 0) {
    prefs.git = git;
  }
  const currentThreshold = prefs.stale_commit_threshold_minutes;
  const thresholdStr = currentThreshold !== void 0 ? String(currentThreshold) : "";
  const thresholdInput = await ctx.ui.input(
    `Stale commit threshold (minutes, 0 to disable)${thresholdStr ? ` (current: ${thresholdStr})` : " (default: 30)"}:`,
    thresholdStr || "30"
  );
  if (thresholdInput !== null && thresholdInput !== void 0) {
    const val = thresholdInput.trim();
    const parsed = tryParseInteger(val);
    if (val && parsed !== null && parsed >= 0) {
      prefs.stale_commit_threshold_minutes = parsed;
    } else if (val && parsed === null) {
      ctx.ui.notify(`Invalid value "${val}" \u2014 must be a whole number. Keeping previous value.`, "warning");
    } else if (!val && currentThreshold !== void 0) {
      delete prefs.stale_commit_threshold_minutes;
    }
  }
}
async function configureSkills(ctx, prefs) {
  const discovery = await promptEnum(ctx, "Skill discovery mode", prefs.skill_discovery, ["auto", "suggest", "off"]);
  if (discovery !== void 0) prefs.skill_discovery = discovery;
  const uat = await promptBoolean(ctx, "UAT dispatch mode", prefs.uat_dispatch, false);
  if (uat !== void 0) prefs.uat_dispatch = uat;
  await editStringListField(ctx, prefs, "always_use_skills", "Always-use skills");
  await editStringListField(ctx, prefs, "prefer_skills", "Preferred skills");
  await editStringListField(ctx, prefs, "avoid_skills", "Avoided skills");
  await editStringListField(ctx, prefs, "custom_instructions", "Custom instructions");
  await configureSkillRules(ctx, prefs);
  const staleness = await promptInteger(ctx, "Skill staleness days (0 to disable)", prefs.skill_staleness_days, "60");
  applyNumber(prefs, "skill_staleness_days", staleness);
}
async function configureSkillRules(ctx, prefs) {
  let rules = Array.isArray(prefs.skill_rules) ? [...prefs.skill_rules] : [];
  while (true) {
    const summary = rules.length === 0 ? "(no rules)" : `${rules.length} rule(s)`;
    const listLabels = rules.map((r, i) => `#${i + 1} when: ${r.when}`);
    const options = [...listLabels, "Add rule", "Done"];
    const choice = await ctx.ui.select(`Skill rules \u2014 ${summary}`, options);
    const pick = typeof choice === "string" ? choice : "";
    if (!pick || pick === "Done") break;
    if (pick === "Add rule") {
      const whenInput = await ctx.ui.input("Rule condition (free text, e.g. 'frontend tasks'):", "");
      const when = typeof whenInput === "string" ? whenInput.trim() : "";
      if (!when) continue;
      const rule = { when };
      for (const field of ["use", "prefer", "avoid"]) {
        const listInput = await ctx.ui.input(`Skills to ${field} (comma- or newline-separated, blank to skip):`, "");
        if (listInput) {
          const parsed = parseStringList(listInput);
          if (parsed.length > 0) rule[field] = parsed;
        }
      }
      if (rule.use || rule.prefer || rule.avoid) rules.push(rule);
      else ctx.ui.notify("Rule discarded \u2014 must have at least one of use/prefer/avoid.", "warning");
    } else if (pick.startsWith("#")) {
      const idx = Number(pick.slice(1, pick.indexOf(" "))) - 1;
      if (idx < 0 || idx >= rules.length) continue;
      const editChoice = await ctx.ui.select(
        `Rule #${idx + 1}`,
        ["Edit condition", "Edit use list", "Edit prefer list", "Edit avoid list", "Delete rule", "Cancel"]
      );
      const ec = typeof editChoice === "string" ? editChoice : "";
      if (!ec || ec === "Cancel") continue;
      if (ec === "Delete rule") {
        rules = rules.filter((_, i) => i !== idx);
        continue;
      }
      if (ec === "Edit condition") {
        const newWhen = await promptString(ctx, "Rule condition", rules[idx].when);
        if (newWhen !== void 0 && newWhen !== "") rules[idx].when = newWhen;
      } else {
        const fieldKey = ec === "Edit use list" ? "use" : ec === "Edit prefer list" ? "prefer" : "avoid";
        const currentList = rules[idx][fieldKey] ?? [];
        const listInput = await ctx.ui.input(
          `${fieldKey} list (comma- or newline-separated, blank to clear):`,
          currentList.join(", ")
        );
        if (listInput === null || listInput === void 0) continue;
        const parsed = parseStringList(listInput);
        if (parsed.length > 0) rules[idx][fieldKey] = parsed;
        else delete rules[idx][fieldKey];
      }
    }
  }
  if (rules.length > 0) prefs.skill_rules = rules;
  else if (prefs.skill_rules !== void 0) delete prefs.skill_rules;
}
async function configureBudget(ctx, prefs) {
  const currentCeiling = prefs.budget_ceiling;
  const ceilingStr = currentCeiling !== void 0 ? String(currentCeiling) : "";
  const ceilingInput = await ctx.ui.input(
    `Budget ceiling (USD)${ceilingStr ? ` (current: $${ceilingStr})` : " (default: no limit)"}:`,
    ceilingStr || ""
  );
  if (ceilingInput !== null && ceilingInput !== void 0) {
    const val = ceilingInput.trim().replace(/^\$/, "");
    const parsed = tryParseNumber(val);
    if (val && parsed !== null) {
      prefs.budget_ceiling = parsed;
    } else if (val) {
      ctx.ui.notify(`Invalid budget ceiling "${val}" \u2014 must be a number. Keeping previous value.`, "warning");
    } else if (!val && ceilingStr) {
      delete prefs.budget_ceiling;
    }
  }
  const currentEnforcement = prefs.budget_enforcement ?? "";
  const enforcementChoice = await ctx.ui.select(
    `Budget enforcement${currentEnforcement ? ` (current: ${currentEnforcement})` : " (default: pause)"}:`,
    ["warn", "pause", "halt", "(keep current)"]
  );
  if (enforcementChoice && enforcementChoice !== "(keep current)") {
    prefs.budget_enforcement = enforcementChoice;
  }
  const currentContextPause = prefs.context_pause_threshold;
  const contextPauseStr = currentContextPause !== void 0 ? String(currentContextPause) : "";
  const contextPauseInput = await ctx.ui.input(
    `Context pause threshold (0-100%, 0=disabled)${contextPauseStr ? ` (current: ${contextPauseStr}%)` : " (default: 0)"}:`,
    contextPauseStr || "0"
  );
  if (contextPauseInput !== null && contextPauseInput !== void 0) {
    const val = contextPauseInput.trim().replace(/%$/, "");
    const parsed = tryParsePercentage(val);
    if (val && parsed !== null) {
      if (parsed === 0) {
        delete prefs.context_pause_threshold;
      } else {
        prefs.context_pause_threshold = parsed;
      }
    } else if (val) {
      ctx.ui.notify(`Invalid context pause threshold "${val}" \u2014 must be 0-100. Keeping previous value.`, "warning");
    }
  }
}
async function configureNotifications(ctx, prefs) {
  const notif = prefs.notifications ?? {};
  const notifFields = [
    { key: "enabled", label: "Notifications enabled (master toggle)", defaultVal: true },
    { key: "on_complete", label: "Notify on unit completion", defaultVal: true },
    { key: "on_error", label: "Notify on errors", defaultVal: true },
    { key: "on_budget", label: "Notify on budget thresholds", defaultVal: true },
    { key: "on_milestone", label: "Notify on milestone completion", defaultVal: true },
    { key: "on_attention", label: "Notify when manual attention needed", defaultVal: true }
  ];
  for (const field of notifFields) {
    const current = notif[field.key];
    const currentStr = current !== void 0 && typeof current === "boolean" ? String(current) : "";
    const choice = await ctx.ui.select(
      `${field.label}${currentStr ? ` (current: ${currentStr})` : ` (default: ${field.defaultVal})`}:`,
      ["true", "false", "(keep current)"]
    );
    if (choice && choice !== "(keep current)") {
      notif[field.key] = choice === "true";
    }
  }
  if (Object.keys(notif).length > 0) {
    prefs.notifications = notif;
  }
}
async function configurePhases(ctx, prefs) {
  const phases = prefs.phases ?? {};
  const fields = [
    { key: "skip_research", label: "Skip research phase" },
    { key: "skip_reassess", label: "Skip roadmap reassessment" },
    { key: "skip_slice_research", label: "Skip slice-level research" },
    { key: "skip_milestone_validation", label: "Skip milestone validation" },
    { key: "reassess_after_slice", label: "Reassess roadmap after each slice" },
    { key: "require_slice_discussion", label: "Pause for discussion before each slice" },
    { key: "mid_execution_escalation", label: "Allow mid-execution escalation (ADR-011 P2)" },
    { key: "progressive_planning", label: "Progressive planning (S01 full, S02+ sketches)" }
  ];
  for (const field of fields) {
    const val = await promptBoolean(ctx, field.label, phases[field.key]);
    if (val !== void 0) phases[field.key] = val;
  }
  if (Object.keys(phases).length > 0) prefs.phases = phases;
  else if (prefs.phases !== void 0) delete prefs.phases;
}
async function configureParallelism(ctx, prefs) {
  const parallel = prefs.parallel ?? {};
  const pEnabled = await promptBoolean(ctx, "Parallel milestone execution", parallel.enabled, false);
  if (pEnabled !== void 0) parallel.enabled = pEnabled;
  const pWorkers = await promptInteger(ctx, "Max parallel workers (1\u20134)", parallel.max_workers, "2");
  if (pWorkers !== void 0 && pWorkers !== "clear") parallel.max_workers = Math.max(1, Math.min(4, pWorkers));
  else if (pWorkers === "clear") delete parallel.max_workers;
  const pBudget = await promptNumber(ctx, "Per-worker budget ceiling (USD, blank = no limit)", parallel.budget_ceiling);
  if (pBudget !== void 0 && pBudget !== "clear") parallel.budget_ceiling = pBudget;
  else if (pBudget === "clear") delete parallel.budget_ceiling;
  const pMerge = await promptEnum(ctx, "Parallel merge strategy", parallel.merge_strategy, ["per-slice", "per-milestone"]);
  if (pMerge !== void 0) parallel.merge_strategy = pMerge;
  const pAuto = await promptEnum(ctx, "Auto-merge mode", parallel.auto_merge, ["auto", "confirm", "manual"]);
  if (pAuto !== void 0) parallel.auto_merge = pAuto;
  const pWorkerModel = await promptString(ctx, "Worker model override (e.g. claude-haiku-4-5)", parallel.worker_model);
  if (pWorkerModel !== void 0) {
    if (pWorkerModel) parallel.worker_model = pWorkerModel;
    else delete parallel.worker_model;
  }
  if (Object.keys(parallel).length > 0) prefs.parallel = parallel;
  else if (prefs.parallel !== void 0) delete prefs.parallel;
  const sp = prefs.slice_parallel ?? {};
  const spEnabled = await promptBoolean(ctx, "Slice-level parallel execution", sp.enabled, false);
  if (spEnabled !== void 0) sp.enabled = spEnabled;
  const spWorkers = await promptInteger(ctx, "Slice max workers", sp.max_workers, "2");
  if (spWorkers !== void 0 && spWorkers !== "clear") sp.max_workers = spWorkers;
  else if (spWorkers === "clear") delete sp.max_workers;
  if (Object.keys(sp).length > 0) prefs.slice_parallel = sp;
  else if (prefs.slice_parallel !== void 0) delete prefs.slice_parallel;
}
async function configureVerification(ctx, prefs) {
  await editStringListField(ctx, prefs, "verification_commands", "Verification commands");
  const autoFix = await promptBoolean(ctx, "Auto-fix on verification failure", prefs.verification_auto_fix);
  if (autoFix !== void 0) prefs.verification_auto_fix = autoFix;
  const maxRetries = await promptInteger(ctx, "Verification max retries", prefs.verification_max_retries, "2");
  applyNumber(prefs, "verification_max_retries", maxRetries);
  const ev = await promptBoolean(ctx, "Enhanced verification (master toggle)", prefs.enhanced_verification, true);
  if (ev !== void 0) prefs.enhanced_verification = ev;
  const evPre = await promptBoolean(ctx, "Enhanced verification \u2014 pre-execution checks", prefs.enhanced_verification_pre, true);
  if (evPre !== void 0) prefs.enhanced_verification_pre = evPre;
  const evPost = await promptBoolean(ctx, "Enhanced verification \u2014 post-execution checks", prefs.enhanced_verification_post, true);
  if (evPost !== void 0) prefs.enhanced_verification_post = evPost;
  const evStrict = await promptBoolean(ctx, "Enhanced verification \u2014 strict mode (fail on any issue)", prefs.enhanced_verification_strict, false);
  if (evStrict !== void 0) prefs.enhanced_verification_strict = evStrict;
  const sh = prefs.safety_harness ?? {};
  const shFields = [
    { key: "enabled", label: "Safety harness enabled" },
    { key: "evidence_collection", label: "Collect tool evidence" },
    { key: "file_change_validation", label: "Validate file change descriptions" },
    { key: "evidence_cross_reference", label: "Cross-reference evidence across tools" },
    { key: "destructive_command_warnings", label: "Warn on destructive commands" },
    { key: "content_validation", label: "Validate written content" },
    { key: "checkpoints", label: "Create safety checkpoints" },
    { key: "auto_rollback", label: "Auto-rollback on safety violation" }
  ];
  for (const field of shFields) {
    const val = await promptBoolean(ctx, `Safety harness \u2014 ${field.label}`, sh[field.key]);
    if (val !== void 0) sh[field.key] = val;
  }
  const cap = await promptNumber(ctx, "Safety harness timeout scale cap", sh.timeout_scale_cap);
  if (cap !== void 0 && cap !== "clear") sh.timeout_scale_cap = cap;
  else if (cap === "clear") delete sh.timeout_scale_cap;
  if (Object.keys(sh).length > 0) prefs.safety_harness = sh;
  else if (prefs.safety_harness !== void 0) delete prefs.safety_harness;
}
async function configureDiscuss(ctx, prefs) {
  const prep = await promptBoolean(ctx, "Discuss \u2014 run preparation phase", prefs.discuss_preparation, true);
  if (prep !== void 0) prefs.discuss_preparation = prep;
  const web = await promptBoolean(ctx, "Discuss \u2014 web research during preparation", prefs.discuss_web_research, true);
  if (web !== void 0) prefs.discuss_web_research = web;
  const depth = await promptEnum(ctx, "Discuss preparation depth", prefs.discuss_depth, ["quick", "standard", "thorough"], "standard");
  if (depth !== void 0) prefs.discuss_depth = depth;
}
async function configureContextCodebase(ctx, prefs) {
  const sel = await promptEnum(ctx, "Context selection mode", prefs.context_selection, ["full", "smart"]);
  if (sel !== void 0) prefs.context_selection = sel;
  const cm = prefs.context_management ?? {};
  const mask = await promptBoolean(ctx, "Observation masking (hide stale tool outputs)", cm.observation_masking, true);
  if (mask !== void 0) cm.observation_masking = mask;
  const maskTurns = await promptInteger(ctx, "Observation mask turns (1\u201350)", cm.observation_mask_turns, "8");
  if (maskTurns !== void 0 && maskTurns !== "clear") cm.observation_mask_turns = maskTurns;
  else if (maskTurns === "clear") delete cm.observation_mask_turns;
  const thresh = await promptNumber(ctx, "Compaction threshold percent (0.5\u20130.95)", cm.compaction_threshold_percent, "0.70");
  if (thresh !== void 0 && thresh !== "clear") cm.compaction_threshold_percent = thresh;
  else if (thresh === "clear") delete cm.compaction_threshold_percent;
  const toolMax = await promptInteger(ctx, "Tool result max chars (200\u201310000)", cm.tool_result_max_chars, "800");
  if (toolMax !== void 0 && toolMax !== "clear") cm.tool_result_max_chars = toolMax;
  else if (toolMax === "clear") delete cm.tool_result_max_chars;
  if (Object.keys(cm).length > 0) prefs.context_management = cm;
  else if (prefs.context_management !== void 0) delete prefs.context_management;
  const override = await promptInteger(ctx, "Context window override (tokens, blank = use model default)", prefs.context_window_override);
  applyNumber(prefs, "context_window_override", override);
  const cb = prefs.codebase ?? {};
  const currentExcludes = Array.isArray(cb.exclude_patterns) ? cb.exclude_patterns : [];
  const excludesInput = await ctx.ui.input(
    `Codebase map \u2014 extra exclude patterns (comma- or newline-separated, blank to keep)${currentExcludes.length ? ` (current: ${currentExcludes.join(", ")})` : ""}:`,
    currentExcludes.join(", ")
  );
  if (excludesInput !== null && excludesInput !== void 0) {
    const parsed = parseStringList(excludesInput);
    if (parsed.length > 0) cb.exclude_patterns = parsed;
    else if (currentExcludes.length > 0 && excludesInput.trim() === "") delete cb.exclude_patterns;
  }
  const maxFiles = await promptInteger(ctx, "Codebase map \u2014 max files", cb.max_files, "500");
  if (maxFiles !== void 0 && maxFiles !== "clear") cb.max_files = maxFiles;
  else if (maxFiles === "clear") delete cb.max_files;
  const collapse = await promptInteger(ctx, "Codebase map \u2014 collapse threshold", cb.collapse_threshold, "20");
  if (collapse !== void 0 && collapse !== "clear") cb.collapse_threshold = collapse;
  else if (collapse === "clear") delete cb.collapse_threshold;
  if (Object.keys(cb).length > 0) prefs.codebase = cb;
  else if (prefs.codebase !== void 0) delete prefs.codebase;
}
async function configureHooks(ctx, prefs) {
  const re = prefs.reactive_execution ?? {};
  const reEnabled = await promptBoolean(ctx, "Reactive (graph-parallel) task execution", re.enabled, false);
  if (reEnabled !== void 0) re.enabled = reEnabled;
  const reMax = await promptInteger(ctx, "Reactive max parallel (1\u20138)", re.max_parallel, "3");
  if (reMax !== void 0 && reMax !== "clear") re.max_parallel = Math.max(1, Math.min(8, reMax));
  else if (reMax === "clear") delete re.max_parallel;
  const reModel = await promptString(ctx, "Reactive subagent model override", re.subagent_model);
  if (reModel !== void 0) {
    if (reModel) re.subagent_model = reModel;
    else delete re.subagent_model;
  }
  if (Object.keys(re).length > 0) {
    if (re.enabled === true && !re.isolation_mode) re.isolation_mode = "same-tree";
    prefs.reactive_execution = re;
  } else if (prefs.reactive_execution !== void 0) {
    delete prefs.reactive_execution;
  }
  const ge = prefs.gate_evaluation ?? {};
  const geEnabled = await promptBoolean(ctx, "Parallel gate evaluation during planning", ge.enabled, false);
  if (geEnabled !== void 0) ge.enabled = geEnabled;
  const currentSliceGates = Array.isArray(ge.slice_gates) ? ge.slice_gates : [];
  const sgInput = await ctx.ui.input(
    `Slice gates to evaluate (comma-separated, blank keeps)${currentSliceGates.length ? ` (current: ${currentSliceGates.join(", ")})` : " (default: Q3,Q4)"}:`,
    currentSliceGates.join(", ")
  );
  if (sgInput !== null && sgInput !== void 0) {
    const parsed = parseStringList(sgInput);
    if (parsed.length > 0) ge.slice_gates = parsed;
    else if (currentSliceGates.length > 0 && sgInput.trim() === "") delete ge.slice_gates;
  }
  const geTask = await promptBoolean(ctx, "Evaluate task-level gates (Q5/Q6/Q7)", ge.task_gates, true);
  if (geTask !== void 0) ge.task_gates = geTask;
  if (Object.keys(ge).length > 0) prefs.gate_evaluation = ge;
  else if (prefs.gate_evaluation !== void 0) delete prefs.gate_evaluation;
  await configureHookList(ctx, prefs, "post_unit_hooks", "Post-unit hooks", "after");
  await configureHookList(ctx, prefs, "pre_dispatch_hooks", "Pre-dispatch hooks", "before");
}
async function configureHookList(ctx, prefs, key, label, triggerField) {
  let hooks = Array.isArray(prefs[key]) ? [...prefs[key]] : [];
  while (true) {
    const summary = hooks.length === 0 ? "(none)" : `${hooks.length} hook(s)`;
    const labels = hooks.map((h, i) => `#${i + 1} ${h.name ?? "(unnamed)"}${h.enabled === false ? " [disabled]" : ""}`);
    const choice = await ctx.ui.select(`${label} \u2014 ${summary}`, [...labels, "Add hook", "Done"]);
    const pick = typeof choice === "string" ? choice : "";
    if (!pick || pick === "Done") break;
    if (pick === "Add hook") {
      const nameInput = await ctx.ui.input("Hook name (unique identifier):", "");
      const name = typeof nameInput === "string" ? nameInput.trim() : "";
      if (!name) continue;
      const triggerInput = await ctx.ui.input(
        `Unit types this hook ${triggerField === "after" ? "runs after" : "intercepts before"} (comma-separated, e.g. execute-task):`,
        ""
      );
      const triggers = triggerInput ? parseStringList(triggerInput) : [];
      if (triggers.length === 0) {
        ctx.ui.notify("Hook discarded \u2014 trigger list cannot be empty.", "warning");
        continue;
      }
      const hook = { name, [triggerField]: triggers, enabled: true };
      if (key === "post_unit_hooks") {
        const promptInput = await ctx.ui.input("Hook prompt (sent to LLM; supports {milestoneId}, {sliceId}, {taskId}):", "");
        if (promptInput) hook.prompt = promptInput;
      } else {
        const actionChoice = await ctx.ui.select("Action:", ["modify", "skip", "replace"]);
        if (actionChoice) hook.action = actionChoice;
      }
      hooks.push(hook);
    } else if (pick.startsWith("#")) {
      const idx = Number(pick.slice(1, pick.indexOf(" "))) - 1;
      if (idx < 0 || idx >= hooks.length) continue;
      const editChoice = await ctx.ui.select(
        `Hook #${idx + 1}: ${hooks[idx].name ?? ""}`,
        ["Toggle enabled", "Edit prompt/action", "Edit model override", "Delete hook", "Cancel"]
      );
      const ec = typeof editChoice === "string" ? editChoice : "";
      if (!ec || ec === "Cancel") continue;
      if (ec === "Delete hook") {
        hooks = hooks.filter((_, i) => i !== idx);
      } else if (ec === "Toggle enabled") {
        hooks[idx].enabled = hooks[idx].enabled === false;
      } else if (ec === "Edit prompt/action") {
        if (key === "post_unit_hooks") {
          const newPrompt = await promptString(ctx, "Prompt", hooks[idx].prompt);
          if (newPrompt !== void 0 && newPrompt) hooks[idx].prompt = newPrompt;
        } else {
          const newAction = await promptEnum(ctx, "Action", hooks[idx].action, ["modify", "skip", "replace"]);
          if (newAction !== void 0) hooks[idx].action = newAction;
        }
      } else if (ec === "Edit model override") {
        const m = await promptString(ctx, "Model override (blank to clear)", hooks[idx].model);
        if (m !== void 0) {
          if (m) hooks[idx].model = m;
          else delete hooks[idx].model;
        }
      }
    }
  }
  if (hooks.length > 0) prefs[key] = hooks;
  else if (prefs[key] !== void 0) delete prefs[key];
}
async function configureUoK(ctx, prefs) {
  const uok = prefs.uok ?? {};
  const enabled = await promptBoolean(ctx, "UoK (Unified Orchestration Kernel) enabled", uok.enabled);
  if (enabled !== void 0) uok.enabled = enabled;
  const subsections = ["legacy_fallback", "gates", "model_policy", "execution_graph", "audit_unified", "plan_v2"];
  for (const sub of subsections) {
    const existing = uok[sub] ?? {};
    const val = await promptBoolean(ctx, `UoK \u2014 ${sub.replace(/_/g, " ")} enabled`, existing.enabled);
    if (val !== void 0) {
      existing.enabled = val;
      uok[sub] = existing;
    } else if (Object.keys(existing).length > 0) {
      uok[sub] = existing;
    }
  }
  const gitops = uok.gitops ?? {};
  const gitopsEnabled = await promptBoolean(ctx, "UoK \u2014 gitops enabled", gitops.enabled);
  if (gitopsEnabled !== void 0) gitops.enabled = gitopsEnabled;
  const turnAction = await promptEnum(ctx, "UoK gitops \u2014 turn action", gitops.turn_action, ["commit", "snapshot", "status-only"]);
  if (turnAction !== void 0) gitops.turn_action = turnAction;
  const turnPush = await promptBoolean(ctx, "UoK gitops \u2014 turn push", gitops.turn_push);
  if (turnPush !== void 0) gitops.turn_push = turnPush;
  if (Object.keys(gitops).length > 0) uok.gitops = gitops;
  if (Object.keys(uok).length > 0) prefs.uok = uok;
  else if (prefs.uok !== void 0) delete prefs.uok;
}
async function configureIntegrations(ctx, prefs) {
  const lang = await promptString(ctx, "Response language (e.g. Chinese, zh, German \u2014 blank to clear)", prefs.language);
  if (lang !== void 0) {
    if (lang) prefs.language = lang;
    else delete prefs.language;
  }
  const search = await promptEnum(
    ctx,
    "Search provider",
    prefs.search_provider,
    ["auto", "brave", "tavily", "ollama", "native"],
    "auto"
  );
  if (search !== void 0) prefs.search_provider = search;
  const cmux = prefs.cmux ?? {};
  for (const field of ["enabled", "notifications", "sidebar", "splits", "browser"]) {
    const val = await promptBoolean(ctx, `cmux \u2014 ${field}`, cmux[field]);
    if (val !== void 0) cmux[field] = val;
  }
  if (Object.keys(cmux).length > 0) prefs.cmux = cmux;
  else if (prefs.cmux !== void 0) delete prefs.cmux;
  await configureRemoteQuestions(ctx, prefs);
  await configureGitHubSync(ctx, prefs);
}
async function configureRemoteQuestions(ctx, prefs) {
  const existing = prefs.remote_questions ?? {};
  const channel = await promptEnum(ctx, "Remote questions channel", existing.channel, ["slack", "discord", "telegram"]);
  const channelId = await promptString(ctx, "Remote questions channel_id", existing.channel_id);
  const timeout = await promptInteger(ctx, "Remote questions timeout (minutes, 1\u201330)", existing.timeout_minutes, "10");
  const poll = await promptInteger(ctx, "Remote questions poll interval (seconds, 2\u201330)", existing.poll_interval_seconds, "5");
  if (channel !== void 0) existing.channel = channel;
  if (channelId !== void 0) {
    if (channelId) existing.channel_id = channelId;
    else delete existing.channel_id;
  }
  applyNumber(existing, "timeout_minutes", timeout);
  applyNumber(existing, "poll_interval_seconds", poll);
  if (existing.channel && existing.channel_id) {
    prefs.remote_questions = existing;
  } else if (!existing.channel && !existing.channel_id) {
    if (prefs.remote_questions !== void 0) delete prefs.remote_questions;
  } else {
    ctx.ui.notify("remote_questions requires both channel and channel_id; keeping partial config.", "warning");
    prefs.remote_questions = existing;
  }
}
async function configureGitHubSync(ctx, prefs) {
  const gh = prefs.github ?? {};
  const enabled = await promptBoolean(ctx, "GitHub sync enabled", gh.enabled, false);
  if (enabled !== void 0) gh.enabled = enabled;
  const repo = await promptString(ctx, "GitHub repo (owner/repo, blank = auto-detect from git remote)", gh.repo);
  if (repo !== void 0) {
    if (repo) gh.repo = repo;
    else delete gh.repo;
  }
  const project = await promptInteger(ctx, "GitHub Projects v2 number (blank = none)", gh.project);
  if (project !== void 0 && project !== "clear") gh.project = project;
  else if (project === "clear") delete gh.project;
  const currentLabels = Array.isArray(gh.labels) ? gh.labels : [];
  const labelsInput = await ctx.ui.input(
    `GitHub default labels (comma-separated)${currentLabels.length ? ` (current: ${currentLabels.join(", ")})` : ""}:`,
    currentLabels.join(", ")
  );
  if (labelsInput !== null && labelsInput !== void 0) {
    const parsed = parseStringList(labelsInput);
    if (parsed.length > 0) gh.labels = parsed;
    else if (currentLabels.length > 0 && labelsInput.trim() === "") delete gh.labels;
  }
  const autoLink = await promptBoolean(ctx, "GitHub \u2014 auto-link commits with Resolves #N", gh.auto_link_commits, true);
  if (autoLink !== void 0) gh.auto_link_commits = autoLink;
  const slicePrs = await promptBoolean(ctx, "GitHub \u2014 create per-slice draft PRs", gh.slice_prs, true);
  if (slicePrs !== void 0) gh.slice_prs = slicePrs;
  if (gh.enabled === true || Object.keys(gh).length > 1) prefs.github = gh;
  else if (prefs.github !== void 0 && Object.keys(gh).length === 0) delete prefs.github;
  else if (Object.keys(gh).length > 0) prefs.github = gh;
}
async function configureMode(ctx, prefs) {
  const currentMode = prefs.mode;
  const modeChoice = await ctx.ui.select(
    `Workflow mode${currentMode ? ` (current: ${currentMode})` : ""}:`,
    [
      "solo \u2014 auto-push, squash, simple IDs (personal projects)",
      "team \u2014 unique IDs, push branches, pre-merge checks (shared repos)",
      "(none) \u2014 configure everything manually",
      "(keep current)"
    ]
  );
  const modeStr = typeof modeChoice === "string" ? modeChoice : "";
  if (modeStr && modeStr !== "(keep current)") {
    if (modeStr.startsWith("solo")) {
      prefs.mode = "solo";
      ctx.ui.notify(
        "Mode: solo \u2014 defaults: auto_push=true, push_branches=false, pre_merge_check=auto, merge_strategy=squash, isolation=worktree, unique_milestone_ids=false",
        "info"
      );
    } else if (modeStr.startsWith("team")) {
      prefs.mode = "team";
      ctx.ui.notify(
        "Mode: team \u2014 defaults: auto_push=false, push_branches=true, pre_merge_check=true, merge_strategy=squash, isolation=worktree, unique_milestone_ids=true",
        "info"
      );
    } else {
      delete prefs.mode;
    }
  }
}
async function configureAdvanced(ctx, prefs) {
  const unique = await promptBoolean(ctx, "Unique milestone IDs", prefs.unique_milestone_ids);
  if (unique !== void 0) prefs.unique_milestone_ids = unique;
  const autoViz = await promptBoolean(ctx, "Auto-visualize milestones (open HTML visualizer)", prefs.auto_visualize);
  if (autoViz !== void 0) prefs.auto_visualize = autoViz;
  const autoReport = await promptBoolean(ctx, "Auto-generate milestone HTML report", prefs.auto_report, true);
  if (autoReport !== void 0) prefs.auto_report = autoReport;
  const forensics = await promptBoolean(ctx, "Forensics dedup (search GitHub before filing)", prefs.forensics_dedup, false);
  if (forensics !== void 0) prefs.forensics_dedup = forensics;
  const tokenCost = await promptBoolean(ctx, "Show token cost in footer", prefs.show_token_cost, false);
  if (tokenCost !== void 0) prefs.show_token_cost = tokenCost;
  const minRequestInterval = await promptInteger(
    ctx,
    "Minimum interval between auto-mode LLM requests (ms, 0 to disable)",
    prefs.min_request_interval_ms,
    "0"
  );
  if (minRequestInterval === "clear") {
    delete prefs.min_request_interval_ms;
  } else if (minRequestInterval !== void 0) {
    prefs.min_request_interval_ms = minRequestInterval;
  }
  const widget = await promptEnum(ctx, "Auto-mode widget display", prefs.widget_mode, ["full", "small", "min", "off"], "full");
  if (widget !== void 0) prefs.widget_mode = widget;
  const experimental = prefs.experimental ?? {};
  const rtk = await promptBoolean(ctx, "Experimental: RTK shell-command compression", experimental.rtk, false);
  if (rtk !== void 0) experimental.rtk = rtk;
  if (Object.keys(experimental).length > 0) prefs.experimental = experimental;
  else if (prefs.experimental !== void 0) delete prefs.experimental;
}
async function handlePrefsWizard(ctx, scope, prefill, opts) {
  const path = opts?.pathOverride ?? (scope === "project" ? getProjectGSDPreferencesPath() : getGlobalGSDPreferencesPath());
  const existing = scope === "project" ? loadProjectGSDPreferences() : loadGlobalGSDPreferences();
  const prefs = {
    ...existing?.preferences ?? {},
    ...prefill ?? {}
  };
  ctx.ui.notify(`GSD preferences (${scope}) \u2014 pick a category to configure.`, "info");
  while (true) {
    const summaries = buildCategorySummaries(prefs);
    const options = [
      `Workflow Mode   ${summaries.mode}`,
      `Models          ${summaries.models}`,
      `Timeouts        ${summaries.timeouts}`,
      `Git             ${summaries.git}`,
      `Skills          ${summaries.skills}`,
      `Budget          ${summaries.budget}`,
      `Notifications   ${summaries.notifications}`,
      `Phases          ${summaries.phases}`,
      `Parallelism     ${summaries.parallelism}`,
      `Verification    ${summaries.verification}`,
      `Discuss         ${summaries.discuss}`,
      `Context         ${summaries.context}`,
      `Hooks           ${summaries.hooks}`,
      `UoK             ${summaries.uok}`,
      `Integrations    ${summaries.integrations}`,
      `Advanced        ${summaries.advanced}`,
      `\u2500\u2500 Save & Exit \u2500\u2500`
    ];
    const raw = await ctx.ui.select("GSD Preferences", options);
    const choice = typeof raw === "string" ? raw : "";
    if (!choice || choice.includes("Save & Exit")) break;
    if (choice.startsWith("Workflow Mode")) await configureMode(ctx, prefs);
    else if (choice.startsWith("Models")) await configureModels(ctx, prefs);
    else if (choice.startsWith("Timeouts")) await configureTimeouts(ctx, prefs);
    else if (choice.startsWith("Git")) await configureGit(ctx, prefs);
    else if (choice.startsWith("Skills")) await configureSkills(ctx, prefs);
    else if (choice.startsWith("Budget")) await configureBudget(ctx, prefs);
    else if (choice.startsWith("Notifications")) await configureNotifications(ctx, prefs);
    else if (choice.startsWith("Phases")) await configurePhases(ctx, prefs);
    else if (choice.startsWith("Parallelism")) await configureParallelism(ctx, prefs);
    else if (choice.startsWith("Verification")) await configureVerification(ctx, prefs);
    else if (choice.startsWith("Discuss")) await configureDiscuss(ctx, prefs);
    else if (choice.startsWith("Context")) await configureContextCodebase(ctx, prefs);
    else if (choice.startsWith("Hooks")) await configureHooks(ctx, prefs);
    else if (choice.startsWith("UoK")) await configureUoK(ctx, prefs);
    else if (choice.startsWith("Integrations")) await configureIntegrations(ctx, prefs);
    else if (choice.startsWith("Advanced")) await configureAdvanced(ctx, prefs);
  }
  await writePreferencesFile(path, prefs, ctx, { scope });
}
async function writePreferencesFile(path, prefs, ctx, opts) {
  const next = { ...prefs, version: prefs.version || 1 };
  const frontmatter = serializePreferencesToFrontmatter(next);
  const fallbackBody = opts?.defaultBody ?? "\n# GSD Skill Preferences\n\nSee `~/.gsd/agent/extensions/gsd/docs/preferences-reference.md` for full field documentation and examples.\n";
  let body = fallbackBody;
  if (existsSync(path)) {
    const preserved = extractBodyAfterFrontmatter(readFileSync(path, "utf-8"));
    if (preserved) body = preserved;
  }
  const content = `---
${frontmatter}---${body}`;
  await saveFile(path, content);
  if (ctx) {
    await ctx.waitForIdle();
    await ctx.reload();
    if (opts?.notifyOnSave !== false) {
      const scopeLabel = opts?.scope ? `${opts.scope} ` : "";
      ctx.ui.notify(`Saved ${scopeLabel}preferences to ${path}`, "info");
    }
  }
}
function yamlSafeString(val) {
  if (typeof val !== "string") return String(val);
  if (/[:#{\[\]'"`,|>&*!?@%\r\n]/.test(val) || val.trim() !== val || val === "") {
    return `"${val.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
  }
  return val;
}
function serializePreferencesToFrontmatter(prefs) {
  const lines = [];
  function serializeValue(key, value, indent) {
    const prefix = "  ".repeat(indent);
    if (value === null || value === void 0) return;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        return;
      }
      lines.push(`${prefix}${key}:`);
      for (const item of value) {
        if (typeof item === "object" && item !== null) {
          const entries = Object.entries(item);
          if (entries.length > 0) {
            const [firstKey, firstVal] = entries[0];
            lines.push(`${prefix}  - ${firstKey}: ${yamlSafeString(firstVal)}`);
            for (let i = 1; i < entries.length; i++) {
              const [k, v] = entries[i];
              if (Array.isArray(v)) {
                lines.push(`${prefix}    ${k}:`);
                for (const arrItem of v) {
                  lines.push(`${prefix}      - ${yamlSafeString(arrItem)}`);
                }
              } else {
                lines.push(`${prefix}    ${k}: ${yamlSafeString(v)}`);
              }
            }
          }
        } else {
          lines.push(`${prefix}  - ${yamlSafeString(item)}`);
        }
      }
      return;
    }
    if (typeof value === "object") {
      const entries = Object.entries(value);
      if (entries.length === 0) {
        return;
      }
      lines.push(`${prefix}${key}:`);
      for (const [k, v] of entries) {
        serializeValue(k, v, indent + 1);
      }
      return;
    }
    lines.push(`${prefix}${key}: ${yamlSafeString(value)}`);
  }
  const orderedKeys = [
    "version",
    "mode",
    "always_use_skills",
    "prefer_skills",
    "avoid_skills",
    "skill_rules",
    "custom_instructions",
    "models",
    "skill_discovery",
    "skill_staleness_days",
    "auto_supervisor",
    "uat_dispatch",
    "unique_milestone_ids",
    "budget_ceiling",
    "budget_enforcement",
    "context_pause_threshold",
    "notifications",
    "cmux",
    "remote_questions",
    "git",
    "stale_commit_threshold_minutes",
    "min_request_interval_ms",
    "post_unit_hooks",
    "pre_dispatch_hooks",
    "dynamic_routing",
    "disabled_model_providers",
    "uok",
    "token_profile",
    "service_tier",
    "flat_rate_providers",
    "phases",
    "parallel",
    "slice_parallel",
    "reactive_execution",
    "gate_evaluation",
    "auto_visualize",
    "auto_report",
    "verification_commands",
    "verification_auto_fix",
    "verification_max_retries",
    "enhanced_verification",
    "enhanced_verification_pre",
    "enhanced_verification_post",
    "enhanced_verification_strict",
    "safety_harness",
    "discuss_preparation",
    "discuss_web_research",
    "discuss_depth",
    "search_provider",
    "context_selection",
    "context_management",
    "context_window_override",
    "codebase",
    "widget_mode",
    "forensics_dedup",
    "show_token_cost",
    "github",
    "experimental",
    "language"
  ];
  const seen = /* @__PURE__ */ new Set();
  for (const key of orderedKeys) {
    if (key in prefs) {
      serializeValue(key, prefs[key], 0);
      seen.add(key);
    }
  }
  for (const [key, value] of Object.entries(prefs)) {
    if (!seen.has(key)) {
      serializeValue(key, value, 0);
    }
  }
  return lines.join("\n") + "\n";
}
async function ensurePreferencesFile(path, ctx, scope) {
  if (!existsSync(path)) {
    const template = await loadFile(join(dirname(fileURLToPath(import.meta.url)), "templates", "PREFERENCES.md"));
    if (!template) {
      ctx.ui.notify("Could not load GSD preferences template.", "error");
      return;
    }
    await saveFile(path, template);
    ctx.ui.notify(`Created ${scope} GSD skill preferences at ${path}`, "info");
  } else {
    ctx.ui.notify(`Using existing ${scope} GSD skill preferences at ${path}`, "info");
  }
}
async function handleLanguage(args, ctx) {
  const path = getGlobalGSDPreferencesPath();
  const lang = args.trim();
  if (!lang) {
    const loaded = loadGlobalGSDPreferences();
    const current = loaded?.preferences.language;
    if (current) {
      ctx.ui.notify(`Current language preference: ${current}
Use /gsd language <name> to change, or /gsd language off to clear.`, "info");
    } else {
      ctx.ui.notify("No language preference set. Use /gsd language <name> to set one (e.g. /gsd language Chinese).", "info");
    }
    return;
  }
  await ensurePreferencesFile(path, ctx, "global");
  const existing = loadGlobalGSDPreferences();
  const prefs = existing?.preferences ? { ...existing.preferences } : { version: 1 };
  if (lang === "off" || lang === "none" || lang === "clear") {
    delete prefs.language;
    ctx.ui.notify("Language preference cleared. GSD will use the default language.", "info");
  } else {
    if (lang.length > 50 || /[\r\n]/.test(lang)) {
      ctx.ui.notify(
        "Language value must be 50 characters or fewer with no newlines (e.g. /gsd language Chinese).",
        "warning"
      );
      return;
    }
    prefs.language = lang;
    ctx.ui.notify(`Language preference set to: ${lang}
GSD will now respond in ${lang} across all sessions.`, "info");
  }
  const rawContent = existsSync(path) ? readFileSync(path, "utf-8") : `---
version: 1
---
`;
  const frontmatter = serializePreferencesToFrontmatter(prefs);
  const body = extractBodyAfterFrontmatter(rawContent) ?? "\n# GSD Skill Preferences\n\nSee `~/.gsd/agent/extensions/gsd/docs/preferences-reference.md` for full field documentation and examples.\n";
  await saveFile(path, `---
${frontmatter}---${body}`);
  await ctx.waitForIdle();
  await ctx.reload();
}
export {
  buildCategorySummaries,
  configureMode,
  ensurePreferencesFile,
  formatConfiguredModel,
  handleImportClaude,
  handleLanguage,
  handlePrefs,
  handlePrefsMode,
  handlePrefsWizard,
  serializePreferencesToFrontmatter,
  toPersistedModelId,
  writePreferencesFile,
  yamlSafeString
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9jb21tYW5kcy1wcmVmcy13aXphcmQudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogR1NEIFByZWZlcmVuY2VzIFdpemFyZCBcdTIwMTQgVFVJIHdpemFyZCBmb3IgY29uZmlndXJpbmcgR1NEIHByZWZlcmVuY2VzLlxuICpcbiAqIENvbnRhaW5zOiBoYW5kbGVQcmVmc1dpemFyZCwgYnVpbGRDYXRlZ29yeVN1bW1hcmllcywgYWxsIGNvbmZpZ3VyZSogZnVuY3Rpb25zLFxuICogc2VyaWFsaXplUHJlZmVyZW5jZXNUb0Zyb250bWF0dGVyLCB5YW1sU2FmZVN0cmluZywgZW5zdXJlUHJlZmVyZW5jZXNGaWxlLFxuICogaGFuZGxlUHJlZnNNb2RlLCBoYW5kbGVJbXBvcnRDbGF1ZGUsIGhhbmRsZVByZWZzXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBFeHRlbnNpb25Db21tYW5kQ29udGV4dCB9IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4sIGRpcm5hbWUgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBmaWxlVVJMVG9QYXRoIH0gZnJvbSBcIm5vZGU6dXJsXCI7XG5pbXBvcnQge1xuICBnZXRHbG9iYWxHU0RQcmVmZXJlbmNlc1BhdGgsXG4gIGdldExlZ2FjeUdsb2JhbEdTRFByZWZlcmVuY2VzUGF0aCxcbiAgZ2V0UHJvamVjdEdTRFByZWZlcmVuY2VzUGF0aCxcbiAgbG9hZEdsb2JhbEdTRFByZWZlcmVuY2VzLFxuICBsb2FkUHJvamVjdEdTRFByZWZlcmVuY2VzLFxuICBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMsXG4gIHJlc29sdmVBbGxTa2lsbFJlZmVyZW5jZXMsXG59IGZyb20gXCIuL3ByZWZlcmVuY2VzLmpzXCI7XG5pbXBvcnQgeyBsb2FkRmlsZSwgc2F2ZUZpbGUsIHNwbGl0RnJvbnRtYXR0ZXIsIHBhcnNlRnJvbnRtYXR0ZXJNYXAgfSBmcm9tIFwiLi9maWxlcy5qc1wiO1xuaW1wb3J0IHsgcnVuQ2xhdWRlSW1wb3J0RmxvdyB9IGZyb20gXCIuL2NsYXVkZS1pbXBvcnQuanNcIjtcblxuLyoqIEV4dHJhY3QgYm9keSBjb250ZW50IGFmdGVyIGZyb250bWF0dGVyIGNsb3NpbmcgZGVsaW1pdGVyLCBvciBudWxsIGlmIG5vbmUuICovXG5mdW5jdGlvbiBleHRyYWN0Qm9keUFmdGVyRnJvbnRtYXR0ZXIoY29udGVudDogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IGNsb3NpbmdJZHggPSBjb250ZW50LmluZGV4T2YoXCJcXG4tLS1cIiwgY29udGVudC5pbmRleE9mKFwiLS0tXCIpKTtcbiAgaWYgKGNsb3NpbmdJZHggPT09IC0xKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgYWZ0ZXJGcm9udG1hdHRlciA9IGNvbnRlbnQuc2xpY2UoY2xvc2luZ0lkeCArIDQpO1xuICByZXR1cm4gYWZ0ZXJGcm9udG1hdHRlci50cmltKCkgPyBhZnRlckZyb250bWF0dGVyIDogbnVsbDtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIE51bWVyaWMgdmFsaWRhdGlvbiBoZWxwZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKiogUGFyc2UgYSBzdHJpbmcgYXMgYSBub24tbmVnYXRpdmUgaW50ZWdlciwgb3IgcmV0dXJuIG51bGwgb24gZmFpbHVyZS4gKi9cbmZ1bmN0aW9uIHRyeVBhcnNlSW50ZWdlcih2YWw6IHN0cmluZyk6IG51bWJlciB8IG51bGwge1xuICByZXR1cm4gL15cXGQrJC8udGVzdCh2YWwpID8gTnVtYmVyKHZhbCkgOiBudWxsO1xufVxuXG4vKiogUGFyc2UgYSBzdHJpbmcgYXMgYSBmaW5pdGUgbnVtYmVyLCBvciByZXR1cm4gbnVsbCBvbiBmYWlsdXJlLiAqL1xuZnVuY3Rpb24gdHJ5UGFyc2VOdW1iZXIodmFsOiBzdHJpbmcpOiBudW1iZXIgfCBudWxsIHtcbiAgY29uc3QgbiA9IE51bWJlcih2YWwpO1xuICByZXR1cm4gIWlzTmFOKG4pICYmIGlzRmluaXRlKG4pID8gbiA6IG51bGw7XG59XG5cbi8qKiBQYXJzZSBhIHN0cmluZyBhcyBhIG51bWJlciBpbiB0aGUgMFx1MjAxMzEwMCByYW5nZSwgb3IgcmV0dXJuIG51bGwgb24gZmFpbHVyZS4gKi9cbmZ1bmN0aW9uIHRyeVBhcnNlUGVyY2VudGFnZSh2YWw6IHN0cmluZyk6IG51bWJlciB8IG51bGwge1xuICBjb25zdCBuID0gTnVtYmVyKHZhbCk7XG4gIHJldHVybiAhaXNOYU4obikgJiYgbiA+PSAwICYmIG4gPD0gMTAwID8gbiA6IG51bGw7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBQcm9tcHQgaGVscGVycyAocmVkdWNlIGJvaWxlcnBsYXRlIGFjcm9zcyBjb25maWd1cmUqIGZ1bmN0aW9ucykgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKiBBc2sgZm9yIGEgYm9vbGVhbjsgcmV0dXJucyB0aGUgY2hvc2VuIHZhbHVlLCBvciB1bmRlZmluZWQgaWYgdXNlciBrZXB0IGN1cnJlbnQvZXNjYXBlZC4gKi9cbmFzeW5jIGZ1bmN0aW9uIHByb21wdEJvb2xlYW4oXG4gIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsXG4gIGxhYmVsOiBzdHJpbmcsXG4gIGN1cnJlbnQ6IHVua25vd24sXG4gIGRlZmF1bHRWYWw/OiBib29sZWFuLFxuKTogUHJvbWlzZTxib29sZWFuIHwgdW5kZWZpbmVkPiB7XG4gIGNvbnN0IGN1cnJlbnRTdHIgPSB0eXBlb2YgY3VycmVudCA9PT0gXCJib29sZWFuXCIgPyBTdHJpbmcoY3VycmVudCkgOiBcIlwiO1xuICBjb25zdCBzdWZmaXggPSBjdXJyZW50U3RyXG4gICAgPyBgIChjdXJyZW50OiAke2N1cnJlbnRTdHJ9KWBcbiAgICA6IGRlZmF1bHRWYWwgIT09IHVuZGVmaW5lZCA/IGAgKGRlZmF1bHQ6ICR7ZGVmYXVsdFZhbH0pYCA6IFwiXCI7XG4gIGNvbnN0IGNob2ljZSA9IGF3YWl0IGN0eC51aS5zZWxlY3QoYCR7bGFiZWx9JHtzdWZmaXh9OmAsIFtcInRydWVcIiwgXCJmYWxzZVwiLCBcIihrZWVwIGN1cnJlbnQpXCJdKTtcbiAgaWYgKCFjaG9pY2UgfHwgY2hvaWNlID09PSBcIihrZWVwIGN1cnJlbnQpXCIpIHJldHVybiB1bmRlZmluZWQ7XG4gIHJldHVybiBjaG9pY2UgPT09IFwidHJ1ZVwiO1xufVxuXG4vKiogQXNrIGZvciBhbiBlbnVtLXN0eWxlIHZhbHVlOyByZXR1cm5zIHRoZSBjaG9zZW4gc3RyaW5nLCBvciB1bmRlZmluZWQgaWYga2VwdC4gKi9cbmFzeW5jIGZ1bmN0aW9uIHByb21wdEVudW0oXG4gIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsXG4gIGxhYmVsOiBzdHJpbmcsXG4gIGN1cnJlbnQ6IHVua25vd24sXG4gIHZhbHVlczogcmVhZG9ubHkgc3RyaW5nW10sXG4gIGRlZmF1bHRWYWw/OiBzdHJpbmcsXG4pOiBQcm9taXNlPHN0cmluZyB8IHVuZGVmaW5lZD4ge1xuICBjb25zdCBjdXJyZW50U3RyID0gdHlwZW9mIGN1cnJlbnQgPT09IFwic3RyaW5nXCIgPyBjdXJyZW50IDogXCJcIjtcbiAgY29uc3Qgc3VmZml4ID0gY3VycmVudFN0clxuICAgID8gYCAoY3VycmVudDogJHtjdXJyZW50U3RyfSlgXG4gICAgOiBkZWZhdWx0VmFsID8gYCAoZGVmYXVsdDogJHtkZWZhdWx0VmFsfSlgIDogXCJcIjtcbiAgY29uc3Qgb3B0aW9ucyA9IFsuLi52YWx1ZXMsIFwiKGtlZXAgY3VycmVudClcIl07XG4gIGNvbnN0IGNob2ljZSA9IGF3YWl0IGN0eC51aS5zZWxlY3QoYCR7bGFiZWx9JHtzdWZmaXh9OmAsIG9wdGlvbnMpO1xuICBpZiAoIWNob2ljZSB8fCB0eXBlb2YgY2hvaWNlICE9PSBcInN0cmluZ1wiIHx8IGNob2ljZSA9PT0gXCIoa2VlcCBjdXJyZW50KVwiKSByZXR1cm4gdW5kZWZpbmVkO1xuICByZXR1cm4gY2hvaWNlO1xufVxuXG4vKipcbiAqIEFzayBmb3IgYSBub24tbmVnYXRpdmUgaW50ZWdlci5cbiAqIFJldHVybnMgcGFyc2VkIG51bWJlciBvbiBzdWNjZXNzOyBcImNsZWFyXCIgd2hlbiB0aGUgdXNlciBleHBsaWNpdGx5IGNsZWFyZWQgYW4gZXhpc3RpbmcgdmFsdWU7XG4gKiB1bmRlZmluZWQgb24gZXNjYXBlLCBlbXB0eS13aXRoLW5vLWV4aXN0aW5nLXZhbHVlLCBvciBpbnZhbGlkIGlucHV0ICh3YXJuaW5nIGVtaXR0ZWQgaW4gdGhlIGludmFsaWQgY2FzZSkuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHByb21wdEludGVnZXIoXG4gIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsXG4gIGxhYmVsOiBzdHJpbmcsXG4gIGN1cnJlbnQ6IHVua25vd24sXG4gIGRlZmF1bHRWYWw/OiBzdHJpbmcsXG4pOiBQcm9taXNlPG51bWJlciB8IFwiY2xlYXJcIiB8IHVuZGVmaW5lZD4ge1xuICBjb25zdCBoYWRWYWx1ZSA9IGN1cnJlbnQgIT09IHVuZGVmaW5lZCAmJiBjdXJyZW50ICE9PSBudWxsO1xuICBjb25zdCBjdXJyZW50U3RyID0gaGFkVmFsdWUgPyBTdHJpbmcoY3VycmVudCkgOiBcIlwiO1xuICBjb25zdCBzdWZmaXggPSBjdXJyZW50U3RyID8gYCAoY3VycmVudDogJHtjdXJyZW50U3RyfSlgIDogZGVmYXVsdFZhbCA/IGAgKGRlZmF1bHQ6ICR7ZGVmYXVsdFZhbH0pYCA6IFwiXCI7XG4gIGNvbnN0IGlucHV0ID0gYXdhaXQgY3R4LnVpLmlucHV0KGAke2xhYmVsfSR7c3VmZml4fTpgLCBjdXJyZW50U3RyIHx8IChkZWZhdWx0VmFsID8/IFwiXCIpKTtcbiAgaWYgKGlucHV0ID09PSBudWxsIHx8IGlucHV0ID09PSB1bmRlZmluZWQpIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IHZhbCA9IGlucHV0LnRyaW0oKTtcbiAgaWYgKCF2YWwpIHJldHVybiBoYWRWYWx1ZSA/IFwiY2xlYXJcIiA6IHVuZGVmaW5lZDtcbiAgY29uc3QgcGFyc2VkID0gdHJ5UGFyc2VJbnRlZ2VyKHZhbCk7XG4gIGlmIChwYXJzZWQgPT09IG51bGwpIHtcbiAgICBjdHgudWkubm90aWZ5KGBJbnZhbGlkIHZhbHVlIFwiJHt2YWx9XCIgZm9yICR7bGFiZWx9IFx1MjAxNCBtdXN0IGJlIGEgd2hvbGUgbnVtYmVyLiBLZWVwaW5nIHByZXZpb3VzIHZhbHVlLmAsIFwid2FybmluZ1wiKTtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG4gIHJldHVybiBwYXJzZWQ7XG59XG5cbi8qKiBBc2sgZm9yIGEgZmluaXRlIG51bWJlci4gU2VlIHByb21wdEludGVnZXIgZm9yIHJldHVybiBzZW1hbnRpY3MuICovXG5hc3luYyBmdW5jdGlvbiBwcm9tcHROdW1iZXIoXG4gIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsXG4gIGxhYmVsOiBzdHJpbmcsXG4gIGN1cnJlbnQ6IHVua25vd24sXG4gIGRlZmF1bHRWYWw/OiBzdHJpbmcsXG4pOiBQcm9taXNlPG51bWJlciB8IFwiY2xlYXJcIiB8IHVuZGVmaW5lZD4ge1xuICBjb25zdCBoYWRWYWx1ZSA9IGN1cnJlbnQgIT09IHVuZGVmaW5lZCAmJiBjdXJyZW50ICE9PSBudWxsO1xuICBjb25zdCBjdXJyZW50U3RyID0gaGFkVmFsdWUgPyBTdHJpbmcoY3VycmVudCkgOiBcIlwiO1xuICBjb25zdCBzdWZmaXggPSBjdXJyZW50U3RyID8gYCAoY3VycmVudDogJHtjdXJyZW50U3RyfSlgIDogZGVmYXVsdFZhbCA/IGAgKGRlZmF1bHQ6ICR7ZGVmYXVsdFZhbH0pYCA6IFwiXCI7XG4gIGNvbnN0IGlucHV0ID0gYXdhaXQgY3R4LnVpLmlucHV0KGAke2xhYmVsfSR7c3VmZml4fTpgLCBjdXJyZW50U3RyIHx8IChkZWZhdWx0VmFsID8/IFwiXCIpKTtcbiAgaWYgKGlucHV0ID09PSBudWxsIHx8IGlucHV0ID09PSB1bmRlZmluZWQpIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IHZhbCA9IGlucHV0LnRyaW0oKTtcbiAgaWYgKCF2YWwpIHJldHVybiBoYWRWYWx1ZSA/IFwiY2xlYXJcIiA6IHVuZGVmaW5lZDtcbiAgY29uc3QgcGFyc2VkID0gdHJ5UGFyc2VOdW1iZXIodmFsKTtcbiAgaWYgKHBhcnNlZCA9PT0gbnVsbCkge1xuICAgIGN0eC51aS5ub3RpZnkoYEludmFsaWQgdmFsdWUgXCIke3ZhbH1cIiBmb3IgJHtsYWJlbH0gXHUyMDE0IG11c3QgYmUgYSBudW1iZXIuIEtlZXBpbmcgcHJldmlvdXMgdmFsdWUuYCwgXCJ3YXJuaW5nXCIpO1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cbiAgcmV0dXJuIHBhcnNlZDtcbn1cblxuLyoqIEFwcGx5IGEgcHJvbXB0SW50ZWdlci9wcm9tcHROdW1iZXIgcmVzdWx0IHRvIGEgcHJlZnMgZGljdC4gKi9cbmZ1bmN0aW9uIGFwcGx5TnVtYmVyKHByZWZzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwga2V5OiBzdHJpbmcsIHJlc3VsdDogbnVtYmVyIHwgXCJjbGVhclwiIHwgdW5kZWZpbmVkKTogdm9pZCB7XG4gIGlmIChyZXN1bHQgPT09IHVuZGVmaW5lZCkgcmV0dXJuO1xuICBpZiAocmVzdWx0ID09PSBcImNsZWFyXCIpIGRlbGV0ZSBwcmVmc1trZXldO1xuICBlbHNlIHByZWZzW2tleV0gPSByZXN1bHQ7XG59XG5cbi8qKiBBc2sgZm9yIGEgZnJlZS1mb3JtIHN0cmluZzsgcmV0dXJucyB0aGUgdHJpbW1lZCB2YWx1ZSwgZW1wdHkgc3RyaW5nIHRvIGNsZWFyLCBvciB1bmRlZmluZWQgaWYgZXNjYXBlZC4gKi9cbmFzeW5jIGZ1bmN0aW9uIHByb21wdFN0cmluZyhcbiAgY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCxcbiAgbGFiZWw6IHN0cmluZyxcbiAgY3VycmVudDogdW5rbm93bixcbiAgZGVmYXVsdFZhbD86IHN0cmluZyxcbik6IFByb21pc2U8c3RyaW5nIHwgdW5kZWZpbmVkPiB7XG4gIGNvbnN0IGN1cnJlbnRTdHIgPSB0eXBlb2YgY3VycmVudCA9PT0gXCJzdHJpbmdcIiA/IGN1cnJlbnQgOiBcIlwiO1xuICBjb25zdCBzdWZmaXggPSBjdXJyZW50U3RyID8gYCAoY3VycmVudDogJHtjdXJyZW50U3RyfSlgIDogZGVmYXVsdFZhbCA/IGAgKGRlZmF1bHQ6ICR7ZGVmYXVsdFZhbH0pYCA6IFwiXCI7XG4gIGNvbnN0IGlucHV0ID0gYXdhaXQgY3R4LnVpLmlucHV0KGAke2xhYmVsfSR7c3VmZml4fTpgLCBjdXJyZW50U3RyIHx8IChkZWZhdWx0VmFsID8/IFwiXCIpKTtcbiAgaWYgKGlucHV0ID09PSBudWxsIHx8IGlucHV0ID09PSB1bmRlZmluZWQpIHJldHVybiB1bmRlZmluZWQ7XG4gIHJldHVybiBpbnB1dC50cmltKCk7XG59XG5cbi8qKiBQYXJzZSBjb21tYS0gb3IgbmV3bGluZS1zZXBhcmF0ZWQgaW5wdXQgaW50byBhIGRlZHVwbGljYXRlZCBzdHJpbmcgYXJyYXkuICovXG5mdW5jdGlvbiBwYXJzZVN0cmluZ0xpc3QoaW5wdXQ6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIGlucHV0XG4gICAgLnNwbGl0KC9bLFxcbl0vKVxuICAgIC5tYXAocyA9PiBzLnRyaW0oKSlcbiAgICAuZmlsdGVyKHMgPT4gcy5sZW5ndGggPiAwKTtcbn1cblxuLyoqIFN1Yi1tZW51IHRvIGVkaXQgYSBzdHJpbmcgbGlzdCBmaWVsZCAoYWRkIC8gcmVtb3ZlIC8gY2xlYXIgLyBkb25lKS4gTXV0YXRlcyB0aGUgcGFyZW50IHByZWZzIG9iamVjdC4gKi9cbmFzeW5jIGZ1bmN0aW9uIGVkaXRTdHJpbmdMaXN0RmllbGQoXG4gIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsXG4gIHByZWZzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAga2V5OiBzdHJpbmcsXG4gIGxhYmVsOiBzdHJpbmcsXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgY3VycmVudCA9IEFycmF5LmlzQXJyYXkocHJlZnNba2V5XSkgPyBbLi4ucHJlZnNba2V5XSBhcyBzdHJpbmdbXV0gOiBbXTtcbiAgbGV0IGxpc3QgPSBjdXJyZW50O1xuICB3aGlsZSAodHJ1ZSkge1xuICAgIGNvbnN0IHN1bW1hcnkgPSBsaXN0Lmxlbmd0aCA9PT0gMCA/IFwiKGVtcHR5KVwiIDogYCR7bGlzdC5sZW5ndGh9IGl0ZW0ocyk6ICR7bGlzdC5zbGljZSgwLCAzKS5qb2luKFwiLCBcIil9JHtsaXN0Lmxlbmd0aCA+IDMgPyBcIlx1MjAyNlwiIDogXCJcIn1gO1xuICAgIGNvbnN0IGNob2ljZSA9IGF3YWl0IGN0eC51aS5zZWxlY3QoXG4gICAgICBgJHtsYWJlbH0gXHUyMDE0ICR7c3VtbWFyeX1gLFxuICAgICAgW1wiQWRkIGVudHJpZXNcIiwgXCJSZW1vdmUgZW50cnlcIiwgXCJDbGVhciBhbGxcIiwgXCJEb25lXCJdLFxuICAgICk7XG4gICAgY29uc3QgcGljayA9IHR5cGVvZiBjaG9pY2UgPT09IFwic3RyaW5nXCIgPyBjaG9pY2UgOiBcIlwiO1xuICAgIGlmICghcGljayB8fCBwaWNrID09PSBcIkRvbmVcIikgYnJlYWs7XG4gICAgaWYgKHBpY2sgPT09IFwiQWRkIGVudHJpZXNcIikge1xuICAgICAgY29uc3QgaW5wdXQgPSBhd2FpdCBjdHgudWkuaW5wdXQoYEFkZCB0byAke2xhYmVsfSAoY29tbWEtIG9yIG5ld2xpbmUtc2VwYXJhdGVkKTpgLCBcIlwiKTtcbiAgICAgIGlmIChpbnB1dCkge1xuICAgICAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgcGFyc2VTdHJpbmdMaXN0KGlucHV0KSkge1xuICAgICAgICAgIGlmICghbGlzdC5pbmNsdWRlcyhpdGVtKSkgbGlzdC5wdXNoKGl0ZW0pO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBlbHNlIGlmIChwaWNrID09PSBcIlJlbW92ZSBlbnRyeVwiKSB7XG4gICAgICBpZiAobGlzdC5sZW5ndGggPT09IDApIGNvbnRpbnVlO1xuICAgICAgY29uc3QgcmVtb3ZlQ2hvaWNlID0gYXdhaXQgY3R4LnVpLnNlbGVjdChgUmVtb3ZlIHdoaWNoIGVudHJ5P2AsIFsuLi5saXN0LCBcIihjYW5jZWwpXCJdKTtcbiAgICAgIGNvbnN0IHJlbW92ZVN0ciA9IHR5cGVvZiByZW1vdmVDaG9pY2UgPT09IFwic3RyaW5nXCIgPyByZW1vdmVDaG9pY2UgOiBcIlwiO1xuICAgICAgaWYgKHJlbW92ZVN0ciAmJiByZW1vdmVTdHIgIT09IFwiKGNhbmNlbClcIikge1xuICAgICAgICBsaXN0ID0gbGlzdC5maWx0ZXIoeCA9PiB4ICE9PSByZW1vdmVTdHIpO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAocGljayA9PT0gXCJDbGVhciBhbGxcIikge1xuICAgICAgbGlzdCA9IFtdO1xuICAgIH1cbiAgfVxuICBpZiAobGlzdC5sZW5ndGggPiAwKSB7XG4gICAgcHJlZnNba2V5XSA9IGxpc3Q7XG4gIH0gZWxzZSBpZiAocHJlZnNba2V5XSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgZGVsZXRlIHByZWZzW2tleV07XG4gIH1cbn1cblxuLyoqIFNldCBhIG5lc3RlZCBvYmplY3Qga2V5LCBjcmVhdGluZyB0aGUgcGFyZW50IG9iamVjdCBpZiBuZWVkZWQsIGFuZCBkZWxldGluZyBvbiB1bmRlZmluZWQvZW1wdHkuICovXG5mdW5jdGlvbiBzZXROZXN0ZWQocGFyZW50OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwgcGFyZW50S2V5OiBzdHJpbmcsIGNoaWxkS2V5OiBzdHJpbmcsIHZhbHVlOiB1bmtub3duKTogdm9pZCB7XG4gIGxldCBjaGlsZCA9IHBhcmVudFtwYXJlbnRLZXldIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkO1xuICBpZiAoIWNoaWxkIHx8IHR5cGVvZiBjaGlsZCAhPT0gXCJvYmplY3RcIikgY2hpbGQgPSB7fTtcbiAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQpIHJldHVybjtcbiAgKGNoaWxkIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KVtjaGlsZEtleV0gPSB2YWx1ZTtcbiAgcGFyZW50W3BhcmVudEtleV0gPSBjaGlsZDtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZVByZWZzKGFyZ3M6IHN0cmluZywgY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB0cmltbWVkID0gYXJncy50cmltKCk7XG5cbiAgaWYgKHRyaW1tZWQgPT09IFwiXCIgfHwgdHJpbW1lZCA9PT0gXCJnbG9iYWxcIiB8fCB0cmltbWVkID09PSBcIndpemFyZFwiIHx8IHRyaW1tZWQgPT09IFwic2V0dXBcIlxuICAgIHx8IHRyaW1tZWQgPT09IFwid2l6YXJkIGdsb2JhbFwiIHx8IHRyaW1tZWQgPT09IFwic2V0dXAgZ2xvYmFsXCIpIHtcbiAgICBhd2FpdCBlbnN1cmVQcmVmZXJlbmNlc0ZpbGUoZ2V0R2xvYmFsR1NEUHJlZmVyZW5jZXNQYXRoKCksIGN0eCwgXCJnbG9iYWxcIik7XG4gICAgYXdhaXQgaGFuZGxlUHJlZnNXaXphcmQoY3R4LCBcImdsb2JhbFwiKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAodHJpbW1lZCA9PT0gXCJwcm9qZWN0XCIgfHwgdHJpbW1lZCA9PT0gXCJ3aXphcmQgcHJvamVjdFwiIHx8IHRyaW1tZWQgPT09IFwic2V0dXAgcHJvamVjdFwiKSB7XG4gICAgYXdhaXQgZW5zdXJlUHJlZmVyZW5jZXNGaWxlKGdldFByb2plY3RHU0RQcmVmZXJlbmNlc1BhdGgoKSwgY3R4LCBcInByb2plY3RcIik7XG4gICAgYXdhaXQgaGFuZGxlUHJlZnNXaXphcmQoY3R4LCBcInByb2plY3RcIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKHRyaW1tZWQgPT09IFwiaW1wb3J0LWNsYXVkZVwiIHx8IHRyaW1tZWQgPT09IFwiaW1wb3J0LWNsYXVkZSBnbG9iYWxcIikge1xuICAgIGF3YWl0IGhhbmRsZUltcG9ydENsYXVkZShjdHgsIFwiZ2xvYmFsXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICh0cmltbWVkID09PSBcImltcG9ydC1jbGF1ZGUgcHJvamVjdFwiKSB7XG4gICAgYXdhaXQgaGFuZGxlSW1wb3J0Q2xhdWRlKGN0eCwgXCJwcm9qZWN0XCIpO1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAodHJpbW1lZCA9PT0gXCJzdGF0dXNcIikge1xuICAgIGNvbnN0IGdsb2JhbFByZWZzID0gbG9hZEdsb2JhbEdTRFByZWZlcmVuY2VzKCk7XG4gICAgY29uc3QgcHJvamVjdFByZWZzID0gbG9hZFByb2plY3RHU0RQcmVmZXJlbmNlcygpO1xuICAgIGNvbnN0IGNhbm9uaWNhbEdsb2JhbCA9IGdldEdsb2JhbEdTRFByZWZlcmVuY2VzUGF0aCgpO1xuICAgIGNvbnN0IGxlZ2FjeUdsb2JhbCA9IGdldExlZ2FjeUdsb2JhbEdTRFByZWZlcmVuY2VzUGF0aCgpO1xuICAgIGNvbnN0IGdsb2JhbFN0YXR1cyA9IGdsb2JhbFByZWZzXG4gICAgICA/IGBwcmVzZW50OiAke2dsb2JhbFByZWZzLnBhdGh9JHtnbG9iYWxQcmVmcy5wYXRoID09PSBsZWdhY3lHbG9iYWwgPyBcIiAobGVnYWN5IGZhbGxiYWNrKVwiIDogXCJcIn1gXG4gICAgICA6IGBtaXNzaW5nOiAke2Nhbm9uaWNhbEdsb2JhbH1gO1xuICAgIGNvbnN0IHByb2plY3RTdGF0dXMgPSBwcm9qZWN0UHJlZnMgPyBgcHJlc2VudDogJHtwcm9qZWN0UHJlZnMucGF0aH1gIDogYG1pc3Npbmc6ICR7Z2V0UHJvamVjdEdTRFByZWZlcmVuY2VzUGF0aCgpfWA7XG5cbiAgICBjb25zdCBsaW5lcyA9IFtgR1NEIHNraWxsIHByZWZzIFx1MjAxNCBnbG9iYWwgJHtnbG9iYWxTdGF0dXN9OyBwcm9qZWN0ICR7cHJvamVjdFN0YXR1c31gXTtcblxuICAgIGNvbnN0IGVmZmVjdGl2ZSA9IGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcygpO1xuICAgIGxldCBoYXNVbnJlc29sdmVkID0gZmFsc2U7XG4gICAgaWYgKGVmZmVjdGl2ZSkge1xuICAgICAgY29uc3QgcmVwb3J0ID0gcmVzb2x2ZUFsbFNraWxsUmVmZXJlbmNlcyhlZmZlY3RpdmUucHJlZmVyZW5jZXMsIHByb2Nlc3MuY3dkKCkpO1xuICAgICAgY29uc3QgcmVzb2x2ZWQgPSBbLi4ucmVwb3J0LnJlc29sdXRpb25zLnZhbHVlcygpXS5maWx0ZXIociA9PiByLm1ldGhvZCAhPT0gXCJ1bnJlc29sdmVkXCIpO1xuICAgICAgaGFzVW5yZXNvbHZlZCA9IHJlcG9ydC53YXJuaW5ncy5sZW5ndGggPiAwO1xuICAgICAgaWYgKHJlc29sdmVkLmxlbmd0aCA+IDAgfHwgaGFzVW5yZXNvbHZlZCkge1xuICAgICAgICBsaW5lcy5wdXNoKGBTa2lsbHM6ICR7cmVzb2x2ZWQubGVuZ3RofSByZXNvbHZlZCwgJHtyZXBvcnQud2FybmluZ3MubGVuZ3RofSB1bnJlc29sdmVkYCk7XG4gICAgICB9XG4gICAgICBpZiAoaGFzVW5yZXNvbHZlZCkge1xuICAgICAgICBsaW5lcy5wdXNoKGBVbnJlc29sdmVkOiAke3JlcG9ydC53YXJuaW5ncy5qb2luKFwiLCBcIil9YCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgY3R4LnVpLm5vdGlmeShsaW5lcy5qb2luKFwiXFxuXCIpLCBoYXNVbnJlc29sdmVkID8gXCJ3YXJuaW5nXCIgOiBcImluZm9cIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY3R4LnVpLm5vdGlmeShcIlVzYWdlOiAvZ3NkIHByZWZzIFtnbG9iYWx8cHJvamVjdHxzdGF0dXN8d2l6YXJkfHNldHVwfGltcG9ydC1jbGF1ZGUgW2dsb2JhbHxwcm9qZWN0XV1cIiwgXCJpbmZvXCIpO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlSW1wb3J0Q2xhdWRlKGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsIHNjb3BlOiBcImdsb2JhbFwiIHwgXCJwcm9qZWN0XCIpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgcGF0aCA9IHNjb3BlID09PSBcInByb2plY3RcIiA/IGdldFByb2plY3RHU0RQcmVmZXJlbmNlc1BhdGgoKSA6IGdldEdsb2JhbEdTRFByZWZlcmVuY2VzUGF0aCgpO1xuICBpZiAoIWV4aXN0c1N5bmMocGF0aCkpIHtcbiAgICBhd2FpdCBlbnN1cmVQcmVmZXJlbmNlc0ZpbGUocGF0aCwgY3R4LCBzY29wZSk7XG4gIH1cblxuICBjb25zdCByZWFkUHJlZnMgPSAoKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT4ge1xuICAgIGlmICghZXhpc3RzU3luYyhwYXRoKSkgcmV0dXJuIHsgdmVyc2lvbjogMSB9O1xuICAgIGNvbnN0IGNvbnRlbnQgPSByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGYtOFwiKTtcbiAgICBjb25zdCBbZnJvbnRtYXR0ZXJMaW5lc10gPSBzcGxpdEZyb250bWF0dGVyKGNvbnRlbnQpO1xuICAgIHJldHVybiBmcm9udG1hdHRlckxpbmVzID8gcGFyc2VGcm9udG1hdHRlck1hcChmcm9udG1hdHRlckxpbmVzKSA6IHsgdmVyc2lvbjogMSB9O1xuICB9O1xuXG4gIGNvbnN0IHdyaXRlUHJlZnMgPSBhc3luYyAocHJlZnM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogUHJvbWlzZTx2b2lkPiA9PiB7XG4gICAgcHJlZnMudmVyc2lvbiA9IHByZWZzLnZlcnNpb24gfHwgMTtcbiAgICBjb25zdCBmcm9udG1hdHRlciA9IHNlcmlhbGl6ZVByZWZlcmVuY2VzVG9Gcm9udG1hdHRlcihwcmVmcyk7XG4gICAgbGV0IGJvZHkgPSBcIlxcbiMgR1NEIFNraWxsIFByZWZlcmVuY2VzXFxuXFxuU2VlIGB+Ly5nc2QvYWdlbnQvZXh0ZW5zaW9ucy9nc2QvZG9jcy9wcmVmZXJlbmNlcy1yZWZlcmVuY2UubWRgIGZvciBmdWxsIGZpZWxkIGRvY3VtZW50YXRpb24gYW5kIGV4YW1wbGVzLlxcblwiO1xuICAgIGlmIChleGlzdHNTeW5jKHBhdGgpKSB7XG4gICAgICBjb25zdCBwcmVzZXJ2ZWQgPSBleHRyYWN0Qm9keUFmdGVyRnJvbnRtYXR0ZXIocmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmLThcIikpO1xuICAgICAgaWYgKHByZXNlcnZlZCkgYm9keSA9IHByZXNlcnZlZDtcbiAgICB9XG4gICAgYXdhaXQgc2F2ZUZpbGUocGF0aCwgYC0tLVxcbiR7ZnJvbnRtYXR0ZXJ9LS0tJHtib2R5fWApO1xuICB9O1xuXG4gIGF3YWl0IHJ1bkNsYXVkZUltcG9ydEZsb3coY3R4LCBzY29wZSwgcmVhZFByZWZzLCB3cml0ZVByZWZzKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZVByZWZzTW9kZShjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LCBzY29wZTogXCJnbG9iYWxcIiB8IFwicHJvamVjdFwiKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHBhdGggPSBzY29wZSA9PT0gXCJwcm9qZWN0XCIgPyBnZXRQcm9qZWN0R1NEUHJlZmVyZW5jZXNQYXRoKCkgOiBnZXRHbG9iYWxHU0RQcmVmZXJlbmNlc1BhdGgoKTtcbiAgY29uc3QgZXhpc3RpbmcgPSBzY29wZSA9PT0gXCJwcm9qZWN0XCIgPyBsb2FkUHJvamVjdEdTRFByZWZlcmVuY2VzKCkgOiBsb2FkR2xvYmFsR1NEUHJlZmVyZW5jZXMoKTtcbiAgY29uc3QgcHJlZnM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0gZXhpc3Rpbmc/LnByZWZlcmVuY2VzID8geyAuLi5leGlzdGluZy5wcmVmZXJlbmNlcyB9IDoge307XG5cbiAgYXdhaXQgY29uZmlndXJlTW9kZShjdHgsIHByZWZzKTtcblxuICAvLyBTZXJpYWxpemUgYW5kIHNhdmVcbiAgcHJlZnMudmVyc2lvbiA9IHByZWZzLnZlcnNpb24gfHwgMTtcbiAgY29uc3QgZnJvbnRtYXR0ZXIgPSBzZXJpYWxpemVQcmVmZXJlbmNlc1RvRnJvbnRtYXR0ZXIocHJlZnMpO1xuXG4gIGxldCBib2R5ID0gXCJcXG4jIEdTRCBTa2lsbCBQcmVmZXJlbmNlc1xcblxcblNlZSBgfi8uZ3NkL2FnZW50L2V4dGVuc2lvbnMvZ3NkL2RvY3MvcHJlZmVyZW5jZXMtcmVmZXJlbmNlLm1kYCBmb3IgZnVsbCBmaWVsZCBkb2N1bWVudGF0aW9uIGFuZCBleGFtcGxlcy5cXG5cIjtcbiAgaWYgKGV4aXN0c1N5bmMocGF0aCkpIHtcbiAgICBjb25zdCBwcmVzZXJ2ZWQgPSBleHRyYWN0Qm9keUFmdGVyRnJvbnRtYXR0ZXIocmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmLThcIikpO1xuICAgIGlmIChwcmVzZXJ2ZWQpIGJvZHkgPSBwcmVzZXJ2ZWQ7XG4gIH1cblxuICBjb25zdCBjb250ZW50ID0gYC0tLVxcbiR7ZnJvbnRtYXR0ZXJ9LS0tJHtib2R5fWA7XG4gIGF3YWl0IHNhdmVGaWxlKHBhdGgsIGNvbnRlbnQpO1xuICBhd2FpdCBjdHgud2FpdEZvcklkbGUoKTtcbiAgYXdhaXQgY3R4LnJlbG9hZCgpO1xuICBjdHgudWkubm90aWZ5KGBTYXZlZCAke3Njb3BlfSBwcmVmZXJlbmNlcyB0byAke3BhdGh9YCwgXCJpbmZvXCIpO1xufVxuXG4vKiogQnVpbGQgc2hvcnQgc3VtbWFyeSBzdHJpbmdzIGZvciBlYWNoIHByZWZlcmVuY2UgY2F0ZWdvcnkuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRDYXRlZ29yeVN1bW1hcmllcyhwcmVmczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IHtcbiAgLy8gTW9kZVxuICBjb25zdCBtb2RlID0gcHJlZnMubW9kZSBhcyBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIGNvbnN0IG1vZGVTdW1tYXJ5ID0gbW9kZSA/PyBcIihub3Qgc2V0KVwiO1xuXG4gIC8vIE1vZGVsc1xuICBjb25zdCBtb2RlbHMgPSBwcmVmcy5tb2RlbHMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQ7XG4gIGNvbnN0IHRva2VuUHJvZmlsZSA9IHByZWZzLnRva2VuX3Byb2ZpbGUgYXMgc3RyaW5nIHwgdW5kZWZpbmVkO1xuICBjb25zdCBzZXJ2aWNlVGllciA9IHByZWZzLnNlcnZpY2VfdGllciBhcyBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIGNvbnN0IGZsYXRSYXRlID0gQXJyYXkuaXNBcnJheShwcmVmcy5mbGF0X3JhdGVfcHJvdmlkZXJzKSA/IChwcmVmcy5mbGF0X3JhdGVfcHJvdmlkZXJzIGFzIHN0cmluZ1tdKS5sZW5ndGggOiAwO1xuICBjb25zdCBkeW5Sb3V0aW5nID0gcHJlZnMuZHluYW1pY19yb3V0aW5nIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkO1xuICBsZXQgbW9kZWxzU3VtbWFyeSA9IFwiKG5vdCBjb25maWd1cmVkKVwiO1xuICB7XG4gICAgY29uc3QgcGFydHM6IHN0cmluZ1tdID0gW107XG4gICAgaWYgKG1vZGVscyAmJiBPYmplY3Qua2V5cyhtb2RlbHMpLmxlbmd0aCA+IDApIHtcbiAgICAgIHBhcnRzLnB1c2goYCR7T2JqZWN0LmtleXMobW9kZWxzKS5sZW5ndGh9IHBoYXNlKHMpYCk7XG4gICAgfVxuICAgIGlmICh0b2tlblByb2ZpbGUpIHBhcnRzLnB1c2goYHByb2ZpbGU6ICR7dG9rZW5Qcm9maWxlfWApO1xuICAgIGlmIChzZXJ2aWNlVGllcikgcGFydHMucHVzaChgdGllcjogJHtzZXJ2aWNlVGllcn1gKTtcbiAgICBpZiAoZmxhdFJhdGUpIHBhcnRzLnB1c2goYGZsYXQtcmF0ZTogJHtmbGF0UmF0ZX1gKTtcbiAgICBpZiAoZHluUm91dGluZz8uZW5hYmxlZCkgcGFydHMucHVzaChcInJvdXRpbmc6IG9uXCIpO1xuICAgIGlmIChwYXJ0cy5sZW5ndGggPiAwKSBtb2RlbHNTdW1tYXJ5ID0gcGFydHMuam9pbihcIiwgXCIpO1xuICB9XG5cbiAgLy8gVGltZW91dHNcbiAgY29uc3QgYXV0b1N1cCA9IHByZWZzLmF1dG9fc3VwZXJ2aXNvciBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZDtcbiAgbGV0IHRpbWVvdXRzU3VtbWFyeSA9IFwiKGRlZmF1bHRzKVwiO1xuICBpZiAoYXV0b1N1cCAmJiBPYmplY3Qua2V5cyhhdXRvU3VwKS5sZW5ndGggPiAwKSB7XG4gICAgY29uc3Qgc29mdCA9IGF1dG9TdXAuc29mdF90aW1lb3V0X21pbnV0ZXMgPz8gXCIyMFwiO1xuICAgIGNvbnN0IGlkbGUgPSBhdXRvU3VwLmlkbGVfdGltZW91dF9taW51dGVzID8/IFwiMTBcIjtcbiAgICBjb25zdCBoYXJkID0gYXV0b1N1cC5oYXJkX3RpbWVvdXRfbWludXRlcyA/PyBcIjMwXCI7XG4gICAgdGltZW91dHNTdW1tYXJ5ID0gYHNvZnQ6ICR7c29mdH1tLCBpZGxlOiAke2lkbGV9bSwgaGFyZDogJHtoYXJkfW1gO1xuICB9XG5cbiAgLy8gR2l0XG4gIGNvbnN0IGdpdCA9IHByZWZzLmdpdCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZDtcbiAgY29uc3Qgc3RhbGVUaHJlc2hvbGQgPSBwcmVmcy5zdGFsZV9jb21taXRfdGhyZXNob2xkX21pbnV0ZXM7XG4gIGNvbnN0IGFic29yYlNuYXBzaG90cyA9IGdpdD8uYWJzb3JiX3NuYXBzaG90X2NvbW1pdHM7XG4gIGxldCBnaXRTdW1tYXJ5ID0gXCIoZGVmYXVsdHMpXCI7XG4gIHtcbiAgICBjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcbiAgICBpZiAoZ2l0ICYmIE9iamVjdC5rZXlzKGdpdCkubGVuZ3RoID4gMCkge1xuICAgICAgY29uc3QgYnJhbmNoID0gZ2l0Lm1haW5fYnJhbmNoID8/IFwibWFpblwiO1xuICAgICAgY29uc3QgcHVzaCA9IGdpdC5hdXRvX3B1c2ggPyBcIm9uXCIgOiBcIm9mZlwiO1xuICAgICAgcGFydHMucHVzaChgbWFpbjogJHticmFuY2h9LCBwdXNoOiAke3B1c2h9YCk7XG4gICAgfVxuICAgIGlmIChzdGFsZVRocmVzaG9sZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBwYXJ0cy5wdXNoKGBzdGFsZTogJHtzdGFsZVRocmVzaG9sZCA9PT0gMCA/IFwib2ZmXCIgOiBgJHtzdGFsZVRocmVzaG9sZH1tYH1gKTtcbiAgICB9XG4gICAgaWYgKGFic29yYlNuYXBzaG90cyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBwYXJ0cy5wdXNoKGBhYnNvcmI6ICR7YWJzb3JiU25hcHNob3RzID8gXCJvblwiIDogXCJvZmZcIn1gKTtcbiAgICB9XG4gICAgaWYgKHBhcnRzLmxlbmd0aCA+IDApIGdpdFN1bW1hcnkgPSBwYXJ0cy5qb2luKFwiLCBcIik7XG4gIH1cblxuICAvLyBTa2lsbHNcbiAgY29uc3QgZGlzY292ZXJ5ID0gcHJlZnMuc2tpbGxfZGlzY292ZXJ5IGFzIHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgY29uc3QgdWF0ID0gcHJlZnMudWF0X2Rpc3BhdGNoO1xuICBjb25zdCBhbHdheXNVc2UgPSBBcnJheS5pc0FycmF5KHByZWZzLmFsd2F5c191c2Vfc2tpbGxzKSA/IChwcmVmcy5hbHdheXNfdXNlX3NraWxscyBhcyBzdHJpbmdbXSkubGVuZ3RoIDogMDtcbiAgY29uc3QgcHJlZmVyUyA9IEFycmF5LmlzQXJyYXkocHJlZnMucHJlZmVyX3NraWxscykgPyAocHJlZnMucHJlZmVyX3NraWxscyBhcyBzdHJpbmdbXSkubGVuZ3RoIDogMDtcbiAgY29uc3QgYXZvaWRTID0gQXJyYXkuaXNBcnJheShwcmVmcy5hdm9pZF9za2lsbHMpID8gKHByZWZzLmF2b2lkX3NraWxscyBhcyBzdHJpbmdbXSkubGVuZ3RoIDogMDtcbiAgY29uc3QgcnVsZXNDb3VudCA9IEFycmF5LmlzQXJyYXkocHJlZnMuc2tpbGxfcnVsZXMpID8gKHByZWZzLnNraWxsX3J1bGVzIGFzIHVua25vd25bXSkubGVuZ3RoIDogMDtcbiAgY29uc3QgY3VzdG9tSW5zdHIgPSBBcnJheS5pc0FycmF5KHByZWZzLmN1c3RvbV9pbnN0cnVjdGlvbnMpID8gKHByZWZzLmN1c3RvbV9pbnN0cnVjdGlvbnMgYXMgc3RyaW5nW10pLmxlbmd0aCA6IDA7XG4gIGxldCBza2lsbHNTdW1tYXJ5ID0gXCIobm90IGNvbmZpZ3VyZWQpXCI7XG4gIHtcbiAgICBjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcbiAgICBpZiAoZGlzY292ZXJ5KSBwYXJ0cy5wdXNoKGBkaXNjb3Zlcnk6ICR7ZGlzY292ZXJ5fWApO1xuICAgIGlmICh1YXQgIT09IHVuZGVmaW5lZCkgcGFydHMucHVzaChgdWF0OiAke3VhdH1gKTtcbiAgICBpZiAoYWx3YXlzVXNlKSBwYXJ0cy5wdXNoKGBhbHdheXM6ICR7YWx3YXlzVXNlfWApO1xuICAgIGlmIChwcmVmZXJTKSBwYXJ0cy5wdXNoKGBwcmVmZXI6ICR7cHJlZmVyU31gKTtcbiAgICBpZiAoYXZvaWRTKSBwYXJ0cy5wdXNoKGBhdm9pZDogJHthdm9pZFN9YCk7XG4gICAgaWYgKHJ1bGVzQ291bnQpIHBhcnRzLnB1c2goYHJ1bGVzOiAke3J1bGVzQ291bnR9YCk7XG4gICAgaWYgKGN1c3RvbUluc3RyKSBwYXJ0cy5wdXNoKGBjdXN0b206ICR7Y3VzdG9tSW5zdHJ9YCk7XG4gICAgaWYgKHByZWZzLnNraWxsX3N0YWxlbmVzc19kYXlzICE9PSB1bmRlZmluZWQpIHBhcnRzLnB1c2goYHN0YWxlOiAke3ByZWZzLnNraWxsX3N0YWxlbmVzc19kYXlzfWRgKTtcbiAgICBpZiAocGFydHMubGVuZ3RoID4gMCkgc2tpbGxzU3VtbWFyeSA9IHBhcnRzLmpvaW4oXCIsIFwiKTtcbiAgfVxuXG4gIC8vIEJ1ZGdldFxuICBjb25zdCBjZWlsaW5nID0gcHJlZnMuYnVkZ2V0X2NlaWxpbmc7XG4gIGNvbnN0IGVuZm9yY2VtZW50ID0gcHJlZnMuYnVkZ2V0X2VuZm9yY2VtZW50IGFzIHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgbGV0IGJ1ZGdldFN1bW1hcnkgPSBcIihubyBsaW1pdClcIjtcbiAgaWYgKGNlaWxpbmcgIT09IHVuZGVmaW5lZCkge1xuICAgIGJ1ZGdldFN1bW1hcnkgPSBgJCR7Y2VpbGluZ31gO1xuICAgIGlmIChlbmZvcmNlbWVudCkgYnVkZ2V0U3VtbWFyeSArPSBgIC8gJHtlbmZvcmNlbWVudH1gO1xuICB9IGVsc2UgaWYgKGVuZm9yY2VtZW50KSB7XG4gICAgYnVkZ2V0U3VtbWFyeSA9IGVuZm9yY2VtZW50O1xuICB9XG5cbiAgLy8gTm90aWZpY2F0aW9uc1xuICBjb25zdCBub3RpZiA9IHByZWZzLm5vdGlmaWNhdGlvbnMgYXMgUmVjb3JkPHN0cmluZywgYm9vbGVhbj4gfCB1bmRlZmluZWQ7XG4gIGxldCBub3RpZlN1bW1hcnkgPSBcIihkZWZhdWx0cylcIjtcbiAgaWYgKG5vdGlmICYmIE9iamVjdC5rZXlzKG5vdGlmKS5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgYWxsS2V5cyA9IFtcImVuYWJsZWRcIiwgXCJvbl9jb21wbGV0ZVwiLCBcIm9uX2Vycm9yXCIsIFwib25fYnVkZ2V0XCIsIFwib25fbWlsZXN0b25lXCIsIFwib25fYXR0ZW50aW9uXCJdO1xuICAgIGNvbnN0IGVuYWJsZWRDb3VudCA9IGFsbEtleXMuZmlsdGVyKGsgPT4gbm90aWZba10gIT09IGZhbHNlKS5sZW5ndGg7XG4gICAgbm90aWZTdW1tYXJ5ID0gYCR7ZW5hYmxlZENvdW50fS8ke2FsbEtleXMubGVuZ3RofSBlbmFibGVkYDtcbiAgfVxuXG4gIC8vIEFkdmFuY2VkXG4gIGNvbnN0IHVuaXF1ZUlkcyA9IHByZWZzLnVuaXF1ZV9taWxlc3RvbmVfaWRzO1xuICBjb25zdCBleHBlcmltZW50YWxSdGsgPSAocHJlZnMuZXhwZXJpbWVudGFsIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkKT8ucnRrO1xuICBsZXQgYWR2YW5jZWRTdW1tYXJ5ID0gXCIoZGVmYXVsdHMpXCI7XG4gIHtcbiAgICBjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcbiAgICBpZiAodW5pcXVlSWRzICE9PSB1bmRlZmluZWQpIHBhcnRzLnB1c2goYHVuaXF1ZTogJHt1bmlxdWVJZHMgPyBcIm9uXCIgOiBcIm9mZlwifWApO1xuICAgIGlmIChwcmVmcy5hdXRvX3Zpc3VhbGl6ZSAhPT0gdW5kZWZpbmVkKSBwYXJ0cy5wdXNoKGB2aXo6ICR7cHJlZnMuYXV0b192aXN1YWxpemUgPyBcIm9uXCIgOiBcIm9mZlwifWApO1xuICAgIGlmIChwcmVmcy5hdXRvX3JlcG9ydCAhPT0gdW5kZWZpbmVkKSBwYXJ0cy5wdXNoKGByZXBvcnQ6ICR7cHJlZnMuYXV0b19yZXBvcnQgPyBcIm9uXCIgOiBcIm9mZlwifWApO1xuICAgIGlmIChwcmVmcy5zaG93X3Rva2VuX2Nvc3QpIHBhcnRzLnB1c2goXCJjb3N0LWRpc3BsYXlcIik7XG4gICAgaWYgKHByZWZzLmZvcmVuc2ljc19kZWR1cCkgcGFydHMucHVzaChcImZvcmVuc2ljcy1kZWR1cFwiKTtcbiAgICBpZiAocHJlZnMud2lkZ2V0X21vZGUpIHBhcnRzLnB1c2goYHdpZGdldDogJHtwcmVmcy53aWRnZXRfbW9kZX1gKTtcbiAgICBpZiAoZXhwZXJpbWVudGFsUnRrKSBwYXJ0cy5wdXNoKFwicnRrXCIpO1xuICAgIGlmIChwYXJ0cy5sZW5ndGggPiAwKSBhZHZhbmNlZFN1bW1hcnkgPSBwYXJ0cy5qb2luKFwiLCBcIik7XG4gIH1cblxuICAvLyBQaGFzZXNcbiAgY29uc3QgcGhhc2VzID0gcHJlZnMucGhhc2VzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkO1xuICBsZXQgcGhhc2VzU3VtbWFyeSA9IFwiKGRlZmF1bHRzKVwiO1xuICBpZiAocGhhc2VzICYmIE9iamVjdC5rZXlzKHBoYXNlcykubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IGFjdGl2ZUZsYWdzID0gT2JqZWN0LmVudHJpZXMocGhhc2VzKS5maWx0ZXIoKFssIHZdKSA9PiB2ID09PSB0cnVlKS5tYXAoKFtrXSkgPT4gayk7XG4gICAgcGhhc2VzU3VtbWFyeSA9IGFjdGl2ZUZsYWdzLmxlbmd0aCA9PT0gMCA/IFwiKG5vIGZsYWdzKVwiIDogYCR7YWN0aXZlRmxhZ3MubGVuZ3RofSBmbGFnKHMpOiAke2FjdGl2ZUZsYWdzLnNsaWNlKDAsIDIpLmpvaW4oXCIsIFwiKX0ke2FjdGl2ZUZsYWdzLmxlbmd0aCA+IDIgPyBcIlx1MjAyNlwiIDogXCJcIn1gO1xuICB9XG5cbiAgLy8gUGFyYWxsZWxpc21cbiAgY29uc3QgcGFyYWxsZWwgPSBwcmVmcy5wYXJhbGxlbCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZDtcbiAgY29uc3Qgc2xpY2VQYXJhbGxlbCA9IHByZWZzLnNsaWNlX3BhcmFsbGVsIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkO1xuICBsZXQgcGFyYWxsZWxpc21TdW1tYXJ5ID0gXCIoZGVmYXVsdHMpXCI7XG4gIHtcbiAgICBjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcbiAgICBpZiAocGFyYWxsZWw/LmVuYWJsZWQpIHBhcnRzLnB1c2goYG1pbGVzdG9uZTogJHtwYXJhbGxlbC5tYXhfd29ya2VycyA/PyAyfXdgKTtcbiAgICBpZiAoc2xpY2VQYXJhbGxlbD8uZW5hYmxlZCkgcGFydHMucHVzaChgc2xpY2U6ICR7c2xpY2VQYXJhbGxlbC5tYXhfd29ya2VycyA/PyAyfXdgKTtcbiAgICBpZiAocGFydHMubGVuZ3RoID4gMCkgcGFyYWxsZWxpc21TdW1tYXJ5ID0gcGFydHMuam9pbihcIiwgXCIpO1xuICB9XG5cbiAgLy8gVmVyaWZpY2F0aW9uXG4gIGNvbnN0IHZlcmlmeUNtZHMgPSBBcnJheS5pc0FycmF5KHByZWZzLnZlcmlmaWNhdGlvbl9jb21tYW5kcykgPyAocHJlZnMudmVyaWZpY2F0aW9uX2NvbW1hbmRzIGFzIHN0cmluZ1tdKS5sZW5ndGggOiAwO1xuICBjb25zdCBzYWZldHkgPSBwcmVmcy5zYWZldHlfaGFybmVzcyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZDtcbiAgbGV0IHZlcmlmaWNhdGlvblN1bW1hcnkgPSBcIihkZWZhdWx0cylcIjtcbiAge1xuICAgIGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGlmICh2ZXJpZnlDbWRzKSBwYXJ0cy5wdXNoKGAke3ZlcmlmeUNtZHN9IGNtZChzKWApO1xuICAgIGlmIChwcmVmcy52ZXJpZmljYXRpb25fYXV0b19maXgpIHBhcnRzLnB1c2goXCJhdXRvLWZpeFwiKTtcbiAgICBpZiAocHJlZnMuZW5oYW5jZWRfdmVyaWZpY2F0aW9uID09PSBmYWxzZSkgcGFydHMucHVzaChcImVuaGFuY2VkOiBvZmZcIik7XG4gICAgaWYgKHByZWZzLmVuaGFuY2VkX3ZlcmlmaWNhdGlvbl9zdHJpY3QpIHBhcnRzLnB1c2goXCJzdHJpY3RcIik7XG4gICAgaWYgKHNhZmV0eT8uZW5hYmxlZCA9PT0gZmFsc2UpIHBhcnRzLnB1c2goXCJoYXJuZXNzOiBvZmZcIik7XG4gICAgZWxzZSBpZiAoc2FmZXR5ICYmIE9iamVjdC5rZXlzKHNhZmV0eSkubGVuZ3RoID4gMCkgcGFydHMucHVzaChcImhhcm5lc3M6IGN1c3RvbVwiKTtcbiAgICBpZiAocGFydHMubGVuZ3RoID4gMCkgdmVyaWZpY2F0aW9uU3VtbWFyeSA9IHBhcnRzLmpvaW4oXCIsIFwiKTtcbiAgfVxuXG4gIC8vIERpc2N1c3NcbiAgbGV0IGRpc2N1c3NTdW1tYXJ5ID0gXCIoZGVmYXVsdHMpXCI7XG4gIHtcbiAgICBjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcbiAgICBpZiAocHJlZnMuZGlzY3Vzc19wcmVwYXJhdGlvbiA9PT0gZmFsc2UpIHBhcnRzLnB1c2goXCJwcmVwOiBvZmZcIik7XG4gICAgaWYgKHByZWZzLmRpc2N1c3Nfd2ViX3Jlc2VhcmNoID09PSBmYWxzZSkgcGFydHMucHVzaChcIndlYjogb2ZmXCIpO1xuICAgIGlmIChwcmVmcy5kaXNjdXNzX2RlcHRoKSBwYXJ0cy5wdXNoKGBkZXB0aDogJHtwcmVmcy5kaXNjdXNzX2RlcHRofWApO1xuICAgIGlmIChwYXJ0cy5sZW5ndGggPiAwKSBkaXNjdXNzU3VtbWFyeSA9IHBhcnRzLmpvaW4oXCIsIFwiKTtcbiAgfVxuXG4gIC8vIENvbnRleHQgJiBDb2RlYmFzZVxuICBjb25zdCBjdHhNZ210ID0gcHJlZnMuY29udGV4dF9tYW5hZ2VtZW50IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkO1xuICBjb25zdCBjb2RlYmFzZSA9IHByZWZzLmNvZGViYXNlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkO1xuICBsZXQgY29udGV4dFN1bW1hcnkgPSBcIihkZWZhdWx0cylcIjtcbiAge1xuICAgIGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGlmIChwcmVmcy5jb250ZXh0X3NlbGVjdGlvbikgcGFydHMucHVzaChgc2VsZWN0aW9uOiAke3ByZWZzLmNvbnRleHRfc2VsZWN0aW9ufWApO1xuICAgIGlmIChjdHhNZ210ICYmIE9iamVjdC5rZXlzKGN0eE1nbXQpLmxlbmd0aCA+IDApIHBhcnRzLnB1c2goYG1nbXQ6ICR7T2JqZWN0LmtleXMoY3R4TWdtdCkubGVuZ3RofSBmaWVsZChzKWApO1xuICAgIGlmIChwcmVmcy5jb250ZXh0X3dpbmRvd19vdmVycmlkZSAhPT0gdW5kZWZpbmVkKSBwYXJ0cy5wdXNoKGBvdmVycmlkZTogJHtwcmVmcy5jb250ZXh0X3dpbmRvd19vdmVycmlkZX1gKTtcbiAgICBpZiAoY29kZWJhc2UgJiYgT2JqZWN0LmtleXMoY29kZWJhc2UpLmxlbmd0aCA+IDApIHBhcnRzLnB1c2goXCJjb2RlYmFzZTogY3VzdG9tXCIpO1xuICAgIGlmIChwYXJ0cy5sZW5ndGggPiAwKSBjb250ZXh0U3VtbWFyeSA9IHBhcnRzLmpvaW4oXCIsIFwiKTtcbiAgfVxuXG4gIC8vIEhvb2tzICYgUmVhY3RpdmVcbiAgY29uc3QgcmVhY3RpdmUgPSBwcmVmcy5yZWFjdGl2ZV9leGVjdXRpb24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQ7XG4gIGNvbnN0IGdhdGVFdmFsID0gcHJlZnMuZ2F0ZV9ldmFsdWF0aW9uIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkO1xuICBjb25zdCBwb3N0SG9va3MgPSBBcnJheS5pc0FycmF5KHByZWZzLnBvc3RfdW5pdF9ob29rcykgPyAocHJlZnMucG9zdF91bml0X2hvb2tzIGFzIHVua25vd25bXSkubGVuZ3RoIDogMDtcbiAgY29uc3QgcHJlSG9va3MgPSBBcnJheS5pc0FycmF5KHByZWZzLnByZV9kaXNwYXRjaF9ob29rcykgPyAocHJlZnMucHJlX2Rpc3BhdGNoX2hvb2tzIGFzIHVua25vd25bXSkubGVuZ3RoIDogMDtcbiAgbGV0IGhvb2tzU3VtbWFyeSA9IFwiKGRlZmF1bHRzKVwiO1xuICB7XG4gICAgY29uc3QgcGFydHM6IHN0cmluZ1tdID0gW107XG4gICAgaWYgKHBvc3RIb29rcykgcGFydHMucHVzaChgcG9zdDogJHtwb3N0SG9va3N9YCk7XG4gICAgaWYgKHByZUhvb2tzKSBwYXJ0cy5wdXNoKGBwcmU6ICR7cHJlSG9va3N9YCk7XG4gICAgaWYgKHJlYWN0aXZlPy5lbmFibGVkKSBwYXJ0cy5wdXNoKFwicmVhY3RpdmU6IG9uXCIpO1xuICAgIGlmIChnYXRlRXZhbD8uZW5hYmxlZCkgcGFydHMucHVzaChcImdhdGUtZXZhbDogb25cIik7XG4gICAgaWYgKHBhcnRzLmxlbmd0aCA+IDApIGhvb2tzU3VtbWFyeSA9IHBhcnRzLmpvaW4oXCIsIFwiKTtcbiAgfVxuXG4gIC8vIFVvS1xuICBjb25zdCB1b2sgPSBwcmVmcy51b2sgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQ7XG4gIGxldCB1b2tTdW1tYXJ5ID0gXCIoZGVmYXVsdHMpXCI7XG4gIGlmICh1b2sgJiYgT2JqZWN0LmtleXModW9rKS5sZW5ndGggPiAwKSB7XG4gICAgaWYgKHVvay5lbmFibGVkID09PSBmYWxzZSkgdW9rU3VtbWFyeSA9IFwib2ZmXCI7XG4gICAgZWxzZSB1b2tTdW1tYXJ5ID0gYCR7T2JqZWN0LmtleXModW9rKS5sZW5ndGh9IHNldHRpbmcocylgO1xuICB9XG5cbiAgLy8gSW50ZWdyYXRpb25zXG4gIGNvbnN0IGNtdXggPSBwcmVmcy5jbXV4IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkO1xuICBjb25zdCByZW1vdGUgPSBwcmVmcy5yZW1vdGVfcXVlc3Rpb25zIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkO1xuICBjb25zdCBnaXRodWIgPSBwcmVmcy5naXRodWIgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQ7XG4gIGxldCBpbnRlZ3JhdGlvbnNTdW1tYXJ5ID0gXCIoZGVmYXVsdHMpXCI7XG4gIHtcbiAgICBjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcbiAgICBpZiAocHJlZnMubGFuZ3VhZ2UpIHBhcnRzLnB1c2goYGxhbmc6ICR7cHJlZnMubGFuZ3VhZ2V9YCk7XG4gICAgaWYgKHByZWZzLnNlYXJjaF9wcm92aWRlcikgcGFydHMucHVzaChgc2VhcmNoOiAke3ByZWZzLnNlYXJjaF9wcm92aWRlcn1gKTtcbiAgICBpZiAoY211eD8uZW5hYmxlZCkgcGFydHMucHVzaChcImNtdXhcIik7XG4gICAgaWYgKHJlbW90ZT8uY2hhbm5lbCkgcGFydHMucHVzaChgcmVtb3RlOiAke3JlbW90ZS5jaGFubmVsfWApO1xuICAgIGlmIChnaXRodWI/LmVuYWJsZWQpIHBhcnRzLnB1c2goXCJnaXRodWJcIik7XG4gICAgaWYgKHBhcnRzLmxlbmd0aCA+IDApIGludGVncmF0aW9uc1N1bW1hcnkgPSBwYXJ0cy5qb2luKFwiLCBcIik7XG4gIH1cblxuICByZXR1cm4ge1xuICAgIG1vZGU6IG1vZGVTdW1tYXJ5LFxuICAgIG1vZGVsczogbW9kZWxzU3VtbWFyeSxcbiAgICB0aW1lb3V0czogdGltZW91dHNTdW1tYXJ5LFxuICAgIGdpdDogZ2l0U3VtbWFyeSxcbiAgICBza2lsbHM6IHNraWxsc1N1bW1hcnksXG4gICAgYnVkZ2V0OiBidWRnZXRTdW1tYXJ5LFxuICAgIG5vdGlmaWNhdGlvbnM6IG5vdGlmU3VtbWFyeSxcbiAgICBhZHZhbmNlZDogYWR2YW5jZWRTdW1tYXJ5LFxuICAgIHBoYXNlczogcGhhc2VzU3VtbWFyeSxcbiAgICBwYXJhbGxlbGlzbTogcGFyYWxsZWxpc21TdW1tYXJ5LFxuICAgIHZlcmlmaWNhdGlvbjogdmVyaWZpY2F0aW9uU3VtbWFyeSxcbiAgICBkaXNjdXNzOiBkaXNjdXNzU3VtbWFyeSxcbiAgICBjb250ZXh0OiBjb250ZXh0U3VtbWFyeSxcbiAgICBob29rczogaG9va3NTdW1tYXJ5LFxuICAgIHVvazogdW9rU3VtbWFyeSxcbiAgICBpbnRlZ3JhdGlvbnM6IGludGVncmF0aW9uc1N1bW1hcnksXG4gIH07XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBDYXRlZ29yeSBjb25maWd1cmF0aW9uIGZ1bmN0aW9ucyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdENvbmZpZ3VyZWRNb2RlbChjb25maWc6IHVua25vd24pOiBzdHJpbmcge1xuICBpZiAodHlwZW9mIGNvbmZpZyA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIGNvbmZpZztcbiAgaWYgKCFjb25maWcgfHwgdHlwZW9mIGNvbmZpZyAhPT0gXCJvYmplY3RcIikgcmV0dXJuIFwiKGludmFsaWQpXCI7XG4gIGNvbnN0IG1heWJlQ29uZmlnID0gY29uZmlnIGFzIHsgbW9kZWw/OiB1bmtub3duOyBwcm92aWRlcj86IHVua25vd24gfTtcbiAgaWYgKHR5cGVvZiBtYXliZUNvbmZpZy5tb2RlbCAhPT0gXCJzdHJpbmdcIiB8fCBtYXliZUNvbmZpZy5tb2RlbC50cmltKCkgPT09IFwiXCIpIHJldHVybiBcIihpbnZhbGlkKVwiO1xuICBpZiAodHlwZW9mIG1heWJlQ29uZmlnLnByb3ZpZGVyID09PSBcInN0cmluZ1wiICYmIG1heWJlQ29uZmlnLnByb3ZpZGVyICYmICFtYXliZUNvbmZpZy5tb2RlbC5pbmNsdWRlcyhcIi9cIikpIHtcbiAgICByZXR1cm4gYCR7bWF5YmVDb25maWcucHJvdmlkZXJ9LyR7bWF5YmVDb25maWcubW9kZWx9YDtcbiAgfVxuICByZXR1cm4gbWF5YmVDb25maWcubW9kZWw7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB0b1BlcnNpc3RlZE1vZGVsSWQocHJvdmlkZXI6IHN0cmluZywgbW9kZWxJZDogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKCFwcm92aWRlci50cmltKCkpIHJldHVybiBtb2RlbElkO1xuICBjb25zdCBub3JtYWxpemVkUHJvdmlkZXIgPSBwcm92aWRlci50cmltKCk7XG4gIGNvbnN0IG5vcm1hbGl6ZWRNb2RlbElkID0gbW9kZWxJZC50cmltKCk7XG4gIHJldHVybiBub3JtYWxpemVkTW9kZWxJZC5zdGFydHNXaXRoKGAke25vcm1hbGl6ZWRQcm92aWRlcn0vYClcbiAgICA/IG5vcm1hbGl6ZWRNb2RlbElkXG4gICAgOiBgJHtub3JtYWxpemVkUHJvdmlkZXJ9LyR7bm9ybWFsaXplZE1vZGVsSWR9YDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY29uZmlndXJlTW9kZWxzKGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsIHByZWZzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBtb2RlbFBoYXNlcyA9IFtcbiAgICBcInJlc2VhcmNoXCIsXG4gICAgXCJwbGFubmluZ1wiLFxuICAgIFwiZGlzY3Vzc1wiLFxuICAgIFwiZXhlY3V0aW9uXCIsXG4gICAgXCJleGVjdXRpb25fc2ltcGxlXCIsXG4gICAgXCJjb21wbGV0aW9uXCIsXG4gICAgXCJ2YWxpZGF0aW9uXCIsXG4gICAgXCJzdWJhZ2VudFwiLFxuICBdIGFzIGNvbnN0O1xuICBjb25zdCBtb2RlbHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0gKHByZWZzLm1vZGVscyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPz8ge307XG5cbiAgY29uc3QgYXZhaWxhYmxlTW9kZWxzID0gY3R4Lm1vZGVsUmVnaXN0cnkuZ2V0QXZhaWxhYmxlKCk7XG4gIGlmIChhdmFpbGFibGVNb2RlbHMubGVuZ3RoID4gMCkge1xuICAgIC8vIEdyb3VwIG1vZGVscyBieSBwcm92aWRlciwgc29ydGVkIGFscGhhYmV0aWNhbGx5XG4gICAgY29uc3QgYnlQcm92aWRlciA9IG5ldyBNYXA8c3RyaW5nLCB0eXBlb2YgYXZhaWxhYmxlTW9kZWxzPigpO1xuICAgIGZvciAoY29uc3QgbSBvZiBhdmFpbGFibGVNb2RlbHMpIHtcbiAgICAgIGxldCBncm91cCA9IGJ5UHJvdmlkZXIuZ2V0KG0ucHJvdmlkZXIpO1xuICAgICAgaWYgKCFncm91cCkge1xuICAgICAgICBncm91cCA9IFtdO1xuICAgICAgICBieVByb3ZpZGVyLnNldChtLnByb3ZpZGVyLCBncm91cCk7XG4gICAgICB9XG4gICAgICBncm91cC5wdXNoKG0pO1xuICAgIH1cbiAgICBjb25zdCBwcm92aWRlcnMgPSBBcnJheS5mcm9tKGJ5UHJvdmlkZXIua2V5cygpKS5zb3J0KChhLCBiKSA9PiBhLmxvY2FsZUNvbXBhcmUoYikpO1xuICAgIC8vIFNvcnQgbW9kZWxzIHdpdGhpbiBlYWNoIHByb3ZpZGVyXG4gICAgZm9yIChjb25zdCBncm91cCBvZiBieVByb3ZpZGVyLnZhbHVlcygpKSB7XG4gICAgICBncm91cC5zb3J0KChhLCBiKSA9PiBhLmlkLmxvY2FsZUNvbXBhcmUoYi5pZCkpO1xuICAgIH1cblxuICAgIC8vIERpc3BsYXkgbmFtZXMgZm9yIHByb3ZpZGVycyBpbiB0aGUgcHJlZmVyZW5jZXMgd2l6YXJkIFVJLlxuICAgIGNvbnN0IFBST1ZJREVSX0RJU1BMQVlfTkFNRVM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7IGFudGhyb3BpYzogXCJhbnRocm9waWMtYXBpXCIgfTtcbiAgICBjb25zdCBkaXNwbGF5TmFtZSA9IChwOiBzdHJpbmcpID0+IFBST1ZJREVSX0RJU1BMQVlfTkFNRVNbcF0gPz8gcDtcblxuICAgIC8vIEJ1aWxkIHByb3ZpZGVyIG1lbnUgd2l0aCBtb2RlbCBjb3VudHMgKGRpc3BsYXkgbmFtZSBcdTIxOTIgcmVhbCBuYW1lIGxvb2t1cClcbiAgICBjb25zdCBkaXNwbGF5VG9SZWFsID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcbiAgICBjb25zdCBwcm92aWRlck9wdGlvbnMgPSBwcm92aWRlcnMubWFwKHAgPT4ge1xuICAgICAgY29uc3QgY291bnQgPSBieVByb3ZpZGVyLmdldChwKSEubGVuZ3RoO1xuICAgICAgY29uc3QgbGFiZWwgPSBgJHtkaXNwbGF5TmFtZShwKX0gKCR7Y291bnR9IG1vZGVscylgO1xuICAgICAgZGlzcGxheVRvUmVhbC5zZXQobGFiZWwsIHApO1xuICAgICAgcmV0dXJuIGxhYmVsO1xuICAgIH0pO1xuICAgIHByb3ZpZGVyT3B0aW9ucy5wdXNoKFwiKGtlZXAgY3VycmVudClcIiwgXCIoY2xlYXIpXCIsIFwiKHR5cGUgbWFudWFsbHkpXCIpO1xuXG4gICAgZm9yIChjb25zdCBwaGFzZSBvZiBtb2RlbFBoYXNlcykge1xuICAgICAgY29uc3QgY3VycmVudCA9IGZvcm1hdENvbmZpZ3VyZWRNb2RlbChtb2RlbHNbcGhhc2VdKTtcbiAgICAgIGNvbnN0IHBoYXNlTGFiZWwgPSBgTW9kZWwgZm9yICR7cGhhc2V9IHBoYXNlJHtjdXJyZW50ID8gYCAoY3VycmVudDogJHtjdXJyZW50fSlgIDogXCJcIn1gO1xuXG4gICAgICAvLyBTdGVwIDE6IHBpY2sgcHJvdmlkZXJcbiAgICAgIGNvbnN0IHByb3ZpZGVyQ2hvaWNlID0gYXdhaXQgY3R4LnVpLnNlbGVjdChgJHtwaGFzZUxhYmVsfSBcdTIwMTQgY2hvb3NlIHByb3ZpZGVyOmAsIHByb3ZpZGVyT3B0aW9ucyk7XG4gICAgICBpZiAoIXByb3ZpZGVyQ2hvaWNlIHx8IHR5cGVvZiBwcm92aWRlckNob2ljZSAhPT0gXCJzdHJpbmdcIiB8fCBwcm92aWRlckNob2ljZSA9PT0gXCIoa2VlcCBjdXJyZW50KVwiKSBjb250aW51ZTtcblxuICAgICAgaWYgKHByb3ZpZGVyQ2hvaWNlID09PSBcIihjbGVhcilcIikge1xuICAgICAgICBkZWxldGUgbW9kZWxzW3BoYXNlXTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIGlmIChwcm92aWRlckNob2ljZSA9PT0gXCIodHlwZSBtYW51YWxseSlcIikge1xuICAgICAgICBjb25zdCBpbnB1dCA9IGF3YWl0IGN0eC51aS5pbnB1dChcbiAgICAgICAgICBgJHtwaGFzZUxhYmVsfSBcdTIwMTQgZW50ZXIgbW9kZWwgSUQ6YCxcbiAgICAgICAgICBjdXJyZW50IHx8IFwiZS5nLiBjbGF1ZGUtc29ubmV0LTQtMjAyNTA1MTRcIixcbiAgICAgICAgKTtcbiAgICAgICAgaWYgKGlucHV0ICE9PSBudWxsICYmIGlucHV0ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICBjb25zdCB2YWwgPSBpbnB1dC50cmltKCk7XG4gICAgICAgICAgaWYgKHZhbCkgbW9kZWxzW3BoYXNlXSA9IHZhbDtcbiAgICAgICAgfVxuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgLy8gU3RlcCAyOiBwaWNrIG1vZGVsIHdpdGhpbiBwcm92aWRlclxuICAgICAgY29uc3QgcHJvdmlkZXJOYW1lID0gZGlzcGxheVRvUmVhbC5nZXQocHJvdmlkZXJDaG9pY2UpID8/IHByb3ZpZGVyQ2hvaWNlLnJlcGxhY2UoLyBcXChcXGQrIG1vZGVscz9cXCkkLywgXCJcIik7XG4gICAgICBjb25zdCBncm91cCA9IGJ5UHJvdmlkZXIuZ2V0KHByb3ZpZGVyTmFtZSk7XG4gICAgICBpZiAoIWdyb3VwKSBjb250aW51ZTtcblxuICAgICAgY29uc3QgbW9kZWxPcHRpb25zID0gZ3JvdXAubWFwKG0gPT4gbS5pZCk7XG4gICAgICBtb2RlbE9wdGlvbnMucHVzaChcIihrZWVwIGN1cnJlbnQpXCIsIFwiKGNsZWFyKVwiKTtcblxuICAgICAgY29uc3QgbW9kZWxDaG9pY2UgPSBhd2FpdCBjdHgudWkuc2VsZWN0KGAke3BoYXNlTGFiZWx9IFx1MjAxNCAke2Rpc3BsYXlOYW1lKHByb3ZpZGVyTmFtZSl9OmAsIG1vZGVsT3B0aW9ucyk7XG4gICAgICBpZiAobW9kZWxDaG9pY2UgJiYgdHlwZW9mIG1vZGVsQ2hvaWNlID09PSBcInN0cmluZ1wiICYmIG1vZGVsQ2hvaWNlICE9PSBcIihrZWVwIGN1cnJlbnQpXCIpIHtcbiAgICAgICAgaWYgKG1vZGVsQ2hvaWNlID09PSBcIihjbGVhcilcIikge1xuICAgICAgICAgIGRlbGV0ZSBtb2RlbHNbcGhhc2VdO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIG1vZGVsc1twaGFzZV0gPSB0b1BlcnNpc3RlZE1vZGVsSWQocHJvdmlkZXJOYW1lLCBtb2RlbENob2ljZSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgZm9yIChjb25zdCBwaGFzZSBvZiBtb2RlbFBoYXNlcykge1xuICAgICAgY29uc3QgY3VycmVudCA9IGZvcm1hdENvbmZpZ3VyZWRNb2RlbChtb2RlbHNbcGhhc2VdKTtcbiAgICAgIGNvbnN0IGlucHV0ID0gYXdhaXQgY3R4LnVpLmlucHV0KFxuICAgICAgICBgTW9kZWwgZm9yICR7cGhhc2V9IHBoYXNlJHtjdXJyZW50ID8gYCAoY3VycmVudDogJHtjdXJyZW50fSlgIDogXCJcIn06YCxcbiAgICAgICAgY3VycmVudCB8fCBcImUuZy4gY2xhdWRlLXNvbm5ldC00LTIwMjUwNTE0XCIsXG4gICAgICApO1xuICAgICAgaWYgKGlucHV0ICE9PSBudWxsICYmIGlucHV0ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgY29uc3QgdmFsID0gaW5wdXQudHJpbSgpO1xuICAgICAgICBpZiAodmFsKSB7XG4gICAgICAgICAgbW9kZWxzW3BoYXNlXSA9IHZhbDtcbiAgICAgICAgfSBlbHNlIGlmIChjdXJyZW50KSB7XG4gICAgICAgICAgZGVsZXRlIG1vZGVsc1twaGFzZV07XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgaWYgKE9iamVjdC5rZXlzKG1vZGVscykubGVuZ3RoID4gMCkge1xuICAgIHByZWZzLm1vZGVscyA9IG1vZGVscztcbiAgfSBlbHNlIHtcbiAgICBkZWxldGUgcHJlZnMubW9kZWxzO1xuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEV4dHJhIHJvdXRpbmctbGV2ZWwgbW9kZWwgcHJlZmVyZW5jZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGNvbnN0IHRva2VuUHJvZmlsZSA9IGF3YWl0IHByb21wdEVudW0oXG4gICAgY3R4LFxuICAgIFwiVG9rZW4gcHJvZmlsZSAoY29zdC9xdWFsaXR5IHRyYWRlb2ZmKVwiLFxuICAgIHByZWZzLnRva2VuX3Byb2ZpbGUsXG4gICAgW1wiYnVkZ2V0XCIsIFwiYmFsYW5jZWRcIiwgXCJxdWFsaXR5XCIsIFwiYnVybi1tYXhcIl0sXG4gICk7XG4gIGlmICh0b2tlblByb2ZpbGUgIT09IHVuZGVmaW5lZCkgcHJlZnMudG9rZW5fcHJvZmlsZSA9IHRva2VuUHJvZmlsZTtcblxuICBjb25zdCBzZXJ2aWNlVGllciA9IGF3YWl0IHByb21wdEVudW0oXG4gICAgY3R4LFxuICAgIFwiT3BlbkFJIHNlcnZpY2UgdGllciAoZ3B0LTUuNCBvbmx5KVwiLFxuICAgIHByZWZzLnNlcnZpY2VfdGllcixcbiAgICBbXCJwcmlvcml0eVwiLCBcImZsZXhcIl0sXG4gICk7XG4gIGlmIChzZXJ2aWNlVGllciAhPT0gdW5kZWZpbmVkKSBwcmVmcy5zZXJ2aWNlX3RpZXIgPSBzZXJ2aWNlVGllcjtcblxuICBhd2FpdCBlZGl0U3RyaW5nTGlzdEZpZWxkKGN0eCwgcHJlZnMsIFwiZmxhdF9yYXRlX3Byb3ZpZGVyc1wiLCBcIkZsYXQtcmF0ZSBwcm92aWRlcnMgKHN1cHByZXNzIGR5bmFtaWMgcm91dGluZylcIik7XG5cbiAgYXdhaXQgY29uZmlndXJlRHluYW1pY1JvdXRpbmcoY3R4LCBwcmVmcyk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNvbmZpZ3VyZUR5bmFtaWNSb3V0aW5nKGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsIHByZWZzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBkciA9IChwcmVmcy5keW5hbWljX3JvdXRpbmcgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQpID8/IHt9O1xuXG4gIGNvbnN0IGVuYWJsZWQgPSBhd2FpdCBwcm9tcHRCb29sZWFuKGN0eCwgXCJFbmFibGUgZHluYW1pYyByb3V0aW5nICh0aWVyLWJhc2VkIG1vZGVsIHNlbGVjdGlvbilcIiwgZHIuZW5hYmxlZCk7XG4gIGlmIChlbmFibGVkICE9PSB1bmRlZmluZWQpIGRyLmVuYWJsZWQgPSBlbmFibGVkO1xuXG4gIGlmIChkci5lbmFibGVkICE9PSB0cnVlKSB7XG4gICAgLy8gSWYgcm91dGluZyBpcyBkaXNhYmxlZCAvIGtlcHQtb2ZmLCBzdGlsbCBsZXQgdGhlIHVzZXIgY29uZmlndXJlIHN1Yi1maWVsZHMgKHRoZXkgbWF5IGVuYWJsZSBsYXRlcikuXG4gIH1cblxuICBjb25zdCBjYXAgPSBhd2FpdCBwcm9tcHRCb29sZWFuKGN0eCwgXCJDYXBhYmlsaXR5LWF3YXJlIHJvdXRpbmdcIiwgZHIuY2FwYWJpbGl0eV9yb3V0aW5nLCBmYWxzZSk7XG4gIGlmIChjYXAgIT09IHVuZGVmaW5lZCkgZHIuY2FwYWJpbGl0eV9yb3V0aW5nID0gY2FwO1xuXG4gIGNvbnN0IGVzY2FsYXRlID0gYXdhaXQgcHJvbXB0Qm9vbGVhbihjdHgsIFwiRXNjYWxhdGUgdG8gaGVhdmllciB0aWVyIG9uIGZhaWx1cmVcIiwgZHIuZXNjYWxhdGVfb25fZmFpbHVyZSwgdHJ1ZSk7XG4gIGlmIChlc2NhbGF0ZSAhPT0gdW5kZWZpbmVkKSBkci5lc2NhbGF0ZV9vbl9mYWlsdXJlID0gZXNjYWxhdGU7XG5cbiAgY29uc3QgcHJlc3N1cmUgPSBhd2FpdCBwcm9tcHRCb29sZWFuKGN0eCwgXCJEb3duZ3JhZGUgdW5kZXIgYnVkZ2V0IHByZXNzdXJlXCIsIGRyLmJ1ZGdldF9wcmVzc3VyZSwgdHJ1ZSk7XG4gIGlmIChwcmVzc3VyZSAhPT0gdW5kZWZpbmVkKSBkci5idWRnZXRfcHJlc3N1cmUgPSBwcmVzc3VyZTtcblxuICBjb25zdCBjcm9zcyA9IGF3YWl0IHByb21wdEJvb2xlYW4oY3R4LCBcIkNyb3NzLXByb3ZpZGVyIHJvdXRpbmdcIiwgZHIuY3Jvc3NfcHJvdmlkZXIsIHRydWUpO1xuICBpZiAoY3Jvc3MgIT09IHVuZGVmaW5lZCkgZHIuY3Jvc3NfcHJvdmlkZXIgPSBjcm9zcztcblxuICBjb25zdCBob29rcyA9IGF3YWl0IHByb21wdEJvb2xlYW4oY3R4LCBcIlJvdXRlIGhvb2sgc2Vzc2lvbnMgZHluYW1pY2FsbHlcIiwgZHIuaG9va3MsIHRydWUpO1xuICBpZiAoaG9va3MgIT09IHVuZGVmaW5lZCkgZHIuaG9va3MgPSBob29rcztcblxuICBjb25zdCBmbGF0UmF0ZSA9IGF3YWl0IHByb21wdEJvb2xlYW4oY3R4LCBcIkFsbG93IGR5bmFtaWMgcm91dGluZyBmb3IgZmxhdC1yYXRlIHByb3ZpZGVyc1wiLCBkci5hbGxvd19mbGF0X3JhdGVfcHJvdmlkZXJzLCBmYWxzZSk7XG4gIGlmIChmbGF0UmF0ZSAhPT0gdW5kZWZpbmVkKSBkci5hbGxvd19mbGF0X3JhdGVfcHJvdmlkZXJzID0gZmxhdFJhdGU7XG5cbiAgLy8gdGllcl9tb2RlbHMubGlnaHQgLyBzdGFuZGFyZCAvIGhlYXZ5IFx1MjAxNCBvcHRpb25hbCBtb2RlbCBJRHNcbiAgY29uc3QgdGllck1vZGVscyA9IChkci50aWVyX21vZGVscyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZCkgPz8ge307XG4gIGZvciAoY29uc3QgdGllciBvZiBbXCJsaWdodFwiLCBcInN0YW5kYXJkXCIsIFwiaGVhdnlcIl0gYXMgY29uc3QpIHtcbiAgICBjb25zdCBjdXJyZW50ID0gdHlwZW9mIHRpZXJNb2RlbHNbdGllcl0gPT09IFwic3RyaW5nXCIgPyB0aWVyTW9kZWxzW3RpZXJdIGFzIHN0cmluZyA6IFwiXCI7XG4gICAgY29uc3QgaW5wdXQgPSBhd2FpdCBwcm9tcHRTdHJpbmcoY3R4LCBgTW9kZWwgZm9yICR7dGllcn0gdGllciAoZS5nLiBjbGF1ZGUtaGFpa3UtNC01KWAsIGN1cnJlbnQpO1xuICAgIGlmIChpbnB1dCA9PT0gdW5kZWZpbmVkKSBjb250aW51ZTtcbiAgICBpZiAoaW5wdXQpIHRpZXJNb2RlbHNbdGllcl0gPSBpbnB1dDtcbiAgICBlbHNlIGlmIChjdXJyZW50KSBkZWxldGUgdGllck1vZGVsc1t0aWVyXTtcbiAgfVxuICBpZiAoT2JqZWN0LmtleXModGllck1vZGVscykubGVuZ3RoID4gMCkgZHIudGllcl9tb2RlbHMgPSB0aWVyTW9kZWxzO1xuICBlbHNlIGRlbGV0ZSAoZHIgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pLnRpZXJfbW9kZWxzO1xuXG4gIGlmIChPYmplY3Qua2V5cyhkcikubGVuZ3RoID4gMCkgcHJlZnMuZHluYW1pY19yb3V0aW5nID0gZHI7XG4gIGVsc2UgaWYgKHByZWZzLmR5bmFtaWNfcm91dGluZyAhPT0gdW5kZWZpbmVkKSBkZWxldGUgcHJlZnMuZHluYW1pY19yb3V0aW5nO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjb25maWd1cmVUaW1lb3V0cyhjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LCBwcmVmczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgYXV0b1N1cDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSAocHJlZnMuYXV0b19zdXBlcnZpc29yIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA/PyB7fTtcbiAgY29uc3QgdGltZW91dEZpZWxkcyA9IFtcbiAgICB7IGtleTogXCJzb2Z0X3RpbWVvdXRfbWludXRlc1wiLCBsYWJlbDogXCJTb2Z0IHRpbWVvdXQgKG1pbnV0ZXMpXCIsIGRlZmF1bHRWYWw6IFwiMjBcIiB9LFxuICAgIHsga2V5OiBcImlkbGVfdGltZW91dF9taW51dGVzXCIsIGxhYmVsOiBcIklkbGUgdGltZW91dCAobWludXRlcylcIiwgZGVmYXVsdFZhbDogXCIxMFwiIH0sXG4gICAgeyBrZXk6IFwiaGFyZF90aW1lb3V0X21pbnV0ZXNcIiwgbGFiZWw6IFwiSGFyZCB0aW1lb3V0IChtaW51dGVzKVwiLCBkZWZhdWx0VmFsOiBcIjMwXCIgfSxcbiAgXSBhcyBjb25zdDtcblxuICBmb3IgKGNvbnN0IGZpZWxkIG9mIHRpbWVvdXRGaWVsZHMpIHtcbiAgICBjb25zdCBjdXJyZW50ID0gYXV0b1N1cFtmaWVsZC5rZXldO1xuICAgIGNvbnN0IGN1cnJlbnRTdHIgPSBjdXJyZW50ICE9PSB1bmRlZmluZWQgJiYgY3VycmVudCAhPT0gbnVsbCA/IFN0cmluZyhjdXJyZW50KSA6IFwiXCI7XG4gICAgY29uc3QgaW5wdXQgPSBhd2FpdCBjdHgudWkuaW5wdXQoXG4gICAgICBgJHtmaWVsZC5sYWJlbH0ke2N1cnJlbnRTdHIgPyBgIChjdXJyZW50OiAke2N1cnJlbnRTdHJ9KWAgOiBgIChkZWZhdWx0OiAke2ZpZWxkLmRlZmF1bHRWYWx9KWB9OmAsXG4gICAgICBjdXJyZW50U3RyIHx8IGZpZWxkLmRlZmF1bHRWYWwsXG4gICAgKTtcbiAgICBpZiAoaW5wdXQgIT09IG51bGwgJiYgaW5wdXQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uc3QgdmFsID0gaW5wdXQudHJpbSgpO1xuICAgICAgY29uc3QgcGFyc2VkID0gdHJ5UGFyc2VJbnRlZ2VyKHZhbCk7XG4gICAgICBpZiAodmFsICYmIHBhcnNlZCAhPT0gbnVsbCkge1xuICAgICAgICBhdXRvU3VwW2ZpZWxkLmtleV0gPSBwYXJzZWQ7XG4gICAgICB9IGVsc2UgaWYgKHZhbCkge1xuICAgICAgICBjdHgudWkubm90aWZ5KGBJbnZhbGlkIHZhbHVlIFwiJHt2YWx9XCIgZm9yICR7ZmllbGQubGFiZWx9IFx1MjAxNCBtdXN0IGJlIGEgd2hvbGUgbnVtYmVyLiBLZWVwaW5nIHByZXZpb3VzIHZhbHVlLmAsIFwid2FybmluZ1wiKTtcbiAgICAgIH0gZWxzZSBpZiAoIXZhbCAmJiBjdXJyZW50U3RyKSB7XG4gICAgICAgIGRlbGV0ZSBhdXRvU3VwW2ZpZWxkLmtleV07XG4gICAgICB9XG4gICAgfVxuICB9XG4gIGlmIChPYmplY3Qua2V5cyhhdXRvU3VwKS5sZW5ndGggPiAwKSB7XG4gICAgcHJlZnMuYXV0b19zdXBlcnZpc29yID0gYXV0b1N1cDtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBjb25maWd1cmVHaXQoY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCwgcHJlZnM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGdpdDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSAocHJlZnMuZ2l0IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA/PyB7fTtcblxuICAvLyBtYWluX2JyYW5jaFxuICBjb25zdCBjdXJyZW50QnJhbmNoID0gZ2l0Lm1haW5fYnJhbmNoID8gU3RyaW5nKGdpdC5tYWluX2JyYW5jaCkgOiBcIlwiO1xuICBjb25zdCBicmFuY2hJbnB1dCA9IGF3YWl0IGN0eC51aS5pbnB1dChcbiAgICBgR2l0IG1haW4gYnJhbmNoJHtjdXJyZW50QnJhbmNoID8gYCAoY3VycmVudDogJHtjdXJyZW50QnJhbmNofSlgIDogXCJcIn06YCxcbiAgICBjdXJyZW50QnJhbmNoIHx8IFwibWFpblwiLFxuICApO1xuICBpZiAoYnJhbmNoSW5wdXQgIT09IG51bGwgJiYgYnJhbmNoSW5wdXQgIT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IHZhbCA9IGJyYW5jaElucHV0LnRyaW0oKTtcbiAgICBpZiAodmFsKSB7XG4gICAgICBnaXQubWFpbl9icmFuY2ggPSB2YWw7XG4gICAgfSBlbHNlIGlmIChjdXJyZW50QnJhbmNoKSB7XG4gICAgICBkZWxldGUgZ2l0Lm1haW5fYnJhbmNoO1xuICAgIH1cbiAgfVxuXG4gIC8vIEJvb2xlYW4gZ2l0IHRvZ2dsZXNcbiAgY29uc3QgZ2l0Qm9vbGVhbkZpZWxkcyA9IFtcbiAgICB7IGtleTogXCJhdXRvX3B1c2hcIiwgbGFiZWw6IFwiQXV0by1wdXNoIGNvbW1pdHMgYWZ0ZXIgY29tbWl0dGluZ1wiLCBkZWZhdWx0VmFsOiBmYWxzZSB9LFxuICAgIHsga2V5OiBcInB1c2hfYnJhbmNoZXNcIiwgbGFiZWw6IFwiUHVzaCBtaWxlc3RvbmUgYnJhbmNoZXMgdG8gcmVtb3RlXCIsIGRlZmF1bHRWYWw6IGZhbHNlIH0sXG4gICAgeyBrZXk6IFwic25hcHNob3RzXCIsIGxhYmVsOiBcIkNyZWF0ZSBXSVAgc25hcHNob3QgY29tbWl0cyBkdXJpbmcgbG9uZyB0YXNrc1wiLCBkZWZhdWx0VmFsOiB0cnVlIH0sXG4gIF0gYXMgY29uc3Q7XG5cbiAgZm9yIChjb25zdCBmaWVsZCBvZiBnaXRCb29sZWFuRmllbGRzKSB7XG4gICAgY29uc3QgY3VycmVudCA9IGdpdFtmaWVsZC5rZXldO1xuICAgIGNvbnN0IGN1cnJlbnRTdHIgPSBjdXJyZW50ICE9PSB1bmRlZmluZWQgPyBTdHJpbmcoY3VycmVudCkgOiBcIlwiO1xuICAgIGNvbnN0IGNob2ljZSA9IGF3YWl0IGN0eC51aS5zZWxlY3QoXG4gICAgICBgJHtmaWVsZC5sYWJlbH0ke2N1cnJlbnRTdHIgPyBgIChjdXJyZW50OiAke2N1cnJlbnRTdHJ9KWAgOiBgIChkZWZhdWx0OiAke2ZpZWxkLmRlZmF1bHRWYWx9KWB9OmAsXG4gICAgICBbXCJ0cnVlXCIsIFwiZmFsc2VcIiwgXCIoa2VlcCBjdXJyZW50KVwiXSxcbiAgICApO1xuICAgIGlmIChjaG9pY2UgJiYgY2hvaWNlICE9PSBcIihrZWVwIGN1cnJlbnQpXCIpIHtcbiAgICAgIGdpdFtmaWVsZC5rZXldID0gY2hvaWNlID09PSBcInRydWVcIjtcbiAgICB9XG4gIH1cblxuICAvLyByZW1vdGVcbiAgY29uc3QgY3VycmVudFJlbW90ZSA9IGdpdC5yZW1vdGUgPyBTdHJpbmcoZ2l0LnJlbW90ZSkgOiBcIlwiO1xuICBjb25zdCByZW1vdGVJbnB1dCA9IGF3YWl0IGN0eC51aS5pbnB1dChcbiAgICBgR2l0IHJlbW90ZSBuYW1lJHtjdXJyZW50UmVtb3RlID8gYCAoY3VycmVudDogJHtjdXJyZW50UmVtb3RlfSlgIDogXCIgKGRlZmF1bHQ6IG9yaWdpbilcIn06YCxcbiAgICBjdXJyZW50UmVtb3RlIHx8IFwib3JpZ2luXCIsXG4gICk7XG4gIGlmIChyZW1vdGVJbnB1dCAhPT0gbnVsbCAmJiByZW1vdGVJbnB1dCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgY29uc3QgdmFsID0gcmVtb3RlSW5wdXQudHJpbSgpO1xuICAgIGlmICh2YWwgJiYgdmFsICE9PSBcIm9yaWdpblwiKSB7XG4gICAgICBnaXQucmVtb3RlID0gdmFsO1xuICAgIH0gZWxzZSBpZiAoIXZhbCAmJiBjdXJyZW50UmVtb3RlKSB7XG4gICAgICBkZWxldGUgZ2l0LnJlbW90ZTtcbiAgICB9XG4gIH1cblxuICAvLyBwcmVfbWVyZ2VfY2hlY2tcbiAgY29uc3QgY3VycmVudFByZU1lcmdlID0gZ2l0LnByZV9tZXJnZV9jaGVjayAhPT0gdW5kZWZpbmVkID8gU3RyaW5nKGdpdC5wcmVfbWVyZ2VfY2hlY2spIDogXCJcIjtcbiAgY29uc3QgcHJlTWVyZ2VDaG9pY2UgPSBhd2FpdCBjdHgudWkuc2VsZWN0KFxuICAgIGBQcmUtbWVyZ2UgY2hlY2ske2N1cnJlbnRQcmVNZXJnZSA/IGAgKGN1cnJlbnQ6ICR7Y3VycmVudFByZU1lcmdlfSlgIDogXCIgKGRlZmF1bHQ6IGF1dG8pXCJ9OmAsXG4gICAgW1widHJ1ZVwiLCBcImZhbHNlXCIsIFwiYXV0b1wiLCBcIihrZWVwIGN1cnJlbnQpXCJdLFxuICApO1xuICBpZiAocHJlTWVyZ2VDaG9pY2UgJiYgcHJlTWVyZ2VDaG9pY2UgIT09IFwiKGtlZXAgY3VycmVudClcIikge1xuICAgIGlmIChwcmVNZXJnZUNob2ljZSA9PT0gXCJhdXRvXCIpIHtcbiAgICAgIGdpdC5wcmVfbWVyZ2VfY2hlY2sgPSBcImF1dG9cIjtcbiAgICB9IGVsc2Uge1xuICAgICAgZ2l0LnByZV9tZXJnZV9jaGVjayA9IHByZU1lcmdlQ2hvaWNlID09PSBcInRydWVcIjtcbiAgICB9XG4gIH1cblxuICAvLyBjb21taXRfdHlwZVxuICBjb25zdCBjdXJyZW50Q29tbWl0VHlwZSA9IGdpdC5jb21taXRfdHlwZSA/IFN0cmluZyhnaXQuY29tbWl0X3R5cGUpIDogXCJcIjtcbiAgY29uc3QgY29tbWl0VHlwZXMgPSBbXCJmZWF0XCIsIFwiZml4XCIsIFwicmVmYWN0b3JcIiwgXCJkb2NzXCIsIFwidGVzdFwiLCBcImNob3JlXCIsIFwicGVyZlwiLCBcImNpXCIsIFwiYnVpbGRcIiwgXCJzdHlsZVwiLCBcIihpbmZlcnJlZCBcdTIwMTQgZGVmYXVsdClcIiwgXCIoa2VlcCBjdXJyZW50KVwiXTtcbiAgY29uc3QgY29tbWl0Q2hvaWNlID0gYXdhaXQgY3R4LnVpLnNlbGVjdChcbiAgICBgRGVmYXVsdCBjb21taXQgdHlwZSR7Y3VycmVudENvbW1pdFR5cGUgPyBgIChjdXJyZW50OiAke2N1cnJlbnRDb21taXRUeXBlfSlgIDogXCJcIn06YCxcbiAgICBjb21taXRUeXBlcyxcbiAgKTtcbiAgaWYgKGNvbW1pdENob2ljZSAmJiB0eXBlb2YgY29tbWl0Q2hvaWNlID09PSBcInN0cmluZ1wiICYmIGNvbW1pdENob2ljZSAhPT0gXCIoa2VlcCBjdXJyZW50KVwiKSB7XG4gICAgaWYgKChjb21taXRDaG9pY2UgYXMgc3RyaW5nKS5zdGFydHNXaXRoKFwiKGluZmVycmVkXCIpKSB7XG4gICAgICBkZWxldGUgZ2l0LmNvbW1pdF90eXBlO1xuICAgIH0gZWxzZSB7XG4gICAgICBnaXQuY29tbWl0X3R5cGUgPSBjb21taXRDaG9pY2U7XG4gICAgfVxuICB9XG5cbiAgLy8gbWVyZ2Vfc3RyYXRlZ3lcbiAgY29uc3QgY3VycmVudE1lcmdlID0gZ2l0Lm1lcmdlX3N0cmF0ZWd5ID8gU3RyaW5nKGdpdC5tZXJnZV9zdHJhdGVneSkgOiBcIlwiO1xuICBjb25zdCBtZXJnZUNob2ljZSA9IGF3YWl0IGN0eC51aS5zZWxlY3QoXG4gICAgYE1lcmdlIHN0cmF0ZWd5JHtjdXJyZW50TWVyZ2UgPyBgIChjdXJyZW50OiAke2N1cnJlbnRNZXJnZX0pYCA6IFwiXCJ9OmAsXG4gICAgW1wic3F1YXNoXCIsIFwibWVyZ2VcIiwgXCIoa2VlcCBjdXJyZW50KVwiXSxcbiAgKTtcbiAgaWYgKG1lcmdlQ2hvaWNlICYmIG1lcmdlQ2hvaWNlICE9PSBcIihrZWVwIGN1cnJlbnQpXCIpIHtcbiAgICBnaXQubWVyZ2Vfc3RyYXRlZ3kgPSBtZXJnZUNob2ljZTtcbiAgfVxuXG4gIC8vIGlzb2xhdGlvblxuICBjb25zdCBjdXJyZW50SXNvbGF0aW9uID0gZ2l0Lmlzb2xhdGlvbiA/IFN0cmluZyhnaXQuaXNvbGF0aW9uKSA6IFwiXCI7XG4gIGNvbnN0IGlzb2xhdGlvbkNob2ljZSA9IGF3YWl0IGN0eC51aS5zZWxlY3QoXG4gICAgYEdpdCBpc29sYXRpb24gc3RyYXRlZ3kke2N1cnJlbnRJc29sYXRpb24gPyBgIChjdXJyZW50OiAke2N1cnJlbnRJc29sYXRpb259KWAgOiBcIiAoZGVmYXVsdDogd29ya3RyZWUpXCJ9OmAsXG4gICAgW1wid29ya3RyZWVcIiwgXCJicmFuY2hcIiwgXCJub25lXCIsIFwiKGtlZXAgY3VycmVudClcIl0sXG4gICk7XG4gIGlmIChpc29sYXRpb25DaG9pY2UgJiYgaXNvbGF0aW9uQ2hvaWNlICE9PSBcIihrZWVwIGN1cnJlbnQpXCIpIHtcbiAgICBnaXQuaXNvbGF0aW9uID0gaXNvbGF0aW9uQ2hvaWNlO1xuICB9XG5cbiAgLy8gYWJzb3JiX3NuYXBzaG90X2NvbW1pdHMgKGdpdCBzdWIta2V5KVxuICBjb25zdCBjdXJyZW50QWJzb3JiID0gZ2l0LmFic29yYl9zbmFwc2hvdF9jb21taXRzO1xuICBjb25zdCBhYnNvcmJTdHIgPSBjdXJyZW50QWJzb3JiICE9PSB1bmRlZmluZWQgPyBTdHJpbmcoY3VycmVudEFic29yYikgOiBcIlwiO1xuICBjb25zdCBhYnNvcmJDaG9pY2UgPSBhd2FpdCBjdHgudWkuc2VsZWN0KFxuICAgIGBBYnNvcmIgc25hcHNob3QgY29tbWl0cyBpbnRvIHJlYWwgY29tbWl0cyR7YWJzb3JiU3RyID8gYCAoY3VycmVudDogJHthYnNvcmJTdHJ9KWAgOiBcIiAoZGVmYXVsdDogdHJ1ZSlcIn06YCxcbiAgICBbXCJ0cnVlXCIsIFwiZmFsc2VcIiwgXCIoa2VlcCBjdXJyZW50KVwiXSxcbiAgKTtcbiAgaWYgKGFic29yYkNob2ljZSAmJiBhYnNvcmJDaG9pY2UgIT09IFwiKGtlZXAgY3VycmVudClcIikge1xuICAgIGdpdC5hYnNvcmJfc25hcHNob3RfY29tbWl0cyA9IGFic29yYkNob2ljZSA9PT0gXCJ0cnVlXCI7XG4gIH1cblxuICBpZiAoT2JqZWN0LmtleXMoZ2l0KS5sZW5ndGggPiAwKSB7XG4gICAgcHJlZnMuZ2l0ID0gZ2l0O1xuICB9XG5cbiAgLy8gc3RhbGVfY29tbWl0X3RocmVzaG9sZF9taW51dGVzICh0b3AtbGV2ZWwgcHJlZiwgc2hvd24gaW4gR2l0IHNlY3Rpb24pXG4gIGNvbnN0IGN1cnJlbnRUaHJlc2hvbGQgPSBwcmVmcy5zdGFsZV9jb21taXRfdGhyZXNob2xkX21pbnV0ZXM7XG4gIGNvbnN0IHRocmVzaG9sZFN0ciA9IGN1cnJlbnRUaHJlc2hvbGQgIT09IHVuZGVmaW5lZCA/IFN0cmluZyhjdXJyZW50VGhyZXNob2xkKSA6IFwiXCI7XG4gIGNvbnN0IHRocmVzaG9sZElucHV0ID0gYXdhaXQgY3R4LnVpLmlucHV0KFxuICAgIGBTdGFsZSBjb21taXQgdGhyZXNob2xkIChtaW51dGVzLCAwIHRvIGRpc2FibGUpJHt0aHJlc2hvbGRTdHIgPyBgIChjdXJyZW50OiAke3RocmVzaG9sZFN0cn0pYCA6IFwiIChkZWZhdWx0OiAzMClcIn06YCxcbiAgICB0aHJlc2hvbGRTdHIgfHwgXCIzMFwiLFxuICApO1xuICBpZiAodGhyZXNob2xkSW5wdXQgIT09IG51bGwgJiYgdGhyZXNob2xkSW5wdXQgIT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IHZhbCA9IHRocmVzaG9sZElucHV0LnRyaW0oKTtcbiAgICBjb25zdCBwYXJzZWQgPSB0cnlQYXJzZUludGVnZXIodmFsKTtcbiAgICBpZiAodmFsICYmIHBhcnNlZCAhPT0gbnVsbCAmJiBwYXJzZWQgPj0gMCkge1xuICAgICAgcHJlZnMuc3RhbGVfY29tbWl0X3RocmVzaG9sZF9taW51dGVzID0gcGFyc2VkO1xuICAgIH0gZWxzZSBpZiAodmFsICYmIHBhcnNlZCA9PT0gbnVsbCkge1xuICAgICAgY3R4LnVpLm5vdGlmeShgSW52YWxpZCB2YWx1ZSBcIiR7dmFsfVwiIFx1MjAxNCBtdXN0IGJlIGEgd2hvbGUgbnVtYmVyLiBLZWVwaW5nIHByZXZpb3VzIHZhbHVlLmAsIFwid2FybmluZ1wiKTtcbiAgICB9IGVsc2UgaWYgKCF2YWwgJiYgY3VycmVudFRocmVzaG9sZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBkZWxldGUgcHJlZnMuc3RhbGVfY29tbWl0X3RocmVzaG9sZF9taW51dGVzO1xuICAgIH1cbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBjb25maWd1cmVTa2lsbHMoY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCwgcHJlZnM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogUHJvbWlzZTx2b2lkPiB7XG4gIC8vIFNraWxsIGRpc2NvdmVyeSBtb2RlXG4gIGNvbnN0IGRpc2NvdmVyeSA9IGF3YWl0IHByb21wdEVudW0oY3R4LCBcIlNraWxsIGRpc2NvdmVyeSBtb2RlXCIsIHByZWZzLnNraWxsX2Rpc2NvdmVyeSwgW1wiYXV0b1wiLCBcInN1Z2dlc3RcIiwgXCJvZmZcIl0pO1xuICBpZiAoZGlzY292ZXJ5ICE9PSB1bmRlZmluZWQpIHByZWZzLnNraWxsX2Rpc2NvdmVyeSA9IGRpc2NvdmVyeTtcblxuICAvLyBVQVQgZGlzcGF0Y2hcbiAgY29uc3QgdWF0ID0gYXdhaXQgcHJvbXB0Qm9vbGVhbihjdHgsIFwiVUFUIGRpc3BhdGNoIG1vZGVcIiwgcHJlZnMudWF0X2Rpc3BhdGNoLCBmYWxzZSk7XG4gIGlmICh1YXQgIT09IHVuZGVmaW5lZCkgcHJlZnMudWF0X2Rpc3BhdGNoID0gdWF0O1xuXG4gIC8vIFNraWxsIGxpc3RzIFx1MjAxNCBlZGl0IHZpYSBzdWItbWVudXNcbiAgYXdhaXQgZWRpdFN0cmluZ0xpc3RGaWVsZChjdHgsIHByZWZzLCBcImFsd2F5c191c2Vfc2tpbGxzXCIsIFwiQWx3YXlzLXVzZSBza2lsbHNcIik7XG4gIGF3YWl0IGVkaXRTdHJpbmdMaXN0RmllbGQoY3R4LCBwcmVmcywgXCJwcmVmZXJfc2tpbGxzXCIsIFwiUHJlZmVycmVkIHNraWxsc1wiKTtcbiAgYXdhaXQgZWRpdFN0cmluZ0xpc3RGaWVsZChjdHgsIHByZWZzLCBcImF2b2lkX3NraWxsc1wiLCBcIkF2b2lkZWQgc2tpbGxzXCIpO1xuICBhd2FpdCBlZGl0U3RyaW5nTGlzdEZpZWxkKGN0eCwgcHJlZnMsIFwiY3VzdG9tX2luc3RydWN0aW9uc1wiLCBcIkN1c3RvbSBpbnN0cnVjdGlvbnNcIik7XG5cbiAgLy8gU2tpbGwgcnVsZXMgKGFycmF5IG9mIHt3aGVuLCB1c2U/LCBwcmVmZXI/LCBhdm9pZD99KVxuICBhd2FpdCBjb25maWd1cmVTa2lsbFJ1bGVzKGN0eCwgcHJlZnMpO1xuXG4gIC8vIFNraWxsIHN0YWxlbmVzcyBkYXlzXG4gIGNvbnN0IHN0YWxlbmVzcyA9IGF3YWl0IHByb21wdEludGVnZXIoY3R4LCBcIlNraWxsIHN0YWxlbmVzcyBkYXlzICgwIHRvIGRpc2FibGUpXCIsIHByZWZzLnNraWxsX3N0YWxlbmVzc19kYXlzLCBcIjYwXCIpO1xuICBhcHBseU51bWJlcihwcmVmcywgXCJza2lsbF9zdGFsZW5lc3NfZGF5c1wiLCBzdGFsZW5lc3MpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjb25maWd1cmVTa2lsbFJ1bGVzKGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsIHByZWZzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IFByb21pc2U8dm9pZD4ge1xuICB0eXBlIFJ1bGUgPSB7IHdoZW46IHN0cmluZzsgdXNlPzogc3RyaW5nW107IHByZWZlcj86IHN0cmluZ1tdOyBhdm9pZD86IHN0cmluZ1tdIH07XG4gIGxldCBydWxlczogUnVsZVtdID0gQXJyYXkuaXNBcnJheShwcmVmcy5za2lsbF9ydWxlcykgPyBbLi4ucHJlZnMuc2tpbGxfcnVsZXMgYXMgUnVsZVtdXSA6IFtdO1xuICB3aGlsZSAodHJ1ZSkge1xuICAgIGNvbnN0IHN1bW1hcnkgPSBydWxlcy5sZW5ndGggPT09IDBcbiAgICAgID8gXCIobm8gcnVsZXMpXCJcbiAgICAgIDogYCR7cnVsZXMubGVuZ3RofSBydWxlKHMpYDtcbiAgICBjb25zdCBsaXN0TGFiZWxzID0gcnVsZXMubWFwKChyLCBpKSA9PiBgIyR7aSArIDF9IHdoZW46ICR7ci53aGVufWApO1xuICAgIGNvbnN0IG9wdGlvbnMgPSBbLi4ubGlzdExhYmVscywgXCJBZGQgcnVsZVwiLCBcIkRvbmVcIl07XG4gICAgY29uc3QgY2hvaWNlID0gYXdhaXQgY3R4LnVpLnNlbGVjdChgU2tpbGwgcnVsZXMgXHUyMDE0ICR7c3VtbWFyeX1gLCBvcHRpb25zKTtcbiAgICBjb25zdCBwaWNrID0gdHlwZW9mIGNob2ljZSA9PT0gXCJzdHJpbmdcIiA/IGNob2ljZSA6IFwiXCI7XG4gICAgaWYgKCFwaWNrIHx8IHBpY2sgPT09IFwiRG9uZVwiKSBicmVhaztcbiAgICBpZiAocGljayA9PT0gXCJBZGQgcnVsZVwiKSB7XG4gICAgICBjb25zdCB3aGVuSW5wdXQgPSBhd2FpdCBjdHgudWkuaW5wdXQoXCJSdWxlIGNvbmRpdGlvbiAoZnJlZSB0ZXh0LCBlLmcuICdmcm9udGVuZCB0YXNrcycpOlwiLCBcIlwiKTtcbiAgICAgIGNvbnN0IHdoZW4gPSB0eXBlb2Ygd2hlbklucHV0ID09PSBcInN0cmluZ1wiID8gd2hlbklucHV0LnRyaW0oKSA6IFwiXCI7XG4gICAgICBpZiAoIXdoZW4pIGNvbnRpbnVlO1xuICAgICAgY29uc3QgcnVsZTogUnVsZSA9IHsgd2hlbiB9O1xuICAgICAgZm9yIChjb25zdCBmaWVsZCBvZiBbXCJ1c2VcIiwgXCJwcmVmZXJcIiwgXCJhdm9pZFwiXSBhcyBjb25zdCkge1xuICAgICAgICBjb25zdCBsaXN0SW5wdXQgPSBhd2FpdCBjdHgudWkuaW5wdXQoYFNraWxscyB0byAke2ZpZWxkfSAoY29tbWEtIG9yIG5ld2xpbmUtc2VwYXJhdGVkLCBibGFuayB0byBza2lwKTpgLCBcIlwiKTtcbiAgICAgICAgaWYgKGxpc3RJbnB1dCkge1xuICAgICAgICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlU3RyaW5nTGlzdChsaXN0SW5wdXQpO1xuICAgICAgICAgIGlmIChwYXJzZWQubGVuZ3RoID4gMCkgcnVsZVtmaWVsZF0gPSBwYXJzZWQ7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChydWxlLnVzZSB8fCBydWxlLnByZWZlciB8fCBydWxlLmF2b2lkKSBydWxlcy5wdXNoKHJ1bGUpO1xuICAgICAgZWxzZSBjdHgudWkubm90aWZ5KFwiUnVsZSBkaXNjYXJkZWQgXHUyMDE0IG11c3QgaGF2ZSBhdCBsZWFzdCBvbmUgb2YgdXNlL3ByZWZlci9hdm9pZC5cIiwgXCJ3YXJuaW5nXCIpO1xuICAgIH0gZWxzZSBpZiAocGljay5zdGFydHNXaXRoKFwiI1wiKSkge1xuICAgICAgY29uc3QgaWR4ID0gTnVtYmVyKHBpY2suc2xpY2UoMSwgcGljay5pbmRleE9mKFwiIFwiKSkpIC0gMTtcbiAgICAgIGlmIChpZHggPCAwIHx8IGlkeCA+PSBydWxlcy5sZW5ndGgpIGNvbnRpbnVlO1xuICAgICAgY29uc3QgZWRpdENob2ljZSA9IGF3YWl0IGN0eC51aS5zZWxlY3QoXG4gICAgICAgIGBSdWxlICMke2lkeCArIDF9YCxcbiAgICAgICAgW1wiRWRpdCBjb25kaXRpb25cIiwgXCJFZGl0IHVzZSBsaXN0XCIsIFwiRWRpdCBwcmVmZXIgbGlzdFwiLCBcIkVkaXQgYXZvaWQgbGlzdFwiLCBcIkRlbGV0ZSBydWxlXCIsIFwiQ2FuY2VsXCJdLFxuICAgICAgKTtcbiAgICAgIGNvbnN0IGVjID0gdHlwZW9mIGVkaXRDaG9pY2UgPT09IFwic3RyaW5nXCIgPyBlZGl0Q2hvaWNlIDogXCJcIjtcbiAgICAgIGlmICghZWMgfHwgZWMgPT09IFwiQ2FuY2VsXCIpIGNvbnRpbnVlO1xuICAgICAgaWYgKGVjID09PSBcIkRlbGV0ZSBydWxlXCIpIHtcbiAgICAgICAgcnVsZXMgPSBydWxlcy5maWx0ZXIoKF8sIGkpID0+IGkgIT09IGlkeCk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgaWYgKGVjID09PSBcIkVkaXQgY29uZGl0aW9uXCIpIHtcbiAgICAgICAgY29uc3QgbmV3V2hlbiA9IGF3YWl0IHByb21wdFN0cmluZyhjdHgsIFwiUnVsZSBjb25kaXRpb25cIiwgcnVsZXNbaWR4XS53aGVuKTtcbiAgICAgICAgaWYgKG5ld1doZW4gIT09IHVuZGVmaW5lZCAmJiBuZXdXaGVuICE9PSBcIlwiKSBydWxlc1tpZHhdLndoZW4gPSBuZXdXaGVuO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc3QgZmllbGRLZXkgPSBlYyA9PT0gXCJFZGl0IHVzZSBsaXN0XCIgPyBcInVzZVwiIDogZWMgPT09IFwiRWRpdCBwcmVmZXIgbGlzdFwiID8gXCJwcmVmZXJcIiA6IFwiYXZvaWRcIjtcbiAgICAgICAgY29uc3QgY3VycmVudExpc3QgPSBydWxlc1tpZHhdW2ZpZWxkS2V5XSA/PyBbXTtcbiAgICAgICAgY29uc3QgbGlzdElucHV0ID0gYXdhaXQgY3R4LnVpLmlucHV0KFxuICAgICAgICAgIGAke2ZpZWxkS2V5fSBsaXN0IChjb21tYS0gb3IgbmV3bGluZS1zZXBhcmF0ZWQsIGJsYW5rIHRvIGNsZWFyKTpgLFxuICAgICAgICAgIGN1cnJlbnRMaXN0LmpvaW4oXCIsIFwiKSxcbiAgICAgICAgKTtcbiAgICAgICAgaWYgKGxpc3RJbnB1dCA9PT0gbnVsbCB8fCBsaXN0SW5wdXQgPT09IHVuZGVmaW5lZCkgY29udGludWU7XG4gICAgICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlU3RyaW5nTGlzdChsaXN0SW5wdXQpO1xuICAgICAgICBpZiAocGFyc2VkLmxlbmd0aCA+IDApIHJ1bGVzW2lkeF1bZmllbGRLZXldID0gcGFyc2VkO1xuICAgICAgICBlbHNlIGRlbGV0ZSBydWxlc1tpZHhdW2ZpZWxkS2V5XTtcbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgaWYgKHJ1bGVzLmxlbmd0aCA+IDApIHByZWZzLnNraWxsX3J1bGVzID0gcnVsZXM7XG4gIGVsc2UgaWYgKHByZWZzLnNraWxsX3J1bGVzICE9PSB1bmRlZmluZWQpIGRlbGV0ZSBwcmVmcy5za2lsbF9ydWxlcztcbn1cblxuYXN5bmMgZnVuY3Rpb24gY29uZmlndXJlQnVkZ2V0KGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsIHByZWZzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBjdXJyZW50Q2VpbGluZyA9IHByZWZzLmJ1ZGdldF9jZWlsaW5nO1xuICBjb25zdCBjZWlsaW5nU3RyID0gY3VycmVudENlaWxpbmcgIT09IHVuZGVmaW5lZCA/IFN0cmluZyhjdXJyZW50Q2VpbGluZykgOiBcIlwiO1xuICBjb25zdCBjZWlsaW5nSW5wdXQgPSBhd2FpdCBjdHgudWkuaW5wdXQoXG4gICAgYEJ1ZGdldCBjZWlsaW5nIChVU0QpJHtjZWlsaW5nU3RyID8gYCAoY3VycmVudDogJCR7Y2VpbGluZ1N0cn0pYCA6IFwiIChkZWZhdWx0OiBubyBsaW1pdClcIn06YCxcbiAgICBjZWlsaW5nU3RyIHx8IFwiXCIsXG4gICk7XG4gIGlmIChjZWlsaW5nSW5wdXQgIT09IG51bGwgJiYgY2VpbGluZ0lucHV0ICE9PSB1bmRlZmluZWQpIHtcbiAgICBjb25zdCB2YWwgPSBjZWlsaW5nSW5wdXQudHJpbSgpLnJlcGxhY2UoL15cXCQvLCBcIlwiKTtcbiAgICBjb25zdCBwYXJzZWQgPSB0cnlQYXJzZU51bWJlcih2YWwpO1xuICAgIGlmICh2YWwgJiYgcGFyc2VkICE9PSBudWxsKSB7XG4gICAgICBwcmVmcy5idWRnZXRfY2VpbGluZyA9IHBhcnNlZDtcbiAgICB9IGVsc2UgaWYgKHZhbCkge1xuICAgICAgY3R4LnVpLm5vdGlmeShgSW52YWxpZCBidWRnZXQgY2VpbGluZyBcIiR7dmFsfVwiIFx1MjAxNCBtdXN0IGJlIGEgbnVtYmVyLiBLZWVwaW5nIHByZXZpb3VzIHZhbHVlLmAsIFwid2FybmluZ1wiKTtcbiAgICB9IGVsc2UgaWYgKCF2YWwgJiYgY2VpbGluZ1N0cikge1xuICAgICAgZGVsZXRlIHByZWZzLmJ1ZGdldF9jZWlsaW5nO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IGN1cnJlbnRFbmZvcmNlbWVudCA9IChwcmVmcy5idWRnZXRfZW5mb3JjZW1lbnQgYXMgc3RyaW5nKSA/PyBcIlwiO1xuICBjb25zdCBlbmZvcmNlbWVudENob2ljZSA9IGF3YWl0IGN0eC51aS5zZWxlY3QoXG4gICAgYEJ1ZGdldCBlbmZvcmNlbWVudCR7Y3VycmVudEVuZm9yY2VtZW50ID8gYCAoY3VycmVudDogJHtjdXJyZW50RW5mb3JjZW1lbnR9KWAgOiBcIiAoZGVmYXVsdDogcGF1c2UpXCJ9OmAsXG4gICAgW1wid2FyblwiLCBcInBhdXNlXCIsIFwiaGFsdFwiLCBcIihrZWVwIGN1cnJlbnQpXCJdLFxuICApO1xuICBpZiAoZW5mb3JjZW1lbnRDaG9pY2UgJiYgZW5mb3JjZW1lbnRDaG9pY2UgIT09IFwiKGtlZXAgY3VycmVudClcIikge1xuICAgIHByZWZzLmJ1ZGdldF9lbmZvcmNlbWVudCA9IGVuZm9yY2VtZW50Q2hvaWNlO1xuICB9XG5cbiAgY29uc3QgY3VycmVudENvbnRleHRQYXVzZSA9IHByZWZzLmNvbnRleHRfcGF1c2VfdGhyZXNob2xkO1xuICBjb25zdCBjb250ZXh0UGF1c2VTdHIgPSBjdXJyZW50Q29udGV4dFBhdXNlICE9PSB1bmRlZmluZWQgPyBTdHJpbmcoY3VycmVudENvbnRleHRQYXVzZSkgOiBcIlwiO1xuICBjb25zdCBjb250ZXh0UGF1c2VJbnB1dCA9IGF3YWl0IGN0eC51aS5pbnB1dChcbiAgICBgQ29udGV4dCBwYXVzZSB0aHJlc2hvbGQgKDAtMTAwJSwgMD1kaXNhYmxlZCkke2NvbnRleHRQYXVzZVN0ciA/IGAgKGN1cnJlbnQ6ICR7Y29udGV4dFBhdXNlU3RyfSUpYCA6IFwiIChkZWZhdWx0OiAwKVwifTpgLFxuICAgIGNvbnRleHRQYXVzZVN0ciB8fCBcIjBcIixcbiAgKTtcbiAgaWYgKGNvbnRleHRQYXVzZUlucHV0ICE9PSBudWxsICYmIGNvbnRleHRQYXVzZUlucHV0ICE9PSB1bmRlZmluZWQpIHtcbiAgICBjb25zdCB2YWwgPSBjb250ZXh0UGF1c2VJbnB1dC50cmltKCkucmVwbGFjZSgvJSQvLCBcIlwiKTtcbiAgICBjb25zdCBwYXJzZWQgPSB0cnlQYXJzZVBlcmNlbnRhZ2UodmFsKTtcbiAgICBpZiAodmFsICYmIHBhcnNlZCAhPT0gbnVsbCkge1xuICAgICAgaWYgKHBhcnNlZCA9PT0gMCkge1xuICAgICAgICBkZWxldGUgcHJlZnMuY29udGV4dF9wYXVzZV90aHJlc2hvbGQ7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBwcmVmcy5jb250ZXh0X3BhdXNlX3RocmVzaG9sZCA9IHBhcnNlZDtcbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKHZhbCkge1xuICAgICAgY3R4LnVpLm5vdGlmeShgSW52YWxpZCBjb250ZXh0IHBhdXNlIHRocmVzaG9sZCBcIiR7dmFsfVwiIFx1MjAxNCBtdXN0IGJlIDAtMTAwLiBLZWVwaW5nIHByZXZpb3VzIHZhbHVlLmAsIFwid2FybmluZ1wiKTtcbiAgICB9XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gY29uZmlndXJlTm90aWZpY2F0aW9ucyhjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LCBwcmVmczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3Qgbm90aWY6IFJlY29yZDxzdHJpbmcsIGJvb2xlYW4+ID0gKHByZWZzLm5vdGlmaWNhdGlvbnMgYXMgUmVjb3JkPHN0cmluZywgYm9vbGVhbj4pID8/IHt9O1xuICBjb25zdCBub3RpZkZpZWxkcyA9IFtcbiAgICB7IGtleTogXCJlbmFibGVkXCIsIGxhYmVsOiBcIk5vdGlmaWNhdGlvbnMgZW5hYmxlZCAobWFzdGVyIHRvZ2dsZSlcIiwgZGVmYXVsdFZhbDogdHJ1ZSB9LFxuICAgIHsga2V5OiBcIm9uX2NvbXBsZXRlXCIsIGxhYmVsOiBcIk5vdGlmeSBvbiB1bml0IGNvbXBsZXRpb25cIiwgZGVmYXVsdFZhbDogdHJ1ZSB9LFxuICAgIHsga2V5OiBcIm9uX2Vycm9yXCIsIGxhYmVsOiBcIk5vdGlmeSBvbiBlcnJvcnNcIiwgZGVmYXVsdFZhbDogdHJ1ZSB9LFxuICAgIHsga2V5OiBcIm9uX2J1ZGdldFwiLCBsYWJlbDogXCJOb3RpZnkgb24gYnVkZ2V0IHRocmVzaG9sZHNcIiwgZGVmYXVsdFZhbDogdHJ1ZSB9LFxuICAgIHsga2V5OiBcIm9uX21pbGVzdG9uZVwiLCBsYWJlbDogXCJOb3RpZnkgb24gbWlsZXN0b25lIGNvbXBsZXRpb25cIiwgZGVmYXVsdFZhbDogdHJ1ZSB9LFxuICAgIHsga2V5OiBcIm9uX2F0dGVudGlvblwiLCBsYWJlbDogXCJOb3RpZnkgd2hlbiBtYW51YWwgYXR0ZW50aW9uIG5lZWRlZFwiLCBkZWZhdWx0VmFsOiB0cnVlIH0sXG4gIF0gYXMgY29uc3Q7XG5cbiAgZm9yIChjb25zdCBmaWVsZCBvZiBub3RpZkZpZWxkcykge1xuICAgIGNvbnN0IGN1cnJlbnQgPSBub3RpZltmaWVsZC5rZXldO1xuICAgIGNvbnN0IGN1cnJlbnRTdHIgPSBjdXJyZW50ICE9PSB1bmRlZmluZWQgJiYgdHlwZW9mIGN1cnJlbnQgPT09IFwiYm9vbGVhblwiID8gU3RyaW5nKGN1cnJlbnQpIDogXCJcIjtcbiAgICBjb25zdCBjaG9pY2UgPSBhd2FpdCBjdHgudWkuc2VsZWN0KFxuICAgICAgYCR7ZmllbGQubGFiZWx9JHtjdXJyZW50U3RyID8gYCAoY3VycmVudDogJHtjdXJyZW50U3RyfSlgIDogYCAoZGVmYXVsdDogJHtmaWVsZC5kZWZhdWx0VmFsfSlgfTpgLFxuICAgICAgW1widHJ1ZVwiLCBcImZhbHNlXCIsIFwiKGtlZXAgY3VycmVudClcIl0sXG4gICAgKTtcbiAgICBpZiAoY2hvaWNlICYmIGNob2ljZSAhPT0gXCIoa2VlcCBjdXJyZW50KVwiKSB7XG4gICAgICBub3RpZltmaWVsZC5rZXldID0gY2hvaWNlID09PSBcInRydWVcIjtcbiAgICB9XG4gIH1cbiAgaWYgKE9iamVjdC5rZXlzKG5vdGlmKS5sZW5ndGggPiAwKSB7XG4gICAgcHJlZnMubm90aWZpY2F0aW9ucyA9IG5vdGlmO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNvbmZpZ3VyZVBoYXNlcyhjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LCBwcmVmczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgcGhhc2VzID0gKHByZWZzLnBoYXNlcyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZCkgPz8ge307XG4gIGNvbnN0IGZpZWxkcyA9IFtcbiAgICB7IGtleTogXCJza2lwX3Jlc2VhcmNoXCIsIGxhYmVsOiBcIlNraXAgcmVzZWFyY2ggcGhhc2VcIiB9LFxuICAgIHsga2V5OiBcInNraXBfcmVhc3Nlc3NcIiwgbGFiZWw6IFwiU2tpcCByb2FkbWFwIHJlYXNzZXNzbWVudFwiIH0sXG4gICAgeyBrZXk6IFwic2tpcF9zbGljZV9yZXNlYXJjaFwiLCBsYWJlbDogXCJTa2lwIHNsaWNlLWxldmVsIHJlc2VhcmNoXCIgfSxcbiAgICB7IGtleTogXCJza2lwX21pbGVzdG9uZV92YWxpZGF0aW9uXCIsIGxhYmVsOiBcIlNraXAgbWlsZXN0b25lIHZhbGlkYXRpb25cIiB9LFxuICAgIHsga2V5OiBcInJlYXNzZXNzX2FmdGVyX3NsaWNlXCIsIGxhYmVsOiBcIlJlYXNzZXNzIHJvYWRtYXAgYWZ0ZXIgZWFjaCBzbGljZVwiIH0sXG4gICAgeyBrZXk6IFwicmVxdWlyZV9zbGljZV9kaXNjdXNzaW9uXCIsIGxhYmVsOiBcIlBhdXNlIGZvciBkaXNjdXNzaW9uIGJlZm9yZSBlYWNoIHNsaWNlXCIgfSxcbiAgICB7IGtleTogXCJtaWRfZXhlY3V0aW9uX2VzY2FsYXRpb25cIiwgbGFiZWw6IFwiQWxsb3cgbWlkLWV4ZWN1dGlvbiBlc2NhbGF0aW9uIChBRFItMDExIFAyKVwiIH0sXG4gICAgeyBrZXk6IFwicHJvZ3Jlc3NpdmVfcGxhbm5pbmdcIiwgbGFiZWw6IFwiUHJvZ3Jlc3NpdmUgcGxhbm5pbmcgKFMwMSBmdWxsLCBTMDIrIHNrZXRjaGVzKVwiIH0sXG4gIF0gYXMgY29uc3Q7XG4gIGZvciAoY29uc3QgZmllbGQgb2YgZmllbGRzKSB7XG4gICAgY29uc3QgdmFsID0gYXdhaXQgcHJvbXB0Qm9vbGVhbihjdHgsIGZpZWxkLmxhYmVsLCBwaGFzZXNbZmllbGQua2V5XSk7XG4gICAgaWYgKHZhbCAhPT0gdW5kZWZpbmVkKSBwaGFzZXNbZmllbGQua2V5XSA9IHZhbDtcbiAgfVxuICBpZiAoT2JqZWN0LmtleXMocGhhc2VzKS5sZW5ndGggPiAwKSBwcmVmcy5waGFzZXMgPSBwaGFzZXM7XG4gIGVsc2UgaWYgKHByZWZzLnBoYXNlcyAhPT0gdW5kZWZpbmVkKSBkZWxldGUgcHJlZnMucGhhc2VzO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjb25maWd1cmVQYXJhbGxlbGlzbShjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LCBwcmVmczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgLy8gcGFyYWxsZWw6IG1pbGVzdG9uZS1sZXZlbFxuICBjb25zdCBwYXJhbGxlbCA9IChwcmVmcy5wYXJhbGxlbCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZCkgPz8ge307XG4gIGNvbnN0IHBFbmFibGVkID0gYXdhaXQgcHJvbXB0Qm9vbGVhbihjdHgsIFwiUGFyYWxsZWwgbWlsZXN0b25lIGV4ZWN1dGlvblwiLCBwYXJhbGxlbC5lbmFibGVkLCBmYWxzZSk7XG4gIGlmIChwRW5hYmxlZCAhPT0gdW5kZWZpbmVkKSBwYXJhbGxlbC5lbmFibGVkID0gcEVuYWJsZWQ7XG5cbiAgY29uc3QgcFdvcmtlcnMgPSBhd2FpdCBwcm9tcHRJbnRlZ2VyKGN0eCwgXCJNYXggcGFyYWxsZWwgd29ya2VycyAoMVx1MjAxMzQpXCIsIHBhcmFsbGVsLm1heF93b3JrZXJzLCBcIjJcIik7XG4gIGlmIChwV29ya2VycyAhPT0gdW5kZWZpbmVkICYmIHBXb3JrZXJzICE9PSBcImNsZWFyXCIpIHBhcmFsbGVsLm1heF93b3JrZXJzID0gTWF0aC5tYXgoMSwgTWF0aC5taW4oNCwgcFdvcmtlcnMpKTtcbiAgZWxzZSBpZiAocFdvcmtlcnMgPT09IFwiY2xlYXJcIikgZGVsZXRlIHBhcmFsbGVsLm1heF93b3JrZXJzO1xuXG4gIGNvbnN0IHBCdWRnZXQgPSBhd2FpdCBwcm9tcHROdW1iZXIoY3R4LCBcIlBlci13b3JrZXIgYnVkZ2V0IGNlaWxpbmcgKFVTRCwgYmxhbmsgPSBubyBsaW1pdClcIiwgcGFyYWxsZWwuYnVkZ2V0X2NlaWxpbmcpO1xuICBpZiAocEJ1ZGdldCAhPT0gdW5kZWZpbmVkICYmIHBCdWRnZXQgIT09IFwiY2xlYXJcIikgcGFyYWxsZWwuYnVkZ2V0X2NlaWxpbmcgPSBwQnVkZ2V0O1xuICBlbHNlIGlmIChwQnVkZ2V0ID09PSBcImNsZWFyXCIpIGRlbGV0ZSBwYXJhbGxlbC5idWRnZXRfY2VpbGluZztcblxuICBjb25zdCBwTWVyZ2UgPSBhd2FpdCBwcm9tcHRFbnVtKGN0eCwgXCJQYXJhbGxlbCBtZXJnZSBzdHJhdGVneVwiLCBwYXJhbGxlbC5tZXJnZV9zdHJhdGVneSwgW1wicGVyLXNsaWNlXCIsIFwicGVyLW1pbGVzdG9uZVwiXSk7XG4gIGlmIChwTWVyZ2UgIT09IHVuZGVmaW5lZCkgcGFyYWxsZWwubWVyZ2Vfc3RyYXRlZ3kgPSBwTWVyZ2U7XG5cbiAgY29uc3QgcEF1dG8gPSBhd2FpdCBwcm9tcHRFbnVtKGN0eCwgXCJBdXRvLW1lcmdlIG1vZGVcIiwgcGFyYWxsZWwuYXV0b19tZXJnZSwgW1wiYXV0b1wiLCBcImNvbmZpcm1cIiwgXCJtYW51YWxcIl0pO1xuICBpZiAocEF1dG8gIT09IHVuZGVmaW5lZCkgcGFyYWxsZWwuYXV0b19tZXJnZSA9IHBBdXRvO1xuXG4gIGNvbnN0IHBXb3JrZXJNb2RlbCA9IGF3YWl0IHByb21wdFN0cmluZyhjdHgsIFwiV29ya2VyIG1vZGVsIG92ZXJyaWRlIChlLmcuIGNsYXVkZS1oYWlrdS00LTUpXCIsIHBhcmFsbGVsLndvcmtlcl9tb2RlbCk7XG4gIGlmIChwV29ya2VyTW9kZWwgIT09IHVuZGVmaW5lZCkge1xuICAgIGlmIChwV29ya2VyTW9kZWwpIHBhcmFsbGVsLndvcmtlcl9tb2RlbCA9IHBXb3JrZXJNb2RlbDtcbiAgICBlbHNlIGRlbGV0ZSBwYXJhbGxlbC53b3JrZXJfbW9kZWw7XG4gIH1cblxuICBpZiAoT2JqZWN0LmtleXMocGFyYWxsZWwpLmxlbmd0aCA+IDApIHByZWZzLnBhcmFsbGVsID0gcGFyYWxsZWw7XG4gIGVsc2UgaWYgKHByZWZzLnBhcmFsbGVsICE9PSB1bmRlZmluZWQpIGRlbGV0ZSBwcmVmcy5wYXJhbGxlbDtcblxuICAvLyBzbGljZV9wYXJhbGxlbDogc2xpY2UtbGV2ZWxcbiAgY29uc3Qgc3AgPSAocHJlZnMuc2xpY2VfcGFyYWxsZWwgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQpID8/IHt9O1xuICBjb25zdCBzcEVuYWJsZWQgPSBhd2FpdCBwcm9tcHRCb29sZWFuKGN0eCwgXCJTbGljZS1sZXZlbCBwYXJhbGxlbCBleGVjdXRpb25cIiwgc3AuZW5hYmxlZCwgZmFsc2UpO1xuICBpZiAoc3BFbmFibGVkICE9PSB1bmRlZmluZWQpIHNwLmVuYWJsZWQgPSBzcEVuYWJsZWQ7XG5cbiAgY29uc3Qgc3BXb3JrZXJzID0gYXdhaXQgcHJvbXB0SW50ZWdlcihjdHgsIFwiU2xpY2UgbWF4IHdvcmtlcnNcIiwgc3AubWF4X3dvcmtlcnMsIFwiMlwiKTtcbiAgaWYgKHNwV29ya2VycyAhPT0gdW5kZWZpbmVkICYmIHNwV29ya2VycyAhPT0gXCJjbGVhclwiKSBzcC5tYXhfd29ya2VycyA9IHNwV29ya2VycztcbiAgZWxzZSBpZiAoc3BXb3JrZXJzID09PSBcImNsZWFyXCIpIGRlbGV0ZSBzcC5tYXhfd29ya2VycztcblxuICBpZiAoT2JqZWN0LmtleXMoc3ApLmxlbmd0aCA+IDApIHByZWZzLnNsaWNlX3BhcmFsbGVsID0gc3A7XG4gIGVsc2UgaWYgKHByZWZzLnNsaWNlX3BhcmFsbGVsICE9PSB1bmRlZmluZWQpIGRlbGV0ZSBwcmVmcy5zbGljZV9wYXJhbGxlbDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY29uZmlndXJlVmVyaWZpY2F0aW9uKGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsIHByZWZzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IFByb21pc2U8dm9pZD4ge1xuICBhd2FpdCBlZGl0U3RyaW5nTGlzdEZpZWxkKGN0eCwgcHJlZnMsIFwidmVyaWZpY2F0aW9uX2NvbW1hbmRzXCIsIFwiVmVyaWZpY2F0aW9uIGNvbW1hbmRzXCIpO1xuXG4gIGNvbnN0IGF1dG9GaXggPSBhd2FpdCBwcm9tcHRCb29sZWFuKGN0eCwgXCJBdXRvLWZpeCBvbiB2ZXJpZmljYXRpb24gZmFpbHVyZVwiLCBwcmVmcy52ZXJpZmljYXRpb25fYXV0b19maXgpO1xuICBpZiAoYXV0b0ZpeCAhPT0gdW5kZWZpbmVkKSBwcmVmcy52ZXJpZmljYXRpb25fYXV0b19maXggPSBhdXRvRml4O1xuXG4gIGNvbnN0IG1heFJldHJpZXMgPSBhd2FpdCBwcm9tcHRJbnRlZ2VyKGN0eCwgXCJWZXJpZmljYXRpb24gbWF4IHJldHJpZXNcIiwgcHJlZnMudmVyaWZpY2F0aW9uX21heF9yZXRyaWVzLCBcIjJcIik7XG4gIGFwcGx5TnVtYmVyKHByZWZzLCBcInZlcmlmaWNhdGlvbl9tYXhfcmV0cmllc1wiLCBtYXhSZXRyaWVzKTtcblxuICBjb25zdCBldiA9IGF3YWl0IHByb21wdEJvb2xlYW4oY3R4LCBcIkVuaGFuY2VkIHZlcmlmaWNhdGlvbiAobWFzdGVyIHRvZ2dsZSlcIiwgcHJlZnMuZW5oYW5jZWRfdmVyaWZpY2F0aW9uLCB0cnVlKTtcbiAgaWYgKGV2ICE9PSB1bmRlZmluZWQpIHByZWZzLmVuaGFuY2VkX3ZlcmlmaWNhdGlvbiA9IGV2O1xuICBjb25zdCBldlByZSA9IGF3YWl0IHByb21wdEJvb2xlYW4oY3R4LCBcIkVuaGFuY2VkIHZlcmlmaWNhdGlvbiBcdTIwMTQgcHJlLWV4ZWN1dGlvbiBjaGVja3NcIiwgcHJlZnMuZW5oYW5jZWRfdmVyaWZpY2F0aW9uX3ByZSwgdHJ1ZSk7XG4gIGlmIChldlByZSAhPT0gdW5kZWZpbmVkKSBwcmVmcy5lbmhhbmNlZF92ZXJpZmljYXRpb25fcHJlID0gZXZQcmU7XG4gIGNvbnN0IGV2UG9zdCA9IGF3YWl0IHByb21wdEJvb2xlYW4oY3R4LCBcIkVuaGFuY2VkIHZlcmlmaWNhdGlvbiBcdTIwMTQgcG9zdC1leGVjdXRpb24gY2hlY2tzXCIsIHByZWZzLmVuaGFuY2VkX3ZlcmlmaWNhdGlvbl9wb3N0LCB0cnVlKTtcbiAgaWYgKGV2UG9zdCAhPT0gdW5kZWZpbmVkKSBwcmVmcy5lbmhhbmNlZF92ZXJpZmljYXRpb25fcG9zdCA9IGV2UG9zdDtcbiAgY29uc3QgZXZTdHJpY3QgPSBhd2FpdCBwcm9tcHRCb29sZWFuKGN0eCwgXCJFbmhhbmNlZCB2ZXJpZmljYXRpb24gXHUyMDE0IHN0cmljdCBtb2RlIChmYWlsIG9uIGFueSBpc3N1ZSlcIiwgcHJlZnMuZW5oYW5jZWRfdmVyaWZpY2F0aW9uX3N0cmljdCwgZmFsc2UpO1xuICBpZiAoZXZTdHJpY3QgIT09IHVuZGVmaW5lZCkgcHJlZnMuZW5oYW5jZWRfdmVyaWZpY2F0aW9uX3N0cmljdCA9IGV2U3RyaWN0O1xuXG4gIC8vIHNhZmV0eV9oYXJuZXNzXG4gIGNvbnN0IHNoID0gKHByZWZzLnNhZmV0eV9oYXJuZXNzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkKSA/PyB7fTtcbiAgY29uc3Qgc2hGaWVsZHMgPSBbXG4gICAgeyBrZXk6IFwiZW5hYmxlZFwiLCBsYWJlbDogXCJTYWZldHkgaGFybmVzcyBlbmFibGVkXCIgfSxcbiAgICB7IGtleTogXCJldmlkZW5jZV9jb2xsZWN0aW9uXCIsIGxhYmVsOiBcIkNvbGxlY3QgdG9vbCBldmlkZW5jZVwiIH0sXG4gICAgeyBrZXk6IFwiZmlsZV9jaGFuZ2VfdmFsaWRhdGlvblwiLCBsYWJlbDogXCJWYWxpZGF0ZSBmaWxlIGNoYW5nZSBkZXNjcmlwdGlvbnNcIiB9LFxuICAgIHsga2V5OiBcImV2aWRlbmNlX2Nyb3NzX3JlZmVyZW5jZVwiLCBsYWJlbDogXCJDcm9zcy1yZWZlcmVuY2UgZXZpZGVuY2UgYWNyb3NzIHRvb2xzXCIgfSxcbiAgICB7IGtleTogXCJkZXN0cnVjdGl2ZV9jb21tYW5kX3dhcm5pbmdzXCIsIGxhYmVsOiBcIldhcm4gb24gZGVzdHJ1Y3RpdmUgY29tbWFuZHNcIiB9LFxuICAgIHsga2V5OiBcImNvbnRlbnRfdmFsaWRhdGlvblwiLCBsYWJlbDogXCJWYWxpZGF0ZSB3cml0dGVuIGNvbnRlbnRcIiB9LFxuICAgIHsga2V5OiBcImNoZWNrcG9pbnRzXCIsIGxhYmVsOiBcIkNyZWF0ZSBzYWZldHkgY2hlY2twb2ludHNcIiB9LFxuICAgIHsga2V5OiBcImF1dG9fcm9sbGJhY2tcIiwgbGFiZWw6IFwiQXV0by1yb2xsYmFjayBvbiBzYWZldHkgdmlvbGF0aW9uXCIgfSxcbiAgXSBhcyBjb25zdDtcbiAgZm9yIChjb25zdCBmaWVsZCBvZiBzaEZpZWxkcykge1xuICAgIGNvbnN0IHZhbCA9IGF3YWl0IHByb21wdEJvb2xlYW4oY3R4LCBgU2FmZXR5IGhhcm5lc3MgXHUyMDE0ICR7ZmllbGQubGFiZWx9YCwgc2hbZmllbGQua2V5XSk7XG4gICAgaWYgKHZhbCAhPT0gdW5kZWZpbmVkKSBzaFtmaWVsZC5rZXldID0gdmFsO1xuICB9XG4gIGNvbnN0IGNhcCA9IGF3YWl0IHByb21wdE51bWJlcihjdHgsIFwiU2FmZXR5IGhhcm5lc3MgdGltZW91dCBzY2FsZSBjYXBcIiwgc2gudGltZW91dF9zY2FsZV9jYXApO1xuICBpZiAoY2FwICE9PSB1bmRlZmluZWQgJiYgY2FwICE9PSBcImNsZWFyXCIpIHNoLnRpbWVvdXRfc2NhbGVfY2FwID0gY2FwO1xuICBlbHNlIGlmIChjYXAgPT09IFwiY2xlYXJcIikgZGVsZXRlIHNoLnRpbWVvdXRfc2NhbGVfY2FwO1xuICBpZiAoT2JqZWN0LmtleXMoc2gpLmxlbmd0aCA+IDApIHByZWZzLnNhZmV0eV9oYXJuZXNzID0gc2g7XG4gIGVsc2UgaWYgKHByZWZzLnNhZmV0eV9oYXJuZXNzICE9PSB1bmRlZmluZWQpIGRlbGV0ZSBwcmVmcy5zYWZldHlfaGFybmVzcztcbn1cblxuYXN5bmMgZnVuY3Rpb24gY29uZmlndXJlRGlzY3VzcyhjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LCBwcmVmczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgcHJlcCA9IGF3YWl0IHByb21wdEJvb2xlYW4oY3R4LCBcIkRpc2N1c3MgXHUyMDE0IHJ1biBwcmVwYXJhdGlvbiBwaGFzZVwiLCBwcmVmcy5kaXNjdXNzX3ByZXBhcmF0aW9uLCB0cnVlKTtcbiAgaWYgKHByZXAgIT09IHVuZGVmaW5lZCkgcHJlZnMuZGlzY3Vzc19wcmVwYXJhdGlvbiA9IHByZXA7XG4gIGNvbnN0IHdlYiA9IGF3YWl0IHByb21wdEJvb2xlYW4oY3R4LCBcIkRpc2N1c3MgXHUyMDE0IHdlYiByZXNlYXJjaCBkdXJpbmcgcHJlcGFyYXRpb25cIiwgcHJlZnMuZGlzY3Vzc193ZWJfcmVzZWFyY2gsIHRydWUpO1xuICBpZiAod2ViICE9PSB1bmRlZmluZWQpIHByZWZzLmRpc2N1c3Nfd2ViX3Jlc2VhcmNoID0gd2ViO1xuICBjb25zdCBkZXB0aCA9IGF3YWl0IHByb21wdEVudW0oY3R4LCBcIkRpc2N1c3MgcHJlcGFyYXRpb24gZGVwdGhcIiwgcHJlZnMuZGlzY3Vzc19kZXB0aCwgW1wicXVpY2tcIiwgXCJzdGFuZGFyZFwiLCBcInRob3JvdWdoXCJdLCBcInN0YW5kYXJkXCIpO1xuICBpZiAoZGVwdGggIT09IHVuZGVmaW5lZCkgcHJlZnMuZGlzY3Vzc19kZXB0aCA9IGRlcHRoO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjb25maWd1cmVDb250ZXh0Q29kZWJhc2UoY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCwgcHJlZnM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHNlbCA9IGF3YWl0IHByb21wdEVudW0oY3R4LCBcIkNvbnRleHQgc2VsZWN0aW9uIG1vZGVcIiwgcHJlZnMuY29udGV4dF9zZWxlY3Rpb24sIFtcImZ1bGxcIiwgXCJzbWFydFwiXSk7XG4gIGlmIChzZWwgIT09IHVuZGVmaW5lZCkgcHJlZnMuY29udGV4dF9zZWxlY3Rpb24gPSBzZWw7XG5cbiAgLy8gY29udGV4dF9tYW5hZ2VtZW50IG5lc3RlZFxuICBjb25zdCBjbSA9IChwcmVmcy5jb250ZXh0X21hbmFnZW1lbnQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQpID8/IHt9O1xuICBjb25zdCBtYXNrID0gYXdhaXQgcHJvbXB0Qm9vbGVhbihjdHgsIFwiT2JzZXJ2YXRpb24gbWFza2luZyAoaGlkZSBzdGFsZSB0b29sIG91dHB1dHMpXCIsIGNtLm9ic2VydmF0aW9uX21hc2tpbmcsIHRydWUpO1xuICBpZiAobWFzayAhPT0gdW5kZWZpbmVkKSBjbS5vYnNlcnZhdGlvbl9tYXNraW5nID0gbWFzaztcbiAgY29uc3QgbWFza1R1cm5zID0gYXdhaXQgcHJvbXB0SW50ZWdlcihjdHgsIFwiT2JzZXJ2YXRpb24gbWFzayB0dXJucyAoMVx1MjAxMzUwKVwiLCBjbS5vYnNlcnZhdGlvbl9tYXNrX3R1cm5zLCBcIjhcIik7XG4gIGlmIChtYXNrVHVybnMgIT09IHVuZGVmaW5lZCAmJiBtYXNrVHVybnMgIT09IFwiY2xlYXJcIikgY20ub2JzZXJ2YXRpb25fbWFza190dXJucyA9IG1hc2tUdXJucztcbiAgZWxzZSBpZiAobWFza1R1cm5zID09PSBcImNsZWFyXCIpIGRlbGV0ZSBjbS5vYnNlcnZhdGlvbl9tYXNrX3R1cm5zO1xuICBjb25zdCB0aHJlc2ggPSBhd2FpdCBwcm9tcHROdW1iZXIoY3R4LCBcIkNvbXBhY3Rpb24gdGhyZXNob2xkIHBlcmNlbnQgKDAuNVx1MjAxMzAuOTUpXCIsIGNtLmNvbXBhY3Rpb25fdGhyZXNob2xkX3BlcmNlbnQsIFwiMC43MFwiKTtcbiAgaWYgKHRocmVzaCAhPT0gdW5kZWZpbmVkICYmIHRocmVzaCAhPT0gXCJjbGVhclwiKSBjbS5jb21wYWN0aW9uX3RocmVzaG9sZF9wZXJjZW50ID0gdGhyZXNoO1xuICBlbHNlIGlmICh0aHJlc2ggPT09IFwiY2xlYXJcIikgZGVsZXRlIGNtLmNvbXBhY3Rpb25fdGhyZXNob2xkX3BlcmNlbnQ7XG4gIGNvbnN0IHRvb2xNYXggPSBhd2FpdCBwcm9tcHRJbnRlZ2VyKGN0eCwgXCJUb29sIHJlc3VsdCBtYXggY2hhcnMgKDIwMFx1MjAxMzEwMDAwKVwiLCBjbS50b29sX3Jlc3VsdF9tYXhfY2hhcnMsIFwiODAwXCIpO1xuICBpZiAodG9vbE1heCAhPT0gdW5kZWZpbmVkICYmIHRvb2xNYXggIT09IFwiY2xlYXJcIikgY20udG9vbF9yZXN1bHRfbWF4X2NoYXJzID0gdG9vbE1heDtcbiAgZWxzZSBpZiAodG9vbE1heCA9PT0gXCJjbGVhclwiKSBkZWxldGUgY20udG9vbF9yZXN1bHRfbWF4X2NoYXJzO1xuICBpZiAoT2JqZWN0LmtleXMoY20pLmxlbmd0aCA+IDApIHByZWZzLmNvbnRleHRfbWFuYWdlbWVudCA9IGNtO1xuICBlbHNlIGlmIChwcmVmcy5jb250ZXh0X21hbmFnZW1lbnQgIT09IHVuZGVmaW5lZCkgZGVsZXRlIHByZWZzLmNvbnRleHRfbWFuYWdlbWVudDtcblxuICBjb25zdCBvdmVycmlkZSA9IGF3YWl0IHByb21wdEludGVnZXIoY3R4LCBcIkNvbnRleHQgd2luZG93IG92ZXJyaWRlICh0b2tlbnMsIGJsYW5rID0gdXNlIG1vZGVsIGRlZmF1bHQpXCIsIHByZWZzLmNvbnRleHRfd2luZG93X292ZXJyaWRlKTtcbiAgYXBwbHlOdW1iZXIocHJlZnMsIFwiY29udGV4dF93aW5kb3dfb3ZlcnJpZGVcIiwgb3ZlcnJpZGUpO1xuXG4gIC8vIGNvZGViYXNlIG1hcFxuICBjb25zdCBjYiA9IChwcmVmcy5jb2RlYmFzZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZCkgPz8ge307XG4gIGNvbnN0IGN1cnJlbnRFeGNsdWRlcyA9IEFycmF5LmlzQXJyYXkoY2IuZXhjbHVkZV9wYXR0ZXJucykgPyBjYi5leGNsdWRlX3BhdHRlcm5zIGFzIHN0cmluZ1tdIDogW107XG4gIGNvbnN0IGV4Y2x1ZGVzSW5wdXQgPSBhd2FpdCBjdHgudWkuaW5wdXQoXG4gICAgYENvZGViYXNlIG1hcCBcdTIwMTQgZXh0cmEgZXhjbHVkZSBwYXR0ZXJucyAoY29tbWEtIG9yIG5ld2xpbmUtc2VwYXJhdGVkLCBibGFuayB0byBrZWVwKSR7Y3VycmVudEV4Y2x1ZGVzLmxlbmd0aCA/IGAgKGN1cnJlbnQ6ICR7Y3VycmVudEV4Y2x1ZGVzLmpvaW4oXCIsIFwiKX0pYCA6IFwiXCJ9OmAsXG4gICAgY3VycmVudEV4Y2x1ZGVzLmpvaW4oXCIsIFwiKSxcbiAgKTtcbiAgaWYgKGV4Y2x1ZGVzSW5wdXQgIT09IG51bGwgJiYgZXhjbHVkZXNJbnB1dCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgY29uc3QgcGFyc2VkID0gcGFyc2VTdHJpbmdMaXN0KGV4Y2x1ZGVzSW5wdXQpO1xuICAgIGlmIChwYXJzZWQubGVuZ3RoID4gMCkgY2IuZXhjbHVkZV9wYXR0ZXJucyA9IHBhcnNlZDtcbiAgICBlbHNlIGlmIChjdXJyZW50RXhjbHVkZXMubGVuZ3RoID4gMCAmJiBleGNsdWRlc0lucHV0LnRyaW0oKSA9PT0gXCJcIikgZGVsZXRlIGNiLmV4Y2x1ZGVfcGF0dGVybnM7XG4gIH1cbiAgY29uc3QgbWF4RmlsZXMgPSBhd2FpdCBwcm9tcHRJbnRlZ2VyKGN0eCwgXCJDb2RlYmFzZSBtYXAgXHUyMDE0IG1heCBmaWxlc1wiLCBjYi5tYXhfZmlsZXMsIFwiNTAwXCIpO1xuICBpZiAobWF4RmlsZXMgIT09IHVuZGVmaW5lZCAmJiBtYXhGaWxlcyAhPT0gXCJjbGVhclwiKSBjYi5tYXhfZmlsZXMgPSBtYXhGaWxlcztcbiAgZWxzZSBpZiAobWF4RmlsZXMgPT09IFwiY2xlYXJcIikgZGVsZXRlIGNiLm1heF9maWxlcztcbiAgY29uc3QgY29sbGFwc2UgPSBhd2FpdCBwcm9tcHRJbnRlZ2VyKGN0eCwgXCJDb2RlYmFzZSBtYXAgXHUyMDE0IGNvbGxhcHNlIHRocmVzaG9sZFwiLCBjYi5jb2xsYXBzZV90aHJlc2hvbGQsIFwiMjBcIik7XG4gIGlmIChjb2xsYXBzZSAhPT0gdW5kZWZpbmVkICYmIGNvbGxhcHNlICE9PSBcImNsZWFyXCIpIGNiLmNvbGxhcHNlX3RocmVzaG9sZCA9IGNvbGxhcHNlO1xuICBlbHNlIGlmIChjb2xsYXBzZSA9PT0gXCJjbGVhclwiKSBkZWxldGUgY2IuY29sbGFwc2VfdGhyZXNob2xkO1xuICBpZiAoT2JqZWN0LmtleXMoY2IpLmxlbmd0aCA+IDApIHByZWZzLmNvZGViYXNlID0gY2I7XG4gIGVsc2UgaWYgKHByZWZzLmNvZGViYXNlICE9PSB1bmRlZmluZWQpIGRlbGV0ZSBwcmVmcy5jb2RlYmFzZTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY29uZmlndXJlSG9va3MoY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCwgcHJlZnM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogUHJvbWlzZTx2b2lkPiB7XG4gIC8vIHJlYWN0aXZlX2V4ZWN1dGlvblxuICBjb25zdCByZSA9IChwcmVmcy5yZWFjdGl2ZV9leGVjdXRpb24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQpID8/IHt9O1xuICBjb25zdCByZUVuYWJsZWQgPSBhd2FpdCBwcm9tcHRCb29sZWFuKGN0eCwgXCJSZWFjdGl2ZSAoZ3JhcGgtcGFyYWxsZWwpIHRhc2sgZXhlY3V0aW9uXCIsIHJlLmVuYWJsZWQsIGZhbHNlKTtcbiAgaWYgKHJlRW5hYmxlZCAhPT0gdW5kZWZpbmVkKSByZS5lbmFibGVkID0gcmVFbmFibGVkO1xuICBjb25zdCByZU1heCA9IGF3YWl0IHByb21wdEludGVnZXIoY3R4LCBcIlJlYWN0aXZlIG1heCBwYXJhbGxlbCAoMVx1MjAxMzgpXCIsIHJlLm1heF9wYXJhbGxlbCwgXCIzXCIpO1xuICBpZiAocmVNYXggIT09IHVuZGVmaW5lZCAmJiByZU1heCAhPT0gXCJjbGVhclwiKSByZS5tYXhfcGFyYWxsZWwgPSBNYXRoLm1heCgxLCBNYXRoLm1pbig4LCByZU1heCkpO1xuICBlbHNlIGlmIChyZU1heCA9PT0gXCJjbGVhclwiKSBkZWxldGUgcmUubWF4X3BhcmFsbGVsO1xuICBjb25zdCByZU1vZGVsID0gYXdhaXQgcHJvbXB0U3RyaW5nKGN0eCwgXCJSZWFjdGl2ZSBzdWJhZ2VudCBtb2RlbCBvdmVycmlkZVwiLCByZS5zdWJhZ2VudF9tb2RlbCk7XG4gIGlmIChyZU1vZGVsICE9PSB1bmRlZmluZWQpIHtcbiAgICBpZiAocmVNb2RlbCkgcmUuc3ViYWdlbnRfbW9kZWwgPSByZU1vZGVsO1xuICAgIGVsc2UgZGVsZXRlIHJlLnN1YmFnZW50X21vZGVsO1xuICB9XG4gIGlmIChPYmplY3Qua2V5cyhyZSkubGVuZ3RoID4gMCkge1xuICAgIC8vIGlzb2xhdGlvbl9tb2RlIGlzIGN1cnJlbnRseSBvbmx5IFwic2FtZS10cmVlXCI7IHNldCBpdCB3aGVuIGVuYWJsZWQgdG8gc2F0aXNmeSB0aGUgc2NoZW1hLlxuICAgIGlmIChyZS5lbmFibGVkID09PSB0cnVlICYmICFyZS5pc29sYXRpb25fbW9kZSkgcmUuaXNvbGF0aW9uX21vZGUgPSBcInNhbWUtdHJlZVwiO1xuICAgIHByZWZzLnJlYWN0aXZlX2V4ZWN1dGlvbiA9IHJlO1xuICB9IGVsc2UgaWYgKHByZWZzLnJlYWN0aXZlX2V4ZWN1dGlvbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgZGVsZXRlIHByZWZzLnJlYWN0aXZlX2V4ZWN1dGlvbjtcbiAgfVxuXG4gIC8vIGdhdGVfZXZhbHVhdGlvblxuICBjb25zdCBnZSA9IChwcmVmcy5nYXRlX2V2YWx1YXRpb24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQpID8/IHt9O1xuICBjb25zdCBnZUVuYWJsZWQgPSBhd2FpdCBwcm9tcHRCb29sZWFuKGN0eCwgXCJQYXJhbGxlbCBnYXRlIGV2YWx1YXRpb24gZHVyaW5nIHBsYW5uaW5nXCIsIGdlLmVuYWJsZWQsIGZhbHNlKTtcbiAgaWYgKGdlRW5hYmxlZCAhPT0gdW5kZWZpbmVkKSBnZS5lbmFibGVkID0gZ2VFbmFibGVkO1xuICBjb25zdCBjdXJyZW50U2xpY2VHYXRlcyA9IEFycmF5LmlzQXJyYXkoZ2Uuc2xpY2VfZ2F0ZXMpID8gZ2Uuc2xpY2VfZ2F0ZXMgYXMgc3RyaW5nW10gOiBbXTtcbiAgY29uc3Qgc2dJbnB1dCA9IGF3YWl0IGN0eC51aS5pbnB1dChcbiAgICBgU2xpY2UgZ2F0ZXMgdG8gZXZhbHVhdGUgKGNvbW1hLXNlcGFyYXRlZCwgYmxhbmsga2VlcHMpJHtjdXJyZW50U2xpY2VHYXRlcy5sZW5ndGggPyBgIChjdXJyZW50OiAke2N1cnJlbnRTbGljZUdhdGVzLmpvaW4oXCIsIFwiKX0pYCA6IFwiIChkZWZhdWx0OiBRMyxRNClcIn06YCxcbiAgICBjdXJyZW50U2xpY2VHYXRlcy5qb2luKFwiLCBcIiksXG4gICk7XG4gIGlmIChzZ0lucHV0ICE9PSBudWxsICYmIHNnSW5wdXQgIT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlU3RyaW5nTGlzdChzZ0lucHV0KTtcbiAgICBpZiAocGFyc2VkLmxlbmd0aCA+IDApIGdlLnNsaWNlX2dhdGVzID0gcGFyc2VkO1xuICAgIGVsc2UgaWYgKGN1cnJlbnRTbGljZUdhdGVzLmxlbmd0aCA+IDAgJiYgc2dJbnB1dC50cmltKCkgPT09IFwiXCIpIGRlbGV0ZSBnZS5zbGljZV9nYXRlcztcbiAgfVxuICBjb25zdCBnZVRhc2sgPSBhd2FpdCBwcm9tcHRCb29sZWFuKGN0eCwgXCJFdmFsdWF0ZSB0YXNrLWxldmVsIGdhdGVzIChRNS9RNi9RNylcIiwgZ2UudGFza19nYXRlcywgdHJ1ZSk7XG4gIGlmIChnZVRhc2sgIT09IHVuZGVmaW5lZCkgZ2UudGFza19nYXRlcyA9IGdlVGFzaztcbiAgaWYgKE9iamVjdC5rZXlzKGdlKS5sZW5ndGggPiAwKSBwcmVmcy5nYXRlX2V2YWx1YXRpb24gPSBnZTtcbiAgZWxzZSBpZiAocHJlZnMuZ2F0ZV9ldmFsdWF0aW9uICE9PSB1bmRlZmluZWQpIGRlbGV0ZSBwcmVmcy5nYXRlX2V2YWx1YXRpb247XG5cbiAgLy8gcG9zdF91bml0X2hvb2tzW11cbiAgYXdhaXQgY29uZmlndXJlSG9va0xpc3QoY3R4LCBwcmVmcywgXCJwb3N0X3VuaXRfaG9va3NcIiwgXCJQb3N0LXVuaXQgaG9va3NcIiwgXCJhZnRlclwiKTtcblxuICAvLyBwcmVfZGlzcGF0Y2hfaG9va3NbXVxuICBhd2FpdCBjb25maWd1cmVIb29rTGlzdChjdHgsIHByZWZzLCBcInByZV9kaXNwYXRjaF9ob29rc1wiLCBcIlByZS1kaXNwYXRjaCBob29rc1wiLCBcImJlZm9yZVwiKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY29uZmlndXJlSG9va0xpc3QoXG4gIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsXG4gIHByZWZzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAga2V5OiBcInBvc3RfdW5pdF9ob29rc1wiIHwgXCJwcmVfZGlzcGF0Y2hfaG9va3NcIixcbiAgbGFiZWw6IHN0cmluZyxcbiAgdHJpZ2dlckZpZWxkOiBcImFmdGVyXCIgfCBcImJlZm9yZVwiLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIHR5cGUgSG9vayA9IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICBsZXQgaG9va3M6IEhvb2tbXSA9IEFycmF5LmlzQXJyYXkocHJlZnNba2V5XSkgPyBbLi4ucHJlZnNba2V5XSBhcyBIb29rW11dIDogW107XG4gIHdoaWxlICh0cnVlKSB7XG4gICAgY29uc3Qgc3VtbWFyeSA9IGhvb2tzLmxlbmd0aCA9PT0gMCA/IFwiKG5vbmUpXCIgOiBgJHtob29rcy5sZW5ndGh9IGhvb2socylgO1xuICAgIGNvbnN0IGxhYmVscyA9IGhvb2tzLm1hcCgoaCwgaSkgPT4gYCMke2kgKyAxfSAke2gubmFtZSA/PyBcIih1bm5hbWVkKVwifSR7aC5lbmFibGVkID09PSBmYWxzZSA/IFwiIFtkaXNhYmxlZF1cIiA6IFwiXCJ9YCk7XG4gICAgY29uc3QgY2hvaWNlID0gYXdhaXQgY3R4LnVpLnNlbGVjdChgJHtsYWJlbH0gXHUyMDE0ICR7c3VtbWFyeX1gLCBbLi4ubGFiZWxzLCBcIkFkZCBob29rXCIsIFwiRG9uZVwiXSk7XG4gICAgY29uc3QgcGljayA9IHR5cGVvZiBjaG9pY2UgPT09IFwic3RyaW5nXCIgPyBjaG9pY2UgOiBcIlwiO1xuICAgIGlmICghcGljayB8fCBwaWNrID09PSBcIkRvbmVcIikgYnJlYWs7XG4gICAgaWYgKHBpY2sgPT09IFwiQWRkIGhvb2tcIikge1xuICAgICAgY29uc3QgbmFtZUlucHV0ID0gYXdhaXQgY3R4LnVpLmlucHV0KFwiSG9vayBuYW1lICh1bmlxdWUgaWRlbnRpZmllcik6XCIsIFwiXCIpO1xuICAgICAgY29uc3QgbmFtZSA9IHR5cGVvZiBuYW1lSW5wdXQgPT09IFwic3RyaW5nXCIgPyBuYW1lSW5wdXQudHJpbSgpIDogXCJcIjtcbiAgICAgIGlmICghbmFtZSkgY29udGludWU7XG4gICAgICBjb25zdCB0cmlnZ2VySW5wdXQgPSBhd2FpdCBjdHgudWkuaW5wdXQoXG4gICAgICAgIGBVbml0IHR5cGVzIHRoaXMgaG9vayAke3RyaWdnZXJGaWVsZCA9PT0gXCJhZnRlclwiID8gXCJydW5zIGFmdGVyXCIgOiBcImludGVyY2VwdHMgYmVmb3JlXCJ9IChjb21tYS1zZXBhcmF0ZWQsIGUuZy4gZXhlY3V0ZS10YXNrKTpgLFxuICAgICAgICBcIlwiLFxuICAgICAgKTtcbiAgICAgIGNvbnN0IHRyaWdnZXJzID0gdHJpZ2dlcklucHV0ID8gcGFyc2VTdHJpbmdMaXN0KHRyaWdnZXJJbnB1dCkgOiBbXTtcbiAgICAgIGlmICh0cmlnZ2Vycy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgY3R4LnVpLm5vdGlmeShcIkhvb2sgZGlzY2FyZGVkIFx1MjAxNCB0cmlnZ2VyIGxpc3QgY2Fubm90IGJlIGVtcHR5LlwiLCBcIndhcm5pbmdcIik7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgY29uc3QgaG9vazogSG9vayA9IHsgbmFtZSwgW3RyaWdnZXJGaWVsZF06IHRyaWdnZXJzLCBlbmFibGVkOiB0cnVlIH07XG4gICAgICBpZiAoa2V5ID09PSBcInBvc3RfdW5pdF9ob29rc1wiKSB7XG4gICAgICAgIGNvbnN0IHByb21wdElucHV0ID0gYXdhaXQgY3R4LnVpLmlucHV0KFwiSG9vayBwcm9tcHQgKHNlbnQgdG8gTExNOyBzdXBwb3J0cyB7bWlsZXN0b25lSWR9LCB7c2xpY2VJZH0sIHt0YXNrSWR9KTpcIiwgXCJcIik7XG4gICAgICAgIGlmIChwcm9tcHRJbnB1dCkgaG9vay5wcm9tcHQgPSBwcm9tcHRJbnB1dDtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbnN0IGFjdGlvbkNob2ljZSA9IGF3YWl0IGN0eC51aS5zZWxlY3QoXCJBY3Rpb246XCIsIFtcIm1vZGlmeVwiLCBcInNraXBcIiwgXCJyZXBsYWNlXCJdKTtcbiAgICAgICAgaWYgKGFjdGlvbkNob2ljZSkgaG9vay5hY3Rpb24gPSBhY3Rpb25DaG9pY2U7XG4gICAgICB9XG4gICAgICBob29rcy5wdXNoKGhvb2spO1xuICAgIH0gZWxzZSBpZiAocGljay5zdGFydHNXaXRoKFwiI1wiKSkge1xuICAgICAgY29uc3QgaWR4ID0gTnVtYmVyKHBpY2suc2xpY2UoMSwgcGljay5pbmRleE9mKFwiIFwiKSkpIC0gMTtcbiAgICAgIGlmIChpZHggPCAwIHx8IGlkeCA+PSBob29rcy5sZW5ndGgpIGNvbnRpbnVlO1xuICAgICAgY29uc3QgZWRpdENob2ljZSA9IGF3YWl0IGN0eC51aS5zZWxlY3QoXG4gICAgICAgIGBIb29rICMke2lkeCArIDF9OiAke2hvb2tzW2lkeF0ubmFtZSA/PyBcIlwifWAsXG4gICAgICAgIFtcIlRvZ2dsZSBlbmFibGVkXCIsIFwiRWRpdCBwcm9tcHQvYWN0aW9uXCIsIFwiRWRpdCBtb2RlbCBvdmVycmlkZVwiLCBcIkRlbGV0ZSBob29rXCIsIFwiQ2FuY2VsXCJdLFxuICAgICAgKTtcbiAgICAgIGNvbnN0IGVjID0gdHlwZW9mIGVkaXRDaG9pY2UgPT09IFwic3RyaW5nXCIgPyBlZGl0Q2hvaWNlIDogXCJcIjtcbiAgICAgIGlmICghZWMgfHwgZWMgPT09IFwiQ2FuY2VsXCIpIGNvbnRpbnVlO1xuICAgICAgaWYgKGVjID09PSBcIkRlbGV0ZSBob29rXCIpIHtcbiAgICAgICAgaG9va3MgPSBob29rcy5maWx0ZXIoKF8sIGkpID0+IGkgIT09IGlkeCk7XG4gICAgICB9IGVsc2UgaWYgKGVjID09PSBcIlRvZ2dsZSBlbmFibGVkXCIpIHtcbiAgICAgICAgaG9va3NbaWR4XS5lbmFibGVkID0gaG9va3NbaWR4XS5lbmFibGVkID09PSBmYWxzZTtcbiAgICAgIH0gZWxzZSBpZiAoZWMgPT09IFwiRWRpdCBwcm9tcHQvYWN0aW9uXCIpIHtcbiAgICAgICAgaWYgKGtleSA9PT0gXCJwb3N0X3VuaXRfaG9va3NcIikge1xuICAgICAgICAgIGNvbnN0IG5ld1Byb21wdCA9IGF3YWl0IHByb21wdFN0cmluZyhjdHgsIFwiUHJvbXB0XCIsIGhvb2tzW2lkeF0ucHJvbXB0KTtcbiAgICAgICAgICBpZiAobmV3UHJvbXB0ICE9PSB1bmRlZmluZWQgJiYgbmV3UHJvbXB0KSBob29rc1tpZHhdLnByb21wdCA9IG5ld1Byb21wdDtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBjb25zdCBuZXdBY3Rpb24gPSBhd2FpdCBwcm9tcHRFbnVtKGN0eCwgXCJBY3Rpb25cIiwgaG9va3NbaWR4XS5hY3Rpb24sIFtcIm1vZGlmeVwiLCBcInNraXBcIiwgXCJyZXBsYWNlXCJdKTtcbiAgICAgICAgICBpZiAobmV3QWN0aW9uICE9PSB1bmRlZmluZWQpIGhvb2tzW2lkeF0uYWN0aW9uID0gbmV3QWN0aW9uO1xuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKGVjID09PSBcIkVkaXQgbW9kZWwgb3ZlcnJpZGVcIikge1xuICAgICAgICBjb25zdCBtID0gYXdhaXQgcHJvbXB0U3RyaW5nKGN0eCwgXCJNb2RlbCBvdmVycmlkZSAoYmxhbmsgdG8gY2xlYXIpXCIsIGhvb2tzW2lkeF0ubW9kZWwpO1xuICAgICAgICBpZiAobSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgaWYgKG0pIGhvb2tzW2lkeF0ubW9kZWwgPSBtO1xuICAgICAgICAgIGVsc2UgZGVsZXRlIGhvb2tzW2lkeF0ubW9kZWw7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgaWYgKGhvb2tzLmxlbmd0aCA+IDApIHByZWZzW2tleV0gPSBob29rcztcbiAgZWxzZSBpZiAocHJlZnNba2V5XSAhPT0gdW5kZWZpbmVkKSBkZWxldGUgcHJlZnNba2V5XTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY29uZmlndXJlVW9LKGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsIHByZWZzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB1b2sgPSAocHJlZnMudW9rIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkKSA/PyB7fTtcblxuICBjb25zdCBlbmFibGVkID0gYXdhaXQgcHJvbXB0Qm9vbGVhbihjdHgsIFwiVW9LIChVbmlmaWVkIE9yY2hlc3RyYXRpb24gS2VybmVsKSBlbmFibGVkXCIsIHVvay5lbmFibGVkKTtcbiAgaWYgKGVuYWJsZWQgIT09IHVuZGVmaW5lZCkgdW9rLmVuYWJsZWQgPSBlbmFibGVkO1xuXG4gIGNvbnN0IHN1YnNlY3Rpb25zID0gW1wibGVnYWN5X2ZhbGxiYWNrXCIsIFwiZ2F0ZXNcIiwgXCJtb2RlbF9wb2xpY3lcIiwgXCJleGVjdXRpb25fZ3JhcGhcIiwgXCJhdWRpdF91bmlmaWVkXCIsIFwicGxhbl92MlwiXSBhcyBjb25zdDtcbiAgZm9yIChjb25zdCBzdWIgb2Ygc3Vic2VjdGlvbnMpIHtcbiAgICBjb25zdCBleGlzdGluZyA9ICh1b2tbc3ViXSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZCkgPz8ge307XG4gICAgY29uc3QgdmFsID0gYXdhaXQgcHJvbXB0Qm9vbGVhbihjdHgsIGBVb0sgXHUyMDE0ICR7c3ViLnJlcGxhY2UoL18vZywgXCIgXCIpfSBlbmFibGVkYCwgZXhpc3RpbmcuZW5hYmxlZCk7XG4gICAgaWYgKHZhbCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBleGlzdGluZy5lbmFibGVkID0gdmFsO1xuICAgICAgdW9rW3N1Yl0gPSBleGlzdGluZztcbiAgICB9IGVsc2UgaWYgKE9iamVjdC5rZXlzKGV4aXN0aW5nKS5sZW5ndGggPiAwKSB7XG4gICAgICB1b2tbc3ViXSA9IGV4aXN0aW5nO1xuICAgIH1cbiAgfVxuXG4gIC8vIGdpdG9wcyBoYXMgZXh0cmEgZmllbGRzXG4gIGNvbnN0IGdpdG9wcyA9ICh1b2suZ2l0b3BzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkKSA/PyB7fTtcbiAgY29uc3QgZ2l0b3BzRW5hYmxlZCA9IGF3YWl0IHByb21wdEJvb2xlYW4oY3R4LCBcIlVvSyBcdTIwMTQgZ2l0b3BzIGVuYWJsZWRcIiwgZ2l0b3BzLmVuYWJsZWQpO1xuICBpZiAoZ2l0b3BzRW5hYmxlZCAhPT0gdW5kZWZpbmVkKSBnaXRvcHMuZW5hYmxlZCA9IGdpdG9wc0VuYWJsZWQ7XG4gIGNvbnN0IHR1cm5BY3Rpb24gPSBhd2FpdCBwcm9tcHRFbnVtKGN0eCwgXCJVb0sgZ2l0b3BzIFx1MjAxNCB0dXJuIGFjdGlvblwiLCBnaXRvcHMudHVybl9hY3Rpb24sIFtcImNvbW1pdFwiLCBcInNuYXBzaG90XCIsIFwic3RhdHVzLW9ubHlcIl0pO1xuICBpZiAodHVybkFjdGlvbiAhPT0gdW5kZWZpbmVkKSBnaXRvcHMudHVybl9hY3Rpb24gPSB0dXJuQWN0aW9uO1xuICBjb25zdCB0dXJuUHVzaCA9IGF3YWl0IHByb21wdEJvb2xlYW4oY3R4LCBcIlVvSyBnaXRvcHMgXHUyMDE0IHR1cm4gcHVzaFwiLCBnaXRvcHMudHVybl9wdXNoKTtcbiAgaWYgKHR1cm5QdXNoICE9PSB1bmRlZmluZWQpIGdpdG9wcy50dXJuX3B1c2ggPSB0dXJuUHVzaDtcbiAgaWYgKE9iamVjdC5rZXlzKGdpdG9wcykubGVuZ3RoID4gMCkgdW9rLmdpdG9wcyA9IGdpdG9wcztcblxuICBpZiAoT2JqZWN0LmtleXModW9rKS5sZW5ndGggPiAwKSBwcmVmcy51b2sgPSB1b2s7XG4gIGVsc2UgaWYgKHByZWZzLnVvayAhPT0gdW5kZWZpbmVkKSBkZWxldGUgcHJlZnMudW9rO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjb25maWd1cmVJbnRlZ3JhdGlvbnMoY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCwgcHJlZnM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogUHJvbWlzZTx2b2lkPiB7XG4gIC8vIExhbmd1YWdlXG4gIGNvbnN0IGxhbmcgPSBhd2FpdCBwcm9tcHRTdHJpbmcoY3R4LCBcIlJlc3BvbnNlIGxhbmd1YWdlIChlLmcuIENoaW5lc2UsIHpoLCBHZXJtYW4gXHUyMDE0IGJsYW5rIHRvIGNsZWFyKVwiLCBwcmVmcy5sYW5ndWFnZSk7XG4gIGlmIChsYW5nICE9PSB1bmRlZmluZWQpIHtcbiAgICBpZiAobGFuZykgcHJlZnMubGFuZ3VhZ2UgPSBsYW5nO1xuICAgIGVsc2UgZGVsZXRlIHByZWZzLmxhbmd1YWdlO1xuICB9XG5cbiAgLy8gU2VhcmNoIHByb3ZpZGVyXG4gIGNvbnN0IHNlYXJjaCA9IGF3YWl0IHByb21wdEVudW0oXG4gICAgY3R4LFxuICAgIFwiU2VhcmNoIHByb3ZpZGVyXCIsXG4gICAgcHJlZnMuc2VhcmNoX3Byb3ZpZGVyLFxuICAgIFtcImF1dG9cIiwgXCJicmF2ZVwiLCBcInRhdmlseVwiLCBcIm9sbGFtYVwiLCBcIm5hdGl2ZVwiXSxcbiAgICBcImF1dG9cIixcbiAgKTtcbiAgaWYgKHNlYXJjaCAhPT0gdW5kZWZpbmVkKSBwcmVmcy5zZWFyY2hfcHJvdmlkZXIgPSBzZWFyY2g7XG5cbiAgLy8gY211eFxuICBjb25zdCBjbXV4ID0gKHByZWZzLmNtdXggYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQpID8/IHt9O1xuICBmb3IgKGNvbnN0IGZpZWxkIG9mIFtcImVuYWJsZWRcIiwgXCJub3RpZmljYXRpb25zXCIsIFwic2lkZWJhclwiLCBcInNwbGl0c1wiLCBcImJyb3dzZXJcIl0gYXMgY29uc3QpIHtcbiAgICBjb25zdCB2YWwgPSBhd2FpdCBwcm9tcHRCb29sZWFuKGN0eCwgYGNtdXggXHUyMDE0ICR7ZmllbGR9YCwgY211eFtmaWVsZF0pO1xuICAgIGlmICh2YWwgIT09IHVuZGVmaW5lZCkgY211eFtmaWVsZF0gPSB2YWw7XG4gIH1cbiAgaWYgKE9iamVjdC5rZXlzKGNtdXgpLmxlbmd0aCA+IDApIHByZWZzLmNtdXggPSBjbXV4O1xuICBlbHNlIGlmIChwcmVmcy5jbXV4ICE9PSB1bmRlZmluZWQpIGRlbGV0ZSBwcmVmcy5jbXV4O1xuXG4gIC8vIHJlbW90ZV9xdWVzdGlvbnNcbiAgYXdhaXQgY29uZmlndXJlUmVtb3RlUXVlc3Rpb25zKGN0eCwgcHJlZnMpO1xuXG4gIC8vIGdpdGh1YiBzeW5jXG4gIGF3YWl0IGNvbmZpZ3VyZUdpdEh1YlN5bmMoY3R4LCBwcmVmcyk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNvbmZpZ3VyZVJlbW90ZVF1ZXN0aW9ucyhjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LCBwcmVmczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgZXhpc3RpbmcgPSAocHJlZnMucmVtb3RlX3F1ZXN0aW9ucyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZCkgPz8ge307XG4gIGNvbnN0IGNoYW5uZWwgPSBhd2FpdCBwcm9tcHRFbnVtKGN0eCwgXCJSZW1vdGUgcXVlc3Rpb25zIGNoYW5uZWxcIiwgZXhpc3RpbmcuY2hhbm5lbCwgW1wic2xhY2tcIiwgXCJkaXNjb3JkXCIsIFwidGVsZWdyYW1cIl0pO1xuICBjb25zdCBjaGFubmVsSWQgPSBhd2FpdCBwcm9tcHRTdHJpbmcoY3R4LCBcIlJlbW90ZSBxdWVzdGlvbnMgY2hhbm5lbF9pZFwiLCBleGlzdGluZy5jaGFubmVsX2lkKTtcbiAgY29uc3QgdGltZW91dCA9IGF3YWl0IHByb21wdEludGVnZXIoY3R4LCBcIlJlbW90ZSBxdWVzdGlvbnMgdGltZW91dCAobWludXRlcywgMVx1MjAxMzMwKVwiLCBleGlzdGluZy50aW1lb3V0X21pbnV0ZXMsIFwiMTBcIik7XG4gIGNvbnN0IHBvbGwgPSBhd2FpdCBwcm9tcHRJbnRlZ2VyKGN0eCwgXCJSZW1vdGUgcXVlc3Rpb25zIHBvbGwgaW50ZXJ2YWwgKHNlY29uZHMsIDJcdTIwMTMzMClcIiwgZXhpc3RpbmcucG9sbF9pbnRlcnZhbF9zZWNvbmRzLCBcIjVcIik7XG5cbiAgaWYgKGNoYW5uZWwgIT09IHVuZGVmaW5lZCkgZXhpc3RpbmcuY2hhbm5lbCA9IGNoYW5uZWw7XG4gIGlmIChjaGFubmVsSWQgIT09IHVuZGVmaW5lZCkge1xuICAgIGlmIChjaGFubmVsSWQpIGV4aXN0aW5nLmNoYW5uZWxfaWQgPSBjaGFubmVsSWQ7XG4gICAgZWxzZSBkZWxldGUgZXhpc3RpbmcuY2hhbm5lbF9pZDtcbiAgfVxuICBhcHBseU51bWJlcihleGlzdGluZywgXCJ0aW1lb3V0X21pbnV0ZXNcIiwgdGltZW91dCk7XG4gIGFwcGx5TnVtYmVyKGV4aXN0aW5nLCBcInBvbGxfaW50ZXJ2YWxfc2Vjb25kc1wiLCBwb2xsKTtcblxuICAvLyBSZXF1aXJlZCBwYWlyOiBjaGFubmVsICsgY2hhbm5lbF9pZC4gSWYgZWl0aGVyIGlzIG1pc3NpbmcsIGtlZXAgd2hhdGV2ZXIgZXhpc3RlZCB1bmNoYW5nZWQuXG4gIGlmIChleGlzdGluZy5jaGFubmVsICYmIGV4aXN0aW5nLmNoYW5uZWxfaWQpIHtcbiAgICBwcmVmcy5yZW1vdGVfcXVlc3Rpb25zID0gZXhpc3Rpbmc7XG4gIH0gZWxzZSBpZiAoIWV4aXN0aW5nLmNoYW5uZWwgJiYgIWV4aXN0aW5nLmNoYW5uZWxfaWQpIHtcbiAgICBpZiAocHJlZnMucmVtb3RlX3F1ZXN0aW9ucyAhPT0gdW5kZWZpbmVkKSBkZWxldGUgcHJlZnMucmVtb3RlX3F1ZXN0aW9ucztcbiAgfSBlbHNlIHtcbiAgICAvLyBQYXJ0aWFsIGNvbmZpZyBcdTIwMTQgaG9sZCBpdCBzbyB1c2VyIGNhbiBmaW5pc2gsIGJ1dCB3YXJuLlxuICAgIGN0eC51aS5ub3RpZnkoXCJyZW1vdGVfcXVlc3Rpb25zIHJlcXVpcmVzIGJvdGggY2hhbm5lbCBhbmQgY2hhbm5lbF9pZDsga2VlcGluZyBwYXJ0aWFsIGNvbmZpZy5cIiwgXCJ3YXJuaW5nXCIpO1xuICAgIHByZWZzLnJlbW90ZV9xdWVzdGlvbnMgPSBleGlzdGluZztcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBjb25maWd1cmVHaXRIdWJTeW5jKGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsIHByZWZzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBnaCA9IChwcmVmcy5naXRodWIgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQpID8/IHt9O1xuICBjb25zdCBlbmFibGVkID0gYXdhaXQgcHJvbXB0Qm9vbGVhbihjdHgsIFwiR2l0SHViIHN5bmMgZW5hYmxlZFwiLCBnaC5lbmFibGVkLCBmYWxzZSk7XG4gIGlmIChlbmFibGVkICE9PSB1bmRlZmluZWQpIGdoLmVuYWJsZWQgPSBlbmFibGVkO1xuICBjb25zdCByZXBvID0gYXdhaXQgcHJvbXB0U3RyaW5nKGN0eCwgXCJHaXRIdWIgcmVwbyAob3duZXIvcmVwbywgYmxhbmsgPSBhdXRvLWRldGVjdCBmcm9tIGdpdCByZW1vdGUpXCIsIGdoLnJlcG8pO1xuICBpZiAocmVwbyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgaWYgKHJlcG8pIGdoLnJlcG8gPSByZXBvO1xuICAgIGVsc2UgZGVsZXRlIGdoLnJlcG87XG4gIH1cbiAgY29uc3QgcHJvamVjdCA9IGF3YWl0IHByb21wdEludGVnZXIoY3R4LCBcIkdpdEh1YiBQcm9qZWN0cyB2MiBudW1iZXIgKGJsYW5rID0gbm9uZSlcIiwgZ2gucHJvamVjdCk7XG4gIGlmIChwcm9qZWN0ICE9PSB1bmRlZmluZWQgJiYgcHJvamVjdCAhPT0gXCJjbGVhclwiKSBnaC5wcm9qZWN0ID0gcHJvamVjdDtcbiAgZWxzZSBpZiAocHJvamVjdCA9PT0gXCJjbGVhclwiKSBkZWxldGUgZ2gucHJvamVjdDtcbiAgLy8gbGFiZWxzXG4gIGNvbnN0IGN1cnJlbnRMYWJlbHMgPSBBcnJheS5pc0FycmF5KGdoLmxhYmVscykgPyBnaC5sYWJlbHMgYXMgc3RyaW5nW10gOiBbXTtcbiAgY29uc3QgbGFiZWxzSW5wdXQgPSBhd2FpdCBjdHgudWkuaW5wdXQoXG4gICAgYEdpdEh1YiBkZWZhdWx0IGxhYmVscyAoY29tbWEtc2VwYXJhdGVkKSR7Y3VycmVudExhYmVscy5sZW5ndGggPyBgIChjdXJyZW50OiAke2N1cnJlbnRMYWJlbHMuam9pbihcIiwgXCIpfSlgIDogXCJcIn06YCxcbiAgICBjdXJyZW50TGFiZWxzLmpvaW4oXCIsIFwiKSxcbiAgKTtcbiAgaWYgKGxhYmVsc0lucHV0ICE9PSBudWxsICYmIGxhYmVsc0lucHV0ICE9PSB1bmRlZmluZWQpIHtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVN0cmluZ0xpc3QobGFiZWxzSW5wdXQpO1xuICAgIGlmIChwYXJzZWQubGVuZ3RoID4gMCkgZ2gubGFiZWxzID0gcGFyc2VkO1xuICAgIGVsc2UgaWYgKGN1cnJlbnRMYWJlbHMubGVuZ3RoID4gMCAmJiBsYWJlbHNJbnB1dC50cmltKCkgPT09IFwiXCIpIGRlbGV0ZSBnaC5sYWJlbHM7XG4gIH1cbiAgY29uc3QgYXV0b0xpbmsgPSBhd2FpdCBwcm9tcHRCb29sZWFuKGN0eCwgXCJHaXRIdWIgXHUyMDE0IGF1dG8tbGluayBjb21taXRzIHdpdGggUmVzb2x2ZXMgI05cIiwgZ2guYXV0b19saW5rX2NvbW1pdHMsIHRydWUpO1xuICBpZiAoYXV0b0xpbmsgIT09IHVuZGVmaW5lZCkgZ2guYXV0b19saW5rX2NvbW1pdHMgPSBhdXRvTGluaztcbiAgY29uc3Qgc2xpY2VQcnMgPSBhd2FpdCBwcm9tcHRCb29sZWFuKGN0eCwgXCJHaXRIdWIgXHUyMDE0IGNyZWF0ZSBwZXItc2xpY2UgZHJhZnQgUFJzXCIsIGdoLnNsaWNlX3BycywgdHJ1ZSk7XG4gIGlmIChzbGljZVBycyAhPT0gdW5kZWZpbmVkKSBnaC5zbGljZV9wcnMgPSBzbGljZVBycztcblxuICBpZiAoZ2guZW5hYmxlZCA9PT0gdHJ1ZSB8fCBPYmplY3Qua2V5cyhnaCkubGVuZ3RoID4gMSkgcHJlZnMuZ2l0aHViID0gZ2g7XG4gIGVsc2UgaWYgKHByZWZzLmdpdGh1YiAhPT0gdW5kZWZpbmVkICYmIE9iamVjdC5rZXlzKGdoKS5sZW5ndGggPT09IDApIGRlbGV0ZSBwcmVmcy5naXRodWI7XG4gIGVsc2UgaWYgKE9iamVjdC5rZXlzKGdoKS5sZW5ndGggPiAwKSBwcmVmcy5naXRodWIgPSBnaDtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNvbmZpZ3VyZU1vZGUoY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCwgcHJlZnM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGN1cnJlbnRNb2RlID0gcHJlZnMubW9kZSBhcyBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIGNvbnN0IG1vZGVDaG9pY2UgPSBhd2FpdCBjdHgudWkuc2VsZWN0KFxuICAgIGBXb3JrZmxvdyBtb2RlJHtjdXJyZW50TW9kZSA/IGAgKGN1cnJlbnQ6ICR7Y3VycmVudE1vZGV9KWAgOiBcIlwifTpgLFxuICAgIFtcbiAgICAgIFwic29sbyBcdTIwMTQgYXV0by1wdXNoLCBzcXVhc2gsIHNpbXBsZSBJRHMgKHBlcnNvbmFsIHByb2plY3RzKVwiLFxuICAgICAgXCJ0ZWFtIFx1MjAxNCB1bmlxdWUgSURzLCBwdXNoIGJyYW5jaGVzLCBwcmUtbWVyZ2UgY2hlY2tzIChzaGFyZWQgcmVwb3MpXCIsXG4gICAgICBcIihub25lKSBcdTIwMTQgY29uZmlndXJlIGV2ZXJ5dGhpbmcgbWFudWFsbHlcIixcbiAgICAgIFwiKGtlZXAgY3VycmVudClcIixcbiAgICBdLFxuICApO1xuICBjb25zdCBtb2RlU3RyID0gdHlwZW9mIG1vZGVDaG9pY2UgPT09IFwic3RyaW5nXCIgPyBtb2RlQ2hvaWNlIDogXCJcIjtcbiAgaWYgKG1vZGVTdHIgJiYgbW9kZVN0ciAhPT0gXCIoa2VlcCBjdXJyZW50KVwiKSB7XG4gICAgaWYgKG1vZGVTdHIuc3RhcnRzV2l0aChcInNvbG9cIikpIHtcbiAgICAgIHByZWZzLm1vZGUgPSBcInNvbG9cIjtcbiAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgIFwiTW9kZTogc29sbyBcdTIwMTQgZGVmYXVsdHM6IGF1dG9fcHVzaD10cnVlLCBwdXNoX2JyYW5jaGVzPWZhbHNlLCBwcmVfbWVyZ2VfY2hlY2s9YXV0bywgbWVyZ2Vfc3RyYXRlZ3k9c3F1YXNoLCBpc29sYXRpb249d29ya3RyZWUsIHVuaXF1ZV9taWxlc3RvbmVfaWRzPWZhbHNlXCIsXG4gICAgICAgIFwiaW5mb1wiLFxuICAgICAgKTtcbiAgICB9IGVsc2UgaWYgKG1vZGVTdHIuc3RhcnRzV2l0aChcInRlYW1cIikpIHtcbiAgICAgIHByZWZzLm1vZGUgPSBcInRlYW1cIjtcbiAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgIFwiTW9kZTogdGVhbSBcdTIwMTQgZGVmYXVsdHM6IGF1dG9fcHVzaD1mYWxzZSwgcHVzaF9icmFuY2hlcz10cnVlLCBwcmVfbWVyZ2VfY2hlY2s9dHJ1ZSwgbWVyZ2Vfc3RyYXRlZ3k9c3F1YXNoLCBpc29sYXRpb249d29ya3RyZWUsIHVuaXF1ZV9taWxlc3RvbmVfaWRzPXRydWVcIixcbiAgICAgICAgXCJpbmZvXCIsXG4gICAgICApO1xuICAgIH0gZWxzZSB7XG4gICAgICBkZWxldGUgcHJlZnMubW9kZTtcbiAgICB9XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gY29uZmlndXJlQWR2YW5jZWQoY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCwgcHJlZnM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHVuaXF1ZSA9IGF3YWl0IHByb21wdEJvb2xlYW4oY3R4LCBcIlVuaXF1ZSBtaWxlc3RvbmUgSURzXCIsIHByZWZzLnVuaXF1ZV9taWxlc3RvbmVfaWRzKTtcbiAgaWYgKHVuaXF1ZSAhPT0gdW5kZWZpbmVkKSBwcmVmcy51bmlxdWVfbWlsZXN0b25lX2lkcyA9IHVuaXF1ZTtcblxuICBjb25zdCBhdXRvVml6ID0gYXdhaXQgcHJvbXB0Qm9vbGVhbihjdHgsIFwiQXV0by12aXN1YWxpemUgbWlsZXN0b25lcyAob3BlbiBIVE1MIHZpc3VhbGl6ZXIpXCIsIHByZWZzLmF1dG9fdmlzdWFsaXplKTtcbiAgaWYgKGF1dG9WaXogIT09IHVuZGVmaW5lZCkgcHJlZnMuYXV0b192aXN1YWxpemUgPSBhdXRvVml6O1xuXG4gIGNvbnN0IGF1dG9SZXBvcnQgPSBhd2FpdCBwcm9tcHRCb29sZWFuKGN0eCwgXCJBdXRvLWdlbmVyYXRlIG1pbGVzdG9uZSBIVE1MIHJlcG9ydFwiLCBwcmVmcy5hdXRvX3JlcG9ydCwgdHJ1ZSk7XG4gIGlmIChhdXRvUmVwb3J0ICE9PSB1bmRlZmluZWQpIHByZWZzLmF1dG9fcmVwb3J0ID0gYXV0b1JlcG9ydDtcblxuICBjb25zdCBmb3JlbnNpY3MgPSBhd2FpdCBwcm9tcHRCb29sZWFuKGN0eCwgXCJGb3JlbnNpY3MgZGVkdXAgKHNlYXJjaCBHaXRIdWIgYmVmb3JlIGZpbGluZylcIiwgcHJlZnMuZm9yZW5zaWNzX2RlZHVwLCBmYWxzZSk7XG4gIGlmIChmb3JlbnNpY3MgIT09IHVuZGVmaW5lZCkgcHJlZnMuZm9yZW5zaWNzX2RlZHVwID0gZm9yZW5zaWNzO1xuXG4gIGNvbnN0IHRva2VuQ29zdCA9IGF3YWl0IHByb21wdEJvb2xlYW4oY3R4LCBcIlNob3cgdG9rZW4gY29zdCBpbiBmb290ZXJcIiwgcHJlZnMuc2hvd190b2tlbl9jb3N0LCBmYWxzZSk7XG4gIGlmICh0b2tlbkNvc3QgIT09IHVuZGVmaW5lZCkgcHJlZnMuc2hvd190b2tlbl9jb3N0ID0gdG9rZW5Db3N0O1xuXG4gIGNvbnN0IG1pblJlcXVlc3RJbnRlcnZhbCA9IGF3YWl0IHByb21wdEludGVnZXIoXG4gICAgY3R4LFxuICAgIFwiTWluaW11bSBpbnRlcnZhbCBiZXR3ZWVuIGF1dG8tbW9kZSBMTE0gcmVxdWVzdHMgKG1zLCAwIHRvIGRpc2FibGUpXCIsXG4gICAgcHJlZnMubWluX3JlcXVlc3RfaW50ZXJ2YWxfbXMsXG4gICAgXCIwXCIsXG4gICk7XG4gIGlmIChtaW5SZXF1ZXN0SW50ZXJ2YWwgPT09IFwiY2xlYXJcIikge1xuICAgIGRlbGV0ZSBwcmVmcy5taW5fcmVxdWVzdF9pbnRlcnZhbF9tcztcbiAgfSBlbHNlIGlmIChtaW5SZXF1ZXN0SW50ZXJ2YWwgIT09IHVuZGVmaW5lZCkge1xuICAgIHByZWZzLm1pbl9yZXF1ZXN0X2ludGVydmFsX21zID0gbWluUmVxdWVzdEludGVydmFsO1xuICB9XG5cbiAgY29uc3Qgd2lkZ2V0ID0gYXdhaXQgcHJvbXB0RW51bShjdHgsIFwiQXV0by1tb2RlIHdpZGdldCBkaXNwbGF5XCIsIHByZWZzLndpZGdldF9tb2RlLCBbXCJmdWxsXCIsIFwic21hbGxcIiwgXCJtaW5cIiwgXCJvZmZcIl0sIFwiZnVsbFwiKTtcbiAgaWYgKHdpZGdldCAhPT0gdW5kZWZpbmVkKSBwcmVmcy53aWRnZXRfbW9kZSA9IHdpZGdldDtcblxuICBjb25zdCBleHBlcmltZW50YWwgPSAocHJlZnMuZXhwZXJpbWVudGFsIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkKSA/PyB7fTtcbiAgY29uc3QgcnRrID0gYXdhaXQgcHJvbXB0Qm9vbGVhbihjdHgsIFwiRXhwZXJpbWVudGFsOiBSVEsgc2hlbGwtY29tbWFuZCBjb21wcmVzc2lvblwiLCBleHBlcmltZW50YWwucnRrLCBmYWxzZSk7XG4gIGlmIChydGsgIT09IHVuZGVmaW5lZCkgZXhwZXJpbWVudGFsLnJ0ayA9IHJ0aztcbiAgaWYgKE9iamVjdC5rZXlzKGV4cGVyaW1lbnRhbCkubGVuZ3RoID4gMCkgcHJlZnMuZXhwZXJpbWVudGFsID0gZXhwZXJpbWVudGFsO1xuICBlbHNlIGlmIChwcmVmcy5leHBlcmltZW50YWwgIT09IHVuZGVmaW5lZCkgZGVsZXRlIHByZWZzLmV4cGVyaW1lbnRhbDtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIE1haW4gd2l6YXJkIHdpdGggY2F0ZWdvcnkgbWVudSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZVByZWZzV2l6YXJkKFxuICBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LFxuICBzY29wZTogXCJnbG9iYWxcIiB8IFwicHJvamVjdFwiLFxuICBwcmVmaWxsPzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gIG9wdHM/OiB7IHBhdGhPdmVycmlkZT86IHN0cmluZyB9LFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIC8vIHBhdGhPdmVycmlkZSBsZXRzIGNhbGxlcnMgbGlrZSAvZ3NkIGluaXQgcGFzcyBhIGJhc2VQYXRoLWRlcml2ZWQgdGFyZ2V0XG4gIC8vIHBhdGggc28gdGhlIHdpemFyZCBkb2Vzbid0IGZhbGwgYmFjayB0byBjd2QtYmFzZWQgZ2V0UHJvamVjdEdTRFByZWZlcmVuY2VzUGF0aFxuICAvLyB3aGVuIHRoZSBpbml0IHRhcmdldCBkaXZlcmdlcyBmcm9tIHRoZSBjdXJyZW50IHdvcmtpbmcgZGlyZWN0b3J5LlxuICBjb25zdCBwYXRoID0gb3B0cz8ucGF0aE92ZXJyaWRlXG4gICAgPz8gKHNjb3BlID09PSBcInByb2plY3RcIiA/IGdldFByb2plY3RHU0RQcmVmZXJlbmNlc1BhdGgoKSA6IGdldEdsb2JhbEdTRFByZWZlcmVuY2VzUGF0aCgpKTtcbiAgY29uc3QgZXhpc3RpbmcgPSBzY29wZSA9PT0gXCJwcm9qZWN0XCIgPyBsb2FkUHJvamVjdEdTRFByZWZlcmVuY2VzKCkgOiBsb2FkR2xvYmFsR1NEUHJlZmVyZW5jZXMoKTtcbiAgLy8gT3JkZXI6IGV4aXN0aW5nLW9uLWRpc2sgdmFsdWVzLCBvdmVybGFpZCB3aXRoIHByZWZpbGwgKGNhbGxlcidzIHNlZWRlZCBhbnN3ZXJzKS5cbiAgLy8gQ2FsbGVycyBsaWtlIC9nc2QgaW5pdCBwYXNzIGZyZXNobHktY29sbGVjdGVkIGluaXQgYW5zd2VycyBhcyBwcmVmaWxsIHNvIHRoZVxuICAvLyB3aXphcmQgbWVudSBzaG93cyB0aGVtIHBvcHVsYXRlZCBhbmQgd3JpdGVhYmxlIGluIG9uZSBwbGFjZS5cbiAgY29uc3QgcHJlZnM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgIC4uLihleGlzdGluZz8ucHJlZmVyZW5jZXMgPz8ge30pLFxuICAgIC4uLihwcmVmaWxsID8/IHt9KSxcbiAgfTtcblxuICBjdHgudWkubm90aWZ5KGBHU0QgcHJlZmVyZW5jZXMgKCR7c2NvcGV9KSBcdTIwMTQgcGljayBhIGNhdGVnb3J5IHRvIGNvbmZpZ3VyZS5gLCBcImluZm9cIik7XG5cbiAgd2hpbGUgKHRydWUpIHtcbiAgICBjb25zdCBzdW1tYXJpZXMgPSBidWlsZENhdGVnb3J5U3VtbWFyaWVzKHByZWZzKTtcbiAgICBjb25zdCBvcHRpb25zID0gW1xuICAgICAgYFdvcmtmbG93IE1vZGUgICAke3N1bW1hcmllcy5tb2RlfWAsXG4gICAgICBgTW9kZWxzICAgICAgICAgICR7c3VtbWFyaWVzLm1vZGVsc31gLFxuICAgICAgYFRpbWVvdXRzICAgICAgICAke3N1bW1hcmllcy50aW1lb3V0c31gLFxuICAgICAgYEdpdCAgICAgICAgICAgICAke3N1bW1hcmllcy5naXR9YCxcbiAgICAgIGBTa2lsbHMgICAgICAgICAgJHtzdW1tYXJpZXMuc2tpbGxzfWAsXG4gICAgICBgQnVkZ2V0ICAgICAgICAgICR7c3VtbWFyaWVzLmJ1ZGdldH1gLFxuICAgICAgYE5vdGlmaWNhdGlvbnMgICAke3N1bW1hcmllcy5ub3RpZmljYXRpb25zfWAsXG4gICAgICBgUGhhc2VzICAgICAgICAgICR7c3VtbWFyaWVzLnBoYXNlc31gLFxuICAgICAgYFBhcmFsbGVsaXNtICAgICAke3N1bW1hcmllcy5wYXJhbGxlbGlzbX1gLFxuICAgICAgYFZlcmlmaWNhdGlvbiAgICAke3N1bW1hcmllcy52ZXJpZmljYXRpb259YCxcbiAgICAgIGBEaXNjdXNzICAgICAgICAgJHtzdW1tYXJpZXMuZGlzY3Vzc31gLFxuICAgICAgYENvbnRleHQgICAgICAgICAke3N1bW1hcmllcy5jb250ZXh0fWAsXG4gICAgICBgSG9va3MgICAgICAgICAgICR7c3VtbWFyaWVzLmhvb2tzfWAsXG4gICAgICBgVW9LICAgICAgICAgICAgICR7c3VtbWFyaWVzLnVva31gLFxuICAgICAgYEludGVncmF0aW9ucyAgICAke3N1bW1hcmllcy5pbnRlZ3JhdGlvbnN9YCxcbiAgICAgIGBBZHZhbmNlZCAgICAgICAgJHtzdW1tYXJpZXMuYWR2YW5jZWR9YCxcbiAgICAgIGBcdTI1MDBcdTI1MDAgU2F2ZSAmIEV4aXQgXHUyNTAwXHUyNTAwYCxcbiAgICBdO1xuXG4gICAgY29uc3QgcmF3ID0gYXdhaXQgY3R4LnVpLnNlbGVjdChcIkdTRCBQcmVmZXJlbmNlc1wiLCBvcHRpb25zKTtcbiAgICBjb25zdCBjaG9pY2UgPSB0eXBlb2YgcmF3ID09PSBcInN0cmluZ1wiID8gcmF3IDogXCJcIjtcbiAgICBpZiAoIWNob2ljZSB8fCBjaG9pY2UuaW5jbHVkZXMoXCJTYXZlICYgRXhpdFwiKSkgYnJlYWs7XG5cbiAgICBpZiAoY2hvaWNlLnN0YXJ0c1dpdGgoXCJXb3JrZmxvdyBNb2RlXCIpKSAgICAgIGF3YWl0IGNvbmZpZ3VyZU1vZGUoY3R4LCBwcmVmcyk7XG4gICAgZWxzZSBpZiAoY2hvaWNlLnN0YXJ0c1dpdGgoXCJNb2RlbHNcIikpICAgICAgICBhd2FpdCBjb25maWd1cmVNb2RlbHMoY3R4LCBwcmVmcyk7XG4gICAgZWxzZSBpZiAoY2hvaWNlLnN0YXJ0c1dpdGgoXCJUaW1lb3V0c1wiKSkgICAgICBhd2FpdCBjb25maWd1cmVUaW1lb3V0cyhjdHgsIHByZWZzKTtcbiAgICBlbHNlIGlmIChjaG9pY2Uuc3RhcnRzV2l0aChcIkdpdFwiKSkgICAgICAgICAgIGF3YWl0IGNvbmZpZ3VyZUdpdChjdHgsIHByZWZzKTtcbiAgICBlbHNlIGlmIChjaG9pY2Uuc3RhcnRzV2l0aChcIlNraWxsc1wiKSkgICAgICAgIGF3YWl0IGNvbmZpZ3VyZVNraWxscyhjdHgsIHByZWZzKTtcbiAgICBlbHNlIGlmIChjaG9pY2Uuc3RhcnRzV2l0aChcIkJ1ZGdldFwiKSkgICAgICAgIGF3YWl0IGNvbmZpZ3VyZUJ1ZGdldChjdHgsIHByZWZzKTtcbiAgICBlbHNlIGlmIChjaG9pY2Uuc3RhcnRzV2l0aChcIk5vdGlmaWNhdGlvbnNcIikpIGF3YWl0IGNvbmZpZ3VyZU5vdGlmaWNhdGlvbnMoY3R4LCBwcmVmcyk7XG4gICAgZWxzZSBpZiAoY2hvaWNlLnN0YXJ0c1dpdGgoXCJQaGFzZXNcIikpICAgICAgICBhd2FpdCBjb25maWd1cmVQaGFzZXMoY3R4LCBwcmVmcyk7XG4gICAgZWxzZSBpZiAoY2hvaWNlLnN0YXJ0c1dpdGgoXCJQYXJhbGxlbGlzbVwiKSkgICBhd2FpdCBjb25maWd1cmVQYXJhbGxlbGlzbShjdHgsIHByZWZzKTtcbiAgICBlbHNlIGlmIChjaG9pY2Uuc3RhcnRzV2l0aChcIlZlcmlmaWNhdGlvblwiKSkgIGF3YWl0IGNvbmZpZ3VyZVZlcmlmaWNhdGlvbihjdHgsIHByZWZzKTtcbiAgICBlbHNlIGlmIChjaG9pY2Uuc3RhcnRzV2l0aChcIkRpc2N1c3NcIikpICAgICAgIGF3YWl0IGNvbmZpZ3VyZURpc2N1c3MoY3R4LCBwcmVmcyk7XG4gICAgZWxzZSBpZiAoY2hvaWNlLnN0YXJ0c1dpdGgoXCJDb250ZXh0XCIpKSAgICAgICBhd2FpdCBjb25maWd1cmVDb250ZXh0Q29kZWJhc2UoY3R4LCBwcmVmcyk7XG4gICAgZWxzZSBpZiAoY2hvaWNlLnN0YXJ0c1dpdGgoXCJIb29rc1wiKSkgICAgICAgICBhd2FpdCBjb25maWd1cmVIb29rcyhjdHgsIHByZWZzKTtcbiAgICBlbHNlIGlmIChjaG9pY2Uuc3RhcnRzV2l0aChcIlVvS1wiKSkgICAgICAgICAgIGF3YWl0IGNvbmZpZ3VyZVVvSyhjdHgsIHByZWZzKTtcbiAgICBlbHNlIGlmIChjaG9pY2Uuc3RhcnRzV2l0aChcIkludGVncmF0aW9uc1wiKSkgIGF3YWl0IGNvbmZpZ3VyZUludGVncmF0aW9ucyhjdHgsIHByZWZzKTtcbiAgICBlbHNlIGlmIChjaG9pY2Uuc3RhcnRzV2l0aChcIkFkdmFuY2VkXCIpKSAgICAgIGF3YWl0IGNvbmZpZ3VyZUFkdmFuY2VkKGN0eCwgcHJlZnMpO1xuICB9XG5cbiAgYXdhaXQgd3JpdGVQcmVmZXJlbmNlc0ZpbGUocGF0aCwgcHJlZnMsIGN0eCwgeyBzY29wZSB9KTtcbn1cblxuLyoqXG4gKiBTaW5nbGUgc291cmNlIG9mIHRydXRoIGZvciB3cml0aW5nIGEgUFJFRkVSRU5DRVMubWQgZmlsZS5cbiAqXG4gKiBCb3RoIGAvZ3NkIGluaXRgIGFuZCB0aGUgcHJlZnMgd2l6YXJkIHJvdXRlIHRocm91Z2ggdGhpcyBoZWxwZXIgc28gd2UgY2FuJ3RcbiAqIGRyaWZ0IG9uIHNlcmlhbGl6YXRpb24sIGJvZHkgcHJlc2VydmF0aW9uLCBvciBwb3N0LXdyaXRlIHJlbG9hZC4gQ2FsbGVyc1xuICogcGFzcyBgY3R4YCBmb3IgdGhlIHJlbG9hZC9ub3RpZnkgc2lkZSBlZmZlY3RzOyB0aGUgZnVuY3Rpb24gaXMgc2FmZSB0byBjYWxsXG4gKiB3aXRob3V0IGEgZnVsbCBVSSBjb250ZXh0IGZvciB0ZXN0cyB2aWEgYGN0eDogbnVsbGAgKHNraXBzIHJlbG9hZC9ub3RpZnkpLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gd3JpdGVQcmVmZXJlbmNlc0ZpbGUoXG4gIHBhdGg6IHN0cmluZyxcbiAgcHJlZnM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0IHwgbnVsbCxcbiAgb3B0cz86IHsgc2NvcGU/OiBcImdsb2JhbFwiIHwgXCJwcm9qZWN0XCI7IGRlZmF1bHRCb2R5Pzogc3RyaW5nOyBub3RpZnlPblNhdmU/OiBib29sZWFuIH0sXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgbmV4dCA9IHsgLi4ucHJlZnMsIHZlcnNpb246IHByZWZzLnZlcnNpb24gfHwgMSB9O1xuICBjb25zdCBmcm9udG1hdHRlciA9IHNlcmlhbGl6ZVByZWZlcmVuY2VzVG9Gcm9udG1hdHRlcihuZXh0KTtcblxuICBjb25zdCBmYWxsYmFja0JvZHkgPSBvcHRzPy5kZWZhdWx0Qm9keVxuICAgID8/IFwiXFxuIyBHU0QgU2tpbGwgUHJlZmVyZW5jZXNcXG5cXG5TZWUgYH4vLmdzZC9hZ2VudC9leHRlbnNpb25zL2dzZC9kb2NzL3ByZWZlcmVuY2VzLXJlZmVyZW5jZS5tZGAgZm9yIGZ1bGwgZmllbGQgZG9jdW1lbnRhdGlvbiBhbmQgZXhhbXBsZXMuXFxuXCI7XG5cbiAgLy8gUHJlc2VydmUgZXhpc3RpbmcgYm9keSBjb250ZW50IChldmVyeXRoaW5nIGFmdGVyIGNsb3NpbmcgLS0tKSBzbyB1c2Vyc1xuICAvLyB3aG8gZWRpdGVkIHRoZSBtYXJrZG93biBib2R5IGRvbid0IGxvc2UgdGhlaXIgbm90ZXMuXG4gIGxldCBib2R5ID0gZmFsbGJhY2tCb2R5O1xuICBpZiAoZXhpc3RzU3luYyhwYXRoKSkge1xuICAgIGNvbnN0IHByZXNlcnZlZCA9IGV4dHJhY3RCb2R5QWZ0ZXJGcm9udG1hdHRlcihyZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGYtOFwiKSk7XG4gICAgaWYgKHByZXNlcnZlZCkgYm9keSA9IHByZXNlcnZlZDtcbiAgfVxuXG4gIGNvbnN0IGNvbnRlbnQgPSBgLS0tXFxuJHtmcm9udG1hdHRlcn0tLS0ke2JvZHl9YDtcbiAgYXdhaXQgc2F2ZUZpbGUocGF0aCwgY29udGVudCk7XG5cbiAgaWYgKGN0eCkge1xuICAgIGF3YWl0IGN0eC53YWl0Rm9ySWRsZSgpO1xuICAgIGF3YWl0IGN0eC5yZWxvYWQoKTtcbiAgICBpZiAob3B0cz8ubm90aWZ5T25TYXZlICE9PSBmYWxzZSkge1xuICAgICAgY29uc3Qgc2NvcGVMYWJlbCA9IG9wdHM/LnNjb3BlID8gYCR7b3B0cy5zY29wZX0gYCA6IFwiXCI7XG4gICAgICBjdHgudWkubm90aWZ5KGBTYXZlZCAke3Njb3BlTGFiZWx9cHJlZmVyZW5jZXMgdG8gJHtwYXRofWAsIFwiaW5mb1wiKTtcbiAgICB9XG4gIH1cbn1cblxuLyoqIFdyYXAgYSBZQU1MIHZhbHVlIGluIGRvdWJsZSBxdW90ZXMgaWYgaXQgY29udGFpbnMgc3BlY2lhbCBjaGFyYWN0ZXJzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHlhbWxTYWZlU3RyaW5nKHZhbDogdW5rbm93bik6IHN0cmluZyB7XG4gIGlmICh0eXBlb2YgdmFsICE9PSBcInN0cmluZ1wiKSByZXR1cm4gU3RyaW5nKHZhbCk7XG4gIGlmICgvWzoje1xcW1xcXSdcImAsfD4mKiE/QCVcXHJcXG5dLy50ZXN0KHZhbCkgfHwgdmFsLnRyaW0oKSAhPT0gdmFsIHx8IHZhbCA9PT0gXCJcIikge1xuICAgIHJldHVybiBgXCIke3ZhbC5yZXBsYWNlKC9cXFxcL2csIFwiXFxcXFxcXFxcIikucmVwbGFjZSgvXCIvZywgJ1xcXFxcIicpLnJlcGxhY2UoL1xcci9nLCBcIlxcXFxyXCIpLnJlcGxhY2UoL1xcbi9nLCBcIlxcXFxuXCIpfVwiYDtcbiAgfVxuICByZXR1cm4gdmFsO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2VyaWFsaXplUHJlZmVyZW5jZXNUb0Zyb250bWF0dGVyKHByZWZzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IHN0cmluZyB7XG4gIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuXG4gIGZ1bmN0aW9uIHNlcmlhbGl6ZVZhbHVlKGtleTogc3RyaW5nLCB2YWx1ZTogdW5rbm93biwgaW5kZW50OiBudW1iZXIpOiB2b2lkIHtcbiAgICBjb25zdCBwcmVmaXggPSBcIiAgXCIucmVwZWF0KGluZGVudCk7XG4gICAgaWYgKHZhbHVlID09PSBudWxsIHx8IHZhbHVlID09PSB1bmRlZmluZWQpIHJldHVybjtcblxuICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgaWYgKHZhbHVlLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICByZXR1cm47IC8vIE9taXQgZW1wdHkgYXJyYXlzIFx1MjAxNCBhdm9pZHMgcGFyc2Uvc2VyaWFsaXplIGN5Y2xlIGJ1ZyB3aXRoIFwiW11cIiBzdHJpbmdzXG4gICAgICB9XG4gICAgICBsaW5lcy5wdXNoKGAke3ByZWZpeH0ke2tleX06YCk7XG4gICAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgdmFsdWUpIHtcbiAgICAgICAgaWYgKHR5cGVvZiBpdGVtID09PSBcIm9iamVjdFwiICYmIGl0ZW0gIT09IG51bGwpIHtcbiAgICAgICAgICBjb25zdCBlbnRyaWVzID0gT2JqZWN0LmVudHJpZXMoaXRlbSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik7XG4gICAgICAgICAgaWYgKGVudHJpZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgY29uc3QgW2ZpcnN0S2V5LCBmaXJzdFZhbF0gPSBlbnRyaWVzWzBdO1xuICAgICAgICAgICAgbGluZXMucHVzaChgJHtwcmVmaXh9ICAtICR7Zmlyc3RLZXl9OiAke3lhbWxTYWZlU3RyaW5nKGZpcnN0VmFsKX1gKTtcbiAgICAgICAgICAgIGZvciAobGV0IGkgPSAxOyBpIDwgZW50cmllcy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgICBjb25zdCBbaywgdl0gPSBlbnRyaWVzW2ldO1xuICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheSh2KSkge1xuICAgICAgICAgICAgICAgIGxpbmVzLnB1c2goYCR7cHJlZml4fSAgICAke2t9OmApO1xuICAgICAgICAgICAgICAgIGZvciAoY29uc3QgYXJySXRlbSBvZiB2KSB7XG4gICAgICAgICAgICAgICAgICBsaW5lcy5wdXNoKGAke3ByZWZpeH0gICAgICAtICR7eWFtbFNhZmVTdHJpbmcoYXJySXRlbSl9YCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGxpbmVzLnB1c2goYCR7cHJlZml4fSAgICAke2t9OiAke3lhbWxTYWZlU3RyaW5nKHYpfWApO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGxpbmVzLnB1c2goYCR7cHJlZml4fSAgLSAke3lhbWxTYWZlU3RyaW5nKGl0ZW0pfWApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gXCJvYmplY3RcIikge1xuICAgICAgY29uc3QgZW50cmllcyA9IE9iamVjdC5lbnRyaWVzKHZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KTtcbiAgICAgIGlmIChlbnRyaWVzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICByZXR1cm47IC8vIE9taXQgZW1wdHkgb2JqZWN0cyBcdTIwMTQgYXZvaWRzIHBhcnNlL3NlcmlhbGl6ZSBjeWNsZSBidWcgd2l0aCBcInt9XCIgc3RyaW5nc1xuICAgICAgfVxuICAgICAgbGluZXMucHVzaChgJHtwcmVmaXh9JHtrZXl9OmApO1xuICAgICAgZm9yIChjb25zdCBbaywgdl0gb2YgZW50cmllcykge1xuICAgICAgICBzZXJpYWxpemVWYWx1ZShrLCB2LCBpbmRlbnQgKyAxKTtcbiAgICAgIH1cbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBsaW5lcy5wdXNoKGAke3ByZWZpeH0ke2tleX06ICR7eWFtbFNhZmVTdHJpbmcodmFsdWUpfWApO1xuICB9XG5cbiAgLy8gT3JkZXJlZCBrZXlzIGZvciBjb25zaXN0ZW50IG91dHB1dFxuICBjb25zdCBvcmRlcmVkS2V5cyA9IFtcbiAgICBcInZlcnNpb25cIiwgXCJtb2RlXCIsIFwiYWx3YXlzX3VzZV9za2lsbHNcIiwgXCJwcmVmZXJfc2tpbGxzXCIsIFwiYXZvaWRfc2tpbGxzXCIsXG4gICAgXCJza2lsbF9ydWxlc1wiLCBcImN1c3RvbV9pbnN0cnVjdGlvbnNcIiwgXCJtb2RlbHNcIiwgXCJza2lsbF9kaXNjb3ZlcnlcIixcbiAgICBcInNraWxsX3N0YWxlbmVzc19kYXlzXCIsIFwiYXV0b19zdXBlcnZpc29yXCIsIFwidWF0X2Rpc3BhdGNoXCIsIFwidW5pcXVlX21pbGVzdG9uZV9pZHNcIixcbiAgICBcImJ1ZGdldF9jZWlsaW5nXCIsIFwiYnVkZ2V0X2VuZm9yY2VtZW50XCIsIFwiY29udGV4dF9wYXVzZV90aHJlc2hvbGRcIixcbiAgICBcIm5vdGlmaWNhdGlvbnNcIiwgXCJjbXV4XCIsIFwicmVtb3RlX3F1ZXN0aW9uc1wiLCBcImdpdFwiLFxuICAgIFwic3RhbGVfY29tbWl0X3RocmVzaG9sZF9taW51dGVzXCIsXG4gICAgXCJtaW5fcmVxdWVzdF9pbnRlcnZhbF9tc1wiLFxuICAgIFwicG9zdF91bml0X2hvb2tzXCIsIFwicHJlX2Rpc3BhdGNoX2hvb2tzXCIsXG4gICAgXCJkeW5hbWljX3JvdXRpbmdcIiwgXCJkaXNhYmxlZF9tb2RlbF9wcm92aWRlcnNcIiwgXCJ1b2tcIiwgXCJ0b2tlbl9wcm9maWxlXCIsXG4gICAgXCJzZXJ2aWNlX3RpZXJcIiwgXCJmbGF0X3JhdGVfcHJvdmlkZXJzXCIsXG4gICAgXCJwaGFzZXNcIiwgXCJwYXJhbGxlbFwiLCBcInNsaWNlX3BhcmFsbGVsXCIsXG4gICAgXCJyZWFjdGl2ZV9leGVjdXRpb25cIiwgXCJnYXRlX2V2YWx1YXRpb25cIixcbiAgICBcImF1dG9fdmlzdWFsaXplXCIsIFwiYXV0b19yZXBvcnRcIixcbiAgICBcInZlcmlmaWNhdGlvbl9jb21tYW5kc1wiLCBcInZlcmlmaWNhdGlvbl9hdXRvX2ZpeFwiLCBcInZlcmlmaWNhdGlvbl9tYXhfcmV0cmllc1wiLFxuICAgIFwiZW5oYW5jZWRfdmVyaWZpY2F0aW9uXCIsIFwiZW5oYW5jZWRfdmVyaWZpY2F0aW9uX3ByZVwiLFxuICAgIFwiZW5oYW5jZWRfdmVyaWZpY2F0aW9uX3Bvc3RcIiwgXCJlbmhhbmNlZF92ZXJpZmljYXRpb25fc3RyaWN0XCIsXG4gICAgXCJzYWZldHlfaGFybmVzc1wiLFxuICAgIFwiZGlzY3Vzc19wcmVwYXJhdGlvblwiLCBcImRpc2N1c3Nfd2ViX3Jlc2VhcmNoXCIsIFwiZGlzY3Vzc19kZXB0aFwiLFxuICAgIFwic2VhcmNoX3Byb3ZpZGVyXCIsIFwiY29udGV4dF9zZWxlY3Rpb25cIiwgXCJjb250ZXh0X21hbmFnZW1lbnRcIiwgXCJjb250ZXh0X3dpbmRvd19vdmVycmlkZVwiLFxuICAgIFwiY29kZWJhc2VcIiwgXCJ3aWRnZXRfbW9kZVwiLCBcImZvcmVuc2ljc19kZWR1cFwiLCBcInNob3dfdG9rZW5fY29zdFwiLFxuICAgIFwiZ2l0aHViXCIsIFwiZXhwZXJpbWVudGFsXCIsXG4gICAgXCJsYW5ndWFnZVwiLFxuICBdO1xuXG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgZm9yIChjb25zdCBrZXkgb2Ygb3JkZXJlZEtleXMpIHtcbiAgICBpZiAoa2V5IGluIHByZWZzKSB7XG4gICAgICBzZXJpYWxpemVWYWx1ZShrZXksIHByZWZzW2tleV0sIDApO1xuICAgICAgc2Vlbi5hZGQoa2V5KTtcbiAgICB9XG4gIH1cbiAgLy8gQW55IHJlbWFpbmluZyBrZXlzIG5vdCBpbiB0aGUgb3JkZXJlZCBsaXN0XG4gIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKHByZWZzKSkge1xuICAgIGlmICghc2Vlbi5oYXMoa2V5KSkge1xuICAgICAgc2VyaWFsaXplVmFsdWUoa2V5LCB2YWx1ZSwgMCk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGxpbmVzLmpvaW4oXCJcXG5cIikgKyBcIlxcblwiO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZW5zdXJlUHJlZmVyZW5jZXNGaWxlKFxuICBwYXRoOiBzdHJpbmcsXG4gIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsXG4gIHNjb3BlOiBcImdsb2JhbFwiIHwgXCJwcm9qZWN0XCIsXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgaWYgKCFleGlzdHNTeW5jKHBhdGgpKSB7XG4gICAgY29uc3QgdGVtcGxhdGUgPSBhd2FpdCBsb2FkRmlsZShqb2luKGRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKSwgXCJ0ZW1wbGF0ZXNcIiwgXCJQUkVGRVJFTkNFUy5tZFwiKSk7XG4gICAgaWYgKCF0ZW1wbGF0ZSkge1xuICAgICAgY3R4LnVpLm5vdGlmeShcIkNvdWxkIG5vdCBsb2FkIEdTRCBwcmVmZXJlbmNlcyB0ZW1wbGF0ZS5cIiwgXCJlcnJvclwiKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgYXdhaXQgc2F2ZUZpbGUocGF0aCwgdGVtcGxhdGUpO1xuICAgIGN0eC51aS5ub3RpZnkoYENyZWF0ZWQgJHtzY29wZX0gR1NEIHNraWxsIHByZWZlcmVuY2VzIGF0ICR7cGF0aH1gLCBcImluZm9cIik7XG4gIH0gZWxzZSB7XG4gICAgY3R4LnVpLm5vdGlmeShgVXNpbmcgZXhpc3RpbmcgJHtzY29wZX0gR1NEIHNraWxsIHByZWZlcmVuY2VzIGF0ICR7cGF0aH1gLCBcImluZm9cIik7XG4gIH1cbn1cblxuLyoqXG4gKiBIYW5kbGUgYC9nc2QgbGFuZ3VhZ2UgW2NvZGVdYCBcdTIwMTQgc2V0IG9yIGNsZWFyIHRoZSBnbG9iYWwgbGFuZ3VhZ2UgcHJlZmVyZW5jZS5cbiAqIFdpdGhvdXQgYW4gYXJndW1lbnQsIHNob3dzIHRoZSBjdXJyZW50IHNldHRpbmcuXG4gKiBQcm9qZWN0LWxldmVsIG92ZXJyaWRlIGNhbiBiZSBzZXQgYnkgZWRpdGluZyBgLmdzZC9QUkVGRVJFTkNFUy5tZGAgZGlyZWN0bHlcbiAqIChwcm9qZWN0IGxhbmd1YWdlIG92ZXJyaWRlcyBnbG9iYWwgd2hlbiBib3RoIGFyZSBzZXQpLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlTGFuZ3VhZ2UoYXJnczogc3RyaW5nLCBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHBhdGggPSBnZXRHbG9iYWxHU0RQcmVmZXJlbmNlc1BhdGgoKTtcbiAgY29uc3QgbGFuZyA9IGFyZ3MudHJpbSgpO1xuXG4gIC8vIFNob3cgY3VycmVudCBzZXR0aW5nIHdoZW4gY2FsbGVkIHdpdGhvdXQgYXJndW1lbnRcbiAgaWYgKCFsYW5nKSB7XG4gICAgY29uc3QgbG9hZGVkID0gbG9hZEdsb2JhbEdTRFByZWZlcmVuY2VzKCk7XG4gICAgY29uc3QgY3VycmVudCA9IGxvYWRlZD8ucHJlZmVyZW5jZXMubGFuZ3VhZ2U7XG4gICAgaWYgKGN1cnJlbnQpIHtcbiAgICAgIGN0eC51aS5ub3RpZnkoYEN1cnJlbnQgbGFuZ3VhZ2UgcHJlZmVyZW5jZTogJHtjdXJyZW50fVxcblVzZSAvZ3NkIGxhbmd1YWdlIDxuYW1lPiB0byBjaGFuZ2UsIG9yIC9nc2QgbGFuZ3VhZ2Ugb2ZmIHRvIGNsZWFyLmAsIFwiaW5mb1wiKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY3R4LnVpLm5vdGlmeShcIk5vIGxhbmd1YWdlIHByZWZlcmVuY2Ugc2V0LiBVc2UgL2dzZCBsYW5ndWFnZSA8bmFtZT4gdG8gc2V0IG9uZSAoZS5nLiAvZ3NkIGxhbmd1YWdlIENoaW5lc2UpLlwiLCBcImluZm9cIik7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIEVuc3VyZSBwcmVmZXJlbmNlcyBmaWxlIGV4aXN0cyB3aXRoIHRoZSBjYW5vbmljYWwgdGVtcGxhdGVcbiAgYXdhaXQgZW5zdXJlUHJlZmVyZW5jZXNGaWxlKHBhdGgsIGN0eCwgXCJnbG9iYWxcIik7XG5cbiAgLy8gUmVhZCB2aWEgdGhlIHNhbWUgdmFsaWRhdGVkIHBhdGggYXMgb3RoZXIgaGFuZGxlcnNcbiAgY29uc3QgZXhpc3RpbmcgPSBsb2FkR2xvYmFsR1NEUHJlZmVyZW5jZXMoKTtcbiAgY29uc3QgcHJlZnM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0gZXhpc3Rpbmc/LnByZWZlcmVuY2VzID8geyAuLi5leGlzdGluZy5wcmVmZXJlbmNlcyB9IDogeyB2ZXJzaW9uOiAxIH07XG5cbiAgaWYgKGxhbmcgPT09IFwib2ZmXCIgfHwgbGFuZyA9PT0gXCJub25lXCIgfHwgbGFuZyA9PT0gXCJjbGVhclwiKSB7XG4gICAgZGVsZXRlIHByZWZzLmxhbmd1YWdlO1xuICAgIGN0eC51aS5ub3RpZnkoXCJMYW5ndWFnZSBwcmVmZXJlbmNlIGNsZWFyZWQuIEdTRCB3aWxsIHVzZSB0aGUgZGVmYXVsdCBsYW5ndWFnZS5cIiwgXCJpbmZvXCIpO1xuICB9IGVsc2Uge1xuICAgIC8vIFZhbGlkYXRlIGJlZm9yZSB3cml0aW5nIFx1MjAxNCByZWplY3QgdmFsdWVzIHRoYXQgd291bGQgZmFpbCBvbiBuZXh0IGxvYWRcbiAgICBpZiAobGFuZy5sZW5ndGggPiA1MCB8fCAvW1xcclxcbl0vLnRlc3QobGFuZykpIHtcbiAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgIFwiTGFuZ3VhZ2UgdmFsdWUgbXVzdCBiZSA1MCBjaGFyYWN0ZXJzIG9yIGZld2VyIHdpdGggbm8gbmV3bGluZXMgKGUuZy4gL2dzZCBsYW5ndWFnZSBDaGluZXNlKS5cIixcbiAgICAgICAgXCJ3YXJuaW5nXCIsXG4gICAgICApO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBwcmVmcy5sYW5ndWFnZSA9IGxhbmc7XG4gICAgY3R4LnVpLm5vdGlmeShgTGFuZ3VhZ2UgcHJlZmVyZW5jZSBzZXQgdG86ICR7bGFuZ31cXG5HU0Qgd2lsbCBub3cgcmVzcG9uZCBpbiAke2xhbmd9IGFjcm9zcyBhbGwgc2Vzc2lvbnMuYCwgXCJpbmZvXCIpO1xuICB9XG5cbiAgY29uc3QgcmF3Q29udGVudCA9IGV4aXN0c1N5bmMocGF0aCkgPyByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGYtOFwiKSA6IGAtLS1cXG52ZXJzaW9uOiAxXFxuLS0tXFxuYDtcbiAgY29uc3QgZnJvbnRtYXR0ZXIgPSBzZXJpYWxpemVQcmVmZXJlbmNlc1RvRnJvbnRtYXR0ZXIocHJlZnMpO1xuICBjb25zdCBib2R5ID0gZXh0cmFjdEJvZHlBZnRlckZyb250bWF0dGVyKHJhd0NvbnRlbnQpXG4gICAgPz8gXCJcXG4jIEdTRCBTa2lsbCBQcmVmZXJlbmNlc1xcblxcblNlZSBgfi8uZ3NkL2FnZW50L2V4dGVuc2lvbnMvZ3NkL2RvY3MvcHJlZmVyZW5jZXMtcmVmZXJlbmNlLm1kYCBmb3IgZnVsbCBmaWVsZCBkb2N1bWVudGF0aW9uIGFuZCBleGFtcGxlcy5cXG5cIjtcbiAgYXdhaXQgc2F2ZUZpbGUocGF0aCwgYC0tLVxcbiR7ZnJvbnRtYXR0ZXJ9LS0tJHtib2R5fWApO1xuICBhd2FpdCBjdHgud2FpdEZvcklkbGUoKTtcbiAgYXdhaXQgY3R4LnJlbG9hZCgpO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBU0EsU0FBUyxZQUFZLG9CQUFvQjtBQUN6QyxTQUFTLE1BQU0sZUFBZTtBQUM5QixTQUFTLHFCQUFxQjtBQUM5QjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1AsU0FBUyxVQUFVLFVBQVUsa0JBQWtCLDJCQUEyQjtBQUMxRSxTQUFTLDJCQUEyQjtBQUdwQyxTQUFTLDRCQUE0QixTQUFnQztBQUNuRSxRQUFNLGFBQWEsUUFBUSxRQUFRLFNBQVMsUUFBUSxRQUFRLEtBQUssQ0FBQztBQUNsRSxNQUFJLGVBQWUsR0FBSSxRQUFPO0FBQzlCLFFBQU0sbUJBQW1CLFFBQVEsTUFBTSxhQUFhLENB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
