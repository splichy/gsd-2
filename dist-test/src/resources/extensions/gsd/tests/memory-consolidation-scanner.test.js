import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  openDatabase,
  closeDatabase,
  insertDecision
} from "../gsd-db.js";
import { createMemory } from "../memory-store.js";
import {
  _resetNotificationStore,
  initNotificationStore,
  readNotifications
} from "../notification-store.js";
import {
  parseKnowledgeRows,
  reportConsolidationGaps,
  scanConsolidationGaps
} from "../memory-consolidation-scanner.js";
function makeTmpBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-consolidation-scan-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  initNotificationStore(base);
  return base;
}
function cleanup(base) {
  try {
    closeDatabase();
  } catch {
  }
  _resetNotificationStore();
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
  }
}
function writeKnowledgeMd(base, body) {
  writeFileSync(join(base, ".gsd", "KNOWLEDGE.md"), body, "utf-8");
}
test("parseKnowledgeRows extracts entries from the three legacy tables", () => {
  const content = `# Project Knowledge

Append-only register.

## Rules

| # | Scope | Rule | Why | Added |
|---|-------|------|-----|-------|
| K001 | project | Always pin SQLite version | corruption | 2026-01-01 |
| K002 | M001 | Use UTC | clarity | 2026-01-02 |

## Patterns

| # | Pattern | Where | Notes |
|---|---------|-------|-------|
| P001 | Repository pattern | services/ | guards |

## Lessons Learned

| # | What Happened | Root Cause | Fix | Scope |
|---|--------------|------------|-----|-------|
| L001 | Cache poisoning | reused key | versioned key | project |
`;
  const rows = parseKnowledgeRows(content);
  assert.equal(rows.length, 4, "should extract 2 rules + 1 pattern + 1 lesson");
  assert.deepEqual(
    rows.map((r) => ({ table: r.table, id: r.id })),
    [
      { table: "rules", id: "K001" },
      { table: "rules", id: "K002" },
      { table: "patterns", id: "P001" },
      { table: "lessons", id: "L001" }
    ]
  );
});
test("parseKnowledgeRows skips header/separator rows and unrecognized sections", () => {
  const content = `## Rules

| # | Scope | Rule | Why | Added |
|---|-------|------|-----|-------|

## Other Section

| # | Foo |
|---|-----|
| X999 | bar |
`;
  assert.equal(parseKnowledgeRows(content).length, 0);
});
test("parseKnowledgeRows returns empty for empty input", () => {
  assert.deepEqual(parseKnowledgeRows(""), []);
  assert.deepEqual(parseKnowledgeRows("   \n\n"), []);
});
test("scanConsolidationGaps reports zero gaps when both surfaces are empty", () => {
  const base = makeTmpBase();
  try {
    const report = scanConsolidationGaps(base);
    assert.equal(report.decisions.total, 0);
    assert.equal(report.knowledge.total, 0);
    assert.equal(report.totalGaps, 0);
    assert.match(report.summary, /all decisions and KNOWLEDGE\.md rows are in memories/);
  } finally {
    cleanup(base);
  }
});
test("scanConsolidationGaps detects unmigrated decisions and ignores migrated ones", () => {
  const base = makeTmpBase();
  try {
    insertDecision({
      id: "D001",
      when_context: "2026-01-01",
      scope: "M001",
      decision: "Decision needing migration",
      choice: "A",
      rationale: "because",
      revisable: "yes",
      made_by: "agent",
      superseded_by: null
    });
    insertDecision({
      id: "D002",
      when_context: "2026-01-02",
      scope: "M001",
      decision: "Already migrated decision",
      choice: "B",
      rationale: "covered",
      revisable: "yes",
      made_by: "agent",
      superseded_by: null
    });
    createMemory({
      category: "architecture",
      content: "Already migrated decision Chose: B. Rationale: covered.",
      scope: "M001",
      structuredFields: { sourceDecisionId: "D002" }
    });
    const report = scanConsolidationGaps(base);
    assert.equal(report.decisions.total, 2);
    assert.equal(report.decisions.migrated, 1);
    assert.equal(report.decisions.unmigrated, 1);
    assert.equal(report.decisions.samples.length, 1);
    assert.equal(report.decisions.samples[0]?.id, "D001");
    assert.equal(report.totalGaps, 1);
    assert.match(report.summary, /1 of 2 active decisions/);
  } finally {
    cleanup(base);
  }
});
test("scanConsolidationGaps skips superseded decisions (historical record only)", () => {
  const base = makeTmpBase();
  try {
    insertDecision({
      id: "D001",
      when_context: "2026-01-01",
      scope: "M001",
      decision: "Superseded \u2014 does not need migration",
      choice: "A",
      rationale: "old",
      revisable: "yes",
      made_by: "agent",
      superseded_by: "D002"
    });
    const report = scanConsolidationGaps(base);
    assert.equal(report.decisions.total, 0, "superseded decisions excluded from active count");
    assert.equal(report.totalGaps, 0);
  } finally {
    cleanup(base);
  }
});
test("scanConsolidationGaps detects unmigrated KNOWLEDGE.md rows by table", () => {
  const base = makeTmpBase();
  try {
    writeKnowledgeMd(
      base,
      `## Rules

| # | Scope | Rule | Why | Added |
|---|-------|------|-----|-------|
| K001 | project | Pin SQLite | corruption | 2026-01-01 |
| K002 | M001 | UTC only | clarity | 2026-01-02 |

## Patterns

| # | Pattern | Where | Notes |
|---|---------|-------|-------|
| P001 | Repository | services/ | guards |

## Lessons Learned

| # | What Happened | Root Cause | Fix | Scope |
|---|--------------|------------|-----|-------|
`
    );
    const report = scanConsolidationGaps(base);
    assert.equal(report.knowledge.total, 3);
    assert.equal(report.knowledge.unmigrated, 3, "no sourceKnowledgeId markers exist yet");
    assert.deepEqual(report.knowledge.byTable, { rules: 2, patterns: 1, lessons: 0 });
    assert.equal(report.knowledge.samples.length, 3);
    assert.equal(report.totalGaps, 3);
    assert.match(report.summary, /3 of 3 KNOWLEDGE\.md rows/);
  } finally {
    cleanup(base);
  }
});
test("scanConsolidationGaps combines decisions and KNOWLEDGE.md gaps in summary", () => {
  const base = makeTmpBase();
  try {
    insertDecision({
      id: "D001",
      when_context: "2026-01-01",
      scope: "M001",
      decision: "Unmigrated decision",
      choice: "A",
      rationale: "x",
      revisable: "yes",
      made_by: "agent",
      superseded_by: null
    });
    writeKnowledgeMd(
      base,
      `## Rules

| # | Scope | Rule | Why | Added |
|---|-------|------|-----|-------|
| K001 | project | Some rule | reason | 2026-01-01 |
`
    );
    const report = scanConsolidationGaps(base);
    assert.equal(report.totalGaps, 2);
    assert.match(report.summary, /1 of 1 active decisions/);
    assert.match(report.summary, /1 of 1 KNOWLEDGE\.md rows/);
  } finally {
    cleanup(base);
  }
});
test("reportConsolidationGaps emits a notification + warning when gaps exist", () => {
  const base = makeTmpBase();
  try {
    insertDecision({
      id: "D001",
      when_context: "2026-01-01",
      scope: "M001",
      decision: "Unmigrated",
      choice: "A",
      rationale: "x",
      revisable: "yes",
      made_by: "agent",
      superseded_by: null
    });
    const report = reportConsolidationGaps(base);
    assert.ok(report);
    assert.equal(report.totalGaps, 1);
    const notifications = readNotifications(base);
    const gapNotifs = notifications.filter((n) => n.message.includes("Memory consolidation"));
    assert.ok(gapNotifs.length >= 1, "a consolidation notification should be persisted");
    assert.equal(gapNotifs[0]?.severity, "warning");
  } finally {
    cleanup(base);
  }
});
test("reportConsolidationGaps stays silent when there are no gaps", () => {
  const base = makeTmpBase();
  try {
    const report = reportConsolidationGaps(base);
    assert.ok(report);
    assert.equal(report.totalGaps, 0);
    const notifications = readNotifications(base);
    const gapNotifs = notifications.filter((n) => n.message.includes("not yet in memories"));
    assert.equal(gapNotifs.length, 0, "no warning notification when clean");
  } finally {
    cleanup(base);
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9tZW1vcnktY29uc29saWRhdGlvbi1zY2FubmVyLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRC0yIFx1MjAxNCBBRFItMDEzIFBoYXNlIDYgcHJlZmxpZ2h0IHNjYW5uZXIgdGVzdHMuXG4vL1xuLy8gTG9ja3MgaW4gdGhlIGZvdXIgc3RhdGVzIHRoZSBzY2FubmVyIG11c3QgZGlzdGluZ3Vpc2g6XG4vLyAgIDEuIENsZWFuIFx1MjAxNCBubyBnYXBzLCBubyB3YXJuaW5nIGVtaXR0ZWQuXG4vLyAgIDIuIERlY2lzaW9ucyBnYXAgXHUyMDE0IGFjdGl2ZSBkZWNpc2lvbnMgd2l0aG91dCBhIG1pZ3JhdGVkIG1lbW9yeS5cbi8vICAgMy4gS05PV0xFREdFLm1kIGdhcCBcdTIwMTQgcm93cyBpbiB0aGUgbGVnYWN5IG1hcmtkb3duIHdpdGhvdXQgbWlncmF0aW9uLlxuLy8gICA0LiBCb3RoIGdhcHMgXHUyMDE0IGNvbWJpbmVkIHN1bW1hcnkgbWVzc2FnZS5cblxuaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgbWtkaXJTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5cbmltcG9ydCB7XG4gIG9wZW5EYXRhYmFzZSxcbiAgY2xvc2VEYXRhYmFzZSxcbiAgaW5zZXJ0RGVjaXNpb24sXG59IGZyb20gXCIuLi9nc2QtZGIudHNcIjtcbmltcG9ydCB7IGNyZWF0ZU1lbW9yeSB9IGZyb20gXCIuLi9tZW1vcnktc3RvcmUudHNcIjtcbmltcG9ydCB7XG4gIF9yZXNldE5vdGlmaWNhdGlvblN0b3JlLFxuICBpbml0Tm90aWZpY2F0aW9uU3RvcmUsXG4gIHJlYWROb3RpZmljYXRpb25zLFxufSBmcm9tIFwiLi4vbm90aWZpY2F0aW9uLXN0b3JlLnRzXCI7XG5pbXBvcnQge1xuICBwYXJzZUtub3dsZWRnZVJvd3MsXG4gIHJlcG9ydENvbnNvbGlkYXRpb25HYXBzLFxuICBzY2FuQ29uc29saWRhdGlvbkdhcHMsXG59IGZyb20gXCIuLi9tZW1vcnktY29uc29saWRhdGlvbi1zY2FubmVyLnRzXCI7XG5cbmZ1bmN0aW9uIG1ha2VUbXBCYXNlKCk6IHN0cmluZyB7XG4gIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1jb25zb2xpZGF0aW9uLXNjYW4tXCIpKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiZ3NkLmRiXCIpKTtcbiAgaW5pdE5vdGlmaWNhdGlvblN0b3JlKGJhc2UpO1xuICByZXR1cm4gYmFzZTtcbn1cblxuZnVuY3Rpb24gY2xlYW51cChiYXNlOiBzdHJpbmcpOiB2b2lkIHtcbiAgdHJ5IHtcbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gIH0gY2F0Y2gge1xuICAgIC8qIG5vb3AgKi9cbiAgfVxuICBfcmVzZXROb3RpZmljYXRpb25TdG9yZSgpO1xuICB0cnkge1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH0gY2F0Y2gge1xuICAgIC8qIG5vb3AgKi9cbiAgfVxufVxuXG5mdW5jdGlvbiB3cml0ZUtub3dsZWRnZU1kKGJhc2U6IHN0cmluZywgYm9keTogc3RyaW5nKTogdm9pZCB7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJLTk9XTEVER0UubWRcIiksIGJvZHksIFwidXRmLThcIik7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBwYXJzZUtub3dsZWRnZVJvd3MgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJwYXJzZUtub3dsZWRnZVJvd3MgZXh0cmFjdHMgZW50cmllcyBmcm9tIHRoZSB0aHJlZSBsZWdhY3kgdGFibGVzXCIsICgpID0+IHtcbiAgY29uc3QgY29udGVudCA9IGAjIFByb2plY3QgS25vd2xlZGdlXG5cbkFwcGVuZC1vbmx5IHJlZ2lzdGVyLlxuXG4jIyBSdWxlc1xuXG58ICMgfCBTY29wZSB8IFJ1bGUgfCBXaHkgfCBBZGRlZCB8XG58LS0tfC0tLS0tLS18LS0tLS0tfC0tLS0tfC0tLS0tLS18XG58IEswMDEgfCBwcm9qZWN0IHwgQWx3YXlzIHBpbiBTUUxpdGUgdmVyc2lvbiB8IGNvcnJ1cHRpb24gfCAyMDI2LTAxLTAxIHxcbnwgSzAwMiB8IE0wMDEgfCBVc2UgVVRDIHwgY2xhcml0eSB8IDIwMjYtMDEtMDIgfFxuXG4jIyBQYXR0ZXJuc1xuXG58ICMgfCBQYXR0ZXJuIHwgV2hlcmUgfCBOb3RlcyB8XG58LS0tfC0tLS0tLS0tLXwtLS0tLS0tfC0tLS0tLS18XG58IFAwMDEgfCBSZXBvc2l0b3J5IHBhdHRlcm4gfCBzZXJ2aWNlcy8gfCBndWFyZHMgfFxuXG4jIyBMZXNzb25zIExlYXJuZWRcblxufCAjIHwgV2hhdCBIYXBwZW5lZCB8IFJvb3QgQ2F1c2UgfCBGaXggfCBTY29wZSB8XG58LS0tfC0tLS0tLS0tLS0tLS0tfC0tLS0tLS0tLS0tLXwtLS0tLXwtLS0tLS0tfFxufCBMMDAxIHwgQ2FjaGUgcG9pc29uaW5nIHwgcmV1c2VkIGtleSB8IHZlcnNpb25lZCBrZXkgfCBwcm9qZWN0IHxcbmA7XG5cbiAgY29uc3Qgcm93cyA9IHBhcnNlS25vd2xlZGdlUm93cyhjb250ZW50KTtcbiAgYXNzZXJ0LmVxdWFsKHJvd3MubGVuZ3RoLCA0LCBcInNob3VsZCBleHRyYWN0IDIgcnVsZXMgKyAxIHBhdHRlcm4gKyAxIGxlc3NvblwiKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICByb3dzLm1hcCgocikgPT4gKHsgdGFibGU6IHIudGFibGUsIGlkOiByLmlkIH0pKSxcbiAgICBbXG4gICAgICB7IHRhYmxlOiBcInJ1bGVzXCIsIGlkOiBcIkswMDFcIiB9LFxuICAgICAgeyB0YWJsZTogXCJydWxlc1wiLCBpZDogXCJLMDAyXCIgfSxcbiAgICAgIHsgdGFibGU6IFwicGF0dGVybnNcIiwgaWQ6IFwiUDAwMVwiIH0sXG4gICAgICB7IHRhYmxlOiBcImxlc3NvbnNcIiwgaWQ6IFwiTDAwMVwiIH0sXG4gICAgXSxcbiAgKTtcbn0pO1xuXG50ZXN0KFwicGFyc2VLbm93bGVkZ2VSb3dzIHNraXBzIGhlYWRlci9zZXBhcmF0b3Igcm93cyBhbmQgdW5yZWNvZ25pemVkIHNlY3Rpb25zXCIsICgpID0+IHtcbiAgY29uc3QgY29udGVudCA9IGAjIyBSdWxlc1xuXG58ICMgfCBTY29wZSB8IFJ1bGUgfCBXaHkgfCBBZGRlZCB8XG58LS0tfC0tLS0tLS18LS0tLS0tfC0tLS0tfC0tLS0tLS18XG5cbiMjIE90aGVyIFNlY3Rpb25cblxufCAjIHwgRm9vIHxcbnwtLS18LS0tLS18XG58IFg5OTkgfCBiYXIgfFxuYDtcblxuICAvLyBFbXB0eSBSdWxlcyB0YWJsZSBcdTIxOTIgMCByb3dzLiBVbnJlY29nbml6ZWQgXCJPdGhlciBTZWN0aW9uXCIgaXMgaWdub3JlZC5cbiAgYXNzZXJ0LmVxdWFsKHBhcnNlS25vd2xlZGdlUm93cyhjb250ZW50KS5sZW5ndGgsIDApO1xufSk7XG5cbnRlc3QoXCJwYXJzZUtub3dsZWRnZVJvd3MgcmV0dXJucyBlbXB0eSBmb3IgZW1wdHkgaW5wdXRcIiwgKCkgPT4ge1xuICBhc3NlcnQuZGVlcEVxdWFsKHBhcnNlS25vd2xlZGdlUm93cyhcIlwiKSwgW10pO1xuICBhc3NlcnQuZGVlcEVxdWFsKHBhcnNlS25vd2xlZGdlUm93cyhcIiAgIFxcblxcblwiKSwgW10pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBzY2FuQ29uc29saWRhdGlvbkdhcHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJzY2FuQ29uc29saWRhdGlvbkdhcHMgcmVwb3J0cyB6ZXJvIGdhcHMgd2hlbiBib3RoIHN1cmZhY2VzIGFyZSBlbXB0eVwiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIGNvbnN0IHJlcG9ydCA9IHNjYW5Db25zb2xpZGF0aW9uR2FwcyhiYXNlKTtcbiAgICBhc3NlcnQuZXF1YWwocmVwb3J0LmRlY2lzaW9ucy50b3RhbCwgMCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlcG9ydC5rbm93bGVkZ2UudG90YWwsIDApO1xuICAgIGFzc2VydC5lcXVhbChyZXBvcnQudG90YWxHYXBzLCAwKTtcbiAgICBhc3NlcnQubWF0Y2gocmVwb3J0LnN1bW1hcnksIC9hbGwgZGVjaXNpb25zIGFuZCBLTk9XTEVER0VcXC5tZCByb3dzIGFyZSBpbiBtZW1vcmllcy8pO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwic2NhbkNvbnNvbGlkYXRpb25HYXBzIGRldGVjdHMgdW5taWdyYXRlZCBkZWNpc2lvbnMgYW5kIGlnbm9yZXMgbWlncmF0ZWQgb25lc1wiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIGluc2VydERlY2lzaW9uKHtcbiAgICAgIGlkOiBcIkQwMDFcIixcbiAgICAgIHdoZW5fY29udGV4dDogXCIyMDI2LTAxLTAxXCIsXG4gICAgICBzY29wZTogXCJNMDAxXCIsXG4gICAgICBkZWNpc2lvbjogXCJEZWNpc2lvbiBuZWVkaW5nIG1pZ3JhdGlvblwiLFxuICAgICAgY2hvaWNlOiBcIkFcIixcbiAgICAgIHJhdGlvbmFsZTogXCJiZWNhdXNlXCIsXG4gICAgICByZXZpc2FibGU6IFwieWVzXCIsXG4gICAgICBtYWRlX2J5OiBcImFnZW50XCIsXG4gICAgICBzdXBlcnNlZGVkX2J5OiBudWxsLFxuICAgIH0pO1xuICAgIGluc2VydERlY2lzaW9uKHtcbiAgICAgIGlkOiBcIkQwMDJcIixcbiAgICAgIHdoZW5fY29udGV4dDogXCIyMDI2LTAxLTAyXCIsXG4gICAgICBzY29wZTogXCJNMDAxXCIsXG4gICAgICBkZWNpc2lvbjogXCJBbHJlYWR5IG1pZ3JhdGVkIGRlY2lzaW9uXCIsXG4gICAgICBjaG9pY2U6IFwiQlwiLFxuICAgICAgcmF0aW9uYWxlOiBcImNvdmVyZWRcIixcbiAgICAgIHJldmlzYWJsZTogXCJ5ZXNcIixcbiAgICAgIG1hZGVfYnk6IFwiYWdlbnRcIixcbiAgICAgIHN1cGVyc2VkZWRfYnk6IG51bGwsXG4gICAgfSk7XG4gICAgLy8gRDAwMiBoYXMgYSBjb3JyZXNwb25kaW5nIG1pZ3JhdGVkIG1lbW9yeTsgRDAwMSBkb2Vzbid0LlxuICAgIGNyZWF0ZU1lbW9yeSh7XG4gICAgICBjYXRlZ29yeTogXCJhcmNoaXRlY3R1cmVcIixcbiAgICAgIGNvbnRlbnQ6IFwiQWxyZWFkeSBtaWdyYXRlZCBkZWNpc2lvbiBDaG9zZTogQi4gUmF0aW9uYWxlOiBjb3ZlcmVkLlwiLFxuICAgICAgc2NvcGU6IFwiTTAwMVwiLFxuICAgICAgc3RydWN0dXJlZEZpZWxkczogeyBzb3VyY2VEZWNpc2lvbklkOiBcIkQwMDJcIiB9LFxuICAgIH0pO1xuXG4gICAgY29uc3QgcmVwb3J0ID0gc2NhbkNvbnNvbGlkYXRpb25HYXBzKGJhc2UpO1xuICAgIGFzc2VydC5lcXVhbChyZXBvcnQuZGVjaXNpb25zLnRvdGFsLCAyKTtcbiAgICBhc3NlcnQuZXF1YWwocmVwb3J0LmRlY2lzaW9ucy5taWdyYXRlZCwgMSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlcG9ydC5kZWNpc2lvbnMudW5taWdyYXRlZCwgMSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlcG9ydC5kZWNpc2lvbnMuc2FtcGxlcy5sZW5ndGgsIDEpO1xuICAgIGFzc2VydC5lcXVhbChyZXBvcnQuZGVjaXNpb25zLnNhbXBsZXNbMF0/LmlkLCBcIkQwMDFcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlcG9ydC50b3RhbEdhcHMsIDEpO1xuICAgIGFzc2VydC5tYXRjaChyZXBvcnQuc3VtbWFyeSwgLzEgb2YgMiBhY3RpdmUgZGVjaXNpb25zLyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJzY2FuQ29uc29saWRhdGlvbkdhcHMgc2tpcHMgc3VwZXJzZWRlZCBkZWNpc2lvbnMgKGhpc3RvcmljYWwgcmVjb3JkIG9ubHkpXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgaW5zZXJ0RGVjaXNpb24oe1xuICAgICAgaWQ6IFwiRDAwMVwiLFxuICAgICAgd2hlbl9jb250ZXh0OiBcIjIwMjYtMDEtMDFcIixcbiAgICAgIHNjb3BlOiBcIk0wMDFcIixcbiAgICAgIGRlY2lzaW9uOiBcIlN1cGVyc2VkZWQgXHUyMDE0IGRvZXMgbm90IG5lZWQgbWlncmF0aW9uXCIsXG4gICAgICBjaG9pY2U6IFwiQVwiLFxuICAgICAgcmF0aW9uYWxlOiBcIm9sZFwiLFxuICAgICAgcmV2aXNhYmxlOiBcInllc1wiLFxuICAgICAgbWFkZV9ieTogXCJhZ2VudFwiLFxuICAgICAgc3VwZXJzZWRlZF9ieTogXCJEMDAyXCIsXG4gICAgfSk7XG5cbiAgICBjb25zdCByZXBvcnQgPSBzY2FuQ29uc29saWRhdGlvbkdhcHMoYmFzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlcG9ydC5kZWNpc2lvbnMudG90YWwsIDAsIFwic3VwZXJzZWRlZCBkZWNpc2lvbnMgZXhjbHVkZWQgZnJvbSBhY3RpdmUgY291bnRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlcG9ydC50b3RhbEdhcHMsIDApO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwic2NhbkNvbnNvbGlkYXRpb25HYXBzIGRldGVjdHMgdW5taWdyYXRlZCBLTk9XTEVER0UubWQgcm93cyBieSB0YWJsZVwiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIHdyaXRlS25vd2xlZGdlTWQoXG4gICAgICBiYXNlLFxuICAgICAgYCMjIFJ1bGVzXG5cbnwgIyB8IFNjb3BlIHwgUnVsZSB8IFdoeSB8IEFkZGVkIHxcbnwtLS18LS0tLS0tLXwtLS0tLS18LS0tLS18LS0tLS0tLXxcbnwgSzAwMSB8IHByb2plY3QgfCBQaW4gU1FMaXRlIHwgY29ycnVwdGlvbiB8IDIwMjYtMDEtMDEgfFxufCBLMDAyIHwgTTAwMSB8IFVUQyBvbmx5IHwgY2xhcml0eSB8IDIwMjYtMDEtMDIgfFxuXG4jIyBQYXR0ZXJuc1xuXG58ICMgfCBQYXR0ZXJuIHwgV2hlcmUgfCBOb3RlcyB8XG58LS0tfC0tLS0tLS0tLXwtLS0tLS0tfC0tLS0tLS18XG58IFAwMDEgfCBSZXBvc2l0b3J5IHwgc2VydmljZXMvIHwgZ3VhcmRzIHxcblxuIyMgTGVzc29ucyBMZWFybmVkXG5cbnwgIyB8IFdoYXQgSGFwcGVuZWQgfCBSb290IENhdXNlIHwgRml4IHwgU2NvcGUgfFxufC0tLXwtLS0tLS0tLS0tLS0tLXwtLS0tLS0tLS0tLS18LS0tLS18LS0tLS0tLXxcbmAsXG4gICAgKTtcblxuICAgIGNvbnN0IHJlcG9ydCA9IHNjYW5Db25zb2xpZGF0aW9uR2FwcyhiYXNlKTtcbiAgICBhc3NlcnQuZXF1YWwocmVwb3J0Lmtub3dsZWRnZS50b3RhbCwgMyk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlcG9ydC5rbm93bGVkZ2UudW5taWdyYXRlZCwgMywgXCJubyBzb3VyY2VLbm93bGVkZ2VJZCBtYXJrZXJzIGV4aXN0IHlldFwiKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHJlcG9ydC5rbm93bGVkZ2UuYnlUYWJsZSwgeyBydWxlczogMiwgcGF0dGVybnM6IDEsIGxlc3NvbnM6IDAgfSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlcG9ydC5rbm93bGVkZ2Uuc2FtcGxlcy5sZW5ndGgsIDMpO1xuICAgIGFzc2VydC5lcXVhbChyZXBvcnQudG90YWxHYXBzLCAzKTtcbiAgICBhc3NlcnQubWF0Y2gocmVwb3J0LnN1bW1hcnksIC8zIG9mIDMgS05PV0xFREdFXFwubWQgcm93cy8pO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwic2NhbkNvbnNvbGlkYXRpb25HYXBzIGNvbWJpbmVzIGRlY2lzaW9ucyBhbmQgS05PV0xFREdFLm1kIGdhcHMgaW4gc3VtbWFyeVwiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIGluc2VydERlY2lzaW9uKHtcbiAgICAgIGlkOiBcIkQwMDFcIixcbiAgICAgIHdoZW5fY29udGV4dDogXCIyMDI2LTAxLTAxXCIsXG4gICAgICBzY29wZTogXCJNMDAxXCIsXG4gICAgICBkZWNpc2lvbjogXCJVbm1pZ3JhdGVkIGRlY2lzaW9uXCIsXG4gICAgICBjaG9pY2U6IFwiQVwiLFxuICAgICAgcmF0aW9uYWxlOiBcInhcIixcbiAgICAgIHJldmlzYWJsZTogXCJ5ZXNcIixcbiAgICAgIG1hZGVfYnk6IFwiYWdlbnRcIixcbiAgICAgIHN1cGVyc2VkZWRfYnk6IG51bGwsXG4gICAgfSk7XG4gICAgd3JpdGVLbm93bGVkZ2VNZChcbiAgICAgIGJhc2UsXG4gICAgICBgIyMgUnVsZXNcblxufCAjIHwgU2NvcGUgfCBSdWxlIHwgV2h5IHwgQWRkZWQgfFxufC0tLXwtLS0tLS0tfC0tLS0tLXwtLS0tLXwtLS0tLS0tfFxufCBLMDAxIHwgcHJvamVjdCB8IFNvbWUgcnVsZSB8IHJlYXNvbiB8IDIwMjYtMDEtMDEgfFxuYCxcbiAgICApO1xuXG4gICAgY29uc3QgcmVwb3J0ID0gc2NhbkNvbnNvbGlkYXRpb25HYXBzKGJhc2UpO1xuICAgIGFzc2VydC5lcXVhbChyZXBvcnQudG90YWxHYXBzLCAyKTtcbiAgICBhc3NlcnQubWF0Y2gocmVwb3J0LnN1bW1hcnksIC8xIG9mIDEgYWN0aXZlIGRlY2lzaW9ucy8pO1xuICAgIGFzc2VydC5tYXRjaChyZXBvcnQuc3VtbWFyeSwgLzEgb2YgMSBLTk9XTEVER0VcXC5tZCByb3dzLyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCByZXBvcnRDb25zb2xpZGF0aW9uR2FwcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcInJlcG9ydENvbnNvbGlkYXRpb25HYXBzIGVtaXRzIGEgbm90aWZpY2F0aW9uICsgd2FybmluZyB3aGVuIGdhcHMgZXhpc3RcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICBpbnNlcnREZWNpc2lvbih7XG4gICAgICBpZDogXCJEMDAxXCIsXG4gICAgICB3aGVuX2NvbnRleHQ6IFwiMjAyNi0wMS0wMVwiLFxuICAgICAgc2NvcGU6IFwiTTAwMVwiLFxuICAgICAgZGVjaXNpb246IFwiVW5taWdyYXRlZFwiLFxuICAgICAgY2hvaWNlOiBcIkFcIixcbiAgICAgIHJhdGlvbmFsZTogXCJ4XCIsXG4gICAgICByZXZpc2FibGU6IFwieWVzXCIsXG4gICAgICBtYWRlX2J5OiBcImFnZW50XCIsXG4gICAgICBzdXBlcnNlZGVkX2J5OiBudWxsLFxuICAgIH0pO1xuXG4gICAgY29uc3QgcmVwb3J0ID0gcmVwb3J0Q29uc29saWRhdGlvbkdhcHMoYmFzZSk7XG4gICAgYXNzZXJ0Lm9rKHJlcG9ydCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlcG9ydC50b3RhbEdhcHMsIDEpO1xuXG4gICAgY29uc3Qgbm90aWZpY2F0aW9ucyA9IHJlYWROb3RpZmljYXRpb25zKGJhc2UpO1xuICAgIGNvbnN0IGdhcE5vdGlmcyA9IG5vdGlmaWNhdGlvbnMuZmlsdGVyKChuKSA9PiBuLm1lc3NhZ2UuaW5jbHVkZXMoXCJNZW1vcnkgY29uc29saWRhdGlvblwiKSk7XG4gICAgYXNzZXJ0Lm9rKGdhcE5vdGlmcy5sZW5ndGggPj0gMSwgXCJhIGNvbnNvbGlkYXRpb24gbm90aWZpY2F0aW9uIHNob3VsZCBiZSBwZXJzaXN0ZWRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGdhcE5vdGlmc1swXT8uc2V2ZXJpdHksIFwid2FybmluZ1wiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcInJlcG9ydENvbnNvbGlkYXRpb25HYXBzIHN0YXlzIHNpbGVudCB3aGVuIHRoZXJlIGFyZSBubyBnYXBzXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVwb3J0ID0gcmVwb3J0Q29uc29saWRhdGlvbkdhcHMoYmFzZSk7XG4gICAgYXNzZXJ0Lm9rKHJlcG9ydCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlcG9ydC50b3RhbEdhcHMsIDApO1xuICAgIGNvbnN0IG5vdGlmaWNhdGlvbnMgPSByZWFkTm90aWZpY2F0aW9ucyhiYXNlKTtcbiAgICBjb25zdCBnYXBOb3RpZnMgPSBub3RpZmljYXRpb25zLmZpbHRlcigobikgPT4gbi5tZXNzYWdlLmluY2x1ZGVzKFwibm90IHlldCBpbiBtZW1vcmllc1wiKSk7XG4gICAgYXNzZXJ0LmVxdWFsKGdhcE5vdGlmcy5sZW5ndGgsIDAsIFwibm8gd2FybmluZyBub3RpZmljYXRpb24gd2hlbiBjbGVhblwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQVFBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxhQUFhLFdBQVcsUUFBUSxxQkFBcUI7QUFDOUQsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUV2QjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFDUCxTQUFTLG9CQUFvQjtBQUM3QjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFDUDtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFFUCxTQUFTLGNBQXNC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
