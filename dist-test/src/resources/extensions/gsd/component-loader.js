import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseFrontmatter } from "@gsd/pi-coding-agent";
import { incrementLegacyTelemetry } from "./legacy-telemetry.js";
import {
  validateComponentName,
  validateComponentDescription,
  computeComponentId
} from "./component-types.js";
const SUPPORTED_COMPONENT_KINDS = ["skill", "agent"];
const SUPPORTED_API_VERSIONS = ["gsd/v1"];
function loadComponentFromDir(dir, source) {
  const diagnostics = [];
  const componentYamlPath = join(dir, "component.yaml");
  if (existsSync(componentYamlPath)) {
    return loadFromComponentYaml(componentYamlPath, dir, source);
  }
  const skillMdPath = join(dir, "SKILL.md");
  if (existsSync(skillMdPath)) {
    return loadFromLegacySkill(skillMdPath, dir, source);
  }
  return { component: null, diagnostics };
}
function loadComponentFromAgentFile(filePath, source) {
  return loadFromLegacyAgent(filePath, source);
}
function loadFromComponentYaml(yamlPath, dir, source) {
  const diagnostics = [];
  let raw;
  try {
    raw = readFileSync(yamlPath, "utf-8");
  } catch (error) {
    const msg = error instanceof Error ? error.message : "failed to read component.yaml";
    diagnostics.push({ type: "error", message: msg, path: yamlPath });
    return { component: null, diagnostics };
  }
  let definition;
  try {
    definition = parseYaml(raw);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "failed to parse component.yaml";
    diagnostics.push({ type: "error", message: `invalid YAML: ${msg}`, path: yamlPath });
    return { component: null, diagnostics };
  }
  if (!definition?.apiVersion) {
    diagnostics.push({ type: "error", message: "missing apiVersion", path: yamlPath });
    return { component: null, diagnostics };
  }
  if (!SUPPORTED_API_VERSIONS.includes(definition.apiVersion)) {
    diagnostics.push({
      type: "error",
      message: `unsupported apiVersion "${String(definition.apiVersion)}"`,
      path: yamlPath
    });
    return { component: null, diagnostics };
  }
  if (!definition.kind) {
    diagnostics.push({ type: "error", message: "missing kind", path: yamlPath });
    return { component: null, diagnostics };
  }
  if (!SUPPORTED_COMPONENT_KINDS.includes(definition.kind)) {
    diagnostics.push({
      type: "error",
      message: `unsupported kind "${definition.kind}"`,
      path: yamlPath
    });
    return { component: null, diagnostics };
  }
  if (!definition.metadata?.name) {
    diagnostics.push({ type: "error", message: "missing metadata.name", path: yamlPath });
    return { component: null, diagnostics };
  }
  if (!definition.metadata?.description) {
    diagnostics.push({ type: "error", message: "missing metadata.description", path: yamlPath });
    return { component: null, diagnostics };
  }
  const nameErrors = validateComponentName(definition.metadata.name);
  for (const err of nameErrors) {
    diagnostics.push({ type: "error", message: err, path: yamlPath });
  }
  const descErrors = validateComponentDescription(definition.metadata.description);
  for (const err of descErrors) {
    diagnostics.push({ type: "error", message: err, path: yamlPath });
  }
  if (nameErrors.length > 0 || descErrors.length > 0) {
    return { component: null, diagnostics };
  }
  if (!definition.spec) {
    diagnostics.push({ type: "error", message: "missing spec", path: yamlPath });
    return { component: null, diagnostics };
  }
  const entryFileDiagnostic = validateEntryFile(definition.kind, definition.spec, dir, yamlPath);
  if (entryFileDiagnostic) {
    diagnostics.push(entryFileDiagnostic);
    return { component: null, diagnostics };
  }
  const id = computeComponentId(definition.metadata.name, definition.metadata.namespace);
  const component = {
    id,
    kind: definition.kind,
    metadata: definition.metadata,
    spec: definition.spec,
    requires: definition.requires,
    compatibility: definition.compatibility,
    routing: definition.routing,
    dirPath: dir,
    filePath: yamlPath,
    source,
    format: "component-yaml",
    enabled: true
  };
  return { component, diagnostics };
}
function loadFromLegacySkill(filePath, dir, source) {
  const diagnostics = [];
  let raw;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (error) {
    const msg = error instanceof Error ? error.message : "failed to read SKILL.md";
    diagnostics.push({ type: "warning", message: msg, path: filePath });
    return { component: null, diagnostics };
  }
  const { frontmatter } = parseFrontmatter(raw);
  const parentDirName = basename(dir);
  const name = frontmatter.name || parentDirName;
  const nameErrors = validateComponentName(name);
  for (const err of nameErrors) {
    diagnostics.push({ type: "warning", message: err, path: filePath });
  }
  const descErrors = validateComponentDescription(frontmatter.description);
  for (const err of descErrors) {
    diagnostics.push({ type: "warning", message: err, path: filePath });
  }
  if (!frontmatter.description || frontmatter.description.trim() === "") {
    return { component: null, diagnostics };
  }
  const spec = {
    prompt: "SKILL.md",
    disableModelInvocation: frontmatter["disable-model-invocation"] === true
  };
  const id = computeComponentId(name);
  const component = {
    id,
    kind: "skill",
    metadata: {
      name,
      description: frontmatter.description
    },
    spec,
    dirPath: dir,
    filePath,
    source,
    format: "skill-md",
    enabled: true
  };
  incrementLegacyTelemetry("legacy.componentFormatUsed");
  return { component, diagnostics };
}
function loadFromLegacyAgent(filePath, source) {
  const diagnostics = [];
  let raw;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (error) {
    const msg = error instanceof Error ? error.message : "failed to read agent file";
    diagnostics.push({ type: "warning", message: msg, path: filePath });
    return { component: null, diagnostics };
  }
  const { frontmatter } = parseFrontmatter(raw);
  if (!frontmatter.name || !frontmatter.description) {
    diagnostics.push({
      type: "warning",
      message: "agent file missing name or description in frontmatter",
      path: filePath
    });
    return { component: null, diagnostics };
  }
  const tools = frontmatter.tools ? {
    allow: frontmatter.tools.split(",").map((t) => t.trim()).filter(Boolean)
  } : void 0;
  const spec = {
    systemPrompt: basename(filePath),
    model: frontmatter.model,
    tools
  };
  const id = computeComponentId(frontmatter.name);
  const dir = dirname(filePath);
  const component = {
    id,
    kind: "agent",
    metadata: {
      name: frontmatter.name,
      description: frontmatter.description
    },
    spec,
    dirPath: dir,
    filePath,
    source,
    format: "agent-md",
    enabled: true
  };
  incrementLegacyTelemetry("legacy.componentFormatUsed");
  return { component, diagnostics };
}
function scanComponentDir(dir, source, kind) {
  const components = [];
  const diagnostics = [];
  if (!existsSync(dir)) {
    return { components, diagnostics };
  }
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: "utf-8" });
  } catch {
    return { components, diagnostics };
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }
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
    if (isDir) {
      const result = loadComponentFromDir(fullPath, source);
      if (result.component) {
        if (!kind || result.component.kind === kind) {
          components.push(result.component);
        }
      }
      diagnostics.push(...result.diagnostics);
    } else if (isFile && entry.name.endsWith(".md")) {
      const result = loadFromFile(fullPath, source);
      if (result.component) {
        if (!kind || result.component.kind === kind) {
          components.push(result.component);
        }
      }
      diagnostics.push(...result.diagnostics);
    }
  }
  return { components, diagnostics };
}
function scanAgentDir(dir, source) {
  const components = [];
  const diagnostics = [];
  if (!existsSync(dir)) {
    return { components, diagnostics };
  }
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: "utf-8" });
  } catch {
    return { components, diagnostics };
  }
  for (const entry of entries) {
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
    if (isDir) {
      const result2 = loadComponentFromDir(fullPath, source);
      if (result2.component?.kind === "agent") {
        components.push(result2.component);
      }
      diagnostics.push(...result2.diagnostics);
      continue;
    }
    if (!entry.name.endsWith(".md")) continue;
    if (!isFile) continue;
    const nameWithoutExt = entry.name.replace(/\.md$/, "");
    const componentDir = join(dir, nameWithoutExt);
    if (existsSync(join(componentDir, "component.yaml"))) {
      continue;
    }
    const result = loadComponentFromAgentFile(fullPath, source);
    if (result.component) {
      components.push(result.component);
    }
    diagnostics.push(...result.diagnostics);
  }
  return { components, diagnostics };
}
function loadFromFile(filePath, source) {
  const diagnostics = [];
  let raw;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (error) {
    const msg = error instanceof Error ? error.message : "failed to read file";
    diagnostics.push({ type: "warning", message: msg, path: filePath });
    return { component: null, diagnostics };
  }
  const { frontmatter } = parseFrontmatter(raw);
  if (frontmatter.tools !== void 0) {
    return loadFromLegacyAgent(filePath, source);
  }
  const dir = dirname(filePath);
  const name = frontmatter.name || basename(filePath, ".md");
  const description = frontmatter.description;
  if (!description || description.trim() === "") {
    return { component: null, diagnostics };
  }
  const spec = {
    prompt: basename(filePath),
    disableModelInvocation: frontmatter["disable-model-invocation"] === true
  };
  const id = computeComponentId(name);
  const component = {
    id,
    kind: "skill",
    metadata: { name, description },
    spec,
    dirPath: dir,
    filePath,
    source,
    format: "skill-md",
    enabled: true
  };
  return { component, diagnostics };
}
function validateEntryFile(kind, spec, dir, yamlPath) {
  const relativePath = kind === "skill" ? spec.prompt : spec.systemPrompt;
  const field = kind === "skill" ? "spec.prompt" : "spec.systemPrompt";
  if (!relativePath || typeof relativePath !== "string") {
    return {
      type: "error",
      message: `missing ${field}`,
      path: yamlPath
    };
  }
  const entryPath = join(dir, relativePath);
  if (!existsSync(entryPath)) {
    return {
      type: "error",
      message: `missing referenced file for ${field}: ${relativePath}`,
      path: entryPath
    };
  }
  try {
    if (!statSync(entryPath).isFile()) {
      return {
        type: "error",
        message: `referenced ${field} is not a file: ${relativePath}`,
        path: entryPath
      };
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : "failed to inspect referenced file";
    return {
      type: "error",
      message: `${msg}: ${relativePath}`,
      path: entryPath
    };
  }
  return null;
}
export {
  loadComponentFromAgentFile,
  loadComponentFromDir,
  scanAgentDir,
  scanComponentDir
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9jb21wb25lbnQtbG9hZGVyLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBQcm9qZWN0L0FwcDogR1NELTJcbi8vIEZpbGUgUHVycG9zZTogTG9hZHMgbW9kZXJuIGNvbXBvbmVudC55YW1sIGRlZmluaXRpb25zIGFuZCBsZWdhY3kgc2tpbGwvYWdlbnQgZm9ybWF0cy5cblxuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZGRpclN5bmMsIHJlYWRGaWxlU3luYywgc3RhdFN5bmMgfSBmcm9tICdub2RlOmZzJztcbmltcG9ydCB7IGJhc2VuYW1lLCBkaXJuYW1lLCBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJztcbmltcG9ydCB7IHBhcnNlIGFzIHBhcnNlWWFtbCB9IGZyb20gJ3lhbWwnO1xuaW1wb3J0IHsgcGFyc2VGcm9udG1hdHRlciB9IGZyb20gJ0Bnc2QvcGktY29kaW5nLWFnZW50JztcbmltcG9ydCB7IGluY3JlbWVudExlZ2FjeVRlbGVtZXRyeSB9IGZyb20gJy4vbGVnYWN5LXRlbGVtZXRyeS5qcyc7XG5pbXBvcnQgdHlwZSB7XG5cdENvbXBvbmVudCxcblx0Q29tcG9uZW50QXBpVmVyc2lvbixcblx0Q29tcG9uZW50RGVmaW5pdGlvbixcblx0Q29tcG9uZW50RGlhZ25vc3RpYyxcblx0Q29tcG9uZW50S2luZCxcblx0Q29tcG9uZW50U291cmNlLFxuXHRBZ2VudFNwZWMsXG5cdEFnZW50VG9vbENvbmZpZyxcblx0U2tpbGxTcGVjLFxufSBmcm9tICcuL2NvbXBvbmVudC10eXBlcy5qcyc7XG5pbXBvcnQge1xuXHR2YWxpZGF0ZUNvbXBvbmVudE5hbWUsXG5cdHZhbGlkYXRlQ29tcG9uZW50RGVzY3JpcHRpb24sXG5cdGNvbXB1dGVDb21wb25lbnRJZCxcbn0gZnJvbSAnLi9jb21wb25lbnQtdHlwZXMuanMnO1xuXG5jb25zdCBTVVBQT1JURURfQ09NUE9ORU5UX0tJTkRTOiBDb21wb25lbnRLaW5kW10gPSBbJ3NraWxsJywgJ2FnZW50J107XG5jb25zdCBTVVBQT1JURURfQVBJX1ZFUlNJT05TOiBDb21wb25lbnRBcGlWZXJzaW9uW10gPSBbJ2dzZC92MSddO1xuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBMb2FkIFJlc3VsdFxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5leHBvcnQgaW50ZXJmYWNlIExvYWRDb21wb25lbnRSZXN1bHQge1xuXHRjb21wb25lbnQ6IENvbXBvbmVudCB8IG51bGw7XG5cdGRpYWdub3N0aWNzOiBDb21wb25lbnREaWFnbm9zdGljW107XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgTG9hZENvbXBvbmVudHNSZXN1bHQge1xuXHRjb21wb25lbnRzOiBDb21wb25lbnRbXTtcblx0ZGlhZ25vc3RpY3M6IENvbXBvbmVudERpYWdub3N0aWNbXTtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gU2luZ2xlIENvbXBvbmVudCBMb2FkaW5nXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICogTG9hZCBhIGNvbXBvbmVudCBmcm9tIGEgZGlyZWN0b3J5LlxuICogQ2hlY2tzIGZvciBjb21wb25lbnQueWFtbCBmaXJzdCwgdGhlbiBsZWdhY3kgZm9ybWF0cy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxvYWRDb21wb25lbnRGcm9tRGlyKFxuXHRkaXI6IHN0cmluZyxcblx0c291cmNlOiBDb21wb25lbnRTb3VyY2UsXG4pOiBMb2FkQ29tcG9uZW50UmVzdWx0IHtcblx0Y29uc3QgZGlhZ25vc3RpY3M6IENvbXBvbmVudERpYWdub3N0aWNbXSA9IFtdO1xuXG5cdC8vIFRyeSBuZXcgZm9ybWF0IGZpcnN0OiBjb21wb25lbnQueWFtbFxuXHRjb25zdCBjb21wb25lbnRZYW1sUGF0aCA9IGpvaW4oZGlyLCAnY29tcG9uZW50LnlhbWwnKTtcblx0aWYgKGV4aXN0c1N5bmMoY29tcG9uZW50WWFtbFBhdGgpKSB7XG5cdFx0cmV0dXJuIGxvYWRGcm9tQ29tcG9uZW50WWFtbChjb21wb25lbnRZYW1sUGF0aCwgZGlyLCBzb3VyY2UpO1xuXHR9XG5cblx0Ly8gVHJ5IGxlZ2FjeSBza2lsbCBmb3JtYXQ6IFNLSUxMLm1kXG5cdGNvbnN0IHNraWxsTWRQYXRoID0gam9pbihkaXIsICdTS0lMTC5tZCcpO1xuXHRpZiAoZXhpc3RzU3luYyhza2lsbE1kUGF0aCkpIHtcblx0XHRyZXR1cm4gbG9hZEZyb21MZWdhY3lTa2lsbChza2lsbE1kUGF0aCwgZGlyLCBzb3VyY2UpO1xuXHR9XG5cblx0Ly8gTm8gcmVjb2duaXplZCBjb21wb25lbnQgZm9ybWF0IGZvdW5kXG5cdHJldHVybiB7IGNvbXBvbmVudDogbnVsbCwgZGlhZ25vc3RpY3MgfTtcbn1cblxuLyoqXG4gKiBMb2FkIGEgY29tcG9uZW50IGZyb20gYSBsZWdhY3kgYWdlbnQgLm1kIGZpbGUgKGZsYXQgZmlsZSwgbm90IGRpcmVjdG9yeSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBsb2FkQ29tcG9uZW50RnJvbUFnZW50RmlsZShcblx0ZmlsZVBhdGg6IHN0cmluZyxcblx0c291cmNlOiBDb21wb25lbnRTb3VyY2UsXG4pOiBMb2FkQ29tcG9uZW50UmVzdWx0IHtcblx0cmV0dXJuIGxvYWRGcm9tTGVnYWN5QWdlbnQoZmlsZVBhdGgsIHNvdXJjZSk7XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIE5ldyBGb3JtYXQ6IGNvbXBvbmVudC55YW1sXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmZ1bmN0aW9uIGxvYWRGcm9tQ29tcG9uZW50WWFtbChcblx0eWFtbFBhdGg6IHN0cmluZyxcblx0ZGlyOiBzdHJpbmcsXG5cdHNvdXJjZTogQ29tcG9uZW50U291cmNlLFxuKTogTG9hZENvbXBvbmVudFJlc3VsdCB7XG5cdGNvbnN0IGRpYWdub3N0aWNzOiBDb21wb25lbnREaWFnbm9zdGljW10gPSBbXTtcblxuXHRsZXQgcmF3OiBzdHJpbmc7XG5cdHRyeSB7XG5cdFx0cmF3ID0gcmVhZEZpbGVTeW5jKHlhbWxQYXRoLCAndXRmLTgnKTtcblx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRjb25zdCBtc2cgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICdmYWlsZWQgdG8gcmVhZCBjb21wb25lbnQueWFtbCc7XG5cdFx0ZGlhZ25vc3RpY3MucHVzaCh7IHR5cGU6ICdlcnJvcicsIG1lc3NhZ2U6IG1zZywgcGF0aDogeWFtbFBhdGggfSk7XG5cdFx0cmV0dXJuIHsgY29tcG9uZW50OiBudWxsLCBkaWFnbm9zdGljcyB9O1xuXHR9XG5cblx0bGV0IGRlZmluaXRpb246IENvbXBvbmVudERlZmluaXRpb247XG5cdHRyeSB7XG5cdFx0ZGVmaW5pdGlvbiA9IHBhcnNlWWFtbChyYXcpIGFzIENvbXBvbmVudERlZmluaXRpb247XG5cdH0gY2F0Y2ggKGVycm9yKSB7XG5cdFx0Y29uc3QgbXNnID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAnZmFpbGVkIHRvIHBhcnNlIGNvbXBvbmVudC55YW1sJztcblx0XHRkaWFnbm9zdGljcy5wdXNoKHsgdHlwZTogJ2Vycm9yJywgbWVzc2FnZTogYGludmFsaWQgWUFNTDogJHttc2d9YCwgcGF0aDogeWFtbFBhdGggfSk7XG5cdFx0cmV0dXJuIHsgY29tcG9uZW50OiBudWxsLCBkaWFnbm9zdGljcyB9O1xuXHR9XG5cblx0Ly8gVmFsaWRhdGUgcmVxdWlyZWQgZmllbGRzXG5cdGlmICghZGVmaW5pdGlvbj8uYXBpVmVyc2lvbikge1xuXHRcdGRpYWdub3N0aWNzLnB1c2goeyB0eXBlOiAnZXJyb3InLCBtZXNzYWdlOiAnbWlzc2luZyBhcGlWZXJzaW9uJywgcGF0aDogeWFtbFBhdGggfSk7XG5cdFx0cmV0dXJuIHsgY29tcG9uZW50OiBudWxsLCBkaWFnbm9zdGljcyB9O1xuXHR9XG5cblx0aWYgKCFTVVBQT1JURURfQVBJX1ZFUlNJT05TLmluY2x1ZGVzKGRlZmluaXRpb24uYXBpVmVyc2lvbikpIHtcblx0XHRkaWFnbm9zdGljcy5wdXNoKHtcblx0XHRcdHR5cGU6ICdlcnJvcicsXG5cdFx0XHRtZXNzYWdlOiBgdW5zdXBwb3J0ZWQgYXBpVmVyc2lvbiBcIiR7U3RyaW5nKGRlZmluaXRpb24uYXBpVmVyc2lvbil9XCJgLFxuXHRcdFx0cGF0aDogeWFtbFBhdGgsXG5cdFx0fSk7XG5cdFx0cmV0dXJuIHsgY29tcG9uZW50OiBudWxsLCBkaWFnbm9zdGljcyB9O1xuXHR9XG5cblx0aWYgKCFkZWZpbml0aW9uLmtpbmQpIHtcblx0XHRkaWFnbm9zdGljcy5wdXNoKHsgdHlwZTogJ2Vycm9yJywgbWVzc2FnZTogJ21pc3Npbmcga2luZCcsIHBhdGg6IHlhbWxQYXRoIH0pO1xuXHRcdHJldHVybiB7IGNvbXBvbmVudDogbnVsbCwgZGlhZ25vc3RpY3MgfTtcblx0fVxuXG5cdGlmICghU1VQUE9SVEVEX0NPTVBPTkVOVF9LSU5EUy5pbmNsdWRlcyhkZWZpbml0aW9uLmtpbmQpKSB7XG5cdFx0ZGlhZ25vc3RpY3MucHVzaCh7XG5cdFx0XHR0eXBlOiAnZXJyb3InLFxuXHRcdFx0bWVzc2FnZTogYHVuc3VwcG9ydGVkIGtpbmQgXCIke2RlZmluaXRpb24ua2luZH1cImAsXG5cdFx0XHRwYXRoOiB5YW1sUGF0aCxcblx0XHR9KTtcblx0XHRyZXR1cm4geyBjb21wb25lbnQ6IG51bGwsIGRpYWdub3N0aWNzIH07XG5cdH1cblxuXHRpZiAoIWRlZmluaXRpb24ubWV0YWRhdGE/Lm5hbWUpIHtcblx0XHRkaWFnbm9zdGljcy5wdXNoKHsgdHlwZTogJ2Vycm9yJywgbWVzc2FnZTogJ21pc3NpbmcgbWV0YWRhdGEubmFtZScsIHBhdGg6IHlhbWxQYXRoIH0pO1xuXHRcdHJldHVybiB7IGNvbXBvbmVudDogbnVsbCwgZGlhZ25vc3RpY3MgfTtcblx0fVxuXG5cdGlmICghZGVmaW5pdGlvbi5tZXRhZGF0YT8uZGVzY3JpcHRpb24pIHtcblx0XHRkaWFnbm9zdGljcy5wdXNoKHsgdHlwZTogJ2Vycm9yJywgbWVzc2FnZTogJ21pc3NpbmcgbWV0YWRhdGEuZGVzY3JpcHRpb24nLCBwYXRoOiB5YW1sUGF0aCB9KTtcblx0XHRyZXR1cm4geyBjb21wb25lbnQ6IG51bGwsIGRpYWdub3N0aWNzIH07XG5cdH1cblxuXHRjb25zdCBuYW1lRXJyb3JzID0gdmFsaWRhdGVDb21wb25lbnROYW1lKGRlZmluaXRpb24ubWV0YWRhdGEubmFtZSk7XG5cdGZvciAoY29uc3QgZXJyIG9mIG5hbWVFcnJvcnMpIHtcblx0XHRkaWFnbm9zdGljcy5wdXNoKHsgdHlwZTogJ2Vycm9yJywgbWVzc2FnZTogZXJyLCBwYXRoOiB5YW1sUGF0aCB9KTtcblx0fVxuXG5cdGNvbnN0IGRlc2NFcnJvcnMgPSB2YWxpZGF0ZUNvbXBvbmVudERlc2NyaXB0aW9uKGRlZmluaXRpb24ubWV0YWRhdGEuZGVzY3JpcHRpb24pO1xuXHRmb3IgKGNvbnN0IGVyciBvZiBkZXNjRXJyb3JzKSB7XG5cdFx0ZGlhZ25vc3RpY3MucHVzaCh7IHR5cGU6ICdlcnJvcicsIG1lc3NhZ2U6IGVyciwgcGF0aDogeWFtbFBhdGggfSk7XG5cdH1cblxuXHRpZiAobmFtZUVycm9ycy5sZW5ndGggPiAwIHx8IGRlc2NFcnJvcnMubGVuZ3RoID4gMCkge1xuXHRcdHJldHVybiB7IGNvbXBvbmVudDogbnVsbCwgZGlhZ25vc3RpY3MgfTtcblx0fVxuXG5cdC8vIFZhbGlkYXRlIGtpbmQtc3BlY2lmaWMgc3BlY1xuXHRpZiAoIWRlZmluaXRpb24uc3BlYykge1xuXHRcdGRpYWdub3N0aWNzLnB1c2goeyB0eXBlOiAnZXJyb3InLCBtZXNzYWdlOiAnbWlzc2luZyBzcGVjJywgcGF0aDogeWFtbFBhdGggfSk7XG5cdFx0cmV0dXJuIHsgY29tcG9uZW50OiBudWxsLCBkaWFnbm9zdGljcyB9O1xuXHR9XG5cblx0Y29uc3QgZW50cnlGaWxlRGlhZ25vc3RpYyA9IHZhbGlkYXRlRW50cnlGaWxlKGRlZmluaXRpb24ua2luZCwgZGVmaW5pdGlvbi5zcGVjLCBkaXIsIHlhbWxQYXRoKTtcblx0aWYgKGVudHJ5RmlsZURpYWdub3N0aWMpIHtcblx0XHRkaWFnbm9zdGljcy5wdXNoKGVudHJ5RmlsZURpYWdub3N0aWMpO1xuXHRcdHJldHVybiB7IGNvbXBvbmVudDogbnVsbCwgZGlhZ25vc3RpY3MgfTtcblx0fVxuXG5cdGNvbnN0IGlkID0gY29tcHV0ZUNvbXBvbmVudElkKGRlZmluaXRpb24ubWV0YWRhdGEubmFtZSwgZGVmaW5pdGlvbi5tZXRhZGF0YS5uYW1lc3BhY2UpO1xuXG5cdGNvbnN0IGNvbXBvbmVudDogQ29tcG9uZW50ID0ge1xuXHRcdGlkLFxuXHRcdGtpbmQ6IGRlZmluaXRpb24ua2luZCxcblx0XHRtZXRhZGF0YTogZGVmaW5pdGlvbi5tZXRhZGF0YSxcblx0XHRzcGVjOiBkZWZpbml0aW9uLnNwZWMsXG5cdFx0cmVxdWlyZXM6IGRlZmluaXRpb24ucmVxdWlyZXMsXG5cdFx0Y29tcGF0aWJpbGl0eTogZGVmaW5pdGlvbi5jb21wYXRpYmlsaXR5LFxuXHRcdHJvdXRpbmc6IGRlZmluaXRpb24ucm91dGluZyxcblx0XHRkaXJQYXRoOiBkaXIsXG5cdFx0ZmlsZVBhdGg6IHlhbWxQYXRoLFxuXHRcdHNvdXJjZSxcblx0XHRmb3JtYXQ6ICdjb21wb25lbnQteWFtbCcsXG5cdFx0ZW5hYmxlZDogdHJ1ZSxcblx0fTtcblxuXHRyZXR1cm4geyBjb21wb25lbnQsIGRpYWdub3N0aWNzIH07XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIExlZ2FjeSBTa2lsbCBGb3JtYXQ6IFNLSUxMLm1kIHdpdGggZnJvbnRtYXR0ZXJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuaW50ZXJmYWNlIExlZ2FjeVNraWxsRnJvbnRtYXR0ZXIge1xuXHRuYW1lPzogc3RyaW5nO1xuXHRkZXNjcmlwdGlvbj86IHN0cmluZztcblx0J2Rpc2FibGUtbW9kZWwtaW52b2NhdGlvbic/OiBib29sZWFuO1xuXHRba2V5OiBzdHJpbmddOiB1bmtub3duO1xufVxuXG5mdW5jdGlvbiBsb2FkRnJvbUxlZ2FjeVNraWxsKFxuXHRmaWxlUGF0aDogc3RyaW5nLFxuXHRkaXI6IHN0cmluZyxcblx0c291cmNlOiBDb21wb25lbnRTb3VyY2UsXG4pOiBMb2FkQ29tcG9uZW50UmVzdWx0IHtcblx0Y29uc3QgZGlhZ25vc3RpY3M6IENvbXBvbmVudERpYWdub3N0aWNbXSA9IFtdO1xuXG5cdGxldCByYXc6IHN0cmluZztcblx0dHJ5IHtcblx0XHRyYXcgPSByZWFkRmlsZVN5bmMoZmlsZVBhdGgsICd1dGYtOCcpO1xuXHR9IGNhdGNoIChlcnJvcikge1xuXHRcdGNvbnN0IG1zZyA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ2ZhaWxlZCB0byByZWFkIFNLSUxMLm1kJztcblx0XHRkaWFnbm9zdGljcy5wdXNoKHsgdHlwZTogJ3dhcm5pbmcnLCBtZXNzYWdlOiBtc2csIHBhdGg6IGZpbGVQYXRoIH0pO1xuXHRcdHJldHVybiB7IGNvbXBvbmVudDogbnVsbCwgZGlhZ25vc3RpY3MgfTtcblx0fVxuXG5cdGNvbnN0IHsgZnJvbnRtYXR0ZXIgfSA9IHBhcnNlRnJvbnRtYXR0ZXI8TGVnYWN5U2tpbGxGcm9udG1hdHRlcj4ocmF3KTtcblx0Y29uc3QgcGFyZW50RGlyTmFtZSA9IGJhc2VuYW1lKGRpcik7XG5cdGNvbnN0IG5hbWUgPSBmcm9udG1hdHRlci5uYW1lIHx8IHBhcmVudERpck5hbWU7XG5cblx0Ly8gVmFsaWRhdGVcblx0Y29uc3QgbmFtZUVycm9ycyA9IHZhbGlkYXRlQ29tcG9uZW50TmFtZShuYW1lKTtcblx0Zm9yIChjb25zdCBlcnIgb2YgbmFtZUVycm9ycykge1xuXHRcdGRpYWdub3N0aWNzLnB1c2goeyB0eXBlOiAnd2FybmluZycsIG1lc3NhZ2U6IGVyciwgcGF0aDogZmlsZVBhdGggfSk7XG5cdH1cblxuXHRjb25zdCBkZXNjRXJyb3JzID0gdmFsaWRhdGVDb21wb25lbnREZXNjcmlwdGlvbihmcm9udG1hdHRlci5kZXNjcmlwdGlvbik7XG5cdGZvciAoY29uc3QgZXJyIG9mIGRlc2NFcnJvcnMpIHtcblx0XHRkaWFnbm9zdGljcy5wdXNoKHsgdHlwZTogJ3dhcm5pbmcnLCBtZXNzYWdlOiBlcnIsIHBhdGg6IGZpbGVQYXRoIH0pO1xuXHR9XG5cblx0aWYgKCFmcm9udG1hdHRlci5kZXNjcmlwdGlvbiB8fCBmcm9udG1hdHRlci5kZXNjcmlwdGlvbi50cmltKCkgPT09ICcnKSB7XG5cdFx0cmV0dXJuIHsgY29tcG9uZW50OiBudWxsLCBkaWFnbm9zdGljcyB9O1xuXHR9XG5cblx0Y29uc3Qgc3BlYzogU2tpbGxTcGVjID0ge1xuXHRcdHByb21wdDogJ1NLSUxMLm1kJyxcblx0XHRkaXNhYmxlTW9kZWxJbnZvY2F0aW9uOiBmcm9udG1hdHRlclsnZGlzYWJsZS1tb2RlbC1pbnZvY2F0aW9uJ10gPT09IHRydWUsXG5cdH07XG5cblx0Y29uc3QgaWQgPSBjb21wdXRlQ29tcG9uZW50SWQobmFtZSk7XG5cblx0Y29uc3QgY29tcG9uZW50OiBDb21wb25lbnQgPSB7XG5cdFx0aWQsXG5cdFx0a2luZDogJ3NraWxsJyxcblx0XHRtZXRhZGF0YToge1xuXHRcdFx0bmFtZSxcblx0XHRcdGRlc2NyaXB0aW9uOiBmcm9udG1hdHRlci5kZXNjcmlwdGlvbixcblx0XHR9LFxuXHRcdHNwZWMsXG5cdFx0ZGlyUGF0aDogZGlyLFxuXHRcdGZpbGVQYXRoLFxuXHRcdHNvdXJjZSxcblx0XHRmb3JtYXQ6ICdza2lsbC1tZCcsXG5cdFx0ZW5hYmxlZDogdHJ1ZSxcblx0fTtcblxuXHRpbmNyZW1lbnRMZWdhY3lUZWxlbWV0cnkoJ2xlZ2FjeS5jb21wb25lbnRGb3JtYXRVc2VkJyk7XG5cdHJldHVybiB7IGNvbXBvbmVudCwgZGlhZ25vc3RpY3MgfTtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gTGVnYWN5IEFnZW50IEZvcm1hdDogLm1kIHdpdGggZnJvbnRtYXR0ZXJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuaW50ZXJmYWNlIExlZ2FjeUFnZW50RnJvbnRtYXR0ZXIge1xuXHRuYW1lPzogc3RyaW5nO1xuXHRkZXNjcmlwdGlvbj86IHN0cmluZztcblx0dG9vbHM/OiBzdHJpbmc7XG5cdG1vZGVsPzogc3RyaW5nO1xuXHRba2V5OiBzdHJpbmddOiB1bmtub3duO1xufVxuXG5mdW5jdGlvbiBsb2FkRnJvbUxlZ2FjeUFnZW50KFxuXHRmaWxlUGF0aDogc3RyaW5nLFxuXHRzb3VyY2U6IENvbXBvbmVudFNvdXJjZSxcbik6IExvYWRDb21wb25lbnRSZXN1bHQge1xuXHRjb25zdCBkaWFnbm9zdGljczogQ29tcG9uZW50RGlhZ25vc3RpY1tdID0gW107XG5cblx0bGV0IHJhdzogc3RyaW5nO1xuXHR0cnkge1xuXHRcdHJhdyA9IHJlYWRGaWxlU3luYyhmaWxlUGF0aCwgJ3V0Zi04Jyk7XG5cdH0gY2F0Y2ggKGVycm9yKSB7XG5cdFx0Y29uc3QgbXNnID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAnZmFpbGVkIHRvIHJlYWQgYWdlbnQgZmlsZSc7XG5cdFx0ZGlhZ25vc3RpY3MucHVzaCh7IHR5cGU6ICd3YXJuaW5nJywgbWVzc2FnZTogbXNnLCBwYXRoOiBmaWxlUGF0aCB9KTtcblx0XHRyZXR1cm4geyBjb21wb25lbnQ6IG51bGwsIGRpYWdub3N0aWNzIH07XG5cdH1cblxuXHRjb25zdCB7IGZyb250bWF0dGVyIH0gPSBwYXJzZUZyb250bWF0dGVyPExlZ2FjeUFnZW50RnJvbnRtYXR0ZXI+KHJhdyk7XG5cblx0aWYgKCFmcm9udG1hdHRlci5uYW1lIHx8ICFmcm9udG1hdHRlci5kZXNjcmlwdGlvbikge1xuXHRcdGRpYWdub3N0aWNzLnB1c2goe1xuXHRcdFx0dHlwZTogJ3dhcm5pbmcnLFxuXHRcdFx0bWVzc2FnZTogJ2FnZW50IGZpbGUgbWlzc2luZyBuYW1lIG9yIGRlc2NyaXB0aW9uIGluIGZyb250bWF0dGVyJyxcblx0XHRcdHBhdGg6IGZpbGVQYXRoLFxuXHRcdH0pO1xuXHRcdHJldHVybiB7IGNvbXBvbmVudDogbnVsbCwgZGlhZ25vc3RpY3MgfTtcblx0fVxuXG5cdC8vIFBhcnNlIHRvb2xzIGZyb20gY29tbWEtc2VwYXJhdGVkIHN0cmluZ1xuXHRjb25zdCB0b29sczogQWdlbnRUb29sQ29uZmlnIHwgdW5kZWZpbmVkID0gZnJvbnRtYXR0ZXIudG9vbHNcblx0XHQ/IHtcblx0XHRcdGFsbG93OiBmcm9udG1hdHRlci50b29sc1xuXHRcdFx0XHQuc3BsaXQoJywnKVxuXHRcdFx0XHQubWFwKCh0OiBzdHJpbmcpID0+IHQudHJpbSgpKVxuXHRcdFx0XHQuZmlsdGVyKEJvb2xlYW4pLFxuXHRcdH1cblx0XHQ6IHVuZGVmaW5lZDtcblxuXHRjb25zdCBzcGVjOiBBZ2VudFNwZWMgPSB7XG5cdFx0c3lzdGVtUHJvbXB0OiBiYXNlbmFtZShmaWxlUGF0aCksXG5cdFx0bW9kZWw6IGZyb250bWF0dGVyLm1vZGVsLFxuXHRcdHRvb2xzLFxuXHR9O1xuXG5cdGNvbnN0IGlkID0gY29tcHV0ZUNvbXBvbmVudElkKGZyb250bWF0dGVyLm5hbWUpO1xuXHRjb25zdCBkaXIgPSBkaXJuYW1lKGZpbGVQYXRoKTtcblxuXHRjb25zdCBjb21wb25lbnQ6IENvbXBvbmVudCA9IHtcblx0XHRpZCxcblx0XHRraW5kOiAnYWdlbnQnLFxuXHRcdG1ldGFkYXRhOiB7XG5cdFx0XHRuYW1lOiBmcm9udG1hdHRlci5uYW1lLFxuXHRcdFx0ZGVzY3JpcHRpb246IGZyb250bWF0dGVyLmRlc2NyaXB0aW9uLFxuXHRcdH0sXG5cdFx0c3BlYyxcblx0XHRkaXJQYXRoOiBkaXIsXG5cdFx0ZmlsZVBhdGgsXG5cdFx0c291cmNlLFxuXHRcdGZvcm1hdDogJ2FnZW50LW1kJyxcblx0XHRlbmFibGVkOiB0cnVlLFxuXHR9O1xuXG5cdGluY3JlbWVudExlZ2FjeVRlbGVtZXRyeSgnbGVnYWN5LmNvbXBvbmVudEZvcm1hdFVzZWQnKTtcblx0cmV0dXJuIHsgY29tcG9uZW50LCBkaWFnbm9zdGljcyB9O1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBEaXJlY3RvcnkgU2Nhbm5pbmdcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqXG4gKiBTY2FuIGEgZGlyZWN0b3J5IGZvciBjb21wb25lbnRzIChza2lsbHMgZm9ybWF0KS5cbiAqIEhhbmRsZXMgYm90aCBuZXcgYW5kIGxlZ2FjeSBkaXJlY3RvcnkgbGF5b3V0cy5cbiAqXG4gKiBFeHBlY3RlZCBsYXlvdXRzOlxuICogLSBkaXIve2NvbXBvbmVudC1uYW1lfS9jb21wb25lbnQueWFtbCAgKG5ldyBmb3JtYXQpXG4gKiAtIGRpci97Y29tcG9uZW50LW5hbWV9L1NLSUxMLm1kICAgICAgICAobGVnYWN5IHNraWxsKVxuICogLSBkaXIve25hbWV9Lm1kICAgICAgICAgICAgICAgICAgICAgICAgKGxlZ2FjeSByb290LWxldmVsIHNraWxsKVxuICovXG5leHBvcnQgZnVuY3Rpb24gc2NhbkNvbXBvbmVudERpcihcblx0ZGlyOiBzdHJpbmcsXG5cdHNvdXJjZTogQ29tcG9uZW50U291cmNlLFxuXHRraW5kPzogQ29tcG9uZW50S2luZCxcbik6IExvYWRDb21wb25lbnRzUmVzdWx0IHtcblx0Y29uc3QgY29tcG9uZW50czogQ29tcG9uZW50W10gPSBbXTtcblx0Y29uc3QgZGlhZ25vc3RpY3M6IENvbXBvbmVudERpYWdub3N0aWNbXSA9IFtdO1xuXG5cdGlmICghZXhpc3RzU3luYyhkaXIpKSB7XG5cdFx0cmV0dXJuIHsgY29tcG9uZW50cywgZGlhZ25vc3RpY3MgfTtcblx0fVxuXG5cdGxldCBlbnRyaWVzOiBpbXBvcnQoJ25vZGU6ZnMnKS5EaXJlbnRbXTtcblx0dHJ5IHtcblx0XHRlbnRyaWVzID0gcmVhZGRpclN5bmMoZGlyLCB7IHdpdGhGaWxlVHlwZXM6IHRydWUsIGVuY29kaW5nOiAndXRmLTgnIH0pO1xuXHR9IGNhdGNoIHtcblx0XHRyZXR1cm4geyBjb21wb25lbnRzLCBkaWFnbm9zdGljcyB9O1xuXHR9XG5cblx0Zm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSB7XG5cdFx0aWYgKGVudHJ5Lm5hbWUuc3RhcnRzV2l0aCgnLicpIHx8IGVudHJ5Lm5hbWUgPT09ICdub2RlX21vZHVsZXMnKSB7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cblx0XHRjb25zdCBmdWxsUGF0aCA9IGpvaW4oZGlyLCBlbnRyeS5uYW1lKTtcblxuXHRcdGxldCBpc0RpciA9IGVudHJ5LmlzRGlyZWN0b3J5KCk7XG5cdFx0bGV0IGlzRmlsZSA9IGVudHJ5LmlzRmlsZSgpO1xuXHRcdGlmIChlbnRyeS5pc1N5bWJvbGljTGluaygpKSB7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCBzdGF0cyA9IHN0YXRTeW5jKGZ1bGxQYXRoKTtcblx0XHRcdFx0aXNEaXIgPSBzdGF0cy5pc0RpcmVjdG9yeSgpO1xuXHRcdFx0XHRpc0ZpbGUgPSBzdGF0cy5pc0ZpbGUoKTtcblx0XHRcdH0gY2F0Y2gge1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblx0XHR9XG5cblx0XHRpZiAoaXNEaXIpIHtcblx0XHRcdGNvbnN0IHJlc3VsdCA9IGxvYWRDb21wb25lbnRGcm9tRGlyKGZ1bGxQYXRoLCBzb3VyY2UpO1xuXHRcdFx0aWYgKHJlc3VsdC5jb21wb25lbnQpIHtcblx0XHRcdFx0aWYgKCFraW5kIHx8IHJlc3VsdC5jb21wb25lbnQua2luZCA9PT0ga2luZCkge1xuXHRcdFx0XHRcdGNvbXBvbmVudHMucHVzaChyZXN1bHQuY29tcG9uZW50KTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdFx0ZGlhZ25vc3RpY3MucHVzaCguLi5yZXN1bHQuZGlhZ25vc3RpY3MpO1xuXHRcdH0gZWxzZSBpZiAoaXNGaWxlICYmIGVudHJ5Lm5hbWUuZW5kc1dpdGgoJy5tZCcpKSB7XG5cdFx0XHQvLyBSb290LWxldmVsIC5tZCBmaWxlcyBcdTIwMTQgY291bGQgYmUgbGVnYWN5IHNraWxscyBvciBhZ2VudHNcblx0XHRcdC8vIFBlZWsgYXQgZnJvbnRtYXR0ZXIgdG8gZGV0ZXJtaW5lIHR5cGVcblx0XHRcdGNvbnN0IHJlc3VsdCA9IGxvYWRGcm9tRmlsZShmdWxsUGF0aCwgc291cmNlKTtcblx0XHRcdGlmIChyZXN1bHQuY29tcG9uZW50KSB7XG5cdFx0XHRcdGlmICgha2luZCB8fCByZXN1bHQuY29tcG9uZW50LmtpbmQgPT09IGtpbmQpIHtcblx0XHRcdFx0XHRjb21wb25lbnRzLnB1c2gocmVzdWx0LmNvbXBvbmVudCk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHRcdGRpYWdub3N0aWNzLnB1c2goLi4ucmVzdWx0LmRpYWdub3N0aWNzKTtcblx0XHR9XG5cdH1cblxuXHRyZXR1cm4geyBjb21wb25lbnRzLCBkaWFnbm9zdGljcyB9O1xufVxuXG4vKipcbiAqIFNjYW4gYSBkaXJlY3Rvcnkgc3BlY2lmaWNhbGx5IGZvciBhZ2VudCAubWQgZmlsZXMgKGxlZ2FjeSBhZ2VudCBmb3JtYXQpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2NhbkFnZW50RGlyKFxuXHRkaXI6IHN0cmluZyxcblx0c291cmNlOiBDb21wb25lbnRTb3VyY2UsXG4pOiBMb2FkQ29tcG9uZW50c1Jlc3VsdCB7XG5cdGNvbnN0IGNvbXBvbmVudHM6IENvbXBvbmVudFtdID0gW107XG5cdGNvbnN0IGRpYWdub3N0aWNzOiBDb21wb25lbnREaWFnbm9zdGljW10gPSBbXTtcblxuXHRpZiAoIWV4aXN0c1N5bmMoZGlyKSkge1xuXHRcdHJldHVybiB7IGNvbXBvbmVudHMsIGRpYWdub3N0aWNzIH07XG5cdH1cblxuXHRsZXQgZW50cmllczogaW1wb3J0KCdub2RlOmZzJykuRGlyZW50W107XG5cdHRyeSB7XG5cdFx0ZW50cmllcyA9IHJlYWRkaXJTeW5jKGRpciwgeyB3aXRoRmlsZVR5cGVzOiB0cnVlLCBlbmNvZGluZzogJ3V0Zi04JyB9KTtcblx0fSBjYXRjaCB7XG5cdFx0cmV0dXJuIHsgY29tcG9uZW50cywgZGlhZ25vc3RpY3MgfTtcblx0fVxuXG5cdGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xuXHRcdGNvbnN0IGZ1bGxQYXRoID0gam9pbihkaXIsIGVudHJ5Lm5hbWUpO1xuXHRcdGxldCBpc0RpciA9IGVudHJ5LmlzRGlyZWN0b3J5KCk7XG5cdFx0bGV0IGlzRmlsZSA9IGVudHJ5LmlzRmlsZSgpO1xuXHRcdGlmIChlbnRyeS5pc1N5bWJvbGljTGluaygpKSB7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCBzdGF0cyA9IHN0YXRTeW5jKGZ1bGxQYXRoKTtcblx0XHRcdFx0aXNEaXIgPSBzdGF0cy5pc0RpcmVjdG9yeSgpO1xuXHRcdFx0XHRpc0ZpbGUgPSBzdGF0cy5pc0ZpbGUoKTtcblx0XHRcdH0gY2F0Y2gge1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblx0XHR9XG5cblx0XHRpZiAoaXNEaXIpIHtcblx0XHRcdGNvbnN0IHJlc3VsdCA9IGxvYWRDb21wb25lbnRGcm9tRGlyKGZ1bGxQYXRoLCBzb3VyY2UpO1xuXHRcdFx0aWYgKHJlc3VsdC5jb21wb25lbnQ/LmtpbmQgPT09ICdhZ2VudCcpIHtcblx0XHRcdFx0Y29tcG9uZW50cy5wdXNoKHJlc3VsdC5jb21wb25lbnQpO1xuXHRcdFx0fVxuXHRcdFx0ZGlhZ25vc3RpY3MucHVzaCguLi5yZXN1bHQuZGlhZ25vc3RpY3MpO1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0aWYgKCFlbnRyeS5uYW1lLmVuZHNXaXRoKCcubWQnKSkgY29udGludWU7XG5cdFx0aWYgKCFpc0ZpbGUpIGNvbnRpbnVlO1xuXG5cdFx0Ly8gQ2hlY2sgaWYgdGhlcmUncyBhIGNvbXBvbmVudC55YW1sIGluIGEgc2FtZS1uYW1lZCBkaXJlY3Rvcnlcblx0XHRjb25zdCBuYW1lV2l0aG91dEV4dCA9IGVudHJ5Lm5hbWUucmVwbGFjZSgvXFwubWQkLywgJycpO1xuXHRcdGNvbnN0IGNvbXBvbmVudERpciA9IGpvaW4oZGlyLCBuYW1lV2l0aG91dEV4dCk7XG5cdFx0aWYgKGV4aXN0c1N5bmMoam9pbihjb21wb25lbnREaXIsICdjb21wb25lbnQueWFtbCcpKSkge1xuXHRcdFx0Ly8gTmV3IGZvcm1hdCB0YWtlcyBwcmVjZWRlbmNlIGFuZCBpcyBsb2FkZWQgYnkgdGhlIGRpcmVjdG9yeSBicmFuY2guXG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cblx0XHRjb25zdCByZXN1bHQgPSBsb2FkQ29tcG9uZW50RnJvbUFnZW50RmlsZShmdWxsUGF0aCwgc291cmNlKTtcblx0XHRpZiAocmVzdWx0LmNvbXBvbmVudCkge1xuXHRcdFx0Y29tcG9uZW50cy5wdXNoKHJlc3VsdC5jb21wb25lbnQpO1xuXHRcdH1cblx0XHRkaWFnbm9zdGljcy5wdXNoKC4uLnJlc3VsdC5kaWFnbm9zdGljcyk7XG5cdH1cblxuXHRyZXR1cm4geyBjb21wb25lbnRzLCBkaWFnbm9zdGljcyB9O1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBIZWxwZXJzXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICogTG9hZCBhIHNpbmdsZSBmaWxlLCBkZXRlY3Rpbmcgd2hldGhlciBpdCdzIGEgc2tpbGwgb3IgYWdlbnQgYnkgZnJvbnRtYXR0ZXIuXG4gKi9cbmZ1bmN0aW9uIGxvYWRGcm9tRmlsZShcblx0ZmlsZVBhdGg6IHN0cmluZyxcblx0c291cmNlOiBDb21wb25lbnRTb3VyY2UsXG4pOiBMb2FkQ29tcG9uZW50UmVzdWx0IHtcblx0Y29uc3QgZGlhZ25vc3RpY3M6IENvbXBvbmVudERpYWdub3N0aWNbXSA9IFtdO1xuXG5cdGxldCByYXc6IHN0cmluZztcblx0dHJ5IHtcblx0XHRyYXcgPSByZWFkRmlsZVN5bmMoZmlsZVBhdGgsICd1dGYtOCcpO1xuXHR9IGNhdGNoIChlcnJvcikge1xuXHRcdGNvbnN0IG1zZyA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ2ZhaWxlZCB0byByZWFkIGZpbGUnO1xuXHRcdGRpYWdub3N0aWNzLnB1c2goeyB0eXBlOiAnd2FybmluZycsIG1lc3NhZ2U6IG1zZywgcGF0aDogZmlsZVBhdGggfSk7XG5cdFx0cmV0dXJuIHsgY29tcG9uZW50OiBudWxsLCBkaWFnbm9zdGljcyB9O1xuXHR9XG5cblx0Y29uc3QgeyBmcm9udG1hdHRlciB9ID0gcGFyc2VGcm9udG1hdHRlcjxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ocmF3KTtcblxuXHQvLyBJZiBpdCBoYXMgJ3Rvb2xzJyBmaWVsZCwgdHJlYXQgYXMgYWdlbnRcblx0aWYgKGZyb250bWF0dGVyLnRvb2xzICE9PSB1bmRlZmluZWQpIHtcblx0XHRyZXR1cm4gbG9hZEZyb21MZWdhY3lBZ2VudChmaWxlUGF0aCwgc291cmNlKTtcblx0fVxuXG5cdC8vIE90aGVyd2lzZSB0cmVhdCBhcyBhIGxlZ2FjeSBza2lsbCAocm9vdC1sZXZlbCAubWQpXG5cdGNvbnN0IGRpciA9IGRpcm5hbWUoZmlsZVBhdGgpO1xuXHRjb25zdCBuYW1lID0gKGZyb250bWF0dGVyLm5hbWUgYXMgc3RyaW5nKSB8fCBiYXNlbmFtZShmaWxlUGF0aCwgJy5tZCcpO1xuXHRjb25zdCBkZXNjcmlwdGlvbiA9IGZyb250bWF0dGVyLmRlc2NyaXB0aW9uIGFzIHN0cmluZyB8IHVuZGVmaW5lZDtcblxuXHRpZiAoIWRlc2NyaXB0aW9uIHx8IGRlc2NyaXB0aW9uLnRyaW0oKSA9PT0gJycpIHtcblx0XHRyZXR1cm4geyBjb21wb25lbnQ6IG51bGwsIGRpYWdub3N0aWNzIH07XG5cdH1cblxuXHRjb25zdCBzcGVjOiBTa2lsbFNwZWMgPSB7XG5cdFx0cHJvbXB0OiBiYXNlbmFtZShmaWxlUGF0aCksXG5cdFx0ZGlzYWJsZU1vZGVsSW52b2NhdGlvbjogZnJvbnRtYXR0ZXJbJ2Rpc2FibGUtbW9kZWwtaW52b2NhdGlvbiddID09PSB0cnVlLFxuXHR9O1xuXG5cdGNvbnN0IGlkID0gY29tcHV0ZUNvbXBvbmVudElkKG5hbWUpO1xuXG5cdGNvbnN0IGNvbXBvbmVudDogQ29tcG9uZW50ID0ge1xuXHRcdGlkLFxuXHRcdGtpbmQ6ICdza2lsbCcsXG5cdFx0bWV0YWRhdGE6IHsgbmFtZSwgZGVzY3JpcHRpb24gfSxcblx0XHRzcGVjLFxuXHRcdGRpclBhdGg6IGRpcixcblx0XHRmaWxlUGF0aCxcblx0XHRzb3VyY2UsXG5cdFx0Zm9ybWF0OiAnc2tpbGwtbWQnLFxuXHRcdGVuYWJsZWQ6IHRydWUsXG5cdH07XG5cblx0cmV0dXJuIHsgY29tcG9uZW50LCBkaWFnbm9zdGljcyB9O1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZUVudHJ5RmlsZShcblx0a2luZDogQ29tcG9uZW50S2luZCxcblx0c3BlYzogQ29tcG9uZW50RGVmaW5pdGlvblsnc3BlYyddLFxuXHRkaXI6IHN0cmluZyxcblx0eWFtbFBhdGg6IHN0cmluZyxcbik6IENvbXBvbmVudERpYWdub3N0aWMgfCBudWxsIHtcblx0Y29uc3QgcmVsYXRpdmVQYXRoID1cblx0XHRraW5kID09PSAnc2tpbGwnXG5cdFx0XHQ/IChzcGVjIGFzIFNraWxsU3BlYykucHJvbXB0XG5cdFx0XHQ6IChzcGVjIGFzIEFnZW50U3BlYykuc3lzdGVtUHJvbXB0O1xuXHRjb25zdCBmaWVsZCA9IGtpbmQgPT09ICdza2lsbCcgPyAnc3BlYy5wcm9tcHQnIDogJ3NwZWMuc3lzdGVtUHJvbXB0JztcblxuXHRpZiAoIXJlbGF0aXZlUGF0aCB8fCB0eXBlb2YgcmVsYXRpdmVQYXRoICE9PSAnc3RyaW5nJykge1xuXHRcdHJldHVybiB7XG5cdFx0XHR0eXBlOiAnZXJyb3InLFxuXHRcdFx0bWVzc2FnZTogYG1pc3NpbmcgJHtmaWVsZH1gLFxuXHRcdFx0cGF0aDogeWFtbFBhdGgsXG5cdFx0fTtcblx0fVxuXG5cdGNvbnN0IGVudHJ5UGF0aCA9IGpvaW4oZGlyLCByZWxhdGl2ZVBhdGgpO1xuXHRpZiAoIWV4aXN0c1N5bmMoZW50cnlQYXRoKSkge1xuXHRcdHJldHVybiB7XG5cdFx0XHR0eXBlOiAnZXJyb3InLFxuXHRcdFx0bWVzc2FnZTogYG1pc3NpbmcgcmVmZXJlbmNlZCBmaWxlIGZvciAke2ZpZWxkfTogJHtyZWxhdGl2ZVBhdGh9YCxcblx0XHRcdHBhdGg6IGVudHJ5UGF0aCxcblx0XHR9O1xuXHR9XG5cblx0dHJ5IHtcblx0XHRpZiAoIXN0YXRTeW5jKGVudHJ5UGF0aCkuaXNGaWxlKCkpIHtcblx0XHRcdHJldHVybiB7XG5cdFx0XHRcdHR5cGU6ICdlcnJvcicsXG5cdFx0XHRcdG1lc3NhZ2U6IGByZWZlcmVuY2VkICR7ZmllbGR9IGlzIG5vdCBhIGZpbGU6ICR7cmVsYXRpdmVQYXRofWAsXG5cdFx0XHRcdHBhdGg6IGVudHJ5UGF0aCxcblx0XHRcdH07XG5cdFx0fVxuXHR9IGNhdGNoIChlcnJvcikge1xuXHRcdGNvbnN0IG1zZyA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ2ZhaWxlZCB0byBpbnNwZWN0IHJlZmVyZW5jZWQgZmlsZSc7XG5cdFx0cmV0dXJuIHtcblx0XHRcdHR5cGU6ICdlcnJvcicsXG5cdFx0XHRtZXNzYWdlOiBgJHttc2d9OiAke3JlbGF0aXZlUGF0aH1gLFxuXHRcdFx0cGF0aDogZW50cnlQYXRoLFxuXHRcdH07XG5cdH1cblxuXHRyZXR1cm4gbnVsbDtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUdBLFNBQVMsWUFBWSxhQUFhLGNBQWMsZ0JBQWdCO0FBQ2hFLFNBQVMsVUFBVSxTQUFTLFlBQVk7QUFDeEMsU0FBUyxTQUFTLGlCQUFpQjtBQUNuQyxTQUFTLHdCQUF3QjtBQUNqQyxTQUFTLGdDQUFnQztBQVl6QztBQUFBLEVBQ0M7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ007QUFFUCxNQUFNLDRCQUE2QyxDQUFDLFNBQVMsT0FBTztBQUNwRSxNQUFNLHlCQUFnRCxDQUFDLFFBQVE7QUF3QnhELFNBQVMscUJBQ2YsS0FDQSxRQUNzQjtBQUN0QixRQUFNLGNBQXFDLENBQUM7QUFHNUMsUUFBTSxvQkFBb0IsS0FBSyxLQUFLLGdCQUFnQjtBQUNwRCxNQUFJLFdBQVcsaUJBQWlCLEdBQUc7QUFDbEMsV0FBTyxzQkFBc0IsbUJBQW1CLEtBQUssTUFBTTtBQUFBLEVBQzVEO0FBR0EsUUFBTSxjQUFjLEtBQUssS0FBSyxVQUFVO0FBQ3hDLE1BQUksV0FBVyxXQUFXLEdBQUc7QUFDNUIsV0FBTyxvQkFBb0IsYUFBYSxLQUFLLE1BQU07QUFBQSxFQUNwRDtBQUdBLFNBQU8sRUFBRSxXQUFX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
