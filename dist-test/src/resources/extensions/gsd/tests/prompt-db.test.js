import { describe, test } from "node:test";
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
  queryProject,
  formatDecisionsForPrompt,
  formatRequirementsForPrompt
} from "../context-store.js";
console.log("\n=== prompt-db: scoped decisions from DB ===");
{
  openDatabase(":memory:");
  for (let i = 1; i <= 10; i++) {
    const milestoneNum = (i - 1) % 3 + 1;
    insertDecision({
      id: `D${String(i).padStart(3, "0")}`,
      when_context: `M00${milestoneNum}/S01`,
      scope: "architecture",
      decision: `decision ${i}`,
      choice: `choice ${i}`,
      rationale: `rationale ${i}`,
      revisable: "yes",
      made_by: "agent",
      superseded_by: null
    });
  }
  const m001Decisions = queryDecisions({ milestoneId: "M001" });
  assert.ok(m001Decisions.length > 0, "M001 decisions should exist");
  assert.ok(m001Decisions.length < 10, `scoped query should return fewer than 10 (got ${m001Decisions.length})`);
  for (const d of m001Decisions) {
    assert.match(d.when_context, /M001/, `decision ${d.id} should be for M001`);
  }
  const formatted = formatDecisionsForPrompt(m001Decisions);
  assert.ok(formatted.length > 0, "formatted decisions should be non-empty");
  assert.match(formatted, /\| # \| When \| Scope/, "formatted decisions have table header");
  const wrapped = `### Decisions
Source: \`.gsd/DECISIONS.md\`

${formatted}`;
  assert.match(wrapped, /^### Decisions/, "wrapped decisions start with ### Decisions");
  assert.match(wrapped, /Source:.*DECISIONS\.md/, "wrapped decisions have source path");
  closeDatabase();
}
console.log("\n=== prompt-db: scoped requirements from DB ===");
{
  openDatabase(":memory:");
  insertRequirement({
    id: "R001",
    class: "functional",
    status: "active",
    description: "feature A",
    why: "needed",
    source: "M001",
    primary_owner: "S01",
    supporting_slices: "",
    validation: "test",
    notes: "",
    full_content: "",
    superseded_by: null
  });
  insertRequirement({
    id: "R002",
    class: "functional",
    status: "active",
    description: "feature B",
    why: "needed",
    source: "M001",
    primary_owner: "S02",
    supporting_slices: "S01",
    validation: "test",
    notes: "",
    full_content: "",
    superseded_by: null
  });
  insertRequirement({
    id: "R003",
    class: "functional",
    status: "active",
    description: "feature C",
    why: "needed",
    source: "M001",
    primary_owner: "S03",
    supporting_slices: "",
    validation: "test",
    notes: "",
    full_content: "",
    superseded_by: null
  });
  const s01Reqs = queryRequirements({ sliceId: "S01" });
  assert.deepStrictEqual(s01Reqs.length, 2, "S01 requirements should be 2 (primary + supporting)");
  const ids = s01Reqs.map((r) => r.id).sort();
  assert.deepStrictEqual(ids, ["R001", "R002"], "S01 owns R001 and supports R002");
  const allReqs = queryRequirements();
  assert.deepStrictEqual(allReqs.length, 3, "unscoped requirements should return all 3");
  const formatted = formatRequirementsForPrompt(s01Reqs);
  assert.ok(formatted.length > 0, "formatted requirements should be non-empty");
  assert.match(formatted, /### R001/, "formatted requirements include R001");
  assert.match(formatted, /### R002/, "formatted requirements include R002");
  assert.doesNotMatch(formatted, /### R003/, "formatted requirements exclude R003");
  const wrapped = `### Requirements
Source: \`.gsd/REQUIREMENTS.md\`

${formatted}`;
  assert.match(wrapped, /^### Requirements/, "wrapped requirements start with ### Requirements");
  assert.match(wrapped, /Source:.*REQUIREMENTS\.md/, "wrapped requirements have source path");
  closeDatabase();
}
console.log("\n=== prompt-db: project content from DB ===");
{
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
  assert.deepStrictEqual(content, "# Test Project\n\nThis is the project description.", "queryProject returns content");
  const wrapped = `### Project
Source: \`.gsd/PROJECT.md\`

${content}`;
  assert.match(wrapped, /^### Project/, "wrapped project starts with ### Project");
  assert.match(wrapped, /Source:.*PROJECT\.md/, "wrapped project has source path");
  assert.match(wrapped, /# Test Project/, "wrapped project includes content");
  closeDatabase();
}
console.log("\n=== prompt-db: fallback when DB unavailable ===");
{
  closeDatabase();
  assert.ok(!isDbAvailable(), "DB should not be available");
  const decisions = queryDecisions({ milestoneId: "M001" });
  assert.deepStrictEqual(decisions, [], "queryDecisions returns [] when DB closed");
  const requirements = queryRequirements({ sliceId: "S01" });
  assert.deepStrictEqual(requirements, [], "queryRequirements returns [] when DB closed");
  const project = queryProject();
  assert.deepStrictEqual(project, null, "queryProject returns null when DB closed");
  const formatted = formatDecisionsForPrompt([]);
  assert.deepStrictEqual(formatted, "", "formatDecisionsForPrompt returns empty for empty input");
  const formattedReqs = formatRequirementsForPrompt([]);
  assert.deepStrictEqual(formattedReqs, "", "formatRequirementsForPrompt returns empty for empty input");
}
console.log("\n=== prompt-db: scoped filtering reduces content ===");
{
  openDatabase(":memory:");
  for (let i = 1; i <= 10; i++) {
    const milestoneNum = (i - 1) % 3 + 1;
    insertDecision({
      id: `D${String(i).padStart(3, "0")}`,
      when_context: `M00${milestoneNum}/S01`,
      scope: "architecture",
      decision: `decision ${i} with some lengthy description for token measurement`,
      choice: `choice ${i}`,
      rationale: `rationale ${i} with additional context`,
      revisable: "yes",
      made_by: "agent",
      superseded_by: null
    });
  }
  const allDecisions = queryDecisions();
  const m001Decisions = queryDecisions({ milestoneId: "M001" });
  assert.deepStrictEqual(allDecisions.length, 10, "unscoped returns all 10 decisions");
  assert.ok(m001Decisions.length < 10, `M001-scoped returns fewer than 10 (got ${m001Decisions.length})`);
  assert.ok(m001Decisions.length > 0, "M001-scoped returns at least 1");
  const allFormatted = formatDecisionsForPrompt(allDecisions);
  const scopedFormatted = formatDecisionsForPrompt(m001Decisions);
  assert.ok(
    scopedFormatted.length < allFormatted.length,
    `scoped content (${scopedFormatted.length} chars) should be shorter than unscoped (${allFormatted.length} chars)`
  );
  for (let i = 1; i <= 8; i++) {
    const sliceNum = (i - 1) % 4 + 1;
    insertRequirement({
      id: `R${String(i).padStart(3, "0")}`,
      class: "functional",
      status: "active",
      description: `requirement ${i} with detailed description`,
      why: `justification ${i}`,
      source: "M001",
      primary_owner: `S0${sliceNum}`,
      supporting_slices: "",
      validation: `validation ${i}`,
      notes: "",
      full_content: "",
      superseded_by: null
    });
  }
  const allReqs = queryRequirements();
  const s01Reqs = queryRequirements({ sliceId: "S01" });
  assert.deepStrictEqual(allReqs.length, 8, "unscoped returns all 8 requirements");
  assert.ok(s01Reqs.length < 8, `S01-scoped returns fewer than 8 (got ${s01Reqs.length})`);
  assert.ok(s01Reqs.length > 0, "S01-scoped returns at least 1");
  const allReqsFormatted = formatRequirementsForPrompt(allReqs);
  const scopedReqsFormatted = formatRequirementsForPrompt(s01Reqs);
  assert.ok(
    scopedReqsFormatted.length < allReqsFormatted.length,
    `scoped requirements (${scopedReqsFormatted.length} chars) should be shorter than unscoped (${allReqsFormatted.length} chars)`
  );
  closeDatabase();
}
console.log("\n=== prompt-db: DB helpers wrapper format matches expected pattern ===");
{
  openDatabase(":memory:");
  insertDecision({
    id: "D001",
    when_context: "M001/S01",
    scope: "architecture",
    decision: "use SQLite",
    choice: "better-sqlite3",
    rationale: "fast",
    revisable: "yes",
    made_by: "agent",
    superseded_by: null
  });
  insertRequirement({
    id: "R001",
    class: "functional",
    status: "active",
    description: "persist decisions",
    why: "memory",
    source: "M001",
    primary_owner: "S01",
    supporting_slices: "",
    validation: "test",
    notes: "",
    full_content: "",
    superseded_by: null
  });
  insertArtifact({
    path: "PROJECT.md",
    artifact_type: "project",
    milestone_id: null,
    slice_id: null,
    task_id: null,
    full_content: "# Project Name\n\nDescription."
  });
  const decisions = queryDecisions({ milestoneId: "M001" });
  assert.ok(decisions.length === 1, "got 1 decision for M001");
  const dFormatted = formatDecisionsForPrompt(decisions);
  const dWrapped = `### Decisions
Source: \`.gsd/DECISIONS.md\`

${dFormatted}`;
  assert.match(dWrapped, /^### Decisions\nSource: `.gsd\/DECISIONS\.md`\n\n\| #/, "decisions wrapper format correct");
  const reqs = queryRequirements({ sliceId: "S01" });
  assert.ok(reqs.length === 1, "got 1 requirement for S01");
  const rFormatted = formatRequirementsForPrompt(reqs);
  const rWrapped = `### Requirements
Source: \`.gsd/REQUIREMENTS.md\`

${rFormatted}`;
  assert.match(rWrapped, /^### Requirements\nSource: `.gsd\/REQUIREMENTS\.md`\n\n### R001/, "requirements wrapper format correct");
  const project = queryProject();
  assert.ok(project !== null, "project content exists");
  const pWrapped = `### Project
Source: \`.gsd/PROJECT.md\`

${project}`;
  assert.match(pWrapped, /^### Project\nSource: `.gsd\/PROJECT\.md`\n\n# Project Name/, "project wrapper format correct");
  closeDatabase();
}
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateFromMarkdown } from "../md-importer.js";
describe("prompt-db", () => {
  test("prompt-db: re-import updates DB when source markdown changes", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "prompt-db-reimport-"));
    const gsdDir = join(tmpDir, ".gsd");
    mkdirSync(gsdDir, { recursive: true });
    const initialDecisions = `# Decisions Register

| # | When | Scope | Decision | Choice | Rationale | Revisable? |
|---|------|-------|----------|--------|-----------|------------|
| D001 | M001/S01 | architecture | use SQLite | better-sqlite3 | fast and embedded | yes |
| D002 | M001/S01 | tooling | use vitest | vitest | modern test runner | yes |
`;
    writeFileSync(join(gsdDir, "DECISIONS.md"), initialDecisions);
    openDatabase(":memory:");
    migrateFromMarkdown(tmpDir);
    const initial = queryDecisions();
    assert.deepStrictEqual(initial.length, 2, "re-import: initial import has 2 decisions");
    const initialIds = initial.map((d) => d.id).sort();
    assert.deepStrictEqual(initialIds, ["D001", "D002"], "re-import: initial decisions are D001, D002");
    const updatedDecisions = `# Decisions Register

| # | When | Scope | Decision | Choice | Rationale | Revisable? |
|---|------|-------|----------|--------|-----------|------------|
| D001 | M001/S01 | architecture | use SQLite | better-sqlite3 | fast and embedded | yes |
| D002 | M001/S01 | tooling | use vitest | vitest | modern test runner | yes |
| D003 | M001/S02 | runtime | dynamic imports | D014 pattern | lazy loading | yes |
`;
    writeFileSync(join(gsdDir, "DECISIONS.md"), updatedDecisions);
    migrateFromMarkdown(tmpDir);
    const afterReimport = queryDecisions();
    assert.deepStrictEqual(afterReimport.length, 3, "re-import: after re-import has 3 decisions");
    const afterIds = afterReimport.map((d) => d.id).sort();
    assert.deepStrictEqual(afterIds, ["D001", "D002", "D003"], "re-import: decisions are D001, D002, D003");
    const d003 = afterReimport.find((d) => d.id === "D003");
    assert.ok(d003 !== void 0, "re-import: D003 exists");
    assert.deepStrictEqual(d003.when_context, "M001/S02", "re-import: D003 when_context is M001/S02");
    assert.deepStrictEqual(d003.scope, "runtime", "re-import: D003 scope is runtime");
    assert.deepStrictEqual(d003.choice, "D014 pattern", "re-import: D003 choice is D014 pattern");
    const m001Scoped = queryDecisions({ milestoneId: "M001" });
    assert.ok(m001Scoped.length === 3, "re-import: all 3 decisions are for M001");
    closeDatabase();
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wcm9tcHQtZGIudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gcHJvbXB0LWRiOiBUZXN0cyBmb3IgREItYXdhcmUgaW5saW5lIGhlbHBlcnMgKGlubGluZURlY2lzaW9uc0Zyb21EYiwgaW5saW5lUmVxdWlyZW1lbnRzRnJvbURiLCBpbmxpbmVQcm9qZWN0RnJvbURiKVxuLy9cbi8vIFZhbGlkYXRlczpcbi8vIChhKSBEQi1hd2FyZSBoZWxwZXJzIHJldHVybiBzY29wZWQgY29udGVudCB3aGVuIERCIGhhcyBkYXRhXG4vLyAoYikgSGVscGVycyBmYWxsIGJhY2sgdG8gbm9uLW51bGwgb3V0cHV0IHdoZW4gREIgdW5hdmFpbGFibGVcbi8vIChjKSBTY29wZWQgZmlsdGVyaW5nIGFjdHVhbGx5IHJlZHVjZXMgY29udGVudFxuXG5pbXBvcnQgeyBkZXNjcmliZSwgdGVzdCB9IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7XG5pbXBvcnQge1xuICBvcGVuRGF0YWJhc2UsXG4gIGNsb3NlRGF0YWJhc2UsXG4gIGlzRGJBdmFpbGFibGUsXG4gIGluc2VydERlY2lzaW9uLFxuICBpbnNlcnRSZXF1aXJlbWVudCxcbiAgaW5zZXJ0QXJ0aWZhY3QsXG59IGZyb20gJy4uL2dzZC1kYi50cyc7XG5pbXBvcnQge1xuICBxdWVyeURlY2lzaW9ucyxcbiAgcXVlcnlSZXF1aXJlbWVudHMsXG4gIHF1ZXJ5UHJvamVjdCxcbiAgZm9ybWF0RGVjaXNpb25zRm9yUHJvbXB0LFxuICBmb3JtYXRSZXF1aXJlbWVudHNGb3JQcm9tcHQsXG59IGZyb20gJy4uL2NvbnRleHQtc3RvcmUudHMnO1xuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIHByb21wdC1kYjogREItYXdhcmUgZGVjaXNpb25zIGhlbHBlciByZXR1cm5zIHNjb3BlZCBjb250ZW50XG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuY29uc29sZS5sb2coJ1xcbj09PSBwcm9tcHQtZGI6IHNjb3BlZCBkZWNpc2lvbnMgZnJvbSBEQiA9PT0nKTtcbntcbiAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuXG4gIC8vIEluc2VydCBkZWNpc2lvbnMgYWNyb3NzIDMgbWlsZXN0b25lc1xuICBmb3IgKGxldCBpID0gMTsgaSA8PSAxMDsgaSsrKSB7XG4gICAgY29uc3QgbWlsZXN0b25lTnVtID0gKChpIC0gMSkgJSAzKSArIDE7XG4gICAgaW5zZXJ0RGVjaXNpb24oe1xuICAgICAgaWQ6IGBEJHtTdHJpbmcoaSkucGFkU3RhcnQoMywgJzAnKX1gLFxuICAgICAgd2hlbl9jb250ZXh0OiBgTTAwJHttaWxlc3RvbmVOdW19L1MwMWAsXG4gICAgICBzY29wZTogJ2FyY2hpdGVjdHVyZScsXG4gICAgICBkZWNpc2lvbjogYGRlY2lzaW9uICR7aX1gLFxuICAgICAgY2hvaWNlOiBgY2hvaWNlICR7aX1gLFxuICAgICAgcmF0aW9uYWxlOiBgcmF0aW9uYWxlICR7aX1gLFxuICAgICAgcmV2aXNhYmxlOiAneWVzJyxcbiAgICAgIG1hZGVfYnk6ICdhZ2VudCcsXG4gICAgICBzdXBlcnNlZGVkX2J5OiBudWxsLFxuICAgIH0pO1xuICB9XG5cbiAgLy8gUXVlcnkgc2NvcGVkIHRvIE0wMDFcbiAgY29uc3QgbTAwMURlY2lzaW9ucyA9IHF1ZXJ5RGVjaXNpb25zKHsgbWlsZXN0b25lSWQ6ICdNMDAxJyB9KTtcbiAgYXNzZXJ0Lm9rKG0wMDFEZWNpc2lvbnMubGVuZ3RoID4gMCwgJ00wMDEgZGVjaXNpb25zIHNob3VsZCBleGlzdCcpO1xuICBhc3NlcnQub2sobTAwMURlY2lzaW9ucy5sZW5ndGggPCAxMCwgYHNjb3BlZCBxdWVyeSBzaG91bGQgcmV0dXJuIGZld2VyIHRoYW4gMTAgKGdvdCAke20wMDFEZWNpc2lvbnMubGVuZ3RofSlgKTtcblxuICAvLyBWZXJpZnkgYWxsIHJldHVybmVkIGRlY2lzaW9ucyBhcmUgZm9yIE0wMDFcbiAgZm9yIChjb25zdCBkIG9mIG0wMDFEZWNpc2lvbnMpIHtcbiAgICBhc3NlcnQubWF0Y2goZC53aGVuX2NvbnRleHQsIC9NMDAxLywgYGRlY2lzaW9uICR7ZC5pZH0gc2hvdWxkIGJlIGZvciBNMDAxYCk7XG4gIH1cblxuICAvLyBGb3JtYXQgYW5kIHZlcmlmeSB3cmFwcGluZ1xuICBjb25zdCBmb3JtYXR0ZWQgPSBmb3JtYXREZWNpc2lvbnNGb3JQcm9tcHQobTAwMURlY2lzaW9ucyk7XG4gIGFzc2VydC5vayhmb3JtYXR0ZWQubGVuZ3RoID4gMCwgJ2Zvcm1hdHRlZCBkZWNpc2lvbnMgc2hvdWxkIGJlIG5vbi1lbXB0eScpO1xuICBhc3NlcnQubWF0Y2goZm9ybWF0dGVkLCAvXFx8ICMgXFx8IFdoZW4gXFx8IFNjb3BlLywgJ2Zvcm1hdHRlZCBkZWNpc2lvbnMgaGF2ZSB0YWJsZSBoZWFkZXInKTtcblxuICAvLyBWZXJpZnkgdGhlIGV4cGVjdGVkIHdyYXBwZXIgZm9ybWF0IHRoYXQgaW5saW5lRGVjaXNpb25zRnJvbURiIHdvdWxkIHByb2R1Y2VcbiAgY29uc3Qgd3JhcHBlZCA9IGAjIyMgRGVjaXNpb25zXFxuU291cmNlOiBcXGAuZ3NkL0RFQ0lTSU9OUy5tZFxcYFxcblxcbiR7Zm9ybWF0dGVkfWA7XG4gIGFzc2VydC5tYXRjaCh3cmFwcGVkLCAvXiMjIyBEZWNpc2lvbnMvLCAnd3JhcHBlZCBkZWNpc2lvbnMgc3RhcnQgd2l0aCAjIyMgRGVjaXNpb25zJyk7XG4gIGFzc2VydC5tYXRjaCh3cmFwcGVkLCAvU291cmNlOi4qREVDSVNJT05TXFwubWQvLCAnd3JhcHBlZCBkZWNpc2lvbnMgaGF2ZSBzb3VyY2UgcGF0aCcpO1xuXG4gIGNsb3NlRGF0YWJhc2UoKTtcbn1cblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBwcm9tcHQtZGI6IERCLWF3YXJlIHJlcXVpcmVtZW50cyBoZWxwZXIgcmV0dXJucyBzY29wZWQgY29udGVudFxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbmNvbnNvbGUubG9nKCdcXG49PT0gcHJvbXB0LWRiOiBzY29wZWQgcmVxdWlyZW1lbnRzIGZyb20gREIgPT09Jyk7XG57XG4gIG9wZW5EYXRhYmFzZSgnOm1lbW9yeTonKTtcblxuICAvLyBJbnNlcnQgcmVxdWlyZW1lbnRzIGFjcm9zcyBkaWZmZXJlbnQgc2xpY2VzXG4gIGluc2VydFJlcXVpcmVtZW50KHtcbiAgICBpZDogJ1IwMDEnLCBjbGFzczogJ2Z1bmN0aW9uYWwnLCBzdGF0dXM6ICdhY3RpdmUnLFxuICAgIGRlc2NyaXB0aW9uOiAnZmVhdHVyZSBBJywgd2h5OiAnbmVlZGVkJywgc291cmNlOiAnTTAwMScsIHByaW1hcnlfb3duZXI6ICdTMDEnLFxuICAgIHN1cHBvcnRpbmdfc2xpY2VzOiAnJywgdmFsaWRhdGlvbjogJ3Rlc3QnLCBub3RlczogJycsIGZ1bGxfY29udGVudDogJycsXG4gICAgc3VwZXJzZWRlZF9ieTogbnVsbCxcbiAgfSk7XG4gIGluc2VydFJlcXVpcmVtZW50KHtcbiAgICBpZDogJ1IwMDInLCBjbGFzczogJ2Z1bmN0aW9uYWwnLCBzdGF0dXM6ICdhY3RpdmUnLFxuICAgIGRlc2NyaXB0aW9uOiAnZmVhdHVyZSBCJywgd2h5OiAnbmVlZGVkJywgc291cmNlOiAnTTAwMScsIHByaW1hcnlfb3duZXI6ICdTMDInLFxuICAgIHN1cHBvcnRpbmdfc2xpY2VzOiAnUzAxJywgdmFsaWRhdGlvbjogJ3Rlc3QnLCBub3RlczogJycsIGZ1bGxfY29udGVudDogJycsXG4gICAgc3VwZXJzZWRlZF9ieTogbnVsbCxcbiAgfSk7XG4gIGluc2VydFJlcXVpcmVtZW50KHtcbiAgICBpZDogJ1IwMDMnLCBjbGFzczogJ2Z1bmN0aW9uYWwnLCBzdGF0dXM6ICdhY3RpdmUnLFxuICAgIGRlc2NyaXB0aW9uOiAnZmVhdHVyZSBDJywgd2h5OiAnbmVlZGVkJywgc291cmNlOiAnTTAwMScsIHByaW1hcnlfb3duZXI6ICdTMDMnLFxuICAgIHN1cHBvcnRpbmdfc2xpY2VzOiAnJywgdmFsaWRhdGlvbjogJ3Rlc3QnLCBub3RlczogJycsIGZ1bGxfY29udGVudDogJycsXG4gICAgc3VwZXJzZWRlZF9ieTogbnVsbCxcbiAgfSk7XG5cbiAgLy8gUXVlcnkgc2NvcGVkIHRvIFMwMSBcdTIwMTQgc2hvdWxkIGdldCBSMDAxIChwcmltYXJ5KSBhbmQgUjAwMiAoc3VwcG9ydGluZylcbiAgY29uc3QgczAxUmVxcyA9IHF1ZXJ5UmVxdWlyZW1lbnRzKHsgc2xpY2VJZDogJ1MwMScgfSk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoczAxUmVxcy5sZW5ndGgsIDIsICdTMDEgcmVxdWlyZW1lbnRzIHNob3VsZCBiZSAyIChwcmltYXJ5ICsgc3VwcG9ydGluZyknKTtcbiAgY29uc3QgaWRzID0gczAxUmVxcy5tYXAociA9PiByLmlkKS5zb3J0KCk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoaWRzLCBbJ1IwMDEnLCAnUjAwMiddLCAnUzAxIG93bnMgUjAwMSBhbmQgc3VwcG9ydHMgUjAwMicpO1xuXG4gIC8vIFVuc2NvcGVkIHF1ZXJ5IHJldHVybnMgYWxsIDNcbiAgY29uc3QgYWxsUmVxcyA9IHF1ZXJ5UmVxdWlyZW1lbnRzKCk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoYWxsUmVxcy5sZW5ndGgsIDMsICd1bnNjb3BlZCByZXF1aXJlbWVudHMgc2hvdWxkIHJldHVybiBhbGwgMycpO1xuXG4gIC8vIEZvcm1hdCBhbmQgdmVyaWZ5IHdyYXBwaW5nXG4gIGNvbnN0IGZvcm1hdHRlZCA9IGZvcm1hdFJlcXVpcmVtZW50c0ZvclByb21wdChzMDFSZXFzKTtcbiAgYXNzZXJ0Lm9rKGZvcm1hdHRlZC5sZW5ndGggPiAwLCAnZm9ybWF0dGVkIHJlcXVpcmVtZW50cyBzaG91bGQgYmUgbm9uLWVtcHR5Jyk7XG4gIGFzc2VydC5tYXRjaChmb3JtYXR0ZWQsIC8jIyMgUjAwMS8sICdmb3JtYXR0ZWQgcmVxdWlyZW1lbnRzIGluY2x1ZGUgUjAwMScpO1xuICBhc3NlcnQubWF0Y2goZm9ybWF0dGVkLCAvIyMjIFIwMDIvLCAnZm9ybWF0dGVkIHJlcXVpcmVtZW50cyBpbmNsdWRlIFIwMDInKTtcbiAgYXNzZXJ0LmRvZXNOb3RNYXRjaChmb3JtYXR0ZWQsIC8jIyMgUjAwMy8sICdmb3JtYXR0ZWQgcmVxdWlyZW1lbnRzIGV4Y2x1ZGUgUjAwMycpO1xuXG4gIC8vIFZlcmlmeSB0aGUgZXhwZWN0ZWQgd3JhcHBlciBmb3JtYXQgdGhhdCBpbmxpbmVSZXF1aXJlbWVudHNGcm9tRGIgd291bGQgcHJvZHVjZVxuICBjb25zdCB3cmFwcGVkID0gYCMjIyBSZXF1aXJlbWVudHNcXG5Tb3VyY2U6IFxcYC5nc2QvUkVRVUlSRU1FTlRTLm1kXFxgXFxuXFxuJHtmb3JtYXR0ZWR9YDtcbiAgYXNzZXJ0Lm1hdGNoKHdyYXBwZWQsIC9eIyMjIFJlcXVpcmVtZW50cy8sICd3cmFwcGVkIHJlcXVpcmVtZW50cyBzdGFydCB3aXRoICMjIyBSZXF1aXJlbWVudHMnKTtcbiAgYXNzZXJ0Lm1hdGNoKHdyYXBwZWQsIC9Tb3VyY2U6LipSRVFVSVJFTUVOVFNcXC5tZC8sICd3cmFwcGVkIHJlcXVpcmVtZW50cyBoYXZlIHNvdXJjZSBwYXRoJyk7XG5cbiAgY2xvc2VEYXRhYmFzZSgpO1xufVxuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIHByb21wdC1kYjogREItYXdhcmUgcHJvamVjdCBoZWxwZXIgcmV0dXJucyBjb250ZW50IGZyb20gREJcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG5jb25zb2xlLmxvZygnXFxuPT09IHByb21wdC1kYjogcHJvamVjdCBjb250ZW50IGZyb20gREIgPT09Jyk7XG57XG4gIG9wZW5EYXRhYmFzZSgnOm1lbW9yeTonKTtcblxuICBpbnNlcnRBcnRpZmFjdCh7XG4gICAgcGF0aDogJ1BST0pFQ1QubWQnLFxuICAgIGFydGlmYWN0X3R5cGU6ICdwcm9qZWN0JyxcbiAgICBtaWxlc3RvbmVfaWQ6IG51bGwsXG4gICAgc2xpY2VfaWQ6IG51bGwsXG4gICAgdGFza19pZDogbnVsbCxcbiAgICBmdWxsX2NvbnRlbnQ6ICcjIFRlc3QgUHJvamVjdFxcblxcblRoaXMgaXMgdGhlIHByb2plY3QgZGVzY3JpcHRpb24uJyxcbiAgfSk7XG5cbiAgY29uc3QgY29udGVudCA9IHF1ZXJ5UHJvamVjdCgpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGNvbnRlbnQsICcjIFRlc3QgUHJvamVjdFxcblxcblRoaXMgaXMgdGhlIHByb2plY3QgZGVzY3JpcHRpb24uJywgJ3F1ZXJ5UHJvamVjdCByZXR1cm5zIGNvbnRlbnQnKTtcblxuICAvLyBWZXJpZnkgdGhlIGV4cGVjdGVkIHdyYXBwZXIgZm9ybWF0IHRoYXQgaW5saW5lUHJvamVjdEZyb21EYiB3b3VsZCBwcm9kdWNlXG4gIGNvbnN0IHdyYXBwZWQgPSBgIyMjIFByb2plY3RcXG5Tb3VyY2U6IFxcYC5nc2QvUFJPSkVDVC5tZFxcYFxcblxcbiR7Y29udGVudH1gO1xuICBhc3NlcnQubWF0Y2god3JhcHBlZCwgL14jIyMgUHJvamVjdC8sICd3cmFwcGVkIHByb2plY3Qgc3RhcnRzIHdpdGggIyMjIFByb2plY3QnKTtcbiAgYXNzZXJ0Lm1hdGNoKHdyYXBwZWQsIC9Tb3VyY2U6LipQUk9KRUNUXFwubWQvLCAnd3JhcHBlZCBwcm9qZWN0IGhhcyBzb3VyY2UgcGF0aCcpO1xuICBhc3NlcnQubWF0Y2god3JhcHBlZCwgLyMgVGVzdCBQcm9qZWN0LywgJ3dyYXBwZWQgcHJvamVjdCBpbmNsdWRlcyBjb250ZW50Jyk7XG5cbiAgY2xvc2VEYXRhYmFzZSgpO1xufVxuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIHByb21wdC1kYjogZmFsbGJhY2sgd2hlbiBEQiB1bmF2YWlsYWJsZVxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbmNvbnNvbGUubG9nKCdcXG49PT0gcHJvbXB0LWRiOiBmYWxsYmFjayB3aGVuIERCIHVuYXZhaWxhYmxlID09PScpO1xue1xuICBjbG9zZURhdGFiYXNlKCk7XG4gIGFzc2VydC5vayghaXNEYkF2YWlsYWJsZSgpLCAnREIgc2hvdWxkIG5vdCBiZSBhdmFpbGFibGUnKTtcblxuICAvLyBxdWVyeURlY2lzaW9ucyByZXR1cm5zIFtdIHdoZW4gREIgY2xvc2VkIFx1MjAxNCBoZWxwZXIgd291bGQgZmFsbCBiYWNrXG4gIGNvbnN0IGRlY2lzaW9ucyA9IHF1ZXJ5RGVjaXNpb25zKHsgbWlsZXN0b25lSWQ6ICdNMDAxJyB9KTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkZWNpc2lvbnMsIFtdLCAncXVlcnlEZWNpc2lvbnMgcmV0dXJucyBbXSB3aGVuIERCIGNsb3NlZCcpO1xuXG4gIC8vIHF1ZXJ5UmVxdWlyZW1lbnRzIHJldHVybnMgW10gd2hlbiBEQiBjbG9zZWQgXHUyMDE0IGhlbHBlciB3b3VsZCBmYWxsIGJhY2tcbiAgY29uc3QgcmVxdWlyZW1lbnRzID0gcXVlcnlSZXF1aXJlbWVudHMoeyBzbGljZUlkOiAnUzAxJyB9KTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXF1aXJlbWVudHMsIFtdLCAncXVlcnlSZXF1aXJlbWVudHMgcmV0dXJucyBbXSB3aGVuIERCIGNsb3NlZCcpO1xuXG4gIC8vIHF1ZXJ5UHJvamVjdCByZXR1cm5zIG51bGwgd2hlbiBEQiBjbG9zZWQgXHUyMDE0IGhlbHBlciB3b3VsZCBmYWxsIGJhY2tcbiAgY29uc3QgcHJvamVjdCA9IHF1ZXJ5UHJvamVjdCgpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHByb2plY3QsIG51bGwsICdxdWVyeVByb2plY3QgcmV0dXJucyBudWxsIHdoZW4gREIgY2xvc2VkJyk7XG5cbiAgLy8gZm9ybWF0RGVjaXNpb25zRm9yUHJvbXB0IHJldHVybnMgJycgZm9yIGVtcHR5IGlucHV0XG4gIGNvbnN0IGZvcm1hdHRlZCA9IGZvcm1hdERlY2lzaW9uc0ZvclByb21wdChbXSk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZm9ybWF0dGVkLCAnJywgJ2Zvcm1hdERlY2lzaW9uc0ZvclByb21wdCByZXR1cm5zIGVtcHR5IGZvciBlbXB0eSBpbnB1dCcpO1xuXG4gIC8vIGZvcm1hdFJlcXVpcmVtZW50c0ZvclByb21wdCByZXR1cm5zICcnIGZvciBlbXB0eSBpbnB1dFxuICBjb25zdCBmb3JtYXR0ZWRSZXFzID0gZm9ybWF0UmVxdWlyZW1lbnRzRm9yUHJvbXB0KFtdKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChmb3JtYXR0ZWRSZXFzLCAnJywgJ2Zvcm1hdFJlcXVpcmVtZW50c0ZvclByb21wdCByZXR1cm5zIGVtcHR5IGZvciBlbXB0eSBpbnB1dCcpO1xufVxuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIHByb21wdC1kYjogc2NvcGVkIGZpbHRlcmluZyByZWR1Y2VzIGNvbnRlbnQgdnMgdW5zY29wZWRcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG5jb25zb2xlLmxvZygnXFxuPT09IHByb21wdC1kYjogc2NvcGVkIGZpbHRlcmluZyByZWR1Y2VzIGNvbnRlbnQgPT09Jyk7XG57XG4gIG9wZW5EYXRhYmFzZSgnOm1lbW9yeTonKTtcblxuICAvLyBJbnNlcnQgMTAgZGVjaXNpb25zIGFjcm9zcyAzIG1pbGVzdG9uZXNcbiAgZm9yIChsZXQgaSA9IDE7IGkgPD0gMTA7IGkrKykge1xuICAgIGNvbnN0IG1pbGVzdG9uZU51bSA9ICgoaSAtIDEpICUgMykgKyAxO1xuICAgIGluc2VydERlY2lzaW9uKHtcbiAgICAgIGlkOiBgRCR7U3RyaW5nKGkpLnBhZFN0YXJ0KDMsICcwJyl9YCxcbiAgICAgIHdoZW5fY29udGV4dDogYE0wMCR7bWlsZXN0b25lTnVtfS9TMDFgLFxuICAgICAgc2NvcGU6ICdhcmNoaXRlY3R1cmUnLFxuICAgICAgZGVjaXNpb246IGBkZWNpc2lvbiAke2l9IHdpdGggc29tZSBsZW5ndGh5IGRlc2NyaXB0aW9uIGZvciB0b2tlbiBtZWFzdXJlbWVudGAsXG4gICAgICBjaG9pY2U6IGBjaG9pY2UgJHtpfWAsXG4gICAgICByYXRpb25hbGU6IGByYXRpb25hbGUgJHtpfSB3aXRoIGFkZGl0aW9uYWwgY29udGV4dGAsXG4gICAgICByZXZpc2FibGU6ICd5ZXMnLFxuICAgICAgbWFkZV9ieTogJ2FnZW50JyxcbiAgICAgIHN1cGVyc2VkZWRfYnk6IG51bGwsXG4gICAgfSk7XG4gIH1cblxuICBjb25zdCBhbGxEZWNpc2lvbnMgPSBxdWVyeURlY2lzaW9ucygpO1xuICBjb25zdCBtMDAxRGVjaXNpb25zID0gcXVlcnlEZWNpc2lvbnMoeyBtaWxlc3RvbmVJZDogJ00wMDEnIH0pO1xuXG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoYWxsRGVjaXNpb25zLmxlbmd0aCwgMTAsICd1bnNjb3BlZCByZXR1cm5zIGFsbCAxMCBkZWNpc2lvbnMnKTtcbiAgYXNzZXJ0Lm9rKG0wMDFEZWNpc2lvbnMubGVuZ3RoIDwgMTAsIGBNMDAxLXNjb3BlZCByZXR1cm5zIGZld2VyIHRoYW4gMTAgKGdvdCAke20wMDFEZWNpc2lvbnMubGVuZ3RofSlgKTtcbiAgYXNzZXJ0Lm9rKG0wMDFEZWNpc2lvbnMubGVuZ3RoID4gMCwgJ00wMDEtc2NvcGVkIHJldHVybnMgYXQgbGVhc3QgMScpO1xuXG4gIC8vIEZvcm1hdCBib3RoIGFuZCBjb21wYXJlIHNpemVzIFx1MjAxNCBzY29wZWQgc2hvdWxkIGJlIHNob3J0ZXJcbiAgY29uc3QgYWxsRm9ybWF0dGVkID0gZm9ybWF0RGVjaXNpb25zRm9yUHJvbXB0KGFsbERlY2lzaW9ucyk7XG4gIGNvbnN0IHNjb3BlZEZvcm1hdHRlZCA9IGZvcm1hdERlY2lzaW9uc0ZvclByb21wdChtMDAxRGVjaXNpb25zKTtcblxuICBhc3NlcnQub2soXG4gICAgc2NvcGVkRm9ybWF0dGVkLmxlbmd0aCA8IGFsbEZvcm1hdHRlZC5sZW5ndGgsXG4gICAgYHNjb3BlZCBjb250ZW50ICgke3Njb3BlZEZvcm1hdHRlZC5sZW5ndGh9IGNoYXJzKSBzaG91bGQgYmUgc2hvcnRlciB0aGFuIHVuc2NvcGVkICgke2FsbEZvcm1hdHRlZC5sZW5ndGh9IGNoYXJzKWAsXG4gICk7XG5cbiAgLy8gSW5zZXJ0IHJlcXVpcmVtZW50cyBhY3Jvc3MgNCBzbGljZXNcbiAgZm9yIChsZXQgaSA9IDE7IGkgPD0gODsgaSsrKSB7XG4gICAgY29uc3Qgc2xpY2VOdW0gPSAoKGkgLSAxKSAlIDQpICsgMTtcbiAgICBpbnNlcnRSZXF1aXJlbWVudCh7XG4gICAgICBpZDogYFIke1N0cmluZyhpKS5wYWRTdGFydCgzLCAnMCcpfWAsXG4gICAgICBjbGFzczogJ2Z1bmN0aW9uYWwnLFxuICAgICAgc3RhdHVzOiAnYWN0aXZlJyxcbiAgICAgIGRlc2NyaXB0aW9uOiBgcmVxdWlyZW1lbnQgJHtpfSB3aXRoIGRldGFpbGVkIGRlc2NyaXB0aW9uYCxcbiAgICAgIHdoeTogYGp1c3RpZmljYXRpb24gJHtpfWAsXG4gICAgICBzb3VyY2U6ICdNMDAxJyxcbiAgICAgIHByaW1hcnlfb3duZXI6IGBTMCR7c2xpY2VOdW19YCxcbiAgICAgIHN1cHBvcnRpbmdfc2xpY2VzOiAnJyxcbiAgICAgIHZhbGlkYXRpb246IGB2YWxpZGF0aW9uICR7aX1gLFxuICAgICAgbm90ZXM6ICcnLFxuICAgICAgZnVsbF9jb250ZW50OiAnJyxcbiAgICAgIHN1cGVyc2VkZWRfYnk6IG51bGwsXG4gICAgfSk7XG4gIH1cblxuICBjb25zdCBhbGxSZXFzID0gcXVlcnlSZXF1aXJlbWVudHMoKTtcbiAgY29uc3QgczAxUmVxcyA9IHF1ZXJ5UmVxdWlyZW1lbnRzKHsgc2xpY2VJZDogJ1MwMScgfSk7XG5cbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChhbGxSZXFzLmxlbmd0aCwgOCwgJ3Vuc2NvcGVkIHJldHVybnMgYWxsIDggcmVxdWlyZW1lbnRzJyk7XG4gIGFzc2VydC5vayhzMDFSZXFzLmxlbmd0aCA8IDgsIGBTMDEtc2NvcGVkIHJldHVybnMgZmV3ZXIgdGhhbiA4IChnb3QgJHtzMDFSZXFzLmxlbmd0aH0pYCk7XG4gIGFzc2VydC5vayhzMDFSZXFzLmxlbmd0aCA+IDAsICdTMDEtc2NvcGVkIHJldHVybnMgYXQgbGVhc3QgMScpO1xuXG4gIGNvbnN0IGFsbFJlcXNGb3JtYXR0ZWQgPSBmb3JtYXRSZXF1aXJlbWVudHNGb3JQcm9tcHQoYWxsUmVxcyk7XG4gIGNvbnN0IHNjb3BlZFJlcXNGb3JtYXR0ZWQgPSBmb3JtYXRSZXF1aXJlbWVudHNGb3JQcm9tcHQoczAxUmVxcyk7XG5cbiAgYXNzZXJ0Lm9rKFxuICAgIHNjb3BlZFJlcXNGb3JtYXR0ZWQubGVuZ3RoIDwgYWxsUmVxc0Zvcm1hdHRlZC5sZW5ndGgsXG4gICAgYHNjb3BlZCByZXF1aXJlbWVudHMgKCR7c2NvcGVkUmVxc0Zvcm1hdHRlZC5sZW5ndGh9IGNoYXJzKSBzaG91bGQgYmUgc2hvcnRlciB0aGFuIHVuc2NvcGVkICgke2FsbFJlcXNGb3JtYXR0ZWQubGVuZ3RofSBjaGFycylgLFxuICApO1xuXG4gIGNsb3NlRGF0YWJhc2UoKTtcbn1cblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBwcm9tcHQtZGI6IERCIGhlbHBlcnMgcHJvZHVjZSBjb3JyZWN0IHdyYXBwZXIgZm9ybWF0XG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuY29uc29sZS5sb2coJ1xcbj09PSBwcm9tcHQtZGI6IERCIGhlbHBlcnMgd3JhcHBlciBmb3JtYXQgbWF0Y2hlcyBleHBlY3RlZCBwYXR0ZXJuID09PScpO1xue1xuICBvcGVuRGF0YWJhc2UoJzptZW1vcnk6Jyk7XG5cbiAgaW5zZXJ0RGVjaXNpb24oe1xuICAgIGlkOiAnRDAwMScsIHdoZW5fY29udGV4dDogJ00wMDEvUzAxJywgc2NvcGU6ICdhcmNoaXRlY3R1cmUnLFxuICAgIGRlY2lzaW9uOiAndXNlIFNRTGl0ZScsIGNob2ljZTogJ2JldHRlci1zcWxpdGUzJywgcmF0aW9uYWxlOiAnZmFzdCcsXG4gICAgcmV2aXNhYmxlOiAneWVzJywgbWFkZV9ieTogJ2FnZW50Jywgc3VwZXJzZWRlZF9ieTogbnVsbCxcbiAgfSk7XG5cbiAgaW5zZXJ0UmVxdWlyZW1lbnQoe1xuICAgIGlkOiAnUjAwMScsIGNsYXNzOiAnZnVuY3Rpb25hbCcsIHN0YXR1czogJ2FjdGl2ZScsXG4gICAgZGVzY3JpcHRpb246ICdwZXJzaXN0IGRlY2lzaW9ucycsIHdoeTogJ21lbW9yeScsIHNvdXJjZTogJ00wMDEnLFxuICAgIHByaW1hcnlfb3duZXI6ICdTMDEnLCBzdXBwb3J0aW5nX3NsaWNlczogJycsIHZhbGlkYXRpb246ICd0ZXN0JyxcbiAgICBub3RlczogJycsIGZ1bGxfY29udGVudDogJycsIHN1cGVyc2VkZWRfYnk6IG51bGwsXG4gIH0pO1xuXG4gIGluc2VydEFydGlmYWN0KHtcbiAgICBwYXRoOiAnUFJPSkVDVC5tZCcsXG4gICAgYXJ0aWZhY3RfdHlwZTogJ3Byb2plY3QnLFxuICAgIG1pbGVzdG9uZV9pZDogbnVsbCxcbiAgICBzbGljZV9pZDogbnVsbCxcbiAgICB0YXNrX2lkOiBudWxsLFxuICAgIGZ1bGxfY29udGVudDogJyMgUHJvamVjdCBOYW1lXFxuXFxuRGVzY3JpcHRpb24uJyxcbiAgfSk7XG5cbiAgLy8gU2ltdWxhdGUgd2hhdCBpbmxpbmVEZWNpc2lvbnNGcm9tRGIgZG9lc1xuICBjb25zdCBkZWNpc2lvbnMgPSBxdWVyeURlY2lzaW9ucyh7IG1pbGVzdG9uZUlkOiAnTTAwMScgfSk7XG4gIGFzc2VydC5vayhkZWNpc2lvbnMubGVuZ3RoID09PSAxLCAnZ290IDEgZGVjaXNpb24gZm9yIE0wMDEnKTtcbiAgY29uc3QgZEZvcm1hdHRlZCA9IGZvcm1hdERlY2lzaW9uc0ZvclByb21wdChkZWNpc2lvbnMpO1xuICBjb25zdCBkV3JhcHBlZCA9IGAjIyMgRGVjaXNpb25zXFxuU291cmNlOiBcXGAuZ3NkL0RFQ0lTSU9OUy5tZFxcYFxcblxcbiR7ZEZvcm1hdHRlZH1gO1xuICBhc3NlcnQubWF0Y2goZFdyYXBwZWQsIC9eIyMjIERlY2lzaW9uc1xcblNvdXJjZTogYC5nc2RcXC9ERUNJU0lPTlNcXC5tZGBcXG5cXG5cXHwgIy8sICdkZWNpc2lvbnMgd3JhcHBlciBmb3JtYXQgY29ycmVjdCcpO1xuXG4gIC8vIFNpbXVsYXRlIHdoYXQgaW5saW5lUmVxdWlyZW1lbnRzRnJvbURiIGRvZXNcbiAgY29uc3QgcmVxcyA9IHF1ZXJ5UmVxdWlyZW1lbnRzKHsgc2xpY2VJZDogJ1MwMScgfSk7XG4gIGFzc2VydC5vayhyZXFzLmxlbmd0aCA9PT0gMSwgJ2dvdCAxIHJlcXVpcmVtZW50IGZvciBTMDEnKTtcbiAgY29uc3QgckZvcm1hdHRlZCA9IGZvcm1hdFJlcXVpcmVtZW50c0ZvclByb21wdChyZXFzKTtcbiAgY29uc3QgcldyYXBwZWQgPSBgIyMjIFJlcXVpcmVtZW50c1xcblNvdXJjZTogXFxgLmdzZC9SRVFVSVJFTUVOVFMubWRcXGBcXG5cXG4ke3JGb3JtYXR0ZWR9YDtcbiAgYXNzZXJ0Lm1hdGNoKHJXcmFwcGVkLCAvXiMjIyBSZXF1aXJlbWVudHNcXG5Tb3VyY2U6IGAuZ3NkXFwvUkVRVUlSRU1FTlRTXFwubWRgXFxuXFxuIyMjIFIwMDEvLCAncmVxdWlyZW1lbnRzIHdyYXBwZXIgZm9ybWF0IGNvcnJlY3QnKTtcblxuICAvLyBTaW11bGF0ZSB3aGF0IGlubGluZVByb2plY3RGcm9tRGIgZG9lc1xuICBjb25zdCBwcm9qZWN0ID0gcXVlcnlQcm9qZWN0KCk7XG4gIGFzc2VydC5vayhwcm9qZWN0ICE9PSBudWxsLCAncHJvamVjdCBjb250ZW50IGV4aXN0cycpO1xuICBjb25zdCBwV3JhcHBlZCA9IGAjIyMgUHJvamVjdFxcblNvdXJjZTogXFxgLmdzZC9QUk9KRUNULm1kXFxgXFxuXFxuJHtwcm9qZWN0fWA7XG4gIGFzc2VydC5tYXRjaChwV3JhcHBlZCwgL14jIyMgUHJvamVjdFxcblNvdXJjZTogYC5nc2RcXC9QUk9KRUNUXFwubWRgXFxuXFxuIyBQcm9qZWN0IE5hbWUvLCAncHJvamVjdCB3cmFwcGVyIGZvcm1hdCBjb3JyZWN0Jyk7XG5cbiAgY2xvc2VEYXRhYmFzZSgpO1xufVxuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIHByb21wdC1kYjogcmUtaW1wb3J0IHVwZGF0ZXMgREIgd2hlbiBzb3VyY2UgbWFya2Rvd24gY2hhbmdlc1xuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbmltcG9ydCB7IG1rZHRlbXBTeW5jLCB3cml0ZUZpbGVTeW5jLCBta2RpclN5bmMgfSBmcm9tICdub2RlOmZzJztcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdub2RlOnBhdGgnO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSAnbm9kZTpvcyc7XG5pbXBvcnQgeyBtaWdyYXRlRnJvbU1hcmtkb3duIH0gZnJvbSAnLi4vbWQtaW1wb3J0ZXIudHMnO1xuXG5cbmRlc2NyaWJlKCdwcm9tcHQtZGInLCAoKSA9PiB7XG50ZXN0KCdwcm9tcHQtZGI6IHJlLWltcG9ydCB1cGRhdGVzIERCIHdoZW4gc291cmNlIG1hcmtkb3duIGNoYW5nZXMnLCAoKSA9PiB7XG4gIC8vIENyZWF0ZSBhIHRlbXAgZGlyIHNpbXVsYXRpbmcgYSBwcm9qZWN0IHdpdGggLmdzZC9ERUNJU0lPTlMubWRcbiAgY29uc3QgdG1wRGlyID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgJ3Byb21wdC1kYi1yZWltcG9ydC0nKSk7XG4gIGNvbnN0IGdzZERpciA9IGpvaW4odG1wRGlyLCAnLmdzZCcpO1xuICBta2RpclN5bmMoZ3NkRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAvLyBXcml0ZSBpbml0aWFsIERFQ0lTSU9OUy5tZCB3aXRoIDIgZGVjaXNpb25zXG4gIGNvbnN0IGluaXRpYWxEZWNpc2lvbnMgPSBgIyBEZWNpc2lvbnMgUmVnaXN0ZXJcblxufCAjIHwgV2hlbiB8IFNjb3BlIHwgRGVjaXNpb24gfCBDaG9pY2UgfCBSYXRpb25hbGUgfCBSZXZpc2FibGU/IHxcbnwtLS18LS0tLS0tfC0tLS0tLS18LS0tLS0tLS0tLXwtLS0tLS0tLXwtLS0tLS0tLS0tLXwtLS0tLS0tLS0tLS18XG58IEQwMDEgfCBNMDAxL1MwMSB8IGFyY2hpdGVjdHVyZSB8IHVzZSBTUUxpdGUgfCBiZXR0ZXItc3FsaXRlMyB8IGZhc3QgYW5kIGVtYmVkZGVkIHwgeWVzIHxcbnwgRDAwMiB8IE0wMDEvUzAxIHwgdG9vbGluZyB8IHVzZSB2aXRlc3QgfCB2aXRlc3QgfCBtb2Rlcm4gdGVzdCBydW5uZXIgfCB5ZXMgfFxuYDtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGdzZERpciwgJ0RFQ0lTSU9OUy5tZCcpLCBpbml0aWFsRGVjaXNpb25zKTtcblxuICAvLyBPcGVuIGluLW1lbW9yeSBEQiBhbmQgZG8gaW5pdGlhbCBpbXBvcnRcbiAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuICBtaWdyYXRlRnJvbU1hcmtkb3duKHRtcERpcik7XG5cbiAgLy8gVmVyaWZ5IGluaXRpYWwgc3RhdGU6IDIgZGVjaXNpb25zXG4gIGNvbnN0IGluaXRpYWwgPSBxdWVyeURlY2lzaW9ucygpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGluaXRpYWwubGVuZ3RoLCAyLCAncmUtaW1wb3J0OiBpbml0aWFsIGltcG9ydCBoYXMgMiBkZWNpc2lvbnMnKTtcbiAgY29uc3QgaW5pdGlhbElkcyA9IGluaXRpYWwubWFwKGQgPT4gZC5pZCkuc29ydCgpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGluaXRpYWxJZHMsIFsnRDAwMScsICdEMDAyJ10sICdyZS1pbXBvcnQ6IGluaXRpYWwgZGVjaXNpb25zIGFyZSBEMDAxLCBEMDAyJyk7XG5cbiAgLy8gTm93IFwidGhlIExMTSBtb2RpZmllcyBERUNJU0lPTlMubWRcIiBcdTIwMTQgYWRkIGEgdGhpcmQgZGVjaXNpb25cbiAgY29uc3QgdXBkYXRlZERlY2lzaW9ucyA9IGAjIERlY2lzaW9ucyBSZWdpc3RlclxuXG58ICMgfCBXaGVuIHwgU2NvcGUgfCBEZWNpc2lvbiB8IENob2ljZSB8IFJhdGlvbmFsZSB8IFJldmlzYWJsZT8gfFxufC0tLXwtLS0tLS18LS0tLS0tLXwtLS0tLS0tLS0tfC0tLS0tLS0tfC0tLS0tLS0tLS0tfC0tLS0tLS0tLS0tLXxcbnwgRDAwMSB8IE0wMDEvUzAxIHwgYXJjaGl0ZWN0dXJlIHwgdXNlIFNRTGl0ZSB8IGJldHRlci1zcWxpdGUzIHwgZmFzdCBhbmQgZW1iZWRkZWQgfCB5ZXMgfFxufCBEMDAyIHwgTTAwMS9TMDEgfCB0b29saW5nIHwgdXNlIHZpdGVzdCB8IHZpdGVzdCB8IG1vZGVybiB0ZXN0IHJ1bm5lciB8IHllcyB8XG58IEQwMDMgfCBNMDAxL1MwMiB8IHJ1bnRpbWUgfCBkeW5hbWljIGltcG9ydHMgfCBEMDE0IHBhdHRlcm4gfCBsYXp5IGxvYWRpbmcgfCB5ZXMgfFxuYDtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGdzZERpciwgJ0RFQ0lTSU9OUy5tZCcpLCB1cGRhdGVkRGVjaXNpb25zKTtcblxuICAvLyBSZS1pbXBvcnQgKHNpbXVsYXRpbmcgd2hhdCB0aGUgYWdlbnRfZW5kIHBhdGggZG9lcylcbiAgbWlncmF0ZUZyb21NYXJrZG93bih0bXBEaXIpO1xuXG4gIC8vIFZlcmlmeSBEQiBub3cgaGFzIDMgZGVjaXNpb25zXG4gIGNvbnN0IGFmdGVyUmVpbXBvcnQgPSBxdWVyeURlY2lzaW9ucygpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGFmdGVyUmVpbXBvcnQubGVuZ3RoLCAzLCAncmUtaW1wb3J0OiBhZnRlciByZS1pbXBvcnQgaGFzIDMgZGVjaXNpb25zJyk7XG4gIGNvbnN0IGFmdGVySWRzID0gYWZ0ZXJSZWltcG9ydC5tYXAoZCA9PiBkLmlkKS5zb3J0KCk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoYWZ0ZXJJZHMsIFsnRDAwMScsICdEMDAyJywgJ0QwMDMnXSwgJ3JlLWltcG9ydDogZGVjaXNpb25zIGFyZSBEMDAxLCBEMDAyLCBEMDAzJyk7XG5cbiAgLy8gVmVyaWZ5IHRoZSBuZXcgZGVjaXNpb24gaGFzIGNvcnJlY3QgZGF0YVxuICBjb25zdCBkMDAzID0gYWZ0ZXJSZWltcG9ydC5maW5kKGQgPT4gZC5pZCA9PT0gJ0QwMDMnKTtcbiAgYXNzZXJ0Lm9rKGQwMDMgIT09IHVuZGVmaW5lZCwgJ3JlLWltcG9ydDogRDAwMyBleGlzdHMnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkMDAzIS53aGVuX2NvbnRleHQsICdNMDAxL1MwMicsICdyZS1pbXBvcnQ6IEQwMDMgd2hlbl9jb250ZXh0IGlzIE0wMDEvUzAyJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZDAwMyEuc2NvcGUsICdydW50aW1lJywgJ3JlLWltcG9ydDogRDAwMyBzY29wZSBpcyBydW50aW1lJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZDAwMyEuY2hvaWNlLCAnRDAxNCBwYXR0ZXJuJywgJ3JlLWltcG9ydDogRDAwMyBjaG9pY2UgaXMgRDAxNCBwYXR0ZXJuJyk7XG5cbiAgLy8gVmVyaWZ5IHNjb3BlZCBxdWVyeSBwaWNrcyB1cCB0aGUgbmV3IGRlY2lzaW9uXG4gIGNvbnN0IG0wMDFTY29wZWQgPSBxdWVyeURlY2lzaW9ucyh7IG1pbGVzdG9uZUlkOiAnTTAwMScgfSk7XG4gIGFzc2VydC5vayhtMDAxU2NvcGVkLmxlbmd0aCA9PT0gMywgJ3JlLWltcG9ydDogYWxsIDMgZGVjaXNpb25zIGFyZSBmb3IgTTAwMScpO1xuXG4gIGNsb3NlRGF0YWJhc2UoKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRmluYWwgUmVwb3J0IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFPQSxTQUFTLFVBQVUsWUFBWTtBQUMvQixPQUFPLFlBQVk7QUFDbkI7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1A7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFNUCxRQUFRLElBQUksK0NBQStDO0FBQzNEO0FBQ0UsZUFBYSxVQUFVO0FBR3ZCLFdBQVMsSUFBSSxHQUFHLEtBQUssSUFBSSxLQUFLO0FBQzVCLFVBQU0s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
