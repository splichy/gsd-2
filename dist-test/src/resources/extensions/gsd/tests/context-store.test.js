import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  openDatabase,
  closeDatabase,
  isDbAvailable,
  insertDecision,
  insertRequirement,
  insertArtifact
} from "../gsd-db.js";
import {
  queryDecisions,
  queryRequirements,
  formatDecisionsForPrompt,
  formatRequirementsForPrompt,
  queryArtifact,
  queryProject,
  formatRoadmapExcerpt,
  queryKnowledge
} from "../context-store.js";
describe("context-store: fallback when DB not open", () => {
  test("returns empty when DB not open", () => {
    closeDatabase();
    assert.ok(!isDbAvailable(), "DB should not be available");
    const d = queryDecisions();
    assert.deepStrictEqual(d, [], "queryDecisions returns [] when DB closed");
    const r = queryRequirements();
    assert.deepStrictEqual(r, [], "queryRequirements returns [] when DB closed");
    const df = queryDecisions({ milestoneId: "M001" });
    assert.deepStrictEqual(df, [], "queryDecisions with opts returns [] when DB closed");
    const rf = queryRequirements({ sliceId: "S01" });
    assert.deepStrictEqual(rf, [], "queryRequirements with opts returns [] when DB closed");
  });
});
describe("context-store: query decisions", () => {
  afterEach(() => closeDatabase());
  test("query all active decisions", () => {
    openDatabase(":memory:");
    insertDecision({
      id: "D001",
      when_context: "M001/S01",
      scope: "architecture",
      decision: "use SQLite",
      choice: "node:sqlite",
      rationale: "built-in",
      revisable: "yes",
      made_by: "agent",
      superseded_by: "D003"
      // superseded!
    });
    insertDecision({
      id: "D002",
      when_context: "M001/S01",
      scope: "architecture",
      decision: "use WAL mode",
      choice: "WAL",
      rationale: "concurrent reads",
      revisable: "no",
      made_by: "agent",
      superseded_by: null
    });
    insertDecision({
      id: "D003",
      when_context: "M002/S01",
      scope: "performance",
      decision: "use better-sqlite3",
      choice: "better-sqlite3",
      rationale: "faster",
      revisable: "yes",
      made_by: "agent",
      superseded_by: null
    });
    const all = queryDecisions();
    assert.strictEqual(all.length, 2, "query all active decisions returns 2 (superseded excluded)");
    const ids = all.map((d) => d.id);
    assert.ok(ids.includes("D002"), "D002 should be in active results");
    assert.ok(ids.includes("D003"), "D003 should be in active results");
    assert.ok(!ids.includes("D001"), "D001 (superseded) should NOT be in active results");
  });
  test("query decisions by milestone", () => {
    openDatabase(":memory:");
    insertDecision({
      id: "D001",
      when_context: "M001/S01",
      scope: "architecture",
      decision: "decision A",
      choice: "A",
      rationale: "r",
      revisable: "yes",
      made_by: "agent",
      superseded_by: null
    });
    insertDecision({
      id: "D002",
      when_context: "M002/S02",
      scope: "architecture",
      decision: "decision B",
      choice: "B",
      rationale: "r",
      revisable: "yes",
      made_by: "agent",
      superseded_by: null
    });
    const m1 = queryDecisions({ milestoneId: "M001" });
    assert.strictEqual(m1.length, 1, "milestone filter M001 returns 1");
    assert.strictEqual(m1[0]?.id, "D001", "milestone filter returns D001");
    const m2 = queryDecisions({ milestoneId: "M002" });
    assert.strictEqual(m2.length, 1, "milestone filter M002 returns 1");
    assert.strictEqual(m2[0]?.id, "D002", "milestone filter returns D002");
  });
  test("query decisions by scope", () => {
    openDatabase(":memory:");
    insertDecision({
      id: "D001",
      when_context: "M001/S01",
      scope: "architecture",
      decision: "decision A",
      choice: "A",
      rationale: "r",
      revisable: "yes",
      made_by: "agent",
      superseded_by: null
    });
    insertDecision({
      id: "D002",
      when_context: "M001/S01",
      scope: "performance",
      decision: "decision B",
      choice: "B",
      rationale: "r",
      revisable: "yes",
      made_by: "agent",
      superseded_by: null
    });
    const arch = queryDecisions({ scope: "architecture" });
    assert.strictEqual(arch.length, 1, "scope filter architecture returns 1");
    assert.strictEqual(arch[0]?.id, "D001", "scope filter returns D001");
    const perf = queryDecisions({ scope: "performance" });
    assert.strictEqual(perf.length, 1, "scope filter performance returns 1");
    assert.strictEqual(perf[0]?.id, "D002", "scope filter returns D002");
    const none = queryDecisions({ scope: "nonexistent" });
    assert.strictEqual(none.length, 0, "scope filter nonexistent returns 0");
  });
});
describe("context-store: query requirements", () => {
  afterEach(() => closeDatabase());
  test("query all active requirements", () => {
    openDatabase(":memory:");
    insertRequirement({
      id: "R001",
      class: "functional",
      status: "active",
      description: "req A",
      why: "w",
      source: "M001",
      primary_owner: "S01",
      supporting_slices: "S02",
      validation: "v",
      notes: "",
      full_content: "",
      superseded_by: "R003"
      // superseded!
    });
    insertRequirement({
      id: "R002",
      class: "non-functional",
      status: "active",
      description: "req B",
      why: "w",
      source: "M001",
      primary_owner: "S01",
      supporting_slices: "",
      validation: "v",
      notes: "",
      full_content: "",
      superseded_by: null
    });
    insertRequirement({
      id: "R003",
      class: "functional",
      status: "validated",
      description: "req C",
      why: "w",
      source: "M001",
      primary_owner: "S02",
      supporting_slices: "S01",
      validation: "v",
      notes: "",
      full_content: "",
      superseded_by: null
    });
    const all = queryRequirements();
    assert.strictEqual(all.length, 2, "query all active requirements returns 2 (superseded excluded)");
    const ids = all.map((r) => r.id);
    assert.ok(ids.includes("R002"), "R002 should be active");
    assert.ok(ids.includes("R003"), "R003 should be active");
    assert.ok(!ids.includes("R001"), "R001 (superseded) should NOT be active");
  });
  test("query requirements by slice", () => {
    openDatabase(":memory:");
    insertRequirement({
      id: "R001",
      class: "functional",
      status: "active",
      description: "req A",
      why: "w",
      source: "M001",
      primary_owner: "S01",
      supporting_slices: "",
      validation: "v",
      notes: "",
      full_content: "",
      superseded_by: null
    });
    insertRequirement({
      id: "R002",
      class: "functional",
      status: "active",
      description: "req B",
      why: "w",
      source: "M001",
      primary_owner: "S02",
      supporting_slices: "S01",
      validation: "v",
      notes: "",
      full_content: "",
      superseded_by: null
    });
    insertRequirement({
      id: "R003",
      class: "functional",
      status: "active",
      description: "req C",
      why: "w",
      source: "M001",
      primary_owner: "S03",
      supporting_slices: "",
      validation: "v",
      notes: "",
      full_content: "",
      superseded_by: null
    });
    const s01 = queryRequirements({ sliceId: "S01" });
    assert.strictEqual(s01.length, 2, "slice filter S01 returns 2 (primary + supporting)");
    const s01ids = s01.map((r) => r.id).sort();
    assert.deepStrictEqual(s01ids, ["R001", "R002"], "S01 owns R001 and supports R002");
    const s03 = queryRequirements({ sliceId: "S03" });
    assert.strictEqual(s03.length, 1, "slice filter S03 returns 1");
    assert.strictEqual(s03[0]?.id, "R003", "S03 owns R003");
  });
  test("query requirements by status", () => {
    openDatabase(":memory:");
    insertRequirement({
      id: "R001",
      class: "functional",
      status: "active",
      description: "req A",
      why: "w",
      source: "M001",
      primary_owner: "S01",
      supporting_slices: "",
      validation: "v",
      notes: "",
      full_content: "",
      superseded_by: null
    });
    insertRequirement({
      id: "R002",
      class: "functional",
      status: "validated",
      description: "req B",
      why: "w",
      source: "M001",
      primary_owner: "S01",
      supporting_slices: "",
      validation: "v",
      notes: "",
      full_content: "",
      superseded_by: null
    });
    insertRequirement({
      id: "R003",
      class: "functional",
      status: "deferred",
      description: "req C",
      why: "w",
      source: "M001",
      primary_owner: "S01",
      supporting_slices: "",
      validation: "v",
      notes: "",
      full_content: "",
      superseded_by: null
    });
    const active = queryRequirements({ status: "active" });
    assert.strictEqual(active.length, 1, "status filter active returns 1");
    assert.strictEqual(active[0]?.id, "R001", "active returns R001");
    const validated = queryRequirements({ status: "validated" });
    assert.strictEqual(validated.length, 1, "status filter validated returns 1");
    assert.strictEqual(validated[0]?.id, "R002", "validated returns R002");
  });
});
describe("context-store: formatDecisionsForPrompt", () => {
  test("empty input returns empty string", () => {
    const empty = formatDecisionsForPrompt([]);
    assert.strictEqual(empty, "", "empty input returns empty string");
  });
  test("formats decisions as markdown table", () => {
    const result = formatDecisionsForPrompt([
      {
        seq: 1,
        id: "D001",
        when_context: "M001/S01",
        scope: "architecture",
        decision: "use SQLite",
        choice: "node:sqlite",
        rationale: "built-in",
        revisable: "yes",
        made_by: "agent",
        superseded_by: null
      },
      {
        seq: 2,
        id: "D002",
        when_context: "M001/S02",
        scope: "performance",
        decision: "use WAL",
        choice: "WAL",
        rationale: "concurrent",
        revisable: "no",
        made_by: "human",
        superseded_by: null
      }
    ]);
    assert.match(result, /^\| # \| When \| Scope/, "has table header");
    assert.match(result, /\|---\|/, "has separator row");
    assert.match(result, /\| D001 \|/, "has D001 row");
    assert.match(result, /\| D002 \|/, "has D002 row");
    const lines = result.split("\n");
    assert.strictEqual(lines.length, 4, "table has 4 lines (header + separator + 2 rows)");
  });
});
describe("context-store: formatRequirementsForPrompt", () => {
  test("empty input returns empty string", () => {
    const empty = formatRequirementsForPrompt([]);
    assert.strictEqual(empty, "", "empty input returns empty string");
  });
  test("formats requirements as markdown sections", () => {
    const result = formatRequirementsForPrompt([
      {
        id: "R001",
        class: "functional",
        status: "active",
        description: "System must persist decisions",
        why: "agent memory",
        source: "M001",
        primary_owner: "S01",
        supporting_slices: "S02",
        validation: "roundtrip test",
        notes: "high priority",
        full_content: "",
        superseded_by: null
      },
      {
        id: "R002",
        class: "non-functional",
        status: "active",
        description: "Sub-5ms query latency",
        why: "prompt injection speed",
        source: "M001",
        primary_owner: "S01",
        supporting_slices: "",
        validation: "timing test",
        notes: "",
        full_content: "",
        superseded_by: null
      }
    ]);
    assert.match(result, /### R001: System must persist decisions/, "has R001 section header");
    assert.match(result, /### R002: Sub-5ms query latency/, "has R002 section header");
    assert.match(result, /\*\*Class:\*\* functional/, "has class field");
    assert.match(result, /\*\*Status:\*\* active/, "has status field");
    assert.match(result, /\*\*Supporting Slices:\*\* S02/, "has supporting slices when present");
    const r002Section = result.split("### R002")[1] || "";
    assert.ok(!r002Section.includes("**Supporting Slices:**"), "no supporting slices line when empty");
    assert.ok(!r002Section.includes("**Notes:**"), "no notes line when empty");
  });
});
describe("context-store: sub-5ms query timing", () => {
  afterEach(() => closeDatabase());
  test("queries complete under 5ms for 50+50 rows", () => {
    openDatabase(":memory:");
    for (let i = 1; i <= 50; i++) {
      const id = `D${String(i).padStart(3, "0")}`;
      insertDecision({
        id,
        when_context: `M00${i % 3 + 1}/S0${i % 5 + 1}`,
        scope: i % 2 === 0 ? "architecture" : "performance",
        decision: `decision ${i}`,
        choice: `choice ${i}`,
        rationale: `rationale ${i}`,
        revisable: i % 3 === 0 ? "no" : "yes",
        made_by: "agent",
        superseded_by: null
      });
    }
    for (let i = 1; i <= 50; i++) {
      const id = `R${String(i).padStart(3, "0")}`;
      insertRequirement({
        id,
        class: i % 2 === 0 ? "functional" : "non-functional",
        status: i % 4 === 0 ? "validated" : "active",
        description: `requirement ${i}`,
        why: `why ${i}`,
        source: "M001",
        primary_owner: `S0${i % 5 + 1}`,
        supporting_slices: i % 3 === 0 ? "S01, S02" : "",
        validation: `validation ${i}`,
        notes: "",
        full_content: "",
        superseded_by: null
      });
    }
    queryDecisions();
    queryRequirements();
    const start = performance.now();
    const decisions = queryDecisions();
    const requirements = queryRequirements();
    const elapsed = performance.now() - start;
    assert.strictEqual(decisions.length, 50, `got ${decisions.length} decisions (expected 50)`);
    assert.strictEqual(requirements.length, 50, `got ${requirements.length} requirements (expected 50)`);
    const maxLatencyMs = process.env.NODE_V8_COVERAGE ? 15 : 5;
    assert.ok(
      elapsed < maxLatencyMs,
      `query latency ${elapsed.toFixed(2)}ms should be < ${maxLatencyMs}ms`
    );
  });
});
describe("context-store: queryArtifact", () => {
  afterEach(() => closeDatabase());
  test("returns content for existing path", () => {
    openDatabase(":memory:");
    insertArtifact({
      path: "PROJECT.md",
      artifact_type: "project",
      milestone_id: null,
      slice_id: null,
      task_id: null,
      full_content: "# My Project\n\nProject description here."
    });
    insertArtifact({
      path: ".gsd/milestones/M001/M001-PLAN.md",
      artifact_type: "milestone_plan",
      milestone_id: "M001",
      slice_id: null,
      task_id: null,
      full_content: "# M001 Plan\n\nMilestone content."
    });
    const project = queryArtifact("PROJECT.md");
    assert.strictEqual(project, "# My Project\n\nProject description here.", "queryArtifact returns full_content for PROJECT.md");
    const plan = queryArtifact(".gsd/milestones/M001/M001-PLAN.md");
    assert.strictEqual(plan, "# M001 Plan\n\nMilestone content.", "queryArtifact returns full_content for milestone plan");
  });
  test("returns null for missing path", () => {
    openDatabase(":memory:");
    const missing = queryArtifact("nonexistent.md");
    assert.strictEqual(missing, null, "queryArtifact returns null for path not in DB");
  });
  test("returns null when DB unavailable", () => {
    closeDatabase();
    assert.ok(!isDbAvailable(), "DB should not be available");
    const result = queryArtifact("PROJECT.md");
    assert.strictEqual(result, null, "queryArtifact returns null when DB closed");
  });
});
describe("context-store: queryProject", () => {
  afterEach(() => closeDatabase());
  test("returns PROJECT.md content", () => {
    openDatabase(":memory:");
    insertArtifact({
      path: "PROJECT.md",
      artifact_type: "project",
      milestone_id: null,
      slice_id: null,
      task_id: null,
      full_content: "# Test Project\n\nThis is the project description."
    });
    const content = queryProject();
    assert.strictEqual(content, "# Test Project\n\nThis is the project description.", "queryProject returns PROJECT.md content");
  });
  test("returns null when no PROJECT.md", () => {
    openDatabase(":memory:");
    const content = queryProject();
    assert.strictEqual(content, null, "queryProject returns null when PROJECT.md not imported");
  });
  test("returns null when DB unavailable", () => {
    closeDatabase();
    assert.ok(!isDbAvailable(), "DB should not be available");
    const content = queryProject();
    assert.strictEqual(content, null, "queryProject returns null when DB closed");
  });
});
describe("context-store: formatRoadmapExcerpt", () => {
  const sampleRoadmap = `# M005: Tiered Context Injection

## Vision
Refactor prompt builders to inject relevance-scoped context.

## Slice Overview
| ID | Slice | Risk | Depends | Done | After this |
|----|-------|------|---------|------|------------|
| S01 | Scope existing queries | low | \u2014 | \u2705 | planSlice prompt scoped. |
| S02 | KNOWLEDGE scoping | medium | S01 | \u2B1C | KNOWLEDGE sections filtered. |
| S03 | Measurement test | low | S02 | \u2B1C | 40% reduction confirmed. |
`;
  test("S02 with S01 predecessor includes both rows", () => {
    const result = formatRoadmapExcerpt(sampleRoadmap, "S02", ".gsd/milestones/M005/M005-ROADMAP.md");
    assert.match(result, /\| ID \| Slice \| Risk \| Depends \| Done \| After this \|/, "has header row");
    assert.match(result, /\|----\|/, "has separator row");
    assert.match(result, /\| S01 \|/, "has predecessor S01 row");
    assert.match(result, /\| S02 \|/, "has target S02 row");
    assert.match(result, /See full roadmap:.*M005-ROADMAP\.md/, "has reference directive");
    assert.ok(!result.includes("| S03 |"), "does not include unrelated S03");
  });
  test("S01 with no predecessor includes only target row", () => {
    const result = formatRoadmapExcerpt(sampleRoadmap, "S01");
    assert.match(result, /\| ID \| Slice \|/, "has header row");
    assert.match(result, /\| S01 \|/, "has target S01 row");
    assert.ok(!result.includes("| S02 |"), "does not include S02");
    assert.ok(!result.includes("| S03 |"), "does not include S03");
    assert.match(result, /See full roadmap:/, "has reference directive");
    const lines = result.split("\n");
    assert.strictEqual(lines.length, 5, "correct number of lines (no predecessor)");
  });
  test("missing slice returns empty string", () => {
    const result = formatRoadmapExcerpt(sampleRoadmap, "S99");
    assert.strictEqual(result, "", "missing slice returns empty string");
  });
  test("empty input returns empty string", () => {
    assert.strictEqual(formatRoadmapExcerpt("", "S01"), "", "empty content returns empty");
    assert.strictEqual(formatRoadmapExcerpt(sampleRoadmap, ""), "", "empty sliceId returns empty");
  });
  test("handles table with various column formats", () => {
    const variantRoadmap = `# Milestone

| ID | Slice | Risk | Depends | Done | After this |
|:---|:------|:-----|:--------|:-----|:-----------|
| S01 | First slice title | low | \u2014 | \u2705 | First complete. |
| S02 | Second longer slice title here | medium | S01 | \u2B1C | Second working. |
`;
    const result = formatRoadmapExcerpt(variantRoadmap, "S02");
    assert.match(result, /\| S01 \|/, "has predecessor with different spacing");
    assert.match(result, /\| S02 \|/, "has target with different spacing");
    assert.match(result, /Second longer slice title/, "preserves full slice title");
  });
  test("handles multiple dependencies by using first one", () => {
    const multiDepRoadmap = `| ID | Slice | Risk | Depends | Done | After this |
|----|-------|------|---------|------|------------|
| S01 | First | low | \u2014 | \u2705 | Done. |
| S02 | Second | low | \u2014 | \u2705 | Done. |
| S03 | Third | medium | S01, S02 | \u2B1C | Working. |
`;
    const result = formatRoadmapExcerpt(multiDepRoadmap, "S03");
    assert.match(result, /\| S01 \|/, "has first dependency S01");
    assert.match(result, /\| S03 \|/, "has target S03");
  });
});
describe("context-store: queryKnowledge", () => {
  const sampleKnowledge = `# Project Knowledge

## Database Patterns
SQLite is used with WAL mode for concurrent reads.
Always use prepared statements.

More database details here.

## API Design
REST endpoints follow OpenAPI spec.
Use versioned paths like /v1/resource.

## Testing Guidelines
Unit tests use node:test.
Integration tests mock external services.
`;
  test("single keyword matches header", async () => {
    const result = await queryKnowledge(sampleKnowledge, ["database"]);
    assert.match(result, /## Database Patterns/, "includes matching section header");
    assert.match(result, /SQLite is used with WAL mode/, "includes section content");
    assert.ok(!result.includes("## API Design"), "does not include non-matching API section");
    assert.ok(!result.includes("## Testing Guidelines"), "does not include non-matching Testing section");
  });
  test("multiple keywords match multiple sections", async () => {
    const result = await queryKnowledge(sampleKnowledge, ["database", "testing"]);
    assert.match(result, /## Database Patterns/, "includes Database section");
    assert.match(result, /## Testing Guidelines/, "includes Testing section");
    assert.ok(!result.includes("## API Design"), "does not include API section");
  });
  test("no matches returns empty string", async () => {
    const result = await queryKnowledge(sampleKnowledge, ["nonexistent"]);
    assert.strictEqual(result, "", "no matches returns empty string per D020");
  });
  test("keyword in first paragraph matches", async () => {
    const result = await queryKnowledge(sampleKnowledge, ["sqlite"]);
    assert.match(result, /## Database Patterns/, "matches keyword in first paragraph");
    assert.match(result, /SQLite is used/, "includes the section with matching paragraph");
  });
  test("case-insensitive matching", async () => {
    const result = await queryKnowledge(sampleKnowledge, ["DATABASE", "API"]);
    assert.match(result, /## Database Patterns/, "case-insensitive header match");
    assert.match(result, /## API Design/, "case-insensitive header match for API");
  });
  test("empty keywords returns empty string", async () => {
    const result = await queryKnowledge(sampleKnowledge, []);
    assert.strictEqual(result, "", "empty keywords returns empty string");
  });
  test("empty content returns empty string", async () => {
    const result = await queryKnowledge("", ["database"]);
    assert.strictEqual(result, "", "empty content returns empty string");
  });
  test("single H2 with many H3 entries filters at H3 level (issue #4719)", async () => {
    const singleH2Knowledge = `# Project Knowledge

## Patterns

### Database: prepared statements
Always use prepared statements with SQLite.

### API: versioned paths
Use /v1/resource style versioning.

### Testing: node:test
Prefer node:test over external frameworks.

### Deployment: blue-green
Blue-green deployment for zero-downtime releases.
`;
    const result = await queryKnowledge(singleH2Knowledge, ["database"]);
    assert.match(result, /Database: prepared statements/, "includes matching H3 entry");
    assert.ok(
      !result.includes("API: versioned paths"),
      "does not include non-matching H3 entry"
    );
    assert.ok(
      !result.includes("Testing: node:test"),
      "does not include non-matching H3 entry"
    );
    assert.ok(
      !result.includes("Deployment: blue-green"),
      "does not include non-matching H3 entry"
    );
    assert.ok(
      result.length < singleH2Knowledge.length / 2,
      `scoped result (${result.length} chars) should be <50% of full content (${singleH2Knowledge.length} chars)`
    );
  });
  test("single H2 with H3 entries returns empty when no H3 matches (issue #4719)", async () => {
    const singleH2Knowledge = `# Project Knowledge

## Patterns

### Database: prepared statements
Always use prepared statements with SQLite.

### API: versioned paths
Use /v1/resource style versioning.
`;
    const result = await queryKnowledge(singleH2Knowledge, ["nonexistent"]);
    assert.strictEqual(result, "", "no H3 match returns empty string");
  });
  test("falls back to H2 when no H3 headings exist at all", async () => {
    const h2OnlyKnowledge = `# Project Knowledge

## Database Patterns
Use prepared statements.

## API Design
REST with OpenAPI.
`;
    const result = await queryKnowledge(h2OnlyKnowledge, ["database"]);
    assert.match(result, /Database Patterns/, "H2-only file falls back to H2 filtering");
    assert.ok(!result.includes("API Design"), "non-matching H2 section excluded");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9jb250ZXh0LXN0b3JlLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRC0yICsgY29udGV4dC1zdG9yZS50ZXN0LnRzIFx1MjAxNCBSZWdyZXNzaW9uIGNvdmVyYWdlIGZvciBEQi1iYWNrZWQgY29udGV4dCBxdWVyeSBoZWxwZXJzLlxuXG5pbXBvcnQgeyBkZXNjcmliZSwgdGVzdCwgYWZ0ZXJFYWNoIH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQge1xuICBvcGVuRGF0YWJhc2UsXG4gIGNsb3NlRGF0YWJhc2UsXG4gIGlzRGJBdmFpbGFibGUsXG4gIGluc2VydERlY2lzaW9uLFxuICBpbnNlcnRSZXF1aXJlbWVudCxcbiAgaW5zZXJ0QXJ0aWZhY3QsXG59IGZyb20gJy4uL2dzZC1kYi50cyc7XG5pbXBvcnQge1xuICBxdWVyeURlY2lzaW9ucyxcbiAgcXVlcnlSZXF1aXJlbWVudHMsXG4gIGZvcm1hdERlY2lzaW9uc0ZvclByb21wdCxcbiAgZm9ybWF0UmVxdWlyZW1lbnRzRm9yUHJvbXB0LFxuICBxdWVyeUFydGlmYWN0LFxuICBxdWVyeVByb2plY3QsXG4gIGZvcm1hdFJvYWRtYXBFeGNlcnB0LFxuICBxdWVyeUtub3dsZWRnZSxcbn0gZnJvbSAnLi4vY29udGV4dC1zdG9yZS50cyc7XG5cbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuLy8gY29udGV4dC1zdG9yZTogZmFsbGJhY2sgd2hlbiBEQiBub3Qgb3BlblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbmRlc2NyaWJlKFwiY29udGV4dC1zdG9yZTogZmFsbGJhY2sgd2hlbiBEQiBub3Qgb3BlblwiLCAoKSA9PiB7XG4gIHRlc3QoXCJyZXR1cm5zIGVtcHR5IHdoZW4gREIgbm90IG9wZW5cIiwgKCkgPT4ge1xuICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICBhc3NlcnQub2soIWlzRGJBdmFpbGFibGUoKSwgJ0RCIHNob3VsZCBub3QgYmUgYXZhaWxhYmxlJyk7XG5cbiAgICBjb25zdCBkID0gcXVlcnlEZWNpc2lvbnMoKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGQsIFtdLCAncXVlcnlEZWNpc2lvbnMgcmV0dXJucyBbXSB3aGVuIERCIGNsb3NlZCcpO1xuXG4gICAgY29uc3QgciA9IHF1ZXJ5UmVxdWlyZW1lbnRzKCk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyLCBbXSwgJ3F1ZXJ5UmVxdWlyZW1lbnRzIHJldHVybnMgW10gd2hlbiBEQiBjbG9zZWQnKTtcblxuICAgIGNvbnN0IGRmID0gcXVlcnlEZWNpc2lvbnMoeyBtaWxlc3RvbmVJZDogJ00wMDEnIH0pO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZGYsIFtdLCAncXVlcnlEZWNpc2lvbnMgd2l0aCBvcHRzIHJldHVybnMgW10gd2hlbiBEQiBjbG9zZWQnKTtcblxuICAgIGNvbnN0IHJmID0gcXVlcnlSZXF1aXJlbWVudHMoeyBzbGljZUlkOiAnUzAxJyB9KTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJmLCBbXSwgJ3F1ZXJ5UmVxdWlyZW1lbnRzIHdpdGggb3B0cyByZXR1cm5zIFtdIHdoZW4gREIgY2xvc2VkJyk7XG4gIH0pO1xufSk7XG5cbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuLy8gY29udGV4dC1zdG9yZTogcXVlcnkgZGVjaXNpb25zXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuZGVzY3JpYmUoXCJjb250ZXh0LXN0b3JlOiBxdWVyeSBkZWNpc2lvbnNcIiwgKCkgPT4ge1xuICBhZnRlckVhY2goKCkgPT4gY2xvc2VEYXRhYmFzZSgpKTtcblxuICB0ZXN0KFwicXVlcnkgYWxsIGFjdGl2ZSBkZWNpc2lvbnNcIiwgKCkgPT4ge1xuICAgIG9wZW5EYXRhYmFzZSgnOm1lbW9yeTonKTtcblxuICAgIGluc2VydERlY2lzaW9uKHtcbiAgICAgIGlkOiAnRDAwMScsIHdoZW5fY29udGV4dDogJ00wMDEvUzAxJywgc2NvcGU6ICdhcmNoaXRlY3R1cmUnLFxuICAgICAgZGVjaXNpb246ICd1c2UgU1FMaXRlJywgY2hvaWNlOiAnbm9kZTpzcWxpdGUnLCByYXRpb25hbGU6ICdidWlsdC1pbicsXG4gICAgICByZXZpc2FibGU6ICd5ZXMnLCBtYWRlX2J5OiAnYWdlbnQnLCBzdXBlcnNlZGVkX2J5OiAnRDAwMycsIC8vIHN1cGVyc2VkZWQhXG4gICAgfSk7XG4gICAgaW5zZXJ0RGVjaXNpb24oe1xuICAgICAgaWQ6ICdEMDAyJywgd2hlbl9jb250ZXh0OiAnTTAwMS9TMDEnLCBzY29wZTogJ2FyY2hpdGVjdHVyZScsXG4gICAgICBkZWNpc2lvbjogJ3VzZSBXQUwgbW9kZScsIGNob2ljZTogJ1dBTCcsIHJhdGlvbmFsZTogJ2NvbmN1cnJlbnQgcmVhZHMnLFxuICAgICAgcmV2aXNhYmxlOiAnbm8nLCBtYWRlX2J5OiAnYWdlbnQnLCBzdXBlcnNlZGVkX2J5OiBudWxsLFxuICAgIH0pO1xuICAgIGluc2VydERlY2lzaW9uKHtcbiAgICAgIGlkOiAnRDAwMycsIHdoZW5fY29udGV4dDogJ00wMDIvUzAxJywgc2NvcGU6ICdwZXJmb3JtYW5jZScsXG4gICAgICBkZWNpc2lvbjogJ3VzZSBiZXR0ZXItc3FsaXRlMycsIGNob2ljZTogJ2JldHRlci1zcWxpdGUzJywgcmF0aW9uYWxlOiAnZmFzdGVyJyxcbiAgICAgIHJldmlzYWJsZTogJ3llcycsIG1hZGVfYnk6ICdhZ2VudCcsIHN1cGVyc2VkZWRfYnk6IG51bGwsXG4gICAgfSk7XG5cbiAgICBjb25zdCBhbGwgPSBxdWVyeURlY2lzaW9ucygpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChhbGwubGVuZ3RoLCAyLCAncXVlcnkgYWxsIGFjdGl2ZSBkZWNpc2lvbnMgcmV0dXJucyAyIChzdXBlcnNlZGVkIGV4Y2x1ZGVkKScpO1xuICAgIGNvbnN0IGlkcyA9IGFsbC5tYXAoZCA9PiBkLmlkKTtcbiAgICBhc3NlcnQub2soaWRzLmluY2x1ZGVzKCdEMDAyJyksICdEMDAyIHNob3VsZCBiZSBpbiBhY3RpdmUgcmVzdWx0cycpO1xuICAgIGFzc2VydC5vayhpZHMuaW5jbHVkZXMoJ0QwMDMnKSwgJ0QwMDMgc2hvdWxkIGJlIGluIGFjdGl2ZSByZXN1bHRzJyk7XG4gICAgYXNzZXJ0Lm9rKCFpZHMuaW5jbHVkZXMoJ0QwMDEnKSwgJ0QwMDEgKHN1cGVyc2VkZWQpIHNob3VsZCBOT1QgYmUgaW4gYWN0aXZlIHJlc3VsdHMnKTtcbiAgfSk7XG5cbiAgdGVzdChcInF1ZXJ5IGRlY2lzaW9ucyBieSBtaWxlc3RvbmVcIiwgKCkgPT4ge1xuICAgIG9wZW5EYXRhYmFzZSgnOm1lbW9yeTonKTtcblxuICAgIGluc2VydERlY2lzaW9uKHtcbiAgICAgIGlkOiAnRDAwMScsIHdoZW5fY29udGV4dDogJ00wMDEvUzAxJywgc2NvcGU6ICdhcmNoaXRlY3R1cmUnLFxuICAgICAgZGVjaXNpb246ICdkZWNpc2lvbiBBJywgY2hvaWNlOiAnQScsIHJhdGlvbmFsZTogJ3InLCByZXZpc2FibGU6ICd5ZXMnLFxuICAgICAgbWFkZV9ieTogJ2FnZW50JyxcbiAgICAgIHN1cGVyc2VkZWRfYnk6IG51bGwsXG4gICAgfSk7XG4gICAgaW5zZXJ0RGVjaXNpb24oe1xuICAgICAgaWQ6ICdEMDAyJywgd2hlbl9jb250ZXh0OiAnTTAwMi9TMDInLCBzY29wZTogJ2FyY2hpdGVjdHVyZScsXG4gICAgICBkZWNpc2lvbjogJ2RlY2lzaW9uIEInLCBjaG9pY2U6ICdCJywgcmF0aW9uYWxlOiAncicsIHJldmlzYWJsZTogJ3llcycsXG4gICAgICBtYWRlX2J5OiAnYWdlbnQnLFxuICAgICAgc3VwZXJzZWRlZF9ieTogbnVsbCxcbiAgICB9KTtcblxuICAgIGNvbnN0IG0xID0gcXVlcnlEZWNpc2lvbnMoeyBtaWxlc3RvbmVJZDogJ00wMDEnIH0pO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChtMS5sZW5ndGgsIDEsICdtaWxlc3RvbmUgZmlsdGVyIE0wMDEgcmV0dXJucyAxJyk7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKG0xWzBdPy5pZCwgJ0QwMDEnLCAnbWlsZXN0b25lIGZpbHRlciByZXR1cm5zIEQwMDEnKTtcblxuICAgIGNvbnN0IG0yID0gcXVlcnlEZWNpc2lvbnMoeyBtaWxlc3RvbmVJZDogJ00wMDInIH0pO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChtMi5sZW5ndGgsIDEsICdtaWxlc3RvbmUgZmlsdGVyIE0wMDIgcmV0dXJucyAxJyk7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKG0yWzBdPy5pZCwgJ0QwMDInLCAnbWlsZXN0b25lIGZpbHRlciByZXR1cm5zIEQwMDInKTtcbiAgfSk7XG5cbiAgdGVzdChcInF1ZXJ5IGRlY2lzaW9ucyBieSBzY29wZVwiLCAoKSA9PiB7XG4gICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuXG4gICAgaW5zZXJ0RGVjaXNpb24oe1xuICAgICAgaWQ6ICdEMDAxJywgd2hlbl9jb250ZXh0OiAnTTAwMS9TMDEnLCBzY29wZTogJ2FyY2hpdGVjdHVyZScsXG4gICAgICBkZWNpc2lvbjogJ2RlY2lzaW9uIEEnLCBjaG9pY2U6ICdBJywgcmF0aW9uYWxlOiAncicsIHJldmlzYWJsZTogJ3llcycsXG4gICAgICBtYWRlX2J5OiAnYWdlbnQnLFxuICAgICAgc3VwZXJzZWRlZF9ieTogbnVsbCxcbiAgICB9KTtcbiAgICBpbnNlcnREZWNpc2lvbih7XG4gICAgICBpZDogJ0QwMDInLCB3aGVuX2NvbnRleHQ6ICdNMDAxL1MwMScsIHNjb3BlOiAncGVyZm9ybWFuY2UnLFxuICAgICAgZGVjaXNpb246ICdkZWNpc2lvbiBCJywgY2hvaWNlOiAnQicsIHJhdGlvbmFsZTogJ3InLCByZXZpc2FibGU6ICd5ZXMnLFxuICAgICAgbWFkZV9ieTogJ2FnZW50JyxcbiAgICAgIHN1cGVyc2VkZWRfYnk6IG51bGwsXG4gICAgfSk7XG5cbiAgICBjb25zdCBhcmNoID0gcXVlcnlEZWNpc2lvbnMoeyBzY29wZTogJ2FyY2hpdGVjdHVyZScgfSk7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKGFyY2gubGVuZ3RoLCAxLCAnc2NvcGUgZmlsdGVyIGFyY2hpdGVjdHVyZSByZXR1cm5zIDEnKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoYXJjaFswXT8uaWQsICdEMDAxJywgJ3Njb3BlIGZpbHRlciByZXR1cm5zIEQwMDEnKTtcblxuICAgIGNvbnN0IHBlcmYgPSBxdWVyeURlY2lzaW9ucyh7IHNjb3BlOiAncGVyZm9ybWFuY2UnIH0pO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChwZXJmLmxlbmd0aCwgMSwgJ3Njb3BlIGZpbHRlciBwZXJmb3JtYW5jZSByZXR1cm5zIDEnKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwocGVyZlswXT8uaWQsICdEMDAyJywgJ3Njb3BlIGZpbHRlciByZXR1cm5zIEQwMDInKTtcblxuICAgIGNvbnN0IG5vbmUgPSBxdWVyeURlY2lzaW9ucyh7IHNjb3BlOiAnbm9uZXhpc3RlbnQnIH0pO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChub25lLmxlbmd0aCwgMCwgJ3Njb3BlIGZpbHRlciBub25leGlzdGVudCByZXR1cm5zIDAnKTtcbiAgfSk7XG59KTtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBjb250ZXh0LXN0b3JlOiBxdWVyeSByZXF1aXJlbWVudHNcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG5kZXNjcmliZShcImNvbnRleHQtc3RvcmU6IHF1ZXJ5IHJlcXVpcmVtZW50c1wiLCAoKSA9PiB7XG4gIGFmdGVyRWFjaCgoKSA9PiBjbG9zZURhdGFiYXNlKCkpO1xuXG4gIHRlc3QoXCJxdWVyeSBhbGwgYWN0aXZlIHJlcXVpcmVtZW50c1wiLCAoKSA9PiB7XG4gICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuXG4gICAgaW5zZXJ0UmVxdWlyZW1lbnQoe1xuICAgICAgaWQ6ICdSMDAxJywgY2xhc3M6ICdmdW5jdGlvbmFsJywgc3RhdHVzOiAnYWN0aXZlJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAncmVxIEEnLCB3aHk6ICd3Jywgc291cmNlOiAnTTAwMScsIHByaW1hcnlfb3duZXI6ICdTMDEnLFxuICAgICAgc3VwcG9ydGluZ19zbGljZXM6ICdTMDInLCB2YWxpZGF0aW9uOiAndicsIG5vdGVzOiAnJywgZnVsbF9jb250ZW50OiAnJyxcbiAgICAgIHN1cGVyc2VkZWRfYnk6ICdSMDAzJywgLy8gc3VwZXJzZWRlZCFcbiAgICB9KTtcbiAgICBpbnNlcnRSZXF1aXJlbWVudCh7XG4gICAgICBpZDogJ1IwMDInLCBjbGFzczogJ25vbi1mdW5jdGlvbmFsJywgc3RhdHVzOiAnYWN0aXZlJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAncmVxIEInLCB3aHk6ICd3Jywgc291cmNlOiAnTTAwMScsIHByaW1hcnlfb3duZXI6ICdTMDEnLFxuICAgICAgc3VwcG9ydGluZ19zbGljZXM6ICcnLCB2YWxpZGF0aW9uOiAndicsIG5vdGVzOiAnJywgZnVsbF9jb250ZW50OiAnJyxcbiAgICAgIHN1cGVyc2VkZWRfYnk6IG51bGwsXG4gICAgfSk7XG4gICAgaW5zZXJ0UmVxdWlyZW1lbnQoe1xuICAgICAgaWQ6ICdSMDAzJywgY2xhc3M6ICdmdW5jdGlvbmFsJywgc3RhdHVzOiAndmFsaWRhdGVkJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAncmVxIEMnLCB3aHk6ICd3Jywgc291cmNlOiAnTTAwMScsIHByaW1hcnlfb3duZXI6ICdTMDInLFxuICAgICAgc3VwcG9ydGluZ19zbGljZXM6ICdTMDEnLCB2YWxpZGF0aW9uOiAndicsIG5vdGVzOiAnJywgZnVsbF9jb250ZW50OiAnJyxcbiAgICAgIHN1cGVyc2VkZWRfYnk6IG51bGwsXG4gICAgfSk7XG5cbiAgICBjb25zdCBhbGwgPSBxdWVyeVJlcXVpcmVtZW50cygpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChhbGwubGVuZ3RoLCAyLCAncXVlcnkgYWxsIGFjdGl2ZSByZXF1aXJlbWVudHMgcmV0dXJucyAyIChzdXBlcnNlZGVkIGV4Y2x1ZGVkKScpO1xuICAgIGNvbnN0IGlkcyA9IGFsbC5tYXAociA9PiByLmlkKTtcbiAgICBhc3NlcnQub2soaWRzLmluY2x1ZGVzKCdSMDAyJyksICdSMDAyIHNob3VsZCBiZSBhY3RpdmUnKTtcbiAgICBhc3NlcnQub2soaWRzLmluY2x1ZGVzKCdSMDAzJyksICdSMDAzIHNob3VsZCBiZSBhY3RpdmUnKTtcbiAgICBhc3NlcnQub2soIWlkcy5pbmNsdWRlcygnUjAwMScpLCAnUjAwMSAoc3VwZXJzZWRlZCkgc2hvdWxkIE5PVCBiZSBhY3RpdmUnKTtcbiAgfSk7XG5cbiAgdGVzdChcInF1ZXJ5IHJlcXVpcmVtZW50cyBieSBzbGljZVwiLCAoKSA9PiB7XG4gICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuXG4gICAgaW5zZXJ0UmVxdWlyZW1lbnQoe1xuICAgICAgaWQ6ICdSMDAxJywgY2xhc3M6ICdmdW5jdGlvbmFsJywgc3RhdHVzOiAnYWN0aXZlJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAncmVxIEEnLCB3aHk6ICd3Jywgc291cmNlOiAnTTAwMScsIHByaW1hcnlfb3duZXI6ICdTMDEnLFxuICAgICAgc3VwcG9ydGluZ19zbGljZXM6ICcnLCB2YWxpZGF0aW9uOiAndicsIG5vdGVzOiAnJywgZnVsbF9jb250ZW50OiAnJyxcbiAgICAgIHN1cGVyc2VkZWRfYnk6IG51bGwsXG4gICAgfSk7XG4gICAgaW5zZXJ0UmVxdWlyZW1lbnQoe1xuICAgICAgaWQ6ICdSMDAyJywgY2xhc3M6ICdmdW5jdGlvbmFsJywgc3RhdHVzOiAnYWN0aXZlJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAncmVxIEInLCB3aHk6ICd3Jywgc291cmNlOiAnTTAwMScsIHByaW1hcnlfb3duZXI6ICdTMDInLFxuICAgICAgc3VwcG9ydGluZ19zbGljZXM6ICdTMDEnLCB2YWxpZGF0aW9uOiAndicsIG5vdGVzOiAnJywgZnVsbF9jb250ZW50OiAnJyxcbiAgICAgIHN1cGVyc2VkZWRfYnk6IG51bGwsXG4gICAgfSk7XG4gICAgaW5zZXJ0UmVxdWlyZW1lbnQoe1xuICAgICAgaWQ6ICdSMDAzJywgY2xhc3M6ICdmdW5jdGlvbmFsJywgc3RhdHVzOiAnYWN0aXZlJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAncmVxIEMnLCB3aHk6ICd3Jywgc291cmNlOiAnTTAwMScsIHByaW1hcnlfb3duZXI6ICdTMDMnLFxuICAgICAgc3VwcG9ydGluZ19zbGljZXM6ICcnLCB2YWxpZGF0aW9uOiAndicsIG5vdGVzOiAnJywgZnVsbF9jb250ZW50OiAnJyxcbiAgICAgIHN1cGVyc2VkZWRfYnk6IG51bGwsXG4gICAgfSk7XG5cbiAgICBjb25zdCBzMDEgPSBxdWVyeVJlcXVpcmVtZW50cyh7IHNsaWNlSWQ6ICdTMDEnIH0pO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChzMDEubGVuZ3RoLCAyLCAnc2xpY2UgZmlsdGVyIFMwMSByZXR1cm5zIDIgKHByaW1hcnkgKyBzdXBwb3J0aW5nKScpO1xuICAgIGNvbnN0IHMwMWlkcyA9IHMwMS5tYXAociA9PiByLmlkKS5zb3J0KCk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzMDFpZHMsIFsnUjAwMScsICdSMDAyJ10sICdTMDEgb3ducyBSMDAxIGFuZCBzdXBwb3J0cyBSMDAyJyk7XG5cbiAgICBjb25zdCBzMDMgPSBxdWVyeVJlcXVpcmVtZW50cyh7IHNsaWNlSWQ6ICdTMDMnIH0pO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChzMDMubGVuZ3RoLCAxLCAnc2xpY2UgZmlsdGVyIFMwMyByZXR1cm5zIDEnKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoczAzWzBdPy5pZCwgJ1IwMDMnLCAnUzAzIG93bnMgUjAwMycpO1xuICB9KTtcblxuICB0ZXN0KFwicXVlcnkgcmVxdWlyZW1lbnRzIGJ5IHN0YXR1c1wiLCAoKSA9PiB7XG4gICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuXG4gICAgaW5zZXJ0UmVxdWlyZW1lbnQoe1xuICAgICAgaWQ6ICdSMDAxJywgY2xhc3M6ICdmdW5jdGlvbmFsJywgc3RhdHVzOiAnYWN0aXZlJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAncmVxIEEnLCB3aHk6ICd3Jywgc291cmNlOiAnTTAwMScsIHByaW1hcnlfb3duZXI6ICdTMDEnLFxuICAgICAgc3VwcG9ydGluZ19zbGljZXM6ICcnLCB2YWxpZGF0aW9uOiAndicsIG5vdGVzOiAnJywgZnVsbF9jb250ZW50OiAnJyxcbiAgICAgIHN1cGVyc2VkZWRfYnk6IG51bGwsXG4gICAgfSk7XG4gICAgaW5zZXJ0UmVxdWlyZW1lbnQoe1xuICAgICAgaWQ6ICdSMDAyJywgY2xhc3M6ICdmdW5jdGlvbmFsJywgc3RhdHVzOiAndmFsaWRhdGVkJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAncmVxIEInLCB3aHk6ICd3Jywgc291cmNlOiAnTTAwMScsIHByaW1hcnlfb3duZXI6ICdTMDEnLFxuICAgICAgc3VwcG9ydGluZ19zbGljZXM6ICcnLCB2YWxpZGF0aW9uOiAndicsIG5vdGVzOiAnJywgZnVsbF9jb250ZW50OiAnJyxcbiAgICAgIHN1cGVyc2VkZWRfYnk6IG51bGwsXG4gICAgfSk7XG4gICAgaW5zZXJ0UmVxdWlyZW1lbnQoe1xuICAgICAgaWQ6ICdSMDAzJywgY2xhc3M6ICdmdW5jdGlvbmFsJywgc3RhdHVzOiAnZGVmZXJyZWQnLFxuICAgICAgZGVzY3JpcHRpb246ICdyZXEgQycsIHdoeTogJ3cnLCBzb3VyY2U6ICdNMDAxJywgcHJpbWFyeV9vd25lcjogJ1MwMScsXG4gICAgICBzdXBwb3J0aW5nX3NsaWNlczogJycsIHZhbGlkYXRpb246ICd2Jywgbm90ZXM6ICcnLCBmdWxsX2NvbnRlbnQ6ICcnLFxuICAgICAgc3VwZXJzZWRlZF9ieTogbnVsbCxcbiAgICB9KTtcblxuICAgIGNvbnN0IGFjdGl2ZSA9IHF1ZXJ5UmVxdWlyZW1lbnRzKHsgc3RhdHVzOiAnYWN0aXZlJyB9KTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoYWN0aXZlLmxlbmd0aCwgMSwgJ3N0YXR1cyBmaWx0ZXIgYWN0aXZlIHJldHVybnMgMScpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChhY3RpdmVbMF0/LmlkLCAnUjAwMScsICdhY3RpdmUgcmV0dXJucyBSMDAxJyk7XG5cbiAgICBjb25zdCB2YWxpZGF0ZWQgPSBxdWVyeVJlcXVpcmVtZW50cyh7IHN0YXR1czogJ3ZhbGlkYXRlZCcgfSk7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHZhbGlkYXRlZC5sZW5ndGgsIDEsICdzdGF0dXMgZmlsdGVyIHZhbGlkYXRlZCByZXR1cm5zIDEnKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwodmFsaWRhdGVkWzBdPy5pZCwgJ1IwMDInLCAndmFsaWRhdGVkIHJldHVybnMgUjAwMicpO1xuICB9KTtcbn0pO1xuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIGNvbnRleHQtc3RvcmU6IGZvcm1hdCBkZWNpc2lvbnNcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG5kZXNjcmliZShcImNvbnRleHQtc3RvcmU6IGZvcm1hdERlY2lzaW9uc0ZvclByb21wdFwiLCAoKSA9PiB7XG4gIHRlc3QoXCJlbXB0eSBpbnB1dCByZXR1cm5zIGVtcHR5IHN0cmluZ1wiLCAoKSA9PiB7XG4gICAgY29uc3QgZW1wdHkgPSBmb3JtYXREZWNpc2lvbnNGb3JQcm9tcHQoW10pO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChlbXB0eSwgJycsICdlbXB0eSBpbnB1dCByZXR1cm5zIGVtcHR5IHN0cmluZycpO1xuICB9KTtcblxuICB0ZXN0KFwiZm9ybWF0cyBkZWNpc2lvbnMgYXMgbWFya2Rvd24gdGFibGVcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGZvcm1hdERlY2lzaW9uc0ZvclByb21wdChbXG4gICAgICB7XG4gICAgICAgIHNlcTogMSwgaWQ6ICdEMDAxJywgd2hlbl9jb250ZXh0OiAnTTAwMS9TMDEnLCBzY29wZTogJ2FyY2hpdGVjdHVyZScsXG4gICAgICAgIGRlY2lzaW9uOiAndXNlIFNRTGl0ZScsIGNob2ljZTogJ25vZGU6c3FsaXRlJywgcmF0aW9uYWxlOiAnYnVpbHQtaW4nLFxuICAgICAgICByZXZpc2FibGU6ICd5ZXMnLCBtYWRlX2J5OiAnYWdlbnQnLCBzdXBlcnNlZGVkX2J5OiBudWxsLFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgc2VxOiAyLCBpZDogJ0QwMDInLCB3aGVuX2NvbnRleHQ6ICdNMDAxL1MwMicsIHNjb3BlOiAncGVyZm9ybWFuY2UnLFxuICAgICAgICBkZWNpc2lvbjogJ3VzZSBXQUwnLCBjaG9pY2U6ICdXQUwnLCByYXRpb25hbGU6ICdjb25jdXJyZW50JyxcbiAgICAgICAgcmV2aXNhYmxlOiAnbm8nLCBtYWRlX2J5OiAnaHVtYW4nLCBzdXBlcnNlZGVkX2J5OiBudWxsLFxuICAgICAgfSxcbiAgICBdKTtcblxuICAgIC8vIFNob3VsZCBiZSBhIG1hcmtkb3duIHRhYmxlXG4gICAgYXNzZXJ0Lm1hdGNoKHJlc3VsdCwgL15cXHwgIyBcXHwgV2hlbiBcXHwgU2NvcGUvLCAnaGFzIHRhYmxlIGhlYWRlcicpO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQsIC9cXHwtLS1cXHwvLCAnaGFzIHNlcGFyYXRvciByb3cnKTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LCAvXFx8IEQwMDEgXFx8LywgJ2hhcyBEMDAxIHJvdycpO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQsIC9cXHwgRDAwMiBcXHwvLCAnaGFzIEQwMDIgcm93Jyk7XG4gICAgY29uc3QgbGluZXMgPSByZXN1bHQuc3BsaXQoJ1xcbicpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChsaW5lcy5sZW5ndGgsIDQsICd0YWJsZSBoYXMgNCBsaW5lcyAoaGVhZGVyICsgc2VwYXJhdG9yICsgMiByb3dzKScpO1xuICB9KTtcbn0pO1xuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIGNvbnRleHQtc3RvcmU6IGZvcm1hdCByZXF1aXJlbWVudHNcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG5kZXNjcmliZShcImNvbnRleHQtc3RvcmU6IGZvcm1hdFJlcXVpcmVtZW50c0ZvclByb21wdFwiLCAoKSA9PiB7XG4gIHRlc3QoXCJlbXB0eSBpbnB1dCByZXR1cm5zIGVtcHR5IHN0cmluZ1wiLCAoKSA9PiB7XG4gICAgY29uc3QgZW1wdHkgPSBmb3JtYXRSZXF1aXJlbWVudHNGb3JQcm9tcHQoW10pO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChlbXB0eSwgJycsICdlbXB0eSBpbnB1dCByZXR1cm5zIGVtcHR5IHN0cmluZycpO1xuICB9KTtcblxuICB0ZXN0KFwiZm9ybWF0cyByZXF1aXJlbWVudHMgYXMgbWFya2Rvd24gc2VjdGlvbnNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGZvcm1hdFJlcXVpcmVtZW50c0ZvclByb21wdChbXG4gICAgICB7XG4gICAgICAgIGlkOiAnUjAwMScsIGNsYXNzOiAnZnVuY3Rpb25hbCcsIHN0YXR1czogJ2FjdGl2ZScsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnU3lzdGVtIG11c3QgcGVyc2lzdCBkZWNpc2lvbnMnLCB3aHk6ICdhZ2VudCBtZW1vcnknLFxuICAgICAgICBzb3VyY2U6ICdNMDAxJywgcHJpbWFyeV9vd25lcjogJ1MwMScsIHN1cHBvcnRpbmdfc2xpY2VzOiAnUzAyJyxcbiAgICAgICAgdmFsaWRhdGlvbjogJ3JvdW5kdHJpcCB0ZXN0Jywgbm90ZXM6ICdoaWdoIHByaW9yaXR5JyxcbiAgICAgICAgZnVsbF9jb250ZW50OiAnJywgc3VwZXJzZWRlZF9ieTogbnVsbCxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIGlkOiAnUjAwMicsIGNsYXNzOiAnbm9uLWZ1bmN0aW9uYWwnLCBzdGF0dXM6ICdhY3RpdmUnLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ1N1Yi01bXMgcXVlcnkgbGF0ZW5jeScsIHdoeTogJ3Byb21wdCBpbmplY3Rpb24gc3BlZWQnLFxuICAgICAgICBzb3VyY2U6ICdNMDAxJywgcHJpbWFyeV9vd25lcjogJ1MwMScsIHN1cHBvcnRpbmdfc2xpY2VzOiAnJyxcbiAgICAgICAgdmFsaWRhdGlvbjogJ3RpbWluZyB0ZXN0Jywgbm90ZXM6ICcnLFxuICAgICAgICBmdWxsX2NvbnRlbnQ6ICcnLCBzdXBlcnNlZGVkX2J5OiBudWxsLFxuICAgICAgfSxcbiAgICBdKTtcblxuICAgIGFzc2VydC5tYXRjaChyZXN1bHQsIC8jIyMgUjAwMTogU3lzdGVtIG11c3QgcGVyc2lzdCBkZWNpc2lvbnMvLCAnaGFzIFIwMDEgc2VjdGlvbiBoZWFkZXInKTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LCAvIyMjIFIwMDI6IFN1Yi01bXMgcXVlcnkgbGF0ZW5jeS8sICdoYXMgUjAwMiBzZWN0aW9uIGhlYWRlcicpO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQsIC9cXCpcXCpDbGFzczpcXCpcXCogZnVuY3Rpb25hbC8sICdoYXMgY2xhc3MgZmllbGQnKTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LCAvXFwqXFwqU3RhdHVzOlxcKlxcKiBhY3RpdmUvLCAnaGFzIHN0YXR1cyBmaWVsZCcpO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQsIC9cXCpcXCpTdXBwb3J0aW5nIFNsaWNlczpcXCpcXCogUzAyLywgJ2hhcyBzdXBwb3J0aW5nIHNsaWNlcyB3aGVuIHByZXNlbnQnKTtcbiAgICAvLyBSMDAyIGhhcyBubyBzdXBwb3J0aW5nX3NsaWNlcyBcdTIwMTQgc2hvdWxkIG5vdCBoYXZlIHRoYXQgbGluZVxuICAgIC8vIFIwMDIgaGFzIG5vIG5vdGVzIFx1MjAxNCBzaG91bGQgbm90IGhhdmUgbm90ZXMgbGluZVxuICAgIGNvbnN0IHIwMDJTZWN0aW9uID0gcmVzdWx0LnNwbGl0KCcjIyMgUjAwMicpWzFdIHx8ICcnO1xuICAgIGFzc2VydC5vayghcjAwMlNlY3Rpb24uaW5jbHVkZXMoJyoqU3VwcG9ydGluZyBTbGljZXM6KionKSwgJ25vIHN1cHBvcnRpbmcgc2xpY2VzIGxpbmUgd2hlbiBlbXB0eScpO1xuICAgIGFzc2VydC5vayghcjAwMlNlY3Rpb24uaW5jbHVkZXMoJyoqTm90ZXM6KionKSwgJ25vIG5vdGVzIGxpbmUgd2hlbiBlbXB0eScpO1xuICB9KTtcbn0pO1xuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIGNvbnRleHQtc3RvcmU6IHN1Yi01bXMgdGltaW5nIGFzc2VydGlvblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbmRlc2NyaWJlKFwiY29udGV4dC1zdG9yZTogc3ViLTVtcyBxdWVyeSB0aW1pbmdcIiwgKCkgPT4ge1xuICBhZnRlckVhY2goKCkgPT4gY2xvc2VEYXRhYmFzZSgpKTtcblxuICB0ZXN0KFwicXVlcmllcyBjb21wbGV0ZSB1bmRlciA1bXMgZm9yIDUwKzUwIHJvd3NcIiwgKCkgPT4ge1xuICAgIG9wZW5EYXRhYmFzZSgnOm1lbW9yeTonKTtcblxuICAgIC8vIEluc2VydCA1MCBkZWNpc2lvbnNcbiAgICBmb3IgKGxldCBpID0gMTsgaSA8PSA1MDsgaSsrKSB7XG4gICAgICBjb25zdCBpZCA9IGBEJHtTdHJpbmcoaSkucGFkU3RhcnQoMywgJzAnKX1gO1xuICAgICAgaW5zZXJ0RGVjaXNpb24oe1xuICAgICAgICBpZCxcbiAgICAgICAgd2hlbl9jb250ZXh0OiBgTTAwJHsoaSAlIDMpICsgMX0vUzAkeyhpICUgNSkgKyAxfWAsXG4gICAgICAgIHNjb3BlOiBpICUgMiA9PT0gMCA/ICdhcmNoaXRlY3R1cmUnIDogJ3BlcmZvcm1hbmNlJyxcbiAgICAgICAgZGVjaXNpb246IGBkZWNpc2lvbiAke2l9YCxcbiAgICAgICAgY2hvaWNlOiBgY2hvaWNlICR7aX1gLFxuICAgICAgICByYXRpb25hbGU6IGByYXRpb25hbGUgJHtpfWAsXG4gICAgICAgIHJldmlzYWJsZTogaSAlIDMgPT09IDAgPyAnbm8nIDogJ3llcycsXG4gICAgICAgIG1hZGVfYnk6ICdhZ2VudCcsXG4gICAgICAgIHN1cGVyc2VkZWRfYnk6IG51bGwsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyBJbnNlcnQgNTAgcmVxdWlyZW1lbnRzXG4gICAgZm9yIChsZXQgaSA9IDE7IGkgPD0gNTA7IGkrKykge1xuICAgICAgY29uc3QgaWQgPSBgUiR7U3RyaW5nKGkpLnBhZFN0YXJ0KDMsICcwJyl9YDtcbiAgICAgIGluc2VydFJlcXVpcmVtZW50KHtcbiAgICAgICAgaWQsXG4gICAgICAgIGNsYXNzOiBpICUgMiA9PT0gMCA/ICdmdW5jdGlvbmFsJyA6ICdub24tZnVuY3Rpb25hbCcsXG4gICAgICAgIHN0YXR1czogaSAlIDQgPT09IDAgPyAndmFsaWRhdGVkJyA6ICdhY3RpdmUnLFxuICAgICAgICBkZXNjcmlwdGlvbjogYHJlcXVpcmVtZW50ICR7aX1gLFxuICAgICAgICB3aHk6IGB3aHkgJHtpfWAsXG4gICAgICAgIHNvdXJjZTogJ00wMDEnLFxuICAgICAgICBwcmltYXJ5X293bmVyOiBgUzAkeyhpICUgNSkgKyAxfWAsXG4gICAgICAgIHN1cHBvcnRpbmdfc2xpY2VzOiBpICUgMyA9PT0gMCA/ICdTMDEsIFMwMicgOiAnJyxcbiAgICAgICAgdmFsaWRhdGlvbjogYHZhbGlkYXRpb24gJHtpfWAsXG4gICAgICAgIG5vdGVzOiAnJyxcbiAgICAgICAgZnVsbF9jb250ZW50OiAnJyxcbiAgICAgICAgc3VwZXJzZWRlZF9ieTogbnVsbCxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIFRpbWUgdGhlIHF1ZXJpZXMgXHUyMDE0IHdhcm0gdXAgZmlyc3RcbiAgICBxdWVyeURlY2lzaW9ucygpO1xuICAgIHF1ZXJ5UmVxdWlyZW1lbnRzKCk7XG5cbiAgICBjb25zdCBzdGFydCA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICAgIGNvbnN0IGRlY2lzaW9ucyA9IHF1ZXJ5RGVjaXNpb25zKCk7XG4gICAgY29uc3QgcmVxdWlyZW1lbnRzID0gcXVlcnlSZXF1aXJlbWVudHMoKTtcbiAgICBjb25zdCBlbGFwc2VkID0gcGVyZm9ybWFuY2Uubm93KCkgLSBzdGFydDtcblxuICAgIGFzc2VydC5zdHJpY3RFcXVhbChkZWNpc2lvbnMubGVuZ3RoLCA1MCwgYGdvdCAke2RlY2lzaW9ucy5sZW5ndGh9IGRlY2lzaW9ucyAoZXhwZWN0ZWQgNTApYCk7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlcXVpcmVtZW50cy5sZW5ndGgsIDUwLCBgZ290ICR7cmVxdWlyZW1lbnRzLmxlbmd0aH0gcmVxdWlyZW1lbnRzIChleHBlY3RlZCA1MClgKTtcbiAgICBjb25zdCBtYXhMYXRlbmN5TXMgPSBwcm9jZXNzLmVudi5OT0RFX1Y4X0NPVkVSQUdFID8gMTUgOiA1O1xuICAgIGFzc2VydC5vayhcbiAgICAgIGVsYXBzZWQgPCBtYXhMYXRlbmN5TXMsXG4gICAgICBgcXVlcnkgbGF0ZW5jeSAke2VsYXBzZWQudG9GaXhlZCgyKX1tcyBzaG91bGQgYmUgPCAke21heExhdGVuY3lNc31tc2AsXG4gICAgKTtcbiAgfSk7XG59KTtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBjb250ZXh0LXN0b3JlOiBxdWVyeUFydGlmYWN0XG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuZGVzY3JpYmUoXCJjb250ZXh0LXN0b3JlOiBxdWVyeUFydGlmYWN0XCIsICgpID0+IHtcbiAgYWZ0ZXJFYWNoKCgpID0+IGNsb3NlRGF0YWJhc2UoKSk7XG5cbiAgdGVzdChcInJldHVybnMgY29udGVudCBmb3IgZXhpc3RpbmcgcGF0aFwiLCAoKSA9PiB7XG4gICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuXG4gICAgaW5zZXJ0QXJ0aWZhY3Qoe1xuICAgICAgcGF0aDogJ1BST0pFQ1QubWQnLFxuICAgICAgYXJ0aWZhY3RfdHlwZTogJ3Byb2plY3QnLFxuICAgICAgbWlsZXN0b25lX2lkOiBudWxsLFxuICAgICAgc2xpY2VfaWQ6IG51bGwsXG4gICAgICB0YXNrX2lkOiBudWxsLFxuICAgICAgZnVsbF9jb250ZW50OiAnIyBNeSBQcm9qZWN0XFxuXFxuUHJvamVjdCBkZXNjcmlwdGlvbiBoZXJlLicsXG4gICAgfSk7XG4gICAgaW5zZXJ0QXJ0aWZhY3Qoe1xuICAgICAgcGF0aDogJy5nc2QvbWlsZXN0b25lcy9NMDAxL00wMDEtUExBTi5tZCcsXG4gICAgICBhcnRpZmFjdF90eXBlOiAnbWlsZXN0b25lX3BsYW4nLFxuICAgICAgbWlsZXN0b25lX2lkOiAnTTAwMScsXG4gICAgICBzbGljZV9pZDogbnVsbCxcbiAgICAgIHRhc2tfaWQ6IG51bGwsXG4gICAgICBmdWxsX2NvbnRlbnQ6ICcjIE0wMDEgUGxhblxcblxcbk1pbGVzdG9uZSBjb250ZW50LicsXG4gICAgfSk7XG5cbiAgICBjb25zdCBwcm9qZWN0ID0gcXVlcnlBcnRpZmFjdCgnUFJPSkVDVC5tZCcpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChwcm9qZWN0LCAnIyBNeSBQcm9qZWN0XFxuXFxuUHJvamVjdCBkZXNjcmlwdGlvbiBoZXJlLicsICdxdWVyeUFydGlmYWN0IHJldHVybnMgZnVsbF9jb250ZW50IGZvciBQUk9KRUNULm1kJyk7XG5cbiAgICBjb25zdCBwbGFuID0gcXVlcnlBcnRpZmFjdCgnLmdzZC9taWxlc3RvbmVzL00wMDEvTTAwMS1QTEFOLm1kJyk7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHBsYW4sICcjIE0wMDEgUGxhblxcblxcbk1pbGVzdG9uZSBjb250ZW50LicsICdxdWVyeUFydGlmYWN0IHJldHVybnMgZnVsbF9jb250ZW50IGZvciBtaWxlc3RvbmUgcGxhbicpO1xuICB9KTtcblxuICB0ZXN0KFwicmV0dXJucyBudWxsIGZvciBtaXNzaW5nIHBhdGhcIiwgKCkgPT4ge1xuICAgIG9wZW5EYXRhYmFzZSgnOm1lbW9yeTonKTtcblxuICAgIGNvbnN0IG1pc3NpbmcgPSBxdWVyeUFydGlmYWN0KCdub25leGlzdGVudC5tZCcpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChtaXNzaW5nLCBudWxsLCAncXVlcnlBcnRpZmFjdCByZXR1cm5zIG51bGwgZm9yIHBhdGggbm90IGluIERCJyk7XG4gIH0pO1xuXG4gIHRlc3QoXCJyZXR1cm5zIG51bGwgd2hlbiBEQiB1bmF2YWlsYWJsZVwiLCAoKSA9PiB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIGFzc2VydC5vayghaXNEYkF2YWlsYWJsZSgpLCAnREIgc2hvdWxkIG5vdCBiZSBhdmFpbGFibGUnKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IHF1ZXJ5QXJ0aWZhY3QoJ1BST0pFQ1QubWQnKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LCBudWxsLCAncXVlcnlBcnRpZmFjdCByZXR1cm5zIG51bGwgd2hlbiBEQiBjbG9zZWQnKTtcbiAgfSk7XG59KTtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBjb250ZXh0LXN0b3JlOiBxdWVyeVByb2plY3Rcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG5kZXNjcmliZShcImNvbnRleHQtc3RvcmU6IHF1ZXJ5UHJvamVjdFwiLCAoKSA9PiB7XG4gIGFmdGVyRWFjaCgoKSA9PiBjbG9zZURhdGFiYXNlKCkpO1xuXG4gIHRlc3QoXCJyZXR1cm5zIFBST0pFQ1QubWQgY29udGVudFwiLCAoKSA9PiB7XG4gICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuXG4gICAgaW5zZXJ0QXJ0aWZhY3Qoe1xuICAgICAgcGF0aDogJ1BST0pFQ1QubWQnLFxuICAgICAgYXJ0aWZhY3RfdHlwZTogJ3Byb2plY3QnLFxuICAgICAgbWlsZXN0b25lX2lkOiBudWxsLFxuICAgICAgc2xpY2VfaWQ6IG51bGwsXG4gICAgICB0YXNrX2lkOiBudWxsLFxuICAgICAgZnVsbF9jb250ZW50OiAnIyBUZXN0IFByb2plY3RcXG5cXG5UaGlzIGlzIHRoZSBwcm9qZWN0IGRlc2NyaXB0aW9uLicsXG4gICAgfSk7XG5cbiAgICBjb25zdCBjb250ZW50ID0gcXVlcnlQcm9qZWN0KCk7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKGNvbnRlbnQsICcjIFRlc3QgUHJvamVjdFxcblxcblRoaXMgaXMgdGhlIHByb2plY3QgZGVzY3JpcHRpb24uJywgJ3F1ZXJ5UHJvamVjdCByZXR1cm5zIFBST0pFQ1QubWQgY29udGVudCcpO1xuICB9KTtcblxuICB0ZXN0KFwicmV0dXJucyBudWxsIHdoZW4gbm8gUFJPSkVDVC5tZFwiLCAoKSA9PiB7XG4gICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuXG4gICAgY29uc3QgY29udGVudCA9IHF1ZXJ5UHJvamVjdCgpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChjb250ZW50LCBudWxsLCAncXVlcnlQcm9qZWN0IHJldHVybnMgbnVsbCB3aGVuIFBST0pFQ1QubWQgbm90IGltcG9ydGVkJyk7XG4gIH0pO1xuXG4gIHRlc3QoXCJyZXR1cm5zIG51bGwgd2hlbiBEQiB1bmF2YWlsYWJsZVwiLCAoKSA9PiB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIGFzc2VydC5vayghaXNEYkF2YWlsYWJsZSgpLCAnREIgc2hvdWxkIG5vdCBiZSBhdmFpbGFibGUnKTtcblxuICAgIGNvbnN0IGNvbnRlbnQgPSBxdWVyeVByb2plY3QoKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoY29udGVudCwgbnVsbCwgJ3F1ZXJ5UHJvamVjdCByZXR1cm5zIG51bGwgd2hlbiBEQiBjbG9zZWQnKTtcbiAgfSk7XG59KTtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBjb250ZXh0LXN0b3JlOiBmb3JtYXRSb2FkbWFwRXhjZXJwdFxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbmRlc2NyaWJlKFwiY29udGV4dC1zdG9yZTogZm9ybWF0Um9hZG1hcEV4Y2VycHRcIiwgKCkgPT4ge1xuICAvLyBTYW1wbGUgcm9hZG1hcCBjb250ZW50IG1hdGNoaW5nIGFjdHVhbCBNMDA1LVJPQURNQVAubWQgZm9ybWF0XG4gIGNvbnN0IHNhbXBsZVJvYWRtYXAgPSBgIyBNMDA1OiBUaWVyZWQgQ29udGV4dCBJbmplY3Rpb25cblxuIyMgVmlzaW9uXG5SZWZhY3RvciBwcm9tcHQgYnVpbGRlcnMgdG8gaW5qZWN0IHJlbGV2YW5jZS1zY29wZWQgY29udGV4dC5cblxuIyMgU2xpY2UgT3ZlcnZpZXdcbnwgSUQgfCBTbGljZSB8IFJpc2sgfCBEZXBlbmRzIHwgRG9uZSB8IEFmdGVyIHRoaXMgfFxufC0tLS18LS0tLS0tLXwtLS0tLS18LS0tLS0tLS0tfC0tLS0tLXwtLS0tLS0tLS0tLS18XG58IFMwMSB8IFNjb3BlIGV4aXN0aW5nIHF1ZXJpZXMgfCBsb3cgfCBcdTIwMTQgfCBcdTI3MDUgfCBwbGFuU2xpY2UgcHJvbXB0IHNjb3BlZC4gfFxufCBTMDIgfCBLTk9XTEVER0Ugc2NvcGluZyB8IG1lZGl1bSB8IFMwMSB8IFx1MkIxQyB8IEtOT1dMRURHRSBzZWN0aW9ucyBmaWx0ZXJlZC4gfFxufCBTMDMgfCBNZWFzdXJlbWVudCB0ZXN0IHwgbG93IHwgUzAyIHwgXHUyQjFDIHwgNDAlIHJlZHVjdGlvbiBjb25maXJtZWQuIHxcbmA7XG5cbiAgdGVzdChcIlMwMiB3aXRoIFMwMSBwcmVkZWNlc3NvciBpbmNsdWRlcyBib3RoIHJvd3NcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGZvcm1hdFJvYWRtYXBFeGNlcnB0KHNhbXBsZVJvYWRtYXAsICdTMDInLCAnLmdzZC9taWxlc3RvbmVzL00wMDUvTTAwNS1ST0FETUFQLm1kJyk7XG5cbiAgICAvLyBTaG91bGQgaGF2ZSBoZWFkZXJcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LCAvXFx8IElEIFxcfCBTbGljZSBcXHwgUmlzayBcXHwgRGVwZW5kcyBcXHwgRG9uZSBcXHwgQWZ0ZXIgdGhpcyBcXHwvLCAnaGFzIGhlYWRlciByb3cnKTtcbiAgICAvLyBTaG91bGQgaGF2ZSBzZXBhcmF0b3JcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LCAvXFx8LS0tLVxcfC8sICdoYXMgc2VwYXJhdG9yIHJvdycpO1xuICAgIC8vIFNob3VsZCBoYXZlIFMwMSBwcmVkZWNlc3NvclxuICAgIGFzc2VydC5tYXRjaChyZXN1bHQsIC9cXHwgUzAxIFxcfC8sICdoYXMgcHJlZGVjZXNzb3IgUzAxIHJvdycpO1xuICAgIC8vIFNob3VsZCBoYXZlIFMwMiB0YXJnZXRcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LCAvXFx8IFMwMiBcXHwvLCAnaGFzIHRhcmdldCBTMDIgcm93Jyk7XG4gICAgLy8gU2hvdWxkIGhhdmUgcmVmZXJlbmNlIGRpcmVjdGl2ZVxuICAgIGFzc2VydC5tYXRjaChyZXN1bHQsIC9TZWUgZnVsbCByb2FkbWFwOi4qTTAwNS1ST0FETUFQXFwubWQvLCAnaGFzIHJlZmVyZW5jZSBkaXJlY3RpdmUnKTtcbiAgICAvLyBTaG91bGQgTk9UIGhhdmUgUzAzIChub3QgcmVsZXZhbnQpXG4gICAgYXNzZXJ0Lm9rKCFyZXN1bHQuaW5jbHVkZXMoJ3wgUzAzIHwnKSwgJ2RvZXMgbm90IGluY2x1ZGUgdW5yZWxhdGVkIFMwMycpO1xuICB9KTtcblxuICB0ZXN0KFwiUzAxIHdpdGggbm8gcHJlZGVjZXNzb3IgaW5jbHVkZXMgb25seSB0YXJnZXQgcm93XCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBmb3JtYXRSb2FkbWFwRXhjZXJwdChzYW1wbGVSb2FkbWFwLCAnUzAxJyk7XG5cbiAgICAvLyBTaG91bGQgaGF2ZSBoZWFkZXIgKyBzZXBhcmF0b3IgKyBTMDEgb25seVxuICAgIGFzc2VydC5tYXRjaChyZXN1bHQsIC9cXHwgSUQgXFx8IFNsaWNlIFxcfC8sICdoYXMgaGVhZGVyIHJvdycpO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQsIC9cXHwgUzAxIFxcfC8sICdoYXMgdGFyZ2V0IFMwMSByb3cnKTtcbiAgICAvLyBTaG91bGQgTk9UIGhhdmUgUzAyIG9yIFMwM1xuICAgIGFzc2VydC5vayghcmVzdWx0LmluY2x1ZGVzKCd8IFMwMiB8JyksICdkb2VzIG5vdCBpbmNsdWRlIFMwMicpO1xuICAgIGFzc2VydC5vayghcmVzdWx0LmluY2x1ZGVzKCd8IFMwMyB8JyksICdkb2VzIG5vdCBpbmNsdWRlIFMwMycpO1xuICAgIC8vIFNob3VsZCBoYXZlIHJlZmVyZW5jZVxuICAgIGFzc2VydC5tYXRjaChyZXN1bHQsIC9TZWUgZnVsbCByb2FkbWFwOi8sICdoYXMgcmVmZXJlbmNlIGRpcmVjdGl2ZScpO1xuXG4gICAgLy8gQ291bnQgcm93czogaGVhZGVyICsgc2VwYXJhdG9yICsgUzAxICsgYmxhbmsgKyBkaXJlY3RpdmUgPSA1IGxpbmVzXG4gICAgY29uc3QgbGluZXMgPSByZXN1bHQuc3BsaXQoJ1xcbicpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChsaW5lcy5sZW5ndGgsIDUsICdjb3JyZWN0IG51bWJlciBvZiBsaW5lcyAobm8gcHJlZGVjZXNzb3IpJyk7XG4gIH0pO1xuXG4gIHRlc3QoXCJtaXNzaW5nIHNsaWNlIHJldHVybnMgZW1wdHkgc3RyaW5nXCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBmb3JtYXRSb2FkbWFwRXhjZXJwdChzYW1wbGVSb2FkbWFwLCAnUzk5Jyk7XG5cbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LCAnJywgJ21pc3Npbmcgc2xpY2UgcmV0dXJucyBlbXB0eSBzdHJpbmcnKTtcbiAgfSk7XG5cbiAgdGVzdChcImVtcHR5IGlucHV0IHJldHVybnMgZW1wdHkgc3RyaW5nXCIsICgpID0+IHtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoZm9ybWF0Um9hZG1hcEV4Y2VycHQoJycsICdTMDEnKSwgJycsICdlbXB0eSBjb250ZW50IHJldHVybnMgZW1wdHknKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoZm9ybWF0Um9hZG1hcEV4Y2VycHQoc2FtcGxlUm9hZG1hcCwgJycpLCAnJywgJ2VtcHR5IHNsaWNlSWQgcmV0dXJucyBlbXB0eScpO1xuICB9KTtcblxuICB0ZXN0KFwiaGFuZGxlcyB0YWJsZSB3aXRoIHZhcmlvdXMgY29sdW1uIGZvcm1hdHNcIiwgKCkgPT4ge1xuICAgIC8vIFRhYmxlIHdpdGggZGlmZmVyZW50IHNwYWNpbmcgYW5kIGNvbnRlbnRcbiAgICBjb25zdCB2YXJpYW50Um9hZG1hcCA9IGAjIE1pbGVzdG9uZVxuXG58IElEIHwgU2xpY2UgfCBSaXNrIHwgRGVwZW5kcyB8IERvbmUgfCBBZnRlciB0aGlzIHxcbnw6LS0tfDotLS0tLS18Oi0tLS0tfDotLS0tLS0tLXw6LS0tLS18Oi0tLS0tLS0tLS0tfFxufCBTMDEgfCBGaXJzdCBzbGljZSB0aXRsZSB8IGxvdyB8IFx1MjAxNCB8IFx1MjcwNSB8IEZpcnN0IGNvbXBsZXRlLiB8XG58IFMwMiB8IFNlY29uZCBsb25nZXIgc2xpY2UgdGl0bGUgaGVyZSB8IG1lZGl1bSB8IFMwMSB8IFx1MkIxQyB8IFNlY29uZCB3b3JraW5nLiB8XG5gO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gZm9ybWF0Um9hZG1hcEV4Y2VycHQodmFyaWFudFJvYWRtYXAsICdTMDInKTtcblxuICAgIGFzc2VydC5tYXRjaChyZXN1bHQsIC9cXHwgUzAxIFxcfC8sICdoYXMgcHJlZGVjZXNzb3Igd2l0aCBkaWZmZXJlbnQgc3BhY2luZycpO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQsIC9cXHwgUzAyIFxcfC8sICdoYXMgdGFyZ2V0IHdpdGggZGlmZmVyZW50IHNwYWNpbmcnKTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LCAvU2Vjb25kIGxvbmdlciBzbGljZSB0aXRsZS8sICdwcmVzZXJ2ZXMgZnVsbCBzbGljZSB0aXRsZScpO1xuICB9KTtcblxuICB0ZXN0KFwiaGFuZGxlcyBtdWx0aXBsZSBkZXBlbmRlbmNpZXMgYnkgdXNpbmcgZmlyc3Qgb25lXCIsICgpID0+IHtcbiAgICBjb25zdCBtdWx0aURlcFJvYWRtYXAgPSBgfCBJRCB8IFNsaWNlIHwgUmlzayB8IERlcGVuZHMgfCBEb25lIHwgQWZ0ZXIgdGhpcyB8XG58LS0tLXwtLS0tLS0tfC0tLS0tLXwtLS0tLS0tLS18LS0tLS0tfC0tLS0tLS0tLS0tLXxcbnwgUzAxIHwgRmlyc3QgfCBsb3cgfCBcdTIwMTQgfCBcdTI3MDUgfCBEb25lLiB8XG58IFMwMiB8IFNlY29uZCB8IGxvdyB8IFx1MjAxNCB8IFx1MjcwNSB8IERvbmUuIHxcbnwgUzAzIHwgVGhpcmQgfCBtZWRpdW0gfCBTMDEsIFMwMiB8IFx1MkIxQyB8IFdvcmtpbmcuIHxcbmA7XG5cbiAgICBjb25zdCByZXN1bHQgPSBmb3JtYXRSb2FkbWFwRXhjZXJwdChtdWx0aURlcFJvYWRtYXAsICdTMDMnKTtcblxuICAgIC8vIFNob3VsZCBpbmNsdWRlIFMwMSAoZmlyc3QgZGVwZW5kZW5jeSkgYW5kIFMwM1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQsIC9cXHwgUzAxIFxcfC8sICdoYXMgZmlyc3QgZGVwZW5kZW5jeSBTMDEnKTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LCAvXFx8IFMwMyBcXHwvLCAnaGFzIHRhcmdldCBTMDMnKTtcbiAgICAvLyBTMDIgaXMgYWxzbyBhIGRlcGVuZGVuY3kgYnV0IHdlIG9ubHkgaW5jbHVkZSB0aGUgZmlyc3Qgb25lXG4gICAgLy8gKFRoaXMgaXMgaW50ZW50aW9uYWwgdG8ga2VlcCBleGNlcnB0cyBtaW5pbWFsKVxuICB9KTtcbn0pO1xuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIGNvbnRleHQtc3RvcmU6IHF1ZXJ5S25vd2xlZGdlXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuZGVzY3JpYmUoXCJjb250ZXh0LXN0b3JlOiBxdWVyeUtub3dsZWRnZVwiLCAoKSA9PiB7XG4gIC8vIFNhbXBsZSBLTk9XTEVER0UubWQgY29udGVudFxuICBjb25zdCBzYW1wbGVLbm93bGVkZ2UgPSBgIyBQcm9qZWN0IEtub3dsZWRnZVxuXG4jIyBEYXRhYmFzZSBQYXR0ZXJuc1xuU1FMaXRlIGlzIHVzZWQgd2l0aCBXQUwgbW9kZSBmb3IgY29uY3VycmVudCByZWFkcy5cbkFsd2F5cyB1c2UgcHJlcGFyZWQgc3RhdGVtZW50cy5cblxuTW9yZSBkYXRhYmFzZSBkZXRhaWxzIGhlcmUuXG5cbiMjIEFQSSBEZXNpZ25cblJFU1QgZW5kcG9pbnRzIGZvbGxvdyBPcGVuQVBJIHNwZWMuXG5Vc2UgdmVyc2lvbmVkIHBhdGhzIGxpa2UgL3YxL3Jlc291cmNlLlxuXG4jIyBUZXN0aW5nIEd1aWRlbGluZXNcblVuaXQgdGVzdHMgdXNlIG5vZGU6dGVzdC5cbkludGVncmF0aW9uIHRlc3RzIG1vY2sgZXh0ZXJuYWwgc2VydmljZXMuXG5gO1xuXG4gIHRlc3QoXCJzaW5nbGUga2V5d29yZCBtYXRjaGVzIGhlYWRlclwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcXVlcnlLbm93bGVkZ2Uoc2FtcGxlS25vd2xlZGdlLCBbJ2RhdGFiYXNlJ10pO1xuXG4gICAgYXNzZXJ0Lm1hdGNoKHJlc3VsdCwgLyMjIERhdGFiYXNlIFBhdHRlcm5zLywgJ2luY2x1ZGVzIG1hdGNoaW5nIHNlY3Rpb24gaGVhZGVyJyk7XG4gICAgYXNzZXJ0Lm1hdGNoKHJlc3VsdCwgL1NRTGl0ZSBpcyB1c2VkIHdpdGggV0FMIG1vZGUvLCAnaW5jbHVkZXMgc2VjdGlvbiBjb250ZW50Jyk7XG4gICAgLy8gU2hvdWxkIE5PVCBpbmNsdWRlIG90aGVyIHNlY3Rpb25zXG4gICAgYXNzZXJ0Lm9rKCFyZXN1bHQuaW5jbHVkZXMoJyMjIEFQSSBEZXNpZ24nKSwgJ2RvZXMgbm90IGluY2x1ZGUgbm9uLW1hdGNoaW5nIEFQSSBzZWN0aW9uJyk7XG4gICAgYXNzZXJ0Lm9rKCFyZXN1bHQuaW5jbHVkZXMoJyMjIFRlc3RpbmcgR3VpZGVsaW5lcycpLCAnZG9lcyBub3QgaW5jbHVkZSBub24tbWF0Y2hpbmcgVGVzdGluZyBzZWN0aW9uJyk7XG4gIH0pO1xuXG4gIHRlc3QoXCJtdWx0aXBsZSBrZXl3b3JkcyBtYXRjaCBtdWx0aXBsZSBzZWN0aW9uc1wiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcXVlcnlLbm93bGVkZ2Uoc2FtcGxlS25vd2xlZGdlLCBbJ2RhdGFiYXNlJywgJ3Rlc3RpbmcnXSk7XG5cbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LCAvIyMgRGF0YWJhc2UgUGF0dGVybnMvLCAnaW5jbHVkZXMgRGF0YWJhc2Ugc2VjdGlvbicpO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQsIC8jIyBUZXN0aW5nIEd1aWRlbGluZXMvLCAnaW5jbHVkZXMgVGVzdGluZyBzZWN0aW9uJyk7XG4gICAgYXNzZXJ0Lm9rKCFyZXN1bHQuaW5jbHVkZXMoJyMjIEFQSSBEZXNpZ24nKSwgJ2RvZXMgbm90IGluY2x1ZGUgQVBJIHNlY3Rpb24nKTtcbiAgfSk7XG5cbiAgdGVzdChcIm5vIG1hdGNoZXMgcmV0dXJucyBlbXB0eSBzdHJpbmdcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHF1ZXJ5S25vd2xlZGdlKHNhbXBsZUtub3dsZWRnZSwgWydub25leGlzdGVudCddKTtcblxuICAgIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQsICcnLCAnbm8gbWF0Y2hlcyByZXR1cm5zIGVtcHR5IHN0cmluZyBwZXIgRDAyMCcpO1xuICB9KTtcblxuICB0ZXN0KFwia2V5d29yZCBpbiBmaXJzdCBwYXJhZ3JhcGggbWF0Y2hlc1wiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcXVlcnlLbm93bGVkZ2Uoc2FtcGxlS25vd2xlZGdlLCBbJ3NxbGl0ZSddKTtcblxuICAgIC8vICdzcWxpdGUnIGFwcGVhcnMgaW4gZmlyc3QgcGFyYWdyYXBoIG9mIERhdGFiYXNlIFBhdHRlcm5zXG4gICAgYXNzZXJ0Lm1hdGNoKHJlc3VsdCwgLyMjIERhdGFiYXNlIFBhdHRlcm5zLywgJ21hdGNoZXMga2V5d29yZCBpbiBmaXJzdCBwYXJhZ3JhcGgnKTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LCAvU1FMaXRlIGlzIHVzZWQvLCAnaW5jbHVkZXMgdGhlIHNlY3Rpb24gd2l0aCBtYXRjaGluZyBwYXJhZ3JhcGgnKTtcbiAgfSk7XG5cbiAgdGVzdChcImNhc2UtaW5zZW5zaXRpdmUgbWF0Y2hpbmdcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHF1ZXJ5S25vd2xlZGdlKHNhbXBsZUtub3dsZWRnZSwgWydEQVRBQkFTRScsICdBUEknXSk7XG5cbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LCAvIyMgRGF0YWJhc2UgUGF0dGVybnMvLCAnY2FzZS1pbnNlbnNpdGl2ZSBoZWFkZXIgbWF0Y2gnKTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LCAvIyMgQVBJIERlc2lnbi8sICdjYXNlLWluc2Vuc2l0aXZlIGhlYWRlciBtYXRjaCBmb3IgQVBJJyk7XG4gIH0pO1xuXG4gIHRlc3QoXCJlbXB0eSBrZXl3b3JkcyByZXR1cm5zIGVtcHR5IHN0cmluZ1wiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcXVlcnlLbm93bGVkZ2Uoc2FtcGxlS25vd2xlZGdlLCBbXSk7XG5cbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LCAnJywgJ2VtcHR5IGtleXdvcmRzIHJldHVybnMgZW1wdHkgc3RyaW5nJyk7XG4gIH0pO1xuXG4gIHRlc3QoXCJlbXB0eSBjb250ZW50IHJldHVybnMgZW1wdHkgc3RyaW5nXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBxdWVyeUtub3dsZWRnZSgnJywgWydkYXRhYmFzZSddKTtcblxuICAgIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQsICcnLCAnZW1wdHkgY29udGVudCByZXR1cm5zIGVtcHR5IHN0cmluZycpO1xuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDAgUmVncmVzc2lvbjogaXNzdWUgIzQ3MTkgXHUyMDE0IHNpbmdsZS1IMiB3aXRoIG1hbnkgSDMgZW50cmllcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgLy8gQSBLTk9XTEVER0UubWQgc3RydWN0dXJlZCBhcyBvbmUgdG9wLWxldmVsIEgyIHdpdGggbWFueSBIMyBlbnRyaWVzIG11c3RcbiAgLy8gZmlsdGVyIGF0IEgzIGdyYW51bGFyaXR5OyBvdGhlcndpc2Ugb25lIGtleXdvcmQgbWF0Y2ggYWdhaW5zdCB0aGUgSDJcbiAgLy8gaGVhZGVyIG9yIGZpcnN0IHBhcmFncmFwaCByZXR1cm5zIHRoZSBlbnRpcmUgZmlsZS5cbiAgdGVzdChcInNpbmdsZSBIMiB3aXRoIG1hbnkgSDMgZW50cmllcyBmaWx0ZXJzIGF0IEgzIGxldmVsIChpc3N1ZSAjNDcxOSlcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHNpbmdsZUgyS25vd2xlZGdlID0gYCMgUHJvamVjdCBLbm93bGVkZ2VcblxuIyMgUGF0dGVybnNcblxuIyMjIERhdGFiYXNlOiBwcmVwYXJlZCBzdGF0ZW1lbnRzXG5BbHdheXMgdXNlIHByZXBhcmVkIHN0YXRlbWVudHMgd2l0aCBTUUxpdGUuXG5cbiMjIyBBUEk6IHZlcnNpb25lZCBwYXRoc1xuVXNlIC92MS9yZXNvdXJjZSBzdHlsZSB2ZXJzaW9uaW5nLlxuXG4jIyMgVGVzdGluZzogbm9kZTp0ZXN0XG5QcmVmZXIgbm9kZTp0ZXN0IG92ZXIgZXh0ZXJuYWwgZnJhbWV3b3Jrcy5cblxuIyMjIERlcGxveW1lbnQ6IGJsdWUtZ3JlZW5cbkJsdWUtZ3JlZW4gZGVwbG95bWVudCBmb3IgemVyby1kb3dudGltZSByZWxlYXNlcy5cbmA7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBxdWVyeUtub3dsZWRnZShzaW5nbGVIMktub3dsZWRnZSwgWydkYXRhYmFzZSddKTtcblxuICAgIC8vIFNob3VsZCBpbmNsdWRlIG9ubHkgdGhlIG1hdGNoaW5nIEgzIGVudHJ5LCBub3QgdGhlIHdob2xlIGZpbGVcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LCAvRGF0YWJhc2U6IHByZXBhcmVkIHN0YXRlbWVudHMvLCAnaW5jbHVkZXMgbWF0Y2hpbmcgSDMgZW50cnknKTtcbiAgICBhc3NlcnQub2soXG4gICAgICAhcmVzdWx0LmluY2x1ZGVzKCdBUEk6IHZlcnNpb25lZCBwYXRocycpLFxuICAgICAgJ2RvZXMgbm90IGluY2x1ZGUgbm9uLW1hdGNoaW5nIEgzIGVudHJ5JyxcbiAgICApO1xuICAgIGFzc2VydC5vayhcbiAgICAgICFyZXN1bHQuaW5jbHVkZXMoJ1Rlc3Rpbmc6IG5vZGU6dGVzdCcpLFxuICAgICAgJ2RvZXMgbm90IGluY2x1ZGUgbm9uLW1hdGNoaW5nIEgzIGVudHJ5JyxcbiAgICApO1xuICAgIGFzc2VydC5vayhcbiAgICAgICFyZXN1bHQuaW5jbHVkZXMoJ0RlcGxveW1lbnQ6IGJsdWUtZ3JlZW4nKSxcbiAgICAgICdkb2VzIG5vdCBpbmNsdWRlIG5vbi1tYXRjaGluZyBIMyBlbnRyeScsXG4gICAgKTtcbiAgICAvLyBUaGUgcmV0dXJuZWQgcGF5bG9hZCBtdXN0IGJlIGRyYW1hdGljYWxseSBzbWFsbGVyIHRoYW4gdGhlIGZ1bGwgY29udGVudFxuICAgIGFzc2VydC5vayhcbiAgICAgIHJlc3VsdC5sZW5ndGggPCBzaW5nbGVIMktub3dsZWRnZS5sZW5ndGggLyAyLFxuICAgICAgYHNjb3BlZCByZXN1bHQgKCR7cmVzdWx0Lmxlbmd0aH0gY2hhcnMpIHNob3VsZCBiZSA8NTAlIG9mIGZ1bGwgY29udGVudCAoJHtzaW5nbGVIMktub3dsZWRnZS5sZW5ndGh9IGNoYXJzKWAsXG4gICAgKTtcbiAgfSk7XG5cbiAgdGVzdChcInNpbmdsZSBIMiB3aXRoIEgzIGVudHJpZXMgcmV0dXJucyBlbXB0eSB3aGVuIG5vIEgzIG1hdGNoZXMgKGlzc3VlICM0NzE5KVwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3Qgc2luZ2xlSDJLbm93bGVkZ2UgPSBgIyBQcm9qZWN0IEtub3dsZWRnZVxuXG4jIyBQYXR0ZXJuc1xuXG4jIyMgRGF0YWJhc2U6IHByZXBhcmVkIHN0YXRlbWVudHNcbkFsd2F5cyB1c2UgcHJlcGFyZWQgc3RhdGVtZW50cyB3aXRoIFNRTGl0ZS5cblxuIyMjIEFQSTogdmVyc2lvbmVkIHBhdGhzXG5Vc2UgL3YxL3Jlc291cmNlIHN0eWxlIHZlcnNpb25pbmcuXG5gO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcXVlcnlLbm93bGVkZ2Uoc2luZ2xlSDJLbm93bGVkZ2UsIFsnbm9uZXhpc3RlbnQnXSk7XG5cbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LCAnJywgJ25vIEgzIG1hdGNoIHJldHVybnMgZW1wdHkgc3RyaW5nJyk7XG4gIH0pO1xuXG4gIHRlc3QoXCJmYWxscyBiYWNrIHRvIEgyIHdoZW4gbm8gSDMgaGVhZGluZ3MgZXhpc3QgYXQgYWxsXCIsIGFzeW5jICgpID0+IHtcbiAgICAvLyBCYWNrd2FyZHMtY29tcGF0OiBmaWxlcyB3aXRoIG9ubHkgSDIgdG9waWMgaGVhZGVycyBtdXN0IHN0aWxsIGZpbHRlci5cbiAgICBjb25zdCBoMk9ubHlLbm93bGVkZ2UgPSBgIyBQcm9qZWN0IEtub3dsZWRnZVxuXG4jIyBEYXRhYmFzZSBQYXR0ZXJuc1xuVXNlIHByZXBhcmVkIHN0YXRlbWVudHMuXG5cbiMjIEFQSSBEZXNpZ25cblJFU1Qgd2l0aCBPcGVuQVBJLlxuYDtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHF1ZXJ5S25vd2xlZGdlKGgyT25seUtub3dsZWRnZSwgWydkYXRhYmFzZSddKTtcblxuICAgIGFzc2VydC5tYXRjaChyZXN1bHQsIC9EYXRhYmFzZSBQYXR0ZXJucy8sICdIMi1vbmx5IGZpbGUgZmFsbHMgYmFjayB0byBIMiBmaWx0ZXJpbmcnKTtcbiAgICBhc3NlcnQub2soIXJlc3VsdC5pbmNsdWRlcygnQVBJIERlc2lnbicpLCAnbm9uLW1hdGNoaW5nIEgyIHNlY3Rpb24gZXhjbHVkZWQnKTtcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUVBLFNBQVMsVUFBVSxNQUFNLGlCQUFpQjtBQUMxQyxPQUFPLFlBQVk7QUFDbkI7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1A7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFNUCxTQUFTLDRDQUE0QyxNQUFNO0FBQ3pELE9BQUssa0NBQWtDLE1BQU07QUFDM0Msa0JBQWM7QUFDZCxXQUFPLEdBQUcsQ0FBQyxjQUFjLEdBQUcsNEJBQTRCO0FBRXhELFVBQU0sSUFBSSxlQUFlO0FBQ3pCLFdBQU8sZ0JBQWdCLEdBQUcsQ0FBQyxHQUFHLDBDQUEwQztBQUV4RSxVQUFNLElBQUksa0JBQWtCO0FBQzVCLFdBQU8sZ0JBQWdCLEdBQUcsQ0FBQyxHQUFHLDZDQUE2QztBQUUzRSxVQUFNLEtBQUssZUFBZSxFQUFFLGFBQWEsT0FBTyxDQUFDO0FBQ2pELFdBQU8sZ0JBQWdCLElBQUksQ0FBQyxHQUFHLG9EQUFvRDtBQUVuRixVQUFNLEtBQUssa0JBQWtCLEVBQUUsU0FBUyxNQUFNLENBQUM7QUFDL0MsV0FBTyxnQkFBZ0IsSUFBSSxDQUFDLEdBQUcsdURBQXVEO0FBQUEsRUFDeEYsQ0FBQztBQUNILENBQUM7QUFNRCxTQUFT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
