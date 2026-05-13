import { Type } from "@sinclair/typebox";
import { queryJournal } from "../journal.js";
import { logWarning } from "../workflow-logger.js";
import { resolveCtxCwd } from "./dynamic-tools.js";
function registerJournalTools(pi) {
  pi.registerTool({
    name: "gsd_journal_query",
    label: "Query Journal",
    description: "Query the structured event journal for auto-mode iterations. Returns matching journal entries filtered by flow ID, unit ID, rule name, event type, or time range.",
    promptSnippet: "Query the GSD event journal with filters (flowId, unitId, rule, eventType, time range, limit)",
    promptGuidelines: [
      "Filter by flowId to trace all events from a single auto-mode iteration.",
      "Filter by unitId to reconstruct the causal chain for a specific milestone/slice/task.",
      "Use limit to control context size \u2014 default is 100 entries."
    ],
    parameters: Type.Object({
      flowId: Type.Optional(Type.String({ description: "Filter by flow ID (UUID grouping one iteration)" })),
      unitId: Type.Optional(Type.String({ description: "Filter by unit ID (e.g. M001/S01/T01) from event data" })),
      rule: Type.Optional(Type.String({ description: "Filter by rule name from the unified registry" })),
      eventType: Type.Optional(Type.String({ description: "Filter by event type (e.g. dispatch-match, unit-start)" })),
      after: Type.Optional(Type.String({ description: "ISO-8601 lower bound (inclusive)" })),
      before: Type.Optional(Type.String({ description: "ISO-8601 upper bound (inclusive)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum entries to return (default: 100)", default: 100 }))
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const filters = {};
        if (params.flowId !== void 0) filters.flowId = params.flowId;
        if (params.unitId !== void 0) filters.unitId = params.unitId;
        if (params.rule !== void 0) filters.rule = params.rule;
        if (params.eventType !== void 0) filters.eventType = params.eventType;
        if (params.after !== void 0) filters.after = params.after;
        if (params.before !== void 0) filters.before = params.before;
        const entries = queryJournal(resolveCtxCwd(_ctx), filters);
        const limited = entries.slice(0, params.limit ?? 100);
        if (limited.length === 0) {
          return {
            content: [{ type: "text", text: "No matching journal entries found." }],
            details: { operation: "journal_query", count: 0 }
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(limited, null, 2) }],
          details: { operation: "journal_query", count: limited.length }
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logWarning("tool", `gsd_journal_query tool failed: ${msg}`);
        return {
          content: [{ type: "text", text: `Error querying journal: ${msg}` }],
          details: { operation: "journal_query", error: msg }
        };
      }
    }
  });
}
export {
  registerJournalTools
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9ib290c3RyYXAvam91cm5hbC10b29scy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IFJlZ2lzdGVycyBqb3VybmFsIHF1ZXJ5IHRvb2xzLlxuaW1wb3J0IHsgVHlwZSB9IGZyb20gXCJAc2luY2xhaXIvdHlwZWJveFwiO1xuaW1wb3J0IHR5cGUgeyBFeHRlbnNpb25BUEkgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcblxuaW1wb3J0IHsgcXVlcnlKb3VybmFsIH0gZnJvbSBcIi4uL2pvdXJuYWwuanNcIjtcbmltcG9ydCB7IGxvZ1dhcm5pbmcgfSBmcm9tIFwiLi4vd29ya2Zsb3ctbG9nZ2VyLmpzXCI7XG5pbXBvcnQgeyByZXNvbHZlQ3R4Q3dkIH0gZnJvbSBcIi4vZHluYW1pYy10b29scy5qc1wiO1xuXG5cbmV4cG9ydCBmdW5jdGlvbiByZWdpc3RlckpvdXJuYWxUb29scyhwaTogRXh0ZW5zaW9uQVBJKTogdm9pZCB7XG4gIHBpLnJlZ2lzdGVyVG9vbCh7XG4gICAgbmFtZTogXCJnc2Rfam91cm5hbF9xdWVyeVwiLFxuICAgIGxhYmVsOiBcIlF1ZXJ5IEpvdXJuYWxcIixcbiAgICBkZXNjcmlwdGlvbjpcbiAgICAgIFwiUXVlcnkgdGhlIHN0cnVjdHVyZWQgZXZlbnQgam91cm5hbCBmb3IgYXV0by1tb2RlIGl0ZXJhdGlvbnMuIFwiICtcbiAgICAgIFwiUmV0dXJucyBtYXRjaGluZyBqb3VybmFsIGVudHJpZXMgZmlsdGVyZWQgYnkgZmxvdyBJRCwgdW5pdCBJRCwgcnVsZSBuYW1lLCBldmVudCB0eXBlLCBvciB0aW1lIHJhbmdlLlwiLFxuICAgIHByb21wdFNuaXBwZXQ6IFwiUXVlcnkgdGhlIEdTRCBldmVudCBqb3VybmFsIHdpdGggZmlsdGVycyAoZmxvd0lkLCB1bml0SWQsIHJ1bGUsIGV2ZW50VHlwZSwgdGltZSByYW5nZSwgbGltaXQpXCIsXG4gICAgcHJvbXB0R3VpZGVsaW5lczogW1xuICAgICAgXCJGaWx0ZXIgYnkgZmxvd0lkIHRvIHRyYWNlIGFsbCBldmVudHMgZnJvbSBhIHNpbmdsZSBhdXRvLW1vZGUgaXRlcmF0aW9uLlwiLFxuICAgICAgXCJGaWx0ZXIgYnkgdW5pdElkIHRvIHJlY29uc3RydWN0IHRoZSBjYXVzYWwgY2hhaW4gZm9yIGEgc3BlY2lmaWMgbWlsZXN0b25lL3NsaWNlL3Rhc2suXCIsXG4gICAgICBcIlVzZSBsaW1pdCB0byBjb250cm9sIGNvbnRleHQgc2l6ZSBcdTIwMTQgZGVmYXVsdCBpcyAxMDAgZW50cmllcy5cIixcbiAgICBdLFxuICAgIHBhcmFtZXRlcnM6IFR5cGUuT2JqZWN0KHtcbiAgICAgIGZsb3dJZDogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIkZpbHRlciBieSBmbG93IElEIChVVUlEIGdyb3VwaW5nIG9uZSBpdGVyYXRpb24pXCIgfSkpLFxuICAgICAgdW5pdElkOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiRmlsdGVyIGJ5IHVuaXQgSUQgKGUuZy4gTTAwMS9TMDEvVDAxKSBmcm9tIGV2ZW50IGRhdGFcIiB9KSksXG4gICAgICBydWxlOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiRmlsdGVyIGJ5IHJ1bGUgbmFtZSBmcm9tIHRoZSB1bmlmaWVkIHJlZ2lzdHJ5XCIgfSkpLFxuICAgICAgZXZlbnRUeXBlOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiRmlsdGVyIGJ5IGV2ZW50IHR5cGUgKGUuZy4gZGlzcGF0Y2gtbWF0Y2gsIHVuaXQtc3RhcnQpXCIgfSkpLFxuICAgICAgYWZ0ZXI6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJJU08tODYwMSBsb3dlciBib3VuZCAoaW5jbHVzaXZlKVwiIH0pKSxcbiAgICAgIGJlZm9yZTogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIklTTy04NjAxIHVwcGVyIGJvdW5kIChpbmNsdXNpdmUpXCIgfSkpLFxuICAgICAgbGltaXQ6IFR5cGUuT3B0aW9uYWwoVHlwZS5OdW1iZXIoeyBkZXNjcmlwdGlvbjogXCJNYXhpbXVtIGVudHJpZXMgdG8gcmV0dXJuIChkZWZhdWx0OiAxMDApXCIsIGRlZmF1bHQ6IDEwMCB9KSksXG4gICAgfSksXG4gICAgYXN5bmMgZXhlY3V0ZShfdG9vbENhbGxJZCwgcGFyYW1zLCBfc2lnbmFsLCBfb25VcGRhdGUsIF9jdHgpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGZpbHRlcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IHVuZGVmaW5lZD4gPSB7fTtcbiAgICAgICAgaWYgKHBhcmFtcy5mbG93SWQgIT09IHVuZGVmaW5lZCkgZmlsdGVycy5mbG93SWQgPSBwYXJhbXMuZmxvd0lkO1xuICAgICAgICBpZiAocGFyYW1zLnVuaXRJZCAhPT0gdW5kZWZpbmVkKSBmaWx0ZXJzLnVuaXRJZCA9IHBhcmFtcy51bml0SWQ7XG4gICAgICAgIGlmIChwYXJhbXMucnVsZSAhPT0gdW5kZWZpbmVkKSBmaWx0ZXJzLnJ1bGUgPSBwYXJhbXMucnVsZTtcbiAgICAgICAgaWYgKHBhcmFtcy5ldmVudFR5cGUgIT09IHVuZGVmaW5lZCkgZmlsdGVycy5ldmVudFR5cGUgPSBwYXJhbXMuZXZlbnRUeXBlO1xuICAgICAgICBpZiAocGFyYW1zLmFmdGVyICE9PSB1bmRlZmluZWQpIGZpbHRlcnMuYWZ0ZXIgPSBwYXJhbXMuYWZ0ZXI7XG4gICAgICAgIGlmIChwYXJhbXMuYmVmb3JlICE9PSB1bmRlZmluZWQpIGZpbHRlcnMuYmVmb3JlID0gcGFyYW1zLmJlZm9yZTtcblxuICAgICAgICBjb25zdCBlbnRyaWVzID0gcXVlcnlKb3VybmFsKHJlc29sdmVDdHhDd2QoX2N0eCksIGZpbHRlcnMpO1xuICAgICAgICBjb25zdCBsaW1pdGVkID0gZW50cmllcy5zbGljZSgwLCBwYXJhbXMubGltaXQgPz8gMTAwKTtcblxuICAgICAgICBpZiAobGltaXRlZC5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IFwiTm8gbWF0Y2hpbmcgam91cm5hbCBlbnRyaWVzIGZvdW5kLlwiIH1dLFxuICAgICAgICAgICAgZGV0YWlsczogeyBvcGVyYXRpb246IFwiam91cm5hbF9xdWVyeVwiLCBjb3VudDogMCB9IGFzIGFueSxcbiAgICAgICAgICB9O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dDogSlNPTi5zdHJpbmdpZnkobGltaXRlZCwgbnVsbCwgMikgfV0sXG4gICAgICAgICAgZGV0YWlsczogeyBvcGVyYXRpb246IFwiam91cm5hbF9xdWVyeVwiLCBjb3VudDogbGltaXRlZC5sZW5ndGggfSBhcyBhbnksXG4gICAgICAgIH07XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgY29uc3QgbXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICAgICAgICBsb2dXYXJuaW5nKFwidG9vbFwiLCBgZ3NkX2pvdXJuYWxfcXVlcnkgdG9vbCBmYWlsZWQ6ICR7bXNnfWApO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBgRXJyb3IgcXVlcnlpbmcgam91cm5hbDogJHttc2d9YCB9XSxcbiAgICAgICAgICBkZXRhaWxzOiB7IG9wZXJhdGlvbjogXCJqb3VybmFsX3F1ZXJ5XCIsIGVycm9yOiBtc2cgfSBhcyBhbnksXG4gICAg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
