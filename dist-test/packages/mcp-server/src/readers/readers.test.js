import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { readProgress } from "./state.js";
import { readRoadmap } from "./roadmap.js";
import { readHistory } from "./metrics.js";
import { readCaptures } from "./captures.js";
import { readKnowledge } from "./knowledge.js";
import { runDoctorLite } from "./doctor-lite.js";
function tmpProject() {
  const dir = join(tmpdir(), `gsd-mcp-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function writeFixture(base, relPath, content) {
  const full = join(base, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf-8");
}
describe("readProgress", () => {
  let projectDir;
  before(() => {
    projectDir = tmpProject();
    writeFixture(projectDir, ".gsd/STATE.md", `# GSD State

**Active Milestone:** M002: Auth System
**Active Slice:** S01: Login flow
**Phase:** execution
**Requirements Status:** 5 active \xB7 2 validated \xB7 1 deferred \xB7 0 out of scope

## Milestone Registry

- \u2611 **M001:** Core Setup
- \u{1F504} **M002:** Auth System
- \u2B1C **M003:** Dashboard

## Blockers

- Waiting on OAuth provider approval

## Next Action

Execute T02 in S01 \u2014 implement token refresh.
`);
    const m1 = ".gsd/milestones/M001/slices/S01/tasks";
    writeFixture(projectDir, `${m1}/T01-PLAN.md`, "# T01");
    writeFixture(projectDir, `${m1}/T01-SUMMARY.md`, "# T01 done");
    const m2 = ".gsd/milestones/M002/slices/S01/tasks";
    writeFixture(projectDir, `${m2}/T01-PLAN.md`, "# T01");
    writeFixture(projectDir, `${m2}/T01-SUMMARY.md`, "# T01 done");
    writeFixture(projectDir, `${m2}/T02-PLAN.md`, "# T02");
    mkdirSync(join(projectDir, ".gsd/milestones/M003"), { recursive: true });
  });
  after(() => rmSync(projectDir, { recursive: true, force: true }));
  it("parses active milestone from STATE.md", () => {
    const result = readProgress(projectDir);
    assert.deepEqual(result.activeMilestone, { id: "M002", title: "Auth System" });
  });
  it("parses active slice", () => {
    const result = readProgress(projectDir);
    assert.deepEqual(result.activeSlice, { id: "S01", title: "Login flow" });
  });
  it("parses phase", () => {
    const result = readProgress(projectDir);
    assert.equal(result.phase, "execute");
  });
  it("parses milestone counts from registry", () => {
    const result = readProgress(projectDir);
    assert.equal(result.milestones.total, 3);
    assert.equal(result.milestones.done, 1);
    assert.equal(result.milestones.active, 1);
    assert.equal(result.milestones.pending, 1);
  });
  it("counts tasks from filesystem", () => {
    const result = readProgress(projectDir);
    assert.equal(result.tasks.total, 3);
    assert.equal(result.tasks.done, 2);
    assert.equal(result.tasks.pending, 1);
  });
  it("parses blockers", () => {
    const result = readProgress(projectDir);
    assert.equal(result.blockers.length, 1);
    assert.ok(result.blockers[0].includes("OAuth"));
  });
  it("parses requirements", () => {
    const result = readProgress(projectDir);
    assert.equal(result.requirements?.active, 5);
    assert.equal(result.requirements?.validated, 2);
    assert.equal(result.requirements?.deferred, 1);
  });
  it("parses next action", () => {
    const result = readProgress(projectDir);
    assert.ok(result.nextAction.includes("T02"));
  });
  it("returns defaults for missing .gsd/", () => {
    const empty = tmpProject();
    const result = readProgress(empty);
    assert.equal(result.phase, "unknown");
    assert.equal(result.milestones.total, 0);
    rmSync(empty, { recursive: true, force: true });
  });
});
describe("readRoadmap", () => {
  let projectDir;
  before(() => {
    projectDir = tmpProject();
    writeFixture(projectDir, ".gsd/milestones/M001/M001-CONTEXT.md", "# M001: Core Setup\n");
    writeFixture(projectDir, ".gsd/milestones/M001/M001-ROADMAP.md", `# M001: Core Setup

## Vision

Build the foundation for the project.

## Slice Overview

| ID | Slice | Risk | Depends | Done | After this |
|----|-------|------|---------|------|------------|
| S01 | Database schema | low | \u2014 | \u2611 | DB ready |
| S02 | API endpoints | medium | S01 | \u{1F7EB} | REST API live |
`);
    writeFixture(projectDir, ".gsd/milestones/M001/slices/S01/S01-PLAN.md", `# S01: Database schema

## Tasks

- [x] **T01: Create migrations** \u2014 Set up schema
- [x] **T02: Seed data** \u2014 Initial seed
`);
    writeFixture(projectDir, ".gsd/milestones/M001/slices/S01/tasks/T01-PLAN.md", "# T01");
    writeFixture(projectDir, ".gsd/milestones/M001/slices/S01/tasks/T01-SUMMARY.md", "# T01 done");
    writeFixture(projectDir, ".gsd/milestones/M001/slices/S01/tasks/T02-PLAN.md", "# T02");
    writeFixture(projectDir, ".gsd/milestones/M001/slices/S01/tasks/T02-SUMMARY.md", "# T02 done");
    writeFixture(projectDir, ".gsd/milestones/M001/slices/S02/S02-PLAN.md", `# S02: API endpoints

## Tasks

- [ ] **T01: Auth routes** \u2014 Implement auth
- [ ] **T02: User routes** \u2014 CRUD users
`);
    writeFixture(projectDir, ".gsd/milestones/M001/slices/S02/tasks/T01-PLAN.md", "# T01");
    writeFixture(projectDir, ".gsd/milestones/M001/slices/S02/tasks/T02-PLAN.md", "# T02");
  });
  after(() => rmSync(projectDir, { recursive: true, force: true }));
  it("returns milestone structure", () => {
    const result = readRoadmap(projectDir);
    assert.equal(result.milestones.length, 1);
    assert.equal(result.milestones[0].id, "M001");
    assert.equal(result.milestones[0].title, "Core Setup");
  });
  it("reads vision from roadmap", () => {
    const result = readRoadmap(projectDir);
    assert.ok(result.milestones[0].vision.includes("foundation"));
  });
  it("parses slices from roadmap table", () => {
    const result = readRoadmap(projectDir);
    const slices = result.milestones[0].slices;
    assert.equal(slices.length, 2);
    assert.equal(slices[0].id, "S01");
    assert.equal(slices[0].title, "Database schema");
    assert.equal(slices[1].id, "S02");
  });
  it("derives slice status from task summaries", () => {
    const result = readRoadmap(projectDir);
    const slices = result.milestones[0].slices;
    assert.equal(slices[0].status, "done");
    assert.equal(slices[1].status, "pending");
  });
  it("includes tasks in slices", () => {
    const result = readRoadmap(projectDir);
    const s01Tasks = result.milestones[0].slices[0].tasks;
    assert.equal(s01Tasks.length, 2);
    assert.equal(s01Tasks[0].status, "done");
  });
  it("filters by milestoneId", () => {
    const result = readRoadmap(projectDir, "M999");
    assert.equal(result.milestones.length, 0);
  });
});
describe("readHistory", () => {
  let projectDir;
  before(() => {
    projectDir = tmpProject();
    writeFixture(projectDir, ".gsd/metrics.json", JSON.stringify({
      version: 1,
      projectStartedAt: 17e11,
      units: [
        {
          type: "execute-task",
          id: "M001/S01/T01",
          model: "claude-sonnet-4",
          startedAt: 1700001e6,
          finishedAt: 1700002e6,
          tokens: { input: 1e4, output: 3e3, cacheRead: 2e3, cacheWrite: 1e3, total: 16e3 },
          cost: 0.05,
          toolCalls: 8,
          apiRequests: 3
        },
        {
          type: "execute-task",
          id: "M001/S01/T02",
          model: "claude-sonnet-4",
          startedAt: 1700003e6,
          finishedAt: 1700004e6,
          tokens: { input: 15e3, output: 5e3, cacheRead: 3e3, cacheWrite: 1500, total: 24500 },
          cost: 0.08,
          toolCalls: 12,
          apiRequests: 5
        }
      ]
    }));
  });
  after(() => rmSync(projectDir, { recursive: true, force: true }));
  it("returns all entries sorted by most recent", () => {
    const result = readHistory(projectDir);
    assert.equal(result.entries.length, 2);
    assert.equal(result.entries[0].id, "M001/S01/T02");
  });
  it("computes totals", () => {
    const result = readHistory(projectDir);
    assert.equal(result.totals.units, 2);
    assert.equal(result.totals.cost, 0.13);
    assert.equal(result.totals.tokens.total, 40500);
  });
  it("respects limit", () => {
    const result = readHistory(projectDir, 1);
    assert.equal(result.entries.length, 1);
    assert.equal(result.totals.units, 2);
  });
  it("returns empty for missing metrics", () => {
    const empty = tmpProject();
    mkdirSync(join(empty, ".gsd"), { recursive: true });
    const result = readHistory(empty);
    assert.equal(result.entries.length, 0);
    assert.equal(result.totals.units, 0);
    rmSync(empty, { recursive: true, force: true });
  });
});
describe("readCaptures", () => {
  let projectDir;
  before(() => {
    projectDir = tmpProject();
    writeFixture(projectDir, ".gsd/CAPTURES.md", `# Captures

### CAP-aaa11111

**Text:** Add rate limiting to API
**Captured:** 2026-04-01T10:00:00Z
**Status:** pending

### CAP-bbb22222

**Text:** Refactor auth module
**Captured:** 2026-04-02T10:00:00Z
**Status:** resolved
**Classification:** inject
**Resolution:** Added to M003 roadmap
**Rationale:** Important for security
**Resolved:** 2026-04-03T10:00:00Z
**Milestone:** M003

### CAP-ccc33333

**Text:** Nice to have: dark mode
**Captured:** 2026-04-02T11:00:00Z
**Status:** resolved
**Classification:** defer
**Resolution:** Deferred to future
**Rationale:** Not blocking
**Resolved:** 2026-04-03T11:00:00Z
`);
  });
  after(() => rmSync(projectDir, { recursive: true, force: true }));
  it("reads all captures", () => {
    const result = readCaptures(projectDir, "all");
    assert.equal(result.captures.length, 3);
    assert.equal(result.counts.total, 3);
  });
  it("filters pending captures", () => {
    const result = readCaptures(projectDir, "pending");
    assert.equal(result.captures.length, 1);
    assert.equal(result.captures[0].id, "CAP-aaa11111");
  });
  it("filters actionable captures (inject, replan, quick-task)", () => {
    const result = readCaptures(projectDir, "actionable");
    assert.equal(result.captures.length, 1);
    assert.equal(result.captures[0].id, "CAP-bbb22222");
  });
  it("counts correctly regardless of filter", () => {
    const result = readCaptures(projectDir, "pending");
    assert.equal(result.counts.total, 3);
    assert.equal(result.counts.pending, 1);
    assert.equal(result.counts.actionable, 1);
  });
  it("returns empty for missing CAPTURES.md", () => {
    const empty = tmpProject();
    mkdirSync(join(empty, ".gsd"), { recursive: true });
    const result = readCaptures(empty);
    assert.equal(result.captures.length, 0);
    rmSync(empty, { recursive: true, force: true });
  });
});
describe("readKnowledge", () => {
  let projectDir;
  before(() => {
    projectDir = tmpProject();
    writeFixture(projectDir, ".gsd/KNOWLEDGE.md", `# Project Knowledge

## Rules

| # | Scope | Rule | Why | Added |
|---|-------|------|-----|-------|
| K001 | auth | Hash passwords with bcrypt | Security requirement | manual |
| K002 | db | Use transactions for multi-table | Data consistency | auto |

## Patterns

| # | Pattern | Where | Notes |
|---|---------|-------|-------|
| P001 | Singleton services | services/ | Prevents duplication |

## Lessons Learned

| # | What Happened | Root Cause | Fix | Scope |
|---|--------------|------------|-----|-------|
| L001 | CI tests failed | Env diff | Added setup script | testing |
`);
  });
  after(() => rmSync(projectDir, { recursive: true, force: true }));
  it("reads all knowledge entries", () => {
    const result = readKnowledge(projectDir);
    assert.equal(result.entries.length, 4);
  });
  it("counts by type", () => {
    const result = readKnowledge(projectDir);
    assert.equal(result.counts.rules, 2);
    assert.equal(result.counts.patterns, 1);
    assert.equal(result.counts.lessons, 1);
  });
  it("parses rule fields correctly", () => {
    const result = readKnowledge(projectDir);
    const k001 = result.entries.find((e) => e.id === "K001");
    assert.ok(k001);
    assert.equal(k001.type, "rule");
    assert.equal(k001.scope, "auth");
    assert.ok(k001.content.includes("bcrypt"));
  });
  it("returns empty for missing KNOWLEDGE.md", () => {
    const empty = tmpProject();
    mkdirSync(join(empty, ".gsd"), { recursive: true });
    const result = readKnowledge(empty);
    assert.equal(result.entries.length, 0);
    rmSync(empty, { recursive: true, force: true });
  });
});
describe("runDoctorLite", () => {
  let projectDir;
  before(() => {
    projectDir = tmpProject();
    writeFixture(projectDir, ".gsd/PROJECT.md", "# Test Project");
    writeFixture(projectDir, ".gsd/STATE.md", "# GSD State");
    writeFixture(projectDir, ".gsd/milestones/M001/M001-CONTEXT.md", "# M001");
    writeFixture(projectDir, ".gsd/milestones/M001/M001-ROADMAP.md", "# Roadmap");
    writeFixture(projectDir, ".gsd/milestones/M001/M001-SUMMARY.md", "# Done");
    writeFixture(projectDir, ".gsd/milestones/M001/slices/S01/S01-PLAN.md", "# Plan");
    writeFixture(projectDir, ".gsd/milestones/M001/slices/S01/tasks/T01-PLAN.md", "# T01");
    writeFixture(projectDir, ".gsd/milestones/M001/slices/S01/tasks/T01-SUMMARY.md", "# T01 done");
    writeFixture(projectDir, ".gsd/milestones/M002/M002-CONTEXT.md", "# M002");
    writeFixture(projectDir, ".gsd/milestones/M002/M002-ROADMAP.md", "# Roadmap");
    writeFixture(projectDir, ".gsd/milestones/M002/slices/S01/S01-PLAN.md", "# Plan");
    writeFixture(projectDir, ".gsd/milestones/M002/slices/S01/tasks/T01-PLAN.md", "# T01");
    writeFixture(projectDir, ".gsd/milestones/M002/slices/S01/tasks/T01-SUMMARY.md", "# T01 done");
    mkdirSync(join(projectDir, ".gsd/milestones/M003"), { recursive: true });
  });
  after(() => rmSync(projectDir, { recursive: true, force: true }));
  it("detects all-slices-done-missing-summary", () => {
    const result = runDoctorLite(projectDir);
    const issue = result.issues.find((i) => i.code === "all_slices_done_missing_summary");
    assert.ok(issue, "Should detect M002 missing summary");
    assert.equal(issue.unitId, "M002");
  });
  it("detects missing context", () => {
    const result = runDoctorLite(projectDir);
    const issue = result.issues.find(
      (i) => i.code === "missing_context" && i.unitId === "M003"
    );
    assert.ok(issue, "Should detect M003 missing context");
  });
  it("scopes to a single milestone", () => {
    const result = runDoctorLite(projectDir, "M001");
    const m002Issues = result.issues.filter((i) => i.unitId.startsWith("M002"));
    assert.equal(m002Issues.length, 0, "Should not include M002 when scoped to M001");
  });
  it("returns ok:true for healthy project", () => {
    const healthy = tmpProject();
    writeFixture(healthy, ".gsd/PROJECT.md", "# Project");
    writeFixture(healthy, ".gsd/STATE.md", "# State");
    const result = runDoctorLite(healthy);
    assert.equal(result.ok, true);
    rmSync(healthy, { recursive: true, force: true });
  });
  it("handles missing .gsd/ gracefully", () => {
    const empty = tmpProject();
    const result = runDoctorLite(empty);
    assert.equal(result.ok, true);
    assert.ok(
      result.issues.some(
        (issue) => issue.code === "no_gsd_directory" || issue.code === "missing_project_md"
      )
    );
    rmSync(empty, { recursive: true, force: true });
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvbWNwLXNlcnZlci9zcmMvcmVhZGVycy9yZWFkZXJzLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRCBNQ1AgU2VydmVyIFx1MjAxNCByZWFkZXIgdGVzdHNcbi8vIENvcHlyaWdodCAoYykgMjAyNiBKZXJlbXkgTWNTcGFkZGVuIDxqZXJlbXlAZmx1eGxhYnMubmV0PlxuXG5pbXBvcnQgeyBkZXNjcmliZSwgaXQsIGJlZm9yZSwgYWZ0ZXIgfSBmcm9tICdub2RlOnRlc3QnO1xuaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydC9zdHJpY3QnO1xuaW1wb3J0IHsgbWtkaXJTeW5jLCB3cml0ZUZpbGVTeW5jLCBybVN5bmMgfSBmcm9tICdub2RlOmZzJztcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdub2RlOnBhdGgnO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSAnbm9kZTpvcyc7XG5pbXBvcnQgeyByYW5kb21CeXRlcyB9IGZyb20gJ25vZGU6Y3J5cHRvJztcblxuaW1wb3J0IHsgcmVhZFByb2dyZXNzIH0gZnJvbSAnLi9zdGF0ZS5qcyc7XG5pbXBvcnQgeyByZWFkUm9hZG1hcCB9IGZyb20gJy4vcm9hZG1hcC5qcyc7XG5pbXBvcnQgeyByZWFkSGlzdG9yeSB9IGZyb20gJy4vbWV0cmljcy5qcyc7XG5pbXBvcnQgeyByZWFkQ2FwdHVyZXMgfSBmcm9tICcuL2NhcHR1cmVzLmpzJztcbmltcG9ydCB7IHJlYWRLbm93bGVkZ2UgfSBmcm9tICcuL2tub3dsZWRnZS5qcyc7XG5pbXBvcnQgeyBydW5Eb2N0b3JMaXRlIH0gZnJvbSAnLi9kb2N0b3ItbGl0ZS5qcyc7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gVGVzdCBmaXh0dXJlIGhlbHBlcnNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5mdW5jdGlvbiB0bXBQcm9qZWN0KCk6IHN0cmluZyB7XG4gIGNvbnN0IGRpciA9IGpvaW4odG1wZGlyKCksIGBnc2QtbWNwLXRlc3QtJHtyYW5kb21CeXRlcyg0KS50b1N0cmluZygnaGV4Jyl9YCk7XG4gIG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICByZXR1cm4gZGlyO1xufVxuXG5mdW5jdGlvbiB3cml0ZUZpeHR1cmUoYmFzZTogc3RyaW5nLCByZWxQYXRoOiBzdHJpbmcsIGNvbnRlbnQ6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBmdWxsID0gam9pbihiYXNlLCByZWxQYXRoKTtcbiAgbWtkaXJTeW5jKGpvaW4oZnVsbCwgJy4uJyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGZ1bGwsIGNvbnRlbnQsICd1dGYtOCcpO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIHJlYWRQcm9ncmVzcyB0ZXN0c1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmRlc2NyaWJlKCdyZWFkUHJvZ3Jlc3MnLCAoKSA9PiB7XG4gIGxldCBwcm9qZWN0RGlyOiBzdHJpbmc7XG5cbiAgYmVmb3JlKCgpID0+IHtcbiAgICBwcm9qZWN0RGlyID0gdG1wUHJvamVjdCgpO1xuXG4gICAgd3JpdGVGaXh0dXJlKHByb2plY3REaXIsICcuZ3NkL1NUQVRFLm1kJywgYCMgR1NEIFN0YXRlXG5cbioqQWN0aXZlIE1pbGVzdG9uZToqKiBNMDAyOiBBdXRoIFN5c3RlbVxuKipBY3RpdmUgU2xpY2U6KiogUzAxOiBMb2dpbiBmbG93XG4qKlBoYXNlOioqIGV4ZWN1dGlvblxuKipSZXF1aXJlbWVudHMgU3RhdHVzOioqIDUgYWN0aXZlIFx1MDBCNyAyIHZhbGlkYXRlZCBcdTAwQjcgMSBkZWZlcnJlZCBcdTAwQjcgMCBvdXQgb2Ygc2NvcGVcblxuIyMgTWlsZXN0b25lIFJlZ2lzdHJ5XG5cbi0gXHUyNjExICoqTTAwMToqKiBDb3JlIFNldHVwXG4tIFx1RDgzRFx1REQwNCAqKk0wMDI6KiogQXV0aCBTeXN0ZW1cbi0gXHUyQjFDICoqTTAwMzoqKiBEYXNoYm9hcmRcblxuIyMgQmxvY2tlcnNcblxuLSBXYWl0aW5nIG9uIE9BdXRoIHByb3ZpZGVyIGFwcHJvdmFsXG5cbiMjIE5leHQgQWN0aW9uXG5cbkV4ZWN1dGUgVDAyIGluIFMwMSBcdTIwMTQgaW1wbGVtZW50IHRva2VuIHJlZnJlc2guXG5gKTtcblxuICAgIC8vIENyZWF0ZSBmaWxlc3lzdGVtIHN0cnVjdHVyZVxuICAgIGNvbnN0IG0xID0gJy5nc2QvbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvdGFza3MnO1xuICAgIHdyaXRlRml4dHVyZShwcm9qZWN0RGlyLCBgJHttMX0vVDAxLVBMQU4ubWRgLCAnIyBUMDEnKTtcbiAgICB3cml0ZUZpeHR1cmUocHJvamVjdERpciwgYCR7bTF9L1QwMS1TVU1NQVJZLm1kYCwgJyMgVDAxIGRvbmUnKTtcblxuICAgIGNvbnN0IG0yID0gJy5nc2QvbWlsZXN0b25lcy9NMDAyL3NsaWNlcy9TMDEvdGFza3MnO1xuICAgIHdyaXRlRml4dHVyZShwcm9qZWN0RGlyLCBgJHttMn0vVDAxLVBMQU4ubWRgLCAnIyBUMDEnKTtcbiAgICB3cml0ZUZpeHR1cmUocHJvamVjdERpciwgYCR7bTJ9L1QwMS1TVU1NQVJZLm1kYCwgJyMgVDAxIGRvbmUnKTtcbiAgICB3cml0ZUZpeHR1cmUocHJvamVjdERpciwgYCR7bTJ9L1QwMi1QTEFOLm1kYCwgJyMgVDAyJyk7XG5cbiAgICBta2RpclN5bmMoam9pbihwcm9qZWN0RGlyLCAnLmdzZC9taWxlc3RvbmVzL00wMDMnKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIH0pO1xuXG4gIGFmdGVyKCgpID0+IHJtU3luYyhwcm9qZWN0RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpO1xuXG4gIGl0KCdwYXJzZXMgYWN0aXZlIG1pbGVzdG9uZSBmcm9tIFNUQVRFLm1kJywgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IHJlYWRQcm9ncmVzcyhwcm9qZWN0RGlyKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdC5hY3RpdmVNaWxlc3RvbmUsIHsgaWQ6ICdNMDAyJywgdGl0bGU6ICdBdXRoIFN5c3RlbScgfSk7XG4gIH0pO1xuXG4gIGl0KCdwYXJzZXMgYWN0aXZlIHNsaWNlJywgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IHJlYWRQcm9ncmVzcyhwcm9qZWN0RGlyKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdC5hY3RpdmVTbGljZSwgeyBpZDogJ1MwMScsIHRpdGxlOiAnTG9naW4gZmxvdycgfSk7XG4gIH0pO1xuXG4gIGl0KCdwYXJzZXMgcGhhc2UnLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gcmVhZFByb2dyZXNzKHByb2plY3REaXIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQucGhhc2UsICdleGVjdXRlJyk7XG4gIH0pO1xuXG4gIGl0KCdwYXJzZXMgbWlsZXN0b25lIGNvdW50cyBmcm9tIHJlZ2lzdHJ5JywgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IHJlYWRQcm9ncmVzcyhwcm9qZWN0RGlyKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm1pbGVzdG9uZXMudG90YWwsIDMpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQubWlsZXN0b25lcy5kb25lLCAxKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm1pbGVzdG9uZXMuYWN0aXZlLCAxKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm1pbGVzdG9uZXMucGVuZGluZywgMSk7XG4gIH0pO1xuXG4gIGl0KCdjb3VudHMgdGFza3MgZnJvbSBmaWxlc3lzdGVtJywgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IHJlYWRQcm9ncmVzcyhwcm9qZWN0RGlyKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnRhc2tzLnRvdGFsLCAzKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnRhc2tzLmRvbmUsIDIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQudGFza3MucGVuZGluZywgMSk7XG4gIH0pO1xuXG4gIGl0KCdwYXJzZXMgYmxvY2tlcnMnLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gcmVhZFByb2dyZXNzKHByb2plY3REaXIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuYmxvY2tlcnMubGVuZ3RoLCAxKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmJsb2NrZXJzWzBdLmluY2x1ZGVzKCdPQXV0aCcpKTtcbiAgfSk7XG5cbiAgaXQoJ3BhcnNlcyByZXF1aXJlbWVudHMnLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gcmVhZFByb2dyZXNzKHByb2plY3REaXIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQucmVxdWlyZW1lbnRzPy5hY3RpdmUsIDUpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQucmVxdWlyZW1lbnRzPy52YWxpZGF0ZWQsIDIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQucmVxdWlyZW1lbnRzPy5kZWZlcnJlZCwgMSk7XG4gIH0pO1xuXG4gIGl0KCdwYXJzZXMgbmV4dCBhY3Rpb24nLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gcmVhZFByb2dyZXNzKHByb2plY3REaXIpO1xuICAgIGFzc2VydC5vayhyZXN1bHQubmV4dEFjdGlvbi5pbmNsdWRlcygnVDAyJykpO1xuICB9KTtcblxuICBpdCgncmV0dXJucyBkZWZhdWx0cyBmb3IgbWlzc2luZyAuZ3NkLycsICgpID0+IHtcbiAgICBjb25zdCBlbXB0eSA9IHRtcFByb2plY3QoKTtcbiAgICBjb25zdCByZXN1bHQgPSByZWFkUHJvZ3Jlc3MoZW1wdHkpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQucGhhc2UsICd1bmtub3duJyk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5taWxlc3RvbmVzLnRvdGFsLCAwKTtcbiAgICBybVN5bmMoZW1wdHksIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfSk7XG59KTtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyByZWFkUm9hZG1hcCB0ZXN0c1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmRlc2NyaWJlKCdyZWFkUm9hZG1hcCcsICgpID0+IHtcbiAgbGV0IHByb2plY3REaXI6IHN0cmluZztcblxuICBiZWZvcmUoKCkgPT4ge1xuICAgIHByb2plY3REaXIgPSB0bXBQcm9qZWN0KCk7XG5cbiAgICB3cml0ZUZpeHR1cmUocHJvamVjdERpciwgJy5nc2QvbWlsZXN0b25lcy9NMDAxL00wMDEtQ09OVEVYVC5tZCcsICcjIE0wMDE6IENvcmUgU2V0dXBcXG4nKTtcbiAgICB3cml0ZUZpeHR1cmUocHJvamVjdERpciwgJy5nc2QvbWlsZXN0b25lcy9NMDAxL00wMDEtUk9BRE1BUC5tZCcsIGAjIE0wMDE6IENvcmUgU2V0dXBcblxuIyMgVmlzaW9uXG5cbkJ1aWxkIHRoZSBmb3VuZGF0aW9uIGZvciB0aGUgcHJvamVjdC5cblxuIyMgU2xpY2UgT3ZlcnZpZXdcblxufCBJRCB8IFNsaWNlIHwgUmlzayB8IERlcGVuZHMgfCBEb25lIHwgQWZ0ZXIgdGhpcyB8XG58LS0tLXwtLS0tLS0tfC0tLS0tLXwtLS0tLS0tLS18LS0tLS0tfC0tLS0tLS0tLS0tLXxcbnwgUzAxIHwgRGF0YWJhc2Ugc2NoZW1hIHwgbG93IHwgXHUyMDE0IHwgXHUyNjExIHwgREIgcmVhZHkgfFxufCBTMDIgfCBBUEkgZW5kcG9pbnRzIHwgbWVkaXVtIHwgUzAxIHwgXHVEODNEXHVERkVCIHwgUkVTVCBBUEkgbGl2ZSB8XG5gKTtcblxuICAgIHdyaXRlRml4dHVyZShwcm9qZWN0RGlyLCAnLmdzZC9taWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMS9TMDEtUExBTi5tZCcsIGAjIFMwMTogRGF0YWJhc2Ugc2NoZW1hXG5cbiMjIFRhc2tzXG5cbi0gW3hdICoqVDAxOiBDcmVhdGUgbWlncmF0aW9ucyoqIFx1MjAxNCBTZXQgdXAgc2NoZW1hXG4tIFt4XSAqKlQwMjogU2VlZCBkYXRhKiogXHUyMDE0IEluaXRpYWwgc2VlZFxuYCk7XG4gICAgd3JpdGVGaXh0dXJlKHByb2plY3REaXIsICcuZ3NkL21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzAxL3Rhc2tzL1QwMS1QTEFOLm1kJywgJyMgVDAxJyk7XG4gICAgd3JpdGVGaXh0dXJlKHByb2plY3REaXIsICcuZ3NkL21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzAxL3Rhc2tzL1QwMS1TVU1NQVJZLm1kJywgJyMgVDAxIGRvbmUnKTtcbiAgICB3cml0ZUZpeHR1cmUocHJvamVjdERpciwgJy5nc2QvbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvdGFza3MvVDAyLVBMQU4ubWQnLCAnIyBUMDInKTtcbiAgICB3cml0ZUZpeHR1cmUocHJvamVjdERpciwgJy5nc2QvbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvdGFza3MvVDAyLVNVTU1BUlkubWQnLCAnIyBUMDIgZG9uZScpO1xuXG4gICAgd3JpdGVGaXh0dXJlKHByb2plY3REaXIsICcuZ3NkL21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzAyL1MwMi1QTEFOLm1kJywgYCMgUzAyOiBBUEkgZW5kcG9pbnRzXG5cbiMjIFRhc2tzXG5cbi0gWyBdICoqVDAxOiBBdXRoIHJvdXRlcyoqIFx1MjAxNCBJbXBsZW1lbnQgYXV0aFxuLSBbIF0gKipUMDI6IFVzZXIgcm91dGVzKiogXHUyMDE0IENSVUQgdXNlcnNcbmApO1xuICAgIHdyaXRlRml4dHVyZShwcm9qZWN0RGlyLCAnLmdzZC9taWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMi90YXNrcy9UMDEtUExBTi5tZCcsICcjIFQwMScpO1xuICAgIHdyaXRlRml4dHVyZShwcm9qZWN0RGlyLCAnLmdzZC9taWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMi90YXNrcy9UMDItUExBTi5tZCcsICcjIFQwMicpO1xuICB9KTtcblxuICBhZnRlcigoKSA9PiBybVN5bmMocHJvamVjdERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcblxuICBpdCgncmV0dXJucyBtaWxlc3RvbmUgc3RydWN0dXJlJywgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IHJlYWRSb2FkbWFwKHByb2plY3REaXIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQubWlsZXN0b25lcy5sZW5ndGgsIDEpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQubWlsZXN0b25lc1swXS5pZCwgJ00wMDEnKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm1pbGVzdG9uZXNbMF0udGl0bGUsICdDb3JlIFNldHVwJyk7XG4gIH0pO1xuXG4gIGl0KCdyZWFkcyB2aXNpb24gZnJvbSByb2FkbWFwJywgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IHJlYWRSb2FkbWFwKHByb2plY3REaXIpO1xuICAgIGFzc2VydC5vayhyZXN1bHQubWlsZXN0b25lc1swXS52aXNpb24uaW5jbHVkZXMoJ2ZvdW5kYXRpb24nKSk7XG4gIH0pO1xuXG4gIGl0KCdwYXJzZXMgc2xpY2VzIGZyb20gcm9hZG1hcCB0YWJsZScsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSByZWFkUm9hZG1hcChwcm9qZWN0RGlyKTtcbiAgICBjb25zdCBzbGljZXMgPSByZXN1bHQubWlsZXN0b25lc1swXS5zbGljZXM7XG4gICAgYXNzZXJ0LmVxdWFsKHNsaWNlcy5sZW5ndGgsIDIpO1xuICAgIGFzc2VydC5lcXVhbChzbGljZXNbMF0uaWQsICdTMDEnKTtcbiAgICBhc3NlcnQuZXF1YWwoc2xpY2VzWzBdLnRpdGxlLCAnRGF0YWJhc2Ugc2NoZW1hJyk7XG4gICAgYXNzZXJ0LmVxdWFsKHNsaWNlc1sxXS5pZCwgJ1MwMicpO1xuICB9KTtcblxuICBpdCgnZGVyaXZlcyBzbGljZSBzdGF0dXMgZnJvbSB0YXNrIHN1bW1hcmllcycsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSByZWFkUm9hZG1hcChwcm9qZWN0RGlyKTtcbiAgICBjb25zdCBzbGljZXMgPSByZXN1bHQubWlsZXN0b25lc1swXS5zbGljZXM7XG4gICAgYXNzZXJ0LmVxdWFsKHNsaWNlc1swXS5zdGF0dXMsICdkb25lJyk7XG4gICAgYXNzZXJ0LmVxdWFsKHNsaWNlc1sxXS5zdGF0dXMsICdwZW5kaW5nJyk7XG4gIH0pO1xuXG4gIGl0KCdpbmNsdWRlcyB0YXNrcyBpbiBzbGljZXMnLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gcmVhZFJvYWRtYXAocHJvamVjdERpcik7XG4gICAgY29uc3QgczAxVGFza3MgPSByZXN1bHQubWlsZXN0b25lc1swXS5zbGljZXNbMF0udGFza3M7XG4gICAgYXNzZXJ0LmVxdWFsKHMwMVRhc2tzLmxlbmd0aCwgMik7XG4gICAgYXNzZXJ0LmVxdWFsKHMwMVRhc2tzWzBdLnN0YXR1cywgJ2RvbmUnKTtcbiAgfSk7XG5cbiAgaXQoJ2ZpbHRlcnMgYnkgbWlsZXN0b25lSWQnLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gcmVhZFJvYWRtYXAocHJvamVjdERpciwgJ005OTknKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm1pbGVzdG9uZXMubGVuZ3RoLCAwKTtcbiAgfSk7XG59KTtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyByZWFkSGlzdG9yeSB0ZXN0c1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmRlc2NyaWJlKCdyZWFkSGlzdG9yeScsICgpID0+IHtcbiAgbGV0IHByb2plY3REaXI6IHN0cmluZztcblxuICBiZWZvcmUoKCkgPT4ge1xuICAgIHByb2plY3REaXIgPSB0bXBQcm9qZWN0KCk7XG4gICAgd3JpdGVGaXh0dXJlKHByb2plY3REaXIsICcuZ3NkL21ldHJpY3MuanNvbicsIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgIHZlcnNpb246IDEsXG4gICAgICBwcm9qZWN0U3RhcnRlZEF0OiAxNzAwMDAwMDAwMDAwLFxuICAgICAgdW5pdHM6IFtcbiAgICAgICAge1xuICAgICAgICAgIHR5cGU6ICdleGVjdXRlLXRhc2snLFxuICAgICAgICAgIGlkOiAnTTAwMS9TMDEvVDAxJyxcbiAgICAgICAgICBtb2RlbDogJ2NsYXVkZS1zb25uZXQtNCcsXG4gICAgICAgICAgc3RhcnRlZEF0OiAxNzAwMDAxMDAwMDAwLFxuICAgICAgICAgIGZpbmlzaGVkQXQ6IDE3MDAwMDIwMDAwMDAsXG4gICAgICAgICAgdG9rZW5zOiB7IGlucHV0OiAxMDAwMCwgb3V0cHV0OiAzMDAwLCBjYWNoZVJlYWQ6IDIwMDAsIGNhY2hlV3JpdGU6IDEwMDAsIHRvdGFsOiAxNjAwMCB9LFxuICAgICAgICAgIGNvc3Q6IDAuMDUsXG4gICAgICAgICAgdG9vbENhbGxzOiA4LFxuICAgICAgICAgIGFwaVJlcXVlc3RzOiAzLFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgdHlwZTogJ2V4ZWN1dGUtdGFzaycsXG4gICAgICAgICAgaWQ6ICdNMDAxL1MwMS9UMDInLFxuICAgICAgICAgIG1vZGVsOiAnY2xhdWRlLXNvbm5ldC00JyxcbiAgICAgICAgICBzdGFydGVkQXQ6IDE3MDAwMDMwMDAwMDAsXG4gICAgICAgICAgZmluaXNoZWRBdDogMTcwMDAwNDAwMDAwMCxcbiAgICAgICAgICB0b2tlbnM6IHsgaW5wdXQ6IDE1MDAwLCBvdXRwdXQ6IDUwMDAsIGNhY2hlUmVhZDogMzAwMCwgY2FjaGVXcml0ZTogMTUwMCwgdG90YWw6IDI0NTAwIH0sXG4gICAgICAgICAgY29zdDogMC4wOCxcbiAgICAgICAgICB0b29sQ2FsbHM6IDEyLFxuICAgICAgICAgIGFwaVJlcXVlc3RzOiA1LFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9KSk7XG4gIH0pO1xuXG4gIGFmdGVyKCgpID0+IHJtU3luYyhwcm9qZWN0RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpO1xuXG4gIGl0KCdyZXR1cm5zIGFsbCBlbnRyaWVzIHNvcnRlZCBieSBtb3N0IHJlY2VudCcsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSByZWFkSGlzdG9yeShwcm9qZWN0RGlyKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmVudHJpZXMubGVuZ3RoLCAyKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmVudHJpZXNbMF0uaWQsICdNMDAxL1MwMS9UMDInKTsgLy8gbW9zdCByZWNlbnQgZmlyc3RcbiAgfSk7XG5cbiAgaXQoJ2NvbXB1dGVzIHRvdGFscycsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSByZWFkSGlzdG9yeShwcm9qZWN0RGlyKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnRvdGFscy51bml0cywgMik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC50b3RhbHMuY29zdCwgMC4xMyk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC50b3RhbHMudG9rZW5zLnRvdGFsLCA0MDUwMCk7XG4gIH0pO1xuXG4gIGl0KCdyZXNwZWN0cyBsaW1pdCcsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSByZWFkSGlzdG9yeShwcm9qZWN0RGlyLCAxKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmVudHJpZXMubGVuZ3RoLCAxKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnRvdGFscy51bml0cywgMik7IC8vIHRvdGFscyBzdGlsbCByZWZsZWN0IGFsbFxuICB9KTtcblxuICBpdCgncmV0dXJucyBlbXB0eSBmb3IgbWlzc2luZyBtZXRyaWNzJywgKCkgPT4ge1xuICAgIGNvbnN0IGVtcHR5ID0gdG1wUHJvamVjdCgpO1xuICAgIG1rZGlyU3luYyhqb2luKGVtcHR5LCAnLmdzZCcpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBjb25zdCByZXN1bHQgPSByZWFkSGlzdG9yeShlbXB0eSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5lbnRyaWVzLmxlbmd0aCwgMCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC50b3RhbHMudW5pdHMsIDApO1xuICAgIHJtU3luYyhlbXB0eSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcbn0pO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIHJlYWRDYXB0dXJlcyB0ZXN0c1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmRlc2NyaWJlKCdyZWFkQ2FwdHVyZXMnLCAoKSA9PiB7XG4gIGxldCBwcm9qZWN0RGlyOiBzdHJpbmc7XG5cbiAgYmVmb3JlKCgpID0+IHtcbiAgICBwcm9qZWN0RGlyID0gdG1wUHJvamVjdCgpO1xuICAgIHdyaXRlRml4dHVyZShwcm9qZWN0RGlyLCAnLmdzZC9DQVBUVVJFUy5tZCcsIGAjIENhcHR1cmVzXG5cbiMjIyBDQVAtYWFhMTExMTFcblxuKipUZXh0OioqIEFkZCByYXRlIGxpbWl0aW5nIHRvIEFQSVxuKipDYXB0dXJlZDoqKiAyMDI2LTA0LTAxVDEwOjAwOjAwWlxuKipTdGF0dXM6KiogcGVuZGluZ1xuXG4jIyMgQ0FQLWJiYjIyMjIyXG5cbioqVGV4dDoqKiBSZWZhY3RvciBhdXRoIG1vZHVsZVxuKipDYXB0dXJlZDoqKiAyMDI2LTA0LTAyVDEwOjAwOjAwWlxuKipTdGF0dXM6KiogcmVzb2x2ZWRcbioqQ2xhc3NpZmljYXRpb246KiogaW5qZWN0XG4qKlJlc29sdXRpb246KiogQWRkZWQgdG8gTTAwMyByb2FkbWFwXG4qKlJhdGlvbmFsZToqKiBJbXBvcnRhbnQgZm9yIHNlY3VyaXR5XG4qKlJlc29sdmVkOioqIDIwMjYtMDQtMDNUMTA6MDA6MDBaXG4qKk1pbGVzdG9uZToqKiBNMDAzXG5cbiMjIyBDQVAtY2NjMzMzMzNcblxuKipUZXh0OioqIE5pY2UgdG8gaGF2ZTogZGFyayBtb2RlXG4qKkNhcHR1cmVkOioqIDIwMjYtMDQtMDJUMTE6MDA6MDBaXG4qKlN0YXR1czoqKiByZXNvbHZlZFxuKipDbGFzc2lmaWNhdGlvbjoqKiBkZWZlclxuKipSZXNvbHV0aW9uOioqIERlZmVycmVkIHRvIGZ1dHVyZVxuKipSYXRpb25hbGU6KiogTm90IGJsb2NraW5nXG4qKlJlc29sdmVkOioqIDIwMjYtMDQtMDNUMTE6MDA6MDBaXG5gKTtcbiAgfSk7XG5cbiAgYWZ0ZXIoKCkgPT4gcm1TeW5jKHByb2plY3REaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSk7XG5cbiAgaXQoJ3JlYWRzIGFsbCBjYXB0dXJlcycsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSByZWFkQ2FwdHVyZXMocHJvamVjdERpciwgJ2FsbCcpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuY2FwdHVyZXMubGVuZ3RoLCAzKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmNvdW50cy50b3RhbCwgMyk7XG4gIH0pO1xuXG4gIGl0KCdmaWx0ZXJzIHBlbmRpbmcgY2FwdHVyZXMnLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gcmVhZENhcHR1cmVzKHByb2plY3REaXIsICdwZW5kaW5nJyk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5jYXB0dXJlcy5sZW5ndGgsIDEpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuY2FwdHVyZXNbMF0uaWQsICdDQVAtYWFhMTExMTEnKTtcbiAgfSk7XG5cbiAgaXQoJ2ZpbHRlcnMgYWN0aW9uYWJsZSBjYXB0dXJlcyAoaW5qZWN0LCByZXBsYW4sIHF1aWNrLXRhc2spJywgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IHJlYWRDYXB0dXJlcyhwcm9qZWN0RGlyLCAnYWN0aW9uYWJsZScpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuY2FwdHVyZXMubGVuZ3RoLCAxKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmNhcHR1cmVzWzBdLmlkLCAnQ0FQLWJiYjIyMjIyJyk7XG4gIH0pO1xuXG4gIGl0KCdjb3VudHMgY29ycmVjdGx5IHJlZ2FyZGxlc3Mgb2YgZmlsdGVyJywgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IHJlYWRDYXB0dXJlcyhwcm9qZWN0RGlyLCAncGVuZGluZycpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuY291bnRzLnRvdGFsLCAzKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmNvdW50cy5wZW5kaW5nLCAxKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmNvdW50cy5hY3Rpb25hYmxlLCAxKTtcbiAgfSk7XG5cbiAgaXQoJ3JldHVybnMgZW1wdHkgZm9yIG1pc3NpbmcgQ0FQVFVSRVMubWQnLCAoKSA9PiB7XG4gICAgY29uc3QgZW1wdHkgPSB0bXBQcm9qZWN0KCk7XG4gICAgbWtkaXJTeW5jKGpvaW4oZW1wdHksICcuZ3NkJyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIGNvbnN0IHJlc3VsdCA9IHJlYWRDYXB0dXJlcyhlbXB0eSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5jYXB0dXJlcy5sZW5ndGgsIDApO1xuICAgIHJtU3luYyhlbXB0eSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcbn0pO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIHJlYWRLbm93bGVkZ2UgdGVzdHNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5kZXNjcmliZSgncmVhZEtub3dsZWRnZScsICgpID0+IHtcbiAgbGV0IHByb2plY3REaXI6IHN0cmluZztcblxuICBiZWZvcmUoKCkgPT4ge1xuICAgIHByb2plY3REaXIgPSB0bXBQcm9qZWN0KCk7XG4gICAgd3JpdGVGaXh0dXJlKHByb2plY3REaXIsICcuZ3NkL0tOT1dMRURHRS5tZCcsIGAjIFByb2plY3QgS25vd2xlZGdlXG5cbiMjIFJ1bGVzXG5cbnwgIyB8IFNjb3BlIHwgUnVsZSB8IFdoeSB8IEFkZGVkIHxcbnwtLS18LS0tLS0tLXwtLS0tLS18LS0tLS18LS0tLS0tLXxcbnwgSzAwMSB8IGF1dGggfCBIYXNoIHBhc3N3b3JkcyB3aXRoIGJjcnlwdCB8IFNlY3VyaXR5IHJlcXVpcmVtZW50IHwgbWFudWFsIHxcbnwgSzAwMiB8IGRiIHwgVXNlIHRyYW5zYWN0aW9ucyBmb3IgbXVsdGktdGFibGUgfCBEYXRhIGNvbnNpc3RlbmN5IHwgYXV0byB8XG5cbiMjIFBhdHRlcm5zXG5cbnwgIyB8IFBhdHRlcm4gfCBXaGVyZSB8IE5vdGVzIHxcbnwtLS18LS0tLS0tLS0tfC0tLS0tLS18LS0tLS0tLXxcbnwgUDAwMSB8IFNpbmdsZXRvbiBzZXJ2aWNlcyB8IHNlcnZpY2VzLyB8IFByZXZlbnRzIGR1cGxpY2F0aW9uIHxcblxuIyMgTGVzc29ucyBMZWFybmVkXG5cbnwgIyB8IFdoYXQgSGFwcGVuZWQgfCBSb290IENhdXNlIHwgRml4IHwgU2NvcGUgfFxufC0tLXwtLS0tLS0tLS0tLS0tLXwtLS0tLS0tLS0tLS18LS0tLS18LS0tLS0tLXxcbnwgTDAwMSB8IENJIHRlc3RzIGZhaWxlZCB8IEVudiBkaWZmIHwgQWRkZWQgc2V0dXAgc2NyaXB0IHwgdGVzdGluZyB8XG5gKTtcbiAgfSk7XG5cbiAgYWZ0ZXIoKCkgPT4gcm1TeW5jKHByb2plY3REaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSk7XG5cbiAgaXQoJ3JlYWRzIGFsbCBrbm93bGVkZ2UgZW50cmllcycsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSByZWFkS25vd2xlZGdlKHByb2plY3REaXIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuZW50cmllcy5sZW5ndGgsIDQpO1xuICB9KTtcblxuICBpdCgnY291bnRzIGJ5IHR5cGUnLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gcmVhZEtub3dsZWRnZShwcm9qZWN0RGlyKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmNvdW50cy5ydWxlcywgMik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5jb3VudHMucGF0dGVybnMsIDEpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuY291bnRzLmxlc3NvbnMsIDEpO1xuICB9KTtcblxuICBpdCgncGFyc2VzIHJ1bGUgZmllbGRzIGNvcnJlY3RseScsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSByZWFkS25vd2xlZGdlKHByb2plY3REaXIpO1xuICAgIGNvbnN0IGswMDEgPSByZXN1bHQuZW50cmllcy5maW5kKChlKSA9PiBlLmlkID09PSAnSzAwMScpO1xuICAgIGFzc2VydC5vayhrMDAxKTtcbiAgICBhc3NlcnQuZXF1YWwoazAwMS50eXBlLCAncnVsZScpO1xuICAgIGFzc2VydC5lcXVhbChrMDAxLnNjb3BlLCAnYXV0aCcpO1xuICAgIGFzc2VydC5vayhrMDAxLmNvbnRlbnQuaW5jbHVkZXMoJ2JjcnlwdCcpKTtcbiAgfSk7XG5cbiAgaXQoJ3JldHVybnMgZW1wdHkgZm9yIG1pc3NpbmcgS05PV0xFREdFLm1kJywgKCkgPT4ge1xuICAgIGNvbnN0IGVtcHR5ID0gdG1wUHJvamVjdCgpO1xuICAgIG1rZGlyU3luYyhqb2luKGVtcHR5LCAnLmdzZCcpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBjb25zdCByZXN1bHQgPSByZWFkS25vd2xlZGdlKGVtcHR5KTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmVudHJpZXMubGVuZ3RoLCAwKTtcbiAgICBybVN5bmMoZW1wdHksIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfSk7XG59KTtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBydW5Eb2N0b3JMaXRlIHRlc3RzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZGVzY3JpYmUoJ3J1bkRvY3RvckxpdGUnLCAoKSA9PiB7XG4gIGxldCBwcm9qZWN0RGlyOiBzdHJpbmc7XG5cbiAgYmVmb3JlKCgpID0+IHtcbiAgICBwcm9qZWN0RGlyID0gdG1wUHJvamVjdCgpO1xuXG4gICAgLy8gTTAwMTogY29tcGxldGUgbWlsZXN0b25lIChoYXMgc3VtbWFyeSlcbiAgICB3cml0ZUZpeHR1cmUocHJvamVjdERpciwgJy5nc2QvUFJPSkVDVC5tZCcsICcjIFRlc3QgUHJvamVjdCcpO1xuICAgIHdyaXRlRml4dHVyZShwcm9qZWN0RGlyLCAnLmdzZC9TVEFURS5tZCcsICcjIEdTRCBTdGF0ZScpO1xuICAgIHdyaXRlRml4dHVyZShwcm9qZWN0RGlyLCAnLmdzZC9taWxlc3RvbmVzL00wMDEvTTAwMS1DT05URVhULm1kJywgJyMgTTAwMScpO1xuICAgIHdyaXRlRml4dHVyZShwcm9qZWN0RGlyLCAnLmdzZC9taWxlc3RvbmVzL00wMDEvTTAwMS1ST0FETUFQLm1kJywgJyMgUm9hZG1hcCcpO1xuICAgIHdyaXRlRml4dHVyZShwcm9qZWN0RGlyLCAnLmdzZC9taWxlc3RvbmVzL00wMDEvTTAwMS1TVU1NQVJZLm1kJywgJyMgRG9uZScpO1xuICAgIHdyaXRlRml4dHVyZShwcm9qZWN0RGlyLCAnLmdzZC9taWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMS9TMDEtUExBTi5tZCcsICcjIFBsYW4nKTtcbiAgICB3cml0ZUZpeHR1cmUocHJvamVjdERpciwgJy5nc2QvbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvdGFza3MvVDAxLVBMQU4ubWQnLCAnIyBUMDEnKTtcbiAgICB3cml0ZUZpeHR1cmUocHJvamVjdERpciwgJy5nc2QvbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvdGFza3MvVDAxLVNVTU1BUlkubWQnLCAnIyBUMDEgZG9uZScpO1xuXG4gICAgLy8gTTAwMjogaW5jb21wbGV0ZSBcdTIwMTQgaGFzIGFsbCB0YXNrcyBkb25lIGJ1dCBubyBTVU1NQVJZXG4gICAgd3JpdGVGaXh0dXJlKHByb2plY3REaXIsICcuZ3NkL21pbGVzdG9uZXMvTTAwMi9NMDAyLUNPTlRFWFQubWQnLCAnIyBNMDAyJyk7XG4gICAgd3JpdGVGaXh0dXJlKHByb2plY3REaXIsICcuZ3NkL21pbGVzdG9uZXMvTTAwMi9NMDAyLVJPQURNQVAubWQnLCAnIyBSb2FkbWFwJyk7XG4gICAgd3JpdGVGaXh0dXJlKHByb2plY3REaXIsICcuZ3NkL21pbGVzdG9uZXMvTTAwMi9zbGljZXMvUzAxL1MwMS1QTEFOLm1kJywgJyMgUGxhbicpO1xuICAgIHdyaXRlRml4dHVyZShwcm9qZWN0RGlyLCAnLmdzZC9taWxlc3RvbmVzL00wMDIvc2xpY2VzL1MwMS90YXNrcy9UMDEtUExBTi5tZCcsICcjIFQwMScpO1xuICAgIHdyaXRlRml4dHVyZShwcm9qZWN0RGlyLCAnLmdzZC9taWxlc3RvbmVzL00wMDIvc2xpY2VzL1MwMS90YXNrcy9UMDEtU1VNTUFSWS5tZCcsICcjIFQwMSBkb25lJyk7XG5cbiAgICAvLyBNMDAzOiBlbXB0eSBcdTIwMTQgbm8gY29udGV4dCwgbm8gc2xpY2VzXG4gICAgbWtkaXJTeW5jKGpvaW4ocHJvamVjdERpciwgJy5nc2QvbWlsZXN0b25lcy9NMDAzJyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB9KTtcblxuICBhZnRlcigoKSA9PiBybVN5bmMocHJvamVjdERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcblxuICBpdCgnZGV0ZWN0cyBhbGwtc2xpY2VzLWRvbmUtbWlzc2luZy1zdW1tYXJ5JywgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IHJ1bkRvY3RvckxpdGUocHJvamVjdERpcik7XG4gICAgY29uc3QgaXNzdWUgPSByZXN1bHQuaXNzdWVzLmZpbmQoKGkpID0+IGkuY29kZSA9PT0gJ2FsbF9zbGljZXNfZG9uZV9taXNzaW5nX3N1bW1hcnknKTtcbiAgICBhc3NlcnQub2soaXNzdWUsICdTaG91bGQgZGV0ZWN0IE0wMDIgbWlzc2luZyBzdW1tYXJ5Jyk7XG4gICAgYXNzZXJ0LmVxdWFsKGlzc3VlLnVuaXRJZCwgJ00wMDInKTtcbiAgfSk7XG5cbiAgaXQoJ2RldGVjdHMgbWlzc2luZyBjb250ZXh0JywgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IHJ1bkRvY3RvckxpdGUocHJvamVjdERpcik7XG4gICAgY29uc3QgaXNzdWUgPSByZXN1bHQuaXNzdWVzLmZpbmQoXG4gICAgICAoaSkgPT4gaS5jb2RlID09PSAnbWlzc2luZ19jb250ZXh0JyAmJiBpLnVuaXRJZCA9PT0gJ00wMDMnLFxuICAgICk7XG4gICAgYXNzZXJ0Lm9rKGlzc3VlLCAnU2hvdWxkIGRldGVjdCBNMDAzIG1pc3NpbmcgY29udGV4dCcpO1xuICB9KTtcblxuICBpdCgnc2NvcGVzIHRvIGEgc2luZ2xlIG1pbGVzdG9uZScsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBydW5Eb2N0b3JMaXRlKHByb2plY3REaXIsICdNMDAxJyk7XG4gICAgY29uc3QgbTAwMklzc3VlcyA9IHJlc3VsdC5pc3N1ZXMuZmlsdGVyKChpKSA9PiBpLnVuaXRJZC5zdGFydHNXaXRoKCdNMDAyJykpO1xuICAgIGFzc2VydC5lcXVhbChtMDAySXNzdWVzLmxlbmd0aCwgMCwgJ1Nob3VsZCBub3QgaW5jbHVkZSBNMDAyIHdoZW4gc2NvcGVkIHRvIE0wMDEnKTtcbiAgfSk7XG5cbiAgaXQoJ3JldHVybnMgb2s6dHJ1ZSBmb3IgaGVhbHRoeSBwcm9qZWN0JywgKCkgPT4ge1xuICAgIGNvbnN0IGhlYWx0aHkgPSB0bXBQcm9qZWN0KCk7XG4gICAgd3JpdGVGaXh0dXJlKGhlYWx0aHksICcuZ3NkL1BST0pFQ1QubWQnLCAnIyBQcm9qZWN0Jyk7XG4gICAgd3JpdGVGaXh0dXJlKGhlYWx0aHksICcuZ3NkL1NUQVRFLm1kJywgJyMgU3RhdGUnKTtcbiAgICBjb25zdCByZXN1bHQgPSBydW5Eb2N0b3JMaXRlKGhlYWx0aHkpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQub2ssIHRydWUpO1xuICAgIHJtU3luYyhoZWFsdGh5LCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH0pO1xuXG4gIGl0KCdoYW5kbGVzIG1pc3NpbmcgLmdzZC8gZ3JhY2VmdWxseScsICgpID0+IHtcbiAgICBjb25zdCBlbXB0eSA9IHRtcFByb2plY3QoKTtcbiAgICBjb25zdCByZXN1bHQgPSBydW5Eb2N0b3JMaXRlKGVtcHR5KTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm9rLCB0cnVlKTtcbiAgICBhc3NlcnQub2soXG4gICAgICByZXN1bHQuaXNzdWVzLnNvbWUoXG4gICAgICAgIChpc3N1ZSkgPT4gaXNzdWUuY29kZSA9PT0gJ25vX2dzZF9kaXJlY3RvcnknIHx8IGlzc3VlLmNvZGUgPT09ICdtaXNzaW5nX3Byb2plY3RfbWQnLFxuICAgICAgKSxcbiAgICApO1xuICAgIHJtU3luYyhlbXB0eSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBR0EsU0FBUyxVQUFVLElBQUksUUFBUSxhQUFhO0FBQzVDLE9BQU8sWUFBWTtBQUNuQixTQUFTLFdBQVcsZUFBZSxjQUFjO0FBQ2pELFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFDdkIsU0FBUyxtQkFBbUI7QUFFNUIsU0FBUyxvQkFBb0I7QUFDN0IsU0FBUyxtQkFBbUI7QUFDNUIsU0FBUyxtQkFBbUI7QUFDNUIsU0FBUyxvQkFBb0I7QUFDN0IsU0FBUyxxQkFBcUI7QUFDOUIsU0FBUyxxQkFBcUI7QUFNOUIsU0FBUyxhQUFxQjtBQUM1QixRQUFNLE1BQU0sS0FBSyxPQUFPLEdBQUcsZ0JBQWdCLFlBQVksQ0FBQyxFQUFFLFNBQVMsS0FBSyxDQUFDLEVBQUU7QUFDM0UsWUFBVSxLQUFLLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDbEMsU0FBTztBQUNUO0FBRUEsU0FBUyxhQUFhLE1BQWMsU0FBaUIsU0FBdUI7QUFDMUUsUUFBTSxPQUFPLEtBQUssTUFBTSxPQUFPO0FBQy9CLFlBQVUsS0FBSyxNQUFNLElBQUksR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQy9DLGdCQUFjLE1BQU0sU0FBUyxPQUFPO0FBQ3RDO0FBTUEsU0FBUyxnQkFBZ0IsTUFBTTtBQUM3QixNQUFJO0FBRUosU0FBTyxNQUFNO0FBQ1gsaUJBQWEsV0FBVztBQUV4QixpQkFBYSxZQUFZLGlCQUFpQjtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsQ0FvQjdDO0FBR0csVUFBTSxLQUFLO0FBQ1gsaUJBQWEsWUFBWSxHQUFHLEVBQUUsZ0JBQWdCLE9BQU87QUFDckQsaUJBQWEsWUFBWSxHQUFHLEVBQUUsbUJBQW1CLFlBQVk7QUFFN0QsVUFBTSxLQUFLO0FBQ1gsaUJBQWEsWUFBWSxHQUFHLEVBQUUsZ0JBQWdCLE9BQU87QUFDckQsaUJBQWEsWUFBWSxHQUFHLEVBQUUsbUJBQW1CLFlBQVk7QUFDN0QsaUJBQWEsWUFBWSxHQUFHLEVBQUUsZ0JBQWdCLE9BQU87QUFFckQsY0FBVSxLQUFLLFlBQVksc0JBQXNCLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUFBLEVBQ3pFLENBQUM7QUFFRCxRQUFNLE1BQU0sT0FBTyxZQUFZLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDLENBQUM7QUFFaEUsS0FBRyx5Q0FBeUMsTUFBTTtBQUNoRCxVQUFNLFNBQVMsYUFBYSxVQUFVO0FBQ3RDLFdBQU8sVUFBVSxPQUFPLGlCQUFpQixFQUFFLElBQUksUUFBUSxPQUFPLGNBQWMsQ0FBQztBQUFBLEVBQy9FLENBQUM7QUFFRCxLQUFHLHVCQUF1QixNQUFNO0FBQzlCLFVBQU0sU0FBUyxhQUFhLFVBQVU7QUFDdEMsV0FBTyxVQUFVLE9BQU8sYUFBYSxFQUFFLElBQUksT0FBTyxPQUFPLGFBQWEsQ0FBQztBQUFBLEVBQ3pFLENBQUM7QUFFRCxLQUFHLGdCQUFnQixNQUFNO0FBQ3ZCLFVBQU0sU0FBUyxhQUFhLFVBQVU7QUFDdEMsV0FBTyxNQUFNLE9BQU8sT0FBTyxTQUFTO0FBQUEsRUFDdEMsQ0FBQztBQUVELEtBQUcseUNBQXlDLE1BQU07QUFDaEQsVUFBTSxTQUFTLGFBQWEsVUFBVTtBQUN0QyxXQUFPLE1BQU0sT0FBTyxXQUFXLE9BQU8sQ0FBQztBQUN2QyxXQUFPLE1BQU0sT0FBTyxXQUFXLE1BQU0sQ0FBQztBQUN0QyxXQUFPLE1BQU0sT0FBTyxXQUFXLFFBQVEsQ0FBQztBQUN4QyxXQUFPLE1BQU0sT0FBTyxXQUFXLFNBQVMsQ0FBQztBQUFBLEVBQzNDLENBQUM7QUFFRCxLQUFHLGdDQUFnQyxNQUFNO0FBQ3ZDLFVBQU0sU0FBUyxhQUFhLFVBQVU7QUFDdEMsV0FBTyxNQUFNLE9BQU8sTUFBTSxPQUFPLENBQUM7QUFDbEMsV0FBTyxNQUFNLE9BQU8sTUFBTSxNQUFNLENBQUM7QUFDakMsV0FBTyxNQUFNLE9BQU8sTUFBTSxTQUFTLENBQUM7QUFBQSxFQUN0QyxDQUFDO0FBRUQsS0FBRyxtQkFBbUIsTUFBTTtBQUMxQixVQUFNLFNBQVMsYUFBYSxVQUFVO0FBQ3RDLFdBQU8sTUFBTSxPQUFPLFNBQVMsUUFBUSxDQUFDO0FBQ3RDLFdBQU8sR0FBRyxPQUFPLFNBQVMsQ0FBQyxFQUFFLFNBQVMsT0FBTyxDQUFDO0FBQUEsRUFDaEQsQ0FBQztBQUVELEtBQUcsdUJBQXVCLE1BQU07QUFDOUIsVUFBTSxTQUFTLGFBQWEsVUFBVTtBQUN0QyxXQUFPLE1BQU0sT0FBTyxjQUFjLFFBQVEsQ0FBQztBQUMzQyxXQUFPLE1BQU0sT0FBTyxjQUFjLFdBQVcsQ0FBQztBQUM5QyxXQUFPLE1BQU0sT0FBTyxjQUFjLFVBQVUsQ0FBQztBQUFBLEVBQy9DLENBQUM7QUFFRCxLQUFHLHNCQUFzQixNQUFNO0FBQzdCLFVBQU0sU0FBUyxhQUFhLFVBQVU7QUFDdEMsV0FBTyxHQUFHLE9BQU8sV0FBVyxTQUFTLEtBQUssQ0FBQztBQUFBLEVBQzdDLENBQUM7QUFFRCxLQUFHLHNDQUFzQyxNQUFNO0FBQzdDLFVBQU0sUUFBUSxXQUFXO0FBQ3pCLFVBQU0sU0FBUyxhQUFhLEtBQUs7QUFDakMsV0FBTyxNQUFNLE9BQU8sT0FBTyxTQUFTO0FBQ3BDLFdBQU8sTUFBTSxPQUFPLFdBQVcsT0FBTyxDQUFDO0FBQ3ZDLFdBQU8sT0FBTyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLEVBQ2hELENBQUM7QUFDSCxDQUFDO0FBTUQsU0FBUyxlQUFlLE1BQU07QUFDNUIsTUFBSTtBQUVKLFNBQU8sTUFBTTtBQUNYLGlCQUFhLFdBQVc7QUFFeEIsaUJBQWEsWUFBWSx3Q0FBd0Msc0JBQXNCO0FBQ3ZGLGlCQUFhLFlBQVksd0NBQXdDO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLENBWXBFO0FBRUcsaUJBQWEsWUFBWSwrQ0FBK0M7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsQ0FNM0U7QUFDRyxpQkFBYSxZQUFZLHFEQUFxRCxPQUFPO0FBQ3JGLGlCQUFhLFlBQVksd0RBQXdELFlBQVk7QUFDN0YsaUJBQWEsWUFBWSxxREFBcUQsT0FBTztBQUNyRixpQkFBYSxZQUFZLHdEQUF3RCxZQUFZO0FBRTdGLGlCQUFhLFlBQVksK0NBQStDO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLENBTTNFO0FBQ0csaUJBQWEsWUFBWSxxREFBcUQsT0FBTztBQUNyRixpQkFBYSxZQUFZLHFEQUFxRCxPQUFPO0FBQUEsRUFDdkYsQ0FBQztBQUVELFFBQU0sTUFBTSxPQUFPLFlBQVksRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUMsQ0FBQztBQUVoRSxLQUFHLCtCQUErQixNQUFNO0FBQ3RDLFVBQU0sU0FBUyxZQUFZLFVBQVU7QUFDckMsV0FBTyxNQUFNLE9BQU8sV0FBVyxRQUFRLENBQUM7QUFDeEMsV0FBTyxNQUFNLE9BQU8sV0FBVyxDQUFDLEVBQUUsSUFBSSxNQUFNO0FBQzVDLFdBQU8sTUFBTSxPQUFPLFdBQVcsQ0FBQyxFQUFFLE9BQU8sWUFBWTtBQUFBLEVBQ3ZELENBQUM7QUFFRCxLQUFHLDZCQUE2QixNQUFNO0FBQ3BDLFVBQU0sU0FBUyxZQUFZLFVBQVU7QUFDckMsV0FBTyxHQUFHLE9BQU8sV0FBVyxDQUFDLEVBQUUsT0FBTyxTQUFTLFlBQVksQ0FBQztBQUFBLEVBQzlELENBQUM7QUFFRCxLQUFHLG9DQUFvQyxNQUFNO0FBQzNDLFVBQU0sU0FBUyxZQUFZLFVBQVU7QUFDckMsVUFBTSxTQUFTLE9BQU8sV0FBVyxDQUFDLEVBQUU7QUFDcEMsV0FBTyxNQUFNLE9BQU8sUUFBUSxDQUFDO0FBQzdCLFdBQU8sTUFBTSxPQUFPLENBQUMsRUFBRSxJQUFJLEtBQUs7QUFDaEMsV0FBTyxNQUFNLE9BQU8sQ0FBQyxFQUFFLE9BQU8saUJBQWlCO0FBQy9DLFdBQU8sTUFBTSxPQUFPLENBQUMsRUFBRSxJQUFJLEtBQUs7QUFBQSxFQUNsQyxDQUFDO0FBRUQsS0FBRyw0Q0FBNEMsTUFBTTtBQUNuRCxVQUFNLFNBQVMsWUFBWSxVQUFVO0FBQ3JDLFVBQU0sU0FBUyxPQUFPLFdBQVcsQ0FBQyxFQUFFO0FBQ3BDLFdBQU8sTUFBTSxPQUFPLENBQUMsRUFBRSxRQUFRLE1BQU07QUFDckMsV0FBTyxNQUFNLE9BQU8sQ0FBQyxFQUFFLFFBQVEsU0FBUztBQUFBLEVBQzFDLENBQUM7QUFFRCxLQUFHLDRCQUE0QixNQUFNO0FBQ25DLFVBQU0sU0FBUyxZQUFZLFVBQVU7QUFDckMsVUFBTSxXQUFXLE9BQU8sV0FBVyxDQUFDLEVBQUUsT0FBTyxDQUFDLEVBQUU7QUFDaEQsV0FBTyxNQUFNLFNBQVMsUUFBUSxDQUFDO0FBQy9CLFdBQU8sTUFBTSxTQUFTLENBQUMsRUFBRSxRQUFRLE1BQU07QUFBQSxFQUN6QyxDQUFDO0FBRUQsS0FBRywwQkFBMEIsTUFBTTtBQUNqQyxVQUFNLFNBQVMsWUFBWSxZQUFZLE1BQU07QUFDN0MsV0FBTyxNQUFNLE9BQU8sV0FBVyxRQUFRLENBQUM7QUFBQSxFQUMxQyxDQUFDO0FBQ0gsQ0FBQztBQU1ELFNBQVMsZUFBZSxNQUFNO0FBQzVCLE1BQUk7QUFFSixTQUFPLE1BQU07QUFDWCxpQkFBYSxXQUFXO0FBQ3hCLGlCQUFhLFlBQVkscUJBQXFCLEtBQUssVUFBVTtBQUFBLE1BQzNELFNBQVM7QUFBQSxNQUNULGtCQUFrQjtBQUFBLE1BQ2xCLE9BQU87QUFBQSxRQUNMO0FBQUEsVUFDRSxNQUFNO0FBQUEsVUFDTixJQUFJO0FBQUEsVUFDSixPQUFPO0FBQUEsVUFDUCxXQUFXO0FBQUEsVUFDWCxZQUFZO0FBQUEsVUFDWixRQUFRLEVBQUUsT0FBTyxLQUFPLFFBQVEsS0FBTSxXQUFXLEtBQU0sWUFBWSxLQUFNLE9BQU8sS0FBTTtBQUFBLFVBQ3RGLE1BQU07QUFBQSxVQUNOLFdBQVc7QUFBQSxVQUNYLGFBQWE7QUFBQSxRQUNmO0FBQUEsUUFDQTtBQUFBLFVBQ0UsTUFBTTtBQUFBLFVBQ04sSUFBSTtBQUFBLFVBQ0osT0FBTztBQUFBLFVBQ1AsV0FBVztBQUFBLFVBQ1gsWUFBWTtBQUFBLFVBQ1osUUFBUSxFQUFFLE9BQU8sTUFBTyxRQUFRLEtBQU0sV0FBVyxLQUFNLFlBQVksTUFBTSxPQUFPLE1BQU07QUFBQSxVQUN0RixNQUFNO0FBQUEsVUFDTixXQUFXO0FBQUEsVUFDWCxhQUFhO0FBQUEsUUFDZjtBQUFBLE1BQ0Y7QUFBQSxJQUNGLENBQUMsQ0FBQztBQUFBLEVBQ0osQ0FBQztBQUVELFFBQU0sTUFBTSxPQUFPLFlBQVksRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUMsQ0FBQztBQUVoRSxLQUFHLDZDQUE2QyxNQUFNO0FBQ3BELFVBQU0sU0FBUyxZQUFZLFVBQVU7QUFDckMsV0FBTyxNQUFNLE9BQU8sUUFBUSxRQUFRLENBQUM7QUFDckMsV0FBTyxNQUFNLE9BQU8sUUFBUSxDQUFDLEVBQUUsSUFBSSxjQUFjO0FBQUEsRUFDbkQsQ0FBQztBQUVELEtBQUcsbUJBQW1CLE1BQU07QUFDMUIsVUFBTSxTQUFTLFlBQVksVUFBVTtBQUNyQyxXQUFPLE1BQU0sT0FBTyxPQUFPLE9BQU8sQ0FBQztBQUNuQyxXQUFPLE1BQU0sT0FBTyxPQUFPLE1BQU0sSUFBSTtBQUNyQyxXQUFPLE1BQU0sT0FBTyxPQUFPLE9BQU8sT0FBTyxLQUFLO0FBQUEsRUFDaEQsQ0FBQztBQUVELEtBQUcsa0JBQWtCLE1BQU07QUFDekIsVUFBTSxTQUFTLFlBQVksWUFBWSxDQUFDO0FBQ3hDLFdBQU8sTUFBTSxPQUFPLFFBQVEsUUFBUSxDQUFDO0FBQ3JDLFdBQU8sTUFBTSxPQUFPLE9BQU8sT0FBTyxDQUFDO0FBQUEsRUFDckMsQ0FBQztBQUVELEtBQUcscUNBQXFDLE1BQU07QUFDNUMsVUFBTSxRQUFRLFdBQVc7QUFDekIsY0FBVSxLQUFLLE9BQU8sTUFBTSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDbEQsVUFBTSxTQUFTLFlBQVksS0FBSztBQUNoQyxXQUFPLE1BQU0sT0FBTyxRQUFRLFFBQVEsQ0FBQztBQUNyQyxXQUFPLE1BQU0sT0FBTyxPQUFPLE9BQU8sQ0FBQztBQUNuQyxXQUFPLE9BQU8sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUNoRCxDQUFDO0FBQ0gsQ0FBQztBQU1ELFNBQVMsZ0JBQWdCLE1BQU07QUFDN0IsTUFBSTtBQUVKLFNBQU8sTUFBTTtBQUNYLGlCQUFhLFdBQVc7QUFDeEIsaUJBQWEsWUFBWSxvQkFBb0I7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxDQTRCaEQ7QUFBQSxFQUNDLENBQUM7QUFFRCxRQUFNLE1BQU0sT0FBTyxZQUFZLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDLENBQUM7QUFFaEUsS0FBRyxzQkFBc0IsTUFBTTtBQUM3QixVQUFNLFNBQVMsYUFBYSxZQUFZLEtBQUs7QUFDN0MsV0FBTyxNQUFNLE9BQU8sU0FBUyxRQUFRLENBQUM7QUFDdEMsV0FBTyxNQUFNLE9BQU8sT0FBTyxPQUFPLENBQUM7QUFBQSxFQUNyQyxDQUFDO0FBRUQsS0FBRyw0QkFBNEIsTUFBTTtBQUNuQyxVQUFNLFNBQVMsYUFBYSxZQUFZLFNBQVM7QUFDakQsV0FBTyxNQUFNLE9BQU8sU0FBUyxRQUFRLENBQUM7QUFDdEMsV0FBTyxNQUFNLE9BQU8sU0FBUyxDQUFDLEVBQUUsSUFBSSxjQUFjO0FBQUEsRUFDcEQsQ0FBQztBQUVELEtBQUcsNERBQTRELE1BQU07QUFDbkUsVUFBTSxTQUFTLGFBQWEsWUFBWSxZQUFZO0FBQ3BELFdBQU8sTUFBTSxPQUFPLFNBQVMsUUFBUSxDQUFDO0FBQ3RDLFdBQU8sTUFBTSxPQUFPLFNBQVMsQ0FBQyxFQUFFLElBQUksY0FBYztBQUFBLEVBQ3BELENBQUM7QUFFRCxLQUFHLHlDQUF5QyxNQUFNO0FBQ2hELFVBQU0sU0FBUyxhQUFhLFlBQVksU0FBUztBQUNqRCxXQUFPLE1BQU0sT0FBTyxPQUFPLE9BQU8sQ0FBQztBQUNuQyxXQUFPLE1BQU0sT0FBTyxPQUFPLFNBQVMsQ0FBQztBQUNyQyxXQUFPLE1BQU0sT0FBTyxPQUFPLFlBQVksQ0FBQztBQUFBLEVBQzFDLENBQUM7QUFFRCxLQUFHLHlDQUF5QyxNQUFNO0FBQ2hELFVBQU0sUUFBUSxXQUFXO0FBQ3pCLGNBQVUsS0FBSyxPQUFPLE1BQU0sR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ2xELFVBQU0sU0FBUyxhQUFhLEtBQUs7QUFDakMsV0FBTyxNQUFNLE9BQU8sU0FBUyxRQUFRLENBQUM7QUFDdEMsV0FBTyxPQUFPLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsRUFDaEQsQ0FBQztBQUNILENBQUM7QUFNRCxTQUFTLGlCQUFpQixNQUFNO0FBQzlCLE1BQUk7QUFFSixTQUFPLE1BQU07QUFDWCxpQkFBYSxXQUFXO0FBQ3hCLGlCQUFhLFlBQVkscUJBQXFCO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxDQW9CakQ7QUFBQSxFQUNDLENBQUM7QUFFRCxRQUFNLE1BQU0sT0FBTyxZQUFZLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDLENBQUM7QUFFaEUsS0FBRywrQkFBK0IsTUFBTTtBQUN0QyxVQUFNLFNBQVMsY0FBYyxVQUFVO0FBQ3ZDLFdBQU8sTUFBTSxPQUFPLFFBQVEsUUFBUSxDQUFDO0FBQUEsRUFDdkMsQ0FBQztBQUVELEtBQUcsa0JBQWtCLE1BQU07QUFDekIsVUFBTSxTQUFTLGNBQWMsVUFBVTtBQUN2QyxXQUFPLE1BQU0sT0FBTyxPQUFPLE9BQU8sQ0FBQztBQUNuQyxXQUFPLE1BQU0sT0FBTyxPQUFPLFVBQVUsQ0FBQztBQUN0QyxXQUFPLE1BQU0sT0FBTyxPQUFPLFNBQVMsQ0FBQztBQUFBLEVBQ3ZDLENBQUM7QUFFRCxLQUFHLGdDQUFnQyxNQUFNO0FBQ3ZDLFVBQU0sU0FBUyxjQUFjLFVBQVU7QUFDdkMsVUFBTSxPQUFPLE9BQU8sUUFBUSxLQUFLLENBQUMsTUFBTSxFQUFFLE9BQU8sTUFBTTtBQUN2RCxXQUFPLEdBQUcsSUFBSTtBQUNkLFdBQU8sTUFBTSxLQUFLLE1BQU0sTUFBTTtBQUM5QixXQUFPLE1BQU0sS0FBSyxPQUFPLE1BQU07QUFDL0IsV0FBTyxHQUFHLEtBQUssUUFBUSxTQUFTLFFBQVEsQ0FBQztBQUFBLEVBQzNDLENBQUM7QUFFRCxLQUFHLDBDQUEwQyxNQUFNO0FBQ2pELFVBQU0sUUFBUSxXQUFXO0FBQ3pCLGNBQVUsS0FBSyxPQUFPLE1BQU0sR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ2xELFVBQU0sU0FBUyxjQUFjLEtBQUs7QUFDbEMsV0FBTyxNQUFNLE9BQU8sUUFBUSxRQUFRLENBQUM7QUFDckMsV0FBTyxPQUFPLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsRUFDaEQsQ0FBQztBQUNILENBQUM7QUFNRCxTQUFTLGlCQUFpQixNQUFNO0FBQzlCLE1BQUk7QUFFSixTQUFPLE1BQU07QUFDWCxpQkFBYSxXQUFXO0FBR3hCLGlCQUFhLFlBQVksbUJBQW1CLGdCQUFnQjtBQUM1RCxpQkFBYSxZQUFZLGlCQUFpQixhQUFhO0FBQ3ZELGlCQUFhLFlBQVksd0NBQXdDLFFBQVE7QUFDekUsaUJBQWEsWUFBWSx3Q0FBd0MsV0FBVztBQUM1RSxpQkFBYSxZQUFZLHdDQUF3QyxRQUFRO0FBQ3pFLGlCQUFhLFlBQVksK0NBQStDLFFBQVE7QUFDaEYsaUJBQWEsWUFBWSxxREFBcUQsT0FBTztBQUNyRixpQkFBYSxZQUFZLHdEQUF3RCxZQUFZO0FBRzdGLGlCQUFhLFlBQVksd0NBQXdDLFFBQVE7QUFDekUsaUJBQWEsWUFBWSx3Q0FBd0MsV0FBVztBQUM1RSxpQkFBYSxZQUFZLCtDQUErQyxRQUFRO0FBQ2hGLGlCQUFhLFlBQVkscURBQXFELE9BQU87QUFDckYsaUJBQWEsWUFBWSx3REFBd0QsWUFBWTtBQUc3RixjQUFVLEtBQUssWUFBWSxzQkFBc0IsR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQUEsRUFDekUsQ0FBQztBQUVELFFBQU0sTUFBTSxPQUFPLFlBQVksRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUMsQ0FBQztBQUVoRSxLQUFHLDJDQUEyQyxNQUFNO0FBQ2xELFVBQU0sU0FBUyxjQUFjLFVBQVU7QUFDdkMsVUFBTSxRQUFRLE9BQU8sT0FBTyxLQUFLLENBQUMsTUFBTSxFQUFFLFNBQVMsaUNBQWlDO0FBQ3BGLFdBQU8sR0FBRyxPQUFPLG9DQUFvQztBQUNyRCxXQUFPLE1BQU0sTUFBTSxRQUFRLE1BQU07QUFBQSxFQUNuQyxDQUFDO0FBRUQsS0FBRywyQkFBMkIsTUFBTTtBQUNsQyxVQUFNLFNBQVMsY0FBYyxVQUFVO0FBQ3ZDLFVBQU0sUUFBUSxPQUFPLE9BQU87QUFBQSxNQUMxQixDQUFDLE1BQU0sRUFBRSxTQUFTLHFCQUFxQixFQUFFLFdBQVc7QUFBQSxJQUN0RDtBQUNBLFdBQU8sR0FBRyxPQUFPLG9DQUFvQztBQUFBLEVBQ3ZELENBQUM7QUFFRCxLQUFHLGdDQUFnQyxNQUFNO0FBQ3ZDLFVBQU0sU0FBUyxjQUFjLFlBQVksTUFBTTtBQUMvQyxVQUFNLGFBQWEsT0FBTyxPQUFPLE9BQU8sQ0FBQyxNQUFNLEVBQUUsT0FBTyxXQUFXLE1BQU0sQ0FBQztBQUMxRSxXQUFPLE1BQU0sV0FBVyxRQUFRLEdBQUcsNkNBQTZDO0FBQUEsRUFDbEYsQ0FBQztBQUVELEtBQUcsdUNBQXVDLE1BQU07QUFDOUMsVUFBTSxVQUFVLFdBQVc7QUFDM0IsaUJBQWEsU0FBUyxtQkFBbUIsV0FBVztBQUNwRCxpQkFBYSxTQUFTLGlCQUFpQixTQUFTO0FBQ2hELFVBQU0sU0FBUyxjQUFjLE9BQU87QUFDcEMsV0FBTyxNQUFNLE9BQU8sSUFBSSxJQUFJO0FBQzVCLFdBQU8sU0FBUyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLEVBQ2xELENBQUM7QUFFRCxLQUFHLG9DQUFvQyxNQUFNO0FBQzNDLFVBQU0sUUFBUSxXQUFXO0FBQ3pCLFVBQU0sU0FBUyxjQUFjLEtBQUs7QUFDbEMsV0FBTyxNQUFNLE9BQU8sSUFBSSxJQUFJO0FBQzVCLFdBQU87QUFBQSxNQUNMLE9BQU8sT0FBTztBQUFBLFFBQ1osQ0FBQyxVQUFVLE1BQU0sU0FBUyxzQkFBc0IsTUFBTSxTQUFTO0FBQUEsTUFDakU7QUFBQSxJQUNGO0FBQ0EsV0FBTyxPQUFPLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsRUFDaEQsQ0FBQztBQUNILENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
