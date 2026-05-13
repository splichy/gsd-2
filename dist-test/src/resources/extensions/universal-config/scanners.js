import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
function source(tool, path, level) {
  return { tool: tool.id, toolName: tool.name, path, level };
}
function walkDirectories(root, visit, maxDepth = 4) {
  const skip = /* @__PURE__ */ new Set([".git", "node_modules", ".worktrees", "dist", "build", "cache", ".cache"]);
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
      if (skip.has(entry.name)) continue;
      walk(join(dir, entry.name), depth + 1);
    }
  }
  walk(root, 0);
}
async function readTextFile(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
function tryParseJson(content) {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}
async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
async function isDirectory(path) {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}
async function readDirSafe(dir) {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}
function parseFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }
  const rawFm = match[1] ?? "";
  const body = match[2] ?? "";
  const frontmatter = {};
  for (const line of rawFm.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    if (typeof value === "string" && /^["'].*["']$/.test(value)) {
      value = value.slice(1, -1);
    }
    if (value === "true") value = true;
    else if (value === "false") value = false;
    else if (typeof value === "string" && /^\d+$/.test(value)) value = parseInt(value, 10);
    frontmatter[key] = value;
  }
  return { frontmatter, body };
}
function parseMcpServersFromJson(json, filePath, tool, level) {
  const servers = [];
  const mcpServers = json.mcpServers;
  if (!mcpServers || typeof mcpServers !== "object") return servers;
  for (const [name, config] of Object.entries(mcpServers)) {
    if (!config || typeof config !== "object") continue;
    const c = config;
    servers.push({
      type: "mcp-server",
      name,
      command: typeof c.command === "string" ? c.command : void 0,
      args: Array.isArray(c.args) ? c.args : void 0,
      env: c.env && typeof c.env === "object" ? c.env : void 0,
      url: typeof c.url === "string" ? c.url : void 0,
      transport: ["stdio", "sse", "http"].includes(c.type) ? c.type : void 0,
      source: source(tool, filePath, level)
    });
  }
  return servers;
}
async function scanClaude(projectRoot, home, tool) {
  const items = [];
  const warnings = [];
  for (const relPath of [".claude.json", ".claude/mcp.json"]) {
    const fullPath = join(home, relPath);
    const content = await readTextFile(fullPath);
    if (content) {
      const json = tryParseJson(content);
      if (json) {
        const servers = parseMcpServersFromJson(json, fullPath, tool, "user");
        if (servers.length > 0) {
          items.push(...servers);
          break;
        }
      }
    }
  }
  for (const relPath of [".mcp.json", ".claude/.mcp.json", ".claude/mcp.json"]) {
    const fullPath = join(projectRoot, relPath);
    const content = await readTextFile(fullPath);
    if (content) {
      const json = tryParseJson(content);
      if (json) {
        const servers = parseMcpServersFromJson(json, fullPath, tool, "project");
        if (servers.length > 0) {
          items.push(...servers);
          break;
        }
      }
    }
  }
  const userClaudeMd = join(home, ".claude/CLAUDE.md");
  const userMdContent = await readTextFile(userClaudeMd);
  if (userMdContent) {
    items.push({
      type: "context-file",
      name: "CLAUDE.md (user)",
      content: userMdContent,
      source: source(tool, userClaudeMd, "user")
    });
  }
  for (const relPath of ["CLAUDE.md", ".claude/CLAUDE.md"]) {
    const fullPath = join(projectRoot, relPath);
    const content = await readTextFile(fullPath);
    if (content) {
      items.push({
        type: "context-file",
        name: `${relPath}`,
        content,
        source: source(tool, fullPath, "project")
      });
    }
  }
  const userSkillsRoot = join(home, ".claude/skills");
  if (existsSync(userSkillsRoot)) {
    walkDirectories(userSkillsRoot, (dir) => {
      const skillFile = join(dir, "SKILL.md");
      if (!existsSync(skillFile)) return;
      items.push({
        type: "claude-skill",
        name: basename(dir),
        path: dir,
        source: source(tool, skillFile, "user")
      });
    }, 5);
  }
  const userPluginsRoot = join(home, ".claude/plugins");
  if (existsSync(userPluginsRoot)) {
    walkDirectories(userPluginsRoot, (dir) => {
      const packageJsonPath = join(dir, "package.json");
      if (!existsSync(packageJsonPath)) return;
      let packageName;
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
        packageName = pkg.name;
      } catch {
        packageName = void 0;
      }
      items.push({
        type: "claude-plugin",
        name: packageName || basename(dir),
        packageName,
        path: dir,
        source: source(tool, packageJsonPath, "user")
      });
    }, 4);
  }
  const userSettings = join(home, ".claude/settings.json");
  const settingsContent = await readTextFile(userSettings);
  if (settingsContent) {
    const json = tryParseJson(settingsContent);
    if (json) {
      items.push({ type: "settings", data: json, source: source(tool, userSettings, "user") });
    }
  }
  return { items, warnings };
}
async function scanCursor(projectRoot, home, tool) {
  const items = [];
  const warnings = [];
  for (const { dir, level } of [
    { dir: home, level: "user" },
    { dir: projectRoot, level: "project" }
  ]) {
    const mcpPath = join(dir, ".cursor/mcp.json");
    const content = await readTextFile(mcpPath);
    if (content) {
      const json = tryParseJson(content);
      if (json) items.push(...parseMcpServersFromJson(json, mcpPath, tool, level));
    }
  }
  const projectRulesDir = join(projectRoot, ".cursor/rules");
  const ruleFiles = await readDirSafe(projectRulesDir);
  for (const file of ruleFiles) {
    if (!file.endsWith(".mdc") && !file.endsWith(".md")) continue;
    const filePath = join(projectRulesDir, file);
    const content = await readTextFile(filePath);
    if (!content) continue;
    const { frontmatter, body } = parseFrontmatter(content);
    items.push({
      type: "rule",
      name: file.replace(/\.(mdc|md)$/, ""),
      content: body,
      globs: typeof frontmatter.globs === "string" ? [frontmatter.globs] : void 0,
      alwaysApply: frontmatter.alwaysApply === true,
      description: typeof frontmatter.description === "string" ? frontmatter.description : void 0,
      source: source(tool, filePath, "project")
    });
  }
  const legacyRulesPath = join(projectRoot, ".cursorrules");
  const legacyContent = await readTextFile(legacyRulesPath);
  if (legacyContent) {
    items.push({
      type: "rule",
      name: "cursorrules (legacy)",
      content: legacyContent,
      alwaysApply: true,
      source: source(tool, legacyRulesPath, "project")
    });
  }
  const settingsPath = join(projectRoot, ".cursor/settings.json");
  const settingsContent = await readTextFile(settingsPath);
  if (settingsContent) {
    const json = tryParseJson(settingsContent);
    if (json) items.push({ type: "settings", data: json, source: source(tool, settingsPath, "project") });
  }
  return { items, warnings };
}
async function scanWindsurf(projectRoot, home, tool) {
  const items = [];
  const warnings = [];
  for (const { path: mcpPath, level } of [
    { path: join(home, ".codeium/windsurf/mcp_config.json"), level: "user" },
    { path: join(projectRoot, ".windsurf/mcp_config.json"), level: "project" }
  ]) {
    const content = await readTextFile(mcpPath);
    if (content) {
      const json = tryParseJson(content);
      if (json) items.push(...parseMcpServersFromJson(json, mcpPath, tool, level));
    }
  }
  const globalRulesPath = join(home, ".codeium/windsurf/memories/global_rules.md");
  const globalRules = await readTextFile(globalRulesPath);
  if (globalRules) {
    items.push({
      type: "rule",
      name: "global_rules",
      content: globalRules,
      alwaysApply: true,
      source: source(tool, globalRulesPath, "user")
    });
  }
  const rulesDir = join(projectRoot, ".windsurf/rules");
  const ruleFiles = await readDirSafe(rulesDir);
  for (const file of ruleFiles) {
    if (!file.endsWith(".md")) continue;
    const filePath = join(rulesDir, file);
    const content = await readTextFile(filePath);
    if (!content) continue;
    const { frontmatter, body } = parseFrontmatter(content);
    items.push({
      type: "rule",
      name: file.replace(/\.md$/, ""),
      content: body,
      description: typeof frontmatter.description === "string" ? frontmatter.description : void 0,
      source: source(tool, filePath, "project")
    });
  }
  const legacyPath = join(projectRoot, ".windsurfrules");
  const legacyContent = await readTextFile(legacyPath);
  if (legacyContent) {
    items.push({
      type: "rule",
      name: "windsurfrules (legacy)",
      content: legacyContent,
      alwaysApply: true,
      source: source(tool, legacyPath, "project")
    });
  }
  return { items, warnings };
}
async function scanGemini(projectRoot, home, tool) {
  const items = [];
  const warnings = [];
  for (const { path: settingsPath, level } of [
    { path: join(home, ".gemini/settings.json"), level: "user" },
    { path: join(projectRoot, ".gemini/settings.json"), level: "project" }
  ]) {
    const content = await readTextFile(settingsPath);
    if (content) {
      const json = tryParseJson(content);
      if (json) {
        items.push(...parseMcpServersFromJson(json, settingsPath, tool, level));
        items.push({ type: "settings", data: json, source: source(tool, settingsPath, level) });
      }
    }
  }
  for (const { path: mdPath, level } of [
    { path: join(home, ".gemini/GEMINI.md"), level: "user" },
    { path: join(projectRoot, ".gemini/GEMINI.md"), level: "project" }
  ]) {
    const content = await readTextFile(mdPath);
    if (content) {
      items.push({
        type: "context-file",
        name: `GEMINI.md (${level})`,
        content,
        source: source(tool, mdPath, level)
      });
    }
  }
  return { items, warnings };
}
async function scanCodex(projectRoot, home, tool) {
  const items = [];
  const warnings = [];
  const agentsMdPath = join(home, ".codex/AGENTS.md");
  const agentsMd = await readTextFile(agentsMdPath);
  if (agentsMd) {
    items.push({
      type: "context-file",
      name: "AGENTS.md (user)",
      content: agentsMd,
      source: source(tool, agentsMdPath, "user")
    });
  }
  const projectAgentsMd = join(projectRoot, "AGENTS.md");
  const projectContent = await readTextFile(projectAgentsMd);
  if (projectContent) {
    items.push({
      type: "context-file",
      name: "AGENTS.md (project)",
      content: projectContent,
      source: source(tool, projectAgentsMd, "project")
    });
  }
  for (const { path: tomlPath, level } of [
    { path: join(home, ".codex/config.toml"), level: "user" },
    { path: join(projectRoot, ".codex/config.toml"), level: "project" }
  ]) {
    if (await fileExists(tomlPath)) {
      warnings.push(`Found ${tomlPath} (TOML config) \u2014 MCP server parsing from TOML not yet supported`);
    }
  }
  return { items, warnings };
}
async function scanCline(projectRoot, _home, tool) {
  const items = [];
  const warnings = [];
  const clinerulesPath = join(projectRoot, ".clinerules");
  if (await isDirectory(clinerulesPath)) {
    const files = await readDirSafe(clinerulesPath);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const filePath = join(clinerulesPath, file);
      const content = await readTextFile(filePath);
      if (!content) continue;
      const { body } = parseFrontmatter(content);
      items.push({
        type: "rule",
        name: file.replace(/\.md$/, ""),
        content: body,
        alwaysApply: true,
        source: source(tool, filePath, "project")
      });
    }
  } else {
    const content = await readTextFile(clinerulesPath);
    if (content) {
      items.push({
        type: "rule",
        name: "clinerules",
        content,
        alwaysApply: true,
        source: source(tool, clinerulesPath, "project")
      });
    }
  }
  const clineMcpPath = join(projectRoot, ".cline/mcp_settings.json");
  const clineMcpContent = await readTextFile(clineMcpPath);
  if (clineMcpContent) {
    const json = tryParseJson(clineMcpContent);
    if (json) items.push(...parseMcpServersFromJson(json, clineMcpPath, tool, "project"));
  }
  return { items, warnings };
}
async function scanGithubCopilot(projectRoot, _home, tool) {
  const items = [];
  const warnings = [];
  const instructionsPath = join(projectRoot, ".github/copilot-instructions.md");
  const instructions = await readTextFile(instructionsPath);
  if (instructions) {
    items.push({
      type: "context-file",
      name: "copilot-instructions.md",
      content: instructions,
      source: source(tool, instructionsPath, "project")
    });
  }
  const instructionsDir = join(projectRoot, ".github/instructions");
  const instrFiles = await readDirSafe(instructionsDir);
  for (const file of instrFiles) {
    if (!file.endsWith(".instructions.md")) continue;
    const filePath = join(instructionsDir, file);
    const content = await readTextFile(filePath);
    if (!content) continue;
    const { frontmatter, body } = parseFrontmatter(content);
    const applyTo = typeof frontmatter.applyTo === "string" ? frontmatter.applyTo : void 0;
    items.push({
      type: "rule",
      name: file.replace(".instructions.md", ""),
      content: body,
      globs: applyTo ? [applyTo] : void 0,
      description: `GitHub Copilot instruction${applyTo ? ` (applies to: ${applyTo})` : ""}`,
      source: source(tool, filePath, "project")
    });
  }
  return { items, warnings };
}
async function scanVSCode(projectRoot, _home, tool) {
  const items = [];
  const warnings = [];
  const settingsPath = join(projectRoot, ".vscode/settings.json");
  const settingsContent = await readTextFile(settingsPath);
  if (settingsContent) {
    const json = tryParseJson(settingsContent);
    if (json) {
      items.push({ type: "settings", data: json, source: source(tool, settingsPath, "project") });
      const mcpServers = json["mcp.servers"] ?? json.mcpServers ?? json.mcp?.servers;
      if (mcpServers && typeof mcpServers === "object") {
        items.push(...parseMcpServersFromJson({ mcpServers }, settingsPath, tool, "project"));
      }
    }
  }
  const mcpPath = join(projectRoot, ".vscode/mcp.json");
  const mcpContent = await readTextFile(mcpPath);
  if (mcpContent) {
    const json = tryParseJson(mcpContent);
    if (json) {
      const servers = json.servers ?? json.mcpServers;
      if (servers && typeof servers === "object") {
        items.push(...parseMcpServersFromJson({ mcpServers: servers }, mcpPath, tool, "project"));
      }
    }
  }
  return { items, warnings };
}
const SCANNERS = {
  claude: scanClaude,
  cursor: scanCursor,
  windsurf: scanWindsurf,
  gemini: scanGemini,
  codex: scanCodex,
  cline: scanCline,
  "github-copilot": scanGithubCopilot,
  vscode: scanVSCode
};
export {
  SCANNERS
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL3VuaXZlcnNhbC1jb25maWcvc2Nhbm5lcnMudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogVW5pdmVyc2FsIENvbmZpZyBEaXNjb3ZlcnkgXHUyMDE0IHBlci10b29sIHNjYW5uZXJzXG4gKlxuICogRWFjaCBzY2FubmVyIHJlYWRzIGNvbmZpZyBmaWxlcyBmb3IgYSBzcGVjaWZpYyBBSSBjb2RpbmcgdG9vbCBhbmRcbiAqIG5vcm1hbGl6ZXMgdGhlbSB0byBEaXNjb3ZlcmVkSXRlbVtdLiBSZWFkLW9ubHk6IG5ldmVyIG1vZGlmaWVzIGZpbGVzLlxuICpcbiAqIENvbmZpZyBwYXRoIHNvdXJjZXMgdmVyaWZpZWQgYWdhaW5zdCBPaCBNeSBQaSdzIGRpc2NvdmVyeSBtb2R1bGUuXG4gKi9cblxuaW1wb3J0IHsgcmVhZEZpbGUsIHJlYWRkaXIsIHN0YXQgfSBmcm9tIFwibm9kZTpmcy9wcm9taXNlc1wiO1xuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZGRpclN5bmMsIHJlYWRGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luLCBiYXNlbmFtZSwgcmVzb2x2ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGhvbWVkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHR5cGUge1xuICBDb25maWdTb3VyY2UsXG4gIENvbmZpZ0xldmVsLFxuICBEaXNjb3ZlcmVkSXRlbSxcbiAgRGlzY292ZXJlZE1DUFNlcnZlcixcbiAgRGlzY292ZXJlZFJ1bGUsXG4gIERpc2NvdmVyZWRDb250ZXh0RmlsZSxcbiAgRGlzY292ZXJlZFNldHRpbmdzLFxuICBUb29sRGlzY292ZXJ5UmVzdWx0LFxuICBUb29sSWQsXG4gIFRvb2xJbmZvLFxufSBmcm9tIFwiLi90eXBlcy5qc1wiO1xuXG4vLyBcdTI1MDBcdTI1MDAgSGVscGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gc291cmNlKHRvb2w6IFRvb2xJbmZvLCBwYXRoOiBzdHJpbmcsIGxldmVsOiBDb25maWdMZXZlbCk6IENvbmZpZ1NvdXJjZSB7XG4gIHJldHVybiB7IHRvb2w6IHRvb2wuaWQsIHRvb2xOYW1lOiB0b29sLm5hbWUsIHBhdGgsIGxldmVsIH07XG59XG5cbmZ1bmN0aW9uIHdhbGtEaXJlY3Rvcmllcyhyb290OiBzdHJpbmcsIHZpc2l0OiAoZGlyOiBzdHJpbmcsIGRlcHRoOiBudW1iZXIpID0+IHZvaWQsIG1heERlcHRoID0gNCk6IHZvaWQge1xuICBjb25zdCBza2lwID0gbmV3IFNldChbXCIuZ2l0XCIsIFwibm9kZV9tb2R1bGVzXCIsIFwiLndvcmt0cmVlc1wiLCBcImRpc3RcIiwgXCJidWlsZFwiLCBcImNhY2hlXCIsIFwiLmNhY2hlXCJdKTtcblxuICBmdW5jdGlvbiB3YWxrKGRpcjogc3RyaW5nLCBkZXB0aDogbnVtYmVyKSB7XG4gICAgdmlzaXQoZGlyLCBkZXB0aCk7XG4gICAgaWYgKGRlcHRoID49IG1heERlcHRoKSByZXR1cm47XG5cbiAgICBsZXQgZW50cmllczogQXJyYXk8eyBuYW1lOiBzdHJpbmc7IGlzRGlyZWN0b3J5OiAoKSA9PiBib29sZWFuIH0+ID0gW107XG4gICAgdHJ5IHtcbiAgICAgIGVudHJpZXMgPSByZWFkZGlyU3luYyhkaXIsIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGVudHJpZXMpIHtcbiAgICAgIGlmICghZW50cnkuaXNEaXJlY3RvcnkoKSkgY29udGludWU7XG4gICAgICBpZiAoc2tpcC5oYXMoZW50cnkubmFtZSkpIGNvbnRpbnVlO1xuICAgICAgd2Fsayhqb2luKGRpciwgZW50cnkubmFtZSksIGRlcHRoICsgMSk7XG4gICAgfVxuICB9XG5cbiAgd2Fsayhyb290LCAwKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVhZFRleHRGaWxlKHBhdGg6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICB0cnkge1xuICAgIHJldHVybiBhd2FpdCByZWFkRmlsZShwYXRoLCBcInV0ZjhcIik7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbmZ1bmN0aW9uIHRyeVBhcnNlSnNvbjxUPihjb250ZW50OiBzdHJpbmcpOiBUIHwgbnVsbCB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIEpTT04ucGFyc2UoY29udGVudCkgYXMgVDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gZmlsZUV4aXN0cyhwYXRoOiBzdHJpbmcpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgdHJ5IHtcbiAgICBhd2FpdCBzdGF0KHBhdGgpO1xuICAgIHJldHVybiB0cnVlO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gaXNEaXJlY3RvcnkocGF0aDogc3RyaW5nKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIHRyeSB7XG4gICAgY29uc3QgcyA9IGF3YWl0IHN0YXQocGF0aCk7XG4gICAgcmV0dXJuIHMuaXNEaXJlY3RvcnkoKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJlYWREaXJTYWZlKGRpcjogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmdbXT4ge1xuICB0cnkge1xuICAgIHJldHVybiBhd2FpdCByZWFkZGlyKGRpcik7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBbXTtcbiAgfVxufVxuXG4vKipcbiAqIFBhcnNlIE1EQy9ZQU1MIGZyb250bWF0dGVyIGZyb20gYSBtYXJrZG93biBmaWxlLlxuICogUmV0dXJucyB0aGUgZnJvbnRtYXR0ZXIgYXMga2V5LXZhbHVlIHBhaXJzIGFuZCB0aGUgYm9keSBjb250ZW50LlxuICovXG5mdW5jdGlvbiBwYXJzZUZyb250bWF0dGVyKGNvbnRlbnQ6IHN0cmluZyk6IHsgZnJvbnRtYXR0ZXI6IFJlY29yZDxzdHJpbmcsIHVua25vd24+OyBib2R5OiBzdHJpbmcgfSB7XG4gIGNvbnN0IG1hdGNoID0gY29udGVudC5tYXRjaCgvXi0tLVxccypcXG4oW1xcc1xcU10qPylcXG4tLS1cXHMqXFxuKFtcXHNcXFNdKikkLyk7XG4gIGlmICghbWF0Y2gpIHtcbiAgICByZXR1cm4geyBmcm9udG1hdHRlcjoge30sIGJvZHk6IGNvbnRlbnQgfTtcbiAgfVxuXG4gIGNvbnN0IHJhd0ZtID0gbWF0Y2hbMV0gPz8gXCJcIjtcbiAgY29uc3QgYm9keSA9IG1hdGNoWzJdID8/IFwiXCI7XG4gIGNvbnN0IGZyb250bWF0dGVyOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuXG4gIGZvciAoY29uc3QgbGluZSBvZiByYXdGbS5zcGxpdChcIlxcblwiKSkge1xuICAgIGNvbnN0IGNvbG9uSWR4ID0gbGluZS5pbmRleE9mKFwiOlwiKTtcbiAgICBpZiAoY29sb25JZHggPT09IC0xKSBjb250aW51ZTtcbiAgICBjb25zdCBrZXkgPSBsaW5lLnNsaWNlKDAsIGNvbG9uSWR4KS50cmltKCk7XG4gICAgbGV0IHZhbHVlOiB1bmtub3duID0gbGluZS5zbGljZShjb2xvbklkeCArIDEpLnRyaW0oKTtcblxuICAgIC8vIFN0cmlwIHN1cnJvdW5kaW5nIHF1b3RlcyBmcm9tIFlBTUwgc3RyaW5nIHZhbHVlc1xuICAgIGlmICh0eXBlb2YgdmFsdWUgPT09IFwic3RyaW5nXCIgJiYgL15bXCInXS4qW1wiJ10kLy50ZXN0KHZhbHVlKSkge1xuICAgICAgdmFsdWUgPSB2YWx1ZS5zbGljZSgxLCAtMSk7XG4gICAgfVxuXG4gICAgLy8gUGFyc2Ugc2ltcGxlIHR5cGVzXG4gICAgaWYgKHZhbHVlID09PSBcInRydWVcIikgdmFsdWUgPSB0cnVlO1xuICAgIGVsc2UgaWYgKHZhbHVlID09PSBcImZhbHNlXCIpIHZhbHVlID0gZmFsc2U7XG4gICAgZWxzZSBpZiAodHlwZW9mIHZhbHVlID09PSBcInN0cmluZ1wiICYmIC9eXFxkKyQvLnRlc3QodmFsdWUpKSB2YWx1ZSA9IHBhcnNlSW50KHZhbHVlLCAxMCk7XG5cbiAgICBmcm9udG1hdHRlcltrZXldID0gdmFsdWU7XG4gIH1cblxuICByZXR1cm4geyBmcm9udG1hdHRlciwgYm9keSB9O1xufVxuXG4vKipcbiAqIFBhcnNlIE1DUCBzZXJ2ZXJzIGZyb20gYSBKU09OIG9iamVjdCB3aXRoIGBtY3BTZXJ2ZXJzYCBrZXkuXG4gKiBDb21tb24gZm9ybWF0IHVzZWQgYnkgQ2xhdWRlIENvZGUsIEN1cnNvciwgV2luZHN1cmYsIEdlbWluaSBDTEkuXG4gKi9cbmZ1bmN0aW9uIHBhcnNlTWNwU2VydmVyc0Zyb21Kc29uKFxuICBqc29uOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAgZmlsZVBhdGg6IHN0cmluZyxcbiAgdG9vbDogVG9vbEluZm8sXG4gIGxldmVsOiBDb25maWdMZXZlbCxcbik6IERpc2NvdmVyZWRNQ1BTZXJ2ZXJbXSB7XG4gIGNvbnN0IHNlcnZlcnM6IERpc2NvdmVyZWRNQ1BTZXJ2ZXJbXSA9IFtdO1xuICBjb25zdCBtY3BTZXJ2ZXJzID0ganNvbi5tY3BTZXJ2ZXJzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkO1xuICBpZiAoIW1jcFNlcnZlcnMgfHwgdHlwZW9mIG1jcFNlcnZlcnMgIT09IFwib2JqZWN0XCIpIHJldHVybiBzZXJ2ZXJzO1xuXG4gIGZvciAoY29uc3QgW25hbWUsIGNvbmZpZ10gb2YgT2JqZWN0LmVudHJpZXMobWNwU2VydmVycykpIHtcbiAgICBpZiAoIWNvbmZpZyB8fCB0eXBlb2YgY29uZmlnICE9PSBcIm9iamVjdFwiKSBjb250aW51ZTtcbiAgICBjb25zdCBjID0gY29uZmlnIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIHNlcnZlcnMucHVzaCh7XG4gICAgICB0eXBlOiBcIm1jcC1zZXJ2ZXJcIixcbiAgICAgIG5hbWUsXG4gICAgICBjb21tYW5kOiB0eXBlb2YgYy5jb21tYW5kID09PSBcInN0cmluZ1wiID8gYy5jb21tYW5kIDogdW5kZWZpbmVkLFxuICAgICAgYXJnczogQXJyYXkuaXNBcnJheShjLmFyZ3MpID8gKGMuYXJncyBhcyBzdHJpbmdbXSkgOiB1bmRlZmluZWQsXG4gICAgICBlbnY6IGMuZW52ICYmIHR5cGVvZiBjLmVudiA9PT0gXCJvYmplY3RcIiA/IChjLmVudiBhcyBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+KSA6IHVuZGVmaW5lZCxcbiAgICAgIHVybDogdHlwZW9mIGMudXJsID09PSBcInN0cmluZ1wiID8gYy51cmwgOiB1bmRlZmluZWQsXG4gICAgICB0cmFuc3BvcnQ6IFtcInN0ZGlvXCIsIFwic3NlXCIsIFwiaHR0cFwiXS5pbmNsdWRlcyhjLnR5cGUgYXMgc3RyaW5nKVxuICAgICAgICA/IChjLnR5cGUgYXMgXCJzdGRpb1wiIHwgXCJzc2VcIiB8IFwiaHR0cFwiKVxuICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICAgIHNvdXJjZTogc291cmNlKHRvb2wsIGZpbGVQYXRoLCBsZXZlbCksXG4gICAgfSk7XG4gIH1cbiAgcmV0dXJuIHNlcnZlcnM7XG59XG5cbi8vIFx1MjUwMFx1MjUwMCBQZXItdG9vbCBzY2FubmVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudHlwZSBTY2FubmVyID0gKHByb2plY3RSb290OiBzdHJpbmcsIGhvbWU6IHN0cmluZywgdG9vbDogVG9vbEluZm8pID0+IFByb21pc2U8eyBpdGVtczogRGlzY292ZXJlZEl0ZW1bXTsgd2FybmluZ3M6IHN0cmluZ1tdIH0+O1xuXG4vLyAtLS0tLS0tLS0tIENsYXVkZSBDb2RlIC0tLS0tLS0tLS1cblxuYXN5bmMgZnVuY3Rpb24gc2NhbkNsYXVkZShwcm9qZWN0Um9vdDogc3RyaW5nLCBob21lOiBzdHJpbmcsIHRvb2w6IFRvb2xJbmZvKTogUHJvbWlzZTx7IGl0ZW1zOiBEaXNjb3ZlcmVkSXRlbVtdOyB3YXJuaW5nczogc3RyaW5nW10gfT4ge1xuICBjb25zdCBpdGVtczogRGlzY292ZXJlZEl0ZW1bXSA9IFtdO1xuICBjb25zdCB3YXJuaW5nczogc3RyaW5nW10gPSBbXTtcblxuICAvLyBVc2VyLWxldmVsIE1DUDogfi8uY2xhdWRlLmpzb24gb3Igfi8uY2xhdWRlL21jcC5qc29uXG4gIGZvciAoY29uc3QgcmVsUGF0aCBvZiBbXCIuY2xhdWRlLmpzb25cIiwgXCIuY2xhdWRlL21jcC5qc29uXCJdKSB7XG4gICAgY29uc3QgZnVsbFBhdGggPSBqb2luKGhvbWUsIHJlbFBhdGgpO1xuICAgIGNvbnN0IGNvbnRlbnQgPSBhd2FpdCByZWFkVGV4dEZpbGUoZnVsbFBhdGgpO1xuICAgIGlmIChjb250ZW50KSB7XG4gICAgICBjb25zdCBqc29uID0gdHJ5UGFyc2VKc29uPFJlY29yZDxzdHJpbmcsIHVua25vd24+Pihjb250ZW50KTtcbiAgICAgIGlmIChqc29uKSB7XG4gICAgICAgIGNvbnN0IHNlcnZlcnMgPSBwYXJzZU1jcFNlcnZlcnNGcm9tSnNvbihqc29uLCBmdWxsUGF0aCwgdG9vbCwgXCJ1c2VyXCIpO1xuICAgICAgICBpZiAoc2VydmVycy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgaXRlbXMucHVzaCguLi5zZXJ2ZXJzKTtcbiAgICAgICAgICBicmVhazsgLy8gRmlyc3QgaGl0IHdpbnMgKG1hdGNoZXMgT2ggTXkgUGkgYmVoYXZpb3IpXG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyBQcm9qZWN0LWxldmVsIE1DUDogLm1jcC5qc29uIChzdGFuZGFyZCksIC5jbGF1ZGUvLm1jcC5qc29uLCBvciAuY2xhdWRlL21jcC5qc29uXG4gIGZvciAoY29uc3QgcmVsUGF0aCBvZiBbXCIubWNwLmpzb25cIiwgXCIuY2xhdWRlLy5tY3AuanNvblwiLCBcIi5jbGF1ZGUvbWNwLmpzb25cIl0pIHtcbiAgICBjb25zdCBmdWxsUGF0aCA9IGpvaW4ocHJvamVjdFJvb3QsIHJlbFBhdGgpO1xuICAgIGNvbnN0IGNvbnRlbnQgPSBhd2FpdCByZWFkVGV4dEZpbGUoZnVsbFBhdGgpO1xuICAgIGlmIChjb250ZW50KSB7XG4gICAgICBjb25zdCBqc29uID0gdHJ5UGFyc2VKc29uPFJlY29yZDxzdHJpbmcsIHVua25vd24+Pihjb250ZW50KTtcbiAgICAgIGlmIChqc29uKSB7XG4gICAgICAgIGNvbnN0IHNlcnZlcnMgPSBwYXJzZU1jcFNlcnZlcnNGcm9tSnNvbihqc29uLCBmdWxsUGF0aCwgdG9vbCwgXCJwcm9qZWN0XCIpO1xuICAgICAgICBpZiAoc2VydmVycy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgaXRlbXMucHVzaCguLi5zZXJ2ZXJzKTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8vIFVzZXItbGV2ZWwgY29udGV4dDogfi8uY2xhdWRlL0NMQVVERS5tZFxuICBjb25zdCB1c2VyQ2xhdWRlTWQgPSBqb2luKGhvbWUsIFwiLmNsYXVkZS9DTEFVREUubWRcIik7XG4gIGNvbnN0IHVzZXJNZENvbnRlbnQgPSBhd2FpdCByZWFkVGV4dEZpbGUodXNlckNsYXVkZU1kKTtcbiAgaWYgKHVzZXJNZENvbnRlbnQpIHtcbiAgICBpdGVtcy5wdXNoKHtcbiAgICAgIHR5cGU6IFwiY29udGV4dC1maWxlXCIsXG4gICAgICBuYW1lOiBcIkNMQVVERS5tZCAodXNlcilcIixcbiAgICAgIGNvbnRlbnQ6IHVzZXJNZENvbnRlbnQsXG4gICAgICBzb3VyY2U6IHNvdXJjZSh0b29sLCB1c2VyQ2xhdWRlTWQsIFwidXNlclwiKSxcbiAgICB9KTtcbiAgfVxuXG4gIC8vIFByb2plY3QtbGV2ZWwgY29udGV4dDogQ0xBVURFLm1kIChyb290KSBhbmQgLmNsYXVkZS9DTEFVREUubWRcbiAgZm9yIChjb25zdCByZWxQYXRoIG9mIFtcIkNMQVVERS5tZFwiLCBcIi5jbGF1ZGUvQ0xBVURFLm1kXCJdKSB7XG4gICAgY29uc3QgZnVsbFBhdGggPSBqb2luKHByb2plY3RSb290LCByZWxQYXRoKTtcbiAgICBjb25zdCBjb250ZW50ID0gYXdhaXQgcmVhZFRleHRGaWxlKGZ1bGxQYXRoKTtcbiAgICBpZiAoY29udGVudCkge1xuICAgICAgaXRlbXMucHVzaCh7XG4gICAgICAgIHR5cGU6IFwiY29udGV4dC1maWxlXCIsXG4gICAgICAgIG5hbWU6IGAke3JlbFBhdGh9YCxcbiAgICAgICAgY29udGVudCxcbiAgICAgICAgc291cmNlOiBzb3VyY2UodG9vbCwgZnVsbFBhdGgsIFwicHJvamVjdFwiKSxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuXG4gIC8vIENsYXVkZSBza2lsbHM6IH4vLmNsYXVkZS9za2lsbHMvKiovU0tJTEwubWRcbiAgY29uc3QgdXNlclNraWxsc1Jvb3QgPSBqb2luKGhvbWUsIFwiLmNsYXVkZS9za2lsbHNcIik7XG4gIGlmIChleGlzdHNTeW5jKHVzZXJTa2lsbHNSb290KSkge1xuICAgIHdhbGtEaXJlY3Rvcmllcyh1c2VyU2tpbGxzUm9vdCwgKGRpcikgPT4ge1xuICAgICAgY29uc3Qgc2tpbGxGaWxlID0gam9pbihkaXIsIFwiU0tJTEwubWRcIik7XG4gICAgICBpZiAoIWV4aXN0c1N5bmMoc2tpbGxGaWxlKSkgcmV0dXJuO1xuICAgICAgaXRlbXMucHVzaCh7XG4gICAgICAgIHR5cGU6IFwiY2xhdWRlLXNraWxsXCIsXG4gICAgICAgIG5hbWU6IGJhc2VuYW1lKGRpciksXG4gICAgICAgIHBhdGg6IGRpcixcbiAgICAgICAgc291cmNlOiBzb3VyY2UodG9vbCwgc2tpbGxGaWxlLCBcInVzZXJcIiksXG4gICAgICB9KTtcbiAgICB9LCA1KTtcbiAgfVxuXG4gIC8vIENsYXVkZSBwbHVnaW5zOiB+Ly5jbGF1ZGUvcGx1Z2lucy8qKi9wYWNrYWdlLmpzb25cbiAgY29uc3QgdXNlclBsdWdpbnNSb290ID0gam9pbihob21lLCBcIi5jbGF1ZGUvcGx1Z2luc1wiKTtcbiAgaWYgKGV4aXN0c1N5bmModXNlclBsdWdpbnNSb290KSkge1xuICAgIHdhbGtEaXJlY3Rvcmllcyh1c2VyUGx1Z2luc1Jvb3QsIChkaXIpID0+IHtcbiAgICAgIGNvbnN0IHBhY2thZ2VKc29uUGF0aCA9IGpvaW4oZGlyLCBcInBhY2thZ2UuanNvblwiKTtcbiAgICAgIGlmICghZXhpc3RzU3luYyhwYWNrYWdlSnNvblBhdGgpKSByZXR1cm47XG4gICAgICBsZXQgcGFja2FnZU5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHBrZyA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHBhY2thZ2VKc29uUGF0aCwgXCJ1dGY4XCIpKSBhcyB7IG5hbWU/OiBzdHJpbmcgfTtcbiAgICAgICAgcGFja2FnZU5hbWUgPSBwa2cubmFtZTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICBwYWNrYWdlTmFtZSA9IHVuZGVmaW5lZDtcbiAgICAgIH1cbiAgICAgIGl0ZW1zLnB1c2goe1xuICAgICAgICB0eXBlOiBcImNsYXVkZS1wbHVnaW5cIixcbiAgICAgICAgbmFtZTogcGFja2FnZU5hbWUgfHwgYmFzZW5hbWUoZGlyKSxcbiAgICAgICAgcGFja2FnZU5hbWUsXG4gICAgICAgIHBhdGg6IGRpcixcbiAgICAgICAgc291cmNlOiBzb3VyY2UodG9vbCwgcGFja2FnZUpzb25QYXRoLCBcInVzZXJcIiksXG4gICAgICB9KTtcbiAgICB9LCA0KTtcbiAgfVxuXG4gIC8vIFVzZXItbGV2ZWwgc2V0dGluZ3M6IH4vLmNsYXVkZS9zZXR0aW5ncy5qc29uXG4gIGNvbnN0IHVzZXJTZXR0aW5ncyA9IGpvaW4oaG9tZSwgXCIuY2xhdWRlL3NldHRpbmdzLmpzb25cIik7XG4gIGNvbnN0IHNldHRpbmdzQ29udGVudCA9IGF3YWl0IHJlYWRUZXh0RmlsZSh1c2VyU2V0dGluZ3MpO1xuICBpZiAoc2V0dGluZ3NDb250ZW50KSB7XG4gICAgY29uc3QganNvbiA9IHRyeVBhcnNlSnNvbjxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oc2V0dGluZ3NDb250ZW50KTtcbiAgICBpZiAoanNvbikge1xuICAgICAgaXRlbXMucHVzaCh7IHR5cGU6IFwic2V0dGluZ3NcIiwgZGF0YToganNvbiwgc291cmNlOiBzb3VyY2UodG9vbCwgdXNlclNldHRpbmdzLCBcInVzZXJcIikgfSk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHsgaXRlbXMsIHdhcm5pbmdzIH07XG59XG5cbi8vIC0tLS0tLS0tLS0gQ3Vyc29yIC0tLS0tLS0tLS1cblxuYXN5bmMgZnVuY3Rpb24gc2NhbkN1cnNvcihwcm9qZWN0Um9vdDogc3RyaW5nLCBob21lOiBzdHJpbmcsIHRvb2w6IFRvb2xJbmZvKTogUHJvbWlzZTx7IGl0ZW1zOiBEaXNjb3ZlcmVkSXRlbVtdOyB3YXJuaW5nczogc3RyaW5nW10gfT4ge1xuICBjb25zdCBpdGVtczogRGlzY292ZXJlZEl0ZW1bXSA9IFtdO1xuICBjb25zdCB3YXJuaW5nczogc3RyaW5nW10gPSBbXTtcblxuICAvLyBNQ1Agc2VydmVyczogfi8uY3Vyc29yL21jcC5qc29uIGFuZCAuY3Vyc29yL21jcC5qc29uXG4gIGZvciAoY29uc3QgeyBkaXIsIGxldmVsIH0gb2YgW1xuICAgIHsgZGlyOiBob21lLCBsZXZlbDogXCJ1c2VyXCIgYXMgQ29uZmlnTGV2ZWwgfSxcbiAgICB7IGRpcjogcHJvamVjdFJvb3QsIGxldmVsOiBcInByb2plY3RcIiBhcyBDb25maWdMZXZlbCB9LFxuICBdKSB7XG4gICAgY29uc3QgbWNwUGF0aCA9IGpvaW4oZGlyLCBcIi5jdXJzb3IvbWNwLmpzb25cIik7XG4gICAgY29uc3QgY29udGVudCA9IGF3YWl0IHJlYWRUZXh0RmlsZShtY3BQYXRoKTtcbiAgICBpZiAoY29udGVudCkge1xuICAgICAgY29uc3QganNvbiA9IHRyeVBhcnNlSnNvbjxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oY29udGVudCk7XG4gICAgICBpZiAoanNvbikgaXRlbXMucHVzaCguLi5wYXJzZU1jcFNlcnZlcnNGcm9tSnNvbihqc29uLCBtY3BQYXRoLCB0b29sLCBsZXZlbCkpO1xuICAgIH1cbiAgfVxuXG4gIC8vIFJ1bGVzOiAuY3Vyc29yL3J1bGVzLyoubWRjIGFuZCAuY3Vyc29yL3J1bGVzLyoubWRcbiAgY29uc3QgcHJvamVjdFJ1bGVzRGlyID0gam9pbihwcm9qZWN0Um9vdCwgXCIuY3Vyc29yL3J1bGVzXCIpO1xuICBjb25zdCBydWxlRmlsZXMgPSBhd2FpdCByZWFkRGlyU2FmZShwcm9qZWN0UnVsZXNEaXIpO1xuICBmb3IgKGNvbnN0IGZpbGUgb2YgcnVsZUZpbGVzKSB7XG4gICAgaWYgKCFmaWxlLmVuZHNXaXRoKFwiLm1kY1wiKSAmJiAhZmlsZS5lbmRzV2l0aChcIi5tZFwiKSkgY29udGludWU7XG4gICAgY29uc3QgZmlsZVBhdGggPSBqb2luKHByb2plY3RSdWxlc0RpciwgZmlsZSk7XG4gICAgY29uc3QgY29udGVudCA9IGF3YWl0IHJlYWRUZXh0RmlsZShmaWxlUGF0aCk7XG4gICAgaWYgKCFjb250ZW50KSBjb250aW51ZTtcblxuICAgIGNvbnN0IHsgZnJvbnRtYXR0ZXIsIGJvZHkgfSA9IHBhcnNlRnJvbnRtYXR0ZXIoY29udGVudCk7XG4gICAgaXRlbXMucHVzaCh7XG4gICAgICB0eXBlOiBcInJ1bGVcIixcbiAgICAgIG5hbWU6IGZpbGUucmVwbGFjZSgvXFwuKG1kY3xtZCkkLywgXCJcIiksXG4gICAgICBjb250ZW50OiBib2R5LFxuICAgICAgZ2xvYnM6IHR5cGVvZiBmcm9udG1hdHRlci5nbG9icyA9PT0gXCJzdHJpbmdcIiA/IFtmcm9udG1hdHRlci5nbG9ic10gOiB1bmRlZmluZWQsXG4gICAgICBhbHdheXNBcHBseTogZnJvbnRtYXR0ZXIuYWx3YXlzQXBwbHkgPT09IHRydWUsXG4gICAgICBkZXNjcmlwdGlvbjogdHlwZW9mIGZyb250bWF0dGVyLmRlc2NyaXB0aW9uID09PSBcInN0cmluZ1wiID8gZnJvbnRtYXR0ZXIuZGVzY3JpcHRpb24gOiB1bmRlZmluZWQsXG4gICAgICBzb3VyY2U6IHNvdXJjZSh0b29sLCBmaWxlUGF0aCwgXCJwcm9qZWN0XCIpLFxuICAgIH0pO1xuICB9XG5cbiAgLy8gTGVnYWN5OiAuY3Vyc29ycnVsZXMgKHJvb3QtbGV2ZWwgZmlsZSlcbiAgY29uc3QgbGVnYWN5UnVsZXNQYXRoID0gam9pbihwcm9qZWN0Um9vdCwgXCIuY3Vyc29ycnVsZXNcIik7XG4gIGNvbnN0IGxlZ2FjeUNvbnRlbnQgPSBhd2FpdCByZWFkVGV4dEZpbGUobGVnYWN5UnVsZXNQYXRoKTtcbiAgaWYgKGxlZ2FjeUNvbnRlbnQpIHtcbiAgICBpdGVtcy5wdXNoKHtcbiAgICAgIHR5cGU6IFwicnVsZVwiLFxuICAgICAgbmFtZTogXCJjdXJzb3JydWxlcyAobGVnYWN5KVwiLFxuICAgICAgY29udGVudDogbGVnYWN5Q29udGVudCxcbiAgICAgIGFsd2F5c0FwcGx5OiB0cnVlLFxuICAgICAgc291cmNlOiBzb3VyY2UodG9vbCwgbGVnYWN5UnVsZXNQYXRoLCBcInByb2plY3RcIiksXG4gICAgfSk7XG4gIH1cblxuICAvLyBTZXR0aW5nczogLmN1cnNvci9zZXR0aW5ncy5qc29uXG4gIGNvbnN0IHNldHRpbmdzUGF0aCA9IGpvaW4ocHJvamVjdFJvb3QsIFwiLmN1cnNvci9zZXR0aW5ncy5qc29uXCIpO1xuICBjb25zdCBzZXR0aW5nc0NvbnRlbnQgPSBhd2FpdCByZWFkVGV4dEZpbGUoc2V0dGluZ3NQYXRoKTtcbiAgaWYgKHNldHRpbmdzQ29udGVudCkge1xuICAgIGNvbnN0IGpzb24gPSB0cnlQYXJzZUpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KHNldHRpbmdzQ29udGVudCk7XG4gICAgaWYgKGpzb24pIGl0ZW1zLnB1c2goeyB0eXBlOiBcInNldHRpbmdzXCIsIGRhdGE6IGpzb24sIHNvdXJjZTogc291cmNlKHRvb2wsIHNldHRpbmdzUGF0aCwgXCJwcm9qZWN0XCIpIH0pO1xuICB9XG5cbiAgcmV0dXJuIHsgaXRlbXMsIHdhcm5pbmdzIH07XG59XG5cbi8vIC0tLS0tLS0tLS0gV2luZHN1cmYgLS0tLS0tLS0tLVxuXG5hc3luYyBmdW5jdGlvbiBzY2FuV2luZHN1cmYocHJvamVjdFJvb3Q6IHN0cmluZywgaG9tZTogc3RyaW5nLCB0b29sOiBUb29sSW5mbyk6IFByb21pc2U8eyBpdGVtczogRGlzY292ZXJlZEl0ZW1bXTsgd2FybmluZ3M6IHN0cmluZ1tdIH0+IHtcbiAgY29uc3QgaXRlbXM6IERpc2NvdmVyZWRJdGVtW10gPSBbXTtcbiAgY29uc3Qgd2FybmluZ3M6IHN0cmluZ1tdID0gW107XG5cbiAgLy8gTUNQIHNlcnZlcnM6IH4vLmNvZGVpdW0vd2luZHN1cmYvbWNwX2NvbmZpZy5qc29uIGFuZCAud2luZHN1cmYvbWNwX2NvbmZpZy5qc29uXG4gIGZvciAoY29uc3QgeyBwYXRoOiBtY3BQYXRoLCBsZXZlbCB9IG9mIFtcbiAgICB7IHBhdGg6IGpvaW4oaG9tZSwgXCIuY29kZWl1bS93aW5kc3VyZi9tY3BfY29uZmlnLmpzb25cIiksIGxldmVsOiBcInVzZXJcIiBhcyBDb25maWdMZXZlbCB9LFxuICAgIHsgcGF0aDogam9pbihwcm9qZWN0Um9vdCwgXCIud2luZHN1cmYvbWNwX2NvbmZpZy5qc29uXCIpLCBsZXZlbDogXCJwcm9qZWN0XCIgYXMgQ29uZmlnTGV2ZWwgfSxcbiAgXSkge1xuICAgIGNvbnN0IGNvbnRlbnQgPSBhd2FpdCByZWFkVGV4dEZpbGUobWNwUGF0aCk7XG4gICAgaWYgKGNvbnRlbnQpIHtcbiAgICAgIGNvbnN0IGpzb24gPSB0cnlQYXJzZUpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KGNvbnRlbnQpO1xuICAgICAgaWYgKGpzb24pIGl0ZW1zLnB1c2goLi4ucGFyc2VNY3BTZXJ2ZXJzRnJvbUpzb24oanNvbiwgbWNwUGF0aCwgdG9vbCwgbGV2ZWwpKTtcbiAgICB9XG4gIH1cblxuICAvLyBVc2VyIHJ1bGVzOiB+Ly5jb2RlaXVtL3dpbmRzdXJmL21lbW9yaWVzL2dsb2JhbF9ydWxlcy5tZFxuICBjb25zdCBnbG9iYWxSdWxlc1BhdGggPSBqb2luKGhvbWUsIFwiLmNvZGVpdW0vd2luZHN1cmYvbWVtb3JpZXMvZ2xvYmFsX3J1bGVzLm1kXCIpO1xuICBjb25zdCBnbG9iYWxSdWxlcyA9IGF3YWl0IHJlYWRUZXh0RmlsZShnbG9iYWxSdWxlc1BhdGgpO1xuICBpZiAoZ2xvYmFsUnVsZXMpIHtcbiAgICBpdGVtcy5wdXNoKHtcbiAgICAgIHR5cGU6IFwicnVsZVwiLFxuICAgICAgbmFtZTogXCJnbG9iYWxfcnVsZXNcIixcbiAgICAgIGNvbnRlbnQ6IGdsb2JhbFJ1bGVzLFxuICAgICAgYWx3YXlzQXBwbHk6IHRydWUsXG4gICAgICBzb3VyY2U6IHNvdXJjZSh0b29sLCBnbG9iYWxSdWxlc1BhdGgsIFwidXNlclwiKSxcbiAgICB9KTtcbiAgfVxuXG4gIC8vIFByb2plY3QgcnVsZXM6IC53aW5kc3VyZi9ydWxlcy8qLm1kXG4gIGNvbnN0IHJ1bGVzRGlyID0gam9pbihwcm9qZWN0Um9vdCwgXCIud2luZHN1cmYvcnVsZXNcIik7XG4gIGNvbnN0IHJ1bGVGaWxlcyA9IGF3YWl0IHJlYWREaXJTYWZlKHJ1bGVzRGlyKTtcbiAgZm9yIChjb25zdCBmaWxlIG9mIHJ1bGVGaWxlcykge1xuICAgIGlmICghZmlsZS5lbmRzV2l0aChcIi5tZFwiKSkgY29udGludWU7XG4gICAgY29uc3QgZmlsZVBhdGggPSBqb2luKHJ1bGVzRGlyLCBmaWxlKTtcbiAgICBjb25zdCBjb250ZW50ID0gYXdhaXQgcmVhZFRleHRGaWxlKGZpbGVQYXRoKTtcbiAgICBpZiAoIWNvbnRlbnQpIGNvbnRpbnVlO1xuICAgIGNvbnN0IHsgZnJvbnRtYXR0ZXIsIGJvZHkgfSA9IHBhcnNlRnJvbnRtYXR0ZXIoY29udGVudCk7XG4gICAgaXRlbXMucHVzaCh7XG4gICAgICB0eXBlOiBcInJ1bGVcIixcbiAgICAgIG5hbWU6IGZpbGUucmVwbGFjZSgvXFwubWQkLywgXCJcIiksXG4gICAgICBjb250ZW50OiBib2R5LFxuICAgICAgZGVzY3JpcHRpb246IHR5cGVvZiBmcm9udG1hdHRlci5kZXNjcmlwdGlvbiA9PT0gXCJzdHJpbmdcIiA/IGZyb250bWF0dGVyLmRlc2NyaXB0aW9uIDogdW5kZWZpbmVkLFxuICAgICAgc291cmNlOiBzb3VyY2UodG9vbCwgZmlsZVBhdGgsIFwicHJvamVjdFwiKSxcbiAgICB9KTtcbiAgfVxuXG4gIC8vIExlZ2FjeTogLndpbmRzdXJmcnVsZXNcbiAgY29uc3QgbGVnYWN5UGF0aCA9IGpvaW4ocHJvamVjdFJvb3QsIFwiLndpbmRzdXJmcnVsZXNcIik7XG4gIGNvbnN0IGxlZ2FjeUNvbnRlbnQgPSBhd2FpdCByZWFkVGV4dEZpbGUobGVnYWN5UGF0aCk7XG4gIGlmIChsZWdhY3lDb250ZW50KSB7XG4gICAgaXRlbXMucHVzaCh7XG4gICAgICB0eXBlOiBcInJ1bGVcIixcbiAgICAgIG5hbWU6IFwid2luZHN1cmZydWxlcyAobGVnYWN5KVwiLFxuICAgICAgY29udGVudDogbGVnYWN5Q29udGVudCxcbiAgICAgIGFsd2F5c0FwcGx5OiB0cnVlLFxuICAgICAgc291cmNlOiBzb3VyY2UodG9vbCwgbGVnYWN5UGF0aCwgXCJwcm9qZWN0XCIpLFxuICAgIH0pO1xuICB9XG5cbiAgcmV0dXJuIHsgaXRlbXMsIHdhcm5pbmdzIH07XG59XG5cbi8vIC0tLS0tLS0tLS0gR2VtaW5pIENMSSAtLS0tLS0tLS0tXG5cbmFzeW5jIGZ1bmN0aW9uIHNjYW5HZW1pbmkocHJvamVjdFJvb3Q6IHN0cmluZywgaG9tZTogc3RyaW5nLCB0b29sOiBUb29sSW5mbyk6IFByb21pc2U8eyBpdGVtczogRGlzY292ZXJlZEl0ZW1bXTsgd2FybmluZ3M6IHN0cmluZ1tdIH0+IHtcbiAgY29uc3QgaXRlbXM6IERpc2NvdmVyZWRJdGVtW10gPSBbXTtcbiAgY29uc3Qgd2FybmluZ3M6IHN0cmluZ1tdID0gW107XG5cbiAgLy8gTUNQIHNlcnZlcnM6IH4vLmdlbWluaS9zZXR0aW5ncy5qc29uIGFuZCAuZ2VtaW5pL3NldHRpbmdzLmpzb25cbiAgZm9yIChjb25zdCB7IHBhdGg6IHNldHRpbmdzUGF0aCwgbGV2ZWwgfSBvZiBbXG4gICAgeyBwYXRoOiBqb2luKGhvbWUsIFwiLmdlbWluaS9zZXR0aW5ncy5qc29uXCIpLCBsZXZlbDogXCJ1c2VyXCIgYXMgQ29uZmlnTGV2ZWwgfSxcbiAgICB7IHBhdGg6IGpvaW4ocHJvamVjdFJvb3QsIFwiLmdlbWluaS9zZXR0aW5ncy5qc29uXCIpLCBsZXZlbDogXCJwcm9qZWN0XCIgYXMgQ29uZmlnTGV2ZWwgfSxcbiAgXSkge1xuICAgIGNvbnN0IGNvbnRlbnQgPSBhd2FpdCByZWFkVGV4dEZpbGUoc2V0dGluZ3NQYXRoKTtcbiAgICBpZiAoY29udGVudCkge1xuICAgICAgY29uc3QganNvbiA9IHRyeVBhcnNlSnNvbjxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oY29udGVudCk7XG4gICAgICBpZiAoanNvbikge1xuICAgICAgICBpdGVtcy5wdXNoKC4uLnBhcnNlTWNwU2VydmVyc0Zyb21Kc29uKGpzb24sIHNldHRpbmdzUGF0aCwgdG9vbCwgbGV2ZWwpKTtcbiAgICAgICAgaXRlbXMucHVzaCh7IHR5cGU6IFwic2V0dGluZ3NcIiwgZGF0YToganNvbiwgc291cmNlOiBzb3VyY2UodG9vbCwgc2V0dGluZ3NQYXRoLCBsZXZlbCkgfSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gQ29udGV4dCBmaWxlczogfi8uZ2VtaW5pL0dFTUlOSS5tZCBhbmQgLmdlbWluaS9HRU1JTkkubWRcbiAgZm9yIChjb25zdCB7IHBhdGg6IG1kUGF0aCwgbGV2ZWwgfSBvZiBbXG4gICAgeyBwYXRoOiBqb2luKGhvbWUsIFwiLmdlbWluaS9HRU1JTkkubWRcIiksIGxldmVsOiBcInVzZXJcIiBhcyBDb25maWdMZXZlbCB9LFxuICAgIHsgcGF0aDogam9pbihwcm9qZWN0Um9vdCwgXCIuZ2VtaW5pL0dFTUlOSS5tZFwiKSwgbGV2ZWw6IFwicHJvamVjdFwiIGFzIENvbmZpZ0xldmVsIH0sXG4gIF0pIHtcbiAgICBjb25zdCBjb250ZW50ID0gYXdhaXQgcmVhZFRleHRGaWxlKG1kUGF0aCk7XG4gICAgaWYgKGNvbnRlbnQpIHtcbiAgICAgIGl0ZW1zLnB1c2goe1xuICAgICAgICB0eXBlOiBcImNvbnRleHQtZmlsZVwiLFxuICAgICAgICBuYW1lOiBgR0VNSU5JLm1kICgke2xldmVsfSlgLFxuICAgICAgICBjb250ZW50LFxuICAgICAgICBzb3VyY2U6IHNvdXJjZSh0b29sLCBtZFBhdGgsIGxldmVsKSxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiB7IGl0ZW1zLCB3YXJuaW5ncyB9O1xufVxuXG4vLyAtLS0tLS0tLS0tIENvZGV4IC0tLS0tLS0tLS1cblxuYXN5bmMgZnVuY3Rpb24gc2NhbkNvZGV4KHByb2plY3RSb290OiBzdHJpbmcsIGhvbWU6IHN0cmluZywgdG9vbDogVG9vbEluZm8pOiBQcm9taXNlPHsgaXRlbXM6IERpc2NvdmVyZWRJdGVtW107IHdhcm5pbmdzOiBzdHJpbmdbXSB9PiB7XG4gIGNvbnN0IGl0ZW1zOiBEaXNjb3ZlcmVkSXRlbVtdID0gW107XG4gIGNvbnN0IHdhcm5pbmdzOiBzdHJpbmdbXSA9IFtdO1xuXG4gIC8vIENvbnRleHQgZmlsZTogfi8uY29kZXgvQUdFTlRTLm1kXG4gIGNvbnN0IGFnZW50c01kUGF0aCA9IGpvaW4oaG9tZSwgXCIuY29kZXgvQUdFTlRTLm1kXCIpO1xuICBjb25zdCBhZ2VudHNNZCA9IGF3YWl0IHJlYWRUZXh0RmlsZShhZ2VudHNNZFBhdGgpO1xuICBpZiAoYWdlbnRzTWQpIHtcbiAgICBpdGVtcy5wdXNoKHtcbiAgICAgIHR5cGU6IFwiY29udGV4dC1maWxlXCIsXG4gICAgICBuYW1lOiBcIkFHRU5UUy5tZCAodXNlcilcIixcbiAgICAgIGNvbnRlbnQ6IGFnZW50c01kLFxuICAgICAgc291cmNlOiBzb3VyY2UodG9vbCwgYWdlbnRzTWRQYXRoLCBcInVzZXJcIiksXG4gICAgfSk7XG4gIH1cblxuICAvLyBQcm9qZWN0LWxldmVsOiBBR0VOVFMubWQgYXQgcm9vdCAoQ29kZXggY29udmVudGlvbilcbiAgY29uc3QgcHJvamVjdEFnZW50c01kID0gam9pbihwcm9qZWN0Um9vdCwgXCJBR0VOVFMubWRcIik7XG4gIGNvbnN0IHByb2plY3RDb250ZW50ID0gYXdhaXQgcmVhZFRleHRGaWxlKHByb2plY3RBZ2VudHNNZCk7XG4gIGlmIChwcm9qZWN0Q29udGVudCkge1xuICAgIGl0ZW1zLnB1c2goe1xuICAgICAgdHlwZTogXCJjb250ZXh0LWZpbGVcIixcbiAgICAgIG5hbWU6IFwiQUdFTlRTLm1kIChwcm9qZWN0KVwiLFxuICAgICAgY29udGVudDogcHJvamVjdENvbnRlbnQsXG4gICAgICBzb3VyY2U6IHNvdXJjZSh0b29sLCBwcm9qZWN0QWdlbnRzTWQsIFwicHJvamVjdFwiKSxcbiAgICB9KTtcbiAgfVxuXG4gIC8vIENvZGV4IHVzZXMgVE9NTCBmb3IgTUNQIGNvbmZpZyBcdTIwMTQgd2UgcGFyc2Ugb25seSB0aGUgSlNPTiBzdWJzZXRcbiAgLy8gKFRPTUwgcGFyc2luZyB3b3VsZCByZXF1aXJlIGEgZGVwZW5kZW5jeTsgc2tpcCBmb3Igbm93LCBsb2cgd2FybmluZylcbiAgZm9yIChjb25zdCB7IHBhdGg6IHRvbWxQYXRoLCBsZXZlbCB9IG9mIFtcbiAgICB7IHBhdGg6IGpvaW4oaG9tZSwgXCIuY29kZXgvY29uZmlnLnRvbWxcIiksIGxldmVsOiBcInVzZXJcIiBhcyBDb25maWdMZXZlbCB9LFxuICAgIHsgcGF0aDogam9pbihwcm9qZWN0Um9vdCwgXCIuY29kZXgvY29uZmlnLnRvbWxcIiksIGxldmVsOiBcInByb2plY3RcIiBhcyBDb25maWdMZXZlbCB9LFxuICBdKSB7XG4gICAgaWYgKGF3YWl0IGZpbGVFeGlzdHModG9tbFBhdGgpKSB7XG4gICAgICB3YXJuaW5ncy5wdXNoKGBGb3VuZCAke3RvbWxQYXRofSAoVE9NTCBjb25maWcpIFx1MjAxNCBNQ1Agc2VydmVyIHBhcnNpbmcgZnJvbSBUT01MIG5vdCB5ZXQgc3VwcG9ydGVkYCk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHsgaXRlbXMsIHdhcm5pbmdzIH07XG59XG5cbi8vIC0tLS0tLS0tLS0gQ2xpbmUgLS0tLS0tLS0tLVxuXG5hc3luYyBmdW5jdGlvbiBzY2FuQ2xpbmUocHJvamVjdFJvb3Q6IHN0cmluZywgX2hvbWU6IHN0cmluZywgdG9vbDogVG9vbEluZm8pOiBQcm9taXNlPHsgaXRlbXM6IERpc2NvdmVyZWRJdGVtW107IHdhcm5pbmdzOiBzdHJpbmdbXSB9PiB7XG4gIGNvbnN0IGl0ZW1zOiBEaXNjb3ZlcmVkSXRlbVtdID0gW107XG4gIGNvbnN0IHdhcm5pbmdzOiBzdHJpbmdbXSA9IFtdO1xuXG4gIGNvbnN0IGNsaW5lcnVsZXNQYXRoID0gam9pbihwcm9qZWN0Um9vdCwgXCIuY2xpbmVydWxlc1wiKTtcblxuICBpZiAoYXdhaXQgaXNEaXJlY3RvcnkoY2xpbmVydWxlc1BhdGgpKSB7XG4gICAgLy8gRGlyZWN0b3J5IGZvcm1hdDogLmNsaW5lcnVsZXMvKi5tZFxuICAgIGNvbnN0IGZpbGVzID0gYXdhaXQgcmVhZERpclNhZmUoY2xpbmVydWxlc1BhdGgpO1xuICAgIGZvciAoY29uc3QgZmlsZSBvZiBmaWxlcykge1xuICAgICAgaWYgKCFmaWxlLmVuZHNXaXRoKFwiLm1kXCIpKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IGZpbGVQYXRoID0gam9pbihjbGluZXJ1bGVzUGF0aCwgZmlsZSk7XG4gICAgICBjb25zdCBjb250ZW50ID0gYXdhaXQgcmVhZFRleHRGaWxlKGZpbGVQYXRoKTtcbiAgICAgIGlmICghY29udGVudCkgY29udGludWU7XG4gICAgICBjb25zdCB7IGJvZHkgfSA9IHBhcnNlRnJvbnRtYXR0ZXIoY29udGVudCk7XG4gICAgICBpdGVtcy5wdXNoKHtcbiAgICAgICAgdHlwZTogXCJydWxlXCIsXG4gICAgICAgIG5hbWU6IGZpbGUucmVwbGFjZSgvXFwubWQkLywgXCJcIiksXG4gICAgICAgIGNvbnRlbnQ6IGJvZHksXG4gICAgICAgIGFsd2F5c0FwcGx5OiB0cnVlLFxuICAgICAgICBzb3VyY2U6IHNvdXJjZSh0b29sLCBmaWxlUGF0aCwgXCJwcm9qZWN0XCIpLFxuICAgICAgfSk7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIC8vIFNpbmdsZSBmaWxlIGZvcm1hdFxuICAgIGNvbnN0IGNvbnRlbnQgPSBhd2FpdCByZWFkVGV4dEZpbGUoY2xpbmVydWxlc1BhdGgpO1xuICAgIGlmIChjb250ZW50KSB7XG4gICAgICBpdGVtcy5wdXNoKHtcbiAgICAgICAgdHlwZTogXCJydWxlXCIsXG4gICAgICAgIG5hbWU6IFwiY2xpbmVydWxlc1wiLFxuICAgICAgICBjb250ZW50LFxuICAgICAgICBhbHdheXNBcHBseTogdHJ1ZSxcbiAgICAgICAgc291cmNlOiBzb3VyY2UodG9vbCwgY2xpbmVydWxlc1BhdGgsIFwicHJvamVjdFwiKSxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuXG4gIC8vIENsaW5lIE1DUDogLmNsaW5lL21jcF9zZXR0aW5ncy5qc29uIChWUyBDb2RlIGV4dGVuc2lvbiBzdG9yZXMgTUNQIGhlcmUpXG4gIGNvbnN0IGNsaW5lTWNwUGF0aCA9IGpvaW4ocHJvamVjdFJvb3QsIFwiLmNsaW5lL21jcF9zZXR0aW5ncy5qc29uXCIpO1xuICBjb25zdCBjbGluZU1jcENvbnRlbnQgPSBhd2FpdCByZWFkVGV4dEZpbGUoY2xpbmVNY3BQYXRoKTtcbiAgaWYgKGNsaW5lTWNwQ29udGVudCkge1xuICAgIGNvbnN0IGpzb24gPSB0cnlQYXJzZUpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KGNsaW5lTWNwQ29udGVudCk7XG4gICAgaWYgKGpzb24pIGl0ZW1zLnB1c2goLi4ucGFyc2VNY3BTZXJ2ZXJzRnJvbUpzb24oanNvbiwgY2xpbmVNY3BQYXRoLCB0b29sLCBcInByb2plY3RcIikpO1xuICB9XG5cbiAgcmV0dXJuIHsgaXRlbXMsIHdhcm5pbmdzIH07XG59XG5cbi8vIC0tLS0tLS0tLS0gR2l0SHViIENvcGlsb3QgLS0tLS0tLS0tLVxuXG5hc3luYyBmdW5jdGlvbiBzY2FuR2l0aHViQ29waWxvdChwcm9qZWN0Um9vdDogc3RyaW5nLCBfaG9tZTogc3RyaW5nLCB0b29sOiBUb29sSW5mbyk6IFByb21pc2U8eyBpdGVtczogRGlzY292ZXJlZEl0ZW1bXTsgd2FybmluZ3M6IHN0cmluZ1tdIH0+IHtcbiAgY29uc3QgaXRlbXM6IERpc2NvdmVyZWRJdGVtW10gPSBbXTtcbiAgY29uc3Qgd2FybmluZ3M6IHN0cmluZ1tdID0gW107XG5cbiAgLy8gQ29udGV4dCBmaWxlOiAuZ2l0aHViL2NvcGlsb3QtaW5zdHJ1Y3Rpb25zLm1kXG4gIGNvbnN0IGluc3RydWN0aW9uc1BhdGggPSBqb2luKHByb2plY3RSb290LCBcIi5naXRodWIvY29waWxvdC1pbnN0cnVjdGlvbnMubWRcIik7XG4gIGNvbnN0IGluc3RydWN0aW9ucyA9IGF3YWl0IHJlYWRUZXh0RmlsZShpbnN0cnVjdGlvbnNQYXRoKTtcbiAgaWYgKGluc3RydWN0aW9ucykge1xuICAgIGl0ZW1zLnB1c2goe1xuICAgICAgdHlwZTogXCJjb250ZXh0LWZpbGVcIixcbiAgICAgIG5hbWU6IFwiY29waWxvdC1pbnN0cnVjdGlvbnMubWRcIixcbiAgICAgIGNvbnRlbnQ6IGluc3RydWN0aW9ucyxcbiAgICAgIHNvdXJjZTogc291cmNlKHRvb2wsIGluc3RydWN0aW9uc1BhdGgsIFwicHJvamVjdFwiKSxcbiAgICB9KTtcbiAgfVxuXG4gIC8vIEluc3RydWN0aW9uczogLmdpdGh1Yi9pbnN0cnVjdGlvbnMvKi5pbnN0cnVjdGlvbnMubWRcbiAgY29uc3QgaW5zdHJ1Y3Rpb25zRGlyID0gam9pbihwcm9qZWN0Um9vdCwgXCIuZ2l0aHViL2luc3RydWN0aW9uc1wiKTtcbiAgY29uc3QgaW5zdHJGaWxlcyA9IGF3YWl0IHJlYWREaXJTYWZlKGluc3RydWN0aW9uc0Rpcik7XG4gIGZvciAoY29uc3QgZmlsZSBvZiBpbnN0ckZpbGVzKSB7XG4gICAgaWYgKCFmaWxlLmVuZHNXaXRoKFwiLmluc3RydWN0aW9ucy5tZFwiKSkgY29udGludWU7XG4gICAgY29uc3QgZmlsZVBhdGggPSBqb2luKGluc3RydWN0aW9uc0RpciwgZmlsZSk7XG4gICAgY29uc3QgY29udGVudCA9IGF3YWl0IHJlYWRUZXh0RmlsZShmaWxlUGF0aCk7XG4gICAgaWYgKCFjb250ZW50KSBjb250aW51ZTtcbiAgICBjb25zdCB7IGZyb250bWF0dGVyLCBib2R5IH0gPSBwYXJzZUZyb250bWF0dGVyKGNvbnRlbnQpO1xuICAgIGNvbnN0IGFwcGx5VG8gPSB0eXBlb2YgZnJvbnRtYXR0ZXIuYXBwbHlUbyA9PT0gXCJzdHJpbmdcIiA/IGZyb250bWF0dGVyLmFwcGx5VG8gOiB1bmRlZmluZWQ7XG4gICAgaXRlbXMucHVzaCh7XG4gICAgICB0eXBlOiBcInJ1bGVcIixcbiAgICAgIG5hbWU6IGZpbGUucmVwbGFjZShcIi5pbnN0cnVjdGlvbnMubWRcIiwgXCJcIiksXG4gICAgICBjb250ZW50OiBib2R5LFxuICAgICAgZ2xvYnM6IGFwcGx5VG8gPyBbYXBwbHlUb10gOiB1bmRlZmluZWQsXG4gICAgICBkZXNjcmlwdGlvbjogYEdpdEh1YiBDb3BpbG90IGluc3RydWN0aW9uJHthcHBseVRvID8gYCAoYXBwbGllcyB0bzogJHthcHBseVRvfSlgIDogXCJcIn1gLFxuICAgICAgc291cmNlOiBzb3VyY2UodG9vbCwgZmlsZVBhdGgsIFwicHJvamVjdFwiKSxcbiAgICB9KTtcbiAgfVxuXG4gIHJldHVybiB7IGl0ZW1zLCB3YXJuaW5ncyB9O1xufVxuXG4vLyAtLS0tLS0tLS0tIFZTIENvZGUgLS0tLS0tLS0tLVxuXG5hc3luYyBmdW5jdGlvbiBzY2FuVlNDb2RlKHByb2plY3RSb290OiBzdHJpbmcsIF9ob21lOiBzdHJpbmcsIHRvb2w6IFRvb2xJbmZvKTogUHJvbWlzZTx7IGl0ZW1zOiBEaXNjb3ZlcmVkSXRlbVtdOyB3YXJuaW5nczogc3RyaW5nW10gfT4ge1xuICBjb25zdCBpdGVtczogRGlzY292ZXJlZEl0ZW1bXSA9IFtdO1xuICBjb25zdCB3YXJuaW5nczogc3RyaW5nW10gPSBbXTtcblxuICAvLyBTZXR0aW5nczogLnZzY29kZS9zZXR0aW5ncy5qc29uIChtYXkgY29udGFpbiBNQ1Agc2VydmVycyBhbmQgQUkgc2V0dGluZ3MpXG4gIGNvbnN0IHNldHRpbmdzUGF0aCA9IGpvaW4ocHJvamVjdFJvb3QsIFwiLnZzY29kZS9zZXR0aW5ncy5qc29uXCIpO1xuICBjb25zdCBzZXR0aW5nc0NvbnRlbnQgPSBhd2FpdCByZWFkVGV4dEZpbGUoc2V0dGluZ3NQYXRoKTtcbiAgaWYgKHNldHRpbmdzQ29udGVudCkge1xuICAgIGNvbnN0IGpzb24gPSB0cnlQYXJzZUpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KHNldHRpbmdzQ29udGVudCk7XG4gICAgaWYgKGpzb24pIHtcbiAgICAgIGl0ZW1zLnB1c2goeyB0eXBlOiBcInNldHRpbmdzXCIsIGRhdGE6IGpzb24sIHNvdXJjZTogc291cmNlKHRvb2wsIHNldHRpbmdzUGF0aCwgXCJwcm9qZWN0XCIpIH0pO1xuXG4gICAgICAvLyBWUyBDb2RlIE1DUCBzZXJ2ZXJzOiBsb29rIGZvciBtY3AtcmVsYXRlZCBrZXlzXG4gICAgICAvLyBGb3JtYXQgdmFyaWVzOiBcIm1jcC5zZXJ2ZXJzXCIsIFwibWNwU2VydmVyc1wiLCBldGMuXG4gICAgICBjb25zdCBtY3BTZXJ2ZXJzID0gKGpzb25bXCJtY3Auc2VydmVyc1wiXSA/PyBqc29uLm1jcFNlcnZlcnMgPz8gKGpzb24ubWNwIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KT8uc2VydmVycykgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQ7XG4gICAgICBpZiAobWNwU2VydmVycyAmJiB0eXBlb2YgbWNwU2VydmVycyA9PT0gXCJvYmplY3RcIikge1xuICAgICAgICBpdGVtcy5wdXNoKC4uLnBhcnNlTWNwU2VydmVyc0Zyb21Kc29uKHsgbWNwU2VydmVycyB9LCBzZXR0aW5nc1BhdGgsIHRvb2wsIFwicHJvamVjdFwiKSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gVlMgQ29kZSBNQ1AgY29uZmlnOiAudnNjb2RlL21jcC5qc29uXG4gIGNvbnN0IG1jcFBhdGggPSBqb2luKHByb2plY3RSb290LCBcIi52c2NvZGUvbWNwLmpzb25cIik7XG4gIGNvbnN0IG1jcENvbnRlbnQgPSBhd2FpdCByZWFkVGV4dEZpbGUobWNwUGF0aCk7XG4gIGlmIChtY3BDb250ZW50KSB7XG4gICAgY29uc3QganNvbiA9IHRyeVBhcnNlSnNvbjxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4obWNwQ29udGVudCk7XG4gICAgaWYgKGpzb24pIHtcbiAgICAgIC8vIFZTIENvZGUgdXNlcyB7IHNlcnZlcnM6IHsgLi4uIH0gfSBvciB7IG1jcFNlcnZlcnM6IHsgLi4uIH0gfVxuICAgICAgY29uc3Qgc2VydmVycyA9IChqc29uLnNlcnZlcnMgPz8ganNvbi5tY3BTZXJ2ZXJzKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZDtcbiAgICAgIGlmIChzZXJ2ZXJzICYmIHR5cGVvZiBzZXJ2ZXJzID09PSBcIm9iamVjdFwiKSB7XG4gICAgICAgIGl0ZW1zLnB1c2goLi4ucGFyc2VNY3BTZXJ2ZXJzRnJvbUpzb24oeyBtY3BTZXJ2ZXJzOiBzZXJ2ZXJzIH0sIG1jcFBhdGgsIHRvb2wsIFwicHJvamVjdFwiKSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHsgaXRlbXMsIHdhcm5pbmdzIH07XG59XG5cbi8vIFx1MjUwMFx1MjUwMCBTY2FubmVyIHJlZ2lzdHJ5IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgY29uc3QgU0NBTk5FUlM6IFJlY29yZDxUb29sSWQsIFNjYW5uZXI+ID0ge1xuICBjbGF1ZGU6IHNjYW5DbGF1ZGUsXG4gIGN1cnNvcjogc2NhbkN1cnNvcixcbiAgd2luZHN1cmY6IHNjYW5XaW5kc3VyZixcbiAgZ2VtaW5pOiBzY2FuR2VtaW5pLFxuICBjb2RleDogc2NhbkNvZGV4LFxuICBjbGluZTogc2NhbkNsaW5lLFxuICBcImdpdGh1Yi1jb3BpbG90XCI6IHNjYW5HaXRodWJDb3BpbG90LFxuICB2c2NvZGU6IHNjYW5WU0NvZGUsXG59O1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBU0EsU0FBUyxVQUFVLFNBQVMsWUFBWTtBQUN4QyxTQUFTLFlBQVksYUFBYSxvQkFBb0I7QUFDdEQsU0FBUyxNQUFNLGdCQUF5QjtBQWlCeEMsU0FBUyxPQUFPLE1BQWdCLE1BQWMsT0FBa0M7QUFDOUUsU0FBTyxFQUFFLE1BQU0sS0FBSyxJQUFJLFVBQVUsS0FBSyxNQUFNLE1BQU0sTUFBTTtBQUMzRDtBQUVBLFNBQVMsZ0JBQWdCLE1BQWMsT0FBNkMsV0FBVyxHQUFTO0FBQ3RHLFFBQU0sT0FBTyxvQkFBSSxJQUFJLENBQUMsUUFBUSxnQkFBZ0IsY0FBYyxRQUFRLFNBQVMsU0FBUyxRQUFRLENBQUM7QUFFL0YsV0FBUyxLQUFLLEtBQWEsT0FBZTtBQUN4QyxVQUFNLEtBQUssS0FBSztBQUNoQixRQUFJLFNBQVMsU0FBVTtBQUV2QixRQUFJLFVBQStELENBQUM7QUFDcEUsUUFBSTtBQUNGLGdCQUFVLFlBQVksS0FBSyxFQUFFLGVBQWUsS0FBSyxDQUFDO0FBQUEsSUFDcEQsUUFBUTtBQUNOO0FBQUEsSUFDRjtBQUVBLGVBQVcsU0FBUyxTQUFTO0FBQzNCLFVBQUksQ0FBQyxNQUFNLFlBQVksRUFBRztBQUMxQixVQUFJLEtBQUssSUFBSSxNQUFNLElBQUksRUFBRztBQUMxQixXQUFLLEtBQUssS0FBSyxNQUFNLElBQUksR0FBRyxRQUFRLENBQUM7QUFBQSxJQUN2QztBQUFBLEVBQ0Y7QUFFQSxPQUFLLE1BQU0sQ0FBQztBQUNkO0FBRUEsZUFBZSxhQUFhLE1BQXNDO0FBQ2hFLE1BQUk7QUFDRixXQUFPLE1BQU0sU0FBUyxNQUFNLE1BQU07QUFBQSxFQUNwQyxRQUFRO0FBQ04sV0FBTztBQUFBLEVBQ1Q7QUFDRjtBQUVBLFNBQVMsYUFBZ0IsU0FBMkI7QUFDbEQsTUFBSTtBQUNGLFdBQU8sS0FBSyxNQUFNLE9BQU87QUFBQSxFQUMzQixRQUFRO0FBQ04sV0FBTztBQUFBLEVBQ1Q7QUFDRjtBQUVBLGVBQWUsV0FBVyxNQUFnQztBQUN4RCxNQUFJO0FBQ0YsVUFBTSxLQUFLLElBQUk7QUFDZixXQUFPO0FBQUEsRUFDVCxRQUFRO0FBQ04sV0FBTztBQUFBLEVBQ1Q7QUFDRjtBQUVBLGVBQWUsWUFBWSxNQUFnQztBQUN6RCxNQUFJO0FBQ0YsVUFBTSxJQUFJLE1BQU0sS0FBSyxJQUFJO0FBQ3pCLFdBQU8sRUFBRSxZQUFZO0FBQUEsRUFDdkIsUUFBUTtBQUNOLFdBQU87QUFBQSxFQUNUO0FBQ0Y7QUFFQSxlQUFlLFlBQVksS0FBZ0M7QUFDekQsTUFBSTtBQUNGLFdBQU8sTUFBTSxRQUFRLEdBQUc7QUFBQSxFQUMxQixRQUFRO0FBQ04sV0FBTyxDQUFDO0FBQUEsRUFDVjtBQUNGO0FBTUEsU0FBUyxpQkFBaUIsU0FBeUU7QUFDakcsUUFBTSxRQUFRLFFBQVEsTUFBTSx5Q0FBeUM7QUFDckUsTUFBSSxDQUFDLE9BQU87QUFDVixXQUFPLEVBQUUsYUFBYSxDQUFDLEdBQUcsTUFBTSxRQUFRO0FBQUEsRUFDMUM7QUFFQSxRQUFNLFFBQVEsTUFBTSxDQUFDLEtBQUs7QUFDMUIsUUFBTSxPQUFPLE1BQU0sQ0FBQyxLQUFLO0FBQ3pCLFFBQU0sY0FBdUMsQ0FBQztBQUU5QyxhQUFXLFFBQVEsTUFBTSxNQUFNLElBQUksR0FBRztBQUNwQyxVQUFNLFdBQVcsS0FBSyxRQUFRLEdBQUc7QUFDakMsUUFBSSxhQUFhLEdBQUk7QUFDckIsVUFBTSxNQUFNLEtBQUssTUFBTSxHQUFHLFFBQVEsRUFBRSxLQUFLO0FBQ3pDLFFBQUksUUFBaUIsS0FBSyxNQUFNLFdBQVcsQ0FBQyxFQUFFLEtBQUs7QUFHbkQsUUFBSSxPQUFPLFVBQVUsWUFBWSxlQUFlLEtBQUssS0FBSyxHQUFHO0FBQzNELGNBQVEsTUFBTSxNQUFNLEdBQUcsRUFBRTtBQUFBLElBQzNCO0FBR0EsUUFBSSxVQUFVLE9BQVEsU0FBUTtBQUFBLGFBQ3JCLFVBQVUsUUFBUyxTQUFRO0FBQUEsYUFDM0IsT0FBTyxVQUFVLFlBQVksUUFBUSxLQUFLLEtBQUssRUFBRyxTQUFRLFNBQVMsT0FBTyxFQUFFO0FBRXJGLGdCQUFZLEdBQUcsSUFBSTtBQUFBLEVBQ3JCO0FBRUEsU0FBTyxFQUFFLGFBQWEsS0FBSztBQUM3QjtBQU1BLFNBQVMsd0JBQ1AsTUFDQSxVQUNBLE1BQ0EsT0FDdUI7QUFDdkIsUUFBTSxVQUFpQyxDQUFDO0FBQ3hDLFFBQU0sYUFBYSxLQUFLO0FBQ3hCLE1BQUksQ0FBQyxjQUFjLE9BQU8sZUFBZSxTQUFVLFFBQU87QUFFMUQsYUFBVyxDQUFDLE1BQU0sTUFBTSxLQUFLLE9BQU8sUUFBUSxVQUFVLEdBQUc7QUFDdkQsUUFBSSxDQUFDLFVBQVUsT0FBTyxXQUFXLFNBQVU7QUFDM0MsVUFBTSxJQUFJO0FBQ1YsWUFBUSxLQUFLO0FBQUEsTUFDWCxNQUFNO0FBQUEsTUFDTjtBQUFBLE1BQ0EsU0FBUyxPQUFPLEVBQUUsWUFBWSxXQUFXLEVBQUUsVUFBVTtBQUFBLE1BQ3JELE1BQU0sTUFBTSxRQUFRLEVBQUUsSUFBSSxJQUFLLEVBQUUsT0FBb0I7QUFBQSxNQUNyRCxLQUFLLEVBQUUsT0FBTyxPQUFPLEVBQUUsUUFBUSxXQUFZLEVBQUUsTUFBaUM7QUFBQSxNQUM5RSxLQUFLLE9BQU8sRUFBRSxRQUFRLFdBQVcsRUFBRSxNQUFNO0FBQUEsTUFDekMsV0FBVyxDQUFDLFNBQVMsT0FBTyxNQUFNLEVBQUUsU0FBUyxFQUFFLElBQWMsSUFDeEQsRUFBRSxPQUNIO0FBQUEsTUFDSixRQUFRLE9BQU8sTUFBTSxVQUFVLEtBQUs7QUFBQSxJQUN0QyxDQUFDO0FBQUEsRUFDSDtBQUNBLFNBQU87QUFDVDtBQVFBLGVBQWUsV0FBVyxhQUFxQixNQUFjLE1BQTBFO0FBQ3JJLFFBQU0sUUFBMEIsQ0FBQztBQUNqQyxRQUFNLFdBQXFCLENBQUM7QUFHNUIsYUFBVyxXQUFXLENBQUMsZ0JBQWdCLGtCQUFrQixHQUFHO0FBQzFELFVBQU0sV0FBVyxLQUFLLE1BQU0sT0FBTztBQUNuQyxVQUFNLFVBQVUsTUFBTSxhQUFhLFFBQVE7QUFDM0MsUUFBSSxTQUFTO0FBQ1gsWUFBTSxPQUFPLGFBQXNDLE9BQU87QUFDMUQsVUFBSSxNQUFNO0FBQ1IsY0FBTSxVQUFVLHdCQUF3QixNQUFNLFVBQVUsTUFBTSxNQUFNO0FBQ3BFLFlBQUksUUFBUSxTQUFTLEdBQUc7QUFDdEIsZ0JBQU0sS0FBSyxHQUFHLE9BQU87QUFDckI7QUFBQSxRQUNGO0FBQUEsTUFDRjtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBR0EsYUFBVyxXQUFXLENBQUMsYUFBYSxxQkFBcUIsa0JBQWtCLEdBQUc7QUFDNUUsVUFBTSxXQUFXLEtBQUssYUFBYSxPQUFPO0FBQzFDLFVBQU0sVUFBVSxNQUFNLGFBQWEsUUFBUTtBQUMzQyxRQUFJLFNBQVM7QUFDWCxZQUFNLE9BQU8sYUFBc0MsT0FBTztBQUMxRCxVQUFJLE1BQU07QUFDUixjQUFNLFVBQVUsd0JBQXdCLE1BQU0sVUFBVSxNQUFNLFNBQVM7QUFDdkUsWUFBSSxRQUFRLFNBQVMsR0FBRztBQUN0QixnQkFBTSxLQUFLLEdBQUcsT0FBTztBQUNyQjtBQUFBLFFBQ0Y7QUFBQSxNQUNGO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFHQSxRQUFNLGVBQWUsS0FBSyxNQUFNLG1CQUFtQjtBQUNuRCxRQUFNLGdCQUFnQixNQUFNLGFBQWEsWUFBWTtBQUNyRCxNQUFJLGVBQWU7QUFDakIsVUFBTSxLQUFLO0FBQUEsTUFDVCxNQUFNO0FBQUEsTUFDTixNQUFNO0FBQUEsTUFDTixTQUFTO0FBQUEsTUFDVCxRQUFRLE9BQU8sTUFBTSxjQUFjLE1BQU07QUFBQSxJQUMzQyxDQUFDO0FBQUEsRUFDSDtBQUdBLGFBQVcsV0FBVyxDQUFDLGFBQWEsbUJBQW1CLEdBQUc7QUFDeEQsVUFBTSxXQUFXLEtBQUssYUFBYSxPQUFPO0FBQzFDLFVBQU0sVUFBVSxNQUFNLGFBQWEsUUFBUTtBQUMzQyxRQUFJLFNBQVM7QUFDWCxZQUFNLEtBQUs7QUFBQSxRQUNULE1BQU07QUFBQSxRQUNOLE1BQU0sR0FBRyxPQUFPO0FBQUEsUUFDaEI7QUFBQSxRQUNBLFFBQVEsT0FBTyxNQUFNLFVBQVUsU0FBUztBQUFBLE1BQzFDLENBQUM7QUFBQSxJQUNIO0FBQUEsRUFDRjtBQUdBLFFBQU0saUJBQWlCLEtBQUssTUFBTSxnQkFBZ0I7QUFDbEQsTUFBSSxXQUFXLGNBQWMsR0FBRztBQUM5QixvQkFBZ0IsZ0JBQWdCLENBQUMsUUFBUTtBQUN2QyxZQUFNLFlBQVksS0FBSyxLQUFLLFVBQVU7QUFDdEMsVUFBSSxDQUFDLFdBQVcsU0FBUyxFQUFHO0FBQzVCLFlBQU0sS0FBSztBQUFBLFFBQ1QsTUFBTTtBQUFBLFFBQ04sTUFBTSxTQUFTLEdBQUc7QUFBQSxRQUNsQixNQUFNO0FBQUEsUUFDTixRQUFRLE9BQU8sTUFBTSxXQUFXLE1BQU07QUFBQSxNQUN4QyxDQUFDO0FBQUEsSUFDSCxHQUFHLENBQUM7QUFBQSxFQUNOO0FBR0EsUUFBTSxrQkFBa0IsS0FBSyxNQUFNLGlCQUFpQjtBQUNwRCxNQUFJLFdBQVcsZUFBZSxHQUFHO0FBQy9CLG9CQUFnQixpQkFBaUIsQ0FBQyxRQUFRO0FBQ3hDLFlBQU0sa0JBQWtCLEtBQUssS0FBSyxjQUFjO0FBQ2hELFVBQUksQ0FBQyxXQUFXLGVBQWUsRUFBRztBQUNsQyxVQUFJO0FBQ0osVUFBSTtBQUNGLGNBQU0sTUFBTSxLQUFLLE1BQU0sYUFBYSxpQkFBaUIsTUFBTSxDQUFDO0FBQzVELHNCQUFjLElBQUk7QUFBQSxNQUNwQixRQUFRO0FBQ04sc0JBQWM7QUFBQSxNQUNoQjtBQUNBLFlBQU0sS0FBSztBQUFBLFFBQ1QsTUFBTTtBQUFBLFFBQ04sTUFBTSxlQUFlLFNBQVMsR0FBRztBQUFBLFFBQ2pDO0FBQUEsUUFDQSxNQUFNO0FBQUEsUUFDTixRQUFRLE9BQU8sTUFBTSxpQkFBaUIsTUFBTTtBQUFBLE1BQzlDLENBQUM7QUFBQSxJQUNILEdBQUcsQ0FBQztBQUFBLEVBQ047QUFHQSxRQUFNLGVBQWUsS0FBSyxNQUFNLHVCQUF1QjtBQUN2RCxRQUFNLGtCQUFrQixNQUFNLGFBQWEsWUFBWTtBQUN2RCxNQUFJLGlCQUFpQjtBQUNuQixVQUFNLE9BQU8sYUFBc0MsZUFBZTtBQUNsRSxRQUFJLE1BQU07QUFDUixZQUFNLEtBQUssRUFBRSxNQUFNLFlBQVksTUFBTSxNQUFNLFFBQVEsT0FBTyxNQUFNLGNBQWMsTUFBTSxFQUFFLENBQUM7QUFBQSxJQUN6RjtBQUFBLEVBQ0Y7QUFFQSxTQUFPLEVBQUUsT0FBTyxTQUFTO0FBQzNCO0FBSUEsZUFBZSxXQUFXLGFBQXFCLE1BQWMsTUFBMEU7QUFDckksUUFBTSxRQUEwQixDQUFDO0FBQ2pDLFFBQU0sV0FBcUIsQ0FBQztBQUc1QixhQUFXLEVBQUUsS0FBSyxNQUFNLEtBQUs7QUFBQSxJQUMzQixFQUFFLEtBQUssTUFBTSxPQUFPLE9BQXNCO0FBQUEsSUFDMUMsRUFBRSxLQUFLLGFBQWEsT0FBTyxVQUF5QjtBQUFBLEVBQ3RELEdBQUc7QUFDRCxVQUFNLFVBQVUsS0FBSyxLQUFLLGtCQUFrQjtBQUM1QyxVQUFNLFVBQVUsTUFBTSxhQUFhLE9BQU87QUFDMUMsUUFBSSxTQUFTO0FBQ1gsWUFBTSxPQUFPLGFBQXNDLE9BQU87QUFDMUQsVUFBSSxLQUFNLE9BQU0sS0FBSyxHQUFHLHdCQUF3QixNQUFNLFNBQVMsTUFBTSxLQUFLLENBQUM7QUFBQSxJQUM3RTtBQUFBLEVBQ0Y7QUFHQSxRQUFNLGtCQUFrQixLQUFLLGFBQWEsZUFBZTtBQUN6RCxRQUFNLFlBQVksTUFBTSxZQUFZLGVBQWU7QUFDbkQsYUFBVyxRQUFRLFdBQVc7QUFDNUIsUUFBSSxDQUFDLEtBQUssU0FBUyxNQUFNLEtBQUssQ0FBQyxLQUFLLFNBQVMsS0FBSyxFQUFHO0FBQ3JELFVBQU0sV0FBVyxLQUFLLGlCQUFpQixJQUFJO0FBQzNDLFVBQU0sVUFBVSxNQUFNLGFBQWEsUUFBUTtBQUMzQyxRQUFJLENBQUMsUUFBUztBQUVkLFVBQU0sRUFBRSxhQUFhLEtBQUssSUFBSSxpQkFBaUIsT0FBTztBQUN0RCxVQUFNLEtBQUs7QUFBQSxNQUNULE1BQU07QUFBQSxNQUNOLE1BQU0sS0FBSyxRQUFRLGVBQWUsRUFBRTtBQUFBLE1BQ3BDLFNBQVM7QUFBQSxNQUNULE9BQU8sT0FBTyxZQUFZLFVBQVUsV0FBVyxDQUFDLFlBQVksS0FBSyxJQUFJO0FBQUEsTUFDckUsYUFBYSxZQUFZLGdCQUFnQjtBQUFBLE1BQ3pDLGFBQWEsT0FBTyxZQUFZLGdCQUFnQixXQUFXLFlBQVksY0FBYztBQUFBLE1BQ3JGLFFBQVEsT0FBTyxNQUFNLFVBQVUsU0FBUztBQUFBLElBQzFDLENBQUM7QUFBQSxFQUNIO0FBR0EsUUFBTSxrQkFBa0IsS0FBSyxhQUFhLGNBQWM7QUFDeEQsUUFBTSxnQkFBZ0IsTUFBTSxhQUFhLGVBQWU7QUFDeEQsTUFBSSxlQUFlO0FBQ2pCLFVBQU0sS0FBSztBQUFBLE1BQ1QsTUFBTTtBQUFBLE1BQ04sTUFBTTtBQUFBLE1BQ04sU0FBUztBQUFBLE1BQ1QsYUFBYTtBQUFBLE1BQ2IsUUFBUSxPQUFPLE1BQU0saUJBQWlCLFNBQVM7QUFBQSxJQUNqRCxDQUFDO0FBQUEsRUFDSDtBQUdBLFFBQU0sZUFBZSxLQUFLLGFBQWEsdUJBQXVCO0FBQzlELFFBQU0sa0JBQWtCLE1BQU0sYUFBYSxZQUFZO0FBQ3ZELE1BQUksaUJBQWlCO0FBQ25CLFVBQU0sT0FBTyxhQUFzQyxlQUFlO0FBQ2xFLFFBQUksS0FBTSxPQUFNLEtBQUssRUFBRSxNQUFNLFlBQVksTUFBTSxNQUFNLFFBQVEsT0FBTyxNQUFNLGNBQWMsU0FBUyxFQUFFLENBQUM7QUFBQSxFQUN0RztBQUVBLFNBQU8sRUFBRSxPQUFPLFNBQVM7QUFDM0I7QUFJQSxlQUFlLGFBQWEsYUFBcUIsTUFBYyxNQUEwRTtBQUN2SSxRQUFNLFFBQTBCLENBQUM7QUFDakMsUUFBTSxXQUFxQixDQUFDO0FBRzVCLGFBQVcsRUFBRSxNQUFNLFNBQVMsTUFBTSxLQUFLO0FBQUEsSUFDckMsRUFBRSxNQUFNLEtBQUssTUFBTSxtQ0FBbUMsR0FBRyxPQUFPLE9BQXNCO0FBQUEsSUFDdEYsRUFBRSxNQUFNLEtBQUssYUFBYSwyQkFBMkIsR0FBRyxPQUFPLFVBQXlCO0FBQUEsRUFDMUYsR0FBRztBQUNELFVBQU0sVUFBVSxNQUFNLGFBQWEsT0FBTztBQUMxQyxRQUFJLFNBQVM7QUFDWCxZQUFNLE9BQU8sYUFBc0MsT0FBTztBQUMxRCxVQUFJLEtBQU0sT0FBTSxLQUFLLEdBQUcsd0JBQXdCLE1BQU0sU0FBUyxNQUFNLEtBQUssQ0FBQztBQUFBLElBQzdFO0FBQUEsRUFDRjtBQUdBLFFBQU0sa0JBQWtCLEtBQUssTUFBTSw0Q0FBNEM7QUFDL0UsUUFBTSxjQUFjLE1BQU0sYUFBYSxlQUFlO0FBQ3RELE1BQUksYUFBYTtBQUNmLFVBQU0sS0FBSztBQUFBLE1BQ1QsTUFBTTtBQUFBLE1BQ04sTUFBTTtBQUFBLE1BQ04sU0FBUztBQUFBLE1BQ1QsYUFBYTtBQUFBLE1BQ2IsUUFBUSxPQUFPLE1BQU0saUJBQWlCLE1BQU07QUFBQSxJQUM5QyxDQUFDO0FBQUEsRUFDSDtBQUdBLFFBQU0sV0FBVyxLQUFLLGFBQWEsaUJBQWlCO0FBQ3BELFFBQU0sWUFBWSxNQUFNLFlBQVksUUFBUTtBQUM1QyxhQUFXLFFBQVEsV0FBVztBQUM1QixRQUFJLENBQUMsS0FBSyxTQUFTLEtBQUssRUFBRztBQUMzQixVQUFNLFdBQVcsS0FBSyxVQUFVLElBQUk7QUFDcEMsVUFBTSxVQUFVLE1BQU0sYUFBYSxRQUFRO0FBQzNDLFFBQUksQ0FBQyxRQUFTO0FBQ2QsVUFBTSxFQUFFLGFBQWEsS0FBSyxJQUFJLGlCQUFpQixPQUFPO0FBQ3RELFVBQU0sS0FBSztBQUFBLE1BQ1QsTUFBTTtBQUFBLE1BQ04sTUFBTSxLQUFLLFFBQVEsU0FBUyxFQUFFO0FBQUEsTUFDOUIsU0FBUztBQUFBLE1BQ1QsYUFBYSxPQUFPLFlBQVksZ0JBQWdCLFdBQVcsWUFBWSxjQUFjO0FBQUEsTUFDckYsUUFBUSxPQUFPLE1BQU0sVUFBVSxTQUFTO0FBQUEsSUFDMUMsQ0FBQztBQUFBLEVBQ0g7QUFHQSxRQUFNLGFBQWEsS0FBSyxhQUFhLGdCQUFnQjtBQUNyRCxRQUFNLGdCQUFnQixNQUFNLGFBQWEsVUFBVTtBQUNuRCxNQUFJLGVBQWU7QUFDakIsVUFBTSxLQUFLO0FBQUEsTUFDVCxNQUFNO0FBQUEsTUFDTixNQUFNO0FBQUEsTUFDTixTQUFTO0FBQUEsTUFDVCxhQUFhO0FBQUEsTUFDYixRQUFRLE9BQU8sTUFBTSxZQUFZLFNBQVM7QUFBQSxJQUM1QyxDQUFDO0FBQUEsRUFDSDtBQUVBLFNBQU8sRUFBRSxPQUFPLFNBQVM7QUFDM0I7QUFJQSxlQUFlLFdBQVcsYUFBcUIsTUFBYyxNQUEwRTtBQUNySSxRQUFNLFFBQTBCLENBQUM7QUFDakMsUUFBTSxXQUFxQixDQUFDO0FBRzVCLGFBQVcsRUFBRSxNQUFNLGNBQWMsTUFBTSxLQUFLO0FBQUEsSUFDMUMsRUFBRSxNQUFNLEtBQUssTUFBTSx1QkFBdUIsR0FBRyxPQUFPLE9BQXNCO0FBQUEsSUFDMUUsRUFBRSxNQUFNLEtBQUssYUFBYSx1QkFBdUIsR0FBRyxPQUFPLFVBQXlCO0FBQUEsRUFDdEYsR0FBRztBQUNELFVBQU0sVUFBVSxNQUFNLGFBQWEsWUFBWTtBQUMvQyxRQUFJLFNBQVM7QUFDWCxZQUFNLE9BQU8sYUFBc0MsT0FBTztBQUMxRCxVQUFJLE1BQU07QUFDUixjQUFNLEtBQUssR0FBRyx3QkFBd0IsTUFBTSxjQUFjLE1BQU0sS0FBSyxDQUFDO0FBQ3RFLGNBQU0sS0FBSyxFQUFFLE1BQU0sWUFBWSxNQUFNLE1BQU0sUUFBUSxPQUFPLE1BQU0sY0FBYyxLQUFLLEVBQUUsQ0FBQztBQUFBLE1BQ3hGO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFHQSxhQUFXLEVBQUUsTUFBTSxRQUFRLE1BQU0sS0FBSztBQUFBLElBQ3BDLEVBQUUsTUFBTSxLQUFLLE1BQU0sbUJBQW1CLEdBQUcsT0FBTyxPQUFzQjtBQUFBLElBQ3RFLEVBQUUsTUFBTSxLQUFLLGFBQWEsbUJBQW1CLEdBQUcsT0FBTyxVQUF5QjtBQUFBLEVBQ2xGLEdBQUc7QUFDRCxVQUFNLFVBQVUsTUFBTSxhQUFhLE1BQU07QUFDekMsUUFBSSxTQUFTO0FBQ1gsWUFBTSxLQUFLO0FBQUEsUUFDVCxNQUFNO0FBQUEsUUFDTixNQUFNLGNBQWMsS0FBSztBQUFBLFFBQ3pCO0FBQUEsUUFDQSxRQUFRLE9BQU8sTUFBTSxRQUFRLEtBQUs7QUFBQSxNQUNwQyxDQUFDO0FBQUEsSUFDSDtBQUFBLEVBQ0Y7QUFFQSxTQUFPLEVBQUUsT0FBTyxTQUFTO0FBQzNCO0FBSUEsZUFBZSxVQUFVLGFBQXFCLE1BQWMsTUFBMEU7QUFDcEksUUFBTSxRQUEwQixDQUFDO0FBQ2pDLFFBQU0sV0FBcUIsQ0FBQztBQUc1QixRQUFNLGVBQWUsS0FBSyxNQUFNLGtCQUFrQjtBQUNsRCxRQUFNLFdBQVcsTUFBTSxhQUFhLFlBQVk7QUFDaEQsTUFBSSxVQUFVO0FBQ1osVUFBTSxLQUFLO0FBQUEsTUFDVCxNQUFNO0FBQUEsTUFDTixNQUFNO0FBQUEsTUFDTixTQUFTO0FBQUEsTUFDVCxRQUFRLE9BQU8sTUFBTSxjQUFjLE1BQU07QUFBQSxJQUMzQyxDQUFDO0FBQUEsRUFDSDtBQUdBLFFBQU0sa0JBQWtCLEtBQUssYUFBYSxXQUFXO0FBQ3JELFFBQU0saUJBQWlCLE1BQU0sYUFBYSxlQUFlO0FBQ3pELE1BQUksZ0JBQWdCO0FBQ2xCLFVBQU0sS0FBSztBQUFBLE1BQ1QsTUFBTTtBQUFBLE1BQ04sTUFBTTtBQUFBLE1BQ04sU0FBUztBQUFBLE1BQ1QsUUFBUSxPQUFPLE1BQU0saUJBQWlCLFNBQVM7QUFBQSxJQUNqRCxDQUFDO0FBQUEsRUFDSDtBQUlBLGFBQVcsRUFBRSxNQUFNLFVBQVUsTUFBTSxLQUFLO0FBQUEsSUFDdEMsRUFBRSxNQUFNLEtBQUssTUFBTSxvQkFBb0IsR0FBRyxPQUFPLE9BQXNCO0FBQUEsSUFDdkUsRUFBRSxNQUFNLEtBQUssYUFBYSxvQkFBb0IsR0FBRyxPQUFPLFVBQXlCO0FBQUEsRUFDbkYsR0FBRztBQUNELFFBQUksTUFBTSxXQUFXLFFBQVEsR0FBRztBQUM5QixlQUFTLEtBQUssU0FBUyxRQUFRLHNFQUFpRTtBQUFBLElBQ2xHO0FBQUEsRUFDRjtBQUVBLFNBQU8sRUFBRSxPQUFPLFNBQVM7QUFDM0I7QUFJQSxlQUFlLFVBQVUsYUFBcUIsT0FBZSxNQUEwRTtBQUNySSxRQUFNLFFBQTBCLENBQUM7QUFDakMsUUFBTSxXQUFxQixDQUFDO0FBRTVCLFFBQU0saUJBQWlCLEtBQUssYUFBYSxhQUFhO0FBRXRELE1BQUksTUFBTSxZQUFZLGNBQWMsR0FBRztBQUVyQyxVQUFNLFFBQVEsTUFBTSxZQUFZLGNBQWM7QUFDOUMsZUFBVyxRQUFRLE9BQU87QUFDeEIsVUFBSSxDQUFDLEtBQUssU0FBUyxLQUFLLEVBQUc7QUFDM0IsWUFBTSxXQUFXLEtBQUssZ0JBQWdCLElBQUk7QUFDMUMsWUFBTSxVQUFVLE1BQU0sYUFBYSxRQUFRO0FBQzNDLFVBQUksQ0FBQyxRQUFTO0FBQ2QsWUFBTSxFQUFFLEtBQUssSUFBSSxpQkFBaUIsT0FBTztBQUN6QyxZQUFNLEtBQUs7QUFBQSxRQUNULE1BQU07QUFBQSxRQUNOLE1BQU0sS0FBSyxRQUFRLFNBQVMsRUFBRTtBQUFBLFFBQzlCLFNBQVM7QUFBQSxRQUNULGFBQWE7QUFBQSxRQUNiLFFBQVEsT0FBTyxNQUFNLFVBQVUsU0FBUztBQUFBLE1BQzFDLENBQUM7QUFBQSxJQUNIO0FBQUEsRUFDRixPQUFPO0FBRUwsVUFBTSxVQUFVLE1BQU0sYUFBYSxjQUFjO0FBQ2pELFFBQUksU0FBUztBQUNYLFlBQU0sS0FBSztBQUFBLFFBQ1QsTUFBTTtBQUFBLFFBQ04sTUFBTTtBQUFBLFFBQ047QUFBQSxRQUNBLGFBQWE7QUFBQSxRQUNiLFFBQVEsT0FBTyxNQUFNLGdCQUFnQixTQUFTO0FBQUEsTUFDaEQsQ0FBQztBQUFBLElBQ0g7QUFBQSxFQUNGO0FBR0EsUUFBTSxlQUFlLEtBQUssYUFBYSwwQkFBMEI7QUFDakUsUUFBTSxrQkFBa0IsTUFBTSxhQUFhLFlBQVk7QUFDdkQsTUFBSSxpQkFBaUI7QUFDbkIsVUFBTSxPQUFPLGFBQXNDLGVBQWU7QUFDbEUsUUFBSSxLQUFNLE9BQU0sS0FBSyxHQUFHLHdCQUF3QixNQUFNLGNBQWMsTUFBTSxTQUFTLENBQUM7QUFBQSxFQUN0RjtBQUVBLFNBQU8sRUFBRSxPQUFPLFNBQVM7QUFDM0I7QUFJQSxlQUFlLGtCQUFrQixhQUFxQixPQUFlLE1BQTBFO0FBQzdJLFFBQU0sUUFBMEIsQ0FBQztBQUNqQyxRQUFNLFdBQXFCLENBQUM7QUFHNUIsUUFBTSxtQkFBbUIsS0FBSyxhQUFhLGlDQUFpQztBQUM1RSxRQUFNLGVBQWUsTUFBTSxhQUFhLGdCQUFnQjtBQUN4RCxNQUFJLGNBQWM7QUFDaEIsVUFBTSxLQUFLO0FBQUEsTUFDVCxNQUFNO0FBQUEsTUFDTixNQUFNO0FBQUEsTUFDTixTQUFTO0FBQUEsTUFDVCxRQUFRLE9BQU8sTUFBTSxrQkFBa0IsU0FBUztBQUFBLElBQ2xELENBQUM7QUFBQSxFQUNIO0FBR0EsUUFBTSxrQkFBa0IsS0FBSyxhQUFhLHNCQUFzQjtBQUNoRSxRQUFNLGFBQWEsTUFBTSxZQUFZLGVBQWU7QUFDcEQsYUFBVyxRQUFRLFlBQVk7QUFDN0IsUUFBSSxDQUFDLEtBQUssU0FBUyxrQkFBa0IsRUFBRztBQUN4QyxVQUFNLFdBQVcsS0FBSyxpQkFBaUIsSUFBSTtBQUMzQyxVQUFNLFVBQVUsTUFBTSxhQUFhLFFBQVE7QUFDM0MsUUFBSSxDQUFDLFFBQVM7QUFDZCxVQUFNLEVBQUUsYUFBYSxLQUFLLElBQUksaUJBQWlCLE9BQU87QUFDdEQsVUFBTSxVQUFVLE9BQU8sWUFBWSxZQUFZLFdBQVcsWUFBWSxVQUFVO0FBQ2hGLFVBQU0sS0FBSztBQUFBLE1BQ1QsTUFBTTtBQUFBLE1BQ04sTUFBTSxLQUFLLFFBQVEsb0JBQW9CLEVBQUU7QUFBQSxNQUN6QyxTQUFTO0FBQUEsTUFDVCxPQUFPLFVBQVUsQ0FBQyxPQUFPLElBQUk7QUFBQSxNQUM3QixhQUFhLDZCQUE2QixVQUFVLGlCQUFpQixPQUFPLE1BQU0sRUFBRTtBQUFBLE1BQ3BGLFFBQVEsT0FBTyxNQUFNLFVBQVUsU0FBUztBQUFBLElBQzFDLENBQUM7QUFBQSxFQUNIO0FBRUEsU0FBTyxFQUFFLE9BQU8sU0FBUztBQUMzQjtBQUlBLGVBQWUsV0FBVyxhQUFxQixPQUFlLE1BQTBFO0FBQ3RJLFFBQU0sUUFBMEIsQ0FBQztBQUNqQyxRQUFNLFdBQXFCLENBQUM7QUFHNUIsUUFBTSxlQUFlLEtBQUssYUFBYSx1QkFBdUI7QUFDOUQsUUFBTSxrQkFBa0IsTUFBTSxhQUFhLFlBQVk7QUFDdkQsTUFBSSxpQkFBaUI7QUFDbkIsVUFBTSxPQUFPLGFBQXNDLGVBQWU7QUFDbEUsUUFBSSxNQUFNO0FBQ1IsWUFBTSxLQUFLLEVBQUUsTUFBTSxZQUFZLE1BQU0sTUFBTSxRQUFRLE9BQU8sTUFBTSxjQUFjLFNBQVMsRUFBRSxDQUFDO0FBSTFGLFlBQU0sYUFBYyxLQUFLLGFBQWEsS0FBSyxLQUFLLGNBQWUsS0FBSyxLQUFpQztBQUNyRyxVQUFJLGNBQWMsT0FBTyxlQUFlLFVBQVU7QUFDaEQsY0FBTSxLQUFLLEdBQUcsd0JBQXdCLEVBQUUsV0FBVyxHQUFHLGNBQWMsTUFBTSxTQUFTLENBQUM7QUFBQSxNQUN0RjtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBR0EsUUFBTSxVQUFVLEtBQUssYUFBYSxrQkFBa0I7QUFDcEQsUUFBTSxhQUFhLE1BQU0sYUFBYSxPQUFPO0FBQzdDLE1BQUksWUFBWTtBQUNkLFVBQU0sT0FBTyxhQUFzQyxVQUFVO0FBQzdELFFBQUksTUFBTTtBQUVSLFlBQU0sVUFBVyxLQUFLLFdBQVcsS0FBSztBQUN0QyxVQUFJLFdBQVcsT0FBTyxZQUFZLFVBQVU7QUFDMUMsY0FBTSxLQUFLLEdBQUcsd0JBQXdCLEVBQUUsWUFBWSxRQUFRLEdBQUcsU0FBUyxNQUFNLFNBQVMsQ0FBQztBQUFBLE1BQzFGO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFFQSxTQUFPLEVBQUUsT0FBTyxTQUFTO0FBQzNCO0FBSU8sTUFBTSxXQUFvQztBQUFBLEVBQy9DLFFBQVE7QUFBQSxFQUNSLFFBQVE7QUFBQSxFQUNSLFVBQVU7QUFBQSxFQUNWLFFBQVE7QUFBQSxFQUNSLE9BQU87QUFBQSxFQUNQLE9BQU87QUFBQSxFQUNQLGtCQUFrQjtBQUFBLEVBQ2xCLFFBQVE7QUFDVjsiLAogICJuYW1lcyI6IFtdCn0K
