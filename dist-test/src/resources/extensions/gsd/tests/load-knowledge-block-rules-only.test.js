import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadKnowledgeBlock } from "../bootstrap/system-context.js";
import { extractIntroAndRules } from "../knowledge-parser.js";
function makeTmpProject() {
  const base = mkdtempSync(join(tmpdir(), "gsd-knowledge-rules-only-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}
function makeTmpHome() {
  const home = mkdtempSync(join(tmpdir(), "gsd-knowledge-home-"));
  mkdirSync(join(home, "agent"), { recursive: true });
  return home;
}
function cleanup(...dirs) {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
    }
  }
}
const FULL_KNOWLEDGE = `# Project Knowledge

Append-only register of project-specific rules, patterns, and lessons learned.

## Rules

| # | Scope | Rule | Why | Added |
|---|-------|------|-----|-------|
| K001 | project | All timestamps in UTC | clarity | 2026-01-01 |
| K002 | M001 | Never trust user input | safety | 2026-01-02 |

## Patterns

| # | Pattern | Where | Notes |
|---|---------|-------|-------|
| P001 | Repository pattern | services/ | guards |

## Lessons Learned

| # | What Happened | Root Cause | Fix | Scope |
|---|--------------|------------|-----|-------|
| L001 | Cache poisoning | reused key | versioned key | project |
`;
test("extractIntroAndRules keeps intro + Rules, drops Patterns + Lessons", () => {
  const out = extractIntroAndRules(FULL_KNOWLEDGE);
  assert.match(out, /# Project Knowledge/);
  assert.match(out, /## Rules/);
  assert.match(out, /\| K001 \| project \| All timestamps in UTC/);
  assert.match(out, /\| K002 \| M001 \| Never trust user input/);
  assert.equal(out.includes("## Patterns"), false, "Patterns heading must be dropped");
  assert.equal(out.includes("P001"), false, "Pattern rows must be dropped");
  assert.equal(out.includes("## Lessons Learned"), false, "Lessons heading must be dropped");
  assert.equal(out.includes("L001"), false, "Lesson rows must be dropped");
});
test("extractIntroAndRules returns content unchanged when no `## Rules` heading", () => {
  const content = "# Notes\n\nfreeform content without standard sections\n";
  assert.equal(extractIntroAndRules(content), content);
});
test("extractIntroAndRules returns empty for empty input", () => {
  assert.equal(extractIntroAndRules(""), "");
  assert.equal(extractIntroAndRules("   \n\n"), "");
});
test("extractIntroAndRules handles Rules as the only section (no Patterns/Lessons to drop)", () => {
  const content = `# Project Knowledge

## Rules

| # | Scope | Rule | Why | Added |
|---|-------|------|-----|-------|
| K001 | project | only rule | reason | 2026-01-01 |
`;
  const out = extractIntroAndRules(content);
  assert.match(out, /K001/);
  assert.match(out, /## Rules/);
});
test("loadKnowledgeBlock trims project KNOWLEDGE.md to intro + Rules", () => {
  const base = makeTmpProject();
  const home = makeTmpHome();
  try {
    writeFileSync(join(base, ".gsd", "KNOWLEDGE.md"), FULL_KNOWLEDGE, "utf-8");
    const { block } = loadKnowledgeBlock(home, base);
    assert.match(block, /## Project Knowledge/);
    assert.match(block, /K001/);
    assert.match(block, /K002/);
    assert.equal(block.includes("P001"), false, "project Patterns must not appear in the block");
    assert.equal(block.includes("L001"), false, "project Lessons must not appear in the block");
    assert.equal(block.includes("## Patterns"), false);
    assert.equal(block.includes("## Lessons Learned"), false);
  } finally {
    cleanup(base, home);
  }
});
test("loadKnowledgeBlock leaves global KNOWLEDGE.md intact (no memory projection there)", () => {
  const base = makeTmpProject();
  const home = makeTmpHome();
  try {
    writeFileSync(join(home, "agent", "KNOWLEDGE.md"), FULL_KNOWLEDGE, "utf-8");
    const { block, globalSizeKb } = loadKnowledgeBlock(home, base);
    assert.match(block, /## Global Knowledge/);
    assert.match(block, /K001/);
    assert.match(block, /P001/);
    assert.match(block, /L001/);
    assert.match(block, /## Patterns/);
    assert.match(block, /## Lessons Learned/);
    assert.ok(globalSizeKb > 0, "globalSizeKb should report the global file size");
  } finally {
    cleanup(base, home);
  }
});
test("loadKnowledgeBlock with both global and project: global keeps full content, project trimmed", () => {
  const base = makeTmpProject();
  const home = makeTmpHome();
  try {
    writeFileSync(join(home, "agent", "KNOWLEDGE.md"), FULL_KNOWLEDGE, "utf-8");
    writeFileSync(join(base, ".gsd", "KNOWLEDGE.md"), FULL_KNOWLEDGE, "utf-8");
    const { block } = loadKnowledgeBlock(home, base);
    assert.match(block, /## Global Knowledge/);
    assert.match(block, /## Project Knowledge/);
    const patternsCount = (block.match(/## Patterns/g) ?? []).length;
    const lessonsCount = (block.match(/## Lessons Learned/g) ?? []).length;
    assert.equal(patternsCount, 1, "Patterns heading appears exactly once (in global)");
    assert.equal(lessonsCount, 1, "Lessons heading appears exactly once (in global)");
    const k001Count = (block.match(/K001/g) ?? []).length;
    const p001Count = (block.match(/P001/g) ?? []).length;
    const l001Count = (block.match(/L001/g) ?? []).length;
    assert.equal(k001Count, 2, "K001 in both global and project");
    assert.equal(p001Count, 1, "P001 only in global");
    assert.equal(l001Count, 1, "L001 only in global");
  } finally {
    cleanup(base, home);
  }
});
test("loadKnowledgeBlock returns empty block when neither file exists", () => {
  const base = makeTmpProject();
  const home = makeTmpHome();
  try {
    const result = loadKnowledgeBlock(home, base);
    assert.equal(result.block, "");
    assert.equal(result.globalSizeKb, 0);
  } finally {
    cleanup(base, home);
  }
});
test("loadKnowledgeBlock injects only Rules when project KNOWLEDGE.md has no Patterns/Lessons", () => {
  const base = makeTmpProject();
  const home = makeTmpHome();
  try {
    writeFileSync(
      join(base, ".gsd", "KNOWLEDGE.md"),
      `# Project Knowledge

## Rules

| # | Scope | Rule | Why | Added |
|---|-------|------|-----|-------|
| K001 | project | rule one | reason | 2026-01-01 |
`,
      "utf-8"
    );
    const { block } = loadKnowledgeBlock(home, base);
    assert.match(block, /K001/);
    assert.match(block, /Rules from KNOWLEDGE\.md/);
  } finally {
    cleanup(base, home);
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9sb2FkLWtub3dsZWRnZS1ibG9jay1ydWxlcy1vbmx5LnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEFEUi0wMTMgZm9sbG93LXVwIFx1MjAxNCBsb2FkS25vd2xlZGdlQmxvY2sgaW5qZWN0cyBvbmx5IFJ1bGVzIGZyb20gcHJvamVjdFxuLy8gS05PV0xFREdFLm1kIHRvIGF2b2lkIGR1cGxpY2F0aW5nIFBhdHRlcm5zICsgTGVzc29ucyBjb250ZW50IGFscmVhZHlcbi8vIGluamVjdGVkIHZpYSBsb2FkTWVtb3J5QmxvY2sgKFN0YWdlIDJiIGN1dG92ZXIpLlxuLy9cbi8vIEdsb2JhbCBLTk9XTEVER0UubWQgKH4vLmdzZC9hZ2VudC9LTk9XTEVER0UubWQpIGlzIE5PVCBtZW1vcnktcHJvamVjdGVkXG4vLyBhbmQgc3RpbGwgcGFzc2VzIHRocm91Z2ggd2l0aCBhbGwgdGhyZWUgc2VjdGlvbnMgaW50YWN0LlxuXG5pbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBta2RpclN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcblxuaW1wb3J0IHsgbG9hZEtub3dsZWRnZUJsb2NrIH0gZnJvbSBcIi4uL2Jvb3RzdHJhcC9zeXN0ZW0tY29udGV4dC50c1wiO1xuaW1wb3J0IHsgZXh0cmFjdEludHJvQW5kUnVsZXMgfSBmcm9tIFwiLi4va25vd2xlZGdlLXBhcnNlci50c1wiO1xuXG5mdW5jdGlvbiBtYWtlVG1wUHJvamVjdCgpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2Qta25vd2xlZGdlLXJ1bGVzLW9ubHktXCIpKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgcmV0dXJuIGJhc2U7XG59XG5cbmZ1bmN0aW9uIG1ha2VUbXBIb21lKCk6IHN0cmluZyB7XG4gIGNvbnN0IGhvbWUgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1rbm93bGVkZ2UtaG9tZS1cIikpO1xuICBta2RpclN5bmMoam9pbihob21lLCBcImFnZW50XCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgcmV0dXJuIGhvbWU7XG59XG5cbmZ1bmN0aW9uIGNsZWFudXAoLi4uZGlyczogc3RyaW5nW10pOiB2b2lkIHtcbiAgZm9yIChjb25zdCBkaXIgb2YgZGlycykge1xuICAgIHRyeSB7XG4gICAgICBybVN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBub29wICovXG4gICAgfVxuICB9XG59XG5cbmNvbnN0IEZVTExfS05PV0xFREdFID0gYCMgUHJvamVjdCBLbm93bGVkZ2VcblxuQXBwZW5kLW9ubHkgcmVnaXN0ZXIgb2YgcHJvamVjdC1zcGVjaWZpYyBydWxlcywgcGF0dGVybnMsIGFuZCBsZXNzb25zIGxlYXJuZWQuXG5cbiMjIFJ1bGVzXG5cbnwgIyB8IFNjb3BlIHwgUnVsZSB8IFdoeSB8IEFkZGVkIHxcbnwtLS18LS0tLS0tLXwtLS0tLS18LS0tLS18LS0tLS0tLXxcbnwgSzAwMSB8IHByb2plY3QgfCBBbGwgdGltZXN0YW1wcyBpbiBVVEMgfCBjbGFyaXR5IHwgMjAyNi0wMS0wMSB8XG58IEswMDIgfCBNMDAxIHwgTmV2ZXIgdHJ1c3QgdXNlciBpbnB1dCB8IHNhZmV0eSB8IDIwMjYtMDEtMDIgfFxuXG4jIyBQYXR0ZXJuc1xuXG58ICMgfCBQYXR0ZXJuIHwgV2hlcmUgfCBOb3RlcyB8XG58LS0tfC0tLS0tLS0tLXwtLS0tLS0tfC0tLS0tLS18XG58IFAwMDEgfCBSZXBvc2l0b3J5IHBhdHRlcm4gfCBzZXJ2aWNlcy8gfCBndWFyZHMgfFxuXG4jIyBMZXNzb25zIExlYXJuZWRcblxufCAjIHwgV2hhdCBIYXBwZW5lZCB8IFJvb3QgQ2F1c2UgfCBGaXggfCBTY29wZSB8XG58LS0tfC0tLS0tLS0tLS0tLS0tfC0tLS0tLS0tLS0tLXwtLS0tLXwtLS0tLS0tfFxufCBMMDAxIHwgQ2FjaGUgcG9pc29uaW5nIHwgcmV1c2VkIGtleSB8IHZlcnNpb25lZCBrZXkgfCBwcm9qZWN0IHxcbmA7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBleHRyYWN0SW50cm9BbmRSdWxlcyB1bml0IHRlc3RzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiZXh0cmFjdEludHJvQW5kUnVsZXMga2VlcHMgaW50cm8gKyBSdWxlcywgZHJvcHMgUGF0dGVybnMgKyBMZXNzb25zXCIsICgpID0+IHtcbiAgY29uc3Qgb3V0ID0gZXh0cmFjdEludHJvQW5kUnVsZXMoRlVMTF9LTk9XTEVER0UpO1xuICBhc3NlcnQubWF0Y2gob3V0LCAvIyBQcm9qZWN0IEtub3dsZWRnZS8pO1xuICBhc3NlcnQubWF0Y2gob3V0LCAvIyMgUnVsZXMvKTtcbiAgYXNzZXJ0Lm1hdGNoKG91dCwgL1xcfCBLMDAxIFxcfCBwcm9qZWN0IFxcfCBBbGwgdGltZXN0YW1wcyBpbiBVVEMvKTtcbiAgYXNzZXJ0Lm1hdGNoKG91dCwgL1xcfCBLMDAyIFxcfCBNMDAxIFxcfCBOZXZlciB0cnVzdCB1c2VyIGlucHV0Lyk7XG5cbiAgYXNzZXJ0LmVxdWFsKG91dC5pbmNsdWRlcyhcIiMjIFBhdHRlcm5zXCIpLCBmYWxzZSwgXCJQYXR0ZXJucyBoZWFkaW5nIG11c3QgYmUgZHJvcHBlZFwiKTtcbiAgYXNzZXJ0LmVxdWFsKG91dC5pbmNsdWRlcyhcIlAwMDFcIiksIGZhbHNlLCBcIlBhdHRlcm4gcm93cyBtdXN0IGJlIGRyb3BwZWRcIik7XG4gIGFzc2VydC5lcXVhbChvdXQuaW5jbHVkZXMoXCIjIyBMZXNzb25zIExlYXJuZWRcIiksIGZhbHNlLCBcIkxlc3NvbnMgaGVhZGluZyBtdXN0IGJlIGRyb3BwZWRcIik7XG4gIGFzc2VydC5lcXVhbChvdXQuaW5jbHVkZXMoXCJMMDAxXCIpLCBmYWxzZSwgXCJMZXNzb24gcm93cyBtdXN0IGJlIGRyb3BwZWRcIik7XG59KTtcblxudGVzdChcImV4dHJhY3RJbnRyb0FuZFJ1bGVzIHJldHVybnMgY29udGVudCB1bmNoYW5nZWQgd2hlbiBubyBgIyMgUnVsZXNgIGhlYWRpbmdcIiwgKCkgPT4ge1xuICBjb25zdCBjb250ZW50ID0gXCIjIE5vdGVzXFxuXFxuZnJlZWZvcm0gY29udGVudCB3aXRob3V0IHN0YW5kYXJkIHNlY3Rpb25zXFxuXCI7XG4gIGFzc2VydC5lcXVhbChleHRyYWN0SW50cm9BbmRSdWxlcyhjb250ZW50KSwgY29udGVudCk7XG59KTtcblxudGVzdChcImV4dHJhY3RJbnRyb0FuZFJ1bGVzIHJldHVybnMgZW1wdHkgZm9yIGVtcHR5IGlucHV0XCIsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKGV4dHJhY3RJbnRyb0FuZFJ1bGVzKFwiXCIpLCBcIlwiKTtcbiAgYXNzZXJ0LmVxdWFsKGV4dHJhY3RJbnRyb0FuZFJ1bGVzKFwiICAgXFxuXFxuXCIpLCBcIlwiKTtcbn0pO1xuXG50ZXN0KFwiZXh0cmFjdEludHJvQW5kUnVsZXMgaGFuZGxlcyBSdWxlcyBhcyB0aGUgb25seSBzZWN0aW9uIChubyBQYXR0ZXJucy9MZXNzb25zIHRvIGRyb3ApXCIsICgpID0+IHtcbiAgY29uc3QgY29udGVudCA9IGAjIFByb2plY3QgS25vd2xlZGdlXG5cbiMjIFJ1bGVzXG5cbnwgIyB8IFNjb3BlIHwgUnVsZSB8IFdoeSB8IEFkZGVkIHxcbnwtLS18LS0tLS0tLXwtLS0tLS18LS0tLS18LS0tLS0tLXxcbnwgSzAwMSB8IHByb2plY3QgfCBvbmx5IHJ1bGUgfCByZWFzb24gfCAyMDI2LTAxLTAxIHxcbmA7XG4gIGNvbnN0IG91dCA9IGV4dHJhY3RJbnRyb0FuZFJ1bGVzKGNvbnRlbnQpO1xuICBhc3NlcnQubWF0Y2gob3V0LCAvSzAwMS8pO1xuICBhc3NlcnQubWF0Y2gob3V0LCAvIyMgUnVsZXMvKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgbG9hZEtub3dsZWRnZUJsb2NrIGludGVncmF0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwibG9hZEtub3dsZWRnZUJsb2NrIHRyaW1zIHByb2plY3QgS05PV0xFREdFLm1kIHRvIGludHJvICsgUnVsZXNcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcFByb2plY3QoKTtcbiAgY29uc3QgaG9tZSA9IG1ha2VUbXBIb21lKCk7XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIktOT1dMRURHRS5tZFwiKSwgRlVMTF9LTk9XTEVER0UsIFwidXRmLThcIik7XG4gICAgY29uc3QgeyBibG9jayB9ID0gbG9hZEtub3dsZWRnZUJsb2NrKGhvbWUsIGJhc2UpO1xuXG4gICAgYXNzZXJ0Lm1hdGNoKGJsb2NrLCAvIyMgUHJvamVjdCBLbm93bGVkZ2UvKTtcbiAgICBhc3NlcnQubWF0Y2goYmxvY2ssIC9LMDAxLyk7XG4gICAgYXNzZXJ0Lm1hdGNoKGJsb2NrLCAvSzAwMi8pO1xuICAgIGFzc2VydC5lcXVhbChibG9jay5pbmNsdWRlcyhcIlAwMDFcIiksIGZhbHNlLCBcInByb2plY3QgUGF0dGVybnMgbXVzdCBub3QgYXBwZWFyIGluIHRoZSBibG9ja1wiKTtcbiAgICBhc3NlcnQuZXF1YWwoYmxvY2suaW5jbHVkZXMoXCJMMDAxXCIpLCBmYWxzZSwgXCJwcm9qZWN0IExlc3NvbnMgbXVzdCBub3QgYXBwZWFyIGluIHRoZSBibG9ja1wiKTtcbiAgICBhc3NlcnQuZXF1YWwoYmxvY2suaW5jbHVkZXMoXCIjIyBQYXR0ZXJuc1wiKSwgZmFsc2UpO1xuICAgIGFzc2VydC5lcXVhbChibG9jay5pbmNsdWRlcyhcIiMjIExlc3NvbnMgTGVhcm5lZFwiKSwgZmFsc2UpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSwgaG9tZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwibG9hZEtub3dsZWRnZUJsb2NrIGxlYXZlcyBnbG9iYWwgS05PV0xFREdFLm1kIGludGFjdCAobm8gbWVtb3J5IHByb2plY3Rpb24gdGhlcmUpXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBQcm9qZWN0KCk7XG4gIGNvbnN0IGhvbWUgPSBtYWtlVG1wSG9tZSgpO1xuICB0cnkge1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihob21lLCBcImFnZW50XCIsIFwiS05PV0xFREdFLm1kXCIpLCBGVUxMX0tOT1dMRURHRSwgXCJ1dGYtOFwiKTtcbiAgICBjb25zdCB7IGJsb2NrLCBnbG9iYWxTaXplS2IgfSA9IGxvYWRLbm93bGVkZ2VCbG9jayhob21lLCBiYXNlKTtcblxuICAgIGFzc2VydC5tYXRjaChibG9jaywgLyMjIEdsb2JhbCBLbm93bGVkZ2UvKTtcbiAgICAvLyBHbG9iYWwgaXMgZnVsbC1maWRlbGl0eTogYWxsIHRocmVlIHNlY3Rpb25zIGludGFjdC5cbiAgICBhc3NlcnQubWF0Y2goYmxvY2ssIC9LMDAxLyk7XG4gICAgYXNzZXJ0Lm1hdGNoKGJsb2NrLCAvUDAwMS8pO1xuICAgIGFzc2VydC5tYXRjaChibG9jaywgL0wwMDEvKTtcbiAgICBhc3NlcnQubWF0Y2goYmxvY2ssIC8jIyBQYXR0ZXJucy8pO1xuICAgIGFzc2VydC5tYXRjaChibG9jaywgLyMjIExlc3NvbnMgTGVhcm5lZC8pO1xuICAgIGFzc2VydC5vayhnbG9iYWxTaXplS2IgPiAwLCBcImdsb2JhbFNpemVLYiBzaG91bGQgcmVwb3J0IHRoZSBnbG9iYWwgZmlsZSBzaXplXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSwgaG9tZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwibG9hZEtub3dsZWRnZUJsb2NrIHdpdGggYm90aCBnbG9iYWwgYW5kIHByb2plY3Q6IGdsb2JhbCBrZWVwcyBmdWxsIGNvbnRlbnQsIHByb2plY3QgdHJpbW1lZFwiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wUHJvamVjdCgpO1xuICBjb25zdCBob21lID0gbWFrZVRtcEhvbWUoKTtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oaG9tZSwgXCJhZ2VudFwiLCBcIktOT1dMRURHRS5tZFwiKSwgRlVMTF9LTk9XTEVER0UsIFwidXRmLThcIik7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIktOT1dMRURHRS5tZFwiKSwgRlVMTF9LTk9XTEVER0UsIFwidXRmLThcIik7XG4gICAgY29uc3QgeyBibG9jayB9ID0gbG9hZEtub3dsZWRnZUJsb2NrKGhvbWUsIGJhc2UpO1xuXG4gICAgLy8gQm90aCBzZWN0aW9ucyBwcmVzZW50LlxuICAgIGFzc2VydC5tYXRjaChibG9jaywgLyMjIEdsb2JhbCBLbm93bGVkZ2UvKTtcbiAgICBhc3NlcnQubWF0Y2goYmxvY2ssIC8jIyBQcm9qZWN0IEtub3dsZWRnZS8pO1xuXG4gICAgLy8gUHJvamVjdCdzIFBhdHRlcm5zL0xlc3NvbnMgaGVhZGluZ3MgbXVzdCBiZSBnb25lLiBCdXQgZ2xvYmFsIGtlZXBzXG4gICAgLy8gdGhlbSwgc28gYSBzdWJzdHJpbmcgY291bnQgb2YgZS5nLiBcIiMjIFBhdHRlcm5zXCIgc2hvdWxkIGVxdWFsIDEuXG4gICAgY29uc3QgcGF0dGVybnNDb3VudCA9IChibG9jay5tYXRjaCgvIyMgUGF0dGVybnMvZykgPz8gW10pLmxlbmd0aDtcbiAgICBjb25zdCBsZXNzb25zQ291bnQgPSAoYmxvY2subWF0Y2goLyMjIExlc3NvbnMgTGVhcm5lZC9nKSA/PyBbXSkubGVuZ3RoO1xuICAgIGFzc2VydC5lcXVhbChwYXR0ZXJuc0NvdW50LCAxLCBcIlBhdHRlcm5zIGhlYWRpbmcgYXBwZWFycyBleGFjdGx5IG9uY2UgKGluIGdsb2JhbClcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGxlc3NvbnNDb3VudCwgMSwgXCJMZXNzb25zIGhlYWRpbmcgYXBwZWFycyBleGFjdGx5IG9uY2UgKGluIGdsb2JhbClcIik7XG5cbiAgICAvLyBLL1AvTCByb3dzOiBLIGFwcGVhcnMgdHdpY2UgKGdsb2JhbCArIHByb2plY3QpLCBQL0wgYXBwZWFyIG9uY2UgKGdsb2JhbCkuXG4gICAgY29uc3QgazAwMUNvdW50ID0gKGJsb2NrLm1hdGNoKC9LMDAxL2cpID8/IFtdKS5sZW5ndGg7XG4gICAgY29uc3QgcDAwMUNvdW50ID0gKGJsb2NrLm1hdGNoKC9QMDAxL2cpID8/IFtdKS5sZW5ndGg7XG4gICAgY29uc3QgbDAwMUNvdW50ID0gKGJsb2NrLm1hdGNoKC9MMDAxL2cpID8/IFtdKS5sZW5ndGg7XG4gICAgYXNzZXJ0LmVxdWFsKGswMDFDb3VudCwgMiwgXCJLMDAxIGluIGJvdGggZ2xvYmFsIGFuZCBwcm9qZWN0XCIpO1xuICAgIGFzc2VydC5lcXVhbChwMDAxQ291bnQsIDEsIFwiUDAwMSBvbmx5IGluIGdsb2JhbFwiKTtcbiAgICBhc3NlcnQuZXF1YWwobDAwMUNvdW50LCAxLCBcIkwwMDEgb25seSBpbiBnbG9iYWxcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlLCBob21lKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJsb2FkS25vd2xlZGdlQmxvY2sgcmV0dXJucyBlbXB0eSBibG9jayB3aGVuIG5laXRoZXIgZmlsZSBleGlzdHNcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcFByb2plY3QoKTtcbiAgY29uc3QgaG9tZSA9IG1ha2VUbXBIb21lKCk7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0ID0gbG9hZEtub3dsZWRnZUJsb2NrKGhvbWUsIGJhc2UpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuYmxvY2ssIFwiXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuZ2xvYmFsU2l6ZUtiLCAwKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UsIGhvbWUpO1xuICB9XG59KTtcblxudGVzdChcImxvYWRLbm93bGVkZ2VCbG9jayBpbmplY3RzIG9ubHkgUnVsZXMgd2hlbiBwcm9qZWN0IEtOT1dMRURHRS5tZCBoYXMgbm8gUGF0dGVybnMvTGVzc29uc1wiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wUHJvamVjdCgpO1xuICBjb25zdCBob21lID0gbWFrZVRtcEhvbWUoKTtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihiYXNlLCBcIi5nc2RcIiwgXCJLTk9XTEVER0UubWRcIiksXG4gICAgICBgIyBQcm9qZWN0IEtub3dsZWRnZVxuXG4jIyBSdWxlc1xuXG58ICMgfCBTY29wZSB8IFJ1bGUgfCBXaHkgfCBBZGRlZCB8XG58LS0tfC0tLS0tLS18LS0tLS0tfC0tLS0tfC0tLS0tLS18XG58IEswMDEgfCBwcm9qZWN0IHwgcnVsZSBvbmUgfCByZWFzb24gfCAyMDI2LTAxLTAxIHxcbmAsXG4gICAgICBcInV0Zi04XCIsXG4gICAgKTtcbiAgICBjb25zdCB7IGJsb2NrIH0gPSBsb2FkS25vd2xlZGdlQmxvY2soaG9tZSwgYmFzZSk7XG4gICAgYXNzZXJ0Lm1hdGNoKGJsb2NrLCAvSzAwMS8pO1xuICAgIC8vIEJsb2NrIGhlYWRpbmcgcmVmbGVjdHMgdGhlIG5ldyBjb250cmFjdC5cbiAgICBhc3NlcnQubWF0Y2goYmxvY2ssIC9SdWxlcyBmcm9tIEtOT1dMRURHRVxcLm1kLyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlLCBob21lKTtcbiAgfVxufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFPQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxXQUFXLFFBQVEscUJBQXFCO0FBQzlELFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFFdkIsU0FBUywwQkFBMEI7QUFDbkMsU0FBUyw0QkFBNEI7QUFFckMsU0FBUyxpQkFBeUI7QUFDaEMsUUFBTSxPQUFPLFlBQVksS0FBSyxPQUFPLEdBQUcsMkJBQTJCLENBQUM7QUFDcEUsWUFBVSxLQUFLLE1BQU0sTUFBTSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDakQsU0FBTztBQUNUO0FBRUEsU0FBUyxjQUFzQjtBQUM3QixRQUFNLE9BQU8sWUFBWSxLQUFLLE9BQU8sR0FBRyxxQkFBcUIsQ0FBQztBQUM5RCxZQUFVLEtBQUssTUFBTSxPQUFPLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNsRCxTQUFPO0FBQ1Q7QUFFQSxTQUFTLFdBQVcsTUFBc0I7QUFDeEMsYUFBVyxPQUFPLE1BQU07QUFDdEIsUUFBSTtBQUNGLGFBQU8sS0FBSyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQzlDLFFBQVE7QUFBQSxJQUVSO0FBQUEsRUFDRjtBQUNGO0FBRUEsTUFBTSxpQkFBaUI7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtB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
