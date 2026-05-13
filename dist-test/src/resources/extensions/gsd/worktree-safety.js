import { existsSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { normalizeWorktreePathForCompare } from "./worktree-root.js";
import { listWorktrees } from "./worktree-manager.js";
import { getCurrentBranch } from "./worktree.js";
const fsOnlyDeps = {
  existsSync,
  lstatSync
};
const defaultDeps = {
  ...fsOnlyDeps,
  listRegisteredWorktrees(projectRoot) {
    return listWorktrees(projectRoot).map((worktree) => ({
      path: worktree.path,
      branch: worktree.branch
    }));
  },
  getCurrentBranch
};
function isValidMilestoneId(milestoneId) {
  return milestoneId.length > 0 && !/[\/\\]|\.\./.test(milestoneId);
}
function samePath(a, b) {
  return normalizeWorktreePathForCompare(a) === normalizeWorktreePathForCompare(b);
}
function failure(kind, reason, remediation, details) {
  return { ok: false, kind, reason, remediation, details };
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function createWorktreeSafetyModule(deps = defaultDeps) {
  return {
    validateUnitRoot(input) {
      if (input.writeScope === "planning-only") {
        return {
          ok: true,
          kind: "not-required",
          reason: "planning-only Units may write GSD artifacts without a source worktree"
        };
      }
      const milestoneId = input.milestoneId?.trim();
      if (!milestoneId) {
        return failure(
          "milestone-id-missing",
          `Source-writing Unit ${input.unitType} ${input.unitId} has no milestone id.`,
          "Resolve the Unit milestone before preparing a worktree root."
        );
      }
      if (!isValidMilestoneId(milestoneId)) {
        return failure(
          "milestone-id-invalid",
          `Milestone id "${milestoneId}" is not safe for worktree path resolution.`,
          "Use a milestone id without path separators or traversal segments.",
          { milestoneId }
        );
      }
      const projectRoot = resolve(input.projectRoot);
      const unitRoot = resolve(input.unitRoot);
      const expectedRoot = join(projectRoot, ".gsd", "worktrees", milestoneId);
      if (!samePath(unitRoot, expectedRoot)) {
        return failure(
          "invalid-root",
          `Unit root ${unitRoot} is not the expected worktree root for ${milestoneId}.`,
          "Prepare the Unit in its canonical milestone worktree before allowing source writes.",
          { expectedRoot, unitRoot }
        );
      }
      if (!deps.existsSync(unitRoot)) {
        return failure(
          "worktree-missing",
          `Worktree root ${unitRoot} does not exist.`,
          "Create or recover the milestone worktree before dispatching the source-writing Unit.",
          { unitRoot }
        );
      }
      const gitMarker = join(unitRoot, ".git");
      if (!deps.existsSync(gitMarker)) {
        return failure(
          "worktree-git-marker-missing",
          `Worktree root ${unitRoot} has no .git marker.`,
          "Recover or recreate the milestone worktree before dispatching the source-writing Unit.",
          { gitMarker }
        );
      }
      let gitMarkerStat;
      try {
        gitMarkerStat = deps.lstatSync(gitMarker);
      } catch (error) {
        return failure(
          "worktree-git-probe-failed",
          `Unable to inspect .git marker for worktree root ${unitRoot}.`,
          "Recover or recreate the milestone worktree before dispatching the source-writing Unit.",
          { gitMarker, error: errorMessage(error) }
        );
      }
      if (!gitMarkerStat.isFile()) {
        return failure(
          "worktree-git-marker-not-file",
          `Worktree root ${unitRoot} has a .git directory, not a registered worktree .git file.`,
          "Use a registered GSD worktree instead of a copied or nested repository.",
          { gitMarker }
        );
      }
      let registered;
      try {
        registered = deps.listRegisteredWorktrees?.(projectRoot);
      } catch (error) {
        return failure(
          "worktree-git-probe-failed",
          `Unable to list registered worktrees for project root ${projectRoot}.`,
          "Recover or recreate the milestone worktree before dispatching the source-writing Unit.",
          { projectRoot, error: errorMessage(error) }
        );
      }
      if (registered && !registered.some((worktree) => samePath(worktree.path, unitRoot))) {
        return failure(
          "worktree-unregistered",
          `Worktree root ${unitRoot} is not registered with git worktree list.`,
          "Recreate or re-register the milestone worktree before dispatching the source-writing Unit.",
          { unitRoot }
        );
      }
      if (input.emptyWorktreeWithProjectContent) {
        return failure(
          "empty-worktree-with-project-content",
          `Worktree root ${unitRoot} has no project content, but the project root does.`,
          "Resolve untracked project-root content or recreate the worktree so source writes stay isolated.",
          { unitRoot, projectRoot }
        );
      }
      const expectedBranch = input.expectedBranch?.trim();
      let branch;
      if (expectedBranch) {
        if (!deps.getCurrentBranch) {
          return failure(
            "worktree-git-probe-failed",
            `Branch verification requested for ${unitRoot} but no getCurrentBranch dependency is configured.`,
            "Recover or recreate the milestone worktree before dispatching the source-writing Unit.",
            { unitRoot, expectedBranch, error: "getCurrentBranch dep not provided" }
          );
        }
        try {
          branch = deps.getCurrentBranch(unitRoot);
        } catch (error) {
          return failure(
            "worktree-git-probe-failed",
            `Unable to resolve current branch for worktree root ${unitRoot}.`,
            "Recover or recreate the milestone worktree before dispatching the source-writing Unit.",
            { unitRoot, expectedBranch, error: errorMessage(error) }
          );
        }
        if (branch !== expectedBranch) {
          return failure(
            "branch-mismatch",
            `Worktree root ${unitRoot} is on branch ${branch}, expected ${expectedBranch}.`,
            "Switch to the expected milestone branch or recover the worktree before dispatching the Unit.",
            { branch, expectedBranch }
          );
        }
      }
      if (input.lease?.required && !input.lease.held) {
        return failure(
          "lease-lost",
          `Milestone lease for ${milestoneId} is not held by the current worker.`,
          "Reclaim the milestone lease before dispatching the source-writing Unit.",
          { owner: input.lease.owner ?? null }
        );
      }
      return {
        ok: true,
        kind: "safe",
        projectRoot,
        unitRoot,
        milestoneId,
        branch
      };
    }
  };
}
function createFsOnlyWorktreeSafetyModule() {
  return createWorktreeSafetyModule(fsOnlyDeps);
}
export {
  createFsOnlyWorktreeSafetyModule,
  createWorktreeSafetyModule
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC93b3JrdHJlZS1zYWZldHkudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFByb2plY3QvQXBwOiBHU0QtMlxuLy8gRmlsZSBQdXJwb3NlOiBXb3JrdHJlZSBTYWZldHkgbW9kdWxlIGNvbnRyYWN0IGZvciB2YWxpZGF0aW5nIHNvdXJjZS13cml0aW5nIFVuaXQgcm9vdHMuXG5cbmltcG9ydCB7IGV4aXN0c1N5bmMsIGxzdGF0U3luYywgdHlwZSBTdGF0cyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luLCByZXNvbHZlIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuXG5pbXBvcnQgeyBub3JtYWxpemVXb3JrdHJlZVBhdGhGb3JDb21wYXJlIH0gZnJvbSBcIi4vd29ya3RyZWUtcm9vdC5qc1wiO1xuaW1wb3J0IHsgbGlzdFdvcmt0cmVlcyB9IGZyb20gXCIuL3dvcmt0cmVlLW1hbmFnZXIuanNcIjtcbmltcG9ydCB7IGdldEN1cnJlbnRCcmFuY2ggfSBmcm9tIFwiLi93b3JrdHJlZS5qc1wiO1xuXG5leHBvcnQgdHlwZSBXb3JrdHJlZVNhZmV0eVdyaXRlU2NvcGUgPSBcInBsYW5uaW5nLW9ubHlcIiB8IFwic291cmNlLXdyaXRpbmdcIjtcblxuZXhwb3J0IHR5cGUgV29ya3RyZWVTYWZldHlGYWlsdXJlS2luZCA9XG4gIHwgXCJtaWxlc3RvbmUtaWQtaW52YWxpZFwiXG4gIHwgXCJtaWxlc3RvbmUtaWQtbWlzc2luZ1wiXG4gIHwgXCJpbnZhbGlkLXJvb3RcIlxuICB8IFwid29ya3RyZWUtbWlzc2luZ1wiXG4gIHwgXCJ3b3JrdHJlZS1naXQtbWFya2VyLW1pc3NpbmdcIlxuICB8IFwid29ya3RyZWUtZ2l0LW1hcmtlci1ub3QtZmlsZVwiXG4gIHwgXCJ3b3JrdHJlZS1naXQtcHJvYmUtZmFpbGVkXCJcbiAgfCBcIndvcmt0cmVlLXVucmVnaXN0ZXJlZFwiXG4gIHwgXCJicmFuY2gtbWlzbWF0Y2hcIlxuICB8IFwibGVhc2UtbG9zdFwiXG4gIHwgXCJlbXB0eS13b3JrdHJlZS13aXRoLXByb2plY3QtY29udGVudFwiO1xuXG5leHBvcnQgdHlwZSBXb3JrdHJlZVNhZmV0eVJlc3VsdCA9XG4gIHwge1xuICAgICAgb2s6IHRydWU7XG4gICAgICBraW5kOiBcIm5vdC1yZXF1aXJlZFwiO1xuICAgICAgcmVhc29uOiBzdHJpbmc7XG4gICAgfVxuICB8IHtcbiAgICAgIG9rOiB0cnVlO1xuICAgICAga2luZDogXCJzYWZlXCI7XG4gICAgICBwcm9qZWN0Um9vdDogc3RyaW5nO1xuICAgICAgdW5pdFJvb3Q6IHN0cmluZztcbiAgICAgIG1pbGVzdG9uZUlkOiBzdHJpbmc7XG4gICAgICBicmFuY2g/OiBzdHJpbmc7XG4gICAgfVxuICB8IHtcbiAgICAgIG9rOiBmYWxzZTtcbiAgICAgIGtpbmQ6IFdvcmt0cmVlU2FmZXR5RmFpbHVyZUtpbmQ7XG4gICAgICByZWFzb246IHN0cmluZztcbiAgICAgIHJlbWVkaWF0aW9uOiBzdHJpbmc7XG4gICAgICBkZXRhaWxzPzogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgbnVtYmVyIHwgYm9vbGVhbiB8IG51bGw+O1xuICAgIH07XG5cbmV4cG9ydCBpbnRlcmZhY2UgV29ya3RyZWVTYWZldHlJbnB1dCB7XG4gIHVuaXRUeXBlOiBzdHJpbmc7XG4gIHVuaXRJZDogc3RyaW5nO1xuICB3cml0ZVNjb3BlOiBXb3JrdHJlZVNhZmV0eVdyaXRlU2NvcGU7XG4gIHByb2plY3RSb290OiBzdHJpbmc7XG4gIHVuaXRSb290OiBzdHJpbmc7XG4gIG1pbGVzdG9uZUlkPzogc3RyaW5nIHwgbnVsbDtcbiAgZXhwZWN0ZWRCcmFuY2g/OiBzdHJpbmcgfCBudWxsO1xuICBlbXB0eVdvcmt0cmVlV2l0aFByb2plY3RDb250ZW50PzogYm9vbGVhbjtcbiAgbGVhc2U/OiB7XG4gICAgcmVxdWlyZWQ6IGJvb2xlYW47XG4gICAgaGVsZDogYm9vbGVhbjtcbiAgICBvd25lcj86IHN0cmluZyB8IG51bGw7XG4gIH07XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUmVnaXN0ZXJlZFdvcmt0cmVlIHtcbiAgcGF0aDogc3RyaW5nO1xuICBicmFuY2g/OiBzdHJpbmcgfCBudWxsO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFdvcmt0cmVlU2FmZXR5RGVwcyB7XG4gIGV4aXN0c1N5bmMocGF0aDogc3RyaW5nKTogYm9vbGVhbjtcbiAgbHN0YXRTeW5jKHBhdGg6IHN0cmluZyk6IFBpY2s8U3RhdHMsIFwiaXNGaWxlXCI+O1xuICBsaXN0UmVnaXN0ZXJlZFdvcmt0cmVlcz8ocHJvamVjdFJvb3Q6IHN0cmluZyk6IHJlYWRvbmx5IFJlZ2lzdGVyZWRXb3JrdHJlZVtdO1xuICBnZXRDdXJyZW50QnJhbmNoPyh1bml0Um9vdDogc3RyaW5nKTogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFdvcmt0cmVlU2FmZXR5TW9kdWxlIHtcbiAgdmFsaWRhdGVVbml0Um9vdChpbnB1dDogV29ya3RyZWVTYWZldHlJbnB1dCk6IFdvcmt0cmVlU2FmZXR5UmVzdWx0O1xufVxuXG5jb25zdCBmc09ubHlEZXBzOiBXb3JrdHJlZVNhZmV0eURlcHMgPSB7XG4gIGV4aXN0c1N5bmMsXG4gIGxzdGF0U3luYyxcbn07XG5cbmNvbnN0IGRlZmF1bHREZXBzOiBXb3JrdHJlZVNhZmV0eURlcHMgPSB7XG4gIC4uLmZzT25seURlcHMsXG4gIGxpc3RSZWdpc3RlcmVkV29ya3RyZWVzKHByb2plY3RSb290KSB7XG4gICAgcmV0dXJuIGxpc3RXb3JrdHJlZXMocHJvamVjdFJvb3QpLm1hcCgod29ya3RyZWUpID0+ICh7XG4gICAgICBwYXRoOiB3b3JrdHJlZS5wYXRoLFxuICAgICAgYnJhbmNoOiB3b3JrdHJlZS5icmFuY2gsXG4gICAgfSkpO1xuICB9LFxuICBnZXRDdXJyZW50QnJhbmNoLFxufTtcblxuZnVuY3Rpb24gaXNWYWxpZE1pbGVzdG9uZUlkKG1pbGVzdG9uZUlkOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIG1pbGVzdG9uZUlkLmxlbmd0aCA+IDAgJiYgIS9bXFwvXFxcXF18XFwuXFwuLy50ZXN0KG1pbGVzdG9uZUlkKTtcbn1cblxuZnVuY3Rpb24gc2FtZVBhdGgoYTogc3RyaW5nLCBiOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIG5vcm1hbGl6ZVdvcmt0cmVlUGF0aEZvckNvbXBhcmUoYSkgPT09IG5vcm1hbGl6ZVdvcmt0cmVlUGF0aEZvckNvbXBhcmUoYik7XG59XG5cbmZ1bmN0aW9uIGZhaWx1cmUoXG4gIGtpbmQ6IFdvcmt0cmVlU2FmZXR5RmFpbHVyZUtpbmQsXG4gIHJlYXNvbjogc3RyaW5nLFxuICByZW1lZGlhdGlvbjogc3RyaW5nLFxuICBkZXRhaWxzPzogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgbnVtYmVyIHwgYm9vbGVhbiB8IG51bGw+LFxuKTogV29ya3RyZWVTYWZldHlSZXN1bHQge1xuICByZXR1cm4geyBvazogZmFsc2UsIGtpbmQsIHJlYXNvbiwgcmVtZWRpYXRpb24sIGRldGFpbHMgfTtcbn1cblxuZnVuY3Rpb24gZXJyb3JNZXNzYWdlKGVycm9yOiB1bmtub3duKTogc3RyaW5nIHtcbiAgcmV0dXJuIGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVdvcmt0cmVlU2FmZXR5TW9kdWxlKFxuICBkZXBzOiBXb3JrdHJlZVNhZmV0eURlcHMgPSBkZWZhdWx0RGVwcyxcbik6IFdvcmt0cmVlU2FmZXR5TW9kdWxlIHtcbiAgcmV0dXJuIHtcbiAgICB2YWxpZGF0ZVVuaXRSb290KGlucHV0KSB7XG4gICAgICBpZiAoaW5wdXQud3JpdGVTY29wZSA9PT0gXCJwbGFubmluZy1vbmx5XCIpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgICBraW5kOiBcIm5vdC1yZXF1aXJlZFwiLFxuICAgICAgICAgIHJlYXNvbjogXCJwbGFubmluZy1vbmx5IFVuaXRzIG1heSB3cml0ZSBHU0QgYXJ0aWZhY3RzIHdpdGhvdXQgYSBzb3VyY2Ugd29ya3RyZWVcIixcbiAgICAgICAgfTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgbWlsZXN0b25lSWQgPSBpbnB1dC5taWxlc3RvbmVJZD8udHJpbSgpO1xuICAgICAgaWYgKCFtaWxlc3RvbmVJZCkge1xuICAgICAgICByZXR1cm4gZmFpbHVyZShcbiAgICAgICAgICBcIm1pbGVzdG9uZS1pZC1taXNzaW5nXCIsXG4gICAgICAgICAgYFNvdXJjZS13cml0aW5nIFVuaXQgJHtpbnB1dC51bml0VHlwZX0gJHtpbnB1dC51bml0SWR9IGhhcyBubyBtaWxlc3RvbmUgaWQuYCxcbiAgICAgICAgICBcIlJlc29sdmUgdGhlIFVuaXQgbWlsZXN0b25lIGJlZm9yZSBwcmVwYXJpbmcgYSB3b3JrdHJlZSByb290LlwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgaWYgKCFpc1ZhbGlkTWlsZXN0b25lSWQobWlsZXN0b25lSWQpKSB7XG4gICAgICAgIHJldHVybiBmYWlsdXJlKFxuICAgICAgICAgIFwibWlsZXN0b25lLWlkLWludmFsaWRcIixcbiAgICAgICAgICBgTWlsZXN0b25lIGlkIFwiJHttaWxlc3RvbmVJZH1cIiBpcyBub3Qgc2FmZSBmb3Igd29ya3RyZWUgcGF0aCByZXNvbHV0aW9uLmAsXG4gICAgICAgICAgXCJVc2UgYSBtaWxlc3RvbmUgaWQgd2l0aG91dCBwYXRoIHNlcGFyYXRvcnMgb3IgdHJhdmVyc2FsIHNlZ21lbnRzLlwiLFxuICAgICAgICAgIHsgbWlsZXN0b25lSWQgfSxcbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgcHJvamVjdFJvb3QgPSByZXNvbHZlKGlucHV0LnByb2plY3RSb290KTtcbiAgICAgIGNvbnN0IHVuaXRSb290ID0gcmVzb2x2ZShpbnB1dC51bml0Um9vdCk7XG4gICAgICBjb25zdCBleHBlY3RlZFJvb3QgPSBqb2luKHByb2plY3RSb290LCBcIi5nc2RcIiwgXCJ3b3JrdHJlZXNcIiwgbWlsZXN0b25lSWQpO1xuICAgICAgaWYgKCFzYW1lUGF0aCh1bml0Um9vdCwgZXhwZWN0ZWRSb290KSkge1xuICAgICAgICByZXR1cm4gZmFpbHVyZShcbiAgICAgICAgICBcImludmFsaWQtcm9vdFwiLFxuICAgICAgICAgIGBVbml0IHJvb3QgJHt1bml0Um9vdH0gaXMgbm90IHRoZSBleHBlY3RlZCB3b3JrdHJlZSByb290IGZvciAke21pbGVzdG9uZUlkfS5gLFxuICAgICAgICAgIFwiUHJlcGFyZSB0aGUgVW5pdCBpbiBpdHMgY2Fub25pY2FsIG1pbGVzdG9uZSB3b3JrdHJlZSBiZWZvcmUgYWxsb3dpbmcgc291cmNlIHdyaXRlcy5cIixcbiAgICAgICAgICB7IGV4cGVjdGVkUm9vdCwgdW5pdFJvb3QgfSxcbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgaWYgKCFkZXBzLmV4aXN0c1N5bmModW5pdFJvb3QpKSB7XG4gICAgICAgIHJldHVybiBmYWlsdXJlKFxuICAgICAgICAgIFwid29ya3RyZWUtbWlzc2luZ1wiLFxuICAgICAgICAgIGBXb3JrdHJlZSByb290ICR7dW5pdFJvb3R9IGRvZXMgbm90IGV4aXN0LmAsXG4gICAgICAgICAgXCJDcmVhdGUgb3IgcmVjb3ZlciB0aGUgbWlsZXN0b25lIHdvcmt0cmVlIGJlZm9yZSBkaXNwYXRjaGluZyB0aGUgc291cmNlLXdyaXRpbmcgVW5pdC5cIixcbiAgICAgICAgICB7IHVuaXRSb290IH0sXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGdpdE1hcmtlciA9IGpvaW4odW5pdFJvb3QsIFwiLmdpdFwiKTtcbiAgICAgIGlmICghZGVwcy5leGlzdHNTeW5jKGdpdE1hcmtlcikpIHtcbiAgICAgICAgcmV0dXJuIGZhaWx1cmUoXG4gICAgICAgICAgXCJ3b3JrdHJlZS1naXQtbWFya2VyLW1pc3NpbmdcIixcbiAgICAgICAgICBgV29ya3RyZWUgcm9vdCAke3VuaXRSb290fSBoYXMgbm8gLmdpdCBtYXJrZXIuYCxcbiAgICAgICAgICBcIlJlY292ZXIgb3IgcmVjcmVhdGUgdGhlIG1pbGVzdG9uZSB3b3JrdHJlZSBiZWZvcmUgZGlzcGF0Y2hpbmcgdGhlIHNvdXJjZS13cml0aW5nIFVuaXQuXCIsXG4gICAgICAgICAgeyBnaXRNYXJrZXIgfSxcbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgbGV0IGdpdE1hcmtlclN0YXQ6IFBpY2s8U3RhdHMsIFwiaXNGaWxlXCI+O1xuICAgICAgdHJ5IHtcbiAgICAgICAgZ2l0TWFya2VyU3RhdCA9IGRlcHMubHN0YXRTeW5jKGdpdE1hcmtlcik7XG4gICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICByZXR1cm4gZmFpbHVyZShcbiAgICAgICAgICBcIndvcmt0cmVlLWdpdC1wcm9iZS1mYWlsZWRcIixcbiAgICAgICAgICBgVW5hYmxlIHRvIGluc3BlY3QgLmdpdCBtYXJrZXIgZm9yIHdvcmt0cmVlIHJvb3QgJHt1bml0Um9vdH0uYCxcbiAgICAgICAgICBcIlJlY292ZXIgb3IgcmVjcmVhdGUgdGhlIG1pbGVzdG9uZSB3b3JrdHJlZSBiZWZvcmUgZGlzcGF0Y2hpbmcgdGhlIHNvdXJjZS13cml0aW5nIFVuaXQuXCIsXG4gICAgICAgICAgeyBnaXRNYXJrZXIsIGVycm9yOiBlcnJvck1lc3NhZ2UoZXJyb3IpIH0sXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIGlmICghZ2l0TWFya2VyU3RhdC5pc0ZpbGUoKSkge1xuICAgICAgICByZXR1cm4gZmFpbHVyZShcbiAgICAgICAgICBcIndvcmt0cmVlLWdpdC1tYXJrZXItbm90LWZpbGVcIixcbiAgICAgICAgICBgV29ya3RyZWUgcm9vdCAke3VuaXRSb290fSBoYXMgYSAuZ2l0IGRpcmVjdG9yeSwgbm90IGEgcmVnaXN0ZXJlZCB3b3JrdHJlZSAuZ2l0IGZpbGUuYCxcbiAgICAgICAgICBcIlVzZSBhIHJlZ2lzdGVyZWQgR1NEIHdvcmt0cmVlIGluc3RlYWQgb2YgYSBjb3BpZWQgb3IgbmVzdGVkIHJlcG9zaXRvcnkuXCIsXG4gICAgICAgICAgeyBnaXRNYXJrZXIgfSxcbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgbGV0IHJlZ2lzdGVyZWQ6IHJlYWRvbmx5IFJlZ2lzdGVyZWRXb3JrdHJlZVtdIHwgdW5kZWZpbmVkO1xuICAgICAgdHJ5IHtcbiAgICAgICAgcmVnaXN0ZXJlZCA9IGRlcHMubGlzdFJlZ2lzdGVyZWRXb3JrdHJlZXM/Lihwcm9qZWN0Um9vdCk7XG4gICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICByZXR1cm4gZmFpbHVyZShcbiAgICAgICAgICBcIndvcmt0cmVlLWdpdC1wcm9iZS1mYWlsZWRcIixcbiAgICAgICAgICBgVW5hYmxlIHRvIGxpc3QgcmVnaXN0ZXJlZCB3b3JrdHJlZXMgZm9yIHByb2plY3Qgcm9vdCAke3Byb2plY3RSb290fS5gLFxuICAgICAgICAgIFwiUmVjb3ZlciBvciByZWNyZWF0ZSB0aGUgbWlsZXN0b25lIHdvcmt0cmVlIGJlZm9yZSBkaXNwYXRjaGluZyB0aGUgc291cmNlLXdyaXRpbmcgVW5pdC5cIixcbiAgICAgICAgICB7IHByb2plY3RSb290LCBlcnJvcjogZXJyb3JNZXNzYWdlKGVycm9yKSB9LFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgaWYgKHJlZ2lzdGVyZWQgJiYgIXJlZ2lzdGVyZWQuc29tZSgod29ya3RyZWUpID0+IHNhbWVQYXRoKHdvcmt0cmVlLnBhdGgsIHVuaXRSb290KSkpIHtcbiAgICAgICAgcmV0dXJuIGZhaWx1cmUoXG4gICAgICAgICAgXCJ3b3JrdHJlZS11bnJlZ2lzdGVyZWRcIixcbiAgICAgICAgICBgV29ya3RyZWUgcm9vdCAke3VuaXRSb290fSBpcyBub3QgcmVnaXN0ZXJlZCB3aXRoIGdpdCB3b3JrdHJlZSBsaXN0LmAsXG4gICAgICAgICAgXCJSZWNyZWF0ZSBvciByZS1yZWdpc3RlciB0aGUgbWlsZXN0b25lIHdvcmt0cmVlIGJlZm9yZSBkaXNwYXRjaGluZyB0aGUgc291cmNlLXdyaXRpbmcgVW5pdC5cIixcbiAgICAgICAgICB7IHVuaXRSb290IH0sXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIGlmIChpbnB1dC5lbXB0eVdvcmt0cmVlV2l0aFByb2plY3RDb250ZW50KSB7XG4gICAgICAgIHJldHVybiBmYWlsdXJlKFxuICAgICAgICAgIFwiZW1wdHktd29ya3RyZWUtd2l0aC1wcm9qZWN0LWNvbnRlbnRcIixcbiAgICAgICAgICBgV29ya3RyZWUgcm9vdCAke3VuaXRSb290fSBoYXMgbm8gcHJvamVjdCBjb250ZW50LCBidXQgdGhlIHByb2plY3Qgcm9vdCBkb2VzLmAsXG4gICAgICAgICAgXCJSZXNvbHZlIHVudHJhY2tlZCBwcm9qZWN0LXJvb3QgY29udGVudCBvciByZWNyZWF0ZSB0aGUgd29ya3RyZWUgc28gc291cmNlIHdyaXRlcyBzdGF5IGlzb2xhdGVkLlwiLFxuICAgICAgICAgIHsgdW5pdFJvb3QsIHByb2plY3RSb290IH0sXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGV4cGVjdGVkQnJhbmNoID0gaW5wdXQuZXhwZWN0ZWRCcmFuY2g/LnRyaW0oKTtcbiAgICAgIGxldCBicmFuY2g6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICAgIGlmIChleHBlY3RlZEJyYW5jaCkge1xuICAgICAgICBpZiAoIWRlcHMuZ2V0Q3VycmVudEJyYW5jaCkge1xuICAgICAgICAgIHJldHVybiBmYWlsdXJlKFxuICAgICAgICAgICAgXCJ3b3JrdHJlZS1naXQtcHJvYmUtZmFpbGVkXCIsXG4gICAgICAgICAgICBgQnJhbmNoIHZlcmlmaWNhdGlvbiByZXF1ZXN0ZWQgZm9yICR7dW5pdFJvb3R9IGJ1dCBubyBnZXRDdXJyZW50QnJhbmNoIGRlcGVuZGVuY3kgaXMgY29uZmlndXJlZC5gLFxuICAgICAgICAgICAgXCJSZWNvdmVyIG9yIHJlY3JlYXRlIHRoZSBtaWxlc3RvbmUgd29ya3RyZWUgYmVmb3JlIGRpc3BhdGNoaW5nIHRoZSBzb3VyY2Utd3JpdGluZyBVbml0LlwiLFxuICAgICAgICAgICAgeyB1bml0Um9vdCwgZXhwZWN0ZWRCcmFuY2gsIGVycm9yOiBcImdldEN1cnJlbnRCcmFuY2ggZGVwIG5vdCBwcm92aWRlZFwiIH0sXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICB0cnkge1xuICAgICAgICAgIGJyYW5jaCA9IGRlcHMuZ2V0Q3VycmVudEJyYW5jaCh1bml0Um9vdCk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgcmV0dXJuIGZhaWx1cmUoXG4gICAgICAgICAgICBcIndvcmt0cmVlLWdpdC1wcm9iZS1mYWlsZWRcIixcbiAgICAgICAgICAgIGBVbmFibGUgdG8gcmVzb2x2ZSBjdXJyZW50IGJyYW5jaCBmb3Igd29ya3RyZWUgcm9vdCAke3VuaXRSb290fS5gLFxuICAgICAgICAgICAgXCJSZWNvdmVyIG9yIHJlY3JlYXRlIHRoZSBtaWxlc3RvbmUgd29ya3RyZWUgYmVmb3JlIGRpc3BhdGNoaW5nIHRoZSBzb3VyY2Utd3JpdGluZyBVbml0LlwiLFxuICAgICAgICAgICAgeyB1bml0Um9vdCwgZXhwZWN0ZWRCcmFuY2gsIGVycm9yOiBlcnJvck1lc3NhZ2UoZXJyb3IpIH0sXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoYnJhbmNoICE9PSBleHBlY3RlZEJyYW5jaCkge1xuICAgICAgICAgIHJldHVybiBmYWlsdXJlKFxuICAgICAgICAgICAgXCJicmFuY2gtbWlzbWF0Y2hcIixcbiAgICAgICAgICAgIGBXb3JrdHJlZSByb290ICR7dW5pdFJvb3R9IGlzIG9uIGJyYW5jaCAke2JyYW5jaH0sIGV4cGVjdGVkICR7ZXhwZWN0ZWRCcmFuY2h9LmAsXG4gICAgICAgICAgICBcIlN3aXRjaCB0byB0aGUgZXhwZWN0ZWQgbWlsZXN0b25lIGJyYW5jaCBvciByZWNvdmVyIHRoZSB3b3JrdHJlZSBiZWZvcmUgZGlzcGF0Y2hpbmcgdGhlIFVuaXQuXCIsXG4gICAgICAgICAgICB7IGJyYW5jaCwgZXhwZWN0ZWRCcmFuY2ggfSxcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGlmIChpbnB1dC5sZWFzZT8ucmVxdWlyZWQgJiYgIWlucHV0LmxlYXNlLmhlbGQpIHtcbiAgICAgICAgcmV0dXJuIGZhaWx1cmUoXG4gICAgICAgICAgXCJsZWFzZS1sb3N0XCIsXG4gICAgICAgICAgYE1pbGVzdG9uZSBsZWFzZSBmb3IgJHttaWxlc3RvbmVJZH0gaXMgbm90IGhlbGQgYnkgdGhlIGN1cnJlbnQgd29ya2VyLmAsXG4gICAgICAgICAgXCJSZWNsYWltIHRoZSBtaWxlc3RvbmUgbGVhc2UgYmVmb3JlIGRpc3BhdGNoaW5nIHRoZSBzb3VyY2Utd3JpdGluZyBVbml0LlwiLFxuICAgICAgICAgIHsgb3duZXI6IGlucHV0LmxlYXNlLm93bmVyID8/IG51bGwgfSxcbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IHRydWUsXG4gICAgICAgIGtpbmQ6IFwic2FmZVwiLFxuICAgICAgICBwcm9qZWN0Um9vdCxcbiAgICAgICAgdW5pdFJvb3QsXG4gICAgICAgIG1pbGVzdG9uZUlkLFxuICAgICAgICBicmFuY2gsXG4gICAgICB9O1xuICAgIH0sXG4gIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVGc09ubHlXb3JrdHJlZVNhZmV0eU1vZHVsZSgpOiBXb3JrdHJlZVNhZmV0eU1vZHVsZSB7XG4gIHJldHVybiBjcmVhdGVXb3JrdHJlZVNhZmV0eU1vZHVsZShmc09ubHlEZXBzKTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUdBLFNBQVMsWUFBWSxpQkFBNkI7QUFDbEQsU0FBUyxNQUFNLGVBQWU7QUFFOUIsU0FBUyx1Q0FBdUM7QUFDaEQsU0FBUyxxQkFBcUI7QUFDOUIsU0FBUyx3QkFBd0I7QUF1RWpDLE1BQU0sYUFBaUM7QUFBQSxFQUNyQztBQUFBLEVB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
