import { SettingsManager, getAgentDir } from "@gsd/pi-coding-agent";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { PluginImporter } from "./plugin-importer.js";
const SKIP_DIRS = /* @__PURE__ */ new Set([
  ".git",
  "node_modules",
  ".worktrees",
  "dist",
  "build",
  ".next",
  ".turbo",
  "cache",
  ".cache"
]);
function uniqueExistingDirs(paths) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const candidate of paths) {
    const resolvedPath = resolve(candidate);
    if (seen.has(resolvedPath)) continue;
    seen.add(resolvedPath);
    if (existsSync(resolvedPath)) out.push(resolvedPath);
  }
  return out;
}
function getClaudeSearchRoots(cwd) {
  const home = homedir();
  const parent = resolve(cwd, "..");
  const grandparent = resolve(cwd, "..", "..");
  const skillRoots = uniqueExistingDirs([
    join(home, ".claude", "skills"),
    join(home, "repos", "claude_skills"),
    join(home, "repos", "skills"),
    join(parent, "claude_skills"),
    join(parent, "skills"),
    join(grandparent, "claude_skills"),
    join(grandparent, "skills")
  ]);
  const pluginRoots = uniqueExistingDirs([
    join(home, ".claude", "plugins", "marketplaces"),
    join(home, ".claude", "plugins", "cache"),
    join(home, ".claude", "plugins"),
    join(home, "repos", "claude-plugins-official"),
    join(home, "repos", "claude_skills"),
    join(parent, "claude-plugins-official"),
    join(parent, "claude_skills"),
    join(grandparent, "claude-plugins-official"),
    join(grandparent, "claude_skills")
  ]);
  return { skillRoots, pluginRoots };
}
function sourceLabel(path) {
  const home = homedir();
  if (path.startsWith(join(home, ".claude"))) return "claude-home";
  if (path.startsWith(join(home, "repos"))) return "repos";
  return "local";
}
function isMarketplacePath(pluginPath) {
  const marketplaceJson = join(pluginPath, ".claude-plugin", "marketplace.json");
  return existsSync(marketplaceJson);
}
function categorizePluginRoots(pluginRoots) {
  const marketplaces = [];
  const flat = [];
  const seen = /* @__PURE__ */ new Set();
  for (const root of pluginRoots) {
    if (isMarketplacePath(root)) {
      if (!seen.has(root)) {
        marketplaces.push(root);
        seen.add(root);
      }
    } else {
      let foundChild = false;
      try {
        const entries = readdirSync(root, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (SKIP_DIRS.has(entry.name)) continue;
          const childPath = join(root, entry.name);
          if (isMarketplacePath(childPath) && !seen.has(childPath)) {
            marketplaces.push(childPath);
            seen.add(childPath);
            foundChild = true;
          }
        }
      } catch {
      }
      if (!foundChild) {
        flat.push(root);
      }
    }
  }
  return { marketplaces, flat };
}
function walkDirs(root, visit, maxDepth = 4) {
  function walk(dir, depth) {
    visit(dir, depth);
    if (depth >= maxDepth) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), depth + 1);
    }
  }
  walk(root, 0);
}
function discoverClaudeSkills(cwd) {
  const { skillRoots } = getClaudeSearchRoots(cwd);
  const results = [];
  const seen = /* @__PURE__ */ new Set();
  for (const root of skillRoots) {
    walkDirs(root, (dir) => {
      const skillFile = join(dir, "SKILL.md");
      if (!existsSync(skillFile)) return;
      const resolvedDir = resolve(dir);
      if (seen.has(resolvedDir)) return;
      seen.add(resolvedDir);
      results.push({
        type: "skill",
        name: basename(dir),
        path: resolvedDir,
        root,
        sourceLabel: sourceLabel(root)
      });
    }, 5);
  }
  return results.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}
function discoverClaudePlugins(cwd) {
  const { pluginRoots } = getClaudeSearchRoots(cwd);
  const results = [];
  const seen = /* @__PURE__ */ new Set();
  for (const root of pluginRoots) {
    walkDirs(root, (dir) => {
      const pkgPath = join(dir, "package.json");
      const claudePluginPath = join(dir, ".claude-plugin", "plugin.json");
      const hasPkg = existsSync(pkgPath);
      const hasClaudePlugin = existsSync(claudePluginPath);
      if (!hasPkg && !hasClaudePlugin) return;
      const resolvedDir = resolve(dir);
      if (seen.has(resolvedDir)) return;
      seen.add(resolvedDir);
      let packageName;
      if (hasPkg) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
          packageName = pkg.name;
        } catch {
          packageName = void 0;
        }
      } else if (hasClaudePlugin) {
        try {
          const manifest = JSON.parse(readFileSync(claudePluginPath, "utf8"));
          packageName = manifest.name;
        } catch {
          packageName = void 0;
        }
      }
      results.push({
        type: "plugin",
        name: packageName || basename(dir),
        packageName,
        path: resolvedDir,
        root,
        sourceLabel: sourceLabel(root)
      });
    }, 4);
  }
  return results.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}
