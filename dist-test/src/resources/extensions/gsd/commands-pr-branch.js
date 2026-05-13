import { execFileSync } from "node:child_process";
import {
  nativeGetCurrentBranch,
  nativeDetectMainBranch,
  nativeBranchExists
} from "./native-git-bridge.js";
const EXCLUDED_PATHS = [".gsd", ".planning", "PLAN.md"];
function git(basePath, args) {
  return execFileSync("git", args, { cwd: basePath, encoding: "utf-8" }).trim();
}
function gitAllowFail(basePath, args) {
  try {
    execFileSync("git", args, { cwd: basePath, encoding: "utf-8", stdio: "pipe" });
  } catch {
  }
}
function hasStagedChanges(basePath) {
  try {
    execFileSync("git", ["diff", "--cached", "--quiet"], {
      cwd: basePath,
      stdio: "pipe"
    });
    return false;
  } catch {
    return true;
  }
}
function isValidBranchName(name) {
  try {
    execFileSync("git", ["check-ref-format", "--branch", name], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
function getCodeOnlyCommits(basePath, base, head) {
  try {
    const allCommits = git(basePath, ["log", "--format=%H", `${base}..${head}`]).split("\n").filter(Boolean);
    const codeCommits = [];
    for (const sha of allCommits) {
      const files = git(basePath, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha]).split("\n").filter(Boolean);
      const hasCodeChanges = files.some(
        (f) => !f.startsWith(".gsd/") && !f.startsWith(".planning/") && f !== "PLAN.md"
      );
      if (hasCodeChanges) {
        codeCommits.push(sha);
      }
    }
    return codeCommits.reverse();
  } catch {
    return [];
  }
}
function cherryPickFiltered(basePath, sha) {
  git(basePath, ["cherry-pick", "--no-commit", "--allow-empty", sha]);
  gitAllowFail(basePath, ["reset", "HEAD", "--", ...EXCLUDED_PATHS]);
  gitAllowFail(basePath, ["checkout", "HEAD", "--", ...EXCLUDED_PATHS]);
  gitAllowFail(basePath, ["clean", "-fdq", "--", ...EXCLUDED_PATHS]);
  if (!hasStagedChanges(basePath)) {
    git(basePath, ["reset", "--hard", "HEAD"]);
    return false;
  }
  git(basePath, ["commit", "-C", sha]);
  return true;
}
function assertNoExcludedPaths(basePath, base) {
  const files = git(basePath, [
    "diff",
    "--name-only",
    `${base}..HEAD`
  ]).split("\n").filter(Boolean);
  const leaked = files.filter(
    (f) => f.startsWith(".gsd/") || f.startsWith(".planning/") || f === "PLAN.md"
  );
  if (leaked.length > 0) {
    throw new Error(
      `PR branch still contains excluded paths: ${leaked.slice(0, 5).join(", ")}${leaked.length > 5 ? ` (+${leaked.length - 5} more)` : ""}`
    );
  }
}
async function handlePrBranch(args, ctx) {
  const basePath = process.cwd();
  const dryRun = args.includes("--dry-run");
  const nameMatch = args.match(/--name\s+(\S+)/);
  const currentBranch = nativeGetCurrentBranch(basePath);
  const mainBranch = nativeDetectMainBranch(basePath);
  let baseRef;
  try {
    git(basePath, ["rev-parse", "--verify", "upstream/main"]);
    baseRef = "upstream/main";
  } catch {
    baseRef = mainBranch;
  }
  const commits = getCodeOnlyCommits(basePath, baseRef, "HEAD");
  if (commits.length === 0) {
    ctx.ui.notify("No code-only commits found (all commits only touch .gsd/ files).", "info");
    return;
  }
  if (dryRun) {
    const lines = [`Would create PR branch with ${commits.length} commits (filtering .gsd/ paths):
`];
    for (const sha of commits) {
      const msg = git(basePath, ["log", "--format=%s", "-1", sha]);
      lines.push(`  ${sha.slice(0, 8)} ${msg}`);
    }
    ctx.ui.notify(lines.join("\n"), "info");
    return;
  }
  const requestedName = nameMatch?.[1];
  if (requestedName && !isValidBranchName(requestedName)) {
    ctx.ui.notify(
      `Invalid branch name: ${requestedName}. Must satisfy git check-ref-format.`,
      "error"
    );
    return;
  }
  const defaultName = `pr/${currentBranch}`;
  const prBranch = requestedName ?? defaultName;
  if (!isValidBranchName(prBranch)) {
    ctx.ui.notify(
      `Derived branch name is invalid: ${prBranch}. Use --name to override.`,
      "error"
    );
    return;
  }
  if (nativeBranchExists(basePath, prBranch)) {
    ctx.ui.notify(
      `Branch ${prBranch} already exists. Use --name to specify a different name, or delete it first.`,
      "warning"
    );
    return;
  }
  try {
    git(basePath, ["checkout", "-b", prBranch, baseRef]);
    let picked = 0;
    let skipped = 0;
    for (const sha of commits) {
      try {
        if (cherryPickFiltered(basePath, sha)) {
          picked++;
        } else {
          skipped++;
        }
      } catch (pickErr) {
        gitAllowFail(basePath, ["cherry-pick", "--abort"]);
        gitAllowFail(basePath, ["reset", "--hard", "HEAD"]);
        const detail = pickErr instanceof Error ? pickErr.message : String(pickErr);
        ctx.ui.notify(
          `Cherry-pick conflict at ${sha.slice(0, 8)}. Picked ${picked}/${commits.length} commits. Resolve manually.
${detail}`,
          "warning"
        );
        git(basePath, ["checkout", currentBranch]);
        return;
      }
    }
    assertNoExcludedPaths(basePath, baseRef);
    const skippedMsg = skipped > 0 ? ` (${skipped} skipped \u2014 contained only planning artifacts)` : "";
    ctx.ui.notify(
      `Created ${prBranch} with ${picked} commits${skippedMsg} (no .gsd/ artifacts).
Switch back: git checkout ${currentBranch}`,
      "success"
    );
  } catch (err) {
    gitAllowFail(basePath, ["cherry-pick", "--abort"]);
    gitAllowFail(basePath, ["reset", "--hard", "HEAD"]);
    gitAllowFail(basePath, ["checkout", currentBranch]);
    const msg = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Failed to create PR branch: ${msg}`, "error");
  }
}
export {
  handlePrBranch
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9jb21tYW5kcy1wci1icmFuY2gudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogR1NEIENvbW1hbmQgXHUyMDE0IC9nc2QgcHItYnJhbmNoXG4gKlxuICogQ3JlYXRlcyBhIGNsZWFuIFBSIGJyYW5jaCBieSBjaGVycnktcGlja2luZyBjb21taXRzIHdoaWxlIHN0cmlwcGluZ1xuICogYW55IGNoYW5nZXMgdG8gLmdzZC8sIC5wbGFubmluZy8sIGFuZCBQTEFOLm1kIHBhdGhzLiBVc2VmdWwgZm9yXG4gKiB1cHN0cmVhbSBQUnMgd2hlcmUgcGxhbm5pbmcgYXJ0aWZhY3RzIHNob3VsZCBub3QgYmUgaW5jbHVkZWQuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBFeHRlbnNpb25Db21tYW5kQ29udGV4dCB9IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuXG5pbXBvcnQgeyBleGVjRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5cbmltcG9ydCB7XG4gIG5hdGl2ZUdldEN1cnJlbnRCcmFuY2gsXG4gIG5hdGl2ZURldGVjdE1haW5CcmFuY2gsXG4gIG5hdGl2ZUJyYW5jaEV4aXN0cyxcbn0gZnJvbSBcIi4vbmF0aXZlLWdpdC1icmlkZ2UuanNcIjtcblxuY29uc3QgRVhDTFVERURfUEFUSFMgPSBbXCIuZ3NkXCIsIFwiLnBsYW5uaW5nXCIsIFwiUExBTi5tZFwiXSBhcyBjb25zdDtcblxuZnVuY3Rpb24gZ2l0KGJhc2VQYXRoOiBzdHJpbmcsIGFyZ3M6IHJlYWRvbmx5IHN0cmluZ1tdKTogc3RyaW5nIHtcbiAgcmV0dXJuIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBhcmdzLCB7IGN3ZDogYmFzZVBhdGgsIGVuY29kaW5nOiBcInV0Zi04XCIgfSkudHJpbSgpO1xufVxuXG5mdW5jdGlvbiBnaXRBbGxvd0ZhaWwoYmFzZVBhdGg6IHN0cmluZywgYXJnczogcmVhZG9ubHkgc3RyaW5nW10pOiB2b2lkIHtcbiAgdHJ5IHtcbiAgICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgYXJncywgeyBjd2Q6IGJhc2VQYXRoLCBlbmNvZGluZzogXCJ1dGYtOFwiLCBzdGRpbzogXCJwaXBlXCIgfSk7XG4gIH0gY2F0Y2gge1xuICAgIC8vIGlnbm9yZWQgXHUyMDE0IGNhbGxlciBvcHRzIGludG8gbm9uLWZhdGFsIGJlaGF2aW9yXG4gIH1cbn1cblxuZnVuY3Rpb24gaGFzU3RhZ2VkQ2hhbmdlcyhiYXNlUGF0aDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHRyeSB7XG4gICAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcImRpZmZcIiwgXCItLWNhY2hlZFwiLCBcIi0tcXVpZXRcIl0sIHtcbiAgICAgIGN3ZDogYmFzZVBhdGgsXG4gICAgICBzdGRpbzogXCJwaXBlXCIsXG4gICAgfSk7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxufVxuXG5mdW5jdGlvbiBpc1ZhbGlkQnJhbmNoTmFtZShuYW1lOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgdHJ5IHtcbiAgICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiY2hlY2stcmVmLWZvcm1hdFwiLCBcIi0tYnJhbmNoXCIsIG5hbWVdLCB7IHN0ZGlvOiBcInBpcGVcIiB9KTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbmZ1bmN0aW9uIGdldENvZGVPbmx5Q29tbWl0cyhiYXNlUGF0aDogc3RyaW5nLCBiYXNlOiBzdHJpbmcsIGhlYWQ6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBhbGxDb21taXRzID0gZ2l0KGJhc2VQYXRoLCBbXCJsb2dcIiwgXCItLWZvcm1hdD0lSFwiLCBgJHtiYXNlfS4uJHtoZWFkfWBdKVxuICAgICAgLnNwbGl0KFwiXFxuXCIpXG4gICAgICAuZmlsdGVyKEJvb2xlYW4pO1xuICAgIGNvbnN0IGNvZGVDb21taXRzOiBzdHJpbmdbXSA9IFtdO1xuXG4gICAgZm9yIChjb25zdCBzaGEgb2YgYWxsQ29tbWl0cykge1xuICAgICAgY29uc3QgZmlsZXMgPSBnaXQoYmFzZVBhdGgsIFtcImRpZmYtdHJlZVwiLCBcIi0tbm8tY29tbWl0LWlkXCIsIFwiLS1uYW1lLW9ubHlcIiwgXCItclwiLCBzaGFdKVxuICAgICAgICAuc3BsaXQoXCJcXG5cIilcbiAgICAgICAgLmZpbHRlcihCb29sZWFuKTtcbiAgICAgIGNvbnN0IGhhc0NvZGVDaGFuZ2VzID0gZmlsZXMuc29tZShcbiAgICAgICAgKGYpID0+ICFmLnN0YXJ0c1dpdGgoXCIuZ3NkL1wiKSAmJiAhZi5zdGFydHNXaXRoKFwiLnBsYW5uaW5nL1wiKSAmJiBmICE9PSBcIlBMQU4ubWRcIixcbiAgICAgICk7XG4gICAgICBpZiAoaGFzQ29kZUNoYW5nZXMpIHtcbiAgICAgICAgY29kZUNvbW1pdHMucHVzaChzaGEpO1xuICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiBjb2RlQ29tbWl0cy5yZXZlcnNlKCk7IC8vIGNocm9ub2xvZ2ljYWwgZm9yIGNoZXJyeS1waWNraW5nXG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBbXTtcbiAgfVxufVxuXG4vKipcbiAqIENoZXJyeS1waWNrIGEgY29tbWl0IHdoaWxlIHN0cmlwcGluZyBleGNsdWRlZCBwYXRocyBmcm9tIHRoZSByZXN1bHRpbmdcbiAqIGNvbW1pdC4gUmV0dXJucyB0cnVlIGlmIGEgY29tbWl0IHdhcyBwcm9kdWNlZCwgZmFsc2UgaWYgbm90aGluZyByZW1haW5lZFxuICogYWZ0ZXIgZmlsdGVyaW5nLlxuICovXG5mdW5jdGlvbiBjaGVycnlQaWNrRmlsdGVyZWQoYmFzZVBhdGg6IHN0cmluZywgc2hhOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgZ2l0KGJhc2VQYXRoLCBbXCJjaGVycnktcGlja1wiLCBcIi0tbm8tY29tbWl0XCIsIFwiLS1hbGxvdy1lbXB0eVwiLCBzaGFdKTtcblxuICAvLyBVbnN0YWdlIGFueSBleGNsdWRlZCBwYXRocyBpbnRyb2R1Y2VkIGJ5IHRoZSBjaGVycnktcGljay5cbiAgZ2l0QWxsb3dGYWlsKGJhc2VQYXRoLCBbXCJyZXNldFwiLCBcIkhFQURcIiwgXCItLVwiLCAuLi5FWENMVURFRF9QQVRIU10pO1xuXG4gIC8vIFJlc3RvcmUgd29ya3RyZWUgc3RhdGUgZm9yIGV4Y2x1ZGVkIHBhdGhzIGZyb20gSEVBRCAoaWYgdHJhY2tlZCksXG4gIC8vIHRoZW4gcmVtb3ZlIGFueSBuZXdseSBpbnRyb2R1Y2VkIHVudHJhY2tlZCBmaWxlcyB1bmRlciB0aG9zZSBwYXRocy5cbiAgZ2l0QWxsb3dGYWlsKGJhc2VQYXRoLCBbXCJjaGVja291dFwiLCBcIkhFQURcIiwgXCItLVwiLCAuLi5FWENMVURFRF9QQVRIU10pO1xuICBnaXRBbGxvd0ZhaWwoYmFzZVBhdGgsIFtcImNsZWFuXCIsIFwiLWZkcVwiLCBcIi0tXCIsIC4uLkVYQ0xVREVEX1BBVEhTXSk7XG5cbiAgaWYgKCFoYXNTdGFnZWRDaGFuZ2VzKGJhc2VQYXRoKSkge1xuICAgIC8vIE5vdGhpbmcgcmVtYWluZWQgYWZ0ZXIgZmlsdGVyaW5nIFx1MjAxNCBkaXNjYXJkIHdvcmt0cmVlIHJlc2lkdWUgYW5kIHNraXAuXG4gICAgZ2l0KGJhc2VQYXRoLCBbXCJyZXNldFwiLCBcIi0taGFyZFwiLCBcIkhFQURcIl0pO1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIGdpdChiYXNlUGF0aCwgW1wiY29tbWl0XCIsIFwiLUNcIiwgc2hhXSk7XG4gIHJldHVybiB0cnVlO1xufVxuXG5mdW5jdGlvbiBhc3NlcnROb0V4Y2x1ZGVkUGF0aHMoYmFzZVBhdGg6IHN0cmluZywgYmFzZTogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGZpbGVzID0gZ2l0KGJhc2VQYXRoLCBbXG4gICAgXCJkaWZmXCIsXG4gICAgXCItLW5hbWUtb25seVwiLFxuICAgIGAke2Jhc2V9Li5IRUFEYCxcbiAgXSlcbiAgICAuc3BsaXQoXCJcXG5cIilcbiAgICAuZmlsdGVyKEJvb2xlYW4pO1xuICBjb25zdCBsZWFrZWQgPSBmaWxlcy5maWx0ZXIoXG4gICAgKGYpID0+IGYuc3RhcnRzV2l0aChcIi5nc2QvXCIpIHx8IGYuc3RhcnRzV2l0aChcIi5wbGFubmluZy9cIikgfHwgZiA9PT0gXCJQTEFOLm1kXCIsXG4gICk7XG4gIGlmIChsZWFrZWQubGVuZ3RoID4gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBQUiBicmFuY2ggc3RpbGwgY29udGFpbnMgZXhjbHVkZWQgcGF0aHM6ICR7bGVha2VkLnNsaWNlKDAsIDUpLmpvaW4oXCIsIFwiKX0ke1xuICAgICAgICBsZWFrZWQubGVuZ3RoID4gNSA/IGAgKCske2xlYWtlZC5sZW5ndGggLSA1fSBtb3JlKWAgOiBcIlwiXG4gICAgICB9YCxcbiAgICApO1xuICB9XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBoYW5kbGVQckJyYW5jaChcbiAgYXJnczogc3RyaW5nLFxuICBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGJhc2VQYXRoID0gcHJvY2Vzcy5jd2QoKTtcbiAgY29uc3QgZHJ5UnVuID0gYXJncy5pbmNsdWRlcyhcIi0tZHJ5LXJ1blwiKTtcbiAgY29uc3QgbmFtZU1hdGNoID0gYXJncy5tYXRjaCgvLS1uYW1lXFxzKyhcXFMrKS8pO1xuXG4gIGNvbnN0IGN1cnJlbnRCcmFuY2ggPSBuYXRpdmVHZXRDdXJyZW50QnJhbmNoKGJhc2VQYXRoKTtcbiAgY29uc3QgbWFpbkJyYW5jaCA9IG5hdGl2ZURldGVjdE1haW5CcmFuY2goYmFzZVBhdGgpO1xuXG4gIC8vIERldGVybWluZSBiYXNlIHJlZiAocHJlZmVyIHVwc3RyZWFtL21haW4gaWYgYXZhaWxhYmxlKVxuICBsZXQgYmFzZVJlZjogc3RyaW5nO1xuICB0cnkge1xuICAgIGdpdChiYXNlUGF0aCwgW1wicmV2LXBhcnNlXCIsIFwiLS12ZXJpZnlcIiwgXCJ1cHN0cmVhbS9tYWluXCJdKTtcbiAgICBiYXNlUmVmID0gXCJ1cHN0cmVhbS9tYWluXCI7XG4gIH0gY2F0Y2gge1xuICAgIGJhc2VSZWYgPSBtYWluQnJhbmNoO1xuICB9XG5cbiAgLy8gRmluZCBjb21taXRzIHdpdGggY29kZSBjaGFuZ2VzXG4gIGNvbnN0IGNvbW1pdHMgPSBnZXRDb2RlT25seUNvbW1pdHMoYmFzZVBhdGgsIGJhc2VSZWYsIFwiSEVBRFwiKTtcblxuICBpZiAoY29tbWl0cy5sZW5ndGggPT09IDApIHtcbiAgICBjdHgudWkubm90aWZ5KFwiTm8gY29kZS1vbmx5IGNvbW1pdHMgZm91bmQgKGFsbCBjb21taXRzIG9ubHkgdG91Y2ggLmdzZC8gZmlsZXMpLlwiLCBcImluZm9cIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKGRyeVJ1bikge1xuICAgIGNvbnN0IGxpbmVzID0gW2BXb3VsZCBjcmVhdGUgUFIgYnJhbmNoIHdpdGggJHtjb21taXRzLmxlbmd0aH0gY29tbWl0cyAoZmlsdGVyaW5nIC5nc2QvIHBhdGhzKTpcXG5gXTtcbiAgICBmb3IgKGNvbnN0IHNoYSBvZiBjb21taXRzKSB7XG4gICAgICBjb25zdCBtc2cgPSBnaXQoYmFzZVBhdGgsIFtcImxvZ1wiLCBcIi0tZm9ybWF0PSVzXCIsIFwiLTFcIiwgc2hhXSk7XG4gICAgICBsaW5lcy5wdXNoKGAgICR7c2hhLnNsaWNlKDAsIDgpfSAke21zZ31gKTtcbiAgICB9XG4gICAgY3R4LnVpLm5vdGlmeShsaW5lcy5qb2luKFwiXFxuXCIpLCBcImluZm9cIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgcmVxdWVzdGVkTmFtZSA9IG5hbWVNYXRjaD8uWzFdO1xuICBpZiAocmVxdWVzdGVkTmFtZSAmJiAhaXNWYWxpZEJyYW5jaE5hbWUocmVxdWVzdGVkTmFtZSkpIHtcbiAgICBjdHgudWkubm90aWZ5KFxuICAgICAgYEludmFsaWQgYnJhbmNoIG5hbWU6ICR7cmVxdWVzdGVkTmFtZX0uIE11c3Qgc2F0aXNmeSBnaXQgY2hlY2stcmVmLWZvcm1hdC5gLFxuICAgICAgXCJlcnJvclwiLFxuICAgICk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgZGVmYXVsdE5hbWUgPSBgcHIvJHtjdXJyZW50QnJhbmNofWA7XG4gIGNvbnN0IHByQnJhbmNoID0gcmVxdWVzdGVkTmFtZSA/PyBkZWZhdWx0TmFtZTtcblxuICBpZiAoIWlzVmFsaWRCcmFuY2hOYW1lKHByQnJhbmNoKSkge1xuICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICBgRGVyaXZlZCBicmFuY2ggbmFtZSBpcyBpbnZhbGlkOiAke3ByQnJhbmNofS4gVXNlIC0tbmFtZSB0byBvdmVycmlkZS5gLFxuICAgICAgXCJlcnJvclwiLFxuICAgICk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKG5hdGl2ZUJyYW5jaEV4aXN0cyhiYXNlUGF0aCwgcHJCcmFuY2gpKSB7XG4gICAgY3R4LnVpLm5vdGlmeShcbiAgICAgIGBCcmFuY2ggJHtwckJyYW5jaH0gYWxyZWFkeSBleGlzdHMuIFVzZSAtLW5hbWUgdG8gc3BlY2lmeSBhIGRpZmZlcmVudCBuYW1lLCBvciBkZWxldGUgaXQgZmlyc3QuYCxcbiAgICAgIFwid2FybmluZ1wiLFxuICAgICk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgdHJ5IHtcbiAgICAvLyBDcmVhdGUgY2xlYW4gYnJhbmNoIGZyb20gYmFzZVxuICAgIGdpdChiYXNlUGF0aCwgW1wiY2hlY2tvdXRcIiwgXCItYlwiLCBwckJyYW5jaCwgYmFzZVJlZl0pO1xuXG4gICAgLy8gQ2hlcnJ5LXBpY2sgd2l0aCBwYXRoIGZpbHRlclxuICAgIGxldCBwaWNrZWQgPSAwO1xuICAgIGxldCBza2lwcGVkID0gMDtcbiAgICBmb3IgKGNvbnN0IHNoYSBvZiBjb21taXRzKSB7XG4gICAgICB0cnkge1xuICAgICAgICBpZiAoY2hlcnJ5UGlja0ZpbHRlcmVkKGJhc2VQYXRoLCBzaGEpKSB7XG4gICAgICAgICAgcGlja2VkKys7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgc2tpcHBlZCsrO1xuICAgICAgICB9XG4gICAgICB9IGNhdGNoIChwaWNrRXJyKSB7XG4gICAgICAgIGdpdEFsbG93RmFpbChiYXNlUGF0aCwgW1wiY2hlcnJ5LXBpY2tcIiwgXCItLWFib3J0XCJdKTtcbiAgICAgICAgZ2l0QWxsb3dGYWlsKGJhc2VQYXRoLCBbXCJyZXNldFwiLCBcIi0taGFyZFwiLCBcIkhFQURcIl0pO1xuICAgICAgICBjb25zdCBkZXRhaWwgPSBwaWNrRXJyIGluc3RhbmNlb2YgRXJyb3IgPyBwaWNrRXJyLm1lc3NhZ2UgOiBTdHJpbmcocGlja0Vycik7XG4gICAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgICAgYENoZXJyeS1waWNrIGNvbmZsaWN0IGF0ICR7c2hhLnNsaWNlKDAsIDgpfS4gUGlja2VkICR7cGlja2VkfS8ke2NvbW1pdHMubGVuZ3RofSBjb21taXRzLiBSZXNvbHZlIG1hbnVhbGx5LlxcbiR7ZGV0YWlsfWAsXG4gICAgICAgICAgXCJ3YXJuaW5nXCIsXG4gICAgICAgICk7XG4gICAgICAgIGdpdChiYXNlUGF0aCwgW1wiY2hlY2tvdXRcIiwgY3VycmVudEJyYW5jaF0pO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gUG9zdC1jb25kaXRpb246IG5vIGV4Y2x1ZGVkIHBhdGhzIHNob3VsZCBhcHBlYXIgaW4gdGhlIFBSIGJyYW5jaCBkaWZmLlxuICAgIGFzc2VydE5vRXhjbHVkZWRQYXRocyhiYXNlUGF0aCwgYmFzZVJlZik7XG5cbiAgICBjb25zdCBza2lwcGVkTXNnID0gc2tpcHBlZCA+IDAgPyBgICgke3NraXBwZWR9IHNraXBwZWQgXHUyMDE0IGNvbnRhaW5lZCBvbmx5IHBsYW5uaW5nIGFydGlmYWN0cylgIDogXCJcIjtcbiAgICBjdHgudWkubm90aWZ5KFxuICAgICAgYENyZWF0ZWQgJHtwckJyYW5jaH0gd2l0aCAke3BpY2tlZH0gY29tbWl0cyR7c2tpcHBlZE1zZ30gKG5vIC5nc2QvIGFydGlmYWN0cykuXFxuU3dpdGNoIGJhY2s6IGdpdCBjaGVja291dCAke2N1cnJlbnRCcmFuY2h9YCxcbiAgICAgIFwic3VjY2Vzc1wiLFxuICAgICk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIC8vIFJlc3RvcmUgb3JpZ2luYWwgYnJhbmNoIG9uIGZhaWx1cmVcbiAgICBnaXRBbGxvd0ZhaWwoYmFzZVBhdGgsIFtcImNoZXJyeS1waWNrXCIsIFwiLS1hYm9ydFwiXSk7XG4gICAgZ2l0QWxsb3dGYWlsKGJhc2VQYXRoLCBbXCJyZXNldFwiLCBcIi0taGFyZFwiLCBcIkhFQURcIl0pO1xuICAgIGdpdEFsbG93RmFpbChiYXNlUGF0aCwgW1wiY2hlY2tvdXRcIiwgY3VycmVudEJyYW5jaF0pO1xuICAgIGNvbnN0IG1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICBjdHgudWkubm90aWZ5KGBGYWlsZWQgdG8gY3JlYXRlIFBSIGJyYW5jaDogJHttc2d9YCwgXCJlcnJvclwiKTtcbiAgfVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBVUEsU0FBUyxvQkFBb0I7QUFFN0I7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBRVAsTUFBTSxpQkFBaUIsQ0FBQyxRQUFRLGFBQWEsU0FBUztBQUV0RCxTQUFTLElBQUksVUFBa0IsTUFBaUM7QUFDOUQsU0FBTyxhQUFhLE9BQU8sTUFBTSxFQUFFLEtBQUssVUFBVSxVQUFVLFFBQVEsQ0FBQyxFQUFFLEtBQUs7QUFDOUU7QUFFQSxTQUFTLGFBQWEsVUFBa0IsTUFBK0I7QUFDckUsTUFBSTtBQUNGLGlCQUFhLE9BQU8sTUFBTSxFQUFFLEtBQUssVUFBVSxVQUFVLFNBQVMsT0FBTyxPQUFPLENBQUM7QUFBQSxFQUMvRSxRQUFRO0FBQUEsRUFFUjtBQUNGO0FBRUEsU0FBUyxpQkFBaUIsVUFBMkI7QUFDbkQsTUFBSTtBQUNGLGlCQUFhLE9BQU8sQ0FB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
