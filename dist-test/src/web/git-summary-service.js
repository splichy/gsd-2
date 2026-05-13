import { execFileSync } from "node:child_process";
import { relative, resolve, sep } from "node:path";
import {
  nativeDetectMainBranch,
  nativeHasChanges,
  nativeHasMergeConflicts,
  nativeGetCurrentBranch
} from "../resources/extensions/gsd/native-git-bridge.js";
import { resolveBridgeRuntimeConfig } from "./bridge-service.js";
import {
  GIT_SUMMARY_SCOPE
} from "../../web/lib/git-summary-contract.js";
const MAX_CHANGED_FILES = 25;
const CONFLICT_STATUS_CODES = /* @__PURE__ */ new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
function sanitizeGitError(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, " ").trim();
}
function gitExecTrim(basePath, args, allowFailure = false) {
  try {
    return execFileSync("git", args, {
      cwd: basePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        GIT_SVN_ID: ""
      }
    }).trim();
  } catch {
    if (allowFailure) return "";
    throw new Error(`git ${args.join(" ")} failed in ${basePath}`);
  }
}
function readGitStatusPorcelain(basePath) {
  try {
    return execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: basePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        GIT_SVN_ID: ""
      }
    });
  } catch {
    return "";
  }
}
function toGitPath(value) {
  return value.split(sep).join("/");
}
function repoRelativeProjectPath(projectCwd, repoRoot) {
  const gitPrefix = gitExecTrim(projectCwd, ["rev-parse", "--show-prefix"], true).replace(/\/$/, "");
  if (gitPrefix) {
    return gitPrefix;
  }
  const relativePath = toGitPath(relative(repoRoot, projectCwd));
  if (!relativePath || relativePath === ".") return "";
  if (relativePath === ".." || relativePath.startsWith("../")) return null;
  return relativePath;
}
function pathInsideProject(repoPath, projectPath) {
  if (projectPath === null || projectPath === "") return true;
  return repoPath === projectPath || repoPath.startsWith(`${projectPath}/`);
}
function toProjectPath(repoPath, projectPath) {
  if (projectPath === null || projectPath === "") return repoPath;
  if (repoPath === projectPath) return ".";
  return repoPath.startsWith(`${projectPath}/`) ? repoPath.slice(projectPath.length + 1) : repoPath;
}
function parsePorcelainPath(rawPath) {
  const renameArrow = " -> ";
  const arrowIndex = rawPath.lastIndexOf(renameArrow);
  const value = arrowIndex >= 0 ? rawPath.slice(arrowIndex + renameArrow.length) : rawPath;
  return value.trim();
}
function parseStatusLine(line, projectPath) {
  if (line.length < 3) return null;
  const status = line.slice(0, 2);
  const repoPath = parsePorcelainPath(line.slice(3));
  if (!repoPath || !pathInsideProject(repoPath, projectPath)) return null;
  const untracked = status === "??";
  const conflict = CONFLICT_STATUS_CODES.has(status);
  const staged = !untracked && !conflict && status[0] !== " ";
  const dirty = !untracked && !conflict && status[1] !== " ";
  return {
    path: toProjectPath(repoPath, projectPath),
    repoPath,
    status,
    staged,
    dirty,
    untracked,
    conflict
  };
}
function summarizeChangedFiles(changedFiles) {
  return changedFiles.reduce(
    (counts, file) => ({
      changed: counts.changed + 1,
      staged: counts.staged + Number(file.staged),
      dirty: counts.dirty + Number(file.dirty),
      untracked: counts.untracked + Number(file.untracked),
      conflicts: counts.conflicts + Number(file.conflict)
    }),
    {
      changed: 0,
      staged: 0,
      dirty: 0,
      untracked: 0,
      conflicts: 0
    }
  );
}
function collectChangedFiles(repoRoot, projectPath) {
  const porcelain = readGitStatusPorcelain(repoRoot);
  if (!porcelain.trim()) return [];
  return porcelain.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean).map((line) => parseStatusLine(line, projectPath)).filter((file) => file !== null);
}
async function collectCurrentProjectGitSummary(projectCwdOverride) {
  const config = resolveBridgeRuntimeConfig(void 0, projectCwdOverride);
  const projectCwd = resolve(config.projectCwd);
  const repoRoot = gitExecTrim(projectCwd, ["rev-parse", "--show-toplevel"], true);
  if (!repoRoot) {
    return {
      kind: "not_repo",
      project: {
        scope: GIT_SUMMARY_SCOPE,
        cwd: projectCwd,
        repoRoot: null,
        repoRelativePath: null
      },
      message: "Current project is not inside a Git repository."
    };
  }
  try {
    const resolvedRepoRoot = resolve(repoRoot);
    const projectPath = repoRelativeProjectPath(projectCwd, resolvedRepoRoot);
    const allChangedFiles = collectChangedFiles(resolvedRepoRoot, projectPath);
    const counts = summarizeChangedFiles(allChangedFiles);
    const branch = nativeGetCurrentBranch(resolvedRepoRoot) || null;
    const mainBranch = nativeDetectMainBranch(resolvedRepoRoot) || null;
    const hasChanges = projectPath === "" ? nativeHasChanges(resolvedRepoRoot) : counts.changed > 0;
    const hasConflicts = projectPath === "" ? nativeHasMergeConflicts(resolvedRepoRoot) : counts.conflicts > 0;
    return {
      kind: "repo",
      project: {
        scope: GIT_SUMMARY_SCOPE,
        cwd: projectCwd,
        repoRoot: resolvedRepoRoot,
        repoRelativePath: projectPath
      },
      branch,
      mainBranch,
      hasChanges,
      hasConflicts,
      counts,
      changedFiles: allChangedFiles.slice(0, MAX_CHANGED_FILES),
      truncatedFileCount: Math.max(0, allChangedFiles.length - MAX_CHANGED_FILES)
    };
  } catch (error) {
    throw new Error(`Current-project git summary failed: ${sanitizeGitError(error)}`);
  }
}
export {
  collectCurrentProjectGitSummary
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3dlYi9naXQtc3VtbWFyeS1zZXJ2aWNlLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyBleGVjRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCJcbmltcG9ydCB7IHJlbGF0aXZlLCByZXNvbHZlLCBzZXAgfSBmcm9tIFwibm9kZTpwYXRoXCJcblxuaW1wb3J0IHtcbiAgbmF0aXZlRGV0ZWN0TWFpbkJyYW5jaCxcbiAgbmF0aXZlSGFzQ2hhbmdlcyxcbiAgbmF0aXZlSGFzTWVyZ2VDb25mbGljdHMsXG4gIG5hdGl2ZUdldEN1cnJlbnRCcmFuY2gsXG59IGZyb20gXCIuLi9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvbmF0aXZlLWdpdC1icmlkZ2UudHNcIlxuaW1wb3J0IHsgcmVzb2x2ZUJyaWRnZVJ1bnRpbWVDb25maWcgfSBmcm9tIFwiLi9icmlkZ2Utc2VydmljZS50c1wiXG5pbXBvcnQge1xuICBHSVRfU1VNTUFSWV9TQ09QRSxcbiAgdHlwZSBHaXRTdW1tYXJ5Q291bnRzLFxuICB0eXBlIEdpdFN1bW1hcnlGaWxlLFxuICB0eXBlIEdpdFN1bW1hcnlSZXNwb25zZSxcbn0gZnJvbSBcIi4uLy4uL3dlYi9saWIvZ2l0LXN1bW1hcnktY29udHJhY3QudHNcIlxuXG5jb25zdCBNQVhfQ0hBTkdFRF9GSUxFUyA9IDI1XG5jb25zdCBDT05GTElDVF9TVEFUVVNfQ09ERVMgPSBuZXcgU2V0KFtcIkREXCIsIFwiQVVcIiwgXCJVRFwiLCBcIlVBXCIsIFwiRFVcIiwgXCJBQVwiLCBcIlVVXCJdKVxuXG5mdW5jdGlvbiBzYW5pdGl6ZUdpdEVycm9yKGVycm9yOiB1bmtub3duKTogc3RyaW5nIHtcbiAgY29uc3QgcmF3ID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpXG4gIHJldHVybiByYXcucmVwbGFjZSgvXFxzKy9nLCBcIiBcIikudHJpbSgpXG59XG5cbmZ1bmN0aW9uIGdpdEV4ZWNUcmltKGJhc2VQYXRoOiBzdHJpbmcsIGFyZ3M6IHN0cmluZ1tdLCBhbGxvd0ZhaWx1cmUgPSBmYWxzZSk6IHN0cmluZyB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBhcmdzLCB7XG4gICAgICBjd2Q6IGJhc2VQYXRoLFxuICAgICAgZW5jb2Rpbmc6IFwidXRmOFwiLFxuICAgICAgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdLFxuICAgICAgZW52OiB7XG4gICAgICAgIC4uLnByb2Nlc3MuZW52LFxuICAgICAgICBHSVRfVEVSTUlOQUxfUFJPTVBUOiBcIjBcIixcbiAgICAgICAgR0lUX0FTS1BBU1M6IFwiXCIsXG4gICAgICAgIEdJVF9TVk5fSUQ6IFwiXCIsXG4gICAgICB9LFxuICAgIH0pLnRyaW0oKVxuICB9IGNhdGNoIHtcbiAgICBpZiAoYWxsb3dGYWlsdXJlKSByZXR1cm4gXCJcIlxuICAgIHRocm93IG5ldyBFcnJvcihgZ2l0ICR7YXJncy5qb2luKFwiIFwiKX0gZmFpbGVkIGluICR7YmFzZVBhdGh9YClcbiAgfVxufVxuXG5mdW5jdGlvbiByZWFkR2l0U3RhdHVzUG9yY2VsYWluKGJhc2VQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICB0cnkge1xuICAgIHJldHVybiBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wic3RhdHVzXCIsIFwiLS1wb3JjZWxhaW5cIiwgXCItLXVudHJhY2tlZC1maWxlcz1hbGxcIl0sIHtcbiAgICAgIGN3ZDogYmFzZVBhdGgsXG4gICAgICBlbmNvZGluZzogXCJ1dGY4XCIsXG4gICAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0sXG4gICAgICBlbnY6IHtcbiAgICAgICAgLi4ucHJvY2Vzcy5lbnYsXG4gICAgICAgIEdJVF9URVJNSU5BTF9QUk9NUFQ6IFwiMFwiLFxuICAgICAgICBHSVRfQVNLUEFTUzogXCJcIixcbiAgICAgICAgR0lUX1NWTl9JRDogXCJcIixcbiAgICAgIH0sXG4gICAgfSlcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFwiXCJcbiAgfVxufVxuXG5mdW5jdGlvbiB0b0dpdFBhdGgodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiB2YWx1ZS5zcGxpdChzZXApLmpvaW4oXCIvXCIpXG59XG5cbmZ1bmN0aW9uIHJlcG9SZWxhdGl2ZVByb2plY3RQYXRoKHByb2plY3RDd2Q6IHN0cmluZywgcmVwb1Jvb3Q6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCBnaXRQcmVmaXggPSBnaXRFeGVjVHJpbShwcm9qZWN0Q3dkLCBbXCJyZXYtcGFyc2VcIiwgXCItLXNob3ctcHJlZml4XCJdLCB0cnVlKS5yZXBsYWNlKC9cXC8kLywgXCJcIilcbiAgaWYgKGdpdFByZWZpeCkge1xuICAgIHJldHVybiBnaXRQcmVmaXhcbiAgfVxuXG4gIGNvbnN0IHJlbGF0aXZlUGF0aCA9IHRvR2l0UGF0aChyZWxhdGl2ZShyZXBvUm9vdCwgcHJvamVjdEN3ZCkpXG4gIGlmICghcmVsYXRpdmVQYXRoIHx8IHJlbGF0aXZlUGF0aCA9PT0gXCIuXCIpIHJldHVybiBcIlwiXG4gIGlmIChyZWxhdGl2ZVBhdGggPT09IFwiLi5cIiB8fCByZWxhdGl2ZVBhdGguc3RhcnRzV2l0aChcIi4uL1wiKSkgcmV0dXJuIG51bGxcbiAgcmV0dXJuIHJlbGF0aXZlUGF0aFxufVxuXG5mdW5jdGlvbiBwYXRoSW5zaWRlUHJvamVjdChyZXBvUGF0aDogc3RyaW5nLCBwcm9qZWN0UGF0aDogc3RyaW5nIHwgbnVsbCk6IGJvb2xlYW4ge1xuICBpZiAocHJvamVjdFBhdGggPT09IG51bGwgfHwgcHJvamVjdFBhdGggPT09IFwiXCIpIHJldHVybiB0cnVlXG4gIHJldHVybiByZXBvUGF0aCA9PT0gcHJvamVjdFBhdGggfHwgcmVwb1BhdGguc3RhcnRzV2l0aChgJHtwcm9qZWN0UGF0aH0vYClcbn1cblxuZnVuY3Rpb24gdG9Qcm9qZWN0UGF0aChyZXBvUGF0aDogc3RyaW5nLCBwcm9qZWN0UGF0aDogc3RyaW5nIHwgbnVsbCk6IHN0cmluZyB7XG4gIGlmIChwcm9qZWN0UGF0aCA9PT0gbnVsbCB8fCBwcm9qZWN0UGF0aCA9PT0gXCJcIikgcmV0dXJuIHJlcG9QYXRoXG4gIGlmIChyZXBvUGF0aCA9PT0gcHJvamVjdFBhdGgpIHJldHVybiBcIi5cIlxuICByZXR1cm4gcmVwb1BhdGguc3RhcnRzV2l0aChgJHtwcm9qZWN0UGF0aH0vYCkgPyByZXBvUGF0aC5zbGljZShwcm9qZWN0UGF0aC5sZW5ndGggKyAxKSA6IHJlcG9QYXRoXG59XG5cbmZ1bmN0aW9uIHBhcnNlUG9yY2VsYWluUGF0aChyYXdQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCByZW5hbWVBcnJvdyA9IFwiIC0+IFwiXG4gIGNvbnN0IGFycm93SW5kZXggPSByYXdQYXRoLmxhc3RJbmRleE9mKHJlbmFtZUFycm93KVxuICBjb25zdCB2YWx1ZSA9IGFycm93SW5kZXggPj0gMCA/IHJhd1BhdGguc2xpY2UoYXJyb3dJbmRleCArIHJlbmFtZUFycm93Lmxlbmd0aCkgOiByYXdQYXRoXG4gIHJldHVybiB2YWx1ZS50cmltKClcbn1cblxuZnVuY3Rpb24gcGFyc2VTdGF0dXNMaW5lKGxpbmU6IHN0cmluZywgcHJvamVjdFBhdGg6IHN0cmluZyB8IG51bGwpOiBHaXRTdW1tYXJ5RmlsZSB8IG51bGwge1xuICBpZiAobGluZS5sZW5ndGggPCAzKSByZXR1cm4gbnVsbFxuXG4gIGNvbnN0IHN0YXR1cyA9IGxpbmUuc2xpY2UoMCwgMilcbiAgY29uc3QgcmVwb1BhdGggPSBwYXJzZVBvcmNlbGFpblBhdGgobGluZS5zbGljZSgzKSlcbiAgaWYgKCFyZXBvUGF0aCB8fCAhcGF0aEluc2lkZVByb2plY3QocmVwb1BhdGgsIHByb2plY3RQYXRoKSkgcmV0dXJuIG51bGxcblxuICBjb25zdCB1bnRyYWNrZWQgPSBzdGF0dXMgPT09IFwiPz9cIlxuICBjb25zdCBjb25mbGljdCA9IENPTkZMSUNUX1NUQVRVU19DT0RFUy5oYXMoc3RhdHVzKVxuICBjb25zdCBzdGFnZWQgPSAhdW50cmFja2VkICYmICFjb25mbGljdCAmJiBzdGF0dXNbMF0gIT09IFwiIFwiXG4gIGNvbnN0IGRpcnR5ID0gIXVudHJhY2tlZCAmJiAhY29uZmxpY3QgJiYgc3RhdHVzWzFdICE9PSBcIiBcIlxuXG4gIHJldHVybiB7XG4gICAgcGF0aDogdG9Qcm9qZWN0UGF0aChyZXBvUGF0aCwgcHJvamVjdFBhdGgpLFxuICAgIHJlcG9QYXRoLFxuICAgIHN0YXR1cyxcbiAgICBzdGFnZWQsXG4gICAgZGlydHksXG4gICAgdW50cmFja2VkLFxuICAgIGNvbmZsaWN0LFxuICB9XG59XG5cbmZ1bmN0aW9uIHN1bW1hcml6ZUNoYW5nZWRGaWxlcyhjaGFuZ2VkRmlsZXM6IEdpdFN1bW1hcnlGaWxlW10pOiBHaXRTdW1tYXJ5Q291bnRzIHtcbiAgcmV0dXJuIGNoYW5nZWRGaWxlcy5yZWR1Y2U8R2l0U3VtbWFyeUNvdW50cz4oXG4gICAgKGNvdW50cywgZmlsZSkgPT4gKHtcbiAgICAgIGNoYW5nZWQ6IGNvdW50cy5jaGFuZ2VkICsgMSxcbiAgICAgIHN0YWdlZDogY291bnRzLnN0YWdlZCArIE51bWJlcihmaWxlLnN0YWdlZCksXG4gICAgICBkaXJ0eTogY291bnRzLmRpcnR5ICsgTnVtYmVyKGZpbGUuZGlydHkpLFxuICAgICAgdW50cmFja2VkOiBjb3VudHMudW50cmFja2VkICsgTnVtYmVyKGZpbGUudW50cmFja2VkKSxcbiAgICAgIGNvbmZsaWN0czogY291bnRzLmNvbmZsaWN0cyArIE51bWJlcihmaWxlLmNvbmZsaWN0KSxcbiAgICB9KSxcbiAgICB7XG4gICAgICBjaGFuZ2VkOiAwLFxuICAgICAgc3RhZ2VkOiAwLFxuICAgICAgZGlydHk6IDAsXG4gICAgICB1bnRyYWNrZWQ6IDAsXG4gICAgICBjb25mbGljdHM6IDAsXG4gICAgfSxcbiAgKVxufVxuXG5mdW5jdGlvbiBjb2xsZWN0Q2hhbmdlZEZpbGVzKHJlcG9Sb290OiBzdHJpbmcsIHByb2plY3RQYXRoOiBzdHJpbmcgfCBudWxsKTogR2l0U3VtbWFyeUZpbGVbXSB7XG4gIGNvbnN0IHBvcmNlbGFpbiA9IHJlYWRHaXRTdGF0dXNQb3JjZWxhaW4ocmVwb1Jvb3QpXG4gIGlmICghcG9yY2VsYWluLnRyaW0oKSkgcmV0dXJuIFtdXG5cbiAgcmV0dXJuIHBvcmNlbGFpblxuICAgIC5zcGxpdCgvXFxyP1xcbi8pXG4gICAgLm1hcCgobGluZSkgPT4gbGluZS50cmltRW5kKCkpXG4gICAgLmZpbHRlcihCb29sZWFuKVxuICAgIC5tYXAoKGxpbmUpID0+IHBhcnNlU3RhdHVzTGluZShsaW5lLCBwcm9qZWN0UGF0aCkpXG4gICAgLmZpbHRlcigoZmlsZSk6IGZpbGUgaXMgR2l0U3VtbWFyeUZpbGUgPT4gZmlsZSAhPT0gbnVsbClcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNvbGxlY3RDdXJyZW50UHJvamVjdEdpdFN1bW1hcnkocHJvamVjdEN3ZE92ZXJyaWRlPzogc3RyaW5nKTogUHJvbWlzZTxHaXRTdW1tYXJ5UmVzcG9uc2U+IHtcbiAgY29uc3QgY29uZmlnID0gcmVzb2x2ZUJyaWRnZVJ1bnRpbWVDb25maWcodW5kZWZpbmVkLCBwcm9qZWN0Q3dkT3ZlcnJpZGUpXG4gIGNvbnN0IHByb2plY3RDd2QgPSByZXNvbHZlKGNvbmZpZy5wcm9qZWN0Q3dkKVxuXG4gIGNvbnN0IHJlcG9Sb290ID0gZ2l0RXhlY1RyaW0ocHJvamVjdEN3ZCwgW1wicmV2LXBhcnNlXCIsIFwiLS1zaG93LXRvcGxldmVsXCJdLCB0cnVlKVxuICBpZiAoIXJlcG9Sb290KSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGtpbmQ6IFwibm90X3JlcG9cIixcbiAgICAgIHByb2plY3Q6IHtcbiAgICAgICAgc2NvcGU6IEdJVF9TVU1NQVJZX1NDT1BFLFxuICAgICAgICBjd2Q6IHByb2plY3RDd2QsXG4gICAgICAgIHJlcG9Sb290OiBudWxsLFxuICAgICAgICByZXBvUmVsYXRpdmVQYXRoOiBudWxsLFxuICAgICAgfSxcbiAgICAgIG1lc3NhZ2U6IFwiQ3VycmVudCBwcm9qZWN0IGlzIG5vdCBpbnNpZGUgYSBHaXQgcmVwb3NpdG9yeS5cIixcbiAgICB9XG4gIH1cblxuICB0cnkge1xuICAgIGNvbnN0IHJlc29sdmVkUmVwb1Jvb3QgPSByZXNvbHZlKHJlcG9Sb290KVxuICAgIGNvbnN0IHByb2plY3RQYXRoID0gcmVwb1JlbGF0aXZlUHJvamVjdFBhdGgocHJvamVjdEN3ZCwgcmVzb2x2ZWRSZXBvUm9vdClcbiAgICBjb25zdCBhbGxDaGFuZ2VkRmlsZXMgPSBjb2xsZWN0Q2hhbmdlZEZpbGVzKHJlc29sdmVkUmVwb1Jvb3QsIHByb2plY3RQYXRoKVxuICAgIGNvbnN0IGNvdW50cyA9IHN1bW1hcml6ZUNoYW5nZWRGaWxlcyhhbGxDaGFuZ2VkRmlsZXMpXG4gICAgY29uc3QgYnJhbmNoID0gbmF0aXZlR2V0Q3VycmVudEJyYW5jaChyZXNvbHZlZFJlcG9Sb290KSB8fCBudWxsXG4gICAgY29uc3QgbWFpbkJyYW5jaCA9IG5hdGl2ZURldGVjdE1haW5CcmFuY2gocmVzb2x2ZWRSZXBvUm9vdCkgfHwgbnVsbFxuICAgIGNvbnN0IGhhc0NoYW5nZXMgPSBwcm9qZWN0UGF0aCA9PT0gXCJcIiA/IG5hdGl2ZUhhc0NoYW5nZXMocmVzb2x2ZWRSZXBvUm9vdCkgOiBjb3VudHMuY2hhbmdlZCA+IDBcbiAgICBjb25zdCBoYXNDb25mbGljdHMgPSBwcm9qZWN0UGF0aCA9PT0gXCJcIiA/IG5hdGl2ZUhhc01lcmdlQ29uZmxpY3RzKHJlc29sdmVkUmVwb1Jvb3QpIDogY291bnRzLmNvbmZsaWN0cyA+IDBcblxuICAgIHJldHVybiB7XG4gICAgICBraW5kOiBcInJlcG9cIixcbiAgICAgIHByb2plY3Q6IHtcbiAgICAgICAgc2NvcGU6IEdJVF9TVU1NQVJZX1NDT1BFLFxuICAgICAgICBjd2Q6IHByb2plY3RDd2QsXG4gICAgICAgIHJlcG9Sb290OiByZXNvbHZlZFJlcG9Sb290LFxuICAgICAgICByZXBvUmVsYXRpdmVQYXRoOiBwcm9qZWN0UGF0aCxcbiAgICAgIH0sXG4gICAgICBicmFuY2gsXG4gICAgICBtYWluQnJhbmNoLFxuICAgICAgaGFzQ2hhbmdlcyxcbiAgICAgIGhhc0NvbmZsaWN0cyxcbiAgICAgIGNvdW50cyxcbiAgICAgIGNoYW5nZWRGaWxlczogYWxsQ2hhbmdlZEZpbGVzLnNsaWNlKDAsIE1BWF9DSEFOR0VEX0ZJTEVTKSxcbiAgICAgIHRydW5jYXRlZEZpbGVDb3VudDogTWF0aC5tYXgoMCwgYWxsQ2hhbmdlZEZpbGVzLmxlbmd0aCAtIE1BWF9DSEFOR0VEX0ZJTEVTKSxcbiAgICB9XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBDdXJyZW50LXByb2plY3QgZ2l0IHN1bW1hcnkgZmFpbGVkOiAke3Nhbml0aXplR2l0RXJyb3IoZXJyb3IpfWApXG4gIH1cbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFNBQVMsb0JBQW9CO0FBQzdCLFNBQVMsVUFBVSxTQUFTLFdBQVc7QUFFdkM7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUNQLFNBQVMsa0NBQWtDO0FBQzNDO0FBQUEsRUFDRTtBQUFBLE9BSUs7QUFFUCxNQUFNLG9CQUFvQjtBQUMxQixNQUFNLHdCQUF3QixvQkFBSSxJQUFJLENBQUMsTUFBTSxNQUFNLE1BQU0sTUFBTSxNQUFNLE1BQU0sSUFBSSxDQUFDO0FBRWhGLFNBQVMsaUJBQWlCLE9BQXdCO0FBQ2hELFFBQU0sTUFBTSxpQkFBaUIsUUFBUSxNQUFNLFVBQVUsT0FBTyxLQUFLO0FBQ2pFLFNBQU8sSUFBSSxRQUFRLFFBQVEsR0FBRyxFQUFFLEtBQUs7QUFDdkM7QUFFQSxTQUFTLFlBQVksVUFBa0IsTUFBZ0IsZUFBZSxPQUFlO0FBQ25GLE1BQUk7QUFDRixXQUFPLGFBQWEsT0FBTyxNQUFNO0FBQUEsTUFDL0IsS0FBSztBQUFBLE1BQ0wsVUFBVTtBQUFBLE1BQ1YsT0FBTyxDQUFD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
