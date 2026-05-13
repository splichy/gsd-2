import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import ignore from "ignore";
import { minimatch } from "minimatch";
import { CONFIG_DIR_NAME } from "../config.js";
import { parseGitUrl } from "../utils/git.js";
import { toPosixPath } from "../utils/path-display.js";
const NETWORK_TIMEOUT_MS = 1e4;
function isOfflineModeEnabled() {
  const value = process.env.PI_OFFLINE;
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}
const RESOURCE_TYPES = ["extensions", "skills", "prompts", "themes"];
const FILE_PATTERNS = {
  extensions: /\.(ts|js)$/,
  skills: /\.md$/,
  prompts: /\.md$/,
  themes: /\.json$/
};
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];
function prefixIgnorePattern(line, prefix) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;
  let pattern = line;
  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith("\\!")) {
    pattern = pattern.slice(1);
  }
  if (pattern.startsWith("/")) {
    pattern = pattern.slice(1);
  }
  const prefixed = prefix ? `${prefix}${pattern}` : pattern;
  return negated ? `!${prefixed}` : prefixed;
}
function addIgnoreRules(ig, dir, rootDir) {
  const relativeDir = relative(rootDir, dir);
  const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";
  for (const filename of IGNORE_FILE_NAMES) {
    const ignorePath = join(dir, filename);
    if (!existsSync(ignorePath)) continue;
    try {
      const content = readFileSync(ignorePath, "utf-8");
      const patterns = content.split(/\r?\n/).map((line) => prefixIgnorePattern(line, prefix)).filter((line) => Boolean(line));
      if (patterns.length > 0) {
        ig.add(patterns);
      }
    } catch {
    }
  }
}
function isPattern(s) {
  return s.startsWith("!") || s.startsWith("+") || s.startsWith("-") || s.includes("*") || s.includes("?");
}
function splitPatterns(entries) {
  const plain = [];
  const patterns = [];
  for (const entry of entries) {
    if (isPattern(entry)) {
      patterns.push(entry);
    } else {
      plain.push(entry);
    }
  }
  return { plain, patterns };
}
function collectFiles(dir, filePattern, skipNodeModules = true, ignoreMatcher, rootDir) {
  const files = [];
  if (!existsSync(dir)) return files;
  const root = rootDir ?? dir;
  const ig = ignoreMatcher ?? ignore();
  addIgnoreRules(ig, dir, root);
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (skipNodeModules && entry.name === "node_modules") continue;
      const fullPath = join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const stats = statSync(fullPath);
          isDir = stats.isDirectory();
          isFile = stats.isFile();
        } catch {
          continue;
        }
      }
      const relPath = toPosixPath(relative(root, fullPath));
      const ignorePath = isDir ? `${relPath}/` : relPath;
      if (ig.ignores(ignorePath)) continue;
      if (isDir) {
        files.push(...collectFiles(fullPath, filePattern, skipNodeModules, ig, root));
      } else if (isFile && filePattern.test(entry.name)) {
        files.push(fullPath);
      }
    }
  } catch {
  }
  return files;
}
function collectSkillEntries(dir, includeRootFiles = true, ignoreMatcher, rootDir) {
  const entries = [];
  if (!existsSync(dir)) return entries;
  const root = rootDir ?? dir;
  const ig = ignoreMatcher ?? ignore();
  addIgnoreRules(ig, dir, root);
  try {
    const dirEntries = readdirSync(dir, { withFileTypes: true });
    for (const entry of dirEntries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules") continue;
      const fullPath = join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const stats = statSync(fullPath);
          isDir = stats.isDirectory();
          isFile = stats.isFile();
        } catch {
          continue;
        }
      }
      const relPath = toPosixPath(relative(root, fullPath));
      const ignorePath = isDir ? `${relPath}/` : relPath;
      if (ig.ignores(ignorePath)) continue;
      if (isDir) {
        entries.push(...collectSkillEntries(fullPath, false, ig, root));
      } else if (isFile) {
        const isRootMd = includeRootFiles && entry.name.endsWith(".md");
        const isSkillMd = !includeRootFiles && entry.name === "SKILL.md";
        if (isRootMd || isSkillMd) {
          entries.push(fullPath);
        }
      }
    }
  } catch {
  }
  return entries;
}
function collectAutoSkillEntries(dir, includeRootFiles = true) {
  return collectSkillEntries(dir, includeRootFiles);
}
function findGitRepoRoot(startDir) {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}
function collectAncestorAgentsSkillDirs(startDir) {
  const skillDirs = [];
  const resolvedStartDir = resolve(startDir);
  const gitRepoRoot = findGitRepoRoot(resolvedStartDir);
  let dir = resolvedStartDir;
  while (true) {
    skillDirs.push(join(dir, ".agents", "skills"));
    if (gitRepoRoot && dir === gitRepoRoot) {
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return skillDirs;
}
function collectAutoPromptEntries(dir) {
  const entries = [];
  if (!existsSync(dir)) return entries;
  const ig = ignore();
  addIgnoreRules(ig, dir, dir);
  try {
    const dirEntries = readdirSync(dir, { withFileTypes: true });
    for (const entry of dirEntries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules") continue;
      const fullPath = join(dir, entry.name);
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          isFile = statSync(fullPath).isFile();
        } catch {
          continue;
        }
      }
      const relPath = toPosixPath(relative(dir, fullPath));
      if (ig.ignores(relPath)) continue;
      if (isFile && entry.name.endsWith(".md")) {
        entries.push(fullPath);
      }
    }
  } catch {
  }
  return entries;
}
function collectAutoThemeEntries(dir) {
  const entries = [];
  if (!existsSync(dir)) return entries;
  const ig = ignore();
  addIgnoreRules(ig, dir, dir);
  try {
    const dirEntries = readdirSync(dir, { withFileTypes: true });
    for (const entry of dirEntries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules") continue;
      const fullPath = join(dir, entry.name);
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          isFile = statSync(fullPath).isFile();
        } catch {
          continue;
        }
      }
      const relPath = toPosixPath(relative(dir, fullPath));
      if (ig.ignores(relPath)) continue;
      if (isFile && entry.name.endsWith(".json")) {
        entries.push(fullPath);
      }
    }
  } catch {
  }
  return entries;
}
function readPiManifestFile(packageJsonPath) {
  try {
    const content = readFileSync(packageJsonPath, "utf-8");
    const pkg = JSON.parse(content);
    return pkg.pi ?? null;
  } catch {
    return null;
  }
}
function resolveExtensionEntries(dir) {
  const packageJsonPath = join(dir, "package.json");
  if (existsSync(packageJsonPath)) {
    const manifest = readPiManifestFile(packageJsonPath);
    if (manifest) {
      if (!manifest.extensions?.length) {
        return null;
      }
      const entries = [];
      for (const extPath of manifest.extensions) {
        const resolvedExtPath = resolve(dir, extPath);
        if (existsSync(resolvedExtPath)) {
          entries.push(resolvedExtPath);
        }
      }
      return entries.length > 0 ? entries : null;
    }
  }
  const indexTs = join(dir, "index.ts");
  const indexJs = join(dir, "index.js");
  if (existsSync(indexTs)) {
    return [indexTs];
  }
  if (existsSync(indexJs)) {
    return [indexJs];
  }
  return null;
}
function collectAutoExtensionEntries(dir) {
  const entries = [];
  if (!existsSync(dir)) return entries;
  const rootEntries = resolveExtensionEntries(dir);
  if (rootEntries) {
    return rootEntries;
  }
  const ig = ignore();
  addIgnoreRules(ig, dir, dir);
  try {
    const dirEntries = readdirSync(dir, { withFileTypes: true });
    for (const entry of dirEntries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules") continue;
      const fullPath = join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const stats = statSync(fullPath);
          isDir = stats.isDirectory();
          isFile = stats.isFile();
        } catch {
          continue;
        }
      }
      const relPath = toPosixPath(relative(dir, fullPath));
      const ignorePath = isDir ? `${relPath}/` : relPath;
      if (ig.ignores(ignorePath)) continue;
      if (isFile && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
        entries.push(fullPath);
      } else if (isDir) {
        const resolvedEntries = resolveExtensionEntries(fullPath);
        if (resolvedEntries) {
          entries.push(...resolvedEntries);
        }
      }
    }
  } catch {
  }
  return entries;
}
function collectResourceFiles(dir, resourceType) {
  if (resourceType === "skills") {
    return collectSkillEntries(dir);
  }
  if (resourceType === "extensions") {
    return collectAutoExtensionEntries(dir);
  }
  return collectFiles(dir, FILE_PATTERNS[resourceType]);
}
function matchesAnyPattern(filePath, patterns, baseDir) {
  const rel = relative(baseDir, filePath);
  const name = basename(filePath);
  const isSkillFile = name === "SKILL.md";
  const parentDir = isSkillFile ? dirname(filePath) : void 0;
  const parentRel = isSkillFile ? relative(baseDir, parentDir) : void 0;
  const parentName = isSkillFile ? basename(parentDir) : void 0;
  return patterns.some((pattern) => {
    if (minimatch(rel, pattern) || minimatch(name, pattern) || minimatch(filePath, pattern)) {
      return true;
    }
    if (!isSkillFile) return false;
    return minimatch(parentRel, pattern) || minimatch(parentName, pattern) || minimatch(parentDir, pattern);
  });
}
function normalizeExactPattern(pattern) {
  if (pattern.startsWith("./") || pattern.startsWith(".\\")) {
    return pattern.slice(2);
  }
  return pattern;
}
function matchesAnyExactPattern(filePath, patterns, baseDir) {
  if (patterns.length === 0) return false;
  const rel = relative(baseDir, filePath);
  const name = basename(filePath);
  const isSkillFile = name === "SKILL.md";
  const parentDir = isSkillFile ? dirname(filePath) : void 0;
  const parentRel = isSkillFile ? relative(baseDir, parentDir) : void 0;
  return patterns.some((pattern) => {
    const normalized = normalizeExactPattern(pattern);
    if (normalized === rel || normalized === filePath) {
      return true;
    }
    if (!isSkillFile) return false;
    return normalized === parentRel || normalized === parentDir;
  });
}
function getOverridePatterns(entries) {
  return entries.filter((pattern) => pattern.startsWith("!") || pattern.startsWith("+") || pattern.startsWith("-"));
}
function isEnabledByOverrides(filePath, patterns, baseDir) {
  const overrides = getOverridePatterns(patterns);
  const excludes = overrides.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
  const forceIncludes = overrides.filter((pattern) => pattern.startsWith("+")).map((pattern) => pattern.slice(1));
  const forceExcludes = overrides.filter((pattern) => pattern.startsWith("-")).map((pattern) => pattern.slice(1));
  let enabled = true;
  if (excludes.length > 0 && matchesAnyPattern(filePath, excludes, baseDir)) {
    enabled = false;
  }
  if (forceIncludes.length > 0 && matchesAnyExactPattern(filePath, forceIncludes, baseDir)) {
    enabled = true;
  }
  if (forceExcludes.length > 0 && matchesAnyExactPattern(filePath, forceExcludes, baseDir)) {
    enabled = false;
  }
  return enabled;
}
function applyPatterns(allPaths, patterns, baseDir) {
  const includes = [];
  const excludes = [];
  const forceIncludes = [];
  const forceExcludes = [];
  for (const p of patterns) {
    if (p.startsWith("+")) {
      forceIncludes.push(p.slice(1));
    } else if (p.startsWith("-")) {
      forceExcludes.push(p.slice(1));
    } else if (p.startsWith("!")) {
      excludes.push(p.slice(1));
    } else {
      includes.push(p);
    }
  }
  let result;
  if (includes.length === 0) {
    result = [...allPaths];
  } else {
    result = allPaths.filter((filePath) => matchesAnyPattern(filePath, includes, baseDir));
  }
  if (excludes.length > 0) {
    result = result.filter((filePath) => !matchesAnyPattern(filePath, excludes, baseDir));
  }
  if (forceIncludes.length > 0) {
    for (const filePath of allPaths) {
      if (!result.includes(filePath) && matchesAnyExactPattern(filePath, forceIncludes, baseDir)) {
        result.push(filePath);
      }
    }
  }
  if (forceExcludes.length > 0) {
    result = result.filter((filePath) => !matchesAnyExactPattern(filePath, forceExcludes, baseDir));
  }
  return new Set(result);
}
class DefaultPackageManager {
  constructor(options) {
    this.cwd = options.cwd;
    this.agentDir = options.agentDir;
    this.settingsManager = options.settingsManager;
  }
  setProgressCallback(callback) {
    this.progressCallback = callback;
  }
  addSourceToSettings(source, options) {
    const scope = options?.local ? "project" : "user";
    const currentSettings = scope === "project" ? this.settingsManager.getProjectSettings() : this.settingsManager.getGlobalSettings();
    const currentPackages = currentSettings.packages ?? [];
    const normalizedSource = this.normalizePackageSourceForSettings(source, scope);
    const exists = currentPackages.some((existing) => this.packageSourcesMatch(existing, source, scope));
    if (exists) {
      return false;
    }
    const nextPackages = [...currentPackages, normalizedSource];
    if (scope === "project") {
      this.settingsManager.setProjectPackages(nextPackages);
    } else {
      this.settingsManager.setPackages(nextPackages);
    }
    return true;
  }
  removeSourceFromSettings(source, options) {
    const scope = options?.local ? "project" : "user";
    const currentSettings = scope === "project" ? this.settingsManager.getProjectSettings() : this.settingsManager.getGlobalSettings();
    const currentPackages = currentSettings.packages ?? [];
    const nextPackages = currentPackages.filter((existing) => !this.packageSourcesMatch(existing, source, scope));
    const changed = nextPackages.length !== currentPackages.length;
    if (!changed) {
      return false;
    }
    if (scope === "project") {
      this.settingsManager.setProjectPackages(nextPackages);
    } else {
      this.settingsManager.setPackages(nextPackages);
    }
    return true;
  }
  getInstalledPath(source, scope) {
    const parsed = this.parseSource(source);
    if (parsed.type === "npm") {
      const path = this.getNpmInstallPath(parsed, scope);
      return existsSync(path) ? path : void 0;
    }
    if (parsed.type === "git") {
      const path = this.getGitInstallPath(parsed, scope);
      return existsSync(path) ? path : void 0;
    }
    if (parsed.type === "local") {
      const baseDir = this.getBaseDirForScope(scope);
      const path = this.resolvePathFromBase(parsed.path, baseDir);
      return existsSync(path) ? path : void 0;
    }
    return void 0;
  }
  emitProgress(event) {
    this.progressCallback?.(event);
  }
  async withProgress(action, source, message, operation) {
    this.emitProgress({ type: "start", action, source, message });
    try {
      await operation();
      this.emitProgress({ type: "complete", action, source });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.emitProgress({ type: "error", action, source, message: errorMessage });
      throw error;
    }
  }
  async resolve(onMissing) {
    const accumulator = this.createAccumulator();
    const globalSettings = this.settingsManager.getGlobalSettings();
    const projectSettings = this.settingsManager.getProjectSettings();
    const allPackages = [];
    for (const pkg of projectSettings.packages ?? []) {
      allPackages.push({ pkg, scope: "project" });
    }
    for (const pkg of globalSettings.packages ?? []) {
      allPackages.push({ pkg, scope: "user" });
    }
    const packageSources = this.dedupePackages(allPackages);
    await this.resolvePackageSources(packageSources, accumulator, onMissing);
    const globalBaseDir = this.agentDir;
    const projectBaseDir = join(this.cwd, CONFIG_DIR_NAME);
    for (const resourceType of RESOURCE_TYPES) {
      const target = this.getTargetMap(accumulator, resourceType);
      const globalEntries = globalSettings[resourceType] ?? [];
      const projectEntries = projectSettings[resourceType] ?? [];
      this.resolveLocalEntries(
        projectEntries,
        resourceType,
        target,
        {
          source: "local",
          scope: "project",
          origin: "top-level"
        },
        projectBaseDir
      );
      this.resolveLocalEntries(
        globalEntries,
        resourceType,
        target,
        {
          source: "local",
          scope: "user",
          origin: "top-level"
        },
        globalBaseDir
      );
    }
    this.addAutoDiscoveredResources(accumulator, globalSettings, projectSettings, globalBaseDir, projectBaseDir);
    return this.toResolvedPaths(accumulator);
  }
  async resolveExtensionSources(sources, options) {
    const accumulator = this.createAccumulator();
    const scope = options?.temporary ? "temporary" : options?.local ? "project" : "user";
    const packageSources = sources.map((source) => ({ pkg: source, scope }));
    await this.resolvePackageSources(packageSources, accumulator);
    return this.toResolvedPaths(accumulator);
  }
  async install(source, options) {
    const parsed = this.parseSource(source);
    const scope = options?.local ? "project" : "user";
    await this.withProgress("install", source, `Installing ${source}...`, async () => {
      if (parsed.type === "npm") {
        await this.installNpm(parsed, scope, false);
        return;
      }
      if (parsed.type === "git") {
        await this.installGit(parsed, scope);
        return;
      }
      if (parsed.type === "local") {
        const resolved = this.resolvePath(parsed.path);
        if (!existsSync(resolved)) {
          throw new Error(`Path does not exist: ${resolved}`);
        }
        return;
      }
      throw new Error(`Unsupported install source: ${source}`);
    });
  }
  async remove(source, options) {
    const parsed = this.parseSource(source);
    const scope = options?.local ? "project" : "user";
    await this.withProgress("remove", source, `Removing ${source}...`, async () => {
      if (parsed.type === "npm") {
        await this.uninstallNpm(parsed, scope);
        return;
      }
      if (parsed.type === "git") {
        await this.removeGit(parsed, scope);
        return;
      }
      if (parsed.type === "local") {
        return;
      }
      throw new Error(`Unsupported remove source: ${source}`);
    });
  }
  async update(source) {
    const globalSettings = this.settingsManager.getGlobalSettings();
    const projectSettings = this.settingsManager.getProjectSettings();
    const identity = source ? this.getPackageIdentity(source) : void 0;
    for (const pkg of globalSettings.packages ?? []) {
      const sourceStr = typeof pkg === "string" ? pkg : pkg.source;
      if (identity && this.getPackageIdentity(sourceStr, "user") !== identity) continue;
      await this.updateSourceForScope(sourceStr, "user");
    }
    for (const pkg of projectSettings.packages ?? []) {
      const sourceStr = typeof pkg === "string" ? pkg : pkg.source;
      if (identity && this.getPackageIdentity(sourceStr, "project") !== identity) continue;
      await this.updateSourceForScope(sourceStr, "project");
    }
  }
  async updateSourceForScope(source, scope) {
    if (isOfflineModeEnabled()) {
      return;
    }
    const parsed = this.parseSource(source);
    if (parsed.type === "npm") {
      if (parsed.pinned) return;
      await this.withProgress("update", source, `Updating ${source}...`, async () => {
        await this.installNpm(parsed, scope, false);
      });
      return;
    }
    if (parsed.type === "git") {
      if (parsed.pinned) return;
      await this.withProgress("update", source, `Updating ${source}...`, async () => {
        await this.updateGit(parsed, scope);
      });
      return;
    }
  }
  async resolvePackageSources(sources, accumulator, onMissing) {
    for (const { pkg, scope } of sources) {
      const sourceStr = typeof pkg === "string" ? pkg : pkg.source;
      const filter = typeof pkg === "object" ? pkg : void 0;
      const parsed = this.parseSource(sourceStr);
      const metadata = { source: sourceStr, scope, origin: "package" };
      if (parsed.type === "local") {
        const baseDir = this.getBaseDirForScope(scope);
        this.resolveLocalExtensionSource(parsed, accumulator, filter, metadata, baseDir);
        continue;
      }
      const installMissing = async () => {
        if (isOfflineModeEnabled()) {
          return false;
        }
        if (!onMissing) {
          await this.installParsedSource(parsed, scope);
          return true;
        }
        const action = await onMissing(sourceStr);
        if (action === "skip") return false;
        if (action === "error") throw new Error(`Missing source: ${sourceStr}`);
        await this.installParsedSource(parsed, scope);
        return true;
      };
      if (parsed.type === "npm") {
        const installedPath = this.getNpmInstallPath(parsed, scope);
        const needsInstall = !existsSync(installedPath) || await this.npmNeedsUpdate(parsed, installedPath);
        if (needsInstall) {
          const installed = await installMissing();
          if (!installed) continue;
        }
        metadata.baseDir = installedPath;
        this.collectPackageResources(installedPath, accumulator, filter, metadata);
        continue;
      }
      if (parsed.type === "git") {
        const installedPath = this.getGitInstallPath(parsed, scope);
        if (!existsSync(installedPath)) {
          const installed = await installMissing();
          if (!installed) continue;
        } else if (scope === "temporary" && !parsed.pinned && !isOfflineModeEnabled()) {
          await this.refreshTemporaryGitSource(parsed, sourceStr);
        }
        metadata.baseDir = installedPath;
        this.collectPackageResources(installedPath, accumulator, filter, metadata);
      }
    }
  }
  resolveLocalExtensionSource(source, accumulator, filter, metadata, baseDir) {
    const resolved = this.resolvePathFromBase(source.path, baseDir);
    if (!existsSync(resolved)) {
      return;
    }
    try {
      const stats = statSync(resolved);
      if (stats.isFile()) {
        metadata.baseDir = dirname(resolved);
        this.addResource(accumulator.extensions, resolved, metadata, true);
        return;
      }
      if (stats.isDirectory()) {
        metadata.baseDir = resolved;
        const resources = this.collectPackageResources(resolved, accumulator, filter, metadata);
        if (!resources) {
          this.addResource(accumulator.extensions, resolved, metadata, true);
        }
      }
    } catch {
      return;
    }
  }
  async installParsedSource(parsed, scope) {
    if (parsed.type === "npm") {
      await this.installNpm(parsed, scope, scope === "temporary");
      return;
    }
    if (parsed.type === "git") {
      await this.installGit(parsed, scope);
      return;
    }
  }
  getPackageSourceString(pkg) {
    return typeof pkg === "string" ? pkg : pkg.source;
  }
  getSourceMatchKeyForInput(source) {
    const parsed = this.parseSource(source);
    if (parsed.type === "npm") {
      return `npm:${parsed.name}`;
    }
    if (parsed.type === "git") {
      return `git:${parsed.host}/${parsed.path}`;
    }
    return `local:${this.resolvePath(parsed.path)}`;
  }
  getSourceMatchKeyForSettings(source, scope) {
    const parsed = this.parseSource(source);
    if (parsed.type === "npm") {
      return `npm:${parsed.name}`;
    }
    if (parsed.type === "git") {
      return `git:${parsed.host}/${parsed.path}`;
    }
    const baseDir = this.getBaseDirForScope(scope);
    return `local:${this.resolvePathFromBase(parsed.path, baseDir)}`;
  }
  packageSourcesMatch(existing, inputSource, scope) {
    const left = this.getSourceMatchKeyForSettings(this.getPackageSourceString(existing), scope);
    const right = this.getSourceMatchKeyForInput(inputSource);
    return left === right;
  }
  normalizePackageSourceForSettings(source, scope) {
    const parsed = this.parseSource(source);
    if (parsed.type !== "local") {
      return source;
    }
    const baseDir = this.getBaseDirForScope(scope);
    const resolved = this.resolvePath(parsed.path);
    const rel = relative(baseDir, resolved);
    return rel || ".";
  }
  parseSource(source) {
    if (source.startsWith("npm:")) {
      const spec = source.slice("npm:".length).trim();
      const { name, version } = this.parseNpmSpec(spec);
      return {
        type: "npm",
        spec,
        name,
        pinned: Boolean(version)
      };
    }
    const trimmed = source.trim();
    const isWindowsAbsolutePath = /^[A-Za-z]:[\\/]|^\\\\/.test(trimmed);
    const isLocalPathLike = trimmed.startsWith(".") || trimmed.startsWith("/") || trimmed === "~" || trimmed.startsWith("~/") || isWindowsAbsolutePath;
    if (isLocalPathLike) {
      return { type: "local", path: source };
    }
    const gitParsed = parseGitUrl(source);
    if (gitParsed) {
      return gitParsed;
    }
    return { type: "local", path: source };
  }
  /**
   * Check if an npm package needs to be updated.
   * - For unpinned packages: check if registry has a newer version
   * - For pinned packages: check if installed version matches the pinned version
   */
  async npmNeedsUpdate(source, installedPath) {
    if (isOfflineModeEnabled()) {
      return false;
    }
    const installedVersion = this.getInstalledNpmVersion(installedPath);
    if (!installedVersion) return true;
    const { version: pinnedVersion } = this.parseNpmSpec(source.spec);
    if (pinnedVersion) {
      return installedVersion !== pinnedVersion;
    }
    try {
      const latestVersion = await this.getLatestNpmVersion(source.name);
      return latestVersion !== installedVersion;
    } catch {
      return false;
    }
  }
  getInstalledNpmVersion(installedPath) {
    const packageJsonPath = join(installedPath, "package.json");
    if (!existsSync(packageJsonPath)) return void 0;
    try {
      const content = readFileSync(packageJsonPath, "utf-8");
      const pkg = JSON.parse(content);
      return pkg.version;
    } catch {
      return void 0;
    }
  }
  async getLatestNpmVersion(packageName) {
    const response = await fetch(`https://registry.npmjs.org/${packageName}/latest`, {
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`Failed to fetch npm registry: ${response.status}`);
    const data = await response.json();
    return data.version;
  }
  /**
   * Get a unique identity for a package, ignoring version/ref.
   * Used to detect when the same package is in both global and project settings.
   * For git packages, uses normalized host/path to ensure SSH and HTTPS URLs
   * for the same repository are treated as identical.
   */
  getPackageIdentity(source, scope) {
    const parsed = this.parseSource(source);
    if (parsed.type === "npm") {
      return `npm:${parsed.name}`;
    }
    if (parsed.type === "git") {
      return `git:${parsed.host}/${parsed.path}`;
    }
    if (scope) {
      const baseDir = this.getBaseDirForScope(scope);
      return `local:${this.resolvePathFromBase(parsed.path, baseDir)}`;
    }
    return `local:${this.resolvePath(parsed.path)}`;
  }
  /**
   * Dedupe packages: if same package identity appears in both global and project,
   * keep only the project one (project wins).
   */
  dedupePackages(packages) {
    const seen = /* @__PURE__ */ new Map();
    for (const entry of packages) {
      const sourceStr = typeof entry.pkg === "string" ? entry.pkg : entry.pkg.source;
      const identity = this.getPackageIdentity(sourceStr, entry.scope);
      const existing = seen.get(identity);
      if (!existing) {
        seen.set(identity, entry);
      } else if (entry.scope === "project" && existing.scope === "user") {
        seen.set(identity, entry);
      }
    }
    return Array.from(seen.values());
  }
  parseNpmSpec(spec) {
    const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
    if (!match) {
      return { name: spec };
    }
    const name = match[1] ?? spec;
    const version = match[2];
    return { name, version };
  }
  async installNpm(source, scope, temporary) {
    if (scope === "user" && !temporary) {
      await this.runCommand("npm", ["install", "-g", source.spec]);
      return;
    }
    const installRoot = this.getNpmInstallRoot(scope, temporary);
    this.ensureNpmProject(installRoot);
    await this.runCommand("npm", ["install", source.spec, "--prefix", installRoot]);
  }
  async uninstallNpm(source, scope) {
    if (scope === "user") {
      await this.runCommand("npm", ["uninstall", "-g", source.name]);
      return;
    }
    const installRoot = this.getNpmInstallRoot(scope, false);
    if (!existsSync(installRoot)) {
      return;
    }
    await this.runCommand("npm", ["uninstall", source.name, "--prefix", installRoot]);
  }
  async installGit(source, scope) {
    const targetDir = this.getGitInstallPath(source, scope);
    if (existsSync(targetDir)) {
      return;
    }
    const gitRoot = this.getGitInstallRoot(scope);
    if (gitRoot) {
      this.ensureGitIgnore(gitRoot);
    }
    mkdirSync(dirname(targetDir), { recursive: true });
    await this.runCommand("git", ["clone", source.repo, targetDir]);
    if (source.ref) {
      await this.runCommand("git", ["checkout", source.ref], { cwd: targetDir });
    }
    const packageJsonPath = join(targetDir, "package.json");
    if (existsSync(packageJsonPath)) {
      await this.runCommand("npm", ["install"], { cwd: targetDir });
    }
  }
  async updateGit(source, scope) {
    const targetDir = this.getGitInstallPath(source, scope);
    if (!existsSync(targetDir)) {
      await this.installGit(source, scope);
      return;
    }
    await this.runCommand("git", ["fetch", "--prune", "origin"], { cwd: targetDir });
    try {
      await this.runCommand("git", ["reset", "--hard", "@{upstream}"], { cwd: targetDir });
    } catch {
      await this.runCommand("git", ["remote", "set-head", "origin", "-a"], { cwd: targetDir }).catch(() => {
      });
      await this.runCommand("git", ["reset", "--hard", "origin/HEAD"], { cwd: targetDir });
    }
    await this.runCommand("git", ["clean", "-fdx"], { cwd: targetDir });
    const packageJsonPath = join(targetDir, "package.json");
    if (existsSync(packageJsonPath)) {
      await this.runCommand("npm", ["install"], { cwd: targetDir });
    }
  }
  async refreshTemporaryGitSource(source, sourceStr) {
    if (isOfflineModeEnabled()) {
      return;
    }
    try {
      await this.withProgress("pull", sourceStr, `Refreshing ${sourceStr}...`, async () => {
        await this.updateGit(source, "temporary");
      });
    } catch {
    }
  }
  async removeGit(source, scope) {
    const targetDir = this.getGitInstallPath(source, scope);
    if (!existsSync(targetDir)) return;
    rmSync(targetDir, { recursive: true, force: true });
    this.pruneEmptyGitParents(targetDir, this.getGitInstallRoot(scope));
  }
  pruneEmptyGitParents(targetDir, installRoot) {
    if (!installRoot) return;
    const resolvedRoot = resolve(installRoot);
    let current = dirname(targetDir);
    while (current.startsWith(resolvedRoot) && current !== resolvedRoot) {
      if (!existsSync(current)) {
        current = dirname(current);
        continue;
      }
      const entries = readdirSync(current);
      if (entries.length > 0) {
        break;
      }
      try {
        rmSync(current, { recursive: true, force: true });
      } catch {
        break;
      }
      current = dirname(current);
    }
  }
  ensureNpmProject(installRoot) {
    if (!existsSync(installRoot)) {
      mkdirSync(installRoot, { recursive: true });
    }
    this.ensureGitIgnore(installRoot);
    const packageJsonPath = join(installRoot, "package.json");
    if (!existsSync(packageJsonPath)) {
      const pkgJson = { name: "pi-extensions", private: true };
      writeFileSync(packageJsonPath, JSON.stringify(pkgJson, null, 2), "utf-8");
    }
  }
  ensureGitIgnore(dir) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const ignorePath = join(dir, ".gitignore");
    if (!existsSync(ignorePath)) {
      writeFileSync(ignorePath, "*\n!.gitignore\n", "utf-8");
    }
  }
  getNpmInstallRoot(scope, temporary) {
    if (temporary) {
      return this.getTemporaryDir("npm");
    }
    if (scope === "project") {
      return join(this.cwd, CONFIG_DIR_NAME, "npm");
    }
    return join(this.getGlobalNpmRoot(), "..");
  }
  getGlobalNpmRoot() {
    if (this.globalNpmRoot) {
      return this.globalNpmRoot;
    }
    const result = this.runCommandSync("npm", ["root", "-g"]);
    this.globalNpmRoot = result.trim();
    return this.globalNpmRoot;
  }
  getNpmInstallPath(source, scope) {
    if (scope === "temporary") {
      return join(this.getTemporaryDir("npm"), "node_modules", source.name);
    }
    if (scope === "project") {
      return join(this.cwd, CONFIG_DIR_NAME, "npm", "node_modules", source.name);
    }
    return join(this.getGlobalNpmRoot(), source.name);
  }
  getGitInstallPath(source, scope) {
    if (scope === "temporary") {
      return this.getTemporaryDir(`git-${source.host}`, source.path);
    }
    if (scope === "project") {
      return join(this.cwd, CONFIG_DIR_NAME, "git", source.host, source.path);
    }
    return join(this.agentDir, "git", source.host, source.path);
  }
  getGitInstallRoot(scope) {
    if (scope === "temporary") {
      return void 0;
    }
    if (scope === "project") {
      return join(this.cwd, CONFIG_DIR_NAME, "git");
    }
    return join(this.agentDir, "git");
  }
  getTemporaryDir(prefix, suffix) {
    const hash = createHash("sha256").update(`${prefix}-${suffix ?? ""}`).digest("hex").slice(0, 8);
    return join(tmpdir(), "pi-extensions", prefix, hash, suffix ?? "");
  }
  getBaseDirForScope(scope) {
    if (scope === "project") {
      return join(this.cwd, CONFIG_DIR_NAME);
    }
    if (scope === "user") {
      return this.agentDir;
    }
    return this.cwd;
  }
  resolvePath(input) {
    const trimmed = input.trim();
    if (trimmed === "~") return homedir();
    if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
    if (trimmed.startsWith("~")) return join(homedir(), trimmed.slice(1));
    return resolve(this.cwd, trimmed);
  }
  resolvePathFromBase(input, baseDir) {
    const trimmed = input.trim();
    if (trimmed === "~") return homedir();
    if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
    if (trimmed.startsWith("~")) return join(homedir(), trimmed.slice(1));
    return resolve(baseDir, trimmed);
  }
  collectPackageResources(packageRoot, accumulator, filter, metadata) {
    if (filter) {
      for (const resourceType of RESOURCE_TYPES) {
        const patterns = filter[resourceType];
        const target = this.getTargetMap(accumulator, resourceType);
        if (patterns !== void 0) {
          this.applyPackageFilter(packageRoot, patterns, resourceType, target, metadata);
        } else {
          this.collectDefaultResources(packageRoot, resourceType, target, metadata);
        }
      }
      return true;
    }
    const manifest = this.readPiManifest(packageRoot);
    if (manifest) {
      for (const resourceType of RESOURCE_TYPES) {
        const entries = manifest[resourceType];
        this.addManifestEntries(
          entries,
          packageRoot,
          resourceType,
          this.getTargetMap(accumulator, resourceType),
          metadata
        );
      }
      return true;
    }
    let hasAnyDir = false;
    for (const resourceType of RESOURCE_TYPES) {
      const dir = join(packageRoot, resourceType);
      if (existsSync(dir)) {
        const files = collectResourceFiles(dir, resourceType);
        for (const f of files) {
          this.addResource(this.getTargetMap(accumulator, resourceType), f, metadata, true);
        }
        hasAnyDir = true;
      }
    }
    return hasAnyDir;
  }
  collectDefaultResources(packageRoot, resourceType, target, metadata) {
    const manifest = this.readPiManifest(packageRoot);
    const entries = manifest?.[resourceType];
    if (entries) {
      this.addManifestEntries(entries, packageRoot, resourceType, target, metadata);
      return;
    }
    const dir = join(packageRoot, resourceType);
    if (existsSync(dir)) {
      const files = collectResourceFiles(dir, resourceType);
      for (const f of files) {
        this.addResource(target, f, metadata, true);
      }
    }
  }
  applyPackageFilter(packageRoot, userPatterns, resourceType, target, metadata) {
    const { allFiles } = this.collectManifestFiles(packageRoot, resourceType);
    if (userPatterns.length === 0) {
      for (const f of allFiles) {
        this.addResource(target, f, metadata, false);
      }
      return;
    }
    const enabledByUser = applyPatterns(allFiles, userPatterns, packageRoot);
    for (const f of allFiles) {
      const enabled = enabledByUser.has(f);
      this.addResource(target, f, metadata, enabled);
    }
  }
  /**
   * Collect all files from a package for a resource type, applying manifest patterns.
   * Returns { allFiles, enabledByManifest } where enabledByManifest is the set of files
   * that pass the manifest's own patterns.
   */
  collectManifestFiles(packageRoot, resourceType) {
    const manifest = this.readPiManifest(packageRoot);
    const entries = manifest?.[resourceType];
    if (entries && entries.length > 0) {
      const allFiles2 = this.collectFilesFromManifestEntries(entries, packageRoot, resourceType);
      const manifestPatterns = entries.filter(isPattern);
      const enabledByManifest = manifestPatterns.length > 0 ? applyPatterns(allFiles2, manifestPatterns, packageRoot) : new Set(allFiles2);
      return { allFiles: Array.from(enabledByManifest), enabledByManifest };
    }
    const conventionDir = join(packageRoot, resourceType);
    if (!existsSync(conventionDir)) {
      return { allFiles: [], enabledByManifest: /* @__PURE__ */ new Set() };
    }
    const allFiles = collectResourceFiles(conventionDir, resourceType);
    return { allFiles, enabledByManifest: new Set(allFiles) };
  }
  readPiManifest(packageRoot) {
    const packageJsonPath = join(packageRoot, "package.json");
    if (!existsSync(packageJsonPath)) {
      return null;
    }
    try {
      const content = readFileSync(packageJsonPath, "utf-8");
      const pkg = JSON.parse(content);
      return pkg.pi ?? null;
    } catch {
      return null;
    }
  }
  addManifestEntries(entries, root, resourceType, target, metadata) {
    if (!entries) return;
    const allFiles = this.collectFilesFromManifestEntries(entries, root, resourceType);
    const patterns = entries.filter(isPattern);
    const enabledPaths = applyPatterns(allFiles, patterns, root);
    for (const f of allFiles) {
      if (enabledPaths.has(f)) {
        this.addResource(target, f, metadata, true);
      }
    }
  }
  collectFilesFromManifestEntries(entries, root, resourceType) {
    const plain = entries.filter((entry) => !isPattern(entry));
    const resolved = plain.map((entry) => resolve(root, entry));
    return this.collectFilesFromPaths(resolved, resourceType);
  }
  resolveLocalEntries(entries, resourceType, target, metadata, baseDir) {
    if (entries.length === 0) return;
    const { plain, patterns } = splitPatterns(entries);
    const resolvedPlain = plain.map((p) => this.resolvePathFromBase(p, baseDir));
    const allFiles = this.collectFilesFromPaths(resolvedPlain, resourceType);
    const enabledPaths = applyPatterns(allFiles, patterns, baseDir);
    for (const f of allFiles) {
      this.addResource(target, f, metadata, enabledPaths.has(f));
    }
  }
  /**
   * Batch-discover which resource subdirectories exist under a parent dir.
   * A single readdirSync replaces 4 separate existsSync probes, reducing
   * syscalls during startup.
   */
  discoverResourceSubdirs(baseDir) {
    try {
      const entries = readdirSync(baseDir, { withFileTypes: true });
      const names = /* @__PURE__ */ new Set();
      for (const e of entries) {
        if (e.isDirectory() || e.isSymbolicLink()) {
          names.add(e.name);
        }
      }
      return names;
    } catch {
      return /* @__PURE__ */ new Set();
    }
  }
  addAutoDiscoveredResources(accumulator, globalSettings, projectSettings, globalBaseDir, projectBaseDir) {
    const userMetadata = {
      source: "auto",
      scope: "user",
      origin: "top-level",
      baseDir: globalBaseDir
    };
    const projectMetadata = {
      source: "auto",
      scope: "project",
      origin: "top-level",
      baseDir: projectBaseDir
    };
    const userOverrides = {
      extensions: globalSettings.extensions ?? [],
      skills: globalSettings.skills ?? [],
      prompts: globalSettings.prompts ?? [],
      themes: globalSettings.themes ?? []
    };
    const projectOverrides = {
      extensions: projectSettings.extensions ?? [],
      skills: projectSettings.skills ?? [],
      prompts: projectSettings.prompts ?? [],
      themes: projectSettings.themes ?? []
    };
    const projectSubdirs = this.discoverResourceSubdirs(projectBaseDir);
    const userSubdirs = this.discoverResourceSubdirs(globalBaseDir);
    const userDirs = {
      extensions: join(globalBaseDir, "extensions"),
      skills: join(globalBaseDir, "skills"),
      prompts: join(globalBaseDir, "prompts"),
      themes: join(globalBaseDir, "themes")
    };
    const projectDirs = {
      extensions: join(projectBaseDir, "extensions"),
      skills: join(projectBaseDir, "skills"),
      prompts: join(projectBaseDir, "prompts"),
      themes: join(projectBaseDir, "themes")
    };
    const userAgentsSkillsDir = join(homedir(), ".agents", "skills");
    const projectAgentsSkillDirs = collectAncestorAgentsSkillDirs(this.cwd).filter(
      (dir) => resolve(dir) !== resolve(userAgentsSkillsDir)
    );
    const addResources = (resourceType, paths, metadata, overrides, baseDir) => {
      const target = this.getTargetMap(accumulator, resourceType);
      for (const path of paths) {
        const enabled = isEnabledByOverrides(path, overrides, baseDir);
        this.addResource(target, path, metadata, enabled);
      }
    };
    if (projectSubdirs.has("extensions")) {
      addResources(
        "extensions",
        collectAutoExtensionEntries(projectDirs.extensions),
        projectMetadata,
        projectOverrides.extensions,
        projectBaseDir
      );
    }
    {
      const skillEntries = [
        ...projectSubdirs.has("skills") ? collectAutoSkillEntries(projectDirs.skills) : [],
        ...projectAgentsSkillDirs.flatMap((dir) => collectAutoSkillEntries(dir))
      ];
      if (skillEntries.length > 0) {
        addResources("skills", skillEntries, projectMetadata, projectOverrides.skills, projectBaseDir);
      }
    }
    if (projectSubdirs.has("prompts")) {
      addResources(
        "prompts",
        collectAutoPromptEntries(projectDirs.prompts),
        projectMetadata,
        projectOverrides.prompts,
        projectBaseDir
      );
    }
    if (projectSubdirs.has("themes")) {
      addResources(
        "themes",
        collectAutoThemeEntries(projectDirs.themes),
        projectMetadata,
        projectOverrides.themes,
        projectBaseDir
      );
    }
    if (userSubdirs.has("extensions")) {
      addResources(
        "extensions",
        collectAutoExtensionEntries(userDirs.extensions),
        userMetadata,
        userOverrides.extensions,
        globalBaseDir
      );
    }
    {
      const legacySkillsMigrated = resolve(userDirs.skills) !== resolve(userAgentsSkillsDir) && existsSync(join(userDirs.skills, ".migrated-to-agents"));
      const legacyUserSkillEntries = !legacySkillsMigrated && userSubdirs.has("skills") ? collectAutoSkillEntries(userDirs.skills) : [];
      const skillEntries = [
        ...collectAutoSkillEntries(userAgentsSkillsDir),
        ...legacyUserSkillEntries
      ];
      if (skillEntries.length > 0) {
        addResources("skills", skillEntries, userMetadata, userOverrides.skills, globalBaseDir);
      }
    }
    if (userSubdirs.has("prompts")) {
      addResources(
        "prompts",
        collectAutoPromptEntries(userDirs.prompts),
        userMetadata,
        userOverrides.prompts,
        globalBaseDir
      );
    }
    if (userSubdirs.has("themes")) {
      addResources(
        "themes",
        collectAutoThemeEntries(userDirs.themes),
        userMetadata,
        userOverrides.themes,
        globalBaseDir
      );
    }
  }
  collectFilesFromPaths(paths, resourceType) {
    const files = [];
    for (const p of paths) {
      if (!existsSync(p)) continue;
      try {
        const stats = statSync(p);
        if (stats.isFile()) {
          files.push(p);
        } else if (stats.isDirectory()) {
          files.push(...collectResourceFiles(p, resourceType));
        }
      } catch {
      }
    }
    return files;
  }
  getTargetMap(accumulator, resourceType) {
    switch (resourceType) {
      case "extensions":
        return accumulator.extensions;
      case "skills":
        return accumulator.skills;
      case "prompts":
        return accumulator.prompts;
      case "themes":
        return accumulator.themes;
      default:
        throw new Error(`Unknown resource type: ${resourceType}`);
    }
  }
  addResource(map, path, metadata, enabled) {
    if (!path) return;
    if (!map.has(path)) {
      map.set(path, { metadata, enabled });
    }
  }
  createAccumulator() {
    return {
      extensions: /* @__PURE__ */ new Map(),
      skills: /* @__PURE__ */ new Map(),
      prompts: /* @__PURE__ */ new Map(),
      themes: /* @__PURE__ */ new Map()
    };
  }
  toResolvedPaths(accumulator) {
    const toResolved = (entries) => {
      return Array.from(entries.entries()).map(([path, { metadata, enabled }]) => ({
        path,
        enabled,
        metadata
      }));
    };
    return {
      extensions: toResolved(accumulator.extensions),
      skills: toResolved(accumulator.skills),
      prompts: toResolved(accumulator.prompts),
      themes: toResolved(accumulator.themes)
    };
  }
  runCommand(command, args, options) {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(command, args, {
        cwd: options?.cwd,
        stdio: "inherit",
        shell: process.platform === "win32"
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) {
          resolvePromise();
        } else {
          reject(new Error(`${command} ${args.join(" ")} failed with code ${code}`));
        }
      });
    });
  }
  runCommandSync(command, args) {
    const result = spawnSync(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      shell: process.platform === "win32"
    });
    if (result.status !== 0) {
      throw new Error(`Failed to run ${command} ${args.join(" ")}: ${result.stderr || result.stdout}`);
    }
    return (result.stdout || result.stderr || "").trim();
  }
}
export {
  DefaultPackageManager
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL3BhY2thZ2UtbWFuYWdlci50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgc3Bhd24sIHNwYXduU3luYyB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7IGNyZWF0ZUhhc2ggfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMsIG1rZGlyU3luYywgcmVhZGRpclN5bmMsIHJlYWRGaWxlU3luYywgcm1TeW5jLCBzdGF0U3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBob21lZGlyLCB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgYmFzZW5hbWUsIGRpcm5hbWUsIGpvaW4sIHJlbGF0aXZlLCByZXNvbHZlLCBzZXAgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgaWdub3JlIGZyb20gXCJpZ25vcmVcIjtcbmltcG9ydCB7IG1pbmltYXRjaCB9IGZyb20gXCJtaW5pbWF0Y2hcIjtcbmltcG9ydCB7IENPTkZJR19ESVJfTkFNRSB9IGZyb20gXCIuLi9jb25maWcuanNcIjtcbmltcG9ydCB7IHR5cGUgR2l0U291cmNlLCBwYXJzZUdpdFVybCB9IGZyb20gXCIuLi91dGlscy9naXQuanNcIjtcbmltcG9ydCB7IHRvUG9zaXhQYXRoIH0gZnJvbSBcIi4uL3V0aWxzL3BhdGgtZGlzcGxheS5qc1wiO1xuaW1wb3J0IHR5cGUgeyBQYWNrYWdlU291cmNlLCBTZXR0aW5nc01hbmFnZXIgfSBmcm9tIFwiLi9zZXR0aW5ncy1tYW5hZ2VyLmpzXCI7XG5cbmNvbnN0IE5FVFdPUktfVElNRU9VVF9NUyA9IDEwMDAwO1xuXG5mdW5jdGlvbiBpc09mZmxpbmVNb2RlRW5hYmxlZCgpOiBib29sZWFuIHtcblx0Y29uc3QgdmFsdWUgPSBwcm9jZXNzLmVudi5QSV9PRkZMSU5FO1xuXHRpZiAoIXZhbHVlKSByZXR1cm4gZmFsc2U7XG5cdHJldHVybiB2YWx1ZSA9PT0gXCIxXCIgfHwgdmFsdWUudG9Mb3dlckNhc2UoKSA9PT0gXCJ0cnVlXCIgfHwgdmFsdWUudG9Mb3dlckNhc2UoKSA9PT0gXCJ5ZXNcIjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBQYXRoTWV0YWRhdGEge1xuXHRzb3VyY2U6IHN0cmluZztcblx0c2NvcGU6IFNvdXJjZVNjb3BlO1xuXHRvcmlnaW46IFwicGFja2FnZVwiIHwgXCJ0b3AtbGV2ZWxcIjtcblx0YmFzZURpcj86IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBSZXNvbHZlZFJlc291cmNlIHtcblx0cGF0aDogc3RyaW5nO1xuXHRlbmFibGVkOiBib29sZWFuO1xuXHRtZXRhZGF0YTogUGF0aE1ldGFkYXRhO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFJlc29sdmVkUGF0aHMge1xuXHRleHRlbnNpb25zOiBSZXNvbHZlZFJlc291cmNlW107XG5cdHNraWxsczogUmVzb2x2ZWRSZXNvdXJjZVtdO1xuXHRwcm9tcHRzOiBSZXNvbHZlZFJlc291cmNlW107XG5cdHRoZW1lczogUmVzb2x2ZWRSZXNvdXJjZVtdO1xufVxuXG5leHBvcnQgdHlwZSBNaXNzaW5nU291cmNlQWN0aW9uID0gXCJpbnN0YWxsXCIgfCBcInNraXBcIiB8IFwiZXJyb3JcIjtcblxuZXhwb3J0IGludGVyZmFjZSBQcm9ncmVzc0V2ZW50IHtcblx0dHlwZTogXCJzdGFydFwiIHwgXCJwcm9ncmVzc1wiIHwgXCJjb21wbGV0ZVwiIHwgXCJlcnJvclwiO1xuXHRhY3Rpb246IFwiaW5zdGFsbFwiIHwgXCJyZW1vdmVcIiB8IFwidXBkYXRlXCIgfCBcImNsb25lXCIgfCBcInB1bGxcIjtcblx0c291cmNlOiBzdHJpbmc7XG5cdG1lc3NhZ2U/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCB0eXBlIFByb2dyZXNzQ2FsbGJhY2sgPSAoZXZlbnQ6IFByb2dyZXNzRXZlbnQpID0+IHZvaWQ7XG5cbmV4cG9ydCBpbnRlcmZhY2UgUGFja2FnZU1hbmFnZXIge1xuXHRyZXNvbHZlKG9uTWlzc2luZz86IChzb3VyY2U6IHN0cmluZykgPT4gUHJvbWlzZTxNaXNzaW5nU291cmNlQWN0aW9uPik6IFByb21pc2U8UmVzb2x2ZWRQYXRocz47XG5cdGluc3RhbGwoc291cmNlOiBzdHJpbmcsIG9wdGlvbnM/OiB7IGxvY2FsPzogYm9vbGVhbiB9KTogUHJvbWlzZTx2b2lkPjtcblx0cmVtb3ZlKHNvdXJjZTogc3RyaW5nLCBvcHRpb25zPzogeyBsb2NhbD86IGJvb2xlYW4gfSk6IFByb21pc2U8dm9pZD47XG5cdHVwZGF0ZShzb3VyY2U/OiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+O1xuXHRyZXNvbHZlRXh0ZW5zaW9uU291cmNlcyhcblx0XHRzb3VyY2VzOiBzdHJpbmdbXSxcblx0XHRvcHRpb25zPzogeyBsb2NhbD86IGJvb2xlYW47IHRlbXBvcmFyeT86IGJvb2xlYW4gfSxcblx0KTogUHJvbWlzZTxSZXNvbHZlZFBhdGhzPjtcblx0YWRkU291cmNlVG9TZXR0aW5ncyhzb3VyY2U6IHN0cmluZywgb3B0aW9ucz86IHsgbG9jYWw/OiBib29sZWFuIH0pOiBib29sZWFuO1xuXHRyZW1vdmVTb3VyY2VGcm9tU2V0dGluZ3Moc291cmNlOiBzdHJpbmcsIG9wdGlvbnM/OiB7IGxvY2FsPzogYm9vbGVhbiB9KTogYm9vbGVhbjtcblx0c2V0UHJvZ3Jlc3NDYWxsYmFjayhjYWxsYmFjazogUHJvZ3Jlc3NDYWxsYmFjayB8IHVuZGVmaW5lZCk6IHZvaWQ7XG5cdGdldEluc3RhbGxlZFBhdGgoc291cmNlOiBzdHJpbmcsIHNjb3BlOiBcInVzZXJcIiB8IFwicHJvamVjdFwiKTogc3RyaW5nIHwgdW5kZWZpbmVkO1xufVxuXG5pbnRlcmZhY2UgUGFja2FnZU1hbmFnZXJPcHRpb25zIHtcblx0Y3dkOiBzdHJpbmc7XG5cdGFnZW50RGlyOiBzdHJpbmc7XG5cdHNldHRpbmdzTWFuYWdlcjogU2V0dGluZ3NNYW5hZ2VyO1xufVxuXG50eXBlIFNvdXJjZVNjb3BlID0gXCJ1c2VyXCIgfCBcInByb2plY3RcIiB8IFwidGVtcG9yYXJ5XCI7XG5cbnR5cGUgTnBtU291cmNlID0ge1xuXHR0eXBlOiBcIm5wbVwiO1xuXHRzcGVjOiBzdHJpbmc7XG5cdG5hbWU6IHN0cmluZztcblx0cGlubmVkOiBib29sZWFuO1xufTtcblxudHlwZSBMb2NhbFNvdXJjZSA9IHtcblx0dHlwZTogXCJsb2NhbFwiO1xuXHRwYXRoOiBzdHJpbmc7XG59O1xuXG50eXBlIFBhcnNlZFNvdXJjZSA9IE5wbVNvdXJjZSB8IEdpdFNvdXJjZSB8IExvY2FsU291cmNlO1xuXG5pbnRlcmZhY2UgUGlNYW5pZmVzdCB7XG5cdGV4dGVuc2lvbnM/OiBzdHJpbmdbXTtcblx0c2tpbGxzPzogc3RyaW5nW107XG5cdHByb21wdHM/OiBzdHJpbmdbXTtcblx0dGhlbWVzPzogc3RyaW5nW107XG59XG5cbmludGVyZmFjZSBSZXNvdXJjZUFjY3VtdWxhdG9yIHtcblx0ZXh0ZW5zaW9uczogTWFwPHN0cmluZywgeyBtZXRhZGF0YTogUGF0aE1ldGFkYXRhOyBlbmFibGVkOiBib29sZWFuIH0+O1xuXHRza2lsbHM6IE1hcDxzdHJpbmcsIHsgbWV0YWRhdGE6IFBhdGhNZXRhZGF0YTsgZW5hYmxlZDogYm9vbGVhbiB9Pjtcblx0cHJvbXB0czogTWFwPHN0cmluZywgeyBtZXRhZGF0YTogUGF0aE1ldGFkYXRhOyBlbmFibGVkOiBib29sZWFuIH0+O1xuXHR0aGVtZXM6IE1hcDxzdHJpbmcsIHsgbWV0YWRhdGE6IFBhdGhNZXRhZGF0YTsgZW5hYmxlZDogYm9vbGVhbiB9Pjtcbn1cblxuaW50ZXJmYWNlIFBhY2thZ2VGaWx0ZXIge1xuXHRleHRlbnNpb25zPzogc3RyaW5nW107XG5cdHNraWxscz86IHN0cmluZ1tdO1xuXHRwcm9tcHRzPzogc3RyaW5nW107XG5cdHRoZW1lcz86IHN0cmluZ1tdO1xufVxuXG50eXBlIFJlc291cmNlVHlwZSA9IFwiZXh0ZW5zaW9uc1wiIHwgXCJza2lsbHNcIiB8IFwicHJvbXB0c1wiIHwgXCJ0aGVtZXNcIjtcblxuY29uc3QgUkVTT1VSQ0VfVFlQRVM6IFJlc291cmNlVHlwZVtdID0gW1wiZXh0ZW5zaW9uc1wiLCBcInNraWxsc1wiLCBcInByb21wdHNcIiwgXCJ0aGVtZXNcIl07XG5cbmNvbnN0IEZJTEVfUEFUVEVSTlM6IFJlY29yZDxSZXNvdXJjZVR5cGUsIFJlZ0V4cD4gPSB7XG5cdGV4dGVuc2lvbnM6IC9cXC4odHN8anMpJC8sXG5cdHNraWxsczogL1xcLm1kJC8sXG5cdHByb21wdHM6IC9cXC5tZCQvLFxuXHR0aGVtZXM6IC9cXC5qc29uJC8sXG59O1xuXG5jb25zdCBJR05PUkVfRklMRV9OQU1FUyA9IFtcIi5naXRpZ25vcmVcIiwgXCIuaWdub3JlXCIsIFwiLmZkaWdub3JlXCJdO1xuXG50eXBlIElnbm9yZU1hdGNoZXIgPSBSZXR1cm5UeXBlPHR5cGVvZiBpZ25vcmU+O1xuXG5mdW5jdGlvbiBwcmVmaXhJZ25vcmVQYXR0ZXJuKGxpbmU6IHN0cmluZywgcHJlZml4OiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcblx0Y29uc3QgdHJpbW1lZCA9IGxpbmUudHJpbSgpO1xuXHRpZiAoIXRyaW1tZWQpIHJldHVybiBudWxsO1xuXHRpZiAodHJpbW1lZC5zdGFydHNXaXRoKFwiI1wiKSAmJiAhdHJpbW1lZC5zdGFydHNXaXRoKFwiXFxcXCNcIikpIHJldHVybiBudWxsO1xuXG5cdGxldCBwYXR0ZXJuID0gbGluZTtcblx0bGV0IG5lZ2F0ZWQgPSBmYWxzZTtcblxuXHRpZiAocGF0dGVybi5zdGFydHNXaXRoKFwiIVwiKSkge1xuXHRcdG5lZ2F0ZWQgPSB0cnVlO1xuXHRcdHBhdHRlcm4gPSBwYXR0ZXJuLnNsaWNlKDEpO1xuXHR9IGVsc2UgaWYgKHBhdHRlcm4uc3RhcnRzV2l0aChcIlxcXFwhXCIpKSB7XG5cdFx0cGF0dGVybiA9IHBhdHRlcm4uc2xpY2UoMSk7XG5cdH1cblxuXHRpZiAocGF0dGVybi5zdGFydHNXaXRoKFwiL1wiKSkge1xuXHRcdHBhdHRlcm4gPSBwYXR0ZXJuLnNsaWNlKDEpO1xuXHR9XG5cblx0Y29uc3QgcHJlZml4ZWQgPSBwcmVmaXggPyBgJHtwcmVmaXh9JHtwYXR0ZXJufWAgOiBwYXR0ZXJuO1xuXHRyZXR1cm4gbmVnYXRlZCA/IGAhJHtwcmVmaXhlZH1gIDogcHJlZml4ZWQ7XG59XG5cbmZ1bmN0aW9uIGFkZElnbm9yZVJ1bGVzKGlnOiBJZ25vcmVNYXRjaGVyLCBkaXI6IHN0cmluZywgcm9vdERpcjogc3RyaW5nKTogdm9pZCB7XG5cdGNvbnN0IHJlbGF0aXZlRGlyID0gcmVsYXRpdmUocm9vdERpciwgZGlyKTtcblx0Y29uc3QgcHJlZml4ID0gcmVsYXRpdmVEaXIgPyBgJHt0b1Bvc2l4UGF0aChyZWxhdGl2ZURpcil9L2AgOiBcIlwiO1xuXG5cdGZvciAoY29uc3QgZmlsZW5hbWUgb2YgSUdOT1JFX0ZJTEVfTkFNRVMpIHtcblx0XHRjb25zdCBpZ25vcmVQYXRoID0gam9pbihkaXIsIGZpbGVuYW1lKTtcblx0XHRpZiAoIWV4aXN0c1N5bmMoaWdub3JlUGF0aCkpIGNvbnRpbnVlO1xuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBjb250ZW50ID0gcmVhZEZpbGVTeW5jKGlnbm9yZVBhdGgsIFwidXRmLThcIik7XG5cdFx0XHRjb25zdCBwYXR0ZXJucyA9IGNvbnRlbnRcblx0XHRcdFx0LnNwbGl0KC9cXHI/XFxuLylcblx0XHRcdFx0Lm1hcCgobGluZSkgPT4gcHJlZml4SWdub3JlUGF0dGVybihsaW5lLCBwcmVmaXgpKVxuXHRcdFx0XHQuZmlsdGVyKChsaW5lKTogbGluZSBpcyBzdHJpbmcgPT4gQm9vbGVhbihsaW5lKSk7XG5cdFx0XHRpZiAocGF0dGVybnMubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRpZy5hZGQocGF0dGVybnMpO1xuXHRcdFx0fVxuXHRcdH0gY2F0Y2gge31cblx0fVxufVxuXG5mdW5jdGlvbiBpc1BhdHRlcm4oczogc3RyaW5nKTogYm9vbGVhbiB7XG5cdHJldHVybiBzLnN0YXJ0c1dpdGgoXCIhXCIpIHx8IHMuc3RhcnRzV2l0aChcIitcIikgfHwgcy5zdGFydHNXaXRoKFwiLVwiKSB8fCBzLmluY2x1ZGVzKFwiKlwiKSB8fCBzLmluY2x1ZGVzKFwiP1wiKTtcbn1cblxuZnVuY3Rpb24gc3BsaXRQYXR0ZXJucyhlbnRyaWVzOiBzdHJpbmdbXSk6IHsgcGxhaW46IHN0cmluZ1tdOyBwYXR0ZXJuczogc3RyaW5nW10gfSB7XG5cdGNvbnN0IHBsYWluOiBzdHJpbmdbXSA9IFtdO1xuXHRjb25zdCBwYXR0ZXJuczogc3RyaW5nW10gPSBbXTtcblx0Zm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSB7XG5cdFx0aWYgKGlzUGF0dGVybihlbnRyeSkpIHtcblx0XHRcdHBhdHRlcm5zLnB1c2goZW50cnkpO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHRwbGFpbi5wdXNoKGVudHJ5KTtcblx0XHR9XG5cdH1cblx0cmV0dXJuIHsgcGxhaW4sIHBhdHRlcm5zIH07XG59XG5cbmZ1bmN0aW9uIGNvbGxlY3RGaWxlcyhcblx0ZGlyOiBzdHJpbmcsXG5cdGZpbGVQYXR0ZXJuOiBSZWdFeHAsXG5cdHNraXBOb2RlTW9kdWxlcyA9IHRydWUsXG5cdGlnbm9yZU1hdGNoZXI/OiBJZ25vcmVNYXRjaGVyLFxuXHRyb290RGlyPzogc3RyaW5nLFxuKTogc3RyaW5nW10ge1xuXHRjb25zdCBmaWxlczogc3RyaW5nW10gPSBbXTtcblx0aWYgKCFleGlzdHNTeW5jKGRpcikpIHJldHVybiBmaWxlcztcblxuXHRjb25zdCByb290ID0gcm9vdERpciA/PyBkaXI7XG5cdGNvbnN0IGlnID0gaWdub3JlTWF0Y2hlciA/PyBpZ25vcmUoKTtcblx0YWRkSWdub3JlUnVsZXMoaWcsIGRpciwgcm9vdCk7XG5cblx0dHJ5IHtcblx0XHRjb25zdCBlbnRyaWVzID0gcmVhZGRpclN5bmMoZGlyLCB7IHdpdGhGaWxlVHlwZXM6IHRydWUgfSk7XG5cdFx0Zm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSB7XG5cdFx0XHRpZiAoZW50cnkubmFtZS5zdGFydHNXaXRoKFwiLlwiKSkgY29udGludWU7XG5cdFx0XHRpZiAoc2tpcE5vZGVNb2R1bGVzICYmIGVudHJ5Lm5hbWUgPT09IFwibm9kZV9tb2R1bGVzXCIpIGNvbnRpbnVlO1xuXG5cdFx0XHRjb25zdCBmdWxsUGF0aCA9IGpvaW4oZGlyLCBlbnRyeS5uYW1lKTtcblx0XHRcdGxldCBpc0RpciA9IGVudHJ5LmlzRGlyZWN0b3J5KCk7XG5cdFx0XHRsZXQgaXNGaWxlID0gZW50cnkuaXNGaWxlKCk7XG5cblx0XHRcdGlmIChlbnRyeS5pc1N5bWJvbGljTGluaygpKSB7XG5cdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0Y29uc3Qgc3RhdHMgPSBzdGF0U3luYyhmdWxsUGF0aCk7XG5cdFx0XHRcdFx0aXNEaXIgPSBzdGF0cy5pc0RpcmVjdG9yeSgpO1xuXHRcdFx0XHRcdGlzRmlsZSA9IHN0YXRzLmlzRmlsZSgpO1xuXHRcdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0XHRjb250aW51ZTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCByZWxQYXRoID0gdG9Qb3NpeFBhdGgocmVsYXRpdmUocm9vdCwgZnVsbFBhdGgpKTtcblx0XHRcdGNvbnN0IGlnbm9yZVBhdGggPSBpc0RpciA/IGAke3JlbFBhdGh9L2AgOiByZWxQYXRoO1xuXHRcdFx0aWYgKGlnLmlnbm9yZXMoaWdub3JlUGF0aCkpIGNvbnRpbnVlO1xuXG5cdFx0XHRpZiAoaXNEaXIpIHtcblx0XHRcdFx0ZmlsZXMucHVzaCguLi5jb2xsZWN0RmlsZXMoZnVsbFBhdGgsIGZpbGVQYXR0ZXJuLCBza2lwTm9kZU1vZHVsZXMsIGlnLCByb290KSk7XG5cdFx0XHR9IGVsc2UgaWYgKGlzRmlsZSAmJiBmaWxlUGF0dGVybi50ZXN0KGVudHJ5Lm5hbWUpKSB7XG5cdFx0XHRcdGZpbGVzLnB1c2goZnVsbFBhdGgpO1xuXHRcdFx0fVxuXHRcdH1cblx0fSBjYXRjaCB7XG5cdFx0Ly8gSWdub3JlIGVycm9yc1xuXHR9XG5cblx0cmV0dXJuIGZpbGVzO1xufVxuXG5mdW5jdGlvbiBjb2xsZWN0U2tpbGxFbnRyaWVzKFxuXHRkaXI6IHN0cmluZyxcblx0aW5jbHVkZVJvb3RGaWxlcyA9IHRydWUsXG5cdGlnbm9yZU1hdGNoZXI/OiBJZ25vcmVNYXRjaGVyLFxuXHRyb290RGlyPzogc3RyaW5nLFxuKTogc3RyaW5nW10ge1xuXHRjb25zdCBlbnRyaWVzOiBzdHJpbmdbXSA9IFtdO1xuXHRpZiAoIWV4aXN0c1N5bmMoZGlyKSkgcmV0dXJuIGVudHJpZXM7XG5cblx0Y29uc3Qgcm9vdCA9IHJvb3REaXIgPz8gZGlyO1xuXHRjb25zdCBpZyA9IGlnbm9yZU1hdGNoZXIgPz8gaWdub3JlKCk7XG5cdGFkZElnbm9yZVJ1bGVzKGlnLCBkaXIsIHJvb3QpO1xuXG5cdHRyeSB7XG5cdFx0Y29uc3QgZGlyRW50cmllcyA9IHJlYWRkaXJTeW5jKGRpciwgeyB3aXRoRmlsZVR5cGVzOiB0cnVlIH0pO1xuXHRcdGZvciAoY29uc3QgZW50cnkgb2YgZGlyRW50cmllcykge1xuXHRcdFx0aWYgKGVudHJ5Lm5hbWUuc3RhcnRzV2l0aChcIi5cIikpIGNvbnRpbnVlO1xuXHRcdFx0aWYgKGVudHJ5Lm5hbWUgPT09IFwibm9kZV9tb2R1bGVzXCIpIGNvbnRpbnVlO1xuXG5cdFx0XHRjb25zdCBmdWxsUGF0aCA9IGpvaW4oZGlyLCBlbnRyeS5uYW1lKTtcblx0XHRcdGxldCBpc0RpciA9IGVudHJ5LmlzRGlyZWN0b3J5KCk7XG5cdFx0XHRsZXQgaXNGaWxlID0gZW50cnkuaXNGaWxlKCk7XG5cblx0XHRcdGlmIChlbnRyeS5pc1N5bWJvbGljTGluaygpKSB7XG5cdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0Y29uc3Qgc3RhdHMgPSBzdGF0U3luYyhmdWxsUGF0aCk7XG5cdFx0XHRcdFx0aXNEaXIgPSBzdGF0cy5pc0RpcmVjdG9yeSgpO1xuXHRcdFx0XHRcdGlzRmlsZSA9IHN0YXRzLmlzRmlsZSgpO1xuXHRcdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0XHRjb250aW51ZTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCByZWxQYXRoID0gdG9Qb3NpeFBhdGgocmVsYXRpdmUocm9vdCwgZnVsbFBhdGgpKTtcblx0XHRcdGNvbnN0IGlnbm9yZVBhdGggPSBpc0RpciA/IGAke3JlbFBhdGh9L2AgOiByZWxQYXRoO1xuXHRcdFx0aWYgKGlnLmlnbm9yZXMoaWdub3JlUGF0aCkpIGNvbnRpbnVlO1xuXG5cdFx0XHRpZiAoaXNEaXIpIHtcblx0XHRcdFx0ZW50cmllcy5wdXNoKC4uLmNvbGxlY3RTa2lsbEVudHJpZXMoZnVsbFBhdGgsIGZhbHNlLCBpZywgcm9vdCkpO1xuXHRcdFx0fSBlbHNlIGlmIChpc0ZpbGUpIHtcblx0XHRcdFx0Y29uc3QgaXNSb290TWQgPSBpbmNsdWRlUm9vdEZpbGVzICYmIGVudHJ5Lm5hbWUuZW5kc1dpdGgoXCIubWRcIik7XG5cdFx0XHRcdGNvbnN0IGlzU2tpbGxNZCA9ICFpbmNsdWRlUm9vdEZpbGVzICYmIGVudHJ5Lm5hbWUgPT09IFwiU0tJTEwubWRcIjtcblx0XHRcdFx0aWYgKGlzUm9vdE1kIHx8IGlzU2tpbGxNZCkge1xuXHRcdFx0XHRcdGVudHJpZXMucHVzaChmdWxsUGF0aCk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9XG5cdH0gY2F0Y2gge1xuXHRcdC8vIElnbm9yZSBlcnJvcnNcblx0fVxuXG5cdHJldHVybiBlbnRyaWVzO1xufVxuXG5mdW5jdGlvbiBjb2xsZWN0QXV0b1NraWxsRW50cmllcyhkaXI6IHN0cmluZywgaW5jbHVkZVJvb3RGaWxlcyA9IHRydWUpOiBzdHJpbmdbXSB7XG5cdHJldHVybiBjb2xsZWN0U2tpbGxFbnRyaWVzKGRpciwgaW5jbHVkZVJvb3RGaWxlcyk7XG59XG5cbmZ1bmN0aW9uIGZpbmRHaXRSZXBvUm9vdChzdGFydERpcjogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG5cdGxldCBkaXIgPSByZXNvbHZlKHN0YXJ0RGlyKTtcblx0d2hpbGUgKHRydWUpIHtcblx0XHRpZiAoZXhpc3RzU3luYyhqb2luKGRpciwgXCIuZ2l0XCIpKSkge1xuXHRcdFx0cmV0dXJuIGRpcjtcblx0XHR9XG5cdFx0Y29uc3QgcGFyZW50ID0gZGlybmFtZShkaXIpO1xuXHRcdGlmIChwYXJlbnQgPT09IGRpcikge1xuXHRcdFx0cmV0dXJuIG51bGw7XG5cdFx0fVxuXHRcdGRpciA9IHBhcmVudDtcblx0fVxufVxuXG5mdW5jdGlvbiBjb2xsZWN0QW5jZXN0b3JBZ2VudHNTa2lsbERpcnMoc3RhcnREaXI6IHN0cmluZyk6IHN0cmluZ1tdIHtcblx0Y29uc3Qgc2tpbGxEaXJzOiBzdHJpbmdbXSA9IFtdO1xuXHRjb25zdCByZXNvbHZlZFN0YXJ0RGlyID0gcmVzb2x2ZShzdGFydERpcik7XG5cdGNvbnN0IGdpdFJlcG9Sb290ID0gZmluZEdpdFJlcG9Sb290KHJlc29sdmVkU3RhcnREaXIpO1xuXG5cdGxldCBkaXIgPSByZXNvbHZlZFN0YXJ0RGlyO1xuXHR3aGlsZSAodHJ1ZSkge1xuXHRcdHNraWxsRGlycy5wdXNoKGpvaW4oZGlyLCBcIi5hZ2VudHNcIiwgXCJza2lsbHNcIikpO1xuXHRcdGlmIChnaXRSZXBvUm9vdCAmJiBkaXIgPT09IGdpdFJlcG9Sb290KSB7XG5cdFx0XHRicmVhaztcblx0XHR9XG5cdFx0Y29uc3QgcGFyZW50ID0gZGlybmFtZShkaXIpO1xuXHRcdGlmIChwYXJlbnQgPT09IGRpcikge1xuXHRcdFx0YnJlYWs7XG5cdFx0fVxuXHRcdGRpciA9IHBhcmVudDtcblx0fVxuXG5cdHJldHVybiBza2lsbERpcnM7XG59XG5cbmZ1bmN0aW9uIGNvbGxlY3RBdXRvUHJvbXB0RW50cmllcyhkaXI6IHN0cmluZyk6IHN0cmluZ1tdIHtcblx0Y29uc3QgZW50cmllczogc3RyaW5nW10gPSBbXTtcblx0aWYgKCFleGlzdHNTeW5jKGRpcikpIHJldHVybiBlbnRyaWVzO1xuXG5cdGNvbnN0IGlnID0gaWdub3JlKCk7XG5cdGFkZElnbm9yZVJ1bGVzKGlnLCBkaXIsIGRpcik7XG5cblx0dHJ5IHtcblx0XHRjb25zdCBkaXJFbnRyaWVzID0gcmVhZGRpclN5bmMoZGlyLCB7IHdpdGhGaWxlVHlwZXM6IHRydWUgfSk7XG5cdFx0Zm9yIChjb25zdCBlbnRyeSBvZiBkaXJFbnRyaWVzKSB7XG5cdFx0XHRpZiAoZW50cnkubmFtZS5zdGFydHNXaXRoKFwiLlwiKSkgY29udGludWU7XG5cdFx0XHRpZiAoZW50cnkubmFtZSA9PT0gXCJub2RlX21vZHVsZXNcIikgY29udGludWU7XG5cblx0XHRcdGNvbnN0IGZ1bGxQYXRoID0gam9pbihkaXIsIGVudHJ5Lm5hbWUpO1xuXHRcdFx0bGV0IGlzRmlsZSA9IGVudHJ5LmlzRmlsZSgpO1xuXHRcdFx0aWYgKGVudHJ5LmlzU3ltYm9saWNMaW5rKCkpIHtcblx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRpc0ZpbGUgPSBzdGF0U3luYyhmdWxsUGF0aCkuaXNGaWxlKCk7XG5cdFx0XHRcdH0gY2F0Y2gge1xuXHRcdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IHJlbFBhdGggPSB0b1Bvc2l4UGF0aChyZWxhdGl2ZShkaXIsIGZ1bGxQYXRoKSk7XG5cdFx0XHRpZiAoaWcuaWdub3JlcyhyZWxQYXRoKSkgY29udGludWU7XG5cblx0XHRcdGlmIChpc0ZpbGUgJiYgZW50cnkubmFtZS5lbmRzV2l0aChcIi5tZFwiKSkge1xuXHRcdFx0XHRlbnRyaWVzLnB1c2goZnVsbFBhdGgpO1xuXHRcdFx0fVxuXHRcdH1cblx0fSBjYXRjaCB7XG5cdFx0Ly8gSWdub3JlIGVycm9yc1xuXHR9XG5cblx0cmV0dXJuIGVudHJpZXM7XG59XG5cbmZ1bmN0aW9uIGNvbGxlY3RBdXRvVGhlbWVFbnRyaWVzKGRpcjogc3RyaW5nKTogc3RyaW5nW10ge1xuXHRjb25zdCBlbnRyaWVzOiBzdHJpbmdbXSA9IFtdO1xuXHRpZiAoIWV4aXN0c1N5bmMoZGlyKSkgcmV0dXJuIGVudHJpZXM7XG5cblx0Y29uc3QgaWcgPSBpZ25vcmUoKTtcblx0YWRkSWdub3JlUnVsZXMoaWcsIGRpciwgZGlyKTtcblxuXHR0cnkge1xuXHRcdGNvbnN0IGRpckVudHJpZXMgPSByZWFkZGlyU3luYyhkaXIsIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KTtcblx0XHRmb3IgKGNvbnN0IGVudHJ5IG9mIGRpckVudHJpZXMpIHtcblx0XHRcdGlmIChlbnRyeS5uYW1lLnN0YXJ0c1dpdGgoXCIuXCIpKSBjb250aW51ZTtcblx0XHRcdGlmIChlbnRyeS5uYW1lID09PSBcIm5vZGVfbW9kdWxlc1wiKSBjb250aW51ZTtcblxuXHRcdFx0Y29uc3QgZnVsbFBhdGggPSBqb2luKGRpciwgZW50cnkubmFtZSk7XG5cdFx0XHRsZXQgaXNGaWxlID0gZW50cnkuaXNGaWxlKCk7XG5cdFx0XHRpZiAoZW50cnkuaXNTeW1ib2xpY0xpbmsoKSkge1xuXHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdGlzRmlsZSA9IHN0YXRTeW5jKGZ1bGxQYXRoKS5pc0ZpbGUoKTtcblx0XHRcdFx0fSBjYXRjaCB7XG5cdFx0XHRcdFx0Y29udGludWU7XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgcmVsUGF0aCA9IHRvUG9zaXhQYXRoKHJlbGF0aXZlKGRpciwgZnVsbFBhdGgpKTtcblx0XHRcdGlmIChpZy5pZ25vcmVzKHJlbFBhdGgpKSBjb250aW51ZTtcblxuXHRcdFx0aWYgKGlzRmlsZSAmJiBlbnRyeS5uYW1lLmVuZHNXaXRoKFwiLmpzb25cIikpIHtcblx0XHRcdFx0ZW50cmllcy5wdXNoKGZ1bGxQYXRoKTtcblx0XHRcdH1cblx0XHR9XG5cdH0gY2F0Y2gge1xuXHRcdC8vIElnbm9yZSBlcnJvcnNcblx0fVxuXG5cdHJldHVybiBlbnRyaWVzO1xufVxuXG5mdW5jdGlvbiByZWFkUGlNYW5pZmVzdEZpbGUocGFja2FnZUpzb25QYXRoOiBzdHJpbmcpOiBQaU1hbmlmZXN0IHwgbnVsbCB7XG5cdHRyeSB7XG5cdFx0Y29uc3QgY29udGVudCA9IHJlYWRGaWxlU3luYyhwYWNrYWdlSnNvblBhdGgsIFwidXRmLThcIik7XG5cdFx0Y29uc3QgcGtnID0gSlNPTi5wYXJzZShjb250ZW50KSBhcyB7IHBpPzogUGlNYW5pZmVzdCB9O1xuXHRcdHJldHVybiBwa2cucGkgPz8gbnVsbDtcblx0fSBjYXRjaCB7XG5cdFx0cmV0dXJuIG51bGw7XG5cdH1cbn1cblxuZnVuY3Rpb24gcmVzb2x2ZUV4dGVuc2lvbkVudHJpZXMoZGlyOiBzdHJpbmcpOiBzdHJpbmdbXSB8IG51bGwge1xuXHRjb25zdCBwYWNrYWdlSnNvblBhdGggPSBqb2luKGRpciwgXCJwYWNrYWdlLmpzb25cIik7XG5cdGlmIChleGlzdHNTeW5jKHBhY2thZ2VKc29uUGF0aCkpIHtcblx0XHRjb25zdCBtYW5pZmVzdCA9IHJlYWRQaU1hbmlmZXN0RmlsZShwYWNrYWdlSnNvblBhdGgpO1xuXHRcdGlmIChtYW5pZmVzdCkge1xuXHRcdFx0Ly8gV2hlbiBhIHBpIG1hbmlmZXN0IGV4aXN0cywgaXQgaXMgYXV0aG9yaXRhdGl2ZSBcdTIwMTQgZG9uJ3QgZmFsbCB0aHJvdWdoXG5cdFx0XHQvLyB0byBpbmRleC50cy9pbmRleC5qcyBhdXRvLWRldGVjdGlvbi4gVGhpcyBhbGxvd3MgbGlicmFyeSBkaXJlY3Rvcmllc1xuXHRcdFx0Ly8gKGxpa2UgY211eCkgdG8gb3B0IG91dCBieSBkZWNsYXJpbmcgXCJwaVwiOiB7fSB3aXRoIG5vIGV4dGVuc2lvbnMuXG5cdFx0XHRpZiAoIW1hbmlmZXN0LmV4dGVuc2lvbnM/Lmxlbmd0aCkge1xuXHRcdFx0XHRyZXR1cm4gbnVsbDtcblx0XHRcdH1cblx0XHRcdGNvbnN0IGVudHJpZXM6IHN0cmluZ1tdID0gW107XG5cdFx0XHRmb3IgKGNvbnN0IGV4dFBhdGggb2YgbWFuaWZlc3QuZXh0ZW5zaW9ucykge1xuXHRcdFx0XHRjb25zdCByZXNvbHZlZEV4dFBhdGggPSByZXNvbHZlKGRpciwgZXh0UGF0aCk7XG5cdFx0XHRcdGlmIChleGlzdHNTeW5jKHJlc29sdmVkRXh0UGF0aCkpIHtcblx0XHRcdFx0XHRlbnRyaWVzLnB1c2gocmVzb2x2ZWRFeHRQYXRoKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdFx0cmV0dXJuIGVudHJpZXMubGVuZ3RoID4gMCA/IGVudHJpZXMgOiBudWxsO1xuXHRcdH1cblx0fVxuXG5cdGNvbnN0IGluZGV4VHMgPSBqb2luKGRpciwgXCJpbmRleC50c1wiKTtcblx0Y29uc3QgaW5kZXhKcyA9IGpvaW4oZGlyLCBcImluZGV4LmpzXCIpO1xuXHRpZiAoZXhpc3RzU3luYyhpbmRleFRzKSkge1xuXHRcdHJldHVybiBbaW5kZXhUc107XG5cdH1cblx0aWYgKGV4aXN0c1N5bmMoaW5kZXhKcykpIHtcblx0XHRyZXR1cm4gW2luZGV4SnNdO1xuXHR9XG5cblx0cmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIGNvbGxlY3RBdXRvRXh0ZW5zaW9uRW50cmllcyhkaXI6IHN0cmluZyk6IHN0cmluZ1tdIHtcblx0Y29uc3QgZW50cmllczogc3RyaW5nW10gPSBbXTtcblx0aWYgKCFleGlzdHNTeW5jKGRpcikpIHJldHVybiBlbnRyaWVzO1xuXG5cdC8vIEZpcnN0IGNoZWNrIGlmIHRoaXMgZGlyZWN0b3J5IGl0c2VsZiBoYXMgZXhwbGljaXQgZXh0ZW5zaW9uIGVudHJpZXMgKHBhY2thZ2UuanNvbiBvciBpbmRleClcblx0Y29uc3Qgcm9vdEVudHJpZXMgPSByZXNvbHZlRXh0ZW5zaW9uRW50cmllcyhkaXIpO1xuXHRpZiAocm9vdEVudHJpZXMpIHtcblx0XHRyZXR1cm4gcm9vdEVudHJpZXM7XG5cdH1cblxuXHQvLyBPdGhlcndpc2UsIGRpc2NvdmVyIGV4dGVuc2lvbnMgZnJvbSBkaXJlY3RvcnkgY29udGVudHNcblx0Y29uc3QgaWcgPSBpZ25vcmUoKTtcblx0YWRkSWdub3JlUnVsZXMoaWcsIGRpciwgZGlyKTtcblxuXHR0cnkge1xuXHRcdGNvbnN0IGRpckVudHJpZXMgPSByZWFkZGlyU3luYyhkaXIsIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KTtcblx0XHRmb3IgKGNvbnN0IGVudHJ5IG9mIGRpckVudHJpZXMpIHtcblx0XHRcdGlmIChlbnRyeS5uYW1lLnN0YXJ0c1dpdGgoXCIuXCIpKSBjb250aW51ZTtcblx0XHRcdGlmIChlbnRyeS5uYW1lID09PSBcIm5vZGVfbW9kdWxlc1wiKSBjb250aW51ZTtcblxuXHRcdFx0Y29uc3QgZnVsbFBhdGggPSBqb2luKGRpciwgZW50cnkubmFtZSk7XG5cdFx0XHRsZXQgaXNEaXIgPSBlbnRyeS5pc0RpcmVjdG9yeSgpO1xuXHRcdFx0bGV0IGlzRmlsZSA9IGVudHJ5LmlzRmlsZSgpO1xuXG5cdFx0XHRpZiAoZW50cnkuaXNTeW1ib2xpY0xpbmsoKSkge1xuXHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdGNvbnN0IHN0YXRzID0gc3RhdFN5bmMoZnVsbFBhdGgpO1xuXHRcdFx0XHRcdGlzRGlyID0gc3RhdHMuaXNEaXJlY3RvcnkoKTtcblx0XHRcdFx0XHRpc0ZpbGUgPSBzdGF0cy5pc0ZpbGUoKTtcblx0XHRcdFx0fSBjYXRjaCB7XG5cdFx0XHRcdFx0Y29udGludWU7XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgcmVsUGF0aCA9IHRvUG9zaXhQYXRoKHJlbGF0aXZlKGRpciwgZnVsbFBhdGgpKTtcblx0XHRcdGNvbnN0IGlnbm9yZVBhdGggPSBpc0RpciA/IGAke3JlbFBhdGh9L2AgOiByZWxQYXRoO1xuXHRcdFx0aWYgKGlnLmlnbm9yZXMoaWdub3JlUGF0aCkpIGNvbnRpbnVlO1xuXG5cdFx0XHRpZiAoaXNGaWxlICYmIChlbnRyeS5uYW1lLmVuZHNXaXRoKFwiLnRzXCIpIHx8IGVudHJ5Lm5hbWUuZW5kc1dpdGgoXCIuanNcIikpKSB7XG5cdFx0XHRcdGVudHJpZXMucHVzaChmdWxsUGF0aCk7XG5cdFx0XHR9IGVsc2UgaWYgKGlzRGlyKSB7XG5cdFx0XHRcdGNvbnN0IHJlc29sdmVkRW50cmllcyA9IHJlc29sdmVFeHRlbnNpb25FbnRyaWVzKGZ1bGxQYXRoKTtcblx0XHRcdFx0aWYgKHJlc29sdmVkRW50cmllcykge1xuXHRcdFx0XHRcdGVudHJpZXMucHVzaCguLi5yZXNvbHZlZEVudHJpZXMpO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0fVxuXHR9IGNhdGNoIHtcblx0XHQvLyBJZ25vcmUgZXJyb3JzXG5cdH1cblxuXHRyZXR1cm4gZW50cmllcztcbn1cblxuLyoqXG4gKiBDb2xsZWN0IHJlc291cmNlIGZpbGVzIGZyb20gYSBkaXJlY3RvcnkgYmFzZWQgb24gcmVzb3VyY2UgdHlwZS5cbiAqIEV4dGVuc2lvbnMgdXNlIHNtYXJ0IGRpc2NvdmVyeSAoaW5kZXgudHMgaW4gc3ViZGlycyksIG90aGVycyB1c2UgcmVjdXJzaXZlIGNvbGxlY3Rpb24uXG4gKi9cbmZ1bmN0aW9uIGNvbGxlY3RSZXNvdXJjZUZpbGVzKGRpcjogc3RyaW5nLCByZXNvdXJjZVR5cGU6IFJlc291cmNlVHlwZSk6IHN0cmluZ1tdIHtcblx0aWYgKHJlc291cmNlVHlwZSA9PT0gXCJza2lsbHNcIikge1xuXHRcdHJldHVybiBjb2xsZWN0U2tpbGxFbnRyaWVzKGRpcik7XG5cdH1cblx0aWYgKHJlc291cmNlVHlwZSA9PT0gXCJleHRlbnNpb25zXCIpIHtcblx0XHRyZXR1cm4gY29sbGVjdEF1dG9FeHRlbnNpb25FbnRyaWVzKGRpcik7XG5cdH1cblx0cmV0dXJuIGNvbGxlY3RGaWxlcyhkaXIsIEZJTEVfUEFUVEVSTlNbcmVzb3VyY2VUeXBlXSk7XG59XG5cbmZ1bmN0aW9uIG1hdGNoZXNBbnlQYXR0ZXJuKGZpbGVQYXRoOiBzdHJpbmcsIHBhdHRlcm5zOiBzdHJpbmdbXSwgYmFzZURpcjogc3RyaW5nKTogYm9vbGVhbiB7XG5cdGNvbnN0IHJlbCA9IHJlbGF0aXZlKGJhc2VEaXIsIGZpbGVQYXRoKTtcblx0Y29uc3QgbmFtZSA9IGJhc2VuYW1lKGZpbGVQYXRoKTtcblx0Y29uc3QgaXNTa2lsbEZpbGUgPSBuYW1lID09PSBcIlNLSUxMLm1kXCI7XG5cdGNvbnN0IHBhcmVudERpciA9IGlzU2tpbGxGaWxlID8gZGlybmFtZShmaWxlUGF0aCkgOiB1bmRlZmluZWQ7XG5cdGNvbnN0IHBhcmVudFJlbCA9IGlzU2tpbGxGaWxlID8gcmVsYXRpdmUoYmFzZURpciwgcGFyZW50RGlyISkgOiB1bmRlZmluZWQ7XG5cdGNvbnN0IHBhcmVudE5hbWUgPSBpc1NraWxsRmlsZSA/IGJhc2VuYW1lKHBhcmVudERpciEpIDogdW5kZWZpbmVkO1xuXG5cdHJldHVybiBwYXR0ZXJucy5zb21lKChwYXR0ZXJuKSA9PiB7XG5cdFx0aWYgKG1pbmltYXRjaChyZWwsIHBhdHRlcm4pIHx8IG1pbmltYXRjaChuYW1lLCBwYXR0ZXJuKSB8fCBtaW5pbWF0Y2goZmlsZVBhdGgsIHBhdHRlcm4pKSB7XG5cdFx0XHRyZXR1cm4gdHJ1ZTtcblx0XHR9XG5cdFx0aWYgKCFpc1NraWxsRmlsZSkgcmV0dXJuIGZhbHNlO1xuXHRcdHJldHVybiBtaW5pbWF0Y2gocGFyZW50UmVsISwgcGF0dGVybikgfHwgbWluaW1hdGNoKHBhcmVudE5hbWUhLCBwYXR0ZXJuKSB8fCBtaW5pbWF0Y2gocGFyZW50RGlyISwgcGF0dGVybik7XG5cdH0pO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVFeGFjdFBhdHRlcm4ocGF0dGVybjogc3RyaW5nKTogc3RyaW5nIHtcblx0aWYgKHBhdHRlcm4uc3RhcnRzV2l0aChcIi4vXCIpIHx8IHBhdHRlcm4uc3RhcnRzV2l0aChcIi5cXFxcXCIpKSB7XG5cdFx0cmV0dXJuIHBhdHRlcm4uc2xpY2UoMik7XG5cdH1cblx0cmV0dXJuIHBhdHRlcm47XG59XG5cbmZ1bmN0aW9uIG1hdGNoZXNBbnlFeGFjdFBhdHRlcm4oZmlsZVBhdGg6IHN0cmluZywgcGF0dGVybnM6IHN0cmluZ1tdLCBiYXNlRGlyOiBzdHJpbmcpOiBib29sZWFuIHtcblx0aWYgKHBhdHRlcm5zLmxlbmd0aCA9PT0gMCkgcmV0dXJuIGZhbHNlO1xuXHRjb25zdCByZWwgPSByZWxhdGl2ZShiYXNlRGlyLCBmaWxlUGF0aCk7XG5cdGNvbnN0IG5hbWUgPSBiYXNlbmFtZShmaWxlUGF0aCk7XG5cdGNvbnN0IGlzU2tpbGxGaWxlID0gbmFtZSA9PT0gXCJTS0lMTC5tZFwiO1xuXHRjb25zdCBwYXJlbnREaXIgPSBpc1NraWxsRmlsZSA/IGRpcm5hbWUoZmlsZVBhdGgpIDogdW5kZWZpbmVkO1xuXHRjb25zdCBwYXJlbnRSZWwgPSBpc1NraWxsRmlsZSA/IHJlbGF0aXZlKGJhc2VEaXIsIHBhcmVudERpciEpIDogdW5kZWZpbmVkO1xuXG5cdHJldHVybiBwYXR0ZXJucy5zb21lKChwYXR0ZXJuKSA9PiB7XG5cdFx0Y29uc3Qgbm9ybWFsaXplZCA9IG5vcm1hbGl6ZUV4YWN0UGF0dGVybihwYXR0ZXJuKTtcblx0XHRpZiAobm9ybWFsaXplZCA9PT0gcmVsIHx8IG5vcm1hbGl6ZWQgPT09IGZpbGVQYXRoKSB7XG5cdFx0XHRyZXR1cm4gdHJ1ZTtcblx0XHR9XG5cdFx0aWYgKCFpc1NraWxsRmlsZSkgcmV0dXJuIGZhbHNlO1xuXHRcdHJldHVybiBub3JtYWxpemVkID09PSBwYXJlbnRSZWwgfHwgbm9ybWFsaXplZCA9PT0gcGFyZW50RGlyO1xuXHR9KTtcbn1cblxuZnVuY3Rpb24gZ2V0T3ZlcnJpZGVQYXR0ZXJucyhlbnRyaWVzOiBzdHJpbmdbXSk6IHN0cmluZ1tdIHtcblx0cmV0dXJuIGVudHJpZXMuZmlsdGVyKChwYXR0ZXJuKSA9PiBwYXR0ZXJuLnN0YXJ0c1dpdGgoXCIhXCIpIHx8IHBhdHRlcm4uc3RhcnRzV2l0aChcIitcIikgfHwgcGF0dGVybi5zdGFydHNXaXRoKFwiLVwiKSk7XG59XG5cbmZ1bmN0aW9uIGlzRW5hYmxlZEJ5T3ZlcnJpZGVzKGZpbGVQYXRoOiBzdHJpbmcsIHBhdHRlcm5zOiBzdHJpbmdbXSwgYmFzZURpcjogc3RyaW5nKTogYm9vbGVhbiB7XG5cdGNvbnN0IG92ZXJyaWRlcyA9IGdldE92ZXJyaWRlUGF0dGVybnMocGF0dGVybnMpO1xuXHRjb25zdCBleGNsdWRlcyA9IG92ZXJyaWRlcy5maWx0ZXIoKHBhdHRlcm4pID0+IHBhdHRlcm4uc3RhcnRzV2l0aChcIiFcIikpLm1hcCgocGF0dGVybikgPT4gcGF0dGVybi5zbGljZSgxKSk7XG5cdGNvbnN0IGZvcmNlSW5jbHVkZXMgPSBvdmVycmlkZXMuZmlsdGVyKChwYXR0ZXJuKSA9PiBwYXR0ZXJuLnN0YXJ0c1dpdGgoXCIrXCIpKS5tYXAoKHBhdHRlcm4pID0+IHBhdHRlcm4uc2xpY2UoMSkpO1xuXHRjb25zdCBmb3JjZUV4Y2x1ZGVzID0gb3ZlcnJpZGVzLmZpbHRlcigocGF0dGVybikgPT4gcGF0dGVybi5zdGFydHNXaXRoKFwiLVwiKSkubWFwKChwYXR0ZXJuKSA9PiBwYXR0ZXJuLnNsaWNlKDEpKTtcblxuXHRsZXQgZW5hYmxlZCA9IHRydWU7XG5cdGlmIChleGNsdWRlcy5sZW5ndGggPiAwICYmIG1hdGNoZXNBbnlQYXR0ZXJuKGZpbGVQYXRoLCBleGNsdWRlcywgYmFzZURpcikpIHtcblx0XHRlbmFibGVkID0gZmFsc2U7XG5cdH1cblx0aWYgKGZvcmNlSW5jbHVkZXMubGVuZ3RoID4gMCAmJiBtYXRjaGVzQW55RXhhY3RQYXR0ZXJuKGZpbGVQYXRoLCBmb3JjZUluY2x1ZGVzLCBiYXNlRGlyKSkge1xuXHRcdGVuYWJsZWQgPSB0cnVlO1xuXHR9XG5cdGlmIChmb3JjZUV4Y2x1ZGVzLmxlbmd0aCA+IDAgJiYgbWF0Y2hlc0FueUV4YWN0UGF0dGVybihmaWxlUGF0aCwgZm9yY2VFeGNsdWRlcywgYmFzZURpcikpIHtcblx0XHRlbmFibGVkID0gZmFsc2U7XG5cdH1cblx0cmV0dXJuIGVuYWJsZWQ7XG59XG5cbi8qKlxuICogQXBwbHkgcGF0dGVybnMgdG8gcGF0aHMgYW5kIHJldHVybiBhIFNldCBvZiBlbmFibGVkIHBhdGhzLlxuICogUGF0dGVybiB0eXBlczpcbiAqIC0gUGxhaW4gcGF0dGVybnM6IGluY2x1ZGUgbWF0Y2hpbmcgcGF0aHNcbiAqIC0gYCFwYXR0ZXJuYDogZXhjbHVkZSBtYXRjaGluZyBwYXRoc1xuICogLSBgK3BhdGhgOiBmb3JjZS1pbmNsdWRlIGV4YWN0IHBhdGggKG92ZXJyaWRlcyBleGNsdXNpb25zKVxuICogLSBgLXBhdGhgOiBmb3JjZS1leGNsdWRlIGV4YWN0IHBhdGggKG92ZXJyaWRlcyBmb3JjZS1pbmNsdWRlcylcbiAqL1xuZnVuY3Rpb24gYXBwbHlQYXR0ZXJucyhhbGxQYXRoczogc3RyaW5nW10sIHBhdHRlcm5zOiBzdHJpbmdbXSwgYmFzZURpcjogc3RyaW5nKTogU2V0PHN0cmluZz4ge1xuXHRjb25zdCBpbmNsdWRlczogc3RyaW5nW10gPSBbXTtcblx0Y29uc3QgZXhjbHVkZXM6IHN0cmluZ1tdID0gW107XG5cdGNvbnN0IGZvcmNlSW5jbHVkZXM6IHN0cmluZ1tdID0gW107XG5cdGNvbnN0IGZvcmNlRXhjbHVkZXM6IHN0cmluZ1tdID0gW107XG5cblx0Zm9yIChjb25zdCBwIG9mIHBhdHRlcm5zKSB7XG5cdFx0aWYgKHAuc3RhcnRzV2l0aChcIitcIikpIHtcblx0XHRcdGZvcmNlSW5jbHVkZXMucHVzaChwLnNsaWNlKDEpKTtcblx0XHR9IGVsc2UgaWYgKHAuc3RhcnRzV2l0aChcIi1cIikpIHtcblx0XHRcdGZvcmNlRXhjbHVkZXMucHVzaChwLnNsaWNlKDEpKTtcblx0XHR9IGVsc2UgaWYgKHAuc3RhcnRzV2l0aChcIiFcIikpIHtcblx0XHRcdGV4Y2x1ZGVzLnB1c2gocC5zbGljZSgxKSk7XG5cdFx0fSBlbHNlIHtcblx0XHRcdGluY2x1ZGVzLnB1c2gocCk7XG5cdFx0fVxuXHR9XG5cblx0Ly8gU3RlcCAxOiBBcHBseSBpbmNsdWRlcyAob3IgYWxsIGlmIG5vIGluY2x1ZGVzKVxuXHRsZXQgcmVzdWx0OiBzdHJpbmdbXTtcblx0aWYgKGluY2x1ZGVzLmxlbmd0aCA9PT0gMCkge1xuXHRcdHJlc3VsdCA9IFsuLi5hbGxQYXRoc107XG5cdH0gZWxzZSB7XG5cdFx0cmVzdWx0ID0gYWxsUGF0aHMuZmlsdGVyKChmaWxlUGF0aCkgPT4gbWF0Y2hlc0FueVBhdHRlcm4oZmlsZVBhdGgsIGluY2x1ZGVzLCBiYXNlRGlyKSk7XG5cdH1cblxuXHQvLyBTdGVwIDI6IEFwcGx5IGV4Y2x1ZGVzXG5cdGlmIChleGNsdWRlcy5sZW5ndGggPiAwKSB7XG5cdFx0cmVzdWx0ID0gcmVzdWx0LmZpbHRlcigoZmlsZVBhdGgpID0+ICFtYXRjaGVzQW55UGF0dGVybihmaWxlUGF0aCwgZXhjbHVkZXMsIGJhc2VEaXIpKTtcblx0fVxuXG5cdC8vIFN0ZXAgMzogRm9yY2UtaW5jbHVkZSAoYWRkIGJhY2sgZnJvbSBhbGxQYXRocywgb3ZlcnJpZGluZyBleGNsdXNpb25zKVxuXHRpZiAoZm9yY2VJbmNsdWRlcy5sZW5ndGggPiAwKSB7XG5cdFx0Zm9yIChjb25zdCBmaWxlUGF0aCBvZiBhbGxQYXRocykge1xuXHRcdFx0aWYgKCFyZXN1bHQuaW5jbHVkZXMoZmlsZVBhdGgpICYmIG1hdGNoZXNBbnlFeGFjdFBhdHRlcm4oZmlsZVBhdGgsIGZvcmNlSW5jbHVkZXMsIGJhc2VEaXIpKSB7XG5cdFx0XHRcdHJlc3VsdC5wdXNoKGZpbGVQYXRoKTtcblx0XHRcdH1cblx0XHR9XG5cdH1cblxuXHQvLyBTdGVwIDQ6IEZvcmNlLWV4Y2x1ZGUgKHJlbW92ZSBldmVuIGlmIGluY2x1ZGVkIG9yIGZvcmNlLWluY2x1ZGVkKVxuXHRpZiAoZm9yY2VFeGNsdWRlcy5sZW5ndGggPiAwKSB7XG5cdFx0cmVzdWx0ID0gcmVzdWx0LmZpbHRlcigoZmlsZVBhdGgpID0+ICFtYXRjaGVzQW55RXhhY3RQYXR0ZXJuKGZpbGVQYXRoLCBmb3JjZUV4Y2x1ZGVzLCBiYXNlRGlyKSk7XG5cdH1cblxuXHRyZXR1cm4gbmV3IFNldChyZXN1bHQpO1xufVxuXG5leHBvcnQgY2xhc3MgRGVmYXVsdFBhY2thZ2VNYW5hZ2VyIGltcGxlbWVudHMgUGFja2FnZU1hbmFnZXIge1xuXHRwcml2YXRlIGN3ZDogc3RyaW5nO1xuXHRwcml2YXRlIGFnZW50RGlyOiBzdHJpbmc7XG5cdHByaXZhdGUgc2V0dGluZ3NNYW5hZ2VyOiBTZXR0aW5nc01hbmFnZXI7XG5cdHByaXZhdGUgZ2xvYmFsTnBtUm9vdDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuXHRwcml2YXRlIHByb2dyZXNzQ2FsbGJhY2s6IFByb2dyZXNzQ2FsbGJhY2sgfCB1bmRlZmluZWQ7XG5cblx0Y29uc3RydWN0b3Iob3B0aW9uczogUGFja2FnZU1hbmFnZXJPcHRpb25zKSB7XG5cdFx0dGhpcy5jd2QgPSBvcHRpb25zLmN3ZDtcblx0XHR0aGlzLmFnZW50RGlyID0gb3B0aW9ucy5hZ2VudERpcjtcblx0XHR0aGlzLnNldHRpbmdzTWFuYWdlciA9IG9wdGlvbnMuc2V0dGluZ3NNYW5hZ2VyO1xuXHR9XG5cblx0c2V0UHJvZ3Jlc3NDYWxsYmFjayhjYWxsYmFjazogUHJvZ3Jlc3NDYWxsYmFjayB8IHVuZGVmaW5lZCk6IHZvaWQge1xuXHRcdHRoaXMucHJvZ3Jlc3NDYWxsYmFjayA9IGNhbGxiYWNrO1xuXHR9XG5cblx0YWRkU291cmNlVG9TZXR0aW5ncyhzb3VyY2U6IHN0cmluZywgb3B0aW9ucz86IHsgbG9jYWw/OiBib29sZWFuIH0pOiBib29sZWFuIHtcblx0XHRjb25zdCBzY29wZTogU291cmNlU2NvcGUgPSBvcHRpb25zPy5sb2NhbCA/IFwicHJvamVjdFwiIDogXCJ1c2VyXCI7XG5cdFx0Y29uc3QgY3VycmVudFNldHRpbmdzID1cblx0XHRcdHNjb3BlID09PSBcInByb2plY3RcIiA/IHRoaXMuc2V0dGluZ3NNYW5hZ2VyLmdldFByb2plY3RTZXR0aW5ncygpIDogdGhpcy5zZXR0aW5nc01hbmFnZXIuZ2V0R2xvYmFsU2V0dGluZ3MoKTtcblx0XHRjb25zdCBjdXJyZW50UGFja2FnZXMgPSBjdXJyZW50U2V0dGluZ3MucGFja2FnZXMgPz8gW107XG5cdFx0Y29uc3Qgbm9ybWFsaXplZFNvdXJjZSA9IHRoaXMubm9ybWFsaXplUGFja2FnZVNvdXJjZUZvclNldHRpbmdzKHNvdXJjZSwgc2NvcGUpO1xuXHRcdGNvbnN0IGV4aXN0cyA9IGN1cnJlbnRQYWNrYWdlcy5zb21lKChleGlzdGluZykgPT4gdGhpcy5wYWNrYWdlU291cmNlc01hdGNoKGV4aXN0aW5nLCBzb3VyY2UsIHNjb3BlKSk7XG5cdFx0aWYgKGV4aXN0cykge1xuXHRcdFx0cmV0dXJuIGZhbHNlO1xuXHRcdH1cblx0XHRjb25zdCBuZXh0UGFja2FnZXMgPSBbLi4uY3VycmVudFBhY2thZ2VzLCBub3JtYWxpemVkU291cmNlXTtcblx0XHRpZiAoc2NvcGUgPT09IFwicHJvamVjdFwiKSB7XG5cdFx0XHR0aGlzLnNldHRpbmdzTWFuYWdlci5zZXRQcm9qZWN0UGFja2FnZXMobmV4dFBhY2thZ2VzKTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0dGhpcy5zZXR0aW5nc01hbmFnZXIuc2V0UGFja2FnZXMobmV4dFBhY2thZ2VzKTtcblx0XHR9XG5cdFx0cmV0dXJuIHRydWU7XG5cdH1cblxuXHRyZW1vdmVTb3VyY2VGcm9tU2V0dGluZ3Moc291cmNlOiBzdHJpbmcsIG9wdGlvbnM/OiB7IGxvY2FsPzogYm9vbGVhbiB9KTogYm9vbGVhbiB7XG5cdFx0Y29uc3Qgc2NvcGU6IFNvdXJjZVNjb3BlID0gb3B0aW9ucz8ubG9jYWwgPyBcInByb2plY3RcIiA6IFwidXNlclwiO1xuXHRcdGNvbnN0IGN1cnJlbnRTZXR0aW5ncyA9XG5cdFx0XHRzY29wZSA9PT0gXCJwcm9qZWN0XCIgPyB0aGlzLnNldHRpbmdzTWFuYWdlci5nZXRQcm9qZWN0U2V0dGluZ3MoKSA6IHRoaXMuc2V0dGluZ3NNYW5hZ2VyLmdldEdsb2JhbFNldHRpbmdzKCk7XG5cdFx0Y29uc3QgY3VycmVudFBhY2thZ2VzID0gY3VycmVudFNldHRpbmdzLnBhY2thZ2VzID8/IFtdO1xuXHRcdGNvbnN0IG5leHRQYWNrYWdlcyA9IGN1cnJlbnRQYWNrYWdlcy5maWx0ZXIoKGV4aXN0aW5nKSA9PiAhdGhpcy5wYWNrYWdlU291cmNlc01hdGNoKGV4aXN0aW5nLCBzb3VyY2UsIHNjb3BlKSk7XG5cdFx0Y29uc3QgY2hhbmdlZCA9IG5leHRQYWNrYWdlcy5sZW5ndGggIT09IGN1cnJlbnRQYWNrYWdlcy5sZW5ndGg7XG5cdFx0aWYgKCFjaGFuZ2VkKSB7XG5cdFx0XHRyZXR1cm4gZmFsc2U7XG5cdFx0fVxuXHRcdGlmIChzY29wZSA9PT0gXCJwcm9qZWN0XCIpIHtcblx0XHRcdHRoaXMuc2V0dGluZ3NNYW5hZ2VyLnNldFByb2plY3RQYWNrYWdlcyhuZXh0UGFja2FnZXMpO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHR0aGlzLnNldHRpbmdzTWFuYWdlci5zZXRQYWNrYWdlcyhuZXh0UGFja2FnZXMpO1xuXHRcdH1cblx0XHRyZXR1cm4gdHJ1ZTtcblx0fVxuXG5cdGdldEluc3RhbGxlZFBhdGgoc291cmNlOiBzdHJpbmcsIHNjb3BlOiBcInVzZXJcIiB8IFwicHJvamVjdFwiKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcblx0XHRjb25zdCBwYXJzZWQgPSB0aGlzLnBhcnNlU291cmNlKHNvdXJjZSk7XG5cdFx0aWYgKHBhcnNlZC50eXBlID09PSBcIm5wbVwiKSB7XG5cdFx0XHRjb25zdCBwYXRoID0gdGhpcy5nZXROcG1JbnN0YWxsUGF0aChwYXJzZWQsIHNjb3BlKTtcblx0XHRcdHJldHVybiBleGlzdHNTeW5jKHBhdGgpID8gcGF0aCA6IHVuZGVmaW5lZDtcblx0XHR9XG5cdFx0aWYgKHBhcnNlZC50eXBlID09PSBcImdpdFwiKSB7XG5cdFx0XHRjb25zdCBwYXRoID0gdGhpcy5nZXRHaXRJbnN0YWxsUGF0aChwYXJzZWQsIHNjb3BlKTtcblx0XHRcdHJldHVybiBleGlzdHNTeW5jKHBhdGgpID8gcGF0aCA6IHVuZGVmaW5lZDtcblx0XHR9XG5cdFx0aWYgKHBhcnNlZC50eXBlID09PSBcImxvY2FsXCIpIHtcblx0XHRcdGNvbnN0IGJhc2VEaXIgPSB0aGlzLmdldEJhc2VEaXJGb3JTY29wZShzY29wZSk7XG5cdFx0XHRjb25zdCBwYXRoID0gdGhpcy5yZXNvbHZlUGF0aEZyb21CYXNlKHBhcnNlZC5wYXRoLCBiYXNlRGlyKTtcblx0XHRcdHJldHVybiBleGlzdHNTeW5jKHBhdGgpID8gcGF0aCA6IHVuZGVmaW5lZDtcblx0XHR9XG5cdFx0cmV0dXJuIHVuZGVmaW5lZDtcblx0fVxuXG5cdHByaXZhdGUgZW1pdFByb2dyZXNzKGV2ZW50OiBQcm9ncmVzc0V2ZW50KTogdm9pZCB7XG5cdFx0dGhpcy5wcm9ncmVzc0NhbGxiYWNrPy4oZXZlbnQpO1xuXHR9XG5cblx0cHJpdmF0ZSBhc3luYyB3aXRoUHJvZ3Jlc3MoXG5cdFx0YWN0aW9uOiBQcm9ncmVzc0V2ZW50W1wiYWN0aW9uXCJdLFxuXHRcdHNvdXJjZTogc3RyaW5nLFxuXHRcdG1lc3NhZ2U6IHN0cmluZyxcblx0XHRvcGVyYXRpb246ICgpID0+IFByb21pc2U8dm9pZD4sXG5cdCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdHRoaXMuZW1pdFByb2dyZXNzKHsgdHlwZTogXCJzdGFydFwiLCBhY3Rpb24sIHNvdXJjZSwgbWVzc2FnZSB9KTtcblx0XHR0cnkge1xuXHRcdFx0YXdhaXQgb3BlcmF0aW9uKCk7XG5cdFx0XHR0aGlzLmVtaXRQcm9ncmVzcyh7IHR5cGU6IFwiY29tcGxldGVcIiwgYWN0aW9uLCBzb3VyY2UgfSk7XG5cdFx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRcdGNvbnN0IGVycm9yTWVzc2FnZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcblx0XHRcdHRoaXMuZW1pdFByb2dyZXNzKHsgdHlwZTogXCJlcnJvclwiLCBhY3Rpb24sIHNvdXJjZSwgbWVzc2FnZTogZXJyb3JNZXNzYWdlIH0pO1xuXHRcdFx0dGhyb3cgZXJyb3I7XG5cdFx0fVxuXHR9XG5cblx0YXN5bmMgcmVzb2x2ZShvbk1pc3Npbmc/OiAoc291cmNlOiBzdHJpbmcpID0+IFByb21pc2U8TWlzc2luZ1NvdXJjZUFjdGlvbj4pOiBQcm9taXNlPFJlc29sdmVkUGF0aHM+IHtcblx0XHRjb25zdCBhY2N1bXVsYXRvciA9IHRoaXMuY3JlYXRlQWNjdW11bGF0b3IoKTtcblx0XHRjb25zdCBnbG9iYWxTZXR0aW5ncyA9IHRoaXMuc2V0dGluZ3NNYW5hZ2VyLmdldEdsb2JhbFNldHRpbmdzKCk7XG5cdFx0Y29uc3QgcHJvamVjdFNldHRpbmdzID0gdGhpcy5zZXR0aW5nc01hbmFnZXIuZ2V0UHJvamVjdFNldHRpbmdzKCk7XG5cblx0XHQvLyBDb2xsZWN0IGFsbCBwYWNrYWdlcyB3aXRoIHNjb3BlIChwcm9qZWN0IGZpcnN0IHNvIGN3ZCByZXNvdXJjZXMgd2luIGNvbGxpc2lvbnMpXG5cdFx0Y29uc3QgYWxsUGFja2FnZXM6IEFycmF5PHsgcGtnOiBQYWNrYWdlU291cmNlOyBzY29wZTogU291cmNlU2NvcGUgfT4gPSBbXTtcblx0XHRmb3IgKGNvbnN0IHBrZyBvZiBwcm9qZWN0U2V0dGluZ3MucGFja2FnZXMgPz8gW10pIHtcblx0XHRcdGFsbFBhY2thZ2VzLnB1c2goeyBwa2csIHNjb3BlOiBcInByb2plY3RcIiB9KTtcblx0XHR9XG5cdFx0Zm9yIChjb25zdCBwa2cgb2YgZ2xvYmFsU2V0dGluZ3MucGFja2FnZXMgPz8gW10pIHtcblx0XHRcdGFsbFBhY2thZ2VzLnB1c2goeyBwa2csIHNjb3BlOiBcInVzZXJcIiB9KTtcblx0XHR9XG5cblx0XHQvLyBEZWR1cGU6IHByb2plY3Qgc2NvcGUgd2lucyBvdmVyIGdsb2JhbCBmb3Igc2FtZSBwYWNrYWdlIGlkZW50aXR5XG5cdFx0Y29uc3QgcGFja2FnZVNvdXJjZXMgPSB0aGlzLmRlZHVwZVBhY2thZ2VzKGFsbFBhY2thZ2VzKTtcblx0XHRhd2FpdCB0aGlzLnJlc29sdmVQYWNrYWdlU291cmNlcyhwYWNrYWdlU291cmNlcywgYWNjdW11bGF0b3IsIG9uTWlzc2luZyk7XG5cblx0XHRjb25zdCBnbG9iYWxCYXNlRGlyID0gdGhpcy5hZ2VudERpcjtcblx0XHRjb25zdCBwcm9qZWN0QmFzZURpciA9IGpvaW4odGhpcy5jd2QsIENPTkZJR19ESVJfTkFNRSk7XG5cblx0XHRmb3IgKGNvbnN0IHJlc291cmNlVHlwZSBvZiBSRVNPVVJDRV9UWVBFUykge1xuXHRcdFx0Y29uc3QgdGFyZ2V0ID0gdGhpcy5nZXRUYXJnZXRNYXAoYWNjdW11bGF0b3IsIHJlc291cmNlVHlwZSk7XG5cdFx0XHRjb25zdCBnbG9iYWxFbnRyaWVzID0gKGdsb2JhbFNldHRpbmdzW3Jlc291cmNlVHlwZV0gPz8gW10pIGFzIHN0cmluZ1tdO1xuXHRcdFx0Y29uc3QgcHJvamVjdEVudHJpZXMgPSAocHJvamVjdFNldHRpbmdzW3Jlc291cmNlVHlwZV0gPz8gW10pIGFzIHN0cmluZ1tdO1xuXHRcdFx0dGhpcy5yZXNvbHZlTG9jYWxFbnRyaWVzKFxuXHRcdFx0XHRwcm9qZWN0RW50cmllcyxcblx0XHRcdFx0cmVzb3VyY2VUeXBlLFxuXHRcdFx0XHR0YXJnZXQsXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRzb3VyY2U6IFwibG9jYWxcIixcblx0XHRcdFx0XHRzY29wZTogXCJwcm9qZWN0XCIsXG5cdFx0XHRcdFx0b3JpZ2luOiBcInRvcC1sZXZlbFwiLFxuXHRcdFx0XHR9LFxuXHRcdFx0XHRwcm9qZWN0QmFzZURpcixcblx0XHRcdCk7XG5cdFx0XHR0aGlzLnJlc29sdmVMb2NhbEVudHJpZXMoXG5cdFx0XHRcdGdsb2JhbEVudHJpZXMsXG5cdFx0XHRcdHJlc291cmNlVHlwZSxcblx0XHRcdFx0dGFyZ2V0LFxuXHRcdFx0XHR7XG5cdFx0XHRcdFx0c291cmNlOiBcImxvY2FsXCIsXG5cdFx0XHRcdFx0c2NvcGU6IFwidXNlclwiLFxuXHRcdFx0XHRcdG9yaWdpbjogXCJ0b3AtbGV2ZWxcIixcblx0XHRcdFx0fSxcblx0XHRcdFx0Z2xvYmFsQmFzZURpcixcblx0XHRcdCk7XG5cdFx0fVxuXG5cdFx0dGhpcy5hZGRBdXRvRGlzY292ZXJlZFJlc291cmNlcyhhY2N1bXVsYXRvciwgZ2xvYmFsU2V0dGluZ3MsIHByb2plY3RTZXR0aW5ncywgZ2xvYmFsQmFzZURpciwgcHJvamVjdEJhc2VEaXIpO1xuXG5cdFx0cmV0dXJuIHRoaXMudG9SZXNvbHZlZFBhdGhzKGFjY3VtdWxhdG9yKTtcblx0fVxuXG5cdGFzeW5jIHJlc29sdmVFeHRlbnNpb25Tb3VyY2VzKFxuXHRcdHNvdXJjZXM6IHN0cmluZ1tdLFxuXHRcdG9wdGlvbnM/OiB7IGxvY2FsPzogYm9vbGVhbjsgdGVtcG9yYXJ5PzogYm9vbGVhbiB9LFxuXHQpOiBQcm9taXNlPFJlc29sdmVkUGF0aHM+IHtcblx0XHRjb25zdCBhY2N1bXVsYXRvciA9IHRoaXMuY3JlYXRlQWNjdW11bGF0b3IoKTtcblx0XHRjb25zdCBzY29wZTogU291cmNlU2NvcGUgPSBvcHRpb25zPy50ZW1wb3JhcnkgPyBcInRlbXBvcmFyeVwiIDogb3B0aW9ucz8ubG9jYWwgPyBcInByb2plY3RcIiA6IFwidXNlclwiO1xuXHRcdGNvbnN0IHBhY2thZ2VTb3VyY2VzID0gc291cmNlcy5tYXAoKHNvdXJjZSkgPT4gKHsgcGtnOiBzb3VyY2UgYXMgUGFja2FnZVNvdXJjZSwgc2NvcGUgfSkpO1xuXHRcdGF3YWl0IHRoaXMucmVzb2x2ZVBhY2thZ2VTb3VyY2VzKHBhY2thZ2VTb3VyY2VzLCBhY2N1bXVsYXRvcik7XG5cdFx0cmV0dXJuIHRoaXMudG9SZXNvbHZlZFBhdGhzKGFjY3VtdWxhdG9yKTtcblx0fVxuXG5cdGFzeW5jIGluc3RhbGwoc291cmNlOiBzdHJpbmcsIG9wdGlvbnM/OiB7IGxvY2FsPzogYm9vbGVhbiB9KTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0Y29uc3QgcGFyc2VkID0gdGhpcy5wYXJzZVNvdXJjZShzb3VyY2UpO1xuXHRcdGNvbnN0IHNjb3BlOiBTb3VyY2VTY29wZSA9IG9wdGlvbnM/LmxvY2FsID8gXCJwcm9qZWN0XCIgOiBcInVzZXJcIjtcblx0XHRhd2FpdCB0aGlzLndpdGhQcm9ncmVzcyhcImluc3RhbGxcIiwgc291cmNlLCBgSW5zdGFsbGluZyAke3NvdXJjZX0uLi5gLCBhc3luYyAoKSA9PiB7XG5cdFx0XHRpZiAocGFyc2VkLnR5cGUgPT09IFwibnBtXCIpIHtcblx0XHRcdFx0YXdhaXQgdGhpcy5pbnN0YWxsTnBtKHBhcnNlZCwgc2NvcGUsIGZhbHNlKTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXHRcdFx0aWYgKHBhcnNlZC50eXBlID09PSBcImdpdFwiKSB7XG5cdFx0XHRcdGF3YWl0IHRoaXMuaW5zdGFsbEdpdChwYXJzZWQsIHNjb3BlKTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXHRcdFx0aWYgKHBhcnNlZC50eXBlID09PSBcImxvY2FsXCIpIHtcblx0XHRcdFx0Y29uc3QgcmVzb2x2ZWQgPSB0aGlzLnJlc29sdmVQYXRoKHBhcnNlZC5wYXRoKTtcblx0XHRcdFx0aWYgKCFleGlzdHNTeW5jKHJlc29sdmVkKSkge1xuXHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcihgUGF0aCBkb2VzIG5vdCBleGlzdDogJHtyZXNvbHZlZH1gKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoYFVuc3VwcG9ydGVkIGluc3RhbGwgc291cmNlOiAke3NvdXJjZX1gKTtcblx0XHR9KTtcblx0fVxuXG5cdGFzeW5jIHJlbW92ZShzb3VyY2U6IHN0cmluZywgb3B0aW9ucz86IHsgbG9jYWw/OiBib29sZWFuIH0pOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRjb25zdCBwYXJzZWQgPSB0aGlzLnBhcnNlU291cmNlKHNvdXJjZSk7XG5cdFx0Y29uc3Qgc2NvcGU6IFNvdXJjZVNjb3BlID0gb3B0aW9ucz8ubG9jYWwgPyBcInByb2plY3RcIiA6IFwidXNlclwiO1xuXHRcdGF3YWl0IHRoaXMud2l0aFByb2dyZXNzKFwicmVtb3ZlXCIsIHNvdXJjZSwgYFJlbW92aW5nICR7c291cmNlfS4uLmAsIGFzeW5jICgpID0+IHtcblx0XHRcdGlmIChwYXJzZWQudHlwZSA9PT0gXCJucG1cIikge1xuXHRcdFx0XHRhd2FpdCB0aGlzLnVuaW5zdGFsbE5wbShwYXJzZWQsIHNjb3BlKTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXHRcdFx0aWYgKHBhcnNlZC50eXBlID09PSBcImdpdFwiKSB7XG5cdFx0XHRcdGF3YWl0IHRoaXMucmVtb3ZlR2l0KHBhcnNlZCwgc2NvcGUpO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cdFx0XHRpZiAocGFyc2VkLnR5cGUgPT09IFwibG9jYWxcIikge1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoYFVuc3VwcG9ydGVkIHJlbW92ZSBzb3VyY2U6ICR7c291cmNlfWApO1xuXHRcdH0pO1xuXHR9XG5cblx0YXN5bmMgdXBkYXRlKHNvdXJjZT86IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGNvbnN0IGdsb2JhbFNldHRpbmdzID0gdGhpcy5zZXR0aW5nc01hbmFnZXIuZ2V0R2xvYmFsU2V0dGluZ3MoKTtcblx0XHRjb25zdCBwcm9qZWN0U2V0dGluZ3MgPSB0aGlzLnNldHRpbmdzTWFuYWdlci5nZXRQcm9qZWN0U2V0dGluZ3MoKTtcblx0XHRjb25zdCBpZGVudGl0eSA9IHNvdXJjZSA/IHRoaXMuZ2V0UGFja2FnZUlkZW50aXR5KHNvdXJjZSkgOiB1bmRlZmluZWQ7XG5cblx0XHRmb3IgKGNvbnN0IHBrZyBvZiBnbG9iYWxTZXR0aW5ncy5wYWNrYWdlcyA/PyBbXSkge1xuXHRcdFx0Y29uc3Qgc291cmNlU3RyID0gdHlwZW9mIHBrZyA9PT0gXCJzdHJpbmdcIiA/IHBrZyA6IHBrZy5zb3VyY2U7XG5cdFx0XHRpZiAoaWRlbnRpdHkgJiYgdGhpcy5nZXRQYWNrYWdlSWRlbnRpdHkoc291cmNlU3RyLCBcInVzZXJcIikgIT09IGlkZW50aXR5KSBjb250aW51ZTtcblx0XHRcdGF3YWl0IHRoaXMudXBkYXRlU291cmNlRm9yU2NvcGUoc291cmNlU3RyLCBcInVzZXJcIik7XG5cdFx0fVxuXHRcdGZvciAoY29uc3QgcGtnIG9mIHByb2plY3RTZXR0aW5ncy5wYWNrYWdlcyA/PyBbXSkge1xuXHRcdFx0Y29uc3Qgc291cmNlU3RyID0gdHlwZW9mIHBrZyA9PT0gXCJzdHJpbmdcIiA/IHBrZyA6IHBrZy5zb3VyY2U7XG5cdFx0XHRpZiAoaWRlbnRpdHkgJiYgdGhpcy5nZXRQYWNrYWdlSWRlbnRpdHkoc291cmNlU3RyLCBcInByb2plY3RcIikgIT09IGlkZW50aXR5KSBjb250aW51ZTtcblx0XHRcdGF3YWl0IHRoaXMudXBkYXRlU291cmNlRm9yU2NvcGUoc291cmNlU3RyLCBcInByb2plY3RcIik7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBhc3luYyB1cGRhdGVTb3VyY2VGb3JTY29wZShzb3VyY2U6IHN0cmluZywgc2NvcGU6IFNvdXJjZVNjb3BlKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0aWYgKGlzT2ZmbGluZU1vZGVFbmFibGVkKCkpIHtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cdFx0Y29uc3QgcGFyc2VkID0gdGhpcy5wYXJzZVNvdXJjZShzb3VyY2UpO1xuXHRcdGlmIChwYXJzZWQudHlwZSA9PT0gXCJucG1cIikge1xuXHRcdFx0aWYgKHBhcnNlZC5waW5uZWQpIHJldHVybjtcblx0XHRcdGF3YWl0IHRoaXMud2l0aFByb2dyZXNzKFwidXBkYXRlXCIsIHNvdXJjZSwgYFVwZGF0aW5nICR7c291cmNlfS4uLmAsIGFzeW5jICgpID0+IHtcblx0XHRcdFx0YXdhaXQgdGhpcy5pbnN0YWxsTnBtKHBhcnNlZCwgc2NvcGUsIGZhbHNlKTtcblx0XHRcdH0pO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblx0XHRpZiAocGFyc2VkLnR5cGUgPT09IFwiZ2l0XCIpIHtcblx0XHRcdGlmIChwYXJzZWQucGlubmVkKSByZXR1cm47XG5cdFx0XHRhd2FpdCB0aGlzLndpdGhQcm9ncmVzcyhcInVwZGF0ZVwiLCBzb3VyY2UsIGBVcGRhdGluZyAke3NvdXJjZX0uLi5gLCBhc3luYyAoKSA9PiB7XG5cdFx0XHRcdGF3YWl0IHRoaXMudXBkYXRlR2l0KHBhcnNlZCwgc2NvcGUpO1xuXHRcdFx0fSk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBhc3luYyByZXNvbHZlUGFja2FnZVNvdXJjZXMoXG5cdFx0c291cmNlczogQXJyYXk8eyBwa2c6IFBhY2thZ2VTb3VyY2U7IHNjb3BlOiBTb3VyY2VTY29wZSB9Pixcblx0XHRhY2N1bXVsYXRvcjogUmVzb3VyY2VBY2N1bXVsYXRvcixcblx0XHRvbk1pc3Npbmc/OiAoc291cmNlOiBzdHJpbmcpID0+IFByb21pc2U8TWlzc2luZ1NvdXJjZUFjdGlvbj4sXG5cdCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGZvciAoY29uc3QgeyBwa2csIHNjb3BlIH0gb2Ygc291cmNlcykge1xuXHRcdFx0Y29uc3Qgc291cmNlU3RyID0gdHlwZW9mIHBrZyA9PT0gXCJzdHJpbmdcIiA/IHBrZyA6IHBrZy5zb3VyY2U7XG5cdFx0XHRjb25zdCBmaWx0ZXIgPSB0eXBlb2YgcGtnID09PSBcIm9iamVjdFwiID8gcGtnIDogdW5kZWZpbmVkO1xuXHRcdFx0Y29uc3QgcGFyc2VkID0gdGhpcy5wYXJzZVNvdXJjZShzb3VyY2VTdHIpO1xuXHRcdFx0Y29uc3QgbWV0YWRhdGE6IFBhdGhNZXRhZGF0YSA9IHsgc291cmNlOiBzb3VyY2VTdHIsIHNjb3BlLCBvcmlnaW46IFwicGFja2FnZVwiIH07XG5cblx0XHRcdGlmIChwYXJzZWQudHlwZSA9PT0gXCJsb2NhbFwiKSB7XG5cdFx0XHRcdGNvbnN0IGJhc2VEaXIgPSB0aGlzLmdldEJhc2VEaXJGb3JTY29wZShzY29wZSk7XG5cdFx0XHRcdHRoaXMucmVzb2x2ZUxvY2FsRXh0ZW5zaW9uU291cmNlKHBhcnNlZCwgYWNjdW11bGF0b3IsIGZpbHRlciwgbWV0YWRhdGEsIGJhc2VEaXIpO1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgaW5zdGFsbE1pc3NpbmcgPSBhc3luYyAoKTogUHJvbWlzZTxib29sZWFuPiA9PiB7XG5cdFx0XHRcdGlmIChpc09mZmxpbmVNb2RlRW5hYmxlZCgpKSB7XG5cdFx0XHRcdFx0cmV0dXJuIGZhbHNlO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGlmICghb25NaXNzaW5nKSB7XG5cdFx0XHRcdFx0YXdhaXQgdGhpcy5pbnN0YWxsUGFyc2VkU291cmNlKHBhcnNlZCwgc2NvcGUpO1xuXHRcdFx0XHRcdHJldHVybiB0cnVlO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGNvbnN0IGFjdGlvbiA9IGF3YWl0IG9uTWlzc2luZyhzb3VyY2VTdHIpO1xuXHRcdFx0XHRpZiAoYWN0aW9uID09PSBcInNraXBcIikgcmV0dXJuIGZhbHNlO1xuXHRcdFx0XHRpZiAoYWN0aW9uID09PSBcImVycm9yXCIpIHRocm93IG5ldyBFcnJvcihgTWlzc2luZyBzb3VyY2U6ICR7c291cmNlU3RyfWApO1xuXHRcdFx0XHRhd2FpdCB0aGlzLmluc3RhbGxQYXJzZWRTb3VyY2UocGFyc2VkLCBzY29wZSk7XG5cdFx0XHRcdHJldHVybiB0cnVlO1xuXHRcdFx0fTtcblxuXHRcdFx0aWYgKHBhcnNlZC50eXBlID09PSBcIm5wbVwiKSB7XG5cdFx0XHRcdGNvbnN0IGluc3RhbGxlZFBhdGggPSB0aGlzLmdldE5wbUluc3RhbGxQYXRoKHBhcnNlZCwgc2NvcGUpO1xuXHRcdFx0XHRjb25zdCBuZWVkc0luc3RhbGwgPSAhZXhpc3RzU3luYyhpbnN0YWxsZWRQYXRoKSB8fCAoYXdhaXQgdGhpcy5ucG1OZWVkc1VwZGF0ZShwYXJzZWQsIGluc3RhbGxlZFBhdGgpKTtcblx0XHRcdFx0aWYgKG5lZWRzSW5zdGFsbCkge1xuXHRcdFx0XHRcdGNvbnN0IGluc3RhbGxlZCA9IGF3YWl0IGluc3RhbGxNaXNzaW5nKCk7XG5cdFx0XHRcdFx0aWYgKCFpbnN0YWxsZWQpIGNvbnRpbnVlO1xuXHRcdFx0XHR9XG5cdFx0XHRcdG1ldGFkYXRhLmJhc2VEaXIgPSBpbnN0YWxsZWRQYXRoO1xuXHRcdFx0XHR0aGlzLmNvbGxlY3RQYWNrYWdlUmVzb3VyY2VzKGluc3RhbGxlZFBhdGgsIGFjY3VtdWxhdG9yLCBmaWx0ZXIsIG1ldGFkYXRhKTtcblx0XHRcdFx0Y29udGludWU7XG5cdFx0XHR9XG5cblx0XHRcdGlmIChwYXJzZWQudHlwZSA9PT0gXCJnaXRcIikge1xuXHRcdFx0XHRjb25zdCBpbnN0YWxsZWRQYXRoID0gdGhpcy5nZXRHaXRJbnN0YWxsUGF0aChwYXJzZWQsIHNjb3BlKTtcblx0XHRcdFx0aWYgKCFleGlzdHNTeW5jKGluc3RhbGxlZFBhdGgpKSB7XG5cdFx0XHRcdFx0Y29uc3QgaW5zdGFsbGVkID0gYXdhaXQgaW5zdGFsbE1pc3NpbmcoKTtcblx0XHRcdFx0XHRpZiAoIWluc3RhbGxlZCkgY29udGludWU7XG5cdFx0XHRcdH0gZWxzZSBpZiAoc2NvcGUgPT09IFwidGVtcG9yYXJ5XCIgJiYgIXBhcnNlZC5waW5uZWQgJiYgIWlzT2ZmbGluZU1vZGVFbmFibGVkKCkpIHtcblx0XHRcdFx0XHRhd2FpdCB0aGlzLnJlZnJlc2hUZW1wb3JhcnlHaXRTb3VyY2UocGFyc2VkLCBzb3VyY2VTdHIpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdG1ldGFkYXRhLmJhc2VEaXIgPSBpbnN0YWxsZWRQYXRoO1xuXHRcdFx0XHR0aGlzLmNvbGxlY3RQYWNrYWdlUmVzb3VyY2VzKGluc3RhbGxlZFBhdGgsIGFjY3VtdWxhdG9yLCBmaWx0ZXIsIG1ldGFkYXRhKTtcblx0XHRcdH1cblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIHJlc29sdmVMb2NhbEV4dGVuc2lvblNvdXJjZShcblx0XHRzb3VyY2U6IExvY2FsU291cmNlLFxuXHRcdGFjY3VtdWxhdG9yOiBSZXNvdXJjZUFjY3VtdWxhdG9yLFxuXHRcdGZpbHRlcjogUGFja2FnZUZpbHRlciB8IHVuZGVmaW5lZCxcblx0XHRtZXRhZGF0YTogUGF0aE1ldGFkYXRhLFxuXHRcdGJhc2VEaXI6IHN0cmluZyxcblx0KTogdm9pZCB7XG5cdFx0Y29uc3QgcmVzb2x2ZWQgPSB0aGlzLnJlc29sdmVQYXRoRnJvbUJhc2Uoc291cmNlLnBhdGgsIGJhc2VEaXIpO1xuXHRcdGlmICghZXhpc3RzU3luYyhyZXNvbHZlZCkpIHtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHR0cnkge1xuXHRcdFx0Y29uc3Qgc3RhdHMgPSBzdGF0U3luYyhyZXNvbHZlZCk7XG5cdFx0XHRpZiAoc3RhdHMuaXNGaWxlKCkpIHtcblx0XHRcdFx0bWV0YWRhdGEuYmFzZURpciA9IGRpcm5hbWUocmVzb2x2ZWQpO1xuXHRcdFx0XHR0aGlzLmFkZFJlc291cmNlKGFjY3VtdWxhdG9yLmV4dGVuc2lvbnMsIHJlc29sdmVkLCBtZXRhZGF0YSwgdHJ1ZSk7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblx0XHRcdGlmIChzdGF0cy5pc0RpcmVjdG9yeSgpKSB7XG5cdFx0XHRcdG1ldGFkYXRhLmJhc2VEaXIgPSByZXNvbHZlZDtcblx0XHRcdFx0Y29uc3QgcmVzb3VyY2VzID0gdGhpcy5jb2xsZWN0UGFja2FnZVJlc291cmNlcyhyZXNvbHZlZCwgYWNjdW11bGF0b3IsIGZpbHRlciwgbWV0YWRhdGEpO1xuXHRcdFx0XHRpZiAoIXJlc291cmNlcykge1xuXHRcdFx0XHRcdHRoaXMuYWRkUmVzb3VyY2UoYWNjdW11bGF0b3IuZXh0ZW5zaW9ucywgcmVzb2x2ZWQsIG1ldGFkYXRhLCB0cnVlKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH0gY2F0Y2gge1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgYXN5bmMgaW5zdGFsbFBhcnNlZFNvdXJjZShwYXJzZWQ6IFBhcnNlZFNvdXJjZSwgc2NvcGU6IFNvdXJjZVNjb3BlKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0aWYgKHBhcnNlZC50eXBlID09PSBcIm5wbVwiKSB7XG5cdFx0XHRhd2FpdCB0aGlzLmluc3RhbGxOcG0ocGFyc2VkLCBzY29wZSwgc2NvcGUgPT09IFwidGVtcG9yYXJ5XCIpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblx0XHRpZiAocGFyc2VkLnR5cGUgPT09IFwiZ2l0XCIpIHtcblx0XHRcdGF3YWl0IHRoaXMuaW5zdGFsbEdpdChwYXJzZWQsIHNjb3BlKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIGdldFBhY2thZ2VTb3VyY2VTdHJpbmcocGtnOiBQYWNrYWdlU291cmNlKTogc3RyaW5nIHtcblx0XHRyZXR1cm4gdHlwZW9mIHBrZyA9PT0gXCJzdHJpbmdcIiA/IHBrZyA6IHBrZy5zb3VyY2U7XG5cdH1cblxuXHRwcml2YXRlIGdldFNvdXJjZU1hdGNoS2V5Rm9ySW5wdXQoc291cmNlOiBzdHJpbmcpOiBzdHJpbmcge1xuXHRcdGNvbnN0IHBhcnNlZCA9IHRoaXMucGFyc2VTb3VyY2Uoc291cmNlKTtcblx0XHRpZiAocGFyc2VkLnR5cGUgPT09IFwibnBtXCIpIHtcblx0XHRcdHJldHVybiBgbnBtOiR7cGFyc2VkLm5hbWV9YDtcblx0XHR9XG5cdFx0aWYgKHBhcnNlZC50eXBlID09PSBcImdpdFwiKSB7XG5cdFx0XHRyZXR1cm4gYGdpdDoke3BhcnNlZC5ob3N0fS8ke3BhcnNlZC5wYXRofWA7XG5cdFx0fVxuXHRcdHJldHVybiBgbG9jYWw6JHt0aGlzLnJlc29sdmVQYXRoKHBhcnNlZC5wYXRoKX1gO1xuXHR9XG5cblx0cHJpdmF0ZSBnZXRTb3VyY2VNYXRjaEtleUZvclNldHRpbmdzKHNvdXJjZTogc3RyaW5nLCBzY29wZTogU291cmNlU2NvcGUpOiBzdHJpbmcge1xuXHRcdGNvbnN0IHBhcnNlZCA9IHRoaXMucGFyc2VTb3VyY2Uoc291cmNlKTtcblx0XHRpZiAocGFyc2VkLnR5cGUgPT09IFwibnBtXCIpIHtcblx0XHRcdHJldHVybiBgbnBtOiR7cGFyc2VkLm5hbWV9YDtcblx0XHR9XG5cdFx0aWYgKHBhcnNlZC50eXBlID09PSBcImdpdFwiKSB7XG5cdFx0XHRyZXR1cm4gYGdpdDoke3BhcnNlZC5ob3N0fS8ke3BhcnNlZC5wYXRofWA7XG5cdFx0fVxuXHRcdGNvbnN0IGJhc2VEaXIgPSB0aGlzLmdldEJhc2VEaXJGb3JTY29wZShzY29wZSk7XG5cdFx0cmV0dXJuIGBsb2NhbDoke3RoaXMucmVzb2x2ZVBhdGhGcm9tQmFzZShwYXJzZWQucGF0aCwgYmFzZURpcil9YDtcblx0fVxuXG5cdHByaXZhdGUgcGFja2FnZVNvdXJjZXNNYXRjaChleGlzdGluZzogUGFja2FnZVNvdXJjZSwgaW5wdXRTb3VyY2U6IHN0cmluZywgc2NvcGU6IFNvdXJjZVNjb3BlKTogYm9vbGVhbiB7XG5cdFx0Y29uc3QgbGVmdCA9IHRoaXMuZ2V0U291cmNlTWF0Y2hLZXlGb3JTZXR0aW5ncyh0aGlzLmdldFBhY2thZ2VTb3VyY2VTdHJpbmcoZXhpc3RpbmcpLCBzY29wZSk7XG5cdFx0Y29uc3QgcmlnaHQgPSB0aGlzLmdldFNvdXJjZU1hdGNoS2V5Rm9ySW5wdXQoaW5wdXRTb3VyY2UpO1xuXHRcdHJldHVybiBsZWZ0ID09PSByaWdodDtcblx0fVxuXG5cdHByaXZhdGUgbm9ybWFsaXplUGFja2FnZVNvdXJjZUZvclNldHRpbmdzKHNvdXJjZTogc3RyaW5nLCBzY29wZTogU291cmNlU2NvcGUpOiBzdHJpbmcge1xuXHRcdGNvbnN0IHBhcnNlZCA9IHRoaXMucGFyc2VTb3VyY2Uoc291cmNlKTtcblx0XHRpZiAocGFyc2VkLnR5cGUgIT09IFwibG9jYWxcIikge1xuXHRcdFx0cmV0dXJuIHNvdXJjZTtcblx0XHR9XG5cdFx0Y29uc3QgYmFzZURpciA9IHRoaXMuZ2V0QmFzZURpckZvclNjb3BlKHNjb3BlKTtcblx0XHRjb25zdCByZXNvbHZlZCA9IHRoaXMucmVzb2x2ZVBhdGgocGFyc2VkLnBhdGgpO1xuXHRcdGNvbnN0IHJlbCA9IHJlbGF0aXZlKGJhc2VEaXIsIHJlc29sdmVkKTtcblx0XHRyZXR1cm4gcmVsIHx8IFwiLlwiO1xuXHR9XG5cblx0cHJpdmF0ZSBwYXJzZVNvdXJjZShzb3VyY2U6IHN0cmluZyk6IFBhcnNlZFNvdXJjZSB7XG5cdFx0aWYgKHNvdXJjZS5zdGFydHNXaXRoKFwibnBtOlwiKSkge1xuXHRcdFx0Y29uc3Qgc3BlYyA9IHNvdXJjZS5zbGljZShcIm5wbTpcIi5sZW5ndGgpLnRyaW0oKTtcblx0XHRcdGNvbnN0IHsgbmFtZSwgdmVyc2lvbiB9ID0gdGhpcy5wYXJzZU5wbVNwZWMoc3BlYyk7XG5cdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHR0eXBlOiBcIm5wbVwiLFxuXHRcdFx0XHRzcGVjLFxuXHRcdFx0XHRuYW1lLFxuXHRcdFx0XHRwaW5uZWQ6IEJvb2xlYW4odmVyc2lvbiksXG5cdFx0XHR9O1xuXHRcdH1cblxuXHRcdGNvbnN0IHRyaW1tZWQgPSBzb3VyY2UudHJpbSgpO1xuXHRcdGNvbnN0IGlzV2luZG93c0Fic29sdXRlUGF0aCA9IC9eW0EtWmEtel06W1xcXFwvXXxeXFxcXFxcXFwvLnRlc3QodHJpbW1lZCk7XG5cdFx0Y29uc3QgaXNMb2NhbFBhdGhMaWtlID1cblx0XHRcdHRyaW1tZWQuc3RhcnRzV2l0aChcIi5cIikgfHxcblx0XHRcdHRyaW1tZWQuc3RhcnRzV2l0aChcIi9cIikgfHxcblx0XHRcdHRyaW1tZWQgPT09IFwiflwiIHx8XG5cdFx0XHR0cmltbWVkLnN0YXJ0c1dpdGgoXCJ+L1wiKSB8fFxuXHRcdFx0aXNXaW5kb3dzQWJzb2x1dGVQYXRoO1xuXHRcdGlmIChpc0xvY2FsUGF0aExpa2UpIHtcblx0XHRcdHJldHVybiB7IHR5cGU6IFwibG9jYWxcIiwgcGF0aDogc291cmNlIH07XG5cdFx0fVxuXG5cdFx0Ly8gVHJ5IHBhcnNpbmcgYXMgZ2l0IFVSTFxuXHRcdGNvbnN0IGdpdFBhcnNlZCA9IHBhcnNlR2l0VXJsKHNvdXJjZSk7XG5cdFx0aWYgKGdpdFBhcnNlZCkge1xuXHRcdFx0cmV0dXJuIGdpdFBhcnNlZDtcblx0XHR9XG5cblx0XHRyZXR1cm4geyB0eXBlOiBcImxvY2FsXCIsIHBhdGg6IHNvdXJjZSB9O1xuXHR9XG5cblx0LyoqXG5cdCAqIENoZWNrIGlmIGFuIG5wbSBwYWNrYWdlIG5lZWRzIHRvIGJlIHVwZGF0ZWQuXG5cdCAqIC0gRm9yIHVucGlubmVkIHBhY2thZ2VzOiBjaGVjayBpZiByZWdpc3RyeSBoYXMgYSBuZXdlciB2ZXJzaW9uXG5cdCAqIC0gRm9yIHBpbm5lZCBwYWNrYWdlczogY2hlY2sgaWYgaW5zdGFsbGVkIHZlcnNpb24gbWF0Y2hlcyB0aGUgcGlubmVkIHZlcnNpb25cblx0ICovXG5cdHByaXZhdGUgYXN5bmMgbnBtTmVlZHNVcGRhdGUoc291cmNlOiBOcG1Tb3VyY2UsIGluc3RhbGxlZFBhdGg6IHN0cmluZyk6IFByb21pc2U8Ym9vbGVhbj4ge1xuXHRcdGlmIChpc09mZmxpbmVNb2RlRW5hYmxlZCgpKSB7XG5cdFx0XHRyZXR1cm4gZmFsc2U7XG5cdFx0fVxuXG5cdFx0Y29uc3QgaW5zdGFsbGVkVmVyc2lvbiA9IHRoaXMuZ2V0SW5zdGFsbGVkTnBtVmVyc2lvbihpbnN0YWxsZWRQYXRoKTtcblx0XHRpZiAoIWluc3RhbGxlZFZlcnNpb24pIHJldHVybiB0cnVlO1xuXG5cdFx0Y29uc3QgeyB2ZXJzaW9uOiBwaW5uZWRWZXJzaW9uIH0gPSB0aGlzLnBhcnNlTnBtU3BlYyhzb3VyY2Uuc3BlYyk7XG5cdFx0aWYgKHBpbm5lZFZlcnNpb24pIHtcblx0XHRcdC8vIFBpbm5lZDogY2hlY2sgaWYgaW5zdGFsbGVkIG1hdGNoZXMgcGlubmVkIChleGFjdCBtYXRjaCBmb3Igbm93KVxuXHRcdFx0cmV0dXJuIGluc3RhbGxlZFZlcnNpb24gIT09IHBpbm5lZFZlcnNpb247XG5cdFx0fVxuXG5cdFx0Ly8gVW5waW5uZWQ6IGNoZWNrIHJlZ2lzdHJ5IGZvciBsYXRlc3QgdmVyc2lvblxuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBsYXRlc3RWZXJzaW9uID0gYXdhaXQgdGhpcy5nZXRMYXRlc3ROcG1WZXJzaW9uKHNvdXJjZS5uYW1lKTtcblx0XHRcdHJldHVybiBsYXRlc3RWZXJzaW9uICE9PSBpbnN0YWxsZWRWZXJzaW9uO1xuXHRcdH0gY2F0Y2gge1xuXHRcdFx0Ly8gSWYgd2UgY2FuJ3QgY2hlY2sgcmVnaXN0cnksIGFzc3VtZSBpdCdzIGZpbmVcblx0XHRcdHJldHVybiBmYWxzZTtcblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIGdldEluc3RhbGxlZE5wbVZlcnNpb24oaW5zdGFsbGVkUGF0aDogc3RyaW5nKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcblx0XHRjb25zdCBwYWNrYWdlSnNvblBhdGggPSBqb2luKGluc3RhbGxlZFBhdGgsIFwicGFja2FnZS5qc29uXCIpO1xuXHRcdGlmICghZXhpc3RzU3luYyhwYWNrYWdlSnNvblBhdGgpKSByZXR1cm4gdW5kZWZpbmVkO1xuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBjb250ZW50ID0gcmVhZEZpbGVTeW5jKHBhY2thZ2VKc29uUGF0aCwgXCJ1dGYtOFwiKTtcblx0XHRcdGNvbnN0IHBrZyA9IEpTT04ucGFyc2UoY29udGVudCkgYXMgeyB2ZXJzaW9uPzogc3RyaW5nIH07XG5cdFx0XHRyZXR1cm4gcGtnLnZlcnNpb247XG5cdFx0fSBjYXRjaCB7XG5cdFx0XHRyZXR1cm4gdW5kZWZpbmVkO1xuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgYXN5bmMgZ2V0TGF0ZXN0TnBtVmVyc2lvbihwYWNrYWdlTmFtZTogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmc+IHtcblx0XHRjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKGBodHRwczovL3JlZ2lzdHJ5Lm5wbWpzLm9yZy8ke3BhY2thZ2VOYW1lfS9sYXRlc3RgLCB7XG5cdFx0XHRzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoTkVUV09SS19USU1FT1VUX01TKSxcblx0XHR9KTtcblx0XHRpZiAoIXJlc3BvbnNlLm9rKSB0aHJvdyBuZXcgRXJyb3IoYEZhaWxlZCB0byBmZXRjaCBucG0gcmVnaXN0cnk6ICR7cmVzcG9uc2Uuc3RhdHVzfWApO1xuXHRcdGNvbnN0IGRhdGEgPSAoYXdhaXQgcmVzcG9uc2UuanNvbigpKSBhcyB7IHZlcnNpb246IHN0cmluZyB9O1xuXHRcdHJldHVybiBkYXRhLnZlcnNpb247XG5cdH1cblxuXHQvKipcblx0ICogR2V0IGEgdW5pcXVlIGlkZW50aXR5IGZvciBhIHBhY2thZ2UsIGlnbm9yaW5nIHZlcnNpb24vcmVmLlxuXHQgKiBVc2VkIHRvIGRldGVjdCB3aGVuIHRoZSBzYW1lIHBhY2thZ2UgaXMgaW4gYm90aCBnbG9iYWwgYW5kIHByb2plY3Qgc2V0dGluZ3MuXG5cdCAqIEZvciBnaXQgcGFja2FnZXMsIHVzZXMgbm9ybWFsaXplZCBob3N0L3BhdGggdG8gZW5zdXJlIFNTSCBhbmQgSFRUUFMgVVJMc1xuXHQgKiBmb3IgdGhlIHNhbWUgcmVwb3NpdG9yeSBhcmUgdHJlYXRlZCBhcyBpZGVudGljYWwuXG5cdCAqL1xuXHRwcml2YXRlIGdldFBhY2thZ2VJZGVudGl0eShzb3VyY2U6IHN0cmluZywgc2NvcGU/OiBTb3VyY2VTY29wZSk6IHN0cmluZyB7XG5cdFx0Y29uc3QgcGFyc2VkID0gdGhpcy5wYXJzZVNvdXJjZShzb3VyY2UpO1xuXHRcdGlmIChwYXJzZWQudHlwZSA9PT0gXCJucG1cIikge1xuXHRcdFx0cmV0dXJuIGBucG06JHtwYXJzZWQubmFtZX1gO1xuXHRcdH1cblx0XHRpZiAocGFyc2VkLnR5cGUgPT09IFwiZ2l0XCIpIHtcblx0XHRcdC8vIFVzZSBob3N0L3BhdGggZm9yIGlkZW50aXR5IHRvIG5vcm1hbGl6ZSBTU0ggYW5kIEhUVFBTXG5cdFx0XHRyZXR1cm4gYGdpdDoke3BhcnNlZC5ob3N0fS8ke3BhcnNlZC5wYXRofWA7XG5cdFx0fVxuXHRcdGlmIChzY29wZSkge1xuXHRcdFx0Y29uc3QgYmFzZURpciA9IHRoaXMuZ2V0QmFzZURpckZvclNjb3BlKHNjb3BlKTtcblx0XHRcdHJldHVybiBgbG9jYWw6JHt0aGlzLnJlc29sdmVQYXRoRnJvbUJhc2UocGFyc2VkLnBhdGgsIGJhc2VEaXIpfWA7XG5cdFx0fVxuXHRcdHJldHVybiBgbG9jYWw6JHt0aGlzLnJlc29sdmVQYXRoKHBhcnNlZC5wYXRoKX1gO1xuXHR9XG5cblx0LyoqXG5cdCAqIERlZHVwZSBwYWNrYWdlczogaWYgc2FtZSBwYWNrYWdlIGlkZW50aXR5IGFwcGVhcnMgaW4gYm90aCBnbG9iYWwgYW5kIHByb2plY3QsXG5cdCAqIGtlZXAgb25seSB0aGUgcHJvamVjdCBvbmUgKHByb2plY3Qgd2lucykuXG5cdCAqL1xuXHRwcml2YXRlIGRlZHVwZVBhY2thZ2VzKFxuXHRcdHBhY2thZ2VzOiBBcnJheTx7IHBrZzogUGFja2FnZVNvdXJjZTsgc2NvcGU6IFNvdXJjZVNjb3BlIH0+LFxuXHQpOiBBcnJheTx7IHBrZzogUGFja2FnZVNvdXJjZTsgc2NvcGU6IFNvdXJjZVNjb3BlIH0+IHtcblx0XHRjb25zdCBzZWVuID0gbmV3IE1hcDxzdHJpbmcsIHsgcGtnOiBQYWNrYWdlU291cmNlOyBzY29wZTogU291cmNlU2NvcGUgfT4oKTtcblxuXHRcdGZvciAoY29uc3QgZW50cnkgb2YgcGFja2FnZXMpIHtcblx0XHRcdGNvbnN0IHNvdXJjZVN0ciA9IHR5cGVvZiBlbnRyeS5wa2cgPT09IFwic3RyaW5nXCIgPyBlbnRyeS5wa2cgOiBlbnRyeS5wa2cuc291cmNlO1xuXHRcdFx0Y29uc3QgaWRlbnRpdHkgPSB0aGlzLmdldFBhY2thZ2VJZGVudGl0eShzb3VyY2VTdHIsIGVudHJ5LnNjb3BlKTtcblxuXHRcdFx0Y29uc3QgZXhpc3RpbmcgPSBzZWVuLmdldChpZGVudGl0eSk7XG5cdFx0XHRpZiAoIWV4aXN0aW5nKSB7XG5cdFx0XHRcdHNlZW4uc2V0KGlkZW50aXR5LCBlbnRyeSk7XG5cdFx0XHR9IGVsc2UgaWYgKGVudHJ5LnNjb3BlID09PSBcInByb2plY3RcIiAmJiBleGlzdGluZy5zY29wZSA9PT0gXCJ1c2VyXCIpIHtcblx0XHRcdFx0Ly8gUHJvamVjdCB3aW5zIG92ZXIgdXNlclxuXHRcdFx0XHRzZWVuLnNldChpZGVudGl0eSwgZW50cnkpO1xuXHRcdFx0fVxuXHRcdFx0Ly8gSWYgZXhpc3RpbmcgaXMgcHJvamVjdCBhbmQgbmV3IGlzIGdsb2JhbCwga2VlcCBleGlzdGluZyAocHJvamVjdClcblx0XHRcdC8vIElmIGJvdGggYXJlIHNhbWUgc2NvcGUsIGtlZXAgZmlyc3Qgb25lXG5cdFx0fVxuXG5cdFx0cmV0dXJuIEFycmF5LmZyb20oc2Vlbi52YWx1ZXMoKSk7XG5cdH1cblxuXHRwcml2YXRlIHBhcnNlTnBtU3BlYyhzcGVjOiBzdHJpbmcpOiB7IG5hbWU6IHN0cmluZzsgdmVyc2lvbj86IHN0cmluZyB9IHtcblx0XHRjb25zdCBtYXRjaCA9IHNwZWMubWF0Y2goL14oQD9bXkBdKyg/OlxcL1teQF0rKT8pKD86QCguKykpPyQvKTtcblx0XHRpZiAoIW1hdGNoKSB7XG5cdFx0XHRyZXR1cm4geyBuYW1lOiBzcGVjIH07XG5cdFx0fVxuXHRcdGNvbnN0IG5hbWUgPSBtYXRjaFsxXSA/PyBzcGVjO1xuXHRcdGNvbnN0IHZlcnNpb24gPSBtYXRjaFsyXTtcblx0XHRyZXR1cm4geyBuYW1lLCB2ZXJzaW9uIH07XG5cdH1cblxuXHRwcml2YXRlIGFzeW5jIGluc3RhbGxOcG0oc291cmNlOiBOcG1Tb3VyY2UsIHNjb3BlOiBTb3VyY2VTY29wZSwgdGVtcG9yYXJ5OiBib29sZWFuKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0aWYgKHNjb3BlID09PSBcInVzZXJcIiAmJiAhdGVtcG9yYXJ5KSB7XG5cdFx0XHRhd2FpdCB0aGlzLnJ1bkNvbW1hbmQoXCJucG1cIiwgW1wiaW5zdGFsbFwiLCBcIi1nXCIsIHNvdXJjZS5zcGVjXSk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXHRcdGNvbnN0IGluc3RhbGxSb290ID0gdGhpcy5nZXROcG1JbnN0YWxsUm9vdChzY29wZSwgdGVtcG9yYXJ5KTtcblx0XHR0aGlzLmVuc3VyZU5wbVByb2plY3QoaW5zdGFsbFJvb3QpO1xuXHRcdGF3YWl0IHRoaXMucnVuQ29tbWFuZChcIm5wbVwiLCBbXCJpbnN0YWxsXCIsIHNvdXJjZS5zcGVjLCBcIi0tcHJlZml4XCIsIGluc3RhbGxSb290XSk7XG5cdH1cblxuXHRwcml2YXRlIGFzeW5jIHVuaW5zdGFsbE5wbShzb3VyY2U6IE5wbVNvdXJjZSwgc2NvcGU6IFNvdXJjZVNjb3BlKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0aWYgKHNjb3BlID09PSBcInVzZXJcIikge1xuXHRcdFx0YXdhaXQgdGhpcy5ydW5Db21tYW5kKFwibnBtXCIsIFtcInVuaW5zdGFsbFwiLCBcIi1nXCIsIHNvdXJjZS5uYW1lXSk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXHRcdGNvbnN0IGluc3RhbGxSb290ID0gdGhpcy5nZXROcG1JbnN0YWxsUm9vdChzY29wZSwgZmFsc2UpO1xuXHRcdGlmICghZXhpc3RzU3luYyhpbnN0YWxsUm9vdCkpIHtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cdFx0YXdhaXQgdGhpcy5ydW5Db21tYW5kKFwibnBtXCIsIFtcInVuaW5zdGFsbFwiLCBzb3VyY2UubmFtZSwgXCItLXByZWZpeFwiLCBpbnN0YWxsUm9vdF0pO1xuXHR9XG5cblx0cHJpdmF0ZSBhc3luYyBpbnN0YWxsR2l0KHNvdXJjZTogR2l0U291cmNlLCBzY29wZTogU291cmNlU2NvcGUpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRjb25zdCB0YXJnZXREaXIgPSB0aGlzLmdldEdpdEluc3RhbGxQYXRoKHNvdXJjZSwgc2NvcGUpO1xuXHRcdGlmIChleGlzdHNTeW5jKHRhcmdldERpcikpIHtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cdFx0Y29uc3QgZ2l0Um9vdCA9IHRoaXMuZ2V0R2l0SW5zdGFsbFJvb3Qoc2NvcGUpO1xuXHRcdGlmIChnaXRSb290KSB7XG5cdFx0XHR0aGlzLmVuc3VyZUdpdElnbm9yZShnaXRSb290KTtcblx0XHR9XG5cdFx0bWtkaXJTeW5jKGRpcm5hbWUodGFyZ2V0RGlyKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cblx0XHRhd2FpdCB0aGlzLnJ1bkNvbW1hbmQoXCJnaXRcIiwgW1wiY2xvbmVcIiwgc291cmNlLnJlcG8sIHRhcmdldERpcl0pO1xuXHRcdGlmIChzb3VyY2UucmVmKSB7XG5cdFx0XHRhd2FpdCB0aGlzLnJ1bkNvbW1hbmQoXCJnaXRcIiwgW1wiY2hlY2tvdXRcIiwgc291cmNlLnJlZl0sIHsgY3dkOiB0YXJnZXREaXIgfSk7XG5cdFx0fVxuXHRcdGNvbnN0IHBhY2thZ2VKc29uUGF0aCA9IGpvaW4odGFyZ2V0RGlyLCBcInBhY2thZ2UuanNvblwiKTtcblx0XHRpZiAoZXhpc3RzU3luYyhwYWNrYWdlSnNvblBhdGgpKSB7XG5cdFx0XHRhd2FpdCB0aGlzLnJ1bkNvbW1hbmQoXCJucG1cIiwgW1wiaW5zdGFsbFwiXSwgeyBjd2Q6IHRhcmdldERpciB9KTtcblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIGFzeW5jIHVwZGF0ZUdpdChzb3VyY2U6IEdpdFNvdXJjZSwgc2NvcGU6IFNvdXJjZVNjb3BlKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0Y29uc3QgdGFyZ2V0RGlyID0gdGhpcy5nZXRHaXRJbnN0YWxsUGF0aChzb3VyY2UsIHNjb3BlKTtcblx0XHRpZiAoIWV4aXN0c1N5bmModGFyZ2V0RGlyKSkge1xuXHRcdFx0YXdhaXQgdGhpcy5pbnN0YWxsR2l0KHNvdXJjZSwgc2NvcGUpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdC8vIEZldGNoIGxhdGVzdCBmcm9tIHJlbW90ZSAoaGFuZGxlcyBmb3JjZS1wdXNoIGJ5IGdldHRpbmcgbmV3IGhpc3RvcnkpXG5cdFx0YXdhaXQgdGhpcy5ydW5Db21tYW5kKFwiZ2l0XCIsIFtcImZldGNoXCIsIFwiLS1wcnVuZVwiLCBcIm9yaWdpblwiXSwgeyBjd2Q6IHRhcmdldERpciB9KTtcblxuXHRcdC8vIFJlc2V0IHRvIHRyYWNraW5nIGJyYW5jaC4gRmFsbCBiYWNrIHRvIG9yaWdpbi9IRUFEIHdoZW4gbm8gdXBzdHJlYW0gaXMgY29uZmlndXJlZC5cblx0XHR0cnkge1xuXHRcdFx0YXdhaXQgdGhpcy5ydW5Db21tYW5kKFwiZ2l0XCIsIFtcInJlc2V0XCIsIFwiLS1oYXJkXCIsIFwiQHt1cHN0cmVhbX1cIl0sIHsgY3dkOiB0YXJnZXREaXIgfSk7XG5cdFx0fSBjYXRjaCB7XG5cdFx0XHRhd2FpdCB0aGlzLnJ1bkNvbW1hbmQoXCJnaXRcIiwgW1wicmVtb3RlXCIsIFwic2V0LWhlYWRcIiwgXCJvcmlnaW5cIiwgXCItYVwiXSwgeyBjd2Q6IHRhcmdldERpciB9KS5jYXRjaCgoKSA9PiB7fSk7XG5cdFx0XHRhd2FpdCB0aGlzLnJ1bkNvbW1hbmQoXCJnaXRcIiwgW1wicmVzZXRcIiwgXCItLWhhcmRcIiwgXCJvcmlnaW4vSEVBRFwiXSwgeyBjd2Q6IHRhcmdldERpciB9KTtcblx0XHR9XG5cblx0XHQvLyBDbGVhbiB1bnRyYWNrZWQgZmlsZXMgKGV4dGVuc2lvbnMgc2hvdWxkIGJlIHByaXN0aW5lKVxuXHRcdGF3YWl0IHRoaXMucnVuQ29tbWFuZChcImdpdFwiLCBbXCJjbGVhblwiLCBcIi1mZHhcIl0sIHsgY3dkOiB0YXJnZXREaXIgfSk7XG5cblx0XHRjb25zdCBwYWNrYWdlSnNvblBhdGggPSBqb2luKHRhcmdldERpciwgXCJwYWNrYWdlLmpzb25cIik7XG5cdFx0aWYgKGV4aXN0c1N5bmMocGFja2FnZUpzb25QYXRoKSkge1xuXHRcdFx0YXdhaXQgdGhpcy5ydW5Db21tYW5kKFwibnBtXCIsIFtcImluc3RhbGxcIl0sIHsgY3dkOiB0YXJnZXREaXIgfSk7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBhc3luYyByZWZyZXNoVGVtcG9yYXJ5R2l0U291cmNlKHNvdXJjZTogR2l0U291cmNlLCBzb3VyY2VTdHI6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGlmIChpc09mZmxpbmVNb2RlRW5hYmxlZCgpKSB7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXHRcdHRyeSB7XG5cdFx0XHRhd2FpdCB0aGlzLndpdGhQcm9ncmVzcyhcInB1bGxcIiwgc291cmNlU3RyLCBgUmVmcmVzaGluZyAke3NvdXJjZVN0cn0uLi5gLCBhc3luYyAoKSA9PiB7XG5cdFx0XHRcdGF3YWl0IHRoaXMudXBkYXRlR2l0KHNvdXJjZSwgXCJ0ZW1wb3JhcnlcIik7XG5cdFx0XHR9KTtcblx0XHR9IGNhdGNoIHtcblx0XHRcdC8vIEtlZXAgY2FjaGVkIHRlbXBvcmFyeSBjaGVja291dCBpZiByZWZyZXNoIGZhaWxzLlxuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgYXN5bmMgcmVtb3ZlR2l0KHNvdXJjZTogR2l0U291cmNlLCBzY29wZTogU291cmNlU2NvcGUpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRjb25zdCB0YXJnZXREaXIgPSB0aGlzLmdldEdpdEluc3RhbGxQYXRoKHNvdXJjZSwgc2NvcGUpO1xuXHRcdGlmICghZXhpc3RzU3luYyh0YXJnZXREaXIpKSByZXR1cm47XG5cdFx0cm1TeW5jKHRhcmdldERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuXHRcdHRoaXMucHJ1bmVFbXB0eUdpdFBhcmVudHModGFyZ2V0RGlyLCB0aGlzLmdldEdpdEluc3RhbGxSb290KHNjb3BlKSk7XG5cdH1cblxuXHRwcml2YXRlIHBydW5lRW1wdHlHaXRQYXJlbnRzKHRhcmdldERpcjogc3RyaW5nLCBpbnN0YWxsUm9vdDogc3RyaW5nIHwgdW5kZWZpbmVkKTogdm9pZCB7XG5cdFx0aWYgKCFpbnN0YWxsUm9vdCkgcmV0dXJuO1xuXHRcdGNvbnN0IHJlc29sdmVkUm9vdCA9IHJlc29sdmUoaW5zdGFsbFJvb3QpO1xuXHRcdGxldCBjdXJyZW50ID0gZGlybmFtZSh0YXJnZXREaXIpO1xuXHRcdHdoaWxlIChjdXJyZW50LnN0YXJ0c1dpdGgocmVzb2x2ZWRSb290KSAmJiBjdXJyZW50ICE9PSByZXNvbHZlZFJvb3QpIHtcblx0XHRcdGlmICghZXhpc3RzU3luYyhjdXJyZW50KSkge1xuXHRcdFx0XHRjdXJyZW50ID0gZGlybmFtZShjdXJyZW50KTtcblx0XHRcdFx0Y29udGludWU7XG5cdFx0XHR9XG5cdFx0XHRjb25zdCBlbnRyaWVzID0gcmVhZGRpclN5bmMoY3VycmVudCk7XG5cdFx0XHRpZiAoZW50cmllcy5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdGJyZWFrO1xuXHRcdFx0fVxuXHRcdFx0dHJ5IHtcblx0XHRcdFx0cm1TeW5jKGN1cnJlbnQsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcblx0XHRcdH0gY2F0Y2gge1xuXHRcdFx0XHRicmVhaztcblx0XHRcdH1cblx0XHRcdGN1cnJlbnQgPSBkaXJuYW1lKGN1cnJlbnQpO1xuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgZW5zdXJlTnBtUHJvamVjdChpbnN0YWxsUm9vdDogc3RyaW5nKTogdm9pZCB7XG5cdFx0aWYgKCFleGlzdHNTeW5jKGluc3RhbGxSb290KSkge1xuXHRcdFx0bWtkaXJTeW5jKGluc3RhbGxSb290LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblx0XHR9XG5cdFx0dGhpcy5lbnN1cmVHaXRJZ25vcmUoaW5zdGFsbFJvb3QpO1xuXHRcdGNvbnN0IHBhY2thZ2VKc29uUGF0aCA9IGpvaW4oaW5zdGFsbFJvb3QsIFwicGFja2FnZS5qc29uXCIpO1xuXHRcdGlmICghZXhpc3RzU3luYyhwYWNrYWdlSnNvblBhdGgpKSB7XG5cdFx0XHRjb25zdCBwa2dKc29uID0geyBuYW1lOiBcInBpLWV4dGVuc2lvbnNcIiwgcHJpdmF0ZTogdHJ1ZSB9O1xuXHRcdFx0d3JpdGVGaWxlU3luYyhwYWNrYWdlSnNvblBhdGgsIEpTT04uc3RyaW5naWZ5KHBrZ0pzb24sIG51bGwsIDIpLCBcInV0Zi04XCIpO1xuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgZW5zdXJlR2l0SWdub3JlKGRpcjogc3RyaW5nKTogdm9pZCB7XG5cdFx0aWYgKCFleGlzdHNTeW5jKGRpcikpIHtcblx0XHRcdG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXHRcdH1cblx0XHRjb25zdCBpZ25vcmVQYXRoID0gam9pbihkaXIsIFwiLmdpdGlnbm9yZVwiKTtcblx0XHRpZiAoIWV4aXN0c1N5bmMoaWdub3JlUGF0aCkpIHtcblx0XHRcdHdyaXRlRmlsZVN5bmMoaWdub3JlUGF0aCwgXCIqXFxuIS5naXRpZ25vcmVcXG5cIiwgXCJ1dGYtOFwiKTtcblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIGdldE5wbUluc3RhbGxSb290KHNjb3BlOiBTb3VyY2VTY29wZSwgdGVtcG9yYXJ5OiBib29sZWFuKTogc3RyaW5nIHtcblx0XHRpZiAodGVtcG9yYXJ5KSB7XG5cdFx0XHRyZXR1cm4gdGhpcy5nZXRUZW1wb3JhcnlEaXIoXCJucG1cIik7XG5cdFx0fVxuXHRcdGlmIChzY29wZSA9PT0gXCJwcm9qZWN0XCIpIHtcblx0XHRcdHJldHVybiBqb2luKHRoaXMuY3dkLCBDT05GSUdfRElSX05BTUUsIFwibnBtXCIpO1xuXHRcdH1cblx0XHRyZXR1cm4gam9pbih0aGlzLmdldEdsb2JhbE5wbVJvb3QoKSwgXCIuLlwiKTtcblx0fVxuXG5cdHByaXZhdGUgZ2V0R2xvYmFsTnBtUm9vdCgpOiBzdHJpbmcge1xuXHRcdGlmICh0aGlzLmdsb2JhbE5wbVJvb3QpIHtcblx0XHRcdHJldHVybiB0aGlzLmdsb2JhbE5wbVJvb3Q7XG5cdFx0fVxuXHRcdGNvbnN0IHJlc3VsdCA9IHRoaXMucnVuQ29tbWFuZFN5bmMoXCJucG1cIiwgW1wicm9vdFwiLCBcIi1nXCJdKTtcblx0XHR0aGlzLmdsb2JhbE5wbVJvb3QgPSByZXN1bHQudHJpbSgpO1xuXHRcdHJldHVybiB0aGlzLmdsb2JhbE5wbVJvb3Q7XG5cdH1cblxuXHRwcml2YXRlIGdldE5wbUluc3RhbGxQYXRoKHNvdXJjZTogTnBtU291cmNlLCBzY29wZTogU291cmNlU2NvcGUpOiBzdHJpbmcge1xuXHRcdGlmIChzY29wZSA9PT0gXCJ0ZW1wb3JhcnlcIikge1xuXHRcdFx0cmV0dXJuIGpvaW4odGhpcy5nZXRUZW1wb3JhcnlEaXIoXCJucG1cIiksIFwibm9kZV9tb2R1bGVzXCIsIHNvdXJjZS5uYW1lKTtcblx0XHR9XG5cdFx0aWYgKHNjb3BlID09PSBcInByb2plY3RcIikge1xuXHRcdFx0cmV0dXJuIGpvaW4odGhpcy5jd2QsIENPTkZJR19ESVJfTkFNRSwgXCJucG1cIiwgXCJub2RlX21vZHVsZXNcIiwgc291cmNlLm5hbWUpO1xuXHRcdH1cblx0XHRyZXR1cm4gam9pbih0aGlzLmdldEdsb2JhbE5wbVJvb3QoKSwgc291cmNlLm5hbWUpO1xuXHR9XG5cblx0cHJpdmF0ZSBnZXRHaXRJbnN0YWxsUGF0aChzb3VyY2U6IEdpdFNvdXJjZSwgc2NvcGU6IFNvdXJjZVNjb3BlKTogc3RyaW5nIHtcblx0XHRpZiAoc2NvcGUgPT09IFwidGVtcG9yYXJ5XCIpIHtcblx0XHRcdHJldHVybiB0aGlzLmdldFRlbXBvcmFyeURpcihgZ2l0LSR7c291cmNlLmhvc3R9YCwgc291cmNlLnBhdGgpO1xuXHRcdH1cblx0XHRpZiAoc2NvcGUgPT09IFwicHJvamVjdFwiKSB7XG5cdFx0XHRyZXR1cm4gam9pbih0aGlzLmN3ZCwgQ09ORklHX0RJUl9OQU1FLCBcImdpdFwiLCBzb3VyY2UuaG9zdCwgc291cmNlLnBhdGgpO1xuXHRcdH1cblx0XHRyZXR1cm4gam9pbih0aGlzLmFnZW50RGlyLCBcImdpdFwiLCBzb3VyY2UuaG9zdCwgc291cmNlLnBhdGgpO1xuXHR9XG5cblx0cHJpdmF0ZSBnZXRHaXRJbnN0YWxsUm9vdChzY29wZTogU291cmNlU2NvcGUpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuXHRcdGlmIChzY29wZSA9PT0gXCJ0ZW1wb3JhcnlcIikge1xuXHRcdFx0cmV0dXJuIHVuZGVmaW5lZDtcblx0XHR9XG5cdFx0aWYgKHNjb3BlID09PSBcInByb2plY3RcIikge1xuXHRcdFx0cmV0dXJuIGpvaW4odGhpcy5jd2QsIENPTkZJR19ESVJfTkFNRSwgXCJnaXRcIik7XG5cdFx0fVxuXHRcdHJldHVybiBqb2luKHRoaXMuYWdlbnREaXIsIFwiZ2l0XCIpO1xuXHR9XG5cblx0cHJpdmF0ZSBnZXRUZW1wb3JhcnlEaXIocHJlZml4OiBzdHJpbmcsIHN1ZmZpeD86IHN0cmluZyk6IHN0cmluZyB7XG5cdFx0Y29uc3QgaGFzaCA9IGNyZWF0ZUhhc2goXCJzaGEyNTZcIilcblx0XHRcdC51cGRhdGUoYCR7cHJlZml4fS0ke3N1ZmZpeCA/PyBcIlwifWApXG5cdFx0XHQuZGlnZXN0KFwiaGV4XCIpXG5cdFx0XHQuc2xpY2UoMCwgOCk7XG5cdFx0cmV0dXJuIGpvaW4odG1wZGlyKCksIFwicGktZXh0ZW5zaW9uc1wiLCBwcmVmaXgsIGhhc2gsIHN1ZmZpeCA/PyBcIlwiKTtcblx0fVxuXG5cdHByaXZhdGUgZ2V0QmFzZURpckZvclNjb3BlKHNjb3BlOiBTb3VyY2VTY29wZSk6IHN0cmluZyB7XG5cdFx0aWYgKHNjb3BlID09PSBcInByb2plY3RcIikge1xuXHRcdFx0cmV0dXJuIGpvaW4odGhpcy5jd2QsIENPTkZJR19ESVJfTkFNRSk7XG5cdFx0fVxuXHRcdGlmIChzY29wZSA9PT0gXCJ1c2VyXCIpIHtcblx0XHRcdHJldHVybiB0aGlzLmFnZW50RGlyO1xuXHRcdH1cblx0XHRyZXR1cm4gdGhpcy5jd2Q7XG5cdH1cblxuXHRwcml2YXRlIHJlc29sdmVQYXRoKGlucHV0OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRcdGNvbnN0IHRyaW1tZWQgPSBpbnB1dC50cmltKCk7XG5cdFx0aWYgKHRyaW1tZWQgPT09IFwiflwiKSByZXR1cm4gaG9tZWRpcigpO1xuXHRcdGlmICh0cmltbWVkLnN0YXJ0c1dpdGgoXCJ+L1wiKSkgcmV0dXJuIGpvaW4oaG9tZWRpcigpLCB0cmltbWVkLnNsaWNlKDIpKTtcblx0XHRpZiAodHJpbW1lZC5zdGFydHNXaXRoKFwiflwiKSkgcmV0dXJuIGpvaW4oaG9tZWRpcigpLCB0cmltbWVkLnNsaWNlKDEpKTtcblx0XHRyZXR1cm4gcmVzb2x2ZSh0aGlzLmN3ZCwgdHJpbW1lZCk7XG5cdH1cblxuXHRwcml2YXRlIHJlc29sdmVQYXRoRnJvbUJhc2UoaW5wdXQ6IHN0cmluZywgYmFzZURpcjogc3RyaW5nKTogc3RyaW5nIHtcblx0XHRjb25zdCB0cmltbWVkID0gaW5wdXQudHJpbSgpO1xuXHRcdGlmICh0cmltbWVkID09PSBcIn5cIikgcmV0dXJuIGhvbWVkaXIoKTtcblx0XHRpZiAodHJpbW1lZC5zdGFydHNXaXRoKFwifi9cIikpIHJldHVybiBqb2luKGhvbWVkaXIoKSwgdHJpbW1lZC5zbGljZSgyKSk7XG5cdFx0aWYgKHRyaW1tZWQuc3RhcnRzV2l0aChcIn5cIikpIHJldHVybiBqb2luKGhvbWVkaXIoKSwgdHJpbW1lZC5zbGljZSgxKSk7XG5cdFx0cmV0dXJuIHJlc29sdmUoYmFzZURpciwgdHJpbW1lZCk7XG5cdH1cblxuXHRwcml2YXRlIGNvbGxlY3RQYWNrYWdlUmVzb3VyY2VzKFxuXHRcdHBhY2thZ2VSb290OiBzdHJpbmcsXG5cdFx0YWNjdW11bGF0b3I6IFJlc291cmNlQWNjdW11bGF0b3IsXG5cdFx0ZmlsdGVyOiBQYWNrYWdlRmlsdGVyIHwgdW5kZWZpbmVkLFxuXHRcdG1ldGFkYXRhOiBQYXRoTWV0YWRhdGEsXG5cdCk6IGJvb2xlYW4ge1xuXHRcdGlmIChmaWx0ZXIpIHtcblx0XHRcdGZvciAoY29uc3QgcmVzb3VyY2VUeXBlIG9mIFJFU09VUkNFX1RZUEVTKSB7XG5cdFx0XHRcdGNvbnN0IHBhdHRlcm5zID0gZmlsdGVyW3Jlc291cmNlVHlwZSBhcyBrZXlvZiBQYWNrYWdlRmlsdGVyXTtcblx0XHRcdFx0Y29uc3QgdGFyZ2V0ID0gdGhpcy5nZXRUYXJnZXRNYXAoYWNjdW11bGF0b3IsIHJlc291cmNlVHlwZSk7XG5cdFx0XHRcdGlmIChwYXR0ZXJucyAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0XHRcdFx0dGhpcy5hcHBseVBhY2thZ2VGaWx0ZXIocGFja2FnZVJvb3QsIHBhdHRlcm5zLCByZXNvdXJjZVR5cGUsIHRhcmdldCwgbWV0YWRhdGEpO1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdHRoaXMuY29sbGVjdERlZmF1bHRSZXNvdXJjZXMocGFja2FnZVJvb3QsIHJlc291cmNlVHlwZSwgdGFyZ2V0LCBtZXRhZGF0YSk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHRcdHJldHVybiB0cnVlO1xuXHRcdH1cblxuXHRcdGNvbnN0IG1hbmlmZXN0ID0gdGhpcy5yZWFkUGlNYW5pZmVzdChwYWNrYWdlUm9vdCk7XG5cdFx0aWYgKG1hbmlmZXN0KSB7XG5cdFx0XHRmb3IgKGNvbnN0IHJlc291cmNlVHlwZSBvZiBSRVNPVVJDRV9UWVBFUykge1xuXHRcdFx0XHRjb25zdCBlbnRyaWVzID0gbWFuaWZlc3RbcmVzb3VyY2VUeXBlIGFzIGtleW9mIFBpTWFuaWZlc3RdO1xuXHRcdFx0XHR0aGlzLmFkZE1hbmlmZXN0RW50cmllcyhcblx0XHRcdFx0XHRlbnRyaWVzLFxuXHRcdFx0XHRcdHBhY2thZ2VSb290LFxuXHRcdFx0XHRcdHJlc291cmNlVHlwZSxcblx0XHRcdFx0XHR0aGlzLmdldFRhcmdldE1hcChhY2N1bXVsYXRvciwgcmVzb3VyY2VUeXBlKSxcblx0XHRcdFx0XHRtZXRhZGF0YSxcblx0XHRcdFx0KTtcblx0XHRcdH1cblx0XHRcdHJldHVybiB0cnVlO1xuXHRcdH1cblxuXHRcdGxldCBoYXNBbnlEaXIgPSBmYWxzZTtcblx0XHRmb3IgKGNvbnN0IHJlc291cmNlVHlwZSBvZiBSRVNPVVJDRV9UWVBFUykge1xuXHRcdFx0Y29uc3QgZGlyID0gam9pbihwYWNrYWdlUm9vdCwgcmVzb3VyY2VUeXBlKTtcblx0XHRcdGlmIChleGlzdHNTeW5jKGRpcikpIHtcblx0XHRcdFx0Ly8gQ29sbGVjdCBhbGwgZmlsZXMgZnJvbSB0aGUgZGlyZWN0b3J5IChhbGwgZW5hYmxlZCBieSBkZWZhdWx0KVxuXHRcdFx0XHRjb25zdCBmaWxlcyA9IGNvbGxlY3RSZXNvdXJjZUZpbGVzKGRpciwgcmVzb3VyY2VUeXBlKTtcblx0XHRcdFx0Zm9yIChjb25zdCBmIG9mIGZpbGVzKSB7XG5cdFx0XHRcdFx0dGhpcy5hZGRSZXNvdXJjZSh0aGlzLmdldFRhcmdldE1hcChhY2N1bXVsYXRvciwgcmVzb3VyY2VUeXBlKSwgZiwgbWV0YWRhdGEsIHRydWUpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGhhc0FueURpciA9IHRydWU7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdHJldHVybiBoYXNBbnlEaXI7XG5cdH1cblxuXHRwcml2YXRlIGNvbGxlY3REZWZhdWx0UmVzb3VyY2VzKFxuXHRcdHBhY2thZ2VSb290OiBzdHJpbmcsXG5cdFx0cmVzb3VyY2VUeXBlOiBSZXNvdXJjZVR5cGUsXG5cdFx0dGFyZ2V0OiBNYXA8c3RyaW5nLCB7IG1ldGFkYXRhOiBQYXRoTWV0YWRhdGE7IGVuYWJsZWQ6IGJvb2xlYW4gfT4sXG5cdFx0bWV0YWRhdGE6IFBhdGhNZXRhZGF0YSxcblx0KTogdm9pZCB7XG5cdFx0Y29uc3QgbWFuaWZlc3QgPSB0aGlzLnJlYWRQaU1hbmlmZXN0KHBhY2thZ2VSb290KTtcblx0XHRjb25zdCBlbnRyaWVzID0gbWFuaWZlc3Q/LltyZXNvdXJjZVR5cGUgYXMga2V5b2YgUGlNYW5pZmVzdF07XG5cdFx0aWYgKGVudHJpZXMpIHtcblx0XHRcdHRoaXMuYWRkTWFuaWZlc3RFbnRyaWVzKGVudHJpZXMsIHBhY2thZ2VSb290LCByZXNvdXJjZVR5cGUsIHRhcmdldCwgbWV0YWRhdGEpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblx0XHRjb25zdCBkaXIgPSBqb2luKHBhY2thZ2VSb290LCByZXNvdXJjZVR5cGUpO1xuXHRcdGlmIChleGlzdHNTeW5jKGRpcikpIHtcblx0XHRcdC8vIENvbGxlY3QgYWxsIGZpbGVzIGZyb20gdGhlIGRpcmVjdG9yeSAoYWxsIGVuYWJsZWQgYnkgZGVmYXVsdClcblx0XHRcdGNvbnN0IGZpbGVzID0gY29sbGVjdFJlc291cmNlRmlsZXMoZGlyLCByZXNvdXJjZVR5cGUpO1xuXHRcdFx0Zm9yIChjb25zdCBmIG9mIGZpbGVzKSB7XG5cdFx0XHRcdHRoaXMuYWRkUmVzb3VyY2UodGFyZ2V0LCBmLCBtZXRhZGF0YSwgdHJ1ZSk7XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBhcHBseVBhY2thZ2VGaWx0ZXIoXG5cdFx0cGFja2FnZVJvb3Q6IHN0cmluZyxcblx0XHR1c2VyUGF0dGVybnM6IHN0cmluZ1tdLFxuXHRcdHJlc291cmNlVHlwZTogUmVzb3VyY2VUeXBlLFxuXHRcdHRhcmdldDogTWFwPHN0cmluZywgeyBtZXRhZGF0YTogUGF0aE1ldGFkYXRhOyBlbmFibGVkOiBib29sZWFuIH0+LFxuXHRcdG1ldGFkYXRhOiBQYXRoTWV0YWRhdGEsXG5cdCk6IHZvaWQge1xuXHRcdGNvbnN0IHsgYWxsRmlsZXMgfSA9IHRoaXMuY29sbGVjdE1hbmlmZXN0RmlsZXMocGFja2FnZVJvb3QsIHJlc291cmNlVHlwZSk7XG5cblx0XHRpZiAodXNlclBhdHRlcm5zLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0Ly8gRW1wdHkgYXJyYXkgZXhwbGljaXRseSBkaXNhYmxlcyBhbGwgcmVzb3VyY2VzIG9mIHRoaXMgdHlwZVxuXHRcdFx0Zm9yIChjb25zdCBmIG9mIGFsbEZpbGVzKSB7XG5cdFx0XHRcdHRoaXMuYWRkUmVzb3VyY2UodGFyZ2V0LCBmLCBtZXRhZGF0YSwgZmFsc2UpO1xuXHRcdFx0fVxuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdC8vIEFwcGx5IHVzZXIgcGF0dGVybnNcblx0XHRjb25zdCBlbmFibGVkQnlVc2VyID0gYXBwbHlQYXR0ZXJucyhhbGxGaWxlcywgdXNlclBhdHRlcm5zLCBwYWNrYWdlUm9vdCk7XG5cblx0XHRmb3IgKGNvbnN0IGYgb2YgYWxsRmlsZXMpIHtcblx0XHRcdGNvbnN0IGVuYWJsZWQgPSBlbmFibGVkQnlVc2VyLmhhcyhmKTtcblx0XHRcdHRoaXMuYWRkUmVzb3VyY2UodGFyZ2V0LCBmLCBtZXRhZGF0YSwgZW5hYmxlZCk7XG5cdFx0fVxuXHR9XG5cblx0LyoqXG5cdCAqIENvbGxlY3QgYWxsIGZpbGVzIGZyb20gYSBwYWNrYWdlIGZvciBhIHJlc291cmNlIHR5cGUsIGFwcGx5aW5nIG1hbmlmZXN0IHBhdHRlcm5zLlxuXHQgKiBSZXR1cm5zIHsgYWxsRmlsZXMsIGVuYWJsZWRCeU1hbmlmZXN0IH0gd2hlcmUgZW5hYmxlZEJ5TWFuaWZlc3QgaXMgdGhlIHNldCBvZiBmaWxlc1xuXHQgKiB0aGF0IHBhc3MgdGhlIG1hbmlmZXN0J3Mgb3duIHBhdHRlcm5zLlxuXHQgKi9cblx0cHJpdmF0ZSBjb2xsZWN0TWFuaWZlc3RGaWxlcyhcblx0XHRwYWNrYWdlUm9vdDogc3RyaW5nLFxuXHRcdHJlc291cmNlVHlwZTogUmVzb3VyY2VUeXBlLFxuXHQpOiB7IGFsbEZpbGVzOiBzdHJpbmdbXTsgZW5hYmxlZEJ5TWFuaWZlc3Q6IFNldDxzdHJpbmc+IH0ge1xuXHRcdGNvbnN0IG1hbmlmZXN0ID0gdGhpcy5yZWFkUGlNYW5pZmVzdChwYWNrYWdlUm9vdCk7XG5cdFx0Y29uc3QgZW50cmllcyA9IG1hbmlmZXN0Py5bcmVzb3VyY2VUeXBlIGFzIGtleW9mIFBpTWFuaWZlc3RdO1xuXHRcdGlmIChlbnRyaWVzICYmIGVudHJpZXMubGVuZ3RoID4gMCkge1xuXHRcdFx0Y29uc3QgYWxsRmlsZXMgPSB0aGlzLmNvbGxlY3RGaWxlc0Zyb21NYW5pZmVzdEVudHJpZXMoZW50cmllcywgcGFja2FnZVJvb3QsIHJlc291cmNlVHlwZSk7XG5cdFx0XHRjb25zdCBtYW5pZmVzdFBhdHRlcm5zID0gZW50cmllcy5maWx0ZXIoaXNQYXR0ZXJuKTtcblx0XHRcdGNvbnN0IGVuYWJsZWRCeU1hbmlmZXN0ID1cblx0XHRcdFx0bWFuaWZlc3RQYXR0ZXJucy5sZW5ndGggPiAwID8gYXBwbHlQYXR0ZXJucyhhbGxGaWxlcywgbWFuaWZlc3RQYXR0ZXJucywgcGFja2FnZVJvb3QpIDogbmV3IFNldChhbGxGaWxlcyk7XG5cdFx0XHRyZXR1cm4geyBhbGxGaWxlczogQXJyYXkuZnJvbShlbmFibGVkQnlNYW5pZmVzdCksIGVuYWJsZWRCeU1hbmlmZXN0IH07XG5cdFx0fVxuXG5cdFx0Y29uc3QgY29udmVudGlvbkRpciA9IGpvaW4ocGFja2FnZVJvb3QsIHJlc291cmNlVHlwZSk7XG5cdFx0aWYgKCFleGlzdHNTeW5jKGNvbnZlbnRpb25EaXIpKSB7XG5cdFx0XHRyZXR1cm4geyBhbGxGaWxlczogW10sIGVuYWJsZWRCeU1hbmlmZXN0OiBuZXcgU2V0KCkgfTtcblx0XHR9XG5cdFx0Y29uc3QgYWxsRmlsZXMgPSBjb2xsZWN0UmVzb3VyY2VGaWxlcyhjb252ZW50aW9uRGlyLCByZXNvdXJjZVR5cGUpO1xuXHRcdHJldHVybiB7IGFsbEZpbGVzLCBlbmFibGVkQnlNYW5pZmVzdDogbmV3IFNldChhbGxGaWxlcykgfTtcblx0fVxuXG5cdHByaXZhdGUgcmVhZFBpTWFuaWZlc3QocGFja2FnZVJvb3Q6IHN0cmluZyk6IFBpTWFuaWZlc3QgfCBudWxsIHtcblx0XHRjb25zdCBwYWNrYWdlSnNvblBhdGggPSBqb2luKHBhY2thZ2VSb290LCBcInBhY2thZ2UuanNvblwiKTtcblx0XHRpZiAoIWV4aXN0c1N5bmMocGFja2FnZUpzb25QYXRoKSkge1xuXHRcdFx0cmV0dXJuIG51bGw7XG5cdFx0fVxuXG5cdFx0dHJ5IHtcblx0XHRcdGNvbnN0IGNvbnRlbnQgPSByZWFkRmlsZVN5bmMocGFja2FnZUpzb25QYXRoLCBcInV0Zi04XCIpO1xuXHRcdFx0Y29uc3QgcGtnID0gSlNPTi5wYXJzZShjb250ZW50KSBhcyB7IHBpPzogUGlNYW5pZmVzdCB9O1xuXHRcdFx0cmV0dXJuIHBrZy5waSA/PyBudWxsO1xuXHRcdH0gY2F0Y2gge1xuXHRcdFx0cmV0dXJuIG51bGw7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBhZGRNYW5pZmVzdEVudHJpZXMoXG5cdFx0ZW50cmllczogc3RyaW5nW10gfCB1bmRlZmluZWQsXG5cdFx0cm9vdDogc3RyaW5nLFxuXHRcdHJlc291cmNlVHlwZTogUmVzb3VyY2VUeXBlLFxuXHRcdHRhcmdldDogTWFwPHN0cmluZywgeyBtZXRhZGF0YTogUGF0aE1ldGFkYXRhOyBlbmFibGVkOiBib29sZWFuIH0+LFxuXHRcdG1ldGFkYXRhOiBQYXRoTWV0YWRhdGEsXG5cdCk6IHZvaWQge1xuXHRcdGlmICghZW50cmllcykgcmV0dXJuO1xuXG5cdFx0Y29uc3QgYWxsRmlsZXMgPSB0aGlzLmNvbGxlY3RGaWxlc0Zyb21NYW5pZmVzdEVudHJpZXMoZW50cmllcywgcm9vdCwgcmVzb3VyY2VUeXBlKTtcblx0XHRjb25zdCBwYXR0ZXJucyA9IGVudHJpZXMuZmlsdGVyKGlzUGF0dGVybik7XG5cdFx0Y29uc3QgZW5hYmxlZFBhdGhzID0gYXBwbHlQYXR0ZXJucyhhbGxGaWxlcywgcGF0dGVybnMsIHJvb3QpO1xuXG5cdFx0Zm9yIChjb25zdCBmIG9mIGFsbEZpbGVzKSB7XG5cdFx0XHRpZiAoZW5hYmxlZFBhdGhzLmhhcyhmKSkge1xuXHRcdFx0XHR0aGlzLmFkZFJlc291cmNlKHRhcmdldCwgZiwgbWV0YWRhdGEsIHRydWUpO1xuXHRcdFx0fVxuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgY29sbGVjdEZpbGVzRnJvbU1hbmlmZXN0RW50cmllcyhlbnRyaWVzOiBzdHJpbmdbXSwgcm9vdDogc3RyaW5nLCByZXNvdXJjZVR5cGU6IFJlc291cmNlVHlwZSk6IHN0cmluZ1tdIHtcblx0XHRjb25zdCBwbGFpbiA9IGVudHJpZXMuZmlsdGVyKChlbnRyeSkgPT4gIWlzUGF0dGVybihlbnRyeSkpO1xuXHRcdGNvbnN0IHJlc29sdmVkID0gcGxhaW4ubWFwKChlbnRyeSkgPT4gcmVzb2x2ZShyb290LCBlbnRyeSkpO1xuXHRcdHJldHVybiB0aGlzLmNvbGxlY3RGaWxlc0Zyb21QYXRocyhyZXNvbHZlZCwgcmVzb3VyY2VUeXBlKTtcblx0fVxuXG5cdHByaXZhdGUgcmVzb2x2ZUxvY2FsRW50cmllcyhcblx0XHRlbnRyaWVzOiBzdHJpbmdbXSxcblx0XHRyZXNvdXJjZVR5cGU6IFJlc291cmNlVHlwZSxcblx0XHR0YXJnZXQ6IE1hcDxzdHJpbmcsIHsgbWV0YWRhdGE6IFBhdGhNZXRhZGF0YTsgZW5hYmxlZDogYm9vbGVhbiB9Pixcblx0XHRtZXRhZGF0YTogUGF0aE1ldGFkYXRhLFxuXHRcdGJhc2VEaXI6IHN0cmluZyxcblx0KTogdm9pZCB7XG5cdFx0aWYgKGVudHJpZXMubGVuZ3RoID09PSAwKSByZXR1cm47XG5cblx0XHQvLyBDb2xsZWN0IGFsbCBmaWxlcyBmcm9tIHBsYWluIGVudHJpZXMgKG5vbi1wYXR0ZXJuIGVudHJpZXMpXG5cdFx0Y29uc3QgeyBwbGFpbiwgcGF0dGVybnMgfSA9IHNwbGl0UGF0dGVybnMoZW50cmllcyk7XG5cdFx0Y29uc3QgcmVzb2x2ZWRQbGFpbiA9IHBsYWluLm1hcCgocCkgPT4gdGhpcy5yZXNvbHZlUGF0aEZyb21CYXNlKHAsIGJhc2VEaXIpKTtcblx0XHRjb25zdCBhbGxGaWxlcyA9IHRoaXMuY29sbGVjdEZpbGVzRnJvbVBhdGhzKHJlc29sdmVkUGxhaW4sIHJlc291cmNlVHlwZSk7XG5cblx0XHQvLyBEZXRlcm1pbmUgd2hpY2ggZmlsZXMgYXJlIGVuYWJsZWQgYmFzZWQgb24gcGF0dGVybnNcblx0XHRjb25zdCBlbmFibGVkUGF0aHMgPSBhcHBseVBhdHRlcm5zKGFsbEZpbGVzLCBwYXR0ZXJucywgYmFzZURpcik7XG5cblx0XHQvLyBBZGQgYWxsIGZpbGVzIHdpdGggdGhlaXIgZW5hYmxlZCBzdGF0ZVxuXHRcdGZvciAoY29uc3QgZiBvZiBhbGxGaWxlcykge1xuXHRcdFx0dGhpcy5hZGRSZXNvdXJjZSh0YXJnZXQsIGYsIG1ldGFkYXRhLCBlbmFibGVkUGF0aHMuaGFzKGYpKTtcblx0XHR9XG5cdH1cblxuXHQvKipcblx0ICogQmF0Y2gtZGlzY292ZXIgd2hpY2ggcmVzb3VyY2Ugc3ViZGlyZWN0b3JpZXMgZXhpc3QgdW5kZXIgYSBwYXJlbnQgZGlyLlxuXHQgKiBBIHNpbmdsZSByZWFkZGlyU3luYyByZXBsYWNlcyA0IHNlcGFyYXRlIGV4aXN0c1N5bmMgcHJvYmVzLCByZWR1Y2luZ1xuXHQgKiBzeXNjYWxscyBkdXJpbmcgc3RhcnR1cC5cblx0ICovXG5cdHByaXZhdGUgZGlzY292ZXJSZXNvdXJjZVN1YmRpcnMoYmFzZURpcjogc3RyaW5nKTogU2V0PHN0cmluZz4ge1xuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBlbnRyaWVzID0gcmVhZGRpclN5bmMoYmFzZURpciwgeyB3aXRoRmlsZVR5cGVzOiB0cnVlIH0pO1xuXHRcdFx0Y29uc3QgbmFtZXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcblx0XHRcdGZvciAoY29uc3QgZSBvZiBlbnRyaWVzKSB7XG5cdFx0XHRcdGlmIChlLmlzRGlyZWN0b3J5KCkgfHwgZS5pc1N5bWJvbGljTGluaygpKSB7XG5cdFx0XHRcdFx0bmFtZXMuYWRkKGUubmFtZSk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHRcdHJldHVybiBuYW1lcztcblx0XHR9IGNhdGNoIHtcblx0XHRcdHJldHVybiBuZXcgU2V0KCk7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBhZGRBdXRvRGlzY292ZXJlZFJlc291cmNlcyhcblx0XHRhY2N1bXVsYXRvcjogUmVzb3VyY2VBY2N1bXVsYXRvcixcblx0XHRnbG9iYWxTZXR0aW5nczogUmV0dXJuVHlwZTxTZXR0aW5nc01hbmFnZXJbXCJnZXRHbG9iYWxTZXR0aW5nc1wiXT4sXG5cdFx0cHJvamVjdFNldHRpbmdzOiBSZXR1cm5UeXBlPFNldHRpbmdzTWFuYWdlcltcImdldFByb2plY3RTZXR0aW5nc1wiXT4sXG5cdFx0Z2xvYmFsQmFzZURpcjogc3RyaW5nLFxuXHRcdHByb2plY3RCYXNlRGlyOiBzdHJpbmcsXG5cdCk6IHZvaWQge1xuXHRcdGNvbnN0IHVzZXJNZXRhZGF0YTogUGF0aE1ldGFkYXRhID0ge1xuXHRcdFx0c291cmNlOiBcImF1dG9cIixcblx0XHRcdHNjb3BlOiBcInVzZXJcIixcblx0XHRcdG9yaWdpbjogXCJ0b3AtbGV2ZWxcIixcblx0XHRcdGJhc2VEaXI6IGdsb2JhbEJhc2VEaXIsXG5cdFx0fTtcblx0XHRjb25zdCBwcm9qZWN0TWV0YWRhdGE6IFBhdGhNZXRhZGF0YSA9IHtcblx0XHRcdHNvdXJjZTogXCJhdXRvXCIsXG5cdFx0XHRzY29wZTogXCJwcm9qZWN0XCIsXG5cdFx0XHRvcmlnaW46IFwidG9wLWxldmVsXCIsXG5cdFx0XHRiYXNlRGlyOiBwcm9qZWN0QmFzZURpcixcblx0XHR9O1xuXG5cdFx0Y29uc3QgdXNlck92ZXJyaWRlcyA9IHtcblx0XHRcdGV4dGVuc2lvbnM6IChnbG9iYWxTZXR0aW5ncy5leHRlbnNpb25zID8/IFtdKSBhcyBzdHJpbmdbXSxcblx0XHRcdHNraWxsczogKGdsb2JhbFNldHRpbmdzLnNraWxscyA/PyBbXSkgYXMgc3RyaW5nW10sXG5cdFx0XHRwcm9tcHRzOiAoZ2xvYmFsU2V0dGluZ3MucHJvbXB0cyA/PyBbXSkgYXMgc3RyaW5nW10sXG5cdFx0XHR0aGVtZXM6IChnbG9iYWxTZXR0aW5ncy50aGVtZXMgPz8gW10pIGFzIHN0cmluZ1tdLFxuXHRcdH07XG5cdFx0Y29uc3QgcHJvamVjdE92ZXJyaWRlcyA9IHtcblx0XHRcdGV4dGVuc2lvbnM6IChwcm9qZWN0U2V0dGluZ3MuZXh0ZW5zaW9ucyA/PyBbXSkgYXMgc3RyaW5nW10sXG5cdFx0XHRza2lsbHM6IChwcm9qZWN0U2V0dGluZ3Muc2tpbGxzID8/IFtdKSBhcyBzdHJpbmdbXSxcblx0XHRcdHByb21wdHM6IChwcm9qZWN0U2V0dGluZ3MucHJvbXB0cyA/PyBbXSkgYXMgc3RyaW5nW10sXG5cdFx0XHR0aGVtZXM6IChwcm9qZWN0U2V0dGluZ3MudGhlbWVzID8/IFtdKSBhcyBzdHJpbmdbXSxcblx0XHR9O1xuXG5cdFx0Ly8gQmF0Y2ggZGlyZWN0b3J5IGRpc2NvdmVyeTogb25lIHJlYWRkaXIgb2YgZWFjaCBwYXJlbnQgcmVwbGFjZXMgdXAgdG9cblx0XHQvLyA0IHNlcGFyYXRlIGV4aXN0c1N5bmMgY2FsbHMgcGVyIGJhc2UgZGlyZWN0b3J5LCBjdXR0aW5nIHN5c2NhbGxzLlxuXHRcdGNvbnN0IHByb2plY3RTdWJkaXJzID0gdGhpcy5kaXNjb3ZlclJlc291cmNlU3ViZGlycyhwcm9qZWN0QmFzZURpcik7XG5cdFx0Y29uc3QgdXNlclN1YmRpcnMgPSB0aGlzLmRpc2NvdmVyUmVzb3VyY2VTdWJkaXJzKGdsb2JhbEJhc2VEaXIpO1xuXG5cdFx0Y29uc3QgdXNlckRpcnMgPSB7XG5cdFx0XHRleHRlbnNpb25zOiBqb2luKGdsb2JhbEJhc2VEaXIsIFwiZXh0ZW5zaW9uc1wiKSxcblx0XHRcdHNraWxsczogam9pbihnbG9iYWxCYXNlRGlyLCBcInNraWxsc1wiKSxcblx0XHRcdHByb21wdHM6IGpvaW4oZ2xvYmFsQmFzZURpciwgXCJwcm9tcHRzXCIpLFxuXHRcdFx0dGhlbWVzOiBqb2luKGdsb2JhbEJhc2VEaXIsIFwidGhlbWVzXCIpLFxuXHRcdH07XG5cdFx0Y29uc3QgcHJvamVjdERpcnMgPSB7XG5cdFx0XHRleHRlbnNpb25zOiBqb2luKHByb2plY3RCYXNlRGlyLCBcImV4dGVuc2lvbnNcIiksXG5cdFx0XHRza2lsbHM6IGpvaW4ocHJvamVjdEJhc2VEaXIsIFwic2tpbGxzXCIpLFxuXHRcdFx0cHJvbXB0czogam9pbihwcm9qZWN0QmFzZURpciwgXCJwcm9tcHRzXCIpLFxuXHRcdFx0dGhlbWVzOiBqb2luKHByb2plY3RCYXNlRGlyLCBcInRoZW1lc1wiKSxcblx0XHR9O1xuXHRcdGNvbnN0IHVzZXJBZ2VudHNTa2lsbHNEaXIgPSBqb2luKGhvbWVkaXIoKSwgXCIuYWdlbnRzXCIsIFwic2tpbGxzXCIpO1xuXHRcdGNvbnN0IHByb2plY3RBZ2VudHNTa2lsbERpcnMgPSBjb2xsZWN0QW5jZXN0b3JBZ2VudHNTa2lsbERpcnModGhpcy5jd2QpLmZpbHRlcihcblx0XHRcdChkaXIpID0+IHJlc29sdmUoZGlyKSAhPT0gcmVzb2x2ZSh1c2VyQWdlbnRzU2tpbGxzRGlyKSxcblx0XHQpO1xuXG5cdFx0Y29uc3QgYWRkUmVzb3VyY2VzID0gKFxuXHRcdFx0cmVzb3VyY2VUeXBlOiBSZXNvdXJjZVR5cGUsXG5cdFx0XHRwYXRoczogc3RyaW5nW10sXG5cdFx0XHRtZXRhZGF0YTogUGF0aE1ldGFkYXRhLFxuXHRcdFx0b3ZlcnJpZGVzOiBzdHJpbmdbXSxcblx0XHRcdGJhc2VEaXI6IHN0cmluZyxcblx0XHQpID0+IHtcblx0XHRcdGNvbnN0IHRhcmdldCA9IHRoaXMuZ2V0VGFyZ2V0TWFwKGFjY3VtdWxhdG9yLCByZXNvdXJjZVR5cGUpO1xuXHRcdFx0Zm9yIChjb25zdCBwYXRoIG9mIHBhdGhzKSB7XG5cdFx0XHRcdGNvbnN0IGVuYWJsZWQgPSBpc0VuYWJsZWRCeU92ZXJyaWRlcyhwYXRoLCBvdmVycmlkZXMsIGJhc2VEaXIpO1xuXHRcdFx0XHR0aGlzLmFkZFJlc291cmNlKHRhcmdldCwgcGF0aCwgbWV0YWRhdGEsIGVuYWJsZWQpO1xuXHRcdFx0fVxuXHRcdH07XG5cblx0XHQvLyBQcm9qZWN0IHJlc291cmNlcyBcdTIwMTQgc2tpcCBjb2xsZWN0IGNhbGxzIHdoZW4gdGhlIHBhcmVudCByZWFkZGlyIHNob3dzXG5cdFx0Ly8gdGhlIHN1YmRpcmVjdG9yeSBkb2Vzbid0IGV4aXN0IChhdm9pZHMgcmVkdW5kYW50IGV4aXN0c1N5bmMgKyByZWFkZGlyU3luYykuXG5cdFx0aWYgKHByb2plY3RTdWJkaXJzLmhhcyhcImV4dGVuc2lvbnNcIikpIHtcblx0XHRcdGFkZFJlc291cmNlcyhcblx0XHRcdFx0XCJleHRlbnNpb25zXCIsXG5cdFx0XHRcdGNvbGxlY3RBdXRvRXh0ZW5zaW9uRW50cmllcyhwcm9qZWN0RGlycy5leHRlbnNpb25zKSxcblx0XHRcdFx0cHJvamVjdE1ldGFkYXRhLFxuXHRcdFx0XHRwcm9qZWN0T3ZlcnJpZGVzLmV4dGVuc2lvbnMsXG5cdFx0XHRcdHByb2plY3RCYXNlRGlyLFxuXHRcdFx0KTtcblx0XHR9XG5cdFx0e1xuXHRcdFx0Y29uc3Qgc2tpbGxFbnRyaWVzID0gW1xuXHRcdFx0XHQuLi4ocHJvamVjdFN1YmRpcnMuaGFzKFwic2tpbGxzXCIpID8gY29sbGVjdEF1dG9Ta2lsbEVudHJpZXMocHJvamVjdERpcnMuc2tpbGxzKSA6IFtdKSxcblx0XHRcdFx0Li4ucHJvamVjdEFnZW50c1NraWxsRGlycy5mbGF0TWFwKChkaXIpID0+IGNvbGxlY3RBdXRvU2tpbGxFbnRyaWVzKGRpcikpLFxuXHRcdFx0XTtcblx0XHRcdGlmIChza2lsbEVudHJpZXMubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRhZGRSZXNvdXJjZXMoXCJza2lsbHNcIiwgc2tpbGxFbnRyaWVzLCBwcm9qZWN0TWV0YWRhdGEsIHByb2plY3RPdmVycmlkZXMuc2tpbGxzLCBwcm9qZWN0QmFzZURpcik7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdGlmIChwcm9qZWN0U3ViZGlycy5oYXMoXCJwcm9tcHRzXCIpKSB7XG5cdFx0XHRhZGRSZXNvdXJjZXMoXG5cdFx0XHRcdFwicHJvbXB0c1wiLFxuXHRcdFx0XHRjb2xsZWN0QXV0b1Byb21wdEVudHJpZXMocHJvamVjdERpcnMucHJvbXB0cyksXG5cdFx0XHRcdHByb2plY3RNZXRhZGF0YSxcblx0XHRcdFx0cHJvamVjdE92ZXJyaWRlcy5wcm9tcHRzLFxuXHRcdFx0XHRwcm9qZWN0QmFzZURpcixcblx0XHRcdCk7XG5cdFx0fVxuXHRcdGlmIChwcm9qZWN0U3ViZGlycy5oYXMoXCJ0aGVtZXNcIikpIHtcblx0XHRcdGFkZFJlc291cmNlcyhcblx0XHRcdFx0XCJ0aGVtZXNcIixcblx0XHRcdFx0Y29sbGVjdEF1dG9UaGVtZUVudHJpZXMocHJvamVjdERpcnMudGhlbWVzKSxcblx0XHRcdFx0cHJvamVjdE1ldGFkYXRhLFxuXHRcdFx0XHRwcm9qZWN0T3ZlcnJpZGVzLnRoZW1lcyxcblx0XHRcdFx0cHJvamVjdEJhc2VEaXIsXG5cdFx0XHQpO1xuXHRcdH1cblxuXHRcdC8vIFVzZXIgKGdsb2JhbCkgcmVzb3VyY2VzXG5cdFx0aWYgKHVzZXJTdWJkaXJzLmhhcyhcImV4dGVuc2lvbnNcIikpIHtcblx0XHRcdGFkZFJlc291cmNlcyhcblx0XHRcdFx0XCJleHRlbnNpb25zXCIsXG5cdFx0XHRcdGNvbGxlY3RBdXRvRXh0ZW5zaW9uRW50cmllcyh1c2VyRGlycy5leHRlbnNpb25zKSxcblx0XHRcdFx0dXNlck1ldGFkYXRhLFxuXHRcdFx0XHR1c2VyT3ZlcnJpZGVzLmV4dGVuc2lvbnMsXG5cdFx0XHRcdGdsb2JhbEJhc2VEaXIsXG5cdFx0XHQpO1xuXHRcdH1cblx0XHR7XG5cdFx0XHQvLyBFY29zeXN0ZW0gc2tpbGxzICh+Ly5hZ2VudHMvc2tpbGxzLykgdGFrZSBwcmlvcml0eSBvdmVyIGxlZ2FjeSBjb25maWctZGlyIHNraWxscy5cblx0XHRcdC8vIFNraXAgbGVnYWN5IGRpciBlbnRpcmVseSB3aGVuIG1pZ3JhdGlvbiBoYXMgY29tcGxldGVkIChtYXJrZXIgZmlsZSBwcmVzZW50KS5cblx0XHRcdGNvbnN0IGxlZ2FjeVNraWxsc01pZ3JhdGVkID1cblx0XHRcdFx0cmVzb2x2ZSh1c2VyRGlycy5za2lsbHMpICE9PSByZXNvbHZlKHVzZXJBZ2VudHNTa2lsbHNEaXIpICYmXG5cdFx0XHRcdGV4aXN0c1N5bmMoam9pbih1c2VyRGlycy5za2lsbHMsIFwiLm1pZ3JhdGVkLXRvLWFnZW50c1wiKSk7XG5cdFx0XHRjb25zdCBsZWdhY3lVc2VyU2tpbGxFbnRyaWVzID1cblx0XHRcdFx0IWxlZ2FjeVNraWxsc01pZ3JhdGVkICYmIHVzZXJTdWJkaXJzLmhhcyhcInNraWxsc1wiKVxuXHRcdFx0XHRcdD8gY29sbGVjdEF1dG9Ta2lsbEVudHJpZXModXNlckRpcnMuc2tpbGxzKVxuXHRcdFx0XHRcdDogW107XG5cdFx0XHRjb25zdCBza2lsbEVudHJpZXMgPSBbXG5cdFx0XHRcdC4uLmNvbGxlY3RBdXRvU2tpbGxFbnRyaWVzKHVzZXJBZ2VudHNTa2lsbHNEaXIpLFxuXHRcdFx0XHQuLi5sZWdhY3lVc2VyU2tpbGxFbnRyaWVzLFxuXHRcdFx0XTtcblx0XHRcdGlmIChza2lsbEVudHJpZXMubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRhZGRSZXNvdXJjZXMoXCJza2lsbHNcIiwgc2tpbGxFbnRyaWVzLCB1c2VyTWV0YWRhdGEsIHVzZXJPdmVycmlkZXMuc2tpbGxzLCBnbG9iYWxCYXNlRGlyKTtcblx0XHRcdH1cblx0XHR9XG5cdFx0aWYgKHVzZXJTdWJkaXJzLmhhcyhcInByb21wdHNcIikpIHtcblx0XHRcdGFkZFJlc291cmNlcyhcblx0XHRcdFx0XCJwcm9tcHRzXCIsXG5cdFx0XHRcdGNvbGxlY3RBdXRvUHJvbXB0RW50cmllcyh1c2VyRGlycy5wcm9tcHRzKSxcblx0XHRcdFx0dXNlck1ldGFkYXRhLFxuXHRcdFx0XHR1c2VyT3ZlcnJpZGVzLnByb21wdHMsXG5cdFx0XHRcdGdsb2JhbEJhc2VEaXIsXG5cdFx0XHQpO1xuXHRcdH1cblx0XHRpZiAodXNlclN1YmRpcnMuaGFzKFwidGhlbWVzXCIpKSB7XG5cdFx0XHRhZGRSZXNvdXJjZXMoXG5cdFx0XHRcdFwidGhlbWVzXCIsXG5cdFx0XHRcdGNvbGxlY3RBdXRvVGhlbWVFbnRyaWVzKHVzZXJEaXJzLnRoZW1lcyksXG5cdFx0XHRcdHVzZXJNZXRhZGF0YSxcblx0XHRcdFx0dXNlck92ZXJyaWRlcy50aGVtZXMsXG5cdFx0XHRcdGdsb2JhbEJhc2VEaXIsXG5cdFx0XHQpO1xuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgY29sbGVjdEZpbGVzRnJvbVBhdGhzKHBhdGhzOiBzdHJpbmdbXSwgcmVzb3VyY2VUeXBlOiBSZXNvdXJjZVR5cGUpOiBzdHJpbmdbXSB7XG5cdFx0Y29uc3QgZmlsZXM6IHN0cmluZ1tdID0gW107XG5cdFx0Zm9yIChjb25zdCBwIG9mIHBhdGhzKSB7XG5cdFx0XHRpZiAoIWV4aXN0c1N5bmMocCkpIGNvbnRpbnVlO1xuXG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCBzdGF0cyA9IHN0YXRTeW5jKHApO1xuXHRcdFx0XHRpZiAoc3RhdHMuaXNGaWxlKCkpIHtcblx0XHRcdFx0XHRmaWxlcy5wdXNoKHApO1xuXHRcdFx0XHR9IGVsc2UgaWYgKHN0YXRzLmlzRGlyZWN0b3J5KCkpIHtcblx0XHRcdFx0XHRmaWxlcy5wdXNoKC4uLmNvbGxlY3RSZXNvdXJjZUZpbGVzKHAsIHJlc291cmNlVHlwZSkpO1xuXHRcdFx0XHR9XG5cdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0Ly8gSWdub3JlIGVycm9yc1xuXHRcdFx0fVxuXHRcdH1cblx0XHRyZXR1cm4gZmlsZXM7XG5cdH1cblxuXHRwcml2YXRlIGdldFRhcmdldE1hcChcblx0XHRhY2N1bXVsYXRvcjogUmVzb3VyY2VBY2N1bXVsYXRvcixcblx0XHRyZXNvdXJjZVR5cGU6IFJlc291cmNlVHlwZSxcblx0KTogTWFwPHN0cmluZywgeyBtZXRhZGF0YTogUGF0aE1ldGFkYXRhOyBlbmFibGVkOiBib29sZWFuIH0+IHtcblx0XHRzd2l0Y2ggKHJlc291cmNlVHlwZSkge1xuXHRcdFx0Y2FzZSBcImV4dGVuc2lvbnNcIjpcblx0XHRcdFx0cmV0dXJuIGFjY3VtdWxhdG9yLmV4dGVuc2lvbnM7XG5cdFx0XHRjYXNlIFwic2tpbGxzXCI6XG5cdFx0XHRcdHJldHVybiBhY2N1bXVsYXRvci5za2lsbHM7XG5cdFx0XHRjYXNlIFwicHJvbXB0c1wiOlxuXHRcdFx0XHRyZXR1cm4gYWNjdW11bGF0b3IucHJvbXB0cztcblx0XHRcdGNhc2UgXCJ0aGVtZXNcIjpcblx0XHRcdFx0cmV0dXJuIGFjY3VtdWxhdG9yLnRoZW1lcztcblx0XHRcdGRlZmF1bHQ6XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcihgVW5rbm93biByZXNvdXJjZSB0eXBlOiAke3Jlc291cmNlVHlwZX1gKTtcblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIGFkZFJlc291cmNlKFxuXHRcdG1hcDogTWFwPHN0cmluZywgeyBtZXRhZGF0YTogUGF0aE1ldGFkYXRhOyBlbmFibGVkOiBib29sZWFuIH0+LFxuXHRcdHBhdGg6IHN0cmluZyxcblx0XHRtZXRhZGF0YTogUGF0aE1ldGFkYXRhLFxuXHRcdGVuYWJsZWQ6IGJvb2xlYW4sXG5cdCk6IHZvaWQge1xuXHRcdGlmICghcGF0aCkgcmV0dXJuO1xuXHRcdGlmICghbWFwLmhhcyhwYXRoKSkge1xuXHRcdFx0bWFwLnNldChwYXRoLCB7IG1ldGFkYXRhLCBlbmFibGVkIH0pO1xuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgY3JlYXRlQWNjdW11bGF0b3IoKTogUmVzb3VyY2VBY2N1bXVsYXRvciB7XG5cdFx0cmV0dXJuIHtcblx0XHRcdGV4dGVuc2lvbnM6IG5ldyBNYXAoKSxcblx0XHRcdHNraWxsczogbmV3IE1hcCgpLFxuXHRcdFx0cHJvbXB0czogbmV3IE1hcCgpLFxuXHRcdFx0dGhlbWVzOiBuZXcgTWFwKCksXG5cdFx0fTtcblx0fVxuXG5cdHByaXZhdGUgdG9SZXNvbHZlZFBhdGhzKGFjY3VtdWxhdG9yOiBSZXNvdXJjZUFjY3VtdWxhdG9yKTogUmVzb2x2ZWRQYXRocyB7XG5cdFx0Y29uc3QgdG9SZXNvbHZlZCA9IChlbnRyaWVzOiBNYXA8c3RyaW5nLCB7IG1ldGFkYXRhOiBQYXRoTWV0YWRhdGE7IGVuYWJsZWQ6IGJvb2xlYW4gfT4pOiBSZXNvbHZlZFJlc291cmNlW10gPT4ge1xuXHRcdFx0cmV0dXJuIEFycmF5LmZyb20oZW50cmllcy5lbnRyaWVzKCkpLm1hcCgoW3BhdGgsIHsgbWV0YWRhdGEsIGVuYWJsZWQgfV0pID0+ICh7XG5cdFx0XHRcdHBhdGgsXG5cdFx0XHRcdGVuYWJsZWQsXG5cdFx0XHRcdG1ldGFkYXRhLFxuXHRcdFx0fSkpO1xuXHRcdH07XG5cblx0XHRyZXR1cm4ge1xuXHRcdFx0ZXh0ZW5zaW9uczogdG9SZXNvbHZlZChhY2N1bXVsYXRvci5leHRlbnNpb25zKSxcblx0XHRcdHNraWxsczogdG9SZXNvbHZlZChhY2N1bXVsYXRvci5za2lsbHMpLFxuXHRcdFx0cHJvbXB0czogdG9SZXNvbHZlZChhY2N1bXVsYXRvci5wcm9tcHRzKSxcblx0XHRcdHRoZW1lczogdG9SZXNvbHZlZChhY2N1bXVsYXRvci50aGVtZXMpLFxuXHRcdH07XG5cdH1cblxuXHRwcml2YXRlIHJ1bkNvbW1hbmQoY29tbWFuZDogc3RyaW5nLCBhcmdzOiBzdHJpbmdbXSwgb3B0aW9ucz86IHsgY3dkPzogc3RyaW5nIH0pOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRyZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmVQcm9taXNlLCByZWplY3QpID0+IHtcblx0XHRcdGNvbnN0IGNoaWxkID0gc3Bhd24oY29tbWFuZCwgYXJncywge1xuXHRcdFx0XHRjd2Q6IG9wdGlvbnM/LmN3ZCxcblx0XHRcdFx0c3RkaW86IFwiaW5oZXJpdFwiLFxuXHRcdFx0XHRzaGVsbDogcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiLFxuXHRcdFx0fSk7XG5cdFx0XHRjaGlsZC5vbihcImVycm9yXCIsIHJlamVjdCk7XG5cdFx0XHRjaGlsZC5vbihcImV4aXRcIiwgKGNvZGUpID0+IHtcblx0XHRcdFx0aWYgKGNvZGUgPT09IDApIHtcblx0XHRcdFx0XHRyZXNvbHZlUHJvbWlzZSgpO1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdHJlamVjdChuZXcgRXJyb3IoYCR7Y29tbWFuZH0gJHthcmdzLmpvaW4oXCIgXCIpfSBmYWlsZWQgd2l0aCBjb2RlICR7Y29kZX1gKSk7XG5cdFx0XHRcdH1cblx0XHRcdH0pO1xuXHRcdH0pO1xuXHR9XG5cblx0cHJpdmF0ZSBydW5Db21tYW5kU3luYyhjb21tYW5kOiBzdHJpbmcsIGFyZ3M6IHN0cmluZ1tdKTogc3RyaW5nIHtcblx0XHRjb25zdCByZXN1bHQgPSBzcGF3blN5bmMoY29tbWFuZCwgYXJncywge1xuXHRcdFx0c3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdLFxuXHRcdFx0ZW5jb2Rpbmc6IFwidXRmLThcIixcblx0XHRcdHNoZWxsOiBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIsXG5cdFx0fSk7XG5cdFx0aWYgKHJlc3VsdC5zdGF0dXMgIT09IDApIHtcblx0XHRcdHRocm93IG5ldyBFcnJvcihgRmFpbGVkIHRvIHJ1biAke2NvbW1hbmR9ICR7YXJncy5qb2luKFwiIFwiKX06ICR7cmVzdWx0LnN0ZGVyciB8fCByZXN1bHQuc3Rkb3V0fWApO1xuXHRcdH1cblx0XHRyZXR1cm4gKHJlc3VsdC5zdGRvdXQgfHwgcmVzdWx0LnN0ZGVyciB8fCBcIlwiKS50cmltKCk7XG5cdH1cbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFNBQVMsT0FBTyxpQkFBaUI7QUFDakMsU0FBUyxrQkFBa0I7QUFDM0IsU0FBUyxZQUFZLFdBQVcsYUFBYSxjQUFjLFFBQVEsVUFBVSxxQkFBcUI7QUFDbEcsU0FBUyxTQUFTLGNBQWM7QUFDaEMsU0FBUyxVQUFVLFNBQVMsTUFBTSxVQUFVLGVBQW9CO0FBQ2hFLE9BQU8sWUFBWTtBQUNuQixTQUFTLGlCQUFpQjtBQUMxQixTQUFTLHVCQUF1QjtBQUNoQyxTQUF5QixtQkFBbUI7QUFDNUMsU0FB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
