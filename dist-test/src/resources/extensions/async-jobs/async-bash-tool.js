import {
  getShellConfig,
  sanitizeCommand,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES
} from "@gsd/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { rewriteCommandWithRtk } from "../shared/rtk.js";
const schema = Type.Object({
  command: Type.String({ description: "Bash command to execute in the background" }),
  timeout: Type.Optional(
    Type.Number({ description: "Timeout in seconds (optional)" })
  ),
  label: Type.Optional(
    Type.String({ description: "Short label for the job (shown in /jobs). Defaults to a truncated version of the command." })
  )
});
function getTempFilePath() {
  const id = randomBytes(8).toString("hex");
  return join(tmpdir(), `pi-async-bash-${id}.log`);
}
function killTree(pid) {
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
        timeout: 5e3,
        stdio: "ignore"
      });
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
      }
    }
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
      }
    }
  }
}
function createAsyncBashTool(getManager, getCwd) {
  return {
    name: "async_bash",
    label: "Background Bash",
    description: `Run a bash command in the background. Returns a job ID immediately so you can continue working. Use await_job to get results or cancel_job to stop. Ideal for long-running builds, tests, or installs. Output is truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB.`,
    promptSnippet: "Run a bash command in the background, returning a job ID immediately.",
    promptGuidelines: [
      "Use async_bash for commands that take more than a few seconds (builds, tests, installs, large git operations).",
      "After starting async jobs, continue with other work and use await_job when you need the results.",
      "await_job has a configurable timeout (default 120s) to prevent indefinite blocking \u2014 if it times out, jobs keep running and you can check again later.",
      "For long-running processes (SSH, deploys, training) that may take minutes+, prefer async_bash with periodic await_job polling over a single long await.",
      "Use cancel_job to stop a running background job.",
      "Check /jobs to see all running and recent background jobs."
    ],
    parameters: schema,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const manager = getManager();
      const cwd = getCwd();
      const { command, timeout, label } = params;
      const shortCmd = label ?? (command.length > 60 ? command.slice(0, 57) + "..." : command);
      const jobId = manager.register("bash", shortCmd, (signal) => {
        return executeBashInBackground(command, cwd, signal, timeout);
      });
      return {
        content: [{
          type: "text",
          text: [
            `Background job started: **${jobId}**`,
            `Command: \`${shortCmd}\``,
            "",
            "Use `await_job` to get results when ready, or `cancel_job` to stop."
          ].join("\n")
        }],
        details: void 0
      };
    }
  };
}
function executeBashInBackground(command, cwd, signal, timeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const safeResolve = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const safeReject = (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };
    const { shell, args } = getShellConfig();
    const rewrittenCommand = rewriteCommandWithRtk(command);
    const resolvedCommand = sanitizeCommand(rewrittenCommand);
    const child = spawn(shell, [...args, resolvedCommand], {
      cwd,
      detached: process.platform !== "win32",
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let timedOut = false;
    let timeoutHandle;
    let sigkillHandle;
    let hardDeadlineHandle;
    const SIGKILL_GRACE_MS = 5e3;
    const HARD_DEADLINE_MS = 3e3;
    if (timeout !== void 0 && timeout > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        if (child.pid) killTree(child.pid);
        sigkillHandle = setTimeout(() => {
          if (child.pid) {
            killTree(child.pid);
          }
          hardDeadlineHandle = setTimeout(() => {
            const output = Buffer.concat(chunks).toString("utf-8");
            safeResolve(
              output ? `${output}

Command timed out after ${timeout} seconds (force-killed)` : `Command timed out after ${timeout} seconds (force-killed)`
            );
          }, HARD_DEADLINE_MS);
          if (typeof hardDeadlineHandle === "object" && "unref" in hardDeadlineHandle) hardDeadlineHandle.unref();
        }, SIGKILL_GRACE_MS);
        if (typeof sigkillHandle === "object" && "unref" in sigkillHandle) sigkillHandle.unref();
      }, timeout * 1e3);
    }
    const chunks = [];
    let totalBytes = 0;
    let spillFilePath;
    let spillStream;
    const MAX_BUFFER = DEFAULT_MAX_BYTES * 2;
    const onData = (data) => {
      totalBytes += data.length;
      if (totalBytes > DEFAULT_MAX_BYTES && !spillFilePath) {
        spillFilePath = getTempFilePath();
        spillStream = createWriteStream(spillFilePath);
        for (const chunk of chunks) spillStream.write(chunk);
      }
      if (spillStream) spillStream.write(data);
      chunks.push(data);
      let chunksBytes = chunks.reduce((s, c) => s + c.length, 0);
      while (chunksBytes > MAX_BUFFER && chunks.length > 1) {
        const removed = chunks.shift();
        chunksBytes -= removed.length;
      }
    };
    if (child.stdout) child.stdout.on("data", onData);
    if (child.stderr) child.stderr.on("data", onData);
    const onAbort = () => {
      if (child.pid) killTree(child.pid);
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    child.on("error", (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (sigkillHandle) clearTimeout(sigkillHandle);
      if (hardDeadlineHandle) clearTimeout(hardDeadlineHandle);
      signal.removeEventListener("abort", onAbort);
      safeReject(err);
    });
    child.on("close", (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (sigkillHandle) clearTimeout(sigkillHandle);
      if (hardDeadlineHandle) clearTimeout(hardDeadlineHandle);
      signal.removeEventListener("abort", onAbort);
      if (spillStream) spillStream.end();
      if (signal.aborted) {
        const output = Buffer.concat(chunks).toString("utf-8");
        safeResolve(output ? `${output}

Command aborted` : "Command aborted");
        return;
      }
      if (timedOut) {
        const output = Buffer.concat(chunks).toString("utf-8");
        safeResolve(output ? `${output}

Command timed out after ${timeout} seconds` : `Command timed out after ${timeout} seconds`);
        return;
      }
      const fullOutput = Buffer.concat(chunks).toString("utf-8");
      const lines = fullOutput.split("\n");
      let text;
      if (lines.length > DEFAULT_MAX_LINES) {
        text = lines.slice(-DEFAULT_MAX_LINES).join("\n");
        if (spillFilePath) {
          text += `

[Showing last ${DEFAULT_MAX_LINES} of ${lines.length} lines. Full output: ${spillFilePath}]`;
        } else {
          text += `

[Showing last ${DEFAULT_MAX_LINES} of ${lines.length} lines]`;
        }
      } else {
        text = fullOutput || "(no output)";
      }
      if (code !== 0 && code !== null) {
        text += `

Command exited with code ${code}`;
      }
      safeResolve(text);
    });
  });
}
export {
  createAsyncBashTool
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2FzeW5jLWpvYnMvYXN5bmMtYmFzaC10b29sLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIGFzeW5jX2Jhc2ggdG9vbCBcdTIwMTQgcnVuIGEgYmFzaCBjb21tYW5kIGluIHRoZSBiYWNrZ3JvdW5kLlxuICpcbiAqIFJlZ2lzdGVycyB0aGUgY29tbWFuZCB3aXRoIHRoZSBBc3luY0pvYk1hbmFnZXIgYW5kIHJldHVybnMgYSBqb2IgSURcbiAqIGltbWVkaWF0ZWx5LiBUaGUgTExNIGNhbiBjb250aW51ZSB3b3JraW5nIGFuZCBjaGVjayByZXN1bHRzIGxhdGVyXG4gKiB3aXRoIGF3YWl0X2pvYi5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFRvb2xEZWZpbml0aW9uIH0gZnJvbSBcIkBnc2QvcGktY29kaW5nLWFnZW50XCI7XG5pbXBvcnQge1xuXHRnZXRTaGVsbENvbmZpZyxcblx0c2FuaXRpemVDb21tYW5kLFxuXHRERUZBVUxUX01BWF9CWVRFUyxcblx0REVGQVVMVF9NQVhfTElORVMsXG59IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuaW1wb3J0IHsgVHlwZSB9IGZyb20gXCJAc2luY2xhaXIvdHlwZWJveFwiO1xuaW1wb3J0IHsgc3Bhd24sIHNwYXduU3luYyB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7IGNyZWF0ZVdyaXRlU3RyZWFtIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgcmFuZG9tQnl0ZXMgfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcbmltcG9ydCB0eXBlIHsgQXN5bmNKb2JNYW5hZ2VyIH0gZnJvbSBcIi4vam9iLW1hbmFnZXIuanNcIjtcbmltcG9ydCB7IHJld3JpdGVDb21tYW5kV2l0aFJ0ayB9IGZyb20gXCIuLi9zaGFyZWQvcnRrLmpzXCI7XG5cbmNvbnN0IHNjaGVtYSA9IFR5cGUuT2JqZWN0KHtcblx0Y29tbWFuZDogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJCYXNoIGNvbW1hbmQgdG8gZXhlY3V0ZSBpbiB0aGUgYmFja2dyb3VuZFwiIH0pLFxuXHR0aW1lb3V0OiBUeXBlLk9wdGlvbmFsKFxuXHRcdFR5cGUuTnVtYmVyKHsgZGVzY3JpcHRpb246IFwiVGltZW91dCBpbiBzZWNvbmRzIChvcHRpb25hbClcIiB9KSxcblx0KSxcblx0bGFiZWw6IFR5cGUuT3B0aW9uYWwoXG5cdFx0VHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJTaG9ydCBsYWJlbCBmb3IgdGhlIGpvYiAoc2hvd24gaW4gL2pvYnMpLiBEZWZhdWx0cyB0byBhIHRydW5jYXRlZCB2ZXJzaW9uIG9mIHRoZSBjb21tYW5kLlwiIH0pLFxuXHQpLFxufSk7XG5cbmZ1bmN0aW9uIGdldFRlbXBGaWxlUGF0aCgpOiBzdHJpbmcge1xuXHRjb25zdCBpZCA9IHJhbmRvbUJ5dGVzKDgpLnRvU3RyaW5nKFwiaGV4XCIpO1xuXHRyZXR1cm4gam9pbih0bXBkaXIoKSwgYHBpLWFzeW5jLWJhc2gtJHtpZH0ubG9nYCk7XG59XG5cbi8qKlxuICogS2lsbCBhIHByb2Nlc3MgYW5kIGl0cyBjaGlsZHJlbiAoY3Jvc3MtcGxhdGZvcm0pLlxuICogVXNlcyBwcm9jZXNzIGdyb3VwIGtpbGwgb24gVW5peDsgdGFza2tpbGwgL0YgL1Qgb24gV2luZG93cy5cbiAqL1xuZnVuY3Rpb24ga2lsbFRyZWUocGlkOiBudW1iZXIpOiB2b2lkIHtcblx0aWYgKHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIikge1xuXHRcdHRyeSB7XG5cdFx0XHRzcGF3blN5bmMoXCJ0YXNra2lsbFwiLCBbXCIvRlwiLCBcIi9UXCIsIFwiL1BJRFwiLCBTdHJpbmcocGlkKV0sIHtcblx0XHRcdFx0dGltZW91dDogNV8wMDAsXG5cdFx0XHRcdHN0ZGlvOiBcImlnbm9yZVwiLFxuXHRcdFx0fSk7XG5cdFx0fSBjYXRjaCB7XG5cdFx0XHR0cnkgeyBwcm9jZXNzLmtpbGwocGlkLCBcIlNJR1RFUk1cIik7IH0gY2F0Y2ggeyAvKiBhbHJlYWR5IGV4aXRlZCAqLyB9XG5cdFx0fVxuXHR9IGVsc2Uge1xuXHRcdHRyeSB7XG5cdFx0XHRwcm9jZXNzLmtpbGwoLXBpZCwgXCJTSUdURVJNXCIpO1xuXHRcdH0gY2F0Y2gge1xuXHRcdFx0dHJ5IHsgcHJvY2Vzcy5raWxsKHBpZCwgXCJTSUdURVJNXCIpOyB9IGNhdGNoIHsgLyogYWxyZWFkeSBleGl0ZWQgKi8gfVxuXHRcdH1cblx0fVxufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlQXN5bmNCYXNoVG9vbChcblx0Z2V0TWFuYWdlcjogKCkgPT4gQXN5bmNKb2JNYW5hZ2VyLFxuXHRnZXRDd2Q6ICgpID0+IHN0cmluZyxcbik6IFRvb2xEZWZpbml0aW9uPHR5cGVvZiBzY2hlbWE+IHtcblx0cmV0dXJuIHtcblx0XHRuYW1lOiBcImFzeW5jX2Jhc2hcIixcblx0XHRsYWJlbDogXCJCYWNrZ3JvdW5kIEJhc2hcIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdGBSdW4gYSBiYXNoIGNvbW1hbmQgaW4gdGhlIGJhY2tncm91bmQuIFJldHVybnMgYSBqb2IgSUQgaW1tZWRpYXRlbHkgc28geW91IGNhbiBjb250aW51ZSB3b3JraW5nLiBgICtcblx0XHRcdGBVc2UgYXdhaXRfam9iIHRvIGdldCByZXN1bHRzIG9yIGNhbmNlbF9qb2IgdG8gc3RvcC4gSWRlYWwgZm9yIGxvbmctcnVubmluZyBidWlsZHMsIHRlc3RzLCBvciBpbnN0YWxscy4gYCArXG5cdFx0XHRgT3V0cHV0IGlzIHRydW5jYXRlZCB0byB0aGUgbGFzdCAke0RFRkFVTFRfTUFYX0xJTkVTfSBsaW5lcyBvciAke0RFRkFVTFRfTUFYX0JZVEVTIC8gMTAyNH1LQi5gLFxuXHRcdHByb21wdFNuaXBwZXQ6IFwiUnVuIGEgYmFzaCBjb21tYW5kIGluIHRoZSBiYWNrZ3JvdW5kLCByZXR1cm5pbmcgYSBqb2IgSUQgaW1tZWRpYXRlbHkuXCIsXG5cdFx0cHJvbXB0R3VpZGVsaW5lczogW1xuXHRcdFx0XCJVc2UgYXN5bmNfYmFzaCBmb3IgY29tbWFuZHMgdGhhdCB0YWtlIG1vcmUgdGhhbiBhIGZldyBzZWNvbmRzIChidWlsZHMsIHRlc3RzLCBpbnN0YWxscywgbGFyZ2UgZ2l0IG9wZXJhdGlvbnMpLlwiLFxuXHRcdFx0XCJBZnRlciBzdGFydGluZyBhc3luYyBqb2JzLCBjb250aW51ZSB3aXRoIG90aGVyIHdvcmsgYW5kIHVzZSBhd2FpdF9qb2Igd2hlbiB5b3UgbmVlZCB0aGUgcmVzdWx0cy5cIixcblx0XHRcdFwiYXdhaXRfam9iIGhhcyBhIGNvbmZpZ3VyYWJsZSB0aW1lb3V0IChkZWZhdWx0IDEyMHMpIHRvIHByZXZlbnQgaW5kZWZpbml0ZSBibG9ja2luZyBcdTIwMTQgaWYgaXQgdGltZXMgb3V0LCBqb2JzIGtlZXAgcnVubmluZyBhbmQgeW91IGNhbiBjaGVjayBhZ2FpbiBsYXRlci5cIixcblx0XHRcdFwiRm9yIGxvbmctcnVubmluZyBwcm9jZXNzZXMgKFNTSCwgZGVwbG95cywgdHJhaW5pbmcpIHRoYXQgbWF5IHRha2UgbWludXRlcyssIHByZWZlciBhc3luY19iYXNoIHdpdGggcGVyaW9kaWMgYXdhaXRfam9iIHBvbGxpbmcgb3ZlciBhIHNpbmdsZSBsb25nIGF3YWl0LlwiLFxuXHRcdFx0XCJVc2UgY2FuY2VsX2pvYiB0byBzdG9wIGEgcnVubmluZyBiYWNrZ3JvdW5kIGpvYi5cIixcblx0XHRcdFwiQ2hlY2sgL2pvYnMgdG8gc2VlIGFsbCBydW5uaW5nIGFuZCByZWNlbnQgYmFja2dyb3VuZCBqb2JzLlwiLFxuXHRcdF0sXG5cdFx0cGFyYW1ldGVyczogc2NoZW1hLFxuXHRcdGFzeW5jIGV4ZWN1dGUoX3Rvb2xDYWxsSWQsIHBhcmFtcywgX3NpZ25hbCwgX29uVXBkYXRlLCBfY3R4KSB7XG5cdFx0XHRjb25zdCBtYW5hZ2VyID0gZ2V0TWFuYWdlcigpO1xuXHRcdFx0Y29uc3QgY3dkID0gZ2V0Q3dkKCk7XG5cdFx0XHRjb25zdCB7IGNvbW1hbmQsIHRpbWVvdXQsIGxhYmVsIH0gPSBwYXJhbXM7XG5cdFx0XHRjb25zdCBzaG9ydENtZCA9IGxhYmVsID8/IChjb21tYW5kLmxlbmd0aCA+IDYwID8gY29tbWFuZC5zbGljZSgwLCA1NykgKyBcIi4uLlwiIDogY29tbWFuZCk7XG5cblx0XHRcdGNvbnN0IGpvYklkID0gbWFuYWdlci5yZWdpc3RlcihcImJhc2hcIiwgc2hvcnRDbWQsIChzaWduYWwpID0+IHtcblx0XHRcdFx0cmV0dXJuIGV4ZWN1dGVCYXNoSW5CYWNrZ3JvdW5kKGNvbW1hbmQsIGN3ZCwgc2lnbmFsLCB0aW1lb3V0KTtcblx0XHRcdH0pO1xuXG5cdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRjb250ZW50OiBbe1xuXHRcdFx0XHRcdHR5cGU6IFwidGV4dFwiLFxuXHRcdFx0XHRcdHRleHQ6IFtcblx0XHRcdFx0XHRcdGBCYWNrZ3JvdW5kIGpvYiBzdGFydGVkOiAqKiR7am9iSWR9KipgLFxuXHRcdFx0XHRcdFx0YENvbW1hbmQ6IFxcYCR7c2hvcnRDbWR9XFxgYCxcblx0XHRcdFx0XHRcdFwiXCIsXG5cdFx0XHRcdFx0XHRcIlVzZSBgYXdhaXRfam9iYCB0byBnZXQgcmVzdWx0cyB3aGVuIHJlYWR5LCBvciBgY2FuY2VsX2pvYmAgdG8gc3RvcC5cIixcblx0XHRcdFx0XHRdLmpvaW4oXCJcXG5cIiksXG5cdFx0XHRcdH1dLFxuXHRcdFx0XHRkZXRhaWxzOiB1bmRlZmluZWQsXG5cdFx0XHR9O1xuXHRcdH0sXG5cdH07XG59XG5cbi8qKlxuICogRXhlY3V0ZSBhIGJhc2ggY29tbWFuZCwgY29sbGVjdGluZyBvdXRwdXQuIFJldHVybnMgdGhlIHRleHQgcmVzdWx0LlxuICovXG5mdW5jdGlvbiBleGVjdXRlQmFzaEluQmFja2dyb3VuZChcblx0Y29tbWFuZDogc3RyaW5nLFxuXHRjd2Q6IHN0cmluZyxcblx0c2lnbmFsOiBBYm9ydFNpZ25hbCxcblx0dGltZW91dD86IG51bWJlcixcbik6IFByb21pc2U8c3RyaW5nPiB7XG5cdHJldHVybiBuZXcgUHJvbWlzZTxzdHJpbmc+KChyZXNvbHZlLCByZWplY3QpID0+IHtcblx0XHRsZXQgc2V0dGxlZCA9IGZhbHNlO1xuXHRcdGNvbnN0IHNhZmVSZXNvbHZlID0gKHZhbHVlOiBzdHJpbmcpID0+IHsgaWYgKCFzZXR0bGVkKSB7IHNldHRsZWQgPSB0cnVlOyByZXNvbHZlKHZhbHVlKTsgfSB9O1xuXHRcdGNvbnN0IHNhZmVSZWplY3QgPSAoZXJyOiB1bmtub3duKSA9PiB7IGlmICghc2V0dGxlZCkgeyBzZXR0bGVkID0gdHJ1ZTsgcmVqZWN0KGVycik7IH0gfTtcblxuXHRcdGNvbnN0IHsgc2hlbGwsIGFyZ3MgfSA9IGdldFNoZWxsQ29uZmlnKCk7XG5cdFx0Y29uc3QgcmV3cml0dGVuQ29tbWFuZCA9IHJld3JpdGVDb21tYW5kV2l0aFJ0ayhjb21tYW5kKTtcblx0XHRjb25zdCByZXNvbHZlZENvbW1hbmQgPSBzYW5pdGl6ZUNvbW1hbmQocmV3cml0dGVuQ29tbWFuZCk7XG5cblx0XHQvLyBPbiBXaW5kb3dzLCBkZXRhY2hlZDogdHJ1ZSBzZXRzIENSRUFURV9ORVdfUFJPQ0VTU19HUk9VUCB3aGljaCBjYW5cblx0XHQvLyBjYXVzZSBFSU5WQUwgaW4gVlNDb2RlL0NvblBUWSB0ZXJtaW5hbCBjb250ZXh0cy4gIFRoZSBiZy1zaGVsbFxuXHRcdC8vIGV4dGVuc2lvbiBhbHJlYWR5IGd1YXJkcyB0aGlzIChwcm9jZXNzLW1hbmFnZXIudHMpOyBhbGlnbiBoZXJlLlxuXHRcdC8vIFByb2Nlc3MtdHJlZSBjbGVhbnVwIHVzZXMgdGFza2tpbGwgL0YgL1Qgb24gV2luZG93cyByZWdhcmRsZXNzLlxuXHRcdGNvbnN0IGNoaWxkID0gc3Bhd24oc2hlbGwsIFsuLi5hcmdzLCByZXNvbHZlZENvbW1hbmRdLCB7XG5cdFx0XHRjd2QsXG5cdFx0XHRkZXRhY2hlZDogcHJvY2Vzcy5wbGF0Zm9ybSAhPT0gXCJ3aW4zMlwiLFxuXHRcdFx0ZW52OiB7IC4uLnByb2Nlc3MuZW52IH0sXG5cdFx0XHRzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0sXG5cdFx0fSk7XG5cblx0XHRsZXQgdGltZWRPdXQgPSBmYWxzZTtcblx0XHRsZXQgdGltZW91dEhhbmRsZTogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCB1bmRlZmluZWQ7XG5cdFx0bGV0IHNpZ2tpbGxIYW5kbGU6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgdW5kZWZpbmVkO1xuXHRcdGxldCBoYXJkRGVhZGxpbmVIYW5kbGU6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgdW5kZWZpbmVkO1xuXG5cdFx0LyoqIEdyYWNlIHBlcmlvZCAobXMpIGJldHdlZW4gU0lHVEVSTSBhbmQgU0lHS0lMTC4gKi9cblx0XHRjb25zdCBTSUdLSUxMX0dSQUNFX01TID0gNV8wMDA7XG5cdFx0LyoqIEhhcmQgZGVhZGxpbmUgKG1zKSBhZnRlciBTSUdLSUxMIHRvIGZvcmNlLXJlc29sdmUgdGhlIHByb21pc2UuICovXG5cdFx0Y29uc3QgSEFSRF9ERUFETElORV9NUyA9IDNfMDAwO1xuXG5cdFx0aWYgKHRpbWVvdXQgIT09IHVuZGVmaW5lZCAmJiB0aW1lb3V0ID4gMCkge1xuXHRcdFx0dGltZW91dEhhbmRsZSA9IHNldFRpbWVvdXQoKCkgPT4ge1xuXHRcdFx0XHR0aW1lZE91dCA9IHRydWU7XG5cdFx0XHRcdGlmIChjaGlsZC5waWQpIGtpbGxUcmVlKGNoaWxkLnBpZCk7XG5cblx0XHRcdFx0Ly8gSWYgdGhlIHByb2Nlc3MgaWdub3JlcyBTSUdURVJNLCBlc2NhbGF0ZSB0byBTSUdLSUxMXG5cdFx0XHRcdHNpZ2tpbGxIYW5kbGUgPSBzZXRUaW1lb3V0KCgpID0+IHtcblx0XHRcdFx0XHRpZiAoY2hpbGQucGlkKSB7XG5cdFx0XHRcdFx0XHQvLyBraWxsVHJlZSBhbHJlYWR5IHVzZXMgdGFza2tpbGwgL0YgL1Qgb24gV2luZG93c1xuXHRcdFx0XHRcdFx0a2lsbFRyZWUoY2hpbGQucGlkKTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHQvLyBIYXJkIGRlYWRsaW5lOiBpZiBldmVuIFNJR0tJTEwgZG9lc24ndCB0cmlnZ2VyICdjbG9zZScsXG5cdFx0XHRcdFx0Ly8gZm9yY2UtcmVzb2x2ZSBzbyB0aGUgam9iIGRvZXNuJ3QgaGFuZyBmb3JldmVyICgjMjE4NikuXG5cdFx0XHRcdFx0aGFyZERlYWRsaW5lSGFuZGxlID0gc2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHRcdFx0XHRjb25zdCBvdXRwdXQgPSBCdWZmZXIuY29uY2F0KGNodW5rcykudG9TdHJpbmcoXCJ1dGYtOFwiKTtcblx0XHRcdFx0XHRcdHNhZmVSZXNvbHZlKFxuXHRcdFx0XHRcdFx0XHRvdXRwdXRcblx0XHRcdFx0XHRcdFx0XHQ/IGAke291dHB1dH1cXG5cXG5Db21tYW5kIHRpbWVkIG91dCBhZnRlciAke3RpbWVvdXR9IHNlY29uZHMgKGZvcmNlLWtpbGxlZClgXG5cdFx0XHRcdFx0XHRcdFx0OiBgQ29tbWFuZCB0aW1lZCBvdXQgYWZ0ZXIgJHt0aW1lb3V0fSBzZWNvbmRzIChmb3JjZS1raWxsZWQpYCxcblx0XHRcdFx0XHRcdCk7XG5cdFx0XHRcdFx0fSwgSEFSRF9ERUFETElORV9NUyk7XG5cdFx0XHRcdFx0aWYgKHR5cGVvZiBoYXJkRGVhZGxpbmVIYW5kbGUgPT09IFwib2JqZWN0XCIgJiYgXCJ1bnJlZlwiIGluIGhhcmREZWFkbGluZUhhbmRsZSkgaGFyZERlYWRsaW5lSGFuZGxlLnVucmVmKCk7XG5cdFx0XHRcdH0sIFNJR0tJTExfR1JBQ0VfTVMpO1xuXHRcdFx0XHRpZiAodHlwZW9mIHNpZ2tpbGxIYW5kbGUgPT09IFwib2JqZWN0XCIgJiYgXCJ1bnJlZlwiIGluIHNpZ2tpbGxIYW5kbGUpIHNpZ2tpbGxIYW5kbGUudW5yZWYoKTtcblx0XHRcdH0sIHRpbWVvdXQgKiAxMDAwKTtcblx0XHR9XG5cblx0XHRjb25zdCBjaHVua3M6IEJ1ZmZlcltdID0gW107XG5cdFx0bGV0IHRvdGFsQnl0ZXMgPSAwO1xuXHRcdGxldCBzcGlsbEZpbGVQYXRoOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG5cdFx0bGV0IHNwaWxsU3RyZWFtOiBSZXR1cm5UeXBlPHR5cGVvZiBjcmVhdGVXcml0ZVN0cmVhbT4gfCB1bmRlZmluZWQ7XG5cdFx0Y29uc3QgTUFYX0JVRkZFUiA9IERFRkFVTFRfTUFYX0JZVEVTICogMjtcblxuXHRcdGNvbnN0IG9uRGF0YSA9IChkYXRhOiBCdWZmZXIpID0+IHtcblx0XHRcdHRvdGFsQnl0ZXMgKz0gZGF0YS5sZW5ndGg7XG5cblx0XHRcdGlmICh0b3RhbEJ5dGVzID4gREVGQVVMVF9NQVhfQllURVMgJiYgIXNwaWxsRmlsZVBhdGgpIHtcblx0XHRcdFx0c3BpbGxGaWxlUGF0aCA9IGdldFRlbXBGaWxlUGF0aCgpO1xuXHRcdFx0XHRzcGlsbFN0cmVhbSA9IGNyZWF0ZVdyaXRlU3RyZWFtKHNwaWxsRmlsZVBhdGgpO1xuXHRcdFx0XHRmb3IgKGNvbnN0IGNodW5rIG9mIGNodW5rcykgc3BpbGxTdHJlYW0ud3JpdGUoY2h1bmspO1xuXHRcdFx0fVxuXHRcdFx0aWYgKHNwaWxsU3RyZWFtKSBzcGlsbFN0cmVhbS53cml0ZShkYXRhKTtcblxuXHRcdFx0Y2h1bmtzLnB1c2goZGF0YSk7XG5cdFx0XHRsZXQgY2h1bmtzQnl0ZXMgPSBjaHVua3MucmVkdWNlKChzLCBjKSA9PiBzICsgYy5sZW5ndGgsIDApO1xuXHRcdFx0d2hpbGUgKGNodW5rc0J5dGVzID4gTUFYX0JVRkZFUiAmJiBjaHVua3MubGVuZ3RoID4gMSkge1xuXHRcdFx0XHRjb25zdCByZW1vdmVkID0gY2h1bmtzLnNoaWZ0KCkhO1xuXHRcdFx0XHRjaHVua3NCeXRlcyAtPSByZW1vdmVkLmxlbmd0aDtcblx0XHRcdH1cblx0XHR9O1xuXG5cdFx0aWYgKGNoaWxkLnN0ZG91dCkgY2hpbGQuc3Rkb3V0Lm9uKFwiZGF0YVwiLCBvbkRhdGEpO1xuXHRcdGlmIChjaGlsZC5zdGRlcnIpIGNoaWxkLnN0ZGVyci5vbihcImRhdGFcIiwgb25EYXRhKTtcblxuXHRcdGNvbnN0IG9uQWJvcnQgPSAoKSA9PiB7XG5cdFx0XHRpZiAoY2hpbGQucGlkKSBraWxsVHJlZShjaGlsZC5waWQpO1xuXHRcdH07XG5cblx0XHRpZiAoc2lnbmFsLmFib3J0ZWQpIHtcblx0XHRcdG9uQWJvcnQoKTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0c2lnbmFsLmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkFib3J0LCB7IG9uY2U6IHRydWUgfSk7XG5cdFx0fVxuXG5cdFx0Y2hpbGQub24oXCJlcnJvclwiLCAoZXJyKSA9PiB7XG5cdFx0XHRpZiAodGltZW91dEhhbmRsZSkgY2xlYXJUaW1lb3V0KHRpbWVvdXRIYW5kbGUpO1xuXHRcdFx0aWYgKHNpZ2tpbGxIYW5kbGUpIGNsZWFyVGltZW91dChzaWdraWxsSGFuZGxlKTtcblx0XHRcdGlmIChoYXJkRGVhZGxpbmVIYW5kbGUpIGNsZWFyVGltZW91dChoYXJkRGVhZGxpbmVIYW5kbGUpO1xuXHRcdFx0c2lnbmFsLnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkFib3J0KTtcblx0XHRcdHNhZmVSZWplY3QoZXJyKTtcblx0XHR9KTtcblxuXHRcdGNoaWxkLm9uKFwiY2xvc2VcIiwgKGNvZGUpID0+IHtcblx0XHRcdGlmICh0aW1lb3V0SGFuZGxlKSBjbGVhclRpbWVvdXQodGltZW91dEhhbmRsZSk7XG5cdFx0XHRpZiAoc2lna2lsbEhhbmRsZSkgY2xlYXJUaW1lb3V0KHNpZ2tpbGxIYW5kbGUpO1xuXHRcdFx0aWYgKGhhcmREZWFkbGluZUhhbmRsZSkgY2xlYXJUaW1lb3V0KGhhcmREZWFkbGluZUhhbmRsZSk7XG5cdFx0XHRzaWduYWwucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQWJvcnQpO1xuXHRcdFx0aWYgKHNwaWxsU3RyZWFtKSBzcGlsbFN0cmVhbS5lbmQoKTtcblxuXHRcdFx0aWYgKHNpZ25hbC5hYm9ydGVkKSB7XG5cdFx0XHRcdGNvbnN0IG91dHB1dCA9IEJ1ZmZlci5jb25jYXQoY2h1bmtzKS50b1N0cmluZyhcInV0Zi04XCIpO1xuXHRcdFx0XHRzYWZlUmVzb2x2ZShvdXRwdXQgPyBgJHtvdXRwdXR9XFxuXFxuQ29tbWFuZCBhYm9ydGVkYCA6IFwiQ29tbWFuZCBhYm9ydGVkXCIpO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cblx0XHRcdGlmICh0aW1lZE91dCkge1xuXHRcdFx0XHRjb25zdCBvdXRwdXQgPSBCdWZmZXIuY29uY2F0KGNodW5rcykudG9TdHJpbmcoXCJ1dGYtOFwiKTtcblx0XHRcdFx0c2FmZVJlc29sdmUob3V0cHV0ID8gYCR7b3V0cHV0fVxcblxcbkNvbW1hbmQgdGltZWQgb3V0IGFmdGVyICR7dGltZW91dH0gc2Vjb25kc2AgOiBgQ29tbWFuZCB0aW1lZCBvdXQgYWZ0ZXIgJHt0aW1lb3V0fSBzZWNvbmRzYCk7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgZnVsbE91dHB1dCA9IEJ1ZmZlci5jb25jYXQoY2h1bmtzKS50b1N0cmluZyhcInV0Zi04XCIpO1xuXG5cdFx0XHRjb25zdCBsaW5lcyA9IGZ1bGxPdXRwdXQuc3BsaXQoXCJcXG5cIik7XG5cdFx0XHRsZXQgdGV4dDogc3RyaW5nO1xuXHRcdFx0aWYgKGxpbmVzLmxlbmd0aCA+IERFRkFVTFRfTUFYX0xJTkVTKSB7XG5cdFx0XHRcdHRleHQgPSBsaW5lcy5zbGljZSgtREVGQVVMVF9NQVhfTElORVMpLmpvaW4oXCJcXG5cIik7XG5cdFx0XHRcdGlmIChzcGlsbEZpbGVQYXRoKSB7XG5cdFx0XHRcdFx0dGV4dCArPSBgXFxuXFxuW1Nob3dpbmcgbGFzdCAke0RFRkFVTFRfTUFYX0xJTkVTfSBvZiAke2xpbmVzLmxlbmd0aH0gbGluZXMuIEZ1bGwgb3V0cHV0OiAke3NwaWxsRmlsZVBhdGh9XWA7XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0dGV4dCArPSBgXFxuXFxuW1Nob3dpbmcgbGFzdCAke0RFRkFVTFRfTUFYX0xJTkVTfSBvZiAke2xpbmVzLmxlbmd0aH0gbGluZXNdYDtcblx0XHRcdFx0fVxuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0dGV4dCA9IGZ1bGxPdXRwdXQgfHwgXCIobm8gb3V0cHV0KVwiO1xuXHRcdFx0fVxuXG5cdFx0XHRpZiAoY29kZSAhPT0gMCAmJiBjb2RlICE9PSBudWxsKSB7XG5cdFx0XHRcdHRleHQgKz0gYFxcblxcbkNvbW1hbmQgZXhpdGVkIHdpdGggY29kZSAke2NvZGV9YDtcblx0XHRcdH1cblxuXHRcdFx0c2FmZVJlc29sdmUodGV4dCk7XG5cdFx0fSk7XG5cdH0pO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBU0E7QUFBQSxFQUNDO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDTTtBQUNQLFNBQVMsWUFBWTtBQUNyQixTQUFTLE9BQU8saUJBQWlCO0FBQ2pDLFNBQVMseUJBQXlCO0FBQ2xDLFNBQVMsY0FBYztBQUN2QixTQUFTLFlBQVk7QUFDckIsU0FBUyxtQkFBbUI7QUFFNUIsU0FBUyw2QkFBNkI7QUFFdEMsTUFBTSxTQUFTLEtBQUssT0FBTztBQUFBLEVBQzFCLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSw0Q0FBNEMsQ0FBQztBQUFBLEVBQ2pGLFNBQVMsS0FBSztBQUFBLElBQ2IsS0FBSyxPQUFPLEVBQUUsYUFBYSxnQ0FBZ0MsQ0FBQztBQUFBLEVBQzdEO0FBQUEsRUFDQSxPQUFPLEtBQUs7QUFBQSxJQUNYLEtBQUssT0FBTyxFQUFFLGFBQWEsNEZBQTRGLENBQUM7QUFBQSxFQUN6SDtBQUNELENBQUM7QUFFRCxTQUFTLGtCQUEwQjtBQUNsQyxRQUFNLEtBQUssWUFBWSxDQUFDLEVBQUUsU0FBUyxLQUFLO0FBQ3hDLFNBQU8sS0FBSyxPQUFPLEdBQUcsaUJBQWlCLEVBQUUsTUFBTTtBQUNoRDtBQU1BLFNBQVMsU0FBUyxLQUFtQjtBQUNwQyxNQUFJLFFBQVEsYUFBYSxTQUFTO0FB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
