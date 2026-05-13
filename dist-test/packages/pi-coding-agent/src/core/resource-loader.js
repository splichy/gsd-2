import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import chalk from "chalk";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.js";
import { loadThemeFromPath } from "../modes/interactive/theme/theme.js";
import { createEventBus } from "./event-bus.js";
import { createExtensionRuntime, loadExtensionFromFactory, loadExtensions, resetExtensionLoaderCache } from "./extensions/loader.js";
import { DefaultPackageManager } from "./package-manager.js";
import { loadPromptTemplates } from "./prompt-templates.js";
import { SettingsManager } from "./settings-manager.js";
import { loadSkills } from "./skills.js";
function resolvePromptInput(input, description) {
  if (!input) {
    return void 0;
  }
  if (existsSync(input)) {
    try {
      return readFileSync(input, "utf-8");
    } catch (error) {
      console.error(chalk.yellow(`Warning: Could not read ${description} file ${input}: ${error}`));
      return input;
    }
  }
  return input;
}
function loadContextFileFromDir(dir) {
  const candidates = ["AGENTS.md", "CLAUDE.md"];
  for (const filename of candidates) {
    const filePath = join(dir, filename);
    if (existsSync(filePath)) {
      try {
        return {
          path: filePath,
          content: readFileSync(filePath, "utf-8")
        };
      } catch (error) {
        console.error(chalk.yellow(`Warning: Could not read ${filePath}: ${error}`));
      }
    }
  }
  return null;
}
function loadProjectContextFiles(options = {}) {
  const resolvedCwd = options.cwd ?? process.cwd();
  const resolvedAgentDir = options.agentDir ?? getAgentDir();
  const contextFiles = [];
  const seenPaths = /* @__PURE__ */ new Set();
  const globalContext = loadContextFileFromDir(resolvedAgentDir);
  if (globalContext) {
    contextFiles.push(globalContext);
    seenPaths.add(globalContext.path);
  }
  const ancestorContextFiles = [];
  let currentDir = resolvedCwd;
  const root = resolve("/");
  while (true) {
    const contextFile = loadContextFileFromDir(currentDir);
    if (contextFile && !seenPaths.has(contextFile.path)) {
      ancestorContextFiles.unshift(contextFile);
      seenPaths.add(contextFile.path);
    }
    if (currentDir === root) break;
    const parentDir = resolve(currentDir, "..");
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }
  contextFiles.push(...ancestorContextFiles);
  return contextFiles;
}
class DefaultResourceLoader {
  constructor(options) {
    this.cwd = options.cwd ?? process.cwd();
    this.agentDir = options.agentDir ?? getAgentDir();
    this.settingsManager = options.settingsManager ?? SettingsManager.create(this.cwd, this.agentDir);
    this.eventBus = options.eventBus ?? createEventBus();
    this.packageManager = new DefaultPackageManager({
      cwd: this.cwd,
      agentDir: this.agentDir,
      settingsManager: this.settingsManager
    });
    this.bundledExtensionKeys = options.bundledExtensionKeys ?? /* @__PURE__ */ new Set();
    this.additionalExtensionPaths = options.additionalExtensionPaths ?? [];
    this.additionalSkillPaths = options.additionalSkillPaths ?? [];
    this.additionalPromptTemplatePaths = options.additionalPromptTemplatePaths ?? [];
    this.additionalThemePaths = options.additionalThemePaths ?? [];
    this.extensionFactories = options.extensionFactories ?? [];
    this.noExtensions = options.noExtensions ?? false;
    this.noSkills = options.noSkills ?? false;
    this.noPromptTemplates = options.noPromptTemplates ?? false;
    this.noThemes = options.noThemes ?? false;
    this.systemPromptSource = options.systemPrompt;
    this.appendSystemPromptSource = options.appendSystemPrompt;
    this.bundledExtensionNames = options.bundledExtensionNames ?? /* @__PURE__ */ new Set();
    this.extensionPathsTransform = options.extensionPathsTransform;
    this.extensionsOverride = options.extensionsOverride;
    this.skillsOverride = options.skillsOverride;
    this.promptsOverride = options.promptsOverride;
    this.themesOverride = options.themesOverride;
    this.agentsFilesOverride = options.agentsFilesOverride;
    this.systemPromptOverride = options.systemPromptOverride;
    this.appendSystemPromptOverride = options.appendSystemPromptOverride;
    this.extensionsResult = { extensions: [], errors: [], warnings: [], runtime: createExtensionRuntime() };
    this.skills = [];
    this.skillDiagnostics = [];
    this.prompts = [];
    this.promptDiagnostics = [];
    this.themes = [];
    this.themeDiagnostics = [];
    this.agentsFiles = [];
    this.appendSystemPrompt = [];
    this.pathMetadata = /* @__PURE__ */ new Map();
    this.lastSkillPaths = [];
    this.lastPromptPaths = [];
    this.lastThemePaths = [];
  }
  getExtensions() {
    return this.extensionsResult;
  }
  getSkills() {
    return { skills: this.skills, diagnostics: this.skillDiagnostics };
  }
  getPrompts() {
    return { prompts: this.prompts, diagnostics: this.promptDiagnostics };
  }
  getThemes() {
    return { themes: this.themes, diagnostics: this.themeDiagnostics };
  }
  getAgentsFiles() {
    return { agentsFiles: this.agentsFiles };
  }
  getSystemPrompt() {
    return this.systemPrompt;
  }
  getAppendSystemPrompt() {
    return this.appendSystemPrompt;
  }
  getPathMetadata() {
    return this.pathMetadata;
  }
  extendResources(paths) {
    const skillPaths = this.normalizeExtensionPaths(paths.skillPaths ?? []);
    const promptPaths = this.normalizeExtensionPaths(paths.promptPaths ?? []);
    const themePaths = this.normalizeExtensionPaths(paths.themePaths ?? []);
    if (skillPaths.length > 0) {
      this.lastSkillPaths = this.mergePaths(
        this.lastSkillPaths,
        skillPaths.map((entry) => entry.path)
      );
      this.updateSkillsFromPaths(this.lastSkillPaths, skillPaths);
    }
    if (promptPaths.length > 0) {
      this.lastPromptPaths = this.mergePaths(
        this.lastPromptPaths,
        promptPaths.map((entry) => entry.path)
      );
      this.updatePromptsFromPaths(this.lastPromptPaths, promptPaths);
    }
    if (themePaths.length > 0) {
      this.lastThemePaths = this.mergePaths(
        this.lastThemePaths,
        themePaths.map((entry) => entry.path)
      );
      this.updateThemesFromPaths(this.lastThemePaths, themePaths);
    }
  }
  async reload() {
    resetExtensionLoaderCache();
    const resolvedPaths = await this.packageManager.resolve();
    const cliExtensionPaths = await this.packageManager.resolveExtensionSources(this.additionalExtensionPaths, {
      temporary: true
    });
    const getEnabledResources = (resources) => {
      for (const r of resources) {
        if (!this.pathMetadata.has(r.path)) {
          this.pathMetadata.set(r.path, r.metadata);
        }
      }
      return resources.filter((r) => r.enabled);
    };
    const getEnabledPaths = (resources) => getEnabledResources(resources).map((r) => r.path);
    this.pathMetadata = /* @__PURE__ */ new Map();
    const enabledExtensions = getEnabledPaths(resolvedPaths.extensions);
    const enabledSkillResources = getEnabledResources(resolvedPaths.skills);
    const enabledPrompts = getEnabledPaths(resolvedPaths.prompts);
    const enabledThemes = getEnabledPaths(resolvedPaths.themes);
    const mapSkillPath = (resource) => {
      if (resource.metadata.source !== "auto" && resource.metadata.origin !== "package") {
        return resource.path;
      }
      try {
        const stats = statSync(resource.path);
        if (!stats.isDirectory()) {
          return resource.path;
        }
      } catch {
        return resource.path;
      }
      const skillFile = join(resource.path, "SKILL.md");
      if (existsSync(skillFile)) {
        if (!this.pathMetadata.has(skillFile)) {
          this.pathMetadata.set(skillFile, resource.metadata);
        }
        return skillFile;
      }
      return resource.path;
    };
    const enabledSkills = enabledSkillResources.map(mapSkillPath);
    for (const r of cliExtensionPaths.extensions) {
      if (!this.pathMetadata.has(r.path)) {
        this.pathMetadata.set(r.path, { source: "cli", scope: "temporary", origin: "top-level" });
      }
    }
    for (const r of cliExtensionPaths.skills) {
      if (!this.pathMetadata.has(r.path)) {
        this.pathMetadata.set(r.path, { source: "cli", scope: "temporary", origin: "top-level" });
      }
    }
    const cliEnabledExtensions = getEnabledPaths(cliExtensionPaths.extensions);
    const cliEnabledSkills = getEnabledPaths(cliExtensionPaths.skills);
    const cliEnabledPrompts = getEnabledPaths(cliExtensionPaths.prompts);
    const cliEnabledThemes = getEnabledPaths(cliExtensionPaths.themes);
    let extensionPaths = this.noExtensions ? cliEnabledExtensions : this.mergePaths(cliEnabledExtensions, enabledExtensions);
    if (this.extensionPathsTransform) {
      const transformed = this.extensionPathsTransform(extensionPaths);
      extensionPaths = transformed.paths;
      if (transformed.diagnostics?.length) {
        for (const msg of transformed.diagnostics) {
          process.stderr.write(`[extensions] ${msg}
`);
        }
      }
    }
    const extensionsResult = await loadExtensions(extensionPaths, this.cwd, this.eventBus);
    const inlineExtensions = await this.loadExtensionFactories(extensionsResult.runtime);
    extensionsResult.extensions.push(...inlineExtensions.extensions);
    extensionsResult.errors.push(...inlineExtensions.errors);
    const conflicts = this.detectExtensionConflicts(extensionsResult.extensions);
    for (const conflict of conflicts) {
      extensionsResult.errors.push({ path: conflict.path, error: conflict.message });
    }
    this.extensionsResult = this.extensionsOverride ? this.extensionsOverride(extensionsResult) : extensionsResult;
    const skillPaths = this.noSkills ? this.mergePaths(cliEnabledSkills, this.additionalSkillPaths) : this.mergePaths([...enabledSkills, ...cliEnabledSkills], this.additionalSkillPaths);
    this.lastSkillPaths = skillPaths;
    this.updateSkillsFromPaths(skillPaths);
    const promptPaths = this.noPromptTemplates ? this.mergePaths(cliEnabledPrompts, this.additionalPromptTemplatePaths) : this.mergePaths([...enabledPrompts, ...cliEnabledPrompts], this.additionalPromptTemplatePaths);
    this.lastPromptPaths = promptPaths;
    this.updatePromptsFromPaths(promptPaths);
    const themePaths = this.noThemes ? this.mergePaths(cliEnabledThemes, this.additionalThemePaths) : this.mergePaths([...enabledThemes, ...cliEnabledThemes], this.additionalThemePaths);
    this.lastThemePaths = themePaths;
    this.updateThemesFromPaths(themePaths);
    for (const extension of this.extensionsResult.extensions) {
      this.addDefaultMetadataForPath(extension.path);
    }
    const agentsFiles = { agentsFiles: loadProjectContextFiles({ cwd: this.cwd, agentDir: this.agentDir }) };
    const resolvedAgentsFiles = this.agentsFilesOverride ? this.agentsFilesOverride(agentsFiles) : agentsFiles;
    this.agentsFiles = resolvedAgentsFiles.agentsFiles;
    const baseSystemPrompt = resolvePromptInput(
      this.systemPromptSource ?? this.discoverFileInSearchPaths("SYSTEM.md"),
      "system prompt"
    );
    this.systemPrompt = this.systemPromptOverride ? this.systemPromptOverride(baseSystemPrompt) : baseSystemPrompt;
    const appendSource = this.appendSystemPromptSource ?? this.discoverFileInSearchPaths("APPEND_SYSTEM.md");
    const resolvedAppend = resolvePromptInput(appendSource, "append system prompt");
    const baseAppend = resolvedAppend ? [resolvedAppend] : [];
    this.appendSystemPrompt = this.appendSystemPromptOverride ? this.appendSystemPromptOverride(baseAppend) : baseAppend;
  }
  normalizeExtensionPaths(entries) {
    return entries.map((entry) => ({
      path: this.resolveResourcePath(entry.path),
      metadata: entry.metadata
    }));
  }
  updateSkillsFromPaths(skillPaths, extensionPaths = []) {
    let skillsResult;
    if (this.noSkills && skillPaths.length === 0) {
      skillsResult = { skills: [], diagnostics: [] };
    } else {
      skillsResult = loadSkills({
        cwd: this.cwd,
        agentDir: this.agentDir,
        skillPaths,
        includeDefaults: false
      });
    }
    const resolvedSkills = this.skillsOverride ? this.skillsOverride(skillsResult) : skillsResult;
    this.skills = resolvedSkills.skills;
    this.skillDiagnostics = resolvedSkills.diagnostics;
    this.applyExtensionMetadata(
      extensionPaths,
      this.skills.map((skill) => skill.filePath)
    );
    for (const skill of this.skills) {
      this.addDefaultMetadataForPath(skill.filePath);
    }
  }
  updatePromptsFromPaths(promptPaths, extensionPaths = []) {
    let promptsResult;
    if (this.noPromptTemplates && promptPaths.length === 0) {
      promptsResult = { prompts: [], diagnostics: [] };
    } else {
      const allPrompts = loadPromptTemplates({
        cwd: this.cwd,
        agentDir: this.agentDir,
        promptPaths,
        includeDefaults: false
      });
      const deduped = this.dedupeResources(allPrompts, {
        getName: (p) => p.name,
        getPath: (p) => p.filePath,
        resourceType: "prompt",
        namePrefix: "/"
      });
      promptsResult = { prompts: deduped.items, diagnostics: deduped.diagnostics };
    }
    const resolvedPrompts = this.promptsOverride ? this.promptsOverride(promptsResult) : promptsResult;
    this.prompts = resolvedPrompts.prompts;
    this.promptDiagnostics = resolvedPrompts.diagnostics;
    this.applyExtensionMetadata(
      extensionPaths,
      this.prompts.map((prompt) => prompt.filePath)
    );
    for (const prompt of this.prompts) {
      this.addDefaultMetadataForPath(prompt.filePath);
    }
  }
  updateThemesFromPaths(themePaths, extensionPaths = []) {
    let themesResult;
    if (this.noThemes && themePaths.length === 0) {
      themesResult = { themes: [], diagnostics: [] };
    } else {
      const loaded = this.loadThemes(themePaths, false);
      const deduped = this.dedupeResources(loaded.themes, {
        getName: (t) => t.name ?? "unnamed",
        getPath: (t) => t.sourcePath,
        resourceType: "theme"
      });
      themesResult = { themes: deduped.items, diagnostics: [...loaded.diagnostics, ...deduped.diagnostics] };
    }
    const resolvedThemes = this.themesOverride ? this.themesOverride(themesResult) : themesResult;
    this.themes = resolvedThemes.themes;
    this.themeDiagnostics = resolvedThemes.diagnostics;
    const themePathsWithSource = this.themes.flatMap((theme) => theme.sourcePath ? [theme.sourcePath] : []);
    this.applyExtensionMetadata(extensionPaths, themePathsWithSource);
    for (const theme of this.themes) {
      if (theme.sourcePath) {
        this.addDefaultMetadataForPath(theme.sourcePath);
      }
    }
  }
  applyExtensionMetadata(extensionPaths, resourcePaths) {
    if (extensionPaths.length === 0) {
      return;
    }
    const normalized = extensionPaths.map((entry) => ({
      path: resolve(entry.path),
      metadata: entry.metadata
    }));
    for (const entry of normalized) {
      if (!this.pathMetadata.has(entry.path)) {
        this.pathMetadata.set(entry.path, entry.metadata);
      }
    }
    for (const resourcePath of resourcePaths) {
      const normalizedResourcePath = resolve(resourcePath);
      if (this.pathMetadata.has(normalizedResourcePath) || this.pathMetadata.has(resourcePath)) {
        continue;
      }
      const match = normalized.find(
        (entry) => normalizedResourcePath === entry.path || normalizedResourcePath.startsWith(`${entry.path}${sep}`)
      );
      if (match) {
        this.pathMetadata.set(normalizedResourcePath, match.metadata);
      }
    }
  }
  mergePaths(primary, additional) {
    const merged = [];
    const seen = /* @__PURE__ */ new Set();
    for (const p of [...primary, ...additional]) {
      const resolved = this.resolveResourcePath(p);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      merged.push(resolved);
    }
    return merged;
  }
  resolveResourcePath(p) {
    const trimmed = p.trim();
    let expanded = trimmed;
    if (trimmed === "~") {
      expanded = homedir();
    } else if (trimmed.startsWith("~/")) {
      expanded = join(homedir(), trimmed.slice(2));
    } else if (trimmed.startsWith("~")) {
      expanded = join(homedir(), trimmed.slice(1));
    }
    return resolve(this.cwd, expanded);
  }
  loadThemes(paths, includeDefaults = true) {
    const themes = [];
    const diagnostics = [];
    if (includeDefaults) {
      const defaultDirs = [join(this.agentDir, "themes"), join(this.cwd, CONFIG_DIR_NAME, "themes")];
      for (const dir of defaultDirs) {
        this.loadThemesFromDir(dir, themes, diagnostics);
      }
    }
    for (const p of paths) {
      const resolved = resolve(this.cwd, p);
      if (!existsSync(resolved)) {
        diagnostics.push({ type: "warning", message: "theme path does not exist", path: resolved });
        continue;
      }
      try {
        const stats = statSync(resolved);
        if (stats.isDirectory()) {
          this.loadThemesFromDir(resolved, themes, diagnostics);
        } else if (stats.isFile() && resolved.endsWith(".json")) {
          this.loadThemeFromFile(resolved, themes, diagnostics);
        } else {
          diagnostics.push({ type: "warning", message: "theme path is not a json file", path: resolved });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "failed to read theme path";
        diagnostics.push({ type: "warning", message, path: resolved });
      }
    }
    return { themes, diagnostics };
  }
  loadThemesFromDir(dir, themes, diagnostics) {
    if (!existsSync(dir)) {
      return;
    }
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        let isFile = entry.isFile();
        if (entry.isSymbolicLink()) {
          try {
            isFile = statSync(join(dir, entry.name)).isFile();
          } catch {
            continue;
          }
        }
        if (!isFile) {
          continue;
        }
        if (!entry.name.endsWith(".json")) {
          continue;
        }
        this.loadThemeFromFile(join(dir, entry.name), themes, diagnostics);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to read theme directory";
      diagnostics.push({ type: "warning", message, path: dir });
    }
  }
  loadThemeFromFile(filePath, themes, diagnostics) {
    try {
      themes.push(loadThemeFromPath(filePath));
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to load theme";
      diagnostics.push({ type: "warning", message, path: filePath });
    }
  }
  async loadExtensionFactories(runtime) {
    const extensions = [];
    const errors = [];
    for (const [index, factory] of this.extensionFactories.entries()) {
      const extensionPath = `<inline:${index + 1}>`;
      try {
        const extension = await loadExtensionFromFactory(factory, this.cwd, this.eventBus, runtime, extensionPath);
        extensions.push(extension);
      } catch (error) {
        const message = error instanceof Error ? error.message : "failed to load extension";
        errors.push({ path: extensionPath, error: message });
      }
    }
    return { extensions, errors };
  }
  dedupeResources(items, options) {
    const seen = /* @__PURE__ */ new Map();
    const diagnostics = [];
    const { getName, getPath, resourceType, namePrefix = "" } = options;
    for (const item of items) {
      const name = getName(item);
      const existing = seen.get(name);
      if (existing) {
        diagnostics.push({
          type: "collision",
          message: `name "${namePrefix}${name}" collision`,
          path: getPath(item),
          collision: {
            resourceType,
            name,
            winnerPath: getPath(existing) ?? "<builtin>",
            loserPath: getPath(item) ?? "<builtin>"
          }
        });
      } else {
        seen.set(name, item);
      }
    }
    return { items: Array.from(seen.values()), diagnostics };
  }
  discoverFileInSearchPaths(filename) {
    const searchDirs = [join(this.cwd, CONFIG_DIR_NAME), this.agentDir];
    for (const dir of searchDirs) {
      const filePath = join(dir, filename);
      if (existsSync(filePath)) {
        return filePath;
      }
    }
    return void 0;
  }
  addDefaultMetadataForPath(filePath) {
    if (!filePath || filePath.startsWith("<")) {
      return;
    }
    const normalizedPath = resolve(filePath);
    if (this.pathMetadata.has(normalizedPath) || this.pathMetadata.has(filePath)) {
      return;
    }
    const agentRoots = [
      join(this.agentDir, "skills"),
      join(this.agentDir, "prompts"),
      join(this.agentDir, "themes"),
      join(this.agentDir, "extensions")
    ];
    const projectRoots = [
      join(this.cwd, CONFIG_DIR_NAME, "skills"),
      join(this.cwd, CONFIG_DIR_NAME, "prompts"),
      join(this.cwd, CONFIG_DIR_NAME, "themes"),
      join(this.cwd, CONFIG_DIR_NAME, "extensions")
    ];
    for (const root of agentRoots) {
      if (this.isUnderPath(normalizedPath, root)) {
        this.pathMetadata.set(normalizedPath, { source: "local", scope: "user", origin: "top-level" });
        return;
      }
    }
    for (const root of projectRoots) {
      if (this.isUnderPath(normalizedPath, root)) {
        this.pathMetadata.set(normalizedPath, { source: "local", scope: "project", origin: "top-level" });
        return;
      }
    }
  }
  isUnderPath(target, root) {
    const normalizedRoot = resolve(root);
    if (target === normalizedRoot) {
      return true;
    }
    const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
    return target.startsWith(prefix);
  }
  /**
   * Extract the extension name from its path.
   * For root-level files: basename without extension (e.g. "search-the-web.ts" → "search-the-web")
   * For subdirectory extensions: the directory name (e.g. "/path/to/gsd/index.ts" → "gsd")
   */
  getExtensionNameFromPath(extPath) {
    const base = basename(extPath);
    if (base === "index.js" || base === "index.ts") {
      return basename(dirname(extPath));
    }
    return base.replace(/\.(?:ts|js)$/, "");
  }
  detectExtensionConflicts(extensions) {
    return detectExtensionConflicts(extensions, this.bundledExtensionKeys, join(this.agentDir, "extensions"));
  }
}
function extractExtensionKey(ownerPath, extensionsDir) {
  const normalizedDir = resolve(extensionsDir);
  const normalizedPath = resolve(ownerPath);
  const prefix = normalizedDir.endsWith(sep) ? normalizedDir : `${normalizedDir}${sep}`;
  if (!normalizedPath.startsWith(prefix)) {
    return void 0;
  }
  const relPath = relative(normalizedDir, normalizedPath);
  const firstSegment = relPath.split(/[\\/]/)[0];
  return firstSegment?.replace(/\.(?:ts|js)$/, "") || void 0;
}
function detectExtensionConflicts(extensions, bundledExtensionKeys, extensionsDir) {
  const conflicts = [];
  const toolOwners = /* @__PURE__ */ new Map();
  const commandOwners = /* @__PURE__ */ new Map();
  const flagOwners = /* @__PURE__ */ new Map();
  const isBundled = (ownerPath) => {
    const key = extractExtensionKey(ownerPath, extensionsDir);
    return key !== void 0 && bundledExtensionKeys.has(key);
  };
  for (const ext of extensions) {
    for (const toolName of ext.tools.keys()) {
      const existingOwner = toolOwners.get(toolName);
      if (existingOwner && existingOwner !== ext.path) {
        const hint = isBundled(existingOwner) ? ` (built-in tool supersedes \u2014 consider removing ${ext.path})` : "";
        conflicts.push({
          path: ext.path,
          message: `Tool "${toolName}" conflicts with ${existingOwner}${hint}`
        });
      } else {
        toolOwners.set(toolName, ext.path);
      }
    }
    for (const commandName of ext.commands.keys()) {
      const existingOwner = commandOwners.get(commandName);
      if (existingOwner && existingOwner !== ext.path) {
        const hint = isBundled(existingOwner) ? ` (built-in command supersedes \u2014 consider removing ${ext.path})` : "";
        conflicts.push({
          path: ext.path,
          message: `Command "/${commandName}" conflicts with ${existingOwner}${hint}`
        });
      } else {
        commandOwners.set(commandName, ext.path);
      }
    }
    for (const flagName of ext.flags.keys()) {
      const existingOwner = flagOwners.get(flagName);
      if (existingOwner && existingOwner !== ext.path) {
        conflicts.push({
          path: ext.path,
          message: `Flag "--${flagName}" conflicts with ${existingOwner}`
        });
      } else {
        flagOwners.set(flagName, ext.path);
      }
    }
  }
  return conflicts;
}
export {
  DefaultResourceLoader,
  detectExtensionConflicts,
  extractExtensionKey
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL3Jlc291cmNlLWxvYWRlci50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZGRpclN5bmMsIHJlYWRGaWxlU3luYywgc3RhdFN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgaG9tZWRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBiYXNlbmFtZSwgZGlybmFtZSwgam9pbiwgcmVsYXRpdmUsIHJlc29sdmUsIHNlcCB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCBjaGFsayBmcm9tIFwiY2hhbGtcIjtcbmltcG9ydCB7IENPTkZJR19ESVJfTkFNRSwgZ2V0QWdlbnREaXIgfSBmcm9tIFwiLi4vY29uZmlnLmpzXCI7XG5pbXBvcnQgeyBsb2FkVGhlbWVGcm9tUGF0aCwgdHlwZSBUaGVtZSB9IGZyb20gXCIuLi9tb2Rlcy9pbnRlcmFjdGl2ZS90aGVtZS90aGVtZS5qc1wiO1xuaW1wb3J0IHR5cGUgeyBSZXNvdXJjZUNvbGxpc2lvbiwgUmVzb3VyY2VEaWFnbm9zdGljIH0gZnJvbSBcIi4vZGlhZ25vc3RpY3MuanNcIjtcblxuZXhwb3J0IHR5cGUgeyBSZXNvdXJjZUNvbGxpc2lvbiwgUmVzb3VyY2VEaWFnbm9zdGljIH0gZnJvbSBcIi4vZGlhZ25vc3RpY3MuanNcIjtcblxuaW1wb3J0IHsgY3JlYXRlRXZlbnRCdXMsIHR5cGUgRXZlbnRCdXMgfSBmcm9tIFwiLi9ldmVudC1idXMuanNcIjtcbmltcG9ydCB7IGNyZWF0ZUV4dGVuc2lvblJ1bnRpbWUsIGxvYWRFeHRlbnNpb25Gcm9tRmFjdG9yeSwgbG9hZEV4dGVuc2lvbnMsIHJlc2V0RXh0ZW5zaW9uTG9hZGVyQ2FjaGUgfSBmcm9tIFwiLi9leHRlbnNpb25zL2xvYWRlci5qc1wiO1xuaW1wb3J0IHR5cGUgeyBFeHRlbnNpb24sIEV4dGVuc2lvbkZhY3RvcnksIEV4dGVuc2lvblJ1bnRpbWUsIExvYWRFeHRlbnNpb25zUmVzdWx0IH0gZnJvbSBcIi4vZXh0ZW5zaW9ucy90eXBlcy5qc1wiO1xuaW1wb3J0IHsgRGVmYXVsdFBhY2thZ2VNYW5hZ2VyLCB0eXBlIFBhdGhNZXRhZGF0YSB9IGZyb20gXCIuL3BhY2thZ2UtbWFuYWdlci5qc1wiO1xuaW1wb3J0IHR5cGUgeyBQcm9tcHRUZW1wbGF0ZSB9IGZyb20gXCIuL3Byb21wdC10ZW1wbGF0ZXMuanNcIjtcbmltcG9ydCB7IGxvYWRQcm9tcHRUZW1wbGF0ZXMgfSBmcm9tIFwiLi9wcm9tcHQtdGVtcGxhdGVzLmpzXCI7XG5pbXBvcnQgeyBTZXR0aW5nc01hbmFnZXIgfSBmcm9tIFwiLi9zZXR0aW5ncy1tYW5hZ2VyLmpzXCI7XG5pbXBvcnQgdHlwZSB7IFNraWxsIH0gZnJvbSBcIi4vc2tpbGxzLmpzXCI7XG5pbXBvcnQgeyBsb2FkU2tpbGxzIH0gZnJvbSBcIi4vc2tpbGxzLmpzXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgUmVzb3VyY2VFeHRlbnNpb25QYXRocyB7XG5cdHNraWxsUGF0aHM/OiBBcnJheTx7IHBhdGg6IHN0cmluZzsgbWV0YWRhdGE6IFBhdGhNZXRhZGF0YSB9Pjtcblx0cHJvbXB0UGF0aHM/OiBBcnJheTx7IHBhdGg6IHN0cmluZzsgbWV0YWRhdGE6IFBhdGhNZXRhZGF0YSB9Pjtcblx0dGhlbWVQYXRocz86IEFycmF5PHsgcGF0aDogc3RyaW5nOyBtZXRhZGF0YTogUGF0aE1ldGFkYXRhIH0+O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFJlc291cmNlTG9hZGVyIHtcblx0Z2V0RXh0ZW5zaW9ucygpOiBMb2FkRXh0ZW5zaW9uc1Jlc3VsdDtcblx0Z2V0U2tpbGxzKCk6IHsgc2tpbGxzOiBTa2lsbFtdOyBkaWFnbm9zdGljczogUmVzb3VyY2VEaWFnbm9zdGljW10gfTtcblx0Z2V0UHJvbXB0cygpOiB7IHByb21wdHM6IFByb21wdFRlbXBsYXRlW107IGRpYWdub3N0aWNzOiBSZXNvdXJjZURpYWdub3N0aWNbXSB9O1xuXHRnZXRUaGVtZXMoKTogeyB0aGVtZXM6IFRoZW1lW107IGRpYWdub3N0aWNzOiBSZXNvdXJjZURpYWdub3N0aWNbXSB9O1xuXHRnZXRBZ2VudHNGaWxlcygpOiB7IGFnZW50c0ZpbGVzOiBBcnJheTx7IHBhdGg6IHN0cmluZzsgY29udGVudDogc3RyaW5nIH0+IH07XG5cdGdldFN5c3RlbVByb21wdCgpOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG5cdGdldEFwcGVuZFN5c3RlbVByb21wdCgpOiBzdHJpbmdbXTtcblx0Z2V0UGF0aE1ldGFkYXRhKCk6IE1hcDxzdHJpbmcsIFBhdGhNZXRhZGF0YT47XG5cdGV4dGVuZFJlc291cmNlcyhwYXRoczogUmVzb3VyY2VFeHRlbnNpb25QYXRocyk6IHZvaWQ7XG5cdHJlbG9hZCgpOiBQcm9taXNlPHZvaWQ+O1xufVxuXG5mdW5jdGlvbiByZXNvbHZlUHJvbXB0SW5wdXQoaW5wdXQ6IHN0cmluZyB8IHVuZGVmaW5lZCwgZGVzY3JpcHRpb246IHN0cmluZyk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG5cdGlmICghaW5wdXQpIHtcblx0XHRyZXR1cm4gdW5kZWZpbmVkO1xuXHR9XG5cblx0aWYgKGV4aXN0c1N5bmMoaW5wdXQpKSB7XG5cdFx0dHJ5IHtcblx0XHRcdHJldHVybiByZWFkRmlsZVN5bmMoaW5wdXQsIFwidXRmLThcIik7XG5cdFx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRcdGNvbnNvbGUuZXJyb3IoY2hhbGsueWVsbG93KGBXYXJuaW5nOiBDb3VsZCBub3QgcmVhZCAke2Rlc2NyaXB0aW9ufSBmaWxlICR7aW5wdXR9OiAke2Vycm9yfWApKTtcblx0XHRcdHJldHVybiBpbnB1dDtcblx0XHR9XG5cdH1cblxuXHRyZXR1cm4gaW5wdXQ7XG59XG5cbmZ1bmN0aW9uIGxvYWRDb250ZXh0RmlsZUZyb21EaXIoZGlyOiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZzsgY29udGVudDogc3RyaW5nIH0gfCBudWxsIHtcblx0Y29uc3QgY2FuZGlkYXRlcyA9IFtcIkFHRU5UUy5tZFwiLCBcIkNMQVVERS5tZFwiXTtcblx0Zm9yIChjb25zdCBmaWxlbmFtZSBvZiBjYW5kaWRhdGVzKSB7XG5cdFx0Y29uc3QgZmlsZVBhdGggPSBqb2luKGRpciwgZmlsZW5hbWUpO1xuXHRcdGlmIChleGlzdHNTeW5jKGZpbGVQYXRoKSkge1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRwYXRoOiBmaWxlUGF0aCxcblx0XHRcdFx0XHRjb250ZW50OiByZWFkRmlsZVN5bmMoZmlsZVBhdGgsIFwidXRmLThcIiksXG5cdFx0XHRcdH07XG5cdFx0XHR9IGNhdGNoIChlcnJvcikge1xuXHRcdFx0XHRjb25zb2xlLmVycm9yKGNoYWxrLnllbGxvdyhgV2FybmluZzogQ291bGQgbm90IHJlYWQgJHtmaWxlUGF0aH06ICR7ZXJyb3J9YCkpO1xuXHRcdFx0fVxuXHRcdH1cblx0fVxuXHRyZXR1cm4gbnVsbDtcbn1cblxuZnVuY3Rpb24gbG9hZFByb2plY3RDb250ZXh0RmlsZXMoXG5cdG9wdGlvbnM6IHsgY3dkPzogc3RyaW5nOyBhZ2VudERpcj86IHN0cmluZyB9ID0ge30sXG4pOiBBcnJheTx7IHBhdGg6IHN0cmluZzsgY29udGVudDogc3RyaW5nIH0+IHtcblx0Y29uc3QgcmVzb2x2ZWRDd2QgPSBvcHRpb25zLmN3ZCA/PyBwcm9jZXNzLmN3ZCgpO1xuXHRjb25zdCByZXNvbHZlZEFnZW50RGlyID0gb3B0aW9ucy5hZ2VudERpciA/PyBnZXRBZ2VudERpcigpO1xuXG5cdGNvbnN0IGNvbnRleHRGaWxlczogQXJyYXk8eyBwYXRoOiBzdHJpbmc7IGNvbnRlbnQ6IHN0cmluZyB9PiA9IFtdO1xuXHRjb25zdCBzZWVuUGF0aHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcblxuXHRjb25zdCBnbG9iYWxDb250ZXh0ID0gbG9hZENvbnRleHRGaWxlRnJvbURpcihyZXNvbHZlZEFnZW50RGlyKTtcblx0aWYgKGdsb2JhbENvbnRleHQpIHtcblx0XHRjb250ZXh0RmlsZXMucHVzaChnbG9iYWxDb250ZXh0KTtcblx0XHRzZWVuUGF0aHMuYWRkKGdsb2JhbENvbnRleHQucGF0aCk7XG5cdH1cblxuXHRjb25zdCBhbmNlc3RvckNvbnRleHRGaWxlczogQXJyYXk8eyBwYXRoOiBzdHJpbmc7IGNvbnRlbnQ6IHN0cmluZyB9PiA9IFtdO1xuXG5cdGxldCBjdXJyZW50RGlyID0gcmVzb2x2ZWRDd2Q7XG5cdGNvbnN0IHJvb3QgPSByZXNvbHZlKFwiL1wiKTtcblxuXHR3aGlsZSAodHJ1ZSkge1xuXHRcdGNvbnN0IGNvbnRleHRGaWxlID0gbG9hZENvbnRleHRGaWxlRnJvbURpcihjdXJyZW50RGlyKTtcblx0XHRpZiAoY29udGV4dEZpbGUgJiYgIXNlZW5QYXRocy5oYXMoY29udGV4dEZpbGUucGF0aCkpIHtcblx0XHRcdGFuY2VzdG9yQ29udGV4dEZpbGVzLnVuc2hpZnQoY29udGV4dEZpbGUpO1xuXHRcdFx0c2VlblBhdGhzLmFkZChjb250ZXh0RmlsZS5wYXRoKTtcblx0XHR9XG5cblx0XHRpZiAoY3VycmVudERpciA9PT0gcm9vdCkgYnJlYWs7XG5cblx0XHRjb25zdCBwYXJlbnREaXIgPSByZXNvbHZlKGN1cnJlbnREaXIsIFwiLi5cIik7XG5cdFx0aWYgKHBhcmVudERpciA9PT0gY3VycmVudERpcikgYnJlYWs7XG5cdFx0Y3VycmVudERpciA9IHBhcmVudERpcjtcblx0fVxuXG5cdGNvbnRleHRGaWxlcy5wdXNoKC4uLmFuY2VzdG9yQ29udGV4dEZpbGVzKTtcblxuXHRyZXR1cm4gY29udGV4dEZpbGVzO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIERlZmF1bHRSZXNvdXJjZUxvYWRlck9wdGlvbnMge1xuXHRjd2Q/OiBzdHJpbmc7XG5cdGFnZW50RGlyPzogc3RyaW5nO1xuXHRzZXR0aW5nc01hbmFnZXI/OiBTZXR0aW5nc01hbmFnZXI7XG5cdGV2ZW50QnVzPzogRXZlbnRCdXM7XG5cdGFkZGl0aW9uYWxFeHRlbnNpb25QYXRocz86IHN0cmluZ1tdO1xuXHRhZGRpdGlvbmFsU2tpbGxQYXRocz86IHN0cmluZ1tdO1xuXHRhZGRpdGlvbmFsUHJvbXB0VGVtcGxhdGVQYXRocz86IHN0cmluZ1tdO1xuXHRhZGRpdGlvbmFsVGhlbWVQYXRocz86IHN0cmluZ1tdO1xuXHRleHRlbnNpb25GYWN0b3JpZXM/OiBFeHRlbnNpb25GYWN0b3J5W107XG5cdGJ1bmRsZWRFeHRlbnNpb25LZXlzPzogU2V0PHN0cmluZz47XG5cdG5vRXh0ZW5zaW9ucz86IGJvb2xlYW47XG5cdG5vU2tpbGxzPzogYm9vbGVhbjtcblx0bm9Qcm9tcHRUZW1wbGF0ZXM/OiBib29sZWFuO1xuXHRub1RoZW1lcz86IGJvb2xlYW47XG5cdHN5c3RlbVByb21wdD86IHN0cmluZztcblx0YXBwZW5kU3lzdGVtUHJvbXB0Pzogc3RyaW5nO1xuXHQvKiogTmFtZXMgb2YgYnVuZGxlZCBleHRlbnNpb25zICh1c2VkIHRvIGlkZW50aWZ5IGJ1aWx0LWluIGV4dGVuc2lvbnMgaW4gY29uZmxpY3QgZGV0ZWN0aW9uKS4gKi9cblx0YnVuZGxlZEV4dGVuc2lvbk5hbWVzPzogU2V0PHN0cmluZz47XG5cdC8qKlxuXHQgKiBUcmFuc2Zvcm0gZXh0ZW5zaW9uIHBhdGhzIGJlZm9yZSBsb2FkaW5nLiBSZWNlaXZlcyB0aGUgbWVyZ2VkIGxpc3Qgb2YgYWxsXG5cdCAqIGRpc2NvdmVyZWQgZXh0ZW5zaW9uIHBhdGhzIGFuZCByZXR1cm5zIGEgKHBvc3NpYmx5IHJlb3JkZXJlZC9maWx0ZXJlZCkgbGlzdC5cblx0ICogVXNlIHRoaXMgdG8gYXBwbHkgZGVwZW5kZW5jeSBzb3J0aW5nIG9yIHJlZ2lzdHJ5LWJhc2VkIGZpbHRlcmluZy5cblx0ICovXG5cdGV4dGVuc2lvblBhdGhzVHJhbnNmb3JtPzogKHBhdGhzOiBzdHJpbmdbXSkgPT4geyBwYXRoczogc3RyaW5nW107IGRpYWdub3N0aWNzPzogc3RyaW5nW10gfTtcblx0ZXh0ZW5zaW9uc092ZXJyaWRlPzogKGJhc2U6IExvYWRFeHRlbnNpb25zUmVzdWx0KSA9PiBMb2FkRXh0ZW5zaW9uc1Jlc3VsdDtcblx0c2tpbGxzT3ZlcnJpZGU/OiAoYmFzZTogeyBza2lsbHM6IFNraWxsW107IGRpYWdub3N0aWNzOiBSZXNvdXJjZURpYWdub3N0aWNbXSB9KSA9PiB7XG5cdFx0c2tpbGxzOiBTa2lsbFtdO1xuXHRcdGRpYWdub3N0aWNzOiBSZXNvdXJjZURpYWdub3N0aWNbXTtcblx0fTtcblx0cHJvbXB0c092ZXJyaWRlPzogKGJhc2U6IHsgcHJvbXB0czogUHJvbXB0VGVtcGxhdGVbXTsgZGlhZ25vc3RpY3M6IFJlc291cmNlRGlhZ25vc3RpY1tdIH0pID0+IHtcblx0XHRwcm9tcHRzOiBQcm9tcHRUZW1wbGF0ZVtdO1xuXHRcdGRpYWdub3N0aWNzOiBSZXNvdXJjZURpYWdub3N0aWNbXTtcblx0fTtcblx0dGhlbWVzT3ZlcnJpZGU/OiAoYmFzZTogeyB0aGVtZXM6IFRoZW1lW107IGRpYWdub3N0aWNzOiBSZXNvdXJjZURpYWdub3N0aWNbXSB9KSA9PiB7XG5cdFx0dGhlbWVzOiBUaGVtZVtdO1xuXHRcdGRpYWdub3N0aWNzOiBSZXNvdXJjZURpYWdub3N0aWNbXTtcblx0fTtcblx0YWdlbnRzRmlsZXNPdmVycmlkZT86IChiYXNlOiB7IGFnZW50c0ZpbGVzOiBBcnJheTx7IHBhdGg6IHN0cmluZzsgY29udGVudDogc3RyaW5nIH0+IH0pID0+IHtcblx0XHRhZ2VudHNGaWxlczogQXJyYXk8eyBwYXRoOiBzdHJpbmc7IGNvbnRlbnQ6IHN0cmluZyB9Pjtcblx0fTtcblx0c3lzdGVtUHJvbXB0T3ZlcnJpZGU/OiAoYmFzZTogc3RyaW5nIHwgdW5kZWZpbmVkKSA9PiBzdHJpbmcgfCB1bmRlZmluZWQ7XG5cdGFwcGVuZFN5c3RlbVByb21wdE92ZXJyaWRlPzogKGJhc2U6IHN0cmluZ1tdKSA9PiBzdHJpbmdbXTtcbn1cblxuZXhwb3J0IGNsYXNzIERlZmF1bHRSZXNvdXJjZUxvYWRlciBpbXBsZW1lbnRzIFJlc291cmNlTG9hZGVyIHtcblx0cHJpdmF0ZSBjd2Q6IHN0cmluZztcblx0cHJpdmF0ZSBhZ2VudERpcjogc3RyaW5nO1xuXHRwcml2YXRlIHNldHRpbmdzTWFuYWdlcjogU2V0dGluZ3NNYW5hZ2VyO1xuXHRwcml2YXRlIGV2ZW50QnVzOiBFdmVudEJ1cztcblx0cHJpdmF0ZSBwYWNrYWdlTWFuYWdlcjogRGVmYXVsdFBhY2thZ2VNYW5hZ2VyO1xuXHRwcml2YXRlIGJ1bmRsZWRFeHRlbnNpb25LZXlzOiBTZXQ8c3RyaW5nPjtcblx0cHJpdmF0ZSBhZGRpdGlvbmFsRXh0ZW5zaW9uUGF0aHM6IHN0cmluZ1tdO1xuXHRwcml2YXRlIGFkZGl0aW9uYWxTa2lsbFBhdGhzOiBzdHJpbmdbXTtcblx0cHJpdmF0ZSBhZGRpdGlvbmFsUHJvbXB0VGVtcGxhdGVQYXRoczogc3RyaW5nW107XG5cdHByaXZhdGUgYWRkaXRpb25hbFRoZW1lUGF0aHM6IHN0cmluZ1tdO1xuXHRwcml2YXRlIGV4dGVuc2lvbkZhY3RvcmllczogRXh0ZW5zaW9uRmFjdG9yeVtdO1xuXHRwcml2YXRlIG5vRXh0ZW5zaW9uczogYm9vbGVhbjtcblx0cHJpdmF0ZSBub1NraWxsczogYm9vbGVhbjtcblx0cHJpdmF0ZSBub1Byb21wdFRlbXBsYXRlczogYm9vbGVhbjtcblx0cHJpdmF0ZSBub1RoZW1lczogYm9vbGVhbjtcblx0cHJpdmF0ZSBzeXN0ZW1Qcm9tcHRTb3VyY2U/OiBzdHJpbmc7XG5cdHByaXZhdGUgYXBwZW5kU3lzdGVtUHJvbXB0U291cmNlPzogc3RyaW5nO1xuXHRwcml2YXRlIGJ1bmRsZWRFeHRlbnNpb25OYW1lczogU2V0PHN0cmluZz47XG5cdHByaXZhdGUgZXh0ZW5zaW9uUGF0aHNUcmFuc2Zvcm0/OiAocGF0aHM6IHN0cmluZ1tdKSA9PiB7IHBhdGhzOiBzdHJpbmdbXTsgZGlhZ25vc3RpY3M/OiBzdHJpbmdbXSB9O1xuXHRwcml2YXRlIGV4dGVuc2lvbnNPdmVycmlkZT86IChiYXNlOiBMb2FkRXh0ZW5zaW9uc1Jlc3VsdCkgPT4gTG9hZEV4dGVuc2lvbnNSZXN1bHQ7XG5cdHByaXZhdGUgc2tpbGxzT3ZlcnJpZGU/OiAoYmFzZTogeyBza2lsbHM6IFNraWxsW107IGRpYWdub3N0aWNzOiBSZXNvdXJjZURpYWdub3N0aWNbXSB9KSA9PiB7XG5cdFx0c2tpbGxzOiBTa2lsbFtdO1xuXHRcdGRpYWdub3N0aWNzOiBSZXNvdXJjZURpYWdub3N0aWNbXTtcblx0fTtcblx0cHJpdmF0ZSBwcm9tcHRzT3ZlcnJpZGU/OiAoYmFzZTogeyBwcm9tcHRzOiBQcm9tcHRUZW1wbGF0ZVtdOyBkaWFnbm9zdGljczogUmVzb3VyY2VEaWFnbm9zdGljW10gfSkgPT4ge1xuXHRcdHByb21wdHM6IFByb21wdFRlbXBsYXRlW107XG5cdFx0ZGlhZ25vc3RpY3M6IFJlc291cmNlRGlhZ25vc3RpY1tdO1xuXHR9O1xuXHRwcml2YXRlIHRoZW1lc092ZXJyaWRlPzogKGJhc2U6IHsgdGhlbWVzOiBUaGVtZVtdOyBkaWFnbm9zdGljczogUmVzb3VyY2VEaWFnbm9zdGljW10gfSkgPT4ge1xuXHRcdHRoZW1lczogVGhlbWVbXTtcblx0XHRkaWFnbm9zdGljczogUmVzb3VyY2VEaWFnbm9zdGljW107XG5cdH07XG5cdHByaXZhdGUgYWdlbnRzRmlsZXNPdmVycmlkZT86IChiYXNlOiB7IGFnZW50c0ZpbGVzOiBBcnJheTx7IHBhdGg6IHN0cmluZzsgY29udGVudDogc3RyaW5nIH0+IH0pID0+IHtcblx0XHRhZ2VudHNGaWxlczogQXJyYXk8eyBwYXRoOiBzdHJpbmc7IGNvbnRlbnQ6IHN0cmluZyB9Pjtcblx0fTtcblx0cHJpdmF0ZSBzeXN0ZW1Qcm9tcHRPdmVycmlkZT86IChiYXNlOiBzdHJpbmcgfCB1bmRlZmluZWQpID0+IHN0cmluZyB8IHVuZGVmaW5lZDtcblx0cHJpdmF0ZSBhcHBlbmRTeXN0ZW1Qcm9tcHRPdmVycmlkZT86IChiYXNlOiBzdHJpbmdbXSkgPT4gc3RyaW5nW107XG5cblx0cHJpdmF0ZSBleHRlbnNpb25zUmVzdWx0OiBMb2FkRXh0ZW5zaW9uc1Jlc3VsdDtcblx0cHJpdmF0ZSBza2lsbHM6IFNraWxsW107XG5cdHByaXZhdGUgc2tpbGxEaWFnbm9zdGljczogUmVzb3VyY2VEaWFnbm9zdGljW107XG5cdHByaXZhdGUgcHJvbXB0czogUHJvbXB0VGVtcGxhdGVbXTtcblx0cHJpdmF0ZSBwcm9tcHREaWFnbm9zdGljczogUmVzb3VyY2VEaWFnbm9zdGljW107XG5cdHByaXZhdGUgdGhlbWVzOiBUaGVtZVtdO1xuXHRwcml2YXRlIHRoZW1lRGlhZ25vc3RpY3M6IFJlc291cmNlRGlhZ25vc3RpY1tdO1xuXHRwcml2YXRlIGFnZW50c0ZpbGVzOiBBcnJheTx7IHBhdGg6IHN0cmluZzsgY29udGVudDogc3RyaW5nIH0+O1xuXHRwcml2YXRlIHN5c3RlbVByb21wdD86IHN0cmluZztcblx0cHJpdmF0ZSBhcHBlbmRTeXN0ZW1Qcm9tcHQ6IHN0cmluZ1tdO1xuXHRwcml2YXRlIHBhdGhNZXRhZGF0YTogTWFwPHN0cmluZywgUGF0aE1ldGFkYXRhPjtcblx0cHJpdmF0ZSBsYXN0U2tpbGxQYXRoczogc3RyaW5nW107XG5cdHByaXZhdGUgbGFzdFByb21wdFBhdGhzOiBzdHJpbmdbXTtcblx0cHJpdmF0ZSBsYXN0VGhlbWVQYXRoczogc3RyaW5nW107XG5cblx0Y29uc3RydWN0b3Iob3B0aW9uczogRGVmYXVsdFJlc291cmNlTG9hZGVyT3B0aW9ucykge1xuXHRcdHRoaXMuY3dkID0gb3B0aW9ucy5jd2QgPz8gcHJvY2Vzcy5jd2QoKTtcblx0XHR0aGlzLmFnZW50RGlyID0gb3B0aW9ucy5hZ2VudERpciA/PyBnZXRBZ2VudERpcigpO1xuXHRcdHRoaXMuc2V0dGluZ3NNYW5hZ2VyID0gb3B0aW9ucy5zZXR0aW5nc01hbmFnZXIgPz8gU2V0dGluZ3NNYW5hZ2VyLmNyZWF0ZSh0aGlzLmN3ZCwgdGhpcy5hZ2VudERpcik7XG5cdFx0dGhpcy5ldmVudEJ1cyA9IG9wdGlvbnMuZXZlbnRCdXMgPz8gY3JlYXRlRXZlbnRCdXMoKTtcblx0XHR0aGlzLnBhY2thZ2VNYW5hZ2VyID0gbmV3IERlZmF1bHRQYWNrYWdlTWFuYWdlcih7XG5cdFx0XHRjd2Q6IHRoaXMuY3dkLFxuXHRcdFx0YWdlbnREaXI6IHRoaXMuYWdlbnREaXIsXG5cdFx0XHRzZXR0aW5nc01hbmFnZXI6IHRoaXMuc2V0dGluZ3NNYW5hZ2VyLFxuXHRcdH0pO1xuXHRcdHRoaXMuYnVuZGxlZEV4dGVuc2lvbktleXMgPSBvcHRpb25zLmJ1bmRsZWRFeHRlbnNpb25LZXlzID8/IG5ldyBTZXQoKTtcblx0XHR0aGlzLmFkZGl0aW9uYWxFeHRlbnNpb25QYXRocyA9IG9wdGlvbnMuYWRkaXRpb25hbEV4dGVuc2lvblBhdGhzID8/IFtdO1xuXHRcdHRoaXMuYWRkaXRpb25hbFNraWxsUGF0aHMgPSBvcHRpb25zLmFkZGl0aW9uYWxTa2lsbFBhdGhzID8/IFtdO1xuXHRcdHRoaXMuYWRkaXRpb25hbFByb21wdFRlbXBsYXRlUGF0aHMgPSBvcHRpb25zLmFkZGl0aW9uYWxQcm9tcHRUZW1wbGF0ZVBhdGhzID8/IFtdO1xuXHRcdHRoaXMuYWRkaXRpb25hbFRoZW1lUGF0aHMgPSBvcHRpb25zLmFkZGl0aW9uYWxUaGVtZVBhdGhzID8/IFtdO1xuXHRcdHRoaXMuZXh0ZW5zaW9uRmFjdG9yaWVzID0gb3B0aW9ucy5leHRlbnNpb25GYWN0b3JpZXMgPz8gW107XG5cdFx0dGhpcy5ub0V4dGVuc2lvbnMgPSBvcHRpb25zLm5vRXh0ZW5zaW9ucyA/PyBmYWxzZTtcblx0XHR0aGlzLm5vU2tpbGxzID0gb3B0aW9ucy5ub1NraWxscyA/PyBmYWxzZTtcblx0XHR0aGlzLm5vUHJvbXB0VGVtcGxhdGVzID0gb3B0aW9ucy5ub1Byb21wdFRlbXBsYXRlcyA/PyBmYWxzZTtcblx0XHR0aGlzLm5vVGhlbWVzID0gb3B0aW9ucy5ub1RoZW1lcyA/PyBmYWxzZTtcblx0XHR0aGlzLnN5c3RlbVByb21wdFNvdXJjZSA9IG9wdGlvbnMuc3lzdGVtUHJvbXB0O1xuXHRcdHRoaXMuYXBwZW5kU3lzdGVtUHJvbXB0U291cmNlID0gb3B0aW9ucy5hcHBlbmRTeXN0ZW1Qcm9tcHQ7XG5cdFx0dGhpcy5idW5kbGVkRXh0ZW5zaW9uTmFtZXMgPSBvcHRpb25zLmJ1bmRsZWRFeHRlbnNpb25OYW1lcyA/PyBuZXcgU2V0KCk7XG5cdFx0dGhpcy5leHRlbnNpb25QYXRoc1RyYW5zZm9ybSA9IG9wdGlvbnMuZXh0ZW5zaW9uUGF0aHNUcmFuc2Zvcm07XG5cdFx0dGhpcy5leHRlbnNpb25zT3ZlcnJpZGUgPSBvcHRpb25zLmV4dGVuc2lvbnNPdmVycmlkZTtcblx0XHR0aGlzLnNraWxsc092ZXJyaWRlID0gb3B0aW9ucy5za2lsbHNPdmVycmlkZTtcblx0XHR0aGlzLnByb21wdHNPdmVycmlkZSA9IG9wdGlvbnMucHJvbXB0c092ZXJyaWRlO1xuXHRcdHRoaXMudGhlbWVzT3ZlcnJpZGUgPSBvcHRpb25zLnRoZW1lc092ZXJyaWRlO1xuXHRcdHRoaXMuYWdlbnRzRmlsZXNPdmVycmlkZSA9IG9wdGlvbnMuYWdlbnRzRmlsZXNPdmVycmlkZTtcblx0XHR0aGlzLnN5c3RlbVByb21wdE92ZXJyaWRlID0gb3B0aW9ucy5zeXN0ZW1Qcm9tcHRPdmVycmlkZTtcblx0XHR0aGlzLmFwcGVuZFN5c3RlbVByb21wdE92ZXJyaWRlID0gb3B0aW9ucy5hcHBlbmRTeXN0ZW1Qcm9tcHRPdmVycmlkZTtcblxuXHRcdHRoaXMuZXh0ZW5zaW9uc1Jlc3VsdCA9IHsgZXh0ZW5zaW9uczogW10sIGVycm9yczogW10sIHdhcm5pbmdzOiBbXSwgcnVudGltZTogY3JlYXRlRXh0ZW5zaW9uUnVudGltZSgpIH07XG5cdFx0dGhpcy5za2lsbHMgPSBbXTtcblx0XHR0aGlzLnNraWxsRGlhZ25vc3RpY3MgPSBbXTtcblx0XHR0aGlzLnByb21wdHMgPSBbXTtcblx0XHR0aGlzLnByb21wdERpYWdub3N0aWNzID0gW107XG5cdFx0dGhpcy50aGVtZXMgPSBbXTtcblx0XHR0aGlzLnRoZW1lRGlhZ25vc3RpY3MgPSBbXTtcblx0XHR0aGlzLmFnZW50c0ZpbGVzID0gW107XG5cdFx0dGhpcy5hcHBlbmRTeXN0ZW1Qcm9tcHQgPSBbXTtcblx0XHR0aGlzLnBhdGhNZXRhZGF0YSA9IG5ldyBNYXAoKTtcblx0XHR0aGlzLmxhc3RTa2lsbFBhdGhzID0gW107XG5cdFx0dGhpcy5sYXN0UHJvbXB0UGF0aHMgPSBbXTtcblx0XHR0aGlzLmxhc3RUaGVtZVBhdGhzID0gW107XG5cdH1cblxuXHRnZXRFeHRlbnNpb25zKCk6IExvYWRFeHRlbnNpb25zUmVzdWx0IHtcblx0XHRyZXR1cm4gdGhpcy5leHRlbnNpb25zUmVzdWx0O1xuXHR9XG5cblx0Z2V0U2tpbGxzKCk6IHsgc2tpbGxzOiBTa2lsbFtdOyBkaWFnbm9zdGljczogUmVzb3VyY2VEaWFnbm9zdGljW10gfSB7XG5cdFx0cmV0dXJuIHsgc2tpbGxzOiB0aGlzLnNraWxscywgZGlhZ25vc3RpY3M6IHRoaXMuc2tpbGxEaWFnbm9zdGljcyB9O1xuXHR9XG5cblx0Z2V0UHJvbXB0cygpOiB7IHByb21wdHM6IFByb21wdFRlbXBsYXRlW107IGRpYWdub3N0aWNzOiBSZXNvdXJjZURpYWdub3N0aWNbXSB9IHtcblx0XHRyZXR1cm4geyBwcm9tcHRzOiB0aGlzLnByb21wdHMsIGRpYWdub3N0aWNzOiB0aGlzLnByb21wdERpYWdub3N0aWNzIH07XG5cdH1cblxuXHRnZXRUaGVtZXMoKTogeyB0aGVtZXM6IFRoZW1lW107IGRpYWdub3N0aWNzOiBSZXNvdXJjZURpYWdub3N0aWNbXSB9IHtcblx0XHRyZXR1cm4geyB0aGVtZXM6IHRoaXMudGhlbWVzLCBkaWFnbm9zdGljczogdGhpcy50aGVtZURpYWdub3N0aWNzIH07XG5cdH1cblxuXHRnZXRBZ2VudHNGaWxlcygpOiB7IGFnZW50c0ZpbGVzOiBBcnJheTx7IHBhdGg6IHN0cmluZzsgY29udGVudDogc3RyaW5nIH0+IH0ge1xuXHRcdHJldHVybiB7IGFnZW50c0ZpbGVzOiB0aGlzLmFnZW50c0ZpbGVzIH07XG5cdH1cblxuXHRnZXRTeXN0ZW1Qcm9tcHQoKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcblx0XHRyZXR1cm4gdGhpcy5zeXN0ZW1Qcm9tcHQ7XG5cdH1cblxuXHRnZXRBcHBlbmRTeXN0ZW1Qcm9tcHQoKTogc3RyaW5nW10ge1xuXHRcdHJldHVybiB0aGlzLmFwcGVuZFN5c3RlbVByb21wdDtcblx0fVxuXG5cdGdldFBhdGhNZXRhZGF0YSgpOiBNYXA8c3RyaW5nLCBQYXRoTWV0YWRhdGE+IHtcblx0XHRyZXR1cm4gdGhpcy5wYXRoTWV0YWRhdGE7XG5cdH1cblxuXHRleHRlbmRSZXNvdXJjZXMocGF0aHM6IFJlc291cmNlRXh0ZW5zaW9uUGF0aHMpOiB2b2lkIHtcblx0XHRjb25zdCBza2lsbFBhdGhzID0gdGhpcy5ub3JtYWxpemVFeHRlbnNpb25QYXRocyhwYXRocy5za2lsbFBhdGhzID8/IFtdKTtcblx0XHRjb25zdCBwcm9tcHRQYXRocyA9IHRoaXMubm9ybWFsaXplRXh0ZW5zaW9uUGF0aHMocGF0aHMucHJvbXB0UGF0aHMgPz8gW10pO1xuXHRcdGNvbnN0IHRoZW1lUGF0aHMgPSB0aGlzLm5vcm1hbGl6ZUV4dGVuc2lvblBhdGhzKHBhdGhzLnRoZW1lUGF0aHMgPz8gW10pO1xuXG5cdFx0aWYgKHNraWxsUGF0aHMubGVuZ3RoID4gMCkge1xuXHRcdFx0dGhpcy5sYXN0U2tpbGxQYXRocyA9IHRoaXMubWVyZ2VQYXRocyhcblx0XHRcdFx0dGhpcy5sYXN0U2tpbGxQYXRocyxcblx0XHRcdFx0c2tpbGxQYXRocy5tYXAoKGVudHJ5KSA9PiBlbnRyeS5wYXRoKSxcblx0XHRcdCk7XG5cdFx0XHR0aGlzLnVwZGF0ZVNraWxsc0Zyb21QYXRocyh0aGlzLmxhc3RTa2lsbFBhdGhzLCBza2lsbFBhdGhzKTtcblx0XHR9XG5cblx0XHRpZiAocHJvbXB0UGF0aHMubGVuZ3RoID4gMCkge1xuXHRcdFx0dGhpcy5sYXN0UHJvbXB0UGF0aHMgPSB0aGlzLm1lcmdlUGF0aHMoXG5cdFx0XHRcdHRoaXMubGFzdFByb21wdFBhdGhzLFxuXHRcdFx0XHRwcm9tcHRQYXRocy5tYXAoKGVudHJ5KSA9PiBlbnRyeS5wYXRoKSxcblx0XHRcdCk7XG5cdFx0XHR0aGlzLnVwZGF0ZVByb21wdHNGcm9tUGF0aHModGhpcy5sYXN0UHJvbXB0UGF0aHMsIHByb21wdFBhdGhzKTtcblx0XHR9XG5cblx0XHRpZiAodGhlbWVQYXRocy5sZW5ndGggPiAwKSB7XG5cdFx0XHR0aGlzLmxhc3RUaGVtZVBhdGhzID0gdGhpcy5tZXJnZVBhdGhzKFxuXHRcdFx0XHR0aGlzLmxhc3RUaGVtZVBhdGhzLFxuXHRcdFx0XHR0aGVtZVBhdGhzLm1hcCgoZW50cnkpID0+IGVudHJ5LnBhdGgpLFxuXHRcdFx0KTtcblx0XHRcdHRoaXMudXBkYXRlVGhlbWVzRnJvbVBhdGhzKHRoaXMubGFzdFRoZW1lUGF0aHMsIHRoZW1lUGF0aHMpO1xuXHRcdH1cblx0fVxuXG5cdGFzeW5jIHJlbG9hZCgpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHQvLyBJbnZhbGlkYXRlIHRoZSBzaGFyZWQgaml0aSBtb2R1bGUgY2FjaGUgc28gdXBkYXRlZCBleHRlbnNpb24gY29kZVxuXHRcdC8vIG9uIGRpc2sgaXMgcmUtY29tcGlsZWQgaW5zdGVhZCBvZiBzZXJ2ZWQgZnJvbSB0aGUgc3RhbGUgY2FjaGUgKCMzNjE2KS5cblx0XHRyZXNldEV4dGVuc2lvbkxvYWRlckNhY2hlKCk7XG5cblx0XHRjb25zdCByZXNvbHZlZFBhdGhzID0gYXdhaXQgdGhpcy5wYWNrYWdlTWFuYWdlci5yZXNvbHZlKCk7XG5cdFx0Y29uc3QgY2xpRXh0ZW5zaW9uUGF0aHMgPSBhd2FpdCB0aGlzLnBhY2thZ2VNYW5hZ2VyLnJlc29sdmVFeHRlbnNpb25Tb3VyY2VzKHRoaXMuYWRkaXRpb25hbEV4dGVuc2lvblBhdGhzLCB7XG5cdFx0XHR0ZW1wb3Jhcnk6IHRydWUsXG5cdFx0fSk7XG5cblx0XHQvLyBIZWxwZXIgdG8gZXh0cmFjdCBlbmFibGVkIHBhdGhzIGFuZCBzdG9yZSBtZXRhZGF0YVxuXHRcdGNvbnN0IGdldEVuYWJsZWRSZXNvdXJjZXMgPSAoXG5cdFx0XHRyZXNvdXJjZXM6IEFycmF5PHsgcGF0aDogc3RyaW5nOyBlbmFibGVkOiBib29sZWFuOyBtZXRhZGF0YTogUGF0aE1ldGFkYXRhIH0+LFxuXHRcdCk6IEFycmF5PHsgcGF0aDogc3RyaW5nOyBlbmFibGVkOiBib29sZWFuOyBtZXRhZGF0YTogUGF0aE1ldGFkYXRhIH0+ID0+IHtcblx0XHRcdGZvciAoY29uc3QgciBvZiByZXNvdXJjZXMpIHtcblx0XHRcdFx0aWYgKCF0aGlzLnBhdGhNZXRhZGF0YS5oYXMoci5wYXRoKSkge1xuXHRcdFx0XHRcdHRoaXMucGF0aE1ldGFkYXRhLnNldChyLnBhdGgsIHIubWV0YWRhdGEpO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0XHRyZXR1cm4gcmVzb3VyY2VzLmZpbHRlcigocikgPT4gci5lbmFibGVkKTtcblx0XHR9O1xuXG5cdFx0Y29uc3QgZ2V0RW5hYmxlZFBhdGhzID0gKFxuXHRcdFx0cmVzb3VyY2VzOiBBcnJheTx7IHBhdGg6IHN0cmluZzsgZW5hYmxlZDogYm9vbGVhbjsgbWV0YWRhdGE6IFBhdGhNZXRhZGF0YSB9Pixcblx0XHQpOiBzdHJpbmdbXSA9PiBnZXRFbmFibGVkUmVzb3VyY2VzKHJlc291cmNlcykubWFwKChyKSA9PiByLnBhdGgpO1xuXG5cdFx0Ly8gU3RvcmUgbWV0YWRhdGEgYW5kIGdldCBlbmFibGVkIHBhdGhzXG5cdFx0dGhpcy5wYXRoTWV0YWRhdGEgPSBuZXcgTWFwKCk7XG5cdFx0Y29uc3QgZW5hYmxlZEV4dGVuc2lvbnMgPSBnZXRFbmFibGVkUGF0aHMocmVzb2x2ZWRQYXRocy5leHRlbnNpb25zKTtcblx0XHRjb25zdCBlbmFibGVkU2tpbGxSZXNvdXJjZXMgPSBnZXRFbmFibGVkUmVzb3VyY2VzKHJlc29sdmVkUGF0aHMuc2tpbGxzKTtcblx0XHRjb25zdCBlbmFibGVkUHJvbXB0cyA9IGdldEVuYWJsZWRQYXRocyhyZXNvbHZlZFBhdGhzLnByb21wdHMpO1xuXHRcdGNvbnN0IGVuYWJsZWRUaGVtZXMgPSBnZXRFbmFibGVkUGF0aHMocmVzb2x2ZWRQYXRocy50aGVtZXMpO1xuXG5cdFx0Y29uc3QgbWFwU2tpbGxQYXRoID0gKHJlc291cmNlOiB7IHBhdGg6IHN0cmluZzsgbWV0YWRhdGE6IFBhdGhNZXRhZGF0YSB9KTogc3RyaW5nID0+IHtcblx0XHRcdGlmIChyZXNvdXJjZS5tZXRhZGF0YS5zb3VyY2UgIT09IFwiYXV0b1wiICYmIHJlc291cmNlLm1ldGFkYXRhLm9yaWdpbiAhPT0gXCJwYWNrYWdlXCIpIHtcblx0XHRcdFx0cmV0dXJuIHJlc291cmNlLnBhdGg7XG5cdFx0XHR9XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCBzdGF0cyA9IHN0YXRTeW5jKHJlc291cmNlLnBhdGgpO1xuXHRcdFx0XHRpZiAoIXN0YXRzLmlzRGlyZWN0b3J5KCkpIHtcblx0XHRcdFx0XHRyZXR1cm4gcmVzb3VyY2UucGF0aDtcblx0XHRcdFx0fVxuXHRcdFx0fSBjYXRjaCB7XG5cdFx0XHRcdHJldHVybiByZXNvdXJjZS5wYXRoO1xuXHRcdFx0fVxuXHRcdFx0Y29uc3Qgc2tpbGxGaWxlID0gam9pbihyZXNvdXJjZS5wYXRoLCBcIlNLSUxMLm1kXCIpO1xuXHRcdFx0aWYgKGV4aXN0c1N5bmMoc2tpbGxGaWxlKSkge1xuXHRcdFx0XHRpZiAoIXRoaXMucGF0aE1ldGFkYXRhLmhhcyhza2lsbEZpbGUpKSB7XG5cdFx0XHRcdFx0dGhpcy5wYXRoTWV0YWRhdGEuc2V0KHNraWxsRmlsZSwgcmVzb3VyY2UubWV0YWRhdGEpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdHJldHVybiBza2lsbEZpbGU7XG5cdFx0XHR9XG5cdFx0XHRyZXR1cm4gcmVzb3VyY2UucGF0aDtcblx0XHR9O1xuXG5cdFx0Y29uc3QgZW5hYmxlZFNraWxscyA9IGVuYWJsZWRTa2lsbFJlc291cmNlcy5tYXAobWFwU2tpbGxQYXRoKTtcblxuXHRcdC8vIEFkZCBDTEkgcGF0aHMgbWV0YWRhdGFcblx0XHRmb3IgKGNvbnN0IHIgb2YgY2xpRXh0ZW5zaW9uUGF0aHMuZXh0ZW5zaW9ucykge1xuXHRcdFx0aWYgKCF0aGlzLnBhdGhNZXRhZGF0YS5oYXMoci5wYXRoKSkge1xuXHRcdFx0XHR0aGlzLnBhdGhNZXRhZGF0YS5zZXQoci5wYXRoLCB7IHNvdXJjZTogXCJjbGlcIiwgc2NvcGU6IFwidGVtcG9yYXJ5XCIsIG9yaWdpbjogXCJ0b3AtbGV2ZWxcIiB9KTtcblx0XHRcdH1cblx0XHR9XG5cdFx0Zm9yIChjb25zdCByIG9mIGNsaUV4dGVuc2lvblBhdGhzLnNraWxscykge1xuXHRcdFx0aWYgKCF0aGlzLnBhdGhNZXRhZGF0YS5oYXMoci5wYXRoKSkge1xuXHRcdFx0XHR0aGlzLnBhdGhNZXRhZGF0YS5zZXQoci5wYXRoLCB7IHNvdXJjZTogXCJjbGlcIiwgc2NvcGU6IFwidGVtcG9yYXJ5XCIsIG9yaWdpbjogXCJ0b3AtbGV2ZWxcIiB9KTtcblx0XHRcdH1cblx0XHR9XG5cblx0XHRjb25zdCBjbGlFbmFibGVkRXh0ZW5zaW9ucyA9IGdldEVuYWJsZWRQYXRocyhjbGlFeHRlbnNpb25QYXRocy5leHRlbnNpb25zKTtcblx0XHRjb25zdCBjbGlFbmFibGVkU2tpbGxzID0gZ2V0RW5hYmxlZFBhdGhzKGNsaUV4dGVuc2lvblBhdGhzLnNraWxscyk7XG5cdFx0Y29uc3QgY2xpRW5hYmxlZFByb21wdHMgPSBnZXRFbmFibGVkUGF0aHMoY2xpRXh0ZW5zaW9uUGF0aHMucHJvbXB0cyk7XG5cdFx0Y29uc3QgY2xpRW5hYmxlZFRoZW1lcyA9IGdldEVuYWJsZWRQYXRocyhjbGlFeHRlbnNpb25QYXRocy50aGVtZXMpO1xuXG5cdFx0bGV0IGV4dGVuc2lvblBhdGhzID0gdGhpcy5ub0V4dGVuc2lvbnNcblx0XHRcdD8gY2xpRW5hYmxlZEV4dGVuc2lvbnNcblx0XHRcdDogdGhpcy5tZXJnZVBhdGhzKGNsaUVuYWJsZWRFeHRlbnNpb25zLCBlbmFibGVkRXh0ZW5zaW9ucyk7XG5cblx0XHQvLyBBcHBseSBwYXRoIHRyYW5zZm9ybSAoZGVwZW5kZW5jeSBzb3J0aW5nLCByZWdpc3RyeSBmaWx0ZXJpbmcpIGlmIHByb3ZpZGVkXG5cdFx0aWYgKHRoaXMuZXh0ZW5zaW9uUGF0aHNUcmFuc2Zvcm0pIHtcblx0XHRcdGNvbnN0IHRyYW5zZm9ybWVkID0gdGhpcy5leHRlbnNpb25QYXRoc1RyYW5zZm9ybShleHRlbnNpb25QYXRocyk7XG5cdFx0XHRleHRlbnNpb25QYXRocyA9IHRyYW5zZm9ybWVkLnBhdGhzO1xuXHRcdFx0aWYgKHRyYW5zZm9ybWVkLmRpYWdub3N0aWNzPy5sZW5ndGgpIHtcblx0XHRcdFx0Zm9yIChjb25zdCBtc2cgb2YgdHJhbnNmb3JtZWQuZGlhZ25vc3RpY3MpIHtcblx0XHRcdFx0XHRwcm9jZXNzLnN0ZGVyci53cml0ZShgW2V4dGVuc2lvbnNdICR7bXNnfVxcbmApO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0Y29uc3QgZXh0ZW5zaW9uc1Jlc3VsdCA9IGF3YWl0IGxvYWRFeHRlbnNpb25zKGV4dGVuc2lvblBhdGhzLCB0aGlzLmN3ZCwgdGhpcy5ldmVudEJ1cyk7XG5cdFx0Y29uc3QgaW5saW5lRXh0ZW5zaW9ucyA9IGF3YWl0IHRoaXMubG9hZEV4dGVuc2lvbkZhY3RvcmllcyhleHRlbnNpb25zUmVzdWx0LnJ1bnRpbWUpO1xuXHRcdGV4dGVuc2lvbnNSZXN1bHQuZXh0ZW5zaW9ucy5wdXNoKC4uLmlubGluZUV4dGVuc2lvbnMuZXh0ZW5zaW9ucyk7XG5cdFx0ZXh0ZW5zaW9uc1Jlc3VsdC5lcnJvcnMucHVzaCguLi5pbmxpbmVFeHRlbnNpb25zLmVycm9ycyk7XG5cblx0XHQvLyBEZXRlY3QgZXh0ZW5zaW9uIGNvbmZsaWN0cyAodG9vbHMsIGNvbW1hbmRzLCBmbGFncyB3aXRoIHNhbWUgbmFtZXMgZnJvbSBkaWZmZXJlbnQgZXh0ZW5zaW9ucylcblx0XHQvLyBLZWVwIGFsbCBleHRlbnNpb25zIGxvYWRlZC4gQ29uZmxpY3RzIGFyZSByZXBvcnRlZCBhcyBkaWFnbm9zdGljcywgYW5kIHByZWNlZGVuY2UgaXMgaGFuZGxlZCBieSBsb2FkIG9yZGVyLlxuXHRcdGNvbnN0IGNvbmZsaWN0cyA9IHRoaXMuZGV0ZWN0RXh0ZW5zaW9uQ29uZmxpY3RzKGV4dGVuc2lvbnNSZXN1bHQuZXh0ZW5zaW9ucyk7XG5cdFx0Zm9yIChjb25zdCBjb25mbGljdCBvZiBjb25mbGljdHMpIHtcblx0XHRcdGV4dGVuc2lvbnNSZXN1bHQuZXJyb3JzLnB1c2goeyBwYXRoOiBjb25mbGljdC5wYXRoLCBlcnJvcjogY29uZmxpY3QubWVzc2FnZSB9KTtcblx0XHR9XG5cblx0XHR0aGlzLmV4dGVuc2lvbnNSZXN1bHQgPSB0aGlzLmV4dGVuc2lvbnNPdmVycmlkZSA/IHRoaXMuZXh0ZW5zaW9uc092ZXJyaWRlKGV4dGVuc2lvbnNSZXN1bHQpIDogZXh0ZW5zaW9uc1Jlc3VsdDtcblxuXHRcdGNvbnN0IHNraWxsUGF0aHMgPSB0aGlzLm5vU2tpbGxzXG5cdFx0XHQ/IHRoaXMubWVyZ2VQYXRocyhjbGlFbmFibGVkU2tpbGxzLCB0aGlzLmFkZGl0aW9uYWxTa2lsbFBhdGhzKVxuXHRcdFx0OiB0aGlzLm1lcmdlUGF0aHMoWy4uLmVuYWJsZWRTa2lsbHMsIC4uLmNsaUVuYWJsZWRTa2lsbHNdLCB0aGlzLmFkZGl0aW9uYWxTa2lsbFBhdGhzKTtcblxuXHRcdHRoaXMubGFzdFNraWxsUGF0aHMgPSBza2lsbFBhdGhzO1xuXHRcdHRoaXMudXBkYXRlU2tpbGxzRnJvbVBhdGhzKHNraWxsUGF0aHMpO1xuXG5cdFx0Y29uc3QgcHJvbXB0UGF0aHMgPSB0aGlzLm5vUHJvbXB0VGVtcGxhdGVzXG5cdFx0XHQ/IHRoaXMubWVyZ2VQYXRocyhjbGlFbmFibGVkUHJvbXB0cywgdGhpcy5hZGRpdGlvbmFsUHJvbXB0VGVtcGxhdGVQYXRocylcblx0XHRcdDogdGhpcy5tZXJnZVBhdGhzKFsuLi5lbmFibGVkUHJvbXB0cywgLi4uY2xpRW5hYmxlZFByb21wdHNdLCB0aGlzLmFkZGl0aW9uYWxQcm9tcHRUZW1wbGF0ZVBhdGhzKTtcblxuXHRcdHRoaXMubGFzdFByb21wdFBhdGhzID0gcHJvbXB0UGF0aHM7XG5cdFx0dGhpcy51cGRhdGVQcm9tcHRzRnJvbVBhdGhzKHByb21wdFBhdGhzKTtcblxuXHRcdGNvbnN0IHRoZW1lUGF0aHMgPSB0aGlzLm5vVGhlbWVzXG5cdFx0XHQ/IHRoaXMubWVyZ2VQYXRocyhjbGlFbmFibGVkVGhlbWVzLCB0aGlzLmFkZGl0aW9uYWxUaGVtZVBhdGhzKVxuXHRcdFx0OiB0aGlzLm1lcmdlUGF0aHMoWy4uLmVuYWJsZWRUaGVtZXMsIC4uLmNsaUVuYWJsZWRUaGVtZXNdLCB0aGlzLmFkZGl0aW9uYWxUaGVtZVBhdGhzKTtcblxuXHRcdHRoaXMubGFzdFRoZW1lUGF0aHMgPSB0aGVtZVBhdGhzO1xuXHRcdHRoaXMudXBkYXRlVGhlbWVzRnJvbVBhdGhzKHRoZW1lUGF0aHMpO1xuXG5cdFx0Zm9yIChjb25zdCBleHRlbnNpb24gb2YgdGhpcy5leHRlbnNpb25zUmVzdWx0LmV4dGVuc2lvbnMpIHtcblx0XHRcdHRoaXMuYWRkRGVmYXVsdE1ldGFkYXRhRm9yUGF0aChleHRlbnNpb24ucGF0aCk7XG5cdFx0fVxuXG5cdFx0Y29uc3QgYWdlbnRzRmlsZXMgPSB7IGFnZW50c0ZpbGVzOiBsb2FkUHJvamVjdENvbnRleHRGaWxlcyh7IGN3ZDogdGhpcy5jd2QsIGFnZW50RGlyOiB0aGlzLmFnZW50RGlyIH0pIH07XG5cdFx0Y29uc3QgcmVzb2x2ZWRBZ2VudHNGaWxlcyA9IHRoaXMuYWdlbnRzRmlsZXNPdmVycmlkZSA/IHRoaXMuYWdlbnRzRmlsZXNPdmVycmlkZShhZ2VudHNGaWxlcykgOiBhZ2VudHNGaWxlcztcblx0XHR0aGlzLmFnZW50c0ZpbGVzID0gcmVzb2x2ZWRBZ2VudHNGaWxlcy5hZ2VudHNGaWxlcztcblxuXHRcdGNvbnN0IGJhc2VTeXN0ZW1Qcm9tcHQgPSByZXNvbHZlUHJvbXB0SW5wdXQoXG5cdFx0XHR0aGlzLnN5c3RlbVByb21wdFNvdXJjZSA/PyB0aGlzLmRpc2NvdmVyRmlsZUluU2VhcmNoUGF0aHMoXCJTWVNURU0ubWRcIiksXG5cdFx0XHRcInN5c3RlbSBwcm9tcHRcIixcblx0XHQpO1xuXHRcdHRoaXMuc3lzdGVtUHJvbXB0ID0gdGhpcy5zeXN0ZW1Qcm9tcHRPdmVycmlkZSA/IHRoaXMuc3lzdGVtUHJvbXB0T3ZlcnJpZGUoYmFzZVN5c3RlbVByb21wdCkgOiBiYXNlU3lzdGVtUHJvbXB0O1xuXG5cdFx0Y29uc3QgYXBwZW5kU291cmNlID0gdGhpcy5hcHBlbmRTeXN0ZW1Qcm9tcHRTb3VyY2UgPz8gdGhpcy5kaXNjb3ZlckZpbGVJblNlYXJjaFBhdGhzKFwiQVBQRU5EX1NZU1RFTS5tZFwiKTtcblx0XHRjb25zdCByZXNvbHZlZEFwcGVuZCA9IHJlc29sdmVQcm9tcHRJbnB1dChhcHBlbmRTb3VyY2UsIFwiYXBwZW5kIHN5c3RlbSBwcm9tcHRcIik7XG5cdFx0Y29uc3QgYmFzZUFwcGVuZCA9IHJlc29sdmVkQXBwZW5kID8gW3Jlc29sdmVkQXBwZW5kXSA6IFtdO1xuXHRcdHRoaXMuYXBwZW5kU3lzdGVtUHJvbXB0ID0gdGhpcy5hcHBlbmRTeXN0ZW1Qcm9tcHRPdmVycmlkZVxuXHRcdFx0PyB0aGlzLmFwcGVuZFN5c3RlbVByb21wdE92ZXJyaWRlKGJhc2VBcHBlbmQpXG5cdFx0XHQ6IGJhc2VBcHBlbmQ7XG5cdH1cblxuXHRwcml2YXRlIG5vcm1hbGl6ZUV4dGVuc2lvblBhdGhzKFxuXHRcdGVudHJpZXM6IEFycmF5PHsgcGF0aDogc3RyaW5nOyBtZXRhZGF0YTogUGF0aE1ldGFkYXRhIH0+LFxuXHQpOiBBcnJheTx7IHBhdGg6IHN0cmluZzsgbWV0YWRhdGE6IFBhdGhNZXRhZGF0YSB9PiB7XG5cdFx0cmV0dXJuIGVudHJpZXMubWFwKChlbnRyeSkgPT4gKHtcblx0XHRcdHBhdGg6IHRoaXMucmVzb2x2ZVJlc291cmNlUGF0aChlbnRyeS5wYXRoKSxcblx0XHRcdG1ldGFkYXRhOiBlbnRyeS5tZXRhZGF0YSxcblx0XHR9KSk7XG5cdH1cblxuXHRwcml2YXRlIHVwZGF0ZVNraWxsc0Zyb21QYXRocyhcblx0XHRza2lsbFBhdGhzOiBzdHJpbmdbXSxcblx0XHRleHRlbnNpb25QYXRoczogQXJyYXk8eyBwYXRoOiBzdHJpbmc7IG1ldGFkYXRhOiBQYXRoTWV0YWRhdGEgfT4gPSBbXSxcblx0KTogdm9pZCB7XG5cdFx0bGV0IHNraWxsc1Jlc3VsdDogeyBza2lsbHM6IFNraWxsW107IGRpYWdub3N0aWNzOiBSZXNvdXJjZURpYWdub3N0aWNbXSB9O1xuXHRcdGlmICh0aGlzLm5vU2tpbGxzICYmIHNraWxsUGF0aHMubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRza2lsbHNSZXN1bHQgPSB7IHNraWxsczogW10sIGRpYWdub3N0aWNzOiBbXSB9O1xuXHRcdH0gZWxzZSB7XG5cdFx0XHRza2lsbHNSZXN1bHQgPSBsb2FkU2tpbGxzKHtcblx0XHRcdFx0Y3dkOiB0aGlzLmN3ZCxcblx0XHRcdFx0YWdlbnREaXI6IHRoaXMuYWdlbnREaXIsXG5cdFx0XHRcdHNraWxsUGF0aHMsXG5cdFx0XHRcdGluY2x1ZGVEZWZhdWx0czogZmFsc2UsXG5cdFx0XHR9KTtcblx0XHR9XG5cdFx0Y29uc3QgcmVzb2x2ZWRTa2lsbHMgPSB0aGlzLnNraWxsc092ZXJyaWRlID8gdGhpcy5za2lsbHNPdmVycmlkZShza2lsbHNSZXN1bHQpIDogc2tpbGxzUmVzdWx0O1xuXHRcdHRoaXMuc2tpbGxzID0gcmVzb2x2ZWRTa2lsbHMuc2tpbGxzO1xuXHRcdHRoaXMuc2tpbGxEaWFnbm9zdGljcyA9IHJlc29sdmVkU2tpbGxzLmRpYWdub3N0aWNzO1xuXHRcdHRoaXMuYXBwbHlFeHRlbnNpb25NZXRhZGF0YShcblx0XHRcdGV4dGVuc2lvblBhdGhzLFxuXHRcdFx0dGhpcy5za2lsbHMubWFwKChza2lsbCkgPT4gc2tpbGwuZmlsZVBhdGgpLFxuXHRcdCk7XG5cdFx0Zm9yIChjb25zdCBza2lsbCBvZiB0aGlzLnNraWxscykge1xuXHRcdFx0dGhpcy5hZGREZWZhdWx0TWV0YWRhdGFGb3JQYXRoKHNraWxsLmZpbGVQYXRoKTtcblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIHVwZGF0ZVByb21wdHNGcm9tUGF0aHMoXG5cdFx0cHJvbXB0UGF0aHM6IHN0cmluZ1tdLFxuXHRcdGV4dGVuc2lvblBhdGhzOiBBcnJheTx7IHBhdGg6IHN0cmluZzsgbWV0YWRhdGE6IFBhdGhNZXRhZGF0YSB9PiA9IFtdLFxuXHQpOiB2b2lkIHtcblx0XHRsZXQgcHJvbXB0c1Jlc3VsdDogeyBwcm9tcHRzOiBQcm9tcHRUZW1wbGF0ZVtdOyBkaWFnbm9zdGljczogUmVzb3VyY2VEaWFnbm9zdGljW10gfTtcblx0XHRpZiAodGhpcy5ub1Byb21wdFRlbXBsYXRlcyAmJiBwcm9tcHRQYXRocy5sZW5ndGggPT09IDApIHtcblx0XHRcdHByb21wdHNSZXN1bHQgPSB7IHByb21wdHM6IFtdLCBkaWFnbm9zdGljczogW10gfTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0Y29uc3QgYWxsUHJvbXB0cyA9IGxvYWRQcm9tcHRUZW1wbGF0ZXMoe1xuXHRcdFx0XHRjd2Q6IHRoaXMuY3dkLFxuXHRcdFx0XHRhZ2VudERpcjogdGhpcy5hZ2VudERpcixcblx0XHRcdFx0cHJvbXB0UGF0aHMsXG5cdFx0XHRcdGluY2x1ZGVEZWZhdWx0czogZmFsc2UsXG5cdFx0XHR9KTtcblx0XHRcdGNvbnN0IGRlZHVwZWQgPSB0aGlzLmRlZHVwZVJlc291cmNlcyhhbGxQcm9tcHRzLCB7XG5cdFx0XHRcdGdldE5hbWU6IChwKSA9PiBwLm5hbWUsXG5cdFx0XHRcdGdldFBhdGg6IChwKSA9PiBwLmZpbGVQYXRoLFxuXHRcdFx0XHRyZXNvdXJjZVR5cGU6IFwicHJvbXB0XCIsXG5cdFx0XHRcdG5hbWVQcmVmaXg6IFwiL1wiLFxuXHRcdFx0fSk7XG5cdFx0XHRwcm9tcHRzUmVzdWx0ID0geyBwcm9tcHRzOiBkZWR1cGVkLml0ZW1zLCBkaWFnbm9zdGljczogZGVkdXBlZC5kaWFnbm9zdGljcyB9O1xuXHRcdH1cblx0XHRjb25zdCByZXNvbHZlZFByb21wdHMgPSB0aGlzLnByb21wdHNPdmVycmlkZSA/IHRoaXMucHJvbXB0c092ZXJyaWRlKHByb21wdHNSZXN1bHQpIDogcHJvbXB0c1Jlc3VsdDtcblx0XHR0aGlzLnByb21wdHMgPSByZXNvbHZlZFByb21wdHMucHJvbXB0cztcblx0XHR0aGlzLnByb21wdERpYWdub3N0aWNzID0gcmVzb2x2ZWRQcm9tcHRzLmRpYWdub3N0aWNzO1xuXHRcdHRoaXMuYXBwbHlFeHRlbnNpb25NZXRhZGF0YShcblx0XHRcdGV4dGVuc2lvblBhdGhzLFxuXHRcdFx0dGhpcy5wcm9tcHRzLm1hcCgocHJvbXB0KSA9PiBwcm9tcHQuZmlsZVBhdGgpLFxuXHRcdCk7XG5cdFx0Zm9yIChjb25zdCBwcm9tcHQgb2YgdGhpcy5wcm9tcHRzKSB7XG5cdFx0XHR0aGlzLmFkZERlZmF1bHRNZXRhZGF0YUZvclBhdGgocHJvbXB0LmZpbGVQYXRoKTtcblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIHVwZGF0ZVRoZW1lc0Zyb21QYXRocyhcblx0XHR0aGVtZVBhdGhzOiBzdHJpbmdbXSxcblx0XHRleHRlbnNpb25QYXRoczogQXJyYXk8eyBwYXRoOiBzdHJpbmc7IG1ldGFkYXRhOiBQYXRoTWV0YWRhdGEgfT4gPSBbXSxcblx0KTogdm9pZCB7XG5cdFx0bGV0IHRoZW1lc1Jlc3VsdDogeyB0aGVtZXM6IFRoZW1lW107IGRpYWdub3N0aWNzOiBSZXNvdXJjZURpYWdub3N0aWNbXSB9O1xuXHRcdGlmICh0aGlzLm5vVGhlbWVzICYmIHRoZW1lUGF0aHMubGVuZ3RoID09PSAwKSB7XG5cdFx0XHR0aGVtZXNSZXN1bHQgPSB7IHRoZW1lczogW10sIGRpYWdub3N0aWNzOiBbXSB9O1xuXHRcdH0gZWxzZSB7XG5cdFx0XHRjb25zdCBsb2FkZWQgPSB0aGlzLmxvYWRUaGVtZXModGhlbWVQYXRocywgZmFsc2UpO1xuXHRcdFx0Y29uc3QgZGVkdXBlZCA9IHRoaXMuZGVkdXBlUmVzb3VyY2VzKGxvYWRlZC50aGVtZXMsIHtcblx0XHRcdFx0Z2V0TmFtZTogKHQpID0+IHQubmFtZSA/PyBcInVubmFtZWRcIixcblx0XHRcdFx0Z2V0UGF0aDogKHQpID0+IHQuc291cmNlUGF0aCxcblx0XHRcdFx0cmVzb3VyY2VUeXBlOiBcInRoZW1lXCIsXG5cdFx0XHR9KTtcblx0XHRcdHRoZW1lc1Jlc3VsdCA9IHsgdGhlbWVzOiBkZWR1cGVkLml0ZW1zLCBkaWFnbm9zdGljczogWy4uLmxvYWRlZC5kaWFnbm9zdGljcywgLi4uZGVkdXBlZC5kaWFnbm9zdGljc10gfTtcblx0XHR9XG5cdFx0Y29uc3QgcmVzb2x2ZWRUaGVtZXMgPSB0aGlzLnRoZW1lc092ZXJyaWRlID8gdGhpcy50aGVtZXNPdmVycmlkZSh0aGVtZXNSZXN1bHQpIDogdGhlbWVzUmVzdWx0O1xuXHRcdHRoaXMudGhlbWVzID0gcmVzb2x2ZWRUaGVtZXMudGhlbWVzO1xuXHRcdHRoaXMudGhlbWVEaWFnbm9zdGljcyA9IHJlc29sdmVkVGhlbWVzLmRpYWdub3N0aWNzO1xuXHRcdGNvbnN0IHRoZW1lUGF0aHNXaXRoU291cmNlID0gdGhpcy50aGVtZXMuZmxhdE1hcCgodGhlbWUpID0+ICh0aGVtZS5zb3VyY2VQYXRoID8gW3RoZW1lLnNvdXJjZVBhdGhdIDogW10pKTtcblx0XHR0aGlzLmFwcGx5RXh0ZW5zaW9uTWV0YWRhdGEoZXh0ZW5zaW9uUGF0aHMsIHRoZW1lUGF0aHNXaXRoU291cmNlKTtcblx0XHRmb3IgKGNvbnN0IHRoZW1lIG9mIHRoaXMudGhlbWVzKSB7XG5cdFx0XHRpZiAodGhlbWUuc291cmNlUGF0aCkge1xuXHRcdFx0XHR0aGlzLmFkZERlZmF1bHRNZXRhZGF0YUZvclBhdGgodGhlbWUuc291cmNlUGF0aCk7XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBhcHBseUV4dGVuc2lvbk1ldGFkYXRhKFxuXHRcdGV4dGVuc2lvblBhdGhzOiBBcnJheTx7IHBhdGg6IHN0cmluZzsgbWV0YWRhdGE6IFBhdGhNZXRhZGF0YSB9Pixcblx0XHRyZXNvdXJjZVBhdGhzOiBzdHJpbmdbXSxcblx0KTogdm9pZCB7XG5cdFx0aWYgKGV4dGVuc2lvblBhdGhzLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGNvbnN0IG5vcm1hbGl6ZWQgPSBleHRlbnNpb25QYXRocy5tYXAoKGVudHJ5KSA9PiAoe1xuXHRcdFx0cGF0aDogcmVzb2x2ZShlbnRyeS5wYXRoKSxcblx0XHRcdG1ldGFkYXRhOiBlbnRyeS5tZXRhZGF0YSxcblx0XHR9KSk7XG5cblx0XHRmb3IgKGNvbnN0IGVudHJ5IG9mIG5vcm1hbGl6ZWQpIHtcblx0XHRcdGlmICghdGhpcy5wYXRoTWV0YWRhdGEuaGFzKGVudHJ5LnBhdGgpKSB7XG5cdFx0XHRcdHRoaXMucGF0aE1ldGFkYXRhLnNldChlbnRyeS5wYXRoLCBlbnRyeS5tZXRhZGF0YSk7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0Zm9yIChjb25zdCByZXNvdXJjZVBhdGggb2YgcmVzb3VyY2VQYXRocykge1xuXHRcdFx0Y29uc3Qgbm9ybWFsaXplZFJlc291cmNlUGF0aCA9IHJlc29sdmUocmVzb3VyY2VQYXRoKTtcblx0XHRcdGlmICh0aGlzLnBhdGhNZXRhZGF0YS5oYXMobm9ybWFsaXplZFJlc291cmNlUGF0aCkgfHwgdGhpcy5wYXRoTWV0YWRhdGEuaGFzKHJlc291cmNlUGF0aCkpIHtcblx0XHRcdFx0Y29udGludWU7XG5cdFx0XHR9XG5cdFx0XHRjb25zdCBtYXRjaCA9IG5vcm1hbGl6ZWQuZmluZChcblx0XHRcdFx0KGVudHJ5KSA9PlxuXHRcdFx0XHRcdG5vcm1hbGl6ZWRSZXNvdXJjZVBhdGggPT09IGVudHJ5LnBhdGggfHwgbm9ybWFsaXplZFJlc291cmNlUGF0aC5zdGFydHNXaXRoKGAke2VudHJ5LnBhdGh9JHtzZXB9YCksXG5cdFx0XHQpO1xuXHRcdFx0aWYgKG1hdGNoKSB7XG5cdFx0XHRcdHRoaXMucGF0aE1ldGFkYXRhLnNldChub3JtYWxpemVkUmVzb3VyY2VQYXRoLCBtYXRjaC5tZXRhZGF0YSk7XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBtZXJnZVBhdGhzKHByaW1hcnk6IHN0cmluZ1tdLCBhZGRpdGlvbmFsOiBzdHJpbmdbXSk6IHN0cmluZ1tdIHtcblx0XHRjb25zdCBtZXJnZWQ6IHN0cmluZ1tdID0gW107XG5cdFx0Y29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG5cdFx0Zm9yIChjb25zdCBwIG9mIFsuLi5wcmltYXJ5LCAuLi5hZGRpdGlvbmFsXSkge1xuXHRcdFx0Y29uc3QgcmVzb2x2ZWQgPSB0aGlzLnJlc29sdmVSZXNvdXJjZVBhdGgocCk7XG5cdFx0XHRpZiAoc2Vlbi5oYXMocmVzb2x2ZWQpKSBjb250aW51ZTtcblx0XHRcdHNlZW4uYWRkKHJlc29sdmVkKTtcblx0XHRcdG1lcmdlZC5wdXNoKHJlc29sdmVkKTtcblx0XHR9XG5cblx0XHRyZXR1cm4gbWVyZ2VkO1xuXHR9XG5cblx0cHJpdmF0ZSByZXNvbHZlUmVzb3VyY2VQYXRoKHA6IHN0cmluZyk6IHN0cmluZyB7XG5cdFx0Y29uc3QgdHJpbW1lZCA9IHAudHJpbSgpO1xuXHRcdGxldCBleHBhbmRlZCA9IHRyaW1tZWQ7XG5cdFx0aWYgKHRyaW1tZWQgPT09IFwiflwiKSB7XG5cdFx0XHRleHBhbmRlZCA9IGhvbWVkaXIoKTtcblx0XHR9IGVsc2UgaWYgKHRyaW1tZWQuc3RhcnRzV2l0aChcIn4vXCIpKSB7XG5cdFx0XHRleHBhbmRlZCA9IGpvaW4oaG9tZWRpcigpLCB0cmltbWVkLnNsaWNlKDIpKTtcblx0XHR9IGVsc2UgaWYgKHRyaW1tZWQuc3RhcnRzV2l0aChcIn5cIikpIHtcblx0XHRcdGV4cGFuZGVkID0gam9pbihob21lZGlyKCksIHRyaW1tZWQuc2xpY2UoMSkpO1xuXHRcdH1cblx0XHRyZXR1cm4gcmVzb2x2ZSh0aGlzLmN3ZCwgZXhwYW5kZWQpO1xuXHR9XG5cblx0cHJpdmF0ZSBsb2FkVGhlbWVzKFxuXHRcdHBhdGhzOiBzdHJpbmdbXSxcblx0XHRpbmNsdWRlRGVmYXVsdHM6IGJvb2xlYW4gPSB0cnVlLFxuXHQpOiB7XG5cdFx0dGhlbWVzOiBUaGVtZVtdO1xuXHRcdGRpYWdub3N0aWNzOiBSZXNvdXJjZURpYWdub3N0aWNbXTtcblx0fSB7XG5cdFx0Y29uc3QgdGhlbWVzOiBUaGVtZVtdID0gW107XG5cdFx0Y29uc3QgZGlhZ25vc3RpY3M6IFJlc291cmNlRGlhZ25vc3RpY1tdID0gW107XG5cdFx0aWYgKGluY2x1ZGVEZWZhdWx0cykge1xuXHRcdFx0Y29uc3QgZGVmYXVsdERpcnMgPSBbam9pbih0aGlzLmFnZW50RGlyLCBcInRoZW1lc1wiKSwgam9pbih0aGlzLmN3ZCwgQ09ORklHX0RJUl9OQU1FLCBcInRoZW1lc1wiKV07XG5cblx0XHRcdGZvciAoY29uc3QgZGlyIG9mIGRlZmF1bHREaXJzKSB7XG5cdFx0XHRcdHRoaXMubG9hZFRoZW1lc0Zyb21EaXIoZGlyLCB0aGVtZXMsIGRpYWdub3N0aWNzKTtcblx0XHRcdH1cblx0XHR9XG5cblx0XHRmb3IgKGNvbnN0IHAgb2YgcGF0aHMpIHtcblx0XHRcdGNvbnN0IHJlc29sdmVkID0gcmVzb2x2ZSh0aGlzLmN3ZCwgcCk7XG5cdFx0XHRpZiAoIWV4aXN0c1N5bmMocmVzb2x2ZWQpKSB7XG5cdFx0XHRcdGRpYWdub3N0aWNzLnB1c2goeyB0eXBlOiBcIndhcm5pbmdcIiwgbWVzc2FnZTogXCJ0aGVtZSBwYXRoIGRvZXMgbm90IGV4aXN0XCIsIHBhdGg6IHJlc29sdmVkIH0pO1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblxuXHRcdFx0dHJ5IHtcblx0XHRcdFx0Y29uc3Qgc3RhdHMgPSBzdGF0U3luYyhyZXNvbHZlZCk7XG5cdFx0XHRcdGlmIChzdGF0cy5pc0RpcmVjdG9yeSgpKSB7XG5cdFx0XHRcdFx0dGhpcy5sb2FkVGhlbWVzRnJvbURpcihyZXNvbHZlZCwgdGhlbWVzLCBkaWFnbm9zdGljcyk7XG5cdFx0XHRcdH0gZWxzZSBpZiAoc3RhdHMuaXNGaWxlKCkgJiYgcmVzb2x2ZWQuZW5kc1dpdGgoXCIuanNvblwiKSkge1xuXHRcdFx0XHRcdHRoaXMubG9hZFRoZW1lRnJvbUZpbGUocmVzb2x2ZWQsIHRoZW1lcywgZGlhZ25vc3RpY3MpO1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdGRpYWdub3N0aWNzLnB1c2goeyB0eXBlOiBcIndhcm5pbmdcIiwgbWVzc2FnZTogXCJ0aGVtZSBwYXRoIGlzIG5vdCBhIGpzb24gZmlsZVwiLCBwYXRoOiByZXNvbHZlZCB9KTtcblx0XHRcdFx0fVxuXHRcdFx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRcdFx0Y29uc3QgbWVzc2FnZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogXCJmYWlsZWQgdG8gcmVhZCB0aGVtZSBwYXRoXCI7XG5cdFx0XHRcdGRpYWdub3N0aWNzLnB1c2goeyB0eXBlOiBcIndhcm5pbmdcIiwgbWVzc2FnZSwgcGF0aDogcmVzb2x2ZWQgfSk7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0cmV0dXJuIHsgdGhlbWVzLCBkaWFnbm9zdGljcyB9O1xuXHR9XG5cblx0cHJpdmF0ZSBsb2FkVGhlbWVzRnJvbURpcihkaXI6IHN0cmluZywgdGhlbWVzOiBUaGVtZVtdLCBkaWFnbm9zdGljczogUmVzb3VyY2VEaWFnbm9zdGljW10pOiB2b2lkIHtcblx0XHRpZiAoIWV4aXN0c1N5bmMoZGlyKSkge1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBlbnRyaWVzID0gcmVhZGRpclN5bmMoZGlyLCB7IHdpdGhGaWxlVHlwZXM6IHRydWUgfSk7XG5cdFx0XHRmb3IgKGNvbnN0IGVudHJ5IG9mIGVudHJpZXMpIHtcblx0XHRcdFx0bGV0IGlzRmlsZSA9IGVudHJ5LmlzRmlsZSgpO1xuXHRcdFx0XHRpZiAoZW50cnkuaXNTeW1ib2xpY0xpbmsoKSkge1xuXHRcdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0XHRpc0ZpbGUgPSBzdGF0U3luYyhqb2luKGRpciwgZW50cnkubmFtZSkpLmlzRmlsZSgpO1xuXHRcdFx0XHRcdH0gY2F0Y2gge1xuXHRcdFx0XHRcdFx0Y29udGludWU7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHRcdGlmICghaXNGaWxlKSB7XG5cdFx0XHRcdFx0Y29udGludWU7XG5cdFx0XHRcdH1cblx0XHRcdFx0aWYgKCFlbnRyeS5uYW1lLmVuZHNXaXRoKFwiLmpzb25cIikpIHtcblx0XHRcdFx0XHRjb250aW51ZTtcblx0XHRcdFx0fVxuXHRcdFx0XHR0aGlzLmxvYWRUaGVtZUZyb21GaWxlKGpvaW4oZGlyLCBlbnRyeS5uYW1lKSwgdGhlbWVzLCBkaWFnbm9zdGljcyk7XG5cdFx0XHR9XG5cdFx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRcdGNvbnN0IG1lc3NhZ2UgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFwiZmFpbGVkIHRvIHJlYWQgdGhlbWUgZGlyZWN0b3J5XCI7XG5cdFx0XHRkaWFnbm9zdGljcy5wdXNoKHsgdHlwZTogXCJ3YXJuaW5nXCIsIG1lc3NhZ2UsIHBhdGg6IGRpciB9KTtcblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIGxvYWRUaGVtZUZyb21GaWxlKGZpbGVQYXRoOiBzdHJpbmcsIHRoZW1lczogVGhlbWVbXSwgZGlhZ25vc3RpY3M6IFJlc291cmNlRGlhZ25vc3RpY1tdKTogdm9pZCB7XG5cdFx0dHJ5IHtcblx0XHRcdHRoZW1lcy5wdXNoKGxvYWRUaGVtZUZyb21QYXRoKGZpbGVQYXRoKSk7XG5cdFx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRcdGNvbnN0IG1lc3NhZ2UgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFwiZmFpbGVkIHRvIGxvYWQgdGhlbWVcIjtcblx0XHRcdGRpYWdub3N0aWNzLnB1c2goeyB0eXBlOiBcIndhcm5pbmdcIiwgbWVzc2FnZSwgcGF0aDogZmlsZVBhdGggfSk7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBhc3luYyBsb2FkRXh0ZW5zaW9uRmFjdG9yaWVzKHJ1bnRpbWU6IEV4dGVuc2lvblJ1bnRpbWUpOiBQcm9taXNlPHtcblx0XHRleHRlbnNpb25zOiBFeHRlbnNpb25bXTtcblx0XHRlcnJvcnM6IEFycmF5PHsgcGF0aDogc3RyaW5nOyBlcnJvcjogc3RyaW5nIH0+O1xuXHR9PiB7XG5cdFx0Y29uc3QgZXh0ZW5zaW9uczogRXh0ZW5zaW9uW10gPSBbXTtcblx0XHRjb25zdCBlcnJvcnM6IEFycmF5PHsgcGF0aDogc3RyaW5nOyBlcnJvcjogc3RyaW5nIH0+ID0gW107XG5cblx0XHRmb3IgKGNvbnN0IFtpbmRleCwgZmFjdG9yeV0gb2YgdGhpcy5leHRlbnNpb25GYWN0b3JpZXMuZW50cmllcygpKSB7XG5cdFx0XHRjb25zdCBleHRlbnNpb25QYXRoID0gYDxpbmxpbmU6JHtpbmRleCArIDF9PmA7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCBleHRlbnNpb24gPSBhd2FpdCBsb2FkRXh0ZW5zaW9uRnJvbUZhY3RvcnkoZmFjdG9yeSwgdGhpcy5jd2QsIHRoaXMuZXZlbnRCdXMsIHJ1bnRpbWUsIGV4dGVuc2lvblBhdGgpO1xuXHRcdFx0XHRleHRlbnNpb25zLnB1c2goZXh0ZW5zaW9uKTtcblx0XHRcdH0gY2F0Y2ggKGVycm9yKSB7XG5cdFx0XHRcdGNvbnN0IG1lc3NhZ2UgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFwiZmFpbGVkIHRvIGxvYWQgZXh0ZW5zaW9uXCI7XG5cdFx0XHRcdGVycm9ycy5wdXNoKHsgcGF0aDogZXh0ZW5zaW9uUGF0aCwgZXJyb3I6IG1lc3NhZ2UgfSk7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0cmV0dXJuIHsgZXh0ZW5zaW9ucywgZXJyb3JzIH07XG5cdH1cblxuXHRwcml2YXRlIGRlZHVwZVJlc291cmNlczxUPihcblx0XHRpdGVtczogVFtdLFxuXHRcdG9wdGlvbnM6IHtcblx0XHRcdGdldE5hbWU6IChpdGVtOiBUKSA9PiBzdHJpbmc7XG5cdFx0XHRnZXRQYXRoOiAoaXRlbTogVCkgPT4gc3RyaW5nIHwgdW5kZWZpbmVkO1xuXHRcdFx0cmVzb3VyY2VUeXBlOiBSZXNvdXJjZUNvbGxpc2lvbltcInJlc291cmNlVHlwZVwiXTtcblx0XHRcdG5hbWVQcmVmaXg/OiBzdHJpbmc7XG5cdFx0fSxcblx0KTogeyBpdGVtczogVFtdOyBkaWFnbm9zdGljczogUmVzb3VyY2VEaWFnbm9zdGljW10gfSB7XG5cdFx0Y29uc3Qgc2VlbiA9IG5ldyBNYXA8c3RyaW5nLCBUPigpO1xuXHRcdGNvbnN0IGRpYWdub3N0aWNzOiBSZXNvdXJjZURpYWdub3N0aWNbXSA9IFtdO1xuXHRcdGNvbnN0IHsgZ2V0TmFtZSwgZ2V0UGF0aCwgcmVzb3VyY2VUeXBlLCBuYW1lUHJlZml4ID0gXCJcIiB9ID0gb3B0aW9ucztcblxuXHRcdGZvciAoY29uc3QgaXRlbSBvZiBpdGVtcykge1xuXHRcdFx0Y29uc3QgbmFtZSA9IGdldE5hbWUoaXRlbSk7XG5cdFx0XHRjb25zdCBleGlzdGluZyA9IHNlZW4uZ2V0KG5hbWUpO1xuXHRcdFx0aWYgKGV4aXN0aW5nKSB7XG5cdFx0XHRcdGRpYWdub3N0aWNzLnB1c2goe1xuXHRcdFx0XHRcdHR5cGU6IFwiY29sbGlzaW9uXCIsXG5cdFx0XHRcdFx0bWVzc2FnZTogYG5hbWUgXCIke25hbWVQcmVmaXh9JHtuYW1lfVwiIGNvbGxpc2lvbmAsXG5cdFx0XHRcdFx0cGF0aDogZ2V0UGF0aChpdGVtKSxcblx0XHRcdFx0XHRjb2xsaXNpb246IHtcblx0XHRcdFx0XHRcdHJlc291cmNlVHlwZSxcblx0XHRcdFx0XHRcdG5hbWUsXG5cdFx0XHRcdFx0XHR3aW5uZXJQYXRoOiBnZXRQYXRoKGV4aXN0aW5nKSA/PyBcIjxidWlsdGluPlwiLFxuXHRcdFx0XHRcdFx0bG9zZXJQYXRoOiBnZXRQYXRoKGl0ZW0pID8/IFwiPGJ1aWx0aW4+XCIsXG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0fSk7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRzZWVuLnNldChuYW1lLCBpdGVtKTtcblx0XHRcdH1cblx0XHR9XG5cblx0XHRyZXR1cm4geyBpdGVtczogQXJyYXkuZnJvbShzZWVuLnZhbHVlcygpKSwgZGlhZ25vc3RpY3MgfTtcblx0fVxuXG5cdHByaXZhdGUgZGlzY292ZXJGaWxlSW5TZWFyY2hQYXRocyhmaWxlbmFtZTogc3RyaW5nKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcblx0XHRjb25zdCBzZWFyY2hEaXJzID0gW2pvaW4odGhpcy5jd2QsIENPTkZJR19ESVJfTkFNRSksIHRoaXMuYWdlbnREaXJdO1xuXHRcdGZvciAoY29uc3QgZGlyIG9mIHNlYXJjaERpcnMpIHtcblx0XHRcdGNvbnN0IGZpbGVQYXRoID0gam9pbihkaXIsIGZpbGVuYW1lKTtcblx0XHRcdGlmIChleGlzdHNTeW5jKGZpbGVQYXRoKSkge1xuXHRcdFx0XHRyZXR1cm4gZmlsZVBhdGg7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdHJldHVybiB1bmRlZmluZWQ7XG5cdH1cblxuXHRwcml2YXRlIGFkZERlZmF1bHRNZXRhZGF0YUZvclBhdGgoZmlsZVBhdGg6IHN0cmluZyk6IHZvaWQge1xuXHRcdGlmICghZmlsZVBhdGggfHwgZmlsZVBhdGguc3RhcnRzV2l0aChcIjxcIikpIHtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRjb25zdCBub3JtYWxpemVkUGF0aCA9IHJlc29sdmUoZmlsZVBhdGgpO1xuXHRcdGlmICh0aGlzLnBhdGhNZXRhZGF0YS5oYXMobm9ybWFsaXplZFBhdGgpIHx8IHRoaXMucGF0aE1ldGFkYXRhLmhhcyhmaWxlUGF0aCkpIHtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRjb25zdCBhZ2VudFJvb3RzID0gW1xuXHRcdFx0am9pbih0aGlzLmFnZW50RGlyLCBcInNraWxsc1wiKSxcblx0XHRcdGpvaW4odGhpcy5hZ2VudERpciwgXCJwcm9tcHRzXCIpLFxuXHRcdFx0am9pbih0aGlzLmFnZW50RGlyLCBcInRoZW1lc1wiKSxcblx0XHRcdGpvaW4odGhpcy5hZ2VudERpciwgXCJleHRlbnNpb25zXCIpLFxuXHRcdF07XG5cdFx0Y29uc3QgcHJvamVjdFJvb3RzID0gW1xuXHRcdFx0am9pbih0aGlzLmN3ZCwgQ09ORklHX0RJUl9OQU1FLCBcInNraWxsc1wiKSxcblx0XHRcdGpvaW4odGhpcy5jd2QsIENPTkZJR19ESVJfTkFNRSwgXCJwcm9tcHRzXCIpLFxuXHRcdFx0am9pbih0aGlzLmN3ZCwgQ09ORklHX0RJUl9OQU1FLCBcInRoZW1lc1wiKSxcblx0XHRcdGpvaW4odGhpcy5jd2QsIENPTkZJR19ESVJfTkFNRSwgXCJleHRlbnNpb25zXCIpLFxuXHRcdF07XG5cblx0XHRmb3IgKGNvbnN0IHJvb3Qgb2YgYWdlbnRSb290cykge1xuXHRcdFx0aWYgKHRoaXMuaXNVbmRlclBhdGgobm9ybWFsaXplZFBhdGgsIHJvb3QpKSB7XG5cdFx0XHRcdHRoaXMucGF0aE1ldGFkYXRhLnNldChub3JtYWxpemVkUGF0aCwgeyBzb3VyY2U6IFwibG9jYWxcIiwgc2NvcGU6IFwidXNlclwiLCBvcmlnaW46IFwidG9wLWxldmVsXCIgfSk7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblx0XHR9XG5cblx0XHRmb3IgKGNvbnN0IHJvb3Qgb2YgcHJvamVjdFJvb3RzKSB7XG5cdFx0XHRpZiAodGhpcy5pc1VuZGVyUGF0aChub3JtYWxpemVkUGF0aCwgcm9vdCkpIHtcblx0XHRcdFx0dGhpcy5wYXRoTWV0YWRhdGEuc2V0KG5vcm1hbGl6ZWRQYXRoLCB7IHNvdXJjZTogXCJsb2NhbFwiLCBzY29wZTogXCJwcm9qZWN0XCIsIG9yaWdpbjogXCJ0b3AtbGV2ZWxcIiB9KTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgaXNVbmRlclBhdGgodGFyZ2V0OiBzdHJpbmcsIHJvb3Q6IHN0cmluZyk6IGJvb2xlYW4ge1xuXHRcdGNvbnN0IG5vcm1hbGl6ZWRSb290ID0gcmVzb2x2ZShyb290KTtcblx0XHRpZiAodGFyZ2V0ID09PSBub3JtYWxpemVkUm9vdCkge1xuXHRcdFx0cmV0dXJuIHRydWU7XG5cdFx0fVxuXHRcdGNvbnN0IHByZWZpeCA9IG5vcm1hbGl6ZWRSb290LmVuZHNXaXRoKHNlcCkgPyBub3JtYWxpemVkUm9vdCA6IGAke25vcm1hbGl6ZWRSb290fSR7c2VwfWA7XG5cdFx0cmV0dXJuIHRhcmdldC5zdGFydHNXaXRoKHByZWZpeCk7XG5cdH1cblxuXHQvKipcblx0ICogRXh0cmFjdCB0aGUgZXh0ZW5zaW9uIG5hbWUgZnJvbSBpdHMgcGF0aC5cblx0ICogRm9yIHJvb3QtbGV2ZWwgZmlsZXM6IGJhc2VuYW1lIHdpdGhvdXQgZXh0ZW5zaW9uIChlLmcuIFwic2VhcmNoLXRoZS13ZWIudHNcIiBcdTIxOTIgXCJzZWFyY2gtdGhlLXdlYlwiKVxuXHQgKiBGb3Igc3ViZGlyZWN0b3J5IGV4dGVuc2lvbnM6IHRoZSBkaXJlY3RvcnkgbmFtZSAoZS5nLiBcIi9wYXRoL3RvL2dzZC9pbmRleC50c1wiIFx1MjE5MiBcImdzZFwiKVxuXHQgKi9cblx0cHJpdmF0ZSBnZXRFeHRlbnNpb25OYW1lRnJvbVBhdGgoZXh0UGF0aDogc3RyaW5nKTogc3RyaW5nIHtcblx0XHRjb25zdCBiYXNlID0gYmFzZW5hbWUoZXh0UGF0aCk7XG5cdFx0aWYgKGJhc2UgPT09IFwiaW5kZXguanNcIiB8fCBiYXNlID09PSBcImluZGV4LnRzXCIpIHtcblx0XHRcdHJldHVybiBiYXNlbmFtZShkaXJuYW1lKGV4dFBhdGgpKTtcblx0XHR9XG5cdFx0cmV0dXJuIGJhc2UucmVwbGFjZSgvXFwuKD86dHN8anMpJC8sIFwiXCIpO1xuXHR9XG5cblx0cHJpdmF0ZSBkZXRlY3RFeHRlbnNpb25Db25mbGljdHMoZXh0ZW5zaW9uczogRXh0ZW5zaW9uW10pOiBBcnJheTx7IHBhdGg6IHN0cmluZzsgbWVzc2FnZTogc3RyaW5nIH0+IHtcblx0XHRyZXR1cm4gZGV0ZWN0RXh0ZW5zaW9uQ29uZmxpY3RzKGV4dGVuc2lvbnMsIHRoaXMuYnVuZGxlZEV4dGVuc2lvbktleXMsIGpvaW4odGhpcy5hZ2VudERpciwgXCJleHRlbnNpb25zXCIpKTtcblx0fVxufVxuXG4vKipcbiAqIEV4dHJhY3QgdGhlIGV4dGVuc2lvbiBkaXJlY3RvcnkgbmFtZSAoa2V5KSBmcm9tIGEgZnVsbCBleHRlbnNpb24gcGF0aC5cbiAqIEdpdmVuIGV4dGVuc2lvbnNEaXIgYC9ob21lL3VzZXIvLmdzZC9hZ2VudC9leHRlbnNpb25zYCBhbmRcbiAqIG93bmVyUGF0aCBgL2hvbWUvdXNlci8uZ3NkL2FnZW50L2V4dGVuc2lvbnMvbWNwLWNsaWVudC9pbmRleC5qc2AsXG4gKiByZXR1cm5zIGBcIm1jcC1jbGllbnRcImAuICBSZXR1cm5zIGB1bmRlZmluZWRgIHdoZW4gdGhlIHBhdGggaXMgbm90XG4gKiB1bmRlciBleHRlbnNpb25zRGlyLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZXh0cmFjdEV4dGVuc2lvbktleShvd25lclBhdGg6IHN0cmluZywgZXh0ZW5zaW9uc0Rpcjogc3RyaW5nKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcblx0Y29uc3Qgbm9ybWFsaXplZERpciA9IHJlc29sdmUoZXh0ZW5zaW9uc0Rpcik7XG5cdGNvbnN0IG5vcm1hbGl6ZWRQYXRoID0gcmVzb2x2ZShvd25lclBhdGgpO1xuXHRjb25zdCBwcmVmaXggPSBub3JtYWxpemVkRGlyLmVuZHNXaXRoKHNlcCkgPyBub3JtYWxpemVkRGlyIDogYCR7bm9ybWFsaXplZERpcn0ke3NlcH1gO1xuXHRpZiAoIW5vcm1hbGl6ZWRQYXRoLnN0YXJ0c1dpdGgocHJlZml4KSkge1xuXHRcdHJldHVybiB1bmRlZmluZWQ7XG5cdH1cblx0Y29uc3QgcmVsUGF0aCA9IHJlbGF0aXZlKG5vcm1hbGl6ZWREaXIsIG5vcm1hbGl6ZWRQYXRoKTtcblx0Y29uc3QgZmlyc3RTZWdtZW50ID0gcmVsUGF0aC5zcGxpdCgvW1xcXFwvXS8pWzBdO1xuXHRyZXR1cm4gZmlyc3RTZWdtZW50Py5yZXBsYWNlKC9cXC4oPzp0c3xqcykkLywgXCJcIikgfHwgdW5kZWZpbmVkO1xufVxuXG4vKipcbiAqIERldGVjdCB0b29sL2NvbW1hbmQvZmxhZyBuYW1lIGNvbGxpc2lvbnMgYWNyb3NzIGxvYWRlZCBleHRlbnNpb25zLlxuICpcbiAqIFdoZW4gdGhlIGZpcnN0LXJlZ2lzdGVyZWQgb3duZXIgb2YgYSBuYW1lIGlzIGEgYnVuZGxlZCBleHRlbnNpb25cbiAqIChpdHMga2V5IGFwcGVhcnMgaW4gYGJ1bmRsZWRFeHRlbnNpb25LZXlzYCksIHRoZSBjb25mbGljdCBtZXNzYWdlXG4gKiBpbmNsdWRlcyBhIFwic3VwZXJzZWRlc1wiIGhpbnQgc28gZG93bnN0cmVhbSBkaXNwbGF5IGNhbiBkb3duZ3JhZGUgdGhlXG4gKiBzZXZlcml0eSBmcm9tIFwiRXh0ZW5zaW9uIGxvYWQgZXJyb3JcIiB0byBcIkV4dGVuc2lvbiBjb25mbGljdFwiLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZGV0ZWN0RXh0ZW5zaW9uQ29uZmxpY3RzKFxuXHRleHRlbnNpb25zOiBFeHRlbnNpb25bXSxcblx0YnVuZGxlZEV4dGVuc2lvbktleXM6IFNldDxzdHJpbmc+LFxuXHRleHRlbnNpb25zRGlyOiBzdHJpbmcsXG4pOiBBcnJheTx7IHBhdGg6IHN0cmluZzsgbWVzc2FnZTogc3RyaW5nIH0+IHtcblx0Y29uc3QgY29uZmxpY3RzOiBBcnJheTx7IHBhdGg6IHN0cmluZzsgbWVzc2FnZTogc3RyaW5nIH0+ID0gW107XG5cblx0Y29uc3QgdG9vbE93bmVycyA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG5cdGNvbnN0IGNvbW1hbmRPd25lcnMgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuXHRjb25zdCBmbGFnT3duZXJzID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcblxuXHRjb25zdCBpc0J1bmRsZWQgPSAob3duZXJQYXRoOiBzdHJpbmcpOiBib29sZWFuID0+IHtcblx0XHRjb25zdCBrZXkgPSBleHRyYWN0RXh0ZW5zaW9uS2V5KG93bmVyUGF0aCwgZXh0ZW5zaW9uc0Rpcik7XG5cdFx0cmV0dXJuIGtleSAhPT0gdW5kZWZpbmVkICYmIGJ1bmRsZWRFeHRlbnNpb25LZXlzLmhhcyhrZXkpO1xuXHR9O1xuXG5cdGZvciAoY29uc3QgZXh0IG9mIGV4dGVuc2lvbnMpIHtcblx0XHRmb3IgKGNvbnN0IHRvb2xOYW1lIG9mIGV4dC50b29scy5rZXlzKCkpIHtcblx0XHRcdGNvbnN0IGV4aXN0aW5nT3duZXIgPSB0b29sT3duZXJzLmdldCh0b29sTmFtZSk7XG5cdFx0XHRpZiAoZXhpc3RpbmdPd25lciAmJiBleGlzdGluZ093bmVyICE9PSBleHQucGF0aCkge1xuXHRcdFx0XHRjb25zdCBoaW50ID0gaXNCdW5kbGVkKGV4aXN0aW5nT3duZXIpXG5cdFx0XHRcdFx0PyBgIChidWlsdC1pbiB0b29sIHN1cGVyc2VkZXMgXHUyMDE0IGNvbnNpZGVyIHJlbW92aW5nICR7ZXh0LnBhdGh9KWBcblx0XHRcdFx0XHQ6IFwiXCI7XG5cdFx0XHRcdGNvbmZsaWN0cy5wdXNoKHtcblx0XHRcdFx0XHRwYXRoOiBleHQucGF0aCxcblx0XHRcdFx0XHRtZXNzYWdlOiBgVG9vbCBcIiR7dG9vbE5hbWV9XCIgY29uZmxpY3RzIHdpdGggJHtleGlzdGluZ093bmVyfSR7aGludH1gLFxuXHRcdFx0XHR9KTtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdHRvb2xPd25lcnMuc2V0KHRvb2xOYW1lLCBleHQucGF0aCk7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0Zm9yIChjb25zdCBjb21tYW5kTmFtZSBvZiBleHQuY29tbWFuZHMua2V5cygpKSB7XG5cdFx0XHRjb25zdCBleGlzdGluZ093bmVyID0gY29tbWFuZE93bmVycy5nZXQoY29tbWFuZE5hbWUpO1xuXHRcdFx0aWYgKGV4aXN0aW5nT3duZXIgJiYgZXhpc3RpbmdPd25lciAhPT0gZXh0LnBhdGgpIHtcblx0XHRcdFx0Y29uc3QgaGludCA9IGlzQnVuZGxlZChleGlzdGluZ093bmVyKVxuXHRcdFx0XHRcdD8gYCAoYnVpbHQtaW4gY29tbWFuZCBzdXBlcnNlZGVzIFx1MjAxNCBjb25zaWRlciByZW1vdmluZyAke2V4dC5wYXRofSlgXG5cdFx0XHRcdFx0OiBcIlwiO1xuXHRcdFx0XHRjb25mbGljdHMucHVzaCh7XG5cdFx0XHRcdFx0cGF0aDogZXh0LnBhdGgsXG5cdFx0XHRcdFx0bWVzc2FnZTogYENvbW1hbmQgXCIvJHtjb21tYW5kTmFtZX1cIiBjb25mbGljdHMgd2l0aCAke2V4aXN0aW5nT3duZXJ9JHtoaW50fWAsXG5cdFx0XHRcdH0pO1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0Y29tbWFuZE93bmVycy5zZXQoY29tbWFuZE5hbWUsIGV4dC5wYXRoKTtcblx0XHRcdH1cblx0XHR9XG5cblx0XHRmb3IgKGNvbnN0IGZsYWdOYW1lIG9mIGV4dC5mbGFncy5rZXlzKCkpIHtcblx0XHRcdGNvbnN0IGV4aXN0aW5nT3duZXIgPSBmbGFnT3duZXJzLmdldChmbGFnTmFtZSk7XG5cdFx0XHRpZiAoZXhpc3RpbmdPd25lciAmJiBleGlzdGluZ093bmVyICE9PSBleHQucGF0aCkge1xuXHRcdFx0XHRjb25mbGljdHMucHVzaCh7XG5cdFx0XHRcdFx0cGF0aDogZXh0LnBhdGgsXG5cdFx0XHRcdFx0bWVzc2FnZTogYEZsYWcgXCItLSR7ZmxhZ05hbWV9XCIgY29uZmxpY3RzIHdpdGggJHtleGlzdGluZ093bmVyfWAsXG5cdFx0XHRcdH0pO1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0ZmxhZ093bmVycy5zZXQoZmxhZ05hbWUsIGV4dC5wYXRoKTtcblx0XHRcdH1cblx0XHR9XG5cdH1cblxuXHRyZXR1cm4gY29uZmxpY3RzO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxZQUFZLGFBQWEsY0FBYyxnQkFBZ0I7QUFDaEUsU0FBUyxlQUFlO0FBQ3hCLFNBQVMsVUFBVSxTQUFTLE1BQU0sVUFBVSxTQUFTLFdBQVc7QUFDaEUsT0FBTyxXQUFXO0FBQ2xCLFNBQVMsaUJBQWlCLG1CQUFtQjtBQUM3QyxTQUFTLHlCQUFxQztBQUs5QyxTQUFTLHNCQUFxQztBQUM5QyxTQUFTLHdCQUF3QiwwQkFBMEIsZ0JBQWdCLGlDQUFpQztBQUU1RyxTQUFTLDZCQUFnRDtBQUV6RCxTQUFTLDJC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
