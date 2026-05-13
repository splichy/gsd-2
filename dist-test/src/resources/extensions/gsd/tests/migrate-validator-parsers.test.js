import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validatePlanningDirectory } from "../migrate/validator.js";
import {
  parseOldRoadmap,
  parseOldPlan,
  parseOldSummary,
  parseOldRequirements,
  parseOldProject,
  parseOldState,
  parseOldConfig
} from "../migrate/parsers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
function createFixtureBase() {
  return mkdtempSync(join(tmpdir(), "gsd-migrate-t02-"));
}
function createPlanningDir(base) {
  const dir = join(base, ".planning");
  mkdirSync(dir, { recursive: true });
  return dir;
}
function cleanup(base) {
  rmSync(base, { recursive: true, force: true });
}
const SAMPLE_ROADMAP = `# Project Roadmap

## Phases

- [x] 29 \u2014 Auth System
- [ ] 30 \u2014 Dashboard
- [ ] 31 \u2014 Notifications
`;
const SAMPLE_VERSION_PREFIX_ROADMAP = `# Project Roadmap

## Phases

- \u2705 **v1.0 MVP** \u2014 Phases 1-6 (shipped 2026-02-24)
- \u2705 **v1.1 Onboarding** \u2014 Phases 7-9 (shipped 2026-03-01)
- \u{1F6A7} **v1.8 Production** \u2014 Phases 44-53
`;
const SAMPLE_PROJECT = `# My Project

A sample project for testing the migration parser.
`;
const SAMPLE_MILESTONE_SECTIONED_ROADMAP = `# Project Roadmap

## v2.0 \u2014 Foundation

<details>
<summary>Completed</summary>

- [x] 01 \u2014 Project Setup
- [x] 02 \u2014 Database Schema

</details>

## v2.5 \u2014 Features

- [x] 29 \u2014 Auth System
- [ ] 30 \u2014 Dashboard
- [ ] 31 \u2014 Notifications
`;
const SAMPLE_PLAN_XML = `---
phase: "29-auth-system"
plan: "01"
type: "implementation"
wave: 1
depends_on: []
files_modified: [src/auth.ts, src/login.ts]
autonomous: true
must_haves:
  truths:
    - Users can log in
  artifacts:
    - src/auth.ts
  key_links: []
---

# 29-01: Implement Auth

<objective>
Build the authentication system with JWT tokens and session management.
</objective>

<tasks>
<task>Create auth middleware</task>
<task>Add login endpoint</task>
<task>Add logout endpoint</task>
</tasks>

<context>
The project needs authentication before any other features can be built.
Auth tokens use JWT with RS256 signing.
</context>

<verification>
- Login returns valid JWT
- Middleware rejects invalid tokens
- Logout invalidates session
</verification>

<success_criteria>
All auth endpoints respond correctly and tokens are validated.
</success_criteria>
`;
const SAMPLE_SUMMARY = `---
phase: "29-auth-system"
plan: "01"
subsystem: "auth"
tags:
  - authentication
  - security
requires: []
provides:
  - auth-middleware
  - jwt-validation
affects:
  - api-routes
tech-stack:
  - jsonwebtoken
  - express
key-files:
  - src/auth.ts
  - src/middleware/auth.ts
key-decisions:
  - Use RS256 for JWT signing
  - Store refresh tokens in DB
patterns-established:
  - Middleware-based auth
duration: "2h"
completed: "2026-01-15"
---

# 29-01: Auth Implementation Summary

Authentication system implemented with JWT tokens.
`;
const SAMPLE_REQUIREMENTS = `# Requirements

## Active

### R001 \u2014 User Authentication
- Status: active
- Description: Users must be able to log in.

### R002 \u2014 Dashboard View
- Status: active
- Description: Main dashboard page.

## Validated

### R003 \u2014 Session Management
- Status: validated
- Description: Sessions expire after 24h.

## Deferred

### R004 \u2014 OAuth Support
- Status: deferred
- Description: Third-party login.
`;
const SAMPLE_STATE = `# State

**Current Phase:** 30-dashboard
**Status:** in-progress
`;
test("Validator: missing directory \u2192 fatal", async () => {
  const base = createFixtureBase();
  try {
    const result = await validatePlanningDirectory(join(base, "nonexistent"));
    assert.deepStrictEqual(result.valid, false, "missing dir: validation fails");
    assert.ok(result.issues.length > 0, "missing dir: has issues");
    assert.ok(result.issues.some((i) => i.severity === "fatal"), "missing dir: has fatal issue");
  } finally {
    cleanup(base);
  }
});
test("Validator: missing ROADMAP.md \u2192 warning (not fatal)", async () => {
  const base = createFixtureBase();
  try {
    const planning = createPlanningDir(base);
    writeFileSync(join(planning, "PROJECT.md"), SAMPLE_PROJECT);
    const result = await validatePlanningDirectory(planning);
    assert.deepStrictEqual(result.valid, true, "no roadmap: validation still passes");
    assert.ok(result.issues.some((i) => i.severity === "warning" && i.file.includes("ROADMAP")), "no roadmap: warning issue mentions ROADMAP");
  } finally {
    cleanup(base);
  }
});
test("Validator: missing PROJECT.md \u2192 warning", async () => {
  const base = createFixtureBase();
  try {
    const planning = createPlanningDir(base);
    writeFileSync(join(planning, "ROADMAP.md"), SAMPLE_ROADMAP);
    const result = await validatePlanningDirectory(planning);
    assert.deepStrictEqual(result.valid, true, "no project: validation passes (warning only)");
    assert.ok(result.issues.some((i) => i.severity === "warning" && i.file.includes("PROJECT")), "no project: warning issue mentions PROJECT");
  } finally {
    cleanup(base);
  }
});
test("Validator: complete directory \u2192 valid with no issues", async () => {
  const base = createFixtureBase();
  try {
    const planning = createPlanningDir(base);
    writeFileSync(join(planning, "ROADMAP.md"), SAMPLE_ROADMAP);
    writeFileSync(join(planning, "PROJECT.md"), SAMPLE_PROJECT);
    writeFileSync(join(planning, "REQUIREMENTS.md"), SAMPLE_REQUIREMENTS);
    writeFileSync(join(planning, "STATE.md"), SAMPLE_STATE);
    mkdirSync(join(planning, "phases"), { recursive: true });
    const result = await validatePlanningDirectory(planning);
    assert.deepStrictEqual(result.valid, true, "complete dir: validation passes");
    assert.deepStrictEqual(result.issues.length, 0, "complete dir: no issues");
  } finally {
    cleanup(base);
  }
});
test("parseOldRoadmap: flat format", () => {
  const roadmap = parseOldRoadmap(SAMPLE_ROADMAP);
  assert.deepStrictEqual(roadmap.milestones.length, 0, "flat roadmap: no milestone sections");
  assert.deepStrictEqual(roadmap.phases.length, 3, "flat roadmap: 3 phases");
  assert.deepStrictEqual(roadmap.phases[0].number, 29, "flat roadmap: first phase number");
  assert.deepStrictEqual(roadmap.phases[0].title, "Auth System", "flat roadmap: first phase title");
  assert.deepStrictEqual(roadmap.phases[0].done, true, "flat roadmap: first phase done");
  assert.deepStrictEqual(roadmap.phases[1].done, false, "flat roadmap: second phase not done");
});
test("parseOldRoadmap: emoji version-prefix phase ranges", () => {
  const roadmap = parseOldRoadmap(SAMPLE_VERSION_PREFIX_ROADMAP);
  assert.deepStrictEqual(roadmap.milestones.length, 0, "version roadmap: no milestone sections");
  assert.deepStrictEqual(roadmap.phases.length, 3, "version roadmap: 3 phase ranges");
  assert.deepStrictEqual(roadmap.phases[0].number, 1, "version roadmap: first range starts at phase 1");
  assert.deepStrictEqual(roadmap.phases[0].title, "MVP", "version roadmap: first title");
  assert.deepStrictEqual(roadmap.phases[0].done, true, "version roadmap: first range done");
  assert.deepStrictEqual(roadmap.phases[1].number, 7, "version roadmap: second range starts at phase 7");
  assert.deepStrictEqual(roadmap.phases[1].title, "Onboarding", "version roadmap: second title");
  assert.deepStrictEqual(roadmap.phases[1].done, true, "version roadmap: second range done");
  assert.deepStrictEqual(roadmap.phases[2].number, 44, "version roadmap: third range starts at phase 44");
  assert.deepStrictEqual(roadmap.phases[2].title, "Production", "version roadmap: third title");
  assert.deepStrictEqual(roadmap.phases[2].done, false, "version roadmap: third range in progress");
});
test("parseOldRoadmap: milestone-sectioned with <details>", () => {
  const roadmap = parseOldRoadmap(SAMPLE_MILESTONE_SECTIONED_ROADMAP);
  assert.ok(roadmap.milestones.length >= 2, "ms roadmap: has milestone sections");
  const v20 = roadmap.milestones.find((m) => m.id.includes("2.0"));
  assert.ok(v20 !== void 0, "ms roadmap: v2.0 found");
  assert.deepStrictEqual(v20?.collapsed, true, "ms roadmap: v2.0 collapsed");
  assert.ok((v20?.phases.length ?? 0) >= 2, "ms roadmap: v2.0 has phases");
  assert.ok(v20?.phases.every((p) => p.done) ?? false, "ms roadmap: v2.0 all done");
  const v25 = roadmap.milestones.find((m) => m.id.includes("2.5"));
  assert.ok(v25 !== void 0, "ms roadmap: v2.5 found");
  assert.deepStrictEqual(v25?.collapsed, false, "ms roadmap: v2.5 not collapsed");
  assert.ok((v25?.phases.length ?? 0) >= 3, "ms roadmap: v2.5 has 3 phases");
  const p29 = v25?.phases.find((p) => p.number === 29);
  assert.deepStrictEqual(p29?.done, true, "ms roadmap: phase 29 done");
  const p30 = v25?.phases.find((p) => p.number === 30);
  assert.deepStrictEqual(p30?.done, false, "ms roadmap: phase 30 not done");
});
test("parseOldPlan: XML-in-markdown", () => {
  const plan = parseOldPlan(SAMPLE_PLAN_XML, "29-01-PLAN.md", "01");
  assert.ok(plan.objective.includes("authentication"), "plan: objective extracted");
  assert.deepStrictEqual(plan.tasks.length, 3, "plan: 3 tasks");
  assert.ok(plan.tasks[0].includes("auth middleware"), "plan: first task content");
  assert.ok(plan.context.includes("JWT"), "plan: context extracted");
  assert.ok(plan.verification.includes("Login returns"), "plan: verification extracted");
  assert.ok(plan.successCriteria.includes("endpoints respond"), "plan: success criteria extracted");
  assert.deepStrictEqual(plan.frontmatter.phase, "29-auth-system", "plan fm: phase");
  assert.deepStrictEqual(plan.frontmatter.plan, "01", "plan fm: plan");
  assert.deepStrictEqual(plan.frontmatter.type, "implementation", "plan fm: type");
  assert.deepStrictEqual(plan.frontmatter.wave, 1, "plan fm: wave");
  assert.deepStrictEqual(plan.frontmatter.autonomous, true, "plan fm: autonomous");
  assert.ok(plan.frontmatter.files_modified.length >= 2, "plan fm: files_modified");
  assert.ok(plan.frontmatter.must_haves !== null, "plan fm: must_haves parsed");
  assert.ok((plan.frontmatter.must_haves?.truths.length ?? 0) >= 1, "plan fm: must_haves truths");
  assert.ok((plan.frontmatter.must_haves?.artifacts.length ?? 0) >= 1, "plan fm: must_haves artifacts");
});
test("parseOldPlan: plain markdown (no XML tags)", () => {
  const plainPlan = `# 001: Fix Login Bug

## Description

Fix the login button not responding on mobile.

## Steps

1. Debug click handler
2. Fix event propagation
`;
  const plan = parseOldPlan(plainPlan, "001-PLAN.md", "001");
  assert.deepStrictEqual(plan.objective, "", "plain plan: no objective (no XML)");
  assert.deepStrictEqual(plan.tasks.length, 0, "plain plan: no tasks (no XML)");
  assert.deepStrictEqual(plan.frontmatter.phase, "", "plain plan: no frontmatter phase");
});
test("parseOldSummary: YAML frontmatter", () => {
  const summary = parseOldSummary(SAMPLE_SUMMARY, "29-01-SUMMARY.md", "01");
  assert.deepStrictEqual(summary.frontmatter.phase, "29-auth-system", "summary fm: phase");
  assert.deepStrictEqual(summary.frontmatter.plan, "01", "summary fm: plan");
  assert.deepStrictEqual(summary.frontmatter.subsystem, "auth", "summary fm: subsystem");
  assert.deepStrictEqual(summary.frontmatter.tags, ["authentication", "security"], "summary fm: tags");
  assert.deepStrictEqual(summary.frontmatter.provides, ["auth-middleware", "jwt-validation"], "summary fm: provides");
  assert.deepStrictEqual(summary.frontmatter.affects, ["api-routes"], "summary fm: affects");
  assert.deepStrictEqual(summary.frontmatter["tech-stack"], ["jsonwebtoken", "express"], "summary fm: tech-stack");
  assert.deepStrictEqual(summary.frontmatter["key-files"], ["src/auth.ts", "src/middleware/auth.ts"], "summary fm: key-files");
  assert.deepStrictEqual(summary.frontmatter["key-decisions"], ["Use RS256 for JWT signing", "Store refresh tokens in DB"], "summary fm: key-decisions");
  assert.deepStrictEqual(summary.frontmatter["patterns-established"], ["Middleware-based auth"], "summary fm: patterns-established");
  assert.deepStrictEqual(summary.frontmatter.duration, "2h", "summary fm: duration");
  assert.deepStrictEqual(summary.frontmatter.completed, "2026-01-15", "summary fm: completed");
  assert.ok(summary.body.includes("Auth Implementation Summary"), "summary: body content present");
});
test("parseOldRequirements", () => {
  const reqs = parseOldRequirements(SAMPLE_REQUIREMENTS);
  assert.deepStrictEqual(reqs.length, 4, "requirements: 4 entries");
  assert.deepStrictEqual(reqs[0].id, "R001", "req 0: id");
  assert.deepStrictEqual(reqs[0].title, "User Authentication", "req 0: title");
  assert.deepStrictEqual(reqs[0].status, "active", "req 0: status");
  assert.ok(reqs[0].description.includes("log in"), "req 0: description");
  assert.deepStrictEqual(reqs[2].id, "R003", "req 2: id");
  assert.deepStrictEqual(reqs[2].status, "validated", "req 2: status");
  assert.deepStrictEqual(reqs[3].id, "R004", "req 3: id");
  assert.deepStrictEqual(reqs[3].status, "deferred", "req 3: status");
});
test("parseOldState", () => {
  const state = parseOldState(SAMPLE_STATE);
  assert.ok(state.currentPhase?.includes("30") ?? false, "state: current phase includes 30");
  assert.deepStrictEqual(state.status, "in-progress", "state: status");
  assert.ok(state.raw === SAMPLE_STATE, "state: raw preserved");
});
test("parseOldConfig: valid JSON", () => {
  const config = parseOldConfig('{"projectName":"test","version":"1.0"}');
  assert.ok(config !== null, "config: parsed");
  assert.deepStrictEqual(config?.projectName, "test", "config: projectName");
});
test("parseOldConfig: invalid JSON \u2192 null", () => {
  const config = parseOldConfig("not json at all {{{");
  assert.deepStrictEqual(config, null, "config: invalid JSON returns null");
});
test("parseOldConfig: non-object JSON \u2192 null", () => {
  const config = parseOldConfig('"just a string"');
  assert.deepStrictEqual(config, null, "config: non-object returns null");
});
test("parseOldProject", () => {
  const project = parseOldProject(SAMPLE_PROJECT);
  assert.deepStrictEqual(project, SAMPLE_PROJECT, "project: returns raw content");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9taWdyYXRlLXZhbGlkYXRvci1wYXJzZXJzLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFVuaXQgdGVzdHMgZm9yIFQwMjogdmFsaWRhdG9yIGFuZCBwZXItZmlsZSBwYXJzZXJzXG4vLyBUZXN0cyB0aGVzZSBpbmRlcGVuZGVudGx5IG9mIHRoZSBUMDMgb3JjaGVzdHJhdG9yIChwYXJzZVBsYW5uaW5nRGlyZWN0b3J5KS5cblxuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSAnbm9kZTpmcyc7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJztcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gJ25vZGU6b3MnO1xuXG5pbXBvcnQgeyB2YWxpZGF0ZVBsYW5uaW5nRGlyZWN0b3J5IH0gZnJvbSAnLi4vbWlncmF0ZS92YWxpZGF0b3IudHMnO1xuaW1wb3J0IHtcbiAgcGFyc2VPbGRSb2FkbWFwLFxuICBwYXJzZU9sZFBsYW4sXG4gIHBhcnNlT2xkU3VtbWFyeSxcbiAgcGFyc2VPbGRSZXF1aXJlbWVudHMsXG4gIHBhcnNlT2xkUHJvamVjdCxcbiAgcGFyc2VPbGRTdGF0ZSxcbiAgcGFyc2VPbGRDb25maWcsXG59IGZyb20gJy4uL21pZ3JhdGUvcGFyc2Vycy50cyc7XG5pbXBvcnQgeyBkZXNjcmliZSwgdGVzdCwgYmVmb3JlRWFjaCwgYWZ0ZXJFYWNoIH0gZnJvbSAnbm9kZTp0ZXN0JztcbmltcG9ydCBhc3NlcnQgZnJvbSAnbm9kZTphc3NlcnQvc3RyaWN0JztcblxuZnVuY3Rpb24gY3JlYXRlRml4dHVyZUJhc2UoKTogc3RyaW5nIHtcbiAgcmV0dXJuIG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksICdnc2QtbWlncmF0ZS10MDItJykpO1xufVxuZnVuY3Rpb24gY3JlYXRlUGxhbm5pbmdEaXIoYmFzZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgZGlyID0gam9pbihiYXNlLCAnLnBsYW5uaW5nJyk7XG4gIG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICByZXR1cm4gZGlyO1xufVxuZnVuY3Rpb24gY2xlYW51cChiYXNlOiBzdHJpbmcpOiB2b2lkIHtcbiAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFNhbXBsZSBGaXh0dXJlcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuY29uc3QgU0FNUExFX1JPQURNQVAgPSBgIyBQcm9qZWN0IFJvYWRtYXBcblxuIyMgUGhhc2VzXG5cbi0gW3hdIDI5IFx1MjAxNCBBdXRoIFN5c3RlbVxuLSBbIF0gMzAgXHUyMDE0IERhc2hib2FyZFxuLSBbIF0gMzEgXHUyMDE0IE5vdGlmaWNhdGlvbnNcbmA7XG5cbmNvbnN0IFNBTVBMRV9WRVJTSU9OX1BSRUZJWF9ST0FETUFQID0gYCMgUHJvamVjdCBSb2FkbWFwXG5cbiMjIFBoYXNlc1xuXG4tIFx1MjcwNSAqKnYxLjAgTVZQKiogXHUyMDE0IFBoYXNlcyAxLTYgKHNoaXBwZWQgMjAyNi0wMi0yNClcbi0gXHUyNzA1ICoqdjEuMSBPbmJvYXJkaW5nKiogXHUyMDE0IFBoYXNlcyA3LTkgKHNoaXBwZWQgMjAyNi0wMy0wMSlcbi0gXHVEODNEXHVERUE3ICoqdjEuOCBQcm9kdWN0aW9uKiogXHUyMDE0IFBoYXNlcyA0NC01M1xuYDtcblxuY29uc3QgU0FNUExFX1BST0pFQ1QgPSBgIyBNeSBQcm9qZWN0XG5cbkEgc2FtcGxlIHByb2plY3QgZm9yIHRlc3RpbmcgdGhlIG1pZ3JhdGlvbiBwYXJzZXIuXG5gO1xuXG5jb25zdCBTQU1QTEVfTUlMRVNUT05FX1NFQ1RJT05FRF9ST0FETUFQID0gYCMgUHJvamVjdCBSb2FkbWFwXG5cbiMjIHYyLjAgXHUyMDE0IEZvdW5kYXRpb25cblxuPGRldGFpbHM+XG48c3VtbWFyeT5Db21wbGV0ZWQ8L3N1bW1hcnk+XG5cbi0gW3hdIDAxIFx1MjAxNCBQcm9qZWN0IFNldHVwXG4tIFt4XSAwMiBcdTIwMTQgRGF0YWJhc2UgU2NoZW1hXG5cbjwvZGV0YWlscz5cblxuIyMgdjIuNSBcdTIwMTQgRmVhdHVyZXNcblxuLSBbeF0gMjkgXHUyMDE0IEF1dGggU3lzdGVtXG4tIFsgXSAzMCBcdTIwMTQgRGFzaGJvYXJkXG4tIFsgXSAzMSBcdTIwMTQgTm90aWZpY2F0aW9uc1xuYDtcblxuY29uc3QgU0FNUExFX1BMQU5fWE1MID0gYC0tLVxucGhhc2U6IFwiMjktYXV0aC1zeXN0ZW1cIlxucGxhbjogXCIwMVwiXG50eXBlOiBcImltcGxlbWVudGF0aW9uXCJcbndhdmU6IDFcbmRlcGVuZHNfb246IFtdXG5maWxlc19tb2RpZmllZDogW3NyYy9hdXRoLnRzLCBzcmMvbG9naW4udHNdXG5hdXRvbm9tb3VzOiB0cnVlXG5tdXN0X2hhdmVzOlxuICB0cnV0aHM6XG4gICAgLSBVc2VycyBjYW4gbG9nIGluXG4gIGFydGlmYWN0czpcbiAgICAtIHNyYy9hdXRoLnRzXG4gIGtleV9saW5rczogW11cbi0tLVxuXG4jIDI5LTAxOiBJbXBsZW1lbnQgQXV0aFxuXG48b2JqZWN0aXZlPlxuQnVpbGQgdGhlIGF1dGhlbnRpY2F0aW9uIHN5c3RlbSB3aXRoIEpXVCB0b2tlbnMgYW5kIHNlc3Npb24gbWFuYWdlbWVudC5cbjwvb2JqZWN0aXZlPlxuXG48dGFza3M+XG48dGFzaz5DcmVhdGUgYXV0aCBtaWRkbGV3YXJlPC90YXNrPlxuPHRhc2s+QWRkIGxvZ2luIGVuZHBvaW50PC90YXNrPlxuPHRhc2s+QWRkIGxvZ291dCBlbmRwb2ludDwvdGFzaz5cbjwvdGFza3M+XG5cbjxjb250ZXh0PlxuVGhlIHByb2plY3QgbmVlZHMgYXV0aGVudGljYXRpb24gYmVmb3JlIGFueSBvdGhlciBmZWF0dXJlcyBjYW4gYmUgYnVpbHQuXG5BdXRoIHRva2VucyB1c2UgSldUIHdpdGggUlMyNTYgc2lnbmluZy5cbjwvY29udGV4dD5cblxuPHZlcmlmaWNhdGlvbj5cbi0gTG9naW4gcmV0dXJucyB2YWxpZCBKV1Rcbi0gTWlkZGxld2FyZSByZWplY3RzIGludmFsaWQgdG9rZW5zXG4tIExvZ291dCBpbnZhbGlkYXRlcyBzZXNzaW9uXG48L3ZlcmlmaWNhdGlvbj5cblxuPHN1Y2Nlc3NfY3JpdGVyaWE+XG5BbGwgYXV0aCBlbmRwb2ludHMgcmVzcG9uZCBjb3JyZWN0bHkgYW5kIHRva2VucyBhcmUgdmFsaWRhdGVkLlxuPC9zdWNjZXNzX2NyaXRlcmlhPlxuYDtcblxuY29uc3QgU0FNUExFX1NVTU1BUlkgPSBgLS0tXG5waGFzZTogXCIyOS1hdXRoLXN5c3RlbVwiXG5wbGFuOiBcIjAxXCJcbnN1YnN5c3RlbTogXCJhdXRoXCJcbnRhZ3M6XG4gIC0gYXV0aGVudGljYXRpb25cbiAgLSBzZWN1cml0eVxucmVxdWlyZXM6IFtdXG5wcm92aWRlczpcbiAgLSBhdXRoLW1pZGRsZXdhcmVcbiAgLSBqd3QtdmFsaWRhdGlvblxuYWZmZWN0czpcbiAgLSBhcGktcm91dGVzXG50ZWNoLXN0YWNrOlxuICAtIGpzb253ZWJ0b2tlblxuICAtIGV4cHJlc3NcbmtleS1maWxlczpcbiAgLSBzcmMvYXV0aC50c1xuICAtIHNyYy9taWRkbGV3YXJlL2F1dGgudHNcbmtleS1kZWNpc2lvbnM6XG4gIC0gVXNlIFJTMjU2IGZvciBKV1Qgc2lnbmluZ1xuICAtIFN0b3JlIHJlZnJlc2ggdG9rZW5zIGluIERCXG5wYXR0ZXJucy1lc3RhYmxpc2hlZDpcbiAgLSBNaWRkbGV3YXJlLWJhc2VkIGF1dGhcbmR1cmF0aW9uOiBcIjJoXCJcbmNvbXBsZXRlZDogXCIyMDI2LTAxLTE1XCJcbi0tLVxuXG4jIDI5LTAxOiBBdXRoIEltcGxlbWVudGF0aW9uIFN1bW1hcnlcblxuQXV0aGVudGljYXRpb24gc3lzdGVtIGltcGxlbWVudGVkIHdpdGggSldUIHRva2Vucy5cbmA7XG5cbmNvbnN0IFNBTVBMRV9SRVFVSVJFTUVOVFMgPSBgIyBSZXF1aXJlbWVudHNcblxuIyMgQWN0aXZlXG5cbiMjIyBSMDAxIFx1MjAxNCBVc2VyIEF1dGhlbnRpY2F0aW9uXG4tIFN0YXR1czogYWN0aXZlXG4tIERlc2NyaXB0aW9uOiBVc2VycyBtdXN0IGJlIGFibGUgdG8gbG9nIGluLlxuXG4jIyMgUjAwMiBcdTIwMTQgRGFzaGJvYXJkIFZpZXdcbi0gU3RhdHVzOiBhY3RpdmVcbi0gRGVzY3JpcHRpb246IE1haW4gZGFzaGJvYXJkIHBhZ2UuXG5cbiMjIFZhbGlkYXRlZFxuXG4jIyMgUjAwMyBcdTIwMTQgU2Vzc2lvbiBNYW5hZ2VtZW50XG4tIFN0YXR1czogdmFsaWRhdGVkXG4tIERlc2NyaXB0aW9uOiBTZXNzaW9ucyBleHBpcmUgYWZ0ZXIgMjRoLlxuXG4jIyBEZWZlcnJlZFxuXG4jIyMgUjAwNCBcdTIwMTQgT0F1dGggU3VwcG9ydFxuLSBTdGF0dXM6IGRlZmVycmVkXG4tIERlc2NyaXB0aW9uOiBUaGlyZC1wYXJ0eSBsb2dpbi5cbmA7XG5cbmNvbnN0IFNBTVBMRV9TVEFURSA9IGAjIFN0YXRlXG5cbioqQ3VycmVudCBQaGFzZToqKiAzMC1kYXNoYm9hcmRcbioqU3RhdHVzOioqIGluLXByb2dyZXNzXG5gO1xuXG4gIC8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuICAvLyBWYWxpZGF0b3IgVGVzdHNcbiAgLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbnRlc3QoJ1ZhbGlkYXRvcjogbWlzc2luZyBkaXJlY3RvcnkgXHUyMTkyIGZhdGFsJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCB2YWxpZGF0ZVBsYW5uaW5nRGlyZWN0b3J5KGpvaW4oYmFzZSwgJ25vbmV4aXN0ZW50JykpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQudmFsaWQsIGZhbHNlLCAnbWlzc2luZyBkaXI6IHZhbGlkYXRpb24gZmFpbHMnKTtcbiAgICAgIGFzc2VydC5vayhyZXN1bHQuaXNzdWVzLmxlbmd0aCA+IDAsICdtaXNzaW5nIGRpcjogaGFzIGlzc3VlcycpO1xuICAgICAgYXNzZXJ0Lm9rKHJlc3VsdC5pc3N1ZXMuc29tZShpID0+IGkuc2V2ZXJpdHkgPT09ICdmYXRhbCcpLCAnbWlzc2luZyBkaXI6IGhhcyBmYXRhbCBpc3N1ZScpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbn0pO1xuXG50ZXN0KCdWYWxpZGF0b3I6IG1pc3NpbmcgUk9BRE1BUC5tZCBcdTIxOTIgd2FybmluZyAobm90IGZhdGFsKScsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcGxhbm5pbmcgPSBjcmVhdGVQbGFubmluZ0RpcihiYXNlKTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihwbGFubmluZywgJ1BST0pFQ1QubWQnKSwgU0FNUExFX1BST0pFQ1QpO1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgdmFsaWRhdGVQbGFubmluZ0RpcmVjdG9yeShwbGFubmluZyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC52YWxpZCwgdHJ1ZSwgJ25vIHJvYWRtYXA6IHZhbGlkYXRpb24gc3RpbGwgcGFzc2VzJyk7XG4gICAgICBhc3NlcnQub2socmVzdWx0Lmlzc3Vlcy5zb21lKGkgPT4gaS5zZXZlcml0eSA9PT0gJ3dhcm5pbmcnICYmIGkuZmlsZS5pbmNsdWRlcygnUk9BRE1BUCcpKSwgJ25vIHJvYWRtYXA6IHdhcm5pbmcgaXNzdWUgbWVudGlvbnMgUk9BRE1BUCcpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbn0pO1xuXG50ZXN0KCdWYWxpZGF0b3I6IG1pc3NpbmcgUFJPSkVDVC5tZCBcdTIxOTIgd2FybmluZycsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcGxhbm5pbmcgPSBjcmVhdGVQbGFubmluZ0RpcihiYXNlKTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihwbGFubmluZywgJ1JPQURNQVAubWQnKSwgU0FNUExFX1JPQURNQVApO1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgdmFsaWRhdGVQbGFubmluZ0RpcmVjdG9yeShwbGFubmluZyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC52YWxpZCwgdHJ1ZSwgJ25vIHByb2plY3Q6IHZhbGlkYXRpb24gcGFzc2VzICh3YXJuaW5nIG9ubHkpJyk7XG4gICAgICBhc3NlcnQub2socmVzdWx0Lmlzc3Vlcy5zb21lKGkgPT4gaS5zZXZlcml0eSA9PT0gJ3dhcm5pbmcnICYmIGkuZmlsZS5pbmNsdWRlcygnUFJPSkVDVCcpKSwgJ25vIHByb2plY3Q6IHdhcm5pbmcgaXNzdWUgbWVudGlvbnMgUFJPSkVDVCcpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbn0pO1xuXG50ZXN0KCdWYWxpZGF0b3I6IGNvbXBsZXRlIGRpcmVjdG9yeSBcdTIxOTIgdmFsaWQgd2l0aCBubyBpc3N1ZXMnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHBsYW5uaW5nID0gY3JlYXRlUGxhbm5pbmdEaXIoYmFzZSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4ocGxhbm5pbmcsICdST0FETUFQLm1kJyksIFNBTVBMRV9ST0FETUFQKTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihwbGFubmluZywgJ1BST0pFQ1QubWQnKSwgU0FNUExFX1BST0pFQ1QpO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHBsYW5uaW5nLCAnUkVRVUlSRU1FTlRTLm1kJyksIFNBTVBMRV9SRVFVSVJFTUVOVFMpO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHBsYW5uaW5nLCAnU1RBVEUubWQnKSwgU0FNUExFX1NUQVRFKTtcbiAgICAgIG1rZGlyU3luYyhqb2luKHBsYW5uaW5nLCAncGhhc2VzJyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgdmFsaWRhdGVQbGFubmluZ0RpcmVjdG9yeShwbGFubmluZyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC52YWxpZCwgdHJ1ZSwgJ2NvbXBsZXRlIGRpcjogdmFsaWRhdGlvbiBwYXNzZXMnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0Lmlzc3Vlcy5sZW5ndGgsIDAsICdjb21wbGV0ZSBkaXI6IG5vIGlzc3VlcycpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbn0pO1xuXG4gIC8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuICAvLyBSb2FkbWFwIFBhcnNlciBUZXN0c1xuICAvLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxudGVzdCgncGFyc2VPbGRSb2FkbWFwOiBmbGF0IGZvcm1hdCcsICgpID0+IHtcbiAgICBjb25zdCByb2FkbWFwID0gcGFyc2VPbGRSb2FkbWFwKFNBTVBMRV9ST0FETUFQKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJvYWRtYXAubWlsZXN0b25lcy5sZW5ndGgsIDAsICdmbGF0IHJvYWRtYXA6IG5vIG1pbGVzdG9uZSBzZWN0aW9ucycpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocm9hZG1hcC5waGFzZXMubGVuZ3RoLCAzLCAnZmxhdCByb2FkbWFwOiAzIHBoYXNlcycpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocm9hZG1hcC5waGFzZXNbMF0ubnVtYmVyLCAyOSwgJ2ZsYXQgcm9hZG1hcDogZmlyc3QgcGhhc2UgbnVtYmVyJyk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyb2FkbWFwLnBoYXNlc1swXS50aXRsZSwgJ0F1dGggU3lzdGVtJywgJ2ZsYXQgcm9hZG1hcDogZmlyc3QgcGhhc2UgdGl0bGUnKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJvYWRtYXAucGhhc2VzWzBdLmRvbmUsIHRydWUsICdmbGF0IHJvYWRtYXA6IGZpcnN0IHBoYXNlIGRvbmUnKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJvYWRtYXAucGhhc2VzWzFdLmRvbmUsIGZhbHNlLCAnZmxhdCByb2FkbWFwOiBzZWNvbmQgcGhhc2Ugbm90IGRvbmUnKTtcbn0pO1xuXG50ZXN0KCdwYXJzZU9sZFJvYWRtYXA6IGVtb2ppIHZlcnNpb24tcHJlZml4IHBoYXNlIHJhbmdlcycsICgpID0+IHtcbiAgICBjb25zdCByb2FkbWFwID0gcGFyc2VPbGRSb2FkbWFwKFNBTVBMRV9WRVJTSU9OX1BSRUZJWF9ST0FETUFQKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJvYWRtYXAubWlsZXN0b25lcy5sZW5ndGgsIDAsICd2ZXJzaW9uIHJvYWRtYXA6IG5vIG1pbGVzdG9uZSBzZWN0aW9ucycpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocm9hZG1hcC5waGFzZXMubGVuZ3RoLCAzLCAndmVyc2lvbiByb2FkbWFwOiAzIHBoYXNlIHJhbmdlcycpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocm9hZG1hcC5waGFzZXNbMF0ubnVtYmVyLCAxLCAndmVyc2lvbiByb2FkbWFwOiBmaXJzdCByYW5nZSBzdGFydHMgYXQgcGhhc2UgMScpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocm9hZG1hcC5waGFzZXNbMF0udGl0bGUsICdNVlAnLCAndmVyc2lvbiByb2FkbWFwOiBmaXJzdCB0aXRsZScpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocm9hZG1hcC5waGFzZXNbMF0uZG9uZSwgdHJ1ZSwgJ3ZlcnNpb24gcm9hZG1hcDogZmlyc3QgcmFuZ2UgZG9uZScpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocm9hZG1hcC5waGFzZXNbMV0ubnVtYmVyLCA3LCAndmVyc2lvbiByb2FkbWFwOiBzZWNvbmQgcmFuZ2Ugc3RhcnRzIGF0IHBoYXNlIDcnKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJvYWRtYXAucGhhc2VzWzFdLnRpdGxlLCAnT25ib2FyZGluZycsICd2ZXJzaW9uIHJvYWRtYXA6IHNlY29uZCB0aXRsZScpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocm9hZG1hcC5waGFzZXNbMV0uZG9uZSwgdHJ1ZSwgJ3ZlcnNpb24gcm9hZG1hcDogc2Vjb25kIHJhbmdlIGRvbmUnKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJvYWRtYXAucGhhc2VzWzJdLm51bWJlciwgNDQsICd2ZXJzaW9uIHJvYWRtYXA6IHRoaXJkIHJhbmdlIHN0YXJ0cyBhdCBwaGFzZSA0NCcpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocm9hZG1hcC5waGFzZXNbMl0udGl0bGUsICdQcm9kdWN0aW9uJywgJ3ZlcnNpb24gcm9hZG1hcDogdGhpcmQgdGl0bGUnKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJvYWRtYXAucGhhc2VzWzJdLmRvbmUsIGZhbHNlLCAndmVyc2lvbiByb2FkbWFwOiB0aGlyZCByYW5nZSBpbiBwcm9ncmVzcycpO1xufSk7XG5cbnRlc3QoJ3BhcnNlT2xkUm9hZG1hcDogbWlsZXN0b25lLXNlY3Rpb25lZCB3aXRoIDxkZXRhaWxzPicsICgpID0+IHtcbiAgICBjb25zdCByb2FkbWFwID0gcGFyc2VPbGRSb2FkbWFwKFNBTVBMRV9NSUxFU1RPTkVfU0VDVElPTkVEX1JPQURNQVApO1xuICAgIGFzc2VydC5vayhyb2FkbWFwLm1pbGVzdG9uZXMubGVuZ3RoID49IDIsICdtcyByb2FkbWFwOiBoYXMgbWlsZXN0b25lIHNlY3Rpb25zJyk7XG5cbiAgICBjb25zdCB2MjAgPSByb2FkbWFwLm1pbGVzdG9uZXMuZmluZChtID0+IG0uaWQuaW5jbHVkZXMoJzIuMCcpKTtcbiAgICBhc3NlcnQub2sodjIwICE9PSB1bmRlZmluZWQsICdtcyByb2FkbWFwOiB2Mi4wIGZvdW5kJyk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbCh2MjA/LmNvbGxhcHNlZCwgdHJ1ZSwgJ21zIHJvYWRtYXA6IHYyLjAgY29sbGFwc2VkJyk7XG4gICAgYXNzZXJ0Lm9rKCh2MjA/LnBoYXNlcy5sZW5ndGggPz8gMCkgPj0gMiwgJ21zIHJvYWRtYXA6IHYyLjAgaGFzIHBoYXNlcycpO1xuICAgIGFzc2VydC5vayh2MjA/LnBoYXNlcy5ldmVyeShwID0+IHAuZG9uZSkgPz8gZmFsc2UsICdtcyByb2FkbWFwOiB2Mi4wIGFsbCBkb25lJyk7XG5cbiAgICBjb25zdCB2MjUgPSByb2FkbWFwLm1pbGVzdG9uZXMuZmluZChtID0+IG0uaWQuaW5jbHVkZXMoJzIuNScpKTtcbiAgICBhc3NlcnQub2sodjI1ICE9PSB1bmRlZmluZWQsICdtcyByb2FkbWFwOiB2Mi41IGZvdW5kJyk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbCh2MjU/LmNvbGxhcHNlZCwgZmFsc2UsICdtcyByb2FkbWFwOiB2Mi41IG5vdCBjb2xsYXBzZWQnKTtcbiAgICBhc3NlcnQub2soKHYyNT8ucGhhc2VzLmxlbmd0aCA/PyAwKSA+PSAzLCAnbXMgcm9hZG1hcDogdjIuNSBoYXMgMyBwaGFzZXMnKTtcblxuICAgIGNvbnN0IHAyOSA9IHYyNT8ucGhhc2VzLmZpbmQocCA9PiBwLm51bWJlciA9PT0gMjkpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocDI5Py5kb25lLCB0cnVlLCAnbXMgcm9hZG1hcDogcGhhc2UgMjkgZG9uZScpO1xuICAgIGNvbnN0IHAzMCA9IHYyNT8ucGhhc2VzLmZpbmQocCA9PiBwLm51bWJlciA9PT0gMzApO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocDMwPy5kb25lLCBmYWxzZSwgJ21zIHJvYWRtYXA6IHBoYXNlIDMwIG5vdCBkb25lJyk7XG59KTtcblxuICAvLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbiAgLy8gUGxhbiBQYXJzZXIgVGVzdHNcbiAgLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbnRlc3QoJ3BhcnNlT2xkUGxhbjogWE1MLWluLW1hcmtkb3duJywgKCkgPT4ge1xuICAgIGNvbnN0IHBsYW4gPSBwYXJzZU9sZFBsYW4oU0FNUExFX1BMQU5fWE1MLCAnMjktMDEtUExBTi5tZCcsICcwMScpO1xuICAgIGFzc2VydC5vayhwbGFuLm9iamVjdGl2ZS5pbmNsdWRlcygnYXV0aGVudGljYXRpb24nKSwgJ3BsYW46IG9iamVjdGl2ZSBleHRyYWN0ZWQnKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBsYW4udGFza3MubGVuZ3RoLCAzLCAncGxhbjogMyB0YXNrcycpO1xuICAgIGFzc2VydC5vayhwbGFuLnRhc2tzWzBdLmluY2x1ZGVzKCdhdXRoIG1pZGRsZXdhcmUnKSwgJ3BsYW46IGZpcnN0IHRhc2sgY29udGVudCcpO1xuICAgIGFzc2VydC5vayhwbGFuLmNvbnRleHQuaW5jbHVkZXMoJ0pXVCcpLCAncGxhbjogY29udGV4dCBleHRyYWN0ZWQnKTtcbiAgICBhc3NlcnQub2socGxhbi52ZXJpZmljYXRpb24uaW5jbHVkZXMoJ0xvZ2luIHJldHVybnMnKSwgJ3BsYW46IHZlcmlmaWNhdGlvbiBleHRyYWN0ZWQnKTtcbiAgICBhc3NlcnQub2socGxhbi5zdWNjZXNzQ3JpdGVyaWEuaW5jbHVkZXMoJ2VuZHBvaW50cyByZXNwb25kJyksICdwbGFuOiBzdWNjZXNzIGNyaXRlcmlhIGV4dHJhY3RlZCcpO1xuXG4gICAgLy8gRnJvbnRtYXR0ZXJcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBsYW4uZnJvbnRtYXR0ZXIucGhhc2UsICcyOS1hdXRoLXN5c3RlbScsICdwbGFuIGZtOiBwaGFzZScpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGxhbi5mcm9udG1hdHRlci5wbGFuLCAnMDEnLCAncGxhbiBmbTogcGxhbicpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGxhbi5mcm9udG1hdHRlci50eXBlLCAnaW1wbGVtZW50YXRpb24nLCAncGxhbiBmbTogdHlwZScpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGxhbi5mcm9udG1hdHRlci53YXZlLCAxLCAncGxhbiBmbTogd2F2ZScpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGxhbi5mcm9udG1hdHRlci5hdXRvbm9tb3VzLCB0cnVlLCAncGxhbiBmbTogYXV0b25vbW91cycpO1xuICAgIGFzc2VydC5vayhwbGFuLmZyb250bWF0dGVyLmZpbGVzX21vZGlmaWVkLmxlbmd0aCA+PSAyLCAncGxhbiBmbTogZmlsZXNfbW9kaWZpZWQnKTtcbiAgICBhc3NlcnQub2socGxhbi5mcm9udG1hdHRlci5tdXN0X2hhdmVzICE9PSBudWxsLCAncGxhbiBmbTogbXVzdF9oYXZlcyBwYXJzZWQnKTtcbiAgICBhc3NlcnQub2soKHBsYW4uZnJvbnRtYXR0ZXIubXVzdF9oYXZlcz8udHJ1dGhzLmxlbmd0aCA/PyAwKSA+PSAxLCAncGxhbiBmbTogbXVzdF9oYXZlcyB0cnV0aHMnKTtcbiAgICBhc3NlcnQub2soKHBsYW4uZnJvbnRtYXR0ZXIubXVzdF9oYXZlcz8uYXJ0aWZhY3RzLmxlbmd0aCA/PyAwKSA+PSAxLCAncGxhbiBmbTogbXVzdF9oYXZlcyBhcnRpZmFjdHMnKTtcbn0pO1xuXG50ZXN0KCdwYXJzZU9sZFBsYW46IHBsYWluIG1hcmtkb3duIChubyBYTUwgdGFncyknLCAoKSA9PiB7XG4gICAgY29uc3QgcGxhaW5QbGFuID0gYCMgMDAxOiBGaXggTG9naW4gQnVnXG5cbiMjIERlc2NyaXB0aW9uXG5cbkZpeCB0aGUgbG9naW4gYnV0dG9uIG5vdCByZXNwb25kaW5nIG9uIG1vYmlsZS5cblxuIyMgU3RlcHNcblxuMS4gRGVidWcgY2xpY2sgaGFuZGxlclxuMi4gRml4IGV2ZW50IHByb3BhZ2F0aW9uXG5gO1xuICAgIGNvbnN0IHBsYW4gPSBwYXJzZU9sZFBsYW4ocGxhaW5QbGFuLCAnMDAxLVBMQU4ubWQnLCAnMDAxJyk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwbGFuLm9iamVjdGl2ZSwgJycsICdwbGFpbiBwbGFuOiBubyBvYmplY3RpdmUgKG5vIFhNTCknKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBsYW4udGFza3MubGVuZ3RoLCAwLCAncGxhaW4gcGxhbjogbm8gdGFza3MgKG5vIFhNTCknKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBsYW4uZnJvbnRtYXR0ZXIucGhhc2UsICcnLCAncGxhaW4gcGxhbjogbm8gZnJvbnRtYXR0ZXIgcGhhc2UnKTtcbn0pO1xuXG4gIC8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuICAvLyBTdW1tYXJ5IFBhcnNlciBUZXN0c1xuICAvLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxudGVzdCgncGFyc2VPbGRTdW1tYXJ5OiBZQU1MIGZyb250bWF0dGVyJywgKCkgPT4ge1xuICAgIGNvbnN0IHN1bW1hcnkgPSBwYXJzZU9sZFN1bW1hcnkoU0FNUExFX1NVTU1BUlksICcyOS0wMS1TVU1NQVJZLm1kJywgJzAxJyk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdW1tYXJ5LmZyb250bWF0dGVyLnBoYXNlLCAnMjktYXV0aC1zeXN0ZW0nLCAnc3VtbWFyeSBmbTogcGhhc2UnKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN1bW1hcnkuZnJvbnRtYXR0ZXIucGxhbiwgJzAxJywgJ3N1bW1hcnkgZm06IHBsYW4nKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN1bW1hcnkuZnJvbnRtYXR0ZXIuc3Vic3lzdGVtLCAnYXV0aCcsICdzdW1tYXJ5IGZtOiBzdWJzeXN0ZW0nKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN1bW1hcnkuZnJvbnRtYXR0ZXIudGFncywgWydhdXRoZW50aWNhdGlvbicsICdzZWN1cml0eSddLCAnc3VtbWFyeSBmbTogdGFncycpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3VtbWFyeS5mcm9udG1hdHRlci5wcm92aWRlcywgWydhdXRoLW1pZGRsZXdhcmUnLCAnand0LXZhbGlkYXRpb24nXSwgJ3N1bW1hcnkgZm06IHByb3ZpZGVzJyk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdW1tYXJ5LmZyb250bWF0dGVyLmFmZmVjdHMsIFsnYXBpLXJvdXRlcyddLCAnc3VtbWFyeSBmbTogYWZmZWN0cycpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3VtbWFyeS5mcm9udG1hdHRlclsndGVjaC1zdGFjayddLCBbJ2pzb253ZWJ0b2tlbicsICdleHByZXNzJ10sICdzdW1tYXJ5IGZtOiB0ZWNoLXN0YWNrJyk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdW1tYXJ5LmZyb250bWF0dGVyWydrZXktZmlsZXMnXSwgWydzcmMvYXV0aC50cycsICdzcmMvbWlkZGxld2FyZS9hdXRoLnRzJ10sICdzdW1tYXJ5IGZtOiBrZXktZmlsZXMnKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN1bW1hcnkuZnJvbnRtYXR0ZXJbJ2tleS1kZWNpc2lvbnMnXSwgWydVc2UgUlMyNTYgZm9yIEpXVCBzaWduaW5nJywgJ1N0b3JlIHJlZnJlc2ggdG9rZW5zIGluIERCJ10sICdzdW1tYXJ5IGZtOiBrZXktZGVjaXNpb25zJyk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdW1tYXJ5LmZyb250bWF0dGVyWydwYXR0ZXJucy1lc3RhYmxpc2hlZCddLCBbJ01pZGRsZXdhcmUtYmFzZWQgYXV0aCddLCAnc3VtbWFyeSBmbTogcGF0dGVybnMtZXN0YWJsaXNoZWQnKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN1bW1hcnkuZnJvbnRtYXR0ZXIuZHVyYXRpb24sICcyaCcsICdzdW1tYXJ5IGZtOiBkdXJhdGlvbicpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3VtbWFyeS5mcm9udG1hdHRlci5jb21wbGV0ZWQsICcyMDI2LTAxLTE1JywgJ3N1bW1hcnkgZm06IGNvbXBsZXRlZCcpO1xuICAgIGFzc2VydC5vayhzdW1tYXJ5LmJvZHkuaW5jbHVkZXMoJ0F1dGggSW1wbGVtZW50YXRpb24gU3VtbWFyeScpLCAnc3VtbWFyeTogYm9keSBjb250ZW50IHByZXNlbnQnKTtcbn0pO1xuXG4gIC8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuICAvLyBSZXF1aXJlbWVudHMgUGFyc2VyIFRlc3RzXG4gIC8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG50ZXN0KCdwYXJzZU9sZFJlcXVpcmVtZW50cycsICgpID0+IHtcbiAgICBjb25zdCByZXFzID0gcGFyc2VPbGRSZXF1aXJlbWVudHMoU0FNUExFX1JFUVVJUkVNRU5UUyk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXFzLmxlbmd0aCwgNCwgJ3JlcXVpcmVtZW50czogNCBlbnRyaWVzJyk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXFzWzBdLmlkLCAnUjAwMScsICdyZXEgMDogaWQnKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlcXNbMF0udGl0bGUsICdVc2VyIEF1dGhlbnRpY2F0aW9uJywgJ3JlcSAwOiB0aXRsZScpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVxc1swXS5zdGF0dXMsICdhY3RpdmUnLCAncmVxIDA6IHN0YXR1cycpO1xuICAgIGFzc2VydC5vayhyZXFzWzBdLmRlc2NyaXB0aW9uLmluY2x1ZGVzKCdsb2cgaW4nKSwgJ3JlcSAwOiBkZXNjcmlwdGlvbicpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVxc1syXS5pZCwgJ1IwMDMnLCAncmVxIDI6IGlkJyk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXFzWzJdLnN0YXR1cywgJ3ZhbGlkYXRlZCcsICdyZXEgMjogc3RhdHVzJyk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXFzWzNdLmlkLCAnUjAwNCcsICdyZXEgMzogaWQnKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlcXNbM10uc3RhdHVzLCAnZGVmZXJyZWQnLCAncmVxIDM6IHN0YXR1cycpO1xufSk7XG5cbiAgLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4gIC8vIFN0YXRlIFBhcnNlciBUZXN0c1xuICAvLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxudGVzdCgncGFyc2VPbGRTdGF0ZScsICgpID0+IHtcbiAgICBjb25zdCBzdGF0ZSA9IHBhcnNlT2xkU3RhdGUoU0FNUExFX1NUQVRFKTtcbiAgICBhc3NlcnQub2soc3RhdGUuY3VycmVudFBoYXNlPy5pbmNsdWRlcygnMzAnKSA/PyBmYWxzZSwgJ3N0YXRlOiBjdXJyZW50IHBoYXNlIGluY2x1ZGVzIDMwJyk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5zdGF0dXMsICdpbi1wcm9ncmVzcycsICdzdGF0ZTogc3RhdHVzJyk7XG4gICAgYXNzZXJ0Lm9rKHN0YXRlLnJhdyA9PT0gU0FNUExFX1NUQVRFLCAnc3RhdGU6IHJhdyBwcmVzZXJ2ZWQnKTtcbn0pO1xuXG4gIC8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuICAvLyBDb25maWcgUGFyc2VyIFRlc3RzXG4gIC8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG50ZXN0KCdwYXJzZU9sZENvbmZpZzogdmFsaWQgSlNPTicsICgpID0+IHtcbiAgICBjb25zdCBjb25maWcgPSBwYXJzZU9sZENvbmZpZygne1wicHJvamVjdE5hbWVcIjpcInRlc3RcIixcInZlcnNpb25cIjpcIjEuMFwifScpO1xuICAgIGFzc2VydC5vayhjb25maWcgIT09IG51bGwsICdjb25maWc6IHBhcnNlZCcpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoY29uZmlnPy5wcm9qZWN0TmFtZSwgJ3Rlc3QnLCAnY29uZmlnOiBwcm9qZWN0TmFtZScpO1xufSk7XG5cbnRlc3QoJ3BhcnNlT2xkQ29uZmlnOiBpbnZhbGlkIEpTT04gXHUyMTkyIG51bGwnLCAoKSA9PiB7XG4gICAgY29uc3QgY29uZmlnID0gcGFyc2VPbGRDb25maWcoJ25vdCBqc29uIGF0IGFsbCB7e3snKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGNvbmZpZywgbnVsbCwgJ2NvbmZpZzogaW52YWxpZCBKU09OIHJldHVybnMgbnVsbCcpO1xufSk7XG5cbnRlc3QoJ3BhcnNlT2xkQ29uZmlnOiBub24tb2JqZWN0IEpTT04gXHUyMTkyIG51bGwnLCAoKSA9PiB7XG4gICAgY29uc3QgY29uZmlnID0gcGFyc2VPbGRDb25maWcoJ1wianVzdCBhIHN0cmluZ1wiJyk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChjb25maWcsIG51bGwsICdjb25maWc6IG5vbi1vYmplY3QgcmV0dXJucyBudWxsJyk7XG59KTtcblxuICAvLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbiAgLy8gUHJvamVjdCBQYXJzZXIgVGVzdHNcbiAgLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbnRlc3QoJ3BhcnNlT2xkUHJvamVjdCcsICgpID0+IHtcbiAgICBjb25zdCBwcm9qZWN0ID0gcGFyc2VPbGRQcm9qZWN0KFNBTVBMRV9QUk9KRUNUKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHByb2plY3QsIFNBTVBMRV9QUk9KRUNULCAncHJvamVjdDogcmV0dXJucyByYXcgY29udGVudCcpO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFHQSxTQUFTLGFBQWEsV0FBVyxRQUFRLHFCQUFxQjtBQUM5RCxTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBRXZCLFNBQVMsaUNBQWlDO0FBQzFDO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFDUCxTQUFtQixZQUFtQztBQUN0RCxPQUFPLFlBQVk7QUFFbkIsU0FBUyxvQkFBNEI7QUFDbkMsU0FBTyxZQUFZLEtBQUssT0FBTyxHQUFHLGtCQUFrQixDQUFDO0FBQ3ZEO0FBQ0EsU0FBUyxrQkFBa0IsTUFBc0I7QUFDL0MsUUFBTSxNQUFNLEtBQUssTUFBTSxXQUFXO0FBQ2xDLFlBQVUsS0FBSyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ2xDLFNBQU87QUFDVDtBQUNBLFNBQVMsUUFBUSxNQUFvQjtBQUNuQyxTQUFPLE1BQU0sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFDL0M7QUFJQSxNQUFNLGlCQUFpQjtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBU3ZCLE1BQU0sZ0NBQWdDO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFTdEMsTUFBTSxpQkFBaUI7QUFBQTtBQUFBO0FBQUE7QUFLdkIsTUFBTSxxQ0FBcUM7QUFBQTtBQUFB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
