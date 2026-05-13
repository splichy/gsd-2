const VISUAL_BRIEF_PAGE_RULES = [
  "Use Mermaid for topology-heavy diagrams when it improves readability.",
  "Use semantic HTML tables for comparisons, audits, matrices, status reports, and dense lists.",
  "Use CSS grid/card layouts when text-heavy module details matter more than edge routing.",
  "For 15+ entities, use a small overview diagram plus detailed cards instead of one crowded diagram.",
  "Include accessible headings, readable contrast, responsive tables, and no horizontal body overflow.",
  "Include source references for factual claims, file relationships, commands, and inferred behavior.",
  "Keep the design distinctive and appropriate to the content; avoid generic purple/blue gradient styling.",
  "CDN libraries are acceptable for Mermaid or charts, but the page must still show useful written context if a CDN fails.",
  "Do not include provider-specific claims, branding, or assumptions."
];
function getVisualBriefModeProfile(mode, slides) {
  if (slides || mode === "slides") {
    return {
      goal: "Turn the subject into a concise, visually paced deck that someone can present or skim quickly.",
      evidenceSteps: [
        "Identify the intended audience and the main decision or understanding the deck should support.",
        "Read the relevant files, diffs, docs, or command output before making factual claims.",
        "Extract the smallest set of concepts, risks, and examples needed for a clear narrative."
      ],
      sections: [
        "Title slide with the subject and one-line takeaway",
        "Problem or context slide",
        "System or concept diagram slide",
        "Key evidence slide",
        "Risks, tradeoffs, or unknowns slide",
        "Recommended next steps slide"
      ]
    };
  }
  switch (mode) {
    case "plan":
      return {
        goal: "Create a visual implementation plan that is detailed enough to guide coding without pretending uncertain facts are verified.",
        evidenceSteps: [
          "Read the relevant exports, immediate callers, tests, docs, and shared utilities.",
          "Identify the likely file changes, existing conventions, edge cases, and test requirements.",
          "Mark any assumption that cannot be verified from the repository."
        ],
        sections: [
          "Feature summary and scope boundaries",
          "Before/after workflow comparison",
          "Architecture or state-flow diagram",
          "Files to change with precise responsibilities",
          "API, command, or data-shape changes",
          "Edge cases and failure behavior",
          "Test plan with success and failure paths",
          "Open questions and assumptions"
        ]
      };
    case "diff":
      return {
        goal: "Review the current changes visually so risk, intent, and affected areas are easy to scan.",
        evidenceSteps: [
          "Inspect git status plus staged and unstaged diffs.",
          "Read changed files where needed to understand behavior, not just line changes.",
          "Separate confirmed findings from questions or residual risk."
        ],
        sections: [
          "Change map by file and subsystem",
          "Intent summary inferred from the diff",
          "Risk heatmap",
          "Behavior changes and compatibility notes",
          "Test coverage matrix",
          "Actionable findings and open questions"
        ]
      };
    case "recap":
      return {
        goal: "Create a context-switching snapshot that helps someone regain the project mental model quickly.",
        evidenceSteps: [
          "Read the current project docs, recent git status, relevant plans, and high-signal source files.",
          "Identify active work, stable architecture, uncertain areas, and likely next actions.",
          "Prefer concrete file references and verified facts over broad summaries."
        ],
        sections: [
          "Current project state",
          "Architecture map",
          "Active work and changed files",
          "Important decisions and constraints",
          "Risks or unresolved questions",
          "Recommended next actions"
        ]
      };
    case "table":
      return {
        goal: "Turn dense structured information into an accessible visual table that is easier to compare than terminal output.",
        evidenceSteps: [
          "Identify the row and column meanings before choosing table structure.",
          "Verify each cell from source material, command output, or code when possible.",
          "Use status labels and short notes so the table remains scannable."
        ],
        sections: [
          "Short summary of what is being compared",
          "Primary responsive table with sticky header",
          "Legend for statuses or scoring",
          "Notable patterns, outliers, and caveats",
          "Source references"
        ]
      };
    case "diagram":
      return {
        goal: "Explain the subject visually with a diagram plus enough context to make the diagram trustworthy.",
        evidenceSteps: [
          "Read relevant files, docs, or command output before drawing relationships.",
          "Choose the right diagram type: flowchart, sequence, state, ER/schema, C4-style, timeline, or dashboard.",
          "Keep complex diagrams readable by splitting overview and details."
        ],
        sections: [
          "One-line takeaway",
          "Primary diagram with readable labels",
          "Component or step details",
          "Data/control flow notes",
          "Assumptions, limitations, and source references"
        ]
      };
    default:
      throw new Error(`Unknown visual brief mode: ${mode}`);
  }
}
function formatPageRules(rules = VISUAL_BRIEF_PAGE_RULES) {
  return rules.map((rule) => `   - ${rule}`).join("\n");
}
export {
  VISUAL_BRIEF_PAGE_RULES,
  formatPageRules,
  getVisualBriefModeProfile
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL3Zpc3VhbC1icmllZi9wYWdlLWNvbnRyYWN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBHU0QtMiArIFZpc3VhbCBCcmllZiBwYWdlIGNvbnRyYWN0XG5cbmltcG9ydCB0eXBlIHsgVmlzdWFsQnJpZWZNb2RlIH0gZnJvbSBcIi4vcHJvbXB0cy5qc1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIFZpc3VhbEJyaWVmTW9kZVByb2ZpbGUge1xuXHRnb2FsOiBzdHJpbmc7XG5cdGV2aWRlbmNlU3RlcHM6IHJlYWRvbmx5IHN0cmluZ1tdO1xuXHRzZWN0aW9uczogcmVhZG9ubHkgc3RyaW5nW107XG59XG5cbmV4cG9ydCBjb25zdCBWSVNVQUxfQlJJRUZfUEFHRV9SVUxFUzogcmVhZG9ubHkgc3RyaW5nW10gPSBbXG5cdFwiVXNlIE1lcm1haWQgZm9yIHRvcG9sb2d5LWhlYXZ5IGRpYWdyYW1zIHdoZW4gaXQgaW1wcm92ZXMgcmVhZGFiaWxpdHkuXCIsXG5cdFwiVXNlIHNlbWFudGljIEhUTUwgdGFibGVzIGZvciBjb21wYXJpc29ucywgYXVkaXRzLCBtYXRyaWNlcywgc3RhdHVzIHJlcG9ydHMsIGFuZCBkZW5zZSBsaXN0cy5cIixcblx0XCJVc2UgQ1NTIGdyaWQvY2FyZCBsYXlvdXRzIHdoZW4gdGV4dC1oZWF2eSBtb2R1bGUgZGV0YWlscyBtYXR0ZXIgbW9yZSB0aGFuIGVkZ2Ugcm91dGluZy5cIixcblx0XCJGb3IgMTUrIGVudGl0aWVzLCB1c2UgYSBzbWFsbCBvdmVydmlldyBkaWFncmFtIHBsdXMgZGV0YWlsZWQgY2FyZHMgaW5zdGVhZCBvZiBvbmUgY3Jvd2RlZCBkaWFncmFtLlwiLFxuXHRcIkluY2x1ZGUgYWNjZXNzaWJsZSBoZWFkaW5ncywgcmVhZGFibGUgY29udHJhc3QsIHJlc3BvbnNpdmUgdGFibGVzLCBhbmQgbm8gaG9yaXpvbnRhbCBib2R5IG92ZXJmbG93LlwiLFxuXHRcIkluY2x1ZGUgc291cmNlIHJlZmVyZW5jZXMgZm9yIGZhY3R1YWwgY2xhaW1zLCBmaWxlIHJlbGF0aW9uc2hpcHMsIGNvbW1hbmRzLCBhbmQgaW5mZXJyZWQgYmVoYXZpb3IuXCIsXG5cdFwiS2VlcCB0aGUgZGVzaWduIGRpc3RpbmN0aXZlIGFuZCBhcHByb3ByaWF0ZSB0byB0aGUgY29udGVudDsgYXZvaWQgZ2VuZXJpYyBwdXJwbGUvYmx1ZSBncmFkaWVudCBzdHlsaW5nLlwiLFxuXHRcIkNETiBsaWJyYXJpZXMgYXJlIGFjY2VwdGFibGUgZm9yIE1lcm1haWQgb3IgY2hhcnRzLCBidXQgdGhlIHBhZ2UgbXVzdCBzdGlsbCBzaG93IHVzZWZ1bCB3cml0dGVuIGNvbnRleHQgaWYgYSBDRE4gZmFpbHMuXCIsXG5cdFwiRG8gbm90IGluY2x1ZGUgcHJvdmlkZXItc3BlY2lmaWMgY2xhaW1zLCBicmFuZGluZywgb3IgYXNzdW1wdGlvbnMuXCIsXG5dO1xuXG5leHBvcnQgZnVuY3Rpb24gZ2V0VmlzdWFsQnJpZWZNb2RlUHJvZmlsZShtb2RlOiBWaXN1YWxCcmllZk1vZGUsIHNsaWRlczogYm9vbGVhbik6IFZpc3VhbEJyaWVmTW9kZVByb2ZpbGUge1xuXHRpZiAoc2xpZGVzIHx8IG1vZGUgPT09IFwic2xpZGVzXCIpIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0Z29hbDogXCJUdXJuIHRoZSBzdWJqZWN0IGludG8gYSBjb25jaXNlLCB2aXN1YWxseSBwYWNlZCBkZWNrIHRoYXQgc29tZW9uZSBjYW4gcHJlc2VudCBvciBza2ltIHF1aWNrbHkuXCIsXG5cdFx0XHRldmlkZW5jZVN0ZXBzOiBbXG5cdFx0XHRcdFwiSWRlbnRpZnkgdGhlIGludGVuZGVkIGF1ZGllbmNlIGFuZCB0aGUgbWFpbiBkZWNpc2lvbiBvciB1bmRlcnN0YW5kaW5nIHRoZSBkZWNrIHNob3VsZCBzdXBwb3J0LlwiLFxuXHRcdFx0XHRcIlJlYWQgdGhlIHJlbGV2YW50IGZpbGVzLCBkaWZmcywgZG9jcywgb3IgY29tbWFuZCBvdXRwdXQgYmVmb3JlIG1ha2luZyBmYWN0dWFsIGNsYWltcy5cIixcblx0XHRcdFx0XCJFeHRyYWN0IHRoZSBzbWFsbGVzdCBzZXQgb2YgY29uY2VwdHMsIHJpc2tzLCBhbmQgZXhhbXBsZXMgbmVlZGVkIGZvciBhIGNsZWFyIG5hcnJhdGl2ZS5cIixcblx0XHRcdF0sXG5cdFx0XHRzZWN0aW9uczogW1xuXHRcdFx0XHRcIlRpdGxlIHNsaWRlIHdpdGggdGhlIHN1YmplY3QgYW5kIG9uZS1saW5lIHRha2Vhd2F5XCIsXG5cdFx0XHRcdFwiUHJvYmxlbSBvciBjb250ZXh0IHNsaWRlXCIsXG5cdFx0XHRcdFwiU3lzdGVtIG9yIGNvbmNlcHQgZGlhZ3JhbSBzbGlkZVwiLFxuXHRcdFx0XHRcIktleSBldmlkZW5jZSBzbGlkZVwiLFxuXHRcdFx0XHRcIlJpc2tzLCB0cmFkZW9mZnMsIG9yIHVua25vd25zIHNsaWRlXCIsXG5cdFx0XHRcdFwiUmVjb21tZW5kZWQgbmV4dCBzdGVwcyBzbGlkZVwiLFxuXHRcdFx0XSxcblx0XHR9O1xuXHR9XG5cblx0c3dpdGNoIChtb2RlKSB7XG5cdFx0Y2FzZSBcInBsYW5cIjpcblx0XHRcdHJldHVybiB7XG5cdFx0XHRcdGdvYWw6IFwiQ3JlYXRlIGEgdmlzdWFsIGltcGxlbWVudGF0aW9uIHBsYW4gdGhhdCBpcyBkZXRhaWxlZCBlbm91Z2ggdG8gZ3VpZGUgY29kaW5nIHdpdGhvdXQgcHJldGVuZGluZyB1bmNlcnRhaW4gZmFjdHMgYXJlIHZlcmlmaWVkLlwiLFxuXHRcdFx0XHRldmlkZW5jZVN0ZXBzOiBbXG5cdFx0XHRcdFx0XCJSZWFkIHRoZSByZWxldmFudCBleHBvcnRzLCBpbW1lZGlhdGUgY2FsbGVycywgdGVzdHMsIGRvY3MsIGFuZCBzaGFyZWQgdXRpbGl0aWVzLlwiLFxuXHRcdFx0XHRcdFwiSWRlbnRpZnkgdGhlIGxpa2VseSBmaWxlIGNoYW5nZXMsIGV4aXN0aW5nIGNvbnZlbnRpb25zLCBlZGdlIGNhc2VzLCBhbmQgdGVzdCByZXF1aXJlbWVudHMuXCIsXG5cdFx0XHRcdFx0XCJNYXJrIGFueSBhc3N1bXB0aW9uIHRoYXQgY2Fubm90IGJlIHZlcmlmaWVkIGZyb20gdGhlIHJlcG9zaXRvcnkuXCIsXG5cdFx0XHRcdF0sXG5cdFx0XHRcdHNlY3Rpb25zOiBbXG5cdFx0XHRcdFx0XCJGZWF0dXJlIHN1bW1hcnkgYW5kIHNjb3BlIGJvdW5kYXJpZXNcIixcblx0XHRcdFx0XHRcIkJlZm9yZS9hZnRlciB3b3JrZmxvdyBjb21wYXJpc29uXCIsXG5cdFx0XHRcdFx0XCJBcmNoaXRlY3R1cmUgb3Igc3RhdGUtZmxvdyBkaWFncmFtXCIsXG5cdFx0XHRcdFx0XCJGaWxlcyB0byBjaGFuZ2Ugd2l0aCBwcmVjaXNlIHJlc3BvbnNpYmlsaXRpZXNcIixcblx0XHRcdFx0XHRcIkFQSSwgY29tbWFuZCwgb3IgZGF0YS1zaGFwZSBjaGFuZ2VzXCIsXG5cdFx0XHRcdFx0XCJFZGdlIGNhc2VzIGFuZCBmYWlsdXJlIGJlaGF2aW9yXCIsXG5cdFx0XHRcdFx0XCJUZXN0IHBsYW4gd2l0aCBzdWNjZXNzIGFuZCBmYWlsdXJlIHBhdGhzXCIsXG5cdFx0XHRcdFx0XCJPcGVuIHF1ZXN0aW9ucyBhbmQgYXNzdW1wdGlvbnNcIixcblx0XHRcdFx0XSxcblx0XHRcdH07XG5cdFx0Y2FzZSBcImRpZmZcIjpcblx0XHRcdHJldHVybiB7XG5cdFx0XHRcdGdvYWw6IFwiUmV2aWV3IHRoZSBjdXJyZW50IGNoYW5nZXMgdmlzdWFsbHkgc28gcmlzaywgaW50ZW50LCBhbmQgYWZmZWN0ZWQgYXJlYXMgYXJlIGVhc3kgdG8gc2Nhbi5cIixcblx0XHRcdFx0ZXZpZGVuY2VTdGVwczogW1xuXHRcdFx0XHRcdFwiSW5zcGVjdCBnaXQgc3RhdHVzIHBsdXMgc3RhZ2VkIGFuZCB1bnN0YWdlZCBkaWZmcy5cIixcblx0XHRcdFx0XHRcIlJlYWQgY2hhbmdlZCBmaWxlcyB3aGVyZSBuZWVkZWQgdG8gdW5kZXJzdGFuZCBiZWhhdmlvciwgbm90IGp1c3QgbGluZSBjaGFuZ2VzLlwiLFxuXHRcdFx0XHRcdFwiU2VwYXJhdGUgY29uZmlybWVkIGZpbmRpbmdzIGZyb20gcXVlc3Rpb25zIG9yIHJlc2lkdWFsIHJpc2suXCIsXG5cdFx0XHRcdF0sXG5cdFx0XHRcdHNlY3Rpb25zOiBbXG5cdFx0XHRcdFx0XCJDaGFuZ2UgbWFwIGJ5IGZpbGUgYW5kIHN1YnN5c3RlbVwiLFxuXHRcdFx0XHRcdFwiSW50ZW50IHN1bW1hcnkgaW5mZXJyZWQgZnJvbSB0aGUgZGlmZlwiLFxuXHRcdFx0XHRcdFwiUmlzayBoZWF0bWFwXCIsXG5cdFx0XHRcdFx0XCJCZWhhdmlvciBjaGFuZ2VzIGFuZCBjb21wYXRpYmlsaXR5IG5vdGVzXCIsXG5cdFx0XHRcdFx0XCJUZXN0IGNvdmVyYWdlIG1hdHJpeFwiLFxuXHRcdFx0XHRcdFwiQWN0aW9uYWJsZSBmaW5kaW5ncyBhbmQgb3BlbiBxdWVzdGlvbnNcIixcblx0XHRcdFx0XSxcblx0XHRcdH07XG5cdFx0Y2FzZSBcInJlY2FwXCI6XG5cdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRnb2FsOiBcIkNyZWF0ZSBhIGNvbnRleHQtc3dpdGNoaW5nIHNuYXBzaG90IHRoYXQgaGVscHMgc29tZW9uZSByZWdhaW4gdGhlIHByb2plY3QgbWVudGFsIG1vZGVsIHF1aWNrbHkuXCIsXG5cdFx0XHRcdGV2aWRlbmNlU3RlcHM6IFtcblx0XHRcdFx0XHRcIlJlYWQgdGhlIGN1cnJlbnQgcHJvamVjdCBkb2NzLCByZWNlbnQgZ2l0IHN0YXR1cywgcmVsZXZhbnQgcGxhbnMsIGFuZCBoaWdoLXNpZ25hbCBzb3VyY2UgZmlsZXMuXCIsXG5cdFx0XHRcdFx0XCJJZGVudGlmeSBhY3RpdmUgd29yaywgc3RhYmxlIGFyY2hpdGVjdHVyZSwgdW5jZXJ0YWluIGFyZWFzLCBhbmQgbGlrZWx5IG5leHQgYWN0aW9ucy5cIixcblx0XHRcdFx0XHRcIlByZWZlciBjb25jcmV0ZSBmaWxlIHJlZmVyZW5jZXMgYW5kIHZlcmlmaWVkIGZhY3RzIG92ZXIgYnJvYWQgc3VtbWFyaWVzLlwiLFxuXHRcdFx0XHRdLFxuXHRcdFx0XHRzZWN0aW9uczogW1xuXHRcdFx0XHRcdFwiQ3VycmVudCBwcm9qZWN0IHN0YXRlXCIsXG5cdFx0XHRcdFx0XCJBcmNoaXRlY3R1cmUgbWFwXCIsXG5cdFx0XHRcdFx0XCJBY3RpdmUgd29yayBhbmQgY2hhbmdlZCBmaWxlc1wiLFxuXHRcdFx0XHRcdFwiSW1wb3J0YW50IGRlY2lzaW9ucyBhbmQgY29uc3RyYWludHNcIixcblx0XHRcdFx0XHRcIlJpc2tzIG9yIHVucmVzb2x2ZWQgcXVlc3Rpb25zXCIsXG5cdFx0XHRcdFx0XCJSZWNvbW1lbmRlZCBuZXh0IGFjdGlvbnNcIixcblx0XHRcdFx0XSxcblx0XHRcdH07XG5cdFx0Y2FzZSBcInRhYmxlXCI6XG5cdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRnb2FsOiBcIlR1cm4gZGVuc2Ugc3RydWN0dXJlZCBpbmZvcm1hdGlvbiBpbnRvIGFuIGFjY2Vzc2libGUgdmlzdWFsIHRhYmxlIHRoYXQgaXMgZWFzaWVyIHRvIGNvbXBhcmUgdGhhbiB0ZXJtaW5hbCBvdXRwdXQuXCIsXG5cdFx0XHRcdGV2aWRlbmNlU3RlcHM6IFtcblx0XHRcdFx0XHRcIklkZW50aWZ5IHRoZSByb3cgYW5kIGNvbHVtbiBtZWFuaW5ncyBiZWZvcmUgY2hvb3NpbmcgdGFibGUgc3RydWN0dXJlLlwiLFxuXHRcdFx0XHRcdFwiVmVyaWZ5IGVhY2ggY2VsbCBmcm9tIHNvdXJjZSBtYXRlcmlhbCwgY29tbWFuZCBvdXRwdXQsIG9yIGNvZGUgd2hlbiBwb3NzaWJsZS5cIixcblx0XHRcdFx0XHRcIlVzZSBzdGF0dXMgbGFiZWxzIGFuZCBzaG9ydCBub3RlcyBzbyB0aGUgdGFibGUgcmVtYWlucyBzY2FubmFibGUuXCIsXG5cdFx0XHRcdF0sXG5cdFx0XHRcdHNlY3Rpb25zOiBbXG5cdFx0XHRcdFx0XCJTaG9ydCBzdW1tYXJ5IG9mIHdoYXQgaXMgYmVpbmcgY29tcGFyZWRcIixcblx0XHRcdFx0XHRcIlByaW1hcnkgcmVzcG9uc2l2ZSB0YWJsZSB3aXRoIHN0aWNreSBoZWFkZXJcIixcblx0XHRcdFx0XHRcIkxlZ2VuZCBmb3Igc3RhdHVzZXMgb3Igc2NvcmluZ1wiLFxuXHRcdFx0XHRcdFwiTm90YWJsZSBwYXR0ZXJucywgb3V0bGllcnMsIGFuZCBjYXZlYXRzXCIsXG5cdFx0XHRcdFx0XCJTb3VyY2UgcmVmZXJlbmNlc1wiLFxuXHRcdFx0XHRdLFxuXHRcdFx0fTtcblx0XHRjYXNlIFwiZGlhZ3JhbVwiOlxuXHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0Z29hbDogXCJFeHBsYWluIHRoZSBzdWJqZWN0IHZpc3VhbGx5IHdpdGggYSBkaWFncmFtIHBsdXMgZW5vdWdoIGNvbnRleHQgdG8gbWFrZSB0aGUgZGlhZ3JhbSB0cnVzdHdvcnRoeS5cIixcblx0XHRcdFx0ZXZpZGVuY2VTdGVwczogW1xuXHRcdFx0XHRcdFwiUmVhZCByZWxldmFudCBmaWxlcywgZG9jcywgb3IgY29tbWFuZCBvdXRwdXQgYmVmb3JlIGRyYXdpbmcgcmVsYXRpb25zaGlwcy5cIixcblx0XHRcdFx0XHRcIkNob29zZSB0aGUgcmlnaHQgZGlhZ3JhbSB0eXBlOiBmbG93Y2hhcnQsIHNlcXVlbmNlLCBzdGF0ZSwgRVIvc2NoZW1hLCBDNC1zdHlsZSwgdGltZWxpbmUsIG9yIGRhc2hib2FyZC5cIixcblx0XHRcdFx0XHRcIktlZXAgY29tcGxleCBkaWFncmFtcyByZWFkYWJsZSBieSBzcGxpdHRpbmcgb3ZlcnZpZXcgYW5kIGRldGFpbHMuXCIsXG5cdFx0XHRcdF0sXG5cdFx0XHRcdHNlY3Rpb25zOiBbXG5cdFx0XHRcdFx0XCJPbmUtbGluZSB0YWtlYXdheVwiLFxuXHRcdFx0XHRcdFwiUHJpbWFyeSBkaWFncmFtIHdpdGggcmVhZGFibGUgbGFiZWxzXCIsXG5cdFx0XHRcdFx0XCJDb21wb25lbnQgb3Igc3RlcCBkZXRhaWxzXCIsXG5cdFx0XHRcdFx0XCJEYXRhL2NvbnRyb2wgZmxvdyBub3Rlc1wiLFxuXHRcdFx0XHRcdFwiQXNzdW1wdGlvbnMsIGxpbWl0YXRpb25zLCBhbmQgc291cmNlIHJlZmVyZW5jZXNcIixcblx0XHRcdFx0XSxcblx0XHRcdH07XG5cdFx0ZGVmYXVsdDpcblx0XHRcdHRocm93IG5ldyBFcnJvcihgVW5rbm93biB2aXN1YWwgYnJpZWYgbW9kZTogJHttb2RlIGFzIHN0cmluZ31gKTtcblx0fVxufVxuXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0UGFnZVJ1bGVzKHJ1bGVzOiByZWFkb25seSBzdHJpbmdbXSA9IFZJU1VBTF9CUklFRl9QQUdFX1JVTEVTKTogc3RyaW5nIHtcblx0cmV0dXJuIHJ1bGVzLm1hcCgocnVsZSkgPT4gYCAgIC0gJHtydWxlfWApLmpvaW4oXCJcXG5cIik7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFVTyxNQUFNLDBCQUE2QztBQUFBLEVBQ3pEO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFDRDtBQUVPLFNBQVMsMEJBQTBCLE1BQXVCLFFBQXlDO0FBQ3pHLE1BQUksVUFBVSxTQUFTLFVBQVU7QUFDaEMsV0FBTztBQUFBLE1BQ04sTUFBTTtBQUFBLE1BQ04sZUFBZTtBQUFBLFFBQ2Q7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLE1BQ0Q7QUFBQSxNQUNBLFVBQVU7QUFBQSxRQUNUO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxNQUNEO0FBQUEsSUFDRDtBQUFBLEVBQ0Q7QUFFQSxVQUFRLE1BQU07QUFBQSxJQUNiLEtBQUs7QUFDSixhQUFPO0FBQUEsUUFDTixNQUFNO0FBQUEsUUFDTixlQUFlO0FBQUEsVUFDZDtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsUUFDRDtBQUFBLFFBQ0EsVUFBVTtBQUFBLFVBQ1Q7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsUUFDRDtBQUFBLE1BQ0Q7QUFBQSxJQUNELEtBQUs7QUFDSixhQUFPO0FBQUEsUUFDTixNQUFNO0FBQUEsUUFDTixlQUFlO0FBQUEsVUFDZDtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsUUFDRDtBQUFBLFFBQ0EsVUFBVTtBQUFBLFVBQ1Q7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFFBQ0Q7QUFBQSxNQUNEO0FBQUEsSUFDRCxLQUFLO0FBQ0osYUFBTztBQUFBLFFBQ04sTUFBTTtBQUFBLFFBQ04sZUFBZTtBQUFBLFVBQ2Q7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFFBQ0Q7QUFBQSxRQUNBLFVBQVU7QUFBQSxVQUNUO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxRQUNEO0FBQUEsTUFDRDtBQUFBLElBQ0QsS0FBSztBQUNKLGFBQU87QUFBQSxRQUNOLE1BQU07QUFBQSxRQUNOLGVBQWU7QUFBQSxVQUNkO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxRQUNEO0FBQUEsUUFDQSxVQUFVO0FBQUEsVUFDVDtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxRQUNEO0FBQUEsTUFDRDtBQUFBLElBQ0QsS0FBSztBQUNKLGFBQU87QUFBQSxRQUNOLE1BQU07QUFBQSxRQUNOLGVBQWU7QUFBQSxVQUNkO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxRQUNEO0FBQUEsUUFDQSxVQUFVO0FBQUEsVUFDVDtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxRQUNEO0FBQUEsTUFDRDtBQUFBLElBQ0Q7QUFDQyxZQUFNLElBQUksTUFBTSw4QkFBOEIsSUFBYyxFQUFFO0FBQUEsRUFDaEU7QUFDRDtBQUVPLFNBQVMsZ0JBQWdCLFFBQTJCLHlCQUFpQztBQUMzRixTQUFPLE1BQU0sSUFBSSxDQUFDLFNBQVMsUUFBUSxJQUFJLEVBQUUsRUFBRSxLQUFLLElBQUk7QUFDckQ7IiwKICAibmFtZXMiOiBbXQp9Cg==
