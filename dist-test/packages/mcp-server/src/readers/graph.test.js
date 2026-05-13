import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import {
  buildGraph,
  writeGraph,
  writeSnapshot,
  graphStatus,
  graphQuery,
  graphDiff
} from "./graph.js";
function tmpProject() {
  const dir = join(tmpdir(), `gsd-graph-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function writeFixture(base, relPath, content) {
  const full = join(base, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf-8");
}
function makeProjectWithArtifacts(projectDir) {
  writeFixture(projectDir, ".gsd/STATE.md", [
    "# GSD State",
    "",
    "**Active Milestone:** M001: Auth System",
    "**Active Slice:** S01: Login flow",
    "**Phase:** execution",
    "",
    "## Milestone Registry",
    "",
    "- \u{1F504} **M001:** Auth System",
    "",
    "## Next Action",
    "",
    "Execute T01 in S01."
  ].join("\n"));
  writeFixture(projectDir, ".gsd/KNOWLEDGE.md", [
    "# Project Knowledge",
    "",
    "## Rules",
    "",
    "| # | Scope | Rule | Why | Added |",
    "|---|-------|------|-----|-------|",
    "| K001 | auth | Hash passwords with bcrypt | Security requirement | manual |",
    "| K002 | db | Use transactions for multi-table | Data consistency | auto |",
    "",
    "## Patterns",
    "",
    "| # | Pattern | Where | Notes |",
    "|---|---------|-------|-------|",
    "| P001 | Singleton services | services/ | Prevents duplication |",
    "",
    "## Lessons Learned",
    "",
    "| # | What Happened | Root Cause | Fix | Scope |",
    "|---|--------------|------------|-----|-------|",
    "| L001 | CI tests failed | Env diff | Added setup script | testing |"
  ].join("\n"));
  writeFixture(projectDir, ".gsd/milestones/M001/M001-ROADMAP.md", [
    "# M001: Auth System",
    "",
    "## Vision",
    "",
    "Build authentication for the platform.",
    "",
    "## Slice Overview",
    "",
    "| ID | Slice | Risk | Depends | Done | After this |",
    "|----|-------|------|---------|------|------------|",
    "| S01 | Login flow | low | \u2014 | \u{1F504} | Users can log in |"
  ].join("\n"));
  writeFixture(projectDir, ".gsd/milestones/M001/slices/S01/S01-PLAN.md", [
    "# S01: Login flow",
    "",
    "## Tasks",
    "",
    "- [ ] **T01: Implement login endpoint** \u2014 Core auth logic",
    "- [ ] **T02: Add session management** \u2014 Keep users logged in"
  ].join("\n"));
}
function writeLearningsFixture(projectDir, milestoneId, content) {
  writeFixture(projectDir, `.gsd/milestones/${milestoneId}/${milestoneId}-LEARNINGS.md`, content);
}
const SAMPLE_LEARNINGS = `---
phase: "M001"
phase_name: "User Auth"
project: "my-project"
generated: "2026-04-15T10:00:00Z"
counts:
  decisions: 2
  lessons: 1
  patterns: 1
  surprises: 1
missing_artifacts: []
---

# Learnings: User Auth

## Decisions
- Use JWT for stateless auth across services.
  Source: M001-PLAN.md/Architecture

- Store refresh tokens in HTTP-only cookies only.
  Source: M001-PLAN.md/Security

## Lessons
- Integration tests need a real DB \u2014 mocks missed migration bugs.
  Source: M001-SUMMARY.md/Testing

## Patterns
- Repository pattern abstracts DB access and simplifies testing.
  Source: M001-PLAN.md/Design

## Surprises
- Token expiry edge case caused silent auth failures in prod.
  Source: M001-SUMMARY.md/Issues
`;
describe("buildGraph", () => {
  let projectDir;
  before(() => {
    projectDir = tmpProject();
    makeProjectWithArtifacts(projectDir);
  });
  after(() => rmSync(projectDir, { recursive: true, force: true }));
  it("returns nodeCount > 0 for a project with artifacts", async () => {
    const graph = await buildGraph(projectDir);
    assert.ok(graph.nodes.length > 0, `Expected nodes, got ${graph.nodes.length}`);
  });
  it("produces a non-empty set of edges for a project with artifacts", async () => {
    const graph = await buildGraph(projectDir);
    assert.ok(
      graph.edges.length > 0,
      `expected edges for a project with artifacts. nodes=${graph.nodes.length}, edges=${graph.edges.length}`
    );
    const nodeIds = new Set(graph.nodes.map((n) => n.id));
    for (const edge of graph.edges) {
      assert.ok(
        nodeIds.has(edge.from),
        `edge.from="${edge.from}" must reference an existing node`
      );
      assert.ok(
        nodeIds.has(edge.to),
        `edge.to="${edge.to}" must reference an existing node`
      );
    }
  });
  it("includes builtAt ISO timestamp", async () => {
    const graph = await buildGraph(projectDir);
    assert.ok(typeof graph.builtAt === "string");
    assert.ok(!isNaN(Date.parse(graph.builtAt)));
  });
  it("skips unparseable artifact and does not throw", async () => {
    const badProject = tmpProject();
    writeFixture(badProject, ".gsd/STATE.md", "not valid gsd state at all \0\0\0");
    const graph = await buildGraph(badProject);
    assert.ok(Array.isArray(graph.nodes), "nodes must be an array");
    assert.ok(Array.isArray(graph.edges), "edges must be an array");
    assert.ok(
      !Number.isNaN(Date.parse(graph.builtAt)),
      "builtAt must be a valid ISO-8601 timestamp even when artifact is unparseable"
    );
    rmSync(badProject, { recursive: true, force: true });
  });
  it("returns empty graph for project with no .gsd/ directory", async () => {
    const emptyProject = tmpProject();
    const graph = await buildGraph(emptyProject);
    assert.deepEqual(graph.nodes, [], "nodes must be empty for .gsd-less project");
    assert.deepEqual(graph.edges, [], "edges must be empty for .gsd-less project");
    assert.equal(typeof graph.builtAt, "string");
    rmSync(emptyProject, { recursive: true, force: true });
  });
  it("nodes have required fields: id, label, type, confidence", async () => {
    const graph = await buildGraph(projectDir);
    for (const node of graph.nodes) {
      assert.ok(typeof node.id === "string", "node.id must be string");
      assert.ok(typeof node.label === "string", "node.label must be string");
      assert.ok(typeof node.type === "string", "node.type must be string");
      assert.ok(
        node.confidence === "EXTRACTED" || node.confidence === "INFERRED" || node.confidence === "AMBIGUOUS",
        `Invalid confidence: ${node.confidence}`
      );
    }
  });
});
describe("buildGraph \u2014 LEARNINGS.md parsing", () => {
  let projectDir;
  beforeEach(() => {
    projectDir = tmpProject();
    mkdirSync(join(projectDir, ".gsd", "milestones", "M001"), { recursive: true });
    writeLearningsFixture(projectDir, "M001", SAMPLE_LEARNINGS);
  });
  afterEach(() => rmSync(projectDir, { recursive: true, force: true }));
  it("extracts decision nodes from ## Decisions section", async () => {
    const graph = await buildGraph(projectDir);
    const decisions = graph.nodes.filter((n) => n.type === "decision" || n.type === "rule" && n.id.startsWith("decision:"));
    const decisionNodes = graph.nodes.filter((n) => n.id.includes("decision:M001"));
    assert.ok(decisionNodes.length >= 2, `Expected >= 2 decision nodes, got ${decisionNodes.length}`);
  });
  it("extracts lesson nodes from ## Lessons section", async () => {
    const graph = await buildGraph(projectDir);
    const lessonNodes = graph.nodes.filter((n) => n.id.includes("lesson:M001"));
    assert.ok(lessonNodes.length >= 1, `Expected >= 1 lesson node, got ${lessonNodes.length}`);
    assert.ok(lessonNodes.every((n) => n.type === "lesson"), 'All lesson nodes must have type "lesson"');
  });
  it("extracts pattern nodes from ## Patterns section", async () => {
    const graph = await buildGraph(projectDir);
    const patternNodes = graph.nodes.filter((n) => n.id.includes("pattern:M001"));
    assert.ok(patternNodes.length >= 1, `Expected >= 1 pattern node, got ${patternNodes.length}`);
    assert.ok(patternNodes.every((n) => n.type === "pattern"), 'All pattern nodes must have type "pattern"');
  });
  it("maps surprises to lesson nodes", async () => {
    const graph = await buildGraph(projectDir);
    const surpriseNodes = graph.nodes.filter((n) => n.id.includes("surprise:M001"));
    assert.ok(surpriseNodes.length >= 1, `Expected >= 1 surprise node, got ${surpriseNodes.length}`);
    assert.ok(surpriseNodes.every((n) => n.type === "lesson"), 'Surprises must be mapped to type "lesson"');
  });
  it("node labels contain the learning text", async () => {
    const graph = await buildGraph(projectDir);
    const hasJwtDecision = graph.nodes.some(
      (n) => n.label.toLowerCase().includes("jwt") || n.description?.toLowerCase().includes("jwt")
    );
    assert.ok(hasJwtDecision, "Expected a node describing the JWT decision");
  });
  it("node description includes source attribution", async () => {
    const graph = await buildGraph(projectDir);
    const learningNodes = graph.nodes.filter(
      (n) => n.id.includes(":M001:") || n.id.match(/:(decision|lesson|pattern|surprise):M001/)
    );
    const withSource = learningNodes.filter((n) => n.description?.includes("Source:") || n.description?.includes("M001-PLAN"));
    assert.ok(withSource.length > 0, "Expected at least one node with source attribution in description");
  });
  it("adds relates_to edge from learning node to milestone node", async () => {
    const graph = await buildGraph(projectDir);
    const edgesToMilestone = graph.edges.filter(
      (e) => e.to === "milestone:M001" || e.from === "milestone:M001"
    );
    const learningEdges = graph.edges.filter(
      (e) => e.from.includes("M001") && (e.type === "relates_to" || e.type === "contains") || e.to.includes("M001") && e.type === "relates_to"
    );
    assert.ok(
      learningEdges.length > 0 || edgesToMilestone.length > 0,
      "Expected edges connecting learning nodes to milestone"
    );
  });
  it("skips LEARNINGS.md gracefully when file is malformed", async () => {
    const badProject = tmpProject();
    mkdirSync(join(badProject, ".gsd", "milestones", "M002"), { recursive: true });
    writeLearningsFixture(badProject, "M002", "\0\0\0 not valid yaml or markdown \0\0\0");
    const graph = await buildGraph(badProject);
    assert.ok(Array.isArray(graph.nodes));
    assert.equal(typeof graph.builtAt, "string");
    const m002LearningNodes = graph.nodes.filter(
      (n) => n.id.includes("M002") && n.type !== "milestone"
    );
    assert.equal(
      m002LearningNodes.length,
      0,
      `malformed LEARNINGS.md must not produce any non-milestone nodes (got: ${JSON.stringify(m002LearningNodes.map((n) => n.id))})`
    );
    rmSync(badProject, { recursive: true, force: true });
  });
  it("produces no learning nodes when all sections are empty", async () => {
    const emptyProject = tmpProject();
    mkdirSync(join(emptyProject, ".gsd", "milestones", "M003"), { recursive: true });
    writeLearningsFixture(emptyProject, "M003", `---
phase: "M003"
phase_name: "Empty"
project: "test"
generated: "2026-04-15T10:00:00Z"
counts:
  decisions: 0
  lessons: 0
  patterns: 0
  surprises: 0
missing_artifacts: []
---

# Learnings: Empty

## Decisions

## Lessons

## Patterns

## Surprises
`);
    const graph = await buildGraph(emptyProject);
    const learningNodes = graph.nodes.filter(
      (n) => n.id.includes("decision:M003") || n.id.includes("lesson:M003") || n.id.includes("pattern:M003") || n.id.includes("surprise:M003")
    );
    assert.equal(learningNodes.length, 0, "Empty sections should produce no nodes");
    rmSync(emptyProject, { recursive: true, force: true });
  });
  it("does not crash when LEARNINGS.md is missing entirely", async () => {
    const noLearningsProject = tmpProject();
    mkdirSync(join(noLearningsProject, ".gsd", "milestones", "M004"), { recursive: true });
    const graph = await buildGraph(noLearningsProject);
    assert.ok(Array.isArray(graph.nodes));
    assert.equal(typeof graph.builtAt, "string");
    const learningNodes = graph.nodes.filter(
      (n) => n.type === "decision" || n.type === "lesson" || n.type === "pattern"
    );
    assert.equal(
      learningNodes.length,
      0,
      `no LEARNINGS.md \u2192 no learning nodes (got: ${JSON.stringify(learningNodes.map((n) => n.id))})`
    );
    rmSync(noLearningsProject, { recursive: true, force: true });
  });
});
describe("writeGraph", () => {
  let projectDir;
  let graph;
  before(async () => {
    projectDir = tmpProject();
    makeProjectWithArtifacts(projectDir);
    graph = await buildGraph(projectDir);
  });
  after(() => rmSync(projectDir, { recursive: true, force: true }));
  it("creates graph.json in .gsd/graphs/ after writeGraph()", async () => {
    const gsdRoot = join(projectDir, ".gsd");
    await writeGraph(gsdRoot, graph);
    const graphPath = join(gsdRoot, "graphs", "graph.json");
    assert.ok(existsSync(graphPath), `Expected ${graphPath} to exist`);
  });
  it("write is atomic \u2014 no temp file remains after writeGraph()", async () => {
    const gsdRoot = join(projectDir, ".gsd");
    await writeGraph(gsdRoot, graph);
    const tmpPath = join(gsdRoot, "graphs", "graph.tmp.json");
    assert.ok(!existsSync(tmpPath), "Temp file should not exist after successful write");
  });
  it("written graph.json is valid JSON with nodes and edges", async () => {
    const gsdRoot = join(projectDir, ".gsd");
    await writeGraph(gsdRoot, graph);
    const raw = readFileSync(join(gsdRoot, "graphs", "graph.json"), "utf-8");
    const parsed = JSON.parse(raw);
    assert.ok(Array.isArray(parsed.nodes));
    assert.ok(Array.isArray(parsed.edges));
    assert.ok(typeof parsed.builtAt === "string");
  });
});
describe("graphStatus", () => {
  let projectDir;
  beforeEach(() => {
    projectDir = tmpProject();
  });
  afterEach(() => rmSync(projectDir, { recursive: true, force: true }));
  it("returns { exists: false } when no graph.json exists", async () => {
    const status = await graphStatus(projectDir);
    assert.equal(status.exists, false);
  });
  it("returns { exists: true, nodeCount, edgeCount, ageHours } when graph exists", async () => {
    makeProjectWithArtifacts(projectDir);
    const gsdRoot = join(projectDir, ".gsd");
    const graph = await buildGraph(projectDir);
    await writeGraph(gsdRoot, graph);
    const status = await graphStatus(projectDir);
    assert.equal(status.exists, true);
    assert.ok(typeof status.nodeCount === "number");
    assert.ok(typeof status.edgeCount === "number");
    assert.ok(typeof status.ageHours === "number");
    assert.ok(status.ageHours >= 0);
  });
  it("stale = false for a freshly built graph", async () => {
    makeProjectWithArtifacts(projectDir);
    const gsdRoot = join(projectDir, ".gsd");
    const graph = await buildGraph(projectDir);
    await writeGraph(gsdRoot, graph);
    const status = await graphStatus(projectDir);
    assert.equal(status.stale, false);
  });
  it("stale = true for a graph older than 24h (builtAt backdated)", async () => {
    makeProjectWithArtifacts(projectDir);
    const gsdRoot = join(projectDir, ".gsd");
    mkdirSync(join(gsdRoot, "graphs"), { recursive: true });
    const oldGraph = {
      nodes: [],
      edges: [],
      builtAt: new Date(Date.now() - 25 * 60 * 60 * 1e3).toISOString()
    };
    writeFileSync(
      join(gsdRoot, "graphs", "graph.json"),
      JSON.stringify(oldGraph),
      "utf-8"
    );
    const status = await graphStatus(projectDir);
    assert.equal(status.exists, true);
    assert.equal(status.stale, true);
  });
});
describe("graphQuery", () => {
  let projectDir;
  before(async () => {
    projectDir = tmpProject();
    makeProjectWithArtifacts(projectDir);
    const gsdRoot = join(projectDir, ".gsd");
    const graph = await buildGraph(projectDir);
    await writeGraph(gsdRoot, graph);
  });
  after(() => rmSync(projectDir, { recursive: true, force: true }));
  it("returns matching nodes for a known term", async () => {
    const result = await graphQuery(projectDir, "auth");
    assert.ok(Array.isArray(result.nodes));
    assert.ok(result.nodes.length > 0, 'Expected at least one match for "auth"');
  });
  it("returns empty array for a term that matches nothing", async () => {
    const result = await graphQuery(projectDir, "xxxxxxnotfound999zzz");
    assert.ok(Array.isArray(result.nodes));
    assert.equal(result.nodes.length, 0);
  });
  it("search is case-insensitive", async () => {
    const lower = await graphQuery(projectDir, "auth");
    const upper = await graphQuery(projectDir, "AUTH");
    assert.deepEqual(
      lower.nodes.map((n) => n.id).sort(),
      upper.nodes.map((n) => n.id).sort()
    );
  });
  it("budget trims AMBIGUOUS edges first \u2014 keeps INFERRED edge when budget only forces one drop", async () => {
    const gsdRoot = join(projectDir, ".gsd");
    const mixedGraph = {
      builtAt: (/* @__PURE__ */ new Date()).toISOString(),
      nodes: [
        { id: "n1", label: "seed node budget", type: "milestone", confidence: "EXTRACTED" },
        { id: "n2", label: "connected via AMBIGUOUS", type: "task", confidence: "AMBIGUOUS" },
        { id: "n3", label: "connected via INFERRED", type: "task", confidence: "INFERRED" }
      ],
      edges: [
        { from: "n1", to: "n2", type: "contains", confidence: "AMBIGUOUS" },
        { from: "n1", to: "n3", type: "contains", confidence: "INFERRED" }
      ]
    };
    await writeGraph(gsdRoot, mixedGraph);
    const result = await graphQuery(projectDir, "seed node budget", 70);
    assert.ok(result.nodes.some((n) => n.id === "n1"), "seed must remain");
    const hasAmbiguousEdge = result.edges.some(
      (e) => e.from === "n1" && e.to === "n2" && e.confidence === "AMBIGUOUS"
    );
    const hasInferredEdge = result.edges.some(
      (e) => e.from === "n1" && e.to === "n3" && e.confidence === "INFERRED"
    );
    assert.equal(
      hasAmbiguousEdge,
      false,
      "AMBIGUOUS edge must be trimmed FIRST when budget is tight"
    );
    assert.equal(
      hasInferredEdge,
      true,
      "INFERRED edge must survive when budget only forces the AMBIGUOUS drop"
    );
    const originalGraph = await buildGraph(projectDir);
    await writeGraph(gsdRoot, originalGraph);
  });
});
describe("graphDiff", () => {
  let projectDir;
  beforeEach(async () => {
    projectDir = tmpProject();
    makeProjectWithArtifacts(projectDir);
    const gsdRoot = join(projectDir, ".gsd");
    const graph = await buildGraph(projectDir);
    await writeGraph(gsdRoot, graph);
  });
  afterEach(() => rmSync(projectDir, { recursive: true, force: true }));
  it("returns empty diff when comparing graph to itself (snapshot = current)", async () => {
    const gsdRoot = join(projectDir, ".gsd");
    await writeSnapshot(gsdRoot);
    const diff = await graphDiff(projectDir);
    assert.ok(Array.isArray(diff.nodes.added));
    assert.ok(Array.isArray(diff.nodes.removed));
    assert.ok(Array.isArray(diff.nodes.changed));
    assert.equal(diff.nodes.added.length, 0);
    assert.equal(diff.nodes.removed.length, 0);
  });
  it("returns added nodes when a new node appears after snapshot", async () => {
    const gsdRoot = join(projectDir, ".gsd");
    await writeSnapshot(gsdRoot);
    const extraGraph = {
      builtAt: (/* @__PURE__ */ new Date()).toISOString(),
      nodes: [
        { id: "brand-new-node", label: "New Feature", type: "milestone", confidence: "EXTRACTED" }
      ],
      edges: []
    };
    await writeGraph(gsdRoot, extraGraph);
    const diff = await graphDiff(projectDir);
    assert.ok(diff.nodes.added.includes("brand-new-node"), "new node should be in added");
  });
  it("returns removed nodes when a node disappears after snapshot", async () => {
    const gsdRoot = join(projectDir, ".gsd");
    const snapshotGraph = {
      builtAt: (/* @__PURE__ */ new Date()).toISOString(),
      nodes: [
        { id: "old-node-to-be-removed", label: "Old", type: "task", confidence: "EXTRACTED" }
      ],
      edges: []
    };
    writeFileSync(
      join(gsdRoot, "graphs", ".last-build-snapshot.json"),
      JSON.stringify({ ...snapshotGraph, snapshotAt: (/* @__PURE__ */ new Date()).toISOString() }),
      "utf-8"
    );
    const diff = await graphDiff(projectDir);
    assert.ok(diff.nodes.removed.includes("old-node-to-be-removed"), "old node should be in removed");
  });
  it("returns empty diff structure when no snapshot exists", async () => {
    const diff = await graphDiff(projectDir);
    assert.ok(Array.isArray(diff.nodes.added));
    assert.ok(Array.isArray(diff.nodes.removed));
    assert.ok(Array.isArray(diff.nodes.changed));
    assert.ok(Array.isArray(diff.edges.added));
    assert.ok(Array.isArray(diff.edges.removed));
  });
  it("writeSnapshot creates .last-build-snapshot.json with snapshotAt", async () => {
    const gsdRoot = join(projectDir, ".gsd");
    await writeSnapshot(gsdRoot);
    const snapshotPath = join(gsdRoot, "graphs", ".last-build-snapshot.json");
    assert.ok(existsSync(snapshotPath));
    const raw = readFileSync(snapshotPath, "utf-8");
    const parsed = JSON.parse(raw);
    assert.ok(typeof parsed.snapshotAt === "string");
    assert.ok(!isNaN(Date.parse(parsed.snapshotAt)));
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvbWNwLXNlcnZlci9zcmMvcmVhZGVycy9ncmFwaC50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBHU0QgTUNQIFNlcnZlciBcdTIwMTQga25vd2xlZGdlIGdyYXBoIHJlYWRlciB0ZXN0c1xuXG5pbXBvcnQgeyBkZXNjcmliZSwgaXQsIGJlZm9yZSwgYWZ0ZXIsIGJlZm9yZUVhY2gsIGFmdGVyRWFjaCB9IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7XG5pbXBvcnQgeyBta2RpclN5bmMsIHdyaXRlRmlsZVN5bmMsIHJtU3luYywgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jIH0gZnJvbSAnbm9kZTpmcyc7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJztcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gJ25vZGU6b3MnO1xuaW1wb3J0IHsgcmFuZG9tQnl0ZXMgfSBmcm9tICdub2RlOmNyeXB0byc7XG5cbmltcG9ydCB7XG4gIGJ1aWxkR3JhcGgsXG4gIHdyaXRlR3JhcGgsXG4gIHdyaXRlU25hcHNob3QsXG4gIGdyYXBoU3RhdHVzLFxuICBncmFwaFF1ZXJ5LFxuICBncmFwaERpZmYsXG59IGZyb20gJy4vZ3JhcGguanMnO1xuaW1wb3J0IHR5cGUgeyBLbm93bGVkZ2VHcmFwaCB9IGZyb20gJy4vZ3JhcGguanMnO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIEZpeHR1cmUgaGVscGVyc1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmZ1bmN0aW9uIHRtcFByb2plY3QoKTogc3RyaW5nIHtcbiAgY29uc3QgZGlyID0gam9pbih0bXBkaXIoKSwgYGdzZC1ncmFwaC10ZXN0LSR7cmFuZG9tQnl0ZXMoNCkudG9TdHJpbmcoJ2hleCcpfWApO1xuICBta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgcmV0dXJuIGRpcjtcbn1cblxuZnVuY3Rpb24gd3JpdGVGaXh0dXJlKGJhc2U6IHN0cmluZywgcmVsUGF0aDogc3RyaW5nLCBjb250ZW50OiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgZnVsbCA9IGpvaW4oYmFzZSwgcmVsUGF0aCk7XG4gIG1rZGlyU3luYyhqb2luKGZ1bGwsICcuLicpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhmdWxsLCBjb250ZW50LCAndXRmLTgnKTtcbn1cblxuZnVuY3Rpb24gbWFrZVByb2plY3RXaXRoQXJ0aWZhY3RzKHByb2plY3REaXI6IHN0cmluZyk6IHZvaWQge1xuICB3cml0ZUZpeHR1cmUocHJvamVjdERpciwgJy5nc2QvU1RBVEUubWQnLCBbXG4gICAgJyMgR1NEIFN0YXRlJyxcbiAgICAnJyxcbiAgICAnKipBY3RpdmUgTWlsZXN0b25lOioqIE0wMDE6IEF1dGggU3lzdGVtJyxcbiAgICAnKipBY3RpdmUgU2xpY2U6KiogUzAxOiBMb2dpbiBmbG93JyxcbiAgICAnKipQaGFzZToqKiBleGVjdXRpb24nLFxuICAgICcnLFxuICAgICcjIyBNaWxlc3RvbmUgUmVnaXN0cnknLFxuICAgICcnLFxuICAgICctIFx1RDgzRFx1REQwNCAqKk0wMDE6KiogQXV0aCBTeXN0ZW0nLFxuICAgICcnLFxuICAgICcjIyBOZXh0IEFjdGlvbicsXG4gICAgJycsXG4gICAgJ0V4ZWN1dGUgVDAxIGluIFMwMS4nLFxuICBdLmpvaW4oJ1xcbicpKTtcblxuICB3cml0ZUZpeHR1cmUocHJvamVjdERpciwgJy5nc2QvS05PV0xFREdFLm1kJywgW1xuICAgICcjIFByb2plY3QgS25vd2xlZGdlJyxcbiAgICAnJyxcbiAgICAnIyMgUnVsZXMnLFxuICAgICcnLFxuICAgICd8ICMgfCBTY29wZSB8IFJ1bGUgfCBXaHkgfCBBZGRlZCB8JyxcbiAgICAnfC0tLXwtLS0tLS0tfC0tLS0tLXwtLS0tLXwtLS0tLS0tfCcsXG4gICAgJ3wgSzAwMSB8IGF1dGggfCBIYXNoIHBhc3N3b3JkcyB3aXRoIGJjcnlwdCB8IFNlY3VyaXR5IHJlcXVpcmVtZW50IHwgbWFudWFsIHwnLFxuICAgICd8IEswMDIgfCBkYiB8IFVzZSB0cmFuc2FjdGlvbnMgZm9yIG11bHRpLXRhYmxlIHwgRGF0YSBjb25zaXN0ZW5jeSB8IGF1dG8gfCcsXG4gICAgJycsXG4gICAgJyMjIFBhdHRlcm5zJyxcbiAgICAnJyxcbiAgICAnfCAjIHwgUGF0dGVybiB8IFdoZXJlIHwgTm90ZXMgfCcsXG4gICAgJ3wtLS18LS0tLS0tLS0tfC0tLS0tLS18LS0tLS0tLXwnLFxuICAgICd8IFAwMDEgfCBTaW5nbGV0b24gc2VydmljZXMgfCBzZXJ2aWNlcy8gfCBQcmV2ZW50cyBkdXBsaWNhdGlvbiB8JyxcbiAgICAnJyxcbiAgICAnIyMgTGVzc29ucyBMZWFybmVkJyxcbiAgICAnJyxcbiAgICAnfCAjIHwgV2hhdCBIYXBwZW5lZCB8IFJvb3QgQ2F1c2UgfCBGaXggfCBTY29wZSB8JyxcbiAgICAnfC0tLXwtLS0tLS0tLS0tLS0tLXwtLS0tLS0tLS0tLS18LS0tLS18LS0tLS0tLXwnLFxuICAgICd8IEwwMDEgfCBDSSB0ZXN0cyBmYWlsZWQgfCBFbnYgZGlmZiB8IEFkZGVkIHNldHVwIHNjcmlwdCB8IHRlc3RpbmcgfCcsXG4gIF0uam9pbignXFxuJykpO1xuXG4gIHdyaXRlRml4dHVyZShwcm9qZWN0RGlyLCAnLmdzZC9taWxlc3RvbmVzL00wMDEvTTAwMS1ST0FETUFQLm1kJywgW1xuICAgICcjIE0wMDE6IEF1dGggU3lzdGVtJyxcbiAgICAnJyxcbiAgICAnIyMgVmlzaW9uJyxcbiAgICAnJyxcbiAgICAnQnVpbGQgYXV0aGVudGljYXRpb24gZm9yIHRoZSBwbGF0Zm9ybS4nLFxuICAgICcnLFxuICAgICcjIyBTbGljZSBPdmVydmlldycsXG4gICAgJycsXG4gICAgJ3wgSUQgfCBTbGljZSB8IFJpc2sgfCBEZXBlbmRzIHwgRG9uZSB8IEFmdGVyIHRoaXMgfCcsXG4gICAgJ3wtLS0tfC0tLS0tLS18LS0tLS0tfC0tLS0tLS0tLXwtLS0tLS18LS0tLS0tLS0tLS0tfCcsXG4gICAgJ3wgUzAxIHwgTG9naW4gZmxvdyB8IGxvdyB8IFx1MjAxNCB8IFx1RDgzRFx1REQwNCB8IFVzZXJzIGNhbiBsb2cgaW4gfCcsXG4gIF0uam9pbignXFxuJykpO1xuXG4gIHdyaXRlRml4dHVyZShwcm9qZWN0RGlyLCAnLmdzZC9taWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMS9TMDEtUExBTi5tZCcsIFtcbiAgICAnIyBTMDE6IExvZ2luIGZsb3cnLFxuICAgICcnLFxuICAgICcjIyBUYXNrcycsXG4gICAgJycsXG4gICAgJy0gWyBdICoqVDAxOiBJbXBsZW1lbnQgbG9naW4gZW5kcG9pbnQqKiBcdTIwMTQgQ29yZSBhdXRoIGxvZ2ljJyxcbiAgICAnLSBbIF0gKipUMDI6IEFkZCBzZXNzaW9uIG1hbmFnZW1lbnQqKiBcdTIwMTQgS2VlcCB1c2VycyBsb2dnZWQgaW4nLFxuICBdLmpvaW4oJ1xcbicpKTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBMRUFSTklOR1MubWQgZml4dHVyZSBoZWxwZXJzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZnVuY3Rpb24gd3JpdGVMZWFybmluZ3NGaXh0dXJlKHByb2plY3REaXI6IHN0cmluZywgbWlsZXN0b25lSWQ6IHN0cmluZywgY29udGVudDogc3RyaW5nKTogdm9pZCB7XG4gIHdyaXRlRml4dHVyZShwcm9qZWN0RGlyLCBgLmdzZC9taWxlc3RvbmVzLyR7bWlsZXN0b25lSWR9LyR7bWlsZXN0b25lSWR9LUxFQVJOSU5HUy5tZGAsIGNvbnRlbnQpO1xufVxuXG5jb25zdCBTQU1QTEVfTEVBUk5JTkdTID0gYC0tLVxucGhhc2U6IFwiTTAwMVwiXG5waGFzZV9uYW1lOiBcIlVzZXIgQXV0aFwiXG5wcm9qZWN0OiBcIm15LXByb2plY3RcIlxuZ2VuZXJhdGVkOiBcIjIwMjYtMDQtMTVUMTA6MDA6MDBaXCJcbmNvdW50czpcbiAgZGVjaXNpb25zOiAyXG4gIGxlc3NvbnM6IDFcbiAgcGF0dGVybnM6IDFcbiAgc3VycHJpc2VzOiAxXG5taXNzaW5nX2FydGlmYWN0czogW11cbi0tLVxuXG4jIExlYXJuaW5nczogVXNlciBBdXRoXG5cbiMjIERlY2lzaW9uc1xuLSBVc2UgSldUIGZvciBzdGF0ZWxlc3MgYXV0aCBhY3Jvc3Mgc2VydmljZXMuXG4gIFNvdXJjZTogTTAwMS1QTEFOLm1kL0FyY2hpdGVjdHVyZVxuXG4tIFN0b3JlIHJlZnJlc2ggdG9rZW5zIGluIEhUVFAtb25seSBjb29raWVzIG9ubHkuXG4gIFNvdXJjZTogTTAwMS1QTEFOLm1kL1NlY3VyaXR5XG5cbiMjIExlc3NvbnNcbi0gSW50ZWdyYXRpb24gdGVzdHMgbmVlZCBhIHJlYWwgREIgXHUyMDE0IG1vY2tzIG1pc3NlZCBtaWdyYXRpb24gYnVncy5cbiAgU291cmNlOiBNMDAxLVNVTU1BUlkubWQvVGVzdGluZ1xuXG4jIyBQYXR0ZXJuc1xuLSBSZXBvc2l0b3J5IHBhdHRlcm4gYWJzdHJhY3RzIERCIGFjY2VzcyBhbmQgc2ltcGxpZmllcyB0ZXN0aW5nLlxuICBTb3VyY2U6IE0wMDEtUExBTi5tZC9EZXNpZ25cblxuIyMgU3VycHJpc2VzXG4tIFRva2VuIGV4cGlyeSBlZGdlIGNhc2UgY2F1c2VkIHNpbGVudCBhdXRoIGZhaWx1cmVzIGluIHByb2QuXG4gIFNvdXJjZTogTTAwMS1TVU1NQVJZLm1kL0lzc3Vlc1xuYDtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBidWlsZEdyYXBoIHRlc3RzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZGVzY3JpYmUoJ2J1aWxkR3JhcGgnLCAoKSA9PiB7XG4gIGxldCBwcm9qZWN0RGlyOiBzdHJpbmc7XG5cbiAgYmVmb3JlKCgpID0+IHtcbiAgICBwcm9qZWN0RGlyID0gdG1wUHJvamVjdCgpO1xuICAgIG1ha2VQcm9qZWN0V2l0aEFydGlmYWN0cyhwcm9qZWN0RGlyKTtcbiAgfSk7XG5cbiAgYWZ0ZXIoKCkgPT4gcm1TeW5jKHByb2plY3REaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSk7XG5cbiAgaXQoJ3JldHVybnMgbm9kZUNvdW50ID4gMCBmb3IgYSBwcm9qZWN0IHdpdGggYXJ0aWZhY3RzJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGdyYXBoID0gYXdhaXQgYnVpbGRHcmFwaChwcm9qZWN0RGlyKTtcbiAgICBhc3NlcnQub2soZ3JhcGgubm9kZXMubGVuZ3RoID4gMCwgYEV4cGVjdGVkIG5vZGVzLCBnb3QgJHtncmFwaC5ub2Rlcy5sZW5ndGh9YCk7XG4gIH0pO1xuXG4gIGl0KCdwcm9kdWNlcyBhIG5vbi1lbXB0eSBzZXQgb2YgZWRnZXMgZm9yIGEgcHJvamVjdCB3aXRoIGFydGlmYWN0cycsIGFzeW5jICgpID0+IHtcbiAgICAvLyBQcmV2aW91cyBgZWRnZUNvdW50ID49IDBgIHdhcyBhIHB1cmUgdGF1dG9sb2d5LiBGb3IgYSBwcm9qZWN0XG4gICAgLy8gd2l0aCBTVEFURS9LTk9XTEVER0UvTEVBUk5JTkdTL21pbGVzdG9uZSBhcnRpZmFjdHMsIHRoZSBncmFwaFxuICAgIC8vIGJ1aWxkZXIgd2lyZXMgcmVsYXRpb25zaGlwcyBiZXR3ZWVuIHRoZSBkZXJpdmVkIG5vZGVzIFx1MjAxNCBvYnNlcnZlZFxuICAgIC8vIGVtcGlyaWNhbGx5IHRvIHByb2R1Y2UgXHUyMjY1IDMgZWRnZXMgZm9yIHRoZSBzdGFuZGFyZCBmaXh0dXJlLlxuICAgIGNvbnN0IGdyYXBoID0gYXdhaXQgYnVpbGRHcmFwaChwcm9qZWN0RGlyKTtcbiAgICBhc3NlcnQub2soXG4gICAgICBncmFwaC5lZGdlcy5sZW5ndGggPiAwLFxuICAgICAgYGV4cGVjdGVkIGVkZ2VzIGZvciBhIHByb2plY3Qgd2l0aCBhcnRpZmFjdHMuIG5vZGVzPSR7Z3JhcGgubm9kZXMubGVuZ3RofSwgZWRnZXM9JHtncmFwaC5lZGdlcy5sZW5ndGh9YCxcbiAgICApO1xuICAgIC8vIEV2ZXJ5IGVkZ2UgbXVzdCByZWZlcmVuY2Ugbm9kZXMgdGhhdCBhY3R1YWxseSBleGlzdCBpbiB0aGUgZ3JhcGguXG4gICAgY29uc3Qgbm9kZUlkcyA9IG5ldyBTZXQoZ3JhcGgubm9kZXMubWFwKChuKSA9PiBuLmlkKSk7XG4gICAgZm9yIChjb25zdCBlZGdlIG9mIGdyYXBoLmVkZ2VzKSB7XG4gICAgICBhc3NlcnQub2soXG4gICAgICAgIG5vZGVJZHMuaGFzKGVkZ2UuZnJvbSksXG4gICAgICAgIGBlZGdlLmZyb209XCIke2VkZ2UuZnJvbX1cIiBtdXN0IHJlZmVyZW5jZSBhbiBleGlzdGluZyBub2RlYCxcbiAgICAgICk7XG4gICAgICBhc3NlcnQub2soXG4gICAgICAgIG5vZGVJZHMuaGFzKGVkZ2UudG8pLFxuICAgICAgICBgZWRnZS50bz1cIiR7ZWRnZS50b31cIiBtdXN0IHJlZmVyZW5jZSBhbiBleGlzdGluZyBub2RlYCxcbiAgICAgICk7XG4gICAgfVxuICB9KTtcblxuICBpdCgnaW5jbHVkZXMgYnVpbHRBdCBJU08gdGltZXN0YW1wJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGdyYXBoID0gYXdhaXQgYnVpbGRHcmFwaChwcm9qZWN0RGlyKTtcbiAgICBhc3NlcnQub2sodHlwZW9mIGdyYXBoLmJ1aWx0QXQgPT09ICdzdHJpbmcnKTtcbiAgICBhc3NlcnQub2soIWlzTmFOKERhdGUucGFyc2UoZ3JhcGguYnVpbHRBdCkpKTtcbiAgfSk7XG5cbiAgaXQoJ3NraXBzIHVucGFyc2VhYmxlIGFydGlmYWN0IGFuZCBkb2VzIG5vdCB0aHJvdycsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYWRQcm9qZWN0ID0gdG1wUHJvamVjdCgpO1xuICAgIC8vIFdyaXRlIGEgY29ycnVwdC9taW5pbWFsIFNUQVRFLm1kIHRoYXQgaXMgdGVjaG5pY2FsbHkgdmFsaWQgYnV0IGVtcHR5XG4gICAgd3JpdGVGaXh0dXJlKGJhZFByb2plY3QsICcuZ3NkL1NUQVRFLm1kJywgJ25vdCB2YWxpZCBnc2Qgc3RhdGUgYXQgYWxsIFxcMFxcMFxcMCcpO1xuICAgIC8vIERvbid0IHRocm93LCBhbmQgZG9uJ3QgbG9zZSB0aGUgd2VsbC1mb3JtZWQgYnVpbHRBdCB0aW1lc3RhbXBcbiAgICAvLyAod2hpY2ggcHJldmlvdXMgYGdyYXBoLm5vZGVzLmxlbmd0aCA+PSAwYCB0YXV0b2xvZ3kgaWdub3JlZCkuXG4gICAgY29uc3QgZ3JhcGggPSBhd2FpdCBidWlsZEdyYXBoKGJhZFByb2plY3QpO1xuICAgIGFzc2VydC5vayhBcnJheS5pc0FycmF5KGdyYXBoLm5vZGVzKSwgXCJub2RlcyBtdXN0IGJlIGFuIGFycmF5XCIpO1xuICAgIGFzc2VydC5vayhBcnJheS5pc0FycmF5KGdyYXBoLmVkZ2VzKSwgXCJlZGdlcyBtdXN0IGJlIGFuIGFycmF5XCIpO1xuICAgIGFzc2VydC5vayhcbiAgICAgICFOdW1iZXIuaXNOYU4oRGF0ZS5wYXJzZShncmFwaC5idWlsdEF0KSksXG4gICAgICBcImJ1aWx0QXQgbXVzdCBiZSBhIHZhbGlkIElTTy04NjAxIHRpbWVzdGFtcCBldmVuIHdoZW4gYXJ0aWZhY3QgaXMgdW5wYXJzZWFibGVcIixcbiAgICApO1xuICAgIHJtU3luYyhiYWRQcm9qZWN0LCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH0pO1xuXG4gIGl0KCdyZXR1cm5zIGVtcHR5IGdyYXBoIGZvciBwcm9qZWN0IHdpdGggbm8gLmdzZC8gZGlyZWN0b3J5JywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGVtcHR5UHJvamVjdCA9IHRtcFByb2plY3QoKTtcbiAgICBjb25zdCBncmFwaCA9IGF3YWl0IGJ1aWxkR3JhcGgoZW1wdHlQcm9qZWN0KTtcbiAgICAvLyBQcmV2aW91cyBgZ3JhcGgubm9kZXMubGVuZ3RoID49IDBgIHdhcyBhIHRhdXRvbG9neS4gVGhlIHJlYWxcbiAgICAvLyBjb250cmFjdCBmb3IgYSAuZ3NkLWxlc3MgcHJvamVjdDogdHJ1bHkgZW1wdHkgZ3JhcGguXG4gICAgYXNzZXJ0LmRlZXBFcXVhbChncmFwaC5ub2RlcywgW10sIFwibm9kZXMgbXVzdCBiZSBlbXB0eSBmb3IgLmdzZC1sZXNzIHByb2plY3RcIik7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChncmFwaC5lZGdlcywgW10sIFwiZWRnZXMgbXVzdCBiZSBlbXB0eSBmb3IgLmdzZC1sZXNzIHByb2plY3RcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHR5cGVvZiBncmFwaC5idWlsdEF0LCAnc3RyaW5nJyk7XG4gICAgcm1TeW5jKGVtcHR5UHJvamVjdCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcblxuICBpdCgnbm9kZXMgaGF2ZSByZXF1aXJlZCBmaWVsZHM6IGlkLCBsYWJlbCwgdHlwZSwgY29uZmlkZW5jZScsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBncmFwaCA9IGF3YWl0IGJ1aWxkR3JhcGgocHJvamVjdERpcik7XG4gICAgZm9yIChjb25zdCBub2RlIG9mIGdyYXBoLm5vZGVzKSB7XG4gICAgICBhc3NlcnQub2sodHlwZW9mIG5vZGUuaWQgPT09ICdzdHJpbmcnLCAnbm9kZS5pZCBtdXN0IGJlIHN0cmluZycpO1xuICAgICAgYXNzZXJ0Lm9rKHR5cGVvZiBub2RlLmxhYmVsID09PSAnc3RyaW5nJywgJ25vZGUubGFiZWwgbXVzdCBiZSBzdHJpbmcnKTtcbiAgICAgIGFzc2VydC5vayh0eXBlb2Ygbm9kZS50eXBlID09PSAnc3RyaW5nJywgJ25vZGUudHlwZSBtdXN0IGJlIHN0cmluZycpO1xuICAgICAgYXNzZXJ0Lm9rKFxuICAgICAgICBub2RlLmNvbmZpZGVuY2UgPT09ICdFWFRSQUNURUQnIHx8XG4gICAgICAgIG5vZGUuY29uZmlkZW5jZSA9PT0gJ0lORkVSUkVEJyB8fFxuICAgICAgICBub2RlLmNvbmZpZGVuY2UgPT09ICdBTUJJR1VPVVMnLFxuICAgICAgICBgSW52YWxpZCBjb25maWRlbmNlOiAke25vZGUuY29uZmlkZW5jZX1gLFxuICAgICAgKTtcbiAgICB9XG4gIH0pO1xufSk7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gYnVpbGRHcmFwaCBcdTIwMTQgTEVBUk5JTkdTLm1kIHBhcnNpbmcgdGVzdHNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5kZXNjcmliZSgnYnVpbGRHcmFwaCBcdTIwMTQgTEVBUk5JTkdTLm1kIHBhcnNpbmcnLCAoKSA9PiB7XG4gIGxldCBwcm9qZWN0RGlyOiBzdHJpbmc7XG5cbiAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgcHJvamVjdERpciA9IHRtcFByb2plY3QoKTtcbiAgICAvLyBDcmVhdGUgbWluaW1hbCBtaWxlc3RvbmUgZGlyZWN0b3J5IHNvIHBhcnNlTWlsZXN0b25lRmlsZXMgZmluZHMgaXRcbiAgICBta2RpclN5bmMoam9pbihwcm9qZWN0RGlyLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgJ00wMDEnKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVMZWFybmluZ3NGaXh0dXJlKHByb2plY3REaXIsICdNMDAxJywgU0FNUExFX0xFQVJOSU5HUyk7XG4gIH0pO1xuXG4gIGFmdGVyRWFjaCgoKSA9PiBybVN5bmMocHJvamVjdERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcblxuICBpdCgnZXh0cmFjdHMgZGVjaXNpb24gbm9kZXMgZnJvbSAjIyBEZWNpc2lvbnMgc2VjdGlvbicsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBncmFwaCA9IGF3YWl0IGJ1aWxkR3JhcGgocHJvamVjdERpcik7XG4gICAgY29uc3QgZGVjaXNpb25zID0gZ3JhcGgubm9kZXMuZmlsdGVyKChuKSA9PiBuLnR5cGUgPT09ICdkZWNpc2lvbicgfHwgKG4udHlwZSA9PT0gJ3J1bGUnICYmIG4uaWQuc3RhcnRzV2l0aCgnZGVjaXNpb246JykpKTtcbiAgICAvLyBEZWNpc2lvbnMgc2hvdWxkIGJlIGV4dHJhY3RlZCB3aXRoIGEgJ2RlY2lzaW9uJyB0eXBlIChvciBzaW1pbGFyIGV4aXN0aW5nIHR5cGUpXG4gICAgY29uc3QgZGVjaXNpb25Ob2RlcyA9IGdyYXBoLm5vZGVzLmZpbHRlcigobikgPT4gbi5pZC5pbmNsdWRlcygnZGVjaXNpb246TTAwMScpKTtcbiAgICBhc3NlcnQub2soZGVjaXNpb25Ob2Rlcy5sZW5ndGggPj0gMiwgYEV4cGVjdGVkID49IDIgZGVjaXNpb24gbm9kZXMsIGdvdCAke2RlY2lzaW9uTm9kZXMubGVuZ3RofWApO1xuICB9KTtcblxuICBpdCgnZXh0cmFjdHMgbGVzc29uIG5vZGVzIGZyb20gIyMgTGVzc29ucyBzZWN0aW9uJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGdyYXBoID0gYXdhaXQgYnVpbGRHcmFwaChwcm9qZWN0RGlyKTtcbiAgICBjb25zdCBsZXNzb25Ob2RlcyA9IGdyYXBoLm5vZGVzLmZpbHRlcigobikgPT4gbi5pZC5pbmNsdWRlcygnbGVzc29uOk0wMDEnKSk7XG4gICAgYXNzZXJ0Lm9rKGxlc3Nvbk5vZGVzLmxlbmd0aCA+PSAxLCBgRXhwZWN0ZWQgPj0gMSBsZXNzb24gbm9kZSwgZ290ICR7bGVzc29uTm9kZXMubGVuZ3RofWApO1xuICAgIGFzc2VydC5vayhsZXNzb25Ob2Rlcy5ldmVyeSgobikgPT4gbi50eXBlID09PSAnbGVzc29uJyksICdBbGwgbGVzc29uIG5vZGVzIG11c3QgaGF2ZSB0eXBlIFwibGVzc29uXCInKTtcbiAgfSk7XG5cbiAgaXQoJ2V4dHJhY3RzIHBhdHRlcm4gbm9kZXMgZnJvbSAjIyBQYXR0ZXJucyBzZWN0aW9uJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGdyYXBoID0gYXdhaXQgYnVpbGRHcmFwaChwcm9qZWN0RGlyKTtcbiAgICBjb25zdCBwYXR0ZXJuTm9kZXMgPSBncmFwaC5ub2Rlcy5maWx0ZXIoKG4pID0+IG4uaWQuaW5jbHVkZXMoJ3BhdHRlcm46TTAwMScpKTtcbiAgICBhc3NlcnQub2socGF0dGVybk5vZGVzLmxlbmd0aCA+PSAxLCBgRXhwZWN0ZWQgPj0gMSBwYXR0ZXJuIG5vZGUsIGdvdCAke3BhdHRlcm5Ob2Rlcy5sZW5ndGh9YCk7XG4gICAgYXNzZXJ0Lm9rKHBhdHRlcm5Ob2Rlcy5ldmVyeSgobikgPT4gbi50eXBlID09PSAncGF0dGVybicpLCAnQWxsIHBhdHRlcm4gbm9kZXMgbXVzdCBoYXZlIHR5cGUgXCJwYXR0ZXJuXCInKTtcbiAgfSk7XG5cbiAgaXQoJ21hcHMgc3VycHJpc2VzIHRvIGxlc3NvbiBub2RlcycsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBncmFwaCA9IGF3YWl0IGJ1aWxkR3JhcGgocHJvamVjdERpcik7XG4gICAgLy8gU3VycHJpc2VzIHNob3VsZCBiZSBtYXBwZWQgdG8gbGVzc29uIHR5cGUgc2luY2Ugbm8gXCJzdXJwcmlzZVwiIE5vZGVUeXBlIGV4aXN0c1xuICAgIGNvbnN0IHN1cnByaXNlTm9kZXMgPSBncmFwaC5ub2Rlcy5maWx0ZXIoKG4pID0+IG4uaWQuaW5jbHVkZXMoJ3N1cnByaXNlOk0wMDEnKSk7XG4gICAgYXNzZXJ0Lm9rKHN1cnByaXNlTm9kZXMubGVuZ3RoID49IDEsIGBFeHBlY3RlZCA+PSAxIHN1cnByaXNlIG5vZGUsIGdvdCAke3N1cnByaXNlTm9kZXMubGVuZ3RofWApO1xuICAgIGFzc2VydC5vayhzdXJwcmlzZU5vZGVzLmV2ZXJ5KChuKSA9PiBuLnR5cGUgPT09ICdsZXNzb24nKSwgJ1N1cnByaXNlcyBtdXN0IGJlIG1hcHBlZCB0byB0eXBlIFwibGVzc29uXCInKTtcbiAgfSk7XG5cbiAgaXQoJ25vZGUgbGFiZWxzIGNvbnRhaW4gdGhlIGxlYXJuaW5nIHRleHQnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgZ3JhcGggPSBhd2FpdCBidWlsZEdyYXBoKHByb2plY3REaXIpO1xuICAgIGNvbnN0IGhhc0p3dERlY2lzaW9uID0gZ3JhcGgubm9kZXMuc29tZSgobikgPT5cbiAgICAgIG4ubGFiZWwudG9Mb3dlckNhc2UoKS5pbmNsdWRlcygnand0JykgfHwgbi5kZXNjcmlwdGlvbj8udG9Mb3dlckNhc2UoKS5pbmNsdWRlcygnand0JyksXG4gICAgKTtcbiAgICBhc3NlcnQub2soaGFzSnd0RGVjaXNpb24sICdFeHBlY3RlZCBhIG5vZGUgZGVzY3JpYmluZyB0aGUgSldUIGRlY2lzaW9uJyk7XG4gIH0pO1xuXG4gIGl0KCdub2RlIGRlc2NyaXB0aW9uIGluY2x1ZGVzIHNvdXJjZSBhdHRyaWJ1dGlvbicsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBncmFwaCA9IGF3YWl0IGJ1aWxkR3JhcGgocHJvamVjdERpcik7XG4gICAgY29uc3QgbGVhcm5pbmdOb2RlcyA9IGdyYXBoLm5vZGVzLmZpbHRlcigobikgPT5cbiAgICAgIG4uaWQuaW5jbHVkZXMoJzpNMDAxOicpIHx8IG4uaWQubWF0Y2goLzooZGVjaXNpb258bGVzc29ufHBhdHRlcm58c3VycHJpc2UpOk0wMDEvKSxcbiAgICApO1xuICAgIGNvbnN0IHdpdGhTb3VyY2UgPSBsZWFybmluZ05vZGVzLmZpbHRlcigobikgPT4gbi5kZXNjcmlwdGlvbj8uaW5jbHVkZXMoJ1NvdXJjZTonKSB8fCBuLmRlc2NyaXB0aW9uPy5pbmNsdWRlcygnTTAwMS1QTEFOJykpO1xuICAgIGFzc2VydC5vayh3aXRoU291cmNlLmxlbmd0aCA+IDAsICdFeHBlY3RlZCBhdCBsZWFzdCBvbmUgbm9kZSB3aXRoIHNvdXJjZSBhdHRyaWJ1dGlvbiBpbiBkZXNjcmlwdGlvbicpO1xuICB9KTtcblxuICBpdCgnYWRkcyByZWxhdGVzX3RvIGVkZ2UgZnJvbSBsZWFybmluZyBub2RlIHRvIG1pbGVzdG9uZSBub2RlJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGdyYXBoID0gYXdhaXQgYnVpbGRHcmFwaChwcm9qZWN0RGlyKTtcbiAgICBjb25zdCBlZGdlc1RvTWlsZXN0b25lID0gZ3JhcGguZWRnZXMuZmlsdGVyKFxuICAgICAgKGUpID0+IGUudG8gPT09ICdtaWxlc3RvbmU6TTAwMScgfHwgZS5mcm9tID09PSAnbWlsZXN0b25lOk0wMDEnLFxuICAgICk7XG4gICAgLy8gQXQgbGVhc3Qgb25lIGxlYXJuaW5nIG5vZGUgc2hvdWxkIHJlbGF0ZSB0byB0aGUgbWlsZXN0b25lXG4gICAgY29uc3QgbGVhcm5pbmdFZGdlcyA9IGdyYXBoLmVkZ2VzLmZpbHRlcihcbiAgICAgIChlKSA9PiAoZS5mcm9tLmluY2x1ZGVzKCdNMDAxJykgJiYgKGUudHlwZSA9PT0gJ3JlbGF0ZXNfdG8nIHx8IGUudHlwZSA9PT0gJ2NvbnRhaW5zJykpIHx8XG4gICAgICAgICAgICAgIChlLnRvLmluY2x1ZGVzKCdNMDAxJykgJiYgZS50eXBlID09PSAncmVsYXRlc190bycpLFxuICAgICk7XG4gICAgYXNzZXJ0Lm9rKGxlYXJuaW5nRWRnZXMubGVuZ3RoID4gMCB8fCBlZGdlc1RvTWlsZXN0b25lLmxlbmd0aCA+IDAsXG4gICAgICAnRXhwZWN0ZWQgZWRnZXMgY29ubmVjdGluZyBsZWFybmluZyBub2RlcyB0byBtaWxlc3RvbmUnKTtcbiAgfSk7XG5cbiAgaXQoJ3NraXBzIExFQVJOSU5HUy5tZCBncmFjZWZ1bGx5IHdoZW4gZmlsZSBpcyBtYWxmb3JtZWQnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFkUHJvamVjdCA9IHRtcFByb2plY3QoKTtcbiAgICBta2RpclN5bmMoam9pbihiYWRQcm9qZWN0LCAnLmdzZCcsICdtaWxlc3RvbmVzJywgJ00wMDInKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVMZWFybmluZ3NGaXh0dXJlKGJhZFByb2plY3QsICdNMDAyJywgJ1xcMFxcMFxcMCBub3QgdmFsaWQgeWFtbCBvciBtYXJrZG93biBcXDBcXDBcXDAnKTtcbiAgICAvLyBNdXN0IG5vdCB0aHJvdyBBTkQgbXVzdCBub3QgcHJvZHVjZSBnYXJiYWdlIGxlYXJuaW5nIG5vZGVzIGZyb21cbiAgICAvLyB0aGUgYmluYXJ5IGNvbnRlbnRzIChwcmV2aW91cyBgbm9kZXMubGVuZ3RoID49IDBgIHRhdXRvbG9neVxuICAgIC8vIGFsbG93ZWQgZWl0aGVyIG91dGNvbWUpLlxuICAgIGNvbnN0IGdyYXBoID0gYXdhaXQgYnVpbGRHcmFwaChiYWRQcm9qZWN0KTtcbiAgICBhc3NlcnQub2soQXJyYXkuaXNBcnJheShncmFwaC5ub2RlcykpO1xuICAgIGFzc2VydC5lcXVhbCh0eXBlb2YgZ3JhcGguYnVpbHRBdCwgJ3N0cmluZycpO1xuICAgIGNvbnN0IG0wMDJMZWFybmluZ05vZGVzID0gZ3JhcGgubm9kZXMuZmlsdGVyKFxuICAgICAgKG4pID0+IG4uaWQuaW5jbHVkZXMoJ00wMDInKSAmJiBuLnR5cGUgIT09ICdtaWxlc3RvbmUnLFxuICAgICk7XG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgbTAwMkxlYXJuaW5nTm9kZXMubGVuZ3RoLFxuICAgICAgMCxcbiAgICAgIFwibWFsZm9ybWVkIExFQVJOSU5HUy5tZCBtdXN0IG5vdCBwcm9kdWNlIGFueSBub24tbWlsZXN0b25lIG5vZGVzIFwiICtcbiAgICAgICAgYChnb3Q6ICR7SlNPTi5zdHJpbmdpZnkobTAwMkxlYXJuaW5nTm9kZXMubWFwKChuKSA9PiBuLmlkKSl9KWAsXG4gICAgKTtcbiAgICBybVN5bmMoYmFkUHJvamVjdCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcblxuICBpdCgncHJvZHVjZXMgbm8gbGVhcm5pbmcgbm9kZXMgd2hlbiBhbGwgc2VjdGlvbnMgYXJlIGVtcHR5JywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGVtcHR5UHJvamVjdCA9IHRtcFByb2plY3QoKTtcbiAgICBta2RpclN5bmMoam9pbihlbXB0eVByb2plY3QsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMycpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUxlYXJuaW5nc0ZpeHR1cmUoZW1wdHlQcm9qZWN0LCAnTTAwMycsIGAtLS1cbnBoYXNlOiBcIk0wMDNcIlxucGhhc2VfbmFtZTogXCJFbXB0eVwiXG5wcm9qZWN0OiBcInRlc3RcIlxuZ2VuZXJhdGVkOiBcIjIwMjYtMDQtMTVUMTA6MDA6MDBaXCJcbmNvdW50czpcbiAgZGVjaXNpb25zOiAwXG4gIGxlc3NvbnM6IDBcbiAgcGF0dGVybnM6IDBcbiAgc3VycHJpc2VzOiAwXG5taXNzaW5nX2FydGlmYWN0czogW11cbi0tLVxuXG4jIExlYXJuaW5nczogRW1wdHlcblxuIyMgRGVjaXNpb25zXG5cbiMjIExlc3NvbnNcblxuIyMgUGF0dGVybnNcblxuIyMgU3VycHJpc2VzXG5gKTtcbiAgICBjb25zdCBncmFwaCA9IGF3YWl0IGJ1aWxkR3JhcGgoZW1wdHlQcm9qZWN0KTtcbiAgICBjb25zdCBsZWFybmluZ05vZGVzID0gZ3JhcGgubm9kZXMuZmlsdGVyKChuKSA9PlxuICAgICAgbi5pZC5pbmNsdWRlcygnZGVjaXNpb246TTAwMycpIHx8XG4gICAgICBuLmlkLmluY2x1ZGVzKCdsZXNzb246TTAwMycpIHx8XG4gICAgICBuLmlkLmluY2x1ZGVzKCdwYXR0ZXJuOk0wMDMnKSB8fFxuICAgICAgbi5pZC5pbmNsdWRlcygnc3VycHJpc2U6TTAwMycpLFxuICAgICk7XG4gICAgYXNzZXJ0LmVxdWFsKGxlYXJuaW5nTm9kZXMubGVuZ3RoLCAwLCAnRW1wdHkgc2VjdGlvbnMgc2hvdWxkIHByb2R1Y2Ugbm8gbm9kZXMnKTtcbiAgICBybVN5bmMoZW1wdHlQcm9qZWN0LCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH0pO1xuXG4gIGl0KCdkb2VzIG5vdCBjcmFzaCB3aGVuIExFQVJOSU5HUy5tZCBpcyBtaXNzaW5nIGVudGlyZWx5JywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IG5vTGVhcm5pbmdzUHJvamVjdCA9IHRtcFByb2plY3QoKTtcbiAgICBta2RpclN5bmMoam9pbihub0xlYXJuaW5nc1Byb2plY3QsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwNCcpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAvLyBObyBMRUFSTklOR1MubWQgZmlsZSB3cml0dGVuLiBQcmV2aW91cyB0YXV0b2xvZ3kgKG5vZGVzLmxlbmd0aCA+PSAwKVxuICAgIC8vIHBhc3NlZCByZWdhcmRsZXNzIG9mIHdoZXRoZXIgdGhlIGdyYXBoIHdhcyBzdHJ1Y3R1cmFsbHkgdmFsaWQ7XG4gICAgLy8gYXNzZXJ0IHJlYWwgc2hhcGUgKyBuby1sZWFybmluZ3Mgb3V0Y29tZS5cbiAgICBjb25zdCBncmFwaCA9IGF3YWl0IGJ1aWxkR3JhcGgobm9MZWFybmluZ3NQcm9qZWN0KTtcbiAgICBhc3NlcnQub2soQXJyYXkuaXNBcnJheShncmFwaC5ub2RlcykpO1xuICAgIGFzc2VydC5lcXVhbCh0eXBlb2YgZ3JhcGguYnVpbHRBdCwgJ3N0cmluZycpO1xuICAgIC8vIFN1cnByaXNlcyBhcmUgc3RvcmVkIGFzIG5vZGVzIG9mIHR5cGUgJ2xlc3Nvbicgd2l0aCBpZC1wcmVmaXhcbiAgICAvLyAnc3VycHJpc2U6JyAoc2VlIGdyYXBoLnRzOjQ0Mik7IHRoZSBsaXRlcmFsICdzdXJwcmlzZScgd2FzIG5ldmVyIGFcbiAgICAvLyBtZW1iZXIgb2YgTm9kZVR5cGUsIHNvIHRoZSBjb21wYXJpc29uIHdhcyBhIHNpbGVudGx5LWFsd2F5cy1mYWxzZVxuICAgIC8vIHRhdXRvbG9neSB0aGF0IHRyaWdnZXJlZCBUUzIzNjcgdW5kZXIgc3RyaWN0IGNoZWNrcy5cbiAgICBjb25zdCBsZWFybmluZ05vZGVzID0gZ3JhcGgubm9kZXMuZmlsdGVyKFxuICAgICAgKG4pID0+IG4udHlwZSA9PT0gJ2RlY2lzaW9uJyB8fCBuLnR5cGUgPT09ICdsZXNzb24nIHx8IG4udHlwZSA9PT0gJ3BhdHRlcm4nLFxuICAgICk7XG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgbGVhcm5pbmdOb2Rlcy5sZW5ndGgsXG4gICAgICAwLFxuICAgICAgYG5vIExFQVJOSU5HUy5tZCBcdTIxOTIgbm8gbGVhcm5pbmcgbm9kZXMgKGdvdDogJHtKU09OLnN0cmluZ2lmeShsZWFybmluZ05vZGVzLm1hcCgobikgPT4gbi5pZCkpfSlgLFxuICAgICk7XG4gICAgcm1TeW5jKG5vTGVhcm5pbmdzUHJvamVjdCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcbn0pO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIHdyaXRlR3JhcGggdGVzdHNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5kZXNjcmliZSgnd3JpdGVHcmFwaCcsICgpID0+IHtcbiAgbGV0IHByb2plY3REaXI6IHN0cmluZztcbiAgbGV0IGdyYXBoOiBLbm93bGVkZ2VHcmFwaDtcblxuICBiZWZvcmUoYXN5bmMgKCkgPT4ge1xuICAgIHByb2plY3REaXIgPSB0bXBQcm9qZWN0KCk7XG4gICAgbWFrZVByb2plY3RXaXRoQXJ0aWZhY3RzKHByb2plY3REaXIpO1xuICAgIGdyYXBoID0gYXdhaXQgYnVpbGRHcmFwaChwcm9qZWN0RGlyKTtcbiAgfSk7XG5cbiAgYWZ0ZXIoKCkgPT4gcm1TeW5jKHByb2plY3REaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSk7XG5cbiAgaXQoJ2NyZWF0ZXMgZ3JhcGguanNvbiBpbiAuZ3NkL2dyYXBocy8gYWZ0ZXIgd3JpdGVHcmFwaCgpJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGdzZFJvb3QgPSBqb2luKHByb2plY3REaXIsICcuZ3NkJyk7XG4gICAgYXdhaXQgd3JpdGVHcmFwaChnc2RSb290LCBncmFwaCk7XG4gICAgY29uc3QgZ3JhcGhQYXRoID0gam9pbihnc2RSb290LCAnZ3JhcGhzJywgJ2dyYXBoLmpzb24nKTtcbiAgICBhc3NlcnQub2soZXhpc3RzU3luYyhncmFwaFBhdGgpLCBgRXhwZWN0ZWQgJHtncmFwaFBhdGh9IHRvIGV4aXN0YCk7XG4gIH0pO1xuXG4gIGl0KCd3cml0ZSBpcyBhdG9taWMgXHUyMDE0IG5vIHRlbXAgZmlsZSByZW1haW5zIGFmdGVyIHdyaXRlR3JhcGgoKScsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBnc2RSb290ID0gam9pbihwcm9qZWN0RGlyLCAnLmdzZCcpO1xuICAgIGF3YWl0IHdyaXRlR3JhcGgoZ3NkUm9vdCwgZ3JhcGgpO1xuICAgIGNvbnN0IHRtcFBhdGggPSBqb2luKGdzZFJvb3QsICdncmFwaHMnLCAnZ3JhcGgudG1wLmpzb24nKTtcbiAgICBhc3NlcnQub2soIWV4aXN0c1N5bmModG1wUGF0aCksICdUZW1wIGZpbGUgc2hvdWxkIG5vdCBleGlzdCBhZnRlciBzdWNjZXNzZnVsIHdyaXRlJyk7XG4gIH0pO1xuXG4gIGl0KCd3cml0dGVuIGdyYXBoLmpzb24gaXMgdmFsaWQgSlNPTiB3aXRoIG5vZGVzIGFuZCBlZGdlcycsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBnc2RSb290ID0gam9pbihwcm9qZWN0RGlyLCAnLmdzZCcpO1xuICAgIGF3YWl0IHdyaXRlR3JhcGgoZ3NkUm9vdCwgZ3JhcGgpO1xuICAgIGNvbnN0IHJhdyA9IHJlYWRGaWxlU3luYyhqb2luKGdzZFJvb3QsICdncmFwaHMnLCAnZ3JhcGguanNvbicpLCAndXRmLTgnKTtcbiAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHJhdykgYXMgS25vd2xlZGdlR3JhcGg7XG4gICAgYXNzZXJ0Lm9rKEFycmF5LmlzQXJyYXkocGFyc2VkLm5vZGVzKSk7XG4gICAgYXNzZXJ0Lm9rKEFycmF5LmlzQXJyYXkocGFyc2VkLmVkZ2VzKSk7XG4gICAgYXNzZXJ0Lm9rKHR5cGVvZiBwYXJzZWQuYnVpbHRBdCA9PT0gJ3N0cmluZycpO1xuICB9KTtcbn0pO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIGdyYXBoU3RhdHVzIHRlc3RzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZGVzY3JpYmUoJ2dyYXBoU3RhdHVzJywgKCkgPT4ge1xuICBsZXQgcHJvamVjdERpcjogc3RyaW5nO1xuXG4gIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgIHByb2plY3REaXIgPSB0bXBQcm9qZWN0KCk7XG4gIH0pO1xuXG4gIGFmdGVyRWFjaCgoKSA9PiBybVN5bmMocHJvamVjdERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcblxuICBpdCgncmV0dXJucyB7IGV4aXN0czogZmFsc2UgfSB3aGVuIG5vIGdyYXBoLmpzb24gZXhpc3RzJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHN0YXR1cyA9IGF3YWl0IGdyYXBoU3RhdHVzKHByb2plY3REaXIpO1xuICAgIGFzc2VydC5lcXVhbChzdGF0dXMuZXhpc3RzLCBmYWxzZSk7XG4gIH0pO1xuXG4gIGl0KCdyZXR1cm5zIHsgZXhpc3RzOiB0cnVlLCBub2RlQ291bnQsIGVkZ2VDb3VudCwgYWdlSG91cnMgfSB3aGVuIGdyYXBoIGV4aXN0cycsIGFzeW5jICgpID0+IHtcbiAgICBtYWtlUHJvamVjdFdpdGhBcnRpZmFjdHMocHJvamVjdERpcik7XG4gICAgY29uc3QgZ3NkUm9vdCA9IGpvaW4ocHJvamVjdERpciwgJy5nc2QnKTtcbiAgICBjb25zdCBncmFwaCA9IGF3YWl0IGJ1aWxkR3JhcGgocHJvamVjdERpcik7XG4gICAgYXdhaXQgd3JpdGVHcmFwaChnc2RSb290LCBncmFwaCk7XG5cbiAgICBjb25zdCBzdGF0dXMgPSBhd2FpdCBncmFwaFN0YXR1cyhwcm9qZWN0RGlyKTtcbiAgICBhc3NlcnQuZXF1YWwoc3RhdHVzLmV4aXN0cywgdHJ1ZSk7XG4gICAgYXNzZXJ0Lm9rKHR5cGVvZiBzdGF0dXMubm9kZUNvdW50ID09PSAnbnVtYmVyJyk7XG4gICAgYXNzZXJ0Lm9rKHR5cGVvZiBzdGF0dXMuZWRnZUNvdW50ID09PSAnbnVtYmVyJyk7XG4gICAgYXNzZXJ0Lm9rKHR5cGVvZiBzdGF0dXMuYWdlSG91cnMgPT09ICdudW1iZXInKTtcbiAgICBhc3NlcnQub2soc3RhdHVzLmFnZUhvdXJzID49IDApO1xuICB9KTtcblxuICBpdCgnc3RhbGUgPSBmYWxzZSBmb3IgYSBmcmVzaGx5IGJ1aWx0IGdyYXBoJywgYXN5bmMgKCkgPT4ge1xuICAgIG1ha2VQcm9qZWN0V2l0aEFydGlmYWN0cyhwcm9qZWN0RGlyKTtcbiAgICBjb25zdCBnc2RSb290ID0gam9pbihwcm9qZWN0RGlyLCAnLmdzZCcpO1xuICAgIGNvbnN0IGdyYXBoID0gYXdhaXQgYnVpbGRHcmFwaChwcm9qZWN0RGlyKTtcbiAgICBhd2FpdCB3cml0ZUdyYXBoKGdzZFJvb3QsIGdyYXBoKTtcblxuICAgIGNvbnN0IHN0YXR1cyA9IGF3YWl0IGdyYXBoU3RhdHVzKHByb2plY3REaXIpO1xuICAgIGFzc2VydC5lcXVhbChzdGF0dXMuc3RhbGUsIGZhbHNlKTtcbiAgfSk7XG5cbiAgaXQoJ3N0YWxlID0gdHJ1ZSBmb3IgYSBncmFwaCBvbGRlciB0aGFuIDI0aCAoYnVpbHRBdCBiYWNrZGF0ZWQpJywgYXN5bmMgKCkgPT4ge1xuICAgIG1ha2VQcm9qZWN0V2l0aEFydGlmYWN0cyhwcm9qZWN0RGlyKTtcbiAgICBjb25zdCBnc2RSb290ID0gam9pbihwcm9qZWN0RGlyLCAnLmdzZCcpO1xuICAgIG1rZGlyU3luYyhqb2luKGdzZFJvb3QsICdncmFwaHMnKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgICAvLyBXcml0ZSBhIGdyYXBoIHdpdGggYSBidWlsdEF0IDI1IGhvdXJzIGFnb1xuICAgIGNvbnN0IG9sZEdyYXBoOiBLbm93bGVkZ2VHcmFwaCA9IHtcbiAgICAgIG5vZGVzOiBbXSxcbiAgICAgIGVkZ2VzOiBbXSxcbiAgICAgIGJ1aWx0QXQ6IG5ldyBEYXRlKERhdGUubm93KCkgLSAyNSAqIDYwICogNjAgKiAxMDAwKS50b0lTT1N0cmluZygpLFxuICAgIH07XG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4oZ3NkUm9vdCwgJ2dyYXBocycsICdncmFwaC5qc29uJyksXG4gICAgICBKU09OLnN0cmluZ2lmeShvbGRHcmFwaCksXG4gICAgICAndXRmLTgnLFxuICAgICk7XG5cbiAgICBjb25zdCBzdGF0dXMgPSBhd2FpdCBncmFwaFN0YXR1cyhwcm9qZWN0RGlyKTtcbiAgICBhc3NlcnQuZXF1YWwoc3RhdHVzLmV4aXN0cywgdHJ1ZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHN0YXR1cy5zdGFsZSwgdHJ1ZSk7XG4gIH0pO1xufSk7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gZ3JhcGhRdWVyeSB0ZXN0c1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmRlc2NyaWJlKCdncmFwaFF1ZXJ5JywgKCkgPT4ge1xuICBsZXQgcHJvamVjdERpcjogc3RyaW5nO1xuXG4gIGJlZm9yZShhc3luYyAoKSA9PiB7XG4gICAgcHJvamVjdERpciA9IHRtcFByb2plY3QoKTtcbiAgICBtYWtlUHJvamVjdFdpdGhBcnRpZmFjdHMocHJvamVjdERpcik7XG4gICAgY29uc3QgZ3NkUm9vdCA9IGpvaW4ocHJvamVjdERpciwgJy5nc2QnKTtcbiAgICBjb25zdCBncmFwaCA9IGF3YWl0IGJ1aWxkR3JhcGgocHJvamVjdERpcik7XG4gICAgYXdhaXQgd3JpdGVHcmFwaChnc2RSb290LCBncmFwaCk7XG4gIH0pO1xuXG4gIGFmdGVyKCgpID0+IHJtU3luYyhwcm9qZWN0RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpO1xuXG4gIGl0KCdyZXR1cm5zIG1hdGNoaW5nIG5vZGVzIGZvciBhIGtub3duIHRlcm0nLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZ3JhcGhRdWVyeShwcm9qZWN0RGlyLCAnYXV0aCcpO1xuICAgIGFzc2VydC5vayhBcnJheS5pc0FycmF5KHJlc3VsdC5ub2RlcykpO1xuICAgIC8vIFNob3VsZCBtYXRjaCBub2RlcyB3aXRoICdhdXRoJyBpbiBsYWJlbCBvciBkZXNjcmlwdGlvblxuICAgIGFzc2VydC5vayhyZXN1bHQubm9kZXMubGVuZ3RoID4gMCwgJ0V4cGVjdGVkIGF0IGxlYXN0IG9uZSBtYXRjaCBmb3IgXCJhdXRoXCInKTtcbiAgfSk7XG5cbiAgaXQoJ3JldHVybnMgZW1wdHkgYXJyYXkgZm9yIGEgdGVybSB0aGF0IG1hdGNoZXMgbm90aGluZycsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBncmFwaFF1ZXJ5KHByb2plY3REaXIsICd4eHh4eHhub3Rmb3VuZDk5OXp6eicpO1xuICAgIGFzc2VydC5vayhBcnJheS5pc0FycmF5KHJlc3VsdC5ub2RlcykpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQubm9kZXMubGVuZ3RoLCAwKTtcbiAgfSk7XG5cbiAgaXQoJ3NlYXJjaCBpcyBjYXNlLWluc2Vuc2l0aXZlJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGxvd2VyID0gYXdhaXQgZ3JhcGhRdWVyeShwcm9qZWN0RGlyLCAnYXV0aCcpO1xuICAgIGNvbnN0IHVwcGVyID0gYXdhaXQgZ3JhcGhRdWVyeShwcm9qZWN0RGlyLCAnQVVUSCcpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwoXG4gICAgICBsb3dlci5ub2Rlcy5tYXAoKG4pID0+IG4uaWQpLnNvcnQoKSxcbiAgICAgIHVwcGVyLm5vZGVzLm1hcCgobikgPT4gbi5pZCkuc29ydCgpLFxuICAgICk7XG4gIH0pO1xuXG4gIGl0KCdidWRnZXQgdHJpbXMgQU1CSUdVT1VTIGVkZ2VzIGZpcnN0IFx1MjAxNCBrZWVwcyBJTkZFUlJFRCBlZGdlIHdoZW4gYnVkZ2V0IG9ubHkgZm9yY2VzIG9uZSBkcm9wJywgYXN5bmMgKCkgPT4ge1xuICAgIC8vIFByZXZpb3VzIHZlcnNpb24gb25seSBhc3NlcnRlZCB0aGUgc2VlZCBub2RlIHJlbWFpbmVkIFx1MjAxNCB0aGUgdGVzdFxuICAgIC8vIHRpdGxlIGNsYWltZWQgQU1CSUdVT1VTIHdhcyB0cmltbWVkIGZpcnN0IGJ1dCBuZXZlciBjaGVja2VkLlxuICAgIC8vIGFwcGx5QnVkZ2V0IChncmFwaC50czo2ODUpIGRyb3BzIEFNQklHVU9VUyBlZGdlcyBmaXJzdCwgdGhlblxuICAgIC8vIElORkVSUkVELCB0aGVuIGhhcmQtdHJpbXMgdG8gc2VlZC1vbmx5LiBCdWRnZXQgaGVyZSBpcyBpbiB0b2tlbnNcbiAgICAvLyAobm9kZXMgXHUwMEQ3IDIwICsgZWRnZXMgXHUwMEQ3IDEwKS4gV2l0aCAzIG5vZGVzICg2MCkgKyAyIGVkZ2VzICgyMCkgPSA4MCxcbiAgICAvLyBhIGJ1ZGdldCBvZiA3MCBmb3JjZXMgZXhhY3RseSB0aGUgQU1CSUdVT1VTLWVkZ2UgZHJvcCBhbmQgc3RvcHNcbiAgICAvLyAoNzAgPiA3MCBpcyBmYWxzZSksIGxlYXZpbmcgdGhlIElORkVSUkVEIGVkZ2UgaW50YWN0LlxuICAgIGNvbnN0IGdzZFJvb3QgPSBqb2luKHByb2plY3REaXIsICcuZ3NkJyk7XG4gICAgY29uc3QgbWl4ZWRHcmFwaDogS25vd2xlZGdlR3JhcGggPSB7XG4gICAgICBidWlsdEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICBub2RlczogW1xuICAgICAgICB7IGlkOiAnbjEnLCBsYWJlbDogJ3NlZWQgbm9kZSBidWRnZXQnLCB0eXBlOiAnbWlsZXN0b25lJywgY29uZmlkZW5jZTogJ0VYVFJBQ1RFRCcgfSxcbiAgICAgICAgeyBpZDogJ24yJywgbGFiZWw6ICdjb25uZWN0ZWQgdmlhIEFNQklHVU9VUycsIHR5cGU6ICd0YXNrJywgY29uZmlkZW5jZTogJ0FNQklHVU9VUycgfSxcbiAgICAgICAgeyBpZDogJ24zJywgbGFiZWw6ICdjb25uZWN0ZWQgdmlhIElORkVSUkVEJywgdHlwZTogJ3Rhc2snLCBjb25maWRlbmNlOiAnSU5GRVJSRUQnIH0sXG4gICAgICBdLFxuICAgICAgZWRnZXM6IFtcbiAgICAgICAgeyBmcm9tOiAnbjEnLCB0bzogJ24yJywgdHlwZTogJ2NvbnRhaW5zJywgY29uZmlkZW5jZTogJ0FNQklHVU9VUycgfSxcbiAgICAgICAgeyBmcm9tOiAnbjEnLCB0bzogJ24zJywgdHlwZTogJ2NvbnRhaW5zJywgY29uZmlkZW5jZTogJ0lORkVSUkVEJyB9LFxuICAgICAgXSxcbiAgICB9O1xuICAgIGF3YWl0IHdyaXRlR3JhcGgoZ3NkUm9vdCwgbWl4ZWRHcmFwaCk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBncmFwaFF1ZXJ5KHByb2plY3REaXIsICdzZWVkIG5vZGUgYnVkZ2V0JywgNzApO1xuICAgIGFzc2VydC5vayhyZXN1bHQubm9kZXMuc29tZSgobikgPT4gbi5pZCA9PT0gJ24xJyksIFwic2VlZCBtdXN0IHJlbWFpblwiKTtcblxuICAgIGNvbnN0IGhhc0FtYmlndW91c0VkZ2UgPSByZXN1bHQuZWRnZXMuc29tZShcbiAgICAgIChlKSA9PiBlLmZyb20gPT09ICduMScgJiYgZS50byA9PT0gJ24yJyAmJiBlLmNvbmZpZGVuY2UgPT09ICdBTUJJR1VPVVMnLFxuICAgICk7XG4gICAgY29uc3QgaGFzSW5mZXJyZWRFZGdlID0gcmVzdWx0LmVkZ2VzLnNvbWUoXG4gICAgICAoZSkgPT4gZS5mcm9tID09PSAnbjEnICYmIGUudG8gPT09ICduMycgJiYgZS5jb25maWRlbmNlID09PSAnSU5GRVJSRUQnLFxuICAgICk7XG5cbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICBoYXNBbWJpZ3VvdXNFZGdlLFxuICAgICAgZmFsc2UsXG4gICAgICBcIkFNQklHVU9VUyBlZGdlIG11c3QgYmUgdHJpbW1lZCBGSVJTVCB3aGVuIGJ1ZGdldCBpcyB0aWdodFwiLFxuICAgICk7XG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgaGFzSW5mZXJyZWRFZGdlLFxuICAgICAgdHJ1ZSxcbiAgICAgIFwiSU5GRVJSRUQgZWRnZSBtdXN0IHN1cnZpdmUgd2hlbiBidWRnZXQgb25seSBmb3JjZXMgdGhlIEFNQklHVU9VUyBkcm9wXCIsXG4gICAgKTtcblxuICAgIC8vIFJlc3RvcmUgdGhlIG9yaWdpbmFsIGdyYXBoXG4gICAgY29uc3Qgb3JpZ2luYWxHcmFwaCA9IGF3YWl0IGJ1aWxkR3JhcGgocHJvamVjdERpcik7XG4gICAgYXdhaXQgd3JpdGVHcmFwaChnc2RSb290LCBvcmlnaW5hbEdyYXBoKTtcbiAgfSk7XG59KTtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyB3cml0ZVNuYXBzaG90ICsgZ3JhcGhEaWZmIHRlc3RzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZGVzY3JpYmUoJ2dyYXBoRGlmZicsICgpID0+IHtcbiAgbGV0IHByb2plY3REaXI6IHN0cmluZztcblxuICBiZWZvcmVFYWNoKGFzeW5jICgpID0+IHtcbiAgICBwcm9qZWN0RGlyID0gdG1wUHJvamVjdCgpO1xuICAgIG1ha2VQcm9qZWN0V2l0aEFydGlmYWN0cyhwcm9qZWN0RGlyKTtcbiAgICBjb25zdCBnc2RSb290ID0gam9pbihwcm9qZWN0RGlyLCAnLmdzZCcpO1xuICAgIGNvbnN0IGdyYXBoID0gYXdhaXQgYnVpbGRHcmFwaChwcm9qZWN0RGlyKTtcbiAgICBhd2FpdCB3cml0ZUdyYXBoKGdzZFJvb3QsIGdyYXBoKTtcbiAgfSk7XG5cbiAgYWZ0ZXJFYWNoKCgpID0+IHJtU3luYyhwcm9qZWN0RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpO1xuXG4gIGl0KCdyZXR1cm5zIGVtcHR5IGRpZmYgd2hlbiBjb21wYXJpbmcgZ3JhcGggdG8gaXRzZWxmIChzbmFwc2hvdCA9IGN1cnJlbnQpJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGdzZFJvb3QgPSBqb2luKHByb2plY3REaXIsICcuZ3NkJyk7XG4gICAgYXdhaXQgd3JpdGVTbmFwc2hvdChnc2RSb290KTtcbiAgICBjb25zdCBkaWZmID0gYXdhaXQgZ3JhcGhEaWZmKHByb2plY3REaXIpO1xuICAgIGFzc2VydC5vayhBcnJheS5pc0FycmF5KGRpZmYubm9kZXMuYWRkZWQpKTtcbiAgICBhc3NlcnQub2soQXJyYXkuaXNBcnJheShkaWZmLm5vZGVzLnJlbW92ZWQpKTtcbiAgICBhc3NlcnQub2soQXJyYXkuaXNBcnJheShkaWZmLm5vZGVzLmNoYW5nZWQpKTtcbiAgICBhc3NlcnQuZXF1YWwoZGlmZi5ub2Rlcy5hZGRlZC5sZW5ndGgsIDApO1xuICAgIGFzc2VydC5lcXVhbChkaWZmLm5vZGVzLnJlbW92ZWQubGVuZ3RoLCAwKTtcbiAgfSk7XG5cbiAgaXQoJ3JldHVybnMgYWRkZWQgbm9kZXMgd2hlbiBhIG5ldyBub2RlIGFwcGVhcnMgYWZ0ZXIgc25hcHNob3QnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgZ3NkUm9vdCA9IGpvaW4ocHJvamVjdERpciwgJy5nc2QnKTtcbiAgICAvLyBUYWtlIHNuYXBzaG90IG9mIHRoZSBvcmlnaW5hbCBncmFwaFxuICAgIGF3YWl0IHdyaXRlU25hcHNob3QoZ3NkUm9vdCk7XG5cbiAgICAvLyBOb3cgd3JpdGUgYSBncmFwaCB3aXRoIGFuIGV4dHJhIG5vZGVcbiAgICBjb25zdCBleHRyYUdyYXBoOiBLbm93bGVkZ2VHcmFwaCA9IHtcbiAgICAgIGJ1aWx0QXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgIG5vZGVzOiBbXG4gICAgICAgIHsgaWQ6ICdicmFuZC1uZXctbm9kZScsIGxhYmVsOiAnTmV3IEZlYXR1cmUnLCB0eXBlOiAnbWlsZXN0b25lJywgY29uZmlkZW5jZTogJ0VYVFJBQ1RFRCcgfSxcbiAgICAgIF0sXG4gICAgICBlZGdlczogW10sXG4gICAgfTtcbiAgICBhd2FpdCB3cml0ZUdyYXBoKGdzZFJvb3QsIGV4dHJhR3JhcGgpO1xuXG4gICAgY29uc3QgZGlmZiA9IGF3YWl0IGdyYXBoRGlmZihwcm9qZWN0RGlyKTtcbiAgICBhc3NlcnQub2soZGlmZi5ub2Rlcy5hZGRlZC5pbmNsdWRlcygnYnJhbmQtbmV3LW5vZGUnKSwgJ25ldyBub2RlIHNob3VsZCBiZSBpbiBhZGRlZCcpO1xuICB9KTtcblxuICBpdCgncmV0dXJucyByZW1vdmVkIG5vZGVzIHdoZW4gYSBub2RlIGRpc2FwcGVhcnMgYWZ0ZXIgc25hcHNob3QnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgZ3NkUm9vdCA9IGpvaW4ocHJvamVjdERpciwgJy5nc2QnKTtcbiAgICAvLyBDcmVhdGUgc25hcHNob3Qgd2l0aCBhIG5vZGUgdGhhdCB3b24ndCBleGlzdCBpbiBjdXJyZW50IGdyYXBoXG4gICAgY29uc3Qgc25hcHNob3RHcmFwaDogS25vd2xlZGdlR3JhcGggPSB7XG4gICAgICBidWlsdEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICBub2RlczogW1xuICAgICAgICB7IGlkOiAnb2xkLW5vZGUtdG8tYmUtcmVtb3ZlZCcsIGxhYmVsOiAnT2xkJywgdHlwZTogJ3Rhc2snLCBjb25maWRlbmNlOiAnRVhUUkFDVEVEJyB9LFxuICAgICAgXSxcbiAgICAgIGVkZ2VzOiBbXSxcbiAgICB9O1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKGdzZFJvb3QsICdncmFwaHMnLCAnLmxhc3QtYnVpbGQtc25hcHNob3QuanNvbicpLFxuICAgICAgSlNPTi5zdHJpbmdpZnkoeyAuLi5zbmFwc2hvdEdyYXBoLCBzbmFwc2hvdEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkgfSksXG4gICAgICAndXRmLTgnLFxuICAgICk7XG5cbiAgICAvLyBDdXJyZW50IGdyYXBoLmpzb24gaGFzIG5vIHN1Y2ggbm9kZVxuICAgIGNvbnN0IGRpZmYgPSBhd2FpdCBncmFwaERpZmYocHJvamVjdERpcik7XG4gICAgYXNzZXJ0Lm9rKGRpZmYubm9kZXMucmVtb3ZlZC5pbmNsdWRlcygnb2xkLW5vZGUtdG8tYmUtcmVtb3ZlZCcpLCAnb2xkIG5vZGUgc2hvdWxkIGJlIGluIHJlbW92ZWQnKTtcbiAgfSk7XG5cbiAgaXQoJ3JldHVybnMgZW1wdHkgZGlmZiBzdHJ1Y3R1cmUgd2hlbiBubyBzbmFwc2hvdCBleGlzdHMnLCBhc3luYyAoKSA9PiB7XG4gICAgLy8gTm8gc25hcHNob3QgZmlsZSBcdTIwMTQgZGlmZiBzaG91bGQgYmUgZW1wdHkvbWVhbmluZ2Z1bFxuICAgIGNvbnN0IGRpZmYgPSBhd2FpdCBncmFwaERpZmYocHJvamVjdERpcik7XG4gICAgYXNzZXJ0Lm9rKEFycmF5LmlzQXJyYXkoZGlmZi5ub2Rlcy5hZGRlZCkpO1xuICAgIGFzc2VydC5vayhBcnJheS5pc0FycmF5KGRpZmYubm9kZXMucmVtb3ZlZCkpO1xuICAgIGFzc2VydC5vayhBcnJheS5pc0FycmF5KGRpZmYubm9kZXMuY2hhbmdlZCkpO1xuICAgIGFzc2VydC5vayhBcnJheS5pc0FycmF5KGRpZmYuZWRnZXMuYWRkZWQpKTtcbiAgICBhc3NlcnQub2soQXJyYXkuaXNBcnJheShkaWZmLmVkZ2VzLnJlbW92ZWQpKTtcbiAgfSk7XG5cbiAgaXQoJ3dyaXRlU25hcHNob3QgY3JlYXRlcyAubGFzdC1idWlsZC1zbmFwc2hvdC5qc29uIHdpdGggc25hcHNob3RBdCcsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBnc2RSb290ID0gam9pbihwcm9qZWN0RGlyLCAnLmdzZCcpO1xuICAgIGF3YWl0IHdyaXRlU25hcHNob3QoZ3NkUm9vdCk7XG4gICAgY29uc3Qgc25hcHNob3RQYXRoID0gam9pbihnc2RSb290LCAnZ3JhcGhzJywgJy5sYXN0LWJ1aWxkLXNuYXBzaG90Lmpzb24nKTtcbiAgICBhc3NlcnQub2soZXhpc3RzU3luYyhzbmFwc2hvdFBhdGgpKTtcbiAgICBjb25zdCByYXcgPSByZWFkRmlsZVN5bmMoc25hcHNob3RQYXRoLCAndXRmLTgnKTtcbiAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHJhdykgYXMgS25vd2xlZGdlR3JhcGggJiB7IHNuYXBzaG90QXQ6IHN0cmluZyB9O1xuICAgIGFzc2VydC5vayh0eXBlb2YgcGFyc2VkLnNuYXBzaG90QXQgPT09ICdzdHJpbmcnKTtcbiAgICBhc3NlcnQub2soIWlzTmFOKERhdGUucGFyc2UocGFyc2VkLnNuYXBzaG90QXQpKSk7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFFQSxTQUFTLFVBQVUsSUFBSSxRQUFRLE9BQU8sWUFBWSxpQkFBaUI7QUFDbkUsT0FBTyxZQUFZO0FBQ25CLFNBQVMsV0FBVyxlQUFlLFFBQVEsWUFBWSxvQkFBb0I7QUFDM0UsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUN2QixTQUFTLG1CQUFtQjtBQUU1QjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFPUCxTQUFTLGFBQXFCO0FBQzVCLFFBQU0sTUFBTSxLQUFLLE9BQU8sR0FBRyxrQkFBa0IsWUFBWSxDQUFDLEVBQUUsU0FBUyxLQUFLLENB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
