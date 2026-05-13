const ARTIFACT_KEYS = [
  // Milestone-scoped
  "roadmap",
  "milestone-context",
  "milestone-summary",
  "milestone-validation",
  "milestone-research",
  "milestone-plan",
  // Slice-scoped
  "slice-context",
  "slice-research",
  "slice-plan",
  "slice-summary",
  "slice-uat",
  "slice-assessment",
  // Task-scoped
  "task-plan",
  "task-summary",
  "prior-task-summaries",
  "dependency-summaries",
  // Project-scoped
  "requirements",
  "decisions",
  "project",
  "templates"
];
const COMMON_BUDGET_LARGE = 15e5;
const COMMON_BUDGET_MEDIUM = 75e4;
const COMMON_BUDGET_SMALL = 25e4;
const TOOLS_ALL = { mode: "all" };
const TOOLS_PLANNING = { mode: "planning" };
const TOOLS_VERIFICATION = { mode: "verification" };
const TOOLS_PLANNING_DISPATCH_RECON = {
  mode: "planning-dispatch",
  allowedSubagents: ["scout", "planner"]
};
const TOOLS_PLANNING_DISPATCH_REVIEW = {
  mode: "planning-dispatch",
  allowedSubagents: ["reviewer", "security", "tester"]
};
const TOOLS_DOCS = {
  mode: "docs",
  // Globs are resolved relative to project basePath. The set is intentionally
  // narrow: top-level docs/, README, CHANGELOG, and any markdown at the
  // project root. Projects with non-standard layouts (e.g. mintlify-docs/)
  // will need this list extended in a follow-up; landed conservative now,
  // expand on demand.
  allowedPathGlobs: [
    "docs/**",
    "README.md",
    "README.*.md",
    "CHANGELOG.md",
    "*.md"
  ]
};
const KNOWN_UNIT_TYPES = [
  "research-milestone",
  "plan-milestone",
  "discuss-milestone",
  "validate-milestone",
  "complete-milestone",
  "research-slice",
  "plan-slice",
  "refine-slice",
  "replan-slice",
  "complete-slice",
  "reassess-roadmap",
  "execute-task",
  "reactive-execute",
  "run-uat",
  "gate-evaluate",
  "rewrite-docs",
  // Deep planning mode (project-level) units
  "workflow-preferences",
  "discuss-project",
  "discuss-requirements",
  "research-decision",
  "research-project"
];
const UNIT_MANIFESTS = {
  // ─── Milestone-scoped ────────────────────────────────────────────────
  "research-milestone": {
    skills: { mode: "all" },
    knowledge: "full",
    memory: "prompt-relevant",
    codebaseMap: true,
    preferences: "active-only",
    contextMode: "research",
    tools: TOOLS_PLANNING,
    artifacts: {
      // Phase 3 migration (#4782): matches today's actual
      // buildResearchMilestonePrompt inlining order.
      inline: ["milestone-context", "project", "requirements", "decisions", "templates"],
      excerpt: [],
      onDemand: []
    },
    maxSystemPromptChars: COMMON_BUDGET_MEDIUM
  },
  "plan-milestone": {
    skills: { mode: "all" },
    knowledge: "full",
    memory: "prompt-relevant",
    codebaseMap: true,
    preferences: "active-only",
    contextMode: "planning",
    tools: TOOLS_PLANNING,
    artifacts: {
      inline: ["project", "requirements", "decisions", "milestone-research", "templates"],
      excerpt: [],
      onDemand: []
    },
    maxSystemPromptChars: COMMON_BUDGET_LARGE
  },
  "discuss-milestone": {
    skills: { mode: "all" },
    knowledge: "full",
    memory: "prompt-relevant",
    codebaseMap: true,
    preferences: "active-only",
    contextMode: "interview",
    tools: TOOLS_PLANNING,
    artifacts: {
      inline: ["project", "requirements", "decisions", "milestone-context", "templates"],
      excerpt: [],
      onDemand: []
    },
    maxSystemPromptChars: COMMON_BUDGET_MEDIUM
  },
  "validate-milestone": {
    skills: { mode: "all" },
    knowledge: "scoped",
    memory: "prompt-relevant",
    codebaseMap: false,
    preferences: "active-only",
    contextMode: "verification",
    // planning-dispatch: validation is a verification-fan-out unit. It reads
    // the milestone surface and dispatches reviewer/security/tester subagents
    // to report findings without touching user source. Write isolation to
    // .gsd/ is preserved.
    tools: TOOLS_PLANNING_DISPATCH_REVIEW,
    artifacts: {
      inline: ["roadmap", "slice-summary", "slice-uat", "requirements", "decisions", "templates"],
      excerpt: [],
      onDemand: []
    },
    maxSystemPromptChars: COMMON_BUDGET_LARGE
  },
  "complete-milestone": {
    skills: { mode: "all" },
    knowledge: "scoped",
    memory: "prompt-relevant",
    codebaseMap: false,
    preferences: "active-only",
    contextMode: "verification",
    // Milestone closeout must run unrestricted shell verification commands
    // against the final diff before recording completion.
    tools: TOOLS_ALL,
    artifacts: {
      // #4780 landed slice-summary as excerpt for this unit; phase 2 of
      // the architecture will read this manifest as the source of truth
      // and retire the special-case wiring in auto-prompts.ts.
      inline: ["roadmap", "milestone-context", "requirements", "decisions", "project", "templates"],
      excerpt: ["slice-summary"],
      onDemand: ["slice-summary"]
    },
    maxSystemPromptChars: COMMON_BUDGET_MEDIUM
  },
  // ─── Slice-scoped ────────────────────────────────────────────────────
  "research-slice": {
    skills: { mode: "all" },
    knowledge: "full",
    memory: "prompt-relevant",
    codebaseMap: true,
    preferences: "active-only",
    contextMode: "research",
    // Multi-slice research dispatches use the research-slice unit contract to
    // fan out scout subagents that write .gsd research artifacts.
    tools: TOOLS_PLANNING_DISPATCH_RECON,
    artifacts: {
      inline: ["roadmap", "milestone-research", "dependency-summaries", "templates"],
      excerpt: [],
      onDemand: []
    },
    maxSystemPromptChars: COMMON_BUDGET_MEDIUM
  },
  "plan-slice": {
    skills: { mode: "all" },
    knowledge: "full",
    memory: "prompt-relevant",
    codebaseMap: true,
    preferences: "active-only",
    contextMode: "planning",
    // planning-dispatch: allows subagent dispatch so the planner can fan out
    // to scout for codebase recon and to planner/decompose-style specialists
    // for sub-decomposition. Write-isolation to .gsd/ is preserved.
    tools: TOOLS_PLANNING_DISPATCH_RECON,
    artifacts: {
      inline: ["roadmap", "slice-research", "dependency-summaries", "requirements", "decisions", "templates"],
      excerpt: [],
      onDemand: []
    },
    maxSystemPromptChars: COMMON_BUDGET_LARGE
  },
  "refine-slice": {
    skills: { mode: "all" },
    knowledge: "scoped",
    memory: "prompt-relevant",
    codebaseMap: true,
    preferences: "active-only",
    contextMode: "planning",
    // See plan-slice — same rationale: dispatch to scout/planner-style
    // specialists during refinement is materially better than re-doing recon
    // inline.
    tools: TOOLS_PLANNING_DISPATCH_RECON,
    artifacts: {
      inline: ["slice-plan", "slice-research", "dependency-summaries", "templates"],
      excerpt: [],
      onDemand: []
    },
    maxSystemPromptChars: COMMON_BUDGET_MEDIUM
  },
  "replan-slice": {
    skills: { mode: "all" },
    knowledge: "scoped",
    memory: "prompt-relevant",
    codebaseMap: true,
    preferences: "active-only",
    contextMode: "planning",
    tools: TOOLS_PLANNING,
    artifacts: {
      inline: ["slice-plan", "slice-research", "dependency-summaries", "prior-task-summaries", "templates"],
      excerpt: [],
      onDemand: []
    },
    maxSystemPromptChars: COMMON_BUDGET_MEDIUM
  },
  "complete-slice": {
    skills: { mode: "all" },
    knowledge: "scoped",
    memory: "prompt-relevant",
    codebaseMap: false,
    preferences: "active-only",
    contextMode: "verification",
    // See complete-milestone — same rationale: dispatch to reviewer / security /
    // tester subagents to fan out review work without bloating this unit's
    // context.
    tools: TOOLS_PLANNING_DISPATCH_REVIEW,
    artifacts: {
      // Phase 3 migration (#4782): matches today's actual
      // buildCompleteSlicePrompt inlining order. Overrides prepend +
      // knowledge splice stay in the builder imperatively (see RFC
      // #4924 — computed/prepend blocks are phase-4 composer work).
      inline: ["roadmap", "slice-context", "slice-plan", "requirements", "prior-task-summaries", "templates"],
      excerpt: [],
      onDemand: []
    },
    maxSystemPromptChars: COMMON_BUDGET_LARGE
  },
  "reassess-roadmap": {
    skills: { mode: "all" },
    knowledge: "scoped",
    memory: "critical-only",
    codebaseMap: false,
    preferences: "none",
    contextMode: "planning",
    tools: TOOLS_PLANNING,
    artifacts: {
      // Phase 2 pilot (#4782): manifest now matches today's actual
      // buildReassessRoadmapPrompt behavior for equivalence. Phase 3
      // will tighten this list once the composer reports real telemetry.
      inline: ["roadmap", "slice-context", "slice-summary", "project", "requirements", "decisions"],
      excerpt: [],
      onDemand: []
    },
    maxSystemPromptChars: COMMON_BUDGET_MEDIUM
  },
  // ─── Task-scoped ─────────────────────────────────────────────────────
  "execute-task": {
    skills: { mode: "all" },
    knowledge: "scoped",
    memory: "prompt-relevant",
    codebaseMap: true,
    preferences: "active-only",
    contextMode: "execution",
    tools: TOOLS_ALL,
    artifacts: {
      inline: ["task-plan", "slice-plan", "prior-task-summaries", "templates"],
      excerpt: [],
      onDemand: ["slice-research"]
    },
    maxSystemPromptChars: COMMON_BUDGET_LARGE
  },
  "reactive-execute": {
    skills: { mode: "all" },
    knowledge: "scoped",
    memory: "prompt-relevant",
    codebaseMap: true,
    preferences: "active-only",
    contextMode: "execution",
    tools: TOOLS_ALL,
    artifacts: {
      inline: ["slice-plan", "prior-task-summaries", "templates"],
      excerpt: [],
      onDemand: ["slice-research"]
    },
    maxSystemPromptChars: COMMON_BUDGET_LARGE
  },
  // ─── Ancillary units ─────────────────────────────────────────────────
  "run-uat": {
    skills: { mode: "all" },
    knowledge: "critical-only",
    memory: "critical-only",
    codebaseMap: false,
    preferences: "active-only",
    contextMode: "verification",
    tools: TOOLS_VERIFICATION,
    artifacts: {
      // Phase 3 migration (#4782): manifest matches today's actual
      // buildRunUatPrompt inlining. Prior phase-1 entry listed
      // `slice-plan` aspirationally — the real builder inlines the UAT
      // file, the slice SUMMARY (optional), and the project row.
      inline: ["slice-uat", "slice-summary", "project"],
      excerpt: [],
      onDemand: []
    },
    maxSystemPromptChars: COMMON_BUDGET_SMALL
  },
  "gate-evaluate": {
    skills: { mode: "all" },
    knowledge: "critical-only",
    memory: "critical-only",
    codebaseMap: false,
    preferences: "active-only",
    contextMode: "verification",
    // Gate evaluation fans out tester-style subagents, which read the slice
    // plan and report via the DB-backed gate-result tool.
    tools: TOOLS_PLANNING_DISPATCH_REVIEW,
    artifacts: {
      inline: ["slice-plan", "prior-task-summaries"],
      excerpt: [],
      onDemand: []
    },
    maxSystemPromptChars: COMMON_BUDGET_SMALL
  },
  "rewrite-docs": {
    skills: { mode: "all" },
    knowledge: "scoped",
    memory: "prompt-relevant",
    codebaseMap: true,
    preferences: "active-only",
    contextMode: "docs",
    tools: TOOLS_DOCS,
    artifacts: {
      inline: ["project", "requirements", "decisions", "templates"],
      excerpt: [],
      onDemand: []
    },
    maxSystemPromptChars: COMMON_BUDGET_MEDIUM
  },
  // ─── Deep planning mode (project-level) units ────────────────────────
  // workflow-preferences: default-writing stage that records
  // commit_policy / branch_model in PREFERENCES.md, defaults
  // uat_dispatch/executor_class, and records the research decision. No project artifacts needed.
  "workflow-preferences": {
    skills: { mode: "none" },
    knowledge: "none",
    memory: "none",
    codebaseMap: false,
    preferences: "none",
    contextMode: "none",
    tools: TOOLS_PLANNING,
    artifacts: {
      inline: [],
      excerpt: [],
      onDemand: []
    },
    maxSystemPromptChars: COMMON_BUDGET_SMALL
  },
  // discuss-project: PROJECT.md interview (deep mode only). Project-scoped
  // discussion runs before any milestone exists, so milestone artifacts are
  // not loaded. Keeps templates available for PROJECT.md scaffolding.
  "discuss-project": {
    skills: { mode: "all" },
    knowledge: "scoped",
    memory: "prompt-relevant",
    codebaseMap: true,
    preferences: "active-only",
    contextMode: "interview",
    tools: TOOLS_PLANNING,
    artifacts: {
      inline: ["templates"],
      excerpt: [],
      onDemand: []
    },
    maxSystemPromptChars: COMMON_BUDGET_MEDIUM
  },
  // discuss-requirements: REQUIREMENTS.md interview. PROJECT.md is the
  // primary context input; templates carry the requirements format.
  "discuss-requirements": {
    skills: { mode: "all" },
    knowledge: "scoped",
    memory: "prompt-relevant",
    codebaseMap: true,
    preferences: "active-only",
    contextMode: "interview",
    tools: TOOLS_PLANNING,
    artifacts: {
      inline: ["project", "templates"],
      excerpt: [],
      onDemand: []
    },
    maxSystemPromptChars: COMMON_BUDGET_MEDIUM
  },
  // research-decision: lightweight one-question yes/no unit. Writes a
  // marker JSON; no project artifacts needed.
  "research-decision": {
    skills: { mode: "none" },
    knowledge: "none",
    memory: "none",
    codebaseMap: false,
    preferences: "none",
    contextMode: "none",
    tools: TOOLS_PLANNING,
    artifacts: {
      inline: [],
      excerpt: [],
      onDemand: []
    },
    maxSystemPromptChars: COMMON_BUDGET_SMALL
  },
  // research-project: orchestrator that fans out 4 parallel scout subagents
  // for project research (stack, features, architecture, pitfalls). Needs the
  // planning-dispatch policy to dispatch them. PROJECT.md + REQUIREMENTS.md
  // give the orchestrator the framing context.
  "research-project": {
    skills: { mode: "all" },
    knowledge: "scoped",
    memory: "prompt-relevant",
    codebaseMap: true,
    preferences: "active-only",
    contextMode: "research",
    tools: { mode: "planning-dispatch", allowedSubagents: ["scout"] },
    artifacts: {
      inline: ["project", "requirements", "templates"],
      excerpt: [],
      onDemand: []
    },
    maxSystemPromptChars: COMMON_BUDGET_MEDIUM
  }
};
function resolveManifest(unitType) {
  return UNIT_MANIFESTS[unitType] ?? null;
}
function compileSubagentPermissionContract(policy) {
  if (!policy) {
    return { allowed: false, allowedSubagents: [], toolsMode: "unknown" };
  }
  if (policy.mode === "all") {
    return { allowed: true, allowedSubagents: ["*"], toolsMode: policy.mode };
  }
  if (policy.mode === "planning-dispatch") {
    return {
      allowed: true,
      allowedSubagents: [...policy.allowedSubagents],
      toolsMode: policy.mode
    };
  }
  return { allowed: false, allowedSubagents: [], toolsMode: policy.mode };
}
function resolveSubagentPermissionContract(unitType) {
  return compileSubagentPermissionContract(resolveManifest(unitType)?.tools);
}
export {
  ARTIFACT_KEYS,
  KNOWN_UNIT_TYPES,
  UNIT_MANIFESTS,
  compileSubagentPermissionContract,
  resolveManifest,
  resolveSubagentPermissionContract
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC91bml0LWNvbnRleHQtbWFuaWZlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRC0yIFx1MjAxNCBVbml0Q29udGV4dE1hbmlmZXN0ICgjNDc4MiBwaGFzZSAxKS5cbi8vXG4vLyBEZWNsYXJhdGl2ZSBkZXNjcmlwdGlvbiBvZiB3aGF0IGNvbnRleHQgZWFjaCBhdXRvLW1vZGUgdW5pdCB0eXBlIG5lZWRzXG4vLyBpbiBpdHMgc3lzdGVtIHByb21wdC4gRXN0YWJsaXNoZXMgdGhlIGNvbnRyYWN0IHRoYXQgbGF0ZXIgcGhhc2VzIHdpbGxcbi8vIHVzZSB0byBkcml2ZSBhIHNpbmdsZSBjb21wb3NlU3lzdGVtUHJvbXB0Rm9yVW5pdCgpIFx1MjAxNCByZXBsYWNpbmcgdGhlXG4vLyBwZXItdW5pdC10eXBlIGJyYW5jaGluZyBjdXJyZW50bHkgc3ByZWFkIGFjcm9zcyBgYXV0by1wcm9tcHRzLnRzYC5cbi8vXG4vLyAqKlBoYXNlIDEgc2hpcHMgdGhlIHR5cGUgKyB0aGUgZGF0YSArIGEgQ0kgY292ZXJhZ2UgZ3VhcmQuKiogSXQgYWRkc1xuLy8gemVybyB3aXJpbmcgXHUyMDE0IG5vIGNhbGxlciByZWFkcyBhIG1hbmlmZXN0IHlldC4gRXZlcnkgdW5pdCB0eXBlIGdldHMgYVxuLy8gbWFuaWZlc3QgdGhhdCBkZXNjcmliZXMgdG9kYXkncyBiZWhhdmlvciBhcyBmYWl0aGZ1bGx5IGFzIHBvc3NpYmxlLCBzb1xuLy8gd2hlbiB0aGUgY29tcG9zZXIgbGFuZHMgaW4gcGhhc2UgMiB0aGUgbWlncmF0aW9uIGNhbiBwcm9jZWVkIG1hbmlmZXN0LVxuLy8gYnktbWFuaWZlc3Qgd2l0aG91dCBiZWhhdmlvciBjaGFuZ2UuXG4vL1xuLy8gUGhhc2VkIHJvbGxvdXQgdHJhY2tpbmc6XG4vLyAgIC0gUGhhc2UgMSAodGhpcyBQUik6IHNjaGVtYSArIG1hbmlmZXN0cyArIGNvdmVyYWdlIHRlc3QuXG4vLyAgIC0gUGhhc2UgMjogYWRkIGNvbXBvc2VTeXN0ZW1Qcm9tcHRGb3JVbml0KCk7IG1pZ3JhdGUgb25lIGxvdy1yaXNrXG4vLyAgICAgdW5pdCB0eXBlIChlLmcuIHJlYXNzZXNzLXJvYWRtYXApIGFzIHRoZSBwaWxvdC5cbi8vICAgLSBQaGFzZSAzOiBtaWdyYXRlIHJlbWFpbmluZyB1bml0IHR5cGVzLCB0aWdodGVuIG1hbmlmZXN0cyBwZXJcbi8vICAgICBlbXBpcmljYWwgdXNhZ2UsIGludHJvZHVjZSBza2lwV2hlbiBwcmVkaWNhdGVzIGFic29yYmluZyB0aGVcbi8vICAgICByZWFzc2VzcyBvcHQtaW4gZ2F0ZSBmcm9tICM0Nzc4LlxuLy8gICAtIFBoYXNlIDQ6IGludHJvZHVjZSBwaXBlbGluZSB2YXJpYW50cyBhcyBkZWNsYXJlZCBzZXF1ZW5jZXMsXG4vLyAgICAgYWJzb3JiaW5nIHRoZSBzY29wZS1jbGFzc2lmaWVyIGdhdGVzIGZyb20gIzQ3ODEuXG4vL1xuLy8gTmFtaW5nOlxuLy8gICAtIEFydGlmYWN0IGtleXMgYXJlIFNUQUJMRSBzdHJpbmdzIChub3QgcGF0aHMpLiBQYXRoIHJlc29sdXRpb24gaXNcbi8vICAgICB0aGUgY29tcG9zZXIncyBqb2I7IG1hbmlmZXN0cyBkZXNjcmliZSBpbnRlbnQsIG5vdCBkaXNrIGxheW91dC5cbi8vICAgLSBDaGFyIGJ1ZGdldHMgYXJlIG5vbWluYWwgXHUyMDE0IGJsb3duIGJ1ZGdldHMgbG9nIGEgdGVsZW1ldHJ5IGV2ZW50LFxuLy8gICAgIHRoZXkgZG8gbm90IHRydW5jYXRlIG9yIGVycm9yICh0aGUgY29tcG9zZXIgZGVjaWRlcyBmYWxsYmFjaykuXG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBBcnRpZmFjdCByZWdpc3RyeSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBTdGFibGUgaWRlbnRpZmllcnMgZm9yIGV2ZXJ5IGFydGlmYWN0IGNsYXNzIGEgdW5pdCBtaWdodCBpbmxpbmUsIGV4Y2VycHQsXG4gKiBvciByZWZlcmVuY2Ugb24tZGVtYW5kLiBBZGRpbmcgYSBuZXcgYXJ0aWZhY3QgY2xhc3MgcmVxdWlyZXMgKGEpIGEga2V5XG4gKiBoZXJlLCAoYikgcGF0aC9ib2R5IHJlc29sdXRpb24gaW4gdGhlIGNvbXBvc2VyLCBhbmQgKGMpIHVwZGF0ZXMgdG8gYW55XG4gKiBtYW5pZmVzdCB0aGF0IHNob3VsZCBzdXJmYWNlIGl0LlxuICovXG5leHBvcnQgY29uc3QgQVJUSUZBQ1RfS0VZUyA9IFtcbiAgLy8gTWlsZXN0b25lLXNjb3BlZFxuICBcInJvYWRtYXBcIixcbiAgXCJtaWxlc3RvbmUtY29udGV4dFwiLFxuICBcIm1pbGVzdG9uZS1zdW1tYXJ5XCIsXG4gIFwibWlsZXN0b25lLXZhbGlkYXRpb25cIixcbiAgXCJtaWxlc3RvbmUtcmVzZWFyY2hcIixcbiAgXCJtaWxlc3RvbmUtcGxhblwiLFxuICAvLyBTbGljZS1zY29wZWRcbiAgXCJzbGljZS1jb250ZXh0XCIsXG4gIFwic2xpY2UtcmVzZWFyY2hcIixcbiAgXCJzbGljZS1wbGFuXCIsXG4gIFwic2xpY2Utc3VtbWFyeVwiLFxuICBcInNsaWNlLXVhdFwiLFxuICBcInNsaWNlLWFzc2Vzc21lbnRcIixcbiAgLy8gVGFzay1zY29wZWRcbiAgXCJ0YXNrLXBsYW5cIixcbiAgXCJ0YXNrLXN1bW1hcnlcIixcbiAgXCJwcmlvci10YXNrLXN1bW1hcmllc1wiLFxuICBcImRlcGVuZGVuY3ktc3VtbWFyaWVzXCIsXG4gIC8vIFByb2plY3Qtc2NvcGVkXG4gIFwicmVxdWlyZW1lbnRzXCIsXG4gIFwiZGVjaXNpb25zXCIsXG4gIFwicHJvamVjdFwiLFxuICBcInRlbXBsYXRlc1wiLFxuXSBhcyBjb25zdDtcblxuZXhwb3J0IHR5cGUgQXJ0aWZhY3RLZXkgPSB0eXBlb2YgQVJUSUZBQ1RfS0VZU1tudW1iZXJdO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUG9saWN5IHR5cGVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFNraWxsIGNhdGFsb2cgcG9saWN5LiBgYWxsYCBwcmVzZXJ2ZXMgdG9kYXkncyBkZWZhdWx0OiB0aGUgZnVsbCBjYXRhbG9nXG4gKiBpcyBzdGFtcGVkIGludG8gdGhlIHByb21wdC4gYGFsbG93bGlzdGAgbmFycm93cyB0byB0aGUgbmFtZWQgc2tpbGxzLlxuICogYG5vbmVgIHN1cHByZXNzZXMgdGhlIGNhdGFsb2cgZW50aXJlbHkuXG4gKlxuICogVGhlIGFsbG93bGlzdCBtb2RlIHBhaXJzIHdpdGggYHNraWxsLW1hbmlmZXN0LnRzYCAoIzQ3NzkpIFx1MjAxNCBlbnRyaWVzXG4gKiB0aGVyZSBhcmUgdGhlIHNvdXJjZSBvZiB0cnV0aCBmb3IgXCJ3aGljaCBza2lsbHMgYXJlIGRpc3BhdGNoZWQgZm9yIGFcbiAqIHVuaXQgdHlwZVwiOyB0aGlzIG1hbmlmZXN0IGNhcnJpZXMgdGhlIHBvbGljeSBzaGFwZSBzbyB0aGUgY29tcG9zZXJcbiAqIGNhbiB1bmlmeSB0aGUgdHdvIHN1cmZhY2VzIGluIHBoYXNlIDIuXG4gKi9cbmV4cG9ydCB0eXBlIFNraWxsc1BvbGljeSA9XG4gIHwgeyByZWFkb25seSBtb2RlOiBcIm5vbmVcIiB9XG4gIHwgeyByZWFkb25seSBtb2RlOiBcImFsbFwiIH1cbiAgfCB7IHJlYWRvbmx5IG1vZGU6IFwiYWxsb3dsaXN0XCI7IHJlYWRvbmx5IHNraWxsczogcmVhZG9ubHkgc3RyaW5nW10gfTtcblxuLyoqIEtub3dsZWRnZSBibG9jayBwb2xpY3kgXHUyMDE0IHNlZSBgYm9vdHN0cmFwL3N5c3RlbS1jb250ZXh0LnRzYCBsb2FkS25vd2xlZGdlQmxvY2suICovXG5leHBvcnQgdHlwZSBLbm93bGVkZ2VQb2xpY3kgPSBcIm5vbmVcIiB8IFwiY3JpdGljYWwtb25seVwiIHwgXCJzY29wZWRcIiB8IFwiZnVsbFwiO1xuXG4vKiogTWVtb3J5IHN0b3JlIHBvbGljeSBcdTIwMTQgc2VlIGBib290c3RyYXAvc3lzdGVtLWNvbnRleHQudHNgIGxvYWRNZW1vcnlCbG9jay4gKi9cbmV4cG9ydCB0eXBlIE1lbW9yeVBvbGljeSA9IFwibm9uZVwiIHwgXCJjcml0aWNhbC1vbmx5XCIgfCBcInByb21wdC1yZWxldmFudFwiO1xuXG4vKiogUHJlZmVyZW5jZXMgYmxvY2sgcG9saWN5LiAqL1xuZXhwb3J0IHR5cGUgUHJlZmVyZW5jZXNQb2xpY3kgPSBcIm5vbmVcIiB8IFwiYWN0aXZlLW9ubHlcIiB8IFwiZnVsbFwiO1xuXG4vKiogQ29udGV4dCBNb2RlIGxhbmUgZ3VpZGFuY2UgcG9saWN5IGZvciBlYWNoIGF1dG8tbW9kZSB1bml0LiAqL1xuZXhwb3J0IHR5cGUgQ29udGV4dE1vZGVQb2xpY3kgPVxuICB8IFwibm9uZVwiXG4gIHwgXCJpbnRlcnZpZXdcIlxuICB8IFwicmVzZWFyY2hcIlxuICB8IFwicGxhbm5pbmdcIlxuICB8IFwiZXhlY3V0aW9uXCJcbiAgfCBcInZlcmlmaWNhdGlvblwiXG4gIHwgXCJvcmNoZXN0cmF0aW9uXCJcbiAgfCBcImRvY3NcIjtcblxuLyoqXG4gKiBUb29sLWFjY2VzcyBwb2xpY3kgcGVyIHVuaXQgdHlwZSAoIzQ5MzQpLlxuICpcbiAqIFJ1bnRpbWUtZW5mb3JjZWQgYnkgdGhlIEdTRCB3cml0ZSBnYXRlIGZvciBhY3RpdmUgYXV0by1tb2RlIHVuaXRzLiBUaGVcbiAqIG1hbmlmZXN0IGRlY2xhcmVzIHRoZSBhbGxvd2VkIHRvb2wgc3VyZmFjZTsgcmVnaXN0ZXItaG9va3MudHMgcmVzb2x2ZXMgdGhlXG4gKiBhY3RpdmUgdW5pdCdzIG1hbmlmZXN0IGJlZm9yZSBlYWNoIHRvb2wgY2FsbCBhbmQgd3JpdGUtZ2F0ZS50cyByZWplY3RzXG4gKiB2aW9sYXRpb25zIGJlZm9yZSB0aGUgdG9vbCBleGVjdXRlcy5cbiAqXG4gKiBNb2RlczpcbiAqICAgLSBcImFsbFwiICAgICAgICBcdTIwMTQgUmVhZCArIEVkaXQvV3JpdGUvTXVsdGlFZGl0L05vdGVib29rRWRpdCArIEJhc2ggKyBUYXNrLlxuICogICAgICAgICAgICAgICAgICAgIFRoZSB1bml0IG1heSBtb2RpZnkgYW55IGZpbGUgaW4gdGhlIHdvcmtpbmcgdHJlZS5cbiAqICAgICAgICAgICAgICAgICAgICBSZXNlcnZlZCBmb3IgZXhlY3V0ZS10YXNrIC8gcmVhY3RpdmUtZXhlY3V0ZSwgd2hpY2ggcnVuXG4gKiAgICAgICAgICAgICAgICAgICAgaW4gd29ya3RyZWVzIHRvZGF5IGFuZCB3aG9zZSB3cml0ZXMgYXJlIGNvbW1pdHRlZC5cbiAqICAgLSBcInJlYWQtb25seVwiICBcdTIwMTQgUmVhZCB0b29scyBvbmx5LiBObyBmaWxlIG11dGF0aW9uLiBObyBzaGVsbC4gTm8gc3ViYWdlbnRcbiAqICAgICAgICAgICAgICAgICAgICBkaXNwYXRjaC4gUmVzZXJ2ZWQgZm9yIGZ1dHVyZSB1bml0cyB0aGF0IHNob3VsZCBiZVxuICogICAgICAgICAgICAgICAgICAgIHN0cmljdGx5IG9ic2VydmF0aW9uYWwgKG5vbmUgdG9kYXkpLlxuICogICAtIFwicGxhbm5pbmdcIiAgIFx1MjAxNCBSZWFkIHRvb2xzIGFsd2F5czsgd3JpdGVzIHJlc3RyaWN0ZWQgdG8gLmdzZC8qKiB1bmRlclxuICogICAgICAgICAgICAgICAgICAgIGJhc2VQYXRoOyBCYXNoIGxpbWl0ZWQgdG8gYSBwZXItdW5pdCBzYWZlIGFsbG93bGlzdDtcbiAqICAgICAgICAgICAgICAgICAgICBUYXNrIHN1YmFnZW50IGRpc3BhdGNoIGRlbmllZC4gQ2F0Y2hlcyB0aGUgYnVnIGNsYXNzXG4gKiAgICAgICAgICAgICAgICAgICAgd2hlcmUgYSBkaXNjdXNzLW1pbGVzdG9uZSB0dXJuIG1vZGlmaWVzIHVzZXIgc291cmNlXG4gKiAgICAgICAgICAgICAgICAgICAgZmlsZXMgKGZvcmVuc2ljczogfi9HaXRodWIvdGVzdC1hcHBzL2IyMywgIzQ5MzQpLlxuICogICAtIFwicGxhbm5pbmctZGlzcGF0Y2hcIlxuICogICAgICAgICAgICAgICAgICBcdTIwMTQgU2FtZSByZWFkICsgLmdzZC8qKiB3cml0ZSArIHNhZmUtQmFzaCBzdXJmYWNlIGFzXG4gKiAgICAgICAgICAgICAgICAgICAgXCJwbGFubmluZ1wiLCBidXQgcGVybWl0cyBjb250cm9sbGVkIHN1YmFnZW50IGRpc3BhdGNoXG4gKiAgICAgICAgICAgICAgICAgICAgb25seSB0byB0aGUgYWdlbnRzIGxpc3RlZCBpbiB0aGUgVG9vbHNQb2xpY3lcbiAqICAgICAgICAgICAgICAgICAgICBgYWxsb3dlZFN1YmFnZW50c2AgZmllbGQuIFNlZSB3cml0ZS1nYXRlLnRzIGZvciB0aGVcbiAqICAgICAgICAgICAgICAgICAgICBydW50aW1lIGFnZW50LWNsYXNzIGVuZm9yY2VtZW50IGRldGFpbHMuXG4gKiAgIC0gXCJkb2NzXCIgICAgICAgXHUyMDE0IFJlYWQgdG9vbHMgYWx3YXlzOyB3cml0ZXMgcmVzdHJpY3RlZCB0byAuZ3NkLyoqIEFORFxuICogICAgICAgICAgICAgICAgICAgIHRoZSBleHBsaWNpdCBgYWxsb3dlZFBhdGhHbG9ic2Agc2V0OyBCYXNoIHNhZmUtYWxsb3dsaXN0O1xuICogICAgICAgICAgICAgICAgICAgIG5vIHN1YmFnZW50cy4gUmVzZXJ2ZWQgZm9yIHJld3JpdGUtZG9jcywgd2hpY2ggbGVnaXRpbWF0ZWx5XG4gKiAgICAgICAgICAgICAgICAgICAgZWRpdHMgcHJvamVjdCBtYXJrZG93biBvdXRzaWRlIC5nc2QvLlxuICogICAtIFwidmVyaWZpY2F0aW9uXCJcbiAqICAgICAgICAgICAgICAgICAgXHUyMDE0IFJlYWQgdG9vbHMgKyBCYXNoIGZvciB2ZXJpZmljYXRpb24gY29tbWFuZHMsIHdyaXRlc1xuICogICAgICAgICAgICAgICAgICAgIHJlc3RyaWN0ZWQgdG8gLmdzZC8qKiwgbm8gc3ViYWdlbnRzLlxuICpcbiAqIFRoZSBhbGxvd2xpc3QgZm9yIFwiZG9jc1wiIGlzIGRlY2xhcmVkIHBlci1tYW5pZmVzdCByYXRoZXIgdGhhbiBoYXJkY29kZWQgc29cbiAqIHByb2plY3RzIHdpdGggbm9uLXN0YW5kYXJkIGRvYyBsYXlvdXRzIGNhbiBleHRlbmQgaXQgd2l0aG91dCBmb3JraW5nIHRoZVxuICogZW5mb3JjZW1lbnQgY29kZSAob3BlbiBxdWVzdGlvbiBmb3IgdGhlIHdpcmluZyBQUiBcdTIwMTQgZXhhY3QgcmVwcmVzZW50YXRpb25cbiAqIG1heSBzaGlmdCkuIEdsb2JzIGFyZSBpbnRlcnByZXRlZCByZWxhdGl2ZSB0byB0aGUgcHJvamVjdCBiYXNlUGF0aC5cbiAqL1xuZXhwb3J0IHR5cGUgVG9vbHNQb2xpY3kgPVxuICB8IHsgcmVhZG9ubHkgbW9kZTogXCJhbGxcIiB9XG4gIHwgeyByZWFkb25seSBtb2RlOiBcInJlYWQtb25seVwiIH1cbiAgfCB7IHJlYWRvbmx5IG1vZGU6IFwicGxhbm5pbmdcIiB9XG4gIHwgeyByZWFkb25seSBtb2RlOiBcInBsYW5uaW5nLWRpc3BhdGNoXCI7IHJlYWRvbmx5IGFsbG93ZWRTdWJhZ2VudHM6IHJlYWRvbmx5IHN0cmluZ1tdIH1cbiAgfCB7IHJlYWRvbmx5IG1vZGU6IFwiZG9jc1wiOyByZWFkb25seSBhbGxvd2VkUGF0aEdsb2JzOiByZWFkb25seSBzdHJpbmdbXSB9XG4gIHwgeyByZWFkb25seSBtb2RlOiBcInZlcmlmaWNhdGlvblwiIH07XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBDb21wdXRlZC1hcnRpZmFjdCByZWdpc3RyeSAoIzQ5MjQgdjIgY29udHJhY3QpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFR5cGVkIHJlZ2lzdHJ5IG9mIGNvbXB1dGVkLWFydGlmYWN0IGlkcyBcdTIxOTIgdGhlaXIgcGVyLWNhbGwgaW5wdXQgc2hhcGUuXG4gKlxuICogKipUaGlzIGlzIHRoZSBjb3JlIGFudGktYGV4dHJhOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPmAgc3VyZmFjZS4qKiBFYWNoXG4gKiBjb21wdXRlZCBibG9jayBhIHVuaXQgbWF5IGVtaXQgaXMgcmVnaXN0ZXJlZCBoZXJlIHdpdGggYW4gZXhwbGljaXQgaW5wdXRcbiAqIHR5cGUuIEFkZGluZyBhIG5ldyBjb21wdXRlZCBibG9jayByZXF1aXJlcyBleHRlbmRpbmcgdGhpcyBpbnRlcmZhY2UgXHUyMDE0IGFcbiAqIGRlbGliZXJhdGUsIHJldmlld2FibGUgY2hhbmdlIHJhdGhlciB0aGFuIGEgc2lsZW50IGFkLWhvYyBmaWVsZC5cbiAqXG4gKiBDb25zdW1lcnMgZXh0ZW5kIHZpYSBtb2R1bGUgYXVnbWVudGF0aW9uIGlmIGEgZG93bnN0cmVhbSBwYWNrYWdlIG5lZWRzIHRvXG4gKiByZWdpc3RlciBuZXcgY29tcHV0ZWQgaWRzIChyYXJlIGluLXRyZWU7IG5vIHB1YmxpYyBBUEkgdG9kYXkpLiBUaGUgcmVwbydzXG4gKiBvd24gY29tcHV0ZWQgYmxvY2tzIGFyZSBkZWNsYXJlZCBpbmxpbmUgYmVsb3cuXG4gKlxuICogSW52YXJpYW50OiB0aGUgdmFsdWUgdHlwZSBmb3IgZWFjaCBpZCBNVVNUIGJlIGEgcGxhaW4gc2VyaWFsaXphYmxlIHNoYXBlLlxuICogTm8gY2xvc3VyZXMsIG5vIGNsYXNzIGluc3RhbmNlcywgbm8gYGFueWAuIElmIGEgYnVpbGRlciBuZWVkcyBmcmFtZXdvcmtcbiAqIHN0YXRlLCBkZWNsYXJlIHRoZSBzcGVjaWZpYyBmaWVsZHMgaXQgbmVlZHMgXHUyMDE0IGRvbid0IHNtdWdnbGUgb2JqZWN0cy5cbiAqL1xuLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby1lbXB0eS1pbnRlcmZhY2VcbmV4cG9ydCBpbnRlcmZhY2UgQ29tcHV0ZWRBcnRpZmFjdElucHV0cyB7XG4gIC8vIFBoYXNlIDMuNSAodjIgY29udHJhY3QgUFIgXHUyMDE0ICM0OTI0KTogbm8gY29tcHV0ZWQgaWRzIGFyZSByZWdpc3RlcmVkIHlldC5cbiAgLy8gRWFjaCBmb2xsb3ctdXAgYmF0Y2ggKHNsaWNlIHByb21wdCwgcmVwbGFuLXNsaWNlLCBnYXRlLWV2YWx1YXRlLCBldGMuKVxuICAvLyBhZGRzIHRoZSBpZHMgaXQgbmVlZHMgYXMgcGFydCBvZiBpdHMgbWlncmF0aW9uIGNvbW1pdC5cbiAgLy9cbiAgLy8gRXhhbXBsZSBzaGFwZSBhbiB1cGNvbWluZyBiYXRjaCB3aWxsIHJlZ2lzdGVyOlxuICAvLyAgIFwic2xpY2UtaGFuZG9mZi1hbmNob3JzXCI6IHsgc2xpY2VJZDogc3RyaW5nOyBwaGFzZTogc3RyaW5nIH07XG4gIC8vICAgXCJyb2FkbWFwLWV4Y2VycHRcIjogICAgICAgeyBtaWxlc3RvbmVJZDogc3RyaW5nOyBhcm91bmRTbGljZTogc3RyaW5nIH07XG4gIC8vICAgXCJncmFwaC1zdWJncmFwaFwiOiAgICAgICAgeyByb290QXJ0aWZhY3Q6IEFydGlmYWN0S2V5IH07XG4gIC8vICAgXCJibG9ja2VyLXRhc2stc3VtbWFyeVwiOiAgeyBzbGljZUlkOiBzdHJpbmcgfTtcbiAgLy8gICBcIm92ZXJyaWRlcy1iYW5uZXJcIjogICAgICB7IC8qIGJhc2VQYXRoIHZpYSBCYXNlUmVzb2x2ZXJDb250ZXh0ICovIH07XG59XG5cbi8qKiBTdGFibGUgc3RyaW5nIGlkcyBmb3IgcmVnaXN0ZXJlZCBjb21wdXRlZCBhcnRpZmFjdHMuICovXG5leHBvcnQgdHlwZSBDb21wdXRlZEFydGlmYWN0SWQgPSBrZXlvZiBDb21wdXRlZEFydGlmYWN0SW5wdXRzICYgc3RyaW5nO1xuXG4vKipcbiAqIEFsd2F5cy1wcmVzZW50IGNvbnRleHQgdGhlIGNvbXBvc2VyIGhhbmRzIGV2ZXJ5IGNvbXB1dGVkLWFydGlmYWN0IGJ1aWxkZXIuXG4gKiBDYXJyaWVzIHVuaXQtc2hhcGUgZmllbGRzIHRoYXQgZG9uJ3QgYmVsb25nIGluIHBlci1pZCBpbnB1dCB0eXBlcyBiZWNhdXNlXG4gKiBldmVyeSBidWlsZGVyIG5lZWRzIHRoZW0gKHBhdGggcmVzb2x1dGlvbiwgZGlzcGF0Y2ggaWRlbnRpdHkpLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEJhc2VSZXNvbHZlckNvbnRleHQge1xuICByZWFkb25seSB1bml0VHlwZTogc3RyaW5nO1xuICByZWFkb25seSBiYXNlUGF0aDogc3RyaW5nO1xuICByZWFkb25seSBtaWxlc3RvbmVJZD86IHN0cmluZztcbiAgcmVhZG9ubHkgc2xpY2VJZD86IHN0cmluZztcbiAgcmVhZG9ubHkgdGFza0lkPzogc3RyaW5nO1xufVxuXG4vKipcbiAqIEJ1aWxkZXIgc2lnbmF0dXJlIGZvciBvbmUgY29tcHV0ZWQgYXJ0aWZhY3QgaWQuIFJldHVybnMgdGhlIHJlbmRlcmVkXG4gKiBibG9jayBib2R5IChqb2luZWQgaW50byB0aGUgY29tcG9zZWQgcHJvbXB0IGF0IHRoZSBtYW5pZmVzdC1kZWNsYXJlZFxuICogcG9zaXRpb24pIG9yIGBudWxsYCB0byBvbWl0IHRoZSBibG9jayBlbnRpcmVseS5cbiAqL1xuZXhwb3J0IHR5cGUgQ29tcHV0ZWRBcnRpZmFjdEJ1aWxkZXI8SyBleHRlbmRzIENvbXB1dGVkQXJ0aWZhY3RJZD4gPSAoXG4gIGlucHV0czogQ29tcHV0ZWRBcnRpZmFjdElucHV0c1tLXSxcbiAgYmFzZTogQmFzZVJlc29sdmVyQ29udGV4dCxcbikgPT4gUHJvbWlzZTxzdHJpbmcgfCBudWxsPjtcblxuLyoqXG4gKiBQZXItY2FsbCByZWdpc3RyeTogZm9yIGVhY2ggY29tcHV0ZWQgaWQgdGhlIG1hbmlmZXN0IGRlY2xhcmVzLCB0aGVcbiAqIGNhbGxlciBzdXBwbGllcyB0aGUgbWF0Y2hpbmcgYnVpbGRlciArIHRoZSBpbnB1dCB2YWx1ZSBmb3IgdGhpcyBjYWxsLlxuICpcbiAqIFJ1bnRpbWUgc2hhcGU6IGB7IFtpZF06IHsgYnVpbGQsIGlucHV0cyB9IH1gLiBUeXBlIG5hcnJvd2luZyBwZXIga2V5IGlzXG4gKiBoYW5kbGVkIGluc2lkZSB0aGUgY29tcG9zZXIgdmlhIHRoZSBgQ29tcHV0ZWRBcnRpZmFjdElucHV0c2AgbWFwIFx1MjAxNCBjYWxsc1xuICogc3RheSB0eXBlLXNhZmUgYWNyb3NzIHRoZSByZWdpc3RyYXRpb24gYm91bmRhcnkuXG4gKi9cbmV4cG9ydCB0eXBlIENvbXB1dGVkQXJ0aWZhY3RSZWdpc3RyeSA9IHtcbiAgcmVhZG9ubHkgW0sgaW4gQ29tcHV0ZWRBcnRpZmFjdElkXT86IHtcbiAgICByZWFkb25seSBidWlsZDogQ29tcHV0ZWRBcnRpZmFjdEJ1aWxkZXI8Sz47XG4gICAgcmVhZG9ubHkgaW5wdXRzOiBDb21wdXRlZEFydGlmYWN0SW5wdXRzW0tdO1xuICB9O1xufTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIE1hbmlmZXN0IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgaW50ZXJmYWNlIFVuaXRDb250ZXh0TWFuaWZlc3Qge1xuICAvKiogU2tpbGxzIGNhdGFsb2cgc2hhcGUgdG8gc3VyZmFjZS4gKi9cbiAgcmVhZG9ubHkgc2tpbGxzOiBTa2lsbHNQb2xpY3k7XG4gIC8qKiBLbm93bGVkZ2UgYmxvY2sgcG9saWN5LiAqL1xuICByZWFkb25seSBrbm93bGVkZ2U6IEtub3dsZWRnZVBvbGljeTtcbiAgLyoqIE1lbW9yeSBzdG9yZSBwb2xpY3kuICovXG4gIHJlYWRvbmx5IG1lbW9yeTogTWVtb3J5UG9saWN5O1xuICAvKiogV2hldGhlciBDT0RFQkFTRS5tZCBpcyBpbmxpbmVkLiAqL1xuICByZWFkb25seSBjb2RlYmFzZU1hcDogYm9vbGVhbjtcbiAgLyoqIFByZWZlcmVuY2VzIGJsb2NrIHBvbGljeS4gKi9cbiAgcmVhZG9ubHkgcHJlZmVyZW5jZXM6IFByZWZlcmVuY2VzUG9saWN5O1xuICAvKiogQ29udGV4dCBNb2RlIGd1aWRhbmNlIGxhbmUuICovXG4gIHJlYWRvbmx5IGNvbnRleHRNb2RlOiBDb250ZXh0TW9kZVBvbGljeTtcbiAgLyoqXG4gICAqIFRvb2wtYWNjZXNzIHBvbGljeSAoIzQ5MzQpLiBSdW50aW1lIGVuZm9yY2VtZW50IGNvdmVycyBwYXRoLXNjb3BlZCB3cml0ZVxuICAgKiBibG9ja2luZywgc3ViYWdlbnQgZGVuaWFsLCBhbmQgYmFzaCBhbGxvd2xpc3RpbmcgZm9yIGFjdGl2ZSBhdXRvLW1vZGVcbiAgICogdW5pdHMuIFJlcXVpcmVkIG9uIGV2ZXJ5IG1hbmlmZXN0IHNvIG1pc3NpbmcgZW50cmllcyBmYWlsIGxvdWQgdmlhIHRoZSBDSVxuICAgKiBpbnZhcmlhbnQgdGVzdCByYXRoZXIgdGhhbiBkZWZhdWx0aW5nIHRvIFwiYWxsXCIgc2lsZW50bHkuXG4gICAqL1xuICByZWFkb25seSB0b29sczogVG9vbHNQb2xpY3k7XG4gIC8qKiBBcnRpZmFjdCBoYW5kbGluZzogaW5saW5lIChmdWxsIGJvZHkpLCBleGNlcnB0IChjb21wYWN0KSwgb3Igb24tZGVtYW5kIChwYXRoIG9ubHkpLiAqL1xuICByZWFkb25seSBhcnRpZmFjdHM6IHtcbiAgICByZWFkb25seSBpbmxpbmU6IHJlYWRvbmx5IEFydGlmYWN0S2V5W107XG4gICAgcmVhZG9ubHkgZXhjZXJwdDogcmVhZG9ubHkgQXJ0aWZhY3RLZXlbXTtcbiAgICByZWFkb25seSBvbkRlbWFuZDogcmVhZG9ubHkgQXJ0aWZhY3RLZXlbXTtcbiAgICAvKipcbiAgICAgKiBPcmRlcmVkIGxpc3Qgb2YgY29tcHV0ZWQtYmxvY2sgaWRzIGVtaXR0ZWQgaW4gdGhlIGlubGluZSBwb3NpdGlvblxuICAgICAqIChpbnRlcmxlYXZlZCB3aXRoIGBpbmxpbmVgIGluIGRlY2xhcmVkIG9yZGVyIFx1MjAxNCBzZWUgY29tcG9zZXIgZm9yIHRoZVxuICAgICAqIGV4YWN0IG1lcmdlIHJ1bGUpLiB2MiBjb250cmFjdCBhZGRpdGlvbiAoIzQ5MjQpLiBVbmtub3duIGlkcyBmYWlsXG4gICAgICogdGhlIG1hbmlmZXN0IHZhbGlkYXRvcjsgYWJzZW50IHJlZ2lzdHJ5IGVudHJpZXMgYXJlIHNraXBwZWQgc2lsZW50bHkuXG4gICAgICovXG4gICAgcmVhZG9ubHkgY29tcHV0ZWQ/OiByZWFkb25seSBDb21wdXRlZEFydGlmYWN0SWRbXTtcbiAgfTtcbiAgLyoqXG4gICAqIE9yZGVyZWQgbGlzdCBvZiBjb21wdXRlZC1ibG9jayBpZHMgZW1pdHRlZCBBQk9WRSB0aGUgbWFpbiBpbmxpbmVkXG4gICAqIGNvbnRleHQgYmxvY2suIE1vZGVscyB0aGUgZXhpc3RpbmcgcGF0dGVybiBvZiBvdmVycmlkZXMgLyBiYW5uZXJzXG4gICAqIHRoYXQgc29tZSBidWlsZGVycyBwcmVwZW5kIHdpdGggYGlubGluZWQudW5zaGlmdCguLi4pYC4gdjIgY29udHJhY3RcbiAgICogYWRkaXRpb24gKCM0OTI0KS5cbiAgICovXG4gIHJlYWRvbmx5IHByZXBlbmQ/OiByZWFkb25seSBDb21wdXRlZEFydGlmYWN0SWRbXTtcbiAgLyoqXG4gICAqIE5vbWluYWwgdXBwZXIgYm91bmQgZm9yIGNvbXBvc2VyLWdlbmVyYXRlZCBzeXN0ZW0gcHJvbXB0IHNpemUsIGluXG4gICAqIGNoYXJhY3RlcnMuIFBoYXNlIDIgY29tcG9zZXIgbG9ncyB0ZWxlbWV0cnkgd2hlbiBhIHVuaXQgZXhjZWVkcyBpdHNcbiAgICogYnVkZ2V0OyB0cnVuY2F0aW9uIGlzIG5vdCBlbmZvcmNlZC4gU2V0IGNvbnNlcnZhdGl2ZWx5IFx1MjAxNCB0b2RheSdzXG4gICAqIG9ic2VydmVkIG1heGltYSBjb21lIGZyb20gYGNvbXBsZXRlLW1pbGVzdG9uZWAgKH4xLjJNIHRva2VucyBjYWNoZWQ7XG4gICAqIH40LjhNIGNoYXJzKSBhbmQgYHZhbGlkYXRlLW1pbGVzdG9uZWAgKH4zMDBLIHRva2VuczsgfjEuMk0gY2hhcnMpLlxuICAgKi9cbiAgcmVhZG9ubHkgbWF4U3lzdGVtUHJvbXB0Q2hhcnM6IG51bWJlcjtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIE1hbmlmZXN0cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLy8gUGhhc2UgMSBwb2xpY3k6IGV2ZXJ5IG1hbmlmZXN0IGVuY29kZXMgdG9kYXkncyBiZWhhdmlvci4gU2tpbGxzID0gXCJhbGxcIlxuLy8gdW5sZXNzIHRoZSB1bml0IHR5cGUgd2FzIGFscmVhZHkgbmFycm93ZWQgdmlhIHRoZSBleGlzdGluZyBza2lsbC1tYW5pZmVzdFxuLy8gcmVzb2x2ZXIgKCM0Nzc5KS4gTWVtb3J5L2tub3dsZWRnZSBwb2xpY2llcyByZWZsZWN0IHRoZSBkZWZhdWx0cyBpblxuLy8gYGJvb3RzdHJhcC9zeXN0ZW0tY29udGV4dC50c2AuIEFydGlmYWN0IGNsYXNzaWZpY2F0aW9ucyBmb2xsb3cgd2hhdFxuLy8gYGF1dG8tcHJvbXB0cy50c2AgaW5saW5lcyB0b2RheSBmb3IgZWFjaCB1bml0IHR5cGUuXG5cbmNvbnN0IENPTU1PTl9CVURHRVRfTEFSR0UgPSAxXzUwMF8wMDA7ICAvLyB+NDAwSyB0b2tlbnNcbmNvbnN0IENPTU1PTl9CVURHRVRfTUVESVVNID0gNzUwXzAwMDsgICAvLyB+MjAwSyB0b2tlbnNcbmNvbnN0IENPTU1PTl9CVURHRVRfU01BTEwgPSAyNTBfMDAwOyAgICAvLyB+NjVLIHRva2Vuc1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVG9vbCBwb2xpY3kgY29uc3RhbnRzICgjNDkzNCkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4vLyBSZXVzZWQgYWNyb3NzIG1hbmlmZXN0cyBzbyBwZXItdW5pdCBhc3NpZ25tZW50IHN0YXlzIGRlY2xhcmF0aXZlIGFuZCB0aGVcbi8vIGFsbG93ZWQtcGF0aCBzZXQgZm9yIHRoZSBkb2NzIHBvbGljeSBsaXZlcyBpbiBvbmUgcmV2aWV3YWJsZSBwbGFjZS5cblxuY29uc3QgVE9PTFNfQUxMOiBUb29sc1BvbGljeSA9IHsgbW9kZTogXCJhbGxcIiB9O1xuY29uc3QgVE9PTFNfUExBTk5JTkc6IFRvb2xzUG9saWN5ID0geyBtb2RlOiBcInBsYW5uaW5nXCIgfTtcbmNvbnN0IFRPT0xTX1ZFUklGSUNBVElPTjogVG9vbHNQb2xpY3kgPSB7IG1vZGU6IFwidmVyaWZpY2F0aW9uXCIgfTtcbi8vIExpa2UgVE9PTFNfUExBTk5JTkcgYnV0IHBlcm1pdHMgZGlzcGF0Y2ggdG8gcmVhZC1vbmx5IHJlY29uL3BsYW5uaW5nXG4vLyBzcGVjaWFsaXN0cy4gUnVudGltZS1lbmZvcmNlZCBieSB3cml0ZS1nYXRlLnRzIGJlZm9yZSB0aGUgc3ViYWdlbnQgdG9vbCBydW5zLlxuY29uc3QgVE9PTFNfUExBTk5JTkdfRElTUEFUQ0hfUkVDT046IFRvb2xzUG9saWN5ID0ge1xuICBtb2RlOiBcInBsYW5uaW5nLWRpc3BhdGNoXCIsXG4gIGFsbG93ZWRTdWJhZ2VudHM6IFtcInNjb3V0XCIsIFwicGxhbm5lclwiXSxcbn07XG4vLyBMaWtlIFRPT0xTX1BMQU5OSU5HX0RJU1BBVENIX1JFQ09OLCBidXQgZm9yIGNsb3Nlb3V0IHVuaXRzIHRoYXQgZmFuIG91dFxuLy8gdmVyaWZpY2F0aW9uIHdvcmsgdG8gcmV2aWV3LXRpZXIgc3BlY2lhbGlzdHMuXG5jb25zdCBUT09MU19QTEFOTklOR19ESVNQQVRDSF9SRVZJRVc6IFRvb2xzUG9saWN5ID0ge1xuICBtb2RlOiBcInBsYW5uaW5nLWRpc3BhdGNoXCIsXG4gIGFsbG93ZWRTdWJhZ2VudHM6IFtcInJldmlld2VyXCIsIFwic2VjdXJpdHlcIiwgXCJ0ZXN0ZXJcIl0sXG59O1xuY29uc3QgVE9PTFNfRE9DUzogVG9vbHNQb2xpY3kgPSB7XG4gIG1vZGU6IFwiZG9jc1wiLFxuICAvLyBHbG9icyBhcmUgcmVzb2x2ZWQgcmVsYXRpdmUgdG8gcHJvamVjdCBiYXNlUGF0aC4gVGhlIHNldCBpcyBpbnRlbnRpb25hbGx5XG4gIC8vIG5hcnJvdzogdG9wLWxldmVsIGRvY3MvLCBSRUFETUUsIENIQU5HRUxPRywgYW5kIGFueSBtYXJrZG93biBhdCB0aGVcbiAgLy8gcHJvamVjdCByb290LiBQcm9qZWN0cyB3aXRoIG5vbi1zdGFuZGFyZCBsYXlvdXRzIChlLmcuIG1pbnRsaWZ5LWRvY3MvKVxuICAvLyB3aWxsIG5lZWQgdGhpcyBsaXN0IGV4dGVuZGVkIGluIGEgZm9sbG93LXVwOyBsYW5kZWQgY29uc2VydmF0aXZlIG5vdyxcbiAgLy8gZXhwYW5kIG9uIGRlbWFuZC5cbiAgYWxsb3dlZFBhdGhHbG9iczogW1xuICAgIFwiZG9jcy8qKlwiLFxuICAgIFwiUkVBRE1FLm1kXCIsXG4gICAgXCJSRUFETUUuKi5tZFwiLFxuICAgIFwiQ0hBTkdFTE9HLm1kXCIsXG4gICAgXCIqLm1kXCIsXG4gIF0sXG59O1xuXG4vKipcbiAqIENhbm9uaWNhbCB1bml0IHR5cGVzIGhhbmRsZWQgYnkgYXV0by1tb2RlIGRpc3BhdGNoLiBUaGUgY292ZXJhZ2UgdGVzdFxuICogZW51bWVyYXRlcyB0aGVzZSBhZ2FpbnN0IGBVTklUX01BTklGRVNUU2AgdG8gY2F0Y2ggbWFuaWZlc3QgZHJpZnQgd2hlblxuICogYSBuZXcgdW5pdCB0eXBlIGxhbmRzLlxuICovXG5leHBvcnQgY29uc3QgS05PV05fVU5JVF9UWVBFUyA9IFtcbiAgXCJyZXNlYXJjaC1taWxlc3RvbmVcIixcbiAgXCJwbGFuLW1pbGVzdG9uZVwiLFxuICBcImRpc2N1c3MtbWlsZXN0b25lXCIsXG4gIFwidmFsaWRhdGUtbWlsZXN0b25lXCIsXG4gIFwiY29tcGxldGUtbWlsZXN0b25lXCIsXG4gIFwicmVzZWFyY2gtc2xpY2VcIixcbiAgXCJwbGFuLXNsaWNlXCIsXG4gIFwicmVmaW5lLXNsaWNlXCIsXG4gIFwicmVwbGFuLXNsaWNlXCIsXG4gIFwiY29tcGxldGUtc2xpY2VcIixcbiAgXCJyZWFzc2Vzcy1yb2FkbWFwXCIsXG4gIFwiZXhlY3V0ZS10YXNrXCIsXG4gIFwicmVhY3RpdmUtZXhlY3V0ZVwiLFxuICBcInJ1bi11YXRcIixcbiAgXCJnYXRlLWV2YWx1YXRlXCIsXG4gIFwicmV3cml0ZS1kb2NzXCIsXG4gIC8vIERlZXAgcGxhbm5pbmcgbW9kZSAocHJvamVjdC1sZXZlbCkgdW5pdHNcbiAgXCJ3b3JrZmxvdy1wcmVmZXJlbmNlc1wiLFxuICBcImRpc2N1c3MtcHJvamVjdFwiLFxuICBcImRpc2N1c3MtcmVxdWlyZW1lbnRzXCIsXG4gIFwicmVzZWFyY2gtZGVjaXNpb25cIixcbiAgXCJyZXNlYXJjaC1wcm9qZWN0XCIsXG5dIGFzIGNvbnN0O1xuXG5leHBvcnQgdHlwZSBVbml0VHlwZSA9IHR5cGVvZiBLTk9XTl9VTklUX1RZUEVTW251bWJlcl07XG5cbmV4cG9ydCBjb25zdCBVTklUX01BTklGRVNUUzogUmVjb3JkPFVuaXRUeXBlLCBVbml0Q29udGV4dE1hbmlmZXN0PiA9IHtcbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIE1pbGVzdG9uZS1zY29wZWQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIFwicmVzZWFyY2gtbWlsZXN0b25lXCI6IHtcbiAgICBza2lsbHM6IHsgbW9kZTogXCJhbGxcIiB9LFxuICAgIGtub3dsZWRnZTogXCJmdWxsXCIsXG4gICAgbWVtb3J5OiBcInByb21wdC1yZWxldmFudFwiLFxuICAgIGNvZGViYXNlTWFwOiB0cnVlLFxuICAgIHByZWZlcmVuY2VzOiBcImFjdGl2ZS1vbmx5XCIsXG4gICAgY29udGV4dE1vZGU6IFwicmVzZWFyY2hcIixcbiAgICB0b29sczogVE9PTFNfUExBTk5JTkcsXG4gICAgYXJ0aWZhY3RzOiB7XG4gICAgICAvLyBQaGFzZSAzIG1pZ3JhdGlvbiAoIzQ3ODIpOiBtYXRjaGVzIHRvZGF5J3MgYWN0dWFsXG4gICAgICAvLyBidWlsZFJlc2VhcmNoTWlsZXN0b25lUHJvbXB0IGlubGluaW5nIG9yZGVyLlxuICAgICAgaW5saW5lOiBbXCJtaWxlc3RvbmUtY29udGV4dFwiLCBcInByb2plY3RcIiwgXCJyZXF1aXJlbWVudHNcIiwgXCJkZWNpc2lvbnNcIiwgXCJ0ZW1wbGF0ZXNcIl0sXG4gICAgICBleGNlcnB0OiBbXSxcbiAgICAgIG9uRGVtYW5kOiBbXSxcbiAgICB9LFxuICAgIG1heFN5c3RlbVByb21wdENoYXJzOiBDT01NT05fQlVER0VUX01FRElVTSxcbiAgfSxcbiAgXCJwbGFuLW1pbGVzdG9uZVwiOiB7XG4gICAgc2tpbGxzOiB7IG1vZGU6IFwiYWxsXCIgfSxcbiAgICBrbm93bGVkZ2U6IFwiZnVsbFwiLFxuICAgIG1lbW9yeTogXCJwcm9tcHQtcmVsZXZhbnRcIixcbiAgICBjb2RlYmFzZU1hcDogdHJ1ZSxcbiAgICBwcmVmZXJlbmNlczogXCJhY3RpdmUtb25seVwiLFxuICAgIGNvbnRleHRNb2RlOiBcInBsYW5uaW5nXCIsXG4gICAgdG9vbHM6IFRPT0xTX1BMQU5OSU5HLFxuICAgIGFydGlmYWN0czoge1xuICAgICAgaW5saW5lOiBbXCJwcm9qZWN0XCIsIFwicmVxdWlyZW1lbnRzXCIsIFwiZGVjaXNpb25zXCIsIFwibWlsZXN0b25lLXJlc2VhcmNoXCIsIFwidGVtcGxhdGVzXCJdLFxuICAgICAgZXhjZXJwdDogW10sXG4gICAgICBvbkRlbWFuZDogW10sXG4gICAgfSxcbiAgICBtYXhTeXN0ZW1Qcm9tcHRDaGFyczogQ09NTU9OX0JVREdFVF9MQVJHRSxcbiAgfSxcbiAgXCJkaXNjdXNzLW1pbGVzdG9uZVwiOiB7XG4gICAgc2tpbGxzOiB7IG1vZGU6IFwiYWxsXCIgfSxcbiAgICBrbm93bGVkZ2U6IFwiZnVsbFwiLFxuICAgIG1lbW9yeTogXCJwcm9tcHQtcmVsZXZhbnRcIixcbiAgICBjb2RlYmFzZU1hcDogdHJ1ZSxcbiAgICBwcmVmZXJlbmNlczogXCJhY3RpdmUtb25seVwiLFxuICAgIGNvbnRleHRNb2RlOiBcImludGVydmlld1wiLFxuICAgIHRvb2xzOiBUT09MU19QTEFOTklORyxcbiAgICBhcnRpZmFjdHM6IHtcbiAgICAgIGlubGluZTogW1wicHJvamVjdFwiLCBcInJlcXVpcmVtZW50c1wiLCBcImRlY2lzaW9uc1wiLCBcIm1pbGVzdG9uZS1jb250ZXh0XCIsIFwidGVtcGxhdGVzXCJdLFxuICAgICAgZXhjZXJwdDogW10sXG4gICAgICBvbkRlbWFuZDogW10sXG4gICAgfSxcbiAgICBtYXhTeXN0ZW1Qcm9tcHRDaGFyczogQ09NTU9OX0JVREdFVF9NRURJVU0sXG4gIH0sXG4gIFwidmFsaWRhdGUtbWlsZXN0b25lXCI6IHtcbiAgICBza2lsbHM6IHsgbW9kZTogXCJhbGxcIiB9LFxuICAgIGtub3dsZWRnZTogXCJzY29wZWRcIixcbiAgICBtZW1vcnk6IFwicHJvbXB0LXJlbGV2YW50XCIsXG4gICAgY29kZWJhc2VNYXA6IGZhbHNlLFxuICAgIHByZWZlcmVuY2VzOiBcImFjdGl2ZS1vbmx5XCIsXG4gICAgY29udGV4dE1vZGU6IFwidmVyaWZpY2F0aW9uXCIsXG4gICAgLy8gcGxhbm5pbmctZGlzcGF0Y2g6IHZhbGlkYXRpb24gaXMgYSB2ZXJpZmljYXRpb24tZmFuLW91dCB1bml0LiBJdCByZWFkc1xuICAgIC8vIHRoZSBtaWxlc3RvbmUgc3VyZmFjZSBhbmQgZGlzcGF0Y2hlcyByZXZpZXdlci9zZWN1cml0eS90ZXN0ZXIgc3ViYWdlbnRzXG4gICAgLy8gdG8gcmVwb3J0IGZpbmRpbmdzIHdpdGhvdXQgdG91Y2hpbmcgdXNlciBzb3VyY2UuIFdyaXRlIGlzb2xhdGlvbiB0b1xuICAgIC8vIC5nc2QvIGlzIHByZXNlcnZlZC5cbiAgICB0b29sczogVE9PTFNfUExBTk5JTkdfRElTUEFUQ0hfUkVWSUVXLFxuICAgIGFydGlmYWN0czoge1xuICAgICAgaW5saW5lOiBbXCJyb2FkbWFwXCIsIFwic2xpY2Utc3VtbWFyeVwiLCBcInNsaWNlLXVhdFwiLCBcInJlcXVpcmVtZW50c1wiLCBcImRlY2lzaW9uc1wiLCBcInRlbXBsYXRlc1wiXSxcbiAgICAgIGV4Y2VycHQ6IFtdLFxuICAgICAgb25EZW1hbmQ6IFtdLFxuICAgIH0sXG4gICAgbWF4U3lzdGVtUHJvbXB0Q2hhcnM6IENPTU1PTl9CVURHRVRfTEFSR0UsXG4gIH0sXG4gIFwiY29tcGxldGUtbWlsZXN0b25lXCI6IHtcbiAgICBza2lsbHM6IHsgbW9kZTogXCJhbGxcIiB9LFxuICAgIGtub3dsZWRnZTogXCJzY29wZWRcIixcbiAgICBtZW1vcnk6IFwicHJvbXB0LXJlbGV2YW50XCIsXG4gICAgY29kZWJhc2VNYXA6IGZhbHNlLFxuICAgIHByZWZlcmVuY2VzOiBcImFjdGl2ZS1vbmx5XCIsXG4gICAgY29udGV4dE1vZGU6IFwidmVyaWZpY2F0aW9uXCIsXG4gICAgLy8gTWlsZXN0b25lIGNsb3Nlb3V0IG11c3QgcnVuIHVucmVzdHJpY3RlZCBzaGVsbCB2ZXJpZmljYXRpb24gY29tbWFuZHNcbiAgICAvLyBhZ2FpbnN0IHRoZSBmaW5hbCBkaWZmIGJlZm9yZSByZWNvcmRpbmcgY29tcGxldGlvbi5cbiAgICB0b29sczogVE9PTFNfQUxMLFxuICAgIGFydGlmYWN0czoge1xuICAgICAgLy8gIzQ3ODAgbGFuZGVkIHNsaWNlLXN1bW1hcnkgYXMgZXhjZXJwdCBmb3IgdGhpcyB1bml0OyBwaGFzZSAyIG9mXG4gICAgICAvLyB0aGUgYXJjaGl0ZWN0dXJlIHdpbGwgcmVhZCB0aGlzIG1hbmlmZXN0IGFzIHRoZSBzb3VyY2Ugb2YgdHJ1dGhcbiAgICAgIC8vIGFuZCByZXRpcmUgdGhlIHNwZWNpYWwtY2FzZSB3aXJpbmcgaW4gYXV0by1wcm9tcHRzLnRzLlxuICAgICAgaW5saW5lOiBbXCJyb2FkbWFwXCIsIFwibWlsZXN0b25lLWNvbnRleHRcIiwgXCJyZXF1aXJlbWVudHNcIiwgXCJkZWNpc2lvbnNcIiwgXCJwcm9qZWN0XCIsIFwidGVtcGxhdGVzXCJdLFxuICAgICAgZXhjZXJwdDogW1wic2xpY2Utc3VtbWFyeVwiXSxcbiAgICAgIG9uRGVtYW5kOiBbXCJzbGljZS1zdW1tYXJ5XCJdLFxuICAgIH0sXG4gICAgbWF4U3lzdGVtUHJvbXB0Q2hhcnM6IENPTU1PTl9CVURHRVRfTUVESVVNLFxuICB9LFxuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTbGljZS1zY29wZWQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIFwicmVzZWFyY2gtc2xpY2VcIjoge1xuICAgIHNraWxsczogeyBtb2RlOiBcImFsbFwiIH0sXG4gICAga25vd2xlZGdlOiBcImZ1bGxcIixcbiAgICBtZW1vcnk6IFwicHJvbXB0LXJlbGV2YW50XCIsXG4gICAgY29kZWJhc2VNYXA6IHRydWUsXG4gICAgcHJlZmVyZW5jZXM6IFwiYWN0aXZlLW9ubHlcIixcbiAgICBjb250ZXh0TW9kZTogXCJyZXNlYXJjaFwiLFxuICAgIC8vIE11bHRpLXNsaWNlIHJlc2VhcmNoIGRpc3BhdGNoZXMgdXNlIHRoZSByZXNlYXJjaC1zbGljZSB1bml0IGNvbnRyYWN0IHRvXG4gICAgLy8gZmFuIG91dCBzY291dCBzdWJhZ2VudHMgdGhhdCB3cml0ZSAuZ3NkIHJlc2VhcmNoIGFydGlmYWN0cy5cbiAgICB0b29sczogVE9PTFNfUExBTk5JTkdfRElTUEFUQ0hfUkVDT04sXG4gICAgYXJ0aWZhY3RzOiB7XG4gICAgICBpbmxpbmU6IFtcInJvYWRtYXBcIiwgXCJtaWxlc3RvbmUtcmVzZWFyY2hcIiwgXCJkZXBlbmRlbmN5LXN1bW1hcmllc1wiLCBcInRlbXBsYXRlc1wiXSxcbiAgICAgIGV4Y2VycHQ6IFtdLFxuICAgICAgb25EZW1hbmQ6IFtdLFxuICAgIH0sXG4gICAgbWF4U3lzdGVtUHJvbXB0Q2hhcnM6IENPTU1PTl9CVURHRVRfTUVESVVNLFxuICB9LFxuICBcInBsYW4tc2xpY2VcIjoge1xuICAgIHNraWxsczogeyBtb2RlOiBcImFsbFwiIH0sXG4gICAga25vd2xlZGdlOiBcImZ1bGxcIixcbiAgICBtZW1vcnk6IFwicHJvbXB0LXJlbGV2YW50XCIsXG4gICAgY29kZWJhc2VNYXA6IHRydWUsXG4gICAgcHJlZmVyZW5jZXM6IFwiYWN0aXZlLW9ubHlcIixcbiAgICBjb250ZXh0TW9kZTogXCJwbGFubmluZ1wiLFxuICAgIC8vIHBsYW5uaW5nLWRpc3BhdGNoOiBhbGxvd3Mgc3ViYWdlbnQgZGlzcGF0Y2ggc28gdGhlIHBsYW5uZXIgY2FuIGZhbiBvdXRcbiAgICAvLyB0byBzY291dCBmb3IgY29kZWJhc2UgcmVjb24gYW5kIHRvIHBsYW5uZXIvZGVjb21wb3NlLXN0eWxlIHNwZWNpYWxpc3RzXG4gICAgLy8gZm9yIHN1Yi1kZWNvbXBvc2l0aW9uLiBXcml0ZS1pc29sYXRpb24gdG8gLmdzZC8gaXMgcHJlc2VydmVkLlxuICAgIHRvb2xzOiBUT09MU19QTEFOTklOR19ESVNQQVRDSF9SRUNPTixcbiAgICBhcnRpZmFjdHM6IHtcbiAgICAgIGlubGluZTogW1wicm9hZG1hcFwiLCBcInNsaWNlLXJlc2VhcmNoXCIsIFwiZGVwZW5kZW5jeS1zdW1tYXJpZXNcIiwgXCJyZXF1aXJlbWVudHNcIiwgXCJkZWNpc2lvbnNcIiwgXCJ0ZW1wbGF0ZXNcIl0sXG4gICAgICBleGNlcnB0OiBbXSxcbiAgICAgIG9uRGVtYW5kOiBbXSxcbiAgICB9LFxuICAgIG1heFN5c3RlbVByb21wdENoYXJzOiBDT01NT05fQlVER0VUX0xBUkdFLFxuICB9LFxuICBcInJlZmluZS1zbGljZVwiOiB7XG4gICAgc2tpbGxzOiB7IG1vZGU6IFwiYWxsXCIgfSxcbiAgICBrbm93bGVkZ2U6IFwic2NvcGVkXCIsXG4gICAgbWVtb3J5OiBcInByb21wdC1yZWxldmFudFwiLFxuICAgIGNvZGViYXNlTWFwOiB0cnVlLFxuICAgIHByZWZlcmVuY2VzOiBcImFjdGl2ZS1vbmx5XCIsXG4gICAgY29udGV4dE1vZGU6IFwicGxhbm5pbmdcIixcbiAgICAvLyBTZWUgcGxhbi1zbGljZSBcdTIwMTQgc2FtZSByYXRpb25hbGU6IGRpc3BhdGNoIHRvIHNjb3V0L3BsYW5uZXItc3R5bGVcbiAgICAvLyBzcGVjaWFsaXN0cyBkdXJpbmcgcmVmaW5lbWVudCBpcyBtYXRlcmlhbGx5IGJldHRlciB0aGFuIHJlLWRvaW5nIHJlY29uXG4gICAgLy8gaW5saW5lLlxuICAgIHRvb2xzOiBUT09MU19QTEFOTklOR19ESVNQQVRDSF9SRUNPTixcbiAgICBhcnRpZmFjdHM6IHtcbiAgICAgIGlubGluZTogW1wic2xpY2UtcGxhblwiLCBcInNsaWNlLXJlc2VhcmNoXCIsIFwiZGVwZW5kZW5jeS1zdW1tYXJpZXNcIiwgXCJ0ZW1wbGF0ZXNcIl0sXG4gICAgICBleGNlcnB0OiBbXSxcbiAgICAgIG9uRGVtYW5kOiBbXSxcbiAgICB9LFxuICAgIG1heFN5c3RlbVByb21wdENoYXJzOiBDT01NT05fQlVER0VUX01FRElVTSxcbiAgfSxcbiAgXCJyZXBsYW4tc2xpY2VcIjoge1xuICAgIHNraWxsczogeyBtb2RlOiBcImFsbFwiIH0sXG4gICAga25vd2xlZGdlOiBcInNjb3BlZFwiLFxuICAgIG1lbW9yeTogXCJwcm9tcHQtcmVsZXZhbnRcIixcbiAgICBjb2RlYmFzZU1hcDogdHJ1ZSxcbiAgICBwcmVmZXJlbmNlczogXCJhY3RpdmUtb25seVwiLFxuICAgIGNvbnRleHRNb2RlOiBcInBsYW5uaW5nXCIsXG4gICAgdG9vbHM6IFRPT0xTX1BMQU5OSU5HLFxuICAgIGFydGlmYWN0czoge1xuICAgICAgaW5saW5lOiBbXCJzbGljZS1wbGFuXCIsIFwic2xpY2UtcmVzZWFyY2hcIiwgXCJkZXBlbmRlbmN5LXN1bW1hcmllc1wiLCBcInByaW9yLXRhc2stc3VtbWFyaWVzXCIsIFwidGVtcGxhdGVzXCJdLFxuICAgICAgZXhjZXJwdDogW10sXG4gICAgICBvbkRlbWFuZDogW10sXG4gICAgfSxcbiAgICBtYXhTeXN0ZW1Qcm9tcHRDaGFyczogQ09NTU9OX0JVREdFVF9NRURJVU0sXG4gIH0sXG4gIFwiY29tcGxldGUtc2xpY2VcIjoge1xuICAgIHNraWxsczogeyBtb2RlOiBcImFsbFwiIH0sXG4gICAga25vd2xlZGdlOiBcInNjb3BlZFwiLFxuICAgIG1lbW9yeTogXCJwcm9tcHQtcmVsZXZhbnRcIixcbiAgICBjb2RlYmFzZU1hcDogZmFsc2UsXG4gICAgcHJlZmVyZW5jZXM6IFwiYWN0aXZlLW9ubHlcIixcbiAgICBjb250ZXh0TW9kZTogXCJ2ZXJpZmljYXRpb25cIixcbiAgICAvLyBTZWUgY29tcGxldGUtbWlsZXN0b25lIFx1MjAxNCBzYW1lIHJhdGlvbmFsZTogZGlzcGF0Y2ggdG8gcmV2aWV3ZXIgLyBzZWN1cml0eSAvXG4gICAgLy8gdGVzdGVyIHN1YmFnZW50cyB0byBmYW4gb3V0IHJldmlldyB3b3JrIHdpdGhvdXQgYmxvYXRpbmcgdGhpcyB1bml0J3NcbiAgICAvLyBjb250ZXh0LlxuICAgIHRvb2xzOiBUT09MU19QTEFOTklOR19ESVNQQVRDSF9SRVZJRVcsXG4gICAgYXJ0aWZhY3RzOiB7XG4gICAgICAvLyBQaGFzZSAzIG1pZ3JhdGlvbiAoIzQ3ODIpOiBtYXRjaGVzIHRvZGF5J3MgYWN0dWFsXG4gICAgICAvLyBidWlsZENvbXBsZXRlU2xpY2VQcm9tcHQgaW5saW5pbmcgb3JkZXIuIE92ZXJyaWRlcyBwcmVwZW5kICtcbiAgICAgIC8vIGtub3dsZWRnZSBzcGxpY2Ugc3RheSBpbiB0aGUgYnVpbGRlciBpbXBlcmF0aXZlbHkgKHNlZSBSRkNcbiAgICAgIC8vICM0OTI0IFx1MjAxNCBjb21wdXRlZC9wcmVwZW5kIGJsb2NrcyBhcmUgcGhhc2UtNCBjb21wb3NlciB3b3JrKS5cbiAgICAgIGlubGluZTogW1wicm9hZG1hcFwiLCBcInNsaWNlLWNvbnRleHRcIiwgXCJzbGljZS1wbGFuXCIsIFwicmVxdWlyZW1lbnRzXCIsIFwicHJpb3ItdGFzay1zdW1tYXJpZXNcIiwgXCJ0ZW1wbGF0ZXNcIl0sXG4gICAgICBleGNlcnB0OiBbXSxcbiAgICAgIG9uRGVtYW5kOiBbXSxcbiAgICB9LFxuICAgIG1heFN5c3RlbVByb21wdENoYXJzOiBDT01NT05fQlVER0VUX0xBUkdFLFxuICB9LFxuICBcInJlYXNzZXNzLXJvYWRtYXBcIjoge1xuICAgIHNraWxsczogeyBtb2RlOiBcImFsbFwiIH0sXG4gICAga25vd2xlZGdlOiBcInNjb3BlZFwiLFxuICAgIG1lbW9yeTogXCJjcml0aWNhbC1vbmx5XCIsXG4gICAgY29kZWJhc2VNYXA6IGZhbHNlLFxuICAgIHByZWZlcmVuY2VzOiBcIm5vbmVcIixcbiAgICBjb250ZXh0TW9kZTogXCJwbGFubmluZ1wiLFxuICAgIHRvb2xzOiBUT09MU19QTEFOTklORyxcbiAgICBhcnRpZmFjdHM6IHtcbiAgICAgIC8vIFBoYXNlIDIgcGlsb3QgKCM0NzgyKTogbWFuaWZlc3Qgbm93IG1hdGNoZXMgdG9kYXkncyBhY3R1YWxcbiAgICAgIC8vIGJ1aWxkUmVhc3Nlc3NSb2FkbWFwUHJvbXB0IGJlaGF2aW9yIGZvciBlcXVpdmFsZW5jZS4gUGhhc2UgM1xuICAgICAgLy8gd2lsbCB0aWdodGVuIHRoaXMgbGlzdCBvbmNlIHRoZSBjb21wb3NlciByZXBvcnRzIHJlYWwgdGVsZW1ldHJ5LlxuICAgICAgaW5saW5lOiBbXCJyb2FkbWFwXCIsIFwic2xpY2UtY29udGV4dFwiLCBcInNsaWNlLXN1bW1hcnlcIiwgXCJwcm9qZWN0XCIsIFwicmVxdWlyZW1lbnRzXCIsIFwiZGVjaXNpb25zXCJdLFxuICAgICAgZXhjZXJwdDogW10sXG4gICAgICBvbkRlbWFuZDogW10sXG4gICAgfSxcbiAgICBtYXhTeXN0ZW1Qcm9tcHRDaGFyczogQ09NTU9OX0JVREdFVF9NRURJVU0sXG4gIH0sXG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRhc2stc2NvcGVkIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBcImV4ZWN1dGUtdGFza1wiOiB7XG4gICAgc2tpbGxzOiB7IG1vZGU6IFwiYWxsXCIgfSxcbiAgICBrbm93bGVkZ2U6IFwic2NvcGVkXCIsXG4gICAgbWVtb3J5OiBcInByb21wdC1yZWxldmFudFwiLFxuICAgIGNvZGViYXNlTWFwOiB0cnVlLFxuICAgIHByZWZlcmVuY2VzOiBcImFjdGl2ZS1vbmx5XCIsXG4gICAgY29udGV4dE1vZGU6IFwiZXhlY3V0aW9uXCIsXG4gICAgdG9vbHM6IFRPT0xTX0FMTCxcbiAgICBhcnRpZmFjdHM6IHtcbiAgICAgIGlubGluZTogW1widGFzay1wbGFuXCIsIFwic2xpY2UtcGxhblwiLCBcInByaW9yLXRhc2stc3VtbWFyaWVzXCIsIFwidGVtcGxhdGVzXCJdLFxuICAgICAgZXhjZXJwdDogW10sXG4gICAgICBvbkRlbWFuZDogW1wic2xpY2UtcmVzZWFyY2hcIl0sXG4gICAgfSxcbiAgICBtYXhTeXN0ZW1Qcm9tcHRDaGFyczogQ09NTU9OX0JVREdFVF9MQVJHRSxcbiAgfSxcbiAgXCJyZWFjdGl2ZS1leGVjdXRlXCI6IHtcbiAgICBza2lsbHM6IHsgbW9kZTogXCJhbGxcIiB9LFxuICAgIGtub3dsZWRnZTogXCJzY29wZWRcIixcbiAgICBtZW1vcnk6IFwicHJvbXB0LXJlbGV2YW50XCIsXG4gICAgY29kZWJhc2VNYXA6IHRydWUsXG4gICAgcHJlZmVyZW5jZXM6IFwiYWN0aXZlLW9ubHlcIixcbiAgICBjb250ZXh0TW9kZTogXCJleGVjdXRpb25cIixcbiAgICB0b29sczogVE9PTFNfQUxMLFxuICAgIGFydGlmYWN0czoge1xuICAgICAgaW5saW5lOiBbXCJzbGljZS1wbGFuXCIsIFwicHJpb3ItdGFzay1zdW1tYXJpZXNcIiwgXCJ0ZW1wbGF0ZXNcIl0sXG4gICAgICBleGNlcnB0OiBbXSxcbiAgICAgIG9uRGVtYW5kOiBbXCJzbGljZS1yZXNlYXJjaFwiXSxcbiAgICB9LFxuICAgIG1heFN5c3RlbVByb21wdENoYXJzOiBDT01NT05fQlVER0VUX0xBUkdFLFxuICB9LFxuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBBbmNpbGxhcnkgdW5pdHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIFwicnVuLXVhdFwiOiB7XG4gICAgc2tpbGxzOiB7IG1vZGU6IFwiYWxsXCIgfSxcbiAgICBrbm93bGVkZ2U6IFwiY3JpdGljYWwtb25seVwiLFxuICAgIG1lbW9yeTogXCJjcml0aWNhbC1vbmx5XCIsXG4gICAgY29kZWJhc2VNYXA6IGZhbHNlLFxuICAgIHByZWZlcmVuY2VzOiBcImFjdGl2ZS1vbmx5XCIsXG4gICAgY29udGV4dE1vZGU6IFwidmVyaWZpY2F0aW9uXCIsXG4gICAgdG9vbHM6IFRPT0xTX1ZFUklGSUNBVElPTixcbiAgICBhcnRpZmFjdHM6IHtcbiAgICAgIC8vIFBoYXNlIDMgbWlncmF0aW9uICgjNDc4Mik6IG1hbmlmZXN0IG1hdGNoZXMgdG9kYXkncyBhY3R1YWxcbiAgICAgIC8vIGJ1aWxkUnVuVWF0UHJvbXB0IGlubGluaW5nLiBQcmlvciBwaGFzZS0xIGVudHJ5IGxpc3RlZFxuICAgICAgLy8gYHNsaWNlLXBsYW5gIGFzcGlyYXRpb25hbGx5IFx1MjAxNCB0aGUgcmVhbCBidWlsZGVyIGlubGluZXMgdGhlIFVBVFxuICAgICAgLy8gZmlsZSwgdGhlIHNsaWNlIFNVTU1BUlkgKG9wdGlvbmFsKSwgYW5kIHRoZSBwcm9qZWN0IHJvdy5cbiAgICAgIGlubGluZTogW1wic2xpY2UtdWF0XCIsIFwic2xpY2Utc3VtbWFyeVwiLCBcInByb2plY3RcIl0sXG4gICAgICBleGNlcnB0OiBbXSxcbiAgICAgIG9uRGVtYW5kOiBbXSxcbiAgICB9LFxuICAgIG1heFN5c3RlbVByb21wdENoYXJzOiBDT01NT05fQlVER0VUX1NNQUxMLFxuICB9LFxuICBcImdhdGUtZXZhbHVhdGVcIjoge1xuICAgIHNraWxsczogeyBtb2RlOiBcImFsbFwiIH0sXG4gICAga25vd2xlZGdlOiBcImNyaXRpY2FsLW9ubHlcIixcbiAgICBtZW1vcnk6IFwiY3JpdGljYWwtb25seVwiLFxuICAgIGNvZGViYXNlTWFwOiBmYWxzZSxcbiAgICBwcmVmZXJlbmNlczogXCJhY3RpdmUtb25seVwiLFxuICAgIGNvbnRleHRNb2RlOiBcInZlcmlmaWNhdGlvblwiLFxuICAgIC8vIEdhdGUgZXZhbHVhdGlvbiBmYW5zIG91dCB0ZXN0ZXItc3R5bGUgc3ViYWdlbnRzLCB3aGljaCByZWFkIHRoZSBzbGljZVxuICAgIC8vIHBsYW4gYW5kIHJlcG9ydCB2aWEgdGhlIERCLWJhY2tlZCBnYXRlLXJlc3VsdCB0b29sLlxuICAgIHRvb2xzOiBUT09MU19QTEFOTklOR19ESVNQQVRDSF9SRVZJRVcsXG4gICAgYXJ0aWZhY3RzOiB7XG4gICAgICBpbmxpbmU6IFtcInNsaWNlLXBsYW5cIiwgXCJwcmlvci10YXNrLXN1bW1hcmllc1wiXSxcbiAgICAgIGV4Y2VycHQ6IFtdLFxuICAgICAgb25EZW1hbmQ6IFtdLFxuICAgIH0sXG4gICAgbWF4U3lzdGVtUHJvbXB0Q2hhcnM6IENPTU1PTl9CVURHRVRfU01BTEwsXG4gIH0sXG4gIFwicmV3cml0ZS1kb2NzXCI6IHtcbiAgICBza2lsbHM6IHsgbW9kZTogXCJhbGxcIiB9LFxuICAgIGtub3dsZWRnZTogXCJzY29wZWRcIixcbiAgICBtZW1vcnk6IFwicHJvbXB0LXJlbGV2YW50XCIsXG4gICAgY29kZWJhc2VNYXA6IHRydWUsXG4gICAgcHJlZmVyZW5jZXM6IFwiYWN0aXZlLW9ubHlcIixcbiAgICBjb250ZXh0TW9kZTogXCJkb2NzXCIsXG4gICAgdG9vbHM6IFRPT0xTX0RPQ1MsXG4gICAgYXJ0aWZhY3RzOiB7XG4gICAgICBpbmxpbmU6IFtcInByb2plY3RcIiwgXCJyZXF1aXJlbWVudHNcIiwgXCJkZWNpc2lvbnNcIiwgXCJ0ZW1wbGF0ZXNcIl0sXG4gICAgICBleGNlcnB0OiBbXSxcbiAgICAgIG9uRGVtYW5kOiBbXSxcbiAgICB9LFxuICAgIG1heFN5c3RlbVByb21wdENoYXJzOiBDT01NT05fQlVER0VUX01FRElVTSxcbiAgfSxcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgRGVlcCBwbGFubmluZyBtb2RlIChwcm9qZWN0LWxldmVsKSB1bml0cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgLy8gd29ya2Zsb3ctcHJlZmVyZW5jZXM6IGRlZmF1bHQtd3JpdGluZyBzdGFnZSB0aGF0IHJlY29yZHNcbiAgLy8gY29tbWl0X3BvbGljeSAvIGJyYW5jaF9tb2RlbCBpbiBQUkVGRVJFTkNFUy5tZCwgZGVmYXVsdHNcbiAgLy8gdWF0X2Rpc3BhdGNoL2V4ZWN1dG9yX2NsYXNzLCBhbmQgcmVjb3JkcyB0aGUgcmVzZWFyY2ggZGVjaXNpb24uIE5vIHByb2plY3QgYXJ0aWZhY3RzIG5lZWRlZC5cbiAgXCJ3b3JrZmxvdy1wcmVmZXJlbmNlc1wiOiB7XG4gICAgc2tpbGxzOiB7IG1vZGU6IFwibm9uZVwiIH0sXG4gICAga25vd2xlZGdlOiBcIm5vbmVcIixcbiAgICBtZW1vcnk6IFwibm9uZVwiLFxuICAgIGNvZGViYXNlTWFwOiBmYWxzZSxcbiAgICBwcmVmZXJlbmNlczogXCJub25lXCIsXG4gICAgY29udGV4dE1vZGU6IFwibm9uZVwiLFxuICAgIHRvb2xzOiBUT09MU19QTEFOTklORyxcbiAgICBhcnRpZmFjdHM6IHtcbiAgICAgIGlubGluZTogW10sXG4gICAgICBleGNlcnB0OiBbXSxcbiAgICAgIG9uRGVtYW5kOiBbXSxcbiAgICB9LFxuICAgIG1heFN5c3RlbVByb21wdENoYXJzOiBDT01NT05fQlVER0VUX1NNQUxMLFxuICB9LFxuICAvLyBkaXNjdXNzLXByb2plY3Q6IFBST0pFQ1QubWQgaW50ZXJ2aWV3IChkZWVwIG1vZGUgb25seSkuIFByb2plY3Qtc2NvcGVkXG4gIC8vIGRpc2N1c3Npb24gcnVucyBiZWZvcmUgYW55IG1pbGVzdG9uZSBleGlzdHMsIHNvIG1pbGVzdG9uZSBhcnRpZmFjdHMgYXJlXG4gIC8vIG5vdCBsb2FkZWQuIEtlZXBzIHRlbXBsYXRlcyBhdmFpbGFibGUgZm9yIFBST0pFQ1QubWQgc2NhZmZvbGRpbmcuXG4gIFwiZGlzY3Vzcy1wcm9qZWN0XCI6IHtcbiAgICBza2lsbHM6IHsgbW9kZTogXCJhbGxcIiB9LFxuICAgIGtub3dsZWRnZTogXCJzY29wZWRcIixcbiAgICBtZW1vcnk6IFwicHJvbXB0LXJlbGV2YW50XCIsXG4gICAgY29kZWJhc2VNYXA6IHRydWUsXG4gICAgcHJlZmVyZW5jZXM6IFwiYWN0aXZlLW9ubHlcIixcbiAgICBjb250ZXh0TW9kZTogXCJpbnRlcnZpZXdcIixcbiAgICB0b29sczogVE9PTFNfUExBTk5JTkcsXG4gICAgYXJ0aWZhY3RzOiB7XG4gICAgICBpbmxpbmU6IFtcInRlbXBsYXRlc1wiXSxcbiAgICAgIGV4Y2VycHQ6IFtdLFxuICAgICAgb25EZW1hbmQ6IFtdLFxuICAgIH0sXG4gICAgbWF4U3lzdGVtUHJvbXB0Q2hhcnM6IENPTU1PTl9CVURHRVRfTUVESVVNLFxuICB9LFxuICAvLyBkaXNjdXNzLXJlcXVpcmVtZW50czogUkVRVUlSRU1FTlRTLm1kIGludGVydmlldy4gUFJPSkVDVC5tZCBpcyB0aGVcbiAgLy8gcHJpbWFyeSBjb250ZXh0IGlucHV0OyB0ZW1wbGF0ZXMgY2FycnkgdGhlIHJlcXVpcmVtZW50cyBmb3JtYXQuXG4gIFwiZGlzY3Vzcy1yZXF1aXJlbWVudHNcIjoge1xuICAgIHNraWxsczogeyBtb2RlOiBcImFsbFwiIH0sXG4gICAga25vd2xlZGdlOiBcInNjb3BlZFwiLFxuICAgIG1lbW9yeTogXCJwcm9tcHQtcmVsZXZhbnRcIixcbiAgICBjb2RlYmFzZU1hcDogdHJ1ZSxcbiAgICBwcmVmZXJlbmNlczogXCJhY3RpdmUtb25seVwiLFxuICAgIGNvbnRleHRNb2RlOiBcImludGVydmlld1wiLFxuICAgIHRvb2xzOiBUT09MU19QTEFOTklORyxcbiAgICBhcnRpZmFjdHM6IHtcbiAgICAgIGlubGluZTogW1wicHJvamVjdFwiLCBcInRlbXBsYXRlc1wiXSxcbiAgICAgIGV4Y2VycHQ6IFtdLFxuICAgICAgb25EZW1hbmQ6IFtdLFxuICAgIH0sXG4gICAgbWF4U3lzdGVtUHJvbXB0Q2hhcnM6IENPTU1PTl9CVURHRVRfTUVESVVNLFxuICB9LFxuICAvLyByZXNlYXJjaC1kZWNpc2lvbjogbGlnaHR3ZWlnaHQgb25lLXF1ZXN0aW9uIHllcy9ubyB1bml0LiBXcml0ZXMgYVxuICAvLyBtYXJrZXIgSlNPTjsgbm8gcHJvamVjdCBhcnRpZmFjdHMgbmVlZGVkLlxuICBcInJlc2VhcmNoLWRlY2lzaW9uXCI6IHtcbiAgICBza2lsbHM6IHsgbW9kZTogXCJub25lXCIgfSxcbiAgICBrbm93bGVkZ2U6IFwibm9uZVwiLFxuICAgIG1lbW9yeTogXCJub25lXCIsXG4gICAgY29kZWJhc2VNYXA6IGZhbHNlLFxuICAgIHByZWZlcmVuY2VzOiBcIm5vbmVcIixcbiAgICBjb250ZXh0TW9kZTogXCJub25lXCIsXG4gICAgdG9vbHM6IFRPT0xTX1BMQU5OSU5HLFxuICAgIGFydGlmYWN0czoge1xuICAgICAgaW5saW5lOiBbXSxcbiAgICAgIGV4Y2VycHQ6IFtdLFxuICAgICAgb25EZW1hbmQ6IFtdLFxuICAgIH0sXG4gICAgbWF4U3lzdGVtUHJvbXB0Q2hhcnM6IENPTU1PTl9CVURHRVRfU01BTEwsXG4gIH0sXG4gIC8vIHJlc2VhcmNoLXByb2plY3Q6IG9yY2hlc3RyYXRvciB0aGF0IGZhbnMgb3V0IDQgcGFyYWxsZWwgc2NvdXQgc3ViYWdlbnRzXG4gIC8vIGZvciBwcm9qZWN0IHJlc2VhcmNoIChzdGFjaywgZmVhdHVyZXMsIGFyY2hpdGVjdHVyZSwgcGl0ZmFsbHMpLiBOZWVkcyB0aGVcbiAgLy8gcGxhbm5pbmctZGlzcGF0Y2ggcG9saWN5IHRvIGRpc3BhdGNoIHRoZW0uIFBST0pFQ1QubWQgKyBSRVFVSVJFTUVOVFMubWRcbiAgLy8gZ2l2ZSB0aGUgb3JjaGVzdHJhdG9yIHRoZSBmcmFtaW5nIGNvbnRleHQuXG4gIFwicmVzZWFyY2gtcHJvamVjdFwiOiB7XG4gICAgc2tpbGxzOiB7IG1vZGU6IFwiYWxsXCIgfSxcbiAgICBrbm93bGVkZ2U6IFwic2NvcGVkXCIsXG4gICAgbWVtb3J5OiBcInByb21wdC1yZWxldmFudFwiLFxuICAgIGNvZGViYXNlTWFwOiB0cnVlLFxuICAgIHByZWZlcmVuY2VzOiBcImFjdGl2ZS1vbmx5XCIsXG4gICAgY29udGV4dE1vZGU6IFwicmVzZWFyY2hcIixcbiAgICB0b29sczogeyBtb2RlOiBcInBsYW5uaW5nLWRpc3BhdGNoXCIsIGFsbG93ZWRTdWJhZ2VudHM6IFtcInNjb3V0XCJdIH0sXG4gICAgYXJ0aWZhY3RzOiB7XG4gICAgICBpbmxpbmU6IFtcInByb2plY3RcIiwgXCJyZXF1aXJlbWVudHNcIiwgXCJ0ZW1wbGF0ZXNcIl0sXG4gICAgICBleGNlcnB0OiBbXSxcbiAgICAgIG9uRGVtYW5kOiBbXSxcbiAgICB9LFxuICAgIG1heFN5c3RlbVByb21wdENoYXJzOiBDT01NT05fQlVER0VUX01FRElVTSxcbiAgfSxcbn07XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBMb29rdXAgaGVscGVyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFJldHVybiB0aGUgbWFuaWZlc3QgZm9yIGEgdW5pdCB0eXBlLCBvciBudWxsIHdoZW4gdGhlIHR5cGUgaXMgdW5rbm93bi5cbiAqXG4gKiBDYWxsZXJzIE1VU1QgdHJlYXQgbnVsbCBhcyBcImZhbGwgdGhyb3VnaCB0byB0b2RheSdzIGRlZmF1bHQgYmVoYXZpb3JcIlxuICogcmF0aGVyIHRoYW4gZXJyb3JpbmcgXHUyMDE0IHVua25vd24gdW5pdCB0eXBlcyBtYXkgYmUgZXhwZXJpbWVudGFsIGFuZFxuICogc2hvdWxkIG5vdCBjcmFzaCB0aGUgY29tcG9zZXIuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlTWFuaWZlc3QodW5pdFR5cGU6IHN0cmluZyk6IFVuaXRDb250ZXh0TWFuaWZlc3QgfCBudWxsIHtcbiAgcmV0dXJuIChVTklUX01BTklGRVNUUyBhcyBSZWNvcmQ8c3RyaW5nLCBVbml0Q29udGV4dE1hbmlmZXN0PilbdW5pdFR5cGVdID8/IG51bGw7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3ViYWdlbnRQZXJtaXNzaW9uQ29udHJhY3Qge1xuICByZWFkb25seSBhbGxvd2VkOiBib29sZWFuO1xuICByZWFkb25seSBhbGxvd2VkU3ViYWdlbnRzOiByZWFkb25seSBzdHJpbmdbXTtcbiAgcmVhZG9ubHkgdG9vbHNNb2RlOiBUb29sc1BvbGljeVtcIm1vZGVcIl0gfCBcInVua25vd25cIjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNvbXBpbGVTdWJhZ2VudFBlcm1pc3Npb25Db250cmFjdChcbiAgcG9saWN5OiBUb29sc1BvbGljeSB8IG51bGwgfCB1bmRlZmluZWQsXG4pOiBTdWJhZ2VudFBlcm1pc3Npb25Db250cmFjdCB7XG4gIGlmICghcG9saWN5KSB7XG4gICAgcmV0dXJuIHsgYWxsb3dlZDogZmFsc2UsIGFsbG93ZWRTdWJhZ2VudHM6IFtdLCB0b29sc01vZGU6IFwidW5rbm93blwiIH07XG4gIH1cbiAgaWYgKHBvbGljeS5tb2RlID09PSBcImFsbFwiKSB7XG4gICAgcmV0dXJuIHsgYWxsb3dlZDogdHJ1ZSwgYWxsb3dlZFN1YmFnZW50czogW1wiKlwiXSwgdG9vbHNNb2RlOiBwb2xpY3kubW9kZSB9O1xuICB9XG4gIGlmIChwb2xpY3kubW9kZSA9PT0gXCJwbGFubmluZy1kaXNwYXRjaFwiKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGFsbG93ZWQ6IHRydWUsXG4gICAgICBhbGxvd2VkU3ViYWdlbnRzOiBbLi4ucG9saWN5LmFsbG93ZWRTdWJhZ2VudHNdLFxuICAgICAgdG9vbHNNb2RlOiBwb2xpY3kubW9kZSxcbiAgICB9O1xuICB9XG4gIHJldHVybiB7IGFsbG93ZWQ6IGZhbHNlLCBhbGxvd2VkU3ViYWdlbnRzOiBbXSwgdG9vbHNNb2RlOiBwb2xpY3kubW9kZSB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZVN1YmFnZW50UGVybWlzc2lvbkNvbnRyYWN0KHVuaXRUeXBlOiBzdHJpbmcpOiBTdWJhZ2VudFBlcm1pc3Npb25Db250cmFjdCB7XG4gIHJldHVybiBjb21waWxlU3ViYWdlbnRQZXJtaXNzaW9uQ29udHJhY3QocmVzb2x2ZU1hbmlmZXN0KHVuaXRUeXBlKT8udG9vbHMpO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBcUNPLE1BQU0sZ0JBQWdCO0FBQUE7QUFBQSxFQUUzQjtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxF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
