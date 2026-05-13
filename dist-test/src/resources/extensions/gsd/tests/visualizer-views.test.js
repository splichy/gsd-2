import {
  renderProgressView,
  renderDepsView,
  renderMetricsView,
  renderTimelineView,
  renderAgentView,
  renderChangelogView,
  renderExportView,
  renderKnowledgeView,
  renderCapturesView,
  renderHealthView
} from "../visualizer-views.js";
import assert from "node:assert/strict";
const mockTheme = {
  fg: (_color, text) => text,
  bold: (text) => text
};
function makeVisualizerData(overrides = {}) {
  return {
    milestones: [],
    phase: "executing",
    totals: null,
    byPhase: [],
    bySlice: [],
    byModel: [],
    byTier: [],
    tierSavingsLine: "",
    units: [],
    criticalPath: {
      milestonePath: [],
      slicePath: [],
      milestoneSlack: /* @__PURE__ */ new Map(),
      sliceSlack: /* @__PURE__ */ new Map()
    },
    remainingSliceCount: 0,
    agentActivity: null,
    changelog: { entries: [] },
    sliceVerifications: [],
    knowledge: { rules: [], patterns: [], lessons: [], exists: false },
    captures: { entries: [], pendingCount: 0, totalCount: 0 },
    health: {
      budgetCeiling: void 0,
      tokenProfile: "standard",
      truncationRate: 0,
      continueHereRate: 0,
      tierBreakdown: [],
      tierSavingsLine: "",
      toolCalls: 0,
      assistantMessages: 0,
      userMessages: 0,
      providers: [],
      skillSummary: { total: 0, warningCount: 0, criticalCount: 0, topIssue: null },
      environmentIssues: []
    },
    discussion: [],
    stats: {
      missingCount: 0,
      missingSlices: [],
      updatedCount: 0,
      updatedSlices: [],
      recentEntries: []
    },
    ...overrides
  };
}
console.log("\n=== renderProgressView ===");
{
  const data = makeVisualizerData({
    milestones: [
      {
        id: "M001",
        title: "First Milestone",
        status: "active",
        dependsOn: [],
        slices: [
          {
            id: "S01",
            title: "Core Types",
            done: true,
            active: false,
            risk: "low",
            depends: [],
            tasks: []
          },
          {
            id: "S02",
            title: "State Engine",
            done: false,
            active: true,
            risk: "high",
            depends: ["S01"],
            tasks: [
              { id: "T01", title: "Dispatch Loop", done: false, active: true, estimate: "30m" },
              { id: "T02", title: "Session Mgmt", done: true, active: false }
            ]
          },
          {
            id: "S03",
            title: "Dashboard",
            done: false,
            active: false,
            risk: "medium",
            depends: ["S02"],
            tasks: []
          }
        ]
      },
      {
        id: "M002",
        title: "Plugin Arch",
        status: "pending",
        dependsOn: ["M001"],
        slices: []
      }
    ],
    sliceVerifications: [
      {
        milestoneId: "M001",
        sliceId: "S01",
        verificationResult: "passed",
        blockerDiscovered: false,
        keyDecisions: [],
        patternsEstablished: [],
        provides: ["core-types"],
        requires: []
      }
    ],
    stats: {
      missingCount: 2,
      missingSlices: [
        { milestoneId: "M001", sliceId: "S02", title: "State Engine" },
        { milestoneId: "M001", sliceId: "S03", title: "Dashboard" }
      ],
      updatedCount: 1,
      updatedSlices: [
        { milestoneId: "M001", sliceId: "S01", title: "Core Types", completedAt: "2026-03-15T14:30:00Z" }
      ],
      recentEntries: [
        {
          milestoneId: "M001",
          sliceId: "S01",
          title: "Core Types Infrastructure",
          oneLiner: "Core structures assembled",
          filesModified: [],
          completedAt: "2026-03-15T14:30:00Z"
        }
      ]
    }
  });
  const lines = renderProgressView(data, mockTheme, 80);
  assert.ok(lines.length > 0, "progress view produces output");
  assert.ok(lines.some((l) => l.includes("M001")), "shows milestone M001");
  assert.ok(lines.some((l) => l.includes("S01")), "shows slice S01");
  assert.ok(lines.some((l) => l.includes("T01")), "shows task T01 for active slice");
  assert.ok(lines.some((l) => l.includes("M002")), "shows milestone M002");
  assert.ok(lines.some((l) => l.includes("depends on M001")), "shows dependency note");
  assert.ok(lines.some((l) => l.includes("30m")), "shows task estimate");
  assert.ok(lines.some((l) => l.includes("Feature Snapshot")), "shows stats header");
  assert.ok(lines.some((l) => l.includes("Missing slices")), "shows missing slices count");
  assert.ok(lines.some((l) => l.includes("State Engine")), "shows missing slice preview");
  assert.ok(lines.some((l) => l.includes("Updated (last 7 days)")), "shows updated count");
  assert.ok(lines.some((l) => l.includes("Recent completions")), "shows recent completions section");
  assert.ok(lines.some((l) => l.includes("Core structures assembled")), "shows recent one-liner entry");
}
{
  const data = makeVisualizerData({
    discussion: [
      {
        milestoneId: "M001",
        title: "First Milestone",
        state: "discussed",
        hasContext: true,
        hasDraft: false,
        lastUpdated: "2026-03-15T14:30:00Z"
      },
      {
        milestoneId: "M002",
        title: "Plugin Arch",
        state: "draft",
        hasContext: false,
        hasDraft: true,
        lastUpdated: "2026-03-16T09:00:00Z"
      },
      {
        milestoneId: "M003",
        title: "Next Batch",
        state: "undiscussed",
        hasContext: false,
        hasDraft: false,
        lastUpdated: null
      }
    ]
  });
  const lines = renderProgressView(data, mockTheme, 80);
  assert.ok(lines.some((l) => l.includes("Discussion Status")), "shows discussion section");
  assert.ok(lines.some((l) => l.includes("Discussed: 1")), "counts discussed milestones");
  assert.ok(lines.some((l) => l.includes("Draft")), "shows draft badge");
  assert.ok(lines.some((l) => l.includes("Pending")), "shows pending badge");
}
{
  const data = makeVisualizerData({
    milestones: [
      {
        id: "M001",
        title: "Test",
        status: "active",
        dependsOn: [],
        slices: [
          { id: "S01", title: "Done Slice", done: true, active: false, risk: "low", depends: [], tasks: [] }
        ]
      }
    ],
    sliceVerifications: [
      {
        milestoneId: "M001",
        sliceId: "S01",
        verificationResult: "passed",
        blockerDiscovered: true,
        keyDecisions: [],
        patternsEstablished: [],
        provides: [],
        requires: []
      }
    ]
  });
  const lines = renderProgressView(data, mockTheme, 80);
  assert.ok(lines.some((l) => l.includes("S01")), "shows slice with verification");
}
{
  const data = makeVisualizerData({ milestones: [] });
  const lines = renderProgressView(data, mockTheme, 80);
  assert.ok(lines.some((l) => l.includes("Feature Snapshot")), "shows stats snapshot even when no milestones");
  assert.ok(lines.some((l) => l.includes("Missing slices")), "reports missing slices count");
}
console.log("\n=== Risk Heatmap ===");
{
  const data = makeVisualizerData({
    milestones: [
      {
        id: "M001",
        title: "First",
        status: "active",
        dependsOn: [],
        slices: [
          { id: "S01", title: "A", done: true, active: false, risk: "low", depends: [], tasks: [] },
          { id: "S02", title: "B", done: false, active: true, risk: "high", depends: [], tasks: [] },
          { id: "S03", title: "C", done: false, active: false, risk: "medium", depends: [], tasks: [] },
          { id: "S04", title: "D", done: false, active: false, risk: "high", depends: [], tasks: [] }
        ]
      }
    ]
  });
  const lines = renderProgressView(data, mockTheme, 80);
  assert.ok(lines.some((l) => l.includes("Risk Heatmap")), "heatmap header present");
  assert.ok(lines.some((l) => l.includes("1 low, 1 med, 2 high")), "risk summary counts");
  assert.ok(lines.some((l) => l.includes("1 high-risk not started")), "high-risk not started warning");
}
console.log("\n=== Search/Filter ===");
{
  const data = makeVisualizerData({
    milestones: [
      {
        id: "M001",
        title: "Auth",
        status: "active",
        dependsOn: [],
        slices: [
          { id: "S01", title: "JWT", done: false, active: false, risk: "low", depends: [], tasks: [] },
          { id: "S02", title: "OAuth", done: false, active: false, risk: "high", depends: [], tasks: [] }
        ]
      },
      {
        id: "M002",
        title: "Dashboard",
        status: "pending",
        dependsOn: ["M001"],
        slices: []
      }
    ]
  });
  const filtered = renderProgressView(data, mockTheme, 80, { text: "auth", field: "all" });
  assert.ok(filtered.some((l) => l.includes("M001")), "filter shows matching milestone");
  assert.ok(filtered.some((l) => l.includes("Filter (all): auth")), "filter indicator present");
  const riskFiltered = renderProgressView(data, mockTheme, 80, { text: "high", field: "risk" });
  assert.ok(riskFiltered.some((l) => l.includes("M001")), "risk filter shows milestone with high-risk slice");
}
console.log("\n=== renderDepsView ===");
{
  const data = makeVisualizerData({
    milestones: [
      {
        id: "M001",
        title: "First",
        status: "active",
        dependsOn: [],
        slices: [
          { id: "S01", title: "A", done: false, active: true, risk: "low", depends: [], tasks: [] },
          { id: "S02", title: "B", done: false, active: false, risk: "low", depends: ["S01"], tasks: [] }
        ]
      },
      {
        id: "M002",
        title: "Second",
        status: "pending",
        dependsOn: ["M001"],
        slices: []
      }
    ],
    criticalPath: {
      milestonePath: ["M001", "M002"],
      slicePath: ["S01", "S02"],
      milestoneSlack: /* @__PURE__ */ new Map([["M001", 0], ["M002", 0]]),
      sliceSlack: /* @__PURE__ */ new Map([["S01", 0], ["S02", 0]])
    },
    sliceVerifications: [
      {
        milestoneId: "M001",
        sliceId: "S01",
        verificationResult: "passed",
        blockerDiscovered: false,
        keyDecisions: [],
        patternsEstablished: [],
        provides: ["api-types"],
        requires: []
      }
    ]
  });
  const lines = renderDepsView(data, mockTheme, 80);
  assert.ok(lines.length > 0, "deps view produces output");
  assert.ok(lines.some((l) => l.includes("M001") && l.includes("M002")), "shows milestone dep edge");
  assert.ok(lines.some((l) => l.includes("S01") && l.includes("S02")), "shows slice dep edge");
  assert.ok(lines.some((l) => l.includes("Critical Path")), "shows critical path section");
  assert.ok(lines.some((l) => l.includes("[CRITICAL]")), "shows CRITICAL badge");
  assert.ok(lines.some((l) => l.includes("Data Flow")), "shows data flow section");
  assert.ok(lines.some((l) => l.includes("api-types")), "shows provides artifact");
}
{
  const data = makeVisualizerData({
    milestones: [
      { id: "M001", title: "Only", status: "active", dependsOn: [], slices: [] }
    ]
  });
  const lines = renderDepsView(data, mockTheme, 80);
  assert.ok(lines.some((l) => l.includes("No milestone dependencies")), "shows no-deps message");
}
console.log("\n=== renderMetricsView ===");
{
  const data = makeVisualizerData({
    totals: {
      units: 5,
      tokens: { input: 1e3, output: 500, cacheRead: 200, cacheWrite: 100, total: 1800 },
      cost: 2.5,
      duration: 6e4,
      toolCalls: 15,
      assistantMessages: 10,
      userMessages: 5,
      totalTruncationSections: 0,
      continueHereFiredCount: 0,
      apiRequests: 5
    },
    byPhase: [
      {
        phase: "execution",
        units: 3,
        tokens: { input: 600, output: 300, cacheRead: 100, cacheWrite: 50, total: 1050 },
        cost: 1.5,
        duration: 4e4
      }
    ],
    byModel: [
      {
        model: "claude-opus-4-6",
        units: 5,
        tokens: { input: 1e3, output: 500, cacheRead: 200, cacheWrite: 100, total: 1800 },
        cost: 2.5
      }
    ],
    byTier: [
      { tier: "standard", units: 3, tokens: { input: 600, output: 300, cacheRead: 100, cacheWrite: 50, total: 1050 }, cost: 1.5, downgraded: 0 },
      { tier: "light", units: 2, tokens: { input: 400, output: 200, cacheRead: 100, cacheWrite: 50, total: 750 }, cost: 1, downgraded: 1 }
    ],
    tierSavingsLine: "Dynamic routing: 1/5 units downgraded (20%), cost: $1.00",
    bySlice: [
      { sliceId: "M001/S01", units: 3, tokens: { input: 600, output: 300, cacheRead: 100, cacheWrite: 50, total: 1050 }, cost: 1.5, duration: 4e4 },
      { sliceId: "M001/S02", units: 2, tokens: { input: 400, output: 200, cacheRead: 100, cacheWrite: 50, total: 750 }, cost: 1, duration: 2e4 }
    ],
    remainingSliceCount: 3
  });
  const lines = renderMetricsView(data, mockTheme, 80);
  assert.ok(lines.length > 0, "metrics view produces output");
  assert.ok(lines.some((l) => l.includes("$2.50")), "shows total cost");
  assert.ok(lines.some((l) => l.includes("execution")), "shows phase name");
  assert.ok(lines.some((l) => l.includes("claude-opus-4-6")), "shows model name");
  assert.ok(lines.some((l) => l.includes("By Tier")), "shows tier breakdown section");
  assert.ok(lines.some((l) => l.includes("standard")), "shows tier name");
  assert.ok(lines.some((l) => l.includes("Dynamic routing")), "shows tier savings line");
  assert.ok(lines.some((l) => l.includes("Tools: 15")), "shows tool call count");
  assert.ok(lines.some((l) => l.includes("10") && l.includes("sent")), "shows message counts");
}
{
  const data = makeVisualizerData({ totals: null });
  const lines = renderMetricsView(data, mockTheme, 80);
  assert.ok(lines.some((l) => l.includes("No metrics data")), "shows no-data message");
}
console.log("\n=== renderTimelineView ===");
{
  const now = Date.now();
  const data = makeVisualizerData({
    units: [
      {
        type: "execute-task",
        id: "M001/S01/T01",
        model: "claude-opus-4-6",
        startedAt: now - 12e4,
        finishedAt: now - 6e4,
        tokens: { input: 500, output: 200, cacheRead: 100, cacheWrite: 50, total: 850 },
        cost: 0.42,
        toolCalls: 5,
        assistantMessages: 3,
        userMessages: 1,
        tier: "standard"
      }
    ]
  });
  const listLines = renderTimelineView(data, mockTheme, 80);
  assert.ok(listLines.length >= 1, "list view produces lines");
  assert.ok(listLines.some((l) => l.includes("execute-task")), "shows unit type");
  assert.ok(listLines.some((l) => l.includes("[standard]")), "shows tier in timeline");
  assert.ok(listLines.some((l) => l.includes("opus-4-6")), "shows shortened model");
}
{
  const data = makeVisualizerData({ units: [] });
  const lines = renderTimelineView(data, mockTheme, 80);
  assert.ok(lines.some((l) => l.includes("No execution history")), "shows empty message");
}
console.log("\n=== renderAgentView ===");
{
  const now = Date.now();
  const data = makeVisualizerData({
    agentActivity: {
      currentUnit: { type: "execute-task", id: "M001/S02/T03", startedAt: now - 6e4 },
      elapsed: 6e4,
      completedUnits: 8,
      totalSlices: 15,
      completionRate: 2.4,
      active: true,
      sessionCost: 1.23,
      sessionTokens: 45200
    },
    units: [
      {
        type: "execute-task",
        id: "M001/S01/T01",
        model: "claude-opus-4-6",
        startedAt: now - 3e5,
        finishedAt: now - 24e4,
        tokens: { input: 500, output: 200, cacheRead: 100, cacheWrite: 50, total: 850 },
        cost: 0.12,
        toolCalls: 5,
        assistantMessages: 3,
        userMessages: 1
      }
    ],
    health: {
      budgetCeiling: 10,
      tokenProfile: "standard",
      truncationRate: 15.5,
      continueHereRate: 5,
      tierBreakdown: [],
      tierSavingsLine: "",
      toolCalls: 20,
      assistantMessages: 15,
      userMessages: 8,
      providers: [],
      skillSummary: { total: 0, warningCount: 0, criticalCount: 0, topIssue: null },
      environmentIssues: []
    },
    captures: { entries: [], pendingCount: 3, totalCount: 5 }
  });
  const lines = renderAgentView(data, mockTheme, 80);
  assert.ok(lines.length > 0, "agent view produces output");
  assert.ok(lines.some((l) => l.includes("ACTIVE")), "shows active status");
  assert.ok(lines.some((l) => l.includes("Pressure")), "shows pressure section");
  assert.ok(lines.some((l) => l.includes("15.5%")), "shows truncation rate");
  assert.ok(lines.some((l) => l.includes("Pending captures: 3")), "shows pending captures");
}
{
  const data = makeVisualizerData({ agentActivity: null });
  const lines = renderAgentView(data, mockTheme, 80);
  assert.ok(lines.some((l) => l.includes("No agent activity")), "shows no-activity message");
}
console.log("\n=== renderChangelogView ===");
{
  const data = makeVisualizerData({
    changelog: {
      entries: [
        {
          milestoneId: "M001",
          sliceId: "S01",
          title: "Core Authentication Setup",
          oneLiner: "Added JWT-based auth with refresh token rotation",
          filesModified: [
            { path: "src/auth/jwt.ts", description: "JWT token generation and validation" }
          ],
          completedAt: "2026-03-15T14:30:00Z"
        }
      ]
    },
    sliceVerifications: [
      {
        milestoneId: "M001",
        sliceId: "S01",
        verificationResult: "passed",
        blockerDiscovered: false,
        keyDecisions: ["Use RS256 for JWT signing"],
        patternsEstablished: ["Repository pattern for data access"],
        provides: [],
        requires: []
      }
    ]
  });
  const lines = renderChangelogView(data, mockTheme, 80);
  assert.ok(lines.some((l) => l.includes("M001/S01")), "shows slice reference");
  assert.ok(lines.some((l) => l.includes("Decisions:")), "shows decisions section");
  assert.ok(lines.some((l) => l.includes("RS256")), "shows decision content");
  assert.ok(lines.some((l) => l.includes("Patterns:")), "shows patterns section");
  assert.ok(lines.some((l) => l.includes("Repository pattern")), "shows pattern content");
}
{
  const data = makeVisualizerData({ changelog: { entries: [] } });
  const lines = renderChangelogView(data, mockTheme, 80);
  assert.ok(lines.some((l) => l.includes("No completed slices")), "shows empty state");
}
console.log("\n=== renderExportView ===");
{
  const data = makeVisualizerData();
  const lines = renderExportView(data, mockTheme, 80);
  assert.ok(lines.some((l) => l.includes("Export Options")), "shows export header");
  assert.ok(lines.some((l) => l.includes("[m]")), "shows markdown option");
  assert.ok(lines.some((l) => l.includes("[j]")), "shows json option");
  assert.ok(lines.some((l) => l.includes("[s]")), "shows snapshot option");
}
console.log("\n=== renderKnowledgeView ===");
{
  const data = makeVisualizerData({
    knowledge: {
      exists: true,
      rules: [{ id: "K001", scope: "global", content: "Always use transactions" }],
      patterns: [{ id: "P001", content: "Repository pattern for DB access" }],
      lessons: [{ id: "L001", content: "Cache invalidation needs TTL" }]
    }
  });
  const lines = renderKnowledgeView(data, mockTheme, 80);
  assert.ok(lines.some((l) => l.includes("Rules")), "shows rules section");
  assert.ok(lines.some((l) => l.includes("K001")), "shows rule ID");
  assert.ok(lines.some((l) => l.includes("Always use transactions")), "shows rule content");
  assert.ok(lines.some((l) => l.includes("Patterns")), "shows patterns section");
  assert.ok(lines.some((l) => l.includes("P001")), "shows pattern ID");
  assert.ok(lines.some((l) => l.includes("Lessons Learned")), "shows lessons section");
  assert.ok(lines.some((l) => l.includes("L001")), "shows lesson ID");
}
{
  const data = makeVisualizerData({
    knowledge: { exists: false, rules: [], patterns: [], lessons: [] }
  });
  const lines = renderKnowledgeView(data, mockTheme, 80);
  assert.ok(lines.some((l) => l.includes("No KNOWLEDGE.md found")), "shows no-knowledge message");
}
console.log("\n=== renderCapturesView ===");
{
  const data = makeVisualizerData({
    captures: {
      entries: [
        { id: "CAP-abc123", text: "Need to add error handling", timestamp: "2026-03-15T10:00:00Z", status: "pending", classification: "inject" },
        { id: "CAP-def456", text: "Consider caching layer", timestamp: "2026-03-15T11:00:00Z", status: "triaged", classification: "defer" },
        { id: "CAP-ghi789", text: "Fixed typo in config", timestamp: "2026-03-15T12:00:00Z", status: "resolved", classification: "quick-task" }
      ],
      pendingCount: 1,
      totalCount: 3
    }
  });
  const lines = renderCapturesView(data, mockTheme, 80);
  assert.ok(lines.some((l) => l.includes("3") && l.includes("total")), "shows total count");
  assert.ok(lines.some((l) => l.includes("1") && l.includes("pending")), "shows pending count");
  assert.ok(lines.some((l) => l.includes("CAP-abc123")), "shows capture ID");
  assert.ok(lines.some((l) => l.includes("(inject)")), "shows classification badge");
  assert.ok(lines.some((l) => l.includes("[pending]")), "shows status badge");
}
{
  const data = makeVisualizerData({
    captures: { entries: [], pendingCount: 0, totalCount: 0 }
  });
  const lines = renderCapturesView(data, mockTheme, 80);
  assert.ok(lines.some((l) => l.includes("No captures recorded")), "shows empty state");
}
console.log("\n=== renderHealthView ===");
{
  const data = makeVisualizerData({
    totals: {
      units: 10,
      tokens: { input: 5e3, output: 2e3, cacheRead: 1e3, cacheWrite: 500, total: 8500 },
      cost: 5,
      duration: 12e4,
      toolCalls: 50,
      assistantMessages: 30,
      userMessages: 15,
      totalTruncationSections: 3,
      continueHereFiredCount: 1,
      apiRequests: 30
    },
    health: {
      budgetCeiling: 20,
      tokenProfile: "standard",
      truncationRate: 30,
      continueHereRate: 10,
      tierBreakdown: [
        { tier: "standard", units: 7, tokens: { input: 3500, output: 1400, cacheRead: 700, cacheWrite: 350, total: 5950 }, cost: 3.5, downgraded: 0 },
        { tier: "light", units: 3, tokens: { input: 1500, output: 600, cacheRead: 300, cacheWrite: 150, total: 2550 }, cost: 1.5, downgraded: 2 }
      ],
      tierSavingsLine: "Dynamic routing: 2/10 units downgraded (20%), cost: $1.50",
      toolCalls: 50,
      assistantMessages: 30,
      userMessages: 15,
      providers: [],
      skillSummary: { total: 0, warningCount: 0, criticalCount: 0, topIssue: null },
      environmentIssues: []
    }
  });
  const lines = renderHealthView(data, mockTheme, 80);
  assert.ok(lines.some((l) => l.includes("Budget")), "shows budget section");
  assert.ok(lines.some((l) => l.includes("Ceiling")), "shows budget ceiling");
  assert.ok(lines.some((l) => l.includes("$20.00")), "shows ceiling amount");
  assert.ok(lines.some((l) => l.includes("Pressure")), "shows pressure section");
  assert.ok(lines.some((l) => l.includes("30.0%")), "shows truncation rate");
  assert.ok(lines.some((l) => l.includes("Routing")), "shows routing section");
  assert.ok(lines.some((l) => l.includes("standard")), "shows tier name");
  assert.ok(lines.some((l) => l.includes("2 downgraded")), "shows downgraded count");
  assert.ok(lines.some((l) => l.includes("Dynamic routing")), "shows savings line");
  assert.ok(lines.some((l) => l.includes("Session")), "shows session section");
  assert.ok(lines.some((l) => l.includes("Tool calls: 50")), "shows tool calls");
}
{
  const data = makeVisualizerData({
    health: {
      budgetCeiling: void 0,
      tokenProfile: "compact",
      truncationRate: 0,
      continueHereRate: 0,
      tierBreakdown: [],
      tierSavingsLine: "",
      toolCalls: 0,
      assistantMessages: 0,
      userMessages: 0,
      providers: [],
      skillSummary: { total: 0, warningCount: 0, criticalCount: 0, topIssue: null },
      environmentIssues: []
    }
  });
  const lines = renderHealthView(data, mockTheme, 80);
  assert.ok(lines.some((l) => l.includes("No budget ceiling set")), "shows no-ceiling message");
  assert.ok(lines.some((l) => l.includes("compact")), "shows token profile");
}
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy92aXN1YWxpemVyLXZpZXdzLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFRlc3RzIGZvciBHU0QgdmlzdWFsaXplciB2aWV3IHJlbmRlcmVycy5cbi8vIFRlc3RzIHRoZSBwdXJlIHZpZXcgZnVuY3Rpb25zIHdpdGggbW9jayBkYXRhIFx1MjAxNCBubyBmaWxlIEkvTy5cblxuaW1wb3J0IHtcbiAgcmVuZGVyUHJvZ3Jlc3NWaWV3LFxuICByZW5kZXJEZXBzVmlldyxcbiAgcmVuZGVyTWV0cmljc1ZpZXcsXG4gIHJlbmRlclRpbWVsaW5lVmlldyxcbiAgcmVuZGVyQWdlbnRWaWV3LFxuICByZW5kZXJDaGFuZ2Vsb2dWaWV3LFxuICByZW5kZXJFeHBvcnRWaWV3LFxuICByZW5kZXJLbm93bGVkZ2VWaWV3LFxuICByZW5kZXJDYXB0dXJlc1ZpZXcsXG4gIHJlbmRlckhlYWx0aFZpZXcsXG59IGZyb20gXCIuLi92aXN1YWxpemVyLXZpZXdzLmpzXCI7XG5pbXBvcnQgdHlwZSB7IFZpc3VhbGl6ZXJEYXRhIH0gZnJvbSBcIi4uL3Zpc3VhbGl6ZXItZGF0YS5qc1wiO1xuaW1wb3J0IHsgdGVzdCB9IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7XG5cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIE1vY2sgdGhlbWUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmNvbnN0IG1vY2tUaGVtZSA9IHtcbiAgZmc6IChfY29sb3I6IHN0cmluZywgdGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuICBib2xkOiAodGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxufSBhcyBhbnk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUZXN0IGRhdGEgZmFjdG9yaWVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBtYWtlVmlzdWFsaXplckRhdGEob3ZlcnJpZGVzOiBQYXJ0aWFsPFZpc3VhbGl6ZXJEYXRhPiA9IHt9KTogVmlzdWFsaXplckRhdGEge1xuICByZXR1cm4ge1xuICAgIG1pbGVzdG9uZXM6IFtdLFxuICAgIHBoYXNlOiBcImV4ZWN1dGluZ1wiLFxuICAgIHRvdGFsczogbnVsbCxcbiAgICBieVBoYXNlOiBbXSxcbiAgICBieVNsaWNlOiBbXSxcbiAgICBieU1vZGVsOiBbXSxcbiAgICBieVRpZXI6IFtdLFxuICAgIHRpZXJTYXZpbmdzTGluZTogXCJcIixcbiAgICB1bml0czogW10sXG4gICAgY3JpdGljYWxQYXRoOiB7XG4gICAgICBtaWxlc3RvbmVQYXRoOiBbXSxcbiAgICAgIHNsaWNlUGF0aDogW10sXG4gICAgICBtaWxlc3RvbmVTbGFjazogbmV3IE1hcCgpLFxuICAgICAgc2xpY2VTbGFjazogbmV3IE1hcCgpLFxuICAgIH0sXG4gICAgcmVtYWluaW5nU2xpY2VDb3VudDogMCxcbiAgICBhZ2VudEFjdGl2aXR5OiBudWxsLFxuICAgIGNoYW5nZWxvZzogeyBlbnRyaWVzOiBbXSB9LFxuICAgIHNsaWNlVmVyaWZpY2F0aW9uczogW10sXG4gICAga25vd2xlZGdlOiB7IHJ1bGVzOiBbXSwgcGF0dGVybnM6IFtdLCBsZXNzb25zOiBbXSwgZXhpc3RzOiBmYWxzZSB9LFxuICAgIGNhcHR1cmVzOiB7IGVudHJpZXM6IFtdLCBwZW5kaW5nQ291bnQ6IDAsIHRvdGFsQ291bnQ6IDAgfSxcbiAgICBoZWFsdGg6IHtcbiAgICAgIGJ1ZGdldENlaWxpbmc6IHVuZGVmaW5lZCxcbiAgICAgIHRva2VuUHJvZmlsZTogXCJzdGFuZGFyZFwiLFxuICAgICAgdHJ1bmNhdGlvblJhdGU6IDAsXG4gICAgICBjb250aW51ZUhlcmVSYXRlOiAwLFxuICAgICAgdGllckJyZWFrZG93bjogW10sXG4gICAgICB0aWVyU2F2aW5nc0xpbmU6IFwiXCIsXG4gICAgICB0b29sQ2FsbHM6IDAsXG4gICAgICBhc3Npc3RhbnRNZXNzYWdlczogMCxcbiAgICAgIHVzZXJNZXNzYWdlczogMCxcbiAgICAgIHByb3ZpZGVyczogW10sXG4gICAgICBza2lsbFN1bW1hcnk6IHsgdG90YWw6IDAsIHdhcm5pbmdDb3VudDogMCwgY3JpdGljYWxDb3VudDogMCwgdG9wSXNzdWU6IG51bGwgfSxcbiAgICAgIGVudmlyb25tZW50SXNzdWVzOiBbXSxcbiAgICB9LFxuICAgIGRpc2N1c3Npb246IFtdLFxuICAgIHN0YXRzOiB7XG4gICAgICBtaXNzaW5nQ291bnQ6IDAsXG4gICAgICBtaXNzaW5nU2xpY2VzOiBbXSxcbiAgICAgIHVwZGF0ZWRDb3VudDogMCxcbiAgICAgIHVwZGF0ZWRTbGljZXM6IFtdLFxuICAgICAgcmVjZW50RW50cmllczogW10sXG4gICAgfSxcbiAgICAuLi5vdmVycmlkZXMsXG4gIH07XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCByZW5kZXJQcm9ncmVzc1ZpZXcgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmNvbnNvbGUubG9nKFwiXFxuPT09IHJlbmRlclByb2dyZXNzVmlldyA9PT1cIik7XG5cbntcbiAgY29uc3QgZGF0YSA9IG1ha2VWaXN1YWxpemVyRGF0YSh7XG4gICAgbWlsZXN0b25lczogW1xuICAgICAge1xuICAgICAgICBpZDogXCJNMDAxXCIsXG4gICAgICAgIHRpdGxlOiBcIkZpcnN0IE1pbGVzdG9uZVwiLFxuICAgICAgICBzdGF0dXM6IFwiYWN0aXZlXCIsXG4gICAgICAgIGRlcGVuZHNPbjogW10sXG4gICAgICAgIHNsaWNlczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIGlkOiBcIlMwMVwiLFxuICAgICAgICAgICAgdGl0bGU6IFwiQ29yZSBUeXBlc1wiLFxuICAgICAgICAgICAgZG9uZTogdHJ1ZSxcbiAgICAgICAgICAgIGFjdGl2ZTogZmFsc2UsXG4gICAgICAgICAgICByaXNrOiBcImxvd1wiLFxuICAgICAgICAgICAgZGVwZW5kczogW10sXG4gICAgICAgICAgICB0YXNrczogW10sXG4gICAgICAgICAgfSxcbiAgICAgICAgICB7XG4gICAgICAgICAgICBpZDogXCJTMDJcIixcbiAgICAgICAgICAgIHRpdGxlOiBcIlN0YXRlIEVuZ2luZVwiLFxuICAgICAgICAgICAgZG9uZTogZmFsc2UsXG4gICAgICAgICAgICBhY3RpdmU6IHRydWUsXG4gICAgICAgICAgICByaXNrOiBcImhpZ2hcIixcbiAgICAgICAgICAgIGRlcGVuZHM6IFtcIlMwMVwiXSxcbiAgICAgICAgICAgIHRhc2tzOiBbXG4gICAgICAgICAgICAgIHsgaWQ6IFwiVDAxXCIsIHRpdGxlOiBcIkRpc3BhdGNoIExvb3BcIiwgZG9uZTogZmFsc2UsIGFjdGl2ZTogdHJ1ZSwgZXN0aW1hdGU6IFwiMzBtXCIgfSxcbiAgICAgICAgICAgICAgeyBpZDogXCJUMDJcIiwgdGl0bGU6IFwiU2Vzc2lvbiBNZ210XCIsIGRvbmU6IHRydWUsIGFjdGl2ZTogZmFsc2UgfSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgIGlkOiBcIlMwM1wiLFxuICAgICAgICAgIHRpdGxlOiBcIkRhc2hib2FyZFwiLFxuICAgICAgICAgIGRvbmU6IGZhbHNlLFxuICAgICAgICAgIGFjdGl2ZTogZmFsc2UsXG4gICAgICAgICAgcmlzazogXCJtZWRpdW1cIixcbiAgICAgICAgICBkZXBlbmRzOiBbXCJTMDJcIl0sXG4gICAgICAgICAgdGFza3M6IFtdLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9LFxuICAgIHtcbiAgICAgIGlkOiBcIk0wMDJcIixcbiAgICAgIHRpdGxlOiBcIlBsdWdpbiBBcmNoXCIsXG4gICAgICBzdGF0dXM6IFwicGVuZGluZ1wiLFxuICAgICAgZGVwZW5kc09uOiBbXCJNMDAxXCJdLFxuICAgICAgc2xpY2VzOiBbXSxcbiAgICB9LFxuICBdLFxuICAgIHNsaWNlVmVyaWZpY2F0aW9uczogW1xuICAgICAge1xuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICAgIHNsaWNlSWQ6IFwiUzAxXCIsXG4gICAgICAgIHZlcmlmaWNhdGlvblJlc3VsdDogXCJwYXNzZWRcIixcbiAgICAgICAgYmxvY2tlckRpc2NvdmVyZWQ6IGZhbHNlLFxuICAgICAgICBrZXlEZWNpc2lvbnM6IFtdLFxuICAgICAgICBwYXR0ZXJuc0VzdGFibGlzaGVkOiBbXSxcbiAgICAgICAgcHJvdmlkZXM6IFtcImNvcmUtdHlwZXNcIl0sXG4gICAgICAgIHJlcXVpcmVzOiBbXSxcbiAgICAgIH0sXG4gICAgXSxcbiAgICBzdGF0czoge1xuICAgICAgbWlzc2luZ0NvdW50OiAyLFxuICAgICAgbWlzc2luZ1NsaWNlczogW1xuICAgICAgICB7IG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgc2xpY2VJZDogXCJTMDJcIiwgdGl0bGU6IFwiU3RhdGUgRW5naW5lXCIgfSxcbiAgICAgICAgeyBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHNsaWNlSWQ6IFwiUzAzXCIsIHRpdGxlOiBcIkRhc2hib2FyZFwiIH0sXG4gICAgICBdLFxuICAgICAgdXBkYXRlZENvdW50OiAxLFxuICAgICAgdXBkYXRlZFNsaWNlczogW1xuICAgICAgICB7IG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgc2xpY2VJZDogXCJTMDFcIiwgdGl0bGU6IFwiQ29yZSBUeXBlc1wiLCBjb21wbGV0ZWRBdDogXCIyMDI2LTAzLTE1VDE0OjMwOjAwWlwiIH0sXG4gICAgICBdLFxuICAgICAgcmVjZW50RW50cmllczogW1xuICAgICAgICB7XG4gICAgICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgICAgIHNsaWNlSWQ6IFwiUzAxXCIsXG4gICAgICAgICAgdGl0bGU6IFwiQ29yZSBUeXBlcyBJbmZyYXN0cnVjdHVyZVwiLFxuICAgICAgICAgIG9uZUxpbmVyOiBcIkNvcmUgc3RydWN0dXJlcyBhc3NlbWJsZWRcIixcbiAgICAgICAgICBmaWxlc01vZGlmaWVkOiBbXSxcbiAgICAgICAgICBjb21wbGV0ZWRBdDogXCIyMDI2LTAzLTE1VDE0OjMwOjAwWlwiLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9LFxuICB9KTtcblxuICBjb25zdCBsaW5lcyA9IHJlbmRlclByb2dyZXNzVmlldyhkYXRhLCBtb2NrVGhlbWUsIDgwKTtcbiAgYXNzZXJ0Lm9rKGxpbmVzLmxlbmd0aCA+IDAsIFwicHJvZ3Jlc3MgdmlldyBwcm9kdWNlcyBvdXRwdXRcIik7XG4gIGFzc2VydC5vayhsaW5lcy5zb21lKGwgPT4gbC5pbmNsdWRlcyhcIk0wMDFcIikpLCBcInNob3dzIG1pbGVzdG9uZSBNMDAxXCIpO1xuICBhc3NlcnQub2sobGluZXMuc29tZShsID0+IGwuaW5jbHVkZXMoXCJTMDFcIikpLCBcInNob3dzIHNsaWNlIFMwMVwiKTtcbiAgYXNzZXJ0Lm9rKGxpbmVzLnNvbWUobCA9PiBsLmluY2x1ZGVzKFwiVDAxXCIpKSwgXCJzaG93cyB0YXNrIFQwMSBmb3IgYWN0aXZlIHNsaWNlXCIpO1xuICBhc3NlcnQub2sobGluZXMuc29tZShsID0+IGwuaW5jbHVkZXMoXCJNMDAyXCIpKSwgXCJzaG93cyBtaWxlc3RvbmUgTTAwMlwiKTtcbiAgYXNzZXJ0Lm9rKGxpbmVzLnNvbWUobCA9PiBsLmluY2x1ZGVzKFwiZGVwZW5kcyBvbiBNMDAxXCIpKSwgXCJzaG93cyBkZXBlbmRlbmN5IG5vdGVcIik7XG4gIGFzc2VydC5vayhsaW5lcy5zb21lKGwgPT4gbC5pbmNsdWRlcyhcIjMwbVwiKSksIFwic2hvd3MgdGFzayBlc3RpbWF0ZVwiKTtcbiAgYXNzZXJ0Lm9rKGxpbmVzLnNvbWUobCA9PiBsLmluY2x1ZGVzKFwiRmVhdHVyZSBTbmFwc2hvdFwiKSksIFwic2hvd3Mgc3RhdHMgaGVhZGVyXCIpO1xuICBhc3NlcnQub2sobGluZXMuc29tZShsID0+IGwuaW5jbHVkZXMoXCJNaXNzaW5nIHNsaWNlc1wiKSksIFwic2hvd3MgbWlzc2luZyBzbGljZXMgY291bnRcIik7XG4gIGFzc2VydC5vayhsaW5lcy5zb21lKGwgPT4gbC5pbmNsdWRlcyhcIlN0YXRlIEVuZ2luZVwiKSksIFwic2hvd3MgbWlzc2luZyBzbGljZSBwcmV2aWV3XCIpO1xuICBhc3NlcnQub2sobGluZXMuc29tZShsID0+IGwuaW5jbHVkZXMoXCJVcGRhdGVkIChsYXN0IDcgZGF5cylcIikpLCBcInNob3dzIHVwZGF0ZWQgY291bnRcIik7XG4gIGFzc2VydC5vayhsaW5lcy5zb21lKGwgPT4gbC5pbmNsdWRlcyhcIlJlY2VudCBjb21wbGV0aW9uc1wiKSksIFwic2hvd3MgcmVjZW50IGNvbXBsZXRpb25zIHNlY3Rpb25cIik7XG4gIGFzc2VydC5vayhsaW5lcy5zb21lKGwgPT4gbC5pbmNsdWRlcyhcIkNvcmUgc3RydWN0dXJlcyBhc3NlbWJsZWRcIikpLCBcInNob3dzIHJlY2VudCBvbmUtbGluZXIgZW50cnlcIik7XG59XG5cbntcbiAgY29uc3QgZGF0YSA9IG1ha2VWaXN1YWxpemVyRGF0YSh7XG4gICAgZGlzY3Vzc2lvbjogW1xuICAgICAge1xuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICAgIHRpdGxlOiBcIkZpcnN0IE1pbGVzdG9uZVwiLFxuICAgICAgICBzdGF0ZTogXCJkaXNjdXNzZWRcIixcbiAgICAgICAgaGFzQ29udGV4dDogdHJ1ZSxcbiAgICAgICAgaGFzRHJhZnQ6IGZhbHNlLFxuICAgICAgICBsYXN0VXBkYXRlZDogXCIyMDI2LTAzLTE1VDE0OjMwOjAwWlwiLFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMlwiLFxuICAgICAgICB0aXRsZTogXCJQbHVnaW4gQXJjaFwiLFxuICAgICAgICBzdGF0ZTogXCJkcmFmdFwiLFxuICAgICAgICBoYXNDb250ZXh0OiBmYWxzZSxcbiAgICAgICAgaGFzRHJhZnQ6IHRydWUsXG4gICAgICAgIGxhc3RVcGRhdGVkOiBcIjIwMjYtMDMtMTZUMDk6MDA6MDBaXCIsXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDAzXCIsXG4gICAgICAgIHRpdGxlOiBcIk5leHQgQmF0Y2hcIixcbiAgICAgICAgc3RhdGU6IFwidW5kaXNjdXNzZWRcIixcbiAgICAgICAgaGFzQ29udGV4dDogZmFsc2UsXG4gICAgICAgIGhhc0RyYWZ0OiBmYWxzZSxcbiAgICAgICAgbGFzdFVwZGF0ZWQ6IG51bGwsXG4gICAgICB9LFxuICAgIF0sXG4gIH0pO1xuXG4gIGNvbnN0IGxpbmVzID0gcmVuZGVyUHJvZ3Jlc3NWaWV3KGRhdGEsIG1vY2tUaGVtZSwgODApO1xuICBhc3NlcnQub2sobGluZXMuc29tZShsID0+IGwuaW5jbHVkZXMoXCJEaXNjdXNzaW9uIFN0YXR1c1wiKSksIFwic2hvd3MgZGlzY3Vzc2lvbiBzZWN0aW9uXCIpO1xuICBhc3NlcnQub2sobGluZXMuc29tZShsID0+IGwuaW5jbHVkZXMoXCJEaXNjdXNzZWQ6IDFcIikpLCBcImNvdW50cyBkaXNjdXNzZWQgbWlsZXN0b25lc1wiKTtcbiAgYXNzZXJ0Lm9rKGxpbmVzLnNvbWUobCA9PiBsLmluY2x1ZGVzKFwiRHJhZnRcIikpLCBcInNob3dzIGRyYWZ0IGJhZGdlXCIpO1xuICBhc3NlcnQub2sobGluZXMuc29tZShsID0+IGwuaW5jbHVkZXMoXCJQZW5kaW5nXCIpKSwgXCJzaG93cyBwZW5kaW5nIGJhZGdlXCIpO1xufVxuXG4vLyBWZXJpZmljYXRpb24gYmFkZ2VzXG57XG4gIGNvbnN0IGRhdGEgPSBtYWtlVmlzdWFsaXplckRhdGEoe1xuICAgIG1pbGVzdG9uZXM6IFtcbiAgICAgIHtcbiAgICAgICAgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIsIHN0YXR1czogXCJhY3RpdmVcIiwgZGVwZW5kc09uOiBbXSxcbiAgICAgICAgc2xpY2VzOiBbXG4gICAgICAgICAgeyBpZDogXCJTMDFcIiwgdGl0bGU6IFwiRG9uZSBTbGljZVwiLCBkb25lOiB0cnVlLCBhY3RpdmU6IGZhbHNlLCByaXNrOiBcImxvd1wiLCBkZXBlbmRzOiBbXSwgdGFza3M6IFtdIH0sXG4gICAgICAgIF0sXG4gICAgICB9LFxuICAgIF0sXG4gICAgc2xpY2VWZXJpZmljYXRpb25zOiBbXG4gICAgICB7XG4gICAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgc2xpY2VJZDogXCJTMDFcIixcbiAgICAgICAgdmVyaWZpY2F0aW9uUmVzdWx0OiBcInBhc3NlZFwiLCBibG9ja2VyRGlzY292ZXJlZDogdHJ1ZSxcbiAgICAgICAga2V5RGVjaXNpb25zOiBbXSwgcGF0dGVybnNFc3RhYmxpc2hlZDogW10sIHByb3ZpZGVzOiBbXSwgcmVxdWlyZXM6IFtdLFxuICAgICAgfSxcbiAgICBdLFxuICB9KTtcblxuICBjb25zdCBsaW5lcyA9IHJlbmRlclByb2dyZXNzVmlldyhkYXRhLCBtb2NrVGhlbWUsIDgwKTtcbiAgLy8gVGhlIHZlcmlmaWNhdGlvbiBiYWRnZSBzaG91bGQgc2hvdyBjaGVjayBtYXJrIGFuZCB3YXJuaW5nXG4gIGFzc2VydC5vayhsaW5lcy5zb21lKGwgPT4gbC5pbmNsdWRlcyhcIlMwMVwiKSksIFwic2hvd3Mgc2xpY2Ugd2l0aCB2ZXJpZmljYXRpb25cIik7XG59XG5cbntcbiAgY29uc3QgZGF0YSA9IG1ha2VWaXN1YWxpemVyRGF0YSh7IG1pbGVzdG9uZXM6IFtdIH0pO1xuICBjb25zdCBsaW5lcyA9IHJlbmRlclByb2dyZXNzVmlldyhkYXRhLCBtb2NrVGhlbWUsIDgwKTtcbiAgYXNzZXJ0Lm9rKGxpbmVzLnNvbWUobCA9PiBsLmluY2x1ZGVzKFwiRmVhdHVyZSBTbmFwc2hvdFwiKSksIFwic2hvd3Mgc3RhdHMgc25hcHNob3QgZXZlbiB3aGVuIG5vIG1pbGVzdG9uZXNcIik7XG4gIGFzc2VydC5vayhsaW5lcy5zb21lKGwgPT4gbC5pbmNsdWRlcyhcIk1pc3Npbmcgc2xpY2VzXCIpKSwgXCJyZXBvcnRzIG1pc3Npbmcgc2xpY2VzIGNvdW50XCIpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUmlzayBIZWF0bWFwIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5jb25zb2xlLmxvZyhcIlxcbj09PSBSaXNrIEhlYXRtYXAgPT09XCIpO1xuXG57XG4gIGNvbnN0IGRhdGEgPSBtYWtlVmlzdWFsaXplckRhdGEoe1xuICAgIG1pbGVzdG9uZXM6IFtcbiAgICAgIHtcbiAgICAgICAgaWQ6IFwiTTAwMVwiLFxuICAgICAgICB0aXRsZTogXCJGaXJzdFwiLFxuICAgICAgICBzdGF0dXM6IFwiYWN0aXZlXCIsXG4gICAgICAgIGRlcGVuZHNPbjogW10sXG4gICAgICAgIHNsaWNlczogW1xuICAgICAgICAgIHsgaWQ6IFwiUzAxXCIsIHRpdGxlOiBcIkFcIiwgZG9uZTogdHJ1ZSwgYWN0aXZlOiBmYWxzZSwgcmlzazogXCJsb3dcIiwgZGVwZW5kczogW10sIHRhc2tzOiBbXSB9LFxuICAgICAgICAgIHsgaWQ6IFwiUzAyXCIsIHRpdGxlOiBcIkJcIiwgZG9uZTogZmFsc2UsIGFjdGl2ZTogdHJ1ZSwgcmlzazogXCJoaWdoXCIsIGRlcGVuZHM6IFtdLCB0YXNrczogW10gfSxcbiAgICAgICAgICB7IGlkOiBcIlMwM1wiLCB0aXRsZTogXCJDXCIsIGRvbmU6IGZhbHNlLCBhY3RpdmU6IGZhbHNlLCByaXNrOiBcIm1lZGl1bVwiLCBkZXBlbmRzOiBbXSwgdGFza3M6IFtdIH0sXG4gICAgICAgICAgeyBpZDogXCJTMDRcIiwgdGl0bGU6IFwiRFwiLCBkb25lOiBmYWxzZSwgYWN0aXZlOiBmYWxzZSwgcmlzazogXCJoaWdoXCIsIGRlcGVuZHM6IFtdLCB0YXNrczogW10gfSxcbiAgICAgICAgXSxcbiAgICAgIH0sXG4gICAgXSxcbiAgfSk7XG5cbiAgY29uc3QgbGluZXMgPSByZW5kZXJQcm9ncmVzc1ZpZXcoZGF0YSwgbW9ja1RoZW1lLCA4MCk7XG4gIGFzc2VydC5vayhsaW5lcy5zb21lKGwgPT4gbC5pbmNsdWRlcyhcIlJpc2sgSGVhdG1hcFwiKSksIFwiaGVhdG1hcCBoZWFkZXIgcHJlc2VudFwiKTtcbiAgYXNzZXJ0Lm9rKGxpbmVzLnNvbWUobCA9PiBsLmluY2x1ZGVzKFwiMSBsb3csIDEgbWVkLCAyIGhpZ2hcIikpLCBcInJpc2sgc3VtbWFyeSBjb3VudHNcIik7XG4gIGFzc2VydC5vayhsaW5lcy5zb21lKGwgPT4gbC5pbmNsdWRlcyhcIjEgaGlnaC1yaXNrIG5vdCBzdGFydGVkXCIpKSwgXCJoaWdoLXJpc2sgbm90IHN0YXJ0ZWQgd2FybmluZ1wiKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFNlYXJjaC9GaWx0ZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmNvbnNvbGUubG9nKFwiXFxuPT09IFNlYXJjaC9GaWx0ZXIgPT09XCIpO1xuXG57XG4gIGNvbnN0IGRhdGEgPSBtYWtlVmlzdWFsaXplckRhdGEoe1xuICAgIG1pbGVzdG9uZXM6IFtcbiAgICAgIHtcbiAgICAgICAgaWQ6IFwiTTAwMVwiLFxuICAgICAgICB0aXRsZTogXCJBdXRoXCIsXG4gICAgICAgIHN0YXR1czogXCJhY3RpdmVcIixcbiAgICAgICAgZGVwZW5kc09uOiBbXSxcbiAgICAgICAgc2xpY2VzOiBbXG4gICAgICAgICAgeyBpZDogXCJTMDFcIiwgdGl0bGU6IFwiSldUXCIsIGRvbmU6IGZhbHNlLCBhY3RpdmU6IGZhbHNlLCByaXNrOiBcImxvd1wiLCBkZXBlbmRzOiBbXSwgdGFza3M6IFtdIH0sXG4gICAgICAgICAgeyBpZDogXCJTMDJcIiwgdGl0bGU6IFwiT0F1dGhcIiwgZG9uZTogZmFsc2UsIGFjdGl2ZTogZmFsc2UsIHJpc2s6IFwiaGlnaFwiLCBkZXBlbmRzOiBbXSwgdGFza3M6IFtdIH0sXG4gICAgICAgIF0sXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBpZDogXCJNMDAyXCIsXG4gICAgICAgIHRpdGxlOiBcIkRhc2hib2FyZFwiLFxuICAgICAgICBzdGF0dXM6IFwicGVuZGluZ1wiLFxuICAgICAgICBkZXBlbmRzT246IFtcIk0wMDFcIl0sXG4gICAgICAgIHNsaWNlczogW10sXG4gICAgICB9LFxuICAgIF0sXG4gIH0pO1xuXG4gIGNvbnN0IGZpbHRlcmVkID0gcmVuZGVyUHJvZ3Jlc3NWaWV3KGRhdGEsIG1vY2tUaGVtZSwgODAsIHsgdGV4dDogXCJhdXRoXCIsIGZpZWxkOiBcImFsbFwiIH0pO1xuICBhc3NlcnQub2soZmlsdGVyZWQuc29tZShsID0+IGwuaW5jbHVkZXMoXCJNMDAxXCIpKSwgXCJmaWx0ZXIgc2hvd3MgbWF0Y2hpbmcgbWlsZXN0b25lXCIpO1xuICBhc3NlcnQub2soZmlsdGVyZWQuc29tZShsID0+IGwuaW5jbHVkZXMoXCJGaWx0ZXIgKGFsbCk6IGF1dGhcIikpLCBcImZpbHRlciBpbmRpY2F0b3IgcHJlc2VudFwiKTtcblxuICBjb25zdCByaXNrRmlsdGVyZWQgPSByZW5kZXJQcm9ncmVzc1ZpZXcoZGF0YSwgbW9ja1RoZW1lLCA4MCwgeyB0ZXh0OiBcImhpZ2hcIiwgZmllbGQ6IFwicmlza1wiIH0pO1xuICBhc3NlcnQub2socmlza0ZpbHRlcmVkLnNvbWUobCA9PiBsLmluY2x1ZGVzKFwiTTAwMVwiKSksIFwicmlzayBmaWx0ZXIgc2hvd3MgbWlsZXN0b25lIHdpdGggaGlnaC1yaXNrIHNsaWNlXCIpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgcmVuZGVyRGVwc1ZpZXcgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmNvbnNvbGUubG9nKFwiXFxuPT09IHJlbmRlckRlcHNWaWV3ID09PVwiKTtcblxue1xuICBjb25zdCBkYXRhID0gbWFrZVZpc3VhbGl6ZXJEYXRhKHtcbiAgICBtaWxlc3RvbmVzOiBbXG4gICAgICB7XG4gICAgICAgIGlkOiBcIk0wMDFcIixcbiAgICAgICAgdGl0bGU6IFwiRmlyc3RcIixcbiAgICAgICAgc3RhdHVzOiBcImFjdGl2ZVwiLFxuICAgICAgICBkZXBlbmRzT246IFtdLFxuICAgICAgICBzbGljZXM6IFtcbiAgICAgICAgICB7IGlkOiBcIlMwMVwiLCB0aXRsZTogXCJBXCIsIGRvbmU6IGZhbHNlLCBhY3RpdmU6IHRydWUsIHJpc2s6IFwibG93XCIsIGRlcGVuZHM6IFtdLCB0YXNrczogW10gfSxcbiAgICAgICAgICB7IGlkOiBcIlMwMlwiLCB0aXRsZTogXCJCXCIsIGRvbmU6IGZhbHNlLCBhY3RpdmU6IGZhbHNlLCByaXNrOiBcImxvd1wiLCBkZXBlbmRzOiBbXCJTMDFcIl0sIHRhc2tzOiBbXSB9LFxuICAgICAgICBdLFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgaWQ6IFwiTTAwMlwiLFxuICAgICAgICB0aXRsZTogXCJTZWNvbmRcIixcbiAgICAgICAgc3RhdHVzOiBcInBlbmRpbmdcIixcbiAgICAgICAgZGVwZW5kc09uOiBbXCJNMDAxXCJdLFxuICAgICAgICBzbGljZXM6IFtdLFxuICAgICAgfSxcbiAgICBdLFxuICAgIGNyaXRpY2FsUGF0aDoge1xuICAgICAgbWlsZXN0b25lUGF0aDogW1wiTTAwMVwiLCBcIk0wMDJcIl0sXG4gICAgICBzbGljZVBhdGg6IFtcIlMwMVwiLCBcIlMwMlwiXSxcbiAgICAgIG1pbGVzdG9uZVNsYWNrOiBuZXcgTWFwKFtbXCJNMDAxXCIsIDBdLCBbXCJNMDAyXCIsIDBdXSksXG4gICAgICBzbGljZVNsYWNrOiBuZXcgTWFwKFtbXCJTMDFcIiwgMF0sIFtcIlMwMlwiLCAwXV0pLFxuICAgIH0sXG4gICAgc2xpY2VWZXJpZmljYXRpb25zOiBbXG4gICAgICB7XG4gICAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgc2xpY2VJZDogXCJTMDFcIixcbiAgICAgICAgdmVyaWZpY2F0aW9uUmVzdWx0OiBcInBhc3NlZFwiLCBibG9ja2VyRGlzY292ZXJlZDogZmFsc2UsXG4gICAgICAgIGtleURlY2lzaW9uczogW10sIHBhdHRlcm5zRXN0YWJsaXNoZWQ6IFtdLFxuICAgICAgICBwcm92aWRlczogW1wiYXBpLXR5cGVzXCJdLCByZXF1aXJlczogW10sXG4gICAgICB9LFxuICAgIF0sXG4gIH0pO1xuXG4gIGNvbnN0IGxpbmVzID0gcmVuZGVyRGVwc1ZpZXcoZGF0YSwgbW9ja1RoZW1lLCA4MCk7XG4gIGFzc2VydC5vayhsaW5lcy5sZW5ndGggPiAwLCBcImRlcHMgdmlldyBwcm9kdWNlcyBvdXRwdXRcIik7XG4gIGFzc2VydC5vayhsaW5lcy5zb21lKGwgPT4gbC5pbmNsdWRlcyhcIk0wMDFcIikgJiYgbC5pbmNsdWRlcyhcIk0wMDJcIikpLCBcInNob3dzIG1pbGVzdG9uZSBkZXAgZWRnZVwiKTtcbiAgYXNzZXJ0Lm9rKGxpbmVzLnNvbWUobCA9PiBsLmluY2x1ZGVzKFwiUzAxXCIpICYmIGwuaW5jbHVkZXMoXCJTMDJcIikpLCBcInNob3dzIHNsaWNlIGRlcCBlZGdlXCIpO1xuICBhc3NlcnQub2sobGluZXMuc29tZShsID0+IGwuaW5jbHVkZXMoXCJDcml0aWNhbCBQYXRoXCIpKSwgXCJzaG93cyBjcml0aWNhbCBwYXRoIHNlY3Rpb25cIik7XG4gIGFzc2VydC5vayhsaW5lcy5zb21lKGwgPT4gbC5pbmNsdWRlcyhcIltDUklUSUNBTF1cIikpLCBcInNob3dzIENSSVRJQ0FMIGJhZGdlXCIpO1xuICBhc3NlcnQub2sobGluZXMuc29tZShsID0+IGwuaW5jbHVkZXMoXCJEYXRhIEZsb3dcIikpLCBcInNob3dzIGRhdGEgZmxvdyBzZWN0aW9uXCIpO1xuICBhc3NlcnQub2sobGluZXMuc29tZShsID0+IGwuaW5jbHVkZXMoXCJhcGktdHlwZXNcIikpLCBcInNob3dzIHByb3ZpZGVzIGFydGlmYWN0XCIpO1xufVxuXG57XG4gIGNvbnN0IGRhdGEgPSBtYWtlVmlzdWFsaXplckRhdGEoe1xuICAgIG1pbGVzdG9uZXM6IFtcbiAgICAgIHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJPbmx5XCIsIHN0YXR1czogXCJhY3RpdmVcIiwgZGVwZW5kc09uOiBbXSwgc2xpY2VzOiBbXSB9LFxuICAgIF0sXG4gIH0pO1xuXG4gIGNvbnN0IGxpbmVzID0gcmVuZGVyRGVwc1ZpZXcoZGF0YSwgbW9ja1RoZW1lLCA4MCk7XG4gIGFzc2VydC5vayhsaW5lcy5zb21lKGwgPT4gbC5pbmNsdWRlcyhcIk5vIG1pbGVzdG9uZSBkZXBlbmRlbmNpZXNcIikpLCBcInNob3dzIG5vLWRlcHMgbWVzc2FnZVwiKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHJlbmRlck1ldHJpY3NWaWV3IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5jb25zb2xlLmxvZyhcIlxcbj09PSByZW5kZXJNZXRyaWNzVmlldyA9PT1cIik7XG5cbntcbiAgY29uc3QgZGF0YSA9IG1ha2VWaXN1YWxpemVyRGF0YSh7XG4gICAgdG90YWxzOiB7XG4gICAgICB1bml0czogNSxcbiAgICAgIHRva2VuczogeyBpbnB1dDogMTAwMCwgb3V0cHV0OiA1MDAsIGNhY2hlUmVhZDogMjAwLCBjYWNoZVdyaXRlOiAxMDAsIHRvdGFsOiAxODAwIH0sXG4gICAgICBjb3N0OiAyLjUwLFxuICAgICAgZHVyYXRpb246IDYwMDAwLFxuICAgICAgdG9vbENhbGxzOiAxNSxcbiAgICAgIGFzc2lzdGFudE1lc3NhZ2VzOiAxMCxcbiAgICAgIHVzZXJNZXNzYWdlczogNSxcbiAgICAgIHRvdGFsVHJ1bmNhdGlvblNlY3Rpb25zOiAwLFxuICAgICAgY29udGludWVIZXJlRmlyZWRDb3VudDogMCxcbiAgICAgIGFwaVJlcXVlc3RzOiA1LFxuICAgIH0sXG4gICAgYnlQaGFzZTogW1xuICAgICAge1xuICAgICAgICBwaGFzZTogXCJleGVjdXRpb25cIixcbiAgICAgICAgdW5pdHM6IDMsXG4gICAgICAgIHRva2VuczogeyBpbnB1dDogNjAwLCBvdXRwdXQ6IDMwMCwgY2FjaGVSZWFkOiAxMDAsIGNhY2hlV3JpdGU6IDUwLCB0b3RhbDogMTA1MCB9LFxuICAgICAgICBjb3N0OiAxLjUwLFxuICAgICAgICBkdXJhdGlvbjogNDAwMDAsXG4gICAgICB9LFxuICAgIF0sXG4gICAgYnlNb2RlbDogW1xuICAgICAge1xuICAgICAgICBtb2RlbDogXCJjbGF1ZGUtb3B1cy00LTZcIixcbiAgICAgICAgdW5pdHM6IDUsXG4gICAgICAgIHRva2VuczogeyBpbnB1dDogMTAwMCwgb3V0cHV0OiA1MDAsIGNhY2hlUmVhZDogMjAwLCBjYWNoZVdyaXRlOiAxMDAsIHRvdGFsOiAxODAwIH0sXG4gICAgICAgIGNvc3Q6IDIuNTAsXG4gICAgICB9LFxuICAgIF0sXG4gICAgYnlUaWVyOiBbXG4gICAgICB7IHRpZXI6IFwic3RhbmRhcmRcIiwgdW5pdHM6IDMsIHRva2VuczogeyBpbnB1dDogNjAwLCBvdXRwdXQ6IDMwMCwgY2FjaGVSZWFkOiAxMDAsIGNhY2hlV3JpdGU6IDUwLCB0b3RhbDogMTA1MCB9LCBjb3N0OiAxLjUwLCBkb3duZ3JhZGVkOiAwIH0sXG4gICAgICB7IHRpZXI6IFwibGlnaHRcIiwgdW5pdHM6IDIsIHRva2VuczogeyBpbnB1dDogNDAwLCBvdXRwdXQ6IDIwMCwgY2FjaGVSZWFkOiAxMDAsIGNhY2hlV3JpdGU6IDUwLCB0b3RhbDogNzUwIH0sIGNvc3Q6IDEuMDAsIGRvd25ncmFkZWQ6IDEgfSxcbiAgICBdLFxuICAgIHRpZXJTYXZpbmdzTGluZTogXCJEeW5hbWljIHJvdXRpbmc6IDEvNSB1bml0cyBkb3duZ3JhZGVkICgyMCUpLCBjb3N0OiAkMS4wMFwiLFxuICAgIGJ5U2xpY2U6IFtcbiAgICAgIHsgc2xpY2VJZDogXCJNMDAxL1MwMVwiLCB1bml0czogMywgdG9rZW5zOiB7IGlucHV0OiA2MDAsIG91dHB1dDogMzAwLCBjYWNoZVJlYWQ6IDEwMCwgY2FjaGVXcml0ZTogNTAsIHRvdGFsOiAxMDUwIH0sIGNvc3Q6IDEuNTAsIGR1cmF0aW9uOiA0MDAwMCB9LFxuICAgICAgeyBzbGljZUlkOiBcIk0wMDEvUzAyXCIsIHVuaXRzOiAyLCB0b2tlbnM6IHsgaW5wdXQ6IDQwMCwgb3V0cHV0OiAyMDAsIGNhY2hlUmVhZDogMTAwLCBjYWNoZVdyaXRlOiA1MCwgdG90YWw6IDc1MCB9LCBjb3N0OiAxLjAwLCBkdXJhdGlvbjogMjAwMDAgfSxcbiAgICBdLFxuICAgIHJlbWFpbmluZ1NsaWNlQ291bnQ6IDMsXG4gIH0pO1xuXG4gIGNvbnN0IGxpbmVzID0gcmVuZGVyTWV0cmljc1ZpZXcoZGF0YSwgbW9ja1RoZW1lLCA4MCk7XG4gIGFzc2VydC5vayhsaW5lcy5sZW5ndGggPiAwLCBcIm1ldHJpY3MgdmlldyBwcm9kdWNlcyBvdXRwdXRcIik7XG4gIGFzc2VydC5vayhsaW5lcy5zb21lKGwgPT4gbC5pbmNsdWRlcyhcIiQyLjUwXCIpKSwgXCJzaG93cyB0b3RhbCBjb3N0XCIpO1xuICBhc3NlcnQub2sobGluZXMuc29tZShsID0+IGwuaW5jbHVkZXMoXCJleGVjdXRpb25cIikpLCBcInNob3dzIHBoYXNlIG5hbWVcIik7XG4gIGFzc2VydC5vayhsaW5lcy5zb21lKGwgPT4gbC5pbmNsdWRlcyhcImNsYXVkZS1vcHVzLTQtNlwiKSksIFwic2hvd3MgbW9kZWwgbmFtZVwiKTtcbiAgYXNzZXJ0Lm9rKGxpbmVzLnNvbWUobCA9PiBsLmluY2x1ZGVzKFwiQnkgVGllclwiKSksIFwic2hvd3MgdGllciBicmVha2Rvd24gc2VjdGlvblwiKTtcbiAgYXNzZXJ0Lm9rKGxpbmVzLnNvbWUobCA9PiBsLmluY2x1ZGVzKFwic3RhbmRhcmRcIikpLCBcInNob3dzIHRpZXIgbmFtZVwiKTtcbiAgYXNzZXJ0Lm9rKGxpbmVzLnNvbWUobCA9PiBsLmluY2x1ZGVzKFwiRHluYW1pYyByb3V0aW5nXCIpKSwgXCJzaG93cyB0aWVyIHNhdmluZ3MgbGluZVwiKTtcbiAgYXNzZXJ0Lm9rKGxpbmVzLnNvbWUobCA9PiBsLmluY2x1ZGVzKFwiVG9vbHM6IDE1XCIpKSwgXCJzaG93cyB0b29sIGNhbGwgY291bnRcIik7XG4gIGFzc2VydC5vayhsaW5lcy5zb21lKGwgPT4gbC5pbmNsdWRlcyhcIjEwXCIpICYmIGwuaW5jbHVkZXMoXCJzZW50XCIpKSwgXCJzaG93cyBtZXNzYWdlIGNvdW50c1wiKTtcbn1cblxue1xuICBjb25zdCBkYXRhID0gbWFrZVZpc3VhbGl6ZXJEYXRhKHsgdG90YWxzOiBudWxsIH0pO1xuICBjb25zdCBsaW5lcyA9IHJlbmRlck1ldHJpY3NWaWV3KGRhdGEsIG1vY2tUaGVtZSwgODApO1xuICBhc3NlcnQub2sobGluZXMuc29tZShsID0+IGwuaW5jbHVkZXMoXCJObyBtZXRyaWNzIGRhdGFcIikpLCBcInNob3dzIG5vLWRhdGEgbWVzc2FnZVwiKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHJlbmRlclRpbWVsaW5lVmlldyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuY29uc29sZS5sb2coXCJcXG49PT0gcmVuZGVyVGltZWxpbmVWaWV3ID09PVwiKTtcblxue1xuICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuICBjb25zdCBkYXRhID0gbWFrZVZpc3VhbGl6ZXJEYXRhKHtcbiAgICB1bml0czogW1xuICAgICAge1xuICAgICAgICB0eXBlOiBcImV4ZWN1dGUtdGFza1wiLFxuICAgICAgICBpZDogXCJNMDAxL1MwMS9UMDFcIixcbiAgICAgICAgbW9kZWw6IFwiY2xhdWRlLW9wdXMtNC02XCIsXG4gICAgICAgIHN0YXJ0ZWRBdDogbm93IC0gMTIwMDAwLFxuICAgICAgICBmaW5pc2hlZEF0OiBub3cgLSA2MDAwMCxcbiAgICAgICAgdG9rZW5zOiB7IGlucHV0OiA1MDAsIG91dHB1dDogMjAwLCBjYWNoZVJlYWQ6IDEwMCwgY2FjaGVXcml0ZTogNTAsIHRvdGFsOiA4NTAgfSxcbiAgICAgICAgY29zdDogMC40MixcbiAgICAgICAgdG9vbENhbGxzOiA1LFxuICAgICAgICBhc3Npc3RhbnRNZXNzYWdlczogMyxcbiAgICAgICAgdXNlck1lc3NhZ2VzOiAxLFxuICAgICAgICB0aWVyOiBcInN0YW5kYXJkXCIsXG4gICAgICB9LFxuICAgIF0sXG4gIH0pO1xuXG4gIGNvbnN0IGxpc3RMaW5lcyA9IHJlbmRlclRpbWVsaW5lVmlldyhkYXRhLCBtb2NrVGhlbWUsIDgwKTtcbiAgYXNzZXJ0Lm9rKGxpc3RMaW5lcy5sZW5ndGggPj0gMSwgXCJsaXN0IHZpZXcgcHJvZHVjZXMgbGluZXNcIik7XG4gIGFzc2VydC5vayhsaXN0TGluZXMuc29tZShsID0+IGwuaW5jbHVkZXMoXCJleGVjdXRlLXRhc2tcIikpLCBcInNob3dzIHVuaXQgdHlwZVwiKTtcbiAgYXNzZXJ0Lm9rKGxpc3RMaW5lcy5zb21lKGwgPT4gbC5pbmNsdWRlcyhcIltzdGFuZGFyZF1cIikpLCBcInNob3dzIHRpZXIgaW4gdGltZWxpbmVcIik7XG4gIGFzc2VydC5vayhsaXN0TGluZXMuc29tZShsID0+IGwuaW5jbHVkZXMoXCJvcHVzLTQtNlwiKSksIFwic2hvd3Mgc2hvcnRlbmVkIG1vZGVsXCIpO1xufVxuXG57XG4gIGNvbnN0IGRhdGEgPSBtYWtlVmlzdWFsaXplckRhdGEoeyB1bml0czogW10gfSk7XG4gIGNvbnN0IGxpbmVzID0gcmVuZGVyVGltZWxpbmVWaWV3KGRhdGEsIG1vY2tUaGVtZSwgODApO1xuICBhc3NlcnQub2sobGluZXMuc29tZShsID0+IGwuaW5jbHVkZXMoXCJObyBleGVjdXRpb24gaGlzdG9yeVwiKSksIFwic2hvd3MgZW1wdHkgbWVzc2FnZVwiKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHJlbmRlckFnZW50VmlldyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuY29uc29sZS5sb2coXCJcXG49PT0gcmVuZGVyQWdlbnRWaWV3ID09PVwiKTtcblxue1xuICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuICBjb25zdCBkYXRhID0gbWFrZVZpc3VhbGl6ZXJEYXRhKHtcbiAgICBhZ2VudEFjdGl2aXR5OiB7XG4gICAgICBjdXJyZW50VW5pdDogeyB0eXBlOiBcImV4ZWN1dGUtdGFza1wiLCBpZDogXCJNMDAxL1MwMi9UMDNcIiwgc3RhcnRlZEF0OiBub3cgLSA2MDAwMCB9LFxuICAgICAgZWxhcHNlZDogNjAwMDAsXG4gICAgICBjb21wbGV0ZWRVbml0czogOCxcbiAgICAgIHRvdGFsU2xpY2VzOiAxNSxcbiAgICAgIGNvbXBsZXRpb25SYXRlOiAyLjQsXG4gICAgICBhY3RpdmU6IHRydWUsXG4gICAgICBzZXNzaW9uQ29zdDogMS4yMyxcbiAgICAgIHNlc3Npb25Ub2tlbnM6IDQ1MjAwLFxuICAgIH0sXG4gICAgdW5pdHM6IFtcbiAgICAgIHtcbiAgICAgICAgdHlwZTogXCJleGVjdXRlLXRhc2tcIiwgaWQ6IFwiTTAwMS9TMDEvVDAxXCIsIG1vZGVsOiBcImNsYXVkZS1vcHVzLTQtNlwiLFxuICAgICAgICBzdGFydGVkQXQ6IG5vdyAtIDMwMDAwMCwgZmluaXNoZWRBdDogbm93IC0gMjQwMDAwLFxuICAgICAgICB0b2tlbnM6IHsgaW5wdXQ6IDUwMCwgb3V0cHV0OiAyMDAsIGNhY2hlUmVhZDogMTAwLCBjYWNoZVdyaXRlOiA1MCwgdG90YWw6IDg1MCB9LFxuICAgICAgICBjb3N0OiAwLjEyLCB0b29sQ2FsbHM6IDUsIGFzc2lzdGFudE1lc3NhZ2VzOiAzLCB1c2VyTWVzc2FnZXM6IDEsXG4gICAgICB9LFxuICAgIF0sXG4gICAgaGVhbHRoOiB7XG4gICAgICBidWRnZXRDZWlsaW5nOiAxMCwgdG9rZW5Qcm9maWxlOiBcInN0YW5kYXJkXCIsXG4gICAgICB0cnVuY2F0aW9uUmF0ZTogMTUuNSwgY29udGludWVIZXJlUmF0ZTogNS4wLFxuICAgICAgdGllckJyZWFrZG93bjogW10sIHRpZXJTYXZpbmdzTGluZTogXCJcIixcbiAgICAgIHRvb2xDYWxsczogMjAsIGFzc2lzdGFudE1lc3NhZ2VzOiAxNSwgdXNlck1lc3NhZ2VzOiA4LFxuICAgICAgcHJvdmlkZXJzOiBbXSxcbiAgICAgIHNraWxsU3VtbWFyeTogeyB0b3RhbDogMCwgd2FybmluZ0NvdW50OiAwLCBjcml0aWNhbENvdW50OiAwLCB0b3BJc3N1ZTogbnVsbCB9LFxuICAgICAgZW52aXJvbm1lbnRJc3N1ZXM6IFtdLFxuICAgIH0sXG4gICAgY2FwdHVyZXM6IHsgZW50cmllczogW10sIHBlbmRpbmdDb3VudDogMywgdG90YWxDb3VudDogNSB9LFxuICB9KTtcblxuICBjb25zdCBsaW5lcyA9IHJlbmRlckFnZW50VmlldyhkYXRhLCBtb2NrVGhlbWUsIDgwKTtcbiAgYXNzZXJ0Lm9rKGxpbmVzLmxlbmd0aCA+IDAsIFwiYWdlbnQgdmlldyBwcm9kdWNlcyBvdXRwdXRcIik7XG4gIGFzc2VydC5vayhsaW5lcy5zb21lKGwgPT4gbC5pbmNsdWRlcyhcIkFDVElWRVwiKSksIFwic2hvd3MgYWN0aXZlIHN0YXR1c1wiKTtcbiAgYXNzZXJ0Lm9rKGxpbmVzLnNvbWUobCA9PiBsLmluY2x1ZGVzKFwiUHJlc3N1cmVcIikpLCBcInNob3dzIHByZXNzdXJlIHNlY3Rpb25cIik7XG4gIGFzc2VydC5vayhsaW5lcy5zb21lKGwgPT4gbC5pbmNsdWRlcyhcIjE1LjUlXCIpKSwgXCJzaG93cyB0cnVuY2F0aW9uIHJhdGVcIik7XG4gIGFzc2VydC5vayhsaW5lcy5zb21lKGwgPT4gbC5pbmNsdWRlcyhcIlBlbmRpbmcgY2FwdHVyZXM6IDNcIikpLCBcInNob3dzIHBlbmRpbmcgY2FwdHVyZXNcIik7XG59XG5cbntcbiAgY29uc3QgZGF0YSA9IG1ha2VWaXN1YWxpemVyRGF0YSh7IGFnZW50QWN0aXZpdHk6IG51bGwgfSk7XG4gIGNvbnN0IGxpbmVzID0gcmVuZGVyQWdlbnRWaWV3KGRhdGEsIG1vY2tUaGVtZSwgODApO1xuICBhc3NlcnQub2sobGluZXMuc29tZShsID0+IGwuaW5jbHVkZXMoXCJObyBhZ2VudCBhY3Rpdml0eVwiKSksIFwic2hvd3Mgbm8tYWN0aXZpdHkgbWVzc2FnZVwiKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHJlbmRlckNoYW5nZWxvZ1ZpZXcgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmNvbnNvbGUubG9nKFwiXFxuPT09IHJlbmRlckNoYW5nZWxvZ1ZpZXcgPT09XCIpO1xuXG57XG4gIGNvbnN0IGRhdGEgPSBtYWtlVmlzdWFsaXplckRhdGEoe1xuICAgIGNoYW5nZWxvZzoge1xuICAgICAgZW50cmllczogW1xuICAgICAgICB7XG4gICAgICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgICAgIHNsaWNlSWQ6IFwiUzAxXCIsXG4gICAgICAgICAgdGl0bGU6IFwiQ29yZSBBdXRoZW50aWNhdGlvbiBTZXR1cFwiLFxuICAgICAgICAgIG9uZUxpbmVyOiBcIkFkZGVkIEpXVC1iYXNlZCBhdXRoIHdpdGggcmVmcmVzaCB0b2tlbiByb3RhdGlvblwiLFxuICAgICAgICAgIGZpbGVzTW9kaWZpZWQ6IFtcbiAgICAgICAgICAgIHsgcGF0aDogXCJzcmMvYXV0aC9qd3QudHNcIiwgZGVzY3JpcHRpb246IFwiSldUIHRva2VuIGdlbmVyYXRpb24gYW5kIHZhbGlkYXRpb25cIiB9LFxuICAgICAgICAgIF0sXG4gICAgICAgICAgY29tcGxldGVkQXQ6IFwiMjAyNi0wMy0xNVQxNDozMDowMFpcIixcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgfSxcbiAgICBzbGljZVZlcmlmaWNhdGlvbnM6IFtcbiAgICAgIHtcbiAgICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCBzbGljZUlkOiBcIlMwMVwiLFxuICAgICAgICB2ZXJpZmljYXRpb25SZXN1bHQ6IFwicGFzc2VkXCIsIGJsb2NrZXJEaXNjb3ZlcmVkOiBmYWxzZSxcbiAgICAgICAga2V5RGVjaXNpb25zOiBbXCJVc2UgUlMyNTYgZm9yIEpXVCBzaWduaW5nXCJdLFxuICAgICAgICBwYXR0ZXJuc0VzdGFibGlzaGVkOiBbXCJSZXBvc2l0b3J5IHBhdHRlcm4gZm9yIGRhdGEgYWNjZXNzXCJdLFxuICAgICAgICBwcm92aWRlczogW10sIHJlcXVpcmVzOiBbXSxcbiAgICAgIH0sXG4gICAgXSxcbiAgfSk7XG5cbiAgY29uc3QgbGluZXMgPSByZW5kZXJDaGFuZ2Vsb2dWaWV3KGRhdGEsIG1vY2tUaGVtZSwgODApO1xuICBhc3NlcnQub2sobGluZXMuc29tZShsID0+IGwuaW5jbHVkZXMoXCJNMDAxL1MwMVwiKSksIFwic2hvd3Mgc2xpY2UgcmVmZXJlbmNlXCIpO1xuICBhc3NlcnQub2sobGluZXMuc29tZShsID0+IGwuaW5jbHVkZXMoXCJEZWNpc2lvbnM6XCIpKSwgXCJzaG93cyBkZWNpc2lvbnMgc2VjdGlvblwiKTtcbiAgYXNzZXJ0Lm9rKGxpbmVzLnNvbWUobCA9PiBsLmluY2x1ZGVzKFwiUlMyNTZcIikpLCBcInNob3dzIGRlY2lzaW9uIGNvbnRlbnRcIik7XG4gIGFzc2VydC5vayhsaW5lcy5zb21lKGwgPT4gbC5pbmNsdWRlcyhcIlBhdHRlcm5zOlwiKSksIFwic2hvd3MgcGF0dGVybnMgc2VjdGlvblwiKTtcbiAgYXNzZXJ0Lm9rKGxpbmVzLnNvbWUobCA9PiBsLmluY2x1ZGVzKFwiUmVwb3NpdG9yeSBwYXR0ZXJuXCIpKSwgXCJzaG93cyBwYXR0ZXJuIGNvbnRlbnRcIik7XG59XG5cbntcbiAgY29uc3QgZGF0YSA9IG1ha2VWaXN1YWxpemVyRGF0YSh7IGNoYW5nZWxvZzogeyBlbnRyaWVzOiBbXSB9IH0pO1xuICBjb25zdCBsaW5lcyA9IHJlbmRlckNoYW5nZWxvZ1ZpZXcoZGF0YSwgbW9ja1RoZW1lLCA4MCk7XG4gIGFzc2VydC5vayhsaW5lcy5zb21lKGwgPT4gbC5pbmNsdWRlcyhcIk5vIGNvbXBsZXRlZCBzbGljZXNcIikpLCBcInNob3dzIGVtcHR5IHN0YXRlXCIpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgcmVuZGVyRXhwb3J0VmlldyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuY29uc29sZS5sb2coXCJcXG49PT0gcmVuZGVyRXhwb3J0VmlldyA9PT1cIik7XG5cbntcbiAgY29uc3QgZGF0YSA9IG1ha2VWaXN1YWxpemVyRGF0YSgpO1xuICBjb25zdCBsaW5lcyA9IHJlbmRlckV4cG9ydFZpZXcoZGF0YSwgbW9ja1RoZW1lLCA4MCk7XG4gIGFzc2VydC5vayhsaW5lcy5zb21lKGwgPT4gbC5pbmNsdWRlcyhcIkV4cG9ydCBPcHRpb25zXCIpKSwgXCJzaG93cyBleHBvcnQgaGVhZGVyXCIpO1xuICBhc3NlcnQub2sobGluZXMuc29tZShsID0+IGwuaW5jbHVkZXMoXCJbbV1cIikpLCBcInNob3dzIG1hcmtkb3duIG9wdGlvblwiKTtcbiAgYXNzZXJ0Lm9rKGxpbmVzLnNvbWUobCA9PiBsLmluY2x1ZGVzKFwiW2pdXCIpKSwgXCJzaG93cyBqc29uIG9wdGlvblwiKTtcbiAgYXNzZXJ0Lm9rKGxpbmVzLnNvbWUobCA9PiBsLmluY2x1ZGVzKFwiW3NdXCIpKSwgXCJzaG93cyBzbmFwc2hvdCBvcHRpb25cIik7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCByZW5kZXJLbm93bGVkZ2VWaWV3IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5jb25zb2xlLmxvZyhcIlxcbj09PSByZW5kZXJLbm93bGVkZ2VWaWV3ID09PVwiKTtcblxue1xuICBjb25zdCBkYXRhID0gbWFrZVZpc3VhbGl6ZXJEYXRhKHtcbiAgICBrbm93bGVkZ2U6IHtcbiAgICAgIGV4aXN0czogdHJ1ZSxcbiAgICAgIHJ1bGVzOiBbeyBpZDogXCJLMDAxXCIsIHNjb3BlOiBcImdsb2JhbFwiLCBjb250ZW50OiBcIkFsd2F5cyB1c2UgdHJhbnNhY3Rpb25zXCIgfV0sXG4gICAgICBwYXR0ZXJuczogW3sgaWQ6IFwiUDAwMVwiLCBjb250ZW50OiBcIlJlcG9zaXRvcnkgcGF0dGVybiBmb3IgREIgYWNjZXNzXCIgfV0sXG4gICAgICBsZXNzb25zOiBbeyBpZDogXCJMMDAxXCIsIGNvbnRlbnQ6IFwiQ2FjaGUgaW52YWxpZGF0aW9uIG5lZWRzIFRUTFwiIH1dLFxuICAgIH0sXG4gIH0pO1xuXG4gIGNvbnN0IGxpbmVzID0gcmVuZGVyS25vd2xlZGdlVmlldyhkYXRhLCBtb2NrVGhlbWUsIDgwKTtcbiAgYXNzZXJ0Lm9rKGxpbmVzLnNvbWUobCA9PiBsLmluY2x1ZGVzKFwiUnVsZXNcIikpLCBcInNob3dzIHJ1bGVzIHNlY3Rpb25cIik7XG4gIGFzc2VydC5vayhsaW5lcy5zb21lKGwgPT4gbC5pbmNsdWRlcyhcIkswMDFcIikpLCBcInNob3dzIHJ1bGUgSURcIik7XG4gIGFzc2VydC5vayhsaW5lcy5zb21lKGwgPT4gbC5pbmNsdWRlcyhcIkFsd2F5cyB1c2UgdHJhbnNhY3Rpb25zXCIpKSwgXCJzaG93cyBydWxlIGNvbnRlbnRcIik7XG4gIGFzc2VydC5vayhsaW5lcy5zb21lKGwgPT4gbC5pbmNsdWRlcyhcIlBhdHRlcm5zXCIpKSwgXCJzaG93cyBwYXR0ZXJucyBzZWN0aW9uXCIpO1xuICBhc3NlcnQub2sobGluZXMuc29tZShsID0+IGwuaW5jbHVkZXMoXCJQMDAxXCIpKSwgXCJzaG93cyBwYXR0ZXJuIElEXCIpO1xuICBhc3NlcnQub2sobGluZXMuc29tZShsID0+IGwuaW5jbHVkZXMoXCJMZXNzb25zIExlYXJuZWRcIikpLCBcInNob3dzIGxlc3NvbnMgc2VjdGlvblwiKTtcbiAgYXNzZXJ0Lm9rKGxpbmVzLnNvbWUobCA9PiBsLmluY2x1ZGVzKFwiTDAwMVwiKSksIFwic2hvd3MgbGVzc29uIElEXCIpO1xufVxuXG57XG4gIGNvbnN0IGRhdGEgPSBtYWtlVmlzdWFsaXplckRhdGEoe1xuICAgIGtub3dsZWRnZTogeyBleGlzdHM6IGZhbHNlLCBydWxlczogW10sIHBhdHRlcm5zOiBbXSwgbGVzc29uczogW10gfSxcbiAgfSk7XG4gIGNvbnN0IGxpbmVzID0gcmVuZGVyS25vd2xlZGdlVmlldyhkYXRhLCBtb2NrVGhlbWUsIDgwKTtcbiAgYXNzZXJ0Lm9rKGxpbmVzLnNvbWUobCA9PiBsLmluY2x1ZGVzKFwiTm8gS05PV0xFREdFLm1kIGZvdW5kXCIpKSwgXCJzaG93cyBuby1rbm93bGVkZ2UgbWVzc2FnZVwiKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHJlbmRlckNhcHR1cmVzVmlldyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuY29uc29sZS5sb2coXCJcXG49PT0gcmVuZGVyQ2FwdHVyZXNWaWV3ID09PVwiKTtcblxue1xuICBjb25zdCBkYXRhID0gbWFrZVZpc3VhbGl6ZXJEYXRhKHtcbiAgICBjYXB0dXJlczoge1xuICAgICAgZW50cmllczogW1xuICAgICAgICB7IGlkOiBcIkNBUC1hYmMxMjNcIiwgdGV4dDogXCJOZWVkIHRvIGFkZCBlcnJvciBoYW5kbGluZ1wiLCB0aW1lc3RhbXA6IFwiMjAyNi0wMy0xNVQxMDowMDowMFpcIiwgc3RhdHVzOiBcInBlbmRpbmdcIiwgY2xhc3NpZmljYXRpb246IFwiaW5qZWN0XCIgfSxcbiAgICAgICAgeyBpZDogXCJDQVAtZGVmNDU2XCIsIHRleHQ6IFwiQ29uc2lkZXIgY2FjaGluZyBsYXllclwiLCB0aW1lc3RhbXA6IFwiMjAyNi0wMy0xNVQxMTowMDowMFpcIiwgc3RhdHVzOiBcInRyaWFnZWRcIiwgY2xhc3NpZmljYXRpb246IFwiZGVmZXJcIiB9LFxuICAgICAgICB7IGlkOiBcIkNBUC1naGk3ODlcIiwgdGV4dDogXCJGaXhlZCB0eXBvIGluIGNvbmZpZ1wiLCB0aW1lc3RhbXA6IFwiMjAyNi0wMy0xNVQxMjowMDowMFpcIiwgc3RhdHVzOiBcInJlc29sdmVkXCIsIGNsYXNzaWZpY2F0aW9uOiBcInF1aWNrLXRhc2tcIiB9LFxuICAgICAgXSxcbiAgICAgIHBlbmRpbmdDb3VudDogMSxcbiAgICAgIHRvdGFsQ291bnQ6IDMsXG4gICAgfSxcbiAgfSk7XG5cbiAgY29uc3QgbGluZXMgPSByZW5kZXJDYXB0dXJlc1ZpZXcoZGF0YSwgbW9ja1RoZW1lLCA4MCk7XG4gIGFzc2VydC5vayhsaW5lcy5zb21lKGwgPT4gbC5pbmNsdWRlcyhcIjNcIikgJiYgbC5pbmNsdWRlcyhcInRvdGFsXCIpKSwgXCJzaG93cyB0b3RhbCBjb3VudFwiKTtcbiAgYXNzZXJ0Lm9rKGxpbmVzLnNvbWUobCA9PiBsLmluY2x1ZGVzKFwiMVwiKSAmJiBsLmluY2x1ZGVzKFwicGVuZGluZ1wiKSksIFwic2hvd3MgcGVuZGluZyBjb3VudFwiKTtcbiAgYXNzZXJ0Lm9rKGxpbmVzLnNvbWUobCA9PiBsLmluY2x1ZGVzKFwiQ0FQLWFiYzEyM1wiKSksIFwic2hvd3MgY2FwdHVyZSBJRFwiKTtcbiAgYXNzZXJ0Lm9rKGxpbmVzLnNvbWUobCA9PiBsLmluY2x1ZGVzKFwiKGluamVjdClcIikpLCBcInNob3dzIGNsYXNzaWZpY2F0aW9uIGJhZGdlXCIpO1xuICBhc3NlcnQub2sobGluZXMuc29tZShsID0+IGwuaW5jbHVkZXMoXCJbcGVuZGluZ11cIikpLCBcInNob3dzIHN0YXR1cyBiYWRnZVwiKTtcbn1cblxue1xuICBjb25zdCBkYXRhID0gbWFrZVZpc3VhbGl6ZXJEYXRhKHtcbiAgICBjYXB0dXJlczogeyBlbnRyaWVzOiBbXSwgcGVuZGluZ0NvdW50OiAwLCB0b3RhbENvdW50OiAwIH0sXG4gIH0pO1xuICBjb25zdCBsaW5lcyA9IHJlbmRlckNhcHR1cmVzVmlldyhkYXRhLCBtb2NrVGhlbWUsIDgwKTtcbiAgYXNzZXJ0Lm9rKGxpbmVzLnNvbWUobCA9PiBsLmluY2x1ZGVzKFwiTm8gY2FwdHVyZXMgcmVjb3JkZWRcIikpLCBcInNob3dzIGVtcHR5IHN0YXRlXCIpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgcmVuZGVySGVhbHRoVmlldyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuY29uc29sZS5sb2coXCJcXG49PT0gcmVuZGVySGVhbHRoVmlldyA9PT1cIik7XG5cbntcbiAgY29uc3QgZGF0YSA9IG1ha2VWaXN1YWxpemVyRGF0YSh7XG4gICAgdG90YWxzOiB7XG4gICAgICB1bml0czogMTAsIHRva2VuczogeyBpbnB1dDogNTAwMCwgb3V0cHV0OiAyMDAwLCBjYWNoZVJlYWQ6IDEwMDAsIGNhY2hlV3JpdGU6IDUwMCwgdG90YWw6IDg1MDAgfSxcbiAgICAgIGNvc3Q6IDUuMDAsIGR1cmF0aW9uOiAxMjAwMDAsIHRvb2xDYWxsczogNTAsXG4gICAgICBhc3Npc3RhbnRNZXNzYWdlczogMzAsIHVzZXJNZXNzYWdlczogMTUsXG4gICAgICB0b3RhbFRydW5jYXRpb25TZWN0aW9uczogMywgY29udGludWVIZXJlRmlyZWRDb3VudDogMSwgYXBpUmVxdWVzdHM6IDMwLFxuICAgIH0sXG4gICAgaGVhbHRoOiB7XG4gICAgICBidWRnZXRDZWlsaW5nOiAyMC4wMCxcbiAgICAgIHRva2VuUHJvZmlsZTogXCJzdGFuZGFyZFwiLFxuICAgICAgdHJ1bmNhdGlvblJhdGU6IDMwLjAsXG4gICAgICBjb250aW51ZUhlcmVSYXRlOiAxMC4wLFxuICAgICAgdGllckJyZWFrZG93bjogW1xuICAgICAgICB7IHRpZXI6IFwic3RhbmRhcmRcIiwgdW5pdHM6IDcsIHRva2VuczogeyBpbnB1dDogMzUwMCwgb3V0cHV0OiAxNDAwLCBjYWNoZVJlYWQ6IDcwMCwgY2FjaGVXcml0ZTogMzUwLCB0b3RhbDogNTk1MCB9LCBjb3N0OiAzLjUwLCBkb3duZ3JhZGVkOiAwIH0sXG4gICAgICAgIHsgdGllcjogXCJsaWdodFwiLCB1bml0czogMywgdG9rZW5zOiB7IGlucHV0OiAxNTAwLCBvdXRwdXQ6IDYwMCwgY2FjaGVSZWFkOiAzMDAsIGNhY2hlV3JpdGU6IDE1MCwgdG90YWw6IDI1NTAgfSwgY29zdDogMS41MCwgZG93bmdyYWRlZDogMiB9LFxuICAgICAgXSxcbiAgICAgIHRpZXJTYXZpbmdzTGluZTogXCJEeW5hbWljIHJvdXRpbmc6IDIvMTAgdW5pdHMgZG93bmdyYWRlZCAoMjAlKSwgY29zdDogJDEuNTBcIixcbiAgICAgIHRvb2xDYWxsczogNTAsXG4gICAgICBhc3Npc3RhbnRNZXNzYWdlczogMzAsXG4gICAgICB1c2VyTWVzc2FnZXM6IDE1LFxuICAgICAgcHJvdmlkZXJzOiBbXSxcbiAgICAgIHNraWxsU3VtbWFyeTogeyB0b3RhbDogMCwgd2FybmluZ0NvdW50OiAwLCBjcml0aWNhbENvdW50OiAwLCB0b3BJc3N1ZTogbnVsbCB9LFxuICAgICAgZW52aXJvbm1lbnRJc3N1ZXM6IFtdLFxuICAgIH0sXG4gIH0pO1xuXG4gIGNvbnN0IGxpbmVzID0gcmVuZGVySGVhbHRoVmlldyhkYXRhLCBtb2NrVGhlbWUsIDgwKTtcbiAgYXNzZXJ0Lm9rKGxpbmVzLnNvbWUobCA9PiBsLmluY2x1ZGVzKFwiQnVkZ2V0XCIpKSwgXCJzaG93cyBidWRnZXQgc2VjdGlvblwiKTtcbiAgYXNzZXJ0Lm9rKGxpbmVzLnNvbWUobCA9PiBsLmluY2x1ZGVzKFwiQ2VpbGluZ1wiKSksIFwic2hvd3MgYnVkZ2V0IGNlaWxpbmdcIik7XG4gIGFzc2VydC5vayhsaW5lcy5zb21lKGwgPT4gbC5pbmNsdWRlcyhcIiQyMC4wMFwiKSksIFwic2hvd3MgY2VpbGluZyBhbW91bnRcIik7XG4gIGFzc2VydC5vayhsaW5lcy5zb21lKGwgPT4gbC5pbmNsdWRlcyhcIlByZXNzdXJlXCIpKSwgXCJzaG93cyBwcmVzc3VyZSBzZWN0aW9uXCIpO1xuICBhc3NlcnQub2sobGluZXMuc29tZShsID0+IGwuaW5jbHVkZXMoXCIzMC4wJVwiKSksIFwic2hvd3MgdHJ1bmNhdGlvbiByYXRlXCIpO1xuICBhc3NlcnQub2sobGluZXMuc29tZShsID0+IGwuaW5jbHVkZXMoXCJSb3V0aW5nXCIpKSwgXCJzaG93cyByb3V0aW5nIHNlY3Rpb25cIik7XG4gIGFzc2VydC5vayhsaW5lcy5zb21lKGwgPT4gbC5pbmNsdWRlcyhcInN0YW5kYXJkXCIpKSwgXCJzaG93cyB0aWVyIG5hbWVcIik7XG4gIGFzc2VydC5vayhsaW5lcy5zb21lKGwgPT4gbC5pbmNsdWRlcyhcIjIgZG93bmdyYWRlZFwiKSksIFwic2hvd3MgZG93bmdyYWRlZCBjb3VudFwiKTtcbiAgYXNzZXJ0Lm9rKGxpbmVzLnNvbWUobCA9PiBsLmluY2x1ZGVzKFwiRHluYW1pYyByb3V0aW5nXCIpKSwgXCJzaG93cyBzYXZpbmdzIGxpbmVcIik7XG4gIGFzc2VydC5vayhsaW5lcy5zb21lKGwgPT4gbC5pbmNsdWRlcyhcIlNlc3Npb25cIikpLCBcInNob3dzIHNlc3Npb24gc2VjdGlvblwiKTtcbiAgYXNzZXJ0Lm9rKGxpbmVzLnNvbWUobCA9PiBsLmluY2x1ZGVzKFwiVG9vbCBjYWxsczogNTBcIikpLCBcInNob3dzIHRvb2wgY2FsbHNcIik7XG59XG5cbntcbiAgY29uc3QgZGF0YSA9IG1ha2VWaXN1YWxpemVyRGF0YSh7XG4gICAgaGVhbHRoOiB7XG4gICAgICBidWRnZXRDZWlsaW5nOiB1bmRlZmluZWQsIHRva2VuUHJvZmlsZTogXCJjb21wYWN0XCIsXG4gICAgICB0cnVuY2F0aW9uUmF0ZTogMCwgY29udGludWVIZXJlUmF0ZTogMCxcbiAgICAgIHRpZXJCcmVha2Rvd246IFtdLCB0aWVyU2F2aW5nc0xpbmU6IFwiXCIsXG4gICAgICB0b29sQ2FsbHM6IDAsIGFzc2lzdGFudE1lc3NhZ2VzOiAwLCB1c2VyTWVzc2FnZXM6IDAsXG4gICAgICBwcm92aWRlcnM6IFtdLFxuICAgICAgc2tpbGxTdW1tYXJ5OiB7IHRvdGFsOiAwLCB3YXJuaW5nQ291bnQ6IDAsIGNyaXRpY2FsQ291bnQ6IDAsIHRvcElzc3VlOiBudWxsIH0sXG4gICAgICBlbnZpcm9ubWVudElzc3VlczogW10sXG4gICAgfSxcbiAgfSk7XG5cbiAgY29uc3QgbGluZXMgPSByZW5kZXJIZWFsdGhWaWV3KGRhdGEsIG1vY2tUaGVtZSwgODApO1xuICBhc3NlcnQub2sobGluZXMuc29tZShsID0+IGwuaW5jbHVkZXMoXCJObyBidWRnZXQgY2VpbGluZyBzZXRcIikpLCBcInNob3dzIG5vLWNlaWxpbmcgbWVzc2FnZVwiKTtcbiAgYXNzZXJ0Lm9rKGxpbmVzLnNvbWUobCA9PiBsLmluY2x1ZGVzKFwiY29tcGFjdFwiKSksIFwic2hvd3MgdG9rZW4gcHJvZmlsZVwiKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFJlcG9ydCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiJdLAogICJtYXBwaW5ncyI6ICJBQUdBO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFHUCxPQUFPLFlBQVk7QUFLbkIsTUFBTSxZQUFZO0FBQUEsRUFDaEIs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