async function chooseMany(ctx, title, candidates) {
  if (candidates.length === 0) return [];
  const mode = await ctx.ui.select(`${title} (${candidates.length} found)`, [
    "Import all discovered",
    "Select individually",
    "Cancel"
  ]);
  if (!mode || mode === "Cancel") return [];
  if (mode === "Import all discovered") return candidates;
  const remaining = [...candidates];
  const selected = [];
  while (remaining.length > 0) {
    const options = [
      ...remaining.map((item) => `${item.name} \u2014 ${item.sourceLabel} \u2014 ${relative(item.root, item.path) || "."}`),
      "Done selecting"
    ];
    const picked = await ctx.ui.select(`${title}: choose an item`, options);
    if (!picked || picked === "Done selecting") break;
    const pickedStr = Array.isArray(picked) ? picked[0] : picked;
    if (!pickedStr) break;
    const idx = options.indexOf(pickedStr);
    if (idx < 0 || idx >= remaining.length) break;
    selected.push(remaining[idx]);
    remaining.splice(idx, 1);
  }
  return selected;
}
function mergeStringList(existing, additions) {
  const list = Array.isArray(existing) ? existing.filter((v) => typeof v === "string") : [];
  const seen = new Set(list);
  for (const item of additions) {
    if (!seen.has(item)) {
      list.push(item);
      seen.add(item);
    }
  }
  return list;
}
function mergePackageSources(existing, additions) {
  const current = Array.isArray(existing) ? existing.filter((v) => typeof v === "string" || typeof v === "object" && v !== null && typeof v.source === "string") : [];
  const seen = new Set(current.map((entry) => typeof entry === "string" ? entry : entry.source));
  const merged = [...current];
  for (const add of additions) {
    if (!seen.has(add)) {
      merged.push(add);
      seen.add(add);
    }
  }
  return merged;
}
function formatComponentForSelection(comp) {
  const typeLabel = comp.type === "skill" ? "\u{1F527}" : "\u{1F916}";
  const nsLabel = comp.namespace ? `${comp.namespace}:` : "";
  return `${typeLabel} ${nsLabel}${comp.name}`;
}
async function selectMarketplaceComponents(ctx, importer, scope) {
  const plugins = importer.getDiscoveredPlugins();
  if (plugins.length === 0) {
    ctx.ui.notify("No plugins discovered in marketplace.", "info");
    return [];
  }
  const allComponents = [];
  for (const plugin of plugins) {
    const components = importer.selectComponents((c) => c.namespace === plugin.canonicalName);
    for (const comp of components) {
      allComponents.push({
        component: comp,
        displayName: formatComponentForSelection(comp),
        pluginName: plugin.canonicalName
      });
    }
  }
  if (allComponents.length === 0) {
    ctx.ui.notify("No components (skills/agents) found in marketplace plugins.", "info");
    return [];
  }
  const mode = await ctx.ui.select(
    `Marketplace components \u2192 ${scope} config (${allComponents.length} found across ${plugins.length} plugins)`,
    [
      "Import all components",
      "Select by plugin",
      "Select individually",
      "Cancel"
    ]
  );
  if (!mode || mode === "Cancel") return [];
  if (mode === "Import all components") {
    return allComponents.map((c) => c.component);
  }
  if (mode === "Select by plugin") {
    const pluginNames = plugins.map((p) => p.canonicalName);
    const selectedPluginNames = [];
    while (true) {
      const remaining2 = pluginNames.filter((n) => !selectedPluginNames.includes(n));
      if (remaining2.length === 0) break;
      const options = [...remaining2, "Done selecting"];
      const picked = await ctx.ui.select("Select a plugin to import all its components", options);
      if (!picked || picked === "Done selecting") break;
      const pickedStr = Array.isArray(picked) ? picked[0] : picked;
      if (!pickedStr) break;
      selectedPluginNames.push(pickedStr);
    }
    return allComponents.filter((c) => selectedPluginNames.includes(c.pluginName)).map((c) => c.component);
  }
  const remaining = [...allComponents];
  const selected = [];
  while (remaining.length > 0) {
    const options = remaining.map(
      (c) => `${c.displayName} \u2014 ${c.pluginName}`
    );
    options.push("Done selecting");
    const picked = await ctx.ui.select("Select a component to import", options);
    if (!picked || picked === "Done selecting") break;
    const pickedStr = Array.isArray(picked) ? picked[0] : picked;
    if (!pickedStr) break;
    const idx = options.indexOf(pickedStr);
    if (idx < 0 || idx >= remaining.length) break;
    selected.push(remaining[idx].component);
    remaining.splice(idx, 1);
  }
  return selected;
}
function formatDiagnosticsForUser(diagnostics) {
  const lines = [];
  const errors = diagnostics.filter((d) => d.severity === "error");
  const warnings = diagnostics.filter((d) => d.severity === "warning");
  if (errors.length > 0) {
    lines.push(`\u274C ${errors.length} error(s) blocking import:`);
    for (const err of errors) {
      lines.push(`   - ${err.class}: ${err.involvedCanonicalNames.join(", ")}`);
      lines.push(`     ${err.remediation}`);
    }
  }
  if (warnings.length > 0) {
    lines.push(`\u26A0\uFE0F ${warnings.length} warning(s):`);
    for (const warn of warnings) {
      lines.push(`   - ${warn.class}: ${warn.involvedCanonicalNames.join(", ")}`);
    }
  }
  return lines.join("\n");
}
function persistManifestToSettings(manifestEntries, settingsManager, scope) {
  const skillPaths = manifestEntries.filter((e) => e.type === "skill").map((e) => e.filePath);
  const agentPaths = manifestEntries.filter((e) => e.type === "agent").map((e) => e.filePath);
  if (skillPaths.length > 0) {
    if (scope === "project") {
      settingsManager.setProjectSkillPaths(
        mergeStringList(settingsManager.getProjectSettings().skills, skillPaths)
      );
    } else {
      settingsManager.setSkillPaths(
        mergeStringList(settingsManager.getGlobalSettings().skills, skillPaths)
      );
    }
  }
}
async function runClaudeImportFlow(ctx, scope, readPrefs, writePrefs) {
  const cwd = process.cwd();
  const settingsManager = SettingsManager.create(cwd, getAgentDir());
  const { skillRoots, pluginRoots } = getClaudeSearchRoots(cwd);
  const { marketplaces, flat } = categorizePluginRoots(pluginRoots);
  const assetChoice = await ctx.ui.select("Import Claude assets into GSD/Pi config", [
    "Skills + plugins",
    "Skills only",
    "Plugins only",
    "Cancel"
  ]);
  if (!assetChoice || assetChoice === "Cancel") return;
  const importSkills = assetChoice !== "Plugins only";
  const importPlugins = assetChoice !== "Skills only";
  let importedSkillsCount = 0;
  let importedPluginsCount = 0;
  let importedMarketplaceComponents = 0;
  const canonicalNamesPersisted = [];
  if (importSkills) {
    const discoveredSkills = discoverClaudeSkills(cwd);
    const selectedSkills = await chooseMany(ctx, `Claude skills \u2192 ${scope} preferences`, discoveredSkills);
    if (selectedSkills.length > 0) {
      const prefMode = await ctx.ui.select("How should GSD treat the imported skills?", [
        "Always use when relevant",
        "Prefer when relevant",
        "Do not modify skill preferences"
      ]);
      const prefs = readPrefs();
      const skillPaths = selectedSkills.map((skill) => skill.path);
      if (prefMode === "Always use when relevant") {
        prefs.always_use_skills = mergeStringList(prefs.always_use_skills, skillPaths);
      } else if (prefMode === "Prefer when relevant") {
        prefs.prefer_skills = mergeStringList(prefs.prefer_skills, skillPaths);
      }
      await writePrefs(prefs);
      if (scope === "project") {
        settingsManager.setProjectSkillPaths(mergeStringList(settingsManager.getProjectSettings().skills, skillPaths));
      } else {
        settingsManager.setSkillPaths(mergeStringList(settingsManager.getGlobalSettings().skills, skillPaths));
      }
      importedSkillsCount = selectedSkills.length;
    }
  }
  if (importPlugins && marketplaces.length > 0) {
    const marketplaceChoice = await ctx.ui.select(
      `Found ${marketplaces.length} marketplace(s). Import from marketplace?`,
      [
        "Yes - discover plugins and select components",
        "Skip marketplaces (use legacy plugin paths only)",
        "Cancel"
      ]
    );
    if (marketplaceChoice === "Yes - discover plugins and select components") {
      const importer = new PluginImporter();
      const discovery = importer.discover(marketplaces);
      if (discovery.summary.totalPlugins > 0) {
        const selectedComponents = await selectMarketplaceComponents(ctx, importer, scope);
        if (selectedComponents.length > 0) {
          const validation = importer.validateImport(selectedComponents);
          if (validation.diagnostics.length > 0) {
            const diagMessage = formatDiagnosticsForUser(validation.diagnostics);
            ctx.ui.notify(diagMessage, validation.canProceed ? "warning" : "error");
            if (!validation.canProceed) {
              ctx.ui.notify(
                "Import blocked due to canonical name conflicts. Please resolve the errors above.",
                "error"
              );
              return;
            }
            const proceed = await ctx.ui.select(
              "Warnings detected. Continue with import?",
              ["Yes, continue", "Cancel"]
            );
            if (proceed !== "Yes, continue") {
              return;
            }
          }
          const manifest = importer.getImportManifest(selectedComponents);
          persistManifestToSettings(manifest.entries, settingsManager, scope);
          importedMarketplaceComponents = selectedComponents.length;
          canonicalNamesPersisted.push(...manifest.entries.map((e) => e.canonicalName));
        }
      } else {
        ctx.ui.notify(`No plugins discovered in ${marketplaces.length} marketplace(s).`, "info");
      }
    }
  }
  if (importPlugins && flat.length > 0) {
    const discoveredPlugins = [];
    const seen = /* @__PURE__ */ new Set();
    for (const root of flat) {
      walkDirs(root, (dir) => {
        const pkgPath = join(dir, "package.json");
        if (!existsSync(pkgPath)) return;
        const resolvedDir = resolve(dir);
        if (seen.has(resolvedDir)) return;
        seen.add(resolvedDir);
        let packageName;
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
          packageName = pkg.name;
        } catch {
          packageName = void 0;
        }
        discoveredPlugins.push({
          type: "plugin",
          name: packageName || basename(dir),
          packageName,
          path: resolvedDir,
          root,
          sourceLabel: sourceLabel(root)
        });
      }, 4);
    }
    const sortedPlugins = discoveredPlugins.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
    const selectedPlugins = await chooseMany(ctx, `Claude plugins/packages \u2192 ${scope} Pi settings`, sortedPlugins);
    if (selectedPlugins.length > 0) {
      const pluginPaths = selectedPlugins.map((plugin) => plugin.path);
      if (scope === "project") {
        settingsManager.setProjectPackages(mergePackageSources(settingsManager.getProjectSettings().packages, pluginPaths));
      } else {
        settingsManager.setPackages(mergePackageSources(settingsManager.getGlobalSettings().packages, pluginPaths));
      }
      importedPluginsCount = selectedPlugins.length;
    }
  }
  if (importedSkillsCount === 0 && importedPluginsCount === 0 && importedMarketplaceComponents === 0) {
    ctx.ui.notify("Claude import cancelled or nothing selected.", "info");
    return;
  }
  await ctx.waitForIdle();
  await ctx.reload();
  const lines = [
    `Imported Claude assets into ${scope} config:`,
    `- Skills (flat): ${importedSkillsCount}`,
    `- Plugins (flat paths): ${importedPluginsCount}`,
    `- Marketplace components: ${importedMarketplaceComponents}`
  ];
  if (importedSkillsCount > 0) {
    lines.push(`- Skill paths added to Pi settings (${scope}) for availability`);
    lines.push(`- Skill refs added to GSD preferences (${scope}) when selected`);
  }
  if (importedPluginsCount > 0) {
    lines.push(`- Plugin/package paths added to Pi settings (${scope}) packages`);
  }
  if (importedMarketplaceComponents > 0) {
    lines.push(`- Canonical names preserved: ${canonicalNamesPersisted.length} entries`);
    if (canonicalNamesPersisted.length <= 10) {
      lines.push(`  Names: ${canonicalNamesPersisted.join(", ")}`);
    }
  }
  ctx.ui.notify(lines.join("\n"), "info");
}
export {
  categorizePluginRoots,
  discoverClaudePlugins,
  discoverClaudeSkills,
  getClaudeSearchRoots,
  runClaudeImportFlow
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9jbGF1ZGUtaW1wb3J0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdHlwZSB7IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0IH0gZnJvbSBcIkBnc2QvcGktY29kaW5nLWFnZW50XCI7XG5pbXBvcnQgeyBTZXR0aW5nc01hbmFnZXIsIGdldEFnZW50RGlyIH0gZnJvbSBcIkBnc2QvcGktY29kaW5nLWFnZW50XCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkZGlyU3luYywgcmVhZEZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBkaXJuYW1lLCBqb2luLCByZWxhdGl2ZSwgcmVzb2x2ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGhvbWVkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgUGx1Z2luSW1wb3J0ZXIsIHR5cGUgSW1wb3J0TWFuaWZlc3RFbnRyeSB9IGZyb20gXCIuL3BsdWdpbi1pbXBvcnRlci5qc1wiO1xuaW1wb3J0IHR5cGUgeyBOYW1lc3BhY2VkQ29tcG9uZW50IH0gZnJvbSBcIi4vbmFtZXNwYWNlZC1yZWdpc3RyeS5qc1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIENsYXVkZVNraWxsQ2FuZGlkYXRlIHtcbiAgdHlwZTogXCJza2lsbFwiO1xuICBuYW1lOiBzdHJpbmc7XG4gIHBhdGg6IHN0cmluZztcbiAgcm9vdDogc3RyaW5nO1xuICBzb3VyY2VMYWJlbDogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIENsYXVkZVBsdWdpbkNhbmRpZGF0ZSB7XG4gIHR5cGU6IFwicGx1Z2luXCI7XG4gIG5hbWU6IHN0cmluZztcbiAgcGF0aDogc3RyaW5nO1xuICByb290OiBzdHJpbmc7XG4gIHNvdXJjZUxhYmVsOiBzdHJpbmc7XG4gIHBhY2thZ2VOYW1lPzogc3RyaW5nO1xufVxuXG5jb25zdCBTS0lQX0RJUlMgPSBuZXcgU2V0KFtcbiAgXCIuZ2l0XCIsXG4gIFwibm9kZV9tb2R1bGVzXCIsXG4gIFwiLndvcmt0cmVlc1wiLFxuICBcImRpc3RcIixcbiAgXCJidWlsZFwiLFxuICBcIi5uZXh0XCIsXG4gIFwiLnR1cmJvXCIsXG4gIFwiY2FjaGVcIixcbiAgXCIuY2FjaGVcIixcbl0pO1xuXG5mdW5jdGlvbiB1bmlxdWVFeGlzdGluZ0RpcnMocGF0aHM6IHN0cmluZ1tdKTogc3RyaW5nW10ge1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IG91dDogc3RyaW5nW10gPSBbXTtcbiAgZm9yIChjb25zdCBjYW5kaWRhdGUgb2YgcGF0aHMpIHtcbiAgICBjb25zdCByZXNvbHZlZFBhdGggPSByZXNvbHZlKGNhbmRpZGF0ZSk7XG4gICAgaWYgKHNlZW4uaGFzKHJlc29sdmVkUGF0aCkpIGNvbnRpbnVlO1xuICAgIHNlZW4uYWRkKHJlc29sdmVkUGF0aCk7XG4gICAgaWYgKGV4aXN0c1N5bmMocmVzb2x2ZWRQYXRoKSkgb3V0LnB1c2gocmVzb2x2ZWRQYXRoKTtcbiAgfVxuICByZXR1cm4gb3V0O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0Q2xhdWRlU2VhcmNoUm9vdHMoY3dkOiBzdHJpbmcpOiB7IHNraWxsUm9vdHM6IHN0cmluZ1tdOyBwbHVnaW5Sb290czogc3RyaW5nW10gfSB7XG4gIGNvbnN0IGhvbWUgPSBob21lZGlyKCk7XG4gIGNvbnN0IHBhcmVudCA9IHJlc29sdmUoY3dkLCBcIi4uXCIpO1xuICBjb25zdCBncmFuZHBhcmVudCA9IHJlc29sdmUoY3dkLCBcIi4uXCIsIFwiLi5cIik7XG5cbiAgLy8gQ2xhdWRlIENvZGUgdXNlci1zY29wZSBza2lsbHMgbGl2ZSB1bmRlciB+Ly5jbGF1ZGUvc2tpbGxzLlxuICAvLyBLZWVwIHNpYmxpbmcvbG9jYWwgY2xvbmUgZmFsbGJhY2tzIGZvciBkZXZlbG9wZXIgd29ya2Zsb3dzLCBidXQgdGhleSBhcmVcbiAgLy8gZXhhbXBsZXMvY29udmVuaWVuY2UgcGF0aHMgcmF0aGVyIHRoYW4gdGhlIHByaW1hcnkgQ2xhdWRlIHN0b3JhZ2UgbW9kZWwuXG4gIGNvbnN0IHNraWxsUm9vdHMgPSB1bmlxdWVFeGlzdGluZ0RpcnMoW1xuICAgIGpvaW4oaG9tZSwgXCIuY2xhdWRlXCIsIFwic2tpbGxzXCIpLFxuICAgIGpvaW4oaG9tZSwgXCJyZXBvc1wiLCBcImNsYXVkZV9za2lsbHNcIiksXG4gICAgam9pbihob21lLCBcInJlcG9zXCIsIFwic2tpbGxzXCIpLFxuICAgIGpvaW4ocGFyZW50LCBcImNsYXVkZV9za2lsbHNcIiksXG4gICAgam9pbihwYXJlbnQsIFwic2tpbGxzXCIpLFxuICAgIGpvaW4oZ3JhbmRwYXJlbnQsIFwiY2xhdWRlX3NraWxsc1wiKSxcbiAgICBqb2luKGdyYW5kcGFyZW50LCBcInNraWxsc1wiKSxcbiAgXSk7XG5cbiAgLy8gQW50aHJvcGljIGRvY3MgbW9kZWwgbWFya2V0cGxhY2VzIGFzIHNvdXJjZXMgdXNlcnMgYWRkIHdpdGhcbiAgLy8gYC9wbHVnaW4gbWFya2V0cGxhY2UgYWRkIC4uLmAsIGFuZCBDbGF1ZGUgc3RvcmVzIHRob3NlIG1hcmtldHBsYWNlcyB1bmRlclxuICAvLyB+Ly5jbGF1ZGUvcGx1Z2lucy9tYXJrZXRwbGFjZXMvLiBJbnN0YWxsZWQgcGx1Z2luIHBheWxvYWRzIGFyZSBjb3BpZWQgaW50b1xuICAvLyB+Ly5jbGF1ZGUvcGx1Z2lucy9jYWNoZS8uIFdlIHByZWZlciB0aG9zZSBzdGFibGUgQ2xhdWRlLW1hbmFnZWQgbG9jYXRpb25zXG4gIC8vIGJlZm9yZSBsb2NhbCBleGFtcGxlIGNsb25lcy5cbiAgY29uc3QgcGx1Z2luUm9vdHMgPSB1bmlxdWVFeGlzdGluZ0RpcnMoW1xuICAgIGpvaW4oaG9tZSwgXCIuY2xhdWRlXCIsIFwicGx1Z2luc1wiLCBcIm1hcmtldHBsYWNlc1wiKSxcbiAgICBqb2luKGhvbWUsIFwiLmNsYXVkZVwiLCBcInBsdWdpbnNcIiwgXCJjYWNoZVwiKSxcbiAgICBqb2luKGhvbWUsIFwiLmNsYXVkZVwiLCBcInBsdWdpbnNcIiksXG4gICAgam9pbihob21lLCBcInJlcG9zXCIsIFwiY2xhdWRlLXBsdWdpbnMtb2ZmaWNpYWxcIiksXG4gICAgam9pbihob21lLCBcInJlcG9zXCIsIFwiY2xhdWRlX3NraWxsc1wiKSxcbiAgICBqb2luKHBhcmVudCwgXCJjbGF1ZGUtcGx1Z2lucy1vZmZpY2lhbFwiKSxcbiAgICBqb2luKHBhcmVudCwgXCJjbGF1ZGVfc2tpbGxzXCIpLFxuICAgIGpvaW4oZ3JhbmRwYXJlbnQsIFwiY2xhdWRlLXBsdWdpbnMtb2ZmaWNpYWxcIiksXG4gICAgam9pbihncmFuZHBhcmVudCwgXCJjbGF1ZGVfc2tpbGxzXCIpLFxuICBdKTtcblxuICByZXR1cm4geyBza2lsbFJvb3RzLCBwbHVnaW5Sb290cyB9O1xufVxuXG5mdW5jdGlvbiBzb3VyY2VMYWJlbChwYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBob21lID0gaG9tZWRpcigpO1xuICBpZiAocGF0aC5zdGFydHNXaXRoKGpvaW4oaG9tZSwgXCIuY2xhdWRlXCIpKSkgcmV0dXJuIFwiY2xhdWRlLWhvbWVcIjtcbiAgaWYgKHBhdGguc3RhcnRzV2l0aChqb2luKGhvbWUsIFwicmVwb3NcIikpKSByZXR1cm4gXCJyZXBvc1wiO1xuICByZXR1cm4gXCJsb2NhbFwiO1xufVxuXG4vKipcbiAqIENoZWNrIGlmIGEgcGF0aCBpcyBhIG1hcmtldHBsYWNlIGRpcmVjdG9yeSAoY29udGFpbnMgLmNsYXVkZS1wbHVnaW4vbWFya2V0cGxhY2UuanNvbikuXG4gKiBNYXJrZXRwbGFjZSBwYXRocyB1c2UgdGhlIFBsdWdpbkltcG9ydGVyIGZsb3c7IG5vbi1tYXJrZXRwbGFjZSB1c2UgdGhlIGxlZ2FjeSBmbGF0IGZsb3cuXG4gKi9cbmZ1bmN0aW9uIGlzTWFya2V0cGxhY2VQYXRoKHBsdWdpblBhdGg6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBtYXJrZXRwbGFjZUpzb24gPSBqb2luKHBsdWdpblBhdGgsIFwiLmNsYXVkZS1wbHVnaW5cIiwgXCJtYXJrZXRwbGFjZS5qc29uXCIpO1xuICByZXR1cm4gZXhpc3RzU3luYyhtYXJrZXRwbGFjZUpzb24pO1xufVxuXG4vKipcbiAqIERldGVjdCB3aGljaCBwbHVnaW4gcm9vdHMgYXJlIG1hcmtldHBsYWNlcyBhbmQgd2hpY2ggYXJlIGxlZ2FjeSBmbGF0IHBhdGhzLlxuICpcbiAqIENsYXVkZSBDb2RlIHN0b3JlcyBtYXJrZXRwbGFjZSBzb3VyY2VzIHVuZGVyIH4vLmNsYXVkZS9wbHVnaW5zL21hcmtldHBsYWNlcy8uXG4gKiBFYWNoIHN1YmRpcmVjdG9yeSAoZS5nLiBtYXJrZXRwbGFjZXMvY29uZmx1ZW50LykgaXMgYSBtYXJrZXRwbGFjZSByZXBvIHRoYXRcbiAqIGNvbnRhaW5zIC5jbGF1ZGUtcGx1Z2luL21hcmtldHBsYWNlLmpzb24uIFRoZSBwYXJlbnQgZGlyZWN0b3J5IGl0c2VsZiBkb2VzIG5vdFxuICogaGF2ZSBhIG1hcmtldHBsYWNlLmpzb24sIHNvIHdlIHNjYW4gb25lIGxldmVsIGRlZXBlciB3aGVuIHRoZSByb290IGlzbid0XG4gKiBkaXJlY3RseSBhIG1hcmtldHBsYWNlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY2F0ZWdvcml6ZVBsdWdpblJvb3RzKHBsdWdpblJvb3RzOiBzdHJpbmdbXSk6IHsgbWFya2V0cGxhY2VzOiBzdHJpbmdbXTsgZmxhdDogc3RyaW5nW10gfSB7XG4gIGNvbnN0IG1hcmtldHBsYWNlczogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgZmxhdDogc3RyaW5nW10gPSBbXTtcbiAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4gIGZvciAoY29uc3Qgcm9vdCBvZiBwbHVnaW5Sb290cykge1xuICAgIGlmIChpc01hcmtldHBsYWNlUGF0aChyb290KSkge1xuICAgICAgaWYgKCFzZWVuLmhhcyhyb290KSkge1xuICAgICAgICBtYXJrZXRwbGFjZXMucHVzaChyb290KTtcbiAgICAgICAgc2Vlbi5hZGQocm9vdCk7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIFRoZSByb290IGl0c2VsZiBpc24ndCBhIG1hcmtldHBsYWNlIFx1MjAxNCBjaGVjayBpZiBpdCdzIGEgY29udGFpbmVyIG9mXG4gICAgICAvLyBtYXJrZXRwbGFjZXMgKGUuZy4gfi8uY2xhdWRlL3BsdWdpbnMvbWFya2V0cGxhY2VzLyBjb250YWlucyBzdWJkaXJzXG4gICAgICAvLyBsaWtlIGNvbmZsdWVudC8sIGNsYXVkZS1odWQvLCBlYWNoIHdpdGggdGhlaXIgb3duIG1hcmtldHBsYWNlLmpzb24pLlxuICAgICAgbGV0IGZvdW5kQ2hpbGQgPSBmYWxzZTtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGVudHJpZXMgPSByZWFkZGlyU3luYyhyb290LCB7IHdpdGhGaWxlVHlwZXM6IHRydWUgfSk7XG4gICAgICAgIGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xuICAgICAgICAgIGlmICghZW50cnkuaXNEaXJlY3RvcnkoKSkgY29udGludWU7XG4gICAgICAgICAgaWYgKFNLSVBfRElSUy5oYXMoZW50cnkubmFtZSkpIGNvbnRpbnVlO1xuICAgICAgICAgIGNvbnN0IGNoaWxkUGF0aCA9IGpvaW4ocm9vdCwgZW50cnkubmFtZSk7XG4gICAgICAgICAgaWYgKGlzTWFya2V0cGxhY2VQYXRoKGNoaWxkUGF0aCkgJiYgIXNlZW4uaGFzKGNoaWxkUGF0aCkpIHtcbiAgICAgICAgICAgIG1hcmtldHBsYWNlcy5wdXNoKGNoaWxkUGF0aCk7XG4gICAgICAgICAgICBzZWVuLmFkZChjaGlsZFBhdGgpO1xuICAgICAgICAgICAgZm91bmRDaGlsZCA9IHRydWU7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLy8gQ2FuJ3QgcmVhZCBkaXJlY3RvcnkgXHUyMDE0IGZhbGwgdGhyb3VnaCB0byBmbGF0XG4gICAgICB9XG4gICAgICBpZiAoIWZvdW5kQ2hpbGQpIHtcbiAgICAgICAgZmxhdC5wdXNoKHJvb3QpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiB7IG1hcmtldHBsYWNlcywgZmxhdCB9O1xufVxuXG5mdW5jdGlvbiB3YWxrRGlycyhyb290OiBzdHJpbmcsIHZpc2l0OiAoZGlyOiBzdHJpbmcsIGRlcHRoOiBudW1iZXIpID0+IHZvaWQsIG1heERlcHRoID0gNCk6IHZvaWQge1xuICBmdW5jdGlvbiB3YWxrKGRpcjogc3RyaW5nLCBkZXB0aDogbnVtYmVyKSB7XG4gICAgdmlzaXQoZGlyLCBkZXB0aCk7XG4gICAgaWYgKGRlcHRoID49IG1heERlcHRoKSByZXR1cm47XG4gICAgbGV0IGVudHJpZXM6IEFycmF5PHsgbmFtZTogc3RyaW5nOyBpc0RpcmVjdG9yeTogKCkgPT4gYm9vbGVhbiB9PiA9IFtdO1xuICAgIHRyeSB7XG4gICAgICBlbnRyaWVzID0gcmVhZGRpclN5bmMoZGlyLCB7IHdpdGhGaWxlVHlwZXM6IHRydWUgfSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xuICAgICAgaWYgKCFlbnRyeS5pc0RpcmVjdG9yeSgpKSBjb250aW51ZTtcbiAgICAgIGlmIChTS0lQX0RJUlMuaGFzKGVudHJ5Lm5hbWUpKSBjb250aW51ZTtcbiAgICAgIHdhbGsoam9pbihkaXIsIGVudHJ5Lm5hbWUpLCBkZXB0aCArIDEpO1xuICAgIH1cbiAgfVxuICB3YWxrKHJvb3QsIDApO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZGlzY292ZXJDbGF1ZGVTa2lsbHMoY3dkOiBzdHJpbmcpOiBDbGF1ZGVTa2lsbENhbmRpZGF0ZVtdIHtcbiAgY29uc3QgeyBza2lsbFJvb3RzIH0gPSBnZXRDbGF1ZGVTZWFyY2hSb290cyhjd2QpO1xuICBjb25zdCByZXN1bHRzOiBDbGF1ZGVTa2lsbENhbmRpZGF0ZVtdID0gW107XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcblxuICBmb3IgKGNvbnN0IHJvb3Qgb2Ygc2tpbGxSb290cykge1xuICAgIHdhbGtEaXJzKHJvb3QsIChkaXIpID0+IHtcbiAgICAgIGNvbnN0IHNraWxsRmlsZSA9IGpvaW4oZGlyLCBcIlNLSUxMLm1kXCIpO1xuICAgICAgaWYgKCFleGlzdHNTeW5jKHNraWxsRmlsZSkpIHJldHVybjtcbiAgICAgIGNvbnN0IHJlc29sdmVkRGlyID0gcmVzb2x2ZShkaXIpO1xuICAgICAgaWYgKHNlZW4uaGFzKHJlc29sdmVkRGlyKSkgcmV0dXJuO1xuICAgICAgc2Vlbi5hZGQocmVzb2x2ZWREaXIpO1xuICAgICAgcmVzdWx0cy5wdXNoKHtcbiAgICAgICAgdHlwZTogXCJza2lsbFwiLFxuICAgICAgICBuYW1lOiBiYXNlbmFtZShkaXIpLFxuICAgICAgICBwYXRoOiByZXNvbHZlZERpcixcbiAgICAgICAgcm9vdCxcbiAgICAgICAgc291cmNlTGFiZWw6IHNvdXJjZUxhYmVsKHJvb3QpLFxuICAgICAgfSk7XG4gICAgfSwgNSk7XG4gIH1cblxuICByZXR1cm4gcmVzdWx0cy5zb3J0KChhLCBiKSA9PiBhLm5hbWUubG9jYWxlQ29tcGFyZShiLm5hbWUpIHx8IGEucGF0aC5sb2NhbGVDb21wYXJlKGIucGF0aCkpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZGlzY292ZXJDbGF1ZGVQbHVnaW5zKGN3ZDogc3RyaW5nKTogQ2xhdWRlUGx1Z2luQ2FuZGlkYXRlW10ge1xuICBjb25zdCB7IHBsdWdpblJvb3RzIH0gPSBnZXRDbGF1ZGVTZWFyY2hSb290cyhjd2QpO1xuICBjb25zdCByZXN1bHRzOiBDbGF1ZGVQbHVnaW5DYW5kaWRhdGVbXSA9IFtdO1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cbiAgZm9yIChjb25zdCByb290IG9mIHBsdWdpblJvb3RzKSB7XG4gICAgd2Fsa0RpcnMocm9vdCwgKGRpcikgPT4ge1xuICAgICAgLy8gUmVjb2duaXplIGJvdGggbnBtLXN0eWxlIHBsdWdpbnMgKHBhY2thZ2UuanNvbikgYW5kIENsYXVkZSBDb2RlIHBsdWdpbnNcbiAgICAgIC8vICguY2xhdWRlLXBsdWdpbi9wbHVnaW4uanNvbikuIENsYXVkZSBtYXJrZXRwbGFjZS1pbnN0YWxsZWQgcGx1Z2lucyB1c2VcbiAgICAgIC8vIHRoZSBsYXR0ZXIgZm9ybWF0IGV4Y2x1c2l2ZWx5LlxuICAgICAgY29uc3QgcGtnUGF0aCA9IGpvaW4oZGlyLCBcInBhY2thZ2UuanNvblwiKTtcbiAgICAgIGNvbnN0IGNsYXVkZVBsdWdpblBhdGggPSBqb2luKGRpciwgXCIuY2xhdWRlLXBsdWdpblwiLCBcInBsdWdpbi5qc29uXCIpO1xuICAgICAgY29uc3QgaGFzUGtnID0gZXhpc3RzU3luYyhwa2dQYXRoKTtcbiAgICAgIGNvbnN0IGhhc0NsYXVkZVBsdWdpbiA9IGV4aXN0c1N5bmMoY2xhdWRlUGx1Z2luUGF0aCk7XG4gICAgICBpZiAoIWhhc1BrZyAmJiAhaGFzQ2xhdWRlUGx1Z2luKSByZXR1cm47XG5cbiAgICAgIGNvbnN0IHJlc29sdmVkRGlyID0gcmVzb2x2ZShkaXIpO1xuICAgICAgaWYgKHNlZW4uaGFzKHJlc29sdmVkRGlyKSkgcmV0dXJuO1xuICAgICAgc2Vlbi5hZGQocmVzb2x2ZWREaXIpO1xuXG4gICAgICBsZXQgcGFja2FnZU5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICAgIGlmIChoYXNQa2cpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBwa2cgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhwa2dQYXRoLCBcInV0ZjhcIikpIGFzIHsgbmFtZT86IHN0cmluZyB9O1xuICAgICAgICAgIHBhY2thZ2VOYW1lID0gcGtnLm5hbWU7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIHBhY2thZ2VOYW1lID0gdW5kZWZpbmVkO1xuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKGhhc0NsYXVkZVBsdWdpbikge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IG1hbmlmZXN0ID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoY2xhdWRlUGx1Z2luUGF0aCwgXCJ1dGY4XCIpKSBhcyB7IG5hbWU/OiBzdHJpbmcgfTtcbiAgICAgICAgICBwYWNrYWdlTmFtZSA9IG1hbmlmZXN0Lm5hbWU7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIHBhY2thZ2VOYW1lID0gdW5kZWZpbmVkO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIHJlc3VsdHMucHVzaCh7XG4gICAgICAgIHR5cGU6IFwicGx1Z2luXCIsXG4gICAgICAgIG5hbWU6IHBhY2thZ2VOYW1lIHx8IGJhc2VuYW1lKGRpciksXG4gICAgICAgIHBhY2thZ2VOYW1lLFxuICAgICAgICBwYXRoOiByZXNvbHZlZERpcixcbiAgICAgICAgcm9vdCxcbiAgICAgICAgc291cmNlTGFiZWw6IHNvdXJjZUxhYmVsKHJvb3QpLFxuICAgICAgfSk7XG4gICAgfSwgNCk7XG4gIH1cblxuICByZXR1cm4gcmVzdWx0cy5zb3J0KChhLCBiKSA9PiBhLm5hbWUubG9jYWxlQ29tcGFyZShiLm5hbWUpIHx8IGEucGF0aC5sb2NhbGVDb21wYXJlKGIucGF0aCkpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjaG9vc2VNYW55PFQgZXh0ZW5kcyB7IG5hbWU6IHN0cmluZzsgcGF0aDogc3RyaW5nOyByb290OiBzdHJpbmc7IHNvdXJjZUxhYmVsOiBzdHJpbmcgfT4oXG4gIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsXG4gIHRpdGxlOiBzdHJpbmcsXG4gIGNhbmRpZGF0ZXM6IFRbXSxcbik6IFByb21pc2U8VFtdPiB7XG4gIGlmIChjYW5kaWRhdGVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIFtdO1xuXG4gIGNvbnN0IG1vZGUgPSBhd2FpdCBjdHgudWkuc2VsZWN0KGAke3RpdGxlfSAoJHtjYW5kaWRhdGVzLmxlbmd0aH0gZm91bmQpYCwgW1xuICAgIFwiSW1wb3J0IGFsbCBkaXNjb3ZlcmVkXCIsXG4gICAgXCJTZWxlY3QgaW5kaXZpZHVhbGx5XCIsXG4gICAgXCJDYW5jZWxcIixcbiAgXSk7XG5cbiAgaWYgKCFtb2RlIHx8IG1vZGUgPT09IFwiQ2FuY2VsXCIpIHJldHVybiBbXTtcbiAgaWYgKG1vZGUgPT09IFwiSW1wb3J0IGFsbCBkaXNjb3ZlcmVkXCIpIHJldHVybiBjYW5kaWRhdGVzO1xuXG4gIGNvbnN0IHJlbWFpbmluZyA9IFsuLi5jYW5kaWRhdGVzXTtcbiAgY29uc3Qgc2VsZWN0ZWQ6IFRbXSA9IFtdO1xuICB3aGlsZSAocmVtYWluaW5nLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCBvcHRpb25zID0gW1xuICAgICAgLi4ucmVtYWluaW5nLm1hcCgoaXRlbSkgPT4gYCR7aXRlbS5uYW1lfSBcdTIwMTQgJHtpdGVtLnNvdXJjZUxhYmVsfSBcdTIwMTQgJHtyZWxhdGl2ZShpdGVtLnJvb3QsIGl0ZW0ucGF0aCkgfHwgXCIuXCJ9YCksXG4gICAgICBcIkRvbmUgc2VsZWN0aW5nXCIsXG4gICAgXTtcbiAgICBjb25zdCBwaWNrZWQgPSBhd2FpdCBjdHgudWkuc2VsZWN0KGAke3RpdGxlfTogY2hvb3NlIGFuIGl0ZW1gLCBvcHRpb25zKTtcbiAgICBpZiAoIXBpY2tlZCB8fCBwaWNrZWQgPT09IFwiRG9uZSBzZWxlY3RpbmdcIikgYnJlYWs7XG4gICAgY29uc3QgcGlja2VkU3RyID0gQXJyYXkuaXNBcnJheShwaWNrZWQpID8gcGlja2VkWzBdIDogcGlja2VkO1xuICAgIGlmICghcGlja2VkU3RyKSBicmVhaztcbiAgICBjb25zdCBpZHggPSBvcHRpb25zLmluZGV4T2YocGlja2VkU3RyKTtcbiAgICBpZiAoaWR4IDwgMCB8fCBpZHggPj0gcmVtYWluaW5nLmxlbmd0aCkgYnJlYWs7XG4gICAgc2VsZWN0ZWQucHVzaChyZW1haW5pbmdbaWR4XSEpO1xuICAgIHJlbWFpbmluZy5zcGxpY2UoaWR4LCAxKTtcbiAgfVxuICByZXR1cm4gc2VsZWN0ZWQ7XG59XG5cbmZ1bmN0aW9uIG1lcmdlU3RyaW5nTGlzdChleGlzdGluZzogdW5rbm93biwgYWRkaXRpb25zOiBzdHJpbmdbXSk6IHN0cmluZ1tdIHtcbiAgY29uc3QgbGlzdCA9IEFycmF5LmlzQXJyYXkoZXhpc3RpbmcpID8gZXhpc3RpbmcuZmlsdGVyKCh2KTogdiBpcyBzdHJpbmcgPT4gdHlwZW9mIHYgPT09IFwic3RyaW5nXCIpIDogW107XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0KGxpc3QpO1xuICBmb3IgKGNvbnN0IGl0ZW0gb2YgYWRkaXRpb25zKSB7XG4gICAgaWYgKCFzZWVuLmhhcyhpdGVtKSkge1xuICAgICAgbGlzdC5wdXNoKGl0ZW0pO1xuICAgICAgc2Vlbi5hZGQoaXRlbSk7XG4gICAgfVxuICB9XG4gIHJldHVybiBsaXN0O1xufVxuXG5mdW5jdGlvbiBtZXJnZVBhY2thZ2VTb3VyY2VzKGV4aXN0aW5nOiB1bmtub3duLCBhZGRpdGlvbnM6IHN0cmluZ1tdKTogQXJyYXk8c3RyaW5nIHwgeyBzb3VyY2U6IHN0cmluZyB9PiB7XG4gIGNvbnN0IGN1cnJlbnQgPSBBcnJheS5pc0FycmF5KGV4aXN0aW5nKVxuICAgID8gZXhpc3RpbmcuZmlsdGVyKCh2KTogdiBpcyBzdHJpbmcgfCB7IHNvdXJjZTogc3RyaW5nIH0gPT4gdHlwZW9mIHYgPT09IFwic3RyaW5nXCIgfHwgKHR5cGVvZiB2ID09PSBcIm9iamVjdFwiICYmIHYgIT09IG51bGwgJiYgdHlwZW9mICh2IGFzIHsgc291cmNlPzogdW5rbm93biB9KS5zb3VyY2UgPT09IFwic3RyaW5nXCIpKVxuICAgIDogW107XG5cbiAgY29uc3Qgc2VlbiA9IG5ldyBTZXQoY3VycmVudC5tYXAoKGVudHJ5KSA9PiB0eXBlb2YgZW50cnkgPT09IFwic3RyaW5nXCIgPyBlbnRyeSA6IGVudHJ5LnNvdXJjZSkpO1xuICBjb25zdCBtZXJnZWQgPSBbLi4uY3VycmVudF07XG4gIGZvciAoY29uc3QgYWRkIG9mIGFkZGl0aW9ucykge1xuICAgIGlmICghc2Vlbi5oYXMoYWRkKSkge1xuICAgICAgbWVyZ2VkLnB1c2goYWRkKTtcbiAgICAgIHNlZW4uYWRkKGFkZCk7XG4gICAgfVxuICB9XG4gIHJldHVybiBtZXJnZWQ7XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIE1hcmtldHBsYWNlIFBsdWdpbkltcG9ydGVyIEludGVncmF0aW9uIChUMDIpXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICogQ29tcG9uZW50IGNhbmRpZGF0ZSBmcm9tIG1hcmtldHBsYWNlIGRpc2NvdmVyeS5cbiAqIEV4dGVuZHMgTmFtZXNwYWNlZENvbXBvbmVudCB3aXRoIFVJLWZyaWVuZGx5IGZpZWxkcy5cbiAqL1xuaW50ZXJmYWNlIE1hcmtldHBsYWNlQ29tcG9uZW50Q2FuZGlkYXRlIHtcbiAgY29tcG9uZW50OiBOYW1lc3BhY2VkQ29tcG9uZW50O1xuICBkaXNwbGF5TmFtZTogc3RyaW5nO1xuICBwbHVnaW5OYW1lOiBzdHJpbmc7XG59XG5cbi8qKlxuICogRm9ybWF0IGEgY29tcG9uZW50IGZvciBkaXNwbGF5IGluIHNlbGVjdGlvbiBVSS5cbiAqL1xuZnVuY3Rpb24gZm9ybWF0Q29tcG9uZW50Rm9yU2VsZWN0aW9uKGNvbXA6IE5hbWVzcGFjZWRDb21wb25lbnQpOiBzdHJpbmcge1xuICBjb25zdCB0eXBlTGFiZWwgPSBjb21wLnR5cGUgPT09ICdza2lsbCcgPyAnXHVEODNEXHVERDI3JyA6ICdcdUQ4M0VcdUREMTYnO1xuICBjb25zdCBuc0xhYmVsID0gY29tcC5uYW1lc3BhY2UgPyBgJHtjb21wLm5hbWVzcGFjZX06YCA6ICcnO1xuICByZXR1cm4gYCR7dHlwZUxhYmVsfSAke25zTGFiZWx9JHtjb21wLm5hbWV9YDtcbn1cblxuLyoqXG4gKiBQcmVzZW50IG1hcmtldHBsYWNlIGNvbXBvbmVudHMgZm9yIHVzZXIgc2VsZWN0aW9uLCBncm91cGVkIGJ5IHBsdWdpbi5cbiAqIFJldHVybnMgdGhlIHNlbGVjdGVkIGNvbXBvbmVudHMgZm9yIGltcG9ydC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gc2VsZWN0TWFya2V0cGxhY2VDb21wb25lbnRzKFxuICBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LFxuICBpbXBvcnRlcjogUGx1Z2luSW1wb3J0ZXIsXG4gIHNjb3BlOiBcImdsb2JhbFwiIHwgXCJwcm9qZWN0XCJcbik6IFByb21pc2U8TmFtZXNwYWNlZENvbXBvbmVudFtdPiB7XG4gIGNvbnN0IHBsdWdpbnMgPSBpbXBvcnRlci5nZXREaXNjb3ZlcmVkUGx1Z2lucygpO1xuXG4gIGlmIChwbHVnaW5zLmxlbmd0aCA9PT0gMCkge1xuICAgIGN0eC51aS5ub3RpZnkoXCJObyBwbHVnaW5zIGRpc2NvdmVyZWQgaW4gbWFya2V0cGxhY2UuXCIsIFwiaW5mb1wiKTtcbiAgICByZXR1cm4gW107XG4gIH1cblxuICAvLyBCdWlsZCBjb21wb25lbnQgY2FuZGlkYXRlcyBncm91cGVkIGJ5IHBsdWdpblxuICBjb25zdCBhbGxDb21wb25lbnRzOiBNYXJrZXRwbGFjZUNvbXBvbmVudENhbmRpZGF0ZVtdID0gW107XG4gIGZvciAoY29uc3QgcGx1Z2luIG9mIHBsdWdpbnMpIHtcbiAgICBjb25zdCBjb21wb25lbnRzID0gaW1wb3J0ZXIuc2VsZWN0Q29tcG9uZW50cyhjID0+IGMubmFtZXNwYWNlID09PSBwbHVnaW4uY2Fub25pY2FsTmFtZSk7XG4gICAgZm9yIChjb25zdCBjb21wIG9mIGNvbXBvbmVudHMpIHtcbiAgICAgIGFsbENvbXBvbmVudHMucHVzaCh7XG4gICAgICAgIGNvbXBvbmVudDogY29tcCxcbiAgICAgICAgZGlzcGxheU5hbWU6IGZvcm1hdENvbXBvbmVudEZvclNlbGVjdGlvbihjb21wKSxcbiAgICAgICAgcGx1Z2luTmFtZTogcGx1Z2luLmNhbm9uaWNhbE5hbWUsXG4gICAgICB9KTtcbiAgICB9XG4gIH1cblxuICBpZiAoYWxsQ29tcG9uZW50cy5sZW5ndGggPT09IDApIHtcbiAgICBjdHgudWkubm90aWZ5KFwiTm8gY29tcG9uZW50cyAoc2tpbGxzL2FnZW50cykgZm91bmQgaW4gbWFya2V0cGxhY2UgcGx1Z2lucy5cIiwgXCJpbmZvXCIpO1xuICAgIHJldHVybiBbXTtcbiAgfVxuXG4gIC8vIEFzayB1c2VyIGZvciBzZWxlY3Rpb24gbW9kZVxuICBjb25zdCBtb2RlID0gYXdhaXQgY3R4LnVpLnNlbGVjdChcbiAgICBgTWFya2V0cGxhY2UgY29tcG9uZW50cyBcdTIxOTIgJHtzY29wZX0gY29uZmlnICgke2FsbENvbXBvbmVudHMubGVuZ3RofSBmb3VuZCBhY3Jvc3MgJHtwbHVnaW5zLmxlbmd0aH0gcGx1Z2lucylgLFxuICAgIFtcbiAgICAgIFwiSW1wb3J0IGFsbCBjb21wb25lbnRzXCIsXG4gICAgICBcIlNlbGVjdCBieSBwbHVnaW5cIixcbiAgICAgIFwiU2VsZWN0IGluZGl2aWR1YWxseVwiLFxuICAgICAgXCJDYW5jZWxcIixcbiAgICBdXG4gICk7XG5cbiAgaWYgKCFtb2RlIHx8IG1vZGUgPT09IFwiQ2FuY2VsXCIpIHJldHVybiBbXTtcblxuICBpZiAobW9kZSA9PT0gXCJJbXBvcnQgYWxsIGNvbXBvbmVudHNcIikge1xuICAgIHJldHVybiBhbGxDb21wb25lbnRzLm1hcChjID0+IGMuY29tcG9uZW50KTtcbiAgfVxuXG4gIGlmIChtb2RlID09PSBcIlNlbGVjdCBieSBwbHVnaW5cIikge1xuICAgIC8vIExldCB1c2VyIHNlbGVjdCBwbHVnaW5zLCB0aGVuIGltcG9ydCBhbGwgdGhlaXIgY29tcG9uZW50c1xuICAgIGNvbnN0IHBsdWdpbk5hbWVzID0gcGx1Z2lucy5tYXAocCA9PiBwLmNhbm9uaWNhbE5hbWUpO1xuICAgIGNvbnN0IHNlbGVjdGVkUGx1Z2luTmFtZXM6IHN0cmluZ1tdID0gW107XG5cbiAgICB3aGlsZSAodHJ1ZSkge1xuICAgICAgY29uc3QgcmVtYWluaW5nID0gcGx1Z2luTmFtZXMuZmlsdGVyKG4gPT4gIXNlbGVjdGVkUGx1Z2luTmFtZXMuaW5jbHVkZXMobikpO1xuICAgICAgaWYgKHJlbWFpbmluZy5sZW5ndGggPT09IDApIGJyZWFrO1xuXG4gICAgICBjb25zdCBvcHRpb25zID0gWy4uLnJlbWFpbmluZywgXCJEb25lIHNlbGVjdGluZ1wiXTtcbiAgICAgIGNvbnN0IHBpY2tlZCA9IGF3YWl0IGN0eC51aS5zZWxlY3QoXCJTZWxlY3QgYSBwbHVnaW4gdG8gaW1wb3J0IGFsbCBpdHMgY29tcG9uZW50c1wiLCBvcHRpb25zKTtcblxuICAgICAgaWYgKCFwaWNrZWQgfHwgcGlja2VkID09PSBcIkRvbmUgc2VsZWN0aW5nXCIpIGJyZWFrO1xuICAgICAgY29uc3QgcGlja2VkU3RyID0gQXJyYXkuaXNBcnJheShwaWNrZWQpID8gcGlja2VkWzBdIDogcGlja2VkO1xuICAgICAgaWYgKCFwaWNrZWRTdHIpIGJyZWFrO1xuICAgICAgc2VsZWN0ZWRQbHVnaW5OYW1lcy5wdXNoKHBpY2tlZFN0cik7XG4gICAgfVxuXG4gICAgcmV0dXJuIGFsbENvbXBvbmVudHNcbiAgICAgIC5maWx0ZXIoYyA9PiBzZWxlY3RlZFBsdWdpbk5hbWVzLmluY2x1ZGVzKGMucGx1Z2luTmFtZSkpXG4gICAgICAubWFwKGMgPT4gYy5jb21wb25lbnQpO1xuICB9XG5cbiAgLy8gU2VsZWN0IGluZGl2aWR1YWxseVxuICBjb25zdCByZW1haW5pbmcgPSBbLi4uYWxsQ29tcG9uZW50c107XG4gIGNvbnN0IHNlbGVjdGVkOiBOYW1lc3BhY2VkQ29tcG9uZW50W10gPSBbXTtcblxuICB3aGlsZSAocmVtYWluaW5nLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCBvcHRpb25zID0gcmVtYWluaW5nLm1hcChjID0+XG4gICAgICBgJHtjLmRpc3BsYXlOYW1lfSBcdTIwMTQgJHtjLnBsdWdpbk5hbWV9YFxuICAgICk7XG4gICAgb3B0aW9ucy5wdXNoKFwiRG9uZSBzZWxlY3RpbmdcIik7XG5cbiAgICBjb25zdCBwaWNrZWQgPSBhd2FpdCBjdHgudWkuc2VsZWN0KFwiU2VsZWN0IGEgY29tcG9uZW50IHRvIGltcG9ydFwiLCBvcHRpb25zKTtcbiAgICBpZiAoIXBpY2tlZCB8fCBwaWNrZWQgPT09IFwiRG9uZSBzZWxlY3RpbmdcIikgYnJlYWs7XG4gICAgY29uc3QgcGlja2VkU3RyID0gQXJyYXkuaXNBcnJheShwaWNrZWQpID8gcGlja2VkWzBdIDogcGlja2VkO1xuICAgIGlmICghcGlja2VkU3RyKSBicmVhaztcblxuICAgIGNvbnN0IGlkeCA9IG9wdGlvbnMuaW5kZXhPZihwaWNrZWRTdHIpO1xuICAgIGlmIChpZHggPCAwIHx8IGlkeCA+PSByZW1haW5pbmcubGVuZ3RoKSBicmVhaztcblxuICAgIHNlbGVjdGVkLnB1c2gocmVtYWluaW5nW2lkeF0hLmNvbXBvbmVudCk7XG4gICAgcmVtYWluaW5nLnNwbGljZShpZHgsIDEpO1xuICB9XG5cbiAgcmV0dXJuIHNlbGVjdGVkO1xufVxuXG4vKipcbiAqIEZvcm1hdCBkaWFnbm9zdGljcyBmb3IgZGlzcGxheSB0byB1c2VyLlxuICogUmV0dXJucyBhIGh1bWFuLXJlYWRhYmxlIHN1bW1hcnkgc3RyaW5nLlxuICovXG5mdW5jdGlvbiBmb3JtYXREaWFnbm9zdGljc0ZvclVzZXIoXG4gIGRpYWdub3N0aWNzOiBBcnJheTx7IHNldmVyaXR5OiBzdHJpbmc7IGNsYXNzOiBzdHJpbmc7IHJlbWVkaWF0aW9uOiBzdHJpbmc7IGludm9sdmVkQ2Fub25pY2FsTmFtZXM6IHN0cmluZ1tdIH0+XG4pOiBzdHJpbmcge1xuICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcblxuICBjb25zdCBlcnJvcnMgPSBkaWFnbm9zdGljcy5maWx0ZXIoZCA9PiBkLnNldmVyaXR5ID09PSAnZXJyb3InKTtcbiAgY29uc3Qgd2FybmluZ3MgPSBkaWFnbm9zdGljcy5maWx0ZXIoZCA9PiBkLnNldmVyaXR5ID09PSAnd2FybmluZycpO1xuXG4gIGlmIChlcnJvcnMubGVuZ3RoID4gMCkge1xuICAgIGxpbmVzLnB1c2goYFx1Mjc0QyAke2Vycm9ycy5sZW5ndGh9IGVycm9yKHMpIGJsb2NraW5nIGltcG9ydDpgKTtcbiAgICBmb3IgKGNvbnN0IGVyciBvZiBlcnJvcnMpIHtcbiAgICAgIGxpbmVzLnB1c2goYCAgIC0gJHtlcnIuY2xhc3N9OiAke2Vyci5pbnZvbHZlZENhbm9uaWNhbE5hbWVzLmpvaW4oJywgJyl9YCk7XG4gICAgICBsaW5lcy5wdXNoKGAgICAgICR7ZXJyLnJlbWVkaWF0aW9ufWApO1xuICAgIH1cbiAgfVxuXG4gIGlmICh3YXJuaW5ncy5sZW5ndGggPiAwKSB7XG4gICAgbGluZXMucHVzaChgXHUyNkEwXHVGRTBGICR7d2FybmluZ3MubGVuZ3RofSB3YXJuaW5nKHMpOmApO1xuICAgIGZvciAoY29uc3Qgd2FybiBvZiB3YXJuaW5ncykge1xuICAgICAgbGluZXMucHVzaChgICAgLSAke3dhcm4uY2xhc3N9OiAke3dhcm4uaW52b2x2ZWRDYW5vbmljYWxOYW1lcy5qb2luKCcsICcpfWApO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiBsaW5lcy5qb2luKCdcXG4nKTtcbn1cblxuLyoqXG4gKiBQZXJzaXN0IGltcG9ydCBtYW5pZmVzdCBlbnRyaWVzIHRvIHNldHRpbmdzLlxuICogTWFwcyBtYW5pZmVzdCBlbnRyaWVzIHRvIHRoZSBhcHByb3ByaWF0ZSBzZXR0aW5ncyBmb3JtYXQuXG4gKi9cbmZ1bmN0aW9uIHBlcnNpc3RNYW5pZmVzdFRvU2V0dGluZ3MoXG4gIG1hbmlmZXN0RW50cmllczogSW1wb3J0TWFuaWZlc3RFbnRyeVtdLFxuICBzZXR0aW5nc01hbmFnZXI6IFNldHRpbmdzTWFuYWdlcixcbiAgc2NvcGU6IFwiZ2xvYmFsXCIgfCBcInByb2plY3RcIlxuKTogdm9pZCB7XG4gIC8vIEdyb3VwIGVudHJpZXMgYnkgbmFtZXNwYWNlIGZvciBvcmdhbml6ZWQgcGVyc2lzdGVuY2VcbiAgY29uc3Qgc2tpbGxQYXRocyA9IG1hbmlmZXN0RW50cmllc1xuICAgIC5maWx0ZXIoZSA9PiBlLnR5cGUgPT09ICdza2lsbCcpXG4gICAgLm1hcChlID0+IGUuZmlsZVBhdGgpO1xuXG4gIGNvbnN0IGFnZW50UGF0aHMgPSBtYW5pZmVzdEVudHJpZXNcbiAgICAuZmlsdGVyKGUgPT4gZS50eXBlID09PSAnYWdlbnQnKVxuICAgIC5tYXAoZSA9PiBlLmZpbGVQYXRoKTtcblxuICAvLyBGb3IgbWFya2V0cGxhY2UgcGx1Z2lucywgd2UgYWxzbyB3YW50IHRvIHN0b3JlIHBsdWdpbi1sZXZlbCBtZXRhZGF0YVxuICAvLyBDdXJyZW50bHkgdGhpcyBhZGRzIGNvbXBvbmVudCBwYXRocyB0byBza2lsbHMvYWdlbnRzIGxpc3RzXG4gIC8vIEZ1dHVyZSBlbmhhbmNlbWVudDogc3RvcmUgY2Fub25pY2FsIG5hbWVzIHdpdGggbWV0YWRhdGFcblxuICBpZiAoc2tpbGxQYXRocy5sZW5ndGggPiAwKSB7XG4gICAgaWYgKHNjb3BlID09PSBcInByb2plY3RcIikge1xuICAgICAgc2V0dGluZ3NNYW5hZ2VyLnNldFByb2plY3RTa2lsbFBhdGhzKFxuICAgICAgICBtZXJnZVN0cmluZ0xpc3Qoc2V0dGluZ3NNYW5hZ2VyLmdldFByb2plY3RTZXR0aW5ncygpLnNraWxscywgc2tpbGxQYXRocylcbiAgICAgICk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHNldHRpbmdzTWFuYWdlci5zZXRTa2lsbFBhdGhzKFxuICAgICAgICBtZXJnZVN0cmluZ0xpc3Qoc2V0dGluZ3NNYW5hZ2VyLmdldEdsb2JhbFNldHRpbmdzKCkuc2tpbGxzLCBza2lsbFBhdGhzKVxuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICAvLyBEbyBub3QgcGVyc2lzdCBpbXBvcnRlZCBtYXJrZXRwbGFjZSBhZ2VudHMgaW50byBzZXR0aW5ncy5wYWNrYWdlcy5cbiAgLy8gQ2xhdWRlIHBsdWdpbiBhZ2VudCBkaXJlY3RvcmllcyBjb250YWluIG1hcmtkb3duIGFnZW50IGRlZmluaXRpb25zLCBub3QgbG9hZGFibGUgUGlcbiAgLy8gZXh0ZW5zaW9uIHBhY2thZ2VzLiBXcml0aW5nIGAuLi4vYWdlbnRzYCBwYXRocyBpbnRvIHBhY2thZ2VzIG1ha2VzIHN0YXJ0dXAgdHJlYXRcbiAgLy8gdGhlbSBhcyBleHRlbnNpb24gcm9vdHMgYW5kIHByb2R1Y2VzIG1vZHVsZS1sb2FkIGVycm9ycy5cbiAgLy9cbiAgLy8gRm9yIG5vdywgbWFya2V0cGxhY2UgYWdlbnRzIHJlbWFpbiBkaXNjb3ZlcmFibGUgdmlhIHRoZSBpbXBvcnQgbWFuaWZlc3QgYW5kXG4gIC8vIGNhbm9uaWNhbCBtZXRhZGF0YSwgYnV0IGFyZSBub3QgcGVyc2lzdGVkIGludG8gcGFja2FnZSBzb3VyY2VzLlxufVxuXG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5DbGF1ZGVJbXBvcnRGbG93KFxuICBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LFxuICBzY29wZTogXCJnbG9iYWxcIiB8IFwicHJvamVjdFwiLFxuICByZWFkUHJlZnM6ICgpID0+IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICB3cml0ZVByZWZzOiAocHJlZnM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiBQcm9taXNlPHZvaWQ+LFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGN3ZCA9IHByb2Nlc3MuY3dkKCk7XG4gIGNvbnN0IHNldHRpbmdzTWFuYWdlciA9IFNldHRpbmdzTWFuYWdlci5jcmVhdGUoY3dkLCBnZXRBZ2VudERpcigpKTtcbiAgY29uc3QgeyBza2lsbFJvb3RzLCBwbHVnaW5Sb290cyB9ID0gZ2V0Q2xhdWRlU2VhcmNoUm9vdHMoY3dkKTtcblxuICAvLyBDYXRlZ29yaXplIHBsdWdpbiByb290cyBpbnRvIG1hcmtldHBsYWNlcyB2cyBmbGF0IHBhdGhzXG4gIGNvbnN0IHsgbWFya2V0cGxhY2VzLCBmbGF0IH0gPSBjYXRlZ29yaXplUGx1Z2luUm9vdHMocGx1Z2luUm9vdHMpO1xuXG4gIC8vIERldGVybWluZSBpbXBvcnQgbW9kZVxuICBjb25zdCBhc3NldENob2ljZSA9IGF3YWl0IGN0eC51aS5zZWxlY3QoXCJJbXBvcnQgQ2xhdWRlIGFzc2V0cyBpbnRvIEdTRC9QaSBjb25maWdcIiwgW1xuICAgIFwiU2tpbGxzICsgcGx1Z2luc1wiLFxuICAgIFwiU2tpbGxzIG9ubHlcIixcbiAgICBcIlBsdWdpbnMgb25seVwiLFxuICAgIFwiQ2FuY2VsXCIsXG4gIF0pO1xuICBpZiAoIWFzc2V0Q2hvaWNlIHx8IGFzc2V0Q2hvaWNlID09PSBcIkNhbmNlbFwiKSByZXR1cm47XG5cbiAgY29uc3QgaW1wb3J0U2tpbGxzID0gYXNzZXRDaG9pY2UgIT09IFwiUGx1Z2lucyBvbmx5XCI7XG4gIGNvbnN0IGltcG9ydFBsdWdpbnMgPSBhc3NldENob2ljZSAhPT0gXCJTa2lsbHMgb25seVwiO1xuXG4gIC8vIFRyYWNrIHdoYXQgd2UncmUgaW1wb3J0aW5nXG4gIGxldCBpbXBvcnRlZFNraWxsc0NvdW50ID0gMDtcbiAgbGV0IGltcG9ydGVkUGx1Z2luc0NvdW50ID0gMDtcbiAgbGV0IGltcG9ydGVkTWFya2V0cGxhY2VDb21wb25lbnRzID0gMDtcbiAgY29uc3QgY2Fub25pY2FsTmFtZXNQZXJzaXN0ZWQ6IHN0cmluZ1tdID0gW107XG5cbiAgLy8gPT09PT09PT09PSBTS0lMTFMgKGxlZ2FjeSBmbGF0IGZsb3cpID09PT09PT09PT1cbiAgaWYgKGltcG9ydFNraWxscykge1xuICAgIGNvbnN0IGRpc2NvdmVyZWRTa2lsbHMgPSBkaXNjb3ZlckNsYXVkZVNraWxscyhjd2QpO1xuICAgIGNvbnN0IHNlbGVjdGVkU2tpbGxzID0gYXdhaXQgY2hvb3NlTWFueShjdHgsIGBDbGF1ZGUgc2tpbGxzIFx1MjE5MiAke3Njb3BlfSBwcmVmZXJlbmNlc2AsIGRpc2NvdmVyZWRTa2lsbHMpO1xuXG4gICAgaWYgKHNlbGVjdGVkU2tpbGxzLmxlbmd0aCA+IDApIHtcbiAgICAgIGNvbnN0IHByZWZNb2RlID0gYXdhaXQgY3R4LnVpLnNlbGVjdChcIkhvdyBzaG91bGQgR1NEIHRyZWF0IHRoZSBpbXBvcnRlZCBza2lsbHM/XCIsIFtcbiAgICAgICAgXCJBbHdheXMgdXNlIHdoZW4gcmVsZXZhbnRcIixcbiAgICAgICAgXCJQcmVmZXIgd2hlbiByZWxldmFudFwiLFxuICAgICAgICBcIkRvIG5vdCBtb2RpZnkgc2tpbGwgcHJlZmVyZW5jZXNcIixcbiAgICAgIF0pO1xuXG4gICAgICBjb25zdCBwcmVmcyA9IHJlYWRQcmVmcygpO1xuICAgICAgY29uc3Qgc2tpbGxQYXRocyA9IHNlbGVjdGVkU2tpbGxzLm1hcCgoc2tpbGwpID0+IHNraWxsLnBhdGgpO1xuICAgICAgaWYgKHByZWZNb2RlID09PSBcIkFsd2F5cyB1c2Ugd2hlbiByZWxldmFudFwiKSB7XG4gICAgICAgIHByZWZzLmFsd2F5c191c2Vfc2tpbGxzID0gbWVyZ2VTdHJpbmdMaXN0KHByZWZzLmFsd2F5c191c2Vfc2tpbGxzLCBza2lsbFBhdGhzKTtcbiAgICAgIH0gZWxzZSBpZiAocHJlZk1vZGUgPT09IFwiUHJlZmVyIHdoZW4gcmVsZXZhbnRcIikge1xuICAgICAgICBwcmVmcy5wcmVmZXJfc2tpbGxzID0gbWVyZ2VTdHJpbmdMaXN0KHByZWZzLnByZWZlcl9za2lsbHMsIHNraWxsUGF0aHMpO1xuICAgICAgfVxuXG4gICAgICBhd2FpdCB3cml0ZVByZWZzKHByZWZzKTtcblxuICAgICAgaWYgKHNjb3BlID09PSBcInByb2plY3RcIikge1xuICAgICAgICBzZXR0aW5nc01hbmFnZXIuc2V0UHJvamVjdFNraWxsUGF0aHMobWVyZ2VTdHJpbmdMaXN0KHNldHRpbmdzTWFuYWdlci5nZXRQcm9qZWN0U2V0dGluZ3MoKS5za2lsbHMsIHNraWxsUGF0aHMpKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHNldHRpbmdzTWFuYWdlci5zZXRTa2lsbFBhdGhzKG1lcmdlU3RyaW5nTGlzdChzZXR0aW5nc01hbmFnZXIuZ2V0R2xvYmFsU2V0dGluZ3MoKS5za2lsbHMsIHNraWxsUGF0aHMpKTtcbiAgICAgIH1cblxuICAgICAgaW1wb3J0ZWRTa2lsbHNDb3VudCA9IHNlbGVjdGVkU2tpbGxzLmxlbmd0aDtcbiAgICB9XG4gIH1cblxuICAvLyA9PT09PT09PT09IE1BUktFVFBMQUNFIFBMVUdJTlMgKG5ldyBQbHVnaW5JbXBvcnRlciBmbG93KSA9PT09PT09PT09XG4gIGlmIChpbXBvcnRQbHVnaW5zICYmIG1hcmtldHBsYWNlcy5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgbWFya2V0cGxhY2VDaG9pY2UgPSBhd2FpdCBjdHgudWkuc2VsZWN0KFxuICAgICAgYEZvdW5kICR7bWFya2V0cGxhY2VzLmxlbmd0aH0gbWFya2V0cGxhY2UocykuIEltcG9ydCBmcm9tIG1hcmtldHBsYWNlP2AsXG4gICAgICBbXG4gICAgICAgIFwiWWVzIC0gZGlzY292ZXIgcGx1Z2lucyBhbmQgc2VsZWN0IGNvbXBvbmVudHNcIixcbiAgICAgICAgXCJTa2lwIG1hcmtldHBsYWNlcyAodXNlIGxlZ2FjeSBwbHVnaW4gcGF0aHMgb25seSlcIixcbiAgICAgICAgXCJDYW5jZWxcIixcbiAgICAgIF1cbiAgICApO1xuXG4gICAgaWYgKG1hcmtldHBsYWNlQ2hvaWNlID09PSBcIlllcyAtIGRpc2NvdmVyIHBsdWdpbnMgYW5kIHNlbGVjdCBjb21wb25lbnRzXCIpIHtcbiAgICAgIC8vIEluc3RhbnRpYXRlIFBsdWdpbkltcG9ydGVyIGFuZCBkaXNjb3ZlclxuICAgICAgY29uc3QgaW1wb3J0ZXIgPSBuZXcgUGx1Z2luSW1wb3J0ZXIoKTtcbiAgICAgIGNvbnN0IGRpc2NvdmVyeSA9IGltcG9ydGVyLmRpc2NvdmVyKG1hcmtldHBsYWNlcyk7XG5cbiAgICAgIGlmIChkaXNjb3Zlcnkuc3VtbWFyeS50b3RhbFBsdWdpbnMgPiAwKSB7XG4gICAgICAgIC8vIFByZXNlbnQgY29tcG9uZW50cyBmb3Igc2VsZWN0aW9uXG4gICAgICAgIGNvbnN0IHNlbGVjdGVkQ29tcG9uZW50cyA9IGF3YWl0IHNlbGVjdE1hcmtldHBsYWNlQ29tcG9uZW50cyhjdHgsIGltcG9ydGVyLCBzY29wZSk7XG5cbiAgICAgICAgaWYgKHNlbGVjdGVkQ29tcG9uZW50cy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgLy8gUnVuIHZhbGlkYXRpb24gKHByZS1pbXBvcnQgZGlhZ25vc3RpY3MpXG4gICAgICAgICAgY29uc3QgdmFsaWRhdGlvbiA9IGltcG9ydGVyLnZhbGlkYXRlSW1wb3J0KHNlbGVjdGVkQ29tcG9uZW50cyk7XG5cbiAgICAgICAgICAvLyBTaG93IGRpYWdub3N0aWNzXG4gICAgICAgICAgaWYgKHZhbGlkYXRpb24uZGlhZ25vc3RpY3MubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgY29uc3QgZGlhZ01lc3NhZ2UgPSBmb3JtYXREaWFnbm9zdGljc0ZvclVzZXIodmFsaWRhdGlvbi5kaWFnbm9zdGljcyk7XG4gICAgICAgICAgICBjdHgudWkubm90aWZ5KGRpYWdNZXNzYWdlLCB2YWxpZGF0aW9uLmNhblByb2NlZWQgPyBcIndhcm5pbmdcIiA6IFwiZXJyb3JcIik7XG5cbiAgICAgICAgICAgIC8vIEJsb2NrIGlmIGVycm9ycyBleGlzdFxuICAgICAgICAgICAgaWYgKCF2YWxpZGF0aW9uLmNhblByb2NlZWQpIHtcbiAgICAgICAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICAgICAgICBcIkltcG9ydCBibG9ja2VkIGR1ZSB0byBjYW5vbmljYWwgbmFtZSBjb25mbGljdHMuIFBsZWFzZSByZXNvbHZlIHRoZSBlcnJvcnMgYWJvdmUuXCIsXG4gICAgICAgICAgICAgICAgXCJlcnJvclwiXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8gV2FybiBidXQgYWxsb3cgcHJvY2VlZCBmb3Igd2FybmluZ3NcbiAgICAgICAgICAgIGNvbnN0IHByb2NlZWQgPSBhd2FpdCBjdHgudWkuc2VsZWN0KFxuICAgICAgICAgICAgICBcIldhcm5pbmdzIGRldGVjdGVkLiBDb250aW51ZSB3aXRoIGltcG9ydD9cIixcbiAgICAgICAgICAgICAgW1wiWWVzLCBjb250aW51ZVwiLCBcIkNhbmNlbFwiXVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIGlmIChwcm9jZWVkICE9PSBcIlllcywgY29udGludWVcIikge1xuICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gR2VuZXJhdGUgbWFuaWZlc3QgYW5kIHBlcnNpc3RcbiAgICAgICAgICBjb25zdCBtYW5pZmVzdCA9IGltcG9ydGVyLmdldEltcG9ydE1hbmlmZXN0KHNlbGVjdGVkQ29tcG9uZW50cyk7XG4gICAgICAgICAgcGVyc2lzdE1hbmlmZXN0VG9TZXR0aW5ncyhtYW5pZmVzdC5lbnRyaWVzLCBzZXR0aW5nc01hbmFnZXIsIHNjb3BlKTtcblxuICAgICAgICAgIGltcG9ydGVkTWFya2V0cGxhY2VDb21wb25lbnRzID0gc2VsZWN0ZWRDb21wb25lbnRzLmxlbmd0aDtcbiAgICAgICAgICBjYW5vbmljYWxOYW1lc1BlcnNpc3RlZC5wdXNoKC4uLm1hbmlmZXN0LmVudHJpZXMubWFwKGUgPT4gZS5jYW5vbmljYWxOYW1lKSk7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGN0eC51aS5ub3RpZnkoYE5vIHBsdWdpbnMgZGlzY292ZXJlZCBpbiAke21hcmtldHBsYWNlcy5sZW5ndGh9IG1hcmtldHBsYWNlKHMpLmAsIFwiaW5mb1wiKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyA9PT09PT09PT09IEZMQVQgUExVR0lOIFBBVEhTIChsZWdhY3kgZmxvdykgPT09PT09PT09PVxuICBpZiAoaW1wb3J0UGx1Z2lucyAmJiBmbGF0Lmxlbmd0aCA+IDApIHtcbiAgICAvLyBVc2UgbGVnYWN5IGRpc2NvdmVyeSBmb3Igbm9uLW1hcmtldHBsYWNlIHBhdGhzXG4gICAgY29uc3QgZGlzY292ZXJlZFBsdWdpbnM6IENsYXVkZVBsdWdpbkNhbmRpZGF0ZVtdID0gW107XG4gICAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4gICAgZm9yIChjb25zdCByb290IG9mIGZsYXQpIHtcbiAgICAgIHdhbGtEaXJzKHJvb3QsIChkaXIpID0+IHtcbiAgICAgICAgY29uc3QgcGtnUGF0aCA9IGpvaW4oZGlyLCBcInBhY2thZ2UuanNvblwiKTtcbiAgICAgICAgaWYgKCFleGlzdHNTeW5jKHBrZ1BhdGgpKSByZXR1cm47XG4gICAgICAgIGNvbnN0IHJlc29sdmVkRGlyID0gcmVzb2x2ZShkaXIpO1xuICAgICAgICBpZiAoc2Vlbi5oYXMocmVzb2x2ZWREaXIpKSByZXR1cm47XG4gICAgICAgIHNlZW4uYWRkKHJlc29sdmVkRGlyKTtcbiAgICAgICAgbGV0IHBhY2thZ2VOYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgcGtnID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocGtnUGF0aCwgXCJ1dGY4XCIpKSBhcyB7IG5hbWU/OiBzdHJpbmcgfTtcbiAgICAgICAgICBwYWNrYWdlTmFtZSA9IHBrZy5uYW1lO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICBwYWNrYWdlTmFtZSA9IHVuZGVmaW5lZDtcbiAgICAgICAgfVxuICAgICAgICBkaXNjb3ZlcmVkUGx1Z2lucy5wdXNoKHtcbiAgICAgICAgICB0eXBlOiBcInBsdWdpblwiLFxuICAgICAgICAgIG5hbWU6IHBhY2thZ2VOYW1lIHx8IGJhc2VuYW1lKGRpciksXG4gICAgICAgICAgcGFja2FnZU5hbWUsXG4gICAgICAgICAgcGF0aDogcmVzb2x2ZWREaXIsXG4gICAgICAgICAgcm9vdCxcbiAgICAgICAgICBzb3VyY2VMYWJlbDogc291cmNlTGFiZWwocm9vdCksXG4gICAgICAgIH0pO1xuICAgICAgfSwgNCk7XG4gICAgfVxuXG4gICAgY29uc3Qgc29ydGVkUGx1Z2lucyA9IGRpc2NvdmVyZWRQbHVnaW5zLnNvcnQoKGEsIGIpID0+IGEubmFtZS5sb2NhbGVDb21wYXJlKGIubmFtZSkgfHwgYS5wYXRoLmxvY2FsZUNvbXBhcmUoYi5wYXRoKSk7XG4gICAgY29uc3Qgc2VsZWN0ZWRQbHVnaW5zID0gYXdhaXQgY2hvb3NlTWFueShjdHgsIGBDbGF1ZGUgcGx1Z2lucy9wYWNrYWdlcyBcdTIxOTIgJHtzY29wZX0gUGkgc2V0dGluZ3NgLCBzb3J0ZWRQbHVnaW5zKTtcblxuICAgIGlmIChzZWxlY3RlZFBsdWdpbnMubGVuZ3RoID4gMCkge1xuICAgICAgY29uc3QgcGx1Z2luUGF0aHMgPSBzZWxlY3RlZFBsdWdpbnMubWFwKChwbHVnaW4pID0+IHBsdWdpbi5wYXRoKTtcbiAgICAgIGlmIChzY29wZSA9PT0gXCJwcm9qZWN0XCIpIHtcbiAgICAgICAgc2V0dGluZ3NNYW5hZ2VyLnNldFByb2plY3RQYWNrYWdlcyhtZXJnZVBhY2thZ2VTb3VyY2VzKHNldHRpbmdzTWFuYWdlci5nZXRQcm9qZWN0U2V0dGluZ3MoKS5wYWNrYWdlcywgcGx1Z2luUGF0aHMpKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHNldHRpbmdzTWFuYWdlci5zZXRQYWNrYWdlcyhtZXJnZVBhY2thZ2VTb3VyY2VzKHNldHRpbmdzTWFuYWdlci5nZXRHbG9iYWxTZXR0aW5ncygpLnBhY2thZ2VzLCBwbHVnaW5QYXRocykpO1xuICAgICAgfVxuICAgICAgaW1wb3J0ZWRQbHVnaW5zQ291bnQgPSBzZWxlY3RlZFBsdWdpbnMubGVuZ3RoO1xuICAgIH1cbiAgfVxuXG4gIC8vID09PT09PT09PT0gRklOQUwgU1VNTUFSWSA9PT09PT09PT09XG4gIGlmIChpbXBvcnRlZFNraWxsc0NvdW50ID09PSAwICYmIGltcG9ydGVkUGx1Z2luc0NvdW50ID09PSAwICYmIGltcG9ydGVkTWFya2V0cGxhY2VDb21wb25lbnRzID09PSAwKSB7XG4gICAgY3R4LnVpLm5vdGlmeShcIkNsYXVkZSBpbXBvcnQgY2FuY2VsbGVkIG9yIG5vdGhpbmcgc2VsZWN0ZWQuXCIsIFwiaW5mb1wiKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBhd2FpdCBjdHgud2FpdEZvcklkbGUoKTtcbiAgYXdhaXQgY3R4LnJlbG9hZCgpO1xuXG4gIGNvbnN0IGxpbmVzID0gW1xuICAgIGBJbXBvcnRlZCBDbGF1ZGUgYXNzZXRzIGludG8gJHtzY29wZX0gY29uZmlnOmAsXG4gICAgYC0gU2tpbGxzIChmbGF0KTogJHtpbXBvcnRlZFNraWxsc0NvdW50fWAsXG4gICAgYC0gUGx1Z2lucyAoZmxhdCBwYXRocyk6ICR7aW1wb3J0ZWRQbHVnaW5zQ291bnR9YCxcbiAgICBgLSBNYXJrZXRwbGFjZSBjb21wb25lbnRzOiAke2ltcG9ydGVkTWFya2V0cGxhY2VDb21wb25lbnRzfWAsXG4gIF07XG4gIGlmIChpbXBvcnRlZFNraWxsc0NvdW50ID4gMCkge1xuICAgIGxpbmVzLnB1c2goYC0gU2tpbGwgcGF0aHMgYWRkZWQgdG8gUGkgc2V0dGluZ3MgKCR7c2NvcGV9KSBmb3IgYXZhaWxhYmlsaXR5YCk7XG4gICAgbGluZXMucHVzaChgLSBTa2lsbCByZWZzIGFkZGVkIHRvIEdTRCBwcmVmZXJlbmNlcyAoJHtzY29wZX0pIHdoZW4gc2VsZWN0ZWRgKTtcbiAgfVxuICBpZiAoaW1wb3J0ZWRQbHVnaW5zQ291bnQgPiAwKSB7XG4gICAgbGluZXMucHVzaChgLSBQbHVnaW4vcGFja2FnZSBwYXRocyBhZGRlZCB0byBQaSBzZXR0aW5ncyAoJHtzY29wZX0pIHBhY2thZ2VzYCk7XG4gIH1cbiAgaWYgKGltcG9ydGVkTWFya2V0cGxhY2VDb21wb25lbnRzID4gMCkge1xuICAgIGxpbmVzLnB1c2goYC0gQ2Fub25pY2FsIG5hbWVzIHByZXNlcnZlZDogJHtjYW5vbmljYWxOYW1lc1BlcnNpc3RlZC5sZW5ndGh9IGVudHJpZXNgKTtcbiAgICBpZiAoY2Fub25pY2FsTmFtZXNQZXJzaXN0ZWQubGVuZ3RoIDw9IDEwKSB7XG4gICAgICBsaW5lcy5wdXNoKGAgIE5hbWVzOiAke2Nhbm9uaWNhbE5hbWVzUGVyc2lzdGVkLmpvaW4oJywgJyl9YCk7XG4gICAgfVxuICB9XG4gIGN0eC51aS5ub3RpZnkobGluZXMuam9pbihcIlxcblwiKSwgXCJpbmZvXCIpO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBQ0EsU0FBUyxpQkFBaUIsbUJBQW1CO0FBQzdDLFNBQVMsWUFBWSxhQUFhLG9CQUFvQjtBQUN0RCxTQUFTLFVBQW1CLE1BQU0sVUFBVSxlQUFlO0FBQzNELFNBQVMsZUFBZTtBQUN4QixTQUFTLHNCQUFnRDtBQW9CekQsTUFBTSxZQUFZLG9CQUFJLElBQUk7QUFBQSxFQUN4QjtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQ0YsQ0FBQztBQUVELFNBQVMsbUJBQW1CLE9BQTJCO0FBQ3JELFFBQU0sT0FBTyxvQkFBSSxJQUFZO0FBQzdCLFFBQU0sTUFBZ0IsQ0FBQztBQUN2QixhQUFXLGFBQWEsT0FBTztBQUM3QixVQUFNLGVBQWUsUUFBUSxTQUFTO0FBQ3RDLFFBQUksS0FBSyxJQUFJLFlBQVksRUFBRztBQUM1QixTQUFLLElBQUksWUFBWTtBQUNyQixRQUFJLFdBQVcsWUFBWSxFQUFHLEtBQUksS0FBSyxZQUFZO0FBQUEsRUFDckQ7QUFDQSxTQUFPO0FBQ1Q7QUFFTyxTQUFTLHFCQUFxQixLQUE4RDtBQUNqRyxRQUFNLE9BQU8sUUFBUTtBQUNyQixRQUFNLFNBQVMsUUFBUSxLQUFLLElBQUk7QUFDaEMsUUFBTSxjQUFjLFFBQVEsS0FBSyxNQUFNLElBQUk7QUFLM0MsUUFBTSxhQUFhLG1CQUFtQjtBQUFBLElBQ3BDLEtBQUssTUFBTSxXQUFXLFFBQVE7QUFBQSxJQUM5QixLQUFLLE1BQU0sU0FBUyxlQUFlO0FBQUEsSUFDbkMsS0FBSyxNQUFNLFNBQVMsUUFBUTtBQUFBLElBQzVCLEtBQUssUUFBUSxlQUFlO0FBQUEsSUFDNUIsS0FBSyxRQUFRLFFBQVE7QUFBQSxJQUNyQixLQUFLLGFBQWEsZUFBZTtBQUFBLElBQ2pDLEtB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
