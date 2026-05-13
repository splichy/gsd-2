import { VALID_BRANCH_NAME } from "./git-service.js";
import { normalizeStringArray } from "../shared/format-utils.js";
import {
  KNOWN_PREFERENCE_KEYS,
  KNOWN_UNIT_LABELS,
  SKILL_ACTIONS
} from "./preferences-types.js";
const VALID_TOKEN_PROFILES = /* @__PURE__ */ new Set(["budget", "balanced", "quality", "burn-max"]);
const VALID_UOK_TURN_ACTIONS = /* @__PURE__ */ new Set([
  "commit",
  "snapshot",
  "status-only"
]);
function validatePreferences(preferences) {
  const errors = [];
  const warnings = [];
  const validated = {};
  const KEY_MIGRATION_HINTS = {
    taskIsolation: 'use "git.isolation" instead (values: worktree, branch, none)',
    task_isolation: 'use "git.isolation" instead (values: worktree, branch, none)',
    isolation: 'use "git.isolation" instead (values: worktree, branch, none)',
    manage_gitignore: 'use "git.manage_gitignore" instead',
    auto_push: 'use "git.auto_push" instead',
    main_branch: 'use "git.main_branch" instead'
  };
  for (const key of Object.keys(preferences)) {
    if (!KNOWN_PREFERENCE_KEYS.has(key)) {
      const hint = KEY_MIGRATION_HINTS[key];
      if (hint) {
        warnings.push(`unknown preference key "${key}" \u2014 ${hint}`);
      } else {
        warnings.push(`unknown preference key "${key}" \u2014 ignored`);
      }
    }
  }
  if (preferences.version !== void 0) {
    if (preferences.version === 1) {
      validated.version = 1;
    } else {
      errors.push(`unsupported version ${preferences.version}`);
    }
  }
  if (preferences.mode !== void 0) {
    const validModes = /* @__PURE__ */ new Set(["solo", "team"]);
    if (typeof preferences.mode === "string" && validModes.has(preferences.mode)) {
      validated.mode = preferences.mode;
    } else {
      errors.push(`invalid mode "${preferences.mode}" \u2014 must be one of: solo, team`);
    }
  }
  const validDiscoveryModes = /* @__PURE__ */ new Set(["auto", "suggest", "off"]);
  if (preferences.skill_discovery) {
    if (validDiscoveryModes.has(preferences.skill_discovery)) {
      validated.skill_discovery = preferences.skill_discovery;
    } else {
      errors.push(`invalid skill_discovery value: ${preferences.skill_discovery}`);
    }
  }
  if (preferences.skill_staleness_days !== void 0) {
    const days = Number(preferences.skill_staleness_days);
    if (Number.isFinite(days) && days >= 0) {
      validated.skill_staleness_days = Math.floor(days);
    } else {
      errors.push(`invalid skill_staleness_days: must be a non-negative number`);
    }
  }
  validated.always_use_skills = normalizeStringArray(preferences.always_use_skills);
  validated.prefer_skills = normalizeStringArray(preferences.prefer_skills);
  validated.avoid_skills = normalizeStringArray(preferences.avoid_skills);
  validated.custom_instructions = normalizeStringArray(preferences.custom_instructions);
  if (preferences.skill_rules) {
    const validRules = [];
    for (const rule of preferences.skill_rules) {
      if (!rule || typeof rule !== "object") {
        errors.push("invalid skill_rules entry");
        continue;
      }
      const when = typeof rule.when === "string" ? rule.when.trim() : "";
      if (!when) {
        errors.push("skill_rules entry missing when");
        continue;
      }
      const validatedRule = { when };
      for (const action of SKILL_ACTIONS) {
        const values = normalizeStringArray(rule[action]);
        if (values.length > 0) {
          validatedRule[action] = values;
        }
      }
      if (!validatedRule.use && !validatedRule.prefer && !validatedRule.avoid) {
        errors.push(`skill rule has no actions: ${when}`);
        continue;
      }
      validRules.push(validatedRule);
    }
    if (validRules.length > 0) {
      validated.skill_rules = validRules;
    }
  }
  for (const key of ["always_use_skills", "prefer_skills", "avoid_skills", "custom_instructions"]) {
    if (validated[key] && validated[key].length === 0) {
      delete validated[key];
    }
  }
  if (preferences.uat_dispatch !== void 0) {
    validated.uat_dispatch = !!preferences.uat_dispatch;
  }
  if (preferences.unique_milestone_ids !== void 0) {
    validated.unique_milestone_ids = !!preferences.unique_milestone_ids;
  }
  if (preferences.budget_ceiling !== void 0) {
    const raw = preferences.budget_ceiling;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      validated.budget_ceiling = raw;
    } else if (typeof raw === "string" && Number.isFinite(Number(raw))) {
      validated.budget_ceiling = Number(raw);
    } else {
      errors.push("budget_ceiling must be a finite number");
    }
  }
  if (preferences.budget_enforcement !== void 0) {
    const validModes = /* @__PURE__ */ new Set(["warn", "pause", "halt"]);
    if (typeof preferences.budget_enforcement === "string" && validModes.has(preferences.budget_enforcement)) {
      validated.budget_enforcement = preferences.budget_enforcement;
    } else {
      errors.push(`budget_enforcement must be one of: warn, pause, halt`);
    }
  }
  if (preferences.uok !== void 0) {
    if (typeof preferences.uok === "object" && preferences.uok !== null) {
      const raw = preferences.uok;
      const valid = {};
      if (raw.enabled !== void 0) {
        if (typeof raw.enabled === "boolean") valid.enabled = raw.enabled;
        else errors.push("uok.enabled must be a boolean");
      }
      const parseEnabledBlock = (key) => {
        const value = raw[key];
        if (value === void 0) return;
        if (typeof value !== "object" || value === null) {
          errors.push(`uok.${key} must be an object`);
          return;
        }
        const block = value;
        const parsed = {};
        if (block.enabled !== void 0) {
          if (typeof block.enabled === "boolean") parsed.enabled = block.enabled;
          else errors.push(`uok.${key}.enabled must be a boolean`);
        }
        const unknown = Object.keys(block).filter((k) => k !== "enabled");
        for (const unk of unknown) {
          warnings.push(`unknown uok.${key} key "${unk}" \u2014 ignored`);
        }
        if (Object.keys(parsed).length > 0) {
          valid[key] = parsed;
        }
      };
      parseEnabledBlock("legacy_fallback");
      parseEnabledBlock("gates");
      parseEnabledBlock("model_policy");
      parseEnabledBlock("execution_graph");
      parseEnabledBlock("audit_unified");
      parseEnabledBlock("plan_v2");
      if (raw.gitops !== void 0) {
        if (typeof raw.gitops !== "object" || raw.gitops === null) {
          errors.push("uok.gitops must be an object");
        } else {
          const gitops = raw.gitops;
          const parsed = {};
          if (gitops.enabled !== void 0) {
            if (typeof gitops.enabled === "boolean") parsed.enabled = gitops.enabled;
            else errors.push("uok.gitops.enabled must be a boolean");
          }
          if (gitops.turn_action !== void 0) {
            if (typeof gitops.turn_action === "string" && VALID_UOK_TURN_ACTIONS.has(gitops.turn_action)) {
              parsed.turn_action = gitops.turn_action;
            } else {
              errors.push("uok.gitops.turn_action must be one of: commit, snapshot, status-only");
            }
          }
          if (gitops.turn_push !== void 0) {
            if (typeof gitops.turn_push === "boolean") parsed.turn_push = gitops.turn_push;
            else errors.push("uok.gitops.turn_push must be a boolean");
          }
          const unknown = Object.keys(gitops).filter((k) => !["enabled", "turn_action", "turn_push"].includes(k));
          for (const unk of unknown) {
            warnings.push(`unknown uok.gitops key "${unk}" \u2014 ignored`);
          }
          if (Object.keys(parsed).length > 0) {
            valid.gitops = parsed;
          }
        }
      }
      const knownUokKeys = /* @__PURE__ */ new Set([
        "enabled",
        "legacy_fallback",
        "gates",
        "model_policy",
        "execution_graph",
        "gitops",
        "audit_unified",
        "plan_v2"
      ]);
      for (const key of Object.keys(raw)) {
        if (!knownUokKeys.has(key)) {
          warnings.push(`unknown uok key "${key}" \u2014 ignored`);
        }
      }
      if (Object.keys(valid).length > 0) {
        validated.uok = valid;
      }
    } else {
      errors.push("uok must be an object");
    }
  }
  if (preferences.token_profile !== void 0) {
    if (typeof preferences.token_profile === "string" && VALID_TOKEN_PROFILES.has(preferences.token_profile)) {
      validated.token_profile = preferences.token_profile;
    } else {
      errors.push(`token_profile must be one of: budget, balanced, quality, burn-max`);
    }
  }
  if (preferences.planning_depth !== void 0) {
    if (preferences.planning_depth === "light" || preferences.planning_depth === "deep") {
      validated.planning_depth = preferences.planning_depth;
    } else {
      errors.push(`planning_depth must be "light" or "deep"`);
    }
  }
  if (preferences.search_provider !== void 0) {
    const validSearchProviders = /* @__PURE__ */ new Set(["brave", "tavily", "ollama", "native", "auto"]);
    if (typeof preferences.search_provider === "string" && validSearchProviders.has(preferences.search_provider)) {
      validated.search_provider = preferences.search_provider;
    } else {
      errors.push(`search_provider must be one of: brave, tavily, ollama, native, auto`);
    }
  }
  if (preferences.flat_rate_providers !== void 0) {
    if (Array.isArray(preferences.flat_rate_providers)) {
      const allStrings = preferences.flat_rate_providers.every(
        (item) => typeof item === "string"
      );
      if (allStrings) {
        validated.flat_rate_providers = preferences.flat_rate_providers.map((s) => s.trim()).filter((s) => s.length > 0);
      } else {
        errors.push("flat_rate_providers must be an array of strings");
      }
    } else {
      errors.push("flat_rate_providers must be an array of strings");
    }
  }
  if (preferences.phases !== void 0) {
    if (typeof preferences.phases === "object" && preferences.phases !== null) {
      const validatedPhases = {};
      const p = preferences.phases;
      const parseStrictBoolean = (key, raw) => {
        if (typeof raw === "boolean") return raw;
        if (typeof raw === "string") {
          if (raw === "true") return true;
          if (raw === "false") return false;
        }
        warnings.push(`phases.${key} must be a boolean (got ${typeof raw}: ${JSON.stringify(raw)}) \u2014 ignored`);
        return void 0;
      };
      const assignBool = (key, raw) => {
        const v = parseStrictBoolean(String(key), raw);
        if (v !== void 0) validatedPhases[key] = v;
      };
      if (p.skip_research !== void 0) assignBool("skip_research", p.skip_research);
      if (p.skip_reassess !== void 0) assignBool("skip_reassess", p.skip_reassess);
      if (p.skip_slice_research !== void 0) assignBool("skip_slice_research", p.skip_slice_research);
      if (p.skip_milestone_validation !== void 0) assignBool("skip_milestone_validation", p.skip_milestone_validation);
      if (p.reassess_after_slice !== void 0) assignBool("reassess_after_slice", p.reassess_after_slice);
      if (p.require_slice_discussion !== void 0) {
        const v = parseStrictBoolean("require_slice_discussion", p.require_slice_discussion);
        if (v !== void 0) validatedPhases.require_slice_discussion = v;
      }
      if (p.mid_execution_escalation !== void 0) assignBool("mid_execution_escalation", p.mid_execution_escalation);
      if (p.progressive_planning !== void 0) assignBool("progressive_planning", p.progressive_planning);
      const knownPhaseKeys = /* @__PURE__ */ new Set(["skip_research", "skip_reassess", "skip_slice_research", "skip_milestone_validation", "reassess_after_slice", "require_slice_discussion", "mid_execution_escalation", "progressive_planning"]);
      for (const key of Object.keys(p)) {
        if (!knownPhaseKeys.has(key)) {
          warnings.push(`unknown phases key "${key}" \u2014 ignored`);
        }
      }
      validated.phases = validatedPhases;
    } else {
      errors.push(`phases must be an object`);
    }
  }
  if (preferences.context_pause_threshold !== void 0) {
    const raw = preferences.context_pause_threshold;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      validated.context_pause_threshold = raw;
    } else if (typeof raw === "string" && Number.isFinite(Number(raw))) {
      validated.context_pause_threshold = Number(raw);
    } else {
      errors.push("context_pause_threshold must be a finite number");
    }
  }
  if (preferences.models !== void 0) {
    if (preferences.models && typeof preferences.models === "object") {
      validated.models = preferences.models;
    } else {
      errors.push("models must be an object");
    }
  }
  if (preferences.auto_supervisor !== void 0) {
    if (preferences.auto_supervisor && typeof preferences.auto_supervisor === "object") {
      validated.auto_supervisor = preferences.auto_supervisor;
    } else {
      errors.push("auto_supervisor must be an object");
    }
  }
  if (preferences.notifications !== void 0) {
    if (preferences.notifications && typeof preferences.notifications === "object") {
      validated.notifications = preferences.notifications;
    } else {
      errors.push("notifications must be an object");
    }
  }
  if (preferences.cmux !== void 0) {
    if (preferences.cmux && typeof preferences.cmux === "object") {
      const cmux = preferences.cmux;
      const validatedCmux = {};
      if (cmux.enabled !== void 0) validatedCmux.enabled = !!cmux.enabled;
      if (cmux.notifications !== void 0) validatedCmux.notifications = !!cmux.notifications;
      if (cmux.sidebar !== void 0) validatedCmux.sidebar = !!cmux.sidebar;
      if (cmux.splits !== void 0) validatedCmux.splits = !!cmux.splits;
      if (cmux.browser !== void 0) validatedCmux.browser = !!cmux.browser;
      const knownCmuxKeys = /* @__PURE__ */ new Set(["enabled", "notifications", "sidebar", "splits", "browser"]);
      for (const key of Object.keys(cmux)) {
        if (!knownCmuxKeys.has(key)) {
          warnings.push(`unknown cmux key "${key}" \u2014 ignored`);
        }
      }
      if (Object.keys(validatedCmux).length > 0) {
        validated.cmux = validatedCmux;
      }
    } else {
      errors.push("cmux must be an object");
    }
  }
  if (preferences.remote_questions !== void 0) {
    if (preferences.remote_questions && typeof preferences.remote_questions === "object") {
      validated.remote_questions = preferences.remote_questions;
    } else {
      errors.push("remote_questions must be an object");
    }
  }
  if (preferences.post_unit_hooks && Array.isArray(preferences.post_unit_hooks)) {
    const validHooks = [];
    const seenNames = /* @__PURE__ */ new Set();
    const knownUnitTypes = new Set(KNOWN_UNIT_LABELS);
    for (const hook of preferences.post_unit_hooks) {
      if (!hook || typeof hook !== "object") {
        errors.push("post_unit_hooks entry must be an object");
        continue;
      }
      const name = typeof hook.name === "string" ? hook.name.trim() : "";
      if (!name) {
        errors.push("post_unit_hooks entry missing name");
        continue;
      }
      if (seenNames.has(name)) {
        errors.push(`duplicate post_unit_hooks name: ${name}`);
        continue;
      }
      const after = normalizeStringArray(hook.after);
      if (after.length === 0) {
        errors.push(`post_unit_hooks "${name}" missing after`);
        continue;
      }
      for (const ut of after) {
        if (!knownUnitTypes.has(ut)) {
          errors.push(`post_unit_hooks "${name}" unknown unit type in after: ${ut}`);
        }
      }
      const prompt = typeof hook.prompt === "string" ? hook.prompt.trim() : "";
      if (!prompt) {
        errors.push(`post_unit_hooks "${name}" missing prompt`);
        continue;
      }
      const validHook = { name, after, prompt };
      if (hook.max_cycles !== void 0) {
        const mc = typeof hook.max_cycles === "number" ? hook.max_cycles : Number(hook.max_cycles);
        validHook.max_cycles = Number.isFinite(mc) ? Math.max(1, Math.min(10, Math.round(mc))) : 1;
      }
      if (typeof hook.model === "string" && hook.model.trim()) {
        validHook.model = hook.model.trim();
      }
      if (typeof hook.artifact === "string" && hook.artifact.trim()) {
        validHook.artifact = hook.artifact.trim();
      }
      if (typeof hook.retry_on === "string" && hook.retry_on.trim()) {
        validHook.retry_on = hook.retry_on.trim();
      }
      if (typeof hook.agent === "string" && hook.agent.trim()) {
        validHook.agent = hook.agent.trim();
      }
      if (hook.enabled !== void 0) {
        validHook.enabled = !!hook.enabled;
      }
      seenNames.add(name);
      validHooks.push(validHook);
    }
    if (validHooks.length > 0) {
      validated.post_unit_hooks = validHooks;
    }
  }
  if (preferences.pre_dispatch_hooks && Array.isArray(preferences.pre_dispatch_hooks)) {
    const validPreHooks = [];
    const seenPreNames = /* @__PURE__ */ new Set();
    const knownUnitTypes = new Set(KNOWN_UNIT_LABELS);
    const validActions = /* @__PURE__ */ new Set(["modify", "skip", "replace"]);
    for (const hook of preferences.pre_dispatch_hooks) {
      if (!hook || typeof hook !== "object") {
        errors.push("pre_dispatch_hooks entry must be an object");
        continue;
      }
      const name = typeof hook.name === "string" ? hook.name.trim() : "";
      if (!name) {
        errors.push("pre_dispatch_hooks entry missing name");
        continue;
      }
      if (seenPreNames.has(name)) {
        errors.push(`duplicate pre_dispatch_hooks name: ${name}`);
        continue;
      }
      const before = normalizeStringArray(hook.before);
      if (before.length === 0) {
        errors.push(`pre_dispatch_hooks "${name}" missing before`);
        continue;
      }
      for (const ut of before) {
        if (!knownUnitTypes.has(ut)) {
          errors.push(`pre_dispatch_hooks "${name}" unknown unit type in before: ${ut}`);
        }
      }
      const action = typeof hook.action === "string" ? hook.action.trim() : "";
      if (!validActions.has(action)) {
        errors.push(`pre_dispatch_hooks "${name}" invalid action: ${action} (must be modify, skip, or replace)`);
        continue;
      }
      const validHook = { name, before, action };
      if (typeof hook.prepend === "string" && hook.prepend.trim()) validHook.prepend = hook.prepend.trim();
      if (typeof hook.append === "string" && hook.append.trim()) validHook.append = hook.append.trim();
      if (typeof hook.prompt === "string" && hook.prompt.trim()) validHook.prompt = hook.prompt.trim();
      if (typeof hook.unit_type === "string" && hook.unit_type.trim()) validHook.unit_type = hook.unit_type.trim();
      if (typeof hook.skip_if === "string" && hook.skip_if.trim()) validHook.skip_if = hook.skip_if.trim();
      if (typeof hook.model === "string" && hook.model.trim()) validHook.model = hook.model.trim();
      if (hook.enabled !== void 0) validHook.enabled = !!hook.enabled;
      if (action === "replace" && !validHook.prompt) {
        errors.push(`pre_dispatch_hooks "${name}" action "replace" requires prompt`);
        continue;
      }
      if (action === "modify" && !validHook.prepend && !validHook.append) {
        errors.push(`pre_dispatch_hooks "${name}" action "modify" requires prepend or append`);
        continue;
      }
      seenPreNames.add(name);
      validPreHooks.push(validHook);
    }
    if (validPreHooks.length > 0) {
      validated.pre_dispatch_hooks = validPreHooks;
    }
  }
  if (preferences.dynamic_routing !== void 0) {
    if (typeof preferences.dynamic_routing === "object" && preferences.dynamic_routing !== null) {
      const dr = preferences.dynamic_routing;
      const validDr = {};
      if (dr.enabled !== void 0) {
        if (typeof dr.enabled === "boolean") validDr.enabled = dr.enabled;
        else errors.push("dynamic_routing.enabled must be a boolean");
      }
      if (dr.escalate_on_failure !== void 0) {
        if (typeof dr.escalate_on_failure === "boolean") validDr.escalate_on_failure = dr.escalate_on_failure;
        else errors.push("dynamic_routing.escalate_on_failure must be a boolean");
      }
      if (dr.budget_pressure !== void 0) {
        if (typeof dr.budget_pressure === "boolean") validDr.budget_pressure = dr.budget_pressure;
        else errors.push("dynamic_routing.budget_pressure must be a boolean");
      }
      if (dr.cross_provider !== void 0) {
        if (typeof dr.cross_provider === "boolean") validDr.cross_provider = dr.cross_provider;
        else errors.push("dynamic_routing.cross_provider must be a boolean");
      }
      if (dr.hooks !== void 0) {
        if (typeof dr.hooks === "boolean") validDr.hooks = dr.hooks;
        else errors.push("dynamic_routing.hooks must be a boolean");
      }
      if (dr.capability_routing !== void 0) {
        if (typeof dr.capability_routing === "boolean") validDr.capability_routing = dr.capability_routing;
        else errors.push("dynamic_routing.capability_routing must be a boolean");
      }
      if (dr.allow_flat_rate_providers !== void 0) {
        if (typeof dr.allow_flat_rate_providers === "boolean") validDr.allow_flat_rate_providers = dr.allow_flat_rate_providers;
        else errors.push("dynamic_routing.allow_flat_rate_providers must be a boolean");
      }
      if (dr.tier_models !== void 0) {
        if (typeof dr.tier_models === "object" && dr.tier_models !== null) {
          const tm = dr.tier_models;
          const validTm = {};
          for (const tier of ["light", "standard", "heavy"]) {
            if (tm[tier] !== void 0) {
              if (typeof tm[tier] === "string") validTm[tier] = tm[tier];
              else errors.push(`dynamic_routing.tier_models.${tier} must be a string`);
            }
          }
          if (Object.keys(validTm).length > 0) validDr.tier_models = validTm;
        } else {
          errors.push("dynamic_routing.tier_models must be an object");
        }
      }
      if (Object.keys(validDr).length > 0) {
        validated.dynamic_routing = validDr;
      }
    } else {
      errors.push("dynamic_routing must be an object");
    }
  }
  if (preferences.disabled_model_providers !== void 0) {
    if (Array.isArray(preferences.disabled_model_providers)) {
      const allStrings = preferences.disabled_model_providers.every(
        (provider) => typeof provider === "string"
      );
      if (!allStrings) {
        errors.push("disabled_model_providers must be an array of strings");
      } else {
        const normalized = preferences.disabled_model_providers.map((provider) => provider.trim()).filter((provider) => provider.length > 0);
        if (normalized.length > 0) {
          validated.disabled_model_providers = Array.from(new Set(normalized));
        }
      }
    } else {
      errors.push("disabled_model_providers must be an array of strings");
    }
  }
  if (preferences.context_management !== void 0) {
    if (typeof preferences.context_management === "object" && preferences.context_management !== null) {
      const cm = preferences.context_management;
      const validCm = {};
      if (cm.observation_masking !== void 0) {
        if (typeof cm.observation_masking === "boolean") validCm.observation_masking = cm.observation_masking;
        else errors.push("context_management.observation_masking must be a boolean");
      }
      if (cm.observation_mask_turns !== void 0) {
        const turns = cm.observation_mask_turns;
        if (typeof turns === "number" && turns >= 1 && turns <= 50) validCm.observation_mask_turns = turns;
        else errors.push("context_management.observation_mask_turns must be a number between 1 and 50");
      }
      if (cm.compaction_threshold_percent !== void 0) {
        const pct = cm.compaction_threshold_percent;
        if (typeof pct === "number" && pct >= 0.5 && pct <= 0.95) validCm.compaction_threshold_percent = pct;
        else errors.push("context_management.compaction_threshold_percent must be a number between 0.5 and 0.95");
      }
      if (cm.tool_result_max_chars !== void 0) {
        const chars = cm.tool_result_max_chars;
        if (typeof chars === "number" && chars >= 200 && chars <= 1e4) validCm.tool_result_max_chars = chars;
        else errors.push("context_management.tool_result_max_chars must be a number between 200 and 10000");
      }
      if (Object.keys(validCm).length > 0) {
        validated.context_management = validCm;
      }
    } else {
      errors.push("context_management must be an object");
    }
  }
  if (preferences.context_mode !== void 0) {
    if (typeof preferences.context_mode === "object" && preferences.context_mode !== null) {
      const cmode = preferences.context_mode;
      const validCmode = {};
      if (cmode.enabled !== void 0) {
        if (typeof cmode.enabled === "boolean") validCmode.enabled = cmode.enabled;
        else errors.push("context_mode.enabled must be a boolean");
      }
      if (cmode.exec_timeout_ms !== void 0) {
        const t = cmode.exec_timeout_ms;
        if (typeof t === "number" && t >= 1e3 && t <= 6e5) validCmode.exec_timeout_ms = Math.floor(t);
        else errors.push("context_mode.exec_timeout_ms must be a number between 1000 and 600000");
      }
      if (cmode.exec_stdout_cap_bytes !== void 0) {
        const b = cmode.exec_stdout_cap_bytes;
        if (typeof b === "number" && b >= 4096 && b <= 16777216) validCmode.exec_stdout_cap_bytes = Math.floor(b);
        else errors.push("context_mode.exec_stdout_cap_bytes must be a number between 4096 and 16777216");
      }
      if (cmode.exec_digest_chars !== void 0) {
        const c = cmode.exec_digest_chars;
        if (typeof c === "number" && c >= 0 && c <= 4e3) validCmode.exec_digest_chars = Math.floor(c);
        else errors.push("context_mode.exec_digest_chars must be a number between 0 and 4000");
      }
      if (cmode.exec_env_allowlist !== void 0) {
        if (Array.isArray(cmode.exec_env_allowlist) && cmode.exec_env_allowlist.every((v) => typeof v === "string" && /^[A-Z_][A-Z0-9_]*$/i.test(v))) {
          validCmode.exec_env_allowlist = cmode.exec_env_allowlist;
        } else {
          errors.push("context_mode.exec_env_allowlist must be an array of valid env var names");
        }
      }
      if (Object.keys(validCmode).length > 0) {
        validated.context_mode = validCmode;
      }
    } else {
      errors.push("context_mode must be an object");
    }
  }
  if (preferences.parallel && typeof preferences.parallel === "object") {
    const p = preferences.parallel;
    const parallel = {};
    if (p.enabled !== void 0) {
      if (typeof p.enabled === "boolean") parallel.enabled = p.enabled;
      else errors.push("parallel.enabled must be a boolean");
    }
    if (p.max_workers !== void 0) {
      if (typeof p.max_workers === "number" && p.max_workers >= 1 && p.max_workers <= 4) {
        parallel.max_workers = Math.floor(p.max_workers);
      } else {
        errors.push("parallel.max_workers must be a number between 1 and 4");
      }
    }
    if (p.budget_ceiling !== void 0) {
      if (typeof p.budget_ceiling === "number" && p.budget_ceiling > 0) {
        parallel.budget_ceiling = p.budget_ceiling;
      } else {
        errors.push("parallel.budget_ceiling must be a positive number");
      }
    }
    if (p.merge_strategy !== void 0) {
      const validStrategies = /* @__PURE__ */ new Set(["per-slice", "per-milestone"]);
      if (typeof p.merge_strategy === "string" && validStrategies.has(p.merge_strategy)) {
        parallel.merge_strategy = p.merge_strategy;
      } else {
        errors.push("parallel.merge_strategy must be one of: per-slice, per-milestone");
      }
    }
    if (p.auto_merge !== void 0) {
      const validModes = /* @__PURE__ */ new Set(["auto", "confirm", "manual"]);
      if (typeof p.auto_merge === "string" && validModes.has(p.auto_merge)) {
        parallel.auto_merge = p.auto_merge;
      } else {
        errors.push("parallel.auto_merge must be one of: auto, confirm, manual");
      }
    }
    if (p.worker_model !== void 0) {
      if (typeof p.worker_model === "string" && p.worker_model.length > 0) {
        parallel.worker_model = p.worker_model;
      } else {
        errors.push("parallel.worker_model must be a non-empty string");
      }
    }
    if (Object.keys(parallel).length > 0) {
      validated.parallel = parallel;
    }
  }
  if (preferences.slice_parallel !== void 0) {
    if (typeof preferences.slice_parallel === "object" && preferences.slice_parallel !== null) {
      const sp = preferences.slice_parallel;
      const validSp = {};
      if (sp.enabled !== void 0) {
        if (typeof sp.enabled === "boolean") validSp.enabled = sp.enabled;
        else errors.push("slice_parallel.enabled must be a boolean");
      }
      if (sp.max_workers !== void 0) {
        const maxWorkers = typeof sp.max_workers === "number" ? sp.max_workers : Number(sp.max_workers);
        if (Number.isFinite(maxWorkers) && maxWorkers >= 1 && maxWorkers <= 8) {
          validSp.max_workers = Math.floor(maxWorkers);
        } else {
          errors.push("slice_parallel.max_workers must be a number between 1 and 8");
        }
      }
      const knownSliceParallelKeys = /* @__PURE__ */ new Set(["enabled", "max_workers"]);
      for (const key of Object.keys(sp)) {
        if (!knownSliceParallelKeys.has(key)) {
          warnings.push(`unknown slice_parallel key "${key}" \u2014 ignored`);
        }
      }
      if (Object.keys(validSp).length > 0) {
        validated.slice_parallel = validSp;
      }
    } else {
      errors.push("slice_parallel must be an object");
    }
  }
  if (preferences.reactive_execution !== void 0) {
    if (typeof preferences.reactive_execution === "object" && preferences.reactive_execution !== null) {
      const re = preferences.reactive_execution;
      const validRe = {};
      if (re.enabled !== void 0) {
        if (typeof re.enabled === "boolean") validRe.enabled = re.enabled;
        else errors.push("reactive_execution.enabled must be a boolean");
      }
      if (re.max_parallel !== void 0) {
        const mp = typeof re.max_parallel === "number" ? re.max_parallel : Number(re.max_parallel);
        if (Number.isFinite(mp) && mp >= 1 && mp <= 8) {
          validRe.max_parallel = Math.floor(mp);
        } else {
          errors.push("reactive_execution.max_parallel must be a number between 1 and 8");
        }
      }
      if (re.isolation_mode !== void 0) {
        if (re.isolation_mode === "same-tree") {
          validRe.isolation_mode = "same-tree";
        } else {
          errors.push('reactive_execution.isolation_mode must be "same-tree"');
        }
      }
      if (re.subagent_model !== void 0) {
        if (typeof re.subagent_model === "string" && re.subagent_model.length > 0) {
          validRe.subagent_model = re.subagent_model;
        } else {
          errors.push("reactive_execution.subagent_model must be a non-empty string");
        }
      }
      const knownReKeys = /* @__PURE__ */ new Set(["enabled", "max_parallel", "isolation_mode", "subagent_model"]);
      for (const key of Object.keys(re)) {
        if (!knownReKeys.has(key)) {
          warnings.push(`unknown reactive_execution key "${key}" \u2014 ignored`);
        }
      }
      if (Object.keys(validRe).length > 0) {
        validated.reactive_execution = validRe;
      }
    } else {
      errors.push("reactive_execution must be an object");
    }
  }
  if (preferences.gate_evaluation !== void 0) {
    if (typeof preferences.gate_evaluation === "object" && preferences.gate_evaluation !== null) {
      const ge = preferences.gate_evaluation;
      const validGe = {};
      if (ge.enabled !== void 0) {
        if (typeof ge.enabled === "boolean") validGe.enabled = ge.enabled;
        else errors.push("gate_evaluation.enabled must be a boolean");
      }
      if (ge.slice_gates !== void 0) {
        if (Array.isArray(ge.slice_gates) && ge.slice_gates.every((g) => typeof g === "string")) {
          validGe.slice_gates = ge.slice_gates;
        } else {
          errors.push("gate_evaluation.slice_gates must be an array of strings");
        }
      }
      if (ge.task_gates !== void 0) {
        if (typeof ge.task_gates === "boolean") validGe.task_gates = ge.task_gates;
        else errors.push("gate_evaluation.task_gates must be a boolean");
      }
      const knownGeKeys = /* @__PURE__ */ new Set(["enabled", "slice_gates", "task_gates"]);
      for (const key of Object.keys(ge)) {
        if (!knownGeKeys.has(key)) {
          warnings.push(`unknown gate_evaluation key "${key}" \u2014 ignored`);
        }
      }
      if (Object.keys(validGe).length > 0) {
        validated.gate_evaluation = validGe;
      }
    } else {
      errors.push("gate_evaluation must be an object");
    }
  }
  if (preferences.verification_commands !== void 0) {
    if (Array.isArray(preferences.verification_commands)) {
      const allStrings = preferences.verification_commands.every(
        (item) => typeof item === "string"
      );
      if (allStrings) {
        validated.verification_commands = preferences.verification_commands;
      } else {
        errors.push("verification_commands must be an array of strings");
      }
    } else {
      errors.push("verification_commands must be an array of strings");
    }
  }
  if (preferences.verification_auto_fix !== void 0) {
    if (typeof preferences.verification_auto_fix === "boolean") {
      validated.verification_auto_fix = preferences.verification_auto_fix;
    } else {
      errors.push("verification_auto_fix must be a boolean");
    }
  }
  if (preferences.verification_max_retries !== void 0) {
    const raw = preferences.verification_max_retries;
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
      validated.verification_max_retries = Math.floor(raw);
    } else {
      errors.push("verification_max_retries must be a non-negative number");
    }
  }
  if (preferences.git && typeof preferences.git === "object") {
    const git = {};
    const g = preferences.git;
    if (g.auto_push !== void 0) {
      if (typeof g.auto_push === "boolean") git.auto_push = g.auto_push;
      else errors.push("git.auto_push must be a boolean");
    }
    if (g.push_branches !== void 0) {
      if (typeof g.push_branches === "boolean") git.push_branches = g.push_branches;
      else errors.push("git.push_branches must be a boolean");
    }
    if (g.remote !== void 0) {
      if (typeof g.remote === "string" && g.remote.trim() !== "") git.remote = g.remote.trim();
      else errors.push("git.remote must be a non-empty string");
    }
    if (g.snapshots !== void 0) {
      if (typeof g.snapshots === "boolean") git.snapshots = g.snapshots;
      else errors.push("git.snapshots must be a boolean");
    }
    if (g.pre_merge_check !== void 0) {
      if (typeof g.pre_merge_check === "boolean") {
        git.pre_merge_check = g.pre_merge_check;
      } else if (typeof g.pre_merge_check === "string" && g.pre_merge_check.trim() !== "") {
        git.pre_merge_check = g.pre_merge_check.trim();
      } else {
        errors.push("git.pre_merge_check must be a boolean or a non-empty string command");
      }
    }
    if (g.commit_type !== void 0) {
      const validCommitTypes = /* @__PURE__ */ new Set([
        "feat",
        "fix",
        "refactor",
        "docs",
        "test",
        "chore",
        "perf",
        "ci",
        "build",
        "style"
      ]);
      if (typeof g.commit_type === "string" && validCommitTypes.has(g.commit_type)) {
        git.commit_type = g.commit_type;
      } else {
        errors.push(`git.commit_type must be one of: feat, fix, refactor, docs, test, chore, perf, ci, build, style`);
      }
    }
    if (g.merge_strategy !== void 0) {
      const validStrategies = /* @__PURE__ */ new Set(["squash", "merge"]);
      if (typeof g.merge_strategy === "string" && validStrategies.has(g.merge_strategy)) {
        git.merge_strategy = g.merge_strategy;
      } else {
        errors.push("git.merge_strategy must be one of: squash, merge");
      }
    }
    if (g.main_branch !== void 0) {
      if (typeof g.main_branch === "string" && g.main_branch.trim() !== "" && VALID_BRANCH_NAME.test(g.main_branch)) {
        git.main_branch = g.main_branch;
      } else {
        errors.push("git.main_branch must be a valid branch name (alphanumeric, _, -, /, .)");
      }
    }
    if (g.isolation !== void 0) {
      const validIsolation = /* @__PURE__ */ new Set(["worktree", "branch", "none"]);
      if (typeof g.isolation === "string" && validIsolation.has(g.isolation)) {
        git.isolation = g.isolation;
      } else {
        errors.push("git.isolation must be one of: worktree, branch, none");
      }
    }
    if (g.commit_docs !== void 0) {
      warnings.push("git.commit_docs is deprecated \u2014 .gsd/ is managed externally and always gitignored. Remove this setting.");
    }
    if (g.manage_gitignore !== void 0) {
      if (typeof g.manage_gitignore === "boolean") git.manage_gitignore = g.manage_gitignore;
      else errors.push("git.manage_gitignore must be a boolean");
    }
    if (g.worktree_post_create !== void 0) {
      if (typeof g.worktree_post_create === "string" && g.worktree_post_create.trim()) {
        git.worktree_post_create = g.worktree_post_create.trim();
      } else {
        errors.push("git.worktree_post_create must be a non-empty string (path to script)");
      }
    }
    if (g.auto_pr !== void 0) {
      if (typeof g.auto_pr === "boolean") git.auto_pr = g.auto_pr;
      else errors.push("git.auto_pr must be a boolean");
    }
    if (g.pr_target_branch !== void 0) {
      if (typeof g.pr_target_branch === "string" && g.pr_target_branch.trim()) {
        git.pr_target_branch = g.pr_target_branch.trim();
      } else {
        errors.push("git.pr_target_branch must be a non-empty string (branch name)");
      }
    }
    if (g.merge_to_main !== void 0) {
      warnings.push("git.merge_to_main is deprecated \u2014 milestone-level merge is now always used. Remove this setting.");
    }
    if (g.collapse_cadence !== void 0) {
      const validCadence = /* @__PURE__ */ new Set(["milestone", "slice"]);
      if (typeof g.collapse_cadence === "string" && validCadence.has(g.collapse_cadence)) {
        git.collapse_cadence = g.collapse_cadence;
      } else {
        errors.push("git.collapse_cadence must be one of: milestone, slice");
      }
    }
    if (g.milestone_resquash !== void 0) {
      if (typeof g.milestone_resquash === "boolean") {
        git.milestone_resquash = g.milestone_resquash;
        const cadence = git.collapse_cadence ?? (typeof g.collapse_cadence === "string" ? g.collapse_cadence : void 0);
        if (cadence !== "slice") {
          warnings.push('git.milestone_resquash is ignored unless git.collapse_cadence is "slice"');
        }
      } else {
        errors.push("git.milestone_resquash must be a boolean");
      }
    }
    if (Object.keys(git).length > 0) {
      validated.git = git;
    }
  }
  if (preferences.auto_visualize !== void 0) {
    if (typeof preferences.auto_visualize === "boolean") {
      validated.auto_visualize = preferences.auto_visualize;
    } else {
      errors.push("auto_visualize must be a boolean");
    }
  }
  if (preferences.auto_report !== void 0) {
    if (typeof preferences.auto_report === "boolean") {
      validated.auto_report = preferences.auto_report;
    } else {
      errors.push("auto_report must be a boolean");
    }
  }
  if (preferences.context_selection !== void 0) {
    const validModes = /* @__PURE__ */ new Set(["full", "smart"]);
    if (typeof preferences.context_selection === "string" && validModes.has(preferences.context_selection)) {
      validated.context_selection = preferences.context_selection;
    } else {
      errors.push(`context_selection must be one of: full, smart`);
    }
  }
  if (preferences.github !== void 0) {
    if (typeof preferences.github === "object" && preferences.github !== null) {
      const gh = preferences.github;
      const validGh = {};
      if (gh.enabled !== void 0) {
        if (typeof gh.enabled === "boolean") validGh.enabled = gh.enabled;
        else errors.push("github.enabled must be a boolean");
      }
      if (gh.repo !== void 0) {
        if (typeof gh.repo === "string" && gh.repo.includes("/")) validGh.repo = gh.repo;
        else errors.push('github.repo must be a string in "owner/repo" format');
      }
      if (gh.project !== void 0) {
        const p = typeof gh.project === "number" ? gh.project : Number(gh.project);
        if (Number.isFinite(p) && p > 0) validGh.project = Math.floor(p);
        else errors.push("github.project must be a positive number");
      }
      if (gh.labels !== void 0) {
        if (Array.isArray(gh.labels) && gh.labels.every((l) => typeof l === "string")) {
          validGh.labels = gh.labels;
        } else {
          errors.push("github.labels must be an array of strings");
        }
      }
      if (gh.auto_link_commits !== void 0) {
        if (typeof gh.auto_link_commits === "boolean") validGh.auto_link_commits = gh.auto_link_commits;
        else errors.push("github.auto_link_commits must be a boolean");
      }
      if (gh.slice_prs !== void 0) {
        if (typeof gh.slice_prs === "boolean") validGh.slice_prs = gh.slice_prs;
        else errors.push("github.slice_prs must be a boolean");
      }
      const knownGhKeys = /* @__PURE__ */ new Set(["enabled", "repo", "project", "labels", "auto_link_commits", "slice_prs"]);
      for (const key of Object.keys(gh)) {
        if (!knownGhKeys.has(key)) {
          warnings.push(`unknown github key "${key}" \u2014 ignored`);
        }
      }
      if (Object.keys(validGh).length > 0) {
        validated.github = validGh;
      }
    } else {
      errors.push("github must be an object");
    }
  }
  if (preferences.show_token_cost !== void 0) {
    if (typeof preferences.show_token_cost === "boolean") {
      validated.show_token_cost = preferences.show_token_cost;
    } else {
      errors.push("show_token_cost must be a boolean");
    }
  }
  if (preferences.min_request_interval_ms !== void 0) {
    if (typeof preferences.min_request_interval_ms === "number" && Number.isFinite(preferences.min_request_interval_ms) && preferences.min_request_interval_ms >= 0 && preferences.min_request_interval_ms <= 2147483647) {
      validated.min_request_interval_ms = Math.floor(preferences.min_request_interval_ms);
    } else {
      errors.push("min_request_interval_ms must be a non-negative number <= 2147483647");
    }
  }
  if (preferences.experimental !== void 0) {
    if (typeof preferences.experimental === "object" && preferences.experimental !== null) {
      const exp = preferences.experimental;
      const validExp = {};
      if (exp.rtk !== void 0) {
        if (typeof exp.rtk === "boolean") validExp.rtk = exp.rtk;
        else errors.push("experimental.rtk must be a boolean");
      }
      const knownExpKeys = /* @__PURE__ */ new Set(["rtk"]);
      for (const key of Object.keys(exp)) {
        if (!knownExpKeys.has(key)) {
          warnings.push(`unknown experimental key "${key}" \u2014 ignored`);
        }
      }
      if (Object.keys(validExp).length > 0) {
        validated.experimental = validExp;
      }
    } else {
      errors.push("experimental must be an object");
    }
  }
  if (preferences.codebase !== void 0) {
    if (typeof preferences.codebase === "object" && preferences.codebase !== null) {
      const cb = preferences.codebase;
      const validCb = {};
      if (cb.exclude_patterns !== void 0) {
        if (Array.isArray(cb.exclude_patterns) && cb.exclude_patterns.every((p) => typeof p === "string")) {
          validCb.exclude_patterns = cb.exclude_patterns;
        } else {
          errors.push("codebase.exclude_patterns must be an array of strings");
        }
      }
      if (cb.max_files !== void 0) {
        const mf = typeof cb.max_files === "number" ? cb.max_files : Number(cb.max_files);
        if (Number.isFinite(mf) && mf >= 1) {
          validCb.max_files = Math.floor(mf);
        } else {
          errors.push("codebase.max_files must be a positive integer");
        }
      }
      if (cb.collapse_threshold !== void 0) {
        const ct = typeof cb.collapse_threshold === "number" ? cb.collapse_threshold : Number(cb.collapse_threshold);
        if (Number.isFinite(ct) && ct >= 1) {
          validCb.collapse_threshold = Math.floor(ct);
        } else {
          errors.push("codebase.collapse_threshold must be a positive integer");
        }
      }
      const knownCbKeys = /* @__PURE__ */ new Set(["exclude_patterns", "max_files", "collapse_threshold"]);
      for (const key of Object.keys(cb)) {
        if (!knownCbKeys.has(key)) {
          warnings.push(`unknown codebase key "${key}" \u2014 ignored`);
        }
      }
      if (Object.keys(validCb).length > 0) {
        validated.codebase = validCb;
      }
    } else {
      errors.push("codebase must be an object");
    }
  }
  if (preferences.claude_code_mcp !== void 0) {
    if (typeof preferences.claude_code_mcp === "object" && preferences.claude_code_mcp !== null) {
      const raw = preferences.claude_code_mcp;
      if (typeof raw.per_model !== "object" || raw.per_model === null || Array.isArray(raw.per_model)) {
        warnings.push("claude_code_mcp.per_model must be an object \u2014 ignoring claude_code_mcp");
      } else {
        const perModel = raw.per_model;
        const validPerModel = {};
        for (const [prefix, entry] of Object.entries(perModel)) {
          if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            warnings.push(`claude_code_mcp.per_model["${prefix}"] must be an object \u2014 ignoring entry`);
            continue;
          }
          const e = entry;
          const validEntry = {};
          for (const field of ["allowed_servers", "blocked_servers"]) {
            if (e[field] !== void 0) {
              if (Array.isArray(e[field]) && e[field].every((s) => typeof s === "string")) {
                validEntry[field] = e[field];
              } else {
                warnings.push(`claude_code_mcp.per_model["${prefix}"].${field} must be an array of strings \u2014 ignoring field`);
              }
            }
          }
          validPerModel[prefix] = validEntry;
        }
        validated.claude_code_mcp = { per_model: validPerModel };
      }
    } else {
      warnings.push("claude_code_mcp must be an object \u2014 ignoring");
    }
  }
  if (preferences.enhanced_verification !== void 0) {
    if (typeof preferences.enhanced_verification === "boolean") {
      validated.enhanced_verification = preferences.enhanced_verification;
    } else {
      errors.push("enhanced_verification must be a boolean");
    }
  }
  if (preferences.enhanced_verification_pre !== void 0) {
    if (typeof preferences.enhanced_verification_pre === "boolean") {
      validated.enhanced_verification_pre = preferences.enhanced_verification_pre;
    } else {
      errors.push("enhanced_verification_pre must be a boolean");
    }
  }
  if (preferences.enhanced_verification_post !== void 0) {
    if (typeof preferences.enhanced_verification_post === "boolean") {
      validated.enhanced_verification_post = preferences.enhanced_verification_post;
    } else {
      errors.push("enhanced_verification_post must be a boolean");
    }
  }
  if (preferences.enhanced_verification_strict !== void 0) {
    if (typeof preferences.enhanced_verification_strict === "boolean") {
      validated.enhanced_verification_strict = preferences.enhanced_verification_strict;
    } else {
      errors.push("enhanced_verification_strict must be a boolean");
    }
  }
  if (preferences.discuss_preparation !== void 0) {
    if (typeof preferences.discuss_preparation === "boolean") {
      validated.discuss_preparation = preferences.discuss_preparation;
    } else {
      errors.push("discuss_preparation must be a boolean");
    }
  }
  if (preferences.discuss_web_research !== void 0) {
    if (typeof preferences.discuss_web_research === "boolean") {
      validated.discuss_web_research = preferences.discuss_web_research;
    } else {
      errors.push("discuss_web_research must be a boolean");
    }
  }
  if (preferences.discuss_depth !== void 0) {
    const validDepths = /* @__PURE__ */ new Set(["quick", "standard", "thorough"]);
    if (typeof preferences.discuss_depth === "string" && validDepths.has(preferences.discuss_depth)) {
      validated.discuss_depth = preferences.discuss_depth;
    } else {
      errors.push(`discuss_depth must be one of: quick, standard, thorough`);
    }
  }
  if (preferences.language !== void 0) {
    const trimmed = typeof preferences.language === "string" ? preferences.language.trim() : void 0;
    if (trimmed && trimmed.length <= 50 && !/[\r\n]/.test(trimmed)) {
      validated.language = trimmed;
    } else {
      errors.push(`language must be a non-empty string up to 50 characters with no newlines (e.g. "Chinese", "de", "\u65E5\u672C\u8A9E")`);
    }
  }
  return { preferences: validated, errors, warnings };
}
export {
  validatePreferences
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9wcmVmZXJlbmNlcy12YWxpZGF0aW9uLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFZhbGlkYXRpb24gbG9naWMgZm9yIEdTRCBwcmVmZXJlbmNlcy5cbiAqXG4gKiBQdXJlIHZhbGlkYXRpb24gLS0gbm8gZmlsZXN5c3RlbSBhY2Nlc3MsIG5vIGxvYWRpbmcsIG5vIG1lcmdpbmcuXG4gKiBBY2NlcHRzIGEgcmF3IEdTRFByZWZlcmVuY2VzIG9iamVjdCBhbmQgcmV0dXJucyBhIHNhbml0aXplZCBjb3B5XG4gKiB0b2dldGhlciB3aXRoIGFueSBlcnJvcnMgYW5kIHdhcm5pbmdzLlxuICovXG5cbmltcG9ydCB0eXBlIHsgR2l0UHJlZmVyZW5jZXMgfSBmcm9tIFwiLi9naXQtc2VydmljZS5qc1wiO1xuaW1wb3J0IHR5cGUgeyBQb3N0VW5pdEhvb2tDb25maWcsIFByZURpc3BhdGNoSG9va0NvbmZpZywgVG9rZW5Qcm9maWxlLCBQaGFzZVNraXBQcmVmZXJlbmNlcyB9IGZyb20gXCIuL3R5cGVzLmpzXCI7XG5pbXBvcnQgdHlwZSB7IER5bmFtaWNSb3V0aW5nQ29uZmlnIH0gZnJvbSBcIi4vbW9kZWwtcm91dGVyLmpzXCI7XG5pbXBvcnQgeyBWQUxJRF9CUkFOQ0hfTkFNRSB9IGZyb20gXCIuL2dpdC1zZXJ2aWNlLmpzXCI7XG5pbXBvcnQgeyBub3JtYWxpemVTdHJpbmdBcnJheSB9IGZyb20gXCIuLi9zaGFyZWQvZm9ybWF0LXV0aWxzLmpzXCI7XG5cbmltcG9ydCB7XG4gIEtOT1dOX1BSRUZFUkVOQ0VfS0VZUyxcbiAgS05PV05fVU5JVF9MQUJFTFMsXG5cbiAgU0tJTExfQUNUSU9OUyxcbiAgdHlwZSBXb3JrZmxvd01vZGUsXG4gIHR5cGUgR1NEUHJlZmVyZW5jZXMsXG4gIHR5cGUgR1NEU2tpbGxSdWxlLFxufSBmcm9tIFwiLi9wcmVmZXJlbmNlcy10eXBlcy5qc1wiO1xuXG5jb25zdCBWQUxJRF9UT0tFTl9QUk9GSUxFUyA9IG5ldyBTZXQ8VG9rZW5Qcm9maWxlPihbXCJidWRnZXRcIiwgXCJiYWxhbmNlZFwiLCBcInF1YWxpdHlcIiwgXCJidXJuLW1heFwiXSk7XG5jb25zdCBWQUxJRF9VT0tfVFVSTl9BQ1RJT05TID0gbmV3IFNldDxcImNvbW1pdFwiIHwgXCJzbmFwc2hvdFwiIHwgXCJzdGF0dXMtb25seVwiPihbXG4gIFwiY29tbWl0XCIsXG4gIFwic25hcHNob3RcIixcbiAgXCJzdGF0dXMtb25seVwiLFxuXSk7XG5cbmV4cG9ydCBmdW5jdGlvbiB2YWxpZGF0ZVByZWZlcmVuY2VzKHByZWZlcmVuY2VzOiBHU0RQcmVmZXJlbmNlcyk6IHtcbiAgcHJlZmVyZW5jZXM6IEdTRFByZWZlcmVuY2VzO1xuICBlcnJvcnM6IHN0cmluZ1tdO1xuICB3YXJuaW5nczogc3RyaW5nW107XG59IHtcbiAgY29uc3QgZXJyb3JzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCB3YXJuaW5nczogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgdmFsaWRhdGVkOiBHU0RQcmVmZXJlbmNlcyA9IHt9O1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBVbmtub3duIEtleSBEZXRlY3Rpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIC8vIENvbW1vbiBrZXkgbWlncmF0aW9uIGhpbnRzIGZvciBwaS1sZXZlbCBzZXR0aW5ncyB0aGF0IGRvbid0IG1hcCB0byBHU0QgcHJlZnNcbiAgY29uc3QgS0VZX01JR1JBVElPTl9ISU5UUzogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgICB0YXNrSXNvbGF0aW9uOiAndXNlIFwiZ2l0Lmlzb2xhdGlvblwiIGluc3RlYWQgKHZhbHVlczogd29ya3RyZWUsIGJyYW5jaCwgbm9uZSknLFxuICAgIHRhc2tfaXNvbGF0aW9uOiAndXNlIFwiZ2l0Lmlzb2xhdGlvblwiIGluc3RlYWQgKHZhbHVlczogd29ya3RyZWUsIGJyYW5jaCwgbm9uZSknLFxuICAgIGlzb2xhdGlvbjogJ3VzZSBcImdpdC5pc29sYXRpb25cIiBpbnN0ZWFkICh2YWx1ZXM6IHdvcmt0cmVlLCBicmFuY2gsIG5vbmUpJyxcbiAgICBtYW5hZ2VfZ2l0aWdub3JlOiAndXNlIFwiZ2l0Lm1hbmFnZV9naXRpZ25vcmVcIiBpbnN0ZWFkJyxcbiAgICBhdXRvX3B1c2g6ICd1c2UgXCJnaXQuYXV0b19wdXNoXCIgaW5zdGVhZCcsXG4gICAgbWFpbl9icmFuY2g6ICd1c2UgXCJnaXQubWFpbl9icmFuY2hcIiBpbnN0ZWFkJyxcbiAgfTtcblxuICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhwcmVmZXJlbmNlcykpIHtcbiAgICBpZiAoIUtOT1dOX1BSRUZFUkVOQ0VfS0VZUy5oYXMoa2V5KSkge1xuICAgICAgY29uc3QgaGludCA9IEtFWV9NSUdSQVRJT05fSElOVFNba2V5XTtcbiAgICAgIGlmIChoaW50KSB7XG4gICAgICAgIHdhcm5pbmdzLnB1c2goYHVua25vd24gcHJlZmVyZW5jZSBrZXkgXCIke2tleX1cIiBcdTIwMTQgJHtoaW50fWApO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgd2FybmluZ3MucHVzaChgdW5rbm93biBwcmVmZXJlbmNlIGtleSBcIiR7a2V5fVwiIFx1MjAxNCBpZ25vcmVkYCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgaWYgKHByZWZlcmVuY2VzLnZlcnNpb24gIT09IHVuZGVmaW5lZCkge1xuICAgIGlmIChwcmVmZXJlbmNlcy52ZXJzaW9uID09PSAxKSB7XG4gICAgICB2YWxpZGF0ZWQudmVyc2lvbiA9IDE7XG4gICAgfSBlbHNlIHtcbiAgICAgIGVycm9ycy5wdXNoKGB1bnN1cHBvcnRlZCB2ZXJzaW9uICR7cHJlZmVyZW5jZXMudmVyc2lvbn1gKTtcbiAgICB9XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgV29ya2Zsb3cgTW9kZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgaWYgKHByZWZlcmVuY2VzLm1vZGUgIT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IHZhbGlkTW9kZXMgPSBuZXcgU2V0PHN0cmluZz4oW1wic29sb1wiLCBcInRlYW1cIl0pO1xuICAgIGlmICh0eXBlb2YgcHJlZmVyZW5jZXMubW9kZSA9PT0gXCJzdHJpbmdcIiAmJiB2YWxpZE1vZGVzLmhhcyhwcmVmZXJlbmNlcy5tb2RlKSkge1xuICAgICAgdmFsaWRhdGVkLm1vZGUgPSBwcmVmZXJlbmNlcy5tb2RlIGFzIFdvcmtmbG93TW9kZTtcbiAgICB9IGVsc2Uge1xuICAgICAgZXJyb3JzLnB1c2goYGludmFsaWQgbW9kZSBcIiR7cHJlZmVyZW5jZXMubW9kZX1cIiBcdTIwMTQgbXVzdCBiZSBvbmUgb2Y6IHNvbG8sIHRlYW1gKTtcbiAgICB9XG4gIH1cblxuICBjb25zdCB2YWxpZERpc2NvdmVyeU1vZGVzID0gbmV3IFNldChbXCJhdXRvXCIsIFwic3VnZ2VzdFwiLCBcIm9mZlwiXSk7XG4gIGlmIChwcmVmZXJlbmNlcy5za2lsbF9kaXNjb3ZlcnkpIHtcbiAgICBpZiAodmFsaWREaXNjb3ZlcnlNb2Rlcy5oYXMocHJlZmVyZW5jZXMuc2tpbGxfZGlzY292ZXJ5KSkge1xuICAgICAgdmFsaWRhdGVkLnNraWxsX2Rpc2NvdmVyeSA9IHByZWZlcmVuY2VzLnNraWxsX2Rpc2NvdmVyeTtcbiAgICB9IGVsc2Uge1xuICAgICAgZXJyb3JzLnB1c2goYGludmFsaWQgc2tpbGxfZGlzY292ZXJ5IHZhbHVlOiAke3ByZWZlcmVuY2VzLnNraWxsX2Rpc2NvdmVyeX1gKTtcbiAgICB9XG4gIH1cblxuICBpZiAocHJlZmVyZW5jZXMuc2tpbGxfc3RhbGVuZXNzX2RheXMgIT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IGRheXMgPSBOdW1iZXIocHJlZmVyZW5jZXMuc2tpbGxfc3RhbGVuZXNzX2RheXMpO1xuICAgIGlmIChOdW1iZXIuaXNGaW5pdGUoZGF5cykgJiYgZGF5cyA+PSAwKSB7XG4gICAgICB2YWxpZGF0ZWQuc2tpbGxfc3RhbGVuZXNzX2RheXMgPSBNYXRoLmZsb29yKGRheXMpO1xuICAgIH0gZWxzZSB7XG4gICAgICBlcnJvcnMucHVzaChgaW52YWxpZCBza2lsbF9zdGFsZW5lc3NfZGF5czogbXVzdCBiZSBhIG5vbi1uZWdhdGl2ZSBudW1iZXJgKTtcbiAgICB9XG4gIH1cblxuICB2YWxpZGF0ZWQuYWx3YXlzX3VzZV9za2lsbHMgPSBub3JtYWxpemVTdHJpbmdBcnJheShwcmVmZXJlbmNlcy5hbHdheXNfdXNlX3NraWxscyk7XG4gIHZhbGlkYXRlZC5wcmVmZXJfc2tpbGxzID0gbm9ybWFsaXplU3RyaW5nQXJyYXkocHJlZmVyZW5jZXMucHJlZmVyX3NraWxscyk7XG4gIHZhbGlkYXRlZC5hdm9pZF9za2lsbHMgPSBub3JtYWxpemVTdHJpbmdBcnJheShwcmVmZXJlbmNlcy5hdm9pZF9za2lsbHMpO1xuICB2YWxpZGF0ZWQuY3VzdG9tX2luc3RydWN0aW9ucyA9IG5vcm1hbGl6ZVN0cmluZ0FycmF5KHByZWZlcmVuY2VzLmN1c3RvbV9pbnN0cnVjdGlvbnMpO1xuXG4gIGlmIChwcmVmZXJlbmNlcy5za2lsbF9ydWxlcykge1xuICAgIGNvbnN0IHZhbGlkUnVsZXM6IEdTRFNraWxsUnVsZVtdID0gW107XG4gICAgZm9yIChjb25zdCBydWxlIG9mIHByZWZlcmVuY2VzLnNraWxsX3J1bGVzKSB7XG4gICAgICBpZiAoIXJ1bGUgfHwgdHlwZW9mIHJ1bGUgIT09IFwib2JqZWN0XCIpIHtcbiAgICAgICAgZXJyb3JzLnB1c2goXCJpbnZhbGlkIHNraWxsX3J1bGVzIGVudHJ5XCIpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHdoZW4gPSB0eXBlb2YgcnVsZS53aGVuID09PSBcInN0cmluZ1wiID8gcnVsZS53aGVuLnRyaW0oKSA6IFwiXCI7XG4gICAgICBpZiAoIXdoZW4pIHtcbiAgICAgICAgZXJyb3JzLnB1c2goXCJza2lsbF9ydWxlcyBlbnRyeSBtaXNzaW5nIHdoZW5cIik7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgY29uc3QgdmFsaWRhdGVkUnVsZTogR1NEU2tpbGxSdWxlID0geyB3aGVuIH07XG4gICAgICBmb3IgKGNvbnN0IGFjdGlvbiBvZiBTS0lMTF9BQ1RJT05TKSB7XG4gICAgICAgIGNvbnN0IHZhbHVlcyA9IG5vcm1hbGl6ZVN0cmluZ0FycmF5KChydWxlIGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pW2FjdGlvbl0pO1xuICAgICAgICBpZiAodmFsdWVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICB2YWxpZGF0ZWRSdWxlW2FjdGlvbiBhcyBrZXlvZiBHU0RTa2lsbFJ1bGVdID0gdmFsdWVzIGFzIG5ldmVyO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBpZiAoIXZhbGlkYXRlZFJ1bGUudXNlICYmICF2YWxpZGF0ZWRSdWxlLnByZWZlciAmJiAhdmFsaWRhdGVkUnVsZS5hdm9pZCkge1xuICAgICAgICBlcnJvcnMucHVzaChgc2tpbGwgcnVsZSBoYXMgbm8gYWN0aW9uczogJHt3aGVufWApO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIHZhbGlkUnVsZXMucHVzaCh2YWxpZGF0ZWRSdWxlKTtcbiAgICB9XG4gICAgaWYgKHZhbGlkUnVsZXMubGVuZ3RoID4gMCkge1xuICAgICAgdmFsaWRhdGVkLnNraWxsX3J1bGVzID0gdmFsaWRSdWxlcztcbiAgICB9XG4gIH1cblxuICBmb3IgKGNvbnN0IGtleSBvZiBbXCJhbHdheXNfdXNlX3NraWxsc1wiLCBcInByZWZlcl9za2lsbHNcIiwgXCJhdm9pZF9za2lsbHNcIiwgXCJjdXN0b21faW5zdHJ1Y3Rpb25zXCJdIGFzIGNvbnN0KSB7XG4gICAgaWYgKHZhbGlkYXRlZFtrZXldICYmIHZhbGlkYXRlZFtrZXldIS5sZW5ndGggPT09IDApIHtcbiAgICAgIGRlbGV0ZSB2YWxpZGF0ZWRba2V5XTtcbiAgICB9XG4gIH1cblxuICBpZiAocHJlZmVyZW5jZXMudWF0X2Rpc3BhdGNoICE9PSB1bmRlZmluZWQpIHtcbiAgICB2YWxpZGF0ZWQudWF0X2Rpc3BhdGNoID0gISFwcmVmZXJlbmNlcy51YXRfZGlzcGF0Y2g7XG4gIH1cblxuICBpZiAocHJlZmVyZW5jZXMudW5pcXVlX21pbGVzdG9uZV9pZHMgIT09IHVuZGVmaW5lZCkge1xuICAgIHZhbGlkYXRlZC51bmlxdWVfbWlsZXN0b25lX2lkcyA9ICEhcHJlZmVyZW5jZXMudW5pcXVlX21pbGVzdG9uZV9pZHM7XG4gIH1cblxuICBpZiAocHJlZmVyZW5jZXMuYnVkZ2V0X2NlaWxpbmcgIT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IHJhdyA9IHByZWZlcmVuY2VzLmJ1ZGdldF9jZWlsaW5nO1xuICAgIGlmICh0eXBlb2YgcmF3ID09PSBcIm51bWJlclwiICYmIE51bWJlci5pc0Zpbml0ZShyYXcpKSB7XG4gICAgICB2YWxpZGF0ZWQuYnVkZ2V0X2NlaWxpbmcgPSByYXc7XG4gICAgfSBlbHNlIGlmICh0eXBlb2YgcmF3ID09PSBcInN0cmluZ1wiICYmIE51bWJlci5pc0Zpbml0ZShOdW1iZXIocmF3KSkpIHtcbiAgICAgIHZhbGlkYXRlZC5idWRnZXRfY2VpbGluZyA9IE51bWJlcihyYXcpO1xuICAgIH0gZWxzZSB7XG4gICAgICBlcnJvcnMucHVzaChcImJ1ZGdldF9jZWlsaW5nIG11c3QgYmUgYSBmaW5pdGUgbnVtYmVyXCIpO1xuICAgIH1cbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBCdWRnZXQgRW5mb3JjZW1lbnQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGlmIChwcmVmZXJlbmNlcy5idWRnZXRfZW5mb3JjZW1lbnQgIT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IHZhbGlkTW9kZXMgPSBuZXcgU2V0KFtcIndhcm5cIiwgXCJwYXVzZVwiLCBcImhhbHRcIl0pO1xuICAgIGlmICh0eXBlb2YgcHJlZmVyZW5jZXMuYnVkZ2V0X2VuZm9yY2VtZW50ID09PSBcInN0cmluZ1wiICYmIHZhbGlkTW9kZXMuaGFzKHByZWZlcmVuY2VzLmJ1ZGdldF9lbmZvcmNlbWVudCkpIHtcbiAgICAgIHZhbGlkYXRlZC5idWRnZXRfZW5mb3JjZW1lbnQgPSBwcmVmZXJlbmNlcy5idWRnZXRfZW5mb3JjZW1lbnQ7XG4gICAgfSBlbHNlIHtcbiAgICAgIGVycm9ycy5wdXNoKGBidWRnZXRfZW5mb3JjZW1lbnQgbXVzdCBiZSBvbmUgb2Y6IHdhcm4sIHBhdXNlLCBoYWx0YCk7XG4gICAgfVxuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFVPSyBGbGFncyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgaWYgKHByZWZlcmVuY2VzLnVvayAhPT0gdW5kZWZpbmVkKSB7XG4gICAgaWYgKHR5cGVvZiBwcmVmZXJlbmNlcy51b2sgPT09IFwib2JqZWN0XCIgJiYgcHJlZmVyZW5jZXMudW9rICE9PSBudWxsKSB7XG4gICAgICBjb25zdCByYXcgPSBwcmVmZXJlbmNlcy51b2sgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICBjb25zdCB2YWxpZDogTm9uTnVsbGFibGU8R1NEUHJlZmVyZW5jZXNbXCJ1b2tcIl0+ID0ge307XG5cbiAgICAgIGlmIChyYXcuZW5hYmxlZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGlmICh0eXBlb2YgcmF3LmVuYWJsZWQgPT09IFwiYm9vbGVhblwiKSB2YWxpZC5lbmFibGVkID0gcmF3LmVuYWJsZWQ7XG4gICAgICAgIGVsc2UgZXJyb3JzLnB1c2goXCJ1b2suZW5hYmxlZCBtdXN0IGJlIGEgYm9vbGVhblwiKTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgcGFyc2VFbmFibGVkQmxvY2sgPSAoXG4gICAgICAgIGtleTogXCJsZWdhY3lfZmFsbGJhY2tcIiB8IFwiZ2F0ZXNcIiB8IFwibW9kZWxfcG9saWN5XCIgfCBcImV4ZWN1dGlvbl9ncmFwaFwiIHwgXCJhdWRpdF91bmlmaWVkXCIgfCBcInBsYW5fdjJcIixcbiAgICAgICk6IHZvaWQgPT4ge1xuICAgICAgICBjb25zdCB2YWx1ZSA9IHJhd1trZXldO1xuICAgICAgICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCkgcmV0dXJuO1xuICAgICAgICBpZiAodHlwZW9mIHZhbHVlICE9PSBcIm9iamVjdFwiIHx8IHZhbHVlID09PSBudWxsKSB7XG4gICAgICAgICAgZXJyb3JzLnB1c2goYHVvay4ke2tleX0gbXVzdCBiZSBhbiBvYmplY3RgKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgYmxvY2sgPSB2YWx1ZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgICAgY29uc3QgcGFyc2VkOiB7IGVuYWJsZWQ/OiBib29sZWFuIH0gPSB7fTtcbiAgICAgICAgaWYgKGJsb2NrLmVuYWJsZWQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIGlmICh0eXBlb2YgYmxvY2suZW5hYmxlZCA9PT0gXCJib29sZWFuXCIpIHBhcnNlZC5lbmFibGVkID0gYmxvY2suZW5hYmxlZDtcbiAgICAgICAgICBlbHNlIGVycm9ycy5wdXNoKGB1b2suJHtrZXl9LmVuYWJsZWQgbXVzdCBiZSBhIGJvb2xlYW5gKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCB1bmtub3duID0gT2JqZWN0LmtleXMoYmxvY2spLmZpbHRlcigoaykgPT4gayAhPT0gXCJlbmFibGVkXCIpO1xuICAgICAgICBmb3IgKGNvbnN0IHVuayBvZiB1bmtub3duKSB7XG4gICAgICAgICAgd2FybmluZ3MucHVzaChgdW5rbm93biB1b2suJHtrZXl9IGtleSBcIiR7dW5rfVwiIFx1MjAxNCBpZ25vcmVkYCk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKE9iamVjdC5rZXlzKHBhcnNlZCkubGVuZ3RoID4gMCkge1xuICAgICAgICAgIHZhbGlkW2tleV0gPSBwYXJzZWQ7XG4gICAgICAgIH1cbiAgICAgIH07XG5cbiAgICAgIHBhcnNlRW5hYmxlZEJsb2NrKFwibGVnYWN5X2ZhbGxiYWNrXCIpO1xuICAgICAgcGFyc2VFbmFibGVkQmxvY2soXCJnYXRlc1wiKTtcbiAgICAgIHBhcnNlRW5hYmxlZEJsb2NrKFwibW9kZWxfcG9saWN5XCIpO1xuICAgICAgcGFyc2VFbmFibGVkQmxvY2soXCJleGVjdXRpb25fZ3JhcGhcIik7XG4gICAgICBwYXJzZUVuYWJsZWRCbG9jayhcImF1ZGl0X3VuaWZpZWRcIik7XG4gICAgICBwYXJzZUVuYWJsZWRCbG9jayhcInBsYW5fdjJcIik7XG5cbiAgICAgIGlmIChyYXcuZ2l0b3BzICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgaWYgKHR5cGVvZiByYXcuZ2l0b3BzICE9PSBcIm9iamVjdFwiIHx8IHJhdy5naXRvcHMgPT09IG51bGwpIHtcbiAgICAgICAgICBlcnJvcnMucHVzaChcInVvay5naXRvcHMgbXVzdCBiZSBhbiBvYmplY3RcIik7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgY29uc3QgZ2l0b3BzID0gcmF3LmdpdG9wcyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgICAgICBjb25zdCBwYXJzZWQ6IE5vbk51bGxhYmxlPE5vbk51bGxhYmxlPEdTRFByZWZlcmVuY2VzW1widW9rXCJdPltcImdpdG9wc1wiXT4gPSB7fTtcbiAgICAgICAgICBpZiAoZ2l0b3BzLmVuYWJsZWQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgaWYgKHR5cGVvZiBnaXRvcHMuZW5hYmxlZCA9PT0gXCJib29sZWFuXCIpIHBhcnNlZC5lbmFibGVkID0gZ2l0b3BzLmVuYWJsZWQ7XG4gICAgICAgICAgICBlbHNlIGVycm9ycy5wdXNoKFwidW9rLmdpdG9wcy5lbmFibGVkIG11c3QgYmUgYSBib29sZWFuXCIpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoZ2l0b3BzLnR1cm5fYWN0aW9uICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgIGlmIChcbiAgICAgICAgICAgICAgdHlwZW9mIGdpdG9wcy50dXJuX2FjdGlvbiA9PT0gXCJzdHJpbmdcIiAmJlxuICAgICAgICAgICAgICBWQUxJRF9VT0tfVFVSTl9BQ1RJT05TLmhhcyhnaXRvcHMudHVybl9hY3Rpb24gYXMgXCJjb21taXRcIiB8IFwic25hcHNob3RcIiB8IFwic3RhdHVzLW9ubHlcIilcbiAgICAgICAgICAgICkge1xuICAgICAgICAgICAgICBwYXJzZWQudHVybl9hY3Rpb24gPSBnaXRvcHMudHVybl9hY3Rpb24gYXMgXCJjb21taXRcIiB8IFwic25hcHNob3RcIiB8IFwic3RhdHVzLW9ubHlcIjtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIGVycm9ycy5wdXNoKFwidW9rLmdpdG9wcy50dXJuX2FjdGlvbiBtdXN0IGJlIG9uZSBvZjogY29tbWl0LCBzbmFwc2hvdCwgc3RhdHVzLW9ubHlcIik7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChnaXRvcHMudHVybl9wdXNoICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgIGlmICh0eXBlb2YgZ2l0b3BzLnR1cm5fcHVzaCA9PT0gXCJib29sZWFuXCIpIHBhcnNlZC50dXJuX3B1c2ggPSBnaXRvcHMudHVybl9wdXNoO1xuICAgICAgICAgICAgZWxzZSBlcnJvcnMucHVzaChcInVvay5naXRvcHMudHVybl9wdXNoIG11c3QgYmUgYSBib29sZWFuXCIpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBjb25zdCB1bmtub3duID0gT2JqZWN0LmtleXMoZ2l0b3BzKS5maWx0ZXIoKGspID0+ICFbXCJlbmFibGVkXCIsIFwidHVybl9hY3Rpb25cIiwgXCJ0dXJuX3B1c2hcIl0uaW5jbHVkZXMoaykpO1xuICAgICAgICAgIGZvciAoY29uc3QgdW5rIG9mIHVua25vd24pIHtcbiAgICAgICAgICAgIHdhcm5pbmdzLnB1c2goYHVua25vd24gdW9rLmdpdG9wcyBrZXkgXCIke3Vua31cIiBcdTIwMTQgaWdub3JlZGApO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoT2JqZWN0LmtleXMocGFyc2VkKS5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICB2YWxpZC5naXRvcHMgPSBwYXJzZWQ7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGtub3duVW9rS2V5cyA9IG5ldyBTZXQoW1xuICAgICAgICBcImVuYWJsZWRcIixcbiAgICAgICAgXCJsZWdhY3lfZmFsbGJhY2tcIixcbiAgICAgICAgXCJnYXRlc1wiLFxuICAgICAgICBcIm1vZGVsX3BvbGljeVwiLFxuICAgICAgICBcImV4ZWN1dGlvbl9ncmFwaFwiLFxuICAgICAgICBcImdpdG9wc1wiLFxuICAgICAgICBcImF1ZGl0X3VuaWZpZWRcIixcbiAgICAgICAgXCJwbGFuX3YyXCIsXG4gICAgICBdKTtcbiAgICAgIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKHJhdykpIHtcbiAgICAgICAgaWYgKCFrbm93blVva0tleXMuaGFzKGtleSkpIHtcbiAgICAgICAgICB3YXJuaW5ncy5wdXNoKGB1bmtub3duIHVvayBrZXkgXCIke2tleX1cIiBcdTIwMTQgaWdub3JlZGApO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGlmIChPYmplY3Qua2V5cyh2YWxpZCkubGVuZ3RoID4gMCkge1xuICAgICAgICB2YWxpZGF0ZWQudW9rID0gdmFsaWQ7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIGVycm9ycy5wdXNoKFwidW9rIG11c3QgYmUgYW4gb2JqZWN0XCIpO1xuICAgIH1cbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUb2tlbiBQcm9maWxlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBpZiAocHJlZmVyZW5jZXMudG9rZW5fcHJvZmlsZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgaWYgKHR5cGVvZiBwcmVmZXJlbmNlcy50b2tlbl9wcm9maWxlID09PSBcInN0cmluZ1wiICYmIFZBTElEX1RPS0VOX1BST0ZJTEVTLmhhcyhwcmVmZXJlbmNlcy50b2tlbl9wcm9maWxlIGFzIFRva2VuUHJvZmlsZSkpIHtcbiAgICAgIHZhbGlkYXRlZC50b2tlbl9wcm9maWxlID0gcHJlZmVyZW5jZXMudG9rZW5fcHJvZmlsZSBhcyBUb2tlblByb2ZpbGU7XG4gICAgfSBlbHNlIHtcbiAgICAgIGVycm9ycy5wdXNoKGB0b2tlbl9wcm9maWxlIG11c3QgYmUgb25lIG9mOiBidWRnZXQsIGJhbGFuY2VkLCBxdWFsaXR5LCBidXJuLW1heGApO1xuICAgIH1cbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBQbGFubmluZyBEZXB0aCAoZGVlcCBwbGFubmluZyBtb2RlKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgaWYgKHByZWZlcmVuY2VzLnBsYW5uaW5nX2RlcHRoICE9PSB1bmRlZmluZWQpIHtcbiAgICBpZiAocHJlZmVyZW5jZXMucGxhbm5pbmdfZGVwdGggPT09IFwibGlnaHRcIiB8fCBwcmVmZXJlbmNlcy5wbGFubmluZ19kZXB0aCA9PT0gXCJkZWVwXCIpIHtcbiAgICAgIHZhbGlkYXRlZC5wbGFubmluZ19kZXB0aCA9IHByZWZlcmVuY2VzLnBsYW5uaW5nX2RlcHRoO1xuICAgIH0gZWxzZSB7XG4gICAgICBlcnJvcnMucHVzaChgcGxhbm5pbmdfZGVwdGggbXVzdCBiZSBcImxpZ2h0XCIgb3IgXCJkZWVwXCJgKTtcbiAgICB9XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgU2VhcmNoIFByb3ZpZGVyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBpZiAocHJlZmVyZW5jZXMuc2VhcmNoX3Byb3ZpZGVyICE9PSB1bmRlZmluZWQpIHtcbiAgICBjb25zdCB2YWxpZFNlYXJjaFByb3ZpZGVycyA9IG5ldyBTZXQoW1wiYnJhdmVcIiwgXCJ0YXZpbHlcIiwgXCJvbGxhbWFcIiwgXCJuYXRpdmVcIiwgXCJhdXRvXCJdKTtcbiAgICBpZiAodHlwZW9mIHByZWZlcmVuY2VzLnNlYXJjaF9wcm92aWRlciA9PT0gXCJzdHJpbmdcIiAmJiB2YWxpZFNlYXJjaFByb3ZpZGVycy5oYXMocHJlZmVyZW5jZXMuc2VhcmNoX3Byb3ZpZGVyKSkge1xuICAgICAgdmFsaWRhdGVkLnNlYXJjaF9wcm92aWRlciA9IHByZWZlcmVuY2VzLnNlYXJjaF9wcm92aWRlciBhcyBHU0RQcmVmZXJlbmNlc1tcInNlYXJjaF9wcm92aWRlclwiXTtcbiAgICB9IGVsc2Uge1xuICAgICAgZXJyb3JzLnB1c2goYHNlYXJjaF9wcm92aWRlciBtdXN0IGJlIG9uZSBvZjogYnJhdmUsIHRhdmlseSwgb2xsYW1hLCBuYXRpdmUsIGF1dG9gKTtcbiAgICB9XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgRmxhdC1yYXRlIFByb3ZpZGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgLy8gVXNlci1kZWNsYXJlZCBmbGF0LXJhdGUgcHJvdmlkZXJzIGZvciBkeW5hbWljIHJvdXRpbmcgc3VwcHJlc3Npb24uXG4gIC8vIEJ1aWx0LWluIHByb3ZpZGVycyAoZ2l0aHViLWNvcGlsb3QsIGNvcGlsb3QsIGNsYXVkZS1jb2RlKSBhbmQgYW55XG4gIC8vIGV4dGVybmFsQ2xpIHByb3ZpZGVyIGFyZSBhbHJlYWR5IGF1dG8tZGV0ZWN0ZWQ7IHRoaXMgbGlzdCBsYXllcnMgb25cbiAgLy8gdG9wIGZvciBwcml2YXRlIHN1YnNjcmlwdGlvbiBwcm94aWVzIGFuZCBjdXN0b20gQ0xJIHdyYXBwZXJzLlxuICBpZiAocHJlZmVyZW5jZXMuZmxhdF9yYXRlX3Byb3ZpZGVycyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgaWYgKEFycmF5LmlzQXJyYXkocHJlZmVyZW5jZXMuZmxhdF9yYXRlX3Byb3ZpZGVycykpIHtcbiAgICAgIGNvbnN0IGFsbFN0cmluZ3MgPSBwcmVmZXJlbmNlcy5mbGF0X3JhdGVfcHJvdmlkZXJzLmV2ZXJ5KFxuICAgICAgICAoaXRlbTogdW5rbm93bikgPT4gdHlwZW9mIGl0ZW0gPT09IFwic3RyaW5nXCIsXG4gICAgICApO1xuICAgICAgaWYgKGFsbFN0cmluZ3MpIHtcbiAgICAgICAgLy8gU3RyaXAgZW1wdHkvd2hpdGVzcGFjZS1vbmx5IGVudHJpZXMgdG8gYXZvaWQgZmFsc2UgbWF0Y2hlcy5cbiAgICAgICAgdmFsaWRhdGVkLmZsYXRfcmF0ZV9wcm92aWRlcnMgPSBwcmVmZXJlbmNlcy5mbGF0X3JhdGVfcHJvdmlkZXJzXG4gICAgICAgICAgLm1hcCgoczogc3RyaW5nKSA9PiBzLnRyaW0oKSlcbiAgICAgICAgICAuZmlsdGVyKChzOiBzdHJpbmcpID0+IHMubGVuZ3RoID4gMCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBlcnJvcnMucHVzaChcImZsYXRfcmF0ZV9wcm92aWRlcnMgbXVzdCBiZSBhbiBhcnJheSBvZiBzdHJpbmdzXCIpO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBlcnJvcnMucHVzaChcImZsYXRfcmF0ZV9wcm92aWRlcnMgbXVzdCBiZSBhbiBhcnJheSBvZiBzdHJpbmdzXCIpO1xuICAgIH1cbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBQaGFzZSBTa2lwIFByZWZlcmVuY2VzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBpZiAocHJlZmVyZW5jZXMucGhhc2VzICE9PSB1bmRlZmluZWQpIHtcbiAgICBpZiAodHlwZW9mIHByZWZlcmVuY2VzLnBoYXNlcyA9PT0gXCJvYmplY3RcIiAmJiBwcmVmZXJlbmNlcy5waGFzZXMgIT09IG51bGwpIHtcbiAgICAgIGNvbnN0IHZhbGlkYXRlZFBoYXNlczogUGhhc2VTa2lwUHJlZmVyZW5jZXMgPSB7fTtcbiAgICAgIGNvbnN0IHAgPSBwcmVmZXJlbmNlcy5waGFzZXMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICAvLyBTdHJpY3QgYm9vbGVhbiBwYXJzaW5nIFx1MjAxNCBZQU1MIHVzdWFsbHkgZGVsaXZlcnMgcmVhbCBib29sZWFucywgYnV0XG4gICAgICAvLyBoYW5kLWVkaXRzIGxpa2UgYHByb2dyZXNzaXZlX3BsYW5uaW5nOiBcImZhbHNlXCJgIG90aGVyd2lzZSBjb2VyY2UgdG9cbiAgICAgIC8vIHRydXRoeSB2aWEgYCEhYC4gQWNjZXB0IG9ubHkgcmVhbCBib29sZWFucyBvciB0aGUgbGl0ZXJhbCBzdHJpbmdzXG4gICAgICAvLyBcInRydWVcIi9cImZhbHNlXCI7IGFueXRoaW5nIGVsc2UgYmVjb21lcyBhIHdhcm5pbmcgKyBpZ25vcmVkLlxuICAgICAgY29uc3QgcGFyc2VTdHJpY3RCb29sZWFuID0gKGtleTogc3RyaW5nLCByYXc6IHVua25vd24pOiBib29sZWFuIHwgdW5kZWZpbmVkID0+IHtcbiAgICAgICAgaWYgKHR5cGVvZiByYXcgPT09IFwiYm9vbGVhblwiKSByZXR1cm4gcmF3O1xuICAgICAgICBpZiAodHlwZW9mIHJhdyA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICAgIGlmIChyYXcgPT09IFwidHJ1ZVwiKSByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICBpZiAocmF3ID09PSBcImZhbHNlXCIpIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgICB3YXJuaW5ncy5wdXNoKGBwaGFzZXMuJHtrZXl9IG11c3QgYmUgYSBib29sZWFuIChnb3QgJHt0eXBlb2YgcmF3fTogJHtKU09OLnN0cmluZ2lmeShyYXcpfSkgXHUyMDE0IGlnbm9yZWRgKTtcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgIH07XG4gICAgICBjb25zdCBhc3NpZ25Cb29sID0gKGtleToga2V5b2YgUGhhc2VTa2lwUHJlZmVyZW5jZXMsIHJhdzogdW5rbm93bik6IHZvaWQgPT4ge1xuICAgICAgICBjb25zdCB2ID0gcGFyc2VTdHJpY3RCb29sZWFuKFN0cmluZyhrZXkpLCByYXcpO1xuICAgICAgICBpZiAodiAhPT0gdW5kZWZpbmVkKSAodmFsaWRhdGVkUGhhc2VzIGFzIFJlY29yZDxzdHJpbmcsIGJvb2xlYW4+KVtrZXkgYXMgc3RyaW5nXSA9IHY7XG4gICAgICB9O1xuICAgICAgaWYgKHAuc2tpcF9yZXNlYXJjaCAhPT0gdW5kZWZpbmVkKSBhc3NpZ25Cb29sKFwic2tpcF9yZXNlYXJjaFwiLCBwLnNraXBfcmVzZWFyY2gpO1xuICAgICAgaWYgKHAuc2tpcF9yZWFzc2VzcyAhPT0gdW5kZWZpbmVkKSBhc3NpZ25Cb29sKFwic2tpcF9yZWFzc2Vzc1wiLCBwLnNraXBfcmVhc3Nlc3MpO1xuICAgICAgaWYgKHAuc2tpcF9zbGljZV9yZXNlYXJjaCAhPT0gdW5kZWZpbmVkKSBhc3NpZ25Cb29sKFwic2tpcF9zbGljZV9yZXNlYXJjaFwiLCBwLnNraXBfc2xpY2VfcmVzZWFyY2gpO1xuICAgICAgaWYgKHAuc2tpcF9taWxlc3RvbmVfdmFsaWRhdGlvbiAhPT0gdW5kZWZpbmVkKSBhc3NpZ25Cb29sKFwic2tpcF9taWxlc3RvbmVfdmFsaWRhdGlvblwiLCBwLnNraXBfbWlsZXN0b25lX3ZhbGlkYXRpb24pO1xuICAgICAgaWYgKHAucmVhc3Nlc3NfYWZ0ZXJfc2xpY2UgIT09IHVuZGVmaW5lZCkgYXNzaWduQm9vbChcInJlYXNzZXNzX2FmdGVyX3NsaWNlXCIsIHAucmVhc3Nlc3NfYWZ0ZXJfc2xpY2UpO1xuICAgICAgaWYgKChwIGFzIGFueSkucmVxdWlyZV9zbGljZV9kaXNjdXNzaW9uICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgY29uc3QgdiA9IHBhcnNlU3RyaWN0Qm9vbGVhbihcInJlcXVpcmVfc2xpY2VfZGlzY3Vzc2lvblwiLCAocCBhcyBhbnkpLnJlcXVpcmVfc2xpY2VfZGlzY3Vzc2lvbik7XG4gICAgICAgIGlmICh2ICE9PSB1bmRlZmluZWQpICh2YWxpZGF0ZWRQaGFzZXMgYXMgYW55KS5yZXF1aXJlX3NsaWNlX2Rpc2N1c3Npb24gPSB2O1xuICAgICAgfVxuICAgICAgaWYgKHAubWlkX2V4ZWN1dGlvbl9lc2NhbGF0aW9uICE9PSB1bmRlZmluZWQpIGFzc2lnbkJvb2woXCJtaWRfZXhlY3V0aW9uX2VzY2FsYXRpb25cIiwgcC5taWRfZXhlY3V0aW9uX2VzY2FsYXRpb24pO1xuICAgICAgaWYgKHAucHJvZ3Jlc3NpdmVfcGxhbm5pbmcgIT09IHVuZGVmaW5lZCkgYXNzaWduQm9vbChcInByb2dyZXNzaXZlX3BsYW5uaW5nXCIsIHAucHJvZ3Jlc3NpdmVfcGxhbm5pbmcpO1xuICAgICAgLy8gV2FybiBvbiB1bmtub3duIHBoYXNlIGtleXNcbiAgICAgIGNvbnN0IGtub3duUGhhc2VLZXlzID0gbmV3IFNldChbXCJza2lwX3Jlc2VhcmNoXCIsIFwic2tpcF9yZWFzc2Vzc1wiLCBcInNraXBfc2xpY2VfcmVzZWFyY2hcIiwgXCJza2lwX21pbGVzdG9uZV92YWxpZGF0aW9uXCIsIFwicmVhc3Nlc3NfYWZ0ZXJfc2xpY2VcIiwgXCJyZXF1aXJlX3NsaWNlX2Rpc2N1c3Npb25cIiwgXCJtaWRfZXhlY3V0aW9uX2VzY2FsYXRpb25cIiwgXCJwcm9ncmVzc2l2ZV9wbGFubmluZ1wiXSk7XG4gICAgICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhwKSkge1xuICAgICAgICBpZiAoIWtub3duUGhhc2VLZXlzLmhhcyhrZXkpKSB7XG4gICAgICAgICAgd2FybmluZ3MucHVzaChgdW5rbm93biBwaGFzZXMga2V5IFwiJHtrZXl9XCIgXHUyMDE0IGlnbm9yZWRgKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgdmFsaWRhdGVkLnBoYXNlcyA9IHZhbGlkYXRlZFBoYXNlcztcbiAgICB9IGVsc2Uge1xuICAgICAgZXJyb3JzLnB1c2goYHBoYXNlcyBtdXN0IGJlIGFuIG9iamVjdGApO1xuICAgIH1cbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBDb250ZXh0IFBhdXNlIFRocmVzaG9sZCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgaWYgKHByZWZlcmVuY2VzLmNvbnRleHRfcGF1c2VfdGhyZXNob2xkICE9PSB1bmRlZmluZWQpIHtcbiAgICBjb25zdCByYXcgPSBwcmVmZXJlbmNlcy5jb250ZXh0X3BhdXNlX3RocmVzaG9sZDtcbiAgICBpZiAodHlwZW9mIHJhdyA9PT0gXCJudW1iZXJcIiAmJiBOdW1iZXIuaXNGaW5pdGUocmF3KSkge1xuICAgICAgdmFsaWRhdGVkLmNvbnRleHRfcGF1c2VfdGhyZXNob2xkID0gcmF3O1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIHJhdyA9PT0gXCJzdHJpbmdcIiAmJiBOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKHJhdykpKSB7XG4gICAgICB2YWxpZGF0ZWQuY29udGV4dF9wYXVzZV90aHJlc2hvbGQgPSBOdW1iZXIocmF3KTtcbiAgICB9IGVsc2Uge1xuICAgICAgZXJyb3JzLnB1c2goXCJjb250ZXh0X3BhdXNlX3RocmVzaG9sZCBtdXN0IGJlIGEgZmluaXRlIG51bWJlclwiKTtcbiAgICB9XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgTW9kZWxzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBpZiAocHJlZmVyZW5jZXMubW9kZWxzICE9PSB1bmRlZmluZWQpIHtcbiAgICBpZiAocHJlZmVyZW5jZXMubW9kZWxzICYmIHR5cGVvZiBwcmVmZXJlbmNlcy5tb2RlbHMgPT09IFwib2JqZWN0XCIpIHtcbiAgICAgIHZhbGlkYXRlZC5tb2RlbHMgPSBwcmVmZXJlbmNlcy5tb2RlbHM7XG4gICAgfSBlbHNlIHtcbiAgICAgIGVycm9ycy5wdXNoKFwibW9kZWxzIG11c3QgYmUgYW4gb2JqZWN0XCIpO1xuICAgIH1cbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBBdXRvIFN1cGVydmlzb3IgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGlmIChwcmVmZXJlbmNlcy5hdXRvX3N1cGVydmlzb3IgIT09IHVuZGVmaW5lZCkge1xuICAgIGlmIChwcmVmZXJlbmNlcy5hdXRvX3N1cGVydmlzb3IgJiYgdHlwZW9mIHByZWZlcmVuY2VzLmF1dG9fc3VwZXJ2aXNvciA9PT0gXCJvYmplY3RcIikge1xuICAgICAgdmFsaWRhdGVkLmF1dG9fc3VwZXJ2aXNvciA9IHByZWZlcmVuY2VzLmF1dG9fc3VwZXJ2aXNvcjtcbiAgICB9IGVsc2Uge1xuICAgICAgZXJyb3JzLnB1c2goXCJhdXRvX3N1cGVydmlzb3IgbXVzdCBiZSBhbiBvYmplY3RcIik7XG4gICAgfVxuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIE5vdGlmaWNhdGlvbnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGlmIChwcmVmZXJlbmNlcy5ub3RpZmljYXRpb25zICE9PSB1bmRlZmluZWQpIHtcbiAgICBpZiAocHJlZmVyZW5jZXMubm90aWZpY2F0aW9ucyAmJiB0eXBlb2YgcHJlZmVyZW5jZXMubm90aWZpY2F0aW9ucyA9PT0gXCJvYmplY3RcIikge1xuICAgICAgdmFsaWRhdGVkLm5vdGlmaWNhdGlvbnMgPSBwcmVmZXJlbmNlcy5ub3RpZmljYXRpb25zO1xuICAgIH0gZWxzZSB7XG4gICAgICBlcnJvcnMucHVzaChcIm5vdGlmaWNhdGlvbnMgbXVzdCBiZSBhbiBvYmplY3RcIik7XG4gICAgfVxuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIENtdXggXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGlmIChwcmVmZXJlbmNlcy5jbXV4ICE9PSB1bmRlZmluZWQpIHtcbiAgICBpZiAocHJlZmVyZW5jZXMuY211eCAmJiB0eXBlb2YgcHJlZmVyZW5jZXMuY211eCA9PT0gXCJvYmplY3RcIikge1xuICAgICAgY29uc3QgY211eCA9IHByZWZlcmVuY2VzLmNtdXggYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICBjb25zdCB2YWxpZGF0ZWRDbXV4OiBOb25OdWxsYWJsZTxHU0RQcmVmZXJlbmNlc1tcImNtdXhcIl0+ID0ge307XG4gICAgICBpZiAoY211eC5lbmFibGVkICE9PSB1bmRlZmluZWQpIHZhbGlkYXRlZENtdXguZW5hYmxlZCA9ICEhY211eC5lbmFibGVkO1xuICAgICAgaWYgKGNtdXgubm90aWZpY2F0aW9ucyAhPT0gdW5kZWZpbmVkKSB2YWxpZGF0ZWRDbXV4Lm5vdGlmaWNhdGlvbnMgPSAhIWNtdXgubm90aWZpY2F0aW9ucztcbiAgICAgIGlmIChjbXV4LnNpZGViYXIgIT09IHVuZGVmaW5lZCkgdmFsaWRhdGVkQ211eC5zaWRlYmFyID0gISFjbXV4LnNpZGViYXI7XG4gICAgICBpZiAoY211eC5zcGxpdHMgIT09IHVuZGVmaW5lZCkgdmFsaWRhdGVkQ211eC5zcGxpdHMgPSAhIWNtdXguc3BsaXRzO1xuICAgICAgaWYgKGNtdXguYnJvd3NlciAhPT0gdW5kZWZpbmVkKSB2YWxpZGF0ZWRDbXV4LmJyb3dzZXIgPSAhIWNtdXguYnJvd3NlcjtcblxuICAgICAgY29uc3Qga25vd25DbXV4S2V5cyA9IG5ldyBTZXQoW1wiZW5hYmxlZFwiLCBcIm5vdGlmaWNhdGlvbnNcIiwgXCJzaWRlYmFyXCIsIFwic3BsaXRzXCIsIFwiYnJvd3NlclwiXSk7XG4gICAgICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhjbXV4KSkge1xuICAgICAgICBpZiAoIWtub3duQ211eEtleXMuaGFzKGtleSkpIHtcbiAgICAgICAgICB3YXJuaW5ncy5wdXNoKGB1bmtub3duIGNtdXgga2V5IFwiJHtrZXl9XCIgXHUyMDE0IGlnbm9yZWRgKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBpZiAoT2JqZWN0LmtleXModmFsaWRhdGVkQ211eCkubGVuZ3RoID4gMCkge1xuICAgICAgICB2YWxpZGF0ZWQuY211eCA9IHZhbGlkYXRlZENtdXg7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIGVycm9ycy5wdXNoKFwiY211eCBtdXN0IGJlIGFuIG9iamVjdFwiKTtcbiAgICB9XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgUmVtb3RlIFF1ZXN0aW9ucyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgaWYgKHByZWZlcmVuY2VzLnJlbW90ZV9xdWVzdGlvbnMgIT09IHVuZGVmaW5lZCkge1xuICAgIGlmIChwcmVmZXJlbmNlcy5yZW1vdGVfcXVlc3Rpb25zICYmIHR5cGVvZiBwcmVmZXJlbmNlcy5yZW1vdGVfcXVlc3Rpb25zID09PSBcIm9iamVjdFwiKSB7XG4gICAgICB2YWxpZGF0ZWQucmVtb3RlX3F1ZXN0aW9ucyA9IHByZWZlcmVuY2VzLnJlbW90ZV9xdWVzdGlvbnM7XG4gICAgfSBlbHNlIHtcbiAgICAgIGVycm9ycy5wdXNoKFwicmVtb3RlX3F1ZXN0aW9ucyBtdXN0IGJlIGFuIG9iamVjdFwiKTtcbiAgICB9XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgUG9zdC1Vbml0IEhvb2tzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBpZiAocHJlZmVyZW5jZXMucG9zdF91bml0X2hvb2tzICYmIEFycmF5LmlzQXJyYXkocHJlZmVyZW5jZXMucG9zdF91bml0X2hvb2tzKSkge1xuICAgIGNvbnN0IHZhbGlkSG9va3M6IFBvc3RVbml0SG9va0NvbmZpZ1tdID0gW107XG4gICAgY29uc3Qgc2Vlbk5hbWVzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgY29uc3Qga25vd25Vbml0VHlwZXMgPSBuZXcgU2V0PHN0cmluZz4oS05PV05fVU5JVF9MQUJFTFMpO1xuICAgIGZvciAoY29uc3QgaG9vayBvZiBwcmVmZXJlbmNlcy5wb3N0X3VuaXRfaG9va3MpIHtcbiAgICAgIGlmICghaG9vayB8fCB0eXBlb2YgaG9vayAhPT0gXCJvYmplY3RcIikge1xuICAgICAgICBlcnJvcnMucHVzaChcInBvc3RfdW5pdF9ob29rcyBlbnRyeSBtdXN0IGJlIGFuIG9iamVjdFwiKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBjb25zdCBuYW1lID0gdHlwZW9mIGhvb2submFtZSA9PT0gXCJzdHJpbmdcIiA/IGhvb2submFtZS50cmltKCkgOiBcIlwiO1xuICAgICAgaWYgKCFuYW1lKSB7XG4gICAgICAgIGVycm9ycy5wdXNoKFwicG9zdF91bml0X2hvb2tzIGVudHJ5IG1pc3NpbmcgbmFtZVwiKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBpZiAoc2Vlbk5hbWVzLmhhcyhuYW1lKSkge1xuICAgICAgICBlcnJvcnMucHVzaChgZHVwbGljYXRlIHBvc3RfdW5pdF9ob29rcyBuYW1lOiAke25hbWV9YCk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgY29uc3QgYWZ0ZXIgPSBub3JtYWxpemVTdHJpbmdBcnJheShob29rLmFmdGVyKTtcbiAgICAgIGlmIChhZnRlci5sZW5ndGggPT09IDApIHtcbiAgICAgICAgZXJyb3JzLnB1c2goYHBvc3RfdW5pdF9ob29rcyBcIiR7bmFtZX1cIiBtaXNzaW5nIGFmdGVyYCk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgZm9yIChjb25zdCB1dCBvZiBhZnRlcikge1xuICAgICAgICBpZiAoIWtub3duVW5pdFR5cGVzLmhhcyh1dCkpIHtcbiAgICAgICAgICBlcnJvcnMucHVzaChgcG9zdF91bml0X2hvb2tzIFwiJHtuYW1lfVwiIHVua25vd24gdW5pdCB0eXBlIGluIGFmdGVyOiAke3V0fWApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBjb25zdCBwcm9tcHQgPSB0eXBlb2YgaG9vay5wcm9tcHQgPT09IFwic3RyaW5nXCIgPyBob29rLnByb21wdC50cmltKCkgOiBcIlwiO1xuICAgICAgaWYgKCFwcm9tcHQpIHtcbiAgICAgICAgZXJyb3JzLnB1c2goYHBvc3RfdW5pdF9ob29rcyBcIiR7bmFtZX1cIiBtaXNzaW5nIHByb21wdGApO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHZhbGlkSG9vazogUG9zdFVuaXRIb29rQ29uZmlnID0geyBuYW1lLCBhZnRlciwgcHJvbXB0IH07XG4gICAgICBpZiAoaG9vay5tYXhfY3ljbGVzICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgY29uc3QgbWMgPSB0eXBlb2YgaG9vay5tYXhfY3ljbGVzID09PSBcIm51bWJlclwiID8gaG9vay5tYXhfY3ljbGVzIDogTnVtYmVyKGhvb2subWF4X2N5Y2xlcyk7XG4gICAgICAgIHZhbGlkSG9vay5tYXhfY3ljbGVzID0gTnVtYmVyLmlzRmluaXRlKG1jKSA/IE1hdGgubWF4KDEsIE1hdGgubWluKDEwLCBNYXRoLnJvdW5kKG1jKSkpIDogMTtcbiAgICAgIH1cbiAgICAgIGlmICh0eXBlb2YgaG9vay5tb2RlbCA9PT0gXCJzdHJpbmdcIiAmJiBob29rLm1vZGVsLnRyaW0oKSkge1xuICAgICAgICB2YWxpZEhvb2subW9kZWwgPSBob29rLm1vZGVsLnRyaW0oKTtcbiAgICAgIH1cbiAgICAgIGlmICh0eXBlb2YgaG9vay5hcnRpZmFjdCA9PT0gXCJzdHJpbmdcIiAmJiBob29rLmFydGlmYWN0LnRyaW0oKSkge1xuICAgICAgICB2YWxpZEhvb2suYXJ0aWZhY3QgPSBob29rLmFydGlmYWN0LnRyaW0oKTtcbiAgICAgIH1cbiAgICAgIGlmICh0eXBlb2YgaG9vay5yZXRyeV9vbiA9PT0gXCJzdHJpbmdcIiAmJiBob29rLnJldHJ5X29uLnRyaW0oKSkge1xuICAgICAgICB2YWxpZEhvb2sucmV0cnlfb24gPSBob29rLnJldHJ5X29uLnRyaW0oKTtcbiAgICAgIH1cbiAgICAgIGlmICh0eXBlb2YgaG9vay5hZ2VudCA9PT0gXCJzdHJpbmdcIiAmJiBob29rLmFnZW50LnRyaW0oKSkge1xuICAgICAgICB2YWxpZEhvb2suYWdlbnQgPSBob29rLmFnZW50LnRyaW0oKTtcbiAgICAgIH1cbiAgICAgIGlmIChob29rLmVuYWJsZWQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICB2YWxpZEhvb2suZW5hYmxlZCA9ICEhaG9vay5lbmFibGVkO1xuICAgICAgfVxuICAgICAgc2Vlbk5hbWVzLmFkZChuYW1lKTtcbiAgICAgIHZhbGlkSG9va3MucHVzaCh2YWxpZEhvb2spO1xuICAgIH1cbiAgICBpZiAodmFsaWRIb29rcy5sZW5ndGggPiAwKSB7XG4gICAgICB2YWxpZGF0ZWQucG9zdF91bml0X2hvb2tzID0gdmFsaWRIb29rcztcbiAgICB9XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgUHJlLURpc3BhdGNoIEhvb2tzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBpZiAocHJlZmVyZW5jZXMucHJlX2Rpc3BhdGNoX2hvb2tzICYmIEFycmF5LmlzQXJyYXkocHJlZmVyZW5jZXMucHJlX2Rpc3BhdGNoX2hvb2tzKSkge1xuICAgIGNvbnN0IHZhbGlkUHJlSG9va3M6IFByZURpc3BhdGNoSG9va0NvbmZpZ1tdID0gW107XG4gICAgY29uc3Qgc2VlblByZU5hbWVzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgY29uc3Qga25vd25Vbml0VHlwZXMgPSBuZXcgU2V0PHN0cmluZz4oS05PV05fVU5JVF9MQUJFTFMpO1xuICAgIGNvbnN0IHZhbGlkQWN0aW9ucyA9IG5ldyBTZXQoW1wibW9kaWZ5XCIsIFwic2tpcFwiLCBcInJlcGxhY2VcIl0pO1xuICAgIGZvciAoY29uc3QgaG9vayBvZiBwcmVmZXJlbmNlcy5wcmVfZGlzcGF0Y2hfaG9va3MpIHtcbiAgICAgIGlmICghaG9vayB8fCB0eXBlb2YgaG9vayAhPT0gXCJvYmplY3RcIikge1xuICAgICAgICBlcnJvcnMucHVzaChcInByZV9kaXNwYXRjaF9ob29rcyBlbnRyeSBtdXN0IGJlIGFuIG9iamVjdFwiKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBjb25zdCBuYW1lID0gdHlwZW9mIGhvb2submFtZSA9PT0gXCJzdHJpbmdcIiA/IGhvb2submFtZS50cmltKCkgOiBcIlwiO1xuICAgICAgaWYgKCFuYW1lKSB7XG4gICAgICAgIGVycm9ycy5wdXNoKFwicHJlX2Rpc3BhdGNoX2hvb2tzIGVudHJ5IG1pc3NpbmcgbmFtZVwiKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBpZiAoc2VlblByZU5hbWVzLmhhcyhuYW1lKSkge1xuICAgICAgICBlcnJvcnMucHVzaChgZHVwbGljYXRlIHByZV9kaXNwYXRjaF9ob29rcyBuYW1lOiAke25hbWV9YCk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgY29uc3QgYmVmb3JlID0gbm9ybWFsaXplU3RyaW5nQXJyYXkoaG9vay5iZWZvcmUpO1xuICAgICAgaWYgKGJlZm9yZS5sZW5ndGggPT09IDApIHtcbiAgICAgICAgZXJyb3JzLnB1c2goYHByZV9kaXNwYXRjaF9ob29rcyBcIiR7bmFtZX1cIiBtaXNzaW5nIGJlZm9yZWApO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGZvciAoY29uc3QgdXQgb2YgYmVmb3JlKSB7XG4gICAgICAgIGlmICgha25vd25Vbml0VHlwZXMuaGFzKHV0KSkge1xuICAgICAgICAgIGVycm9ycy5wdXNoKGBwcmVfZGlzcGF0Y2hfaG9va3MgXCIke25hbWV9XCIgdW5rbm93biB1bml0IHR5cGUgaW4gYmVmb3JlOiAke3V0fWApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBjb25zdCBhY3Rpb24gPSB0eXBlb2YgaG9vay5hY3Rpb24gPT09IFwic3RyaW5nXCIgPyBob29rLmFjdGlvbi50cmltKCkgOiBcIlwiO1xuICAgICAgaWYgKCF2YWxpZEFjdGlvbnMuaGFzKGFjdGlvbikpIHtcbiAgICAgICAgZXJyb3JzLnB1c2goYHByZV9kaXNwYXRjaF9ob29rcyBcIiR7bmFtZX1cIiBpbnZhbGlkIGFjdGlvbjogJHthY3Rpb259IChtdXN0IGJlIG1vZGlmeSwgc2tpcCwgb3IgcmVwbGFjZSlgKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBjb25zdCB2YWxpZEhvb2s6IFByZURpc3BhdGNoSG9va0NvbmZpZyA9IHsgbmFtZSwgYmVmb3JlLCBhY3Rpb246IGFjdGlvbiBhcyBQcmVEaXNwYXRjaEhvb2tDb25maWdbXCJhY3Rpb25cIl0gfTtcbiAgICAgIGlmICh0eXBlb2YgaG9vay5wcmVwZW5kID09PSBcInN0cmluZ1wiICYmIGhvb2sucHJlcGVuZC50cmltKCkpIHZhbGlkSG9vay5wcmVwZW5kID0gaG9vay5wcmVwZW5kLnRyaW0oKTtcbiAgICAgIGlmICh0eXBlb2YgaG9vay5hcHBlbmQgPT09IFwic3RyaW5nXCIgJiYgaG9vay5hcHBlbmQudHJpbSgpKSB2YWxpZEhvb2suYXBwZW5kID0gaG9vay5hcHBlbmQudHJpbSgpO1xuICAgICAgaWYgKHR5cGVvZiBob29rLnByb21wdCA9PT0gXCJzdHJpbmdcIiAmJiBob29rLnByb21wdC50cmltKCkpIHZhbGlkSG9vay5wcm9tcHQgPSBob29rLnByb21wdC50cmltKCk7XG4gICAgICBpZiAodHlwZW9mIGhvb2sudW5pdF90eXBlID09PSBcInN0cmluZ1wiICYmIGhvb2sudW5pdF90eXBlLnRyaW0oKSkgdmFsaWRIb29rLnVuaXRfdHlwZSA9IGhvb2sudW5pdF90eXBlLnRyaW0oKTtcbiAgICAgIGlmICh0eXBlb2YgaG9vay5za2lwX2lmID09PSBcInN0cmluZ1wiICYmIGhvb2suc2tpcF9pZi50cmltKCkpIHZhbGlkSG9vay5za2lwX2lmID0gaG9vay5za2lwX2lmLnRyaW0oKTtcbiAgICAgIGlmICh0eXBlb2YgaG9vay5tb2RlbCA9PT0gXCJzdHJpbmdcIiAmJiBob29rLm1vZGVsLnRyaW0oKSkgdmFsaWRIb29rLm1vZGVsID0gaG9vay5tb2RlbC50cmltKCk7XG4gICAgICBpZiAoaG9vay5lbmFibGVkICE9PSB1bmRlZmluZWQpIHZhbGlkSG9vay5lbmFibGVkID0gISFob29rLmVuYWJsZWQ7XG5cbiAgICAgIC8vIFZhbGlkYXRpb246IGFjdGlvbi1zcGVjaWZpYyByZXF1aXJlZCBmaWVsZHNcbiAgICAgIGlmIChhY3Rpb24gPT09IFwicmVwbGFjZVwiICYmICF2YWxpZEhvb2sucHJvbXB0KSB7XG4gICAgICAgIGVycm9ycy5wdXNoKGBwcmVfZGlzcGF0Y2hfaG9va3MgXCIke25hbWV9XCIgYWN0aW9uIFwicmVwbGFjZVwiIHJlcXVpcmVzIHByb21wdGApO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGlmIChhY3Rpb24gPT09IFwibW9kaWZ5XCIgJiYgIXZhbGlkSG9vay5wcmVwZW5kICYmICF2YWxpZEhvb2suYXBwZW5kKSB7XG4gICAgICAgIGVycm9ycy5wdXNoKGBwcmVfZGlzcGF0Y2hfaG9va3MgXCIke25hbWV9XCIgYWN0aW9uIFwibW9kaWZ5XCIgcmVxdWlyZXMgcHJlcGVuZCBvciBhcHBlbmRgKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIHNlZW5QcmVOYW1lcy5hZGQobmFtZSk7XG4gICAgICB2YWxpZFByZUhvb2tzLnB1c2godmFsaWRIb29rKTtcbiAgICB9XG4gICAgaWYgKHZhbGlkUHJlSG9va3MubGVuZ3RoID4gMCkge1xuICAgICAgdmFsaWRhdGVkLnByZV9kaXNwYXRjaF9ob29rcyA9IHZhbGlkUHJlSG9va3M7XG4gICAgfVxuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIER5bmFtaWMgUm91dGluZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgaWYgKHByZWZlcmVuY2VzLmR5bmFtaWNfcm91dGluZyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgaWYgKHR5cGVvZiBwcmVmZXJlbmNlcy5keW5hbWljX3JvdXRpbmcgPT09IFwib2JqZWN0XCIgJiYgcHJlZmVyZW5jZXMuZHluYW1pY19yb3V0aW5nICE9PSBudWxsKSB7XG4gICAgICBjb25zdCBkciA9IHByZWZlcmVuY2VzLmR5bmFtaWNfcm91dGluZyBhcyB1bmtub3duIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgY29uc3QgdmFsaWREcjogUGFydGlhbDxEeW5hbWljUm91dGluZ0NvbmZpZz4gPSB7fTtcblxuICAgICAgaWYgKGRyLmVuYWJsZWQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICBpZiAodHlwZW9mIGRyLmVuYWJsZWQgPT09IFwiYm9vbGVhblwiKSB2YWxpZERyLmVuYWJsZWQgPSBkci5lbmFibGVkO1xuICAgICAgICBlbHNlIGVycm9ycy5wdXNoKFwiZHluYW1pY19yb3V0aW5nLmVuYWJsZWQgbXVzdCBiZSBhIGJvb2xlYW5cIik7XG4gICAgICB9XG4gICAgICBpZiAoZHIuZXNjYWxhdGVfb25fZmFpbHVyZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGlmICh0eXBlb2YgZHIuZXNjYWxhdGVfb25fZmFpbHVyZSA9PT0gXCJib29sZWFuXCIpIHZhbGlkRHIuZXNjYWxhdGVfb25fZmFpbHVyZSA9IGRyLmVzY2FsYXRlX29uX2ZhaWx1cmU7XG4gICAgICAgIGVsc2UgZXJyb3JzLnB1c2goXCJkeW5hbWljX3JvdXRpbmcuZXNjYWxhdGVfb25fZmFpbHVyZSBtdXN0IGJlIGEgYm9vbGVhblwiKTtcbiAgICAgIH1cbiAgICAgIGlmIChkci5idWRnZXRfcHJlc3N1cmUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICBpZiAodHlwZW9mIGRyLmJ1ZGdldF9wcmVzc3VyZSA9PT0gXCJib29sZWFuXCIpIHZhbGlkRHIuYnVkZ2V0X3ByZXNzdXJlID0gZHIuYnVkZ2V0X3ByZXNzdXJlO1xuICAgICAgICBlbHNlIGVycm9ycy5wdXNoKFwiZHluYW1pY19yb3V0aW5nLmJ1ZGdldF9wcmVzc3VyZSBtdXN0IGJlIGEgYm9vbGVhblwiKTtcbiAgICAgIH1cbiAgICAgIGlmIChkci5jcm9zc19wcm92aWRlciAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGlmICh0eXBlb2YgZHIuY3Jvc3NfcHJvdmlkZXIgPT09IFwiYm9vbGVhblwiKSB2YWxpZERyLmNyb3NzX3Byb3ZpZGVyID0gZHIuY3Jvc3NfcHJvdmlkZXI7XG4gICAgICAgIGVsc2UgZXJyb3JzLnB1c2goXCJkeW5hbWljX3JvdXRpbmcuY3Jvc3NfcHJvdmlkZXIgbXVzdCBiZSBhIGJvb2xlYW5cIik7XG4gICAgICB9XG4gICAgICBpZiAoZHIuaG9va3MgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICBpZiAodHlwZW9mIGRyLmhvb2tzID09PSBcImJvb2xlYW5cIikgdmFsaWREci5ob29rcyA9IGRyLmhvb2tzO1xuICAgICAgICBlbHNlIGVycm9ycy5wdXNoKFwiZHluYW1pY19yb3V0aW5nLmhvb2tzIG11c3QgYmUgYSBib29sZWFuXCIpO1xuICAgICAgfVxuICAgICAgaWYgKGRyLmNhcGFiaWxpdHlfcm91dGluZyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGlmICh0eXBlb2YgZHIuY2FwYWJpbGl0eV9yb3V0aW5nID09PSBcImJvb2xlYW5cIikgdmFsaWREci5jYXBhYmlsaXR5X3JvdXRpbmcgPSBkci5jYXBhYmlsaXR5X3JvdXRpbmc7XG4gICAgICAgIGVsc2UgZXJyb3JzLnB1c2goXCJkeW5hbWljX3JvdXRpbmcuY2FwYWJpbGl0eV9yb3V0aW5nIG11c3QgYmUgYSBib29sZWFuXCIpO1xuICAgICAgfVxuICAgICAgaWYgKGRyLmFsbG93X2ZsYXRfcmF0ZV9wcm92aWRlcnMgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICBpZiAodHlwZW9mIGRyLmFsbG93X2ZsYXRfcmF0ZV9wcm92aWRlcnMgPT09IFwiYm9vbGVhblwiKSB2YWxpZERyLmFsbG93X2ZsYXRfcmF0ZV9wcm92aWRlcnMgPSBkci5hbGxvd19mbGF0X3JhdGVfcHJvdmlkZXJzO1xuICAgICAgICBlbHNlIGVycm9ycy5wdXNoKFwiZHluYW1pY19yb3V0aW5nLmFsbG93X2ZsYXRfcmF0ZV9wcm92aWRlcnMgbXVzdCBiZSBhIGJvb2xlYW5cIik7XG4gICAgICB9XG4gICAgICBpZiAoZHIudGllcl9tb2RlbHMgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICBpZiAodHlwZW9mIGRyLnRpZXJfbW9kZWxzID09PSBcIm9iamVjdFwiICYmIGRyLnRpZXJfbW9kZWxzICE9PSBudWxsKSB7XG4gICAgICAgICAgY29uc3QgdG0gPSBkci50aWVyX21vZGVscyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgICAgICBjb25zdCB2YWxpZFRtOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XG4gICAgICAgICAgZm9yIChjb25zdCB0aWVyIG9mIFtcImxpZ2h0XCIsIFwic3RhbmRhcmRcIiwgXCJoZWF2eVwiXSkge1xuICAgICAgICAgICAgaWYgKHRtW3RpZXJdICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgICAgaWYgKHR5cGVvZiB0bVt0aWVyXSA9PT0gXCJzdHJpbmdcIikgdmFsaWRUbVt0aWVyXSA9IHRtW3RpZXJdIGFzIHN0cmluZztcbiAgICAgICAgICAgICAgZWxzZSBlcnJvcnMucHVzaChgZHluYW1pY19yb3V0aW5nLnRpZXJfbW9kZWxzLiR7dGllcn0gbXVzdCBiZSBhIHN0cmluZ2ApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoT2JqZWN0LmtleXModmFsaWRUbSkubGVuZ3RoID4gMCkgdmFsaWREci50aWVyX21vZGVscyA9IHZhbGlkVG0gYXMgRHluYW1pY1JvdXRpbmdDb25maWdbXCJ0aWVyX21vZGVsc1wiXTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBlcnJvcnMucHVzaChcImR5bmFtaWNfcm91dGluZy50aWVyX21vZGVscyBtdXN0IGJlIGFuIG9iamVjdFwiKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBpZiAoT2JqZWN0LmtleXModmFsaWREcikubGVuZ3RoID4gMCkge1xuICAgICAgICB2YWxpZGF0ZWQuZHluYW1pY19yb3V0aW5nID0gdmFsaWREciBhcyB1bmtub3duIGFzIER5bmFtaWNSb3V0aW5nQ29uZmlnO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBlcnJvcnMucHVzaChcImR5bmFtaWNfcm91dGluZyBtdXN0IGJlIGFuIG9iamVjdFwiKTtcbiAgICB9XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgRGlzYWJsZWQgTW9kZWwgUHJvdmlkZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBpZiAocHJlZmVyZW5jZXMuZGlzYWJsZWRfbW9kZWxfcHJvdmlkZXJzICE9PSB1bmRlZmluZWQpIHtcbiAgICBpZiAoQXJyYXkuaXNBcnJheShwcmVmZXJlbmNlcy5kaXNhYmxlZF9tb2RlbF9wcm92aWRlcnMpKSB7XG4gICAgICBjb25zdCBhbGxTdHJpbmdzID0gcHJlZmVyZW5jZXMuZGlzYWJsZWRfbW9kZWxfcHJvdmlkZXJzLmV2ZXJ5KFxuICAgICAgICAocHJvdmlkZXI6IHVua25vd24pID0+IHR5cGVvZiBwcm92aWRlciA9PT0gXCJzdHJpbmdcIixcbiAgICAgICk7XG4gICAgICBpZiAoIWFsbFN0cmluZ3MpIHtcbiAgICAgICAgZXJyb3JzLnB1c2goXCJkaXNhYmxlZF9tb2RlbF9wcm92aWRlcnMgbXVzdCBiZSBhbiBhcnJheSBvZiBzdHJpbmdzXCIpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc3Qgbm9ybWFsaXplZCA9IHByZWZlcmVuY2VzLmRpc2FibGVkX21vZGVsX3Byb3ZpZGVyc1xuICAgICAgICAgIC5tYXAoKHByb3ZpZGVyKSA9PiBwcm92aWRlci50cmltKCkpXG4gICAgICAgICAgLmZpbHRlcigocHJvdmlkZXIpID0+IHByb3ZpZGVyLmxlbmd0aCA+IDApO1xuICAgICAgICBpZiAobm9ybWFsaXplZC5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgdmFsaWRhdGVkLmRpc2FibGVkX21vZGVsX3Byb3ZpZGVycyA9IEFycmF5LmZyb20obmV3IFNldChub3JtYWxpemVkKSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgZXJyb3JzLnB1c2goXCJkaXNhYmxlZF9tb2RlbF9wcm92aWRlcnMgbXVzdCBiZSBhbiBhcnJheSBvZiBzdHJpbmdzXCIpO1xuICAgIH1cbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBDb250ZXh0IE1hbmFnZW1lbnQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGlmIChwcmVmZXJlbmNlcy5jb250ZXh0X21hbmFnZW1lbnQgIT09IHVuZGVmaW5lZCkge1xuICAgIGlmICh0eXBlb2YgcHJlZmVyZW5jZXMuY29udGV4dF9tYW5hZ2VtZW50ID09PSBcIm9iamVjdFwiICYmIHByZWZlcmVuY2VzLmNvbnRleHRfbWFuYWdlbWVudCAhPT0gbnVsbCkge1xuICAgICAgY29uc3QgY20gPSBwcmVmZXJlbmNlcy5jb250ZXh0X21hbmFnZW1lbnQgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgIGNvbnN0IHZhbGlkQ206IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG5cbiAgICAgIGlmIChjbS5vYnNlcnZhdGlvbl9tYXNraW5nICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgaWYgKHR5cGVvZiBjbS5vYnNlcnZhdGlvbl9tYXNraW5nID09PSBcImJvb2xlYW5cIikgdmFsaWRDbS5vYnNlcnZhdGlvbl9tYXNraW5nID0gY20ub2JzZXJ2YXRpb25fbWFza2luZztcbiAgICAgICAgZWxzZSBlcnJvcnMucHVzaChcImNvbnRleHRfbWFuYWdlbWVudC5vYnNlcnZhdGlvbl9tYXNraW5nIG11c3QgYmUgYSBib29sZWFuXCIpO1xuICAgICAgfVxuICAgICAgaWYgKGNtLm9ic2VydmF0aW9uX21hc2tfdHVybnMgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICBjb25zdCB0dXJucyA9IGNtLm9ic2VydmF0aW9uX21hc2tfdHVybnM7XG4gICAgICAgIGlmICh0eXBlb2YgdHVybnMgPT09IFwibnVtYmVyXCIgJiYgdHVybnMgPj0gMSAmJiB0dXJucyA8PSA1MCkgdmFsaWRDbS5vYnNlcnZhdGlvbl9tYXNrX3R1cm5zID0gdHVybnM7XG4gICAgICAgIGVsc2UgZXJyb3JzLnB1c2goXCJjb250ZXh0X21hbmFnZW1lbnQub2JzZXJ2YXRpb25fbWFza190dXJucyBtdXN0IGJlIGEgbnVtYmVyIGJldHdlZW4gMSBhbmQgNTBcIik7XG4gICAgICB9XG4gICAgICBpZiAoY20uY29tcGFjdGlvbl90aHJlc2hvbGRfcGVyY2VudCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGNvbnN0IHBjdCA9IGNtLmNvbXBhY3Rpb25fdGhyZXNob2xkX3BlcmNlbnQ7XG4gICAgICAgIGlmICh0eXBlb2YgcGN0ID09PSBcIm51bWJlclwiICYmIHBjdCA+PSAwLjUgJiYgcGN0IDw9IDAuOTUpIHZhbGlkQ20uY29tcGFjdGlvbl90aHJlc2hvbGRfcGVyY2VudCA9IHBjdDtcbiAgICAgICAgZWxzZSBlcnJvcnMucHVzaChcImNvbnRleHRfbWFuYWdlbWVudC5jb21wYWN0aW9uX3RocmVzaG9sZF9wZXJjZW50IG11c3QgYmUgYSBudW1iZXIgYmV0d2VlbiAwLjUgYW5kIDAuOTVcIik7XG4gICAgICB9XG4gICAgICBpZiAoY20udG9vbF9yZXN1bHRfbWF4X2NoYXJzICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgY29uc3QgY2hhcnMgPSBjbS50b29sX3Jlc3VsdF9tYXhfY2hhcnM7XG4gICAgICAgIGlmICh0eXBlb2YgY2hhcnMgPT09IFwibnVtYmVyXCIgJiYgY2hhcnMgPj0gMjAwICYmIGNoYXJzIDw9IDEwMDAwKSB2YWxpZENtLnRvb2xfcmVzdWx0X21heF9jaGFycyA9IGNoYXJzO1xuICAgICAgICBlbHNlIGVycm9ycy5wdXNoKFwiY29udGV4dF9tYW5hZ2VtZW50LnRvb2xfcmVzdWx0X21heF9jaGFycyBtdXN0IGJlIGEgbnVtYmVyIGJldHdlZW4gMjAwIGFuZCAxMDAwMFwiKTtcbiAgICAgIH1cblxuICAgICAgaWYgKE9iamVjdC5rZXlzKHZhbGlkQ20pLmxlbmd0aCA+IDApIHtcbiAgICAgICAgdmFsaWRhdGVkLmNvbnRleHRfbWFuYWdlbWVudCA9IHZhbGlkQ20gYXMgYW55O1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBlcnJvcnMucHVzaChcImNvbnRleHRfbWFuYWdlbWVudCBtdXN0IGJlIGFuIG9iamVjdFwiKTtcbiAgICB9XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgQ29udGV4dCBNb2RlIChnc2RfZXhlYyBzYW5kYm94KSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgaWYgKHByZWZlcmVuY2VzLmNvbnRleHRfbW9kZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgaWYgKHR5cGVvZiBwcmVmZXJlbmNlcy5jb250ZXh0X21vZGUgPT09IFwib2JqZWN0XCIgJiYgcHJlZmVyZW5jZXMuY29udGV4dF9tb2RlICE9PSBudWxsKSB7XG4gICAgICBjb25zdCBjbW9kZSA9IHByZWZlcmVuY2VzLmNvbnRleHRfbW9kZSBhcyB1bmtub3duIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgY29uc3QgdmFsaWRDbW9kZTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcblxuICAgICAgaWYgKGNtb2RlLmVuYWJsZWQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICBpZiAodHlwZW9mIGNtb2RlLmVuYWJsZWQgPT09IFwiYm9vbGVhblwiKSB2YWxpZENtb2RlLmVuYWJsZWQgPSBjbW9kZS5lbmFibGVkO1xuICAgICAgICBlbHNlIGVycm9ycy5wdXNoKFwiY29udGV4dF9tb2RlLmVuYWJsZWQgbXVzdCBiZSBhIGJvb2xlYW5cIik7XG4gICAgICB9XG4gICAgICBpZiAoY21vZGUuZXhlY190aW1lb3V0X21zICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgY29uc3QgdCA9IGNtb2RlLmV4ZWNfdGltZW91dF9tcztcbiAgICAgICAgaWYgKHR5cGVvZiB0ID09PSBcIm51bWJlclwiICYmIHQgPj0gMTAwMCAmJiB0IDw9IDYwMF8wMDApIHZhbGlkQ21vZGUuZXhlY190aW1lb3V0X21zID0gTWF0aC5mbG9vcih0KTtcbiAgICAgICAgZWxzZSBlcnJvcnMucHVzaChcImNvbnRleHRfbW9kZS5leGVjX3RpbWVvdXRfbXMgbXVzdCBiZSBhIG51bWJlciBiZXR3ZWVuIDEwMDAgYW5kIDYwMDAwMFwiKTtcbiAgICAgIH1cbiAgICAgIGlmIChjbW9kZS5leGVjX3N0ZG91dF9jYXBfYnl0ZXMgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICBjb25zdCBiID0gY21vZGUuZXhlY19zdGRvdXRfY2FwX2J5dGVzO1xuICAgICAgICBpZiAodHlwZW9mIGIgPT09IFwibnVtYmVyXCIgJiYgYiA+PSA0MDk2ICYmIGIgPD0gMTZfNzc3XzIxNikgdmFsaWRDbW9kZS5leGVjX3N0ZG91dF9jYXBfYnl0ZXMgPSBNYXRoLmZsb29yKGIpO1xuICAgICAgICBlbHNlIGVycm9ycy5wdXNoKFwiY29udGV4dF9tb2RlLmV4ZWNfc3Rkb3V0X2NhcF9ieXRlcyBtdXN0IGJlIGEgbnVtYmVyIGJldHdlZW4gNDA5NiBhbmQgMTY3NzcyMTZcIik7XG4gICAgICB9XG4gICAgICBpZiAoY21vZGUuZXhlY19kaWdlc3RfY2hhcnMgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICBjb25zdCBjID0gY21vZGUuZXhlY19kaWdlc3RfY2hhcnM7XG4gICAgICAgIGlmICh0eXBlb2YgYyA9PT0gXCJudW1iZXJcIiAmJiBjID49IDAgJiYgYyA8PSA0MDAwKSB2YWxpZENtb2RlLmV4ZWNfZGlnZXN0X2NoYXJzID0gTWF0aC5mbG9vcihjKTtcbiAgICAgICAgZWxzZSBlcnJvcnMucHVzaChcImNvbnRleHRfbW9kZS5leGVjX2RpZ2VzdF9jaGFycyBtdXN0IGJlIGEgbnVtYmVyIGJldHdlZW4gMCBhbmQgNDAwMFwiKTtcbiAgICAgIH1cbiAgICAgIGlmIChjbW9kZS5leGVjX2Vudl9hbGxvd2xpc3QgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICBpZiAoXG4gICAgICAgICAgQXJyYXkuaXNBcnJheShjbW9kZS5leGVjX2Vudl9hbGxvd2xpc3QpICYmXG4gICAgICAgICAgY21vZGUuZXhlY19lbnZfYWxsb3dsaXN0LmV2ZXJ5KCh2KSA9PiB0eXBlb2YgdiA9PT0gXCJzdHJpbmdcIiAmJiAvXltBLVpfXVtBLVowLTlfXSokL2kudGVzdCh2KSlcbiAgICAgICAgKSB7XG4gICAgICAgICAgdmFsaWRDbW9kZS5leGVjX2Vudl9hbGxvd2xpc3QgPSBjbW9kZS5leGVjX2Vudl9hbGxvd2xpc3Q7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgZXJyb3JzLnB1c2goXCJjb250ZXh0X21vZGUuZXhlY19lbnZfYWxsb3dsaXN0IG11c3QgYmUgYW4gYXJyYXkgb2YgdmFsaWQgZW52IHZhciBuYW1lc1wiKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBpZiAoT2JqZWN0LmtleXModmFsaWRDbW9kZSkubGVuZ3RoID4gMCkge1xuICAgICAgICB2YWxpZGF0ZWQuY29udGV4dF9tb2RlID0gdmFsaWRDbW9kZSBhcyBhbnk7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIGVycm9ycy5wdXNoKFwiY29udGV4dF9tb2RlIG11c3QgYmUgYW4gb2JqZWN0XCIpO1xuICAgIH1cbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBQYXJhbGxlbCBDb25maWcgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGlmIChwcmVmZXJlbmNlcy5wYXJhbGxlbCAmJiB0eXBlb2YgcHJlZmVyZW5jZXMucGFyYWxsZWwgPT09IFwib2JqZWN0XCIpIHtcbiAgICBjb25zdCBwID0gcHJlZmVyZW5jZXMucGFyYWxsZWwgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICBjb25zdCBwYXJhbGxlbDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcblxuICAgIGlmIChwLmVuYWJsZWQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgaWYgKHR5cGVvZiBwLmVuYWJsZWQgPT09IFwiYm9vbGVhblwiKSBwYXJhbGxlbC5lbmFibGVkID0gcC5lbmFibGVkO1xuICAgICAgZWxzZSBlcnJvcnMucHVzaChcInBhcmFsbGVsLmVuYWJsZWQgbXVzdCBiZSBhIGJvb2xlYW5cIik7XG4gICAgfVxuICAgIGlmIChwLm1heF93b3JrZXJzICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGlmICh0eXBlb2YgcC5tYXhfd29ya2VycyA9PT0gXCJudW1iZXJcIiAmJiBwLm1heF93b3JrZXJzID49IDEgJiYgcC5tYXhfd29ya2VycyA8PSA0KSB7XG4gICAgICAgIHBhcmFsbGVsLm1heF93b3JrZXJzID0gTWF0aC5mbG9vcihwLm1heF93b3JrZXJzKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGVycm9ycy5wdXNoKFwicGFyYWxsZWwubWF4X3dvcmtlcnMgbXVzdCBiZSBhIG51bWJlciBiZXR3ZWVuIDEgYW5kIDRcIik7XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChwLmJ1ZGdldF9jZWlsaW5nICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGlmICh0eXBlb2YgcC5idWRnZXRfY2VpbGluZyA9PT0gXCJudW1iZXJcIiAmJiBwLmJ1ZGdldF9jZWlsaW5nID4gMCkge1xuICAgICAgICBwYXJhbGxlbC5idWRnZXRfY2VpbGluZyA9IHAuYnVkZ2V0X2NlaWxpbmc7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBlcnJvcnMucHVzaChcInBhcmFsbGVsLmJ1ZGdldF9jZWlsaW5nIG11c3QgYmUgYSBwb3NpdGl2ZSBudW1iZXJcIik7XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChwLm1lcmdlX3N0cmF0ZWd5ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbnN0IHZhbGlkU3RyYXRlZ2llcyA9IG5ldyBTZXQoW1wicGVyLXNsaWNlXCIsIFwicGVyLW1pbGVzdG9uZVwiXSk7XG4gICAgICBpZiAodHlwZW9mIHAubWVyZ2Vfc3RyYXRlZ3kgPT09IFwic3RyaW5nXCIgJiYgdmFsaWRTdHJhdGVnaWVzLmhhcyhwLm1lcmdlX3N0cmF0ZWd5KSkge1xuICAgICAgICBwYXJhbGxlbC5tZXJnZV9zdHJhdGVneSA9IHAubWVyZ2Vfc3RyYXRlZ3k7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBlcnJvcnMucHVzaChcInBhcmFsbGVsLm1lcmdlX3N0cmF0ZWd5IG11c3QgYmUgb25lIG9mOiBwZXItc2xpY2UsIHBlci1taWxlc3RvbmVcIik7XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChwLmF1dG9fbWVyZ2UgIT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uc3QgdmFsaWRNb2RlcyA9IG5ldyBTZXQoW1wiYXV0b1wiLCBcImNvbmZpcm1cIiwgXCJtYW51YWxcIl0pO1xuICAgICAgaWYgKHR5cGVvZiBwLmF1dG9fbWVyZ2UgPT09IFwic3RyaW5nXCIgJiYgdmFsaWRNb2Rlcy5oYXMocC5hdXRvX21lcmdlKSkge1xuICAgICAgICBwYXJhbGxlbC5hdXRvX21lcmdlID0gcC5hdXRvX21lcmdlO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgZXJyb3JzLnB1c2goXCJwYXJhbGxlbC5hdXRvX21lcmdlIG11c3QgYmUgb25lIG9mOiBhdXRvLCBjb25maXJtLCBtYW51YWxcIik7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKHAud29ya2VyX21vZGVsICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGlmICh0eXBlb2YgcC53b3JrZXJfbW9kZWwgPT09IFwic3RyaW5nXCIgJiYgcC53b3JrZXJfbW9kZWwubGVuZ3RoID4gMCkge1xuICAgICAgICBwYXJhbGxlbC53b3JrZXJfbW9kZWwgPSBwLndvcmtlcl9tb2RlbDtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGVycm9ycy5wdXNoKFwicGFyYWxsZWwud29ya2VyX21vZGVsIG11c3QgYmUgYSBub24tZW1wdHkgc3RyaW5nXCIpO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChPYmplY3Qua2V5cyhwYXJhbGxlbCkubGVuZ3RoID4gMCkge1xuICAgICAgdmFsaWRhdGVkLnBhcmFsbGVsID0gcGFyYWxsZWwgYXMgdW5rbm93biBhcyBpbXBvcnQoXCIuL3R5cGVzLmpzXCIpLlBhcmFsbGVsQ29uZmlnO1xuICAgIH1cbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTbGljZSBQYXJhbGxlbCBDb25maWcgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGlmIChwcmVmZXJlbmNlcy5zbGljZV9wYXJhbGxlbCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgaWYgKHR5cGVvZiBwcmVmZXJlbmNlcy5zbGljZV9wYXJhbGxlbCA9PT0gXCJvYmplY3RcIiAmJiBwcmVmZXJlbmNlcy5zbGljZV9wYXJhbGxlbCAhPT0gbnVsbCkge1xuICAgICAgY29uc3Qgc3AgPSBwcmVmZXJlbmNlcy5zbGljZV9wYXJhbGxlbCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgIGNvbnN0IHZhbGlkU3A6IE5vbk51bGxhYmxlPEdTRFByZWZlcmVuY2VzW1wic2xpY2VfcGFyYWxsZWxcIl0+ID0ge307XG5cbiAgICAgIGlmIChzcC5lbmFibGVkICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgaWYgKHR5cGVvZiBzcC5lbmFibGVkID09PSBcImJvb2xlYW5cIikgdmFsaWRTcC5lbmFibGVkID0gc3AuZW5hYmxlZDtcbiAgICAgICAgZWxzZSBlcnJvcnMucHVzaChcInNsaWNlX3BhcmFsbGVsLmVuYWJsZWQgbXVzdCBiZSBhIGJvb2xlYW5cIik7XG4gICAgICB9XG5cbiAgICAgIGlmIChzcC5tYXhfd29ya2VycyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGNvbnN0IG1heFdvcmtlcnMgPSB0eXBlb2Ygc3AubWF4X3dvcmtlcnMgPT09IFwibnVtYmVyXCIgPyBzcC5tYXhfd29ya2VycyA6IE51bWJlcihzcC5tYXhfd29ya2Vycyk7XG4gICAgICAgIGlmIChOdW1iZXIuaXNGaW5pdGUobWF4V29ya2VycykgJiYgbWF4V29ya2VycyA+PSAxICYmIG1heFdvcmtlcnMgPD0gOCkge1xuICAgICAgICAgIHZhbGlkU3AubWF4X3dvcmtlcnMgPSBNYXRoLmZsb29yKG1heFdvcmtlcnMpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGVycm9ycy5wdXNoKFwic2xpY2VfcGFyYWxsZWwubWF4X3dvcmtlcnMgbXVzdCBiZSBhIG51bWJlciBiZXR3ZWVuIDEgYW5kIDhcIik7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgY29uc3Qga25vd25TbGljZVBhcmFsbGVsS2V5cyA9IG5ldyBTZXQoW1wiZW5hYmxlZFwiLCBcIm1heF93b3JrZXJzXCJdKTtcbiAgICAgIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKHNwKSkge1xuICAgICAgICBpZiAoIWtub3duU2xpY2VQYXJhbGxlbEtleXMuaGFzKGtleSkpIHtcbiAgICAgICAgICB3YXJuaW5ncy5wdXNoKGB1bmtub3duIHNsaWNlX3BhcmFsbGVsIGtleSBcIiR7a2V5fVwiIFx1MjAxNCBpZ25vcmVkYCk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgaWYgKE9iamVjdC5rZXlzKHZhbGlkU3ApLmxlbmd0aCA+IDApIHtcbiAgICAgICAgdmFsaWRhdGVkLnNsaWNlX3BhcmFsbGVsID0gdmFsaWRTcDtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgZXJyb3JzLnB1c2goXCJzbGljZV9wYXJhbGxlbCBtdXN0IGJlIGFuIG9iamVjdFwiKTtcbiAgICB9XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgUmVhY3RpdmUgRXhlY3V0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBpZiAocHJlZmVyZW5jZXMucmVhY3RpdmVfZXhlY3V0aW9uICE9PSB1bmRlZmluZWQpIHtcbiAgICBpZiAodHlwZW9mIHByZWZlcmVuY2VzLnJlYWN0aXZlX2V4ZWN1dGlvbiA9PT0gXCJvYmplY3RcIiAmJiBwcmVmZXJlbmNlcy5yZWFjdGl2ZV9leGVjdXRpb24gIT09IG51bGwpIHtcbiAgICAgIGNvbnN0IHJlID0gcHJlZmVyZW5jZXMucmVhY3RpdmVfZXhlY3V0aW9uIGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICBjb25zdCB2YWxpZFJlOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuXG4gICAgICBpZiAocmUuZW5hYmxlZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGlmICh0eXBlb2YgcmUuZW5hYmxlZCA9PT0gXCJib29sZWFuXCIpIHZhbGlkUmUuZW5hYmxlZCA9IHJlLmVuYWJsZWQ7XG4gICAgICAgIGVsc2UgZXJyb3JzLnB1c2goXCJyZWFjdGl2ZV9leGVjdXRpb24uZW5hYmxlZCBtdXN0IGJlIGEgYm9vbGVhblwiKTtcbiAgICAgIH1cbiAgICAgIGlmIChyZS5tYXhfcGFyYWxsZWwgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICBjb25zdCBtcCA9IHR5cGVvZiByZS5tYXhfcGFyYWxsZWwgPT09IFwibnVtYmVyXCIgPyByZS5tYXhfcGFyYWxsZWwgOiBOdW1iZXIocmUubWF4X3BhcmFsbGVsKTtcbiAgICAgICAgaWYgKE51bWJlci5pc0Zpbml0ZShtcCkgJiYgbXAgPj0gMSAmJiBtcCA8PSA4KSB7XG4gICAgICAgICAgdmFsaWRSZS5tYXhfcGFyYWxsZWwgPSBNYXRoLmZsb29yKG1wKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBlcnJvcnMucHVzaChcInJlYWN0aXZlX2V4ZWN1dGlvbi5tYXhfcGFyYWxsZWwgbXVzdCBiZSBhIG51bWJlciBiZXR3ZWVuIDEgYW5kIDhcIik7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChyZS5pc29sYXRpb25fbW9kZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGlmIChyZS5pc29sYXRpb25fbW9kZSA9PT0gXCJzYW1lLXRyZWVcIikge1xuICAgICAgICAgIHZhbGlkUmUuaXNvbGF0aW9uX21vZGUgPSBcInNhbWUtdHJlZVwiO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGVycm9ycy5wdXNoKCdyZWFjdGl2ZV9leGVjdXRpb24uaXNvbGF0aW9uX21vZGUgbXVzdCBiZSBcInNhbWUtdHJlZVwiJyk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgaWYgKHJlLnN1YmFnZW50X21vZGVsICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgaWYgKHR5cGVvZiByZS5zdWJhZ2VudF9tb2RlbCA9PT0gXCJzdHJpbmdcIiAmJiByZS5zdWJhZ2VudF9tb2RlbC5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgdmFsaWRSZS5zdWJhZ2VudF9tb2RlbCA9IHJlLnN1YmFnZW50X21vZGVsO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGVycm9ycy5wdXNoKFwicmVhY3RpdmVfZXhlY3V0aW9uLnN1YmFnZW50X21vZGVsIG11c3QgYmUgYSBub24tZW1wdHkgc3RyaW5nXCIpO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGtub3duUmVLZXlzID0gbmV3IFNldChbXCJlbmFibGVkXCIsIFwibWF4X3BhcmFsbGVsXCIsIFwiaXNvbGF0aW9uX21vZGVcIiwgXCJzdWJhZ2VudF9tb2RlbFwiXSk7XG4gICAgICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhyZSkpIHtcbiAgICAgICAgaWYgKCFrbm93blJlS2V5cy5oYXMoa2V5KSkge1xuICAgICAgICAgIHdhcm5pbmdzLnB1c2goYHVua25vd24gcmVhY3RpdmVfZXhlY3V0aW9uIGtleSBcIiR7a2V5fVwiIFx1MjAxNCBpZ25vcmVkYCk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgaWYgKE9iamVjdC5rZXlzKHZhbGlkUmUpLmxlbmd0aCA+IDApIHtcbiAgICAgICAgdmFsaWRhdGVkLnJlYWN0aXZlX2V4ZWN1dGlvbiA9IHZhbGlkUmUgYXMgdW5rbm93biBhcyBpbXBvcnQoXCIuL3R5cGVzLmpzXCIpLlJlYWN0aXZlRXhlY3V0aW9uQ29uZmlnO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBlcnJvcnMucHVzaChcInJlYWN0aXZlX2V4ZWN1dGlvbiBtdXN0IGJlIGFuIG9iamVjdFwiKTtcbiAgICB9XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgR2F0ZSBFdmFsdWF0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBpZiAocHJlZmVyZW5jZXMuZ2F0ZV9ldmFsdWF0aW9uICE9PSB1bmRlZmluZWQpIHtcbiAgICBpZiAodHlwZW9mIHByZWZlcmVuY2VzLmdhdGVfZXZhbHVhdGlvbiA9PT0gXCJvYmplY3RcIiAmJiBwcmVmZXJlbmNlcy5nYXRlX2V2YWx1YXRpb24gIT09IG51bGwpIHtcbiAgICAgIGNvbnN0IGdlID0gcHJlZmVyZW5jZXMuZ2F0ZV9ldmFsdWF0aW9uIGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICBjb25zdCB2YWxpZEdlOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuXG4gICAgICBpZiAoZ2UuZW5hYmxlZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGlmICh0eXBlb2YgZ2UuZW5hYmxlZCA9PT0gXCJib29sZWFuXCIpIHZhbGlkR2UuZW5hYmxlZCA9IGdlLmVuYWJsZWQ7XG4gICAgICAgIGVsc2UgZXJyb3JzLnB1c2goXCJnYXRlX2V2YWx1YXRpb24uZW5hYmxlZCBtdXN0IGJlIGEgYm9vbGVhblwiKTtcbiAgICAgIH1cbiAgICAgIGlmIChnZS5zbGljZV9nYXRlcyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGdlLnNsaWNlX2dhdGVzKSAmJiBnZS5zbGljZV9nYXRlcy5ldmVyeSgoZzogdW5rbm93bikgPT4gdHlwZW9mIGcgPT09IFwic3RyaW5nXCIpKSB7XG4gICAgICAgICAgdmFsaWRHZS5zbGljZV9nYXRlcyA9IGdlLnNsaWNlX2dhdGVzO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGVycm9ycy5wdXNoKFwiZ2F0ZV9ldmFsdWF0aW9uLnNsaWNlX2dhdGVzIG11c3QgYmUgYW4gYXJyYXkgb2Ygc3RyaW5nc1wiKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKGdlLnRhc2tfZ2F0ZXMgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICBpZiAodHlwZW9mIGdlLnRhc2tfZ2F0ZXMgPT09IFwiYm9vbGVhblwiKSB2YWxpZEdlLnRhc2tfZ2F0ZXMgPSBnZS50YXNrX2dhdGVzO1xuICAgICAgICBlbHNlIGVycm9ycy5wdXNoKFwiZ2F0ZV9ldmFsdWF0aW9uLnRhc2tfZ2F0ZXMgbXVzdCBiZSBhIGJvb2xlYW5cIik7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGtub3duR2VLZXlzID0gbmV3IFNldChbXCJlbmFibGVkXCIsIFwic2xpY2VfZ2F0ZXNcIiwgXCJ0YXNrX2dhdGVzXCJdKTtcbiAgICAgIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKGdlKSkge1xuICAgICAgICBpZiAoIWtub3duR2VLZXlzLmhhcyhrZXkpKSB7XG4gICAgICAgICAgd2FybmluZ3MucHVzaChgdW5rbm93biBnYXRlX2V2YWx1YXRpb24ga2V5IFwiJHtrZXl9XCIgXHUyMDE0IGlnbm9yZWRgKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBpZiAoT2JqZWN0LmtleXModmFsaWRHZSkubGVuZ3RoID4gMCkge1xuICAgICAgICB2YWxpZGF0ZWQuZ2F0ZV9ldmFsdWF0aW9uID0gdmFsaWRHZSBhcyB1bmtub3duIGFzIGltcG9ydChcIi4vdHlwZXMuanNcIikuR2F0ZUV2YWx1YXRpb25Db25maWc7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIGVycm9ycy5wdXNoKFwiZ2F0ZV9ldmFsdWF0aW9uIG11c3QgYmUgYW4gb2JqZWN0XCIpO1xuICAgIH1cbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBWZXJpZmljYXRpb24gUHJlZmVyZW5jZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGlmIChwcmVmZXJlbmNlcy52ZXJpZmljYXRpb25fY29tbWFuZHMgIT09IHVuZGVmaW5lZCkge1xuICAgIGlmIChBcnJheS5pc0FycmF5KHByZWZlcmVuY2VzLnZlcmlmaWNhdGlvbl9jb21tYW5kcykpIHtcbiAgICAgIGNvbnN0IGFsbFN0cmluZ3MgPSBwcmVmZXJlbmNlcy52ZXJpZmljYXRpb25fY29tbWFuZHMuZXZlcnkoXG4gICAgICAgIChpdGVtOiB1bmtub3duKSA9PiB0eXBlb2YgaXRlbSA9PT0gXCJzdHJpbmdcIixcbiAgICAgICk7XG4gICAgICBpZiAoYWxsU3RyaW5ncykge1xuICAgICAgICB2YWxpZGF0ZWQudmVyaWZpY2F0aW9uX2NvbW1hbmRzID0gcHJlZmVyZW5jZXMudmVyaWZpY2F0aW9uX2NvbW1hbmRzO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgZXJyb3JzLnB1c2goXCJ2ZXJpZmljYXRpb25fY29tbWFuZHMgbXVzdCBiZSBhbiBhcnJheSBvZiBzdHJpbmdzXCIpO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBlcnJvcnMucHVzaChcInZlcmlmaWNhdGlvbl9jb21tYW5kcyBtdXN0IGJlIGFuIGFycmF5IG9mIHN0cmluZ3NcIik7XG4gICAgfVxuICB9XG5cbiAgaWYgKHByZWZlcmVuY2VzLnZlcmlmaWNhdGlvbl9hdXRvX2ZpeCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgaWYgKHR5cGVvZiBwcmVmZXJlbmNlcy52ZXJpZmljYXRpb25fYXV0b19maXggPT09IFwiYm9vbGVhblwiKSB7XG4gICAgICB2YWxpZGF0ZWQudmVyaWZpY2F0aW9uX2F1dG9fZml4ID0gcHJlZmVyZW5jZXMudmVyaWZpY2F0aW9uX2F1dG9fZml4O1xuICAgIH0gZWxzZSB7XG4gICAgICBlcnJvcnMucHVzaChcInZlcmlmaWNhdGlvbl9hdXRvX2ZpeCBtdXN0IGJlIGEgYm9vbGVhblwiKTtcbiAgICB9XG4gIH1cblxuICBpZiAocHJlZmVyZW5jZXMudmVyaWZpY2F0aW9uX21heF9yZXRyaWVzICE9PSB1bmRlZmluZWQpIHtcbiAgICBjb25zdCByYXcgPSBwcmVmZXJlbmNlcy52ZXJpZmljYXRpb25fbWF4X3JldHJpZXM7XG4gICAgaWYgKHR5cGVvZiByYXcgPT09IFwibnVtYmVyXCIgJiYgTnVtYmVyLmlzRmluaXRlKHJhdykgJiYgcmF3ID49IDApIHtcbiAgICAgIHZhbGlkYXRlZC52ZXJpZmljYXRpb25fbWF4X3JldHJpZXMgPSBNYXRoLmZsb29yKHJhdyk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGVycm9ycy5wdXNoKFwidmVyaWZpY2F0aW9uX21heF9yZXRyaWVzIG11c3QgYmUgYSBub24tbmVnYXRpdmUgbnVtYmVyXCIpO1xuICAgIH1cbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBHaXQgUHJlZmVyZW5jZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGlmIChwcmVmZXJlbmNlcy5naXQgJiYgdHlwZW9mIHByZWZlcmVuY2VzLmdpdCA9PT0gXCJvYmplY3RcIikge1xuICAgIGNvbnN0IGdpdDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgICBjb25zdCBnID0gcHJlZmVyZW5jZXMuZ2l0IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuXG4gICAgaWYgKGcuYXV0b19wdXNoICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGlmICh0eXBlb2YgZy5hdXRvX3B1c2ggPT09IFwiYm9vbGVhblwiKSBnaXQuYXV0b19wdXNoID0gZy5hdXRvX3B1c2g7XG4gICAgICBlbHNlIGVycm9ycy5wdXNoKFwiZ2l0LmF1dG9fcHVzaCBtdXN0IGJlIGEgYm9vbGVhblwiKTtcbiAgICB9XG4gICAgaWYgKGcucHVzaF9icmFuY2hlcyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBpZiAodHlwZW9mIGcucHVzaF9icmFuY2hlcyA9PT0gXCJib29sZWFuXCIpIGdpdC5wdXNoX2JyYW5jaGVzID0gZy5wdXNoX2JyYW5jaGVzO1xuICAgICAgZWxzZSBlcnJvcnMucHVzaChcImdpdC5wdXNoX2JyYW5jaGVzIG11c3QgYmUgYSBib29sZWFuXCIpO1xuICAgIH1cbiAgICBpZiAoZy5yZW1vdGUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgaWYgKHR5cGVvZiBnLnJlbW90ZSA9PT0gXCJzdHJpbmdcIiAmJiBnLnJlbW90ZS50cmltKCkgIT09IFwiXCIpIGdpdC5yZW1vdGUgPSBnLnJlbW90ZS50cmltKCk7XG4gICAgICBlbHNlIGVycm9ycy5wdXNoKFwiZ2l0LnJlbW90ZSBtdXN0IGJlIGEgbm9uLWVtcHR5IHN0cmluZ1wiKTtcbiAgICB9XG4gICAgaWYgKGcuc25hcHNob3RzICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGlmICh0eXBlb2YgZy5zbmFwc2hvdHMgPT09IFwiYm9vbGVhblwiKSBnaXQuc25hcHNob3RzID0gZy5zbmFwc2hvdHM7XG4gICAgICBlbHNlIGVycm9ycy5wdXNoKFwiZ2l0LnNuYXBzaG90cyBtdXN0IGJlIGEgYm9vbGVhblwiKTtcbiAgICB9XG4gICAgaWYgKGcucHJlX21lcmdlX2NoZWNrICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGlmICh0eXBlb2YgZy5wcmVfbWVyZ2VfY2hlY2sgPT09IFwiYm9vbGVhblwiKSB7XG4gICAgICAgIGdpdC5wcmVfbWVyZ2VfY2hlY2sgPSBnLnByZV9tZXJnZV9jaGVjaztcbiAgICAgIH0gZWxzZSBpZiAodHlwZW9mIGcucHJlX21lcmdlX2NoZWNrID09PSBcInN0cmluZ1wiICYmIGcucHJlX21lcmdlX2NoZWNrLnRyaW0oKSAhPT0gXCJcIikge1xuICAgICAgICBnaXQucHJlX21lcmdlX2NoZWNrID0gZy5wcmVfbWVyZ2VfY2hlY2sudHJpbSgpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgZXJyb3JzLnB1c2goXCJnaXQucHJlX21lcmdlX2NoZWNrIG11c3QgYmUgYSBib29sZWFuIG9yIGEgbm9uLWVtcHR5IHN0cmluZyBjb21tYW5kXCIpO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAoZy5jb21taXRfdHlwZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25zdCB2YWxpZENvbW1pdFR5cGVzID0gbmV3IFNldChbXG4gICAgICAgIFwiZmVhdFwiLCBcImZpeFwiLCBcInJlZmFjdG9yXCIsIFwiZG9jc1wiLCBcInRlc3RcIiwgXCJjaG9yZVwiLCBcInBlcmZcIiwgXCJjaVwiLCBcImJ1aWxkXCIsIFwic3R5bGVcIixcbiAgICAgIF0pO1xuICAgICAgaWYgKHR5cGVvZiBnLmNvbW1pdF90eXBlID09PSBcInN0cmluZ1wiICYmIHZhbGlkQ29tbWl0VHlwZXMuaGFzKGcuY29tbWl0X3R5cGUpKSB7XG4gICAgICAgIGdpdC5jb21taXRfdHlwZSA9IGcuY29tbWl0X3R5cGU7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBlcnJvcnMucHVzaChgZ2l0LmNvbW1pdF90eXBlIG11c3QgYmUgb25lIG9mOiBmZWF0LCBmaXgsIHJlZmFjdG9yLCBkb2NzLCB0ZXN0LCBjaG9yZSwgcGVyZiwgY2ksIGJ1aWxkLCBzdHlsZWApO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAoZy5tZXJnZV9zdHJhdGVneSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25zdCB2YWxpZFN0cmF0ZWdpZXMgPSBuZXcgU2V0KFtcInNxdWFzaFwiLCBcIm1lcmdlXCJdKTtcbiAgICAgIGlmICh0eXBlb2YgZy5tZXJnZV9zdHJhdGVneSA9PT0gXCJzdHJpbmdcIiAmJiB2YWxpZFN0cmF0ZWdpZXMuaGFzKGcubWVyZ2Vfc3RyYXRlZ3kpKSB7XG4gICAgICAgIGdpdC5tZXJnZV9zdHJhdGVneSA9IGcubWVyZ2Vfc3RyYXRlZ3kgYXMgXCJzcXVhc2hcIiB8IFwibWVyZ2VcIjtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGVycm9ycy5wdXNoKFwiZ2l0Lm1lcmdlX3N0cmF0ZWd5IG11c3QgYmUgb25lIG9mOiBzcXVhc2gsIG1lcmdlXCIpO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAoZy5tYWluX2JyYW5jaCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBpZiAodHlwZW9mIGcubWFpbl9icmFuY2ggPT09IFwic3RyaW5nXCIgJiYgZy5tYWluX2JyYW5jaC50cmltKCkgIT09IFwiXCIgJiYgVkFMSURfQlJBTkNIX05BTUUudGVzdChnLm1haW5fYnJhbmNoKSkge1xuICAgICAgICBnaXQubWFpbl9icmFuY2ggPSBnLm1haW5fYnJhbmNoO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgZXJyb3JzLnB1c2goXCJnaXQubWFpbl9icmFuY2ggbXVzdCBiZSBhIHZhbGlkIGJyYW5jaCBuYW1lIChhbHBoYW51bWVyaWMsIF8sIC0sIC8sIC4pXCIpO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAoZy5pc29sYXRpb24gIT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uc3QgdmFsaWRJc29sYXRpb24gPSBuZXcgU2V0KFtcIndvcmt0cmVlXCIsIFwiYnJhbmNoXCIsIFwibm9uZVwiXSk7XG4gICAgICBpZiAodHlwZW9mIGcuaXNvbGF0aW9uID09PSBcInN0cmluZ1wiICYmIHZhbGlkSXNvbGF0aW9uLmhhcyhnLmlzb2xhdGlvbikpIHtcbiAgICAgICAgZ2l0Lmlzb2xhdGlvbiA9IGcuaXNvbGF0aW9uIGFzIFwid29ya3RyZWVcIiB8IFwiYnJhbmNoXCIgfCBcIm5vbmVcIjtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGVycm9ycy5wdXNoKFwiZ2l0Lmlzb2xhdGlvbiBtdXN0IGJlIG9uZSBvZjogd29ya3RyZWUsIGJyYW5jaCwgbm9uZVwiKTtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKGcuY29tbWl0X2RvY3MgIT09IHVuZGVmaW5lZCkge1xuICAgICAgd2FybmluZ3MucHVzaChcImdpdC5jb21taXRfZG9jcyBpcyBkZXByZWNhdGVkIFx1MjAxNCAuZ3NkLyBpcyBtYW5hZ2VkIGV4dGVybmFsbHkgYW5kIGFsd2F5cyBnaXRpZ25vcmVkLiBSZW1vdmUgdGhpcyBzZXR0aW5nLlwiKTtcbiAgICB9XG4gICAgaWYgKGcubWFuYWdlX2dpdGlnbm9yZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBpZiAodHlwZW9mIGcubWFuYWdlX2dpdGlnbm9yZSA9PT0gXCJib29sZWFuXCIpIGdpdC5tYW5hZ2VfZ2l0aWdub3JlID0gZy5tYW5hZ2VfZ2l0aWdub3JlO1xuICAgICAgZWxzZSBlcnJvcnMucHVzaChcImdpdC5tYW5hZ2VfZ2l0aWdub3JlIG11c3QgYmUgYSBib29sZWFuXCIpO1xuICAgIH1cbiAgICBpZiAoZy53b3JrdHJlZV9wb3N0X2NyZWF0ZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBpZiAodHlwZW9mIGcud29ya3RyZWVfcG9zdF9jcmVhdGUgPT09IFwic3RyaW5nXCIgJiYgZy53b3JrdHJlZV9wb3N0X2NyZWF0ZS50cmltKCkpIHtcbiAgICAgICAgZ2l0Lndvcmt0cmVlX3Bvc3RfY3JlYXRlID0gZy53b3JrdHJlZV9wb3N0X2NyZWF0ZS50cmltKCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBlcnJvcnMucHVzaChcImdpdC53b3JrdHJlZV9wb3N0X2NyZWF0ZSBtdXN0IGJlIGEgbm9uLWVtcHR5IHN0cmluZyAocGF0aCB0byBzY3JpcHQpXCIpO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAoZy5hdXRvX3ByICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGlmICh0eXBlb2YgZy5hdXRvX3ByID09PSBcImJvb2xlYW5cIikgZ2l0LmF1dG9fcHIgPSBnLmF1dG9fcHI7XG4gICAgICBlbHNlIGVycm9ycy5wdXNoKFwiZ2l0LmF1dG9fcHIgbXVzdCBiZSBhIGJvb2xlYW5cIik7XG4gICAgfVxuICAgIGlmIChnLnByX3RhcmdldF9icmFuY2ggIT09IHVuZGVmaW5lZCkge1xuICAgICAgaWYgKHR5cGVvZiBnLnByX3RhcmdldF9icmFuY2ggPT09IFwic3RyaW5nXCIgJiYgZy5wcl90YXJnZXRfYnJhbmNoLnRyaW0oKSkge1xuICAgICAgICBnaXQucHJfdGFyZ2V0X2JyYW5jaCA9IGcucHJfdGFyZ2V0X2JyYW5jaC50cmltKCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBlcnJvcnMucHVzaChcImdpdC5wcl90YXJnZXRfYnJhbmNoIG11c3QgYmUgYSBub24tZW1wdHkgc3RyaW5nIChicmFuY2ggbmFtZSlcIik7XG4gICAgICB9XG4gICAgfVxuICAgIC8vIERlcHJlY2F0ZWQ6IG1lcmdlX3RvX21haW4gaXMgaWdub3JlZCAoYnJhbmNobGVzcyBhcmNoaXRlY3R1cmUpLlxuICAgIGlmIChnLm1lcmdlX3RvX21haW4gIT09IHVuZGVmaW5lZCkge1xuICAgICAgd2FybmluZ3MucHVzaChcImdpdC5tZXJnZV90b19tYWluIGlzIGRlcHJlY2F0ZWQgXHUyMDE0IG1pbGVzdG9uZS1sZXZlbCBtZXJnZSBpcyBub3cgYWx3YXlzIHVzZWQuIFJlbW92ZSB0aGlzIHNldHRpbmcuXCIpO1xuICAgIH1cbiAgICAvLyAjNDc2NSBcdTIwMTQgY29sbGFwc2UgY2FkZW5jZSArIG1pbGVzdG9uZSByZXNxdWFzaFxuICAgIGlmIChnLmNvbGxhcHNlX2NhZGVuY2UgIT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uc3QgdmFsaWRDYWRlbmNlID0gbmV3IFNldChbXCJtaWxlc3RvbmVcIiwgXCJzbGljZVwiXSk7XG4gICAgICBpZiAodHlwZW9mIGcuY29sbGFwc2VfY2FkZW5jZSA9PT0gXCJzdHJpbmdcIiAmJiB2YWxpZENhZGVuY2UuaGFzKGcuY29sbGFwc2VfY2FkZW5jZSkpIHtcbiAgICAgICAgZ2l0LmNvbGxhcHNlX2NhZGVuY2UgPSBnLmNvbGxhcHNlX2NhZGVuY2UgYXMgXCJtaWxlc3RvbmVcIiB8IFwic2xpY2VcIjtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGVycm9ycy5wdXNoKFwiZ2l0LmNvbGxhcHNlX2NhZGVuY2UgbXVzdCBiZSBvbmUgb2Y6IG1pbGVzdG9uZSwgc2xpY2VcIik7XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChnLm1pbGVzdG9uZV9yZXNxdWFzaCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBpZiAodHlwZW9mIGcubWlsZXN0b25lX3Jlc3F1YXNoID09PSBcImJvb2xlYW5cIikge1xuICAgICAgICBnaXQubWlsZXN0b25lX3Jlc3F1YXNoID0gZy5taWxlc3RvbmVfcmVzcXVhc2g7XG4gICAgICAgIGNvbnN0IGNhZGVuY2UgPSAoZ2l0LmNvbGxhcHNlX2NhZGVuY2UgYXMgc3RyaW5nIHwgdW5kZWZpbmVkKVxuICAgICAgICAgID8/ICh0eXBlb2YgZy5jb2xsYXBzZV9jYWRlbmNlID09PSBcInN0cmluZ1wiID8gZy5jb2xsYXBzZV9jYWRlbmNlIDogdW5kZWZpbmVkKTtcbiAgICAgICAgaWYgKGNhZGVuY2UgIT09IFwic2xpY2VcIikge1xuICAgICAgICAgIHdhcm5pbmdzLnB1c2goJ2dpdC5taWxlc3RvbmVfcmVzcXVhc2ggaXMgaWdub3JlZCB1bmxlc3MgZ2l0LmNvbGxhcHNlX2NhZGVuY2UgaXMgXCJzbGljZVwiJyk7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGVycm9ycy5wdXNoKFwiZ2l0Lm1pbGVzdG9uZV9yZXNxdWFzaCBtdXN0IGJlIGEgYm9vbGVhblwiKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoT2JqZWN0LmtleXMoZ2l0KS5sZW5ndGggPiAwKSB7XG4gICAgICB2YWxpZGF0ZWQuZ2l0ID0gZ2l0IGFzIEdpdFByZWZlcmVuY2VzO1xuICAgIH1cbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBBdXRvIFZpc3VhbGl6ZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgaWYgKHByZWZlcmVuY2VzLmF1dG9fdmlzdWFsaXplICE9PSB1bmRlZmluZWQpIHtcbiAgICBpZiAodHlwZW9mIHByZWZlcmVuY2VzLmF1dG9fdmlzdWFsaXplID09PSBcImJvb2xlYW5cIikge1xuICAgICAgdmFsaWRhdGVkLmF1dG9fdmlzdWFsaXplID0gcHJlZmVyZW5jZXMuYXV0b192aXN1YWxpemU7XG4gICAgfSBlbHNlIHtcbiAgICAgIGVycm9ycy5wdXNoKFwiYXV0b192aXN1YWxpemUgbXVzdCBiZSBhIGJvb2xlYW5cIik7XG4gICAgfVxuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEF1dG8gUmVwb3J0IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBpZiAocHJlZmVyZW5jZXMuYXV0b19yZXBvcnQgIT09IHVuZGVmaW5lZCkge1xuICAgIGlmICh0eXBlb2YgcHJlZmVyZW5jZXMuYXV0b19yZXBvcnQgPT09IFwiYm9vbGVhblwiKSB7XG4gICAgICB2YWxpZGF0ZWQuYXV0b19yZXBvcnQgPSBwcmVmZXJlbmNlcy5hdXRvX3JlcG9ydDtcbiAgICB9IGVsc2Uge1xuICAgICAgZXJyb3JzLnB1c2goXCJhdXRvX3JlcG9ydCBtdXN0IGJlIGEgYm9vbGVhblwiKTtcbiAgICB9XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgQ29udGV4dCBTZWxlY3Rpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGlmIChwcmVmZXJlbmNlcy5jb250ZXh0X3NlbGVjdGlvbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgY29uc3QgdmFsaWRNb2RlcyA9IG5ldyBTZXQoW1wiZnVsbFwiLCBcInNtYXJ0XCJdKTtcbiAgICBpZiAodHlwZW9mIHByZWZlcmVuY2VzLmNvbnRleHRfc2VsZWN0aW9uID09PSBcInN0cmluZ1wiICYmIHZhbGlkTW9kZXMuaGFzKHByZWZlcmVuY2VzLmNvbnRleHRfc2VsZWN0aW9uKSkge1xuICAgICAgdmFsaWRhdGVkLmNvbnRleHRfc2VsZWN0aW9uID0gcHJlZmVyZW5jZXMuY29udGV4dF9zZWxlY3Rpb24gYXMgR1NEUHJlZmVyZW5jZXNbXCJjb250ZXh0X3NlbGVjdGlvblwiXTtcbiAgICB9IGVsc2Uge1xuICAgICAgZXJyb3JzLnB1c2goYGNvbnRleHRfc2VsZWN0aW9uIG11c3QgYmUgb25lIG9mOiBmdWxsLCBzbWFydGApO1xuICAgIH1cbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBHaXRIdWIgU3luYyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgaWYgKHByZWZlcmVuY2VzLmdpdGh1YiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgaWYgKHR5cGVvZiBwcmVmZXJlbmNlcy5naXRodWIgPT09IFwib2JqZWN0XCIgJiYgcHJlZmVyZW5jZXMuZ2l0aHViICE9PSBudWxsKSB7XG4gICAgICBjb25zdCBnaCA9IHByZWZlcmVuY2VzLmdpdGh1YiBhcyB1bmtub3duIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgY29uc3QgdmFsaWRHaDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcblxuICAgICAgaWYgKGdoLmVuYWJsZWQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICBpZiAodHlwZW9mIGdoLmVuYWJsZWQgPT09IFwiYm9vbGVhblwiKSB2YWxpZEdoLmVuYWJsZWQgPSBnaC5lbmFibGVkO1xuICAgICAgICBlbHNlIGVycm9ycy5wdXNoKFwiZ2l0aHViLmVuYWJsZWQgbXVzdCBiZSBhIGJvb2xlYW5cIik7XG4gICAgICB9XG4gICAgICBpZiAoZ2gucmVwbyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGlmICh0eXBlb2YgZ2gucmVwbyA9PT0gXCJzdHJpbmdcIiAmJiBnaC5yZXBvLmluY2x1ZGVzKFwiL1wiKSkgdmFsaWRHaC5yZXBvID0gZ2gucmVwbztcbiAgICAgICAgZWxzZSBlcnJvcnMucHVzaCgnZ2l0aHViLnJlcG8gbXVzdCBiZSBhIHN0cmluZyBpbiBcIm93bmVyL3JlcG9cIiBmb3JtYXQnKTtcbiAgICAgIH1cbiAgICAgIGlmIChnaC5wcm9qZWN0ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgY29uc3QgcCA9IHR5cGVvZiBnaC5wcm9qZWN0ID09PSBcIm51bWJlclwiID8gZ2gucHJvamVjdCA6IE51bWJlcihnaC5wcm9qZWN0KTtcbiAgICAgICAgaWYgKE51bWJlci5pc0Zpbml0ZShwKSAmJiBwID4gMCkgdmFsaWRHaC5wcm9qZWN0ID0gTWF0aC5mbG9vcihwKTtcbiAgICAgICAgZWxzZSBlcnJvcnMucHVzaChcImdpdGh1Yi5wcm9qZWN0IG11c3QgYmUgYSBwb3NpdGl2ZSBudW1iZXJcIik7XG4gICAgICB9XG4gICAgICBpZiAoZ2gubGFiZWxzICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZ2gubGFiZWxzKSAmJiBnaC5sYWJlbHMuZXZlcnkoKGw6IHVua25vd24pID0+IHR5cGVvZiBsID09PSBcInN0cmluZ1wiKSkge1xuICAgICAgICAgIHZhbGlkR2gubGFiZWxzID0gZ2gubGFiZWxzO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGVycm9ycy5wdXNoKFwiZ2l0aHViLmxhYmVscyBtdXN0IGJlIGFuIGFycmF5IG9mIHN0cmluZ3NcIik7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChnaC5hdXRvX2xpbmtfY29tbWl0cyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGlmICh0eXBlb2YgZ2guYXV0b19saW5rX2NvbW1pdHMgPT09IFwiYm9vbGVhblwiKSB2YWxpZEdoLmF1dG9fbGlua19jb21taXRzID0gZ2guYXV0b19saW5rX2NvbW1pdHM7XG4gICAgICAgIGVsc2UgZXJyb3JzLnB1c2goXCJnaXRodWIuYXV0b19saW5rX2NvbW1pdHMgbXVzdCBiZSBhIGJvb2xlYW5cIik7XG4gICAgICB9XG4gICAgICBpZiAoZ2guc2xpY2VfcHJzICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgaWYgKHR5cGVvZiBnaC5zbGljZV9wcnMgPT09IFwiYm9vbGVhblwiKSB2YWxpZEdoLnNsaWNlX3BycyA9IGdoLnNsaWNlX3BycztcbiAgICAgICAgZWxzZSBlcnJvcnMucHVzaChcImdpdGh1Yi5zbGljZV9wcnMgbXVzdCBiZSBhIGJvb2xlYW5cIik7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGtub3duR2hLZXlzID0gbmV3IFNldChbXCJlbmFibGVkXCIsIFwicmVwb1wiLCBcInByb2plY3RcIiwgXCJsYWJlbHNcIiwgXCJhdXRvX2xpbmtfY29tbWl0c1wiLCBcInNsaWNlX3Byc1wiXSk7XG4gICAgICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhnaCkpIHtcbiAgICAgICAgaWYgKCFrbm93bkdoS2V5cy5oYXMoa2V5KSkge1xuICAgICAgICAgIHdhcm5pbmdzLnB1c2goYHVua25vd24gZ2l0aHViIGtleSBcIiR7a2V5fVwiIFx1MjAxNCBpZ25vcmVkYCk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgaWYgKE9iamVjdC5rZXlzKHZhbGlkR2gpLmxlbmd0aCA+IDApIHtcbiAgICAgICAgdmFsaWRhdGVkLmdpdGh1YiA9IHZhbGlkR2ggYXMgdW5rbm93biBhcyBpbXBvcnQoXCIuLi9naXRodWItc3luYy90eXBlcy5qc1wiKS5HaXRIdWJTeW5jQ29uZmlnO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBlcnJvcnMucHVzaChcImdpdGh1YiBtdXN0IGJlIGFuIG9iamVjdFwiKTtcbiAgICB9XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgU2hvdyBUb2tlbiBDb3N0IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBpZiAocHJlZmVyZW5jZXMuc2hvd190b2tlbl9jb3N0ICE9PSB1bmRlZmluZWQpIHtcbiAgICBpZiAodHlwZW9mIHByZWZlcmVuY2VzLnNob3dfdG9rZW5fY29zdCA9PT0gXCJib29sZWFuXCIpIHtcbiAgICAgIHZhbGlkYXRlZC5zaG93X3Rva2VuX2Nvc3QgPSBwcmVmZXJlbmNlcy5zaG93X3Rva2VuX2Nvc3Q7XG4gICAgfSBlbHNlIHtcbiAgICAgIGVycm9ycy5wdXNoKFwic2hvd190b2tlbl9jb3N0IG11c3QgYmUgYSBib29sZWFuXCIpO1xuICAgIH1cbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBBdXRvLU1vZGUgUmVxdWVzdCBJbnRlcnZhbCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgaWYgKHByZWZlcmVuY2VzLm1pbl9yZXF1ZXN0X2ludGVydmFsX21zICE9PSB1bmRlZmluZWQpIHtcbiAgICBpZiAoXG4gICAgICB0eXBlb2YgcHJlZmVyZW5jZXMubWluX3JlcXVlc3RfaW50ZXJ2YWxfbXMgPT09IFwibnVtYmVyXCIgJiZcbiAgICAgIE51bWJlci5pc0Zpbml0ZShwcmVmZXJlbmNlcy5taW5fcmVxdWVzdF9pbnRlcnZhbF9tcykgJiZcbiAgICAgIHByZWZlcmVuY2VzLm1pbl9yZXF1ZXN0X2ludGVydmFsX21zID49IDAgJiZcbiAgICAgIHByZWZlcmVuY2VzLm1pbl9yZXF1ZXN0X2ludGVydmFsX21zIDw9IDJfMTQ3XzQ4M182NDdcbiAgICApIHtcbiAgICAgIHZhbGlkYXRlZC5taW5fcmVxdWVzdF9pbnRlcnZhbF9tcyA9IE1hdGguZmxvb3IocHJlZmVyZW5jZXMubWluX3JlcXVlc3RfaW50ZXJ2YWxfbXMpO1xuICAgIH0gZWxzZSB7XG4gICAgICBlcnJvcnMucHVzaChcIm1pbl9yZXF1ZXN0X2ludGVydmFsX21zIG11c3QgYmUgYSBub24tbmVnYXRpdmUgbnVtYmVyIDw9IDIxNDc0ODM2NDdcIik7XG4gICAgfVxuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEV4cGVyaW1lbnRhbCBGZWF0dXJlcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgaWYgKHByZWZlcmVuY2VzLmV4cGVyaW1lbnRhbCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgaWYgKHR5cGVvZiBwcmVmZXJlbmNlcy5leHBlcmltZW50YWwgPT09IFwib2JqZWN0XCIgJiYgcHJlZmVyZW5jZXMuZXhwZXJpbWVudGFsICE9PSBudWxsKSB7XG4gICAgICBjb25zdCBleHAgPSBwcmVmZXJlbmNlcy5leHBlcmltZW50YWwgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgIGNvbnN0IHZhbGlkRXhwOiBpbXBvcnQoXCIuL3ByZWZlcmVuY2VzLXR5cGVzLmpzXCIpLkV4cGVyaW1lbnRhbFByZWZlcmVuY2VzID0ge307XG5cbiAgICAgIGlmIChleHAucnRrICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgaWYgKHR5cGVvZiBleHAucnRrID09PSBcImJvb2xlYW5cIikgdmFsaWRFeHAucnRrID0gZXhwLnJ0aztcbiAgICAgICAgZWxzZSBlcnJvcnMucHVzaChcImV4cGVyaW1lbnRhbC5ydGsgbXVzdCBiZSBhIGJvb2xlYW5cIik7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGtub3duRXhwS2V5cyA9IG5ldyBTZXQoW1wicnRrXCJdKTtcbiAgICAgIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKGV4cCkpIHtcbiAgICAgICAgaWYgKCFrbm93bkV4cEtleXMuaGFzKGtleSkpIHtcbiAgICAgICAgICB3YXJuaW5ncy5wdXNoKGB1bmtub3duIGV4cGVyaW1lbnRhbCBrZXkgXCIke2tleX1cIiBcdTIwMTQgaWdub3JlZGApO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGlmIChPYmplY3Qua2V5cyh2YWxpZEV4cCkubGVuZ3RoID4gMCkge1xuICAgICAgICB2YWxpZGF0ZWQuZXhwZXJpbWVudGFsID0gdmFsaWRFeHA7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIGVycm9ycy5wdXNoKFwiZXhwZXJpbWVudGFsIG11c3QgYmUgYW4gb2JqZWN0XCIpO1xuICAgIH1cbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBDb2RlYmFzZSBNYXAgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGlmIChwcmVmZXJlbmNlcy5jb2RlYmFzZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgaWYgKHR5cGVvZiBwcmVmZXJlbmNlcy5jb2RlYmFzZSA9PT0gXCJvYmplY3RcIiAmJiBwcmVmZXJlbmNlcy5jb2RlYmFzZSAhPT0gbnVsbCkge1xuICAgICAgY29uc3QgY2IgPSBwcmVmZXJlbmNlcy5jb2RlYmFzZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgIGNvbnN0IHZhbGlkQ2I6IGltcG9ydChcIi4vcHJlZmVyZW5jZXMtdHlwZXMuanNcIikuQ29kZWJhc2VNYXBQcmVmZXJlbmNlcyA9IHt9O1xuXG4gICAgICBpZiAoY2IuZXhjbHVkZV9wYXR0ZXJucyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGNiLmV4Y2x1ZGVfcGF0dGVybnMpICYmIGNiLmV4Y2x1ZGVfcGF0dGVybnMuZXZlcnkoKHA6IHVua25vd24pID0+IHR5cGVvZiBwID09PSBcInN0cmluZ1wiKSkge1xuICAgICAgICAgIHZhbGlkQ2IuZXhjbHVkZV9wYXR0ZXJucyA9IGNiLmV4Y2x1ZGVfcGF0dGVybnMgYXMgc3RyaW5nW107XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgZXJyb3JzLnB1c2goXCJjb2RlYmFzZS5leGNsdWRlX3BhdHRlcm5zIG11c3QgYmUgYW4gYXJyYXkgb2Ygc3RyaW5nc1wiKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKGNiLm1heF9maWxlcyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGNvbnN0IG1mID0gdHlwZW9mIGNiLm1heF9maWxlcyA9PT0gXCJudW1iZXJcIiA/IGNiLm1heF9maWxlcyA6IE51bWJlcihjYi5tYXhfZmlsZXMpO1xuICAgICAgICBpZiAoTnVtYmVyLmlzRmluaXRlKG1mKSAmJiBtZiA+PSAxKSB7XG4gICAgICAgICAgdmFsaWRDYi5tYXhfZmlsZXMgPSBNYXRoLmZsb29yKG1mKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBlcnJvcnMucHVzaChcImNvZGViYXNlLm1heF9maWxlcyBtdXN0IGJlIGEgcG9zaXRpdmUgaW50ZWdlclwiKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKGNiLmNvbGxhcHNlX3RocmVzaG9sZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGNvbnN0IGN0ID0gdHlwZW9mIGNiLmNvbGxhcHNlX3RocmVzaG9sZCA9PT0gXCJudW1iZXJcIiA/IGNiLmNvbGxhcHNlX3RocmVzaG9sZCA6IE51bWJlcihjYi5jb2xsYXBzZV90aHJlc2hvbGQpO1xuICAgICAgICBpZiAoTnVtYmVyLmlzRmluaXRlKGN0KSAmJiBjdCA+PSAxKSB7XG4gICAgICAgICAgdmFsaWRDYi5jb2xsYXBzZV90aHJlc2hvbGQgPSBNYXRoLmZsb29yKGN0KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBlcnJvcnMucHVzaChcImNvZGViYXNlLmNvbGxhcHNlX3RocmVzaG9sZCBtdXN0IGJlIGEgcG9zaXRpdmUgaW50ZWdlclwiKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBjb25zdCBrbm93bkNiS2V5cyA9IG5ldyBTZXQoW1wiZXhjbHVkZV9wYXR0ZXJuc1wiLCBcIm1heF9maWxlc1wiLCBcImNvbGxhcHNlX3RocmVzaG9sZFwiXSk7XG4gICAgICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhjYikpIHtcbiAgICAgICAgaWYgKCFrbm93bkNiS2V5cy5oYXMoa2V5KSkge1xuICAgICAgICAgIHdhcm5pbmdzLnB1c2goYHVua25vd24gY29kZWJhc2Uga2V5IFwiJHtrZXl9XCIgXHUyMDE0IGlnbm9yZWRgKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBpZiAoT2JqZWN0LmtleXModmFsaWRDYikubGVuZ3RoID4gMCkge1xuICAgICAgICB2YWxpZGF0ZWQuY29kZWJhc2UgPSB2YWxpZENiO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBlcnJvcnMucHVzaChcImNvZGViYXNlIG11c3QgYmUgYW4gb2JqZWN0XCIpO1xuICAgIH1cbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBDbGF1ZGUgQ29kZSBNQ1AgUGVyLU1vZGVsIENvbmZpZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgaWYgKHByZWZlcmVuY2VzLmNsYXVkZV9jb2RlX21jcCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgaWYgKHR5cGVvZiBwcmVmZXJlbmNlcy5jbGF1ZGVfY29kZV9tY3AgPT09IFwib2JqZWN0XCIgJiYgcHJlZmVyZW5jZXMuY2xhdWRlX2NvZGVfbWNwICE9PSBudWxsKSB7XG4gICAgICBjb25zdCByYXcgPSBwcmVmZXJlbmNlcy5jbGF1ZGVfY29kZV9tY3AgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgIGlmICh0eXBlb2YgcmF3LnBlcl9tb2RlbCAhPT0gXCJvYmplY3RcIiB8fCByYXcucGVyX21vZGVsID09PSBudWxsIHx8IEFycmF5LmlzQXJyYXkocmF3LnBlcl9tb2RlbCkpIHtcbiAgICAgICAgd2FybmluZ3MucHVzaChcImNsYXVkZV9jb2RlX21jcC5wZXJfbW9kZWwgbXVzdCBiZSBhbiBvYmplY3QgXHUyMDE0IGlnbm9yaW5nIGNsYXVkZV9jb2RlX21jcFwiKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbnN0IHBlck1vZGVsID0gcmF3LnBlcl9tb2RlbCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgICAgY29uc3QgdmFsaWRQZXJNb2RlbDogUmVjb3JkPHN0cmluZywgeyBhbGxvd2VkX3NlcnZlcnM/OiBzdHJpbmdbXTsgYmxvY2tlZF9zZXJ2ZXJzPzogc3RyaW5nW10gfT4gPSB7fTtcbiAgICAgICAgZm9yIChjb25zdCBbcHJlZml4LCBlbnRyeV0gb2YgT2JqZWN0LmVudHJpZXMocGVyTW9kZWwpKSB7XG4gICAgICAgICAgaWYgKHR5cGVvZiBlbnRyeSAhPT0gXCJvYmplY3RcIiB8fCBlbnRyeSA9PT0gbnVsbCB8fCBBcnJheS5pc0FycmF5KGVudHJ5KSkge1xuICAgICAgICAgICAgd2FybmluZ3MucHVzaChgY2xhdWRlX2NvZGVfbWNwLnBlcl9tb2RlbFtcIiR7cHJlZml4fVwiXSBtdXN0IGJlIGFuIG9iamVjdCBcdTIwMTQgaWdub3JpbmcgZW50cnlgKTtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgIH1cbiAgICAgICAgICBjb25zdCBlID0gZW50cnkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICAgICAgY29uc3QgdmFsaWRFbnRyeTogeyBhbGxvd2VkX3NlcnZlcnM/OiBzdHJpbmdbXTsgYmxvY2tlZF9zZXJ2ZXJzPzogc3RyaW5nW10gfSA9IHt9O1xuICAgICAgICAgIGZvciAoY29uc3QgZmllbGQgb2YgW1wiYWxsb3dlZF9zZXJ2ZXJzXCIsIFwiYmxvY2tlZF9zZXJ2ZXJzXCJdIGFzIGNvbnN0KSB7XG4gICAgICAgICAgICBpZiAoZVtmaWVsZF0gIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShlW2ZpZWxkXSkgJiYgKGVbZmllbGRdIGFzIHVua25vd25bXSkuZXZlcnkoKHMpID0+IHR5cGVvZiBzID09PSBcInN0cmluZ1wiKSkge1xuICAgICAgICAgICAgICAgIHZhbGlkRW50cnlbZmllbGRdID0gZVtmaWVsZF0gYXMgc3RyaW5nW107XG4gICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgd2FybmluZ3MucHVzaChgY2xhdWRlX2NvZGVfbWNwLnBlcl9tb2RlbFtcIiR7cHJlZml4fVwiXS4ke2ZpZWxkfSBtdXN0IGJlIGFuIGFycmF5IG9mIHN0cmluZ3MgXHUyMDE0IGlnbm9yaW5nIGZpZWxkYCk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgICAgdmFsaWRQZXJNb2RlbFtwcmVmaXhdID0gdmFsaWRFbnRyeTtcbiAgICAgICAgfVxuICAgICAgICB2YWxpZGF0ZWQuY2xhdWRlX2NvZGVfbWNwID0geyBwZXJfbW9kZWw6IHZhbGlkUGVyTW9kZWwgfTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgd2FybmluZ3MucHVzaChcImNsYXVkZV9jb2RlX21jcCBtdXN0IGJlIGFuIG9iamVjdCBcdTIwMTQgaWdub3JpbmdcIik7XG4gICAgfVxuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEVuaGFuY2VkIFZlcmlmaWNhdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgaWYgKHByZWZlcmVuY2VzLmVuaGFuY2VkX3ZlcmlmaWNhdGlvbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgaWYgKHR5cGVvZiBwcmVmZXJlbmNlcy5lbmhhbmNlZF92ZXJpZmljYXRpb24gPT09IFwiYm9vbGVhblwiKSB7XG4gICAgICB2YWxpZGF0ZWQuZW5oYW5jZWRfdmVyaWZpY2F0aW9uID0gcHJlZmVyZW5jZXMuZW5oYW5jZWRfdmVyaWZpY2F0aW9uO1xuICAgIH0gZWxzZSB7XG4gICAgICBlcnJvcnMucHVzaChcImVuaGFuY2VkX3ZlcmlmaWNhdGlvbiBtdXN0IGJlIGEgYm9vbGVhblwiKTtcbiAgICB9XG4gIH1cblxuICBpZiAocHJlZmVyZW5jZXMuZW5oYW5jZWRfdmVyaWZpY2F0aW9uX3ByZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgaWYgKHR5cGVvZiBwcmVmZXJlbmNlcy5lbmhhbmNlZF92ZXJpZmljYXRpb25fcHJlID09PSBcImJvb2xlYW5cIikge1xuICAgICAgdmFsaWRhdGVkLmVuaGFuY2VkX3ZlcmlmaWNhdGlvbl9wcmUgPSBwcmVmZXJlbmNlcy5lbmhhbmNlZF92ZXJpZmljYXRpb25fcHJlO1xuICAgIH0gZWxzZSB7XG4gICAgICBlcnJvcnMucHVzaChcImVuaGFuY2VkX3ZlcmlmaWNhdGlvbl9wcmUgbXVzdCBiZSBhIGJvb2xlYW5cIik7XG4gICAgfVxuICB9XG5cbiAgaWYgKHByZWZlcmVuY2VzLmVuaGFuY2VkX3ZlcmlmaWNhdGlvbl9wb3N0ICE9PSB1bmRlZmluZWQpIHtcbiAgICBpZiAodHlwZW9mIHByZWZlcmVuY2VzLmVuaGFuY2VkX3ZlcmlmaWNhdGlvbl9wb3N0ID09PSBcImJvb2xlYW5cIikge1xuICAgICAgdmFsaWRhdGVkLmVuaGFuY2VkX3ZlcmlmaWNhdGlvbl9wb3N0ID0gcHJlZmVyZW5jZXMuZW5oYW5jZWRfdmVyaWZpY2F0aW9uX3Bvc3Q7XG4gICAgfSBlbHNlIHtcbiAgICAgIGVycm9ycy5wdXNoKFwiZW5oYW5jZWRfdmVyaWZpY2F0aW9uX3Bvc3QgbXVzdCBiZSBhIGJvb2xlYW5cIik7XG4gICAgfVxuICB9XG5cbiAgaWYgKHByZWZlcmVuY2VzLmVuaGFuY2VkX3ZlcmlmaWNhdGlvbl9zdHJpY3QgIT09IHVuZGVmaW5lZCkge1xuICAgIGlmICh0eXBlb2YgcHJlZmVyZW5jZXMuZW5oYW5jZWRfdmVyaWZpY2F0aW9uX3N0cmljdCA9PT0gXCJib29sZWFuXCIpIHtcbiAgICAgIHZhbGlkYXRlZC5lbmhhbmNlZF92ZXJpZmljYXRpb25fc3RyaWN0ID0gcHJlZmVyZW5jZXMuZW5oYW5jZWRfdmVyaWZpY2F0aW9uX3N0cmljdDtcbiAgICB9IGVsc2Uge1xuICAgICAgZXJyb3JzLnB1c2goXCJlbmhhbmNlZF92ZXJpZmljYXRpb25fc3RyaWN0IG11c3QgYmUgYSBib29sZWFuXCIpO1xuICAgIH1cbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBEaXNjdXNzIFByZXBhcmF0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBpZiAocHJlZmVyZW5jZXMuZGlzY3Vzc19wcmVwYXJhdGlvbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgaWYgKHR5cGVvZiBwcmVmZXJlbmNlcy5kaXNjdXNzX3ByZXBhcmF0aW9uID09PSBcImJvb2xlYW5cIikge1xuICAgICAgdmFsaWRhdGVkLmRpc2N1c3NfcHJlcGFyYXRpb24gPSBwcmVmZXJlbmNlcy5kaXNjdXNzX3ByZXBhcmF0aW9uO1xuICAgIH0gZWxzZSB7XG4gICAgICBlcnJvcnMucHVzaChcImRpc2N1c3NfcHJlcGFyYXRpb24gbXVzdCBiZSBhIGJvb2xlYW5cIik7XG4gICAgfVxuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIERpc2N1c3MgV2ViIFJlc2VhcmNoIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBpZiAocHJlZmVyZW5jZXMuZGlzY3Vzc193ZWJfcmVzZWFyY2ggIT09IHVuZGVmaW5lZCkge1xuICAgIGlmICh0eXBlb2YgcHJlZmVyZW5jZXMuZGlzY3Vzc193ZWJfcmVzZWFyY2ggPT09IFwiYm9vbGVhblwiKSB7XG4gICAgICB2YWxpZGF0ZWQuZGlzY3Vzc193ZWJfcmVzZWFyY2ggPSBwcmVmZXJlbmNlcy5kaXNjdXNzX3dlYl9yZXNlYXJjaDtcbiAgICB9IGVsc2Uge1xuICAgICAgZXJyb3JzLnB1c2goXCJkaXNjdXNzX3dlYl9yZXNlYXJjaCBtdXN0IGJlIGEgYm9vbGVhblwiKTtcbiAgICB9XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgRGlzY3VzcyBEZXB0aCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgaWYgKHByZWZlcmVuY2VzLmRpc2N1c3NfZGVwdGggIT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IHZhbGlkRGVwdGhzID0gbmV3IFNldChbXCJxdWlja1wiLCBcInN0YW5kYXJkXCIsIFwidGhvcm91Z2hcIl0pO1xuICAgIGlmICh0eXBlb2YgcHJlZmVyZW5jZXMuZGlzY3Vzc19kZXB0aCA9PT0gXCJzdHJpbmdcIiAmJiB2YWxpZERlcHRocy5oYXMocHJlZmVyZW5jZXMuZGlzY3Vzc19kZXB0aCkpIHtcbiAgICAgIHZhbGlkYXRlZC5kaXNjdXNzX2RlcHRoID0gcHJlZmVyZW5jZXMuZGlzY3Vzc19kZXB0aCBhcyBHU0RQcmVmZXJlbmNlc1tcImRpc2N1c3NfZGVwdGhcIl07XG4gICAgfSBlbHNlIHtcbiAgICAgIGVycm9ycy5wdXNoKGBkaXNjdXNzX2RlcHRoIG11c3QgYmUgb25lIG9mOiBxdWljaywgc3RhbmRhcmQsIHRob3JvdWdoYCk7XG4gICAgfVxuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIExhbmd1YWdlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBpZiAocHJlZmVyZW5jZXMubGFuZ3VhZ2UgIT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IHRyaW1tZWQgPSB0eXBlb2YgcHJlZmVyZW5jZXMubGFuZ3VhZ2UgPT09IFwic3RyaW5nXCIgPyBwcmVmZXJlbmNlcy5sYW5ndWFnZS50cmltKCkgOiB1bmRlZmluZWQ7XG4gICAgaWYgKHRyaW1tZWQgJiYgdHJpbW1lZC5sZW5ndGggPD0gNTAgJiYgIS9bXFxyXFxuXS8udGVzdCh0cmltbWVkKSkge1xuICAgICAgdmFsaWRhdGVkLmxhbmd1YWdlID0gdHJpbW1lZDtcbiAgICB9IGVsc2Uge1xuICAgICAgZXJyb3JzLnB1c2goYGxhbmd1YWdlIG11c3QgYmUgYSBub24tZW1wdHkgc3RyaW5nIHVwIHRvIDUwIGNoYXJhY3RlcnMgd2l0aCBubyBuZXdsaW5lcyAoZS5nLiBcIkNoaW5lc2VcIiwgXCJkZVwiLCBcIlx1NjVFNVx1NjcyQ1x1OEE5RVwiKWApO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiB7IHByZWZlcmVuY2VzOiB2YWxpZGF0ZWQsIGVycm9ycywgd2FybmluZ3MgfTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQVdBLFNBQVMseUJBQXlCO0FBQ2xDLFNBQVMsNEJBQTRCO0FBRXJDO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUVBO0FBQUEsT0FJSztBQUVQLE1BQU0sdUJBQXVCLG9CQUFJLElBQWtCLENBQUMsVUFBVSxZQUFZLFdBQVcsVUFBVSxDQUFDO0FBQ2hHLE1BQU0seUJBQXlCLG9CQUFJLElBQTJDO0FBQUEsRUFDNUU7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUNGLENBQUM7QUFFTSxTQUFTLG9CQUFvQixhQUlsQztBQUNBLFFBQU0sU0FBbUIsQ0FBQztBQUMxQixRQUFNLFdBQXFCLENBQUM7QUFDNUIsUUFBTSxZQUE0QixDQUFDO0FBSW5DLFFBQU0sc0JBQThDO0FBQUEsSUFDbEQsZUFBZTtBQUFBLElBQ2YsZ0JBQWdCO0FBQUEsSUFDaEIsV0FBVztBQUFBLElBQ1gsa0JBQWtCO0FBQUEsSUFDbEIsV0FBVztBQUFBLElBQ1gsYUFBYTtBQUFBLEVBQ2Y7QUFFQSxhQUFX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
