import test from "node:test";
import assert from "node:assert/strict";
import { generateHtmlReport } from "../export-html.js";
function mockOpts(overrides = {}) {
  return {
    projectName: "TestProject",
    projectPath: "/tmp/test",
    gsdVersion: "2.28.0",
    ...overrides
  };
}
function mockTokens(input = 5e3, output = 2e3, cacheRead = 3e3, cacheWrite = 500) {
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}
function mockUnit(id, cost, startedAt, finishedAt, type = "execute-task") {
  return {
    type,
    id,
    model: "claude-sonnet-4-20250514",
    startedAt,
    finishedAt,
    tokens: mockTokens(),
    cost,
    toolCalls: 10,
    assistantMessages: 5,
    userMessages: 3
  };
}
function mockData(overrides = {}) {
  return {
    milestones: [
      {
        id: "M001",
        title: "First Milestone",
        status: "complete",
        dependsOn: [],
        slices: [
          { id: "S01", title: "Slice One", done: true, active: false, risk: "low", depends: [], tasks: [] },
          { id: "S02", title: "Slice Two", done: true, active: false, risk: "medium", depends: ["S01"], tasks: [] }
        ]
      },
      {
        id: "M002",
        title: "Second Milestone",
        status: "active",
        dependsOn: ["M001"],
        slices: [
          { id: "S01", title: "Active Slice", done: false, active: true, risk: "high", depends: [], tasks: [] },
          { id: "S02", title: "Pending Slice", done: false, active: false, risk: "low", depends: ["S01"], tasks: [] }
        ]
      }
    ],
    phase: "executing",
    totals: {
      units: 4,
      tokens: mockTokens(),
      cost: 2.5,
      duration: 36e5,
      toolCalls: 40,
      assistantMessages: 20,
      userMessages: 12,
      totalTruncationSections: 2,
      continueHereFiredCount: 1,
      apiRequests: 20
    },
    byPhase: [
      { phase: "execution", units: 4, tokens: mockTokens(), cost: 2.5, duration: 36e5 }
    ],
    bySlice: [
      { sliceId: "M001/S01", units: 2, tokens: mockTokens(), cost: 1.2, duration: 18e5 },
      { sliceId: "M001/S02", units: 2, tokens: mockTokens(), cost: 1.3, duration: 18e5 }
    ],
    byModel: [
      { model: "claude-sonnet-4-20250514", units: 4, tokens: mockTokens(), cost: 2.5 }
    ],
    byTier: [],
    tierSavingsLine: "",
    units: [
      mockUnit("M001/S01/T01", 0.5, Date.now() - 4e6, Date.now() - 3e6),
      mockUnit("M001/S01/T02", 0.7, Date.now() - 3e6, Date.now() - 2e6),
      mockUnit("M001/S02/T01", 0.6, Date.now() - 2e6, Date.now() - 1e6),
      mockUnit("M001/S02/T02", 0.7, Date.now() - 1e6, Date.now() - 5e5)
    ],
    criticalPath: {
      milestonePath: ["M001", "M002"],
      slicePath: ["S01", "S02"],
      milestoneSlack: /* @__PURE__ */ new Map(),
      sliceSlack: /* @__PURE__ */ new Map()
    },
    remainingSliceCount: 2,
    agentActivity: {
      currentUnit: { type: "execute-task", id: "M002/S01/T01", startedAt: Date.now() - 3e4 },
      elapsed: 3e4,
      completedUnits: 4,
      totalSlices: 4,
      completionRate: 2.5,
      active: true,
      sessionCost: 2.5,
      sessionTokens: 10500
    },
    changelog: { entries: [] },
    sliceVerifications: [],
    knowledge: { rules: [], patterns: [], lessons: [], exists: false },
    captures: { entries: [], pendingCount: 0, totalCount: 0 },
    health: {
      budgetCeiling: void 0,
      tokenProfile: "standard",
      truncationRate: 5,
      continueHereRate: 2,
      tierBreakdown: [],
      tierSavingsLine: "",
      toolCalls: 40,
      assistantMessages: 20,
      userMessages: 12,
      providers: [],
      skillSummary: { total: 0, warningCount: 0, criticalCount: 0, topIssue: null },
      environmentIssues: []
    },
    discussion: [],
    stats: { missingCount: 0, missingSlices: [], updatedCount: 0, updatedSlices: [], recentEntries: [] },
    ...overrides
  };
}
test("Feature 1: executive summary paragraph is rendered", () => {
  const html = generateHtmlReport(mockData(), mockOpts());
  assert.ok(html.includes('class="exec-summary"'), "should contain exec-summary class");
  assert.ok(html.includes("TestProject is"), "should contain project name in exec summary");
  assert.ok(html.includes("% complete across"), "should contain completion percentage");
  assert.ok(html.includes("milestones"), "should mention milestones");
  assert.ok(html.includes("$2.50 spent"), "should contain cost");
});
test("report uses the shared GSD HTML shell", () => {
  const html = generateHtmlReport(mockData(), mockOpts());
  assert.ok(html.includes('<span class="logo">GSD</span>'), "should render shared shell logo");
  assert.ok(html.includes('<span class="kind-chip">Report</span>'), "should render report kind chip");
  assert.ok(html.includes('<nav class="toc" aria-label="Report sections">'), "should render shared shell TOC");
  assert.ok(html.includes("<main>"), "should render content inside shared shell main");
});
test("Feature 1: executive summary includes budget context when set", () => {
  const data = mockData({ health: { ...mockData().health, budgetCeiling: 10 } });
  const html = generateHtmlReport(data, mockOpts());
  assert.ok(html.includes("Budget:"), "should include budget line");
  assert.ok(html.includes("ceiling"), "should mention ceiling");
});
test("Feature 2: ETA line is rendered when completion rate > 0", () => {
  const html = generateHtmlReport(mockData(), mockOpts());
  assert.ok(html.includes('class="eta-line"'), "should contain eta-line class");
  assert.ok(html.includes("ETA:"), "should contain ETA text");
  assert.ok(html.includes("remaining"), "should mention remaining");
  assert.ok(html.includes("2.5/hr"), "should show completion rate");
});
test("Feature 2: ETA line is skipped when rate is 0", () => {
  const data = mockData({
    agentActivity: { ...mockData().agentActivity, completionRate: 0 }
  });
  const html = generateHtmlReport(data, mockOpts());
  assert.ok(!html.includes('class="eta-line"'), "should not contain eta-line when rate is 0");
});
test("Feature 2: ETA line is skipped when no remaining slices", () => {
  const data = mockData({ remainingSliceCount: 0 });
  const html = generateHtmlReport(data, mockOpts());
  assert.ok(!html.includes('class="eta-line"'), "should not contain eta-line when no remaining slices");
});
test("Feature 3: cost efficiency metrics shown in KV grid", () => {
  const html = generateHtmlReport(mockData(), mockOpts());
  assert.ok(html.includes("Cost/slice"), "should contain Cost/slice KV");
  assert.ok(html.includes("Tokens/tool"), "should contain Tokens/tool KV");
});
test("Feature 4: cache hit ratio shown in KV grid", () => {
  const html = generateHtmlReport(mockData(), mockOpts());
  assert.ok(html.includes("Cache hit"), "should contain Cache hit KV");
  assert.ok(html.includes("37.5%"), "should show correct cache hit percentage");
});
test("Feature 4: cache hit ratio skipped when no input tokens", () => {
  const data = mockData({
    totals: {
      ...mockData().totals,
      tokens: { input: 0, output: 100, cacheRead: 0, cacheWrite: 0, total: 100 }
    }
  });
  const html = generateHtmlReport(data, mockOpts());
  assert.ok(!html.includes("Cache hit"), "should not contain Cache hit when no input/cacheRead");
});
test("Feature 15: scope shown when milestoneId is set", () => {
  const html = generateHtmlReport(mockData(), mockOpts({ milestoneId: "M001" }));
  assert.ok(html.includes("Scope"), "should contain Scope KV");
  assert.ok(html.includes("M001"), "should show milestone ID");
});
test("Feature 15: scope not shown when no milestoneId", () => {
  const html = generateHtmlReport(mockData(), mockOpts());
  assert.ok(!html.includes("Scope"), "should not contain Scope KV without milestoneId");
});
test("Feature 5: cost over time chart is rendered", () => {
  const html = generateHtmlReport(mockData(), mockOpts());
  assert.ok(html.includes('class="cost-svg"'), "should contain cost-svg class");
  assert.ok(html.includes('class="cost-line"'), "should contain cost line path");
  assert.ok(html.includes('class="cost-area"'), "should contain cost area path");
  assert.ok(html.includes("Cost over time"), "should have chart title");
});
test("Feature 5: cost over time chart skipped with < 2 units", () => {
  const data = mockData({ units: [mockUnit("M001/S01/T01", 0.5, 1e3, 2e3)] });
  const html = generateHtmlReport(data, mockOpts());
  assert.ok(!html.includes('class="cost-svg"'), "should not render cost chart with single unit");
});
test("Feature 6: duration by slice bar chart is rendered", () => {
  const html = generateHtmlReport(mockData(), mockOpts());
  assert.ok(html.includes("Duration by slice"), "should contain duration by slice chart");
});
test("Feature 7: budget burndown rendered when ceiling is set", () => {
  const data = mockData({ health: { ...mockData().health, budgetCeiling: 10 } });
  const html = generateHtmlReport(data, mockOpts());
  assert.ok(html.includes('class="burndown-wrap"'), "should contain burndown-wrap");
  assert.ok(html.includes("Budget burndown"), "should have burndown title");
  assert.ok(html.includes("burndown-spent"), "should show spent bar");
  assert.ok(html.includes("Ceiling:"), "should show ceiling in legend");
});
test("Feature 7: budget burndown skipped without ceiling", () => {
  const html = generateHtmlReport(mockData(), mockOpts());
  assert.ok(!html.includes('class="burndown-wrap"'), "should not render burndown without ceiling");
});
test("Feature 8: blockers section renders clean state", () => {
  const html = generateHtmlReport(mockData(), mockOpts());
  assert.ok(html.includes('id="blockers"'), "should contain blockers section");
  assert.ok(html.includes("blocker-card"), "should contain high-risk blocker card");
  assert.ok(html.includes("High risk"), "should flag high-risk slice");
});
test("Feature 8: blockers section renders blocker verifications", () => {
  const data = mockData({
    sliceVerifications: [
      {
        milestoneId: "M001",
        sliceId: "S01",
        verificationResult: "Tests failing on CI",
        blockerDiscovered: true,
        keyDecisions: [],
        patternsEstablished: [],
        provides: [],
        requires: []
      }
    ]
  });
  const html = generateHtmlReport(data, mockOpts());
  assert.ok(html.includes("Tests failing on CI"), "should show blocker verification text");
  assert.ok(html.includes("M001"), "should show milestone ID in blocker");
});
test("Feature 8: blockers section shows no-blockers message when clean", () => {
  const data = mockData({
    milestones: [
      {
        id: "M001",
        title: "Clean Milestone",
        status: "complete",
        dependsOn: [],
        slices: [
          { id: "S01", title: "Done", done: true, active: false, risk: "low", depends: [], tasks: [] }
        ]
      }
    ]
  });
  const html = generateHtmlReport(data, mockOpts());
  assert.ok(html.includes("No blockers or high-risk items found"), "should show clean message");
});
test("Feature 8: blockers section in TOC nav", () => {
  const html = generateHtmlReport(mockData(), mockOpts());
  assert.ok(html.includes('href="#blockers"'), "TOC should contain blockers link");
});
test("Feature 13: slice Gantt chart is rendered with timing data", () => {
  const html = generateHtmlReport(mockData(), mockOpts());
  assert.ok(html.includes('class="gantt-wrap"'), "should contain gantt-wrap");
  assert.ok(html.includes('class="gantt-svg"'), "should contain gantt-svg");
  assert.ok(html.includes("Slice timeline"), "should have Gantt title");
  assert.ok(html.includes("gantt-bar-"), "should contain gantt bars");
});
test("Feature 13: Gantt chart skipped with < 2 slices", () => {
  const data = mockData({
    units: [mockUnit("M001/S01/T01", 0.5, 1e3, 2e3)]
  });
  const html = generateHtmlReport(data, mockOpts());
  assert.ok(!html.includes('class="gantt-wrap"'), "should not render Gantt with single slice");
});
test("Feature 9: timeline filter JS is included", () => {
  const html = generateHtmlReport(mockData(), mockOpts());
  assert.ok(html.includes("tl-filter"), "should contain timeline filter class in JS");
  assert.ok(html.includes("Filter timeline"), "should contain filter placeholder text");
});
test("Feature 10: collapsible sections JS is included", () => {
  const html = generateHtmlReport(mockData(), mockOpts());
  assert.ok(html.includes("sec-toggle"), "should contain section toggle class");
  assert.ok(html.includes("gsd-collapsed"), "should reference localStorage key for collapsed state");
});
test("Feature 11: dark/light theme toggle JS is included", () => {
  const html = generateHtmlReport(mockData(), mockOpts());
  assert.ok(html.includes("theme-toggle"), "should contain theme toggle class");
  assert.ok(html.includes("gsd-theme"), "should reference localStorage key for theme");
  assert.ok(html.includes("light-theme"), "should reference light-theme class");
});
test("Feature 12: responsive media queries are included", () => {
  const html = generateHtmlReport(mockData(), mockOpts());
  assert.ok(html.includes("max-width:768px"), "should contain 768px breakpoint");
  assert.ok(html.includes("max-width:480px"), "should contain 480px breakpoint");
});
test("Edge: no totals data renders without crash", () => {
  const data = mockData({ totals: null, units: [], byPhase: [], bySlice: [], byModel: [] });
  const html = generateHtmlReport(data, mockOpts());
  assert.ok(html.includes('id="summary"'), "should render summary section");
  assert.ok(html.includes('id="metrics"'), "should render metrics section");
  assert.ok(!html.includes("Cost/slice"), "should not show cost/slice without totals");
});
test("Edge: zero completion rate and zero remaining slices", () => {
  const data = mockData({
    agentActivity: null,
    remainingSliceCount: 0
  });
  const html = generateHtmlReport(data, mockOpts());
  assert.ok(!html.includes('class="eta-line"'), "no ETA line with null activity");
  assert.ok(html.includes('id="summary"'), "summary still renders");
});
test("Edge: empty milestones array", () => {
  const data = mockData({ milestones: [] });
  const html = generateHtmlReport(data, mockOpts());
  assert.ok(html.includes("0% complete across 0 milestones"), "should show 0% completion");
});
test("Edge: light theme CSS variables are defined", () => {
  const html = generateHtmlReport(mockData(), mockOpts());
  assert.ok(html.includes(".light-theme{"), "should include light-theme CSS rule");
  assert.ok(html.includes("--bg-0:#fff"), "should override bg-0 in light theme");
});
test("Edge: print media query still present", () => {
  const html = generateHtmlReport(mockData(), mockOpts());
  assert.ok(html.includes("@media print"), "should still contain print media query");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9leHBvcnQtaHRtbC1lbmhhbmNlbWVudHMudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBnZW5lcmF0ZUh0bWxSZXBvcnQsIHR5cGUgSHRtbFJlcG9ydE9wdGlvbnMgfSBmcm9tIFwiLi4vZXhwb3J0LWh0bWwuanNcIjtcbmltcG9ydCB0eXBlIHsgVmlzdWFsaXplckRhdGEgfSBmcm9tIFwiLi4vdmlzdWFsaXplci1kYXRhLmpzXCI7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBNb2NrIERhdGEgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIG1vY2tPcHRzKG92ZXJyaWRlczogUGFydGlhbDxIdG1sUmVwb3J0T3B0aW9ucz4gPSB7fSk6IEh0bWxSZXBvcnRPcHRpb25zIHtcbiAgcmV0dXJuIHtcbiAgICBwcm9qZWN0TmFtZTogXCJUZXN0UHJvamVjdFwiLFxuICAgIHByb2plY3RQYXRoOiBcIi90bXAvdGVzdFwiLFxuICAgIGdzZFZlcnNpb246IFwiMi4yOC4wXCIsXG4gICAgLi4ub3ZlcnJpZGVzLFxuICB9O1xufVxuXG5mdW5jdGlvbiBtb2NrVG9rZW5zKGlucHV0ID0gNTAwMCwgb3V0cHV0ID0gMjAwMCwgY2FjaGVSZWFkID0gMzAwMCwgY2FjaGVXcml0ZSA9IDUwMCkge1xuICByZXR1cm4geyBpbnB1dCwgb3V0cHV0LCBjYWNoZVJlYWQsIGNhY2hlV3JpdGUsIHRvdGFsOiBpbnB1dCArIG91dHB1dCArIGNhY2hlUmVhZCArIGNhY2hlV3JpdGUgfTtcbn1cblxuZnVuY3Rpb24gbW9ja1VuaXQoaWQ6IHN0cmluZywgY29zdDogbnVtYmVyLCBzdGFydGVkQXQ6IG51bWJlciwgZmluaXNoZWRBdDogbnVtYmVyLCB0eXBlID0gXCJleGVjdXRlLXRhc2tcIikge1xuICByZXR1cm4ge1xuICAgIHR5cGUsXG4gICAgaWQsXG4gICAgbW9kZWw6IFwiY2xhdWRlLXNvbm5ldC00LTIwMjUwNTE0XCIsXG4gICAgc3RhcnRlZEF0LFxuICAgIGZpbmlzaGVkQXQsXG4gICAgdG9rZW5zOiBtb2NrVG9rZW5zKCksXG4gICAgY29zdCxcbiAgICB0b29sQ2FsbHM6IDEwLFxuICAgIGFzc2lzdGFudE1lc3NhZ2VzOiA1LFxuICAgIHVzZXJNZXNzYWdlczogMyxcbiAgfTtcbn1cblxuZnVuY3Rpb24gbW9ja0RhdGEob3ZlcnJpZGVzOiBQYXJ0aWFsPFZpc3VhbGl6ZXJEYXRhPiA9IHt9KTogVmlzdWFsaXplckRhdGEge1xuICByZXR1cm4ge1xuICAgIG1pbGVzdG9uZXM6IFtcbiAgICAgIHtcbiAgICAgICAgaWQ6IFwiTTAwMVwiLFxuICAgICAgICB0aXRsZTogXCJGaXJzdCBNaWxlc3RvbmVcIixcbiAgICAgICAgc3RhdHVzOiBcImNvbXBsZXRlXCIsXG4gICAgICAgIGRlcGVuZHNPbjogW10sXG4gICAgICAgIHNsaWNlczogW1xuICAgICAgICAgIHsgaWQ6IFwiUzAxXCIsIHRpdGxlOiBcIlNsaWNlIE9uZVwiLCBkb25lOiB0cnVlLCBhY3RpdmU6IGZhbHNlLCByaXNrOiBcImxvd1wiLCBkZXBlbmRzOiBbXSwgdGFza3M6IFtdIH0sXG4gICAgICAgICAgeyBpZDogXCJTMDJcIiwgdGl0bGU6IFwiU2xpY2UgVHdvXCIsIGRvbmU6IHRydWUsIGFjdGl2ZTogZmFsc2UsIHJpc2s6IFwibWVkaXVtXCIsIGRlcGVuZHM6IFtcIlMwMVwiXSwgdGFza3M6IFtdIH0sXG4gICAgICAgIF0sXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBpZDogXCJNMDAyXCIsXG4gICAgICAgIHRpdGxlOiBcIlNlY29uZCBNaWxlc3RvbmVcIixcbiAgICAgICAgc3RhdHVzOiBcImFjdGl2ZVwiLFxuICAgICAgICBkZXBlbmRzT246IFtcIk0wMDFcIl0sXG4gICAgICAgIHNsaWNlczogW1xuICAgICAgICAgIHsgaWQ6IFwiUzAxXCIsIHRpdGxlOiBcIkFjdGl2ZSBTbGljZVwiLCBkb25lOiBmYWxzZSwgYWN0aXZlOiB0cnVlLCByaXNrOiBcImhpZ2hcIiwgZGVwZW5kczogW10sIHRhc2tzOiBbXSB9LFxuICAgICAgICAgIHsgaWQ6IFwiUzAyXCIsIHRpdGxlOiBcIlBlbmRpbmcgU2xpY2VcIiwgZG9uZTogZmFsc2UsIGFjdGl2ZTogZmFsc2UsIHJpc2s6IFwibG93XCIsIGRlcGVuZHM6IFtcIlMwMVwiXSwgdGFza3M6IFtdIH0sXG4gICAgICAgIF0sXG4gICAgICB9LFxuICAgIF0sXG4gICAgcGhhc2U6IFwiZXhlY3V0aW5nXCIsXG4gICAgdG90YWxzOiB7XG4gICAgICB1bml0czogNCxcbiAgICAgIHRva2VuczogbW9ja1Rva2VucygpLFxuICAgICAgY29zdDogMi41MCxcbiAgICAgIGR1cmF0aW9uOiAzXzYwMF8wMDAsXG4gICAgICB0b29sQ2FsbHM6IDQwLFxuICAgICAgYXNzaXN0YW50TWVzc2FnZXM6IDIwLFxuICAgICAgdXNlck1lc3NhZ2VzOiAxMixcbiAgICAgIHRvdGFsVHJ1bmNhdGlvblNlY3Rpb25zOiAyLFxuICAgICAgY29udGludWVIZXJlRmlyZWRDb3VudDogMSxcbiAgICAgIGFwaVJlcXVlc3RzOiAyMCxcbiAgICB9LFxuICAgIGJ5UGhhc2U6IFtcbiAgICAgIHsgcGhhc2U6IFwiZXhlY3V0aW9uXCIsIHVuaXRzOiA0LCB0b2tlbnM6IG1vY2tUb2tlbnMoKSwgY29zdDogMi41MCwgZHVyYXRpb246IDNfNjAwXzAwMCB9LFxuICAgIF0sXG4gICAgYnlTbGljZTogW1xuICAgICAgeyBzbGljZUlkOiBcIk0wMDEvUzAxXCIsIHVuaXRzOiAyLCB0b2tlbnM6IG1vY2tUb2tlbnMoKSwgY29zdDogMS4yMCwgZHVyYXRpb246IDFfODAwXzAwMCB9LFxuICAgICAgeyBzbGljZUlkOiBcIk0wMDEvUzAyXCIsIHVuaXRzOiAyLCB0b2tlbnM6IG1vY2tUb2tlbnMoKSwgY29zdDogMS4zMCwgZHVyYXRpb246IDFfODAwXzAwMCB9LFxuICAgIF0sXG4gICAgYnlNb2RlbDogW1xuICAgICAgeyBtb2RlbDogXCJjbGF1ZGUtc29ubmV0LTQtMjAyNTA1MTRcIiwgdW5pdHM6IDQsIHRva2VuczogbW9ja1Rva2VucygpLCBjb3N0OiAyLjUwIH0sXG4gICAgXSxcbiAgICBieVRpZXI6IFtdLFxuICAgIHRpZXJTYXZpbmdzTGluZTogXCJcIixcbiAgICB1bml0czogW1xuICAgICAgbW9ja1VuaXQoXCJNMDAxL1MwMS9UMDFcIiwgMC41MCwgRGF0ZS5ub3coKSAtIDRfMDAwXzAwMCwgRGF0ZS5ub3coKSAtIDNfMDAwXzAwMCksXG4gICAgICBtb2NrVW5pdChcIk0wMDEvUzAxL1QwMlwiLCAwLjcwLCBEYXRlLm5vdygpIC0gM18wMDBfMDAwLCBEYXRlLm5vdygpIC0gMl8wMDBfMDAwKSxcbiAgICAgIG1vY2tVbml0KFwiTTAwMS9TMDIvVDAxXCIsIDAuNjAsIERhdGUubm93KCkgLSAyXzAwMF8wMDAsIERhdGUubm93KCkgLSAxXzAwMF8wMDApLFxuICAgICAgbW9ja1VuaXQoXCJNMDAxL1MwMi9UMDJcIiwgMC43MCwgRGF0ZS5ub3coKSAtIDFfMDAwXzAwMCwgRGF0ZS5ub3coKSAtIDUwMF8wMDApLFxuICAgIF0sXG4gICAgY3JpdGljYWxQYXRoOiB7XG4gICAgICBtaWxlc3RvbmVQYXRoOiBbXCJNMDAxXCIsIFwiTTAwMlwiXSxcbiAgICAgIHNsaWNlUGF0aDogW1wiUzAxXCIsIFwiUzAyXCJdLFxuICAgICAgbWlsZXN0b25lU2xhY2s6IG5ldyBNYXAoKSxcbiAgICAgIHNsaWNlU2xhY2s6IG5ldyBNYXAoKSxcbiAgICB9LFxuICAgIHJlbWFpbmluZ1NsaWNlQ291bnQ6IDIsXG4gICAgYWdlbnRBY3Rpdml0eToge1xuICAgICAgY3VycmVudFVuaXQ6IHsgdHlwZTogXCJleGVjdXRlLXRhc2tcIiwgaWQ6IFwiTTAwMi9TMDEvVDAxXCIsIHN0YXJ0ZWRBdDogRGF0ZS5ub3coKSAtIDMwXzAwMCB9LFxuICAgICAgZWxhcHNlZDogMzBfMDAwLFxuICAgICAgY29tcGxldGVkVW5pdHM6IDQsXG4gICAgICB0b3RhbFNsaWNlczogNCxcbiAgICAgIGNvbXBsZXRpb25SYXRlOiAyLjUsXG4gICAgICBhY3RpdmU6IHRydWUsXG4gICAgICBzZXNzaW9uQ29zdDogMi41MCxcbiAgICAgIHNlc3Npb25Ub2tlbnM6IDEwXzUwMCxcbiAgICB9LFxuICAgIGNoYW5nZWxvZzogeyBlbnRyaWVzOiBbXSB9LFxuICAgIHNsaWNlVmVyaWZpY2F0aW9uczogW10sXG4gICAga25vd2xlZGdlOiB7IHJ1bGVzOiBbXSwgcGF0dGVybnM6IFtdLCBsZXNzb25zOiBbXSwgZXhpc3RzOiBmYWxzZSB9LFxuICAgIGNhcHR1cmVzOiB7IGVudHJpZXM6IFtdLCBwZW5kaW5nQ291bnQ6IDAsIHRvdGFsQ291bnQ6IDAgfSxcbiAgICBoZWFsdGg6IHtcbiAgICAgIGJ1ZGdldENlaWxpbmc6IHVuZGVmaW5lZCxcbiAgICAgIHRva2VuUHJvZmlsZTogXCJzdGFuZGFyZFwiLFxuICAgICAgdHJ1bmNhdGlvblJhdGU6IDUuMCxcbiAgICAgIGNvbnRpbnVlSGVyZVJhdGU6IDIuMCxcbiAgICAgIHRpZXJCcmVha2Rvd246IFtdLFxuICAgICAgdGllclNhdmluZ3NMaW5lOiBcIlwiLFxuICAgICAgdG9vbENhbGxzOiA0MCxcbiAgICAgIGFzc2lzdGFudE1lc3NhZ2VzOiAyMCxcbiAgICAgIHVzZXJNZXNzYWdlczogMTIsXG4gICAgICBwcm92aWRlcnM6IFtdLFxuICAgICAgc2tpbGxTdW1tYXJ5OiB7IHRvdGFsOiAwLCB3YXJuaW5nQ291bnQ6IDAsIGNyaXRpY2FsQ291bnQ6IDAsIHRvcElzc3VlOiBudWxsIH0sXG4gICAgICBlbnZpcm9ubWVudElzc3VlczogW10sXG5cbiAgICB9LFxuICAgIGRpc2N1c3Npb246IFtdLFxuICAgIHN0YXRzOiB7IG1pc3NpbmdDb3VudDogMCwgbWlzc2luZ1NsaWNlczogW10sIHVwZGF0ZWRDb3VudDogMCwgdXBkYXRlZFNsaWNlczogW10sIHJlY2VudEVudHJpZXM6IFtdIH0sXG4gICAgLi4ub3ZlcnJpZGVzLFxuICB9O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgV2F2ZSAxOiBTdW1tYXJ5IEVuaGFuY2VtZW50cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcIkZlYXR1cmUgMTogZXhlY3V0aXZlIHN1bW1hcnkgcGFyYWdyYXBoIGlzIHJlbmRlcmVkXCIsICgpID0+IHtcbiAgY29uc3QgaHRtbCA9IGdlbmVyYXRlSHRtbFJlcG9ydChtb2NrRGF0YSgpLCBtb2NrT3B0cygpKTtcbiAgYXNzZXJ0Lm9rKGh0bWwuaW5jbHVkZXMoJ2NsYXNzPVwiZXhlYy1zdW1tYXJ5XCInKSwgXCJzaG91bGQgY29udGFpbiBleGVjLXN1bW1hcnkgY2xhc3NcIik7XG4gIGFzc2VydC5vayhodG1sLmluY2x1ZGVzKFwiVGVzdFByb2plY3QgaXNcIiksIFwic2hvdWxkIGNvbnRhaW4gcHJvamVjdCBuYW1lIGluIGV4ZWMgc3VtbWFyeVwiKTtcbiAgYXNzZXJ0Lm9rKGh0bWwuaW5jbHVkZXMoXCIlIGNvbXBsZXRlIGFjcm9zc1wiKSwgXCJzaG91bGQgY29udGFpbiBjb21wbGV0aW9uIHBlcmNlbnRhZ2VcIik7XG4gIGFzc2VydC5vayhodG1sLmluY2x1ZGVzKFwibWlsZXN0b25lc1wiKSwgXCJzaG91bGQgbWVudGlvbiBtaWxlc3RvbmVzXCIpO1xuICBhc3NlcnQub2soaHRtbC5pbmNsdWRlcyhcIiQyLjUwIHNwZW50XCIpLCBcInNob3VsZCBjb250YWluIGNvc3RcIik7XG59KTtcblxudGVzdChcInJlcG9ydCB1c2VzIHRoZSBzaGFyZWQgR1NEIEhUTUwgc2hlbGxcIiwgKCkgPT4ge1xuICBjb25zdCBodG1sID0gZ2VuZXJhdGVIdG1sUmVwb3J0KG1vY2tEYXRhKCksIG1vY2tPcHRzKCkpO1xuICBhc3NlcnQub2soaHRtbC5pbmNsdWRlcygnPHNwYW4gY2xhc3M9XCJsb2dvXCI+R1NEPC9zcGFuPicpLCBcInNob3VsZCByZW5kZXIgc2hhcmVkIHNoZWxsIGxvZ29cIik7XG4gIGFzc2VydC5vayhodG1sLmluY2x1ZGVzKCc8c3BhbiBjbGFzcz1cImtpbmQtY2hpcFwiPlJlcG9ydDwvc3Bhbj4nKSwgXCJzaG91bGQgcmVuZGVyIHJlcG9ydCBraW5kIGNoaXBcIik7XG4gIGFzc2VydC5vayhodG1sLmluY2x1ZGVzKCc8bmF2IGNsYXNzPVwidG9jXCIgYXJpYS1sYWJlbD1cIlJlcG9ydCBzZWN0aW9uc1wiPicpLCBcInNob3VsZCByZW5kZXIgc2hhcmVkIHNoZWxsIFRPQ1wiKTtcbiAgYXNzZXJ0Lm9rKGh0bWwuaW5jbHVkZXMoJzxtYWluPicpLCBcInNob3VsZCByZW5kZXIgY29udGVudCBpbnNpZGUgc2hhcmVkIHNoZWxsIG1haW5cIik7XG59KTtcblxudGVzdChcIkZlYXR1cmUgMTogZXhlY3V0aXZlIHN1bW1hcnkgaW5jbHVkZXMgYnVkZ2V0IGNvbnRleHQgd2hlbiBzZXRcIiwgKCkgPT4ge1xuICBjb25zdCBkYXRhID0gbW9ja0RhdGEoeyBoZWFsdGg6IHsgLi4ubW9ja0RhdGEoKS5oZWFsdGgsIGJ1ZGdldENlaWxpbmc6IDEwLjAwIH0gfSk7XG4gIGNvbnN0IGh0bWwgPSBnZW5lcmF0ZUh0bWxSZXBvcnQoZGF0YSwgbW9ja09wdHMoKSk7XG4gIGFzc2VydC5vayhodG1sLmluY2x1ZGVzKFwiQnVkZ2V0OlwiKSwgXCJzaG91bGQgaW5jbHVkZSBidWRnZXQgbGluZVwiKTtcbiAgYXNzZXJ0Lm9rKGh0bWwuaW5jbHVkZXMoXCJjZWlsaW5nXCIpLCBcInNob3VsZCBtZW50aW9uIGNlaWxpbmdcIik7XG59KTtcblxudGVzdChcIkZlYXR1cmUgMjogRVRBIGxpbmUgaXMgcmVuZGVyZWQgd2hlbiBjb21wbGV0aW9uIHJhdGUgPiAwXCIsICgpID0+IHtcbiAgY29uc3QgaHRtbCA9IGdlbmVyYXRlSHRtbFJlcG9ydChtb2NrRGF0YSgpLCBtb2NrT3B0cygpKTtcbiAgYXNzZXJ0Lm9rKGh0bWwuaW5jbHVkZXMoJ2NsYXNzPVwiZXRhLWxpbmVcIicpLCBcInNob3VsZCBjb250YWluIGV0YS1saW5lIGNsYXNzXCIpO1xuICBhc3NlcnQub2soaHRtbC5pbmNsdWRlcyhcIkVUQTpcIiksIFwic2hvdWxkIGNvbnRhaW4gRVRBIHRleHRcIik7XG4gIGFzc2VydC5vayhodG1sLmluY2x1ZGVzKFwicmVtYWluaW5nXCIpLCBcInNob3VsZCBtZW50aW9uIHJlbWFpbmluZ1wiKTtcbiAgYXNzZXJ0Lm9rKGh0bWwuaW5jbHVkZXMoXCIyLjUvaHJcIiksIFwic2hvdWxkIHNob3cgY29tcGxldGlvbiByYXRlXCIpO1xufSk7XG5cbnRlc3QoXCJGZWF0dXJlIDI6IEVUQSBsaW5lIGlzIHNraXBwZWQgd2hlbiByYXRlIGlzIDBcIiwgKCkgPT4ge1xuICBjb25zdCBkYXRhID0gbW9ja0RhdGEoe1xuICAgIGFnZW50QWN0aXZpdHk6IHsgLi4ubW9ja0RhdGEoKS5hZ2VudEFjdGl2aXR5ISwgY29tcGxldGlvblJhdGU6IDAgfSxcbiAgfSk7XG4gIGNvbnN0IGh0bWwgPSBnZW5lcmF0ZUh0bWxSZXBvcnQoZGF0YSwgbW9ja09wdHMoKSk7XG4gIGFzc2VydC5vayghaHRtbC5pbmNsdWRlcygnY2xhc3M9XCJldGEtbGluZVwiJyksIFwic2hvdWxkIG5vdCBjb250YWluIGV0YS1saW5lIHdoZW4gcmF0ZSBpcyAwXCIpO1xufSk7XG5cbnRlc3QoXCJGZWF0dXJlIDI6IEVUQSBsaW5lIGlzIHNraXBwZWQgd2hlbiBubyByZW1haW5pbmcgc2xpY2VzXCIsICgpID0+IHtcbiAgY29uc3QgZGF0YSA9IG1vY2tEYXRhKHsgcmVtYWluaW5nU2xpY2VDb3VudDogMCB9KTtcbiAgY29uc3QgaHRtbCA9IGdlbmVyYXRlSHRtbFJlcG9ydChkYXRhLCBtb2NrT3B0cygpKTtcbiAgYXNzZXJ0Lm9rKCFodG1sLmluY2x1ZGVzKCdjbGFzcz1cImV0YS1saW5lXCInKSwgXCJzaG91bGQgbm90IGNvbnRhaW4gZXRhLWxpbmUgd2hlbiBubyByZW1haW5pbmcgc2xpY2VzXCIpO1xufSk7XG5cbnRlc3QoXCJGZWF0dXJlIDM6IGNvc3QgZWZmaWNpZW5jeSBtZXRyaWNzIHNob3duIGluIEtWIGdyaWRcIiwgKCkgPT4ge1xuICBjb25zdCBodG1sID0gZ2VuZXJhdGVIdG1sUmVwb3J0KG1vY2tEYXRhKCksIG1vY2tPcHRzKCkpO1xuICBhc3NlcnQub2soaHRtbC5pbmNsdWRlcyhcIkNvc3Qvc2xpY2VcIiksIFwic2hvdWxkIGNvbnRhaW4gQ29zdC9zbGljZSBLVlwiKTtcbiAgYXNzZXJ0Lm9rKGh0bWwuaW5jbHVkZXMoXCJUb2tlbnMvdG9vbFwiKSwgXCJzaG91bGQgY29udGFpbiBUb2tlbnMvdG9vbCBLVlwiKTtcbn0pO1xuXG50ZXN0KFwiRmVhdHVyZSA0OiBjYWNoZSBoaXQgcmF0aW8gc2hvd24gaW4gS1YgZ3JpZFwiLCAoKSA9PiB7XG4gIGNvbnN0IGh0bWwgPSBnZW5lcmF0ZUh0bWxSZXBvcnQobW9ja0RhdGEoKSwgbW9ja09wdHMoKSk7XG4gIGFzc2VydC5vayhodG1sLmluY2x1ZGVzKFwiQ2FjaGUgaGl0XCIpLCBcInNob3VsZCBjb250YWluIENhY2hlIGhpdCBLVlwiKTtcbiAgLy8gMzAwMCAvICg1MDAwICsgMzAwMCkgPSAzNy41JVxuICBhc3NlcnQub2soaHRtbC5pbmNsdWRlcyhcIjM3LjUlXCIpLCBcInNob3VsZCBzaG93IGNvcnJlY3QgY2FjaGUgaGl0IHBlcmNlbnRhZ2VcIik7XG59KTtcblxudGVzdChcIkZlYXR1cmUgNDogY2FjaGUgaGl0IHJhdGlvIHNraXBwZWQgd2hlbiBubyBpbnB1dCB0b2tlbnNcIiwgKCkgPT4ge1xuICBjb25zdCBkYXRhID0gbW9ja0RhdGEoe1xuICAgIHRvdGFsczoge1xuICAgICAgLi4ubW9ja0RhdGEoKS50b3RhbHMhLFxuICAgICAgdG9rZW5zOiB7IGlucHV0OiAwLCBvdXRwdXQ6IDEwMCwgY2FjaGVSZWFkOiAwLCBjYWNoZVdyaXRlOiAwLCB0b3RhbDogMTAwIH0sXG4gICAgfSxcbiAgfSk7XG4gIGNvbnN0IGh0bWwgPSBnZW5lcmF0ZUh0bWxSZXBvcnQoZGF0YSwgbW9ja09wdHMoKSk7XG4gIGFzc2VydC5vayghaHRtbC5pbmNsdWRlcyhcIkNhY2hlIGhpdFwiKSwgXCJzaG91bGQgbm90IGNvbnRhaW4gQ2FjaGUgaGl0IHdoZW4gbm8gaW5wdXQvY2FjaGVSZWFkXCIpO1xufSk7XG5cbnRlc3QoXCJGZWF0dXJlIDE1OiBzY29wZSBzaG93biB3aGVuIG1pbGVzdG9uZUlkIGlzIHNldFwiLCAoKSA9PiB7XG4gIGNvbnN0IGh0bWwgPSBnZW5lcmF0ZUh0bWxSZXBvcnQobW9ja0RhdGEoKSwgbW9ja09wdHMoeyBtaWxlc3RvbmVJZDogXCJNMDAxXCIgfSkpO1xuICBhc3NlcnQub2soaHRtbC5pbmNsdWRlcyhcIlNjb3BlXCIpLCBcInNob3VsZCBjb250YWluIFNjb3BlIEtWXCIpO1xuICBhc3NlcnQub2soaHRtbC5pbmNsdWRlcyhcIk0wMDFcIiksIFwic2hvdWxkIHNob3cgbWlsZXN0b25lIElEXCIpO1xufSk7XG5cbnRlc3QoXCJGZWF0dXJlIDE1OiBzY29wZSBub3Qgc2hvd24gd2hlbiBubyBtaWxlc3RvbmVJZFwiLCAoKSA9PiB7XG4gIGNvbnN0IGh0bWwgPSBnZW5lcmF0ZUh0bWxSZXBvcnQobW9ja0RhdGEoKSwgbW9ja09wdHMoKSk7XG4gIGFzc2VydC5vayghaHRtbC5pbmNsdWRlcyhcIlNjb3BlXCIpLCBcInNob3VsZCBub3QgY29udGFpbiBTY29wZSBLViB3aXRob3V0IG1pbGVzdG9uZUlkXCIpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBXYXZlIDI6IE1ldHJpY3MgRW5oYW5jZW1lbnRzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiRmVhdHVyZSA1OiBjb3N0IG92ZXIgdGltZSBjaGFydCBpcyByZW5kZXJlZFwiLCAoKSA9PiB7XG4gIGNvbnN0IGh0bWwgPSBnZW5lcmF0ZUh0bWxSZXBvcnQobW9ja0RhdGEoKSwgbW9ja09wdHMoKSk7XG4gIGFzc2VydC5vayhodG1sLmluY2x1ZGVzKCdjbGFzcz1cImNvc3Qtc3ZnXCInKSwgXCJzaG91bGQgY29udGFpbiBjb3N0LXN2ZyBjbGFzc1wiKTtcbiAgYXNzZXJ0Lm9rKGh0bWwuaW5jbHVkZXMoJ2NsYXNzPVwiY29zdC1saW5lXCInKSwgXCJzaG91bGQgY29udGFpbiBjb3N0IGxpbmUgcGF0aFwiKTtcbiAgYXNzZXJ0Lm9rKGh0bWwuaW5jbHVkZXMoJ2NsYXNzPVwiY29zdC1hcmVhXCInKSwgXCJzaG91bGQgY29udGFpbiBjb3N0IGFyZWEgcGF0aFwiKTtcbiAgYXNzZXJ0Lm9rKGh0bWwuaW5jbHVkZXMoXCJDb3N0IG92ZXIgdGltZVwiKSwgXCJzaG91bGQgaGF2ZSBjaGFydCB0aXRsZVwiKTtcbn0pO1xuXG50ZXN0KFwiRmVhdHVyZSA1OiBjb3N0IG92ZXIgdGltZSBjaGFydCBza2lwcGVkIHdpdGggPCAyIHVuaXRzXCIsICgpID0+IHtcbiAgY29uc3QgZGF0YSA9IG1vY2tEYXRhKHsgdW5pdHM6IFttb2NrVW5pdChcIk0wMDEvUzAxL1QwMVwiLCAwLjUwLCAxMDAwLCAyMDAwKV0gfSk7XG4gIGNvbnN0IGh0bWwgPSBnZW5lcmF0ZUh0bWxSZXBvcnQoZGF0YSwgbW9ja09wdHMoKSk7XG4gIGFzc2VydC5vayghaHRtbC5pbmNsdWRlcygnY2xhc3M9XCJjb3N0LXN2Z1wiJyksIFwic2hvdWxkIG5vdCByZW5kZXIgY29zdCBjaGFydCB3aXRoIHNpbmdsZSB1bml0XCIpO1xufSk7XG5cbnRlc3QoXCJGZWF0dXJlIDY6IGR1cmF0aW9uIGJ5IHNsaWNlIGJhciBjaGFydCBpcyByZW5kZXJlZFwiLCAoKSA9PiB7XG4gIGNvbnN0IGh0bWwgPSBnZW5lcmF0ZUh0bWxSZXBvcnQobW9ja0RhdGEoKSwgbW9ja09wdHMoKSk7XG4gIGFzc2VydC5vayhodG1sLmluY2x1ZGVzKFwiRHVyYXRpb24gYnkgc2xpY2VcIiksIFwic2hvdWxkIGNvbnRhaW4gZHVyYXRpb24gYnkgc2xpY2UgY2hhcnRcIik7XG59KTtcblxudGVzdChcIkZlYXR1cmUgNzogYnVkZ2V0IGJ1cm5kb3duIHJlbmRlcmVkIHdoZW4gY2VpbGluZyBpcyBzZXRcIiwgKCkgPT4ge1xuICBjb25zdCBkYXRhID0gbW9ja0RhdGEoeyBoZWFsdGg6IHsgLi4ubW9ja0RhdGEoKS5oZWFsdGgsIGJ1ZGdldENlaWxpbmc6IDEwLjAwIH0gfSk7XG4gIGNvbnN0IGh0bWwgPSBnZW5lcmF0ZUh0bWxSZXBvcnQoZGF0YSwgbW9ja09wdHMoKSk7XG4gIGFzc2VydC5vayhodG1sLmluY2x1ZGVzKCdjbGFzcz1cImJ1cm5kb3duLXdyYXBcIicpLCBcInNob3VsZCBjb250YWluIGJ1cm5kb3duLXdyYXBcIik7XG4gIGFzc2VydC5vayhodG1sLmluY2x1ZGVzKFwiQnVkZ2V0IGJ1cm5kb3duXCIpLCBcInNob3VsZCBoYXZlIGJ1cm5kb3duIHRpdGxlXCIpO1xuICBhc3NlcnQub2soaHRtbC5pbmNsdWRlcyhcImJ1cm5kb3duLXNwZW50XCIpLCBcInNob3VsZCBzaG93IHNwZW50IGJhclwiKTtcbiAgYXNzZXJ0Lm9rKGh0bWwuaW5jbHVkZXMoXCJDZWlsaW5nOlwiKSwgXCJzaG91bGQgc2hvdyBjZWlsaW5nIGluIGxlZ2VuZFwiKTtcbn0pO1xuXG50ZXN0KFwiRmVhdHVyZSA3OiBidWRnZXQgYnVybmRvd24gc2tpcHBlZCB3aXRob3V0IGNlaWxpbmdcIiwgKCkgPT4ge1xuICBjb25zdCBodG1sID0gZ2VuZXJhdGVIdG1sUmVwb3J0KG1vY2tEYXRhKCksIG1vY2tPcHRzKCkpO1xuICBhc3NlcnQub2soIWh0bWwuaW5jbHVkZXMoJ2NsYXNzPVwiYnVybmRvd24td3JhcFwiJyksIFwic2hvdWxkIG5vdCByZW5kZXIgYnVybmRvd24gd2l0aG91dCBjZWlsaW5nXCIpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBXYXZlIDM6IEJsb2NrZXJzIFNlY3Rpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJGZWF0dXJlIDg6IGJsb2NrZXJzIHNlY3Rpb24gcmVuZGVycyBjbGVhbiBzdGF0ZVwiLCAoKSA9PiB7XG4gIGNvbnN0IGh0bWwgPSBnZW5lcmF0ZUh0bWxSZXBvcnQobW9ja0RhdGEoKSwgbW9ja09wdHMoKSk7XG4gIGFzc2VydC5vayhodG1sLmluY2x1ZGVzKCdpZD1cImJsb2NrZXJzXCInKSwgXCJzaG91bGQgY29udGFpbiBibG9ja2VycyBzZWN0aW9uXCIpO1xuICAvLyBNMDAyL1MwMSBpcyBoaWdoIHJpc2sgYW5kIGluY29tcGxldGVcbiAgYXNzZXJ0Lm9rKGh0bWwuaW5jbHVkZXMoXCJibG9ja2VyLWNhcmRcIiksIFwic2hvdWxkIGNvbnRhaW4gaGlnaC1yaXNrIGJsb2NrZXIgY2FyZFwiKTtcbiAgYXNzZXJ0Lm9rKGh0bWwuaW5jbHVkZXMoXCJIaWdoIHJpc2tcIiksIFwic2hvdWxkIGZsYWcgaGlnaC1yaXNrIHNsaWNlXCIpO1xufSk7XG5cbnRlc3QoXCJGZWF0dXJlIDg6IGJsb2NrZXJzIHNlY3Rpb24gcmVuZGVycyBibG9ja2VyIHZlcmlmaWNhdGlvbnNcIiwgKCkgPT4ge1xuICBjb25zdCBkYXRhID0gbW9ja0RhdGEoe1xuICAgIHNsaWNlVmVyaWZpY2F0aW9uczogW1xuICAgICAge1xuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICAgIHNsaWNlSWQ6IFwiUzAxXCIsXG4gICAgICAgIHZlcmlmaWNhdGlvblJlc3VsdDogXCJUZXN0cyBmYWlsaW5nIG9uIENJXCIsXG4gICAgICAgIGJsb2NrZXJEaXNjb3ZlcmVkOiB0cnVlLFxuICAgICAgICBrZXlEZWNpc2lvbnM6IFtdLFxuICAgICAgICBwYXR0ZXJuc0VzdGFibGlzaGVkOiBbXSxcbiAgICAgICAgcHJvdmlkZXM6IFtdLFxuICAgICAgICByZXF1aXJlczogW10sXG4gICAgICB9LFxuICAgIF0sXG4gIH0pO1xuICBjb25zdCBodG1sID0gZ2VuZXJhdGVIdG1sUmVwb3J0KGRhdGEsIG1vY2tPcHRzKCkpO1xuICBhc3NlcnQub2soaHRtbC5pbmNsdWRlcyhcIlRlc3RzIGZhaWxpbmcgb24gQ0lcIiksIFwic2hvdWxkIHNob3cgYmxvY2tlciB2ZXJpZmljYXRpb24gdGV4dFwiKTtcbiAgYXNzZXJ0Lm9rKGh0bWwuaW5jbHVkZXMoXCJNMDAxXCIpLCBcInNob3VsZCBzaG93IG1pbGVzdG9uZSBJRCBpbiBibG9ja2VyXCIpO1xufSk7XG5cbnRlc3QoXCJGZWF0dXJlIDg6IGJsb2NrZXJzIHNlY3Rpb24gc2hvd3Mgbm8tYmxvY2tlcnMgbWVzc2FnZSB3aGVuIGNsZWFuXCIsICgpID0+IHtcbiAgY29uc3QgZGF0YSA9IG1vY2tEYXRhKHtcbiAgICBtaWxlc3RvbmVzOiBbXG4gICAgICB7XG4gICAgICAgIGlkOiBcIk0wMDFcIixcbiAgICAgICAgdGl0bGU6IFwiQ2xlYW4gTWlsZXN0b25lXCIsXG4gICAgICAgIHN0YXR1czogXCJjb21wbGV0ZVwiLFxuICAgICAgICBkZXBlbmRzT246IFtdLFxuICAgICAgICBzbGljZXM6IFtcbiAgICAgICAgICB7IGlkOiBcIlMwMVwiLCB0aXRsZTogXCJEb25lXCIsIGRvbmU6IHRydWUsIGFjdGl2ZTogZmFsc2UsIHJpc2s6IFwibG93XCIsIGRlcGVuZHM6IFtdLCB0YXNrczogW10gfSxcbiAgICAgICAgXSxcbiAgICAgIH0sXG4gICAgXSxcbiAgfSk7XG4gIGNvbnN0IGh0bWwgPSBnZW5lcmF0ZUh0bWxSZXBvcnQoZGF0YSwgbW9ja09wdHMoKSk7XG4gIGFzc2VydC5vayhodG1sLmluY2x1ZGVzKFwiTm8gYmxvY2tlcnMgb3IgaGlnaC1yaXNrIGl0ZW1zIGZvdW5kXCIpLCBcInNob3VsZCBzaG93IGNsZWFuIG1lc3NhZ2VcIik7XG59KTtcblxudGVzdChcIkZlYXR1cmUgODogYmxvY2tlcnMgc2VjdGlvbiBpbiBUT0MgbmF2XCIsICgpID0+IHtcbiAgY29uc3QgaHRtbCA9IGdlbmVyYXRlSHRtbFJlcG9ydChtb2NrRGF0YSgpLCBtb2NrT3B0cygpKTtcbiAgYXNzZXJ0Lm9rKGh0bWwuaW5jbHVkZXMoJ2hyZWY9XCIjYmxvY2tlcnNcIicpLCBcIlRPQyBzaG91bGQgY29udGFpbiBibG9ja2VycyBsaW5rXCIpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBXYXZlIDQ6IEdhbnR0IENoYXJ0IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiRmVhdHVyZSAxMzogc2xpY2UgR2FudHQgY2hhcnQgaXMgcmVuZGVyZWQgd2l0aCB0aW1pbmcgZGF0YVwiLCAoKSA9PiB7XG4gIGNvbnN0IGh0bWwgPSBnZW5lcmF0ZUh0bWxSZXBvcnQobW9ja0RhdGEoKSwgbW9ja09wdHMoKSk7XG4gIGFzc2VydC5vayhodG1sLmluY2x1ZGVzKCdjbGFzcz1cImdhbnR0LXdyYXBcIicpLCBcInNob3VsZCBjb250YWluIGdhbnR0LXdyYXBcIik7XG4gIGFzc2VydC5vayhodG1sLmluY2x1ZGVzKCdjbGFzcz1cImdhbnR0LXN2Z1wiJyksIFwic2hvdWxkIGNvbnRhaW4gZ2FudHQtc3ZnXCIpO1xuICBhc3NlcnQub2soaHRtbC5pbmNsdWRlcyhcIlNsaWNlIHRpbWVsaW5lXCIpLCBcInNob3VsZCBoYXZlIEdhbnR0IHRpdGxlXCIpO1xuICBhc3NlcnQub2soaHRtbC5pbmNsdWRlcyhcImdhbnR0LWJhci1cIiksIFwic2hvdWxkIGNvbnRhaW4gZ2FudHQgYmFyc1wiKTtcbn0pO1xuXG50ZXN0KFwiRmVhdHVyZSAxMzogR2FudHQgY2hhcnQgc2tpcHBlZCB3aXRoIDwgMiBzbGljZXNcIiwgKCkgPT4ge1xuICBjb25zdCBkYXRhID0gbW9ja0RhdGEoe1xuICAgIHVuaXRzOiBbbW9ja1VuaXQoXCJNMDAxL1MwMS9UMDFcIiwgMC41MCwgMTAwMCwgMjAwMCldLFxuICB9KTtcbiAgY29uc3QgaHRtbCA9IGdlbmVyYXRlSHRtbFJlcG9ydChkYXRhLCBtb2NrT3B0cygpKTtcbiAgYXNzZXJ0Lm9rKCFodG1sLmluY2x1ZGVzKCdjbGFzcz1cImdhbnR0LXdyYXBcIicpLCBcInNob3VsZCBub3QgcmVuZGVyIEdhbnR0IHdpdGggc2luZ2xlIHNsaWNlXCIpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBXYXZlIDU6IEludGVyYWN0aXZlIEpTIEZlYXR1cmVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiRmVhdHVyZSA5OiB0aW1lbGluZSBmaWx0ZXIgSlMgaXMgaW5jbHVkZWRcIiwgKCkgPT4ge1xuICBjb25zdCBodG1sID0gZ2VuZXJhdGVIdG1sUmVwb3J0KG1vY2tEYXRhKCksIG1vY2tPcHRzKCkpO1xuICBhc3NlcnQub2soaHRtbC5pbmNsdWRlcyhcInRsLWZpbHRlclwiKSwgXCJzaG91bGQgY29udGFpbiB0aW1lbGluZSBmaWx0ZXIgY2xhc3MgaW4gSlNcIik7XG4gIGFzc2VydC5vayhodG1sLmluY2x1ZGVzKFwiRmlsdGVyIHRpbWVsaW5lXCIpLCBcInNob3VsZCBjb250YWluIGZpbHRlciBwbGFjZWhvbGRlciB0ZXh0XCIpO1xufSk7XG5cbnRlc3QoXCJGZWF0dXJlIDEwOiBjb2xsYXBzaWJsZSBzZWN0aW9ucyBKUyBpcyBpbmNsdWRlZFwiLCAoKSA9PiB7XG4gIGNvbnN0IGh0bWwgPSBnZW5lcmF0ZUh0bWxSZXBvcnQobW9ja0RhdGEoKSwgbW9ja09wdHMoKSk7XG4gIGFzc2VydC5vayhodG1sLmluY2x1ZGVzKFwic2VjLXRvZ2dsZVwiKSwgXCJzaG91bGQgY29udGFpbiBzZWN0aW9uIHRvZ2dsZSBjbGFzc1wiKTtcbiAgYXNzZXJ0Lm9rKGh0bWwuaW5jbHVkZXMoXCJnc2QtY29sbGFwc2VkXCIpLCBcInNob3VsZCByZWZlcmVuY2UgbG9jYWxTdG9yYWdlIGtleSBmb3IgY29sbGFwc2VkIHN0YXRlXCIpO1xufSk7XG5cbnRlc3QoXCJGZWF0dXJlIDExOiBkYXJrL2xpZ2h0IHRoZW1lIHRvZ2dsZSBKUyBpcyBpbmNsdWRlZFwiLCAoKSA9PiB7XG4gIGNvbnN0IGh0bWwgPSBnZW5lcmF0ZUh0bWxSZXBvcnQobW9ja0RhdGEoKSwgbW9ja09wdHMoKSk7XG4gIGFzc2VydC5vayhodG1sLmluY2x1ZGVzKFwidGhlbWUtdG9nZ2xlXCIpLCBcInNob3VsZCBjb250YWluIHRoZW1lIHRvZ2dsZSBjbGFzc1wiKTtcbiAgYXNzZXJ0Lm9rKGh0bWwuaW5jbHVkZXMoXCJnc2QtdGhlbWVcIiksIFwic2hvdWxkIHJlZmVyZW5jZSBsb2NhbFN0b3JhZ2Uga2V5IGZvciB0aGVtZVwiKTtcbiAgYXNzZXJ0Lm9rKGh0bWwuaW5jbHVkZXMoXCJsaWdodC10aGVtZVwiKSwgXCJzaG91bGQgcmVmZXJlbmNlIGxpZ2h0LXRoZW1lIGNsYXNzXCIpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBXYXZlIDY6IFJlc3BvbnNpdmUgQ1NTIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiRmVhdHVyZSAxMjogcmVzcG9uc2l2ZSBtZWRpYSBxdWVyaWVzIGFyZSBpbmNsdWRlZFwiLCAoKSA9PiB7XG4gIGNvbnN0IGh0bWwgPSBnZW5lcmF0ZUh0bWxSZXBvcnQobW9ja0RhdGEoKSwgbW9ja09wdHMoKSk7XG4gIGFzc2VydC5vayhodG1sLmluY2x1ZGVzKFwibWF4LXdpZHRoOjc2OHB4XCIpLCBcInNob3VsZCBjb250YWluIDc2OHB4IGJyZWFrcG9pbnRcIik7XG4gIGFzc2VydC5vayhodG1sLmluY2x1ZGVzKFwibWF4LXdpZHRoOjQ4MHB4XCIpLCBcInNob3VsZCBjb250YWluIDQ4MHB4IGJyZWFrcG9pbnRcIik7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEVkZ2UgQ2FzZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJFZGdlOiBubyB0b3RhbHMgZGF0YSByZW5kZXJzIHdpdGhvdXQgY3Jhc2hcIiwgKCkgPT4ge1xuICBjb25zdCBkYXRhID0gbW9ja0RhdGEoeyB0b3RhbHM6IG51bGwsIHVuaXRzOiBbXSwgYnlQaGFzZTogW10sIGJ5U2xpY2U6IFtdLCBieU1vZGVsOiBbXSB9KTtcbiAgY29uc3QgaHRtbCA9IGdlbmVyYXRlSHRtbFJlcG9ydChkYXRhLCBtb2NrT3B0cygpKTtcbiAgYXNzZXJ0Lm9rKGh0bWwuaW5jbHVkZXMoJ2lkPVwic3VtbWFyeVwiJyksIFwic2hvdWxkIHJlbmRlciBzdW1tYXJ5IHNlY3Rpb25cIik7XG4gIGFzc2VydC5vayhodG1sLmluY2x1ZGVzKCdpZD1cIm1ldHJpY3NcIicpLCBcInNob3VsZCByZW5kZXIgbWV0cmljcyBzZWN0aW9uXCIpO1xuICBhc3NlcnQub2soIWh0bWwuaW5jbHVkZXMoXCJDb3N0L3NsaWNlXCIpLCBcInNob3VsZCBub3Qgc2hvdyBjb3N0L3NsaWNlIHdpdGhvdXQgdG90YWxzXCIpO1xufSk7XG5cbnRlc3QoXCJFZGdlOiB6ZXJvIGNvbXBsZXRpb24gcmF0ZSBhbmQgemVybyByZW1haW5pbmcgc2xpY2VzXCIsICgpID0+IHtcbiAgY29uc3QgZGF0YSA9IG1vY2tEYXRhKHtcbiAgICBhZ2VudEFjdGl2aXR5OiBudWxsLFxuICAgIHJlbWFpbmluZ1NsaWNlQ291bnQ6IDAsXG4gIH0pO1xuICBjb25zdCBodG1sID0gZ2VuZXJhdGVIdG1sUmVwb3J0KGRhdGEsIG1vY2tPcHRzKCkpO1xuICBhc3NlcnQub2soIWh0bWwuaW5jbHVkZXMoJ2NsYXNzPVwiZXRhLWxpbmVcIicpLCBcIm5vIEVUQSBsaW5lIHdpdGggbnVsbCBhY3Rpdml0eVwiKTtcbiAgYXNzZXJ0Lm9rKGh0bWwuaW5jbHVkZXMoJ2lkPVwic3VtbWFyeVwiJyksIFwic3VtbWFyeSBzdGlsbCByZW5kZXJzXCIpO1xufSk7XG5cbnRlc3QoXCJFZGdlOiBlbXB0eSBtaWxlc3RvbmVzIGFycmF5XCIsICgpID0+IHtcbiAgY29uc3QgZGF0YSA9IG1vY2tEYXRhKHsgbWlsZXN0b25lczogW10gfSk7XG4gIGNvbnN0IGh0bWwgPSBnZW5lcmF0ZUh0bWxSZXBvcnQoZGF0YSwgbW9ja09wdHMoKSk7XG4gIGFzc2VydC5vayhodG1sLmluY2x1ZGVzKFwiMCUgY29tcGxldGUgYWNyb3NzIDAgbWlsZXN0b25lc1wiKSwgXCJzaG91bGQgc2hvdyAwJSBjb21wbGV0aW9uXCIpO1xufSk7XG5cbnRlc3QoXCJFZGdlOiBsaWdodCB0aGVtZSBDU1MgdmFyaWFibGVzIGFyZSBkZWZpbmVkXCIsICgpID0+IHtcbiAgY29uc3QgaHRtbCA9IGdlbmVyYXRlSHRtbFJlcG9ydChtb2NrRGF0YSgpLCBtb2NrT3B0cygpKTtcbiAgLy8gVmVyaWZ5IHRoYXQgbGlnaHQtdGhlbWUgY2xhc3MgY29udGFpbnMgb3ZlcnJpZGUgdmFyaWFibGVzXG4gIGFzc2VydC5vayhodG1sLmluY2x1ZGVzKFwiLmxpZ2h0LXRoZW1le1wiKSwgXCJzaG91bGQgaW5jbHVkZSBsaWdodC10aGVtZSBDU1MgcnVsZVwiKTtcbiAgYXNzZXJ0Lm9rKGh0bWwuaW5jbHVkZXMoXCItLWJnLTA6I2ZmZlwiKSwgXCJzaG91bGQgb3ZlcnJpZGUgYmctMCBpbiBsaWdodCB0aGVtZVwiKTtcbn0pO1xuXG50ZXN0KFwiRWRnZTogcHJpbnQgbWVkaWEgcXVlcnkgc3RpbGwgcHJlc2VudFwiLCAoKSA9PiB7XG4gIGNvbnN0IGh0bWwgPSBnZW5lcmF0ZUh0bWxSZXBvcnQobW9ja0RhdGEoKSwgbW9ja09wdHMoKSk7XG4gIGFzc2VydC5vayhodG1sLmluY2x1ZGVzKFwiQG1lZGlhIHByaW50XCIpLCBcInNo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
