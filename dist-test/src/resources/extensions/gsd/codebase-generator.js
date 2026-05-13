import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { execSync } from "node:child_process";
import { gsdRoot } from "./paths.js";
const DEFAULT_EXCLUDES = [
  // ── AI / tooling meta ──
  ".agents/",
  ".gsd/",
  ".planning/",
  ".plans/",
  ".claude/",
  ".cursor/",
  ".bg-shell/",
  // ── Editor / IDE ──
  ".vscode/",
  ".idea/",
  // ── VCS ──
  ".git/",
  // ── Dependencies & build artifacts ──
  "node_modules/",
  "dist/",
  "build/",
  ".next/",
  "coverage/",
  "__pycache__/",
  ".venv/",
  "venv/",
  "vendor/",
  "target/",
  // ── Misc ──
  ".cache/",
  "tmp/"
];
const DEFAULT_MAX_FILES = 500;
const DEFAULT_COLLAPSE_THRESHOLD = 20;
const DEFAULT_REFRESH_TTL_MS = 3e4;
const DEFAULT_MAX_AGE_MS = 15 * 6e4;
const CODEBASE_METADATA_PREFIX = "<!-- gsd:codebase-meta ";
const freshnessCache = /* @__PURE__ */ new Map();
function parseCodebaseMap(content) {
  const descriptions = /* @__PURE__ */ new Map();
  let inCollapsedBlock = false;
  for (const line of content.split("\n")) {
    if (line.trimStart().startsWith("<!-- gsd:collapsed-descriptions")) {
      inCollapsedBlock = true;
      continue;
    }
    if (inCollapsedBlock && line.trimStart().startsWith("-->")) {
      inCollapsedBlock = false;
      continue;
    }
    const match = line.match(/^- `(.+?)` — (.+)$/);
    if (match) {
      descriptions.set(match[1], match[2]);
      continue;
    }
    if (!inCollapsedBlock) {
      const bareMatch = line.match(/^- `(.+?)`\s*$/);
      if (bareMatch) {
        descriptions.set(bareMatch[1], "");
      }
    }
  }
  return descriptions;
}
function parseCodebaseMapMetadata(content) {
  const metaLine = content.split("\n").find((line) => line.trimStart().startsWith(CODEBASE_METADATA_PREFIX));
  if (!metaLine) return null;
  const trimmed = metaLine.trim();
  const jsonStart = CODEBASE_METADATA_PREFIX.length;
  const jsonEnd = trimmed.lastIndexOf(" -->");
  if (jsonEnd <= jsonStart) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(jsonStart, jsonEnd));
    if (typeof parsed?.generatedAt === "string" && typeof parsed?.fingerprint === "string" && typeof parsed?.fileCount === "number" && typeof parsed?.truncated === "boolean") {
      return parsed;
    }
  } catch {
  }
  return null;
}
function shouldExclude(filePath, excludes) {
  for (const pattern of excludes) {
    if (pattern.endsWith("/")) {
      if (filePath.startsWith(pattern) || filePath.includes(`/${pattern}`)) return true;
    } else if (filePath === pattern || filePath.endsWith(`/${pattern}`)) {
      return true;
    }
  }
  const ext = extname(filePath).toLowerCase();
  if ([".lock", ".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".eot", ".svg"].includes(ext)) {
    return true;
  }
  return false;
}
function lsFiles(basePath) {
  try {
    const result = execSync("git ls-files", { cwd: basePath, encoding: "utf-8", timeout: 1e4 });
    return result.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
function enumerateFiles(basePath, excludes, maxFiles) {
  const allFiles = lsFiles(basePath);
  const filtered = allFiles.filter((f) => !shouldExclude(f, excludes));
  const truncated = filtered.length > maxFiles;
  return { files: truncated ? filtered.slice(0, maxFiles) : filtered, truncated };
}
function resolveGeneratorOptions(options) {
  const excludes = [...DEFAULT_EXCLUDES, ...options?.excludePatterns ?? []];
  const maxFiles = options?.maxFiles ?? DEFAULT_MAX_FILES;
  const collapseThreshold = options?.collapseThreshold ?? DEFAULT_COLLAPSE_THRESHOLD;
  return {
    excludes,
    maxFiles,
    collapseThreshold,
    optionSignature: JSON.stringify({
      excludes,
      maxFiles,
      collapseThreshold
    })
  };
}
function computeCodebaseFingerprint(files, resolved, truncated) {
  return createHash("sha1").update(JSON.stringify({
    files,
    truncated,
    optionSignature: resolved.optionSignature
  })).digest("hex");
}
function groupByDirectory(files, descriptions, collapseThreshold) {
  const dirMap = /* @__PURE__ */ new Map();
  for (const file of files) {
    const dir = dirname(file);
    const dirKey = dir === "." ? "" : dir;
    if (!dirMap.has(dirKey)) {
      dirMap.set(dirKey, []);
    }
    dirMap.get(dirKey).push({
      path: file,
      description: descriptions.get(file) ?? ""
    });
  }
  const groups = [];
  const sortedDirs = [...dirMap.keys()].sort();
  for (const dir of sortedDirs) {
    const dirFiles = dirMap.get(dir);
    dirFiles.sort((a, b) => a.path.localeCompare(b.path));
    groups.push({
      path: dir,
      files: dirFiles,
      collapsed: dirFiles.length > collapseThreshold
    });
  }
  return groups;
}
function renderCodebaseMap(groups, totalFiles, truncated, metadata) {
  const lines = [];
  const described = groups.reduce((sum, g) => sum + g.files.filter((f) => f.description).length, 0);
  lines.push("# Codebase Map");
  lines.push("");
  lines.push(`Generated: ${metadata.generatedAt} | Files: ${totalFiles} | Described: ${described}/${totalFiles}`);
  lines.push(`${CODEBASE_METADATA_PREFIX}${JSON.stringify(metadata)} -->`);
  if (truncated) {
    lines.push(`Note: Truncated to first ${totalFiles} files. Run with higher --max-files to include all.`);
  }
  lines.push("");
  for (const group of groups) {
    const heading = group.path || "(root)";
    lines.push(`### ${heading}/`);
    if (group.collapsed) {
      const extensions = /* @__PURE__ */ new Map();
      for (const f of group.files) {
        const ext = extname(f.path) || "(no ext)";
        extensions.set(ext, (extensions.get(ext) ?? 0) + 1);
      }
      const extSummary = [...extensions.entries()].sort((a, b) => b[1] - a[1]).map(([ext, count]) => `${count} ${ext}`).join(", ");
      lines.push(`- *(${group.files.length} files: ${extSummary})*`);
      const descLines = group.files.filter((f) => f.description).map((f) => `- \`${f.path}\` \u2014 ${f.description}`);
      if (descLines.length > 0) {
        lines.push("<!-- gsd:collapsed-descriptions");
        lines.push(...descLines);
        lines.push("-->");
      }
    } else {
      for (const file of group.files) {
        if (file.description) {
          lines.push(`- \`${file.path}\` \u2014 ${file.description}`);
        } else {
          lines.push(`- \`${file.path}\``);
        }
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}
function buildCodebaseMap(basePath, resolved, existingDescriptions, enumerated) {
  const listed = enumerated ?? enumerateFiles(basePath, resolved.excludes, resolved.maxFiles);
  const descriptions = existingDescriptions ?? /* @__PURE__ */ new Map();
  const groups = groupByDirectory(listed.files, descriptions, resolved.collapseThreshold);
  const generatedAt = (/* @__PURE__ */ new Date()).toISOString().split(".")[0] + "Z";
  const metadata = {
    generatedAt,
    fingerprint: computeCodebaseFingerprint(listed.files, resolved, listed.truncated),
    fileCount: listed.files.length,
    truncated: listed.truncated
  };
  const content = renderCodebaseMap(groups, listed.files.length, listed.truncated, metadata);
  return {
    content,
    fileCount: listed.files.length,
    truncated: listed.truncated,
    files: listed.files,
    fingerprint: metadata.fingerprint,
    generatedAt
  };
}
function generateCodebaseMap(basePath, options, existingDescriptions) {
  const resolved = resolveGeneratorOptions(options);
  return buildCodebaseMap(basePath, resolved, existingDescriptions);
}
function updateCodebaseMap(basePath, options) {
  const codebasePath = join(gsdRoot(basePath), "CODEBASE.md");
  const resolved = resolveGeneratorOptions(options);
  let existingDescriptions = /* @__PURE__ */ new Map();
  if (existsSync(codebasePath)) {
    const existing = readFileSync(codebasePath, "utf-8");
    existingDescriptions = parseCodebaseMap(existing);
  }
  const existingFiles = new Set(existingDescriptions.keys());
  const result = buildCodebaseMap(basePath, resolved, existingDescriptions);
  const currentSet = new Set(result.files);
  let added = 0;
  let removed = 0;
  for (const f of result.files) {
    if (!existingFiles.has(f)) added++;
  }
  for (const f of existingFiles) {
    if (!currentSet.has(f)) removed++;
  }
  return {
    content: result.content,
    added,
    removed,
    unchanged: result.files.length - added,
    fileCount: result.fileCount,
    truncated: result.truncated,
    fingerprint: result.fingerprint,
    generatedAt: result.generatedAt
  };
}
function clearFreshnessCache(basePath) {
  for (const key of freshnessCache.keys()) {
    if (key === basePath || key.startsWith(`${basePath}::`)) {
      freshnessCache.delete(key);
    }
  }
}
function ensureCodebaseMapFresh(basePath, options, ensureOptions) {
  const resolved = resolveGeneratorOptions(options);
  const cacheKey = `${basePath}::${resolved.optionSignature}`;
  const ttlMs = ensureOptions?.ttlMs ?? DEFAULT_REFRESH_TTL_MS;
  const maxAgeMs = ensureOptions?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const force = ensureOptions?.force === true;
  const now = Date.now();
  if (!force && ttlMs > 0) {
    const cached = freshnessCache.get(cacheKey);
    if (cached && now - cached.checkedAt < ttlMs) {
      return cached.result;
    }
  }
  const existing = readCodebaseMap(basePath);
  const listed = enumerateFiles(basePath, resolved.excludes, resolved.maxFiles);
  const fingerprint = computeCodebaseFingerprint(listed.files, resolved, listed.truncated);
  const cacheAndReturn = (result) => {
    freshnessCache.set(cacheKey, { checkedAt: now, result });
    return result;
  };
  if (!existing) {
    const generated = buildCodebaseMap(basePath, resolved, void 0, listed);
    if (generated.fileCount > 0) {
      writeCodebaseMap(basePath, generated.content);
      return cacheAndReturn({
        status: "generated",
        fileCount: generated.fileCount,
        truncated: generated.truncated,
        generatedAt: generated.generatedAt,
        fingerprint: generated.fingerprint,
        reason: "missing"
      });
    }
    return cacheAndReturn({
      status: "empty",
      fileCount: 0,
      truncated: false,
      generatedAt: null,
      fingerprint,
      reason: "no-tracked-files"
    });
  }
  const metadata = parseCodebaseMapMetadata(existing);
  const existingDescriptions = parseCodebaseMap(existing);
  const ageMs = metadata ? now - Date.parse(metadata.generatedAt) : Number.POSITIVE_INFINITY;
  const staleReason = !metadata ? "missing-metadata" : metadata.fingerprint !== fingerprint ? "files-changed" : metadata.fileCount !== listed.files.length ? "file-count-changed" : metadata.truncated !== listed.truncated ? "truncation-changed" : maxAgeMs > 0 && Number.isFinite(ageMs) && ageMs > maxAgeMs ? "expired" : void 0;
  if (!staleReason) {
    return cacheAndReturn({
      status: "fresh",
      fileCount: metadata?.fileCount ?? listed.files.length,
      truncated: metadata?.truncated ?? listed.truncated,
      generatedAt: metadata?.generatedAt ?? null,
      fingerprint: metadata?.fingerprint ?? fingerprint
    });
  }
  const updated = buildCodebaseMap(basePath, resolved, existingDescriptions, listed);
  if (updated.fileCount > 0) {
    writeCodebaseMap(basePath, updated.content);
    return cacheAndReturn({
      status: "updated",
      fileCount: updated.fileCount,
      truncated: updated.truncated,
      generatedAt: updated.generatedAt,
      fingerprint: updated.fingerprint,
      reason: staleReason
    });
  }
  return cacheAndReturn({
    status: "empty",
    fileCount: 0,
    truncated: false,
    generatedAt: null,
    fingerprint,
    reason: staleReason
  });
}
function writeCodebaseMap(basePath, content) {
  const root = gsdRoot(basePath);
  mkdirSync(root, { recursive: true });
  const outPath = join(root, "CODEBASE.md");
  writeFileSync(outPath, content, "utf-8");
  clearFreshnessCache(basePath);
  return outPath;
}
function readCodebaseMap(basePath) {
  const codebasePath = join(gsdRoot(basePath), "CODEBASE.md");
  if (!existsSync(codebasePath)) return null;
  try {
    return readFileSync(codebasePath, "utf-8");
  } catch {
    return null;
  }
}
function getCodebaseMapStats(basePath) {
  const content = readCodebaseMap(basePath);
  if (!content) {
    return { exists: false, fileCount: 0, describedCount: 0, undescribedCount: 0, generatedAt: null };
  }
  const fileCountMatch = content.match(/Files:\s*(\d+)/);
  const totalFiles = fileCountMatch ? parseInt(fileCountMatch[1], 10) : 0;
  const descriptions = parseCodebaseMap(content);
  const described = [...descriptions.values()].filter((d) => d.length > 0).length;
  const dateMatch = content.match(/Generated: (\S+)/);
  return {
    exists: true,
    fileCount: totalFiles,
    describedCount: described,
    undescribedCount: totalFiles - described,
    generatedAt: dateMatch?.[1] ?? null
  };
}
export {
  ensureCodebaseMapFresh,
  generateCodebaseMap,
  getCodebaseMapStats,
  parseCodebaseMap,
  parseCodebaseMapMetadata,
  readCodebaseMap,
  updateCodebaseMap,
  writeCodebaseMap
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9jb2RlYmFzZS1nZW5lcmF0b3IudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogR1NEIENvZGViYXNlIE1hcCBHZW5lcmF0b3JcbiAqXG4gKiBQcm9kdWNlcyAuZ3NkL0NPREVCQVNFLm1kIFx1MjAxNCBhIHN0cnVjdHVyYWwgdGFibGUgb2YgY29udGVudHMgZm9yIHRoZSBwcm9qZWN0LlxuICogR2l2ZXMgZnJlc2ggYWdlbnQgY29udGV4dHMgaW5zdGFudCBvcmllbnRhdGlvbiB3aXRob3V0IGZpbGVzeXN0ZW0gZXhwbG9yYXRpb24uXG4gKlxuICogR2VuZXJhdGlvbjogd2FsayBgZ2l0IGxzLWZpbGVzYCwgZ3JvdXAgYnkgZGlyZWN0b3J5LCBvdXRwdXQgd2l0aCBkZXNjcmlwdGlvbnMuXG4gKiBNYWludGVuYW5jZTogYWdlbnQgdXBkYXRlcyBkZXNjcmlwdGlvbnMgYXMgaXQgd29ya3M7IGluY3JlbWVudGFsIHVwZGF0ZSBwcmVzZXJ2ZXMgdGhlbS5cbiAqL1xuXG5pbXBvcnQgeyBjcmVhdGVIYXNoIH0gZnJvbSBcIm5vZGU6Y3J5cHRvXCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkRmlsZVN5bmMsIHdyaXRlRmlsZVN5bmMsIG1rZGlyU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luLCBkaXJuYW1lLCBleHRuYW1lIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuXG5pbXBvcnQgeyBleGVjU3luYyB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7IGdzZFJvb3QgfSBmcm9tIFwiLi9wYXRocy5qc1wiO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVHlwZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBpbnRlcmZhY2UgQ29kZWJhc2VNYXBPcHRpb25zIHtcbiAgZXhjbHVkZVBhdHRlcm5zPzogc3RyaW5nW107XG4gIG1heEZpbGVzPzogbnVtYmVyO1xuICBjb2xsYXBzZVRocmVzaG9sZD86IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDb2RlYmFzZU1hcE1ldGFkYXRhIHtcbiAgZ2VuZXJhdGVkQXQ6IHN0cmluZztcbiAgZmluZ2VycHJpbnQ6IHN0cmluZztcbiAgZmlsZUNvdW50OiBudW1iZXI7XG4gIHRydW5jYXRlZDogYm9vbGVhbjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBFbnN1cmVDb2RlYmFzZU1hcE9wdGlvbnMge1xuICB0dGxNcz86IG51bWJlcjtcbiAgbWF4QWdlTXM/OiBudW1iZXI7XG4gIGZvcmNlPzogYm9vbGVhbjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBFbnN1cmVDb2RlYmFzZU1hcFJlc3VsdCB7XG4gIHN0YXR1czogXCJnZW5lcmF0ZWRcIiB8IFwidXBkYXRlZFwiIHwgXCJmcmVzaFwiIHwgXCJlbXB0eVwiO1xuICBmaWxlQ291bnQ6IG51bWJlcjtcbiAgdHJ1bmNhdGVkOiBib29sZWFuO1xuICBnZW5lcmF0ZWRBdDogc3RyaW5nIHwgbnVsbDtcbiAgZmluZ2VycHJpbnQ6IHN0cmluZyB8IG51bGw7XG4gIHJlYXNvbj86IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIEZpbGVFbnRyeSB7XG4gIHBhdGg6IHN0cmluZztcbiAgZGVzY3JpcHRpb246IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIERpcmVjdG9yeUdyb3VwIHtcbiAgcGF0aDogc3RyaW5nO1xuICBmaWxlczogRmlsZUVudHJ5W107XG4gIGNvbGxhcHNlZDogYm9vbGVhbjtcbn1cblxuaW50ZXJmYWNlIFJlc29sdmVkQ29kZWJhc2VNYXBPcHRpb25zIHtcbiAgZXhjbHVkZXM6IHN0cmluZ1tdO1xuICBtYXhGaWxlczogbnVtYmVyO1xuICBjb2xsYXBzZVRocmVzaG9sZDogbnVtYmVyO1xuICBvcHRpb25TaWduYXR1cmU6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIEVudW1lcmF0ZWRGaWxlcyB7XG4gIGZpbGVzOiBzdHJpbmdbXTtcbiAgdHJ1bmNhdGVkOiBib29sZWFuO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRGVmYXVsdHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmNvbnN0IERFRkFVTFRfRVhDTFVERVMgPSBbXG4gIC8vIFx1MjUwMFx1MjUwMCBBSSAvIHRvb2xpbmcgbWV0YSBcdTI1MDBcdTI1MDBcbiAgXCIuYWdlbnRzL1wiLFxuICBcIi5nc2QvXCIsXG4gIFwiLnBsYW5uaW5nL1wiLFxuICBcIi5wbGFucy9cIixcbiAgXCIuY2xhdWRlL1wiLFxuICBcIi5jdXJzb3IvXCIsXG4gIFwiLmJnLXNoZWxsL1wiLFxuXG4gIC8vIFx1MjUwMFx1MjUwMCBFZGl0b3IgLyBJREUgXHUyNTAwXHUyNTAwXG4gIFwiLnZzY29kZS9cIixcbiAgXCIuaWRlYS9cIixcblxuICAvLyBcdTI1MDBcdTI1MDAgVkNTIFx1MjUwMFx1MjUwMFxuICBcIi5naXQvXCIsXG5cbiAgLy8gXHUyNTAwXHUyNTAwIERlcGVuZGVuY2llcyAmIGJ1aWxkIGFydGlmYWN0cyBcdTI1MDBcdTI1MDBcbiAgXCJub2RlX21vZHVsZXMvXCIsXG4gIFwiZGlzdC9cIixcbiAgXCJidWlsZC9cIixcbiAgXCIubmV4dC9cIixcbiAgXCJjb3ZlcmFnZS9cIixcbiAgXCJfX3B5Y2FjaGVfXy9cIixcbiAgXCIudmVudi9cIixcbiAgXCJ2ZW52L1wiLFxuICBcInZlbmRvci9cIixcbiAgXCJ0YXJnZXQvXCIsXG5cbiAgLy8gXHUyNTAwXHUyNTAwIE1pc2MgXHUyNTAwXHUyNTAwXG4gIFwiLmNhY2hlL1wiLFxuICBcInRtcC9cIixcbl07XG5cbmNvbnN0IERFRkFVTFRfTUFYX0ZJTEVTID0gNTAwO1xuY29uc3QgREVGQVVMVF9DT0xMQVBTRV9USFJFU0hPTEQgPSAyMDtcbmNvbnN0IERFRkFVTFRfUkVGUkVTSF9UVExfTVMgPSAzMF8wMDA7XG5jb25zdCBERUZBVUxUX01BWF9BR0VfTVMgPSAxNSAqIDYwXzAwMDtcbmNvbnN0IENPREVCQVNFX01FVEFEQVRBX1BSRUZJWCA9IFwiPCEtLSBnc2Q6Y29kZWJhc2UtbWV0YSBcIjtcblxuY29uc3QgZnJlc2huZXNzQ2FjaGUgPSBuZXcgTWFwPHN0cmluZywgeyBjaGVja2VkQXQ6IG51bWJlcjsgcmVzdWx0OiBFbnN1cmVDb2RlYmFzZU1hcFJlc3VsdCB9PigpO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUGFyc2luZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBQYXJzZSBhbiBleGlzdGluZyBDT0RFQkFTRS5tZCB0byBleHRyYWN0IGZpbGUgXHUyMTkyIGRlc2NyaXB0aW9uIG1hcHBpbmdzLlxuICogQWxzbyBzY2FucyA8IS0tIGdzZDpjb2xsYXBzZWQtZGVzY3JpcHRpb25zIC0tPiBjb21tZW50IGJsb2NrcyB0byBwcmVzZXJ2ZVxuICogZGVzY3JpcHRpb25zIGZvciBmaWxlcyBpbiBjb2xsYXBzZWQgZGlyZWN0b3JpZXMgYWNyb3NzIGluY3JlbWVudGFsIHVwZGF0ZXMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUNvZGViYXNlTWFwKGNvbnRlbnQ6IHN0cmluZyk6IE1hcDxzdHJpbmcsIHN0cmluZz4ge1xuICBjb25zdCBkZXNjcmlwdGlvbnMgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICBsZXQgaW5Db2xsYXBzZWRCbG9jayA9IGZhbHNlO1xuXG4gIGZvciAoY29uc3QgbGluZSBvZiBjb250ZW50LnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgLy8gVHJhY2sgY29sbGFwc2VkLWRlc2NyaXB0aW9uIGNvbW1lbnQgYmxvY2tzXG4gICAgaWYgKGxpbmUudHJpbVN0YXJ0KCkuc3RhcnRzV2l0aChcIjwhLS0gZ3NkOmNvbGxhcHNlZC1kZXNjcmlwdGlvbnNcIikpIHtcbiAgICAgIGluQ29sbGFwc2VkQmxvY2sgPSB0cnVlO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChpbkNvbGxhcHNlZEJsb2NrICYmIGxpbmUudHJpbVN0YXJ0KCkuc3RhcnRzV2l0aChcIi0tPlwiKSkge1xuICAgICAgaW5Db2xsYXBzZWRCbG9jayA9IGZhbHNlO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgLy8gTWF0Y2g6IC0gYHBhdGgvdG8vZmlsZS50c2AgXHUyMDE0IERlc2NyaXB0aW9uIGhlcmVcbiAgICBjb25zdCBtYXRjaCA9IGxpbmUubWF0Y2goL14tIGAoLis/KWAgXHUyMDE0ICguKykkLyk7XG4gICAgaWYgKG1hdGNoKSB7XG4gICAgICBkZXNjcmlwdGlvbnMuc2V0KG1hdGNoWzFdLCBtYXRjaFsyXSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICAvLyBNYXRjaDogLSBgcGF0aC90by9maWxlLnRzYCAobm8gZGVzY3JpcHRpb24pIFx1MjAxNCBvbmx5IG91dHNpZGUgY29sbGFwc2VkIGJsb2Nrc1xuICAgIGlmICghaW5Db2xsYXBzZWRCbG9jaykge1xuICAgICAgY29uc3QgYmFyZU1hdGNoID0gbGluZS5tYXRjaCgvXi0gYCguKz8pYFxccyokLyk7XG4gICAgICBpZiAoYmFyZU1hdGNoKSB7XG4gICAgICAgIGRlc2NyaXB0aW9ucy5zZXQoYmFyZU1hdGNoWzFdLCBcIlwiKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgcmV0dXJuIGRlc2NyaXB0aW9ucztcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQ29kZWJhc2VNYXBNZXRhZGF0YShjb250ZW50OiBzdHJpbmcpOiBDb2RlYmFzZU1hcE1ldGFkYXRhIHwgbnVsbCB7XG4gIGNvbnN0IG1ldGFMaW5lID0gY29udGVudFxuICAgIC5zcGxpdChcIlxcblwiKVxuICAgIC5maW5kKChsaW5lKSA9PiBsaW5lLnRyaW1TdGFydCgpLnN0YXJ0c1dpdGgoQ09ERUJBU0VfTUVUQURBVEFfUFJFRklYKSk7XG4gIGlmICghbWV0YUxpbmUpIHJldHVybiBudWxsO1xuXG4gIGNvbnN0IHRyaW1tZWQgPSBtZXRhTGluZS50cmltKCk7XG4gIGNvbnN0IGpzb25TdGFydCA9IENPREVCQVNFX01FVEFEQVRBX1BSRUZJWC5sZW5ndGg7XG4gIGNvbnN0IGpzb25FbmQgPSB0cmltbWVkLmxhc3RJbmRleE9mKFwiIC0tPlwiKTtcbiAgaWYgKGpzb25FbmQgPD0ganNvblN0YXJ0KSByZXR1cm4gbnVsbDtcblxuICB0cnkge1xuICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UodHJpbW1lZC5zbGljZShqc29uU3RhcnQsIGpzb25FbmQpKTtcbiAgICBpZiAoXG4gICAgICB0eXBlb2YgcGFyc2VkPy5nZW5lcmF0ZWRBdCA9PT0gXCJzdHJpbmdcIlxuICAgICAgJiYgdHlwZW9mIHBhcnNlZD8uZmluZ2VycHJpbnQgPT09IFwic3RyaW5nXCJcbiAgICAgICYmIHR5cGVvZiBwYXJzZWQ/LmZpbGVDb3VudCA9PT0gXCJudW1iZXJcIlxuICAgICAgJiYgdHlwZW9mIHBhcnNlZD8udHJ1bmNhdGVkID09PSBcImJvb2xlYW5cIlxuICAgICkge1xuICAgICAgcmV0dXJuIHBhcnNlZCBhcyBDb2RlYmFzZU1hcE1ldGFkYXRhO1xuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gSWdub3JlIG1hbGZvcm1lZCBtZXRhZGF0YSBhbmQgdHJlYXQgdGhlIG1hcCBhcyBzdGFsZS5cbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEZpbGUgRW51bWVyYXRpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIHNob3VsZEV4Y2x1ZGUoZmlsZVBhdGg6IHN0cmluZywgZXhjbHVkZXM6IHN0cmluZ1tdKTogYm9vbGVhbiB7XG4gIGZvciAoY29uc3QgcGF0dGVybiBvZiBleGNsdWRlcykge1xuICAgIGlmIChwYXR0ZXJuLmVuZHNXaXRoKFwiL1wiKSkge1xuICAgICAgaWYgKGZpbGVQYXRoLnN0YXJ0c1dpdGgocGF0dGVybikgfHwgZmlsZVBhdGguaW5jbHVkZXMoYC8ke3BhdHRlcm59YCkpIHJldHVybiB0cnVlO1xuICAgIH0gZWxzZSBpZiAoZmlsZVBhdGggPT09IHBhdHRlcm4gfHwgZmlsZVBhdGguZW5kc1dpdGgoYC8ke3BhdHRlcm59YCkpIHtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgfVxuICAvLyBTa2lwIGJpbmFyeS9sb2NrIGZpbGVzXG4gIGNvbnN0IGV4dCA9IGV4dG5hbWUoZmlsZVBhdGgpLnRvTG93ZXJDYXNlKCk7XG4gIGlmIChbXCIubG9ja1wiLCBcIi5wbmdcIiwgXCIuanBnXCIsIFwiLmpwZWdcIiwgXCIuZ2lmXCIsIFwiLmljb1wiLCBcIi53b2ZmXCIsIFwiLndvZmYyXCIsIFwiLnR0ZlwiLCBcIi5lb3RcIiwgXCIuc3ZnXCJdLmluY2x1ZGVzKGV4dCkpIHtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICByZXR1cm4gZmFsc2U7XG59XG5cbmZ1bmN0aW9uIGxzRmlsZXMoYmFzZVBhdGg6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXN1bHQgPSBleGVjU3luYyhcImdpdCBscy1maWxlc1wiLCB7IGN3ZDogYmFzZVBhdGgsIGVuY29kaW5nOiBcInV0Zi04XCIsIHRpbWVvdXQ6IDEwMDAwIH0pO1xuICAgIHJldHVybiByZXN1bHQuc3BsaXQoXCJcXG5cIikuZmlsdGVyKEJvb2xlYW4pO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gW107XG4gIH1cbn1cblxuLyoqXG4gKiBFbnVtZXJhdGUgdHJhY2tlZCBmaWxlcywgYXBwbHlpbmcgZXhjbHVzaW9ucyBhbmQgdGhlIG1heEZpbGVzIGNhcC5cbiAqIFJldHVybnMgYm90aCB0aGUgZmlsZSBsaXN0IGFuZCB3aGV0aGVyIHRydW5jYXRpb24gb2NjdXJyZWQuXG4gKi9cbmZ1bmN0aW9uIGVudW1lcmF0ZUZpbGVzKGJhc2VQYXRoOiBzdHJpbmcsIGV4Y2x1ZGVzOiBzdHJpbmdbXSwgbWF4RmlsZXM6IG51bWJlcik6IHsgZmlsZXM6IHN0cmluZ1tdOyB0cnVuY2F0ZWQ6IGJvb2xlYW4gfSB7XG4gIGNvbnN0IGFsbEZpbGVzID0gbHNGaWxlcyhiYXNlUGF0aCk7XG4gIGNvbnN0IGZpbHRlcmVkID0gYWxsRmlsZXMuZmlsdGVyKChmKSA9PiAhc2hvdWxkRXhjbHVkZShmLCBleGNsdWRlcykpO1xuICBjb25zdCB0cnVuY2F0ZWQgPSBmaWx0ZXJlZC5sZW5ndGggPiBtYXhGaWxlcztcbiAgcmV0dXJuIHsgZmlsZXM6IHRydW5jYXRlZCA/IGZpbHRlcmVkLnNsaWNlKDAsIG1heEZpbGVzKSA6IGZpbHRlcmVkLCB0cnVuY2F0ZWQgfTtcbn1cblxuZnVuY3Rpb24gcmVzb2x2ZUdlbmVyYXRvck9wdGlvbnMob3B0aW9ucz86IENvZGViYXNlTWFwT3B0aW9ucyk6IFJlc29sdmVkQ29kZWJhc2VNYXBPcHRpb25zIHtcbiAgY29uc3QgZXhjbHVkZXMgPSBbLi4uREVGQVVMVF9FWENMVURFUywgLi4uKG9wdGlvbnM/LmV4Y2x1ZGVQYXR0ZXJucyA/PyBbXSldO1xuICBjb25zdCBtYXhGaWxlcyA9IG9wdGlvbnM/Lm1heEZpbGVzID8/IERFRkFVTFRfTUFYX0ZJTEVTO1xuICBjb25zdCBjb2xsYXBzZVRocmVzaG9sZCA9IG9wdGlvbnM/LmNvbGxhcHNlVGhyZXNob2xkID8/IERFRkFVTFRfQ09MTEFQU0VfVEhSRVNIT0xEO1xuICByZXR1cm4ge1xuICAgIGV4Y2x1ZGVzLFxuICAgIG1heEZpbGVzLFxuICAgIGNvbGxhcHNlVGhyZXNob2xkLFxuICAgIG9wdGlvblNpZ25hdHVyZTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgZXhjbHVkZXMsXG4gICAgICBtYXhGaWxlcyxcbiAgICAgIGNvbGxhcHNlVGhyZXNob2xkLFxuICAgIH0pLFxuICB9O1xufVxuXG5mdW5jdGlvbiBjb21wdXRlQ29kZWJhc2VGaW5nZXJwcmludChcbiAgZmlsZXM6IHN0cmluZ1tdLFxuICByZXNvbHZlZDogUmVzb2x2ZWRDb2RlYmFzZU1hcE9wdGlvbnMsXG4gIHRydW5jYXRlZDogYm9vbGVhbixcbik6IHN0cmluZyB7XG4gIHJldHVybiBjcmVhdGVIYXNoKFwic2hhMVwiKVxuICAgIC51cGRhdGUoSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgZmlsZXMsXG4gICAgICB0cnVuY2F0ZWQsXG4gICAgICBvcHRpb25TaWduYXR1cmU6IHJlc29sdmVkLm9wdGlvblNpZ25hdHVyZSxcbiAgICB9KSlcbiAgICAuZGlnZXN0KFwiaGV4XCIpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgR3JvdXBpbmcgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIGdyb3VwQnlEaXJlY3RvcnkoXG4gIGZpbGVzOiBzdHJpbmdbXSxcbiAgZGVzY3JpcHRpb25zOiBNYXA8c3RyaW5nLCBzdHJpbmc+LFxuICBjb2xsYXBzZVRocmVzaG9sZDogbnVtYmVyLFxuKTogRGlyZWN0b3J5R3JvdXBbXSB7XG4gIGNvbnN0IGRpck1hcCA9IG5ldyBNYXA8c3RyaW5nLCBGaWxlRW50cnlbXT4oKTtcblxuICBmb3IgKGNvbnN0IGZpbGUgb2YgZmlsZXMpIHtcbiAgICBjb25zdCBkaXIgPSBkaXJuYW1lKGZpbGUpO1xuICAgIGNvbnN0IGRpcktleSA9IGRpciA9PT0gXCIuXCIgPyBcIlwiIDogZGlyO1xuICAgIGlmICghZGlyTWFwLmhhcyhkaXJLZXkpKSB7XG4gICAgICBkaXJNYXAuc2V0KGRpcktleSwgW10pO1xuICAgIH1cbiAgICBkaXJNYXAuZ2V0KGRpcktleSkhLnB1c2goe1xuICAgICAgcGF0aDogZmlsZSxcbiAgICAgIGRlc2NyaXB0aW9uOiBkZXNjcmlwdGlvbnMuZ2V0KGZpbGUpID8/IFwiXCIsXG4gICAgfSk7XG4gIH1cblxuICBjb25zdCBncm91cHM6IERpcmVjdG9yeUdyb3VwW10gPSBbXTtcbiAgY29uc3Qgc29ydGVkRGlycyA9IFsuLi5kaXJNYXAua2V5cygpXS5zb3J0KCk7XG5cbiAgZm9yIChjb25zdCBkaXIgb2Ygc29ydGVkRGlycykge1xuICAgIGNvbnN0IGRpckZpbGVzID0gZGlyTWFwLmdldChkaXIpITtcbiAgICBkaXJGaWxlcy5zb3J0KChhLCBiKSA9PiBhLnBhdGgubG9jYWxlQ29tcGFyZShiLnBhdGgpKTtcblxuICAgIGdyb3Vwcy5wdXNoKHtcbiAgICAgIHBhdGg6IGRpcixcbiAgICAgIGZpbGVzOiBkaXJGaWxlcyxcbiAgICAgIGNvbGxhcHNlZDogZGlyRmlsZXMubGVuZ3RoID4gY29sbGFwc2VUaHJlc2hvbGQsXG4gICAgfSk7XG4gIH1cblxuICByZXR1cm4gZ3JvdXBzO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUmVuZGVyaW5nIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiByZW5kZXJDb2RlYmFzZU1hcChcbiAgZ3JvdXBzOiBEaXJlY3RvcnlHcm91cFtdLFxuICB0b3RhbEZpbGVzOiBudW1iZXIsXG4gIHRydW5jYXRlZDogYm9vbGVhbixcbiAgbWV0YWRhdGE6IENvZGViYXNlTWFwTWV0YWRhdGEsXG4pOiBzdHJpbmcge1xuICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgZGVzY3JpYmVkID0gZ3JvdXBzLnJlZHVjZSgoc3VtLCBnKSA9PiBzdW0gKyBnLmZpbGVzLmZpbHRlcigoZikgPT4gZi5kZXNjcmlwdGlvbikubGVuZ3RoLCAwKTtcblxuICBsaW5lcy5wdXNoKFwiIyBDb2RlYmFzZSBNYXBcIik7XG4gIGxpbmVzLnB1c2goXCJcIik7XG4gIGxpbmVzLnB1c2goYEdlbmVyYXRlZDogJHttZXRhZGF0YS5nZW5lcmF0ZWRBdH0gfCBGaWxlczogJHt0b3RhbEZpbGVzfSB8IERlc2NyaWJlZDogJHtkZXNjcmliZWR9LyR7dG90YWxGaWxlc31gKTtcbiAgbGluZXMucHVzaChgJHtDT0RFQkFTRV9NRVRBREFUQV9QUkVGSVh9JHtKU09OLnN0cmluZ2lmeShtZXRhZGF0YSl9IC0tPmApO1xuICBpZiAodHJ1bmNhdGVkKSB7XG4gICAgbGluZXMucHVzaChgTm90ZTogVHJ1bmNhdGVkIHRvIGZpcnN0ICR7dG90YWxGaWxlc30gZmlsZXMuIFJ1biB3aXRoIGhpZ2hlciAtLW1heC1maWxlcyB0byBpbmNsdWRlIGFsbC5gKTtcbiAgfVxuICBsaW5lcy5wdXNoKFwiXCIpO1xuXG4gIGZvciAoY29uc3QgZ3JvdXAgb2YgZ3JvdXBzKSB7XG4gICAgY29uc3QgaGVhZGluZyA9IGdyb3VwLnBhdGggfHwgXCIocm9vdClcIjtcbiAgICBsaW5lcy5wdXNoKGAjIyMgJHtoZWFkaW5nfS9gKTtcblxuICAgIGlmIChncm91cC5jb2xsYXBzZWQpIHtcbiAgICAgIC8vIFN1bW1hcml6ZSBjb2xsYXBzZWQgZGlyZWN0b3JpZXNcbiAgICAgIGNvbnN0IGV4dGVuc2lvbnMgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuICAgICAgZm9yIChjb25zdCBmIG9mIGdyb3VwLmZpbGVzKSB7XG4gICAgICAgIGNvbnN0IGV4dCA9IGV4dG5hbWUoZi5wYXRoKSB8fCBcIihubyBleHQpXCI7XG4gICAgICAgIGV4dGVuc2lvbnMuc2V0KGV4dCwgKGV4dGVuc2lvbnMuZ2V0KGV4dCkgPz8gMCkgKyAxKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGV4dFN1bW1hcnkgPSBbLi4uZXh0ZW5zaW9ucy5lbnRyaWVzKCldXG4gICAgICAgIC5zb3J0KChhLCBiKSA9PiBiWzFdIC0gYVsxXSlcbiAgICAgICAgLm1hcCgoW2V4dCwgY291bnRdKSA9PiBgJHtjb3VudH0gJHtleHR9YClcbiAgICAgICAgLmpvaW4oXCIsIFwiKTtcbiAgICAgIGxpbmVzLnB1c2goYC0gKigke2dyb3VwLmZpbGVzLmxlbmd0aH0gZmlsZXM6ICR7ZXh0U3VtbWFyeX0pKmApO1xuXG4gICAgICAvLyBQcmVzZXJ2ZSBhbnkgZXhpc3RpbmcgZGVzY3JpcHRpb25zIGluIGEgaGlkZGVuIGNvbW1lbnQgYmxvY2sgc29cbiAgICAgIC8vIGluY3JlbWVudGFsIHVwZGF0ZXMgY2FuIHJlY292ZXIgdGhlbSB2aWEgcGFyc2VDb2RlYmFzZU1hcC5cbiAgICAgIGNvbnN0IGRlc2NMaW5lcyA9IGdyb3VwLmZpbGVzXG4gICAgICAgIC5maWx0ZXIoKGYpID0+IGYuZGVzY3JpcHRpb24pXG4gICAgICAgIC5tYXAoKGYpID0+IGAtIFxcYCR7Zi5wYXRofVxcYCBcdTIwMTQgJHtmLmRlc2NyaXB0aW9ufWApO1xuICAgICAgaWYgKGRlc2NMaW5lcy5sZW5ndGggPiAwKSB7XG4gICAgICAgIGxpbmVzLnB1c2goXCI8IS0tIGdzZDpjb2xsYXBzZWQtZGVzY3JpcHRpb25zXCIpO1xuICAgICAgICBsaW5lcy5wdXNoKC4uLmRlc2NMaW5lcyk7XG4gICAgICAgIGxpbmVzLnB1c2goXCItLT5cIik7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIGZvciAoY29uc3QgZmlsZSBvZiBncm91cC5maWxlcykge1xuICAgICAgICBpZiAoZmlsZS5kZXNjcmlwdGlvbikge1xuICAgICAgICAgIGxpbmVzLnB1c2goYC0gXFxgJHtmaWxlLnBhdGh9XFxgIFx1MjAxNCAke2ZpbGUuZGVzY3JpcHRpb259YCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgbGluZXMucHVzaChgLSBcXGAke2ZpbGUucGF0aH1cXGBgKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICB9XG5cbiAgcmV0dXJuIGxpbmVzLmpvaW4oXCJcXG5cIik7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkQ29kZWJhc2VNYXAoXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIHJlc29sdmVkOiBSZXNvbHZlZENvZGViYXNlTWFwT3B0aW9ucyxcbiAgZXhpc3RpbmdEZXNjcmlwdGlvbnM/OiBNYXA8c3RyaW5nLCBzdHJpbmc+LFxuICBlbnVtZXJhdGVkPzogRW51bWVyYXRlZEZpbGVzLFxuKToge1xuICBjb250ZW50OiBzdHJpbmc7XG4gIGZpbGVDb3VudDogbnVtYmVyO1xuICB0cnVuY2F0ZWQ6IGJvb2xlYW47XG4gIGZpbGVzOiBzdHJpbmdbXTtcbiAgZmluZ2VycHJpbnQ6IHN0cmluZztcbiAgZ2VuZXJhdGVkQXQ6IHN0cmluZztcbn0ge1xuICBjb25zdCBsaXN0ZWQgPSBlbnVtZXJhdGVkID8/IGVudW1lcmF0ZUZpbGVzKGJhc2VQYXRoLCByZXNvbHZlZC5leGNsdWRlcywgcmVzb2x2ZWQubWF4RmlsZXMpO1xuICBjb25zdCBkZXNjcmlwdGlvbnMgPSBleGlzdGluZ0Rlc2NyaXB0aW9ucyA/PyBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICBjb25zdCBncm91cHMgPSBncm91cEJ5RGlyZWN0b3J5KGxpc3RlZC5maWxlcywgZGVzY3JpcHRpb25zLCByZXNvbHZlZC5jb2xsYXBzZVRocmVzaG9sZCk7XG4gIGNvbnN0IGdlbmVyYXRlZEF0ID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpLnNwbGl0KFwiLlwiKVswXSArIFwiWlwiO1xuICBjb25zdCBtZXRhZGF0YTogQ29kZWJhc2VNYXBNZXRhZGF0YSA9IHtcbiAgICBnZW5lcmF0ZWRBdCxcbiAgICBmaW5nZXJwcmludDogY29tcHV0ZUNvZGViYXNlRmluZ2VycHJpbnQobGlzdGVkLmZpbGVzLCByZXNvbHZlZCwgbGlzdGVkLnRydW5jYXRlZCksXG4gICAgZmlsZUNvdW50OiBsaXN0ZWQuZmlsZXMubGVuZ3RoLFxuICAgIHRydW5jYXRlZDogbGlzdGVkLnRydW5jYXRlZCxcbiAgfTtcbiAgY29uc3QgY29udGVudCA9IHJlbmRlckNvZGViYXNlTWFwKGdyb3VwcywgbGlzdGVkLmZpbGVzLmxlbmd0aCwgbGlzdGVkLnRydW5jYXRlZCwgbWV0YWRhdGEpO1xuXG4gIHJldHVybiB7XG4gICAgY29udGVudCxcbiAgICBmaWxlQ291bnQ6IGxpc3RlZC5maWxlcy5sZW5ndGgsXG4gICAgdHJ1bmNhdGVkOiBsaXN0ZWQudHJ1bmNhdGVkLFxuICAgIGZpbGVzOiBsaXN0ZWQuZmlsZXMsXG4gICAgZmluZ2VycHJpbnQ6IG1ldGFkYXRhLmZpbmdlcnByaW50LFxuICAgIGdlbmVyYXRlZEF0LFxuICB9O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUHVibGljIEFQSSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBHZW5lcmF0ZSBhIGZyZXNoIENPREVCQVNFLm1kIGZyb20gc2NyYXRjaC5cbiAqIFByZXNlcnZlcyBleGlzdGluZyBkZXNjcmlwdGlvbnMgaWYgYGV4aXN0aW5nRGVzY3JpcHRpb25zYCBpcyBwcm92aWRlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdlbmVyYXRlQ29kZWJhc2VNYXAoXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIG9wdGlvbnM/OiBDb2RlYmFzZU1hcE9wdGlvbnMsXG4gIGV4aXN0aW5nRGVzY3JpcHRpb25zPzogTWFwPHN0cmluZywgc3RyaW5nPixcbik6IHsgY29udGVudDogc3RyaW5nOyBmaWxlQ291bnQ6IG51bWJlcjsgdHJ1bmNhdGVkOiBib29sZWFuOyBmaWxlczogc3RyaW5nW107IGZpbmdlcnByaW50OiBzdHJpbmc7IGdlbmVyYXRlZEF0OiBzdHJpbmcgfSB7XG4gIGNvbnN0IHJlc29sdmVkID0gcmVzb2x2ZUdlbmVyYXRvck9wdGlvbnMob3B0aW9ucyk7XG4gIHJldHVybiBidWlsZENvZGViYXNlTWFwKGJhc2VQYXRoLCByZXNvbHZlZCwgZXhpc3RpbmdEZXNjcmlwdGlvbnMpO1xufVxuXG4vKipcbiAqIEluY3JlbWVudGFsIHVwZGF0ZTogcmUtc2NhbiBmaWxlcywgcHJlc2VydmUgZXhpc3RpbmcgZGVzY3JpcHRpb25zLFxuICogYWRkIG5ldyBmaWxlcywgcmVtb3ZlIGRlbGV0ZWQgZmlsZXMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVDb2RlYmFzZU1hcChcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgb3B0aW9ucz86IENvZGViYXNlTWFwT3B0aW9ucyxcbik6IHtcbiAgY29udGVudDogc3RyaW5nO1xuICBhZGRlZDogbnVtYmVyO1xuICByZW1vdmVkOiBudW1iZXI7XG4gIHVuY2hhbmdlZDogbnVtYmVyO1xuICBmaWxlQ291bnQ6IG51bWJlcjtcbiAgdHJ1bmNhdGVkOiBib29sZWFuO1xuICBmaW5nZXJwcmludDogc3RyaW5nO1xuICBnZW5lcmF0ZWRBdDogc3RyaW5nO1xufSB7XG4gIGNvbnN0IGNvZGViYXNlUGF0aCA9IGpvaW4oZ3NkUm9vdChiYXNlUGF0aCksIFwiQ09ERUJBU0UubWRcIik7XG4gIGNvbnN0IHJlc29sdmVkID0gcmVzb2x2ZUdlbmVyYXRvck9wdGlvbnMob3B0aW9ucyk7XG5cbiAgLy8gTG9hZCBleGlzdGluZyBkZXNjcmlwdGlvbnNcbiAgbGV0IGV4aXN0aW5nRGVzY3JpcHRpb25zID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcbiAgaWYgKGV4aXN0c1N5bmMoY29kZWJhc2VQYXRoKSkge1xuICAgIGNvbnN0IGV4aXN0aW5nID0gcmVhZEZpbGVTeW5jKGNvZGViYXNlUGF0aCwgXCJ1dGYtOFwiKTtcbiAgICBleGlzdGluZ0Rlc2NyaXB0aW9ucyA9IHBhcnNlQ29kZWJhc2VNYXAoZXhpc3RpbmcpO1xuICB9XG5cbiAgY29uc3QgZXhpc3RpbmdGaWxlcyA9IG5ldyBTZXQoZXhpc3RpbmdEZXNjcmlwdGlvbnMua2V5cygpKTtcblxuICAvLyBHZW5lcmF0ZSBuZXcgbWFwIHByZXNlcnZpbmcgZGVzY3JpcHRpb25zIFx1MjAxNCByZXVzZSB0aGUgcmV0dXJuZWQgZmlsZSBsaXN0XG4gIC8vIHRvIGF2b2lkIGEgc2Vjb25kIGVudW1lcmF0aW9uIChwcmV2ZW50cyByYWNlIGJldHdlZW4gY29udGVudCBhbmQgc3RhdHMpLlxuICBjb25zdCByZXN1bHQgPSBidWlsZENvZGViYXNlTWFwKGJhc2VQYXRoLCByZXNvbHZlZCwgZXhpc3RpbmdEZXNjcmlwdGlvbnMpO1xuICBjb25zdCBjdXJyZW50U2V0ID0gbmV3IFNldChyZXN1bHQuZmlsZXMpO1xuXG4gIC8vIENvdW50IGNoYW5nZXNcbiAgbGV0IGFkZGVkID0gMDtcbiAgbGV0IHJlbW92ZWQgPSAwO1xuXG4gIGZvciAoY29uc3QgZiBvZiByZXN1bHQuZmlsZXMpIHtcbiAgICBpZiAoIWV4aXN0aW5nRmlsZXMuaGFzKGYpKSBhZGRlZCsrO1xuICB9XG4gIGZvciAoY29uc3QgZiBvZiBleGlzdGluZ0ZpbGVzKSB7XG4gICAgaWYgKCFjdXJyZW50U2V0LmhhcyhmKSkgcmVtb3ZlZCsrO1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBjb250ZW50OiByZXN1bHQuY29udGVudCxcbiAgICBhZGRlZCxcbiAgICByZW1vdmVkLFxuICAgIHVuY2hhbmdlZDogcmVzdWx0LmZpbGVzLmxlbmd0aCAtIGFkZGVkLFxuICAgIGZpbGVDb3VudDogcmVzdWx0LmZpbGVDb3VudCxcbiAgICB0cnVuY2F0ZWQ6IHJlc3VsdC50cnVuY2F0ZWQsXG4gICAgZmluZ2VycHJpbnQ6IHJlc3VsdC5maW5nZXJwcmludCxcbiAgICBnZW5lcmF0ZWRBdDogcmVzdWx0LmdlbmVyYXRlZEF0LFxuICB9O1xufVxuXG5mdW5jdGlvbiBjbGVhckZyZXNobmVzc0NhY2hlKGJhc2VQYXRoOiBzdHJpbmcpOiB2b2lkIHtcbiAgZm9yIChjb25zdCBrZXkgb2YgZnJlc2huZXNzQ2FjaGUua2V5cygpKSB7XG4gICAgaWYgKGtleSA9PT0gYmFzZVBhdGggfHwga2V5LnN0YXJ0c1dpdGgoYCR7YmFzZVBhdGh9OjpgKSkge1xuICAgICAgZnJlc2huZXNzQ2FjaGUuZGVsZXRlKGtleSk7XG4gICAgfVxuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBlbnN1cmVDb2RlYmFzZU1hcEZyZXNoKFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICBvcHRpb25zPzogQ29kZWJhc2VNYXBPcHRpb25zLFxuICBlbnN1cmVPcHRpb25zPzogRW5zdXJlQ29kZWJhc2VNYXBPcHRpb25zLFxuKTogRW5zdXJlQ29kZWJhc2VNYXBSZXN1bHQge1xuICBjb25zdCByZXNvbHZlZCA9IHJlc29sdmVHZW5lcmF0b3JPcHRpb25zKG9wdGlvbnMpO1xuICBjb25zdCBjYWNoZUtleSA9IGAke2Jhc2VQYXRofTo6JHtyZXNvbHZlZC5vcHRpb25TaWduYXR1cmV9YDtcbiAgY29uc3QgdHRsTXMgPSBlbnN1cmVPcHRpb25zPy50dGxNcyA/PyBERUZBVUxUX1JFRlJFU0hfVFRMX01TO1xuICBjb25zdCBtYXhBZ2VNcyA9IGVuc3VyZU9wdGlvbnM/Lm1heEFnZU1zID8/IERFRkFVTFRfTUFYX0FHRV9NUztcbiAgY29uc3QgZm9yY2UgPSBlbnN1cmVPcHRpb25zPy5mb3JjZSA9PT0gdHJ1ZTtcbiAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcblxuICBpZiAoIWZvcmNlICYmIHR0bE1zID4gMCkge1xuICAgIGNvbnN0IGNhY2hlZCA9IGZyZXNobmVzc0NhY2hlLmdldChjYWNoZUtleSk7XG4gICAgaWYgKGNhY2hlZCAmJiBub3cgLSBjYWNoZWQuY2hlY2tlZEF0IDwgdHRsTXMpIHtcbiAgICAgIHJldHVybiBjYWNoZWQucmVzdWx0O1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IGV4aXN0aW5nID0gcmVhZENvZGViYXNlTWFwKGJhc2VQYXRoKTtcbiAgY29uc3QgbGlzdGVkID0gZW51bWVyYXRlRmlsZXMoYmFzZVBhdGgsIHJlc29sdmVkLmV4Y2x1ZGVzLCByZXNvbHZlZC5tYXhGaWxlcyk7XG4gIGNvbnN0IGZpbmdlcnByaW50ID0gY29tcHV0ZUNvZGViYXNlRmluZ2VycHJpbnQobGlzdGVkLmZpbGVzLCByZXNvbHZlZCwgbGlzdGVkLnRydW5jYXRlZCk7XG5cbiAgY29uc3QgY2FjaGVBbmRSZXR1cm4gPSAocmVzdWx0OiBFbnN1cmVDb2RlYmFzZU1hcFJlc3VsdCk6IEVuc3VyZUNvZGViYXNlTWFwUmVzdWx0ID0+IHtcbiAgICBmcmVzaG5lc3NDYWNoZS5zZXQoY2FjaGVLZXksIHsgY2hlY2tlZEF0OiBub3csIHJlc3VsdCB9KTtcbiAgICByZXR1cm4gcmVzdWx0O1xuICB9O1xuXG4gIGlmICghZXhpc3RpbmcpIHtcbiAgICBjb25zdCBnZW5lcmF0ZWQgPSBidWlsZENvZGViYXNlTWFwKGJhc2VQYXRoLCByZXNvbHZlZCwgdW5kZWZpbmVkLCBsaXN0ZWQpO1xuICAgIGlmIChnZW5lcmF0ZWQuZmlsZUNvdW50ID4gMCkge1xuICAgICAgd3JpdGVDb2RlYmFzZU1hcChiYXNlUGF0aCwgZ2VuZXJhdGVkLmNvbnRlbnQpO1xuICAgICAgcmV0dXJuIGNhY2hlQW5kUmV0dXJuKHtcbiAgICAgICAgc3RhdHVzOiBcImdlbmVyYXRlZFwiLFxuICAgICAgICBmaWxlQ291bnQ6IGdlbmVyYXRlZC5maWxlQ291bnQsXG4gICAgICAgIHRydW5jYXRlZDogZ2VuZXJhdGVkLnRydW5jYXRlZCxcbiAgICAgICAgZ2VuZXJhdGVkQXQ6IGdlbmVyYXRlZC5nZW5lcmF0ZWRBdCxcbiAgICAgICAgZmluZ2VycHJpbnQ6IGdlbmVyYXRlZC5maW5nZXJwcmludCxcbiAgICAgICAgcmVhc29uOiBcIm1pc3NpbmdcIixcbiAgICAgIH0pO1xuICAgIH1cbiAgICByZXR1cm4gY2FjaGVBbmRSZXR1cm4oe1xuICAgICAgc3RhdHVzOiBcImVtcHR5XCIsXG4gICAgICBmaWxlQ291bnQ6IDAsXG4gICAgICB0cnVuY2F0ZWQ6IGZhbHNlLFxuICAgICAgZ2VuZXJhdGVkQXQ6IG51bGwsXG4gICAgICBmaW5nZXJwcmludCxcbiAgICAgIHJlYXNvbjogXCJuby10cmFja2VkLWZpbGVzXCIsXG4gICAgfSk7XG4gIH1cblxuICBjb25zdCBtZXRhZGF0YSA9IHBhcnNlQ29kZWJhc2VNYXBNZXRhZGF0YShleGlzdGluZyk7XG4gIGNvbnN0IGV4aXN0aW5nRGVzY3JpcHRpb25zID0gcGFyc2VDb2RlYmFzZU1hcChleGlzdGluZyk7XG4gIGNvbnN0IGFnZU1zID0gbWV0YWRhdGEgPyBub3cgLSBEYXRlLnBhcnNlKG1ldGFkYXRhLmdlbmVyYXRlZEF0KSA6IE51bWJlci5QT1NJVElWRV9JTkZJTklUWTtcbiAgY29uc3Qgc3RhbGVSZWFzb24gPVxuICAgICFtZXRhZGF0YSA/IFwibWlzc2luZy1tZXRhZGF0YVwiXG4gICAgOiBtZXRhZGF0YS5maW5nZXJwcmludCAhPT0gZmluZ2VycHJpbnQgPyBcImZpbGVzLWNoYW5nZWRcIlxuICAgIDogbWV0YWRhdGEuZmlsZUNvdW50ICE9PSBsaXN0ZWQuZmlsZXMubGVuZ3RoID8gXCJmaWxlLWNvdW50LWNoYW5nZWRcIlxuICAgIDogbWV0YWRhdGEudHJ1bmNhdGVkICE9PSBsaXN0ZWQudHJ1bmNhdGVkID8gXCJ0cnVuY2F0aW9uLWNoYW5nZWRcIlxuICAgIDogbWF4QWdlTXMgPiAwICYmIE51bWJlci5pc0Zpbml0ZShhZ2VNcykgJiYgYWdlTXMgPiBtYXhBZ2VNcyA/IFwiZXhwaXJlZFwiXG4gICAgOiB1bmRlZmluZWQ7XG5cbiAgaWYgKCFzdGFsZVJlYXNvbikge1xuICAgIHJldHVybiBjYWNoZUFuZFJldHVybih7XG4gICAgICBzdGF0dXM6IFwiZnJlc2hcIixcbiAgICAgIGZpbGVDb3VudDogbWV0YWRhdGE/LmZpbGVDb3VudCA/PyBsaXN0ZWQuZmlsZXMubGVuZ3RoLFxuICAgICAgdHJ1bmNhdGVkOiBtZXRhZGF0YT8udHJ1bmNhdGVkID8/IGxpc3RlZC50cnVuY2F0ZWQsXG4gICAgICBnZW5lcmF0ZWRBdDogbWV0YWRhdGE/LmdlbmVyYXRlZEF0ID8/IG51bGwsXG4gICAgICBmaW5nZXJwcmludDogbWV0YWRhdGE/LmZpbmdlcnByaW50ID8/IGZpbmdlcnByaW50LFxuICAgIH0pO1xuICB9XG5cbiAgY29uc3QgdXBkYXRlZCA9IGJ1aWxkQ29kZWJhc2VNYXAoYmFzZVBhdGgsIHJlc29sdmVkLCBleGlzdGluZ0Rlc2NyaXB0aW9ucywgbGlzdGVkKTtcbiAgaWYgKHVwZGF0ZWQuZmlsZUNvdW50ID4gMCkge1xuICAgIHdyaXRlQ29kZWJhc2VNYXAoYmFzZVBhdGgsIHVwZGF0ZWQuY29udGVudCk7XG4gICAgcmV0dXJuIGNhY2hlQW5kUmV0dXJuKHtcbiAgICAgIHN0YXR1czogXCJ1cGRhdGVkXCIsXG4gICAgICBmaWxlQ291bnQ6IHVwZGF0ZWQuZmlsZUNvdW50LFxuICAgICAgdHJ1bmNhdGVkOiB1cGRhdGVkLnRydW5jYXRlZCxcbiAgICAgIGdlbmVyYXRlZEF0OiB1cGRhdGVkLmdlbmVyYXRlZEF0LFxuICAgICAgZmluZ2VycHJpbnQ6IHVwZGF0ZWQuZmluZ2VycHJpbnQsXG4gICAgICByZWFzb246IHN0YWxlUmVhc29uLFxuICAgIH0pO1xuICB9XG5cbiAgcmV0dXJuIGNhY2hlQW5kUmV0dXJuKHtcbiAgICBzdGF0dXM6IFwiZW1wdHlcIixcbiAgICBmaWxlQ291bnQ6IDAsXG4gICAgdHJ1bmNhdGVkOiBmYWxzZSxcbiAgICBnZW5lcmF0ZWRBdDogbnVsbCxcbiAgICBmaW5nZXJwcmludCxcbiAgICByZWFzb246IHN0YWxlUmVhc29uLFxuICB9KTtcbn1cblxuLyoqXG4gKiBXcml0ZSBDT0RFQkFTRS5tZCB0byAuZ3NkLyBkaXJlY3RvcnkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3cml0ZUNvZGViYXNlTWFwKGJhc2VQYXRoOiBzdHJpbmcsIGNvbnRlbnQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHJvb3QgPSBnc2RSb290KGJhc2VQYXRoKTtcbiAgbWtkaXJTeW5jKHJvb3QsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBjb25zdCBvdXRQYXRoID0gam9pbihyb290LCBcIkNPREVCQVNFLm1kXCIpO1xuICB3cml0ZUZpbGVTeW5jKG91dFBhdGgsIGNvbnRlbnQsIFwidXRmLThcIik7XG4gIGNsZWFyRnJlc2huZXNzQ2FjaGUoYmFzZVBhdGgpO1xuICByZXR1cm4gb3V0UGF0aDtcbn1cblxuLyoqXG4gKiBSZWFkIGV4aXN0aW5nIENPREVCQVNFLm1kLCBvciByZXR1cm4gbnVsbCBpZiBpdCBkb2Vzbid0IGV4aXN0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVhZENvZGViYXNlTWFwKGJhc2VQYXRoOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3QgY29kZWJhc2VQYXRoID0gam9pbihnc2RSb290KGJhc2VQYXRoKSwgXCJDT0RFQkFTRS5tZFwiKTtcbiAgaWYgKCFleGlzdHNTeW5jKGNvZGViYXNlUGF0aCkpIHJldHVybiBudWxsO1xuICB0cnkge1xuICAgIHJldHVybiByZWFkRmlsZVN5bmMoY29kZWJhc2VQYXRoLCBcInV0Zi04XCIpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG4vKipcbiAqIEdldCBzdGF0cyBhYm91dCB0aGUgY29kZWJhc2UgbWFwLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0Q29kZWJhc2VNYXBTdGF0cyhiYXNlUGF0aDogc3RyaW5nKToge1xuICBleGlzdHM6IGJvb2xlYW47XG4gIGZpbGVDb3VudDogbnVtYmVyO1xuICBkZXNjcmliZWRDb3VudDogbnVtYmVyO1xuICB1bmRlc2NyaWJlZENvdW50OiBudW1iZXI7XG4gIGdlbmVyYXRlZEF0OiBzdHJpbmcgfCBudWxsO1xufSB7XG4gIGNvbnN0IGNvbnRlbnQgPSByZWFkQ29kZWJhc2VNYXAoYmFzZVBhdGgpO1xuICBpZiAoIWNvbnRlbnQpIHtcbiAgICByZXR1cm4geyBleGlzdHM6IGZhbHNlLCBmaWxlQ291bnQ6IDAsIGRlc2NyaWJlZENvdW50OiAwLCB1bmRlc2NyaWJlZENvdW50OiAwLCBnZW5lcmF0ZWRBdDogbnVsbCB9O1xuICB9XG5cbiAgLy8gUGFyc2UgdG90YWwgZmlsZSBjb3VudCBmcm9tIHRoZSBoZWFkZXIgbGluZSAoYWNjdXJhdGUgZXZlbiBmb3IgY29sbGFwc2VkIGRpcnMpXG4gIGNvbnN0IGZpbGVDb3VudE1hdGNoID0gY29udGVudC5tYXRjaCgvRmlsZXM6XFxzKihcXGQrKS8pO1xuICBjb25zdCB0b3RhbEZpbGVzID0gZmlsZUNvdW50TWF0Y2ggPyBwYXJzZUludChmaWxlQ291bnRNYXRjaFsxXSwgMTApIDogMDtcblxuICAvLyBVc2UgcGFyc2VDb2RlYmFzZU1hcCB0byBjb3VudCBkZXNjcmliZWQgZmlsZXMgKGluY2x1ZGVzIGNvbGxhcHNlZC1kZXNjcmlwdGlvbiBibG9ja3MpXG4gIGNvbnN0IGRlc2NyaXB0aW9ucyA9IHBhcnNlQ29kZWJhc2VNYXAoY29udGVudCk7XG4gIGNvbnN0IGRlc2NyaWJlZCA9IFsuLi5kZXNjcmlwdGlvbnMudmFsdWVzKCldLmZpbHRlcigoZCkgPT4gZC5sZW5ndGggPiAwKS5sZW5ndGg7XG4gIGNvbnN0IGRhdGVNYXRjaCA9IGNvbnRlbnQubWF0Y2goL0dlbmVyYXRlZDogKFxcUyspLyk7XG5cbiAgcmV0dXJuIHtcbiAgICBleGlzdHM6IHRydWUsXG4gICAgZmlsZUNvdW50OiB0b3RhbEZpbGVzLFxuICAgIGRlc2NyaWJlZENvdW50OiBkZXNjcmliZWQsXG4gICAgdW5kZXNjcmliZWRDb3VudDogdG90YWxGaWxlcyAtIGRlc2NyaWJlZCxcbiAgICBnZW5lcmF0ZWRBdDogZGF0ZU1hdGNoPy5bMV0gPz8gbnVsbCxcbiAgfTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQVVBLFNBQVMsa0JBQWtCO0FBQzNCLFNBQVMsWUFBWSxjQUFjLGVBQWUsaUJBQWlCO0FBQ25FLFNBQVMsTUFBTSxTQUFTLGVBQWU7QUFFdkMsU0FBUyxnQkFBZ0I7QUFDekIsU0FBUyxlQUFlO0FBeUR4QixNQUFNLG1CQUFtQjtBQUFBO0FBQUEsRUFFdkI7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQTtBQUFBLEVBR0E7QUFBQSxFQUNBO0FBQUE7QUFBQSxFQUdBO0FBQUE7QUFBQSxFQUdBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUE7QUFBQSxFQUdBO0FBQUEsRUFDQTtBQUNGO0FBRUEsTUFBTSxvQkFBb0I7QUFDMUIsTUFBTSw2QkFBNkI7QUFDbkMsTUFBTSx5QkFBeUI7QUFDL0IsTUFBTSxxQkFBcUIsS0FBSztBQUNoQyxNQUFNLDJCQUEyQjtBQUVqQyxNQUFNLGlCQUFpQixvQkFBSSxJQUFvRTtBQVN4RixTQUFTLGlCQUFpQixTQUFzQztBQUNyRSxRQUFNLGVBQWUsb0JBQUksSUFBb0I7QUFDN0MsTUFBSSxtQkFBbUI7QUFFdkIsYUFBVyxRQUFRLFFBQVEsTUFBTSxJQUFJLEdBQUc7QUFFdEMsUUFBSSxLQUFLLFVBQVUsRUFBRSxXQUFXLGlDQUFpQyxHQUFHO0FBQ2xFLHlCQUFtQjtBQUNuQjtBQUFBLElBQ0Y7QUFDQSxRQUFJLG9CQUFvQixLQUFLLFVBQVUsRUFBRSxXQUFXLEtBQUssR0FBRztBQUMxRCx5QkFBbUI7QUFDbkI7QUFBQSxJQUNGO0FBR0EsVUFBTSxRQUFRLEtBQUssTUFBTSxvQkFBb0I7QUFDN0MsUUFBSSxPQUFPO0FBQ1QsbUJBQWEsSUFBSSxNQUFNLENBQUMsR0FBRyxNQUFNLENBQUMsQ0FBQztBQUNuQztBQUFBLElBQ0Y7QUFHQSxRQUFJLENBQUMsa0JBQWtCO0FBQ3JCLFlBQU0sWUFBWSxLQUFLLE1BQU0sZ0JBQWdCO0FBQzdDLFVBQUksV0FBVztBQUNiLHFCQUFhLElBQUksVUFBVSxDQUFDLEdBQUcsRUFBRTtBQUFBLE1BQ25DO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFDQSxTQUFPO0FBQ1Q7QUFFTyxTQUFTLHlCQUF5QixTQUE2QztBQUNwRixRQUFNLFdBQVcsUUFDZCxNQUFNLElBQUksRUFDVixLQUFLLENBQUMsU0FBUyxLQUFLLFVBQVUsRUFBRSxXQUFXLHdCQUF3QixDQUFDO0FBQ3ZFLE1BQUksQ0FBQyxTQUFVLFFBQU87QUFFdEIsUUFBTSxVQUFVLFNBQVMsS0FBSztBQUM5QixRQUFNLFlBQVkseUJBQXlCO0FBQzNDLFFBQU0sVUFBVSxRQUFRLFlBQVksTUFBTTtBQUMxQyxNQUFJLFdBQVcsVUFBVyxRQUFPO0FBRWpDLE1BQUk7QUFDRixVQUFNLFNBQVMsS0FBSyxNQUFNLFFBQVEsTUFBTSxXQUFXLE9BQU8sQ0FBQztBQUMzRCxRQUNFLE9BQU8sUUFBUSxnQkFBZ0IsWUFDNUIsT0FBTyxRQUFRLGdCQUFnQixZQUMvQixPQUFPLFFBQVEsY0FBYyxZQUM3QixPQUFPLFFBQVEsY0FBYyxXQUNoQztBQUNBLGFBQU87QUFBQSxJQUNUO0FBQUEsRUFDRixRQUFRO0FBQUEsRUFFUjtBQUNBLFNBQU87QUFDVDtBQUlBLFNBQVMsY0FBYyxVQUFrQixVQUE2QjtBQUNwRSxhQUFXLFdBQVcsVUFBVTtBQUM5QixRQUFJLFFBQVEsU0FBUyxHQUFHLEdBQUc7QUFDekIsVUFBSSxTQUFTLFdBQVcsT0FBTyxLQUFLLFNBQVMsU0FBUyxJQUFJLE9BQU8sRUFBRSxFQUFHLFFBQU87QUFBQSxJQUMvRSxXQUFXLGFBQWEsV0FBVyxTQUFTLFNBQVMsSUFBSSxPQUFPLEVBQUUsR0FBRztBQUNuRSxhQUFPO0FBQUEsSUFDVDtBQUFBLEVBQ0Y7QUFFQSxRQUFNLE1BQU0sUUFBUSxRQUFRLEVBQUUsWUFBWTtBQUMxQyxNQUFJLENBQUMsU0FBUyxRQUFRLFFBQVEsU0FBUyxRQUFRLFFBQVEsU0FBUyxVQUFVLFFBQVEsUUFBUSxNQUFNLEVBQUUsU0FBUyxHQUFHLEdBQUc7QUFDL0csV0FBTztBQUFBLEVBQ1Q7QUFDQSxTQUFPO0FBQ1Q7QUFFQSxTQUFTLFFBQVEsVUFBNEI7QUFDM0MsTUFBSTtBQUNGLFVBQU0sU0FBUyxTQUFTLGdCQUFnQixFQUFFLEtBQUssVUFBVSxVQUFVLFNBQVMsU0FBUyxJQUFNLENBQUM7QUFDNUYsV0FBTyxPQUFPLE1BQU0sSUFBSSxFQUFFLE9BQU8sT0FBTztBQUFBLEVBQzFDLFFBQVE7QUFDTixXQUFPLENBQUM7QUFBQSxFQUNWO0FBQ0Y7QUFNQSxTQUFTLGVBQWUsVUFBa0IsVUFBb0IsVUFBMkQ7QUFDdkgsUUFBTSxXQUFXLFFBQVEsUUFBUTtBQUNqQyxRQUFNLFdBQVcsU0FBUyxPQUFPLENBQUMsTUFBTSxDQUFDLGNBQWMsR0FBRyxRQUFRLENBQUM7QUFDbkUsUUFBTSxZQUFZLFNBQVMsU0FBUztBQUNwQyxTQUFPLEVBQUUsT0FBTyxZQUFZLFNBQVMsTUFBTSxHQUFHLFFBQVEsSUFBSSxVQUFVLFVBQVU7QUFDaEY7QUFFQSxTQUFTLHdCQUF3QixTQUEwRDtBQUN6RixRQUFNLFdBQVcsQ0FBQyxHQUFHLGtCQUFrQixHQUFJLFNBQVMsbUJBQW1CLENBQUMsQ0FBRTtBQUMxRSxRQUFNLFdBQVcsU0FBUyxZQUFZO0FBQ3RDLFFBQU0sb0JBQW9CLFNBQVMscUJBQXFCO0FBQ3hELFNBQU87QUFBQSxJQUNMO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBLGlCQUFpQixLQUFLLFVBQVU7QUFBQSxNQUM5QjtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRixDQUFDO0FBQUEsRUFDSDtBQUNGO0FBRUEsU0FBUywyQkFDUCxPQUNBLFVBQ0EsV0FDUTtBQUNSLFNBQU8sV0FBVyxNQUFNLEVBQ3JCLE9BQU8sS0FBSyxVQUFVO0FBQUEsSUFDckI7QUFBQSxJQUNBO0FBQUEsSUFDQSxpQkFBaUIsU0FBUztBQUFBLEVBQzVCLENBQUMsQ0FBQyxFQUNELE9BQU8sS0FBSztBQUNqQjtBQUlBLFNBQVMsaUJBQ1AsT0FDQSxjQUNBLG1CQUNrQjtBQUNsQixRQUFNLFNBQVMsb0JBQUksSUFBeUI7QUFFNUMsYUFBVyxRQUFRLE9BQU87QUFDeEIsVUFBTSxNQUFNLFFBQVEsSUFBSTtBQUN4QixVQUFNLFNBQVMsUUFBUSxNQUFNLEtBQUs7QUFDbEMsUUFBSSxDQUFDLE9BQU8sSUFBSSxNQUFNLEdBQUc7QUFDdkIsYUFBTyxJQUFJLFFBQVEsQ0FBQyxDQUFDO0FBQUEsSUFDdkI7QUFDQSxXQUFPLElBQUksTUFBTSxFQUFHLEtBQUs7QUFBQSxNQUN2QixNQUFNO0FBQUEsTUFDTixhQUFhLGFBQWEsSUFBSSxJQUFJLEtBQUs7QUFBQSxJQUN6QyxDQUFDO0FBQUEsRUFDSDtBQUVBLFFBQU0sU0FBMkIsQ0FBQztBQUNsQyxRQUFNLGFBQWEsQ0FBQyxHQUFHLE9BQU8sS0FBSyxDQUFDLEVBQUUsS0FBSztBQUUzQyxhQUFXLE9BQU8sWUFBWTtBQUM1QixVQUFNLFdBQVcsT0FBTyxJQUFJLEdBQUc7QUFDL0IsYUFBUyxLQUFLLENBQUMsR0FBRyxNQUFNLEVBQUUsS0FBSyxjQUFjLEVBQUUsSUFBSSxDQUFDO0FBRXBELFdBQU8sS0FBSztBQUFBLE1BQ1YsTUFBTTtBQUFBLE1BQ04sT0FBTztBQUFBLE1BQ1AsV0FBVyxTQUFTLFNBQVM7QUFBQSxJQUMvQixDQUFDO0FBQUEsRUFDSDtBQUVBLFNBQU87QUFDVDtBQUlBLFNBQVMsa0JBQ1AsUUFDQSxZQUNBLFdBQ0EsVUFDUTtBQUNSLFFBQU0sUUFBa0IsQ0FBQztBQUN6QixRQUFNLFlBQVksT0FBTyxPQUFPLENBQUMsS0FBSyxNQUFNLE1BQU0sRUFBRSxNQUFNLE9BQU8sQ0FBQyxNQUFNLEVBQUUsV0FBVyxFQUFFLFFBQVEsQ0FBQztBQUVoRyxRQUFNLEtBQUssZ0JBQWdCO0FBQzNCLFFBQU0sS0FBSyxFQUFFO0FBQ2IsUUFBTSxLQUFLLGNBQWMsU0FBUyxXQUFXLGFBQWEsVUFBVSxpQkFBaUIsU0FBUyxJQUFJLFVBQVUsRUFBRTtBQUM5RyxRQUFNLEtBQUssR0FBRyx3QkFBd0IsR0FBRyxLQUFLLFVBQVUsUUFBUSxDQUFDLE1BQU07QUFDdkUsTUFBSSxXQUFXO0FBQ2IsVUFBTSxLQUFLLDRCQUE0QixVQUFVLHFEQUFxRDtBQUFBLEVBQ3hHO0FBQ0EsUUFBTSxLQUFLLEVBQUU7QUFFYixhQUFXLFNBQVMsUUFBUTtBQUMxQixVQUFNLFVBQVUsTUFBTSxRQUFRO0FBQzlCLFVBQU0sS0FBSyxPQUFPLE9BQU8sR0FBRztBQUU1QixRQUFJLE1BQU0sV0FBVztBQUVuQixZQUFNLGFBQWEsb0JBQUksSUFBb0I7QUFDM0MsaUJBQVcsS0FBSyxNQUFNLE9BQU87QUFDM0IsY0FBTSxNQUFNLFFBQVEsRUFBRSxJQUFJLEtBQUs7QUFDL0IsbUJBQVcsSUFBSSxNQUFNLFdBQVcsSUFBSSxHQUFHLEtBQUssS0FBSyxDQUFDO0FBQUEsTUFDcEQ7QUFDQSxZQUFNLGFBQWEsQ0FBQyxHQUFHLFdBQVcsUUFBUSxDQUFDLEVBQ3hDLEtBQUssQ0FBQyxHQUFHLE1BQU0sRUFBRSxDQUFDLElBQUksRUFBRSxDQUFDLENBQUMsRUFDMUIsSUFBSSxDQUFDLENBQUMsS0FBSyxLQUFLLE1BQU0sR0FBRyxLQUFLLElBQUksR0FBRyxFQUFFLEVBQ3ZDLEtBQUssSUFBSTtBQUNaLFlBQU0sS0FBSyxPQUFPLE1BQU0sTUFBTSxNQUFNLFdBQVcsVUFBVSxJQUFJO0FBSTdELFlBQU0sWUFBWSxNQUFNLE1BQ3JCLE9BQU8sQ0FBQyxNQUFNLEVBQUUsV0FBVyxFQUMzQixJQUFJLENBQUMsTUFBTSxPQUFPLEVBQUUsSUFBSSxhQUFRLEVBQUUsV0FBVyxFQUFFO0FBQ2xELFVBQUksVUFBVSxTQUFTLEdBQUc7QUFDeEIsY0FBTSxLQUFLLGlDQUFpQztBQUM1QyxjQUFNLEtBQUssR0FBRyxTQUFTO0FBQ3ZCLGNBQU0sS0FBSyxLQUFLO0FBQUEsTUFDbEI7QUFBQSxJQUNGLE9BQU87QUFDTCxpQkFBVyxRQUFRLE1BQU0sT0FBTztBQUM5QixZQUFJLEtBQUssYUFBYTtBQUNwQixnQkFBTSxLQUFLLE9BQU8sS0FBSyxJQUFJLGFBQVEsS0FBSyxXQUFXLEVBQUU7QUFBQSxRQUN2RCxPQUFPO0FBQ0wsZ0JBQU0sS0FBSyxPQUFPLEtBQUssSUFBSSxJQUFJO0FBQUEsUUFDakM7QUFBQSxNQUNGO0FBQUEsSUFDRjtBQUNBLFVBQU0sS0FBSyxFQUFFO0FBQUEsRUFDZjtBQUVBLFNBQU8sTUFBTSxLQUFLLElBQUk7QUFDeEI7QUFFQSxTQUFTLGlCQUNQLFVBQ0EsVUFDQSxzQkFDQSxZQVFBO0FBQ0EsUUFBTSxTQUFTLGNBQWMsZUFBZSxVQUFVLFNBQVMsVUFBVSxTQUFTLFFBQVE7QUFDMUYsUUFBTSxlQUFlLHdCQUF3QixvQkFBSSxJQUFvQjtBQUNyRSxRQUFNLFNBQVMsaUJBQWlCLE9BQU8sT0FBTyxjQUFjLFNBQVMsaUJBQWlCO0FBQ3RGLFFBQU0sZUFBYyxvQkFBSSxLQUFLLEdBQUUsWUFBWSxFQUFFLE1BQU0sR0FBRyxFQUFFLENBQUMsSUFBSTtBQUM3RCxRQUFNLFdBQWdDO0FBQUEsSUFDcEM7QUFBQSxJQUNBLGFBQWEsMkJBQTJCLE9BQU8sT0FBTyxVQUFVLE9BQU8sU0FBUztBQUFBLElBQ2hGLFdBQVcsT0FBTyxNQUFNO0FBQUEsSUFDeEIsV0FBVyxPQUFPO0FBQUEsRUFDcEI7QUFDQSxRQUFNLFVBQVUsa0JBQWtCLFFBQVEsT0FBTyxNQUFNLFFBQVEsT0FBTyxXQUFXLFFBQVE7QUFFekYsU0FBTztBQUFBLElBQ0w7QUFBQSxJQUNBLFdBQVcsT0FBTyxNQUFNO0FBQUEsSUFDeEIsV0FBVyxPQUFPO0FBQUEsSUFDbEIsT0FBTyxPQUFPO0FBQUEsSUFDZCxhQUFhLFNBQVM7QUFBQSxJQUN0QjtBQUFBLEVBQ0Y7QUFDRjtBQVFPLFNBQVMsb0JBQ2QsVUFDQSxTQUNBLHNCQUN1SDtBQUN2SCxRQUFNLFdBQVcsd0JBQXdCLE9BQU87QUFDaEQsU0FBTyxpQkFBaUIsVUFBVSxVQUFVLG9CQUFvQjtBQUNsRTtBQU1PLFNBQVMsa0JBQ2QsVUFDQSxTQVVBO0FBQ0EsUUFBTSxlQUFlLEtBQUssUUFBUSxRQUFRLEdBQUcsYUFBYTtBQUMxRCxRQUFNLFdBQVcsd0JBQXdCLE9BQU87QUFHaEQsTUFBSSx1QkFBdUIsb0JBQUksSUFBb0I7QUFDbkQsTUFBSSxXQUFXLFlBQVksR0FBRztBQUM1QixVQUFNLFdBQVcsYUFBYSxjQUFjLE9BQU87QUFDbkQsMkJBQXVCLGlCQUFpQixRQUFRO0FBQUEsRUFDbEQ7QUFFQSxRQUFNLGdCQUFnQixJQUFJLElBQUkscUJBQXFCLEtBQUssQ0FBQztBQUl6RCxRQUFNLFNBQVMsaUJBQWlCLFVBQVUsVUFBVSxvQkFBb0I7QUFDeEUsUUFBTSxhQUFhLElBQUksSUFBSSxPQUFPLEtBQUs7QUFHdkMsTUFBSSxRQUFRO0FBQ1osTUFBSSxVQUFVO0FBRWQsYUFBVyxLQUFLLE9BQU8sT0FBTztBQUM1QixRQUFJLENBQUMsY0FBYyxJQUFJLENBQUMsRUFBRztBQUFBLEVBQzdCO0FBQ0EsYUFBVyxLQUFLLGVBQWU7QUFDN0IsUUFBSSxDQUFDLFdBQVcsSUFBSSxDQUFDLEVBQUc7QUFBQSxFQUMxQjtBQUVBLFNBQU87QUFBQSxJQUNMLFNBQVMsT0FBTztBQUFBLElBQ2hCO0FBQUEsSUFDQTtBQUFBLElBQ0EsV0FBVyxPQUFPLE1BQU0sU0FBUztBQUFBLElBQ2pDLFdBQVcsT0FBTztBQUFBLElBQ2xCLFdBQVcsT0FBTztBQUFBLElBQ2xCLGFBQWEsT0FBTztBQUFBLElBQ3BCLGFBQWEsT0FBTztBQUFBLEVBQ3RCO0FBQ0Y7QUFFQSxTQUFTLG9CQUFvQixVQUF3QjtBQUNuRCxhQUFXLE9BQU8sZUFBZSxLQUFLLEdBQUc7QUFDdkMsUUFBSSxRQUFRLFlBQVksSUFBSSxXQUFXLEdBQUcsUUFBUSxJQUFJLEdBQUc7QUFDdkQscUJBQWUsT0FBTyxHQUFHO0FBQUEsSUFDM0I7QUFBQSxFQUNGO0FBQ0Y7QUFFTyxTQUFTLHVCQUNkLFVBQ0EsU0FDQSxlQUN5QjtBQUN6QixRQUFNLFdBQVcsd0JBQXdCLE9BQU87QUFDaEQsUUFBTSxXQUFXLEdBQUcsUUFBUSxLQUFLLFNBQVMsZUFBZTtBQUN6RCxRQUFNLFFBQVEsZUFBZSxTQUFTO0FBQ3RDLFFBQU0sV0FBVyxlQUFlLFlBQVk7QUFDNUMsUUFBTSxRQUFRLGVBQWUsVUFBVTtBQUN2QyxRQUFNLE1BQU0sS0FBSyxJQUFJO0FBRXJCLE1BQUksQ0FBQyxTQUFTLFFBQVEsR0FBRztBQUN2QixVQUFNLFNBQVMsZUFBZSxJQUFJLFFBQVE7QUFDMUMsUUFBSSxVQUFVLE1BQU0sT0FBTyxZQUFZLE9BQU87QUFDNUMsYUFBTyxPQUFPO0FBQUEsSUFDaEI7QUFBQSxFQUNGO0FBRUEsUUFBTSxXQUFXLGdCQUFnQixRQUFRO0FBQ3pDLFFBQU0sU0FBUyxlQUFlLFVBQVUsU0FBUyxVQUFVLFNBQVMsUUFBUTtBQUM1RSxRQUFNLGNBQWMsMkJBQTJCLE9BQU8sT0FBTyxVQUFVLE9BQU8sU0FBUztBQUV2RixRQUFNLGlCQUFpQixDQUFDLFdBQTZEO0FBQ25GLG1CQUFlLElBQUksVUFBVSxFQUFFLFdBQVcsS0FBSyxPQUFPLENBQUM7QUFDdkQsV0FBTztBQUFBLEVBQ1Q7QUFFQSxNQUFJLENBQUMsVUFBVTtBQUNiLFVBQU0sWUFBWSxpQkFBaUIsVUFBVSxVQUFVLFFBQVcsTUFBTTtBQUN4RSxRQUFJLFVBQVUsWUFBWSxHQUFHO0FBQzNCLHVCQUFpQixVQUFVLFVBQVUsT0FBTztBQUM1QyxhQUFPLGVBQWU7QUFBQSxRQUNwQixRQUFRO0FBQUEsUUFDUixXQUFXLFVBQVU7QUFBQSxRQUNyQixXQUFXLFVBQVU7QUFBQSxRQUNyQixhQUFhLFVBQVU7QUFBQSxRQUN2QixhQUFhLFVBQVU7QUFBQSxRQUN2QixRQUFRO0FBQUEsTUFDVixDQUFDO0FBQUEsSUFDSDtBQUNBLFdBQU8sZUFBZTtBQUFBLE1BQ3BCLFFBQVE7QUFBQSxNQUNSLFdBQVc7QUFBQSxNQUNYLFdBQVc7QUFBQSxNQUNYLGFBQWE7QUFBQSxNQUNiO0FBQUEsTUFDQSxRQUFRO0FBQUEsSUFDVixDQUFDO0FBQUEsRUFDSDtBQUVBLFFBQU0sV0FBVyx5QkFBeUIsUUFBUTtBQUNsRCxRQUFNLHVCQUF1QixpQkFBaUIsUUFBUTtBQUN0RCxRQUFNLFFBQVEsV0FBVyxNQUFNLEtBQUssTUFBTSxTQUFTLFdBQVcsSUFBSSxPQUFPO0FBQ3pFLFFBQU0sY0FDSixDQUFDLFdBQVcscUJBQ1YsU0FBUyxnQkFBZ0IsY0FBYyxrQkFDdkMsU0FBUyxjQUFjLE9BQU8sTUFBTSxTQUFTLHVCQUM3QyxTQUFTLGNBQWMsT0FBTyxZQUFZLHVCQUMxQyxXQUFXLEtBQUssT0FBTyxTQUFTLEtBQUssS0FBSyxRQUFRLFdBQVcsWUFDN0Q7QUFFSixNQUFJLENBQUMsYUFBYTtBQUNoQixXQUFPLGVBQWU7QUFBQSxNQUNwQixRQUFRO0FBQUEsTUFDUixXQUFXLFVBQVUsYUFBYSxPQUFPLE1BQU07QUFBQSxNQUMvQyxXQUFXLFVBQVUsYUFBYSxPQUFPO0FBQUEsTUFDekMsYUFBYSxVQUFVLGVBQWU7QUFBQSxNQUN0QyxhQUFhLFVBQVUsZUFBZTtBQUFBLElBQ3hDLENBQUM7QUFBQSxFQUNIO0FBRUEsUUFBTSxVQUFVLGlCQUFpQixVQUFVLFVBQVUsc0JBQXNCLE1BQU07QUFDakYsTUFBSSxRQUFRLFlBQVksR0FBRztBQUN6QixxQkFBaUIsVUFBVSxRQUFRLE9BQU87QUFDMUMsV0FBTyxlQUFlO0FBQUEsTUFDcEIsUUFBUTtBQUFBLE1BQ1IsV0FBVyxRQUFRO0FBQUEsTUFDbkIsV0FBVyxRQUFRO0FBQUEsTUFDbkIsYUFBYSxRQUFRO0FBQUEsTUFDckIsYUFBYSxRQUFRO0FBQUEsTUFDckIsUUFBUTtBQUFBLElBQ1YsQ0FBQztBQUFBLEVBQ0g7QUFFQSxTQUFPLGVBQWU7QUFBQSxJQUNwQixRQUFRO0FBQUEsSUFDUixXQUFXO0FBQUEsSUFDWCxXQUFXO0FBQUEsSUFDWCxhQUFhO0FBQUEsSUFDYjtBQUFBLElBQ0EsUUFBUTtBQUFBLEVBQ1YsQ0FBQztBQUNIO0FBS08sU0FBUyxpQkFBaUIsVUFBa0IsU0FBeUI7QUFDMUUsUUFBTSxPQUFPLFFBQVEsUUFBUTtBQUM3QixZQUFVLE1BQU0sRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNuQyxRQUFNLFVBQVUsS0FBSyxNQUFNLGFBQWE7QUFDeEMsZ0JBQWMsU0FBUyxTQUFTLE9BQU87QUFDdkMsc0JBQW9CLFFBQVE7QUFDNUIsU0FBTztBQUNUO0FBS08sU0FBUyxnQkFBZ0IsVUFBaUM7QUFDL0QsUUFBTSxlQUFlLEtBQUssUUFBUSxRQUFRLEdBQUcsYUFBYTtBQUMxRCxNQUFJLENBQUMsV0FBVyxZQUFZLEVBQUcsUUFBTztBQUN0QyxNQUFJO0FBQ0YsV0FBTyxhQUFhLGNBQWMsT0FBTztBQUFBLEVBQzNDLFFBQVE7QUFDTixXQUFPO0FBQUEsRUFDVDtBQUNGO0FBS08sU0FBUyxvQkFBb0IsVUFNbEM7QUFDQSxRQUFNLFVBQVUsZ0JBQWdCLFFBQVE7QUFDeEMsTUFBSSxDQUFDLFNBQVM7QUFDWixXQUFPLEVBQUUsUUFBUSxPQUFPLFdBQVcsR0FBRyxnQkFBZ0IsR0FBRyxrQkFBa0IsR0FBRyxhQUFhLEtBQUs7QUFBQSxFQUNsRztBQUdBLFFBQU0saUJBQWlCLFFBQVEsTUFBTSxnQkFBZ0I7QUFDckQsUUFBTSxhQUFhLGlCQUFpQixTQUFTLGVBQWUsQ0FBQyxHQUFHLEVBQUUsSUFBSTtBQUd0RSxRQUFNLGVBQWUsaUJBQWlCLE9BQU87QUFDN0MsUUFBTSxZQUFZLENBQUMsR0FBRyxhQUFhLE9BQU8sQ0FBQyxFQUFFLE9BQU8sQ0FBQyxNQUFNLEVBQUUsU0FBUyxDQUFDLEVBQUU7QUFDekUsUUFBTSxZQUFZLFFBQVEsTUFBTSxrQkFBa0I7QUFFbEQsU0FBTztBQUFBLElBQ0wsUUFBUTtBQUFBLElBQ1IsV0FBVztBQUFBLElBQ1gsZ0JBQWdCO0FBQUEsSUFDaEIsa0JBQWtCLGFBQWE7QUFBQSxJQUMvQixhQUFhLFlBQVksQ0FBQyxLQUFLO0FBQUEsRUFDakM7QUFDRjsiLAogICJuYW1lcyI6IFtdCn0K
