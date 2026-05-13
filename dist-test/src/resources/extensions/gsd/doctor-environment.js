import { existsSync, readFileSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { detectPythonExecutable } from "./python-resolver.js";
const DEFAULT_DEV_PORTS = [3e3, 3001, 4e3, 5e3, 5173, 8e3, 8080, 8888];
const MIN_DISK_BYTES = 500 * 1024 * 1024;
const CMD_TIMEOUT = 5e3;
const WORKTREE_PATH_SEGMENT = `${join(".gsd", "worktrees")}/`;
function resolveWorktreeProjectRoot(basePath) {
  const envRoot = process.env.GSD_WORKTREE;
  if (envRoot) return envRoot;
  const normalised = basePath.replace(/\\/g, "/");
  const idx = normalised.indexOf(WORKTREE_PATH_SEGMENT.replace(/\\/g, "/"));
  if (idx === -1) return null;
  return basePath.slice(0, idx);
}
function tryExec(cmd, cwd) {
  try {
    return execSync(cmd, {
      cwd,
      timeout: CMD_TIMEOUT,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8"
    }).trim();
  } catch {
    return null;
  }
}
function commandExists(name, cwd) {
  const whichCmd = process.platform === "win32" ? `where ${name}` : `command -v ${name}`;
  return tryExec(whichCmd, cwd) !== null;
}
function checkNodeVersion(basePath) {
  const pkgPath = join(basePath, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const required = pkg.engines?.node;
    if (!required) return null;
    const currentVersion = tryExec("node --version", basePath);
    if (!currentVersion) {
      return { name: "node_version", status: "error", message: "Node.js not found in PATH" };
    }
    const reqMatch = required.match(/>=?\s*(\d+)(?:\.(\d+))?/);
    if (!reqMatch) return null;
    const reqMajor = parseInt(reqMatch[1], 10);
    const reqMinor = parseInt(reqMatch[2] ?? "0", 10);
    const curMatch = currentVersion.match(/v?(\d+)\.(\d+)/);
    if (!curMatch) return null;
    const curMajor = parseInt(curMatch[1], 10);
    const curMinor = parseInt(curMatch[2], 10);
    if (curMajor < reqMajor || curMajor === reqMajor && curMinor < reqMinor) {
      return {
        name: "node_version",
        status: "warning",
        message: `Node.js ${currentVersion} does not meet requirement "${required}"`,
        detail: `Current: ${currentVersion}, Required: ${required}`
      };
    }
    return { name: "node_version", status: "ok", message: `Node.js ${currentVersion}` };
  } catch {
    return null;
  }
}
function checkDependenciesInstalled(basePath) {
  const pkgPath = join(basePath, "package.json");
  if (!existsSync(pkgPath)) return null;
  const nodeModules = join(basePath, "node_modules");
  if (!existsSync(nodeModules)) {
    const projectRoot = resolveWorktreeProjectRoot(basePath);
    if (projectRoot && existsSync(join(projectRoot, "node_modules"))) {
      return { name: "dependencies", status: "ok", message: "Dependencies installed (project root)" };
    }
    return {
      name: "dependencies",
      status: "error",
      message: "node_modules missing \u2014 run npm install"
    };
  }
  const lockfiles = [
    { lock: "package-lock.json", markers: ["node_modules/.package-lock.json"] },
    { lock: "yarn.lock", markers: ["node_modules/.yarn-integrity"] },
    { lock: "pnpm-lock.yaml", markers: ["node_modules/.modules.yaml"] }
  ];
  for (const { lock, markers } of lockfiles) {
    const lockPath = join(basePath, lock);
    if (!existsSync(lockPath)) continue;
    try {
      const lockMtime = statSync(lockPath).mtimeMs;
      let installMtime = 0;
      for (const marker of markers) {
        const markerPath = join(basePath, marker);
        if (existsSync(markerPath)) {
          installMtime = Math.max(installMtime, statSync(markerPath).mtimeMs);
        }
      }
      if (installMtime === 0) {
        installMtime = statSync(nodeModules).mtimeMs;
      }
      if (lockMtime > installMtime) {
        return {
          name: "dependencies",
          status: "warning",
          message: `${lock} is newer than node_modules \u2014 dependencies may be stale`,
          detail: `Run npm install / yarn / pnpm install to update`
        };
      }
    } catch {
    }
  }
  return { name: "dependencies", status: "ok", message: "Dependencies installed" };
}
function checkEnvFiles(basePath) {
  const examplePath = join(basePath, ".env.example");
  if (!existsSync(examplePath)) return null;
  const envPath = join(basePath, ".env");
  const envLocalPath = join(basePath, ".env.local");
  if (!existsSync(envPath) && !existsSync(envLocalPath)) {
    return {
      name: "env_file",
      status: "warning",
      message: ".env.example exists but no .env or .env.local found",
      detail: "Copy .env.example to .env and fill in values"
    };
  }
  return { name: "env_file", status: "ok", message: "Environment file present" };
}
function checkPortConflicts(basePath) {
  if (process.platform === "win32") return [];
  const results = [];
  const portsToCheck = /* @__PURE__ */ new Set();
  const pkgPath = join(basePath, "package.json");
  if (!existsSync(pkgPath)) {
    return [];
  }
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const scripts = pkg.scripts ?? {};
    const scriptText = Object.values(scripts).join(" ");
    const portMatches = scriptText.matchAll(/(?:--port\s+|(?:^|[^a-z])PORT[=:]\s*|-p\s+|:)(\d{4,5})\b/gi);
    for (const m of portMatches) {
      const port = parseInt(m[1], 10);
      if (port >= 1024 && port <= 65535) portsToCheck.add(port);
    }
  } catch {
    return [];
  }
  if (portsToCheck.size === 0) {
    for (const p of DEFAULT_DEV_PORTS) {
      if (p === 5e3 && process.platform === "darwin") continue;
      portsToCheck.add(p);
    }
  }
  for (const port of portsToCheck) {
    const result = tryExec(`lsof -i :${port} -sTCP:LISTEN -t`, basePath);
    if (result && result.length > 0) {
      const nameResult = tryExec(`lsof -i :${port} -sTCP:LISTEN -Fp | head -2`, basePath);
      const processName = nameResult?.match(/p(\d+)\n?c?(.+)?/)?.[2] ?? "unknown";
      results.push({
        name: "port_conflict",
        status: "warning",
        message: `Port ${port} is already in use by ${processName} (PID ${result.split("\n")[0]})`,
        detail: `Kill the process or use a different port`
      });
    }
  }
  return results;
}
function checkDiskSpace(basePath) {
  if (process.platform === "win32") return null;
  const dfOutput = tryExec(`df -k "${basePath}" | tail -1`, basePath);
  if (!dfOutput) return null;
  try {
    const parts = dfOutput.split(/\s+/);
    const availKB = parseInt(parts[3], 10);
    if (isNaN(availKB)) return null;
    const availBytes = availKB * 1024;
    const availMB = Math.round(availBytes / (1024 * 1024));
    const availGB = (availBytes / (1024 * 1024 * 1024)).toFixed(1);
    if (availBytes < MIN_DISK_BYTES) {
      return {
        name: "disk_space",
        status: "error",
        message: `Low disk space: ${availMB}MB free`,
        detail: `Free up space \u2014 builds and git operations may fail`
      };
    }
    if (availBytes < MIN_DISK_BYTES * 4) {
      return {
        name: "disk_space",
        status: "warning",
        message: `Disk space getting low: ${availGB}GB free`
      };
    }
    return { name: "disk_space", status: "ok", message: `${availGB}GB free` };
  } catch {
    return null;
  }
}
function checkDocker(basePath) {
  const hasDockerfile = existsSync(join(basePath, "Dockerfile")) || existsSync(join(basePath, "docker-compose.yml")) || existsSync(join(basePath, "docker-compose.yaml")) || existsSync(join(basePath, "compose.yml")) || existsSync(join(basePath, "compose.yaml"));
  if (!hasDockerfile) return null;
  if (!commandExists("docker", basePath)) {
    return {
      name: "docker",
      status: "warning",
      message: "Project has Docker files but docker is not installed"
    };
  }
  const info = tryExec("docker info --format '{{.ServerVersion}}'", basePath);
  if (!info) {
    return {
      name: "docker",
      status: "warning",
      message: "Docker is installed but daemon is not running",
      detail: "Start Docker Desktop or the docker daemon"
    };
  }
  return { name: "docker", status: "ok", message: `Docker ${info}` };
}
function checkProjectTools(basePath) {
  const results = [];
  const pkgPath = join(basePath, "package.json");
  if (!existsSync(pkgPath)) return results;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const allDeps = {
      ...pkg.dependencies ?? {},
      ...pkg.devDependencies ?? {}
    };
    const packageManager = pkg.packageManager;
    if (packageManager) {
      const managerName = packageManager.split("@")[0];
      if (managerName && managerName !== "npm" && !commandExists(managerName, basePath)) {
        results.push({
          name: "package_manager",
          status: "warning",
          message: `Project requires ${managerName} but it's not installed`,
          detail: `Install with: npm install -g ${managerName}`
        });
      }
    }
    if (allDeps["typescript"] && !existsSync(join(basePath, "node_modules", ".bin", "tsc"))) {
      results.push({
        name: "typescript",
        status: "warning",
        message: "TypeScript is a dependency but tsc is not available (run npm install)"
      });
    }
    if (existsSync(join(basePath, "pyproject.toml")) || existsSync(join(basePath, "requirements.txt"))) {
      if (detectPythonExecutable() === null) {
        results.push({
          name: "python",
          status: "warning",
          message: "Project has Python config but python is not installed"
        });
      }
    }
    if (existsSync(join(basePath, "Cargo.toml"))) {
      if (!commandExists("cargo", basePath)) {
        results.push({
          name: "cargo",
          status: "warning",
          message: "Project has Cargo.toml but cargo is not installed"
        });
      }
    }
    if (existsSync(join(basePath, "go.mod"))) {
      if (!commandExists("go", basePath)) {
        results.push({
          name: "go",
          status: "warning",
          message: "Project has go.mod but go is not installed"
        });
      }
    }
  } catch {
  }
  return results;
}
function checkGitRemote(basePath) {
  const remote = tryExec("git remote get-url origin", basePath);
  if (!remote) return null;
  const result = tryExec("git ls-remote --exit-code -h origin HEAD", basePath);
  if (result === null) {
    return {
      name: "git_remote",
      status: "warning",
      message: "Git remote 'origin' is unreachable",
      detail: `Remote: ${remote}`
    };
  }
  return { name: "git_remote", status: "ok", message: "Git remote reachable" };
}
function checkBuildHealth(basePath) {
  const pkgPath = join(basePath, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const buildScript = pkg.scripts?.build;
    if (!buildScript) return null;
    const result = tryExec("npm run build 2>&1", basePath);
    if (result === null) {
      return {
        name: "build",
        status: "error",
        message: "Build failed \u2014 npm run build exited non-zero",
        detail: "Fix build errors before dispatching work"
      };
    }
    return { name: "build", status: "ok", message: "Build passes" };
  } catch {
    return null;
  }
}
function checkTestHealth(basePath) {
  const pkgPath = join(basePath, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const testScript = pkg.scripts?.test;
    if (!testScript || testScript.includes("no test specified")) return null;
    const result = tryExec("npm test 2>&1", basePath);
    if (result === null) {
      return {
        name: "test",
        status: "warning",
        message: "Tests failing \u2014 npm test exited non-zero",
        detail: "Fix failing tests before shipping"
      };
    }
    return { name: "test", status: "ok", message: "Tests pass" };
  } catch {
    return null;
  }
}
function runEnvironmentChecks(basePath) {
  const results = [];
  const nodeCheck = checkNodeVersion(basePath);
  if (nodeCheck) results.push(nodeCheck);
  const depsCheck = checkDependenciesInstalled(basePath);
  if (depsCheck) results.push(depsCheck);
  const envCheck = checkEnvFiles(basePath);
  if (envCheck) results.push(envCheck);
  results.push(...checkPortConflicts(basePath));
  const diskCheck = checkDiskSpace(basePath);
  if (diskCheck) results.push(diskCheck);
  const dockerCheck = checkDocker(basePath);
  if (dockerCheck) results.push(dockerCheck);
  results.push(...checkProjectTools(basePath));
  return results;
}
function runFullEnvironmentChecks(basePath) {
  const results = runEnvironmentChecks(basePath);
  const remoteCheck = checkGitRemote(basePath);
  if (remoteCheck) results.push(remoteCheck);
  return results;
}
function runSlowEnvironmentChecks(basePath, options) {
  const results = [];
  if (options?.includeBuild) {
    const buildCheck = checkBuildHealth(basePath);
    if (buildCheck) results.push(buildCheck);
  }
  if (options?.includeTests) {
    const testCheck = checkTestHealth(basePath);
    if (testCheck) results.push(testCheck);
  }
  return results;
}
function environmentResultsToDoctorIssues(results) {
  return results.filter((r) => r.status !== "ok").map((r) => ({
    severity: r.status === "error" ? "error" : "warning",
    code: `env_${r.name}`,
    scope: "project",
    unitId: "environment",
    message: r.detail ? `${r.message} \u2014 ${r.detail}` : r.message,
    fixable: false
  }));
}
async function checkEnvironmentHealth(basePath, issues, options) {
  const results = options?.includeRemote ? runFullEnvironmentChecks(basePath) : runEnvironmentChecks(basePath);
  if (options?.includeBuild || options?.includeTests) {
    results.push(...runSlowEnvironmentChecks(basePath, options));
  }
  issues.push(...environmentResultsToDoctorIssues(results));
}
function formatEnvironmentReport(results) {
  if (results.length === 0) return "No environment checks applicable.";
  const lines = [];
  lines.push("Environment Health:");
  for (const r of results) {
    const icon = r.status === "ok" ? "\u2705" : r.status === "warning" ? "\u26A0\uFE0F" : "\u{1F6D1}";
    lines.push(`  ${icon} ${r.message}`);
    if (r.detail && r.status !== "ok") {
      lines.push(`     ${r.detail}`);
    }
  }
  return lines.join("\n");
}
export {
  checkEnvironmentHealth,
  environmentResultsToDoctorIssues,
  formatEnvironmentReport,
  runEnvironmentChecks,
  runFullEnvironmentChecks,
  runSlowEnvironmentChecks
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9kb2N0b3ItZW52aXJvbm1lbnQudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogR1NEIERvY3RvciBcdTIwMTQgRW52aXJvbm1lbnQgSGVhbHRoIENoZWNrcyAoIzEyMjEpXG4gKlxuICogRGV0ZXJtaW5pc3RpYyBjaGVja3MgZm9yIGVudmlyb25tZW50IHJlYWRpbmVzcyB0aGF0IHByZXZlbnQgdGhlIG1vZGVsXG4gKiBmcm9tIHNwaW5uaW5nIGl0cyB3aGVlbHMgb24gbWlzc2luZyB0b29scywgcG9ydCBjb25mbGljdHMsIHN0YWxlXG4gKiBkZXBlbmRlbmNpZXMsIGFuZCBvdGhlciBpbmZyYXN0cnVjdHVyZSBpc3N1ZXMuXG4gKlxuICogVGhlc2UgY2hlY2tzIGNvbXBsZW1lbnQgdGhlIGV4aXN0aW5nIGdpdC9ydW50aW1lIGhlYWx0aCBjaGVja3MgYW5kXG4gKiBpbnRlZ3JhdGUgaW50byB0aGUgZG9jdG9yIHBpcGVsaW5lIHZpYSBjaGVja0Vudmlyb25tZW50SGVhbHRoKCkuXG4gKi9cblxuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jLCBzdGF0U3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBleGVjU3luYyB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbmltcG9ydCB0eXBlIHsgRG9jdG9ySXNzdWUsIERvY3Rvcklzc3VlQ29kZSB9IGZyb20gXCIuL2RvY3Rvci10eXBlcy5qc1wiO1xuaW1wb3J0IHsgZGV0ZWN0UHl0aG9uRXhlY3V0YWJsZSB9IGZyb20gXCIuL3B5dGhvbi1yZXNvbHZlci5qc1wiO1xuXG4vLyBcdTI1MDBcdTI1MDAgVHlwZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBpbnRlcmZhY2UgRW52aXJvbm1lbnRDaGVja1Jlc3VsdCB7XG4gIG5hbWU6IHN0cmluZztcbiAgc3RhdHVzOiBcIm9rXCIgfCBcIndhcm5pbmdcIiB8IFwiZXJyb3JcIjtcbiAgbWVzc2FnZTogc3RyaW5nO1xuICBkZXRhaWw/OiBzdHJpbmc7XG59XG5cbi8vIFx1MjUwMFx1MjUwMCBDb25zdGFudHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKiBEZWZhdWx0IGRldiBzZXJ2ZXIgcG9ydHMgdG8gc2NhbiBmb3IgY29uZmxpY3RzLiAqL1xuY29uc3QgREVGQVVMVF9ERVZfUE9SVFMgPSBbMzAwMCwgMzAwMSwgNDAwMCwgNTAwMCwgNTE3MywgODAwMCwgODA4MCwgODg4OF07XG5cbi8qKiBNaW5pbXVtIGZyZWUgZGlzayBzcGFjZSBpbiBieXRlcyAoNTAwTUIpLiAqL1xuY29uc3QgTUlOX0RJU0tfQllURVMgPSA1MDAgKiAxMDI0ICogMTAyNDtcblxuLyoqIFRpbWVvdXQgZm9yIGV4dGVybmFsIGNvbW1hbmRzIChtcykuICovXG5jb25zdCBDTURfVElNRU9VVCA9IDVfMDAwO1xuXG4vLyBcdTI1MDBcdTI1MDAgSGVscGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqIFdvcmt0cmVlIHNlbnRpbmVsIFx1MjAxNCBwYXRoIHNlZ21lbnQgdGhhdCBtYXJrcyBhbiBhdXRvLXdvcmt0cmVlIGRpcmVjdG9yeS4gKi9cbmNvbnN0IFdPUktUUkVFX1BBVEhfU0VHTUVOVCA9IGAke2pvaW4oXCIuZ3NkXCIsIFwid29ya3RyZWVzXCIpfS9gO1xuXG4vKipcbiAqIFJlc29sdmUgdGhlIHByb2plY3Qgcm9vdCB3aGVuIHJ1bm5pbmcgaW5zaWRlIGEgYC5nc2Qvd29ya3RyZWVzLzxuYW1lPi9gXG4gKiBhdXRvLXdvcmt0cmVlLiBSZXR1cm5zIGBudWxsYCBpZiBub3QgaW4gYSB3b3JrdHJlZS5cbiAqXG4gKiBEZXRlY3Rpb24gb3JkZXI6XG4gKiAgIDEuIGBHU0RfV09SS1RSRUVgIGVudiB2YXIgKHNldCBieSB0aGUgd29ya3RyZWUgbGF1bmNoZXIpXG4gKiAgIDIuIGAuZ3NkL3dvcmt0cmVlcy9gIHNlZ21lbnQgaW4gYmFzZVBhdGhcbiAqL1xuZnVuY3Rpb24gcmVzb2x2ZVdvcmt0cmVlUHJvamVjdFJvb3QoYmFzZVBhdGg6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCBlbnZSb290ID0gcHJvY2Vzcy5lbnYuR1NEX1dPUktUUkVFO1xuICBpZiAoZW52Um9vdCkgcmV0dXJuIGVudlJvb3Q7XG5cbiAgY29uc3Qgbm9ybWFsaXNlZCA9IGJhc2VQYXRoLnJlcGxhY2UoL1xcXFwvZywgXCIvXCIpO1xuICBjb25zdCBpZHggPSBub3JtYWxpc2VkLmluZGV4T2YoV09SS1RSRUVfUEFUSF9TRUdNRU5ULnJlcGxhY2UoL1xcXFwvZywgXCIvXCIpKTtcbiAgaWYgKGlkeCA9PT0gLTEpIHJldHVybiBudWxsO1xuXG4gIC8vIEV2ZXJ5dGhpbmcgYmVmb3JlIGAuZ3NkL3dvcmt0cmVlcy9gIGlzIHRoZSBwcm9qZWN0IHJvb3RcbiAgcmV0dXJuIGJhc2VQYXRoLnNsaWNlKDAsIGlkeCk7XG59XG5cbmZ1bmN0aW9uIHRyeUV4ZWMoY21kOiBzdHJpbmcsIGN3ZDogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIGV4ZWNTeW5jKGNtZCwge1xuICAgICAgY3dkLFxuICAgICAgdGltZW91dDogQ01EX1RJTUVPVVQsXG4gICAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0sXG4gICAgICBlbmNvZGluZzogXCJ1dGYtOFwiLFxuICAgIH0pLnRyaW0oKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuZnVuY3Rpb24gY29tbWFuZEV4aXN0cyhuYW1lOiBzdHJpbmcsIGN3ZDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IHdoaWNoQ21kID0gcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiID8gYHdoZXJlICR7bmFtZX1gIDogYGNvbW1hbmQgLXYgJHtuYW1lfWA7XG4gIHJldHVybiB0cnlFeGVjKHdoaWNoQ21kLCBjd2QpICE9PSBudWxsO1xufVxuXG4vLyBcdTI1MDBcdTI1MDAgSW5kaXZpZHVhbCBDaGVja3MgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogQ2hlY2sgdGhhdCBOb2RlLmpzIHZlcnNpb24gbWVldHMgdGhlIHByb2plY3QncyBlbmdpbmVzIHJlcXVpcmVtZW50LlxuICovXG5mdW5jdGlvbiBjaGVja05vZGVWZXJzaW9uKGJhc2VQYXRoOiBzdHJpbmcpOiBFbnZpcm9ubWVudENoZWNrUmVzdWx0IHwgbnVsbCB7XG4gIGNvbnN0IHBrZ1BhdGggPSBqb2luKGJhc2VQYXRoLCBcInBhY2thZ2UuanNvblwiKTtcbiAgaWYgKCFleGlzdHNTeW5jKHBrZ1BhdGgpKSByZXR1cm4gbnVsbDtcblxuICB0cnkge1xuICAgIGNvbnN0IHBrZyA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHBrZ1BhdGgsIFwidXRmLThcIikpO1xuICAgIGNvbnN0IHJlcXVpcmVkID0gcGtnLmVuZ2luZXM/Lm5vZGU7XG4gICAgaWYgKCFyZXF1aXJlZCkgcmV0dXJuIG51bGw7XG5cbiAgICBjb25zdCBjdXJyZW50VmVyc2lvbiA9IHRyeUV4ZWMoXCJub2RlIC0tdmVyc2lvblwiLCBiYXNlUGF0aCk7XG4gICAgaWYgKCFjdXJyZW50VmVyc2lvbikge1xuICAgICAgcmV0dXJuIHsgbmFtZTogXCJub2RlX3ZlcnNpb25cIiwgc3RhdHVzOiBcImVycm9yXCIsIG1lc3NhZ2U6IFwiTm9kZS5qcyBub3QgZm91bmQgaW4gUEFUSFwiIH07XG4gICAgfVxuXG4gICAgLy8gUGFyc2Ugc2VtdmVyIHJlcXVpcmVtZW50IChoYW5kbGVzID49WC5ZLlogZm9ybWF0KVxuICAgIGNvbnN0IHJlcU1hdGNoID0gcmVxdWlyZWQubWF0Y2goLz49P1xccyooXFxkKykoPzpcXC4oXFxkKykpPy8pO1xuICAgIGlmICghcmVxTWF0Y2gpIHJldHVybiBudWxsO1xuXG4gICAgY29uc3QgcmVxTWFqb3IgPSBwYXJzZUludChyZXFNYXRjaFsxXSwgMTApO1xuICAgIGNvbnN0IHJlcU1pbm9yID0gcGFyc2VJbnQocmVxTWF0Y2hbMl0gPz8gXCIwXCIsIDEwKTtcblxuICAgIGNvbnN0IGN1ck1hdGNoID0gY3VycmVudFZlcnNpb24ubWF0Y2goL3Y/KFxcZCspXFwuKFxcZCspLyk7XG4gICAgaWYgKCFjdXJNYXRjaCkgcmV0dXJuIG51bGw7XG5cbiAgICBjb25zdCBjdXJNYWpvciA9IHBhcnNlSW50KGN1ck1hdGNoWzFdLCAxMCk7XG4gICAgY29uc3QgY3VyTWlub3IgPSBwYXJzZUludChjdXJNYXRjaFsyXSwgMTApO1xuXG4gICAgaWYgKGN1ck1ham9yIDwgcmVxTWFqb3IgfHwgKGN1ck1ham9yID09PSByZXFNYWpvciAmJiBjdXJNaW5vciA8IHJlcU1pbm9yKSkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgbmFtZTogXCJub2RlX3ZlcnNpb25cIixcbiAgICAgICAgc3RhdHVzOiBcIndhcm5pbmdcIixcbiAgICAgICAgbWVzc2FnZTogYE5vZGUuanMgJHtjdXJyZW50VmVyc2lvbn0gZG9lcyBub3QgbWVldCByZXF1aXJlbWVudCBcIiR7cmVxdWlyZWR9XCJgLFxuICAgICAgICBkZXRhaWw6IGBDdXJyZW50OiAke2N1cnJlbnRWZXJzaW9ufSwgUmVxdWlyZWQ6ICR7cmVxdWlyZWR9YCxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgcmV0dXJuIHsgbmFtZTogXCJub2RlX3ZlcnNpb25cIiwgc3RhdHVzOiBcIm9rXCIsIG1lc3NhZ2U6IGBOb2RlLmpzICR7Y3VycmVudFZlcnNpb259YCB9O1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG4vKipcbiAqIENoZWNrIGlmIG5vZGVfbW9kdWxlcyBleGlzdHMgYW5kIGlzIG5vdCBzdGFsZSB2cyB0aGUgbG9ja2ZpbGUuXG4gKi9cbmZ1bmN0aW9uIGNoZWNrRGVwZW5kZW5jaWVzSW5zdGFsbGVkKGJhc2VQYXRoOiBzdHJpbmcpOiBFbnZpcm9ubWVudENoZWNrUmVzdWx0IHwgbnVsbCB7XG4gIGNvbnN0IHBrZ1BhdGggPSBqb2luKGJhc2VQYXRoLCBcInBhY2thZ2UuanNvblwiKTtcbiAgaWYgKCFleGlzdHNTeW5jKHBrZ1BhdGgpKSByZXR1cm4gbnVsbDtcblxuICBjb25zdCBub2RlTW9kdWxlcyA9IGpvaW4oYmFzZVBhdGgsIFwibm9kZV9tb2R1bGVzXCIpO1xuICBpZiAoIWV4aXN0c1N5bmMobm9kZU1vZHVsZXMpKSB7XG4gICAgLy8gSW4gYXV0by13b3JrdHJlZXMgbm9kZV9tb2R1bGVzIGlzIGFic2VudCBieSBkZXNpZ24gXHUyMDE0IHRoZSB3b3JrdHJlZVxuICAgIC8vIHN5bWxpbmtzIHRvIChvciBleHBlY3RzKSB0aGUgcHJvamVjdCByb290J3MgY29weS4gIEZhbGwgYmFjayB0b1xuICAgIC8vIGNoZWNraW5nIHRoZSBwcm9qZWN0IHJvb3QgYmVmb3JlIHJlcG9ydGluZyBhbiBlcnJvciAoIzIzMDMpLlxuICAgIGNvbnN0IHByb2plY3RSb290ID0gcmVzb2x2ZVdvcmt0cmVlUHJvamVjdFJvb3QoYmFzZVBhdGgpO1xuICAgIGlmIChwcm9qZWN0Um9vdCAmJiBleGlzdHNTeW5jKGpvaW4ocHJvamVjdFJvb3QsIFwibm9kZV9tb2R1bGVzXCIpKSkge1xuICAgICAgcmV0dXJuIHsgbmFtZTogXCJkZXBlbmRlbmNpZXNcIiwgc3RhdHVzOiBcIm9rXCIsIG1lc3NhZ2U6IFwiRGVwZW5kZW5jaWVzIGluc3RhbGxlZCAocHJvamVjdCByb290KVwiIH07XG4gICAgfVxuXG4gICAgcmV0dXJuIHtcbiAgICAgIG5hbWU6IFwiZGVwZW5kZW5jaWVzXCIsXG4gICAgICBzdGF0dXM6IFwiZXJyb3JcIixcbiAgICAgIG1lc3NhZ2U6IFwibm9kZV9tb2R1bGVzIG1pc3NpbmcgXHUyMDE0IHJ1biBucG0gaW5zdGFsbFwiLFxuICAgIH07XG4gIH1cblxuICAvLyBDaGVjayBpZiBsb2NrZmlsZSBpcyBuZXdlciB0aGFuIHRoZSBsYXN0IGluc3RhbGwuXG4gIC8vXG4gIC8vIEVhY2ggcGFja2FnZSBtYW5hZ2VyIHdyaXRlcyBhIG1ldGFkYXRhIG1hcmtlciBpbnNpZGUgbm9kZV9tb2R1bGVzIG9uXG4gIC8vIGV2ZXJ5IGluc3RhbGwuIENvbXBhcmluZyB0aGUgbG9ja2ZpbGUgbXRpbWUgYWdhaW5zdCB0aGUgbWFya2VyIGlzXG4gIC8vIHJlbGlhYmxlOyBjb21wYXJpbmcgYWdhaW5zdCB0aGUgbm9kZV9tb2R1bGVzICpkaXJlY3RvcnkqIG10aW1lIGlzIG5vdCxcbiAgLy8gYmVjYXVzZSBkaXJlY3RvcnkgbXRpbWUgb25seSBjaGFuZ2VzIHdoZW4gZW50cmllcyBhcmUgYWRkZWQgb3IgcmVtb3ZlZFxuICAvLyBcdTIwMTQgbm90IHdoZW4gZmlsZXMgaW5zaWRlIGl0IGFyZSB1cGRhdGVkLiAoIzE5NzQpXG4gIGNvbnN0IGxvY2tmaWxlczogQXJyYXk8eyBsb2NrOiBzdHJpbmc7IG1hcmtlcnM6IHN0cmluZ1tdIH0+ID0gW1xuICAgIHsgbG9jazogXCJwYWNrYWdlLWxvY2suanNvblwiLCBtYXJrZXJzOiBbXCJub2RlX21vZHVsZXMvLnBhY2thZ2UtbG9jay5qc29uXCJdIH0sXG4gICAgeyBsb2NrOiBcInlhcm4ubG9ja1wiLCAgICAgICAgIG1hcmtlcnM6IFtcIm5vZGVfbW9kdWxlcy8ueWFybi1pbnRlZ3JpdHlcIl0gfSxcbiAgICB7IGxvY2s6IFwicG5wbS1sb2NrLnlhbWxcIiwgICAgbWFya2VyczogW1wibm9kZV9tb2R1bGVzLy5tb2R1bGVzLnlhbWxcIl0gfSxcbiAgXTtcblxuICBmb3IgKGNvbnN0IHsgbG9jaywgbWFya2VycyB9IG9mIGxvY2tmaWxlcykge1xuICAgIGNvbnN0IGxvY2tQYXRoID0gam9pbihiYXNlUGF0aCwgbG9jayk7XG4gICAgaWYgKCFleGlzdHNTeW5jKGxvY2tQYXRoKSkgY29udGludWU7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgbG9ja010aW1lID0gc3RhdFN5bmMobG9ja1BhdGgpLm10aW1lTXM7XG5cbiAgICAgIC8vIFByZWZlciB0aGUgcGFja2FnZSBtYW5hZ2VyJ3MgbWFya2VyIGZpbGU7IGZhbGwgYmFjayB0byBkaXJlY3RvcnkgbXRpbWVcbiAgICAgIC8vIG9ubHkgd2hlbiBubyBtYXJrZXIgZXhpc3RzIChlLmcuLCBtYW51YWxseSBjcmVhdGVkIG5vZGVfbW9kdWxlcykuXG4gICAgICBsZXQgaW5zdGFsbE10aW1lID0gMDtcbiAgICAgIGZvciAoY29uc3QgbWFya2VyIG9mIG1hcmtlcnMpIHtcbiAgICAgICAgY29uc3QgbWFya2VyUGF0aCA9IGpvaW4oYmFzZVBhdGgsIG1hcmtlcik7XG4gICAgICAgIGlmIChleGlzdHNTeW5jKG1hcmtlclBhdGgpKSB7XG4gICAgICAgICAgaW5zdGFsbE10aW1lID0gTWF0aC5tYXgoaW5zdGFsbE10aW1lLCBzdGF0U3luYyhtYXJrZXJQYXRoKS5tdGltZU1zKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKGluc3RhbGxNdGltZSA9PT0gMCkge1xuICAgICAgICBpbnN0YWxsTXRpbWUgPSBzdGF0U3luYyhub2RlTW9kdWxlcykubXRpbWVNcztcbiAgICAgIH1cblxuICAgICAgaWYgKGxvY2tNdGltZSA+IGluc3RhbGxNdGltZSkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIG5hbWU6IFwiZGVwZW5kZW5jaWVzXCIsXG4gICAgICAgICAgc3RhdHVzOiBcIndhcm5pbmdcIixcbiAgICAgICAgICBtZXNzYWdlOiBgJHtsb2NrfSBpcyBuZXdlciB0aGFuIG5vZGVfbW9kdWxlcyBcdTIwMTQgZGVwZW5kZW5jaWVzIG1heSBiZSBzdGFsZWAsXG4gICAgICAgICAgZGV0YWlsOiBgUnVuIG5wbSBpbnN0YWxsIC8geWFybiAvIHBucG0gaW5zdGFsbCB0byB1cGRhdGVgLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gc3RhdCBmYWlsZWQgXHUyMDE0IHNraXBcbiAgICB9XG4gIH1cblxuICByZXR1cm4geyBuYW1lOiBcImRlcGVuZGVuY2llc1wiLCBzdGF0dXM6IFwib2tcIiwgbWVzc2FnZTogXCJEZXBlbmRlbmNpZXMgaW5zdGFsbGVkXCIgfTtcbn1cblxuLyoqXG4gKiBDaGVjayBmb3IgLmVudi5leGFtcGxlIGZpbGVzIHdpdGhvdXQgY29ycmVzcG9uZGluZyAuZW52IGZpbGVzLlxuICovXG5mdW5jdGlvbiBjaGVja0VudkZpbGVzKGJhc2VQYXRoOiBzdHJpbmcpOiBFbnZpcm9ubWVudENoZWNrUmVzdWx0IHwgbnVsbCB7XG4gIGNvbnN0IGV4YW1wbGVQYXRoID0gam9pbihiYXNlUGF0aCwgXCIuZW52LmV4YW1wbGVcIik7XG4gIGlmICghZXhpc3RzU3luYyhleGFtcGxlUGF0aCkpIHJldHVybiBudWxsO1xuXG4gIGNvbnN0IGVudlBhdGggPSBqb2luKGJhc2VQYXRoLCBcIi5lbnZcIik7XG4gIGNvbnN0IGVudkxvY2FsUGF0aCA9IGpvaW4oYmFzZVBhdGgsIFwiLmVudi5sb2NhbFwiKTtcblxuICBpZiAoIWV4aXN0c1N5bmMoZW52UGF0aCkgJiYgIWV4aXN0c1N5bmMoZW52TG9jYWxQYXRoKSkge1xuICAgIHJldHVybiB7XG4gICAgICBuYW1lOiBcImVudl9maWxlXCIsXG4gICAgICBzdGF0dXM6IFwid2FybmluZ1wiLFxuICAgICAgbWVzc2FnZTogXCIuZW52LmV4YW1wbGUgZXhpc3RzIGJ1dCBubyAuZW52IG9yIC5lbnYubG9jYWwgZm91bmRcIixcbiAgICAgIGRldGFpbDogXCJDb3B5IC5lbnYuZXhhbXBsZSB0byAuZW52IGFuZCBmaWxsIGluIHZhbHVlc1wiLFxuICAgIH07XG4gIH1cblxuICByZXR1cm4geyBuYW1lOiBcImVudl9maWxlXCIsIHN0YXR1czogXCJva1wiLCBtZXNzYWdlOiBcIkVudmlyb25tZW50IGZpbGUgcHJlc2VudFwiIH07XG59XG5cbi8qKlxuICogQ2hlY2sgZm9yIHBvcnQgY29uZmxpY3RzIG9uIGNvbW1vbiBkZXYgc2VydmVyIHBvcnRzLlxuICogT25seSBjaGVja3MgcG9ydHMgdGhhdCBhcHBlYXIgaW4gcGFja2FnZS5qc29uIHNjcmlwdHMuXG4gKi9cbmZ1bmN0aW9uIGNoZWNrUG9ydENvbmZsaWN0cyhiYXNlUGF0aDogc3RyaW5nKTogRW52aXJvbm1lbnRDaGVja1Jlc3VsdFtdIHtcbiAgLy8gT25seSBydW4gb24gbWFjT1MvTGludXggXHUyMDE0IGxzb2YgaXMgbm90IGF2YWlsYWJsZSBvbiBXaW5kb3dzXG4gIGlmIChwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIpIHJldHVybiBbXTtcblxuICBjb25zdCByZXN1bHRzOiBFbnZpcm9ubWVudENoZWNrUmVzdWx0W10gPSBbXTtcblxuICAvLyBUcnkgdG8gZGV0ZWN0IHBvcnRzIGZyb20gcGFja2FnZS5qc29uIHNjcmlwdHNcbiAgY29uc3QgcG9ydHNUb0NoZWNrID0gbmV3IFNldDxudW1iZXI+KCk7XG4gIGNvbnN0IHBrZ1BhdGggPSBqb2luKGJhc2VQYXRoLCBcInBhY2thZ2UuanNvblwiKTtcblxuICBpZiAoIWV4aXN0c1N5bmMocGtnUGF0aCkpIHtcbiAgICAvLyBObyBwYWNrYWdlLmpzb24gXHUyMDE0IHRoaXMgaXNuJ3QgYSBOb2RlLmpzIHByb2plY3QuIFNraXAgcG9ydCBjaGVja3NcbiAgICAvLyBlbnRpcmVseSB0byBhdm9pZCBmYWxzZSBwb3NpdGl2ZXMgZnJvbSBzeXN0ZW0gc2VydmljZXMgKGUuZy4sIG1hY09TXG4gICAgLy8gQWlyUGxheSBSZWNlaXZlciBvbiBwb3J0IDUwMDApLiAoIzEzODEpXG4gICAgcmV0dXJuIFtdO1xuICB9XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBwa2cgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhwa2dQYXRoLCBcInV0Zi04XCIpKTtcbiAgICBjb25zdCBzY3JpcHRzID0gcGtnLnNjcmlwdHMgPz8ge307XG4gICAgY29uc3Qgc2NyaXB0VGV4dCA9IE9iamVjdC52YWx1ZXMoc2NyaXB0cykuam9pbihcIiBcIik7XG5cbiAgICAvLyBMb29rIGZvciAtLXBvcnQgTk5OTiwgLXAgTk5OTiwgUE9SVD1OTk5OLCA6Tk5OTiBwYXR0ZXJuc1xuICAgIGNvbnN0IHBvcnRNYXRjaGVzID0gc2NyaXB0VGV4dC5tYXRjaEFsbCgvKD86LS1wb3J0XFxzK3woPzpefFteYS16XSlQT1JUWz06XVxccyp8LXBcXHMrfDopKFxcZHs0LDV9KVxcYi9naSk7XG4gICAgZm9yIChjb25zdCBtIG9mIHBvcnRNYXRjaGVzKSB7XG4gICAgICBjb25zdCBwb3J0ID0gcGFyc2VJbnQobVsxXSwgMTApO1xuICAgICAgaWYgKHBvcnQgPj0gMTAyNCAmJiBwb3J0IDw9IDY1NTM1KSBwb3J0c1RvQ2hlY2suYWRkKHBvcnQpO1xuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gcGFyc2UgZmFpbGVkIFx1MjAxNCBza2lwIHBvcnQgY2hlY2tzIHJhdGhlciB0aGFuIHVzaW5nIGRlZmF1bHRzXG4gICAgcmV0dXJuIFtdO1xuICB9XG5cbiAgLy8gSWYgbm8gcG9ydHMgZm91bmQgaW4gc2NyaXB0cywgY2hlY2sgY29tbW9uIGRlZmF1bHRzLlxuICAvLyBGaWx0ZXIgb3V0IHBvcnQgNTAwMCBvbiBtYWNPUyBcdTIwMTQgQWlyUGxheSBSZWNlaXZlciB1c2VzIGl0IGJ5IGRlZmF1bHQgKCMxMzgxKS5cbiAgaWYgKHBvcnRzVG9DaGVjay5zaXplID09PSAwKSB7XG4gICAgZm9yIChjb25zdCBwIG9mIERFRkFVTFRfREVWX1BPUlRTKSB7XG4gICAgICBpZiAocCA9PT0gNTAwMCAmJiBwcm9jZXNzLnBsYXRmb3JtID09PSBcImRhcndpblwiKSBjb250aW51ZTtcbiAgICAgIHBvcnRzVG9DaGVjay5hZGQocCk7XG4gICAgfVxuICB9XG5cbiAgZm9yIChjb25zdCBwb3J0IG9mIHBvcnRzVG9DaGVjaykge1xuICAgIGNvbnN0IHJlc3VsdCA9IHRyeUV4ZWMoYGxzb2YgLWkgOiR7cG9ydH0gLXNUQ1A6TElTVEVOIC10YCwgYmFzZVBhdGgpO1xuICAgIGlmIChyZXN1bHQgJiYgcmVzdWx0Lmxlbmd0aCA+IDApIHtcbiAgICAgIC8vIEdldCBwcm9jZXNzIG5hbWVcbiAgICAgIGNvbnN0IG5hbWVSZXN1bHQgPSB0cnlFeGVjKGBsc29mIC1pIDoke3BvcnR9IC1zVENQOkxJU1RFTiAtRnAgfCBoZWFkIC0yYCwgYmFzZVBhdGgpO1xuICAgICAgY29uc3QgcHJvY2Vzc05hbWUgPSBuYW1lUmVzdWx0Py5tYXRjaCgvcChcXGQrKVxcbj9jPyguKyk/Lyk/LlsyXSA/PyBcInVua25vd25cIjtcblxuICAgICAgcmVzdWx0cy5wdXNoKHtcbiAgICAgICAgbmFtZTogXCJwb3J0X2NvbmZsaWN0XCIsXG4gICAgICAgIHN0YXR1czogXCJ3YXJuaW5nXCIsXG4gICAgICAgIG1lc3NhZ2U6IGBQb3J0ICR7cG9ydH0gaXMgYWxyZWFkeSBpbiB1c2UgYnkgJHtwcm9jZXNzTmFtZX0gKFBJRCAke3Jlc3VsdC5zcGxpdChcIlxcblwiKVswXX0pYCxcbiAgICAgICAgZGV0YWlsOiBgS2lsbCB0aGUgcHJvY2VzcyBvciB1c2UgYSBkaWZmZXJlbnQgcG9ydGAsXG4gICAgICB9KTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gcmVzdWx0cztcbn1cblxuLyoqXG4gKiBDaGVjayBhdmFpbGFibGUgZGlzayBzcGFjZSBvbiB0aGUgd29ya2luZyBkaXJlY3RvcnkgcGFydGl0aW9uLlxuICovXG5mdW5jdGlvbiBjaGVja0Rpc2tTcGFjZShiYXNlUGF0aDogc3RyaW5nKTogRW52aXJvbm1lbnRDaGVja1Jlc3VsdCB8IG51bGwge1xuICAvLyBPbmx5IHJ1biBvbiBtYWNPUy9MaW51eFxuICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiKSByZXR1cm4gbnVsbDtcblxuICBjb25zdCBkZk91dHB1dCA9IHRyeUV4ZWMoYGRmIC1rIFwiJHtiYXNlUGF0aH1cIiB8IHRhaWwgLTFgLCBiYXNlUGF0aCk7XG4gIGlmICghZGZPdXRwdXQpIHJldHVybiBudWxsO1xuXG4gIHRyeSB7XG4gICAgLy8gZGYgb3V0cHV0OiBmaWxlc3lzdGVtIGJsb2NrcyB1c2VkIGF2YWlsIGNhcGFjaXR5IG1vdW50XG4gICAgY29uc3QgcGFydHMgPSBkZk91dHB1dC5zcGxpdCgvXFxzKy8pO1xuICAgIGNvbnN0IGF2YWlsS0IgPSBwYXJzZUludChwYXJ0c1szXSwgMTApO1xuICAgIGlmIChpc05hTihhdmFpbEtCKSkgcmV0dXJuIG51bGw7XG5cbiAgICBjb25zdCBhdmFpbEJ5dGVzID0gYXZhaWxLQiAqIDEwMjQ7XG4gICAgY29uc3QgYXZhaWxNQiA9IE1hdGgucm91bmQoYXZhaWxCeXRlcyAvICgxMDI0ICogMTAyNCkpO1xuICAgIGNvbnN0IGF2YWlsR0IgPSAoYXZhaWxCeXRlcyAvICgxMDI0ICogMTAyNCAqIDEwMjQpKS50b0ZpeGVkKDEpO1xuXG4gICAgaWYgKGF2YWlsQnl0ZXMgPCBNSU5fRElTS19CWVRFUykge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgbmFtZTogXCJkaXNrX3NwYWNlXCIsXG4gICAgICAgIHN0YXR1czogXCJlcnJvclwiLFxuICAgICAgICBtZXNzYWdlOiBgTG93IGRpc2sgc3BhY2U6ICR7YXZhaWxNQn1NQiBmcmVlYCxcbiAgICAgICAgZGV0YWlsOiBgRnJlZSB1cCBzcGFjZSBcdTIwMTQgYnVpbGRzIGFuZCBnaXQgb3BlcmF0aW9ucyBtYXkgZmFpbGAsXG4gICAgICB9O1xuICAgIH1cblxuICAgIGlmIChhdmFpbEJ5dGVzIDwgTUlOX0RJU0tfQllURVMgKiA0KSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBuYW1lOiBcImRpc2tfc3BhY2VcIixcbiAgICAgICAgc3RhdHVzOiBcIndhcm5pbmdcIixcbiAgICAgICAgbWVzc2FnZTogYERpc2sgc3BhY2UgZ2V0dGluZyBsb3c6ICR7YXZhaWxHQn1HQiBmcmVlYCxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgcmV0dXJuIHsgbmFtZTogXCJkaXNrX3NwYWNlXCIsIHN0YXR1czogXCJva1wiLCBtZXNzYWdlOiBgJHthdmFpbEdCfUdCIGZyZWVgIH07XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8qKlxuICogQ2hlY2sgaWYgRG9ja2VyIGlzIGF2YWlsYWJsZSB3aGVuIHByb2plY3QgaGFzIGEgRG9ja2VyZmlsZS5cbiAqL1xuZnVuY3Rpb24gY2hlY2tEb2NrZXIoYmFzZVBhdGg6IHN0cmluZyk6IEVudmlyb25tZW50Q2hlY2tSZXN1bHQgfCBudWxsIHtcbiAgY29uc3QgaGFzRG9ja2VyZmlsZSA9IGV4aXN0c1N5bmMoam9pbihiYXNlUGF0aCwgXCJEb2NrZXJmaWxlXCIpKSB8fFxuICAgIGV4aXN0c1N5bmMoam9pbihiYXNlUGF0aCwgXCJkb2NrZXItY29tcG9zZS55bWxcIikpIHx8XG4gICAgZXhpc3RzU3luYyhqb2luKGJhc2VQYXRoLCBcImRvY2tlci1jb21wb3NlLnlhbWxcIikpIHx8XG4gICAgZXhpc3RzU3luYyhqb2luKGJhc2VQYXRoLCBcImNvbXBvc2UueW1sXCIpKSB8fFxuICAgIGV4aXN0c1N5bmMoam9pbihiYXNlUGF0aCwgXCJjb21wb3NlLnlhbWxcIikpO1xuXG4gIGlmICghaGFzRG9ja2VyZmlsZSkgcmV0dXJuIG51bGw7XG5cbiAgaWYgKCFjb21tYW5kRXhpc3RzKFwiZG9ja2VyXCIsIGJhc2VQYXRoKSkge1xuICAgIHJldHVybiB7XG4gICAgICBuYW1lOiBcImRvY2tlclwiLFxuICAgICAgc3RhdHVzOiBcIndhcm5pbmdcIixcbiAgICAgIG1lc3NhZ2U6IFwiUHJvamVjdCBoYXMgRG9ja2VyIGZpbGVzIGJ1dCBkb2NrZXIgaXMgbm90IGluc3RhbGxlZFwiLFxuICAgIH07XG4gIH1cblxuICBjb25zdCBpbmZvID0gdHJ5RXhlYyhcImRvY2tlciBpbmZvIC0tZm9ybWF0ICd7ey5TZXJ2ZXJWZXJzaW9ufX0nXCIsIGJhc2VQYXRoKTtcbiAgaWYgKCFpbmZvKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG5hbWU6IFwiZG9ja2VyXCIsXG4gICAgICBzdGF0dXM6IFwid2FybmluZ1wiLFxuICAgICAgbWVzc2FnZTogXCJEb2NrZXIgaXMgaW5zdGFsbGVkIGJ1dCBkYWVtb24gaXMgbm90IHJ1bm5pbmdcIixcbiAgICAgIGRldGFpbDogXCJTdGFydCBEb2NrZXIgRGVza3RvcCBvciB0aGUgZG9ja2VyIGRhZW1vblwiLFxuICAgIH07XG4gIH1cblxuICByZXR1cm4geyBuYW1lOiBcImRvY2tlclwiLCBzdGF0dXM6IFwib2tcIiwgbWVzc2FnZTogYERvY2tlciAke2luZm99YCB9O1xufVxuXG4vKipcbiAqIENoZWNrIGZvciBjb21tb24gcHJvamVjdCB0b29scyB0aGF0IHNob3VsZCBiZSBhdmFpbGFibGUuXG4gKi9cbmZ1bmN0aW9uIGNoZWNrUHJvamVjdFRvb2xzKGJhc2VQYXRoOiBzdHJpbmcpOiBFbnZpcm9ubWVudENoZWNrUmVzdWx0W10ge1xuICBjb25zdCByZXN1bHRzOiBFbnZpcm9ubWVudENoZWNrUmVzdWx0W10gPSBbXTtcbiAgY29uc3QgcGtnUGF0aCA9IGpvaW4oYmFzZVBhdGgsIFwicGFja2FnZS5qc29uXCIpO1xuXG4gIGlmICghZXhpc3RzU3luYyhwa2dQYXRoKSkgcmV0dXJuIHJlc3VsdHM7XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBwa2cgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhwa2dQYXRoLCBcInV0Zi04XCIpKTtcbiAgICBjb25zdCBhbGxEZXBzID0ge1xuICAgICAgLi4uKHBrZy5kZXBlbmRlbmNpZXMgPz8ge30pLFxuICAgICAgLi4uKHBrZy5kZXZEZXBlbmRlbmNpZXMgPz8ge30pLFxuICAgIH07XG5cbiAgICAvLyBDaGVjayBmb3IgcGFja2FnZSBtYW5hZ2VyXG4gICAgY29uc3QgcGFja2FnZU1hbmFnZXIgPSBwa2cucGFja2FnZU1hbmFnZXI7XG4gICAgaWYgKHBhY2thZ2VNYW5hZ2VyKSB7XG4gICAgICBjb25zdCBtYW5hZ2VyTmFtZSA9IHBhY2thZ2VNYW5hZ2VyLnNwbGl0KFwiQFwiKVswXTtcbiAgICAgIGlmIChtYW5hZ2VyTmFtZSAmJiBtYW5hZ2VyTmFtZSAhPT0gXCJucG1cIiAmJiAhY29tbWFuZEV4aXN0cyhtYW5hZ2VyTmFtZSwgYmFzZVBhdGgpKSB7XG4gICAgICAgIHJlc3VsdHMucHVzaCh7XG4gICAgICAgICAgbmFtZTogXCJwYWNrYWdlX21hbmFnZXJcIixcbiAgICAgICAgICBzdGF0dXM6IFwid2FybmluZ1wiLFxuICAgICAgICAgIG1lc3NhZ2U6IGBQcm9qZWN0IHJlcXVpcmVzICR7bWFuYWdlck5hbWV9IGJ1dCBpdCdzIG5vdCBpbnN0YWxsZWRgLFxuICAgICAgICAgIGRldGFpbDogYEluc3RhbGwgd2l0aDogbnBtIGluc3RhbGwgLWcgJHttYW5hZ2VyTmFtZX1gLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBDaGVjayBmb3IgVHlwZVNjcmlwdCBpZiBpdCdzIGEgZGVwZW5kZW5jeVxuICAgIGlmIChhbGxEZXBzW1widHlwZXNjcmlwdFwiXSAmJiAhZXhpc3RzU3luYyhqb2luKGJhc2VQYXRoLCBcIm5vZGVfbW9kdWxlc1wiLCBcIi5iaW5cIiwgXCJ0c2NcIikpKSB7XG4gICAgICByZXN1bHRzLnB1c2goe1xuICAgICAgICBuYW1lOiBcInR5cGVzY3JpcHRcIixcbiAgICAgICAgc3RhdHVzOiBcIndhcm5pbmdcIixcbiAgICAgICAgbWVzc2FnZTogXCJUeXBlU2NyaXB0IGlzIGEgZGVwZW5kZW5jeSBidXQgdHNjIGlzIG5vdCBhdmFpbGFibGUgKHJ1biBucG0gaW5zdGFsbClcIixcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIENoZWNrIGZvciBQeXRob24gaWYgcHlwcm9qZWN0LnRvbWwgb3IgcmVxdWlyZW1lbnRzLnR4dCBleGlzdHNcbiAgICBpZiAoZXhpc3RzU3luYyhqb2luKGJhc2VQYXRoLCBcInB5cHJvamVjdC50b21sXCIpKSB8fCBleGlzdHNTeW5jKGpvaW4oYmFzZVBhdGgsIFwicmVxdWlyZW1lbnRzLnR4dFwiKSkpIHtcbiAgICAgIGlmIChkZXRlY3RQeXRob25FeGVjdXRhYmxlKCkgPT09IG51bGwpIHtcbiAgICAgICAgcmVzdWx0cy5wdXNoKHtcbiAgICAgICAgICBuYW1lOiBcInB5dGhvblwiLFxuICAgICAgICAgIHN0YXR1czogXCJ3YXJuaW5nXCIsXG4gICAgICAgICAgbWVzc2FnZTogXCJQcm9qZWN0IGhhcyBQeXRob24gY29uZmlnIGJ1dCBweXRob24gaXMgbm90IGluc3RhbGxlZFwiLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBDaGVjayBmb3IgUnVzdCBpZiBDYXJnby50b21sIGV4aXN0c1xuICAgIGlmIChleGlzdHNTeW5jKGpvaW4oYmFzZVBhdGgsIFwiQ2FyZ28udG9tbFwiKSkpIHtcbiAgICAgIGlmICghY29tbWFuZEV4aXN0cyhcImNhcmdvXCIsIGJhc2VQYXRoKSkge1xuICAgICAgICByZXN1bHRzLnB1c2goe1xuICAgICAgICAgIG5hbWU6IFwiY2FyZ29cIixcbiAgICAgICAgICBzdGF0dXM6IFwid2FybmluZ1wiLFxuICAgICAgICAgIG1lc3NhZ2U6IFwiUHJvamVjdCBoYXMgQ2FyZ28udG9tbCBidXQgY2FyZ28gaXMgbm90IGluc3RhbGxlZFwiLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBDaGVjayBmb3IgR28gaWYgZ28ubW9kIGV4aXN0c1xuICAgIGlmIChleGlzdHNTeW5jKGpvaW4oYmFzZVBhdGgsIFwiZ28ubW9kXCIpKSkge1xuICAgICAgaWYgKCFjb21tYW5kRXhpc3RzKFwiZ29cIiwgYmFzZVBhdGgpKSB7XG4gICAgICAgIHJlc3VsdHMucHVzaCh7XG4gICAgICAgICAgbmFtZTogXCJnb1wiLFxuICAgICAgICAgIHN0YXR1czogXCJ3YXJuaW5nXCIsXG4gICAgICAgICAgbWVzc2FnZTogXCJQcm9qZWN0IGhhcyBnby5tb2QgYnV0IGdvIGlzIG5vdCBpbnN0YWxsZWRcIixcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuICB9IGNhdGNoIHtcbiAgICAvLyBwYXJzZSBmYWlsZWQgXHUyMDE0IHNraXBcbiAgfVxuXG4gIHJldHVybiByZXN1bHRzO1xufVxuXG4vKipcbiAqIENoZWNrIGdpdCByZW1vdGUgcmVhY2hhYmlsaXR5LlxuICovXG5mdW5jdGlvbiBjaGVja0dpdFJlbW90ZShiYXNlUGF0aDogc3RyaW5nKTogRW52aXJvbm1lbnRDaGVja1Jlc3VsdCB8IG51bGwge1xuICAvLyBPbmx5IGNoZWNrIGlmIGl0J3MgYSBnaXQgcmVwbyB3aXRoIGEgcmVtb3RlXG4gIGNvbnN0IHJlbW90ZSA9IHRyeUV4ZWMoXCJnaXQgcmVtb3RlIGdldC11cmwgb3JpZ2luXCIsIGJhc2VQYXRoKTtcbiAgaWYgKCFyZW1vdGUpIHJldHVybiBudWxsO1xuXG4gIC8vIFF1aWNrIGNvbm5lY3Rpdml0eSBjaGVjayB3aXRoIHNob3J0IHRpbWVvdXRcbiAgY29uc3QgcmVzdWx0ID0gdHJ5RXhlYyhcImdpdCBscy1yZW1vdGUgLS1leGl0LWNvZGUgLWggb3JpZ2luIEhFQURcIiwgYmFzZVBhdGgpO1xuICBpZiAocmVzdWx0ID09PSBudWxsKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG5hbWU6IFwiZ2l0X3JlbW90ZVwiLFxuICAgICAgc3RhdHVzOiBcIndhcm5pbmdcIixcbiAgICAgIG1lc3NhZ2U6IFwiR2l0IHJlbW90ZSAnb3JpZ2luJyBpcyB1bnJlYWNoYWJsZVwiLFxuICAgICAgZGV0YWlsOiBgUmVtb3RlOiAke3JlbW90ZX1gLFxuICAgIH07XG4gIH1cblxuICByZXR1cm4geyBuYW1lOiBcImdpdF9yZW1vdGVcIiwgc3RhdHVzOiBcIm9rXCIsIG1lc3NhZ2U6IFwiR2l0IHJlbW90ZSByZWFjaGFibGVcIiB9O1xufVxuXG4vKipcbiAqIENoZWNrIGlmIHRoZSBwcm9qZWN0IGJ1aWxkIHBhc3NlcyAob3B0LWluIHNsb3cgY2hlY2ssIHVzZSAtLWJ1aWxkIGZsYWcpLlxuICogUnVucyBucG0gcnVuIGJ1aWxkIGFuZCByZXBvcnRzIGZhaWx1cmUgYXMgZW52X2J1aWxkLlxuICovXG5mdW5jdGlvbiBjaGVja0J1aWxkSGVhbHRoKGJhc2VQYXRoOiBzdHJpbmcpOiBFbnZpcm9ubWVudENoZWNrUmVzdWx0IHwgbnVsbCB7XG4gIGNvbnN0IHBrZ1BhdGggPSBqb2luKGJhc2VQYXRoLCBcInBhY2thZ2UuanNvblwiKTtcbiAgaWYgKCFleGlzdHNTeW5jKHBrZ1BhdGgpKSByZXR1cm4gbnVsbDtcblxuICB0cnkge1xuICAgIGNvbnN0IHBrZyA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHBrZ1BhdGgsIFwidXRmLThcIikpO1xuICAgIGNvbnN0IGJ1aWxkU2NyaXB0ID0gcGtnLnNjcmlwdHM/LmJ1aWxkO1xuICAgIGlmICghYnVpbGRTY3JpcHQpIHJldHVybiBudWxsO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gdHJ5RXhlYyhcIm5wbSBydW4gYnVpbGQgMj4mMVwiLCBiYXNlUGF0aCk7XG4gICAgaWYgKHJlc3VsdCA9PT0gbnVsbCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgbmFtZTogXCJidWlsZFwiLFxuICAgICAgICBzdGF0dXM6IFwiZXJyb3JcIixcbiAgICAgICAgbWVzc2FnZTogXCJCdWlsZCBmYWlsZWQgXHUyMDE0IG5wbSBydW4gYnVpbGQgZXhpdGVkIG5vbi16ZXJvXCIsXG4gICAgICAgIGRldGFpbDogXCJGaXggYnVpbGQgZXJyb3JzIGJlZm9yZSBkaXNwYXRjaGluZyB3b3JrXCIsXG4gICAgICB9O1xuICAgIH1cbiAgICByZXR1cm4geyBuYW1lOiBcImJ1aWxkXCIsIHN0YXR1czogXCJva1wiLCBtZXNzYWdlOiBcIkJ1aWxkIHBhc3Nlc1wiIH07XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8qKlxuICogQ2hlY2sgaWYgdGVzdHMgcGFzcyAob3B0LWluIHNsb3cgY2hlY2ssIHVzZSAtLXRlc3QgZmxhZykuXG4gKiBSdW5zIG5wbSB0ZXN0IGFuZCByZXBvcnRzIGZhaWx1cmVzIGFzIGVudl90ZXN0LlxuICovXG5mdW5jdGlvbiBjaGVja1Rlc3RIZWFsdGgoYmFzZVBhdGg6IHN0cmluZyk6IEVudmlyb25tZW50Q2hlY2tSZXN1bHQgfCBudWxsIHtcbiAgY29uc3QgcGtnUGF0aCA9IGpvaW4oYmFzZVBhdGgsIFwicGFja2FnZS5qc29uXCIpO1xuICBpZiAoIWV4aXN0c1N5bmMocGtnUGF0aCkpIHJldHVybiBudWxsO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgcGtnID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocGtnUGF0aCwgXCJ1dGYtOFwiKSk7XG4gICAgY29uc3QgdGVzdFNjcmlwdCA9IHBrZy5zY3JpcHRzPy50ZXN0O1xuICAgIC8vIFNraXAgaWYgbm8gdGVzdCBzY3JpcHQgb3IgdGhlIGRlZmF1bHQgcGxhY2Vob2xkZXJcbiAgICBpZiAoIXRlc3RTY3JpcHQgfHwgdGVzdFNjcmlwdC5pbmNsdWRlcyhcIm5vIHRlc3Qgc3BlY2lmaWVkXCIpKSByZXR1cm4gbnVsbDtcblxuICAgIGNvbnN0IHJlc3VsdCA9IHRyeUV4ZWMoXCJucG0gdGVzdCAyPiYxXCIsIGJhc2VQYXRoKTtcbiAgICBpZiAocmVzdWx0ID09PSBudWxsKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBuYW1lOiBcInRlc3RcIixcbiAgICAgICAgc3RhdHVzOiBcIndhcm5pbmdcIixcbiAgICAgICAgbWVzc2FnZTogXCJUZXN0cyBmYWlsaW5nIFx1MjAxNCBucG0gdGVzdCBleGl0ZWQgbm9uLXplcm9cIixcbiAgICAgICAgZGV0YWlsOiBcIkZpeCBmYWlsaW5nIHRlc3RzIGJlZm9yZSBzaGlwcGluZ1wiLFxuICAgICAgfTtcbiAgICB9XG4gICAgcmV0dXJuIHsgbmFtZTogXCJ0ZXN0XCIsIHN0YXR1czogXCJva1wiLCBtZXNzYWdlOiBcIlRlc3RzIHBhc3NcIiB9O1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDAgUHVibGljIEFQSSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBSdW4gYWxsIGVudmlyb25tZW50IGhlYWx0aCBjaGVja3MuIFJldHVybnMgc3RydWN0dXJlZCByZXN1bHRzIGZvclxuICogaW50ZWdyYXRpb24gd2l0aCB0aGUgZG9jdG9yIHBpcGVsaW5lLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcnVuRW52aXJvbm1lbnRDaGVja3MoYmFzZVBhdGg6IHN0cmluZyk6IEVudmlyb25tZW50Q2hlY2tSZXN1bHRbXSB7XG4gIGNvbnN0IHJlc3VsdHM6IEVudmlyb25tZW50Q2hlY2tSZXN1bHRbXSA9IFtdO1xuXG4gIGNvbnN0IG5vZGVDaGVjayA9IGNoZWNrTm9kZVZlcnNpb24oYmFzZVBhdGgpO1xuICBpZiAobm9kZUNoZWNrKSByZXN1bHRzLnB1c2gobm9kZUNoZWNrKTtcblxuICBjb25zdCBkZXBzQ2hlY2sgPSBjaGVja0RlcGVuZGVuY2llc0luc3RhbGxlZChiYXNlUGF0aCk7XG4gIGlmIChkZXBzQ2hlY2spIHJlc3VsdHMucHVzaChkZXBzQ2hlY2spO1xuXG4gIGNvbnN0IGVudkNoZWNrID0gY2hlY2tFbnZGaWxlcyhiYXNlUGF0aCk7XG4gIGlmIChlbnZDaGVjaykgcmVzdWx0cy5wdXNoKGVudkNoZWNrKTtcblxuICByZXN1bHRzLnB1c2goLi4uY2hlY2tQb3J0Q29uZmxpY3RzKGJhc2VQYXRoKSk7XG5cbiAgY29uc3QgZGlza0NoZWNrID0gY2hlY2tEaXNrU3BhY2UoYmFzZVBhdGgpO1xuICBpZiAoZGlza0NoZWNrKSByZXN1bHRzLnB1c2goZGlza0NoZWNrKTtcblxuICBjb25zdCBkb2NrZXJDaGVjayA9IGNoZWNrRG9ja2VyKGJhc2VQYXRoKTtcbiAgaWYgKGRvY2tlckNoZWNrKSByZXN1bHRzLnB1c2goZG9ja2VyQ2hlY2spO1xuXG4gIHJlc3VsdHMucHVzaCguLi5jaGVja1Byb2plY3RUb29scyhiYXNlUGF0aCkpO1xuXG4gIC8vIEdpdCByZW1vdGUgY2hlY2sgY2FuIGJlIHNsb3cgXHUyMDE0IG9ubHkgcnVuIG9uIGV4cGxpY2l0IGRvY3RvciBpbnZvY2F0aW9uXG4gIC8vIChub3Qgb24gcHJlLWRpc3BhdGNoIGdhdGUpXG5cbiAgcmV0dXJuIHJlc3VsdHM7XG59XG5cbi8qKlxuICogUnVuIGVudmlyb25tZW50IGNoZWNrcyB3aXRoIGdpdCByZW1vdGUgY2hlY2sgaW5jbHVkZWQuXG4gKiBVc2UgdGhpcyBmb3IgZXhwbGljaXQgL2dzZCBkb2N0b3IgaW52b2NhdGlvbnMsIG5vdCBwcmUtZGlzcGF0Y2ggZ2F0ZXMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBydW5GdWxsRW52aXJvbm1lbnRDaGVja3MoYmFzZVBhdGg6IHN0cmluZyk6IEVudmlyb25tZW50Q2hlY2tSZXN1bHRbXSB7XG4gIGNvbnN0IHJlc3VsdHMgPSBydW5FbnZpcm9ubWVudENoZWNrcyhiYXNlUGF0aCk7XG5cbiAgY29uc3QgcmVtb3RlQ2hlY2sgPSBjaGVja0dpdFJlbW90ZShiYXNlUGF0aCk7XG4gIGlmIChyZW1vdGVDaGVjaykgcmVzdWx0cy5wdXNoKHJlbW90ZUNoZWNrKTtcblxuICByZXR1cm4gcmVzdWx0cztcbn1cblxuLyoqXG4gKiBSdW4gc2xvdyBvcHQtaW4gY2hlY2tzIChidWlsZCBhbmQvb3IgdGVzdCkuXG4gKiBUaGVzZSBhcmUgbmV2ZXIgcnVuIG9uIHRoZSBwcmUtZGlzcGF0Y2ggZ2F0ZSBcdTIwMTQgb25seSBvbiBleHBsaWNpdCAvZ3NkIGRvY3RvciAtLWJ1aWxkLy0tdGVzdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJ1blNsb3dFbnZpcm9ubWVudENoZWNrcyhcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgb3B0aW9ucz86IHsgaW5jbHVkZUJ1aWxkPzogYm9vbGVhbjsgaW5jbHVkZVRlc3RzPzogYm9vbGVhbiB9LFxuKTogRW52aXJvbm1lbnRDaGVja1Jlc3VsdFtdIHtcbiAgY29uc3QgcmVzdWx0czogRW52aXJvbm1lbnRDaGVja1Jlc3VsdFtdID0gW107XG4gIGlmIChvcHRpb25zPy5pbmNsdWRlQnVpbGQpIHtcbiAgICBjb25zdCBidWlsZENoZWNrID0gY2hlY2tCdWlsZEhlYWx0aChiYXNlUGF0aCk7XG4gICAgaWYgKGJ1aWxkQ2hlY2spIHJlc3VsdHMucHVzaChidWlsZENoZWNrKTtcbiAgfVxuICBpZiAob3B0aW9ucz8uaW5jbHVkZVRlc3RzKSB7XG4gICAgY29uc3QgdGVzdENoZWNrID0gY2hlY2tUZXN0SGVhbHRoKGJhc2VQYXRoKTtcbiAgICBpZiAodGVzdENoZWNrKSByZXN1bHRzLnB1c2godGVzdENoZWNrKTtcbiAgfVxuICByZXR1cm4gcmVzdWx0cztcbn1cblxuLyoqXG4gKiBDb252ZXJ0IGVudmlyb25tZW50IGNoZWNrIHJlc3VsdHMgdG8gRG9jdG9ySXNzdWUgZm9ybWF0IGZvciB0aGUgZG9jdG9yIHBpcGVsaW5lLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZW52aXJvbm1lbnRSZXN1bHRzVG9Eb2N0b3JJc3N1ZXMocmVzdWx0czogRW52aXJvbm1lbnRDaGVja1Jlc3VsdFtdKTogRG9jdG9ySXNzdWVbXSB7XG4gIHJldHVybiByZXN1bHRzXG4gICAgLmZpbHRlcihyID0+IHIuc3RhdHVzICE9PSBcIm9rXCIpXG4gICAgLm1hcChyID0+ICh7XG4gICAgICBzZXZlcml0eTogci5zdGF0dXMgPT09IFwiZXJyb3JcIiA/IFwiZXJyb3JcIiBhcyBjb25zdCA6IFwid2FybmluZ1wiIGFzIGNvbnN0LFxuICAgICAgY29kZTogYGVudl8ke3IubmFtZX1gIGFzIERvY3Rvcklzc3VlQ29kZSxcbiAgICAgIHNjb3BlOiBcInByb2plY3RcIiBhcyBjb25zdCxcbiAgICAgIHVuaXRJZDogXCJlbnZpcm9ubWVudFwiLFxuICAgICAgbWVzc2FnZTogci5kZXRhaWwgPyBgJHtyLm1lc3NhZ2V9IFx1MjAxNCAke3IuZGV0YWlsfWAgOiByLm1lc3NhZ2UsXG4gICAgICBmaXhhYmxlOiBmYWxzZSxcbiAgICB9KSk7XG59XG5cbi8qKlxuICogSW50ZWdyYXRpb24gcG9pbnQgZm9yIHRoZSBkb2N0b3IgcGlwZWxpbmUuIFJ1bnMgZW52aXJvbm1lbnQgY2hlY2tzXG4gKiBhbmQgYXBwZW5kcyBpc3N1ZXMgdG8gdGhlIHByb3ZpZGVkIGFycmF5LlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY2hlY2tFbnZpcm9ubWVudEhlYWx0aChcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgaXNzdWVzOiBEb2N0b3JJc3N1ZVtdLFxuICBvcHRpb25zPzogeyBpbmNsdWRlUmVtb3RlPzogYm9vbGVhbjsgaW5jbHVkZUJ1aWxkPzogYm9vbGVhbjsgaW5jbHVkZVRlc3RzPzogYm9vbGVhbiB9LFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHJlc3VsdHMgPSBvcHRpb25zPy5pbmNsdWRlUmVtb3RlXG4gICAgPyBydW5GdWxsRW52aXJvbm1lbnRDaGVja3MoYmFzZVBhdGgpXG4gICAgOiBydW5FbnZpcm9ubWVudENoZWNrcyhiYXNlUGF0aCk7XG5cbiAgaWYgKG9wdGlvbnM/LmluY2x1ZGVCdWlsZCB8fCBvcHRpb25zPy5pbmNsdWRlVGVzdHMpIHtcbiAgICByZXN1bHRzLnB1c2goLi4ucnVuU2xvd0Vudmlyb25tZW50Q2hlY2tzKGJhc2VQYXRoLCBvcHRpb25zKSk7XG4gIH1cblxuICBpc3N1ZXMucHVzaCguLi5lbnZpcm9ubWVudFJlc3VsdHNUb0RvY3Rvcklzc3VlcyhyZXN1bHRzKSk7XG59XG5cbi8qKlxuICogRm9ybWF0IGVudmlyb25tZW50IGNoZWNrIHJlc3VsdHMgZm9yIGRpc3BsYXkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXRFbnZpcm9ubWVudFJlcG9ydChyZXN1bHRzOiBFbnZpcm9ubWVudENoZWNrUmVzdWx0W10pOiBzdHJpbmcge1xuICBpZiAocmVzdWx0cy5sZW5ndGggPT09IDApIHJldHVybiBcIk5vIGVudmlyb25tZW50IGNoZWNrcyBhcHBsaWNhYmxlLlwiO1xuXG4gIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICBsaW5lcy5wdXNoKFwiRW52aXJvbm1lbnQgSGVhbHRoOlwiKTtcblxuICBmb3IgKGNvbnN0IHIgb2YgcmVzdWx0cykge1xuICAgIGNvbnN0IGljb24gPSByLnN0YXR1cyA9PT0gXCJva1wiID8gXCJcXHUyNzA1XCIgOiByLnN0YXR1cyA9PT0gXCJ3YXJuaW5nXCIgPyBcIlxcdTI2QTBcXHVGRTBGXCIgOiBcIlxcdUQ4M0RcXHVERUQxXCI7XG4gICAgbGluZXMucHVzaChgICAke2ljb259ICR7ci5tZXNzYWdlfWApO1xuICAgIGlmIChyLmRldGFpbCAmJiByLnN0YXR1cyAhPT0gXCJva1wiKSB7XG4gICAgICBsaW5lcy5wdXNoKGAgICAgICR7ci5kZXRhaWx9YCk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGxpbmVzLmpvaW4oXCJcXG5cIik7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFXQSxTQUFTLFlBQVksY0FBYyxnQkFBZ0I7QUFDbkQsU0FBUyxnQkFBZ0I7QUFDekIsU0FBUyxZQUFZO0FBR3JCLFNBQVMsOEJBQThCO0FBY3ZDLE1BQU0sb0JBQW9CLENBQUMsS0FBTSxNQUFNLEtBQU0sS0FBTSxNQUFNLEtBQU0sTUFBTSxJQUFJO0FBR3pFLE1BQU0saUJBQWlCLE1BQU0sT0FBTztBQUdwQyxNQUFNLGNBQWM7QUFLcEIsTUFBTSx3QkFBd0IsR0FBRyxLQUFLLFFBQVEsV0FBVyxDQUFDO0FBVTFELFNBQVMsMkJBQTJCLFVBQWlDO0FBQ25FLFFBQU0sVUFBVSxRQUFRLElBQUk7QUFDNUIsTUFBSSxRQUFTLFFBQU87QUFFcEIsUUFBTSxhQUFhLFNBQVMsUUFBUSxPQUFPLEdBQUc7QUFDOUMsUUFBTSxNQUFNLFdBQVcsUUFBUSxzQkFBc0IsUUFBUSxPQUFPLEdBQUcsQ0FBQztBQUN4RSxNQUFJLFFBQVEsR0FBSSxRQUFPO0FBR3ZCLFNBQU8sU0FBUyxNQUFNLEdBQUcsR0FBRztBQUM5QjtBQUVBLFNBQVMsUUFBUSxLQUFhLEtBQTRCO0FBQ3hELE1BQUk7QUFDRixXQUFPLFNBQVMsS0FBSztBQUFBLE1BQ25CO0FBQUEsTUFDQSxTQUFTO0FBQUEsTUFDVCxPQUFPLENBQUMsVUFBVSxRQUFRLE1BQU07QUFBQSxNQUNoQyxVQUFVO0FBQUEsSUFDWixDQUFDLEVBQUUsS0FBSztBQUFBLEVBQ1YsUUFBUTtBQUNOLFdBQU87QUFBQSxFQUNUO0FBQ0Y7QUFFQSxTQUFTLGNBQWMsTUFBYyxLQUFzQjtBQUN6RCxRQUFNLFdBQVcsUUFBUSxhQUFhLFVBQVUsU0FBUyxJQUFJLEtBQUssY0FBYyxJQUFJO0FBQ3BGLFNBQU8sUUFBUSxVQUFVLEdBQUcsTUFBTTtBQUNwQztBQU9BLFNBQVMsaUJBQWlCLFVBQWlEO0FBQ3pFLFFBQU0sVUFBVSxLQUFLLFVBQVUsY0FBYztBQUM3QyxNQUFJLENBQUMsV0FBVyxPQUFPLEVBQUcsUUFBTztBQUVqQyxNQUFJO0FBQ0YsVUFBTSxNQUFNLEtBQUssTUFBTSxhQUFhLFNBQVMsT0FBTyxDQUFDO0FBQ3JELFVBQU0sV0FBVyxJQUFJLFNBQVM7QUFDOUIsUUFBSSxDQUFDLFNBQVUsUUFBTztBQUV0QixVQUFNLGlCQUFpQixRQUFRLGtCQUFrQixRQUFRO0FBQ3pELFFBQUksQ0FBQyxnQkFBZ0I7QUFDbkIsYUFBTyxFQUFFLE1BQU0sZ0JBQWdCLFFBQVEsU0FBUyxTQUFTLDRCQUE0QjtBQUFBLElBQ3ZGO0FBR0EsVUFBTSxXQUFXLFNBQVMsTUFBTSx5QkFBeUI7QUFDekQsUUFBSSxDQUFDLFNBQVUsUUFBTztBQUV0QixVQUFNLFdBQVcsU0FBUyxTQUFTLENBQUMsR0FBRyxFQUFFO0FBQ3pDLFVBQU0sV0FBVyxTQUFTLFNBQVMsQ0FBQyxLQUFLLEtBQUssRUFBRTtBQUVoRCxVQUFNLFdBQVcsZUFBZSxNQUFNLGdCQUFnQjtBQUN0RCxRQUFJLENBQUMsU0FBVSxRQUFPO0FBRXRCLFVBQU0sV0FBVyxTQUFTLFNBQVMsQ0FBQyxHQUFHLEVBQUU7QUFDekMsVUFBTSxXQUFXLFNBQVMsU0FBUyxDQUFDLEdBQUcsRUFBRTtBQUV6QyxRQUFJLFdBQVcsWUFBYSxhQUFhLFlBQVksV0FBVyxVQUFXO0FBQ3pFLGFBQU87QUFBQSxRQUNMLE1BQU07QUFBQSxRQUNOLFFBQVE7QUFBQSxRQUNSLFNBQVMsV0FBVyxjQUFjLCtCQUErQixRQUFRO0FBQUEsUUFDekUsUUFBUSxZQUFZLGNBQWMsZUFBZSxRQUFRO0FBQUEsTUFDM0Q7QUFBQSxJQUNGO0FBRUEsV0FBTyxFQUFFLE1BQU0sZ0JBQWdCLFFBQVEsTUFBTSxTQUFTLFdBQVcsY0FBYyxHQUFHO0FBQUEsRUFDcEYsUUFBUTtBQUNOLFdBQU87QUFBQSxFQUNUO0FBQ0Y7QUFLQSxTQUFTLDJCQUEyQixVQUFpRDtBQUNuRixRQUFNLFVBQVUsS0FBSyxVQUFVLGNBQWM7QUFDN0MsTUFBSSxDQUFDLFdBQVcsT0FBTyxFQUFHLFFBQU87QUFFakMsUUFBTSxjQUFjLEtBQUssVUFBVSxjQUFjO0FBQ2pELE1BQUksQ0FBQyxXQUFXLFdBQVcsR0FBRztBQUk1QixVQUFNLGNBQWMsMkJBQTJCLFFBQVE7QUFDdkQsUUFBSSxlQUFlLFdBQVcsS0FBSyxhQUFhLGNBQWMsQ0FBQyxHQUFHO0FBQ2hFLGFBQU8sRUFBRSxNQUFNLGdCQUFnQixRQUFRLE1BQU0sU0FBUyx3Q0FBd0M7QUFBQSxJQUNoRztBQUVBLFdBQU87QUFBQSxNQUNMLE1BQU07QUFBQSxNQUNOLFFBQVE7QUFBQSxNQUNSLFNBQVM7QUFBQSxJQUNYO0FBQUEsRUFDRjtBQVNBLFFBQU0sWUFBd0Q7QUFBQSxJQUM1RCxFQUFFLE1BQU0scUJBQXFCLFNBQVMsQ0FBQyxpQ0FBaUMsRUFBRTtBQUFBLElBQzFFLEVBQUUsTUFBTSxhQUFxQixTQUFTLENBQUMsOEJBQThCLEVBQUU7QUFBQSxJQUN2RSxFQUFFLE1BQU0sa0JBQXFCLFNBQVMsQ0FBQyw0QkFBNEIsRUFBRTtBQUFBLEVBQ3ZFO0FBRUEsYUFBVyxFQUFFLE1BQU0sUUFBUSxLQUFLLFdBQVc7QUFDekMsVUFBTSxXQUFXLEtBQUssVUFBVSxJQUFJO0FBQ3BDLFFBQUksQ0FBQyxXQUFXLFFBQVEsRUFBRztBQUUzQixRQUFJO0FBQ0YsWUFBTSxZQUFZLFNBQVMsUUFBUSxFQUFFO0FBSXJDLFVBQUksZUFBZTtBQUNuQixpQkFBVyxVQUFVLFNBQVM7QUFDNUIsY0FBTSxhQUFhLEtBQUssVUFBVSxNQUFNO0FBQ3hDLFlBQUksV0FBVyxVQUFVLEdBQUc7QUFDMUIseUJBQWUsS0FBSyxJQUFJLGNBQWMsU0FBUyxVQUFVLEVBQUUsT0FBTztBQUFBLFFBQ3BFO0FBQUEsTUFDRjtBQUNBLFVBQUksaUJBQWlCLEdBQUc7QUFDdEIsdUJBQWUsU0FBUyxXQUFXLEVBQUU7QUFBQSxNQUN2QztBQUVBLFVBQUksWUFBWSxjQUFjO0FBQzVCLGVBQU87QUFBQSxVQUNMLE1BQU07QUFBQSxVQUNOLFFBQVE7QUFBQSxVQUNSLFNBQVMsR0FBRyxJQUFJO0FBQUEsVUFDaEIsUUFBUTtBQUFBLFFBQ1Y7QUFBQSxNQUNGO0FBQUEsSUFDRixRQUFRO0FBQUEsSUFFUjtBQUFBLEVBQ0Y7QUFFQSxTQUFPLEVBQUUsTUFBTSxnQkFBZ0IsUUFBUSxNQUFNLFNBQVMseUJBQXlCO0FBQ2pGO0FBS0EsU0FBUyxjQUFjLFVBQWlEO0FBQ3RFLFFBQU0sY0FBYyxLQUFLLFVBQVUsY0FBYztBQUNqRCxNQUFJLENBQUMsV0FBVyxXQUFXLEVBQUcsUUFBTztBQUVyQyxRQUFNLFVBQVUsS0FBSyxVQUFVLE1BQU07QUFDckMsUUFBTSxlQUFlLEtBQUssVUFBVSxZQUFZO0FBRWhELE1BQUksQ0FBQyxXQUFXLE9BQU8sS0FBSyxDQUFDLFdBQVcsWUFBWSxHQUFHO0FBQ3JELFdBQU87QUFBQSxNQUNMLE1BQU07QUFBQSxNQUNOLFFBQVE7QUFBQSxNQUNSLFNBQVM7QUFBQSxNQUNULFFBQVE7QUFBQSxJQUNWO0FBQUEsRUFDRjtBQUVBLFNBQU8sRUFBRSxNQUFNLFlBQVksUUFBUSxNQUFNLFNBQVMsMkJBQTJCO0FBQy9FO0FBTUEsU0FBUyxtQkFBbUIsVUFBNEM7QUFFdEUsTUFBSSxRQUFRLGFBQWEsUUFBUyxRQUFPLENBQUM7QUFFMUMsUUFBTSxVQUFvQyxDQUFDO0FBRzNDLFFBQU0sZUFBZSxvQkFBSSxJQUFZO0FBQ3JDLFFBQU0sVUFBVSxLQUFLLFVBQVUsY0FBYztBQUU3QyxNQUFJLENBQUMsV0FBVyxPQUFPLEdBQUc7QUFJeEIsV0FBTyxDQUFDO0FBQUEsRUFDVjtBQUVBLE1BQUk7QUFDRixVQUFNLE1BQU0sS0FBSyxNQUFNLGFBQWEsU0FBUyxPQUFPLENBQUM7QUFDckQsVUFBTSxVQUFVLElBQUksV0FBVyxDQUFDO0FBQ2hDLFVBQU0sYUFBYSxPQUFPLE9BQU8sT0FBTyxFQUFFLEtBQUssR0FBRztBQUdsRCxVQUFNLGNBQWMsV0FBVyxTQUFTLDREQUE0RDtBQUNwRyxlQUFXLEtBQUssYUFBYTtBQUMzQixZQUFNLE9BQU8sU0FBUyxFQUFFLENBQUMsR0FBRyxFQUFFO0FBQzlCLFVBQUksUUFBUSxRQUFRLFFBQVEsTUFBTyxjQUFhLElBQUksSUFBSTtBQUFBLElBQzFEO0FBQUEsRUFDRixRQUFRO0FBRU4sV0FBTyxDQUFDO0FBQUEsRUFDVjtBQUlBLE1BQUksYUFBYSxTQUFTLEdBQUc7QUFDM0IsZUFBVyxLQUFLLG1CQUFtQjtBQUNqQyxVQUFJLE1BQU0sT0FBUSxRQUFRLGFBQWEsU0FBVTtBQUNqRCxtQkFBYSxJQUFJLENBQUM7QUFBQSxJQUNwQjtBQUFBLEVBQ0Y7QUFFQSxhQUFXLFFBQVEsY0FBYztBQUMvQixVQUFNLFNBQVMsUUFBUSxZQUFZLElBQUksb0JBQW9CLFFBQVE7QUFDbkUsUUFBSSxVQUFVLE9BQU8sU0FBUyxHQUFHO0FBRS9CLFlBQU0sYUFBYSxRQUFRLFlBQVksSUFBSSwrQkFBK0IsUUFBUTtBQUNsRixZQUFNLGNBQWMsWUFBWSxNQUFNLGtCQUFrQixJQUFJLENBQUMsS0FBSztBQUVsRSxjQUFRLEtBQUs7QUFBQSxRQUNYLE1BQU07QUFBQSxRQUNOLFFBQVE7QUFBQSxRQUNSLFNBQVMsUUFBUSxJQUFJLHlCQUF5QixXQUFXLFNBQVMsT0FBTyxNQUFNLElBQUksRUFBRSxDQUFDLENBQUM7QUFBQSxRQUN2RixRQUFRO0FBQUEsTUFDVixDQUFDO0FBQUEsSUFDSDtBQUFBLEVBQ0Y7QUFFQSxTQUFPO0FBQ1Q7QUFLQSxTQUFTLGVBQWUsVUFBaUQ7QUFFdkUsTUFBSSxRQUFRLGFBQWEsUUFBUyxRQUFPO0FBRXpDLFFBQU0sV0FBVyxRQUFRLFVBQVUsUUFBUSxlQUFlLFFBQVE7QUFDbEUsTUFBSSxDQUFDLFNBQVUsUUFBTztBQUV0QixNQUFJO0FBRUYsVUFBTSxRQUFRLFNBQVMsTUFBTSxLQUFLO0FBQ2xDLFVBQU0sVUFBVSxTQUFTLE1BQU0sQ0FBQyxHQUFHLEVBQUU7QUFDckMsUUFBSSxNQUFNLE9BQU8sRUFBRyxRQUFPO0FBRTNCLFVBQU0sYUFBYSxVQUFVO0FBQzdCLFVBQU0sVUFBVSxLQUFLLE1BQU0sY0FBYyxPQUFPLEtBQUs7QUFDckQsVUFBTSxXQUFXLGNBQWMsT0FBTyxPQUFPLE9BQU8sUUFBUSxDQUFDO0FBRTdELFFBQUksYUFBYSxnQkFBZ0I7QUFDL0IsYUFBTztBQUFBLFFBQ0wsTUFBTTtBQUFBLFFBQ04sUUFBUTtBQUFBLFFBQ1IsU0FBUyxtQkFBbUIsT0FBTztBQUFBLFFBQ25DLFFBQVE7QUFBQSxNQUNWO0FBQUEsSUFDRjtBQUVBLFFBQUksYUFBYSxpQkFBaUIsR0FBRztBQUNuQyxhQUFPO0FBQUEsUUFDTCxNQUFNO0FBQUEsUUFDTixRQUFRO0FBQUEsUUFDUixTQUFTLDJCQUEyQixPQUFPO0FBQUEsTUFDN0M7QUFBQSxJQUNGO0FBRUEsV0FBTyxFQUFFLE1BQU0sY0FBYyxRQUFRLE1BQU0sU0FBUyxHQUFHLE9BQU8sVUFBVTtBQUFBLEVBQzFFLFFBQVE7QUFDTixXQUFPO0FBQUEsRUFDVDtBQUNGO0FBS0EsU0FBUyxZQUFZLFVBQWlEO0FBQ3BFLFFBQU0sZ0JBQWdCLFdBQVcsS0FBSyxVQUFVLFlBQVksQ0FBQyxLQUMzRCxXQUFXLEtBQUssVUFBVSxvQkFBb0IsQ0FBQyxLQUMvQyxXQUFXLEtBQUssVUFBVSxxQkFBcUIsQ0FBQyxLQUNoRCxXQUFXLEtBQUssVUFBVSxhQUFhLENBQUMsS0FDeEMsV0FBVyxLQUFLLFVBQVUsY0FBYyxDQUFDO0FBRTNDLE1BQUksQ0FBQyxjQUFlLFFBQU87QUFFM0IsTUFBSSxDQUFDLGNBQWMsVUFBVSxRQUFRLEdBQUc7QUFDdEMsV0FBTztBQUFBLE1BQ0wsTUFBTTtBQUFBLE1BQ04sUUFBUTtBQUFBLE1BQ1IsU0FBUztBQUFBLElBQ1g7QUFBQSxFQUNGO0FBRUEsUUFBTSxPQUFPLFFBQVEsNkNBQTZDLFFBQVE7QUFDMUUsTUFBSSxDQUFDLE1BQU07QUFDVCxXQUFPO0FBQUEsTUFDTCxNQUFNO0FBQUEsTUFDTixRQUFRO0FBQUEsTUFDUixTQUFTO0FBQUEsTUFDVCxRQUFRO0FBQUEsSUFDVjtBQUFBLEVBQ0Y7QUFFQSxTQUFPLEVBQUUsTUFBTSxVQUFVLFFBQVEsTUFBTSxTQUFTLFVBQVUsSUFBSSxHQUFHO0FBQ25FO0FBS0EsU0FBUyxrQkFBa0IsVUFBNEM7QUFDckUsUUFBTSxVQUFvQyxDQUFDO0FBQzNDLFFBQU0sVUFBVSxLQUFLLFVBQVUsY0FBYztBQUU3QyxNQUFJLENBQUMsV0FBVyxPQUFPLEVBQUcsUUFBTztBQUVqQyxNQUFJO0FBQ0YsVUFBTSxNQUFNLEtBQUssTUFBTSxhQUFhLFNBQVMsT0FBTyxDQUFDO0FBQ3JELFVBQU0sVUFBVTtBQUFBLE1BQ2QsR0FBSSxJQUFJLGdCQUFnQixDQUFDO0FBQUEsTUFDekIsR0FBSSxJQUFJLG1CQUFtQixDQUFDO0FBQUEsSUFDOUI7QUFHQSxVQUFNLGlCQUFpQixJQUFJO0FBQzNCLFFBQUksZ0JBQWdCO0FBQ2xCLFlBQU0sY0FBYyxlQUFlLE1BQU0sR0FBRyxFQUFFLENBQUM7QUFDL0MsVUFBSSxlQUFlLGdCQUFnQixTQUFTLENBQUMsY0FBYyxhQUFhLFFBQVEsR0FBRztBQUNqRixnQkFBUSxLQUFLO0FBQUEsVUFDWCxNQUFNO0FBQUEsVUFDTixRQUFRO0FBQUEsVUFDUixTQUFTLG9CQUFvQixXQUFXO0FBQUEsVUFDeEMsUUFBUSxnQ0FBZ0MsV0FBVztBQUFBLFFBQ3JELENBQUM7QUFBQSxNQUNIO0FBQUEsSUFDRjtBQUdBLFFBQUksUUFBUSxZQUFZLEtBQUssQ0FBQyxXQUFXLEtBQUssVUFBVSxnQkFBZ0IsUUFBUSxLQUFLLENBQUMsR0FBRztBQUN2RixjQUFRLEtBQUs7QUFBQSxRQUNYLE1BQU07QUFBQSxRQUNOLFFBQVE7QUFBQSxRQUNSLFNBQVM7QUFBQSxNQUNYLENBQUM7QUFBQSxJQUNIO0FBR0EsUUFBSSxXQUFXLEtBQUssVUFBVSxnQkFBZ0IsQ0FBQyxLQUFLLFdBQVcsS0FBSyxVQUFVLGtCQUFrQixDQUFDLEdBQUc7QUFDbEcsVUFBSSx1QkFBdUIsTUFBTSxNQUFNO0FBQ3JDLGdCQUFRLEtBQUs7QUFBQSxVQUNYLE1BQU07QUFBQSxVQUNOLFFBQVE7QUFBQSxVQUNSLFNBQVM7QUFBQSxRQUNYLENBQUM7QUFBQSxNQUNIO0FBQUEsSUFDRjtBQUdBLFFBQUksV0FBVyxLQUFLLFVBQVUsWUFBWSxDQUFDLEdBQUc7QUFDNUMsVUFBSSxDQUFDLGNBQWMsU0FBUyxRQUFRLEdBQUc7QUFDckMsZ0JBQVEsS0FBSztBQUFBLFVBQ1gsTUFBTTtBQUFBLFVBQ04sUUFBUTtBQUFBLFVBQ1IsU0FBUztBQUFBLFFBQ1gsQ0FBQztBQUFBLE1BQ0g7QUFBQSxJQUNGO0FBR0EsUUFBSSxXQUFXLEtBQUssVUFBVSxRQUFRLENBQUMsR0FBRztBQUN4QyxVQUFJLENBQUMsY0FBYyxNQUFNLFFBQVEsR0FBRztBQUNsQyxnQkFBUSxLQUFLO0FBQUEsVUFDWCxNQUFNO0FBQUEsVUFDTixRQUFRO0FBQUEsVUFDUixTQUFTO0FBQUEsUUFDWCxDQUFDO0FBQUEsTUFDSDtBQUFBLElBQ0Y7QUFBQSxFQUNGLFFBQVE7QUFBQSxFQUVSO0FBRUEsU0FBTztBQUNUO0FBS0EsU0FBUyxlQUFlLFVBQWlEO0FBRXZFLFFBQU0sU0FBUyxRQUFRLDZCQUE2QixRQUFRO0FBQzVELE1BQUksQ0FBQyxPQUFRLFFBQU87QUFHcEIsUUFBTSxTQUFTLFFBQVEsNENBQTRDLFFBQVE7QUFDM0UsTUFBSSxXQUFXLE1BQU07QUFDbkIsV0FBTztBQUFBLE1BQ0wsTUFBTTtBQUFBLE1BQ04sUUFBUTtBQUFBLE1BQ1IsU0FBUztBQUFBLE1BQ1QsUUFBUSxXQUFXLE1BQU07QUFBQSxJQUMzQjtBQUFBLEVBQ0Y7QUFFQSxTQUFPLEVBQUUsTUFBTSxjQUFjLFFBQVEsTUFBTSxTQUFTLHVCQUF1QjtBQUM3RTtBQU1BLFNBQVMsaUJBQWlCLFVBQWlEO0FBQ3pFLFFBQU0sVUFBVSxLQUFLLFVBQVUsY0FBYztBQUM3QyxNQUFJLENBQUMsV0FBVyxPQUFPLEVBQUcsUUFBTztBQUVqQyxNQUFJO0FBQ0YsVUFBTSxNQUFNLEtBQUssTUFBTSxhQUFhLFNBQVMsT0FBTyxDQUFDO0FBQ3JELFVBQU0sY0FBYyxJQUFJLFNBQVM7QUFDakMsUUFBSSxDQUFDLFlBQWEsUUFBTztBQUV6QixVQUFNLFNBQVMsUUFBUSxzQkFBc0IsUUFBUTtBQUNyRCxRQUFJLFdBQVcsTUFBTTtBQUNuQixhQUFPO0FBQUEsUUFDTCxNQUFNO0FBQUEsUUFDTixRQUFRO0FBQUEsUUFDUixTQUFTO0FBQUEsUUFDVCxRQUFRO0FBQUEsTUFDVjtBQUFBLElBQ0Y7QUFDQSxXQUFPLEVBQUUsTUFBTSxTQUFTLFFBQVEsTUFBTSxTQUFTLGVBQWU7QUFBQSxFQUNoRSxRQUFRO0FBQ04sV0FBTztBQUFBLEVBQ1Q7QUFDRjtBQU1BLFNBQVMsZ0JBQWdCLFVBQWlEO0FBQ3hFLFFBQU0sVUFBVSxLQUFLLFVBQVUsY0FBYztBQUM3QyxNQUFJLENBQUMsV0FBVyxPQUFPLEVBQUcsUUFBTztBQUVqQyxNQUFJO0FBQ0YsVUFBTSxNQUFNLEtBQUssTUFBTSxhQUFhLFNBQVMsT0FBTyxDQUFDO0FBQ3JELFVBQU0sYUFBYSxJQUFJLFNBQVM7QUFFaEMsUUFBSSxDQUFDLGNBQWMsV0FBVyxTQUFTLG1CQUFtQixFQUFHLFFBQU87QUFFcEUsVUFBTSxTQUFTLFFBQVEsaUJBQWlCLFFBQVE7QUFDaEQsUUFBSSxXQUFXLE1BQU07QUFDbkIsYUFBTztBQUFBLFFBQ0wsTUFBTTtBQUFBLFFBQ04sUUFBUTtBQUFBLFFBQ1IsU0FBUztBQUFBLFFBQ1QsUUFBUTtBQUFBLE1BQ1Y7QUFBQSxJQUNGO0FBQ0EsV0FBTyxFQUFFLE1BQU0sUUFBUSxRQUFRLE1BQU0sU0FBUyxhQUFhO0FBQUEsRUFDN0QsUUFBUTtBQUNOLFdBQU87QUFBQSxFQUNUO0FBQ0Y7QUFRTyxTQUFTLHFCQUFxQixVQUE0QztBQUMvRSxRQUFNLFVBQW9DLENBQUM7QUFFM0MsUUFBTSxZQUFZLGlCQUFpQixRQUFRO0FBQzNDLE1BQUksVUFBVyxTQUFRLEtBQUssU0FBUztBQUVyQyxRQUFNLFlBQVksMkJBQTJCLFFBQVE7QUFDckQsTUFBSSxVQUFXLFNBQVEsS0FBSyxTQUFTO0FBRXJDLFFBQU0sV0FBVyxjQUFjLFFBQVE7QUFDdkMsTUFBSSxTQUFVLFNBQVEsS0FBSyxRQUFRO0FBRW5DLFVBQVEsS0FBSyxHQUFHLG1CQUFtQixRQUFRLENBQUM7QUFFNUMsUUFBTSxZQUFZLGVBQWUsUUFBUTtBQUN6QyxNQUFJLFVBQVcsU0FBUSxLQUFLLFNBQVM7QUFFckMsUUFBTSxjQUFjLFlBQVksUUFBUTtBQUN4QyxNQUFJLFlBQWEsU0FBUSxLQUFLLFdBQVc7QUFFekMsVUFBUSxLQUFLLEdBQUcsa0JBQWtCLFFBQVEsQ0FBQztBQUszQyxTQUFPO0FBQ1Q7QUFNTyxTQUFTLHlCQUF5QixVQUE0QztBQUNuRixRQUFNLFVBQVUscUJBQXFCLFFBQVE7QUFFN0MsUUFBTSxjQUFjLGVBQWUsUUFBUTtBQUMzQyxNQUFJLFlBQWEsU0FBUSxLQUFLLFdBQVc7QUFFekMsU0FBTztBQUNUO0FBTU8sU0FBUyx5QkFDZCxVQUNBLFNBQzBCO0FBQzFCLFFBQU0sVUFBb0MsQ0FBQztBQUMzQyxNQUFJLFNBQVMsY0FBYztBQUN6QixVQUFNLGFBQWEsaUJBQWlCLFFBQVE7QUFDNUMsUUFBSSxXQUFZLFNBQVEsS0FBSyxVQUFVO0FBQUEsRUFDekM7QUFDQSxNQUFJLFNBQVMsY0FBYztBQUN6QixVQUFNLFlBQVksZ0JBQWdCLFFBQVE7QUFDMUMsUUFBSSxVQUFXLFNBQVEsS0FBSyxTQUFTO0FBQUEsRUFDdkM7QUFDQSxTQUFPO0FBQ1Q7QUFLTyxTQUFTLGlDQUFpQyxTQUFrRDtBQUNqRyxTQUFPLFFBQ0osT0FBTyxPQUFLLEVBQUUsV0FBVyxJQUFJLEVBQzdCLElBQUksUUFBTTtBQUFBLElBQ1QsVUFBVSxFQUFFLFdBQVcsVUFBVSxVQUFtQjtBQUFBLElBQ3BELE1BQU0sT0FBTyxFQUFFLElBQUk7QUFBQSxJQUNuQixPQUFPO0FBQUEsSUFDUCxRQUFRO0FBQUEsSUFDUixTQUFTLEVBQUUsU0FBUyxHQUFHLEVBQUUsT0FBTyxXQUFNLEVBQUUsTUFBTSxLQUFLLEVBQUU7QUFBQSxJQUNyRCxTQUFTO0FBQUEsRUFDWCxFQUFFO0FBQ047QUFNQSxlQUFzQix1QkFDcEIsVUFDQSxRQUNBLFNBQ2U7QUFDZixRQUFNLFVBQVUsU0FBUyxnQkFDckIseUJBQXlCLFFBQVEsSUFDakMscUJBQXFCLFFBQVE7QUFFakMsTUFBSSxTQUFTLGdCQUFnQixTQUFTLGNBQWM7QUFDbEQsWUFBUSxLQUFLLEdBQUcseUJBQXlCLFVBQVUsT0FBTyxDQUFDO0FBQUEsRUFDN0Q7QUFFQSxTQUFPLEtBQUssR0FBRyxpQ0FBaUMsT0FBTyxDQUFDO0FBQzFEO0FBS08sU0FBUyx3QkFBd0IsU0FBMkM7QUFDakYsTUFBSSxRQUFRLFdBQVcsRUFBRyxRQUFPO0FBRWpDLFFBQU0sUUFBa0IsQ0FBQztBQUN6QixRQUFNLEtBQUsscUJBQXFCO0FBRWhDLGFBQVcsS0FBSyxTQUFTO0FBQ3ZCLFVBQU0sT0FBTyxFQUFFLFdBQVcsT0FBTyxXQUFXLEVBQUUsV0FBVyxZQUFZLGlCQUFpQjtBQUN0RixVQUFNLEtBQUssS0FBSyxJQUFJLElBQUksRUFBRSxPQUFPLEVBQUU7QUFDbkMsUUFBSSxFQUFFLFVBQVUsRUFBRSxXQUFXLE1BQU07QUFDakMsWUFBTSxLQUFLLFFBQVEsRUFBRSxNQUFNLEVBQUU7QUFBQSxJQUMvQjtBQUFBLEVBQ0Y7QUFFQSxTQUFPLE1BQU0sS0FBSyxJQUFJO0FBQ3hCOyIsCiAgIm5hbWVzIjogW10KfQo=
