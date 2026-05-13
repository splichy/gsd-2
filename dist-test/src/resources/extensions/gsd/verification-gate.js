import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { DEFAULT_COMMAND_TIMEOUT_MS } from "./constants.js";
import { rewriteCommandWithRtk } from "../shared/rtk.js";
import { normalizePythonCommand } from "./python-resolver.js";
const MAX_OUTPUT_BYTES = 10 * 1024;
function truncate(value, maxBytes) {
  if (!value) return "";
  if (Buffer.byteLength(value, "utf-8") <= maxBytes) return value;
  const buf = Buffer.from(value, "utf-8").subarray(0, maxBytes);
  return buf.toString("utf-8") + "\n\u2026[truncated]";
}
const PACKAGE_SCRIPT_KEYS = ["typecheck", "lint", "test"];
function discoverCommands(options) {
  if (options.preferenceCommands && options.preferenceCommands.length > 0) {
    const filtered = options.preferenceCommands.map((c) => c.trim()).filter(Boolean);
    if (filtered.length > 0) {
      return { commands: filtered, source: "preference" };
    }
  }
  if (options.taskPlanVerify && options.taskPlanVerify.trim()) {
    const commands = options.taskPlanVerify.split("&&").map((c) => c.trim()).filter(Boolean).filter((c) => sanitizeCommand(c) !== null);
    if (commands.length > 0) {
      return { commands, source: "task-plan" };
    }
  }
  const pkgPath = join(options.cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const raw = readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(raw);
      if (pkg && typeof pkg === "object" && pkg.scripts && typeof pkg.scripts === "object") {
        const commands = [];
        for (const key of PACKAGE_SCRIPT_KEYS) {
          if (typeof pkg.scripts[key] === "string") {
            commands.push(`npm run ${key}`);
          }
        }
        if (commands.length > 0) {
          return { commands, source: "package-json" };
        }
      }
    } catch {
    }
  }
  const pythonCommand = discoverPythonPytestCommand(options.cwd);
  if (pythonCommand) {
    return { commands: [pythonCommand], source: "python-project" };
  }
  return { commands: [], source: "none" };
}
function discoverPythonPytestCommand(cwd) {
  const hasPythonTestFiles = hasPythonTests(join(cwd, "tests"));
  const hasPytestConfig = existsSync(join(cwd, "pytest.ini"));
  const pyprojectPath = join(cwd, "pyproject.toml");
  const hasPyproject = existsSync(pyprojectPath);
  if (!hasPythonTestFiles && !hasPytestConfig && !hasPyproject) {
    return null;
  }
  if (hasPytestConfig || hasPythonTestFiles) {
    return "python3 -m pytest";
  }
  try {
    const pyproject = readFileSync(pyprojectPath, "utf-8");
    if (pyproject.includes("[tool.pytest]") || pyproject.includes("[tool.pytest.") || pyproject.includes("[pytest]") || pyproject.includes("[tool:pytest]")) {
      return "python3 -m pytest";
    }
  } catch {
  }
  return null;
}
function hasPythonTests(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && hasPythonTests(path)) {
      return true;
    }
    if (entry.isFile() && /^test_.*\.py$|^.*_test\.py$/.test(entry.name)) {
      return true;
    }
  }
  return false;
}
const MAX_STDERR_PER_CHECK = 2e3;
const MAX_FAILURE_CONTEXT_CHARS = 1e4;
function formatFailureContext(result) {
  const failures = result.checks.filter((c) => c.exitCode !== 0);
  if (failures.length === 0) return "";
  const blocks = [];
  for (const check of failures) {
    let stderr = check.stderr ?? "";
    if (stderr.length > MAX_STDERR_PER_CHECK) {
      stderr = stderr.slice(0, MAX_STDERR_PER_CHECK) + "\n\u2026[truncated]";
    }
    blocks.push(
      `### \u274C \`${check.command}\` (exit code ${check.exitCode})
\`\`\`stderr
${stderr}
\`\`\``
    );
  }
  let body = blocks.join("\n\n");
  const header = "## Verification Failures\n\n";
  if (header.length + body.length > MAX_FAILURE_CONTEXT_CHARS) {
    body = body.slice(0, MAX_FAILURE_CONTEXT_CHARS - header.length) + "\n\n\u2026[remaining failures truncated]";
  }
  return header + body;
}
const SHELL_INJECTION_PATTERN = /[;|`<>]|\$\(/;
const KNOWN_COMMAND_PREFIXES = /* @__PURE__ */ new Set([
  "npm",
  "npx",
  "yarn",
  "pnpm",
  "bun",
  "bunx",
  "deno",
  "node",
  "ts-node",
  "tsx",
  "tsc",
  "sh",
  "bash",
  "zsh",
  "echo",
  "cat",
  "ls",
  "test",
  "true",
  "false",
  "pwd",
  "env",
  "make",
  "cargo",
  "go",
  "python",
  "python3",
  "pip",
  "pip3",
  "ruby",
  "gem",
  "bundle",
  "rake",
  "java",
  "javac",
  "mvn",
  "gradle",
  "docker",
  "docker-compose",
  "git",
  "gh",
  "eslint",
  "prettier",
  "vitest",
  "jest",
  "mocha",
  "pytest",
  "phpunit",
  "curl",
  "wget",
  "grep",
  "find",
  "diff",
  "wc",
  "sort",
  "head",
  "tail"
]);
function isLikelyCommand(cmd) {
  const trimmed = cmd.trim();
  if (!trimmed) return false;
  const tokens = trimmed.split(/\s+/);
  const firstToken = tokens[0];
  if (KNOWN_COMMAND_PREFIXES.has(firstToken)) return true;
  if (firstToken.startsWith("/") || firstToken.startsWith("./") || firstToken.startsWith("../")) return true;
  if (tokens.some((t) => t.startsWith("-"))) return true;
  if (/^[A-Z]/.test(firstToken) && tokens.length >= 4) return false;
  if (/,\s/.test(trimmed) && tokens.length >= 4) return false;
  if (/[A-Z]/.test(firstToken) && !firstToken.includes("/")) return false;
  if (!/[A-Za-z0-9]/.test(firstToken) && tokens.length >= 4) return false;
  return true;
}
function validateVerificationCommand(cmd) {
  if (SHELL_INJECTION_PATTERN.test(cmd)) {
    return { ok: false, reason: "contains shell control syntax such as pipes, redirects, semicolons, backticks, or command substitution" };
  }
  if (!isLikelyCommand(cmd)) {
    return { ok: false, reason: "does not look like a runnable command" };
  }
  return { ok: true };
}
function sanitizeCommand(cmd) {
  const validation = validateVerificationCommand(cmd);
  if (!validation.ok) return null;
  return cmd;
}
function runVerificationGate(options) {
  const timestamp = Date.now();
  const { commands, source } = discoverCommands({
    preferenceCommands: options.preferenceCommands,
    taskPlanVerify: options.taskPlanVerify,
    cwd: options.cwd
  });
  if (commands.length === 0) {
    return {
      passed: true,
      checks: [],
      discoverySource: source,
      timestamp
    };
  }
  const checks = [];
  for (const command of commands) {
    const start = Date.now();
    const rewrittenCommand = normalizePythonCommand(rewriteCommandWithRtk(command));
    const shellBin = process.platform === "win32" ? "cmd" : "sh";
    const shellArgs = process.platform === "win32" ? ["/c", rewrittenCommand] : ["-c", rewrittenCommand];
    const result = spawnSync(shellBin, shellArgs, {
      cwd: options.cwd,
      stdio: "pipe",
      encoding: "utf-8",
      timeout: options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
    });
    const durationMs = Date.now() - start;
    let exitCode;
    let stderr;
    if (result.error) {
      exitCode = 127;
      stderr = truncate(
        (result.stderr || "") + "\n" + result.error.message,
        MAX_OUTPUT_BYTES
      );
    } else {
      exitCode = result.status ?? 1;
      stderr = truncate(result.stderr, MAX_OUTPUT_BYTES);
    }
    checks.push({
      command,
      exitCode,
      stdout: truncate(result.stdout, MAX_OUTPUT_BYTES),
      stderr,
      durationMs
    });
  }
  return {
    passed: checks.every((c) => c.exitCode === 0),
    checks,
    discoverySource: source,
    timestamp
  };
}
const MAX_BROWSER_TEXT_CHARS = 500;
const FATAL_SIGNALS = /* @__PURE__ */ new Set(["SIGABRT", "SIGSEGV", "SIGBUS"]);
async function captureRuntimeErrors(options) {
  const errors = [];
  try {
    let processes;
    if (options?.getProcesses) {
      processes = options.getProcesses();
    } else {
      const mod = await import("../bg-shell/process-manager.js");
      processes = mod.processes;
    }
    for (const [id, raw] of processes) {
      const proc = raw;
      const name = proc.label || proc.id || id;
      if (proc.signal && FATAL_SIGNALS.has(proc.signal)) {
        errors.push({
          source: "bg-shell",
          severity: "crash",
          message: buildBgShellMessage(name, proc.exitCode, proc.signal, proc.recentErrors),
          blocking: true
        });
        continue;
      }
      if (proc.status === "crashed") {
        errors.push({
          source: "bg-shell",
          severity: "crash",
          message: buildBgShellMessage(name, proc.exitCode, proc.signal, proc.recentErrors),
          blocking: true
        });
        continue;
      }
      if (!proc.alive && proc.exitCode !== 0 && proc.exitCode !== null && proc.exitCode !== void 0) {
        errors.push({
          source: "bg-shell",
          severity: "crash",
          message: buildBgShellMessage(name, proc.exitCode, proc.signal, proc.recentErrors),
          blocking: true
        });
        continue;
      }
      if (proc.alive && proc.recentErrors && proc.recentErrors.length > 0) {
        const snippet = proc.recentErrors.slice(0, 3).join("; ");
        errors.push({
          source: "bg-shell",
          severity: "error",
          message: `[${name}] recent errors: ${snippet}`,
          blocking: false
        });
      }
    }
  } catch {
  }
  try {
    let logs;
    if (options?.getConsoleLogs) {
      logs = options.getConsoleLogs();
    } else {
      const mod = await import("../browser-tools/state.js");
      logs = mod.getConsoleLogs();
    }
    for (const entry of logs) {
      const text = entry.text.length > MAX_BROWSER_TEXT_CHARS ? entry.text.slice(0, MAX_BROWSER_TEXT_CHARS) + "\u2026[truncated]" : entry.text;
      if (entry.type === "error") {
        if (/unhandled/i.test(entry.text)) {
          errors.push({
            source: "browser",
            severity: "crash",
            message: text,
            blocking: true
          });
        } else {
          errors.push({
            source: "browser",
            severity: "error",
            message: text,
            blocking: false
          });
        }
      } else if (entry.type === "warning" && /deprecated/i.test(entry.text)) {
        errors.push({
          source: "browser",
          severity: "warning",
          message: text,
          blocking: false
        });
      }
    }
  } catch {
  }
  return errors;
}
function buildBgShellMessage(name, exitCode, signal, recentErrors) {
  const parts = [`[${name}]`];
  if (signal) parts.push(`signal=${signal}`);
  if (exitCode !== null && exitCode !== void 0) parts.push(`exitCode=${exitCode}`);
  if (recentErrors && recentErrors.length > 0) {
    const snippet = recentErrors.slice(0, 3).join("; ");
    parts.push(`errors: ${snippet}`);
  }
  return parts.join(" ");
}
const DEPENDENCY_FILES = /* @__PURE__ */ new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb"
]);
function defaultGitDiff(cwd) {
  try {
    const result = spawnSync("git", ["diff", "--name-only", "HEAD"], {
      cwd,
      encoding: "utf-8",
      timeout: 1e4
    });
    if (result.status !== 0 || !result.stdout) return [];
    return result.stdout.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
function defaultNpmAudit(cwd) {
  const result = spawnSync("npm", ["audit", "--audit-level=moderate", "--json"], {
    cwd,
    encoding: "utf-8",
    timeout: 6e4
  });
  return {
    stdout: result.stdout ?? "",
    exitCode: result.status ?? 1
  };
}
function runDependencyAudit(cwd, options) {
  try {
    const gitDiff = options?.gitDiff ?? defaultGitDiff;
    const npmAudit = options?.npmAudit ?? defaultNpmAudit;
    const changedFiles = gitDiff(cwd);
    const hasDependencyChange = changedFiles.some((filePath) => {
      const name = basename(filePath);
      return DEPENDENCY_FILES.has(name) && filePath === name;
    });
    if (!hasDependencyChange) return [];
    const auditResult = npmAudit(cwd);
    let parsed;
    try {
      parsed = JSON.parse(auditResult.stdout);
    } catch {
      return [];
    }
    const vulnerabilities = parsed.vulnerabilities;
    if (!vulnerabilities || typeof vulnerabilities !== "object") return [];
    const warnings = [];
    for (const [name, raw] of Object.entries(vulnerabilities)) {
      const vuln = raw;
      if (!vuln || typeof vuln !== "object") continue;
      const severity = vuln.severity;
      if (severity !== "low" && severity !== "moderate" && severity !== "high" && severity !== "critical") {
        continue;
      }
      let title = name;
      let url = "";
      if (Array.isArray(vuln.via)) {
        for (const entry of vuln.via) {
          if (entry && typeof entry === "object" && !Array.isArray(entry)) {
            const obj = entry;
            if (obj.title) title = obj.title;
            if (obj.url) url = obj.url;
            break;
          }
        }
      }
      warnings.push({
        name,
        severity,
        title,
        url,
        fixAvailable: vuln.fixAvailable === true
      });
    }
    return warnings;
  } catch {
    return [];
  }
}
export {
  captureRuntimeErrors,
  discoverCommands,
  formatFailureContext,
  isLikelyCommand,
  runDependencyAudit,
  runVerificationGate,
  validateVerificationCommand
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC92ZXJpZmljYXRpb24tZ2F0ZS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NEIEV4dGVuc2lvbiBcdTIwMTQgVmVyaWZpY2F0aW9uIEdhdGVcbi8vIFB1cmUgZnVuY3Rpb25zIGZvciBkaXNjb3ZlcmluZyBhbmQgcnVubmluZyB2ZXJpZmljYXRpb24gY29tbWFuZHMuXG4vLyBEaXNjb3Zlcnkgb3JkZXIgKEQwMDMpOiBwcmVmZXJlbmNlIFx1MjE5MiB0YXNrIHBsYW4gdmVyaWZ5IFx1MjE5MiBwYWNrYWdlLmpzb24gc2NyaXB0cy5cbi8vIEZpcnN0IG5vbi1lbXB0eSBzb3VyY2Ugd2lucy5cblxuaW1wb3J0IHsgc3Bhd25TeW5jLCB0eXBlIFNwYXduU3luY1JldHVybnMgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkRmlsZVN5bmMsIHJlYWRkaXJTeW5jLCB0eXBlIERpcmVudCB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luLCBiYXNlbmFtZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB0eXBlIHsgQXVkaXRXYXJuaW5nLCBSdW50aW1lRXJyb3IsIFZlcmlmaWNhdGlvbkNoZWNrLCBWZXJpZmljYXRpb25SZXN1bHQgfSBmcm9tIFwiLi90eXBlcy5qc1wiO1xuaW1wb3J0IHsgREVGQVVMVF9DT01NQU5EX1RJTUVPVVRfTVMgfSBmcm9tIFwiLi9jb25zdGFudHMuanNcIjtcbmltcG9ydCB7IHJld3JpdGVDb21tYW5kV2l0aFJ0ayB9IGZyb20gXCIuLi9zaGFyZWQvcnRrLmpzXCI7XG5pbXBvcnQgeyBub3JtYWxpemVQeXRob25Db21tYW5kIH0gZnJvbSBcIi4vcHl0aG9uLXJlc29sdmVyLmpzXCI7XG5cbi8qKiBNYXhpbXVtIGJ5dGVzIG9mIHN0ZG91dC9zdGRlcnIgdG8gcmV0YWluIHBlciBjb21tYW5kICgxMCBLQikuICovXG5jb25zdCBNQVhfT1VUUFVUX0JZVEVTID0gMTAgKiAxMDI0O1xuXG4vKiogVHJ1bmNhdGUgYSBzdHJpbmcgdG8gbWF4Qnl0ZXMsIGFwcGVuZGluZyBhIG1hcmtlciBpZiB0cnVuY2F0ZWQuICovXG5mdW5jdGlvbiB0cnVuY2F0ZSh2YWx1ZTogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCwgbWF4Qnl0ZXM6IG51bWJlcik6IHN0cmluZyB7XG4gIGlmICghdmFsdWUpIHJldHVybiBcIlwiO1xuICBpZiAoQnVmZmVyLmJ5dGVMZW5ndGgodmFsdWUsIFwidXRmLThcIikgPD0gbWF4Qnl0ZXMpIHJldHVybiB2YWx1ZTtcbiAgLy8gU2xpY2UgY29uc2VydmF0aXZlbHkgdGhlbiB0cmltIHRvIGxhc3QgZnVsbCBjaGFyYWN0ZXJcbiAgY29uc3QgYnVmID0gQnVmZmVyLmZyb20odmFsdWUsIFwidXRmLThcIikuc3ViYXJyYXkoMCwgbWF4Qnl0ZXMpO1xuICByZXR1cm4gYnVmLnRvU3RyaW5nKFwidXRmLThcIikgKyBcIlxcblx1MjAyNlt0cnVuY2F0ZWRdXCI7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBDb21tYW5kIERpc2NvdmVyeSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGludGVyZmFjZSBEaXNjb3ZlckNvbW1hbmRzT3B0aW9ucyB7XG4gIHByZWZlcmVuY2VDb21tYW5kcz86IHN0cmluZ1tdO1xuICB0YXNrUGxhblZlcmlmeT86IHN0cmluZztcbiAgY3dkOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRGlzY292ZXJlZENvbW1hbmRzIHtcbiAgY29tbWFuZHM6IHN0cmluZ1tdO1xuICBzb3VyY2U6IFZlcmlmaWNhdGlvblJlc3VsdFtcImRpc2NvdmVyeVNvdXJjZVwiXTtcbn1cblxuLyoqIFBhY2thZ2UuanNvbiBzY3JpcHQga2V5cyB0byBwcm9iZSwgaW4gb3JkZXIuICovXG5jb25zdCBQQUNLQUdFX1NDUklQVF9LRVlTID0gW1widHlwZWNoZWNrXCIsIFwibGludFwiLCBcInRlc3RcIl0gYXMgY29uc3Q7XG5cbi8qKlxuICogRGlzY292ZXIgdmVyaWZpY2F0aW9uIGNvbW1hbmRzIHVzaW5nIHRoZSBmaXJzdC1ub24tZW1wdHktd2lucyBzdHJhdGVneSAoRDAwMyk6XG4gKiAgIDEuIEV4cGxpY2l0IHByZWZlcmVuY2UgY29tbWFuZHNcbiAqICAgMi4gVGFzayBwbGFuIHZlcmlmeSBmaWVsZCAoc3BsaXQgb24gJiYpXG4gKiAgIDMuIHBhY2thZ2UuanNvbiBzY3JpcHRzICh0eXBlY2hlY2ssIGxpbnQsIHRlc3QpXG4gKiAgIDQuIFB5dGhvbiBweXRlc3QgcHJvamVjdCBtYXJrZXJzXG4gKiAgIDUuIE5vbmUgZm91bmRcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRpc2NvdmVyQ29tbWFuZHMob3B0aW9uczogRGlzY292ZXJDb21tYW5kc09wdGlvbnMpOiBEaXNjb3ZlcmVkQ29tbWFuZHMge1xuICAvLyAxLiBQcmVmZXJlbmNlIGNvbW1hbmRzXG4gIGlmIChvcHRpb25zLnByZWZlcmVuY2VDb21tYW5kcyAmJiBvcHRpb25zLnByZWZlcmVuY2VDb21tYW5kcy5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgZmlsdGVyZWQgPSBvcHRpb25zLnByZWZlcmVuY2VDb21tYW5kc1xuICAgICAgLm1hcChjID0+IGMudHJpbSgpKVxuICAgICAgLmZpbHRlcihCb29sZWFuKTtcbiAgICBpZiAoZmlsdGVyZWQubGVuZ3RoID4gMCkge1xuICAgICAgcmV0dXJuIHsgY29tbWFuZHM6IGZpbHRlcmVkLCBzb3VyY2U6IFwicHJlZmVyZW5jZVwiIH07XG4gICAgfVxuICB9XG5cbiAgLy8gMi4gVGFzayBwbGFuIHZlcmlmeSBmaWVsZCAoY29tbWFuZHMgYXJlIHVudHJ1c3RlZCBcdTIwMTQgc2FuaXRpemUpXG4gIGlmIChvcHRpb25zLnRhc2tQbGFuVmVyaWZ5ICYmIG9wdGlvbnMudGFza1BsYW5WZXJpZnkudHJpbSgpKSB7XG4gICAgY29uc3QgY29tbWFuZHMgPSBvcHRpb25zLnRhc2tQbGFuVmVyaWZ5XG4gICAgICAuc3BsaXQoXCImJlwiKVxuICAgICAgLm1hcChjID0+IGMudHJpbSgpKVxuICAgICAgLmZpbHRlcihCb29sZWFuKVxuICAgICAgLmZpbHRlcihjID0+IHNhbml0aXplQ29tbWFuZChjKSAhPT0gbnVsbCk7XG4gICAgaWYgKGNvbW1hbmRzLmxlbmd0aCA+IDApIHtcbiAgICAgIHJldHVybiB7IGNvbW1hbmRzLCBzb3VyY2U6IFwidGFzay1wbGFuXCIgfTtcbiAgICB9XG4gIH1cblxuICAvLyAzLiBwYWNrYWdlLmpzb24gc2NyaXB0c1xuICBjb25zdCBwa2dQYXRoID0gam9pbihvcHRpb25zLmN3ZCwgXCJwYWNrYWdlLmpzb25cIik7XG4gIGlmIChleGlzdHNTeW5jKHBrZ1BhdGgpKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJhdyA9IHJlYWRGaWxlU3luYyhwa2dQYXRoLCBcInV0Zi04XCIpO1xuICAgICAgY29uc3QgcGtnID0gSlNPTi5wYXJzZShyYXcpO1xuICAgICAgaWYgKHBrZyAmJiB0eXBlb2YgcGtnID09PSBcIm9iamVjdFwiICYmIHBrZy5zY3JpcHRzICYmIHR5cGVvZiBwa2cuc2NyaXB0cyA9PT0gXCJvYmplY3RcIikge1xuICAgICAgICBjb25zdCBjb21tYW5kczogc3RyaW5nW10gPSBbXTtcbiAgICAgICAgZm9yIChjb25zdCBrZXkgb2YgUEFDS0FHRV9TQ1JJUFRfS0VZUykge1xuICAgICAgICAgIGlmICh0eXBlb2YgcGtnLnNjcmlwdHNba2V5XSA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICAgICAgY29tbWFuZHMucHVzaChgbnBtIHJ1biAke2tleX1gKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGNvbW1hbmRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICByZXR1cm4geyBjb21tYW5kcywgc291cmNlOiBcInBhY2thZ2UtanNvblwiIH07XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIE1hbGZvcm1lZCBwYWNrYWdlLmpzb24gXHUyMDE0IGZhbGwgdGhyb3VnaCB0byBcIm5vbmVcIlxuICAgIH1cbiAgfVxuXG4gIGNvbnN0IHB5dGhvbkNvbW1hbmQgPSBkaXNjb3ZlclB5dGhvblB5dGVzdENvbW1hbmQob3B0aW9ucy5jd2QpO1xuICBpZiAocHl0aG9uQ29tbWFuZCkge1xuICAgIHJldHVybiB7IGNvbW1hbmRzOiBbcHl0aG9uQ29tbWFuZF0sIHNvdXJjZTogXCJweXRob24tcHJvamVjdFwiIH07XG4gIH1cblxuICAvLyA1LiBOb3RoaW5nIGZvdW5kXG4gIHJldHVybiB7IGNvbW1hbmRzOiBbXSwgc291cmNlOiBcIm5vbmVcIiB9O1xufVxuXG5mdW5jdGlvbiBkaXNjb3ZlclB5dGhvblB5dGVzdENvbW1hbmQoY3dkOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3QgaGFzUHl0aG9uVGVzdEZpbGVzID0gaGFzUHl0aG9uVGVzdHMoam9pbihjd2QsIFwidGVzdHNcIikpO1xuICBjb25zdCBoYXNQeXRlc3RDb25maWcgPSBleGlzdHNTeW5jKGpvaW4oY3dkLCBcInB5dGVzdC5pbmlcIikpO1xuICBjb25zdCBweXByb2plY3RQYXRoID0gam9pbihjd2QsIFwicHlwcm9qZWN0LnRvbWxcIik7XG4gIGNvbnN0IGhhc1B5cHJvamVjdCA9IGV4aXN0c1N5bmMocHlwcm9qZWN0UGF0aCk7XG5cbiAgaWYgKCFoYXNQeXRob25UZXN0RmlsZXMgJiYgIWhhc1B5dGVzdENvbmZpZyAmJiAhaGFzUHlwcm9qZWN0KSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cblxuICBpZiAoaGFzUHl0ZXN0Q29uZmlnIHx8IGhhc1B5dGhvblRlc3RGaWxlcykge1xuICAgIHJldHVybiBcInB5dGhvbjMgLW0gcHl0ZXN0XCI7XG4gIH1cblxuICB0cnkge1xuICAgIGNvbnN0IHB5cHJvamVjdCA9IHJlYWRGaWxlU3luYyhweXByb2plY3RQYXRoLCBcInV0Zi04XCIpO1xuICAgIGlmIChcbiAgICAgIHB5cHJvamVjdC5pbmNsdWRlcyhcIlt0b29sLnB5dGVzdF1cIikgfHxcbiAgICAgIHB5cHJvamVjdC5pbmNsdWRlcyhcIlt0b29sLnB5dGVzdC5cIikgfHxcbiAgICAgIHB5cHJvamVjdC5pbmNsdWRlcyhcIltweXRlc3RdXCIpIHx8XG4gICAgICBweXByb2plY3QuaW5jbHVkZXMoXCJbdG9vbDpweXRlc3RdXCIpXG4gICAgKSB7XG4gICAgICByZXR1cm4gXCJweXRob24zIC1tIHB5dGVzdFwiO1xuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gSWdub3JlIHVucmVhZGFibGUgcHlwcm9qZWN0LnRvbWwgYW5kIGZhbGwgdGhyb3VnaC5cbiAgfVxuXG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBoYXNQeXRob25UZXN0cyhkaXI6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBsZXQgZW50cmllczogRGlyZW50W107XG4gIHRyeSB7XG4gICAgZW50cmllcyA9IHJlYWRkaXJTeW5jKGRpciwgeyB3aXRoRmlsZVR5cGVzOiB0cnVlIH0pO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICBmb3IgKGNvbnN0IGVudHJ5IG9mIGVudHJpZXMpIHtcbiAgICBjb25zdCBwYXRoID0gam9pbihkaXIsIGVudHJ5Lm5hbWUpO1xuICAgIGlmIChlbnRyeS5pc0RpcmVjdG9yeSgpICYmIGhhc1B5dGhvblRlc3RzKHBhdGgpKSB7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgaWYgKGVudHJ5LmlzRmlsZSgpICYmIC9edGVzdF8uKlxcLnB5JHxeLipfdGVzdFxcLnB5JC8udGVzdChlbnRyeS5uYW1lKSkge1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGZhbHNlO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRmFpbHVyZSBDb250ZXh0IEZvcm1hdHRpbmcgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKiBNYXhpbXVtIGNoYXJzIG9mIHN0ZGVyciB0byBpbmNsdWRlIHBlciBmYWlsZWQgY2hlY2sgaW4gZmFpbHVyZSBjb250ZXh0LiAqL1xuY29uc3QgTUFYX1NUREVSUl9QRVJfQ0hFQ0sgPSAyXzAwMDtcblxuLyoqIE1heGltdW0gdG90YWwgY2hhcnMgZm9yIHRoZSBjb21iaW5lZCBmYWlsdXJlIGNvbnRleHQgb3V0cHV0LiAqL1xuY29uc3QgTUFYX0ZBSUxVUkVfQ09OVEVYVF9DSEFSUyA9IDEwXzAwMDtcblxuLyoqXG4gKiBGb3JtYXQgZmFpbGVkIHZlcmlmaWNhdGlvbiBjaGVja3MgaW50byBhIHByb21wdC1pbmplY3RhYmxlIHRleHQgYmxvY2suXG4gKlxuICogRWFjaCBmYWlsZWQgY2hlY2sgZ2V0cyBhIGhlYWRpbmcgd2l0aCB0aGUgY29tbWFuZCBuYW1lIGFuZCBleGl0IGNvZGUsXG4gKiBmb2xsb3dlZCBieSBhIHRydW5jYXRlZCBzdGRlcnIgZXhjZXJwdC4gSW5kaXZpZHVhbCBzdGRlcnIgaXMgY2FwcGVkIHRvXG4gKiAyIDAwMCBjaGFyczsgdG90YWwgb3V0cHV0IGlzIGNhcHBlZCB0byAxMCAwMDAgY2hhcnMuXG4gKlxuICogUmV0dXJucyBhbiBlbXB0eSBzdHJpbmcgd2hlbiBhbGwgY2hlY2tzIHBhc3Mgb3IgdGhlIGNoZWNrcyBhcnJheSBpcyBlbXB0eS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdEZhaWx1cmVDb250ZXh0KHJlc3VsdDogVmVyaWZpY2F0aW9uUmVzdWx0KTogc3RyaW5nIHtcbiAgY29uc3QgZmFpbHVyZXMgPSByZXN1bHQuY2hlY2tzLmZpbHRlcigoYykgPT4gYy5leGl0Q29kZSAhPT0gMCk7XG4gIGlmIChmYWlsdXJlcy5sZW5ndGggPT09IDApIHJldHVybiBcIlwiO1xuXG4gIGNvbnN0IGJsb2Nrczogc3RyaW5nW10gPSBbXTtcblxuICBmb3IgKGNvbnN0IGNoZWNrIG9mIGZhaWx1cmVzKSB7XG4gICAgbGV0IHN0ZGVyciA9IGNoZWNrLnN0ZGVyciA/PyBcIlwiO1xuICAgIGlmIChzdGRlcnIubGVuZ3RoID4gTUFYX1NUREVSUl9QRVJfQ0hFQ0spIHtcbiAgICAgIHN0ZGVyciA9IHN0ZGVyci5zbGljZSgwLCBNQVhfU1RERVJSX1BFUl9DSEVDSykgKyBcIlxcblx1MjAyNlt0cnVuY2F0ZWRdXCI7XG4gICAgfVxuXG4gICAgYmxvY2tzLnB1c2goXG4gICAgICBgIyMjIFx1Mjc0QyBcXGAke2NoZWNrLmNvbW1hbmR9XFxgIChleGl0IGNvZGUgJHtjaGVjay5leGl0Q29kZX0pXFxuXFxgXFxgXFxgc3RkZXJyXFxuJHtzdGRlcnJ9XFxuXFxgXFxgXFxgYCxcbiAgICApO1xuICB9XG5cbiAgbGV0IGJvZHkgPSBibG9ja3Muam9pbihcIlxcblxcblwiKTtcbiAgY29uc3QgaGVhZGVyID0gXCIjIyBWZXJpZmljYXRpb24gRmFpbHVyZXNcXG5cXG5cIjtcblxuICBpZiAoaGVhZGVyLmxlbmd0aCArIGJvZHkubGVuZ3RoID4gTUFYX0ZBSUxVUkVfQ09OVEVYVF9DSEFSUykge1xuICAgIGJvZHkgPVxuICAgICAgYm9keS5zbGljZSgwLCBNQVhfRkFJTFVSRV9DT05URVhUX0NIQVJTIC0gaGVhZGVyLmxlbmd0aCkgK1xuICAgICAgXCJcXG5cXG5cdTIwMjZbcmVtYWluaW5nIGZhaWx1cmVzIHRydW5jYXRlZF1cIjtcbiAgfVxuXG4gIHJldHVybiBoZWFkZXIgKyBib2R5O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgR2F0ZSBFeGVjdXRpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKiBDaGFyYWN0ZXJzIHRoYXQgaW5kaWNhdGUgc2hlbGwgaW5qZWN0aW9uIHdoZW4gZm91bmQgaW4gYSBjb21tYW5kIHN0cmluZy4gKi9cbmNvbnN0IFNIRUxMX0lOSkVDVElPTl9QQVRURVJOID0gL1s7fGA8Pl18XFwkXFwoLztcblxuLyoqXG4gKiBLbm93biBleGVjdXRhYmxlIGZpcnN0LXRva2VucyB0aGF0IGFyZSBzYWZlIHRvIHJ1bi5cbiAqIExvd2VyY2FzZSBjb21tYW5kcywgY29tbW9uIGJ1aWxkL3Rlc3QgdG9vbHMsIGFuZCBucG0veWFybi9wbnBtIGludm9jYXRpb25zLlxuICovXG5jb25zdCBLTk9XTl9DT01NQU5EX1BSRUZJWEVTID0gbmV3IFNldChbXG4gIFwibnBtXCIsIFwibnB4XCIsIFwieWFyblwiLCBcInBucG1cIiwgXCJidW5cIiwgXCJidW54XCIsIFwiZGVub1wiLFxuICBcIm5vZGVcIiwgXCJ0cy1ub2RlXCIsIFwidHN4XCIsIFwidHNjXCIsXG4gIFwic2hcIiwgXCJiYXNoXCIsIFwienNoXCIsXG4gIFwiZWNob1wiLCBcImNhdFwiLCBcImxzXCIsIFwidGVzdFwiLCBcInRydWVcIiwgXCJmYWxzZVwiLCBcInB3ZFwiLCBcImVudlwiLFxuICBcIm1ha2VcIiwgXCJjYXJnb1wiLCBcImdvXCIsIFwicHl0aG9uXCIsIFwicHl0aG9uM1wiLCBcInBpcFwiLCBcInBpcDNcIixcbiAgXCJydWJ5XCIsIFwiZ2VtXCIsIFwiYnVuZGxlXCIsIFwicmFrZVwiLFxuICBcImphdmFcIiwgXCJqYXZhY1wiLCBcIm12blwiLCBcImdyYWRsZVwiLFxuICBcImRvY2tlclwiLCBcImRvY2tlci1jb21wb3NlXCIsXG4gIFwiZ2l0XCIsIFwiZ2hcIixcbiAgXCJlc2xpbnRcIiwgXCJwcmV0dGllclwiLCBcInZpdGVzdFwiLCBcImplc3RcIiwgXCJtb2NoYVwiLCBcInB5dGVzdFwiLCBcInBocHVuaXRcIixcbiAgXCJjdXJsXCIsIFwid2dldFwiLFxuICBcImdyZXBcIiwgXCJmaW5kXCIsIFwiZGlmZlwiLCBcIndjXCIsIFwic29ydFwiLCBcImhlYWRcIiwgXCJ0YWlsXCIsXG5dKTtcblxuLyoqXG4gKiBIZXVyaXN0aWMgY2hlY2s6IGRvZXMgdGhpcyBzdHJpbmcgbG9vayBsaWtlIGFuIGV4ZWN1dGFibGUgc2hlbGwgY29tbWFuZFxuICogcmF0aGVyIHRoYW4gYSBwcm9zZSBkZXNjcmlwdGlvbj9cbiAqXG4gKiBSZXR1cm5zIHRydWUgd2hlbiB0aGUgc3RyaW5nIGFwcGVhcnMgdG8gYmUgYSBjb21tYW5kLiBSZXR1cm5zIGZhbHNlXG4gKiBmb3IgRW5nbGlzaCBwcm9zZSAoZS5nLiBcIkRvY3VtZW50IGV4aXN0cywgY29udGFpbnMgYWxsIDUgc2NhbGUgbmFtZXNcIikuXG4gKlxuICogSGV1cmlzdGljcyAoYW55IHRydWUgXHUyMTkyIGNvbW1hbmQtbGlrZSk6XG4gKiAgIDEuIEZpcnN0IHRva2VuIGlzIGEga25vd24gY29tbWFuZCBwcmVmaXhcbiAqICAgMi4gRmlyc3QgdG9rZW4gc3RhcnRzIHdpdGggYC5gIG9yIGAvYCAocGF0aC1saWtlKVxuICogICAzLiBBbnkgdG9rZW4gc3RhcnRzIHdpdGggYC1gIChmbGFnLWxpa2UpXG4gKiAgIDQuIEZpcnN0IHRva2VuIGNvbnRhaW5zIG5vIHVwcGVyY2FzZSBsZXR0ZXJzIChjb21tYW5kcyBhcmUgbG93ZXJjYXNlKVxuICogICAgICBBTkQgZmlyc3QgdG9rZW4gZG9lcyBub3QgZW5kIHdpdGggYSBjb21tYSBvciBjb2xvbiAocHJvc2UgcHVuY3R1YXRpb24pXG4gKlxuICogSGV1cmlzdGljcyAoYW55IHRydWUgXHUyMTkyIHByb3NlLWxpa2UpOlxuICogICAxLiBGaXJzdCB0b2tlbiBzdGFydHMgd2l0aCBhbiB1cHBlcmNhc2UgbGV0dGVyIGFuZCB0aGUgc3RyaW5nIGhhcyA0KyB3b3Jkc1xuICogICAyLiBTdHJpbmcgY29udGFpbnMgY29tbWFzIGZvbGxvd2VkIGJ5IHNwYWNlcyAocHJvc2UgY2xhdXNlIHN0cnVjdHVyZSlcbiAqICAgMy4gRmlyc3QgdG9rZW4gaGFzIG5vIEFTQ0lJIGxldHRlcnMgb3IgZGlnaXRzIGFuZCB0aGUgc3RyaW5nIGhhcyA0KyB3b3Jkc1xuICovXG5leHBvcnQgZnVuY3Rpb24gaXNMaWtlbHlDb21tYW5kKGNtZDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IHRyaW1tZWQgPSBjbWQudHJpbSgpO1xuICBpZiAoIXRyaW1tZWQpIHJldHVybiBmYWxzZTtcblxuICBjb25zdCB0b2tlbnMgPSB0cmltbWVkLnNwbGl0KC9cXHMrLyk7XG4gIGNvbnN0IGZpcnN0VG9rZW4gPSB0b2tlbnNbMF07XG5cbiAgLy8gS25vd24gY29tbWFuZCBwcmVmaXggXHUyMTkyIGRlZmluaXRlbHkgYSBjb21tYW5kXG4gIGlmIChLTk9XTl9DT01NQU5EX1BSRUZJWEVTLmhhcyhmaXJzdFRva2VuKSkgcmV0dXJuIHRydWU7XG5cbiAgLy8gUGF0aC1saWtlIGZpcnN0IHRva2VuIFx1MjE5MiBjb21tYW5kXG4gIGlmIChmaXJzdFRva2VuLnN0YXJ0c1dpdGgoXCIvXCIpIHx8IGZpcnN0VG9rZW4uc3RhcnRzV2l0aChcIi4vXCIpIHx8IGZpcnN0VG9rZW4uc3RhcnRzV2l0aChcIi4uL1wiKSkgcmV0dXJuIHRydWU7XG5cbiAgLy8gSGFzIGZsYWctbGlrZSB0b2tlbnMgXHUyMTkyIGNvbW1hbmRcbiAgaWYgKHRva2Vucy5zb21lKHQgPT4gdC5zdGFydHNXaXRoKFwiLVwiKSkpIHJldHVybiB0cnVlO1xuXG4gIC8vIEZpcnN0IHRva2VuIHN0YXJ0cyB3aXRoIHVwcGVyY2FzZSArIDQgb3IgbW9yZSB3b3JkcyBcdTIxOTIgcHJvc2VcbiAgaWYgKC9eW0EtWl0vLnRlc3QoZmlyc3RUb2tlbikgJiYgdG9rZW5zLmxlbmd0aCA+PSA0KSByZXR1cm4gZmFsc2U7XG5cbiAgLy8gQ29udGFpbnMgY29tbWEtc3BhY2UgcGF0dGVybnMgKHByb3NlIGNsYXVzZSBzZXBhcmF0b3JzKSBcdTIxOTIgcHJvc2VcbiAgaWYgKC8sXFxzLy50ZXN0KHRyaW1tZWQpICYmIHRva2Vucy5sZW5ndGggPj0gNCkgcmV0dXJuIGZhbHNlO1xuXG4gIC8vIEZpcnN0IHRva2VuIGhhcyB1cHBlcmNhc2UgbGV0dGVycyBhbmQgbm8gcGF0aCBzZXBhcmF0b3JzIFx1MjE5MiBwcm9zZVxuICBpZiAoL1tBLVpdLy50ZXN0KGZpcnN0VG9rZW4pICYmICFmaXJzdFRva2VuLmluY2x1ZGVzKFwiL1wiKSkgcmV0dXJuIGZhbHNlO1xuXG4gIC8vIE5vbi1BU0NJSSBwcm9zZSB3aXRoIG11bHRpcGxlIHdvcmRzIHNob3VsZCBub3QgYmUgZXhlY3V0ZWQgYXMgYSBjb21tYW5kLlxuICBpZiAoIS9bQS1aYS16MC05XS8udGVzdChmaXJzdFRva2VuKSAmJiB0b2tlbnMubGVuZ3RoID49IDQpIHJldHVybiBmYWxzZTtcblxuICByZXR1cm4gdHJ1ZTtcbn1cblxuLyoqXG4gKiBWYWxpZGF0ZSBhIGNvbW1hbmQgc3RyaW5nIGZvciBvYnZpb3VzIHNoZWxsIGluamVjdGlvbiBwYXR0ZXJucy5cbiAqIFJldHVybnMgdGhlIGNvbW1hbmQgdW5jaGFuZ2VkIGlmIHNhZmUsIG9yIG51bGwgaWYgc3VzcGljaW91cy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHZhbGlkYXRlVmVyaWZpY2F0aW9uQ29tbWFuZChjbWQ6IHN0cmluZyk6IHsgb2s6IHRydWUgfSB8IHsgb2s6IGZhbHNlOyByZWFzb246IHN0cmluZyB9IHtcbiAgaWYgKFNIRUxMX0lOSkVDVElPTl9QQVRURVJOLnRlc3QoY21kKSkge1xuICAgIHJldHVybiB7IG9rOiBmYWxzZSwgcmVhc29uOiBcImNvbnRhaW5zIHNoZWxsIGNvbnRyb2wgc3ludGF4IHN1Y2ggYXMgcGlwZXMsIHJlZGlyZWN0cywgc2VtaWNvbG9ucywgYmFja3RpY2tzLCBvciBjb21tYW5kIHN1YnN0aXR1dGlvblwiIH07XG4gIH1cbiAgaWYgKCFpc0xpa2VseUNvbW1hbmQoY21kKSkge1xuICAgIHJldHVybiB7IG9rOiBmYWxzZSwgcmVhc29uOiBcImRvZXMgbm90IGxvb2sgbGlrZSBhIHJ1bm5hYmxlIGNvbW1hbmRcIiB9O1xuICB9XG4gIHJldHVybiB7IG9rOiB0cnVlIH07XG59XG5cbmZ1bmN0aW9uIHNhbml0aXplQ29tbWFuZChjbWQ6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCB2YWxpZGF0aW9uID0gdmFsaWRhdGVWZXJpZmljYXRpb25Db21tYW5kKGNtZCk7XG4gIGlmICghdmFsaWRhdGlvbi5vaykgcmV0dXJuIG51bGw7XG4gIHJldHVybiBjbWQ7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUnVuVmVyaWZpY2F0aW9uR2F0ZU9wdGlvbnMge1xuICBjd2Q6IHN0cmluZztcbiAgcHJlZmVyZW5jZUNvbW1hbmRzPzogc3RyaW5nW107XG4gIHRhc2tQbGFuVmVyaWZ5Pzogc3RyaW5nO1xuICAvKiogUGVyLWNvbW1hbmQgdGltZW91dCBpbiBtcy4gRGVmYXVsdHMgdG8gMTIwIDAwMCAoMiBtaW51dGVzKS4gKi9cbiAgY29tbWFuZFRpbWVvdXRNcz86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBSdW4gdGhlIHZlcmlmaWNhdGlvbiBnYXRlOiBkaXNjb3ZlciBjb21tYW5kcywgZXhlY3V0ZSBlYWNoIHZpYSBzcGF3blN5bmMsXG4gKiBhbmQgcmV0dXJuIGEgc3RydWN0dXJlZCByZXN1bHQuXG4gKlxuICogLSBBbGwgY29tbWFuZHMgcnVuIHNlcXVlbnRpYWxseSByZWdhcmRsZXNzIG9mIGluZGl2aWR1YWwgcGFzcy9mYWlsLlxuICogLSBgcGFzc2VkYCBpcyB0cnVlIHdoZW4gZXZlcnkgY29tbWFuZCBleGl0cyAwIChvciBubyBjb21tYW5kcyBhcmUgZGlzY292ZXJlZCkuXG4gKiAtIHN0ZG91dC9zdGRlcnIgcGVyIGNvbW1hbmQgYXJlIHRydW5jYXRlZCB0byAxMCBLQi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJ1blZlcmlmaWNhdGlvbkdhdGUob3B0aW9uczogUnVuVmVyaWZpY2F0aW9uR2F0ZU9wdGlvbnMpOiBWZXJpZmljYXRpb25SZXN1bHQge1xuICBjb25zdCB0aW1lc3RhbXAgPSBEYXRlLm5vdygpO1xuXG4gIGNvbnN0IHsgY29tbWFuZHMsIHNvdXJjZSB9ID0gZGlzY292ZXJDb21tYW5kcyh7XG4gICAgcHJlZmVyZW5jZUNvbW1hbmRzOiBvcHRpb25zLnByZWZlcmVuY2VDb21tYW5kcyxcbiAgICB0YXNrUGxhblZlcmlmeTogb3B0aW9ucy50YXNrUGxhblZlcmlmeSxcbiAgICBjd2Q6IG9wdGlvbnMuY3dkLFxuICB9KTtcblxuICBpZiAoY29tbWFuZHMubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHBhc3NlZDogdHJ1ZSxcbiAgICAgIGNoZWNrczogW10sXG4gICAgICBkaXNjb3ZlcnlTb3VyY2U6IHNvdXJjZSxcbiAgICAgIHRpbWVzdGFtcCxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgY2hlY2tzOiBWZXJpZmljYXRpb25DaGVja1tdID0gW107XG5cbiAgZm9yIChjb25zdCBjb21tYW5kIG9mIGNvbW1hbmRzKSB7XG4gICAgY29uc3Qgc3RhcnQgPSBEYXRlLm5vdygpO1xuICAgIGNvbnN0IHJld3JpdHRlbkNvbW1hbmQgPSBub3JtYWxpemVQeXRob25Db21tYW5kKHJld3JpdGVDb21tYW5kV2l0aFJ0ayhjb21tYW5kKSk7XG4gICAgLy8gUGFzcyB0aGUgY29tbWFuZCBzdHJpbmcgYXMgYW4gYXJndW1lbnQgdG8gdGhlIHNoZWxsIGV4cGxpY2l0bHlcbiAgICAvLyB0byBhdm9pZCBOb2RlLmpzIERFUDAxOTAgKHNwYXduU3luYyB3aXRoIHNoZWxsOiB0cnVlIGFuZCBubyBhcmdzKS5cbiAgICBjb25zdCBzaGVsbEJpbiA9IHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIiA/IFwiY21kXCIgOiBcInNoXCI7XG4gICAgY29uc3Qgc2hlbGxBcmdzID0gcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiID8gW1wiL2NcIiwgcmV3cml0dGVuQ29tbWFuZF0gOiBbXCItY1wiLCByZXdyaXR0ZW5Db21tYW5kXTtcbiAgICBjb25zdCByZXN1bHQ6IFNwYXduU3luY1JldHVybnM8c3RyaW5nPiA9IHNwYXduU3luYyhzaGVsbEJpbiwgc2hlbGxBcmdzLCB7XG4gICAgICBjd2Q6IG9wdGlvbnMuY3dkLFxuICAgICAgc3RkaW86IFwicGlwZVwiLFxuICAgICAgZW5jb2Rpbmc6IFwidXRmLThcIixcbiAgICAgIHRpbWVvdXQ6IG9wdGlvbnMuY29tbWFuZFRpbWVvdXRNcyA/PyBERUZBVUxUX0NPTU1BTkRfVElNRU9VVF9NUyxcbiAgICB9KTtcbiAgICBjb25zdCBkdXJhdGlvbk1zID0gRGF0ZS5ub3coKSAtIHN0YXJ0O1xuXG4gICAgbGV0IGV4aXRDb2RlOiBudW1iZXI7XG4gICAgbGV0IHN0ZGVycjogc3RyaW5nO1xuXG4gICAgaWYgKHJlc3VsdC5lcnJvcikge1xuICAgICAgLy8gQ29tbWFuZCBub3QgZm91bmQgb3Igc3Bhd24gZmFpbHVyZVxuICAgICAgZXhpdENvZGUgPSAxMjc7XG4gICAgICBzdGRlcnIgPSB0cnVuY2F0ZShcbiAgICAgICAgKHJlc3VsdC5zdGRlcnIgfHwgXCJcIikgKyBcIlxcblwiICsgKHJlc3VsdC5lcnJvciBhcyBFcnJvcikubWVzc2FnZSxcbiAgICAgICAgTUFYX09VVFBVVF9CWVRFUyxcbiAgICAgICk7XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIHN0YXR1cyBpcyBudWxsIHdoZW4ga2lsbGVkIGJ5IHNpZ25hbCBcdTIwMTQgdHJlYXQgYXMgZmFpbHVyZVxuICAgICAgZXhpdENvZGUgPSByZXN1bHQuc3RhdHVzID8/IDE7XG4gICAgICBzdGRlcnIgPSB0cnVuY2F0ZShyZXN1bHQuc3RkZXJyLCBNQVhfT1VUUFVUX0JZVEVTKTtcbiAgICB9XG5cbiAgICBjaGVja3MucHVzaCh7XG4gICAgICBjb21tYW5kLFxuICAgICAgZXhpdENvZGUsXG4gICAgICBzdGRvdXQ6IHRydW5jYXRlKHJlc3VsdC5zdGRvdXQsIE1BWF9PVVRQVVRfQllURVMpLFxuICAgICAgc3RkZXJyLFxuICAgICAgZHVyYXRpb25NcyxcbiAgICB9KTtcbiAgfVxuXG4gIHJldHVybiB7XG4gICAgcGFzc2VkOiBjaGVja3MuZXZlcnkoYyA9PiBjLmV4aXRDb2RlID09PSAwKSxcbiAgICBjaGVja3MsXG4gICAgZGlzY292ZXJ5U291cmNlOiBzb3VyY2UsXG4gICAgdGltZXN0YW1wLFxuICB9O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUnVudGltZSBFcnJvciBDYXB0dXJlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKiogTWF4aW11bSBjaGFyYWN0ZXJzIG9mIGJyb3dzZXIgY29uc29sZSB0ZXh0IHRvIHJldGFpbiBwZXIgZW50cnkuICovXG5jb25zdCBNQVhfQlJPV1NFUl9URVhUX0NIQVJTID0gNTAwO1xuXG4vKiogRmF0YWwgc2lnbmFscyB0aGF0IGluZGljYXRlIGEgY3Jhc2ggcmVnYXJkbGVzcyBvZiBvdGhlciBzdGF0dXMgZmllbGRzLiAqL1xuY29uc3QgRkFUQUxfU0lHTkFMUyA9IG5ldyBTZXQoW1wiU0lHQUJSVFwiLCBcIlNJR1NFR1ZcIiwgXCJTSUdCVVNcIl0pO1xuXG4vKipcbiAqIEluamVjdGFibGUgZGVwZW5kZW5jaWVzIGZvciBjYXB0dXJlUnVudGltZUVycm9ycy5cbiAqIFdoZW4gb21pdHRlZCB0aGUgZnVuY3Rpb24gdXNlcyBkeW5hbWljIGltcG9ydCgpIHRvIGFjY2Vzc1xuICogYmctc2hlbGwncyBwcm9jZXNzZXMgTWFwIGFuZCBicm93c2VyLXRvb2xzJyBnZXRDb25zb2xlTG9ncygpLlxuICogUHJvdmlkZSBvdmVycmlkZXMgaW4gdGVzdHMgdG8gYXZvaWQgbW9kdWxlIG1vY2tpbmcuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQ2FwdHVyZVJ1bnRpbWVFcnJvcnNPcHRpb25zIHtcbiAgZ2V0UHJvY2Vzc2VzPzogKCkgPT4gTWFwPHN0cmluZywgdW5rbm93bj47XG4gIGdldENvbnNvbGVMb2dzPzogKCkgPT4gQXJyYXk8eyB0eXBlOiBzdHJpbmc7IHRleHQ6IHN0cmluZzsgdGltZXN0YW1wOiBudW1iZXI7IHVybDogc3RyaW5nIH0+O1xufVxuXG4vKipcbiAqIFNjYW4gYmctc2hlbGwgcHJvY2Vzc2VzIGFuZCBicm93c2VyIGNvbnNvbGUgbG9ncyBmb3IgcnVudGltZSBlcnJvcnMuXG4gKlxuICogU2V2ZXJpdHkgY2xhc3NpZmljYXRpb24gZm9sbG93cyBEMDA0OlxuICogICAtIGJnLXNoZWxsIHN0YXR1cyBcImNyYXNoZWRcIiBcdTIxOTIgYmxvY2tpbmcgY3Jhc2hcbiAqICAgLSBiZy1zaGVsbCAhYWxpdmUgJiYgZXhpdENvZGUgIT09IDAgJiYgZXhpdENvZGUgIT09IG51bGwgXHUyMTkyIGJsb2NraW5nIGNyYXNoXG4gKiAgIC0gYmctc2hlbGwgc2lnbmFsIFNJR0FCUlQvU0lHU0VHVi9TSUdCVVMgXHUyMTkyIGJsb2NraW5nIGNyYXNoXG4gKiAgIC0gQnJvd3NlciBjb25zb2xlIGVycm9yIHdpdGggXCJVbmhhbmRsZWRcIi9cIlVuaGFuZGxlZFJlamVjdGlvblwiIFx1MjE5MiBibG9ja2luZyBjcmFzaFxuICogICAtIEJyb3dzZXIgY29uc29sZSBlcnJvciAoZ2VuZXJhbCkgXHUyMTkyIG5vbi1ibG9ja2luZyBlcnJvclxuICogICAtIEJyb3dzZXIgY29uc29sZSB3YXJuaW5nIHdpdGggZGVwcmVjYXRpb24gdGV4dCBcdTIxOTIgbm9uLWJsb2NraW5nIHdhcm5pbmdcbiAqICAgLSBiZy1zaGVsbCBhbGl2ZSBwcm9jZXNzIHdpdGggcmVjZW50RXJyb3JzIFx1MjE5MiBub24tYmxvY2tpbmcgZXJyb3JcbiAqXG4gKiBSZXR1cm5zIFJ1bnRpbWVFcnJvcltdIFx1MjAxNCBlbXB0eSB3aGVuIGJvdGggc291cmNlcyBhcmUgdW5hdmFpbGFibGUuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjYXB0dXJlUnVudGltZUVycm9ycyhcbiAgb3B0aW9ucz86IENhcHR1cmVSdW50aW1lRXJyb3JzT3B0aW9ucyxcbik6IFByb21pc2U8UnVudGltZUVycm9yW10+IHtcbiAgY29uc3QgZXJyb3JzOiBSdW50aW1lRXJyb3JbXSA9IFtdO1xuXG4gIC8vIFx1MjUwMFx1MjUwMCBiZy1zaGVsbCBzY2FuIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICB0cnkge1xuICAgIGxldCBwcm9jZXNzZXM6IE1hcDxzdHJpbmcsIHVua25vd24+O1xuICAgIGlmIChvcHRpb25zPy5nZXRQcm9jZXNzZXMpIHtcbiAgICAgIHByb2Nlc3NlcyA9IG9wdGlvbnMuZ2V0UHJvY2Vzc2VzKCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IG1vZCA9IGF3YWl0IGltcG9ydChcIi4uL2JnLXNoZWxsL3Byb2Nlc3MtbWFuYWdlci5qc1wiKTtcbiAgICAgIHByb2Nlc3NlcyA9IG1vZC5wcm9jZXNzZXM7XG4gICAgfVxuXG4gICAgZm9yIChjb25zdCBbaWQsIHJhd10gb2YgcHJvY2Vzc2VzKSB7XG4gICAgICBjb25zdCBwcm9jID0gcmF3IGFzIHtcbiAgICAgICAgaWQ6IHN0cmluZztcbiAgICAgICAgbGFiZWw/OiBzdHJpbmc7XG4gICAgICAgIHN0YXR1cz86IHN0cmluZztcbiAgICAgICAgYWxpdmU/OiBib29sZWFuO1xuICAgICAgICBleGl0Q29kZT86IG51bWJlciB8IG51bGw7XG4gICAgICAgIHNpZ25hbD86IHN0cmluZyB8IG51bGw7XG4gICAgICAgIHJlY2VudEVycm9ycz86IHN0cmluZ1tdO1xuICAgICAgfTtcblxuICAgICAgY29uc3QgbmFtZSA9IHByb2MubGFiZWwgfHwgcHJvYy5pZCB8fCBpZDtcblxuICAgICAgLy8gQ2hlY2sgZm9yIGZhdGFsIHNpZ25hbCBmaXJzdCAoYXBwbGllcyByZWdhcmRsZXNzIG9mIGFsaXZlL3N0YXR1cylcbiAgICAgIGlmIChwcm9jLnNpZ25hbCAmJiBGQVRBTF9TSUdOQUxTLmhhcyhwcm9jLnNpZ25hbCkpIHtcbiAgICAgICAgZXJyb3JzLnB1c2goe1xuICAgICAgICAgIHNvdXJjZTogXCJiZy1zaGVsbFwiLFxuICAgICAgICAgIHNldmVyaXR5OiBcImNyYXNoXCIsXG4gICAgICAgICAgbWVzc2FnZTogYnVpbGRCZ1NoZWxsTWVzc2FnZShuYW1lLCBwcm9jLmV4aXRDb2RlLCBwcm9jLnNpZ25hbCwgcHJvYy5yZWNlbnRFcnJvcnMpLFxuICAgICAgICAgIGJsb2NraW5nOiB0cnVlLFxuICAgICAgICB9KTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIC8vIENyYXNoZWQgc3RhdHVzXG4gICAgICBpZiAocHJvYy5zdGF0dXMgPT09IFwiY3Jhc2hlZFwiKSB7XG4gICAgICAgIGVycm9ycy5wdXNoKHtcbiAgICAgICAgICBzb3VyY2U6IFwiYmctc2hlbGxcIixcbiAgICAgICAgICBzZXZlcml0eTogXCJjcmFzaFwiLFxuICAgICAgICAgIG1lc3NhZ2U6IGJ1aWxkQmdTaGVsbE1lc3NhZ2UobmFtZSwgcHJvYy5leGl0Q29kZSwgcHJvYy5zaWduYWwsIHByb2MucmVjZW50RXJyb3JzKSxcbiAgICAgICAgICBibG9ja2luZzogdHJ1ZSxcbiAgICAgICAgfSk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICAvLyBOb24temVybyBleGl0IG9uIGRlYWQgcHJvY2Vzc1xuICAgICAgaWYgKFxuICAgICAgICAhcHJvYy5hbGl2ZSAmJlxuICAgICAgICBwcm9jLmV4aXRDb2RlICE9PSAwICYmXG4gICAgICAgIHByb2MuZXhpdENvZGUgIT09IG51bGwgJiZcbiAgICAgICAgcHJvYy5leGl0Q29kZSAhPT0gdW5kZWZpbmVkXG4gICAgICApIHtcbiAgICAgICAgZXJyb3JzLnB1c2goe1xuICAgICAgICAgIHNvdXJjZTogXCJiZy1zaGVsbFwiLFxuICAgICAgICAgIHNldmVyaXR5OiBcImNyYXNoXCIsXG4gICAgICAgICAgbWVzc2FnZTogYnVpbGRCZ1NoZWxsTWVzc2FnZShuYW1lLCBwcm9jLmV4aXRDb2RlLCBwcm9jLnNpZ25hbCwgcHJvYy5yZWNlbnRFcnJvcnMpLFxuICAgICAgICAgIGJsb2NraW5nOiB0cnVlLFxuICAgICAgICB9KTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIC8vIEFsaXZlIHByb2Nlc3Mgd2l0aCByZWNlbnQgZXJyb3JzIFx1MjAxNCBub24tYmxvY2tpbmdcbiAgICAgIGlmIChwcm9jLmFsaXZlICYmIHByb2MucmVjZW50RXJyb3JzICYmIHByb2MucmVjZW50RXJyb3JzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgY29uc3Qgc25pcHBldCA9IHByb2MucmVjZW50RXJyb3JzLnNsaWNlKDAsIDMpLmpvaW4oXCI7IFwiKTtcbiAgICAgICAgZXJyb3JzLnB1c2goe1xuICAgICAgICAgIHNvdXJjZTogXCJiZy1zaGVsbFwiLFxuICAgICAgICAgIHNldmVyaXR5OiBcImVycm9yXCIsXG4gICAgICAgICAgbWVzc2FnZTogYFske25hbWV9XSByZWNlbnQgZXJyb3JzOiAke3NuaXBwZXR9YCxcbiAgICAgICAgICBibG9ja2luZzogZmFsc2UsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gYmctc2hlbGwgbm90IGF2YWlsYWJsZSBcdTIwMTQgc2tpcCBzaWxlbnRseVxuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwIGJyb3dzZXIgY29uc29sZSBzY2FuIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICB0cnkge1xuICAgIGxldCBsb2dzOiBBcnJheTx7IHR5cGU6IHN0cmluZzsgdGV4dDogc3RyaW5nOyB0aW1lc3RhbXA6IG51bWJlcjsgdXJsOiBzdHJpbmcgfT47XG4gICAgaWYgKG9wdGlvbnM/LmdldENvbnNvbGVMb2dzKSB7XG4gICAgICBsb2dzID0gb3B0aW9ucy5nZXRDb25zb2xlTG9ncygpO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBtb2QgPSBhd2FpdCBpbXBvcnQoXCIuLi9icm93c2VyLXRvb2xzL3N0YXRlLmpzXCIpO1xuICAgICAgbG9ncyA9IG1vZC5nZXRDb25zb2xlTG9ncygpO1xuICAgIH1cblxuICAgIGZvciAoY29uc3QgZW50cnkgb2YgbG9ncykge1xuICAgICAgY29uc3QgdGV4dCA9XG4gICAgICAgIGVudHJ5LnRleHQubGVuZ3RoID4gTUFYX0JST1dTRVJfVEVYVF9DSEFSU1xuICAgICAgICAgID8gZW50cnkudGV4dC5zbGljZSgwLCBNQVhfQlJPV1NFUl9URVhUX0NIQVJTKSArIFwiXHUyMDI2W3RydW5jYXRlZF1cIlxuICAgICAgICAgIDogZW50cnkudGV4dDtcblxuICAgICAgaWYgKGVudHJ5LnR5cGUgPT09IFwiZXJyb3JcIikge1xuICAgICAgICAvLyBVbmhhbmRsZWQgcmVqZWN0aW9uIC8gdW5oYW5kbGVkIGVycm9yIFx1MjE5MiBibG9ja2luZyBjcmFzaFxuICAgICAgICBpZiAoL3VuaGFuZGxlZC9pLnRlc3QoZW50cnkudGV4dCkpIHtcbiAgICAgICAgICBlcnJvcnMucHVzaCh7XG4gICAgICAgICAgICBzb3VyY2U6IFwiYnJvd3NlclwiLFxuICAgICAgICAgICAgc2V2ZXJpdHk6IFwiY3Jhc2hcIixcbiAgICAgICAgICAgIG1lc3NhZ2U6IHRleHQsXG4gICAgICAgICAgICBibG9ja2luZzogdHJ1ZSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAvLyBHZW5lcmFsIGNvbnNvbGUuZXJyb3IgXHUyMTkyIG5vbi1ibG9ja2luZyBlcnJvclxuICAgICAgICAgIGVycm9ycy5wdXNoKHtcbiAgICAgICAgICAgIHNvdXJjZTogXCJicm93c2VyXCIsXG4gICAgICAgICAgICBzZXZlcml0eTogXCJlcnJvclwiLFxuICAgICAgICAgICAgbWVzc2FnZTogdGV4dCxcbiAgICAgICAgICAgIGJsb2NraW5nOiBmYWxzZSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIGlmIChlbnRyeS50eXBlID09PSBcIndhcm5pbmdcIiAmJiAvZGVwcmVjYXRlZC9pLnRlc3QoZW50cnkudGV4dCkpIHtcbiAgICAgICAgLy8gRGVwcmVjYXRpb24gd2FybmluZyBcdTIxOTIgbm9uLWJsb2NraW5nIHdhcm5pbmdcbiAgICAgICAgZXJyb3JzLnB1c2goe1xuICAgICAgICAgIHNvdXJjZTogXCJicm93c2VyXCIsXG4gICAgICAgICAgc2V2ZXJpdHk6IFwid2FybmluZ1wiLFxuICAgICAgICAgIG1lc3NhZ2U6IHRleHQsXG4gICAgICAgICAgYmxvY2tpbmc6IGZhbHNlLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICAgIC8vIE5vbi1kZXByZWNhdGlvbiB3YXJuaW5ncyBhcmUgaW50ZW50aW9uYWxseSBpZ25vcmVkXG4gICAgfVxuICB9IGNhdGNoIHtcbiAgICAvLyBicm93c2VyLXRvb2xzIG5vdCBhdmFpbGFibGUgXHUyMDE0IHNraXAgc2lsZW50bHlcbiAgfVxuXG4gIHJldHVybiBlcnJvcnM7XG59XG5cbi8qKiBCdWlsZCBhIGh1bWFuLXJlYWRhYmxlIG1lc3NhZ2UgZm9yIGEgYmctc2hlbGwgcHJvY2VzcyBlcnJvci4gKi9cbmZ1bmN0aW9uIGJ1aWxkQmdTaGVsbE1lc3NhZ2UoXG4gIG5hbWU6IHN0cmluZyxcbiAgZXhpdENvZGU6IG51bWJlciB8IG51bGwgfCB1bmRlZmluZWQsXG4gIHNpZ25hbDogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCxcbiAgcmVjZW50RXJyb3JzOiBzdHJpbmdbXSB8IHVuZGVmaW5lZCxcbik6IHN0cmluZyB7XG4gIGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtgWyR7bmFtZX1dYF07XG4gIGlmIChzaWduYWwpIHBhcnRzLnB1c2goYHNpZ25hbD0ke3NpZ25hbH1gKTtcbiAgaWYgKGV4aXRDb2RlICE9PSBudWxsICYmIGV4aXRDb2RlICE9PSB1bmRlZmluZWQpIHBhcnRzLnB1c2goYGV4aXRDb2RlPSR7ZXhpdENvZGV9YCk7XG4gIGlmIChyZWNlbnRFcnJvcnMgJiYgcmVjZW50RXJyb3JzLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCBzbmlwcGV0ID0gcmVjZW50RXJyb3JzLnNsaWNlKDAsIDMpLmpvaW4oXCI7IFwiKTtcbiAgICBwYXJ0cy5wdXNoKGBlcnJvcnM6ICR7c25pcHBldH1gKTtcbiAgfVxuICByZXR1cm4gcGFydHMuam9pbihcIiBcIik7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBEZXBlbmRlbmN5IEF1ZGl0IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKiogVG9wLWxldmVsIGRlcGVuZGVuY3kgZmlsZXMgdGhhdCB0cmlnZ2VyIGFuIGF1ZGl0IHdoZW4gY2hhbmdlZC4gKi9cbmNvbnN0IERFUEVOREVOQ1lfRklMRVMgPSBuZXcgU2V0KFtcbiAgXCJwYWNrYWdlLmpzb25cIixcbiAgXCJwYWNrYWdlLWxvY2suanNvblwiLFxuICBcInBucG0tbG9jay55YW1sXCIsXG4gIFwieWFybi5sb2NrXCIsXG4gIFwiYnVuLmxvY2tiXCIsXG5dKTtcblxuLyoqXG4gKiBJbmplY3RhYmxlIGRlcGVuZGVuY2llcyBmb3IgcnVuRGVwZW5kZW5jeUF1ZGl0IChEMDIzIHBhdHRlcm4pLlxuICogV2hlbiBvbWl0dGVkIHRoZSBmdW5jdGlvbiB1c2VzIHJlYWwgZ2l0L25wbSB2aWEgc3Bhd25TeW5jLlxuICogUHJvdmlkZSBvdmVycmlkZXMgaW4gdGVzdHMgdG8gYXZvaWQgcmVhbCBnaXQgcmVwb3MgYW5kIG5wbSByZWdpc3RyaWVzLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIERlcGVuZGVuY3lBdWRpdE9wdGlvbnMge1xuICBnaXREaWZmPzogKGN3ZDogc3RyaW5nKSA9PiBzdHJpbmdbXTtcbiAgbnBtQXVkaXQ/OiAoY3dkOiBzdHJpbmcpID0+IHsgc3Rkb3V0OiBzdHJpbmc7IGV4aXRDb2RlOiBudW1iZXIgfTtcbn1cblxuLyoqXG4gKiBEZWZhdWx0IGdpdERpZmY6IHJ1bnMgYGdpdCBkaWZmIC0tbmFtZS1vbmx5IEhFQURgIGFuZCByZXR1cm5zIGZpbGUgcGF0aHMuXG4gKiBSZXR1cm5zIGVtcHR5IGFycmF5IG9uIGFueSBmYWlsdXJlIChub24tZ2l0IGRpciwgZ2l0IG5vdCBmb3VuZCwgZXRjLikuXG4gKi9cbmZ1bmN0aW9uIGRlZmF1bHRHaXREaWZmKGN3ZDogc3RyaW5nKTogc3RyaW5nW10ge1xuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IHNwYXduU3luYyhcImdpdFwiLCBbXCJkaWZmXCIsIFwiLS1uYW1lLW9ubHlcIiwgXCJIRUFEXCJdLCB7XG4gICAgICBjd2QsXG4gICAgICBlbmNvZGluZzogXCJ1dGYtOFwiLFxuICAgICAgdGltZW91dDogMTBfMDAwLFxuICAgIH0pO1xuICAgIGlmIChyZXN1bHQuc3RhdHVzICE9PSAwIHx8ICFyZXN1bHQuc3Rkb3V0KSByZXR1cm4gW107XG4gICAgcmV0dXJuIHJlc3VsdC5zdGRvdXQudHJpbSgpLnNwbGl0KFwiXFxuXCIpLmZpbHRlcihCb29sZWFuKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG59XG5cbi8qKlxuICogRGVmYXVsdCBucG1BdWRpdDogcnVucyBgbnBtIGF1ZGl0IC0tYXVkaXQtbGV2ZWw9bW9kZXJhdGUgLS1qc29uYC5cbiAqIFJldHVybnMgeyBzdGRvdXQsIGV4aXRDb2RlIH0uIE5vbi16ZXJvIGV4aXQgaXMgZXhwZWN0ZWQgd2hlbiB2dWxuZXJhYmlsaXRpZXMgZXhpc3QuXG4gKi9cbmZ1bmN0aW9uIGRlZmF1bHROcG1BdWRpdChjd2Q6IHN0cmluZyk6IHsgc3Rkb3V0OiBzdHJpbmc7IGV4aXRDb2RlOiBudW1iZXIgfSB7XG4gIGNvbnN0IHJlc3VsdCA9IHNwYXduU3luYyhcIm5wbVwiLCBbXCJhdWRpdFwiLCBcIi0tYXVkaXQtbGV2ZWw9bW9kZXJhdGVcIiwgXCItLWpzb25cIl0sIHtcbiAgICBjd2QsXG4gICAgZW5jb2Rpbmc6IFwidXRmLThcIixcbiAgICB0aW1lb3V0OiA2MF8wMDAsXG4gIH0pO1xuICByZXR1cm4ge1xuICAgIHN0ZG91dDogcmVzdWx0LnN0ZG91dCA/PyBcIlwiLFxuICAgIGV4aXRDb2RlOiByZXN1bHQuc3RhdHVzID8/IDEsXG4gIH07XG59XG5cbi8qKlxuICogRGV0ZWN0IGRlcGVuZGVuY3kgZmlsZSBjaGFuZ2VzIGFuZCBydW4gbnBtIGF1ZGl0IGlmIGNoYW5nZXMgYXJlIGZvdW5kLlxuICpcbiAqIC0gQ2FsbHMgZ2l0RGlmZiB0byBnZXQgY2hhbmdlZCBmaWxlcywgY2hlY2tzIGlmIGFueSBhcmUgdG9wLWxldmVsIGRlcGVuZGVuY3kgZmlsZXNcbiAqIC0gSWYgbm8gZGVwZW5kZW5jeSBmaWxlcyBjaGFuZ2VkLCByZXR1cm5zIFtdXG4gKiAtIFJ1bnMgbnBtQXVkaXQgYW5kIHBhcnNlcyBKU09OIG91dHB1dCBpbnRvIEF1ZGl0V2FybmluZ1tdXG4gKiAtIE5ldmVyIHRocm93cyBcdTIwMTQgYWxsIGVycm9ycyByZXR1cm4gW11cbiAqIC0gTm9uLXplcm8gbnBtIGF1ZGl0IGV4aXQgY29kZSBpcyBleHBlY3RlZCAodnVsbmVyYWJpbGl0aWVzIGZvdW5kKSwgbm90IGFuIGVycm9yXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBydW5EZXBlbmRlbmN5QXVkaXQoXG4gIGN3ZDogc3RyaW5nLFxuICBvcHRpb25zPzogRGVwZW5kZW5jeUF1ZGl0T3B0aW9ucyxcbik6IEF1ZGl0V2FybmluZ1tdIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBnaXREaWZmID0gb3B0aW9ucz8uZ2l0RGlmZiA/PyBkZWZhdWx0R2l0RGlmZjtcbiAgICBjb25zdCBucG1BdWRpdCA9IG9wdGlvbnM/Lm5wbUF1ZGl0ID8/IGRlZmF1bHROcG1BdWRpdDtcblxuICAgIC8vIEdldCBjaGFuZ2VkIGZpbGVzIGFuZCBjaGVjayBmb3IgdG9wLWxldmVsIGRlcGVuZGVuY3kgZmlsZSBtYXRjaGVzXG4gICAgY29uc3QgY2hhbmdlZEZpbGVzID0gZ2l0RGlmZihjd2QpO1xuICAgIGNvbnN0IGhhc0RlcGVuZGVuY3lDaGFuZ2UgPSBjaGFuZ2VkRmlsZXMuc29tZSgoZmlsZVBhdGgpID0+IHtcbiAgICAgIGNvbnN0IG5hbWUgPSBiYXNlbmFtZShmaWxlUGF0aCk7XG4gICAgICAvLyBPbmx5IG1hdGNoIHRvcC1sZXZlbCBmaWxlczogdGhlIHBhdGggbXVzdCBlcXVhbCBqdXN0IHRoZSBmaWxlbmFtZVxuICAgICAgLy8gKG5vIGRpcmVjdG9yeSBzZXBhcmF0b3JzKSB0byBiZSBjb25zaWRlcmVkIHRvcC1sZXZlbFxuICAgICAgcmV0dXJuIERFUEVOREVOQ1lfRklMRVMuaGFzKG5hbWUpICYmIGZpbGVQYXRoID09PSBuYW1lO1xuICAgIH0pO1xuXG4gICAgaWYgKCFoYXNEZXBlbmRlbmN5Q2hhbmdlKSByZXR1cm4gW107XG5cbiAgICAvLyBSdW4gbnBtIGF1ZGl0XG4gICAgY29uc3QgYXVkaXRSZXN1bHQgPSBucG1BdWRpdChjd2QpO1xuXG4gICAgLy8gUGFyc2UgSlNPTiBvdXRwdXQgXHUyMDE0IG5wbSBhdWRpdCBleGl0cyBub24temVybyB3aGVuIHZ1bG5lcmFiaWxpdGllcyBleGlzdFxuICAgIGxldCBwYXJzZWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIHRyeSB7XG4gICAgICBwYXJzZWQgPSBKU09OLnBhcnNlKGF1ZGl0UmVzdWx0LnN0ZG91dCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gW107XG4gICAgfVxuXG4gICAgLy8gRXh0cmFjdCB2dWxuZXJhYmlsaXRpZXMgZnJvbSB0aGUgcGFyc2VkIG91dHB1dFxuICAgIGNvbnN0IHZ1bG5lcmFiaWxpdGllcyA9IHBhcnNlZC52dWxuZXJhYmlsaXRpZXM7XG4gICAgaWYgKCF2dWxuZXJhYmlsaXRpZXMgfHwgdHlwZW9mIHZ1bG5lcmFiaWxpdGllcyAhPT0gXCJvYmplY3RcIikgcmV0dXJuIFtdO1xuXG4gICAgY29uc3Qgd2FybmluZ3M6IEF1ZGl0V2FybmluZ1tdID0gW107XG4gICAgZm9yIChjb25zdCBbbmFtZSwgcmF3XSBvZiBPYmplY3QuZW50cmllcyh2dWxuZXJhYmlsaXRpZXMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pKSB7XG4gICAgICBjb25zdCB2dWxuID0gcmF3IGFzIHtcbiAgICAgICAgc2V2ZXJpdHk/OiBzdHJpbmc7XG4gICAgICAgIGZpeEF2YWlsYWJsZT86IGJvb2xlYW47XG4gICAgICAgIHZpYT86IHVua25vd25bXTtcbiAgICAgIH07XG4gICAgICBpZiAoIXZ1bG4gfHwgdHlwZW9mIHZ1bG4gIT09IFwib2JqZWN0XCIpIGNvbnRpbnVlO1xuXG4gICAgICBjb25zdCBzZXZlcml0eSA9IHZ1bG4uc2V2ZXJpdHk7XG4gICAgICBpZiAoXG4gICAgICAgIHNldmVyaXR5ICE9PSBcImxvd1wiICYmXG4gICAgICAgIHNldmVyaXR5ICE9PSBcIm1vZGVyYXRlXCIgJiZcbiAgICAgICAgc2V2ZXJpdHkgIT09IFwiaGlnaFwiICYmXG4gICAgICAgIHNldmVyaXR5ICE9PSBcImNyaXRpY2FsXCJcbiAgICAgICkge1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgLy8gRmluZCB0aGUgZmlyc3QgYHZpYWAgZW50cnkgdGhhdCdzIGFuIG9iamVjdCAobm90IGEgc3RyaW5nIHJlZmVyZW5jZSlcbiAgICAgIGxldCB0aXRsZSA9IG5hbWU7XG4gICAgICBsZXQgdXJsID0gXCJcIjtcbiAgICAgIGlmIChBcnJheS5pc0FycmF5KHZ1bG4udmlhKSkge1xuICAgICAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIHZ1bG4udmlhKSB7XG4gICAgICAgICAgaWYgKGVudHJ5ICYmIHR5cGVvZiBlbnRyeSA9PT0gXCJvYmplY3RcIiAmJiAhQXJyYXkuaXNBcnJheShlbnRyeSkpIHtcbiAgICAgICAgICAgIGNvbnN0IG9iaiA9IGVudHJ5IGFzIHsgdGl0bGU/OiBzdHJpbmc7IHVybD86IHN0cmluZyB9O1xuICAgICAgICAgICAgaWYgKG9iai50aXRsZSkgdGl0bGUgPSBvYmoudGl0bGU7XG4gICAgICAgICAgICBpZiAob2JqLnVybCkgdXJsID0gb2JqLnVybDtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICB3YXJuaW5ncy5wdXNoKHtcbiAgICAgICAgbmFtZSxcbiAgICAgICAgc2V2ZXJpdHk6IHNldmVyaXR5IGFzIEF1ZGl0V2FybmluZ1tcInNldmVyaXR5XCJdLFxuICAgICAgICB0aXRsZSxcbiAgICAgICAgdXJsLFxuICAgICAgICBmaXhBdmFpbGFibGU6IHZ1bG4uZml4QXZhaWxhYmxlID09PSB0cnVlLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHdhcm5pbmdzO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gW107XG4gIH1cbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUtBLFNBQVMsaUJBQXdDO0FBQ2pELFNBQVMsWUFBWSxjQUFjLG1CQUFnQztBQUNuRSxTQUFTLE1BQU0sZ0JBQWdCO0FBRS9CLFNBQVMsa0NBQWtDO0FBQzNDLFNBQVMsNkJBQTZCO0FBQ3RDLFNBQVMsOEJBQThCO0FBR3ZDLE1BQU0sbUJBQW1CLEtBQUs7QUFHOUIsU0FBUyxTQUFTLE9BQWtDLFVBQTBCO0FBQzVFLE1BQUksQ0FBQyxNQUFPLFFBQU87QUFDbkIsTUFBSSxPQUFPLFdBQVcsT0FBTyxPQUFPLEtBQUssU0FBVSxRQUFPO0FBRTFELFFBQU0sTUFBTSxPQUFPLEtBQUssT0FBTyxPQUFPLEVBQUUsU0FBUyxHQUFHLFFBQVE7QUFDNUQsU0FBTyxJQUFJLFNBQVMsT0FBTyxJQUFJO0FBQ2pDO0FBZ0JBLE1BQU0sc0JBQXNCLENBQUMsYUFBYSxRQUFRLE1BQU07QUFVakQsU0FBUyxpQkFBaUIsU0FBc0Q7QUFFckYsTUFBSSxRQUFRLHNCQUFzQixRQUFRLG1CQUFtQixTQUFTLEdBQUc7QUFDdkUsVUFBTSxXQUFXLFFBQVEsbUJBQ3RCLElBQUksT0FBSyxFQUFFLEtBQUssQ0FBQyxFQUNqQixPQUFPLE9BQU87QUFDakIsUUFBSSxTQUFTLFNBQVMsR0FBRztBQUN2QixhQUFPLEVBQUUsVUFBVSxVQUFVLFFBQVEsYUFBYTtBQUFBLElBQ3BEO0FBQUEsRUFDRjtBQUdBLE1BQUksUUFBUSxrQkFBa0IsUUFBUSxlQUFlLEtBQUssR0FBRztBQUMzRCxVQUFNLFdBQVcsUUFBUSxlQUN0QixNQUFNLElBQUksRUFDVixJQUFJLE9BQUssRUFBRSxLQUFLLENBQUMsRUFDakIsT0FBTyxPQUFPLEVBQ2Qs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
