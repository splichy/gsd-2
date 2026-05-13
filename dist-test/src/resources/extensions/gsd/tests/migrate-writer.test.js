import {
  formatRoadmap,
  formatPlan,
  formatSliceSummary,
  formatTaskSummary,
  formatRequirements,
  formatProject,
  formatDecisions,
  formatContext,
  formatState
} from "../migrate/writer.js";
import {
  parseRoadmap,
  parsePlan
} from "../parsers-legacy.js";
import {
  parseSummary,
  parseRequirementCounts
} from "../files.js";
import { test } from "node:test";
import assert from "node:assert/strict";
function makeTask(overrides = {}) {
  return {
    id: "T01",
    title: "Setup Auth",
    description: "Implement authentication",
    done: false,
    estimate: "30m",
    files: ["src/auth.ts"],
    mustHaves: ["JWT support"],
    summary: null,
    ...overrides
  };
}
function makeSlice(overrides = {}) {
  return {
    id: "S01",
    title: "Auth System",
    risk: "medium",
    depends: [],
    done: false,
    demo: "Login flow works end-to-end",
    goal: "Working authentication",
    tasks: [makeTask()],
    research: null,
    summary: null,
    ...overrides
  };
}
function makeMilestone(overrides = {}) {
  return {
    id: "M001",
    title: "Core Platform",
    vision: "Build the core platform",
    successCriteria: ["All tests pass", "Deploy to staging"],
    slices: [makeSlice()],
    research: null,
    boundaryMap: [],
    ...overrides
  };
}
function makeSliceSummary(overrides = {}) {
  return {
    completedAt: "2026-03-10",
    provides: ["auth-flow", "jwt-tokens"],
    keyFiles: ["src/auth.ts", "src/middleware.ts"],
    keyDecisions: ["Use JWT over sessions"],
    patternsEstablished: ["Middleware pattern"],
    duration: "2h",
    whatHappened: "Implemented full auth system with JWT.",
    ...overrides
  };
}
function makeTaskSummary(overrides = {}) {
  return {
    completedAt: "2026-03-09",
    provides: ["auth-endpoint"],
    keyFiles: ["src/auth.ts"],
    duration: "45m",
    whatHappened: "Built the auth endpoint.",
    ...overrides
  };
}
test("Scenario A: Roadmap round-trip with 2 slices (1 done, 1 not)", () => {
  const milestone = makeMilestone({
    slices: [
      makeSlice({
        id: "S01",
        title: "Auth System",
        risk: "high",
        depends: [],
        done: true,
        demo: "Login flow works"
      }),
      makeSlice({
        id: "S02",
        title: "Dashboard",
        risk: "low",
        depends: ["S01"],
        done: false,
        demo: "Dashboard renders data"
      })
    ]
  });
  const output = formatRoadmap(milestone);
  const parsed = parseRoadmap(output);
  assert.deepStrictEqual(parsed.title, "M001: Core Platform", "roadmap: title");
  assert.deepStrictEqual(parsed.vision, "Build the core platform", "roadmap: vision");
  assert.deepStrictEqual(parsed.successCriteria.length, 2, "roadmap: successCriteria count");
  assert.deepStrictEqual(parsed.successCriteria[0], "All tests pass", "roadmap: successCriteria[0]");
  assert.deepStrictEqual(parsed.successCriteria[1], "Deploy to staging", "roadmap: successCriteria[1]");
  assert.deepStrictEqual(parsed.slices.length, 2, "roadmap: slices count");
  assert.deepStrictEqual(parsed.slices[0].id, "S01", "roadmap: S01 id");
  assert.deepStrictEqual(parsed.slices[0].title, "Auth System", "roadmap: S01 title");
  assert.deepStrictEqual(parsed.slices[0].done, true, "roadmap: S01 done");
  assert.deepStrictEqual(parsed.slices[0].risk, "high", "roadmap: S01 risk");
  assert.deepStrictEqual(parsed.slices[0].depends.length, 0, "roadmap: S01 depends empty");
  assert.deepStrictEqual(parsed.slices[0].demo, "Login flow works", "roadmap: S01 demo");
  assert.deepStrictEqual(parsed.slices[1].id, "S02", "roadmap: S02 id");
  assert.deepStrictEqual(parsed.slices[1].title, "Dashboard", "roadmap: S02 title");
  assert.deepStrictEqual(parsed.slices[1].done, false, "roadmap: S02 done");
  assert.deepStrictEqual(parsed.slices[1].risk, "low", "roadmap: S02 risk");
  assert.deepStrictEqual(parsed.slices[1].depends, ["S01"], "roadmap: S02 depends");
  assert.deepStrictEqual(parsed.slices[1].demo, "Dashboard renders data", "roadmap: S02 demo");
  assert.deepStrictEqual(parsed.boundaryMap.length, 0, "roadmap: boundaryMap empty");
});
test("Scenario B: Plan round-trip with 3 tasks (mixed done)", () => {
  const slice = makeSlice({
    id: "S01",
    title: "Auth System",
    goal: "Working authentication system",
    demo: "Login works with valid credentials",
    tasks: [
      makeTask({ id: "T01", title: "Setup Models", done: true, estimate: "15m", description: "Define user model" }),
      makeTask({ id: "T02", title: "Build Endpoints", done: false, estimate: "30m", description: "REST API endpoints" }),
      makeTask({ id: "T03", title: "Write Tests", done: true, estimate: "20m", description: "Unit and integration tests" })
    ]
  });
  const output = formatPlan(slice);
  const parsed = parsePlan(output);
  assert.deepStrictEqual(parsed.id, "S01", "plan: id");
  assert.deepStrictEqual(parsed.title, "Auth System", "plan: title");
  assert.deepStrictEqual(parsed.goal, "Working authentication system", "plan: goal");
  assert.deepStrictEqual(parsed.demo, "Login works with valid credentials", "plan: demo");
  assert.deepStrictEqual(parsed.tasks.length, 3, "plan: tasks count");
  assert.deepStrictEqual(parsed.tasks[0].id, "T01", "plan: T01 id");
  assert.deepStrictEqual(parsed.tasks[0].title, "Setup Models", "plan: T01 title");
  assert.deepStrictEqual(parsed.tasks[0].done, true, "plan: T01 done");
  assert.deepStrictEqual(parsed.tasks[0].estimate, "15m", "plan: T01 estimate");
  assert.deepStrictEqual(parsed.tasks[1].id, "T02", "plan: T02 id");
  assert.deepStrictEqual(parsed.tasks[1].done, false, "plan: T02 done");
  assert.deepStrictEqual(parsed.tasks[1].estimate, "30m", "plan: T02 estimate");
  assert.deepStrictEqual(parsed.tasks[2].id, "T03", "plan: T03 id");
  assert.deepStrictEqual(parsed.tasks[2].done, true, "plan: T03 done");
  assert.deepStrictEqual(parsed.tasks[2].estimate, "20m", "plan: T03 estimate");
});
test("Scenario C: Slice summary round-trip with full data", () => {
  const slice = makeSlice({
    id: "S01",
    title: "Auth System",
    done: true,
    summary: makeSliceSummary()
  });
  const output = formatSliceSummary(slice, "M001");
  const parsed = parseSummary(output);
  assert.deepStrictEqual(parsed.frontmatter.id, "S01", "sliceSummary: id");
  assert.deepStrictEqual(parsed.frontmatter.parent, "M001", "sliceSummary: parent");
  assert.deepStrictEqual(parsed.frontmatter.milestone, "M001", "sliceSummary: milestone");
  assert.deepStrictEqual(parsed.frontmatter.provides, ["auth-flow", "jwt-tokens"], "sliceSummary: provides");
  assert.deepStrictEqual(parsed.frontmatter.requires.length, 0, "sliceSummary: requires empty");
  assert.deepStrictEqual(parsed.frontmatter.affects.length, 0, "sliceSummary: affects empty");
  assert.deepStrictEqual(parsed.frontmatter.key_files, ["src/auth.ts", "src/middleware.ts"], "sliceSummary: key_files");
  assert.deepStrictEqual(parsed.frontmatter.key_decisions, ["Use JWT over sessions"], "sliceSummary: key_decisions");
  assert.deepStrictEqual(parsed.frontmatter.patterns_established, ["Middleware pattern"], "sliceSummary: patterns_established");
  assert.deepStrictEqual(parsed.frontmatter.duration, "2h", "sliceSummary: duration");
  assert.deepStrictEqual(parsed.frontmatter.completed_at, "2026-03-10", "sliceSummary: completed_at");
  assert.deepStrictEqual(parsed.frontmatter.verification_result, "passed", "sliceSummary: verification_result");
  assert.deepStrictEqual(parsed.frontmatter.blocker_discovered, false, "sliceSummary: blocker_discovered");
  assert.ok(parsed.whatHappened.includes("Implemented full auth system"), "sliceSummary: whatHappened content");
  assert.deepStrictEqual(parsed.title, "S01: Auth System", "sliceSummary: title");
});
test("Scenario D: Task summary round-trip", () => {
  const task = makeTask({
    id: "T01",
    title: "Setup Auth",
    done: true,
    summary: makeTaskSummary()
  });
  const output = formatTaskSummary(task, "S01", "M001");
  const parsed = parseSummary(output);
  assert.deepStrictEqual(parsed.frontmatter.id, "T01", "taskSummary: id");
  assert.deepStrictEqual(parsed.frontmatter.parent, "S01", "taskSummary: parent");
  assert.deepStrictEqual(parsed.frontmatter.milestone, "M001", "taskSummary: milestone");
  assert.deepStrictEqual(parsed.frontmatter.provides, ["auth-endpoint"], "taskSummary: provides");
  assert.deepStrictEqual(parsed.frontmatter.key_files, ["src/auth.ts"], "taskSummary: key_files");
  assert.deepStrictEqual(parsed.frontmatter.duration, "45m", "taskSummary: duration");
  assert.deepStrictEqual(parsed.frontmatter.completed_at, "2026-03-09", "taskSummary: completed_at");
  assert.ok(parsed.whatHappened.includes("Built the auth endpoint"), "taskSummary: whatHappened content");
  assert.deepStrictEqual(parsed.title, "T01: Setup Auth", "taskSummary: title");
});
test("Scenario E: Requirements round-trip with mixed statuses", () => {
  const requirements = [
    { id: "R001", title: "Auth Required", class: "core-capability", status: "active", description: "Must have auth", source: "spec", primarySlice: "S01" },
    { id: "R002", title: "Logging", class: "observability", status: "active", description: "Must log", source: "spec", primarySlice: "S02" },
    { id: "R003", title: "OAuth Support", class: "core-capability", status: "validated", description: "OAuth working", source: "testing", primarySlice: "S01" },
    { id: "R004", title: "Dark Mode", class: "ui", status: "deferred", description: "Nice to have", source: "feedback", primarySlice: "none" },
    { id: "R005", title: "Legacy API", class: "compat", status: "out-of-scope", description: "Dropped", source: "decision", primarySlice: "none" }
  ];
  const output = formatRequirements(requirements);
  const counts = parseRequirementCounts(output);
  assert.deepStrictEqual(counts.active, 2, "requirements: active count");
  assert.deepStrictEqual(counts.validated, 1, "requirements: validated count");
  assert.deepStrictEqual(counts.deferred, 1, "requirements: deferred count");
  assert.deepStrictEqual(counts.outOfScope, 1, "requirements: outOfScope count");
  assert.deepStrictEqual(counts.total, 5, "requirements: total count");
});
test("F1: Empty vision \u2192 fallback text", () => {
  const milestone = makeMilestone({ vision: "" });
  const output = formatRoadmap(milestone);
  const parsed = parseRoadmap(output);
  assert.deepStrictEqual(parsed.vision, "(migrated project)", "edge: empty vision fallback");
});
test("F2: Empty successCriteria \u2192 empty array", () => {
  const milestone = makeMilestone({ successCriteria: [] });
  const output = formatRoadmap(milestone);
  const parsed = parseRoadmap(output);
  assert.deepStrictEqual(parsed.successCriteria.length, 0, "edge: empty successCriteria");
});
test("F3: Empty tasks \u2192 empty array in parsed plan", () => {
  const slice = makeSlice({ tasks: [] });
  const output = formatPlan(slice);
  const parsed = parsePlan(output);
  assert.deepStrictEqual(parsed.tasks.length, 0, "edge: empty tasks");
});
test("F4: Null summary \u2192 empty string from formatSliceSummary", () => {
  const slice = makeSlice({ summary: null });
  const output = formatSliceSummary(slice, "M001");
  assert.deepStrictEqual(output, "", "edge: null summary returns empty string");
});
test("F5: Done=true checkbox in roadmap", () => {
  const milestone = makeMilestone({
    slices: [makeSlice({ id: "S01", done: true })]
  });
  const output = formatRoadmap(milestone);
  const parsed = parseRoadmap(output);
  assert.deepStrictEqual(parsed.slices[0].done, true, "edge: done checkbox true");
});
test("F6: Done=false checkbox in roadmap", () => {
  const milestone = makeMilestone({
    slices: [makeSlice({ id: "S01", done: false })]
  });
  const output = formatRoadmap(milestone);
  const parsed = parseRoadmap(output);
  assert.deepStrictEqual(parsed.slices[0].done, false, "edge: done checkbox false");
});
test("F7: Null task summary \u2192 empty string from formatTaskSummary", () => {
  const task = makeTask({ summary: null });
  const output = formatTaskSummary(task, "S01", "M001");
  assert.deepStrictEqual(output, "", "edge: null task summary returns empty string");
});
test("F8: Empty requirements \u2192 all zeros", () => {
  const output = formatRequirements([]);
  const counts = parseRequirementCounts(output);
  assert.deepStrictEqual(counts.total, 0, "edge: empty requirements total 0");
});
test("F9: formatProject with empty content \u2192 produces valid stub", () => {
  const output = formatProject("");
  assert.ok(output.includes("# Project"), "edge: empty project has heading");
  assert.ok(output.length > 10, "edge: empty project not blank");
});
test("F10: formatProject with existing content \u2192 passes through", () => {
  const content = "# My Project\n\nDescription here.\n";
  const output = formatProject(content);
  assert.deepStrictEqual(output, content, "edge: project passthrough");
});
test("F11: formatDecisions with empty content \u2192 produces valid stub", () => {
  const output = formatDecisions("");
  assert.ok(output.includes("# Decisions"), "edge: empty decisions has heading");
});
test("F12: formatContext produces valid content", () => {
  const output = formatContext("M001");
  assert.ok(output.includes("M001"), "edge: context mentions milestone");
});
test("F13: formatState produces valid content", () => {
  const milestones = [makeMilestone({
    slices: [
      makeSlice({ done: true }),
      makeSlice({ id: "S02", done: false })
    ]
  })];
  const output = formatState(milestones);
  assert.ok(output.includes("1/2"), "edge: state shows slice progress");
});
test("F14: Task with no estimate \u2192 no est backtick in plan", () => {
  const slice = makeSlice({
    tasks: [makeTask({ id: "T01", title: "Quick Fix", estimate: "" })]
  });
  const output = formatPlan(slice);
  const parsed = parsePlan(output);
  assert.deepStrictEqual(parsed.tasks[0].id, "T01", "edge: task no estimate id");
  assert.deepStrictEqual(parsed.tasks[0].estimate, "", "edge: task no estimate empty");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9taWdyYXRlLXdyaXRlci50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBNaWdyYXRpb24gd3JpdGVyIGZvcm1hdCByb3VuZC10cmlwIHRlc3Qgc3VpdGVcbi8vIFRlc3RzIHRoYXQgZm9ybWF0IGZ1bmN0aW9ucyBwcm9kdWNlIG91dHB1dCB0aGF0IHBhcnNlcyBiYWNrIGNvcnJlY3RseVxuLy8gdGhyb3VnaCBwYXJzZVJvYWRtYXAoKSwgcGFyc2VQbGFuKCksIHBhcnNlU3VtbWFyeSgpLCBhbmQgcGFyc2VSZXF1aXJlbWVudENvdW50cygpLlxuLy8gUHVyZSBpbi1tZW1vcnkgdGVzdHMgXHUyMDE0IG5vIGZpbGVzeXN0ZW0gbmVlZGVkLlxuXG5pbXBvcnQge1xuICBmb3JtYXRSb2FkbWFwLFxuICBmb3JtYXRQbGFuLFxuICBmb3JtYXRTbGljZVN1bW1hcnksXG4gIGZvcm1hdFRhc2tTdW1tYXJ5LFxuICBmb3JtYXRUYXNrUGxhbixcbiAgZm9ybWF0UmVxdWlyZW1lbnRzLFxuICBmb3JtYXRQcm9qZWN0LFxuICBmb3JtYXREZWNpc2lvbnMsXG4gIGZvcm1hdENvbnRleHQsXG4gIGZvcm1hdFN0YXRlLFxufSBmcm9tICcuLi9taWdyYXRlL3dyaXRlci50cyc7XG5pbXBvcnQge1xuICBwYXJzZVJvYWRtYXAsXG4gIHBhcnNlUGxhbixcbn0gZnJvbSAnLi4vcGFyc2Vycy1sZWdhY3kudHMnO1xuaW1wb3J0IHtcbiAgcGFyc2VTdW1tYXJ5LFxuICBwYXJzZVJlcXVpcmVtZW50Q291bnRzLFxufSBmcm9tICcuLi9maWxlcy50cyc7XG5pbXBvcnQgdHlwZSB7XG4gIEdTRE1pbGVzdG9uZSxcbiAgR1NEU2xpY2UsXG4gIEdTRFRhc2ssXG4gIEdTRFJlcXVpcmVtZW50LFxuICBHU0RTbGljZVN1bW1hcnlEYXRhLFxuICBHU0RUYXNrU3VtbWFyeURhdGEsXG59IGZyb20gJy4uL21pZ3JhdGUvdHlwZXMudHMnO1xuaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QsIGJlZm9yZUVhY2gsIGFmdGVyRWFjaCB9IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUZXN0IERhdGEgQnVpbGRlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIG1ha2VUYXNrKG92ZXJyaWRlczogUGFydGlhbDxHU0RUYXNrPiA9IHt9KTogR1NEVGFzayB7XG4gIHJldHVybiB7XG4gICAgaWQ6ICdUMDEnLFxuICAgIHRpdGxlOiAnU2V0dXAgQXV0aCcsXG4gICAgZGVzY3JpcHRpb246ICdJbXBsZW1lbnQgYXV0aGVudGljYXRpb24nLFxuICAgIGRvbmU6IGZhbHNlLFxuICAgIGVzdGltYXRlOiAnMzBtJyxcbiAgICBmaWxlczogWydzcmMvYXV0aC50cyddLFxuICAgIG11c3RIYXZlczogWydKV1Qgc3VwcG9ydCddLFxuICAgIHN1bW1hcnk6IG51bGwsXG4gICAgLi4ub3ZlcnJpZGVzLFxuICB9O1xufVxuXG5mdW5jdGlvbiBtYWtlU2xpY2Uob3ZlcnJpZGVzOiBQYXJ0aWFsPEdTRFNsaWNlPiA9IHt9KTogR1NEU2xpY2Uge1xuICByZXR1cm4ge1xuICAgIGlkOiAnUzAxJyxcbiAgICB0aXRsZTogJ0F1dGggU3lzdGVtJyxcbiAgICByaXNrOiAnbWVkaXVtJyBhcyBjb25zdCxcbiAgICBkZXBlbmRzOiBbXSxcbiAgICBkb25lOiBmYWxzZSxcbiAgICBkZW1vOiAnTG9naW4gZmxvdyB3b3JrcyBlbmQtdG8tZW5kJyxcbiAgICBnb2FsOiAnV29ya2luZyBhdXRoZW50aWNhdGlvbicsXG4gICAgdGFza3M6IFttYWtlVGFzaygpXSxcbiAgICByZXNlYXJjaDogbnVsbCxcbiAgICBzdW1tYXJ5OiBudWxsLFxuICAgIC4uLm92ZXJyaWRlcyxcbiAgfTtcbn1cblxuZnVuY3Rpb24gbWFrZU1pbGVzdG9uZShvdmVycmlkZXM6IFBhcnRpYWw8R1NETWlsZXN0b25lPiA9IHt9KTogR1NETWlsZXN0b25lIHtcbiAgcmV0dXJuIHtcbiAgICBpZDogJ00wMDEnLFxuICAgIHRpdGxlOiAnQ29yZSBQbGF0Zm9ybScsXG4gICAgdmlzaW9uOiAnQnVpbGQgdGhlIGNvcmUgcGxhdGZvcm0nLFxuICAgIHN1Y2Nlc3NDcml0ZXJpYTogWydBbGwgdGVzdHMgcGFzcycsICdEZXBsb3kgdG8gc3RhZ2luZyddLFxuICAgIHNsaWNlczogW21ha2VTbGljZSgpXSxcbiAgICByZXNlYXJjaDogbnVsbCxcbiAgICBib3VuZGFyeU1hcDogW10sXG4gICAgLi4ub3ZlcnJpZGVzLFxuICB9O1xufVxuXG5mdW5jdGlvbiBtYWtlU2xpY2VTdW1tYXJ5KG92ZXJyaWRlczogUGFydGlhbDxHU0RTbGljZVN1bW1hcnlEYXRhPiA9IHt9KTogR1NEU2xpY2VTdW1tYXJ5RGF0YSB7XG4gIHJldHVybiB7XG4gICAgY29tcGxldGVkQXQ6ICcyMDI2LTAzLTEwJyxcbiAgICBwcm92aWRlczogWydhdXRoLWZsb3cnLCAnand0LXRva2VucyddLFxuICAgIGtleUZpbGVzOiBbJ3NyYy9hdXRoLnRzJywgJ3NyYy9taWRkbGV3YXJlLnRzJ10sXG4gICAga2V5RGVjaXNpb25zOiBbJ1VzZSBKV1Qgb3ZlciBzZXNzaW9ucyddLFxuICAgIHBhdHRlcm5zRXN0YWJsaXNoZWQ6IFsnTWlkZGxld2FyZSBwYXR0ZXJuJ10sXG4gICAgZHVyYXRpb246ICcyaCcsXG4gICAgd2hhdEhhcHBlbmVkOiAnSW1wbGVtZW50ZWQgZnVsbCBhdXRoIHN5c3RlbSB3aXRoIEpXVC4nLFxuICAgIC4uLm92ZXJyaWRlcyxcbiAgfTtcbn1cblxuZnVuY3Rpb24gbWFrZVRhc2tTdW1tYXJ5KG92ZXJyaWRlczogUGFydGlhbDxHU0RUYXNrU3VtbWFyeURhdGE+ID0ge30pOiBHU0RUYXNrU3VtbWFyeURhdGEge1xuICByZXR1cm4ge1xuICAgIGNvbXBsZXRlZEF0OiAnMjAyNi0wMy0wOScsXG4gICAgcHJvdmlkZXM6IFsnYXV0aC1lbmRwb2ludCddLFxuICAgIGtleUZpbGVzOiBbJ3NyYy9hdXRoLnRzJ10sXG4gICAgZHVyYXRpb246ICc0NW0nLFxuICAgIHdoYXRIYXBwZW5lZDogJ0J1aWx0IHRoZSBhdXRoIGVuZHBvaW50LicsXG4gICAgLi4ub3ZlcnJpZGVzLFxuICB9O1xufVxuXG50ZXN0KCdTY2VuYXJpbyBBOiBSb2FkbWFwIHJvdW5kLXRyaXAgd2l0aCAyIHNsaWNlcyAoMSBkb25lLCAxIG5vdCknLCAoKSA9PiB7XG4gIGNvbnN0IG1pbGVzdG9uZSA9IG1ha2VNaWxlc3RvbmUoe1xuICAgIHNsaWNlczogW1xuICAgICAgbWFrZVNsaWNlKHtcbiAgICAgICAgaWQ6ICdTMDEnLFxuICAgICAgICB0aXRsZTogJ0F1dGggU3lzdGVtJyxcbiAgICAgICAgcmlzazogJ2hpZ2gnLFxuICAgICAgICBkZXBlbmRzOiBbXSxcbiAgICAgICAgZG9uZTogdHJ1ZSxcbiAgICAgICAgZGVtbzogJ0xvZ2luIGZsb3cgd29ya3MnLFxuICAgICAgfSksXG4gICAgICBtYWtlU2xpY2Uoe1xuICAgICAgICBpZDogJ1MwMicsXG4gICAgICAgIHRpdGxlOiAnRGFzaGJvYXJkJyxcbiAgICAgICAgcmlzazogJ2xvdycsXG4gICAgICAgIGRlcGVuZHM6IFsnUzAxJ10sXG4gICAgICAgIGRvbmU6IGZhbHNlLFxuICAgICAgICBkZW1vOiAnRGFzaGJvYXJkIHJlbmRlcnMgZGF0YScsXG4gICAgICB9KSxcbiAgICBdLFxuICB9KTtcblxuICBjb25zdCBvdXRwdXQgPSBmb3JtYXRSb2FkbWFwKG1pbGVzdG9uZSk7XG4gIGNvbnN0IHBhcnNlZCA9IHBhcnNlUm9hZG1hcChvdXRwdXQpO1xuXG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGFyc2VkLnRpdGxlLCAnTTAwMTogQ29yZSBQbGF0Zm9ybScsICdyb2FkbWFwOiB0aXRsZScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBhcnNlZC52aXNpb24sICdCdWlsZCB0aGUgY29yZSBwbGF0Zm9ybScsICdyb2FkbWFwOiB2aXNpb24nKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwYXJzZWQuc3VjY2Vzc0NyaXRlcmlhLmxlbmd0aCwgMiwgJ3JvYWRtYXA6IHN1Y2Nlc3NDcml0ZXJpYSBjb3VudCcpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBhcnNlZC5zdWNjZXNzQ3JpdGVyaWFbMF0sICdBbGwgdGVzdHMgcGFzcycsICdyb2FkbWFwOiBzdWNjZXNzQ3JpdGVyaWFbMF0nKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwYXJzZWQuc3VjY2Vzc0NyaXRlcmlhWzFdLCAnRGVwbG95IHRvIHN0YWdpbmcnLCAncm9hZG1hcDogc3VjY2Vzc0NyaXRlcmlhWzFdJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGFyc2VkLnNsaWNlcy5sZW5ndGgsIDIsICdyb2FkbWFwOiBzbGljZXMgY291bnQnKTtcblxuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBhcnNlZC5zbGljZXNbMF0uaWQsICdTMDEnLCAncm9hZG1hcDogUzAxIGlkJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGFyc2VkLnNsaWNlc1swXS50aXRsZSwgJ0F1dGggU3lzdGVtJywgJ3JvYWRtYXA6IFMwMSB0aXRsZScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBhcnNlZC5zbGljZXNbMF0uZG9uZSwgdHJ1ZSwgJ3JvYWRtYXA6IFMwMSBkb25lJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGFyc2VkLnNsaWNlc1swXS5yaXNrLCAnaGlnaCcsICdyb2FkbWFwOiBTMDEgcmlzaycpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBhcnNlZC5zbGljZXNbMF0uZGVwZW5kcy5sZW5ndGgsIDAsICdyb2FkbWFwOiBTMDEgZGVwZW5kcyBlbXB0eScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBhcnNlZC5zbGljZXNbMF0uZGVtbywgJ0xvZ2luIGZsb3cgd29ya3MnLCAncm9hZG1hcDogUzAxIGRlbW8nKTtcblxuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBhcnNlZC5zbGljZXNbMV0uaWQsICdTMDInLCAncm9hZG1hcDogUzAyIGlkJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGFyc2VkLnNsaWNlc1sxXS50aXRsZSwgJ0Rhc2hib2FyZCcsICdyb2FkbWFwOiBTMDIgdGl0bGUnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwYXJzZWQuc2xpY2VzWzFdLmRvbmUsIGZhbHNlLCAncm9hZG1hcDogUzAyIGRvbmUnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwYXJzZWQuc2xpY2VzWzFdLnJpc2ssICdsb3cnLCAncm9hZG1hcDogUzAyIHJpc2snKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwYXJzZWQuc2xpY2VzWzFdLmRlcGVuZHMsIFsnUzAxJ10sICdyb2FkbWFwOiBTMDIgZGVwZW5kcycpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBhcnNlZC5zbGljZXNbMV0uZGVtbywgJ0Rhc2hib2FyZCByZW5kZXJzIGRhdGEnLCAncm9hZG1hcDogUzAyIGRlbW8nKTtcblxuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBhcnNlZC5ib3VuZGFyeU1hcC5sZW5ndGgsIDAsICdyb2FkbWFwOiBib3VuZGFyeU1hcCBlbXB0eScpO1xufSk7XG5cbnRlc3QoJ1NjZW5hcmlvIEI6IFBsYW4gcm91bmQtdHJpcCB3aXRoIDMgdGFza3MgKG1peGVkIGRvbmUpJywgKCkgPT4ge1xuICBjb25zdCBzbGljZSA9IG1ha2VTbGljZSh7XG4gICAgaWQ6ICdTMDEnLFxuICAgIHRpdGxlOiAnQXV0aCBTeXN0ZW0nLFxuICAgIGdvYWw6ICdXb3JraW5nIGF1dGhlbnRpY2F0aW9uIHN5c3RlbScsXG4gICAgZGVtbzogJ0xvZ2luIHdvcmtzIHdpdGggdmFsaWQgY3JlZGVudGlhbHMnLFxuICAgIHRhc2tzOiBbXG4gICAgICBtYWtlVGFzayh7IGlkOiAnVDAxJywgdGl0bGU6ICdTZXR1cCBNb2RlbHMnLCBkb25lOiB0cnVlLCBlc3RpbWF0ZTogJzE1bScsIGRlc2NyaXB0aW9uOiAnRGVmaW5lIHVzZXIgbW9kZWwnIH0pLFxuICAgICAgbWFrZVRhc2soeyBpZDogJ1QwMicsIHRpdGxlOiAnQnVpbGQgRW5kcG9pbnRzJywgZG9uZTogZmFsc2UsIGVzdGltYXRlOiAnMzBtJywgZGVzY3JpcHRpb246ICdSRVNUIEFQSSBlbmRwb2ludHMnIH0pLFxuICAgICAgbWFrZVRhc2soeyBpZDogJ1QwMycsIHRpdGxlOiAnV3JpdGUgVGVzdHMnLCBkb25lOiB0cnVlLCBlc3RpbWF0ZTogJzIwbScsIGRlc2NyaXB0aW9uOiAnVW5pdCBhbmQgaW50ZWdyYXRpb24gdGVzdHMnIH0pLFxuICAgIF0sXG4gIH0pO1xuXG4gIGNvbnN0IG91dHB1dCA9IGZvcm1hdFBsYW4oc2xpY2UpO1xuICBjb25zdCBwYXJzZWQgPSBwYXJzZVBsYW4ob3V0cHV0KTtcblxuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBhcnNlZC5pZCwgJ1MwMScsICdwbGFuOiBpZCcpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBhcnNlZC50aXRsZSwgJ0F1dGggU3lzdGVtJywgJ3BsYW46IHRpdGxlJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGFyc2VkLmdvYWwsICdXb3JraW5nIGF1dGhlbnRpY2F0aW9uIHN5c3RlbScsICdwbGFuOiBnb2FsJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGFyc2VkLmRlbW8sICdMb2dpbiB3b3JrcyB3aXRoIHZhbGlkIGNyZWRlbnRpYWxzJywgJ3BsYW46IGRlbW8nKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwYXJzZWQudGFza3MubGVuZ3RoLCAzLCAncGxhbjogdGFza3MgY291bnQnKTtcblxuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBhcnNlZC50YXNrc1swXS5pZCwgJ1QwMScsICdwbGFuOiBUMDEgaWQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwYXJzZWQudGFza3NbMF0udGl0bGUsICdTZXR1cCBNb2RlbHMnLCAncGxhbjogVDAxIHRpdGxlJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGFyc2VkLnRhc2tzWzBdLmRvbmUsIHRydWUsICdwbGFuOiBUMDEgZG9uZScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBhcnNlZC50YXNrc1swXS5lc3RpbWF0ZSwgJzE1bScsICdwbGFuOiBUMDEgZXN0aW1hdGUnKTtcblxuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBhcnNlZC50YXNrc1sxXS5pZCwgJ1QwMicsICdwbGFuOiBUMDIgaWQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwYXJzZWQudGFza3NbMV0uZG9uZSwgZmFsc2UsICdwbGFuOiBUMDIgZG9uZScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBhcnNlZC50YXNrc1sxXS5lc3RpbWF0ZSwgJzMwbScsICdwbGFuOiBUMDIgZXN0aW1hdGUnKTtcblxuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBhcnNlZC50YXNrc1syXS5pZCwgJ1QwMycsICdwbGFuOiBUMDMgaWQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwYXJzZWQudGFza3NbMl0uZG9uZSwgdHJ1ZSwgJ3BsYW46IFQwMyBkb25lJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGFyc2VkLnRhc2tzWzJdLmVzdGltYXRlLCAnMjBtJywgJ3BsYW46IFQwMyBlc3RpbWF0ZScpO1xufSk7XG5cbnRlc3QoJ1NjZW5hcmlvIEM6IFNsaWNlIHN1bW1hcnkgcm91bmQtdHJpcCB3aXRoIGZ1bGwgZGF0YScsICgpID0+IHtcbiAgY29uc3Qgc2xpY2UgPSBtYWtlU2xpY2Uoe1xuICAgIGlkOiAnUzAxJyxcbiAgICB0aXRsZTogJ0F1dGggU3lzdGVtJyxcbiAgICBkb25lOiB0cnVlLFxuICAgIHN1bW1hcnk6IG1ha2VTbGljZVN1bW1hcnkoKSxcbiAgfSk7XG5cbiAgY29uc3Qgb3V0cHV0ID0gZm9ybWF0U2xpY2VTdW1tYXJ5KHNsaWNlLCAnTTAwMScpO1xuICBjb25zdCBwYXJzZWQgPSBwYXJzZVN1bW1hcnkob3V0cHV0KTtcblxuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBhcnNlZC5mcm9udG1hdHRlci5pZCwgJ1MwMScsICdzbGljZVN1bW1hcnk6IGlkJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGFyc2VkLmZyb250bWF0dGVyLnBhcmVudCwgJ00wMDEnLCAnc2xpY2VTdW1tYXJ5OiBwYXJlbnQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwYXJzZWQuZnJvbnRtYXR0ZXIubWlsZXN0b25lLCAnTTAwMScsICdzbGljZVN1bW1hcnk6IG1pbGVzdG9uZScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBhcnNlZC5mcm9udG1hdHRlci5wcm92aWRlcywgWydhdXRoLWZsb3cnLCAnand0LXRva2VucyddLCAnc2xpY2VTdW1tYXJ5OiBwcm92aWRlcycpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBhcnNlZC5mcm9udG1hdHRlci5yZXF1aXJlcy5sZW5ndGgsIDAsICdzbGljZVN1bW1hcnk6IHJlcXVpcmVzIGVtcHR5Jyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGFyc2VkLmZyb250bWF0dGVyLmFmZmVjdHMubGVuZ3RoLCAwLCAnc2xpY2VTdW1tYXJ5OiBhZmZlY3RzIGVtcHR5Jyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGFyc2VkLmZyb250bWF0dGVyLmtleV9maWxlcywgWydzcmMvYXV0aC50cycsICdzcmMvbWlkZGxld2FyZS50cyddLCAnc2xpY2VTdW1tYXJ5OiBrZXlfZmlsZXMnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwYXJzZWQuZnJvbnRtYXR0ZXIua2V5X2RlY2lzaW9ucywgWydVc2UgSldUIG92ZXIgc2Vzc2lvbnMnXSwgJ3NsaWNlU3VtbWFyeToga2V5X2RlY2lzaW9ucycpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBhcnNlZC5mcm9udG1hdHRlci5wYXR0ZXJuc19lc3RhYmxpc2hlZCwgWydNaWRkbGV3YXJlIHBhdHRlcm4nXSwgJ3NsaWNlU3VtbWFyeTogcGF0dGVybnNfZXN0YWJsaXNoZWQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwYXJzZWQuZnJvbnRtYXR0ZXIuZHVyYXRpb24sICcyaCcsICdzbGljZVN1bW1hcnk6IGR1cmF0aW9uJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGFyc2VkLmZyb250bWF0dGVyLmNvbXBsZXRlZF9hdCwgJzIwMjYtMDMtMTAnLCAnc2xpY2VTdW1tYXJ5OiBjb21wbGV0ZWRfYXQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwYXJzZWQuZnJvbnRtYXR0ZXIudmVyaWZpY2F0aW9uX3Jlc3VsdCwgJ3Bhc3NlZCcsICdzbGljZVN1bW1hcnk6IHZlcmlmaWNhdGlvbl9yZXN1bHQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwYXJzZWQuZnJvbnRtYXR0ZXIuYmxvY2tlcl9kaXNjb3ZlcmVkLCBmYWxzZSwgJ3NsaWNlU3VtbWFyeTogYmxvY2tlcl9kaXNjb3ZlcmVkJyk7XG4gIGFzc2VydC5vayhwYXJzZWQud2hhdEhhcHBlbmVkLmluY2x1ZGVzKCdJbXBsZW1lbnRlZCBmdWxsIGF1dGggc3lzdGVtJyksICdzbGljZVN1bW1hcnk6IHdoYXRIYXBwZW5lZCBjb250ZW50Jyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGFyc2VkLnRpdGxlLCAnUzAxOiBBdXRoIFN5c3RlbScsICdzbGljZVN1bW1hcnk6IHRpdGxlJyk7XG59KTtcblxudGVzdCgnU2NlbmFyaW8gRDogVGFzayBzdW1tYXJ5IHJvdW5kLXRyaXAnLCAoKSA9PiB7XG4gIGNvbnN0IHRhc2sgPSBtYWtlVGFzayh7XG4gICAgaWQ6ICdUMDEnLFxuICAgIHRpdGxlOiAnU2V0dXAgQXV0aCcsXG4gICAgZG9uZTogdHJ1ZSxcbiAgICBzdW1tYXJ5OiBtYWtlVGFza1N1bW1hcnkoKSxcbiAgfSk7XG5cbiAgY29uc3Qgb3V0cHV0ID0gZm9ybWF0VGFza1N1bW1hcnkodGFzaywgJ1MwMScsICdNMDAxJyk7XG4gIGNvbnN0IHBhcnNlZCA9IHBhcnNlU3VtbWFyeShvdXRwdXQpO1xuXG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGFyc2VkLmZyb250bWF0dGVyLmlkLCAnVDAxJywgJ3Rhc2tTdW1tYXJ5OiBpZCcpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBhcnNlZC5mcm9udG1hdHRlci5wYXJlbnQsICdTMDEnLCAndGFza1N1bW1hcnk6IHBhcmVudCcpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBhcnNlZC5mcm9udG1hdHRlci5taWxlc3RvbmUsICdNMDAxJywgJ3Rhc2tTdW1tYXJ5OiBtaWxlc3RvbmUnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwYXJzZWQuZnJvbnRtYXR0ZXIucHJvdmlkZXMsIFsnYXV0aC1lbmRwb2ludCddLCAndGFza1N1bW1hcnk6IHByb3ZpZGVzJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGFyc2VkLmZyb250bWF0dGVyLmtleV9maWxlcywgWydzcmMvYXV0aC50cyddLCAndGFza1N1bW1hcnk6IGtleV9maWxlcycpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBhcnNlZC5mcm9udG1hdHRlci5kdXJhdGlvbiwgJzQ1bScsICd0YXNrU3VtbWFyeTogZHVyYXRpb24nKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwYXJzZWQuZnJvbnRtYXR0ZXIuY29tcGxldGVkX2F0LCAnMjAyNi0wMy0wOScsICd0YXNrU3VtbWFyeTogY29tcGxldGVkX2F0Jyk7XG4gIGFzc2VydC5vayhwYXJzZWQud2hhdEhhcHBlbmVkLmluY2x1ZGVzKCdCdWlsdCB0aGUgYXV0aCBlbmRwb2ludCcpLCAndGFza1N1bW1hcnk6IHdoYXRIYXBwZW5lZCBjb250ZW50Jyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGFyc2VkLnRpdGxlLCAnVDAxOiBTZXR1cCBBdXRoJywgJ3Rhc2tTdW1tYXJ5OiB0aXRsZScpO1xufSk7XG5cbnRlc3QoJ1NjZW5hcmlvIEU6IFJlcXVpcmVtZW50cyByb3VuZC10cmlwIHdpdGggbWl4ZWQgc3RhdHVzZXMnLCAoKSA9PiB7XG4gIGNvbnN0IHJlcXVpcmVtZW50czogR1NEUmVxdWlyZW1lbnRbXSA9IFtcbiAgICB7IGlkOiAnUjAwMScsIHRpdGxlOiAnQXV0aCBSZXF1aXJlZCcsIGNsYXNzOiAnY29yZS1jYXBhYmlsaXR5Jywgc3RhdHVzOiAnYWN0aXZlJywgZGVzY3JpcHRpb246ICdNdXN0IGhhdmUgYXV0aCcsIHNvdXJjZTogJ3NwZWMnLCBwcmltYXJ5U2xpY2U6ICdTMDEnIH0sXG4gICAgeyBpZDogJ1IwMDInLCB0aXRsZTogJ0xvZ2dpbmcnLCBjbGFzczogJ29ic2VydmFiaWxpdHknLCBzdGF0dXM6ICdhY3RpdmUnLCBkZXNjcmlwdGlvbjogJ011c3QgbG9nJywgc291cmNlOiAnc3BlYycsIHByaW1hcnlTbGljZTogJ1MwMicgfSxcbiAgICB7IGlkOiAnUjAwMycsIHRpdGxlOiAnT0F1dGggU3VwcG9ydCcsIGNsYXNzOiAnY29yZS1jYXBhYmlsaXR5Jywgc3RhdHVzOiAndmFsaWRhdGVkJywgZGVzY3JpcHRpb246ICdPQXV0aCB3b3JraW5nJywgc291cmNlOiAndGVzdGluZycsIHByaW1hcnlTbGljZTogJ1MwMScgfSxcbiAgICB7IGlkOiAnUjAwNCcsIHRpdGxlOiAnRGFyayBNb2RlJywgY2xhc3M6ICd1aScsIHN0YXR1czogJ2RlZmVycmVkJywgZGVzY3JpcHRpb246ICdOaWNlIHRvIGhhdmUnLCBzb3VyY2U6ICdmZWVkYmFjaycsIHByaW1hcnlTbGljZTogJ25vbmUnIH0sXG4gICAgeyBpZDogJ1IwMDUnLCB0aXRsZTogJ0xlZ2FjeSBBUEknLCBjbGFzczogJ2NvbXBhdCcsIHN0YXR1czogJ291dC1vZi1zY29wZScsIGRlc2NyaXB0aW9uOiAnRHJvcHBlZCcsIHNvdXJjZTogJ2RlY2lzaW9uJywgcHJpbWFyeVNsaWNlOiAnbm9uZScgfSxcbiAgXTtcblxuICBjb25zdCBvdXRwdXQgPSBmb3JtYXRSZXF1aXJlbWVudHMocmVxdWlyZW1lbnRzKTtcbiAgY29uc3QgY291bnRzID0gcGFyc2VSZXF1aXJlbWVudENvdW50cyhvdXRwdXQpO1xuXG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoY291bnRzLmFjdGl2ZSwgMiwgJ3JlcXVpcmVtZW50czogYWN0aXZlIGNvdW50Jyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoY291bnRzLnZhbGlkYXRlZCwgMSwgJ3JlcXVpcmVtZW50czogdmFsaWRhdGVkIGNvdW50Jyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoY291bnRzLmRlZmVycmVkLCAxLCAncmVxdWlyZW1lbnRzOiBkZWZlcnJlZCBjb3VudCcpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGNvdW50cy5vdXRPZlNjb3BlLCAxLCAncmVxdWlyZW1lbnRzOiBvdXRPZlNjb3BlIGNvdW50Jyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoY291bnRzLnRvdGFsLCA1LCAncmVxdWlyZW1lbnRzOiB0b3RhbCBjb3VudCcpO1xufSk7XG5cbnRlc3QoJ0YxOiBFbXB0eSB2aXNpb24gXHUyMTkyIGZhbGxiYWNrIHRleHQnLCAoKSA9PiB7XG4gIGNvbnN0IG1pbGVzdG9uZSA9IG1ha2VNaWxlc3RvbmUoeyB2aXNpb246ICcnIH0pO1xuICBjb25zdCBvdXRwdXQgPSBmb3JtYXRSb2FkbWFwKG1pbGVzdG9uZSk7XG4gIGNvbnN0IHBhcnNlZCA9IHBhcnNlUm9hZG1hcChvdXRwdXQpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBhcnNlZC52aXNpb24sICcobWlncmF0ZWQgcHJvamVjdCknLCAnZWRnZTogZW1wdHkgdmlzaW9uIGZhbGxiYWNrJyk7XG59KTtcblxudGVzdCgnRjI6IEVtcHR5IHN1Y2Nlc3NDcml0ZXJpYSBcdTIxOTIgZW1wdHkgYXJyYXknLCAoKSA9PiB7XG4gIGNvbnN0IG1pbGVzdG9uZSA9IG1ha2VNaWxlc3RvbmUoeyBzdWNjZXNzQ3JpdGVyaWE6IFtdIH0pO1xuICBjb25zdCBvdXRwdXQgPSBmb3JtYXRSb2FkbWFwKG1pbGVzdG9uZSk7XG4gIGNvbnN0IHBhcnNlZCA9IHBhcnNlUm9hZG1hcChvdXRwdXQpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBhcnNlZC5zdWNjZXNzQ3JpdGVyaWEubGVuZ3RoLCAwLCAnZWRnZTogZW1wdHkgc3VjY2Vzc0NyaXRlcmlhJyk7XG59KTtcblxudGVzdCgnRjM6IEVtcHR5IHRhc2tzIFx1MjE5MiBlbXB0eSBhcnJheSBpbiBwYXJzZWQgcGxhbicsICgpID0+IHtcbiAgY29uc3Qgc2xpY2UgPSBtYWtlU2xpY2UoeyB0YXNrczogW10gfSk7XG4gIGNvbnN0IG91dHB1dCA9IGZvcm1hdFBsYW4oc2xpY2UpO1xuICBjb25zdCBwYXJzZWQgPSBwYXJzZVBsYW4ob3V0cHV0KTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwYXJzZWQudGFza3MubGVuZ3RoLCAwLCAnZWRnZTogZW1wdHkgdGFza3MnKTtcbn0pO1xuXG50ZXN0KCdGNDogTnVsbCBzdW1tYXJ5IFx1MjE5MiBlbXB0eSBzdHJpbmcgZnJvbSBmb3JtYXRTbGljZVN1bW1hcnknLCAoKSA9PiB7XG4gIGNvbnN0IHNsaWNlID0gbWFrZVNsaWNlKHsgc3VtbWFyeTogbnVsbCB9KTtcbiAgY29uc3Qgb3V0cHV0ID0gZm9ybWF0U2xpY2VTdW1tYXJ5KHNsaWNlLCAnTTAwMScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKG91dHB1dCwgJycsICdlZGdlOiBudWxsIHN1bW1hcnkgcmV0dXJucyBlbXB0eSBzdHJpbmcnKTtcbn0pO1xuXG50ZXN0KCdGNTogRG9uZT10cnVlIGNoZWNrYm94IGluIHJvYWRtYXAnLCAoKSA9PiB7XG4gIGNvbnN0IG1pbGVzdG9uZSA9IG1ha2VNaWxlc3RvbmUoe1xuICAgIHNsaWNlczogW21ha2VTbGljZSh7IGlkOiAnUzAxJywgZG9uZTogdHJ1ZSB9KV0sXG4gIH0pO1xuICBjb25zdCBvdXRwdXQgPSBmb3JtYXRSb2FkbWFwKG1pbGVzdG9uZSk7XG4gIGNvbnN0IHBhcnNlZCA9IHBhcnNlUm9hZG1hcChvdXRwdXQpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBhcnNlZC5zbGljZXNbMF0uZG9uZSwgdHJ1ZSwgJ2VkZ2U6IGRvbmUgY2hlY2tib3ggdHJ1ZScpO1xufSk7XG5cbnRlc3QoJ0Y2OiBEb25lPWZhbHNlIGNoZWNrYm94IGluIHJvYWRtYXAnLCAoKSA9PiB7XG4gIGNvbnN0IG1pbGVzdG9uZSA9IG1ha2VNaWxlc3RvbmUoe1xuICAgIHNsaWNlczogW21ha2VTbGljZSh7IGlkOiAnUzAxJywgZG9uZTogZmFsc2UgfSldLFxuICB9KTtcbiAgY29uc3Qgb3V0cHV0ID0gZm9ybWF0Um9hZG1hcChtaWxlc3RvbmUpO1xuICBjb25zdCBwYXJzZWQgPSBwYXJzZVJvYWRtYXAob3V0cHV0KTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwYXJzZWQuc2xpY2VzWzBdLmRvbmUsIGZhbHNlLCAnZWRnZTogZG9uZSBjaGVja2JveCBmYWxzZScpO1xufSk7XG5cbnRlc3QoJ0Y3OiBOdWxsIHRhc2sgc3VtbWFyeSBcdTIxOTIgZW1wdHkgc3RyaW5nIGZyb20gZm9ybWF0VGFza1N1bW1hcnknLCAoKSA9PiB7XG4gIGNvbnN0IHRhc2sgPSBtYWtlVGFzayh7IHN1bW1hcnk6IG51bGwgfSk7XG4gIGNvbnN0IG91dHB1dCA9IGZvcm1hdFRhc2tTdW1tYXJ5KHRhc2ssICdTMDEnLCAnTTAwMScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKG91dHB1dCwgJycsICdlZGdlOiBudWxsIHRhc2sgc3VtbWFyeSByZXR1cm5zIGVtcHR5IHN0cmluZycpO1xufSk7XG5cbnRlc3QoJ0Y4OiBFbXB0eSByZXF1aXJlbWVudHMgXHUyMTkyIGFsbCB6ZXJvcycsICgpID0+IHtcbiAgY29uc3Qgb3V0cHV0ID0gZm9ybWF0UmVxdWlyZW1lbnRzKFtdKTtcbiAgY29uc3QgY291bnRzID0gcGFyc2VSZXF1aXJlbWVudENvdW50cyhvdXRwdXQpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGNvdW50cy50b3RhbCwgMCwgJ2VkZ2U6IGVtcHR5IHJlcXVpcmVtZW50cyB0b3RhbCAwJyk7XG59KTtcblxudGVzdCgnRjk6IGZvcm1hdFByb2plY3Qgd2l0aCBlbXB0eSBjb250ZW50IFx1MjE5MiBwcm9kdWNlcyB2YWxpZCBzdHViJywgKCkgPT4ge1xuICBjb25zdCBvdXRwdXQgPSBmb3JtYXRQcm9qZWN0KCcnKTtcbiAgYXNzZXJ0Lm9rKG91dHB1dC5pbmNsdWRlcygnIyBQcm9qZWN0JyksICdlZGdlOiBlbXB0eSBwcm9qZWN0IGhhcyBoZWFkaW5nJyk7XG4gIGFzc2VydC5vayhvdXRwdXQubGVuZ3RoID4gMTAsICdlZGdlOiBlbXB0eSBwcm9qZWN0IG5vdCBibGFuaycpO1xufSk7XG5cbnRlc3QoJ0YxMDogZm9ybWF0UHJvamVjdCB3aXRoIGV4aXN0aW5nIGNvbnRlbnQgXHUyMTkyIHBhc3NlcyB0aHJvdWdoJywgKCkgPT4ge1xuICBjb25zdCBjb250ZW50ID0gJyMgTXkgUHJvamVjdFxcblxcbkRlc2NyaXB0aW9uIGhlcmUuXFxuJztcbiAgY29uc3Qgb3V0cHV0ID0gZm9ybWF0UHJvamVjdChjb250ZW50KTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChvdXRwdXQsIGNvbnRlbnQsICdlZGdlOiBwcm9qZWN0IHBhc3N0aHJvdWdoJyk7XG59KTtcblxudGVzdCgnRjExOiBmb3JtYXREZWNpc2lvbnMgd2l0aCBlbXB0eSBjb250ZW50IFx1MjE5MiBwcm9kdWNlcyB2YWxpZCBzdHViJywgKCkgPT4ge1xuICBjb25zdCBvdXRwdXQgPSBmb3JtYXREZWNpc2lvbnMoJycpO1xuICBhc3NlcnQub2sob3V0cHV0LmluY2x1ZGVzKCcjIERlY2lzaW9ucycpLCAnZWRnZTogZW1wdHkgZGVjaXNpb25zIGhhcyBoZWFkaW5nJyk7XG59KTtcblxudGVzdCgnRjEyOiBmb3JtYXRDb250ZXh0IHByb2R1Y2VzIHZhbGlkIGNvbnRlbnQnLCAoKSA9PiB7XG4gIGNvbnN0IG91dHB1dCA9IGZvcm1hdENvbnRleHQoJ00wMDEnKTtcbiAgYXNzZXJ0Lm9rKG91dHB1dC5pbmNsdWRlcygnTTAwMScpLCAnZWRnZTogY29udGV4dCBtZW50aW9ucyBtaWxlc3RvbmUnKTtcbn0pO1xuXG50ZXN0KCdGMTM6IGZvcm1hdFN0YXRlIHByb2R1Y2VzIHZhbGlkIGNvbnRlbnQnLCAoKSA9PiB7XG4gIGNvbnN0IG1pbGVzdG9uZXMgPSBbbWFrZU1pbGVzdG9uZSh7XG4gICAgc2xpY2VzOiBbXG4gICAgICBtYWtlU2xpY2UoeyBkb25lOiB0cnVlIH0pLFxuICAgICAgbWFrZVNsaWNlKHsgaWQ6ICdTMDInLCBkb25lOiBmYWxzZSB9KSxcbiAgICBdLFxuICB9KV07XG4gIGNvbnN0IG91dHB1dCA9IGZvcm1hdFN0YXRlKG1pbGVzdG9uZXMpO1xuICBhc3NlcnQub2sob3V0cHV0LmluY2x1ZGVzKCcxLzInKSwgJ2VkZ2U6IHN0YXRlIHNob3dzIHNsaWNlIHByb2dyZXNzJyk7XG59KTtcblxudGVzdCgnRjE0OiBUYXNrIHdpdGggbm8gZXN0aW1hdGUgXHUyMTkyIG5vIGVzdCBiYWNrdGljayBpbiBwbGFuJywgKCkgPT4ge1xuICBjb25zdCBzbGljZSA9IG1ha2VTbGljZSh7XG4gICAgdGFza3M6IFttYWtlVGFzayh7IGlkOiAnVDAxJywgdGl0bGU6ICdRdWljayBGaXgnLCBlc3RpbWF0ZTogJycgfSldLFxuICB9KTtcbiAgY29uc3Qgb3V0cHV0ID0gZm9ybWF0UGxhbihzbGljZSk7XG4gIGNvbnN0IHBhcnNlZCA9IHBhcnNlUGxhbihvdXRwdXQpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBhcnNlZC50YXNrc1swXS5pZCwgJ1QwMScsICdlZGdlOiB0YXNrIG5vIGVzdGltYXRlIGlkJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGFyc2VkLnRhc2tzWzBdLmVzdGltYXRlLCAnJywgJ2VkZ2U6IHRhc2sgbm8gZXN0aW1hdGUgZW1wdHknKTtcbn0pO1xuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuIl0sCiAgIm1hcHBpbmdzIjogIkFBS0E7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFFQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtB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
