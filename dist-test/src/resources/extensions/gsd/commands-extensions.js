import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { lockSync, unlockSync } from "proper-lockfile";
import { gsdHome } from "./gsd-home.js";
function isVersionGreater(a, b) {
  const split = (v) => {
    const dash = v.indexOf("-");
    const release = (dash === -1 ? v : v.slice(0, dash)).split(".").map((part) => Number.parseInt(part, 10) || 0);
    const pre = dash === -1 ? null : v.slice(dash + 1);
    return { release, pre };
  };
  const sa = split(a);
  const sb = split(b);
  const len = Math.max(sa.release.length, sb.release.length);
  for (let i = 0; i < len; i++) {
    const ai = sa.release[i] ?? 0;
    const bi = sb.release[i] ?? 0;
    if (ai !== bi) return ai > bi;
  }
  if (sa.pre === null && sb.pre !== null) return true;
  if (sa.pre !== null && sb.pre === null) return false;
  if (sa.pre !== null && sb.pre !== null) return sa.pre > sb.pre;
  return false;
}
function getRegistryPath() {
  return join(gsdHome(), "extensions", "registry.json");
}
function getAgentExtensionsDir() {
  return join(gsdHome(), "agent", "extensions");
}
function loadRegistry() {
  const filePath = getRegistryPath();
  try {
    if (!existsSync(filePath)) return { version: 1, entries: {} };
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && parsed.version === 1 && typeof parsed.entries === "object") {
      return parsed;
    }
    return { version: 1, entries: {} };
  } catch {
    return { version: 1, entries: {} };
  }
}
function saveRegistry(registry) {
  const filePath = getRegistryPath();
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(registry, null, 2), "utf-8");
    renameSync(tmp, filePath);
  } catch {
  }
}
function withRegistryLock(mutate) {
  const filePath = getRegistryPath();
  mkdirSync(dirname(filePath), { recursive: true });
  if (!existsSync(filePath)) {
    writeFileSync(filePath, JSON.stringify({ version: 1, entries: {} }, null, 2), "utf-8");
  }
  lockSync(filePath, { retries: { retries: 5, minTimeout: 50, maxTimeout: 500 } });
  try {
    const registry = loadRegistry();
    const result = mutate(registry);
    saveRegistry(registry);
    return result;
  } finally {
    try {
      unlockSync(filePath);
    } catch {
    }
  }
}
function isEnabled(registry, id) {
  const entry = registry.entries[id];
  if (!entry) return true;
  return entry.enabled;
}
function readManifest(dir) {
  const mPath = join(dir, "extension-manifest.json");
  if (!existsSync(mPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(mPath, "utf-8"));
    if (typeof raw?.id === "string" && typeof raw?.name === "string") return raw;
    return null;
  } catch {
    return null;
  }
}
function validateExtensionPackage(packageDir) {
  const errors = [];
  const warnings = [];
  const pkgPath = join(packageDir, "package.json");
  if (!existsSync(pkgPath)) {
    return { valid: false, errors: ["package.json not found"], warnings };
  }
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  } catch {
    return { valid: false, errors: ["package.json is invalid JSON"], warnings };
  }
  const gsdField = pkg.gsd;
  if (gsdField?.extension !== true) {
    errors.push('package.json missing "gsd": { "extension": true }');
  }
  const piField = pkg.pi;
  const piExtensions = piField?.extensions;
  if (!Array.isArray(piExtensions) || piExtensions.length === 0) {
    errors.push('package.json missing "pi": { "extensions": [...] }');
  } else {
    for (const entry of piExtensions) {
      if (typeof entry === "string") {
        const resolved = join(packageDir, entry);
        if (!existsSync(resolved)) {
          errors.push(`pi.extensions entry not found: ${entry}`);
        }
      }
    }
  }
  for (const field of ["dependencies", "devDependencies"]) {
    const deps = pkg[field] ?? {};
    for (const dep of Object.keys(deps)) {
      if (dep.startsWith("@gsd/")) {
        errors.push(`"${dep}" must be in peerDependencies, not ${field}`);
      }
    }
  }
  return { valid: errors.length === 0, errors, warnings };
}
function discoverManifests() {
  const manifests = /* @__PURE__ */ new Map();
  const dirs = [getAgentExtensionsDir(), getInstalledExtDir()];
  for (const extDir of dirs) {
    if (!existsSync(extDir)) continue;
    for (const entry of readdirSync(extDir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const m = readManifest(join(extDir, entry.name));
      if (m) manifests.set(m.id, m);
    }
  }
  return manifests;
}
function getInstalledExtDir() {
  return join(gsdHome(), "extensions");
}
function detectInstallType(specifier) {
  if (specifier.startsWith("/") || specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("~/")) return "local";
  if (specifier.startsWith("git+") || specifier.startsWith("git://") || specifier.startsWith("github:") || specifier.startsWith("gitlab:") || specifier.startsWith("bitbucket:") || specifier.startsWith("https://") && specifier.endsWith(".git") || specifier.startsWith("http://") && specifier.endsWith(".git")) return "git";
  return "npm";
}
function validateExtensionManifest(pkg, opts = {}) {
  const errors = [];
  if (typeof pkg !== "object" || pkg === null) {
    errors.push({ code: "MISSING_GSD_MARKER", message: 'package.json must declare "gsd": { "extension": true } to be recognized as a GSD extension.', field: "gsd.extension" });
  } else {
    const obj = pkg;
    const gsd = obj.gsd;
    if (typeof gsd !== "object" || gsd === null || gsd.extension !== true) {
      errors.push({ code: "MISSING_GSD_MARKER", message: 'package.json must declare "gsd": { "extension": true } to be recognized as a GSD extension.', field: "gsd.extension" });
    }
  }
  if (opts.extensionId && opts.extensionId.startsWith("gsd.") && opts.allowGsdNamespace !== true) {
    errors.push({ code: "RESERVED_NAMESPACE", message: `Extension ID "${opts.extensionId}" is reserved for GSD core extensions. Use a different namespace for community extensions.`, field: "extensionId" });
  }
  if (typeof pkg === "object" && pkg !== null) {
    const obj = pkg;
    for (const field of ["dependencies", "devDependencies"]) {
      const deps = obj[field];
      if (typeof deps === "object" && deps !== null) {
        for (const pkgName of Object.keys(deps)) {
          if (pkgName.startsWith("@gsd/")) {
            errors.push({ code: "WRONG_DEP_FIELD", message: `"${pkgName}" must not appear in "${field}". Move it to "peerDependencies".`, field });
          }
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}
const SAFE_EXTENSION_ID_RE = /^[A-Za-z0-9._-]+$/;
function isSafeExtensionId(id) {
  if (!id || id === "." || id === "..") return false;
  if (id.includes("/") || id.includes("\\") || id.includes("..")) return false;
  return SAFE_EXTENSION_ID_RE.test(id);
}
function postInstallValidate(destPath, specifier, ctx) {
  const pkgJsonPath = join(destPath, "package.json");
  if (!existsSync(pkgJsonPath)) {
    ctx.ui.notify(`Cannot install "${specifier}": no package.json found.`, "error");
    return null;
  }
  let pkgJson;
  try {
    pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
  } catch {
    ctx.ui.notify(`Cannot install "${specifier}": malformed package.json.`, "error");
    return null;
  }
  const manifest = readManifest(destPath);
  const extensionId = manifest?.id;
  const validation = validateExtensionManifest(pkgJson, { extensionId });
  if (!validation.valid) {
    const msgs = validation.errors.map((e) => e.message).join("\n");
    ctx.ui.notify(`Cannot install "${specifier}": ${msgs}`, "error");
    return null;
  }
  if (!manifest || !extensionId) {
    ctx.ui.notify(`Cannot install "${specifier}": no extension-manifest.json with valid id found.`, "error");
    return null;
  }
  if (!isSafeExtensionId(extensionId)) {
    ctx.ui.notify(
      `Cannot install "${specifier}": extension id "${extensionId}" contains unsafe characters (allowed: alphanumerics, ".", "-", "_").`,
      "error"
    );
    return null;
  }
  return { id: extensionId, manifest };
}
function writeInstalledRegistryEntry(id, manifest, specifier, installType) {
  withRegistryLock((registry) => {
    registry.entries[id] = {
      id,
      enabled: true,
      source: "user",
      version: manifest.version,
      installedFrom: specifier,
      installType
    };
  });
}
function findDependents(targetId, installedExtDir) {
  const dependents = [];
  if (!existsSync(installedExtDir)) return dependents;
  for (const entry of readdirSync(installedExtDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = readManifest(join(installedExtDir, entry.name));
    if (!manifest) continue;
    if (manifest.dependencies?.extensions?.includes(targetId)) {
      dependents.push(manifest.id);
    }
  }
  return dependents;
}
function handleUninstall(id, ctx) {
  if (!id) {
    ctx.ui.notify("Usage: /gsd extensions uninstall <id>", "warning");
    return;
  }
  const result = withRegistryLock((registry) => {
    const entry = registry.entries[id];
    if (!entry || entry.source !== "user") {
      return { ok: false, reason: "not-found" };
    }
    const installedExtDir = getInstalledExtDir();
    const extDir = join(installedExtDir, id);
    const dependents = findDependents(id, installedExtDir);
    try {
      if (existsSync(extDir)) {
        rmSync(extDir, { recursive: true, force: true });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: "rm-failed", msg };
    }
    delete registry.entries[id];
    return { ok: true, dependents };
  });
  if (!result.ok) {
    if (result.reason === "not-found") {
      ctx.ui.notify(
        `Extension "${id}" not found in registry. Run /gsd extensions list to see installed extensions.`,
        "warning"
      );
    } else if (result.reason === "rm-failed") {
      ctx.ui.notify(`Failed to remove extension directory for "${id}": ${result.msg}`, "error");
    }
    return;
  }
  if (result.dependents.length > 0) {
    ctx.ui.notify(
      `Warning: the following installed extensions depend on "${id}": ${result.dependents.join(", ")}. Removed anyway.`,
      "warning"
    );
  }
  ctx.ui.notify(`Uninstalled "${id}". Restart GSD to deactivate.`, "info");
}
async function getLatestNpmVersion(packageName) {
  try {
    const res = await fetch(`https://registry.npmjs.org/${packageName}/latest`, {
      signal: AbortSignal.timeout(5e3)
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.version ?? null;
  } catch {
    return null;
  }
}
async function handleUpdate(id, ctx) {
  const registry = loadRegistry();
  if (id) {
    await updateSingleExtension(id, registry, ctx);
  } else {
    await updateAllExtensions(registry, ctx);
  }
}
async function updateSingleExtension(id, registry, ctx) {
  const entry = registry.entries[id];
  if (!entry || entry.source !== "user") {
    ctx.ui.notify(
      `Extension "${id}" not found in registry. Run /gsd extensions list to see installed extensions.`,
      "warning"
    );
    return;
  }
  if (entry.installType !== "npm") {
    const source = entry.installType ?? "unknown";
    const hint = entry.installedFrom ? `gsd extensions install ${entry.installedFrom}` : `gsd extensions install <specifier>`;
    ctx.ui.notify(
      `"${id}" was installed from ${source}. Reinstall to update: ${hint}`,
      "warning"
    );
    return;
  }
  const current = entry.version ?? "0.0.0";
  const specifier = entry.installedFrom;
  if (!specifier) {
    ctx.ui.notify(`"${id}" has no recorded install source. Reinstall manually.`, "warning");
    return;
  }
  const { name: packageName, pin } = parseNpmSpecifier(specifier);
  if (pin) {
    ctx.ui.notify(
      `"${id}" was installed with a pinned version (${pin}). To update, run: gsd extensions install ${packageName}@<new-version>`,
      "info"
    );
    return;
  }
  const latest = await getLatestNpmVersion(packageName);
  if (!latest) {
    ctx.ui.notify(`Could not fetch latest version for "${id}".`, "warning");
    return;
  }
  if (isVersionGreater(latest, current)) {
    ctx.ui.notify(`Updating "${id}": v${current} \u2192 v${latest}...`, "info");
    await handleInstall(packageName, ctx);
  } else {
    ctx.ui.notify(`"${id}" is already at the latest version (v${current}).`, "info");
  }
}
function parseNpmSpecifier(specifier) {
  const isScoped = specifier.startsWith("@");
  const searchFrom = isScoped ? specifier.indexOf("/") + 1 : 0;
  const atIdx = specifier.indexOf("@", searchFrom);
  if (atIdx === -1) return { name: specifier, pin: null };
  return { name: specifier.slice(0, atIdx), pin: specifier.slice(atIdx + 1) };
}
async function updateAllExtensions(registry, ctx) {
  const userEntries = Object.values(registry.entries).filter((e) => e.source === "user");
  if (userEntries.length === 0) {
    ctx.ui.notify("No user-installed extensions found. Use: gsd extensions install <package> to add one.", "warning");
    return;
  }
  ctx.ui.notify(`Checking ${userEntries.length} installed extension(s) for updates...`, "info");
  let updated = 0;
  let skipped = 0;
  for (const entry of userEntries) {
    if (entry.installType !== "npm") {
      const source = entry.installType ?? "unknown";
      ctx.ui.notify(`  ${entry.id}: installed from ${source} \u2014 reinstall to update`, "info");
      skipped++;
      continue;
    }
    const current = entry.version ?? "0.0.0";
    const packageName = entry.installedFrom;
    if (!packageName) {
      ctx.ui.notify(`  ${entry.id}: no recorded install source \u2014 skip`, "info");
      skipped++;
      continue;
    }
    const latest = await getLatestNpmVersion(packageName);
    if (!latest) {
      ctx.ui.notify(`  ${entry.id}: could not fetch latest version \u2014 skip`, "info");
      skipped++;
      continue;
    }
    if (isVersionGreater(latest, current)) {
      ctx.ui.notify(`  ${entry.id}: v${current} \u2192 v${latest} (updating)`, "info");
      await handleInstall(packageName, ctx);
      updated++;
    } else {
      ctx.ui.notify(`  ${entry.id}: v${current} (already up to date)`, "info");
    }
  }
  ctx.ui.notify(`Updated ${updated} extension(s). ${skipped} skipped (git/local \u2014 reinstall to update).`, "info");
}
async function handleInstall(specifier, ctx) {
  if (!specifier) {
    ctx.ui.notify("Usage: /gsd extensions install <npm-package|git-url|local-path>", "warning");
    return;
  }
  const installType = detectInstallType(specifier);
  const installedExtDir = getInstalledExtDir();
  mkdirSync(installedExtDir, { recursive: true });
  process.stderr.write(`Installing ${specifier}...
`);
  if (installType === "npm") {
    installFromNpm(specifier, installedExtDir, ctx);
  } else if (installType === "git") {
    installFromGit(specifier, installedExtDir, ctx);
  } else {
    installFromLocal(specifier, installedExtDir, ctx);
  }
}
function installFromNpm(specifier, installedExtDir, ctx) {
  const packDir = mkdtempSync(join(tmpdir(), "gsd-install-"));
  let extractDir = null;
  try {
    execFileSync("npm", ["pack", specifier, "--pack-destination", packDir, "--ignore-scripts"], {
      stdio: "pipe",
      encoding: "utf-8"
    });
    const tgzFile = readdirSync(packDir).find((f) => f.endsWith(".tgz"));
    if (!tgzFile) throw new Error("npm pack produced no tarball");
    extractDir = mkdtempSync(join(installedExtDir, "tmp-npm-"));
    execFileSync("tar", ["xzf", join(packDir, tgzFile), "-C", extractDir, "--strip-components=1"], { stdio: "pipe" });
    const validated = postInstallValidate(extractDir, specifier, ctx);
    if (!validated) {
      return;
    }
    const destPath = join(installedExtDir, validated.id);
    if (existsSync(destPath)) {
      rmSync(destPath, { recursive: true, force: true });
    }
    renameSync(extractDir, destPath);
    extractDir = null;
    writeInstalledRegistryEntry(validated.id, validated.manifest, specifier, "npm");
    ctx.ui.notify(`Installed "${validated.id}" v${validated.manifest.version ?? "unknown"}. Restart GSD to activate.`, "info");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Failed to install "${specifier}": ${msg}`, "error");
  } finally {
    if (extractDir && existsSync(extractDir)) {
      try {
        rmSync(extractDir, { recursive: true, force: true });
      } catch {
      }
    }
    rmSync(packDir, { recursive: true, force: true });
  }
}
function installFromGit(gitUrl, installedExtDir, ctx) {
  const tmpDir = join(installedExtDir, `__installing-${Date.now()}`);
  try {
    execFileSync("git", ["clone", "--depth=1", gitUrl, tmpDir], { stdio: "pipe" });
    const dotGit = join(tmpDir, ".git");
    if (existsSync(dotGit)) {
      rmSync(dotGit, { recursive: true, force: true });
    }
    const validated = postInstallValidate(tmpDir, gitUrl, ctx);
    if (!validated) {
      rmSync(tmpDir, { recursive: true, force: true });
      return;
    }
    const destPath = join(installedExtDir, validated.id);
    if (existsSync(destPath)) {
      rmSync(destPath, { recursive: true, force: true });
    }
    renameSync(tmpDir, destPath);
    writeInstalledRegistryEntry(validated.id, validated.manifest, gitUrl, "git");
    ctx.ui.notify(`Installed "${validated.id}" v${validated.manifest.version ?? "unknown"}. Restart GSD to activate.`, "info");
  } catch (err) {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    const msg = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Failed to install "${gitUrl}": ${msg}`, "error");
  }
}
function installFromLocal(localPath, installedExtDir, ctx) {
  const sourcePath = resolve(localPath.startsWith("~/") ? join(homedir(), localPath.slice(2)) : localPath);
  if (!existsSync(sourcePath)) {
    ctx.ui.notify(`Cannot install "${localPath}": path does not exist.`, "error");
    return;
  }
  const tmpDir = join(installedExtDir, `__installing-${Date.now()}`);
  try {
    cpSync(sourcePath, tmpDir, { recursive: true });
    const validated = postInstallValidate(tmpDir, localPath, ctx);
    if (!validated) {
      rmSync(tmpDir, { recursive: true, force: true });
      return;
    }
    const destPath = join(installedExtDir, validated.id);
    if (existsSync(destPath)) {
      rmSync(destPath, { recursive: true, force: true });
    }
    renameSync(tmpDir, destPath);
    writeInstalledRegistryEntry(validated.id, validated.manifest, localPath, "local");
    ctx.ui.notify(`Installed "${validated.id}" v${validated.manifest.version ?? "unknown"}. Restart GSD to activate.`, "info");
  } catch (err) {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    const msg = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Failed to install "${localPath}": ${msg}`, "error");
  }
}
async function handleExtensions(args, ctx) {
  const parts = args.split(/\s+/).filter(Boolean);
  const subCmd = parts[0] ?? "list";
  if (subCmd === "list") {
    handleList(ctx);
    return;
  }
  if (subCmd === "enable") {
    handleEnable(parts[1], ctx);
    return;
  }
  if (subCmd === "disable") {
    handleDisable(parts[1], parts.slice(2).join(" "), ctx);
    return;
  }
  if (subCmd === "info") {
    handleInfo(parts[1], ctx);
    return;
  }
  if (subCmd === "install") {
    await handleInstall(parts[1], ctx);
    return;
  }
  if (subCmd === "uninstall") {
    handleUninstall(parts[1], ctx);
    return;
  }
  if (subCmd === "update") {
    await handleUpdate(parts[1], ctx);
    return;
  }
  if (subCmd === "validate") {
    handleValidate(parts[1], ctx);
    return;
  }
  ctx.ui.notify(
    `Unknown: /gsd extensions ${subCmd}. Usage: /gsd extensions [list|enable|disable|info|install|uninstall|update|validate]`,
    "warning"
  );
}
function handleList(ctx) {
  const manifests = discoverManifests();
  const registry = loadRegistry();
  if (manifests.size === 0) {
    ctx.ui.notify("No extension manifests found.", "warning");
    return;
  }
  const sorted = [...manifests.values()].sort((a, b) => {
    if (a.tier === "core" && b.tier !== "core") return -1;
    if (b.tier === "core" && a.tier !== "core") return 1;
    return a.id.localeCompare(b.id);
  });
  const lines = [];
  const hdr = padRight("Extensions", 38) + padRight("Status", 10) + padRight("Tier", 10) + padRight("Tools", 7) + "Commands";
  lines.push(hdr);
  lines.push("\u2500".repeat(hdr.length));
  for (const m of sorted) {
    const enabled = isEnabled(registry, m.id);
    const status = enabled ? "enabled" : "disabled";
    const toolCount = m.provides?.tools?.length ?? 0;
    const cmdCount = m.provides?.commands?.length ?? 0;
    const label = `${m.id} (${m.name})`;
    lines.push(
      padRight(label, 38) + padRight(status, 10) + padRight(m.tier, 10) + padRight(String(toolCount), 7) + String(cmdCount)
    );
    const regEntry = registry.entries[m.id];
    if (regEntry?.source === "user") {
      const lastLine = lines[lines.length - 1];
      lines[lines.length - 1] = lastLine + "      [user]";
      if (regEntry.installedFrom) {
        const typePrefix = regEntry.installType ? `${regEntry.installType}:` : "";
        const versionSuffix = regEntry.version ? `@${regEntry.version}` : "";
        lines.push(`  installed from: ${typePrefix}${regEntry.installedFrom}${versionSuffix}`);
      }
    }
    if (!enabled) {
      lines.push(`  \u21B3 gsd extensions enable ${m.id}`);
    }
  }
  ctx.ui.notify(lines.join("\n"), "info");
}
function handleEnable(id, ctx) {
  if (!id) {
    ctx.ui.notify("Usage: /gsd extensions enable <id>", "warning");
    return;
  }
  const manifests = discoverManifests();
  if (!manifests.has(id)) {
    ctx.ui.notify(`Extension "${id}" not found. Run /gsd extensions list to see available extensions.`, "warning");
    return;
  }
  const alreadyEnabled = withRegistryLock((registry) => {
    if (isEnabled(registry, id)) return true;
    const entry = registry.entries[id];
    if (entry) {
      entry.enabled = true;
      delete entry.disabledAt;
      delete entry.disabledReason;
    } else {
      registry.entries[id] = { id, enabled: true, source: "bundled" };
    }
    return false;
  });
  if (alreadyEnabled) {
    ctx.ui.notify(`Extension "${id}" is already enabled.`, "info");
    return;
  }
  ctx.ui.notify(`Enabled "${id}". Restart GSD to activate.`, "info");
}
function handleDisable(id, reason, ctx) {
  if (!id) {
    ctx.ui.notify("Usage: /gsd extensions disable <id>", "warning");
    return;
  }
  const manifests = discoverManifests();
  const manifest = manifests.get(id) ?? null;
  if (!manifests.has(id)) {
    ctx.ui.notify(`Extension "${id}" not found. Run /gsd extensions list to see available extensions.`, "warning");
    return;
  }
  if (manifest?.tier === "core") {
    ctx.ui.notify(`Cannot disable "${id}" \u2014 it is a core extension.`, "warning");
    return;
  }
  const alreadyDisabled = withRegistryLock((registry) => {
    if (!isEnabled(registry, id)) return true;
    const entry = registry.entries[id];
    if (entry) {
      entry.enabled = false;
      entry.disabledAt = (/* @__PURE__ */ new Date()).toISOString();
      entry.disabledReason = reason || void 0;
    } else {
      registry.entries[id] = {
        id,
        enabled: false,
        source: "bundled",
        disabledAt: (/* @__PURE__ */ new Date()).toISOString(),
        disabledReason: reason || void 0
      };
    }
    return false;
  });
  if (alreadyDisabled) {
    ctx.ui.notify(`Extension "${id}" is already disabled.`, "info");
    return;
  }
  ctx.ui.notify(`Disabled "${id}". Restart GSD to deactivate.`, "info");
}
function handleInfo(id, ctx) {
  if (!id) {
    ctx.ui.notify("Usage: /gsd extensions info <id>", "warning");
    return;
  }
  const manifests = discoverManifests();
  const manifest = manifests.get(id);
  if (!manifest) {
    ctx.ui.notify(`Extension "${id}" not found.`, "warning");
    return;
  }
  const registry = loadRegistry();
  const enabled = isEnabled(registry, id);
  const entry = registry.entries[id];
  const lines = [
    `${manifest.name} (${manifest.id})`,
    "",
    `  Version:     ${manifest.version}`,
    `  Description: ${manifest.description}`,
    `  Tier:        ${manifest.tier}`,
    `  Status:      ${enabled ? "enabled" : "disabled"}`
  ];
  if (entry?.disabledAt) {
    lines.push(`  Disabled at: ${entry.disabledAt}`);
  }
  if (entry?.disabledReason) {
    lines.push(`  Reason:      ${entry.disabledReason}`);
  }
  if (entry?.source === "user") {
    if (entry.installedFrom) {
      lines.push(`  Installed from: ${entry.installedFrom}`);
    }
    if (entry.installType) {
      lines.push(`  Install type:   ${entry.installType}`);
    }
  }
  if (manifest.provides) {
    lines.push("");
    lines.push("  Provides:");
    if (manifest.provides.tools?.length) {
      lines.push(`    Tools:     ${manifest.provides.tools.join(", ")}`);
    }
    if (manifest.provides.commands?.length) {
      lines.push(`    Commands:  ${manifest.provides.commands.join(", ")}`);
    }
    if (manifest.provides.hooks?.length) {
      lines.push(`    Hooks:     ${manifest.provides.hooks.join(", ")}`);
    }
    if (manifest.provides.shortcuts?.length) {
      lines.push(`    Shortcuts: ${manifest.provides.shortcuts.join(", ")}`);
    }
  }
  if (manifest.dependencies) {
    lines.push("");
    lines.push("  Dependencies:");
    if (manifest.dependencies.extensions?.length) {
      lines.push(`    Extensions: ${manifest.dependencies.extensions.join(", ")}`);
    }
    if (manifest.dependencies.runtime?.length) {
      lines.push(`    Runtime:    ${manifest.dependencies.runtime.join(", ")}`);
    }
  }
  ctx.ui.notify(lines.join("\n"), "info");
}
function handleValidate(path, ctx) {
  if (!path) {
    ctx.ui.notify("Usage: /gsd extensions validate <path>", "warning");
    return;
  }
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    ctx.ui.notify(`Path not found: ${resolved}`, "warning");
    return;
  }
  const result = validateExtensionPackage(resolved);
  if (result.valid) {
    ctx.ui.notify(`Valid extension package: ${resolved}`, "info");
  } else {
    ctx.ui.notify(
      `Invalid extension package: ${resolved}
` + result.errors.map((e) => `  - ${e}`).join("\n"),
      "warning"
    );
  }
}
function padRight(str, len) {
  return str.length >= len ? str + " " : str + " ".repeat(len - str.length);
}
export {
  handleExtensions,
  isVersionGreater,
  validateExtensionPackage
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9jb21tYW5kcy1leHRlbnNpb25zLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIEdTRCBFeHRlbnNpb25zIENvbW1hbmQgXHUyMDE0IC9nc2QgZXh0ZW5zaW9uc1xuICpcbiAqIE1hbmFnZSB0aGUgZXh0ZW5zaW9uIHJlZ2lzdHJ5OiBsaXN0LCBlbmFibGUsIGRpc2FibGUsIGluZm8sIGluc3RhbGwuXG4gKiBTZWxmLWNvbnRhaW5lZCBcdTIwMTQgbm8gaW1wb3J0cyBvdXRzaWRlIHRoZSBleHRlbnNpb25zIHRyZWUgKGV4dGVuc2lvbnMgYXJlIGxvYWRlZFxuICogdmlhIGppdGkgYXQgcnVudGltZSBmcm9tIH4vLmdzZC9hZ2VudC8sIG5vdCBjb21waWxlZCBieSB0c2MpLlxuICovXG5cbmltcG9ydCB0eXBlIHsgRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB7IGNwU3luYywgZXhpc3RzU3luYywgbWtkaXJTeW5jLCBta2R0ZW1wU3luYywgcmVhZEZpbGVTeW5jLCByZWFkZGlyU3luYywgcmVuYW1lU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGRpcm5hbWUsIGpvaW4sIHJlc29sdmUgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBob21lZGlyLCB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgZXhlY0ZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHsgbG9ja1N5bmMsIHVubG9ja1N5bmMgfSBmcm9tIFwicHJvcGVyLWxvY2tmaWxlXCI7XG5pbXBvcnQgeyBnc2RIb21lIH0gZnJvbSBcIi4vZ3NkLWhvbWUuanNcIjtcblxuLyoqXG4gKiBTdHJpY3QgbnVtZXJpYyBjb21wYXJpc29uIG9mIHR3byBucG0tc3R5bGUgdmVyc2lvbiBzdHJpbmdzLlxuICpcbiAqIFJldHVybnMgdHJ1ZSB3aGVuIGBhYCBpcyBzdHJpY3RseSBncmVhdGVyIHRoYW4gYGJgLiBDb21wYXJlcyB0aGUgZG90dGVkXG4gKiByZWxlYXNlIGNvbXBvbmVudHMgbnVtZXJpY2FsbHkgKHNvIGAxLjEwLjBgID4gYDEuOS4wYCkgYW5kIHRyZWF0cyBhbnlcbiAqIHByZXJlbGVhc2Ugc3VmZml4IChgLWJldGEuMWAsIGAtcmMuMmApIGFzIGxlc3MgdGhhbiB0aGUgZXF1aXZhbGVudFxuICogcmVsZWFzZSB2ZXJzaW9uIChgMS4wLjBgID4gYDEuMC4wLWJldGEuMWApLiBTdWZmaWNpZW50IGZvciBucG0gcGFja2FnZVxuICogdmVyc2lvbiBjb21wYXJpc29uIGluIHRoZSBleHRlbnNpb24gaW5zdGFsbGVyOyB3ZSBkb24ndCBuZWVkIHRoZSBmdWxsXG4gKiBzZW12ZXIgcmFuZ2UvaW50ZXJzZWN0IG1hY2hpbmVyeSBoZXJlLlxuICpcbiAqIFJlcGxhY2VzIHRoZSBlYXJsaWVyIGBpbXBvcnQgc2VtdmVyIGZyb20gXCJzZW12ZXJcImAgXHUyMDE0IHRoYXQgaW1wb3J0IGJyb2tlXG4gKiBgdHNjIC1wIHRzY29uZmlnLmpzb25gIHdoZW5ldmVyIGBAdHlwZXMvc2VtdmVyYCBmYWlsZWQgdG8gaW5zdGFsbFxuICogKElzc3VlICM0OTQ2KSBiZWNhdXNlIHRoZSBmaWxlIGlzIHB1bGxlZCBpbiB0cmFuc2l0aXZlbHkgZGVzcGl0ZSBiZWluZ1xuICogdW5kZXIgdGhlIGBzcmMvcmVzb3VyY2VzYCBleGNsdWRlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNWZXJzaW9uR3JlYXRlcihhOiBzdHJpbmcsIGI6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBzcGxpdCA9ICh2OiBzdHJpbmcpOiB7IHJlbGVhc2U6IG51bWJlcltdOyBwcmU6IHN0cmluZyB8IG51bGwgfSA9PiB7XG4gICAgY29uc3QgZGFzaCA9IHYuaW5kZXhPZihcIi1cIik7XG4gICAgY29uc3QgcmVsZWFzZSA9IChkYXNoID09PSAtMSA/IHYgOiB2LnNsaWNlKDAsIGRhc2gpKVxuICAgICAgLnNwbGl0KFwiLlwiKVxuICAgICAgLm1hcChwYXJ0ID0+IE51bWJlci5wYXJzZUludChwYXJ0LCAxMCkgfHwgMCk7XG4gICAgY29uc3QgcHJlID0gZGFzaCA9PT0gLTEgPyBudWxsIDogdi5zbGljZShkYXNoICsgMSk7XG4gICAgcmV0dXJuIHsgcmVsZWFzZSwgcHJlIH07XG4gIH07XG4gIGNvbnN0IHNhID0gc3BsaXQoYSk7XG4gIGNvbnN0IHNiID0gc3BsaXQoYik7XG4gIGNvbnN0IGxlbiA9IE1hdGgubWF4KHNhLnJlbGVhc2UubGVuZ3RoLCBzYi5yZWxlYXNlLmxlbmd0aCk7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgbGVuOyBpKyspIHtcbiAgICBjb25zdCBhaSA9IHNhLnJlbGVhc2VbaV0gPz8gMDtcbiAgICBjb25zdCBiaSA9IHNiLnJlbGVhc2VbaV0gPz8gMDtcbiAgICBpZiAoYWkgIT09IGJpKSByZXR1cm4gYWkgPiBiaTtcbiAgfVxuICAvLyBSZWxlYXNlIGNvbXBvbmVudHMgZXF1YWwgXHUyMDE0IGEgcmVsZWFzZSB2ZXJzaW9uIGJlYXRzIGFueSBwcmVyZWxlYXNlLFxuICAvLyBhbmQgcHJlcmVsZWFzZSBzdHJpbmdzIGFyZSBjb21wYXJlZCBsZXhpY29ncmFwaGljYWxseSAoZ29vZCBlbm91Z2hcbiAgLy8gZm9yIGBiZXRhLjFgIHZzIGBiZXRhLjJgLCB0aGUgb25seSByZWFsaXN0aWMgY2FzZSBoZXJlKS5cbiAgaWYgKHNhLnByZSA9PT0gbnVsbCAmJiBzYi5wcmUgIT09IG51bGwpIHJldHVybiB0cnVlO1xuICBpZiAoc2EucHJlICE9PSBudWxsICYmIHNiLnByZSA9PT0gbnVsbCkgcmV0dXJuIGZhbHNlO1xuICBpZiAoc2EucHJlICE9PSBudWxsICYmIHNiLnByZSAhPT0gbnVsbCkgcmV0dXJuIHNhLnByZSA+IHNiLnByZTtcbiAgcmV0dXJuIGZhbHNlO1xufVxuXG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUeXBlcyAobWlycm9yZWQgZnJvbSBleHRlbnNpb24tcmVnaXN0cnkudHMpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5pbnRlcmZhY2UgRXh0ZW5zaW9uTWFuaWZlc3Qge1xuICBpZDogc3RyaW5nO1xuICBuYW1lOiBzdHJpbmc7XG4gIHZlcnNpb246IHN0cmluZztcbiAgZGVzY3JpcHRpb246IHN0cmluZztcbiAgdGllcjogXCJjb3JlXCIgfCBcImJ1bmRsZWRcIiB8IFwiY29tbXVuaXR5XCI7XG4gIHJlcXVpcmVzOiB7IHBsYXRmb3JtOiBzdHJpbmcgfTtcbiAgcHJvdmlkZXM/OiB7XG4gICAgdG9vbHM/OiBzdHJpbmdbXTtcbiAgICBjb21tYW5kcz86IHN0cmluZ1tdO1xuICAgIGhvb2tzPzogc3RyaW5nW107XG4gICAgc2hvcnRjdXRzPzogc3RyaW5nW107XG4gIH07XG4gIGRlcGVuZGVuY2llcz86IHtcbiAgICBleHRlbnNpb25zPzogc3RyaW5nW107XG4gICAgcnVudGltZT86IHN0cmluZ1tdO1xuICB9O1xufVxuXG5pbnRlcmZhY2UgRXh0ZW5zaW9uUmVnaXN0cnlFbnRyeSB7XG4gIGlkOiBzdHJpbmc7XG4gIGVuYWJsZWQ6IGJvb2xlYW47XG4gIHNvdXJjZTogXCJidW5kbGVkXCIgfCBcInVzZXJcIiB8IFwicHJvamVjdFwiO1xuICBkaXNhYmxlZEF0Pzogc3RyaW5nO1xuICBkaXNhYmxlZFJlYXNvbj86IHN0cmluZztcbiAgdmVyc2lvbj86IHN0cmluZztcbiAgaW5zdGFsbGVkRnJvbT86IHN0cmluZztcbiAgaW5zdGFsbFR5cGU/OiBcIm5wbVwiIHwgXCJnaXRcIiB8IFwibG9jYWxcIjtcbn1cblxuaW50ZXJmYWNlIEV4dGVuc2lvblJlZ2lzdHJ5IHtcbiAgdmVyc2lvbjogMTtcbiAgZW50cmllczogUmVjb3JkPHN0cmluZywgRXh0ZW5zaW9uUmVnaXN0cnlFbnRyeT47XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBSZWdpc3RyeSBJL08gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIGdldFJlZ2lzdHJ5UGF0aCgpOiBzdHJpbmcge1xuICByZXR1cm4gam9pbihnc2RIb21lKCksIFwiZXh0ZW5zaW9uc1wiLCBcInJlZ2lzdHJ5Lmpzb25cIik7XG59XG5cbmZ1bmN0aW9uIGdldEFnZW50RXh0ZW5zaW9uc0RpcigpOiBzdHJpbmcge1xuICByZXR1cm4gam9pbihnc2RIb21lKCksIFwiYWdlbnRcIiwgXCJleHRlbnNpb25zXCIpO1xufVxuXG5mdW5jdGlvbiBsb2FkUmVnaXN0cnkoKTogRXh0ZW5zaW9uUmVnaXN0cnkge1xuICBjb25zdCBmaWxlUGF0aCA9IGdldFJlZ2lzdHJ5UGF0aCgpO1xuICB0cnkge1xuICAgIGlmICghZXhpc3RzU3luYyhmaWxlUGF0aCkpIHJldHVybiB7IHZlcnNpb246IDEsIGVudHJpZXM6IHt9IH07XG4gICAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKGZpbGVQYXRoLCBcInV0Zi04XCIpO1xuICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocmF3KTtcbiAgICBpZiAodHlwZW9mIHBhcnNlZCA9PT0gXCJvYmplY3RcIiAmJiBwYXJzZWQgIT09IG51bGwgJiYgcGFyc2VkLnZlcnNpb24gPT09IDEgJiYgdHlwZW9mIHBhcnNlZC5lbnRyaWVzID09PSBcIm9iamVjdFwiKSB7XG4gICAgICByZXR1cm4gcGFyc2VkIGFzIEV4dGVuc2lvblJlZ2lzdHJ5O1xuICAgIH1cbiAgICByZXR1cm4geyB2ZXJzaW9uOiAxLCBlbnRyaWVzOiB7fSB9O1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4geyB2ZXJzaW9uOiAxLCBlbnRyaWVzOiB7fSB9O1xuICB9XG59XG5cbmZ1bmN0aW9uIHNhdmVSZWdpc3RyeShyZWdpc3RyeTogRXh0ZW5zaW9uUmVnaXN0cnkpOiB2b2lkIHtcbiAgY29uc3QgZmlsZVBhdGggPSBnZXRSZWdpc3RyeVBhdGgoKTtcbiAgdHJ5IHtcbiAgICBta2RpclN5bmMoZGlybmFtZShmaWxlUGF0aCksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIGNvbnN0IHRtcCA9IGZpbGVQYXRoICsgXCIudG1wXCI7XG4gICAgd3JpdGVGaWxlU3luYyh0bXAsIEpTT04uc3RyaW5naWZ5KHJlZ2lzdHJ5LCBudWxsLCAyKSwgXCJ1dGYtOFwiKTtcbiAgICByZW5hbWVTeW5jKHRtcCwgZmlsZVBhdGgpO1xuICB9IGNhdGNoIHsgLyogbm9uLWZhdGFsICovIH1cbn1cblxuLyoqXG4gKiBSdW4gYSByZWdpc3RyeSBsb2FkIFx1MjE5MiBtdXRhdGUgXHUyMTkyIHNhdmUgdHJhbnNhY3Rpb24gdW5kZXIgYSBjcm9zcy1wcm9jZXNzIGxvY2suXG4gKiBQcmV2ZW50cyB0d28gY29uY3VycmVudCBgZ3NkIGV4dGVuc2lvbnMgaW5zdGFsbC91bmluc3RhbGwvdXBkYXRlYCBpbnZvY2F0aW9uc1xuICogZnJvbSB0cmFtcGxpbmcgZWFjaCBvdGhlcidzIHJlZ2lzdHJ5IG11dGF0aW9ucy5cbiAqXG4gKiBVc2VzIHByb3Blci1sb2NrZmlsZS5sb2NrU3luYyBhZ2FpbnN0IHRoZSByZWdpc3RyeSBwYXRoLiBEaXJlY3RvcnkgaXMgY3JlYXRlZFxuICogZmlyc3Qgc28gbG9ja2luZyB3b3JrcyBvbiBmcmVzaCBpbnN0YWxscy4gTG9jayBpcyBhbHdheXMgcmVsZWFzZWQgdmlhIGZpbmFsbHkuXG4gKi9cbmZ1bmN0aW9uIHdpdGhSZWdpc3RyeUxvY2s8VD4obXV0YXRlOiAocmVnaXN0cnk6IEV4dGVuc2lvblJlZ2lzdHJ5KSA9PiBUKTogVCB7XG4gIGNvbnN0IGZpbGVQYXRoID0gZ2V0UmVnaXN0cnlQYXRoKCk7XG4gIG1rZGlyU3luYyhkaXJuYW1lKGZpbGVQYXRoKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIC8vIGxvY2tTeW5jIHJlcXVpcmVzIHRoZSBmaWxlIHRvIGV4aXN0IFx1MjAxNCBlbnN1cmUgaXQgZG9lcyBiZWZvcmUgYWNxdWlyaW5nLlxuICBpZiAoIWV4aXN0c1N5bmMoZmlsZVBhdGgpKSB7XG4gICAgd3JpdGVGaWxlU3luYyhmaWxlUGF0aCwgSlNPTi5zdHJpbmdpZnkoeyB2ZXJzaW9uOiAxLCBlbnRyaWVzOiB7fSB9LCBudWxsLCAyKSwgXCJ1dGYtOFwiKTtcbiAgfVxuICBsb2NrU3luYyhmaWxlUGF0aCwgeyByZXRyaWVzOiB7IHJldHJpZXM6IDUsIG1pblRpbWVvdXQ6IDUwLCBtYXhUaW1lb3V0OiA1MDAgfSB9KTtcbiAgdHJ5IHtcbiAgICBjb25zdCByZWdpc3RyeSA9IGxvYWRSZWdpc3RyeSgpO1xuICAgIGNvbnN0IHJlc3VsdCA9IG11dGF0ZShyZWdpc3RyeSk7XG4gICAgc2F2ZVJlZ2lzdHJ5KHJlZ2lzdHJ5KTtcbiAgICByZXR1cm4gcmVzdWx0O1xuICB9IGZpbmFsbHkge1xuICAgIHRyeSB7IHVubG9ja1N5bmMoZmlsZVBhdGgpOyB9IGNhdGNoIHsgLyogbG9jayBtYXkgYWxyZWFkeSBiZSBnb25lICovIH1cbiAgfVxufVxuXG5mdW5jdGlvbiBpc0VuYWJsZWQocmVnaXN0cnk6IEV4dGVuc2lvblJlZ2lzdHJ5LCBpZDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IGVudHJ5ID0gcmVnaXN0cnkuZW50cmllc1tpZF07XG4gIGlmICghZW50cnkpIHJldHVybiB0cnVlO1xuICByZXR1cm4gZW50cnkuZW5hYmxlZDtcbn1cblxuZnVuY3Rpb24gcmVhZE1hbmlmZXN0KGRpcjogc3RyaW5nKTogRXh0ZW5zaW9uTWFuaWZlc3QgfCBudWxsIHtcbiAgY29uc3QgbVBhdGggPSBqb2luKGRpciwgXCJleHRlbnNpb24tbWFuaWZlc3QuanNvblwiKTtcbiAgaWYgKCFleGlzdHNTeW5jKG1QYXRoKSkgcmV0dXJuIG51bGw7XG4gIHRyeSB7XG4gICAgY29uc3QgcmF3ID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMobVBhdGgsIFwidXRmLThcIikpO1xuICAgIGlmICh0eXBlb2YgcmF3Py5pZCA9PT0gXCJzdHJpbmdcIiAmJiB0eXBlb2YgcmF3Py5uYW1lID09PSBcInN0cmluZ1wiKSByZXR1cm4gcmF3IGFzIEV4dGVuc2lvbk1hbmlmZXN0O1xuICAgIHJldHVybiBudWxsO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUGFja2FnZSBWYWxpZGF0aW9uIChtaXJyb3JlZCBcdTIwMTQgRC0xNCwgbm8gc3JjLyBpbXBvcnRzKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGludGVyZmFjZSBWYWxpZGF0aW9uUmVzdWx0IHtcbiAgdmFsaWQ6IGJvb2xlYW47XG4gIGVycm9yczogc3RyaW5nW107XG4gIHdhcm5pbmdzOiBzdHJpbmdbXTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHZhbGlkYXRlRXh0ZW5zaW9uUGFja2FnZShwYWNrYWdlRGlyOiBzdHJpbmcpOiBWYWxpZGF0aW9uUmVzdWx0IHtcbiAgY29uc3QgZXJyb3JzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCB3YXJuaW5nczogc3RyaW5nW10gPSBbXTtcblxuICAvLyBDaGVjayBwYWNrYWdlLmpzb24gZXhpc3RzXG4gIGNvbnN0IHBrZ1BhdGggPSBqb2luKHBhY2thZ2VEaXIsIFwicGFja2FnZS5qc29uXCIpO1xuICBpZiAoIWV4aXN0c1N5bmMocGtnUGF0aCkpIHtcbiAgICByZXR1cm4geyB2YWxpZDogZmFsc2UsIGVycm9yczogW1wicGFja2FnZS5qc29uIG5vdCBmb3VuZFwiXSwgd2FybmluZ3MgfTtcbiAgfVxuXG4gIGxldCBwa2c6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICB0cnkge1xuICAgIHBrZyA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHBrZ1BhdGgsIFwidXRmLThcIikpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4geyB2YWxpZDogZmFsc2UsIGVycm9yczogW1wicGFja2FnZS5qc29uIGlzIGludmFsaWQgSlNPTlwiXSwgd2FybmluZ3MgfTtcbiAgfVxuXG4gIC8vIChhKSBnc2QuZXh0ZW5zaW9uOiB0cnVlIG1hcmtlciAoRC0xMmEpXG4gIGNvbnN0IGdzZEZpZWxkID0gcGtnLmdzZCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZDtcbiAgaWYgKGdzZEZpZWxkPy5leHRlbnNpb24gIT09IHRydWUpIHtcbiAgICBlcnJvcnMucHVzaCgncGFja2FnZS5qc29uIG1pc3NpbmcgXCJnc2RcIjogeyBcImV4dGVuc2lvblwiOiB0cnVlIH0nKTtcbiAgfVxuXG4gIC8vIChiKSBwaS5leHRlbnNpb25zIGVudHJ5IHBhdGhzIGV4aXN0IGFuZCBhcmUgcmVzb2x2YWJsZSAoRC0xMmIpXG4gIGNvbnN0IHBpRmllbGQgPSBwa2cucGkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQ7XG4gIGNvbnN0IHBpRXh0ZW5zaW9ucyA9IHBpRmllbGQ/LmV4dGVuc2lvbnM7XG4gIGlmICghQXJyYXkuaXNBcnJheShwaUV4dGVuc2lvbnMpIHx8IHBpRXh0ZW5zaW9ucy5sZW5ndGggPT09IDApIHtcbiAgICBlcnJvcnMucHVzaCgncGFja2FnZS5qc29uIG1pc3NpbmcgXCJwaVwiOiB7IFwiZXh0ZW5zaW9uc1wiOiBbLi4uXSB9Jyk7XG4gIH0gZWxzZSB7XG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiBwaUV4dGVuc2lvbnMpIHtcbiAgICAgIGlmICh0eXBlb2YgZW50cnkgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgY29uc3QgcmVzb2x2ZWQgPSBqb2luKHBhY2thZ2VEaXIsIGVudHJ5KTtcbiAgICAgICAgaWYgKCFleGlzdHNTeW5jKHJlc29sdmVkKSkge1xuICAgICAgICAgIGVycm9ycy5wdXNoKGBwaS5leHRlbnNpb25zIGVudHJ5IG5vdCBmb3VuZDogJHtlbnRyeX1gKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8vIChjKSBAZ3NkLyogcGFja2FnZXMgbXVzdCBiZSBpbiBwZWVyRGVwZW5kZW5jaWVzLCBub3QgZGVwZW5kZW5jaWVzL2RldkRlcGVuZGVuY2llcyAoRC0xMmMpXG4gIC8vIE1pcnJvcnMgdmFsaWRhdGVFeHRlbnNpb25NYW5pZmVzdCBiZWxvdyBhbmQgZXh0ZW5zaW9uLXZhbGlkYXRvci50czpjaGVja0RlcGVuZGVuY3lQbGFjZW1lbnQuXG4gIGZvciAoY29uc3QgZmllbGQgb2YgW1wiZGVwZW5kZW5jaWVzXCIsIFwiZGV2RGVwZW5kZW5jaWVzXCJdIGFzIGNvbnN0KSB7XG4gICAgY29uc3QgZGVwcyA9IChwa2dbZmllbGRdIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkKSA/PyB7fTtcbiAgICBmb3IgKGNvbnN0IGRlcCBvZiBPYmplY3Qua2V5cyhkZXBzKSkge1xuICAgICAgaWYgKGRlcC5zdGFydHNXaXRoKFwiQGdzZC9cIikpIHtcbiAgICAgICAgZXJyb3JzLnB1c2goYFwiJHtkZXB9XCIgbXVzdCBiZSBpbiBwZWVyRGVwZW5kZW5jaWVzLCBub3QgJHtmaWVsZH1gKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4geyB2YWxpZDogZXJyb3JzLmxlbmd0aCA9PT0gMCwgZXJyb3JzLCB3YXJuaW5ncyB9O1xufVxuXG5mdW5jdGlvbiBkaXNjb3Zlck1hbmlmZXN0cygpOiBNYXA8c3RyaW5nLCBFeHRlbnNpb25NYW5pZmVzdD4ge1xuICBjb25zdCBtYW5pZmVzdHMgPSBuZXcgTWFwPHN0cmluZywgRXh0ZW5zaW9uTWFuaWZlc3Q+KCk7XG4gIC8vIFNjYW4gYm90aCBidW5kbGVkL2FnZW50IGRpciBhbmQgdXNlci1pbnN0YWxsZWQgZGlyIHNvIENMSSAobGlzdC9pbmZvL1xuICAvLyBlbmFibGUvZGlzYWJsZSkgc2VlcyB0aGUgc2FtZSBzZXQgdGhlIGxvYWRlciB3aWxsIG1lcmdlIGF0IHJ1bnRpbWUuXG4gIC8vIEJ1bmRsZWQgZW50cmllcyBhcmUgc2Nhbm5lZCBmaXJzdCBzbyB1c2VyLWluc3RhbGxlZCBJRHMgb3ZlcnJpZGUgb24gY29sbGlzaW9uLlxuICBjb25zdCBkaXJzID0gW2dldEFnZW50RXh0ZW5zaW9uc0RpcigpLCBnZXRJbnN0YWxsZWRFeHREaXIoKV07XG4gIGZvciAoY29uc3QgZXh0RGlyIG9mIGRpcnMpIHtcbiAgICBpZiAoIWV4aXN0c1N5bmMoZXh0RGlyKSkgY29udGludWU7XG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiByZWFkZGlyU3luYyhleHREaXIsIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KSkge1xuICAgICAgaWYgKCFlbnRyeS5pc0RpcmVjdG9yeSgpICYmICFlbnRyeS5pc1N5bWJvbGljTGluaygpKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IG0gPSByZWFkTWFuaWZlc3Qoam9pbihleHREaXIsIGVudHJ5Lm5hbWUpKTtcbiAgICAgIGlmIChtKSBtYW5pZmVzdHMuc2V0KG0uaWQsIG0pO1xuICAgIH1cbiAgfVxuICByZXR1cm4gbWFuaWZlc3RzO1xufVxuXG5mdW5jdGlvbiBnZXRJbnN0YWxsZWRFeHREaXIoKTogc3RyaW5nIHtcbiAgcmV0dXJuIGpvaW4oZ3NkSG9tZSgpLCBcImV4dGVuc2lvbnNcIik7XG59XG5cbi8vIFNvdXJjZTogZGVyaXZlZCBmcm9tIG5wbS9naXQgVVJMIGNvbnZlbnRpb25zIChmcm9tIFJFU0VBUkNILm1kKVxuZnVuY3Rpb24gZGV0ZWN0SW5zdGFsbFR5cGUoc3BlY2lmaWVyOiBzdHJpbmcpOiBcIm5wbVwiIHwgXCJnaXRcIiB8IFwibG9jYWxcIiB7XG4gIGlmIChcbiAgICBzcGVjaWZpZXIuc3RhcnRzV2l0aChcIi9cIikgfHxcbiAgICBzcGVjaWZpZXIuc3RhcnRzV2l0aChcIi4vXCIpIHx8XG4gICAgc3BlY2lmaWVyLnN0YXJ0c1dpdGgoXCIuLi9cIikgfHxcbiAgICBzcGVjaWZpZXIuc3RhcnRzV2l0aChcIn4vXCIpXG4gICkgcmV0dXJuIFwibG9jYWxcIjtcbiAgaWYgKFxuICAgIHNwZWNpZmllci5zdGFydHNXaXRoKFwiZ2l0K1wiKSB8fFxuICAgIHNwZWNpZmllci5zdGFydHNXaXRoKFwiZ2l0Oi8vXCIpIHx8XG4gICAgc3BlY2lmaWVyLnN0YXJ0c1dpdGgoXCJnaXRodWI6XCIpIHx8XG4gICAgc3BlY2lmaWVyLnN0YXJ0c1dpdGgoXCJnaXRsYWI6XCIpIHx8XG4gICAgc3BlY2lmaWVyLnN0YXJ0c1dpdGgoXCJiaXRidWNrZXQ6XCIpIHx8XG4gICAgKHNwZWNpZmllci5zdGFydHNXaXRoKFwiaHR0cHM6Ly9cIikgJiYgc3BlY2lmaWVyLmVuZHNXaXRoKFwiLmdpdFwiKSkgfHxcbiAgICAoc3BlY2lmaWVyLnN0YXJ0c1dpdGgoXCJodHRwOi8vXCIpICYmIHNwZWNpZmllci5lbmRzV2l0aChcIi5naXRcIikpXG4gICkgcmV0dXJuIFwiZ2l0XCI7XG4gIHJldHVybiBcIm5wbVwiO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgTWFuaWZlc3QgVmFsaWRhdGlvbiAobWlycm9yZWQgZnJvbSBleHRlbnNpb24tdmFsaWRhdG9yLnRzKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbi8vIE5vdGU6IGRpc3RpbmN0IGZyb20gdmFsaWRhdGVFeHRlbnNpb25QYWNrYWdlIGFib3ZlICh3aGljaCB2YWxpZGF0ZXMgYSBwYWNrYWdlXG4vLyBkaXJlY3Rvcnkgb24gZGlzayBhbmQgcmV0dXJucyBzdHJpbmcgZXJyb3JzKS4gVGhpcyBvbmUgdmFsaWRhdGVzIGFuIGFscmVhZHktXG4vLyBwYXJzZWQgcGFja2FnZS5qc29uIG9iamVjdCBhbmQgcmV0dXJucyBzdHJ1Y3R1cmVkIGVycm9ycywgdXNlZCBieSBpbnN0YWxsLlxuXG5pbnRlcmZhY2UgTWFuaWZlc3RWYWxpZGF0aW9uRXJyb3Ige1xuICBjb2RlOiBzdHJpbmc7XG4gIG1lc3NhZ2U6IHN0cmluZztcbiAgZmllbGQ/OiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBNYW5pZmVzdFZhbGlkYXRpb25SZXN1bHQge1xuICB2YWxpZDogYm9vbGVhbjtcbiAgZXJyb3JzOiBNYW5pZmVzdFZhbGlkYXRpb25FcnJvcltdO1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZUV4dGVuc2lvbk1hbmlmZXN0KHBrZzogdW5rbm93biwgb3B0czogeyBleHRlbnNpb25JZD86IHN0cmluZzsgYWxsb3dHc2ROYW1lc3BhY2U/OiBib29sZWFuIH0gPSB7fSk6IE1hbmlmZXN0VmFsaWRhdGlvblJlc3VsdCB7XG4gIGNvbnN0IGVycm9yczogTWFuaWZlc3RWYWxpZGF0aW9uRXJyb3JbXSA9IFtdO1xuXG4gIC8vIENoZWNrIGdzZC5leHRlbnNpb24gPT09IHRydWUgKHN0cmljdClcbiAgaWYgKHR5cGVvZiBwa2cgIT09IFwib2JqZWN0XCIgfHwgcGtnID09PSBudWxsKSB7XG4gICAgZXJyb3JzLnB1c2goeyBjb2RlOiBcIk1JU1NJTkdfR1NEX01BUktFUlwiLCBtZXNzYWdlOiAncGFja2FnZS5qc29uIG11c3QgZGVjbGFyZSBcImdzZFwiOiB7IFwiZXh0ZW5zaW9uXCI6IHRydWUgfSB0byBiZSByZWNvZ25pemVkIGFzIGEgR1NEIGV4dGVuc2lvbi4nLCBmaWVsZDogXCJnc2QuZXh0ZW5zaW9uXCIgfSk7XG4gIH0gZWxzZSB7XG4gICAgY29uc3Qgb2JqID0gcGtnIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIGNvbnN0IGdzZCA9IG9iai5nc2Q7XG4gICAgaWYgKHR5cGVvZiBnc2QgIT09IFwib2JqZWN0XCIgfHwgZ3NkID09PSBudWxsIHx8IChnc2QgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pLmV4dGVuc2lvbiAhPT0gdHJ1ZSkge1xuICAgICAgZXJyb3JzLnB1c2goeyBjb2RlOiBcIk1JU1NJTkdfR1NEX01BUktFUlwiLCBtZXNzYWdlOiAncGFja2FnZS5qc29uIG11c3QgZGVjbGFyZSBcImdzZFwiOiB7IFwiZXh0ZW5zaW9uXCI6IHRydWUgfSB0byBiZSByZWNvZ25pemVkIGFzIGEgR1NEIGV4dGVuc2lvbi4nLCBmaWVsZDogXCJnc2QuZXh0ZW5zaW9uXCIgfSk7XG4gICAgfVxuICB9XG5cbiAgLy8gQ2hlY2sgbmFtZXNwYWNlIHJlc2VydmF0aW9uXG4gIGlmIChvcHRzLmV4dGVuc2lvbklkICYmIG9wdHMuZXh0ZW5zaW9uSWQuc3RhcnRzV2l0aChcImdzZC5cIikgJiYgb3B0cy5hbGxvd0dzZE5hbWVzcGFjZSAhPT0gdHJ1ZSkge1xuICAgIGVycm9ycy5wdXNoKHsgY29kZTogXCJSRVNFUlZFRF9OQU1FU1BBQ0VcIiwgbWVzc2FnZTogYEV4dGVuc2lvbiBJRCBcIiR7b3B0cy5leHRlbnNpb25JZH1cIiBpcyByZXNlcnZlZCBmb3IgR1NEIGNvcmUgZXh0ZW5zaW9ucy4gVXNlIGEgZGlmZmVyZW50IG5hbWVzcGFjZSBmb3IgY29tbXVuaXR5IGV4dGVuc2lvbnMuYCwgZmllbGQ6IFwiZXh0ZW5zaW9uSWRcIiB9KTtcbiAgfVxuXG4gIC8vIENoZWNrIGRlcGVuZGVuY3kgcGxhY2VtZW50XG4gIGlmICh0eXBlb2YgcGtnID09PSBcIm9iamVjdFwiICYmIHBrZyAhPT0gbnVsbCkge1xuICAgIGNvbnN0IG9iaiA9IHBrZyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICBmb3IgKGNvbnN0IGZpZWxkIG9mIFtcImRlcGVuZGVuY2llc1wiLCBcImRldkRlcGVuZGVuY2llc1wiXSBhcyBjb25zdCkge1xuICAgICAgY29uc3QgZGVwcyA9IG9ialtmaWVsZF07XG4gICAgICBpZiAodHlwZW9mIGRlcHMgPT09IFwib2JqZWN0XCIgJiYgZGVwcyAhPT0gbnVsbCkge1xuICAgICAgICBmb3IgKGNvbnN0IHBrZ05hbWUgb2YgT2JqZWN0LmtleXMoZGVwcyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikpIHtcbiAgICAgICAgICBpZiAocGtnTmFtZS5zdGFydHNXaXRoKFwiQGdzZC9cIikpIHtcbiAgICAgICAgICAgIGVycm9ycy5wdXNoKHsgY29kZTogXCJXUk9OR19ERVBfRklFTERcIiwgbWVzc2FnZTogYFwiJHtwa2dOYW1lfVwiIG11c3Qgbm90IGFwcGVhciBpbiBcIiR7ZmllbGR9XCIuIE1vdmUgaXQgdG8gXCJwZWVyRGVwZW5kZW5jaWVzXCIuYCwgZmllbGQgfSk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHsgdmFsaWQ6IGVycm9ycy5sZW5ndGggPT09IDAsIGVycm9ycyB9O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUG9zdC1pbnN0YWxsIGNvbnZlcmdlbmNlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIEFsbG93ZWQgY2hhcmFjdGVycyBmb3IgYW4gZXh0ZW5zaW9uIGlkIHdoZW4gdXNlZCBhcyBhIHBhdGggc2VnbWVudC5cbiAqIFJlamVjdHMgYW55dGhpbmcgdGhhdCBjb3VsZCBlbmFibGUgdHJhdmVyc2FsIG9yIGVzY2FwZSAoc2xhc2hlcywgXCIuLlwiLCBiYWNrc2xhc2hlcykuXG4gKi9cbmNvbnN0IFNBRkVfRVhURU5TSU9OX0lEX1JFID0gL15bQS1aYS16MC05Ll8tXSskLztcblxuZnVuY3Rpb24gaXNTYWZlRXh0ZW5zaW9uSWQoaWQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBpZiAoIWlkIHx8IGlkID09PSBcIi5cIiB8fCBpZCA9PT0gXCIuLlwiKSByZXR1cm4gZmFsc2U7XG4gIGlmIChpZC5pbmNsdWRlcyhcIi9cIikgfHwgaWQuaW5jbHVkZXMoXCJcXFxcXCIpIHx8IGlkLmluY2x1ZGVzKFwiLi5cIikpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIFNBRkVfRVhURU5TSU9OX0lEX1JFLnRlc3QoaWQpO1xufVxuXG4vKipcbiAqIFBvc3QtaW5zdGFsbCBjb252ZXJnZW5jZTogdmFsaWRhdGUgcGFja2FnZSBhbmQgcmVhZCBtYW5pZmVzdC5cbiAqIFJldHVybnMgdGhlICh2YWxpZGF0ZWQpIGV4dGVuc2lvbiBJRCBhbmQgbWFuaWZlc3Qgb24gc3VjY2Vzcywgb3IgbnVsbCBvbiBmYWlsdXJlLlxuICogQ2FsbGVyIGlzIHJlc3BvbnNpYmxlIGZvciB3cml0aW5nIHRoZSByZWdpc3RyeSBlbnRyeSAqYWZ0ZXIqIHRoZSBmaW5hbCBjb21taXRcbiAqIHJlbmFtZSBzdWNjZWVkcyBzbyBhIGZhaWxlZCBtb3ZlIGRvZXNuJ3QgbGVhdmUgYSBkYW5nbGluZyByZWdpc3RyeSBlbnRyeS5cbiAqL1xuZnVuY3Rpb24gcG9zdEluc3RhbGxWYWxpZGF0ZShcbiAgZGVzdFBhdGg6IHN0cmluZyxcbiAgc3BlY2lmaWVyOiBzdHJpbmcsXG4gIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsXG4pOiB7IGlkOiBzdHJpbmc7IG1hbmlmZXN0OiBFeHRlbnNpb25NYW5pZmVzdCB9IHwgbnVsbCB7XG4gIC8vIFJlYWQgcGFja2FnZS5qc29uXG4gIGNvbnN0IHBrZ0pzb25QYXRoID0gam9pbihkZXN0UGF0aCwgXCJwYWNrYWdlLmpzb25cIik7XG4gIGlmICghZXhpc3RzU3luYyhwa2dKc29uUGF0aCkpIHtcbiAgICBjdHgudWkubm90aWZ5KGBDYW5ub3QgaW5zdGFsbCBcIiR7c3BlY2lmaWVyfVwiOiBubyBwYWNrYWdlLmpzb24gZm91bmQuYCwgXCJlcnJvclwiKTtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICBsZXQgcGtnSnNvbjogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIHRyeSB7XG4gICAgcGtnSnNvbiA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHBrZ0pzb25QYXRoLCBcInV0Zi04XCIpKTtcbiAgfSBjYXRjaCB7XG4gICAgY3R4LnVpLm5vdGlmeShgQ2Fubm90IGluc3RhbGwgXCIke3NwZWNpZmllcn1cIjogbWFsZm9ybWVkIHBhY2thZ2UuanNvbi5gLCBcImVycm9yXCIpO1xuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgLy8gUmVhZCBleHRlbnNpb24tbWFuaWZlc3QuanNvbiBmb3IgdGhlIElEXG4gIGNvbnN0IG1hbmlmZXN0ID0gcmVhZE1hbmlmZXN0KGRlc3RQYXRoKTtcbiAgY29uc3QgZXh0ZW5zaW9uSWQgPSBtYW5pZmVzdD8uaWQ7XG5cbiAgLy8gVmFsaWRhdGVcbiAgY29uc3QgdmFsaWRhdGlvbiA9IHZhbGlkYXRlRXh0ZW5zaW9uTWFuaWZlc3QocGtnSnNvbiwgeyBleHRlbnNpb25JZCB9KTtcbiAgaWYgKCF2YWxpZGF0aW9uLnZhbGlkKSB7XG4gICAgY29uc3QgbXNncyA9IHZhbGlkYXRpb24uZXJyb3JzLm1hcChlID0+IGUubWVzc2FnZSkuam9pbihcIlxcblwiKTtcbiAgICBjdHgudWkubm90aWZ5KGBDYW5ub3QgaW5zdGFsbCBcIiR7c3BlY2lmaWVyfVwiOiAke21zZ3N9YCwgXCJlcnJvclwiKTtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIGlmICghbWFuaWZlc3QgfHwgIWV4dGVuc2lvbklkKSB7XG4gICAgY3R4LnVpLm5vdGlmeShgQ2Fubm90IGluc3RhbGwgXCIke3NwZWNpZmllcn1cIjogbm8gZXh0ZW5zaW9uLW1hbmlmZXN0Lmpzb24gd2l0aCB2YWxpZCBpZCBmb3VuZC5gLCBcImVycm9yXCIpO1xuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgLy8gVGhlIGlkIGZyb20gdGhlIG1hbmlmZXN0IGlzIHVzZWQgYXMgYSBwYXRoIHNlZ21lbnQgdW5kZXIgaW5zdGFsbGVkRXh0RGlyLlxuICAvLyBSZWplY3QgdW5zYWZlIGlkcyBiZWZvcmUgdGhlIGNhbGxlciBwZXJmb3JtcyBhbnkgcGF0aCBqb2lucy5cbiAgaWYgKCFpc1NhZmVFeHRlbnNpb25JZChleHRlbnNpb25JZCkpIHtcbiAgICBjdHgudWkubm90aWZ5KFxuICAgICAgYENhbm5vdCBpbnN0YWxsIFwiJHtzcGVjaWZpZXJ9XCI6IGV4dGVuc2lvbiBpZCBcIiR7ZXh0ZW5zaW9uSWR9XCIgY29udGFpbnMgdW5zYWZlIGNoYXJhY3RlcnMgKGFsbG93ZWQ6IGFscGhhbnVtZXJpY3MsIFwiLlwiLCBcIi1cIiwgXCJfXCIpLmAsXG4gICAgICBcImVycm9yXCIsXG4gICAgKTtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIHJldHVybiB7IGlkOiBleHRlbnNpb25JZCwgbWFuaWZlc3QgfTtcbn1cblxuLyoqXG4gKiBXcml0ZSB0aGUgcmVnaXN0cnkgZW50cnkgZm9yIGEgZnJlc2hseS1pbnN0YWxsZWQgZXh0ZW5zaW9uLiBDYWxsZWQgYWZ0ZXIgdGhlXG4gKiBmaW5hbCBkZXN0aW5hdGlvbiBjb21taXQgc3VjY2VlZHMgc28gYSBmYWlsZWQgcmVuYW1lIGNhbid0IGxlYXZlIGEgc3RhbGUgZW50cnkuXG4gKi9cbmZ1bmN0aW9uIHdyaXRlSW5zdGFsbGVkUmVnaXN0cnlFbnRyeShcbiAgaWQ6IHN0cmluZyxcbiAgbWFuaWZlc3Q6IEV4dGVuc2lvbk1hbmlmZXN0LFxuICBzcGVjaWZpZXI6IHN0cmluZyxcbiAgaW5zdGFsbFR5cGU6IFwibnBtXCIgfCBcImdpdFwiIHwgXCJsb2NhbFwiLFxuKTogdm9pZCB7XG4gIHdpdGhSZWdpc3RyeUxvY2soKHJlZ2lzdHJ5KSA9PiB7XG4gICAgcmVnaXN0cnkuZW50cmllc1tpZF0gPSB7XG4gICAgICBpZCxcbiAgICAgIGVuYWJsZWQ6IHRydWUsXG4gICAgICBzb3VyY2U6IFwidXNlclwiLFxuICAgICAgdmVyc2lvbjogbWFuaWZlc3QudmVyc2lvbixcbiAgICAgIGluc3RhbGxlZEZyb206IHNwZWNpZmllcixcbiAgICAgIGluc3RhbGxUeXBlLFxuICAgIH07XG4gIH0pO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVW5pbnN0YWxsIGhlbHBlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogU2NhbiBpbnN0YWxsZWQgZXh0ZW5zaW9ucyB0byBmaW5kIHdoaWNoIG9uZXMgZGVwZW5kIG9uIHRoZSB0YXJnZXQgSUQuXG4gKiBVc2VkIGZvciBkZXBlbmRlbmN5IHdhcm5pbmcgb24gdW5pbnN0YWxsIChELTA2KS5cbiAqL1xuZnVuY3Rpb24gZmluZERlcGVuZGVudHModGFyZ2V0SWQ6IHN0cmluZywgaW5zdGFsbGVkRXh0RGlyOiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGRlcGVuZGVudHM6IHN0cmluZ1tdID0gW107XG4gIGlmICghZXhpc3RzU3luYyhpbnN0YWxsZWRFeHREaXIpKSByZXR1cm4gZGVwZW5kZW50cztcbiAgZm9yIChjb25zdCBlbnRyeSBvZiByZWFkZGlyU3luYyhpbnN0YWxsZWRFeHREaXIsIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KSkge1xuICAgIGlmICghZW50cnkuaXNEaXJlY3RvcnkoKSkgY29udGludWU7XG4gICAgY29uc3QgbWFuaWZlc3QgPSByZWFkTWFuaWZlc3Qoam9pbihpbnN0YWxsZWRFeHREaXIsIGVudHJ5Lm5hbWUpKTtcbiAgICBpZiAoIW1hbmlmZXN0KSBjb250aW51ZTtcbiAgICBpZiAobWFuaWZlc3QuZGVwZW5kZW5jaWVzPy5leHRlbnNpb25zPy5pbmNsdWRlcyh0YXJnZXRJZCkpIHtcbiAgICAgIGRlcGVuZGVudHMucHVzaChtYW5pZmVzdC5pZCk7XG4gICAgfVxuICB9XG4gIHJldHVybiBkZXBlbmRlbnRzO1xufVxuXG5mdW5jdGlvbiBoYW5kbGVVbmluc3RhbGwoaWQ6IHN0cmluZyB8IHVuZGVmaW5lZCwgY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCk6IHZvaWQge1xuICBpZiAoIWlkKSB7XG4gICAgY3R4LnVpLm5vdGlmeShcIlVzYWdlOiAvZ3NkIGV4dGVuc2lvbnMgdW5pbnN0YWxsIDxpZD5cIiwgXCJ3YXJuaW5nXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIEhvbGQgdGhlIHJlZ2lzdHJ5IGxvY2sgZm9yIHRoZSBlbnRpcmUgdW5pbnN0YWxsIHRyYW5zYWN0aW9uIHNvIGEgY29uY3VycmVudFxuICAvLyBpbnN0YWxsIGNhbid0IGFkZCBvciByZS1lbmFibGUgYGlkYCB3aGlsZSB3ZSdyZSBpbiB0aGUgbWlkZGxlIG9mIHJlbW92aW5nIGl0LlxuICBjb25zdCByZXN1bHQgPSB3aXRoUmVnaXN0cnlMb2NrKChyZWdpc3RyeSkgPT4ge1xuICAgIGNvbnN0IGVudHJ5ID0gcmVnaXN0cnkuZW50cmllc1tpZF07XG5cbiAgICAvLyBDaGVjayBpZiBleHRlbnNpb24gZXhpc3RzIGFuZCBpcyB1c2VyLWluc3RhbGxlZFxuICAgIGlmICghZW50cnkgfHwgZW50cnkuc291cmNlICE9PSBcInVzZXJcIikge1xuICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlIGFzIGNvbnN0LCByZWFzb246IFwibm90LWZvdW5kXCIgYXMgY29uc3QgfTtcbiAgICB9XG5cbiAgICBjb25zdCBpbnN0YWxsZWRFeHREaXIgPSBnZXRJbnN0YWxsZWRFeHREaXIoKTtcbiAgICBjb25zdCBleHREaXIgPSBqb2luKGluc3RhbGxlZEV4dERpciwgaWQpO1xuXG4gICAgLy8gQ2hlY2sgZm9yIGRlcGVuZGVudHMgYW5kIHdhcm4gKEQtMDY6IHdhcm4tdGhlbi1wcm9jZWVkKVxuICAgIGNvbnN0IGRlcGVuZGVudHMgPSBmaW5kRGVwZW5kZW50cyhpZCwgaW5zdGFsbGVkRXh0RGlyKTtcblxuICAgIC8vIFJlbW92ZSBkaXJlY3RvcnkgZmlyc3QsIHRoZW4gcmVnaXN0cnkgZW50cnkgKFBpdGZhbGwgNCBmcm9tIFJFU0VBUkNILm1kKVxuICAgIC8vIElmIHJtIGZhaWxzLCBkbyBOT1QgcmVtb3ZlIHJlZ2lzdHJ5IGVudHJ5IFx1MjAxNCBsZWF2ZXMgYSByZWNvdmVyYWJsZSBzdGF0ZVxuICAgIHRyeSB7XG4gICAgICBpZiAoZXhpc3RzU3luYyhleHREaXIpKSB7XG4gICAgICAgIHJtU3luYyhleHREaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGNvbnN0IG1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICAgIHJldHVybiB7IG9rOiBmYWxzZSBhcyBjb25zdCwgcmVhc29uOiBcInJtLWZhaWxlZFwiIGFzIGNvbnN0LCBtc2cgfTtcbiAgICB9XG5cbiAgICAvLyBSZW1vdmUgcmVnaXN0cnkgZW50cnkgKEQtMDcpXG4gICAgZGVsZXRlIHJlZ2lzdHJ5LmVudHJpZXNbaWRdO1xuICAgIHJldHVybiB7IG9rOiB0cnVlIGFzIGNvbnN0LCBkZXBlbmRlbnRzIH07XG4gIH0pO1xuXG4gIGlmICghcmVzdWx0Lm9rKSB7XG4gICAgaWYgKHJlc3VsdC5yZWFzb24gPT09IFwibm90LWZvdW5kXCIpIHtcbiAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgIGBFeHRlbnNpb24gXCIke2lkfVwiIG5vdCBmb3VuZCBpbiByZWdpc3RyeS4gUnVuIC9nc2QgZXh0ZW5zaW9ucyBsaXN0IHRvIHNlZSBpbnN0YWxsZWQgZXh0ZW5zaW9ucy5gLFxuICAgICAgICBcIndhcm5pbmdcIixcbiAgICAgICk7XG4gICAgfSBlbHNlIGlmIChyZXN1bHQucmVhc29uID09PSBcInJtLWZhaWxlZFwiKSB7XG4gICAgICBjdHgudWkubm90aWZ5KGBGYWlsZWQgdG8gcmVtb3ZlIGV4dGVuc2lvbiBkaXJlY3RvcnkgZm9yIFwiJHtpZH1cIjogJHtyZXN1bHQubXNnfWAsIFwiZXJyb3JcIik7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmIChyZXN1bHQuZGVwZW5kZW50cy5sZW5ndGggPiAwKSB7XG4gICAgY3R4LnVpLm5vdGlmeShcbiAgICAgIGBXYXJuaW5nOiB0aGUgZm9sbG93aW5nIGluc3RhbGxlZCBleHRlbnNpb25zIGRlcGVuZCBvbiBcIiR7aWR9XCI6ICR7cmVzdWx0LmRlcGVuZGVudHMuam9pbihcIiwgXCIpfS4gUmVtb3ZlZCBhbnl3YXkuYCxcbiAgICAgIFwid2FybmluZ1wiLFxuICAgICk7XG4gIH1cbiAgY3R4LnVpLm5vdGlmeShgVW5pbnN0YWxsZWQgXCIke2lkfVwiLiBSZXN0YXJ0IEdTRCB0byBkZWFjdGl2YXRlLmAsIFwiaW5mb1wiKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFVwZGF0ZSBzdWJjb21tYW5kIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5hc3luYyBmdW5jdGlvbiBnZXRMYXRlc3ROcG1WZXJzaW9uKHBhY2thZ2VOYW1lOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cHM6Ly9yZWdpc3RyeS5ucG1qcy5vcmcvJHtwYWNrYWdlTmFtZX0vbGF0ZXN0YCwge1xuICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDUwMDApLFxuICAgIH0pO1xuICAgIGlmICghcmVzLm9rKSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCBkYXRhID0gYXdhaXQgcmVzLmpzb24oKSBhcyB7IHZlcnNpb24/OiBzdHJpbmcgfTtcbiAgICByZXR1cm4gZGF0YS52ZXJzaW9uID8/IG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZVVwZGF0ZShpZDogc3RyaW5nIHwgdW5kZWZpbmVkLCBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHJlZ2lzdHJ5ID0gbG9hZFJlZ2lzdHJ5KCk7XG5cbiAgaWYgKGlkKSB7XG4gICAgLy8gVXBkYXRlIHNpbmdsZSBleHRlbnNpb24gKEQtMTIpXG4gICAgYXdhaXQgdXBkYXRlU2luZ2xlRXh0ZW5zaW9uKGlkLCByZWdpc3RyeSwgY3R4KTtcbiAgfSBlbHNlIHtcbiAgICAvLyBVcGRhdGUgYWxsIGluc3RhbGxlZCBleHRlbnNpb25zIChELTExKVxuICAgIGF3YWl0IHVwZGF0ZUFsbEV4dGVuc2lvbnMocmVnaXN0cnksIGN0eCk7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gdXBkYXRlU2luZ2xlRXh0ZW5zaW9uKFxuICBpZDogc3RyaW5nLFxuICByZWdpc3RyeTogRXh0ZW5zaW9uUmVnaXN0cnksXG4gIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgZW50cnkgPSByZWdpc3RyeS5lbnRyaWVzW2lkXTtcblxuICBpZiAoIWVudHJ5IHx8IGVudHJ5LnNvdXJjZSAhPT0gXCJ1c2VyXCIpIHtcbiAgICBjdHgudWkubm90aWZ5KFxuICAgICAgYEV4dGVuc2lvbiBcIiR7aWR9XCIgbm90IGZvdW5kIGluIHJlZ2lzdHJ5LiBSdW4gL2dzZCBleHRlbnNpb25zIGxpc3QgdG8gc2VlIGluc3RhbGxlZCBleHRlbnNpb25zLmAsXG4gICAgICBcIndhcm5pbmdcIixcbiAgICApO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIEdpdCBhbmQgbG9jYWwgaW5zdGFsbHM6IFwicmVpbnN0YWxsIHRvIHVwZGF0ZVwiIGhpbnQgKEQtMTAsIEQtMTIpXG4gIGlmIChlbnRyeS5pbnN0YWxsVHlwZSAhPT0gXCJucG1cIikge1xuICAgIGNvbnN0IHNvdXJjZSA9IGVudHJ5Lmluc3RhbGxUeXBlID8/IFwidW5rbm93blwiO1xuICAgIGNvbnN0IGhpbnQgPSBlbnRyeS5pbnN0YWxsZWRGcm9tID8gYGdzZCBleHRlbnNpb25zIGluc3RhbGwgJHtlbnRyeS5pbnN0YWxsZWRGcm9tfWAgOiBgZ3NkIGV4dGVuc2lvbnMgaW5zdGFsbCA8c3BlY2lmaWVyPmA7XG4gICAgY3R4LnVpLm5vdGlmeShcbiAgICAgIGBcIiR7aWR9XCIgd2FzIGluc3RhbGxlZCBmcm9tICR7c291cmNlfS4gUmVpbnN0YWxsIHRvIHVwZGF0ZTogJHtoaW50fWAsXG4gICAgICBcIndhcm5pbmdcIixcbiAgICApO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIG5wbSBleHRlbnNpb246IGNoZWNrIGZvciBuZXdlciB2ZXJzaW9uIChELTA5KVxuICBjb25zdCBjdXJyZW50ID0gZW50cnkudmVyc2lvbiA/PyBcIjAuMC4wXCI7XG4gIGNvbnN0IHNwZWNpZmllciA9IGVudHJ5Lmluc3RhbGxlZEZyb207XG4gIGlmICghc3BlY2lmaWVyKSB7XG4gICAgY3R4LnVpLm5vdGlmeShgXCIke2lkfVwiIGhhcyBubyByZWNvcmRlZCBpbnN0YWxsIHNvdXJjZS4gUmVpbnN0YWxsIG1hbnVhbGx5LmAsIFwid2FybmluZ1wiKTtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBTcGxpdCBucG0gc3BlY2lmaWVyIGludG8gbmFtZSArIG9wdGlvbmFsIHBpbi5cbiAgLy8gU2NvcGVkIChgQHNjb3BlL25hbWVbQHZlcnNpb25dYCkgdnMgdW5zY29wZWQgKGBuYW1lW0B2ZXJzaW9uXWApLlxuICBjb25zdCB7IG5hbWU6IHBhY2thZ2VOYW1lLCBwaW4gfSA9IHBhcnNlTnBtU3BlY2lmaWVyKHNwZWNpZmllcik7XG5cbiAgLy8gUGlubmVkIGluc3RhbGxzOiB0aGUgdXNlciBleHBsaWNpdGx5IHJlcXVlc3RlZCBhIHNwZWNpZmljIHZlcnNpb24uIERvbid0XG4gIC8vIHNpbGVudGx5IHVwZ3JhZGUgcGFzdCB0aGUgcGluIFx1MjAxNCB0ZWxsIHRoZW0gdG8gcmUtaW5zdGFsbCB3aXRoIGEgbmV3IHBpbi5cbiAgaWYgKHBpbikge1xuICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICBgXCIke2lkfVwiIHdhcyBpbnN0YWxsZWQgd2l0aCBhIHBpbm5lZCB2ZXJzaW9uICgke3Bpbn0pLiBUbyB1cGRhdGUsIHJ1bjogZ3NkIGV4dGVuc2lvbnMgaW5zdGFsbCAke3BhY2thZ2VOYW1lfUA8bmV3LXZlcnNpb24+YCxcbiAgICAgIFwiaW5mb1wiLFxuICAgICk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgbGF0ZXN0ID0gYXdhaXQgZ2V0TGF0ZXN0TnBtVmVyc2lvbihwYWNrYWdlTmFtZSk7XG4gIGlmICghbGF0ZXN0KSB7XG4gICAgY3R4LnVpLm5vdGlmeShgQ291bGQgbm90IGZldGNoIGxhdGVzdCB2ZXJzaW9uIGZvciBcIiR7aWR9XCIuYCwgXCJ3YXJuaW5nXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmIChpc1ZlcnNpb25HcmVhdGVyKGxhdGVzdCwgY3VycmVudCkpIHtcbiAgICBjdHgudWkubm90aWZ5KGBVcGRhdGluZyBcIiR7aWR9XCI6IHYke2N1cnJlbnR9IFx1MjE5MiB2JHtsYXRlc3R9Li4uYCwgXCJpbmZvXCIpO1xuICAgIGF3YWl0IGhhbmRsZUluc3RhbGwocGFja2FnZU5hbWUsIGN0eCk7XG4gIH0gZWxzZSB7XG4gICAgY3R4LnVpLm5vdGlmeShgXCIke2lkfVwiIGlzIGFscmVhZHkgYXQgdGhlIGxhdGVzdCB2ZXJzaW9uICh2JHtjdXJyZW50fSkuYCwgXCJpbmZvXCIpO1xuICB9XG59XG5cbi8qKlxuICogUGFyc2UgYW4gbnBtIHNwZWNpZmllciBpbnRvIGl0cyBwYWNrYWdlIG5hbWUgYW5kIG9wdGlvbmFsIHZlcnNpb24gcGluLlxuICogSGFuZGxlcyBzY29wZWQgKGBAc2NvcGUvbmFtZVtAdmVyc2lvbl1gKSBhbmQgdW5zY29wZWQgKGBuYW1lW0B2ZXJzaW9uXWApLlxuICovXG5mdW5jdGlvbiBwYXJzZU5wbVNwZWNpZmllcihzcGVjaWZpZXI6IHN0cmluZyk6IHsgbmFtZTogc3RyaW5nOyBwaW46IHN0cmluZyB8IG51bGwgfSB7XG4gIGNvbnN0IGlzU2NvcGVkID0gc3BlY2lmaWVyLnN0YXJ0c1dpdGgoXCJAXCIpO1xuICBjb25zdCBzZWFyY2hGcm9tID0gaXNTY29wZWQgPyBzcGVjaWZpZXIuaW5kZXhPZihcIi9cIikgKyAxIDogMDtcbiAgY29uc3QgYXRJZHggPSBzcGVjaWZpZXIuaW5kZXhPZihcIkBcIiwgc2VhcmNoRnJvbSk7XG4gIGlmIChhdElkeCA9PT0gLTEpIHJldHVybiB7IG5hbWU6IHNwZWNpZmllciwgcGluOiBudWxsIH07XG4gIHJldHVybiB7IG5hbWU6IHNwZWNpZmllci5zbGljZSgwLCBhdElkeCksIHBpbjogc3BlY2lmaWVyLnNsaWNlKGF0SWR4ICsgMSkgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gdXBkYXRlQWxsRXh0ZW5zaW9ucyhcbiAgcmVnaXN0cnk6IEV4dGVuc2lvblJlZ2lzdHJ5LFxuICBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIC8vIEZpbmQgYWxsIHVzZXItaW5zdGFsbGVkIGV4dGVuc2lvbnNcbiAgY29uc3QgdXNlckVudHJpZXMgPSBPYmplY3QudmFsdWVzKHJlZ2lzdHJ5LmVudHJpZXMpLmZpbHRlcihlID0+IGUuc291cmNlID09PSBcInVzZXJcIik7XG5cbiAgaWYgKHVzZXJFbnRyaWVzLmxlbmd0aCA9PT0gMCkge1xuICAgIGN0eC51aS5ub3RpZnkoXCJObyB1c2VyLWluc3RhbGxlZCBleHRlbnNpb25zIGZvdW5kLiBVc2U6IGdzZCBleHRlbnNpb25zIGluc3RhbGwgPHBhY2thZ2U+IHRvIGFkZCBvbmUuXCIsIFwid2FybmluZ1wiKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjdHgudWkubm90aWZ5KGBDaGVja2luZyAke3VzZXJFbnRyaWVzLmxlbmd0aH0gaW5zdGFsbGVkIGV4dGVuc2lvbihzKSBmb3IgdXBkYXRlcy4uLmAsIFwiaW5mb1wiKTtcblxuICBsZXQgdXBkYXRlZCA9IDA7XG4gIGxldCBza2lwcGVkID0gMDtcblxuICBmb3IgKGNvbnN0IGVudHJ5IG9mIHVzZXJFbnRyaWVzKSB7XG4gICAgLy8gU2tpcCBub24tbnBtIGluc3RhbGxzIChELTExKVxuICAgIGlmIChlbnRyeS5pbnN0YWxsVHlwZSAhPT0gXCJucG1cIikge1xuICAgICAgY29uc3Qgc291cmNlID0gZW50cnkuaW5zdGFsbFR5cGUgPz8gXCJ1bmtub3duXCI7XG4gICAgICBjdHgudWkubm90aWZ5KGAgICR7ZW50cnkuaWR9OiBpbnN0YWxsZWQgZnJvbSAke3NvdXJjZX0gXHUyMDE0IHJlaW5zdGFsbCB0byB1cGRhdGVgLCBcImluZm9cIik7XG4gICAgICBza2lwcGVkKys7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBjb25zdCBjdXJyZW50ID0gZW50cnkudmVyc2lvbiA/PyBcIjAuMC4wXCI7XG4gICAgY29uc3QgcGFja2FnZU5hbWUgPSBlbnRyeS5pbnN0YWxsZWRGcm9tO1xuICAgIGlmICghcGFja2FnZU5hbWUpIHtcbiAgICAgIGN0eC51aS5ub3RpZnkoYCAgJHtlbnRyeS5pZH06IG5vIHJlY29yZGVkIGluc3RhbGwgc291cmNlIFx1MjAxNCBza2lwYCwgXCJpbmZvXCIpO1xuICAgICAgc2tpcHBlZCsrO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgY29uc3QgbGF0ZXN0ID0gYXdhaXQgZ2V0TGF0ZXN0TnBtVmVyc2lvbihwYWNrYWdlTmFtZSk7XG4gICAgaWYgKCFsYXRlc3QpIHtcbiAgICAgIGN0eC51aS5ub3RpZnkoYCAgJHtlbnRyeS5pZH06IGNvdWxkIG5vdCBmZXRjaCBsYXRlc3QgdmVyc2lvbiBcdTIwMTQgc2tpcGAsIFwiaW5mb1wiKTtcbiAgICAgIHNraXBwZWQrKztcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGlmIChpc1ZlcnNpb25HcmVhdGVyKGxhdGVzdCwgY3VycmVudCkpIHtcbiAgICAgIGN0eC51aS5ub3RpZnkoYCAgJHtlbnRyeS5pZH06IHYke2N1cnJlbnR9IFx1MjE5MiB2JHtsYXRlc3R9ICh1cGRhdGluZylgLCBcImluZm9cIik7XG4gICAgICBhd2FpdCBoYW5kbGVJbnN0YWxsKHBhY2thZ2VOYW1lLCBjdHgpO1xuICAgICAgdXBkYXRlZCsrO1xuICAgIH0gZWxzZSB7XG4gICAgICBjdHgudWkubm90aWZ5KGAgICR7ZW50cnkuaWR9OiB2JHtjdXJyZW50fSAoYWxyZWFkeSB1cCB0byBkYXRlKWAsIFwiaW5mb1wiKTtcbiAgICB9XG4gIH1cblxuICBjdHgudWkubm90aWZ5KGBVcGRhdGVkICR7dXBkYXRlZH0gZXh0ZW5zaW9uKHMpLiAke3NraXBwZWR9IHNraXBwZWQgKGdpdC9sb2NhbCBcdTIwMTQgcmVpbnN0YWxsIHRvIHVwZGF0ZSkuYCwgXCJpbmZvXCIpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgSW5zdGFsbCBzdWJjb21tYW5kIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVJbnN0YWxsKHNwZWNpZmllcjogc3RyaW5nIHwgdW5kZWZpbmVkLCBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0KTogUHJvbWlzZTx2b2lkPiB7XG4gIGlmICghc3BlY2lmaWVyKSB7XG4gICAgY3R4LnVpLm5vdGlmeShcIlVzYWdlOiAvZ3NkIGV4dGVuc2lvbnMgaW5zdGFsbCA8bnBtLXBhY2thZ2V8Z2l0LXVybHxsb2NhbC1wYXRoPlwiLCBcIndhcm5pbmdcIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgaW5zdGFsbFR5cGUgPSBkZXRlY3RJbnN0YWxsVHlwZShzcGVjaWZpZXIpO1xuICBjb25zdCBpbnN0YWxsZWRFeHREaXIgPSBnZXRJbnN0YWxsZWRFeHREaXIoKTtcbiAgbWtkaXJTeW5jKGluc3RhbGxlZEV4dERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYEluc3RhbGxpbmcgJHtzcGVjaWZpZXJ9Li4uXFxuYCk7XG5cbiAgaWYgKGluc3RhbGxUeXBlID09PSBcIm5wbVwiKSB7XG4gICAgaW5zdGFsbEZyb21OcG0oc3BlY2lmaWVyLCBpbnN0YWxsZWRFeHREaXIsIGN0eCk7XG4gIH0gZWxzZSBpZiAoaW5zdGFsbFR5cGUgPT09IFwiZ2l0XCIpIHtcbiAgICBpbnN0YWxsRnJvbUdpdChzcGVjaWZpZXIsIGluc3RhbGxlZEV4dERpciwgY3R4KTtcbiAgfSBlbHNlIHtcbiAgICBpbnN0YWxsRnJvbUxvY2FsKHNwZWNpZmllciwgaW5zdGFsbGVkRXh0RGlyLCBjdHgpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGluc3RhbGxGcm9tTnBtKHNwZWNpZmllcjogc3RyaW5nLCBpbnN0YWxsZWRFeHREaXI6IHN0cmluZywgY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCk6IHZvaWQge1xuICAvLyBwYWNrRGlyIGhvbGRzIHRoZSB0YXJiYWxsIGluIHRtcGRpcigpLiBUaGUgKmV4dHJhY3REaXIqIGlzIHN0YWdlZCBpbnNpZGVcbiAgLy8gaW5zdGFsbGVkRXh0RGlyIHNvIHRoZSBmaW5hbCByZW5hbWVTeW5jIHRvIGRlc3RQYXRoIHN0YXlzIG9uIGEgc2luZ2xlXG4gIC8vIGZpbGVzeXN0ZW0gKGF2b2lkcyBFWERFViB3aGVuIHRtcGRpcigpIGFuZCB+Ly5nc2QgbGl2ZSBvbiBkaWZmZXJlbnQgbW91bnRzKS5cbiAgY29uc3QgcGFja0RpciA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLWluc3RhbGwtXCIpKTtcbiAgbGV0IGV4dHJhY3REaXI6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICB0cnkge1xuICAgIC8vIFN0ZXAgMTogbnBtIHBhY2sgdG8gdG1wZGlyIChELTAxLCBELTA1KVxuICAgIGV4ZWNGaWxlU3luYyhcIm5wbVwiLCBbXCJwYWNrXCIsIHNwZWNpZmllciwgXCItLXBhY2stZGVzdGluYXRpb25cIiwgcGFja0RpciwgXCItLWlnbm9yZS1zY3JpcHRzXCJdLCB7XG4gICAgICBzdGRpbzogXCJwaXBlXCIsXG4gICAgICBlbmNvZGluZzogXCJ1dGYtOFwiLFxuICAgIH0pO1xuXG4gICAgLy8gU3RlcCAyOiBGaW5kIHRoZSB0YXJiYWxsXG4gICAgY29uc3QgdGd6RmlsZSA9IHJlYWRkaXJTeW5jKHBhY2tEaXIpLmZpbmQoZiA9PiBmLmVuZHNXaXRoKFwiLnRnelwiKSk7XG4gICAgaWYgKCF0Z3pGaWxlKSB0aHJvdyBuZXcgRXJyb3IoXCJucG0gcGFjayBwcm9kdWNlZCBubyB0YXJiYWxsXCIpO1xuXG4gICAgLy8gU3RlcCAzOiBFeHRyYWN0IHZpYSB0YXIgaW50byBhIHN0YWdpbmcgZGlyICppbnNpZGUqIGluc3RhbGxlZEV4dERpclxuICAgIGV4dHJhY3REaXIgPSBta2R0ZW1wU3luYyhqb2luKGluc3RhbGxlZEV4dERpciwgXCJ0bXAtbnBtLVwiKSk7XG4gICAgZXhlY0ZpbGVTeW5jKFwidGFyXCIsIFtcInh6ZlwiLCBqb2luKHBhY2tEaXIsIHRnekZpbGUpLCBcIi1DXCIsIGV4dHJhY3REaXIsIFwiLS1zdHJpcC1jb21wb25lbnRzPTFcIl0sIHsgc3RkaW86IFwicGlwZVwiIH0pO1xuXG4gICAgLy8gU3RlcCA0OiBWYWxpZGF0ZSBhbmQgZ2V0IGV4dGVuc2lvbiBJRFxuICAgIGNvbnN0IHZhbGlkYXRlZCA9IHBvc3RJbnN0YWxsVmFsaWRhdGUoZXh0cmFjdERpciwgc3BlY2lmaWVyLCBjdHgpO1xuICAgIGlmICghdmFsaWRhdGVkKSB7XG4gICAgICByZXR1cm47IC8vIEVycm9yIGFscmVhZHkgbm90aWZpZWRcbiAgICB9XG5cbiAgICAvLyBTdGVwIDU6IE1vdmUgdG8gZmluYWwgZGVzdGluYXRpb24gXHUyMDE0IHNhbWUgZmlsZXN5c3RlbSBhcyBleHRyYWN0RGlyXG4gICAgY29uc3QgZGVzdFBhdGggPSBqb2luKGluc3RhbGxlZEV4dERpciwgdmFsaWRhdGVkLmlkKTtcbiAgICBpZiAoZXhpc3RzU3luYyhkZXN0UGF0aCkpIHtcbiAgICAgIHJtU3luYyhkZXN0UGF0aCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgICByZW5hbWVTeW5jKGV4dHJhY3REaXIsIGRlc3RQYXRoKTtcbiAgICBleHRyYWN0RGlyID0gbnVsbDsgLy8gU3VjY2Vzc2Z1bGx5IG1vdmVkOyBza2lwIGNsZWFudXBcblxuICAgIC8vIFN0ZXAgNjogQ29tbWl0IHRoZSByZWdpc3RyeSBlbnRyeSBvbmx5IGFmdGVyIHRoZSByZW5hbWUgc3VjY2VlZHMuXG4gICAgd3JpdGVJbnN0YWxsZWRSZWdpc3RyeUVudHJ5KHZhbGlkYXRlZC5pZCwgdmFsaWRhdGVkLm1hbmlmZXN0LCBzcGVjaWZpZXIsIFwibnBtXCIpO1xuICAgIGN0eC51aS5ub3RpZnkoYEluc3RhbGxlZCBcIiR7dmFsaWRhdGVkLmlkfVwiIHYke3ZhbGlkYXRlZC5tYW5pZmVzdC52ZXJzaW9uID8/IFwidW5rbm93blwifS4gUmVzdGFydCBHU0QgdG8gYWN0aXZhdGUuYCwgXCJpbmZvXCIpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBjb25zdCBtc2cgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgY3R4LnVpLm5vdGlmeShgRmFpbGVkIHRvIGluc3RhbGwgXCIke3NwZWNpZmllcn1cIjogJHttc2d9YCwgXCJlcnJvclwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBpZiAoZXh0cmFjdERpciAmJiBleGlzdHNTeW5jKGV4dHJhY3REaXIpKSB7XG4gICAgICB0cnkgeyBybVN5bmMoZXh0cmFjdERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pOyB9IGNhdGNoIHsgLyogYmVzdC1lZmZvcnQgKi8gfVxuICAgIH1cbiAgICBybVN5bmMocGFja0RpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59XG5cbmZ1bmN0aW9uIGluc3RhbGxGcm9tR2l0KGdpdFVybDogc3RyaW5nLCBpbnN0YWxsZWRFeHREaXI6IHN0cmluZywgY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCk6IHZvaWQge1xuICAvLyBDbG9uZSBpbnRvIHRlbXAgZGlyLCB2YWxpZGF0ZSwgdGhlbiByZW5hbWUgdG8gcmVhbCBJRCAoRC0wMilcbiAgY29uc3QgdG1wRGlyID0gam9pbihpbnN0YWxsZWRFeHREaXIsIGBfX2luc3RhbGxpbmctJHtEYXRlLm5vdygpfWApO1xuICB0cnkge1xuICAgIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJjbG9uZVwiLCBcIi0tZGVwdGg9MVwiLCBnaXRVcmwsIHRtcERpcl0sIHsgc3RkaW86IFwicGlwZVwiIH0pO1xuXG4gICAgLy8gUmVtb3ZlIC5naXQgZGlyZWN0b3J5IFx1MjAxNCBub3QgbmVlZGVkIGFmdGVyIGNsb25lXG4gICAgY29uc3QgZG90R2l0ID0gam9pbih0bXBEaXIsIFwiLmdpdFwiKTtcbiAgICBpZiAoZXhpc3RzU3luYyhkb3RHaXQpKSB7XG4gICAgICBybVN5bmMoZG90R2l0LCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuXG4gICAgY29uc3QgdmFsaWRhdGVkID0gcG9zdEluc3RhbGxWYWxpZGF0ZSh0bXBEaXIsIGdpdFVybCwgY3R4KTtcbiAgICBpZiAoIXZhbGlkYXRlZCkge1xuICAgICAgcm1TeW5jKHRtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IGRlc3RQYXRoID0gam9pbihpbnN0YWxsZWRFeHREaXIsIHZhbGlkYXRlZC5pZCk7XG4gICAgaWYgKGV4aXN0c1N5bmMoZGVzdFBhdGgpKSB7XG4gICAgICBybVN5bmMoZGVzdFBhdGgsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gICAgcmVuYW1lU3luYyh0bXBEaXIsIGRlc3RQYXRoKTtcblxuICAgIHdyaXRlSW5zdGFsbGVkUmVnaXN0cnlFbnRyeSh2YWxpZGF0ZWQuaWQsIHZhbGlkYXRlZC5tYW5pZmVzdCwgZ2l0VXJsLCBcImdpdFwiKTtcbiAgICBjdHgudWkubm90aWZ5KGBJbnN0YWxsZWQgXCIke3ZhbGlkYXRlZC5pZH1cIiB2JHt2YWxpZGF0ZWQubWFuaWZlc3QudmVyc2lvbiA/PyBcInVua25vd25cIn0uIFJlc3RhcnQgR1NEIHRvIGFjdGl2YXRlLmAsIFwiaW5mb1wiKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgaWYgKGV4aXN0c1N5bmModG1wRGlyKSkgcm1TeW5jKHRtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIGNvbnN0IG1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICBjdHgudWkubm90aWZ5KGBGYWlsZWQgdG8gaW5zdGFsbCBcIiR7Z2l0VXJsfVwiOiAke21zZ31gLCBcImVycm9yXCIpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGluc3RhbGxGcm9tTG9jYWwobG9jYWxQYXRoOiBzdHJpbmcsIGluc3RhbGxlZEV4dERpcjogc3RyaW5nLCBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0KTogdm9pZCB7XG4gIC8vIFJlc29sdmUgcGF0aCBhbmQgY29weSAobm90IHN5bWxpbmspIHBlciBELTAzXG4gIGNvbnN0IHNvdXJjZVBhdGggPSByZXNvbHZlKGxvY2FsUGF0aC5zdGFydHNXaXRoKFwifi9cIikgPyBqb2luKGhvbWVkaXIoKSwgbG9jYWxQYXRoLnNsaWNlKDIpKSA6IGxvY2FsUGF0aCk7XG5cbiAgaWYgKCFleGlzdHNTeW5jKHNvdXJjZVBhdGgpKSB7XG4gICAgY3R4LnVpLm5vdGlmeShgQ2Fubm90IGluc3RhbGwgXCIke2xvY2FsUGF0aH1cIjogcGF0aCBkb2VzIG5vdCBleGlzdC5gLCBcImVycm9yXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIENvcHkgdG8gdGVtcCBkaXIgZmlyc3QsIHZhbGlkYXRlLCB0aGVuIHJlbmFtZVxuICBjb25zdCB0bXBEaXIgPSBqb2luKGluc3RhbGxlZEV4dERpciwgYF9faW5zdGFsbGluZy0ke0RhdGUubm93KCl9YCk7XG4gIHRyeSB7XG4gICAgY3BTeW5jKHNvdXJjZVBhdGgsIHRtcERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgICBjb25zdCB2YWxpZGF0ZWQgPSBwb3N0SW5zdGFsbFZhbGlkYXRlKHRtcERpciwgbG9jYWxQYXRoLCBjdHgpO1xuICAgIGlmICghdmFsaWRhdGVkKSB7XG4gICAgICBybVN5bmModG1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgZGVzdFBhdGggPSBqb2luKGluc3RhbGxlZEV4dERpciwgdmFsaWRhdGVkLmlkKTtcbiAgICBpZiAoZXhpc3RzU3luYyhkZXN0UGF0aCkpIHtcbiAgICAgIHJtU3luYyhkZXN0UGF0aCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgICByZW5hbWVTeW5jKHRtcERpciwgZGVzdFBhdGgpO1xuXG4gICAgd3JpdGVJbnN0YWxsZWRSZWdpc3RyeUVudHJ5KHZhbGlkYXRlZC5pZCwgdmFsaWRhdGVkLm1hbmlmZXN0LCBsb2NhbFBhdGgsIFwibG9jYWxcIik7XG4gICAgY3R4LnVpLm5vdGlmeShgSW5zdGFsbGVkIFwiJHt2YWxpZGF0ZWQuaWR9XCIgdiR7dmFsaWRhdGVkLm1hbmlmZXN0LnZlcnNpb24gPz8gXCJ1bmtub3duXCJ9LiBSZXN0YXJ0IEdTRCB0byBhY3RpdmF0ZS5gLCBcImluZm9cIik7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGlmIChleGlzdHNTeW5jKHRtcERpcikpIHJtU3luYyh0bXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICBjb25zdCBtc2cgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgY3R4LnVpLm5vdGlmeShgRmFpbGVkIHRvIGluc3RhbGwgXCIke2xvY2FsUGF0aH1cIjogJHttc2d9YCwgXCJlcnJvclwiKTtcbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQ29tbWFuZCBIYW5kbGVyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlRXh0ZW5zaW9ucyhhcmdzOiBzdHJpbmcsIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgcGFydHMgPSBhcmdzLnNwbGl0KC9cXHMrLykuZmlsdGVyKEJvb2xlYW4pO1xuICBjb25zdCBzdWJDbWQgPSBwYXJ0c1swXSA/PyBcImxpc3RcIjtcblxuICBpZiAoc3ViQ21kID09PSBcImxpc3RcIikge1xuICAgIGhhbmRsZUxpc3QoY3R4KTtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAoc3ViQ21kID09PSBcImVuYWJsZVwiKSB7XG4gICAgaGFuZGxlRW5hYmxlKHBhcnRzWzFdLCBjdHgpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmIChzdWJDbWQgPT09IFwiZGlzYWJsZVwiKSB7XG4gICAgaGFuZGxlRGlzYWJsZShwYXJ0c1sxXSwgcGFydHMuc2xpY2UoMikuam9pbihcIiBcIiksIGN0eCk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKHN1YkNtZCA9PT0gXCJpbmZvXCIpIHtcbiAgICBoYW5kbGVJbmZvKHBhcnRzWzFdLCBjdHgpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmIChzdWJDbWQgPT09IFwiaW5zdGFsbFwiKSB7XG4gICAgYXdhaXQgaGFuZGxlSW5zdGFsbChwYXJ0c1sxXSwgY3R4KTtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAoc3ViQ21kID09PSBcInVuaW5zdGFsbFwiKSB7XG4gICAgaGFuZGxlVW5pbnN0YWxsKHBhcnRzWzFdLCBjdHgpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmIChzdWJDbWQgPT09IFwidXBkYXRlXCIpIHtcbiAgICBhd2FpdCBoYW5kbGVVcGRhdGUocGFydHNbMV0sIGN0eCk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKHN1YkNtZCA9PT0gXCJ2YWxpZGF0ZVwiKSB7XG4gICAgaGFuZGxlVmFsaWRhdGUocGFydHNbMV0sIGN0eCk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY3R4LnVpLm5vdGlmeShcbiAgICBgVW5rbm93bjogL2dzZCBleHRlbnNpb25zICR7c3ViQ21kfS4gVXNhZ2U6IC9nc2QgZXh0ZW5zaW9ucyBbbGlzdHxlbmFibGV8ZGlzYWJsZXxpbmZvfGluc3RhbGx8dW5pbnN0YWxsfHVwZGF0ZXx2YWxpZGF0ZV1gLFxuICAgIFwid2FybmluZ1wiLFxuICApO1xufVxuXG5mdW5jdGlvbiBoYW5kbGVMaXN0KGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQpOiB2b2lkIHtcbiAgY29uc3QgbWFuaWZlc3RzID0gZGlzY292ZXJNYW5pZmVzdHMoKTtcbiAgY29uc3QgcmVnaXN0cnkgPSBsb2FkUmVnaXN0cnkoKTtcblxuICBpZiAobWFuaWZlc3RzLnNpemUgPT09IDApIHtcbiAgICBjdHgudWkubm90aWZ5KFwiTm8gZXh0ZW5zaW9uIG1hbmlmZXN0cyBmb3VuZC5cIiwgXCJ3YXJuaW5nXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFNvcnQ6IGNvcmUgZmlyc3QsIHRoZW4gYWxwaGFiZXRpY2FsXG4gIGNvbnN0IHNvcnRlZCA9IFsuLi5tYW5pZmVzdHMudmFsdWVzKCldLnNvcnQoKGEsIGIpID0+IHtcbiAgICBpZiAoYS50aWVyID09PSBcImNvcmVcIiAmJiBiLnRpZXIgIT09IFwiY29yZVwiKSByZXR1cm4gLTE7XG4gICAgaWYgKGIudGllciA9PT0gXCJjb3JlXCIgJiYgYS50aWVyICE9PSBcImNvcmVcIikgcmV0dXJuIDE7XG4gICAgcmV0dXJuIGEuaWQubG9jYWxlQ29tcGFyZShiLmlkKTtcbiAgfSk7XG5cbiAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IGhkciA9IHBhZFJpZ2h0KFwiRXh0ZW5zaW9uc1wiLCAzOCkgKyBwYWRSaWdodChcIlN0YXR1c1wiLCAxMCkgKyBwYWRSaWdodChcIlRpZXJcIiwgMTApICsgcGFkUmlnaHQoXCJUb29sc1wiLCA3KSArIFwiQ29tbWFuZHNcIjtcbiAgbGluZXMucHVzaChoZHIpO1xuICBsaW5lcy5wdXNoKFwiXHUyNTAwXCIucmVwZWF0KGhkci5sZW5ndGgpKTtcblxuICBmb3IgKGNvbnN0IG0gb2Ygc29ydGVkKSB7XG4gICAgY29uc3QgZW5hYmxlZCA9IGlzRW5hYmxlZChyZWdpc3RyeSwgbS5pZCk7XG4gICAgY29uc3Qgc3RhdHVzID0gZW5hYmxlZCA/IFwiZW5hYmxlZFwiIDogXCJkaXNhYmxlZFwiO1xuICAgIGNvbnN0IHRvb2xDb3VudCA9IG0ucHJvdmlkZXM/LnRvb2xzPy5sZW5ndGggPz8gMDtcbiAgICBjb25zdCBjbWRDb3VudCA9IG0ucHJvdmlkZXM/LmNvbW1hbmRzPy5sZW5ndGggPz8gMDtcbiAgICBjb25zdCBsYWJlbCA9IGAke20uaWR9ICgke20ubmFtZX0pYDtcblxuICAgIGxpbmVzLnB1c2goXG4gICAgICBwYWRSaWdodChsYWJlbCwgMzgpICtcbiAgICAgIHBhZFJpZ2h0KHN0YXR1cywgMTApICtcbiAgICAgIHBhZFJpZ2h0KG0udGllciwgMTApICtcbiAgICAgIHBhZFJpZ2h0KFN0cmluZyh0b29sQ291bnQpLCA3KSArXG4gICAgICBTdHJpbmcoY21kQ291bnQpLFxuICAgICk7XG5cbiAgICAvLyBTaG93IHNvdXJjZSBpbmRpY2F0b3IgYW5kIGluc3RhbGwgaW5mbyBmb3IgdXNlci1pbnN0YWxsZWQgZXh0ZW5zaW9uc1xuICAgIGNvbnN0IHJlZ0VudHJ5ID0gcmVnaXN0cnkuZW50cmllc1ttLmlkXTtcbiAgICBpZiAocmVnRW50cnk/LnNvdXJjZSA9PT0gXCJ1c2VyXCIpIHtcbiAgICAgIC8vIEFwcGVuZCBbdXNlcl0gdGFnIHRvIHRoZSBsYXN0IGxpbmVcbiAgICAgIGNvbnN0IGxhc3RMaW5lID0gbGluZXNbbGluZXMubGVuZ3RoIC0gMV07XG4gICAgICBsaW5lc1tsaW5lcy5sZW5ndGggLSAxXSA9IGxhc3RMaW5lICsgXCIgICAgICBbdXNlcl1cIjtcbiAgICAgIGlmIChyZWdFbnRyeS5pbnN0YWxsZWRGcm9tKSB7XG4gICAgICAgIGNvbnN0IHR5cGVQcmVmaXggPSByZWdFbnRyeS5pbnN0YWxsVHlwZSA/IGAke3JlZ0VudHJ5Lmluc3RhbGxUeXBlfTpgIDogXCJcIjtcbiAgICAgICAgY29uc3QgdmVyc2lvblN1ZmZpeCA9IHJlZ0VudHJ5LnZlcnNpb24gPyBgQCR7cmVnRW50cnkudmVyc2lvbn1gIDogXCJcIjtcbiAgICAgICAgbGluZXMucHVzaChgICBpbnN0YWxsZWQgZnJvbTogJHt0eXBlUHJlZml4fSR7cmVnRW50cnkuaW5zdGFsbGVkRnJvbX0ke3ZlcnNpb25TdWZmaXh9YCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKCFlbmFibGVkKSB7XG4gICAgICBsaW5lcy5wdXNoKGAgIFx1MjFCMyBnc2QgZXh0ZW5zaW9ucyBlbmFibGUgJHttLmlkfWApO1xuICAgIH1cbiAgfVxuXG4gIGN0eC51aS5ub3RpZnkobGluZXMuam9pbihcIlxcblwiKSwgXCJpbmZvXCIpO1xufVxuXG5mdW5jdGlvbiBoYW5kbGVFbmFibGUoaWQ6IHN0cmluZyB8IHVuZGVmaW5lZCwgY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCk6IHZvaWQge1xuICBpZiAoIWlkKSB7XG4gICAgY3R4LnVpLm5vdGlmeShcIlVzYWdlOiAvZ3NkIGV4dGVuc2lvbnMgZW5hYmxlIDxpZD5cIiwgXCJ3YXJuaW5nXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IG1hbmlmZXN0cyA9IGRpc2NvdmVyTWFuaWZlc3RzKCk7XG4gIGlmICghbWFuaWZlc3RzLmhhcyhpZCkpIHtcbiAgICBjdHgudWkubm90aWZ5KGBFeHRlbnNpb24gXCIke2lkfVwiIG5vdCBmb3VuZC4gUnVuIC9nc2QgZXh0ZW5zaW9ucyBsaXN0IHRvIHNlZSBhdmFpbGFibGUgZXh0ZW5zaW9ucy5gLCBcIndhcm5pbmdcIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgYWxyZWFkeUVuYWJsZWQgPSB3aXRoUmVnaXN0cnlMb2NrKChyZWdpc3RyeSkgPT4ge1xuICAgIGlmIChpc0VuYWJsZWQocmVnaXN0cnksIGlkKSkgcmV0dXJuIHRydWU7XG4gICAgY29uc3QgZW50cnkgPSByZWdpc3RyeS5lbnRyaWVzW2lkXTtcbiAgICBpZiAoZW50cnkpIHtcbiAgICAgIGVudHJ5LmVuYWJsZWQgPSB0cnVlO1xuICAgICAgZGVsZXRlIGVudHJ5LmRpc2FibGVkQXQ7XG4gICAgICBkZWxldGUgZW50cnkuZGlzYWJsZWRSZWFzb247XG4gICAgfSBlbHNlIHtcbiAgICAgIHJlZ2lzdHJ5LmVudHJpZXNbaWRdID0geyBpZCwgZW5hYmxlZDogdHJ1ZSwgc291cmNlOiBcImJ1bmRsZWRcIiB9O1xuICAgIH1cbiAgICByZXR1cm4gZmFsc2U7XG4gIH0pO1xuICBpZiAoYWxyZWFkeUVuYWJsZWQpIHtcbiAgICBjdHgudWkubm90aWZ5KGBFeHRlbnNpb24gXCIke2lkfVwiIGlzIGFscmVhZHkgZW5hYmxlZC5gLCBcImluZm9cIik7XG4gICAgcmV0dXJuO1xuICB9XG4gIGN0eC51aS5ub3RpZnkoYEVuYWJsZWQgXCIke2lkfVwiLiBSZXN0YXJ0IEdTRCB0byBhY3RpdmF0ZS5gLCBcImluZm9cIik7XG59XG5cbmZ1bmN0aW9uIGhhbmRsZURpc2FibGUoaWQ6IHN0cmluZyB8IHVuZGVmaW5lZCwgcmVhc29uOiBzdHJpbmcsIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQpOiB2b2lkIHtcbiAgaWYgKCFpZCkge1xuICAgIGN0eC51aS5ub3RpZnkoXCJVc2FnZTogL2dzZCBleHRlbnNpb25zIGRpc2FibGUgPGlkPlwiLCBcIndhcm5pbmdcIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgbWFuaWZlc3RzID0gZGlzY292ZXJNYW5pZmVzdHMoKTtcbiAgY29uc3QgbWFuaWZlc3QgPSBtYW5pZmVzdHMuZ2V0KGlkKSA/PyBudWxsO1xuXG4gIGlmICghbWFuaWZlc3RzLmhhcyhpZCkpIHtcbiAgICBjdHgudWkubm90aWZ5KGBFeHRlbnNpb24gXCIke2lkfVwiIG5vdCBmb3VuZC4gUnVuIC9nc2QgZXh0ZW5zaW9ucyBsaXN0IHRvIHNlZSBhdmFpbGFibGUgZXh0ZW5zaW9ucy5gLCBcIndhcm5pbmdcIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKG1hbmlmZXN0Py50aWVyID09PSBcImNvcmVcIikge1xuICAgIGN0eC51aS5ub3RpZnkoYENhbm5vdCBkaXNhYmxlIFwiJHtpZH1cIiBcdTIwMTQgaXQgaXMgYSBjb3JlIGV4dGVuc2lvbi5gLCBcIndhcm5pbmdcIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgYWxyZWFkeURpc2FibGVkID0gd2l0aFJlZ2lzdHJ5TG9jaygocmVnaXN0cnkpID0+IHtcbiAgICBpZiAoIWlzRW5hYmxlZChyZWdpc3RyeSwgaWQpKSByZXR1cm4gdHJ1ZTtcbiAgICBjb25zdCBlbnRyeSA9IHJlZ2lzdHJ5LmVudHJpZXNbaWRdO1xuICAgIGlmIChlbnRyeSkge1xuICAgICAgZW50cnkuZW5hYmxlZCA9IGZhbHNlO1xuICAgICAgZW50cnkuZGlzYWJsZWRBdCA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcbiAgICAgIGVudHJ5LmRpc2FibGVkUmVhc29uID0gcmVhc29uIHx8IHVuZGVmaW5lZDtcbiAgICB9IGVsc2Uge1xuICAgICAgcmVnaXN0cnkuZW50cmllc1tpZF0gPSB7XG4gICAgICAgIGlkLFxuICAgICAgICBlbmFibGVkOiBmYWxzZSxcbiAgICAgICAgc291cmNlOiBcImJ1bmRsZWRcIixcbiAgICAgICAgZGlzYWJsZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgICBkaXNhYmxlZFJlYXNvbjogcmVhc29uIHx8IHVuZGVmaW5lZCxcbiAgICAgIH07XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfSk7XG4gIGlmIChhbHJlYWR5RGlzYWJsZWQpIHtcbiAgICBjdHgudWkubm90aWZ5KGBFeHRlbnNpb24gXCIke2lkfVwiIGlzIGFscmVhZHkgZGlzYWJsZWQuYCwgXCJpbmZvXCIpO1xuICAgIHJldHVybjtcbiAgfVxuICBjdHgudWkubm90aWZ5KGBEaXNhYmxlZCBcIiR7aWR9XCIuIFJlc3RhcnQgR1NEIHRvIGRlYWN0aXZhdGUuYCwgXCJpbmZvXCIpO1xufVxuXG5mdW5jdGlvbiBoYW5kbGVJbmZvKGlkOiBzdHJpbmcgfCB1bmRlZmluZWQsIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQpOiB2b2lkIHtcbiAgaWYgKCFpZCkge1xuICAgIGN0eC51aS5ub3RpZnkoXCJVc2FnZTogL2dzZCBleHRlbnNpb25zIGluZm8gPGlkPlwiLCBcIndhcm5pbmdcIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgbWFuaWZlc3RzID0gZGlzY292ZXJNYW5pZmVzdHMoKTtcbiAgY29uc3QgbWFuaWZlc3QgPSBtYW5pZmVzdHMuZ2V0KGlkKTtcbiAgaWYgKCFtYW5pZmVzdCkge1xuICAgIGN0eC51aS5ub3RpZnkoYEV4dGVuc2lvbiBcIiR7aWR9XCIgbm90IGZvdW5kLmAsIFwid2FybmluZ1wiKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCByZWdpc3RyeSA9IGxvYWRSZWdpc3RyeSgpO1xuICBjb25zdCBlbmFibGVkID0gaXNFbmFibGVkKHJlZ2lzdHJ5LCBpZCk7XG4gIGNvbnN0IGVudHJ5ID0gcmVnaXN0cnkuZW50cmllc1tpZF07XG5cbiAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW1xuICAgIGAke21hbmlmZXN0Lm5hbWV9ICgke21hbmlmZXN0LmlkfSlgLFxuICAgIFwiXCIsXG4gICAgYCAgVmVyc2lvbjogICAgICR7bWFuaWZlc3QudmVyc2lvbn1gLFxuICAgIGAgIERlc2NyaXB0aW9uOiAke21hbmlmZXN0LmRlc2NyaXB0aW9ufWAsXG4gICAgYCAgVGllcjogICAgICAgICR7bWFuaWZlc3QudGllcn1gLFxuICAgIGAgIFN0YXR1czogICAgICAke2VuYWJsZWQgPyBcImVuYWJsZWRcIiA6IFwiZGlzYWJsZWRcIn1gLFxuICBdO1xuXG4gIGlmIChlbnRyeT8uZGlzYWJsZWRBdCkge1xuICAgIGxpbmVzLnB1c2goYCAgRGlzYWJsZWQgYXQ6ICR7ZW50cnkuZGlzYWJsZWRBdH1gKTtcbiAgfVxuICBpZiAoZW50cnk/LmRpc2FibGVkUmVhc29uKSB7XG4gICAgbGluZXMucHVzaChgICBSZWFzb246ICAgICAgJHtlbnRyeS5kaXNhYmxlZFJlYXNvbn1gKTtcbiAgfVxuXG4gIC8vIFBoYXNlIDggZmllbGRzIGZvciB1c2VyLWluc3RhbGxlZCBleHRlbnNpb25zIChwZXIgVUktU1BFQylcbiAgaWYgKGVudHJ5Py5zb3VyY2UgPT09IFwidXNlclwiKSB7XG4gICAgaWYgKGVudHJ5Lmluc3RhbGxlZEZyb20pIHtcbiAgICAgIGxpbmVzLnB1c2goYCAgSW5zdGFsbGVkIGZyb206ICR7ZW50cnkuaW5zdGFsbGVkRnJvbX1gKTtcbiAgICB9XG4gICAgaWYgKGVudHJ5Lmluc3RhbGxUeXBlKSB7XG4gICAgICBsaW5lcy5wdXNoKGAgIEluc3RhbGwgdHlwZTogICAke2VudHJ5Lmluc3RhbGxUeXBlfWApO1xuICAgIH1cbiAgfVxuXG4gIGlmIChtYW5pZmVzdC5wcm92aWRlcykge1xuICAgIGxpbmVzLnB1c2goXCJcIik7XG4gICAgbGluZXMucHVzaChcIiAgUHJvdmlkZXM6XCIpO1xuICAgIGlmIChtYW5pZmVzdC5wcm92aWRlcy50b29scz8ubGVuZ3RoKSB7XG4gICAgICBsaW5lcy5wdXNoKGAgICAgVG9vbHM6ICAgICAke21hbmlmZXN0LnByb3ZpZGVzLnRvb2xzLmpvaW4oXCIsIFwiKX1gKTtcbiAgICB9XG4gICAgaWYgKG1hbmlmZXN0LnByb3ZpZGVzLmNvbW1hbmRzPy5sZW5ndGgpIHtcbiAgICAgIGxpbmVzLnB1c2goYCAgICBDb21tYW5kczogICR7bWFuaWZlc3QucHJvdmlkZXMuY29tbWFuZHMuam9pbihcIiwgXCIpfWApO1xuICAgIH1cbiAgICBpZiAobWFuaWZlc3QucHJvdmlkZXMuaG9va3M/Lmxlbmd0aCkge1xuICAgICAgbGluZXMucHVzaChgICAgIEhvb2tzOiAgICAgJHttYW5pZmVzdC5wcm92aWRlcy5ob29rcy5qb2luKFwiLCBcIil9YCk7XG4gICAgfVxuICAgIGlmIChtYW5pZmVzdC5wcm92aWRlcy5zaG9ydGN1dHM/Lmxlbmd0aCkge1xuICAgICAgbGluZXMucHVzaChgICAgIFNob3J0Y3V0czogJHttYW5pZmVzdC5wcm92aWRlcy5zaG9ydGN1dHMuam9pbihcIiwgXCIpfWApO1xuICAgIH1cbiAgfVxuXG4gIGlmIChtYW5pZmVzdC5kZXBlbmRlbmNpZXMpIHtcbiAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICAgIGxpbmVzLnB1c2goXCIgIERlcGVuZGVuY2llczpcIik7XG4gICAgaWYgKG1hbmlmZXN0LmRlcGVuZGVuY2llcy5leHRlbnNpb25zPy5sZW5ndGgpIHtcbiAgICAgIGxpbmVzLnB1c2goYCAgICBFeHRlbnNpb25zOiAke21hbmlmZXN0LmRlcGVuZGVuY2llcy5leHRlbnNpb25zLmpvaW4oXCIsIFwiKX1gKTtcbiAgICB9XG4gICAgaWYgKG1hbmlmZXN0LmRlcGVuZGVuY2llcy5ydW50aW1lPy5sZW5ndGgpIHtcbiAgICAgIGxpbmVzLnB1c2goYCAgICBSdW50aW1lOiAgICAke21hbmlmZXN0LmRlcGVuZGVuY2llcy5ydW50aW1lLmpvaW4oXCIsIFwiKX1gKTtcbiAgICB9XG4gIH1cblxuICBjdHgudWkubm90aWZ5KGxpbmVzLmpvaW4oXCJcXG5cIiksIFwiaW5mb1wiKTtcbn1cblxuZnVuY3Rpb24gaGFuZGxlVmFsaWRhdGUocGF0aDogc3RyaW5nIHwgdW5kZWZpbmVkLCBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0KTogdm9pZCB7XG4gIGlmICghcGF0aCkge1xuICAgIGN0eC51aS5ub3RpZnkoXCJVc2FnZTogL2dzZCBleHRlbnNpb25zIHZhbGlkYXRlIDxwYXRoPlwiLCBcIndhcm5pbmdcIik7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHJlc29sdmVkID0gcmVzb2x2ZShwYXRoKTtcbiAgaWYgKCFleGlzdHNTeW5jKHJlc29sdmVkKSkge1xuICAgIGN0eC51aS5ub3RpZnkoYFBhdGggbm90IGZvdW5kOiAke3Jlc29sdmVkfWAsIFwid2FybmluZ1wiKTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgcmVzdWx0ID0gdmFsaWRhdGVFeHRlbnNpb25QYWNrYWdlKHJlc29sdmVkKTtcbiAgaWYgKHJlc3VsdC52YWxpZCkge1xuICAgIGN0eC51aS5ub3RpZnkoYFZhbGlkIGV4dGVuc2lvbiBwYWNrYWdlOiAke3Jlc29sdmVkfWAsIFwiaW5mb1wiKTtcbiAgfSBlbHNlIHtcbiAgICBjdHgudWkubm90aWZ5KFxuICAgICAgYEludmFsaWQgZXh0ZW5zaW9uIHBhY2thZ2U6ICR7cmVzb2x2ZWR9XFxuYCArXG4gICAgICByZXN1bHQuZXJyb3JzLm1hcChlID0+IGAgIC0gJHtlfWApLmpvaW4oXCJcXG5cIiksXG4gICAgICBcIndhcm5pbmdcIixcbiAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHBhZFJpZ2h0KHN0cjogc3RyaW5nLCBsZW46IG51bWJlcik6IHN0cmluZyB7XG4gIHJldHVybiBzdHIubGVuZ3RoID49IGxlbiA/IHN0ciArIFwiIFwiIDogc3RyICsgXCIgXCIucmVwZWF0KGxlbiAtIHN0ci5sZW5ndGgpO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBU0EsU0FBUyxRQUFRLFlBQVksV0FBVyxhQUFhLGNBQWMsYUFBYSxZQUFZLFFBQVEscUJBQXFCO0FBQ3pILFNBQVMsU0FBUyxNQUFNLGVBQWU7QUFDdkMsU0FBUyxTQUFTLGNBQWM7QUFDaEMsU0FBUyxvQkFBb0I7QUFDN0IsU0FBUyxVQUFVLGtCQUFrQjtBQUNyQyxTQUFTLGVBQWU7QUFpQmpCLFNBQVMsaUJBQWlCLEdBQVcsR0FBb0I7QUFDOUQsUUFBTSxRQUFRLENBQUMsTUFBeUQ7QUFDdEUsVUFBTSxPQUFPLEVBQUUsUUFBUSxHQUFHO0FBQzFCLFVBQU0sV0FBVyxTQUFTLEtBQUssSUFBSSxFQUFFLE1BQU0sR0FBRyxJQUFJLEdBQy9DLE1BQU0sR0FBRyxFQUNULElBQUksVUFBUSxPQUFPLFNBQVMsTUFBTSxFQUFFLEtBQUssQ0FBQztBQUM3QyxVQUFNLE1BQU0sU0FBUyxLQUFLLE9BQU8sRUFBRSxNQUFNLE9BQU8sQ0FBQztBQUNqRCxXQUFPLEVBQUUsU0FBUyxJQUFJO0FBQUEsRUFDeEI7QUFDQSxRQUFNLEtBQUssTUFBTSxDQUFDO0FBQ2xCLFFBQU0sS0FBSyxNQUFNLENBQUM7QUFDbEIsUUFBTSxNQUFNLEtBQUssSUFBSSxHQUFHLFFBQVEsUUFBUSxHQUFHLFFB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
