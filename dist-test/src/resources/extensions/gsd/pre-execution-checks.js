import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { validateVerificationCommand } from "./verification-gate.js";
const NPM_COMMAND = process.platform === "win32" ? "npm.cmd" : "npm";
function checkVerificationCommands(tasks) {
  const results = [];
  for (const task of tasks) {
    const verify = task.verify.trim();
    if (!verify) continue;
    const commands = verify.split("&&").map((command) => command.trim()).filter(Boolean);
    for (const command of commands) {
      const validation = validateVerificationCommand(command);
      if (!validation.ok) {
        results.push({
          category: "tool",
          target: `${task.id} Verify`,
          passed: false,
          message: `Unsafe or non-runnable Verify command: ${command} (${validation.reason})`,
          blocking: true
        });
      }
    }
  }
  return results;
}
function extractPackageReferences(description) {
  const packages = /* @__PURE__ */ new Set();
  const stopwords = /* @__PURE__ */ new Set([
    "then",
    "and",
    "the",
    "to",
    "a",
    "an",
    "in",
    "for",
    "with",
    "from",
    "or",
    "npm",
    "yarn",
    "pnpm",
    "i"
    // Don't capture the command itself
  ]);
  const installCmdPattern = /(?:npm\s+(?:install|i|add)|yarn\s+add|pnpm\s+add)\s+/g;
  let cmdMatch;
  while ((cmdMatch = installCmdPattern.exec(description)) !== null) {
    const afterCmd = description.slice(cmdMatch.index + cmdMatch[0].length);
    const tokenPattern = /^([@a-zA-Z][a-zA-Z0-9@/_-]*)(?:\s+|$)/;
    let remaining = afterCmd;
    while (remaining.length > 0) {
      const flagMatch = remaining.match(/^(-[a-zA-Z-]+)\s*/);
      if (flagMatch) {
        remaining = remaining.slice(flagMatch[0].length);
        continue;
      }
      const pkgMatch = remaining.match(tokenPattern);
      if (pkgMatch) {
        const token = pkgMatch[1];
        if (stopwords.has(token.toLowerCase())) {
          break;
        }
        packages.add(normalizePackageName(token));
        remaining = remaining.slice(pkgMatch[0].length);
      } else {
        break;
      }
    }
  }
  const importPattern = /(?:require\s*\(\s*['"]|import\b[\s\S]*?\bfrom\s+['"])([a-zA-Z0-9@/_-]+)['"\)]/g;
  let importMatch;
  while ((importMatch = importPattern.exec(description)) !== null) {
    const pkg = importMatch[1];
    if (!pkg.startsWith(".") && !pkg.startsWith("node:")) {
      packages.add(normalizePackageName(pkg));
    }
  }
  return Array.from(packages);
}
function normalizePackageName(raw) {
  if (raw.startsWith("@")) {
    const parts = raw.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : raw;
  }
  return raw.split("/")[0];
}
async function checkPackageOnNpm(packageName, timeoutMs = 5e3) {
  return new Promise((resolve2) => {
    const child = spawn(NPM_COMMAND, ["view", packageName, "name"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      shell: process.platform === "win32"
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve2({ exists: false, error: `Timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) {
        resolve2({ exists: true });
      } else if (stderr.includes("404") || stderr.includes("not found")) {
        resolve2({ exists: false, error: `Package not found: ${packageName}` });
      } else if (code !== 0) {
        resolve2({ exists: true, error: `npm view failed (code ${code}): ${stderr.slice(0, 100)}` });
      } else {
        resolve2({ exists: true });
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve2({ exists: true, error: `npm spawn error: ${err.message}` });
    });
  });
}
async function checkPackageExistence(tasks, _basePath) {
  const results = [];
  const packagesToCheck = /* @__PURE__ */ new Set();
  for (const task of tasks) {
    const packages = extractPackageReferences(task.description);
    for (const pkg of packages) {
      packagesToCheck.add(pkg);
    }
  }
  if (packagesToCheck.size === 0) {
    return results;
  }
  const checkPromises = Array.from(packagesToCheck).map(async (pkg) => {
    const result = await checkPackageOnNpm(pkg);
    return { pkg, result };
  });
  const checkResults = await Promise.all(checkPromises);
  for (const { pkg, result } of checkResults) {
    if (!result.exists && !result.error?.includes("Timeout") && !result.error?.includes("spawn error")) {
      results.push({
        category: "package",
        target: pkg,
        passed: false,
        message: result.error || `Package '${pkg}' not found on npm`,
        blocking: true
      });
    } else if (result.error) {
      results.push({
        category: "package",
        target: pkg,
        passed: true,
        message: `Warning: ${result.error}`,
        blocking: false
      });
    }
  }
  return results;
}
function normalizeFilePath(filePath) {
  if (!filePath) return filePath;
  let normalized = extractPathFromAnnotation(filePath);
  normalized = normalized.replace(/\\/g, "/");
  if (normalized === "~") {
    normalized = homedir();
  } else if (normalized.startsWith("~/")) {
    normalized = resolve(homedir(), normalized.slice(2));
  }
  normalized = normalized.replace(/\\/g, "/");
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  normalized = normalized.replace(/\/+/g, "/");
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}
function isDirectoryReference(raw) {
  const candidate = extractPathFromAnnotation(raw.trim());
  if (!candidate) return false;
  if (containsGlobPattern(candidate)) return false;
  return candidate.endsWith("/");
}
function anyOutputUnderDirectory(normalizedDir, knownOutputs) {
  const prefix = normalizedDir + "/";
  for (const output of knownOutputs) {
    if (output === normalizedDir) return true;
    if (output.startsWith(prefix)) return true;
  }
  return false;
}
const URL_SCHEME_PATTERN = /^(https?|ftp|file|ssh|git):\/\//i;
const SCP_PATTERN = /^[\w.-]+@[\w.-]+:[^/]/;
function looksLikePathOrUrl(token) {
  if (URL_SCHEME_PATTERN.test(token)) return true;
  if (SCP_PATTERN.test(token)) return true;
  if (/^[./~]/.test(token)) return true;
  if (/[\\/]/.test(token)) return true;
  if (/\.[A-Za-z0-9]{1,8}$/.test(token)) return true;
  return false;
}
function extractPathFromAnnotation(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  const backtickMatch = trimmed.match(/^(`+)([^`]+)\1(?:(?:\s+[—–-]\s+.+)|(?:\s+\([^()]+\)))?$/);
  if (backtickMatch) {
    return backtickMatch[2].trim();
  }
  const quoteMatch = trimmed.match(/^(["'])([^"']+)\1$/);
  if (quoteMatch) {
    return quoteMatch[2].trim();
  }
  const annotatedMatch = trimmed.match(/^(.+?)\s+[—–-]\s+.+$/);
  if (annotatedMatch) {
    const prefix = annotatedMatch[1].trim();
    const prefixBacktickMatch = prefix.match(/`([^`]+)`/);
    if (prefixBacktickMatch && looksLikePathOrUrl(prefixBacktickMatch[1].trim())) {
      return prefixBacktickMatch[1].trim();
    }
    return prefix.replace(/`/g, "").trim();
  }
  const backtickTokens = trimmed.matchAll(/`([^`]+)`/g);
  for (const match of backtickTokens) {
    const token = match[1].trim();
    if (looksLikePathOrUrl(token)) {
      return token;
    }
  }
  return trimmed.replace(/`/g, "");
}
function shouldValidateInputAsPath(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (isRuntimeOnlyInput(trimmed)) return false;
  const candidate = extractPathFromAnnotation(trimmed);
  if (!candidate) return false;
  if (URL_SCHEME_PATTERN.test(candidate)) return false;
  if (SCP_PATTERN.test(candidate)) return false;
  if (/^`+[^`]+`+/.test(trimmed)) {
    return true;
  }
  if (!/\s/.test(candidate)) {
    return true;
  }
  return candidate.startsWith("/") || candidate.startsWith("./") || candidate.startsWith("../") || candidate.startsWith("~/") || /[\\/]/.test(candidate) || /[*?[\]{}]/.test(candidate);
}
function isRuntimeOnlyInput(raw) {
  return /\(\s*runtime\s*\)/i.test(raw);
}
function containsGlobPattern(candidate) {
  return ["*", "?", "[", "]", "{", "}"].some((char) => candidate.includes(char));
}
function getExpectedOutputsUpTo(tasks, taskIndex) {
  const outputs = /* @__PURE__ */ new Set();
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    if (i < taskIndex || task.status === "completed") {
      for (const file of task.expected_output) {
        outputs.add(normalizeFilePath(file));
      }
    }
  }
  return outputs;
}
function checkFilePathConsistency(tasks, basePath) {
  const results = [];
  const allTaskOutputs = /* @__PURE__ */ new Set();
  for (const t of tasks) {
    for (const f of t.expected_output) {
      allTaskOutputs.add(normalizeFilePath(f));
    }
  }
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const priorOutputs = getExpectedOutputsUpTo(tasks, i);
    const ownOutputs = new Set(task.expected_output.map(normalizeFilePath));
    const filesToCheck = [...task.inputs];
    for (const file of filesToCheck) {
      if (!file.trim()) continue;
      if (!shouldValidateInputAsPath(file)) continue;
      const normalizedFile = normalizeFilePath(file);
      if (containsGlobPattern(normalizedFile)) continue;
      const absolutePath = resolve(basePath, normalizedFile);
      const existsOnDisk = existsSync(absolutePath);
      const inPriorOutputs = priorOutputs.has(normalizedFile);
      const inOwnOutputs = ownOutputs.has(normalizedFile);
      let directorySatisfied = false;
      if (!existsOnDisk && !inPriorOutputs && !inOwnOutputs && isDirectoryReference(file)) {
        directorySatisfied = anyOutputUnderDirectory(normalizedFile, priorOutputs) || anyOutputUnderDirectory(normalizedFile, ownOutputs);
      }
      if (!existsOnDisk && !inPriorOutputs && !inOwnOutputs && !directorySatisfied) {
        if (allTaskOutputs.has(normalizedFile) && !ownOutputs.has(normalizedFile)) {
          continue;
        }
        results.push({
          category: "file",
          target: file,
          passed: false,
          message: `Task ${task.id} references '${file}' which doesn't exist and isn't created by prior or same-task outputs`,
          blocking: true
        });
      }
    }
  }
  return results;
}
function checkTaskOrdering(tasks, basePath) {
  const results = [];
  const fileCreators = /* @__PURE__ */ new Map();
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    for (const file of task.expected_output) {
      const normalizedFile = normalizeFilePath(file);
      const existing = fileCreators.get(normalizedFile);
      if (!existing || !existing.completed && task.status === "completed") {
        fileCreators.set(normalizedFile, {
          taskId: task.id,
          index: i,
          originalPath: file,
          completed: task.status === "completed"
        });
      }
    }
  }
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const filesToCheck = [...task.inputs];
    for (const file of filesToCheck) {
      if (isRuntimeOnlyInput(file)) continue;
      if (!shouldValidateInputAsPath(file)) continue;
      const normalizedFile = normalizeFilePath(file);
      if (containsGlobPattern(normalizedFile)) continue;
      if (isDirectoryReference(file)) continue;
      const creator = fileCreators.get(normalizedFile);
      const absolutePath = resolve(basePath, normalizedFile);
      const existsOnDisk = existsSync(absolutePath);
      if (creator && creator.index > i && !existsOnDisk && !creator.completed) {
        results.push({
          category: "file",
          target: file,
          passed: false,
          message: `Task ${task.id} reads '${file}' but it's created by task ${creator.taskId} (sequence violation)`,
          blocking: true
        });
      }
    }
  }
  return results;
}
function extractFunctionSignatures(description, taskId) {
  const signatures = [];
  const codeBlockPattern = /```(?:typescript|ts|javascript|js)?\n([\s\S]*?)```/g;
  let blockMatch;
  while ((blockMatch = codeBlockPattern.exec(description)) !== null) {
    const codeBlock = blockMatch[1];
    const funcPattern = /(?:export\s+)?(?:async\s+)?(?:function\s+|const\s+)(\w+)(?:\s*=\s*)?\s*\(([^)]*)\)(?:\s*:\s*([^{=>\n]+))?/g;
    let funcMatch;
    while ((funcMatch = funcPattern.exec(codeBlock)) !== null) {
      const [raw, name, params, returnType] = funcMatch;
      signatures.push({
        name,
        params: normalizeParams(params),
        returnType: normalizeType(returnType || "void"),
        taskId,
        raw: raw.trim()
      });
    }
    const methodPattern = /^\s*(\w+)\s*\(([^)]*)\)\s*:\s*([^;]+);/gm;
    let methodMatch;
    while ((methodMatch = methodPattern.exec(codeBlock)) !== null) {
      const [raw, name, params, returnType] = methodMatch;
      signatures.push({
        name,
        params: normalizeParams(params),
        returnType: normalizeType(returnType),
        taskId,
        raw: raw.trim()
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
function checkInterfaceContracts(tasks, _basePath) {
  const results = [];
  const allSignatures = [];
  for (const task of tasks) {
    const sigs = extractFunctionSignatures(task.description, task.id);
    allSignatures.push(...sigs);
  }
  const byName = /* @__PURE__ */ new Map();
  for (const sig of allSignatures) {
    const existing = byName.get(sig.name) || [];
    existing.push(sig);
    byName.set(sig.name, existing);
  }
  for (const [name, sigs] of byName) {
    if (sigs.length < 2) continue;
    const first = sigs[0];
    for (let i = 1; i < sigs.length; i++) {
      const current = sigs[i];
      if (first.params !== current.params) {
        results.push({
          category: "schema",
          target: name,
          passed: true,
          // Warning only, not blocking
          message: `Function '${name}' has different parameters: '${first.params}' (${first.taskId}) vs '${current.params}' (${current.taskId})`,
          blocking: false
        });
      }
      if (first.returnType !== current.returnType) {
        results.push({
          category: "schema",
          target: name,
          passed: true,
          // Warning only, not blocking
          message: `Function '${name}' has different return types: '${first.returnType}' (${first.taskId}) vs '${current.returnType}' (${current.taskId})`,
          blocking: false
        });
      }
    }
  }
  return results;
}
async function runPreExecutionChecks(tasks, basePath) {
  const startTime = Date.now();
  const allChecks = [];
  const fileChecks = checkFilePathConsistency(tasks, basePath);
  const orderingChecks = checkTaskOrdering(tasks, basePath);
  const contractChecks = checkInterfaceContracts(tasks, basePath);
  const verificationChecks = checkVerificationCommands(tasks);
  allChecks.push(...fileChecks, ...orderingChecks, ...contractChecks, ...verificationChecks);
  const packageChecks = await checkPackageExistence(tasks, basePath);
  allChecks.push(...packageChecks);
  const durationMs = Date.now() - startTime;
  const hasBlockingFailure = allChecks.some((c) => !c.passed && c.blocking);
  const hasNonBlockingFailure = allChecks.some((c) => !c.passed && !c.blocking);
  const hasInterfaceWarning = allChecks.some(
    (c) => c.category === "schema" && c.message && !c.message.startsWith("Warning:")
  );
  const hasNetworkWarning = allChecks.some(
    (c) => c.passed && c.message?.startsWith("Warning:")
  );
  let status;
  if (hasBlockingFailure) {
    status = "fail";
  } else if (hasNonBlockingFailure || hasInterfaceWarning || hasNetworkWarning) {
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
  checkFilePathConsistency,
  checkInterfaceContracts,
  checkPackageExistence,
  checkTaskOrdering,
  checkVerificationCommands,
  extractPackageReferences,
  normalizeFilePath,
  runPreExecutionChecks
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9wcmUtZXhlY3V0aW9uLWNoZWNrcy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IFByZS1leGVjdXRpb24gdmFsaWRhdGlvbiBjaGVja3MgZm9yIEdTRCB0YXNrIHBsYW5zLlxuXG4vKipcbiAqIFByZS1FeGVjdXRpb24gQ2hlY2tzIFx1MjAxNCBWYWxpZGF0ZSB0YXNrIHBsYW5zIGJlZm9yZSBleGVjdXRpb24gYmVnaW5zLlxuICpcbiAqIFJ1bnMgdGhlc2UgY2hlY2tzIGFnYWluc3QgYSBzbGljZSdzIHRhc2sgcGxhbjpcbiAqICAgMS4gUGFja2FnZSBleGlzdGVuY2UgXHUyMDE0IG5wbSB2aWV3IGNhbGxzIGluIHBhcmFsbGVsIHdpdGggdGltZW91dFxuICogICAyLiBGaWxlIHBhdGggY29uc2lzdGVuY3kgXHUyMDE0IHZlcmlmeSBmaWxlcyBleGlzdCBvciBhcmUgaW4gcHJpb3IgZXhwZWN0ZWRfb3V0cHV0XG4gKiAgIDMuIFRhc2sgb3JkZXJpbmcgXHUyMDE0IGRldGVjdCBpbXBvc3NpYmxlIG9yZGVyaW5nICh0YXNrIHJlYWRzIGZpbGUgY3JlYXRlZCBsYXRlcilcbiAqICAgNC4gSW50ZXJmYWNlIGNvbnRyYWN0cyBcdTIwMTQgZGV0ZWN0IGNvbnRyYWRpY3RvcnkgZnVuY3Rpb24gc2lnbmF0dXJlcyAod2FybiBvbmx5KVxuICpcbiAqIERlc2lnbiBwcmluY2lwbGVzOlxuICogICAtIFB1cmUgZnVuY3Rpb25zIHRha2luZyAodGFza3M6IFRhc2tSb3dbXSwgYmFzZVBhdGg6IHN0cmluZykgZm9yIHRlc3RhYmlsaXR5XG4gKiAgIC0gTmV0d29yayBmYWlsdXJlcyB3YXJuLCBkb24ndCBmYWlsIChSMDEyIGNvbnNlcnZhdGl2ZSBkZXNpZ24pXG4gKiAgIC0gVG90YWwgZXhlY3V0aW9uIDwycyB0YXJnZXQgKFIwMTMpXG4gKiAgIC0gTm8gQVNUIHBhcnNlcnMgXHUyMDE0IGludGVyZmFjZSBwYXJzaW5nIGlzIGhldXJpc3RpYyAocmVnZXggb24gY29kZSBibG9ja3MpXG4gKi9cblxuaW1wb3J0IHsgZXhpc3RzU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBzcGF3biB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7IGhvbWVkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgcmVzb2x2ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB0eXBlIHsgVGFza1JvdyB9IGZyb20gXCIuL2RiLXRhc2stc2xpY2Utcm93cy5qc1wiO1xuaW1wb3J0IHR5cGUgeyBQcmVFeGVjdXRpb25DaGVja0pTT04gfSBmcm9tIFwiLi92ZXJpZmljYXRpb24tZXZpZGVuY2UudHNcIjtcbmltcG9ydCB7IHZhbGlkYXRlVmVyaWZpY2F0aW9uQ29tbWFuZCB9IGZyb20gXCIuL3ZlcmlmaWNhdGlvbi1nYXRlLmpzXCI7XG5cbmNvbnN0IE5QTV9DT01NQU5EID0gcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiID8gXCJucG0uY21kXCIgOiBcIm5wbVwiO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUmVzdWx0IFR5cGVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgaW50ZXJmYWNlIFByZUV4ZWN1dGlvblJlc3VsdCB7XG4gIC8qKiBPdmVyYWxsIHJlc3VsdDogcGFzcyBpZiBubyBibG9ja2luZyBmYWlsdXJlcywgd2FybiBpZiBub24tYmxvY2tpbmcgaXNzdWVzLCBmYWlsIGlmIGJsb2NraW5nIGlzc3VlcyAqL1xuICBzdGF0dXM6IFwicGFzc1wiIHwgXCJ3YXJuXCIgfCBcImZhaWxcIjtcbiAgLyoqIEFsbCBjaGVjayByZXN1bHRzICovXG4gIGNoZWNrczogUHJlRXhlY3V0aW9uQ2hlY2tKU09OW107XG4gIC8qKiBUb3RhbCBkdXJhdGlvbiBpbiBtaWxsaXNlY29uZHMgKi9cbiAgZHVyYXRpb25NczogbnVtYmVyO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY2hlY2tWZXJpZmljYXRpb25Db21tYW5kcyh0YXNrczogVGFza1Jvd1tdKTogUHJlRXhlY3V0aW9uQ2hlY2tKU09OW10ge1xuICBjb25zdCByZXN1bHRzOiBQcmVFeGVjdXRpb25DaGVja0pTT05bXSA9IFtdO1xuXG4gIGZvciAoY29uc3QgdGFzayBvZiB0YXNrcykge1xuICAgIGNvbnN0IHZlcmlmeSA9IHRhc2sudmVyaWZ5LnRyaW0oKTtcbiAgICBpZiAoIXZlcmlmeSkgY29udGludWU7XG5cbiAgICBjb25zdCBjb21tYW5kcyA9IHZlcmlmeVxuICAgICAgLnNwbGl0KFwiJiZcIilcbiAgICAgIC5tYXAoKGNvbW1hbmQpID0+IGNvbW1hbmQudHJpbSgpKVxuICAgICAgLmZpbHRlcihCb29sZWFuKTtcblxuICAgIGZvciAoY29uc3QgY29tbWFuZCBvZiBjb21tYW5kcykge1xuICAgICAgY29uc3QgdmFsaWRhdGlvbiA9IHZhbGlkYXRlVmVyaWZpY2F0aW9uQ29tbWFuZChjb21tYW5kKTtcbiAgICAgIGlmICghdmFsaWRhdGlvbi5vaykge1xuICAgICAgICByZXN1bHRzLnB1c2goe1xuICAgICAgICAgIGNhdGVnb3J5OiBcInRvb2xcIixcbiAgICAgICAgICB0YXJnZXQ6IGAke3Rhc2suaWR9IFZlcmlmeWAsXG4gICAgICAgICAgcGFzc2VkOiBmYWxzZSxcbiAgICAgICAgICBtZXNzYWdlOiBgVW5zYWZlIG9yIG5vbi1ydW5uYWJsZSBWZXJpZnkgY29tbWFuZDogJHtjb21tYW5kfSAoJHt2YWxpZGF0aW9uLnJlYXNvbn0pYCxcbiAgICAgICAgICBibG9ja2luZzogdHJ1ZSxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHJlc3VsdHM7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBQYWNrYWdlIEV4aXN0ZW5jZSBDaGVjayBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBFeHRyYWN0IG5wbSBwYWNrYWdlIG5hbWVzIGZyb20gdGFzayBkZXNjcmlwdGlvbnMuXG4gKiBMb29rcyBmb3I6XG4gKiAgIC0gYG5wbSBpbnN0YWxsIDxwa2c+YCBwYXR0ZXJuc1xuICogICAtIENvZGUgYmxvY2tzIHdpdGggYHJlcXVpcmUoJzxwa2c+JylgIG9yIGBpbXBvcnQgLi4uIGZyb20gJzxwa2c+J2BcbiAqICAgLSBFeHBsaWNpdCBtZW50aW9ucyBsaWtlIFwidXNlcyBsb2Rhc2hcIiBvciBcInBhY2thZ2U6IGF4aW9zXCJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGV4dHJhY3RQYWNrYWdlUmVmZXJlbmNlcyhkZXNjcmlwdGlvbjogc3RyaW5nKTogc3RyaW5nW10ge1xuICBjb25zdCBwYWNrYWdlcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4gIC8vIENvbW1vbiB3b3JkcyB0aGF0IGFyZW4ndCBwYWNrYWdlIG5hbWVzIGJ1dCBtaWdodCBhcHBlYXIgYWZ0ZXIgaW5zdGFsbFxuICBjb25zdCBzdG9wd29yZHMgPSBuZXcgU2V0KFtcbiAgICBcInRoZW5cIiwgXCJhbmRcIiwgXCJ0aGVcIiwgXCJ0b1wiLCBcImFcIiwgXCJhblwiLCBcImluXCIsIFwiZm9yXCIsIFwid2l0aFwiLCBcImZyb21cIiwgXCJvclwiLFxuICAgIFwibnBtXCIsIFwieWFyblwiLCBcInBucG1cIiwgXCJpXCIsIC8vIERvbid0IGNhcHR1cmUgdGhlIGNvbW1hbmQgaXRzZWxmXG4gIF0pO1xuXG4gIC8vIG5wbSBpbnN0YWxsIDxwa2c+IHBhdHRlcm5zIChoYW5kbGVzIG5wbSBpLCBucG0gYWRkLCB5YXJuIGFkZCwgcG5wbSBhZGQpXG4gIC8vIFVzZSBhIGdsb2JhbCBwYXR0ZXJuIHRvIGZpbmQgYWxsIGluc3RhbGwgY29tbWFuZHMsIHRoZW4gcGFyc2UgZm9sbG93aW5nIHRva2Vuc1xuICBjb25zdCBpbnN0YWxsQ21kUGF0dGVybiA9IC8oPzpucG1cXHMrKD86aW5zdGFsbHxpfGFkZCl8eWFyblxccythZGR8cG5wbVxccythZGQpXFxzKy9nO1xuICBsZXQgY21kTWF0Y2g6IFJlZ0V4cEV4ZWNBcnJheSB8IG51bGw7XG4gIFxuICB3aGlsZSAoKGNtZE1hdGNoID0gaW5zdGFsbENtZFBhdHRlcm4uZXhlYyhkZXNjcmlwdGlvbikpICE9PSBudWxsKSB7XG4gICAgLy8gU3RhcnQgYWZ0ZXIgdGhlIGluc3RhbGwgY29tbWFuZFxuICAgIGNvbnN0IGFmdGVyQ21kID0gZGVzY3JpcHRpb24uc2xpY2UoY21kTWF0Y2guaW5kZXggKyBjbWRNYXRjaFswXS5sZW5ndGgpO1xuICAgIFxuICAgIC8vIE1hdGNoIHBhY2thZ2UtbGlrZSB0b2tlbnMgKGFscGhhbnVtZXJpYywgQCwgLywgLSwgXykgdW50aWwgd2UgaGl0XG4gICAgLy8gc29tZXRoaW5nIHRoYXQncyBub3QgYSBwYWNrYWdlIChub24tdG9rZW4gY2hhciBhZnRlciB3aGl0ZXNwYWNlKVxuICAgIGNvbnN0IHRva2VuUGF0dGVybiA9IC9eKFtAYS16QS1aXVthLXpBLVowLTlAL18tXSopKD86XFxzK3wkKS87XG4gICAgbGV0IHJlbWFpbmluZyA9IGFmdGVyQ21kO1xuICAgIFxuICAgIHdoaWxlIChyZW1haW5pbmcubGVuZ3RoID4gMCkge1xuICAgICAgLy8gU2tpcCBhbnkgZmxhZ3MgbGlrZSAtRCwgLS1zYXZlLWRldlxuICAgICAgY29uc3QgZmxhZ01hdGNoID0gcmVtYWluaW5nLm1hdGNoKC9eKC1bYS16QS1aLV0rKVxccyovKTtcbiAgICAgIGlmIChmbGFnTWF0Y2gpIHtcbiAgICAgICAgcmVtYWluaW5nID0gcmVtYWluaW5nLnNsaWNlKGZsYWdNYXRjaFswXS5sZW5ndGgpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIFxuICAgICAgLy8gVHJ5IHRvIG1hdGNoIGEgcGFja2FnZSBuYW1lXG4gICAgICBjb25zdCBwa2dNYXRjaCA9IHJlbWFpbmluZy5tYXRjaCh0b2tlblBhdHRlcm4pO1xuICAgICAgaWYgKHBrZ01hdGNoKSB7XG4gICAgICAgIGNvbnN0IHRva2VuID0gcGtnTWF0Y2hbMV07XG4gICAgICAgIC8vIFNraXAgc3RvcHdvcmRzIC0gdGhleSBpbmRpY2F0ZSBlbmQgb2YgcGFja2FnZSBsaXN0XG4gICAgICAgIGlmIChzdG9wd29yZHMuaGFzKHRva2VuLnRvTG93ZXJDYXNlKCkpKSB7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgICAgcGFja2FnZXMuYWRkKG5vcm1hbGl6ZVBhY2thZ2VOYW1lKHRva2VuKSk7XG4gICAgICAgIHJlbWFpbmluZyA9IHJlbWFpbmluZy5zbGljZShwa2dNYXRjaFswXS5sZW5ndGgpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gTm90IGEgcGFja2FnZSBuYW1lLCBzdG9wIHBhcnNpbmcgdGhpcyBpbnN0YWxsIGNvbW1hbmRcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gcmVxdWlyZSgncGtnJykgb3IgYGltcG9ydCAuLi4gZnJvbSAncGtnJ2AgaW4gY29kZSBibG9ja3MuXG4gIC8vIFRoZSBgZnJvbVxccytbJ1wiXWAgYnJhbmNoIE1VU1QgYmUgcHJlY2VkZWQgYnkgYW4gYGltcG9ydGAga2V5d29yZCBzbyB0aGF0XG4gIC8vIG5hdHVyYWwtbGFuZ3VhZ2UgcHJvc2UgbGlrZSBgZnJvbSBcIldoYXQncyBOZXh0XCJgIG9yIGBmcm9tICdtYXN0ZXInYCBkb2VzXG4gIC8vIG5vdCBwcm9kdWNlIGZhbHNlIHBhY2thZ2UtZXhpc3RlbmNlIGZhaWx1cmVzLiAgUmVxdWlyaW5nIHRoZSBsZWFkaW5nIGltcG9ydFxuICAvLyBrZXl3b3JkIGFuY2hvcnMgdGhlIG1hdGNoIHRvIEphdmFTY3JpcHQvVHlwZVNjcmlwdCBzeW50YXguXG4gIC8vIFNlZTogaHR0cHM6Ly9naXRodWIuY29tL2dzZC1idWlsZC9nc2QtMi9pc3N1ZXMvNDM4OFxuICBjb25zdCBpbXBvcnRQYXR0ZXJuID0gLyg/OnJlcXVpcmVcXHMqXFwoXFxzKlsnXCJdfGltcG9ydFxcYltcXHNcXFNdKj9cXGJmcm9tXFxzK1snXCJdKShbYS16QS1aMC05QC9fLV0rKVsnXCJcXCldL2c7XG4gIGxldCBpbXBvcnRNYXRjaDogUmVnRXhwRXhlY0FycmF5IHwgbnVsbDtcbiAgd2hpbGUgKChpbXBvcnRNYXRjaCA9IGltcG9ydFBhdHRlcm4uZXhlYyhkZXNjcmlwdGlvbikpICE9PSBudWxsKSB7XG4gICAgLy8gU2tpcCByZWxhdGl2ZSBpbXBvcnRzIGFuZCBub2RlIGJ1aWx0aW5zXG4gICAgY29uc3QgcGtnID0gaW1wb3J0TWF0Y2hbMV07XG4gICAgaWYgKCFwa2cuc3RhcnRzV2l0aChcIi5cIikgJiYgIXBrZy5zdGFydHNXaXRoKFwibm9kZTpcIikpIHtcbiAgICAgIHBhY2thZ2VzLmFkZChub3JtYWxpemVQYWNrYWdlTmFtZShwa2cpKTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gQXJyYXkuZnJvbShwYWNrYWdlcyk7XG59XG5cbi8qKlxuICogTm9ybWFsaXplIHBhY2thZ2UgbmFtZSB0byByZWdpc3RyeS1jaGVja2FibGUgZm9ybS5cbiAqIEhhbmRsZXMgc2NvcGVkIHBhY2thZ2VzIChAb3JnL3BrZykgYW5kIHN1YnBhdGhzIChwa2cvc3VicGF0aCBcdTIxOTIgcGtnKS5cbiAqL1xuZnVuY3Rpb24gbm9ybWFsaXplUGFja2FnZU5hbWUocmF3OiBzdHJpbmcpOiBzdHJpbmcge1xuICAvLyBTY29wZWQgcGFja2FnZTogQG9yZy9wa2cgb3IgQG9yZy9wa2cvc3VicGF0aFxuICBpZiAocmF3LnN0YXJ0c1dpdGgoXCJAXCIpKSB7XG4gICAgY29uc3QgcGFydHMgPSByYXcuc3BsaXQoXCIvXCIpO1xuICAgIHJldHVybiBwYXJ0cy5sZW5ndGggPj0gMiA/IGAke3BhcnRzWzBdfS8ke3BhcnRzWzFdfWAgOiByYXc7XG4gIH1cbiAgLy8gUmVndWxhciBwYWNrYWdlOiBwa2cgb3IgcGtnL3N1YnBhdGhcbiAgcmV0dXJuIHJhdy5zcGxpdChcIi9cIilbMF07XG59XG5cbi8qKlxuICogQ2hlY2sgaWYgYSBwYWNrYWdlIGV4aXN0cyBvbiBucG0gcmVnaXN0cnkuXG4gKiBSZXR1cm5zIG51bGwgb24gc3VjY2VzcywgZXJyb3IgbWVzc2FnZSBvbiBmYWlsdXJlLlxuICogVGltZXMgb3V0IGFmdGVyIHRpbWVvdXRNcyAoZGVmYXVsdCA1MDAwbXMpLlxuICovXG5hc3luYyBmdW5jdGlvbiBjaGVja1BhY2thZ2VPbk5wbShcbiAgcGFja2FnZU5hbWU6IHN0cmluZyxcbiAgdGltZW91dE1zID0gNTAwMFxuKTogUHJvbWlzZTx7IGV4aXN0czogYm9vbGVhbjsgZXJyb3I/OiBzdHJpbmcgfT4ge1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcbiAgICBjb25zdCBjaGlsZCA9IHNwYXduKE5QTV9DT01NQU5ELCBbXCJ2aWV3XCIsIHBhY2thZ2VOYW1lLCBcIm5hbWVcIl0sIHtcbiAgICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwicGlwZVwiXSxcbiAgICAgIHRpbWVvdXQ6IHRpbWVvdXRNcyxcbiAgICAgIHNoZWxsOiBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIsXG4gICAgfSk7XG5cbiAgICBsZXQgc3Rkb3V0ID0gXCJcIjtcbiAgICBsZXQgc3RkZXJyID0gXCJcIjtcblxuICAgIGNoaWxkLnN0ZG91dC5vbihcImRhdGFcIiwgKGRhdGE6IEJ1ZmZlcikgPT4ge1xuICAgICAgc3Rkb3V0ICs9IGRhdGEudG9TdHJpbmcoKTtcbiAgICB9KTtcbiAgICBjaGlsZC5zdGRlcnIub24oXCJkYXRhXCIsIChkYXRhOiBCdWZmZXIpID0+IHtcbiAgICAgIHN0ZGVyciArPSBkYXRhLnRvU3RyaW5nKCk7XG4gICAgfSk7XG5cbiAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgY2hpbGQua2lsbChcIlNJR1RFUk1cIik7XG4gICAgICByZXNvbHZlKHsgZXhpc3RzOiBmYWxzZSwgZXJyb3I6IGBUaW1lb3V0IGFmdGVyICR7dGltZW91dE1zfW1zYCB9KTtcbiAgICB9LCB0aW1lb3V0TXMpO1xuXG4gICAgY2hpbGQub24oXCJjbG9zZVwiLCAoY29kZSkgPT4ge1xuICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgIGlmIChjb2RlID09PSAwICYmIHN0ZG91dC50cmltKCkpIHtcbiAgICAgICAgcmVzb2x2ZSh7IGV4aXN0czogdHJ1ZSB9KTtcbiAgICAgIH0gZWxzZSBpZiAoc3RkZXJyLmluY2x1ZGVzKFwiNDA0XCIpIHx8IHN0ZGVyci5pbmNsdWRlcyhcIm5vdCBmb3VuZFwiKSkge1xuICAgICAgICByZXNvbHZlKHsgZXhpc3RzOiBmYWxzZSwgZXJyb3I6IGBQYWNrYWdlIG5vdCBmb3VuZDogJHtwYWNrYWdlTmFtZX1gIH0pO1xuICAgICAgfSBlbHNlIGlmIChjb2RlICE9PSAwKSB7XG4gICAgICAgIC8vIE5ldHdvcmsgZXJyb3Igb3Igb3RoZXIgaXNzdWUgXHUyMDE0IHdhcm4sIGRvbid0IGZhaWxcbiAgICAgICAgcmVzb2x2ZSh7IGV4aXN0czogdHJ1ZSwgZXJyb3I6IGBucG0gdmlldyBmYWlsZWQgKGNvZGUgJHtjb2RlfSk6ICR7c3RkZXJyLnNsaWNlKDAsIDEwMCl9YCB9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJlc29sdmUoeyBleGlzdHM6IHRydWUgfSk7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBjaGlsZC5vbihcImVycm9yXCIsIChlcnIpID0+IHtcbiAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICByZXNvbHZlKHsgZXhpc3RzOiB0cnVlLCBlcnJvcjogYG5wbSBzcGF3biBlcnJvcjogJHtlcnIubWVzc2FnZX1gIH0pO1xuICAgIH0pO1xuICB9KTtcbn1cblxuLyoqXG4gKiBDaGVjayBhbGwgcGFja2FnZSByZWZlcmVuY2VzIGluIHRhc2tzIGZvciBleGlzdGVuY2Ugb24gbnBtLlxuICogUnVucyBjaGVja3MgaW4gcGFyYWxsZWwgd2l0aCBhIDVzIHRpbWVvdXQgcGVyIHBhY2thZ2UuXG4gKiBOZXR3b3JrIGZhaWx1cmVzIHdhcm4gYnV0IGRvbid0IGZhaWwgKFIwMTIgY29uc2VydmF0aXZlIGRlc2lnbikuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjaGVja1BhY2thZ2VFeGlzdGVuY2UoXG4gIHRhc2tzOiBUYXNrUm93W10sXG4gIF9iYXNlUGF0aDogc3RyaW5nXG4pOiBQcm9taXNlPFByZUV4ZWN1dGlvbkNoZWNrSlNPTltdPiB7XG4gIGNvbnN0IHJlc3VsdHM6IFByZUV4ZWN1dGlvbkNoZWNrSlNPTltdID0gW107XG4gIGNvbnN0IHBhY2thZ2VzVG9DaGVjayA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4gIC8vIENvbGxlY3QgYWxsIHBhY2thZ2UgcmVmZXJlbmNlcyBmcm9tIHRhc2sgZGVzY3JpcHRpb25zXG4gIGZvciAoY29uc3QgdGFzayBvZiB0YXNrcykge1xuICAgIGNvbnN0IHBhY2thZ2VzID0gZXh0cmFjdFBhY2thZ2VSZWZlcmVuY2VzKHRhc2suZGVzY3JpcHRpb24pO1xuICAgIGZvciAoY29uc3QgcGtnIG9mIHBhY2thZ2VzKSB7XG4gICAgICBwYWNrYWdlc1RvQ2hlY2suYWRkKHBrZyk7XG4gICAgfVxuICB9XG5cbiAgaWYgKHBhY2thZ2VzVG9DaGVjay5zaXplID09PSAwKSB7XG4gICAgcmV0dXJuIHJlc3VsdHM7XG4gIH1cblxuICAvLyBDaGVjayBwYWNrYWdlcyBpbiBwYXJhbGxlbFxuICBjb25zdCBjaGVja1Byb21pc2VzID0gQXJyYXkuZnJvbShwYWNrYWdlc1RvQ2hlY2spLm1hcChhc3luYyAocGtnKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY2hlY2tQYWNrYWdlT25OcG0ocGtnKTtcbiAgICByZXR1cm4geyBwa2csIHJlc3VsdCB9O1xuICB9KTtcblxuICBjb25zdCBjaGVja1Jlc3VsdHMgPSBhd2FpdCBQcm9taXNlLmFsbChjaGVja1Byb21pc2VzKTtcblxuICBmb3IgKGNvbnN0IHsgcGtnLCByZXN1bHQgfSBvZiBjaGVja1Jlc3VsdHMpIHtcbiAgICBpZiAoIXJlc3VsdC5leGlzdHMgJiYgIXJlc3VsdC5lcnJvcj8uaW5jbHVkZXMoXCJUaW1lb3V0XCIpICYmICFyZXN1bHQuZXJyb3I/LmluY2x1ZGVzKFwic3Bhd24gZXJyb3JcIikpIHtcbiAgICAgIC8vIFBhY2thZ2UgZ2VudWluZWx5IGRvZXNuJ3QgZXhpc3QgXHUyMDE0IGJsb2NraW5nIGZhaWx1cmVcbiAgICAgIHJlc3VsdHMucHVzaCh7XG4gICAgICAgIGNhdGVnb3J5OiBcInBhY2thZ2VcIixcbiAgICAgICAgdGFyZ2V0OiBwa2csXG4gICAgICAgIHBhc3NlZDogZmFsc2UsXG4gICAgICAgIG1lc3NhZ2U6IHJlc3VsdC5lcnJvciB8fCBgUGFja2FnZSAnJHtwa2d9JyBub3QgZm91bmQgb24gbnBtYCxcbiAgICAgICAgYmxvY2tpbmc6IHRydWUsXG4gICAgICB9KTtcbiAgICB9IGVsc2UgaWYgKHJlc3VsdC5lcnJvcikge1xuICAgICAgLy8gTmV0d29yayBpc3N1ZSBvciB0aW1lb3V0IFx1MjAxNCB3YXJuIGJ1dCBkb24ndCBibG9ja1xuICAgICAgcmVzdWx0cy5wdXNoKHtcbiAgICAgICAgY2F0ZWdvcnk6IFwicGFja2FnZVwiLFxuICAgICAgICB0YXJnZXQ6IHBrZyxcbiAgICAgICAgcGFzc2VkOiB0cnVlLFxuICAgICAgICBtZXNzYWdlOiBgV2FybmluZzogJHtyZXN1bHQuZXJyb3J9YCxcbiAgICAgICAgYmxvY2tpbmc6IGZhbHNlLFxuICAgICAgfSk7XG4gICAgfVxuICAgIC8vIFNpbGVudCBzdWNjZXNzIGZvciBleGlzdGluZyBwYWNrYWdlcyBcdTIwMTQgbm8gbmVlZCB0byByZXBvcnRcbiAgfVxuXG4gIHJldHVybiByZXN1bHRzO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRmlsZSBQYXRoIENvbnNpc3RlbmN5IENoZWNrIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIE5vcm1hbGl6ZSBhIGZpbGUgcGF0aCBmb3IgY29uc2lzdGVudCBjb21wYXJpc29uLlxuICogLSBTdHJpcHMgbGVhZGluZyAuL1xuICogLSBOb3JtYWxpemVzIHBhdGggc2VwYXJhdG9ycyB0byBmb3J3YXJkIHNsYXNoZXNcbiAqIC0gUmVzb2x2ZXMgcmVkdW5kYW50IHNlZ21lbnRzIChlLmcuLCBmb28vLi4vYmFyIFx1MjE5MiBiYXIpXG4gKiBcbiAqIFRoaXMgZW5zdXJlcyB0aGF0IFwiLi9zcmMvYS50c1wiLCBcInNyYy9hLnRzXCIsIGFuZCBcInNyYy8vYS50c1wiIGFsbCBjb21wYXJlIGVxdWFsLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplRmlsZVBhdGgoZmlsZVBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmICghZmlsZVBhdGgpIHJldHVybiBmaWxlUGF0aDtcblxuICBsZXQgbm9ybWFsaXplZCA9IGV4dHJhY3RQYXRoRnJvbUFubm90YXRpb24oZmlsZVBhdGgpO1xuXG4gIC8vIE5vcm1hbGl6ZSBwYXRoIHNlcGFyYXRvcnMgdG8gZm9yd2FyZCBzbGFzaGVzXG4gIG5vcm1hbGl6ZWQgPSBub3JtYWxpemVkLnJlcGxhY2UoL1xcXFwvZywgXCIvXCIpO1xuXG4gIC8vIEV4cGFuZCBhIGxlYWRpbmcgfiBvciB+LyBzbyBkb3duc3RyZWFtIHJlc29sdmUoKS9zZXQgbG9va3VwcyBoaXQgdGhlIHJlYWxcbiAgLy8gaG9tZSBkaXJlY3RvcnkgaW5zdGVhZCBvZiB0cmVhdGluZyB0aGUgdGlsZGUgYXMgYSBsaXRlcmFsIHBhdGggc2VnbWVudC5cbiAgaWYgKG5vcm1hbGl6ZWQgPT09IFwiflwiKSB7XG4gICAgbm9ybWFsaXplZCA9IGhvbWVkaXIoKTtcbiAgfSBlbHNlIGlmIChub3JtYWxpemVkLnN0YXJ0c1dpdGgoXCJ+L1wiKSkge1xuICAgIG5vcm1hbGl6ZWQgPSByZXNvbHZlKGhvbWVkaXIoKSwgbm9ybWFsaXplZC5zbGljZSgyKSk7XG4gIH1cbiAgLy8gaG9tZWRpcigpL3Jlc29sdmUoKSBjYW4gZW1pdCBwbGF0Zm9ybSBzZXBhcmF0b3JzIChlLmcuIFwiXFxcIiBvbiBXaW5kb3dzKS5cbiAgbm9ybWFsaXplZCA9IG5vcm1hbGl6ZWQucmVwbGFjZSgvXFxcXC9nLCBcIi9cIik7XG5cbiAgLy8gUmVtb3ZlIGxlYWRpbmcgLi9cbiAgd2hpbGUgKG5vcm1hbGl6ZWQuc3RhcnRzV2l0aChcIi4vXCIpKSB7XG4gICAgbm9ybWFsaXplZCA9IG5vcm1hbGl6ZWQuc2xpY2UoMik7XG4gIH1cblxuICAvLyBSZW1vdmUgZHVwbGljYXRlIHNsYXNoZXNcbiAgbm9ybWFsaXplZCA9IG5vcm1hbGl6ZWQucmVwbGFjZSgvXFwvKy9nLCBcIi9cIik7XG5cbiAgLy8gUmVtb3ZlIHRyYWlsaW5nIHNsYXNoIHVubGVzcyBpdCdzIHRoZSByb290XG4gIGlmIChub3JtYWxpemVkLmxlbmd0aCA+IDEgJiYgbm9ybWFsaXplZC5lbmRzV2l0aChcIi9cIikpIHtcbiAgICBub3JtYWxpemVkID0gbm9ybWFsaXplZC5zbGljZSgwLCAtMSk7XG4gIH1cblxuICByZXR1cm4gbm9ybWFsaXplZDtcbn1cblxuLyoqXG4gKiBQbGFubmluZyB1bml0cyBzb21ldGltZXMgcGFzcyBhIGRpcmVjdG9yeSByZWZlcmVuY2UgYXMgdGFzay5pbnB1dHNcbiAqIChlLmcuIGBhcnRpZmFjdHMvTTAwOS1TMDMvYCkuIFRoZSB0cmFpbGluZyBzbGFzaCBpcyBtZWFuaW5nZnVsIFx1MjAxNCB0aGUgdGFza1xuICogcmVhZHMgd2hhdGV2ZXIgbGFuZHMgaW5zaWRlIFx1MjAxNCBidXQgbm9ybWFsaXplRmlsZVBhdGggc3RyaXBzIGl0LCBzbyBjYWxsIHRoaXNcbiAqIGhlbHBlciBhZ2FpbnN0IHRoZSByYXcgaW5wdXQgYmVmb3JlIG5vcm1hbGl6YXRpb24uXG4gKi9cbmZ1bmN0aW9uIGlzRGlyZWN0b3J5UmVmZXJlbmNlKHJhdzogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IGNhbmRpZGF0ZSA9IGV4dHJhY3RQYXRoRnJvbUFubm90YXRpb24ocmF3LnRyaW0oKSk7XG4gIGlmICghY2FuZGlkYXRlKSByZXR1cm4gZmFsc2U7XG4gIGlmIChjb250YWluc0dsb2JQYXR0ZXJuKGNhbmRpZGF0ZSkpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIGNhbmRpZGF0ZS5lbmRzV2l0aChcIi9cIik7XG59XG5cbi8qKlxuICogVHJ1ZSB3aGVuIGFueSBvZiBga25vd25PdXRwdXRzYCBsaXZlcyB1bmRlciBgbm9ybWFsaXplZERpcmAgKGkuZS4gdGhlIHRhc2tcbiAqIGRpcmVjdG9yeSBpbnB1dCBpcyB0aGUgcGFyZW50IG9mIHNvbWV0aGluZyBhIHByaW9yL3NhbWUgdGFzayBwcm9kdWNlcykuXG4gKi9cbmZ1bmN0aW9uIGFueU91dHB1dFVuZGVyRGlyZWN0b3J5KFxuICBub3JtYWxpemVkRGlyOiBzdHJpbmcsXG4gIGtub3duT3V0cHV0czogSXRlcmFibGU8c3RyaW5nPixcbik6IGJvb2xlYW4ge1xuICBjb25zdCBwcmVmaXggPSBub3JtYWxpemVkRGlyICsgXCIvXCI7XG4gIGZvciAoY29uc3Qgb3V0cHV0IG9mIGtub3duT3V0cHV0cykge1xuICAgIGlmIChvdXRwdXQgPT09IG5vcm1hbGl6ZWREaXIpIHJldHVybiB0cnVlO1xuICAgIGlmIChvdXRwdXQuc3RhcnRzV2l0aChwcmVmaXgpKSByZXR1cm4gdHJ1ZTtcbiAgfVxuICByZXR1cm4gZmFsc2U7XG59XG5cbmNvbnN0IFVSTF9TQ0hFTUVfUEFUVEVSTiA9IC9eKGh0dHBzP3xmdHB8ZmlsZXxzc2h8Z2l0KTpcXC9cXC8vaTtcbmNvbnN0IFNDUF9QQVRURVJOID0gL15bXFx3Li1dK0BbXFx3Li1dKzpbXi9dLztcblxuZnVuY3Rpb24gbG9va3NMaWtlUGF0aE9yVXJsKHRva2VuOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgaWYgKFVSTF9TQ0hFTUVfUEFUVEVSTi50ZXN0KHRva2VuKSkgcmV0dXJuIHRydWU7XG4gIGlmIChTQ1BfUEFUVEVSTi50ZXN0KHRva2VuKSkgcmV0dXJuIHRydWU7XG4gIGlmICgvXlsuL35dLy50ZXN0KHRva2VuKSkgcmV0dXJuIHRydWU7XG4gIGlmICgvW1xcXFwvXS8udGVzdCh0b2tlbikpIHJldHVybiB0cnVlO1xuICBpZiAoL1xcLltBLVphLXowLTldezEsOH0kLy50ZXN0KHRva2VuKSkgcmV0dXJuIHRydWU7XG4gIHJldHVybiBmYWxzZTtcbn1cblxuZnVuY3Rpb24gZXh0cmFjdFBhdGhGcm9tQW5ub3RhdGlvbihyYXc6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHRyaW1tZWQgPSByYXcudHJpbSgpO1xuICBpZiAoIXRyaW1tZWQpIHJldHVybiB0cmltbWVkO1xuXG4gIGNvbnN0IGJhY2t0aWNrTWF0Y2ggPSB0cmltbWVkLm1hdGNoKC9eKGArKShbXmBdKylcXDEoPzooPzpcXHMrW1x1MjAxNFx1MjAxMy1dXFxzKy4rKXwoPzpcXHMrXFwoW14oKV0rXFwpKSk/JC8pO1xuICBpZiAoYmFja3RpY2tNYXRjaCkge1xuICAgIHJldHVybiBiYWNrdGlja01hdGNoWzJdLnRyaW0oKTtcbiAgfVxuXG4gIC8vIFN0cmlwIGxlYWRpbmcvdHJhaWxpbmcgZG91YmxlIG9yIHNpbmdsZSBxdW90ZXMgd3JhcHBpbmcgdGhlIHdob2xlIHZhbHVlLlxuICAvLyBQbGFuIGRvY3VtZW50cyBzb21ldGltZXMgZW1pdCBgXCJzcmMvZm9vLnRzXCJgIG9yIGAnc3JjL2Jhci50cydgIGFzIGlucHV0XG4gIC8vIGFubm90YXRpb25zLiBTdHJpcHBpbmcgdGhlIHdyYXBwZXIgYWxsb3dzIHRoZSBpbm5lciBwYXRoIHRvIGJlIGNoZWNrZWRcbiAgLy8gY29ycmVjdGx5IGluc3RlYWQgb2YgcHJvZHVjaW5nIGEgZmFsc2UtcG9zaXRpdmUgXCJmaWxlIG5vdCBmb3VuZFwiIGVycm9yXG4gIC8vIGZvciBhIGxpdGVyYWwgc3RyaW5nIHdpdGggcXVvdGUgY2hhcmFjdGVycyBpbiBpdCAoIzM3NDcpLlxuICBjb25zdCBxdW90ZU1hdGNoID0gdHJpbW1lZC5tYXRjaCgvXihbXCInXSkoW15cIiddKylcXDEkLyk7XG4gIGlmIChxdW90ZU1hdGNoKSB7XG4gICAgcmV0dXJuIHF1b3RlTWF0Y2hbMl0udHJpbSgpO1xuICB9XG5cbiAgY29uc3QgYW5ub3RhdGVkTWF0Y2ggPSB0cmltbWVkLm1hdGNoKC9eKC4rPylcXHMrW1x1MjAxNFx1MjAxMy1dXFxzKy4rJC8pO1xuICBpZiAoYW5ub3RhdGVkTWF0Y2gpIHtcbiAgICBjb25zdCBwcmVmaXggPSBhbm5vdGF0ZWRNYXRjaFsxXS50cmltKCk7XG4gICAgY29uc3QgcHJlZml4QmFja3RpY2tNYXRjaCA9IHByZWZpeC5tYXRjaCgvYChbXmBdKylgLyk7XG4gICAgaWYgKHByZWZpeEJhY2t0aWNrTWF0Y2ggJiYgbG9va3NMaWtlUGF0aE9yVXJsKHByZWZpeEJhY2t0aWNrTWF0Y2hbMV0udHJpbSgpKSkge1xuICAgICAgcmV0dXJuIHByZWZpeEJhY2t0aWNrTWF0Y2hbMV0udHJpbSgpO1xuICAgIH1cbiAgICByZXR1cm4gcHJlZml4LnJlcGxhY2UoL2AvZywgXCJcIikudHJpbSgpO1xuICB9XG5cbiAgLy8gRmFsbGJhY2s6IHNjYW4gYWxsIGJhY2t0aWNrZWQgdG9rZW5zIGFuZCByZXR1cm4gdGhlIGZpcnN0IG9uZSB0aGF0IGxvb2tzXG4gIC8vIGxpa2UgYSBwYXRoIG9yIFVSTC4gSGFuZGxlcyBwcm9zZS1hbm5vdGF0ZWQgYnVsbGV0cyBzdWNoIGFzOlxuICAvLyAgIGBwYXRoL2AgZGlyZWN0b3J5IGxpc3RpbmcgKC4uLilcbiAgLy8gICBQcmVmaXggcHJvc2UgYGh0dHBzOi8vLi4uYCBzdWZmaXggcHJvc2VcbiAgLy8gICBDaXRpbmcgYC5nc2QvUkVRVUlSRU1FTlRTLm1kYCBtaWQtc2VudGVuY2VcbiAgLy8gU2tpcHMgbm9uLXBhdGggYmFja3RpY2tlZCB0b2tlbnMgbGlrZSBgbm90ZWAgb3IgYG5wbSB0ZXN0YC5cbiAgY29uc3QgYmFja3RpY2tUb2tlbnMgPSB0cmltbWVkLm1hdGNoQWxsKC9gKFteYF0rKWAvZyk7XG4gIGZvciAoY29uc3QgbWF0Y2ggb2YgYmFja3RpY2tUb2tlbnMpIHtcbiAgICBjb25zdCB0b2tlbiA9IG1hdGNoWzFdLnRyaW0oKTtcbiAgICBpZiAobG9va3NMaWtlUGF0aE9yVXJsKHRva2VuKSkge1xuICAgICAgcmV0dXJuIHRva2VuO1xuICAgIH1cbiAgfVxuXG4gIC8vIEZhbGwgYmFjayB0byB0aGUgb3JpZ2luYWwgYmVoYXZpb3IgZm9yIGFscmVhZHktcGxhaW4gcGF0aHMuXG4gIHJldHVybiB0cmltbWVkLnJlcGxhY2UoL2AvZywgXCJcIik7XG59XG5cbi8qKlxuICogUGxhbm5pbmcgdW5pdHMgc29tZXRpbWVzIHVzZSB0YXNrLmlucHV0cyBmb3IgcHJvc2UgbGlrZSBcIkN1cnJlbnQgZW51bSBzaGFwZVwiXG4gKiBpbnN0ZWFkIG9mIGNvbmNyZXRlIGZpbGUgcGF0aHMuIFRob3NlIGVudHJpZXMgc2hvdWxkIG5vdCBmYWlsIHBhdGggY2hlY2tzLlxuICogS2VlcCB2YWxpZGF0aW9uIGZvciBhbnl0aGluZyB0aGF0IHN0aWxsIGxvb2tzIGxpa2UgYSByZWFsIGZpbGUgcmVmZXJlbmNlOlxuICogZXhwbGljaXQgYmFja3RpY2tzLCBnbG9icywgc2VwYXJhdG9ycywgZG90LXBhdGhzLCBvciBzaW5nbGUtdG9rZW4gYmFzZW5hbWVzXG4gKiBsaWtlIERvY2tlcmZpbGUuXG4gKi9cbmZ1bmN0aW9uIHNob3VsZFZhbGlkYXRlSW5wdXRBc1BhdGgocmF3OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgdHJpbW1lZCA9IHJhdy50cmltKCk7XG4gIGlmICghdHJpbW1lZCkgcmV0dXJuIGZhbHNlO1xuXG4gIGlmIChpc1J1bnRpbWVPbmx5SW5wdXQodHJpbW1lZCkpIHJldHVybiBmYWxzZTtcblxuICBjb25zdCBjYW5kaWRhdGUgPSBleHRyYWN0UGF0aEZyb21Bbm5vdGF0aW9uKHRyaW1tZWQpO1xuICBpZiAoIWNhbmRpZGF0ZSkgcmV0dXJuIGZhbHNlO1xuXG4gIC8vIFVSTHMgYW5kIHJlbW90ZSByZXBvIHJlZnMgYXJlIG5vdCBmaWxlc3lzdGVtIHBhdGhzLlxuICBpZiAoVVJMX1NDSEVNRV9QQVRURVJOLnRlc3QoY2FuZGlkYXRlKSkgcmV0dXJuIGZhbHNlO1xuICBpZiAoU0NQX1BBVFRFUk4udGVzdChjYW5kaWRhdGUpKSByZXR1cm4gZmFsc2U7XG5cbiAgaWYgKC9eYCtbXmBdK2ArLy50ZXN0KHRyaW1tZWQpKSB7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICBpZiAoIS9cXHMvLnRlc3QoY2FuZGlkYXRlKSkge1xuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgcmV0dXJuIChcbiAgICBjYW5kaWRhdGUuc3RhcnRzV2l0aChcIi9cIikgfHxcbiAgICBjYW5kaWRhdGUuc3RhcnRzV2l0aChcIi4vXCIpIHx8XG4gICAgY2FuZGlkYXRlLnN0YXJ0c1dpdGgoXCIuLi9cIikgfHxcbiAgICBjYW5kaWRhdGUuc3RhcnRzV2l0aChcIn4vXCIpIHx8XG4gICAgL1tcXFxcL10vLnRlc3QoY2FuZGlkYXRlKSB8fFxuICAgIC9bKj9bXFxde31dLy50ZXN0KGNhbmRpZGF0ZSlcbiAgKTtcbn1cblxuZnVuY3Rpb24gaXNSdW50aW1lT25seUlucHV0KHJhdzogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiAvXFwoXFxzKnJ1bnRpbWVcXHMqXFwpL2kudGVzdChyYXcpO1xufVxuXG5mdW5jdGlvbiBjb250YWluc0dsb2JQYXR0ZXJuKGNhbmRpZGF0ZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBbXCIqXCIsIFwiP1wiLCBcIltcIiwgXCJdXCIsIFwie1wiLCBcIn1cIl0uc29tZSgoY2hhcikgPT4gY2FuZGlkYXRlLmluY2x1ZGVzKGNoYXIpKTtcbn1cblxuLyoqXG4gKiBCdWlsZCBhIHNldCBvZiBmaWxlcyB0aGF0IHdpbGwgYmUgY3JlYXRlZCBieSB0YXNrcyB1cCB0byAoYnV0IG5vdCBpbmNsdWRpbmcpIHRhc2tJbmRleC5cbiAqIEFsc28gaW5jbHVkZXMgb3V0cHV0cyBvZiBjb21wbGV0ZWQgdGFza3MgYXQgYW55IHBvc2l0aW9uIFx1MjAxNCBhIGNvbXBsZXRlZCB0YXNrIGhhcyBhbHJlYWR5XG4gKiBydW4gYW5kIGl0cyBvdXRwdXRzIGFyZSBhdmFpbGFibGUgcmVnYXJkbGVzcyBvZiBzZXF1ZW5jZSBwb3NpdGlvbiBvciBkaXNrIHN0YXRlICgjNDA3MSkuXG4gKiBBbGwgcGF0aHMgYXJlIG5vcm1hbGl6ZWQgZm9yIGNvbnNpc3RlbnQgY29tcGFyaXNvbi5cbiAqL1xuZnVuY3Rpb24gZ2V0RXhwZWN0ZWRPdXRwdXRzVXBUbyh0YXNrczogVGFza1Jvd1tdLCB0YXNrSW5kZXg6IG51bWJlcik6IFNldDxzdHJpbmc+IHtcbiAgY29uc3Qgb3V0cHV0cyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IHRhc2tzLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgdGFzayA9IHRhc2tzW2ldO1xuICAgIC8vIEluY2x1ZGUgcHJpb3IgdGFza3MgKGkgPCB0YXNrSW5kZXgpIE9SIGNvbXBsZXRlZCB0YXNrcyBhdCBhbnkgcG9zaXRpb25cbiAgICBpZiAoaSA8IHRhc2tJbmRleCB8fCB0YXNrLnN0YXR1cyA9PT0gXCJjb21wbGV0ZWRcIikge1xuICAgICAgZm9yIChjb25zdCBmaWxlIG9mIHRhc2suZXhwZWN0ZWRfb3V0cHV0KSB7XG4gICAgICAgIG91dHB1dHMuYWRkKG5vcm1hbGl6ZUZpbGVQYXRoKGZpbGUpKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgcmV0dXJuIG91dHB1dHM7XG59XG5cbi8qKlxuICogQ2hlY2sgdGhhdCBhbGwgZmlsZXMgcmVmZXJlbmNlZCBpbiB0YXNrLmlucHV0cyBlaXRoZXI6XG4gKiAgIDEuIEV4aXN0IG9uIGRpc2ssIE9SXG4gKiAgIDIuIEFyZSBpbiBhIHByaW9yIHRhc2sncyBleHBlY3RlZF9vdXRwdXQsIE9SXG4gKiAgIDMuIEFyZSBpbiB0aGUgY3VycmVudCB0YXNrJ3Mgb3duIGV4cGVjdGVkX291dHB1dCBcdTIwMTQgdGhlIHRhc2sgcHJvZHVjZXMgdGhlbSxcbiAqICAgICAgc28gdGhleSBkb24ndCBuZWVkIHRvIHByZS1leGlzdCAoIzQ0NTksIG1pcnJvcmluZyB0aGUgZXhlbXB0aW9uICMzNjI2XG4gKiAgICAgIGludHJvZHVjZWQgZm9yIHRhc2suZmlsZXMpLlxuICpcbiAqIHRhc2suZmlsZXMgKFwiZmlsZXMgbGlrZWx5IHRvdWNoZWRcIikgaXMgZXhjbHVkZWQgZW50aXJlbHkgZnJvbSB0aGlzIGNoZWNrIFx1MjAxNFxuICogaXQgaW50ZW50aW9uYWxseSBpbmNsdWRlcyBmaWxlcyB0aGUgdGFzayB3aWxsIGNyZWF0ZSAoIzM2MjYpLlxuICpcbiAqIEFsbCBwYXRocyBhcmUgbm9ybWFsaXplZCBiZWZvcmUgY29tcGFyaXNvbiB0byBlbnN1cmUgLi9zcmMvYS50cyBtYXRjaGVzIHNyYy9hLnRzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY2hlY2tGaWxlUGF0aENvbnNpc3RlbmN5KFxuICB0YXNrczogVGFza1Jvd1tdLFxuICBiYXNlUGF0aDogc3RyaW5nXG4pOiBQcmVFeGVjdXRpb25DaGVja0pTT05bXSB7XG4gIGNvbnN0IHJlc3VsdHM6IFByZUV4ZWN1dGlvbkNoZWNrSlNPTltdID0gW107XG5cbiAgLy8gQnVpbGQgYSBzZXQgb2YgYWxsIGZpbGVzIGNyZWF0ZWQgYnkgYW55IHRhc2sgYXQgYW55IHBvc2l0aW9uIChub3JtYWxpemVkKS5cbiAgLy8gVXNlZCB0byBzdXBwcmVzcyBjb25zaXN0ZW5jeSBlcnJvcnMgZm9yIGZpbGVzIHRoYXQgd2lsbCBiZSBjYXVnaHQgd2l0aCBhXG4gIC8vIG1vcmUgcHJlY2lzZSBtZXNzYWdlIGJ5IGNoZWNrVGFza09yZGVyaW5nIChzZXF1ZW5jZSB2aW9sYXRpb24pLlxuICBjb25zdCBhbGxUYXNrT3V0cHV0cyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IHQgb2YgdGFza3MpIHtcbiAgICBmb3IgKGNvbnN0IGYgb2YgdC5leHBlY3RlZF9vdXRwdXQpIHtcbiAgICAgIGFsbFRhc2tPdXRwdXRzLmFkZChub3JtYWxpemVGaWxlUGF0aChmKSk7XG4gICAgfVxuICB9XG5cbiAgZm9yIChsZXQgaSA9IDA7IGkgPCB0YXNrcy5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IHRhc2sgPSB0YXNrc1tpXTtcbiAgICBjb25zdCBwcmlvck91dHB1dHMgPSBnZXRFeHBlY3RlZE91dHB1dHNVcFRvKHRhc2tzLCBpKTtcbiAgICBjb25zdCBvd25PdXRwdXRzID0gbmV3IFNldDxzdHJpbmc+KHRhc2suZXhwZWN0ZWRfb3V0cHV0Lm1hcChub3JtYWxpemVGaWxlUGF0aCkpO1xuICAgIGNvbnN0IGZpbGVzVG9DaGVjayA9IFsuLi50YXNrLmlucHV0c107XG5cbiAgICBmb3IgKGNvbnN0IGZpbGUgb2YgZmlsZXNUb0NoZWNrKSB7XG4gICAgICAvLyBTa2lwIGVtcHR5IHN0cmluZ3NcbiAgICAgIGlmICghZmlsZS50cmltKCkpIGNvbnRpbnVlO1xuICAgICAgaWYgKCFzaG91bGRWYWxpZGF0ZUlucHV0QXNQYXRoKGZpbGUpKSBjb250aW51ZTtcblxuICAgICAgLy8gTm9ybWFsaXplIHBhdGggZm9yIGNvbnNpc3RlbnQgY29tcGFyaXNvblxuICAgICAgY29uc3Qgbm9ybWFsaXplZEZpbGUgPSBub3JtYWxpemVGaWxlUGF0aChmaWxlKTtcbiAgICAgIGlmIChjb250YWluc0dsb2JQYXR0ZXJuKG5vcm1hbGl6ZWRGaWxlKSkgY29udGludWU7XG5cbiAgICAgIC8vIENoZWNrIGlmIGZpbGUgZXhpc3RzIG9uIGRpc2tcbiAgICAgIGNvbnN0IGFic29sdXRlUGF0aCA9IHJlc29sdmUoYmFzZVBhdGgsIG5vcm1hbGl6ZWRGaWxlKTtcbiAgICAgIGNvbnN0IGV4aXN0c09uRGlzayA9IGV4aXN0c1N5bmMoYWJzb2x1dGVQYXRoKTtcblxuICAgICAgLy8gQ2hlY2sgaWYgZmlsZSBpcyBpbiBwcmlvciBleHBlY3RlZCBvdXRwdXRzIChwcmlvck91dHB1dHMgYWxyZWFkeSBub3JtYWxpemVkKVxuICAgICAgY29uc3QgaW5Qcmlvck91dHB1dHMgPSBwcmlvck91dHB1dHMuaGFzKG5vcm1hbGl6ZWRGaWxlKTtcbiAgICAgIGNvbnN0IGluT3duT3V0cHV0cyA9IG93bk91dHB1dHMuaGFzKG5vcm1hbGl6ZWRGaWxlKTtcblxuICAgICAgLy8gRGlyZWN0b3J5IGlucHV0cyBhcmUgc2F0aXNmaWVkIHdoZW4gc29tZXRoaW5nIHByb2R1Y2VzIGEgZmlsZSBiZW5lYXRoXG4gICAgICAvLyB0aGVtIFx1MjAxNCBlaXRoZXIgYSBwcmlvciB0YXNrIG9yIHRoZSBjdXJyZW50IHRhc2sgaXRzZWxmLlxuICAgICAgbGV0IGRpcmVjdG9yeVNhdGlzZmllZCA9IGZhbHNlO1xuICAgICAgaWYgKCFleGlzdHNPbkRpc2sgJiYgIWluUHJpb3JPdXRwdXRzICYmICFpbk93bk91dHB1dHMgJiYgaXNEaXJlY3RvcnlSZWZlcmVuY2UoZmlsZSkpIHtcbiAgICAgICAgZGlyZWN0b3J5U2F0aXNmaWVkID1cbiAgICAgICAgICBhbnlPdXRwdXRVbmRlckRpcmVjdG9yeShub3JtYWxpemVkRmlsZSwgcHJpb3JPdXRwdXRzKSB8fFxuICAgICAgICAgIGFueU91dHB1dFVuZGVyRGlyZWN0b3J5KG5vcm1hbGl6ZWRGaWxlLCBvd25PdXRwdXRzKTtcbiAgICAgIH1cblxuICAgICAgaWYgKCFleGlzdHNPbkRpc2sgJiYgIWluUHJpb3JPdXRwdXRzICYmICFpbk93bk91dHB1dHMgJiYgIWRpcmVjdG9yeVNhdGlzZmllZCkge1xuICAgICAgICAvLyBJZiBhIGxhdGVyIHRhc2sgY2xhaW1zIHRvIGNyZWF0ZSB0aGlzIGZpbGUsIHRoZSBvcmRlcmluZyBjaGVjayB3aWxsXG4gICAgICAgIC8vIGZpcmUgYSBtb3JlIHByZWNpc2UgXCJzZXF1ZW5jZSB2aW9sYXRpb25cIiBlcnJvciBmb3IgdGhlIHNhbWUgZmlsZS5cbiAgICAgICAgLy8gU3VwcHJlc3MgdGhlIGNvbnNpc3RlbmN5IGVycm9yIGhlcmUgdG8gYXZvaWQgZHVwbGljYXRlIG5vaXNlLlxuICAgICAgICBpZiAoYWxsVGFza091dHB1dHMuaGFzKG5vcm1hbGl6ZWRGaWxlKSAmJiAhb3duT3V0cHV0cy5oYXMobm9ybWFsaXplZEZpbGUpKSB7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgcmVzdWx0cy5wdXNoKHtcbiAgICAgICAgICBjYXRlZ29yeTogXCJmaWxlXCIsXG4gICAgICAgICAgdGFyZ2V0OiBmaWxlLFxuICAgICAgICAgIHBhc3NlZDogZmFsc2UsXG4gICAgICAgICAgbWVzc2FnZTogYFRhc2sgJHt0YXNrLmlkfSByZWZlcmVuY2VzICcke2ZpbGV9JyB3aGljaCBkb2Vzbid0IGV4aXN0IGFuZCBpc24ndCBjcmVhdGVkIGJ5IHByaW9yIG9yIHNhbWUtdGFzayBvdXRwdXRzYCxcbiAgICAgICAgICBibG9ja2luZzogdHJ1ZSxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHJlc3VsdHM7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUYXNrIE9yZGVyaW5nIENoZWNrIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIERldGVjdCBpbXBvc3NpYmxlIHRhc2sgb3JkZXJpbmc6IHRhc2sgTiByZWFkcyBhIGZpbGUgdGhhdCB0YXNrIE4rTSBjcmVhdGVzLlxuICogVGhpcyBpcyBhIGZhdGFsIGVycm9yIFx1MjAxNCB0aGUgcGxhbiBoYXMgYW4gaW1wb3NzaWJsZSBkZXBlbmRlbmN5LlxuICogXG4gKiBBbGwgcGF0aHMgYXJlIG5vcm1hbGl6ZWQgYmVmb3JlIGNvbXBhcmlzb24gdG8gZW5zdXJlIC4vc3JjL2EudHMgbWF0Y2hlcyBzcmMvYS50cy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNoZWNrVGFza09yZGVyaW5nKFxuICB0YXNrczogVGFza1Jvd1tdLFxuICBiYXNlUGF0aDogc3RyaW5nXG4pOiBQcmVFeGVjdXRpb25DaGVja0pTT05bXSB7XG4gIGNvbnN0IHJlc3VsdHM6IFByZUV4ZWN1dGlvbkNoZWNrSlNPTltdID0gW107XG5cbiAgLy8gQnVpbGQgbWFwOiBub3JtYWxpemVkIGZpbGUgXHUyMTkyIHRhc2sgaW5kZXggdGhhdCBjcmVhdGVzIGl0XG4gIGNvbnN0IGZpbGVDcmVhdG9ycyA9IG5ldyBNYXA8c3RyaW5nLCB7IHRhc2tJZDogc3RyaW5nOyBpbmRleDogbnVtYmVyOyBvcmlnaW5hbFBhdGg6IHN0cmluZzsgY29tcGxldGVkOiBib29sZWFuIH0+KCk7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgdGFza3MubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCB0YXNrID0gdGFza3NbaV07XG4gICAgZm9yIChjb25zdCBmaWxlIG9mIHRhc2suZXhwZWN0ZWRfb3V0cHV0KSB7XG4gICAgICBjb25zdCBub3JtYWxpemVkRmlsZSA9IG5vcm1hbGl6ZUZpbGVQYXRoKGZpbGUpO1xuICAgICAgY29uc3QgZXhpc3RpbmcgPSBmaWxlQ3JlYXRvcnMuZ2V0KG5vcm1hbGl6ZWRGaWxlKTtcbiAgICAgIGlmICghZXhpc3RpbmcgfHwgKCFleGlzdGluZy5jb21wbGV0ZWQgJiYgdGFzay5zdGF0dXMgPT09IFwiY29tcGxldGVkXCIpKSB7XG4gICAgICAgIGZpbGVDcmVhdG9ycy5zZXQobm9ybWFsaXplZEZpbGUsIHtcbiAgICAgICAgICB0YXNrSWQ6IHRhc2suaWQsXG4gICAgICAgICAgaW5kZXg6IGksXG4gICAgICAgICAgb3JpZ2luYWxQYXRoOiBmaWxlLFxuICAgICAgICAgIGNvbXBsZXRlZDogdGFzay5zdGF0dXMgPT09IFwiY29tcGxldGVkXCIsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8vIENoZWNrIGVhY2ggdGFzaydzIGlucHV0cyBhZ2FpbnN0IGZpbGUgY3JlYXRvcnMuXG4gIC8vIE9ubHkgY2hlY2sgdGFzay5pbnB1dHMgXHUyMDE0IHRhc2suZmlsZXMgKFwiZmlsZXMgbGlrZWx5IHRvdWNoZWRcIikgaW50ZW50aW9uYWxseVxuICAvLyBpbmNsdWRlcyBmaWxlcyB0aGUgdGFzayB3aWxsIGNyZWF0ZSwgc28gdGhleSBkb24ndCBpbmRpY2F0ZSByZWFkLWJlZm9yZS1jcmVhdGUgKCMzNjc3KS5cbiAgZm9yIChsZXQgaSA9IDA7IGkgPCB0YXNrcy5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IHRhc2sgPSB0YXNrc1tpXTtcbiAgICBjb25zdCBmaWxlc1RvQ2hlY2sgPSBbLi4udGFzay5pbnB1dHNdO1xuXG4gICAgZm9yIChjb25zdCBmaWxlIG9mIGZpbGVzVG9DaGVjaykge1xuICAgICAgaWYgKGlzUnVudGltZU9ubHlJbnB1dChmaWxlKSkgY29udGludWU7XG4gICAgICBpZiAoIXNob3VsZFZhbGlkYXRlSW5wdXRBc1BhdGgoZmlsZSkpIGNvbnRpbnVlO1xuXG4gICAgICBjb25zdCBub3JtYWxpemVkRmlsZSA9IG5vcm1hbGl6ZUZpbGVQYXRoKGZpbGUpO1xuICAgICAgaWYgKGNvbnRhaW5zR2xvYlBhdHRlcm4obm9ybWFsaXplZEZpbGUpKSBjb250aW51ZTtcbiAgICAgIC8vIEEgZGlyZWN0b3J5IHJlZmVyZW5jZSBsaWtlIGBhcnRpZmFjdHMvTTAwOS1TMDMvYCBpcyBuZXZlciBhIGNvbmNyZXRlXG4gICAgICAvLyByZWFkLWJlZm9yZS1jcmVhdGUgZGVwZW5kZW5jeTogdGhlIGZpbGVDcmVhdG9ycyBtYXAgaXMga2V5ZWQgYnkgbGVhZlxuICAgICAgLy8gZmlsZXMsIGFuZCBhIHNhbWUtdGFzayBvdXRwdXQgdW5kZXIgdGhlIGRpcmVjdG9yeSBzYXRpc2ZpZXMgaXQuXG4gICAgICBpZiAoaXNEaXJlY3RvcnlSZWZlcmVuY2UoZmlsZSkpIGNvbnRpbnVlO1xuICAgICAgY29uc3QgY3JlYXRvciA9IGZpbGVDcmVhdG9ycy5nZXQobm9ybWFsaXplZEZpbGUpO1xuICAgICAgY29uc3QgYWJzb2x1dGVQYXRoID0gcmVzb2x2ZShiYXNlUGF0aCwgbm9ybWFsaXplZEZpbGUpO1xuICAgICAgY29uc3QgZXhpc3RzT25EaXNrID0gZXhpc3RzU3luYyhhYnNvbHV0ZVBhdGgpO1xuICAgICAgLy8gU2tpcCBpZiB0aGUgY3JlYXRpbmcgdGFzayBoYXMgYWxyZWFkeSBjb21wbGV0ZWQgXHUyMDE0IGl0cyBvdXRwdXQgaXMgYXZhaWxhYmxlXG4gICAgICAvLyByZWdhcmRsZXNzIG9mIGRpc2sgc3RhdGUgKGUuZy4gZmlsZSB3YXMgYSB0ZW1wIGFydGlmYWN0IGNsZWFuZWQgdXAgYWZ0ZXJcbiAgICAgIC8vIHRoZSB0YXNrIHJhbiwgb3IgYSByZXBsYW4gaW50cm9kdWNlZCBhIG5ldyBlYXJsaWVyLXNlcXVlbmNlIHRhc2sgdGhhdFxuICAgICAgLy8gcmVhZHMgdGhpcyBwcmUtZXhlY3V0aW9uIG91dHB1dCkuICgjNDA3MSlcbiAgICAgIGlmIChjcmVhdG9yICYmIGNyZWF0b3IuaW5kZXggPiBpICYmICFleGlzdHNPbkRpc2sgJiYgIWNyZWF0b3IuY29tcGxldGVkKSB7XG4gICAgICAgIC8vIFRhc2sgcmVhZHMgZmlsZSB0aGF0IGlzIGNyZWF0ZWQgbGF0ZXIgXHUyMDE0IGltcG9zc2libGUgb3JkZXJpbmdcbiAgICAgICAgcmVzdWx0cy5wdXNoKHtcbiAgICAgICAgICBjYXRlZ29yeTogXCJmaWxlXCIsXG4gICAgICAgICAgdGFyZ2V0OiBmaWxlLFxuICAgICAgICAgIHBhc3NlZDogZmFsc2UsXG4gICAgICAgICAgbWVzc2FnZTogYFRhc2sgJHt0YXNrLmlkfSByZWFkcyAnJHtmaWxlfScgYnV0IGl0J3MgY3JlYXRlZCBieSB0YXNrICR7Y3JlYXRvci50YXNrSWR9IChzZXF1ZW5jZSB2aW9sYXRpb24pYCxcbiAgICAgICAgICBibG9ja2luZzogdHJ1ZSxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHJlc3VsdHM7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBJbnRlcmZhY2UgQ29udHJhY3QgQ2hlY2sgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmludGVyZmFjZSBGdW5jdGlvblNpZ25hdHVyZSB7XG4gIG5hbWU6IHN0cmluZztcbiAgcGFyYW1zOiBzdHJpbmc7XG4gIHJldHVyblR5cGU6IHN0cmluZztcbiAgdGFza0lkOiBzdHJpbmc7XG4gIHJhdzogc3RyaW5nO1xufVxuXG4vKipcbiAqIEV4dHJhY3QgZnVuY3Rpb24gc2lnbmF0dXJlcyBmcm9tIGNvZGUgYmxvY2tzIGluIHRhc2sgZGVzY3JpcHRpb24uXG4gKiBVc2VzIGhldXJpc3RpYyByZWdleCBcdTIwMTQgbm90IGFuIEFTVCBwYXJzZXIuXG4gKi9cbmZ1bmN0aW9uIGV4dHJhY3RGdW5jdGlvblNpZ25hdHVyZXMoZGVzY3JpcHRpb246IHN0cmluZywgdGFza0lkOiBzdHJpbmcpOiBGdW5jdGlvblNpZ25hdHVyZVtdIHtcbiAgY29uc3Qgc2lnbmF0dXJlczogRnVuY3Rpb25TaWduYXR1cmVbXSA9IFtdO1xuXG4gIC8vIE1hdGNoIGNvZGUgYmxvY2tzIChgYGAuLi5gYGApXG4gIGNvbnN0IGNvZGVCbG9ja1BhdHRlcm4gPSAvYGBgKD86dHlwZXNjcmlwdHx0c3xqYXZhc2NyaXB0fGpzKT9cXG4oW1xcc1xcU10qPylgYGAvZztcbiAgbGV0IGJsb2NrTWF0Y2g6IFJlZ0V4cEV4ZWNBcnJheSB8IG51bGw7XG5cbiAgd2hpbGUgKChibG9ja01hdGNoID0gY29kZUJsb2NrUGF0dGVybi5leGVjKGRlc2NyaXB0aW9uKSkgIT09IG51bGwpIHtcbiAgICBjb25zdCBjb2RlQmxvY2sgPSBibG9ja01hdGNoWzFdO1xuXG4gICAgLy8gTWF0Y2ggZnVuY3Rpb24gZGVjbGFyYXRpb25zIGFuZCBleHBvcnRzXG4gICAgLy8gUGF0dGVybnM6XG4gICAgLy8gICBmdW5jdGlvbiBuYW1lKHBhcmFtcyk6IFJldHVyblR5cGVcbiAgICAvLyAgIGV4cG9ydCBmdW5jdGlvbiBuYW1lKHBhcmFtcyk6IFJldHVyblR5cGVcbiAgICAvLyAgIGV4cG9ydCBhc3luYyBmdW5jdGlvbiBuYW1lKHBhcmFtcyk6IFByb21pc2U8UmV0dXJuVHlwZT5cbiAgICAvLyAgIGNvbnN0IG5hbWUgPSAocGFyYW1zKTogUmV0dXJuVHlwZSA9PlxuICAgIC8vICAgZXhwb3J0IGNvbnN0IG5hbWUgPSAocGFyYW1zKTogUmV0dXJuVHlwZSA9PlxuICAgIGNvbnN0IGZ1bmNQYXR0ZXJuID0gLyg/OmV4cG9ydFxccyspPyg/OmFzeW5jXFxzKyk/KD86ZnVuY3Rpb25cXHMrfGNvbnN0XFxzKykoXFx3KykoPzpcXHMqPVxccyopP1xccypcXCgoW14pXSopXFwpKD86XFxzKjpcXHMqKFteez0+XFxuXSspKT8vZztcbiAgICBsZXQgZnVuY01hdGNoOiBSZWdFeHBFeGVjQXJyYXkgfCBudWxsO1xuXG4gICAgd2hpbGUgKChmdW5jTWF0Y2ggPSBmdW5jUGF0dGVybi5leGVjKGNvZGVCbG9jaykpICE9PSBudWxsKSB7XG4gICAgICBjb25zdCBbcmF3LCBuYW1lLCBwYXJhbXMsIHJldHVyblR5cGVdID0gZnVuY01hdGNoO1xuICAgICAgc2lnbmF0dXJlcy5wdXNoKHtcbiAgICAgICAgbmFtZSxcbiAgICAgICAgcGFyYW1zOiBub3JtYWxpemVQYXJhbXMocGFyYW1zKSxcbiAgICAgICAgcmV0dXJuVHlwZTogbm9ybWFsaXplVHlwZShyZXR1cm5UeXBlIHx8IFwidm9pZFwiKSxcbiAgICAgICAgdGFza0lkLFxuICAgICAgICByYXc6IHJhdy50cmltKCksXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyBNYXRjaCBpbnRlcmZhY2UgbWV0aG9kIHNpZ25hdHVyZXNcbiAgICAvLyBQYXR0ZXJuOiBtZXRob2ROYW1lKHBhcmFtcyk6IFJldHVyblR5cGU7XG4gICAgY29uc3QgbWV0aG9kUGF0dGVybiA9IC9eXFxzKihcXHcrKVxccypcXCgoW14pXSopXFwpXFxzKjpcXHMqKFteO10rKTsvZ207XG4gICAgbGV0IG1ldGhvZE1hdGNoOiBSZWdFeHBFeGVjQXJyYXkgfCBudWxsO1xuXG4gICAgd2hpbGUgKChtZXRob2RNYXRjaCA9IG1ldGhvZFBhdHRlcm4uZXhlYyhjb2RlQmxvY2spKSAhPT0gbnVsbCkge1xuICAgICAgY29uc3QgW3JhdywgbmFtZSwgcGFyYW1zLCByZXR1cm5UeXBlXSA9IG1ldGhvZE1hdGNoO1xuICAgICAgc2lnbmF0dXJlcy5wdXNoKHtcbiAgICAgICAgbmFtZSxcbiAgICAgICAgcGFyYW1zOiBub3JtYWxpemVQYXJhbXMocGFyYW1zKSxcbiAgICAgICAgcmV0dXJuVHlwZTogbm9ybWFsaXplVHlwZShyZXR1cm5UeXBlKSxcbiAgICAgICAgdGFza0lkLFxuICAgICAgICByYXc6IHJhdy50cmltKCksXG4gICAgICB9KTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gc2lnbmF0dXJlcztcbn1cblxuLyoqXG4gKiBOb3JtYWxpemUgcGFyYW1ldGVyIGxpc3QgZm9yIGNvbXBhcmlzb24uXG4gKiBSZW1vdmVzIHdoaXRlc3BhY2UsIGNvbW1lbnRzLCBhbmQgZGVmYXVsdCB2YWx1ZXMuXG4gKi9cbmZ1bmN0aW9uIG5vcm1hbGl6ZVBhcmFtcyhwYXJhbXM6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBwYXJhbXNcbiAgICAucmVwbGFjZSgvXFwvXFwqW1xcc1xcU10qP1xcKlxcLy9nLCBcIlwiKSAvLyBSZW1vdmUgYmxvY2sgY29tbWVudHNcbiAgICAucmVwbGFjZSgvXFwvXFwvW15cXG5dKi9nLCBcIlwiKSAgICAgICAvLyBSZW1vdmUgbGluZSBjb21tZW50c1xuICAgIC5yZXBsYWNlKC9cXHMqPVxccypbXiwpXSsvZywgXCJcIikgICAgLy8gUmVtb3ZlIGRlZmF1bHQgdmFsdWVzXG4gICAgLnJlcGxhY2UoL1xccysvZywgXCIgXCIpICAgICAgICAgICAgIC8vIE5vcm1hbGl6ZSB3aGl0ZXNwYWNlXG4gICAgLnRyaW0oKTtcbn1cblxuLyoqXG4gKiBOb3JtYWxpemUgdHlwZSBmb3IgY29tcGFyaXNvbi5cbiAqL1xuZnVuY3Rpb24gbm9ybWFsaXplVHlwZSh0eXBlOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdHlwZVxuICAgIC5yZXBsYWNlKC9cXHMrL2csIFwiIFwiKVxuICAgIC50cmltKCk7XG59XG5cbi8qKlxuICogQ2hlY2sgZm9yIGNvbnRyYWRpY3RvcnkgZnVuY3Rpb24gc2lnbmF0dXJlcyBhY3Jvc3MgdGFza3MuXG4gKiBTYW1lIGZ1bmN0aW9uIG5hbWUgd2l0aCBkaWZmZXJlbnQgc2lnbmF0dXJlcyBpcyBhIHdhcm5pbmcgKG5vdCBibG9ja2luZykuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjaGVja0ludGVyZmFjZUNvbnRyYWN0cyhcbiAgdGFza3M6IFRhc2tSb3dbXSxcbiAgX2Jhc2VQYXRoOiBzdHJpbmdcbik6IFByZUV4ZWN1dGlvbkNoZWNrSlNPTltdIHtcbiAgY29uc3QgcmVzdWx0czogUHJlRXhlY3V0aW9uQ2hlY2tKU09OW10gPSBbXTtcblxuICAvLyBDb2xsZWN0IGFsbCBzaWduYXR1cmVzXG4gIGNvbnN0IGFsbFNpZ25hdHVyZXM6IEZ1bmN0aW9uU2lnbmF0dXJlW10gPSBbXTtcbiAgZm9yIChjb25zdCB0YXNrIG9mIHRhc2tzKSB7XG4gICAgY29uc3Qgc2lncyA9IGV4dHJhY3RGdW5jdGlvblNpZ25hdHVyZXModGFzay5kZXNjcmlwdGlvbiwgdGFzay5pZCk7XG4gICAgYWxsU2lnbmF0dXJlcy5wdXNoKC4uLnNpZ3MpO1xuICB9XG5cbiAgLy8gR3JvdXAgYnkgZnVuY3Rpb24gbmFtZVxuICBjb25zdCBieU5hbWUgPSBuZXcgTWFwPHN0cmluZywgRnVuY3Rpb25TaWduYXR1cmVbXT4oKTtcbiAgZm9yIChjb25zdCBzaWcgb2YgYWxsU2lnbmF0dXJlcykge1xuICAgIGNvbnN0IGV4aXN0aW5nID0gYnlOYW1lLmdldChzaWcubmFtZSkgfHwgW107XG4gICAgZXhpc3RpbmcucHVzaChzaWcpO1xuICAgIGJ5TmFtZS5zZXQoc2lnLm5hbWUsIGV4aXN0aW5nKTtcbiAgfVxuXG4gIC8vIENoZWNrIGZvciBjb250cmFkaWN0aW9uc1xuICBmb3IgKGNvbnN0IFtuYW1lLCBzaWdzXSBvZiBieU5hbWUpIHtcbiAgICBpZiAoc2lncy5sZW5ndGggPCAyKSBjb250aW51ZTtcblxuICAgIC8vIENvbXBhcmUgc2lnbmF0dXJlc1xuICAgIGNvbnN0IGZpcnN0ID0gc2lnc1swXTtcbiAgICBmb3IgKGxldCBpID0gMTsgaSA8IHNpZ3MubGVuZ3RoOyBpKyspIHtcbiAgICAgIGNvbnN0IGN1cnJlbnQgPSBzaWdzW2ldO1xuXG4gICAgICAvLyBDaGVjayBwYXJhbWV0ZXIgbWlzbWF0Y2hcbiAgICAgIGlmIChmaXJzdC5wYXJhbXMgIT09IGN1cnJlbnQucGFyYW1zKSB7XG4gICAgICAgIHJlc3VsdHMucHVzaCh7XG4gICAgICAgICAgY2F0ZWdvcnk6IFwic2NoZW1hXCIsXG4gICAgICAgICAgdGFyZ2V0OiBuYW1lLFxuICAgICAgICAgIHBhc3NlZDogdHJ1ZSwgLy8gV2FybmluZyBvbmx5LCBub3QgYmxvY2tpbmdcbiAgICAgICAgICBtZXNzYWdlOiBgRnVuY3Rpb24gJyR7bmFtZX0nIGhhcyBkaWZmZXJlbnQgcGFyYW1ldGVyczogJyR7Zmlyc3QucGFyYW1zfScgKCR7Zmlyc3QudGFza0lkfSkgdnMgJyR7Y3VycmVudC5wYXJhbXN9JyAoJHtjdXJyZW50LnRhc2tJZH0pYCxcbiAgICAgICAgICBibG9ja2luZzogZmFsc2UsXG4gICAgICAgIH0pO1xuICAgICAgfVxuXG4gICAgICAvLyBDaGVjayByZXR1cm4gdHlwZSBtaXNtYXRjaFxuICAgICAgaWYgKGZpcnN0LnJldHVyblR5cGUgIT09IGN1cnJlbnQucmV0dXJuVHlwZSkge1xuICAgICAgICByZXN1bHRzLnB1c2goe1xuICAgICAgICAgIGNhdGVnb3J5OiBcInNjaGVtYVwiLFxuICAgICAgICAgIHRhcmdldDogbmFtZSxcbiAgICAgICAgICBwYXNzZWQ6IHRydWUsIC8vIFdhcm5pbmcgb25seSwgbm90IGJsb2NraW5nXG4gICAgICAgICAgbWVzc2FnZTogYEZ1bmN0aW9uICcke25hbWV9JyBoYXMgZGlmZmVyZW50IHJldHVybiB0eXBlczogJyR7Zmlyc3QucmV0dXJuVHlwZX0nICgke2ZpcnN0LnRhc2tJZH0pIHZzICcke2N1cnJlbnQucmV0dXJuVHlwZX0nICgke2N1cnJlbnQudGFza0lkfSlgLFxuICAgICAgICAgIGJsb2NraW5nOiBmYWxzZSxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHJlc3VsdHM7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBNYWluIEVudHJ5IFBvaW50IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFJ1biBhbGwgcHJlLWV4ZWN1dGlvbiBjaGVja3MgYWdhaW5zdCBhIHNsaWNlJ3MgdGFzayBwbGFuLlxuICpcbiAqIEBwYXJhbSB0YXNrcyAtIEFycmF5IG9mIFRhc2tSb3cgZnJvbSB0aGUgc2xpY2VcbiAqIEBwYXJhbSBiYXNlUGF0aCAtIEJhc2UgcGF0aCBmb3IgcmVzb2x2aW5nIGZpbGUgcmVmZXJlbmNlc1xuICogQHJldHVybnMgUHJlRXhlY3V0aW9uUmVzdWx0IHdpdGggc3RhdHVzLCBjaGVja3MsIGFuZCBkdXJhdGlvblxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuUHJlRXhlY3V0aW9uQ2hlY2tzKFxuICB0YXNrczogVGFza1Jvd1tdLFxuICBiYXNlUGF0aDogc3RyaW5nXG4pOiBQcm9taXNlPFByZUV4ZWN1dGlvblJlc3VsdD4ge1xuICBjb25zdCBzdGFydFRpbWUgPSBEYXRlLm5vdygpO1xuICBjb25zdCBhbGxDaGVja3M6IFByZUV4ZWN1dGlvbkNoZWNrSlNPTltdID0gW107XG5cbiAgLy8gUnVuIHN5bmMgY2hlY2tzIGZpcnN0XG4gIGNvbnN0IGZpbGVDaGVja3MgPSBjaGVja0ZpbGVQYXRoQ29uc2lzdGVuY3kodGFza3MsIGJhc2VQYXRoKTtcbiAgY29uc3Qgb3JkZXJpbmdDaGVja3MgPSBjaGVja1Rhc2tPcmRlcmluZyh0YXNrcywgYmFzZVBhdGgpO1xuICBjb25zdCBjb250cmFjdENoZWNrcyA9IGNoZWNrSW50ZXJmYWNlQ29udHJhY3RzKHRhc2tzLCBiYXNlUGF0aCk7XG4gIGNvbnN0IHZlcmlmaWNhdGlvbkNoZWNrcyA9IGNoZWNrVmVyaWZpY2F0aW9uQ29tbWFuZHModGFza3MpO1xuXG4gIGFsbENoZWNrcy5wdXNoKC4uLmZpbGVDaGVja3MsIC4uLm9yZGVyaW5nQ2hlY2tzLCAuLi5jb250cmFjdENoZWNrcywgLi4udmVyaWZpY2F0aW9uQ2hlY2tzKTtcblxuICAvLyBSdW4gYXN5bmMgcGFja2FnZSBjaGVja3NcbiAgY29uc3QgcGFja2FnZUNoZWNrcyA9IGF3YWl0IGNoZWNrUGFja2FnZUV4aXN0ZW5jZSh0YXNrcywgYmFzZVBhdGgpO1xuICBhbGxDaGVja3MucHVzaCguLi5wYWNrYWdlQ2hlY2tzKTtcblxuICBjb25zdCBkdXJhdGlvbk1zID0gRGF0ZS5ub3coKSAtIHN0YXJ0VGltZTtcblxuICAvLyBEZXRlcm1pbmUgb3ZlcmFsbCBzdGF0dXNcbiAgY29uc3QgaGFzQmxvY2tpbmdGYWlsdXJlID0gYWxsQ2hlY2tzLnNvbWUoKGMpID0+ICFjLnBhc3NlZCAmJiBjLmJsb2NraW5nKTtcbiAgY29uc3QgaGFzTm9uQmxvY2tpbmdGYWlsdXJlID0gYWxsQ2hlY2tzLnNvbWUoKGMpID0+ICFjLnBhc3NlZCAmJiAhYy5ibG9ja2luZyk7XG4gIC8vIEludGVyZmFjZSBjb250cmFjdCBjaGVja3MgcGFzcyBidXQgc3RpbGwgcmVwb3J0IHdhcm5pbmdzIHZpYSBtZXNzYWdlXG4gIGNvbnN0IGhhc0ludGVyZmFjZVdhcm5pbmcgPSBhbGxDaGVja3Muc29tZShcbiAgICAoYykgPT4gYy5jYXRlZ29yeSA9PT0gXCJzY2hlbWFcIiAmJiBjLm1lc3NhZ2UgJiYgIWMubWVzc2FnZS5zdGFydHNXaXRoKFwiV2FybmluZzpcIilcbiAgKTtcbiAgY29uc3QgaGFzTmV0d29ya1dhcm5pbmcgPSBhbGxDaGVja3Muc29tZShcbiAgICAoYykgPT4gYy5wYXNzZWQgJiYgYy5tZXNzYWdlPy5zdGFydHNXaXRoKFwiV2FybmluZzpcIilcbiAgKTtcblxuICBsZXQgc3RhdHVzOiBcInBhc3NcIiB8IFwid2FyblwiIHwgXCJmYWlsXCI7XG4gIGlmIChoYXNCbG9ja2luZ0ZhaWx1cmUpIHtcbiAgICBzdGF0dXMgPSBcImZhaWxcIjtcbiAgfSBlbHNlIGlmIChoYXNOb25CbG9ja2luZ0ZhaWx1cmUgfHwgaGFzSW50ZXJmYWNlV2FybmluZyB8fCBoYXNOZXR3b3JrV2FybmluZykge1xuICAgIHN0YXR1cyA9IFwid2FyblwiO1xuICB9IGVsc2Uge1xuICAgIHN0YXR1cyA9IFwicGFzc1wiO1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBzdGF0dXMsXG4gICAgY2hlY2tzOiBhbGxDaGVja3MsXG4gICAgZHVyYXRpb25NcyxcbiAgfTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQW1CQSxTQUFTLGtCQUFrQjtBQUMzQixTQUFTLGFBQWE7QUFDdEIsU0FBUyxlQUFlO0FBQ3hCLFNBQVMsZUFBZTtBQUd4QixTQUFTLG1DQUFtQztBQUU1QyxNQUFNLGNBQWMsUUFBUSxhQUFhLFVBQVUsWUFBWTtBQWF4RCxTQUFTLDBCQUEwQixPQUEyQztBQUNuRixRQUFNLFVBQW1DLENBQUM7QUFFMUMsYUFBVyxRQUFRLE9BQU87QUFDeEIsVUFBTSxTQUFTLEtBQUssT0FBTyxLQUFLO0FBQ2hDLFFBQUksQ0FBQyxPQUFRO0FBRWIsVUFBTSxXQUFXLE9BQ2QsTUFBTSxJQUFJLEVBQ1YsSUFBSSxDQUFDLFlBQVksUUFBUSxLQUFLLENBQUMsRUFDL0IsT0FBTyxPQUFPO0FBRWpCLGVBQVcsV0FBVyxVQUFVO0FBQzlCLFlBQU0sYUFBYSw0QkFBNEIsT0FBTztBQUN0RCxVQUFJLENBQUMsV0FBVyxJQUFJO0FBQ2xCLGdCQUFRLEtBQUs7QUFBQSxVQUNYLFVBQVU7QUFBQSxVQUNWLFFBQVEsR0FBRyxLQUFLLEVBQUU7QUFBQSxVQUNsQixRQUFRO0FBQUEsVUFDUixTQUFTLDBDQUEwQyxPQUFPLEtBQUssV0FBVyxNQUFNO0FBQUEsVUFDaEYsVUFBVTtBQUFBLFFBQ1osQ0FBQztBQUFBLE1BQ0g7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUVBLFNBQU87QUFDVDtBQVdPLFNBQVMseUJBQXlCLGFBQStCO0FBQ3RFLFFBQU0sV0FBVyxvQkFBSSxJQUFZO0FBR2pDLFFBQU0sWUFBWSxvQkFBSSxJQUFJO0FBQUEsSUFDeEI7QUFBQSxJQUFRO0FBQUEsSUFBTztBQUFBLElBQU87QUFBQSxJQUFNO0FBQUEsSUFBSztBQUFBLElBQU07QUFBQSxJQUFNO0FBQUEsSUFBTztBQUFBLElBQVE7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
