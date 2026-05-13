import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareSemver } from "./update-check.js";
import { discoverExtensionEntryPaths } from "./extension-discovery.js";
import { loadRegistry, readManifestFromEntryPath, isExtensionEnabled, ensureRegistryEntries } from "./extension-registry.js";
import { resolveBundledResourcesDirFromPackageRoot } from "./bundled-resource-path.js";
let piCodingAgentModulePromise;
function loadPiCodingAgentModule() {
  return piCodingAgentModulePromise ??= import("@gsd/pi-coding-agent");
}
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resourcesDir = resolveBundledResourcesDirFromPackageRoot(packageRoot);
const bundledExtensionsDir = join(resourcesDir, "extensions");
const resourceVersionManifestName = "managed-resources.json";
const resourceFingerprintFileName = ".managed-resources-content-hash";
import { discoverExtensionEntryPaths as discoverExtensionEntryPaths2 } from "./extension-discovery.js";
function getExtensionKey(entryPath, extensionsDir) {
  const relPath = relative(extensionsDir, entryPath);
  return relPath.split(/[\\/]/)[0].replace(/\.(?:ts|js)$/, "");
}
function stripSemverBuildMetadata(version) {
  return version.trim().replace(/^v/, "").split(/[+-]/, 1)[0] || "0.0.0";
}
function getManagedResourceManifestPath(agentDir) {
  return join(agentDir, resourceVersionManifestName);
}
function getBundledGsdVersion() {
  if (process.env.GSD_VERSION && process.env.GSD_VERSION !== "0.0.0") {
    return process.env.GSD_VERSION;
  }
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf-8"));
    return typeof pkg?.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
function writeManagedResourceManifest(agentDir) {
  let installedExtensionRootFiles = [];
  let installedExtensionDirs = [];
  try {
    if (existsSync(bundledExtensionsDir)) {
      const entries = readdirSync(bundledExtensionsDir, { withFileTypes: true });
      installedExtensionRootFiles = entries.filter((e) => e.isFile()).map((e) => e.name);
      installedExtensionDirs = entries.filter((e) => e.isDirectory()).filter((e) => {
        const dirPath = join(bundledExtensionsDir, e.name);
        return existsSync(join(dirPath, "index.js")) || existsSync(join(dirPath, "index.ts")) || existsSync(join(dirPath, "extension-manifest.json"));
      }).map((e) => e.name);
    }
  } catch {
  }
  const manifest = {
    gsdVersion: getBundledGsdVersion(),
    syncedAt: Date.now(),
    contentHash: getCurrentResourceFingerprint(),
    installedExtensionRootFiles,
    installedExtensionDirs
  };
  writeFileSync(getManagedResourceManifestPath(agentDir), JSON.stringify(manifest));
}
function readManagedResourceVersion(agentDir) {
  try {
    const manifest = JSON.parse(readFileSync(getManagedResourceManifestPath(agentDir), "utf-8"));
    return typeof manifest?.gsdVersion === "string" ? manifest.gsdVersion : null;
  } catch {
    return null;
  }
}
function readManagedResourceManifest(agentDir) {
  try {
    return JSON.parse(readFileSync(getManagedResourceManifestPath(agentDir), "utf-8"));
  } catch {
    return null;
  }
}
function computeResourceFingerprint(rootDir = resourcesDir) {
  const entries = [];
  collectFileEntries(rootDir, rootDir, entries);
  entries.sort();
  return createHash("sha256").update(entries.join("\n")).digest("hex").slice(0, 16);
}
function getCurrentResourceFingerprint() {
  try {
    const precomputed = readFileSync(join(resourcesDir, resourceFingerprintFileName), "utf-8").trim();
    if (/^[a-f0-9]{16}$/i.test(precomputed)) {
      return precomputed;
    }
  } catch {
  }
  return computeResourceFingerprint();
}
function collectFileEntries(dir, root, out) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === resourceFingerprintFileName) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFileEntries(fullPath, root, out);
    } else {
      const rel = relative(root, fullPath);
      let contentHash;
      try {
        contentHash = createHash("sha256").update(readFileSync(fullPath)).digest("hex");
      } catch {
        contentHash = "unreadable";
      }
      out.push(`${rel}:${contentHash}`);
    }
  }
}
function getNewerManagedResourceVersion(agentDir, currentVersion) {
  const managedVersion = readManagedResourceVersion(agentDir);
  if (!managedVersion) {
    return null;
  }
  return compareSemver(
    stripSemverBuildMetadata(managedVersion),
    stripSemverBuildMetadata(currentVersion)
  ) > 0 ? managedVersion : null;
}
function makeTreeWritable(dirPath) {
  if (!existsSync(dirPath)) return;
  const stats = lstatSync(dirPath);
  if (stats.isSymbolicLink()) return;
  const isDir = stats.isDirectory();
  const currentMode = stats.mode & 511;
  let newMode = currentMode | 128;
  if (isDir) {
    newMode |= 64;
  }
  if (newMode !== currentMode) {
    try {
      chmodSync(dirPath, newMode);
    } catch {
    }
  }
  if (isDir) {
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      const entryPath = join(dirPath, entry.name);
      makeTreeWritable(entryPath);
    }
  }
}
function syncResourceDir(srcDir, destDir) {
  makeTreeWritable(destDir);
  if (existsSync(srcDir)) {
    pruneStaleSiblingFiles(srcDir, destDir);
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const target = join(destDir, entry.name);
        if (existsSync(target)) rmSync(target, { recursive: true, force: true });
      }
    }
    try {
      cpSync(srcDir, destDir, { recursive: true, force: true });
    } catch {
      copyDirRecursive(srcDir, destDir);
    }
    makeTreeWritable(destDir);
  }
}
function pruneStaleSiblingFiles(srcDir, destDir) {
  if (!existsSync(destDir)) return;
  const sourceFiles = new Set(
    readdirSync(srcDir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name)
  );
  for (const entry of readdirSync(destDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (sourceFiles.has(entry.name)) continue;
    const sourceJsName = entry.name.replace(/\.ts$/, ".js");
    const sourceTsName = entry.name.replace(/\.js$/, ".ts");
    if (sourceFiles.has(sourceJsName) || sourceFiles.has(sourceTsName)) {
      rmSync(join(destDir, entry.name), { force: true });
    }
  }
}
function copyDirRecursive(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}
function ensureNodeModulesSymlink(agentDir) {
  const agentNodeModules = join(agentDir, "node_modules");
  const internalNodeModules = join(packageRoot, "node_modules");
  const hoistedNodeModules = dirname(packageRoot);
  const isGlobalInstall = basename(hoistedNodeModules) === "node_modules";
  if (!isGlobalInstall) {
    reconcileSymlink(agentNodeModules, internalNodeModules);
    return;
  }
  if (!hasMissingWorkspaceScopes(hoistedNodeModules, internalNodeModules)) {
    reconcileSymlink(agentNodeModules, hoistedNodeModules);
    return;
  }
  reconcileMergedNodeModules(agentNodeModules, hoistedNodeModules, internalNodeModules);
}
function hasMissingWorkspaceScopes(hoisted, internal) {
  if (!existsSync(internal)) return false;
  try {
    for (const entry of readdirSync(internal, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("@gsd") && !existsSync(join(hoisted, entry.name))) {
        return true;
      }
    }
  } catch {
  }
  return false;
}
function reconcileSymlink(link, target) {
  try {
    const stat = lstatSync(link);
    if (stat.isSymbolicLink()) {
      const existing = readlinkSync(link);
      if (existing === target && existsSync(link)) return;
      unlinkSync(link);
    } else {
      rmSync(link, { recursive: true, force: true });
    }
  } catch {
  }
  try {
    symlinkSync(target, link, "junction");
  } catch (err) {
    console.error(`[gsd] WARN: Failed to symlink ${link} \u2192 ${target}: ${err instanceof Error ? err.message : err}`);
  }
}
function reconcileMergedNodeModules(agentNodeModules, hoisted, internal) {
  const marker = join(agentNodeModules, ".gsd-merged");
  const fingerprint = mergedFingerprint(hoisted, internal);
  try {
    if (existsSync(marker) && readFileSync(marker, "utf-8").trim() === fingerprint) return;
  } catch {
  }
  try {
    const stat = lstatSync(agentNodeModules);
    if (stat.isSymbolicLink()) {
      unlinkSync(agentNodeModules);
    } else {
      rmSync(agentNodeModules, { recursive: true, force: true });
    }
  } catch {
  }
  mkdirSync(agentNodeModules, { recursive: true });
  let linkedCount = 0;
  try {
    for (const entry of readdirSync(hoisted, { withFileTypes: true })) {
      if (entry.name === basename(packageRoot)) continue;
      if (entry.name.startsWith(".")) continue;
      try {
        symlinkSync(join(hoisted, entry.name), join(agentNodeModules, entry.name), "junction");
        linkedCount++;
      } catch {
      }
    }
  } catch (err) {
    console.error(`[gsd] WARN: Failed to read hoisted node_modules at ${hoisted}: ${err instanceof Error ? err.message : err}`);
  }
  try {
    for (const entry of readdirSync(internal, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const link = join(agentNodeModules, entry.name);
      try {
        lstatSync(link);
        unlinkSync(link);
      } catch {
      }
      try {
        symlinkSync(join(internal, entry.name), link, "junction");
        linkedCount++;
      } catch {
      }
    }
  } catch (err) {
    console.error(`[gsd] WARN: Failed to read internal node_modules at ${internal}: ${err instanceof Error ? err.message : err}`);
  }
  if (linkedCount > 0) {
    try {
      writeFileSync(marker, fingerprint);
    } catch {
    }
  }
}
function mergedFingerprint(hoisted, internal) {
  try {
    const h = readdirSync(hoisted).sort().join(",");
    const i = readdirSync(internal).sort().join(",");
    return `${packageRoot}
${h}
${i}`;
  } catch {
    return packageRoot;
  }
}
function pruneRemovedBundledExtensions(manifest, agentDir) {
  const extensionsDir = join(agentDir, "extensions");
  if (!existsSync(extensionsDir)) return;
  const currentSourceFiles = /* @__PURE__ */ new Set();
  const currentSourceDirs = /* @__PURE__ */ new Set();
  try {
    if (existsSync(bundledExtensionsDir)) {
      for (const e of readdirSync(bundledExtensionsDir, { withFileTypes: true })) {
        if (e.isFile()) currentSourceFiles.add(e.name);
        if (e.isDirectory()) currentSourceDirs.add(e.name);
      }
    }
  } catch {
  }
  const removeFileIfStale = (fileName) => {
    if (currentSourceFiles.has(fileName)) return;
    const stale = join(extensionsDir, fileName);
    try {
      if (existsSync(stale)) rmSync(stale, { force: true });
    } catch {
    }
  };
  const removeDirIfStale = (dirName) => {
    if (currentSourceDirs.has(dirName)) return;
    const stale = join(extensionsDir, dirName);
    try {
      if (existsSync(stale)) rmSync(stale, { recursive: true, force: true });
    } catch {
    }
  };
  if (manifest?.installedExtensionRootFiles) {
    for (const prevFile of manifest.installedExtensionRootFiles) {
      removeFileIfStale(prevFile);
    }
  }
  if (manifest?.installedExtensionDirs) {
    for (const prevDir of manifest.installedExtensionDirs) {
      removeDirIfStale(prevDir);
    }
  }
  try {
    if (existsSync(extensionsDir)) {
      for (const e of readdirSync(extensionsDir, { withFileTypes: true })) {
        if (e.isDirectory()) removeDirIfStale(e.name);
      }
    }
  } catch {
  }
  removeFileIfStale("env-utils.js");
}
function initResources(agentDir, skillsDir = join(homedir(), ".agents", "skills")) {
  mkdirSync(agentDir, { recursive: true });
  const currentVersion = getBundledGsdVersion();
  const manifest = readManagedResourceManifest(agentDir);
  const extensionsDir = join(agentDir, "extensions");
  pruneRemovedBundledExtensions(manifest, agentDir);
  pruneStaleSiblingFiles(bundledExtensionsDir, extensionsDir);
  ensureNodeModulesSymlink(agentDir);
  migrateSkillsToEcosystemDir(agentDir);
  if (manifest && manifest.gsdVersion === currentVersion) {
    const currentHash = getCurrentResourceFingerprint();
    const hasStaleExtensionFiles = hasStaleCompiledExtensionSiblings(extensionsDir, bundledExtensionsDir);
    if (manifest.contentHash && manifest.contentHash === currentHash && !hasStaleExtensionFiles) {
      return;
    }
  }
  syncResourceDir(bundledExtensionsDir, join(agentDir, "extensions"));
  syncResourceDir(join(resourcesDir, "agents"), join(agentDir, "agents"));
  syncResourceDir(join(resourcesDir, "skills"), skillsDir);
  const workflowSrc = join(resourcesDir, "GSD-WORKFLOW.md");
  if (existsSync(workflowSrc)) {
    try {
      copyFileSync(workflowSrc, join(agentDir, "GSD-WORKFLOW.md"));
    } catch {
    }
  }
  makeTreeWritable(agentDir);
  writeManagedResourceManifest(agentDir);
  ensureRegistryEntries(join(agentDir, "extensions"));
}
function migrateSkillsToEcosystemDir(agentDir) {
  const legacyDir = join(agentDir, "skills");
  const markerPath = join(legacyDir, ".migrated-to-agents");
  if (!existsSync(legacyDir)) return;
  let markerFd;
  try {
    markerFd = openSync(markerPath, "wx");
  } catch {
    return;
  }
  try {
    const ecosystemDir = join(homedir(), ".agents", "skills");
    mkdirSync(ecosystemDir, { recursive: true });
    const entries = readdirSync(legacyDir, { withFileTypes: true });
    let migrated = 0;
    let candidates = 0;
    for (const entry of entries) {
      const isDir = entry.isDirectory();
      const isSymlink = entry.isSymbolicLink();
      if (!isDir && !isSymlink) continue;
      const sourcePath = join(legacyDir, entry.name);
      if (isSymlink) {
        try {
          const stat = statSync(sourcePath);
          if (!stat.isDirectory()) continue;
        } catch {
          continue;
        }
      }
      const skillMd = join(sourcePath, "SKILL.md");
      if (!existsSync(skillMd)) continue;
      const target = join(ecosystemDir, entry.name);
      if (existsSync(target)) continue;
      candidates++;
      try {
        if (isSymlink) {
          const rawTarget = readlinkSync(sourcePath);
          const absTarget = resolve(dirname(sourcePath), rawTarget);
          symlinkSync(absTarget, target);
        } else {
          cpSync(sourcePath, target, { recursive: true });
        }
        migrated++;
      } catch {
      }
    }
    if (migrated < candidates) {
      try {
        closeSync(markerFd);
        markerFd = -1;
      } catch {
      }
      try {
        unlinkSync(markerPath);
      } catch {
      }
      return;
    }
    try {
      writeFileSync(markerFd, `Migrated ${migrated} skill(s) to ${ecosystemDir} on ${(/* @__PURE__ */ new Date()).toISOString()}
`);
    } catch {
    }
  } catch {
    try {
      closeSync(markerFd);
      markerFd = -1;
    } catch {
    }
    try {
      unlinkSync(markerPath);
    } catch {
    }
  } finally {
    if (markerFd !== -1) {
      try {
        closeSync(markerFd);
      } catch {
      }
    }
  }
}
function hasStaleCompiledExtensionSiblings(extensionsDir, sourceDir = bundledExtensionsDir) {
  if (!existsSync(extensionsDir)) return false;
  const sourceFiles = collectRelativeFiles(sourceDir);
  const installedFiles = collectRelativeFiles(extensionsDir);
  for (const relPath of installedFiles) {
    if (!relPath.endsWith(".ts") && !relPath.endsWith(".js")) continue;
    if (sourceFiles.has(relPath)) continue;
    const bundledSibling = relPath.endsWith(".ts") ? relPath.replace(/\.ts$/, ".js") : relPath.replace(/\.js$/, ".ts");
    if (sourceFiles.has(bundledSibling)) return true;
  }
  return false;
}
function collectRelativeFiles(rootDir) {
  const files = /* @__PURE__ */ new Set();
  if (!existsSync(rootDir)) return files;
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      files.add(relative(rootDir, entryPath).replaceAll("\\", "/"));
    }
  };
  visit(rootDir);
  return files;
}
let _bundledExtensionKeys = null;
function getBundledExtensionKeys() {
  if (!_bundledExtensionKeys) {
    _bundledExtensionKeys = new Set(
      discoverExtensionEntryPaths(bundledExtensionsDir).map((entryPath) => getExtensionKey(entryPath, bundledExtensionsDir))
    );
  }
  return _bundledExtensionKeys;
}
async function buildResourceLoader(agentDir, options = {}) {
  const { DefaultResourceLoader, sortExtensionPaths } = await loadPiCodingAgentModule();
  const registry = loadRegistry();
  const piAgentDir = join(homedir(), ".pi", "agent");
  const piExtensionsDir = join(piAgentDir, "extensions");
  const bundledKeys = getBundledExtensionKeys();
  const piExtensionPaths = discoverExtensionEntryPaths(piExtensionsDir).filter((entryPath) => !bundledKeys.has(getExtensionKey(entryPath, piExtensionsDir))).filter((entryPath) => {
    const manifest = readManifestFromEntryPath(entryPath);
    if (!manifest) return true;
    return isExtensionEnabled(registry, manifest.id);
  });
  const additionalExtensionPaths = [
    ...piExtensionPaths,
    ...options.additionalExtensionPaths ?? []
  ];
  return new DefaultResourceLoader({
    agentDir,
    additionalExtensionPaths,
    bundledExtensionKeys: bundledKeys,
    extensionPathsTransform: (paths) => {
      const filteredPaths = paths.filter((entryPath) => {
        const manifest = readManifestFromEntryPath(entryPath);
        if (!manifest) return true;
        return isExtensionEnabled(registry, manifest.id);
      });
      const { sortedPaths, warnings } = sortExtensionPaths(filteredPaths);
      return {
        paths: sortedPaths,
        diagnostics: warnings.map((w) => w.message)
      };
    }
  });
}
export {
  buildResourceLoader,
  computeResourceFingerprint,
  discoverExtensionEntryPaths2 as discoverExtensionEntryPaths,
  getExtensionKey,
  getNewerManagedResourceVersion,
  hasMissingWorkspaceScopes,
  hasStaleCompiledExtensionSiblings,
  initResources,
  mergedFingerprint,
  readManagedResourceVersion,
  reconcileMergedNodeModules,
  syncResourceDir
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL3Jlc291cmNlLWxvYWRlci50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHR5cGUgeyBEZWZhdWx0UmVzb3VyY2VMb2FkZXIgYXMgRGVmYXVsdFJlc291cmNlTG9hZGVyVHlwZSB9IGZyb20gJ0Bnc2QvcGktY29kaW5nLWFnZW50J1xuaW1wb3J0IHsgY3JlYXRlSGFzaCB9IGZyb20gJ25vZGU6Y3J5cHRvJ1xuaW1wb3J0IHsgaG9tZWRpciB9IGZyb20gJ25vZGU6b3MnXG5pbXBvcnQgeyBjaG1vZFN5bmMsIGNvcHlGaWxlU3luYywgY3BTeW5jLCBleGlzdHNTeW5jLCBsc3RhdFN5bmMsIG1rZGlyU3luYywgb3BlblN5bmMsIGNsb3NlU3luYywgcmVhZEZpbGVTeW5jLCByZWFkbGlua1N5bmMsIHJlYWRkaXJTeW5jLCBybVN5bmMsIHN0YXRTeW5jLCBzeW1saW5rU3luYywgdW5saW5rU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gJ25vZGU6ZnMnXG5pbXBvcnQgeyBiYXNlbmFtZSwgZGlybmFtZSwgam9pbiwgcmVsYXRpdmUsIHJlc29sdmUgfSBmcm9tICdub2RlOnBhdGgnXG5pbXBvcnQgeyBmaWxlVVJMVG9QYXRoIH0gZnJvbSAnbm9kZTp1cmwnXG5pbXBvcnQgeyBjb21wYXJlU2VtdmVyIH0gZnJvbSAnLi91cGRhdGUtY2hlY2suanMnXG5pbXBvcnQgeyBkaXNjb3ZlckV4dGVuc2lvbkVudHJ5UGF0aHMgfSBmcm9tICcuL2V4dGVuc2lvbi1kaXNjb3ZlcnkuanMnXG5pbXBvcnQgeyBsb2FkUmVnaXN0cnksIHJlYWRNYW5pZmVzdEZyb21FbnRyeVBhdGgsIGlzRXh0ZW5zaW9uRW5hYmxlZCwgZW5zdXJlUmVnaXN0cnlFbnRyaWVzIH0gZnJvbSAnLi9leHRlbnNpb24tcmVnaXN0cnkuanMnXG5pbXBvcnQgeyByZXNvbHZlQnVuZGxlZFJlc291cmNlc0RpckZyb21QYWNrYWdlUm9vdCB9IGZyb20gJy4vYnVuZGxlZC1yZXNvdXJjZS1wYXRoLmpzJ1xuXG50eXBlIFBpQ29kaW5nQWdlbnRNb2R1bGUgPSB0eXBlb2YgaW1wb3J0KCdAZ3NkL3BpLWNvZGluZy1hZ2VudCcpXG5cbmxldCBwaUNvZGluZ0FnZW50TW9kdWxlUHJvbWlzZTogUHJvbWlzZTxQaUNvZGluZ0FnZW50TW9kdWxlPiB8IHVuZGVmaW5lZFxuXG5mdW5jdGlvbiBsb2FkUGlDb2RpbmdBZ2VudE1vZHVsZSgpOiBQcm9taXNlPFBpQ29kaW5nQWdlbnRNb2R1bGU+IHtcbiAgcmV0dXJuIChwaUNvZGluZ0FnZW50TW9kdWxlUHJvbWlzZSA/Pz0gaW1wb3J0KCdAZ3NkL3BpLWNvZGluZy1hZ2VudCcpKVxufVxuXG4vLyBSZXNvbHZlIHJlc291cmNlcyBkaXJlY3RvcnkgXHUyMDE0IHByZWZlciBkaXN0L3Jlc291cmNlcy8gKHN0YWJsZSwgc2V0IGF0IGJ1aWxkIHRpbWUpXG4vLyBvdmVyIHNyYy9yZXNvdXJjZXMvIChsaXZlIHdvcmtpbmcgdHJlZSwgY2hhbmdlcyB3aXRoIGdpdCBicmFuY2gpLlxuLy9cbi8vIFdoeSB0aGlzIG1hdHRlcnM6IHdpdGggYG5wbSBsaW5rYCwgc3JjL3Jlc291cmNlcy8gcG9pbnRzIGludG8gdGhlIGdzZC0yIHJlcG8nc1xuLy8gd29ya2luZyB0cmVlLiBTd2l0Y2hpbmcgYnJhbmNoZXMgdGhlcmUgY2hhbmdlcyBzcmMvcmVzb3VyY2VzLyBmb3IgQUxMIHByb2plY3RzXG4vLyB0aGF0IHVzZSBnc2QgXHUyMDE0IGNhdXNpbmcgc3RhbGUvYnJva2VuIGV4dGVuc2lvbnMgdG8gYmUgc3luY2VkIHRvIH4vLmdzZC9hZ2VudC8uXG4vLyBkaXN0L3Jlc291cmNlcy8gaXMgcG9wdWxhdGVkIGJ5IHRoZSBidWlsZCBzdGVwIChgbnBtIHJ1biBjb3B5LXJlc291cmNlc2ApIGFuZFxuLy8gcmVmbGVjdHMgdGhlIGJ1aWx0IHN0YXRlLCBub3QgdGhlIGN1cnJlbnRseSBjaGVja2VkLW91dCBicmFuY2guXG5jb25zdCBwYWNrYWdlUm9vdCA9IHJlc29sdmUoZGlybmFtZShmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpLCAnLi4nKVxuY29uc3QgcmVzb3VyY2VzRGlyID0gcmVzb2x2ZUJ1bmRsZWRSZXNvdXJjZXNEaXJGcm9tUGFja2FnZVJvb3QocGFja2FnZVJvb3QpXG5jb25zdCBidW5kbGVkRXh0ZW5zaW9uc0RpciA9IGpvaW4ocmVzb3VyY2VzRGlyLCAnZXh0ZW5zaW9ucycpXG5jb25zdCByZXNvdXJjZVZlcnNpb25NYW5pZmVzdE5hbWUgPSAnbWFuYWdlZC1yZXNvdXJjZXMuanNvbidcbmNvbnN0IHJlc291cmNlRmluZ2VycHJpbnRGaWxlTmFtZSA9ICcubWFuYWdlZC1yZXNvdXJjZXMtY29udGVudC1oYXNoJ1xuXG5pbnRlcmZhY2UgTWFuYWdlZFJlc291cmNlTWFuaWZlc3Qge1xuICBnc2RWZXJzaW9uOiBzdHJpbmdcbiAgc3luY2VkQXQ/OiBudW1iZXJcbiAgLyoqIENvbnRlbnQgZmluZ2VycHJpbnQgb2YgYnVuZGxlZCByZXNvdXJjZXMgXHUyMDE0IGRldGVjdHMgc2FtZS12ZXJzaW9uIGNvbnRlbnQgY2hhbmdlcy4gKi9cbiAgY29udGVudEhhc2g/OiBzdHJpbmdcbiAgLyoqXG4gICAqIFJvb3QtbGV2ZWwgZmlsZXMgaW5zdGFsbGVkIGluIGV4dGVuc2lvbnMvIGJ5IHRoaXMgR1NEIHZlcnNpb24uXG4gICAqIFVzZWQgb24gdGhlIG5leHQgdXBncmFkZSB0byBkZXRlY3QgYW5kIHBydW5lIGZpbGVzIHRoYXQgd2VyZSByZW1vdmVkIG9yXG4gICAqIG1vdmVkIGludG8gYSBzdWJkaXJlY3RvcnksIHByZXZlbnRpbmcgb3JwaGFuZWQgbm9uLWV4dGVuc2lvbiBmaWxlcyBmcm9tXG4gICAqIGNhdXNpbmcgZXh0ZW5zaW9uIGxvYWQgZXJyb3JzLlxuICAgKi9cbiAgaW5zdGFsbGVkRXh0ZW5zaW9uUm9vdEZpbGVzPzogc3RyaW5nW11cbiAgLyoqXG4gICAqIFN1YmRpcmVjdG9yeSBleHRlbnNpb24gbmFtZXMgaW5zdGFsbGVkIGluIGV4dGVuc2lvbnMvIGJ5IHRoaXMgR1NEIHZlcnNpb24uXG4gICAqIFVzZWQgb24gdGhlIG5leHQgdXBncmFkZSB0byBkZXRlY3QgYW5kIHBydW5lIHN1YmRpcmVjdG9yeSBleHRlbnNpb25zIHRoYXRcbiAgICogd2VyZSByZW1vdmVkIGZyb20gdGhlIGJ1bmRsZS5cbiAgICovXG4gIGluc3RhbGxlZEV4dGVuc2lvbkRpcnM/OiBzdHJpbmdbXVxufVxuXG5leHBvcnQgeyBkaXNjb3ZlckV4dGVuc2lvbkVudHJ5UGF0aHMgfSBmcm9tICcuL2V4dGVuc2lvbi1kaXNjb3ZlcnkuanMnXG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRFeHRlbnNpb25LZXkoZW50cnlQYXRoOiBzdHJpbmcsIGV4dGVuc2lvbnNEaXI6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHJlbFBhdGggPSByZWxhdGl2ZShleHRlbnNpb25zRGlyLCBlbnRyeVBhdGgpXG4gIHJldHVybiByZWxQYXRoLnNwbGl0KC9bXFxcXC9dLylbMF0ucmVwbGFjZSgvXFwuKD86dHN8anMpJC8sICcnKVxufVxuXG5mdW5jdGlvbiBzdHJpcFNlbXZlckJ1aWxkTWV0YWRhdGEodmVyc2lvbjogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHZlcnNpb24udHJpbSgpLnJlcGxhY2UoL152LywgJycpLnNwbGl0KC9bKy1dLywgMSlbMF0gfHwgJzAuMC4wJ1xufVxuXG5mdW5jdGlvbiBnZXRNYW5hZ2VkUmVzb3VyY2VNYW5pZmVzdFBhdGgoYWdlbnREaXI6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBqb2luKGFnZW50RGlyLCByZXNvdXJjZVZlcnNpb25NYW5pZmVzdE5hbWUpXG59XG5cbmZ1bmN0aW9uIGdldEJ1bmRsZWRHc2RWZXJzaW9uKCk6IHN0cmluZyB7XG4gIC8vIFByZWZlciBHU0RfVkVSU0lPTiBlbnYgdmFyIChzZXQgb25jZSBieSBsb2FkZXIudHMpIHRvIGF2b2lkIHJlLXJlYWRpbmcgcGFja2FnZS5qc29uXG4gIGlmIChwcm9jZXNzLmVudi5HU0RfVkVSU0lPTiAmJiBwcm9jZXNzLmVudi5HU0RfVkVSU0lPTiAhPT0gJzAuMC4wJykge1xuICAgIHJldHVybiBwcm9jZXNzLmVudi5HU0RfVkVSU0lPTlxuICB9XG4gIHRyeSB7XG4gICAgY29uc3QgcGtnID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoam9pbihwYWNrYWdlUm9vdCwgJ3BhY2thZ2UuanNvbicpLCAndXRmLTgnKSlcbiAgICByZXR1cm4gdHlwZW9mIHBrZz8udmVyc2lvbiA9PT0gJ3N0cmluZycgPyBwa2cudmVyc2lvbiA6ICcwLjAuMCdcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuICcwLjAuMCdcbiAgfVxufVxuXG5mdW5jdGlvbiB3cml0ZU1hbmFnZWRSZXNvdXJjZU1hbmlmZXN0KGFnZW50RGlyOiBzdHJpbmcpOiB2b2lkIHtcbiAgLy8gUmVjb3JkIHJvb3QtbGV2ZWwgZmlsZXMgYW5kIHN1YmRpcmVjdG9yeSBleHRlbnNpb24gbmFtZXMgY3VycmVudGx5IGluIHRoZVxuICAvLyBidW5kbGVkIGV4dGVuc2lvbnMgc291cmNlIHNvIHRoYXQgZnV0dXJlIHVwZ3JhZGVzIGNhbiBkZXRlY3QgYW5kIHBydW5lIGFueVxuICAvLyB0aGF0IGdldCByZW1vdmVkIG9yIG1vdmVkLlxuICBsZXQgaW5zdGFsbGVkRXh0ZW5zaW9uUm9vdEZpbGVzOiBzdHJpbmdbXSA9IFtdXG4gIGxldCBpbnN0YWxsZWRFeHRlbnNpb25EaXJzOiBzdHJpbmdbXSA9IFtdXG4gIHRyeSB7XG4gICAgaWYgKGV4aXN0c1N5bmMoYnVuZGxlZEV4dGVuc2lvbnNEaXIpKSB7XG4gICAgICBjb25zdCBlbnRyaWVzID0gcmVhZGRpclN5bmMoYnVuZGxlZEV4dGVuc2lvbnNEaXIsIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KVxuICAgICAgaW5zdGFsbGVkRXh0ZW5zaW9uUm9vdEZpbGVzID0gZW50cmllc1xuICAgICAgICAuZmlsdGVyKGUgPT4gZS5pc0ZpbGUoKSlcbiAgICAgICAgLm1hcChlID0+IGUubmFtZSlcbiAgICAgIGluc3RhbGxlZEV4dGVuc2lvbkRpcnMgPSBlbnRyaWVzXG4gICAgICAgIC5maWx0ZXIoZSA9PiBlLmlzRGlyZWN0b3J5KCkpXG4gICAgICAgIC5maWx0ZXIoZSA9PiB7XG4gICAgICAgICAgLy8gVHJhY2sgZGlyZWN0b3JpZXMgdGhhdCBhcmUgYWN0dWFsIGV4dGVuc2lvbnMgXHUyMDE0IGlkZW50aWZpZWQgYnkgYW5cbiAgICAgICAgICAvLyBpbmRleC5qcy9pbmRleC50cyBlbnRyeSBwb2ludCBPUiBhbiBleHRlbnNpb24tbWFuaWZlc3QuanNvbiAoZS5nLlxuICAgICAgICAgIC8vIHJlbW90ZS1xdWVzdGlvbnMgd2hpY2ggdXNlcyBtb2QudHMgaW5zdGVhZCBvZiBpbmRleC50cykuXG4gICAgICAgICAgY29uc3QgZGlyUGF0aCA9IGpvaW4oYnVuZGxlZEV4dGVuc2lvbnNEaXIsIGUubmFtZSlcbiAgICAgICAgICByZXR1cm4gZXhpc3RzU3luYyhqb2luKGRpclBhdGgsICdpbmRleC5qcycpKVxuICAgICAgICAgICAgfHwgZXhpc3RzU3luYyhqb2luKGRpclBhdGgsICdpbmRleC50cycpKVxuICAgICAgICAgICAgfHwgZXhpc3RzU3luYyhqb2luKGRpclBhdGgsICdleHRlbnNpb24tbWFuaWZlc3QuanNvbicpKVxuICAgICAgICB9KVxuICAgICAgICAubWFwKGUgPT4gZS5uYW1lKVxuICAgIH1cbiAgfSBjYXRjaCB7IC8qIG5vbi1mYXRhbCAqLyB9XG5cbiAgY29uc3QgbWFuaWZlc3Q6IE1hbmFnZWRSZXNvdXJjZU1hbmlmZXN0ID0ge1xuICAgIGdzZFZlcnNpb246IGdldEJ1bmRsZWRHc2RWZXJzaW9uKCksXG4gICAgc3luY2VkQXQ6IERhdGUubm93KCksXG4gICAgY29udGVudEhhc2g6IGdldEN1cnJlbnRSZXNvdXJjZUZpbmdlcnByaW50KCksXG4gICAgaW5zdGFsbGVkRXh0ZW5zaW9uUm9vdEZpbGVzLFxuICAgIGluc3RhbGxlZEV4dGVuc2lvbkRpcnMsXG4gIH1cbiAgd3JpdGVGaWxlU3luYyhnZXRNYW5hZ2VkUmVzb3VyY2VNYW5pZmVzdFBhdGgoYWdlbnREaXIpLCBKU09OLnN0cmluZ2lmeShtYW5pZmVzdCkpXG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZWFkTWFuYWdlZFJlc291cmNlVmVyc2lvbihhZ2VudERpcjogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gIHRyeSB7XG4gICAgY29uc3QgbWFuaWZlc3QgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhnZXRNYW5hZ2VkUmVzb3VyY2VNYW5pZmVzdFBhdGgoYWdlbnREaXIpLCAndXRmLTgnKSkgYXMgTWFuYWdlZFJlc291cmNlTWFuaWZlc3RcbiAgICByZXR1cm4gdHlwZW9mIG1hbmlmZXN0Py5nc2RWZXJzaW9uID09PSAnc3RyaW5nJyA/IG1hbmlmZXN0LmdzZFZlcnNpb24gOiBudWxsXG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsXG4gIH1cbn1cblxuZnVuY3Rpb24gcmVhZE1hbmFnZWRSZXNvdXJjZU1hbmlmZXN0KGFnZW50RGlyOiBzdHJpbmcpOiBNYW5hZ2VkUmVzb3VyY2VNYW5pZmVzdCB8IG51bGwge1xuICB0cnkge1xuICAgIHJldHVybiBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhnZXRNYW5hZ2VkUmVzb3VyY2VNYW5pZmVzdFBhdGgoYWdlbnREaXIpLCAndXRmLTgnKSkgYXMgTWFuYWdlZFJlc291cmNlTWFuaWZlc3RcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGxcbiAgfVxufVxuXG4vKipcbiAqIENvbXB1dGVzIGEgY29udGVudCBmaW5nZXJwcmludCBvZiBhIHJlc291cmNlcyBkaXJlY3RvcnkgKGRlZmF1bHRzIHRvIHRoZVxuICogYnVuZGxlZCByZXNvdXJjZXNEaXIpLlxuICpcbiAqIFdhbGtzIGFsbCBmaWxlcyB1bmRlciBgcm9vdERpcmAgYW5kIGhhc2hlcyBgJHtyZWxhdGl2ZVBhdGh9OiR7c2hhMjU2KGNvbnRlbnRzKX1gXG4gKiBmb3IgZWFjaCBvbmUuIFVzaW5nIHRoZSBmaWxlICpjb250ZW50cyogXHUyMDE0IG5vdCBzaXplIFx1MjAxNCBpcyB3aGF0IGRpc3Rpbmd1aXNoZXNcbiAqIHRoaXMgZnJvbSB0aGUgZWFybGllciBpbXBsZW1lbnRhdGlvbiBhbmQgY2xvc2VzICM0Nzg3OiBhIHNhbWUtc2l6ZSBlZGl0XG4gKiAoZS5nLiBzd2FwcGluZyBvbmUgd29yZCBmb3IgYW5vdGhlciB3b3JkIG9mIHRoZSBzYW1lIGJ5dGUgbGVuZ3RoKSBwcm9kdWNlc1xuICogYSBkaWZmZXJlbnQgZmlsZSBoYXNoLCBidW1wcyB0aGUgYWdncmVnYXRlIGZpbmdlcnByaW50LCBhbmQgdGhlcmVmb3JlXG4gKiB0cmlnZ2VycyBhIGZ1bGwgcmVzeW5jIGluIGBpbml0UmVzb3VyY2VzYC4gVGhlIG9sZCBwYXRoK3NpemUgYXBwcm9hY2hcbiAqIHNpbGVudGx5IGNhY2hlZCBzdGFsZSBwcm9tcHRzIGFjcm9zcyB1cGdyYWRlcy5cbiAqXG4gKiBDb3N0IGlzIH4xLTJtcyBmb3IgYSB0eXBpY2FsIHJlc291cmNlcyB0cmVlICh+MTAwIHNtYWxsIC5tZCBmaWxlcykgXHUyMDE0XG4gKiBzdGlsbCBuZWdsaWdpYmxlIGF0IHN0YXJ0dXAuIEZpbGVzIGFyZSBzdHJlYW1lZCB2aWEgYHJlYWRGaWxlU3luY2AgYnV0XG4gKiBidW5kbGVkIHByb21wdHMgYXJlIHRpbnkgc28gdGhpcyBpcyBmaW5lLlxuICpcbiAqIEV4cG9ydGVkIGZvciB1bml0IHRlc3RzIGFuZCBmb3IgY2FsbGVycyB0aGF0IHdhbnQgdG8gY2hlY2sgYSBkaWZmZXJlbnRcbiAqIGRpcmVjdG9yeSAoZS5nLiBwcmUtaW5zdGFsbCB2ZXJpZmljYXRpb24pLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY29tcHV0ZVJlc291cmNlRmluZ2VycHJpbnQocm9vdERpcjogc3RyaW5nID0gcmVzb3VyY2VzRGlyKTogc3RyaW5nIHtcbiAgY29uc3QgZW50cmllczogc3RyaW5nW10gPSBbXVxuICBjb2xsZWN0RmlsZUVudHJpZXMocm9vdERpciwgcm9vdERpciwgZW50cmllcylcbiAgZW50cmllcy5zb3J0KClcbiAgcmV0dXJuIGNyZWF0ZUhhc2goJ3NoYTI1NicpLnVwZGF0ZShlbnRyaWVzLmpvaW4oJ1xcbicpKS5kaWdlc3QoJ2hleCcpLnNsaWNlKDAsIDE2KVxufVxuXG5mdW5jdGlvbiBnZXRDdXJyZW50UmVzb3VyY2VGaW5nZXJwcmludCgpOiBzdHJpbmcge1xuICB0cnkge1xuICAgIGNvbnN0IHByZWNvbXB1dGVkID0gcmVhZEZpbGVTeW5jKGpvaW4ocmVzb3VyY2VzRGlyLCByZXNvdXJjZUZpbmdlcnByaW50RmlsZU5hbWUpLCAndXRmLTgnKS50cmltKClcbiAgICBpZiAoL15bYS1mMC05XXsxNn0kL2kudGVzdChwcmVjb21wdXRlZCkpIHtcbiAgICAgIHJldHVybiBwcmVjb21wdXRlZFxuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gU291cmNlLXRyZWUgYW5kIHBhcnRpYWwtYnVpbGQgd29ya2Zsb3dzIG1heSBub3QgaGF2ZSBhIHByZWNvbXB1dGVkIGhhc2guXG4gIH1cbiAgcmV0dXJuIGNvbXB1dGVSZXNvdXJjZUZpbmdlcnByaW50KClcbn1cblxuZnVuY3Rpb24gY29sbGVjdEZpbGVFbnRyaWVzKGRpcjogc3RyaW5nLCByb290OiBzdHJpbmcsIG91dDogc3RyaW5nW10pOiB2b2lkIHtcbiAgaWYgKCFleGlzdHNTeW5jKGRpcikpIHJldHVyblxuICBmb3IgKGNvbnN0IGVudHJ5IG9mIHJlYWRkaXJTeW5jKGRpciwgeyB3aXRoRmlsZVR5cGVzOiB0cnVlIH0pKSB7XG4gICAgaWYgKGVudHJ5Lm5hbWUgPT09IHJlc291cmNlRmluZ2VycHJpbnRGaWxlTmFtZSkgY29udGludWVcbiAgICBjb25zdCBmdWxsUGF0aCA9IGpvaW4oZGlyLCBlbnRyeS5uYW1lKVxuICAgIGlmIChlbnRyeS5pc0RpcmVjdG9yeSgpKSB7XG4gICAgICBjb2xsZWN0RmlsZUVudHJpZXMoZnVsbFBhdGgsIHJvb3QsIG91dClcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgcmVsID0gcmVsYXRpdmUocm9vdCwgZnVsbFBhdGgpXG4gICAgICAvLyBIYXNoIHRoZSBmaWxlIGNvbnRlbnRzIFx1MjAxNCBzZWUgZnVuY3Rpb24gZG9jIGZvciAjNDc4NyByYXRpb25hbGUuXG4gICAgICBsZXQgY29udGVudEhhc2g6IHN0cmluZ1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29udGVudEhhc2ggPSBjcmVhdGVIYXNoKCdzaGEyNTYnKS51cGRhdGUocmVhZEZpbGVTeW5jKGZ1bGxQYXRoKSkuZGlnZXN0KCdoZXgnKVxuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIFVucmVhZGFibGUgZmlsZSBcdTIwMTQgZmFsbCBiYWNrIHRvIGEgc3RhYmxlIG1hcmtlciBzbyB0aGUgZW50cnkgc3RpbGxcbiAgICAgICAgLy8gY29udHJpYnV0ZXMgdG8gdGhlIGFnZ3JlZ2F0ZSBoYXNoIGFuZCBmdXR1cmUgcmVhZHMgd2lsbCByZS1oYXNoLlxuICAgICAgICBjb250ZW50SGFzaCA9ICd1bnJlYWRhYmxlJ1xuICAgICAgfVxuICAgICAgb3V0LnB1c2goYCR7cmVsfToke2NvbnRlbnRIYXNofWApXG4gICAgfVxuICB9XG59XG5cblxuZXhwb3J0IGZ1bmN0aW9uIGdldE5ld2VyTWFuYWdlZFJlc291cmNlVmVyc2lvbihhZ2VudERpcjogc3RyaW5nLCBjdXJyZW50VmVyc2lvbjogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IG1hbmFnZWRWZXJzaW9uID0gcmVhZE1hbmFnZWRSZXNvdXJjZVZlcnNpb24oYWdlbnREaXIpXG4gIGlmICghbWFuYWdlZFZlcnNpb24pIHtcbiAgICByZXR1cm4gbnVsbFxuICB9XG4gIC8vIE1hbmFnZWQgcmVzb3VyY2VzIHN0YW1wZWQgZnJvbSB0aGUgc2FtZSByZWxlYXNlIGxpbmUgc2hvdWxkIHJlbWFpbiB1c2FibGVcbiAgLy8gYWdhaW5zdCBsb2NhbCBkZXYgYmluYXJpZXMgbGlrZSAyLjc4LjEtZGV2LjxzaGE+LlxuICByZXR1cm4gY29tcGFyZVNlbXZlcihcbiAgICBzdHJpcFNlbXZlckJ1aWxkTWV0YWRhdGEobWFuYWdlZFZlcnNpb24pLFxuICAgIHN0cmlwU2VtdmVyQnVpbGRNZXRhZGF0YShjdXJyZW50VmVyc2lvbiksXG4gICkgPiAwID8gbWFuYWdlZFZlcnNpb24gOiBudWxsXG59XG5cbi8qKlxuICogUmVjdXJzaXZlbHkgbWFrZXMgYWxsIGZpbGVzIGFuZCBkaXJlY3RvcmllcyB1bmRlciBkaXJQYXRoIG93bmVyLXdyaXRhYmxlLlxuICpcbiAqIEZpbGVzIGNvcGllZCBmcm9tIHRoZSBOaXggc3RvcmUgaW5oZXJpdCByZWFkLW9ubHkgbW9kZXMgKDA0NDQvMDU1NSkuXG4gKiBDYWxsaW5nIHRoaXMgYmVmb3JlIGNwU3luYyBwcmV2ZW50cyBvdmVyd3JpdGUgZmFpbHVyZXMgb24gc3Vic2VxdWVudCB1cGdyYWRlcyxcbiAqIGFuZCBjYWxsaW5nIGl0IGFmdGVyIGVuc3VyZXMgdGhlIG5leHQgcnVuIGNhbiBvdmVyd3JpdGUgdGhlIGNvcGllcyB0b28uXG4gKlxuICogUHJlc2VydmVzIGV4aXN0aW5nIHBlcm1pc3Npb24gYml0cyAoaW5jbHVkaW5nIGV4ZWN1dGFiaWxpdHkpIGFuZCBvbmx5IGFkZHNcbiAqIG93bmVyLXdyaXRlIChhbmQgZm9yIGRpcmVjdG9yaWVzLCBvd25lci1leGVjKSB3aXRob3V0IHdpZGVuaW5nIGdyb3VwL290aGVyXG4gKiBwZXJtaXNzaW9ucy5cbiAqL1xuZnVuY3Rpb24gbWFrZVRyZWVXcml0YWJsZShkaXJQYXRoOiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKCFleGlzdHNTeW5jKGRpclBhdGgpKSByZXR1cm5cblxuICAvLyBVc2UgbHN0YXRTeW5jIHRvIGF2b2lkIGZvbGxvd2luZyBzeW1saW5rcyBpbnRvIGltbXV0YWJsZSBmaWxlc3lzdGVtc1xuICAvLyAoZS5nLiwgTml4IHN0b3JlIG9uIE5peE9TL25peC1kYXJ3aW4pLiBTeW1saW5rcyBkb24ndCBjYXJyeSB0aGVpciBvd25cbiAgLy8gcGVybWlzc2lvbnMgYW5kIHRoZWlyIHRhcmdldHMgbWF5IGJlIHJlYWQtb25seSBieSBkZXNpZ24gKCMxMjk4KS5cbiAgY29uc3Qgc3RhdHMgPSBsc3RhdFN5bmMoZGlyUGF0aClcbiAgaWYgKHN0YXRzLmlzU3ltYm9saWNMaW5rKCkpIHJldHVyblxuXG4gIGNvbnN0IGlzRGlyID0gc3RhdHMuaXNEaXJlY3RvcnkoKVxuICBjb25zdCBjdXJyZW50TW9kZSA9IHN0YXRzLm1vZGUgJiAwbzc3N1xuXG4gIC8vIEVuc3VyZSBvd25lci13cml0ZTsgZm9yIGRpcmVjdG9yaWVzIGFsc28gZW5zdXJlIG93bmVyLWV4ZWMgc28gdGhleSByZW1haW4gdHJhdmVyc2FibGUuXG4gIGxldCBuZXdNb2RlID0gY3VycmVudE1vZGUgfCAwbzIwMFxuICBpZiAoaXNEaXIpIHtcbiAgICBuZXdNb2RlIHw9IDBvMTAwXG4gIH1cblxuICBpZiAobmV3TW9kZSAhPT0gY3VycmVudE1vZGUpIHtcbiAgICB0cnkge1xuICAgICAgY2htb2RTeW5jKGRpclBhdGgsIG5ld01vZGUpXG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBOb24tZmF0YWwgXHUyMDE0IG1heSBmYWlsIG9uIHJlYWQtb25seSBmaWxlc3lzdGVtcyBvciBpbnN1ZmZpY2llbnQgcGVybWlzc2lvbnNcbiAgICB9XG4gIH1cblxuICBpZiAoaXNEaXIpIHtcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIHJlYWRkaXJTeW5jKGRpclBhdGgsIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KSkge1xuICAgICAgY29uc3QgZW50cnlQYXRoID0gam9pbihkaXJQYXRoLCBlbnRyeS5uYW1lKVxuICAgICAgbWFrZVRyZWVXcml0YWJsZShlbnRyeVBhdGgpXG4gICAgfVxuICB9XG59XG5cbi8qKlxuICogU3luY3MgYSBzaW5nbGUgYnVuZGxlZCByZXNvdXJjZSBkaXJlY3RvcnkgaW50byB0aGUgYWdlbnQgZGlyZWN0b3J5LlxuICpcbiAqIDEuIE1ha2VzIHRoZSBkZXN0aW5hdGlvbiB3cml0YWJsZSAoaGFuZGxlcyBOaXggc3RvcmUgcmVhZC1vbmx5IGNvcGllcykuXG4gKiAyLiBSZW1vdmVzIGRlc3RpbmF0aW9uIHN1YmRpcnMgdGhhdCBleGlzdCBpbiBzb3VyY2UgdG8gY2xlYXIgc3RhbGUgZmlsZXMsXG4gKiAgICB3aGlsZSBwcmVzZXJ2aW5nIHVzZXItY3JlYXRlZCBkaXJlY3Rvcmllcy5cbiAqIDMuIENvcGllcyBzb3VyY2UgaW50byBkZXN0aW5hdGlvbi5cbiAqIDQuIE1ha2VzIHRoZSByZXN1bHQgd3JpdGFibGUgZm9yIHRoZSBuZXh0IHVwZ3JhZGUgY3ljbGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzeW5jUmVzb3VyY2VEaXIoc3JjRGlyOiBzdHJpbmcsIGRlc3REaXI6IHN0cmluZyk6IHZvaWQge1xuICBtYWtlVHJlZVdyaXRhYmxlKGRlc3REaXIpXG4gIGlmIChleGlzdHNTeW5jKHNyY0RpcikpIHtcbiAgICBwcnVuZVN0YWxlU2libGluZ0ZpbGVzKHNyY0RpciwgZGVzdERpcilcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIHJlYWRkaXJTeW5jKHNyY0RpciwgeyB3aXRoRmlsZVR5cGVzOiB0cnVlIH0pKSB7XG4gICAgICBpZiAoZW50cnkuaXNEaXJlY3RvcnkoKSkge1xuICAgICAgICBjb25zdCB0YXJnZXQgPSBqb2luKGRlc3REaXIsIGVudHJ5Lm5hbWUpXG4gICAgICAgIGlmIChleGlzdHNTeW5jKHRhcmdldCkpIHJtU3luYyh0YXJnZXQsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KVxuICAgICAgfVxuICAgIH1cbiAgICB0cnkge1xuICAgICAgY3BTeW5jKHNyY0RpciwgZGVzdERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pXG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBGYWxsYmFjayBmb3IgV2luZG93cyBwYXRocyB3aXRoIG5vbi1BU0NJSSBjaGFyYWN0ZXJzIHdoZXJlIGNwU3luY1xuICAgICAgLy8gZmFpbHMgd2l0aCB0aGUgXFxcXD9cXCBleHRlbmRlZC1sZW5ndGggcHJlZml4ICgjMTE3OCkuXG4gICAgICBjb3B5RGlyUmVjdXJzaXZlKHNyY0RpciwgZGVzdERpcilcbiAgICB9XG4gICAgbWFrZVRyZWVXcml0YWJsZShkZXN0RGlyKVxuICB9XG59XG5cbmZ1bmN0aW9uIHBydW5lU3RhbGVTaWJsaW5nRmlsZXMoc3JjRGlyOiBzdHJpbmcsIGRlc3REaXI6IHN0cmluZyk6IHZvaWQge1xuICBpZiAoIWV4aXN0c1N5bmMoZGVzdERpcikpIHJldHVyblxuXG4gIGNvbnN0IHNvdXJjZUZpbGVzID0gbmV3IFNldChcbiAgICByZWFkZGlyU3luYyhzcmNEaXIsIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KVxuICAgICAgLmZpbHRlcigoZW50cnkpID0+IGVudHJ5LmlzRmlsZSgpKVxuICAgICAgLm1hcCgoZW50cnkpID0+IGVudHJ5Lm5hbWUpLFxuICApXG5cbiAgZm9yIChjb25zdCBlbnRyeSBvZiByZWFkZGlyU3luYyhkZXN0RGlyLCB7IHdpdGhGaWxlVHlwZXM6IHRydWUgfSkpIHtcbiAgICBpZiAoIWVudHJ5LmlzRmlsZSgpKSBjb250aW51ZVxuICAgIGlmIChzb3VyY2VGaWxlcy5oYXMoZW50cnkubmFtZSkpIGNvbnRpbnVlXG5cbiAgICBjb25zdCBzb3VyY2VKc05hbWUgPSBlbnRyeS5uYW1lLnJlcGxhY2UoL1xcLnRzJC8sICcuanMnKVxuICAgIGNvbnN0IHNvdXJjZVRzTmFtZSA9IGVudHJ5Lm5hbWUucmVwbGFjZSgvXFwuanMkLywgJy50cycpXG4gICAgaWYgKHNvdXJjZUZpbGVzLmhhcyhzb3VyY2VKc05hbWUpIHx8IHNvdXJjZUZpbGVzLmhhcyhzb3VyY2VUc05hbWUpKSB7XG4gICAgICBybVN5bmMoam9pbihkZXN0RGlyLCBlbnRyeS5uYW1lKSwgeyBmb3JjZTogdHJ1ZSB9KVxuICAgIH1cbiAgfVxufVxuXG4vKipcbiAqIFJlY3Vyc2l2ZSBkaXJlY3RvcnkgY29weSB1c2luZyBjb3B5RmlsZVN5bmMgXHUyMDE0IHdvcmthcm91bmQgZm9yIGNwU3luYyBmYWlsdXJlc1xuICogb24gV2luZG93cyBwYXRocyBjb250YWluaW5nIG5vbi1BU0NJSSBjaGFyYWN0ZXJzICgjMTE3OCkuXG4gKi9cbmZ1bmN0aW9uIGNvcHlEaXJSZWN1cnNpdmUoc3JjOiBzdHJpbmcsIGRlc3Q6IHN0cmluZyk6IHZvaWQge1xuICBta2RpclN5bmMoZGVzdCwgeyByZWN1cnNpdmU6IHRydWUgfSlcbiAgZm9yIChjb25zdCBlbnRyeSBvZiByZWFkZGlyU3luYyhzcmMsIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KSkge1xuICAgIGNvbnN0IHNyY1BhdGggPSBqb2luKHNyYywgZW50cnkubmFtZSlcbiAgICBjb25zdCBkZXN0UGF0aCA9IGpvaW4oZGVzdCwgZW50cnkubmFtZSlcbiAgICBpZiAoZW50cnkuaXNEaXJlY3RvcnkoKSkge1xuICAgICAgY29weURpclJlY3Vyc2l2ZShzcmNQYXRoLCBkZXN0UGF0aClcbiAgICB9IGVsc2Uge1xuICAgICAgY29weUZpbGVTeW5jKHNyY1BhdGgsIGRlc3RQYXRoKVxuICAgIH1cbiAgfVxufVxuXG4vKipcbiAqIENyZWF0ZXMgKG9yIHVwZGF0ZXMpIGEgc3ltbGluayBhdCBhZ2VudERpci9ub2RlX21vZHVsZXMgcG9pbnRpbmcgdG8gR1NEJ3NcbiAqIG93biBub2RlX21vZHVsZXMgZGlyZWN0b3J5LlxuICpcbiAqIE5hdGl2ZSBFU00gYGltcG9ydCgpYCBpZ25vcmVzIE5PREVfUEFUSCBcdTIwMTQgaXQgcmVzb2x2ZXMgcGFja2FnZXMgYnkgd2Fsa2luZ1xuICogdXAgdGhlIGRpcmVjdG9yeSB0cmVlIGZyb20gdGhlIGltcG9ydGluZyBmaWxlLiBFeHRlbnNpb24gZmlsZXMgc3luY2VkIHRvXG4gKiB+Ly5nc2QvYWdlbnQvZXh0ZW5zaW9ucy8gaGF2ZSBubyBhbmNlc3RvciBub2RlX21vZHVsZXMsIHNvIGltcG9ydHMgb2ZcbiAqIEBnc2QvKiBwYWNrYWdlcyBmYWlsLiBUaGUgc3ltbGluayBtYWtlcyBOb2RlJ3Mgc3RhbmRhcmQgcmVzb2x1dGlvbiBmaW5kXG4gKiB0aGVtIHdpdGhvdXQgcmVxdWlyaW5nIGV2ZXJ5IGNhbGwgc2l0ZSB0byB1c2Ugaml0aS5cbiAqXG4gKiBMYXlvdXQgZGlmZmVyZW5jZXMgYnkgaW5zdGFsbCBtZXRob2Q6XG4gKiAtIFNvdXJjZS9tb25vcmVwbzogcGFja2FnZVJvb3Qvbm9kZV9tb2R1bGVzIGhhcyBldmVyeXRoaW5nIFx1MjE5MiBzaW1wbGUgc3ltbGlua1xuICogLSBucG0vYnVuIGdsb2JhbDogZGVwcyBob2lzdGVkIHRvIGRpcm5hbWUocGFja2FnZVJvb3QpLCBpbmNsdWRpbmcgQGdzZC8qIFx1MjE5MiBzaW1wbGUgc3ltbGlua1xuICogLSBwbnBtIGdsb2JhbDogZXh0ZXJuYWwgZGVwcyBob2lzdGVkLCBidXQgQGdzZC8qIHN0YXlzIGluIHBhY2thZ2VSb290L25vZGVfbW9kdWxlc1xuICogICBcdTIxOTIgbWVyZ2VkIGRpcmVjdG9yeSB3aXRoIHN5bWxpbmtzIGZyb20gYm90aCByb290cyAoIzM1MjksICMzNTY0KVxuICovXG5mdW5jdGlvbiBlbnN1cmVOb2RlTW9kdWxlc1N5bWxpbmsoYWdlbnREaXI6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBhZ2VudE5vZGVNb2R1bGVzID0gam9pbihhZ2VudERpciwgJ25vZGVfbW9kdWxlcycpXG4gIGNvbnN0IGludGVybmFsTm9kZU1vZHVsZXMgPSBqb2luKHBhY2thZ2VSb290LCAnbm9kZV9tb2R1bGVzJylcbiAgY29uc3QgaG9pc3RlZE5vZGVNb2R1bGVzID0gZGlybmFtZShwYWNrYWdlUm9vdClcbiAgY29uc3QgaXNHbG9iYWxJbnN0YWxsID0gYmFzZW5hbWUoaG9pc3RlZE5vZGVNb2R1bGVzKSA9PT0gJ25vZGVfbW9kdWxlcydcblxuICBpZiAoIWlzR2xvYmFsSW5zdGFsbCkge1xuICAgIC8vIFNvdXJjZS9tb25vcmVwbzogaW50ZXJuYWwgbm9kZV9tb2R1bGVzIGhhcyBldmVyeXRoaW5nXG4gICAgcmVjb25jaWxlU3ltbGluayhhZ2VudE5vZGVNb2R1bGVzLCBpbnRlcm5hbE5vZGVNb2R1bGVzKVxuICAgIHJldHVyblxuICB9XG5cbiAgLy8gR2xvYmFsIGluc3RhbGw6IGNoZWNrIGlmIHdvcmtzcGFjZSBzY29wZXMgKEBnc2QvKikgYXJlIGhvaXN0ZWQuXG4gIC8vIG5wbS9idW4gaG9pc3QgZXZlcnl0aGluZzsgcG5wbSBrZWVwcyB3b3Jrc3BhY2UgcGFja2FnZXMgaW50ZXJuYWwuXG4gIGlmICghaGFzTWlzc2luZ1dvcmtzcGFjZVNjb3Blcyhob2lzdGVkTm9kZU1vZHVsZXMsIGludGVybmFsTm9kZU1vZHVsZXMpKSB7XG4gICAgLy8gRXZlcnl0aGluZyBpcyBob2lzdGVkIFx1MjAxNCBzaW1wbGUgc3ltbGluayB0byBwYXJlbnQgbm9kZV9tb2R1bGVzXG4gICAgcmVjb25jaWxlU3ltbGluayhhZ2VudE5vZGVNb2R1bGVzLCBob2lzdGVkTm9kZU1vZHVsZXMpXG4gICAgcmV0dXJuXG4gIH1cblxuICAvLyBwbnBtLXN0eWxlIGxheW91dDogY3JlYXRlIGEgcmVhbCBkaXJlY3RvcnkgbWVyZ2luZyBib3RoIHJvb3RzXG4gIHJlY29uY2lsZU1lcmdlZE5vZGVNb2R1bGVzKGFnZW50Tm9kZU1vZHVsZXMsIGhvaXN0ZWROb2RlTW9kdWxlcywgaW50ZXJuYWxOb2RlTW9kdWxlcylcbn1cblxuLyoqIENoZWNrIGlmIGFueSBAZ3NkKiBzY29wZXMgZXhpc3QgaW4gaW50ZXJuYWwgYnV0IG5vdCBpbiBob2lzdGVkIG5vZGVfbW9kdWxlcyAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhhc01pc3NpbmdXb3Jrc3BhY2VTY29wZXMoaG9pc3RlZDogc3RyaW5nLCBpbnRlcm5hbDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGlmICghZXhpc3RzU3luYyhpbnRlcm5hbCkpIHJldHVybiBmYWxzZVxuICB0cnkge1xuICAgIGZvciAoY29uc3QgZW50cnkgb2YgcmVhZGRpclN5bmMoaW50ZXJuYWwsIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KSkge1xuICAgICAgaWYgKGVudHJ5LmlzRGlyZWN0b3J5KCkgJiYgZW50cnkubmFtZS5zdGFydHNXaXRoKCdAZ3NkJykgJiZcbiAgICAgICAgICAhZXhpc3RzU3luYyhqb2luKGhvaXN0ZWQsIGVudHJ5Lm5hbWUpKSkge1xuICAgICAgICByZXR1cm4gdHJ1ZVxuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCB7IC8qIG5vbi1mYXRhbCAqLyB9XG4gIHJldHVybiBmYWxzZVxufVxuXG4vKiogRW5zdXJlIGEgc3ltbGluayBhdCBgbGlua2AgcG9pbnRzIHRvIGB0YXJnZXRgLCBmaXhpbmcgc3RhbGUvd3JvbmcgZW50cmllcyAqL1xuZnVuY3Rpb24gcmVjb25jaWxlU3ltbGluayhsaW5rOiBzdHJpbmcsIHRhcmdldDogc3RyaW5nKTogdm9pZCB7XG4gIHRyeSB7XG4gICAgY29uc3Qgc3RhdCA9IGxzdGF0U3luYyhsaW5rKVxuICAgIGlmIChzdGF0LmlzU3ltYm9saWNMaW5rKCkpIHtcbiAgICAgIGNvbnN0IGV4aXN0aW5nID0gcmVhZGxpbmtTeW5jKGxpbmspXG4gICAgICBpZiAoZXhpc3RpbmcgPT09IHRhcmdldCAmJiBleGlzdHNTeW5jKGxpbmspKSByZXR1cm4gIC8vIGNvcnJlY3QgYW5kIHRhcmdldCBleGlzdHNcbiAgICAgIHVubGlua1N5bmMobGluaylcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gUmVhbCBkaXJlY3RvcnkgKG9yIG1lcmdlZCBkaXIgZnJvbSBwcmV2aW91cyBwbnBtIGZpeCkgXHUyMDE0IHJlbW92ZSBpdFxuICAgICAgcm1TeW5jKGxpbmssIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KVxuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gbHN0YXRTeW5jIHRocm93cyBpZiBwYXRoIGRvZXNuJ3QgZXhpc3QgXHUyMDE0IGZpbmUsIHdlJ2xsIGNyZWF0ZSBiZWxvd1xuICB9XG5cbiAgdHJ5IHtcbiAgICBzeW1saW5rU3luYyh0YXJnZXQsIGxpbmssICdqdW5jdGlvbicpXG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGNvbnNvbGUuZXJyb3IoYFtnc2RdIFdBUk46IEZhaWxlZCB0byBzeW1saW5rICR7bGlua30gXHUyMTkyICR7dGFyZ2V0fTogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogZXJyfWApXG4gIH1cbn1cblxuLyoqXG4gKiBDcmVhdGUgYSByZWFsIG5vZGVfbW9kdWxlcyBkaXJlY3RvcnkgY29udGFpbmluZyBzeW1saW5rcyBmcm9tIGJvdGggdGhlXG4gKiBob2lzdGVkIHJvb3QgKGV4dGVybmFsIGRlcHMpIGFuZCBpbnRlcm5hbCByb290IChAZ3NkLyogd29ya3NwYWNlIHBhY2thZ2VzKS5cbiAqIFVzZWQgZm9yIHBucG0gZ2xvYmFsIGluc3RhbGxzIHdoZXJlIEBnc2QvKiBpc24ndCBob2lzdGVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVjb25jaWxlTWVyZ2VkTm9kZU1vZHVsZXMoXG4gIGFnZW50Tm9kZU1vZHVsZXM6IHN0cmluZyxcbiAgaG9pc3RlZDogc3RyaW5nLFxuICBpbnRlcm5hbDogc3RyaW5nLFxuKTogdm9pZCB7XG4gIC8vIEZhc3QgcGF0aDogaWYgYWxyZWFkeSBtZXJnZWQgZm9yIHRoaXMgcGFja2FnZVJvb3QgKyBzYW1lIGRpcmVjdG9yeSBjb250ZW50cywgc2tpcC5cbiAgLy8gVGhlIGZpbmdlcnByaW50IGluY2x1ZGVzIGVudHJ5IG5hbWVzIGZyb20gYm90aCByb290cyBzbyBgcG5wbSBhZGQvcmVtb3ZlYCB0cmlnZ2VycyByZWJ1aWxkLlxuICBjb25zdCBtYXJrZXIgPSBqb2luKGFnZW50Tm9kZU1vZHVsZXMsICcuZ3NkLW1lcmdlZCcpXG4gIGNvbnN0IGZpbmdlcnByaW50ID0gbWVyZ2VkRmluZ2VycHJpbnQoaG9pc3RlZCwgaW50ZXJuYWwpXG4gIHRyeSB7XG4gICAgaWYgKGV4aXN0c1N5bmMobWFya2VyKSAmJiByZWFkRmlsZVN5bmMobWFya2VyLCAndXRmLTgnKS50cmltKCkgPT09IGZpbmdlcnByaW50KSByZXR1cm5cbiAgfSBjYXRjaCB7IC8qIHJlYnVpbGQgKi8gfVxuXG4gIC8vIFJlbW92ZSBhbnkgZXhpc3Rpbmcgc3ltbGluayBvciBzdGFsZSBtZXJnZWQgZGlyZWN0b3J5XG4gIHRyeSB7XG4gICAgY29uc3Qgc3RhdCA9IGxzdGF0U3luYyhhZ2VudE5vZGVNb2R1bGVzKVxuICAgIGlmIChzdGF0LmlzU3ltYm9saWNMaW5rKCkpIHtcbiAgICAgIHVubGlua1N5bmMoYWdlbnROb2RlTW9kdWxlcylcbiAgICB9IGVsc2Uge1xuICAgICAgcm1TeW5jKGFnZW50Tm9kZU1vZHVsZXMsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KVxuICAgIH1cbiAgfSBjYXRjaCB7IC8qIGRvZXNuJ3QgZXhpc3QgKi8gfVxuXG4gIG1rZGlyU3luYyhhZ2VudE5vZGVNb2R1bGVzLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KVxuXG4gIGxldCBsaW5rZWRDb3VudCA9IDBcblxuICAvLyBTeW1saW5rIGVudHJpZXMgZnJvbSB0aGUgaG9pc3RlZCBub2RlX21vZHVsZXMgKGV4dGVybmFsIGRlcHMpXG4gIHRyeSB7XG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiByZWFkZGlyU3luYyhob2lzdGVkLCB7IHdpdGhGaWxlVHlwZXM6IHRydWUgfSkpIHtcbiAgICAgIC8vIFNraXAgdGhlIGdzZC1waSBwYWNrYWdlIGl0c2VsZiBhbmQgZG90ZmlsZXNcbiAgICAgIGlmIChlbnRyeS5uYW1lID09PSBiYXNlbmFtZShwYWNrYWdlUm9vdCkpIGNvbnRpbnVlXG4gICAgICBpZiAoZW50cnkubmFtZS5zdGFydHNXaXRoKCcuJykpIGNvbnRpbnVlXG4gICAgICB0cnkgeyBzeW1saW5rU3luYyhqb2luKGhvaXN0ZWQsIGVudHJ5Lm5hbWUpLCBqb2luKGFnZW50Tm9kZU1vZHVsZXMsIGVudHJ5Lm5hbWUpLCAnanVuY3Rpb24nKTsgbGlua2VkQ291bnQrKyB9IGNhdGNoIHsgLyogc2tpcCBpbmRpdmlkdWFsICovIH1cbiAgICB9XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGNvbnNvbGUuZXJyb3IoYFtnc2RdIFdBUk46IEZhaWxlZCB0byByZWFkIGhvaXN0ZWQgbm9kZV9tb2R1bGVzIGF0ICR7aG9pc3RlZH06ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IGVycn1gKVxuICB9XG5cbiAgLy8gT3ZlcmxheSBpbnRlcm5hbCBub2RlX21vZHVsZXMgZW50cmllcyB0aGF0IHdlcmVuJ3QgaG9pc3RlZC5cbiAgLy8gVGhpcyBjb3ZlcnMgQGdzZC8qIHdvcmtzcGFjZSBwYWNrYWdlcyBBTkQgb3B0aW9uYWwgZGVwcyBsaWtlXG4gIC8vIEBhbnRocm9waWMtYWkvY2xhdWRlLWFnZW50LXNkayB0aGF0IG5wbSBrZWVwcyBpbnRlcm5hbC5cbiAgdHJ5IHtcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIHJlYWRkaXJTeW5jKGludGVybmFsLCB7IHdpdGhGaWxlVHlwZXM6IHRydWUgfSkpIHtcbiAgICAgIGlmIChlbnRyeS5uYW1lLnN0YXJ0c1dpdGgoJy4nKSkgY29udGludWVcbiAgICAgIGNvbnN0IGxpbmsgPSBqb2luKGFnZW50Tm9kZU1vZHVsZXMsIGVudHJ5Lm5hbWUpXG4gICAgICAvLyBSZXBsYWNlIGhvaXN0ZWQgc3ltbGluayB3aXRoIGludGVybmFsIHZlcnNpb24gKGludGVybmFsIHRha2VzIHByZWNlZGVuY2UpXG4gICAgICB0cnkgeyBsc3RhdFN5bmMobGluayk7IHVubGlua1N5bmMobGluaykgfSBjYXRjaCB7IC8qIGRpZG4ndCBleGlzdCBcdTIwMTQgd2lsbCBjcmVhdGUgYmVsb3cgKi8gfVxuICAgICAgdHJ5IHsgc3ltbGlua1N5bmMoam9pbihpbnRlcm5hbCwgZW50cnkubmFtZSksIGxpbmssICdqdW5jdGlvbicpOyBsaW5rZWRDb3VudCsrIH0gY2F0Y2ggeyAvKiBza2lwIGluZGl2aWR1YWwgKi8gfVxuICAgIH1cbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY29uc29sZS5lcnJvcihgW2dzZF0gV0FSTjogRmFpbGVkIHRvIHJlYWQgaW50ZXJuYWwgbm9kZV9tb2R1bGVzIGF0ICR7aW50ZXJuYWx9OiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBlcnJ9YClcbiAgfVxuXG4gIC8vIE9ubHkgc3RhbXAgbWFya2VyIGlmIHdlIGFjdHVhbGx5IGxpbmtlZCBzb21ldGhpbmcgXHUyMDE0IGF2b2lkcyBjYWNoaW5nIGEgYnJva2VuIHN0YXRlXG4gIGlmIChsaW5rZWRDb3VudCA+IDApIHtcbiAgICB0cnkgeyB3cml0ZUZpbGVTeW5jKG1hcmtlciwgZmluZ2VycHJpbnQpIH0gY2F0Y2ggeyAvKiBub24tZmF0YWwgKi8gfVxuICB9XG59XG5cbi8qKiBCdWlsZCBhIGNhY2hlIGZpbmdlcnByaW50IGZyb20gcGFja2FnZVJvb3QgKyBzb3J0ZWQgZW50cnkgbmFtZXMgb2YgYm90aCBkaXJlY3RvcmllcyAqL1xuZXhwb3J0IGZ1bmN0aW9uIG1lcmdlZEZpbmdlcnByaW50KGhvaXN0ZWQ6IHN0cmluZywgaW50ZXJuYWw6IHN0cmluZyk6IHN0cmluZyB7XG4gIHRyeSB7XG4gICAgY29uc3QgaCA9IHJlYWRkaXJTeW5jKGhvaXN0ZWQpLnNvcnQoKS5qb2luKCcsJylcbiAgICBjb25zdCBpID0gcmVhZGRpclN5bmMoaW50ZXJuYWwpLnNvcnQoKS5qb2luKCcsJylcbiAgICByZXR1cm4gYCR7cGFja2FnZVJvb3R9XFxuJHtofVxcbiR7aX1gXG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBwYWNrYWdlUm9vdCAgLy8gZmFsbGJhY2s6IGF0IGxlYXN0IGludmFsaWRhdGUgb24gdmVyc2lvbiBjaGFuZ2VcbiAgfVxufVxuXG4vKipcbiAqIFBydW5lIHJvb3QtbGV2ZWwgZXh0ZW5zaW9uIGZpbGVzIHRoYXQgd2VyZSBpbnN0YWxsZWQgYnkgYSBwcmV2aW91cyBHU0QgdmVyc2lvblxuICogYnV0IGhhdmUgc2luY2UgYmVlbiByZW1vdmVkIG9yIHJlbG9jYXRlZCB0byBhIHN1YmRpcmVjdG9yeS5cbiAqXG4gKiBUd28gc3RyYXRlZ2llczpcbiAqIDEuIE1hbmlmZXN0LWJhc2VkIChwcmVmZXJyZWQpOiB0aGUgbWFuaWZlc3QgcmVjb3JkcyB3aGljaCByb290IGZpbGVzIHdlcmUgaW5zdGFsbGVkXG4gKiAgICBsYXN0IHRpbWU7IGFueSB0aGF0IGFyZSBubyBsb25nZXIgaW4gdGhlIGN1cnJlbnQgYnVuZGxlIGFyZSBkZWxldGVkLlxuICogMi4gS25vd24tc3RhbGUgZmFsbGJhY2s6IGZvciB1cGdyYWRlcyBmcm9tIHZlcnNpb25zIGJlZm9yZSBtYW5pZmVzdCB0cmFja2luZyxcbiAqICAgIGV4cGxpY2l0bHkgZGVsZXRlIGZpbGVzIGtub3duIHRvIGhhdmUgYmVlbiBtb3ZlZCAoZS5nLiBlbnYtdXRpbHMuanMgXHUyMTkyIGdzZC8pLlxuICovXG5mdW5jdGlvbiBwcnVuZVJlbW92ZWRCdW5kbGVkRXh0ZW5zaW9ucyhcbiAgbWFuaWZlc3Q6IE1hbmFnZWRSZXNvdXJjZU1hbmlmZXN0IHwgbnVsbCxcbiAgYWdlbnREaXI6IHN0cmluZyxcbik6IHZvaWQge1xuICBjb25zdCBleHRlbnNpb25zRGlyID0gam9pbihhZ2VudERpciwgJ2V4dGVuc2lvbnMnKVxuICBpZiAoIWV4aXN0c1N5bmMoZXh0ZW5zaW9uc0RpcikpIHJldHVyblxuXG4gIC8vIEN1cnJlbnQgYnVuZGxlZCByb290LWxldmVsIGZpbGVzICh3aGF0IHRoZSBuZXcgdmVyc2lvbiBwcm92aWRlcylcbiAgY29uc3QgY3VycmVudFNvdXJjZUZpbGVzID0gbmV3IFNldDxzdHJpbmc+KClcbiAgLy8gQ3VycmVudCBidW5kbGVkIHN1YmRpcmVjdG9yeSBleHRlbnNpb25zXG4gIGNvbnN0IGN1cnJlbnRTb3VyY2VEaXJzID0gbmV3IFNldDxzdHJpbmc+KClcbiAgdHJ5IHtcbiAgICBpZiAoZXhpc3RzU3luYyhidW5kbGVkRXh0ZW5zaW9uc0RpcikpIHtcbiAgICAgIGZvciAoY29uc3QgZSBvZiByZWFkZGlyU3luYyhidW5kbGVkRXh0ZW5zaW9uc0RpciwgeyB3aXRoRmlsZVR5cGVzOiB0cnVlIH0pKSB7XG4gICAgICAgIGlmIChlLmlzRmlsZSgpKSBjdXJyZW50U291cmNlRmlsZXMuYWRkKGUubmFtZSlcbiAgICAgICAgaWYgKGUuaXNEaXJlY3RvcnkoKSkgY3VycmVudFNvdXJjZURpcnMuYWRkKGUubmFtZSlcbiAgICAgIH1cbiAgICB9XG4gIH0gY2F0Y2ggeyAvKiBub24tZmF0YWwgKi8gfVxuXG4gIGNvbnN0IHJlbW92ZUZpbGVJZlN0YWxlID0gKGZpbGVOYW1lOiBzdHJpbmcpID0+IHtcbiAgICBpZiAoY3VycmVudFNvdXJjZUZpbGVzLmhhcyhmaWxlTmFtZSkpIHJldHVybiAgLy8gc3RpbGwgaW4gYnVuZGxlLCBub3Qgc3RhbGVcbiAgICBjb25zdCBzdGFsZSA9IGpvaW4oZXh0ZW5zaW9uc0RpciwgZmlsZU5hbWUpXG4gICAgdHJ5IHsgaWYgKGV4aXN0c1N5bmMoc3RhbGUpKSBybVN5bmMoc3RhbGUsIHsgZm9yY2U6IHRydWUgfSkgfSBjYXRjaCB7IC8qIG5vbi1mYXRhbCAqLyB9XG4gIH1cblxuICBjb25zdCByZW1vdmVEaXJJZlN0YWxlID0gKGRpck5hbWU6IHN0cmluZykgPT4ge1xuICAgIGlmIChjdXJyZW50U291cmNlRGlycy5oYXMoZGlyTmFtZSkpIHJldHVybiAgLy8gc3RpbGwgaW4gYnVuZGxlLCBub3Qgc3RhbGVcbiAgICBjb25zdCBzdGFsZSA9IGpvaW4oZXh0ZW5zaW9uc0RpciwgZGlyTmFtZSlcbiAgICB0cnkgeyBpZiAoZXhpc3RzU3luYyhzdGFsZSkpIHJtU3luYyhzdGFsZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pIH0gY2F0Y2ggeyAvKiBub24tZmF0YWwgKi8gfVxuICB9XG5cbiAgaWYgKG1hbmlmZXN0Py5pbnN0YWxsZWRFeHRlbnNpb25Sb290RmlsZXMpIHtcbiAgICAvLyBNYW5pZmVzdC1iYXNlZDogcmVtb3ZlIHByZXZpb3VzbHktaW5zdGFsbGVkIHJvb3QgZmlsZXMgdGhhdCBhcmUgbm8gbG9uZ2VyIGJ1bmRsZWRcbiAgICBmb3IgKGNvbnN0IHByZXZGaWxlIG9mIG1hbmlmZXN0Lmluc3RhbGxlZEV4dGVuc2lvblJvb3RGaWxlcykge1xuICAgICAgcmVtb3ZlRmlsZUlmU3RhbGUocHJldkZpbGUpXG4gICAgfVxuICB9XG5cbiAgaWYgKG1hbmlmZXN0Py5pbnN0YWxsZWRFeHRlbnNpb25EaXJzKSB7XG4gICAgLy8gTWFuaWZlc3QtYmFzZWQ6IHJlbW92ZSBwcmV2aW91c2x5LWluc3RhbGxlZCBzdWJkaXJlY3RvcnkgZXh0ZW5zaW9ucyB0aGF0IGFyZSBubyBsb25nZXIgYnVuZGxlZFxuICAgIGZvciAoY29uc3QgcHJldkRpciBvZiBtYW5pZmVzdC5pbnN0YWxsZWRFeHRlbnNpb25EaXJzKSB7XG4gICAgICByZW1vdmVEaXJJZlN0YWxlKHByZXZEaXIpXG4gICAgfVxuICB9XG5cbiAgLy8gU3dlZXAtYmFzZWQ6IGFsc28gcmVtb3ZlIGFueSBpbnN0YWxsZWQgZXh0ZW5zaW9uIHN1YmRpcmVjdG9yeSBub3QgaW4gdGhlIGN1cnJlbnQgYnVuZGxlLFxuICAvLyBldmVuIGlmIGl0IHdhcyBuZXZlciB0cmFja2VkIGluIHRoZSBtYW5pZmVzdCAoZS5nLiBpbnN0YWxsZWQgYnkgYSBwcmUtbWFuaWZlc3QgdmVyc2lvbikuXG4gIHRyeSB7XG4gICAgaWYgKGV4aXN0c1N5bmMoZXh0ZW5zaW9uc0RpcikpIHtcbiAgICAgIGZvciAoY29uc3QgZSBvZiByZWFkZGlyU3luYyhleHRlbnNpb25zRGlyLCB7IHdpdGhGaWxlVHlwZXM6IHRydWUgfSkpIHtcbiAgICAgICAgaWYgKGUuaXNEaXJlY3RvcnkoKSkgcmVtb3ZlRGlySWZTdGFsZShlLm5hbWUpXG4gICAgICB9XG4gICAgfVxuICB9IGNhdGNoIHsgLyogbm9uLWZhdGFsICovIH1cblxuICAvLyBBbHdheXMgcmVtb3ZlIGtub3duIHN0YWxlIGZpbGVzIHJlZ2FyZGxlc3Mgb2YgbWFuaWZlc3Qgc3RhdGUuXG4gIC8vIFRoZXNlIHdlcmUgaW5zdGFsbGVkIGJ5IHByZS1tYW5pZmVzdCB2ZXJzaW9ucyBzbyB0aGV5IG1heSBub3QgYXBwZWFyIGluXG4gIC8vIGluc3RhbGxlZEV4dGVuc2lvblJvb3RGaWxlcyBldmVuIHdoZW4gYSBtYW5pZmVzdCBleGlzdHMuXG4gIC8vIGVudi11dGlscy5qcyB3YXMgbW92ZWQgZnJvbSBleHRlbnNpb25zLyByb290IFx1MjE5MiBnc2QvIGluIHYyLjM5LnggKCMxNjM0KVxuICByZW1vdmVGaWxlSWZTdGFsZSgnZW52LXV0aWxzLmpzJylcbn1cblxuLyoqXG4gKiBTeW5jcyBhbGwgYnVuZGxlZCByZXNvdXJjZXMgdG8gYWdlbnREaXIgKH4vLmdzZC9hZ2VudC8pIG9uIGV2ZXJ5IGxhdW5jaC5cbiAqXG4gKiAtIGV4dGVuc2lvbnMvIFx1MjE5MiB+Ly5nc2QvYWdlbnQvZXh0ZW5zaW9ucy8gICAob3ZlcndyaXRlIHdoZW4gdmVyc2lvbiBjaGFuZ2VzKVxuICogLSBhZ2VudHMvICAgICBcdTIxOTIgfi8uZ3NkL2FnZW50L2FnZW50cy8gICAgICAgIChvdmVyd3JpdGUgd2hlbiB2ZXJzaW9uIGNoYW5nZXMpXG4gKiAtIEdTRC1XT1JLRkxPVy5tZCBcdTIxOTIgfi8uZ3NkL2FnZW50L0dTRC1XT1JLRkxPVy5tZCAoZmFsbGJhY2sgZm9yIGVudiB2YXIgbWlzcylcbiAqXG4gKiBTa2lsbHMgYXJlIE5PVCBzeW5jZWQgaGVyZS4gVGhleSBhcmUgaW5zdGFsbGVkIGJ5IHRoZSB1c2VyIHZpYSB0aGVcbiAqIHNraWxscy5zaCBDTEkgKGBucHggc2tpbGxzIGFkZCA8cmVwbz5gKSBpbnRvIH4vLmFnZW50cy9za2lsbHMvIFx1MjAxNCB0aGVcbiAqIGluZHVzdHJ5LXN0YW5kYXJkIEFnZW50IFNraWxscyBlY29zeXN0ZW0gZGlyZWN0b3J5LlxuICpcbiAqIFNraXBzIHRoZSBjb3B5IHdoZW4gdGhlIG1hbmFnZWQtcmVzb3VyY2VzLmpzb24gdmVyc2lvbiBtYXRjaGVzIHRoZSBjdXJyZW50XG4gKiBHU0QgdmVyc2lvbiwgYXZvaWRpbmcgfjEyOG1zIG9mIHN5bmNocm9ub3VzIGNwU3luYyBvbiBldmVyeSBzdGFydHVwLlxuICogQWZ0ZXIgYG5wbSB1cGRhdGUgLWcgQGdsaXR0ZXJjb3dib3kvZ3NkYCwgdmVyc2lvbnMgd2lsbCBkaWZmZXIgYW5kIHRoZVxuICogY29weSBydW5zIG9uY2UgdG8gbGFuZCB0aGUgbmV3IHJlc291cmNlcy5cbiAqXG4gKiBJbnNwZWN0YWJsZTogYGxzIH4vLmdzZC9hZ2VudC9leHRlbnNpb25zL2BcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGluaXRSZXNvdXJjZXMoYWdlbnREaXI6IHN0cmluZywgc2tpbGxzRGlyOiBzdHJpbmcgPSBqb2luKGhvbWVkaXIoKSwgJy5hZ2VudHMnLCAnc2tpbGxzJykpOiB2b2lkIHtcbiAgbWtkaXJTeW5jKGFnZW50RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KVxuXG4gIGNvbnN0IGN1cnJlbnRWZXJzaW9uID0gZ2V0QnVuZGxlZEdzZFZlcnNpb24oKVxuICBjb25zdCBtYW5pZmVzdCA9IHJlYWRNYW5hZ2VkUmVzb3VyY2VNYW5pZmVzdChhZ2VudERpcilcbiAgY29uc3QgZXh0ZW5zaW9uc0RpciA9IGpvaW4oYWdlbnREaXIsICdleHRlbnNpb25zJylcblxuICAvLyBBbHdheXMgcHJ1bmUgcm9vdC1sZXZlbCBleHRlbnNpb24gZmlsZXMgdGhhdCB3ZXJlIHJlbW92ZWQgZnJvbSB0aGUgYnVuZGxlLlxuICAvLyBUaGlzIGlzIGNoZWFwIChhIGZldyBleGlzdGVuY2UgY2hlY2tzICsgYXQgbW9zdCBvbmUgcm1TeW5jKSBhbmQgbXVzdCBydW5cbiAgLy8gdW5jb25kaXRpb25hbGx5IHNvIHRoYXQgc3RhbGUgZmlsZXMgbGVmdCBieSBhIHByZXZpb3VzIHZlcnNpb24gYXJlIGNsZWFuZWRcbiAgLy8gdXAgZXZlbiB3aGVuIHRoZSB2ZXJzaW9uL2hhc2ggbWF0Y2ggY2F1c2VzIHRoZSBmdWxsIHN5bmMgdG8gYmUgc2tpcHBlZC5cbiAgcHJ1bmVSZW1vdmVkQnVuZGxlZEV4dGVuc2lvbnMobWFuaWZlc3QsIGFnZW50RGlyKVxuICBwcnVuZVN0YWxlU2libGluZ0ZpbGVzKGJ1bmRsZWRFeHRlbnNpb25zRGlyLCBleHRlbnNpb25zRGlyKVxuXG4gIC8vIEVuc3VyZSB+Ly5nc2QvYWdlbnQvbm9kZV9tb2R1bGVzIHN5bWxpbmtzIHRvIEdTRCdzIG5vZGVfbW9kdWxlcyBvbiBFVkVSWVxuICAvLyBsYXVuY2gsIG5vdCBqdXN0IGR1cmluZyByZXNvdXJjZSBzeW5jcy4gQSBzdGFsZS9icm9rZW4gc3ltbGluayBtYWtlcyBBTExcbiAgLy8gZXh0ZW5zaW9ucyBmYWlsIHRvIHJlc29sdmUgQGdzZC8qIHBhY2thZ2VzLCByZW5kZXJpbmcgR1NEIG5vbi1mdW5jdGlvbmFsLlxuICBlbnN1cmVOb2RlTW9kdWxlc1N5bWxpbmsoYWdlbnREaXIpXG5cbiAgLy8gTWlncmF0ZSBsZWdhY3kgc2tpbGxzIG9uIGV2ZXJ5IGxhdW5jaCAobm90IGdhdGVkIGJ5IG1hbmlmZXN0KSBzbyB0aGF0XG4gIC8vIHBhcnRpYWwtZmFpbHVyZSByZXRyaWVzIGRvbid0IHdhaXQgZm9yIGEgdmVyc2lvbiBidW1wLlxuICBtaWdyYXRlU2tpbGxzVG9FY29zeXN0ZW1EaXIoYWdlbnREaXIpXG5cbiAgLy8gU2tpcCB0aGUgZnVsbCBjb3B5IHdoZW4gYm90aCB2ZXJzaW9uIEFORCBjb250ZW50IGZpbmdlcnByaW50IG1hdGNoLlxuICAvLyBWZXJzaW9uLW9ubHkgY2hlY2tzIG1pc3Mgc2FtZS12ZXJzaW9uIGNvbnRlbnQgY2hhbmdlcyAobnBtIGxpbmsgZGV2IHdvcmtmbG93LFxuICAvLyBob3RmaXhlcyB3aXRoaW4gYSByZWxlYXNlKS4gVGhlIGNvbnRlbnQgaGFzaCBjYXRjaGVzIHRob3NlIGF0IH4xbXMgY29zdC5cbiAgaWYgKG1hbmlmZXN0ICYmIG1hbmlmZXN0LmdzZFZlcnNpb24gPT09IGN1cnJlbnRWZXJzaW9uKSB7XG4gICAgLy8gVmVyc2lvbiBtYXRjaGVzIFx1MjAxNCBjaGVjayBjb250ZW50IGZpbmdlcnByaW50IGZvciBzYW1lLXZlcnNpb24gc3RhbGVuZXNzLlxuICAgIGNvbnN0IGN1cnJlbnRIYXNoID0gZ2V0Q3VycmVudFJlc291cmNlRmluZ2VycHJpbnQoKVxuICAgIGNvbnN0IGhhc1N0YWxlRXh0ZW5zaW9uRmlsZXMgPSBoYXNTdGFsZUNvbXBpbGVkRXh0ZW5zaW9uU2libGluZ3MoZXh0ZW5zaW9uc0RpciwgYnVuZGxlZEV4dGVuc2lvbnNEaXIpXG4gICAgaWYgKG1hbmlmZXN0LmNvbnRlbnRIYXNoICYmIG1hbmlmZXN0LmNvbnRlbnRIYXNoID09PSBjdXJyZW50SGFzaCAmJiAhaGFzU3RhbGVFeHRlbnNpb25GaWxlcykge1xuICAgICAgcmV0dXJuXG4gICAgfVxuICB9XG5cbiAgLy8gU3luYyBidW5kbGVkIHJlc291cmNlcyBcdTIwMTQgb3ZlcndyaXRlIHNvIHVwZGF0ZXMgbGFuZCBvbiBuZXh0IGxhdW5jaC5cblxuICBzeW5jUmVzb3VyY2VEaXIoYnVuZGxlZEV4dGVuc2lvbnNEaXIsIGpvaW4oYWdlbnREaXIsICdleHRlbnNpb25zJykpXG4gIHN5bmNSZXNvdXJjZURpcihqb2luKHJlc291cmNlc0RpciwgJ2FnZW50cycpLCBqb2luKGFnZW50RGlyLCAnYWdlbnRzJykpXG4gIHN5bmNSZXNvdXJjZURpcihqb2luKHJlc291cmNlc0RpciwgJ3NraWxscycpLCBza2lsbHNEaXIpXG5cbiAgLy8gU3luYyBHU0QtV09SS0ZMT1cubWQgdG8gYWdlbnREaXIgYXMgYSBmYWxsYmFjayBmb3Igd2hlbiBHU0RfV09SS0ZMT1dfUEFUSFxuICAvLyBlbnYgdmFyIGlzIG5vdCBzZXQgKGUuZy4gZm9yay9kZXYgYnVpbGRzLCBhbHRlcm5hdGl2ZSBlbnRyeSBwb2ludHMpLlxuICBjb25zdCB3b3JrZmxvd1NyYyA9IGpvaW4ocmVzb3VyY2VzRGlyLCAnR1NELVdPUktGTE9XLm1kJylcbiAgaWYgKGV4aXN0c1N5bmMod29ya2Zsb3dTcmMpKSB7XG4gICAgdHJ5IHsgY29weUZpbGVTeW5jKHdvcmtmbG93U3JjLCBqb2luKGFnZW50RGlyLCAnR1NELVdPUktGTE9XLm1kJykpIH0gY2F0Y2ggeyAvKiBub24tZmF0YWwgKi8gfVxuICB9XG5cbiAgLy8gRW5zdXJlIGFsbCBuZXdseSBjb3BpZWQgZmlsZXMgYXJlIG93bmVyLXdyaXRhYmxlIHNvIHRoZSBuZXh0IHJ1biBjYW5cbiAgLy8gb3ZlcndyaXRlIHRoZW0gKGNvdmVycyBleHRlbnNpb25zLCBhZ2VudHMsIGFuZCBza2lsbHMgaW4gb25lIHdhbGspLlxuICBtYWtlVHJlZVdyaXRhYmxlKGFnZW50RGlyKVxuXG4gIHdyaXRlTWFuYWdlZFJlc291cmNlTWFuaWZlc3QoYWdlbnREaXIpXG4gIGVuc3VyZVJlZ2lzdHJ5RW50cmllcyhqb2luKGFnZW50RGlyLCAnZXh0ZW5zaW9ucycpKVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgTGVnYWN5IFNraWxsIE1pZ3JhdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBPbmUtdGltZSBtaWdyYXRpb246IGNvcHkgdXNlci1jdXN0b21pemVkIHNraWxscyBmcm9tIHRoZSBvbGRcbiAqIH4vLmdzZC9hZ2VudC9za2lsbHMvIGRpcmVjdG9yeSBpbnRvIH4vLmFnZW50cy9za2lsbHMvLlxuICpcbiAqIFRoZSBtaWdyYXRpb24gaXMgY29uc2VydmF0aXZlOlxuICogIC0gT25seSBza2lsbCBkaXJlY3RvcmllcyBjb250YWluaW5nIGEgU0tJTEwubWQgYXJlIGNvbnNpZGVyZWQuXG4gKiAgLSBDb3BpZXMsIGRvZXMgbm90IG1vdmUgXHUyMDE0IHRoZSBvbGQgZGlyZWN0b3J5IHN0YXlzIGludGFjdCBzbyBkb3duZ3JhZGluZ1xuICogICAgdG8gYSBwcmUtbWlncmF0aW9uIEdTRCB2ZXJzaW9uIHN0aWxsIHdvcmtzLlxuICogIC0gQ29sbGlzaW9uLXNhZmUgXHUyMDE0IGlmIGEgc2tpbGwgbmFtZSBhbHJlYWR5IGV4aXN0cyBpbiB0aGUgdGFyZ2V0LCB0aGVcbiAqICAgIGV4aXN0aW5nIGVjb3N5c3RlbSBza2lsbCB3aW5zICh1c2VyIG1heSBoYXZlIGFscmVhZHkgaW5zdGFsbGVkIGEgbmV3ZXJcbiAqICAgIHZlcnNpb24gdmlhIHNraWxscy5zaCkuXG4gKiAgLSBXcml0ZXMgYSBgLm1pZ3JhdGVkLXRvLWFnZW50c2AgbWFya2VyIGluc2lkZSB0aGUgbGVnYWN5IGRpcmVjdG9yeSBzb1xuICogICAgdGhlIG1pZ3JhdGlvbiBydW5zIGF0IG1vc3Qgb25jZS5cbiAqL1xuZnVuY3Rpb24gbWlncmF0ZVNraWxsc1RvRWNvc3lzdGVtRGlyKGFnZW50RGlyOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgbGVnYWN5RGlyID0gam9pbihhZ2VudERpciwgJ3NraWxscycpXG4gIGNvbnN0IG1hcmtlclBhdGggPSBqb2luKGxlZ2FjeURpciwgJy5taWdyYXRlZC10by1hZ2VudHMnKVxuXG4gIC8vIEFscmVhZHkgbWlncmF0ZWQgb3Igbm8gbGVnYWN5IGRpciBcdTIwMTQgbm90aGluZyB0byBkb1xuICBpZiAoIWV4aXN0c1N5bmMobGVnYWN5RGlyKSkgcmV0dXJuXG5cbiAgLy8gQXRvbWljIG1hcmtlciBjaGVjayBcdTIwMTQgJ3d4JyBmYWlscyBpZiBmaWxlIGFscmVhZHkgZXhpc3RzLCBwcmV2ZW50aW5nIHJhY2VzXG4gIC8vIHdoZW4gdHdvIEdTRCBwcm9jZXNzZXMgc3RhcnQgc2ltdWx0YW5lb3VzbHkuXG4gIGxldCBtYXJrZXJGZDogbnVtYmVyXG4gIHRyeSB7XG4gICAgbWFya2VyRmQgPSBvcGVuU3luYyhtYXJrZXJQYXRoLCAnd3gnKVxuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gLy8gbWFya2VyIGFscmVhZHkgZXhpc3RzIChhbm90aGVyIHByb2Nlc3Mgd29uIHRoZSByYWNlLCBvciBhbHJlYWR5IG1pZ3JhdGVkKVxuICB9XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBlY29zeXN0ZW1EaXIgPSBqb2luKGhvbWVkaXIoKSwgJy5hZ2VudHMnLCAnc2tpbGxzJylcbiAgICBta2RpclN5bmMoZWNvc3lzdGVtRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KVxuXG4gICAgY29uc3QgZW50cmllcyA9IHJlYWRkaXJTeW5jKGxlZ2FjeURpciwgeyB3aXRoRmlsZVR5cGVzOiB0cnVlIH0pXG4gICAgbGV0IG1pZ3JhdGVkID0gMFxuICAgIGxldCBjYW5kaWRhdGVzID0gMFxuICAgIGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xuICAgICAgLy8gSGFuZGxlIGJvdGggcmVhbCBkaXJlY3RvcmllcyBhbmQgc3ltbGlua3MgcG9pbnRpbmcgdG8gZGlyZWN0b3JpZXNcbiAgICAgIGNvbnN0IGlzRGlyID0gZW50cnkuaXNEaXJlY3RvcnkoKVxuICAgICAgY29uc3QgaXNTeW1saW5rID0gZW50cnkuaXNTeW1ib2xpY0xpbmsoKVxuICAgICAgaWYgKCFpc0RpciAmJiAhaXNTeW1saW5rKSBjb250aW51ZVxuXG4gICAgICBjb25zdCBzb3VyY2VQYXRoID0gam9pbihsZWdhY3lEaXIsIGVudHJ5Lm5hbWUpXG5cbiAgICAgIC8vIEZvciBzeW1saW5rcywgdmVyaWZ5IHRoZSB0YXJnZXQgaXMgYSBkaXJlY3RvcnlcbiAgICAgIGlmIChpc1N5bWxpbmspIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBzdGF0ID0gc3RhdFN5bmMoc291cmNlUGF0aClcbiAgICAgICAgICBpZiAoIXN0YXQuaXNEaXJlY3RvcnkoKSkgY29udGludWVcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgY29udGludWUgLy8gYnJva2VuIHN5bWxpbmsgXHUyMDE0IHNraXBcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBjb25zdCBza2lsbE1kID0gam9pbihzb3VyY2VQYXRoLCAnU0tJTEwubWQnKVxuICAgICAgaWYgKCFleGlzdHNTeW5jKHNraWxsTWQpKSBjb250aW51ZVxuXG4gICAgICBjb25zdCB0YXJnZXQgPSBqb2luKGVjb3N5c3RlbURpciwgZW50cnkubmFtZSlcbiAgICAgIGlmIChleGlzdHNTeW5jKHRhcmdldCkpIGNvbnRpbnVlIC8vIGVjb3N5c3RlbSB2ZXJzaW9uIHdpbnNcblxuICAgICAgY2FuZGlkYXRlcysrXG4gICAgICB0cnkge1xuICAgICAgICBpZiAoaXNTeW1saW5rKSB7XG4gICAgICAgICAgLy8gUmVjcmVhdGUgdGhlIHN5bWxpbmsgaW4gdGhlIGVjb3N5c3RlbSBkaXJlY3RvcnkgdXNpbmcgYW4gYWJzb2x1dGVcbiAgICAgICAgICAvLyB0YXJnZXQuIFJlbGF0aXZlIHN5bWxpbmtzIHdvdWxkIHJlc29sdmUgZnJvbSB0aGUgbmV3IHBhcmVudCBkaXJcbiAgICAgICAgICAvLyAofi8uYWdlbnRzL3NraWxscy8pIGluc3RlYWQgb2YgdGhlIG9yaWdpbmFsICh+Ly5nc2QvYWdlbnQvc2tpbGxzLyksXG4gICAgICAgICAgLy8gcG9pbnRpbmcgdG8gdGhlIHdyb25nIGxvY2F0aW9uLlxuICAgICAgICAgIGNvbnN0IHJhd1RhcmdldCA9IHJlYWRsaW5rU3luYyhzb3VyY2VQYXRoKVxuICAgICAgICAgIGNvbnN0IGFic1RhcmdldCA9IHJlc29sdmUoZGlybmFtZShzb3VyY2VQYXRoKSwgcmF3VGFyZ2V0KVxuICAgICAgICAgIHN5bWxpbmtTeW5jKGFic1RhcmdldCwgdGFyZ2V0KVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGNwU3luYyhzb3VyY2VQYXRoLCB0YXJnZXQsIHsgcmVjdXJzaXZlOiB0cnVlIH0pXG4gICAgICAgIH1cbiAgICAgICAgbWlncmF0ZWQrK1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIG5vbi1mYXRhbCBcdTIwMTQgc2tpcCB0aGlzIHNraWxsXG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gSWYgYW55IHNraWxscyBmYWlsZWQgdG8gY29weSwgcmVtb3ZlIHRoZSBtYXJrZXIgc28gbWlncmF0aW9uIHJldHJpZXNcbiAgICAvLyBvbiB0aGUgbmV4dCBsYXVuY2guICBUaGlzIGtlZXBzIHRoZSBsZWdhY3kgZGlyIGFzIGZhbGxiYWNrIHVudGlsIGV2ZXJ5XG4gICAgLy8gc2tpbGwgaGFzIGJlZW4gc3VjY2Vzc2Z1bGx5IG1pZ3JhdGVkLlxuICAgIGlmIChtaWdyYXRlZCA8IGNhbmRpZGF0ZXMpIHtcbiAgICAgIHRyeSB7IGNsb3NlU3luYyhtYXJrZXJGZCk7IG1hcmtlckZkID0gLTEgfSBjYXRjaCB7IC8qIG5vbi1mYXRhbCAqLyB9XG4gICAgICB0cnkgeyB1bmxpbmtTeW5jKG1hcmtlclBhdGgpIH0gY2F0Y2ggeyAvKiBub24tZmF0YWwgKi8gfVxuICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgLy8gV3JpdGUgbWlncmF0aW9uIGluZm8gdG8gdGhlIG1hcmtlclxuICAgIHRyeSB7IHdyaXRlRmlsZVN5bmMobWFya2VyRmQsIGBNaWdyYXRlZCAke21pZ3JhdGVkfSBza2lsbChzKSB0byAke2Vjb3N5c3RlbURpcn0gb24gJHtuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCl9XFxuYCkgfSBjYXRjaCB7IC8qIG5vbi1mYXRhbCAqLyB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIGNhbid0IGNyZWF0ZSBlY29zeXN0ZW0gZGlyIG9yIHJlYWQgbGVnYWN5IGRpciBcdTIwMTQgY2xvc2UgZmQgZmlyc3QgKHJlcXVpcmVkIG9uIFdpbmRvd3NcbiAgICAvLyB3aGVyZSB1bmxpbmtTeW5jIGZhaWxzIG9uIG9wZW4gaGFuZGxlcyksIHRoZW4gcmVtb3ZlIG1hcmtlciBzbyB3ZSByZXRyeSBuZXh0IGxhdW5jaFxuICAgIHRyeSB7IGNsb3NlU3luYyhtYXJrZXJGZCk7IG1hcmtlckZkID0gLTEgfSBjYXRjaCB7IC8qIG5vbi1mYXRhbCAqLyB9XG4gICAgdHJ5IHsgdW5saW5rU3luYyhtYXJrZXJQYXRoKSB9IGNhdGNoIHsgLyogbm9uLWZhdGFsICovIH1cbiAgfSBmaW5hbGx5IHtcbiAgICBpZiAobWFya2VyRmQgIT09IC0xKSB7IHRyeSB7IGNsb3NlU3luYyhtYXJrZXJGZCkgfSBjYXRjaCB7IC8qIG5vbi1mYXRhbCAqLyB9IH1cbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gaGFzU3RhbGVDb21waWxlZEV4dGVuc2lvblNpYmxpbmdzKGV4dGVuc2lvbnNEaXI6IHN0cmluZywgc291cmNlRGlyOiBzdHJpbmcgPSBidW5kbGVkRXh0ZW5zaW9uc0Rpcik6IGJvb2xlYW4ge1xuICBpZiAoIWV4aXN0c1N5bmMoZXh0ZW5zaW9uc0RpcikpIHJldHVybiBmYWxzZVxuICBjb25zdCBzb3VyY2VGaWxlcyA9IGNvbGxlY3RSZWxhdGl2ZUZpbGVzKHNvdXJjZURpcilcbiAgY29uc3QgaW5zdGFsbGVkRmlsZXMgPSBjb2xsZWN0UmVsYXRpdmVGaWxlcyhleHRlbnNpb25zRGlyKVxuXG4gIGZvciAoY29uc3QgcmVsUGF0aCBvZiBpbnN0YWxsZWRGaWxlcykge1xuICAgIGlmICghcmVsUGF0aC5lbmRzV2l0aCgnLnRzJykgJiYgIXJlbFBhdGguZW5kc1dpdGgoJy5qcycpKSBjb250aW51ZVxuICAgIGlmIChzb3VyY2VGaWxlcy5oYXMocmVsUGF0aCkpIGNvbnRpbnVlXG5cbiAgICBjb25zdCBidW5kbGVkU2libGluZyA9IHJlbFBhdGguZW5kc1dpdGgoJy50cycpXG4gICAgICA/IHJlbFBhdGgucmVwbGFjZSgvXFwudHMkLywgJy5qcycpXG4gICAgICA6IHJlbFBhdGgucmVwbGFjZSgvXFwuanMkLywgJy50cycpXG5cbiAgICBpZiAoc291cmNlRmlsZXMuaGFzKGJ1bmRsZWRTaWJsaW5nKSkgcmV0dXJuIHRydWVcbiAgfVxuXG4gIHJldHVybiBmYWxzZVxufVxuXG5mdW5jdGlvbiBjb2xsZWN0UmVsYXRpdmVGaWxlcyhyb290RGlyOiBzdHJpbmcpOiBTZXQ8c3RyaW5nPiB7XG4gIGNvbnN0IGZpbGVzID0gbmV3IFNldDxzdHJpbmc+KClcbiAgaWYgKCFleGlzdHNTeW5jKHJvb3REaXIpKSByZXR1cm4gZmlsZXNcblxuICBjb25zdCB2aXNpdCA9IChkaXI6IHN0cmluZyk6IHZvaWQgPT4ge1xuICAgIGZvciAoY29uc3QgZW50cnkgb2YgcmVhZGRpclN5bmMoZGlyLCB7IHdpdGhGaWxlVHlwZXM6IHRydWUgfSkpIHtcbiAgICAgIGNvbnN0IGVudHJ5UGF0aCA9IGpvaW4oZGlyLCBlbnRyeS5uYW1lKVxuICAgICAgaWYgKGVudHJ5LmlzRGlyZWN0b3J5KCkpIHtcbiAgICAgICAgdmlzaXQoZW50cnlQYXRoKVxuICAgICAgICBjb250aW51ZVxuICAgICAgfVxuICAgICAgZmlsZXMuYWRkKHJlbGF0aXZlKHJvb3REaXIsIGVudHJ5UGF0aCkucmVwbGFjZUFsbCgnXFxcXCcsICcvJykpXG4gICAgfVxuICB9XG5cbiAgdmlzaXQocm9vdERpcilcbiAgcmV0dXJuIGZpbGVzXG59XG5cbi8qKlxuICogQ29uc3RydWN0cyBhIERlZmF1bHRSZXNvdXJjZUxvYWRlciB0aGF0IGxvYWRzIGV4dGVuc2lvbnMgZnJvbSBib3RoXG4gKiB+Ly5nc2QvYWdlbnQvZXh0ZW5zaW9ucy8gKEdTRCdzIGRlZmF1bHQpIGFuZCB+Ly5waS9hZ2VudC9leHRlbnNpb25zLyAocGkncyBkZWZhdWx0KS5cbiAqIFRoaXMgYWxsb3dzIHVzZXJzIHRvIHVzZSBleHRlbnNpb25zIGZyb20gZWl0aGVyIGxvY2F0aW9uLlxuICovXG4vLyBDYWNoZSBidW5kbGVkIGV4dGVuc2lvbiBrZXlzIGF0IG1vZHVsZSBsb2FkIFx1MjAxNCBhdm9pZHMgcmUtc2Nhbm5pbmcgdGhlIGV4dGVuc2lvbnNcbi8vIGRpcmVjdG9yeSBpbiBidWlsZFJlc291cmNlTG9hZGVyKCkgKGFscmVhZHkgc2Nhbm5lZCBieSBsb2FkZXIudHMgZm9yIGVudiB2YXIpLlxubGV0IF9idW5kbGVkRXh0ZW5zaW9uS2V5czogU2V0PHN0cmluZz4gfCBudWxsID0gbnVsbFxuZnVuY3Rpb24gZ2V0QnVuZGxlZEV4dGVuc2lvbktleXMoKTogU2V0PHN0cmluZz4ge1xuICBpZiAoIV9idW5kbGVkRXh0ZW5zaW9uS2V5cykge1xuICAgIF9idW5kbGVkRXh0ZW5zaW9uS2V5cyA9IG5ldyBTZXQoXG4gICAgICBkaXNjb3ZlckV4dGVuc2lvbkVudHJ5UGF0aHMoYnVuZGxlZEV4dGVuc2lvbnNEaXIpLm1hcCgoZW50cnlQYXRoKSA9PiBnZXRFeHRlbnNpb25LZXkoZW50cnlQYXRoLCBidW5kbGVkRXh0ZW5zaW9uc0RpcikpLFxuICAgIClcbiAgfVxuICByZXR1cm4gX2J1bmRsZWRFeHRlbnNpb25LZXlzXG59XG5cbmludGVyZmFjZSBCdWlsZFJlc291cmNlTG9hZGVyT3B0aW9ucyB7XG4gIGFkZGl0aW9uYWxFeHRlbnNpb25QYXRocz86IHN0cmluZ1tdXG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBidWlsZFJlc291cmNlTG9hZGVyKFxuICBhZ2VudERpcjogc3RyaW5nLFxuICBvcHRpb25zOiBCdWlsZFJlc291cmNlTG9hZGVyT3B0aW9ucyA9IHt9LFxuKTogUHJvbWlzZTxEZWZhdWx0UmVzb3VyY2VMb2FkZXJUeXBlPiB7XG4gIGNvbnN0IHsgRGVmYXVsdFJlc291cmNlTG9hZGVyLCBzb3J0RXh0ZW5zaW9uUGF0aHMgfSA9IGF3YWl0IGxvYWRQaUNvZGluZ0FnZW50TW9kdWxlKClcbiAgY29uc3QgcmVnaXN0cnkgPSBsb2FkUmVnaXN0cnkoKVxuICBjb25zdCBwaUFnZW50RGlyID0gam9pbihob21lZGlyKCksICcucGknLCAnYWdlbnQnKVxuICBjb25zdCBwaUV4dGVuc2lvbnNEaXIgPSBqb2luKHBpQWdlbnREaXIsICdleHRlbnNpb25zJylcbiAgY29uc3QgYnVuZGxlZEtleXMgPSBnZXRCdW5kbGVkRXh0ZW5zaW9uS2V5cygpXG4gIGNvbnN0IHBpRXh0ZW5zaW9uUGF0aHMgPSBkaXNjb3ZlckV4dGVuc2lvbkVudHJ5UGF0aHMocGlFeHRlbnNpb25zRGlyKVxuICAgIC5maWx0ZXIoKGVudHJ5UGF0aCkgPT4gIWJ1bmRsZWRLZXlzLmhhcyhnZXRFeHRlbnNpb25LZXkoZW50cnlQYXRoLCBwaUV4dGVuc2lvbnNEaXIpKSlcbiAgICAuZmlsdGVyKChlbnRyeVBhdGgpID0+IHtcbiAgICAgIGNvbnN0IG1hbmlmZXN0ID0gcmVhZE1hbmlmZXN0RnJvbUVudHJ5UGF0aChlbnRyeVBhdGgpXG4gICAgICBpZiAoIW1hbmlmZXN0KSByZXR1cm4gdHJ1ZVxuICAgICAgcmV0dXJuIGlzRXh0ZW5zaW9uRW5hYmxlZChyZWdpc3RyeSwgbWFuaWZlc3QuaWQpXG4gICAgfSlcbiAgY29uc3QgYWRkaXRpb25hbEV4dGVuc2lvblBhdGhzID0gW1xuICAgIC4uLnBpRXh0ZW5zaW9uUGF0aHMsXG4gICAgLi4uKG9wdGlvbnMuYWRkaXRpb25hbEV4dGVuc2lvblBhdGhzID8/IFtdKSxcbiAgXVxuXG4gIHJldHVybiBuZXcgRGVmYXVsdFJlc291cmNlTG9hZGVyKHtcbiAgICBhZ2VudERpcixcbiAgICBhZGRpdGlvbmFsRXh0ZW5zaW9uUGF0aHMsXG4gICAgYnVuZGxlZEV4dGVuc2lvbktleXM6IGJ1bmRsZWRLZXlzLFxuICAgIGV4dGVuc2lvblBhdGhzVHJhbnNmb3JtOiAocGF0aHM6IHN0cmluZ1tdKSA9PiB7XG4gICAgICAvLyAxLiBGaWx0ZXIgY29tbXVuaXR5IGV4dGVuc2lvbnMgdGhyb3VnaCB0aGUgR1NEIHJlZ2lzdHJ5XG4gICAgICBjb25zdCBmaWx0ZXJlZFBhdGhzID0gcGF0aHMuZmlsdGVyKChlbnRyeVBhdGgpID0+IHtcbiAgICAgICAgY29uc3QgbWFuaWZlc3QgPSByZWFkTWFuaWZlc3RGcm9tRW50cnlQYXRoKGVudHJ5UGF0aClcbiAgICAgICAgaWYgKCFtYW5pZmVzdCkgcmV0dXJuIHRydWUgLy8gbm8gbWFuaWZlc3QgPSBhbHdheXMgbG9hZFxuICAgICAgICByZXR1cm4gaXNFeHRlbnNpb25FbmFibGVkKHJlZ2lzdHJ5LCBtYW5pZmVzdC5pZClcbiAgICAgIH0pXG5cbiAgICAgIC8vIDIuIFNvcnQgaW4gdG9wb2xvZ2ljYWwgZGVwZW5kZW5jeSBvcmRlclxuICAgICAgY29uc3QgeyBzb3J0ZWRQYXRocywgd2FybmluZ3MgfSA9IHNvcnRFeHRlbnNpb25QYXRocyhmaWx0ZXJlZFBhdGhzKVxuXG4gICAgICByZXR1cm4ge1xuICAgICAgICBwYXRoczogc29ydGVkUGF0aHMsXG4gICAgICAgIGRpYWdub3N0aWNzOiB3YXJuaW5ncy5tYXAoKHcpID0+IHcubWVzc2FnZSksXG4gICAgICB9XG4gICAgfSxcbiAgfSBhcyBDb25zdHJ1Y3RvclBhcmFtZXRlcnM8dHlwZW9mIERlZmF1bHRSZXNvdXJjZUxvYWRlcj5bMF0pXG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFDQSxTQUFTLGtCQUFrQjtBQUMzQixTQUFTLGVBQWU7QUFDeEIsU0FBUyxXQUFXLGNBQWMsUUFBUSxZQUFZLFdBQVcsV0FBVyxVQUFVLFdBQVcsY0FBYyxjQUFjLGFBQWEsUUFBUSxVQUFVLGFBQWEsWUFBWSxxQkFBcUI7QUFDMU0sU0FBUyxVQUFVLFNBQVMsTUFBTSxVQUFVLGVBQWU7QUFDM0QsU0FBUyxxQkFBcUI7QUFDOUIsU0FBUyxxQkFBcUI7QUFDOUIsU0FBUyxtQ0FBbUM7QUFDNUMsU0FBUyxjQUFjLDJCQUEyQixvQkFBb0IsNkJBQTZCO0FBQ25HLFNBQVMsaURBQWlEO0FBSTFELElBQUk7QUFFSixTQUFTLDBCQUF3RDtBQUMvRCxTQUFRLCtCQUErQixPQUFPLHNCQUFzQjtBQUN0RTtBQVVBLE1BQU0sY0FBYyxRQUFRLFFBQVEsY0FBYyxZQUFZLEdBQUcsQ0FBQyxHQUFHLElBQUk7QUFDekUsTUFBTSxlQUFlLDBDQUEwQyxXQUFXO0FBQzFFLE1BQU0sdUJBQXVCLEtBQUssY0FBYyxZQUFZO0FBQzVELE1BQU0sOEJBQThCO0FBQ3BDLE1BQU0sOEJBQThCO0FBc0JwQyxT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LENBQUMsR0FBRztBQUM3RCxZQUFNLFlBQVksS0FBSyxLQUFLLE1BQU0sSUFBSTtBQUN0QyxVQUFJLE1BQU0sWUFBWSxHQUFHO0FBQ3ZCLGNBQU0sU0FBUztBQUNmO0FBQUEsTUFDRjtBQUNBLFlBQU0sSUFBSSxTQUFTLFNBQVMsU0FBUyxFQUFFLFdBQVcsTUFBTSxHQUFHLENBQUM7QUFBQSxJQUM5RDtBQUFBLEVBQ0Y7QUFFQSxRQUFNLE9BQU87QUFDYixTQUFPO0FBQ1Q7QUFTQSxJQUFJLHdCQUE0QztBQUNoRCxTQUFTLDBCQUF1QztBQUM5QyxNQUFJLENBQUMsdUJBQXVCO0FBQzFCLDRCQUF3QixJQUFJO0FBQUEsTUFDMUIsNEJBQTRCLG9CQUFvQixFQUFFLElBQUksQ0FBQyxjQUFjLGdCQUFnQixXQUFXLG9CQUFvQixDQUFDO0FBQUEsSUFDdkg7QUFBQSxFQUNGO0FBQ0EsU0FBTztBQUNUO0FBTUEsZUFBc0Isb0JBQ3BCLFVBQ0EsVUFBc0MsQ0FBQyxHQUNIO0FBQ3BDLFFBQU0sRUFBRSx1QkFBdUIsbUJBQW1CLElBQUksTUFBTSx3QkFBd0I7QUFDcEYsUUFBTSxXQUFXLGFBQWE7QUFDOUIsUUFBTSxhQUFhLEtBQUssUUFBUSxHQUFHLE9BQU8sT0FBTztBQUNqRCxRQUFNLGtCQUFrQixLQUFLLFlBQVksWUFBWTtBQUNyRCxRQUFNLGNBQWMsd0JBQXdCO0FBQzVDLFFBQU0sbUJBQW1CLDRCQUE0QixlQUFlLEVBQ2pFLE9BQU8sQ0FBQyxjQUFjLENBQUMsWUFBWSxJQUFJLGdCQUFnQixXQUFXLGVBQWUsQ0FBQyxDQUFDLEVBQ25GLE9BQU8sQ0FBQyxjQUFjO0FBQ3JCLFVBQU0sV0FBVywwQkFBMEIsU0FBUztBQUNwRCxRQUFJLENBQUMsU0FBVSxRQUFPO0FBQ3RCLFdBQU8sbUJBQW1CLFVBQVUsU0FBUyxFQUFFO0FBQUEsRUFDakQsQ0FBQztBQUNILFFBQU0sMkJBQTJCO0FBQUEsSUFDL0IsR0FBRztBQUFBLElBQ0gsR0FBSSxRQUFRLDRCQUE0QixDQUFDO0FBQUEsRUFDM0M7QUFFQSxTQUFPLElBQUksc0JBQXNCO0FBQUEsSUFDL0I7QUFBQSxJQUNBO0FBQUEsSUFDQSxzQkFBc0I7QUFBQSxJQUN0Qix5QkFBeUIsQ0FBQyxVQUFvQjtBQUU1QyxZQUFNLGdCQUFnQixNQUFNLE9BQU8sQ0FBQyxjQUFjO0FBQ2hELGNBQU0sV0FBVywwQkFBMEIsU0FBUztBQUNwRCxZQUFJLENBQUMsU0FBVSxRQUFPO0FBQ3RCLGVBQU8sbUJBQW1CLFVBQVUsU0FBUyxFQUFFO0FBQUEsTUFDakQsQ0FBQztBQUdELFlBQU0sRUFBRSxhQUFhLFNBQVMsSUFBSSxtQkFBbUIsYUFBYTtBQUVsRSxhQUFPO0FBQUEsUUFDTCxPQUFPO0FBQUEsUUFDUCxhQUFhLFNBQVMsSUFBSSxDQUFDLE1BQU0sRUFBRSxPQUFPO0FBQUEsTUFDNUM7QUFBQSxJQUNGO0FBQUEsRUFDRixDQUEyRDtBQUM3RDsiLAogICJuYW1lcyI6IFsiZGlzY292ZXJFeHRlbnNpb25FbnRyeVBhdGhzIl0KfQo=
