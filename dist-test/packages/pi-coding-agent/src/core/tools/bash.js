import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { spawn } from "child_process";
import { getShellConfig, getShellEnv, killProcessTree, sanitizeCommand } from "../../utils/shell.js";
import { compileInterceptor, DEFAULT_BASH_INTERCEPTOR_RULES } from "./bash-interceptor.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail } from "./truncate.js";
let _vtHandles = null;
function restoreWindowsVTInput() {
  if (process.platform !== "win32") return;
  try {
    if (!_vtHandles) {
      const cjsRequire = createRequire(import.meta.url);
      const koffi = cjsRequire("koffi");
      const k32 = koffi.load("kernel32.dll");
      const GetStdHandle = k32.func("void* __stdcall GetStdHandle(int)");
      const GetConsoleMode = k32.func("bool __stdcall GetConsoleMode(void*, _Out_ uint32_t*)");
      const SetConsoleMode = k32.func("bool __stdcall SetConsoleMode(void*, uint32_t)");
      const handle = GetStdHandle(-10);
      _vtHandles = { GetConsoleMode, SetConsoleMode, handle };
    }
    const ENABLE_VIRTUAL_TERMINAL_INPUT = 512;
    const mode = new Uint32Array(1);
    _vtHandles.GetConsoleMode(_vtHandles.handle, mode);
    if (!(mode[0] & ENABLE_VIRTUAL_TERMINAL_INPUT)) {
      _vtHandles.SetConsoleMode(_vtHandles.handle, mode[0] | ENABLE_VIRTUAL_TERMINAL_INPUT);
    }
  } catch {
  }
}
function getTempFilePath() {
  const id = randomBytes(8).toString("hex");
  return join(tmpdir(), `pi-bash-${id}.log`);
}
function endsWithBackgroundOperator(fragment) {
  const stripped = fragment.replace(/'[^']*'/g, "''");
  return /(?<!&)&\s*(?:disown\s*)?(?:#.*)?$/.test(stripped.trim());
}
function hasOutputRedirect(segment) {
  const stripped = segment.replace(/'[^']*'/g, "''");
  return /(?<!\d)(?:>>?|&>|>&|\|)/.test(stripped);
}
function rewriteBackgroundCommand(command) {
  if (!command.includes("&")) return { command, rewritten: false };
  const segments = command.split(/(?<=[;\n])/);
  let anyRewritten = false;
  const rewrittenSegments = segments.map((segment) => {
    if (!endsWithBackgroundOperator(segment)) return segment;
    if (hasOutputRedirect(segment)) return segment;
    anyRewritten = true;
    return segment.replace(
      /(?<!&)(&\s*(?:disown\s*)?(?:#.*)?)$/,
      ">/dev/null 2>&1 $1"
    );
  });
  if (!anyRewritten) return { command, rewritten: false };
  return { command: rewrittenSegments.join(""), rewritten: true };
}
const bashSchema = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" }))
});
const defaultBashOperations = {
  exec: (command, cwd, { onData, signal, timeout, env }) => {
    return new Promise((resolve, reject) => {
      const { shell, args } = getShellConfig();
      if (!existsSync(cwd)) {
        reject(new Error(`Working directory does not exist: ${cwd}
Cannot execute bash commands.`));
        return;
      }
      const child = spawn(shell, [...args, command], {
        cwd,
        detached: process.platform !== "win32",
        env: env ?? getShellEnv(),
        stdio: ["ignore", "pipe", "pipe"]
      });
      let timedOut = false;
      let timeoutHandle;
      if (timeout !== void 0 && timeout > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          if (child.pid) {
            killProcessTree(child.pid);
          }
        }, timeout * 1e3);
      }
      if (child.stdout) {
        child.stdout.on("data", onData);
      }
      if (child.stderr) {
        child.stderr.on("data", onData);
      }
      child.on("error", (err) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (signal) signal.removeEventListener("abort", onAbort);
        reject(err);
      });
      const onAbort = () => {
        if (child.pid) {
          killProcessTree(child.pid);
        }
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }
      child.on("close", (code) => {
        restoreWindowsVTInput();
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (signal) signal.removeEventListener("abort", onAbort);
        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        if (timedOut) {
          reject(new Error(`timeout:${timeout}`));
          return;
        }
        resolve({ exitCode: code });
      });
    });
  }
};
function resolveSpawnContext(command, cwd, spawnHook) {
  const baseContext = {
    command,
    cwd,
    env: { ...getShellEnv() }
  };
  return spawnHook ? spawnHook(baseContext) : baseContext;
}
function createBashTool(cwd, options) {
  const ops = options?.operations ?? defaultBashOperations;
  const commandPrefix = options?.commandPrefix;
  const spawnHook = options?.spawnHook;
  const artifactManager = options?.artifactManager;
  const interceptorInstance = options?.interceptor?.enabled ? compileInterceptor(options.interceptor.rules ?? DEFAULT_BASH_INTERCEPTOR_RULES) : null;
  return {
    name: "bash",
    label: "bash",
    description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
    parameters: bashSchema,
    execute: async (_toolCallId, { command, timeout }, signal, onUpdate) => {
      if (interceptorInstance) {
        const toolNames = typeof options.availableToolNames === "function" ? options.availableToolNames() : options.availableToolNames ?? [];
        const interception = interceptorInstance.check(command, toolNames);
        if (interception.block) {
          return {
            content: [{ type: "text", text: interception.message ?? "Command blocked by interceptor" }],
            details: void 0
          };
        }
      }
      const bgResult = rewriteBackgroundCommand(command);
      const effectiveCommand = bgResult.command;
      if (bgResult.rewritten) {
        onUpdate?.({
          content: [{
            type: "text",
            text: "Note: Background command output redirected to /dev/null to prevent pipe hang. Use nohup or setsid for reliable detachment."
          }],
          details: void 0
        });
      }
      const resolvedCommand = sanitizeCommand(commandPrefix ? `${commandPrefix}
${effectiveCommand}` : effectiveCommand);
      const spawnContext = resolveSpawnContext(resolvedCommand, cwd, spawnHook);
      return new Promise((resolve, reject) => {
        let spillFilePath;
        let spillArtifactId;
        let spillFileStream;
        let totalBytes = 0;
        const chunks = [];
        let chunksBytes = 0;
        const maxChunksBytes = DEFAULT_MAX_BYTES * 2;
        const handleData = (data) => {
          totalBytes += data.length;
          if (totalBytes > DEFAULT_MAX_BYTES && !spillFilePath) {
            if (artifactManager) {
              const allocated = artifactManager.allocatePath("bash");
              spillFilePath = allocated.path;
              spillArtifactId = allocated.id;
            } else {
              spillFilePath = getTempFilePath();
            }
            spillFileStream = createWriteStream(spillFilePath);
            for (const chunk of chunks) {
              spillFileStream.write(chunk);
            }
          }
          if (spillFileStream) {
            spillFileStream.write(data);
          }
          chunks.push(data);
          chunksBytes += data.length;
          while (chunksBytes > maxChunksBytes && chunks.length > 1) {
            const removed = chunks.shift();
            chunksBytes -= removed.length;
          }
          if (onUpdate) {
            const fullBuffer = Buffer.concat(chunks);
            const fullText = fullBuffer.toString("utf-8");
            const truncation = truncateTail(fullText);
            onUpdate({
              content: [{ type: "text", text: truncation.content || "" }],
              details: {
                cwd: spawnContext.cwd,
                truncation: truncation.truncated ? truncation : void 0,
                fullOutputPath: spillFilePath
              }
            });
          }
        };
        ops.exec(spawnContext.command, spawnContext.cwd, {
          onData: handleData,
          signal,
          timeout,
          env: spawnContext.env
        }).then(({ exitCode }) => {
          if (spillFileStream) {
            spillFileStream.end();
          }
          const fullBuffer = Buffer.concat(chunks);
          const fullOutput = fullBuffer.toString("utf-8");
          const truncation = truncateTail(fullOutput);
          let outputText = truncation.content || "(no output)";
          let details = { cwd: spawnContext.cwd };
          if (truncation.truncated) {
            details = {
              ...details,
              truncation,
              fullOutputPath: spillFilePath,
              ...spillArtifactId ? { artifactId: spillArtifactId } : {}
            };
            const startLine = truncation.totalLines - truncation.outputLines + 1;
            const endLine = truncation.totalLines;
            const outputRef = spillArtifactId ? `artifact://${spillArtifactId}` : spillFilePath;
            if (truncation.lastLinePartial) {
              const lastLineSize = formatSize(Buffer.byteLength(fullOutput.split("\n").pop() || "", "utf-8"));
              outputText += `

[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${outputRef}]`;
            } else if (truncation.truncatedBy === "lines") {
              outputText += `

[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${outputRef}]`;
            } else {
              outputText += `

[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${outputRef}]`;
            }
          }
          if (exitCode !== 0 && exitCode !== null) {
            outputText += `

Command exited with code ${exitCode}`;
            reject(new Error(outputText));
          } else {
            resolve({ content: [{ type: "text", text: outputText }], details });
          }
        }).catch((err) => {
          if (spillFileStream) {
            spillFileStream.end();
          }
          const fullBuffer = Buffer.concat(chunks);
          let output = fullBuffer.toString("utf-8");
          if (err.message === "aborted") {
            if (output) output += "\n\n";
            output += "Command aborted";
            reject(new Error(output));
          } else if (err.message.startsWith("timeout:")) {
            const timeoutSecs = err.message.split(":")[1];
            if (output) output += "\n\n";
            output += `Command timed out after ${timeoutSecs} seconds`;
            reject(new Error(output));
          } else {
            reject(err);
          }
        });
      });
    }
  };
}
const bashTool = createBashTool(process.cwd());
export {
  bashTool,
  createBashTool,
  rewriteBackgroundCommand
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL3Rvb2xzL2Jhc2gudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IHJhbmRvbUJ5dGVzIH0gZnJvbSBcIm5vZGU6Y3J5cHRvXCI7XG5pbXBvcnQgeyBjcmVhdGVXcml0ZVN0cmVhbSwgZXhpc3RzU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBjcmVhdGVSZXF1aXJlIH0gZnJvbSBcIm5vZGU6bW9kdWxlXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB0eXBlIHsgQWdlbnRUb29sIH0gZnJvbSBcIkBnc2QvcGktYWdlbnQtY29yZVwiO1xuaW1wb3J0IHsgdHlwZSBTdGF0aWMsIFR5cGUgfSBmcm9tIFwiQHNpbmNsYWlyL3R5cGVib3hcIjtcbmltcG9ydCB7IHNwYXduIH0gZnJvbSBcImNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7IGdldFNoZWxsQ29uZmlnLCBnZXRTaGVsbEVudiwga2lsbFByb2Nlc3NUcmVlLCBzYW5pdGl6ZUNvbW1hbmQgfSBmcm9tIFwiLi4vLi4vdXRpbHMvc2hlbGwuanNcIjtcbmltcG9ydCB7IHR5cGUgQmFzaEludGVyY2VwdG9yUnVsZSwgY29tcGlsZUludGVyY2VwdG9yLCBERUZBVUxUX0JBU0hfSU5URVJDRVBUT1JfUlVMRVMgfSBmcm9tIFwiLi9iYXNoLWludGVyY2VwdG9yLmpzXCI7XG5pbXBvcnQgeyBERUZBVUxUX01BWF9CWVRFUywgREVGQVVMVF9NQVhfTElORVMsIGZvcm1hdFNpemUsIHR5cGUgVHJ1bmNhdGlvblJlc3VsdCwgdHJ1bmNhdGVUYWlsIH0gZnJvbSBcIi4vdHJ1bmNhdGUuanNcIjtcbmltcG9ydCB0eXBlIHsgQXJ0aWZhY3RNYW5hZ2VyIH0gZnJvbSBcIi4uL2FydGlmYWN0LW1hbmFnZXIuanNcIjtcblxuLy8gQ2FjaGVkIFdpbjMyIEZGSSBoYW5kbGVzIGZvciByZXN0b3JpbmcgVlQgaW5wdXQgYWZ0ZXIgY2hpbGQgcHJvY2Vzc2VzXG5sZXQgX3Z0SGFuZGxlczogeyBHZXRDb25zb2xlTW9kZTogYW55OyBTZXRDb25zb2xlTW9kZTogYW55OyBoYW5kbGU6IGFueSB9IHwgbnVsbCA9IG51bGw7XG5mdW5jdGlvbiByZXN0b3JlV2luZG93c1ZUSW5wdXQoKTogdm9pZCB7XG5cdGlmIChwcm9jZXNzLnBsYXRmb3JtICE9PSBcIndpbjMyXCIpIHJldHVybjtcblx0dHJ5IHtcblx0XHRpZiAoIV92dEhhbmRsZXMpIHtcblx0XHRcdGNvbnN0IGNqc1JlcXVpcmUgPSBjcmVhdGVSZXF1aXJlKGltcG9ydC5tZXRhLnVybCk7XG5cdFx0XHRjb25zdCBrb2ZmaSA9IGNqc1JlcXVpcmUoXCJrb2ZmaVwiKTtcblx0XHRcdGNvbnN0IGszMiA9IGtvZmZpLmxvYWQoXCJrZXJuZWwzMi5kbGxcIik7XG5cdFx0XHRjb25zdCBHZXRTdGRIYW5kbGUgPSBrMzIuZnVuYyhcInZvaWQqIF9fc3RkY2FsbCBHZXRTdGRIYW5kbGUoaW50KVwiKTtcblx0XHRcdGNvbnN0IEdldENvbnNvbGVNb2RlID0gazMyLmZ1bmMoXCJib29sIF9fc3RkY2FsbCBHZXRDb25zb2xlTW9kZSh2b2lkKiwgX091dF8gdWludDMyX3QqKVwiKTtcblx0XHRcdGNvbnN0IFNldENvbnNvbGVNb2RlID0gazMyLmZ1bmMoXCJib29sIF9fc3RkY2FsbCBTZXRDb25zb2xlTW9kZSh2b2lkKiwgdWludDMyX3QpXCIpO1xuXHRcdFx0Y29uc3QgaGFuZGxlID0gR2V0U3RkSGFuZGxlKC0xMCk7XG5cdFx0XHRfdnRIYW5kbGVzID0geyBHZXRDb25zb2xlTW9kZSwgU2V0Q29uc29sZU1vZGUsIGhhbmRsZSB9O1xuXHRcdH1cblx0XHRjb25zdCBFTkFCTEVfVklSVFVBTF9URVJNSU5BTF9JTlBVVCA9IDB4MDIwMDtcblx0XHRjb25zdCBtb2RlID0gbmV3IFVpbnQzMkFycmF5KDEpO1xuXHRcdF92dEhhbmRsZXMuR2V0Q29uc29sZU1vZGUoX3Z0SGFuZGxlcy5oYW5kbGUsIG1vZGUpO1xuXHRcdGlmICghKG1vZGVbMF0hICYgRU5BQkxFX1ZJUlRVQUxfVEVSTUlOQUxfSU5QVVQpKSB7XG5cdFx0XHRfdnRIYW5kbGVzLlNldENvbnNvbGVNb2RlKF92dEhhbmRsZXMuaGFuZGxlLCBtb2RlWzBdISB8IEVOQUJMRV9WSVJUVUFMX1RFUk1JTkFMX0lOUFVUKTtcblx0XHR9XG5cdH0gY2F0Y2ggeyAvKiBrb2ZmaSBub3QgYXZhaWxhYmxlICovIH1cbn1cblxuLyoqXG4gKiBHZW5lcmF0ZSBhIHVuaXF1ZSB0ZW1wIGZpbGUgcGF0aCBmb3IgYmFzaCBvdXRwdXRcbiAqL1xuZnVuY3Rpb24gZ2V0VGVtcEZpbGVQYXRoKCk6IHN0cmluZyB7XG5cdGNvbnN0IGlkID0gcmFuZG9tQnl0ZXMoOCkudG9TdHJpbmcoXCJoZXhcIik7XG5cdHJldHVybiBqb2luKHRtcGRpcigpLCBgcGktYmFzaC0ke2lkfS5sb2dgKTtcbn1cblxuLyoqXG4gKiBEZXRlY3Qgd2hldGhlciBhIGNvbW1hbmQgZnJhZ21lbnQgZW5kcyB3aXRoIGFuIHVucXVvdGVkICYgKGJhY2tncm91bmQgb3BlcmF0b3IpLlxuICogUmV0dXJucyB0cnVlIGZvciBwYXR0ZXJucyBsaWtlOiBgY21kICZgLCBgY21kIGFyZyAmYCwgYGNtZCAmIGRpc293bmAsIGAoY21kKSAmYC5cbiAqIFJldHVybnMgZmFsc2Ugd2hlbiAmIGFwcGVhcnMgaW5zaWRlIGEgc3RyaW5nIGxpdGVyYWwgb3IgYXMgJiYuXG4gKi9cbmZ1bmN0aW9uIGVuZHNXaXRoQmFja2dyb3VuZE9wZXJhdG9yKGZyYWdtZW50OiBzdHJpbmcpOiBib29sZWFuIHtcblx0Ly8gUmVtb3ZlIGNvbnRlbnQgaW5zaWRlIHNpbmdsZS1xdW90ZWQgc3RyaW5ncyB0byBhdm9pZCBmYWxzZSBwb3NpdGl2ZXNcblx0Y29uc3Qgc3RyaXBwZWQgPSBmcmFnbWVudC5yZXBsYWNlKC8nW14nXSonL2csIFwiJydcIik7XG5cdC8vIE1hdGNoIHRyYWlsaW5nICYgbm90IHByZWNlZGVkIGJ5IGFub3RoZXIgJiAoaS5lLiwgbm90ICYmKVxuXHRyZXR1cm4gLyg/PCEmKSZcXHMqKD86ZGlzb3duXFxzKik/KD86Iy4qKT8kLy50ZXN0KHN0cmlwcGVkLnRyaW0oKSk7XG59XG5cbi8qKlxuICogRGV0ZXJtaW5lIHdoZXRoZXIgYSBjb21tYW5kIHNlZ21lbnQgYWxyZWFkeSByZWRpcmVjdHMgc3Rkb3V0IGF3YXkgZnJvbSB0aGUgdGVybWluYWwuXG4gKiBDaGVja3MgZm9yID4sID4+LCAmPiwgfCwgL2Rldi9udWxsIHJlZGlyZWN0cy5cbiAqL1xuZnVuY3Rpb24gaGFzT3V0cHV0UmVkaXJlY3Qoc2VnbWVudDogc3RyaW5nKTogYm9vbGVhbiB7XG5cdC8vIFJlbW92ZSBzaW5nbGUtcXVvdGVkIHN0cmluZ3MgdG8gYXZvaWQgbWF0Y2hpbmcgaW5zaWRlIHRoZW1cblx0Y29uc3Qgc3RyaXBwZWQgPSBzZWdtZW50LnJlcGxhY2UoLydbXiddKicvZywgXCInJ1wiKTtcblx0Ly8gTWF0Y2ggPiwgPj4gbm90IHByZWNlZGVkIGJ5IDIgKHN0ZGVyci1vbmx5KSBcdTIwMTQgd2Ugb25seSBjYXJlIGFib3V0IHN0ZG91dFxuXHQvLyBBbHNvIG1hdGNoICY+IChjb21iaW5lZCksID4mLCBvciBhIHBpcGUgfCB3aGljaCByb3V0ZXMgc3Rkb3V0IGVsc2V3aGVyZVxuXHRyZXR1cm4gLyg/PCFcXGQpKD86Pj4/fCY+fD4mfFxcfCkvLnRlc3Qoc3RyaXBwZWQpO1xufVxuXG4vKipcbiAqIFJld3JpdGUgYSBjb21tYW5kIHRoYXQgdXNlcyAmIGZvciBiYWNrZ3JvdW5kaW5nIHNvIHRoZSBiYWNrZ3JvdW5kIHByb2Nlc3NcbiAqIGRvZXMgbm90IGluaGVyaXQgdGhlIGJhc2ggdG9vbCdzIHN0ZG91dC9zdGRlcnIgcGlwZXMuXG4gKlxuICogV2l0aG91dCB0aGlzLCBgcHl0aG9uIC1tIGh0dHAuc2VydmVyIDgwODAgJmAgY2F1c2VzIHRoZSBiYXNoIHRvb2wgdG8gaGFuZ1xuICogaW5kZWZpbml0ZWx5IGJlY2F1c2UgTm9kZS5qcyBrZWVwcyB0aGUgcGlwZSBvcGVuIHVudGlsIGV2ZXJ5IHByb2Nlc3MgdGhhdFxuICogaW5oZXJpdGVkIGl0IGV4aXRzIFx1MjAxNCBpbmNsdWRpbmcgdGhlIGxvbmctcnVubmluZyBzZXJ2ZXIuXG4gKlxuICogVGhlIHJld3JpdGUgYWRkcyBgPi9kZXYvbnVsbCAyPiYxYCBiZWZvcmUgZWFjaCAmIHdoZXJlIHN0ZG91dCBpcyBub3QgYWxyZWFkeVxuICogcmVkaXJlY3RlZCwgZW5zdXJpbmcgdGhlIGJhY2tncm91bmQgcHJvY2VzcyBkZXRhY2hlcyBmcm9tIHRoZSBwaXBlcyB3aGlsZVxuICogc3RpbGwgcHJvZHVjaW5nIGEgaHVtYW4tcmVhZGFibGUgbm90aWNlIGluIHRoZSB0b29sIG91dHB1dC5cbiAqXG4gKiBSZXR1cm5zIHsgY29tbWFuZDogc3RyaW5nOyByZXdyaXR0ZW46IGJvb2xlYW4gfS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJld3JpdGVCYWNrZ3JvdW5kQ29tbWFuZChjb21tYW5kOiBzdHJpbmcpOiB7IGNvbW1hbmQ6IHN0cmluZzsgcmV3cml0dGVuOiBib29sZWFuIH0ge1xuXHQvLyBRdWljayBwcmUtY2hlY2s6IGlmIHRoZXJlJ3Mgbm8gJiBhdCBhbGwsIHNraXAgdGhlIG1vcmUgZXhwZW5zaXZlIHByb2Nlc3Npbmdcblx0aWYgKCFjb21tYW5kLmluY2x1ZGVzKFwiJlwiKSkgcmV0dXJuIHsgY29tbWFuZCwgcmV3cml0dGVuOiBmYWxzZSB9O1xuXG5cdC8vIFNwbGl0IG9uIDsgYW5kIG5ld2xpbmVzIHRvIGhhbmRsZSBjb21wb3VuZCBjb21tYW5kcy5cblx0Ly8gV2UgcmV3cml0ZSBlYWNoIHNlZ21lbnQgaW5kZXBlbmRlbnRseS5cblx0Ly8gTm90ZTogdGhpcyBpcyBpbnRlbnRpb25hbGx5IHNpbXBsZSBhbmQgY292ZXJzIHRoZSBjb21tb24gTExNIHBhdHRlcm5zLlxuXHQvLyBJdCBkb2VzIG5vdCBhdHRlbXB0IHRvIHBhcnNlIGNvbXBsZXggbmVzdGVkIHN1YnNoZWxscy5cblx0Y29uc3Qgc2VnbWVudHMgPSBjb21tYW5kLnNwbGl0KC8oPzw9WztcXG5dKS8pO1xuXHRsZXQgYW55UmV3cml0dGVuID0gZmFsc2U7XG5cblx0Y29uc3QgcmV3cml0dGVuU2VnbWVudHMgPSBzZWdtZW50cy5tYXAoKHNlZ21lbnQpID0+IHtcblx0XHRpZiAoIWVuZHNXaXRoQmFja2dyb3VuZE9wZXJhdG9yKHNlZ21lbnQpKSByZXR1cm4gc2VnbWVudDtcblx0XHRpZiAoaGFzT3V0cHV0UmVkaXJlY3Qoc2VnbWVudCkpIHJldHVybiBzZWdtZW50O1xuXG5cdFx0YW55UmV3cml0dGVuID0gdHJ1ZTtcblx0XHQvLyBJbnNlcnQgPi9kZXYvbnVsbCAyPiYxIGJlZm9yZSB0aGUgdHJhaWxpbmcgJiAoYW5kIG9wdGlvbmFsIGRpc293bi9jb21tZW50KVxuXHRcdHJldHVybiBzZWdtZW50LnJlcGxhY2UoXG5cdFx0XHQvKD88ISYpKCZcXHMqKD86ZGlzb3duXFxzKik/KD86Iy4qKT8pJC8sXG5cdFx0XHRcIj4vZGV2L251bGwgMj4mMSAkMVwiLFxuXHRcdCk7XG5cdH0pO1xuXG5cdGlmICghYW55UmV3cml0dGVuKSByZXR1cm4geyBjb21tYW5kLCByZXdyaXR0ZW46IGZhbHNlIH07XG5cdHJldHVybiB7IGNvbW1hbmQ6IHJld3JpdHRlblNlZ21lbnRzLmpvaW4oXCJcIiksIHJld3JpdHRlbjogdHJ1ZSB9O1xufVxuXG5jb25zdCBiYXNoU2NoZW1hID0gVHlwZS5PYmplY3Qoe1xuXHRjb21tYW5kOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIkJhc2ggY29tbWFuZCB0byBleGVjdXRlXCIgfSksXG5cdHRpbWVvdXQ6IFR5cGUuT3B0aW9uYWwoVHlwZS5OdW1iZXIoeyBkZXNjcmlwdGlvbjogXCJUaW1lb3V0IGluIHNlY29uZHMgKG9wdGlvbmFsLCBubyBkZWZhdWx0IHRpbWVvdXQpXCIgfSkpLFxufSk7XG5cbmV4cG9ydCB0eXBlIEJhc2hUb29sSW5wdXQgPSBTdGF0aWM8dHlwZW9mIGJhc2hTY2hlbWE+O1xuXG5leHBvcnQgaW50ZXJmYWNlIEJhc2hUb29sRGV0YWlscyB7XG5cdGN3ZD86IHN0cmluZztcblx0dHJ1bmNhdGlvbj86IFRydW5jYXRpb25SZXN1bHQ7XG5cdGZ1bGxPdXRwdXRQYXRoPzogc3RyaW5nO1xuXHRhcnRpZmFjdElkPzogc3RyaW5nO1xufVxuXG4vKipcbiAqIFBsdWdnYWJsZSBvcGVyYXRpb25zIGZvciB0aGUgYmFzaCB0b29sLlxuICogT3ZlcnJpZGUgdGhlc2UgdG8gZGVsZWdhdGUgY29tbWFuZCBleGVjdXRpb24gdG8gcmVtb3RlIHN5c3RlbXMgKGUuZy4sIFNTSCkuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQmFzaE9wZXJhdGlvbnMge1xuXHQvKipcblx0ICogRXhlY3V0ZSBhIGNvbW1hbmQgYW5kIHN0cmVhbSBvdXRwdXQuXG5cdCAqIEBwYXJhbSBjb21tYW5kIC0gVGhlIGNvbW1hbmQgdG8gZXhlY3V0ZVxuXHQgKiBAcGFyYW0gY3dkIC0gV29ya2luZyBkaXJlY3Rvcnlcblx0ICogQHBhcmFtIG9wdGlvbnMgLSBFeGVjdXRpb24gb3B0aW9uc1xuXHQgKiBAcmV0dXJucyBQcm9taXNlIHJlc29sdmluZyB0byBleGl0IGNvZGUgKG51bGwgaWYga2lsbGVkKVxuXHQgKi9cblx0ZXhlYzogKFxuXHRcdGNvbW1hbmQ6IHN0cmluZyxcblx0XHRjd2Q6IHN0cmluZyxcblx0XHRvcHRpb25zOiB7XG5cdFx0XHRvbkRhdGE6IChkYXRhOiBCdWZmZXIpID0+IHZvaWQ7XG5cdFx0XHRzaWduYWw/OiBBYm9ydFNpZ25hbDtcblx0XHRcdHRpbWVvdXQ/OiBudW1iZXI7XG5cdFx0XHRlbnY/OiBOb2RlSlMuUHJvY2Vzc0Vudjtcblx0XHR9LFxuXHQpID0+IFByb21pc2U8eyBleGl0Q29kZTogbnVtYmVyIHwgbnVsbCB9Pjtcbn1cblxuLyoqXG4gKiBEZWZhdWx0IGJhc2ggb3BlcmF0aW9ucyB1c2luZyBsb2NhbCBzaGVsbFxuICovXG5jb25zdCBkZWZhdWx0QmFzaE9wZXJhdGlvbnM6IEJhc2hPcGVyYXRpb25zID0ge1xuXHRleGVjOiAoY29tbWFuZCwgY3dkLCB7IG9uRGF0YSwgc2lnbmFsLCB0aW1lb3V0LCBlbnYgfSkgPT4ge1xuXHRcdHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG5cdFx0XHRjb25zdCB7IHNoZWxsLCBhcmdzIH0gPSBnZXRTaGVsbENvbmZpZygpO1xuXG5cdFx0XHRpZiAoIWV4aXN0c1N5bmMoY3dkKSkge1xuXHRcdFx0XHRyZWplY3QobmV3IEVycm9yKGBXb3JraW5nIGRpcmVjdG9yeSBkb2VzIG5vdCBleGlzdDogJHtjd2R9XFxuQ2Fubm90IGV4ZWN1dGUgYmFzaCBjb21tYW5kcy5gKSk7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblxuXHRcdFx0Ly8gT24gV2luZG93cywgZGV0YWNoZWQ6IHRydWUgc2V0cyBDUkVBVEVfTkVXX1BST0NFU1NfR1JPVVAgd2hpY2ggY2FuXG5cdFx0XHQvLyBjYXVzZSBFSU5WQUwgaW4gVlNDb2RlL0NvblBUWSB0ZXJtaW5hbCBjb250ZXh0cy4gIFRoZSBiZy1zaGVsbFxuXHRcdFx0Ly8gZXh0ZW5zaW9uIGFscmVhZHkgZ3VhcmRzIHRoaXMgKHByb2Nlc3MtbWFuYWdlci50cyk7IGFsaWduIGhlcmUuXG5cdFx0XHQvLyBQcm9jZXNzLXRyZWUgY2xlYW51cCB1c2VzIHRhc2traWxsIC9GIC9UIG9uIFdpbmRvd3MgcmVnYXJkbGVzcy5cblx0XHRcdGNvbnN0IGNoaWxkID0gc3Bhd24oc2hlbGwsIFsuLi5hcmdzLCBjb21tYW5kXSwge1xuXHRcdFx0XHRjd2QsXG5cdFx0XHRcdGRldGFjaGVkOiBwcm9jZXNzLnBsYXRmb3JtICE9PSBcIndpbjMyXCIsXG5cdFx0XHRcdGVudjogZW52ID8/IGdldFNoZWxsRW52KCksXG5cdFx0XHRcdHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwicGlwZVwiXSxcblx0XHRcdH0pO1xuXG5cdFx0XHRsZXQgdGltZWRPdXQgPSBmYWxzZTtcblxuXHRcdFx0Ly8gU2V0IHRpbWVvdXQgaWYgcHJvdmlkZWRcblx0XHRcdGxldCB0aW1lb3V0SGFuZGxlOiBOb2RlSlMuVGltZW91dCB8IHVuZGVmaW5lZDtcblx0XHRcdGlmICh0aW1lb3V0ICE9PSB1bmRlZmluZWQgJiYgdGltZW91dCA+IDApIHtcblx0XHRcdFx0dGltZW91dEhhbmRsZSA9IHNldFRpbWVvdXQoKCkgPT4ge1xuXHRcdFx0XHRcdHRpbWVkT3V0ID0gdHJ1ZTtcblx0XHRcdFx0XHRpZiAoY2hpbGQucGlkKSB7XG5cdFx0XHRcdFx0XHRraWxsUHJvY2Vzc1RyZWUoY2hpbGQucGlkKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH0sIHRpbWVvdXQgKiAxMDAwKTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gU3RyZWFtIHN0ZG91dCBhbmQgc3RkZXJyXG5cdFx0XHRpZiAoY2hpbGQuc3Rkb3V0KSB7XG5cdFx0XHRcdGNoaWxkLnN0ZG91dC5vbihcImRhdGFcIiwgb25EYXRhKTtcblx0XHRcdH1cblx0XHRcdGlmIChjaGlsZC5zdGRlcnIpIHtcblx0XHRcdFx0Y2hpbGQuc3RkZXJyLm9uKFwiZGF0YVwiLCBvbkRhdGEpO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBIYW5kbGUgc2hlbGwgc3Bhd24gZXJyb3JzXG5cdFx0XHRjaGlsZC5vbihcImVycm9yXCIsIChlcnIpID0+IHtcblx0XHRcdFx0aWYgKHRpbWVvdXRIYW5kbGUpIGNsZWFyVGltZW91dCh0aW1lb3V0SGFuZGxlKTtcblx0XHRcdFx0aWYgKHNpZ25hbCkgc2lnbmFsLnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkFib3J0KTtcblx0XHRcdFx0cmVqZWN0KGVycik7XG5cdFx0XHR9KTtcblxuXHRcdFx0Ly8gSGFuZGxlIGFib3J0IHNpZ25hbCAtIGtpbGwgZW50aXJlIHByb2Nlc3MgdHJlZVxuXHRcdFx0Y29uc3Qgb25BYm9ydCA9ICgpID0+IHtcblx0XHRcdFx0aWYgKGNoaWxkLnBpZCkge1xuXHRcdFx0XHRcdGtpbGxQcm9jZXNzVHJlZShjaGlsZC5waWQpO1xuXHRcdFx0XHR9XG5cdFx0XHR9O1xuXG5cdFx0XHRpZiAoc2lnbmFsKSB7XG5cdFx0XHRcdGlmIChzaWduYWwuYWJvcnRlZCkge1xuXHRcdFx0XHRcdG9uQWJvcnQoKTtcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRzaWduYWwuYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQWJvcnQsIHsgb25jZTogdHJ1ZSB9KTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHQvLyBIYW5kbGUgcHJvY2VzcyBleGl0XG5cdFx0XHRjaGlsZC5vbihcImNsb3NlXCIsIChjb2RlKSA9PiB7XG5cdFx0XHRcdHJlc3RvcmVXaW5kb3dzVlRJbnB1dCgpO1xuXHRcdFx0XHRpZiAodGltZW91dEhhbmRsZSkgY2xlYXJUaW1lb3V0KHRpbWVvdXRIYW5kbGUpO1xuXHRcdFx0XHRpZiAoc2lnbmFsKSBzaWduYWwucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQWJvcnQpO1xuXG5cdFx0XHRcdGlmIChzaWduYWw/LmFib3J0ZWQpIHtcblx0XHRcdFx0XHRyZWplY3QobmV3IEVycm9yKFwiYWJvcnRlZFwiKSk7XG5cdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0aWYgKHRpbWVkT3V0KSB7XG5cdFx0XHRcdFx0cmVqZWN0KG5ldyBFcnJvcihgdGltZW91dDoke3RpbWVvdXR9YCkpO1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdHJlc29sdmUoeyBleGl0Q29kZTogY29kZSB9KTtcblx0XHRcdH0pO1xuXHRcdH0pO1xuXHR9LFxufTtcblxuZXhwb3J0IGludGVyZmFjZSBCYXNoU3Bhd25Db250ZXh0IHtcblx0Y29tbWFuZDogc3RyaW5nO1xuXHRjd2Q6IHN0cmluZztcblx0ZW52OiBOb2RlSlMuUHJvY2Vzc0Vudjtcbn1cblxuZXhwb3J0IHR5cGUgQmFzaFNwYXduSG9vayA9IChjb250ZXh0OiBCYXNoU3Bhd25Db250ZXh0KSA9PiBCYXNoU3Bhd25Db250ZXh0O1xuXG5mdW5jdGlvbiByZXNvbHZlU3Bhd25Db250ZXh0KGNvbW1hbmQ6IHN0cmluZywgY3dkOiBzdHJpbmcsIHNwYXduSG9vaz86IEJhc2hTcGF3bkhvb2spOiBCYXNoU3Bhd25Db250ZXh0IHtcblx0Y29uc3QgYmFzZUNvbnRleHQ6IEJhc2hTcGF3bkNvbnRleHQgPSB7XG5cdFx0Y29tbWFuZCxcblx0XHRjd2QsXG5cdFx0ZW52OiB7IC4uLmdldFNoZWxsRW52KCkgfSxcblx0fTtcblxuXHRyZXR1cm4gc3Bhd25Ib29rID8gc3Bhd25Ib29rKGJhc2VDb250ZXh0KSA6IGJhc2VDb250ZXh0O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEJhc2hUb29sT3B0aW9ucyB7XG5cdC8qKiBDdXN0b20gb3BlcmF0aW9ucyBmb3IgY29tbWFuZCBleGVjdXRpb24uIERlZmF1bHQ6IGxvY2FsIHNoZWxsICovXG5cdG9wZXJhdGlvbnM/OiBCYXNoT3BlcmF0aW9ucztcblx0LyoqIENvbW1hbmQgcHJlZml4IHByZXBlbmRlZCB0byBldmVyeSBjb21tYW5kIChlLmcuLCBcInNob3B0IC1zIGV4cGFuZF9hbGlhc2VzXCIgZm9yIGFsaWFzIHN1cHBvcnQpICovXG5cdGNvbW1hbmRQcmVmaXg/OiBzdHJpbmc7XG5cdC8qKiBIb29rIHRvIGFkanVzdCBjb21tYW5kLCBjd2QsIG9yIGVudiBiZWZvcmUgZXhlY3V0aW9uICovXG5cdHNwYXduSG9vaz86IEJhc2hTcGF3bkhvb2s7XG5cdC8qKiBTZXNzaW9uLXNjb3BlZCBhcnRpZmFjdCBzdG9yYWdlLiBXaGVuIHByb3ZpZGVkLCBzcGlsbHMgdG8gYXJ0aWZhY3QgZmlsZXMgaW5zdGVhZCBvZiB0ZW1wIGZpbGVzLiAqL1xuXHRhcnRpZmFjdE1hbmFnZXI/OiBBcnRpZmFjdE1hbmFnZXI7XG5cdC8qKiBCYXNoIGludGVyY2VwdG9yIGNvbmZpZ3VyYXRpb24gXHUyMDE0IGJsb2NrcyBjb21tYW5kcyB0aGF0IGR1cGxpY2F0ZSBkZWRpY2F0ZWQgdG9vbHMgKi9cblx0aW50ZXJjZXB0b3I/OiB7XG5cdFx0ZW5hYmxlZDogYm9vbGVhbjtcblx0XHRydWxlcz86IEJhc2hJbnRlcmNlcHRvclJ1bGVbXTtcblx0fTtcblx0LyoqIFRvb2wgbmFtZXMgYXZhaWxhYmxlIGluIHRoZSBzZXNzaW9uLCB1c2VkIGJ5IHRoZSBpbnRlcmNlcHRvciB0byBjaGVjayBpZiByZXBsYWNlbWVudCB0b29scyBleGlzdCAqL1xuXHRhdmFpbGFibGVUb29sTmFtZXM/OiBzdHJpbmdbXSB8ICgoKSA9PiBzdHJpbmdbXSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVCYXNoVG9vbChjd2Q6IHN0cmluZywgb3B0aW9ucz86IEJhc2hUb29sT3B0aW9ucyk6IEFnZW50VG9vbDx0eXBlb2YgYmFzaFNjaGVtYT4ge1xuXHRjb25zdCBvcHMgPSBvcHRpb25zPy5vcGVyYXRpb25zID8/IGRlZmF1bHRCYXNoT3BlcmF0aW9ucztcblx0Y29uc3QgY29tbWFuZFByZWZpeCA9IG9wdGlvbnM/LmNvbW1hbmRQcmVmaXg7XG5cdGNvbnN0IHNwYXduSG9vayA9IG9wdGlvbnM/LnNwYXduSG9vaztcblx0Y29uc3QgYXJ0aWZhY3RNYW5hZ2VyID0gb3B0aW9ucz8uYXJ0aWZhY3RNYW5hZ2VyO1xuXG5cdC8vIFByZS1jb21waWxlIGludGVyY2VwdG9yIHJ1bGVzIG9uY2UgYXQgY29uc3RydWN0aW9uIHRpbWVcblx0Y29uc3QgaW50ZXJjZXB0b3JJbnN0YW5jZSA9XG5cdFx0b3B0aW9ucz8uaW50ZXJjZXB0b3I/LmVuYWJsZWRcblx0XHRcdD8gY29tcGlsZUludGVyY2VwdG9yKG9wdGlvbnMuaW50ZXJjZXB0b3IucnVsZXMgPz8gREVGQVVMVF9CQVNIX0lOVEVSQ0VQVE9SX1JVTEVTKVxuXHRcdFx0OiBudWxsO1xuXG5cdHJldHVybiB7XG5cdFx0bmFtZTogXCJiYXNoXCIsXG5cdFx0bGFiZWw6IFwiYmFzaFwiLFxuXHRcdGRlc2NyaXB0aW9uOiBgRXhlY3V0ZSBhIGJhc2ggY29tbWFuZCBpbiB0aGUgY3VycmVudCB3b3JraW5nIGRpcmVjdG9yeS4gUmV0dXJucyBzdGRvdXQgYW5kIHN0ZGVyci4gT3V0cHV0IGlzIHRydW5jYXRlZCB0byBsYXN0ICR7REVGQVVMVF9NQVhfTElORVN9IGxpbmVzIG9yICR7REVGQVVMVF9NQVhfQllURVMgLyAxMDI0fUtCICh3aGljaGV2ZXIgaXMgaGl0IGZpcnN0KS4gSWYgdHJ1bmNhdGVkLCBmdWxsIG91dHB1dCBpcyBzYXZlZCB0byBhIHRlbXAgZmlsZS4gT3B0aW9uYWxseSBwcm92aWRlIGEgdGltZW91dCBpbiBzZWNvbmRzLmAsXG5cdFx0cGFyYW1ldGVyczogYmFzaFNjaGVtYSxcblx0XHRleGVjdXRlOiBhc3luYyAoXG5cdFx0XHRfdG9vbENhbGxJZDogc3RyaW5nLFxuXHRcdFx0eyBjb21tYW5kLCB0aW1lb3V0IH06IHsgY29tbWFuZDogc3RyaW5nOyB0aW1lb3V0PzogbnVtYmVyIH0sXG5cdFx0XHRzaWduYWw/OiBBYm9ydFNpZ25hbCxcblx0XHRcdG9uVXBkYXRlPyxcblx0XHQpID0+IHtcblx0XHRcdC8vIENoZWNrIGJhc2ggaW50ZXJjZXB0b3IgXHUyMDE0IGJsb2NrIGNvbW1hbmRzIHRoYXQgZHVwbGljYXRlIGRlZGljYXRlZCB0b29sc1xuXHRcdFx0aWYgKGludGVyY2VwdG9ySW5zdGFuY2UpIHtcblx0XHRcdFx0Y29uc3QgdG9vbE5hbWVzID1cblx0XHRcdFx0XHR0eXBlb2Ygb3B0aW9ucyEuYXZhaWxhYmxlVG9vbE5hbWVzID09PSBcImZ1bmN0aW9uXCJcblx0XHRcdFx0XHRcdD8gb3B0aW9ucyEuYXZhaWxhYmxlVG9vbE5hbWVzKClcblx0XHRcdFx0XHRcdDogb3B0aW9ucyEuYXZhaWxhYmxlVG9vbE5hbWVzID8/IFtdO1xuXHRcdFx0XHRjb25zdCBpbnRlcmNlcHRpb24gPSBpbnRlcmNlcHRvckluc3RhbmNlLmNoZWNrKGNvbW1hbmQsIHRvb2xOYW1lcyk7XG5cdFx0XHRcdGlmIChpbnRlcmNlcHRpb24uYmxvY2spIHtcblx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IGludGVyY2VwdGlvbi5tZXNzYWdlID8/IFwiQ29tbWFuZCBibG9ja2VkIGJ5IGludGVyY2VwdG9yXCIgfV0sXG5cdFx0XHRcdFx0XHRkZXRhaWxzOiB1bmRlZmluZWQsXG5cdFx0XHRcdFx0fTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHQvLyBSZXdyaXRlIGJhY2tncm91bmQgY29tbWFuZHMgKCYpIHRvIHJlZGlyZWN0IG91dHB1dCBhd2F5IGZyb20gdGhlIHBpcGVzLlxuXHRcdFx0Ly8gV2l0aG91dCB0aGlzLCBgY21kICZgIGNhdXNlcyB0aGUgdG9vbCB0byBoYW5nIGJlY2F1c2UgdGhlIGJhY2tncm91bmRcblx0XHRcdC8vIHByb2Nlc3MgaW5oZXJpdHMgdGhlIHBpcGVkIHN0ZG91dC9zdGRlcnIgYW5kIGtlZXBzIHRoZW0gb3BlbiBpbmRlZmluaXRlbHkuXG5cdFx0XHRjb25zdCBiZ1Jlc3VsdCA9IHJld3JpdGVCYWNrZ3JvdW5kQ29tbWFuZChjb21tYW5kKTtcblx0XHRcdGNvbnN0IGVmZmVjdGl2ZUNvbW1hbmQgPSBiZ1Jlc3VsdC5jb21tYW5kO1xuXHRcdFx0aWYgKGJnUmVzdWx0LnJld3JpdHRlbikge1xuXHRcdFx0XHQvLyBTdXJmYWNlIGEgYnJpZWYgYWR2aXNvcnkgc28gdGhlIExMTSBrbm93cyB3aGF0IGhhcHBlbmVkLlxuXHRcdFx0XHQvLyBUaGUgcmV3cml0ZSBpcyB0cmFuc3BhcmVudCBmb3IgdGhlIGNvbW1vbiBjYXNlOyBleHBsaWNpdCBkZXRhY2htZW50XG5cdFx0XHRcdC8vIChub2h1cCwgc3RhcnRfbmV3X3Nlc3Npb24pIGlzIHByZWZlcnJlZCBmb3Igcm9idXN0bmVzcy5cblx0XHRcdFx0b25VcGRhdGU/Lih7XG5cdFx0XHRcdFx0Y29udGVudDogW3tcblx0XHRcdFx0XHRcdHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LFxuXHRcdFx0XHRcdFx0dGV4dDogXCJOb3RlOiBCYWNrZ3JvdW5kIGNvbW1hbmQgb3V0cHV0IHJlZGlyZWN0ZWQgdG8gL2Rldi9udWxsIHRvIHByZXZlbnQgcGlwZSBoYW5nLiBVc2Ugbm9odXAgb3Igc2V0c2lkIGZvciByZWxpYWJsZSBkZXRhY2htZW50LlwiLFxuXHRcdFx0XHRcdH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IHVuZGVmaW5lZCxcblx0XHRcdFx0fSk7XG5cdFx0XHR9XG5cdFx0XHQvLyBBcHBseSBjb21tYW5kIHByZWZpeCBpZiBjb25maWd1cmVkIChlLmcuLCBcInNob3B0IC1zIGV4cGFuZF9hbGlhc2VzXCIgZm9yIGFsaWFzIHN1cHBvcnQpXG5cdFx0XHRjb25zdCByZXNvbHZlZENvbW1hbmQgPSBzYW5pdGl6ZUNvbW1hbmQoY29tbWFuZFByZWZpeCA/IGAke2NvbW1hbmRQcmVmaXh9XFxuJHtlZmZlY3RpdmVDb21tYW5kfWAgOiBlZmZlY3RpdmVDb21tYW5kKTtcblx0XHRcdGNvbnN0IHNwYXduQ29udGV4dCA9IHJlc29sdmVTcGF3bkNvbnRleHQocmVzb2x2ZWRDb21tYW5kLCBjd2QsIHNwYXduSG9vayk7XG5cblx0XHRcdHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG5cdFx0XHRcdC8vIFdlJ2xsIHN0cmVhbSB0byBhIGZpbGUgaWYgb3V0cHV0IGdldHMgbGFyZ2Vcblx0XHRcdFx0bGV0IHNwaWxsRmlsZVBhdGg6IHN0cmluZyB8IHVuZGVmaW5lZDtcblx0XHRcdFx0bGV0IHNwaWxsQXJ0aWZhY3RJZDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuXHRcdFx0XHRsZXQgc3BpbGxGaWxlU3RyZWFtOiBSZXR1cm5UeXBlPHR5cGVvZiBjcmVhdGVXcml0ZVN0cmVhbT4gfCB1bmRlZmluZWQ7XG5cdFx0XHRcdGxldCB0b3RhbEJ5dGVzID0gMDtcblxuXHRcdFx0XHQvLyBLZWVwIGEgcm9sbGluZyBidWZmZXIgb2YgdGhlIGxhc3QgY2h1bmsgZm9yIHRhaWwgdHJ1bmNhdGlvblxuXHRcdFx0XHRjb25zdCBjaHVua3M6IEJ1ZmZlcltdID0gW107XG5cdFx0XHRcdGxldCBjaHVua3NCeXRlcyA9IDA7XG5cdFx0XHRcdC8vIEtlZXAgbW9yZSB0aGFuIHdlIG5lZWQgc28gd2UgaGF2ZSBlbm91Z2ggZm9yIHRydW5jYXRpb25cblx0XHRcdFx0Y29uc3QgbWF4Q2h1bmtzQnl0ZXMgPSBERUZBVUxUX01BWF9CWVRFUyAqIDI7XG5cblx0XHRcdFx0Y29uc3QgaGFuZGxlRGF0YSA9IChkYXRhOiBCdWZmZXIpID0+IHtcblx0XHRcdFx0XHR0b3RhbEJ5dGVzICs9IGRhdGEubGVuZ3RoO1xuXG5cdFx0XHRcdFx0Ly8gU3RhcnQgd3JpdGluZyB0byBmaWxlIG9uY2Ugd2UgZXhjZWVkIHRoZSB0aHJlc2hvbGRcblx0XHRcdFx0XHRpZiAodG90YWxCeXRlcyA+IERFRkFVTFRfTUFYX0JZVEVTICYmICFzcGlsbEZpbGVQYXRoKSB7XG5cdFx0XHRcdFx0XHRpZiAoYXJ0aWZhY3RNYW5hZ2VyKSB7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IGFsbG9jYXRlZCA9IGFydGlmYWN0TWFuYWdlci5hbGxvY2F0ZVBhdGgoXCJiYXNoXCIpO1xuXHRcdFx0XHRcdFx0XHRzcGlsbEZpbGVQYXRoID0gYWxsb2NhdGVkLnBhdGg7XG5cdFx0XHRcdFx0XHRcdHNwaWxsQXJ0aWZhY3RJZCA9IGFsbG9jYXRlZC5pZDtcblx0XHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHRcdHNwaWxsRmlsZVBhdGggPSBnZXRUZW1wRmlsZVBhdGgoKTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdHNwaWxsRmlsZVN0cmVhbSA9IGNyZWF0ZVdyaXRlU3RyZWFtKHNwaWxsRmlsZVBhdGgpO1xuXHRcdFx0XHRcdFx0Ly8gV3JpdGUgYWxsIGJ1ZmZlcmVkIGNodW5rcyB0byB0aGUgZmlsZVxuXHRcdFx0XHRcdFx0Zm9yIChjb25zdCBjaHVuayBvZiBjaHVua3MpIHtcblx0XHRcdFx0XHRcdFx0c3BpbGxGaWxlU3RyZWFtLndyaXRlKGNodW5rKTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHQvLyBXcml0ZSB0byB0ZW1wIGZpbGUgaWYgd2UgaGF2ZSBvbmVcblx0XHRcdFx0XHRpZiAoc3BpbGxGaWxlU3RyZWFtKSB7XG5cdFx0XHRcdFx0XHRzcGlsbEZpbGVTdHJlYW0ud3JpdGUoZGF0YSk7XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Ly8gS2VlcCByb2xsaW5nIGJ1ZmZlciBvZiByZWNlbnQgZGF0YVxuXHRcdFx0XHRcdGNodW5rcy5wdXNoKGRhdGEpO1xuXHRcdFx0XHRcdGNodW5rc0J5dGVzICs9IGRhdGEubGVuZ3RoO1xuXG5cdFx0XHRcdFx0Ly8gVHJpbSBvbGQgY2h1bmtzIGlmIGJ1ZmZlciBpcyB0b28gbGFyZ2Vcblx0XHRcdFx0XHR3aGlsZSAoY2h1bmtzQnl0ZXMgPiBtYXhDaHVua3NCeXRlcyAmJiBjaHVua3MubGVuZ3RoID4gMSkge1xuXHRcdFx0XHRcdFx0Y29uc3QgcmVtb3ZlZCA9IGNodW5rcy5zaGlmdCgpITtcblx0XHRcdFx0XHRcdGNodW5rc0J5dGVzIC09IHJlbW92ZWQubGVuZ3RoO1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdC8vIFN0cmVhbSBwYXJ0aWFsIG91dHB1dCB0byBjYWxsYmFjayAodHJ1bmNhdGVkIHJvbGxpbmcgYnVmZmVyKVxuXHRcdFx0XHRcdGlmIChvblVwZGF0ZSkge1xuXHRcdFx0XHRcdFx0Y29uc3QgZnVsbEJ1ZmZlciA9IEJ1ZmZlci5jb25jYXQoY2h1bmtzKTtcblx0XHRcdFx0XHRcdGNvbnN0IGZ1bGxUZXh0ID0gZnVsbEJ1ZmZlci50b1N0cmluZyhcInV0Zi04XCIpO1xuXHRcdFx0XHRcdFx0Y29uc3QgdHJ1bmNhdGlvbiA9IHRydW5jYXRlVGFpbChmdWxsVGV4dCk7XG5cdFx0XHRcdFx0XHRvblVwZGF0ZSh7XG5cdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiB0cnVuY2F0aW9uLmNvbnRlbnQgfHwgXCJcIiB9XSxcblx0XHRcdFx0XHRcdFx0ZGV0YWlsczoge1xuXHRcdFx0XHRcdFx0XHRcdGN3ZDogc3Bhd25Db250ZXh0LmN3ZCxcblx0XHRcdFx0XHRcdFx0XHR0cnVuY2F0aW9uOiB0cnVuY2F0aW9uLnRydW5jYXRlZCA/IHRydW5jYXRpb24gOiB1bmRlZmluZWQsXG5cdFx0XHRcdFx0XHRcdFx0ZnVsbE91dHB1dFBhdGg6IHNwaWxsRmlsZVBhdGgsXG5cdFx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH07XG5cblx0XHRcdFx0b3BzLmV4ZWMoc3Bhd25Db250ZXh0LmNvbW1hbmQsIHNwYXduQ29udGV4dC5jd2QsIHtcblx0XHRcdFx0XHRvbkRhdGE6IGhhbmRsZURhdGEsXG5cdFx0XHRcdFx0c2lnbmFsLFxuXHRcdFx0XHRcdHRpbWVvdXQsXG5cdFx0XHRcdFx0ZW52OiBzcGF3bkNvbnRleHQuZW52LFxuXHRcdFx0XHR9KVxuXHRcdFx0XHRcdC50aGVuKCh7IGV4aXRDb2RlIH0pID0+IHtcblx0XHRcdFx0XHRcdC8vIENsb3NlIHRlbXAgZmlsZSBzdHJlYW1cblx0XHRcdFx0XHRcdGlmIChzcGlsbEZpbGVTdHJlYW0pIHtcblx0XHRcdFx0XHRcdFx0c3BpbGxGaWxlU3RyZWFtLmVuZCgpO1xuXHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHQvLyBDb21iaW5lIGFsbCBidWZmZXJlZCBjaHVua3Ncblx0XHRcdFx0XHRcdGNvbnN0IGZ1bGxCdWZmZXIgPSBCdWZmZXIuY29uY2F0KGNodW5rcyk7XG5cdFx0XHRcdFx0XHRjb25zdCBmdWxsT3V0cHV0ID0gZnVsbEJ1ZmZlci50b1N0cmluZyhcInV0Zi04XCIpO1xuXG5cdFx0XHRcdFx0XHQvLyBBcHBseSB0YWlsIHRydW5jYXRpb25cblx0XHRcdFx0XHRcdGNvbnN0IHRydW5jYXRpb24gPSB0cnVuY2F0ZVRhaWwoZnVsbE91dHB1dCk7XG5cdFx0XHRcdFx0XHRsZXQgb3V0cHV0VGV4dCA9IHRydW5jYXRpb24uY29udGVudCB8fCBcIihubyBvdXRwdXQpXCI7XG5cblx0XHRcdFx0XHRcdC8vIEJ1aWxkIGRldGFpbHMgd2l0aCB0cnVuY2F0aW9uIGluZm9cblx0XHRcdFx0XHRcdGxldCBkZXRhaWxzOiBCYXNoVG9vbERldGFpbHMgfCB1bmRlZmluZWQgPSB7IGN3ZDogc3Bhd25Db250ZXh0LmN3ZCB9O1xuXG5cdFx0XHRcdFx0XHRpZiAodHJ1bmNhdGlvbi50cnVuY2F0ZWQpIHtcblx0XHRcdFx0XHRcdFx0ZGV0YWlscyA9IHtcblx0XHRcdFx0XHRcdFx0XHQuLi5kZXRhaWxzLFxuXHRcdFx0XHRcdFx0XHRcdHRydW5jYXRpb24sXG5cdFx0XHRcdFx0XHRcdFx0ZnVsbE91dHB1dFBhdGg6IHNwaWxsRmlsZVBhdGgsXG5cdFx0XHRcdFx0XHRcdFx0Li4uKHNwaWxsQXJ0aWZhY3RJZCA/IHsgYXJ0aWZhY3RJZDogc3BpbGxBcnRpZmFjdElkIH0gOiB7fSksXG5cdFx0XHRcdFx0XHRcdH07XG5cblx0XHRcdFx0XHRcdFx0Ly8gQnVpbGQgYWN0aW9uYWJsZSBub3RpY2Vcblx0XHRcdFx0XHRcdFx0Y29uc3Qgc3RhcnRMaW5lID0gdHJ1bmNhdGlvbi50b3RhbExpbmVzIC0gdHJ1bmNhdGlvbi5vdXRwdXRMaW5lcyArIDE7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IGVuZExpbmUgPSB0cnVuY2F0aW9uLnRvdGFsTGluZXM7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IG91dHB1dFJlZiA9IHNwaWxsQXJ0aWZhY3RJZCA/IGBhcnRpZmFjdDovLyR7c3BpbGxBcnRpZmFjdElkfWAgOiBzcGlsbEZpbGVQYXRoO1xuXG5cdFx0XHRcdFx0XHRcdGlmICh0cnVuY2F0aW9uLmxhc3RMaW5lUGFydGlhbCkge1xuXHRcdFx0XHRcdFx0XHRcdGNvbnN0IGxhc3RMaW5lU2l6ZSA9IGZvcm1hdFNpemUoQnVmZmVyLmJ5dGVMZW5ndGgoZnVsbE91dHB1dC5zcGxpdChcIlxcblwiKS5wb3AoKSB8fCBcIlwiLCBcInV0Zi04XCIpKTtcblx0XHRcdFx0XHRcdFx0XHRvdXRwdXRUZXh0ICs9IGBcXG5cXG5bU2hvd2luZyBsYXN0ICR7Zm9ybWF0U2l6ZSh0cnVuY2F0aW9uLm91dHB1dEJ5dGVzKX0gb2YgbGluZSAke2VuZExpbmV9IChsaW5lIGlzICR7bGFzdExpbmVTaXplfSkuIEZ1bGwgb3V0cHV0OiAke291dHB1dFJlZn1dYDtcblx0XHRcdFx0XHRcdFx0fSBlbHNlIGlmICh0cnVuY2F0aW9uLnRydW5jYXRlZEJ5ID09PSBcImxpbmVzXCIpIHtcblx0XHRcdFx0XHRcdFx0XHRvdXRwdXRUZXh0ICs9IGBcXG5cXG5bU2hvd2luZyBsaW5lcyAke3N0YXJ0TGluZX0tJHtlbmRMaW5lfSBvZiAke3RydW5jYXRpb24udG90YWxMaW5lc30uIEZ1bGwgb3V0cHV0OiAke291dHB1dFJlZn1dYDtcblx0XHRcdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdFx0XHRvdXRwdXRUZXh0ICs9IGBcXG5cXG5bU2hvd2luZyBsaW5lcyAke3N0YXJ0TGluZX0tJHtlbmRMaW5lfSBvZiAke3RydW5jYXRpb24udG90YWxMaW5lc30gKCR7Zm9ybWF0U2l6ZShERUZBVUxUX01BWF9CWVRFUyl9IGxpbWl0KS4gRnVsbCBvdXRwdXQ6ICR7b3V0cHV0UmVmfV1gO1xuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdGlmIChleGl0Q29kZSAhPT0gMCAmJiBleGl0Q29kZSAhPT0gbnVsbCkge1xuXHRcdFx0XHRcdFx0XHRvdXRwdXRUZXh0ICs9IGBcXG5cXG5Db21tYW5kIGV4aXRlZCB3aXRoIGNvZGUgJHtleGl0Q29kZX1gO1xuXHRcdFx0XHRcdFx0XHRyZWplY3QobmV3IEVycm9yKG91dHB1dFRleHQpKTtcblx0XHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHRcdHJlc29sdmUoeyBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogb3V0cHV0VGV4dCB9XSwgZGV0YWlscyB9KTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9KVxuXHRcdFx0XHRcdC5jYXRjaCgoZXJyOiBFcnJvcikgPT4ge1xuXHRcdFx0XHRcdFx0Ly8gQ2xvc2UgdGVtcCBmaWxlIHN0cmVhbVxuXHRcdFx0XHRcdFx0aWYgKHNwaWxsRmlsZVN0cmVhbSkge1xuXHRcdFx0XHRcdFx0XHRzcGlsbEZpbGVTdHJlYW0uZW5kKCk7XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdC8vIENvbWJpbmUgYWxsIGJ1ZmZlcmVkIGNodW5rcyBmb3IgZXJyb3Igb3V0cHV0XG5cdFx0XHRcdFx0XHRjb25zdCBmdWxsQnVmZmVyID0gQnVmZmVyLmNvbmNhdChjaHVua3MpO1xuXHRcdFx0XHRcdFx0bGV0IG91dHB1dCA9IGZ1bGxCdWZmZXIudG9TdHJpbmcoXCJ1dGYtOFwiKTtcblxuXHRcdFx0XHRcdFx0aWYgKGVyci5tZXNzYWdlID09PSBcImFib3J0ZWRcIikge1xuXHRcdFx0XHRcdFx0XHRpZiAob3V0cHV0KSBvdXRwdXQgKz0gXCJcXG5cXG5cIjtcblx0XHRcdFx0XHRcdFx0b3V0cHV0ICs9IFwiQ29tbWFuZCBhYm9ydGVkXCI7XG5cdFx0XHRcdFx0XHRcdHJlamVjdChuZXcgRXJyb3Iob3V0cHV0KSk7XG5cdFx0XHRcdFx0XHR9IGVsc2UgaWYgKGVyci5tZXNzYWdlLnN0YXJ0c1dpdGgoXCJ0aW1lb3V0OlwiKSkge1xuXHRcdFx0XHRcdFx0XHRjb25zdCB0aW1lb3V0U2VjcyA9IGVyci5tZXNzYWdlLnNwbGl0KFwiOlwiKVsxXTtcblx0XHRcdFx0XHRcdFx0aWYgKG91dHB1dCkgb3V0cHV0ICs9IFwiXFxuXFxuXCI7XG5cdFx0XHRcdFx0XHRcdG91dHB1dCArPSBgQ29tbWFuZCB0aW1lZCBvdXQgYWZ0ZXIgJHt0aW1lb3V0U2Vjc30gc2Vjb25kc2A7XG5cdFx0XHRcdFx0XHRcdHJlamVjdChuZXcgRXJyb3Iob3V0cHV0KSk7XG5cdFx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0XHRyZWplY3QoZXJyKTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9KTtcblx0XHRcdH0pO1xuXHRcdH0sXG5cdH07XG59XG5cbi8qKiBEZWZhdWx0IGJhc2ggdG9vbCB1c2luZyBwcm9jZXNzLmN3ZCgpIC0gZm9yIGJhY2t3YXJkcyBjb21wYXRpYmlsaXR5ICovXG5leHBvcnQgY29uc3QgYmFzaFRvb2wgPSBjcmVhdGVCYXNoVG9vbChwcm9jZXNzLmN3ZCgpKTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFNBQVMsbUJBQW1CO0FBQzVCLFNBQVMsbUJBQW1CLGtCQUFrQjtBQUM5QyxTQUFTLHFCQUFxQjtBQUM5QixTQUFTLGNBQWM7QUFDdkIsU0FBUyxZQUFZO0FBRXJCLFNBQXNCLFlBQVk7QUFDbEMsU0FBUyxhQUFhO0FBQ3RCLFNBQVMsZ0JBQWdCLGFBQWEsaUJBQWlCLHVCQUF1QjtBQUM5RSxTQUFtQyxvQkFBb0Isc0NBQXNDO0FBQzdGLFNBQVMsbUJBQW1CLG1CQUFtQixZQUFtQyxvQkFBb0I7QUFJdEcsSUFBSSxhQUErRTtBQUNuRixTQUFTLHdCQUE4QjtBQUN0QyxNQUFJLFFBQVEsYUFBYSxRQUFTO0FBQ2xDLE1BQUk7QUFDSCxRQUFJLENBQUMsWUFBWTtBQUNoQixZQUFNLGFBQWEsY0FBYyxZQUFZLEdBQUc7QUFDaEQsWUFBTSxRQUFRLFdBQVcsT0FBTztBQUNoQyxZQUFNLE1BQU0sTUFBTSxLQUFLLGNBQWM7QUFDckMsWUFBTSxlQUFlLElBQUksS0FBSyxtQ0FBbUM7QUFDakUsWUFBTSxpQkFBaUIsSUFBSSxLQUFLLHVEQUF1RDtBQUN2RixZQUFNLGlCQUFpQixJQUFJLEtBQUssZ0RBQWdEO0FBQ2hGLFlBQU0sU0FBUyxhQUFhLEdBQUc7QUFDL0IsbUJBQWEsRUFBRSxnQkFBZ0IsZ0JBQWdCLE9BQU87QUFBQSxJQUN2RDtBQUNBLFVBQU0sZ0NBQWdDO0FBQ3RDLFVBQU0sT0FBTyxJQUFJLFlBQVksQ0FBQztBQUM5Qixl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
