import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "fs";
import ignore from "ignore";
import { homedir } from "os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { parseFrontmatter } from "../utils/frontmatter.js";
import { toPosixPath } from "../utils/path-display.js";
import { CONFIG_DIR_NAME } from "../config.js";
const ECOSYSTEM_SKILLS_DIR = join(homedir(), ".agents", "skills");
const ECOSYSTEM_PROJECT_SKILLS_DIR = ".agents";
const LEGACY_SKILLS_DIR = join(homedir(), CONFIG_DIR_NAME, "agent", "skills");
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
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
let loadedSkills = [];
function getLoadedSkills() {
  return [...loadedSkills];
}
function validateName(name, parentDirName) {
  const errors = [];
  if (name !== parentDirName) {
    errors.push(`name "${name}" does not match parent directory "${parentDirName}"`);
  }
  if (name.length > MAX_NAME_LENGTH) {
    errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    errors.push(`name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)`);
  }
  if (name.startsWith("-") || name.endsWith("-")) {
    errors.push(`name must not start or end with a hyphen`);
  }
  if (name.includes("--")) {
    errors.push(`name must not contain consecutive hyphens`);
  }
  return errors;
}
function validateDescription(description) {
  const errors = [];
  if (!description || description.trim() === "") {
    errors.push("description is required");
  } else if (description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
  }
  return errors;
}
function loadSkillsFromDir(options) {
  const { dir, source } = options;
  return loadSkillsFromDirInternal(dir, source, true);
}
function loadSkillsFromDirInternal(dir, source, includeRootFiles, ignoreMatcher, rootDir) {
  const skills = [];
  const diagnostics = [];
  if (!existsSync(dir)) {
    return { skills, diagnostics };
  }
  const root = rootDir ?? dir;
  const ig = ignoreMatcher ?? ignore();
  addIgnoreRules(ig, dir, root);
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      if (entry.name === "node_modules") {
        continue;
      }
      const fullPath = join(dir, entry.name);
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const stats = statSync(fullPath);
          isDirectory = stats.isDirectory();
          isFile = stats.isFile();
        } catch {
          continue;
        }
      }
      const relPath = toPosixPath(relative(root, fullPath));
      const ignorePath = isDirectory ? `${relPath}/` : relPath;
      if (ig.ignores(ignorePath)) {
        continue;
      }
      if (isDirectory) {
        const subResult = loadSkillsFromDirInternal(fullPath, source, false, ig, root);
        skills.push(...subResult.skills);
        diagnostics.push(...subResult.diagnostics);
        continue;
      }
      if (!isFile) {
        continue;
      }
      const isRootMd = includeRootFiles && entry.name.endsWith(".md");
      const isSkillMd = !includeRootFiles && entry.name === "SKILL.md";
      if (!isRootMd && !isSkillMd) {
        continue;
      }
      const result = loadSkillFromFile(fullPath, source);
      if (result.skill) {
        skills.push(result.skill);
      }
      diagnostics.push(...result.diagnostics);
    }
  } catch {
  }
  return { skills, diagnostics };
}
function loadSkillFromFile(filePath, source) {
  const diagnostics = [];
  try {
    const rawContent = readFileSync(filePath, "utf-8");
    const { frontmatter } = parseFrontmatter(rawContent);
    const skillDir = dirname(filePath);
    const parentDirName = basename(skillDir);
    const descErrors = validateDescription(frontmatter.description);
    for (const error of descErrors) {
      diagnostics.push({ type: "warning", message: error, path: filePath });
    }
    const name = frontmatter.name || parentDirName;
    const nameErrors = validateName(name, parentDirName);
    for (const error of nameErrors) {
      diagnostics.push({ type: "warning", message: error, path: filePath });
    }
    if (!frontmatter.description || frontmatter.description.trim() === "") {
      return { skill: null, diagnostics };
    }
    return {
      skill: {
        name,
        description: frontmatter.description,
        filePath,
        baseDir: skillDir,
        source,
        disableModelInvocation: frontmatter["disable-model-invocation"] === true
      },
      diagnostics
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to parse skill file";
    diagnostics.push({ type: "warning", message, path: filePath });
    return { skill: null, diagnostics };
  }
}
function formatSkillsForPrompt(skills) {
  const visibleSkills = skills.filter((s) => !s.disableModelInvocation);
  if (visibleSkills.length === 0) {
    return "";
  }
  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use the Skill tool with the exact skill name from <available_skills> when the task matches its description.",
    "If the Skill tool reports an unknown skill, do not guess: use an exact name from <available_skills> or tell the user the skill is unavailable.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>"
  ];
  for (const skill of visibleSkills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}
function escapeXml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function normalizePath(input) {
  const trimmed = input.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  if (trimmed.startsWith("~")) return join(homedir(), trimmed.slice(1));
  return trimmed;
}
function resolveSkillPath(p, cwd) {
  const normalized = normalizePath(p);
  return isAbsolute(normalized) ? normalized : resolve(cwd, normalized);
}
function loadSkills(options = {}) {
  const { cwd = process.cwd(), skillPaths = [], includeDefaults = true } = options;
  const skillMap = /* @__PURE__ */ new Map();
  const realPathSet = /* @__PURE__ */ new Set();
  const allDiagnostics = [];
  const collisionDiagnostics = [];
  function addSkills(result) {
    allDiagnostics.push(...result.diagnostics);
    for (const skill of result.skills) {
      let realPath;
      try {
        realPath = realpathSync(skill.filePath);
      } catch {
        realPath = skill.filePath;
      }
      if (realPathSet.has(realPath)) {
        continue;
      }
      const existing = skillMap.get(skill.name);
      if (existing) {
        collisionDiagnostics.push({
          type: "collision",
          message: `name "${skill.name}" collision`,
          path: skill.filePath,
          collision: {
            resourceType: "skill",
            name: skill.name,
            winnerPath: existing.filePath,
            loserPath: skill.filePath
          }
        });
      } else {
        skillMap.set(skill.name, skill);
        realPathSet.add(realPath);
      }
    }
  }
  if (includeDefaults) {
    addSkills(loadSkillsFromDirInternal(ECOSYSTEM_SKILLS_DIR, "user", true));
    addSkills(loadSkillsFromDirInternal(resolve(cwd, ECOSYSTEM_PROJECT_SKILLS_DIR, "skills"), "project", true));
    const legacyMigrated = existsSync(join(LEGACY_SKILLS_DIR, ".migrated-to-agents"));
    if (LEGACY_SKILLS_DIR !== ECOSYSTEM_SKILLS_DIR && existsSync(LEGACY_SKILLS_DIR) && !legacyMigrated) {
      addSkills(loadSkillsFromDirInternal(LEGACY_SKILLS_DIR, "user", true));
    }
  }
  const userSkillsDir = ECOSYSTEM_SKILLS_DIR;
  const projectSkillsDir = resolve(cwd, ECOSYSTEM_PROJECT_SKILLS_DIR, "skills");
  const isUnderPath = (target, root) => {
    const normalizedRoot = resolve(root);
    if (target === normalizedRoot) {
      return true;
    }
    const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
    return target.startsWith(prefix);
  };
  const getSource = (resolvedPath) => {
    if (!includeDefaults) {
      if (isUnderPath(resolvedPath, userSkillsDir)) return "user";
      if (isUnderPath(resolvedPath, projectSkillsDir)) return "project";
    }
    return "path";
  };
  for (const rawPath of skillPaths) {
    const resolvedPath = resolveSkillPath(rawPath, cwd);
    if (!existsSync(resolvedPath)) {
      allDiagnostics.push({ type: "warning", message: "skill path does not exist", path: resolvedPath });
      continue;
    }
    try {
      const stats = statSync(resolvedPath);
      const source = getSource(resolvedPath);
      if (stats.isDirectory()) {
        addSkills(loadSkillsFromDirInternal(resolvedPath, source, true));
      } else if (stats.isFile() && resolvedPath.endsWith(".md")) {
        const result = loadSkillFromFile(resolvedPath, source);
        if (result.skill) {
          addSkills({ skills: [result.skill], diagnostics: result.diagnostics });
        } else {
          allDiagnostics.push(...result.diagnostics);
        }
      } else {
        allDiagnostics.push({ type: "warning", message: "skill path is not a markdown file", path: resolvedPath });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to read skill path";
      allDiagnostics.push({ type: "warning", message, path: resolvedPath });
    }
  }
  loadedSkills = Array.from(skillMap.values());
  return {
    skills: [...loadedSkills],
    diagnostics: [...allDiagnostics, ...collisionDiagnostics]
  };
}
export {
  ECOSYSTEM_PROJECT_SKILLS_DIR,
  ECOSYSTEM_SKILLS_DIR,
  formatSkillsForPrompt,
  getLoadedSkills,
  loadSkills,
  loadSkillsFromDir
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL3NraWxscy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZGRpclN5bmMsIHJlYWRGaWxlU3luYywgcmVhbHBhdGhTeW5jLCBzdGF0U3luYyB9IGZyb20gXCJmc1wiO1xuaW1wb3J0IGlnbm9yZSBmcm9tIFwiaWdub3JlXCI7XG5pbXBvcnQgeyBob21lZGlyIH0gZnJvbSBcIm9zXCI7XG5pbXBvcnQgeyBiYXNlbmFtZSwgZGlybmFtZSwgaXNBYnNvbHV0ZSwgam9pbiwgcmVsYXRpdmUsIHJlc29sdmUsIHNlcCB9IGZyb20gXCJwYXRoXCI7XG5pbXBvcnQgeyBwYXJzZUZyb250bWF0dGVyIH0gZnJvbSBcIi4uL3V0aWxzL2Zyb250bWF0dGVyLmpzXCI7XG5pbXBvcnQgeyB0b1Bvc2l4UGF0aCB9IGZyb20gXCIuLi91dGlscy9wYXRoLWRpc3BsYXkuanNcIjtcbmltcG9ydCB0eXBlIHsgUmVzb3VyY2VEaWFnbm9zdGljIH0gZnJvbSBcIi4vZGlhZ25vc3RpY3MuanNcIjtcbmltcG9ydCB7IENPTkZJR19ESVJfTkFNRSB9IGZyb20gXCIuLi9jb25maWcuanNcIjtcblxuLyoqXG4gKiBUaGUgc3RhbmRhcmQgZWNvc3lzdGVtIHNraWxscyBkaXJlY3RvcnkgdXNlZCBieSBza2lsbHMuc2ggYW5kIHRoZVxuICogQWdlbnQgU2tpbGxzIHN0YW5kYXJkLiAgQWxsIGFnZW50cyBzaGFyZSB0aGlzIGxvY2F0aW9uIGZvciBnbG9iYWxseVxuICogaW5zdGFsbGVkIHNraWxscy5cbiAqL1xuZXhwb3J0IGNvbnN0IEVDT1NZU1RFTV9TS0lMTFNfRElSID0gam9pbihob21lZGlyKCksIFwiLmFnZW50c1wiLCBcInNraWxsc1wiKTtcblxuLyoqXG4gKiBUaGUgc3RhbmRhcmQgcHJvamVjdC1sZXZlbCBza2lsbHMgZGlyZWN0b3J5IChgLmFnZW50cy9za2lsbHMvYCByZWxhdGl2ZSB0byBjd2QpLlxuICovXG5leHBvcnQgY29uc3QgRUNPU1lTVEVNX1BST0pFQ1RfU0tJTExTX0RJUiA9IFwiLmFnZW50c1wiO1xuXG4vKipcbiAqIExlZ2FjeSBza2lsbHMgZGlyZWN0b3J5ICh+Ly5nc2QvYWdlbnQvc2tpbGxzLyBvciB+Ly5waS9hZ2VudC9za2lsbHMvKS5cbiAqIFJlYWQgYXMgYSBmYWxsYmFjayBzbyBleGlzdGluZyBpbnN0YWxscyBkb24ndCBsb3NlIHNraWxscyBiZWZvcmUgbWlncmF0aW9uIHJ1bnMuXG4gKi9cbmNvbnN0IExFR0FDWV9TS0lMTFNfRElSID0gam9pbihob21lZGlyKCksIENPTkZJR19ESVJfTkFNRSwgXCJhZ2VudFwiLCBcInNraWxsc1wiKTtcblxuLyoqIE1heCBuYW1lIGxlbmd0aCBwZXIgc3BlYyAqL1xuY29uc3QgTUFYX05BTUVfTEVOR1RIID0gNjQ7XG5cbi8qKiBNYXggZGVzY3JpcHRpb24gbGVuZ3RoIHBlciBzcGVjICovXG5jb25zdCBNQVhfREVTQ1JJUFRJT05fTEVOR1RIID0gMTAyNDtcblxuY29uc3QgSUdOT1JFX0ZJTEVfTkFNRVMgPSBbXCIuZ2l0aWdub3JlXCIsIFwiLmlnbm9yZVwiLCBcIi5mZGlnbm9yZVwiXTtcblxudHlwZSBJZ25vcmVNYXRjaGVyID0gUmV0dXJuVHlwZTx0eXBlb2YgaWdub3JlPjtcblxuZnVuY3Rpb24gcHJlZml4SWdub3JlUGF0dGVybihsaW5lOiBzdHJpbmcsIHByZWZpeDogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG5cdGNvbnN0IHRyaW1tZWQgPSBsaW5lLnRyaW0oKTtcblx0aWYgKCF0cmltbWVkKSByZXR1cm4gbnVsbDtcblx0aWYgKHRyaW1tZWQuc3RhcnRzV2l0aChcIiNcIikgJiYgIXRyaW1tZWQuc3RhcnRzV2l0aChcIlxcXFwjXCIpKSByZXR1cm4gbnVsbDtcblxuXHRsZXQgcGF0dGVybiA9IGxpbmU7XG5cdGxldCBuZWdhdGVkID0gZmFsc2U7XG5cblx0aWYgKHBhdHRlcm4uc3RhcnRzV2l0aChcIiFcIikpIHtcblx0XHRuZWdhdGVkID0gdHJ1ZTtcblx0XHRwYXR0ZXJuID0gcGF0dGVybi5zbGljZSgxKTtcblx0fSBlbHNlIGlmIChwYXR0ZXJuLnN0YXJ0c1dpdGgoXCJcXFxcIVwiKSkge1xuXHRcdHBhdHRlcm4gPSBwYXR0ZXJuLnNsaWNlKDEpO1xuXHR9XG5cblx0aWYgKHBhdHRlcm4uc3RhcnRzV2l0aChcIi9cIikpIHtcblx0XHRwYXR0ZXJuID0gcGF0dGVybi5zbGljZSgxKTtcblx0fVxuXG5cdGNvbnN0IHByZWZpeGVkID0gcHJlZml4ID8gYCR7cHJlZml4fSR7cGF0dGVybn1gIDogcGF0dGVybjtcblx0cmV0dXJuIG5lZ2F0ZWQgPyBgISR7cHJlZml4ZWR9YCA6IHByZWZpeGVkO1xufVxuXG5mdW5jdGlvbiBhZGRJZ25vcmVSdWxlcyhpZzogSWdub3JlTWF0Y2hlciwgZGlyOiBzdHJpbmcsIHJvb3REaXI6IHN0cmluZyk6IHZvaWQge1xuXHRjb25zdCByZWxhdGl2ZURpciA9IHJlbGF0aXZlKHJvb3REaXIsIGRpcik7XG5cdGNvbnN0IHByZWZpeCA9IHJlbGF0aXZlRGlyID8gYCR7dG9Qb3NpeFBhdGgocmVsYXRpdmVEaXIpfS9gIDogXCJcIjtcblxuXHRmb3IgKGNvbnN0IGZpbGVuYW1lIG9mIElHTk9SRV9GSUxFX05BTUVTKSB7XG5cdFx0Y29uc3QgaWdub3JlUGF0aCA9IGpvaW4oZGlyLCBmaWxlbmFtZSk7XG5cdFx0aWYgKCFleGlzdHNTeW5jKGlnbm9yZVBhdGgpKSBjb250aW51ZTtcblx0XHR0cnkge1xuXHRcdFx0Y29uc3QgY29udGVudCA9IHJlYWRGaWxlU3luYyhpZ25vcmVQYXRoLCBcInV0Zi04XCIpO1xuXHRcdFx0Y29uc3QgcGF0dGVybnMgPSBjb250ZW50XG5cdFx0XHRcdC5zcGxpdCgvXFxyP1xcbi8pXG5cdFx0XHRcdC5tYXAoKGxpbmUpID0+IHByZWZpeElnbm9yZVBhdHRlcm4obGluZSwgcHJlZml4KSlcblx0XHRcdFx0LmZpbHRlcigobGluZSk6IGxpbmUgaXMgc3RyaW5nID0+IEJvb2xlYW4obGluZSkpO1xuXHRcdFx0aWYgKHBhdHRlcm5zLmxlbmd0aCA+IDApIHtcblx0XHRcdFx0aWcuYWRkKHBhdHRlcm5zKTtcblx0XHRcdH1cblx0XHR9IGNhdGNoIHt9XG5cdH1cbn1cblxuZXhwb3J0IGludGVyZmFjZSBTa2lsbEZyb250bWF0dGVyIHtcblx0bmFtZT86IHN0cmluZztcblx0ZGVzY3JpcHRpb24/OiBzdHJpbmc7XG5cdFwiZGlzYWJsZS1tb2RlbC1pbnZvY2F0aW9uXCI/OiBib29sZWFuO1xuXHRba2V5OiBzdHJpbmddOiB1bmtub3duO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFNraWxsIHtcblx0bmFtZTogc3RyaW5nO1xuXHRkZXNjcmlwdGlvbjogc3RyaW5nO1xuXHRmaWxlUGF0aDogc3RyaW5nO1xuXHRiYXNlRGlyOiBzdHJpbmc7XG5cdHNvdXJjZTogc3RyaW5nO1xuXHRkaXNhYmxlTW9kZWxJbnZvY2F0aW9uOiBib29sZWFuO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIExvYWRTa2lsbHNSZXN1bHQge1xuXHRza2lsbHM6IFNraWxsW107XG5cdGRpYWdub3N0aWNzOiBSZXNvdXJjZURpYWdub3N0aWNbXTtcbn1cblxubGV0IGxvYWRlZFNraWxsczogU2tpbGxbXSA9IFtdO1xuXG5leHBvcnQgZnVuY3Rpb24gZ2V0TG9hZGVkU2tpbGxzKCk6IFNraWxsW10ge1xuXHRyZXR1cm4gWy4uLmxvYWRlZFNraWxsc107XG59XG5cbi8qKlxuICogVmFsaWRhdGUgc2tpbGwgbmFtZSBwZXIgQWdlbnQgU2tpbGxzIHNwZWMuXG4gKiBSZXR1cm5zIGFycmF5IG9mIHZhbGlkYXRpb24gZXJyb3IgbWVzc2FnZXMgKGVtcHR5IGlmIHZhbGlkKS5cbiAqL1xuZnVuY3Rpb24gdmFsaWRhdGVOYW1lKG5hbWU6IHN0cmluZywgcGFyZW50RGlyTmFtZTogc3RyaW5nKTogc3RyaW5nW10ge1xuXHRjb25zdCBlcnJvcnM6IHN0cmluZ1tdID0gW107XG5cblx0aWYgKG5hbWUgIT09IHBhcmVudERpck5hbWUpIHtcblx0XHRlcnJvcnMucHVzaChgbmFtZSBcIiR7bmFtZX1cIiBkb2VzIG5vdCBtYXRjaCBwYXJlbnQgZGlyZWN0b3J5IFwiJHtwYXJlbnREaXJOYW1lfVwiYCk7XG5cdH1cblxuXHRpZiAobmFtZS5sZW5ndGggPiBNQVhfTkFNRV9MRU5HVEgpIHtcblx0XHRlcnJvcnMucHVzaChgbmFtZSBleGNlZWRzICR7TUFYX05BTUVfTEVOR1RIfSBjaGFyYWN0ZXJzICgke25hbWUubGVuZ3RofSlgKTtcblx0fVxuXG5cdGlmICghL15bYS16MC05LV0rJC8udGVzdChuYW1lKSkge1xuXHRcdGVycm9ycy5wdXNoKGBuYW1lIGNvbnRhaW5zIGludmFsaWQgY2hhcmFjdGVycyAobXVzdCBiZSBsb3dlcmNhc2UgYS16LCAwLTksIGh5cGhlbnMgb25seSlgKTtcblx0fVxuXG5cdGlmIChuYW1lLnN0YXJ0c1dpdGgoXCItXCIpIHx8IG5hbWUuZW5kc1dpdGgoXCItXCIpKSB7XG5cdFx0ZXJyb3JzLnB1c2goYG5hbWUgbXVzdCBub3Qgc3RhcnQgb3IgZW5kIHdpdGggYSBoeXBoZW5gKTtcblx0fVxuXG5cdGlmIChuYW1lLmluY2x1ZGVzKFwiLS1cIikpIHtcblx0XHRlcnJvcnMucHVzaChgbmFtZSBtdXN0IG5vdCBjb250YWluIGNvbnNlY3V0aXZlIGh5cGhlbnNgKTtcblx0fVxuXG5cdHJldHVybiBlcnJvcnM7XG59XG5cbi8qKlxuICogVmFsaWRhdGUgZGVzY3JpcHRpb24gcGVyIEFnZW50IFNraWxscyBzcGVjLlxuICovXG5mdW5jdGlvbiB2YWxpZGF0ZURlc2NyaXB0aW9uKGRlc2NyaXB0aW9uOiBzdHJpbmcgfCB1bmRlZmluZWQpOiBzdHJpbmdbXSB7XG5cdGNvbnN0IGVycm9yczogc3RyaW5nW10gPSBbXTtcblxuXHRpZiAoIWRlc2NyaXB0aW9uIHx8IGRlc2NyaXB0aW9uLnRyaW0oKSA9PT0gXCJcIikge1xuXHRcdGVycm9ycy5wdXNoKFwiZGVzY3JpcHRpb24gaXMgcmVxdWlyZWRcIik7XG5cdH0gZWxzZSBpZiAoZGVzY3JpcHRpb24ubGVuZ3RoID4gTUFYX0RFU0NSSVBUSU9OX0xFTkdUSCkge1xuXHRcdGVycm9ycy5wdXNoKGBkZXNjcmlwdGlvbiBleGNlZWRzICR7TUFYX0RFU0NSSVBUSU9OX0xFTkdUSH0gY2hhcmFjdGVycyAoJHtkZXNjcmlwdGlvbi5sZW5ndGh9KWApO1xuXHR9XG5cblx0cmV0dXJuIGVycm9ycztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBMb2FkU2tpbGxzRnJvbURpck9wdGlvbnMge1xuXHQvKiogRGlyZWN0b3J5IHRvIHNjYW4gZm9yIHNraWxscyAqL1xuXHRkaXI6IHN0cmluZztcblx0LyoqIFNvdXJjZSBpZGVudGlmaWVyIGZvciB0aGVzZSBza2lsbHMgKi9cblx0c291cmNlOiBzdHJpbmc7XG59XG5cbi8qKlxuICogTG9hZCBza2lsbHMgZnJvbSBhIGRpcmVjdG9yeS5cbiAqXG4gKiBEaXNjb3ZlcnkgcnVsZXM6XG4gKiAtIGRpcmVjdCAubWQgY2hpbGRyZW4gaW4gdGhlIHJvb3RcbiAqIC0gcmVjdXJzaXZlIFNLSUxMLm1kIHVuZGVyIHN1YmRpcmVjdG9yaWVzXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBsb2FkU2tpbGxzRnJvbURpcihvcHRpb25zOiBMb2FkU2tpbGxzRnJvbURpck9wdGlvbnMpOiBMb2FkU2tpbGxzUmVzdWx0IHtcblx0Y29uc3QgeyBkaXIsIHNvdXJjZSB9ID0gb3B0aW9ucztcblx0cmV0dXJuIGxvYWRTa2lsbHNGcm9tRGlySW50ZXJuYWwoZGlyLCBzb3VyY2UsIHRydWUpO1xufVxuXG5mdW5jdGlvbiBsb2FkU2tpbGxzRnJvbURpckludGVybmFsKFxuXHRkaXI6IHN0cmluZyxcblx0c291cmNlOiBzdHJpbmcsXG5cdGluY2x1ZGVSb290RmlsZXM6IGJvb2xlYW4sXG5cdGlnbm9yZU1hdGNoZXI/OiBJZ25vcmVNYXRjaGVyLFxuXHRyb290RGlyPzogc3RyaW5nLFxuKTogTG9hZFNraWxsc1Jlc3VsdCB7XG5cdGNvbnN0IHNraWxsczogU2tpbGxbXSA9IFtdO1xuXHRjb25zdCBkaWFnbm9zdGljczogUmVzb3VyY2VEaWFnbm9zdGljW10gPSBbXTtcblxuXHRpZiAoIWV4aXN0c1N5bmMoZGlyKSkge1xuXHRcdHJldHVybiB7IHNraWxscywgZGlhZ25vc3RpY3MgfTtcblx0fVxuXG5cdGNvbnN0IHJvb3QgPSByb290RGlyID8/IGRpcjtcblx0Y29uc3QgaWcgPSBpZ25vcmVNYXRjaGVyID8/IGlnbm9yZSgpO1xuXHRhZGRJZ25vcmVSdWxlcyhpZywgZGlyLCByb290KTtcblxuXHR0cnkge1xuXHRcdGNvbnN0IGVudHJpZXMgPSByZWFkZGlyU3luYyhkaXIsIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KTtcblxuXHRcdGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xuXHRcdFx0aWYgKGVudHJ5Lm5hbWUuc3RhcnRzV2l0aChcIi5cIikpIHtcblx0XHRcdFx0Y29udGludWU7XG5cdFx0XHR9XG5cblx0XHRcdC8vIFNraXAgbm9kZV9tb2R1bGVzIHRvIGF2b2lkIHNjYW5uaW5nIGRlcGVuZGVuY2llc1xuXHRcdFx0aWYgKGVudHJ5Lm5hbWUgPT09IFwibm9kZV9tb2R1bGVzXCIpIHtcblx0XHRcdFx0Y29udGludWU7XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IGZ1bGxQYXRoID0gam9pbihkaXIsIGVudHJ5Lm5hbWUpO1xuXG5cdFx0XHQvLyBGb3Igc3ltbGlua3MsIGNoZWNrIGlmIHRoZXkgcG9pbnQgdG8gYSBkaXJlY3RvcnkgYW5kIGZvbGxvdyB0aGVtXG5cdFx0XHRsZXQgaXNEaXJlY3RvcnkgPSBlbnRyeS5pc0RpcmVjdG9yeSgpO1xuXHRcdFx0bGV0IGlzRmlsZSA9IGVudHJ5LmlzRmlsZSgpO1xuXHRcdFx0aWYgKGVudHJ5LmlzU3ltYm9saWNMaW5rKCkpIHtcblx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRjb25zdCBzdGF0cyA9IHN0YXRTeW5jKGZ1bGxQYXRoKTtcblx0XHRcdFx0XHRpc0RpcmVjdG9yeSA9IHN0YXRzLmlzRGlyZWN0b3J5KCk7XG5cdFx0XHRcdFx0aXNGaWxlID0gc3RhdHMuaXNGaWxlKCk7XG5cdFx0XHRcdH0gY2F0Y2gge1xuXHRcdFx0XHRcdC8vIEJyb2tlbiBzeW1saW5rLCBza2lwIGl0XG5cdFx0XHRcdFx0Y29udGludWU7XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgcmVsUGF0aCA9IHRvUG9zaXhQYXRoKHJlbGF0aXZlKHJvb3QsIGZ1bGxQYXRoKSk7XG5cdFx0XHRjb25zdCBpZ25vcmVQYXRoID0gaXNEaXJlY3RvcnkgPyBgJHtyZWxQYXRofS9gIDogcmVsUGF0aDtcblx0XHRcdGlmIChpZy5pZ25vcmVzKGlnbm9yZVBhdGgpKSB7XG5cdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0fVxuXG5cdFx0XHRpZiAoaXNEaXJlY3RvcnkpIHtcblx0XHRcdFx0Y29uc3Qgc3ViUmVzdWx0ID0gbG9hZFNraWxsc0Zyb21EaXJJbnRlcm5hbChmdWxsUGF0aCwgc291cmNlLCBmYWxzZSwgaWcsIHJvb3QpO1xuXHRcdFx0XHRza2lsbHMucHVzaCguLi5zdWJSZXN1bHQuc2tpbGxzKTtcblx0XHRcdFx0ZGlhZ25vc3RpY3MucHVzaCguLi5zdWJSZXN1bHQuZGlhZ25vc3RpY3MpO1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblxuXHRcdFx0aWYgKCFpc0ZpbGUpIHtcblx0XHRcdFx0Y29udGludWU7XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IGlzUm9vdE1kID0gaW5jbHVkZVJvb3RGaWxlcyAmJiBlbnRyeS5uYW1lLmVuZHNXaXRoKFwiLm1kXCIpO1xuXHRcdFx0Y29uc3QgaXNTa2lsbE1kID0gIWluY2x1ZGVSb290RmlsZXMgJiYgZW50cnkubmFtZSA9PT0gXCJTS0lMTC5tZFwiO1xuXHRcdFx0aWYgKCFpc1Jvb3RNZCAmJiAhaXNTa2lsbE1kKSB7XG5cdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCByZXN1bHQgPSBsb2FkU2tpbGxGcm9tRmlsZShmdWxsUGF0aCwgc291cmNlKTtcblx0XHRcdGlmIChyZXN1bHQuc2tpbGwpIHtcblx0XHRcdFx0c2tpbGxzLnB1c2gocmVzdWx0LnNraWxsKTtcblx0XHRcdH1cblx0XHRcdGRpYWdub3N0aWNzLnB1c2goLi4ucmVzdWx0LmRpYWdub3N0aWNzKTtcblx0XHR9XG5cdH0gY2F0Y2gge31cblxuXHRyZXR1cm4geyBza2lsbHMsIGRpYWdub3N0aWNzIH07XG59XG5cbmZ1bmN0aW9uIGxvYWRTa2lsbEZyb21GaWxlKFxuXHRmaWxlUGF0aDogc3RyaW5nLFxuXHRzb3VyY2U6IHN0cmluZyxcbik6IHsgc2tpbGw6IFNraWxsIHwgbnVsbDsgZGlhZ25vc3RpY3M6IFJlc291cmNlRGlhZ25vc3RpY1tdIH0ge1xuXHRjb25zdCBkaWFnbm9zdGljczogUmVzb3VyY2VEaWFnbm9zdGljW10gPSBbXTtcblxuXHR0cnkge1xuXHRcdGNvbnN0IHJhd0NvbnRlbnQgPSByZWFkRmlsZVN5bmMoZmlsZVBhdGgsIFwidXRmLThcIik7XG5cdFx0Y29uc3QgeyBmcm9udG1hdHRlciB9ID0gcGFyc2VGcm9udG1hdHRlcjxTa2lsbEZyb250bWF0dGVyPihyYXdDb250ZW50KTtcblx0XHRjb25zdCBza2lsbERpciA9IGRpcm5hbWUoZmlsZVBhdGgpO1xuXHRcdGNvbnN0IHBhcmVudERpck5hbWUgPSBiYXNlbmFtZShza2lsbERpcik7XG5cblx0XHQvLyBWYWxpZGF0ZSBkZXNjcmlwdGlvblxuXHRcdGNvbnN0IGRlc2NFcnJvcnMgPSB2YWxpZGF0ZURlc2NyaXB0aW9uKGZyb250bWF0dGVyLmRlc2NyaXB0aW9uKTtcblx0XHRmb3IgKGNvbnN0IGVycm9yIG9mIGRlc2NFcnJvcnMpIHtcblx0XHRcdGRpYWdub3N0aWNzLnB1c2goeyB0eXBlOiBcIndhcm5pbmdcIiwgbWVzc2FnZTogZXJyb3IsIHBhdGg6IGZpbGVQYXRoIH0pO1xuXHRcdH1cblxuXHRcdC8vIFVzZSBuYW1lIGZyb20gZnJvbnRtYXR0ZXIsIG9yIGZhbGwgYmFjayB0byBwYXJlbnQgZGlyZWN0b3J5IG5hbWVcblx0XHRjb25zdCBuYW1lID0gZnJvbnRtYXR0ZXIubmFtZSB8fCBwYXJlbnREaXJOYW1lO1xuXG5cdFx0Ly8gVmFsaWRhdGUgbmFtZVxuXHRcdGNvbnN0IG5hbWVFcnJvcnMgPSB2YWxpZGF0ZU5hbWUobmFtZSwgcGFyZW50RGlyTmFtZSk7XG5cdFx0Zm9yIChjb25zdCBlcnJvciBvZiBuYW1lRXJyb3JzKSB7XG5cdFx0XHRkaWFnbm9zdGljcy5wdXNoKHsgdHlwZTogXCJ3YXJuaW5nXCIsIG1lc3NhZ2U6IGVycm9yLCBwYXRoOiBmaWxlUGF0aCB9KTtcblx0XHR9XG5cblx0XHQvLyBTdGlsbCBsb2FkIHRoZSBza2lsbCBldmVuIHdpdGggd2FybmluZ3MgKHVubGVzcyBkZXNjcmlwdGlvbiBpcyBjb21wbGV0ZWx5IG1pc3NpbmcpXG5cdFx0aWYgKCFmcm9udG1hdHRlci5kZXNjcmlwdGlvbiB8fCBmcm9udG1hdHRlci5kZXNjcmlwdGlvbi50cmltKCkgPT09IFwiXCIpIHtcblx0XHRcdHJldHVybiB7IHNraWxsOiBudWxsLCBkaWFnbm9zdGljcyB9O1xuXHRcdH1cblxuXHRcdHJldHVybiB7XG5cdFx0XHRza2lsbDoge1xuXHRcdFx0XHRuYW1lLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogZnJvbnRtYXR0ZXIuZGVzY3JpcHRpb24sXG5cdFx0XHRcdGZpbGVQYXRoLFxuXHRcdFx0XHRiYXNlRGlyOiBza2lsbERpcixcblx0XHRcdFx0c291cmNlLFxuXHRcdFx0XHRkaXNhYmxlTW9kZWxJbnZvY2F0aW9uOiBmcm9udG1hdHRlcltcImRpc2FibGUtbW9kZWwtaW52b2NhdGlvblwiXSA9PT0gdHJ1ZSxcblx0XHRcdH0sXG5cdFx0XHRkaWFnbm9zdGljcyxcblx0XHR9O1xuXHR9IGNhdGNoIChlcnJvcikge1xuXHRcdGNvbnN0IG1lc3NhZ2UgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFwiZmFpbGVkIHRvIHBhcnNlIHNraWxsIGZpbGVcIjtcblx0XHRkaWFnbm9zdGljcy5wdXNoKHsgdHlwZTogXCJ3YXJuaW5nXCIsIG1lc3NhZ2UsIHBhdGg6IGZpbGVQYXRoIH0pO1xuXHRcdHJldHVybiB7IHNraWxsOiBudWxsLCBkaWFnbm9zdGljcyB9O1xuXHR9XG59XG5cbi8qKlxuICogRm9ybWF0IHNraWxscyBmb3IgaW5jbHVzaW9uIGluIGEgc3lzdGVtIHByb21wdC5cbiAqIFVzZXMgWE1MIGZvcm1hdCBwZXIgQWdlbnQgU2tpbGxzIHN0YW5kYXJkLlxuICogU2VlOiBodHRwczovL2FnZW50c2tpbGxzLmlvL2ludGVncmF0ZS1za2lsbHNcbiAqXG4gKiBTa2lsbHMgd2l0aCBkaXNhYmxlTW9kZWxJbnZvY2F0aW9uPXRydWUgYXJlIGV4Y2x1ZGVkIGZyb20gdGhlIHByb21wdFxuICogKHRoZXkgY2FuIG9ubHkgYmUgaW52b2tlZCBleHBsaWNpdGx5IHZpYSAvc2tpbGw6bmFtZSBjb21tYW5kcykuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXRTa2lsbHNGb3JQcm9tcHQoc2tpbGxzOiBTa2lsbFtdKTogc3RyaW5nIHtcblx0Y29uc3QgdmlzaWJsZVNraWxscyA9IHNraWxscy5maWx0ZXIoKHMpID0+ICFzLmRpc2FibGVNb2RlbEludm9jYXRpb24pO1xuXG5cdGlmICh2aXNpYmxlU2tpbGxzLmxlbmd0aCA9PT0gMCkge1xuXHRcdHJldHVybiBcIlwiO1xuXHR9XG5cblx0Y29uc3QgbGluZXMgPSBbXG5cdFx0XCJcXG5cXG5UaGUgZm9sbG93aW5nIHNraWxscyBwcm92aWRlIHNwZWNpYWxpemVkIGluc3RydWN0aW9ucyBmb3Igc3BlY2lmaWMgdGFza3MuXCIsXG5cdFx0XCJVc2UgdGhlIFNraWxsIHRvb2wgd2l0aCB0aGUgZXhhY3Qgc2tpbGwgbmFtZSBmcm9tIDxhdmFpbGFibGVfc2tpbGxzPiB3aGVuIHRoZSB0YXNrIG1hdGNoZXMgaXRzIGRlc2NyaXB0aW9uLlwiLFxuXHRcdFwiSWYgdGhlIFNraWxsIHRvb2wgcmVwb3J0cyBhbiB1bmtub3duIHNraWxsLCBkbyBub3QgZ3Vlc3M6IHVzZSBhbiBleGFjdCBuYW1lIGZyb20gPGF2YWlsYWJsZV9za2lsbHM+IG9yIHRlbGwgdGhlIHVzZXIgdGhlIHNraWxsIGlzIHVuYXZhaWxhYmxlLlwiLFxuXHRcdFwiV2hlbiBhIHNraWxsIGZpbGUgcmVmZXJlbmNlcyBhIHJlbGF0aXZlIHBhdGgsIHJlc29sdmUgaXQgYWdhaW5zdCB0aGUgc2tpbGwgZGlyZWN0b3J5IChwYXJlbnQgb2YgU0tJTEwubWQgLyBkaXJuYW1lIG9mIHRoZSBwYXRoKSBhbmQgdXNlIHRoYXQgYWJzb2x1dGUgcGF0aCBpbiB0b29sIGNvbW1hbmRzLlwiLFxuXHRcdFwiXCIsXG5cdFx0XCI8YXZhaWxhYmxlX3NraWxscz5cIixcblx0XTtcblxuXHRmb3IgKGNvbnN0IHNraWxsIG9mIHZpc2libGVTa2lsbHMpIHtcblx0XHRsaW5lcy5wdXNoKFwiICA8c2tpbGw+XCIpO1xuXHRcdGxpbmVzLnB1c2goYCAgICA8bmFtZT4ke2VzY2FwZVhtbChza2lsbC5uYW1lKX08L25hbWU+YCk7XG5cdFx0bGluZXMucHVzaChgICAgIDxkZXNjcmlwdGlvbj4ke2VzY2FwZVhtbChza2lsbC5kZXNjcmlwdGlvbil9PC9kZXNjcmlwdGlvbj5gKTtcblx0XHRsaW5lcy5wdXNoKGAgICAgPGxvY2F0aW9uPiR7ZXNjYXBlWG1sKHNraWxsLmZpbGVQYXRoKX08L2xvY2F0aW9uPmApO1xuXHRcdGxpbmVzLnB1c2goXCIgIDwvc2tpbGw+XCIpO1xuXHR9XG5cblx0bGluZXMucHVzaChcIjwvYXZhaWxhYmxlX3NraWxscz5cIik7XG5cblx0cmV0dXJuIGxpbmVzLmpvaW4oXCJcXG5cIik7XG59XG5cbmZ1bmN0aW9uIGVzY2FwZVhtbChzdHI6IHN0cmluZyk6IHN0cmluZyB7XG5cdHJldHVybiBzdHJcblx0XHQucmVwbGFjZSgvJi9nLCBcIiZhbXA7XCIpXG5cdFx0LnJlcGxhY2UoLzwvZywgXCImbHQ7XCIpXG5cdFx0LnJlcGxhY2UoLz4vZywgXCImZ3Q7XCIpXG5cdFx0LnJlcGxhY2UoL1wiL2csIFwiJnF1b3Q7XCIpXG5cdFx0LnJlcGxhY2UoLycvZywgXCImYXBvcztcIik7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgTG9hZFNraWxsc09wdGlvbnMge1xuXHQvKiogV29ya2luZyBkaXJlY3RvcnkgZm9yIHByb2plY3QtbG9jYWwgc2tpbGxzLiBEZWZhdWx0OiBwcm9jZXNzLmN3ZCgpICovXG5cdGN3ZD86IHN0cmluZztcblx0LyoqIEBkZXByZWNhdGVkIFNraWxscyBub3cgdXNlIH4vLmFnZW50cy9za2lsbHMvIGV4Y2x1c2l2ZWx5LiBUaGlzIG9wdGlvbiBpcyBpZ25vcmVkLiAqL1xuXHRhZ2VudERpcj86IHN0cmluZztcblx0LyoqIEV4cGxpY2l0IHNraWxsIHBhdGhzIChmaWxlcyBvciBkaXJlY3RvcmllcykgKi9cblx0c2tpbGxQYXRocz86IHN0cmluZ1tdO1xuXHQvKiogSW5jbHVkZSBkZWZhdWx0IHNraWxscyBkaXJlY3Rvcmllcy4gRGVmYXVsdDogdHJ1ZSAqL1xuXHRpbmNsdWRlRGVmYXVsdHM/OiBib29sZWFuO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVQYXRoKGlucHV0OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRjb25zdCB0cmltbWVkID0gaW5wdXQudHJpbSgpO1xuXHRpZiAodHJpbW1lZCA9PT0gXCJ+XCIpIHJldHVybiBob21lZGlyKCk7XG5cdGlmICh0cmltbWVkLnN0YXJ0c1dpdGgoXCJ+L1wiKSkgcmV0dXJuIGpvaW4oaG9tZWRpcigpLCB0cmltbWVkLnNsaWNlKDIpKTtcblx0aWYgKHRyaW1tZWQuc3RhcnRzV2l0aChcIn5cIikpIHJldHVybiBqb2luKGhvbWVkaXIoKSwgdHJpbW1lZC5zbGljZSgxKSk7XG5cdHJldHVybiB0cmltbWVkO1xufVxuXG5mdW5jdGlvbiByZXNvbHZlU2tpbGxQYXRoKHA6IHN0cmluZywgY3dkOiBzdHJpbmcpOiBzdHJpbmcge1xuXHRjb25zdCBub3JtYWxpemVkID0gbm9ybWFsaXplUGF0aChwKTtcblx0cmV0dXJuIGlzQWJzb2x1dGUobm9ybWFsaXplZCkgPyBub3JtYWxpemVkIDogcmVzb2x2ZShjd2QsIG5vcm1hbGl6ZWQpO1xufVxuXG4vKipcbiAqIExvYWQgc2tpbGxzIGZyb20gYWxsIGNvbmZpZ3VyZWQgbG9jYXRpb25zLlxuICogUmV0dXJucyBza2lsbHMgYW5kIGFueSB2YWxpZGF0aW9uIGRpYWdub3N0aWNzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbG9hZFNraWxscyhvcHRpb25zOiBMb2FkU2tpbGxzT3B0aW9ucyA9IHt9KTogTG9hZFNraWxsc1Jlc3VsdCB7XG5cdGNvbnN0IHsgY3dkID0gcHJvY2Vzcy5jd2QoKSwgc2tpbGxQYXRocyA9IFtdLCBpbmNsdWRlRGVmYXVsdHMgPSB0cnVlIH0gPSBvcHRpb25zO1xuXG5cdGNvbnN0IHNraWxsTWFwID0gbmV3IE1hcDxzdHJpbmcsIFNraWxsPigpO1xuXHRjb25zdCByZWFsUGF0aFNldCA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXHRjb25zdCBhbGxEaWFnbm9zdGljczogUmVzb3VyY2VEaWFnbm9zdGljW10gPSBbXTtcblx0Y29uc3QgY29sbGlzaW9uRGlhZ25vc3RpY3M6IFJlc291cmNlRGlhZ25vc3RpY1tdID0gW107XG5cblx0ZnVuY3Rpb24gYWRkU2tpbGxzKHJlc3VsdDogTG9hZFNraWxsc1Jlc3VsdCkge1xuXHRcdGFsbERpYWdub3N0aWNzLnB1c2goLi4ucmVzdWx0LmRpYWdub3N0aWNzKTtcblx0XHRmb3IgKGNvbnN0IHNraWxsIG9mIHJlc3VsdC5za2lsbHMpIHtcblx0XHRcdC8vIFJlc29sdmUgc3ltbGlua3MgdG8gZGV0ZWN0IGR1cGxpY2F0ZSBmaWxlc1xuXHRcdFx0bGV0IHJlYWxQYXRoOiBzdHJpbmc7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRyZWFsUGF0aCA9IHJlYWxwYXRoU3luYyhza2lsbC5maWxlUGF0aCk7XG5cdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0cmVhbFBhdGggPSBza2lsbC5maWxlUGF0aDtcblx0XHRcdH1cblxuXHRcdFx0Ly8gU2tpcCBzaWxlbnRseSBpZiB3ZSd2ZSBhbHJlYWR5IGxvYWRlZCB0aGlzIGV4YWN0IGZpbGUgKHZpYSBzeW1saW5rKVxuXHRcdFx0aWYgKHJlYWxQYXRoU2V0LmhhcyhyZWFsUGF0aCkpIHtcblx0XHRcdFx0Y29udGludWU7XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IGV4aXN0aW5nID0gc2tpbGxNYXAuZ2V0KHNraWxsLm5hbWUpO1xuXHRcdFx0aWYgKGV4aXN0aW5nKSB7XG5cdFx0XHRcdGNvbGxpc2lvbkRpYWdub3N0aWNzLnB1c2goe1xuXHRcdFx0XHRcdHR5cGU6IFwiY29sbGlzaW9uXCIsXG5cdFx0XHRcdFx0bWVzc2FnZTogYG5hbWUgXCIke3NraWxsLm5hbWV9XCIgY29sbGlzaW9uYCxcblx0XHRcdFx0XHRwYXRoOiBza2lsbC5maWxlUGF0aCxcblx0XHRcdFx0XHRjb2xsaXNpb246IHtcblx0XHRcdFx0XHRcdHJlc291cmNlVHlwZTogXCJza2lsbFwiLFxuXHRcdFx0XHRcdFx0bmFtZTogc2tpbGwubmFtZSxcblx0XHRcdFx0XHRcdHdpbm5lclBhdGg6IGV4aXN0aW5nLmZpbGVQYXRoLFxuXHRcdFx0XHRcdFx0bG9zZXJQYXRoOiBza2lsbC5maWxlUGF0aCxcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHR9KTtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdHNraWxsTWFwLnNldChza2lsbC5uYW1lLCBza2lsbCk7XG5cdFx0XHRcdHJlYWxQYXRoU2V0LmFkZChyZWFsUGF0aCk7XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG5cblx0aWYgKGluY2x1ZGVEZWZhdWx0cykge1xuXHRcdC8vIFByaW1hcnk6IH4vLmFnZW50cy9za2lsbHMvIFx1MjAxNCB0aGUgaW5kdXN0cnktc3RhbmRhcmQgc2tpbGxzLnNoIGxvY2F0aW9uXG5cdFx0YWRkU2tpbGxzKGxvYWRTa2lsbHNGcm9tRGlySW50ZXJuYWwoRUNPU1lTVEVNX1NLSUxMU19ESVIsIFwidXNlclwiLCB0cnVlKSk7XG5cdFx0Ly8gUHJpbWFyeSBwcm9qZWN0OiAuYWdlbnRzL3NraWxscy8gXHUyMDE0IHN0YW5kYXJkIHByb2plY3QtbGV2ZWwgbG9jYXRpb25cblx0XHRhZGRTa2lsbHMobG9hZFNraWxsc0Zyb21EaXJJbnRlcm5hbChyZXNvbHZlKGN3ZCwgRUNPU1lTVEVNX1BST0pFQ1RfU0tJTExTX0RJUiwgXCJza2lsbHNcIiksIFwicHJvamVjdFwiLCB0cnVlKSk7XG5cblx0XHQvLyBMZWdhY3kgZmFsbGJhY2s6IHJlYWQgc2tpbGxzIGZyb20gfi8uZ3NkL2FnZW50L3NraWxscy8gc28gZXhpc3Rpbmdcblx0XHQvLyBpbnN0YWxscyBrZWVwIHdvcmtpbmcgdW50aWwgdGhlIG9uZS10aW1lIG1pZ3JhdGlvbiBpbiByZXNvdXJjZS1sb2FkZXJcblx0XHQvLyBjb3BpZXMgdGhlbSB0byB+Ly5hZ2VudHMvc2tpbGxzLy4gU2tpcCBpZiBtaWdyYXRpb24gaGFzIGNvbXBsZXRlZC5cblx0XHRjb25zdCBsZWdhY3lNaWdyYXRlZCA9IGV4aXN0c1N5bmMoam9pbihMRUdBQ1lfU0tJTExTX0RJUiwgXCIubWlncmF0ZWQtdG8tYWdlbnRzXCIpKTtcblx0XHRpZiAoTEVHQUNZX1NLSUxMU19ESVIgIT09IEVDT1NZU1RFTV9TS0lMTFNfRElSICYmIGV4aXN0c1N5bmMoTEVHQUNZX1NLSUxMU19ESVIpICYmICFsZWdhY3lNaWdyYXRlZCkge1xuXHRcdFx0YWRkU2tpbGxzKGxvYWRTa2lsbHNGcm9tRGlySW50ZXJuYWwoTEVHQUNZX1NLSUxMU19ESVIsIFwidXNlclwiLCB0cnVlKSk7XG5cdFx0fVxuXHR9XG5cblx0Y29uc3QgdXNlclNraWxsc0RpciA9IEVDT1NZU1RFTV9TS0lMTFNfRElSO1xuXHRjb25zdCBwcm9qZWN0U2tpbGxzRGlyID0gcmVzb2x2ZShjd2QsIEVDT1NZU1RFTV9QUk9KRUNUX1NLSUxMU19ESVIsIFwic2tpbGxzXCIpO1xuXG5cdGNvbnN0IGlzVW5kZXJQYXRoID0gKHRhcmdldDogc3RyaW5nLCByb290OiBzdHJpbmcpOiBib29sZWFuID0+IHtcblx0XHRjb25zdCBub3JtYWxpemVkUm9vdCA9IHJlc29sdmUocm9vdCk7XG5cdFx0aWYgKHRhcmdldCA9PT0gbm9ybWFsaXplZFJvb3QpIHtcblx0XHRcdHJldHVybiB0cnVlO1xuXHRcdH1cblx0XHRjb25zdCBwcmVmaXggPSBub3JtYWxpemVkUm9vdC5lbmRzV2l0aChzZXApID8gbm9ybWFsaXplZFJvb3QgOiBgJHtub3JtYWxpemVkUm9vdH0ke3NlcH1gO1xuXHRcdHJldHVybiB0YXJnZXQuc3RhcnRzV2l0aChwcmVmaXgpO1xuXHR9O1xuXG5cdGNvbnN0IGdldFNvdXJjZSA9IChyZXNvbHZlZFBhdGg6IHN0cmluZyk6IFwidXNlclwiIHwgXCJwcm9qZWN0XCIgfCBcInBhdGhcIiA9PiB7XG5cdFx0aWYgKCFpbmNsdWRlRGVmYXVsdHMpIHtcblx0XHRcdGlmIChpc1VuZGVyUGF0aChyZXNvbHZlZFBhdGgsIHVzZXJTa2lsbHNEaXIpKSByZXR1cm4gXCJ1c2VyXCI7XG5cdFx0XHRpZiAoaXNVbmRlclBhdGgocmVzb2x2ZWRQYXRoLCBwcm9qZWN0U2tpbGxzRGlyKSkgcmV0dXJuIFwicHJvamVjdFwiO1xuXHRcdH1cblx0XHRyZXR1cm4gXCJwYXRoXCI7XG5cdH07XG5cblx0Zm9yIChjb25zdCByYXdQYXRoIG9mIHNraWxsUGF0aHMpIHtcblx0XHRjb25zdCByZXNvbHZlZFBhdGggPSByZXNvbHZlU2tpbGxQYXRoKHJhd1BhdGgsIGN3ZCk7XG5cdFx0aWYgKCFleGlzdHNTeW5jKHJlc29sdmVkUGF0aCkpIHtcblx0XHRcdGFsbERpYWdub3N0aWNzLnB1c2goeyB0eXBlOiBcIndhcm5pbmdcIiwgbWVzc2FnZTogXCJza2lsbCBwYXRoIGRvZXMgbm90IGV4aXN0XCIsIHBhdGg6IHJlc29sdmVkUGF0aCB9KTtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBzdGF0cyA9IHN0YXRTeW5jKHJlc29sdmVkUGF0aCk7XG5cdFx0XHRjb25zdCBzb3VyY2UgPSBnZXRTb3VyY2UocmVzb2x2ZWRQYXRoKTtcblx0XHRcdGlmIChzdGF0cy5pc0RpcmVjdG9yeSgpKSB7XG5cdFx0XHRcdGFkZFNraWxscyhsb2FkU2tpbGxzRnJvbURpckludGVybmFsKHJlc29sdmVkUGF0aCwgc291cmNlLCB0cnVlKSk7XG5cdFx0XHR9IGVsc2UgaWYgKHN0YXRzLmlzRmlsZSgpICYmIHJlc29sdmVkUGF0aC5lbmRzV2l0aChcIi5tZFwiKSkge1xuXHRcdFx0XHRjb25zdCByZXN1bHQgPSBsb2FkU2tpbGxGcm9tRmlsZShyZXNvbHZlZFBhdGgsIHNvdXJjZSk7XG5cdFx0XHRcdGlmIChyZXN1bHQuc2tpbGwpIHtcblx0XHRcdFx0XHRhZGRTa2lsbHMoeyBza2lsbHM6IFtyZXN1bHQuc2tpbGxdLCBkaWFnbm9zdGljczogcmVzdWx0LmRpYWdub3N0aWNzIH0pO1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdGFsbERpYWdub3N0aWNzLnB1c2goLi4ucmVzdWx0LmRpYWdub3N0aWNzKTtcblx0XHRcdFx0fVxuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0YWxsRGlhZ25vc3RpY3MucHVzaCh7IHR5cGU6IFwid2FybmluZ1wiLCBtZXNzYWdlOiBcInNraWxsIHBhdGggaXMgbm90IGEgbWFya2Rvd24gZmlsZVwiLCBwYXRoOiByZXNvbHZlZFBhdGggfSk7XG5cdFx0XHR9XG5cdFx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRcdGNvbnN0IG1lc3NhZ2UgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFwiZmFpbGVkIHRvIHJlYWQgc2tpbGwgcGF0aFwiO1xuXHRcdFx0YWxsRGlhZ25vc3RpY3MucHVzaCh7IHR5cGU6IFwid2FybmluZ1wiLCBtZXNzYWdlLCBwYXRoOiByZXNvbHZlZFBhdGggfSk7XG5cdFx0fVxuXHR9XG5cblx0bG9hZGVkU2tpbGxzID0gQXJyYXkuZnJvbShza2lsbE1hcC52YWx1ZXMoKSk7XG5cblx0cmV0dXJuIHtcblx0XHRza2lsbHM6IFsuLi5sb2FkZWRTa2lsbHNdLFxuXHRcdGRpYWdub3N0aWNzOiBbLi4uYWxsRGlhZ25vc3RpY3MsIC4uLmNvbGxpc2lvbkRpYWdub3N0aWNzXSxcblx0fTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFNBQVMsWUFBWSxhQUFhLGNBQWMsY0FBYyxnQkFBZ0I7QUFDOUUsT0FBTyxZQUFZO0FBQ25CLFNBQVMsZUFBZTtBQUN4QixTQUFTLFVBQVUsU0FBUyxZQUFZLE1BQU0sVUFBVSxTQUFTLFdBQVc7QUFDNUUsU0FBUyx3QkFBd0I7QUFDakMsU0FBUyxtQkFBbUI7QUFFNUIsU0FBUyx1QkFBdUI7QUFPekIsTUFBTSx1QkFBdUIsS0FBSyxRQUFRLEdBQUcsV0FBVyxRQUFRO0FBS2hFLE1BQU0sK0JBQStCO0FBTTVDLE1BQU0sb0JBQW9CLEtBQUssUUFBUSxHQUFHLGlCQUFpQixTQUFTLFFBQVE7QUFHNUUsTUFBTSxrQkFBa0I7QUFHeEIsTUFBTSx5QkFBeUI7QUFFL0IsTUFBTSxvQkFBb0IsQ0FBQyxjQUFjLFdBQVcsV0FBVztBQUkvRCxTQUFTLG9CQUFvQixNQUFjLFFBQStCO0FBQ3pFLFFBQU0sVUFBVSxLQUFLLEtBQUs7QUFDMUIsTUFBSSxDQUFDLFFBQVMsUUFBTztBQUNyQixNQUFJLFFBQVEsV0FBVyxHQUFHLEtBQUssQ0FBQyxRQUFRLFdBQVcsS0FBSyxFQUFHLFFBQU87QUFFbEUsTUFBSSxVQUFVO0FBQ2QsTUFBSSxVQUFVO0FBRWQsTUFBSSxRQUFRLFdBQVcsR0FBRyxHQUFHO0FBQzVCLGNBQVU7QUFDVixjQUFVLFFBQVEsTUFBTSxDQUFDO0FBQUEsRUFDMUIsV0FBVyxRQUFRLFdBQVcsS0FBSyxHQUFHO0FBQ3JDLGNBQVUsUUFBUSxNQUFNLENBQUM7QUFBQSxFQUMxQjtBQUVBLE1BQUksUUFBUSxXQUFXLEdBQUcsR0FBRztBQUM1QixjQUFVLFFBQVEsTUFBTSxDQUFDO0FBQUEsRUFDMUI7QUFFQSxRQUFNLFdBQVcsU0FBUyxHQUFHLE1BQU0sR0FBRyxPQUFPLEtBQUs7QUFDbEQsU0FBTyxVQUFVLElBQUksUUFBUSxLQUFLO0FBQ25DO0FBRUEsU0FBUyxlQUFlLElBQW1CLEtBQWEsU0FBdUI7QUFDOUUsUUFBTSxjQUFjLFNBQVMsU0FBUyxHQUFHO0FBQ3pDLFFBQU0sU0FBUyxjQUFjLEdBQUcsWUFBWSxXQUFXLENBQUMsTUFBTTtBQUU5RCxhQUFXLFlBQVksbUJBQW1CO0FBQ3pDLFVBQU0sYUFBYSxLQUFLLEtBQUssUUFBUTtBQUNyQyxRQUFJLENBQUMsV0FBVyxVQUFVLEVBQUc7QUFDN0IsUUFBSTtBQUNILFlBQU0sVUFBVSxhQUFhLFlBQVksT0FBTztBQUNoRCxZQUFNLFdBQVcsUUFDZixNQUFNLE9BQU8sRUFDYixJQUFJLENBQUMsU0FBUyxvQkFBb0IsTUFBTSxNQUFNLENBQUMsRUFDL0MsT0FBTyxDQUFDLFNBQXlCLFFBQVEsSUFBSSxDQUFDO0FBQ2hELFVBQUksU0FBUyxTQUFTLEdBQUc7QUFDeEIsV0FBRyxJQUFJLFFBQVE7QUFBQSxNQUNoQjtBQUFBLElBQ0QsUUFBUTtBQUFBLElBQUM7QUFBQSxFQUNWO0FBQ0Q7QUF1QkEsSUFBSSxlQUF3QixDQUFDO0FBRXRCLFNBQVMsa0JBQTJCO0FBQzFDLFNBQU8sQ0FBQyxHQUFHLFlBQVk7QUFDeEI7QUFNQSxTQUFTLGFBQWEsTUFBYyxlQUFpQztBQUNwRSxRQUFNLFNBQW1CLENBQUM7QUFFMUIsTUFBSSxTQUFTLGVBQWU7QUFDM0IsV0FBTyxLQUFLLFNBQVMsSUFBSSxzQ0FBc0MsYUFBYSxHQUFHO0FBQUEsRUFDaEY7QUFFQSxNQUFJLEtBQUssU0FBUyxpQkFBaUI7QUFDbEMsV0FBTyxLQUFLLGdCQUFnQixlQUFlLGdCQUFnQixLQUFLLE1BQU0sR0FBRztBQUFBLEVBQzFFO0FBRUEsTUFBSSxDQUFDLGVBQWUsS0FBSyxJQUFJLEdBQUc7QUFDL0IsV0FBTyxLQUFLLDZFQUE2RTtBQUFBLEVBQzFGO0FBRUEsTUFBSSxLQUFLLFdBQVcsR0FBRyxLQUFLLEtBQUssU0FBUyxHQUFHLEdBQUc7QUFDL0MsV0FBTyxLQUFLLDBDQUEwQztBQUFBLEVBQ3ZEO0FBRUEsTUFBSSxLQUFLLFNBQVMsSUFBSSxHQUFHO0FBQ3hCLFdBQU8sS0FBSywyQ0FBMkM7QUFBQSxFQUN4RDtBQUVBLFNBQU87QUFDUjtBQUtBLFNBQVMsb0JBQW9CLGFBQTJDO0FBQ3ZFLFFBQU0sU0FBbUIsQ0FBQztBQUUxQixNQUFJLENBQUMsZUFBZSxZQUFZLEtBQUssTUFBTSxJQUFJO0FBQzlDLFdBQU8sS0FBSyx5QkFBeUI7QUFBQSxFQUN0QyxXQUFXLFlBQVksU0FBUyx3QkFBd0I7QUFDdkQsV0FBTyxLQUFLLHVCQUF1QixzQkFBc0IsZ0JBQWdCLFlBQVksTUFBTSxHQUFHO0FBQUEsRUFDL0Y7QUFFQSxTQUFPO0FBQ1I7QUFnQk8sU0FBUyxrQkFBa0IsU0FBcUQ7QUFDdEYsUUFBTSxFQUFFLEtBQUssT0FBTyxJQUFJO0FBQ3hCLFNBQU8sMEJBQTBCLEtBQUssUUFBUSxJQUFJO0FBQ25EO0FBRUEsU0FBUywwQkFDUixLQUNBLFFBQ0Esa0JBQ0EsZUFDQSxTQUNtQjtBQUNuQixRQUFNLFNBQWtCLENBQUM7QUFDekIsUUFBTSxjQUFvQyxDQUFDO0FBRTNDLE1BQUksQ0FBQyxXQUFXLEdBQUcsR0FBRztBQUNyQixXQUFPLEVBQUUsUUFBUSxZQUFZO0FBQUEsRUFDOUI7QUFFQSxRQUFNLE9BQU8sV0FBVztBQUN4QixRQUFNLEtBQUssaUJBQWlCLE9BQU87QUFDbkMsaUJBQWUsSUFBSSxLQUFLLElBQUk7QUFFNUIsTUFBSTtBQUNILFVBQU0sVUFBVSxZQUFZLEtBQUssRUFBRSxlQUFlLEtBQUssQ0FBQztBQUV4RCxlQUFXLFNBQVMsU0FBUztBQUM1QixVQUFJLE1BQU0sS0FBSyxXQUFXLEdBQUcsR0FBRztBQUMvQjtBQUFBLE1BQ0Q7QUFHQSxVQUFJLE1BQU0sU0FBUyxnQkFBZ0I7QUFDbEM7QUFBQSxNQUNEO0FBRUEsWUFBTSxXQUFXLEtBQUssS0FBSyxNQUFNLElBQUk7QUFHckMsVUFBSSxjQUFjLE1BQU0sWUFBWTtBQUNwQyxVQUFJLFNBQVMsTUFBTSxPQUFPO0FBQzFCLFVBQUksTUFBTSxlQUFlLEdBQUc7QUFDM0IsWUFBSTtBQUNILGdCQUFNLFFBQVEsU0FBUyxRQUFRO0FBQy9CLHdCQUFjLE1BQU0sWUFBWTtBQUNoQyxtQkFBUyxNQUFNLE9BQU87QUFBQSxRQUN2QixRQUFRO0FBRVA7QUFBQSxRQUNEO0FBQUEsTUFDRDtBQUVBLFlBQU0sVUFBVSxZQUFZLFNBQVMsTUFBTSxRQUFRLENBQUM7QUFDcEQsWUFBTSxhQUFhLGNBQWMsR0FBRyxPQUFPLE1BQU07QUFDakQsVUFBSSxHQUFHLFFBQVEsVUFBVSxHQUFHO0FBQzNCO0FBQUEsTUFDRDtBQUVBLFVBQUksYUFBYTtBQUNoQixjQUFNLFlBQVksMEJBQTBCLFVBQVUsUUFBUSxPQUFPLElBQUksSUFBSTtBQUM3RSxlQUFPLEtBQUssR0FBRyxVQUFVLE1BQU07QUFDL0Isb0JBQVksS0FBSyxHQUFHLFVBQVUsV0FBVztBQUN6QztBQUFBLE1BQ0Q7QUFFQSxVQUFJLENBQUMsUUFBUTtBQUNaO0FBQUEsTUFDRDtBQUVBLFlBQU0sV0FBVyxvQkFBb0IsTUFBTSxLQUFLLFNBQVMsS0FBSztBQUM5RCxZQUFNLFlBQVksQ0FBQyxvQkFBb0IsTUFBTSxTQUFTO0FBQ3RELFVBQUksQ0FBQyxZQUFZLENBQUMsV0FBVztBQUM1QjtBQUFBLE1BQ0Q7QUFFQSxZQUFNLFNBQVMsa0JBQWtCLFVBQVUsTUFBTTtBQUNqRCxVQUFJLE9BQU8sT0FBTztBQUNqQixlQUFPLEtBQUssT0FBTyxLQUFLO0FBQUEsTUFDekI7QUFDQSxrQkFBWSxLQUFLLEdBQUcsT0FBTyxXQUFXO0FBQUEsSUFDdkM7QUFBQSxFQUNELFFBQVE7QUFBQSxFQUFDO0FBRVQsU0FBTyxFQUFFLFFBQVEsWUFBWTtBQUM5QjtBQUVBLFNBQVMsa0JBQ1IsVUFDQSxRQUM2RDtBQUM3RCxRQUFNLGNBQW9DLENBQUM7QUFFM0MsTUFBSTtBQUNILFVBQU0sYUFBYSxhQUFhLFVBQVUsT0FBTztBQUNqRCxVQUFNLEVBQUUsWUFBWSxJQUFJLGlCQUFtQyxVQUFVO0FBQ3JFLFVBQU0sV0FBVyxRQUFRLFFBQVE7QUFDakMsVUFBTSxnQkFBZ0IsU0FBUyxRQUFRO0FBR3ZDLFVBQU0sYUFBYSxvQkFBb0IsWUFBWSxXQUFXO0FBQzlELGVBQVcsU0FBUyxZQUFZO0FBQy9CLGtCQUFZLEtBQUssRUFBRSxNQUFNLFdBQVcsU0FBUyxPQUFPLE1BQU0sU0FBUyxDQUFDO0FBQUEsSUFDckU7QUFHQSxVQUFNLE9BQU8sWUFBWSxRQUFRO0FBR2pDLFVBQU0sYUFBYSxhQUFhLE1BQU0sYUFBYTtBQUNuRCxlQUFXLFNBQVMsWUFBWTtBQUMvQixrQkFBWSxLQUFLLEVBQUUsTUFBTSxXQUFXLFNBQVMsT0FBTyxNQUFNLFNBQVMsQ0FBQztBQUFBLElBQ3JFO0FBR0EsUUFBSSxDQUFDLFlBQVksZUFBZSxZQUFZLFlBQVksS0FBSyxNQUFNLElBQUk7QUFDdEUsYUFBTyxFQUFFLE9BQU8sTUFBTSxZQUFZO0FBQUEsSUFDbkM7QUFFQSxXQUFPO0FBQUEsTUFDTixPQUFPO0FBQUEsUUFDTjtBQUFBLFFBQ0EsYUFBYSxZQUFZO0FBQUEsUUFDekI7QUFBQSxRQUNBLFNBQVM7QUFBQSxRQUNUO0FBQUEsUUFDQSx3QkFBd0IsWUFBWSwwQkFBMEIsTUFBTTtBQUFBLE1BQ3JFO0FBQUEsTUFDQTtBQUFBLElBQ0Q7QUFBQSxFQUNELFNBQVMsT0FBTztBQUNmLFVBQU0sVUFBVSxpQkFBaUIsUUFBUSxNQUFNLFVBQVU7QUFDekQsZ0JBQVksS0FBSyxFQUFFLE1BQU0sV0FBVyxTQUFTLE1BQU0sU0FBUyxDQUFDO0FBQzdELFdBQU8sRUFBRSxPQUFPLE1BQU0sWUFBWTtBQUFBLEVBQ25DO0FBQ0Q7QUFVTyxTQUFTLHNCQUFzQixRQUF5QjtBQUM5RCxRQUFNLGdCQUFnQixPQUFPLE9BQU8sQ0FBQyxNQUFNLENBQUMsRUFBRSxzQkFBc0I7QUFFcEUsTUFBSSxjQUFjLFdBQVcsR0FBRztBQUMvQixXQUFPO0FBQUEsRUFDUjtBQUVBLFFBQU0sUUFBUTtBQUFBLElBQ2I7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLEVBQ0Q7QUFFQSxhQUFXLFNBQVMsZUFBZTtBQUNsQyxVQUFNLEtBQUssV0FBVztBQUN0QixVQUFNLEtBQUssYUFBYSxVQUFVLE1BQU0sSUFBSSxDQUFDLFNBQVM7QUFDdEQsVUFBTSxLQUFLLG9CQUFvQixVQUFVLE1BQU0sV0FBVyxDQUFDLGdCQUFnQjtBQUMzRSxVQUFNLEtBQUssaUJBQWlCLFVBQVUsTUFBTSxRQUFRLENBQUMsYUFBYTtBQUNsRSxVQUFNLEtBQUssWUFBWTtBQUFBLEVBQ3hCO0FBRUEsUUFBTSxLQUFLLHFCQUFxQjtBQUVoQyxTQUFPLE1BQU0sS0FBSyxJQUFJO0FBQ3ZCO0FBRUEsU0FBUyxVQUFVLEtBQXFCO0FBQ3ZDLFNBQU8sSUFDTCxRQUFRLE1BQU0sT0FBTyxFQUNyQixRQUFRLE1BQU0sTUFBTSxFQUNwQixRQUFRLE1BQU0sTUFBTSxFQUNwQixRQUFRLE1BQU0sUUFBUSxFQUN0QixRQUFRLE1BQU0sUUFBUTtBQUN6QjtBQWFBLFNBQVMsY0FBYyxPQUF1QjtBQUM3QyxRQUFNLFVBQVUsTUFBTSxLQUFLO0FBQzNCLE1BQUksWUFBWSxJQUFLLFFBQU8sUUFBUTtBQUNwQyxNQUFJLFFBQVEsV0FBVyxJQUFJLEVBQUcsUUFBTyxLQUFLLFFBQVEsR0FBRyxRQUFRLE1BQU0sQ0FBQyxDQUFDO0FBQ3JFLE1BQUksUUFBUSxXQUFXLEdBQUcsRUFBRyxRQUFPLEtBQUssUUFBUSxHQUFHLFFBQVEsTUFBTSxDQUFDLENBQUM7QUFDcEUsU0FBTztBQUNSO0FBRUEsU0FBUyxpQkFBaUIsR0FBVyxLQUFxQjtBQUN6RCxRQUFNLGFBQWEsY0FBYyxDQUFDO0FBQ2xDLFNBQU8sV0FBVyxVQUFVLElBQUksYUFBYSxRQUFRLEtBQUssVUFBVTtBQUNyRTtBQU1PLFNBQVMsV0FBVyxVQUE2QixDQUFDLEdBQXFCO0FBQzdFLFFBQU0sRUFBRSxNQUFNLFFBQVEsSUFBSSxHQUFHLGFBQWEsQ0FBQyxHQUFHLGtCQUFrQixLQUFLLElBQUk7QUFFekUsUUFBTSxXQUFXLG9CQUFJLElBQW1CO0FBQ3hDLFFBQU0sY0FBYyxvQkFBSSxJQUFZO0FBQ3BDLFFBQU0saUJBQXVDLENBQUM7QUFDOUMsUUFBTSx1QkFBNkMsQ0FBQztBQUVwRCxXQUFTLFVBQVUsUUFBMEI7QUFDNUMsbUJBQWUsS0FBSyxHQUFHLE9BQU8sV0FBVztBQUN6QyxlQUFXLFNBQVMsT0FBTyxRQUFRO0FBRWxDLFVBQUk7QUFDSixVQUFJO0FBQ0gsbUJBQVcsYUFBYSxNQUFNLFFBQVE7QUFBQSxNQUN2QyxRQUFRO0FBQ1AsbUJBQVcsTUFBTTtBQUFBLE1BQ2xCO0FBR0EsVUFBSSxZQUFZLElBQUksUUFBUSxHQUFHO0FBQzlCO0FBQUEsTUFDRDtBQUVBLFlBQU0sV0FBVyxTQUFTLElBQUksTUFBTSxJQUFJO0FBQ3hDLFVBQUksVUFBVTtBQUNiLDZCQUFxQixLQUFLO0FBQUEsVUFDekIsTUFBTTtBQUFBLFVBQ04sU0FBUyxTQUFTLE1BQU0sSUFBSTtBQUFBLFVBQzVCLE1BQU0sTUFBTTtBQUFBLFVBQ1osV0FBVztBQUFBLFlBQ1YsY0FBYztBQUFBLFlBQ2QsTUFBTSxNQUFNO0FBQUEsWUFDWixZQUFZLFNBQVM7QUFBQSxZQUNyQixXQUFXLE1BQU07QUFBQSxVQUNsQjtBQUFBLFFBQ0QsQ0FBQztBQUFBLE1BQ0YsT0FBTztBQUNOLGlCQUFTLElBQUksTUFBTSxNQUFNLEtBQUs7QUFDOUIsb0JBQVksSUFBSSxRQUFRO0FBQUEsTUFDekI7QUFBQSxJQUNEO0FBQUEsRUFDRDtBQUVBLE1BQUksaUJBQWlCO0FBRXBCLGNBQVUsMEJBQTBCLHNCQUFzQixRQUFRLElBQUksQ0FBQztBQUV2RSxjQUFVLDBCQUEwQixRQUFRLEtBQUssOEJBQThCLFFBQVEsR0FBRyxXQUFXLElBQUksQ0FBQztBQUsxRyxVQUFNLGlCQUFpQixXQUFXLEtBQUssbUJBQW1CLHFCQUFxQixDQUFDO0FBQ2hGLFFBQUksc0JBQXNCLHdCQUF3QixXQUFXLGlCQUFpQixLQUFLLENBQUMsZ0JBQWdCO0FBQ25HLGdCQUFVLDBCQUEwQixtQkFBbUIsUUFBUSxJQUFJLENBQUM7QUFBQSxJQUNyRTtBQUFBLEVBQ0Q7QUFFQSxRQUFNLGdCQUFnQjtBQUN0QixRQUFNLG1CQUFtQixRQUFRLEtBQUssOEJBQThCLFFBQVE7QUFFNUUsUUFBTSxjQUFjLENBQUMsUUFBZ0IsU0FBMEI7QUFDOUQsVUFBTSxpQkFBaUIsUUFBUSxJQUFJO0FBQ25DLFFBQUksV0FBVyxnQkFBZ0I7QUFDOUIsYUFBTztBQUFBLElBQ1I7QUFDQSxVQUFNLFNBQVMsZUFBZSxTQUFTLEdBQUcsSUFBSSxpQkFBaUIsR0FBRyxjQUFjLEdBQUcsR0FBRztBQUN0RixXQUFPLE9BQU8sV0FBVyxNQUFNO0FBQUEsRUFDaEM7QUFFQSxRQUFNLFlBQVksQ0FBQyxpQkFBc0Q7QUFDeEUsUUFBSSxDQUFDLGlCQUFpQjtBQUNyQixVQUFJLFlBQVksY0FBYyxhQUFhLEVBQUcsUUFBTztBQUNyRCxVQUFJLFlBQVksY0FBYyxnQkFBZ0IsRUFBRyxRQUFPO0FBQUEsSUFDekQ7QUFDQSxXQUFPO0FBQUEsRUFDUjtBQUVBLGFBQVcsV0FBVyxZQUFZO0FBQ2pDLFVBQU0sZUFBZSxpQkFBaUIsU0FBUyxHQUFHO0FBQ2xELFFBQUksQ0FBQyxXQUFXLFlBQVksR0FBRztBQUM5QixxQkFBZSxLQUFLLEVBQUUsTUFBTSxXQUFXLFNBQVMsNkJBQTZCLE1BQU0sYUFBYSxDQUFDO0FBQ2pHO0FBQUEsSUFDRDtBQUVBLFFBQUk7QUFDSCxZQUFNLFFBQVEsU0FBUyxZQUFZO0FBQ25DLFlBQU0sU0FBUyxVQUFVLFlBQVk7QUFDckMsVUFBSSxNQUFNLFlBQVksR0FBRztBQUN4QixrQkFBVSwwQkFBMEIsY0FBYyxRQUFRLElBQUksQ0FBQztBQUFBLE1BQ2hFLFdBQVcsTUFBTSxPQUFPLEtBQUssYUFBYSxTQUFTLEtBQUssR0FBRztBQUMxRCxjQUFNLFNBQVMsa0JBQWtCLGNBQWMsTUFBTTtBQUNyRCxZQUFJLE9BQU8sT0FBTztBQUNqQixvQkFBVSxFQUFFLFFBQVEsQ0FBQyxPQUFPLEtBQUssR0FBRyxhQUFhLE9BQU8sWUFBWSxDQUFDO0FBQUEsUUFDdEUsT0FBTztBQUNOLHlCQUFlLEtBQUssR0FBRyxPQUFPLFdBQVc7QUFBQSxRQUMxQztBQUFBLE1BQ0QsT0FBTztBQUNOLHVCQUFlLEtBQUssRUFBRSxNQUFNLFdBQVcsU0FBUyxxQ0FBcUMsTUFBTSxhQUFhLENBQUM7QUFBQSxNQUMxRztBQUFBLElBQ0QsU0FBUyxPQUFPO0FBQ2YsWUFBTSxVQUFVLGlCQUFpQixRQUFRLE1BQU0sVUFBVTtBQUN6RCxxQkFBZSxLQUFLLEVBQUUsTUFBTSxXQUFXLFNBQVMsTUFBTSxhQUFhLENBQUM7QUFBQSxJQUNyRTtBQUFBLEVBQ0Q7QUFFQSxpQkFBZSxNQUFNLEtBQUssU0FBUyxPQUFPLENBQUM7QUFFM0MsU0FBTztBQUFBLElBQ04sUUFBUSxDQUFDLEdBQUcsWUFBWTtBQUFBLElBQ3hCLGFBQWEsQ0FBQyxHQUFHLGdCQUFnQixHQUFHLG9CQUFvQjtBQUFBLEVBQ3pEO0FBQ0Q7IiwKICAibmFtZXMiOiBbXQp9Cg==
