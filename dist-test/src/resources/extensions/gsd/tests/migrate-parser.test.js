import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parsePlanningDirectory } from "../migrate/parser.js";
import { validatePlanningDirectory } from "../migrate/validator.js";
import { test } from "node:test";
import assert from "node:assert/strict";
function createFixtureBase() {
  return mkdtempSync(join(tmpdir(), "gsd-migrate-test-"));
}
function createPlanningDir(base) {
  const dir = join(base, ".planning");
  mkdirSync(dir, { recursive: true });
  return dir;
}
function writeFile(dir, ...pathParts) {
  return (content) => {
    const filePath = join(dir, ...pathParts);
    mkdirSync(join(filePath, ".."), { recursive: true });
    writeFileSync(filePath, content);
  };
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
const SAMPLE_PROJECT = `# My Project

A sample project for testing the migration parser.

## Goals

- Build a thing
- Ship it
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
const SAMPLE_CONFIG = JSON.stringify({
  projectName: "test-project",
  version: "1.0"
});
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

## What Happened

Built the auth middleware and login/logout endpoints.

## Files Modified

- \`src/auth.ts\` \u2014 Core auth logic
- \`src/middleware/auth.ts\` \u2014 Express middleware
`;
const SAMPLE_RESEARCH = `# Auth Research

## JWT vs Session Tokens

JWT tokens are stateless and work well for microservices.
Session tokens require server-side storage but are easier to revoke.

## Decision

Use JWT with short expiry + refresh tokens.
`;
const SAMPLE_MILESTONE_ROADMAP = `# Milestone v2.2 Roadmap

## Phases

- [x] 29 \u2014 Auth System
- [x] 30 \u2014 Dashboard
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
const SAMPLE_QUICK_PLAN = `# 001: Fix Login Bug

## Description

Fix the login button not responding on mobile.

## Steps

1. Debug click handler
2. Fix event propagation
3. Test on mobile
`;
const SAMPLE_QUICK_SUMMARY = `# 001: Fix Login Bug \u2014 Summary

Fixed the login button by correcting the touch event handler.
`;
test("Complete .planning directory with all file types", async () => {
  const base = createFixtureBase();
  try {
    const planning = createPlanningDir(base);
    writeFileSync(join(planning, "PROJECT.md"), SAMPLE_PROJECT);
    writeFileSync(join(planning, "ROADMAP.md"), SAMPLE_ROADMAP);
    writeFileSync(join(planning, "REQUIREMENTS.md"), SAMPLE_REQUIREMENTS);
    writeFileSync(join(planning, "STATE.md"), SAMPLE_STATE);
    writeFileSync(join(planning, "config.json"), SAMPLE_CONFIG);
    const phaseDir = join(planning, "phases", "29-auth-system");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(join(phaseDir, "29-01-PLAN.md"), SAMPLE_PLAN_XML);
    writeFileSync(join(phaseDir, "29-01-SUMMARY.md"), SAMPLE_SUMMARY);
    writeFileSync(join(phaseDir, "29-RESEARCH.md"), SAMPLE_RESEARCH);
    const phase2Dir = join(planning, "phases", "30-dashboard");
    mkdirSync(phase2Dir, { recursive: true });
    writeFileSync(join(phase2Dir, "30-01-PLAN.md"), `---
phase: "30-dashboard"
plan: "01"
type: "implementation"
wave: 1
depends_on: [29-01]
files_modified: []
autonomous: false
---

# 30-01: Build Dashboard

<objective>
Create the main dashboard view.
</objective>

<tasks>
<task>Create dashboard component</task>
<task>Add data fetching</task>
</tasks>

<context>
Dashboard needs auth to be complete first.
</context>
`);
    const quickDir = join(planning, "quick", "001-fix-login");
    mkdirSync(quickDir, { recursive: true });
    writeFileSync(join(quickDir, "001-PLAN.md"), SAMPLE_QUICK_PLAN);
    writeFileSync(join(quickDir, "001-SUMMARY.md"), SAMPLE_QUICK_SUMMARY);
    const msDir = join(planning, "milestones");
    mkdirSync(msDir, { recursive: true });
    writeFileSync(join(msDir, "v2.2-ROADMAP.md"), SAMPLE_MILESTONE_ROADMAP);
    writeFileSync(join(msDir, "v2.2-REQUIREMENTS.md"), "Milestone requirements here.");
    const researchDir = join(planning, "research");
    mkdirSync(researchDir, { recursive: true });
    writeFileSync(join(researchDir, "architecture.md"), "# Architecture Research\n\nNotes.");
    const project = await parsePlanningDirectory(planning);
    assert.deepStrictEqual(project.path, planning, "project.path matches");
    assert.ok(project.project !== null, "PROJECT.md parsed");
    assert.ok(project.roadmap !== null, "ROADMAP.md parsed");
    assert.ok(project.requirements.length > 0, "requirements parsed");
    assert.ok(project.state !== null, "STATE.md parsed");
    assert.ok(project.config !== null, "config.json parsed");
    assert.ok("29-auth-system" in project.phases, "phase 29 present");
    assert.ok("30-dashboard" in project.phases, "phase 30 present");
    const phase29 = project.phases["29-auth-system"];
    assert.deepStrictEqual(phase29?.number, 29, "phase 29 number");
    assert.deepStrictEqual(phase29?.slug, "auth-system", "phase 29 slug");
    assert.ok("01" in (phase29?.plans ?? {}), "phase 29 has plan 01");
    assert.ok("01" in (phase29?.summaries ?? {}), "phase 29 has summary 01");
    assert.ok((phase29?.research?.length ?? 0) > 0, "phase 29 has research");
    const plan29 = phase29?.plans?.["01"];
    assert.ok(plan29 !== void 0, "plan 29-01 exists");
    assert.ok(plan29?.objective?.includes("authentication") ?? false, "plan objective extracted");
    assert.ok((plan29?.tasks?.length ?? 0) >= 3, "plan tasks extracted");
    assert.ok(plan29?.context?.includes("JWT") ?? false, "plan context extracted");
    assert.ok(plan29?.verification !== "", "plan verification extracted");
    assert.ok(plan29?.successCriteria !== "", "plan success criteria extracted");
    assert.deepStrictEqual(plan29?.frontmatter?.phase, "29-auth-system", "plan frontmatter phase");
    assert.deepStrictEqual(plan29?.frontmatter?.plan, "01", "plan frontmatter plan");
    assert.deepStrictEqual(plan29?.frontmatter?.type, "implementation", "plan frontmatter type");
    assert.deepStrictEqual(plan29?.frontmatter?.wave, 1, "plan frontmatter wave");
    assert.deepStrictEqual(plan29?.frontmatter?.autonomous, true, "plan frontmatter autonomous");
    const summary29 = phase29?.summaries?.["01"];
    assert.ok(summary29 !== void 0, "summary 29-01 exists");
    assert.deepStrictEqual(summary29?.frontmatter?.phase, "29-auth-system", "summary frontmatter phase");
    assert.deepStrictEqual(summary29?.frontmatter?.plan, "01", "summary frontmatter plan");
    assert.deepStrictEqual(summary29?.frontmatter?.subsystem, "auth", "summary frontmatter subsystem");
    assert.ok((summary29?.frontmatter?.tags?.length ?? 0) >= 2, "summary frontmatter tags");
    assert.ok((summary29?.frontmatter?.provides?.length ?? 0) >= 2, "summary frontmatter provides");
    assert.ok((summary29?.frontmatter?.affects?.length ?? 0) >= 1, "summary frontmatter affects");
    assert.ok((summary29?.frontmatter?.["tech-stack"]?.length ?? 0) >= 2, "summary frontmatter tech-stack");
    assert.ok((summary29?.frontmatter?.["key-files"]?.length ?? 0) >= 2, "summary frontmatter key-files");
    assert.ok((summary29?.frontmatter?.["key-decisions"]?.length ?? 0) >= 2, "summary frontmatter key-decisions");
    assert.ok((summary29?.frontmatter?.["patterns-established"]?.length ?? 0) >= 1, "summary frontmatter patterns-established");
    assert.deepStrictEqual(summary29?.frontmatter?.duration, "2h", "summary frontmatter duration");
    assert.deepStrictEqual(summary29?.frontmatter?.completed, "2026-01-15", "summary frontmatter completed");
    assert.ok(project.quickTasks.length >= 1, "quick tasks parsed");
    assert.deepStrictEqual(project.quickTasks[0]?.number, 1, "quick task number");
    assert.ok(project.quickTasks[0]?.plan !== null, "quick task has plan");
    assert.ok(project.quickTasks[0]?.summary !== null, "quick task has summary");
    assert.ok(project.milestones.length >= 1, "milestones parsed");
    assert.ok(project.research.length >= 1, "root research parsed");
    assert.deepStrictEqual(project.config?.projectName, "test-project", "config projectName");
    assert.ok(project.state?.currentPhase?.includes("30") ?? false, "state current phase");
    assert.deepStrictEqual(project.state?.status, "in-progress", "state status");
    assert.deepStrictEqual(project.validation.valid, true, "validation passes for complete dir");
    assert.deepStrictEqual(project.validation.issues.length, 0, "no validation issues");
  } finally {
    cleanup(base);
  }
});
test("Minimal .planning directory (only ROADMAP.md)", async () => {
  const base = createFixtureBase();
  try {
    const planning = createPlanningDir(base);
    writeFileSync(join(planning, "ROADMAP.md"), SAMPLE_ROADMAP);
    const project = await parsePlanningDirectory(planning);
    assert.deepStrictEqual(project.project, null, "minimal: PROJECT.md is null");
    assert.ok(project.roadmap !== null, "minimal: ROADMAP.md parsed");
    assert.deepStrictEqual(project.requirements.length, 0, "minimal: no requirements");
    assert.deepStrictEqual(project.state, null, "minimal: no state");
    assert.deepStrictEqual(project.config, null, "minimal: no config");
    assert.deepStrictEqual(Object.keys(project.phases).length, 0, "minimal: no phases");
    assert.deepStrictEqual(project.quickTasks.length, 0, "minimal: no quick tasks");
    assert.deepStrictEqual(project.milestones.length, 0, "minimal: no milestones");
    assert.deepStrictEqual(project.research.length, 0, "minimal: no research");
    assert.deepStrictEqual(project.validation.valid, true, "minimal: validation passes");
  } finally {
    cleanup(base);
  }
});
test("Missing directory \u2192 validation returns fatal error", async () => {
  const base = createFixtureBase();
  try {
    const result = await validatePlanningDirectory(join(base, "nonexistent"));
    assert.deepStrictEqual(result.valid, false, "missing dir: validation fails");
    assert.ok(result.issues.length > 0, "missing dir: has issues");
    assert.ok(
      result.issues.some((i) => i.severity === "fatal"),
      "missing dir: has fatal issue"
    );
  } finally {
    cleanup(base);
  }
});
test("Phase directory with duplicate numbers", async () => {
  const base = createFixtureBase();
  try {
    const planning = createPlanningDir(base);
    writeFileSync(join(planning, "ROADMAP.md"), SAMPLE_ROADMAP);
    const phasesDir = join(planning, "phases");
    mkdirSync(join(phasesDir, "45-core-infrastructure"), { recursive: true });
    mkdirSync(join(phasesDir, "45-logging-config"), { recursive: true });
    writeFileSync(
      join(phasesDir, "45-core-infrastructure", "45-01-PLAN.md"),
      "# Core Plan\n\n<objective>Core infra</objective>"
    );
    writeFileSync(
      join(phasesDir, "45-logging-config", "45-01-PLAN.md"),
      "# Logging Plan\n\n<objective>Logging config</objective>"
    );
    const project = await parsePlanningDirectory(planning);
    assert.ok("45-core-infrastructure" in project.phases, "dup nums: core-infrastructure phase present");
    assert.ok("45-logging-config" in project.phases, "dup nums: logging-config phase present");
    assert.deepStrictEqual(project.phases["45-core-infrastructure"]?.number, 45, "dup nums: both have number 45 (a)");
    assert.deepStrictEqual(project.phases["45-logging-config"]?.number, 45, "dup nums: both have number 45 (b)");
  } finally {
    cleanup(base);
  }
});
test("Plan file with XML-in-markdown", async () => {
  const base = createFixtureBase();
  try {
    const planning = createPlanningDir(base);
    writeFileSync(join(planning, "ROADMAP.md"), SAMPLE_ROADMAP);
    const phaseDir = join(planning, "phases", "29-auth-system");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(join(phaseDir, "29-01-PLAN.md"), SAMPLE_PLAN_XML);
    const project = await parsePlanningDirectory(planning);
    const plan = project.phases["29-auth-system"]?.plans?.["01"];
    assert.ok(plan !== void 0, "xml plan: plan exists");
    assert.ok(plan?.objective?.includes("authentication") ?? false, "xml plan: objective extracted");
    assert.ok((plan?.tasks?.length ?? 0) === 3, "xml plan: 3 tasks extracted");
    assert.ok(plan?.tasks?.[0]?.includes("auth middleware") ?? false, "xml plan: first task content");
    assert.ok(plan?.context?.includes("JWT") ?? false, "xml plan: context extracted");
    assert.ok(plan?.verification?.includes("Login returns") ?? false, "xml plan: verification extracted");
    assert.ok(plan?.successCriteria?.includes("endpoints respond") ?? false, "xml plan: success criteria extracted");
  } finally {
    cleanup(base);
  }
});
test("Summary file with YAML frontmatter", async () => {
  const base = createFixtureBase();
  try {
    const planning = createPlanningDir(base);
    writeFileSync(join(planning, "ROADMAP.md"), SAMPLE_ROADMAP);
    const phaseDir = join(planning, "phases", "29-auth-system");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(join(phaseDir, "29-01-SUMMARY.md"), SAMPLE_SUMMARY);
    const project = await parsePlanningDirectory(planning);
    const summary = project.phases["29-auth-system"]?.summaries?.["01"];
    assert.ok(summary !== void 0, "summary fm: summary exists");
    assert.deepStrictEqual(summary?.frontmatter?.phase, "29-auth-system", "summary fm: phase");
    assert.deepStrictEqual(summary?.frontmatter?.plan, "01", "summary fm: plan");
    assert.deepStrictEqual(summary?.frontmatter?.subsystem, "auth", "summary fm: subsystem");
    assert.deepStrictEqual(summary?.frontmatter?.tags, ["authentication", "security"], "summary fm: tags");
    assert.deepStrictEqual(summary?.frontmatter?.provides, ["auth-middleware", "jwt-validation"], "summary fm: provides");
    assert.deepStrictEqual(summary?.frontmatter?.affects, ["api-routes"], "summary fm: affects");
    assert.deepStrictEqual(summary?.frontmatter?.["tech-stack"], ["jsonwebtoken", "express"], "summary fm: tech-stack");
    assert.deepStrictEqual(summary?.frontmatter?.["key-files"], ["src/auth.ts", "src/middleware/auth.ts"], "summary fm: key-files");
    assert.deepStrictEqual(summary?.frontmatter?.["key-decisions"], ["Use RS256 for JWT signing", "Store refresh tokens in DB"], "summary fm: key-decisions");
    assert.deepStrictEqual(summary?.frontmatter?.["patterns-established"], ["Middleware-based auth"], "summary fm: patterns-established");
    assert.deepStrictEqual(summary?.frontmatter?.duration, "2h", "summary fm: duration");
    assert.deepStrictEqual(summary?.frontmatter?.completed, "2026-01-15", "summary fm: completed");
  } finally {
    cleanup(base);
  }
});
test("Orphan summaries (no matching plan)", async () => {
  const base = createFixtureBase();
  try {
    const planning = createPlanningDir(base);
    writeFileSync(join(planning, "ROADMAP.md"), SAMPLE_ROADMAP);
    const phaseDir = join(planning, "phases", "45-logging-config");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(join(phaseDir, "45-04-SUMMARY.md"), `---
phase: "45-logging-config"
plan: "04"
subsystem: "logging"
---

# 45-04 Summary

Orphan summary content.
`);
    writeFileSync(join(phaseDir, "45-05-SUMMARY.md"), `---
phase: "45-logging-config"
plan: "05"
subsystem: "logging"
---

# 45-05 Summary

Another orphan.
`);
    const project = await parsePlanningDirectory(planning);
    const phase = project.phases["45-logging-config"];
    assert.ok(phase !== void 0, "orphan: phase exists");
    assert.deepStrictEqual(Object.keys(phase?.plans ?? {}).length, 0, "orphan: no plans");
    assert.ok(Object.keys(phase?.summaries ?? {}).length >= 2, "orphan: summaries preserved");
    assert.ok("04" in (phase?.summaries ?? {}), "orphan: summary 04 present");
    assert.ok("05" in (phase?.summaries ?? {}), "orphan: summary 05 present");
  } finally {
    cleanup(base);
  }
});
test(".archive/ directory \u2192 skipped by default", async () => {
  const base = createFixtureBase();
  try {
    const planning = createPlanningDir(base);
    writeFileSync(join(planning, "ROADMAP.md"), SAMPLE_ROADMAP);
    const phaseDir = join(planning, "phases", "29-auth-system");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(join(phaseDir, "29-01-PLAN.md"), SAMPLE_PLAN_XML);
    const archiveDir = join(planning, ".archive", "v2.5-deploy", "29-old-auth");
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(join(archiveDir, "29-01-PLAN.md"), "# Archived plan");
    const project = await parsePlanningDirectory(planning);
    assert.ok("29-auth-system" in project.phases, "archive: normal phase present");
    assert.ok(!Object.keys(project.phases).some((k) => k.includes("old-auth")), "archive: archived phase not present");
  } finally {
    cleanup(base);
  }
});
test("Quick tasks parsed", async () => {
  const base = createFixtureBase();
  try {
    const planning = createPlanningDir(base);
    writeFileSync(join(planning, "ROADMAP.md"), SAMPLE_ROADMAP);
    const qt1 = join(planning, "quick", "001-fix-login");
    mkdirSync(qt1, { recursive: true });
    writeFileSync(join(qt1, "001-PLAN.md"), SAMPLE_QUICK_PLAN);
    writeFileSync(join(qt1, "001-SUMMARY.md"), SAMPLE_QUICK_SUMMARY);
    const qt2 = join(planning, "quick", "002-update-deps");
    mkdirSync(qt2, { recursive: true });
    writeFileSync(join(qt2, "002-PLAN.md"), "# 002: Update Dependencies\n\nUpdate all deps.");
    const project = await parsePlanningDirectory(planning);
    assert.deepStrictEqual(project.quickTasks.length, 2, "quick: 2 quick tasks");
    assert.deepStrictEqual(project.quickTasks[0]?.number, 1, "quick: first task number");
    assert.deepStrictEqual(project.quickTasks[0]?.slug, "fix-login", "quick: first task slug");
    assert.ok(project.quickTasks[0]?.plan !== null, "quick: first task has plan");
    assert.ok(project.quickTasks[0]?.summary !== null, "quick: first task has summary");
    assert.deepStrictEqual(project.quickTasks[1]?.number, 2, "quick: second task number");
    assert.ok(project.quickTasks[1]?.plan !== null, "quick: second task has plan");
    assert.deepStrictEqual(project.quickTasks[1]?.summary, null, "quick: second task has no summary");
  } finally {
    cleanup(base);
  }
});
test("Roadmap with milestone sections and <details> blocks", async () => {
  const base = createFixtureBase();
  try {
    const planning = createPlanningDir(base);
    writeFileSync(join(planning, "ROADMAP.md"), SAMPLE_MILESTONE_SECTIONED_ROADMAP);
    const project = await parsePlanningDirectory(planning);
    assert.ok(project.roadmap !== null, "ms roadmap: roadmap parsed");
    assert.ok((project.roadmap?.milestones?.length ?? 0) >= 2, "ms roadmap: has milestone sections");
    const v20 = project.roadmap?.milestones?.find((m) => m.id.includes("2.0"));
    assert.ok(v20 !== void 0, "ms roadmap: v2.0 milestone found");
    assert.deepStrictEqual(v20?.collapsed, true, "ms roadmap: v2.0 is collapsed");
    assert.ok((v20?.phases?.length ?? 0) >= 2, "ms roadmap: v2.0 has phases");
    assert.ok(v20?.phases?.every((p) => p.done) ?? false, "ms roadmap: v2.0 phases all done");
    const v25 = project.roadmap?.milestones?.find((m) => m.id.includes("2.5"));
    assert.ok(v25 !== void 0, "ms roadmap: v2.5 milestone found");
    assert.deepStrictEqual(v25?.collapsed, false, "ms roadmap: v2.5 is not collapsed");
    assert.ok((v25?.phases?.length ?? 0) >= 3, "ms roadmap: v2.5 has phases");
    const phase29 = v25?.phases?.find((p) => p.number === 29);
    assert.ok(phase29?.done === true, "ms roadmap: phase 29 is done");
    const phase30 = v25?.phases?.find((p) => p.number === 30);
    assert.ok(phase30?.done === false, "ms roadmap: phase 30 is not done");
  } finally {
    cleanup(base);
  }
});
test("Non-standard phase files \u2192 collected as extra files", async () => {
  const base = createFixtureBase();
  try {
    const planning = createPlanningDir(base);
    writeFileSync(join(planning, "ROADMAP.md"), SAMPLE_ROADMAP);
    const phaseDir = join(planning, "phases", "36-attachment-system");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(join(phaseDir, "36-01-PLAN.md"), "<objective>Attachments</objective>");
    writeFileSync(join(phaseDir, "BASELINE.md"), "# Baseline\n\nBaseline measurements.");
    writeFileSync(join(phaseDir, "BUNDLE-ANALYSIS.md"), "# Bundle Analysis\n\nResults.");
    writeFileSync(join(phaseDir, "depcheck-results.txt"), "unused: pkg-a, pkg-b");
    const project = await parsePlanningDirectory(planning);
    const phase = project.phases["36-attachment-system"];
    assert.ok(phase !== void 0, "extra: phase exists");
    assert.ok((phase?.extraFiles?.length ?? 0) >= 3, "extra: non-standard files collected");
    assert.ok(
      phase?.extraFiles?.some((f) => f.fileName === "BASELINE.md") ?? false,
      "extra: BASELINE.md collected"
    );
    assert.ok(
      phase?.extraFiles?.some((f) => f.fileName === "BUNDLE-ANALYSIS.md") ?? false,
      "extra: BUNDLE-ANALYSIS.md collected"
    );
    assert.ok(
      phase?.extraFiles?.some((f) => f.fileName === "depcheck-results.txt") ?? false,
      "extra: depcheck-results.txt collected"
    );
  } finally {
    cleanup(base);
  }
});
test("Validation: missing ROADMAP.md \u2192 warning (not fatal)", async () => {
  const base = createFixtureBase();
  try {
    const planning = createPlanningDir(base);
    writeFileSync(join(planning, "PROJECT.md"), SAMPLE_PROJECT);
    const result = await validatePlanningDirectory(planning);
    assert.deepStrictEqual(result.valid, true, "no roadmap: validation still passes");
    assert.ok(
      result.issues.some((i) => i.severity === "warning" && i.file.includes("ROADMAP")),
      "no roadmap: warning issue mentions ROADMAP"
    );
  } finally {
    cleanup(base);
  }
});
test("Validation: missing PROJECT.md \u2192 warning", async () => {
  const base = createFixtureBase();
  try {
    const planning = createPlanningDir(base);
    writeFileSync(join(planning, "ROADMAP.md"), SAMPLE_ROADMAP);
    const result = await validatePlanningDirectory(planning);
    assert.deepStrictEqual(result.valid, true, "no project: validation passes (warning only)");
    assert.ok(
      result.issues.some((i) => i.severity === "warning" && i.file.includes("PROJECT")),
      "no project: warning issue mentions PROJECT"
    );
  } finally {
    cleanup(base);
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9taWdyYXRlLXBhcnNlci50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBNaWdyYXRpb24gcGFyc2VyIHRlc3Qgc3VpdGVcbi8vIFRlc3RzIGZvciBwYXJzaW5nIG9sZCAucGxhbm5pbmcgZGlyZWN0b3JpZXMgaW50byB0eXBlZCBQbGFubmluZ1Byb2plY3Qgc3RydWN0dXJlcy5cbi8vIFVzZXMgc3ludGhldGljIGZpeHR1cmUgZGlyZWN0b3JpZXMgXHUyMDE0IG5vIHJlYWwgLnBsYW5uaW5nIGRpcnMgbmVlZGVkLlxuXG5pbXBvcnQgeyBta2R0ZW1wU3luYywgbWtkaXJTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tICdub2RlOmZzJztcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdub2RlOnBhdGgnO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSAnbm9kZTpvcyc7XG5cbmltcG9ydCB7IHBhcnNlUGxhbm5pbmdEaXJlY3RvcnkgfSBmcm9tICcuLi9taWdyYXRlL3BhcnNlci50cyc7XG5pbXBvcnQgeyB2YWxpZGF0ZVBsYW5uaW5nRGlyZWN0b3J5IH0gZnJvbSAnLi4vbWlncmF0ZS92YWxpZGF0b3IudHMnO1xuXG5pbXBvcnQgdHlwZSB7IFBsYW5uaW5nUHJvamVjdCwgVmFsaWRhdGlvblJlc3VsdCB9IGZyb20gJy4uL21pZ3JhdGUvdHlwZXMudHMnO1xuaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QsIGJlZm9yZUVhY2gsIGFmdGVyRWFjaCB9IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBGaXh0dXJlIEhlbHBlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIGNyZWF0ZUZpeHR1cmVCYXNlKCk6IHN0cmluZyB7XG4gIHJldHVybiBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCAnZ3NkLW1pZ3JhdGUtdGVzdC0nKSk7XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZVBsYW5uaW5nRGlyKGJhc2U6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGRpciA9IGpvaW4oYmFzZSwgJy5wbGFubmluZycpO1xuICBta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgcmV0dXJuIGRpcjtcbn1cblxuZnVuY3Rpb24gd3JpdGVGaWxlKGRpcjogc3RyaW5nLCAuLi5wYXRoUGFydHM6IHN0cmluZ1tdKTogKGNvbnRlbnQ6IHN0cmluZykgPT4gdm9pZCB7XG4gIHJldHVybiAoY29udGVudDogc3RyaW5nKSA9PiB7XG4gICAgY29uc3QgZmlsZVBhdGggPSBqb2luKGRpciwgLi4ucGF0aFBhcnRzKTtcbiAgICBta2RpclN5bmMoam9pbihmaWxlUGF0aCwgJy4uJyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoZmlsZVBhdGgsIGNvbnRlbnQpO1xuICB9O1xufVxuXG5mdW5jdGlvbiBjbGVhbnVwKGJhc2U6IHN0cmluZyk6IHZvaWQge1xuICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU2FtcGxlIEZpeHR1cmVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5jb25zdCBTQU1QTEVfUk9BRE1BUCA9IGAjIFByb2plY3QgUm9hZG1hcFxuXG4jIyBQaGFzZXNcblxuLSBbeF0gMjkgXHUyMDE0IEF1dGggU3lzdGVtXG4tIFsgXSAzMCBcdTIwMTQgRGFzaGJvYXJkXG4tIFsgXSAzMSBcdTIwMTQgTm90aWZpY2F0aW9uc1xuYDtcblxuY29uc3QgU0FNUExFX1BST0pFQ1QgPSBgIyBNeSBQcm9qZWN0XG5cbkEgc2FtcGxlIHByb2plY3QgZm9yIHRlc3RpbmcgdGhlIG1pZ3JhdGlvbiBwYXJzZXIuXG5cbiMjIEdvYWxzXG5cbi0gQnVpbGQgYSB0aGluZ1xuLSBTaGlwIGl0XG5gO1xuXG5jb25zdCBTQU1QTEVfUkVRVUlSRU1FTlRTID0gYCMgUmVxdWlyZW1lbnRzXG5cbiMjIEFjdGl2ZVxuXG4jIyMgUjAwMSBcdTIwMTQgVXNlciBBdXRoZW50aWNhdGlvblxuLSBTdGF0dXM6IGFjdGl2ZVxuLSBEZXNjcmlwdGlvbjogVXNlcnMgbXVzdCBiZSBhYmxlIHRvIGxvZyBpbi5cblxuIyMjIFIwMDIgXHUyMDE0IERhc2hib2FyZCBWaWV3XG4tIFN0YXR1czogYWN0aXZlXG4tIERlc2NyaXB0aW9uOiBNYWluIGRhc2hib2FyZCBwYWdlLlxuXG4jIyBWYWxpZGF0ZWRcblxuIyMjIFIwMDMgXHUyMDE0IFNlc3Npb24gTWFuYWdlbWVudFxuLSBTdGF0dXM6IHZhbGlkYXRlZFxuLSBEZXNjcmlwdGlvbjogU2Vzc2lvbnMgZXhwaXJlIGFmdGVyIDI0aC5cblxuIyMgRGVmZXJyZWRcblxuIyMjIFIwMDQgXHUyMDE0IE9BdXRoIFN1cHBvcnRcbi0gU3RhdHVzOiBkZWZlcnJlZFxuLSBEZXNjcmlwdGlvbjogVGhpcmQtcGFydHkgbG9naW4uXG5gO1xuXG5jb25zdCBTQU1QTEVfU1RBVEUgPSBgIyBTdGF0ZVxuXG4qKkN1cnJlbnQgUGhhc2U6KiogMzAtZGFzaGJvYXJkXG4qKlN0YXR1czoqKiBpbi1wcm9ncmVzc1xuYDtcblxuY29uc3QgU0FNUExFX0NPTkZJRyA9IEpTT04uc3RyaW5naWZ5KHtcbiAgcHJvamVjdE5hbWU6ICd0ZXN0LXByb2plY3QnLFxuICB2ZXJzaW9uOiAnMS4wJyxcbn0pO1xuXG5jb25zdCBTQU1QTEVfUExBTl9YTUwgPSBgLS0tXG5waGFzZTogXCIyOS1hdXRoLXN5c3RlbVwiXG5wbGFuOiBcIjAxXCJcbnR5cGU6IFwiaW1wbGVtZW50YXRpb25cIlxud2F2ZTogMVxuZGVwZW5kc19vbjogW11cbmZpbGVzX21vZGlmaWVkOiBbc3JjL2F1dGgudHMsIHNyYy9sb2dpbi50c11cbmF1dG9ub21vdXM6IHRydWVcbm11c3RfaGF2ZXM6XG4gIHRydXRoczpcbiAgICAtIFVzZXJzIGNhbiBsb2cgaW5cbiAgYXJ0aWZhY3RzOlxuICAgIC0gc3JjL2F1dGgudHNcbiAga2V5X2xpbmtzOiBbXVxuLS0tXG5cbiMgMjktMDE6IEltcGxlbWVudCBBdXRoXG5cbjxvYmplY3RpdmU+XG5CdWlsZCB0aGUgYXV0aGVudGljYXRpb24gc3lzdGVtIHdpdGggSldUIHRva2VucyBhbmQgc2Vzc2lvbiBtYW5hZ2VtZW50LlxuPC9vYmplY3RpdmU+XG5cbjx0YXNrcz5cbjx0YXNrPkNyZWF0ZSBhdXRoIG1pZGRsZXdhcmU8L3Rhc2s+XG48dGFzaz5BZGQgbG9naW4gZW5kcG9pbnQ8L3Rhc2s+XG48dGFzaz5BZGQgbG9nb3V0IGVuZHBvaW50PC90YXNrPlxuPC90YXNrcz5cblxuPGNvbnRleHQ+XG5UaGUgcHJvamVjdCBuZWVkcyBhdXRoZW50aWNhdGlvbiBiZWZvcmUgYW55IG90aGVyIGZlYXR1cmVzIGNhbiBiZSBidWlsdC5cbkF1dGggdG9rZW5zIHVzZSBKV1Qgd2l0aCBSUzI1NiBzaWduaW5nLlxuPC9jb250ZXh0PlxuXG48dmVyaWZpY2F0aW9uPlxuLSBMb2dpbiByZXR1cm5zIHZhbGlkIEpXVFxuLSBNaWRkbGV3YXJlIHJlamVjdHMgaW52YWxpZCB0b2tlbnNcbi0gTG9nb3V0IGludmFsaWRhdGVzIHNlc3Npb25cbjwvdmVyaWZpY2F0aW9uPlxuXG48c3VjY2Vzc19jcml0ZXJpYT5cbkFsbCBhdXRoIGVuZHBvaW50cyByZXNwb25kIGNvcnJlY3RseSBhbmQgdG9rZW5zIGFyZSB2YWxpZGF0ZWQuXG48L3N1Y2Nlc3NfY3JpdGVyaWE+XG5gO1xuXG5jb25zdCBTQU1QTEVfU1VNTUFSWSA9IGAtLS1cbnBoYXNlOiBcIjI5LWF1dGgtc3lzdGVtXCJcbnBsYW46IFwiMDFcIlxuc3Vic3lzdGVtOiBcImF1dGhcIlxudGFnczpcbiAgLSBhdXRoZW50aWNhdGlvblxuICAtIHNlY3VyaXR5XG5yZXF1aXJlczogW11cbnByb3ZpZGVzOlxuICAtIGF1dGgtbWlkZGxld2FyZVxuICAtIGp3dC12YWxpZGF0aW9uXG5hZmZlY3RzOlxuICAtIGFwaS1yb3V0ZXNcbnRlY2gtc3RhY2s6XG4gIC0ganNvbndlYnRva2VuXG4gIC0gZXhwcmVzc1xua2V5LWZpbGVzOlxuICAtIHNyYy9hdXRoLnRzXG4gIC0gc3JjL21pZGRsZXdhcmUvYXV0aC50c1xua2V5LWRlY2lzaW9uczpcbiAgLSBVc2UgUlMyNTYgZm9yIEpXVCBzaWduaW5nXG4gIC0gU3RvcmUgcmVmcmVzaCB0b2tlbnMgaW4gREJcbnBhdHRlcm5zLWVzdGFibGlzaGVkOlxuICAtIE1pZGRsZXdhcmUtYmFzZWQgYXV0aFxuZHVyYXRpb246IFwiMmhcIlxuY29tcGxldGVkOiBcIjIwMjYtMDEtMTVcIlxuLS0tXG5cbiMgMjktMDE6IEF1dGggSW1wbGVtZW50YXRpb24gU3VtbWFyeVxuXG5BdXRoZW50aWNhdGlvbiBzeXN0ZW0gaW1wbGVtZW50ZWQgd2l0aCBKV1QgdG9rZW5zLlxuXG4jIyBXaGF0IEhhcHBlbmVkXG5cbkJ1aWx0IHRoZSBhdXRoIG1pZGRsZXdhcmUgYW5kIGxvZ2luL2xvZ291dCBlbmRwb2ludHMuXG5cbiMjIEZpbGVzIE1vZGlmaWVkXG5cbi0gXFxgc3JjL2F1dGgudHNcXGAgXHUyMDE0IENvcmUgYXV0aCBsb2dpY1xuLSBcXGBzcmMvbWlkZGxld2FyZS9hdXRoLnRzXFxgIFx1MjAxNCBFeHByZXNzIG1pZGRsZXdhcmVcbmA7XG5cbmNvbnN0IFNBTVBMRV9SRVNFQVJDSCA9IGAjIEF1dGggUmVzZWFyY2hcblxuIyMgSldUIHZzIFNlc3Npb24gVG9rZW5zXG5cbkpXVCB0b2tlbnMgYXJlIHN0YXRlbGVzcyBhbmQgd29yayB3ZWxsIGZvciBtaWNyb3NlcnZpY2VzLlxuU2Vzc2lvbiB0b2tlbnMgcmVxdWlyZSBzZXJ2ZXItc2lkZSBzdG9yYWdlIGJ1dCBhcmUgZWFzaWVyIHRvIHJldm9rZS5cblxuIyMgRGVjaXNpb25cblxuVXNlIEpXVCB3aXRoIHNob3J0IGV4cGlyeSArIHJlZnJlc2ggdG9rZW5zLlxuYDtcblxuY29uc3QgU0FNUExFX01JTEVTVE9ORV9ST0FETUFQID0gYCMgTWlsZXN0b25lIHYyLjIgUm9hZG1hcFxuXG4jIyBQaGFzZXNcblxuLSBbeF0gMjkgXHUyMDE0IEF1dGggU3lzdGVtXG4tIFt4XSAzMCBcdTIwMTQgRGFzaGJvYXJkXG5gO1xuXG5jb25zdCBTQU1QTEVfTUlMRVNUT05FX1NFQ1RJT05FRF9ST0FETUFQID0gYCMgUHJvamVjdCBSb2FkbWFwXG5cbiMjIHYyLjAgXHUyMDE0IEZvdW5kYXRpb25cblxuPGRldGFpbHM+XG48c3VtbWFyeT5Db21wbGV0ZWQ8L3N1bW1hcnk+XG5cbi0gW3hdIDAxIFx1MjAxNCBQcm9qZWN0IFNldHVwXG4tIFt4XSAwMiBcdTIwMTQgRGF0YWJhc2UgU2NoZW1hXG5cbjwvZGV0YWlscz5cblxuIyMgdjIuNSBcdTIwMTQgRmVhdHVyZXNcblxuLSBbeF0gMjkgXHUyMDE0IEF1dGggU3lzdGVtXG4tIFsgXSAzMCBcdTIwMTQgRGFzaGJvYXJkXG4tIFsgXSAzMSBcdTIwMTQgTm90aWZpY2F0aW9uc1xuYDtcblxuY29uc3QgU0FNUExFX1FVSUNLX1BMQU4gPSBgIyAwMDE6IEZpeCBMb2dpbiBCdWdcblxuIyMgRGVzY3JpcHRpb25cblxuRml4IHRoZSBsb2dpbiBidXR0b24gbm90IHJlc3BvbmRpbmcgb24gbW9iaWxlLlxuXG4jIyBTdGVwc1xuXG4xLiBEZWJ1ZyBjbGljayBoYW5kbGVyXG4yLiBGaXggZXZlbnQgcHJvcGFnYXRpb25cbjMuIFRlc3Qgb24gbW9iaWxlXG5gO1xuXG5jb25zdCBTQU1QTEVfUVVJQ0tfU1VNTUFSWSA9IGAjIDAwMTogRml4IExvZ2luIEJ1ZyBcdTIwMTQgU3VtbWFyeVxuXG5GaXhlZCB0aGUgbG9naW4gYnV0dG9uIGJ5IGNvcnJlY3RpbmcgdGhlIHRvdWNoIGV2ZW50IGhhbmRsZXIuXG5gO1xuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIFRlc3QgR3JvdXBzXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdCAxOiBDb21wbGV0ZSAucGxhbm5pbmcgZGlyZWN0b3J5IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KCdDb21wbGV0ZSAucGxhbm5pbmcgZGlyZWN0b3J5IHdpdGggYWxsIGZpbGUgdHlwZXMnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHBsYW5uaW5nID0gY3JlYXRlUGxhbm5pbmdEaXIoYmFzZSk7XG5cbiAgICAgIC8vIFJvb3QgZmlsZXNcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihwbGFubmluZywgJ1BST0pFQ1QubWQnKSwgU0FNUExFX1BST0pFQ1QpO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHBsYW5uaW5nLCAnUk9BRE1BUC5tZCcpLCBTQU1QTEVfUk9BRE1BUCk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4ocGxhbm5pbmcsICdSRVFVSVJFTUVOVFMubWQnKSwgU0FNUExFX1JFUVVJUkVNRU5UUyk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4ocGxhbm5pbmcsICdTVEFURS5tZCcpLCBTQU1QTEVfU1RBVEUpO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHBsYW5uaW5nLCAnY29uZmlnLmpzb24nKSwgU0FNUExFX0NPTkZJRyk7XG5cbiAgICAgIC8vIFBoYXNlIGRpcmVjdG9yeSB3aXRoIHBsYW4sIHN1bW1hcnksIHJlc2VhcmNoXG4gICAgICBjb25zdCBwaGFzZURpciA9IGpvaW4ocGxhbm5pbmcsICdwaGFzZXMnLCAnMjktYXV0aC1zeXN0ZW0nKTtcbiAgICAgIG1rZGlyU3luYyhwaGFzZURpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4ocGhhc2VEaXIsICcyOS0wMS1QTEFOLm1kJyksIFNBTVBMRV9QTEFOX1hNTCk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4ocGhhc2VEaXIsICcyOS0wMS1TVU1NQVJZLm1kJyksIFNBTVBMRV9TVU1NQVJZKTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihwaGFzZURpciwgJzI5LVJFU0VBUkNILm1kJyksIFNBTVBMRV9SRVNFQVJDSCk7XG5cbiAgICAgIC8vIFNlY29uZCBwaGFzZSBkaXJlY3RvcnlcbiAgICAgIGNvbnN0IHBoYXNlMkRpciA9IGpvaW4ocGxhbm5pbmcsICdwaGFzZXMnLCAnMzAtZGFzaGJvYXJkJyk7XG4gICAgICBta2RpclN5bmMocGhhc2UyRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihwaGFzZTJEaXIsICczMC0wMS1QTEFOLm1kJyksIGAtLS1cbnBoYXNlOiBcIjMwLWRhc2hib2FyZFwiXG5wbGFuOiBcIjAxXCJcbnR5cGU6IFwiaW1wbGVtZW50YXRpb25cIlxud2F2ZTogMVxuZGVwZW5kc19vbjogWzI5LTAxXVxuZmlsZXNfbW9kaWZpZWQ6IFtdXG5hdXRvbm9tb3VzOiBmYWxzZVxuLS0tXG5cbiMgMzAtMDE6IEJ1aWxkIERhc2hib2FyZFxuXG48b2JqZWN0aXZlPlxuQ3JlYXRlIHRoZSBtYWluIGRhc2hib2FyZCB2aWV3LlxuPC9vYmplY3RpdmU+XG5cbjx0YXNrcz5cbjx0YXNrPkNyZWF0ZSBkYXNoYm9hcmQgY29tcG9uZW50PC90YXNrPlxuPHRhc2s+QWRkIGRhdGEgZmV0Y2hpbmc8L3Rhc2s+XG48L3Rhc2tzPlxuXG48Y29udGV4dD5cbkRhc2hib2FyZCBuZWVkcyBhdXRoIHRvIGJlIGNvbXBsZXRlIGZpcnN0LlxuPC9jb250ZXh0PlxuYCk7XG5cbiAgICAgIC8vIFF1aWNrIHRhc2tzXG4gICAgICBjb25zdCBxdWlja0RpciA9IGpvaW4ocGxhbm5pbmcsICdxdWljaycsICcwMDEtZml4LWxvZ2luJyk7XG4gICAgICBta2RpclN5bmMocXVpY2tEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHF1aWNrRGlyLCAnMDAxLVBMQU4ubWQnKSwgU0FNUExFX1FVSUNLX1BMQU4pO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHF1aWNrRGlyLCAnMDAxLVNVTU1BUlkubWQnKSwgU0FNUExFX1FVSUNLX1NVTU1BUlkpO1xuXG4gICAgICAvLyBNaWxlc3RvbmVzXG4gICAgICBjb25zdCBtc0RpciA9IGpvaW4ocGxhbm5pbmcsICdtaWxlc3RvbmVzJyk7XG4gICAgICBta2RpclN5bmMobXNEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKG1zRGlyLCAndjIuMi1ST0FETUFQLm1kJyksIFNBTVBMRV9NSUxFU1RPTkVfUk9BRE1BUCk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4obXNEaXIsICd2Mi4yLVJFUVVJUkVNRU5UUy5tZCcpLCAnTWlsZXN0b25lIHJlcXVpcmVtZW50cyBoZXJlLicpO1xuXG4gICAgICAvLyBSZXNlYXJjaCBhdCByb290XG4gICAgICBjb25zdCByZXNlYXJjaERpciA9IGpvaW4ocGxhbm5pbmcsICdyZXNlYXJjaCcpO1xuICAgICAgbWtkaXJTeW5jKHJlc2VhcmNoRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihyZXNlYXJjaERpciwgJ2FyY2hpdGVjdHVyZS5tZCcpLCAnIyBBcmNoaXRlY3R1cmUgUmVzZWFyY2hcXG5cXG5Ob3Rlcy4nKTtcblxuICAgICAgY29uc3QgcHJvamVjdCA9IGF3YWl0IHBhcnNlUGxhbm5pbmdEaXJlY3RvcnkocGxhbm5pbmcpO1xuXG4gICAgICAvLyBUb3AtbGV2ZWwgc3RydWN0dXJlXG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHByb2plY3QucGF0aCwgcGxhbm5pbmcsICdwcm9qZWN0LnBhdGggbWF0Y2hlcycpO1xuICAgICAgYXNzZXJ0Lm9rKHByb2plY3QucHJvamVjdCAhPT0gbnVsbCwgJ1BST0pFQ1QubWQgcGFyc2VkJyk7XG4gICAgICBhc3NlcnQub2socHJvamVjdC5yb2FkbWFwICE9PSBudWxsLCAnUk9BRE1BUC5tZCBwYXJzZWQnKTtcbiAgICAgIGFzc2VydC5vayhwcm9qZWN0LnJlcXVpcmVtZW50cy5sZW5ndGggPiAwLCAncmVxdWlyZW1lbnRzIHBhcnNlZCcpO1xuICAgICAgYXNzZXJ0Lm9rKHByb2plY3Quc3RhdGUgIT09IG51bGwsICdTVEFURS5tZCBwYXJzZWQnKTtcbiAgICAgIGFzc2VydC5vayhwcm9qZWN0LmNvbmZpZyAhPT0gbnVsbCwgJ2NvbmZpZy5qc29uIHBhcnNlZCcpO1xuXG4gICAgICAvLyBQaGFzZXNcbiAgICAgIGFzc2VydC5vaygnMjktYXV0aC1zeXN0ZW0nIGluIHByb2plY3QucGhhc2VzLCAncGhhc2UgMjkgcHJlc2VudCcpO1xuICAgICAgYXNzZXJ0Lm9rKCczMC1kYXNoYm9hcmQnIGluIHByb2plY3QucGhhc2VzLCAncGhhc2UgMzAgcHJlc2VudCcpO1xuXG4gICAgICBjb25zdCBwaGFzZTI5ID0gcHJvamVjdC5waGFzZXNbJzI5LWF1dGgtc3lzdGVtJ107XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBoYXNlMjk/Lm51bWJlciwgMjksICdwaGFzZSAyOSBudW1iZXInKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGhhc2UyOT8uc2x1ZywgJ2F1dGgtc3lzdGVtJywgJ3BoYXNlIDI5IHNsdWcnKTtcbiAgICAgIGFzc2VydC5vaygnMDEnIGluIChwaGFzZTI5Py5wbGFucyA/PyB7fSksICdwaGFzZSAyOSBoYXMgcGxhbiAwMScpO1xuICAgICAgYXNzZXJ0Lm9rKCcwMScgaW4gKHBoYXNlMjk/LnN1bW1hcmllcyA/PyB7fSksICdwaGFzZSAyOSBoYXMgc3VtbWFyeSAwMScpO1xuICAgICAgYXNzZXJ0Lm9rKChwaGFzZTI5Py5yZXNlYXJjaD8ubGVuZ3RoID8/IDApID4gMCwgJ3BoYXNlIDI5IGhhcyByZXNlYXJjaCcpO1xuXG4gICAgICAvLyBQbGFuIGNvbnRlbnQgKFhNTC1pbi1tYXJrZG93bilcbiAgICAgIGNvbnN0IHBsYW4yOSA9IHBoYXNlMjk/LnBsYW5zPy5bJzAxJ107XG4gICAgICBhc3NlcnQub2socGxhbjI5ICE9PSB1bmRlZmluZWQsICdwbGFuIDI5LTAxIGV4aXN0cycpO1xuICAgICAgYXNzZXJ0Lm9rKHBsYW4yOT8ub2JqZWN0aXZlPy5pbmNsdWRlcygnYXV0aGVudGljYXRpb24nKSA/PyBmYWxzZSwgJ3BsYW4gb2JqZWN0aXZlIGV4dHJhY3RlZCcpO1xuICAgICAgYXNzZXJ0Lm9rKChwbGFuMjk/LnRhc2tzPy5sZW5ndGggPz8gMCkgPj0gMywgJ3BsYW4gdGFza3MgZXh0cmFjdGVkJyk7XG4gICAgICBhc3NlcnQub2socGxhbjI5Py5jb250ZXh0Py5pbmNsdWRlcygnSldUJykgPz8gZmFsc2UsICdwbGFuIGNvbnRleHQgZXh0cmFjdGVkJyk7XG4gICAgICBhc3NlcnQub2socGxhbjI5Py52ZXJpZmljYXRpb24gIT09ICcnLCAncGxhbiB2ZXJpZmljYXRpb24gZXh0cmFjdGVkJyk7XG4gICAgICBhc3NlcnQub2socGxhbjI5Py5zdWNjZXNzQ3JpdGVyaWEgIT09ICcnLCAncGxhbiBzdWNjZXNzIGNyaXRlcmlhIGV4dHJhY3RlZCcpO1xuXG4gICAgICAvLyBQbGFuIGZyb250bWF0dGVyXG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBsYW4yOT8uZnJvbnRtYXR0ZXI/LnBoYXNlLCAnMjktYXV0aC1zeXN0ZW0nLCAncGxhbiBmcm9udG1hdHRlciBwaGFzZScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwbGFuMjk/LmZyb250bWF0dGVyPy5wbGFuLCAnMDEnLCAncGxhbiBmcm9udG1hdHRlciBwbGFuJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBsYW4yOT8uZnJvbnRtYXR0ZXI/LnR5cGUsICdpbXBsZW1lbnRhdGlvbicsICdwbGFuIGZyb250bWF0dGVyIHR5cGUnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGxhbjI5Py5mcm9udG1hdHRlcj8ud2F2ZSwgMSwgJ3BsYW4gZnJvbnRtYXR0ZXIgd2F2ZScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwbGFuMjk/LmZyb250bWF0dGVyPy5hdXRvbm9tb3VzLCB0cnVlLCAncGxhbiBmcm9udG1hdHRlciBhdXRvbm9tb3VzJyk7XG5cbiAgICAgIC8vIFN1bW1hcnkgY29udGVudFxuICAgICAgY29uc3Qgc3VtbWFyeTI5ID0gcGhhc2UyOT8uc3VtbWFyaWVzPy5bJzAxJ107XG4gICAgICBhc3NlcnQub2soc3VtbWFyeTI5ICE9PSB1bmRlZmluZWQsICdzdW1tYXJ5IDI5LTAxIGV4aXN0cycpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdW1tYXJ5Mjk/LmZyb250bWF0dGVyPy5waGFzZSwgJzI5LWF1dGgtc3lzdGVtJywgJ3N1bW1hcnkgZnJvbnRtYXR0ZXIgcGhhc2UnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3VtbWFyeTI5Py5mcm9udG1hdHRlcj8ucGxhbiwgJzAxJywgJ3N1bW1hcnkgZnJvbnRtYXR0ZXIgcGxhbicpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdW1tYXJ5Mjk/LmZyb250bWF0dGVyPy5zdWJzeXN0ZW0sICdhdXRoJywgJ3N1bW1hcnkgZnJvbnRtYXR0ZXIgc3Vic3lzdGVtJyk7XG4gICAgICBhc3NlcnQub2soKHN1bW1hcnkyOT8uZnJvbnRtYXR0ZXI/LnRhZ3M/Lmxlbmd0aCA/PyAwKSA+PSAyLCAnc3VtbWFyeSBmcm9udG1hdHRlciB0YWdzJyk7XG4gICAgICBhc3NlcnQub2soKHN1bW1hcnkyOT8uZnJvbnRtYXR0ZXI/LnByb3ZpZGVzPy5sZW5ndGggPz8gMCkgPj0gMiwgJ3N1bW1hcnkgZnJvbnRtYXR0ZXIgcHJvdmlkZXMnKTtcbiAgICAgIGFzc2VydC5vaygoc3VtbWFyeTI5Py5mcm9udG1hdHRlcj8uYWZmZWN0cz8ubGVuZ3RoID8/IDApID49IDEsICdzdW1tYXJ5IGZyb250bWF0dGVyIGFmZmVjdHMnKTtcbiAgICAgIGFzc2VydC5vaygoc3VtbWFyeTI5Py5mcm9udG1hdHRlcj8uWyd0ZWNoLXN0YWNrJ10/Lmxlbmd0aCA/PyAwKSA+PSAyLCAnc3VtbWFyeSBmcm9udG1hdHRlciB0ZWNoLXN0YWNrJyk7XG4gICAgICBhc3NlcnQub2soKHN1bW1hcnkyOT8uZnJvbnRtYXR0ZXI/Llsna2V5LWZpbGVzJ10/Lmxlbmd0aCA/PyAwKSA+PSAyLCAnc3VtbWFyeSBmcm9udG1hdHRlciBrZXktZmlsZXMnKTtcbiAgICAgIGFzc2VydC5vaygoc3VtbWFyeTI5Py5mcm9udG1hdHRlcj8uWydrZXktZGVjaXNpb25zJ10/Lmxlbmd0aCA/PyAwKSA+PSAyLCAnc3VtbWFyeSBmcm9udG1hdHRlciBrZXktZGVjaXNpb25zJyk7XG4gICAgICBhc3NlcnQub2soKHN1bW1hcnkyOT8uZnJvbnRtYXR0ZXI/LlsncGF0dGVybnMtZXN0YWJsaXNoZWQnXT8ubGVuZ3RoID8/IDApID49IDEsICdzdW1tYXJ5IGZyb250bWF0dGVyIHBhdHRlcm5zLWVzdGFibGlzaGVkJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN1bW1hcnkyOT8uZnJvbnRtYXR0ZXI/LmR1cmF0aW9uLCAnMmgnLCAnc3VtbWFyeSBmcm9udG1hdHRlciBkdXJhdGlvbicpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdW1tYXJ5Mjk/LmZyb250bWF0dGVyPy5jb21wbGV0ZWQsICcyMDI2LTAxLTE1JywgJ3N1bW1hcnkgZnJvbnRtYXR0ZXIgY29tcGxldGVkJyk7XG5cbiAgICAgIC8vIFF1aWNrIHRhc2tzXG4gICAgICBhc3NlcnQub2socHJvamVjdC5xdWlja1Rhc2tzLmxlbmd0aCA+PSAxLCAncXVpY2sgdGFza3MgcGFyc2VkJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHByb2plY3QucXVpY2tUYXNrc1swXT8ubnVtYmVyLCAxLCAncXVpY2sgdGFzayBudW1iZXInKTtcbiAgICAgIGFzc2VydC5vayhwcm9qZWN0LnF1aWNrVGFza3NbMF0/LnBsYW4gIT09IG51bGwsICdxdWljayB0YXNrIGhhcyBwbGFuJyk7XG4gICAgICBhc3NlcnQub2socHJvamVjdC5xdWlja1Rhc2tzWzBdPy5zdW1tYXJ5ICE9PSBudWxsLCAncXVpY2sgdGFzayBoYXMgc3VtbWFyeScpO1xuXG4gICAgICAvLyBNaWxlc3RvbmVzXG4gICAgICBhc3NlcnQub2socHJvamVjdC5taWxlc3RvbmVzLmxlbmd0aCA+PSAxLCAnbWlsZXN0b25lcyBwYXJzZWQnKTtcblxuICAgICAgLy8gUm9vdCByZXNlYXJjaFxuICAgICAgYXNzZXJ0Lm9rKHByb2plY3QucmVzZWFyY2gubGVuZ3RoID49IDEsICdyb290IHJlc2VhcmNoIHBhcnNlZCcpO1xuXG4gICAgICAvLyBDb25maWdcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocHJvamVjdC5jb25maWc/LnByb2plY3ROYW1lLCAndGVzdC1wcm9qZWN0JywgJ2NvbmZpZyBwcm9qZWN0TmFtZScpO1xuXG4gICAgICAvLyBTdGF0ZVxuICAgICAgYXNzZXJ0Lm9rKHByb2plY3Quc3RhdGU/LmN1cnJlbnRQaGFzZT8uaW5jbHVkZXMoJzMwJykgPz8gZmFsc2UsICdzdGF0ZSBjdXJyZW50IHBoYXNlJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHByb2plY3Quc3RhdGU/LnN0YXR1cywgJ2luLXByb2dyZXNzJywgJ3N0YXRlIHN0YXR1cycpO1xuXG4gICAgICAvLyBWYWxpZGF0aW9uXG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHByb2plY3QudmFsaWRhdGlvbi52YWxpZCwgdHJ1ZSwgJ3ZhbGlkYXRpb24gcGFzc2VzIGZvciBjb21wbGV0ZSBkaXInKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocHJvamVjdC52YWxpZGF0aW9uLmlzc3Vlcy5sZW5ndGgsIDAsICdubyB2YWxpZGF0aW9uIGlzc3VlcycpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbn0pO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUZXN0IDI6IE1pbmltYWwgLnBsYW5uaW5nIGRpcmVjdG9yeSAob25seSBST0FETUFQLm1kKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdCgnTWluaW1hbCAucGxhbm5pbmcgZGlyZWN0b3J5IChvbmx5IFJPQURNQVAubWQpJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBwbGFubmluZyA9IGNyZWF0ZVBsYW5uaW5nRGlyKGJhc2UpO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHBsYW5uaW5nLCAnUk9BRE1BUC5tZCcpLCBTQU1QTEVfUk9BRE1BUCk7XG5cbiAgICAgIGNvbnN0IHByb2plY3QgPSBhd2FpdCBwYXJzZVBsYW5uaW5nRGlyZWN0b3J5KHBsYW5uaW5nKTtcblxuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwcm9qZWN0LnByb2plY3QsIG51bGwsICdtaW5pbWFsOiBQUk9KRUNULm1kIGlzIG51bGwnKTtcbiAgICAgIGFzc2VydC5vayhwcm9qZWN0LnJvYWRtYXAgIT09IG51bGwsICdtaW5pbWFsOiBST0FETUFQLm1kIHBhcnNlZCcpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwcm9qZWN0LnJlcXVpcmVtZW50cy5sZW5ndGgsIDAsICdtaW5pbWFsOiBubyByZXF1aXJlbWVudHMnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocHJvamVjdC5zdGF0ZSwgbnVsbCwgJ21pbmltYWw6IG5vIHN0YXRlJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHByb2plY3QuY29uZmlnLCBudWxsLCAnbWluaW1hbDogbm8gY29uZmlnJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKE9iamVjdC5rZXlzKHByb2plY3QucGhhc2VzKS5sZW5ndGgsIDAsICdtaW5pbWFsOiBubyBwaGFzZXMnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocHJvamVjdC5xdWlja1Rhc2tzLmxlbmd0aCwgMCwgJ21pbmltYWw6IG5vIHF1aWNrIHRhc2tzJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHByb2plY3QubWlsZXN0b25lcy5sZW5ndGgsIDAsICdtaW5pbWFsOiBubyBtaWxlc3RvbmVzJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHByb2plY3QucmVzZWFyY2gubGVuZ3RoLCAwLCAnbWluaW1hbDogbm8gcmVzZWFyY2gnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocHJvamVjdC52YWxpZGF0aW9uLnZhbGlkLCB0cnVlLCAnbWluaW1hbDogdmFsaWRhdGlvbiBwYXNzZXMnKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG59KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdCAzOiBNaXNzaW5nIGRpcmVjdG9yeSBcdTIxOTIgdmFsaWRhdGlvbiBmYXRhbCBlcnJvciBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdCgnTWlzc2luZyBkaXJlY3RvcnkgXHUyMTkyIHZhbGlkYXRpb24gcmV0dXJucyBmYXRhbCBlcnJvcicsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgdmFsaWRhdGVQbGFubmluZ0RpcmVjdG9yeShqb2luKGJhc2UsICdub25leGlzdGVudCcpKTtcblxuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQudmFsaWQsIGZhbHNlLCAnbWlzc2luZyBkaXI6IHZhbGlkYXRpb24gZmFpbHMnKTtcbiAgICAgIGFzc2VydC5vayhyZXN1bHQuaXNzdWVzLmxlbmd0aCA+IDAsICdtaXNzaW5nIGRpcjogaGFzIGlzc3VlcycpO1xuICAgICAgYXNzZXJ0Lm9rKFxuICAgICAgICByZXN1bHQuaXNzdWVzLnNvbWUoaSA9PiBpLnNldmVyaXR5ID09PSAnZmF0YWwnKSxcbiAgICAgICAgJ21pc3NpbmcgZGlyOiBoYXMgZmF0YWwgaXNzdWUnXG4gICAgICApO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbn0pO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUZXN0IDQ6IER1cGxpY2F0ZSBwaGFzZSBudW1iZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KCdQaGFzZSBkaXJlY3Rvcnkgd2l0aCBkdXBsaWNhdGUgbnVtYmVycycsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcGxhbm5pbmcgPSBjcmVhdGVQbGFubmluZ0RpcihiYXNlKTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihwbGFubmluZywgJ1JPQURNQVAubWQnKSwgU0FNUExFX1JPQURNQVApO1xuXG4gICAgICBjb25zdCBwaGFzZXNEaXIgPSBqb2luKHBsYW5uaW5nLCAncGhhc2VzJyk7XG4gICAgICBta2RpclN5bmMoam9pbihwaGFzZXNEaXIsICc0NS1jb3JlLWluZnJhc3RydWN0dXJlJyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgbWtkaXJTeW5jKGpvaW4ocGhhc2VzRGlyLCAnNDUtbG9nZ2luZy1jb25maWcnKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICAgIGpvaW4ocGhhc2VzRGlyLCAnNDUtY29yZS1pbmZyYXN0cnVjdHVyZScsICc0NS0wMS1QTEFOLm1kJyksXG4gICAgICAgICcjIENvcmUgUGxhblxcblxcbjxvYmplY3RpdmU+Q29yZSBpbmZyYTwvb2JqZWN0aXZlPidcbiAgICAgICk7XG4gICAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgICBqb2luKHBoYXNlc0RpciwgJzQ1LWxvZ2dpbmctY29uZmlnJywgJzQ1LTAxLVBMQU4ubWQnKSxcbiAgICAgICAgJyMgTG9nZ2luZyBQbGFuXFxuXFxuPG9iamVjdGl2ZT5Mb2dnaW5nIGNvbmZpZzwvb2JqZWN0aXZlPidcbiAgICAgICk7XG5cbiAgICAgIGNvbnN0IHByb2plY3QgPSBhd2FpdCBwYXJzZVBsYW5uaW5nRGlyZWN0b3J5KHBsYW5uaW5nKTtcblxuICAgICAgYXNzZXJ0Lm9rKCc0NS1jb3JlLWluZnJhc3RydWN0dXJlJyBpbiBwcm9qZWN0LnBoYXNlcywgJ2R1cCBudW1zOiBjb3JlLWluZnJhc3RydWN0dXJlIHBoYXNlIHByZXNlbnQnKTtcbiAgICAgIGFzc2VydC5vaygnNDUtbG9nZ2luZy1jb25maWcnIGluIHByb2plY3QucGhhc2VzLCAnZHVwIG51bXM6IGxvZ2dpbmctY29uZmlnIHBoYXNlIHByZXNlbnQnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocHJvamVjdC5waGFzZXNbJzQ1LWNvcmUtaW5mcmFzdHJ1Y3R1cmUnXT8ubnVtYmVyLCA0NSwgJ2R1cCBudW1zOiBib3RoIGhhdmUgbnVtYmVyIDQ1IChhKScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwcm9qZWN0LnBoYXNlc1snNDUtbG9nZ2luZy1jb25maWcnXT8ubnVtYmVyLCA0NSwgJ2R1cCBudW1zOiBib3RoIGhhdmUgbnVtYmVyIDQ1IChiKScpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbn0pO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUZXN0IDU6IFhNTC1pbi1tYXJrZG93biBwbGFuIHBhcnNpbmcgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoJ1BsYW4gZmlsZSB3aXRoIFhNTC1pbi1tYXJrZG93bicsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcGxhbm5pbmcgPSBjcmVhdGVQbGFubmluZ0RpcihiYXNlKTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihwbGFubmluZywgJ1JPQURNQVAubWQnKSwgU0FNUExFX1JPQURNQVApO1xuXG4gICAgICBjb25zdCBwaGFzZURpciA9IGpvaW4ocGxhbm5pbmcsICdwaGFzZXMnLCAnMjktYXV0aC1zeXN0ZW0nKTtcbiAgICAgIG1rZGlyU3luYyhwaGFzZURpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4ocGhhc2VEaXIsICcyOS0wMS1QTEFOLm1kJyksIFNBTVBMRV9QTEFOX1hNTCk7XG5cbiAgICAgIGNvbnN0IHByb2plY3QgPSBhd2FpdCBwYXJzZVBsYW5uaW5nRGlyZWN0b3J5KHBsYW5uaW5nKTtcbiAgICAgIGNvbnN0IHBsYW4gPSBwcm9qZWN0LnBoYXNlc1snMjktYXV0aC1zeXN0ZW0nXT8ucGxhbnM/LlsnMDEnXTtcblxuICAgICAgYXNzZXJ0Lm9rKHBsYW4gIT09IHVuZGVmaW5lZCwgJ3htbCBwbGFuOiBwbGFuIGV4aXN0cycpO1xuICAgICAgYXNzZXJ0Lm9rKHBsYW4/Lm9iamVjdGl2ZT8uaW5jbHVkZXMoJ2F1dGhlbnRpY2F0aW9uJykgPz8gZmFsc2UsICd4bWwgcGxhbjogb2JqZWN0aXZlIGV4dHJhY3RlZCcpO1xuICAgICAgYXNzZXJ0Lm9rKChwbGFuPy50YXNrcz8ubGVuZ3RoID8/IDApID09PSAzLCAneG1sIHBsYW46IDMgdGFza3MgZXh0cmFjdGVkJyk7XG4gICAgICBhc3NlcnQub2socGxhbj8udGFza3M/LlswXT8uaW5jbHVkZXMoJ2F1dGggbWlkZGxld2FyZScpID8/IGZhbHNlLCAneG1sIHBsYW46IGZpcnN0IHRhc2sgY29udGVudCcpO1xuICAgICAgYXNzZXJ0Lm9rKHBsYW4/LmNvbnRleHQ/LmluY2x1ZGVzKCdKV1QnKSA/PyBmYWxzZSwgJ3htbCBwbGFuOiBjb250ZXh0IGV4dHJhY3RlZCcpO1xuICAgICAgYXNzZXJ0Lm9rKHBsYW4/LnZlcmlmaWNhdGlvbj8uaW5jbHVkZXMoJ0xvZ2luIHJldHVybnMnKSA/PyBmYWxzZSwgJ3htbCBwbGFuOiB2ZXJpZmljYXRpb24gZXh0cmFjdGVkJyk7XG4gICAgICBhc3NlcnQub2socGxhbj8uc3VjY2Vzc0NyaXRlcmlhPy5pbmNsdWRlcygnZW5kcG9pbnRzIHJlc3BvbmQnKSA/PyBmYWxzZSwgJ3htbCBwbGFuOiBzdWNjZXNzIGNyaXRlcmlhIGV4dHJhY3RlZCcpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbn0pO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUZXN0IDY6IFN1bW1hcnkgZmlsZSB3aXRoIFlBTUwgZnJvbnRtYXR0ZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoJ1N1bW1hcnkgZmlsZSB3aXRoIFlBTUwgZnJvbnRtYXR0ZXInLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHBsYW5uaW5nID0gY3JlYXRlUGxhbm5pbmdEaXIoYmFzZSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4ocGxhbm5pbmcsICdST0FETUFQLm1kJyksIFNBTVBMRV9ST0FETUFQKTtcblxuICAgICAgY29uc3QgcGhhc2VEaXIgPSBqb2luKHBsYW5uaW5nLCAncGhhc2VzJywgJzI5LWF1dGgtc3lzdGVtJyk7XG4gICAgICBta2RpclN5bmMocGhhc2VEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHBoYXNlRGlyLCAnMjktMDEtU1VNTUFSWS5tZCcpLCBTQU1QTEVfU1VNTUFSWSk7XG5cbiAgICAgIGNvbnN0IHByb2plY3QgPSBhd2FpdCBwYXJzZVBsYW5uaW5nRGlyZWN0b3J5KHBsYW5uaW5nKTtcbiAgICAgIGNvbnN0IHN1bW1hcnkgPSBwcm9qZWN0LnBoYXNlc1snMjktYXV0aC1zeXN0ZW0nXT8uc3VtbWFyaWVzPy5bJzAxJ107XG5cbiAgICAgIGFzc2VydC5vayhzdW1tYXJ5ICE9PSB1bmRlZmluZWQsICdzdW1tYXJ5IGZtOiBzdW1tYXJ5IGV4aXN0cycpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdW1tYXJ5Py5mcm9udG1hdHRlcj8ucGhhc2UsICcyOS1hdXRoLXN5c3RlbScsICdzdW1tYXJ5IGZtOiBwaGFzZScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdW1tYXJ5Py5mcm9udG1hdHRlcj8ucGxhbiwgJzAxJywgJ3N1bW1hcnkgZm06IHBsYW4nKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3VtbWFyeT8uZnJvbnRtYXR0ZXI/LnN1YnN5c3RlbSwgJ2F1dGgnLCAnc3VtbWFyeSBmbTogc3Vic3lzdGVtJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN1bW1hcnk/LmZyb250bWF0dGVyPy50YWdzLCBbJ2F1dGhlbnRpY2F0aW9uJywgJ3NlY3VyaXR5J10sICdzdW1tYXJ5IGZtOiB0YWdzJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN1bW1hcnk/LmZyb250bWF0dGVyPy5wcm92aWRlcywgWydhdXRoLW1pZGRsZXdhcmUnLCAnand0LXZhbGlkYXRpb24nXSwgJ3N1bW1hcnkgZm06IHByb3ZpZGVzJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN1bW1hcnk/LmZyb250bWF0dGVyPy5hZmZlY3RzLCBbJ2FwaS1yb3V0ZXMnXSwgJ3N1bW1hcnkgZm06IGFmZmVjdHMnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3VtbWFyeT8uZnJvbnRtYXR0ZXI/LlsndGVjaC1zdGFjayddLCBbJ2pzb253ZWJ0b2tlbicsICdleHByZXNzJ10sICdzdW1tYXJ5IGZtOiB0ZWNoLXN0YWNrJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN1bW1hcnk/LmZyb250bWF0dGVyPy5bJ2tleS1maWxlcyddLCBbJ3NyYy9hdXRoLnRzJywgJ3NyYy9taWRkbGV3YXJlL2F1dGgudHMnXSwgJ3N1bW1hcnkgZm06IGtleS1maWxlcycpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdW1tYXJ5Py5mcm9udG1hdHRlcj8uWydrZXktZGVjaXNpb25zJ10sIFsnVXNlIFJTMjU2IGZvciBKV1Qgc2lnbmluZycsICdTdG9yZSByZWZyZXNoIHRva2VucyBpbiBEQiddLCAnc3VtbWFyeSBmbToga2V5LWRlY2lzaW9ucycpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdW1tYXJ5Py5mcm9udG1hdHRlcj8uWydwYXR0ZXJucy1lc3RhYmxpc2hlZCddLCBbJ01pZGRsZXdhcmUtYmFzZWQgYXV0aCddLCAnc3VtbWFyeSBmbTogcGF0dGVybnMtZXN0YWJsaXNoZWQnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3VtbWFyeT8uZnJvbnRtYXR0ZXI/LmR1cmF0aW9uLCAnMmgnLCAnc3VtbWFyeSBmbTogZHVyYXRpb24nKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3VtbWFyeT8uZnJvbnRtYXR0ZXI/LmNvbXBsZXRlZCwgJzIwMjYtMDEtMTUnLCAnc3VtbWFyeSBmbTogY29tcGxldGVkJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxufSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRlc3QgNzogT3JwaGFuIHN1bW1hcmllcyAobm8gbWF0Y2hpbmcgcGxhbikgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoJ09ycGhhbiBzdW1tYXJpZXMgKG5vIG1hdGNoaW5nIHBsYW4pJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBwbGFubmluZyA9IGNyZWF0ZVBsYW5uaW5nRGlyKGJhc2UpO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHBsYW5uaW5nLCAnUk9BRE1BUC5tZCcpLCBTQU1QTEVfUk9BRE1BUCk7XG5cbiAgICAgIGNvbnN0IHBoYXNlRGlyID0gam9pbihwbGFubmluZywgJ3BoYXNlcycsICc0NS1sb2dnaW5nLWNvbmZpZycpO1xuICAgICAgbWtkaXJTeW5jKHBoYXNlRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAgICAgLy8gU3VtbWFyaWVzIHdpdGhvdXQgY29ycmVzcG9uZGluZyBwbGFuc1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHBoYXNlRGlyLCAnNDUtMDQtU1VNTUFSWS5tZCcpLCBgLS0tXG5waGFzZTogXCI0NS1sb2dnaW5nLWNvbmZpZ1wiXG5wbGFuOiBcIjA0XCJcbnN1YnN5c3RlbTogXCJsb2dnaW5nXCJcbi0tLVxuXG4jIDQ1LTA0IFN1bW1hcnlcblxuT3JwaGFuIHN1bW1hcnkgY29udGVudC5cbmApO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHBoYXNlRGlyLCAnNDUtMDUtU1VNTUFSWS5tZCcpLCBgLS0tXG5waGFzZTogXCI0NS1sb2dnaW5nLWNvbmZpZ1wiXG5wbGFuOiBcIjA1XCJcbnN1YnN5c3RlbTogXCJsb2dnaW5nXCJcbi0tLVxuXG4jIDQ1LTA1IFN1bW1hcnlcblxuQW5vdGhlciBvcnBoYW4uXG5gKTtcblxuICAgICAgY29uc3QgcHJvamVjdCA9IGF3YWl0IHBhcnNlUGxhbm5pbmdEaXJlY3RvcnkocGxhbm5pbmcpO1xuICAgICAgY29uc3QgcGhhc2UgPSBwcm9qZWN0LnBoYXNlc1snNDUtbG9nZ2luZy1jb25maWcnXTtcblxuICAgICAgYXNzZXJ0Lm9rKHBoYXNlICE9PSB1bmRlZmluZWQsICdvcnBoYW46IHBoYXNlIGV4aXN0cycpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChPYmplY3Qua2V5cyhwaGFzZT8ucGxhbnMgPz8ge30pLmxlbmd0aCwgMCwgJ29ycGhhbjogbm8gcGxhbnMnKTtcbiAgICAgIGFzc2VydC5vayhPYmplY3Qua2V5cyhwaGFzZT8uc3VtbWFyaWVzID8/IHt9KS5sZW5ndGggPj0gMiwgJ29ycGhhbjogc3VtbWFyaWVzIHByZXNlcnZlZCcpO1xuICAgICAgYXNzZXJ0Lm9rKCcwNCcgaW4gKHBoYXNlPy5zdW1tYXJpZXMgPz8ge30pLCAnb3JwaGFuOiBzdW1tYXJ5IDA0IHByZXNlbnQnKTtcbiAgICAgIGFzc2VydC5vaygnMDUnIGluIChwaGFzZT8uc3VtbWFyaWVzID8/IHt9KSwgJ29ycGhhbjogc3VtbWFyeSAwNSBwcmVzZW50Jyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxufSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRlc3QgODogLmFyY2hpdmUvIGRpcmVjdG9yeSBza2lwcGVkIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KCcuYXJjaGl2ZS8gZGlyZWN0b3J5IFx1MjE5MiBza2lwcGVkIGJ5IGRlZmF1bHQnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHBsYW5uaW5nID0gY3JlYXRlUGxhbm5pbmdEaXIoYmFzZSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4ocGxhbm5pbmcsICdST0FETUFQLm1kJyksIFNBTVBMRV9ST0FETUFQKTtcblxuICAgICAgLy8gTm9ybWFsIHBoYXNlXG4gICAgICBjb25zdCBwaGFzZURpciA9IGpvaW4ocGxhbm5pbmcsICdwaGFzZXMnLCAnMjktYXV0aC1zeXN0ZW0nKTtcbiAgICAgIG1rZGlyU3luYyhwaGFzZURpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4ocGhhc2VEaXIsICcyOS0wMS1QTEFOLm1kJyksIFNBTVBMRV9QTEFOX1hNTCk7XG5cbiAgICAgIC8vIEFyY2hpdmVkIHBoYXNlIChzaG91bGQgYmUgc2tpcHBlZClcbiAgICAgIGNvbnN0IGFyY2hpdmVEaXIgPSBqb2luKHBsYW5uaW5nLCAnLmFyY2hpdmUnLCAndjIuNS1kZXBsb3knLCAnMjktb2xkLWF1dGgnKTtcbiAgICAgIG1rZGlyU3luYyhhcmNoaXZlRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihhcmNoaXZlRGlyLCAnMjktMDEtUExBTi5tZCcpLCAnIyBBcmNoaXZlZCBwbGFuJyk7XG5cbiAgICAgIGNvbnN0IHByb2plY3QgPSBhd2FpdCBwYXJzZVBsYW5uaW5nRGlyZWN0b3J5KHBsYW5uaW5nKTtcblxuICAgICAgYXNzZXJ0Lm9rKCcyOS1hdXRoLXN5c3RlbScgaW4gcHJvamVjdC5waGFzZXMsICdhcmNoaXZlOiBub3JtYWwgcGhhc2UgcHJlc2VudCcpO1xuICAgICAgLy8gQXJjaGl2ZSBwaGFzZXMgc2hvdWxkIG5vdCBhcHBlYXIgaW4gdGhlIHBoYXNlcyBtYXBcbiAgICAgIGFzc2VydC5vayghT2JqZWN0LmtleXMocHJvamVjdC5waGFzZXMpLnNvbWUoayA9PiBrLmluY2x1ZGVzKCdvbGQtYXV0aCcpKSwgJ2FyY2hpdmU6IGFyY2hpdmVkIHBoYXNlIG5vdCBwcmVzZW50Jyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxufSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRlc3QgOTogUXVpY2sgdGFza3MgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoJ1F1aWNrIHRhc2tzIHBhcnNlZCcsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcGxhbm5pbmcgPSBjcmVhdGVQbGFubmluZ0RpcihiYXNlKTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihwbGFubmluZywgJ1JPQURNQVAubWQnKSwgU0FNUExFX1JPQURNQVApO1xuXG4gICAgICAvLyBRdWljayB0YXNrIDFcbiAgICAgIGNvbnN0IHF0MSA9IGpvaW4ocGxhbm5pbmcsICdxdWljaycsICcwMDEtZml4LWxvZ2luJyk7XG4gICAgICBta2RpclN5bmMocXQxLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihxdDEsICcwMDEtUExBTi5tZCcpLCBTQU1QTEVfUVVJQ0tfUExBTik7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4ocXQxLCAnMDAxLVNVTU1BUlkubWQnKSwgU0FNUExFX1FVSUNLX1NVTU1BUlkpO1xuXG4gICAgICAvLyBRdWljayB0YXNrIDIgKHBsYW4gb25seSwgbm8gc3VtbWFyeSlcbiAgICAgIGNvbnN0IHF0MiA9IGpvaW4ocGxhbm5pbmcsICdxdWljaycsICcwMDItdXBkYXRlLWRlcHMnKTtcbiAgICAgIG1rZGlyU3luYyhxdDIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHF0MiwgJzAwMi1QTEFOLm1kJyksICcjIDAwMjogVXBkYXRlIERlcGVuZGVuY2llc1xcblxcblVwZGF0ZSBhbGwgZGVwcy4nKTtcblxuICAgICAgY29uc3QgcHJvamVjdCA9IGF3YWl0IHBhcnNlUGxhbm5pbmdEaXJlY3RvcnkocGxhbm5pbmcpO1xuXG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHByb2plY3QucXVpY2tUYXNrcy5sZW5ndGgsIDIsICdxdWljazogMiBxdWljayB0YXNrcycpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwcm9qZWN0LnF1aWNrVGFza3NbMF0/Lm51bWJlciwgMSwgJ3F1aWNrOiBmaXJzdCB0YXNrIG51bWJlcicpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwcm9qZWN0LnF1aWNrVGFza3NbMF0/LnNsdWcsICdmaXgtbG9naW4nLCAncXVpY2s6IGZpcnN0IHRhc2sgc2x1ZycpO1xuICAgICAgYXNzZXJ0Lm9rKHByb2plY3QucXVpY2tUYXNrc1swXT8ucGxhbiAhPT0gbnVsbCwgJ3F1aWNrOiBmaXJzdCB0YXNrIGhhcyBwbGFuJyk7XG4gICAgICBhc3NlcnQub2socHJvamVjdC5xdWlja1Rhc2tzWzBdPy5zdW1tYXJ5ICE9PSBudWxsLCAncXVpY2s6IGZpcnN0IHRhc2sgaGFzIHN1bW1hcnknKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocHJvamVjdC5xdWlja1Rhc2tzWzFdPy5udW1iZXIsIDIsICdxdWljazogc2Vjb25kIHRhc2sgbnVtYmVyJyk7XG4gICAgICBhc3NlcnQub2socHJvamVjdC5xdWlja1Rhc2tzWzFdPy5wbGFuICE9PSBudWxsLCAncXVpY2s6IHNlY29uZCB0YXNrIGhhcyBwbGFuJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHByb2plY3QucXVpY2tUYXNrc1sxXT8uc3VtbWFyeSwgbnVsbCwgJ3F1aWNrOiBzZWNvbmQgdGFzayBoYXMgbm8gc3VtbWFyeScpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbn0pO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUZXN0IDEwOiBSb2FkbWFwIHdpdGggbWlsZXN0b25lIHNlY3Rpb25zIGFuZCA8ZGV0YWlscz4gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoJ1JvYWRtYXAgd2l0aCBtaWxlc3RvbmUgc2VjdGlvbnMgYW5kIDxkZXRhaWxzPiBibG9ja3MnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHBsYW5uaW5nID0gY3JlYXRlUGxhbm5pbmdEaXIoYmFzZSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4ocGxhbm5pbmcsICdST0FETUFQLm1kJyksIFNBTVBMRV9NSUxFU1RPTkVfU0VDVElPTkVEX1JPQURNQVApO1xuXG4gICAgICBjb25zdCBwcm9qZWN0ID0gYXdhaXQgcGFyc2VQbGFubmluZ0RpcmVjdG9yeShwbGFubmluZyk7XG5cbiAgICAgIGFzc2VydC5vayhwcm9qZWN0LnJvYWRtYXAgIT09IG51bGwsICdtcyByb2FkbWFwOiByb2FkbWFwIHBhcnNlZCcpO1xuICAgICAgYXNzZXJ0Lm9rKChwcm9qZWN0LnJvYWRtYXA/Lm1pbGVzdG9uZXM/Lmxlbmd0aCA/PyAwKSA+PSAyLCAnbXMgcm9hZG1hcDogaGFzIG1pbGVzdG9uZSBzZWN0aW9ucycpO1xuXG4gICAgICAvLyBDaGVjayBjb2xsYXBzZWQgbWlsZXN0b25lXG4gICAgICBjb25zdCB2MjAgPSBwcm9qZWN0LnJvYWRtYXA/Lm1pbGVzdG9uZXM/LmZpbmQobSA9PiBtLmlkLmluY2x1ZGVzKCcyLjAnKSk7XG4gICAgICBhc3NlcnQub2sodjIwICE9PSB1bmRlZmluZWQsICdtcyByb2FkbWFwOiB2Mi4wIG1pbGVzdG9uZSBmb3VuZCcpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbCh2MjA/LmNvbGxhcHNlZCwgdHJ1ZSwgJ21zIHJvYWRtYXA6IHYyLjAgaXMgY29sbGFwc2VkJyk7XG4gICAgICBhc3NlcnQub2soKHYyMD8ucGhhc2VzPy5sZW5ndGggPz8gMCkgPj0gMiwgJ21zIHJvYWRtYXA6IHYyLjAgaGFzIHBoYXNlcycpO1xuICAgICAgYXNzZXJ0Lm9rKHYyMD8ucGhhc2VzPy5ldmVyeShwID0+IHAuZG9uZSkgPz8gZmFsc2UsICdtcyByb2FkbWFwOiB2Mi4wIHBoYXNlcyBhbGwgZG9uZScpO1xuXG4gICAgICAvLyBDaGVjayBhY3RpdmUgbWlsZXN0b25lXG4gICAgICBjb25zdCB2MjUgPSBwcm9qZWN0LnJvYWRtYXA/Lm1pbGVzdG9uZXM/LmZpbmQobSA9PiBtLmlkLmluY2x1ZGVzKCcyLjUnKSk7XG4gICAgICBhc3NlcnQub2sodjI1ICE9PSB1bmRlZmluZWQsICdtcyByb2FkbWFwOiB2Mi41IG1pbGVzdG9uZSBmb3VuZCcpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbCh2MjU/LmNvbGxhcHNlZCwgZmFsc2UsICdtcyByb2FkbWFwOiB2Mi41IGlzIG5vdCBjb2xsYXBzZWQnKTtcbiAgICAgIGFzc2VydC5vaygodjI1Py5waGFzZXM/Lmxlbmd0aCA/PyAwKSA+PSAzLCAnbXMgcm9hZG1hcDogdjIuNSBoYXMgcGhhc2VzJyk7XG5cbiAgICAgIC8vIENoZWNrIGNvbXBsZXRpb24gc3RhdGVcbiAgICAgIGNvbnN0IHBoYXNlMjkgPSB2MjU/LnBoYXNlcz8uZmluZChwID0+IHAubnVtYmVyID09PSAyOSk7XG4gICAgICBhc3NlcnQub2socGhhc2UyOT8uZG9uZSA9PT0gdHJ1ZSwgJ21zIHJvYWRtYXA6IHBoYXNlIDI5IGlzIGRvbmUnKTtcbiAgICAgIGNvbnN0IHBoYXNlMzAgPSB2MjU/LnBoYXNlcz8uZmluZChwID0+IHAubnVtYmVyID09PSAzMCk7XG4gICAgICBhc3NlcnQub2socGhhc2UzMD8uZG9uZSA9PT0gZmFsc2UsICdtcyByb2FkbWFwOiBwaGFzZSAzMCBpcyBub3QgZG9uZScpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbn0pO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUZXN0IDExOiBOb24tc3RhbmRhcmQgcGhhc2UgZmlsZXMgXHUyMTkyIGV4dHJhIGZpbGVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KCdOb24tc3RhbmRhcmQgcGhhc2UgZmlsZXMgXHUyMTkyIGNvbGxlY3RlZCBhcyBleHRyYSBmaWxlcycsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcGxhbm5pbmcgPSBjcmVhdGVQbGFubmluZ0RpcihiYXNlKTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihwbGFubmluZywgJ1JPQURNQVAubWQnKSwgU0FNUExFX1JPQURNQVApO1xuXG4gICAgICBjb25zdCBwaGFzZURpciA9IGpvaW4ocGxhbm5pbmcsICdwaGFzZXMnLCAnMzYtYXR0YWNobWVudC1zeXN0ZW0nKTtcbiAgICAgIG1rZGlyU3luYyhwaGFzZURpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4ocGhhc2VEaXIsICczNi0wMS1QTEFOLm1kJyksICc8b2JqZWN0aXZlPkF0dGFjaG1lbnRzPC9vYmplY3RpdmU+Jyk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4ocGhhc2VEaXIsICdCQVNFTElORS5tZCcpLCAnIyBCYXNlbGluZVxcblxcbkJhc2VsaW5lIG1lYXN1cmVtZW50cy4nKTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihwaGFzZURpciwgJ0JVTkRMRS1BTkFMWVNJUy5tZCcpLCAnIyBCdW5kbGUgQW5hbHlzaXNcXG5cXG5SZXN1bHRzLicpO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHBoYXNlRGlyLCAnZGVwY2hlY2stcmVzdWx0cy50eHQnKSwgJ3VudXNlZDogcGtnLWEsIHBrZy1iJyk7XG5cbiAgICAgIGNvbnN0IHByb2plY3QgPSBhd2FpdCBwYXJzZVBsYW5uaW5nRGlyZWN0b3J5KHBsYW5uaW5nKTtcbiAgICAgIGNvbnN0IHBoYXNlID0gcHJvamVjdC5waGFzZXNbJzM2LWF0dGFjaG1lbnQtc3lzdGVtJ107XG5cbiAgICAgIGFzc2VydC5vayhwaGFzZSAhPT0gdW5kZWZpbmVkLCAnZXh0cmE6IHBoYXNlIGV4aXN0cycpO1xuICAgICAgYXNzZXJ0Lm9rKChwaGFzZT8uZXh0cmFGaWxlcz8ubGVuZ3RoID8/IDApID49IDMsICdleHRyYTogbm9uLXN0YW5kYXJkIGZpbGVzIGNvbGxlY3RlZCcpO1xuICAgICAgYXNzZXJ0Lm9rKFxuICAgICAgICBwaGFzZT8uZXh0cmFGaWxlcz8uc29tZShmID0+IGYuZmlsZU5hbWUgPT09ICdCQVNFTElORS5tZCcpID8/IGZhbHNlLFxuICAgICAgICAnZXh0cmE6IEJBU0VMSU5FLm1kIGNvbGxlY3RlZCdcbiAgICAgICk7XG4gICAgICBhc3NlcnQub2soXG4gICAgICAgIHBoYXNlPy5leHRyYUZpbGVzPy5zb21lKGYgPT4gZi5maWxlTmFtZSA9PT0gJ0JVTkRMRS1BTkFMWVNJUy5tZCcpID8/IGZhbHNlLFxuICAgICAgICAnZXh0cmE6IEJVTkRMRS1BTkFMWVNJUy5tZCBjb2xsZWN0ZWQnXG4gICAgICApO1xuICAgICAgYXNzZXJ0Lm9rKFxuICAgICAgICBwaGFzZT8uZXh0cmFGaWxlcz8uc29tZShmID0+IGYuZmlsZU5hbWUgPT09ICdkZXBjaGVjay1yZXN1bHRzLnR4dCcpID8/IGZhbHNlLFxuICAgICAgICAnZXh0cmE6IGRlcGNoZWNrLXJlc3VsdHMudHh0IGNvbGxlY3RlZCdcbiAgICAgICk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxufSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRlc3QgMTI6IFZhbGlkYXRpb24gXHUyMDE0IG1pc3NpbmcgUk9BRE1BUC5tZCBcdTIxOTIgd2FybmluZyAobm90IGZhdGFsKSBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdCgnVmFsaWRhdGlvbjogbWlzc2luZyBST0FETUFQLm1kIFx1MjE5MiB3YXJuaW5nIChub3QgZmF0YWwpJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBwbGFubmluZyA9IGNyZWF0ZVBsYW5uaW5nRGlyKGJhc2UpO1xuICAgICAgLy8gT25seSBQUk9KRUNULm1kLCBubyBST0FETUFQLm1kXG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4ocGxhbm5pbmcsICdQUk9KRUNULm1kJyksIFNBTVBMRV9QUk9KRUNUKTtcblxuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgdmFsaWRhdGVQbGFubmluZ0RpcmVjdG9yeShwbGFubmluZyk7XG5cbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0LnZhbGlkLCB0cnVlLCAnbm8gcm9hZG1hcDogdmFsaWRhdGlvbiBzdGlsbCBwYXNzZXMnKTtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgcmVzdWx0Lmlzc3Vlcy5zb21lKGkgPT4gaS5zZXZlcml0eSA9PT0gJ3dhcm5pbmcnICYmIGkuZmlsZS5pbmNsdWRlcygnUk9BRE1BUCcpKSxcbiAgICAgICAgJ25vIHJvYWRtYXA6IHdhcm5pbmcgaXNzdWUgbWVudGlvbnMgUk9BRE1BUCdcbiAgICAgICk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxufSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRlc3QgMTM6IFZhbGlkYXRpb24gXHUyMDE0IG1pc3NpbmcgUFJPSkVDVC5tZCBcdTIxOTIgd2FybmluZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdCgnVmFsaWRhdGlvbjogbWlzc2luZyBQUk9KRUNULm1kIFx1MjE5MiB3YXJuaW5nJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBwbGFubmluZyA9IGNyZWF0ZVBsYW5uaW5nRGlyKGJhc2UpO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHBsYW5uaW5nLCAnUk9BRE1BUC5tZCcpLCBTQU1QTEVfUk9BRE1BUCk7XG4gICAgICAvLyBObyBQUk9KRUNULm1kXG5cbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHZhbGlkYXRlUGxhbm5pbmdEaXJlY3RvcnkocGxhbm5pbmcpO1xuXG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC52YWxpZCwgdHJ1ZSwgJ25vIHByb2plY3Q6IHZhbGlkYXRpb24gcGFzc2VzICh3YXJuaW5nIG9ubHkpJyk7XG4gICAgICBhc3NlcnQub2soXG4gICAgICAgIHJlc3VsdC5pc3N1ZXMuc29tZShpID0+IGkuc2V2ZXJpdHkgPT09ICd3YXJuaW5nJyAmJiBpLmZpbGUuaW5jbHVkZXMoJ1BST0pFQ1QnKSksXG4gICAgICAgICdubyBwcm9qZWN0OiB3YXJuaW5nIGlzc3VlIG1lbnRpb25zIFBST0pFQ1QnXG4gICAgICApO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbn0pO1xuXG4iXSwKICAibWFwcGluZ3MiOiAiQUFJQSxTQUFTLGFBQWEsV0FBVyxRQUFRLHFCQUFxQjtBQUM5RCxTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBRXZCLFNBQVMsOEJBQThCO0FBQ3ZDLFNBQVMsaUNBQWlDO0FBRzFDLFNBQW1CLFlBQW1DO0FBQ3RELE9BQU8sWUFBWTtBQUluQixTQUFTLG9CQUE0QjtBQUNuQyxTQUFPLFlBQVksS0FBSyxPQUFPLEdBQUcsbUJBQW1CLENBQUM7QUFDeEQ7QUFFQSxTQUFTLGtCQUFrQixNQUFzQjtBQUMvQyxRQUFNLE1BQU0sS0FBSyxNQUFNLFdBQVc7QUFDbEMsWUFBVSxLQUFLLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDbEMsU0FBTztBQUNUO0FBRUEsU0FBUyxVQUFVLFFBQWdCLFdBQWdEO0FBQ2pGLFNBQU8sQ0FBQyxZQUFvQjtBQUMxQixVQUFNLFdBQVcsS0FBSyxLQUFLLEdBQUcsU0FBUztBQUN2QyxjQUFVLEtBQUssVUFBVSxJQUFJLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNuRCxrQkFBYyxVQUFVLE9BQU87QUFBQSxFQUNqQztBQUNGO0FBRUEsU0FBUyxRQUFRLE1BQW9CO0FBQ25DLFNBQU8sTUFBTSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUMvQztBQUlBLE1BQU0saUJBQWlCO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFTdkIsTUFBTSxpQkFBaUI7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBVXZCLE1BQU0sc0JBQXNCO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQXlCNUIsTUFBTSxlQUFlO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFNckIsTUFBTSxnQkFBZ0IsS0FBSyxVQUFVO0FBQUEsRUFDbkMsYUFBYTtBQUFBLEVBQ2IsU0FBUztBQUNYLENBQUM7QUFFRCxNQUFNLGtCQUFrQjtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQTRDeEIsTUFBTSxpQkFBaUI7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQTBDdkIsTUFBTSxrQkFBa0I7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQVl4QixNQUFNLDJCQUEyQjtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQVFqQyxNQUFNLHFDQUFxQztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFtQjNDLE1BQU0sb0JBQW9CO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQWExQixNQUFNLHVCQUF1QjtBQUFBO0FBQUE7QUFBQTtBQVc3QixLQUFLLG9EQUFvRCxZQUFZO0FBQ2pFLFFBQU0sT0FBTyxrQkFBa0I7QUFDL0IsTUFBSTtBQUNGLFVBQU0sV0FBVyxrQkFBa0IsSUFBSTtBQUd2QyxrQkFBYyxLQUFLLFVBQVUsWUFBWSxHQUFHLGNBQWM7QUFDMUQsa0JBQWMsS0FBSyxVQUFVLFlBQVksR0FBRyxjQUFjO0FBQzFELGtCQUFjLEtBQUssVUFBVSxpQkFBaUIsR0FBRyxtQkFBbUI7QUFDcEUsa0JBQWMsS0FBSyxVQUFVLFVBQVUsR0FBRyxZQUFZO0FBQ3RELGtCQUFjLEtBQUssVUFBVSxhQUFhLEdBQUcsYUFBYTtBQUcxRCxVQUFNLFdBQVcsS0FBSyxVQUFVLFVBQVUsZ0JBQWdCO0FBQzFELGNBQVUsVUFBVSxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3ZDLGtCQUFjLEtBQUssVUFBVSxlQUFlLEdBQUcsZUFBZTtBQUM5RCxrQkFBYyxLQUFLLFVBQVUsa0JBQWtCLEdBQUcsY0FBYztBQUNoRSxrQkFBYyxLQUFLLFVBQVUsZ0JBQWdCLEdBQUcsZUFBZTtBQUcvRCxVQUFNLFlBQVksS0FBSyxVQUFVLFVBQVUsY0FBYztBQUN6RCxjQUFVLFdBQVcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUN4QyxrQkFBYyxLQUFLLFdBQVcsZUFBZSxHQUFHO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLENBd0JyRDtBQUdLLFVBQU0sV0FBVyxLQUFLLFVBQVUsU0FBUyxlQUFlO0FBQ3hELGNBQVUsVUFBVSxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3ZDLGtCQUFjLEtBQUssVUFBVSxhQUFhLEdBQUcsaUJBQWlCO0FBQzlELGtCQUFjLEtBQUssVUFBVSxnQkFBZ0IsR0FBRyxvQkFBb0I7QUFHcEUsVUFBTSxRQUFRLEtBQUssVUFBVSxZQUFZO0FBQ3pDLGNBQVUsT0FBTyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3BDLGtCQUFjLEtBQUssT0FBTyxpQkFBaUIsR0FBRyx3QkFBd0I7QUFDdEUsa0JBQWMsS0FBSyxPQUFPLHNCQUFzQixHQUFHLDhCQUE4QjtBQUdqRixVQUFNLGNBQWMsS0FBSyxVQUFVLFVBQVU7QUFDN0MsY0FBVSxhQUFhLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDMUMsa0JBQWMsS0FBSyxhQUFhLGlCQUFpQixHQUFHLG1DQUFtQztBQUV2RixVQUFNLFVBQVUsTUFBTSx1QkFBdUIsUUFBUTtBQUdyRCxXQUFPLGdCQUFnQixRQUFRLE1BQU0sVUFBVSxzQkFBc0I7QUFDckUsV0FBTyxHQUFHLFFBQVEsWUFBWSxNQUFNLG1CQUFtQjtBQUN2RCxXQUFPLEdBQUcsUUFBUSxZQUFZLE1BQU0sbUJBQW1CO0FBQ3ZELFdBQU8sR0FBRyxRQUFRLGFBQWEsU0FBUyxHQUFHLHFCQUFxQjtBQUNoRSxXQUFPLEdBQUcsUUFBUSxVQUFVLE1BQU0saUJBQWlCO0FBQ25ELFdBQU8sR0FBRyxRQUFRLFdBQVcsTUFBTSxvQkFBb0I7QUFHdkQsV0FBTyxHQUFHLG9CQUFvQixRQUFRLFFBQVEsa0JBQWtCO0FBQ2hFLFdBQU8sR0FBRyxrQkFBa0IsUUFBUSxRQUFRLGtCQUFrQjtBQUU5RCxVQUFNLFVBQVUsUUFBUSxPQUFPLGdCQUFnQjtBQUMvQyxXQUFPLGdCQUFnQixTQUFTLFFBQVEsSUFBSSxpQkFBaUI7QUFDN0QsV0FBTyxnQkFBZ0IsU0FBUyxNQUFNLGVBQWUsZUFBZTtBQUNwRSxXQUFPLEdBQUcsU0FBUyxTQUFTLFNBQVMsQ0FBQyxJQUFJLHNCQUFzQjtBQUNoRSxXQUFPLEdBQUcsU0FBUyxTQUFTLGFBQWEsQ0FBQyxJQUFJLHlCQUF5QjtBQUN2RSxXQUFPLElBQUksU0FBUyxVQUFVLFVBQVUsS0FBSyxHQUFHLHVCQUF1QjtBQUd2RSxVQUFNLFNBQVMsU0FBUyxRQUFRLElBQUk7QUFDcEMsV0FBTyxHQUFHLFdBQVcsUUFBVyxtQkFBbUI7QUFDbkQsV0FBTyxHQUFHLFFBQVEsV0FBVyxTQUFTLGdCQUFnQixLQUFLLE9BQU8sMEJBQTBCO0FBQzVGLFdBQU8sSUFBSSxRQUFRLE9BQU8sVUFBVSxNQUFNLEdBQUcsc0JBQXNCO0FBQ25FLFdBQU8sR0FBRyxRQUFRLFNBQVMsU0FBUyxLQUFLLEtBQUssT0FBTyx3QkFBd0I7QUFDN0UsV0FBTyxHQUFHLFFBQVEsaUJBQWlCLElBQUksNkJBQTZCO0FBQ3BFLFdBQU8sR0FBRyxRQUFRLG9CQUFvQixJQUFJLGlDQUFpQztBQUczRSxXQUFPLGdCQUFnQixRQUFRLGFBQWEsT0FBTyxrQkFBa0Isd0JBQXdCO0FBQzdGLFdBQU8sZ0JBQWdCLFFBQVEsYUFBYSxNQUFNLE1BQU0sdUJBQXVCO0FBQy9FLFdBQU8sZ0JBQWdCLFFBQVEsYUFBYSxNQUFNLGtCQUFrQix1QkFBdUI7QUFDM0YsV0FBTyxnQkFBZ0IsUUFBUSxhQUFhLE1BQU0sR0FBRyx1QkFBdUI7QUFDNUUsV0FBTyxnQkFBZ0IsUUFBUSxhQUFhLFlBQVksTUFBTSw2QkFBNkI7QUFHM0YsVUFBTSxZQUFZLFNBQVMsWUFBWSxJQUFJO0FBQzNDLFdBQU8sR0FBRyxjQUFjLFFBQVcsc0JBQXNCO0FBQ3pELFdBQU8sZ0JBQWdCLFdBQVcsYUFBYSxPQUFPLGtCQUFrQiwyQkFBMkI7QUFDbkcsV0FBTyxnQkFBZ0IsV0FBVyxhQUFhLE1BQU0sTUFBTSwwQkFBMEI7QUFDckYsV0FBTyxnQkFBZ0IsV0FBVyxhQUFhLFdBQVcsUUFBUSwrQkFBK0I7QUFDakcsV0FBTyxJQUFJLFdBQVcsYUFBYSxNQUFNLFVBQVUsTUFBTSxHQUFHLDBCQUEwQjtBQUN0RixXQUFPLElBQUksV0FBVyxhQUFhLFVBQVUsVUFBVSxNQUFNLEdBQUcsOEJBQThCO0FBQzlGLFdBQU8sSUFBSSxXQUFXLGFBQWEsU0FBUyxVQUFVLE1BQU0sR0FBRyw2QkFBNkI7QUFDNUYsV0FBTyxJQUFJLFdBQVcsY0FBYyxZQUFZLEdBQUcsVUFBVSxNQUFNLEdBQUcsZ0NBQWdDO0FBQ3RHLFdBQU8sSUFBSSxXQUFXLGNBQWMsV0FBVyxHQUFHLFVBQVUsTUFBTSxHQUFHLCtCQUErQjtBQUNwRyxXQUFPLElBQUksV0FBVyxjQUFjLGVBQWUsR0FBRyxVQUFVLE1BQU0sR0FBRyxtQ0FBbUM7QUFDNUcsV0FBTyxJQUFJLFdBQVcsY0FBYyxzQkFBc0IsR0FBRyxVQUFVLE1BQU0sR0FBRywwQ0FBMEM7QUFDMUgsV0FBTyxnQkFBZ0IsV0FBVyxhQUFhLFVBQVUsTUFBTSw4QkFBOEI7QUFDN0YsV0FBTyxnQkFBZ0IsV0FBVyxhQUFhLFdBQVcsY0FBYywrQkFBK0I7QUFHdkcsV0FBTyxHQUFHLFFBQVEsV0FBVyxVQUFVLEdBQUcsb0JBQW9CO0FBQzlELFdBQU8sZ0JBQWdCLFFBQVEsV0FBVyxDQUFDLEdBQUcsUUFBUSxHQUFHLG1CQUFtQjtBQUM1RSxXQUFPLEdBQUcsUUFBUSxXQUFXLENBQUMsR0FBRyxTQUFTLE1BQU0scUJBQXFCO0FBQ3JFLFdBQU8sR0FBRyxRQUFRLFdBQVcsQ0FBQyxHQUFHLFlBQVksTUFBTSx3QkFBd0I7QUFHM0UsV0FBTyxHQUFHLFFBQVEsV0FBVyxVQUFVLEdBQUcsbUJBQW1CO0FBRzdELFdBQU8sR0FBRyxRQUFRLFNBQVMsVUFBVSxHQUFHLHNCQUFzQjtBQUc5RCxXQUFPLGdCQUFnQixRQUFRLFFBQVEsYUFBYSxnQkFBZ0Isb0JBQW9CO0FBR3hGLFdBQU8sR0FBRyxRQUFRLE9BQU8sY0FBYyxTQUFTLElBQUksS0FBSyxPQUFPLHFCQUFxQjtBQUNyRixXQUFPLGdCQUFnQixRQUFRLE9BQU8sUUFBUSxlQUFlLGNBQWM7QUFHM0UsV0FBTyxnQkFBZ0IsUUFBUSxXQUFXLE9BQU8sTUFBTSxvQ0FBb0M7QUFDM0YsV0FBTyxnQkFBZ0IsUUFBUSxXQUFXLE9BQU8sUUFBUSxHQUFHLHNCQUFzQjtBQUFBLEVBQ3BGLFVBQUU7QUFDQSxZQUFRLElBQUk7QUFBQSxFQUNkO0FBQ0osQ0FBQztBQUlELEtBQUssaURBQWlELFlBQVk7QUFDOUQsUUFBTSxPQUFPLGtCQUFrQjtBQUMvQixNQUFJO0FBQ0YsVUFBTSxXQUFXLGtCQUFrQixJQUFJO0FBQ3ZDLGtCQUFjLEtBQUssVUFBVSxZQUFZLEdBQUcsY0FBYztBQUUxRCxVQUFNLFVBQVUsTUFBTSx1QkFBdUIsUUFBUTtBQUVyRCxXQUFPLGdCQUFnQixRQUFRLFNBQVMsTUFBTSw2QkFBNkI7QUFDM0UsV0FBTyxHQUFHLFFBQVEsWUFBWSxNQUFNLDRCQUE0QjtBQUNoRSxXQUFPLGdCQUFnQixRQUFRLGFBQWEsUUFBUSxHQUFHLDBCQUEwQjtBQUNqRixXQUFPLGdCQUFnQixRQUFRLE9BQU8sTUFBTSxtQkFBbUI7QUFDL0QsV0FBTyxnQkFBZ0IsUUFBUSxRQUFRLE1BQU0sb0JBQW9CO0FBQ2pFLFdBQU8sZ0JBQWdCLE9BQU8sS0FBSyxRQUFRLE1BQU0sRUFBRSxRQUFRLEdBQUcsb0JBQW9CO0FBQ2xGLFdBQU8sZ0JBQWdCLFFBQVEsV0FBVyxRQUFRLEdBQUcseUJBQXlCO0FBQzlFLFdBQU8sZ0JBQWdCLFFBQVEsV0FBVyxRQUFRLEdBQUcsd0JBQXdCO0FBQzdFLFdBQU8sZ0JBQWdCLFFBQVEsU0FBUyxRQUFRLEdBQUcsc0JBQXNCO0FBQ3pFLFdBQU8sZ0JBQWdCLFFBQVEsV0FBVyxPQUFPLE1BQU0sNEJBQTRCO0FBQUEsRUFDckYsVUFBRTtBQUNBLFlBQVEsSUFBSTtBQUFBLEVBQ2Q7QUFDSixDQUFDO0FBSUQsS0FBSywyREFBc0QsWUFBWTtBQUNuRSxRQUFNLE9BQU8sa0JBQWtCO0FBQy9CLE1BQUk7QUFDRixVQUFNLFNBQVMsTUFBTSwwQkFBMEIsS0FBSyxNQUFNLGFBQWEsQ0FBQztBQUV4RSxXQUFPLGdCQUFnQixPQUFPLE9BQU8sT0FBTywrQkFBK0I7QUFDM0UsV0FBTyxHQUFHLE9BQU8sT0FBTyxTQUFTLEdBQUcseUJBQXlCO0FBQzdELFdBQU87QUFBQSxNQUNMLE9BQU8sT0FBTyxLQUFLLE9BQUssRUFBRSxhQUFhLE9BQU87QUFBQSxNQUM5QztBQUFBLElBQ0Y7QUFBQSxFQUNGLFVBQUU7QUFDQSxZQUFRLElBQUk7QUFBQSxFQUNkO0FBQ0osQ0FBQztBQUlELEtBQUssMENBQTBDLFlBQVk7QUFDdkQsUUFBTSxPQUFPLGtCQUFrQjtBQUMvQixNQUFJO0FBQ0YsVUFBTSxXQUFXLGtCQUFrQixJQUFJO0FBQ3ZDLGtCQUFjLEtBQUssVUFBVSxZQUFZLEdBQUcsY0FBYztBQUUxRCxVQUFNLFlBQVksS0FBSyxVQUFVLFFBQVE7QUFDekMsY0FBVSxLQUFLLFdBQVcsd0JBQXdCLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUN4RSxjQUFVLEtBQUssV0FBVyxtQkFBbUIsR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBRW5FO0FBQUEsTUFDRSxLQUFLLFdBQVcsMEJBQTBCLGVBQWU7QUFBQSxNQUN6RDtBQUFBLElBQ0Y7QUFDQTtBQUFBLE1BQ0UsS0FBSyxXQUFXLHFCQUFxQixlQUFlO0FBQUEsTUFDcEQ7QUFBQSxJQUNGO0FBRUEsVUFBTSxVQUFVLE1BQU0sdUJBQXVCLFFBQVE7QUFFckQsV0FBTyxHQUFHLDRCQUE0QixRQUFRLFFBQVEsNkNBQTZDO0FBQ25HLFdBQU8sR0FBRyx1QkFBdUIsUUFBUSxRQUFRLHdDQUF3QztBQUN6RixXQUFPLGdCQUFnQixRQUFRLE9BQU8sd0JBQXdCLEdBQUcsUUFBUSxJQUFJLG1DQUFtQztBQUNoSCxXQUFPLGdCQUFnQixRQUFRLE9BQU8sbUJBQW1CLEdBQUcsUUFBUSxJQUFJLG1DQUFtQztBQUFBLEVBQzdHLFVBQUU7QUFDQSxZQUFRLElBQUk7QUFBQSxFQUNkO0FBQ0osQ0FBQztBQUlELEtBQUssa0NBQWtDLFlBQVk7QUFDL0MsUUFBTSxPQUFPLGtCQUFrQjtBQUMvQixNQUFJO0FBQ0YsVUFBTSxXQUFXLGtCQUFrQixJQUFJO0FBQ3ZDLGtCQUFjLEtBQUssVUFBVSxZQUFZLEdBQUcsY0FBYztBQUUxRCxVQUFNLFdBQVcsS0FBSyxVQUFVLFVBQVUsZ0JBQWdCO0FBQzFELGNBQVUsVUFBVSxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3ZDLGtCQUFjLEtBQUssVUFBVSxlQUFlLEdBQUcsZUFBZTtBQUU5RCxVQUFNLFVBQVUsTUFBTSx1QkFBdUIsUUFBUTtBQUNyRCxVQUFNLE9BQU8sUUFBUSxPQUFPLGdCQUFnQixHQUFHLFFBQVEsSUFBSTtBQUUzRCxXQUFPLEdBQUcsU0FBUyxRQUFXLHVCQUF1QjtBQUNyRCxXQUFPLEdBQUcsTUFBTSxXQUFXLFNBQVMsZ0JBQWdCLEtBQUssT0FBTywrQkFBK0I7QUFDL0YsV0FBTyxJQUFJLE1BQU0sT0FBTyxVQUFVLE9BQU8sR0FBRyw2QkFBNkI7QUFDekUsV0FBTyxHQUFHLE1BQU0sUUFBUSxDQUFDLEdBQUcsU0FBUyxpQkFBaUIsS0FBSyxPQUFPLDhCQUE4QjtBQUNoRyxXQUFPLEdBQUcsTUFBTSxTQUFTLFNBQVMsS0FBSyxLQUFLLE9BQU8sNkJBQTZCO0FBQ2hGLFdBQU8sR0FBRyxNQUFNLGNBQWMsU0FBUyxlQUFlLEtBQUssT0FBTyxrQ0FBa0M7QUFDcEcsV0FBTyxHQUFHLE1BQU0saUJBQWlCLFNBQVMsbUJBQW1CLEtBQUssT0FBTyxzQ0FBc0M7QUFBQSxFQUNqSCxVQUFFO0FBQ0EsWUFBUSxJQUFJO0FBQUEsRUFDZDtBQUNKLENBQUM7QUFJRCxLQUFLLHNDQUFzQyxZQUFZO0FBQ25ELFFBQU0sT0FBTyxrQkFBa0I7QUFDL0IsTUFBSTtBQUNGLFVBQU0sV0FBVyxrQkFBa0IsSUFBSTtBQUN2QyxrQkFBYyxLQUFLLFVBQVUsWUFBWSxHQUFHLGNBQWM7QUFFMUQsVUFBTSxXQUFXLEtBQUssVUFBVSxVQUFVLGdCQUFnQjtBQUMxRCxjQUFVLFVBQVUsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUN2QyxrQkFBYyxLQUFLLFVBQVUsa0JBQWtCLEdBQUcsY0FBYztBQUVoRSxVQUFNLFVBQVUsTUFBTSx1QkFBdUIsUUFBUTtBQUNyRCxVQUFNLFVBQVUsUUFBUSxPQUFPLGdCQUFnQixHQUFHLFlBQVksSUFBSTtBQUVsRSxXQUFPLEdBQUcsWUFBWSxRQUFXLDRCQUE0QjtBQUM3RCxXQUFPLGdCQUFnQixTQUFTLGFBQWEsT0FBTyxrQkFBa0IsbUJBQW1CO0FBQ3pGLFdBQU8sZ0JBQWdCLFNBQVMsYUFBYSxNQUFNLE1BQU0sa0JBQWtCO0FBQzNFLFdBQU8sZ0JBQWdCLFNBQVMsYUFBYSxXQUFXLFFBQVEsdUJBQXVCO0FBQ3ZGLFdBQU8sZ0JBQWdCLFNBQVMsYUFBYSxNQUFNLENBQUMsa0JBQWtCLFVBQVUsR0FBRyxrQkFBa0I7QUFDckcsV0FBTyxnQkFBZ0IsU0FBUyxhQUFhLFVBQVUsQ0FBQyxtQkFBbUIsZ0JBQWdCLEdBQUcsc0JBQXNCO0FBQ3BILFdBQU8sZ0JBQWdCLFNBQVMsYUFBYSxTQUFTLENBQUMsWUFBWSxHQUFHLHFCQUFxQjtBQUMzRixXQUFPLGdCQUFnQixTQUFTLGNBQWMsWUFBWSxHQUFHLENBQUMsZ0JBQWdCLFNBQVMsR0FBRyx3QkFBd0I7QUFDbEgsV0FBTyxnQkFBZ0IsU0FBUyxjQUFjLFdBQVcsR0FBRyxDQUFDLGVBQWUsd0JBQXdCLEdBQUcsdUJBQXVCO0FBQzlILFdBQU8sZ0JBQWdCLFNBQVMsY0FBYyxlQUFlLEdBQUcsQ0FBQyw2QkFBNkIsNEJBQTRCLEdBQUcsMkJBQTJCO0FBQ3hKLFdBQU8sZ0JBQWdCLFNBQVMsY0FBYyxzQkFBc0IsR0FBRyxDQUFDLHVCQUF1QixHQUFHLGtDQUFrQztBQUNwSSxXQUFPLGdCQUFnQixTQUFTLGFBQWEsVUFBVSxNQUFNLHNCQUFzQjtBQUNuRixXQUFPLGdCQUFnQixTQUFTLGFBQWEsV0FBVyxjQUFjLHVCQUF1QjtBQUFBLEVBQy9GLFVBQUU7QUFDQSxZQUFRLElBQUk7QUFBQSxFQUNkO0FBQ0osQ0FBQztBQUlELEtBQUssdUNBQXVDLFlBQVk7QUFDcEQsUUFBTSxPQUFPLGtCQUFrQjtBQUMvQixNQUFJO0FBQ0YsVUFBTSxXQUFXLGtCQUFrQixJQUFJO0FBQ3ZDLGtCQUFjLEtBQUssVUFBVSxZQUFZLEdBQUcsY0FBYztBQUUxRCxVQUFNLFdBQVcsS0FBSyxVQUFVLFVBQVUsbUJBQW1CO0FBQzdELGNBQVUsVUFBVSxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBR3ZDLGtCQUFjLEtBQUssVUFBVSxrQkFBa0IsR0FBRztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxDQVN2RDtBQUNLLGtCQUFjLEtBQUssVUFBVSxrQkFBa0IsR0FBRztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxDQVN2RDtBQUVLLFVBQU0sVUFBVSxNQUFNLHVCQUF1QixRQUFRO0FBQ3JELFVBQU0sUUFBUSxRQUFRLE9BQU8sbUJBQW1CO0FBRWhELFdBQU8sR0FBRyxVQUFVLFFBQVcsc0JBQXNCO0FBQ3JELFdBQU8sZ0JBQWdCLE9BQU8sS0FBSyxPQUFPLFNBQVMsQ0FBQyxDQUFDLEVBQUUsUUFBUSxHQUFHLGtCQUFrQjtBQUNwRixXQUFPLEdBQUcsT0FBTyxLQUFLLE9BQU8sYUFBYSxDQUFDLENBQUMsRUFBRSxVQUFVLEdBQUcsNkJBQTZCO0FBQ3hGLFdBQU8sR0FBRyxTQUFTLE9BQU8sYUFBYSxDQUFDLElBQUksNEJBQTRCO0FBQ3hFLFdBQU8sR0FBRyxTQUFTLE9BQU8sYUFBYSxDQUFDLElBQUksNEJBQTRCO0FBQUEsRUFDMUUsVUFBRTtBQUNBLFlBQVEsSUFBSTtBQUFBLEVBQ2Q7QUFDSixDQUFDO0FBSUQsS0FBSyxpREFBNEMsWUFBWTtBQUN6RCxRQUFNLE9BQU8sa0JBQWtCO0FBQy9CLE1BQUk7QUFDRixVQUFNLFdBQVcsa0JBQWtCLElBQUk7QUFDdkMsa0JBQWMsS0FBSyxVQUFVLFlBQVksR0FBRyxjQUFjO0FBRzFELFVBQU0sV0FBVyxLQUFLLFVBQVUsVUFBVSxnQkFBZ0I7QUFDMUQsY0FBVSxVQUFVLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDdkMsa0JBQWMsS0FBSyxVQUFVLGVBQWUsR0FBRyxlQUFlO0FBRzlELFVBQU0sYUFBYSxLQUFLLFVBQVUsWUFBWSxlQUFlLGFBQWE7QUFDMUUsY0FBVSxZQUFZLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDekMsa0JBQWMsS0FBSyxZQUFZLGVBQWUsR0FBRyxpQkFBaUI7QUFFbEUsVUFBTSxVQUFVLE1BQU0sdUJBQXVCLFFBQVE7QUFFckQsV0FBTyxHQUFHLG9CQUFvQixRQUFRLFFBQVEsK0JBQStCO0FBRTdFLFdBQU8sR0FBRyxDQUFDLE9BQU8sS0FBSyxRQUFRLE1BQU0sRUFBRSxLQUFLLE9BQUssRUFBRSxTQUFTLFVBQVUsQ0FBQyxHQUFHLHFDQUFxQztBQUFBLEVBQ2pILFVBQUU7QUFDQSxZQUFRLElBQUk7QUFBQSxFQUNkO0FBQ0osQ0FBQztBQUlELEtBQUssc0JBQXNCLFlBQVk7QUFDbkMsUUFBTSxPQUFPLGtCQUFrQjtBQUMvQixNQUFJO0FBQ0YsVUFBTSxXQUFXLGtCQUFrQixJQUFJO0FBQ3ZDLGtCQUFjLEtBQUssVUFBVSxZQUFZLEdBQUcsY0FBYztBQUcxRCxVQUFNLE1BQU0sS0FBSyxVQUFVLFNBQVMsZUFBZTtBQUNuRCxjQUFVLEtBQUssRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNsQyxrQkFBYyxLQUFLLEtBQUssYUFBYSxHQUFHLGlCQUFpQjtBQUN6RCxrQkFBYyxLQUFLLEtBQUssZ0JBQWdCLEdBQUcsb0JBQW9CO0FBRy9ELFVBQU0sTUFBTSxLQUFLLFVBQVUsU0FBUyxpQkFBaUI7QUFDckQsY0FBVSxLQUFLLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDbEMsa0JBQWMsS0FBSyxLQUFLLGFBQWEsR0FBRyxnREFBZ0Q7QUFFeEYsVUFBTSxVQUFVLE1BQU0sdUJBQXVCLFFBQVE7QUFFckQsV0FBTyxnQkFBZ0IsUUFBUSxXQUFXLFFBQVEsR0FBRyxzQkFBc0I7QUFDM0UsV0FBTyxnQkFBZ0IsUUFBUSxXQUFXLENBQUMsR0FBRyxRQUFRLEdBQUcsMEJBQTBCO0FBQ25GLFdBQU8sZ0JBQWdCLFFBQVEsV0FBVyxDQUFDLEdBQUcsTUFBTSxhQUFhLHdCQUF3QjtBQUN6RixXQUFPLEdBQUcsUUFBUSxXQUFXLENBQUMsR0FBRyxTQUFTLE1BQU0sNEJBQTRCO0FBQzVFLFdBQU8sR0FBRyxRQUFRLFdBQVcsQ0FBQyxHQUFHLFlBQVksTUFBTSwrQkFBK0I7QUFDbEYsV0FBTyxnQkFBZ0IsUUFBUSxXQUFXLENBQUMsR0FBRyxRQUFRLEdBQUcsMkJBQTJCO0FBQ3BGLFdBQU8sR0FBRyxRQUFRLFdBQVcsQ0FBQyxHQUFHLFNBQVMsTUFBTSw2QkFBNkI7QUFDN0UsV0FBTyxnQkFBZ0IsUUFBUSxXQUFXLENBQUMsR0FBRyxTQUFTLE1BQU0sbUNBQW1DO0FBQUEsRUFDbEcsVUFBRTtBQUNBLFlBQVEsSUFBSTtBQUFBLEVBQ2Q7QUFDSixDQUFDO0FBSUQsS0FBSyx3REFBd0QsWUFBWTtBQUNyRSxRQUFNLE9BQU8sa0JBQWtCO0FBQy9CLE1BQUk7QUFDRixVQUFNLFdBQVcsa0JBQWtCLElBQUk7QUFDdkMsa0JBQWMsS0FBSyxVQUFVLFlBQVksR0FBRyxrQ0FBa0M7QUFFOUUsVUFBTSxVQUFVLE1BQU0sdUJBQXVCLFFBQVE7QUFFckQsV0FBTyxHQUFHLFFBQVEsWUFBWSxNQUFNLDRCQUE0QjtBQUNoRSxXQUFPLElBQUksUUFBUSxTQUFTLFlBQVksVUFBVSxNQUFNLEdBQUcsb0NBQW9DO0FBRy9GLFVBQU0sTUFBTSxRQUFRLFNBQVMsWUFBWSxLQUFLLE9BQUssRUFBRSxHQUFHLFNBQVMsS0FBSyxDQUFDO0FBQ3ZFLFdBQU8sR0FBRyxRQUFRLFFBQVcsa0NBQWtDO0FBQy9ELFdBQU8sZ0JBQWdCLEtBQUssV0FBVyxNQUFNLCtCQUErQjtBQUM1RSxXQUFPLElBQUksS0FBSyxRQUFRLFVBQVUsTUFBTSxHQUFHLDZCQUE2QjtBQUN4RSxXQUFPLEdBQUcsS0FBSyxRQUFRLE1BQU0sT0FBSyxFQUFFLElBQUksS0FBSyxPQUFPLGtDQUFrQztBQUd0RixVQUFNLE1BQU0sUUFBUSxTQUFTLFlBQVksS0FBSyxPQUFLLEVBQUUsR0FBRyxTQUFTLEtBQUssQ0FBQztBQUN2RSxXQUFPLEdBQUcsUUFBUSxRQUFXLGtDQUFrQztBQUMvRCxXQUFPLGdCQUFnQixLQUFLLFdBQVcsT0FBTyxtQ0FBbUM7QUFDakYsV0FBTyxJQUFJLEtBQUssUUFBUSxVQUFVLE1BQU0sR0FBRyw2QkFBNkI7QUFHeEUsVUFBTSxVQUFVLEtBQUssUUFBUSxLQUFLLE9BQUssRUFBRSxXQUFXLEVBQUU7QUFDdEQsV0FBTyxHQUFHLFNBQVMsU0FBUyxNQUFNLDhCQUE4QjtBQUNoRSxVQUFNLFVBQVUsS0FBSyxRQUFRLEtBQUssT0FBSyxFQUFFLFdBQVcsRUFBRTtBQUN0RCxXQUFPLEdBQUcsU0FBUyxTQUFTLE9BQU8sa0NBQWtDO0FBQUEsRUFDdkUsVUFBRTtBQUNBLFlBQVEsSUFBSTtBQUFBLEVBQ2Q7QUFDSixDQUFDO0FBSUQsS0FBSyw0REFBdUQsWUFBWTtBQUNwRSxRQUFNLE9BQU8sa0JBQWtCO0FBQy9CLE1BQUk7QUFDRixVQUFNLFdBQVcsa0JBQWtCLElBQUk7QUFDdkMsa0JBQWMsS0FBSyxVQUFVLFlBQVksR0FBRyxjQUFjO0FBRTFELFVBQU0sV0FBVyxLQUFLLFVBQVUsVUFBVSxzQkFBc0I7QUFDaEUsY0FBVSxVQUFVLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDdkMsa0JBQWMsS0FBSyxVQUFVLGVBQWUsR0FBRyxvQ0FBb0M7QUFDbkYsa0JBQWMsS0FBSyxVQUFVLGFBQWEsR0FBRyxzQ0FBc0M7QUFDbkYsa0JBQWMsS0FBSyxVQUFVLG9CQUFvQixHQUFHLCtCQUErQjtBQUNuRixrQkFBYyxLQUFLLFVBQVUsc0JBQXNCLEdBQUcsc0JBQXNCO0FBRTVFLFVBQU0sVUFBVSxNQUFNLHVCQUF1QixRQUFRO0FBQ3JELFVBQU0sUUFBUSxRQUFRLE9BQU8sc0JBQXNCO0FBRW5ELFdBQU8sR0FBRyxVQUFVLFFBQVcscUJBQXFCO0FBQ3BELFdBQU8sSUFBSSxPQUFPLFlBQVksVUFBVSxNQUFNLEdBQUcscUNBQXFDO0FBQ3RGLFdBQU87QUFBQSxNQUNMLE9BQU8sWUFBWSxLQUFLLE9BQUssRUFBRSxhQUFhLGFBQWEsS0FBSztBQUFBLE1BQzlEO0FBQUEsSUFDRjtBQUNBLFdBQU87QUFBQSxNQUNMLE9BQU8sWUFBWSxLQUFLLE9BQUssRUFBRSxhQUFhLG9CQUFvQixLQUFLO0FBQUEsTUFDckU7QUFBQSxJQUNGO0FBQ0EsV0FBTztBQUFBLE1BQ0wsT0FBTyxZQUFZLEtBQUssT0FBSyxFQUFFLGFBQWEsc0JBQXNCLEtBQUs7QUFBQSxNQUN2RTtBQUFBLElBQ0Y7QUFBQSxFQUNGLFVBQUU7QUFDQSxZQUFRLElBQUk7QUFBQSxFQUNkO0FBQ0osQ0FBQztBQUlELEtBQUssNkRBQXdELFlBQVk7QUFDckUsUUFBTSxPQUFPLGtCQUFrQjtBQUMvQixNQUFJO0FBQ0YsVUFBTSxXQUFXLGtCQUFrQixJQUFJO0FBRXZDLGtCQUFjLEtBQUssVUFBVSxZQUFZLEdBQUcsY0FBYztBQUUxRCxVQUFNLFNBQVMsTUFBTSwwQkFBMEIsUUFBUTtBQUV2RCxXQUFPLGdCQUFnQixPQUFPLE9BQU8sTUFBTSxxQ0FBcUM7QUFDaEYsV0FBTztBQUFBLE1BQ0wsT0FBTyxPQUFPLEtBQUssT0FBSyxFQUFFLGFBQWEsYUFBYSxFQUFFLEtBQUssU0FBUyxTQUFTLENBQUM7QUFBQSxNQUM5RTtBQUFBLElBQ0Y7QUFBQSxFQUNGLFVBQUU7QUFDQSxZQUFRLElBQUk7QUFBQSxFQUNkO0FBQ0osQ0FBQztBQUlELEtBQUssaURBQTRDLFlBQVk7QUFDekQsUUFBTSxPQUFPLGtCQUFrQjtBQUMvQixNQUFJO0FBQ0YsVUFBTSxXQUFXLGtCQUFrQixJQUFJO0FBQ3ZDLGtCQUFjLEtBQUssVUFBVSxZQUFZLEdBQUcsY0FBYztBQUcxRCxVQUFNLFNBQVMsTUFBTSwwQkFBMEIsUUFBUTtBQUV2RCxXQUFPLGdCQUFnQixPQUFPLE9BQU8sTUFBTSw4Q0FBOEM7QUFDekYsV0FBTztBQUFBLE1BQ0wsT0FBTyxPQUFPLEtBQUssT0FBSyxFQUFFLGFBQWEsYUFBYSxFQUFFLEtBQUssU0FBUyxTQUFTLENBQUM7QUFBQSxNQUM5RTtBQUFBLElBQ0Y7QUFBQSxFQUNGLFVBQUU7QUFDQSxZQUFRLElBQUk7QUFBQSxFQUNkO0FBQ0osQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
