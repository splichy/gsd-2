import { Type } from "@sinclair/typebox";
const DEFAULT_TIMEOUT_SECONDS = 120;
const schema = Type.Object({
  jobs: Type.Optional(
    Type.Array(Type.String(), {
      description: "Job IDs to wait for. Omit to wait for any running job."
    })
  ),
  timeout: Type.Optional(
    Type.Number({
      description: "Maximum seconds to wait before returning control. Defaults to 120. Jobs continue running in the background after timeout."
    })
  )
});
function createAwaitTool(getManager) {
  return {
    name: "await_job",
    label: "Await Background Job",
    description: "Wait for background jobs to complete. Provide specific job IDs or omit to wait for the next job that finishes. Returns results of completed jobs.",
    parameters: schema,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const manager = getManager();
      const { jobs: jobIds, timeout } = params;
      const timeoutMs = (timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1e3;
      let watched;
      if (jobIds && jobIds.length > 0) {
        watched = [];
        const notFound = [];
        for (const id of jobIds) {
          const job = manager.getJob(id);
          if (job) {
            watched.push(job);
          } else {
            notFound.push(id);
          }
        }
        if (notFound.length > 0 && watched.length === 0) {
          return {
            content: [{ type: "text", text: `No jobs found: ${notFound.join(", ")}` }],
            details: void 0
          };
        }
      } else {
        watched = manager.getRunningJobs();
        if (watched.length === 0) {
          return {
            content: [{ type: "text", text: "No running background jobs." }],
            details: void 0
          };
        }
      }
      for (const j of watched) manager.suppressFollowUp(j.id);
      const running = watched.filter((j) => j.status === "running");
      if (running.length === 0) {
        const result2 = formatResults(watched);
        return { content: [{ type: "text", text: result2 }], details: void 0 };
      }
      const TIMEOUT_SENTINEL = Symbol("timeout");
      const timeoutPromise = new Promise((resolve) => {
        const timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs);
        if (typeof timer === "object" && "unref" in timer) timer.unref();
      });
      const raceResult = await Promise.race([
        Promise.race(running.map((j) => j.promise)).then(() => "completed"),
        timeoutPromise
      ]);
      const timedOut = raceResult === TIMEOUT_SENTINEL;
      const completed = watched.filter((j) => j.status !== "running");
      const stillRunning = watched.filter((j) => j.status === "running");
      let result = formatResults(completed);
      if (stillRunning.length > 0) {
        result += `

**Still running:** ${stillRunning.map((j) => `${j.id} (${j.label})`).join(", ")}`;
      }
      if (timedOut) {
        result += `

\u23F1 **Timed out** after ${timeout ?? DEFAULT_TIMEOUT_SECONDS}s waiting for jobs to finish. Jobs are still running in the background. Use \`await_job\` again later or \`async_bash\` + \`await_job\` for shorter polling intervals.`;
      }
      return { content: [{ type: "text", text: result }], details: void 0 };
    }
  };
}
function formatResults(jobs) {
  if (jobs.length === 0) return "No completed jobs.";
  const parts = [];
  for (const job of jobs) {
    const elapsed = ((Date.now() - job.startTime) / 1e3).toFixed(1);
    const header = `### ${job.id} \u2014 ${job.label} (${job.status}, ${elapsed}s)`;
    if (job.status === "completed") {
      parts.push(`${header}

${job.resultText ?? "(no output)"}`);
    } else if (job.status === "failed") {
      parts.push(`${header}

Error: ${job.errorText ?? "unknown error"}`);
    } else if (job.status === "cancelled") {
      parts.push(`${header}

Cancelled.`);
    }
  }
  return parts.join("\n\n---\n\n");
}
export {
  createAwaitTool
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2FzeW5jLWpvYnMvYXdhaXQtdG9vbC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBhd2FpdF9qb2IgdG9vbCBcdTIwMTQgd2FpdCBmb3Igb25lIG9yIG1vcmUgYmFja2dyb3VuZCBqb2JzIHRvIGNvbXBsZXRlLlxuICpcbiAqIElmIHNwZWNpZmljIGpvYiBJRHMgYXJlIHByb3ZpZGVkLCB3YWl0cyBmb3IgdGhvc2Ugam9icy5cbiAqIElmIG9taXR0ZWQsIHdhaXRzIGZvciBhbnkgcnVubmluZyBqb2IgdG8gY29tcGxldGUuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBUb29sRGVmaW5pdGlvbiB9IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuaW1wb3J0IHsgVHlwZSB9IGZyb20gXCJAc2luY2xhaXIvdHlwZWJveFwiO1xuaW1wb3J0IHR5cGUgeyBBc3luY0pvYk1hbmFnZXIsIEpvYiB9IGZyb20gXCIuL2pvYi1tYW5hZ2VyLmpzXCI7XG5cbmNvbnN0IERFRkFVTFRfVElNRU9VVF9TRUNPTkRTID0gMTIwO1xuXG5jb25zdCBzY2hlbWEgPSBUeXBlLk9iamVjdCh7XG5cdGpvYnM6IFR5cGUuT3B0aW9uYWwoXG5cdFx0VHlwZS5BcnJheShUeXBlLlN0cmluZygpLCB7XG5cdFx0XHRkZXNjcmlwdGlvbjogXCJKb2IgSURzIHRvIHdhaXQgZm9yLiBPbWl0IHRvIHdhaXQgZm9yIGFueSBydW5uaW5nIGpvYi5cIixcblx0XHR9KSxcblx0KSxcblx0dGltZW91dDogVHlwZS5PcHRpb25hbChcblx0XHRUeXBlLk51bWJlcih7XG5cdFx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFx0XCJNYXhpbXVtIHNlY29uZHMgdG8gd2FpdCBiZWZvcmUgcmV0dXJuaW5nIGNvbnRyb2wuIERlZmF1bHRzIHRvIDEyMC4gXCIgK1xuXHRcdFx0XHRcIkpvYnMgY29udGludWUgcnVubmluZyBpbiB0aGUgYmFja2dyb3VuZCBhZnRlciB0aW1lb3V0LlwiLFxuXHRcdH0pLFxuXHQpLFxufSk7XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVBd2FpdFRvb2woZ2V0TWFuYWdlcjogKCkgPT4gQXN5bmNKb2JNYW5hZ2VyKTogVG9vbERlZmluaXRpb248dHlwZW9mIHNjaGVtYT4ge1xuXHRyZXR1cm4ge1xuXHRcdG5hbWU6IFwiYXdhaXRfam9iXCIsXG5cdFx0bGFiZWw6IFwiQXdhaXQgQmFja2dyb3VuZCBKb2JcIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiV2FpdCBmb3IgYmFja2dyb3VuZCBqb2JzIHRvIGNvbXBsZXRlLiBQcm92aWRlIHNwZWNpZmljIGpvYiBJRHMgb3Igb21pdCB0byB3YWl0IGZvciB0aGUgbmV4dCBqb2IgdGhhdCBmaW5pc2hlcy4gUmV0dXJucyByZXN1bHRzIG9mIGNvbXBsZXRlZCBqb2JzLlwiLFxuXHRcdHBhcmFtZXRlcnM6IHNjaGVtYSxcblx0XHRhc3luYyBleGVjdXRlKF90b29sQ2FsbElkLCBwYXJhbXMsIF9zaWduYWwsIF9vblVwZGF0ZSwgX2N0eCkge1xuXHRcdFx0Y29uc3QgbWFuYWdlciA9IGdldE1hbmFnZXIoKTtcblx0XHRcdGNvbnN0IHsgam9iczogam9iSWRzLCB0aW1lb3V0IH0gPSBwYXJhbXM7XG5cdFx0XHRjb25zdCB0aW1lb3V0TXMgPSAoKHRpbWVvdXQgPz8gREVGQVVMVF9USU1FT1VUX1NFQ09ORFMpICogMTAwMCk7XG5cblx0XHRcdGxldCB3YXRjaGVkOiBKb2JbXTtcblx0XHRcdGlmIChqb2JJZHMgJiYgam9iSWRzLmxlbmd0aCA+IDApIHtcblx0XHRcdFx0d2F0Y2hlZCA9IFtdO1xuXHRcdFx0XHRjb25zdCBub3RGb3VuZDogc3RyaW5nW10gPSBbXTtcblx0XHRcdFx0Zm9yIChjb25zdCBpZCBvZiBqb2JJZHMpIHtcblx0XHRcdFx0XHRjb25zdCBqb2IgPSBtYW5hZ2VyLmdldEpvYihpZCk7XG5cdFx0XHRcdFx0aWYgKGpvYikge1xuXHRcdFx0XHRcdFx0d2F0Y2hlZC5wdXNoKGpvYik7XG5cdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdG5vdEZvdW5kLnB1c2goaWQpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXHRcdFx0XHRpZiAobm90Rm91bmQubGVuZ3RoID4gMCAmJiB3YXRjaGVkLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYE5vIGpvYnMgZm91bmQ6ICR7bm90Rm91bmQuam9pbihcIiwgXCIpfWAgfV0sXG5cdFx0XHRcdFx0XHRkZXRhaWxzOiB1bmRlZmluZWQsXG5cdFx0XHRcdFx0fTtcblx0XHRcdFx0fVxuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0d2F0Y2hlZCA9IG1hbmFnZXIuZ2V0UnVubmluZ0pvYnMoKTtcblx0XHRcdFx0aWYgKHdhdGNoZWQubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIk5vIHJ1bm5pbmcgYmFja2dyb3VuZCBqb2JzLlwiIH1dLFxuXHRcdFx0XHRcdFx0ZGV0YWlsczogdW5kZWZpbmVkLFxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0Ly8gU3VwcHJlc3MgZm9sbG93LXVwIG5vdGlmaWNhdGlvbnMgZm9yIGFsbCB3YXRjaGVkIGpvYnMgdXBmcm9udC5cblx0XHRcdC8vIHN1cHByZXNzRm9sbG93VXAoKSBjYW5jZWxzIHRoZSBwZW5kaW5nIGRlbGl2ZXJ5IHRpbWVyIChpZiBhbnkpLCB3aGljaFxuXHRcdFx0Ly8gaGFuZGxlcyBib3RoIHRoZSB3aXRoaW4tdHVybiBjYXNlIChqb2IgY29tcGxldGVzIHdoaWxlIHdlIGF3YWl0KSBhbmRcblx0XHRcdC8vIHRoZSBjcm9zcy10dXJuIGNhc2UgKGpvYiBhbHJlYWR5IGNvbXBsZXRlZCBiZWZvcmUgYXdhaXRfam9iIHdhcyBjYWxsZWQpLlxuXHRcdFx0Ly8gUHJldmlvdXNseSB0aGlzIG9ubHkgc2V0IGouYXdhaXRlZCA9IHRydWUsIHdoaWNoIG1pc3NlZCB0aGUgY3Jvc3MtdHVyblxuXHRcdFx0Ly8gY2FzZSBiZWNhdXNlIHRoZSBxdWV1ZU1pY3JvdGFzayBoYWQgYWxyZWFkeSBmaXJlZCAoIzM3ODcpLlxuXHRcdFx0Zm9yIChjb25zdCBqIG9mIHdhdGNoZWQpIG1hbmFnZXIuc3VwcHJlc3NGb2xsb3dVcChqLmlkKTtcblxuXHRcdFx0Ly8gSWYgYWxsIHdhdGNoZWQgam9icyBhcmUgYWxyZWFkeSBkb25lLCByZXR1cm4gaW1tZWRpYXRlbHlcblx0XHRcdGNvbnN0IHJ1bm5pbmcgPSB3YXRjaGVkLmZpbHRlcigoaikgPT4gai5zdGF0dXMgPT09IFwicnVubmluZ1wiKTtcblx0XHRcdGlmIChydW5uaW5nLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0XHRjb25zdCByZXN1bHQgPSBmb3JtYXRSZXN1bHRzKHdhdGNoZWQpO1xuXHRcdFx0XHRyZXR1cm4geyBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogcmVzdWx0IH1dLCBkZXRhaWxzOiB1bmRlZmluZWQgfTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gV2FpdCBmb3IgYXQgbGVhc3Qgb25lIHRvIGNvbXBsZXRlLCBvciB0aW1lb3V0XG5cdFx0XHRjb25zdCBUSU1FT1VUX1NFTlRJTkVMID0gU3ltYm9sKFwidGltZW91dFwiKTtcblx0XHRcdGNvbnN0IHRpbWVvdXRQcm9taXNlID0gbmV3IFByb21pc2U8dHlwZW9mIFRJTUVPVVRfU0VOVElORUw+KChyZXNvbHZlKSA9PiB7XG5cdFx0XHRcdGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiByZXNvbHZlKFRJTUVPVVRfU0VOVElORUwpLCB0aW1lb3V0TXMpO1xuXHRcdFx0XHQvLyBBbGxvdyB0aGUgcHJvY2VzcyB0byBleGl0IGV2ZW4gaWYgdGhlIHRpbWVyIGlzIHBlbmRpbmdcblx0XHRcdFx0aWYgKHR5cGVvZiB0aW1lciA9PT0gXCJvYmplY3RcIiAmJiBcInVucmVmXCIgaW4gdGltZXIpIHRpbWVyLnVucmVmKCk7XG5cdFx0XHR9KTtcblxuXHRcdFx0Y29uc3QgcmFjZVJlc3VsdCA9IGF3YWl0IFByb21pc2UucmFjZShbXG5cdFx0XHRcdFByb21pc2UucmFjZShydW5uaW5nLm1hcCgoaikgPT4gai5wcm9taXNlKSkudGhlbigoKSA9PiBcImNvbXBsZXRlZFwiIGFzIGNvbnN0KSxcblx0XHRcdFx0dGltZW91dFByb21pc2UsXG5cdFx0XHRdKTtcblxuXHRcdFx0Y29uc3QgdGltZWRPdXQgPSByYWNlUmVzdWx0ID09PSBUSU1FT1VUX1NFTlRJTkVMO1xuXG5cdFx0XHQvLyBDb2xsZWN0IGFsbCBjb21wbGV0ZWQgcmVzdWx0cyAobW9yZSBtYXkgaGF2ZSBmaW5pc2hlZCB3aGlsZSB3YWl0aW5nKVxuXHRcdFx0Y29uc3QgY29tcGxldGVkID0gd2F0Y2hlZC5maWx0ZXIoKGopID0+IGouc3RhdHVzICE9PSBcInJ1bm5pbmdcIik7XG5cblx0XHRcdGNvbnN0IHN0aWxsUnVubmluZyA9IHdhdGNoZWQuZmlsdGVyKChqKSA9PiBqLnN0YXR1cyA9PT0gXCJydW5uaW5nXCIpO1xuXHRcdFx0bGV0IHJlc3VsdCA9IGZvcm1hdFJlc3VsdHMoY29tcGxldGVkKTtcblx0XHRcdGlmIChzdGlsbFJ1bm5pbmcubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRyZXN1bHQgKz0gYFxcblxcbioqU3RpbGwgcnVubmluZzoqKiAke3N0aWxsUnVubmluZy5tYXAoKGopID0+IGAke2ouaWR9ICgke2oubGFiZWx9KWApLmpvaW4oXCIsIFwiKX1gO1xuXHRcdFx0fVxuXHRcdFx0aWYgKHRpbWVkT3V0KSB7XG5cdFx0XHRcdHJlc3VsdCArPSBgXFxuXFxuXHUyM0YxICoqVGltZWQgb3V0KiogYWZ0ZXIgJHt0aW1lb3V0ID8/IERFRkFVTFRfVElNRU9VVF9TRUNPTkRTfXMgd2FpdGluZyBmb3Igam9icyB0byBmaW5pc2guIGAgK1xuXHRcdFx0XHRcdGBKb2JzIGFyZSBzdGlsbCBydW5uaW5nIGluIHRoZSBiYWNrZ3JvdW5kLiBgICtcblx0XHRcdFx0XHRgVXNlIFxcYGF3YWl0X2pvYlxcYCBhZ2FpbiBsYXRlciBvciBcXGBhc3luY19iYXNoXFxgICsgXFxgYXdhaXRfam9iXFxgIGZvciBzaG9ydGVyIHBvbGxpbmcgaW50ZXJ2YWxzLmA7XG5cdFx0XHR9XG5cblx0XHRcdHJldHVybiB7IGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiByZXN1bHQgfV0sIGRldGFpbHM6IHVuZGVmaW5lZCB9O1xuXHRcdH0sXG5cdH07XG59XG5cbmZ1bmN0aW9uIGZvcm1hdFJlc3VsdHMoam9iczogSm9iW10pOiBzdHJpbmcge1xuXHRpZiAoam9icy5sZW5ndGggPT09IDApIHJldHVybiBcIk5vIGNvbXBsZXRlZCBqb2JzLlwiO1xuXG5cdGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuXHRmb3IgKGNvbnN0IGpvYiBvZiBqb2JzKSB7XG5cdFx0Y29uc3QgZWxhcHNlZCA9ICgoRGF0ZS5ub3coKSAtIGpvYi5zdGFydFRpbWUpIC8gMTAwMCkudG9GaXhlZCgxKTtcblx0XHRjb25zdCBoZWFkZXIgPSBgIyMjICR7am9iLmlkfSBcdTIwMTQgJHtqb2IubGFiZWx9ICgke2pvYi5zdGF0dXN9LCAke2VsYXBzZWR9cylgO1xuXG5cdFx0aWYgKGpvYi5zdGF0dXMgPT09IFwiY29tcGxldGVkXCIpIHtcblx0XHRcdHBhcnRzLnB1c2goYCR7aGVhZGVyfVxcblxcbiR7am9iLnJlc3VsdFRleHQgPz8gXCIobm8gb3V0cHV0KVwifWApO1xuXHRcdH0gZWxzZSBpZiAoam9iLnN0YXR1cyA9PT0gXCJmYWlsZWRcIikge1xuXHRcdFx0cGFydHMucHVzaChgJHtoZWFkZXJ9XFxuXFxuRXJyb3I6ICR7am9iLmVycm9yVGV4dCA/PyBcInVua25vd24gZXJyb3JcIn1gKTtcblx0XHR9IGVsc2UgaWYgKGpvYi5zdGF0dXMgPT09IFwiY2FuY2VsbGVkXCIpIHtcblx0XHRcdHBhcnRzLnB1c2goYCR7aGVhZGVyfVxcblxcbkNhbmNlbGxlZC5gKTtcblx0XHR9XG5cdH1cblxuXHRyZXR1cm4gcGFydHMuam9pbihcIlxcblxcbi0tLVxcblxcblwiKTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQVFBLFNBQVMsWUFBWTtBQUdyQixNQUFNLDBCQUEwQjtBQUVoQyxNQUFNLFNBQVMsS0FBSyxPQUFPO0FBQUEsRUFDMUIsTUFBTSxLQUFLO0FBQUEsSUFDVixLQUFLLE1BQU0sS0FBSyxPQUFPLEdBQUc7QUFBQSxNQUN6QixhQUFhO0FBQUEsSUFDZCxDQUFDO0FBQUEsRUFDRjtBQUFBLEVBQ0EsU0FBUyxLQUFLO0FBQUEsSUFDYixLQUFLLE9BQU87QUFBQSxNQUNYLGFBQ0M7QUFBQSxJQUVGLENBQUM7QUFBQSxFQUNGO0FBQ0QsQ0FBQztBQUVNLFNBQVMsZ0JBQWdCLFlBQWtFO0FBQ2pHLFNBQU87QUFBQSxJQUNOLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLGFBQ0M7QUFBQSxJQUNELFlBQVk7QUFBQSxJQUNaLE1BQU0sUUFBUSxhQUFhLFFBQVEsU0FBUyxXQUFXLE1BQU07QUFDNUQsWUFBTSxVQUFVLFdBQVc7QUFDM0IsWUFBTSxFQUFFLE1BQU0sUUFBUSxRQUFRLElBQUk7QUFDbEMsWUFBTSxhQUFjLFdBQVcsMkJBQTJCO0FBRTFELFVBQUk7QUFDSixVQUFJLFVBQVUsT0FBTyxTQUFTLEdBQUc7QUFDaEMsa0JBQVUsQ0FBQztBQUNYLGNBQU0sV0FBcUIsQ0FBQztBQUM1QixtQkFBVyxNQUFNLFFBQVE7QUFDeEIsZ0JBQU0sTUFBTSxRQUFRLE9BQU8sRUFBRTtBQUM3QixjQUFJLEtBQUs7QUFDUixvQkFBUSxLQUFLLEdBQUc7QUFBQSxVQUNqQixPQUFPO0FBQ04scUJBQVMsS0FBSyxFQUFFO0FBQUEsVUFDakI7QUFBQSxRQUNEO0FBQ0EsWUFBSSxTQUFTLFNBQVMsS0FBSyxRQUFRLFdBQVcsR0FBRztBQUNoRCxpQkFBTztBQUFBLFlBQ04sU0FB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
