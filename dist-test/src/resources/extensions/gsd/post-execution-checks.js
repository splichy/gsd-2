import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
function stripStringLiterals(line) {
  let result = "";
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '"' || ch === "'") {
      result += ch;
      i++;
      while (i < line.length) {
        const c = line[i];
        if (c === "\\" && i + 1 < line.length) {
          result += "  ";
          i += 2;
        } else if (c === ch) {
          result += ch;
          i++;
          break;
        } else {
          result += " ";
          i++;
        }
      }
    } else {
      result += ch;
      i++;
    }
  }
  return result;
}
function extractRelativeImports(source) {
  const imports = [];
  const lines = source.split("\n");
  const importPattern = /(?:^|[;{}]\s*)import\s+(?:.*?\s+from\s+)?(['"])(\.\.?\/[^'"]+)\1/g;
  const requirePattern = /require\s*\(\s*(['"])(\.\.?\/[^'"]+)\1/g;
  let inBlockComment = false;
  let inTemplateLiteral = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inTemplateLiteral) {
      if ((line.match(/(?<!\\)`/g) ?? []).length % 2 === 1) {
        inTemplateLiteral = false;
      }
      continue;
    }
    if (inBlockComment) {
      if (line.includes("*/")) {
        inBlockComment = false;
      }
      continue;
    }
    const blockStart = line.indexOf("/*");
    const blockEnd = line.indexOf("*/");
    if (blockStart !== -1 && (blockEnd === -1 || blockEnd < blockStart)) {
      inBlockComment = true;
      continue;
    }
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//")) {
      continue;
    }
    if (trimmed.startsWith("*")) {
      continue;
    }
    let match;
    importPattern.lastIndex = 0;
    requirePattern.lastIndex = 0;
    const strippedLine = stripStringLiterals(line);
    while ((match = importPattern.exec(line)) !== null) {
      const importOffset = match[0].indexOf("import");
      const importStart = match.index + importOffset;
      if (strippedLine.slice(importStart, importStart + "import".length) !== "import") {
        continue;
      }
      const beforeMatch = strippedLine.substring(0, match.index);
      if (beforeMatch.includes("//")) {
        continue;
      }
      imports.push({
        importPath: match[2],
        lineNum: i + 1
      });
    }
    while ((match = requirePattern.exec(line)) !== null) {
      if (strippedLine.slice(match.index, match.index + "require".length) !== "require") {
        continue;
      }
      const beforeMatch = strippedLine.substring(0, match.index);
      if (beforeMatch.includes("//")) {
        continue;
      }
      imports.push({
        importPath: match[2],
        lineNum: i + 1
      });
    }
    if ((strippedLine.match(/(?<!\\)`/g) ?? []).length % 2 === 1) {
      inTemplateLiteral = true;
    }
  }
  return imports;
}
function resolveImportPath(importPath, sourceFile, basePath) {
  const sourceDir = dirname(resolve(basePath, sourceFile));
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
  const explicitExt = extname(importPath);
  if (explicitExt !== "") {
    const directPath = resolve(sourceDir, importPath);
    if (existsSync(directPath)) {
      return { exists: true, resolvedPath: directPath };
    }
    const nonFallbackExtensions = /* @__PURE__ */ new Set([
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
      ".json",
      ".css",
      ".scss",
      ".sass",
      ".less",
      ".styl",
      ".svg",
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".webp",
      ".avif",
      ".ico",
      ".bmp",
      ".woff",
      ".woff2",
      ".ttf",
      ".otf",
      ".eot"
    ]);
    const runtimeFallbackExtensions = /* @__PURE__ */ new Set([".js", ".jsx", ".mjs", ".cjs"]);
    const dottedStemFallbackExtensions = /* @__PURE__ */ new Set([".server", ".client", ".webhook"]);
    if (explicitExt !== "" && !runtimeFallbackExtensions.has(explicitExt) && !nonFallbackExtensions.has(explicitExt) && !dottedStemFallbackExtensions.has(explicitExt)) {
      return { exists: false, resolvedPath: null };
    }
    if (nonFallbackExtensions.has(explicitExt) && !runtimeFallbackExtensions.has(explicitExt)) {
      return { exists: false, resolvedPath: null };
    }
  }
  let normalizedPath = importPath;
  if (importPath.endsWith(".js")) {
    normalizedPath = importPath.slice(0, -3);
  } else if (importPath.endsWith(".jsx")) {
    normalizedPath = importPath.slice(0, -4);
  } else if (importPath.endsWith(".mjs")) {
    normalizedPath = importPath.slice(0, -4);
  } else if (importPath.endsWith(".cjs")) {
    normalizedPath = importPath.slice(0, -4);
  }
  for (const ext of extensions) {
    const fullPath = resolve(sourceDir, normalizedPath + ext);
    if (existsSync(fullPath)) {
      return { exists: true, resolvedPath: fullPath };
    }
  }
  for (const ext of extensions) {
    const indexPath = resolve(sourceDir, normalizedPath, `index${ext}`);
    if (existsSync(indexPath)) {
      return { exists: true, resolvedPath: indexPath };
    }
  }
  return { exists: false, resolvedPath: null };
}
function checkImportResolution(taskRow, _priorTasks, basePath) {
  const results = [];
  const filesToCheck = taskRow.key_files.filter((f) => {
    const ext = extname(f);
    return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext);
  });
  for (const file of filesToCheck) {
    const absolutePath = resolve(basePath, file);
    if (!existsSync(absolutePath)) {
      continue;
    }
    let source;
    try {
      source = readFileSync(absolutePath, "utf-8");
    } catch {
      continue;
    }
    const imports = extractRelativeImports(source);
    for (const { importPath, lineNum } of imports) {
      if (/^\.{1,2}\/\+types\//.test(importPath)) {
        continue;
      }
      const resolution = resolveImportPath(importPath, file, basePath);
      if (!resolution.exists) {
        results.push({
          category: "import",
          target: `${file}:${lineNum}`,
          passed: false,
          message: `Import '${importPath}' in ${file}:${lineNum} does not resolve to an existing file`,
          blocking: true
        });
      }
    }
  }
  return results;
}
function extractFunctionSignatures(source, fileName) {
  const signatures = [];
  const lines = source.split("\n");
  const funcPattern = /(?:export\s+)?(?:async\s+)?(?:function\s+|const\s+)(\w+)(?:\s*=\s*)?\s*\(([^)]*)\)(?:\s*:\s*([^{=>\n]+))?/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    funcPattern.lastIndex = 0;
    let match;
    while ((match = funcPattern.exec(line)) !== null) {
      const [, name, params, returnType] = match;
      signatures.push({
        name,
        params: normalizeParams(params),
        returnType: normalizeType(returnType || "void"),
        file: fileName,
        lineNum: i + 1
      });
    }
  }
  return signatures;
}
function normalizeParams(params) {
  return params.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").replace(/\s*=\s*[^,)]+/g, "").replace(/\s+/g, " ").trim();
}
function normalizeType(type) {
  return type.replace(/\s+/g, " ").trim();
}
function checkCrossTaskSignatures(taskRow, priorTasks, basePath) {
  const results = [];
  const priorSignatures = /* @__PURE__ */ new Map();
  for (const task of priorTasks) {
    for (const file of task.key_files) {
      const ext = extname(file);
      if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) continue;
      const absolutePath = resolve(basePath, file);
      if (!existsSync(absolutePath)) continue;
      try {
        const source = readFileSync(absolutePath, "utf-8");
        const sigs = extractFunctionSignatures(source, file);
        for (const sig of sigs) {
          const existing = priorSignatures.get(sig.name) || [];
          existing.push(sig);
          priorSignatures.set(sig.name, existing);
        }
      } catch {
      }
    }
  }
  for (const file of taskRow.key_files) {
    const ext = extname(file);
    if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) continue;
    const absolutePath = resolve(basePath, file);
    if (!existsSync(absolutePath)) continue;
    try {
      const source = readFileSync(absolutePath, "utf-8");
      const currentSigs = extractFunctionSignatures(source, file);
      for (const currentSig of currentSigs) {
        const priorDefs = priorSignatures.get(currentSig.name);
        if (priorDefs && priorDefs.length > 0) {
          const priorDef = priorDefs[0];
          if (currentSig.params !== priorDef.params) {
            results.push({
              category: "signature",
              target: currentSig.name,
              passed: false,
              message: `Function '${currentSig.name}' in ${file}:${currentSig.lineNum} has parameters '${currentSig.params}' but prior definition in ${priorDef.file}:${priorDef.lineNum} has '${priorDef.params}'`,
              blocking: false
              // Warn only — may be intentional override
            });
          }
          if (currentSig.returnType !== priorDef.returnType) {
            results.push({
              category: "signature",
              target: currentSig.name,
              passed: false,
              message: `Function '${currentSig.name}' in ${file}:${currentSig.lineNum} returns '${currentSig.returnType}' but prior definition in ${priorDef.file}:${priorDef.lineNum} returns '${priorDef.returnType}'`,
              blocking: false
              // Warn only — may be intentional override
            });
          }
        }
      }
    } catch {
    }
  }
  return results;
}
function checkPatternConsistency(taskRow, _priorTasks, basePath) {
  const results = [];
  for (const file of taskRow.key_files) {
    const ext = extname(file);
    if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) continue;
    const absolutePath = resolve(basePath, file);
    if (!existsSync(absolutePath)) continue;
    try {
      const source = readFileSync(absolutePath, "utf-8");
      const asyncStyleResult = checkAsyncStyleDrift(source, file);
      if (asyncStyleResult) {
        results.push(asyncStyleResult);
      }
      const namingResults = checkNamingConsistency(source, file);
      results.push(...namingResults);
    } catch {
    }
  }
  return results;
}
function checkAsyncStyleDrift(source, fileName) {
  const hasAsyncAwait = /\basync\b[\s\S]*?\bawait\b/.test(source);
  const hasThenChaining = /\.\s*then\s*\(/.test(source);
  if (hasAsyncAwait && hasThenChaining) {
    return {
      category: "pattern",
      target: fileName,
      passed: true,
      // Warning only
      message: `File ${fileName} mixes async/await with .then() promise chaining \u2014 consider using consistent async style`,
      blocking: false
    };
  }
  return null;
}
function checkNamingConsistency(source, fileName) {
  const results = [];
  const functionNames = [];
  const funcPattern = /(?:function\s+|const\s+|let\s+|var\s+)(\w+)(?:\s*=\s*(?:async\s*)?\(|\s*\()/g;
  let match;
  while ((match = funcPattern.exec(source)) !== null) {
    functionNames.push(match[1]);
  }
  const camelCaseFuncs = functionNames.filter((n) => /^[a-z][a-zA-Z0-9]*$/.test(n) && /[A-Z]/.test(n));
  const snakeCaseFuncs = functionNames.filter((n) => /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(n));
  if (camelCaseFuncs.length > 0 && snakeCaseFuncs.length > 0) {
    results.push({
      category: "pattern",
      target: fileName,
      passed: true,
      // Warning only
      message: `File ${fileName} mixes camelCase (${camelCaseFuncs.slice(0, 2).join(", ")}) and snake_case (${snakeCaseFuncs.slice(0, 2).join(", ")}) function names`,
      blocking: false
    });
  }
  return results;
}
function runPostExecutionChecks(taskRow, priorTasks, basePath) {
  const startTime = Date.now();
  const allChecks = [];
  const importChecks = checkImportResolution(taskRow, priorTasks, basePath);
  const signatureChecks = checkCrossTaskSignatures(taskRow, priorTasks, basePath);
  const patternChecks = checkPatternConsistency(taskRow, priorTasks, basePath);
  allChecks.push(...importChecks, ...signatureChecks, ...patternChecks);
  const durationMs = Date.now() - startTime;
  const hasBlockingFailure = allChecks.some((c) => !c.passed && c.blocking);
  const hasNonBlockingIssue = allChecks.some(
    (c) => !c.passed && !c.blocking || c.passed && c.category === "pattern"
  );
  let status;
  if (hasBlockingFailure) {
    status = "fail";
  } else if (hasNonBlockingIssue) {
    status = "warn";
  } else {
    status = "pass";
  }
  return {
    status,
    checks: allChecks,
    durationMs
  };
}
export {
  checkCrossTaskSignatures,
  checkImportResolution,
  checkPatternConsistency,
  extractRelativeImports,
  resolveImportPath,
  runPostExecutionChecks
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9wb3N0LWV4ZWN1dGlvbi1jaGVja3MudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFByb2plY3QvQXBwOiBHU0QtMlxuLy8gRmlsZSBQdXJwb3NlOiBQb3N0LWV4ZWN1dGlvbiB2YWxpZGF0aW9uIGNoZWNrcyBmb3IgY29tcGxldGVkIEdTRCB0YXNrIG91dHB1dC5cblxuLyoqXG4gKiBQb3N0LUV4ZWN1dGlvbiBDaGVja3MgXHUyMDE0IFZhbGlkYXRlIHRhc2sgb3V0cHV0IGFmdGVyIGV4ZWN1dGlvbiBjb21wbGV0ZXMuXG4gKlxuICogUnVucyB0aGVzZSBjaGVja3MgYWdhaW5zdCBhIGNvbXBsZXRlZCB0YXNrJ3Mgb3V0cHV0OlxuICogICAxLiBJbXBvcnQgcmVzb2x1dGlvbiBcdTIwMTQgdmVyaWZ5IHJlbGF0aXZlIGltcG9ydHMgaW4ga2V5X2ZpbGVzIHJlc29sdmUgdG8gZXhpc3RpbmcgZmlsZXNcbiAqICAgMi4gQ3Jvc3MtdGFzayBzaWduYXR1cmVzIFx1MjAxNCBkZXRlY3QgaGFsbHVjaW5hdGlvbiBjYXNjYWRlcyAoZnVuY3Rpb24gZXhpc3RzIGluIHRhc2sgb3V0cHV0XG4gKiAgICAgIGJ1dCBkb2Vzbid0IG1hdGNoIHByaW9yIHRhc2tzJyBhY3R1YWwgY29kZSlcbiAqICAgMy4gUGF0dGVybiBjb25zaXN0ZW5jeSBcdTIwMTQgd2FybiBvbiBhc3luYyBzdHlsZSBkcmlmdCwgbmFtaW5nIGNvbnZlbnRpb24gaW5jb25zaXN0ZW5jaWVzXG4gKlxuICogRGVzaWduIHByaW5jaXBsZXM6XG4gKiAgIC0gUHVyZSBmdW5jdGlvbnMgdGFraW5nICh0YXNrUm93LCBwcmlvclRhc2tzLCBiYXNlUGF0aCkgZm9yIHRlc3RhYmlsaXR5XG4gKiAgIC0gSW1wb3J0IGNoZWNrcyBhcmUgYmxvY2tpbmcgZmFpbHVyZXM7IHBhdHRlcm4gY2hlY2tzIGFyZSB3YXJuaW5nc1xuICogICAtIE5vIEFTVCBwYXJzZXJzIFx1MjAxNCB1c2VzIHJlZ2V4IGhldXJpc3RpY3NcbiAqL1xuXG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgcmVzb2x2ZSwgZGlybmFtZSwgam9pbiwgZXh0bmFtZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB0eXBlIHsgVGFza1JvdyB9IGZyb20gXCIuL2RiLXRhc2stc2xpY2Utcm93cy5qc1wiO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUmVzdWx0IFR5cGVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgaW50ZXJmYWNlIFBvc3RFeGVjdXRpb25DaGVja0pTT04ge1xuICAvKiogQ2hlY2sgY2F0ZWdvcnk6IGltcG9ydCwgc2lnbmF0dXJlLCBwYXR0ZXJuICovXG4gIGNhdGVnb3J5OiBcImltcG9ydFwiIHwgXCJzaWduYXR1cmVcIiB8IFwicGF0dGVyblwiO1xuICAvKiogV2hhdCB3YXMgY2hlY2tlZCAoZS5nLiwgZmlsZSBwYXRoLCBmdW5jdGlvbiBuYW1lKSAqL1xuICB0YXJnZXQ6IHN0cmluZztcbiAgLyoqIFdoZXRoZXIgdGhlIGNoZWNrIHBhc3NlZCAqL1xuICBwYXNzZWQ6IGJvb2xlYW47XG4gIC8qKiBIdW1hbi1yZWFkYWJsZSBtZXNzYWdlIGV4cGxhaW5pbmcgdGhlIHJlc3VsdCAqL1xuICBtZXNzYWdlOiBzdHJpbmc7XG4gIC8qKiBXaGV0aGVyIHRoaXMgZmFpbHVyZSBzaG91bGQgYmxvY2sgY29tcGxldGlvbiAob25seSBtZWFuaW5nZnVsIHdoZW4gcGFzc2VkPWZhbHNlKSAqL1xuICBibG9ja2luZz86IGJvb2xlYW47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUG9zdEV4ZWN1dGlvblJlc3VsdCB7XG4gIC8qKiBPdmVyYWxsIHJlc3VsdDogcGFzcyBpZiBubyBibG9ja2luZyBmYWlsdXJlcywgd2FybiBpZiBub24tYmxvY2tpbmcgaXNzdWVzLCBmYWlsIGlmIGJsb2NraW5nIGlzc3VlcyAqL1xuICBzdGF0dXM6IFwicGFzc1wiIHwgXCJ3YXJuXCIgfCBcImZhaWxcIjtcbiAgLyoqIEFsbCBjaGVjayByZXN1bHRzICovXG4gIGNoZWNrczogUG9zdEV4ZWN1dGlvbkNoZWNrSlNPTltdO1xuICAvKiogVG90YWwgZHVyYXRpb24gaW4gbWlsbGlzZWNvbmRzICovXG4gIGR1cmF0aW9uTXM6IG51bWJlcjtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEltcG9ydCBSZXNvbHV0aW9uIENoZWNrIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFJlcGxhY2UgdGhlIGNvbnRlbnRzIG9mIHNpbmdsZS0gYW5kIGRvdWJsZS1xdW90ZWQgc3RyaW5nIGxpdGVyYWxzIG9uIGEgc2luZ2xlXG4gKiBzb3VyY2UgbGluZSB3aXRoIHNwYWNlcyBzbyBpbXBvcnQgcGF0dGVybnMgZG8gbm90IG1hdGNoIHRleHQgaW5zaWRlIHN0cmluZ3MuXG4gKiBUZW1wbGF0ZS1saXRlcmFsIHNwYW5zIGFyZSBoYW5kbGVkIHNlcGFyYXRlbHkgdmlhIHRoZSBpblRlbXBsYXRlTGl0ZXJhbCBmbGFnLlxuICovXG5mdW5jdGlvbiBzdHJpcFN0cmluZ0xpdGVyYWxzKGxpbmU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGxldCByZXN1bHQgPSBcIlwiO1xuICBsZXQgaSA9IDA7XG5cbiAgd2hpbGUgKGkgPCBsaW5lLmxlbmd0aCkge1xuICAgIGNvbnN0IGNoID0gbGluZVtpXTtcblxuICAgIGlmIChjaCA9PT0gJ1wiJyB8fCBjaCA9PT0gXCInXCIpIHtcbiAgICAgIHJlc3VsdCArPSBjaDtcbiAgICAgIGkrKztcblxuICAgICAgd2hpbGUgKGkgPCBsaW5lLmxlbmd0aCkge1xuICAgICAgICBjb25zdCBjID0gbGluZVtpXTtcblxuICAgICAgICBpZiAoYyA9PT0gXCJcXFxcXCIgJiYgaSArIDEgPCBsaW5lLmxlbmd0aCkge1xuICAgICAgICAgIHJlc3VsdCArPSBcIiAgXCI7XG4gICAgICAgICAgaSArPSAyO1xuICAgICAgICB9IGVsc2UgaWYgKGMgPT09IGNoKSB7XG4gICAgICAgICAgcmVzdWx0ICs9IGNoO1xuICAgICAgICAgIGkrKztcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICByZXN1bHQgKz0gXCIgXCI7XG4gICAgICAgICAgaSsrO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHJlc3VsdCArPSBjaDtcbiAgICAgIGkrKztcbiAgICB9XG4gIH1cblxuICByZXR1cm4gcmVzdWx0O1xufVxuXG4vKipcbiAqIEV4dHJhY3QgcmVsYXRpdmUgaW1wb3J0IHBhdGhzIGZyb20gVHlwZVNjcmlwdC9KYXZhU2NyaXB0IHNvdXJjZSBjb2RlLlxuICogUmV0dXJucyBhcnJheSBvZiB7IGltcG9ydFBhdGgsIGxpbmVOdW0gfSBmb3IgcmVsYXRpdmUgaW1wb3J0cy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGV4dHJhY3RSZWxhdGl2ZUltcG9ydHMoXG4gIHNvdXJjZTogc3RyaW5nXG4pOiBBcnJheTx7IGltcG9ydFBhdGg6IHN0cmluZzsgbGluZU51bTogbnVtYmVyIH0+IHtcbiAgY29uc3QgaW1wb3J0czogQXJyYXk8eyBpbXBvcnRQYXRoOiBzdHJpbmc7IGxpbmVOdW06IG51bWJlciB9PiA9IFtdO1xuICBjb25zdCBsaW5lcyA9IHNvdXJjZS5zcGxpdChcIlxcblwiKTtcblxuICAvLyBNYXRjaDpcbiAgLy8gICBpbXBvcnQgLi4uIGZyb20gJy4vcGF0aCdcbiAgLy8gICBpbXBvcnQgLi4uIGZyb20gXCIuLi9wYXRoXCJcbiAgLy8gICBpbXBvcnQgJy4vcGF0aCdcbiAgLy8gICByZXF1aXJlKCcuL3BhdGgnKVxuICAvLyAgIHJlcXVpcmUoXCIuLi9wYXRoXCIpXG4gIGNvbnN0IGltcG9ydFBhdHRlcm4gPSAvKD86XnxbO3t9XVxccyopaW1wb3J0XFxzKyg/Oi4qP1xccytmcm9tXFxzKyk/KFsnXCJdKShcXC5cXC4/XFwvW14nXCJdKylcXDEvZztcbiAgY29uc3QgcmVxdWlyZVBhdHRlcm4gPSAvcmVxdWlyZVxccypcXChcXHMqKFsnXCJdKShcXC5cXC4/XFwvW14nXCJdKylcXDEvZztcblxuICAvLyBUcmFjayBpZiB3ZSdyZSBpbnNpZGUgYSBibG9jayBjb21tZW50XG4gIGxldCBpbkJsb2NrQ29tbWVudCA9IGZhbHNlO1xuICBsZXQgaW5UZW1wbGF0ZUxpdGVyYWwgPSBmYWxzZTtcblxuICBmb3IgKGxldCBpID0gMDsgaSA8IGxpbmVzLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgbGluZSA9IGxpbmVzW2ldO1xuXG4gICAgaWYgKGluVGVtcGxhdGVMaXRlcmFsKSB7XG4gICAgICBpZiAoKGxpbmUubWF0Y2goLyg/PCFcXFxcKWAvZykgPz8gW10pLmxlbmd0aCAlIDIgPT09IDEpIHtcbiAgICAgICAgaW5UZW1wbGF0ZUxpdGVyYWwgPSBmYWxzZTtcbiAgICAgIH1cbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIC8vIEhhbmRsZSBibG9jayBjb21tZW50IGJvdW5kYXJpZXNcbiAgICBpZiAoaW5CbG9ja0NvbW1lbnQpIHtcbiAgICAgIGlmIChsaW5lLmluY2x1ZGVzKFwiKi9cIikpIHtcbiAgICAgICAgaW5CbG9ja0NvbW1lbnQgPSBmYWxzZTtcbiAgICAgIH1cbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIC8vIENoZWNrIGZvciBibG9jayBjb21tZW50IHN0YXJ0ICh0aGF0IGRvZXNuJ3QgZW5kIG9uIHNhbWUgbGluZSlcbiAgICBjb25zdCBibG9ja1N0YXJ0ID0gbGluZS5pbmRleE9mKFwiLypcIik7XG4gICAgY29uc3QgYmxvY2tFbmQgPSBsaW5lLmluZGV4T2YoXCIqL1wiKTtcbiAgICBpZiAoYmxvY2tTdGFydCAhPT0gLTEgJiYgKGJsb2NrRW5kID09PSAtMSB8fCBibG9ja0VuZCA8IGJsb2NrU3RhcnQpKSB7XG4gICAgICBpbkJsb2NrQ29tbWVudCA9IHRydWU7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICAvLyBTa2lwIHNpbmdsZS1saW5lIGNvbW1lbnRzICgvLyBhdCBzdGFydCBvciBhZnRlciB3aGl0ZXNwYWNlKVxuICAgIGNvbnN0IHRyaW1tZWQgPSBsaW5lLnRyaW1TdGFydCgpO1xuICAgIGlmICh0cmltbWVkLnN0YXJ0c1dpdGgoXCIvL1wiKSkge1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgLy8gU2tpcCBKU0RvYy1zdHlsZSBsaW5lcyAoZS5nLiwgXCIgKiBpbXBvcnQgLi4uXCIpXG4gICAgaWYgKHRyaW1tZWQuc3RhcnRzV2l0aChcIipcIikpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGxldCBtYXRjaDogUmVnRXhwRXhlY0FycmF5IHwgbnVsbDtcblxuICAgIC8vIFJlc2V0IGxhc3RJbmRleCBmb3IgZWFjaCBsaW5lXG4gICAgaW1wb3J0UGF0dGVybi5sYXN0SW5kZXggPSAwO1xuICAgIHJlcXVpcmVQYXR0ZXJuLmxhc3RJbmRleCA9IDA7XG5cbiAgICBjb25zdCBzdHJpcHBlZExpbmUgPSBzdHJpcFN0cmluZ0xpdGVyYWxzKGxpbmUpO1xuXG4gICAgd2hpbGUgKChtYXRjaCA9IGltcG9ydFBhdHRlcm4uZXhlYyhsaW5lKSkgIT09IG51bGwpIHtcbiAgICAgIGNvbnN0IGltcG9ydE9mZnNldCA9IG1hdGNoWzBdLmluZGV4T2YoXCJpbXBvcnRcIik7XG4gICAgICBjb25zdCBpbXBvcnRTdGFydCA9IG1hdGNoLmluZGV4ICsgaW1wb3J0T2Zmc2V0O1xuICAgICAgaWYgKFxuICAgICAgICBzdHJpcHBlZExpbmUuc2xpY2UoaW1wb3J0U3RhcnQsIGltcG9ydFN0YXJ0ICsgXCJpbXBvcnRcIi5sZW5ndGgpICE9PVxuICAgICAgICBcImltcG9ydFwiXG4gICAgICApIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIC8vIENoZWNrIGlmIHRoaXMgbWF0Y2ggaXMgYWZ0ZXIgYSAvLyBjb21tZW50IG1hcmtlciBvbiB0aGUgc2FtZSBsaW5lXG4gICAgICBjb25zdCBiZWZvcmVNYXRjaCA9IHN0cmlwcGVkTGluZS5zdWJzdHJpbmcoMCwgbWF0Y2guaW5kZXgpO1xuICAgICAgaWYgKGJlZm9yZU1hdGNoLmluY2x1ZGVzKFwiLy9cIikpIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIGltcG9ydHMucHVzaCh7XG4gICAgICAgIGltcG9ydFBhdGg6IG1hdGNoWzJdLFxuICAgICAgICBsaW5lTnVtOiBpICsgMSxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIHdoaWxlICgobWF0Y2ggPSByZXF1aXJlUGF0dGVybi5leGVjKGxpbmUpKSAhPT0gbnVsbCkge1xuICAgICAgaWYgKFxuICAgICAgICBzdHJpcHBlZExpbmUuc2xpY2UobWF0Y2guaW5kZXgsIG1hdGNoLmluZGV4ICsgXCJyZXF1aXJlXCIubGVuZ3RoKSAhPT1cbiAgICAgICAgXCJyZXF1aXJlXCJcbiAgICAgICkge1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgLy8gQ2hlY2sgaWYgdGhpcyBtYXRjaCBpcyBhZnRlciBhIC8vIGNvbW1lbnQgbWFya2VyIG9uIHRoZSBzYW1lIGxpbmVcbiAgICAgIGNvbnN0IGJlZm9yZU1hdGNoID0gc3RyaXBwZWRMaW5lLnN1YnN0cmluZygwLCBtYXRjaC5pbmRleCk7XG4gICAgICBpZiAoYmVmb3JlTWF0Y2guaW5jbHVkZXMoXCIvL1wiKSkge1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgaW1wb3J0cy5wdXNoKHtcbiAgICAgICAgaW1wb3J0UGF0aDogbWF0Y2hbMl0sXG4gICAgICAgIGxpbmVOdW06IGkgKyAxLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgaWYgKChzdHJpcHBlZExpbmUubWF0Y2goLyg/PCFcXFxcKWAvZykgPz8gW10pLmxlbmd0aCAlIDIgPT09IDEpIHtcbiAgICAgIGluVGVtcGxhdGVMaXRlcmFsID0gdHJ1ZTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gaW1wb3J0cztcbn1cblxuLyoqXG4gKiBDaGVjayBpZiBhIHJlbGF0aXZlIGltcG9ydCByZXNvbHZlcyB0byBhbiBleGlzdGluZyBmaWxlLlxuICogUmVzb2x1dGlvbiBvcmRlcjpcbiAqICAgMS4gSW1wb3J0cyBjYXJyeWluZyBhbiBleHBsaWNpdCBleHRlbnNpb24gYXJlIGNoZWNrZWQgYXMtaXMgKGhhbmRsZXMgYXNzZXRzXG4gKiAgICAgIGxpa2UgLmNzcy8uc2Nzcy9pbWFnZXMvZm9udHMgYW5kIC5qc29uLCBub3QganVzdCBjb2RlIGV4dGVuc2lvbnMpLlxuICogICAyLiBUeXBlU2NyaXB0IEVTTSBjb252ZW50aW9uIHdoZXJlIC5qcyBpbXBvcnRzIHJlc29sdmUgdG8gLnRzIGZpbGVzLlxuICogICAzLiBFeHRlbnNpb25sZXNzIGltcG9ydHMgcmVzb2x2ZWQgYWdhaW5zdCAudHMvLnRzeC8uanMvLmpzeC8ubWpzLy5janMuXG4gKiAgIDQuIERpcmVjdG9yeSBpbXBvcnRzIHJlc29sdmVkIGFnYWluc3QgaW5kZXgue3RzLHRzeCxqcyxqc3gsbWpzLGNqc30uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlSW1wb3J0UGF0aChcbiAgaW1wb3J0UGF0aDogc3RyaW5nLFxuICBzb3VyY2VGaWxlOiBzdHJpbmcsXG4gIGJhc2VQYXRoOiBzdHJpbmdcbik6IHsgZXhpc3RzOiBib29sZWFuOyByZXNvbHZlZFBhdGg6IHN0cmluZyB8IG51bGwgfSB7XG4gIGNvbnN0IHNvdXJjZURpciA9IGRpcm5hbWUocmVzb2x2ZShiYXNlUGF0aCwgc291cmNlRmlsZSkpO1xuICBjb25zdCBleHRlbnNpb25zID0gW1wiLnRzXCIsIFwiLnRzeFwiLCBcIi5qc1wiLCBcIi5qc3hcIiwgXCIubWpzXCIsIFwiLmNqc1wiXTtcblxuICAvLyBJZiB0aGUgaW1wb3J0IGFscmVhZHkgaGFzIGFuIGV4cGxpY2l0IGV4dGVuc2lvbiwgY2hlY2sgaXQgYXMtaXMgZmlyc3QuXG4gIC8vIFRoaXMgY29ycmVjdGx5IHJlc29sdmVzIGFzc2V0IGltcG9ydHMgbGlrZSAuY3NzLCAuc2NzcywgaW1hZ2VzLCBmb250c1xuICAvLyB3aXRob3V0IHJlcXVpcmluZyBlYWNoIGV4dGVuc2lvbiB0byBiZSBlbnVtZXJhdGVkIChpc3N1ZSAjNDQxMSkuIFdlIG9ubHlcbiAgLy8gZG8gdGhpcyB3aGVuIHRoZSBpbXBvcnQgY2FycmllcyBhbiBleHRlbnNpb24gc28gdGhhdCBleHRlbnNpb25sZXNzIG1vZHVsZVxuICAvLyBpbXBvcnRzIHN0aWxsIGZsb3cgdGhyb3VnaCB0aGUgVFMgRVNNIGNvbnZlbnRpb24gYW5kIGluZGV4LWZpbGUgcmVzb2x2ZXJzLlxuICBjb25zdCBleHBsaWNpdEV4dCA9IGV4dG5hbWUoaW1wb3J0UGF0aCk7XG4gIGlmIChleHBsaWNpdEV4dCAhPT0gXCJcIikge1xuICAgIGNvbnN0IGRpcmVjdFBhdGggPSByZXNvbHZlKHNvdXJjZURpciwgaW1wb3J0UGF0aCk7XG4gICAgaWYgKGV4aXN0c1N5bmMoZGlyZWN0UGF0aCkpIHtcbiAgICAgIHJldHVybiB7IGV4aXN0czogdHJ1ZSwgcmVzb2x2ZWRQYXRoOiBkaXJlY3RQYXRoIH07XG4gICAgfVxuXG4gICAgLy8gS25vd24gY29uY3JldGUgZXh0ZW5zaW9ucyB0aGF0IHNob3VsZCBOT1QgZmFsbCB0aHJvdWdoIHRvIGNvZGUtc2hhZG93XG4gICAgLy8gcHJvYmluZyB3aGVuIG1pc3NpbmcuIFRoaXMgcHJlc2VydmVzIHRoZSBcIm1pc3NpbmcuY3NzIG11c3Qgc3RheSBtaXNzaW5nXCJcbiAgICAvLyBndWFyYW50ZWUgd2hpbGUgc3RpbGwgYWxsb3dpbmcgZG90dGVkIG1vZHVsZSBzdGVtcyBsaWtlIC4vcm91dGUuc2VydmVyXG4gICAgLy8gdG8gcmVzb2x2ZSBhcyAuL3JvdXRlLnNlcnZlci50cy5cbiAgICBjb25zdCBub25GYWxsYmFja0V4dGVuc2lvbnMgPSBuZXcgU2V0KFtcbiAgICAgIFwiLnRzXCIsIFwiLnRzeFwiLCBcIi5qc1wiLCBcIi5qc3hcIiwgXCIubWpzXCIsIFwiLmNqc1wiLFxuICAgICAgXCIuanNvblwiLCBcIi5jc3NcIiwgXCIuc2Nzc1wiLCBcIi5zYXNzXCIsIFwiLmxlc3NcIiwgXCIuc3R5bFwiLFxuICAgICAgXCIuc3ZnXCIsIFwiLnBuZ1wiLCBcIi5qcGdcIiwgXCIuanBlZ1wiLCBcIi5naWZcIiwgXCIud2VicFwiLCBcIi5hdmlmXCIsIFwiLmljb1wiLCBcIi5ibXBcIixcbiAgICAgIFwiLndvZmZcIiwgXCIud29mZjJcIiwgXCIudHRmXCIsIFwiLm90ZlwiLCBcIi5lb3RcIixcbiAgICBdKTtcbiAgICBjb25zdCBydW50aW1lRmFsbGJhY2tFeHRlbnNpb25zID0gbmV3IFNldChbXCIuanNcIiwgXCIuanN4XCIsIFwiLm1qc1wiLCBcIi5janNcIl0pO1xuICAgIGNvbnN0IGRvdHRlZFN0ZW1GYWxsYmFja0V4dGVuc2lvbnMgPSBuZXcgU2V0KFtcIi5zZXJ2ZXJcIiwgXCIuY2xpZW50XCIsIFwiLndlYmhvb2tcIl0pO1xuXG4gICAgaWYgKFxuICAgICAgZXhwbGljaXRFeHQgIT09IFwiXCIgJiZcbiAgICAgICFydW50aW1lRmFsbGJhY2tFeHRlbnNpb25zLmhhcyhleHBsaWNpdEV4dCkgJiZcbiAgICAgICFub25GYWxsYmFja0V4dGVuc2lvbnMuaGFzKGV4cGxpY2l0RXh0KSAmJlxuICAgICAgIWRvdHRlZFN0ZW1GYWxsYmFja0V4dGVuc2lvbnMuaGFzKGV4cGxpY2l0RXh0KVxuICAgICkge1xuICAgICAgcmV0dXJuIHsgZXhpc3RzOiBmYWxzZSwgcmVzb2x2ZWRQYXRoOiBudWxsIH07XG4gICAgfVxuXG4gICAgaWYgKG5vbkZhbGxiYWNrRXh0ZW5zaW9ucy5oYXMoZXhwbGljaXRFeHQpICYmICFydW50aW1lRmFsbGJhY2tFeHRlbnNpb25zLmhhcyhleHBsaWNpdEV4dCkpIHtcbiAgICAgIHJldHVybiB7IGV4aXN0czogZmFsc2UsIHJlc29sdmVkUGF0aDogbnVsbCB9O1xuICAgIH1cbiAgfVxuXG4gIC8vIEhhbmRsZSBUeXBlU2NyaXB0IEVTTSBjb252ZW50aW9uOiAuanMgaW1wb3J0cyByZXNvbHZlIHRvIC50cyBmaWxlc1xuICAvLyBlLmcuLCBpbXBvcnQgJy4vdHlwZXMuanMnIC0+IC4vdHlwZXMudHNcbiAgbGV0IG5vcm1hbGl6ZWRQYXRoID0gaW1wb3J0UGF0aDtcbiAgaWYgKGltcG9ydFBhdGguZW5kc1dpdGgoXCIuanNcIikpIHtcbiAgICBub3JtYWxpemVkUGF0aCA9IGltcG9ydFBhdGguc2xpY2UoMCwgLTMpO1xuICB9IGVsc2UgaWYgKGltcG9ydFBhdGguZW5kc1dpdGgoXCIuanN4XCIpKSB7XG4gICAgbm9ybWFsaXplZFBhdGggPSBpbXBvcnRQYXRoLnNsaWNlKDAsIC00KTtcbiAgfSBlbHNlIGlmIChpbXBvcnRQYXRoLmVuZHNXaXRoKFwiLm1qc1wiKSkge1xuICAgIG5vcm1hbGl6ZWRQYXRoID0gaW1wb3J0UGF0aC5zbGljZSgwLCAtNCk7XG4gIH0gZWxzZSBpZiAoaW1wb3J0UGF0aC5lbmRzV2l0aChcIi5janNcIikpIHtcbiAgICBub3JtYWxpemVkUGF0aCA9IGltcG9ydFBhdGguc2xpY2UoMCwgLTQpO1xuICB9XG5cbiAgLy8gVHJ5IHRoZSBub3JtYWxpemVkIHBhdGggd2l0aCBjb21tb24gZXh0ZW5zaW9uc1xuICBmb3IgKGNvbnN0IGV4dCBvZiBleHRlbnNpb25zKSB7XG4gICAgY29uc3QgZnVsbFBhdGggPSByZXNvbHZlKHNvdXJjZURpciwgbm9ybWFsaXplZFBhdGggKyBleHQpO1xuICAgIGlmIChleGlzdHNTeW5jKGZ1bGxQYXRoKSkge1xuICAgICAgcmV0dXJuIHsgZXhpc3RzOiB0cnVlLCByZXNvbHZlZFBhdGg6IGZ1bGxQYXRoIH07XG4gICAgfVxuICB9XG5cbiAgLy8gVHJ5IGFzIGEgZGlyZWN0b3J5IHdpdGggaW5kZXggZmlsZVxuICBmb3IgKGNvbnN0IGV4dCBvZiBleHRlbnNpb25zKSB7XG4gICAgY29uc3QgaW5kZXhQYXRoID0gcmVzb2x2ZShzb3VyY2VEaXIsIG5vcm1hbGl6ZWRQYXRoLCBgaW5kZXgke2V4dH1gKTtcbiAgICBpZiAoZXhpc3RzU3luYyhpbmRleFBhdGgpKSB7XG4gICAgICByZXR1cm4geyBleGlzdHM6IHRydWUsIHJlc29sdmVkUGF0aDogaW5kZXhQYXRoIH07XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHsgZXhpc3RzOiBmYWxzZSwgcmVzb2x2ZWRQYXRoOiBudWxsIH07XG59XG5cbi8qKlxuICogQ2hlY2sgdGhhdCBhbGwgcmVsYXRpdmUgaW1wb3J0cyBpbiB0aGUgdGFzaydzIGtleV9maWxlcyByZXNvbHZlIHRvIGV4aXN0aW5nIGZpbGVzLlxuICogUmVhZHMgbW9kaWZpZWQgZmlsZXMgZnJvbSB0YXNrLmtleV9maWxlcywgZXh0cmFjdHMgaW1wb3J0IHN0YXRlbWVudHMgdmlhIHJlZ2V4LFxuICogdmVyaWZpZXMgcmVsYXRpdmUgaW1wb3J0cyByZXNvbHZlIHRvIGV4aXN0aW5nIGZpbGVzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY2hlY2tJbXBvcnRSZXNvbHV0aW9uKFxuICB0YXNrUm93OiBUYXNrUm93LFxuICBfcHJpb3JUYXNrczogVGFza1Jvd1tdLFxuICBiYXNlUGF0aDogc3RyaW5nXG4pOiBQb3N0RXhlY3V0aW9uQ2hlY2tKU09OW10ge1xuICBjb25zdCByZXN1bHRzOiBQb3N0RXhlY3V0aW9uQ2hlY2tKU09OW10gPSBbXTtcblxuICAvLyBHZXQgZmlsZXMgZnJvbSBrZXlfZmlsZXNcbiAgY29uc3QgZmlsZXNUb0NoZWNrID0gdGFza1Jvdy5rZXlfZmlsZXMuZmlsdGVyKChmKSA9PiB7XG4gICAgY29uc3QgZXh0ID0gZXh0bmFtZShmKTtcbiAgICByZXR1cm4gW1wiLnRzXCIsIFwiLnRzeFwiLCBcIi5qc1wiLCBcIi5qc3hcIiwgXCIubWpzXCIsIFwiLmNqc1wiXS5pbmNsdWRlcyhleHQpO1xuICB9KTtcblxuICBmb3IgKGNvbnN0IGZpbGUgb2YgZmlsZXNUb0NoZWNrKSB7XG4gICAgY29uc3QgYWJzb2x1dGVQYXRoID0gcmVzb2x2ZShiYXNlUGF0aCwgZmlsZSk7XG5cbiAgICAvLyBTa2lwIGlmIGZpbGUgZG9lc24ndCBleGlzdCAobWlnaHQgaGF2ZSBiZWVuIGRlbGV0ZWQgb3IgcmVuYW1lZClcbiAgICBpZiAoIWV4aXN0c1N5bmMoYWJzb2x1dGVQYXRoKSkge1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgbGV0IHNvdXJjZTogc3RyaW5nO1xuICAgIHRyeSB7XG4gICAgICBzb3VyY2UgPSByZWFkRmlsZVN5bmMoYWJzb2x1dGVQYXRoLCBcInV0Zi04XCIpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgY29uc3QgaW1wb3J0cyA9IGV4dHJhY3RSZWxhdGl2ZUltcG9ydHMoc291cmNlKTtcblxuICAgIGZvciAoY29uc3QgeyBpbXBvcnRQYXRoLCBsaW5lTnVtIH0gb2YgaW1wb3J0cykge1xuICAgICAgLy8gUmVhY3QgUm91dGVyIGdlbmVyYXRlZCArdHlwZXMgbW9kdWxlcyBtYXkgbm90IGV4aXN0IG9uIGRpc2sgZHVyaW5nXG4gICAgICAvLyBwb3N0LWV4ZWMgY2hlY2tzIChnZW5lcmF0ZWQgZHVyaW5nIGZyYW1ld29yayBidWlsZCkuIERvbid0IGJsb2NrIHRhc2tcbiAgICAgIC8vIGNvbXBsZXRpb24gb24gdGhlc2UgaW1wb3J0cy5cbiAgICAgIGlmICgvXlxcLnsxLDJ9XFwvXFwrdHlwZXNcXC8vLnRlc3QoaW1wb3J0UGF0aCkpIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHJlc29sdXRpb24gPSByZXNvbHZlSW1wb3J0UGF0aChpbXBvcnRQYXRoLCBmaWxlLCBiYXNlUGF0aCk7XG5cbiAgICAgIGlmICghcmVzb2x1dGlvbi5leGlzdHMpIHtcbiAgICAgICAgcmVzdWx0cy5wdXNoKHtcbiAgICAgICAgICBjYXRlZ29yeTogXCJpbXBvcnRcIixcbiAgICAgICAgICB0YXJnZXQ6IGAke2ZpbGV9OiR7bGluZU51bX1gLFxuICAgICAgICAgIHBhc3NlZDogZmFsc2UsXG4gICAgICAgICAgbWVzc2FnZTogYEltcG9ydCAnJHtpbXBvcnRQYXRofScgaW4gJHtmaWxlfToke2xpbmVOdW19IGRvZXMgbm90IHJlc29sdmUgdG8gYW4gZXhpc3RpbmcgZmlsZWAsXG4gICAgICAgICAgYmxvY2tpbmc6IHRydWUsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiByZXN1bHRzO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQ3Jvc3MtVGFzayBTaWduYXR1cmUgQ2hlY2sgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogTm9ybWFsaXplZCBmdW5jdGlvbiBzaWduYXR1cmUgZXh0cmFjdGVkIGZyb20gYSBzb3VyY2UgZmlsZS5cbiAqIFVzZWQgdG8gY29tcGFyZSBkZWZpbml0aW9ucyBhY3Jvc3MgdGFza3MgYW5kIGRldGVjdCBzaWduYXR1cmUgZHJpZnQuXG4gKi9cbmludGVyZmFjZSBGdW5jdGlvblNpZ25hdHVyZSB7XG4gIC8qKiBGdW5jdGlvbiBvciBleHBvcnRlZCBjb25zdCBuYW1lLiAqL1xuICBuYW1lOiBzdHJpbmc7XG4gIC8qKiBQYXJhbWV0ZXIgbGlzdCB3aXRoIGRlZmF1bHRzIGFuZCBjb21tZW50cyBzdHJpcHBlZC4gKi9cbiAgcGFyYW1zOiBzdHJpbmc7XG4gIC8qKiBEZWNsYXJlZCByZXR1cm4gdHlwZSwgb3IgXCJ2b2lkXCIgd2hlbiBub25lIGlzIGFubm90YXRlZC4gKi9cbiAgcmV0dXJuVHlwZTogc3RyaW5nO1xuICAvKiogU291cmNlIGZpbGUgdGhlIHNpZ25hdHVyZSB3YXMgZXh0cmFjdGVkIGZyb20uICovXG4gIGZpbGU6IHN0cmluZztcbiAgLyoqIDEtYmFzZWQgbGluZSBudW1iZXIgb2YgdGhlIGRlY2xhcmF0aW9uLiAqL1xuICBsaW5lTnVtOiBudW1iZXI7XG59XG5cbi8qKlxuICogRXh0cmFjdCBmdW5jdGlvbiBzaWduYXR1cmVzIGZyb20gVHlwZVNjcmlwdC9KYXZhU2NyaXB0IHNvdXJjZSBjb2RlLlxuICovXG5mdW5jdGlvbiBleHRyYWN0RnVuY3Rpb25TaWduYXR1cmVzKFxuICBzb3VyY2U6IHN0cmluZyxcbiAgZmlsZU5hbWU6IHN0cmluZ1xuKTogRnVuY3Rpb25TaWduYXR1cmVbXSB7XG4gIGNvbnN0IHNpZ25hdHVyZXM6IEZ1bmN0aW9uU2lnbmF0dXJlW10gPSBbXTtcbiAgY29uc3QgbGluZXMgPSBzb3VyY2Uuc3BsaXQoXCJcXG5cIik7XG5cbiAgLy8gTWF0Y2ggZnVuY3Rpb24gZGVjbGFyYXRpb25zIGFuZCBleHBvcnRzXG4gIC8vIFBhdHRlcm5zOlxuICAvLyAgIGZ1bmN0aW9uIG5hbWUocGFyYW1zKTogUmV0dXJuVHlwZVxuICAvLyAgIGV4cG9ydCBmdW5jdGlvbiBuYW1lKHBhcmFtcyk6IFJldHVyblR5cGVcbiAgLy8gICBleHBvcnQgYXN5bmMgZnVuY3Rpb24gbmFtZShwYXJhbXMpOiBQcm9taXNlPFJldHVyblR5cGU+XG4gIC8vICAgY29uc3QgbmFtZSA9IChwYXJhbXMpOiBSZXR1cm5UeXBlID0+XG4gIC8vICAgZXhwb3J0IGNvbnN0IG5hbWUgPSAocGFyYW1zKTogUmV0dXJuVHlwZSA9PlxuICBjb25zdCBmdW5jUGF0dGVybiA9XG4gICAgLyg/OmV4cG9ydFxccyspPyg/OmFzeW5jXFxzKyk/KD86ZnVuY3Rpb25cXHMrfGNvbnN0XFxzKykoXFx3KykoPzpcXHMqPVxccyopP1xccypcXCgoW14pXSopXFwpKD86XFxzKjpcXHMqKFteez0+XFxuXSspKT8vZztcblxuICBmb3IgKGxldCBpID0gMDsgaSA8IGxpbmVzLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgbGluZSA9IGxpbmVzW2ldO1xuICAgIGZ1bmNQYXR0ZXJuLmxhc3RJbmRleCA9IDA7XG5cbiAgICBsZXQgbWF0Y2g6IFJlZ0V4cEV4ZWNBcnJheSB8IG51bGw7XG4gICAgd2hpbGUgKChtYXRjaCA9IGZ1bmNQYXR0ZXJuLmV4ZWMobGluZSkpICE9PSBudWxsKSB7XG4gICAgICBjb25zdCBbLCBuYW1lLCBwYXJhbXMsIHJldHVyblR5cGVdID0gbWF0Y2g7XG4gICAgICBzaWduYXR1cmVzLnB1c2goe1xuICAgICAgICBuYW1lLFxuICAgICAgICBwYXJhbXM6IG5vcm1hbGl6ZVBhcmFtcyhwYXJhbXMpLFxuICAgICAgICByZXR1cm5UeXBlOiBub3JtYWxpemVUeXBlKHJldHVyblR5cGUgfHwgXCJ2b2lkXCIpLFxuICAgICAgICBmaWxlOiBmaWxlTmFtZSxcbiAgICAgICAgbGluZU51bTogaSArIDEsXG4gICAgICB9KTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gc2lnbmF0dXJlcztcbn1cblxuLyoqXG4gKiBOb3JtYWxpemUgcGFyYW1ldGVyIGxpc3QgZm9yIGNvbXBhcmlzb24uXG4gKi9cbmZ1bmN0aW9uIG5vcm1hbGl6ZVBhcmFtcyhwYXJhbXM6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBwYXJhbXNcbiAgICAucmVwbGFjZSgvXFwvXFwqW1xcc1xcU10qP1xcKlxcLy9nLCBcIlwiKSAvLyBSZW1vdmUgYmxvY2sgY29tbWVudHNcbiAgICAucmVwbGFjZSgvXFwvXFwvW15cXG5dKi9nLCBcIlwiKSAvLyBSZW1vdmUgbGluZSBjb21tZW50c1xuICAgIC5yZXBsYWNlKC9cXHMqPVxccypbXiwpXSsvZywgXCJcIikgLy8gUmVtb3ZlIGRlZmF1bHQgdmFsdWVzXG4gICAgLnJlcGxhY2UoL1xccysvZywgXCIgXCIpIC8vIE5vcm1hbGl6ZSB3aGl0ZXNwYWNlXG4gICAgLnRyaW0oKTtcbn1cblxuLyoqXG4gKiBOb3JtYWxpemUgdHlwZSBmb3IgY29tcGFyaXNvbi5cbiAqL1xuZnVuY3Rpb24gbm9ybWFsaXplVHlwZSh0eXBlOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdHlwZS5yZXBsYWNlKC9cXHMrL2csIFwiIFwiKS50cmltKCk7XG59XG5cbi8qKlxuICogQ29tcGFyZSBmdW5jdGlvbiBzaWduYXR1cmVzIGluIGN1cnJlbnQgdGFzaydzIG91dHB1dCBhZ2FpbnN0IHByaW9yIHRhc2tzJyBrZXlfZmlsZXNcbiAqIHRvIGNhdGNoIGhhbGx1Y2luYXRpb24gY2FzY2FkZXMgXHUyMDE0IHdoZW4gYSB0YXNrIHJlZmVyZW5jZXMgZnVuY3Rpb25zIHRoYXQgZG9uJ3QgZXhpc3RcbiAqIG9yIGhhdmUgZGlmZmVyZW50IHNpZ25hdHVyZXMgdGhhbiB3aGF0IHdhcyBhY3R1YWxseSBjcmVhdGVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY2hlY2tDcm9zc1Rhc2tTaWduYXR1cmVzKFxuICB0YXNrUm93OiBUYXNrUm93LFxuICBwcmlvclRhc2tzOiBUYXNrUm93W10sXG4gIGJhc2VQYXRoOiBzdHJpbmdcbik6IFBvc3RFeGVjdXRpb25DaGVja0pTT05bXSB7XG4gIGNvbnN0IHJlc3VsdHM6IFBvc3RFeGVjdXRpb25DaGVja0pTT05bXSA9IFtdO1xuXG4gIC8vIEJ1aWxkIG1hcCBvZiBmdW5jdGlvbnMgZnJvbSBwcmlvciB0YXNrcycga2V5X2ZpbGVzXG4gIGNvbnN0IHByaW9yU2lnbmF0dXJlcyA9IG5ldyBNYXA8c3RyaW5nLCBGdW5jdGlvblNpZ25hdHVyZVtdPigpO1xuXG4gIGZvciAoY29uc3QgdGFzayBvZiBwcmlvclRhc2tzKSB7XG4gICAgZm9yIChjb25zdCBmaWxlIG9mIHRhc2sua2V5X2ZpbGVzKSB7XG4gICAgICBjb25zdCBleHQgPSBleHRuYW1lKGZpbGUpO1xuICAgICAgaWYgKCFbXCIudHNcIiwgXCIudHN4XCIsIFwiLmpzXCIsIFwiLmpzeFwiLCBcIi5tanNcIiwgXCIuY2pzXCJdLmluY2x1ZGVzKGV4dCkpIGNvbnRpbnVlO1xuXG4gICAgICBjb25zdCBhYnNvbHV0ZVBhdGggPSByZXNvbHZlKGJhc2VQYXRoLCBmaWxlKTtcbiAgICAgIGlmICghZXhpc3RzU3luYyhhYnNvbHV0ZVBhdGgpKSBjb250aW51ZTtcblxuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3Qgc291cmNlID0gcmVhZEZpbGVTeW5jKGFic29sdXRlUGF0aCwgXCJ1dGYtOFwiKTtcbiAgICAgICAgY29uc3Qgc2lncyA9IGV4dHJhY3RGdW5jdGlvblNpZ25hdHVyZXMoc291cmNlLCBmaWxlKTtcbiAgICAgICAgZm9yIChjb25zdCBzaWcgb2Ygc2lncykge1xuICAgICAgICAgIGNvbnN0IGV4aXN0aW5nID0gcHJpb3JTaWduYXR1cmVzLmdldChzaWcubmFtZSkgfHwgW107XG4gICAgICAgICAgZXhpc3RpbmcucHVzaChzaWcpO1xuICAgICAgICAgIHByaW9yU2lnbmF0dXJlcy5zZXQoc2lnLm5hbWUsIGV4aXN0aW5nKTtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIFNraXAgdW5yZWFkYWJsZSBmaWxlc1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8vIEV4dHJhY3QgZnVuY3Rpb24gY2FsbHMvcmVmZXJlbmNlcyBmcm9tIGN1cnJlbnQgdGFzaydzIGtleV9maWxlc1xuICAvLyBhbmQgY2hlY2sgdGhleSBtYXRjaCBwcmlvciBkZWZpbml0aW9uc1xuICBmb3IgKGNvbnN0IGZpbGUgb2YgdGFza1Jvdy5rZXlfZmlsZXMpIHtcbiAgICBjb25zdCBleHQgPSBleHRuYW1lKGZpbGUpO1xuICAgIGlmICghW1wiLnRzXCIsIFwiLnRzeFwiLCBcIi5qc1wiLCBcIi5qc3hcIiwgXCIubWpzXCIsIFwiLmNqc1wiXS5pbmNsdWRlcyhleHQpKSBjb250aW51ZTtcblxuICAgIGNvbnN0IGFic29sdXRlUGF0aCA9IHJlc29sdmUoYmFzZVBhdGgsIGZpbGUpO1xuICAgIGlmICghZXhpc3RzU3luYyhhYnNvbHV0ZVBhdGgpKSBjb250aW51ZTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCBzb3VyY2UgPSByZWFkRmlsZVN5bmMoYWJzb2x1dGVQYXRoLCBcInV0Zi04XCIpO1xuICAgICAgY29uc3QgY3VycmVudFNpZ3MgPSBleHRyYWN0RnVuY3Rpb25TaWduYXR1cmVzKHNvdXJjZSwgZmlsZSk7XG5cbiAgICAgIC8vIENoZWNrIGVhY2ggZnVuY3Rpb24gaW4gY3VycmVudCB0YXNrIGFnYWluc3QgcHJpb3IgZGVmaW5pdGlvbnNcbiAgICAgIGZvciAoY29uc3QgY3VycmVudFNpZyBvZiBjdXJyZW50U2lncykge1xuICAgICAgICBjb25zdCBwcmlvckRlZnMgPSBwcmlvclNpZ25hdHVyZXMuZ2V0KGN1cnJlbnRTaWcubmFtZSk7XG5cbiAgICAgICAgLy8gSWYgdGhpcyBmdW5jdGlvbiB3YXMgZGVmaW5lZCBpbiBhIHByaW9yIHRhc2ssIGNoZWNrIGZvciBzaWduYXR1cmUgZHJpZnRcbiAgICAgICAgaWYgKHByaW9yRGVmcyAmJiBwcmlvckRlZnMubGVuZ3RoID4gMCkge1xuICAgICAgICAgIGNvbnN0IHByaW9yRGVmID0gcHJpb3JEZWZzWzBdOyAvLyBVc2UgZmlyc3QgZGVmaW5pdGlvblxuXG4gICAgICAgICAgLy8gQ2hlY2sgcGFyYW1ldGVyIG1pc21hdGNoXG4gICAgICAgICAgaWYgKGN1cnJlbnRTaWcucGFyYW1zICE9PSBwcmlvckRlZi5wYXJhbXMpIHtcbiAgICAgICAgICAgIHJlc3VsdHMucHVzaCh7XG4gICAgICAgICAgICAgIGNhdGVnb3J5OiBcInNpZ25hdHVyZVwiLFxuICAgICAgICAgICAgICB0YXJnZXQ6IGN1cnJlbnRTaWcubmFtZSxcbiAgICAgICAgICAgICAgcGFzc2VkOiBmYWxzZSxcbiAgICAgICAgICAgICAgbWVzc2FnZTogYEZ1bmN0aW9uICcke2N1cnJlbnRTaWcubmFtZX0nIGluICR7ZmlsZX06JHtjdXJyZW50U2lnLmxpbmVOdW19IGhhcyBwYXJhbWV0ZXJzICcke2N1cnJlbnRTaWcucGFyYW1zfScgYnV0IHByaW9yIGRlZmluaXRpb24gaW4gJHtwcmlvckRlZi5maWxlfToke3ByaW9yRGVmLmxpbmVOdW19IGhhcyAnJHtwcmlvckRlZi5wYXJhbXN9J2AsXG4gICAgICAgICAgICAgIGJsb2NraW5nOiBmYWxzZSwgLy8gV2FybiBvbmx5IFx1MjAxNCBtYXkgYmUgaW50ZW50aW9uYWwgb3ZlcnJpZGVcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIC8vIENoZWNrIHJldHVybiB0eXBlIG1pc21hdGNoXG4gICAgICAgICAgaWYgKGN1cnJlbnRTaWcucmV0dXJuVHlwZSAhPT0gcHJpb3JEZWYucmV0dXJuVHlwZSkge1xuICAgICAgICAgICAgcmVzdWx0cy5wdXNoKHtcbiAgICAgICAgICAgICAgY2F0ZWdvcnk6IFwic2lnbmF0dXJlXCIsXG4gICAgICAgICAgICAgIHRhcmdldDogY3VycmVudFNpZy5uYW1lLFxuICAgICAgICAgICAgICBwYXNzZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICBtZXNzYWdlOiBgRnVuY3Rpb24gJyR7Y3VycmVudFNpZy5uYW1lfScgaW4gJHtmaWxlfToke2N1cnJlbnRTaWcubGluZU51bX0gcmV0dXJucyAnJHtjdXJyZW50U2lnLnJldHVyblR5cGV9JyBidXQgcHJpb3IgZGVmaW5pdGlvbiBpbiAke3ByaW9yRGVmLmZpbGV9OiR7cHJpb3JEZWYubGluZU51bX0gcmV0dXJucyAnJHtwcmlvckRlZi5yZXR1cm5UeXBlfSdgLFxuICAgICAgICAgICAgICBibG9ja2luZzogZmFsc2UsIC8vIFdhcm4gb25seSBcdTIwMTQgbWF5IGJlIGludGVudGlvbmFsIG92ZXJyaWRlXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIFNraXAgdW5yZWFkYWJsZSBmaWxlc1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiByZXN1bHRzO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUGF0dGVybiBDb25zaXN0ZW5jeSBDaGVjayBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBEZXRlY3QgYXN5bmMgc3R5bGUgZHJpZnQgKG1peGluZyBhc3luYy9hd2FpdCB3aXRoIC50aGVuKCkpIGFuZFxuICogbmFtaW5nIGNvbnZlbnRpb24gaW5jb25zaXN0ZW5jaWVzIHdpdGhpbiBhIHRhc2sncyBrZXlfZmlsZXMuXG4gKiBXYXJuIG9ubHkgXHUyMDE0IHRoZXNlIGFyZSBzdHlsZSBpc3N1ZXMsIG5vdCBjb3JyZWN0bmVzcyBpc3N1ZXMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjaGVja1BhdHRlcm5Db25zaXN0ZW5jeShcbiAgdGFza1JvdzogVGFza1JvdyxcbiAgX3ByaW9yVGFza3M6IFRhc2tSb3dbXSxcbiAgYmFzZVBhdGg6IHN0cmluZ1xuKTogUG9zdEV4ZWN1dGlvbkNoZWNrSlNPTltdIHtcbiAgY29uc3QgcmVzdWx0czogUG9zdEV4ZWN1dGlvbkNoZWNrSlNPTltdID0gW107XG5cbiAgZm9yIChjb25zdCBmaWxlIG9mIHRhc2tSb3cua2V5X2ZpbGVzKSB7XG4gICAgY29uc3QgZXh0ID0gZXh0bmFtZShmaWxlKTtcbiAgICBpZiAoIVtcIi50c1wiLCBcIi50c3hcIiwgXCIuanNcIiwgXCIuanN4XCIsIFwiLm1qc1wiLCBcIi5janNcIl0uaW5jbHVkZXMoZXh0KSkgY29udGludWU7XG5cbiAgICBjb25zdCBhYnNvbHV0ZVBhdGggPSByZXNvbHZlKGJhc2VQYXRoLCBmaWxlKTtcbiAgICBpZiAoIWV4aXN0c1N5bmMoYWJzb2x1dGVQYXRoKSkgY29udGludWU7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3Qgc291cmNlID0gcmVhZEZpbGVTeW5jKGFic29sdXRlUGF0aCwgXCJ1dGYtOFwiKTtcblxuICAgICAgLy8gQ2hlY2sgZm9yIGFzeW5jIHN0eWxlIGRyaWZ0XG4gICAgICBjb25zdCBhc3luY1N0eWxlUmVzdWx0ID0gY2hlY2tBc3luY1N0eWxlRHJpZnQoc291cmNlLCBmaWxlKTtcbiAgICAgIGlmIChhc3luY1N0eWxlUmVzdWx0KSB7XG4gICAgICAgIHJlc3VsdHMucHVzaChhc3luY1N0eWxlUmVzdWx0KTtcbiAgICAgIH1cblxuICAgICAgLy8gQ2hlY2sgZm9yIG5hbWluZyBjb252ZW50aW9uIGluY29uc2lzdGVuY2llc1xuICAgICAgY29uc3QgbmFtaW5nUmVzdWx0cyA9IGNoZWNrTmFtaW5nQ29uc2lzdGVuY3koc291cmNlLCBmaWxlKTtcbiAgICAgIHJlc3VsdHMucHVzaCguLi5uYW1pbmdSZXN1bHRzKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIFNraXAgdW5yZWFkYWJsZSBmaWxlc1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiByZXN1bHRzO1xufVxuXG4vKipcbiAqIERldGVjdCBhc3luYyBzdHlsZSBkcmlmdCB3aXRoaW4gYSBzaW5nbGUgZmlsZS5cbiAqIFJldHVybnMgYSB3YXJuaW5nIGlmIGJvdGggYXN5bmMvYXdhaXQgQU5EIC50aGVuKCkgcHJvbWlzZSBjaGFpbmluZyBhcmUgdXNlZC5cbiAqL1xuZnVuY3Rpb24gY2hlY2tBc3luY1N0eWxlRHJpZnQoXG4gIHNvdXJjZTogc3RyaW5nLFxuICBmaWxlTmFtZTogc3RyaW5nXG4pOiBQb3N0RXhlY3V0aW9uQ2hlY2tKU09OIHwgbnVsbCB7XG4gIC8vIENoZWNrIGZvciBhc3luYy9hd2FpdCB1c2FnZVxuICBjb25zdCBoYXNBc3luY0F3YWl0ID0gL1xcYmFzeW5jXFxiW1xcc1xcU10qP1xcYmF3YWl0XFxiLy50ZXN0KHNvdXJjZSk7XG5cbiAgLy8gQ2hlY2sgZm9yIC50aGVuKCkgcHJvbWlzZSBjaGFpbmluZyAoZXhjbHVkaW5nIGNvbW1lbnRzKVxuICAvLyBGaWx0ZXIgb3V0IGNvbW1vbiBmYWxzZSBwb3NpdGl2ZXMgbGlrZSBBcnJheS5wcm90b3R5cGUudGhlbiBkb2Vzbid0IGV4aXN0XG4gIGNvbnN0IGhhc1RoZW5DaGFpbmluZyA9IC9cXC5cXHMqdGhlblxccypcXCgvLnRlc3Qoc291cmNlKTtcblxuICAvLyBJZiBib3RoIHBhdHRlcm5zIGFyZSBwcmVzZW50LCBmbGFnIGFzIHN0eWxlIGRyaWZ0XG4gIGlmIChoYXNBc3luY0F3YWl0ICYmIGhhc1RoZW5DaGFpbmluZykge1xuICAgIHJldHVybiB7XG4gICAgICBjYXRlZ29yeTogXCJwYXR0ZXJuXCIsXG4gICAgICB0YXJnZXQ6IGZpbGVOYW1lLFxuICAgICAgcGFzc2VkOiB0cnVlLCAvLyBXYXJuaW5nIG9ubHlcbiAgICAgIG1lc3NhZ2U6IGBGaWxlICR7ZmlsZU5hbWV9IG1peGVzIGFzeW5jL2F3YWl0IHdpdGggLnRoZW4oKSBwcm9taXNlIGNoYWluaW5nIFx1MjAxNCBjb25zaWRlciB1c2luZyBjb25zaXN0ZW50IGFzeW5jIHN0eWxlYCxcbiAgICAgIGJsb2NraW5nOiBmYWxzZSxcbiAgICB9O1xuICB9XG5cbiAgcmV0dXJuIG51bGw7XG59XG5cbi8qKlxuICogQ2hlY2sgZm9yIG5hbWluZyBjb252ZW50aW9uIGluY29uc2lzdGVuY2llcyB3aXRoaW4gYSBmaWxlLlxuICogRGV0ZWN0cyBtaXhpbmcgb2YgY2FtZWxDYXNlIGFuZCBzbmFrZV9jYXNlIGZvciBzaW1pbGFyIGlkZW50aWZpZXIgdHlwZXMuXG4gKi9cbmZ1bmN0aW9uIGNoZWNrTmFtaW5nQ29uc2lzdGVuY3koXG4gIHNvdXJjZTogc3RyaW5nLFxuICBmaWxlTmFtZTogc3RyaW5nXG4pOiBQb3N0RXhlY3V0aW9uQ2hlY2tKU09OW10ge1xuICBjb25zdCByZXN1bHRzOiBQb3N0RXhlY3V0aW9uQ2hlY2tKU09OW10gPSBbXTtcblxuICAvLyBFeHRyYWN0IGZ1bmN0aW9uIG5hbWVzXG4gIGNvbnN0IGZ1bmN0aW9uTmFtZXM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IGZ1bmNQYXR0ZXJuID0gLyg/OmZ1bmN0aW9uXFxzK3xjb25zdFxccyt8bGV0XFxzK3x2YXJcXHMrKShcXHcrKSg/Olxccyo9XFxzKig/OmFzeW5jXFxzKik/XFwofFxccypcXCgpL2c7XG4gIGxldCBtYXRjaDogUmVnRXhwRXhlY0FycmF5IHwgbnVsbDtcblxuICB3aGlsZSAoKG1hdGNoID0gZnVuY1BhdHRlcm4uZXhlYyhzb3VyY2UpKSAhPT0gbnVsbCkge1xuICAgIGZ1bmN0aW9uTmFtZXMucHVzaChtYXRjaFsxXSk7XG4gIH1cblxuICAvLyBDaGVjayBmb3IgbWl4ZWQgbmFtaW5nIGNvbnZlbnRpb25zIGluIGZ1bmN0aW9uc1xuICBjb25zdCBjYW1lbENhc2VGdW5jcyA9IGZ1bmN0aW9uTmFtZXMuZmlsdGVyKChuKSA9PiAvXlthLXpdW2EtekEtWjAtOV0qJC8udGVzdChuKSAmJiAvW0EtWl0vLnRlc3QobikpO1xuICBjb25zdCBzbmFrZUNhc2VGdW5jcyA9IGZ1bmN0aW9uTmFtZXMuZmlsdGVyKChuKSA9PiAvXlthLXpdW2EtejAtOV0qKF9bYS16MC05XSspKyQvLnRlc3QobikpO1xuXG4gIGlmIChjYW1lbENhc2VGdW5jcy5sZW5ndGggPiAwICYmIHNuYWtlQ2FzZUZ1bmNzLmxlbmd0aCA+IDApIHtcbiAgICByZXN1bHRzLnB1c2goe1xuICAgICAgY2F0ZWdvcnk6IFwicGF0dGVyblwiLFxuICAgICAgdGFyZ2V0OiBmaWxlTmFtZSxcbiAgICAgIHBhc3NlZDogdHJ1ZSwgLy8gV2FybmluZyBvbmx5XG4gICAgICBtZXNzYWdlOiBgRmlsZSAke2ZpbGVOYW1lfSBtaXhlcyBjYW1lbENhc2UgKCR7Y2FtZWxDYXNlRnVuY3Muc2xpY2UoMCwgMikuam9pbihcIiwgXCIpfSkgYW5kIHNuYWtlX2Nhc2UgKCR7c25ha2VDYXNlRnVuY3Muc2xpY2UoMCwgMikuam9pbihcIiwgXCIpfSkgZnVuY3Rpb24gbmFtZXNgLFxuICAgICAgYmxvY2tpbmc6IGZhbHNlLFxuICAgIH0pO1xuICB9XG5cbiAgcmV0dXJuIHJlc3VsdHM7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBNYWluIEVudHJ5IFBvaW50IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFJ1biBhbGwgcG9zdC1leGVjdXRpb24gY2hlY2tzIGFnYWluc3QgYSBjb21wbGV0ZWQgdGFzay5cbiAqXG4gKiBAcGFyYW0gdGFza1JvdyAtIFRoZSBjb21wbGV0ZWQgdGFzayByb3dcbiAqIEBwYXJhbSBwcmlvclRhc2tzIC0gQXJyYXkgb2YgVGFza1JvdyBmcm9tIHByaW9yIGNvbXBsZXRlZCB0YXNrcyBpbiB0aGUgc2xpY2VcbiAqIEBwYXJhbSBiYXNlUGF0aCAtIEJhc2UgcGF0aCBmb3IgcmVzb2x2aW5nIGZpbGUgcmVmZXJlbmNlc1xuICogQHJldHVybnMgUG9zdEV4ZWN1dGlvblJlc3VsdCB3aXRoIHN0YXR1cywgY2hlY2tzLCBhbmQgZHVyYXRpb25cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJ1blBvc3RFeGVjdXRpb25DaGVja3MoXG4gIHRhc2tSb3c6IFRhc2tSb3csXG4gIHByaW9yVGFza3M6IFRhc2tSb3dbXSxcbiAgYmFzZVBhdGg6IHN0cmluZ1xuKTogUG9zdEV4ZWN1dGlvblJlc3VsdCB7XG4gIGNvbnN0IHN0YXJ0VGltZSA9IERhdGUubm93KCk7XG4gIGNvbnN0IGFsbENoZWNrczogUG9zdEV4ZWN1dGlvbkNoZWNrSlNPTltdID0gW107XG5cbiAgLy8gUnVuIGFsbCBjaGVja3NcbiAgY29uc3QgaW1wb3J0Q2hlY2tzID0gY2hlY2tJbXBvcnRSZXNvbHV0aW9uKHRhc2tSb3csIHByaW9yVGFza3MsIGJhc2VQYXRoKTtcbiAgY29uc3Qgc2lnbmF0dXJlQ2hlY2tzID0gY2hlY2tDcm9zc1Rhc2tTaWduYXR1cmVzKHRhc2tSb3csIHByaW9yVGFza3MsIGJhc2VQYXRoKTtcbiAgY29uc3QgcGF0dGVybkNoZWNrcyA9IGNoZWNrUGF0dGVybkNvbnNpc3RlbmN5KHRhc2tSb3csIHByaW9yVGFza3MsIGJhc2VQYXRoKTtcblxuICBhbGxDaGVja3MucHVzaCguLi5pbXBvcnRDaGVja3MsIC4uLnNpZ25hdHVyZUNoZWNrcywgLi4ucGF0dGVybkNoZWNrcyk7XG5cbiAgY29uc3QgZHVyYXRpb25NcyA9IERhdGUubm93KCkgLSBzdGFydFRpbWU7XG5cbiAgLy8gRGV0ZXJtaW5lIG92ZXJhbGwgc3RhdHVzXG4gIGNvbnN0IGhhc0Jsb2NraW5nRmFpbHVyZSA9IGFsbENoZWNrcy5zb21lKChjKSA9PiAhYy5wYXNzZWQgJiYgYy5ibG9ja2luZyk7XG4gIGNvbnN0IGhhc05vbkJsb2NraW5nSXNzdWUgPSBhbGxDaGVja3Muc29tZShcbiAgICAoYykgPT4gKCFjLnBhc3NlZCAmJiAhYy5ibG9ja2luZykgfHwgKGMucGFzc2VkICYmIGMuY2F0ZWdvcnkgPT09IFwicGF0dGVyblwiKVxuICApO1xuXG4gIGxldCBzdGF0dXM6IFwicGFzc1wiIHwgXCJ3YXJuXCIgfCBcImZhaWxcIjtcbiAgaWYgKGhhc0Jsb2NraW5nRmFpbHVyZSkge1xuICAgIHN0YXR1cyA9IFwiZmFpbFwiO1xuICB9IGVsc2UgaWYgKGhhc05vbkJsb2NraW5nSXNzdWUpIHtcbiAgICBzdGF0dXMgPSBcIndhcm5cIjtcbiAgfSBlbHNlIHtcbiAgICBzdGF0dXMgPSBcInBhc3NcIjtcbiAgfVxuXG4gIHJldHVybiB7XG4gICAgc3RhdHVzLFxuICAgIGNoZWNrczogYWxsQ2hlY2tzLFxuICAgIGR1cmF0aW9uTXMsXG4gIH07XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFrQkEsU0FBUyxZQUFZLG9CQUFvQjtBQUN6QyxTQUFTLFNBQVMsU0FBZSxlQUFlO0FBa0NoRCxT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
