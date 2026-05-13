import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  unitVerb,
  unitPhaseLabel,
  describeNextUnit,
  formatAutoElapsed,
  formatWidgetTokens,
  estimateTimeRemaining,
  extractUatSliceId,
  updateProgressWidget,
  setAutoOutcomeWidget,
  getRoadmapSlicesSync,
  clearSliceProgressCache,
  getWidgetMode,
  cycleWidgetMode,
  _resetWidgetModeForTests,
  _resetLastCommitCacheForTests,
  _refreshLastCommitForTests,
  _getLastCommitForTests,
  _getLastCommitFetchedAtForTests,
  formatRuntimeHealthSignal,
  shouldRenderRoadmapProgress
} from "../auto-dashboard.js";
import { getAutoDashboardData } from "../auto.js";
import { autoSession } from "../auto-runtime-state.js";
import { formatRtkSavingsLabel } from "../../shared/rtk-session-stats.js";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask
} from "../gsd-db.js";
function makeTempDir(prefix) {
  return join(
    tmpdir(),
    `gsd-auto-dashboard-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
}
function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
  }
}
test("unitVerb maps known unit types to verbs", () => {
  assert.equal(unitVerb("research-milestone"), "researching");
  assert.equal(unitVerb("research-slice"), "researching");
  assert.equal(unitVerb("plan-milestone"), "planning");
  assert.equal(unitVerb("plan-slice"), "planning");
  assert.equal(unitVerb("execute-task"), "executing");
  assert.equal(unitVerb("complete-slice"), "completing");
  assert.equal(unitVerb("replan-slice"), "replanning");
  assert.equal(unitVerb("reassess-roadmap"), "reassessing");
  assert.equal(unitVerb("run-uat"), "running UAT");
});
test("unitVerb returns raw type for unknown types", () => {
  assert.equal(unitVerb("custom-thing"), "custom-thing");
});
test("unitVerb handles hook types", () => {
  assert.equal(unitVerb("hook/verify-code"), "hook: verify-code");
  assert.equal(unitVerb("hook/"), "hook: ");
});
test("unitPhaseLabel maps known types to labels", () => {
  assert.equal(unitPhaseLabel("research-milestone"), "RESEARCH");
  assert.equal(unitPhaseLabel("research-slice"), "RESEARCH");
  assert.equal(unitPhaseLabel("plan-milestone"), "PLAN");
  assert.equal(unitPhaseLabel("plan-slice"), "PLAN");
  assert.equal(unitPhaseLabel("execute-task"), "EXECUTE");
  assert.equal(unitPhaseLabel("complete-slice"), "COMPLETE");
  assert.equal(unitPhaseLabel("replan-slice"), "REPLAN");
  assert.equal(unitPhaseLabel("reassess-roadmap"), "REASSESS");
  assert.equal(unitPhaseLabel("run-uat"), "UAT");
});
test("unitPhaseLabel uppercases unknown types", () => {
  assert.equal(unitPhaseLabel("custom-thing"), "CUSTOM-THING");
});
test("unitPhaseLabel returns HOOK for hook types", () => {
  assert.equal(unitPhaseLabel("hook/verify"), "HOOK");
});
test("describeNextUnit handles pre-planning phase", () => {
  const result = describeNextUnit({
    phase: "pre-planning",
    activeMilestone: { id: "M001", title: "Test" }
  });
  assert.equal(result.label, "Research & plan milestone");
});
test("describeNextUnit handles executing phase", () => {
  const result = describeNextUnit({
    phase: "executing",
    activeMilestone: { id: "M001", title: "Test" },
    activeSlice: { id: "S01", title: "Slice" },
    activeTask: { id: "T01", title: "Task One" }
  });
  assert.ok(result.label.includes("T01"));
  assert.ok(result.label.includes("Task One"));
});
test("describeNextUnit handles summarizing phase", () => {
  const result = describeNextUnit({
    phase: "summarizing",
    activeMilestone: { id: "M001", title: "Test" },
    activeSlice: { id: "S01", title: "First Slice" }
  });
  assert.ok(result.label.includes("S01"));
});
test("describeNextUnit handles needs-discussion phase", () => {
  const result = describeNextUnit({
    phase: "needs-discussion",
    activeMilestone: { id: "M001", title: "Test" }
  });
  assert.ok(
    result.label.toLowerCase().includes("discuss") || result.label.toLowerCase().includes("draft")
  );
});
test("describeNextUnit handles completing-milestone phase", () => {
  const result = describeNextUnit({
    phase: "completing-milestone",
    activeMilestone: { id: "M001", title: "Test" }
  });
  assert.ok(result.label.toLowerCase().includes("milestone"));
});
test("describeNextUnit returns fallback for unknown phase", () => {
  const result = describeNextUnit({
    phase: "some-future-phase",
    activeMilestone: { id: "M001", title: "Test" }
  });
  assert.equal(result.label, "Continue");
});
test("formatAutoElapsed returns empty for zero startTime", () => {
  assert.equal(formatAutoElapsed(0), "");
});
test("formatAutoElapsed formats seconds", () => {
  const result = formatAutoElapsed(Date.now() - 3e4);
  assert.match(result, /^\d+s$/);
});
test("formatAutoElapsed formats minutes", () => {
  const result = formatAutoElapsed(Date.now() - 18e4);
  assert.match(result, /^3m/);
});
test("formatAutoElapsed formats hours", () => {
  const result = formatAutoElapsed(Date.now() - 37e5);
  assert.match(result, /^1h/);
});
test("formatWidgetTokens formats small numbers directly", () => {
  assert.equal(formatWidgetTokens(0), "0");
  assert.equal(formatWidgetTokens(500), "500");
  assert.equal(formatWidgetTokens(999), "999");
});
test("formatWidgetTokens formats thousands with k", () => {
  assert.equal(formatWidgetTokens(1e3), "1.0k");
  assert.equal(formatWidgetTokens(5500), "5.5k");
  assert.equal(formatWidgetTokens(1e4), "10k");
  assert.equal(formatWidgetTokens(99999), "100k");
});
test("formatWidgetTokens formats millions with M", () => {
  assert.equal(formatWidgetTokens(1e6), "1.0M");
  assert.equal(formatWidgetTokens(1e7), "10M");
  assert.equal(formatWidgetTokens(25e6), "25M");
});
test("formatRuntimeHealthSignal surfaces idle recovery instead of generic progress", () => {
  const signal = formatRuntimeHealthSignal({
    version: 1,
    unitType: "research-milestone",
    unitId: "M001",
    startedAt: 1e3,
    updatedAt: 6e5,
    phase: "recovered",
    wrapupWarningSent: false,
    continueHereFired: false,
    timeoutAt: null,
    lastProgressAt: 1e3,
    progressCount: 1,
    lastProgressKind: "idle-recovery-retry",
    recoveryAttempts: 1,
    lastRecoveryReason: "idle"
  }, 6e5);
  assert.deepEqual(signal, {
    level: "yellow",
    summary: "Recovering",
    detail: "retry 1 after idle stall"
  });
});
test("setAutoOutcomeWidget renders a durable next-action handoff", () => {
  let widgetFactory;
  setAutoOutcomeWidget(
    {
      hasUI: true,
      ui: {
        setWidget(key, factory) {
          if (key === "gsd-outcome") widgetFactory = factory;
        }
      }
    },
    {
      status: "paused",
      title: "Auto-mode paused",
      detail: "Paused by user request.",
      unitLabel: "researching M005/S01",
      nextAction: "Type to steer, or run /gsd auto to resume.",
      commands: ["/gsd auto", "/gsd status for overview"],
      startedAt: Date.now() - 2e3
    }
  );
  assert.equal(typeof widgetFactory, "function");
  const component = widgetFactory(
    { requestRender() {
    } },
    { fg: (_color, text) => text, bold: (text) => text }
  );
  const output = component.render(100).join("\n");
  assert.match(output, /Auto-mode paused/);
  assert.match(output, /Paused by user request/);
  assert.match(output, /researching M005\/S01/);
  assert.match(output, /\/gsd auto/);
});
test("shouldRenderRoadmapProgress hides pre-roadmap zero-slice progress", () => {
  assert.equal(shouldRenderRoadmapProgress(null), false);
  assert.equal(shouldRenderRoadmapProgress({ done: 0, total: 0, activeSliceTasks: null }), false);
  assert.equal(shouldRenderRoadmapProgress({ done: 0, total: 1, activeSliceTasks: null }), true);
});
test("estimateTimeRemaining returns null when no ledger data", () => {
  const result = estimateTimeRemaining();
  assert.equal(result, null);
});
test("estimateTimeRemaining is exported and callable", () => {
  assert.equal(typeof estimateTimeRemaining, "function");
});
test("formatAutoElapsed returns empty string for negative autoStartTime", () => {
  assert.equal(formatAutoElapsed(-1), "");
  assert.equal(formatAutoElapsed(NaN), "");
});
test("getAutoDashboardData returns RTK savings in the dashboard payload", () => {
  autoSession.reset();
  autoSession.active = true;
  autoSession.basePath = makeTempDir("rtk-dashboard");
  autoSession.cmdCtx = {
    sessionManager: { getSessionId: () => "session-1" }
  };
  try {
    const data = getAutoDashboardData();
    assert.equal(Object.hasOwn(data, "rtkSavings"), true);
    assert.equal(
      data.rtkSavings === null || typeof data.rtkSavings === "object",
      true
    );
  } finally {
    cleanup(autoSession.basePath);
    autoSession.reset();
  }
});
test("RTK savings label formats the dashboard footer text", () => {
  assert.equal(formatRtkSavingsLabel(null), null);
  assert.equal(
    formatRtkSavingsLabel({
      commands: 2,
      inputTokens: 1e4,
      outputTokens: 1e3,
      savedTokens: 2500,
      savingsPct: 25,
      totalTimeMs: 100,
      avgTimeMs: 50,
      updatedAt: (/* @__PURE__ */ new Date(0)).toISOString()
    }),
    "rtk: 2.5k saved (25%)"
  );
});
test("updateProgressWidget refreshes slice progress cache immediately", (t) => {
  const dir = makeTempDir("progress-cache");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  t.after(() => {
    closeDatabase();
    clearSliceProgressCache();
    cleanup(dir);
  });
  openDatabase(join(dir, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ milestoneId: "M001", id: "S01", title: "Done", status: "complete", sequence: 1 });
  insertSlice({ milestoneId: "M001", id: "S02", title: "Active", status: "pending", sequence: 2 });
  insertSlice({ milestoneId: "M001", id: "S03", title: "Pending", status: "pending", sequence: 3 });
  insertTask({ milestoneId: "M001", sliceId: "S02", id: "T01", title: "Task", status: "complete" });
  clearSliceProgressCache();
  updateProgressWidget(
    {
      hasUI: true,
      ui: { setWidget() {
      } }
    },
    "complete-slice",
    "M001/S02",
    {
      phase: "summarizing",
      activeMilestone: { id: "M001", title: "Milestone" },
      activeSlice: { id: "S02", title: "Active" },
      activeTask: null
    },
    {
      getAutoStartTime: () => 0,
      isStepMode: () => false,
      getCmdCtx: () => null,
      getBasePath: () => dir,
      isVerbose: () => false,
      isSessionSwitching: () => false,
      getCurrentDispatchedModelId: () => null
    }
  );
  const progress = getRoadmapSlicesSync();
  assert.ok(progress, "progress cache should be populated immediately after updateProgressWidget");
  assert.deepEqual({
    done: progress.done,
    total: progress.total,
    activeSliceTasks: progress.activeSliceTasks
  }, {
    done: 1,
    total: 3,
    activeSliceTasks: { done: 1, total: 1 }
  });
});
test("updateProgressWidget full mode keeps footer-owned signals out of auto deck", (t) => {
  const dir = makeTempDir("command-deck");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  let widget = null;
  t.after(() => {
    widget?.dispose?.();
    clearSliceProgressCache();
    cleanup(dir);
  });
  updateProgressWidget(
    {
      hasUI: true,
      ui: {
        setHeader() {
        },
        setStatus() {
        },
        setWidget(_key, factory) {
          if (_key === "gsd-progress") {
            widget = factory(
              { requestRender() {
              } },
              { fg: (_color, text) => text, bold: (text) => text }
            );
          }
        }
      },
      sessionManager: { getSessionId: () => "session-1" }
    },
    "execute-task",
    "M004/S01/T01",
    {
      phase: "executing",
      activeMilestone: { id: "M004", title: "Budget Tracking" },
      activeSlice: { id: "S01", title: "Schema migration + expense add --repeat" },
      activeTask: { id: "T01", title: "Add repeat column via idempotent ALTER TABLE" }
    },
    {
      getAutoStartTime: () => Date.now() - 18e3,
      isStepMode: () => false,
      getCmdCtx: () => ({
        model: { id: "claude-sonnet-4-6", provider: "claude-code", contextWindow: 1e6 },
        getContextUsage: () => ({ percent: 0.2, contextWindow: 1e6 }),
        sessionManager: { getEntries: () => [] }
      }),
      getBasePath: () => dir,
      isVerbose: () => false,
      isSessionSwitching: () => false,
      getCurrentDispatchedModelId: () => "claude-code/claude-sonnet-4-6"
    }
  );
  const installedWidget = widget;
  assert.ok(installedWidget, "progress widget should be installed");
  const rendered = installedWidget.render(120).join("\n");
  assert.match(rendered, /GSD\s+AUTO/);
  assert.match(rendered, /Budget Tracking/);
  assert.match(rendered, /T01: Add repeat column via idempotent ALTER TABLE/);
  assert.match(rendered, /dashboard/);
  assert.doesNotMatch(rendered, /claude-sonnet-4-6/, "footer owns provider/model display");
  assert.doesNotMatch(rendered, /0\.2%|ctx|1\.0M/, "footer owns raw context meter display");
  assert.doesNotMatch(rendered, /\$/, "footer owns session cost display");
});
test("last commit refresh backs off cleanly when base path is not a git repo", (t) => {
  const dir = makeTempDir("non-git");
  mkdirSync(dir, { recursive: true });
  t.after(() => {
    cleanup(dir);
    _resetLastCommitCacheForTests();
  });
  _resetLastCommitCacheForTests();
  _refreshLastCommitForTests(dir);
  assert.equal(_getLastCommitForTests(dir), null);
  assert.ok(
    _getLastCommitFetchedAtForTests() > 0,
    "non-git refresh should still advance fetchedAt to avoid render-loop retries"
  );
});
test("last commit refresh backs off cleanly when git repo has no commits", (t) => {
  const dir = makeTempDir("empty-git");
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "pipe" });
  t.after(() => {
    cleanup(dir);
    _resetLastCommitCacheForTests();
  });
  _resetLastCommitCacheForTests();
  _refreshLastCommitForTests(dir);
  assert.equal(_getLastCommitForTests(dir), null);
  assert.ok(
    _getLastCommitFetchedAtForTests() > 0,
    "empty git refresh should still advance fetchedAt to avoid render-loop retries"
  );
});
test("last commit refresh still returns commit info for a valid git repo", (t) => {
  const dir = makeTempDir("git");
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "GSD Test"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "gsd@example.com"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "hello\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "test: seed dashboard repo"], { cwd: dir, stdio: "pipe" });
  t.after(() => {
    cleanup(dir);
    _resetLastCommitCacheForTests();
  });
  _resetLastCommitCacheForTests();
  _refreshLastCommitForTests(dir);
  const lastCommit = _getLastCommitForTests(dir);
  assert.ok(lastCommit, "git repo should produce last commit metadata");
  assert.match(lastCommit.message, /test: seed dashboard repo/);
  assert.ok(lastCommit.timeAgo.length > 0, "relative time should be populated");
});
test("extractUatSliceId extracts slice ID from M001/S01 format", () => {
  assert.equal(extractUatSliceId("M001/S01"), "S01");
  assert.equal(extractUatSliceId("M002/S03"), "S03");
  assert.equal(extractUatSliceId("M001/S12"), "S12");
});
test("extractUatSliceId returns null for invalid formats", () => {
  assert.equal(extractUatSliceId("M001"), null);
  assert.equal(extractUatSliceId(""), null);
  assert.equal(extractUatSliceId("M001/T01"), null);
});
test("widget mode respects project preference precedence and persists there", (t) => {
  const homeDir = makeTempDir("home");
  const projectDir = makeTempDir("project");
  const globalPrefsPath = join(homeDir, ".gsd", "preferences.md");
  const projectPrefsPath = join(projectDir, ".gsd", "preferences.md");
  mkdirSync(join(homeDir, ".gsd"), { recursive: true });
  mkdirSync(join(projectDir, ".gsd"), { recursive: true });
  writeFileSync(globalPrefsPath, "---\nversion: 1\nwidget_mode: off\n---\n", "utf-8");
  writeFileSync(projectPrefsPath, "---\nversion: 1\nwidget_mode: small\n---\n", "utf-8");
  t.after(() => {
    cleanup(homeDir);
    cleanup(projectDir);
    _resetWidgetModeForTests();
  });
  _resetWidgetModeForTests();
  assert.equal(getWidgetMode(projectPrefsPath, globalPrefsPath), "small", "project widget_mode overrides global");
  assert.equal(
    cycleWidgetMode(projectPrefsPath, globalPrefsPath),
    "min",
    "cycling advances from the project-owned mode"
  );
  const projectPrefs = readFileSync(projectPrefsPath, "utf-8");
  const globalPrefs = readFileSync(globalPrefsPath, "utf-8");
  assert.match(projectPrefs, /widget_mode:\s*min/);
  assert.match(globalPrefs, /widget_mode:\s*off/);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9hdXRvLWRhc2hib2FyZC50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZGlyU3luYywgcmVhZEZpbGVTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBleGVjRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5cbmltcG9ydCB7XG4gIHVuaXRWZXJiLFxuICB1bml0UGhhc2VMYWJlbCxcbiAgZGVzY3JpYmVOZXh0VW5pdCxcbiAgZm9ybWF0QXV0b0VsYXBzZWQsXG4gIGZvcm1hdFdpZGdldFRva2VucyxcbiAgZXN0aW1hdGVUaW1lUmVtYWluaW5nLFxuICBleHRyYWN0VWF0U2xpY2VJZCxcbiAgdXBkYXRlUHJvZ3Jlc3NXaWRnZXQsXG4gIHNldEF1dG9PdXRjb21lV2lkZ2V0LFxuICBnZXRSb2FkbWFwU2xpY2VzU3luYyxcbiAgY2xlYXJTbGljZVByb2dyZXNzQ2FjaGUsXG4gIGdldFdpZGdldE1vZGUsXG4gIGN5Y2xlV2lkZ2V0TW9kZSxcbiAgX3Jlc2V0V2lkZ2V0TW9kZUZvclRlc3RzLFxuICBfcmVzZXRMYXN0Q29tbWl0Q2FjaGVGb3JUZXN0cyxcbiAgX3JlZnJlc2hMYXN0Q29tbWl0Rm9yVGVzdHMsXG4gIF9nZXRMYXN0Q29tbWl0Rm9yVGVzdHMsXG4gIF9nZXRMYXN0Q29tbWl0RmV0Y2hlZEF0Rm9yVGVzdHMsXG4gIGZvcm1hdFJ1bnRpbWVIZWFsdGhTaWduYWwsXG4gIHNob3VsZFJlbmRlclJvYWRtYXBQcm9ncmVzcyxcbn0gZnJvbSBcIi4uL2F1dG8tZGFzaGJvYXJkLnRzXCI7XG5pbXBvcnQgeyBnZXRBdXRvRGFzaGJvYXJkRGF0YSB9IGZyb20gXCIuLi9hdXRvLnRzXCI7XG5pbXBvcnQgeyBhdXRvU2Vzc2lvbiB9IGZyb20gXCIuLi9hdXRvLXJ1bnRpbWUtc3RhdGUudHNcIjtcbmltcG9ydCB7IGZvcm1hdFJ0a1NhdmluZ3NMYWJlbCB9IGZyb20gXCIuLi8uLi9zaGFyZWQvcnRrLXNlc3Npb24tc3RhdHMudHNcIjtcbmltcG9ydCB7XG4gIG9wZW5EYXRhYmFzZSxcbiAgY2xvc2VEYXRhYmFzZSxcbiAgaW5zZXJ0TWlsZXN0b25lLFxuICBpbnNlcnRTbGljZSxcbiAgaW5zZXJ0VGFzayxcbn0gZnJvbSBcIi4uL2dzZC1kYi50c1wiO1xuXG5mdW5jdGlvbiBtYWtlVGVtcERpcihwcmVmaXg6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBqb2luKFxuICAgIHRtcGRpcigpLFxuICAgIGBnc2QtYXV0by1kYXNoYm9hcmQtdGVzdC0ke3ByZWZpeH0tJHtEYXRlLm5vdygpfS0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDgpfWAsXG4gICk7XG59XG5cbmZ1bmN0aW9uIGNsZWFudXAoZGlyOiBzdHJpbmcpOiB2b2lkIHtcbiAgdHJ5IHtcbiAgICBybVN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH0gY2F0Y2gge1xuICAgIC8vIGJlc3QtZWZmb3J0XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHVuaXRWZXJiIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwidW5pdFZlcmIgbWFwcyBrbm93biB1bml0IHR5cGVzIHRvIHZlcmJzXCIsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKHVuaXRWZXJiKFwicmVzZWFyY2gtbWlsZXN0b25lXCIpLCBcInJlc2VhcmNoaW5nXCIpO1xuICBhc3NlcnQuZXF1YWwodW5pdFZlcmIoXCJyZXNlYXJjaC1zbGljZVwiKSwgXCJyZXNlYXJjaGluZ1wiKTtcbiAgYXNzZXJ0LmVxdWFsKHVuaXRWZXJiKFwicGxhbi1taWxlc3RvbmVcIiksIFwicGxhbm5pbmdcIik7XG4gIGFzc2VydC5lcXVhbCh1bml0VmVyYihcInBsYW4tc2xpY2VcIiksIFwicGxhbm5pbmdcIik7XG4gIGFzc2VydC5lcXVhbCh1bml0VmVyYihcImV4ZWN1dGUtdGFza1wiKSwgXCJleGVjdXRpbmdcIik7XG4gIGFzc2VydC5lcXVhbCh1bml0VmVyYihcImNvbXBsZXRlLXNsaWNlXCIpLCBcImNvbXBsZXRpbmdcIik7XG4gIGFzc2VydC5lcXVhbCh1bml0VmVyYihcInJlcGxhbi1zbGljZVwiKSwgXCJyZXBsYW5uaW5nXCIpO1xuICBhc3NlcnQuZXF1YWwodW5pdFZlcmIoXCJyZWFzc2Vzcy1yb2FkbWFwXCIpLCBcInJlYXNzZXNzaW5nXCIpO1xuICBhc3NlcnQuZXF1YWwodW5pdFZlcmIoXCJydW4tdWF0XCIpLCBcInJ1bm5pbmcgVUFUXCIpO1xufSk7XG5cbnRlc3QoXCJ1bml0VmVyYiByZXR1cm5zIHJhdyB0eXBlIGZvciB1bmtub3duIHR5cGVzXCIsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKHVuaXRWZXJiKFwiY3VzdG9tLXRoaW5nXCIpLCBcImN1c3RvbS10aGluZ1wiKTtcbn0pO1xuXG50ZXN0KFwidW5pdFZlcmIgaGFuZGxlcyBob29rIHR5cGVzXCIsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKHVuaXRWZXJiKFwiaG9vay92ZXJpZnktY29kZVwiKSwgXCJob29rOiB2ZXJpZnktY29kZVwiKTtcbiAgYXNzZXJ0LmVxdWFsKHVuaXRWZXJiKFwiaG9vay9cIiksIFwiaG9vazogXCIpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCB1bml0UGhhc2VMYWJlbCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcInVuaXRQaGFzZUxhYmVsIG1hcHMga25vd24gdHlwZXMgdG8gbGFiZWxzXCIsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKHVuaXRQaGFzZUxhYmVsKFwicmVzZWFyY2gtbWlsZXN0b25lXCIpLCBcIlJFU0VBUkNIXCIpO1xuICBhc3NlcnQuZXF1YWwodW5pdFBoYXNlTGFiZWwoXCJyZXNlYXJjaC1zbGljZVwiKSwgXCJSRVNFQVJDSFwiKTtcbiAgYXNzZXJ0LmVxdWFsKHVuaXRQaGFzZUxhYmVsKFwicGxhbi1taWxlc3RvbmVcIiksIFwiUExBTlwiKTtcbiAgYXNzZXJ0LmVxdWFsKHVuaXRQaGFzZUxhYmVsKFwicGxhbi1zbGljZVwiKSwgXCJQTEFOXCIpO1xuICBhc3NlcnQuZXF1YWwodW5pdFBoYXNlTGFiZWwoXCJleGVjdXRlLXRhc2tcIiksIFwiRVhFQ1VURVwiKTtcbiAgYXNzZXJ0LmVxdWFsKHVuaXRQaGFzZUxhYmVsKFwiY29tcGxldGUtc2xpY2VcIiksIFwiQ09NUExFVEVcIik7XG4gIGFzc2VydC5lcXVhbCh1bml0UGhhc2VMYWJlbChcInJlcGxhbi1zbGljZVwiKSwgXCJSRVBMQU5cIik7XG4gIGFzc2VydC5lcXVhbCh1bml0UGhhc2VMYWJlbChcInJlYXNzZXNzLXJvYWRtYXBcIiksIFwiUkVBU1NFU1NcIik7XG4gIGFzc2VydC5lcXVhbCh1bml0UGhhc2VMYWJlbChcInJ1bi11YXRcIiksIFwiVUFUXCIpO1xufSk7XG5cbnRlc3QoXCJ1bml0UGhhc2VMYWJlbCB1cHBlcmNhc2VzIHVua25vd24gdHlwZXNcIiwgKCkgPT4ge1xuICBhc3NlcnQuZXF1YWwodW5pdFBoYXNlTGFiZWwoXCJjdXN0b20tdGhpbmdcIiksIFwiQ1VTVE9NLVRISU5HXCIpO1xufSk7XG5cbnRlc3QoXCJ1bml0UGhhc2VMYWJlbCByZXR1cm5zIEhPT0sgZm9yIGhvb2sgdHlwZXNcIiwgKCkgPT4ge1xuICBhc3NlcnQuZXF1YWwodW5pdFBoYXNlTGFiZWwoXCJob29rL3ZlcmlmeVwiKSwgXCJIT09LXCIpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBkZXNjcmliZU5leHRVbml0IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiZGVzY3JpYmVOZXh0VW5pdCBoYW5kbGVzIHByZS1wbGFubmluZyBwaGFzZVwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IGRlc2NyaWJlTmV4dFVuaXQoe1xuICAgIHBoYXNlOiBcInByZS1wbGFubmluZ1wiLFxuICAgIGFjdGl2ZU1pbGVzdG9uZTogeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiB9LFxuICB9IGFzIGFueSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQubGFiZWwsIFwiUmVzZWFyY2ggJiBwbGFuIG1pbGVzdG9uZVwiKTtcbn0pO1xuXG50ZXN0KFwiZGVzY3JpYmVOZXh0VW5pdCBoYW5kbGVzIGV4ZWN1dGluZyBwaGFzZVwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IGRlc2NyaWJlTmV4dFVuaXQoe1xuICAgIHBoYXNlOiBcImV4ZWN1dGluZ1wiLFxuICAgIGFjdGl2ZU1pbGVzdG9uZTogeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiB9LFxuICAgIGFjdGl2ZVNsaWNlOiB7IGlkOiBcIlMwMVwiLCB0aXRsZTogXCJTbGljZVwiIH0sXG4gICAgYWN0aXZlVGFzazogeyBpZDogXCJUMDFcIiwgdGl0bGU6IFwiVGFzayBPbmVcIiB9LFxuICB9IGFzIGFueSk7XG4gIGFzc2VydC5vayhyZXN1bHQubGFiZWwuaW5jbHVkZXMoXCJUMDFcIikpO1xuICBhc3NlcnQub2socmVzdWx0LmxhYmVsLmluY2x1ZGVzKFwiVGFzayBPbmVcIikpO1xufSk7XG5cbnRlc3QoXCJkZXNjcmliZU5leHRVbml0IGhhbmRsZXMgc3VtbWFyaXppbmcgcGhhc2VcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBkZXNjcmliZU5leHRVbml0KHtcbiAgICBwaGFzZTogXCJzdW1tYXJpemluZ1wiLFxuICAgIGFjdGl2ZU1pbGVzdG9uZTogeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiB9LFxuICAgIGFjdGl2ZVNsaWNlOiB7IGlkOiBcIlMwMVwiLCB0aXRsZTogXCJGaXJzdCBTbGljZVwiIH0sXG4gIH0gYXMgYW55KTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdC5sYWJlbC5pbmNsdWRlcyhcIlMwMVwiKSk7XG59KTtcblxudGVzdChcImRlc2NyaWJlTmV4dFVuaXQgaGFuZGxlcyBuZWVkcy1kaXNjdXNzaW9uIHBoYXNlXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gZGVzY3JpYmVOZXh0VW5pdCh7XG4gICAgcGhhc2U6IFwibmVlZHMtZGlzY3Vzc2lvblwiLFxuICAgIGFjdGl2ZU1pbGVzdG9uZTogeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiB9LFxuICB9IGFzIGFueSk7XG4gIGFzc2VydC5vayhcbiAgICByZXN1bHQubGFiZWwudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhcImRpc2N1c3NcIikgfHwgcmVzdWx0LmxhYmVsLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoXCJkcmFmdFwiKSxcbiAgKTtcbn0pO1xuXG50ZXN0KFwiZGVzY3JpYmVOZXh0VW5pdCBoYW5kbGVzIGNvbXBsZXRpbmctbWlsZXN0b25lIHBoYXNlXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gZGVzY3JpYmVOZXh0VW5pdCh7XG4gICAgcGhhc2U6IFwiY29tcGxldGluZy1taWxlc3RvbmVcIixcbiAgICBhY3RpdmVNaWxlc3RvbmU6IHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIgfSxcbiAgfSBhcyBhbnkpO1xuICBhc3NlcnQub2socmVzdWx0LmxhYmVsLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoXCJtaWxlc3RvbmVcIikpO1xufSk7XG5cbnRlc3QoXCJkZXNjcmliZU5leHRVbml0IHJldHVybnMgZmFsbGJhY2sgZm9yIHVua25vd24gcGhhc2VcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBkZXNjcmliZU5leHRVbml0KHtcbiAgICBwaGFzZTogXCJzb21lLWZ1dHVyZS1waGFzZVwiIGFzIGFueSxcbiAgICBhY3RpdmVNaWxlc3RvbmU6IHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIgfSxcbiAgfSBhcyBhbnkpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LmxhYmVsLCBcIkNvbnRpbnVlXCIpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBmb3JtYXRBdXRvRWxhcHNlZCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcImZvcm1hdEF1dG9FbGFwc2VkIHJldHVybnMgZW1wdHkgZm9yIHplcm8gc3RhcnRUaW1lXCIsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKGZvcm1hdEF1dG9FbGFwc2VkKDApLCBcIlwiKTtcbn0pO1xuXG50ZXN0KFwiZm9ybWF0QXV0b0VsYXBzZWQgZm9ybWF0cyBzZWNvbmRzXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gZm9ybWF0QXV0b0VsYXBzZWQoRGF0ZS5ub3coKSAtIDMwXzAwMCk7XG4gIGFzc2VydC5tYXRjaChyZXN1bHQsIC9eXFxkK3MkLyk7XG59KTtcblxudGVzdChcImZvcm1hdEF1dG9FbGFwc2VkIGZvcm1hdHMgbWludXRlc1wiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IGZvcm1hdEF1dG9FbGFwc2VkKERhdGUubm93KCkgLSAxODBfMDAwKTsgLy8gMyBtaW5cbiAgYXNzZXJ0Lm1hdGNoKHJlc3VsdCwgL14zbS8pO1xufSk7XG5cbnRlc3QoXCJmb3JtYXRBdXRvRWxhcHNlZCBmb3JtYXRzIGhvdXJzXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gZm9ybWF0QXV0b0VsYXBzZWQoRGF0ZS5ub3coKSAtIDNfNzAwXzAwMCk7IC8vIH4xaFxuICBhc3NlcnQubWF0Y2gocmVzdWx0LCAvXjFoLyk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGZvcm1hdFdpZGdldFRva2VucyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcImZvcm1hdFdpZGdldFRva2VucyBmb3JtYXRzIHNtYWxsIG51bWJlcnMgZGlyZWN0bHlcIiwgKCkgPT4ge1xuICBhc3NlcnQuZXF1YWwoZm9ybWF0V2lkZ2V0VG9rZW5zKDApLCBcIjBcIik7XG4gIGFzc2VydC5lcXVhbChmb3JtYXRXaWRnZXRUb2tlbnMoNTAwKSwgXCI1MDBcIik7XG4gIGFzc2VydC5lcXVhbChmb3JtYXRXaWRnZXRUb2tlbnMoOTk5KSwgXCI5OTlcIik7XG59KTtcblxudGVzdChcImZvcm1hdFdpZGdldFRva2VucyBmb3JtYXRzIHRob3VzYW5kcyB3aXRoIGtcIiwgKCkgPT4ge1xuICBhc3NlcnQuZXF1YWwoZm9ybWF0V2lkZ2V0VG9rZW5zKDEwMDApLCBcIjEuMGtcIik7XG4gIGFzc2VydC5lcXVhbChmb3JtYXRXaWRnZXRUb2tlbnMoNTUwMCksIFwiNS41a1wiKTtcbiAgYXNzZXJ0LmVxdWFsKGZvcm1hdFdpZGdldFRva2VucygxMDAwMCksIFwiMTBrXCIpO1xuICBhc3NlcnQuZXF1YWwoZm9ybWF0V2lkZ2V0VG9rZW5zKDk5OTk5KSwgXCIxMDBrXCIpO1xufSk7XG5cbnRlc3QoXCJmb3JtYXRXaWRnZXRUb2tlbnMgZm9ybWF0cyBtaWxsaW9ucyB3aXRoIE1cIiwgKCkgPT4ge1xuICBhc3NlcnQuZXF1YWwoZm9ybWF0V2lkZ2V0VG9rZW5zKDFfMDAwXzAwMCksIFwiMS4wTVwiKTtcbiAgYXNzZXJ0LmVxdWFsKGZvcm1hdFdpZGdldFRva2VucygxMF8wMDBfMDAwKSwgXCIxME1cIik7XG4gIGFzc2VydC5lcXVhbChmb3JtYXRXaWRnZXRUb2tlbnMoMjVfMDAwXzAwMCksIFwiMjVNXCIpO1xufSk7XG5cbnRlc3QoXCJmb3JtYXRSdW50aW1lSGVhbHRoU2lnbmFsIHN1cmZhY2VzIGlkbGUgcmVjb3ZlcnkgaW5zdGVhZCBvZiBnZW5lcmljIHByb2dyZXNzXCIsICgpID0+IHtcbiAgY29uc3Qgc2lnbmFsID0gZm9ybWF0UnVudGltZUhlYWx0aFNpZ25hbCh7XG4gICAgdmVyc2lvbjogMSxcbiAgICB1bml0VHlwZTogXCJyZXNlYXJjaC1taWxlc3RvbmVcIixcbiAgICB1bml0SWQ6IFwiTTAwMVwiLFxuICAgIHN0YXJ0ZWRBdDogMV8wMDAsXG4gICAgdXBkYXRlZEF0OiA2MDBfMDAwLFxuICAgIHBoYXNlOiBcInJlY292ZXJlZFwiLFxuICAgIHdyYXB1cFdhcm5pbmdTZW50OiBmYWxzZSxcbiAgICBjb250aW51ZUhlcmVGaXJlZDogZmFsc2UsXG4gICAgdGltZW91dEF0OiBudWxsLFxuICAgIGxhc3RQcm9ncmVzc0F0OiAxXzAwMCxcbiAgICBwcm9ncmVzc0NvdW50OiAxLFxuICAgIGxhc3RQcm9ncmVzc0tpbmQ6IFwiaWRsZS1yZWNvdmVyeS1yZXRyeVwiLFxuICAgIHJlY292ZXJ5QXR0ZW1wdHM6IDEsXG4gICAgbGFzdFJlY292ZXJ5UmVhc29uOiBcImlkbGVcIixcbiAgfSwgNjAwXzAwMCk7XG5cbiAgYXNzZXJ0LmRlZXBFcXVhbChzaWduYWwsIHtcbiAgICBsZXZlbDogXCJ5ZWxsb3dcIixcbiAgICBzdW1tYXJ5OiBcIlJlY292ZXJpbmdcIixcbiAgICBkZXRhaWw6IFwicmV0cnkgMSBhZnRlciBpZGxlIHN0YWxsXCIsXG4gIH0pO1xufSk7XG5cbnRlc3QoXCJzZXRBdXRvT3V0Y29tZVdpZGdldCByZW5kZXJzIGEgZHVyYWJsZSBuZXh0LWFjdGlvbiBoYW5kb2ZmXCIsICgpID0+IHtcbiAgbGV0IHdpZGdldEZhY3Rvcnk6IGFueTtcbiAgc2V0QXV0b091dGNvbWVXaWRnZXQoXG4gICAge1xuICAgICAgaGFzVUk6IHRydWUsXG4gICAgICB1aToge1xuICAgICAgICBzZXRXaWRnZXQoa2V5OiBzdHJpbmcsIGZhY3Rvcnk6IGFueSkge1xuICAgICAgICAgIGlmIChrZXkgPT09IFwiZ3NkLW91dGNvbWVcIikgd2lkZ2V0RmFjdG9yeSA9IGZhY3Rvcnk7XG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgIH0gYXMgYW55LFxuICAgIHtcbiAgICAgIHN0YXR1czogXCJwYXVzZWRcIixcbiAgICAgIHRpdGxlOiBcIkF1dG8tbW9kZSBwYXVzZWRcIixcbiAgICAgIGRldGFpbDogXCJQYXVzZWQgYnkgdXNlciByZXF1ZXN0LlwiLFxuICAgICAgdW5pdExhYmVsOiBcInJlc2VhcmNoaW5nIE0wMDUvUzAxXCIsXG4gICAgICBuZXh0QWN0aW9uOiBcIlR5cGUgdG8gc3RlZXIsIG9yIHJ1biAvZ3NkIGF1dG8gdG8gcmVzdW1lLlwiLFxuICAgICAgY29tbWFuZHM6IFtcIi9nc2QgYXV0b1wiLCBcIi9nc2Qgc3RhdHVzIGZvciBvdmVydmlld1wiXSxcbiAgICAgIHN0YXJ0ZWRBdDogRGF0ZS5ub3coKSAtIDJfMDAwLFxuICAgIH0sXG4gICk7XG5cbiAgYXNzZXJ0LmVxdWFsKHR5cGVvZiB3aWRnZXRGYWN0b3J5LCBcImZ1bmN0aW9uXCIpO1xuICBjb25zdCBjb21wb25lbnQgPSB3aWRnZXRGYWN0b3J5KFxuICAgIHsgcmVxdWVzdFJlbmRlcigpIHt9IH0sXG4gICAgeyBmZzogKF9jb2xvcjogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpID0+IHRleHQsIGJvbGQ6ICh0ZXh0OiBzdHJpbmcpID0+IHRleHQgfSxcbiAgKTtcbiAgY29uc3Qgb3V0cHV0ID0gY29tcG9uZW50LnJlbmRlcigxMDApLmpvaW4oXCJcXG5cIik7XG4gIGFzc2VydC5tYXRjaChvdXRwdXQsIC9BdXRvLW1vZGUgcGF1c2VkLyk7XG4gIGFzc2VydC5tYXRjaChvdXRwdXQsIC9QYXVzZWQgYnkgdXNlciByZXF1ZXN0Lyk7XG4gIGFzc2VydC5tYXRjaChvdXRwdXQsIC9yZXNlYXJjaGluZyBNMDA1XFwvUzAxLyk7XG4gIGFzc2VydC5tYXRjaChvdXRwdXQsIC9cXC9nc2QgYXV0by8pO1xufSk7XG5cbnRlc3QoXCJzaG91bGRSZW5kZXJSb2FkbWFwUHJvZ3Jlc3MgaGlkZXMgcHJlLXJvYWRtYXAgemVyby1zbGljZSBwcm9ncmVzc1wiLCAoKSA9PiB7XG4gIGFzc2VydC5lcXVhbChzaG91bGRSZW5kZXJSb2FkbWFwUHJvZ3Jlc3MobnVsbCksIGZhbHNlKTtcbiAgYXNzZXJ0LmVxdWFsKHNob3VsZFJlbmRlclJvYWRtYXBQcm9ncmVzcyh7IGRvbmU6IDAsIHRvdGFsOiAwLCBhY3RpdmVTbGljZVRhc2tzOiBudWxsIH0gYXMgYW55KSwgZmFsc2UpO1xuICBhc3NlcnQuZXF1YWwoc2hvdWxkUmVuZGVyUm9hZG1hcFByb2dyZXNzKHsgZG9uZTogMCwgdG90YWw6IDEsIGFjdGl2ZVNsaWNlVGFza3M6IG51bGwgfSBhcyBhbnkpLCB0cnVlKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgZXN0aW1hdGVUaW1lUmVtYWluaW5nIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiZXN0aW1hdGVUaW1lUmVtYWluaW5nIHJldHVybnMgbnVsbCB3aGVuIG5vIGxlZGdlciBkYXRhXCIsICgpID0+IHtcbiAgLy8gV2l0aCBubyBhY3RpdmUgYXV0by1tb2RlIHNlc3Npb24sIGxlZGdlciBpcyBlbXB0eVxuICBjb25zdCByZXN1bHQgPSBlc3RpbWF0ZVRpbWVSZW1haW5pbmcoKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgbnVsbCk7XG59KTtcblxudGVzdChcImVzdGltYXRlVGltZVJlbWFpbmluZyBpcyBleHBvcnRlZCBhbmQgY2FsbGFibGVcIiwgKCkgPT4ge1xuICBhc3NlcnQuZXF1YWwodHlwZW9mIGVzdGltYXRlVGltZVJlbWFpbmluZywgXCJmdW5jdGlvblwiKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgZ2V0QXV0b0Rhc2hib2FyZERhdGEgZWxhcHNlZCBndWFyZCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbi8vIFRoZXNlIHRlc3RzIHZlcmlmeSB0aGUgZWxhcHNlZCB0aW1lIGNhbGN1bGF0aW9uIGluIGdldEF1dG9EYXNoYm9hcmREYXRhKClcbi8vIGRvZXNuJ3QgcHJvZHVjZSBhYnN1cmQgdmFsdWVzIHdoZW4gYXV0b1N0YXJ0VGltZSBpcyAwICh1bmluaXRpYWxpemVkKS5cbi8vIFRoZSBhY3R1YWwgZnVuY3Rpb24gaXMgaW4gYXV0by50cyBhbmQgdGVzdGVkIHN0cnVjdHVyYWxseSBoZXJlIGJ5IHZlcmlmeWluZ1xuLy8gdGhhdCBmb3JtYXRBdXRvRWxhcHNlZCBwcm9wZXJseSBoYW5kbGVzIHRoZSB6ZXJvIGNhc2UuXG5cbnRlc3QoXCJmb3JtYXRBdXRvRWxhcHNlZCByZXR1cm5zIGVtcHR5IHN0cmluZyBmb3IgbmVnYXRpdmUgYXV0b1N0YXJ0VGltZVwiLCAoKSA9PiB7XG4gIC8vIEEgbmVnYXRpdmUgdmFsdWUgc2hvdWxkIGJlIHRyZWF0ZWQgYXMgaW52YWxpZCBcdTIwMTQgdGhlIGd1YXJkIGluXG4gIC8vIGdldEF1dG9EYXNoYm9hcmREYXRhIHByZXZlbnRzIHRoaXMsIGJ1dCBmb3JtYXRBdXRvRWxhcHNlZCBzaG91bGQgYWxzb1xuICAvLyBoYW5kbGUgaXQgZ3JhY2VmdWxseSB2aWEgaXRzIGZhbHN5IGNoZWNrLlxuICBhc3NlcnQuZXF1YWwoZm9ybWF0QXV0b0VsYXBzZWQoLTEpLCBcIlwiKTtcbiAgYXNzZXJ0LmVxdWFsKGZvcm1hdEF1dG9FbGFwc2VkKE5hTiksIFwiXCIpO1xufSk7XG5cbnRlc3QoXCJnZXRBdXRvRGFzaGJvYXJkRGF0YSByZXR1cm5zIFJUSyBzYXZpbmdzIGluIHRoZSBkYXNoYm9hcmQgcGF5bG9hZFwiLCAoKSA9PiB7XG4gIGF1dG9TZXNzaW9uLnJlc2V0KCk7XG4gIGF1dG9TZXNzaW9uLmFjdGl2ZSA9IHRydWU7XG4gIGF1dG9TZXNzaW9uLmJhc2VQYXRoID0gbWFrZVRlbXBEaXIoXCJydGstZGFzaGJvYXJkXCIpO1xuICBhdXRvU2Vzc2lvbi5jbWRDdHggPSB7XG4gICAgc2Vzc2lvbk1hbmFnZXI6IHsgZ2V0U2Vzc2lvbklkOiAoKSA9PiBcInNlc3Npb24tMVwiIH0sXG4gIH0gYXMgYW55O1xuICB0cnkge1xuICAgIGNvbnN0IGRhdGEgPSBnZXRBdXRvRGFzaGJvYXJkRGF0YSgpO1xuICAgIGFzc2VydC5lcXVhbChPYmplY3QuaGFzT3duKGRhdGEsIFwicnRrU2F2aW5nc1wiKSwgdHJ1ZSk7XG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgZGF0YS5ydGtTYXZpbmdzID09PSBudWxsIHx8IHR5cGVvZiBkYXRhLnJ0a1NhdmluZ3MgPT09IFwib2JqZWN0XCIsXG4gICAgICB0cnVlLFxuICAgICk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChhdXRvU2Vzc2lvbi5iYXNlUGF0aCk7XG4gICAgYXV0b1Nlc3Npb24ucmVzZXQoKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJSVEsgc2F2aW5ncyBsYWJlbCBmb3JtYXRzIHRoZSBkYXNoYm9hcmQgZm9vdGVyIHRleHRcIiwgKCkgPT4ge1xuICBhc3NlcnQuZXF1YWwoZm9ybWF0UnRrU2F2aW5nc0xhYmVsKG51bGwpLCBudWxsKTtcbiAgYXNzZXJ0LmVxdWFsKFxuICAgIGZvcm1hdFJ0a1NhdmluZ3NMYWJlbCh7XG4gICAgICBjb21tYW5kczogMixcbiAgICAgIGlucHV0VG9rZW5zOiAxMF8wMDAsXG4gICAgICBvdXRwdXRUb2tlbnM6IDFfMDAwLFxuICAgICAgc2F2ZWRUb2tlbnM6IDJfNTAwLFxuICAgICAgc2F2aW5nc1BjdDogMjUsXG4gICAgICB0b3RhbFRpbWVNczogMTAwLFxuICAgICAgYXZnVGltZU1zOiA1MCxcbiAgICAgIHVwZGF0ZWRBdDogbmV3IERhdGUoMCkudG9JU09TdHJpbmcoKSxcbiAgICB9KSxcbiAgICBcInJ0azogMi41ayBzYXZlZCAoMjUlKVwiLFxuICApO1xufSk7XG5cbnRlc3QoXCJ1cGRhdGVQcm9ncmVzc1dpZGdldCByZWZyZXNoZXMgc2xpY2UgcHJvZ3Jlc3MgY2FjaGUgaW1tZWRpYXRlbHlcIiwgKHQpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJwcm9ncmVzcy1jYWNoZVwiKTtcbiAgbWtkaXJTeW5jKGpvaW4oZGlyLCBcIi5nc2RcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gIHQuYWZ0ZXIoKCkgPT4ge1xuICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICBjbGVhclNsaWNlUHJvZ3Jlc3NDYWNoZSgpO1xuICAgIGNsZWFudXAoZGlyKTtcbiAgfSk7XG5cbiAgb3BlbkRhdGFiYXNlKGpvaW4oZGlyLCBcIi5nc2RcIiwgXCJnc2QuZGJcIikpO1xuICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIk1pbGVzdG9uZVwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSk7XG4gIGluc2VydFNsaWNlKHsgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCBpZDogXCJTMDFcIiwgdGl0bGU6IFwiRG9uZVwiLCBzdGF0dXM6IFwiY29tcGxldGVcIiwgc2VxdWVuY2U6IDEgfSk7XG4gIGluc2VydFNsaWNlKHsgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCBpZDogXCJTMDJcIiwgdGl0bGU6IFwiQWN0aXZlXCIsIHN0YXR1czogXCJwZW5kaW5nXCIsIHNlcXVlbmNlOiAyIH0pO1xuICBpbnNlcnRTbGljZSh7IG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgaWQ6IFwiUzAzXCIsIHRpdGxlOiBcIlBlbmRpbmdcIiwgc3RhdHVzOiBcInBlbmRpbmdcIiwgc2VxdWVuY2U6IDMgfSk7XG4gIGluc2VydFRhc2soeyBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHNsaWNlSWQ6IFwiUzAyXCIsIGlkOiBcIlQwMVwiLCB0aXRsZTogXCJUYXNrXCIsIHN0YXR1czogXCJjb21wbGV0ZVwiIH0pO1xuXG4gIGNsZWFyU2xpY2VQcm9ncmVzc0NhY2hlKCk7XG4gIHVwZGF0ZVByb2dyZXNzV2lkZ2V0KFxuICAgIHtcbiAgICAgIGhhc1VJOiB0cnVlLFxuICAgICAgdWk6IHsgc2V0V2lkZ2V0KCkge30gfSxcbiAgICB9IGFzIGFueSxcbiAgICBcImNvbXBsZXRlLXNsaWNlXCIsXG4gICAgXCJNMDAxL1MwMlwiLFxuICAgIHtcbiAgICAgIHBoYXNlOiBcInN1bW1hcml6aW5nXCIsXG4gICAgICBhY3RpdmVNaWxlc3RvbmU6IHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJNaWxlc3RvbmVcIiB9LFxuICAgICAgYWN0aXZlU2xpY2U6IHsgaWQ6IFwiUzAyXCIsIHRpdGxlOiBcIkFjdGl2ZVwiIH0sXG4gICAgICBhY3RpdmVUYXNrOiBudWxsLFxuICAgIH0gYXMgYW55LFxuICAgIHtcbiAgICAgIGdldEF1dG9TdGFydFRpbWU6ICgpID0+IDAsXG4gICAgICBpc1N0ZXBNb2RlOiAoKSA9PiBmYWxzZSxcbiAgICAgIGdldENtZEN0eDogKCkgPT4gbnVsbCxcbiAgICAgIGdldEJhc2VQYXRoOiAoKSA9PiBkaXIsXG4gICAgICBpc1ZlcmJvc2U6ICgpID0+IGZhbHNlLFxuICAgICAgaXNTZXNzaW9uU3dpdGNoaW5nOiAoKSA9PiBmYWxzZSxcbiAgICAgIGdldEN1cnJlbnREaXNwYXRjaGVkTW9kZWxJZDogKCkgPT4gbnVsbCxcbiAgICB9LFxuICApO1xuXG4gIGNvbnN0IHByb2dyZXNzID0gZ2V0Um9hZG1hcFNsaWNlc1N5bmMoKTtcbiAgYXNzZXJ0Lm9rKHByb2dyZXNzLCBcInByb2dyZXNzIGNhY2hlIHNob3VsZCBiZSBwb3B1bGF0ZWQgaW1tZWRpYXRlbHkgYWZ0ZXIgdXBkYXRlUHJvZ3Jlc3NXaWRnZXRcIik7XG4gIGFzc2VydC5kZWVwRXF1YWwoe1xuICAgIGRvbmU6IHByb2dyZXNzLmRvbmUsXG4gICAgdG90YWw6IHByb2dyZXNzLnRvdGFsLFxuICAgIGFjdGl2ZVNsaWNlVGFza3M6IHByb2dyZXNzLmFjdGl2ZVNsaWNlVGFza3MsXG4gIH0sIHtcbiAgICBkb25lOiAxLFxuICAgIHRvdGFsOiAzLFxuICAgIGFjdGl2ZVNsaWNlVGFza3M6IHsgZG9uZTogMSwgdG90YWw6IDEgfSxcbiAgfSk7XG59KTtcblxudGVzdChcInVwZGF0ZVByb2dyZXNzV2lkZ2V0IGZ1bGwgbW9kZSBrZWVwcyBmb290ZXItb3duZWQgc2lnbmFscyBvdXQgb2YgYXV0byBkZWNrXCIsICh0KSA9PiB7XG4gIGNvbnN0IGRpciA9IG1ha2VUZW1wRGlyKFwiY29tbWFuZC1kZWNrXCIpO1xuICBta2RpclN5bmMoam9pbihkaXIsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGxldCB3aWRnZXQ6IHsgcmVuZGVyKHdpZHRoOiBudW1iZXIpOiBzdHJpbmdbXTsgZGlzcG9zZT86ICgpID0+IHZvaWQgfSB8IG51bGwgPSBudWxsO1xuXG4gIHQuYWZ0ZXIoKCkgPT4ge1xuICAgIHdpZGdldD8uZGlzcG9zZT8uKCk7XG4gICAgY2xlYXJTbGljZVByb2dyZXNzQ2FjaGUoKTtcbiAgICBjbGVhbnVwKGRpcik7XG4gIH0pO1xuXG4gIHVwZGF0ZVByb2dyZXNzV2lkZ2V0KFxuICAgIHtcbiAgICAgIGhhc1VJOiB0cnVlLFxuICAgICAgdWk6IHtcbiAgICAgICAgc2V0SGVhZGVyKCkge30sXG4gICAgICAgIHNldFN0YXR1cygpIHt9LFxuICAgICAgICBzZXRXaWRnZXQoX2tleTogc3RyaW5nLCBmYWN0b3J5OiBhbnkpIHtcbiAgICAgICAgICBpZiAoX2tleSA9PT0gXCJnc2QtcHJvZ3Jlc3NcIikge1xuICAgICAgICAgICAgd2lkZ2V0ID0gZmFjdG9yeShcbiAgICAgICAgICAgICAgeyByZXF1ZXN0UmVuZGVyKCkge30gfSxcbiAgICAgICAgICAgICAgeyBmZzogKF9jb2xvcjogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpID0+IHRleHQsIGJvbGQ6ICh0ZXh0OiBzdHJpbmcpID0+IHRleHQgfSxcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICAgIHNlc3Npb25NYW5hZ2VyOiB7IGdldFNlc3Npb25JZDogKCkgPT4gXCJzZXNzaW9uLTFcIiB9LFxuICAgIH0gYXMgYW55LFxuICAgIFwiZXhlY3V0ZS10YXNrXCIsXG4gICAgXCJNMDA0L1MwMS9UMDFcIixcbiAgICB7XG4gICAgICBwaGFzZTogXCJleGVjdXRpbmdcIixcbiAgICAgIGFjdGl2ZU1pbGVzdG9uZTogeyBpZDogXCJNMDA0XCIsIHRpdGxlOiBcIkJ1ZGdldCBUcmFja2luZ1wiIH0sXG4gICAgICBhY3RpdmVTbGljZTogeyBpZDogXCJTMDFcIiwgdGl0bGU6IFwiU2NoZW1hIG1pZ3JhdGlvbiArIGV4cGVuc2UgYWRkIC0tcmVwZWF0XCIgfSxcbiAgICAgIGFjdGl2ZVRhc2s6IHsgaWQ6IFwiVDAxXCIsIHRpdGxlOiBcIkFkZCByZXBlYXQgY29sdW1uIHZpYSBpZGVtcG90ZW50IEFMVEVSIFRBQkxFXCIgfSxcbiAgICB9IGFzIGFueSxcbiAgICB7XG4gICAgICBnZXRBdXRvU3RhcnRUaW1lOiAoKSA9PiBEYXRlLm5vdygpIC0gMThfMDAwLFxuICAgICAgaXNTdGVwTW9kZTogKCkgPT4gZmFsc2UsXG4gICAgICBnZXRDbWRDdHg6ICgpID0+ICh7XG4gICAgICAgIG1vZGVsOiB7IGlkOiBcImNsYXVkZS1zb25uZXQtNC02XCIsIHByb3ZpZGVyOiBcImNsYXVkZS1jb2RlXCIsIGNvbnRleHRXaW5kb3c6IDFfMDAwXzAwMCB9LFxuICAgICAgICBnZXRDb250ZXh0VXNhZ2U6ICgpID0+ICh7IHBlcmNlbnQ6IDAuMiwgY29udGV4dFdpbmRvdzogMV8wMDBfMDAwIH0pLFxuICAgICAgICBzZXNzaW9uTWFuYWdlcjogeyBnZXRFbnRyaWVzOiAoKSA9PiBbXSB9LFxuICAgICAgfSBhcyBhbnkpLFxuICAgICAgZ2V0QmFzZVBhdGg6ICgpID0+IGRpcixcbiAgICAgIGlzVmVyYm9zZTogKCkgPT4gZmFsc2UsXG4gICAgICBpc1Nlc3Npb25Td2l0Y2hpbmc6ICgpID0+IGZhbHNlLFxuICAgICAgZ2V0Q3VycmVudERpc3BhdGNoZWRNb2RlbElkOiAoKSA9PiBcImNsYXVkZS1jb2RlL2NsYXVkZS1zb25uZXQtNC02XCIsXG4gICAgfSxcbiAgKTtcblxuICBjb25zdCBpbnN0YWxsZWRXaWRnZXQgPSB3aWRnZXQgYXMgeyByZW5kZXIod2lkdGg6IG51bWJlcik6IHN0cmluZ1tdOyBkaXNwb3NlPzogKCkgPT4gdm9pZCB9IHwgbnVsbDtcbiAgYXNzZXJ0Lm9rKGluc3RhbGxlZFdpZGdldCwgXCJwcm9ncmVzcyB3aWRnZXQgc2hvdWxkIGJlIGluc3RhbGxlZFwiKTtcbiAgY29uc3QgcmVuZGVyZWQgPSBpbnN0YWxsZWRXaWRnZXQucmVuZGVyKDEyMCkuam9pbihcIlxcblwiKTtcblxuICBhc3NlcnQubWF0Y2gocmVuZGVyZWQsIC9HU0RcXHMrQVVUTy8pO1xuICBhc3NlcnQubWF0Y2gocmVuZGVyZWQsIC9CdWRnZXQgVHJhY2tpbmcvKTtcbiAgYXNzZXJ0Lm1hdGNoKHJlbmRlcmVkLCAvVDAxOiBBZGQgcmVwZWF0IGNvbHVtbiB2aWEgaWRlbXBvdGVudCBBTFRFUiBUQUJMRS8pO1xuICBhc3NlcnQubWF0Y2gocmVuZGVyZWQsIC9kYXNoYm9hcmQvKTtcbiAgYXNzZXJ0LmRvZXNOb3RNYXRjaChyZW5kZXJlZCwgL2NsYXVkZS1zb25uZXQtNC02LywgXCJmb290ZXIgb3ducyBwcm92aWRlci9tb2RlbCBkaXNwbGF5XCIpO1xuICBhc3NlcnQuZG9lc05vdE1hdGNoKHJlbmRlcmVkLCAvMFxcLjIlfGN0eHwxXFwuME0vLCBcImZvb3RlciBvd25zIHJhdyBjb250ZXh0IG1ldGVyIGRpc3BsYXlcIik7XG4gIGFzc2VydC5kb2VzTm90TWF0Y2gocmVuZGVyZWQsIC9cXCQvLCBcImZvb3RlciBvd25zIHNlc3Npb24gY29zdCBkaXNwbGF5XCIpO1xufSk7XG5cbnRlc3QoXCJsYXN0IGNvbW1pdCByZWZyZXNoIGJhY2tzIG9mZiBjbGVhbmx5IHdoZW4gYmFzZSBwYXRoIGlzIG5vdCBhIGdpdCByZXBvXCIsICh0KSA9PiB7XG4gIGNvbnN0IGRpciA9IG1ha2VUZW1wRGlyKFwibm9uLWdpdFwiKTtcbiAgbWtkaXJTeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgdC5hZnRlcigoKSA9PiB7XG4gICAgY2xlYW51cChkaXIpO1xuICAgIF9yZXNldExhc3RDb21taXRDYWNoZUZvclRlc3RzKCk7XG4gIH0pO1xuXG4gIF9yZXNldExhc3RDb21taXRDYWNoZUZvclRlc3RzKCk7XG4gIF9yZWZyZXNoTGFzdENvbW1pdEZvclRlc3RzKGRpcik7XG5cbiAgYXNzZXJ0LmVxdWFsKF9nZXRMYXN0Q29tbWl0Rm9yVGVzdHMoZGlyKSwgbnVsbCk7XG4gIGFzc2VydC5vayhcbiAgICBfZ2V0TGFzdENvbW1pdEZldGNoZWRBdEZvclRlc3RzKCkgPiAwLFxuICAgIFwibm9uLWdpdCByZWZyZXNoIHNob3VsZCBzdGlsbCBhZHZhbmNlIGZldGNoZWRBdCB0byBhdm9pZCByZW5kZXItbG9vcCByZXRyaWVzXCIsXG4gICk7XG59KTtcblxudGVzdChcImxhc3QgY29tbWl0IHJlZnJlc2ggYmFja3Mgb2ZmIGNsZWFubHkgd2hlbiBnaXQgcmVwbyBoYXMgbm8gY29tbWl0c1wiLCAodCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcihcImVtcHR5LWdpdFwiKTtcbiAgbWtkaXJTeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJpbml0XCIsIFwiLWJcIiwgXCJtYWluXCJdLCB7IGN3ZDogZGlyLCBzdGRpbzogXCJwaXBlXCIgfSk7XG5cbiAgdC5hZnRlcigoKSA9PiB7XG4gICAgY2xlYW51cChkaXIpO1xuICAgIF9yZXNldExhc3RDb21taXRDYWNoZUZvclRlc3RzKCk7XG4gIH0pO1xuXG4gIF9yZXNldExhc3RDb21taXRDYWNoZUZvclRlc3RzKCk7XG4gIF9yZWZyZXNoTGFzdENvbW1pdEZvclRlc3RzKGRpcik7XG5cbiAgYXNzZXJ0LmVxdWFsKF9nZXRMYXN0Q29tbWl0Rm9yVGVzdHMoZGlyKSwgbnVsbCk7XG4gIGFzc2VydC5vayhcbiAgICBfZ2V0TGFzdENvbW1pdEZldGNoZWRBdEZvclRlc3RzKCkgPiAwLFxuICAgIFwiZW1wdHkgZ2l0IHJlZnJlc2ggc2hvdWxkIHN0aWxsIGFkdmFuY2UgZmV0Y2hlZEF0IHRvIGF2b2lkIHJlbmRlci1sb29wIHJldHJpZXNcIixcbiAgKTtcbn0pO1xuXG50ZXN0KFwibGFzdCBjb21taXQgcmVmcmVzaCBzdGlsbCByZXR1cm5zIGNvbW1pdCBpbmZvIGZvciBhIHZhbGlkIGdpdCByZXBvXCIsICh0KSA9PiB7XG4gIGNvbnN0IGRpciA9IG1ha2VUZW1wRGlyKFwiZ2l0XCIpO1xuICBta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiaW5pdFwiLCBcIi1iXCIsIFwibWFpblwiXSwgeyBjd2Q6IGRpciwgc3RkaW86IFwicGlwZVwiIH0pO1xuICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiY29uZmlnXCIsIFwidXNlci5uYW1lXCIsIFwiR1NEIFRlc3RcIl0sIHsgY3dkOiBkaXIsIHN0ZGlvOiBcInBpcGVcIiB9KTtcbiAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcImNvbmZpZ1wiLCBcInVzZXIuZW1haWxcIiwgXCJnc2RAZXhhbXBsZS5jb21cIl0sIHsgY3dkOiBkaXIsIHN0ZGlvOiBcInBpcGVcIiB9KTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJSRUFETUUubWRcIiksIFwiaGVsbG9cXG5cIiwgXCJ1dGYtOFwiKTtcbiAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcImFkZFwiLCBcIlJFQURNRS5tZFwiXSwgeyBjd2Q6IGRpciwgc3RkaW86IFwicGlwZVwiIH0pO1xuICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiY29tbWl0XCIsIFwiLW1cIiwgXCJ0ZXN0OiBzZWVkIGRhc2hib2FyZCByZXBvXCJdLCB7IGN3ZDogZGlyLCBzdGRpbzogXCJwaXBlXCIgfSk7XG5cbiAgdC5hZnRlcigoKSA9PiB7XG4gICAgY2xlYW51cChkaXIpO1xuICAgIF9yZXNldExhc3RDb21taXRDYWNoZUZvclRlc3RzKCk7XG4gIH0pO1xuXG4gIF9yZXNldExhc3RDb21taXRDYWNoZUZvclRlc3RzKCk7XG4gIF9yZWZyZXNoTGFzdENvbW1pdEZvclRlc3RzKGRpcik7XG5cbiAgY29uc3QgbGFzdENvbW1pdCA9IF9nZXRMYXN0Q29tbWl0Rm9yVGVzdHMoZGlyKTtcbiAgYXNzZXJ0Lm9rKGxhc3RDb21taXQsIFwiZ2l0IHJlcG8gc2hvdWxkIHByb2R1Y2UgbGFzdCBjb21taXQgbWV0YWRhdGFcIik7XG4gIGFzc2VydC5tYXRjaChsYXN0Q29tbWl0IS5tZXNzYWdlLCAvdGVzdDogc2VlZCBkYXNoYm9hcmQgcmVwby8pO1xuICBhc3NlcnQub2sobGFzdENvbW1pdCEudGltZUFnby5sZW5ndGggPiAwLCBcInJlbGF0aXZlIHRpbWUgc2hvdWxkIGJlIHBvcHVsYXRlZFwiKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgZXh0cmFjdFVhdFNsaWNlSWQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJleHRyYWN0VWF0U2xpY2VJZCBleHRyYWN0cyBzbGljZSBJRCBmcm9tIE0wMDEvUzAxIGZvcm1hdFwiLCAoKSA9PiB7XG4gIGFzc2VydC5lcXVhbChleHRyYWN0VWF0U2xpY2VJZChcIk0wMDEvUzAxXCIpLCBcIlMwMVwiKTtcbiAgYXNzZXJ0LmVxdWFsKGV4dHJhY3RVYXRTbGljZUlkKFwiTTAwMi9TMDNcIiksIFwiUzAzXCIpO1xuICBhc3NlcnQuZXF1YWwoZXh0cmFjdFVhdFNsaWNlSWQoXCJNMDAxL1MxMlwiKSwgXCJTMTJcIik7XG59KTtcblxudGVzdChcImV4dHJhY3RVYXRTbGljZUlkIHJldHVybnMgbnVsbCBmb3IgaW52YWxpZCBmb3JtYXRzXCIsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKGV4dHJhY3RVYXRTbGljZUlkKFwiTTAwMVwiKSwgbnVsbCk7XG4gIGFzc2VydC5lcXVhbChleHRyYWN0VWF0U2xpY2VJZChcIlwiKSwgbnVsbCk7XG4gIGFzc2VydC5lcXVhbChleHRyYWN0VWF0U2xpY2VJZChcIk0wMDEvVDAxXCIpLCBudWxsKTtcbn0pO1xuXG50ZXN0KFwid2lkZ2V0IG1vZGUgcmVzcGVjdHMgcHJvamVjdCBwcmVmZXJlbmNlIHByZWNlZGVuY2UgYW5kIHBlcnNpc3RzIHRoZXJlXCIsICh0KSA9PiB7XG4gIGNvbnN0IGhvbWVEaXIgPSBtYWtlVGVtcERpcihcImhvbWVcIik7XG4gIGNvbnN0IHByb2plY3REaXIgPSBtYWtlVGVtcERpcihcInByb2plY3RcIik7XG4gIGNvbnN0IGdsb2JhbFByZWZzUGF0aCA9IGpvaW4oaG9tZURpciwgXCIuZ3NkXCIsIFwicHJlZmVyZW5jZXMubWRcIik7XG4gIGNvbnN0IHByb2plY3RQcmVmc1BhdGggPSBqb2luKHByb2plY3REaXIsIFwiLmdzZFwiLCBcInByZWZlcmVuY2VzLm1kXCIpO1xuXG4gIG1rZGlyU3luYyhqb2luKGhvbWVEaXIsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIG1rZGlyU3luYyhqb2luKHByb2plY3REaXIsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoZ2xvYmFsUHJlZnNQYXRoLCBcIi0tLVxcbnZlcnNpb246IDFcXG53aWRnZXRfbW9kZTogb2ZmXFxuLS0tXFxuXCIsIFwidXRmLThcIik7XG4gIHdyaXRlRmlsZVN5bmMocHJvamVjdFByZWZzUGF0aCwgXCItLS1cXG52ZXJzaW9uOiAxXFxud2lkZ2V0X21vZGU6IHNtYWxsXFxuLS0tXFxuXCIsIFwidXRmLThcIik7XG5cbiAgdC5hZnRlcigoKSA9PiB7XG4gICAgY2xlYW51cChob21lRGlyKTtcbiAgICBjbGVhbnVwKHByb2plY3REaXIpO1xuICAgIF9yZXNldFdpZGdldE1vZGVGb3JUZXN0cygpO1xuICB9KTtcblxuICBfcmVzZXRXaWRnZXRNb2RlRm9yVGVzdHMoKTtcblxuICBhc3NlcnQuZXF1YWwoZ2V0V2lkZ2V0TW9kZShwcm9qZWN0UHJlZnNQYXRoLCBnbG9iYWxQcmVmc1BhdGgpLCBcInNtYWxsXCIsIFwicHJvamVjdCB3aWRnZXRfbW9kZSBvdmVycmlkZXMgZ2xvYmFsXCIpO1xuICBhc3NlcnQuZXF1YWwoXG4gICAgY3ljbGVXaWRnZXRNb2RlKHByb2plY3RQcmVmc1BhdGgsIGdsb2JhbFByZWZzUGF0aCksXG4gICAgXCJtaW5cIixcbiAgICBcImN5Y2xpbmcgYWR2YW5jZXMgZnJvbSB0aGUgcHJvamVjdC1vd25lZCBtb2RlXCIsXG4gICk7XG5cbiAgY29uc3QgcHJvamVjdFByZWZzID0gcmVhZEZpbGVTeW5jKHByb2plY3RQcmVmc1BhdGgsIFwidXRmLThcIik7XG4gIGNvbnN0IGdsb2JhbFByZWZzID0gcmVhZEZpbGVTeW5jKGdsb2JhbFByZWZzUGF0aCwgXCJ1dGYtOFwiKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb2plY3RQcmVmcywgL3dpZGdldF9tb2RlOlxccyptaW4vKTtcbiAgYXNzZXJ0Lm1hdGNoKGdsb2JhbFByZWZzLCAvd2lkZ2V0X21vZGU6XFxzKm9mZi8pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBQ25CLFNBQVMsV0FBVyxjQUFjLFFBQVEscUJBQXFCO0FBQy9ELFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFDdkIsU0FBUyxvQkFBb0I7QUFFN0I7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFD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
