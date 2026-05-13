import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.js";
import {
  COMPACTION_KEEP_RECENT_TOKENS,
  COMPACTION_RESERVE_TOKENS,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS
} from "./constants.js";
const GLOBAL_ONLY_KEYS = /* @__PURE__ */ new Set([
  "allowedCommandPrefixes",
  "fetchAllowedUrls"
]);
function stripGlobalOnlyKeys(settings) {
  const result = { ...settings };
  for (const key of GLOBAL_ONLY_KEYS) {
    delete result[key];
  }
  return result;
}
function deepMergeSettings(base, overrides) {
  const result = { ...base };
  for (const key of Object.keys(overrides)) {
    const overrideValue = overrides[key];
    const baseValue = base[key];
    if (overrideValue === void 0) {
      continue;
    }
    if (typeof overrideValue === "object" && overrideValue !== null && !Array.isArray(overrideValue) && typeof baseValue === "object" && baseValue !== null && !Array.isArray(baseValue)) {
      result[key] = { ...baseValue, ...overrideValue };
    } else {
      result[key] = overrideValue;
    }
  }
  return result;
}
class FileSettingsStorage {
  constructor(cwd = process.cwd(), agentDir = getAgentDir()) {
    this.globalSettingsPath = join(agentDir, "settings.json");
    this.projectSettingsPath = join(cwd, CONFIG_DIR_NAME, "settings.json");
  }
  acquireLockSyncWithRetry(path) {
    const maxAttempts = 10;
    const delayMs = 20;
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return lockfile.lockSync(path, { realpath: false });
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : void 0;
        if (code !== "ELOCKED" || attempt === maxAttempts) {
          throw error;
        }
        lastError = error;
        const start = Date.now();
        while (Date.now() - start < delayMs) {
        }
      }
    }
    throw lastError ?? new Error("Failed to acquire settings lock");
  }
  withLock(scope, fn) {
    const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
    const dir = dirname(path);
    let release;
    try {
      const fileExists = existsSync(path);
      if (fileExists) {
        release = this.acquireLockSyncWithRetry(path);
      }
      const current = fileExists ? readFileSync(path, "utf-8") : void 0;
      const next = fn(current);
      if (next !== void 0) {
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        if (!release) {
          release = this.acquireLockSyncWithRetry(path);
        }
        writeFileSync(path, next, "utf-8");
      }
    } finally {
      if (release) {
        release();
      }
    }
  }
}
class InMemorySettingsStorage {
  withLock(scope, fn) {
    const current = scope === "global" ? this.global : this.project;
    const next = fn(current);
    if (next !== void 0) {
      if (scope === "global") {
        this.global = next;
      } else {
        this.project = next;
      }
    }
  }
}
class SettingsManager {
  constructor(storage, initialGlobal, initialProject, globalLoadError = null, projectLoadError = null, initialErrors = []) {
    this.modifiedFields = /* @__PURE__ */ new Set();
    // Track global fields modified during session
    this.modifiedNestedFields = /* @__PURE__ */ new Map();
    // Track global nested field modifications
    this.modifiedProjectFields = /* @__PURE__ */ new Set();
    // Track project fields modified during session
    this.modifiedProjectNestedFields = /* @__PURE__ */ new Map();
    // Track project nested field modifications
    this.globalSettingsLoadError = null;
    // Track if global settings file had parse errors
    this.projectSettingsLoadError = null;
    // Track if project settings file had parse errors
    this.writeQueue = Promise.resolve();
    this.storage = storage;
    this.globalSettings = initialGlobal;
    this.projectSettings = stripGlobalOnlyKeys(initialProject);
    this.globalSettingsLoadError = globalLoadError;
    this.projectSettingsLoadError = projectLoadError;
    this.errors = [...initialErrors];
    this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
  }
  /** Create a SettingsManager that loads from files */
  static create(cwd = process.cwd(), agentDir = getAgentDir()) {
    const storage = new FileSettingsStorage(cwd, agentDir);
    return SettingsManager.fromStorage(storage);
  }
  /** Create a SettingsManager from an arbitrary storage backend */
  static fromStorage(storage) {
    const globalLoad = SettingsManager.tryLoadFromStorage(storage, "global");
    const projectLoad = SettingsManager.tryLoadFromStorage(storage, "project");
    const initialErrors = [];
    if (globalLoad.error) {
      initialErrors.push({ scope: "global", error: globalLoad.error });
    }
    if (projectLoad.error) {
      initialErrors.push({ scope: "project", error: projectLoad.error });
    }
    return new SettingsManager(
      storage,
      globalLoad.settings,
      projectLoad.settings,
      globalLoad.error,
      projectLoad.error,
      initialErrors
    );
  }
  /** Create an in-memory SettingsManager (no file I/O) */
  static inMemory(settings = {}) {
    const storage = new InMemorySettingsStorage();
    return new SettingsManager(storage, settings, {});
  }
  static loadFromStorage(storage, scope) {
    let content;
    storage.withLock(scope, (current) => {
      content = current;
      return void 0;
    });
    if (!content) {
      return {};
    }
    const settings = JSON.parse(content);
    return SettingsManager.migrateSettings(settings);
  }
  static tryLoadFromStorage(storage, scope) {
    try {
      return { settings: SettingsManager.loadFromStorage(storage, scope), error: null };
    } catch (error) {
      return { settings: {}, error };
    }
  }
  /** Migrate old settings format to new format */
  static migrateSettings(settings) {
    if ("queueMode" in settings && !("steeringMode" in settings)) {
      settings.steeringMode = settings.queueMode;
      delete settings.queueMode;
    }
    if (!("transport" in settings) && typeof settings.websockets === "boolean") {
      settings.transport = settings.websockets ? "websocket" : "sse";
      delete settings.websockets;
    }
    if ("skills" in settings && typeof settings.skills === "object" && settings.skills !== null && !Array.isArray(settings.skills)) {
      const skillsSettings = settings.skills;
      if (skillsSettings.enableSkillCommands !== void 0 && settings.enableSkillCommands === void 0) {
        settings.enableSkillCommands = skillsSettings.enableSkillCommands;
      }
      if (Array.isArray(skillsSettings.customDirectories) && skillsSettings.customDirectories.length > 0) {
        settings.skills = skillsSettings.customDirectories;
      } else {
        delete settings.skills;
      }
    }
    return settings;
  }
  getGlobalSettings() {
    return structuredClone(this.globalSettings);
  }
  getProjectSettings() {
    return structuredClone(this.projectSettings);
  }
  getBashInterceptorEnabled() {
    return this.settings.bashInterceptor?.enabled ?? true;
  }
  getBashInterceptorRules() {
    return this.settings.bashInterceptor?.rules;
  }
  reload() {
    const globalLoad = SettingsManager.tryLoadFromStorage(this.storage, "global");
    if (!globalLoad.error) {
      this.globalSettings = globalLoad.settings;
      this.globalSettingsLoadError = null;
    } else {
      this.globalSettingsLoadError = globalLoad.error;
      this.recordError("global", globalLoad.error);
    }
    this.modifiedFields.clear();
    this.modifiedNestedFields.clear();
    this.modifiedProjectFields.clear();
    this.modifiedProjectNestedFields.clear();
    const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project");
    if (!projectLoad.error) {
      this.projectSettings = stripGlobalOnlyKeys(projectLoad.settings);
      this.projectSettingsLoadError = null;
    } else {
      this.projectSettingsLoadError = projectLoad.error;
      this.recordError("project", projectLoad.error);
    }
    this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
  }
  /** Apply additional overrides on top of current settings */
  applyOverrides(overrides) {
    this.settings = deepMergeSettings(this.settings, overrides);
  }
  /** Mark a global field as modified during this session */
  markModified(field, nestedKey) {
    this.modifiedFields.add(field);
    if (nestedKey) {
      if (!this.modifiedNestedFields.has(field)) {
        this.modifiedNestedFields.set(field, /* @__PURE__ */ new Set());
      }
      this.modifiedNestedFields.get(field).add(nestedKey);
    }
  }
  /** Mark a project field as modified during this session */
  markProjectModified(field, nestedKey) {
    this.modifiedProjectFields.add(field);
    if (nestedKey) {
      if (!this.modifiedProjectNestedFields.has(field)) {
        this.modifiedProjectNestedFields.set(field, /* @__PURE__ */ new Set());
      }
      this.modifiedProjectNestedFields.get(field).add(nestedKey);
    }
  }
  recordError(scope, error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    this.errors.push({ scope, error: normalizedError });
  }
  /**
   * Check if project-level settings are active (loaded from a file).
   * Used to scope model persistence to the project when possible,
   * preventing model config bleed between concurrent instances (#650).
   */
  hasProjectSettings() {
    return !this.projectSettingsLoadError && Object.keys(this.projectSettings).length > 0;
  }
  clearModifiedScope(scope) {
    if (scope === "global") {
      this.modifiedFields.clear();
      this.modifiedNestedFields.clear();
      return;
    }
    this.modifiedProjectFields.clear();
    this.modifiedProjectNestedFields.clear();
  }
  enqueueWrite(scope, task) {
    this.writeQueue = this.writeQueue.then(() => {
      task();
      this.clearModifiedScope(scope);
    }).catch((error) => {
      this.recordError(scope, error);
    });
  }
  cloneModifiedNestedFields(source) {
    const snapshot = /* @__PURE__ */ new Map();
    for (const [key, value] of source.entries()) {
      snapshot.set(key, new Set(value));
    }
    return snapshot;
  }
  persistScopedSettings(scope, snapshotSettings, modifiedFields, modifiedNestedFields) {
    this.storage.withLock(scope, (current) => {
      const currentFileSettings = current ? SettingsManager.migrateSettings(JSON.parse(current)) : {};
      const mergedSettings = { ...currentFileSettings };
      for (const field of modifiedFields) {
        const value = snapshotSettings[field];
        if (modifiedNestedFields.has(field) && typeof value === "object" && value !== null) {
          const nestedModified = modifiedNestedFields.get(field);
          const baseNested = currentFileSettings[field] ?? {};
          const inMemoryNested = value;
          const mergedNested = { ...baseNested };
          for (const nestedKey of nestedModified) {
            mergedNested[nestedKey] = inMemoryNested[nestedKey];
          }
          mergedSettings[field] = mergedNested;
        } else {
          mergedSettings[field] = value;
        }
      }
      return JSON.stringify(mergedSettings, null, 2);
    });
  }
  save() {
    this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
    if (this.globalSettingsLoadError) {
      return;
    }
    const snapshotGlobalSettings = structuredClone(this.globalSettings);
    const modifiedFields = new Set(this.modifiedFields);
    const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedNestedFields);
    this.enqueueWrite("global", () => {
      this.persistScopedSettings("global", snapshotGlobalSettings, modifiedFields, modifiedNestedFields);
    });
  }
  saveProjectSettings(settings) {
    this.projectSettings = stripGlobalOnlyKeys(structuredClone(settings));
    this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
    if (this.projectSettingsLoadError) {
      return;
    }
    const snapshotProjectSettings = structuredClone(this.projectSettings);
    const modifiedFields = new Set(this.modifiedProjectFields);
    const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedProjectNestedFields);
    this.enqueueWrite("project", () => {
      this.persistScopedSettings("project", snapshotProjectSettings, modifiedFields, modifiedNestedFields);
    });
  }
  async flush() {
    await this.writeQueue;
  }
  drainErrors() {
    const drained = [...this.errors];
    this.errors = [];
    return drained;
  }
  // ── Generic setter helpers ──────────────────────────────────────────
  /** Set a top-level global setting field, mark modified, and save. */
  setGlobalSetting(key, value) {
    this.globalSettings[key] = value;
    this.markModified(key);
    this.save();
  }
  /** Set a top-level setting, scoped to project when project settings are active. */
  setScopedSetting(key, value) {
    if (this.hasProjectSettings()) {
      this.projectSettings[key] = value;
      this.markProjectModified(key);
      this.saveProjectSettings(this.projectSettings);
    } else {
      this.setGlobalSetting(key, value);
    }
  }
  /** Set a nested field within a global settings object (e.g. compaction.enabled). */
  setNestedGlobalSetting(key, nestedKey, value) {
    if (!this.globalSettings[key]) {
      this.globalSettings[key] = {};
    }
    this.globalSettings[key][nestedKey] = value;
    this.markModified(key, nestedKey);
    this.save();
  }
  /** Set a field on project settings (clone, set, mark modified, save). */
  setProjectSetting(key, value) {
    const projectSettings = structuredClone(this.projectSettings);
    projectSettings[key] = value;
    this.markProjectModified(key);
    this.saveProjectSettings(projectSettings);
  }
  // ── Public getters and setters ──────────────────────────────────────
  getLastChangelogVersion() {
    return this.settings.lastChangelogVersion;
  }
  setLastChangelogVersion(version) {
    this.setGlobalSetting("lastChangelogVersion", version);
  }
  getDefaultProvider() {
    return this.settings.defaultProvider;
  }
  getDefaultModel() {
    return this.settings.defaultModel;
  }
  setDefaultProvider(provider) {
    this.setScopedSetting("defaultProvider", provider);
  }
  setDefaultModel(modelId) {
    this.setScopedSetting("defaultModel", modelId);
  }
  setDefaultModelAndProvider(provider, modelId) {
    if (this.hasProjectSettings()) {
      this.projectSettings.defaultProvider = provider;
      this.projectSettings.defaultModel = modelId;
      this.markProjectModified("defaultProvider");
      this.markProjectModified("defaultModel");
      this.saveProjectSettings(this.projectSettings);
    } else {
      this.globalSettings.defaultProvider = provider;
      this.globalSettings.defaultModel = modelId;
      this.markModified("defaultProvider");
      this.markModified("defaultModel");
      this.save();
    }
  }
  getSteeringMode() {
    return this.settings.steeringMode || "one-at-a-time";
  }
  setSteeringMode(mode) {
    this.setGlobalSetting("steeringMode", mode);
  }
  getFollowUpMode() {
    return this.settings.followUpMode || "one-at-a-time";
  }
  setFollowUpMode(mode) {
    this.setGlobalSetting("followUpMode", mode);
  }
  getTheme() {
    return this.settings.theme;
  }
  setTheme(theme) {
    this.setGlobalSetting("theme", theme);
  }
  getDefaultThinkingLevel() {
    return this.settings.defaultThinkingLevel;
  }
  setDefaultThinkingLevel(level) {
    this.setGlobalSetting("defaultThinkingLevel", level);
  }
  getTransport() {
    return this.settings.transport ?? "sse";
  }
  setTransport(transport) {
    this.setGlobalSetting("transport", transport);
  }
  getCompactionEnabled() {
    return this.settings.compaction?.enabled ?? true;
  }
  setCompactionEnabled(enabled) {
    this.setNestedGlobalSetting("compaction", "enabled", enabled);
  }
  getCompactionReserveTokens() {
    return this.settings.compaction?.reserveTokens ?? COMPACTION_RESERVE_TOKENS;
  }
  getCompactionKeepRecentTokens() {
    return this.settings.compaction?.keepRecentTokens ?? COMPACTION_KEEP_RECENT_TOKENS;
  }
  getCompactionThresholdPercent() {
    return this.settings.compaction?.thresholdPercent;
  }
  /**
   * Set or clear an in-memory compaction threshold-percent override.
   *
   * Applied to `this.settings` only; never persisted to disk. Pass `undefined`
   * to clear a previously set override (necessary for idempotent re-sync from
   * host integrations whose preference may have been removed).
   *
   * Direct mutation is used instead of `applyOverrides()` because deep-merge
   * semantics skip `undefined` values, which would prevent clearing.
   */
  setCompactionThresholdOverride(percent) {
    if (!this.settings.compaction) {
      this.settings.compaction = {};
    }
    if (percent === void 0) {
      delete this.settings.compaction.thresholdPercent;
    } else {
      this.settings.compaction.thresholdPercent = percent;
    }
  }
  getCompactionSettings() {
    return {
      enabled: this.getCompactionEnabled(),
      reserveTokens: this.getCompactionReserveTokens(),
      keepRecentTokens: this.getCompactionKeepRecentTokens(),
      thresholdPercent: this.getCompactionThresholdPercent()
    };
  }
  getBranchSummarySettings() {
    return {
      reserveTokens: this.settings.branchSummary?.reserveTokens ?? COMPACTION_RESERVE_TOKENS,
      skipPrompt: this.settings.branchSummary?.skipPrompt ?? false
    };
  }
  getBranchSummarySkipPrompt() {
    return this.settings.branchSummary?.skipPrompt ?? false;
  }
  getRetryEnabled() {
    return this.settings.retry?.enabled ?? true;
  }
  setRetryEnabled(enabled) {
    this.setNestedGlobalSetting("retry", "enabled", enabled);
  }
  getRetrySettings() {
    return {
      enabled: this.getRetryEnabled(),
      maxRetries: this.settings.retry?.maxRetries ?? 3,
      baseDelayMs: this.settings.retry?.baseDelayMs ?? RETRY_BASE_DELAY_MS,
      maxDelayMs: this.settings.retry?.maxDelayMs ?? RETRY_MAX_DELAY_MS
    };
  }
  getHideThinkingBlock() {
    return this.settings.hideThinkingBlock ?? false;
  }
  setHideThinkingBlock(hide) {
    this.setGlobalSetting("hideThinkingBlock", hide);
  }
  getShellPath() {
    return this.settings.shellPath;
  }
  setShellPath(path) {
    this.setGlobalSetting("shellPath", path);
  }
  getQuietStartup() {
    return this.settings.quietStartup ?? false;
  }
  setQuietStartup(quiet) {
    this.setGlobalSetting("quietStartup", quiet);
  }
  getShellCommandPrefix() {
    return this.settings.shellCommandPrefix;
  }
  setShellCommandPrefix(prefix) {
    this.setGlobalSetting("shellCommandPrefix", prefix);
  }
  getCollapseChangelog() {
    return this.settings.collapseChangelog ?? false;
  }
  setCollapseChangelog(collapse) {
    this.setGlobalSetting("collapseChangelog", collapse);
  }
  getPackages() {
    return [...this.settings.packages ?? []];
  }
  setPackages(packages) {
    this.setGlobalSetting("packages", packages);
  }
  setProjectPackages(packages) {
    this.setProjectSetting("packages", packages);
  }
  getExtensionPaths() {
    return [...this.settings.extensions ?? []];
  }
  setExtensionPaths(paths) {
    this.setGlobalSetting("extensions", paths);
  }
  setProjectExtensionPaths(paths) {
    this.setProjectSetting("extensions", paths);
  }
  getSkillPaths() {
    return [...this.settings.skills ?? []];
  }
  setSkillPaths(paths) {
    this.setGlobalSetting("skills", paths);
  }
  setProjectSkillPaths(paths) {
    this.setProjectSetting("skills", paths);
  }
  getPromptTemplatePaths() {
    return [...this.settings.prompts ?? []];
  }
  setPromptTemplatePaths(paths) {
    this.setGlobalSetting("prompts", paths);
  }
  setProjectPromptTemplatePaths(paths) {
    this.setProjectSetting("prompts", paths);
  }
  getThemePaths() {
    return [...this.settings.themes ?? []];
  }
  setThemePaths(paths) {
    this.setGlobalSetting("themes", paths);
  }
  setProjectThemePaths(paths) {
    this.setProjectSetting("themes", paths);
  }
  getEnableSkillCommands() {
    return this.settings.enableSkillCommands ?? true;
  }
  setEnableSkillCommands(enabled) {
    this.setGlobalSetting("enableSkillCommands", enabled);
  }
  getThinkingBudgets() {
    return this.settings.thinkingBudgets;
  }
  getShowImages() {
    return this.settings.terminal?.showImages ?? true;
  }
  setShowImages(show) {
    this.setNestedGlobalSetting("terminal", "showImages", show);
  }
  getClearOnShrink() {
    if (this.settings.terminal?.clearOnShrink !== void 0) {
      return this.settings.terminal.clearOnShrink;
    }
    return process.env.PI_CLEAR_ON_SHRINK === "1";
  }
  setClearOnShrink(enabled) {
    this.setNestedGlobalSetting("terminal", "clearOnShrink", enabled);
  }
  getAdaptiveMode() {
    const mode = this.settings.terminal?.adaptiveMode;
    const valid = ["auto", "chat", "workflow", "validation", "debug", "compact"];
    return mode && valid.includes(mode) ? mode : "auto";
  }
  setAdaptiveMode(mode) {
    this.setNestedGlobalSetting("terminal", "adaptiveMode", mode);
  }
  getImageAutoResize() {
    return this.settings.images?.autoResize ?? true;
  }
  setImageAutoResize(enabled) {
    this.setNestedGlobalSetting("images", "autoResize", enabled);
  }
  getBlockImages() {
    return this.settings.images?.blockImages ?? false;
  }
  setBlockImages(blocked) {
    this.setNestedGlobalSetting("images", "blockImages", blocked);
  }
  getEnabledModels() {
    return this.settings.enabledModels;
  }
  setEnabledModels(patterns) {
    this.setGlobalSetting("enabledModels", patterns);
  }
  getDoubleEscapeAction() {
    return this.settings.doubleEscapeAction ?? "tree";
  }
  setDoubleEscapeAction(action) {
    this.setGlobalSetting("doubleEscapeAction", action);
  }
  getTreeFilterMode() {
    const mode = this.settings.treeFilterMode;
    const valid = ["default", "no-tools", "user-only", "labeled-only", "all"];
    return mode && valid.includes(mode) ? mode : "default";
  }
  setTreeFilterMode(mode) {
    this.setGlobalSetting("treeFilterMode", mode);
  }
  getShowHardwareCursor() {
    return this.settings.showHardwareCursor ?? process.env.PI_HARDWARE_CURSOR === "1";
  }
  setShowHardwareCursor(enabled) {
    this.setGlobalSetting("showHardwareCursor", enabled);
  }
  getEditorPaddingX() {
    return this.settings.editorPaddingX ?? 0;
  }
  setEditorPaddingX(padding) {
    this.setGlobalSetting("editorPaddingX", Math.max(0, Math.min(3, Math.floor(padding))));
  }
  getAutocompleteMaxVisible() {
    return this.settings.autocompleteMaxVisible ?? 5;
  }
  setAutocompleteMaxVisible(maxVisible) {
    this.setGlobalSetting("autocompleteMaxVisible", Math.max(3, Math.min(20, Math.floor(maxVisible))));
  }
  getRespectGitignoreInPicker() {
    return this.settings.respectGitignoreInPicker ?? true;
  }
  setRespectGitignoreInPicker(value) {
    this.setGlobalSetting("respectGitignoreInPicker", value);
  }
  getSearchExcludeDirs() {
    return this.settings.searchExcludeDirs ?? [];
  }
  setSearchExcludeDirs(dirs) {
    this.setGlobalSetting("searchExcludeDirs", dirs.filter(Boolean));
  }
  getCodeBlockIndent() {
    return this.settings.markdown?.codeBlockIndent ?? "  ";
  }
  getMemorySettings() {
    return {
      enabled: this.settings.memory?.enabled ?? false,
      maxRolloutsPerStartup: this.settings.memory?.maxRolloutsPerStartup ?? 64,
      maxRolloutAgeDays: this.settings.memory?.maxRolloutAgeDays ?? 30,
      minRolloutIdleHours: this.settings.memory?.minRolloutIdleHours ?? 12,
      stage1Concurrency: this.settings.memory?.stage1Concurrency ?? 8,
      summaryInjectionTokenLimit: this.settings.memory?.summaryInjectionTokenLimit ?? 5e3
    };
  }
  getAsyncEnabled() {
    return this.settings.async?.enabled ?? false;
  }
  getAsyncMaxJobs() {
    return this.settings.async?.maxJobs ?? 100;
  }
  getTaskIsolationMode() {
    return this.settings.taskIsolation?.mode ?? "none";
  }
  getTaskIsolationMerge() {
    return this.settings.taskIsolation?.merge ?? "patch";
  }
  getFallbackEnabled() {
    return this.settings.fallback?.enabled ?? false;
  }
  setFallbackEnabled(enabled) {
    this.setNestedGlobalSetting("fallback", "enabled", enabled);
  }
  getFallbackChains() {
    return this.settings.fallback?.chains ?? {};
  }
  getFallbackChain(name) {
    return this.settings.fallback?.chains?.[name];
  }
  setFallbackChain(name, entries) {
    if (!this.globalSettings.fallback) {
      this.globalSettings.fallback = {};
    }
    if (!this.globalSettings.fallback.chains) {
      this.globalSettings.fallback.chains = {};
    }
    this.globalSettings.fallback.chains[name] = [...entries].sort((a, b) => a.priority - b.priority);
    this.markModified("fallback");
    this.save();
  }
  removeFallbackChain(name) {
    if (!this.globalSettings.fallback?.chains?.[name]) {
      return false;
    }
    delete this.globalSettings.fallback.chains[name];
    if (Object.keys(this.globalSettings.fallback.chains).length === 0) {
      delete this.globalSettings.fallback.chains;
    }
    this.markModified("fallback");
    this.save();
    return true;
  }
  getFallbackSettings() {
    return {
      enabled: this.getFallbackEnabled(),
      chains: this.getFallbackChains()
    };
  }
  getModelDiscoverySettings() {
    return this.settings.modelDiscovery ?? {};
  }
  setModelDiscoveryEnabled(enabled) {
    this.setNestedGlobalSetting("modelDiscovery", "enabled", enabled);
  }
  getEditMode() {
    return this.settings.editMode ?? "standard";
  }
  setEditMode(mode) {
    this.setGlobalSetting("editMode", mode);
  }
  getTimestampFormat() {
    return this.settings.timestampFormat ?? "date-time-iso";
  }
  setTimestampFormat(format) {
    this.setGlobalSetting("timestampFormat", format);
  }
  /**
   * Get the allowed command prefixes from global settings only.
   * Returns undefined if not configured (caller should use built-in defaults).
   */
  getAllowedCommandPrefixes() {
    return this.globalSettings.allowedCommandPrefixes;
  }
  setAllowedCommandPrefixes(prefixes) {
    this.setGlobalSetting("allowedCommandPrefixes", prefixes);
  }
  /**
   * Get the fetch URL allowlist from global settings only.
   * Returns undefined if not configured (caller should use empty allowlist).
   */
  getFetchAllowedUrls() {
    return this.globalSettings.fetchAllowedUrls;
  }
  setFetchAllowedUrls(urls) {
    this.setGlobalSetting("fetchAllowedUrls", urls);
  }
}
export {
  SettingsManager
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL3NldHRpbmdzLW1hbmFnZXIudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0eXBlIHsgVHJhbnNwb3J0IH0gZnJvbSBcIkBnc2QvcGktYWlcIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMsIG1rZGlyU3luYywgcmVhZEZpbGVTeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcImZzXCI7XG5pbXBvcnQgeyBkaXJuYW1lLCBqb2luIH0gZnJvbSBcInBhdGhcIjtcbmltcG9ydCBsb2NrZmlsZSBmcm9tIFwicHJvcGVyLWxvY2tmaWxlXCI7XG5pbXBvcnQgeyBDT05GSUdfRElSX05BTUUsIGdldEFnZW50RGlyIH0gZnJvbSBcIi4uL2NvbmZpZy5qc1wiO1xuaW1wb3J0IHtcblx0Q09NUEFDVElPTl9LRUVQX1JFQ0VOVF9UT0tFTlMsXG5cdENPTVBBQ1RJT05fUkVTRVJWRV9UT0tFTlMsXG5cdFJFVFJZX0JBU0VfREVMQVlfTVMsXG5cdFJFVFJZX01BWF9ERUxBWV9NUyxcbn0gZnJvbSBcIi4vY29uc3RhbnRzLmpzXCI7XG5pbXBvcnQgdHlwZSB7IEJhc2hJbnRlcmNlcHRvclJ1bGUgfSBmcm9tIFwiLi90b29scy9iYXNoLWludGVyY2VwdG9yLmpzXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ29tcGFjdGlvblNldHRpbmdzIHtcblx0ZW5hYmxlZD86IGJvb2xlYW47IC8vIGRlZmF1bHQ6IHRydWVcblx0cmVzZXJ2ZVRva2Vucz86IG51bWJlcjsgLy8gZGVmYXVsdDogMTYzODRcblx0a2VlcFJlY2VudFRva2Vucz86IG51bWJlcjsgLy8gZGVmYXVsdDogMjAwMDBcblx0LyoqXG5cdCAqIE9wdGlvbmFsIHBlcmNlbnQtb2YtY29udGV4dC13aW5kb3cgdHJpZ2dlciAoMCA8IHZhbHVlIDwgMSkuIFdoZW4gc2V0LFxuXHQgKiBjb21wYWN0aW9uIGZpcmVzIGF0IGBjb250ZXh0V2luZG93ICogdGhyZXNob2xkUGVyY2VudGAgYW5kIG92ZXJyaWRlc1xuXHQgKiBgcmVzZXJ2ZVRva2Vuc2AuIFR5cGljYWxseSBzZXQgYXMgYSBydW50aW1lIG92ZXJyaWRlIGJ5IGhvc3QgaW50ZWdyYXRpb25zXG5cdCAqIChzZWUgYHNldENvbXBhY3Rpb25UaHJlc2hvbGRPdmVycmlkZWApIGFuZCBub3QgcGVyc2lzdGVkIGJ5IHVzZXJzIGRpcmVjdGx5LlxuXHQgKi9cblx0dGhyZXNob2xkUGVyY2VudD86IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBCcmFuY2hTdW1tYXJ5U2V0dGluZ3Mge1xuXHRyZXNlcnZlVG9rZW5zPzogbnVtYmVyOyAvLyBkZWZhdWx0OiAxNjM4NCAodG9rZW5zIHJlc2VydmVkIGZvciBwcm9tcHQgKyBMTE0gcmVzcG9uc2UpXG5cdHNraXBQcm9tcHQ/OiBib29sZWFuOyAvLyBkZWZhdWx0OiBmYWxzZSAtIHdoZW4gdHJ1ZSwgc2tpcHMgXCJTdW1tYXJpemUgYnJhbmNoP1wiIHByb21wdCBhbmQgZGVmYXVsdHMgdG8gbm8gc3VtbWFyeVxufVxuXG5leHBvcnQgaW50ZXJmYWNlIFJldHJ5U2V0dGluZ3Mge1xuXHRlbmFibGVkPzogYm9vbGVhbjsgLy8gZGVmYXVsdDogdHJ1ZVxuXHRtYXhSZXRyaWVzPzogbnVtYmVyOyAvLyBkZWZhdWx0OiAzXG5cdGJhc2VEZWxheU1zPzogbnVtYmVyOyAvLyBkZWZhdWx0OiAyMDAwIChleHBvbmVudGlhbCBiYWNrb2ZmOiAycywgNHMsIDhzKVxuXHRtYXhEZWxheU1zPzogbnVtYmVyOyAvLyBkZWZhdWx0OiAzMDAwMDAgKG1heCBzZXJ2ZXItcmVxdWVzdGVkIGRlbGF5IGJlZm9yZSBmYWlsaW5nKVxufVxuXG5leHBvcnQgaW50ZXJmYWNlIFRlcm1pbmFsU2V0dGluZ3Mge1xuXHRzaG93SW1hZ2VzPzogYm9vbGVhbjsgLy8gZGVmYXVsdDogdHJ1ZSAob25seSByZWxldmFudCBpZiB0ZXJtaW5hbCBzdXBwb3J0cyBpbWFnZXMpXG5cdGNsZWFyT25TaHJpbms/OiBib29sZWFuOyAvLyBkZWZhdWx0OiBmYWxzZSAoY2xlYXIgZW1wdHkgcm93cyB3aGVuIGNvbnRlbnQgc2hyaW5rcylcblx0YWRhcHRpdmVNb2RlPzogQWRhcHRpdmVUdWlNb2RlOyAvLyBkZWZhdWx0OiBcImF1dG9cIlxufVxuXG5leHBvcnQgaW50ZXJmYWNlIEltYWdlU2V0dGluZ3Mge1xuXHRhdXRvUmVzaXplPzogYm9vbGVhbjsgLy8gZGVmYXVsdDogdHJ1ZSAocmVzaXplIGltYWdlcyB0byAyMDAweDIwMDAgbWF4IGZvciBiZXR0ZXIgbW9kZWwgY29tcGF0aWJpbGl0eSlcblx0YmxvY2tJbWFnZXM/OiBib29sZWFuOyAvLyBkZWZhdWx0OiBmYWxzZSAtIHdoZW4gdHJ1ZSwgcHJldmVudHMgYWxsIGltYWdlcyBmcm9tIGJlaW5nIHNlbnQgdG8gTExNIHByb3ZpZGVyc1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFRoaW5raW5nQnVkZ2V0c1NldHRpbmdzIHtcblx0bWluaW1hbD86IG51bWJlcjtcblx0bG93PzogbnVtYmVyO1xuXHRtZWRpdW0/OiBudW1iZXI7XG5cdGhpZ2g/OiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQmFzaEludGVyY2VwdG9yU2V0dGluZ3Mge1xuXHRlbmFibGVkPzogYm9vbGVhbjsgLy8gZGVmYXVsdDogdHJ1ZVxuXHRydWxlcz86IEJhc2hJbnRlcmNlcHRvclJ1bGVbXTsgLy8gb3ZlcnJpZGUgZGVmYXVsdCBydWxlc1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIE1hcmtkb3duU2V0dGluZ3Mge1xuXHRjb2RlQmxvY2tJbmRlbnQ/OiBzdHJpbmc7IC8vIGRlZmF1bHQ6IFwiICBcIlxufVxuXG5leHBvcnQgaW50ZXJmYWNlIE1lbW9yeVNldHRpbmdzIHtcblx0ZW5hYmxlZD86IGJvb2xlYW47IC8vIGRlZmF1bHQ6IGZhbHNlXG5cdG1heFJvbGxvdXRzUGVyU3RhcnR1cD86IG51bWJlcjsgLy8gZGVmYXVsdDogNjRcblx0bWF4Um9sbG91dEFnZURheXM/OiBudW1iZXI7IC8vIGRlZmF1bHQ6IDMwXG5cdG1pblJvbGxvdXRJZGxlSG91cnM/OiBudW1iZXI7IC8vIGRlZmF1bHQ6IDEyXG5cdHN0YWdlMUNvbmN1cnJlbmN5PzogbnVtYmVyOyAvLyBkZWZhdWx0OiA4XG5cdHN1bW1hcnlJbmplY3Rpb25Ub2tlbkxpbWl0PzogbnVtYmVyOyAvLyBkZWZhdWx0OiA1MDAwXG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXN5bmNTZXR0aW5ncyB7XG5cdGVuYWJsZWQ/OiBib29sZWFuOyAgLy8gZGVmYXVsdDogZmFsc2Vcblx0bWF4Sm9icz86IG51bWJlcjsgICAvLyBkZWZhdWx0OiAxMDBcbn1cblxuZXhwb3J0IGludGVyZmFjZSBUYXNrSXNvbGF0aW9uU2V0dGluZ3Mge1xuXHRtb2RlPzogXCJub25lXCIgfCBcIndvcmt0cmVlXCIgfCBcImZ1c2Utb3ZlcmxheVwiOyAvLyBkZWZhdWx0OiBcIm5vbmVcIlxuXHRtZXJnZT86IFwicGF0Y2hcIiB8IFwiYnJhbmNoXCI7IC8vIGRlZmF1bHQ6IFwicGF0Y2hcIlxufVxuXG5leHBvcnQgaW50ZXJmYWNlIEZhbGxiYWNrQ2hhaW5FbnRyeSB7XG5cdHByb3ZpZGVyOiBzdHJpbmc7XG5cdG1vZGVsOiBzdHJpbmc7XG5cdHByaW9yaXR5OiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRmFsbGJhY2tTZXR0aW5ncyB7XG5cdGVuYWJsZWQ/OiBib29sZWFuOyAvLyBkZWZhdWx0OiBmYWxzZVxuXHRjaGFpbnM/OiBSZWNvcmQ8c3RyaW5nLCBGYWxsYmFja0NoYWluRW50cnlbXT47IC8vIGtleWVkIGJ5IGNoYWluIG5hbWVcbn1cblxuZXhwb3J0IGludGVyZmFjZSBNb2RlbERpc2NvdmVyeVNldHRpbmdzIHtcblx0ZW5hYmxlZD86IGJvb2xlYW47IC8vIGRlZmF1bHQ6IGZhbHNlXG5cdHByb3ZpZGVycz86IHN0cmluZ1tdOyAvLyBsaW1pdCBkaXNjb3ZlcnkgdG8gc3BlY2lmaWMgcHJvdmlkZXJzXG5cdHR0bE1pbnV0ZXM/OiBudW1iZXI7IC8vIG92ZXJyaWRlIGRlZmF1bHQgVFRMcyAoaW4gbWludXRlcylcblx0YXV0b1JlZnJlc2hPbk1vZGVsU2VsZWN0PzogYm9vbGVhbjsgLy8gZGVmYXVsdDogZmFsc2UgLSByZWZyZXNoIGRpc2NvdmVyeSB3aGVuIG9wZW5pbmcgbW9kZWwgc2VsZWN0b3Jcbn1cblxuLyoqXG4gKiBBIHNoZWxsIGNvbW1hbmQgYm91bmQgdG8gYSBMYXllciAwIGhvb2sgZXZlbnQuXG4gKlxuICogUGF5bG9hZCBpcyBwYXNzZWQgdG8gdGhlIGNvbW1hbmQgb24gc3RkaW4gYXMgSlNPTi4gVGhlIGNvbW1hbmQgbWF5IHdyaXRlIGFcbiAqIEpTT04gb2JqZWN0IHRvIHN0ZG91dCB0byBtdXRhdGUgdGhlIHBlbmRpbmcgYWN0aW9uIFx1MjAxNCBzaGFwZSB2YXJpZXMgcGVyIGhvb2tcbiAqIChlLmcuIGB7XCJibG9ja1wiOnRydWUsXCJyZWFzb25cIjpcIi4uLlwifWAgZm9yIFByZVRvb2xVc2UpLiBOb24temVybyBleGl0IHdpdGhcbiAqIGBibG9ja2luZzogdHJ1ZWAgdmV0b2VzIHRoZSBhY3Rpb24uXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgSG9va0VudHJ5IHtcblx0LyoqIE9wdGlvbmFsIGZpbHRlciBvbiB0aGUgZXZlbnQgcGF5bG9hZCAoY3VycmVudGx5IHN1cHBvcnRzIHRvb2wgbmFtZSAvIGJhc2ggY29tbWFuZCBwcmVmaXgpLiAqL1xuXHRtYXRjaD86IHtcblx0XHR0b29sPzogc3RyaW5nIHwgc3RyaW5nW107XG5cdFx0Y29tbWFuZD86IHN0cmluZztcblx0fTtcblx0LyoqIFRoZSBzaGVsbCBjb21tYW5kIHRvIGV4ZWN1dGUuICovXG5cdGNvbW1hbmQ6IHN0cmluZztcblx0LyoqIFRpbWVvdXQgaW4gbWlsbGlzZWNvbmRzLiBEZWZhdWx0OiAzMDAwMC4gKi9cblx0dGltZW91dD86IG51bWJlcjtcblx0LyoqIFdoZW4gdHJ1ZSAoZGVmYXVsdCksIGEgbm9uLXplcm8gZXhpdCB2ZXRvZXMgdGhlIHBlbmRpbmcgYWN0aW9uLiAqL1xuXHRibG9ja2luZz86IGJvb2xlYW47XG5cdC8qKiBFeHRyYSBlbnZpcm9ubWVudCB2YXJpYWJsZXMgZm9yIHRoZSBjaGlsZCBwcm9jZXNzLiAqL1xuXHRlbnY/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xufVxuXG4vKipcbiAqIExheWVyIDAgc2hlbGwgaG9va3MuIEVhY2gga2V5IGlzIHRoZSBuYW1lIG9mIGEgaG9vayBldmVudDsgZWFjaCB2YWx1ZSBpcyBhXG4gKiBsaXN0IG9mIGBIb29rRW50cnlgIFx1MjAxNCBhbGwgbWF0Y2hpbmcgZW50cmllcyBydW4gaW4gb3JkZXIuXG4gKlxuICogSG9vayBuYW1lcyBtaXJyb3IgQ2xhdWRlIENvZGUncyBmb3IgcG9ydGFiaWxpdHkuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgSG9va3NTZXR0aW5ncyB7XG5cdFByZVRvb2xVc2U/OiBIb29rRW50cnlbXTtcblx0UG9zdFRvb2xVc2U/OiBIb29rRW50cnlbXTtcblx0VXNlclByb21wdFN1Ym1pdD86IEhvb2tFbnRyeVtdO1xuXHRTZXNzaW9uU3RhcnQ/OiBIb29rRW50cnlbXTtcblx0U2Vzc2lvbkVuZD86IEhvb2tFbnRyeVtdO1xuXHRTdG9wPzogSG9va0VudHJ5W107XG5cdE5vdGlmaWNhdGlvbj86IEhvb2tFbnRyeVtdO1xuXHRQcmVDb21wYWN0PzogSG9va0VudHJ5W107XG5cdFBvc3RDb21wYWN0PzogSG9va0VudHJ5W107XG5cdFByZUNvbW1pdD86IEhvb2tFbnRyeVtdO1xuXHRQb3N0Q29tbWl0PzogSG9va0VudHJ5W107XG5cdFByZVB1c2g/OiBIb29rRW50cnlbXTtcblx0UG9zdFB1c2g/OiBIb29rRW50cnlbXTtcblx0UHJlUHI/OiBIb29rRW50cnlbXTtcblx0UG9zdFByPzogSG9va0VudHJ5W107XG5cdFByZU1pbGVzdG9uZT86IEhvb2tFbnRyeVtdO1xuXHRQb3N0TWlsZXN0b25lPzogSG9va0VudHJ5W107XG5cdFByZVVuaXQ/OiBIb29rRW50cnlbXTtcblx0UG9zdFVuaXQ/OiBIb29rRW50cnlbXTtcblx0UHJlVmVyaWZ5PzogSG9va0VudHJ5W107XG5cdFBvc3RWZXJpZnk/OiBIb29rRW50cnlbXTtcblx0QnVkZ2V0VGhyZXNob2xkPzogSG9va0VudHJ5W107XG5cdEJsb2NrZWQ/OiBIb29rRW50cnlbXTtcbn1cblxuZXhwb3J0IHR5cGUgVHJhbnNwb3J0U2V0dGluZyA9IFRyYW5zcG9ydDtcbmV4cG9ydCB0eXBlIEFkYXB0aXZlVHVpTW9kZSA9IFwiYXV0b1wiIHwgXCJjaGF0XCIgfCBcIndvcmtmbG93XCIgfCBcInZhbGlkYXRpb25cIiB8IFwiZGVidWdcIiB8IFwiY29tcGFjdFwiO1xuXG4vKipcbiAqIFBhY2thZ2Ugc291cmNlIGZvciBucG0vZ2l0IHBhY2thZ2VzLlxuICogLSBTdHJpbmcgZm9ybTogbG9hZCBhbGwgcmVzb3VyY2VzIGZyb20gdGhlIHBhY2thZ2VcbiAqIC0gT2JqZWN0IGZvcm06IGZpbHRlciB3aGljaCByZXNvdXJjZXMgdG8gbG9hZFxuICovXG5leHBvcnQgdHlwZSBQYWNrYWdlU291cmNlID1cblx0fCBzdHJpbmdcblx0fCB7XG5cdFx0XHRzb3VyY2U6IHN0cmluZztcblx0XHRcdGV4dGVuc2lvbnM/OiBzdHJpbmdbXTtcblx0XHRcdHNraWxscz86IHN0cmluZ1tdO1xuXHRcdFx0cHJvbXB0cz86IHN0cmluZ1tdO1xuXHRcdFx0dGhlbWVzPzogc3RyaW5nW107XG5cdCAgfTtcblxuZXhwb3J0IGludGVyZmFjZSBTZXR0aW5ncyB7XG5cdGxhc3RDaGFuZ2Vsb2dWZXJzaW9uPzogc3RyaW5nO1xuXHRkZWZhdWx0UHJvdmlkZXI/OiBzdHJpbmc7XG5cdGRlZmF1bHRNb2RlbD86IHN0cmluZztcblx0ZGVmYXVsdFRoaW5raW5nTGV2ZWw/OiBcIm9mZlwiIHwgXCJtaW5pbWFsXCIgfCBcImxvd1wiIHwgXCJtZWRpdW1cIiB8IFwiaGlnaFwiIHwgXCJ4aGlnaFwiO1xuXHR0cmFuc3BvcnQ/OiBUcmFuc3BvcnRTZXR0aW5nOyAvLyBkZWZhdWx0OiBcInNzZVwiXG5cdHN0ZWVyaW5nTW9kZT86IFwiYWxsXCIgfCBcIm9uZS1hdC1hLXRpbWVcIjtcblx0Zm9sbG93VXBNb2RlPzogXCJhbGxcIiB8IFwib25lLWF0LWEtdGltZVwiO1xuXHR0aGVtZT86IHN0cmluZztcblx0Y29tcGFjdGlvbj86IENvbXBhY3Rpb25TZXR0aW5ncztcblx0YnJhbmNoU3VtbWFyeT86IEJyYW5jaFN1bW1hcnlTZXR0aW5ncztcblx0cmV0cnk/OiBSZXRyeVNldHRpbmdzO1xuXHRoaWRlVGhpbmtpbmdCbG9jaz86IGJvb2xlYW47XG5cdHNoZWxsUGF0aD86IHN0cmluZzsgLy8gQ3VzdG9tIHNoZWxsIHBhdGggKGUuZy4sIGZvciBDeWd3aW4gdXNlcnMgb24gV2luZG93cylcblx0cXVpZXRTdGFydHVwPzogYm9vbGVhbjtcblx0c2hlbGxDb21tYW5kUHJlZml4Pzogc3RyaW5nOyAvLyBQcmVmaXggcHJlcGVuZGVkIHRvIGV2ZXJ5IGJhc2ggY29tbWFuZCAoZS5nLiwgXCJzaG9wdCAtcyBleHBhbmRfYWxpYXNlc1wiIGZvciBhbGlhcyBzdXBwb3J0KVxuXHRjb2xsYXBzZUNoYW5nZWxvZz86IGJvb2xlYW47IC8vIFNob3cgY29uZGVuc2VkIGNoYW5nZWxvZyBhZnRlciB1cGRhdGUgKHVzZSAvY2hhbmdlbG9nIGZvciBmdWxsKVxuXHRwYWNrYWdlcz86IFBhY2thZ2VTb3VyY2VbXTsgLy8gQXJyYXkgb2YgbnBtL2dpdCBwYWNrYWdlIHNvdXJjZXMgKHN0cmluZyBvciBvYmplY3Qgd2l0aCBmaWx0ZXJpbmcpXG5cdGV4dGVuc2lvbnM/OiBzdHJpbmdbXTsgLy8gQXJyYXkgb2YgbG9jYWwgZXh0ZW5zaW9uIGZpbGUgcGF0aHMgb3IgZGlyZWN0b3JpZXNcblx0c2tpbGxzPzogc3RyaW5nW107IC8vIEFycmF5IG9mIGxvY2FsIHNraWxsIGZpbGUgcGF0aHMgb3IgZGlyZWN0b3JpZXNcblx0cHJvbXB0cz86IHN0cmluZ1tdOyAvLyBBcnJheSBvZiBsb2NhbCBwcm9tcHQgdGVtcGxhdGUgcGF0aHMgb3IgZGlyZWN0b3JpZXNcblx0dGhlbWVzPzogc3RyaW5nW107IC8vIEFycmF5IG9mIGxvY2FsIHRoZW1lIGZpbGUgcGF0aHMgb3IgZGlyZWN0b3JpZXNcblx0ZW5hYmxlU2tpbGxDb21tYW5kcz86IGJvb2xlYW47IC8vIGRlZmF1bHQ6IHRydWUgLSByZWdpc3RlciBza2lsbHMgYXMgL3NraWxsOm5hbWUgY29tbWFuZHNcblx0dGVybWluYWw/OiBUZXJtaW5hbFNldHRpbmdzO1xuXHRpbWFnZXM/OiBJbWFnZVNldHRpbmdzO1xuXHRlbmFibGVkTW9kZWxzPzogc3RyaW5nW107IC8vIE1vZGVsIHBhdHRlcm5zIGZvciBjeWNsaW5nIChzYW1lIGZvcm1hdCBhcyAtLW1vZGVscyBDTEkgZmxhZylcblx0ZG91YmxlRXNjYXBlQWN0aW9uPzogXCJmb3JrXCIgfCBcInRyZWVcIiB8IFwibm9uZVwiOyAvLyBBY3Rpb24gZm9yIGRvdWJsZS1lc2NhcGUgd2l0aCBlbXB0eSBlZGl0b3IgKGRlZmF1bHQ6IFwidHJlZVwiKVxuXHR0cmVlRmlsdGVyTW9kZT86IFwiZGVmYXVsdFwiIHwgXCJuby10b29sc1wiIHwgXCJ1c2VyLW9ubHlcIiB8IFwibGFiZWxlZC1vbmx5XCIgfCBcImFsbFwiOyAvLyBEZWZhdWx0IGZpbHRlciB3aGVuIG9wZW5pbmcgL3RyZWVcblx0dGhpbmtpbmdCdWRnZXRzPzogVGhpbmtpbmdCdWRnZXRzU2V0dGluZ3M7IC8vIEN1c3RvbSB0b2tlbiBidWRnZXRzIGZvciB0aGlua2luZyBsZXZlbHNcblx0ZWRpdG9yUGFkZGluZ1g/OiBudW1iZXI7IC8vIEhvcml6b250YWwgcGFkZGluZyBmb3IgaW5wdXQgZWRpdG9yIChkZWZhdWx0OiAwKVxuXHRhdXRvY29tcGxldGVNYXhWaXNpYmxlPzogbnVtYmVyOyAvLyBNYXggdmlzaWJsZSBpdGVtcyBpbiBhdXRvY29tcGxldGUgZHJvcGRvd24gKGRlZmF1bHQ6IDUpXG5cdHJlc3BlY3RHaXRpZ25vcmVJblBpY2tlcj86IGJvb2xlYW47IC8vIFdoZW4gZmFsc2UsIEAgZmlsZSBwaWNrZXIgc2hvd3MgZ2l0aWdub3JlZCBmaWxlcyAoZGVmYXVsdDogdHJ1ZSlcblx0c2VhcmNoRXhjbHVkZURpcnM/OiBzdHJpbmdbXTsgLy8gRGlyZWN0b3JpZXMgdG8gZXhjbHVkZSBmcm9tIEAgZmlsZSBzZWFyY2ggKGUuZy4sIFtcIm5vZGVfbW9kdWxlc1wiLCBcIi5naXRcIiwgXCJkaXN0XCJdKVxuXHRzaG93SGFyZHdhcmVDdXJzb3I/OiBib29sZWFuOyAvLyBTaG93IHRlcm1pbmFsIGN1cnNvciB3aGlsZSBzdGlsbCBwb3NpdGlvbmluZyBpdCBmb3IgSU1FXG5cdG1hcmtkb3duPzogTWFya2Rvd25TZXR0aW5ncztcblx0bWVtb3J5PzogTWVtb3J5U2V0dGluZ3M7XG5cdGFzeW5jPzogQXN5bmNTZXR0aW5ncztcblx0YmFzaEludGVyY2VwdG9yPzogQmFzaEludGVyY2VwdG9yU2V0dGluZ3M7XG5cdHRhc2tJc29sYXRpb24/OiBUYXNrSXNvbGF0aW9uU2V0dGluZ3M7XG5cdGZhbGxiYWNrPzogRmFsbGJhY2tTZXR0aW5ncztcblx0bW9kZWxEaXNjb3Zlcnk/OiBNb2RlbERpc2NvdmVyeVNldHRpbmdzO1xuXHRlZGl0TW9kZT86IFwic3RhbmRhcmRcIiB8IFwiaGFzaGxpbmVcIjsgLy8gRWRpdCB0b29sIG1vZGU6IFwic3RhbmRhcmRcIiAodGV4dCBtYXRjaCkgb3IgXCJoYXNobGluZVwiIChMSU5FI0lEIGFuY2hvcnMpLiBEZWZhdWx0OiBcInN0YW5kYXJkXCJcblx0dGltZXN0YW1wRm9ybWF0PzogXCJkYXRlLXRpbWUtaXNvXCIgfCBcImRhdGUtdGltZS11c1wiOyAvLyBUaW1lc3RhbXAgZGlzcGxheSBmb3JtYXQgZm9yIG1lc3NhZ2VzLiBEZWZhdWx0OiBcImRhdGUtdGltZS1pc29cIlxuXHRhbGxvd2VkQ29tbWFuZFByZWZpeGVzPzogc3RyaW5nW107IC8vIE92ZXJyaWRlIGJ1aWx0LWluIFNBRkVfQ09NTUFORF9QUkVGSVhFUyBmb3IgIWNvbW1hbmQgcmVzb2x1dGlvbiAoZ2xvYmFsLW9ubHkgXHUyMDE0IGlnbm9yZWQgaW4gcHJvamVjdCBzZXR0aW5ncylcblx0ZmV0Y2hBbGxvd2VkVXJscz86IHN0cmluZ1tdOyAvLyBIb3N0bmFtZXMgZXhlbXB0ZWQgZnJvbSBTU1JGIGJsb2NrbGlzdCBpbiBmZXRjaF9wYWdlIChnbG9iYWwtb25seSBcdTIwMTQgaWdub3JlZCBpbiBwcm9qZWN0IHNldHRpbmdzKVxuXHRob29rcz86IEhvb2tzU2V0dGluZ3M7IC8vIExheWVyIDAgc2hlbGwtY29tbWFuZCBob29rcy4gUHJvamVjdC1zY29wZWQgaG9va3MgcmVxdWlyZSBleHBsaWNpdCB0cnVzdCAoLnBpL2hvb2tzLnRydXN0ZWQpLlxufVxuXG4vKiogU2V0dGluZ3Mga2V5cyB0aGF0IGFyZSBvbmx5IHJlc3BlY3RlZCBmcm9tIGdsb2JhbCBjb25maWcgXHUyMDE0IHByb2plY3Qgc2V0dGluZ3MgY2Fubm90IG92ZXJyaWRlIHRoZXNlLiAqL1xuY29uc3QgR0xPQkFMX09OTFlfS0VZUzogUmVhZG9ubHlTZXQ8a2V5b2YgU2V0dGluZ3M+ID0gbmV3IFNldChbXG5cdFwiYWxsb3dlZENvbW1hbmRQcmVmaXhlc1wiLFxuXHRcImZldGNoQWxsb3dlZFVybHNcIixcbl0pO1xuXG4vKiogUmVtb3ZlIGdsb2JhbC1vbmx5IGtleXMgZnJvbSBhIHNldHRpbmdzIG9iamVjdC4gQXBwbGllZCBvbmNlIGF0IGxvYWQgdGltZS4gKi9cbmZ1bmN0aW9uIHN0cmlwR2xvYmFsT25seUtleXMoc2V0dGluZ3M6IFNldHRpbmdzKTogU2V0dGluZ3Mge1xuXHRjb25zdCByZXN1bHQgPSB7IC4uLnNldHRpbmdzIH07XG5cdGZvciAoY29uc3Qga2V5IG9mIEdMT0JBTF9PTkxZX0tFWVMpIHtcblx0XHRkZWxldGUgKHJlc3VsdCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPilba2V5XTtcblx0fVxuXHRyZXR1cm4gcmVzdWx0O1xufVxuXG4vKiogRGVlcCBtZXJnZSBzZXR0aW5nczogcHJvamVjdC9vdmVycmlkZXMgdGFrZSBwcmVjZWRlbmNlLCBuZXN0ZWQgb2JqZWN0cyBtZXJnZSByZWN1cnNpdmVseSAqL1xuZnVuY3Rpb24gZGVlcE1lcmdlU2V0dGluZ3MoYmFzZTogU2V0dGluZ3MsIG92ZXJyaWRlczogU2V0dGluZ3MpOiBTZXR0aW5ncyB7XG5cdGNvbnN0IHJlc3VsdDogU2V0dGluZ3MgPSB7IC4uLmJhc2UgfTtcblxuXHRmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhvdmVycmlkZXMpIGFzIChrZXlvZiBTZXR0aW5ncylbXSkge1xuXHRcdGNvbnN0IG92ZXJyaWRlVmFsdWUgPSBvdmVycmlkZXNba2V5XTtcblx0XHRjb25zdCBiYXNlVmFsdWUgPSBiYXNlW2tleV07XG5cblx0XHRpZiAob3ZlcnJpZGVWYWx1ZSA9PT0gdW5kZWZpbmVkKSB7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cblx0XHQvLyBGb3IgbmVzdGVkIG9iamVjdHMsIG1lcmdlIHJlY3Vyc2l2ZWx5XG5cdFx0aWYgKFxuXHRcdFx0dHlwZW9mIG92ZXJyaWRlVmFsdWUgPT09IFwib2JqZWN0XCIgJiZcblx0XHRcdG92ZXJyaWRlVmFsdWUgIT09IG51bGwgJiZcblx0XHRcdCFBcnJheS5pc0FycmF5KG92ZXJyaWRlVmFsdWUpICYmXG5cdFx0XHR0eXBlb2YgYmFzZVZhbHVlID09PSBcIm9iamVjdFwiICYmXG5cdFx0XHRiYXNlVmFsdWUgIT09IG51bGwgJiZcblx0XHRcdCFBcnJheS5pc0FycmF5KGJhc2VWYWx1ZSlcblx0XHQpIHtcblx0XHRcdChyZXN1bHQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pW2tleV0gPSB7IC4uLmJhc2VWYWx1ZSwgLi4ub3ZlcnJpZGVWYWx1ZSB9O1xuXHRcdH0gZWxzZSB7XG5cdFx0XHQvLyBGb3IgcHJpbWl0aXZlcyBhbmQgYXJyYXlzLCBvdmVycmlkZSB2YWx1ZSB3aW5zXG5cdFx0XHQocmVzdWx0IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KVtrZXldID0gb3ZlcnJpZGVWYWx1ZTtcblx0XHR9XG5cdH1cblxuXHRyZXR1cm4gcmVzdWx0O1xufVxuXG5leHBvcnQgdHlwZSBTZXR0aW5nc1Njb3BlID0gXCJnbG9iYWxcIiB8IFwicHJvamVjdFwiO1xuXG5leHBvcnQgaW50ZXJmYWNlIFNldHRpbmdzU3RvcmFnZSB7XG5cdHdpdGhMb2NrKHNjb3BlOiBTZXR0aW5nc1Njb3BlLCBmbjogKGN1cnJlbnQ6IHN0cmluZyB8IHVuZGVmaW5lZCkgPT4gc3RyaW5nIHwgdW5kZWZpbmVkKTogdm9pZDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBTZXR0aW5nc0Vycm9yIHtcblx0c2NvcGU6IFNldHRpbmdzU2NvcGU7XG5cdGVycm9yOiBFcnJvcjtcbn1cblxuY2xhc3MgRmlsZVNldHRpbmdzU3RvcmFnZSBpbXBsZW1lbnRzIFNldHRpbmdzU3RvcmFnZSB7XG5cdHByaXZhdGUgZ2xvYmFsU2V0dGluZ3NQYXRoOiBzdHJpbmc7XG5cdHByaXZhdGUgcHJvamVjdFNldHRpbmdzUGF0aDogc3RyaW5nO1xuXG5cdGNvbnN0cnVjdG9yKGN3ZDogc3RyaW5nID0gcHJvY2Vzcy5jd2QoKSwgYWdlbnREaXI6IHN0cmluZyA9IGdldEFnZW50RGlyKCkpIHtcblx0XHR0aGlzLmdsb2JhbFNldHRpbmdzUGF0aCA9IGpvaW4oYWdlbnREaXIsIFwic2V0dGluZ3MuanNvblwiKTtcblx0XHR0aGlzLnByb2plY3RTZXR0aW5nc1BhdGggPSBqb2luKGN3ZCwgQ09ORklHX0RJUl9OQU1FLCBcInNldHRpbmdzLmpzb25cIik7XG5cdH1cblxuXHRwcml2YXRlIGFjcXVpcmVMb2NrU3luY1dpdGhSZXRyeShwYXRoOiBzdHJpbmcpOiAoKSA9PiB2b2lkIHtcblx0XHRjb25zdCBtYXhBdHRlbXB0cyA9IDEwO1xuXHRcdGNvbnN0IGRlbGF5TXMgPSAyMDtcblx0XHRsZXQgbGFzdEVycm9yOiB1bmtub3duO1xuXG5cdFx0Zm9yIChsZXQgYXR0ZW1wdCA9IDE7IGF0dGVtcHQgPD0gbWF4QXR0ZW1wdHM7IGF0dGVtcHQrKykge1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0cmV0dXJuIGxvY2tmaWxlLmxvY2tTeW5jKHBhdGgsIHsgcmVhbHBhdGg6IGZhbHNlIH0pO1xuXHRcdFx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRcdFx0Y29uc3QgY29kZSA9XG5cdFx0XHRcdFx0dHlwZW9mIGVycm9yID09PSBcIm9iamVjdFwiICYmIGVycm9yICE9PSBudWxsICYmIFwiY29kZVwiIGluIGVycm9yXG5cdFx0XHRcdFx0XHQ/IFN0cmluZygoZXJyb3IgYXMgeyBjb2RlPzogdW5rbm93biB9KS5jb2RlKVxuXHRcdFx0XHRcdFx0OiB1bmRlZmluZWQ7XG5cdFx0XHRcdGlmIChjb2RlICE9PSBcIkVMT0NLRURcIiB8fCBhdHRlbXB0ID09PSBtYXhBdHRlbXB0cykge1xuXHRcdFx0XHRcdHRocm93IGVycm9yO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGxhc3RFcnJvciA9IGVycm9yO1xuXHRcdFx0XHRjb25zdCBzdGFydCA9IERhdGUubm93KCk7XG5cdFx0XHRcdHdoaWxlIChEYXRlLm5vdygpIC0gc3RhcnQgPCBkZWxheU1zKSB7XG5cdFx0XHRcdFx0Ly8gU2xlZXAgc3luY2hyb25vdXNseSB0byBhdm9pZCBjaGFuZ2luZyBjYWxsZXJzIHRvIGFzeW5jLlxuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0dGhyb3cgKGxhc3RFcnJvciBhcyBFcnJvcikgPz8gbmV3IEVycm9yKFwiRmFpbGVkIHRvIGFjcXVpcmUgc2V0dGluZ3MgbG9ja1wiKTtcblx0fVxuXG5cdHdpdGhMb2NrKHNjb3BlOiBTZXR0aW5nc1Njb3BlLCBmbjogKGN1cnJlbnQ6IHN0cmluZyB8IHVuZGVmaW5lZCkgPT4gc3RyaW5nIHwgdW5kZWZpbmVkKTogdm9pZCB7XG5cdFx0Y29uc3QgcGF0aCA9IHNjb3BlID09PSBcImdsb2JhbFwiID8gdGhpcy5nbG9iYWxTZXR0aW5nc1BhdGggOiB0aGlzLnByb2plY3RTZXR0aW5nc1BhdGg7XG5cdFx0Y29uc3QgZGlyID0gZGlybmFtZShwYXRoKTtcblxuXHRcdGxldCByZWxlYXNlOiAoKCkgPT4gdm9pZCkgfCB1bmRlZmluZWQ7XG5cdFx0dHJ5IHtcblx0XHRcdC8vIE9ubHkgY3JlYXRlIGRpcmVjdG9yeSBhbmQgbG9jayBpZiBmaWxlIGV4aXN0cyBvciB3ZSBuZWVkIHRvIHdyaXRlXG5cdFx0XHRjb25zdCBmaWxlRXhpc3RzID0gZXhpc3RzU3luYyhwYXRoKTtcblx0XHRcdGlmIChmaWxlRXhpc3RzKSB7XG5cdFx0XHRcdHJlbGVhc2UgPSB0aGlzLmFjcXVpcmVMb2NrU3luY1dpdGhSZXRyeShwYXRoKTtcblx0XHRcdH1cblx0XHRcdGNvbnN0IGN1cnJlbnQgPSBmaWxlRXhpc3RzID8gcmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmLThcIikgOiB1bmRlZmluZWQ7XG5cdFx0XHRjb25zdCBuZXh0ID0gZm4oY3VycmVudCk7XG5cdFx0XHRpZiAobmV4dCAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0XHRcdC8vIE9ubHkgY3JlYXRlIGRpcmVjdG9yeSB3aGVuIHdlIGFjdHVhbGx5IG5lZWQgdG8gd3JpdGVcblx0XHRcdFx0aWYgKCFleGlzdHNTeW5jKGRpcikpIHtcblx0XHRcdFx0XHRta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblx0XHRcdFx0fVxuXHRcdFx0XHRpZiAoIXJlbGVhc2UpIHtcblx0XHRcdFx0XHRyZWxlYXNlID0gdGhpcy5hY3F1aXJlTG9ja1N5bmNXaXRoUmV0cnkocGF0aCk7XG5cdFx0XHRcdH1cblx0XHRcdFx0d3JpdGVGaWxlU3luYyhwYXRoLCBuZXh0LCBcInV0Zi04XCIpO1xuXHRcdFx0fVxuXHRcdH0gZmluYWxseSB7XG5cdFx0XHRpZiAocmVsZWFzZSkge1xuXHRcdFx0XHRyZWxlYXNlKCk7XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG59XG5cbmNsYXNzIEluTWVtb3J5U2V0dGluZ3NTdG9yYWdlIGltcGxlbWVudHMgU2V0dGluZ3NTdG9yYWdlIHtcblx0cHJpdmF0ZSBnbG9iYWw6IHN0cmluZyB8IHVuZGVmaW5lZDtcblx0cHJpdmF0ZSBwcm9qZWN0OiBzdHJpbmcgfCB1bmRlZmluZWQ7XG5cblx0d2l0aExvY2soc2NvcGU6IFNldHRpbmdzU2NvcGUsIGZuOiAoY3VycmVudDogc3RyaW5nIHwgdW5kZWZpbmVkKSA9PiBzdHJpbmcgfCB1bmRlZmluZWQpOiB2b2lkIHtcblx0XHRjb25zdCBjdXJyZW50ID0gc2NvcGUgPT09IFwiZ2xvYmFsXCIgPyB0aGlzLmdsb2JhbCA6IHRoaXMucHJvamVjdDtcblx0XHRjb25zdCBuZXh0ID0gZm4oY3VycmVudCk7XG5cdFx0aWYgKG5leHQgIT09IHVuZGVmaW5lZCkge1xuXHRcdFx0aWYgKHNjb3BlID09PSBcImdsb2JhbFwiKSB7XG5cdFx0XHRcdHRoaXMuZ2xvYmFsID0gbmV4dDtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdHRoaXMucHJvamVjdCA9IG5leHQ7XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG59XG5cbmV4cG9ydCBjbGFzcyBTZXR0aW5nc01hbmFnZXIge1xuXHRwcml2YXRlIHN0b3JhZ2U6IFNldHRpbmdzU3RvcmFnZTtcblx0cHJpdmF0ZSBnbG9iYWxTZXR0aW5nczogU2V0dGluZ3M7XG5cdHByaXZhdGUgcHJvamVjdFNldHRpbmdzOiBTZXR0aW5ncztcblx0cHJpdmF0ZSBzZXR0aW5nczogU2V0dGluZ3M7XG5cdHByaXZhdGUgbW9kaWZpZWRGaWVsZHMgPSBuZXcgU2V0PGtleW9mIFNldHRpbmdzPigpOyAvLyBUcmFjayBnbG9iYWwgZmllbGRzIG1vZGlmaWVkIGR1cmluZyBzZXNzaW9uXG5cdHByaXZhdGUgbW9kaWZpZWROZXN0ZWRGaWVsZHMgPSBuZXcgTWFwPGtleW9mIFNldHRpbmdzLCBTZXQ8c3RyaW5nPj4oKTsgLy8gVHJhY2sgZ2xvYmFsIG5lc3RlZCBmaWVsZCBtb2RpZmljYXRpb25zXG5cdHByaXZhdGUgbW9kaWZpZWRQcm9qZWN0RmllbGRzID0gbmV3IFNldDxrZXlvZiBTZXR0aW5ncz4oKTsgLy8gVHJhY2sgcHJvamVjdCBmaWVsZHMgbW9kaWZpZWQgZHVyaW5nIHNlc3Npb25cblx0cHJpdmF0ZSBtb2RpZmllZFByb2plY3ROZXN0ZWRGaWVsZHMgPSBuZXcgTWFwPGtleW9mIFNldHRpbmdzLCBTZXQ8c3RyaW5nPj4oKTsgLy8gVHJhY2sgcHJvamVjdCBuZXN0ZWQgZmllbGQgbW9kaWZpY2F0aW9uc1xuXHRwcml2YXRlIGdsb2JhbFNldHRpbmdzTG9hZEVycm9yOiBFcnJvciB8IG51bGwgPSBudWxsOyAvLyBUcmFjayBpZiBnbG9iYWwgc2V0dGluZ3MgZmlsZSBoYWQgcGFyc2UgZXJyb3JzXG5cdHByaXZhdGUgcHJvamVjdFNldHRpbmdzTG9hZEVycm9yOiBFcnJvciB8IG51bGwgPSBudWxsOyAvLyBUcmFjayBpZiBwcm9qZWN0IHNldHRpbmdzIGZpbGUgaGFkIHBhcnNlIGVycm9yc1xuXHRwcml2YXRlIHdyaXRlUXVldWU6IFByb21pc2U8dm9pZD4gPSBQcm9taXNlLnJlc29sdmUoKTtcblx0cHJpdmF0ZSBlcnJvcnM6IFNldHRpbmdzRXJyb3JbXTtcblxuXHRwcml2YXRlIGNvbnN0cnVjdG9yKFxuXHRcdHN0b3JhZ2U6IFNldHRpbmdzU3RvcmFnZSxcblx0XHRpbml0aWFsR2xvYmFsOiBTZXR0aW5ncyxcblx0XHRpbml0aWFsUHJvamVjdDogU2V0dGluZ3MsXG5cdFx0Z2xvYmFsTG9hZEVycm9yOiBFcnJvciB8IG51bGwgPSBudWxsLFxuXHRcdHByb2plY3RMb2FkRXJyb3I6IEVycm9yIHwgbnVsbCA9IG51bGwsXG5cdFx0aW5pdGlhbEVycm9yczogU2V0dGluZ3NFcnJvcltdID0gW10sXG5cdCkge1xuXHRcdHRoaXMuc3RvcmFnZSA9IHN0b3JhZ2U7XG5cdFx0dGhpcy5nbG9iYWxTZXR0aW5ncyA9IGluaXRpYWxHbG9iYWw7XG5cdFx0dGhpcy5wcm9qZWN0U2V0dGluZ3MgPSBzdHJpcEdsb2JhbE9ubHlLZXlzKGluaXRpYWxQcm9qZWN0KTtcblx0XHR0aGlzLmdsb2JhbFNldHRpbmdzTG9hZEVycm9yID0gZ2xvYmFsTG9hZEVycm9yO1xuXHRcdHRoaXMucHJvamVjdFNldHRpbmdzTG9hZEVycm9yID0gcHJvamVjdExvYWRFcnJvcjtcblx0XHR0aGlzLmVycm9ycyA9IFsuLi5pbml0aWFsRXJyb3JzXTtcblx0XHR0aGlzLnNldHRpbmdzID0gZGVlcE1lcmdlU2V0dGluZ3ModGhpcy5nbG9iYWxTZXR0aW5ncywgdGhpcy5wcm9qZWN0U2V0dGluZ3MpO1xuXHR9XG5cblx0LyoqIENyZWF0ZSBhIFNldHRpbmdzTWFuYWdlciB0aGF0IGxvYWRzIGZyb20gZmlsZXMgKi9cblx0c3RhdGljIGNyZWF0ZShjd2Q6IHN0cmluZyA9IHByb2Nlc3MuY3dkKCksIGFnZW50RGlyOiBzdHJpbmcgPSBnZXRBZ2VudERpcigpKTogU2V0dGluZ3NNYW5hZ2VyIHtcblx0XHRjb25zdCBzdG9yYWdlID0gbmV3IEZpbGVTZXR0aW5nc1N0b3JhZ2UoY3dkLCBhZ2VudERpcik7XG5cdFx0cmV0dXJuIFNldHRpbmdzTWFuYWdlci5mcm9tU3RvcmFnZShzdG9yYWdlKTtcblx0fVxuXG5cdC8qKiBDcmVhdGUgYSBTZXR0aW5nc01hbmFnZXIgZnJvbSBhbiBhcmJpdHJhcnkgc3RvcmFnZSBiYWNrZW5kICovXG5cdHN0YXRpYyBmcm9tU3RvcmFnZShzdG9yYWdlOiBTZXR0aW5nc1N0b3JhZ2UpOiBTZXR0aW5nc01hbmFnZXIge1xuXHRcdGNvbnN0IGdsb2JhbExvYWQgPSBTZXR0aW5nc01hbmFnZXIudHJ5TG9hZEZyb21TdG9yYWdlKHN0b3JhZ2UsIFwiZ2xvYmFsXCIpO1xuXHRcdGNvbnN0IHByb2plY3RMb2FkID0gU2V0dGluZ3NNYW5hZ2VyLnRyeUxvYWRGcm9tU3RvcmFnZShzdG9yYWdlLCBcInByb2plY3RcIik7XG5cdFx0Y29uc3QgaW5pdGlhbEVycm9yczogU2V0dGluZ3NFcnJvcltdID0gW107XG5cdFx0aWYgKGdsb2JhbExvYWQuZXJyb3IpIHtcblx0XHRcdGluaXRpYWxFcnJvcnMucHVzaCh7IHNjb3BlOiBcImdsb2JhbFwiLCBlcnJvcjogZ2xvYmFsTG9hZC5lcnJvciB9KTtcblx0XHR9XG5cdFx0aWYgKHByb2plY3RMb2FkLmVycm9yKSB7XG5cdFx0XHRpbml0aWFsRXJyb3JzLnB1c2goeyBzY29wZTogXCJwcm9qZWN0XCIsIGVycm9yOiBwcm9qZWN0TG9hZC5lcnJvciB9KTtcblx0XHR9XG5cblx0XHRyZXR1cm4gbmV3IFNldHRpbmdzTWFuYWdlcihcblx0XHRcdHN0b3JhZ2UsXG5cdFx0XHRnbG9iYWxMb2FkLnNldHRpbmdzLFxuXHRcdFx0cHJvamVjdExvYWQuc2V0dGluZ3MsXG5cdFx0XHRnbG9iYWxMb2FkLmVycm9yLFxuXHRcdFx0cHJvamVjdExvYWQuZXJyb3IsXG5cdFx0XHRpbml0aWFsRXJyb3JzLFxuXHRcdCk7XG5cdH1cblxuXHQvKiogQ3JlYXRlIGFuIGluLW1lbW9yeSBTZXR0aW5nc01hbmFnZXIgKG5vIGZpbGUgSS9PKSAqL1xuXHRzdGF0aWMgaW5NZW1vcnkoc2V0dGluZ3M6IFBhcnRpYWw8U2V0dGluZ3M+ID0ge30pOiBTZXR0aW5nc01hbmFnZXIge1xuXHRcdGNvbnN0IHN0b3JhZ2UgPSBuZXcgSW5NZW1vcnlTZXR0aW5nc1N0b3JhZ2UoKTtcblx0XHRyZXR1cm4gbmV3IFNldHRpbmdzTWFuYWdlcihzdG9yYWdlLCBzZXR0aW5ncywge30pO1xuXHR9XG5cblx0cHJpdmF0ZSBzdGF0aWMgbG9hZEZyb21TdG9yYWdlKHN0b3JhZ2U6IFNldHRpbmdzU3RvcmFnZSwgc2NvcGU6IFNldHRpbmdzU2NvcGUpOiBTZXR0aW5ncyB7XG5cdFx0bGV0IGNvbnRlbnQ6IHN0cmluZyB8IHVuZGVmaW5lZDtcblx0XHRzdG9yYWdlLndpdGhMb2NrKHNjb3BlLCAoY3VycmVudCkgPT4ge1xuXHRcdFx0Y29udGVudCA9IGN1cnJlbnQ7XG5cdFx0XHRyZXR1cm4gdW5kZWZpbmVkO1xuXHRcdH0pO1xuXG5cdFx0aWYgKCFjb250ZW50KSB7XG5cdFx0XHRyZXR1cm4ge307XG5cdFx0fVxuXHRcdGNvbnN0IHNldHRpbmdzID0gSlNPTi5wYXJzZShjb250ZW50KTtcblx0XHRyZXR1cm4gU2V0dGluZ3NNYW5hZ2VyLm1pZ3JhdGVTZXR0aW5ncyhzZXR0aW5ncyk7XG5cdH1cblxuXHRwcml2YXRlIHN0YXRpYyB0cnlMb2FkRnJvbVN0b3JhZ2UoXG5cdFx0c3RvcmFnZTogU2V0dGluZ3NTdG9yYWdlLFxuXHRcdHNjb3BlOiBTZXR0aW5nc1Njb3BlLFxuXHQpOiB7IHNldHRpbmdzOiBTZXR0aW5nczsgZXJyb3I6IEVycm9yIHwgbnVsbCB9IHtcblx0XHR0cnkge1xuXHRcdFx0cmV0dXJuIHsgc2V0dGluZ3M6IFNldHRpbmdzTWFuYWdlci5sb2FkRnJvbVN0b3JhZ2Uoc3RvcmFnZSwgc2NvcGUpLCBlcnJvcjogbnVsbCB9O1xuXHRcdH0gY2F0Y2ggKGVycm9yKSB7XG5cdFx0XHRyZXR1cm4geyBzZXR0aW5nczoge30sIGVycm9yOiBlcnJvciBhcyBFcnJvciB9O1xuXHRcdH1cblx0fVxuXG5cdC8qKiBNaWdyYXRlIG9sZCBzZXR0aW5ncyBmb3JtYXQgdG8gbmV3IGZvcm1hdCAqL1xuXHRwcml2YXRlIHN0YXRpYyBtaWdyYXRlU2V0dGluZ3Moc2V0dGluZ3M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogU2V0dGluZ3Mge1xuXHRcdC8vIE1pZ3JhdGUgcXVldWVNb2RlIC0+IHN0ZWVyaW5nTW9kZVxuXHRcdGlmIChcInF1ZXVlTW9kZVwiIGluIHNldHRpbmdzICYmICEoXCJzdGVlcmluZ01vZGVcIiBpbiBzZXR0aW5ncykpIHtcblx0XHRcdHNldHRpbmdzLnN0ZWVyaW5nTW9kZSA9IHNldHRpbmdzLnF1ZXVlTW9kZTtcblx0XHRcdGRlbGV0ZSBzZXR0aW5ncy5xdWV1ZU1vZGU7XG5cdFx0fVxuXG5cdFx0Ly8gTWlncmF0ZSBsZWdhY3kgd2Vic29ja2V0cyBib29sZWFuIC0+IHRyYW5zcG9ydCBlbnVtXG5cdFx0aWYgKCEoXCJ0cmFuc3BvcnRcIiBpbiBzZXR0aW5ncykgJiYgdHlwZW9mIHNldHRpbmdzLndlYnNvY2tldHMgPT09IFwiYm9vbGVhblwiKSB7XG5cdFx0XHRzZXR0aW5ncy50cmFuc3BvcnQgPSBzZXR0aW5ncy53ZWJzb2NrZXRzID8gXCJ3ZWJzb2NrZXRcIiA6IFwic3NlXCI7XG5cdFx0XHRkZWxldGUgc2V0dGluZ3Mud2Vic29ja2V0cztcblx0XHR9XG5cblx0XHQvLyBNaWdyYXRlIG9sZCBza2lsbHMgb2JqZWN0IGZvcm1hdCB0byBuZXcgYXJyYXkgZm9ybWF0XG5cdFx0aWYgKFxuXHRcdFx0XCJza2lsbHNcIiBpbiBzZXR0aW5ncyAmJlxuXHRcdFx0dHlwZW9mIHNldHRpbmdzLnNraWxscyA9PT0gXCJvYmplY3RcIiAmJlxuXHRcdFx0c2V0dGluZ3Muc2tpbGxzICE9PSBudWxsICYmXG5cdFx0XHQhQXJyYXkuaXNBcnJheShzZXR0aW5ncy5za2lsbHMpXG5cdFx0KSB7XG5cdFx0XHRjb25zdCBza2lsbHNTZXR0aW5ncyA9IHNldHRpbmdzLnNraWxscyBhcyB7XG5cdFx0XHRcdGVuYWJsZVNraWxsQ29tbWFuZHM/OiBib29sZWFuO1xuXHRcdFx0XHRjdXN0b21EaXJlY3Rvcmllcz86IHVua25vd247XG5cdFx0XHR9O1xuXHRcdFx0aWYgKHNraWxsc1NldHRpbmdzLmVuYWJsZVNraWxsQ29tbWFuZHMgIT09IHVuZGVmaW5lZCAmJiBzZXR0aW5ncy5lbmFibGVTa2lsbENvbW1hbmRzID09PSB1bmRlZmluZWQpIHtcblx0XHRcdFx0c2V0dGluZ3MuZW5hYmxlU2tpbGxDb21tYW5kcyA9IHNraWxsc1NldHRpbmdzLmVuYWJsZVNraWxsQ29tbWFuZHM7XG5cdFx0XHR9XG5cdFx0XHRpZiAoQXJyYXkuaXNBcnJheShza2lsbHNTZXR0aW5ncy5jdXN0b21EaXJlY3RvcmllcykgJiYgc2tpbGxzU2V0dGluZ3MuY3VzdG9tRGlyZWN0b3JpZXMubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRzZXR0aW5ncy5za2lsbHMgPSBza2lsbHNTZXR0aW5ncy5jdXN0b21EaXJlY3Rvcmllcztcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdGRlbGV0ZSBzZXR0aW5ncy5za2lsbHM7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0cmV0dXJuIHNldHRpbmdzIGFzIFNldHRpbmdzO1xuXHR9XG5cblx0Z2V0R2xvYmFsU2V0dGluZ3MoKTogU2V0dGluZ3Mge1xuXHRcdHJldHVybiBzdHJ1Y3R1cmVkQ2xvbmUodGhpcy5nbG9iYWxTZXR0aW5ncyk7XG5cdH1cblxuXHRnZXRQcm9qZWN0U2V0dGluZ3MoKTogU2V0dGluZ3Mge1xuXHRcdHJldHVybiBzdHJ1Y3R1cmVkQ2xvbmUodGhpcy5wcm9qZWN0U2V0dGluZ3MpO1xuXHR9XG5cblx0Z2V0QmFzaEludGVyY2VwdG9yRW5hYmxlZCgpOiBib29sZWFuIHtcblx0XHRyZXR1cm4gdGhpcy5zZXR0aW5ncy5iYXNoSW50ZXJjZXB0b3I/LmVuYWJsZWQgPz8gdHJ1ZTtcblx0fVxuXG5cdGdldEJhc2hJbnRlcmNlcHRvclJ1bGVzKCk6IEJhc2hJbnRlcmNlcHRvclJ1bGVbXSB8IHVuZGVmaW5lZCB7XG5cdFx0cmV0dXJuIHRoaXMuc2V0dGluZ3MuYmFzaEludGVyY2VwdG9yPy5ydWxlcztcblx0fVxuXG5cdHJlbG9hZCgpOiB2b2lkIHtcblx0XHRjb25zdCBnbG9iYWxMb2FkID0gU2V0dGluZ3NNYW5hZ2VyLnRyeUxvYWRGcm9tU3RvcmFnZSh0aGlzLnN0b3JhZ2UsIFwiZ2xvYmFsXCIpO1xuXHRcdGlmICghZ2xvYmFsTG9hZC5lcnJvcikge1xuXHRcdFx0dGhpcy5nbG9iYWxTZXR0aW5ncyA9IGdsb2JhbExvYWQuc2V0dGluZ3M7XG5cdFx0XHR0aGlzLmdsb2JhbFNldHRpbmdzTG9hZEVycm9yID0gbnVsbDtcblx0XHR9IGVsc2Uge1xuXHRcdFx0dGhpcy5nbG9iYWxTZXR0aW5nc0xvYWRFcnJvciA9IGdsb2JhbExvYWQuZXJyb3I7XG5cdFx0XHR0aGlzLnJlY29yZEVycm9yKFwiZ2xvYmFsXCIsIGdsb2JhbExvYWQuZXJyb3IpO1xuXHRcdH1cblxuXHRcdHRoaXMubW9kaWZpZWRGaWVsZHMuY2xlYXIoKTtcblx0XHR0aGlzLm1vZGlmaWVkTmVzdGVkRmllbGRzLmNsZWFyKCk7XG5cdFx0dGhpcy5tb2RpZmllZFByb2plY3RGaWVsZHMuY2xlYXIoKTtcblx0XHR0aGlzLm1vZGlmaWVkUHJvamVjdE5lc3RlZEZpZWxkcy5jbGVhcigpO1xuXG5cdFx0Y29uc3QgcHJvamVjdExvYWQgPSBTZXR0aW5nc01hbmFnZXIudHJ5TG9hZEZyb21TdG9yYWdlKHRoaXMuc3RvcmFnZSwgXCJwcm9qZWN0XCIpO1xuXHRcdGlmICghcHJvamVjdExvYWQuZXJyb3IpIHtcblx0XHRcdHRoaXMucHJvamVjdFNldHRpbmdzID0gc3RyaXBHbG9iYWxPbmx5S2V5cyhwcm9qZWN0TG9hZC5zZXR0aW5ncyk7XG5cdFx0XHR0aGlzLnByb2plY3RTZXR0aW5nc0xvYWRFcnJvciA9IG51bGw7XG5cdFx0fSBlbHNlIHtcblx0XHRcdHRoaXMucHJvamVjdFNldHRpbmdzTG9hZEVycm9yID0gcHJvamVjdExvYWQuZXJyb3I7XG5cdFx0XHR0aGlzLnJlY29yZEVycm9yKFwicHJvamVjdFwiLCBwcm9qZWN0TG9hZC5lcnJvcik7XG5cdFx0fVxuXG5cdFx0dGhpcy5zZXR0aW5ncyA9IGRlZXBNZXJnZVNldHRpbmdzKHRoaXMuZ2xvYmFsU2V0dGluZ3MsIHRoaXMucHJvamVjdFNldHRpbmdzKTtcblx0fVxuXG5cdC8qKiBBcHBseSBhZGRpdGlvbmFsIG92ZXJyaWRlcyBvbiB0b3Agb2YgY3VycmVudCBzZXR0aW5ncyAqL1xuXHRhcHBseU92ZXJyaWRlcyhvdmVycmlkZXM6IFBhcnRpYWw8U2V0dGluZ3M+KTogdm9pZCB7XG5cdFx0dGhpcy5zZXR0aW5ncyA9IGRlZXBNZXJnZVNldHRpbmdzKHRoaXMuc2V0dGluZ3MsIG92ZXJyaWRlcyk7XG5cdH1cblxuXHQvKiogTWFyayBhIGdsb2JhbCBmaWVsZCBhcyBtb2RpZmllZCBkdXJpbmcgdGhpcyBzZXNzaW9uICovXG5cdHByaXZhdGUgbWFya01vZGlmaWVkKGZpZWxkOiBrZXlvZiBTZXR0aW5ncywgbmVzdGVkS2V5Pzogc3RyaW5nKTogdm9pZCB7XG5cdFx0dGhpcy5tb2RpZmllZEZpZWxkcy5hZGQoZmllbGQpO1xuXHRcdGlmIChuZXN0ZWRLZXkpIHtcblx0XHRcdGlmICghdGhpcy5tb2RpZmllZE5lc3RlZEZpZWxkcy5oYXMoZmllbGQpKSB7XG5cdFx0XHRcdHRoaXMubW9kaWZpZWROZXN0ZWRGaWVsZHMuc2V0KGZpZWxkLCBuZXcgU2V0KCkpO1xuXHRcdFx0fVxuXHRcdFx0dGhpcy5tb2RpZmllZE5lc3RlZEZpZWxkcy5nZXQoZmllbGQpIS5hZGQobmVzdGVkS2V5KTtcblx0XHR9XG5cdH1cblxuXHQvKiogTWFyayBhIHByb2plY3QgZmllbGQgYXMgbW9kaWZpZWQgZHVyaW5nIHRoaXMgc2Vzc2lvbiAqL1xuXHRwcml2YXRlIG1hcmtQcm9qZWN0TW9kaWZpZWQoZmllbGQ6IGtleW9mIFNldHRpbmdzLCBuZXN0ZWRLZXk/OiBzdHJpbmcpOiB2b2lkIHtcblx0XHR0aGlzLm1vZGlmaWVkUHJvamVjdEZpZWxkcy5hZGQoZmllbGQpO1xuXHRcdGlmIChuZXN0ZWRLZXkpIHtcblx0XHRcdGlmICghdGhpcy5tb2RpZmllZFByb2plY3ROZXN0ZWRGaWVsZHMuaGFzKGZpZWxkKSkge1xuXHRcdFx0XHR0aGlzLm1vZGlmaWVkUHJvamVjdE5lc3RlZEZpZWxkcy5zZXQoZmllbGQsIG5ldyBTZXQoKSk7XG5cdFx0XHR9XG5cdFx0XHR0aGlzLm1vZGlmaWVkUHJvamVjdE5lc3RlZEZpZWxkcy5nZXQoZmllbGQpIS5hZGQobmVzdGVkS2V5KTtcblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIHJlY29yZEVycm9yKHNjb3BlOiBTZXR0aW5nc1Njb3BlLCBlcnJvcjogdW5rbm93bik6IHZvaWQge1xuXHRcdGNvbnN0IG5vcm1hbGl6ZWRFcnJvciA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvciA6IG5ldyBFcnJvcihTdHJpbmcoZXJyb3IpKTtcblx0XHR0aGlzLmVycm9ycy5wdXNoKHsgc2NvcGUsIGVycm9yOiBub3JtYWxpemVkRXJyb3IgfSk7XG5cdH1cblxuXHQvKipcblx0ICogQ2hlY2sgaWYgcHJvamVjdC1sZXZlbCBzZXR0aW5ncyBhcmUgYWN0aXZlIChsb2FkZWQgZnJvbSBhIGZpbGUpLlxuXHQgKiBVc2VkIHRvIHNjb3BlIG1vZGVsIHBlcnNpc3RlbmNlIHRvIHRoZSBwcm9qZWN0IHdoZW4gcG9zc2libGUsXG5cdCAqIHByZXZlbnRpbmcgbW9kZWwgY29uZmlnIGJsZWVkIGJldHdlZW4gY29uY3VycmVudCBpbnN0YW5jZXMgKCM2NTApLlxuXHQgKi9cblx0cHJpdmF0ZSBoYXNQcm9qZWN0U2V0dGluZ3MoKTogYm9vbGVhbiB7XG5cdFx0Ly8gUHJvamVjdCBzZXR0aW5ncyBhcmUgYWN0aXZlIGlmIHdlIGxvYWRlZCB0aGVtIGFuZCB0aGV5IHdlcmVuJ3QgZW1wdHkvZXJyb3JlZFxuXHRcdHJldHVybiAhdGhpcy5wcm9qZWN0U2V0dGluZ3NMb2FkRXJyb3IgJiYgT2JqZWN0LmtleXModGhpcy5wcm9qZWN0U2V0dGluZ3MpLmxlbmd0aCA+IDA7XG5cdH1cblxuXHRwcml2YXRlIGNsZWFyTW9kaWZpZWRTY29wZShzY29wZTogU2V0dGluZ3NTY29wZSk6IHZvaWQge1xuXHRcdGlmIChzY29wZSA9PT0gXCJnbG9iYWxcIikge1xuXHRcdFx0dGhpcy5tb2RpZmllZEZpZWxkcy5jbGVhcigpO1xuXHRcdFx0dGhpcy5tb2RpZmllZE5lc3RlZEZpZWxkcy5jbGVhcigpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdHRoaXMubW9kaWZpZWRQcm9qZWN0RmllbGRzLmNsZWFyKCk7XG5cdFx0dGhpcy5tb2RpZmllZFByb2plY3ROZXN0ZWRGaWVsZHMuY2xlYXIoKTtcblx0fVxuXG5cdHByaXZhdGUgZW5xdWV1ZVdyaXRlKHNjb3BlOiBTZXR0aW5nc1Njb3BlLCB0YXNrOiAoKSA9PiB2b2lkKTogdm9pZCB7XG5cdFx0dGhpcy53cml0ZVF1ZXVlID0gdGhpcy53cml0ZVF1ZXVlXG5cdFx0XHQudGhlbigoKSA9PiB7XG5cdFx0XHRcdHRhc2soKTtcblx0XHRcdFx0dGhpcy5jbGVhck1vZGlmaWVkU2NvcGUoc2NvcGUpO1xuXHRcdFx0fSlcblx0XHRcdC5jYXRjaCgoZXJyb3IpID0+IHtcblx0XHRcdFx0dGhpcy5yZWNvcmRFcnJvcihzY29wZSwgZXJyb3IpO1xuXHRcdFx0fSk7XG5cdH1cblxuXHRwcml2YXRlIGNsb25lTW9kaWZpZWROZXN0ZWRGaWVsZHMoc291cmNlOiBNYXA8a2V5b2YgU2V0dGluZ3MsIFNldDxzdHJpbmc+Pik6IE1hcDxrZXlvZiBTZXR0aW5ncywgU2V0PHN0cmluZz4+IHtcblx0XHRjb25zdCBzbmFwc2hvdCA9IG5ldyBNYXA8a2V5b2YgU2V0dGluZ3MsIFNldDxzdHJpbmc+PigpO1xuXHRcdGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIHNvdXJjZS5lbnRyaWVzKCkpIHtcblx0XHRcdHNuYXBzaG90LnNldChrZXksIG5ldyBTZXQodmFsdWUpKTtcblx0XHR9XG5cdFx0cmV0dXJuIHNuYXBzaG90O1xuXHR9XG5cblx0cHJpdmF0ZSBwZXJzaXN0U2NvcGVkU2V0dGluZ3MoXG5cdFx0c2NvcGU6IFNldHRpbmdzU2NvcGUsXG5cdFx0c25hcHNob3RTZXR0aW5nczogU2V0dGluZ3MsXG5cdFx0bW9kaWZpZWRGaWVsZHM6IFNldDxrZXlvZiBTZXR0aW5ncz4sXG5cdFx0bW9kaWZpZWROZXN0ZWRGaWVsZHM6IE1hcDxrZXlvZiBTZXR0aW5ncywgU2V0PHN0cmluZz4+LFxuXHQpOiB2b2lkIHtcblx0XHR0aGlzLnN0b3JhZ2Uud2l0aExvY2soc2NvcGUsIChjdXJyZW50KSA9PiB7XG5cdFx0XHRjb25zdCBjdXJyZW50RmlsZVNldHRpbmdzID0gY3VycmVudFxuXHRcdFx0XHQ/IFNldHRpbmdzTWFuYWdlci5taWdyYXRlU2V0dGluZ3MoSlNPTi5wYXJzZShjdXJyZW50KSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPilcblx0XHRcdFx0OiB7fTtcblx0XHRcdGNvbnN0IG1lcmdlZFNldHRpbmdzOiBTZXR0aW5ncyA9IHsgLi4uY3VycmVudEZpbGVTZXR0aW5ncyB9O1xuXHRcdFx0Zm9yIChjb25zdCBmaWVsZCBvZiBtb2RpZmllZEZpZWxkcykge1xuXHRcdFx0XHRjb25zdCB2YWx1ZSA9IHNuYXBzaG90U2V0dGluZ3NbZmllbGRdO1xuXHRcdFx0XHRpZiAobW9kaWZpZWROZXN0ZWRGaWVsZHMuaGFzKGZpZWxkKSAmJiB0eXBlb2YgdmFsdWUgPT09IFwib2JqZWN0XCIgJiYgdmFsdWUgIT09IG51bGwpIHtcblx0XHRcdFx0XHRjb25zdCBuZXN0ZWRNb2RpZmllZCA9IG1vZGlmaWVkTmVzdGVkRmllbGRzLmdldChmaWVsZCkhO1xuXHRcdFx0XHRcdGNvbnN0IGJhc2VOZXN0ZWQgPSAoY3VycmVudEZpbGVTZXR0aW5nc1tmaWVsZF0gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID8/IHt9O1xuXHRcdFx0XHRcdGNvbnN0IGluTWVtb3J5TmVzdGVkID0gdmFsdWUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG5cdFx0XHRcdFx0Y29uc3QgbWVyZ2VkTmVzdGVkID0geyAuLi5iYXNlTmVzdGVkIH07XG5cdFx0XHRcdFx0Zm9yIChjb25zdCBuZXN0ZWRLZXkgb2YgbmVzdGVkTW9kaWZpZWQpIHtcblx0XHRcdFx0XHRcdG1lcmdlZE5lc3RlZFtuZXN0ZWRLZXldID0gaW5NZW1vcnlOZXN0ZWRbbmVzdGVkS2V5XTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0KG1lcmdlZFNldHRpbmdzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KVtmaWVsZF0gPSBtZXJnZWROZXN0ZWQ7XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0KG1lcmdlZFNldHRpbmdzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KVtmaWVsZF0gPSB2YWx1ZTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHRyZXR1cm4gSlNPTi5zdHJpbmdpZnkobWVyZ2VkU2V0dGluZ3MsIG51bGwsIDIpO1xuXHRcdH0pO1xuXHR9XG5cblx0cHJpdmF0ZSBzYXZlKCk6IHZvaWQge1xuXHRcdHRoaXMuc2V0dGluZ3MgPSBkZWVwTWVyZ2VTZXR0aW5ncyh0aGlzLmdsb2JhbFNldHRpbmdzLCB0aGlzLnByb2plY3RTZXR0aW5ncyk7XG5cblx0XHRpZiAodGhpcy5nbG9iYWxTZXR0aW5nc0xvYWRFcnJvcikge1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGNvbnN0IHNuYXBzaG90R2xvYmFsU2V0dGluZ3MgPSBzdHJ1Y3R1cmVkQ2xvbmUodGhpcy5nbG9iYWxTZXR0aW5ncyk7XG5cdFx0Y29uc3QgbW9kaWZpZWRGaWVsZHMgPSBuZXcgU2V0KHRoaXMubW9kaWZpZWRGaWVsZHMpO1xuXHRcdGNvbnN0IG1vZGlmaWVkTmVzdGVkRmllbGRzID0gdGhpcy5jbG9uZU1vZGlmaWVkTmVzdGVkRmllbGRzKHRoaXMubW9kaWZpZWROZXN0ZWRGaWVsZHMpO1xuXG5cdFx0dGhpcy5lbnF1ZXVlV3JpdGUoXCJnbG9iYWxcIiwgKCkgPT4ge1xuXHRcdFx0dGhpcy5wZXJzaXN0U2NvcGVkU2V0dGluZ3MoXCJnbG9iYWxcIiwgc25hcHNob3RHbG9iYWxTZXR0aW5ncywgbW9kaWZpZWRGaWVsZHMsIG1vZGlmaWVkTmVzdGVkRmllbGRzKTtcblx0XHR9KTtcblx0fVxuXG5cdHByaXZhdGUgc2F2ZVByb2plY3RTZXR0aW5ncyhzZXR0aW5nczogU2V0dGluZ3MpOiB2b2lkIHtcblx0XHR0aGlzLnByb2plY3RTZXR0aW5ncyA9IHN0cmlwR2xvYmFsT25seUtleXMoc3RydWN0dXJlZENsb25lKHNldHRpbmdzKSk7XG5cdFx0dGhpcy5zZXR0aW5ncyA9IGRlZXBNZXJnZVNldHRpbmdzKHRoaXMuZ2xvYmFsU2V0dGluZ3MsIHRoaXMucHJvamVjdFNldHRpbmdzKTtcblxuXHRcdGlmICh0aGlzLnByb2plY3RTZXR0aW5nc0xvYWRFcnJvcikge1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGNvbnN0IHNuYXBzaG90UHJvamVjdFNldHRpbmdzID0gc3RydWN0dXJlZENsb25lKHRoaXMucHJvamVjdFNldHRpbmdzKTtcblx0XHRjb25zdCBtb2RpZmllZEZpZWxkcyA9IG5ldyBTZXQodGhpcy5tb2RpZmllZFByb2plY3RGaWVsZHMpO1xuXHRcdGNvbnN0IG1vZGlmaWVkTmVzdGVkRmllbGRzID0gdGhpcy5jbG9uZU1vZGlmaWVkTmVzdGVkRmllbGRzKHRoaXMubW9kaWZpZWRQcm9qZWN0TmVzdGVkRmllbGRzKTtcblx0XHR0aGlzLmVucXVldWVXcml0ZShcInByb2plY3RcIiwgKCkgPT4ge1xuXHRcdFx0dGhpcy5wZXJzaXN0U2NvcGVkU2V0dGluZ3MoXCJwcm9qZWN0XCIsIHNuYXBzaG90UHJvamVjdFNldHRpbmdzLCBtb2RpZmllZEZpZWxkcywgbW9kaWZpZWROZXN0ZWRGaWVsZHMpO1xuXHRcdH0pO1xuXHR9XG5cblx0YXN5bmMgZmx1c2goKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0YXdhaXQgdGhpcy53cml0ZVF1ZXVlO1xuXHR9XG5cblx0ZHJhaW5FcnJvcnMoKTogU2V0dGluZ3NFcnJvcltdIHtcblx0XHRjb25zdCBkcmFpbmVkID0gWy4uLnRoaXMuZXJyb3JzXTtcblx0XHR0aGlzLmVycm9ycyA9IFtdO1xuXHRcdHJldHVybiBkcmFpbmVkO1xuXHR9XG5cblx0Ly8gXHUyNTAwXHUyNTAwIEdlbmVyaWMgc2V0dGVyIGhlbHBlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cblx0LyoqIFNldCBhIHRvcC1sZXZlbCBnbG9iYWwgc2V0dGluZyBmaWVsZCwgbWFyayBtb2RpZmllZCwgYW5kIHNhdmUuICovXG5cdHByaXZhdGUgc2V0R2xvYmFsU2V0dGluZzxLIGV4dGVuZHMga2V5b2YgU2V0dGluZ3M+KGtleTogSywgdmFsdWU6IFNldHRpbmdzW0tdKTogdm9pZCB7XG5cdFx0dGhpcy5nbG9iYWxTZXR0aW5nc1trZXldID0gdmFsdWU7XG5cdFx0dGhpcy5tYXJrTW9kaWZpZWQoa2V5KTtcblx0XHR0aGlzLnNhdmUoKTtcblx0fVxuXG5cdC8qKiBTZXQgYSB0b3AtbGV2ZWwgc2V0dGluZywgc2NvcGVkIHRvIHByb2plY3Qgd2hlbiBwcm9qZWN0IHNldHRpbmdzIGFyZSBhY3RpdmUuICovXG5cdHByaXZhdGUgc2V0U2NvcGVkU2V0dGluZzxLIGV4dGVuZHMga2V5b2YgU2V0dGluZ3M+KGtleTogSywgdmFsdWU6IFNldHRpbmdzW0tdKTogdm9pZCB7XG5cdFx0aWYgKHRoaXMuaGFzUHJvamVjdFNldHRpbmdzKCkpIHtcblx0XHRcdHRoaXMucHJvamVjdFNldHRpbmdzW2tleV0gPSB2YWx1ZTtcblx0XHRcdHRoaXMubWFya1Byb2plY3RNb2RpZmllZChrZXkpO1xuXHRcdFx0dGhpcy5zYXZlUHJvamVjdFNldHRpbmdzKHRoaXMucHJvamVjdFNldHRpbmdzKTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0dGhpcy5zZXRHbG9iYWxTZXR0aW5nKGtleSwgdmFsdWUpO1xuXHRcdH1cblx0fVxuXG5cdC8qKiBTZXQgYSBuZXN0ZWQgZmllbGQgd2l0aGluIGEgZ2xvYmFsIHNldHRpbmdzIG9iamVjdCAoZS5nLiBjb21wYWN0aW9uLmVuYWJsZWQpLiAqL1xuXHRwcml2YXRlIHNldE5lc3RlZEdsb2JhbFNldHRpbmc8SyBleHRlbmRzIGtleW9mIFNldHRpbmdzLCBOSyBleHRlbmRzIHN0cmluZyAmIGtleW9mIE5vbk51bGxhYmxlPFNldHRpbmdzW0tdPj4oXG5cdFx0a2V5OiBLLFxuXHRcdG5lc3RlZEtleTogTkssXG5cdFx0dmFsdWU6IE5vbk51bGxhYmxlPFNldHRpbmdzW0tdPltOS10sXG5cdCk6IHZvaWQge1xuXHRcdGlmICghdGhpcy5nbG9iYWxTZXR0aW5nc1trZXldKSB7XG5cdFx0XHQodGhpcy5nbG9iYWxTZXR0aW5ncyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPilba2V5XSA9IHt9O1xuXHRcdH1cblx0XHQodGhpcy5nbG9iYWxTZXR0aW5nc1trZXldIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KVtuZXN0ZWRLZXldID0gdmFsdWU7XG5cdFx0dGhpcy5tYXJrTW9kaWZpZWQoa2V5LCBuZXN0ZWRLZXkpO1xuXHRcdHRoaXMuc2F2ZSgpO1xuXHR9XG5cblx0LyoqIFNldCBhIGZpZWxkIG9uIHByb2plY3Qgc2V0dGluZ3MgKGNsb25lLCBzZXQsIG1hcmsgbW9kaWZpZWQsIHNhdmUpLiAqL1xuXHRwcml2YXRlIHNldFByb2plY3RTZXR0aW5nPEsgZXh0ZW5kcyBrZXlvZiBTZXR0aW5ncz4oa2V5OiBLLCB2YWx1ZTogU2V0dGluZ3NbS10pOiB2b2lkIHtcblx0XHRjb25zdCBwcm9qZWN0U2V0dGluZ3MgPSBzdHJ1Y3R1cmVkQ2xvbmUodGhpcy5wcm9qZWN0U2V0dGluZ3MpO1xuXHRcdHByb2plY3RTZXR0aW5nc1trZXldID0gdmFsdWU7XG5cdFx0dGhpcy5tYXJrUHJvamVjdE1vZGlmaWVkKGtleSk7XG5cdFx0dGhpcy5zYXZlUHJvamVjdFNldHRpbmdzKHByb2plY3RTZXR0aW5ncyk7XG5cdH1cblxuXHQvLyBcdTI1MDBcdTI1MDAgUHVibGljIGdldHRlcnMgYW5kIHNldHRlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cblx0Z2V0TGFzdENoYW5nZWxvZ1ZlcnNpb24oKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcblx0XHRyZXR1cm4gdGhpcy5zZXR0aW5ncy5sYXN0Q2hhbmdlbG9nVmVyc2lvbjtcblx0fVxuXG5cdHNldExhc3RDaGFuZ2Vsb2dWZXJzaW9uKHZlcnNpb246IHN0cmluZyk6IHZvaWQge1xuXHRcdHRoaXMuc2V0R2xvYmFsU2V0dGluZyhcImxhc3RDaGFuZ2Vsb2dWZXJzaW9uXCIsIHZlcnNpb24pO1xuXHR9XG5cblx0Z2V0RGVmYXVsdFByb3ZpZGVyKCk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG5cdFx0cmV0dXJuIHRoaXMuc2V0dGluZ3MuZGVmYXVsdFByb3ZpZGVyO1xuXHR9XG5cblx0Z2V0RGVmYXVsdE1vZGVsKCk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG5cdFx0cmV0dXJuIHRoaXMuc2V0dGluZ3MuZGVmYXVsdE1vZGVsO1xuXHR9XG5cblx0c2V0RGVmYXVsdFByb3ZpZGVyKHByb3ZpZGVyOiBzdHJpbmcpOiB2b2lkIHtcblx0XHR0aGlzLnNldFNjb3BlZFNldHRpbmcoXCJkZWZhdWx0UHJvdmlkZXJcIiwgcHJvdmlkZXIpO1xuXHR9XG5cblx0c2V0RGVmYXVsdE1vZGVsKG1vZGVsSWQ6IHN0cmluZyk6IHZvaWQge1xuXHRcdHRoaXMuc2V0U2NvcGVkU2V0dGluZyhcImRlZmF1bHRNb2RlbFwiLCBtb2RlbElkKTtcblx0fVxuXG5cdHNldERlZmF1bHRNb2RlbEFuZFByb3ZpZGVyKHByb3ZpZGVyOiBzdHJpbmcsIG1vZGVsSWQ6IHN0cmluZyk6IHZvaWQge1xuXHRcdGlmICh0aGlzLmhhc1Byb2plY3RTZXR0aW5ncygpKSB7XG5cdFx0XHR0aGlzLnByb2plY3RTZXR0aW5ncy5kZWZhdWx0UHJvdmlkZXIgPSBwcm92aWRlcjtcblx0XHRcdHRoaXMucHJvamVjdFNldHRpbmdzLmRlZmF1bHRNb2RlbCA9IG1vZGVsSWQ7XG5cdFx0XHR0aGlzLm1hcmtQcm9qZWN0TW9kaWZpZWQoXCJkZWZhdWx0UHJvdmlkZXJcIik7XG5cdFx0XHR0aGlzLm1hcmtQcm9qZWN0TW9kaWZpZWQoXCJkZWZhdWx0TW9kZWxcIik7XG5cdFx0XHR0aGlzLnNhdmVQcm9qZWN0U2V0dGluZ3ModGhpcy5wcm9qZWN0U2V0dGluZ3MpO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHR0aGlzLmdsb2JhbFNldHRpbmdzLmRlZmF1bHRQcm92aWRlciA9IHByb3ZpZGVyO1xuXHRcdFx0dGhpcy5nbG9iYWxTZXR0aW5ncy5kZWZhdWx0TW9kZWwgPSBtb2RlbElkO1xuXHRcdFx0dGhpcy5tYXJrTW9kaWZpZWQoXCJkZWZhdWx0UHJvdmlkZXJcIik7XG5cdFx0XHR0aGlzLm1hcmtNb2RpZmllZChcImRlZmF1bHRNb2RlbFwiKTtcblx0XHRcdHRoaXMuc2F2ZSgpO1xuXHRcdH1cblx0fVxuXG5cdGdldFN0ZWVyaW5nTW9kZSgpOiBcImFsbFwiIHwgXCJvbmUtYXQtYS10aW1lXCIge1xuXHRcdHJldHVybiB0aGlzLnNldHRpbmdzLnN0ZWVyaW5nTW9kZSB8fCBcIm9uZS1hdC1hLXRpbWVcIjtcblx0fVxuXG5cdHNldFN0ZWVyaW5nTW9kZShtb2RlOiBcImFsbFwiIHwgXCJvbmUtYXQtYS10aW1lXCIpOiB2b2lkIHtcblx0XHR0aGlzLnNldEdsb2JhbFNldHRpbmcoXCJzdGVlcmluZ01vZGVcIiwgbW9kZSk7XG5cdH1cblxuXHRnZXRGb2xsb3dVcE1vZGUoKTogXCJhbGxcIiB8IFwib25lLWF0LWEtdGltZVwiIHtcblx0XHRyZXR1cm4gdGhpcy5zZXR0aW5ncy5mb2xsb3dVcE1vZGUgfHwgXCJvbmUtYXQtYS10aW1lXCI7XG5cdH1cblxuXHRzZXRGb2xsb3dVcE1vZGUobW9kZTogXCJhbGxcIiB8IFwib25lLWF0LWEtdGltZVwiKTogdm9pZCB7XG5cdFx0dGhpcy5zZXRHbG9iYWxTZXR0aW5nKFwiZm9sbG93VXBNb2RlXCIsIG1vZGUpO1xuXHR9XG5cblx0Z2V0VGhlbWUoKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcblx0XHRyZXR1cm4gdGhpcy5zZXR0aW5ncy50aGVtZTtcblx0fVxuXG5cdHNldFRoZW1lKHRoZW1lOiBzdHJpbmcpOiB2b2lkIHtcblx0XHR0aGlzLnNldEdsb2JhbFNldHRpbmcoXCJ0aGVtZVwiLCB0aGVtZSk7XG5cdH1cblxuXHRnZXREZWZhdWx0VGhpbmtpbmdMZXZlbCgpOiBcIm9mZlwiIHwgXCJtaW5pbWFsXCIgfCBcImxvd1wiIHwgXCJtZWRpdW1cIiB8IFwiaGlnaFwiIHwgXCJ4aGlnaFwiIHwgdW5kZWZpbmVkIHtcblx0XHRyZXR1cm4gdGhpcy5zZXR0aW5ncy5kZWZhdWx0VGhpbmtpbmdMZXZlbDtcblx0fVxuXG5cdHNldERlZmF1bHRUaGlua2luZ0xldmVsKGxldmVsOiBcIm9mZlwiIHwgXCJtaW5pbWFsXCIgfCBcImxvd1wiIHwgXCJtZWRpdW1cIiB8IFwiaGlnaFwiIHwgXCJ4aGlnaFwiKTogdm9pZCB7XG5cdFx0dGhpcy5zZXRHbG9iYWxTZXR0aW5nKFwiZGVmYXVsdFRoaW5raW5nTGV2ZWxcIiwgbGV2ZWwpO1xuXHR9XG5cblx0Z2V0VHJhbnNwb3J0KCk6IFRyYW5zcG9ydFNldHRpbmcge1xuXHRcdHJldHVybiB0aGlzLnNldHRpbmdzLnRyYW5zcG9ydCA/PyBcInNzZVwiO1xuXHR9XG5cblx0c2V0VHJhbnNwb3J0KHRyYW5zcG9ydDogVHJhbnNwb3J0U2V0dGluZyk6IHZvaWQge1xuXHRcdHRoaXMuc2V0R2xvYmFsU2V0dGluZyhcInRyYW5zcG9ydFwiLCB0cmFuc3BvcnQpO1xuXHR9XG5cblx0Z2V0Q29tcGFjdGlvbkVuYWJsZWQoKTogYm9vbGVhbiB7XG5cdFx0cmV0dXJuIHRoaXMuc2V0dGluZ3MuY29tcGFjdGlvbj8uZW5hYmxlZCA/PyB0cnVlO1xuXHR9XG5cblx0c2V0Q29tcGFjdGlvbkVuYWJsZWQoZW5hYmxlZDogYm9vbGVhbik6IHZvaWQge1xuXHRcdHRoaXMuc2V0TmVzdGVkR2xvYmFsU2V0dGluZyhcImNvbXBhY3Rpb25cIiwgXCJlbmFibGVkXCIsIGVuYWJsZWQpO1xuXHR9XG5cblx0Z2V0Q29tcGFjdGlvblJlc2VydmVUb2tlbnMoKTogbnVtYmVyIHtcblx0XHRyZXR1cm4gdGhpcy5zZXR0aW5ncy5jb21wYWN0aW9uPy5yZXNlcnZlVG9rZW5zID8/IENPTVBBQ1RJT05fUkVTRVJWRV9UT0tFTlM7XG5cdH1cblxuXHRnZXRDb21wYWN0aW9uS2VlcFJlY2VudFRva2VucygpOiBudW1iZXIge1xuXHRcdHJldHVybiB0aGlzLnNldHRpbmdzLmNvbXBhY3Rpb24/LmtlZXBSZWNlbnRUb2tlbnMgPz8gQ09NUEFDVElPTl9LRUVQX1JFQ0VOVF9UT0tFTlM7XG5cdH1cblxuXHRnZXRDb21wYWN0aW9uVGhyZXNob2xkUGVyY2VudCgpOiBudW1iZXIgfCB1bmRlZmluZWQge1xuXHRcdHJldHVybiB0aGlzLnNldHRpbmdzLmNvbXBhY3Rpb24/LnRocmVzaG9sZFBlcmNlbnQ7XG5cdH1cblxuXHQvKipcblx0ICogU2V0IG9yIGNsZWFyIGFuIGluLW1lbW9yeSBjb21wYWN0aW9uIHRocmVzaG9sZC1wZXJjZW50IG92ZXJyaWRlLlxuXHQgKlxuXHQgKiBBcHBsaWVkIHRvIGB0aGlzLnNldHRpbmdzYCBvbmx5OyBuZXZlciBwZXJzaXN0ZWQgdG8gZGlzay4gUGFzcyBgdW5kZWZpbmVkYFxuXHQgKiB0byBjbGVhciBhIHByZXZpb3VzbHkgc2V0IG92ZXJyaWRlIChuZWNlc3NhcnkgZm9yIGlkZW1wb3RlbnQgcmUtc3luYyBmcm9tXG5cdCAqIGhvc3QgaW50ZWdyYXRpb25zIHdob3NlIHByZWZlcmVuY2UgbWF5IGhhdmUgYmVlbiByZW1vdmVkKS5cblx0ICpcblx0ICogRGlyZWN0IG11dGF0aW9uIGlzIHVzZWQgaW5zdGVhZCBvZiBgYXBwbHlPdmVycmlkZXMoKWAgYmVjYXVzZSBkZWVwLW1lcmdlXG5cdCAqIHNlbWFudGljcyBza2lwIGB1bmRlZmluZWRgIHZhbHVlcywgd2hpY2ggd291bGQgcHJldmVudCBjbGVhcmluZy5cblx0ICovXG5cdHNldENvbXBhY3Rpb25UaHJlc2hvbGRPdmVycmlkZShwZXJjZW50OiBudW1iZXIgfCB1bmRlZmluZWQpOiB2b2lkIHtcblx0XHRpZiAoIXRoaXMuc2V0dGluZ3MuY29tcGFjdGlvbikge1xuXHRcdFx0dGhpcy5zZXR0aW5ncy5jb21wYWN0aW9uID0ge307XG5cdFx0fVxuXHRcdGlmIChwZXJjZW50ID09PSB1bmRlZmluZWQpIHtcblx0XHRcdGRlbGV0ZSB0aGlzLnNldHRpbmdzLmNvbXBhY3Rpb24udGhyZXNob2xkUGVyY2VudDtcblx0XHR9IGVsc2Uge1xuXHRcdFx0dGhpcy5zZXR0aW5ncy5jb21wYWN0aW9uLnRocmVzaG9sZFBlcmNlbnQgPSBwZXJjZW50O1xuXHRcdH1cblx0fVxuXG5cdGdldENvbXBhY3Rpb25TZXR0aW5ncygpOiB7XG5cdFx0ZW5hYmxlZDogYm9vbGVhbjtcblx0XHRyZXNlcnZlVG9rZW5zOiBudW1iZXI7XG5cdFx0a2VlcFJlY2VudFRva2VuczogbnVtYmVyO1xuXHRcdHRocmVzaG9sZFBlcmNlbnQ/OiBudW1iZXI7XG5cdH0ge1xuXHRcdHJldHVybiB7XG5cdFx0XHRlbmFibGVkOiB0aGlzLmdldENvbXBhY3Rpb25FbmFibGVkKCksXG5cdFx0XHRyZXNlcnZlVG9rZW5zOiB0aGlzLmdldENvbXBhY3Rpb25SZXNlcnZlVG9rZW5zKCksXG5cdFx0XHRrZWVwUmVjZW50VG9rZW5zOiB0aGlzLmdldENvbXBhY3Rpb25LZWVwUmVjZW50VG9rZW5zKCksXG5cdFx0XHR0aHJlc2hvbGRQZXJjZW50OiB0aGlzLmdldENvbXBhY3Rpb25UaHJlc2hvbGRQZXJjZW50KCksXG5cdFx0fTtcblx0fVxuXG5cdGdldEJyYW5jaFN1bW1hcnlTZXR0aW5ncygpOiB7IHJlc2VydmVUb2tlbnM6IG51bWJlcjsgc2tpcFByb21wdDogYm9vbGVhbiB9IHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0cmVzZXJ2ZVRva2VuczogdGhpcy5zZXR0aW5ncy5icmFuY2hTdW1tYXJ5Py5yZXNlcnZlVG9rZW5zID8/IENPTVBBQ1RJT05fUkVTRVJWRV9UT0tFTlMsXG5cdFx0XHRza2lwUHJvbXB0OiB0aGlzLnNldHRpbmdzLmJyYW5jaFN1bW1hcnk/LnNraXBQcm9tcHQgPz8gZmFsc2UsXG5cdFx0fTtcblx0fVxuXG5cdGdldEJyYW5jaFN1bW1hcnlTa2lwUHJvbXB0KCk6IGJvb2xlYW4ge1xuXHRcdHJldHVybiB0aGlzLnNldHRpbmdzLmJyYW5jaFN1bW1hcnk/LnNraXBQcm9tcHQgPz8gZmFsc2U7XG5cdH1cblxuXHRnZXRSZXRyeUVuYWJsZWQoKTogYm9vbGVhbiB7XG5cdFx0cmV0dXJuIHRoaXMuc2V0dGluZ3MucmV0cnk/LmVuYWJsZWQgPz8gdHJ1ZTtcblx0fVxuXG5cdHNldFJldHJ5RW5hYmxlZChlbmFibGVkOiBib29sZWFuKTogdm9pZCB7XG5cdFx0dGhpcy5zZXROZXN0ZWRHbG9iYWxTZXR0aW5nKFwicmV0cnlcIiwgXCJlbmFibGVkXCIsIGVuYWJsZWQpO1xuXHR9XG5cblx0Z2V0UmV0cnlTZXR0aW5ncygpOiB7IGVuYWJsZWQ6IGJvb2xlYW47IG1heFJldHJpZXM6IG51bWJlcjsgYmFzZURlbGF5TXM6IG51bWJlcjsgbWF4RGVsYXlNczogbnVtYmVyIH0ge1xuXHRcdHJldHVybiB7XG5cdFx0XHRlbmFibGVkOiB0aGlzLmdldFJldHJ5RW5hYmxlZCgpLFxuXHRcdFx0bWF4UmV0cmllczogdGhpcy5zZXR0aW5ncy5yZXRyeT8ubWF4UmV0cmllcyA/PyAzLFxuXHRcdFx0YmFzZURlbGF5TXM6IHRoaXMuc2V0dGluZ3MucmV0cnk/LmJhc2VEZWxheU1zID8/IFJFVFJZX0JBU0VfREVMQVlfTVMsXG5cdFx0XHRtYXhEZWxheU1zOiB0aGlzLnNldHRpbmdzLnJldHJ5Py5tYXhEZWxheU1zID8/IFJFVFJZX01BWF9ERUxBWV9NUyxcblx0XHR9O1xuXHR9XG5cblx0Z2V0SGlkZVRoaW5raW5nQmxvY2soKTogYm9vbGVhbiB7XG5cdFx0cmV0dXJuIHRoaXMuc2V0dGluZ3MuaGlkZVRoaW5raW5nQmxvY2sgPz8gZmFsc2U7XG5cdH1cblxuXHRzZXRIaWRlVGhpbmtpbmdCbG9jayhoaWRlOiBib29sZWFuKTogdm9pZCB7XG5cdFx0dGhpcy5zZXRHbG9iYWxTZXR0aW5nKFwiaGlkZVRoaW5raW5nQmxvY2tcIiwgaGlkZSk7XG5cdH1cblxuXHRnZXRTaGVsbFBhdGgoKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcblx0XHRyZXR1cm4gdGhpcy5zZXR0aW5ncy5zaGVsbFBhdGg7XG5cdH1cblxuXHRzZXRTaGVsbFBhdGgocGF0aDogc3RyaW5nIHwgdW5kZWZpbmVkKTogdm9pZCB7XG5cdFx0dGhpcy5zZXRHbG9iYWxTZXR0aW5nKFwic2hlbGxQYXRoXCIsIHBhdGgpO1xuXHR9XG5cblx0Z2V0UXVpZXRTdGFydHVwKCk6IGJvb2xlYW4ge1xuXHRcdHJldHVybiB0aGlzLnNldHRpbmdzLnF1aWV0U3RhcnR1cCA/PyBmYWxzZTtcblx0fVxuXG5cdHNldFF1aWV0U3RhcnR1cChxdWlldDogYm9vbGVhbik6IHZvaWQge1xuXHRcdHRoaXMuc2V0R2xvYmFsU2V0dGluZyhcInF1aWV0U3RhcnR1cFwiLCBxdWlldCk7XG5cdH1cblxuXHRnZXRTaGVsbENvbW1hbmRQcmVmaXgoKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcblx0XHRyZXR1cm4gdGhpcy5zZXR0aW5ncy5zaGVsbENvbW1hbmRQcmVmaXg7XG5cdH1cblxuXHRzZXRTaGVsbENvbW1hbmRQcmVmaXgocHJlZml4OiBzdHJpbmcgfCB1bmRlZmluZWQpOiB2b2lkIHtcblx0XHR0aGlzLnNldEdsb2JhbFNldHRpbmcoXCJzaGVsbENvbW1hbmRQcmVmaXhcIiwgcHJlZml4KTtcblx0fVxuXG5cdGdldENvbGxhcHNlQ2hhbmdlbG9nKCk6IGJvb2xlYW4ge1xuXHRcdHJldHVybiB0aGlzLnNldHRpbmdzLmNvbGxhcHNlQ2hhbmdlbG9nID8/IGZhbHNlO1xuXHR9XG5cblx0c2V0Q29sbGFwc2VDaGFuZ2Vsb2coY29sbGFwc2U6IGJvb2xlYW4pOiB2b2lkIHtcblx0XHR0aGlzLnNldEdsb2JhbFNldHRpbmcoXCJjb2xsYXBzZUNoYW5nZWxvZ1wiLCBjb2xsYXBzZSk7XG5cdH1cblxuXHRnZXRQYWNrYWdlcygpOiBQYWNrYWdlU291cmNlW10ge1xuXHRcdHJldHVybiBbLi4uKHRoaXMuc2V0dGluZ3MucGFja2FnZXMgPz8gW10pXTtcblx0fVxuXG5cdHNldFBhY2thZ2VzKHBhY2thZ2VzOiBQYWNrYWdlU291cmNlW10pOiB2b2lkIHtcblx0XHR0aGlzLnNldEdsb2JhbFNldHRpbmcoXCJwYWNrYWdlc1wiLCBwYWNrYWdlcyk7XG5cdH1cblxuXHRzZXRQcm9qZWN0UGFja2FnZXMocGFja2FnZXM6IFBhY2thZ2VTb3VyY2VbXSk6IHZvaWQge1xuXHRcdHRoaXMuc2V0UHJvamVjdFNldHRpbmcoXCJwYWNrYWdlc1wiLCBwYWNrYWdlcyk7XG5cdH1cblxuXHRnZXRFeHRlbnNpb25QYXRocygpOiBzdHJpbmdbXSB7XG5cdFx0cmV0dXJuIFsuLi4odGhpcy5zZXR0aW5ncy5leHRlbnNpb25zID8/IFtdKV07XG5cdH1cblxuXHRzZXRFeHRlbnNpb25QYXRocyhwYXRoczogc3RyaW5nW10pOiB2b2lkIHtcblx0XHR0aGlzLnNldEdsb2JhbFNldHRpbmcoXCJleHRlbnNpb25zXCIsIHBhdGhzKTtcblx0fVxuXG5cdHNldFByb2plY3RFeHRlbnNpb25QYXRocyhwYXRoczogc3RyaW5nW10pOiB2b2lkIHtcblx0XHR0aGlzLnNldFByb2plY3RTZXR0aW5nKFwiZXh0ZW5zaW9uc1wiLCBwYXRocyk7XG5cdH1cblxuXHRnZXRTa2lsbFBhdGhzKCk6IHN0cmluZ1tdIHtcblx0XHRyZXR1cm4gWy4uLih0aGlzLnNldHRpbmdzLnNraWxscyA/PyBbXSldO1xuXHR9XG5cblx0c2V0U2tpbGxQYXRocyhwYXRoczogc3RyaW5nW10pOiB2b2lkIHtcblx0XHR0aGlzLnNldEdsb2JhbFNldHRpbmcoXCJza2lsbHNcIiwgcGF0aHMpO1xuXHR9XG5cblx0c2V0UHJvamVjdFNraWxsUGF0aHMocGF0aHM6IHN0cmluZ1tdKTogdm9pZCB7XG5cdFx0dGhpcy5zZXRQcm9qZWN0U2V0dGluZyhcInNraWxsc1wiLCBwYXRocyk7XG5cdH1cblxuXHRnZXRQcm9tcHRUZW1wbGF0ZVBhdGhzKCk6IHN0cmluZ1tdIHtcblx0XHRyZXR1cm4gWy4uLih0aGlzLnNldHRpbmdzLnByb21wdHMgPz8gW10pXTtcblx0fVxuXG5cdHNldFByb21wdFRlbXBsYXRlUGF0aHMocGF0aHM6IHN0cmluZ1tdKTogdm9pZCB7XG5cdFx0dGhpcy5zZXRHbG9iYWxTZXR0aW5nKFwicHJvbXB0c1wiLCBwYXRocyk7XG5cdH1cblxuXHRzZXRQcm9qZWN0UHJvbXB0VGVtcGxhdGVQYXRocyhwYXRoczogc3RyaW5nW10pOiB2b2lkIHtcblx0XHR0aGlzLnNldFByb2plY3RTZXR0aW5nKFwicHJvbXB0c1wiLCBwYXRocyk7XG5cdH1cblxuXHRnZXRUaGVtZVBhdGhzKCk6IHN0cmluZ1tdIHtcblx0XHRyZXR1cm4gWy4uLih0aGlzLnNldHRpbmdzLnRoZW1lcyA/PyBbXSldO1xuXHR9XG5cblx0c2V0VGhlbWVQYXRocyhwYXRoczogc3RyaW5nW10pOiB2b2lkIHtcblx0XHR0aGlzLnNldEdsb2JhbFNldHRpbmcoXCJ0aGVtZXNcIiwgcGF0aHMpO1xuXHR9XG5cblx0c2V0UHJvamVjdFRoZW1lUGF0aHMocGF0aHM6IHN0cmluZ1tdKTogdm9pZCB7XG5cdFx0dGhpcy5zZXRQcm9qZWN0U2V0dGluZyhcInRoZW1lc1wiLCBwYXRocyk7XG5cdH1cblxuXHRnZXRFbmFibGVTa2lsbENvbW1hbmRzKCk6IGJvb2xlYW4ge1xuXHRcdHJldHVybiB0aGlzLnNldHRpbmdzLmVuYWJsZVNraWxsQ29tbWFuZHMgPz8gdHJ1ZTtcblx0fVxuXG5cdHNldEVuYWJsZVNraWxsQ29tbWFuZHMoZW5hYmxlZDogYm9vbGVhbik6IHZvaWQge1xuXHRcdHRoaXMuc2V0R2xvYmFsU2V0dGluZyhcImVuYWJsZVNraWxsQ29tbWFuZHNcIiwgZW5hYmxlZCk7XG5cdH1cblxuXHRnZXRUaGlua2luZ0J1ZGdldHMoKTogVGhpbmtpbmdCdWRnZXRzU2V0dGluZ3MgfCB1bmRlZmluZWQge1xuXHRcdHJldHVybiB0aGlzLnNldHRpbmdzLnRoaW5raW5nQnVkZ2V0cztcblx0fVxuXG5cdGdldFNob3dJbWFnZXMoKTogYm9vbGVhbiB7XG5cdFx0cmV0dXJuIHRoaXMuc2V0dGluZ3MudGVybWluYWw/LnNob3dJbWFnZXMgPz8gdHJ1ZTtcblx0fVxuXG5cdHNldFNob3dJbWFnZXMoc2hvdzogYm9vbGVhbik6IHZvaWQge1xuXHRcdHRoaXMuc2V0TmVzdGVkR2xvYmFsU2V0dGluZyhcInRlcm1pbmFsXCIsIFwic2hvd0ltYWdlc1wiLCBzaG93KTtcblx0fVxuXG5cdGdldENsZWFyT25TaHJpbmsoKTogYm9vbGVhbiB7XG5cdFx0Ly8gU2V0dGluZ3MgdGFrZXMgcHJlY2VkZW5jZSwgdGhlbiBlbnYgdmFyLCB0aGVuIGRlZmF1bHQgZmFsc2Vcblx0XHRpZiAodGhpcy5zZXR0aW5ncy50ZXJtaW5hbD8uY2xlYXJPblNocmluayAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0XHRyZXR1cm4gdGhpcy5zZXR0aW5ncy50ZXJtaW5hbC5jbGVhck9uU2hyaW5rO1xuXHRcdH1cblx0XHRyZXR1cm4gcHJvY2Vzcy5lbnYuUElfQ0xFQVJfT05fU0hSSU5LID09PSBcIjFcIjtcblx0fVxuXG5cdHNldENsZWFyT25TaHJpbmsoZW5hYmxlZDogYm9vbGVhbik6IHZvaWQge1xuXHRcdHRoaXMuc2V0TmVzdGVkR2xvYmFsU2V0dGluZyhcInRlcm1pbmFsXCIsIFwiY2xlYXJPblNocmlua1wiLCBlbmFibGVkKTtcblx0fVxuXG5cdGdldEFkYXB0aXZlTW9kZSgpOiBBZGFwdGl2ZVR1aU1vZGUge1xuXHRcdGNvbnN0IG1vZGUgPSB0aGlzLnNldHRpbmdzLnRlcm1pbmFsPy5hZGFwdGl2ZU1vZGU7XG5cdFx0Y29uc3QgdmFsaWQ6IEFkYXB0aXZlVHVpTW9kZVtdID0gW1wiYXV0b1wiLCBcImNoYXRcIiwgXCJ3b3JrZmxvd1wiLCBcInZhbGlkYXRpb25cIiwgXCJkZWJ1Z1wiLCBcImNvbXBhY3RcIl07XG5cdFx0cmV0dXJuIG1vZGUgJiYgdmFsaWQuaW5jbHVkZXMobW9kZSkgPyBtb2RlIDogXCJhdXRvXCI7XG5cdH1cblxuXHRzZXRBZGFwdGl2ZU1vZGUobW9kZTogQWRhcHRpdmVUdWlNb2RlKTogdm9pZCB7XG5cdFx0dGhpcy5zZXROZXN0ZWRHbG9iYWxTZXR0aW5nKFwidGVybWluYWxcIiwgXCJhZGFwdGl2ZU1vZGVcIiwgbW9kZSk7XG5cdH1cblxuXHRnZXRJbWFnZUF1dG9SZXNpemUoKTogYm9vbGVhbiB7XG5cdFx0cmV0dXJuIHRoaXMuc2V0dGluZ3MuaW1hZ2VzPy5hdXRvUmVzaXplID8/IHRydWU7XG5cdH1cblxuXHRzZXRJbWFnZUF1dG9SZXNpemUoZW5hYmxlZDogYm9vbGVhbik6IHZvaWQge1xuXHRcdHRoaXMuc2V0TmVzdGVkR2xvYmFsU2V0dGluZyhcImltYWdlc1wiLCBcImF1dG9SZXNpemVcIiwgZW5hYmxlZCk7XG5cdH1cblxuXHRnZXRCbG9ja0ltYWdlcygpOiBib29sZWFuIHtcblx0XHRyZXR1cm4gdGhpcy5zZXR0aW5ncy5pbWFnZXM/LmJsb2NrSW1hZ2VzID8/IGZhbHNlO1xuXHR9XG5cblx0c2V0QmxvY2tJbWFnZXMoYmxvY2tlZDogYm9vbGVhbik6IHZvaWQge1xuXHRcdHRoaXMuc2V0TmVzdGVkR2xvYmFsU2V0dGluZyhcImltYWdlc1wiLCBcImJsb2NrSW1hZ2VzXCIsIGJsb2NrZWQpO1xuXHR9XG5cblx0Z2V0RW5hYmxlZE1vZGVscygpOiBzdHJpbmdbXSB8IHVuZGVmaW5lZCB7XG5cdFx0cmV0dXJuIHRoaXMuc2V0dGluZ3MuZW5hYmxlZE1vZGVscztcblx0fVxuXG5cdHNldEVuYWJsZWRNb2RlbHMocGF0dGVybnM6IHN0cmluZ1tdIHwgdW5kZWZpbmVkKTogdm9pZCB7XG5cdFx0dGhpcy5zZXRHbG9iYWxTZXR0aW5nKFwiZW5hYmxlZE1vZGVsc1wiLCBwYXR0ZXJucyk7XG5cdH1cblxuXHRnZXREb3VibGVFc2NhcGVBY3Rpb24oKTogXCJmb3JrXCIgfCBcInRyZWVcIiB8IFwibm9uZVwiIHtcblx0XHRyZXR1cm4gdGhpcy5zZXR0aW5ncy5kb3VibGVFc2NhcGVBY3Rpb24gPz8gXCJ0cmVlXCI7XG5cdH1cblxuXHRzZXREb3VibGVFc2NhcGVBY3Rpb24oYWN0aW9uOiBcImZvcmtcIiB8IFwidHJlZVwiIHwgXCJub25lXCIpOiB2b2lkIHtcblx0XHR0aGlzLnNldEdsb2JhbFNldHRpbmcoXCJkb3VibGVFc2NhcGVBY3Rpb25cIiwgYWN0aW9uKTtcblx0fVxuXG5cdGdldFRyZWVGaWx0ZXJNb2RlKCk6IFwiZGVmYXVsdFwiIHwgXCJuby10b29sc1wiIHwgXCJ1c2VyLW9ubHlcIiB8IFwibGFiZWxlZC1vbmx5XCIgfCBcImFsbFwiIHtcblx0XHRjb25zdCBtb2RlID0gdGhpcy5zZXR0aW5ncy50cmVlRmlsdGVyTW9kZTtcblx0XHRjb25zdCB2YWxpZCA9IFtcImRlZmF1bHRcIiwgXCJuby10b29sc1wiLCBcInVzZXItb25seVwiLCBcImxhYmVsZWQtb25seVwiLCBcImFsbFwiXTtcblx0XHRyZXR1cm4gbW9kZSAmJiB2YWxpZC5pbmNsdWRlcyhtb2RlKSA/IG1vZGUgOiBcImRlZmF1bHRcIjtcblx0fVxuXG5cdHNldFRyZWVGaWx0ZXJNb2RlKG1vZGU6IFwiZGVmYXVsdFwiIHwgXCJuby10b29sc1wiIHwgXCJ1c2VyLW9ubHlcIiB8IFwibGFiZWxlZC1vbmx5XCIgfCBcImFsbFwiKTogdm9pZCB7XG5cdFx0dGhpcy5zZXRHbG9iYWxTZXR0aW5nKFwidHJlZUZpbHRlck1vZGVcIiwgbW9kZSk7XG5cdH1cblxuXHRnZXRTaG93SGFyZHdhcmVDdXJzb3IoKTogYm9vbGVhbiB7XG5cdFx0cmV0dXJuIHRoaXMuc2V0dGluZ3Muc2hvd0hhcmR3YXJlQ3Vyc29yID8/IHByb2Nlc3MuZW52LlBJX0hBUkRXQVJFX0NVUlNPUiA9PT0gXCIxXCI7XG5cdH1cblxuXHRzZXRTaG93SGFyZHdhcmVDdXJzb3IoZW5hYmxlZDogYm9vbGVhbik6IHZvaWQge1xuXHRcdHRoaXMuc2V0R2xvYmFsU2V0dGluZyhcInNob3dIYXJkd2FyZUN1cnNvclwiLCBlbmFibGVkKTtcblx0fVxuXG5cdGdldEVkaXRvclBhZGRpbmdYKCk6IG51bWJlciB7XG5cdFx0cmV0dXJuIHRoaXMuc2V0dGluZ3MuZWRpdG9yUGFkZGluZ1ggPz8gMDtcblx0fVxuXG5cdHNldEVkaXRvclBhZGRpbmdYKHBhZGRpbmc6IG51bWJlcik6IHZvaWQge1xuXHRcdHRoaXMuc2V0R2xvYmFsU2V0dGluZyhcImVkaXRvclBhZGRpbmdYXCIsIE1hdGgubWF4KDAsIE1hdGgubWluKDMsIE1hdGguZmxvb3IocGFkZGluZykpKSk7XG5cdH1cblxuXHRnZXRBdXRvY29tcGxldGVNYXhWaXNpYmxlKCk6IG51bWJlciB7XG5cdFx0cmV0dXJuIHRoaXMuc2V0dGluZ3MuYXV0b2NvbXBsZXRlTWF4VmlzaWJsZSA/PyA1O1xuXHR9XG5cblx0c2V0QXV0b2NvbXBsZXRlTWF4VmlzaWJsZShtYXhWaXNpYmxlOiBudW1iZXIpOiB2b2lkIHtcblx0XHR0aGlzLnNldEdsb2JhbFNldHRpbmcoXCJhdXRvY29tcGxldGVNYXhWaXNpYmxlXCIsIE1hdGgubWF4KDMsIE1hdGgubWluKDIwLCBNYXRoLmZsb29yKG1heFZpc2libGUpKSkpO1xuXHR9XG5cblx0Z2V0UmVzcGVjdEdpdGlnbm9yZUluUGlja2VyKCk6IGJvb2xlYW4ge1xuXHRcdHJldHVybiB0aGlzLnNldHRpbmdzLnJlc3BlY3RHaXRpZ25vcmVJblBpY2tlciA/PyB0cnVlO1xuXHR9XG5cblx0c2V0UmVzcGVjdEdpdGlnbm9yZUluUGlja2VyKHZhbHVlOiBib29sZWFuKTogdm9pZCB7XG5cdFx0dGhpcy5zZXRHbG9iYWxTZXR0aW5nKFwicmVzcGVjdEdpdGlnbm9yZUluUGlja2VyXCIsIHZhbHVlKTtcblx0fVxuXG5cdGdldFNlYXJjaEV4Y2x1ZGVEaXJzKCk6IHN0cmluZ1tdIHtcblx0XHRyZXR1cm4gdGhpcy5zZXR0aW5ncy5zZWFyY2hFeGNsdWRlRGlycyA/PyBbXTtcblx0fVxuXG5cdHNldFNlYXJjaEV4Y2x1ZGVEaXJzKGRpcnM6IHN0cmluZ1tdKTogdm9pZCB7XG5cdFx0dGhpcy5zZXRHbG9iYWxTZXR0aW5nKFwic2VhcmNoRXhjbHVkZURpcnNcIiwgZGlycy5maWx0ZXIoQm9vbGVhbikpO1xuXHR9XG5cblx0Z2V0Q29kZUJsb2NrSW5kZW50KCk6IHN0cmluZyB7XG5cdFx0cmV0dXJuIHRoaXMuc2V0dGluZ3MubWFya2Rvd24/LmNvZGVCbG9ja0luZGVudCA/PyBcIiAgXCI7XG5cdH1cblxuXHRnZXRNZW1vcnlTZXR0aW5ncygpOiB7XG5cdFx0ZW5hYmxlZDogYm9vbGVhbjtcblx0XHRtYXhSb2xsb3V0c1BlclN0YXJ0dXA6IG51bWJlcjtcblx0XHRtYXhSb2xsb3V0QWdlRGF5czogbnVtYmVyO1xuXHRcdG1pblJvbGxvdXRJZGxlSG91cnM6IG51bWJlcjtcblx0XHRzdGFnZTFDb25jdXJyZW5jeTogbnVtYmVyO1xuXHRcdHN1bW1hcnlJbmplY3Rpb25Ub2tlbkxpbWl0OiBudW1iZXI7XG5cdH0ge1xuXHRcdHJldHVybiB7XG5cdFx0XHRlbmFibGVkOiB0aGlzLnNldHRpbmdzLm1lbW9yeT8uZW5hYmxlZCA/PyBmYWxzZSxcblx0XHRcdG1heFJvbGxvdXRzUGVyU3RhcnR1cDogdGhpcy5zZXR0aW5ncy5tZW1vcnk/Lm1heFJvbGxvdXRzUGVyU3RhcnR1cCA/PyA2NCxcblx0XHRcdG1heFJvbGxvdXRBZ2VEYXlzOiB0aGlzLnNldHRpbmdzLm1lbW9yeT8ubWF4Um9sbG91dEFnZURheXMgPz8gMzAsXG5cdFx0XHRtaW5Sb2xsb3V0SWRsZUhvdXJzOiB0aGlzLnNldHRpbmdzLm1lbW9yeT8ubWluUm9sbG91dElkbGVIb3VycyA/PyAxMixcblx0XHRcdHN0YWdlMUNvbmN1cnJlbmN5OiB0aGlzLnNldHRpbmdzLm1lbW9yeT8uc3RhZ2UxQ29uY3VycmVuY3kgPz8gOCxcblx0XHRcdHN1bW1hcnlJbmplY3Rpb25Ub2tlbkxpbWl0OiB0aGlzLnNldHRpbmdzLm1lbW9yeT8uc3VtbWFyeUluamVjdGlvblRva2VuTGltaXQgPz8gNTAwMCxcblx0XHR9O1xuXHR9XG5cblx0Z2V0QXN5bmNFbmFibGVkKCk6IGJvb2xlYW4ge1xuXHRcdHJldHVybiB0aGlzLnNldHRpbmdzLmFzeW5jPy5lbmFibGVkID8/IGZhbHNlO1xuXHR9XG5cblx0Z2V0QXN5bmNNYXhKb2JzKCk6IG51bWJlciB7XG5cdFx0cmV0dXJuIHRoaXMuc2V0dGluZ3MuYXN5bmM/Lm1heEpvYnMgPz8gMTAwO1xuXHR9XG5cblx0Z2V0VGFza0lzb2xhdGlvbk1vZGUoKTogXCJub25lXCIgfCBcIndvcmt0cmVlXCIgfCBcImZ1c2Utb3ZlcmxheVwiIHtcblx0XHRyZXR1cm4gdGhpcy5zZXR0aW5ncy50YXNrSXNvbGF0aW9uPy5tb2RlID8/IFwibm9uZVwiO1xuXHR9XG5cblx0Z2V0VGFza0lzb2xhdGlvbk1lcmdlKCk6IFwicGF0Y2hcIiB8IFwiYnJhbmNoXCIge1xuXHRcdHJldHVybiB0aGlzLnNldHRpbmdzLnRhc2tJc29sYXRpb24/Lm1lcmdlID8/IFwicGF0Y2hcIjtcblx0fVxuXG5cdGdldEZhbGxiYWNrRW5hYmxlZCgpOiBib29sZWFuIHtcblx0XHRyZXR1cm4gdGhpcy5zZXR0aW5ncy5mYWxsYmFjaz8uZW5hYmxlZCA/PyBmYWxzZTtcblx0fVxuXG5cdHNldEZhbGxiYWNrRW5hYmxlZChlbmFibGVkOiBib29sZWFuKTogdm9pZCB7XG5cdFx0dGhpcy5zZXROZXN0ZWRHbG9iYWxTZXR0aW5nKFwiZmFsbGJhY2tcIiwgXCJlbmFibGVkXCIsIGVuYWJsZWQpO1xuXHR9XG5cblx0Z2V0RmFsbGJhY2tDaGFpbnMoKTogUmVjb3JkPHN0cmluZywgRmFsbGJhY2tDaGFpbkVudHJ5W10+IHtcblx0XHRyZXR1cm4gdGhpcy5zZXR0aW5ncy5mYWxsYmFjaz8uY2hhaW5zID8/IHt9O1xuXHR9XG5cblx0Z2V0RmFsbGJhY2tDaGFpbihuYW1lOiBzdHJpbmcpOiBGYWxsYmFja0NoYWluRW50cnlbXSB8IHVuZGVmaW5lZCB7XG5cdFx0cmV0dXJuIHRoaXMuc2V0dGluZ3MuZmFsbGJhY2s/LmNoYWlucz8uW25hbWVdO1xuXHR9XG5cblx0c2V0RmFsbGJhY2tDaGFpbihuYW1lOiBzdHJpbmcsIGVudHJpZXM6IEZhbGxiYWNrQ2hhaW5FbnRyeVtdKTogdm9pZCB7XG5cdFx0aWYgKCF0aGlzLmdsb2JhbFNldHRpbmdzLmZhbGxiYWNrKSB7XG5cdFx0XHR0aGlzLmdsb2JhbFNldHRpbmdzLmZhbGxiYWNrID0ge307XG5cdFx0fVxuXHRcdGlmICghdGhpcy5nbG9iYWxTZXR0aW5ncy5mYWxsYmFjay5jaGFpbnMpIHtcblx0XHRcdHRoaXMuZ2xvYmFsU2V0dGluZ3MuZmFsbGJhY2suY2hhaW5zID0ge307XG5cdFx0fVxuXHRcdC8vIFNvcnQgYnkgcHJpb3JpdHlcblx0XHR0aGlzLmdsb2JhbFNldHRpbmdzLmZhbGxiYWNrLmNoYWluc1tuYW1lXSA9IFsuLi5lbnRyaWVzXS5zb3J0KChhLCBiKSA9PiBhLnByaW9yaXR5IC0gYi5wcmlvcml0eSk7XG5cdFx0dGhpcy5tYXJrTW9kaWZpZWQoXCJmYWxsYmFja1wiKTtcblx0XHR0aGlzLnNhdmUoKTtcblx0fVxuXG5cdHJlbW92ZUZhbGxiYWNrQ2hhaW4obmFtZTogc3RyaW5nKTogYm9vbGVhbiB7XG5cdFx0aWYgKCF0aGlzLmdsb2JhbFNldHRpbmdzLmZhbGxiYWNrPy5jaGFpbnM/LltuYW1lXSkge1xuXHRcdFx0cmV0dXJuIGZhbHNlO1xuXHRcdH1cblx0XHRkZWxldGUgdGhpcy5nbG9iYWxTZXR0aW5ncy5mYWxsYmFjay5jaGFpbnNbbmFtZV07XG5cdFx0aWYgKE9iamVjdC5rZXlzKHRoaXMuZ2xvYmFsU2V0dGluZ3MuZmFsbGJhY2suY2hhaW5zKS5sZW5ndGggPT09IDApIHtcblx0XHRcdGRlbGV0ZSB0aGlzLmdsb2JhbFNldHRpbmdzLmZhbGxiYWNrLmNoYWlucztcblx0XHR9XG5cdFx0dGhpcy5tYXJrTW9kaWZpZWQoXCJmYWxsYmFja1wiKTtcblx0XHR0aGlzLnNhdmUoKTtcblx0XHRyZXR1cm4gdHJ1ZTtcblx0fVxuXG5cdGdldEZhbGxiYWNrU2V0dGluZ3MoKTogeyBlbmFibGVkOiBib29sZWFuOyBjaGFpbnM6IFJlY29yZDxzdHJpbmcsIEZhbGxiYWNrQ2hhaW5FbnRyeVtdPiB9IHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0ZW5hYmxlZDogdGhpcy5nZXRGYWxsYmFja0VuYWJsZWQoKSxcblx0XHRcdGNoYWluczogdGhpcy5nZXRGYWxsYmFja0NoYWlucygpLFxuXHRcdH07XG5cdH1cblxuXHRnZXRNb2RlbERpc2NvdmVyeVNldHRpbmdzKCk6IE1vZGVsRGlzY292ZXJ5U2V0dGluZ3Mge1xuXHRcdHJldHVybiB0aGlzLnNldHRpbmdzLm1vZGVsRGlzY292ZXJ5ID8/IHt9O1xuXHR9XG5cblx0c2V0TW9kZWxEaXNjb3ZlcnlFbmFibGVkKGVuYWJsZWQ6IGJvb2xlYW4pOiB2b2lkIHtcblx0XHR0aGlzLnNldE5lc3RlZEdsb2JhbFNldHRpbmcoXCJtb2RlbERpc2NvdmVyeVwiLCBcImVuYWJsZWRcIiwgZW5hYmxlZCk7XG5cdH1cblxuXHRnZXRFZGl0TW9kZSgpOiBcInN0YW5kYXJkXCIgfCBcImhhc2hsaW5lXCIge1xuXHRcdHJldHVybiB0aGlzLnNldHRpbmdzLmVkaXRNb2RlID8/IFwic3RhbmRhcmRcIjtcblx0fVxuXG5cdHNldEVkaXRNb2RlKG1vZGU6IFwic3RhbmRhcmRcIiB8IFwiaGFzaGxpbmVcIik6IHZvaWQge1xuXHRcdHRoaXMuc2V0R2xvYmFsU2V0dGluZyhcImVkaXRNb2RlXCIsIG1vZGUpO1xuXHR9XG5cblx0Z2V0VGltZXN0YW1wRm9ybWF0KCk6IFwiZGF0ZS10aW1lLWlzb1wiIHwgXCJkYXRlLXRpbWUtdXNcIiB7XG5cdFx0cmV0dXJuIHRoaXMuc2V0dGluZ3MudGltZXN0YW1wRm9ybWF0ID8/IFwiZGF0ZS10aW1lLWlzb1wiO1xuXHR9XG5cblx0c2V0VGltZXN0YW1wRm9ybWF0KGZvcm1hdDogXCJkYXRlLXRpbWUtaXNvXCIgfCBcImRhdGUtdGltZS11c1wiKTogdm9pZCB7XG5cdFx0dGhpcy5zZXRHbG9iYWxTZXR0aW5nKFwidGltZXN0YW1wRm9ybWF0XCIsIGZvcm1hdCk7XG5cdH1cblxuXHQvKipcblx0ICogR2V0IHRoZSBhbGxvd2VkIGNvbW1hbmQgcHJlZml4ZXMgZnJvbSBnbG9iYWwgc2V0dGluZ3Mgb25seS5cblx0ICogUmV0dXJucyB1bmRlZmluZWQgaWYgbm90IGNvbmZpZ3VyZWQgKGNhbGxlciBzaG91bGQgdXNlIGJ1aWx0LWluIGRlZmF1bHRzKS5cblx0ICovXG5cdGdldEFsbG93ZWRDb21tYW5kUHJlZml4ZXMoKTogc3RyaW5nW10gfCB1bmRlZmluZWQge1xuXHRcdHJldHVybiB0aGlzLmdsb2JhbFNldHRpbmdzLmFsbG93ZWRDb21tYW5kUHJlZml4ZXM7XG5cdH1cblxuXHRzZXRBbGxvd2VkQ29tbWFuZFByZWZpeGVzKHByZWZpeGVzOiBzdHJpbmdbXSk6IHZvaWQge1xuXHRcdHRoaXMuc2V0R2xvYmFsU2V0dGluZyhcImFsbG93ZWRDb21tYW5kUHJlZml4ZXNcIiwgcHJlZml4ZXMpO1xuXHR9XG5cblx0LyoqXG5cdCAqIEdldCB0aGUgZmV0Y2ggVVJMIGFsbG93bGlzdCBmcm9tIGdsb2JhbCBzZXR0aW5ncyBvbmx5LlxuXHQgKiBSZXR1cm5zIHVuZGVmaW5lZCBpZiBub3QgY29uZmlndXJlZCAoY2FsbGVyIHNob3VsZCB1c2UgZW1wdHkgYWxsb3dsaXN0KS5cblx0ICovXG5cdGdldEZldGNoQWxsb3dlZFVybHMoKTogc3RyaW5nW10gfCB1bmRlZmluZWQge1xuXHRcdHJldHVybiB0aGlzLmdsb2JhbFNldHRpbmdzLmZldGNoQWxsb3dlZFVybHM7XG5cdH1cblxuXHRzZXRGZXRjaEFsbG93ZWRVcmxzKHVybHM6IHN0cmluZ1tdKTogdm9pZCB7XG5cdFx0dGhpcy5zZXRHbG9iYWxTZXR0aW5nKFwiZmV0Y2hBbGxvd2VkVXJsc1wiLCB1cmxzKTtcblx0fVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBQ0EsU0FBUyxZQUFZLFdBQVcsY0FB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
