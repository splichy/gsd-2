import { checkRemoteAutoSession, isAutoActive, isAutoPaused, stopAutoRemote } from "../auto.js";
import { validateDirectory } from "../validate-directory.js";
import { resolveProjectRoot } from "../worktree.js";
import { showNextAction } from "../../shared/tui.js";
import { handleStatus } from "./handlers/core.js";
import { homedir } from "node:os";
class GSDNoProjectError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "GSDNoProjectError";
  }
}
let commandCwdOverride = null;
async function withCommandCwd(cwd, fn) {
  const previous = commandCwdOverride;
  commandCwdOverride = cwd || null;
  try {
    return await fn();
  } finally {
    commandCwdOverride = previous;
  }
}
function projectRoot() {
  let cwd;
  if (commandCwdOverride) {
    cwd = commandCwdOverride;
  } else {
    try {
      cwd = process.cwd();
    } catch {
      cwd = homedir();
    }
  }
  const root = resolveProjectRoot(cwd);
  const pathToCheck = root !== cwd ? cwd : root;
  const result = validateDirectory(pathToCheck);
  if (result.severity === "blocked") {
    throw new GSDNoProjectError(result.reason ?? "GSD must be run inside a project directory.");
  }
  return root;
}
function currentDirectoryRoot() {
  let cwd;
  if (commandCwdOverride) {
    cwd = commandCwdOverride;
  } else {
    try {
      cwd = process.cwd();
    } catch {
      cwd = homedir();
    }
  }
  const result = validateDirectory(cwd);
  if (result.severity === "blocked") {
    throw new GSDNoProjectError(result.reason ?? "GSD must be run inside a project directory.");
  }
  return cwd;
}
async function guardRemoteSession(ctx, pi) {
  if (isAutoActive() || isAutoPaused()) return true;
  const remote = checkRemoteAutoSession(projectRoot());
  if (!remote.running || !remote.pid) return true;
  const unitLabel = remote.unitType && remote.unitId ? `${remote.unitType} (${remote.unitId})` : "unknown unit";
  if (process.env.GSD_WEB_BRIDGE_TUI === "1") {
    ctx.ui.notify(
      `Another auto-mode session (PID ${remote.pid}) is running on this project (${unitLabel}). Stop it first with /gsd stop, or use /gsd steer to redirect it.`,
      "warning"
    );
    return false;
  }
  const choice = await showNextAction(ctx, {
    title: `Auto-mode is running in another terminal (PID ${remote.pid})`,
    summary: [
      `Currently executing: ${unitLabel}`,
      ...remote.startedAt ? [`Started: ${remote.startedAt}`] : []
    ],
    actions: [
      {
        id: "status",
        label: "View status",
        description: "Show the current GSD progress dashboard.",
        recommended: true
      },
      {
        id: "steer",
        label: "Steer the session",
        description: "Use /gsd steer <instruction> to redirect the running session."
      },
      {
        id: "stop",
        label: "Stop remote session",
        description: `Send SIGTERM to PID ${remote.pid} to stop it gracefully.`
      },
      {
        id: "force",
        label: "Force start (steal lock)",
        description: "Start a new session, terminating the existing one."
      }
    ],
    notYetMessage: "Run /gsd when ready."
  });
  if (choice === "status") {
    await handleStatus(ctx);
    return false;
  }
  if (choice === "steer") {
    ctx.ui.notify(
      "Use /gsd steer <instruction> to redirect the running auto-mode session.\nExample: /gsd steer Use Postgres instead of SQLite",
      "info"
    );
    return false;
  }
  if (choice === "stop") {
    const result = stopAutoRemote(projectRoot());
    if (result.found) {
      ctx.ui.notify(`Sent stop signal to auto-mode session (PID ${result.pid}). It will shut down gracefully.`, "info");
    } else if (result.error) {
      ctx.ui.notify(`Failed to stop remote auto-mode: ${result.error}`, "error");
    } else {
      ctx.ui.notify("Remote session is no longer running.", "info");
    }
    return false;
  }
  return choice === "force";
}
export {
  GSDNoProjectError,
  currentDirectoryRoot,
  guardRemoteSession,
  projectRoot,
  withCommandCwd
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9jb21tYW5kcy9jb250ZXh0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdHlwZSB7IEV4dGVuc2lvbkFQSSwgRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcblxuaW1wb3J0IHsgY2hlY2tSZW1vdGVBdXRvU2Vzc2lvbiwgaXNBdXRvQWN0aXZlLCBpc0F1dG9QYXVzZWQsIHN0b3BBdXRvUmVtb3RlIH0gZnJvbSBcIi4uL2F1dG8uanNcIjtcbmltcG9ydCB7IHZhbGlkYXRlRGlyZWN0b3J5IH0gZnJvbSBcIi4uL3ZhbGlkYXRlLWRpcmVjdG9yeS5qc1wiO1xuaW1wb3J0IHsgcmVzb2x2ZVByb2plY3RSb290IH0gZnJvbSBcIi4uL3dvcmt0cmVlLmpzXCI7XG5pbXBvcnQgeyBzaG93TmV4dEFjdGlvbiB9IGZyb20gXCIuLi8uLi9zaGFyZWQvdHVpLmpzXCI7XG5pbXBvcnQgeyBoYW5kbGVTdGF0dXMgfSBmcm9tIFwiLi9oYW5kbGVycy9jb3JlLmpzXCI7XG5pbXBvcnQgeyBob21lZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcblxuZXhwb3J0IGludGVyZmFjZSBHc2REaXNwYXRjaENvbnRleHQge1xuICBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0O1xuICBwaTogRXh0ZW5zaW9uQVBJO1xuICB0cmltbWVkOiBzdHJpbmc7XG59XG5cbi8qKlxuICogVHlwZWQgZXJyb3IgZm9yIHdoZW4gR1NEIGlzIHJ1biBvdXRzaWRlIGEgdmFsaWQgcHJvamVjdCBkaXJlY3RvcnkuXG4gKiBDb21tYW5kIGhhbmRsZXJzIGNhdGNoIHRoaXMgdG8gc2hvdyBhIGZyaWVuZGx5IG1lc3NhZ2UgaW5zdGVhZCBvZiBhIHJhdyBleGNlcHRpb24uXG4gKi9cbmV4cG9ydCBjbGFzcyBHU0ROb1Byb2plY3RFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IocmVhc29uOiBzdHJpbmcpIHtcbiAgICBzdXBlcihyZWFzb24pO1xuICAgIHRoaXMubmFtZSA9IFwiR1NETm9Qcm9qZWN0RXJyb3JcIjtcbiAgfVxufVxuXG5sZXQgY29tbWFuZEN3ZE92ZXJyaWRlOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHdpdGhDb21tYW5kQ3dkPFQ+KGN3ZDogc3RyaW5nIHwgdW5kZWZpbmVkLCBmbjogKCkgPT4gUHJvbWlzZTxUPik6IFByb21pc2U8VD4ge1xuICBjb25zdCBwcmV2aW91cyA9IGNvbW1hbmRDd2RPdmVycmlkZTtcbiAgY29tbWFuZEN3ZE92ZXJyaWRlID0gY3dkIHx8IG51bGw7XG4gIHRyeSB7XG4gICAgcmV0dXJuIGF3YWl0IGZuKCk7XG4gIH0gZmluYWxseSB7XG4gICAgY29tbWFuZEN3ZE92ZXJyaWRlID0gcHJldmlvdXM7XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHByb2plY3RSb290KCk6IHN0cmluZyB7XG4gIGxldCBjd2Q6IHN0cmluZztcbiAgaWYgKGNvbW1hbmRDd2RPdmVycmlkZSkge1xuICAgIGN3ZCA9IGNvbW1hbmRDd2RPdmVycmlkZTtcbiAgfSBlbHNlIHtcbiAgICB0cnkge1xuICAgICAgY3dkID0gcHJvY2Vzcy5jd2QoKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIGN3ZCBkaXJlY3Rvcnkgd2FzIGRlbGV0ZWQgKGUuZy4gd29ya3RyZWUgdGVhcmRvd24pIFx1MjAxNCBmYWxsIGJhY2sgdG8gaG9tZSAoIzM1OTgpXG4gICAgICBjd2QgPSBob21lZGlyKCk7XG4gICAgfVxuICB9XG4gIGNvbnN0IHJvb3QgPSByZXNvbHZlUHJvamVjdFJvb3QoY3dkKTtcbiAgY29uc3QgcGF0aFRvQ2hlY2sgPSByb290ICE9PSBjd2QgPyBjd2QgOiByb290O1xuICBjb25zdCByZXN1bHQgPSB2YWxpZGF0ZURpcmVjdG9yeShwYXRoVG9DaGVjayk7XG4gIGlmIChyZXN1bHQuc2V2ZXJpdHkgPT09IFwiYmxvY2tlZFwiKSB7XG4gICAgdGhyb3cgbmV3IEdTRE5vUHJvamVjdEVycm9yKHJlc3VsdC5yZWFzb24gPz8gXCJHU0QgbXVzdCBiZSBydW4gaW5zaWRlIGEgcHJvamVjdCBkaXJlY3RvcnkuXCIpO1xuICB9XG4gIHJldHVybiByb290O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY3VycmVudERpcmVjdG9yeVJvb3QoKTogc3RyaW5nIHtcbiAgbGV0IGN3ZDogc3RyaW5nO1xuICBpZiAoY29tbWFuZEN3ZE92ZXJyaWRlKSB7XG4gICAgY3dkID0gY29tbWFuZEN3ZE92ZXJyaWRlO1xuICB9IGVsc2Uge1xuICAgIHRyeSB7XG4gICAgICBjd2QgPSBwcm9jZXNzLmN3ZCgpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgY3dkID0gaG9tZWRpcigpO1xuICAgIH1cbiAgfVxuICBjb25zdCByZXN1bHQgPSB2YWxpZGF0ZURpcmVjdG9yeShjd2QpO1xuICBpZiAocmVzdWx0LnNldmVyaXR5ID09PSBcImJsb2NrZWRcIikge1xuICAgIHRocm93IG5ldyBHU0ROb1Byb2plY3RFcnJvcihyZXN1bHQucmVhc29uID8/IFwiR1NEIG11c3QgYmUgcnVuIGluc2lkZSBhIHByb2plY3QgZGlyZWN0b3J5LlwiKTtcbiAgfVxuICByZXR1cm4gY3dkO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ3VhcmRSZW1vdGVTZXNzaW9uKFxuICBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LFxuICBwaTogRXh0ZW5zaW9uQVBJLFxuKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGlmIChpc0F1dG9BY3RpdmUoKSB8fCBpc0F1dG9QYXVzZWQoKSkgcmV0dXJuIHRydWU7XG5cbiAgY29uc3QgcmVtb3RlID0gY2hlY2tSZW1vdGVBdXRvU2Vzc2lvbihwcm9qZWN0Um9vdCgpKTtcbiAgaWYgKCFyZW1vdGUucnVubmluZyB8fCAhcmVtb3RlLnBpZCkgcmV0dXJuIHRydWU7XG5cbiAgY29uc3QgdW5pdExhYmVsID0gcmVtb3RlLnVuaXRUeXBlICYmIHJlbW90ZS51bml0SWRcbiAgICA/IGAke3JlbW90ZS51bml0VHlwZX0gKCR7cmVtb3RlLnVuaXRJZH0pYFxuICAgIDogXCJ1bmtub3duIHVuaXRcIjtcblxuICAvLyBJbiBSUEMvd2ViIGJyaWRnZSBtb2RlLCBpbnRlcmFjdGl2ZSBUVUkgcHJvbXB0cyAoc2hvd05leHRBY3Rpb24pIGJsb2NrXG4gIC8vIGZvcmV2ZXIgYmVjYXVzZSB0aGVyZSBpcyBubyB0ZXJtaW5hbCB0byBhbnN3ZXIgdGhlbS4gTm90aWZ5IGFuZCBiYWlsLlxuICBpZiAocHJvY2Vzcy5lbnYuR1NEX1dFQl9CUklER0VfVFVJID09PSBcIjFcIikge1xuICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICBgQW5vdGhlciBhdXRvLW1vZGUgc2Vzc2lvbiAoUElEICR7cmVtb3RlLnBpZH0pIGlzIHJ1bm5pbmcgb24gdGhpcyBwcm9qZWN0ICgke3VuaXRMYWJlbH0pLiBgICtcbiAgICAgIGBTdG9wIGl0IGZpcnN0IHdpdGggL2dzZCBzdG9wLCBvciB1c2UgL2dzZCBzdGVlciB0byByZWRpcmVjdCBpdC5gLFxuICAgICAgXCJ3YXJuaW5nXCIsXG4gICAgKTtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICBjb25zdCBjaG9pY2UgPSBhd2FpdCBzaG93TmV4dEFjdGlvbihjdHgsIHtcbiAgICB0aXRsZTogYEF1dG8tbW9kZSBpcyBydW5uaW5nIGluIGFub3RoZXIgdGVybWluYWwgKFBJRCAke3JlbW90ZS5waWR9KWAsXG4gICAgc3VtbWFyeTogW1xuICAgICAgYEN1cnJlbnRseSBleGVjdXRpbmc6ICR7dW5pdExhYmVsfWAsXG4gICAgICAuLi4ocmVtb3RlLnN0YXJ0ZWRBdCA/IFtgU3RhcnRlZDogJHtyZW1vdGUuc3RhcnRlZEF0fWBdIDogW10pLFxuICAgIF0sXG4gICAgYWN0aW9uczogW1xuICAgICAge1xuICAgICAgICBpZDogXCJzdGF0dXNcIixcbiAgICAgICAgbGFiZWw6IFwiVmlldyBzdGF0dXNcIixcbiAgICAgICAgZGVzY3JpcHRpb246IFwiU2hvdyB0aGUgY3VycmVudCBHU0QgcHJvZ3Jlc3MgZGFzaGJvYXJkLlwiLFxuICAgICAgICByZWNvbW1lbmRlZDogdHJ1ZSxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIGlkOiBcInN0ZWVyXCIsXG4gICAgICAgIGxhYmVsOiBcIlN0ZWVyIHRoZSBzZXNzaW9uXCIsXG4gICAgICAgIGRlc2NyaXB0aW9uOiBcIlVzZSAvZ3NkIHN0ZWVyIDxpbnN0cnVjdGlvbj4gdG8gcmVkaXJlY3QgdGhlIHJ1bm5pbmcgc2Vzc2lvbi5cIixcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIGlkOiBcInN0b3BcIixcbiAgICAgICAgbGFiZWw6IFwiU3RvcCByZW1vdGUgc2Vzc2lvblwiLFxuICAgICAgICBkZXNjcmlwdGlvbjogYFNlbmQgU0lHVEVSTSB0byBQSUQgJHtyZW1vdGUucGlkfSB0byBzdG9wIGl0IGdyYWNlZnVsbHkuYCxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIGlkOiBcImZvcmNlXCIsXG4gICAgICAgIGxhYmVsOiBcIkZvcmNlIHN0YXJ0IChzdGVhbCBsb2NrKVwiLFxuICAgICAgICBkZXNjcmlwdGlvbjogXCJTdGFydCBhIG5ldyBzZXNzaW9uLCB0ZXJtaW5hdGluZyB0aGUgZXhpc3Rpbmcgb25lLlwiLFxuICAgICAgfSxcbiAgICBdLFxuICAgIG5vdFlldE1lc3NhZ2U6IFwiUnVuIC9nc2Qgd2hlbiByZWFkeS5cIixcbiAgfSk7XG5cbiAgaWYgKGNob2ljZSA9PT0gXCJzdGF0dXNcIikge1xuICAgIGF3YWl0IGhhbmRsZVN0YXR1cyhjdHgpO1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICBpZiAoY2hvaWNlID09PSBcInN0ZWVyXCIpIHtcbiAgICBjdHgudWkubm90aWZ5KFxuICAgICAgXCJVc2UgL2dzZCBzdGVlciA8aW5zdHJ1Y3Rpb24+IHRvIHJlZGlyZWN0IHRoZSBydW5uaW5nIGF1dG8tbW9kZSBzZXNzaW9uLlxcblwiICtcbiAgICAgIFwiRXhhbXBsZTogL2dzZCBzdGVlciBVc2UgUG9zdGdyZXMgaW5zdGVhZCBvZiBTUUxpdGVcIixcbiAgICAgIFwiaW5mb1wiLFxuICAgICk7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIGlmIChjaG9pY2UgPT09IFwic3RvcFwiKSB7XG4gICAgY29uc3QgcmVzdWx0ID0gc3RvcEF1dG9SZW1vdGUocHJvamVjdFJvb3QoKSk7XG4gICAgaWYgKHJlc3VsdC5mb3VuZCkge1xuICAgICAgY3R4LnVpLm5vdGlmeShgU2VudCBzdG9wIHNpZ25hbCB0byBhdXRvLW1vZGUgc2Vzc2lvbiAoUElEICR7cmVzdWx0LnBpZH0pLiBJdCB3aWxsIHNodXQgZG93biBncmFjZWZ1bGx5LmAsIFwiaW5mb1wiKTtcbiAgICB9IGVsc2UgaWYgKHJlc3VsdC5lcnJvcikge1xuICAgICAgY3R4LnVpLm5vdGlmeShgRmFpbGVkIHRvIHN0b3AgcmVtb3RlIGF1dG8tbW9kZTogJHtyZXN1bHQuZXJyb3J9YCwgXCJlcnJvclwiKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY3R4LnVpLm5vdGlmeShcIlJlbW90ZSBzZXNzaW9uIGlzIG5vIGxvbmdlciBydW5uaW5nLlwiLCBcImluZm9cIik7XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIHJldHVybiBjaG9pY2UgPT09IFwiZm9yY2VcIjtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUVBLFNBQVMsd0JBQXdCLGNBQWMsY0FBYyxzQkFBc0I7QUFDbkYsU0FBUyx5QkFBeUI7QUFDbEMsU0FBUywwQkFBMEI7QUFDbkMsU0FBUyxzQkFBc0I7QUFDL0IsU0FBUyxvQkFBb0I7QUFDN0IsU0FBUyxlQUFlO0FBWWpCLE1BQU0sMEJBQTBCLE1BQU07QUFBQSxFQUMzQyxZQUFZLFFBQWdCO0FBQzFCLFVBQU0sTUFBTTtBQUNaLFNBQUssT0FBTztBQUFBLEVBQ2Q7QUFDRjtBQUVBLElBQUkscUJBQW9DO0FBRXhDLGVBQXNCLGVBQWtC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
