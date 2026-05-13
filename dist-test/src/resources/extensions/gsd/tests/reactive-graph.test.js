import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveTaskGraph,
  getReadyTasks,
  chooseNonConflictingSubset,
  isGraphAmbiguous,
  getMissingAnnotationTasks,
  detectDeadlock,
  graphMetrics
} from "../reactive-graph.js";
import { parseTaskPlanIO } from "../files.js";
test("parseTaskPlanIO extracts backtick-wrapped file paths from Inputs and Expected Output", () => {
  const content = `---
estimated_steps: 3
estimated_files: 2
---

# T01: Setup Models

**Slice:** S01 \u2014 Core Setup
**Milestone:** M001

## Description

Create the core data models.

## Steps

1. Create types file
2. Create models file

## Must-Haves

- [ ] Type definitions complete

## Verification

- Run type checker

## Inputs

- \`src/types.ts\` \u2014 Existing type definitions from prior work
- \`src/config.json\` \u2014 Configuration schema

## Expected Output

- \`src/models.ts\` \u2014 New data model definitions
- \`src/models.test.ts\` \u2014 Unit tests for models
`;
  const io = parseTaskPlanIO(content);
  assert.deepEqual(io.inputFiles, ["src/types.ts", "src/config.json"]);
  assert.deepEqual(io.outputFiles, ["src/models.ts", "src/models.test.ts"]);
});
test("parseTaskPlanIO returns empty arrays for missing sections", () => {
  const content = `# T01: Something

## Description

No IO sections here.
`;
  const io = parseTaskPlanIO(content);
  assert.deepEqual(io.inputFiles, []);
  assert.deepEqual(io.outputFiles, []);
});
test("parseTaskPlanIO ignores non-file-path backtick tokens", () => {
  const content = `# T01: Test

## Inputs

- \`true\` \u2014 a boolean flag
- \`src/index.ts\` \u2014 main entry
- \`npm run test\` \u2014 a command, not a file

## Expected Output

- \`dist/bundle.js\` \u2014 compiled output
- \`false\` \u2014 not a file
`;
  const io = parseTaskPlanIO(content);
  assert.deepEqual(io.inputFiles, ["src/index.ts"]);
  assert.deepEqual(io.outputFiles, ["dist/bundle.js"]);
});
test("parseTaskPlanIO handles multiple backtick tokens on one line", () => {
  const content = `# T01: Multi

## Inputs

- \`src/a.ts\` and \`src/b.ts\` \u2014 both needed

## Expected Output

- \`src/c.ts\` \u2014 output
`;
  const io = parseTaskPlanIO(content);
  assert.deepEqual(io.inputFiles, ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(io.outputFiles, ["src/c.ts"]);
});
test("parseTaskPlanIO strips inline descriptions from backtick-wrapped file references", () => {
  const content = `# T01: Described Paths

## Inputs

- \`src/config.ts \u2014 existing configuration\`
- \`src/flags.ts - feature flags\`

## Expected Output

- \`definitions/ac-audit.md \u2014 current state of AC CRM\`
- \`docs/runbook.md - update deployment notes\`
`;
  const io = parseTaskPlanIO(content);
  assert.deepEqual(io.inputFiles, ["src/config.ts", "src/flags.ts"]);
  assert.deepEqual(io.outputFiles, ["definitions/ac-audit.md", "docs/runbook.md"]);
});
test("deriveTaskGraph: linear chain T01\u2192T02\u2192T03", () => {
  const tasks = [
    { id: "T01", title: "First", inputFiles: [], outputFiles: ["src/a.ts"], done: false },
    { id: "T02", title: "Second", inputFiles: ["src/a.ts"], outputFiles: ["src/b.ts"], done: false },
    { id: "T03", title: "Third", inputFiles: ["src/b.ts"], outputFiles: ["src/c.ts"], done: false }
  ];
  const graph = deriveTaskGraph(tasks);
  assert.deepEqual(graph[0].dependsOn, []);
  assert.deepEqual(graph[1].dependsOn, ["T01"]);
  assert.deepEqual(graph[2].dependsOn, ["T02"]);
});
test("deriveTaskGraph: diamond dependency", () => {
  const tasks = [
    { id: "T01", title: "Base", inputFiles: [], outputFiles: ["src/base.ts"], done: false },
    { id: "T02", title: "Left", inputFiles: ["src/base.ts"], outputFiles: ["src/left.ts"], done: false },
    { id: "T03", title: "Right", inputFiles: ["src/base.ts"], outputFiles: ["src/right.ts"], done: false },
    { id: "T04", title: "Merge", inputFiles: ["src/left.ts", "src/right.ts"], outputFiles: ["src/final.ts"], done: false }
  ];
  const graph = deriveTaskGraph(tasks);
  assert.deepEqual(graph[0].dependsOn, []);
  assert.deepEqual(graph[1].dependsOn, ["T01"]);
  assert.deepEqual(graph[2].dependsOn, ["T01"]);
  assert.deepEqual(graph[3].dependsOn, ["T02", "T03"]);
});
test("deriveTaskGraph: fully independent tasks", () => {
  const tasks = [
    { id: "T01", title: "A", inputFiles: [], outputFiles: ["src/a.ts"], done: false },
    { id: "T02", title: "B", inputFiles: [], outputFiles: ["src/b.ts"], done: false },
    { id: "T03", title: "C", inputFiles: [], outputFiles: ["src/c.ts"], done: false }
  ];
  const graph = deriveTaskGraph(tasks);
  assert.deepEqual(graph[0].dependsOn, []);
  assert.deepEqual(graph[1].dependsOn, []);
  assert.deepEqual(graph[2].dependsOn, []);
});
test("deriveTaskGraph: self-referencing output\u2192input is excluded", () => {
  const tasks = [
    { id: "T01", title: "Self", inputFiles: ["src/a.ts"], outputFiles: ["src/a.ts"], done: false }
  ];
  const graph = deriveTaskGraph(tasks);
  assert.deepEqual(graph[0].dependsOn, []);
});
test("getReadyTasks: partially completed graph", () => {
  const tasks = [
    { id: "T01", title: "Base", inputFiles: [], outputFiles: ["src/a.ts"], done: true },
    { id: "T02", title: "Dep", inputFiles: ["src/a.ts"], outputFiles: ["src/b.ts"], done: false },
    { id: "T03", title: "Blocked", inputFiles: ["src/b.ts"], outputFiles: ["src/c.ts"], done: false }
  ];
  const graph = deriveTaskGraph(tasks);
  const ready = getReadyTasks(graph, /* @__PURE__ */ new Set(["T01"]), /* @__PURE__ */ new Set());
  assert.deepEqual(ready, ["T02"]);
});
test("getReadyTasks: nothing complete \u2192 only root tasks ready", () => {
  const tasks = [
    { id: "T01", title: "Root", inputFiles: [], outputFiles: ["src/a.ts"], done: false },
    { id: "T02", title: "Dep", inputFiles: ["src/a.ts"], outputFiles: ["src/b.ts"], done: false }
  ];
  const graph = deriveTaskGraph(tasks);
  const ready = getReadyTasks(graph, /* @__PURE__ */ new Set(), /* @__PURE__ */ new Set());
  assert.deepEqual(ready, ["T01"]);
});
test("getReadyTasks: all complete \u2192 empty", () => {
  const tasks = [
    { id: "T01", title: "Done", inputFiles: [], outputFiles: ["src/a.ts"], done: true }
  ];
  const graph = deriveTaskGraph(tasks);
  const ready = getReadyTasks(graph, /* @__PURE__ */ new Set(["T01"]), /* @__PURE__ */ new Set());
  assert.deepEqual(ready, []);
});
test("getReadyTasks: in-flight tasks excluded", () => {
  const tasks = [
    { id: "T01", title: "A", inputFiles: [], outputFiles: ["src/a.ts"], done: false },
    { id: "T02", title: "B", inputFiles: [], outputFiles: ["src/b.ts"], done: false }
  ];
  const graph = deriveTaskGraph(tasks);
  const ready = getReadyTasks(graph, /* @__PURE__ */ new Set(), /* @__PURE__ */ new Set(["T01"]));
  assert.deepEqual(ready, ["T02"]);
});
test("chooseNonConflictingSubset: output conflicts", () => {
  const tasks = [
    { id: "T01", title: "A", inputFiles: [], outputFiles: ["src/shared.ts"], done: false },
    { id: "T02", title: "B", inputFiles: [], outputFiles: ["src/shared.ts"], done: false },
    { id: "T03", title: "C", inputFiles: [], outputFiles: ["src/other.ts"], done: false }
  ];
  const graph = deriveTaskGraph(tasks);
  const selected = chooseNonConflictingSubset(["T01", "T02", "T03"], graph, 3, /* @__PURE__ */ new Set());
  assert.deepEqual(selected, ["T01", "T03"]);
});
test("chooseNonConflictingSubset: respects maxParallel", () => {
  const tasks = [
    { id: "T01", title: "A", inputFiles: [], outputFiles: ["src/a.ts"], done: false },
    { id: "T02", title: "B", inputFiles: [], outputFiles: ["src/b.ts"], done: false },
    { id: "T03", title: "C", inputFiles: [], outputFiles: ["src/c.ts"], done: false }
  ];
  const graph = deriveTaskGraph(tasks);
  const selected = chooseNonConflictingSubset(["T01", "T02", "T03"], graph, 2, /* @__PURE__ */ new Set());
  assert.deepEqual(selected, ["T01", "T02"]);
});
test("chooseNonConflictingSubset: respects inFlightOutputs", () => {
  const tasks = [
    { id: "T01", title: "A", inputFiles: [], outputFiles: ["src/a.ts"], done: false },
    { id: "T02", title: "B", inputFiles: [], outputFiles: ["src/b.ts"], done: false }
  ];
  const graph = deriveTaskGraph(tasks);
  const selected = chooseNonConflictingSubset(["T01", "T02"], graph, 4, /* @__PURE__ */ new Set(["src/a.ts"]));
  assert.deepEqual(selected, ["T02"]);
});
test("isGraphAmbiguous: task with no IO \u2192 ambiguous", () => {
  const graph = [
    { id: "T01", title: "A", inputFiles: [], outputFiles: [], done: false, dependsOn: [] },
    { id: "T02", title: "B", inputFiles: ["src/a.ts"], outputFiles: ["src/b.ts"], done: false, dependsOn: [] }
  ];
  assert.equal(isGraphAmbiguous(graph), true);
});
test("isGraphAmbiguous: all tasks have IO \u2192 not ambiguous", () => {
  const graph = [
    { id: "T01", title: "A", inputFiles: [], outputFiles: ["src/a.ts"], done: false, dependsOn: [] },
    { id: "T02", title: "B", inputFiles: ["src/a.ts"], outputFiles: ["src/b.ts"], done: false, dependsOn: ["T01"] }
  ];
  assert.equal(isGraphAmbiguous(graph), false);
});
test("isGraphAmbiguous: done tasks with no IO are ignored", () => {
  const graph = [
    { id: "T01", title: "A", inputFiles: [], outputFiles: [], done: true, dependsOn: [] },
    { id: "T02", title: "B", inputFiles: [], outputFiles: ["src/b.ts"], done: false, dependsOn: [] }
  ];
  assert.equal(isGraphAmbiguous(graph), false);
});
test("detectDeadlock: circular dependency detected", () => {
  const graph = [
    { id: "T01", title: "A", inputFiles: ["src/b.ts"], outputFiles: ["src/a.ts"], done: false, dependsOn: ["T02"] },
    { id: "T02", title: "B", inputFiles: ["src/a.ts"], outputFiles: ["src/b.ts"], done: false, dependsOn: ["T01"] }
  ];
  assert.equal(detectDeadlock(graph, /* @__PURE__ */ new Set(), /* @__PURE__ */ new Set()), true);
});
test("detectDeadlock: normal blocked-waiting-for-in-flight \u2192 not deadlock", () => {
  const graph = [
    { id: "T01", title: "A", inputFiles: [], outputFiles: ["src/a.ts"], done: false, dependsOn: [] },
    { id: "T02", title: "B", inputFiles: ["src/a.ts"], outputFiles: ["src/b.ts"], done: false, dependsOn: ["T01"] }
  ];
  assert.equal(detectDeadlock(graph, /* @__PURE__ */ new Set(), /* @__PURE__ */ new Set(["T01"])), false);
});
test("detectDeadlock: all complete \u2192 not deadlock", () => {
  const graph = [
    { id: "T01", title: "A", inputFiles: [], outputFiles: ["src/a.ts"], done: true, dependsOn: [] }
  ];
  assert.equal(detectDeadlock(graph, /* @__PURE__ */ new Set(["T01"]), /* @__PURE__ */ new Set()), false);
});
test("graphMetrics computes correct values", () => {
  const tasks = [
    { id: "T01", title: "A", inputFiles: [], outputFiles: ["src/a.ts"], done: true },
    { id: "T02", title: "B", inputFiles: ["src/a.ts"], outputFiles: ["src/b.ts"], done: false },
    { id: "T03", title: "C", inputFiles: [], outputFiles: ["src/c.ts"], done: false }
  ];
  const graph = deriveTaskGraph(tasks);
  const metrics = graphMetrics(graph);
  assert.equal(metrics.taskCount, 3);
  assert.equal(metrics.edgeCount, 1);
  assert.equal(metrics.readySetSize, 2);
  assert.equal(metrics.ambiguous, false);
});
test("getMissingAnnotationTasks: returns empty array when all tasks have annotations", () => {
  const graph = [
    { id: "T01", title: "A", inputFiles: ["src/a.ts"], outputFiles: ["src/b.ts"], done: false, dependsOn: [] },
    { id: "T02", title: "B", inputFiles: [], outputFiles: ["src/c.ts"], done: false, dependsOn: [] }
  ];
  assert.deepEqual(getMissingAnnotationTasks(graph), []);
});
test("getMissingAnnotationTasks: returns tasks with missing annotations", () => {
  const graph = [
    { id: "T01", title: "A", inputFiles: [], outputFiles: [], done: false, dependsOn: [] },
    { id: "T02", title: "B", inputFiles: ["src/a.ts"], outputFiles: ["src/b.ts"], done: false, dependsOn: [] },
    { id: "T03", title: "C", inputFiles: [], outputFiles: [], done: false, dependsOn: [] }
  ];
  assert.deepEqual(getMissingAnnotationTasks(graph), [
    { id: "T01", title: "A" },
    { id: "T03", title: "C" }
  ]);
});
test("getMissingAnnotationTasks: skips done tasks", () => {
  const graph = [
    { id: "T01", title: "A", inputFiles: [], outputFiles: [], done: true, dependsOn: [] },
    { id: "T02", title: "B", inputFiles: [], outputFiles: [], done: false, dependsOn: [] }
  ];
  assert.deepEqual(getMissingAnnotationTasks(graph), [
    { id: "T02", title: "B" }
  ]);
});
test("getMissingAnnotationTasks: returns only tasks missing BOTH inputFiles and outputFiles", () => {
  const graph = [
    { id: "T01", title: "InputOnly", inputFiles: ["src/a.ts"], outputFiles: [], done: false, dependsOn: [] },
    { id: "T02", title: "OutputOnly", inputFiles: [], outputFiles: ["src/b.ts"], done: false, dependsOn: [] },
    { id: "T03", title: "Neither", inputFiles: [], outputFiles: [], done: false, dependsOn: [] },
    { id: "T04", title: "Both", inputFiles: ["src/c.ts"], outputFiles: ["src/d.ts"], done: false, dependsOn: [] }
  ];
  assert.deepEqual(getMissingAnnotationTasks(graph), [
    { id: "T03", title: "Neither" }
  ]);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9yZWFjdGl2ZS1ncmFwaC50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7XG4gIGRlcml2ZVRhc2tHcmFwaCxcbiAgZ2V0UmVhZHlUYXNrcyxcbiAgY2hvb3NlTm9uQ29uZmxpY3RpbmdTdWJzZXQsXG4gIGlzR3JhcGhBbWJpZ3VvdXMsXG4gIGdldE1pc3NpbmdBbm5vdGF0aW9uVGFza3MsXG4gIGRldGVjdERlYWRsb2NrLFxuICBncmFwaE1ldHJpY3MsXG59IGZyb20gXCIuLi9yZWFjdGl2ZS1ncmFwaC50c1wiO1xuaW1wb3J0IHsgcGFyc2VUYXNrUGxhbklPIH0gZnJvbSBcIi4uL2ZpbGVzLnRzXCI7XG5pbXBvcnQgdHlwZSB7IFRhc2tJTywgRGVyaXZlZFRhc2tOb2RlIH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBwYXJzZVRhc2tQbGFuSU8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJwYXJzZVRhc2tQbGFuSU8gZXh0cmFjdHMgYmFja3RpY2std3JhcHBlZCBmaWxlIHBhdGhzIGZyb20gSW5wdXRzIGFuZCBFeHBlY3RlZCBPdXRwdXRcIiwgKCkgPT4ge1xuICBjb25zdCBjb250ZW50ID0gYC0tLVxuZXN0aW1hdGVkX3N0ZXBzOiAzXG5lc3RpbWF0ZWRfZmlsZXM6IDJcbi0tLVxuXG4jIFQwMTogU2V0dXAgTW9kZWxzXG5cbioqU2xpY2U6KiogUzAxIFx1MjAxNCBDb3JlIFNldHVwXG4qKk1pbGVzdG9uZToqKiBNMDAxXG5cbiMjIERlc2NyaXB0aW9uXG5cbkNyZWF0ZSB0aGUgY29yZSBkYXRhIG1vZGVscy5cblxuIyMgU3RlcHNcblxuMS4gQ3JlYXRlIHR5cGVzIGZpbGVcbjIuIENyZWF0ZSBtb2RlbHMgZmlsZVxuXG4jIyBNdXN0LUhhdmVzXG5cbi0gWyBdIFR5cGUgZGVmaW5pdGlvbnMgY29tcGxldGVcblxuIyMgVmVyaWZpY2F0aW9uXG5cbi0gUnVuIHR5cGUgY2hlY2tlclxuXG4jIyBJbnB1dHNcblxuLSBcXGBzcmMvdHlwZXMudHNcXGAgXHUyMDE0IEV4aXN0aW5nIHR5cGUgZGVmaW5pdGlvbnMgZnJvbSBwcmlvciB3b3JrXG4tIFxcYHNyYy9jb25maWcuanNvblxcYCBcdTIwMTQgQ29uZmlndXJhdGlvbiBzY2hlbWFcblxuIyMgRXhwZWN0ZWQgT3V0cHV0XG5cbi0gXFxgc3JjL21vZGVscy50c1xcYCBcdTIwMTQgTmV3IGRhdGEgbW9kZWwgZGVmaW5pdGlvbnNcbi0gXFxgc3JjL21vZGVscy50ZXN0LnRzXFxgIFx1MjAxNCBVbml0IHRlc3RzIGZvciBtb2RlbHNcbmA7XG5cbiAgY29uc3QgaW8gPSBwYXJzZVRhc2tQbGFuSU8oY29udGVudCk7XG4gIGFzc2VydC5kZWVwRXF1YWwoaW8uaW5wdXRGaWxlcywgW1wic3JjL3R5cGVzLnRzXCIsIFwic3JjL2NvbmZpZy5qc29uXCJdKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChpby5vdXRwdXRGaWxlcywgW1wic3JjL21vZGVscy50c1wiLCBcInNyYy9tb2RlbHMudGVzdC50c1wiXSk7XG59KTtcblxudGVzdChcInBhcnNlVGFza1BsYW5JTyByZXR1cm5zIGVtcHR5IGFycmF5cyBmb3IgbWlzc2luZyBzZWN0aW9uc1wiLCAoKSA9PiB7XG4gIGNvbnN0IGNvbnRlbnQgPSBgIyBUMDE6IFNvbWV0aGluZ1xcblxcbiMjIERlc2NyaXB0aW9uXFxuXFxuTm8gSU8gc2VjdGlvbnMgaGVyZS5cXG5gO1xuICBjb25zdCBpbyA9IHBhcnNlVGFza1BsYW5JTyhjb250ZW50KTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChpby5pbnB1dEZpbGVzLCBbXSk7XG4gIGFzc2VydC5kZWVwRXF1YWwoaW8ub3V0cHV0RmlsZXMsIFtdKTtcbn0pO1xuXG50ZXN0KFwicGFyc2VUYXNrUGxhbklPIGlnbm9yZXMgbm9uLWZpbGUtcGF0aCBiYWNrdGljayB0b2tlbnNcIiwgKCkgPT4ge1xuICBjb25zdCBjb250ZW50ID0gYCMgVDAxOiBUZXN0XG5cbiMjIElucHV0c1xuXG4tIFxcYHRydWVcXGAgXHUyMDE0IGEgYm9vbGVhbiBmbGFnXG4tIFxcYHNyYy9pbmRleC50c1xcYCBcdTIwMTQgbWFpbiBlbnRyeVxuLSBcXGBucG0gcnVuIHRlc3RcXGAgXHUyMDE0IGEgY29tbWFuZCwgbm90IGEgZmlsZVxuXG4jIyBFeHBlY3RlZCBPdXRwdXRcblxuLSBcXGBkaXN0L2J1bmRsZS5qc1xcYCBcdTIwMTQgY29tcGlsZWQgb3V0cHV0XG4tIFxcYGZhbHNlXFxgIFx1MjAxNCBub3QgYSBmaWxlXG5gO1xuXG4gIGNvbnN0IGlvID0gcGFyc2VUYXNrUGxhbklPKGNvbnRlbnQpO1xuICBhc3NlcnQuZGVlcEVxdWFsKGlvLmlucHV0RmlsZXMsIFtcInNyYy9pbmRleC50c1wiXSk7XG4gIGFzc2VydC5kZWVwRXF1YWwoaW8ub3V0cHV0RmlsZXMsIFtcImRpc3QvYnVuZGxlLmpzXCJdKTtcbn0pO1xuXG50ZXN0KFwicGFyc2VUYXNrUGxhbklPIGhhbmRsZXMgbXVsdGlwbGUgYmFja3RpY2sgdG9rZW5zIG9uIG9uZSBsaW5lXCIsICgpID0+IHtcbiAgY29uc3QgY29udGVudCA9IGAjIFQwMTogTXVsdGlcblxuIyMgSW5wdXRzXG5cbi0gXFxgc3JjL2EudHNcXGAgYW5kIFxcYHNyYy9iLnRzXFxgIFx1MjAxNCBib3RoIG5lZWRlZFxuXG4jIyBFeHBlY3RlZCBPdXRwdXRcblxuLSBcXGBzcmMvYy50c1xcYCBcdTIwMTQgb3V0cHV0XG5gO1xuICBjb25zdCBpbyA9IHBhcnNlVGFza1BsYW5JTyhjb250ZW50KTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChpby5pbnB1dEZpbGVzLCBbXCJzcmMvYS50c1wiLCBcInNyYy9iLnRzXCJdKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChpby5vdXRwdXRGaWxlcywgW1wic3JjL2MudHNcIl0pO1xufSk7XG5cbnRlc3QoXCJwYXJzZVRhc2tQbGFuSU8gc3RyaXBzIGlubGluZSBkZXNjcmlwdGlvbnMgZnJvbSBiYWNrdGljay13cmFwcGVkIGZpbGUgcmVmZXJlbmNlc1wiLCAoKSA9PiB7XG4gIGNvbnN0IGNvbnRlbnQgPSBgIyBUMDE6IERlc2NyaWJlZCBQYXRoc1xuXG4jIyBJbnB1dHNcblxuLSBcXGBzcmMvY29uZmlnLnRzIFx1MjAxNCBleGlzdGluZyBjb25maWd1cmF0aW9uXFxgXG4tIFxcYHNyYy9mbGFncy50cyAtIGZlYXR1cmUgZmxhZ3NcXGBcblxuIyMgRXhwZWN0ZWQgT3V0cHV0XG5cbi0gXFxgZGVmaW5pdGlvbnMvYWMtYXVkaXQubWQgXHUyMDE0IGN1cnJlbnQgc3RhdGUgb2YgQUMgQ1JNXFxgXG4tIFxcYGRvY3MvcnVuYm9vay5tZCAtIHVwZGF0ZSBkZXBsb3ltZW50IG5vdGVzXFxgXG5gO1xuXG4gIGNvbnN0IGlvID0gcGFyc2VUYXNrUGxhbklPKGNvbnRlbnQpO1xuICBhc3NlcnQuZGVlcEVxdWFsKGlvLmlucHV0RmlsZXMsIFtcInNyYy9jb25maWcudHNcIiwgXCJzcmMvZmxhZ3MudHNcIl0pO1xuICBhc3NlcnQuZGVlcEVxdWFsKGlvLm91dHB1dEZpbGVzLCBbXCJkZWZpbml0aW9ucy9hYy1hdWRpdC5tZFwiLCBcImRvY3MvcnVuYm9vay5tZFwiXSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGRlcml2ZVRhc2tHcmFwaCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcImRlcml2ZVRhc2tHcmFwaDogbGluZWFyIGNoYWluIFQwMVx1MjE5MlQwMlx1MjE5MlQwM1wiLCAoKSA9PiB7XG4gIGNvbnN0IHRhc2tzOiBUYXNrSU9bXSA9IFtcbiAgICB7IGlkOiBcIlQwMVwiLCB0aXRsZTogXCJGaXJzdFwiLCBpbnB1dEZpbGVzOiBbXSwgb3V0cHV0RmlsZXM6IFtcInNyYy9hLnRzXCJdLCBkb25lOiBmYWxzZSB9LFxuICAgIHsgaWQ6IFwiVDAyXCIsIHRpdGxlOiBcIlNlY29uZFwiLCBpbnB1dEZpbGVzOiBbXCJzcmMvYS50c1wiXSwgb3V0cHV0RmlsZXM6IFtcInNyYy9iLnRzXCJdLCBkb25lOiBmYWxzZSB9LFxuICAgIHsgaWQ6IFwiVDAzXCIsIHRpdGxlOiBcIlRoaXJkXCIsIGlucHV0RmlsZXM6IFtcInNyYy9iLnRzXCJdLCBvdXRwdXRGaWxlczogW1wic3JjL2MudHNcIl0sIGRvbmU6IGZhbHNlIH0sXG4gIF07XG5cbiAgY29uc3QgZ3JhcGggPSBkZXJpdmVUYXNrR3JhcGgodGFza3MpO1xuICBhc3NlcnQuZGVlcEVxdWFsKGdyYXBoWzBdLmRlcGVuZHNPbiwgW10pO1xuICBhc3NlcnQuZGVlcEVxdWFsKGdyYXBoWzFdLmRlcGVuZHNPbiwgW1wiVDAxXCJdKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChncmFwaFsyXS5kZXBlbmRzT24sIFtcIlQwMlwiXSk7XG59KTtcblxudGVzdChcImRlcml2ZVRhc2tHcmFwaDogZGlhbW9uZCBkZXBlbmRlbmN5XCIsICgpID0+IHtcbiAgY29uc3QgdGFza3M6IFRhc2tJT1tdID0gW1xuICAgIHsgaWQ6IFwiVDAxXCIsIHRpdGxlOiBcIkJhc2VcIiwgaW5wdXRGaWxlczogW10sIG91dHB1dEZpbGVzOiBbXCJzcmMvYmFzZS50c1wiXSwgZG9uZTogZmFsc2UgfSxcbiAgICB7IGlkOiBcIlQwMlwiLCB0aXRsZTogXCJMZWZ0XCIsIGlucHV0RmlsZXM6IFtcInNyYy9iYXNlLnRzXCJdLCBvdXRwdXRGaWxlczogW1wic3JjL2xlZnQudHNcIl0sIGRvbmU6IGZhbHNlIH0sXG4gICAgeyBpZDogXCJUMDNcIiwgdGl0bGU6IFwiUmlnaHRcIiwgaW5wdXRGaWxlczogW1wic3JjL2Jhc2UudHNcIl0sIG91dHB1dEZpbGVzOiBbXCJzcmMvcmlnaHQudHNcIl0sIGRvbmU6IGZhbHNlIH0sXG4gICAgeyBpZDogXCJUMDRcIiwgdGl0bGU6IFwiTWVyZ2VcIiwgaW5wdXRGaWxlczogW1wic3JjL2xlZnQudHNcIiwgXCJzcmMvcmlnaHQudHNcIl0sIG91dHB1dEZpbGVzOiBbXCJzcmMvZmluYWwudHNcIl0sIGRvbmU6IGZhbHNlIH0sXG4gIF07XG5cbiAgY29uc3QgZ3JhcGggPSBkZXJpdmVUYXNrR3JhcGgodGFza3MpO1xuICBhc3NlcnQuZGVlcEVxdWFsKGdyYXBoWzBdLmRlcGVuZHNPbiwgW10pO1xuICBhc3NlcnQuZGVlcEVxdWFsKGdyYXBoWzFdLmRlcGVuZHNPbiwgW1wiVDAxXCJdKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChncmFwaFsyXS5kZXBlbmRzT24sIFtcIlQwMVwiXSk7XG4gIGFzc2VydC5kZWVwRXF1YWwoZ3JhcGhbM10uZGVwZW5kc09uLCBbXCJUMDJcIiwgXCJUMDNcIl0pO1xufSk7XG5cbnRlc3QoXCJkZXJpdmVUYXNrR3JhcGg6IGZ1bGx5IGluZGVwZW5kZW50IHRhc2tzXCIsICgpID0+IHtcbiAgY29uc3QgdGFza3M6IFRhc2tJT1tdID0gW1xuICAgIHsgaWQ6IFwiVDAxXCIsIHRpdGxlOiBcIkFcIiwgaW5wdXRGaWxlczogW10sIG91dHB1dEZpbGVzOiBbXCJzcmMvYS50c1wiXSwgZG9uZTogZmFsc2UgfSxcbiAgICB7IGlkOiBcIlQwMlwiLCB0aXRsZTogXCJCXCIsIGlucHV0RmlsZXM6IFtdLCBvdXRwdXRGaWxlczogW1wic3JjL2IudHNcIl0sIGRvbmU6IGZhbHNlIH0sXG4gICAgeyBpZDogXCJUMDNcIiwgdGl0bGU6IFwiQ1wiLCBpbnB1dEZpbGVzOiBbXSwgb3V0cHV0RmlsZXM6IFtcInNyYy9jLnRzXCJdLCBkb25lOiBmYWxzZSB9LFxuICBdO1xuXG4gIGNvbnN0IGdyYXBoID0gZGVyaXZlVGFza0dyYXBoKHRhc2tzKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChncmFwaFswXS5kZXBlbmRzT24sIFtdKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChncmFwaFsxXS5kZXBlbmRzT24sIFtdKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChncmFwaFsyXS5kZXBlbmRzT24sIFtdKTtcbn0pO1xuXG50ZXN0KFwiZGVyaXZlVGFza0dyYXBoOiBzZWxmLXJlZmVyZW5jaW5nIG91dHB1dFx1MjE5MmlucHV0IGlzIGV4Y2x1ZGVkXCIsICgpID0+IHtcbiAgY29uc3QgdGFza3M6IFRhc2tJT1tdID0gW1xuICAgIHsgaWQ6IFwiVDAxXCIsIHRpdGxlOiBcIlNlbGZcIiwgaW5wdXRGaWxlczogW1wic3JjL2EudHNcIl0sIG91dHB1dEZpbGVzOiBbXCJzcmMvYS50c1wiXSwgZG9uZTogZmFsc2UgfSxcbiAgXTtcblxuICBjb25zdCBncmFwaCA9IGRlcml2ZVRhc2tHcmFwaCh0YXNrcyk7XG4gIGFzc2VydC5kZWVwRXF1YWwoZ3JhcGhbMF0uZGVwZW5kc09uLCBbXSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGdldFJlYWR5VGFza3MgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJnZXRSZWFkeVRhc2tzOiBwYXJ0aWFsbHkgY29tcGxldGVkIGdyYXBoXCIsICgpID0+IHtcbiAgY29uc3QgdGFza3M6IFRhc2tJT1tdID0gW1xuICAgIHsgaWQ6IFwiVDAxXCIsIHRpdGxlOiBcIkJhc2VcIiwgaW5wdXRGaWxlczogW10sIG91dHB1dEZpbGVzOiBbXCJzcmMvYS50c1wiXSwgZG9uZTogdHJ1ZSB9LFxuICAgIHsgaWQ6IFwiVDAyXCIsIHRpdGxlOiBcIkRlcFwiLCBpbnB1dEZpbGVzOiBbXCJzcmMvYS50c1wiXSwgb3V0cHV0RmlsZXM6IFtcInNyYy9iLnRzXCJdLCBkb25lOiBmYWxzZSB9LFxuICAgIHsgaWQ6IFwiVDAzXCIsIHRpdGxlOiBcIkJsb2NrZWRcIiwgaW5wdXRGaWxlczogW1wic3JjL2IudHNcIl0sIG91dHB1dEZpbGVzOiBbXCJzcmMvYy50c1wiXSwgZG9uZTogZmFsc2UgfSxcbiAgXTtcbiAgY29uc3QgZ3JhcGggPSBkZXJpdmVUYXNrR3JhcGgodGFza3MpO1xuICBjb25zdCByZWFkeSA9IGdldFJlYWR5VGFza3MoZ3JhcGgsIG5ldyBTZXQoW1wiVDAxXCJdKSwgbmV3IFNldCgpKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChyZWFkeSwgW1wiVDAyXCJdKTtcbn0pO1xuXG50ZXN0KFwiZ2V0UmVhZHlUYXNrczogbm90aGluZyBjb21wbGV0ZSBcdTIxOTIgb25seSByb290IHRhc2tzIHJlYWR5XCIsICgpID0+IHtcbiAgY29uc3QgdGFza3M6IFRhc2tJT1tdID0gW1xuICAgIHsgaWQ6IFwiVDAxXCIsIHRpdGxlOiBcIlJvb3RcIiwgaW5wdXRGaWxlczogW10sIG91dHB1dEZpbGVzOiBbXCJzcmMvYS50c1wiXSwgZG9uZTogZmFsc2UgfSxcbiAgICB7IGlkOiBcIlQwMlwiLCB0aXRsZTogXCJEZXBcIiwgaW5wdXRGaWxlczogW1wic3JjL2EudHNcIl0sIG91dHB1dEZpbGVzOiBbXCJzcmMvYi50c1wiXSwgZG9uZTogZmFsc2UgfSxcbiAgXTtcbiAgY29uc3QgZ3JhcGggPSBkZXJpdmVUYXNrR3JhcGgodGFza3MpO1xuICBjb25zdCByZWFkeSA9IGdldFJlYWR5VGFza3MoZ3JhcGgsIG5ldyBTZXQoKSwgbmV3IFNldCgpKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChyZWFkeSwgW1wiVDAxXCJdKTtcbn0pO1xuXG50ZXN0KFwiZ2V0UmVhZHlUYXNrczogYWxsIGNvbXBsZXRlIFx1MjE5MiBlbXB0eVwiLCAoKSA9PiB7XG4gIGNvbnN0IHRhc2tzOiBUYXNrSU9bXSA9IFtcbiAgICB7IGlkOiBcIlQwMVwiLCB0aXRsZTogXCJEb25lXCIsIGlucHV0RmlsZXM6IFtdLCBvdXRwdXRGaWxlczogW1wic3JjL2EudHNcIl0sIGRvbmU6IHRydWUgfSxcbiAgXTtcbiAgY29uc3QgZ3JhcGggPSBkZXJpdmVUYXNrR3JhcGgodGFza3MpO1xuICBjb25zdCByZWFkeSA9IGdldFJlYWR5VGFza3MoZ3JhcGgsIG5ldyBTZXQoW1wiVDAxXCJdKSwgbmV3IFNldCgpKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChyZWFkeSwgW10pO1xufSk7XG5cbnRlc3QoXCJnZXRSZWFkeVRhc2tzOiBpbi1mbGlnaHQgdGFza3MgZXhjbHVkZWRcIiwgKCkgPT4ge1xuICBjb25zdCB0YXNrczogVGFza0lPW10gPSBbXG4gICAgeyBpZDogXCJUMDFcIiwgdGl0bGU6IFwiQVwiLCBpbnB1dEZpbGVzOiBbXSwgb3V0cHV0RmlsZXM6IFtcInNyYy9hLnRzXCJdLCBkb25lOiBmYWxzZSB9LFxuICAgIHsgaWQ6IFwiVDAyXCIsIHRpdGxlOiBcIkJcIiwgaW5wdXRGaWxlczogW10sIG91dHB1dEZpbGVzOiBbXCJzcmMvYi50c1wiXSwgZG9uZTogZmFsc2UgfSxcbiAgXTtcbiAgY29uc3QgZ3JhcGggPSBkZXJpdmVUYXNrR3JhcGgodGFza3MpO1xuICBjb25zdCByZWFkeSA9IGdldFJlYWR5VGFza3MoZ3JhcGgsIG5ldyBTZXQoKSwgbmV3IFNldChbXCJUMDFcIl0pKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChyZWFkeSwgW1wiVDAyXCJdKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgY2hvb3NlTm9uQ29uZmxpY3RpbmdTdWJzZXQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJjaG9vc2VOb25Db25mbGljdGluZ1N1YnNldDogb3V0cHV0IGNvbmZsaWN0c1wiLCAoKSA9PiB7XG4gIGNvbnN0IHRhc2tzOiBUYXNrSU9bXSA9IFtcbiAgICB7IGlkOiBcIlQwMVwiLCB0aXRsZTogXCJBXCIsIGlucHV0RmlsZXM6IFtdLCBvdXRwdXRGaWxlczogW1wic3JjL3NoYXJlZC50c1wiXSwgZG9uZTogZmFsc2UgfSxcbiAgICB7IGlkOiBcIlQwMlwiLCB0aXRsZTogXCJCXCIsIGlucHV0RmlsZXM6IFtdLCBvdXRwdXRGaWxlczogW1wic3JjL3NoYXJlZC50c1wiXSwgZG9uZTogZmFsc2UgfSxcbiAgICB7IGlkOiBcIlQwM1wiLCB0aXRsZTogXCJDXCIsIGlucHV0RmlsZXM6IFtdLCBvdXRwdXRGaWxlczogW1wic3JjL290aGVyLnRzXCJdLCBkb25lOiBmYWxzZSB9LFxuICBdO1xuICBjb25zdCBncmFwaCA9IGRlcml2ZVRhc2tHcmFwaCh0YXNrcyk7XG4gIGNvbnN0IHNlbGVjdGVkID0gY2hvb3NlTm9uQ29uZmxpY3RpbmdTdWJzZXQoW1wiVDAxXCIsIFwiVDAyXCIsIFwiVDAzXCJdLCBncmFwaCwgMywgbmV3IFNldCgpKTtcbiAgLy8gVDAxIGNsYWltcyBzaGFyZWQudHMsIFQwMiBjb25mbGljdHMsIFQwMyBpcyBmaW5lXG4gIGFzc2VydC5kZWVwRXF1YWwoc2VsZWN0ZWQsIFtcIlQwMVwiLCBcIlQwM1wiXSk7XG59KTtcblxudGVzdChcImNob29zZU5vbkNvbmZsaWN0aW5nU3Vic2V0OiByZXNwZWN0cyBtYXhQYXJhbGxlbFwiLCAoKSA9PiB7XG4gIGNvbnN0IHRhc2tzOiBUYXNrSU9bXSA9IFtcbiAgICB7IGlkOiBcIlQwMVwiLCB0aXRsZTogXCJBXCIsIGlucHV0RmlsZXM6IFtdLCBvdXRwdXRGaWxlczogW1wic3JjL2EudHNcIl0sIGRvbmU6IGZhbHNlIH0sXG4gICAgeyBpZDogXCJUMDJcIiwgdGl0bGU6IFwiQlwiLCBpbnB1dEZpbGVzOiBbXSwgb3V0cHV0RmlsZXM6IFtcInNyYy9iLnRzXCJdLCBkb25lOiBmYWxzZSB9LFxuICAgIHsgaWQ6IFwiVDAzXCIsIHRpdGxlOiBcIkNcIiwgaW5wdXRGaWxlczogW10sIG91dHB1dEZpbGVzOiBbXCJzcmMvYy50c1wiXSwgZG9uZTogZmFsc2UgfSxcbiAgXTtcbiAgY29uc3QgZ3JhcGggPSBkZXJpdmVUYXNrR3JhcGgodGFza3MpO1xuICBjb25zdCBzZWxlY3RlZCA9IGNob29zZU5vbkNvbmZsaWN0aW5nU3Vic2V0KFtcIlQwMVwiLCBcIlQwMlwiLCBcIlQwM1wiXSwgZ3JhcGgsIDIsIG5ldyBTZXQoKSk7XG4gIGFzc2VydC5kZWVwRXF1YWwoc2VsZWN0ZWQsIFtcIlQwMVwiLCBcIlQwMlwiXSk7XG59KTtcblxudGVzdChcImNob29zZU5vbkNvbmZsaWN0aW5nU3Vic2V0OiByZXNwZWN0cyBpbkZsaWdodE91dHB1dHNcIiwgKCkgPT4ge1xuICBjb25zdCB0YXNrczogVGFza0lPW10gPSBbXG4gICAgeyBpZDogXCJUMDFcIiwgdGl0bGU6IFwiQVwiLCBpbnB1dEZpbGVzOiBbXSwgb3V0cHV0RmlsZXM6IFtcInNyYy9hLnRzXCJdLCBkb25lOiBmYWxzZSB9LFxuICAgIHsgaWQ6IFwiVDAyXCIsIHRpdGxlOiBcIkJcIiwgaW5wdXRGaWxlczogW10sIG91dHB1dEZpbGVzOiBbXCJzcmMvYi50c1wiXSwgZG9uZTogZmFsc2UgfSxcbiAgXTtcbiAgY29uc3QgZ3JhcGggPSBkZXJpdmVUYXNrR3JhcGgodGFza3MpO1xuICBjb25zdCBzZWxlY3RlZCA9IGNob29zZU5vbkNvbmZsaWN0aW5nU3Vic2V0KFtcIlQwMVwiLCBcIlQwMlwiXSwgZ3JhcGgsIDQsIG5ldyBTZXQoW1wic3JjL2EudHNcIl0pKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChzZWxlY3RlZCwgW1wiVDAyXCJdKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgaXNHcmFwaEFtYmlndW91cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcImlzR3JhcGhBbWJpZ3VvdXM6IHRhc2sgd2l0aCBubyBJTyBcdTIxOTIgYW1iaWd1b3VzXCIsICgpID0+IHtcbiAgY29uc3QgZ3JhcGg6IERlcml2ZWRUYXNrTm9kZVtdID0gW1xuICAgIHsgaWQ6IFwiVDAxXCIsIHRpdGxlOiBcIkFcIiwgaW5wdXRGaWxlczogW10sIG91dHB1dEZpbGVzOiBbXSwgZG9uZTogZmFsc2UsIGRlcGVuZHNPbjogW10gfSxcbiAgICB7IGlkOiBcIlQwMlwiLCB0aXRsZTogXCJCXCIsIGlucHV0RmlsZXM6IFtcInNyYy9hLnRzXCJdLCBvdXRwdXRGaWxlczogW1wic3JjL2IudHNcIl0sIGRvbmU6IGZhbHNlLCBkZXBlbmRzT246IFtdIH0sXG4gIF07XG4gIGFzc2VydC5lcXVhbChpc0dyYXBoQW1iaWd1b3VzKGdyYXBoKSwgdHJ1ZSk7XG59KTtcblxudGVzdChcImlzR3JhcGhBbWJpZ3VvdXM6IGFsbCB0YXNrcyBoYXZlIElPIFx1MjE5MiBub3QgYW1iaWd1b3VzXCIsICgpID0+IHtcbiAgY29uc3QgZ3JhcGg6IERlcml2ZWRUYXNrTm9kZVtdID0gW1xuICAgIHsgaWQ6IFwiVDAxXCIsIHRpdGxlOiBcIkFcIiwgaW5wdXRGaWxlczogW10sIG91dHB1dEZpbGVzOiBbXCJzcmMvYS50c1wiXSwgZG9uZTogZmFsc2UsIGRlcGVuZHNPbjogW10gfSxcbiAgICB7IGlkOiBcIlQwMlwiLCB0aXRsZTogXCJCXCIsIGlucHV0RmlsZXM6IFtcInNyYy9hLnRzXCJdLCBvdXRwdXRGaWxlczogW1wic3JjL2IudHNcIl0sIGRvbmU6IGZhbHNlLCBkZXBlbmRzT246IFtcIlQwMVwiXSB9LFxuICBdO1xuICBhc3NlcnQuZXF1YWwoaXNHcmFwaEFtYmlndW91cyhncmFwaCksIGZhbHNlKTtcbn0pO1xuXG50ZXN0KFwiaXNHcmFwaEFtYmlndW91czogZG9uZSB0YXNrcyB3aXRoIG5vIElPIGFyZSBpZ25vcmVkXCIsICgpID0+IHtcbiAgY29uc3QgZ3JhcGg6IERlcml2ZWRUYXNrTm9kZVtdID0gW1xuICAgIHsgaWQ6IFwiVDAxXCIsIHRpdGxlOiBcIkFcIiwgaW5wdXRGaWxlczogW10sIG91dHB1dEZpbGVzOiBbXSwgZG9uZTogdHJ1ZSwgZGVwZW5kc09uOiBbXSB9LFxuICAgIHsgaWQ6IFwiVDAyXCIsIHRpdGxlOiBcIkJcIiwgaW5wdXRGaWxlczogW10sIG91dHB1dEZpbGVzOiBbXCJzcmMvYi50c1wiXSwgZG9uZTogZmFsc2UsIGRlcGVuZHNPbjogW10gfSxcbiAgXTtcbiAgYXNzZXJ0LmVxdWFsKGlzR3JhcGhBbWJpZ3VvdXMoZ3JhcGgpLCBmYWxzZSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGRldGVjdERlYWRsb2NrIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiZGV0ZWN0RGVhZGxvY2s6IGNpcmN1bGFyIGRlcGVuZGVuY3kgZGV0ZWN0ZWRcIiwgKCkgPT4ge1xuICAvLyBUMDEgZGVwZW5kcyBvbiBUMDIsIFQwMiBkZXBlbmRzIG9uIFQwMSBcdTIwMTQgZGVhZGxvY2tcbiAgY29uc3QgZ3JhcGg6IERlcml2ZWRUYXNrTm9kZVtdID0gW1xuICAgIHsgaWQ6IFwiVDAxXCIsIHRpdGxlOiBcIkFcIiwgaW5wdXRGaWxlczogW1wic3JjL2IudHNcIl0sIG91dHB1dEZpbGVzOiBbXCJzcmMvYS50c1wiXSwgZG9uZTogZmFsc2UsIGRlcGVuZHNPbjogW1wiVDAyXCJdIH0sXG4gICAgeyBpZDogXCJUMDJcIiwgdGl0bGU6IFwiQlwiLCBpbnB1dEZpbGVzOiBbXCJzcmMvYS50c1wiXSwgb3V0cHV0RmlsZXM6IFtcInNyYy9iLnRzXCJdLCBkb25lOiBmYWxzZSwgZGVwZW5kc09uOiBbXCJUMDFcIl0gfSxcbiAgXTtcbiAgYXNzZXJ0LmVxdWFsKGRldGVjdERlYWRsb2NrKGdyYXBoLCBuZXcgU2V0KCksIG5ldyBTZXQoKSksIHRydWUpO1xufSk7XG5cbnRlc3QoXCJkZXRlY3REZWFkbG9jazogbm9ybWFsIGJsb2NrZWQtd2FpdGluZy1mb3ItaW4tZmxpZ2h0IFx1MjE5MiBub3QgZGVhZGxvY2tcIiwgKCkgPT4ge1xuICBjb25zdCBncmFwaDogRGVyaXZlZFRhc2tOb2RlW10gPSBbXG4gICAgeyBpZDogXCJUMDFcIiwgdGl0bGU6IFwiQVwiLCBpbnB1dEZpbGVzOiBbXSwgb3V0cHV0RmlsZXM6IFtcInNyYy9hLnRzXCJdLCBkb25lOiBmYWxzZSwgZGVwZW5kc09uOiBbXSB9LFxuICAgIHsgaWQ6IFwiVDAyXCIsIHRpdGxlOiBcIkJcIiwgaW5wdXRGaWxlczogW1wic3JjL2EudHNcIl0sIG91dHB1dEZpbGVzOiBbXCJzcmMvYi50c1wiXSwgZG9uZTogZmFsc2UsIGRlcGVuZHNPbjogW1wiVDAxXCJdIH0sXG4gIF07XG4gIC8vIFQwMSBpcyBpbi1mbGlnaHQsIFQwMiBpcyB3YWl0aW5nIFx1MjE5MiBub3QgZGVhZGxvY2tcbiAgYXNzZXJ0LmVxdWFsKGRldGVjdERlYWRsb2NrKGdyYXBoLCBuZXcgU2V0KCksIG5ldyBTZXQoW1wiVDAxXCJdKSksIGZhbHNlKTtcbn0pO1xuXG50ZXN0KFwiZGV0ZWN0RGVhZGxvY2s6IGFsbCBjb21wbGV0ZSBcdTIxOTIgbm90IGRlYWRsb2NrXCIsICgpID0+IHtcbiAgY29uc3QgZ3JhcGg6IERlcml2ZWRUYXNrTm9kZVtdID0gW1xuICAgIHsgaWQ6IFwiVDAxXCIsIHRpdGxlOiBcIkFcIiwgaW5wdXRGaWxlczogW10sIG91dHB1dEZpbGVzOiBbXCJzcmMvYS50c1wiXSwgZG9uZTogdHJ1ZSwgZGVwZW5kc09uOiBbXSB9LFxuICBdO1xuICBhc3NlcnQuZXF1YWwoZGV0ZWN0RGVhZGxvY2soZ3JhcGgsIG5ldyBTZXQoW1wiVDAxXCJdKSwgbmV3IFNldCgpKSwgZmFsc2UpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBncmFwaE1ldHJpY3MgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJncmFwaE1ldHJpY3MgY29tcHV0ZXMgY29ycmVjdCB2YWx1ZXNcIiwgKCkgPT4ge1xuICBjb25zdCB0YXNrczogVGFza0lPW10gPSBbXG4gICAgeyBpZDogXCJUMDFcIiwgdGl0bGU6IFwiQVwiLCBpbnB1dEZpbGVzOiBbXSwgb3V0cHV0RmlsZXM6IFtcInNyYy9hLnRzXCJdLCBkb25lOiB0cnVlIH0sXG4gICAgeyBpZDogXCJUMDJcIiwgdGl0bGU6IFwiQlwiLCBpbnB1dEZpbGVzOiBbXCJzcmMvYS50c1wiXSwgb3V0cHV0RmlsZXM6IFtcInNyYy9iLnRzXCJdLCBkb25lOiBmYWxzZSB9LFxuICAgIHsgaWQ6IFwiVDAzXCIsIHRpdGxlOiBcIkNcIiwgaW5wdXRGaWxlczogW10sIG91dHB1dEZpbGVzOiBbXCJzcmMvYy50c1wiXSwgZG9uZTogZmFsc2UgfSxcbiAgXTtcbiAgY29uc3QgZ3JhcGggPSBkZXJpdmVUYXNrR3JhcGgodGFza3MpO1xuICBjb25zdCBtZXRyaWNzID0gZ3JhcGhNZXRyaWNzKGdyYXBoKTtcbiAgYXNzZXJ0LmVxdWFsKG1ldHJpY3MudGFza0NvdW50LCAzKTtcbiAgYXNzZXJ0LmVxdWFsKG1ldHJpY3MuZWRnZUNvdW50LCAxKTsgLy8gVDAyIGRlcGVuZHMgb24gVDAxXG4gIGFzc2VydC5lcXVhbChtZXRyaWNzLnJlYWR5U2V0U2l6ZSwgMik7IC8vIFQwMiAoVDAxIGRvbmUpIGFuZCBUMDMgKG5vIGRlcHMpXG4gIGFzc2VydC5lcXVhbChtZXRyaWNzLmFtYmlndW91cywgZmFsc2UpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBnZXRNaXNzaW5nQW5ub3RhdGlvblRhc2tzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiZ2V0TWlzc2luZ0Fubm90YXRpb25UYXNrczogcmV0dXJucyBlbXB0eSBhcnJheSB3aGVuIGFsbCB0YXNrcyBoYXZlIGFubm90YXRpb25zXCIsICgpID0+IHtcbiAgY29uc3QgZ3JhcGg6IERlcml2ZWRUYXNrTm9kZVtdID0gW1xuICAgIHsgaWQ6IFwiVDAxXCIsIHRpdGxlOiBcIkFcIiwgaW5wdXRGaWxlczogW1wic3JjL2EudHNcIl0sIG91dHB1dEZpbGVzOiBbXCJzcmMvYi50c1wiXSwgZG9uZTogZmFsc2UsIGRlcGVuZHNPbjogW10gfSxcbiAgICB7IGlkOiBcIlQwMlwiLCB0aXRsZTogXCJCXCIsIGlucHV0RmlsZXM6IFtdLCBvdXRwdXRGaWxlczogW1wic3JjL2MudHNcIl0sIGRvbmU6IGZhbHNlLCBkZXBlbmRzT246IFtdIH0sXG4gIF07XG4gIGFzc2VydC5kZWVwRXF1YWwoZ2V0TWlzc2luZ0Fubm90YXRpb25UYXNrcyhncmFwaCksIFtdKTtcbn0pO1xuXG50ZXN0KFwiZ2V0TWlzc2luZ0Fubm90YXRpb25UYXNrczogcmV0dXJucyB0YXNrcyB3aXRoIG1pc3NpbmcgYW5ub3RhdGlvbnNcIiwgKCkgPT4ge1xuICBjb25zdCBncmFwaDogRGVyaXZlZFRhc2tOb2RlW10gPSBbXG4gICAgeyBpZDogXCJUMDFcIiwgdGl0bGU6IFwiQVwiLCBpbnB1dEZpbGVzOiBbXSwgb3V0cHV0RmlsZXM6IFtdLCBkb25lOiBmYWxzZSwgZGVwZW5kc09uOiBbXSB9LFxuICAgIHsgaWQ6IFwiVDAyXCIsIHRpdGxlOiBcIkJcIiwgaW5wdXRGaWxlczogW1wic3JjL2EudHNcIl0sIG91dHB1dEZpbGVzOiBbXCJzcmMvYi50c1wiXSwgZG9uZTogZmFsc2UsIGRlcGVuZHNPbjogW10gfSxcbiAgICB7IGlkOiBcIlQwM1wiLCB0aXRsZTogXCJDXCIsIGlucHV0RmlsZXM6IFtdLCBvdXRwdXRGaWxlczogW10sIGRvbmU6IGZhbHNlLCBkZXBlbmRzT246IFtdIH0sXG4gIF07XG4gIGFzc2VydC5kZWVwRXF1YWwoZ2V0TWlzc2luZ0Fubm90YXRpb25UYXNrcyhncmFwaCksIFtcbiAgICB7IGlkOiBcIlQwMVwiLCB0aXRsZTogXCJBXCIgfSxcbiAgICB7IGlkOiBcIlQwM1wiLCB0aXRsZTogXCJDXCIgfSxcbiAgXSk7XG59KTtcblxudGVzdChcImdldE1pc3NpbmdBbm5vdGF0aW9uVGFza3M6IHNraXBzIGRvbmUgdGFza3NcIiwgKCkgPT4ge1xuICBjb25zdCBncmFwaDogRGVyaXZlZFRhc2tOb2RlW10gPSBbXG4gICAgeyBpZDogXCJUMDFcIiwgdGl0bGU6IFwiQVwiLCBpbnB1dEZpbGVzOiBbXSwgb3V0cHV0RmlsZXM6IFtdLCBkb25lOiB0cnVlLCBkZXBlbmRzT246IFtdIH0sXG4gICAgeyBpZDogXCJUMDJcIiwgdGl0bGU6IFwiQlwiLCBpbnB1dEZpbGVzOiBbXSwgb3V0cHV0RmlsZXM6IFtdLCBkb25lOiBmYWxzZSwgZGVwZW5kc09uOiBbXSB9LFxuICBdO1xuICBhc3NlcnQuZGVlcEVxdWFsKGdldE1pc3NpbmdBbm5vdGF0aW9uVGFza3MoZ3JhcGgpLCBbXG4gICAgeyBpZDogXCJUMDJcIiwgdGl0bGU6IFwiQlwiIH0sXG4gIF0pO1xufSk7XG5cbnRlc3QoXCJnZXRNaXNzaW5nQW5ub3RhdGlvblRhc2tzOiByZXR1cm5zIG9ubHkgdGFza3MgbWlzc2luZyBCT1RIIGlucHV0RmlsZXMgYW5kIG91dHB1dEZpbGVzXCIsICgpID0+IHtcbiAgY29uc3QgZ3JhcGg6IERlcml2ZWRUYXNrTm9kZVtdID0gW1xuICAgIHsgaWQ6IFwiVDAxXCIsIHRpdGxlOiBcIklucHV0T25seVwiLCBpbnB1dEZpbGVzOiBbXCJzcmMvYS50c1wiXSwgb3V0cHV0RmlsZXM6IFtdLCBkb25lOiBmYWxzZSwgZGVwZW5kc09uOiBbXSB9LFxuICAgIHsgaWQ6IFwiVDAyXCIsIHRpdGxlOiBcIk91dHB1dE9ubHlcIiwgaW5wdXRGaWxlczogW10sIG91dHB1dEZpbGVzOiBbXCJzcmMvYi50c1wiXSwgZG9uZTogZmFsc2UsIGRlcGVuZHNPbjogW10gfSxcbiAgICB7IGlkOiBcIlQwM1wiLCB0aXRsZTogXCJOZWl0aGVyXCIsIGlucHV0RmlsZXM6IFtdLCBvdXRwdXRGaWxlczogW10sIGRvbmU6IGZhbHNlLCBkZXBlbmRzT246IFtdIH0sXG4gICAgeyBpZDogXCJUMDRcIiwgdGl0bGU6IFwiQm90aFwiLCBpbnB1dEZpbGVzOiBbXCJzcmMvYy50c1wiXSwgb3V0cHV0RmlsZXM6IFtcInNyYy9kLnRzXCJdLCBkb25lOiBmYWxzZSwgZGVwZW5kc09uOiBbXSB9LFxuICBdO1xuICBhc3NlcnQuZGVlcEVxdWFsKGdldE1pc3NpbmdBbm5vdGF0aW9uVGFza3MoZ3JhcGgpLCBbXG4gICAgeyBpZDogXCJUMDNcIiwgdGl0bGU6IFwiTmVpdGhlclwiIH0sXG4gIF0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBQ25CO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFDUCxTQUFTLHVCQUF1QjtBQUtoQyxLQUFLLHdGQUF3RixNQUFNO0FBQ2pHLFFBQU0sVUFBVTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQXNDaEIsUUFBTSxLQUFLLGdCQUFnQixPQUFPO0FBQ2xDLFNBQU8sVUFBVSxHQUFHLFlBQVksQ0FBQyxnQkFBZ0IsaUJBQWlCLENBQUM7QUFDbkUsU0FBTyxVQUFVLEdBQUcsYUFBYSxDQUFDLGlCQUFpQixvQkFBb0IsQ0FBQztBQUMxRSxDQUFDO0FBRUQsS0FBSyw2REFBNkQsTUFBTTtBQUN0RSxRQUFNLFVBQVU7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQ2hCLFFBQU0sS0FBSyxnQkFBZ0IsT0FBTztBQUNsQyxTQUFPLFVBQVUsR0FBRyxZQUFZLENBQUMsQ0FBQztBQUNsQyxTQUFP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
