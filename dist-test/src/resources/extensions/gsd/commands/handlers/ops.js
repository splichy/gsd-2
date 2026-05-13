import { dispatchDirectPhase } from "../../auto-direct-dispatch.js";
import { handleConfig } from "../../commands-config.js";
import { handleDoctor, handleCapture, handleKnowledge, handleRunHook, handleSkillHealth, handleSteer, handleTriage, handleUpdate } from "../../commands-handlers.js";
import { handleInspect } from "../../commands-inspect.js";
import { handleLogs } from "../../commands-logs.js";
import { handleDebug } from "../../commands-debug.js";
import { handleCleanupBranches, handleCleanupSnapshots, handleSkip, handleCleanupProjects, handleCleanupWorktrees, handleRecover } from "../../commands-maintenance.js";
import { handleExport } from "../../export.js";
import { handleHistory } from "../../history.js";
import { handleUndo } from "../../undo.js";
import { handleRemote } from "../../../remote-questions/mod.js";
import { handleShip } from "../../commands-ship.js";
import { handleSessionReport } from "../../commands-session-report.js";
import { handlePrBranch } from "../../commands-pr-branch.js";
import { currentDirectoryRoot, projectRoot } from "../context.js";
async function handleOpsCommand(trimmed, ctx, pi) {
  if (trimmed === "init") {
    const { detectProjectState } = await import("../../detection.js");
    const { handleReinit, showProjectInit } = await import("../../init-wizard.js");
    const basePath = projectRoot();
    const detection = detectProjectState(basePath);
    if (detection.state === "v2-gsd" || detection.state === "v2-gsd-empty") {
      await handleReinit(ctx, detection);
    } else {
      await showProjectInit(ctx, pi, basePath, detection);
    }
    return true;
  }
  if (trimmed === "keys" || trimmed.startsWith("keys ")) {
    const { handleKeys } = await import("../../key-manager.js");
    await handleKeys(trimmed.replace(/^keys\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "doctor" || trimmed.startsWith("doctor ")) {
    await handleDoctor(trimmed.replace(/^doctor\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "logs" || trimmed.startsWith("logs ")) {
    await handleLogs(trimmed.replace(/^logs\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "debug" || trimmed.startsWith("debug ")) {
    await handleDebug(trimmed.replace(/^debug\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "forensics" || trimmed.startsWith("forensics ")) {
    const { handleForensics } = await import("../../forensics.js");
    await handleForensics(trimmed.replace(/^forensics\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "changelog" || trimmed.startsWith("changelog ")) {
    const { handleChangelog } = await import("../../changelog.js");
    await handleChangelog(trimmed.replace(/^changelog\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "history" || trimmed.startsWith("history ")) {
    await handleHistory(trimmed.replace(/^history\s*/, "").trim(), ctx, projectRoot());
    return true;
  }
  if (trimmed === "undo-task" || trimmed.startsWith("undo-task ")) {
    const { handleUndoTask } = await import("../../undo.js");
    await handleUndoTask(trimmed.replace(/^undo-task\s*/, "").trim(), ctx, pi, projectRoot());
    return true;
  }
  if (trimmed === "reset-slice" || trimmed.startsWith("reset-slice ")) {
    const { handleResetSlice } = await import("../../undo.js");
    await handleResetSlice(trimmed.replace(/^reset-slice\s*/, "").trim(), ctx, pi, projectRoot());
    return true;
  }
  if (trimmed === "undo" || trimmed.startsWith("undo ")) {
    await handleUndo(trimmed.replace(/^undo\s*/, "").trim(), ctx, pi, projectRoot());
    return true;
  }
  if (trimmed === "skip") {
    ctx.ui.notify("Usage: /gsd skip <unit-id>  Example: /gsd skip M001/S01/T03", "warning");
    return true;
  }
  if (trimmed.startsWith("skip ")) {
    await handleSkip(trimmed.replace(/^skip\s*/, "").trim(), ctx, projectRoot());
    return true;
  }
  if (trimmed === "recover") {
    await handleRecover(ctx, projectRoot());
    return true;
  }
  if (trimmed === "export" || trimmed.startsWith("export ")) {
    await handleExport(trimmed.replace(/^export\s*/, "").trim(), ctx, projectRoot());
    return true;
  }
  if (trimmed === "cleanup projects" || trimmed.startsWith("cleanup projects ")) {
    await handleCleanupProjects(trimmed.replace(/^cleanup projects\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "cleanup worktrees") {
    await handleCleanupWorktrees(ctx, projectRoot());
    return true;
  }
  if (trimmed === "cleanup") {
    await handleCleanupBranches(ctx, projectRoot());
    await handleCleanupSnapshots(ctx, projectRoot());
    return true;
  }
  if (trimmed === "cleanup branches") {
    await handleCleanupBranches(ctx, projectRoot());
    return true;
  }
  if (trimmed === "cleanup snapshots") {
    await handleCleanupSnapshots(ctx, projectRoot());
    return true;
  }
  if (trimmed.startsWith("capture ") || trimmed === "capture") {
    await handleCapture(trimmed.replace(/^capture\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "triage") {
    await handleTriage(ctx, pi, currentDirectoryRoot());
    return true;
  }
  if (trimmed === "config") {
    await handleConfig(ctx);
    return true;
  }
  if (trimmed === "hooks") {
    const { formatHookStatus } = await import("../../post-unit-hooks.js");
    ctx.ui.notify(formatHookStatus(), "info");
    return true;
  }
  if (trimmed === "skill-health" || trimmed.startsWith("skill-health ")) {
    await handleSkillHealth(trimmed.replace(/^skill-health\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed.startsWith("run-hook ")) {
    await handleRunHook(trimmed.replace(/^run-hook\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "run-hook") {
    ctx.ui.notify(`Usage: /gsd run-hook <hook-name> <unit-type> <unit-id>

Unit types:
  execute-task   - Task execution (unit-id: M001/S01/T01)
  plan-slice     - Slice planning (unit-id: M001/S01)
  research-milestone - Milestone research (unit-id: M001)
  complete-slice - Slice completion (unit-id: M001/S01)
  complete-milestone - Milestone completion (unit-id: M001)

Examples:
  /gsd run-hook code-review execute-task M001/S01/T01
  /gsd run-hook lint-check plan-slice M001/S01`, "warning");
    return true;
  }
  if (trimmed.startsWith("steer ")) {
    await handleSteer(trimmed.replace(/^steer\s+/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "steer") {
    ctx.ui.notify("Usage: /gsd steer <description of change>. Example: /gsd steer Use Postgres instead of SQLite", "warning");
    return true;
  }
  if (trimmed.startsWith("knowledge ")) {
    await handleKnowledge(trimmed.replace(/^knowledge\s+/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "knowledge") {
    ctx.ui.notify("Usage: /gsd knowledge <rule|pattern|lesson> <description>. Example: /gsd knowledge rule Use real DB for integration tests", "warning");
    return true;
  }
  if (trimmed === "migrate" || trimmed.startsWith("migrate ")) {
    const { handleMigrate } = await import("../../migrate/command.js");
    await handleMigrate(trimmed.replace(/^migrate\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "remote" || trimmed.startsWith("remote ")) {
    await handleRemote(trimmed.replace(/^remote\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "dispatch" || trimmed.startsWith("dispatch ")) {
    const phase = trimmed.replace(/^dispatch\s*/, "").trim();
    if (!phase) {
      ctx.ui.notify("Usage: /gsd dispatch <phase>  (research|plan|execute|complete|reassess|uat|replan)", "warning");
      return true;
    }
    await dispatchDirectPhase(ctx, pi, phase, projectRoot());
    return true;
  }
  if (trimmed === "notifications" || trimmed.startsWith("notifications ")) {
    const { handleNotificationsCommand } = await import("./notifications-handler.js");
    await handleNotificationsCommand(trimmed.replace(/^notifications\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "escalate" || trimmed.startsWith("escalate ")) {
    const { handleEscalateCommand } = await import("./escalate.js");
    await handleEscalateCommand(trimmed.replace(/^escalate\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "inspect") {
    await handleInspect(ctx);
    return true;
  }
  if (trimmed === "update") {
    await handleUpdate(ctx);
    return true;
  }
  if (trimmed === "fast" || trimmed.startsWith("fast ")) {
    const { handleFast } = await import("../../service-tier.js");
    await handleFast(trimmed.replace(/^fast\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "mcp" || trimmed.startsWith("mcp ")) {
    const { handleMcpStatus } = await import("../../commands-mcp-status.js");
    await handleMcpStatus(trimmed.replace(/^mcp\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "extensions" || trimmed.startsWith("extensions ")) {
    const { handleExtensions } = await import("../../commands-extensions.js");
    await handleExtensions(trimmed.replace(/^extensions\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "rethink") {
    const { handleRethink } = await import("../../rethink.js");
    await handleRethink(trimmed, ctx, pi);
    return true;
  }
  if (trimmed === "codebase" || trimmed.startsWith("codebase ")) {
    const { handleCodebase } = await import("../../commands-codebase.js");
    await handleCodebase(trimmed.replace(/^codebase\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "ship" || trimmed.startsWith("ship ")) {
    await handleShip(trimmed.replace(/^ship\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "session-report" || trimmed.startsWith("session-report ")) {
    await handleSessionReport(trimmed.replace(/^session-report\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "pr-branch" || trimmed.startsWith("pr-branch ")) {
    await handlePrBranch(trimmed.replace(/^pr-branch\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "add-tests" || trimmed.startsWith("add-tests ")) {
    const { handleAddTests } = await import("../../commands-add-tests.js");
    await handleAddTests(trimmed.replace(/^add-tests\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "eval-review" || trimmed.startsWith("eval-review ")) {
    const { handleEvalReview } = await import("../../commands-eval-review.js");
    await handleEvalReview(trimmed.replace(/^eval-review\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "extract-learnings" || trimmed.startsWith("extract-learnings ")) {
    const { handleExtractLearnings } = await import("../../commands-extract-learnings.js");
    await handleExtractLearnings(trimmed.replace(/^extract-learnings\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "memory" || trimmed.startsWith("memory ") || trimmed === "memory help") {
    const { handleMemory } = await import("../../commands-memory.js");
    await handleMemory(trimmed.replace(/^memory\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "scan" || trimmed.startsWith("scan ")) {
    const { handleScan } = await import("../../commands-scan.js");
    await handleScan(trimmed.replace(/^scan\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "worktree" || trimmed.startsWith("worktree ") || trimmed === "wt" || trimmed.startsWith("wt ")) {
    const { handleWorktree } = await import("../../commands-worktree.js");
    await handleWorktree(trimmed.replace(/^(worktree|wt)\s*/, "").trim(), ctx);
    return true;
  }
  return false;
}
export {
  handleOpsCommand
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9jb21tYW5kcy9oYW5kbGVycy9vcHMudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFByb2plY3QvQXBwOiBHU0QtMlxuLy8gRmlsZSBQdXJwb3NlOiBIYW5kbGVzIG9wZXJhdGlvbmFsIC9nc2Qgc3ViY29tbWFuZHMuXG5pbXBvcnQgdHlwZSB7IEV4dGVuc2lvbkFQSSwgRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcblxuaW1wb3J0IHsgZW5hYmxlRGVidWcgfSBmcm9tIFwiLi4vLi4vZGVidWctbG9nZ2VyLmpzXCI7XG5pbXBvcnQgeyBkaXNwYXRjaERpcmVjdFBoYXNlIH0gZnJvbSBcIi4uLy4uL2F1dG8tZGlyZWN0LWRpc3BhdGNoLmpzXCI7XG5pbXBvcnQgeyBoYW5kbGVDb25maWcgfSBmcm9tIFwiLi4vLi4vY29tbWFuZHMtY29uZmlnLmpzXCI7XG5pbXBvcnQgeyBoYW5kbGVEb2N0b3IsIGhhbmRsZUNhcHR1cmUsIGhhbmRsZUtub3dsZWRnZSwgaGFuZGxlUnVuSG9vaywgaGFuZGxlU2tpbGxIZWFsdGgsIGhhbmRsZVN0ZWVyLCBoYW5kbGVUcmlhZ2UsIGhhbmRsZVVwZGF0ZSB9IGZyb20gXCIuLi8uLi9jb21tYW5kcy1oYW5kbGVycy5qc1wiO1xuaW1wb3J0IHsgaGFuZGxlSW5zcGVjdCB9IGZyb20gXCIuLi8uLi9jb21tYW5kcy1pbnNwZWN0LmpzXCI7XG5pbXBvcnQgeyBoYW5kbGVMb2dzIH0gZnJvbSBcIi4uLy4uL2NvbW1hbmRzLWxvZ3MuanNcIjtcbmltcG9ydCB7IGhhbmRsZURlYnVnIH0gZnJvbSBcIi4uLy4uL2NvbW1hbmRzLWRlYnVnLmpzXCI7XG5pbXBvcnQgeyBoYW5kbGVDbGVhbnVwQnJhbmNoZXMsIGhhbmRsZUNsZWFudXBTbmFwc2hvdHMsIGhhbmRsZVNraXAsIGhhbmRsZUNsZWFudXBQcm9qZWN0cywgaGFuZGxlQ2xlYW51cFdvcmt0cmVlcywgaGFuZGxlUmVjb3ZlciB9IGZyb20gXCIuLi8uLi9jb21tYW5kcy1tYWludGVuYW5jZS5qc1wiO1xuaW1wb3J0IHsgaGFuZGxlRXhwb3J0IH0gZnJvbSBcIi4uLy4uL2V4cG9ydC5qc1wiO1xuaW1wb3J0IHsgaGFuZGxlSGlzdG9yeSB9IGZyb20gXCIuLi8uLi9oaXN0b3J5LmpzXCI7XG5pbXBvcnQgeyBoYW5kbGVVbmRvIH0gZnJvbSBcIi4uLy4uL3VuZG8uanNcIjtcbmltcG9ydCB7IGhhbmRsZVJlbW90ZSB9IGZyb20gXCIuLi8uLi8uLi9yZW1vdGUtcXVlc3Rpb25zL21vZC5qc1wiO1xuaW1wb3J0IHsgaGFuZGxlU2hpcCB9IGZyb20gXCIuLi8uLi9jb21tYW5kcy1zaGlwLmpzXCI7XG5pbXBvcnQgeyBoYW5kbGVTZXNzaW9uUmVwb3J0IH0gZnJvbSBcIi4uLy4uL2NvbW1hbmRzLXNlc3Npb24tcmVwb3J0LmpzXCI7XG5pbXBvcnQgeyBoYW5kbGVQckJyYW5jaCB9IGZyb20gXCIuLi8uLi9jb21tYW5kcy1wci1icmFuY2guanNcIjtcbmltcG9ydCB7IGN1cnJlbnREaXJlY3RvcnlSb290LCBwcm9qZWN0Um9vdCB9IGZyb20gXCIuLi9jb250ZXh0LmpzXCI7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBoYW5kbGVPcHNDb21tYW5kKHRyaW1tZWQ6IHN0cmluZywgY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCwgcGk6IEV4dGVuc2lvbkFQSSk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBpZiAodHJpbW1lZCA9PT0gXCJpbml0XCIpIHtcbiAgICBjb25zdCB7IGRldGVjdFByb2plY3RTdGF0ZSB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vLi4vZGV0ZWN0aW9uLmpzXCIpO1xuICAgIGNvbnN0IHsgaGFuZGxlUmVpbml0LCBzaG93UHJvamVjdEluaXQgfSA9IGF3YWl0IGltcG9ydChcIi4uLy4uL2luaXQtd2l6YXJkLmpzXCIpO1xuICAgIGNvbnN0IGJhc2VQYXRoID0gcHJvamVjdFJvb3QoKTtcbiAgICBjb25zdCBkZXRlY3Rpb24gPSBkZXRlY3RQcm9qZWN0U3RhdGUoYmFzZVBhdGgpO1xuICAgIGlmIChkZXRlY3Rpb24uc3RhdGUgPT09IFwidjItZ3NkXCIgfHwgZGV0ZWN0aW9uLnN0YXRlID09PSBcInYyLWdzZC1lbXB0eVwiKSB7XG4gICAgICBhd2FpdCBoYW5kbGVSZWluaXQoY3R4LCBkZXRlY3Rpb24pO1xuICAgIH0gZWxzZSB7XG4gICAgICBhd2FpdCBzaG93UHJvamVjdEluaXQoY3R4LCBwaSwgYmFzZVBhdGgsIGRldGVjdGlvbik7XG4gICAgfVxuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGlmICh0cmltbWVkID09PSBcImtleXNcIiB8fCB0cmltbWVkLnN0YXJ0c1dpdGgoXCJrZXlzIFwiKSkge1xuICAgIGNvbnN0IHsgaGFuZGxlS2V5cyB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vLi4va2V5LW1hbmFnZXIuanNcIik7XG4gICAgYXdhaXQgaGFuZGxlS2V5cyh0cmltbWVkLnJlcGxhY2UoL15rZXlzXFxzKi8sIFwiXCIpLnRyaW0oKSwgY3R4KTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICBpZiAodHJpbW1lZCA9PT0gXCJkb2N0b3JcIiB8fCB0cmltbWVkLnN0YXJ0c1dpdGgoXCJkb2N0b3IgXCIpKSB7XG4gICAgYXdhaXQgaGFuZGxlRG9jdG9yKHRyaW1tZWQucmVwbGFjZSgvXmRvY3RvclxccyovLCBcIlwiKS50cmltKCksIGN0eCwgcGkpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGlmICh0cmltbWVkID09PSBcImxvZ3NcIiB8fCB0cmltbWVkLnN0YXJ0c1dpdGgoXCJsb2dzIFwiKSkge1xuICAgIGF3YWl0IGhhbmRsZUxvZ3ModHJpbW1lZC5yZXBsYWNlKC9ebG9nc1xccyovLCBcIlwiKS50cmltKCksIGN0eCk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgaWYgKHRyaW1tZWQgPT09IFwiZGVidWdcIiB8fCB0cmltbWVkLnN0YXJ0c1dpdGgoXCJkZWJ1ZyBcIikpIHtcbiAgICBhd2FpdCBoYW5kbGVEZWJ1Zyh0cmltbWVkLnJlcGxhY2UoL15kZWJ1Z1xccyovLCBcIlwiKS50cmltKCksIGN0eCwgcGkpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGlmICh0cmltbWVkID09PSBcImZvcmVuc2ljc1wiIHx8IHRyaW1tZWQuc3RhcnRzV2l0aChcImZvcmVuc2ljcyBcIikpIHtcbiAgICBjb25zdCB7IGhhbmRsZUZvcmVuc2ljcyB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vLi4vZm9yZW5zaWNzLmpzXCIpO1xuICAgIGF3YWl0IGhhbmRsZUZvcmVuc2ljcyh0cmltbWVkLnJlcGxhY2UoL15mb3JlbnNpY3NcXHMqLywgXCJcIikudHJpbSgpLCBjdHgsIHBpKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICBpZiAodHJpbW1lZCA9PT0gXCJjaGFuZ2Vsb2dcIiB8fCB0cmltbWVkLnN0YXJ0c1dpdGgoXCJjaGFuZ2Vsb2cgXCIpKSB7XG4gICAgY29uc3QgeyBoYW5kbGVDaGFuZ2Vsb2cgfSA9IGF3YWl0IGltcG9ydChcIi4uLy4uL2NoYW5nZWxvZy5qc1wiKTtcbiAgICBhd2FpdCBoYW5kbGVDaGFuZ2Vsb2codHJpbW1lZC5yZXBsYWNlKC9eY2hhbmdlbG9nXFxzKi8sIFwiXCIpLnRyaW0oKSwgY3R4LCBwaSk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgaWYgKHRyaW1tZWQgPT09IFwiaGlzdG9yeVwiIHx8IHRyaW1tZWQuc3RhcnRzV2l0aChcImhpc3RvcnkgXCIpKSB7XG4gICAgYXdhaXQgaGFuZGxlSGlzdG9yeSh0cmltbWVkLnJlcGxhY2UoL15oaXN0b3J5XFxzKi8sIFwiXCIpLnRyaW0oKSwgY3R4LCBwcm9qZWN0Um9vdCgpKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICBpZiAodHJpbW1lZCA9PT0gXCJ1bmRvLXRhc2tcIiB8fCB0cmltbWVkLnN0YXJ0c1dpdGgoXCJ1bmRvLXRhc2sgXCIpKSB7XG4gICAgY29uc3QgeyBoYW5kbGVVbmRvVGFzayB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vLi4vdW5kby5qc1wiKTtcbiAgICBhd2FpdCBoYW5kbGVVbmRvVGFzayh0cmltbWVkLnJlcGxhY2UoL151bmRvLXRhc2tcXHMqLywgXCJcIikudHJpbSgpLCBjdHgsIHBpLCBwcm9qZWN0Um9vdCgpKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICBpZiAodHJpbW1lZCA9PT0gXCJyZXNldC1zbGljZVwiIHx8IHRyaW1tZWQuc3RhcnRzV2l0aChcInJlc2V0LXNsaWNlIFwiKSkge1xuICAgIGNvbnN0IHsgaGFuZGxlUmVzZXRTbGljZSB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vLi4vdW5kby5qc1wiKTtcbiAgICBhd2FpdCBoYW5kbGVSZXNldFNsaWNlKHRyaW1tZWQucmVwbGFjZSgvXnJlc2V0LXNsaWNlXFxzKi8sIFwiXCIpLnRyaW0oKSwgY3R4LCBwaSwgcHJvamVjdFJvb3QoKSk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgaWYgKHRyaW1tZWQgPT09IFwidW5kb1wiIHx8IHRyaW1tZWQuc3RhcnRzV2l0aChcInVuZG8gXCIpKSB7XG4gICAgYXdhaXQgaGFuZGxlVW5kbyh0cmltbWVkLnJlcGxhY2UoL151bmRvXFxzKi8sIFwiXCIpLnRyaW0oKSwgY3R4LCBwaSwgcHJvamVjdFJvb3QoKSk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgaWYgKHRyaW1tZWQgPT09IFwic2tpcFwiKSB7XG4gICAgY3R4LnVpLm5vdGlmeShcIlVzYWdlOiAvZ3NkIHNraXAgPHVuaXQtaWQ+ICBFeGFtcGxlOiAvZ3NkIHNraXAgTTAwMS9TMDEvVDAzXCIsIFwid2FybmluZ1wiKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICBpZiAodHJpbW1lZC5zdGFydHNXaXRoKFwic2tpcCBcIikpIHtcbiAgICBhd2FpdCBoYW5kbGVTa2lwKHRyaW1tZWQucmVwbGFjZSgvXnNraXBcXHMqLywgXCJcIikudHJpbSgpLCBjdHgsIHByb2plY3RSb290KCkpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGlmICh0cmltbWVkID09PSBcInJlY292ZXJcIikge1xuICAgIGF3YWl0IGhhbmRsZVJlY292ZXIoY3R4LCBwcm9qZWN0Um9vdCgpKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICBpZiAodHJpbW1lZCA9PT0gXCJleHBvcnRcIiB8fCB0cmltbWVkLnN0YXJ0c1dpdGgoXCJleHBvcnQgXCIpKSB7XG4gICAgYXdhaXQgaGFuZGxlRXhwb3J0KHRyaW1tZWQucmVwbGFjZSgvXmV4cG9ydFxccyovLCBcIlwiKS50cmltKCksIGN0eCwgcHJvamVjdFJvb3QoKSk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgaWYgKHRyaW1tZWQgPT09IFwiY2xlYW51cCBwcm9qZWN0c1wiIHx8IHRyaW1tZWQuc3RhcnRzV2l0aChcImNsZWFudXAgcHJvamVjdHMgXCIpKSB7XG4gICAgYXdhaXQgaGFuZGxlQ2xlYW51cFByb2plY3RzKHRyaW1tZWQucmVwbGFjZSgvXmNsZWFudXAgcHJvamVjdHNcXHMqLywgXCJcIikudHJpbSgpLCBjdHgpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGlmICh0cmltbWVkID09PSBcImNsZWFudXAgd29ya3RyZWVzXCIpIHtcbiAgICBhd2FpdCBoYW5kbGVDbGVhbnVwV29ya3RyZWVzKGN0eCwgcHJvamVjdFJvb3QoKSk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgaWYgKHRyaW1tZWQgPT09IFwiY2xlYW51cFwiKSB7XG4gICAgYXdhaXQgaGFuZGxlQ2xlYW51cEJyYW5jaGVzKGN0eCwgcHJvamVjdFJvb3QoKSk7XG4gICAgYXdhaXQgaGFuZGxlQ2xlYW51cFNuYXBzaG90cyhjdHgsIHByb2plY3RSb290KCkpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGlmICh0cmltbWVkID09PSBcImNsZWFudXAgYnJhbmNoZXNcIikge1xuICAgIGF3YWl0IGhhbmRsZUNsZWFudXBCcmFuY2hlcyhjdHgsIHByb2plY3RSb290KCkpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGlmICh0cmltbWVkID09PSBcImNsZWFudXAgc25hcHNob3RzXCIpIHtcbiAgICBhd2FpdCBoYW5kbGVDbGVhbnVwU25hcHNob3RzKGN0eCwgcHJvamVjdFJvb3QoKSk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgaWYgKHRyaW1tZWQuc3RhcnRzV2l0aChcImNhcHR1cmUgXCIpIHx8IHRyaW1tZWQgPT09IFwiY2FwdHVyZVwiKSB7XG4gICAgYXdhaXQgaGFuZGxlQ2FwdHVyZSh0cmltbWVkLnJlcGxhY2UoL15jYXB0dXJlXFxzKi8sIFwiXCIpLnRyaW0oKSwgY3R4KTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICBpZiAodHJpbW1lZCA9PT0gXCJ0cmlhZ2VcIikge1xuICAgIGF3YWl0IGhhbmRsZVRyaWFnZShjdHgsIHBpLCBjdXJyZW50RGlyZWN0b3J5Um9vdCgpKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICBpZiAodHJpbW1lZCA9PT0gXCJjb25maWdcIikge1xuICAgIGF3YWl0IGhhbmRsZUNvbmZpZyhjdHgpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGlmICh0cmltbWVkID09PSBcImhvb2tzXCIpIHtcbiAgICBjb25zdCB7IGZvcm1hdEhvb2tTdGF0dXMgfSA9IGF3YWl0IGltcG9ydChcIi4uLy4uL3Bvc3QtdW5pdC1ob29rcy5qc1wiKTtcbiAgICBjdHgudWkubm90aWZ5KGZvcm1hdEhvb2tTdGF0dXMoKSwgXCJpbmZvXCIpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGlmICh0cmltbWVkID09PSBcInNraWxsLWhlYWx0aFwiIHx8IHRyaW1tZWQuc3RhcnRzV2l0aChcInNraWxsLWhlYWx0aCBcIikpIHtcbiAgICBhd2FpdCBoYW5kbGVTa2lsbEhlYWx0aCh0cmltbWVkLnJlcGxhY2UoL15za2lsbC1oZWFsdGhcXHMqLywgXCJcIikudHJpbSgpLCBjdHgpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGlmICh0cmltbWVkLnN0YXJ0c1dpdGgoXCJydW4taG9vayBcIikpIHtcbiAgICBhd2FpdCBoYW5kbGVSdW5Ib29rKHRyaW1tZWQucmVwbGFjZSgvXnJ1bi1ob29rXFxzKi8sIFwiXCIpLnRyaW0oKSwgY3R4LCBwaSk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgaWYgKHRyaW1tZWQgPT09IFwicnVuLWhvb2tcIikge1xuICAgIGN0eC51aS5ub3RpZnkoYFVzYWdlOiAvZ3NkIHJ1bi1ob29rIDxob29rLW5hbWU+IDx1bml0LXR5cGU+IDx1bml0LWlkPlxuXG5Vbml0IHR5cGVzOlxuICBleGVjdXRlLXRhc2sgICAtIFRhc2sgZXhlY3V0aW9uICh1bml0LWlkOiBNMDAxL1MwMS9UMDEpXG4gIHBsYW4tc2xpY2UgICAgIC0gU2xpY2UgcGxhbm5pbmcgKHVuaXQtaWQ6IE0wMDEvUzAxKVxuICByZXNlYXJjaC1taWxlc3RvbmUgLSBNaWxlc3RvbmUgcmVzZWFyY2ggKHVuaXQtaWQ6IE0wMDEpXG4gIGNvbXBsZXRlLXNsaWNlIC0gU2xpY2UgY29tcGxldGlvbiAodW5pdC1pZDogTTAwMS9TMDEpXG4gIGNvbXBsZXRlLW1pbGVzdG9uZSAtIE1pbGVzdG9uZSBjb21wbGV0aW9uICh1bml0LWlkOiBNMDAxKVxuXG5FeGFtcGxlczpcbiAgL2dzZCBydW4taG9vayBjb2RlLXJldmlldyBleGVjdXRlLXRhc2sgTTAwMS9TMDEvVDAxXG4gIC9nc2QgcnVuLWhvb2sgbGludC1jaGVjayBwbGFuLXNsaWNlIE0wMDEvUzAxYCwgXCJ3YXJuaW5nXCIpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGlmICh0cmltbWVkLnN0YXJ0c1dpdGgoXCJzdGVlciBcIikpIHtcbiAgICBhd2FpdCBoYW5kbGVTdGVlcih0cmltbWVkLnJlcGxhY2UoL15zdGVlclxccysvLCBcIlwiKS50cmltKCksIGN0eCwgcGkpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGlmICh0cmltbWVkID09PSBcInN0ZWVyXCIpIHtcbiAgICBjdHgudWkubm90aWZ5KFwiVXNhZ2U6IC9nc2Qgc3RlZXIgPGRlc2NyaXB0aW9uIG9mIGNoYW5nZT4uIEV4YW1wbGU6IC9nc2Qgc3RlZXIgVXNlIFBvc3RncmVzIGluc3RlYWQgb2YgU1FMaXRlXCIsIFwid2FybmluZ1wiKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICBpZiAodHJpbW1lZC5zdGFydHNXaXRoKFwia25vd2xlZGdlIFwiKSkge1xuICAgIGF3YWl0IGhhbmRsZUtub3dsZWRnZSh0cmltbWVkLnJlcGxhY2UoL15rbm93bGVkZ2VcXHMrLywgXCJcIikudHJpbSgpLCBjdHgpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGlmICh0cmltbWVkID09PSBcImtub3dsZWRnZVwiKSB7XG4gICAgY3R4LnVpLm5vdGlmeShcIlVzYWdlOiAvZ3NkIGtub3dsZWRnZSA8cnVsZXxwYXR0ZXJufGxlc3Nvbj4gPGRlc2NyaXB0aW9uPi4gRXhhbXBsZTogL2dzZCBrbm93bGVkZ2UgcnVsZSBVc2UgcmVhbCBEQiBmb3IgaW50ZWdyYXRpb24gdGVzdHNcIiwgXCJ3YXJuaW5nXCIpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGlmICh0cmltbWVkID09PSBcIm1pZ3JhdGVcIiB8fCB0cmltbWVkLnN0YXJ0c1dpdGgoXCJtaWdyYXRlIFwiKSkge1xuICAgIGNvbnN0IHsgaGFuZGxlTWlncmF0ZSB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vLi4vbWlncmF0ZS9jb21tYW5kLmpzXCIpO1xuICAgIGF3YWl0IGhhbmRsZU1pZ3JhdGUodHJpbW1lZC5yZXBsYWNlKC9ebWlncmF0ZVxccyovLCBcIlwiKS50cmltKCksIGN0eCwgcGkpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGlmICh0cmltbWVkID09PSBcInJlbW90ZVwiIHx8IHRyaW1tZWQuc3RhcnRzV2l0aChcInJlbW90ZSBcIikpIHtcbiAgICBhd2FpdCBoYW5kbGVSZW1vdGUodHJpbW1lZC5yZXBsYWNlKC9ecmVtb3RlXFxzKi8sIFwiXCIpLnRyaW0oKSwgY3R4LCBwaSk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgaWYgKHRyaW1tZWQgPT09IFwiZGlzcGF0Y2hcIiB8fCB0cmltbWVkLnN0YXJ0c1dpdGgoXCJkaXNwYXRjaCBcIikpIHtcbiAgICBjb25zdCBwaGFzZSA9IHRyaW1tZWQucmVwbGFjZSgvXmRpc3BhdGNoXFxzKi8sIFwiXCIpLnRyaW0oKTtcbiAgICBpZiAoIXBoYXNlKSB7XG4gICAgICBjdHgudWkubm90aWZ5KFwiVXNhZ2U6IC9nc2QgZGlzcGF0Y2ggPHBoYXNlPiAgKHJlc2VhcmNofHBsYW58ZXhlY3V0ZXxjb21wbGV0ZXxyZWFzc2Vzc3x1YXR8cmVwbGFuKVwiLCBcIndhcm5pbmdcIik7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgYXdhaXQgZGlzcGF0Y2hEaXJlY3RQaGFzZShjdHgsIHBpLCBwaGFzZSwgcHJvamVjdFJvb3QoKSk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgaWYgKHRyaW1tZWQgPT09IFwibm90aWZpY2F0aW9uc1wiIHx8IHRyaW1tZWQuc3RhcnRzV2l0aChcIm5vdGlmaWNhdGlvbnMgXCIpKSB7XG4gICAgY29uc3QgeyBoYW5kbGVOb3RpZmljYXRpb25zQ29tbWFuZCB9ID0gYXdhaXQgaW1wb3J0KFwiLi9ub3RpZmljYXRpb25zLWhhbmRsZXIuanNcIik7XG4gICAgYXdhaXQgaGFuZGxlTm90aWZpY2F0aW9uc0NvbW1hbmQodHJpbW1lZC5yZXBsYWNlKC9ebm90aWZpY2F0aW9uc1xccyovLCBcIlwiKS50cmltKCksIGN0eCwgcGkpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGlmICh0cmltbWVkID09PSBcImVzY2FsYXRlXCIgfHwgdHJpbW1lZC5zdGFydHNXaXRoKFwiZXNjYWxhdGUgXCIpKSB7XG4gICAgY29uc3QgeyBoYW5kbGVFc2NhbGF0ZUNvbW1hbmQgfSA9IGF3YWl0IGltcG9ydChcIi4vZXNjYWxhdGUuanNcIik7XG4gICAgYXdhaXQgaGFuZGxlRXNjYWxhdGVDb21tYW5kKHRyaW1tZWQucmVwbGFjZSgvXmVzY2FsYXRlXFxzKi8sIFwiXCIpLnRyaW0oKSwgY3R4LCBwaSk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgaWYgKHRyaW1tZWQgPT09IFwiaW5zcGVjdFwiKSB7XG4gICAgYXdhaXQgaGFuZGxlSW5zcGVjdChjdHgpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGlmICh0cmltbWVkID09PSBcInVwZGF0ZVwiKSB7XG4gICAgYXdhaXQgaGFuZGxlVXBkYXRlKGN0eCk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgaWYgKHRyaW1tZWQgPT09IFwiZmFzdFwiIHx8IHRyaW1tZWQuc3RhcnRzV2l0aChcImZhc3QgXCIpKSB7XG4gICAgY29uc3QgeyBoYW5kbGVGYXN0IH0gPSBhd2FpdCBpbXBvcnQoXCIuLi8uLi9zZXJ2aWNlLXRpZXIuanNcIik7XG4gICAgYXdhaXQgaGFuZGxlRmFzdCh0cmltbWVkLnJlcGxhY2UoL15mYXN0XFxzKi8sIFwiXCIpLnRyaW0oKSwgY3R4KTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICBpZiAodHJpbW1lZCA9PT0gXCJtY3BcIiB8fCB0cmltbWVkLnN0YXJ0c1dpdGgoXCJtY3AgXCIpKSB7XG4gICAgY29uc3QgeyBoYW5kbGVNY3BTdGF0dXMgfSA9IGF3YWl0IGltcG9ydChcIi4uLy4uL2NvbW1hbmRzLW1jcC1zdGF0dXMuanNcIik7XG4gICAgYXdhaXQgaGFuZGxlTWNwU3RhdHVzKHRyaW1tZWQucmVwbGFjZSgvXm1jcFxccyovLCBcIlwiKS50cmltKCksIGN0eCk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgaWYgKHRyaW1tZWQgPT09IFwiZXh0ZW5zaW9uc1wiIHx8IHRyaW1tZWQuc3RhcnRzV2l0aChcImV4dGVuc2lvbnMgXCIpKSB7XG4gICAgY29uc3QgeyBoYW5kbGVFeHRlbnNpb25zIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi8uLi9jb21tYW5kcy1leHRlbnNpb25zLmpzXCIpO1xuICAgIGF3YWl0IGhhbmRsZUV4dGVuc2lvbnModHJpbW1lZC5yZXBsYWNlKC9eZXh0ZW5zaW9uc1xccyovLCBcIlwiKS50cmltKCksIGN0eCk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgaWYgKHRyaW1tZWQgPT09IFwicmV0aGlua1wiKSB7XG4gICAgY29uc3QgeyBoYW5kbGVSZXRoaW5rIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi8uLi9yZXRoaW5rLmpzXCIpO1xuICAgIGF3YWl0IGhhbmRsZVJldGhpbmsodHJpbW1lZCwgY3R4LCBwaSk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgaWYgKHRyaW1tZWQgPT09IFwiY29kZWJhc2VcIiB8fCB0cmltbWVkLnN0YXJ0c1dpdGgoXCJjb2RlYmFzZSBcIikpIHtcbiAgICBjb25zdCB7IGhhbmRsZUNvZGViYXNlIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi8uLi9jb21tYW5kcy1jb2RlYmFzZS5qc1wiKTtcbiAgICBhd2FpdCBoYW5kbGVDb2RlYmFzZSh0cmltbWVkLnJlcGxhY2UoL15jb2RlYmFzZVxccyovLCBcIlwiKS50cmltKCksIGN0eCwgcGkpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGlmICh0cmltbWVkID09PSBcInNoaXBcIiB8fCB0cmltbWVkLnN0YXJ0c1dpdGgoXCJzaGlwIFwiKSkge1xuICAgIGF3YWl0IGhhbmRsZVNoaXAodHJpbW1lZC5yZXBsYWNlKC9ec2hpcFxccyovLCBcIlwiKS50cmltKCksIGN0eCwgcGkpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGlmICh0cmltbWVkID09PSBcInNlc3Npb24tcmVwb3J0XCIgfHwgdHJpbW1lZC5zdGFydHNXaXRoKFwic2Vzc2lvbi1yZXBvcnQgXCIpKSB7XG4gICAgYXdhaXQgaGFuZGxlU2Vzc2lvblJlcG9ydCh0cmltbWVkLnJlcGxhY2UoL15zZXNzaW9uLXJlcG9ydFxccyovLCBcIlwiKS50cmltKCksIGN0eCk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgaWYgKHRyaW1tZWQgPT09IFwicHItYnJhbmNoXCIgfHwgdHJpbW1lZC5zdGFydHNXaXRoKFwicHItYnJhbmNoIFwiKSkge1xuICAgIGF3YWl0IGhhbmRsZVByQnJhbmNoKHRyaW1tZWQucmVwbGFjZSgvXnByLWJyYW5jaFxccyovLCBcIlwiKS50cmltKCksIGN0eCk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgaWYgKHRyaW1tZWQgPT09IFwiYWRkLXRlc3RzXCIgfHwgdHJpbW1lZC5zdGFydHNXaXRoKFwiYWRkLXRlc3RzIFwiKSkge1xuICAgIGNvbnN0IHsgaGFuZGxlQWRkVGVzdHMgfSA9IGF3YWl0IGltcG9ydChcIi4uLy4uL2NvbW1hbmRzLWFkZC10ZXN0cy5qc1wiKTtcbiAgICBhd2FpdCBoYW5kbGVBZGRUZXN0cyh0cmltbWVkLnJlcGxhY2UoL15hZGQtdGVzdHNcXHMqLywgXCJcIikudHJpbSgpLCBjdHgsIHBpKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICBpZiAodHJpbW1lZCA9PT0gXCJldmFsLXJldmlld1wiIHx8IHRyaW1tZWQuc3RhcnRzV2l0aChcImV2YWwtcmV2aWV3IFwiKSkge1xuICAgIGNvbnN0IHsgaGFuZGxlRXZhbFJldmlldyB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vLi4vY29tbWFuZHMtZXZhbC1yZXZpZXcuanNcIik7XG4gICAgYXdhaXQgaGFuZGxlRXZhbFJldmlldyh0cmltbWVkLnJlcGxhY2UoL15ldmFsLXJldmlld1xccyovLCBcIlwiKS50cmltKCksIGN0eCwgcGkpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGlmICh0cmltbWVkID09PSBcImV4dHJhY3QtbGVhcm5pbmdzXCIgfHwgdHJpbW1lZC5zdGFydHNXaXRoKFwiZXh0cmFjdC1sZWFybmluZ3MgXCIpKSB7XG4gICAgY29uc3QgeyBoYW5kbGVFeHRyYWN0TGVhcm5pbmdzIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi8uLi9jb21tYW5kcy1leHRyYWN0LWxlYXJuaW5ncy5qc1wiKTtcbiAgICBhd2FpdCBoYW5kbGVFeHRyYWN0TGVhcm5pbmdzKHRyaW1tZWQucmVwbGFjZSgvXmV4dHJhY3QtbGVhcm5pbmdzXFxzKi8sIFwiXCIpLnRyaW0oKSwgY3R4LCBwaSk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgaWYgKHRyaW1tZWQgPT09IFwibWVtb3J5XCIgfHwgdHJpbW1lZC5zdGFydHNXaXRoKFwibWVtb3J5IFwiKSB8fCB0cmltbWVkID09PSBcIm1lbW9yeSBoZWxwXCIpIHtcbiAgICBjb25zdCB7IGhhbmRsZU1lbW9yeSB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vLi4vY29tbWFuZHMtbWVtb3J5LmpzXCIpO1xuICAgIGF3YWl0IGhhbmRsZU1lbW9yeSh0cmltbWVkLnJlcGxhY2UoL15tZW1vcnlcXHMqLywgXCJcIikudHJpbSgpLCBjdHgsIHBpKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICBpZiAodHJpbW1lZCA9PT0gXCJzY2FuXCIgfHwgdHJpbW1lZC5zdGFydHNXaXRoKFwic2NhbiBcIikpIHtcbiAgICBjb25zdCB7IGhhbmRsZVNjYW4gfSA9IGF3YWl0IGltcG9ydChcIi4uLy4uL2NvbW1hbmRzLXNjYW4uanNcIik7XG4gICAgLy8gXFxzKiAobm90IFxccyspIGlzIGludGVudGlvbmFsOiBoYW5kbGVzIGJvdGggL2dzZCBzY2FuIChubyBhcmdzKSBhbmQgL2dzZCBzY2FuIC0tZm9jdXMgWFxuICAgIGF3YWl0IGhhbmRsZVNjYW4odHJpbW1lZC5yZXBsYWNlKC9ec2NhblxccyovLCBcIlwiKS50cmltKCksIGN0eCwgcGkpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGlmIChcbiAgICB0cmltbWVkID09PSBcIndvcmt0cmVlXCIgfHxcbiAgICB0cmltbWVkLnN0YXJ0c1dpdGgoXCJ3b3JrdHJlZSBcIikgfHxcbiAgICB0cmltbWVkID09PSBcInd0XCIgfHxcbiAgICB0cmltbWVkLnN0YXJ0c1dpdGgoXCJ3dCBcIilcbiAgKSB7XG4gICAgY29uc3QgeyBoYW5kbGVXb3JrdHJlZSB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vLi4vY29tbWFuZHMtd29ya3RyZWUuanNcIik7XG4gICAgYXdhaXQgaGFuZGxlV29ya3RyZWUodHJpbW1lZC5yZXBsYWNlKC9eKHdvcmt0cmVlfHd0KVxccyovLCBcIlwiKS50cmltKCksIGN0eCk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgcmV0dXJuIGZhbHNlO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBS0EsU0FBUywyQkFBMkI7QUFDcEMsU0FBUyxvQkFBb0I7QUFDN0IsU0FBUyxjQUFjLGVBQWUsaUJBQWlCLGVBQWUsbUJBQW1CLGFBQWEsY0FBYyxvQkFBb0I7QUFDeEksU0FBUyxxQkFBcUI7QUFDOUIsU0FBUyxrQkFBa0I7QUFDM0IsU0FBUyxtQkFBbUI7QUFDNUIsU0FBUyx1QkFBdUIsd0JBQXdCLFlBQVksdUJBQXVCLHdCQUF3QixxQkFBcUI7QUFDeEksU0FBUyxvQkFBb0I7QUFDN0IsU0FBUyxxQkFBcUI7QUFDOUIsU0FBUyxrQkFBa0I7QUFDM0IsU0FBUyxvQkFBb0I7QUFDN0IsU0FBUyxrQkFBa0I7QUFDM0IsU0FBUywyQkFBMkI7QUFDcEMsU0FBUyxzQkFBc0I7QUFDL0IsU0FBUyxzQkFBc0IsbUJBQW1CO0FBRWxELGVBQXNCLGlCQUFpQixTQUFpQixLQUE4QixJQUFvQztBQUN4SCxNQUFJLFlBQVksUUFBUTtBQUN0QixVQUFNLEVBQUUsbUJBQW1CLElBQUksTUFBTSxPQUFPLG9CQUFvQjtBQUNoRSxVQUFNLEVBQUUsY0FBYyxnQkFBZ0IsSUFBSSxNQUFNLE9BQU8sc0JBQXNCO0FBQzdFLFVBQU0sV0FBVyxZQUFZO0FBQzdCLFVBQU0sWUFBWSxtQkFBbUIsUUFBUTtBQUM3QyxRQUFJLFVBQVUsVUFBVSxZQUFZLFVBQVUsVUFBVSxnQkFBZ0I7QUFDdEUsWUFBTSxhQUFhLEtBQUssU0FBUztBQUFBLElBQ25DLE9BQU87QUFDTCxZQUFNLGdCQUFnQixLQUFLLElBQUksVUFBVSxTQUFTO0FBQUEsSUFDcEQ7QUFDQSxXQUFPO0FBQUEsRUFDVDtBQUNBLE1BQUksWUFBWSxVQUFVLFFB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
