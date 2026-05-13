import { Type } from "@sinclair/typebox";
import { resolveCtxCwd } from "./dynamic-tools.js";
async function loadContextModePreferences(baseDir) {
  const [{ loadEffectiveGSDPreferences }, { logWarning }] = await Promise.all([
    import("../preferences.js"),
    import("../workflow-logger.js")
  ]);
  try {
    return loadEffectiveGSDPreferences(baseDir)?.preferences ?? null;
  } catch (err) {
    logWarning("tool", `Context Mode tool could not load preferences: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
function registerExecTools(pi) {
  pi.registerTool({
    name: "gsd_exec",
    label: "Exec (Sandboxed)",
    description: "Run a short script (bash/node/python) in a subprocess. Capped stdout/stderr and metadata persist to .gsd/exec/<id>.{stdout,stderr,meta.json}; only a short digest returns in context. Use this instead of reading many files or emitting large tool outputs \u2014 e.g. have the script count/grep/summarize and log the finding. Enabled by default; opt out via preferences.context_mode.enabled=false.",
    promptSnippet: "Run a bash/node/python script in a sandbox; capped output is saved to disk and only a digest returns",
    promptGuidelines: [
      "Prefer gsd_exec for analyses that would otherwise read >3 files or produce large tool output.",
      "Write scripts that log the finding (counts, matches, summaries) rather than raw dumps.",
      "The digest is the last ~300 chars of stdout \u2014 size your log output accordingly.",
      "Need persisted output? Read the stdout_path returned in details (file on local disk)."
    ],
    parameters: Type.Object({
      runtime: Type.Union(
        [Type.Literal("bash"), Type.Literal("node"), Type.Literal("python")],
        { description: "Interpreter: bash (-c), node (-e), or python3 (-c)." }
      ),
      script: Type.String({ description: "Script body. Keep output small (log the finding, not the data)." }),
      purpose: Type.Optional(Type.String({ description: "Short label recorded in meta.json for later review." })),
      timeout_ms: Type.Optional(
        Type.Number({
          description: "Per-invocation timeout (ms). Capped at 600000. Default from preferences.",
          minimum: 1e3,
          maximum: 6e5
        })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { executeGsdExec } = await import("../tools/exec-tool.js");
      const baseDir = resolveCtxCwd(_ctx);
      return executeGsdExec(params, {
        baseDir,
        preferences: await loadContextModePreferences(baseDir)
      });
    }
  });
  pi.registerTool({
    name: "gsd_exec_search",
    label: "Search gsd_exec History",
    description: "List prior gsd_exec runs (most recent first) from .gsd/exec/*.meta.json. Useful for rediscovering the stdout_path of an earlier run without re-executing it. Read-only.",
    promptSnippet: "Search prior gsd_exec runs by substring, runtime, or failing-only filter",
    promptGuidelines: [
      "Use this before re-running an expensive analysis \u2014 the prior run's stdout file may still answer.",
      "The preview shows the trailing ~300 chars of stdout; read stdout_path for persisted output."
    ],
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Substring matched against id and purpose (case-insensitive)." })),
      runtime: Type.Optional(
        Type.Union([Type.Literal("bash"), Type.Literal("node"), Type.Literal("python")], {
          description: "Restrict to one runtime."
        })
      ),
      failing_only: Type.Optional(Type.Boolean({ description: "Only non-zero exit codes and timeouts." })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 20, cap 200)", minimum: 1, maximum: 200 }))
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { executeExecSearch } = await import("../tools/exec-search-tool.js");
      const baseDir = resolveCtxCwd(_ctx);
      return executeExecSearch(params, {
        baseDir,
        preferences: await loadContextModePreferences(baseDir)
      });
    }
  });
  pi.registerTool({
    name: "gsd_resume",
    label: "Resume (Read Snapshot)",
    description: "Return the contents of .gsd/last-snapshot.md \u2014 a \u22642 KB digest of top memories, recent gsd_exec runs, and active context, written automatically on session_before_compact. Use this after compaction or session resume to re-orient quickly.",
    promptSnippet: "Read the pre-compaction snapshot to re-orient after context loss",
    promptGuidelines: [
      "Call this right after a session resumes if you feel you've lost durable context.",
      "The snapshot is a summary \u2014 use memory_query or gsd_exec_search for detail."
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { executeResume } = await import("../tools/resume-tool.js");
      const baseDir = resolveCtxCwd(_ctx);
      return executeResume(params, {
        baseDir,
        preferences: await loadContextModePreferences(baseDir)
      });
    }
  });
}
export {
  registerExecTools
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9ib290c3RyYXAvZXhlYy10b29scy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IFJlZ2lzdGVycyBDb250ZXh0IE1vZGUgZXhlY3V0aW9uIHRvb2xzLlxuLy8gR1NEMiBcdTIwMTQgRXhlYyAoY29udGV4dC1tb2RlKSB0b29sIHJlZ2lzdHJhdGlvbi5cbi8vXG4vLyBFeHBvc2VzIHRoZSBDb250ZXh0IE1vZGUgcnVudGltZSB0b29scyBpbi1wcm9jZXNzLiBEZWZhdWx0LW9uOyBvcHQgb3V0IHdpdGhcbi8vIGBjb250ZXh0X21vZGUuZW5hYmxlZDogZmFsc2VgIGluIHByZWZlcmVuY2VzLlxuXG5pbXBvcnQgeyBUeXBlIH0gZnJvbSBcIkBzaW5jbGFpci90eXBlYm94XCI7XG5pbXBvcnQgdHlwZSB7IEV4dGVuc2lvbkFQSSB9IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuXG5pbXBvcnQgeyByZXNvbHZlQ3R4Q3dkIH0gZnJvbSBcIi4vZHluYW1pYy10b29scy5qc1wiO1xuXG5cbmFzeW5jIGZ1bmN0aW9uIGxvYWRDb250ZXh0TW9kZVByZWZlcmVuY2VzKGJhc2VEaXI6IHN0cmluZykge1xuICBjb25zdCBbeyBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMgfSwgeyBsb2dXYXJuaW5nIH1dID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgIGltcG9ydChcIi4uL3ByZWZlcmVuY2VzLmpzXCIpLFxuICAgIGltcG9ydChcIi4uL3dvcmtmbG93LWxvZ2dlci5qc1wiKSxcbiAgXSk7XG4gIHRyeSB7XG4gICAgcmV0dXJuIGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcyhiYXNlRGlyKT8ucHJlZmVyZW5jZXMgPz8gbnVsbDtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgbG9nV2FybmluZyhcInRvb2xcIiwgYENvbnRleHQgTW9kZSB0b29sIGNvdWxkIG5vdCBsb2FkIHByZWZlcmVuY2VzOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gKTtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVnaXN0ZXJFeGVjVG9vbHMocGk6IEV4dGVuc2lvbkFQSSk6IHZvaWQge1xuICBwaS5yZWdpc3RlclRvb2woe1xuICAgIG5hbWU6IFwiZ3NkX2V4ZWNcIixcbiAgICBsYWJlbDogXCJFeGVjIChTYW5kYm94ZWQpXCIsXG4gICAgZGVzY3JpcHRpb246XG4gICAgICBcIlJ1biBhIHNob3J0IHNjcmlwdCAoYmFzaC9ub2RlL3B5dGhvbikgaW4gYSBzdWJwcm9jZXNzLiBDYXBwZWQgc3Rkb3V0L3N0ZGVyciBhbmQgbWV0YWRhdGEgcGVyc2lzdCB0byBcIiArXG4gICAgICBcIi5nc2QvZXhlYy88aWQ+LntzdGRvdXQsc3RkZXJyLG1ldGEuanNvbn07IG9ubHkgYSBzaG9ydCBkaWdlc3QgcmV0dXJucyBpbiBjb250ZXh0LiBVc2UgXCIgK1xuICAgICAgXCJ0aGlzIGluc3RlYWQgb2YgcmVhZGluZyBtYW55IGZpbGVzIG9yIGVtaXR0aW5nIGxhcmdlIHRvb2wgb3V0cHV0cyBcdTIwMTQgZS5nLiBoYXZlIHRoZSBzY3JpcHQgXCIgK1xuICAgICAgXCJjb3VudC9ncmVwL3N1bW1hcml6ZSBhbmQgbG9nIHRoZSBmaW5kaW5nLiBFbmFibGVkIGJ5IGRlZmF1bHQ7IG9wdCBvdXQgdmlhIFwiICtcbiAgICAgIFwicHJlZmVyZW5jZXMuY29udGV4dF9tb2RlLmVuYWJsZWQ9ZmFsc2UuXCIsXG4gICAgcHJvbXB0U25pcHBldDpcbiAgICAgIFwiUnVuIGEgYmFzaC9ub2RlL3B5dGhvbiBzY3JpcHQgaW4gYSBzYW5kYm94OyBjYXBwZWQgb3V0cHV0IGlzIHNhdmVkIHRvIGRpc2sgYW5kIG9ubHkgYSBkaWdlc3QgcmV0dXJuc1wiLFxuICAgIHByb21wdEd1aWRlbGluZXM6IFtcbiAgICAgIFwiUHJlZmVyIGdzZF9leGVjIGZvciBhbmFseXNlcyB0aGF0IHdvdWxkIG90aGVyd2lzZSByZWFkID4zIGZpbGVzIG9yIHByb2R1Y2UgbGFyZ2UgdG9vbCBvdXRwdXQuXCIsXG4gICAgICBcIldyaXRlIHNjcmlwdHMgdGhhdCBsb2cgdGhlIGZpbmRpbmcgKGNvdW50cywgbWF0Y2hlcywgc3VtbWFyaWVzKSByYXRoZXIgdGhhbiByYXcgZHVtcHMuXCIsXG4gICAgICBcIlRoZSBkaWdlc3QgaXMgdGhlIGxhc3QgfjMwMCBjaGFycyBvZiBzdGRvdXQgXHUyMDE0IHNpemUgeW91ciBsb2cgb3V0cHV0IGFjY29yZGluZ2x5LlwiLFxuICAgICAgXCJOZWVkIHBlcnNpc3RlZCBvdXRwdXQ/IFJlYWQgdGhlIHN0ZG91dF9wYXRoIHJldHVybmVkIGluIGRldGFpbHMgKGZpbGUgb24gbG9jYWwgZGlzaykuXCIsXG4gICAgXSxcbiAgICBwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG4gICAgICBydW50aW1lOiBUeXBlLlVuaW9uKFxuICAgICAgICBbVHlwZS5MaXRlcmFsKFwiYmFzaFwiKSwgVHlwZS5MaXRlcmFsKFwibm9kZVwiKSwgVHlwZS5MaXRlcmFsKFwicHl0aG9uXCIpXSxcbiAgICAgICAgeyBkZXNjcmlwdGlvbjogXCJJbnRlcnByZXRlcjogYmFzaCAoLWMpLCBub2RlICgtZSksIG9yIHB5dGhvbjMgKC1jKS5cIiB9LFxuICAgICAgKSxcbiAgICAgIHNjcmlwdDogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJTY3JpcHQgYm9keS4gS2VlcCBvdXRwdXQgc21hbGwgKGxvZyB0aGUgZmluZGluZywgbm90IHRoZSBkYXRhKS5cIiB9KSxcbiAgICAgIHB1cnBvc2U6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJTaG9ydCBsYWJlbCByZWNvcmRlZCBpbiBtZXRhLmpzb24gZm9yIGxhdGVyIHJldmlldy5cIiB9KSksXG4gICAgICB0aW1lb3V0X21zOiBUeXBlLk9wdGlvbmFsKFxuICAgICAgICBUeXBlLk51bWJlcih7XG4gICAgICAgICAgZGVzY3JpcHRpb246IFwiUGVyLWludm9jYXRpb24gdGltZW91dCAobXMpLiBDYXBwZWQgYXQgNjAwMDAwLiBEZWZhdWx0IGZyb20gcHJlZmVyZW5jZXMuXCIsXG4gICAgICAgICAgbWluaW11bTogMV8wMDAsXG4gICAgICAgICAgbWF4aW11bTogNjAwXzAwMCxcbiAgICAgICAgfSksXG4gICAgICApLFxuICAgIH0pLFxuICAgIGFzeW5jIGV4ZWN1dGUoX3Rvb2xDYWxsSWQsIHBhcmFtcywgX3NpZ25hbCwgX29uVXBkYXRlLCBfY3R4KSB7XG4gICAgICBjb25zdCB7IGV4ZWN1dGVHc2RFeGVjIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi90b29scy9leGVjLXRvb2wuanNcIik7XG4gICAgICBjb25zdCBiYXNlRGlyID0gcmVzb2x2ZUN0eEN3ZChfY3R4KTtcbiAgICAgIHJldHVybiBleGVjdXRlR3NkRXhlYyhwYXJhbXMgYXMgUGFyYW1ldGVyczx0eXBlb2YgZXhlY3V0ZUdzZEV4ZWM+WzBdLCB7XG4gICAgICAgIGJhc2VEaXIsXG4gICAgICAgIHByZWZlcmVuY2VzOiBhd2FpdCBsb2FkQ29udGV4dE1vZGVQcmVmZXJlbmNlcyhiYXNlRGlyKSxcbiAgICAgIH0pO1xuICAgIH0sXG4gIH0pO1xuXG4gIHBpLnJlZ2lzdGVyVG9vbCh7XG4gICAgbmFtZTogXCJnc2RfZXhlY19zZWFyY2hcIixcbiAgICBsYWJlbDogXCJTZWFyY2ggZ3NkX2V4ZWMgSGlzdG9yeVwiLFxuICAgIGRlc2NyaXB0aW9uOlxuICAgICAgXCJMaXN0IHByaW9yIGdzZF9leGVjIHJ1bnMgKG1vc3QgcmVjZW50IGZpcnN0KSBmcm9tIC5nc2QvZXhlYy8qLm1ldGEuanNvbi4gVXNlZnVsIGZvciBcIiArXG4gICAgICBcInJlZGlzY292ZXJpbmcgdGhlIHN0ZG91dF9wYXRoIG9mIGFuIGVhcmxpZXIgcnVuIHdpdGhvdXQgcmUtZXhlY3V0aW5nIGl0LiBSZWFkLW9ubHkuXCIsXG4gICAgcHJvbXB0U25pcHBldDogXCJTZWFyY2ggcHJpb3IgZ3NkX2V4ZWMgcnVucyBieSBzdWJzdHJpbmcsIHJ1bnRpbWUsIG9yIGZhaWxpbmctb25seSBmaWx0ZXJcIixcbiAgICBwcm9tcHRHdWlkZWxpbmVzOiBbXG4gICAgICBcIlVzZSB0aGlzIGJlZm9yZSByZS1ydW5uaW5nIGFuIGV4cGVuc2l2ZSBhbmFseXNpcyBcdTIwMTQgdGhlIHByaW9yIHJ1bidzIHN0ZG91dCBmaWxlIG1heSBzdGlsbCBhbnN3ZXIuXCIsXG4gICAgICBcIlRoZSBwcmV2aWV3IHNob3dzIHRoZSB0cmFpbGluZyB+MzAwIGNoYXJzIG9mIHN0ZG91dDsgcmVhZCBzdGRvdXRfcGF0aCBmb3IgcGVyc2lzdGVkIG91dHB1dC5cIixcbiAgICBdLFxuICAgIHBhcmFtZXRlcnM6IFR5cGUuT2JqZWN0KHtcbiAgICAgIHF1ZXJ5OiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiU3Vic3RyaW5nIG1hdGNoZWQgYWdhaW5zdCBpZCBhbmQgcHVycG9zZSAoY2FzZS1pbnNlbnNpdGl2ZSkuXCIgfSkpLFxuICAgICAgcnVudGltZTogVHlwZS5PcHRpb25hbChcbiAgICAgICAgVHlwZS5VbmlvbihbVHlwZS5MaXRlcmFsKFwiYmFzaFwiKSwgVHlwZS5MaXRlcmFsKFwibm9kZVwiKSwgVHlwZS5MaXRlcmFsKFwicHl0aG9uXCIpXSwge1xuICAgICAgICAgIGRlc2NyaXB0aW9uOiBcIlJlc3RyaWN0IHRvIG9uZSBydW50aW1lLlwiLFxuICAgICAgICB9KSxcbiAgICAgICksXG4gICAgICBmYWlsaW5nX29ubHk6IFR5cGUuT3B0aW9uYWwoVHlwZS5Cb29sZWFuKHsgZGVzY3JpcHRpb246IFwiT25seSBub24temVybyBleGl0IGNvZGVzIGFuZCB0aW1lb3V0cy5cIiB9KSksXG4gICAgICBsaW1pdDogVHlwZS5PcHRpb25hbChUeXBlLk51bWJlcih7IGRlc2NyaXB0aW9uOiBcIk1heCByZXN1bHRzIChkZWZhdWx0IDIwLCBjYXAgMjAwKVwiLCBtaW5pbXVtOiAxLCBtYXhpbXVtOiAyMDAgfSkpLFxuICAgIH0pLFxuICAgIGFzeW5jIGV4ZWN1dGUoX3Rvb2xDYWxsSWQsIHBhcmFtcywgX3NpZ25hbCwgX29uVXBkYXRlLCBfY3R4KSB7XG4gICAgICBjb25zdCB7IGV4ZWN1dGVFeGVjU2VhcmNoIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi90b29scy9leGVjLXNlYXJjaC10b29sLmpzXCIpO1xuICAgICAgY29uc3QgYmFzZURpciA9IHJlc29sdmVDdHhDd2QoX2N0eCk7XG4gICAgICByZXR1cm4gZXhlY3V0ZUV4ZWNTZWFyY2gocGFyYW1zIGFzIFBhcmFtZXRlcnM8dHlwZW9mIGV4ZWN1dGVFeGVjU2VhcmNoPlswXSwge1xuICAgICAgICBiYXNlRGlyLFxuICAgICAgICBwcmVmZXJlbmNlczogYXdhaXQgbG9hZENvbnRleHRNb2RlUHJlZmVyZW5jZXMoYmFzZURpciksXG4gICAgICB9KTtcbiAgICB9LFxuICB9KTtcblxuICBwaS5yZWdpc3RlclRvb2woe1xuICAgIG5hbWU6IFwiZ3NkX3Jlc3VtZVwiLFxuICAgIGxhYmVsOiBcIlJlc3VtZSAoUmVhZCBTbmFwc2hvdClcIixcbiAgICBkZXNjcmlwdGlvbjpcbiAgICAgIFwiUmV0dXJuIHRoZSBjb250ZW50cyBvZiAuZ3NkL2xhc3Qtc25hcHNob3QubWQgXHUyMDE0IGEgXHUyMjY0MiBLQiBkaWdlc3Qgb2YgdG9wIG1lbW9yaWVzLCByZWNlbnQgXCIgK1xuICAgICAgXCJnc2RfZXhlYyBydW5zLCBhbmQgYWN0aXZlIGNvbnRleHQsIHdyaXR0ZW4gYXV0b21hdGljYWxseSBvbiBzZXNzaW9uX2JlZm9yZV9jb21wYWN0LiBVc2UgXCIgK1xuICAgICAgXCJ0aGlzIGFmdGVyIGNvbXBhY3Rpb24gb3Igc2Vzc2lvbiByZXN1bWUgdG8gcmUtb3JpZW50IHF1aWNrbHkuXCIsXG4gICAgcHJvbXB0U25pcHBldDogXCJSZWFkIHRoZSBwcmUtY29tcGFjdGlvbiBzbmFwc2hvdCB0byByZS1vcmllbnQgYWZ0ZXIgY29udGV4dCBsb3NzXCIsXG4gICAgcHJvbXB0R3VpZGVsaW5lczogW1xuICAgICAgXCJDYWxsIHRoaXMgcmlnaHQgYWZ0ZXIgYSBzZXNzaW9uIHJlc3VtZXMgaWYgeW91IGZlZWwgeW91J3ZlIGxvc3QgZHVyYWJsZSBjb250ZXh0LlwiLFxuICAgICAgXCJUaGUgc25hcHNob3QgaXMgYSBzdW1tYXJ5IFx1MjAxNCB1c2UgbWVtb3J5X3F1ZXJ5IG9yIGdzZF9leGVjX3NlYXJjaCBmb3IgZGV0YWlsLlwiLFxuICAgIF0sXG4gICAgcGFyYW1ldGVyczogVHlwZS5PYmplY3Qoe30pLFxuICAgIGFzeW5jIGV4ZWN1dGUoX3Rvb2xDYWxsSWQsIHBhcmFtcywgX3NpZ25hbCwgX29uVXBkYXRlLCBfY3R4KSB7XG4gICAgICBjb25zdCB7IGV4ZWN1dGVSZXN1bWUgfSA9IGF3YWl0IGltcG9ydChcIi4uL3Rvb2xzL3Jlc3VtZS10b29sLmpzXCIpO1xuICAgICAgY29uc3QgYmFzZURpciA9IHJlc29sdmVDdHhDd2QoX2N0eCk7XG4gICAgICByZXR1cm4gZXhlY3V0ZVJlc3VtZShwYXJhbXMgYXMgUGFyYW1ldGVyczx0eXBlb2YgZXhlY3V0ZVJlc3VtZT5bMF0sIHtcbiAgICAgICAgYmFzZURpcixcbiAgICAgICAgcHJlZmVyZW5jZXM6IGF3YWl0IGxvYWRDb250ZXh0TW9kZVByZWZlcmVuY2VzKGJhc2VEaXIpLFxuICAgICAgfSk7XG4gICAgfSxcbiAgfSk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFPQSxTQUFTLFlBQVk7QUFHckIsU0FBUyxxQkFBcUI7QUFHOUIsZUFBZSwyQkFBMkIsU0FBaUI7QUFDekQsUUFBTSxDQUFDLEVBQUUsNEJBQTRCLEdBQUcsRUFBRSxXQUFXLENBQUMsSUFBSSxNQUFNLFFBQVEsSUFBSTtBQUFBLElBQzFFLE9BQU8sbUJBQW1CO0FBQUEsSUFDMUIsT0FBTyx1QkFBdUI7QUFBQSxFQUNoQyxDQUFDO0FBQ0QsTUFBSTtBQUNGLFdBQU8sNEJBQTRCLE9BQU8sR0FBRyxlQUFlO0FBQUEsRUFDOUQsU0FBUyxLQUFLO0FBQ1osZUFBVyxRQUFRLGlEQUFpRCxlQUFlLFFBQVEsSUFBSSxVQUFVLE9BQU8sR0FBRyxDQUFDLEVBQUU7QUFDdEgsV0FBTztBQUFBLEVBQ1Q7QUFDRjtBQUVPLFNBQVMsa0JBQWtCLElBQXdCO0FBQ3hELEtBQUcsYUFBYTtBQUFBLElBQ2QsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBLElBQ1AsYUFDRTtBQUFBLElBS0YsZUFDRTtBQUFBLElBQ0Ysa0JBQWtCO0FBQUEsTUFDaEI7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxJQUNGO0FBQUEsSUFDQSxZQUFZLEtBQUssT0FBTztBQUFBLE1BQ3RCLFNBQVMsS0FBSztBQUFBLFFBQ1osQ0FBQyxLQUFLLFFBQVEsTUFBTSxHQUFHLEtBQUssUUFBUSxNQUFNLEdBQUcsS0FBSyxRQUFRLFFBQVEsQ0FBQztBQUFBLFFBQ25FLEVBQUUsYUFBYSxzREFBc0Q7QUFBQSxNQUN2RTtBQUFBLE1BQ0EsUUFBUSxLQUFLLE9BQU8sRUFBRSxhQUFhLGtFQUFrRSxDQUFDO0FBQUEsTUFDdEcsU0FBUyxLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSxzREFBc0QsQ0FBQyxDQUFDO0FBQUEsTUFDMUcsWUFBWSxLQUFLO0FBQUEsUUFDZixLQUFLLE9BQU87QUFBQSxVQUNWLGFBQWE7QUFBQSxVQUNiLFNBQVM7QUFBQSxVQUNULFNBQVM7QUFBQSxRQUNYLENBQUM7QUFBQSxNQUNIO0FBQUEsSUFDRixDQUFDO0FBQUEsSUFDRCxNQUFNLFFBQVEsYUFBYSxRQUFRLFNBQVMsV0FBVyxNQUFNO0FBQzNELFlBQU0sRUFBRSxlQUFlLElBQUksTUFBTSxPQUFPLHVCQUF1QjtBQUMvRCxZQUFNLFVBQVUsY0FBYyxJQUFJO0FBQ2xDLGFBQU8sZUFBZSxRQUFnRDtBQUFBLFFBQ3BFO0FBQUEsUUFDQSxhQUFhLE1BQU0sMkJBQTJCLE9BQU87QUFBQSxNQUN2RCxDQUFDO0FBQUEsSUFDSDtBQUFBLEVBQ0YsQ0FBQztBQUVELEtBQUcsYUFBYTtBQUFBLElBQ2QsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBLElBQ1AsYUFDRTtBQUFBLElBRUYsZUFBZTtBQUFBLElBQ2Ysa0JBQWtCO0FBQUEsTUFDaEI7QUFBQSxNQUNBO0FBQUEsSUFDRjtBQUFBLElBQ0EsWUFBWSxLQUFLLE9BQU87QUFBQSxNQUN0QixPQUFPLEtBQUssU0FBUyxLQUFLLE9BQU8sRUFBRSxhQUFhLCtEQUErRCxDQUFDLENBQUM7QUFBQSxNQUNqSCxTQUFTLEtBQUs7QUFBQSxRQUNaLEtBQUssTUFBTSxDQUFDLEtBQUssUUFBUSxNQUFNLEdBQUcsS0FBSyxRQUFRLE1BQU0sR0FBRyxLQUFLLFFBQVEsUUFBUSxDQUFDLEdBQUc7QUFBQSxVQUMvRSxhQUFhO0FBQUEsUUFDZixDQUFDO0FBQUEsTUFDSDtBQUFBLE1BQ0EsY0FBYyxLQUFLLFNBQVMsS0FBSyxRQUFRLEVBQUUsYUFBYSx5Q0FBeUMsQ0FBQyxDQUFDO0FBQUEsTUFDbkcsT0FBTyxLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSxxQ0FBcUMsU0FBUyxHQUFHLFNBQVMsSUFBSSxDQUFDLENBQUM7QUFBQSxJQUNsSCxDQUFDO0FBQUEsSUFDRCxNQUFNLFFBQVEsYUFBYSxRQUFRLFNBQVMsV0FBVyxNQUFNO0FBQzNELFlBQU0sRUFBRSxrQkFBa0IsSUFBSSxNQUFNLE9BQU8sOEJBQThCO0FBQ3pFLFlBQU0sVUFBVSxjQUFjLElBQUk7QUFDbEMsYUFBTyxrQkFBa0IsUUFBbUQ7QUFBQSxRQUMxRTtBQUFBLFFBQ0EsYUFBYSxNQUFNLDJCQUEyQixPQUFPO0FBQUEsTUFDdkQsQ0FBQztBQUFBLElBQ0g7QUFBQSxFQUNGLENBQUM7QUFFRCxLQUFHLGFBQWE7QUFBQSxJQUNkLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLGFBQ0U7QUFBQSxJQUdGLGVBQWU7QUFBQSxJQUNmLGtCQUFrQjtBQUFBLE1BQ2hCO0FBQUEsTUFDQTtBQUFBLElBQ0Y7QUFBQSxJQUNBLFlBQVksS0FBSyxPQUFPLENBQUMsQ0FBQztBQUFBLElBQzFCLE1BQU0sUUFBUSxhQUFhLFFBQVEsU0FBUyxXQUFXLE1BQU07QUFDM0QsWUFBTSxFQUFFLGNBQWMsSUFBSSxNQUFNLE9BQU8seUJBQXlCO0FBQ2hFLFlBQU0sVUFBVSxjQUFjLElBQUk7QUFDbEMsYUFBTyxjQUFjLFFBQStDO0FBQUEsUUFDbEU7QUFBQSxRQUNBLGFBQWEsTUFBTSwyQkFBMkIsT0FBTztBQUFBLE1BQ3ZELENBQUM7QUFBQSxJQUNIO0FBQUEsRUFDRixDQUFDO0FBQ0g7IiwKICAibmFtZXMiOiBbXQp9Cg==
