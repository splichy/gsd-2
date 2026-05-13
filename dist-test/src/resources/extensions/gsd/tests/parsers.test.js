import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseRoadmap, parsePlan } from "../parsers-legacy.js";
import { parseTaskPlanFile, parseSummary, parseContinue, parseRequirementCounts, parseSecretsManifest, formatSecretsManifest } from "../files.js";
describe("parsers", () => {
  test("parseRoadmap: full roadmap", () => {
    const content = `# M001: GSD Extension \u2014 Hierarchical Planning

**Vision:** Build a structured planning system for coding agents.

**Success Criteria:**
- All parsers have test coverage
- Round-trip formatting preserves data
- State derivation works correctly

---

## Slices

- [x] **S01: Types + File I/O** \`risk:low\` \`depends:[]\`
  > After this: All types defined and parsers work.

- [ ] **S02: State Derivation** \`risk:medium\` \`depends:[S01]\`
  > After this: Dashboard shows real-time state.

- [ ] **S03: Auto Mode** \`risk:high\` \`depends:[S01, S02]\`
  > After this: Agent can execute tasks automatically.

---

## Boundary Map

### S01 \u2192 S02
\`\`\`
Produces:
  types.ts \u2014 all type definitions
  files.ts \u2014 parser and formatter functions

Consumes from S02:
  nothing
\`\`\`

### S02 \u2192 S03
\`\`\`
Produces:
  state.ts \u2014 deriveState function

Consumes from S03:
  auto-mode entry points
\`\`\`
`;
    const r = parseRoadmap(content);
    assert.deepStrictEqual(r.title, "M001: GSD Extension \u2014 Hierarchical Planning", "roadmap title");
    assert.deepStrictEqual(r.vision, "Build a structured planning system for coding agents.", "roadmap vision");
    assert.deepStrictEqual(r.successCriteria.length, 3, "success criteria count");
    assert.deepStrictEqual(r.successCriteria[0], "All parsers have test coverage", "first success criterion");
    assert.deepStrictEqual(r.successCriteria[2], "State derivation works correctly", "third success criterion");
    assert.deepStrictEqual(r.slices.length, 3, "slice count");
    assert.deepStrictEqual(r.slices[0].id, "S01", "S01 id");
    assert.deepStrictEqual(r.slices[0].title, "Types + File I/O", "S01 title");
    assert.deepStrictEqual(r.slices[0].risk, "low", "S01 risk");
    assert.deepStrictEqual(r.slices[0].depends, [], "S01 depends");
    assert.deepStrictEqual(r.slices[0].done, true, "S01 done");
    assert.deepStrictEqual(r.slices[0].demo, "All types defined and parsers work.", "S01 demo");
    assert.deepStrictEqual(r.slices[1].id, "S02", "S02 id");
    assert.deepStrictEqual(r.slices[1].title, "State Derivation", "S02 title");
    assert.deepStrictEqual(r.slices[1].risk, "medium", "S02 risk");
    assert.deepStrictEqual(r.slices[1].depends, ["S01"], "S02 depends");
    assert.deepStrictEqual(r.slices[1].done, false, "S02 done");
    assert.deepStrictEqual(r.slices[2].id, "S03", "S03 id");
    assert.deepStrictEqual(r.slices[2].risk, "high", "S03 risk");
    assert.deepStrictEqual(r.slices[2].depends, ["S01", "S02"], "S03 depends");
    assert.deepStrictEqual(r.slices[2].done, false, "S03 done");
    assert.deepStrictEqual(r.boundaryMap.length, 2, "boundary map entry count");
    assert.deepStrictEqual(r.boundaryMap[0].fromSlice, "S01", "bm[0] from");
    assert.deepStrictEqual(r.boundaryMap[0].toSlice, "S02", "bm[0] to");
    assert.ok(r.boundaryMap[0].produces.includes("types.ts"), "bm[0] produces mentions types.ts");
    assert.deepStrictEqual(r.boundaryMap[1].fromSlice, "S02", "bm[1] from");
    assert.deepStrictEqual(r.boundaryMap[1].toSlice, "S03", "bm[1] to");
  });
  test("parseRoadmap: empty slices section", () => {
    const content = `# M002: Empty Milestone

**Vision:** Nothing yet.

## Slices

## Boundary Map
`;
    const r = parseRoadmap(content);
    assert.deepStrictEqual(r.title, "M002: Empty Milestone", "title with empty slices");
    assert.deepStrictEqual(r.slices.length, 0, "no slices parsed");
    assert.deepStrictEqual(r.boundaryMap.length, 0, "no boundary map entries");
  });
  test("parseRoadmap: malformed checkbox lines", () => {
    const content = `# M003: Malformed

**Vision:** Test malformed lines.

## Slices

- [ ] S01: Missing bold markers \`risk:low\` \`depends:[]\`
- [x] **S02: Valid Slice** \`risk:medium\` \`depends:[]\`
  > After this: Works.
- [ ] Not a checkbox at all
  Some random text
- [x] **S03: Another Valid** \`risk:high\` \`depends:[S02]\`
  > After this: Also works.
`;
    const r = parseRoadmap(content);
    assert.deepStrictEqual(r.slices.length, 2, "only valid slices parsed from malformed input");
    assert.deepStrictEqual(r.slices[0].id, "S02", "first valid slice is S02");
    assert.deepStrictEqual(r.slices[0].done, true, "S02 done");
    assert.deepStrictEqual(r.slices[1].id, "S03", "second valid slice is S03");
    assert.deepStrictEqual(r.slices[1].depends, ["S02"], "S03 depends on S02");
  });
  test("parseRoadmap: lowercase vs uppercase X for done", () => {
    const content = `# M004: Case Test

**Vision:** Test X case sensitivity.

## Slices

- [x] **S01: Lowercase x** \`risk:low\` \`depends:[]\`
  > After this: done.

- [X] **S02: Uppercase X** \`risk:low\` \`depends:[]\`
  > After this: also done.

- [ ] **S03: Not Done** \`risk:low\` \`depends:[]\`
  > After this: not yet.
`;
    const r = parseRoadmap(content);
    assert.deepStrictEqual(r.slices.length, 3, "all three slices parsed");
    assert.deepStrictEqual(r.slices[0].done, true, "lowercase x is done");
    assert.deepStrictEqual(r.slices[1].done, true, "uppercase X is done");
    assert.deepStrictEqual(r.slices[2].done, false, "space is not done");
  });
  test("parseRoadmap: missing boundary map", () => {
    const content = `# M005: No Boundary Map

**Vision:** A roadmap without a boundary map section.

**Success Criteria:**
- One criterion

---

## Slices

- [ ] **S01: Only Slice** \`risk:low\` \`depends:[]\`
  > After this: Done.
`;
    const r = parseRoadmap(content);
    assert.deepStrictEqual(r.title, "M005: No Boundary Map", "title");
    assert.deepStrictEqual(r.slices.length, 1, "one slice");
    assert.deepStrictEqual(r.boundaryMap.length, 0, "empty boundary map when section missing");
    assert.deepStrictEqual(r.successCriteria.length, 1, "one success criterion");
  });
  test("parseRoadmap: no sections at all", () => {
    const content = `# M006: Bare Minimum

Just a title and nothing else.
`;
    const r = parseRoadmap(content);
    assert.deepStrictEqual(r.title, "M006: Bare Minimum", "title from bare roadmap");
    assert.deepStrictEqual(r.vision, "", "empty vision");
    assert.deepStrictEqual(r.successCriteria.length, 0, "no success criteria");
    assert.deepStrictEqual(r.slices.length, 0, "no slices");
    assert.deepStrictEqual(r.boundaryMap.length, 0, "no boundary map");
  });
  test("parseRoadmap: slice with no demo blockquote", () => {
    const content = `# M007: No Demo

**Vision:** Testing slices without demo lines.

## Slices

- [ ] **S01: No Demo Here** \`risk:medium\` \`depends:[]\`
- [ ] **S02: Also No Demo** \`risk:low\` \`depends:[S01]\`
`;
    const r = parseRoadmap(content);
    assert.deepStrictEqual(r.slices.length, 2, "two slices without demos");
    assert.deepStrictEqual(r.slices[0].demo, "", "S01 demo empty");
    assert.deepStrictEqual(r.slices[1].demo, "", "S02 demo empty");
  });
  test("parseRoadmap: missing risk defaults to low", () => {
    const content = `# M008: Default Risk

**Vision:** Test default risk.

## Slices

- [ ] **S01: No Risk Tag** \`depends:[]\`
  > After this: done.
`;
    const r = parseRoadmap(content);
    assert.deepStrictEqual(r.slices.length, 1, "one slice");
    assert.deepStrictEqual(r.slices[0].risk, "low", "default risk is low");
  });
  test("parsePlan: full plan", () => {
    const content = `---
estimated_steps: 6
estimated_files: 3
skills_used:
  - typescript
  - testing
---

# S01: Parser Test Suite

**Goal:** All 5 parsers have test coverage with edge cases.
**Demo:** \`node --test tests/parsers.test.ts\` passes with zero failures.

## Must-Haves

- parseRoadmap tests cover happy path and edge cases
- parsePlan tests cover happy path and edge cases
- All existing tests still pass

## Tasks

- [ ] **T01: Test parseRoadmap and parsePlan** \`est:45m\`
  Create tests/parsers.test.ts with comprehensive tests for the two most complex parsers.

- [x] **T02: Test parseSummary and parseContinue** \`est:35m\`
  Extend tests/parsers.test.ts with tests for the remaining parsers.

## Files Likely Touched

- \`tests/parsers.test.ts\` \u2014 new test file
- \`types.ts\` \u2014 add observability_surfaces
- \`files.ts\` \u2014 update parseSummary
`;
    const taskPlan = parseTaskPlanFile(content);
    assert.deepStrictEqual(taskPlan.frontmatter.estimated_steps, 6, "task plan frontmatter estimated_steps");
    assert.deepStrictEqual(taskPlan.frontmatter.estimated_files, 3, "task plan frontmatter estimated_files");
    assert.deepStrictEqual(taskPlan.frontmatter.skills_used.length, 2, "task plan frontmatter skills_used count");
    assert.deepStrictEqual(taskPlan.frontmatter.skills_used[0], "typescript", "first task plan skill");
    assert.deepStrictEqual(taskPlan.frontmatter.skills_used[1], "testing", "second task plan skill");
    const p = parsePlan(content);
    assert.deepStrictEqual(p.id, "S01", "plan id");
    assert.deepStrictEqual(p.title, "Parser Test Suite", "plan title");
    assert.deepStrictEqual(p.goal, "All 5 parsers have test coverage with edge cases.", "plan goal");
    assert.deepStrictEqual(p.demo, "`node --test tests/parsers.test.ts` passes with zero failures.", "plan demo");
    assert.deepStrictEqual(p.mustHaves.length, 3, "must-have count");
    assert.deepStrictEqual(p.mustHaves[0], "parseRoadmap tests cover happy path and edge cases", "first must-have");
    assert.deepStrictEqual(p.tasks.length, 2, "task count");
    assert.deepStrictEqual(p.tasks[0].id, "T01", "T01 id");
    assert.deepStrictEqual(p.tasks[0].title, "Test parseRoadmap and parsePlan", "T01 title");
    assert.deepStrictEqual(p.tasks[0].done, false, "T01 not done");
    assert.ok(p.tasks[0].description.includes("comprehensive tests"), "T01 description content");
    assert.deepStrictEqual(p.tasks[1].id, "T02", "T02 id");
    assert.deepStrictEqual(p.tasks[1].title, "Test parseSummary and parseContinue", "T02 title");
    assert.deepStrictEqual(p.tasks[1].done, true, "T02 done");
    assert.deepStrictEqual(p.filesLikelyTouched.length, 3, "files likely touched count");
    assert.ok(p.filesLikelyTouched[0].includes("tests/parsers.test.ts"), "first file");
  });
  test("parseTaskPlanFile: defaults missing frontmatter fields", () => {
    const content = `# T01: Minimal task plan

## Description

No frontmatter here.
`;
    const taskPlan = parseTaskPlanFile(content);
    assert.deepStrictEqual(taskPlan.frontmatter.estimated_steps, void 0, "estimated_steps defaults undefined");
    assert.deepStrictEqual(taskPlan.frontmatter.estimated_files, void 0, "estimated_files defaults undefined");
    assert.deepStrictEqual(taskPlan.frontmatter.skills_used.length, 0, "skills_used defaults empty array");
  });
  test("parseTaskPlanFile: accepts scalar skills_used and numeric strings", () => {
    const content = `---
estimated_steps: "9"
estimated_files: "4"
skills_used: react-best-practices
---

# T02: Scalar skill handoff
`;
    const taskPlan = parseTaskPlanFile(content);
    assert.deepStrictEqual(taskPlan.frontmatter.estimated_steps, 9, "string estimated_steps parsed");
    assert.deepStrictEqual(taskPlan.frontmatter.estimated_files, 4, "string estimated_files parsed");
    assert.deepStrictEqual(taskPlan.frontmatter.skills_used.length, 1, "scalar skills_used normalized to array");
    assert.deepStrictEqual(taskPlan.frontmatter.skills_used[0], "react-best-practices", "scalar skill preserved");
  });
  test("parseTaskPlanFile: filters blank skills_used items", () => {
    const content = `---
skills_used:
  - react
  -
  - testing
---

# T03: Blank skills filtered
`;
    const taskPlan = parseTaskPlanFile(content);
    assert.deepStrictEqual(taskPlan.frontmatter.skills_used.length, 2, "blank skill entries removed");
    assert.deepStrictEqual(taskPlan.frontmatter.skills_used[0], "react", "first remaining skill");
    assert.deepStrictEqual(taskPlan.frontmatter.skills_used[1], "testing", "second remaining skill");
  });
  test("parseTaskPlanFile: invalid numeric frontmatter ignored", () => {
    const content = `---
estimated_steps: many
estimated_files: unknown
---

# T04: Invalid estimates
`;
    const taskPlan = parseTaskPlanFile(content);
    assert.deepStrictEqual(taskPlan.frontmatter.estimated_steps, void 0, "invalid estimated_steps ignored");
    assert.deepStrictEqual(taskPlan.frontmatter.estimated_files, void 0, "invalid estimated_files ignored");
  });
  test("parseTaskPlanFile: parsePlan ignores task-plan frontmatter", () => {
    const content = `---
estimated_steps: 2
estimated_files: 1
skills_used:
  - react
---

# S11: Frontmatter Compatible

**Goal:** Plan parser ignores task-plan handoff metadata.
**Demo:** Slice content still parses.

## Tasks

- [ ] **T01: Compatible task** \`est:5m\`
  Description.
`;
    const p = parsePlan(content);
    assert.deepStrictEqual(p.id, "S11", "plan id still parsed with frontmatter");
    assert.deepStrictEqual(p.tasks.length, 1, "task still parsed with frontmatter");
  });
  test("parsePlan: multi-line task description concatenation", () => {
    const content = `# S02: Multi-line Test

**Goal:** Test multi-line descriptions.
**Demo:** Descriptions are concatenated.

## Must-Haves

- Multi-line works

## Tasks

- [ ] **T01: Multi-line Task** \`est:30m\`
  First line of description.
  Second line of description.
  Third line of description.

- [ ] **T02: Single Line** \`est:10m\`
  Just one line.

## Files Likely Touched

- \`foo.ts\`
`;
    const p = parsePlan(content);
    assert.deepStrictEqual(p.tasks.length, 2, "two tasks");
    assert.ok(p.tasks[0].description.includes("First line"), "T01 desc has first line");
    assert.ok(p.tasks[0].description.includes("Second line"), "T01 desc has second line");
    assert.ok(p.tasks[0].description.includes("Third line"), "T01 desc has third line");
    assert.ok(p.tasks[0].description.includes("description. Second"), "lines joined with space");
    assert.deepStrictEqual(p.tasks[1].description, "Just one line.", "T02 single-line desc");
  });
  test("parsePlan: frontmatter does not pollute task descriptions", () => {
    const content = `---
estimated_steps: 2
estimated_files: 1
skills_used:
  - react
---

# S12: Frontmatter + multiline

## Tasks

- [ ] **T01: Multi-line Task** \`est:30m\`
  First line of description.
  Second line of description.
`;
    const p = parsePlan(content);
    assert.deepStrictEqual(p.tasks.length, 1, "one task parsed with frontmatter");
    assert.deepStrictEqual(p.tasks[0].description, "First line of description. Second line of description.", "frontmatter excluded from description");
  });
  test("parsePlan: task with missing estimate", () => {
    const content = `# S03: No Estimate

**Goal:** Handle tasks without estimates.
**Demo:** Parser doesn't crash.

## Tasks

- [ ] **T01: No Estimate Task**
  A task without an estimate backtick.

- [ ] **T02: Has Estimate** \`est:20m\`
  This one has an estimate.
`;
    const p = parsePlan(content);
    assert.deepStrictEqual(p.tasks.length, 2, "two tasks parsed");
    assert.deepStrictEqual(p.tasks[0].id, "T01", "T01 id");
    assert.deepStrictEqual(p.tasks[0].title, "No Estimate Task", "T01 title without estimate");
    assert.deepStrictEqual(p.tasks[0].done, false, "T01 not done");
    assert.deepStrictEqual(p.tasks[1].id, "T02", "T02 id");
  });
  test("parsePlan: empty tasks section", () => {
    const content = `# S04: Empty Tasks

**Goal:** No tasks yet.
**Demo:** Nothing.

## Must-Haves

- Something

## Tasks

## Files Likely Touched

- \`nothing.ts\`
`;
    const p = parsePlan(content);
    assert.deepStrictEqual(p.id, "S04", "plan id with empty tasks");
    assert.deepStrictEqual(p.tasks.length, 0, "no tasks");
    assert.deepStrictEqual(p.mustHaves.length, 1, "one must-have");
    assert.deepStrictEqual(p.filesLikelyTouched.length, 1, "one file");
  });
  test("parsePlan: no H1", () => {
    const content = `**Goal:** A plan without a heading.
**Demo:** Still parses.

## Tasks

- [ ] **T01: Orphan Task** \`est:5m\`
  A task in a headingless plan.
`;
    const p = parsePlan(content);
    assert.deepStrictEqual(p.id, "", "empty id without H1");
    assert.deepStrictEqual(p.title, "", "empty title without H1");
    assert.deepStrictEqual(p.goal, "A plan without a heading.", "goal still parsed");
    assert.deepStrictEqual(p.tasks.length, 1, "task still parsed");
    assert.deepStrictEqual(p.tasks[0].id, "T01", "task id");
  });
  test("parsePlan: task estimate backtick in description", () => {
    const content = `# S05: Estimate Handling

**Goal:** Test estimate text handling.
**Demo:** Works.

## Tasks

- [ ] **T01: With Estimate** \`est:45m\`
  Main description here.
`;
    const p = parsePlan(content);
    assert.deepStrictEqual(p.tasks.length, 1, "one task");
    assert.deepStrictEqual(p.tasks[0].id, "T01", "task id");
    assert.deepStrictEqual(p.tasks[0].title, "With Estimate", "title excludes estimate");
    assert.ok(p.tasks[0].description.includes("Main description"), "description from continuation line");
  });
  test("parsePlan: uppercase X for done", () => {
    const content = `# S06: Case Test

**Goal:** Test case.
**Demo:** Works.

## Tasks

- [X] **T01: Uppercase Done** \`est:5m\`
  Done with uppercase X.

- [x] **T02: Lowercase Done** \`est:5m\`
  Done with lowercase x.
`;
    const p = parsePlan(content);
    assert.deepStrictEqual(p.tasks[0].done, true, "uppercase X is done");
    assert.deepStrictEqual(p.tasks[1].done, true, "lowercase x is done");
  });
  test("parsePlan: no Must-Haves section", () => {
    const content = `# S07: No Must-Haves

**Goal:** Test missing must-haves.
**Demo:** Parser handles it.

## Tasks

- [ ] **T01: Only Task** \`est:10m\`
  The only task.
`;
    const p = parsePlan(content);
    assert.deepStrictEqual(p.mustHaves.length, 0, "empty must-haves");
    assert.deepStrictEqual(p.tasks.length, 1, "task still parsed");
  });
  test("parsePlan: no Files Likely Touched section", () => {
    const content = `# S08: No Files

**Goal:** Test missing files section.
**Demo:** Parser handles it.

## Tasks

- [ ] **T01: Task** \`est:10m\`
  Description.
`;
    const p = parsePlan(content);
    assert.deepStrictEqual(p.filesLikelyTouched.length, 0, "empty files likely touched");
  });
  test("parsePlan: old-format task entries (no sublines)", () => {
    const content = `# S09: Old Format

**Goal:** Test old-format compatibility.
**Demo:** Parser handles entries without sublines.

## Tasks

- [ ] **T01: Classic Task** \`est:10m\`
  Just a plain description with no labeled sublines.
`;
    const p = parsePlan(content);
    assert.deepStrictEqual(p.tasks.length, 1, "one task parsed");
    assert.deepStrictEqual(p.tasks[0].id, "T01", "task id");
    assert.deepStrictEqual(p.tasks[0].title, "Classic Task", "task title");
    assert.deepStrictEqual(p.tasks[0].done, false, "task not done");
    assert.deepStrictEqual(p.tasks[0].files, void 0, "files is undefined for old-format entry");
    assert.deepStrictEqual(p.tasks[0].verify, void 0, "verify is undefined for old-format entry");
  });
  test("parsePlan: new-format task entries with Files and Verify sublines", () => {
    const content = `# S10: New Format

**Goal:** Test new-format subline extraction.
**Demo:** Parser extracts Files and Verify correctly.

## Tasks

- [ ] **T01: Modern Task** \`est:15m\`
  - Why: because we need typed plan entries
  - Files: \`types.ts\`, \`files.ts\`
  - Verify: run the test suite
`;
    const p = parsePlan(content);
    assert.deepStrictEqual(p.tasks.length, 1, "one task parsed");
    assert.deepStrictEqual(p.tasks[0].id, "T01", "task id");
    assert.ok(Array.isArray(p.tasks[0].files), "files is an array");
    assert.deepStrictEqual(p.tasks[0].files.length, 2, "files array has two entries");
    assert.deepStrictEqual(p.tasks[0].files[0], "types.ts", "first file is types.ts");
    assert.deepStrictEqual(p.tasks[0].files[1], "files.ts", "second file is files.ts");
    assert.deepStrictEqual(p.tasks[0].verify, "run the test suite", "verify string extracted correctly");
    assert.ok(p.tasks[0].description.includes("Why: because we need typed plan entries"), "Why line accumulates into description");
  });
  test("parsePlan: heading-style task entries (### T01 -- Title)", () => {
    const content = `# S11: Heading Style

**Goal:** Test heading-style task parsing.
**Demo:** Parser handles heading-style task entries.

## Tasks

### T01 -- Implement feature

- Why: the feature is needed
- Files: \`src/feature.ts\`
- Verify: npm test

### T02 -- Write tests \`est:1h\`

Some description for the second task.
`;
    const p = parsePlan(content);
    assert.deepStrictEqual(p.tasks.length, 2, "heading-style task count");
    assert.deepStrictEqual(p.tasks[0].id, "T01", "heading T01 id");
    assert.deepStrictEqual(p.tasks[0].title, "Implement feature", "heading T01 title");
    assert.deepStrictEqual(p.tasks[0].done, false, "heading T01 not done (headings have no checkbox)");
    assert.deepStrictEqual(p.tasks[0].files[0], "src/feature.ts", "heading T01 files extracted");
    assert.deepStrictEqual(p.tasks[0].verify, "npm test", "heading T01 verify extracted");
    assert.deepStrictEqual(p.tasks[1].id, "T02", "heading T02 id");
    assert.deepStrictEqual(p.tasks[1].title, "Write tests", "heading T02 title");
    assert.deepStrictEqual(p.tasks[1].estimate, "1h", "heading T02 estimate");
    assert.ok(p.tasks[1].description.includes("Some description"), "heading T02 description");
  });
  test("parsePlan: heading-style with colon separator (### T01: Title)", () => {
    const content = `# S12: Heading Colon Style

**Goal:** Test colon-separated heading tasks.
**Demo:** Parser handles colon separator.

## Tasks

### T01: Setup project
  Basic project setup steps.

### T02: Add CI pipeline \`est:30m\`
  Configure CI.
`;
    const p = parsePlan(content);
    assert.deepStrictEqual(p.tasks.length, 2, "colon heading task count");
    assert.deepStrictEqual(p.tasks[0].id, "T01", "colon heading T01 id");
    assert.deepStrictEqual(p.tasks[0].title, "Setup project", "colon heading T01 title");
    assert.deepStrictEqual(p.tasks[1].id, "T02", "colon heading T02 id");
    assert.deepStrictEqual(p.tasks[1].title, "Add CI pipeline", "colon heading T02 title");
    assert.deepStrictEqual(p.tasks[1].estimate, "30m", "colon heading T02 estimate");
  });
  test("parsePlan: heading-style with em-dash separator (### T01 \u2014 Title)", () => {
    const content = `# S13: Em-Dash Style

**Goal:** Test em-dash separated heading tasks.
**Demo:** Parser handles em-dash separator.

## Tasks

### T01 \u2014 Build the widget

Widget description.
`;
    const p = parsePlan(content);
    assert.deepStrictEqual(p.tasks.length, 1, "em-dash heading task count");
    assert.deepStrictEqual(p.tasks[0].id, "T01", "em-dash heading T01 id");
    assert.deepStrictEqual(p.tasks[0].title, "Build the widget", "em-dash heading T01 title");
  });
  test("parsePlan: filename subheadings do not become task ids", () => {
    const content = `# S15: Filename Headings

**Goal:** Ignore file-reference subheadings inside task descriptions.
**Demo:** Only real task ids are parsed.

## Tasks

- [ ] **T01: First task** \`est:10m\`
  Implement the feature.

### constraints.py \u2014 \`add_off_request_tiered()\`
- preserve behavior

### annotations.py \u2014 \`annotate()\`
- keep metadata
`;
    const p = parsePlan(content);
    assert.deepStrictEqual(p.tasks.map((task) => task.id), ["T01"], "filename subheadings should not create extra tasks");
    assert.deepStrictEqual(p.tasks[0].title, "First task", "real task should still parse normally");
    assert.ok(p.tasks[0].description.includes("preserve behavior"), "detail lines under filename subheadings should remain attached to the task");
    assert.ok(p.tasks[0].description.includes("keep metadata"), "later detail lines should also remain attached to the task");
  });
  test("parsePlan: mixed checkbox and heading-style tasks", () => {
    const content = `# S14: Mixed Format

**Goal:** Test mixed formats.
**Demo:** Parser handles both styles in one plan.

## Tasks

- [ ] **T01: Checkbox task** \`est:20m\`
  A checkbox-style task.

### T02 -- Heading task \`est:15m\`

A heading-style task.

- [x] **T03: Done checkbox task** \`est:10m\`
  Already completed.
`;
    const p = parsePlan(content);
    assert.deepStrictEqual(p.tasks.length, 3, "mixed format task count");
    assert.deepStrictEqual(p.tasks[0].id, "T01", "mixed T01 id");
    assert.deepStrictEqual(p.tasks[0].done, false, "mixed T01 not done");
    assert.deepStrictEqual(p.tasks[1].id, "T02", "mixed T02 id");
    assert.deepStrictEqual(p.tasks[1].title, "Heading task", "mixed T02 title");
    assert.deepStrictEqual(p.tasks[1].estimate, "15m", "mixed T02 estimate");
    assert.deepStrictEqual(p.tasks[1].done, false, "mixed T02 not done (heading style)");
    assert.deepStrictEqual(p.tasks[2].id, "T03", "mixed T03 id");
    assert.deepStrictEqual(p.tasks[2].done, true, "mixed T03 done");
  });
  test("parseSummary: full summary with all frontmatter fields", () => {
    const content = `---
id: T01
parent: S01
milestone: M001
provides:
  - parseRoadmap test coverage
  - parsePlan test coverage
requires:
  - slice: S00
    provides: type definitions
  - slice: S02
    provides: state derivation
affects:
  - auto-mode dispatch
key_files:
  - tests/parsers.test.ts
  - files.ts
key_decisions:
  - Use manual assert pattern
patterns_established:
  - parsers.test.ts is the canonical test location
drill_down_paths:
  - tests/parsers.test.ts for assertion details
observability_surfaces:
  - test pass/fail output from node --test
  - exit code 1 on failure
duration: 23min
verification_result: pass
retries: 0
completed_at: 2025-03-10T08:00:00Z
---

# T01: Test parseRoadmap and parsePlan

**Created parsers.test.ts with 98 assertions across 16 test groups.**

## What Happened

Added comprehensive tests for parseRoadmap and parsePlan.

## Deviations

None.

## Files Created/Modified

- \`tests/parsers.test.ts\` \u2014 new test file with 98 assertions
- \`types.ts\` \u2014 added observability_surfaces field
- \`files.ts\` \u2014 updated parseSummary extraction
`;
    const s = parseSummary(content);
    assert.deepStrictEqual(s.frontmatter.id, "T01", "summary id");
    assert.deepStrictEqual(s.frontmatter.parent, "S01", "summary parent");
    assert.deepStrictEqual(s.frontmatter.milestone, "M001", "summary milestone");
    assert.deepStrictEqual(s.frontmatter.provides.length, 2, "provides count");
    assert.deepStrictEqual(s.frontmatter.provides[0], "parseRoadmap test coverage", "first provides");
    assert.deepStrictEqual(s.frontmatter.provides[1], "parsePlan test coverage", "second provides");
    assert.deepStrictEqual(s.frontmatter.requires.length, 2, "requires count");
    assert.deepStrictEqual(s.frontmatter.requires[0].slice, "S00", "first requires slice");
    assert.deepStrictEqual(s.frontmatter.requires[0].provides, "type definitions", "first requires provides");
    assert.deepStrictEqual(s.frontmatter.requires[1].slice, "S02", "second requires slice");
    assert.deepStrictEqual(s.frontmatter.requires[1].provides, "state derivation", "second requires provides");
    assert.deepStrictEqual(s.frontmatter.affects.length, 1, "affects count");
    assert.deepStrictEqual(s.frontmatter.affects[0], "auto-mode dispatch", "affects value");
    assert.deepStrictEqual(s.frontmatter.key_files.length, 2, "key_files count");
    assert.deepStrictEqual(s.frontmatter.key_decisions.length, 1, "key_decisions count");
    assert.deepStrictEqual(s.frontmatter.patterns_established.length, 1, "patterns_established count");
    assert.deepStrictEqual(s.frontmatter.drill_down_paths.length, 1, "drill_down_paths count");
    assert.deepStrictEqual(s.frontmatter.observability_surfaces.length, 2, "observability_surfaces count");
    assert.deepStrictEqual(s.frontmatter.observability_surfaces[0], "test pass/fail output from node --test", "first observability surface");
    assert.deepStrictEqual(s.frontmatter.observability_surfaces[1], "exit code 1 on failure", "second observability surface");
    assert.deepStrictEqual(s.frontmatter.duration, "23min", "duration");
    assert.deepStrictEqual(s.frontmatter.verification_result, "pass", "verification_result");
    assert.deepStrictEqual(s.frontmatter.completed_at, "2025-03-10T08:00:00Z", "completed_at");
    assert.deepStrictEqual(s.title, "T01: Test parseRoadmap and parsePlan", "summary title");
    assert.deepStrictEqual(s.oneLiner, "Created parsers.test.ts with 98 assertions across 16 test groups.", "one-liner");
    assert.ok(s.whatHappened.includes("comprehensive tests"), "whatHappened content");
    assert.deepStrictEqual(s.deviations, "None.", "deviations");
    assert.deepStrictEqual(s.filesModified.length, 3, "filesModified count");
    assert.deepStrictEqual(s.filesModified[0].path, "tests/parsers.test.ts", "first file path");
    assert.ok(s.filesModified[0].description.includes("98 assertions"), "first file description");
    assert.deepStrictEqual(s.filesModified[1].path, "types.ts", "second file path");
    assert.deepStrictEqual(s.filesModified[2].path, "files.ts", "third file path");
  });
  test("parseSummary: one-liner extraction (bold-wrapped line after H1)", () => {
    const content = `# S01: Parser Test Suite

**All 5 parsers have test coverage with edge cases.**

## What Happened

Things happened.
`;
    const s = parseSummary(content);
    assert.deepStrictEqual(s.title, "S01: Parser Test Suite", "title");
    assert.deepStrictEqual(s.oneLiner, "All 5 parsers have test coverage with edge cases.", "bold one-liner");
  });
  test("parseSummary: non-bold paragraph after H1 (empty one-liner)", () => {
    const content = `# T02: Some Task

This is just a regular paragraph, not bold.

## What Happened

Did stuff.
`;
    const s = parseSummary(content);
    assert.deepStrictEqual(s.title, "T02: Some Task", "title");
    assert.deepStrictEqual(s.oneLiner, "", "non-bold line results in empty one-liner");
  });
  test("parseSummary: files-modified parsing (backtick path \u2014 description format)", () => {
    const content = `# T03: File Changes

**One-liner.**

## Files Created/Modified

- \`src/index.ts\` \u2014 main entry point
- \`src/utils.ts\` \u2014 utility functions
- \`README.md\` \u2014 updated docs
`;
    const s = parseSummary(content);
    assert.deepStrictEqual(s.filesModified.length, 3, "three files");
    assert.deepStrictEqual(s.filesModified[0].path, "src/index.ts", "first path");
    assert.deepStrictEqual(s.filesModified[0].description, "main entry point", "first description");
    assert.deepStrictEqual(s.filesModified[1].path, "src/utils.ts", "second path");
    assert.deepStrictEqual(s.filesModified[2].path, "README.md", "third path");
  });
  test("parseSummary: missing frontmatter (safe defaults)", () => {
    const content = `# T04: No Frontmatter

**Did something.**

## What Happened

No frontmatter at all.
`;
    const s = parseSummary(content);
    assert.deepStrictEqual(s.frontmatter.id, "", "default id empty");
    assert.deepStrictEqual(s.frontmatter.parent, "", "default parent empty");
    assert.deepStrictEqual(s.frontmatter.milestone, "", "default milestone empty");
    assert.deepStrictEqual(s.frontmatter.provides.length, 0, "default provides empty");
    assert.deepStrictEqual(s.frontmatter.requires.length, 0, "default requires empty");
    assert.deepStrictEqual(s.frontmatter.affects.length, 0, "default affects empty");
    assert.deepStrictEqual(s.frontmatter.key_files.length, 0, "default key_files empty");
    assert.deepStrictEqual(s.frontmatter.key_decisions.length, 0, "default key_decisions empty");
    assert.deepStrictEqual(s.frontmatter.patterns_established.length, 0, "default patterns_established empty");
    assert.deepStrictEqual(s.frontmatter.drill_down_paths.length, 0, "default drill_down_paths empty");
    assert.deepStrictEqual(s.frontmatter.observability_surfaces.length, 0, "default observability_surfaces empty");
    assert.deepStrictEqual(s.frontmatter.duration, "", "default duration empty");
    assert.deepStrictEqual(s.frontmatter.verification_result, "untested", "default verification_result");
    assert.deepStrictEqual(s.frontmatter.completed_at, "", "default completed_at empty");
    assert.deepStrictEqual(s.title, "T04: No Frontmatter", "title still parsed");
    assert.deepStrictEqual(s.oneLiner, "Did something.", "one-liner still parsed");
  });
  test("parseSummary: empty body", () => {
    const content = `---
id: T05
parent: S01
milestone: M001
---
`;
    const s = parseSummary(content);
    assert.deepStrictEqual(s.frontmatter.id, "T05", "id from frontmatter");
    assert.deepStrictEqual(s.title, "", "empty title");
    assert.deepStrictEqual(s.oneLiner, "", "empty one-liner");
    assert.deepStrictEqual(s.whatHappened, "", "empty whatHappened");
    assert.deepStrictEqual(s.deviations, "", "empty deviations");
    assert.deepStrictEqual(s.filesModified.length, 0, "no files modified");
  });
  test("parseSummary: summary with requires array (nested objects)", () => {
    const content = `---
id: T06
parent: S02
milestone: M001
requires:
  - slice: S01
    provides: parser functions
  - slice: S00
    provides: core types
  - slice: S03
    provides: state engine
provides: []
affects: []
key_files: []
key_decisions: []
patterns_established: []
drill_down_paths: []
observability_surfaces: []
duration: 10min
verification_result: pass
retries: 1
completed_at: 2025-03-10T09:00:00Z
---

# T06: Nested Requires

**Test nested requires parsing.**

## What Happened

Tested.
`;
    const s = parseSummary(content);
    assert.deepStrictEqual(s.frontmatter.requires.length, 3, "three requires entries");
    assert.deepStrictEqual(s.frontmatter.requires[0].slice, "S01", "first requires slice");
    assert.deepStrictEqual(s.frontmatter.requires[0].provides, "parser functions", "first requires provides");
    assert.deepStrictEqual(s.frontmatter.requires[1].slice, "S00", "second requires slice");
    assert.deepStrictEqual(s.frontmatter.requires[2].slice, "S03", "third requires slice");
    assert.deepStrictEqual(s.frontmatter.requires[2].provides, "state engine", "third requires provides");
  });
  test("parseContinue: full continue file with all frontmatter fields", () => {
    const content = `---
milestone: M001
slice: S01
task: T02
step: 3
total_steps: 5
status: in_progress
saved_at: 2025-03-10T08:30:00Z
---

## Completed Work

Steps 1-3 are done. Created test file and wrote assertions.

## Remaining Work

Steps 4-5: run tests and check regressions.

## Decisions Made

Used manual assert pattern instead of node:assert.

## Context

Working in the gsd-s01 worktree. All imports use .ts extensions.

## Next Action

Run the full test suite with node --test.
`;
    const c = parseContinue(content);
    assert.deepStrictEqual(c.frontmatter.milestone, "M001", "continue milestone");
    assert.deepStrictEqual(c.frontmatter.slice, "S01", "continue slice");
    assert.deepStrictEqual(c.frontmatter.task, "T02", "continue task");
    assert.deepStrictEqual(c.frontmatter.step, 3, "continue step");
    assert.deepStrictEqual(c.frontmatter.totalSteps, 5, "continue totalSteps");
    assert.deepStrictEqual(c.frontmatter.status, "in_progress", "continue status");
    assert.deepStrictEqual(c.frontmatter.savedAt, "2025-03-10T08:30:00Z", "continue savedAt");
    assert.ok(c.completedWork.includes("Steps 1-3 are done"), "completedWork content");
    assert.ok(c.remainingWork.includes("Steps 4-5"), "remainingWork content");
    assert.ok(c.decisions.includes("manual assert pattern"), "decisions content");
    assert.ok(c.context.includes("gsd-s01 worktree"), "context content");
    assert.ok(c.nextAction.includes("node --test"), "nextAction content");
  });
  test("parseContinue: string step/totalSteps parsed as integers", () => {
    const content = `---
milestone: M002
slice: S03
task: T01
step: 7
total_steps: 12
status: in_progress
saved_at: 2025-03-10T10:00:00Z
---

## Completed Work

Some work.

## Remaining Work

More work.

## Decisions Made

None.

## Context

None.

## Next Action

Continue.
`;
    const c = parseContinue(content);
    assert.deepStrictEqual(c.frontmatter.step, 7, "step parsed as integer 7");
    assert.deepStrictEqual(c.frontmatter.totalSteps, 12, "totalSteps parsed as integer 12");
    assert.deepStrictEqual(typeof c.frontmatter.step, "number", "step is number type");
    assert.deepStrictEqual(typeof c.frontmatter.totalSteps, "number", "totalSteps is number type");
  });
  test("parseContinue: NaN step values (non-numeric strings)", () => {
    const content = `---
milestone: M001
slice: S01
task: T01
step: abc
total_steps: xyz
status: in_progress
saved_at: 2025-03-10T10:00:00Z
---

## Completed Work

Work.

## Remaining Work

Work.

## Decisions Made

None.

## Context

None.

## Next Action

Do things.
`;
    const c = parseContinue(content);
    const stepIsNaN = Number.isNaN(c.frontmatter.step);
    const totalIsNaN = Number.isNaN(c.frontmatter.totalSteps);
    assert.ok(stepIsNaN, "NaN step when non-numeric string");
    assert.ok(totalIsNaN, "NaN totalSteps when non-numeric string");
  });
  test("parseContinue: all three status variants", () => {
    for (const status of ["in_progress", "interrupted", "compacted"]) {
      const content = `---
milestone: M001
slice: S01
task: T01
step: 1
total_steps: 3
status: ${status}
saved_at: 2025-03-10T10:00:00Z
---

## Completed Work

Work.
`;
      const c = parseContinue(content);
      assert.deepStrictEqual(c.frontmatter.status, status, `status variant: ${status}`);
    }
  });
  test("parseContinue: missing frontmatter", () => {
    const content = `## Completed Work

Some work done.

## Remaining Work

More to do.

## Decisions Made

A decision.

## Context

Some context.

## Next Action

Next thing.
`;
    const c = parseContinue(content);
    assert.deepStrictEqual(c.frontmatter.milestone, "", "default milestone empty");
    assert.deepStrictEqual(c.frontmatter.slice, "", "default slice empty");
    assert.deepStrictEqual(c.frontmatter.task, "", "default task empty");
    assert.deepStrictEqual(c.frontmatter.step, 0, "default step 0");
    assert.deepStrictEqual(c.frontmatter.totalSteps, 0, "default totalSteps 0");
    assert.deepStrictEqual(c.frontmatter.status, "in_progress", "default status in_progress");
    assert.deepStrictEqual(c.frontmatter.savedAt, "", "default savedAt empty");
    assert.ok(c.completedWork.includes("Some work done"), "completedWork without frontmatter");
    assert.ok(c.remainingWork.includes("More to do"), "remainingWork without frontmatter");
    assert.ok(c.decisions.includes("A decision"), "decisions without frontmatter");
    assert.ok(c.context.includes("Some context"), "context without frontmatter");
    assert.ok(c.nextAction.includes("Next thing"), "nextAction without frontmatter");
  });
  test("parseContinue: body section extraction", () => {
    const content = `---
milestone: M001
slice: S01
task: T03
step: 2
total_steps: 4
status: interrupted
saved_at: 2025-03-10T11:00:00Z
---

## Completed Work

First paragraph of completed work.
Second paragraph continuing the explanation.

## Remaining Work

Need to finish step 3 and step 4.

## Decisions Made

Decided to use approach A over approach B because of performance.

## Context

Running in worktree. Node 22 required. TypeScript strict mode.

## Next Action

Pick up at step 3: run the integration tests.
`;
    const c = parseContinue(content);
    assert.ok(c.completedWork.includes("First paragraph"), "completedWork first paragraph");
    assert.ok(c.completedWork.includes("Second paragraph"), "completedWork second paragraph");
    assert.ok(c.remainingWork.includes("step 3 and step 4"), "remainingWork detail");
    assert.ok(c.decisions.includes("approach A over approach B"), "decisions detail");
    assert.ok(c.context.includes("Node 22 required"), "context detail");
    assert.ok(c.nextAction.includes("step 3: run the integration tests"), "nextAction detail");
  });
  test("parseContinue: total_steps vs totalSteps key support", () => {
    const content1 = `---
milestone: M001
slice: S01
task: T01
step: 2
total_steps: 8
status: in_progress
saved_at: 2025-03-10T12:00:00Z
---

## Completed Work

Work.
`;
    const c1 = parseContinue(content1);
    assert.deepStrictEqual(c1.frontmatter.totalSteps, 8, "total_steps snake_case works");
    const content2 = `---
milestone: M001
slice: S01
task: T01
step: 2
totalSteps: 6
status: in_progress
saved_at: 2025-03-10T12:00:00Z
---

## Completed Work

Work.
`;
    const c2 = parseContinue(content2);
    assert.deepStrictEqual(c2.frontmatter.totalSteps, 6, "totalSteps camelCase works");
  });
  test("parseRequirementCounts: full requirements file", () => {
    const content = `# Requirements

## Active

### R001 \u2014 User authentication
- Status: active

### R002 \u2014 Dashboard rendering
- Status: blocked

### R003 \u2014 API rate limiting
- Status: active

## Validated

### R010 \u2014 Parser test coverage
- Status: validated

### R011 \u2014 Type system
- Status: validated

## Deferred

### R020 \u2014 Admin panel
- Status: deferred

## Out of Scope

### R030 \u2014 Mobile app
- Status: out-of-scope

### R031 \u2014 Desktop app
- Status: out-of-scope
`;
    const counts = parseRequirementCounts(content);
    assert.deepStrictEqual(counts.active, 3, "active count");
    assert.deepStrictEqual(counts.validated, 2, "validated count");
    assert.deepStrictEqual(counts.deferred, 1, "deferred count");
    assert.deepStrictEqual(counts.outOfScope, 2, "outOfScope count");
    assert.deepStrictEqual(counts.blocked, 1, "blocked count");
    assert.deepStrictEqual(counts.total, 8, "total is sum of active+validated+deferred+outOfScope");
  });
  test("parseRequirementCounts: null input returns all zeros", () => {
    const counts = parseRequirementCounts(null);
    assert.deepStrictEqual(counts.active, 0, "null active");
    assert.deepStrictEqual(counts.validated, 0, "null validated");
    assert.deepStrictEqual(counts.deferred, 0, "null deferred");
    assert.deepStrictEqual(counts.outOfScope, 0, "null outOfScope");
    assert.deepStrictEqual(counts.blocked, 0, "null blocked");
    assert.deepStrictEqual(counts.total, 0, "null total");
  });
  test("parseRequirementCounts: empty sections return zero counts", () => {
    const content = `# Requirements

## Active

## Validated

## Deferred

## Out of Scope
`;
    const counts = parseRequirementCounts(content);
    assert.deepStrictEqual(counts.active, 0, "empty active");
    assert.deepStrictEqual(counts.validated, 0, "empty validated");
    assert.deepStrictEqual(counts.deferred, 0, "empty deferred");
    assert.deepStrictEqual(counts.outOfScope, 0, "empty outOfScope");
    assert.deepStrictEqual(counts.blocked, 0, "empty blocked");
    assert.deepStrictEqual(counts.total, 0, "empty total");
  });
  test("parseRequirementCounts: blocked status counting", () => {
    const content = `# Requirements

## Active

### R001 \u2014 Blocked thing
- Status: blocked

### R002 \u2014 Another blocked thing
- Status: blocked

### R003 \u2014 Active thing
- Status: active

## Validated

## Deferred

### R020 \u2014 Blocked deferred
- Status: blocked

## Out of Scope
`;
    const counts = parseRequirementCounts(content);
    assert.deepStrictEqual(counts.active, 3, "active includes blocked items in Active section");
    assert.deepStrictEqual(counts.blocked, 3, "blocked counts all blocked statuses across sections");
    assert.deepStrictEqual(counts.deferred, 1, "deferred section count");
  });
  test("parseRequirementCounts: total is sum of all section counts", () => {
    const content = `# Requirements

## Active

### R001 \u2014 One
- Status: active

## Validated

### R010 \u2014 Two
- Status: validated

### R011 \u2014 Three
- Status: validated

## Deferred

### R020 \u2014 Four
- Status: deferred

### R021 \u2014 Five
- Status: deferred

### R022 \u2014 Six
- Status: deferred

## Out of Scope

### R030 \u2014 Seven
- Status: out-of-scope
`;
    const counts = parseRequirementCounts(content);
    assert.deepStrictEqual(counts.active, 1, "one active");
    assert.deepStrictEqual(counts.validated, 2, "two validated");
    assert.deepStrictEqual(counts.deferred, 3, "three deferred");
    assert.deepStrictEqual(counts.outOfScope, 1, "one outOfScope");
    assert.deepStrictEqual(counts.total, 7, "total = 1 + 2 + 3 + 1");
    assert.deepStrictEqual(counts.total, counts.active + counts.validated + counts.deferred + counts.outOfScope, "total is exact sum");
  });
  test("parseSecretsManifest: full manifest with 3 keys", () => {
    const content = `# Secrets Manifest

**Milestone:** M003
**Generated:** 2025-06-15T10:00:00Z

### OPENAI_API_KEY

**Service:** OpenAI
**Dashboard:** https://platform.openai.com/api-keys
**Format hint:** starts with sk-
**Status:** pending
**Destination:** dotenv

1. Go to https://platform.openai.com/api-keys
2. Click "Create new secret key"
3. Copy the key immediately \u2014 it won't be shown again

### STRIPE_SECRET_KEY

**Service:** Stripe
**Dashboard:** https://dashboard.stripe.com/apikeys
**Format hint:** starts with sk_test_ or sk_live_
**Status:** collected
**Destination:** dotenv

1. Go to https://dashboard.stripe.com/apikeys
2. Reveal the secret key
3. Copy it

### SUPABASE_URL

**Service:** Supabase
**Dashboard:** https://app.supabase.com/project/settings/api
**Format hint:** https://<project-ref>.supabase.co
**Status:** skipped
**Destination:** vercel

1. Go to project settings in Supabase
2. Copy the URL from the API section
`;
    const m = parseSecretsManifest(content);
    assert.deepStrictEqual(m.milestone, "M003", "manifest milestone");
    assert.deepStrictEqual(m.generatedAt, "2025-06-15T10:00:00Z", "manifest generatedAt");
    assert.deepStrictEqual(m.entries.length, 3, "three entries");
    assert.deepStrictEqual(m.entries[0].key, "OPENAI_API_KEY", "entry 0 key");
    assert.deepStrictEqual(m.entries[0].service, "OpenAI", "entry 0 service");
    assert.deepStrictEqual(m.entries[0].dashboardUrl, "https://platform.openai.com/api-keys", "entry 0 dashboardUrl");
    assert.deepStrictEqual(m.entries[0].formatHint, "starts with sk-", "entry 0 formatHint");
    assert.deepStrictEqual(m.entries[0].status, "pending", "entry 0 status");
    assert.deepStrictEqual(m.entries[0].destination, "dotenv", "entry 0 destination");
    assert.deepStrictEqual(m.entries[0].guidance.length, 3, "entry 0 guidance count");
    assert.deepStrictEqual(m.entries[0].guidance[0], "Go to https://platform.openai.com/api-keys", "entry 0 guidance[0]");
    assert.deepStrictEqual(m.entries[0].guidance[2], "Copy the key immediately \u2014 it won't be shown again", "entry 0 guidance[2]");
    assert.deepStrictEqual(m.entries[1].key, "STRIPE_SECRET_KEY", "entry 1 key");
    assert.deepStrictEqual(m.entries[1].service, "Stripe", "entry 1 service");
    assert.deepStrictEqual(m.entries[1].status, "collected", "entry 1 status");
    assert.deepStrictEqual(m.entries[1].formatHint, "starts with sk_test_ or sk_live_", "entry 1 formatHint");
    assert.deepStrictEqual(m.entries[1].guidance.length, 3, "entry 1 guidance count");
    assert.deepStrictEqual(m.entries[2].key, "SUPABASE_URL", "entry 2 key");
    assert.deepStrictEqual(m.entries[2].status, "skipped", "entry 2 status");
    assert.deepStrictEqual(m.entries[2].destination, "vercel", "entry 2 destination");
    assert.deepStrictEqual(m.entries[2].guidance.length, 2, "entry 2 guidance count");
  });
  test("parseSecretsManifest: single-key manifest", () => {
    const content = `# Secrets Manifest

**Milestone:** M001
**Generated:** 2025-06-15T12:00:00Z

### DATABASE_URL

**Service:** PostgreSQL
**Dashboard:** https://console.neon.tech
**Format hint:** postgresql://...
**Status:** pending
**Destination:** dotenv

1. Create a database on Neon
2. Copy the connection string
`;
    const m = parseSecretsManifest(content);
    assert.deepStrictEqual(m.milestone, "M001", "single-key milestone");
    assert.deepStrictEqual(m.entries.length, 1, "single entry");
    assert.deepStrictEqual(m.entries[0].key, "DATABASE_URL", "single entry key");
    assert.deepStrictEqual(m.entries[0].service, "PostgreSQL", "single entry service");
    assert.deepStrictEqual(m.entries[0].guidance.length, 2, "single entry guidance count");
  });
  test("parseSecretsManifest: empty/no-secrets manifest", () => {
    const content = `# Secrets Manifest

**Milestone:** M002
**Generated:** 2025-06-15T14:00:00Z
`;
    const m = parseSecretsManifest(content);
    assert.deepStrictEqual(m.milestone, "M002", "empty manifest milestone");
    assert.deepStrictEqual(m.generatedAt, "2025-06-15T14:00:00Z", "empty manifest generatedAt");
    assert.deepStrictEqual(m.entries.length, 0, "no entries in empty manifest");
  });
  test("parseSecretsManifest: missing optional fields default correctly", () => {
    const content = `# Secrets Manifest

**Milestone:** M004
**Generated:** 2025-06-15T16:00:00Z

### SOME_API_KEY

**Service:** SomeService

1. Get the key from the dashboard
`;
    const m = parseSecretsManifest(content);
    assert.deepStrictEqual(m.entries.length, 1, "one entry with missing fields");
    assert.deepStrictEqual(m.entries[0].key, "SOME_API_KEY", "key parsed");
    assert.deepStrictEqual(m.entries[0].service, "SomeService", "service parsed");
    assert.deepStrictEqual(m.entries[0].dashboardUrl, "", "missing dashboardUrl defaults to empty string");
    assert.deepStrictEqual(m.entries[0].formatHint, "", "missing formatHint defaults to empty string");
    assert.deepStrictEqual(m.entries[0].status, "pending", "missing status defaults to pending");
    assert.deepStrictEqual(m.entries[0].destination, "dotenv", "missing destination defaults to dotenv");
    assert.deepStrictEqual(m.entries[0].guidance.length, 1, "guidance still parsed");
  });
  test("parseSecretsManifest: all three status values parse", () => {
    for (const status of ["pending", "collected", "skipped"]) {
      const content = `# Secrets Manifest

**Milestone:** M005
**Generated:** 2025-06-15T18:00:00Z

### TEST_KEY

**Service:** TestService
**Status:** ${status}

1. Do something
`;
      const m = parseSecretsManifest(content);
      assert.deepStrictEqual(m.entries[0].status, status, `status variant: ${status}`);
    }
  });
  test("parseSecretsManifest: invalid status defaults to pending", () => {
    const content = `# Secrets Manifest

**Milestone:** M006
**Generated:** 2025-06-15T20:00:00Z

### BAD_STATUS_KEY

**Service:** TestService
**Status:** invalid_value

1. Some step
`;
    const m = parseSecretsManifest(content);
    assert.deepStrictEqual(m.entries[0].status, "pending", "invalid status defaults to pending");
  });
  test("parseSecretsManifest + formatSecretsManifest: round-trip", () => {
    const original = `# Secrets Manifest

**Milestone:** M007
**Generated:** 2025-06-16T10:00:00Z

### OPENAI_API_KEY

**Service:** OpenAI
**Dashboard:** https://platform.openai.com/api-keys
**Format hint:** starts with sk-
**Status:** pending
**Destination:** dotenv

1. Go to the API keys page
2. Create a new key
3. Copy it

### REDIS_URL

**Service:** Upstash
**Dashboard:** https://console.upstash.com
**Format hint:** redis://...
**Status:** collected
**Destination:** vercel

1. Open Upstash console
2. Copy the Redis URL
`;
    const parsed1 = parseSecretsManifest(original);
    const formatted = formatSecretsManifest(parsed1);
    const parsed2 = parseSecretsManifest(formatted);
    assert.deepStrictEqual(parsed2.milestone, parsed1.milestone, "round-trip milestone");
    assert.deepStrictEqual(parsed2.generatedAt, parsed1.generatedAt, "round-trip generatedAt");
    assert.deepStrictEqual(parsed2.entries.length, parsed1.entries.length, "round-trip entry count");
    for (let i = 0; i < parsed1.entries.length; i++) {
      const e1 = parsed1.entries[i];
      const e2 = parsed2.entries[i];
      assert.deepStrictEqual(e2.key, e1.key, `round-trip entry ${i} key`);
      assert.deepStrictEqual(e2.service, e1.service, `round-trip entry ${i} service`);
      assert.deepStrictEqual(e2.dashboardUrl, e1.dashboardUrl, `round-trip entry ${i} dashboardUrl`);
      assert.deepStrictEqual(e2.formatHint, e1.formatHint, `round-trip entry ${i} formatHint`);
      assert.deepStrictEqual(e2.status, e1.status, `round-trip entry ${i} status`);
      assert.deepStrictEqual(e2.destination, e1.destination, `round-trip entry ${i} destination`);
      assert.deepStrictEqual(e2.guidance.length, e1.guidance.length, `round-trip entry ${i} guidance length`);
      for (let j = 0; j < e1.guidance.length; j++) {
        assert.deepStrictEqual(e2.guidance[j], e1.guidance[j], `round-trip entry ${i} guidance[${j}]`);
      }
    }
  });
  test("LLM round-trip: extra whitespace", () => {
    const messy = `# Secrets Manifest

**Milestone:**   M010  
**Generated:**   2025-07-01T12:00:00Z  

###   OPENAI_API_KEY  

**Service:**   OpenAI  
**Dashboard:**   https://platform.openai.com/api-keys  
**Format hint:**   starts with sk-  
**Status:**   pending  
**Destination:**   dotenv  

1.   Go to the API keys page  
2.   Create a new key  

###   REDIS_URL  

**Service:**   Upstash  
**Status:**   collected  
**Destination:**   vercel  

1.   Open console  
`;
    const parsed1 = parseSecretsManifest(messy);
    const formatted = formatSecretsManifest(parsed1);
    const parsed2 = parseSecretsManifest(formatted);
    assert.deepStrictEqual(parsed2.milestone, parsed1.milestone, "whitespace round-trip milestone");
    assert.deepStrictEqual(parsed2.generatedAt, parsed1.generatedAt, "whitespace round-trip generatedAt");
    assert.deepStrictEqual(parsed2.entries.length, parsed1.entries.length, "whitespace round-trip entry count");
    assert.deepStrictEqual(parsed2.entries.length, 2, "whitespace: two entries parsed");
    for (let i = 0; i < parsed1.entries.length; i++) {
      const e1 = parsed1.entries[i];
      const e2 = parsed2.entries[i];
      assert.deepStrictEqual(e2.key, e1.key, `whitespace round-trip entry ${i} key`);
      assert.deepStrictEqual(e2.service, e1.service, `whitespace round-trip entry ${i} service`);
      assert.deepStrictEqual(e2.dashboardUrl, e1.dashboardUrl, `whitespace round-trip entry ${i} dashboardUrl`);
      assert.deepStrictEqual(e2.formatHint, e1.formatHint, `whitespace round-trip entry ${i} formatHint`);
      assert.deepStrictEqual(e2.status, e1.status, `whitespace round-trip entry ${i} status`);
      assert.deepStrictEqual(e2.destination, e1.destination, `whitespace round-trip entry ${i} destination`);
      assert.deepStrictEqual(e2.guidance.length, e1.guidance.length, `whitespace round-trip entry ${i} guidance length`);
      for (let j = 0; j < e1.guidance.length; j++) {
        assert.deepStrictEqual(e2.guidance[j], e1.guidance[j], `whitespace round-trip entry ${i} guidance[${j}]`);
      }
    }
    assert.deepStrictEqual(parsed1.milestone, "M010", "whitespace: milestone trimmed");
    assert.deepStrictEqual(parsed1.entries[0].key, "OPENAI_API_KEY", "whitespace: key trimmed");
    assert.deepStrictEqual(parsed1.entries[0].service, "OpenAI", "whitespace: service trimmed");
  });
  test("LLM round-trip: missing optional fields", () => {
    const minimal = `# Secrets Manifest

**Milestone:** M011
**Generated:** 2025-07-02T08:00:00Z

### DATABASE_URL

**Service:** Neon
**Status:** pending
**Destination:** dotenv

1. Create a Neon project
2. Copy connection string

### WEBHOOK_SECRET

**Service:** Stripe
**Status:** collected
**Destination:** dotenv

1. Go to webhooks
`;
    const parsed1 = parseSecretsManifest(minimal);
    assert.deepStrictEqual(parsed1.entries[0].dashboardUrl, "", "missing-optional: no dashboard \u2192 empty string");
    assert.deepStrictEqual(parsed1.entries[0].formatHint, "", "missing-optional: no format hint \u2192 empty string");
    assert.deepStrictEqual(parsed1.entries[1].dashboardUrl, "", "missing-optional: entry 2 no dashboard \u2192 empty string");
    assert.deepStrictEqual(parsed1.entries[1].formatHint, "", "missing-optional: entry 2 no format hint \u2192 empty string");
    const formatted = formatSecretsManifest(parsed1);
    const parsed2 = parseSecretsManifest(formatted);
    assert.deepStrictEqual(parsed2.entries.length, parsed1.entries.length, "missing-optional round-trip entry count");
    for (let i = 0; i < parsed1.entries.length; i++) {
      const e1 = parsed1.entries[i];
      const e2 = parsed2.entries[i];
      assert.deepStrictEqual(e2.key, e1.key, `missing-optional round-trip entry ${i} key`);
      assert.deepStrictEqual(e2.service, e1.service, `missing-optional round-trip entry ${i} service`);
      assert.deepStrictEqual(e2.dashboardUrl, e1.dashboardUrl, `missing-optional round-trip entry ${i} dashboardUrl`);
      assert.deepStrictEqual(e2.formatHint, e1.formatHint, `missing-optional round-trip entry ${i} formatHint`);
      assert.deepStrictEqual(e2.status, e1.status, `missing-optional round-trip entry ${i} status`);
      assert.deepStrictEqual(e2.destination, e1.destination, `missing-optional round-trip entry ${i} destination`);
      assert.deepStrictEqual(e2.guidance.length, e1.guidance.length, `missing-optional round-trip entry ${i} guidance length`);
    }
  });
  test("LLM round-trip: extra blank lines", () => {
    const blanky = `# Secrets Manifest


**Milestone:** M012
**Generated:** 2025-07-03T14:00:00Z



### API_KEY_ONE


**Service:** ServiceOne
**Dashboard:** https://one.example.com


**Format hint:** key_...
**Status:** pending
**Destination:** dotenv



1. Go to settings


2. Generate key



### API_KEY_TWO



**Service:** ServiceTwo
**Status:** skipped
**Destination:** dotenv


1. Not needed
`;
    const parsed1 = parseSecretsManifest(blanky);
    assert.deepStrictEqual(parsed1.entries.length, 2, "blank-lines: two entries parsed");
    assert.deepStrictEqual(parsed1.milestone, "M012", "blank-lines: milestone parsed");
    assert.deepStrictEqual(parsed1.entries[0].key, "API_KEY_ONE", "blank-lines: first key");
    assert.deepStrictEqual(parsed1.entries[0].guidance.length, 2, "blank-lines: first entry guidance count");
    assert.deepStrictEqual(parsed1.entries[1].key, "API_KEY_TWO", "blank-lines: second key");
    assert.deepStrictEqual(parsed1.entries[1].status, "skipped", "blank-lines: second entry status");
    const formatted = formatSecretsManifest(parsed1);
    const parsed2 = parseSecretsManifest(formatted);
    assert.deepStrictEqual(parsed2.entries.length, parsed1.entries.length, "blank-lines round-trip entry count");
    for (let i = 0; i < parsed1.entries.length; i++) {
      const e1 = parsed1.entries[i];
      const e2 = parsed2.entries[i];
      assert.deepStrictEqual(e2.key, e1.key, `blank-lines round-trip entry ${i} key`);
      assert.deepStrictEqual(e2.service, e1.service, `blank-lines round-trip entry ${i} service`);
      assert.deepStrictEqual(e2.dashboardUrl, e1.dashboardUrl, `blank-lines round-trip entry ${i} dashboardUrl`);
      assert.deepStrictEqual(e2.formatHint, e1.formatHint, `blank-lines round-trip entry ${i} formatHint`);
      assert.deepStrictEqual(e2.status, e1.status, `blank-lines round-trip entry ${i} status`);
      assert.deepStrictEqual(e2.destination, e1.destination, `blank-lines round-trip entry ${i} destination`);
      assert.deepStrictEqual(e2.guidance.length, e1.guidance.length, `blank-lines round-trip entry ${i} guidance length`);
    }
    const consecutiveBlanks = formatted.match(/\n{4,}/g);
    assert.ok(consecutiveBlanks === null, "blank-lines: formatted output has no 4+ consecutive newlines");
  });
  test("parseRoadmap: boundary map with code fences (#468)", () => {
    const content = `# M001: Test

**Vision:** Test

## Slices

- [ ] **S01: Core** \`risk:low\` \`depends:[]\`
- [ ] **S02: API** \`risk:low\` \`depends:[S01]\`

## Boundary Map

### S01 \u2192 S02

Produces:
  types.ts \u2014 all types
  \`\`\`
  const x = 1;
  \`\`\`

Consumes: nothing
`;
    const start = Date.now();
    const r = parseRoadmap(content);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 1e3, `boundary map with code fences parsed in ${elapsed}ms (should be < 1s)`);
    assert.deepStrictEqual(r.slices.length, 2, "code-fence roadmap: slice count");
    assert.ok(r.boundaryMap.length >= 0, "code-fence roadmap: boundary map parsed without hanging");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wYXJzZXJzLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IGRlc2NyaWJlLCB0ZXN0IH0gZnJvbSAnbm9kZTp0ZXN0JztcbmltcG9ydCBhc3NlcnQgZnJvbSAnbm9kZTphc3NlcnQvc3RyaWN0JztcbmltcG9ydCB7IHBhcnNlUm9hZG1hcCwgcGFyc2VQbGFuIH0gZnJvbSAnLi4vcGFyc2Vycy1sZWdhY3kudHMnO1xuaW1wb3J0IHsgcGFyc2VUYXNrUGxhbkZpbGUsIHBhcnNlU3VtbWFyeSwgcGFyc2VDb250aW51ZSwgcGFyc2VSZXF1aXJlbWVudENvdW50cywgcGFyc2VTZWNyZXRzTWFuaWZlc3QsIGZvcm1hdFNlY3JldHNNYW5pZmVzdCB9IGZyb20gJy4uL2ZpbGVzLnRzJztcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuLy8gcGFyc2VSb2FkbWFwIHRlc3RzXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuXG5kZXNjcmliZSgncGFyc2VycycsICgpID0+IHtcbnRlc3QoJ3BhcnNlUm9hZG1hcDogZnVsbCByb2FkbWFwJywgKCkgPT4ge1xuICBjb25zdCBjb250ZW50ID0gYCMgTTAwMTogR1NEIEV4dGVuc2lvbiBcdTIwMTQgSGllcmFyY2hpY2FsIFBsYW5uaW5nXG5cbioqVmlzaW9uOioqIEJ1aWxkIGEgc3RydWN0dXJlZCBwbGFubmluZyBzeXN0ZW0gZm9yIGNvZGluZyBhZ2VudHMuXG5cbioqU3VjY2VzcyBDcml0ZXJpYToqKlxuLSBBbGwgcGFyc2VycyBoYXZlIHRlc3QgY292ZXJhZ2Vcbi0gUm91bmQtdHJpcCBmb3JtYXR0aW5nIHByZXNlcnZlcyBkYXRhXG4tIFN0YXRlIGRlcml2YXRpb24gd29ya3MgY29ycmVjdGx5XG5cbi0tLVxuXG4jIyBTbGljZXNcblxuLSBbeF0gKipTMDE6IFR5cGVzICsgRmlsZSBJL08qKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgXG4gID4gQWZ0ZXIgdGhpczogQWxsIHR5cGVzIGRlZmluZWQgYW5kIHBhcnNlcnMgd29yay5cblxuLSBbIF0gKipTMDI6IFN0YXRlIERlcml2YXRpb24qKiBcXGByaXNrOm1lZGl1bVxcYCBcXGBkZXBlbmRzOltTMDFdXFxgXG4gID4gQWZ0ZXIgdGhpczogRGFzaGJvYXJkIHNob3dzIHJlYWwtdGltZSBzdGF0ZS5cblxuLSBbIF0gKipTMDM6IEF1dG8gTW9kZSoqIFxcYHJpc2s6aGlnaFxcYCBcXGBkZXBlbmRzOltTMDEsIFMwMl1cXGBcbiAgPiBBZnRlciB0aGlzOiBBZ2VudCBjYW4gZXhlY3V0ZSB0YXNrcyBhdXRvbWF0aWNhbGx5LlxuXG4tLS1cblxuIyMgQm91bmRhcnkgTWFwXG5cbiMjIyBTMDEgXHUyMTkyIFMwMlxuXFxgXFxgXFxgXG5Qcm9kdWNlczpcbiAgdHlwZXMudHMgXHUyMDE0IGFsbCB0eXBlIGRlZmluaXRpb25zXG4gIGZpbGVzLnRzIFx1MjAxNCBwYXJzZXIgYW5kIGZvcm1hdHRlciBmdW5jdGlvbnNcblxuQ29uc3VtZXMgZnJvbSBTMDI6XG4gIG5vdGhpbmdcblxcYFxcYFxcYFxuXG4jIyMgUzAyIFx1MjE5MiBTMDNcblxcYFxcYFxcYFxuUHJvZHVjZXM6XG4gIHN0YXRlLnRzIFx1MjAxNCBkZXJpdmVTdGF0ZSBmdW5jdGlvblxuXG5Db25zdW1lcyBmcm9tIFMwMzpcbiAgYXV0by1tb2RlIGVudHJ5IHBvaW50c1xuXFxgXFxgXFxgXG5gO1xuXG4gIGNvbnN0IHIgPSBwYXJzZVJvYWRtYXAoY29udGVudCk7XG5cbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyLnRpdGxlLCAnTTAwMTogR1NEIEV4dGVuc2lvbiBcdTIwMTQgSGllcmFyY2hpY2FsIFBsYW5uaW5nJywgJ3JvYWRtYXAgdGl0bGUnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyLnZpc2lvbiwgJ0J1aWxkIGEgc3RydWN0dXJlZCBwbGFubmluZyBzeXN0ZW0gZm9yIGNvZGluZyBhZ2VudHMuJywgJ3JvYWRtYXAgdmlzaW9uJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoci5zdWNjZXNzQ3JpdGVyaWEubGVuZ3RoLCAzLCAnc3VjY2VzcyBjcml0ZXJpYSBjb3VudCcpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHIuc3VjY2Vzc0NyaXRlcmlhWzBdLCAnQWxsIHBhcnNlcnMgaGF2ZSB0ZXN0IGNvdmVyYWdlJywgJ2ZpcnN0IHN1Y2Nlc3MgY3JpdGVyaW9uJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoci5zdWNjZXNzQ3JpdGVyaWFbMl0sICdTdGF0ZSBkZXJpdmF0aW9uIHdvcmtzIGNvcnJlY3RseScsICd0aGlyZCBzdWNjZXNzIGNyaXRlcmlvbicpO1xuXG4gIC8vIFNsaWNlc1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHIuc2xpY2VzLmxlbmd0aCwgMywgJ3NsaWNlIGNvdW50Jyk7XG5cbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyLnNsaWNlc1swXS5pZCwgJ1MwMScsICdTMDEgaWQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyLnNsaWNlc1swXS50aXRsZSwgJ1R5cGVzICsgRmlsZSBJL08nLCAnUzAxIHRpdGxlJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoci5zbGljZXNbMF0ucmlzaywgJ2xvdycsICdTMDEgcmlzaycpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHIuc2xpY2VzWzBdLmRlcGVuZHMsIFtdLCAnUzAxIGRlcGVuZHMnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyLnNsaWNlc1swXS5kb25lLCB0cnVlLCAnUzAxIGRvbmUnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyLnNsaWNlc1swXS5kZW1vLCAnQWxsIHR5cGVzIGRlZmluZWQgYW5kIHBhcnNlcnMgd29yay4nLCAnUzAxIGRlbW8nKTtcblxuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHIuc2xpY2VzWzFdLmlkLCAnUzAyJywgJ1MwMiBpZCcpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHIuc2xpY2VzWzFdLnRpdGxlLCAnU3RhdGUgRGVyaXZhdGlvbicsICdTMDIgdGl0bGUnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyLnNsaWNlc1sxXS5yaXNrLCAnbWVkaXVtJywgJ1MwMiByaXNrJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoci5zbGljZXNbMV0uZGVwZW5kcywgWydTMDEnXSwgJ1MwMiBkZXBlbmRzJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoci5zbGljZXNbMV0uZG9uZSwgZmFsc2UsICdTMDIgZG9uZScpO1xuXG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoci5zbGljZXNbMl0uaWQsICdTMDMnLCAnUzAzIGlkJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoci5zbGljZXNbMl0ucmlzaywgJ2hpZ2gnLCAnUzAzIHJpc2snKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyLnNsaWNlc1syXS5kZXBlbmRzLCBbJ1MwMScsICdTMDInXSwgJ1MwMyBkZXBlbmRzJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoci5zbGljZXNbMl0uZG9uZSwgZmFsc2UsICdTMDMgZG9uZScpO1xuXG4gIC8vIEJvdW5kYXJ5IG1hcFxuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHIuYm91bmRhcnlNYXAubGVuZ3RoLCAyLCAnYm91bmRhcnkgbWFwIGVudHJ5IGNvdW50Jyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoci5ib3VuZGFyeU1hcFswXS5mcm9tU2xpY2UsICdTMDEnLCAnYm1bMF0gZnJvbScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHIuYm91bmRhcnlNYXBbMF0udG9TbGljZSwgJ1MwMicsICdibVswXSB0bycpO1xuICBhc3NlcnQub2soci5ib3VuZGFyeU1hcFswXS5wcm9kdWNlcy5pbmNsdWRlcygndHlwZXMudHMnKSwgJ2JtWzBdIHByb2R1Y2VzIG1lbnRpb25zIHR5cGVzLnRzJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoci5ib3VuZGFyeU1hcFsxXS5mcm9tU2xpY2UsICdTMDInLCAnYm1bMV0gZnJvbScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHIuYm91bmRhcnlNYXBbMV0udG9TbGljZSwgJ1MwMycsICdibVsxXSB0bycpO1xufSk7XG5cbnRlc3QoJ3BhcnNlUm9hZG1hcDogZW1wdHkgc2xpY2VzIHNlY3Rpb24nLCAoKSA9PiB7XG4gIGNvbnN0IGNvbnRlbnQgPSBgIyBNMDAyOiBFbXB0eSBNaWxlc3RvbmVcblxuKipWaXNpb246KiogTm90aGluZyB5ZXQuXG5cbiMjIFNsaWNlc1xuXG4jIyBCb3VuZGFyeSBNYXBcbmA7XG5cbiAgY29uc3QgciA9IHBhcnNlUm9hZG1hcChjb250ZW50KTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyLnRpdGxlLCAnTTAwMjogRW1wdHkgTWlsZXN0b25lJywgJ3RpdGxlIHdpdGggZW1wdHkgc2xpY2VzJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoci5zbGljZXMubGVuZ3RoLCAwLCAnbm8gc2xpY2VzIHBhcnNlZCcpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHIuYm91bmRhcnlNYXAubGVuZ3RoLCAwLCAnbm8gYm91bmRhcnkgbWFwIGVudHJpZXMnKTtcbn0pO1xuXG50ZXN0KCdwYXJzZVJvYWRtYXA6IG1hbGZvcm1lZCBjaGVja2JveCBsaW5lcycsICgpID0+IHtcbiAgLy8gTGluZXMgdGhhdCBkb24ndCBtYXRjaCB0aGUgZXhwZWN0ZWQgYm9sZCBwYXR0ZXJuIHNob3VsZCBiZSBza2lwcGVkXG4gIGNvbnN0IGNvbnRlbnQgPSBgIyBNMDAzOiBNYWxmb3JtZWRcblxuKipWaXNpb246KiogVGVzdCBtYWxmb3JtZWQgbGluZXMuXG5cbiMjIFNsaWNlc1xuXG4tIFsgXSBTMDE6IE1pc3NpbmcgYm9sZCBtYXJrZXJzIFxcYHJpc2s6bG93XFxgIFxcYGRlcGVuZHM6W11cXGBcbi0gW3hdICoqUzAyOiBWYWxpZCBTbGljZSoqIFxcYHJpc2s6bWVkaXVtXFxgIFxcYGRlcGVuZHM6W11cXGBcbiAgPiBBZnRlciB0aGlzOiBXb3Jrcy5cbi0gWyBdIE5vdCBhIGNoZWNrYm94IGF0IGFsbFxuICBTb21lIHJhbmRvbSB0ZXh0XG4tIFt4XSAqKlMwMzogQW5vdGhlciBWYWxpZCoqIFxcYHJpc2s6aGlnaFxcYCBcXGBkZXBlbmRzOltTMDJdXFxgXG4gID4gQWZ0ZXIgdGhpczogQWxzbyB3b3Jrcy5cbmA7XG5cbiAgY29uc3QgciA9IHBhcnNlUm9hZG1hcChjb250ZW50KTtcbiAgLy8gT25seSBTMDIgYW5kIFMwMyBzaG91bGQgYmUgcGFyc2VkIChtYWxmb3JtZWQgbGluZXMgd2l0aG91dCBib2xkIG1hcmtlcnMgYXJlIHNraXBwZWQpXG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoci5zbGljZXMubGVuZ3RoLCAyLCAnb25seSB2YWxpZCBzbGljZXMgcGFyc2VkIGZyb20gbWFsZm9ybWVkIGlucHV0Jyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoci5zbGljZXNbMF0uaWQsICdTMDInLCAnZmlyc3QgdmFsaWQgc2xpY2UgaXMgUzAyJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoci5zbGljZXNbMF0uZG9uZSwgdHJ1ZSwgJ1MwMiBkb25lJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoci5zbGljZXNbMV0uaWQsICdTMDMnLCAnc2Vjb25kIHZhbGlkIHNsaWNlIGlzIFMwMycpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHIuc2xpY2VzWzFdLmRlcGVuZHMsIFsnUzAyJ10sICdTMDMgZGVwZW5kcyBvbiBTMDInKTtcbn0pO1xuXG50ZXN0KCdwYXJzZVJvYWRtYXA6IGxvd2VyY2FzZSB2cyB1cHBlcmNhc2UgWCBmb3IgZG9uZScsICgpID0+IHtcbiAgY29uc3QgY29udGVudCA9IGAjIE0wMDQ6IENhc2UgVGVzdFxuXG4qKlZpc2lvbjoqKiBUZXN0IFggY2FzZSBzZW5zaXRpdml0eS5cblxuIyMgU2xpY2VzXG5cbi0gW3hdICoqUzAxOiBMb3dlcmNhc2UgeCoqIFxcYHJpc2s6bG93XFxgIFxcYGRlcGVuZHM6W11cXGBcbiAgPiBBZnRlciB0aGlzOiBkb25lLlxuXG4tIFtYXSAqKlMwMjogVXBwZXJjYXNlIFgqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgXG4gID4gQWZ0ZXIgdGhpczogYWxzbyBkb25lLlxuXG4tIFsgXSAqKlMwMzogTm90IERvbmUqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgXG4gID4gQWZ0ZXIgdGhpczogbm90IHlldC5cbmA7XG5cbiAgY29uc3QgciA9IHBhcnNlUm9hZG1hcChjb250ZW50KTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyLnNsaWNlcy5sZW5ndGgsIDMsICdhbGwgdGhyZWUgc2xpY2VzIHBhcnNlZCcpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHIuc2xpY2VzWzBdLmRvbmUsIHRydWUsICdsb3dlcmNhc2UgeCBpcyBkb25lJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoci5zbGljZXNbMV0uZG9uZSwgdHJ1ZSwgJ3VwcGVyY2FzZSBYIGlzIGRvbmUnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyLnNsaWNlc1syXS5kb25lLCBmYWxzZSwgJ3NwYWNlIGlzIG5vdCBkb25lJyk7XG59KTtcblxudGVzdCgncGFyc2VSb2FkbWFwOiBtaXNzaW5nIGJvdW5kYXJ5IG1hcCcsICgpID0+IHtcbiAgY29uc3QgY29udGVudCA9IGAjIE0wMDU6IE5vIEJvdW5kYXJ5IE1hcFxuXG4qKlZpc2lvbjoqKiBBIHJvYWRtYXAgd2l0aG91dCBhIGJvdW5kYXJ5IG1hcCBzZWN0aW9uLlxuXG4qKlN1Y2Nlc3MgQ3JpdGVyaWE6Kipcbi0gT25lIGNyaXRlcmlvblxuXG4tLS1cblxuIyMgU2xpY2VzXG5cbi0gWyBdICoqUzAxOiBPbmx5IFNsaWNlKiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbXVxcYFxuICA+IEFmdGVyIHRoaXM6IERvbmUuXG5gO1xuXG4gIGNvbnN0IHIgPSBwYXJzZVJvYWRtYXAoY29udGVudCk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoci50aXRsZSwgJ00wMDU6IE5vIEJvdW5kYXJ5IE1hcCcsICd0aXRsZScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHIuc2xpY2VzLmxlbmd0aCwgMSwgJ29uZSBzbGljZScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHIuYm91bmRhcnlNYXAubGVuZ3RoLCAwLCAnZW1wdHkgYm91bmRhcnkgbWFwIHdoZW4gc2VjdGlvbiBtaXNzaW5nJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoci5zdWNjZXNzQ3JpdGVyaWEubGVuZ3RoLCAxLCAnb25lIHN1Y2Nlc3MgY3JpdGVyaW9uJyk7XG59KTtcblxudGVzdCgncGFyc2VSb2FkbWFwOiBubyBzZWN0aW9ucyBhdCBhbGwnLCAoKSA9PiB7XG4gIGNvbnN0IGNvbnRlbnQgPSBgIyBNMDA2OiBCYXJlIE1pbmltdW1cblxuSnVzdCBhIHRpdGxlIGFuZCBub3RoaW5nIGVsc2UuXG5gO1xuXG4gIGNvbnN0IHIgPSBwYXJzZVJvYWRtYXAoY29udGVudCk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoci50aXRsZSwgJ00wMDY6IEJhcmUgTWluaW11bScsICd0aXRsZSBmcm9tIGJhcmUgcm9hZG1hcCcpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHIudmlzaW9uLCAnJywgJ2VtcHR5IHZpc2lvbicpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHIuc3VjY2Vzc0NyaXRlcmlhLmxlbmd0aCwgMCwgJ25vIHN1Y2Nlc3MgY3JpdGVyaWEnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyLnNsaWNlcy5sZW5ndGgsIDAsICdubyBzbGljZXMnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyLmJvdW5kYXJ5TWFwLmxlbmd0aCwgMCwgJ25vIGJvdW5kYXJ5IG1hcCcpO1xufSk7XG5cbnRlc3QoJ3BhcnNlUm9hZG1hcDogc2xpY2Ugd2l0aCBubyBkZW1vIGJsb2NrcXVvdGUnLCAoKSA9PiB7XG4gIGNvbnN0IGNvbnRlbnQgPSBgIyBNMDA3OiBObyBEZW1vXG5cbioqVmlzaW9uOioqIFRlc3Rpbmcgc2xpY2VzIHdpdGhvdXQgZGVtbyBsaW5lcy5cblxuIyMgU2xpY2VzXG5cbi0gWyBdICoqUzAxOiBObyBEZW1vIEhlcmUqKiBcXGByaXNrOm1lZGl1bVxcYCBcXGBkZXBlbmRzOltdXFxgXG4tIFsgXSAqKlMwMjogQWxzbyBObyBEZW1vKiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbUzAxXVxcYFxuYDtcblxuICBjb25zdCByID0gcGFyc2VSb2FkbWFwKGNvbnRlbnQpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHIuc2xpY2VzLmxlbmd0aCwgMiwgJ3R3byBzbGljZXMgd2l0aG91dCBkZW1vcycpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHIuc2xpY2VzWzBdLmRlbW8sICcnLCAnUzAxIGRlbW8gZW1wdHknKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyLnNsaWNlc1sxXS5kZW1vLCAnJywgJ1MwMiBkZW1vIGVtcHR5Jyk7XG59KTtcblxudGVzdCgncGFyc2VSb2FkbWFwOiBtaXNzaW5nIHJpc2sgZGVmYXVsdHMgdG8gbG93JywgKCkgPT4ge1xuICBjb25zdCBjb250ZW50ID0gYCMgTTAwODogRGVmYXVsdCBSaXNrXG5cbioqVmlzaW9uOioqIFRlc3QgZGVmYXVsdCByaXNrLlxuXG4jIyBTbGljZXNcblxuLSBbIF0gKipTMDE6IE5vIFJpc2sgVGFnKiogXFxgZGVwZW5kczpbXVxcYFxuICA+IEFmdGVyIHRoaXM6IGRvbmUuXG5gO1xuXG4gIGNvbnN0IHIgPSBwYXJzZVJvYWRtYXAoY29udGVudCk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoci5zbGljZXMubGVuZ3RoLCAxLCAnb25lIHNsaWNlJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoci5zbGljZXNbMF0ucmlzaywgJ2xvdycsICdkZWZhdWx0IHJpc2sgaXMgbG93Jyk7XG59KTtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBwYXJzZVBsYW4gdGVzdHNcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxudGVzdCgncGFyc2VQbGFuOiBmdWxsIHBsYW4nLCAoKSA9PiB7XG4gIGNvbnN0IGNvbnRlbnQgPSBgLS0tXG5lc3RpbWF0ZWRfc3RlcHM6IDZcbmVzdGltYXRlZF9maWxlczogM1xuc2tpbGxzX3VzZWQ6XG4gIC0gdHlwZXNjcmlwdFxuICAtIHRlc3Rpbmdcbi0tLVxuXG4jIFMwMTogUGFyc2VyIFRlc3QgU3VpdGVcblxuKipHb2FsOioqIEFsbCA1IHBhcnNlcnMgaGF2ZSB0ZXN0IGNvdmVyYWdlIHdpdGggZWRnZSBjYXNlcy5cbioqRGVtbzoqKiBcXGBub2RlIC0tdGVzdCB0ZXN0cy9wYXJzZXJzLnRlc3QudHNcXGAgcGFzc2VzIHdpdGggemVybyBmYWlsdXJlcy5cblxuIyMgTXVzdC1IYXZlc1xuXG4tIHBhcnNlUm9hZG1hcCB0ZXN0cyBjb3ZlciBoYXBweSBwYXRoIGFuZCBlZGdlIGNhc2VzXG4tIHBhcnNlUGxhbiB0ZXN0cyBjb3ZlciBoYXBweSBwYXRoIGFuZCBlZGdlIGNhc2VzXG4tIEFsbCBleGlzdGluZyB0ZXN0cyBzdGlsbCBwYXNzXG5cbiMjIFRhc2tzXG5cbi0gWyBdICoqVDAxOiBUZXN0IHBhcnNlUm9hZG1hcCBhbmQgcGFyc2VQbGFuKiogXFxgZXN0OjQ1bVxcYFxuICBDcmVhdGUgdGVzdHMvcGFyc2Vycy50ZXN0LnRzIHdpdGggY29tcHJlaGVuc2l2ZSB0ZXN0cyBmb3IgdGhlIHR3byBtb3N0IGNvbXBsZXggcGFyc2Vycy5cblxuLSBbeF0gKipUMDI6IFRlc3QgcGFyc2VTdW1tYXJ5IGFuZCBwYXJzZUNvbnRpbnVlKiogXFxgZXN0OjM1bVxcYFxuICBFeHRlbmQgdGVzdHMvcGFyc2Vycy50ZXN0LnRzIHdpdGggdGVzdHMgZm9yIHRoZSByZW1haW5pbmcgcGFyc2Vycy5cblxuIyMgRmlsZXMgTGlrZWx5IFRvdWNoZWRcblxuLSBcXGB0ZXN0cy9wYXJzZXJzLnRlc3QudHNcXGAgXHUyMDE0IG5ldyB0ZXN0IGZpbGVcbi0gXFxgdHlwZXMudHNcXGAgXHUyMDE0IGFkZCBvYnNlcnZhYmlsaXR5X3N1cmZhY2VzXG4tIFxcYGZpbGVzLnRzXFxgIFx1MjAxNCB1cGRhdGUgcGFyc2VTdW1tYXJ5XG5gO1xuXG4gIGNvbnN0IHRhc2tQbGFuID0gcGFyc2VUYXNrUGxhbkZpbGUoY29udGVudCk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwodGFza1BsYW4uZnJvbnRtYXR0ZXIuZXN0aW1hdGVkX3N0ZXBzLCA2LCAndGFzayBwbGFuIGZyb250bWF0dGVyIGVzdGltYXRlZF9zdGVwcycpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHRhc2tQbGFuLmZyb250bWF0dGVyLmVzdGltYXRlZF9maWxlcywgMywgJ3Rhc2sgcGxhbiBmcm9udG1hdHRlciBlc3RpbWF0ZWRfZmlsZXMnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbCh0YXNrUGxhbi5mcm9udG1hdHRlci5za2lsbHNfdXNlZC5sZW5ndGgsIDIsICd0YXNrIHBsYW4gZnJvbnRtYXR0ZXIgc2tpbGxzX3VzZWQgY291bnQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbCh0YXNrUGxhbi5mcm9udG1hdHRlci5za2lsbHNfdXNlZFswXSwgJ3R5cGVzY3JpcHQnLCAnZmlyc3QgdGFzayBwbGFuIHNraWxsJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwodGFza1BsYW4uZnJvbnRtYXR0ZXIuc2tpbGxzX3VzZWRbMV0sICd0ZXN0aW5nJywgJ3NlY29uZCB0YXNrIHBsYW4gc2tpbGwnKTtcblxuICBjb25zdCBwID0gcGFyc2VQbGFuKGNvbnRlbnQpO1xuXG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocC5pZCwgJ1MwMScsICdwbGFuIGlkJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocC50aXRsZSwgJ1BhcnNlciBUZXN0IFN1aXRlJywgJ3BsYW4gdGl0bGUnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwLmdvYWwsICdBbGwgNSBwYXJzZXJzIGhhdmUgdGVzdCBjb3ZlcmFnZSB3aXRoIGVkZ2UgY2FzZXMuJywgJ3BsYW4gZ29hbCcpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHAuZGVtbywgJ2Bub2RlIC0tdGVzdCB0ZXN0cy9wYXJzZXJzLnRlc3QudHNgIHBhc3NlcyB3aXRoIHplcm8gZmFpbHVyZXMuJywgJ3BsYW4gZGVtbycpO1xuXG4gIC8vIE11c3QtaGF2ZXNcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwLm11c3RIYXZlcy5sZW5ndGgsIDMsICdtdXN0LWhhdmUgY291bnQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwLm11c3RIYXZlc1swXSwgJ3BhcnNlUm9hZG1hcCB0ZXN0cyBjb3ZlciBoYXBweSBwYXRoIGFuZCBlZGdlIGNhc2VzJywgJ2ZpcnN0IG11c3QtaGF2ZScpO1xuXG4gIC8vIFRhc2tzXG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocC50YXNrcy5sZW5ndGgsIDIsICd0YXNrIGNvdW50Jyk7XG5cbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwLnRhc2tzWzBdLmlkLCAnVDAxJywgJ1QwMSBpZCcpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHAudGFza3NbMF0udGl0bGUsICdUZXN0IHBhcnNlUm9hZG1hcCBhbmQgcGFyc2VQbGFuJywgJ1QwMSB0aXRsZScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHAudGFza3NbMF0uZG9uZSwgZmFsc2UsICdUMDEgbm90IGRvbmUnKTtcbiAgYXNzZXJ0Lm9rKHAudGFza3NbMF0uZGVzY3JpcHRpb24uaW5jbHVkZXMoJ2NvbXByZWhlbnNpdmUgdGVzdHMnKSwgJ1QwMSBkZXNjcmlwdGlvbiBjb250ZW50Jyk7XG5cbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwLnRhc2tzWzFdLmlkLCAnVDAyJywgJ1QwMiBpZCcpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHAudGFza3NbMV0udGl0bGUsICdUZXN0IHBhcnNlU3VtbWFyeSBhbmQgcGFyc2VDb250aW51ZScsICdUMDIgdGl0bGUnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwLnRhc2tzWzFdLmRvbmUsIHRydWUsICdUMDIgZG9uZScpO1xuXG4gIC8vIEZpbGVzIGxpa2VseSB0b3VjaGVkXG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocC5maWxlc0xpa2VseVRvdWNoZWQubGVuZ3RoLCAzLCAnZmlsZXMgbGlrZWx5IHRvdWNoZWQgY291bnQnKTtcbiAgYXNzZXJ0Lm9rKHAuZmlsZXNMaWtlbHlUb3VjaGVkWzBdLmluY2x1ZGVzKCd0ZXN0cy9wYXJzZXJzLnRlc3QudHMnKSwgJ2ZpcnN0IGZpbGUnKTtcbn0pO1xuXG50ZXN0KCdwYXJzZVRhc2tQbGFuRmlsZTogZGVmYXVsdHMgbWlzc2luZyBmcm9udG1hdHRlciBmaWVsZHMnLCAoKSA9PiB7XG4gIGNvbnN0IGNvbnRlbnQgPSBgIyBUMDE6IE1pbmltYWwgdGFzayBwbGFuXG5cbiMjIERlc2NyaXB0aW9uXG5cbk5vIGZyb250bWF0dGVyIGhlcmUuXG5gO1xuXG4gIGNvbnN0IHRhc2tQbGFuID0gcGFyc2VUYXNrUGxhbkZpbGUoY29udGVudCk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwodGFza1BsYW4uZnJvbnRtYXR0ZXIuZXN0aW1hdGVkX3N0ZXBzLCB1bmRlZmluZWQsICdlc3RpbWF0ZWRfc3RlcHMgZGVmYXVsdHMgdW5kZWZpbmVkJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwodGFza1BsYW4uZnJvbnRtYXR0ZXIuZXN0aW1hdGVkX2ZpbGVzLCB1bmRlZmluZWQsICdlc3RpbWF0ZWRfZmlsZXMgZGVmYXVsdHMgdW5kZWZpbmVkJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwodGFza1BsYW4uZnJvbnRtYXR0ZXIuc2tpbGxzX3VzZWQubGVuZ3RoLCAwLCAnc2tpbGxzX3VzZWQgZGVmYXVsdHMgZW1wdHkgYXJyYXknKTtcbn0pO1xuXG50ZXN0KCdwYXJzZVRhc2tQbGFuRmlsZTogYWNjZXB0cyBzY2FsYXIgc2tpbGxzX3VzZWQgYW5kIG51bWVyaWMgc3RyaW5ncycsICgpID0+IHtcbiAgY29uc3QgY29udGVudCA9IGAtLS1cbmVzdGltYXRlZF9zdGVwczogXCI5XCJcbmVzdGltYXRlZF9maWxlczogXCI0XCJcbnNraWxsc191c2VkOiByZWFjdC1iZXN0LXByYWN0aWNlc1xuLS0tXG5cbiMgVDAyOiBTY2FsYXIgc2tpbGwgaGFuZG9mZlxuYDtcblxuICBjb25zdCB0YXNrUGxhbiA9IHBhcnNlVGFza1BsYW5GaWxlKGNvbnRlbnQpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHRhc2tQbGFuLmZyb250bWF0dGVyLmVzdGltYXRlZF9zdGVwcywgOSwgJ3N0cmluZyBlc3RpbWF0ZWRfc3RlcHMgcGFyc2VkJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwodGFza1BsYW4uZnJvbnRtYXR0ZXIuZXN0aW1hdGVkX2ZpbGVzLCA0LCAnc3RyaW5nIGVzdGltYXRlZF9maWxlcyBwYXJzZWQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbCh0YXNrUGxhbi5mcm9udG1hdHRlci5za2lsbHNfdXNlZC5sZW5ndGgsIDEsICdzY2FsYXIgc2tpbGxzX3VzZWQgbm9ybWFsaXplZCB0byBhcnJheScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHRhc2tQbGFuLmZyb250bWF0dGVyLnNraWxsc191c2VkWzBdLCAncmVhY3QtYmVzdC1wcmFjdGljZXMnLCAnc2NhbGFyIHNraWxsIHByZXNlcnZlZCcpO1xufSk7XG5cbnRlc3QoJ3BhcnNlVGFza1BsYW5GaWxlOiBmaWx0ZXJzIGJsYW5rIHNraWxsc191c2VkIGl0ZW1zJywgKCkgPT4ge1xuICBjb25zdCBjb250ZW50ID0gYC0tLVxuc2tpbGxzX3VzZWQ6XG4gIC0gcmVhY3RcbiAgLVxuICAtIHRlc3Rpbmdcbi0tLVxuXG4jIFQwMzogQmxhbmsgc2tpbGxzIGZpbHRlcmVkXG5gO1xuXG4gIGNvbnN0IHRhc2tQbGFuID0gcGFyc2VUYXNrUGxhbkZpbGUoY29udGVudCk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwodGFza1BsYW4uZnJvbnRtYXR0ZXIuc2tpbGxzX3VzZWQubGVuZ3RoLCAyLCAnYmxhbmsgc2tpbGwgZW50cmllcyByZW1vdmVkJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwodGFza1BsYW4uZnJvbnRtYXR0ZXIuc2tpbGxzX3VzZWRbMF0sICdyZWFjdCcsICdmaXJzdCByZW1haW5pbmcgc2tpbGwnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbCh0YXNrUGxhbi5mcm9udG1hdHRlci5za2lsbHNfdXNlZFsxXSwgJ3Rlc3RpbmcnLCAnc2Vjb25kIHJlbWFpbmluZyBza2lsbCcpO1xufSk7XG5cbnRlc3QoJ3BhcnNlVGFza1BsYW5GaWxlOiBpbnZhbGlkIG51bWVyaWMgZnJvbnRtYXR0ZXIgaWdub3JlZCcsICgpID0+IHtcbiAgY29uc3QgY29udGVudCA9IGAtLS1cbmVzdGltYXRlZF9zdGVwczogbWFueVxuZXN0aW1hdGVkX2ZpbGVzOiB1bmtub3duXG4tLS1cblxuIyBUMDQ6IEludmFsaWQgZXN0aW1hdGVzXG5gO1xuXG4gIGNvbnN0IHRhc2tQbGFuID0gcGFyc2VUYXNrUGxhbkZpbGUoY29udGVudCk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwodGFza1BsYW4uZnJvbnRtYXR0ZXIuZXN0aW1hdGVkX3N0ZXBzLCB1bmRlZmluZWQsICdpbnZhbGlkIGVzdGltYXRlZF9zdGVwcyBpZ25vcmVkJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwodGFza1BsYW4uZnJvbnRtYXR0ZXIuZXN0aW1hdGVkX2ZpbGVzLCB1bmRlZmluZWQsICdpbnZhbGlkIGVzdGltYXRlZF9maWxlcyBpZ25vcmVkJyk7XG59KTtcblxudGVzdCgncGFyc2VUYXNrUGxhbkZpbGU6IHBhcnNlUGxhbiBpZ25vcmVzIHRhc2stcGxhbiBmcm9udG1hdHRlcicsICgpID0+IHtcbiAgY29uc3QgY29udGVudCA9IGAtLS1cbmVzdGltYXRlZF9zdGVwczogMlxuZXN0aW1hdGVkX2ZpbGVzOiAxXG5za2lsbHNfdXNlZDpcbiAgLSByZWFjdFxuLS0tXG5cbiMgUzExOiBGcm9udG1hdHRlciBDb21wYXRpYmxlXG5cbioqR29hbDoqKiBQbGFuIHBhcnNlciBpZ25vcmVzIHRhc2stcGxhbiBoYW5kb2ZmIG1ldGFkYXRhLlxuKipEZW1vOioqIFNsaWNlIGNvbnRlbnQgc3RpbGwgcGFyc2VzLlxuXG4jIyBUYXNrc1xuXG4tIFsgXSAqKlQwMTogQ29tcGF0aWJsZSB0YXNrKiogXFxgZXN0OjVtXFxgXG4gIERlc2NyaXB0aW9uLlxuYDtcblxuICBjb25zdCBwID0gcGFyc2VQbGFuKGNvbnRlbnQpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHAuaWQsICdTMTEnLCAncGxhbiBpZCBzdGlsbCBwYXJzZWQgd2l0aCBmcm9udG1hdHRlcicpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHAudGFza3MubGVuZ3RoLCAxLCAndGFzayBzdGlsbCBwYXJzZWQgd2l0aCBmcm9udG1hdHRlcicpO1xufSk7XG5cbnRlc3QoJ3BhcnNlUGxhbjogbXVsdGktbGluZSB0YXNrIGRlc2NyaXB0aW9uIGNvbmNhdGVuYXRpb24nLCAoKSA9PiB7XG4gIGNvbnN0IGNvbnRlbnQgPSBgIyBTMDI6IE11bHRpLWxpbmUgVGVzdFxuXG4qKkdvYWw6KiogVGVzdCBtdWx0aS1saW5lIGRlc2NyaXB0aW9ucy5cbioqRGVtbzoqKiBEZXNjcmlwdGlvbnMgYXJlIGNvbmNhdGVuYXRlZC5cblxuIyMgTXVzdC1IYXZlc1xuXG4tIE11bHRpLWxpbmUgd29ya3NcblxuIyMgVGFza3NcblxuLSBbIF0gKipUMDE6IE11bHRpLWxpbmUgVGFzayoqIFxcYGVzdDozMG1cXGBcbiAgRmlyc3QgbGluZSBvZiBkZXNjcmlwdGlvbi5cbiAgU2Vjb25kIGxpbmUgb2YgZGVzY3JpcHRpb24uXG4gIFRoaXJkIGxpbmUgb2YgZGVzY3JpcHRpb24uXG5cbi0gWyBdICoqVDAyOiBTaW5nbGUgTGluZSoqIFxcYGVzdDoxMG1cXGBcbiAgSnVzdCBvbmUgbGluZS5cblxuIyMgRmlsZXMgTGlrZWx5IFRvdWNoZWRcblxuLSBcXGBmb28udHNcXGBcbmA7XG5cbiAgY29uc3QgcCA9IHBhcnNlUGxhbihjb250ZW50KTtcblxuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHAudGFza3MubGVuZ3RoLCAyLCAndHdvIHRhc2tzJyk7XG4gIGFzc2VydC5vayhwLnRhc2tzWzBdLmRlc2NyaXB0aW9uLmluY2x1ZGVzKCdGaXJzdCBsaW5lJyksICdUMDEgZGVzYyBoYXMgZmlyc3QgbGluZScpO1xuICBhc3NlcnQub2socC50YXNrc1swXS5kZXNjcmlwdGlvbi5pbmNsdWRlcygnU2Vjb25kIGxpbmUnKSwgJ1QwMSBkZXNjIGhhcyBzZWNvbmQgbGluZScpO1xuICBhc3NlcnQub2socC50YXNrc1swXS5kZXNjcmlwdGlvbi5pbmNsdWRlcygnVGhpcmQgbGluZScpLCAnVDAxIGRlc2MgaGFzIHRoaXJkIGxpbmUnKTtcbiAgYXNzZXJ0Lm9rKHAudGFza3NbMF0uZGVzY3JpcHRpb24uaW5jbHVkZXMoJ2Rlc2NyaXB0aW9uLiBTZWNvbmQnKSwgJ2xpbmVzIGpvaW5lZCB3aXRoIHNwYWNlJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocC50YXNrc1sxXS5kZXNjcmlwdGlvbiwgJ0p1c3Qgb25lIGxpbmUuJywgJ1QwMiBzaW5nbGUtbGluZSBkZXNjJyk7XG59KTtcblxudGVzdCgncGFyc2VQbGFuOiBmcm9udG1hdHRlciBkb2VzIG5vdCBwb2xsdXRlIHRhc2sgZGVzY3JpcHRpb25zJywgKCkgPT4ge1xuICBjb25zdCBjb250ZW50ID0gYC0tLVxuZXN0aW1hdGVkX3N0ZXBzOiAyXG5lc3RpbWF0ZWRfZmlsZXM6IDFcbnNraWxsc191c2VkOlxuICAtIHJlYWN0XG4tLS1cblxuIyBTMTI6IEZyb250bWF0dGVyICsgbXVsdGlsaW5lXG5cbiMjIFRhc2tzXG5cbi0gWyBdICoqVDAxOiBNdWx0aS1saW5lIFRhc2sqKiBcXGBlc3Q6MzBtXFxgXG4gIEZpcnN0IGxpbmUgb2YgZGVzY3JpcHRpb24uXG4gIFNlY29uZCBsaW5lIG9mIGRlc2NyaXB0aW9uLlxuYDtcblxuICBjb25zdCBwID0gcGFyc2VQbGFuKGNvbnRlbnQpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHAudGFza3MubGVuZ3RoLCAxLCAnb25lIHRhc2sgcGFyc2VkIHdpdGggZnJvbnRtYXR0ZXInKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwLnRhc2tzWzBdLmRlc2NyaXB0aW9uLCAnRmlyc3QgbGluZSBvZiBkZXNjcmlwdGlvbi4gU2Vjb25kIGxpbmUgb2YgZGVzY3JpcHRpb24uJywgJ2Zyb250bWF0dGVyIGV4Y2x1ZGVkIGZyb20gZGVzY3JpcHRpb24nKTtcbn0pO1xuXG50ZXN0KCdwYXJzZVBsYW46IHRhc2sgd2l0aCBtaXNzaW5nIGVzdGltYXRlJywgKCkgPT4ge1xuICBjb25zdCBjb250ZW50ID0gYCMgUzAzOiBObyBFc3RpbWF0ZVxuXG4qKkdvYWw6KiogSGFuZGxlIHRhc2tzIHdpdGhvdXQgZXN0aW1hdGVzLlxuKipEZW1vOioqIFBhcnNlciBkb2Vzbid0IGNyYXNoLlxuXG4jIyBUYXNrc1xuXG4tIFsgXSAqKlQwMTogTm8gRXN0aW1hdGUgVGFzayoqXG4gIEEgdGFzayB3aXRob3V0IGFuIGVzdGltYXRlIGJhY2t0aWNrLlxuXG4tIFsgXSAqKlQwMjogSGFzIEVzdGltYXRlKiogXFxgZXN0OjIwbVxcYFxuICBUaGlzIG9uZSBoYXMgYW4gZXN0aW1hdGUuXG5gO1xuXG4gIGNvbnN0IHAgPSBwYXJzZVBsYW4oY29udGVudCk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocC50YXNrcy5sZW5ndGgsIDIsICd0d28gdGFza3MgcGFyc2VkJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocC50YXNrc1swXS5pZCwgJ1QwMScsICdUMDEgaWQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwLnRhc2tzWzBdLnRpdGxlLCAnTm8gRXN0aW1hdGUgVGFzaycsICdUMDEgdGl0bGUgd2l0aG91dCBlc3RpbWF0ZScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHAudGFza3NbMF0uZG9uZSwgZmFsc2UsICdUMDEgbm90IGRvbmUnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwLnRhc2tzWzFdLmlkLCAnVDAyJywgJ1QwMiBpZCcpO1xufSk7XG5cbnRlc3QoJ3BhcnNlUGxhbjogZW1wdHkgdGFza3Mgc2VjdGlvbicsICgpID0+IHtcbiAgY29uc3QgY29udGVudCA9IGAjIFMwNDogRW1wdHkgVGFza3NcblxuKipHb2FsOioqIE5vIHRhc2tzIHlldC5cbioqRGVtbzoqKiBOb3RoaW5nLlxuXG4jIyBNdXN0LUhhdmVzXG5cbi0gU29tZXRoaW5nXG5cbiMjIFRhc2tzXG5cbiMjIEZpbGVzIExpa2VseSBUb3VjaGVkXG5cbi0gXFxgbm90aGluZy50c1xcYFxuYDtcblxuICBjb25zdCBwID0gcGFyc2VQbGFuKGNvbnRlbnQpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHAuaWQsICdTMDQnLCAncGxhbiBpZCB3aXRoIGVtcHR5IHRhc2tzJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocC50YXNrcy5sZW5ndGgsIDAsICdubyB0YXNrcycpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHAubXVzdEhhdmVzLmxlbmd0aCwgMSwgJ29uZSBtdXN0LWhhdmUnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwLmZpbGVzTGlrZWx5VG91Y2hlZC5sZW5ndGgsIDEsICdvbmUgZmlsZScpO1xufSk7XG5cbnRlc3QoJ3BhcnNlUGxhbjogbm8gSDEnLCAoKSA9PiB7XG4gIGNvbnN0IGNvbnRlbnQgPSBgKipHb2FsOioqIEEgcGxhbiB3aXRob3V0IGEgaGVhZGluZy5cbioqRGVtbzoqKiBTdGlsbCBwYXJzZXMuXG5cbiMjIFRhc2tzXG5cbi0gWyBdICoqVDAxOiBPcnBoYW4gVGFzayoqIFxcYGVzdDo1bVxcYFxuICBBIHRhc2sgaW4gYSBoZWFkaW5nbGVzcyBwbGFuLlxuYDtcblxuICBjb25zdCBwID0gcGFyc2VQbGFuKGNvbnRlbnQpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHAuaWQsICcnLCAnZW1wdHkgaWQgd2l0aG91dCBIMScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHAudGl0bGUsICcnLCAnZW1wdHkgdGl0bGUgd2l0aG91dCBIMScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHAuZ29hbCwgJ0EgcGxhbiB3aXRob3V0IGEgaGVhZGluZy4nLCAnZ29hbCBzdGlsbCBwYXJzZWQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwLnRhc2tzLmxlbmd0aCwgMSwgJ3Rhc2sgc3RpbGwgcGFyc2VkJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocC50YXNrc1swXS5pZCwgJ1QwMScsICd0YXNrIGlkJyk7XG59KTtcblxudGVzdCgncGFyc2VQbGFuOiB0YXNrIGVzdGltYXRlIGJhY2t0aWNrIGluIGRlc2NyaXB0aW9uJywgKCkgPT4ge1xuICBjb25zdCBjb250ZW50ID0gYCMgUzA1OiBFc3RpbWF0ZSBIYW5kbGluZ1xuXG4qKkdvYWw6KiogVGVzdCBlc3RpbWF0ZSB0ZXh0IGhhbmRsaW5nLlxuKipEZW1vOioqIFdvcmtzLlxuXG4jIyBUYXNrc1xuXG4tIFsgXSAqKlQwMTogV2l0aCBFc3RpbWF0ZSoqIFxcYGVzdDo0NW1cXGBcbiAgTWFpbiBkZXNjcmlwdGlvbiBoZXJlLlxuYDtcblxuICBjb25zdCBwID0gcGFyc2VQbGFuKGNvbnRlbnQpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHAudGFza3MubGVuZ3RoLCAxLCAnb25lIHRhc2snKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwLnRhc2tzWzBdLmlkLCAnVDAxJywgJ3Rhc2sgaWQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwLnRhc2tzWzBdLnRpdGxlLCAnV2l0aCBFc3RpbWF0ZScsICd0aXRsZSBleGNsdWRlcyBlc3RpbWF0ZScpO1xuICBhc3NlcnQub2socC50YXNrc1swXS5kZXNjcmlwdGlvbi5pbmNsdWRlcygnTWFpbiBkZXNjcmlwdGlvbicpLCAnZGVzY3JpcHRpb24gZnJvbSBjb250aW51YXRpb24gbGluZScpO1xufSk7XG5cbnRlc3QoJ3BhcnNlUGxhbjogdXBwZXJjYXNlIFggZm9yIGRvbmUnLCAoKSA9PiB7XG4gIGNvbnN0IGNvbnRlbnQgPSBgIyBTMDY6IENhc2UgVGVzdFxuXG4qKkdvYWw6KiogVGVzdCBjYXNlLlxuKipEZW1vOioqIFdvcmtzLlxuXG4jIyBUYXNrc1xuXG4tIFtYXSAqKlQwMTogVXBwZXJjYXNlIERvbmUqKiBcXGBlc3Q6NW1cXGBcbiAgRG9uZSB3aXRoIHVwcGVyY2FzZSBYLlxuXG4tIFt4XSAqKlQwMjogTG93ZXJjYXNlIERvbmUqKiBcXGBlc3Q6NW1cXGBcbiAgRG9uZSB3aXRoIGxvd2VyY2FzZSB4LlxuYDtcblxuICBjb25zdCBwID0gcGFyc2VQbGFuKGNvbnRlbnQpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHAudGFza3NbMF0uZG9uZSwgdHJ1ZSwgJ3VwcGVyY2FzZSBYIGlzIGRvbmUnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwLnRhc2tzWzFdLmRvbmUsIHRydWUsICdsb3dlcmNhc2UgeCBpcyBkb25lJyk7XG59KTtcblxudGVzdCgncGFyc2VQbGFuOiBubyBNdXN0LUhhdmVzIHNlY3Rpb24nLCAoKSA9PiB7XG4gIGNvbnN0IGNvbnRlbnQgPSBgIyBTMDc6IE5vIE11c3QtSGF2ZXNcblxuKipHb2FsOioqIFRlc3QgbWlzc2luZyBtdXN0LWhhdmVzLlxuKipEZW1vOioqIFBhcnNlciBoYW5kbGVzIGl0LlxuXG4jIyBUYXNrc1xuXG4tIFsgXSAqKlQwMTogT25seSBUYXNrKiogXFxgZXN0OjEwbVxcYFxuICBUaGUgb25seSB0YXNrLlxuYDtcblxuICBjb25zdCBwID0gcGFyc2VQbGFuKGNvbnRlbnQpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHAubXVzdEhhdmVzLmxlbmd0aCwgMCwgJ2VtcHR5IG11c3QtaGF2ZXMnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwLnRhc2tzLmxlbmd0aCwgMSwgJ3Rhc2sgc3RpbGwgcGFyc2VkJyk7XG59KTtcblxudGVzdCgncGFyc2VQbGFuOiBubyBGaWxlcyBMaWtlbHkgVG91Y2hlZCBzZWN0aW9uJywgKCkgPT4ge1xuICBjb25zdCBjb250ZW50ID0gYCMgUzA4OiBObyBGaWxlc1xuXG4qKkdvYWw6KiogVGVzdCBtaXNzaW5nIGZpbGVzIHNlY3Rpb24uXG4qKkRlbW86KiogUGFyc2VyIGhhbmRsZXMgaXQuXG5cbiMjIFRhc2tzXG5cbi0gWyBdICoqVDAxOiBUYXNrKiogXFxgZXN0OjEwbVxcYFxuICBEZXNjcmlwdGlvbi5cbmA7XG5cbiAgY29uc3QgcCA9IHBhcnNlUGxhbihjb250ZW50KTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwLmZpbGVzTGlrZWx5VG91Y2hlZC5sZW5ndGgsIDAsICdlbXB0eSBmaWxlcyBsaWtlbHkgdG91Y2hlZCcpO1xufSk7XG5cbnRlc3QoJ3BhcnNlUGxhbjogb2xkLWZvcm1hdCB0YXNrIGVudHJpZXMgKG5vIHN1YmxpbmVzKScsICgpID0+IHtcbiAgY29uc3QgY29udGVudCA9IGAjIFMwOTogT2xkIEZvcm1hdFxuXG4qKkdvYWw6KiogVGVzdCBvbGQtZm9ybWF0IGNvbXBhdGliaWxpdHkuXG4qKkRlbW86KiogUGFyc2VyIGhhbmRsZXMgZW50cmllcyB3aXRob3V0IHN1YmxpbmVzLlxuXG4jIyBUYXNrc1xuXG4tIFsgXSAqKlQwMTogQ2xhc3NpYyBUYXNrKiogXFxgZXN0OjEwbVxcYFxuICBKdXN0IGEgcGxhaW4gZGVzY3JpcHRpb24gd2l0aCBubyBsYWJlbGVkIHN1YmxpbmVzLlxuYDtcblxuICBjb25zdCBwID0gcGFyc2VQbGFuKGNvbnRlbnQpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHAudGFza3MubGVuZ3RoLCAxLCAnb25lIHRhc2sgcGFyc2VkJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocC50YXNrc1swXS5pZCwgJ1QwMScsICd0YXNrIGlkJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocC50YXNrc1swXS50aXRsZSwgJ0NsYXNzaWMgVGFzaycsICd0YXNrIHRpdGxlJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocC50YXNrc1swXS5kb25lLCBmYWxzZSwgJ3Rhc2sgbm90IGRvbmUnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwLnRhc2tzWzBdLmZpbGVzLCB1bmRlZmluZWQsICdmaWxlcyBpcyB1bmRlZmluZWQgZm9yIG9sZC1mb3JtYXQgZW50cnknKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwLnRhc2tzWzBdLnZlcmlmeSwgdW5kZWZpbmVkLCAndmVyaWZ5IGlzIHVuZGVmaW5lZCBmb3Igb2xkLWZvcm1hdCBlbnRyeScpO1xufSk7XG5cbnRlc3QoJ3BhcnNlUGxhbjogbmV3LWZvcm1hdCB0YXNrIGVudHJpZXMgd2l0aCBGaWxlcyBhbmQgVmVyaWZ5IHN1YmxpbmVzJywgKCkgPT4ge1xuICBjb25zdCBjb250ZW50ID0gYCMgUzEwOiBOZXcgRm9ybWF0XG5cbioqR29hbDoqKiBUZXN0IG5ldy1mb3JtYXQgc3VibGluZSBleHRyYWN0aW9uLlxuKipEZW1vOioqIFBhcnNlciBleHRyYWN0cyBGaWxlcyBhbmQgVmVyaWZ5IGNvcnJlY3RseS5cblxuIyMgVGFza3NcblxuLSBbIF0gKipUMDE6IE1vZGVybiBUYXNrKiogXFxgZXN0OjE1bVxcYFxuICAtIFdoeTogYmVjYXVzZSB3ZSBuZWVkIHR5cGVkIHBsYW4gZW50cmllc1xuICAtIEZpbGVzOiBcXGB0eXBlcy50c1xcYCwgXFxgZmlsZXMudHNcXGBcbiAgLSBWZXJpZnk6IHJ1biB0aGUgdGVzdCBzdWl0ZVxuYDtcblxuICBjb25zdCBwID0gcGFyc2VQbGFuKGNvbnRlbnQpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHAudGFza3MubGVuZ3RoLCAxLCAnb25lIHRhc2sgcGFyc2VkJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocC50YXNrc1swXS5pZCwgJ1QwMScsICd0YXNrIGlkJyk7XG4gIGFzc2VydC5vayhBcnJheS5pc0FycmF5KHAudGFza3NbMF0uZmlsZXMpLCAnZmlsZXMgaXMgYW4gYXJyYXknKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwLnRhc2tzWzBdLmZpbGVzIS5sZW5ndGgsIDIsICdmaWxlcyBhcnJheSBoYXMgdHdvIGVudHJpZXMnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwLnRhc2tzWzBdLmZpbGVzIVswXSwgJ3R5cGVzLnRzJywgJ2ZpcnN0IGZpbGUgaXMgdHlwZXMudHMnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwLnRhc2tzWzBdLmZpbGVzIVsxXSwgJ2ZpbGVzLnRzJywgJ3NlY29uZCBmaWxlIGlzIGZpbGVzLnRzJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocC50YXNrc1swXS52ZXJpZnksICdydW4gdGhlIHRlc3Qgc3VpdGUnLCAndmVyaWZ5IHN0cmluZyBleHRyYWN0ZWQgY29ycmVjdGx5Jyk7XG4gIGFzc2VydC5vayhwLnRhc2tzWzBdLmRlc2NyaXB0aW9uLmluY2x1ZGVzKCdXaHk6IGJlY2F1c2Ugd2UgbmVlZCB0eXBlZCBwbGFuIGVudHJpZXMnKSwgJ1doeSBsaW5lIGFjY3VtdWxhdGVzIGludG8gZGVzY3JpcHRpb24nKTtcbn0pO1xuXG50ZXN0KCdwYXJzZVBsYW46IGhlYWRpbmctc3R5bGUgdGFzayBlbnRyaWVzICgjIyMgVDAxIC0tIFRpdGxlKScsICgpID0+IHtcbiAgY29uc3QgY29udGVudCA9IGAjIFMxMTogSGVhZGluZyBTdHlsZVxuXG4qKkdvYWw6KiogVGVzdCBoZWFkaW5nLXN0eWxlIHRhc2sgcGFyc2luZy5cbioqRGVtbzoqKiBQYXJzZXIgaGFuZGxlcyBoZWFkaW5nLXN0eWxlIHRhc2sgZW50cmllcy5cblxuIyMgVGFza3NcblxuIyMjIFQwMSAtLSBJbXBsZW1lbnQgZmVhdHVyZVxuXG4tIFdoeTogdGhlIGZlYXR1cmUgaXMgbmVlZGVkXG4tIEZpbGVzOiBcXGBzcmMvZmVhdHVyZS50c1xcYFxuLSBWZXJpZnk6IG5wbSB0ZXN0XG5cbiMjIyBUMDIgLS0gV3JpdGUgdGVzdHMgXFxgZXN0OjFoXFxgXG5cblNvbWUgZGVzY3JpcHRpb24gZm9yIHRoZSBzZWNvbmQgdGFzay5cbmA7XG5cbiAgY29uc3QgcCA9IHBhcnNlUGxhbihjb250ZW50KTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwLnRhc2tzLmxlbmd0aCwgMiwgJ2hlYWRpbmctc3R5bGUgdGFzayBjb3VudCcpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHAudGFza3NbMF0uaWQsICdUMDEnLCAnaGVhZGluZyBUMDEgaWQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwLnRhc2tzWzBdLnRpdGxlLCAnSW1wbGVtZW50IGZlYXR1cmUnLCAnaGVhZGluZyBUMDEgdGl0bGUnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwLnRhc2tzWzBdLmRvbmUsIGZhbHNlLCAnaGVhZGluZyBUMDEgbm90IGRvbmUgKGhlYWRpbmdzIGhhdmUgbm8gY2hlY2tib3gpJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocC50YXNrc1swXS5maWxlcyFbMF0sICdzcmMvZmVhdHVyZS50cycsICdoZWFkaW5nIFQwMSBmaWxlcyBleHRyYWN0ZWQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwLnRhc2tzWzBdLnZlcmlmeSwgJ25wbSB0ZXN0JywgJ2hlYWRpbmcgVDAxIHZlcmlmeSBleHRyYWN0ZWQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwLnRhc2tzWzFdLmlkLCAnVDAyJywgJ2hlYWRpbmcgVDAyIGlkJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocC50YXNrc1sxXS50aXRsZSwgJ1dyaXRlIHRlc3RzJywgJ2hlYWRpbmcgVDAyIHRpdGxlJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocC50YXNrc1sxXS5lc3RpbWF0ZSwgJzFoJywgJ2hlYWRpbmcgVDAyIGVzdGltYXRlJyk7XG4gIGFzc2VydC5vayhwLnRhc2tzWzFdLmRlc2NyaXB0aW9uLmluY2x1ZGVzKCdTb21lIGRlc2NyaXB0aW9uJyksICdoZWFkaW5nIFQwMiBkZXNjcmlwdGlvbicpO1xufSk7XG5cbnRlc3QoJ3BhcnNlUGxhbjogaGVhZGluZy1zdHlsZSB3aXRoIGNvbG9uIHNlcGFyYXRvciAoIyMjIFQwMTogVGl0bGUpJywgKCkgPT4ge1xuICBjb25zdCBjb250ZW50ID0gYCMgUzEyOiBIZWFkaW5nIENvbG9uIFN0eWxlXG5cbioqR29hbDoqKiBUZXN0IGNvbG9uLXNlcGFyYXRlZCBoZWFkaW5nIHRhc2tzLlxuKipEZW1vOioqIFBhcnNlciBoYW5kbGVzIGNvbG9uIHNlcGFyYXRvci5cblxuIyMgVGFza3NcblxuIyMjIFQwMTogU2V0dXAgcHJvamVjdFxuICBCYXNpYyBwcm9qZWN0IHNldHVwIHN0ZXBzLlxuXG4jIyMgVDAyOiBBZGQgQ0kgcGlwZWxpbmUgXFxgZXN0OjMwbVxcYFxuICBDb25maWd1cmUgQ0kuXG5gO1xuXG4gIGNvbnN0IHAgPSBwYXJzZVBsYW4oY29udGVudCk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocC50YXNrcy5sZW5ndGgsIDIsICdjb2xvbiBoZWFkaW5nIHRhc2sgY291bnQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwLnRhc2tzWzBdLmlkLCAnVDAxJywgJ2NvbG9uIGhlYWRpbmcgVDAxIGlkJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocC50YXNrc1swXS50aXRsZSwgJ1NldHVwIHByb2plY3QnLCAnY29sb24gaGVhZGluZyBUMDEgdGl0bGUnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwLnRhc2tzWzFdLmlkLCAnVDAyJywgJ2NvbG9uIGhlYWRpbmcgVDAyIGlkJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocC50YXNrc1sxXS50aXRsZSwgJ0FkZCBDSSBwaXBlbGluZScsICdjb2xvbiBoZWFkaW5nIFQwMiB0aXRsZScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHAudGFza3NbMV0uZXN0aW1hdGUsICczMG0nLCAnY29sb24gaGVhZGluZyBUMDIgZXN0aW1hdGUnKTtcbn0pO1xuXG50ZXN0KCdwYXJzZVBsYW46IGhlYWRpbmctc3R5bGUgd2l0aCBlbS1kYXNoIHNlcGFyYXRvciAoIyMjIFQwMSBcdTIwMTQgVGl0bGUpJywgKCkgPT4ge1xuICBjb25zdCBjb250ZW50ID0gYCMgUzEzOiBFbS1EYXNoIFN0eWxlXG5cbioqR29hbDoqKiBUZXN0IGVtLWRhc2ggc2VwYXJhdGVkIGhlYWRpbmcgdGFza3MuXG4qKkRlbW86KiogUGFyc2VyIGhhbmRsZXMgZW0tZGFzaCBzZXBhcmF0b3IuXG5cbiMjIFRhc2tzXG5cbiMjIyBUMDEgXHUyMDE0IEJ1aWxkIHRoZSB3aWRnZXRcblxuV2lkZ2V0IGRlc2NyaXB0aW9uLlxuYDtcblxuICBjb25zdCBwID0gcGFyc2VQbGFuKGNvbnRlbnQpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHAudGFza3MubGVuZ3RoLCAxLCAnZW0tZGFzaCBoZWFkaW5nIHRhc2sgY291bnQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwLnRhc2tzWzBdLmlkLCAnVDAxJywgJ2VtLWRhc2ggaGVhZGluZyBUMDEgaWQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwLnRhc2tzWzBdLnRpdGxlLCAnQnVpbGQgdGhlIHdpZGdldCcsICdlbS1kYXNoIGhlYWRpbmcgVDAxIHRpdGxlJyk7XG59KTtcblxudGVzdCgncGFyc2VQbGFuOiBmaWxlbmFtZSBzdWJoZWFkaW5ncyBkbyBub3QgYmVjb21lIHRhc2sgaWRzJywgKCkgPT4ge1xuICBjb25zdCBjb250ZW50ID0gYCMgUzE1OiBGaWxlbmFtZSBIZWFkaW5nc1xuXG4qKkdvYWw6KiogSWdub3JlIGZpbGUtcmVmZXJlbmNlIHN1YmhlYWRpbmdzIGluc2lkZSB0YXNrIGRlc2NyaXB0aW9ucy5cbioqRGVtbzoqKiBPbmx5IHJlYWwgdGFzayBpZHMgYXJlIHBhcnNlZC5cblxuIyMgVGFza3NcblxuLSBbIF0gKipUMDE6IEZpcnN0IHRhc2sqKiBcXGBlc3Q6MTBtXFxgXG4gIEltcGxlbWVudCB0aGUgZmVhdHVyZS5cblxuIyMjIGNvbnN0cmFpbnRzLnB5IFx1MjAxNCBcXGBhZGRfb2ZmX3JlcXVlc3RfdGllcmVkKClcXGBcbi0gcHJlc2VydmUgYmVoYXZpb3JcblxuIyMjIGFubm90YXRpb25zLnB5IFx1MjAxNCBcXGBhbm5vdGF0ZSgpXFxgXG4tIGtlZXAgbWV0YWRhdGFcbmA7XG5cbiAgY29uc3QgcCA9IHBhcnNlUGxhbihjb250ZW50KTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwLnRhc2tzLm1hcCgodGFzaykgPT4gdGFzay5pZCksIFsnVDAxJ10sICdmaWxlbmFtZSBzdWJoZWFkaW5ncyBzaG91bGQgbm90IGNyZWF0ZSBleHRyYSB0YXNrcycpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHAudGFza3NbMF0udGl0bGUsICdGaXJzdCB0YXNrJywgJ3JlYWwgdGFzayBzaG91bGQgc3RpbGwgcGFyc2Ugbm9ybWFsbHknKTtcbiAgYXNzZXJ0Lm9rKHAudGFza3NbMF0uZGVzY3JpcHRpb24uaW5jbHVkZXMoJ3ByZXNlcnZlIGJlaGF2aW9yJyksICdkZXRhaWwgbGluZXMgdW5kZXIgZmlsZW5hbWUgc3ViaGVhZGluZ3Mgc2hvdWxkIHJlbWFpbiBhdHRhY2hlZCB0byB0aGUgdGFzaycpO1xuICBhc3NlcnQub2socC50YXNrc1swXS5kZXNjcmlwdGlvbi5pbmNsdWRlcygna2VlcCBtZXRhZGF0YScpLCAnbGF0ZXIgZGV0YWlsIGxpbmVzIHNob3VsZCBhbHNvIHJlbWFpbiBhdHRhY2hlZCB0byB0aGUgdGFzaycpO1xufSk7XG5cbnRlc3QoJ3BhcnNlUGxhbjogbWl4ZWQgY2hlY2tib3ggYW5kIGhlYWRpbmctc3R5bGUgdGFza3MnLCAoKSA9PiB7XG4gIGNvbnN0IGNvbnRlbnQgPSBgIyBTMTQ6IE1peGVkIEZvcm1hdFxuXG4qKkdvYWw6KiogVGVzdCBtaXhlZCBmb3JtYXRzLlxuKipEZW1vOioqIFBhcnNlciBoYW5kbGVzIGJvdGggc3R5bGVzIGluIG9uZSBwbGFuLlxuXG4jIyBUYXNrc1xuXG4tIFsgXSAqKlQwMTogQ2hlY2tib3ggdGFzayoqIFxcYGVzdDoyMG1cXGBcbiAgQSBjaGVja2JveC1zdHlsZSB0YXNrLlxuXG4jIyMgVDAyIC0tIEhlYWRpbmcgdGFzayBcXGBlc3Q6MTVtXFxgXG5cbkEgaGVhZGluZy1zdHlsZSB0YXNrLlxuXG4tIFt4XSAqKlQwMzogRG9uZSBjaGVja2JveCB0YXNrKiogXFxgZXN0OjEwbVxcYFxuICBBbHJlYWR5IGNvbXBsZXRlZC5cbmA7XG5cbiAgY29uc3QgcCA9IHBhcnNlUGxhbihjb250ZW50KTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwLnRhc2tzLmxlbmd0aCwgMywgJ21peGVkIGZvcm1hdCB0YXNrIGNvdW50Jyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocC50YXNrc1swXS5pZCwgJ1QwMScsICdtaXhlZCBUMDEgaWQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwLnRhc2tzWzBdLmRvbmUsIGZhbHNlLCAnbWl4ZWQgVDAxIG5vdCBkb25lJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocC50YXNrc1sxXS5pZCwgJ1QwMicsICdtaXhlZCBUMDIgaWQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwLnRhc2tzWzFdLnRpdGxlLCAnSGVhZGluZyB0YXNrJywgJ21peGVkIFQwMiB0aXRsZScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHAudGFza3NbMV0uZXN0aW1hdGUsICcxNW0nLCAnbWl4ZWQgVDAyIGVzdGltYXRlJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocC50YXNrc1sxXS5kb25lLCBmYWxzZSwgJ21peGVkIFQwMiBub3QgZG9uZSAoaGVhZGluZyBzdHlsZSknKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwLnRhc2tzWzJdLmlkLCAnVDAzJywgJ21peGVkIFQwMyBpZCcpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHAudGFza3NbMl0uZG9uZSwgdHJ1ZSwgJ21peGVkIFQwMyBkb25lJyk7XG59KTtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBwYXJzZVN1bW1hcnkgdGVzdHNcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxudGVzdCgncGFyc2VTdW1tYXJ5OiBmdWxsIHN1bW1hcnkgd2l0aCBhbGwgZnJvbnRtYXR0ZXIgZmllbGRzJywgKCkgPT4ge1xuICBjb25zdCBjb250ZW50ID0gYC0tLVxuaWQ6IFQwMVxucGFyZW50OiBTMDFcbm1pbGVzdG9uZTogTTAwMVxucHJvdmlkZXM6XG4gIC0gcGFyc2VSb2FkbWFwIHRlc3QgY292ZXJhZ2VcbiAgLSBwYXJzZVBsYW4gdGVzdCBjb3ZlcmFnZVxucmVxdWlyZXM6XG4gIC0gc2xpY2U6IFMwMFxuICAgIHByb3ZpZGVzOiB0eXBlIGRlZmluaXRpb25zXG4gIC0gc2xpY2U6IFMwMlxuICAgIHByb3ZpZGVzOiBzdGF0ZSBkZXJpdmF0aW9uXG5hZmZlY3RzOlxuICAtIGF1dG8tbW9kZSBkaXNwYXRjaFxua2V5X2ZpbGVzOlxuICAtIHRlc3RzL3BhcnNlcnMudGVzdC50c1xuICAtIGZpbGVzLnRzXG5rZXlfZGVjaXNpb25zOlxuICAtIFVzZSBtYW51YWwgYXNzZXJ0IHBhdHRlcm5cbnBhdHRlcm5zX2VzdGFibGlzaGVkOlxuICAtIHBhcnNlcnMudGVzdC50cyBpcyB0aGUgY2Fub25pY2FsIHRlc3QgbG9jYXRpb25cbmRyaWxsX2Rvd25fcGF0aHM6XG4gIC0gdGVzdHMvcGFyc2Vycy50ZXN0LnRzIGZvciBhc3NlcnRpb24gZGV0YWlsc1xub2JzZXJ2YWJpbGl0eV9zdXJmYWNlczpcbiAgLSB0ZXN0IHBhc3MvZmFpbCBvdXRwdXQgZnJvbSBub2RlIC0tdGVzdFxuICAtIGV4aXQgY29kZSAxIG9uIGZhaWx1cmVcbmR1cmF0aW9uOiAyM21pblxudmVyaWZpY2F0aW9uX3Jlc3VsdDogcGFzc1xucmV0cmllczogMFxuY29tcGxldGVkX2F0OiAyMDI1LTAzLTEwVDA4OjAwOjAwWlxuLS0tXG5cbiMgVDAxOiBUZXN0IHBhcnNlUm9hZG1hcCBhbmQgcGFyc2VQbGFuXG5cbioqQ3JlYXRlZCBwYXJzZXJzLnRlc3QudHMgd2l0aCA5OCBhc3NlcnRpb25zIGFjcm9zcyAxNiB0ZXN0IGdyb3Vwcy4qKlxuXG4jIyBXaGF0IEhhcHBlbmVkXG5cbkFkZGVkIGNvbXByZWhlbnNpdmUgdGVzdHMgZm9yIHBhcnNlUm9hZG1hcCBhbmQgcGFyc2VQbGFuLlxuXG4jIyBEZXZpYXRpb25zXG5cbk5vbmUuXG5cbiMjIEZpbGVzIENyZWF0ZWQvTW9kaWZpZWRcblxuLSBcXGB0ZXN0cy9wYXJzZXJzLnRlc3QudHNcXGAgXHUyMDE0IG5ldyB0ZXN0IGZpbGUgd2l0aCA5OCBhc3NlcnRpb25zXG4tIFxcYHR5cGVzLnRzXFxgIFx1MjAxNCBhZGRlZCBvYnNlcnZhYmlsaXR5X3N1cmZhY2VzIGZpZWxkXG4tIFxcYGZpbGVzLnRzXFxgIFx1MjAxNCB1cGRhdGVkIHBhcnNlU3VtbWFyeSBleHRyYWN0aW9uXG5gO1xuXG4gIGNvbnN0IHMgPSBwYXJzZVN1bW1hcnkoY29udGVudCk7XG5cbiAgLy8gRnJvbnRtYXR0ZXIgZmllbGRzXG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocy5mcm9udG1hdHRlci5pZCwgJ1QwMScsICdzdW1tYXJ5IGlkJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocy5mcm9udG1hdHRlci5wYXJlbnQsICdTMDEnLCAnc3VtbWFyeSBwYXJlbnQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzLmZyb250bWF0dGVyLm1pbGVzdG9uZSwgJ00wMDEnLCAnc3VtbWFyeSBtaWxlc3RvbmUnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzLmZyb250bWF0dGVyLnByb3ZpZGVzLmxlbmd0aCwgMiwgJ3Byb3ZpZGVzIGNvdW50Jyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocy5mcm9udG1hdHRlci5wcm92aWRlc1swXSwgJ3BhcnNlUm9hZG1hcCB0ZXN0IGNvdmVyYWdlJywgJ2ZpcnN0IHByb3ZpZGVzJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocy5mcm9udG1hdHRlci5wcm92aWRlc1sxXSwgJ3BhcnNlUGxhbiB0ZXN0IGNvdmVyYWdlJywgJ3NlY29uZCBwcm92aWRlcycpO1xuXG4gIC8vIHJlcXVpcmVzIChuZXN0ZWQgb2JqZWN0cylcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzLmZyb250bWF0dGVyLnJlcXVpcmVzLmxlbmd0aCwgMiwgJ3JlcXVpcmVzIGNvdW50Jyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocy5mcm9udG1hdHRlci5yZXF1aXJlc1swXS5zbGljZSwgJ1MwMCcsICdmaXJzdCByZXF1aXJlcyBzbGljZScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHMuZnJvbnRtYXR0ZXIucmVxdWlyZXNbMF0ucHJvdmlkZXMsICd0eXBlIGRlZmluaXRpb25zJywgJ2ZpcnN0IHJlcXVpcmVzIHByb3ZpZGVzJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocy5mcm9udG1hdHRlci5yZXF1aXJlc1sxXS5zbGljZSwgJ1MwMicsICdzZWNvbmQgcmVxdWlyZXMgc2xpY2UnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzLmZyb250bWF0dGVyLnJlcXVpcmVzWzFdLnByb3ZpZGVzLCAnc3RhdGUgZGVyaXZhdGlvbicsICdzZWNvbmQgcmVxdWlyZXMgcHJvdmlkZXMnKTtcblxuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHMuZnJvbnRtYXR0ZXIuYWZmZWN0cy5sZW5ndGgsIDEsICdhZmZlY3RzIGNvdW50Jyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocy5mcm9udG1hdHRlci5hZmZlY3RzWzBdLCAnYXV0by1tb2RlIGRpc3BhdGNoJywgJ2FmZmVjdHMgdmFsdWUnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzLmZyb250bWF0dGVyLmtleV9maWxlcy5sZW5ndGgsIDIsICdrZXlfZmlsZXMgY291bnQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzLmZyb250bWF0dGVyLmtleV9kZWNpc2lvbnMubGVuZ3RoLCAxLCAna2V5X2RlY2lzaW9ucyBjb3VudCcpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHMuZnJvbnRtYXR0ZXIucGF0dGVybnNfZXN0YWJsaXNoZWQubGVuZ3RoLCAxLCAncGF0dGVybnNfZXN0YWJsaXNoZWQgY291bnQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzLmZyb250bWF0dGVyLmRyaWxsX2Rvd25fcGF0aHMubGVuZ3RoLCAxLCAnZHJpbGxfZG93bl9wYXRocyBjb3VudCcpO1xuXG4gIC8vIG9ic2VydmFiaWxpdHlfc3VyZmFjZXMgZXh0cmFjdGlvblxuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHMuZnJvbnRtYXR0ZXIub2JzZXJ2YWJpbGl0eV9zdXJmYWNlcy5sZW5ndGgsIDIsICdvYnNlcnZhYmlsaXR5X3N1cmZhY2VzIGNvdW50Jyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocy5mcm9udG1hdHRlci5vYnNlcnZhYmlsaXR5X3N1cmZhY2VzWzBdLCAndGVzdCBwYXNzL2ZhaWwgb3V0cHV0IGZyb20gbm9kZSAtLXRlc3QnLCAnZmlyc3Qgb2JzZXJ2YWJpbGl0eSBzdXJmYWNlJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocy5mcm9udG1hdHRlci5vYnNlcnZhYmlsaXR5X3N1cmZhY2VzWzFdLCAnZXhpdCBjb2RlIDEgb24gZmFpbHVyZScsICdzZWNvbmQgb2JzZXJ2YWJpbGl0eSBzdXJmYWNlJyk7XG5cbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzLmZyb250bWF0dGVyLmR1cmF0aW9uLCAnMjNtaW4nLCAnZHVyYXRpb24nKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzLmZyb250bWF0dGVyLnZlcmlmaWNhdGlvbl9yZXN1bHQsICdwYXNzJywgJ3ZlcmlmaWNhdGlvbl9yZXN1bHQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzLmZyb250bWF0dGVyLmNvbXBsZXRlZF9hdCwgJzIwMjUtMDMtMTBUMDg6MDA6MDBaJywgJ2NvbXBsZXRlZF9hdCcpO1xuXG4gIC8vIEJvZHkgZmllbGRzXG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocy50aXRsZSwgJ1QwMTogVGVzdCBwYXJzZVJvYWRtYXAgYW5kIHBhcnNlUGxhbicsICdzdW1tYXJ5IHRpdGxlJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocy5vbmVMaW5lciwgJ0NyZWF0ZWQgcGFyc2Vycy50ZXN0LnRzIHdpdGggOTggYXNzZXJ0aW9ucyBhY3Jvc3MgMTYgdGVzdCBncm91cHMuJywgJ29uZS1saW5lcicpO1xuICBhc3NlcnQub2socy53aGF0SGFwcGVuZWQuaW5jbHVkZXMoJ2NvbXByZWhlbnNpdmUgdGVzdHMnKSwgJ3doYXRIYXBwZW5lZCBjb250ZW50Jyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocy5kZXZpYXRpb25zLCAnTm9uZS4nLCAnZGV2aWF0aW9ucycpO1xuXG4gIC8vIEZpbGVzIG1vZGlmaWVkXG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocy5maWxlc01vZGlmaWVkLmxlbmd0aCwgMywgJ2ZpbGVzTW9kaWZpZWQgY291bnQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzLmZpbGVzTW9kaWZpZWRbMF0ucGF0aCwgJ3Rlc3RzL3BhcnNlcnMudGVzdC50cycsICdmaXJzdCBmaWxlIHBhdGgnKTtcbiAgYXNzZXJ0Lm9rKHMuZmlsZXNNb2RpZmllZFswXS5kZXNjcmlwdGlvbi5pbmNsdWRlcygnOTggYXNzZXJ0aW9ucycpLCAnZmlyc3QgZmlsZSBkZXNjcmlwdGlvbicpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHMuZmlsZXNNb2RpZmllZFsxXS5wYXRoLCAndHlwZXMudHMnLCAnc2Vjb25kIGZpbGUgcGF0aCcpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHMuZmlsZXNNb2RpZmllZFsyXS5wYXRoLCAnZmlsZXMudHMnLCAndGhpcmQgZmlsZSBwYXRoJyk7XG59KTtcblxudGVzdCgncGFyc2VTdW1tYXJ5OiBvbmUtbGluZXIgZXh0cmFjdGlvbiAoYm9sZC13cmFwcGVkIGxpbmUgYWZ0ZXIgSDEpJywgKCkgPT4ge1xuICBjb25zdCBjb250ZW50ID0gYCMgUzAxOiBQYXJzZXIgVGVzdCBTdWl0ZVxuXG4qKkFsbCA1IHBhcnNlcnMgaGF2ZSB0ZXN0IGNvdmVyYWdlIHdpdGggZWRnZSBjYXNlcy4qKlxuXG4jIyBXaGF0IEhhcHBlbmVkXG5cblRoaW5ncyBoYXBwZW5lZC5cbmA7XG5cbiAgY29uc3QgcyA9IHBhcnNlU3VtbWFyeShjb250ZW50KTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzLnRpdGxlLCAnUzAxOiBQYXJzZXIgVGVzdCBTdWl0ZScsICd0aXRsZScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHMub25lTGluZXIsICdBbGwgNSBwYXJzZXJzIGhhdmUgdGVzdCBjb3ZlcmFnZSB3aXRoIGVkZ2UgY2FzZXMuJywgJ2JvbGQgb25lLWxpbmVyJyk7XG59KTtcblxudGVzdCgncGFyc2VTdW1tYXJ5OiBub24tYm9sZCBwYXJhZ3JhcGggYWZ0ZXIgSDEgKGVtcHR5IG9uZS1saW5lciknLCAoKSA9PiB7XG4gIGNvbnN0IGNvbnRlbnQgPSBgIyBUMDI6IFNvbWUgVGFza1xuXG5UaGlzIGlzIGp1c3QgYSByZWd1bGFyIHBhcmFncmFwaCwgbm90IGJvbGQuXG5cbiMjIFdoYXQgSGFwcGVuZWRcblxuRGlkIHN0dWZmLlxuYDtcblxuICBjb25zdCBzID0gcGFyc2VTdW1tYXJ5KGNvbnRlbnQpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHMudGl0bGUsICdUMDI6IFNvbWUgVGFzaycsICd0aXRsZScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHMub25lTGluZXIsICcnLCAnbm9uLWJvbGQgbGluZSByZXN1bHRzIGluIGVtcHR5IG9uZS1saW5lcicpO1xufSk7XG5cbnRlc3QoJ3BhcnNlU3VtbWFyeTogZmlsZXMtbW9kaWZpZWQgcGFyc2luZyAoYmFja3RpY2sgcGF0aCBcdTIwMTQgZGVzY3JpcHRpb24gZm9ybWF0KScsICgpID0+IHtcbiAgY29uc3QgY29udGVudCA9IGAjIFQwMzogRmlsZSBDaGFuZ2VzXG5cbioqT25lLWxpbmVyLioqXG5cbiMjIEZpbGVzIENyZWF0ZWQvTW9kaWZpZWRcblxuLSBcXGBzcmMvaW5kZXgudHNcXGAgXHUyMDE0IG1haW4gZW50cnkgcG9pbnRcbi0gXFxgc3JjL3V0aWxzLnRzXFxgIFx1MjAxNCB1dGlsaXR5IGZ1bmN0aW9uc1xuLSBcXGBSRUFETUUubWRcXGAgXHUyMDE0IHVwZGF0ZWQgZG9jc1xuYDtcblxuICBjb25zdCBzID0gcGFyc2VTdW1tYXJ5KGNvbnRlbnQpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHMuZmlsZXNNb2RpZmllZC5sZW5ndGgsIDMsICd0aHJlZSBmaWxlcycpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHMuZmlsZXNNb2RpZmllZFswXS5wYXRoLCAnc3JjL2luZGV4LnRzJywgJ2ZpcnN0IHBhdGgnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzLmZpbGVzTW9kaWZpZWRbMF0uZGVzY3JpcHRpb24sICdtYWluIGVudHJ5IHBvaW50JywgJ2ZpcnN0IGRlc2NyaXB0aW9uJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocy5maWxlc01vZGlmaWVkWzFdLnBhdGgsICdzcmMvdXRpbHMudHMnLCAnc2Vjb25kIHBhdGgnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzLmZpbGVzTW9kaWZpZWRbMl0ucGF0aCwgJ1JFQURNRS5tZCcsICd0aGlyZCBwYXRoJyk7XG59KTtcblxudGVzdCgncGFyc2VTdW1tYXJ5OiBtaXNzaW5nIGZyb250bWF0dGVyIChzYWZlIGRlZmF1bHRzKScsICgpID0+IHtcbiAgY29uc3QgY29udGVudCA9IGAjIFQwNDogTm8gRnJvbnRtYXR0ZXJcblxuKipEaWQgc29tZXRoaW5nLioqXG5cbiMjIFdoYXQgSGFwcGVuZWRcblxuTm8gZnJvbnRtYXR0ZXIgYXQgYWxsLlxuYDtcblxuICBjb25zdCBzID0gcGFyc2VTdW1tYXJ5KGNvbnRlbnQpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHMuZnJvbnRtYXR0ZXIuaWQsICcnLCAnZGVmYXVsdCBpZCBlbXB0eScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHMuZnJvbnRtYXR0ZXIucGFyZW50LCAnJywgJ2RlZmF1bHQgcGFyZW50IGVtcHR5Jyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocy5mcm9udG1hdHRlci5taWxlc3RvbmUsICcnLCAnZGVmYXVsdCBtaWxlc3RvbmUgZW1wdHknKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzLmZyb250bWF0dGVyLnByb3ZpZGVzLmxlbmd0aCwgMCwgJ2RlZmF1bHQgcHJvdmlkZXMgZW1wdHknKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzLmZyb250bWF0dGVyLnJlcXVpcmVzLmxlbmd0aCwgMCwgJ2RlZmF1bHQgcmVxdWlyZXMgZW1wdHknKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzLmZyb250bWF0dGVyLmFmZmVjdHMubGVuZ3RoLCAwLCAnZGVmYXVsdCBhZmZlY3RzIGVtcHR5Jyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocy5mcm9udG1hdHRlci5rZXlfZmlsZXMubGVuZ3RoLCAwLCAnZGVmYXVsdCBrZXlfZmlsZXMgZW1wdHknKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzLmZyb250bWF0dGVyLmtleV9kZWNpc2lvbnMubGVuZ3RoLCAwLCAnZGVmYXVsdCBrZXlfZGVjaXNpb25zIGVtcHR5Jyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocy5mcm9udG1hdHRlci5wYXR0ZXJuc19lc3RhYmxpc2hlZC5sZW5ndGgsIDAsICdkZWZhdWx0IHBhdHRlcm5zX2VzdGFibGlzaGVkIGVtcHR5Jyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocy5mcm9udG1hdHRlci5kcmlsbF9kb3duX3BhdGhzLmxlbmd0aCwgMCwgJ2RlZmF1bHQgZHJpbGxfZG93bl9wYXRocyBlbXB0eScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHMuZnJvbnRtYXR0ZXIub2JzZXJ2YWJpbGl0eV9zdXJmYWNlcy5sZW5ndGgsIDAsICdkZWZhdWx0IG9ic2VydmFiaWxpdHlfc3VyZmFjZXMgZW1wdHknKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzLmZyb250bWF0dGVyLmR1cmF0aW9uLCAnJywgJ2RlZmF1bHQgZHVyYXRpb24gZW1wdHknKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzLmZyb250bWF0dGVyLnZlcmlmaWNhdGlvbl9yZXN1bHQsICd1bnRlc3RlZCcsICdkZWZhdWx0IHZlcmlmaWNhdGlvbl9yZXN1bHQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzLmZyb250bWF0dGVyLmNvbXBsZXRlZF9hdCwgJycsICdkZWZhdWx0IGNvbXBsZXRlZF9hdCBlbXB0eScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHMudGl0bGUsICdUMDQ6IE5vIEZyb250bWF0dGVyJywgJ3RpdGxlIHN0aWxsIHBhcnNlZCcpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHMub25lTGluZXIsICdEaWQgc29tZXRoaW5nLicsICdvbmUtbGluZXIgc3RpbGwgcGFyc2VkJyk7XG59KTtcblxudGVzdCgncGFyc2VTdW1tYXJ5OiBlbXB0eSBib2R5JywgKCkgPT4ge1xuICBjb25zdCBjb250ZW50ID0gYC0tLVxuaWQ6IFQwNVxucGFyZW50OiBTMDFcbm1pbGVzdG9uZTogTTAwMVxuLS0tXG5gO1xuXG4gIGNvbnN0IHMgPSBwYXJzZVN1bW1hcnkoY29udGVudCk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocy5mcm9udG1hdHRlci5pZCwgJ1QwNScsICdpZCBmcm9tIGZyb250bWF0dGVyJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocy50aXRsZSwgJycsICdlbXB0eSB0aXRsZScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHMub25lTGluZXIsICcnLCAnZW1wdHkgb25lLWxpbmVyJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocy53aGF0SGFwcGVuZWQsICcnLCAnZW1wdHkgd2hhdEhhcHBlbmVkJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocy5kZXZpYXRpb25zLCAnJywgJ2VtcHR5IGRldmlhdGlvbnMnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzLmZpbGVzTW9kaWZpZWQubGVuZ3RoLCAwLCAnbm8gZmlsZXMgbW9kaWZpZWQnKTtcbn0pO1xuXG50ZXN0KCdwYXJzZVN1bW1hcnk6IHN1bW1hcnkgd2l0aCByZXF1aXJlcyBhcnJheSAobmVzdGVkIG9iamVjdHMpJywgKCkgPT4ge1xuICBjb25zdCBjb250ZW50ID0gYC0tLVxuaWQ6IFQwNlxucGFyZW50OiBTMDJcbm1pbGVzdG9uZTogTTAwMVxucmVxdWlyZXM6XG4gIC0gc2xpY2U6IFMwMVxuICAgIHByb3ZpZGVzOiBwYXJzZXIgZnVuY3Rpb25zXG4gIC0gc2xpY2U6IFMwMFxuICAgIHByb3ZpZGVzOiBjb3JlIHR5cGVzXG4gIC0gc2xpY2U6IFMwM1xuICAgIHByb3ZpZGVzOiBzdGF0ZSBlbmdpbmVcbnByb3ZpZGVzOiBbXVxuYWZmZWN0czogW11cbmtleV9maWxlczogW11cbmtleV9kZWNpc2lvbnM6IFtdXG5wYXR0ZXJuc19lc3RhYmxpc2hlZDogW11cbmRyaWxsX2Rvd25fcGF0aHM6IFtdXG5vYnNlcnZhYmlsaXR5X3N1cmZhY2VzOiBbXVxuZHVyYXRpb246IDEwbWluXG52ZXJpZmljYXRpb25fcmVzdWx0OiBwYXNzXG5yZXRyaWVzOiAxXG5jb21wbGV0ZWRfYXQ6IDIwMjUtMDMtMTBUMDk6MDA6MDBaXG4tLS1cblxuIyBUMDY6IE5lc3RlZCBSZXF1aXJlc1xuXG4qKlRlc3QgbmVzdGVkIHJlcXVpcmVzIHBhcnNpbmcuKipcblxuIyMgV2hhdCBIYXBwZW5lZFxuXG5UZXN0ZWQuXG5gO1xuXG4gIGNvbnN0IHMgPSBwYXJzZVN1bW1hcnkoY29udGVudCk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocy5mcm9udG1hdHRlci5yZXF1aXJlcy5sZW5ndGgsIDMsICd0aHJlZSByZXF1aXJlcyBlbnRyaWVzJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocy5mcm9udG1hdHRlci5yZXF1aXJlc1swXS5zbGljZSwgJ1MwMScsICdmaXJzdCByZXF1aXJlcyBzbGljZScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHMuZnJvbnRtYXR0ZXIucmVxdWlyZXNbMF0ucHJvdmlkZXMsICdwYXJzZXIgZnVuY3Rpb25zJywgJ2ZpcnN0IHJlcXVpcmVzIHByb3ZpZGVzJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocy5mcm9udG1hdHRlci5yZXF1aXJlc1sxXS5zbGljZSwgJ1MwMCcsICdzZWNvbmQgcmVxdWlyZXMgc2xpY2UnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzLmZyb250bWF0dGVyLnJlcXVpcmVzWzJdLnNsaWNlLCAnUzAzJywgJ3RoaXJkIHJlcXVpcmVzIHNsaWNlJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocy5mcm9udG1hdHRlci5yZXF1aXJlc1syXS5wcm92aWRlcywgJ3N0YXRlIGVuZ2luZScsICd0aGlyZCByZXF1aXJlcyBwcm92aWRlcycpO1xufSk7XG5cbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuLy8gcGFyc2VDb250aW51ZSB0ZXN0c1xuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG50ZXN0KCdwYXJzZUNvbnRpbnVlOiBmdWxsIGNvbnRpbnVlIGZpbGUgd2l0aCBhbGwgZnJvbnRtYXR0ZXIgZmllbGRzJywgKCkgPT4ge1xuICBjb25zdCBjb250ZW50ID0gYC0tLVxubWlsZXN0b25lOiBNMDAxXG5zbGljZTogUzAxXG50YXNrOiBUMDJcbnN0ZXA6IDNcbnRvdGFsX3N0ZXBzOiA1XG5zdGF0dXM6IGluX3Byb2dyZXNzXG5zYXZlZF9hdDogMjAyNS0wMy0xMFQwODozMDowMFpcbi0tLVxuXG4jIyBDb21wbGV0ZWQgV29ya1xuXG5TdGVwcyAxLTMgYXJlIGRvbmUuIENyZWF0ZWQgdGVzdCBmaWxlIGFuZCB3cm90ZSBhc3NlcnRpb25zLlxuXG4jIyBSZW1haW5pbmcgV29ya1xuXG5TdGVwcyA0LTU6IHJ1biB0ZXN0cyBhbmQgY2hlY2sgcmVncmVzc2lvbnMuXG5cbiMjIERlY2lzaW9ucyBNYWRlXG5cblVzZWQgbWFudWFsIGFzc2VydCBwYXR0ZXJuIGluc3RlYWQgb2Ygbm9kZTphc3NlcnQuXG5cbiMjIENvbnRleHRcblxuV29ya2luZyBpbiB0aGUgZ3NkLXMwMSB3b3JrdHJlZS4gQWxsIGltcG9ydHMgdXNlIC50cyBleHRlbnNpb25zLlxuXG4jIyBOZXh0IEFjdGlvblxuXG5SdW4gdGhlIGZ1bGwgdGVzdCBzdWl0ZSB3aXRoIG5vZGUgLS10ZXN0LlxuYDtcblxuICBjb25zdCBjID0gcGFyc2VDb250aW51ZShjb250ZW50KTtcblxuICAvLyBGcm9udG1hdHRlclxuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGMuZnJvbnRtYXR0ZXIubWlsZXN0b25lLCAnTTAwMScsICdjb250aW51ZSBtaWxlc3RvbmUnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChjLmZyb250bWF0dGVyLnNsaWNlLCAnUzAxJywgJ2NvbnRpbnVlIHNsaWNlJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoYy5mcm9udG1hdHRlci50YXNrLCAnVDAyJywgJ2NvbnRpbnVlIHRhc2snKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChjLmZyb250bWF0dGVyLnN0ZXAsIDMsICdjb250aW51ZSBzdGVwJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoYy5mcm9udG1hdHRlci50b3RhbFN0ZXBzLCA1LCAnY29udGludWUgdG90YWxTdGVwcycpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGMuZnJvbnRtYXR0ZXIuc3RhdHVzLCAnaW5fcHJvZ3Jlc3MnLCAnY29udGludWUgc3RhdHVzJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoYy5mcm9udG1hdHRlci5zYXZlZEF0LCAnMjAyNS0wMy0xMFQwODozMDowMFonLCAnY29udGludWUgc2F2ZWRBdCcpO1xuXG4gIC8vIEJvZHkgc2VjdGlvbnNcbiAgYXNzZXJ0Lm9rKGMuY29tcGxldGVkV29yay5pbmNsdWRlcygnU3RlcHMgMS0zIGFyZSBkb25lJyksICdjb21wbGV0ZWRXb3JrIGNvbnRlbnQnKTtcbiAgYXNzZXJ0Lm9rKGMucmVtYWluaW5nV29yay5pbmNsdWRlcygnU3RlcHMgNC01JyksICdyZW1haW5pbmdXb3JrIGNvbnRlbnQnKTtcbiAgYXNzZXJ0Lm9rKGMuZGVjaXNpb25zLmluY2x1ZGVzKCdtYW51YWwgYXNzZXJ0IHBhdHRlcm4nKSwgJ2RlY2lzaW9ucyBjb250ZW50Jyk7XG4gIGFzc2VydC5vayhjLmNvbnRleHQuaW5jbHVkZXMoJ2dzZC1zMDEgd29ya3RyZWUnKSwgJ2NvbnRleHQgY29udGVudCcpO1xuICBhc3NlcnQub2soYy5uZXh0QWN0aW9uLmluY2x1ZGVzKCdub2RlIC0tdGVzdCcpLCAnbmV4dEFjdGlvbiBjb250ZW50Jyk7XG59KTtcblxudGVzdCgncGFyc2VDb250aW51ZTogc3RyaW5nIHN0ZXAvdG90YWxTdGVwcyBwYXJzZWQgYXMgaW50ZWdlcnMnLCAoKSA9PiB7XG4gIGNvbnN0IGNvbnRlbnQgPSBgLS0tXG5taWxlc3RvbmU6IE0wMDJcbnNsaWNlOiBTMDNcbnRhc2s6IFQwMVxuc3RlcDogN1xudG90YWxfc3RlcHM6IDEyXG5zdGF0dXM6IGluX3Byb2dyZXNzXG5zYXZlZF9hdDogMjAyNS0wMy0xMFQxMDowMDowMFpcbi0tLVxuXG4jIyBDb21wbGV0ZWQgV29ya1xuXG5Tb21lIHdvcmsuXG5cbiMjIFJlbWFpbmluZyBXb3JrXG5cbk1vcmUgd29yay5cblxuIyMgRGVjaXNpb25zIE1hZGVcblxuTm9uZS5cblxuIyMgQ29udGV4dFxuXG5Ob25lLlxuXG4jIyBOZXh0IEFjdGlvblxuXG5Db250aW51ZS5cbmA7XG5cbiAgY29uc3QgYyA9IHBhcnNlQ29udGludWUoY29udGVudCk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoYy5mcm9udG1hdHRlci5zdGVwLCA3LCAnc3RlcCBwYXJzZWQgYXMgaW50ZWdlciA3Jyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoYy5mcm9udG1hdHRlci50b3RhbFN0ZXBzLCAxMiwgJ3RvdGFsU3RlcHMgcGFyc2VkIGFzIGludGVnZXIgMTInKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbCh0eXBlb2YgYy5mcm9udG1hdHRlci5zdGVwLCAnbnVtYmVyJywgJ3N0ZXAgaXMgbnVtYmVyIHR5cGUnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbCh0eXBlb2YgYy5mcm9udG1hdHRlci50b3RhbFN0ZXBzLCAnbnVtYmVyJywgJ3RvdGFsU3RlcHMgaXMgbnVtYmVyIHR5cGUnKTtcbn0pO1xuXG50ZXN0KCdwYXJzZUNvbnRpbnVlOiBOYU4gc3RlcCB2YWx1ZXMgKG5vbi1udW1lcmljIHN0cmluZ3MpJywgKCkgPT4ge1xuICBjb25zdCBjb250ZW50ID0gYC0tLVxubWlsZXN0b25lOiBNMDAxXG5zbGljZTogUzAxXG50YXNrOiBUMDFcbnN0ZXA6IGFiY1xudG90YWxfc3RlcHM6IHh5elxuc3RhdHVzOiBpbl9wcm9ncmVzc1xuc2F2ZWRfYXQ6IDIwMjUtMDMtMTBUMTA6MDA6MDBaXG4tLS1cblxuIyMgQ29tcGxldGVkIFdvcmtcblxuV29yay5cblxuIyMgUmVtYWluaW5nIFdvcmtcblxuV29yay5cblxuIyMgRGVjaXNpb25zIE1hZGVcblxuTm9uZS5cblxuIyMgQ29udGV4dFxuXG5Ob25lLlxuXG4jIyBOZXh0IEFjdGlvblxuXG5EbyB0aGluZ3MuXG5gO1xuXG4gIGNvbnN0IGMgPSBwYXJzZUNvbnRpbnVlKGNvbnRlbnQpO1xuICAvLyBwYXJzZUludChcImFiY1wiKSByZXR1cm5zIE5hTjsgdGhlIHBhcnNlciB8fCAwIGZhbGxiYWNrIHNob3VsZCBnaXZlIDBcbiAgLy8gQWN0dWFsbHksIGxvb2tpbmcgYXQgcGFyc2VyOiB0eXBlb2YgZm0uc3RlcCA9PT0gJ3N0cmluZycgPyBwYXJzZUludChmbS5zdGVwKSA6IC4uLlxuICAvLyBwYXJzZUludChcImFiY1wiKSA9IE5hTiwgYW5kIE5hTiB8fCAwIGRvZXNuJ3Qgd29yayBiZWNhdXNlIE5hTiBpcyBmYWxzeSBvbmx5IGluIGJvb2xlYW4gY29udGV4dFxuICAvLyBCdXQgdGhlIHBhcnNlciB1c2VzOiB0eXBlb2YgZm0uc3RlcCA9PT0gJ3N0cmluZycgPyBwYXJzZUludChmbS5zdGVwKSA6IChmbS5zdGVwIGFzIG51bWJlcikgfHwgMFxuICAvLyBwYXJzZUludCByZXR1cm5zIE5hTiB3aGljaCBpcyBhIG51bWJlciwgbm90IDAgXHUyMDE0IGxldCdzIHZlcmlmeVxuICBjb25zdCBzdGVwSXNOYU4gPSBOdW1iZXIuaXNOYU4oYy5mcm9udG1hdHRlci5zdGVwKTtcbiAgY29uc3QgdG90YWxJc05hTiA9IE51bWJlci5pc05hTihjLmZyb250bWF0dGVyLnRvdGFsU3RlcHMpO1xuICAvLyBUaGUgcGFyc2VyIGRvZXMgcGFyc2VJbnQgd2hpY2ggcmV0dXJucyBOYU4gZm9yIG5vbi1udW1lcmljIHN0cmluZ3NcbiAgLy8gVGhlcmUncyBubyB8fCAwIGZhbGxiYWNrIG9uIHRoZSBwYXJzZUludCBwYXRoLCBzbyBOYU4gaXMgZXhwZWN0ZWRcbiAgYXNzZXJ0Lm9rKHN0ZXBJc05hTiwgJ05hTiBzdGVwIHdoZW4gbm9uLW51bWVyaWMgc3RyaW5nJyk7XG4gIGFzc2VydC5vayh0b3RhbElzTmFOLCAnTmFOIHRvdGFsU3RlcHMgd2hlbiBub24tbnVtZXJpYyBzdHJpbmcnKTtcbn0pO1xuXG50ZXN0KCdwYXJzZUNvbnRpbnVlOiBhbGwgdGhyZWUgc3RhdHVzIHZhcmlhbnRzJywgKCkgPT4ge1xuICBmb3IgKGNvbnN0IHN0YXR1cyBvZiBbJ2luX3Byb2dyZXNzJywgJ2ludGVycnVwdGVkJywgJ2NvbXBhY3RlZCddIGFzIGNvbnN0KSB7XG4gICAgY29uc3QgY29udGVudCA9IGAtLS1cbm1pbGVzdG9uZTogTTAwMVxuc2xpY2U6IFMwMVxudGFzazogVDAxXG5zdGVwOiAxXG50b3RhbF9zdGVwczogM1xuc3RhdHVzOiAke3N0YXR1c31cbnNhdmVkX2F0OiAyMDI1LTAzLTEwVDEwOjAwOjAwWlxuLS0tXG5cbiMjIENvbXBsZXRlZCBXb3JrXG5cbldvcmsuXG5gO1xuXG4gICAgY29uc3QgYyA9IHBhcnNlQ29udGludWUoY29udGVudCk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChjLmZyb250bWF0dGVyLnN0YXR1cywgc3RhdHVzLCBgc3RhdHVzIHZhcmlhbnQ6ICR7c3RhdHVzfWApO1xuICB9XG59KTtcblxudGVzdCgncGFyc2VDb250aW51ZTogbWlzc2luZyBmcm9udG1hdHRlcicsICgpID0+IHtcbiAgY29uc3QgY29udGVudCA9IGAjIyBDb21wbGV0ZWQgV29ya1xuXG5Tb21lIHdvcmsgZG9uZS5cblxuIyMgUmVtYWluaW5nIFdvcmtcblxuTW9yZSB0byBkby5cblxuIyMgRGVjaXNpb25zIE1hZGVcblxuQSBkZWNpc2lvbi5cblxuIyMgQ29udGV4dFxuXG5Tb21lIGNvbnRleHQuXG5cbiMjIE5leHQgQWN0aW9uXG5cbk5leHQgdGhpbmcuXG5gO1xuXG4gIGNvbnN0IGMgPSBwYXJzZUNvbnRpbnVlKGNvbnRlbnQpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGMuZnJvbnRtYXR0ZXIubWlsZXN0b25lLCAnJywgJ2RlZmF1bHQgbWlsZXN0b25lIGVtcHR5Jyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoYy5mcm9udG1hdHRlci5zbGljZSwgJycsICdkZWZhdWx0IHNsaWNlIGVtcHR5Jyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoYy5mcm9udG1hdHRlci50YXNrLCAnJywgJ2RlZmF1bHQgdGFzayBlbXB0eScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGMuZnJvbnRtYXR0ZXIuc3RlcCwgMCwgJ2RlZmF1bHQgc3RlcCAwJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoYy5mcm9udG1hdHRlci50b3RhbFN0ZXBzLCAwLCAnZGVmYXVsdCB0b3RhbFN0ZXBzIDAnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChjLmZyb250bWF0dGVyLnN0YXR1cywgJ2luX3Byb2dyZXNzJywgJ2RlZmF1bHQgc3RhdHVzIGluX3Byb2dyZXNzJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoYy5mcm9udG1hdHRlci5zYXZlZEF0LCAnJywgJ2RlZmF1bHQgc2F2ZWRBdCBlbXB0eScpO1xuXG4gIC8vIEJvZHkgc2VjdGlvbnMgc3RpbGwgcGFyc2VcbiAgYXNzZXJ0Lm9rKGMuY29tcGxldGVkV29yay5pbmNsdWRlcygnU29tZSB3b3JrIGRvbmUnKSwgJ2NvbXBsZXRlZFdvcmsgd2l0aG91dCBmcm9udG1hdHRlcicpO1xuICBhc3NlcnQub2soYy5yZW1haW5pbmdXb3JrLmluY2x1ZGVzKCdNb3JlIHRvIGRvJyksICdyZW1haW5pbmdXb3JrIHdpdGhvdXQgZnJvbnRtYXR0ZXInKTtcbiAgYXNzZXJ0Lm9rKGMuZGVjaXNpb25zLmluY2x1ZGVzKCdBIGRlY2lzaW9uJyksICdkZWNpc2lvbnMgd2l0aG91dCBmcm9udG1hdHRlcicpO1xuICBhc3NlcnQub2soYy5jb250ZXh0LmluY2x1ZGVzKCdTb21lIGNvbnRleHQnKSwgJ2NvbnRleHQgd2l0aG91dCBmcm9udG1hdHRlcicpO1xuICBhc3NlcnQub2soYy5uZXh0QWN0aW9uLmluY2x1ZGVzKCdOZXh0IHRoaW5nJyksICduZXh0QWN0aW9uIHdpdGhvdXQgZnJvbnRtYXR0ZXInKTtcbn0pO1xuXG50ZXN0KCdwYXJzZUNvbnRpbnVlOiBib2R5IHNlY3Rpb24gZXh0cmFjdGlvbicsICgpID0+IHtcbiAgY29uc3QgY29udGVudCA9IGAtLS1cbm1pbGVzdG9uZTogTTAwMVxuc2xpY2U6IFMwMVxudGFzazogVDAzXG5zdGVwOiAyXG50b3RhbF9zdGVwczogNFxuc3RhdHVzOiBpbnRlcnJ1cHRlZFxuc2F2ZWRfYXQ6IDIwMjUtMDMtMTBUMTE6MDA6MDBaXG4tLS1cblxuIyMgQ29tcGxldGVkIFdvcmtcblxuRmlyc3QgcGFyYWdyYXBoIG9mIGNvbXBsZXRlZCB3b3JrLlxuU2Vjb25kIHBhcmFncmFwaCBjb250aW51aW5nIHRoZSBleHBsYW5hdGlvbi5cblxuIyMgUmVtYWluaW5nIFdvcmtcblxuTmVlZCB0byBmaW5pc2ggc3RlcCAzIGFuZCBzdGVwIDQuXG5cbiMjIERlY2lzaW9ucyBNYWRlXG5cbkRlY2lkZWQgdG8gdXNlIGFwcHJvYWNoIEEgb3ZlciBhcHByb2FjaCBCIGJlY2F1c2Ugb2YgcGVyZm9ybWFuY2UuXG5cbiMjIENvbnRleHRcblxuUnVubmluZyBpbiB3b3JrdHJlZS4gTm9kZSAyMiByZXF1aXJlZC4gVHlwZVNjcmlwdCBzdHJpY3QgbW9kZS5cblxuIyMgTmV4dCBBY3Rpb25cblxuUGljayB1cCBhdCBzdGVwIDM6IHJ1biB0aGUgaW50ZWdyYXRpb24gdGVzdHMuXG5gO1xuXG4gIGNvbnN0IGMgPSBwYXJzZUNvbnRpbnVlKGNvbnRlbnQpO1xuICBhc3NlcnQub2soYy5jb21wbGV0ZWRXb3JrLmluY2x1ZGVzKCdGaXJzdCBwYXJhZ3JhcGgnKSwgJ2NvbXBsZXRlZFdvcmsgZmlyc3QgcGFyYWdyYXBoJyk7XG4gIGFzc2VydC5vayhjLmNvbXBsZXRlZFdvcmsuaW5jbHVkZXMoJ1NlY29uZCBwYXJhZ3JhcGgnKSwgJ2NvbXBsZXRlZFdvcmsgc2Vjb25kIHBhcmFncmFwaCcpO1xuICBhc3NlcnQub2soYy5yZW1haW5pbmdXb3JrLmluY2x1ZGVzKCdzdGVwIDMgYW5kIHN0ZXAgNCcpLCAncmVtYWluaW5nV29yayBkZXRhaWwnKTtcbiAgYXNzZXJ0Lm9rKGMuZGVjaXNpb25zLmluY2x1ZGVzKCdhcHByb2FjaCBBIG92ZXIgYXBwcm9hY2ggQicpLCAnZGVjaXNpb25zIGRldGFpbCcpO1xuICBhc3NlcnQub2soYy5jb250ZXh0LmluY2x1ZGVzKCdOb2RlIDIyIHJlcXVpcmVkJyksICdjb250ZXh0IGRldGFpbCcpO1xuICBhc3NlcnQub2soYy5uZXh0QWN0aW9uLmluY2x1ZGVzKCdzdGVwIDM6IHJ1biB0aGUgaW50ZWdyYXRpb24gdGVzdHMnKSwgJ25leHRBY3Rpb24gZGV0YWlsJyk7XG59KTtcblxudGVzdCgncGFyc2VDb250aW51ZTogdG90YWxfc3RlcHMgdnMgdG90YWxTdGVwcyBrZXkgc3VwcG9ydCcsICgpID0+IHtcbiAgLy8gVGVzdCB0b3RhbF9zdGVwcyAoc25ha2VfY2FzZSkgXHUyMDE0IHRoZSBwcmltYXJ5IGZvcm1hdFxuICBjb25zdCBjb250ZW50MSA9IGAtLS1cbm1pbGVzdG9uZTogTTAwMVxuc2xpY2U6IFMwMVxudGFzazogVDAxXG5zdGVwOiAyXG50b3RhbF9zdGVwczogOFxuc3RhdHVzOiBpbl9wcm9ncmVzc1xuc2F2ZWRfYXQ6IDIwMjUtMDMtMTBUMTI6MDA6MDBaXG4tLS1cblxuIyMgQ29tcGxldGVkIFdvcmtcblxuV29yay5cbmA7XG5cbiAgY29uc3QgYzEgPSBwYXJzZUNvbnRpbnVlKGNvbnRlbnQxKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChjMS5mcm9udG1hdHRlci50b3RhbFN0ZXBzLCA4LCAndG90YWxfc3RlcHMgc25ha2VfY2FzZSB3b3JrcycpO1xuXG4gIC8vIFRlc3QgdG90YWxTdGVwcyAoY2FtZWxDYXNlKSBcdTIwMTQgdGhlIGZhbGxiYWNrXG4gIGNvbnN0IGNvbnRlbnQyID0gYC0tLVxubWlsZXN0b25lOiBNMDAxXG5zbGljZTogUzAxXG50YXNrOiBUMDFcbnN0ZXA6IDJcbnRvdGFsU3RlcHM6IDZcbnN0YXR1czogaW5fcHJvZ3Jlc3NcbnNhdmVkX2F0OiAyMDI1LTAzLTEwVDEyOjAwOjAwWlxuLS0tXG5cbiMjIENvbXBsZXRlZCBXb3JrXG5cbldvcmsuXG5gO1xuXG4gIGNvbnN0IGMyID0gcGFyc2VDb250aW51ZShjb250ZW50Mik7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoYzIuZnJvbnRtYXR0ZXIudG90YWxTdGVwcywgNiwgJ3RvdGFsU3RlcHMgY2FtZWxDYXNlIHdvcmtzJyk7XG59KTtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBwYXJzZVJlcXVpcmVtZW50Q291bnRzIHRlc3RzXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbnRlc3QoJ3BhcnNlUmVxdWlyZW1lbnRDb3VudHM6IGZ1bGwgcmVxdWlyZW1lbnRzIGZpbGUnLCAoKSA9PiB7XG4gIGNvbnN0IGNvbnRlbnQgPSBgIyBSZXF1aXJlbWVudHNcblxuIyMgQWN0aXZlXG5cbiMjIyBSMDAxIFx1MjAxNCBVc2VyIGF1dGhlbnRpY2F0aW9uXG4tIFN0YXR1czogYWN0aXZlXG5cbiMjIyBSMDAyIFx1MjAxNCBEYXNoYm9hcmQgcmVuZGVyaW5nXG4tIFN0YXR1czogYmxvY2tlZFxuXG4jIyMgUjAwMyBcdTIwMTQgQVBJIHJhdGUgbGltaXRpbmdcbi0gU3RhdHVzOiBhY3RpdmVcblxuIyMgVmFsaWRhdGVkXG5cbiMjIyBSMDEwIFx1MjAxNCBQYXJzZXIgdGVzdCBjb3ZlcmFnZVxuLSBTdGF0dXM6IHZhbGlkYXRlZFxuXG4jIyMgUjAxMSBcdTIwMTQgVHlwZSBzeXN0ZW1cbi0gU3RhdHVzOiB2YWxpZGF0ZWRcblxuIyMgRGVmZXJyZWRcblxuIyMjIFIwMjAgXHUyMDE0IEFkbWluIHBhbmVsXG4tIFN0YXR1czogZGVmZXJyZWRcblxuIyMgT3V0IG9mIFNjb3BlXG5cbiMjIyBSMDMwIFx1MjAxNCBNb2JpbGUgYXBwXG4tIFN0YXR1czogb3V0LW9mLXNjb3BlXG5cbiMjIyBSMDMxIFx1MjAxNCBEZXNrdG9wIGFwcFxuLSBTdGF0dXM6IG91dC1vZi1zY29wZVxuYDtcblxuICBjb25zdCBjb3VudHMgPSBwYXJzZVJlcXVpcmVtZW50Q291bnRzKGNvbnRlbnQpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGNvdW50cy5hY3RpdmUsIDMsICdhY3RpdmUgY291bnQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChjb3VudHMudmFsaWRhdGVkLCAyLCAndmFsaWRhdGVkIGNvdW50Jyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoY291bnRzLmRlZmVycmVkLCAxLCAnZGVmZXJyZWQgY291bnQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChjb3VudHMub3V0T2ZTY29wZSwgMiwgJ291dE9mU2NvcGUgY291bnQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChjb3VudHMuYmxvY2tlZCwgMSwgJ2Jsb2NrZWQgY291bnQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChjb3VudHMudG90YWwsIDgsICd0b3RhbCBpcyBzdW0gb2YgYWN0aXZlK3ZhbGlkYXRlZCtkZWZlcnJlZCtvdXRPZlNjb3BlJyk7XG59KTtcblxudGVzdCgncGFyc2VSZXF1aXJlbWVudENvdW50czogbnVsbCBpbnB1dCByZXR1cm5zIGFsbCB6ZXJvcycsICgpID0+IHtcbiAgY29uc3QgY291bnRzID0gcGFyc2VSZXF1aXJlbWVudENvdW50cyhudWxsKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChjb3VudHMuYWN0aXZlLCAwLCAnbnVsbCBhY3RpdmUnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChjb3VudHMudmFsaWRhdGVkLCAwLCAnbnVsbCB2YWxpZGF0ZWQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChjb3VudHMuZGVmZXJyZWQsIDAsICdudWxsIGRlZmVycmVkJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoY291bnRzLm91dE9mU2NvcGUsIDAsICdudWxsIG91dE9mU2NvcGUnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChjb3VudHMuYmxvY2tlZCwgMCwgJ251bGwgYmxvY2tlZCcpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGNvdW50cy50b3RhbCwgMCwgJ251bGwgdG90YWwnKTtcbn0pO1xuXG50ZXN0KCdwYXJzZVJlcXVpcmVtZW50Q291bnRzOiBlbXB0eSBzZWN0aW9ucyByZXR1cm4gemVybyBjb3VudHMnLCAoKSA9PiB7XG4gIGNvbnN0IGNvbnRlbnQgPSBgIyBSZXF1aXJlbWVudHNcblxuIyMgQWN0aXZlXG5cbiMjIFZhbGlkYXRlZFxuXG4jIyBEZWZlcnJlZFxuXG4jIyBPdXQgb2YgU2NvcGVcbmA7XG5cbiAgY29uc3QgY291bnRzID0gcGFyc2VSZXF1aXJlbWVudENvdW50cyhjb250ZW50KTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChjb3VudHMuYWN0aXZlLCAwLCAnZW1wdHkgYWN0aXZlJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoY291bnRzLnZhbGlkYXRlZCwgMCwgJ2VtcHR5IHZhbGlkYXRlZCcpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGNvdW50cy5kZWZlcnJlZCwgMCwgJ2VtcHR5IGRlZmVycmVkJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoY291bnRzLm91dE9mU2NvcGUsIDAsICdlbXB0eSBvdXRPZlNjb3BlJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoY291bnRzLmJsb2NrZWQsIDAsICdlbXB0eSBibG9ja2VkJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoY291bnRzLnRvdGFsLCAwLCAnZW1wdHkgdG90YWwnKTtcbn0pO1xuXG50ZXN0KCdwYXJzZVJlcXVpcmVtZW50Q291bnRzOiBibG9ja2VkIHN0YXR1cyBjb3VudGluZycsICgpID0+IHtcbiAgY29uc3QgY29udGVudCA9IGAjIFJlcXVpcmVtZW50c1xuXG4jIyBBY3RpdmVcblxuIyMjIFIwMDEgXHUyMDE0IEJsb2NrZWQgdGhpbmdcbi0gU3RhdHVzOiBibG9ja2VkXG5cbiMjIyBSMDAyIFx1MjAxNCBBbm90aGVyIGJsb2NrZWQgdGhpbmdcbi0gU3RhdHVzOiBibG9ja2VkXG5cbiMjIyBSMDAzIFx1MjAxNCBBY3RpdmUgdGhpbmdcbi0gU3RhdHVzOiBhY3RpdmVcblxuIyMgVmFsaWRhdGVkXG5cbiMjIERlZmVycmVkXG5cbiMjIyBSMDIwIFx1MjAxNCBCbG9ja2VkIGRlZmVycmVkXG4tIFN0YXR1czogYmxvY2tlZFxuXG4jIyBPdXQgb2YgU2NvcGVcbmA7XG5cbiAgY29uc3QgY291bnRzID0gcGFyc2VSZXF1aXJlbWVudENvdW50cyhjb250ZW50KTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChjb3VudHMuYWN0aXZlLCAzLCAnYWN0aXZlIGluY2x1ZGVzIGJsb2NrZWQgaXRlbXMgaW4gQWN0aXZlIHNlY3Rpb24nKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChjb3VudHMuYmxvY2tlZCwgMywgJ2Jsb2NrZWQgY291bnRzIGFsbCBibG9ja2VkIHN0YXR1c2VzIGFjcm9zcyBzZWN0aW9ucycpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGNvdW50cy5kZWZlcnJlZCwgMSwgJ2RlZmVycmVkIHNlY3Rpb24gY291bnQnKTtcbn0pO1xuXG50ZXN0KCdwYXJzZVJlcXVpcmVtZW50Q291bnRzOiB0b3RhbCBpcyBzdW0gb2YgYWxsIHNlY3Rpb24gY291bnRzJywgKCkgPT4ge1xuICBjb25zdCBjb250ZW50ID0gYCMgUmVxdWlyZW1lbnRzXG5cbiMjIEFjdGl2ZVxuXG4jIyMgUjAwMSBcdTIwMTQgT25lXG4tIFN0YXR1czogYWN0aXZlXG5cbiMjIFZhbGlkYXRlZFxuXG4jIyMgUjAxMCBcdTIwMTQgVHdvXG4tIFN0YXR1czogdmFsaWRhdGVkXG5cbiMjIyBSMDExIFx1MjAxNCBUaHJlZVxuLSBTdGF0dXM6IHZhbGlkYXRlZFxuXG4jIyBEZWZlcnJlZFxuXG4jIyMgUjAyMCBcdTIwMTQgRm91clxuLSBTdGF0dXM6IGRlZmVycmVkXG5cbiMjIyBSMDIxIFx1MjAxNCBGaXZlXG4tIFN0YXR1czogZGVmZXJyZWRcblxuIyMjIFIwMjIgXHUyMDE0IFNpeFxuLSBTdGF0dXM6IGRlZmVycmVkXG5cbiMjIE91dCBvZiBTY29wZVxuXG4jIyMgUjAzMCBcdTIwMTQgU2V2ZW5cbi0gU3RhdHVzOiBvdXQtb2Ytc2NvcGVcbmA7XG5cbiAgY29uc3QgY291bnRzID0gcGFyc2VSZXF1aXJlbWVudENvdW50cyhjb250ZW50KTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChjb3VudHMuYWN0aXZlLCAxLCAnb25lIGFjdGl2ZScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGNvdW50cy52YWxpZGF0ZWQsIDIsICd0d28gdmFsaWRhdGVkJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoY291bnRzLmRlZmVycmVkLCAzLCAndGhyZWUgZGVmZXJyZWQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChjb3VudHMub3V0T2ZTY29wZSwgMSwgJ29uZSBvdXRPZlNjb3BlJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoY291bnRzLnRvdGFsLCA3LCAndG90YWwgPSAxICsgMiArIDMgKyAxJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoY291bnRzLnRvdGFsLCBjb3VudHMuYWN0aXZlICsgY291bnRzLnZhbGlkYXRlZCArIGNvdW50cy5kZWZlcnJlZCArIGNvdW50cy5vdXRPZlNjb3BlLCAndG90YWwgaXMgZXhhY3Qgc3VtJyk7XG59KTtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBwYXJzZVNlY3JldHNNYW5pZmVzdCAvIGZvcm1hdFNlY3JldHNNYW5pZmVzdCB0ZXN0c1xuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG50ZXN0KCdwYXJzZVNlY3JldHNNYW5pZmVzdDogZnVsbCBtYW5pZmVzdCB3aXRoIDMga2V5cycsICgpID0+IHtcbiAgY29uc3QgY29udGVudCA9IGAjIFNlY3JldHMgTWFuaWZlc3RcblxuKipNaWxlc3RvbmU6KiogTTAwM1xuKipHZW5lcmF0ZWQ6KiogMjAyNS0wNi0xNVQxMDowMDowMFpcblxuIyMjIE9QRU5BSV9BUElfS0VZXG5cbioqU2VydmljZToqKiBPcGVuQUlcbioqRGFzaGJvYXJkOioqIGh0dHBzOi8vcGxhdGZvcm0ub3BlbmFpLmNvbS9hcGkta2V5c1xuKipGb3JtYXQgaGludDoqKiBzdGFydHMgd2l0aCBzay1cbioqU3RhdHVzOioqIHBlbmRpbmdcbioqRGVzdGluYXRpb246KiogZG90ZW52XG5cbjEuIEdvIHRvIGh0dHBzOi8vcGxhdGZvcm0ub3BlbmFpLmNvbS9hcGkta2V5c1xuMi4gQ2xpY2sgXCJDcmVhdGUgbmV3IHNlY3JldCBrZXlcIlxuMy4gQ29weSB0aGUga2V5IGltbWVkaWF0ZWx5IFx1MjAxNCBpdCB3b24ndCBiZSBzaG93biBhZ2FpblxuXG4jIyMgU1RSSVBFX1NFQ1JFVF9LRVlcblxuKipTZXJ2aWNlOioqIFN0cmlwZVxuKipEYXNoYm9hcmQ6KiogaHR0cHM6Ly9kYXNoYm9hcmQuc3RyaXBlLmNvbS9hcGlrZXlzXG4qKkZvcm1hdCBoaW50OioqIHN0YXJ0cyB3aXRoIHNrX3Rlc3RfIG9yIHNrX2xpdmVfXG4qKlN0YXR1czoqKiBjb2xsZWN0ZWRcbioqRGVzdGluYXRpb246KiogZG90ZW52XG5cbjEuIEdvIHRvIGh0dHBzOi8vZGFzaGJvYXJkLnN0cmlwZS5jb20vYXBpa2V5c1xuMi4gUmV2ZWFsIHRoZSBzZWNyZXQga2V5XG4zLiBDb3B5IGl0XG5cbiMjIyBTVVBBQkFTRV9VUkxcblxuKipTZXJ2aWNlOioqIFN1cGFiYXNlXG4qKkRhc2hib2FyZDoqKiBodHRwczovL2FwcC5zdXBhYmFzZS5jb20vcHJvamVjdC9zZXR0aW5ncy9hcGlcbioqRm9ybWF0IGhpbnQ6KiogaHR0cHM6Ly88cHJvamVjdC1yZWY+LnN1cGFiYXNlLmNvXG4qKlN0YXR1czoqKiBza2lwcGVkXG4qKkRlc3RpbmF0aW9uOioqIHZlcmNlbFxuXG4xLiBHbyB0byBwcm9qZWN0IHNldHRpbmdzIGluIFN1cGFiYXNlXG4yLiBDb3B5IHRoZSBVUkwgZnJvbSB0aGUgQVBJIHNlY3Rpb25cbmA7XG5cbiAgY29uc3QgbSA9IHBhcnNlU2VjcmV0c01hbmlmZXN0KGNvbnRlbnQpO1xuXG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwobS5taWxlc3RvbmUsICdNMDAzJywgJ21hbmlmZXN0IG1pbGVzdG9uZScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKG0uZ2VuZXJhdGVkQXQsICcyMDI1LTA2LTE1VDEwOjAwOjAwWicsICdtYW5pZmVzdCBnZW5lcmF0ZWRBdCcpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKG0uZW50cmllcy5sZW5ndGgsIDMsICd0aHJlZSBlbnRyaWVzJyk7XG5cbiAgLy8gRmlyc3QgZW50cnlcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChtLmVudHJpZXNbMF0ua2V5LCAnT1BFTkFJX0FQSV9LRVknLCAnZW50cnkgMCBrZXknKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChtLmVudHJpZXNbMF0uc2VydmljZSwgJ09wZW5BSScsICdlbnRyeSAwIHNlcnZpY2UnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChtLmVudHJpZXNbMF0uZGFzaGJvYXJkVXJsLCAnaHR0cHM6Ly9wbGF0Zm9ybS5vcGVuYWkuY29tL2FwaS1rZXlzJywgJ2VudHJ5IDAgZGFzaGJvYXJkVXJsJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwobS5lbnRyaWVzWzBdLmZvcm1hdEhpbnQsICdzdGFydHMgd2l0aCBzay0nLCAnZW50cnkgMCBmb3JtYXRIaW50Jyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwobS5lbnRyaWVzWzBdLnN0YXR1cywgJ3BlbmRpbmcnLCAnZW50cnkgMCBzdGF0dXMnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChtLmVudHJpZXNbMF0uZGVzdGluYXRpb24sICdkb3RlbnYnLCAnZW50cnkgMCBkZXN0aW5hdGlvbicpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKG0uZW50cmllc1swXS5ndWlkYW5jZS5sZW5ndGgsIDMsICdlbnRyeSAwIGd1aWRhbmNlIGNvdW50Jyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwobS5lbnRyaWVzWzBdLmd1aWRhbmNlWzBdLCAnR28gdG8gaHR0cHM6Ly9wbGF0Zm9ybS5vcGVuYWkuY29tL2FwaS1rZXlzJywgJ2VudHJ5IDAgZ3VpZGFuY2VbMF0nKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChtLmVudHJpZXNbMF0uZ3VpZGFuY2VbMl0sICdDb3B5IHRoZSBrZXkgaW1tZWRpYXRlbHkgXHUyMDE0IGl0IHdvblxcJ3QgYmUgc2hvd24gYWdhaW4nLCAnZW50cnkgMCBndWlkYW5jZVsyXScpO1xuXG4gIC8vIFNlY29uZCBlbnRyeVxuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKG0uZW50cmllc1sxXS5rZXksICdTVFJJUEVfU0VDUkVUX0tFWScsICdlbnRyeSAxIGtleScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKG0uZW50cmllc1sxXS5zZXJ2aWNlLCAnU3RyaXBlJywgJ2VudHJ5IDEgc2VydmljZScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKG0uZW50cmllc1sxXS5zdGF0dXMsICdjb2xsZWN0ZWQnLCAnZW50cnkgMSBzdGF0dXMnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChtLmVudHJpZXNbMV0uZm9ybWF0SGludCwgJ3N0YXJ0cyB3aXRoIHNrX3Rlc3RfIG9yIHNrX2xpdmVfJywgJ2VudHJ5IDEgZm9ybWF0SGludCcpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKG0uZW50cmllc1sxXS5ndWlkYW5jZS5sZW5ndGgsIDMsICdlbnRyeSAxIGd1aWRhbmNlIGNvdW50Jyk7XG5cbiAgLy8gVGhpcmQgZW50cnlcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChtLmVudHJpZXNbMl0ua2V5LCAnU1VQQUJBU0VfVVJMJywgJ2VudHJ5IDIga2V5Jyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwobS5lbnRyaWVzWzJdLnN0YXR1cywgJ3NraXBwZWQnLCAnZW50cnkgMiBzdGF0dXMnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChtLmVudHJpZXNbMl0uZGVzdGluYXRpb24sICd2ZXJjZWwnLCAnZW50cnkgMiBkZXN0aW5hdGlvbicpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKG0uZW50cmllc1syXS5ndWlkYW5jZS5sZW5ndGgsIDIsICdlbnRyeSAyIGd1aWRhbmNlIGNvdW50Jyk7XG59KTtcblxudGVzdCgncGFyc2VTZWNyZXRzTWFuaWZlc3Q6IHNpbmdsZS1rZXkgbWFuaWZlc3QnLCAoKSA9PiB7XG4gIGNvbnN0IGNvbnRlbnQgPSBgIyBTZWNyZXRzIE1hbmlmZXN0XG5cbioqTWlsZXN0b25lOioqIE0wMDFcbioqR2VuZXJhdGVkOioqIDIwMjUtMDYtMTVUMTI6MDA6MDBaXG5cbiMjIyBEQVRBQkFTRV9VUkxcblxuKipTZXJ2aWNlOioqIFBvc3RncmVTUUxcbioqRGFzaGJvYXJkOioqIGh0dHBzOi8vY29uc29sZS5uZW9uLnRlY2hcbioqRm9ybWF0IGhpbnQ6KiogcG9zdGdyZXNxbDovLy4uLlxuKipTdGF0dXM6KiogcGVuZGluZ1xuKipEZXN0aW5hdGlvbjoqKiBkb3RlbnZcblxuMS4gQ3JlYXRlIGEgZGF0YWJhc2Ugb24gTmVvblxuMi4gQ29weSB0aGUgY29ubmVjdGlvbiBzdHJpbmdcbmA7XG5cbiAgY29uc3QgbSA9IHBhcnNlU2VjcmV0c01hbmlmZXN0KGNvbnRlbnQpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKG0ubWlsZXN0b25lLCAnTTAwMScsICdzaW5nbGUta2V5IG1pbGVzdG9uZScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKG0uZW50cmllcy5sZW5ndGgsIDEsICdzaW5nbGUgZW50cnknKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChtLmVudHJpZXNbMF0ua2V5LCAnREFUQUJBU0VfVVJMJywgJ3NpbmdsZSBlbnRyeSBrZXknKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChtLmVudHJpZXNbMF0uc2VydmljZSwgJ1Bvc3RncmVTUUwnLCAnc2luZ2xlIGVudHJ5IHNlcnZpY2UnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChtLmVudHJpZXNbMF0uZ3VpZGFuY2UubGVuZ3RoLCAyLCAnc2luZ2xlIGVudHJ5IGd1aWRhbmNlIGNvdW50Jyk7XG59KTtcblxudGVzdCgncGFyc2VTZWNyZXRzTWFuaWZlc3Q6IGVtcHR5L25vLXNlY3JldHMgbWFuaWZlc3QnLCAoKSA9PiB7XG4gIGNvbnN0IGNvbnRlbnQgPSBgIyBTZWNyZXRzIE1hbmlmZXN0XG5cbioqTWlsZXN0b25lOioqIE0wMDJcbioqR2VuZXJhdGVkOioqIDIwMjUtMDYtMTVUMTQ6MDA6MDBaXG5gO1xuXG4gIGNvbnN0IG0gPSBwYXJzZVNlY3JldHNNYW5pZmVzdChjb250ZW50KTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChtLm1pbGVzdG9uZSwgJ00wMDInLCAnZW1wdHkgbWFuaWZlc3QgbWlsZXN0b25lJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwobS5nZW5lcmF0ZWRBdCwgJzIwMjUtMDYtMTVUMTQ6MDA6MDBaJywgJ2VtcHR5IG1hbmlmZXN0IGdlbmVyYXRlZEF0Jyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwobS5lbnRyaWVzLmxlbmd0aCwgMCwgJ25vIGVudHJpZXMgaW4gZW1wdHkgbWFuaWZlc3QnKTtcbn0pO1xuXG50ZXN0KCdwYXJzZVNlY3JldHNNYW5pZmVzdDogbWlzc2luZyBvcHRpb25hbCBmaWVsZHMgZGVmYXVsdCBjb3JyZWN0bHknLCAoKSA9PiB7XG4gIGNvbnN0IGNvbnRlbnQgPSBgIyBTZWNyZXRzIE1hbmlmZXN0XG5cbioqTWlsZXN0b25lOioqIE0wMDRcbioqR2VuZXJhdGVkOioqIDIwMjUtMDYtMTVUMTY6MDA6MDBaXG5cbiMjIyBTT01FX0FQSV9LRVlcblxuKipTZXJ2aWNlOioqIFNvbWVTZXJ2aWNlXG5cbjEuIEdldCB0aGUga2V5IGZyb20gdGhlIGRhc2hib2FyZFxuYDtcblxuICBjb25zdCBtID0gcGFyc2VTZWNyZXRzTWFuaWZlc3QoY29udGVudCk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwobS5lbnRyaWVzLmxlbmd0aCwgMSwgJ29uZSBlbnRyeSB3aXRoIG1pc3NpbmcgZmllbGRzJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwobS5lbnRyaWVzWzBdLmtleSwgJ1NPTUVfQVBJX0tFWScsICdrZXkgcGFyc2VkJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwobS5lbnRyaWVzWzBdLnNlcnZpY2UsICdTb21lU2VydmljZScsICdzZXJ2aWNlIHBhcnNlZCcpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKG0uZW50cmllc1swXS5kYXNoYm9hcmRVcmwsICcnLCAnbWlzc2luZyBkYXNoYm9hcmRVcmwgZGVmYXVsdHMgdG8gZW1wdHkgc3RyaW5nJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwobS5lbnRyaWVzWzBdLmZvcm1hdEhpbnQsICcnLCAnbWlzc2luZyBmb3JtYXRIaW50IGRlZmF1bHRzIHRvIGVtcHR5IHN0cmluZycpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKG0uZW50cmllc1swXS5zdGF0dXMsICdwZW5kaW5nJywgJ21pc3Npbmcgc3RhdHVzIGRlZmF1bHRzIHRvIHBlbmRpbmcnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChtLmVudHJpZXNbMF0uZGVzdGluYXRpb24sICdkb3RlbnYnLCAnbWlzc2luZyBkZXN0aW5hdGlvbiBkZWZhdWx0cyB0byBkb3RlbnYnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChtLmVudHJpZXNbMF0uZ3VpZGFuY2UubGVuZ3RoLCAxLCAnZ3VpZGFuY2Ugc3RpbGwgcGFyc2VkJyk7XG59KTtcblxudGVzdCgncGFyc2VTZWNyZXRzTWFuaWZlc3Q6IGFsbCB0aHJlZSBzdGF0dXMgdmFsdWVzIHBhcnNlJywgKCkgPT4ge1xuICBmb3IgKGNvbnN0IHN0YXR1cyBvZiBbJ3BlbmRpbmcnLCAnY29sbGVjdGVkJywgJ3NraXBwZWQnXSBhcyBjb25zdCkge1xuICAgIGNvbnN0IGNvbnRlbnQgPSBgIyBTZWNyZXRzIE1hbmlmZXN0XG5cbioqTWlsZXN0b25lOioqIE0wMDVcbioqR2VuZXJhdGVkOioqIDIwMjUtMDYtMTVUMTg6MDA6MDBaXG5cbiMjIyBURVNUX0tFWVxuXG4qKlNlcnZpY2U6KiogVGVzdFNlcnZpY2VcbioqU3RhdHVzOioqICR7c3RhdHVzfVxuXG4xLiBEbyBzb21ldGhpbmdcbmA7XG5cbiAgICBjb25zdCBtID0gcGFyc2VTZWNyZXRzTWFuaWZlc3QoY29udGVudCk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChtLmVudHJpZXNbMF0uc3RhdHVzLCBzdGF0dXMsIGBzdGF0dXMgdmFyaWFudDogJHtzdGF0dXN9YCk7XG4gIH1cbn0pO1xuXG50ZXN0KCdwYXJzZVNlY3JldHNNYW5pZmVzdDogaW52YWxpZCBzdGF0dXMgZGVmYXVsdHMgdG8gcGVuZGluZycsICgpID0+IHtcbiAgY29uc3QgY29udGVudCA9IGAjIFNlY3JldHMgTWFuaWZlc3RcblxuKipNaWxlc3RvbmU6KiogTTAwNlxuKipHZW5lcmF0ZWQ6KiogMjAyNS0wNi0xNVQyMDowMDowMFpcblxuIyMjIEJBRF9TVEFUVVNfS0VZXG5cbioqU2VydmljZToqKiBUZXN0U2VydmljZVxuKipTdGF0dXM6KiogaW52YWxpZF92YWx1ZVxuXG4xLiBTb21lIHN0ZXBcbmA7XG5cbiAgY29uc3QgbSA9IHBhcnNlU2VjcmV0c01hbmlmZXN0KGNvbnRlbnQpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKG0uZW50cmllc1swXS5zdGF0dXMsICdwZW5kaW5nJywgJ2ludmFsaWQgc3RhdHVzIGRlZmF1bHRzIHRvIHBlbmRpbmcnKTtcbn0pO1xuXG50ZXN0KCdwYXJzZVNlY3JldHNNYW5pZmVzdCArIGZvcm1hdFNlY3JldHNNYW5pZmVzdDogcm91bmQtdHJpcCcsICgpID0+IHtcbiAgY29uc3Qgb3JpZ2luYWwgPSBgIyBTZWNyZXRzIE1hbmlmZXN0XG5cbioqTWlsZXN0b25lOioqIE0wMDdcbioqR2VuZXJhdGVkOioqIDIwMjUtMDYtMTZUMTA6MDA6MDBaXG5cbiMjIyBPUEVOQUlfQVBJX0tFWVxuXG4qKlNlcnZpY2U6KiogT3BlbkFJXG4qKkRhc2hib2FyZDoqKiBodHRwczovL3BsYXRmb3JtLm9wZW5haS5jb20vYXBpLWtleXNcbioqRm9ybWF0IGhpbnQ6Kiogc3RhcnRzIHdpdGggc2stXG4qKlN0YXR1czoqKiBwZW5kaW5nXG4qKkRlc3RpbmF0aW9uOioqIGRvdGVudlxuXG4xLiBHbyB0byB0aGUgQVBJIGtleXMgcGFnZVxuMi4gQ3JlYXRlIGEgbmV3IGtleVxuMy4gQ29weSBpdFxuXG4jIyMgUkVESVNfVVJMXG5cbioqU2VydmljZToqKiBVcHN0YXNoXG4qKkRhc2hib2FyZDoqKiBodHRwczovL2NvbnNvbGUudXBzdGFzaC5jb21cbioqRm9ybWF0IGhpbnQ6KiogcmVkaXM6Ly8uLi5cbioqU3RhdHVzOioqIGNvbGxlY3RlZFxuKipEZXN0aW5hdGlvbjoqKiB2ZXJjZWxcblxuMS4gT3BlbiBVcHN0YXNoIGNvbnNvbGVcbjIuIENvcHkgdGhlIFJlZGlzIFVSTFxuYDtcblxuICBjb25zdCBwYXJzZWQxID0gcGFyc2VTZWNyZXRzTWFuaWZlc3Qob3JpZ2luYWwpO1xuICBjb25zdCBmb3JtYXR0ZWQgPSBmb3JtYXRTZWNyZXRzTWFuaWZlc3QocGFyc2VkMSk7XG4gIGNvbnN0IHBhcnNlZDIgPSBwYXJzZVNlY3JldHNNYW5pZmVzdChmb3JtYXR0ZWQpO1xuXG4gIC8vIFZlcmlmeSBzZW1hbnRpYyBlcXVhbGl0eSBhZnRlciByb3VuZC10cmlwXG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGFyc2VkMi5taWxlc3RvbmUsIHBhcnNlZDEubWlsZXN0b25lLCAncm91bmQtdHJpcCBtaWxlc3RvbmUnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwYXJzZWQyLmdlbmVyYXRlZEF0LCBwYXJzZWQxLmdlbmVyYXRlZEF0LCAncm91bmQtdHJpcCBnZW5lcmF0ZWRBdCcpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBhcnNlZDIuZW50cmllcy5sZW5ndGgsIHBhcnNlZDEuZW50cmllcy5sZW5ndGgsICdyb3VuZC10cmlwIGVudHJ5IGNvdW50Jyk7XG5cbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBwYXJzZWQxLmVudHJpZXMubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBlMSA9IHBhcnNlZDEuZW50cmllc1tpXTtcbiAgICBjb25zdCBlMiA9IHBhcnNlZDIuZW50cmllc1tpXTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGUyLmtleSwgZTEua2V5LCBgcm91bmQtdHJpcCBlbnRyeSAke2l9IGtleWApO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZTIuc2VydmljZSwgZTEuc2VydmljZSwgYHJvdW5kLXRyaXAgZW50cnkgJHtpfSBzZXJ2aWNlYCk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChlMi5kYXNoYm9hcmRVcmwsIGUxLmRhc2hib2FyZFVybCwgYHJvdW5kLXRyaXAgZW50cnkgJHtpfSBkYXNoYm9hcmRVcmxgKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGUyLmZvcm1hdEhpbnQsIGUxLmZvcm1hdEhpbnQsIGByb3VuZC10cmlwIGVudHJ5ICR7aX0gZm9ybWF0SGludGApO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZTIuc3RhdHVzLCBlMS5zdGF0dXMsIGByb3VuZC10cmlwIGVudHJ5ICR7aX0gc3RhdHVzYCk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChlMi5kZXN0aW5hdGlvbiwgZTEuZGVzdGluYXRpb24sIGByb3VuZC10cmlwIGVudHJ5ICR7aX0gZGVzdGluYXRpb25gKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGUyLmd1aWRhbmNlLmxlbmd0aCwgZTEuZ3VpZGFuY2UubGVuZ3RoLCBgcm91bmQtdHJpcCBlbnRyeSAke2l9IGd1aWRhbmNlIGxlbmd0aGApO1xuICAgIGZvciAobGV0IGogPSAwOyBqIDwgZTEuZ3VpZGFuY2UubGVuZ3RoOyBqKyspIHtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZTIuZ3VpZGFuY2Vbal0sIGUxLmd1aWRhbmNlW2pdLCBgcm91bmQtdHJpcCBlbnRyeSAke2l9IGd1aWRhbmNlWyR7an1dYCk7XG4gICAgfVxuICB9XG59KTtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBMTE0tc3R5bGUgcm91bmQtdHJpcCB0ZXN0cyBcdTIwMTQgcmVhbGlzdGljIG1hbmlmZXN0IHZhcmlhdGlvbnNcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxudGVzdCgnTExNIHJvdW5kLXRyaXA6IGV4dHJhIHdoaXRlc3BhY2UnLCAoKSA9PiB7XG4gIC8vIExMTXMgb2Z0ZW4gcHJvZHVjZSBpbmNvbnNpc3RlbnQgaW5kZW50YXRpb24gYW5kIHRyYWlsaW5nIHNwYWNlc1xuICBjb25zdCBtZXNzeSA9IGAjIFNlY3JldHMgTWFuaWZlc3RcblxuKipNaWxlc3RvbmU6KiogICBNMDEwICBcbioqR2VuZXJhdGVkOioqICAgMjAyNS0wNy0wMVQxMjowMDowMFogIFxuXG4jIyMgICBPUEVOQUlfQVBJX0tFWSAgXG5cbioqU2VydmljZToqKiAgIE9wZW5BSSAgXG4qKkRhc2hib2FyZDoqKiAgIGh0dHBzOi8vcGxhdGZvcm0ub3BlbmFpLmNvbS9hcGkta2V5cyAgXG4qKkZvcm1hdCBoaW50OioqICAgc3RhcnRzIHdpdGggc2stICBcbioqU3RhdHVzOioqICAgcGVuZGluZyAgXG4qKkRlc3RpbmF0aW9uOioqICAgZG90ZW52ICBcblxuMS4gICBHbyB0byB0aGUgQVBJIGtleXMgcGFnZSAgXG4yLiAgIENyZWF0ZSBhIG5ldyBrZXkgIFxuXG4jIyMgICBSRURJU19VUkwgIFxuXG4qKlNlcnZpY2U6KiogICBVcHN0YXNoICBcbioqU3RhdHVzOioqICAgY29sbGVjdGVkICBcbioqRGVzdGluYXRpb246KiogICB2ZXJjZWwgIFxuXG4xLiAgIE9wZW4gY29uc29sZSAgXG5gO1xuXG4gIGNvbnN0IHBhcnNlZDEgPSBwYXJzZVNlY3JldHNNYW5pZmVzdChtZXNzeSk7XG4gIGNvbnN0IGZvcm1hdHRlZCA9IGZvcm1hdFNlY3JldHNNYW5pZmVzdChwYXJzZWQxKTtcbiAgY29uc3QgcGFyc2VkMiA9IHBhcnNlU2VjcmV0c01hbmlmZXN0KGZvcm1hdHRlZCk7XG5cbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwYXJzZWQyLm1pbGVzdG9uZSwgcGFyc2VkMS5taWxlc3RvbmUsICd3aGl0ZXNwYWNlIHJvdW5kLXRyaXAgbWlsZXN0b25lJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGFyc2VkMi5nZW5lcmF0ZWRBdCwgcGFyc2VkMS5nZW5lcmF0ZWRBdCwgJ3doaXRlc3BhY2Ugcm91bmQtdHJpcCBnZW5lcmF0ZWRBdCcpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBhcnNlZDIuZW50cmllcy5sZW5ndGgsIHBhcnNlZDEuZW50cmllcy5sZW5ndGgsICd3aGl0ZXNwYWNlIHJvdW5kLXRyaXAgZW50cnkgY291bnQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwYXJzZWQyLmVudHJpZXMubGVuZ3RoLCAyLCAnd2hpdGVzcGFjZTogdHdvIGVudHJpZXMgcGFyc2VkJyk7XG5cbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBwYXJzZWQxLmVudHJpZXMubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBlMSA9IHBhcnNlZDEuZW50cmllc1tpXTtcbiAgICBjb25zdCBlMiA9IHBhcnNlZDIuZW50cmllc1tpXTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGUyLmtleSwgZTEua2V5LCBgd2hpdGVzcGFjZSByb3VuZC10cmlwIGVudHJ5ICR7aX0ga2V5YCk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChlMi5zZXJ2aWNlLCBlMS5zZXJ2aWNlLCBgd2hpdGVzcGFjZSByb3VuZC10cmlwIGVudHJ5ICR7aX0gc2VydmljZWApO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZTIuZGFzaGJvYXJkVXJsLCBlMS5kYXNoYm9hcmRVcmwsIGB3aGl0ZXNwYWNlIHJvdW5kLXRyaXAgZW50cnkgJHtpfSBkYXNoYm9hcmRVcmxgKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGUyLmZvcm1hdEhpbnQsIGUxLmZvcm1hdEhpbnQsIGB3aGl0ZXNwYWNlIHJvdW5kLXRyaXAgZW50cnkgJHtpfSBmb3JtYXRIaW50YCk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChlMi5zdGF0dXMsIGUxLnN0YXR1cywgYHdoaXRlc3BhY2Ugcm91bmQtdHJpcCBlbnRyeSAke2l9IHN0YXR1c2ApO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZTIuZGVzdGluYXRpb24sIGUxLmRlc3RpbmF0aW9uLCBgd2hpdGVzcGFjZSByb3VuZC10cmlwIGVudHJ5ICR7aX0gZGVzdGluYXRpb25gKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGUyLmd1aWRhbmNlLmxlbmd0aCwgZTEuZ3VpZGFuY2UubGVuZ3RoLCBgd2hpdGVzcGFjZSByb3VuZC10cmlwIGVudHJ5ICR7aX0gZ3VpZGFuY2UgbGVuZ3RoYCk7XG4gICAgZm9yIChsZXQgaiA9IDA7IGogPCBlMS5ndWlkYW5jZS5sZW5ndGg7IGorKykge1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChlMi5ndWlkYW5jZVtqXSwgZTEuZ3VpZGFuY2Vbal0sIGB3aGl0ZXNwYWNlIHJvdW5kLXRyaXAgZW50cnkgJHtpfSBndWlkYW5jZVske2p9XWApO1xuICAgIH1cbiAgfVxuXG4gIC8vIFZlcmlmeSB0aGUgcGFyc2VyIGNvcnJlY3RseSBzdHJpcHBlZCB0cmFpbGluZyB3aGl0ZXNwYWNlXG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGFyc2VkMS5taWxlc3RvbmUsICdNMDEwJywgJ3doaXRlc3BhY2U6IG1pbGVzdG9uZSB0cmltbWVkJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGFyc2VkMS5lbnRyaWVzWzBdLmtleSwgJ09QRU5BSV9BUElfS0VZJywgJ3doaXRlc3BhY2U6IGtleSB0cmltbWVkJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGFyc2VkMS5lbnRyaWVzWzBdLnNlcnZpY2UsICdPcGVuQUknLCAnd2hpdGVzcGFjZTogc2VydmljZSB0cmltbWVkJyk7XG59KTtcblxudGVzdCgnTExNIHJvdW5kLXRyaXA6IG1pc3Npbmcgb3B0aW9uYWwgZmllbGRzJywgKCkgPT4ge1xuICAvLyBMTE1zIG1heSBvbWl0IERhc2hib2FyZCBhbmQgRm9ybWF0IGhpbnQgbGluZXMgZW50aXJlbHlcbiAgY29uc3QgbWluaW1hbCA9IGAjIFNlY3JldHMgTWFuaWZlc3RcblxuKipNaWxlc3RvbmU6KiogTTAxMVxuKipHZW5lcmF0ZWQ6KiogMjAyNS0wNy0wMlQwODowMDowMFpcblxuIyMjIERBVEFCQVNFX1VSTFxuXG4qKlNlcnZpY2U6KiogTmVvblxuKipTdGF0dXM6KiogcGVuZGluZ1xuKipEZXN0aW5hdGlvbjoqKiBkb3RlbnZcblxuMS4gQ3JlYXRlIGEgTmVvbiBwcm9qZWN0XG4yLiBDb3B5IGNvbm5lY3Rpb24gc3RyaW5nXG5cbiMjIyBXRUJIT09LX1NFQ1JFVFxuXG4qKlNlcnZpY2U6KiogU3RyaXBlXG4qKlN0YXR1czoqKiBjb2xsZWN0ZWRcbioqRGVzdGluYXRpb246KiogZG90ZW52XG5cbjEuIEdvIHRvIHdlYmhvb2tzXG5gO1xuXG4gIGNvbnN0IHBhcnNlZDEgPSBwYXJzZVNlY3JldHNNYW5pZmVzdChtaW5pbWFsKTtcblxuICAvLyBWZXJpZnkgbWlzc2luZyBvcHRpb25hbCBmaWVsZHMgZ2V0IGRlZmF1bHRzXG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGFyc2VkMS5lbnRyaWVzWzBdLmRhc2hib2FyZFVybCwgJycsICdtaXNzaW5nLW9wdGlvbmFsOiBubyBkYXNoYm9hcmQgXHUyMTkyIGVtcHR5IHN0cmluZycpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBhcnNlZDEuZW50cmllc1swXS5mb3JtYXRIaW50LCAnJywgJ21pc3Npbmctb3B0aW9uYWw6IG5vIGZvcm1hdCBoaW50IFx1MjE5MiBlbXB0eSBzdHJpbmcnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwYXJzZWQxLmVudHJpZXNbMV0uZGFzaGJvYXJkVXJsLCAnJywgJ21pc3Npbmctb3B0aW9uYWw6IGVudHJ5IDIgbm8gZGFzaGJvYXJkIFx1MjE5MiBlbXB0eSBzdHJpbmcnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwYXJzZWQxLmVudHJpZXNbMV0uZm9ybWF0SGludCwgJycsICdtaXNzaW5nLW9wdGlvbmFsOiBlbnRyeSAyIG5vIGZvcm1hdCBoaW50IFx1MjE5MiBlbXB0eSBzdHJpbmcnKTtcblxuICAvLyBSb3VuZC10cmlwOiBmb3JtYXR0ZXIgb21pdHMgZW1wdHkgb3B0aW9uYWwgZmllbGRzLCByZS1wYXJzZSBwcmVzZXJ2ZXMgZGVmYXVsdHNcbiAgY29uc3QgZm9ybWF0dGVkID0gZm9ybWF0U2VjcmV0c01hbmlmZXN0KHBhcnNlZDEpO1xuICBjb25zdCBwYXJzZWQyID0gcGFyc2VTZWNyZXRzTWFuaWZlc3QoZm9ybWF0dGVkKTtcblxuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBhcnNlZDIuZW50cmllcy5sZW5ndGgsIHBhcnNlZDEuZW50cmllcy5sZW5ndGgsICdtaXNzaW5nLW9wdGlvbmFsIHJvdW5kLXRyaXAgZW50cnkgY291bnQnKTtcblxuICBmb3IgKGxldCBpID0gMDsgaSA8IHBhcnNlZDEuZW50cmllcy5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IGUxID0gcGFyc2VkMS5lbnRyaWVzW2ldO1xuICAgIGNvbnN0IGUyID0gcGFyc2VkMi5lbnRyaWVzW2ldO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZTIua2V5LCBlMS5rZXksIGBtaXNzaW5nLW9wdGlvbmFsIHJvdW5kLXRyaXAgZW50cnkgJHtpfSBrZXlgKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGUyLnNlcnZpY2UsIGUxLnNlcnZpY2UsIGBtaXNzaW5nLW9wdGlvbmFsIHJvdW5kLXRyaXAgZW50cnkgJHtpfSBzZXJ2aWNlYCk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChlMi5kYXNoYm9hcmRVcmwsIGUxLmRhc2hib2FyZFVybCwgYG1pc3Npbmctb3B0aW9uYWwgcm91bmQtdHJpcCBlbnRyeSAke2l9IGRhc2hib2FyZFVybGApO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZTIuZm9ybWF0SGludCwgZTEuZm9ybWF0SGludCwgYG1pc3Npbmctb3B0aW9uYWwgcm91bmQtdHJpcCBlbnRyeSAke2l9IGZvcm1hdEhpbnRgKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGUyLnN0YXR1cywgZTEuc3RhdHVzLCBgbWlzc2luZy1vcHRpb25hbCByb3VuZC10cmlwIGVudHJ5ICR7aX0gc3RhdHVzYCk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChlMi5kZXN0aW5hdGlvbiwgZTEuZGVzdGluYXRpb24sIGBtaXNzaW5nLW9wdGlvbmFsIHJvdW5kLXRyaXAgZW50cnkgJHtpfSBkZXN0aW5hdGlvbmApO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZTIuZ3VpZGFuY2UubGVuZ3RoLCBlMS5ndWlkYW5jZS5sZW5ndGgsIGBtaXNzaW5nLW9wdGlvbmFsIHJvdW5kLXRyaXAgZW50cnkgJHtpfSBndWlkYW5jZSBsZW5ndGhgKTtcbiAgfVxufSk7XG5cbnRlc3QoJ0xMTSByb3VuZC10cmlwOiBleHRyYSBibGFuayBsaW5lcycsICgpID0+IHtcbiAgLy8gTExNcyBzb21ldGltZXMgaW5zZXJ0IGV4Y2Vzc2l2ZSBibGFuayBsaW5lcyBiZXR3ZWVuIHNlY3Rpb25zXG4gIGNvbnN0IGJsYW5reSA9IGAjIFNlY3JldHMgTWFuaWZlc3RcblxuXG4qKk1pbGVzdG9uZToqKiBNMDEyXG4qKkdlbmVyYXRlZDoqKiAyMDI1LTA3LTAzVDE0OjAwOjAwWlxuXG5cblxuIyMjIEFQSV9LRVlfT05FXG5cblxuKipTZXJ2aWNlOioqIFNlcnZpY2VPbmVcbioqRGFzaGJvYXJkOioqIGh0dHBzOi8vb25lLmV4YW1wbGUuY29tXG5cblxuKipGb3JtYXQgaGludDoqKiBrZXlfLi4uXG4qKlN0YXR1czoqKiBwZW5kaW5nXG4qKkRlc3RpbmF0aW9uOioqIGRvdGVudlxuXG5cblxuMS4gR28gdG8gc2V0dGluZ3NcblxuXG4yLiBHZW5lcmF0ZSBrZXlcblxuXG5cbiMjIyBBUElfS0VZX1RXT1xuXG5cblxuKipTZXJ2aWNlOioqIFNlcnZpY2VUd29cbioqU3RhdHVzOioqIHNraXBwZWRcbioqRGVzdGluYXRpb246KiogZG90ZW52XG5cblxuMS4gTm90IG5lZWRlZFxuYDtcblxuICBjb25zdCBwYXJzZWQxID0gcGFyc2VTZWNyZXRzTWFuaWZlc3QoYmxhbmt5KTtcblxuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHBhcnNlZDEuZW50cmllcy5sZW5ndGgsIDIsICdibGFuay1saW5lczogdHdvIGVudHJpZXMgcGFyc2VkJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGFyc2VkMS5taWxlc3RvbmUsICdNMDEyJywgJ2JsYW5rLWxpbmVzOiBtaWxlc3RvbmUgcGFyc2VkJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGFyc2VkMS5lbnRyaWVzWzBdLmtleSwgJ0FQSV9LRVlfT05FJywgJ2JsYW5rLWxpbmVzOiBmaXJzdCBrZXknKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwYXJzZWQxLmVudHJpZXNbMF0uZ3VpZGFuY2UubGVuZ3RoLCAyLCAnYmxhbmstbGluZXM6IGZpcnN0IGVudHJ5IGd1aWRhbmNlIGNvdW50Jyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGFyc2VkMS5lbnRyaWVzWzFdLmtleSwgJ0FQSV9LRVlfVFdPJywgJ2JsYW5rLWxpbmVzOiBzZWNvbmQga2V5Jyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGFyc2VkMS5lbnRyaWVzWzFdLnN0YXR1cywgJ3NraXBwZWQnLCAnYmxhbmstbGluZXM6IHNlY29uZCBlbnRyeSBzdGF0dXMnKTtcblxuICAvLyBSb3VuZC10cmlwIHByb2R1Y2VzIGNsZWFuIG91dHB1dFxuICBjb25zdCBmb3JtYXR0ZWQgPSBmb3JtYXRTZWNyZXRzTWFuaWZlc3QocGFyc2VkMSk7XG4gIGNvbnN0IHBhcnNlZDIgPSBwYXJzZVNlY3JldHNNYW5pZmVzdChmb3JtYXR0ZWQpO1xuXG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGFyc2VkMi5lbnRyaWVzLmxlbmd0aCwgcGFyc2VkMS5lbnRyaWVzLmxlbmd0aCwgJ2JsYW5rLWxpbmVzIHJvdW5kLXRyaXAgZW50cnkgY291bnQnKTtcblxuICBmb3IgKGxldCBpID0gMDsgaSA8IHBhcnNlZDEuZW50cmllcy5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IGUxID0gcGFyc2VkMS5lbnRyaWVzW2ldO1xuICAgIGNvbnN0IGUyID0gcGFyc2VkMi5lbnRyaWVzW2ldO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZTIua2V5LCBlMS5rZXksIGBibGFuay1saW5lcyByb3VuZC10cmlwIGVudHJ5ICR7aX0ga2V5YCk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChlMi5zZXJ2aWNlLCBlMS5zZXJ2aWNlLCBgYmxhbmstbGluZXMgcm91bmQtdHJpcCBlbnRyeSAke2l9IHNlcnZpY2VgKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGUyLmRhc2hib2FyZFVybCwgZTEuZGFzaGJvYXJkVXJsLCBgYmxhbmstbGluZXMgcm91bmQtdHJpcCBlbnRyeSAke2l9IGRhc2hib2FyZFVybGApO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZTIuZm9ybWF0SGludCwgZTEuZm9ybWF0SGludCwgYGJsYW5rLWxpbmVzIHJvdW5kLXRyaXAgZW50cnkgJHtpfSBmb3JtYXRIaW50YCk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChlMi5zdGF0dXMsIGUxLnN0YXR1cywgYGJsYW5rLWxpbmVzIHJvdW5kLXRyaXAgZW50cnkgJHtpfSBzdGF0dXNgKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGUyLmRlc3RpbmF0aW9uLCBlMS5kZXN0aW5hdGlvbiwgYGJsYW5rLWxpbmVzIHJvdW5kLXRyaXAgZW50cnkgJHtpfSBkZXN0aW5hdGlvbmApO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZTIuZ3VpZGFuY2UubGVuZ3RoLCBlMS5ndWlkYW5jZS5sZW5ndGgsIGBibGFuay1saW5lcyByb3VuZC10cmlwIGVudHJ5ICR7aX0gZ3VpZGFuY2UgbGVuZ3RoYCk7XG4gIH1cblxuICAvLyBWZXJpZnkgdGhlIGZvcm1hdHRlZCBvdXRwdXQgaXMgY2xlYW5lciAoZmV3ZXIgY29uc2VjdXRpdmUgYmxhbmsgbGluZXMpXG4gIGNvbnN0IGNvbnNlY3V0aXZlQmxhbmtzID0gZm9ybWF0dGVkLm1hdGNoKC9cXG57NCx9L2cpO1xuICBhc3NlcnQub2soY29uc2VjdXRpdmVCbGFua3MgPT09IG51bGwsICdibGFuay1saW5lczogZm9ybWF0dGVkIG91dHB1dCBoYXMgbm8gNCsgY29uc2VjdXRpdmUgbmV3bGluZXMnKTtcbn0pO1xuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIHBhcnNlUm9hZG1hcDogYm91bmRhcnkgbWFwIHdpdGggZW1iZWRkZWQgY29kZSBmZW5jZXMgKCM0NjgpXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbnRlc3QoJ3BhcnNlUm9hZG1hcDogYm91bmRhcnkgbWFwIHdpdGggY29kZSBmZW5jZXMgKCM0NjgpJywgKCkgPT4ge1xuICBjb25zdCBjb250ZW50ID0gYCMgTTAwMTogVGVzdFxuXG4qKlZpc2lvbjoqKiBUZXN0XG5cbiMjIFNsaWNlc1xuXG4tIFsgXSAqKlMwMTogQ29yZSoqIFxcYHJpc2s6bG93XFxgIFxcYGRlcGVuZHM6W11cXGBcbi0gWyBdICoqUzAyOiBBUEkqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltTMDFdXFxgXG5cbiMjIEJvdW5kYXJ5IE1hcFxuXG4jIyMgUzAxIFx1MjE5MiBTMDJcblxuUHJvZHVjZXM6XG4gIHR5cGVzLnRzIFx1MjAxNCBhbGwgdHlwZXNcbiAgXFxgXFxgXFxgXG4gIGNvbnN0IHggPSAxO1xuICBcXGBcXGBcXGBcblxuQ29uc3VtZXM6IG5vdGhpbmdcbmA7XG5cbiAgLy8gVGhpcyB0ZXN0IGVuc3VyZXMgdGhlIGJvdW5kYXJ5IG1hcCBwYXJzZXIgZG9lcyBub3QgaGFuZyBvclxuICAvLyBjYXRhc3Ryb3BoaWNhbGx5IGJhY2t0cmFjayB3aGVuIGNvbnRlbnQgY29udGFpbnMgY29kZSBmZW5jZXMuXG4gIGNvbnN0IHN0YXJ0ID0gRGF0ZS5ub3coKTtcbiAgY29uc3QgciA9IHBhcnNlUm9hZG1hcChjb250ZW50KTtcbiAgY29uc3QgZWxhcHNlZCA9IERhdGUubm93KCkgLSBzdGFydDtcblxuICBhc3NlcnQub2soZWxhcHNlZCA8IDEwMDAsIGBib3VuZGFyeSBtYXAgd2l0aCBjb2RlIGZlbmNlcyBwYXJzZWQgaW4gJHtlbGFwc2VkfW1zIChzaG91bGQgYmUgPCAxcylgKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyLnNsaWNlcy5sZW5ndGgsIDIsICdjb2RlLWZlbmNlIHJvYWRtYXA6IHNsaWNlIGNvdW50Jyk7XG4gIC8vIEJvdW5kYXJ5IG1hcCBzaG91bGQgc3RpbGwgcGFyc2UgKG1heSBub3QgY2FwdHVyZSBwZXJmZWN0bHkgd2l0aCBjb2RlIGZlbmNlcywgYnV0IG11c3Qgbm90IGhhbmcpXG4gIGFzc2VydC5vayhyLmJvdW5kYXJ5TWFwLmxlbmd0aCA+PSAwLCAnY29kZS1mZW5jZSByb2FkbWFwOiBib3VuZGFyeSBtYXAgcGFyc2VkIHdpdGhvdXQgaGFuZ2luZycpO1xufSk7XG5cbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxVQUFVLFlBQVk7QUFDL0IsT0FBTyxZQUFZO0FBQ25CLFNBQVMsY0FBYyxpQkFBaUI7QUFDeEMsU0FBUyxtQkFBbUIsY0FBYyxlQUFlLHdCQUF3QixzQkFBc0IsNkJBQTZCO0FBTXBJLFNBQVMsV0FBVyxNQUFNO0FBQzFCLE9BQUssOEJBQThCLE1BQU07QUFDdkMsVUFBTSxVQUFVO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQThDaEIsVUFBTSxJQUFJLGFBQWEsT0FBTztBQUU5QixXQUFPLGdCQUFnQixFQUFFLE9BQU8sb0RBQStDLGVBQWU7QUFDOUYsV0FBTyxnQkFBZ0IsRUFBRSxRQUFRLHlEQUF5RCxnQkFBZ0I7QUFDMUcsV0FBTyxnQkFBZ0IsRUFBRSxnQkFBZ0IsUUFBUSxHQUFHLHdCQUF3QjtBQUM1RSxXQUFPLGdCQUFnQixFQUFFLGdCQUFnQixDQUFDLEdBQUcsa0NBQWtDLHlCQUF5QjtBQUN4RyxXQUFPLGdC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
