import { Type } from "@sinclair/typebox";
import { ensureDbOpen, resolveCtxCwd } from "./dynamic-tools.js";
import {
  executeGsdGraph,
  executeMemoryCapture,
  executeMemoryQuery
} from "../tools/memory-tools.js";
function registerMemoryTools(pi) {
  pi.registerTool({
    name: "capture_thought",
    label: "Capture Thought",
    description: "Record a durable piece of project knowledge (decision, convention, gotcha, pattern, preference, or environment detail) into the GSD memory store. Use sparingly \u2014 one memory per genuinely reusable insight, not per task.",
    promptSnippet: "Capture a durable project insight into the GSD memory store (categories: architecture, convention, gotcha, pattern, preference, environment)",
    promptGuidelines: [
      "Use capture_thought for insights that will remain useful across future sessions.",
      "Do NOT capture one-off bug fixes, temporary state, secrets, or task-specific details.",
      "Keep content to 1\u20133 sentences.",
      "Set confidence: 0.6 tentative, 0.8 solid, 0.95 well-confirmed (default 0.8)."
    ],
    parameters: Type.Object({
      category: Type.Union(
        [
          Type.Literal("architecture"),
          Type.Literal("convention"),
          Type.Literal("gotcha"),
          Type.Literal("preference"),
          Type.Literal("environment"),
          Type.Literal("pattern")
        ],
        { description: "Memory category" }
      ),
      content: Type.String({ description: "The memory text (1\u20133 sentences, no secrets)" }),
      confidence: Type.Optional(
        Type.Number({ description: "0.1\u20130.99, default 0.8", minimum: 0.1, maximum: 0.99 })
      ),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Free-form tags (reserved for future use)" })),
      scope: Type.Optional(Type.String({ description: "Scope name (reserved for future use; defaults to project)" })),
      structuredFields: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "Optional structured payload preserved alongside content (ADR-013). Use for decisions to retain scope/decision/choice/rationale/made_by/revisable. Omit for plain captures."
        })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const ok = await ensureDbOpen(resolveCtxCwd(_ctx));
      if (!ok) {
        return {
          content: [{ type: "text", text: "Error: GSD database is not available. Cannot capture memory." }],
          details: { operation: "memory_capture", error: "db_unavailable" },
          isError: true
        };
      }
      return executeMemoryCapture(params);
    }
  });
  pi.registerTool({
    name: "memory_query",
    label: "Query Memory",
    description: "Search the GSD memory store for relevant memories. Phase 1 uses keyword matching ranked by confidence and reinforcement; future phases add semantic (embedding) retrieval.",
    promptSnippet: "Search the GSD memory store by keyword; returns ranked memories with id, category, and content",
    promptGuidelines: [
      "Use memory_query when you need durable project context that may not be in the current prompt.",
      "Provide a short keyword-style query \u2014 not a full question.",
      "Use category to narrow results to gotchas, conventions, architecture notes, etc."
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Keyword query (2+ char terms)" }),
      k: Type.Optional(Type.Number({ description: "Max results (default 10, max 50)", minimum: 1, maximum: 50 })),
      category: Type.Optional(
        Type.Union(
          [
            Type.Literal("architecture"),
            Type.Literal("convention"),
            Type.Literal("gotcha"),
            Type.Literal("preference"),
            Type.Literal("environment"),
            Type.Literal("pattern")
          ],
          { description: "Restrict results to a single category" }
        )
      ),
      scope: Type.Optional(Type.String({ description: "Only include memories with this scope (e.g. 'project', 'global')" })),
      tag: Type.Optional(Type.String({ description: "Only include memories tagged with this value" })),
      include_superseded: Type.Optional(Type.Boolean({ description: "Include superseded memories (default false)" })),
      reinforce_hits: Type.Optional(
        Type.Boolean({ description: "Increment hit_count on returned memories (default false)" })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const ok = await ensureDbOpen(resolveCtxCwd(_ctx));
      if (!ok) {
        return {
          content: [{ type: "text", text: "Error: GSD database is not available. Cannot query memory." }],
          details: { operation: "memory_query", error: "db_unavailable" },
          isError: true
        };
      }
      return executeMemoryQuery(params);
    }
  });
  pi.registerTool({
    name: "gsd_graph",
    label: "GSD Knowledge Graph",
    description: "Inspect the relationship graph between memories. mode=query walks supersedes edges from a given memoryId; mode=build is a placeholder that future phases will use to rebuild graph edges from milestone LEARNINGS artifacts.",
    promptSnippet: "Query the memory relationship graph or trigger a rebuild",
    promptGuidelines: [
      "Use mode=query with a memoryId when you want to see how a memory relates to others.",
      "Phase 1 only exposes supersedes edges; additional relation types arrive in later phases."
    ],
    parameters: Type.Object({
      mode: Type.Union([Type.Literal("build"), Type.Literal("query")], {
        description: "build = recompute graph (placeholder), query = inspect edges"
      }),
      memoryId: Type.Optional(Type.String({ description: "Memory ID (required when mode=query)" })),
      depth: Type.Optional(Type.Number({ description: "Hops to traverse (0\u20135, default 1)", minimum: 0, maximum: 5 })),
      rel: Type.Optional(Type.Union([
        Type.Literal("related_to"),
        Type.Literal("depends_on"),
        Type.Literal("contradicts"),
        Type.Literal("elaborates"),
        Type.Literal("supersedes")
      ], { description: "Only include edges with this relation type" }))
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const ok = await ensureDbOpen(resolveCtxCwd(_ctx));
      if (!ok) {
        return {
          content: [{ type: "text", text: "Error: GSD database is not available." }],
          details: { operation: "gsd_graph", error: "db_unavailable" },
          isError: true
        };
      }
      return executeGsdGraph(params);
    }
  });
}
export {
  registerMemoryTools
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9ib290c3RyYXAvbWVtb3J5LXRvb2xzLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBQcm9qZWN0L0FwcDogR1NELTJcbi8vIEZpbGUgUHVycG9zZTogUmVnaXN0ZXJzIG1lbW9yeS1sYXllciB0b29scy5cbi8vIEdTRDIgXHUyMDE0IE1lbW9yeSB0b29sIHJlZ2lzdHJhdGlvblxuLy9cbi8vIEV4cG9zZXMgdGhlIG1lbW9yeS1sYXllciB0b29scyAoY2FwdHVyZV90aG91Z2h0LCBtZW1vcnlfcXVlcnksIGdzZF9ncmFwaClcbi8vIHRvIHRoZSBMTE0gb3ZlciBNQ1AuIEFsbCB0aHJlZSBkZWdyYWRlIGdyYWNlZnVsbHkgd2hlbiB0aGUgR1NEIGRhdGFiYXNlXG4vLyBpcyB1bmF2YWlsYWJsZS5cblxuaW1wb3J0IHsgVHlwZSB9IGZyb20gXCJAc2luY2xhaXIvdHlwZWJveFwiO1xuaW1wb3J0IHR5cGUgeyBFeHRlbnNpb25BUEkgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcblxuaW1wb3J0IHsgZW5zdXJlRGJPcGVuLCByZXNvbHZlQ3R4Q3dkIH0gZnJvbSBcIi4vZHluYW1pYy10b29scy5qc1wiO1xuaW1wb3J0IHtcbiAgZXhlY3V0ZUdzZEdyYXBoLFxuICBleGVjdXRlTWVtb3J5Q2FwdHVyZSxcbiAgZXhlY3V0ZU1lbW9yeVF1ZXJ5LFxufSBmcm9tIFwiLi4vdG9vbHMvbWVtb3J5LXRvb2xzLmpzXCI7XG5cblxuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVyTWVtb3J5VG9vbHMocGk6IEV4dGVuc2lvbkFQSSk6IHZvaWQge1xuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgY2FwdHVyZV90aG91Z2h0IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4gIHBpLnJlZ2lzdGVyVG9vbCh7XG4gICAgbmFtZTogXCJjYXB0dXJlX3Rob3VnaHRcIixcbiAgICBsYWJlbDogXCJDYXB0dXJlIFRob3VnaHRcIixcbiAgICBkZXNjcmlwdGlvbjpcbiAgICAgIFwiUmVjb3JkIGEgZHVyYWJsZSBwaWVjZSBvZiBwcm9qZWN0IGtub3dsZWRnZSAoZGVjaXNpb24sIGNvbnZlbnRpb24sIGdvdGNoYSwgcGF0dGVybiwgXCIgK1xuICAgICAgXCJwcmVmZXJlbmNlLCBvciBlbnZpcm9ubWVudCBkZXRhaWwpIGludG8gdGhlIEdTRCBtZW1vcnkgc3RvcmUuIFVzZSBzcGFyaW5nbHkgXHUyMDE0IG9uZSBtZW1vcnkgXCIgK1xuICAgICAgXCJwZXIgZ2VudWluZWx5IHJldXNhYmxlIGluc2lnaHQsIG5vdCBwZXIgdGFzay5cIixcbiAgICBwcm9tcHRTbmlwcGV0OlxuICAgICAgXCJDYXB0dXJlIGEgZHVyYWJsZSBwcm9qZWN0IGluc2lnaHQgaW50byB0aGUgR1NEIG1lbW9yeSBzdG9yZSAoY2F0ZWdvcmllczogYXJjaGl0ZWN0dXJlLCBjb252ZW50aW9uLCBnb3RjaGEsIHBhdHRlcm4sIHByZWZlcmVuY2UsIGVudmlyb25tZW50KVwiLFxuICAgIHByb21wdEd1aWRlbGluZXM6IFtcbiAgICAgIFwiVXNlIGNhcHR1cmVfdGhvdWdodCBmb3IgaW5zaWdodHMgdGhhdCB3aWxsIHJlbWFpbiB1c2VmdWwgYWNyb3NzIGZ1dHVyZSBzZXNzaW9ucy5cIixcbiAgICAgIFwiRG8gTk9UIGNhcHR1cmUgb25lLW9mZiBidWcgZml4ZXMsIHRlbXBvcmFyeSBzdGF0ZSwgc2VjcmV0cywgb3IgdGFzay1zcGVjaWZpYyBkZXRhaWxzLlwiLFxuICAgICAgXCJLZWVwIGNvbnRlbnQgdG8gMVx1MjAxMzMgc2VudGVuY2VzLlwiLFxuICAgICAgXCJTZXQgY29uZmlkZW5jZTogMC42IHRlbnRhdGl2ZSwgMC44IHNvbGlkLCAwLjk1IHdlbGwtY29uZmlybWVkIChkZWZhdWx0IDAuOCkuXCIsXG4gICAgXSxcbiAgICBwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG4gICAgICBjYXRlZ29yeTogVHlwZS5VbmlvbihcbiAgICAgICAgW1xuICAgICAgICAgIFR5cGUuTGl0ZXJhbChcImFyY2hpdGVjdHVyZVwiKSxcbiAgICAgICAgICBUeXBlLkxpdGVyYWwoXCJjb252ZW50aW9uXCIpLFxuICAgICAgICAgIFR5cGUuTGl0ZXJhbChcImdvdGNoYVwiKSxcbiAgICAgICAgICBUeXBlLkxpdGVyYWwoXCJwcmVmZXJlbmNlXCIpLFxuICAgICAgICAgIFR5cGUuTGl0ZXJhbChcImVudmlyb25tZW50XCIpLFxuICAgICAgICAgIFR5cGUuTGl0ZXJhbChcInBhdHRlcm5cIiksXG4gICAgICAgIF0sXG4gICAgICAgIHsgZGVzY3JpcHRpb246IFwiTWVtb3J5IGNhdGVnb3J5XCIgfSxcbiAgICAgICksXG4gICAgICBjb250ZW50OiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIlRoZSBtZW1vcnkgdGV4dCAoMVx1MjAxMzMgc2VudGVuY2VzLCBubyBzZWNyZXRzKVwiIH0pLFxuICAgICAgY29uZmlkZW5jZTogVHlwZS5PcHRpb25hbChcbiAgICAgICAgVHlwZS5OdW1iZXIoeyBkZXNjcmlwdGlvbjogXCIwLjFcdTIwMTMwLjk5LCBkZWZhdWx0IDAuOFwiLCBtaW5pbXVtOiAwLjEsIG1heGltdW06IDAuOTkgfSksXG4gICAgICApLFxuICAgICAgdGFnczogVHlwZS5PcHRpb25hbChUeXBlLkFycmF5KFR5cGUuU3RyaW5nKCksIHsgZGVzY3JpcHRpb246IFwiRnJlZS1mb3JtIHRhZ3MgKHJlc2VydmVkIGZvciBmdXR1cmUgdXNlKVwiIH0pKSxcbiAgICAgIHNjb3BlOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiU2NvcGUgbmFtZSAocmVzZXJ2ZWQgZm9yIGZ1dHVyZSB1c2U7IGRlZmF1bHRzIHRvIHByb2plY3QpXCIgfSkpLFxuICAgICAgc3RydWN0dXJlZEZpZWxkczogVHlwZS5PcHRpb25hbChcbiAgICAgICAgVHlwZS5SZWNvcmQoVHlwZS5TdHJpbmcoKSwgVHlwZS5Vbmtub3duKCksIHtcbiAgICAgICAgICBkZXNjcmlwdGlvbjogXCJPcHRpb25hbCBzdHJ1Y3R1cmVkIHBheWxvYWQgcHJlc2VydmVkIGFsb25nc2lkZSBjb250ZW50IChBRFItMDEzKS4gVXNlIGZvciBkZWNpc2lvbnMgdG8gcmV0YWluIHNjb3BlL2RlY2lzaW9uL2Nob2ljZS9yYXRpb25hbGUvbWFkZV9ieS9yZXZpc2FibGUuIE9taXQgZm9yIHBsYWluIGNhcHR1cmVzLlwiLFxuICAgICAgICB9KSxcbiAgICAgICksXG4gICAgfSksXG4gICAgYXN5bmMgZXhlY3V0ZShfdG9vbENhbGxJZCwgcGFyYW1zLCBfc2lnbmFsLCBfb25VcGRhdGUsIF9jdHgpIHtcbiAgICAgIGNvbnN0IG9rID0gYXdhaXQgZW5zdXJlRGJPcGVuKHJlc29sdmVDdHhDd2QoX2N0eCkpO1xuICAgICAgaWYgKCFvaykge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBcIkVycm9yOiBHU0QgZGF0YWJhc2UgaXMgbm90IGF2YWlsYWJsZS4gQ2Fubm90IGNhcHR1cmUgbWVtb3J5LlwiIH1dLFxuICAgICAgICAgIGRldGFpbHM6IHsgb3BlcmF0aW9uOiBcIm1lbW9yeV9jYXB0dXJlXCIsIGVycm9yOiBcImRiX3VuYXZhaWxhYmxlXCIgfSxcbiAgICAgICAgICBpc0Vycm9yOiB0cnVlLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgcmV0dXJuIGV4ZWN1dGVNZW1vcnlDYXB0dXJlKHBhcmFtcyBhcyBQYXJhbWV0ZXJzPHR5cGVvZiBleGVjdXRlTWVtb3J5Q2FwdHVyZT5bMF0pO1xuICAgIH0sXG4gIH0pO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBtZW1vcnlfcXVlcnkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbiAgcGkucmVnaXN0ZXJUb29sKHtcbiAgICBuYW1lOiBcIm1lbW9yeV9xdWVyeVwiLFxuICAgIGxhYmVsOiBcIlF1ZXJ5IE1lbW9yeVwiLFxuICAgIGRlc2NyaXB0aW9uOlxuICAgICAgXCJTZWFyY2ggdGhlIEdTRCBtZW1vcnkgc3RvcmUgZm9yIHJlbGV2YW50IG1lbW9yaWVzLiBQaGFzZSAxIHVzZXMga2V5d29yZCBtYXRjaGluZyByYW5rZWQgXCIgK1xuICAgICAgXCJieSBjb25maWRlbmNlIGFuZCByZWluZm9yY2VtZW50OyBmdXR1cmUgcGhhc2VzIGFkZCBzZW1hbnRpYyAoZW1iZWRkaW5nKSByZXRyaWV2YWwuXCIsXG4gICAgcHJvbXB0U25pcHBldDpcbiAgICAgIFwiU2VhcmNoIHRoZSBHU0QgbWVtb3J5IHN0b3JlIGJ5IGtleXdvcmQ7IHJldHVybnMgcmFua2VkIG1lbW9yaWVzIHdpdGggaWQsIGNhdGVnb3J5LCBhbmQgY29udGVudFwiLFxuICAgIHByb21wdEd1aWRlbGluZXM6IFtcbiAgICAgIFwiVXNlIG1lbW9yeV9xdWVyeSB3aGVuIHlvdSBuZWVkIGR1cmFibGUgcHJvamVjdCBjb250ZXh0IHRoYXQgbWF5IG5vdCBiZSBpbiB0aGUgY3VycmVudCBwcm9tcHQuXCIsXG4gICAgICBcIlByb3ZpZGUgYSBzaG9ydCBrZXl3b3JkLXN0eWxlIHF1ZXJ5IFx1MjAxNCBub3QgYSBmdWxsIHF1ZXN0aW9uLlwiLFxuICAgICAgXCJVc2UgY2F0ZWdvcnkgdG8gbmFycm93IHJlc3VsdHMgdG8gZ290Y2hhcywgY29udmVudGlvbnMsIGFyY2hpdGVjdHVyZSBub3RlcywgZXRjLlwiLFxuICAgIF0sXG4gICAgcGFyYW1ldGVyczogVHlwZS5PYmplY3Qoe1xuICAgICAgcXVlcnk6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiS2V5d29yZCBxdWVyeSAoMisgY2hhciB0ZXJtcylcIiB9KSxcbiAgICAgIGs6IFR5cGUuT3B0aW9uYWwoVHlwZS5OdW1iZXIoeyBkZXNjcmlwdGlvbjogXCJNYXggcmVzdWx0cyAoZGVmYXVsdCAxMCwgbWF4IDUwKVwiLCBtaW5pbXVtOiAxLCBtYXhpbXVtOiA1MCB9KSksXG4gICAgICBjYXRlZ29yeTogVHlwZS5PcHRpb25hbChcbiAgICAgICAgVHlwZS5VbmlvbihcbiAgICAgICAgICBbXG4gICAgICAgICAgICBUeXBlLkxpdGVyYWwoXCJhcmNoaXRlY3R1cmVcIiksXG4gICAgICAgICAgICBUeXBlLkxpdGVyYWwoXCJjb252ZW50aW9uXCIpLFxuICAgICAgICAgICAgVHlwZS5MaXRlcmFsKFwiZ290Y2hhXCIpLFxuICAgICAgICAgICAgVHlwZS5MaXRlcmFsKFwicHJlZmVyZW5jZVwiKSxcbiAgICAgICAgICAgIFR5cGUuTGl0ZXJhbChcImVudmlyb25tZW50XCIpLFxuICAgICAgICAgICAgVHlwZS5MaXRlcmFsKFwicGF0dGVyblwiKSxcbiAgICAgICAgICBdLFxuICAgICAgICAgIHsgZGVzY3JpcHRpb246IFwiUmVzdHJpY3QgcmVzdWx0cyB0byBhIHNpbmdsZSBjYXRlZ29yeVwiIH0sXG4gICAgICAgICksXG4gICAgICApLFxuICAgICAgc2NvcGU6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJPbmx5IGluY2x1ZGUgbWVtb3JpZXMgd2l0aCB0aGlzIHNjb3BlIChlLmcuICdwcm9qZWN0JywgJ2dsb2JhbCcpXCIgfSkpLFxuICAgICAgdGFnOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiT25seSBpbmNsdWRlIG1lbW9yaWVzIHRhZ2dlZCB3aXRoIHRoaXMgdmFsdWVcIiB9KSksXG4gICAgICBpbmNsdWRlX3N1cGVyc2VkZWQ6IFR5cGUuT3B0aW9uYWwoVHlwZS5Cb29sZWFuKHsgZGVzY3JpcHRpb246IFwiSW5jbHVkZSBzdXBlcnNlZGVkIG1lbW9yaWVzIChkZWZhdWx0IGZhbHNlKVwiIH0pKSxcbiAgICAgIHJlaW5mb3JjZV9oaXRzOiBUeXBlLk9wdGlvbmFsKFxuICAgICAgICBUeXBlLkJvb2xlYW4oeyBkZXNjcmlwdGlvbjogXCJJbmNyZW1lbnQgaGl0X2NvdW50IG9uIHJldHVybmVkIG1lbW9yaWVzIChkZWZhdWx0IGZhbHNlKVwiIH0pLFxuICAgICAgKSxcbiAgICB9KSxcbiAgICBhc3luYyBleGVjdXRlKF90b29sQ2FsbElkLCBwYXJhbXMsIF9zaWduYWwsIF9vblVwZGF0ZSwgX2N0eCkge1xuICAgICAgY29uc3Qgb2sgPSBhd2FpdCBlbnN1cmVEYk9wZW4ocmVzb2x2ZUN0eEN3ZChfY3R4KSk7XG4gICAgICBpZiAoIW9rKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IFwiRXJyb3I6IEdTRCBkYXRhYmFzZSBpcyBub3QgYXZhaWxhYmxlLiBDYW5ub3QgcXVlcnkgbWVtb3J5LlwiIH1dLFxuICAgICAgICAgIGRldGFpbHM6IHsgb3BlcmF0aW9uOiBcIm1lbW9yeV9xdWVyeVwiLCBlcnJvcjogXCJkYl91bmF2YWlsYWJsZVwiIH0sXG4gICAgICAgICAgaXNFcnJvcjogdHJ1ZSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBleGVjdXRlTWVtb3J5UXVlcnkocGFyYW1zIGFzIFBhcmFtZXRlcnM8dHlwZW9mIGV4ZWN1dGVNZW1vcnlRdWVyeT5bMF0pO1xuICAgIH0sXG4gIH0pO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBnc2RfZ3JhcGggXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbiAgcGkucmVnaXN0ZXJUb29sKHtcbiAgICBuYW1lOiBcImdzZF9ncmFwaFwiLFxuICAgIGxhYmVsOiBcIkdTRCBLbm93bGVkZ2UgR3JhcGhcIixcbiAgICBkZXNjcmlwdGlvbjpcbiAgICAgIFwiSW5zcGVjdCB0aGUgcmVsYXRpb25zaGlwIGdyYXBoIGJldHdlZW4gbWVtb3JpZXMuIG1vZGU9cXVlcnkgd2Fsa3Mgc3VwZXJzZWRlcyBlZGdlcyBmcm9tIGEgXCIgK1xuICAgICAgXCJnaXZlbiBtZW1vcnlJZDsgbW9kZT1idWlsZCBpcyBhIHBsYWNlaG9sZGVyIHRoYXQgZnV0dXJlIHBoYXNlcyB3aWxsIHVzZSB0byByZWJ1aWxkIGdyYXBoIFwiICtcbiAgICAgIFwiZWRnZXMgZnJvbSBtaWxlc3RvbmUgTEVBUk5JTkdTIGFydGlmYWN0cy5cIixcbiAgICBwcm9tcHRTbmlwcGV0OiBcIlF1ZXJ5IHRoZSBtZW1vcnkgcmVsYXRpb25zaGlwIGdyYXBoIG9yIHRyaWdnZXIgYSByZWJ1aWxkXCIsXG4gICAgcHJvbXB0R3VpZGVsaW5lczogW1xuICAgICAgXCJVc2UgbW9kZT1xdWVyeSB3aXRoIGEgbWVtb3J5SWQgd2hlbiB5b3Ugd2FudCB0byBzZWUgaG93IGEgbWVtb3J5IHJlbGF0ZXMgdG8gb3RoZXJzLlwiLFxuICAgICAgXCJQaGFzZSAxIG9ubHkgZXhwb3NlcyBzdXBlcnNlZGVzIGVkZ2VzOyBhZGRpdGlvbmFsIHJlbGF0aW9uIHR5cGVzIGFycml2ZSBpbiBsYXRlciBwaGFzZXMuXCIsXG4gICAgXSxcbiAgICBwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG4gICAgICBtb2RlOiBUeXBlLlVuaW9uKFtUeXBlLkxpdGVyYWwoXCJidWlsZFwiKSwgVHlwZS5MaXRlcmFsKFwicXVlcnlcIildLCB7XG4gICAgICAgIGRlc2NyaXB0aW9uOiBcImJ1aWxkID0gcmVjb21wdXRlIGdyYXBoIChwbGFjZWhvbGRlciksIHF1ZXJ5ID0gaW5zcGVjdCBlZGdlc1wiLFxuICAgICAgfSksXG4gICAgICBtZW1vcnlJZDogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIk1lbW9yeSBJRCAocmVxdWlyZWQgd2hlbiBtb2RlPXF1ZXJ5KVwiIH0pKSxcbiAgICAgIGRlcHRoOiBUeXBlLk9wdGlvbmFsKFR5cGUuTnVtYmVyKHsgZGVzY3JpcHRpb246IFwiSG9wcyB0byB0cmF2ZXJzZSAoMFx1MjAxMzUsIGRlZmF1bHQgMSlcIiwgbWluaW11bTogMCwgbWF4aW11bTogNSB9KSksXG4gICAgICByZWw6IFR5cGUuT3B0aW9uYWwoVHlwZS5VbmlvbihbXG4gICAgICAgIFR5cGUuTGl0ZXJhbChcInJlbGF0ZWRfdG9cIiksXG4gICAgICAgIFR5cGUuTGl0ZXJhbChcImRlcGVuZHNfb25cIiksXG4gICAgICAgIFR5cGUuTGl0ZXJhbChcImNvbnRyYWRpY3RzXCIpLFxuICAgICAgICBUeXBlLkxpdGVyYWwoXCJlbGFib3JhdGVzXCIpLFxuICAgICAgICBUeXBlLkxpdGVyYWwoXCJzdXBlcnNlZGVzXCIpLFxuICAgICAgXSwgeyBkZXNjcmlwdGlvbjogXCJPbmx5IGluY2x1ZGUgZWRnZXMgd2l0aCB0aGlzIHJlbGF0aW9uIHR5cGVcIiB9KSksXG4gICAgfSksXG4gICAgYXN5bmMgZXhlY3V0ZShfdG9vbENhbGxJZCwgcGFyYW1zLCBfc2lnbmFsLCBfb25VcGRhdGUsIF9jdHgpIHtcbiAgICAgIGNvbnN0IG9rID0gYXdhaXQgZW5zdXJlRGJPcGVuKHJlc29sdmVDdHhDd2QoX2N0eCkpO1xuICAgICAgaWYgKCFvaykge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBcIkVycm9yOiBHU0QgZGF0YWJhc2UgaXMgbm90IGF2YWlsYWJsZS5cIiB9XSxcbiAgICAgICAgICBkZXRhaWxzOiB7IG9wZXJhdGlvbjogXCJnc2RfZ3JhcGhcIiwgZXJyb3I6IFwiZGJfdW5hdmFpbGFibGVcIiB9LFxuICAgICAgICAgIGlzRXJyb3I6IHRydWUsXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICByZXR1cm4gZXhlY3V0ZUdzZEdyYXBoKHBhcmFtcyBhcyBQYXJhbWV0ZXJzPHR5cGVvZiBleGVjdXRlR3NkR3JhcGg+WzBdKTtcbiAgICB9LFxuICB9KTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQVFBLFNBQVMsWUFBWTtBQUdyQixTQUFTLGNBQWMscUJBQXFCO0FBQzVDO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUdBLFNBQVMsb0JBQW9CLElBQXdCO0FBRzFELEtBQUcsYUFBYTtBQUFBLElBQ2QsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBLElBQ1AsYUFDRTtBQUFBLElBR0YsZUFDRTtBQUFBLElBQ0Ysa0JBQWtCO0FBQUEsTUFDaEI7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxJQUNGO0FBQUEsSUFDQSxZQUFZLEtBQUssT0FBTztBQUFBLE1BQ3RCLFVBQVUsS0FBSztBQUFBLFFBQ2I7QUFBQSxVQUNFLEtBQUssUUFBUSxjQUFjO0FBQUEsVUFDM0IsS0FBSyxRQUFRLFlBQVk7QUFBQSxVQUN6QixLQUFLLFFBQVEsUUFBUTtBQUFBLFVBQ3JCLEtBQUssUUFBUSxZQUFZO0FBQUEsVUFDekIsS0FBSyxRQUFRLGFBQWE7QUFBQSxVQUMxQixLQUFLLFFBQVEsU0FBUztBQUFBLFFBQ3hCO0FBQUEsUUFDQSxFQUFFLGFBQWEsa0JBQWtCO0FBQUEsTUFDbkM7QUFBQSxNQUNBLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSxtREFBOEMsQ0FBQztBQUFBLE1BQ25GLFlBQVksS0FBSztBQUFBLFFBQ2YsS0FBSyxPQUFPLEVBQUUsYUFBYSw4QkFBeUIsU0FBUyxLQUFLLFNBQVMsS0FBSyxDQUFDO0FBQUEsTUFDbkY7QUFBQSxNQUNBLE1BQU0sS0FBSyxTQUFTLEtBQUssTUFBTSxLQUFLLE9BQU8sR0FBRyxFQUFFLGFBQWEsMkNBQTJDLENBQUMsQ0FBQztBQUFBLE1BQzFHLE9BQU8sS0FBSyxTQUFTLEtBQUssT0FBTyxFQUFFLGFBQWEsNERBQTRELENBQUMsQ0FBQztBQUFBLE1BQzlHLGtCQUFrQixLQUFLO0FBQUEsUUFDckIsS0FBSyxPQUFPLEtBQUssT0FBTyxHQUFHLEtBQUssUUFBUSxHQUFHO0FBQUEsVUFDekMsYUFBYTtBQUFBLFFBQ2YsQ0FBQztBQUFBLE1BQ0g7QUFBQSxJQUNGLENBQUM7QUFBQSxJQUNELE1BQU0sUUFBUSxhQUFhLFFBQVEsU0FBUyxXQUFXLE1BQU07QUFDM0QsWUFBTSxLQUFLLE1BQU0sYUFBYSxjQUFjLElBQUksQ0FBQztBQUNqRCxVQUFJLENBQUMsSUFBSTtBQUNQLGVBQU87QUFBQSxVQUNMLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBaUIsTUFBTSwrREFBK0QsQ0FBQztBQUFBLFVBQ3pHLFNBQVMsRUFBRSxXQUFXLGtCQUFrQixPQUFPLGlCQUFpQjtBQUFBLFVBQ2hFLFNBQVM7QUFBQSxRQUNYO0FBQUEsTUFDRjtBQUNBLGFBQU8scUJBQXFCLE1BQW9EO0FBQUEsSUFDbEY7QUFBQSxFQUNGLENBQUM7QUFJRCxLQUFHLGFBQWE7QUFBQSxJQUNkLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLGFBQ0U7QUFBQSxJQUVGLGVBQ0U7QUFBQSxJQUNGLGtCQUFrQjtBQUFBLE1BQ2hCO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxJQUNGO0FBQUEsSUFDQSxZQUFZLEtBQUssT0FBTztBQUFBLE1BQ3RCLE9BQU8sS0FBSyxPQUFPLEVBQUUsYUFBYSxnQ0FBZ0MsQ0FBQztBQUFBLE1BQ25FLEdBQUcsS0FBSyxTQUFTLEtBQUssT0FBTyxFQUFFLGFBQWEsb0NBQW9DLFNBQVMsR0FBRyxTQUFTLEdBQUcsQ0FBQyxDQUFDO0FBQUEsTUFDMUcsVUFBVSxLQUFLO0FBQUEsUUFDYixLQUFLO0FBQUEsVUFDSDtBQUFBLFlBQ0UsS0FBSyxRQUFRLGNBQWM7QUFBQSxZQUMzQixLQUFLLFFBQVEsWUFBWTtBQUFBLFlBQ3pCLEtBQUssUUFBUSxRQUFRO0FBQUEsWUFDckIsS0FBSyxRQUFRLFlBQVk7QUFBQSxZQUN6QixLQUFLLFFBQVEsYUFBYTtBQUFBLFlBQzFCLEtBQUssUUFBUSxTQUFTO0FBQUEsVUFDeEI7QUFBQSxVQUNBLEVBQUUsYUFBYSx3Q0FBd0M7QUFBQSxRQUN6RDtBQUFBLE1BQ0Y7QUFBQSxNQUNBLE9BQU8sS0FBSyxTQUFTLEtBQUssT0FBTyxFQUFFLGFBQWEsbUVBQW1FLENBQUMsQ0FBQztBQUFBLE1BQ3JILEtBQUssS0FBSyxTQUFTLEtBQUssT0FBTyxFQUFFLGFBQWEsK0NBQStDLENBQUMsQ0FBQztBQUFBLE1BQy9GLG9CQUFvQixLQUFLLFNBQVMsS0FBSyxRQUFRLEVBQUUsYUFBYSw4Q0FBOEMsQ0FBQyxDQUFDO0FBQUEsTUFDOUcsZ0JBQWdCLEtBQUs7QUFBQSxRQUNuQixLQUFLLFFBQVEsRUFBRSxhQUFhLDJEQUEyRCxDQUFDO0FBQUEsTUFDMUY7QUFBQSxJQUNGLENBQUM7QUFBQSxJQUNELE1BQU0sUUFBUSxhQUFhLFFBQVEsU0FBUyxXQUFXLE1BQU07QUFDM0QsWUFBTSxLQUFLLE1BQU0sYUFBYSxjQUFjLElBQUksQ0FBQztBQUNqRCxVQUFJLENBQUMsSUFBSTtBQUNQLGVBQU87QUFBQSxVQUNMLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBaUIsTUFBTSw2REFBNkQsQ0FBQztBQUFBLFVBQ3ZHLFNBQVMsRUFBRSxXQUFXLGdCQUFnQixPQUFPLGlCQUFpQjtBQUFBLFVBQzlELFNBQVM7QUFBQSxRQUNYO0FBQUEsTUFDRjtBQUNBLGFBQU8sbUJBQW1CLE1BQWtEO0FBQUEsSUFDOUU7QUFBQSxFQUNGLENBQUM7QUFJRCxLQUFHLGFBQWE7QUFBQSxJQUNkLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLGFBQ0U7QUFBQSxJQUdGLGVBQWU7QUFBQSxJQUNmLGtCQUFrQjtBQUFBLE1BQ2hCO0FBQUEsTUFDQTtBQUFBLElBQ0Y7QUFBQSxJQUNBLFlBQVksS0FBSyxPQUFPO0FBQUEsTUFDdEIsTUFBTSxLQUFLLE1BQU0sQ0FBQyxLQUFLLFFBQVEsT0FBTyxHQUFHLEtBQUssUUFBUSxPQUFPLENBQUMsR0FBRztBQUFBLFFBQy9ELGFBQWE7QUFBQSxNQUNmLENBQUM7QUFBQSxNQUNELFVBQVUsS0FBSyxTQUFTLEtBQUssT0FBTyxFQUFFLGFBQWEsdUNBQXVDLENBQUMsQ0FBQztBQUFBLE1BQzVGLE9BQU8sS0FBSyxTQUFTLEtBQUssT0FBTyxFQUFFLGFBQWEsMENBQXFDLFNBQVMsR0FBRyxTQUFTLEVBQUUsQ0FBQyxDQUFDO0FBQUEsTUFDOUcsS0FBSyxLQUFLLFNBQVMsS0FBSyxNQUFNO0FBQUEsUUFDNUIsS0FBSyxRQUFRLFlBQVk7QUFBQSxRQUN6QixLQUFLLFFBQVEsWUFBWTtBQUFBLFFBQ3pCLEtBQUssUUFBUSxhQUFhO0FBQUEsUUFDMUIsS0FBSyxRQUFRLFlBQVk7QUFBQSxRQUN6QixLQUFLLFFBQVEsWUFBWTtBQUFBLE1BQzNCLEdBQUcsRUFBRSxhQUFhLDZDQUE2QyxDQUFDLENBQUM7QUFBQSxJQUNuRSxDQUFDO0FBQUEsSUFDRCxNQUFNLFFBQVEsYUFBYSxRQUFRLFNBQVMsV0FBVyxNQUFNO0FBQzNELFlBQU0sS0FBSyxNQUFNLGFBQWEsY0FBYyxJQUFJLENBQUM7QUFDakQsVUFBSSxDQUFDLElBQUk7QUFDUCxlQUFPO0FBQUEsVUFDTCxTQUFTLENBQUMsRUFBRSxNQUFNLFFBQWlCLE1BQU0sd0NBQXdDLENBQUM7QUFBQSxVQUNsRixTQUFTLEVBQUUsV0FBVyxhQUFhLE9BQU8saUJBQWlCO0FBQUEsVUFDM0QsU0FBUztBQUFBLFFBQ1g7QUFBQSxNQUNGO0FBQ0EsYUFBTyxnQkFBZ0IsTUFBK0M7QUFBQSxJQUN4RTtBQUFBLEVBQ0YsQ0FBQztBQUNIOyIsCiAgIm5hbWVzIjogW10KfQo=
