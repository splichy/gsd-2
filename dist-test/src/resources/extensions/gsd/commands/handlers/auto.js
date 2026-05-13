import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { enableDebug } from "../../debug-logger.js";
import { isAutoActive, isAutoPaused, pauseAuto, startAutoDetached, stopAuto, stopAutoRemote } from "../../auto.js";
import { handleRate } from "../../commands-rate.js";
import { guardRemoteSession, projectRoot } from "../context.js";
import { findMilestoneIds } from "../../milestone-id-utils.js";
function parseYoloFlag(trimmed) {
  const yoloRe = /(?:--yolo|-y)\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/;
  const match = trimmed.match(yoloRe);
  if (!match) return { yoloSeedFile: null, rest: trimmed };
  let filePath = match[1];
  if (filePath.startsWith('"') && filePath.endsWith('"') || filePath.startsWith("'") && filePath.endsWith("'")) {
    filePath = filePath.slice(1, -1);
  }
  const rest = trimmed.replace(match[0], "").replace(/\s+/g, " ").trim();
  return { yoloSeedFile: filePath, rest };
}
function parseMilestoneTarget(input) {
  const match = input.match(/\b(M\d+(?:-[a-z0-9]{6})?)\b/);
  if (!match) return { milestoneId: null, rest: input };
  const rest = input.replace(match[0], "").replace(/\s+/g, " ").trim();
  return { milestoneId: match[1], rest };
}
async function handleAutoCommand(trimmed, ctx, pi) {
  if (trimmed === "next" || trimmed.startsWith("next ")) {
    if (trimmed.includes("--dry-run")) {
      const { handleDryRun } = await import("../../commands-maintenance.js");
      await handleDryRun(ctx, projectRoot());
      return true;
    }
    const { milestoneId, rest: afterMilestone } = parseMilestoneTarget(trimmed);
    const verboseMode = afterMilestone.includes("--verbose");
    const debugMode = afterMilestone.includes("--debug");
    if (debugMode) enableDebug(projectRoot());
    if (!await guardRemoteSession(ctx, pi)) return true;
    if (milestoneId) {
      const allIds = findMilestoneIds(projectRoot());
      if (!allIds.includes(milestoneId)) {
        ctx.ui.notify(`Milestone ${milestoneId} does not exist. Available: ${allIds.join(", ") || "(none)"}`, "error");
        return true;
      }
    }
    startAutoDetached(ctx, pi, projectRoot(), verboseMode, {
      step: true,
      milestoneLock: milestoneId
    });
    return true;
  }
  if (trimmed === "auto" || trimmed.startsWith("auto ")) {
    const { yoloSeedFile, rest: afterYolo } = parseYoloFlag(trimmed);
    const { milestoneId, rest: afterMilestone } = parseMilestoneTarget(afterYolo);
    const verboseMode = afterMilestone.includes("--verbose");
    const debugMode = afterMilestone.includes("--debug");
    if (debugMode) enableDebug(projectRoot());
    if (!await guardRemoteSession(ctx, pi)) return true;
    if (milestoneId) {
      const allIds = findMilestoneIds(projectRoot());
      if (!allIds.includes(milestoneId)) {
        ctx.ui.notify(`Milestone ${milestoneId} does not exist. Available: ${allIds.join(", ") || "(none)"}`, "error");
        return true;
      }
    }
    if (yoloSeedFile) {
      const resolved = resolve(projectRoot(), yoloSeedFile);
      if (!existsSync(resolved)) {
        ctx.ui.notify(`Yolo seed file not found: ${resolved}`, "error");
        return true;
      }
      const seedContent = readFileSync(resolved, "utf-8").trim();
      if (!seedContent) {
        ctx.ui.notify(`Yolo seed file is empty: ${resolved}`, "error");
        return true;
      }
      const { showHeadlessMilestoneCreation } = await import("../../guided-flow.js");
      await showHeadlessMilestoneCreation(ctx, pi, projectRoot(), seedContent);
    } else if (milestoneId) {
      startAutoDetached(ctx, pi, projectRoot(), verboseMode, {
        milestoneLock: milestoneId
      });
    } else {
      startAutoDetached(ctx, pi, projectRoot(), verboseMode);
    }
    return true;
  }
  if (trimmed === "stop") {
    if (!isAutoActive() && !isAutoPaused()) {
      const result = stopAutoRemote(projectRoot());
      if (result.found) {
        ctx.ui.notify(`Sent stop signal to auto-mode session (PID ${result.pid}). It will shut down gracefully.`, "info");
      } else if (result.error) {
        ctx.ui.notify(`Failed to stop remote auto-mode: ${result.error}`, "error");
      } else {
        ctx.ui.notify("Auto-mode is not running.", "info");
      }
      return true;
    }
    await stopAuto(ctx, pi, "User requested stop");
    return true;
  }
  if (trimmed === "pause") {
    if (!isAutoActive()) {
      if (isAutoPaused()) {
        ctx.ui.notify("Auto-mode is already paused. /gsd auto to resume.", "info");
      } else {
        ctx.ui.notify("Auto-mode is not running.", "info");
      }
      return true;
    }
    await pauseAuto(ctx, pi);
    return true;
  }
  if (trimmed === "rate" || trimmed.startsWith("rate ")) {
    await handleRate(trimmed.replace(/^rate\s*/, "").trim(), ctx, projectRoot());
    return true;
  }
  if (trimmed === "") {
    if (!await guardRemoteSession(ctx, pi)) return true;
    const { showSmartEntry } = await import("../../guided-flow.js");
    await showSmartEntry(ctx, pi, projectRoot(), { step: true });
    return true;
  }
  return false;
}
export {
  handleAutoCommand,
  parseMilestoneTarget
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9jb21tYW5kcy9oYW5kbGVycy9hdXRvLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdHlwZSB7IEV4dGVuc2lvbkFQSSwgRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcblxuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IHJlc29sdmUgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbmltcG9ydCB7IGVuYWJsZURlYnVnIH0gZnJvbSBcIi4uLy4uL2RlYnVnLWxvZ2dlci5qc1wiO1xuaW1wb3J0IHsgZ2V0QXV0b0Rhc2hib2FyZERhdGEsIGlzQXV0b0FjdGl2ZSwgaXNBdXRvUGF1c2VkLCBwYXVzZUF1dG8sIHN0YXJ0QXV0b0RldGFjaGVkLCBzdG9wQXV0bywgc3RvcEF1dG9SZW1vdGUgfSBmcm9tIFwiLi4vLi4vYXV0by5qc1wiO1xuaW1wb3J0IHsgaGFuZGxlUmF0ZSB9IGZyb20gXCIuLi8uLi9jb21tYW5kcy1yYXRlLmpzXCI7XG5pbXBvcnQgeyBndWFyZFJlbW90ZVNlc3Npb24sIHByb2plY3RSb290IH0gZnJvbSBcIi4uL2NvbnRleHQuanNcIjtcbmltcG9ydCB7IGZpbmRNaWxlc3RvbmVJZHMgfSBmcm9tIFwiLi4vLi4vbWlsZXN0b25lLWlkLXV0aWxzLmpzXCI7XG5cbi8qKlxuICogUGFyc2UgLS15b2xvIGZsYWcgYW5kIG9wdGlvbmFsIGZpbGUgcGF0aCBmcm9tIHRoZSBhdXRvIGNvbW1hbmQgc3RyaW5nLlxuICogU3VwcG9ydHM6IGAvZ3NkIGF1dG8gLS15b2xvIHBhdGgvdG8vZmlsZS5tZGAgb3IgYC9nc2QgYXV0byAteSBwYXRoL3RvL2ZpbGUubWRgXG4gKi9cbmZ1bmN0aW9uIHBhcnNlWW9sb0ZsYWcodHJpbW1lZDogc3RyaW5nKTogeyB5b2xvU2VlZEZpbGU6IHN0cmluZyB8IG51bGw7IHJlc3Q6IHN0cmluZyB9IHtcbiAgY29uc3QgeW9sb1JlID0gLyg/Oi0teW9sb3wteSlcXHMrKFwiKD86W15cIlxcXFxdfFxcXFwuKSpcInwnKD86W14nXFxcXF18XFxcXC4pKid8XFxTKykvO1xuICBjb25zdCBtYXRjaCA9IHRyaW1tZWQubWF0Y2goeW9sb1JlKTtcbiAgaWYgKCFtYXRjaCkgcmV0dXJuIHsgeW9sb1NlZWRGaWxlOiBudWxsLCByZXN0OiB0cmltbWVkIH07XG5cbiAgLy8gU3RyaXAgcXVvdGVzIGlmIHByZXNlbnRcbiAgbGV0IGZpbGVQYXRoID0gbWF0Y2hbMV07XG4gIGlmICgoZmlsZVBhdGguc3RhcnRzV2l0aCgnXCInKSAmJiBmaWxlUGF0aC5lbmRzV2l0aCgnXCInKSkgfHxcbiAgICAgIChmaWxlUGF0aC5zdGFydHNXaXRoKFwiJ1wiKSAmJiBmaWxlUGF0aC5lbmRzV2l0aChcIidcIikpKSB7XG4gICAgZmlsZVBhdGggPSBmaWxlUGF0aC5zbGljZSgxLCAtMSk7XG4gIH1cblxuICBjb25zdCByZXN0ID0gdHJpbW1lZC5yZXBsYWNlKG1hdGNoWzBdLCBcIlwiKS5yZXBsYWNlKC9cXHMrL2csIFwiIFwiKS50cmltKCk7XG4gIHJldHVybiB7IHlvbG9TZWVkRmlsZTogZmlsZVBhdGgsIHJlc3QgfTtcbn1cblxuLyoqXG4gKiBFeHRyYWN0IGEgbWlsZXN0b25lIElEIChlLmcuIE0wMTYgb3IgTTAwMS1hM2I0YzUpIGZyb20gdGhlIGNvbW1hbmQgc3RyaW5nLlxuICogUmV0dXJucyB0aGUgbWF0Y2hlZCBJRCBhbmQgdGhlIHJlbWFpbmluZyBzdHJpbmcgd2l0aCB0aGUgSUQgcmVtb3ZlZC5cbiAqIFRoZSBtaWxlc3RvbmUgSUQgcGF0dGVybiBtYXRjaGVzIHRoZSBmb3JtYXQgdXNlZCBieSBmaW5kTWlsZXN0b25lSWRzOiBNXFxkKyB3aXRoXG4gKiBhbiBvcHRpb25hbCAtW2EtejAtOV17Nn0gc3VmZml4IGZvciB1bmlxdWUgbWlsZXN0b25lIElEcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlTWlsZXN0b25lVGFyZ2V0KGlucHV0OiBzdHJpbmcpOiB7IG1pbGVzdG9uZUlkOiBzdHJpbmcgfCBudWxsOyByZXN0OiBzdHJpbmcgfSB7XG4gIGNvbnN0IG1hdGNoID0gaW5wdXQubWF0Y2goL1xcYihNXFxkKyg/Oi1bYS16MC05XXs2fSk/KVxcYi8pO1xuICBpZiAoIW1hdGNoKSByZXR1cm4geyBtaWxlc3RvbmVJZDogbnVsbCwgcmVzdDogaW5wdXQgfTtcbiAgY29uc3QgcmVzdCA9IGlucHV0LnJlcGxhY2UobWF0Y2hbMF0sIFwiXCIpLnJlcGxhY2UoL1xccysvZywgXCIgXCIpLnRyaW0oKTtcbiAgcmV0dXJuIHsgbWlsZXN0b25lSWQ6IG1hdGNoWzFdLCByZXN0IH07XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBoYW5kbGVBdXRvQ29tbWFuZCh0cmltbWVkOiBzdHJpbmcsIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsIHBpOiBFeHRlbnNpb25BUEkpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgaWYgKHRyaW1tZWQgPT09IFwibmV4dFwiIHx8IHRyaW1tZWQuc3RhcnRzV2l0aChcIm5leHQgXCIpKSB7XG4gICAgaWYgKHRyaW1tZWQuaW5jbHVkZXMoXCItLWRyeS1ydW5cIikpIHtcbiAgICAgIGNvbnN0IHsgaGFuZGxlRHJ5UnVuIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi8uLi9jb21tYW5kcy1tYWludGVuYW5jZS5qc1wiKTtcbiAgICAgIGF3YWl0IGhhbmRsZURyeVJ1bihjdHgsIHByb2plY3RSb290KCkpO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGNvbnN0IHsgbWlsZXN0b25lSWQsIHJlc3Q6IGFmdGVyTWlsZXN0b25lIH0gPSBwYXJzZU1pbGVzdG9uZVRhcmdldCh0cmltbWVkKTtcbiAgICBjb25zdCB2ZXJib3NlTW9kZSA9IGFmdGVyTWlsZXN0b25lLmluY2x1ZGVzKFwiLS12ZXJib3NlXCIpO1xuICAgIGNvbnN0IGRlYnVnTW9kZSA9IGFmdGVyTWlsZXN0b25lLmluY2x1ZGVzKFwiLS1kZWJ1Z1wiKTtcbiAgICBpZiAoZGVidWdNb2RlKSBlbmFibGVEZWJ1Zyhwcm9qZWN0Um9vdCgpKTtcbiAgICBpZiAoIShhd2FpdCBndWFyZFJlbW90ZVNlc3Npb24oY3R4LCBwaSkpKSByZXR1cm4gdHJ1ZTtcblxuICAgIC8vIFZhbGlkYXRlIHRoZSBtaWxlc3RvbmUgdGFyZ2V0IGV4aXN0cyBhbmQgaXMgbm90IGFscmVhZHkgY29tcGxldGUuXG4gICAgaWYgKG1pbGVzdG9uZUlkKSB7XG4gICAgICBjb25zdCBhbGxJZHMgPSBmaW5kTWlsZXN0b25lSWRzKHByb2plY3RSb290KCkpO1xuICAgICAgaWYgKCFhbGxJZHMuaW5jbHVkZXMobWlsZXN0b25lSWQpKSB7XG4gICAgICAgIGN0eC51aS5ub3RpZnkoYE1pbGVzdG9uZSAke21pbGVzdG9uZUlkfSBkb2VzIG5vdCBleGlzdC4gQXZhaWxhYmxlOiAke2FsbElkcy5qb2luKFwiLCBcIikgfHwgXCIobm9uZSlcIn1gLCBcImVycm9yXCIpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBzdGFydEF1dG9EZXRhY2hlZChjdHgsIHBpLCBwcm9qZWN0Um9vdCgpLCB2ZXJib3NlTW9kZSwge1xuICAgICAgc3RlcDogdHJ1ZSxcbiAgICAgIG1pbGVzdG9uZUxvY2s6IG1pbGVzdG9uZUlkLFxuICAgIH0pO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgaWYgKHRyaW1tZWQgPT09IFwiYXV0b1wiIHx8IHRyaW1tZWQuc3RhcnRzV2l0aChcImF1dG8gXCIpKSB7XG4gICAgY29uc3QgeyB5b2xvU2VlZEZpbGUsIHJlc3Q6IGFmdGVyWW9sbyB9ID0gcGFyc2VZb2xvRmxhZyh0cmltbWVkKTtcbiAgICBjb25zdCB7IG1pbGVzdG9uZUlkLCByZXN0OiBhZnRlck1pbGVzdG9uZSB9ID0gcGFyc2VNaWxlc3RvbmVUYXJnZXQoYWZ0ZXJZb2xvKTtcbiAgICBjb25zdCB2ZXJib3NlTW9kZSA9IGFmdGVyTWlsZXN0b25lLmluY2x1ZGVzKFwiLS12ZXJib3NlXCIpO1xuICAgIGNvbnN0IGRlYnVnTW9kZSA9IGFmdGVyTWlsZXN0b25lLmluY2x1ZGVzKFwiLS1kZWJ1Z1wiKTtcbiAgICBpZiAoZGVidWdNb2RlKSBlbmFibGVEZWJ1Zyhwcm9qZWN0Um9vdCgpKTtcbiAgICBpZiAoIShhd2FpdCBndWFyZFJlbW90ZVNlc3Npb24oY3R4LCBwaSkpKSByZXR1cm4gdHJ1ZTtcblxuICAgIC8vIFZhbGlkYXRlIHRoZSBtaWxlc3RvbmUgdGFyZ2V0IGV4aXN0cyBhbmQgaXMgbm90IGFscmVhZHkgY29tcGxldGUuXG4gICAgaWYgKG1pbGVzdG9uZUlkKSB7XG4gICAgICBjb25zdCBhbGxJZHMgPSBmaW5kTWlsZXN0b25lSWRzKHByb2plY3RSb290KCkpO1xuICAgICAgaWYgKCFhbGxJZHMuaW5jbHVkZXMobWlsZXN0b25lSWQpKSB7XG4gICAgICAgIGN0eC51aS5ub3RpZnkoYE1pbGVzdG9uZSAke21pbGVzdG9uZUlkfSBkb2VzIG5vdCBleGlzdC4gQXZhaWxhYmxlOiAke2FsbElkcy5qb2luKFwiLCBcIikgfHwgXCIobm9uZSlcIn1gLCBcImVycm9yXCIpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoeW9sb1NlZWRGaWxlKSB7XG4gICAgICBjb25zdCByZXNvbHZlZCA9IHJlc29sdmUocHJvamVjdFJvb3QoKSwgeW9sb1NlZWRGaWxlKTtcbiAgICAgIGlmICghZXhpc3RzU3luYyhyZXNvbHZlZCkpIHtcbiAgICAgICAgY3R4LnVpLm5vdGlmeShgWW9sbyBzZWVkIGZpbGUgbm90IGZvdW5kOiAke3Jlc29sdmVkfWAsIFwiZXJyb3JcIik7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfVxuICAgICAgY29uc3Qgc2VlZENvbnRlbnQgPSByZWFkRmlsZVN5bmMocmVzb2x2ZWQsIFwidXRmLThcIikudHJpbSgpO1xuICAgICAgaWYgKCFzZWVkQ29udGVudCkge1xuICAgICAgICBjdHgudWkubm90aWZ5KGBZb2xvIHNlZWQgZmlsZSBpcyBlbXB0eTogJHtyZXNvbHZlZH1gLCBcImVycm9yXCIpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICAgIC8vIEhlYWRsZXNzIHBhdGg6IGJvb3RzdHJhcCBwcm9qZWN0LCBkaXNwYXRjaCBub24taW50ZXJhY3RpdmUgZGlzY3VzcyxcbiAgICAgIC8vIHRoZW4gYXV0by1tb2RlIHN0YXJ0cyBhdXRvbWF0aWNhbGx5IHZpYSBjaGVja0F1dG9TdGFydEFmdGVyRGlzY3Vzc1xuICAgICAgLy8gd2hlbiB0aGUgTExNIHNheXMgXCJNaWxlc3RvbmUgWCByZWFkeS5cIlxuICAgICAgY29uc3QgeyBzaG93SGVhZGxlc3NNaWxlc3RvbmVDcmVhdGlvbiB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vLi4vZ3VpZGVkLWZsb3cuanNcIik7XG4gICAgICBhd2FpdCBzaG93SGVhZGxlc3NNaWxlc3RvbmVDcmVhdGlvbihjdHgsIHBpLCBwcm9qZWN0Um9vdCgpLCBzZWVkQ29udGVudCk7XG4gICAgfSBlbHNlIGlmIChtaWxlc3RvbmVJZCkge1xuICAgICAgc3RhcnRBdXRvRGV0YWNoZWQoY3R4LCBwaSwgcHJvamVjdFJvb3QoKSwgdmVyYm9zZU1vZGUsIHtcbiAgICAgICAgbWlsZXN0b25lTG9jazogbWlsZXN0b25lSWQsXG4gICAgICB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgc3RhcnRBdXRvRGV0YWNoZWQoY3R4LCBwaSwgcHJvamVjdFJvb3QoKSwgdmVyYm9zZU1vZGUpO1xuICAgIH1cbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIGlmICh0cmltbWVkID09PSBcInN0b3BcIikge1xuICAgIGlmICghaXNBdXRvQWN0aXZlKCkgJiYgIWlzQXV0b1BhdXNlZCgpKSB7XG4gICAgICBjb25zdCByZXN1bHQgPSBzdG9wQXV0b1JlbW90ZShwcm9qZWN0Um9vdCgpKTtcbiAgICAgIGlmIChyZXN1bHQuZm91bmQpIHtcbiAgICAgICAgY3R4LnVpLm5vdGlmeShgU2VudCBzdG9wIHNpZ25hbCB0byBhdXRvLW1vZGUgc2Vzc2lvbiAoUElEICR7cmVzdWx0LnBpZH0pLiBJdCB3aWxsIHNodXQgZG93biBncmFjZWZ1bGx5LmAsIFwiaW5mb1wiKTtcbiAgICAgIH0gZWxzZSBpZiAocmVzdWx0LmVycm9yKSB7XG4gICAgICAgIGN0eC51aS5ub3RpZnkoYEZhaWxlZCB0byBzdG9wIHJlbW90ZSBhdXRvLW1vZGU6ICR7cmVzdWx0LmVycm9yfWAsIFwiZXJyb3JcIik7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjdHgudWkubm90aWZ5KFwiQXV0by1tb2RlIGlzIG5vdCBydW5uaW5nLlwiLCBcImluZm9cIik7XG4gICAgICB9XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgYXdhaXQgc3RvcEF1dG8oY3R4LCBwaSwgXCJVc2VyIHJlcXVlc3RlZCBzdG9wXCIpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgaWYgKHRyaW1tZWQgPT09IFwicGF1c2VcIikge1xuICAgIGlmICghaXNBdXRvQWN0aXZlKCkpIHtcbiAgICAgIGlmIChpc0F1dG9QYXVzZWQoKSkge1xuICAgICAgICBjdHgudWkubm90aWZ5KFwiQXV0by1tb2RlIGlzIGFscmVhZHkgcGF1c2VkLiAvZ3NkIGF1dG8gdG8gcmVzdW1lLlwiLCBcImluZm9cIik7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjdHgudWkubm90aWZ5KFwiQXV0by1tb2RlIGlzIG5vdCBydW5uaW5nLlwiLCBcImluZm9cIik7XG4gICAgICB9XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgYXdhaXQgcGF1c2VBdXRvKGN0eCwgcGkpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgaWYgKHRyaW1tZWQgPT09IFwicmF0ZVwiIHx8IHRyaW1tZWQuc3RhcnRzV2l0aChcInJhdGUgXCIpKSB7XG4gICAgYXdhaXQgaGFuZGxlUmF0ZSh0cmltbWVkLnJlcGxhY2UoL15yYXRlXFxzKi8sIFwiXCIpLnRyaW0oKSwgY3R4LCBwcm9qZWN0Um9vdCgpKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIGlmICh0cmltbWVkID09PSBcIlwiKSB7XG4gICAgaWYgKCEoYXdhaXQgZ3VhcmRSZW1vdGVTZXNzaW9uKGN0eCwgcGkpKSkgcmV0dXJuIHRydWU7XG4gICAgY29uc3QgeyBzaG93U21hcnRFbnRyeSB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vLi4vZ3VpZGVkLWZsb3cuanNcIik7XG4gICAgYXdhaXQgc2hvd1NtYXJ0RW50cnkoY3R4LCBwaSwgcHJvamVjdFJvb3QoKSwgeyBzdGVwOiB0cnVlIH0pO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgcmV0dXJuIGZhbHNlO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBRUEsU0FBUyxZQUFZLG9CQUFvQjtBQUN6QyxTQUFTLGVBQWU7QUFFeEIsU0FBUyxtQkFBbUI7QUFDNUIsU0FBK0IsY0FBYyxjQUFjLFdBQVcsbUJBQW1CLFVBQVUsc0JBQXNCO0FBQ3pILFNBQVMsa0JBQWtCO0FBQzNCLFNBQVMsb0JBQW9CLG1CQUFtQjtBQUNoRCxTQUFTLHdCQUF3QjtBQU1qQyxTQUFTLGNBQWMsU0FBZ0U7QUFDckYsUUFBTSxTQUFTO0FBQ2YsUUFBTSxRQUFRLFFBQVEsTUFBTSxNQUFNO0FBQ2xDLE1BQUksQ0FBQyxNQUFPLFFBQU8sRUFBRSxjQUFjLE1BQU0sTUFBTSxRQUFRO0FBR3ZELE1BQUksV0FBVyxNQUFNLENBQUM7QUFDdEIsTUFBSyxTQUFTLFdBQVcsR0FBRyxLQUFLLFNBQVMsU0FBUyxHQUFHLEtBQ2pELFNBQVMsV0FBVyxHQUFHLEtBQUssU0FBUyxTQUFTLEdBQUcsR0FBSTtBQUN4RCxlQUFXLFNBQVMsTUFBTSxHQUFHLEVBQUU7QUFBQSxFQUNqQztBQUVBLFFBQU0sT0FBTyxRQUFRLFFBQVEsTUFBTSxDQUFDLEdBQUcsRUFBRSxFQUFFLFFBQVEs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RSxXQUFXLGFBQWE7QUFDdEIsd0JBQWtCLEtBQUssSUFBSSxZQUFZLEdBQUcsYUFBYTtBQUFBLFFBQ3JELGVBQWU7QUFBQSxNQUNqQixDQUFDO0FBQUEsSUFDSCxPQUFPO0FBQ0wsd0JBQWtCLEtBQUssSUFBSSxZQUFZLEdBQUcsV0FBVztBQUFBLElBQ3ZEO0FBQ0EsV0FBTztBQUFBLEVBQ1Q7QUFFQSxNQUFJLFlBQVksUUFBUTtBQUN0QixRQUFJLENBQUMsYUFBYSxLQUFLLENBQUMsYUFBYSxHQUFHO0FBQ3RDLFlBQU0sU0FBUyxlQUFlLFlBQVksQ0FBQztBQUMzQyxVQUFJLE9BQU8sT0FBTztBQUNoQixZQUFJLEdBQUcsT0FBTyw4Q0FBOEMsT0FBTyxHQUFHLG9DQUFvQyxNQUFNO0FBQUEsTUFDbEgsV0FBVyxPQUFPLE9BQU87QUFDdkIsWUFBSSxHQUFHLE9BQU8sb0NBQW9DLE9BQU8sS0FBSyxJQUFJLE9BQU87QUFBQSxNQUMzRSxPQUFPO0FBQ0wsWUFBSSxHQUFHLE9BQU8sNkJBQTZCLE1BQU07QUFBQSxNQUNuRDtBQUNBLGFBQU87QUFBQSxJQUNUO0FBQ0EsVUFBTSxTQUFTLEtBQUssSUFBSSxxQkFBcUI7QUFDN0MsV0FBTztBQUFBLEVBQ1Q7QUFFQSxNQUFJLFlBQVksU0FBUztBQUN2QixRQUFJLENBQUMsYUFBYSxHQUFHO0FBQ25CLFVBQUksYUFBYSxHQUFHO0FBQ2xCLFlBQUksR0FBRyxPQUFPLHFEQUFxRCxNQUFNO0FBQUEsTUFDM0UsT0FBTztBQUNMLFlBQUksR0FBRyxPQUFPLDZCQUE2QixNQUFNO0FBQUEsTUFDbkQ7QUFDQSxhQUFPO0FBQUEsSUFDVDtBQUNBLFVBQU0sVUFBVSxLQUFLLEVBQUU7QUFDdkIsV0FBTztBQUFBLEVBQ1Q7QUFFQSxNQUFJLFlBQVksVUFBVSxRQUFRLFdBQVcsT0FBTyxHQUFHO0FBQ3JELFVBQU0sV0FBVyxRQUFRLFFBQVEsWUFBWSxFQUFFLEVBQUUsS0FBSyxHQUFHLEtBQUssWUFBWSxDQUFDO0FBQzNFLFdBQU87QUFBQSxFQUNUO0FBRUEsTUFBSSxZQUFZLElBQUk7QUFDbEIsUUFBSSxDQUFFLE1BQU0sbUJBQW1CLEtBQUssRUFBRSxFQUFJLFFBQU87QUFDakQsVUFBTSxFQUFFLGVBQWUsSUFBSSxNQUFNLE9BQU8sc0JBQXNCO0FBQzlELFVBQU0sZUFBZSxLQUFLLElBQUksWUFBWSxHQUFHLEVBQUUsTUFBTSxLQUFLLENBQUM7QUFDM0QsV0FBTztBQUFBLEVBQ1Q7QUFFQSxTQUFPO0FBQ1Q7IiwKICAibmFtZXMiOiBbXQp9Cg==
