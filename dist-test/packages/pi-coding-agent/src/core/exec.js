import { spawn } from "node:child_process";
async function execCommand(command, args, cwd, options) {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd,
      // On Windows, npm/npx/tsc etc. are .cmd scripts that require shell
      // resolution.  Without this, spawn fails with ENOENT or EINVAL (#2854).
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    let timeoutId;
    const killProcess = () => {
      if (!killed) {
        killed = true;
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) {
            proc.kill("SIGKILL");
          }
        }, 5e3);
      }
    };
    if (options?.signal) {
      if (options.signal.aborted) {
        killProcess();
      } else {
        options.signal.addEventListener("abort", killProcess, { once: true });
      }
    }
    if (options?.timeout && options.timeout > 0) {
      timeoutId = setTimeout(() => {
        killProcess();
      }, options.timeout);
    }
    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });
    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });
    proc.on("close", (code) => {
      if (timeoutId) clearTimeout(timeoutId);
      if (options?.signal) {
        options.signal.removeEventListener("abort", killProcess);
      }
      resolve({ stdout, stderr, code: code ?? 0, killed });
    });
    proc.on("error", (_err) => {
      if (timeoutId) clearTimeout(timeoutId);
      if (options?.signal) {
        options.signal.removeEventListener("abort", killProcess);
      }
      resolve({ stdout, stderr, code: 1, killed });
    });
  });
}
export {
  execCommand
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL2V4ZWMudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogU2hhcmVkIGNvbW1hbmQgZXhlY3V0aW9uIHV0aWxpdGllcyBmb3IgZXh0ZW5zaW9ucyBhbmQgY3VzdG9tIHRvb2xzLlxuICovXG5cbmltcG9ydCB7IHNwYXduIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuXG4vKipcbiAqIE9wdGlvbnMgZm9yIGV4ZWN1dGluZyBzaGVsbCBjb21tYW5kcy5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBFeGVjT3B0aW9ucyB7XG5cdC8qKiBBYm9ydFNpZ25hbCB0byBjYW5jZWwgdGhlIGNvbW1hbmQgKi9cblx0c2lnbmFsPzogQWJvcnRTaWduYWw7XG5cdC8qKiBUaW1lb3V0IGluIG1pbGxpc2Vjb25kcyAqL1xuXHR0aW1lb3V0PzogbnVtYmVyO1xuXHQvKiogV29ya2luZyBkaXJlY3RvcnkgKi9cblx0Y3dkPzogc3RyaW5nO1xufVxuXG4vKipcbiAqIFJlc3VsdCBvZiBleGVjdXRpbmcgYSBzaGVsbCBjb21tYW5kLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEV4ZWNSZXN1bHQge1xuXHRzdGRvdXQ6IHN0cmluZztcblx0c3RkZXJyOiBzdHJpbmc7XG5cdGNvZGU6IG51bWJlcjtcblx0a2lsbGVkOiBib29sZWFuO1xufVxuXG4vKipcbiAqIEV4ZWN1dGUgYSBzaGVsbCBjb21tYW5kIGFuZCByZXR1cm4gc3Rkb3V0L3N0ZGVyci9jb2RlLlxuICogU3VwcG9ydHMgdGltZW91dCBhbmQgYWJvcnQgc2lnbmFsLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZXhlY0NvbW1hbmQoXG5cdGNvbW1hbmQ6IHN0cmluZyxcblx0YXJnczogc3RyaW5nW10sXG5cdGN3ZDogc3RyaW5nLFxuXHRvcHRpb25zPzogRXhlY09wdGlvbnMsXG4pOiBQcm9taXNlPEV4ZWNSZXN1bHQ+IHtcblx0cmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG5cdFx0Y29uc3QgcHJvYyA9IHNwYXduKGNvbW1hbmQsIGFyZ3MsIHtcblx0XHRcdGN3ZCxcblx0XHRcdC8vIE9uIFdpbmRvd3MsIG5wbS9ucHgvdHNjIGV0Yy4gYXJlIC5jbWQgc2NyaXB0cyB0aGF0IHJlcXVpcmUgc2hlbGxcblx0XHRcdC8vIHJlc29sdXRpb24uICBXaXRob3V0IHRoaXMsIHNwYXduIGZhaWxzIHdpdGggRU5PRU5UIG9yIEVJTlZBTCAoIzI4NTQpLlxuXHRcdFx0c2hlbGw6IHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIixcblx0XHRcdHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwicGlwZVwiXSxcblx0XHR9KTtcblxuXHRcdGxldCBzdGRvdXQgPSBcIlwiO1xuXHRcdGxldCBzdGRlcnIgPSBcIlwiO1xuXHRcdGxldCBraWxsZWQgPSBmYWxzZTtcblx0XHRsZXQgdGltZW91dElkOiBOb2RlSlMuVGltZW91dCB8IHVuZGVmaW5lZDtcblxuXHRcdGNvbnN0IGtpbGxQcm9jZXNzID0gKCkgPT4ge1xuXHRcdFx0aWYgKCFraWxsZWQpIHtcblx0XHRcdFx0a2lsbGVkID0gdHJ1ZTtcblx0XHRcdFx0cHJvYy5raWxsKFwiU0lHVEVSTVwiKTtcblx0XHRcdFx0Ly8gRm9yY2Uga2lsbCBhZnRlciA1IHNlY29uZHMgaWYgU0lHVEVSTSBkb2Vzbid0IHdvcmtcblx0XHRcdFx0c2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHRcdFx0aWYgKCFwcm9jLmtpbGxlZCkge1xuXHRcdFx0XHRcdFx0cHJvYy5raWxsKFwiU0lHS0lMTFwiKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH0sIDUwMDApO1xuXHRcdFx0fVxuXHRcdH07XG5cblx0XHQvLyBIYW5kbGUgYWJvcnQgc2lnbmFsXG5cdFx0aWYgKG9wdGlvbnM/LnNpZ25hbCkge1xuXHRcdFx0aWYgKG9wdGlvbnMuc2lnbmFsLmFib3J0ZWQpIHtcblx0XHRcdFx0a2lsbFByb2Nlc3MoKTtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdG9wdGlvbnMuc2lnbmFsLmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBraWxsUHJvY2VzcywgeyBvbmNlOiB0cnVlIH0pO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdC8vIEhhbmRsZSB0aW1lb3V0XG5cdFx0aWYgKG9wdGlvbnM/LnRpbWVvdXQgJiYgb3B0aW9ucy50aW1lb3V0ID4gMCkge1xuXHRcdFx0dGltZW91dElkID0gc2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHRcdGtpbGxQcm9jZXNzKCk7XG5cdFx0XHR9LCBvcHRpb25zLnRpbWVvdXQpO1xuXHRcdH1cblxuXHRcdHByb2Muc3Rkb3V0Py5vbihcImRhdGFcIiwgKGRhdGEpID0+IHtcblx0XHRcdHN0ZG91dCArPSBkYXRhLnRvU3RyaW5nKCk7XG5cdFx0fSk7XG5cblx0XHRwcm9jLnN0ZGVycj8ub24oXCJkYXRhXCIsIChkYXRhKSA9PiB7XG5cdFx0XHRzdGRlcnIgKz0gZGF0YS50b1N0cmluZygpO1xuXHRcdH0pO1xuXG5cdFx0cHJvYy5vbihcImNsb3NlXCIsIChjb2RlKSA9PiB7XG5cdFx0XHRpZiAodGltZW91dElkKSBjbGVhclRpbWVvdXQodGltZW91dElkKTtcblx0XHRcdGlmIChvcHRpb25zPy5zaWduYWwpIHtcblx0XHRcdFx0b3B0aW9ucy5zaWduYWwucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIGtpbGxQcm9jZXNzKTtcblx0XHRcdH1cblx0XHRcdHJlc29sdmUoeyBzdGRvdXQsIHN0ZGVyciwgY29kZTogY29kZSA/PyAwLCBraWxsZWQgfSk7XG5cdFx0fSk7XG5cblx0XHRwcm9jLm9uKFwiZXJyb3JcIiwgKF9lcnIpID0+IHtcblx0XHRcdGlmICh0aW1lb3V0SWQpIGNsZWFyVGltZW91dCh0aW1lb3V0SWQpO1xuXHRcdFx0aWYgKG9wdGlvbnM/LnNpZ25hbCkge1xuXHRcdFx0XHRvcHRpb25zLnNpZ25hbC5yZW1vdmVFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwga2lsbFByb2Nlc3MpO1xuXHRcdFx0fVxuXHRcdFx0cmVzb2x2ZSh7IHN0ZG91dCwgc3RkZXJyLCBjb2RlOiAxLCBraWxsZWQgfSk7XG5cdFx0fSk7XG5cdH0pO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBSUEsU0FBUyxhQUFhO0FBNEJ0QixlQUFzQixZQUNyQixTQUNBLE1BQ0EsS0FDQSxTQUNzQjtBQUN0QixTQUFPLElBQUksUUFBUSxDQUFDLFlBQVk7QUFDL0IsVUFBTSxPQUFPLE1BQU0sU0FBUyxNQUFNO0FBQUEsTUFDakM7QUFBQTtBQUFBO0FBQUEsTUFHQSxPQUFPLFFBQVEsYUFBYTtBQUFBLE1BQzVCLE9BQU8sQ0FBQyxVQUFVLFFBQVEsTUFBTTtBQUFBLElBQ2pDLENBQUM7QUFFRCxRQUFJLFNBQVM7QUFDYixRQUFJLFNBQVM7QUFDYixRQUFJLFNBQVM7QUFDYixRQUFJO0FBRUosVUFBTSxjQUFjLE1BQU07QUFDekIsVUFBSSxDQUFDLFFBQVE7QUFDWixpQkFBUztBQUNULGFBQUssS0FBSyxTQUFTO0FBRW5CLG1CQUFXLE1BQU07QUFDaEIsY0FBSSxDQUFDLEtBQUssUUFBUTtBQUNqQixpQkFBSyxLQUFLLFNBQVM7QUFBQSxVQUNwQjtBQUFBLFFBQ0QsR0FBRyxHQUFJO0FBQUEsTUFDUjtBQUFBLElBQ0Q7QUFHQSxRQUFJLFNBQVMsUUFBUTtBQUNwQixVQUFJLFFBQVEsT0FBTyxTQUFTO0FBQzNCLG9CQUFZO0FBQUEsTUFDYixPQUFPO0FBQ04sZ0JBQVEsT0FBTyxpQkFBaUIsU0FBUyxhQUFhLEVBQUUsTUFBTSxLQUFLLENBQUM7QUFBQSxNQUNyRTtBQUFBLElBQ0Q7QUFHQSxRQUFJLFNBQVMsV0FBVyxRQUFRLFVBQVUsR0FBRztBQUM1QyxrQkFBWSxXQUFXLE1BQU07QUFDNUIsb0JBQVk7QUFBQSxNQUNiLEdBQUcsUUFBUSxPQUFPO0FBQUEsSUFDbkI7QUFFQSxTQUFLLFFBQVEsR0FBRyxRQUFRLENBQUMsU0FBUztBQUNqQyxnQkFBVSxLQUFLLFNBQVM7QUFBQSxJQUN6QixDQUFDO0FBRUQsU0FBSyxRQUFRLEdBQUcsUUFBUSxDQUFDLFNBQVM7QUFDakMsZ0JBQVUsS0FBSyxTQUFTO0FBQUEsSUFDekIsQ0FBQztBQUVELFNBQUssR0FBRyxTQUFTLENBQUMsU0FBUztBQUMxQixVQUFJLFVBQVcsY0FBYSxTQUFTO0FBQ3JDLFVBQUksU0FBUyxRQUFRO0FBQ3BCLGdCQUFRLE9BQU8sb0JBQW9CLFNBQVMsV0FBVztBQUFBLE1BQ3hEO0FBQ0EsY0FBUSxFQUFFLFFBQVEsUUFBUSxNQUFNLFFBQVEsR0FBRyxPQUFPLENBQUM7QUFBQSxJQUNwRCxDQUFDO0FBRUQsU0FBSyxHQUFHLFNBQVMsQ0FBQyxTQUFTO0FBQzFCLFVBQUksVUFBVyxjQUFhLFNBQVM7QUFDckMsVUFBSSxTQUFTLFFBQVE7QUFDcEIsZ0JBQVEsT0FBTyxvQkFBb0IsU0FBUyxXQUFXO0FBQUEsTUFDeEQ7QUFDQSxjQUFRLEVBQUUsUUFBUSxRQUFRLE1BQU0sR0FBRyxPQUFPLENBQUM7QUFBQSxJQUM1QyxDQUFDO0FBQUEsRUFDRixDQUFDO0FBQ0Y7IiwKICAibmFtZXMiOiBbXQp9Cg==
