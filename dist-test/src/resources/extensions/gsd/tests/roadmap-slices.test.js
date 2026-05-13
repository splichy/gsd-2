import test from "node:test";
import assert from "node:assert/strict";
import { parseRoadmap } from "../parsers-legacy.js";
import { parseRoadmapSlices, expandDependencies } from "../roadmap-slices.js";
const content = `# M003: Current

**Vision:** Build the thing.

## Slices
- [x] **S01: First Slice** \`risk:low\` \`depends:[]\`
  > After this: First demo works.
- [ ] **S02: Second Slice** \`risk:medium\` \`depends:[S01]\`
- [x] **S03: Third Slice** \`depends:[S01, S02]\`
  > After this: Third demo works.

## Boundary Map
### S01 \u2192 S02
Produces:
  foo.ts
`;
test("parseRoadmapSlices extracts slices with dependencies and risk", () => {
  const slices = parseRoadmapSlices(content);
  assert.equal(slices.length, 3);
  assert.equal(slices[0]?.id, "S01");
  assert.equal(slices[0]?.done, true);
  assert.equal(slices[0]?.demo, "First demo works.");
  assert.deepEqual(slices[1]?.depends, ["S01"]);
  assert.equal(slices[1]?.risk, "medium");
  assert.equal(slices[2]?.risk, "low");
  assert.deepEqual(slices[2]?.depends, ["S01", "S02"]);
});
test("parseRoadmap integration: uses extracted slice parser", () => {
  const roadmap = parseRoadmap(content);
  assert.equal(roadmap.title, "M003: Current");
  assert.equal(roadmap.vision, "Build the thing.");
  assert.equal(roadmap.slices.length, 3);
  assert.equal(roadmap.boundaryMap.length, 1);
});
test("expandDependencies: plain IDs, ranges, and edge cases", () => {
  assert.deepEqual(expandDependencies([]), []);
  assert.deepEqual(expandDependencies(["S01"]), ["S01"]);
  assert.deepEqual(expandDependencies(["S01", "S03"]), ["S01", "S03"]);
  assert.deepEqual(expandDependencies(["S01-S04"]), ["S01", "S02", "S03", "S04"]);
  assert.deepEqual(expandDependencies(["S01-S01"]), ["S01"]);
  assert.deepEqual(expandDependencies(["S01..S03"]), ["S01", "S02", "S03"]);
  assert.deepEqual(expandDependencies(["S01-S03", "S05"]), ["S01", "S02", "S03", "S05"]);
  assert.deepEqual(expandDependencies(["S04-S01"]), ["S04-S01"]);
  assert.deepEqual(expandDependencies(["S01-T04"]), ["S01-T04"]);
});
test("parseRoadmapSlices: range syntax in depends expanded", () => {
  const rangeContent = `# M016: Test

## Slices
- [x] **S01: A** \`risk:low\` \`depends:[]\`
- [x] **S02: B** \`risk:low\` \`depends:[]\`
- [x] **S03: C** \`risk:low\` \`depends:[]\`
- [x] **S04: D** \`risk:low\` \`depends:[]\`
- [ ] **S05: E** \`risk:low\` \`depends:[S01-S04]\`
  > After this: all done
`;
  const slices = parseRoadmapSlices(rangeContent);
  assert.equal(slices.length, 5);
  assert.deepEqual(slices[4]?.depends, ["S01", "S02", "S03", "S04"]);
});
test("parseRoadmapSlices: comma-separated depends still works", () => {
  const commaContent = `# M001: Test

## Slices
- [ ] **S05: E** \`risk:low\` \`depends:[S01,S02,S03,S04]\`
  > After this: done
`;
  const slices = parseRoadmapSlices(commaContent);
  assert.deepEqual(slices[0]?.depends, ["S01", "S02", "S03", "S04"]);
});
test("parseRoadmapSlices: table format under ## Slices heading (#1736)", () => {
  const tableContent = [
    "# M001: Test Project",
    "",
    "## Slices",
    "",
    "| Slice | Title | Risk | Status |",
    "| --- | --- | --- | --- |",
    "| S01 | Setup Foundation | Low | [x] Done |",
    "| S02 | Core Features | High | [ ] Pending |",
    "| S03 | Polish | Medium | [x] Done |",
    "",
    "## Boundary Map"
  ].join("\n");
  const slices = parseRoadmapSlices(tableContent);
  assert.equal(slices.length, 3, "should parse 3 slices from table");
  assert.equal(slices[0]?.id, "S01");
  assert.equal(slices[0]?.done, true);
  assert.equal(slices[1]?.id, "S02");
  assert.equal(slices[1]?.done, false);
  assert.equal(slices[2]?.done, true);
});
test("parseRoadmapSlices: table format under ## Slice Overview heading (#1736)", () => {
  const tableContent = [
    "# M002: Another Project",
    "",
    "## Slice Overview",
    "",
    "| ID | Description | Risk | Done |",
    "|---|---|---|---|",
    "| S01 | Foundation Work | High | [x] |",
    "| S02 | API Layer | Medium | [ ] |",
    ""
  ].join("\n");
  const slices = parseRoadmapSlices(tableContent);
  assert.equal(slices.length, 2);
  assert.equal(slices[0]?.done, true);
  assert.equal(slices[1]?.done, false);
});
test("parseRoadmapSlices: table with Status Done/Complete text (#1736)", () => {
  const tableContent = [
    "# M003: Status Text",
    "",
    "## Slices",
    "",
    "| Slice | Title | Risk | Status |",
    "|---|---|---|---|",
    "| S01 | First | Low | Done |",
    "| S02 | Second | High | Pending |",
    "| S03 | Third | Medium | Completed |",
    ""
  ].join("\n");
  const slices = parseRoadmapSlices(tableContent);
  assert.equal(slices.length, 3);
  assert.equal(slices[0]?.done, true);
  assert.equal(slices[1]?.done, false);
  assert.equal(slices[2]?.done, true);
});
test("parseRoadmapSlices: table with glyph completion markers (#2841)", () => {
  const tableContent = [
    "# M003: Glyph Status",
    "",
    "## Slices",
    "",
    "| Slice | Title | Risk | Status |",
    "|---|---|---|---|",
    "| S01 | First | Low | \u2705 |",
    "| S02 | Second | High | Pending |",
    "| S03 | Third | Medium | \u2611 |",
    "| S04 | Fourth | Medium | \u2713 |",
    ""
  ].join("\n");
  const slices = parseRoadmapSlices(tableContent);
  assert.equal(slices.length, 4);
  assert.equal(slices[0]?.done, true);
  assert.equal(slices[1]?.done, false);
  assert.equal(slices[2]?.done, true);
  assert.equal(slices[3]?.done, true);
});
test("parseRoadmapSlices: table with heavy check mark U+2714 (#2940)", () => {
  const tableContent = [
    "# M003: Heavy Check",
    "",
    "## Slices",
    "",
    "| Slice | Title | Risk | Status |",
    "|---|---|---|---|",
    "| S01 | First | Low | \u2714 |",
    "| S02 | Second | High | Pending |",
    ""
  ].join("\n");
  const slices = parseRoadmapSlices(tableContent);
  assert.equal(slices.length, 2);
  assert.equal(slices[0]?.done, true, "U+2714 heavy check mark should mark slice as done");
  assert.equal(slices[1]?.done, false);
});
test("parseRoadmapSlices: table with dependencies column (#1736)", () => {
  const tableContent = [
    "# M004: Deps",
    "",
    "## Slices",
    "",
    "| Slice | Title | Risk | Depends | Status |",
    "|---|---|---|---|---|",
    "| S01 | First | Low | None | Done |",
    "| S02 | Second | High | S01 | Pending |",
    "| S03 | Third | Medium | S01, S02 | [ ] |",
    ""
  ].join("\n");
  const slices = parseRoadmapSlices(tableContent);
  assert.equal(slices.length, 3);
  assert.deepEqual(slices[0]?.depends, []);
  assert.deepEqual(slices[1]?.depends, ["S01"]);
  assert.deepEqual(slices[2]?.depends, ["S01", "S02"]);
});
test("parseRoadmapSlices: standard checkbox format still works (#1736)", () => {
  const checkboxContent = [
    "# M005: Unchanged",
    "",
    "## Slices",
    "",
    "- [x] **S01: First Slice** `risk:low` `depends:[]`",
    "  > After this: First demo works.",
    "- [ ] **S02: Second Slice** `risk:medium` `depends:[S01]`",
    ""
  ].join("\n");
  const slices = parseRoadmapSlices(checkboxContent);
  assert.equal(slices.length, 2);
  assert.equal(slices[0]?.done, true);
  assert.equal(slices[1]?.done, false);
});
test("parseRoadmapSlices: prose headers with \u2713 marker detected as done", () => {
  const proseContent = `# M010: Prose Roadmap

## S01: \u2713 First Feature
Some description.

## S02: Second Feature
Not done yet.

## S03: \u2713 Third Feature
Also done.
`;
  const slices = parseRoadmapSlices(proseContent);
  assert.equal(slices.length, 3);
  assert.equal(slices[0]?.id, "S01");
  assert.equal(slices[0]?.done, true);
  assert.equal(slices[0]?.title, "First Feature");
  assert.equal(slices[1]?.done, false);
  assert.equal(slices[2]?.done, true);
});
test("parseRoadmapSlices: prose headers with (Complete) marker detected as done", () => {
  const proseContent = `# M011: Prose Roadmap

## S01: First Feature (Complete)
Done slice.

## S02: Second Feature
In progress.
`;
  const slices = parseRoadmapSlices(proseContent);
  assert.equal(slices.length, 2);
  assert.equal(slices[0]?.done, true);
  assert.equal(slices[0]?.title, "First Feature");
  assert.equal(slices[1]?.done, false);
});
test("parseRoadmapSlices: prose headers with \u2713 prefix before title", () => {
  const proseContent = `# M012: Prose

## \u2713 S01: Done Slice
Complete.

## S02: Pending Slice
Not done.
`;
  const slices = parseRoadmapSlices(proseContent);
  assert.equal(slices.length, 2);
  assert.equal(slices[0]?.done, true);
  assert.equal(slices[0]?.title, "Done Slice");
  assert.equal(slices[1]?.done, false);
});
test("parseRoadmapSlices: H3 prose headers under ## Slices section triggers prose fallback (#1711)", () => {
  const proseUnderSlices = `# M010: My Milestone

**Vision:** Ship it.

## Slices

### S01 \u2014 Setup Environment
Set up the dev environment and tooling.

### S02 \u2014 Build Core
Implement the core logic.
**Depends on:** S01

### S03 \u2014 Polish UI
Final polish and theming.
**Depends on:** S01, S02
`;
  const slices = parseRoadmapSlices(proseUnderSlices);
  assert.equal(slices.length, 3, "should find 3 slices from H3 prose headers under ## Slices");
  assert.equal(slices[0]?.id, "S01");
  assert.equal(slices[0]?.title, "Setup Environment");
  assert.equal(slices[1]?.id, "S02");
  assert.deepEqual(slices[1]?.depends, ["S01"]);
  assert.equal(slices[2]?.id, "S03");
  assert.deepEqual(slices[2]?.depends, ["S01", "S02"]);
});
test("parseRoadmapSlices: ## Slices with valid checkboxes does NOT invoke prose fallback", () => {
  const slices = parseRoadmapSlices(content);
  assert.equal(slices.length, 3);
  assert.equal(slices[0]?.id, "S01");
  assert.equal(slices[0]?.done, true);
});
test("parseRoadmapSlices: ## Slice Roadmap heading recognized (#1940)", () => {
  const roadmapContent = [
    "# M002: Current Milestone",
    "",
    "**Vision:** Ship it.",
    "",
    "## Slice Roadmap",
    "",
    "- [x] **S01: Foundation** `risk:low` `depends:[]`",
    "  > After this: base layer works.",
    "- [x] **S02: Core Logic** `risk:medium` `depends:[S01]`",
    "- [ ] **S03: Polish** `risk:low` `depends:[S01,S02]`",
    "",
    "## Boundary Map"
  ].join("\n");
  const slices = parseRoadmapSlices(roadmapContent);
  assert.equal(slices.length, 3, "should parse 3 slices under '## Slice Roadmap'");
  assert.equal(slices[0]?.id, "S01");
  assert.equal(slices[0]?.done, true, "S01 should be marked done");
  assert.equal(slices[1]?.id, "S02");
  assert.equal(slices[1]?.done, true, "S02 should be marked done");
  assert.equal(slices[2]?.id, "S03");
  assert.equal(slices[2]?.done, false, "S03 should be pending");
  assert.deepEqual(slices[2]?.depends, ["S01", "S02"]);
});
test("parseRoadmapSlices: ## Slices with only non-matching lines returns prose fallback results", () => {
  const weirdContent = `# M020: Odd

## Slices
Some introductory text that is not a checkbox or a slice header.

### S01: First Thing
Do the first thing.

### S02: Second Thing
Do the second thing.
`;
  const slices = parseRoadmapSlices(weirdContent);
  assert.equal(slices.length, 2, "should fall through to prose parser");
  assert.equal(slices[0]?.id, "S01");
  assert.equal(slices[1]?.id, "S02");
});
test("parseRoadmapSlices: numbered H3 headers under ## Slices (#2567)", () => {
  const numberedContent = `# M002: My Milestone

**Vision:** Ship the product.

## Slices

### 1. S01: Setup Environment
Set up the dev environment and tooling.

### 2. S02: Build Core
Implement the core logic.
**Depends on:** S01

### 3. S03: Polish UI
Final polish and theming.
**Depends on:** S01, S02
`;
  const slices = parseRoadmapSlices(numberedContent);
  assert.equal(slices.length, 3, "should parse 3 slices from numbered H3 headers");
  assert.equal(slices[0]?.id, "S01");
  assert.equal(slices[0]?.title, "Setup Environment");
  assert.equal(slices[1]?.id, "S02");
  assert.deepEqual(slices[1]?.depends, ["S01"]);
  assert.equal(slices[2]?.id, "S03");
  assert.deepEqual(slices[2]?.depends, ["S01", "S02"]);
});
test("parseRoadmapSlices: parenthetical-numbered H3 headers (#2567)", () => {
  const parenContent = `# M002: Milestone

**Vision:** Ship.

## Slices

### (1) S01: Setup
Setup work.

### (2) S02: Build
Build work.
**Depends on:** S01
`;
  const slices = parseRoadmapSlices(parenContent);
  assert.equal(slices.length, 2, "should parse slices with parenthetical numbering");
  assert.equal(slices[0]?.id, "S01");
  assert.equal(slices[0]?.title, "Setup");
  assert.equal(slices[1]?.id, "S02");
  assert.deepEqual(slices[1]?.depends, ["S01"]);
});
test("parseRoadmapSlices: bracketed slice IDs in H3 headers (#2567)", () => {
  const bracketContent = `# M002: Milestone

**Vision:** Ship.

## Slices

### [S01] Setup Environment
Setup work.

### [S02] Build Core
Build work.
**Depends on:** S01
`;
  const slices = parseRoadmapSlices(bracketContent);
  assert.equal(slices.length, 2, "should parse slices with bracketed IDs");
  assert.equal(slices[0]?.id, "S01");
  assert.equal(slices[0]?.title, "Setup Environment");
  assert.equal(slices[1]?.id, "S02");
  assert.deepEqual(slices[1]?.depends, ["S01"]);
});
test("parseRoadmapSlices: indented H3 headers under ## Slices (#2567)", () => {
  const indentedContent = `# M002: Milestone

**Vision:** Ship.

## Slices

  ### S01: Setup
  Setup work.

  ### S02: Build
  Build work.
`;
  const slices = parseRoadmapSlices(indentedContent);
  assert.equal(slices.length, 2, "should parse slices from indented H3 headers");
  assert.equal(slices[0]?.id, "S01");
  assert.equal(slices[0]?.title, "Setup");
  assert.equal(slices[1]?.id, "S02");
  assert.equal(slices[1]?.title, "Build");
});
test("parseRoadmapSlices: prose headers with \u2705 suffix detected as done (#1884)", () => {
  const proseContent = `# M013: Prose Roadmap

### S01: Plan Limits & Billing Foundation \u2705
All tasks done.

### S02: Usage Tracking
Not done yet.

### S03: Notification System \u2705
Also done.
`;
  const slices = parseRoadmapSlices(proseContent);
  assert.equal(slices.length, 3);
  assert.equal(slices[0]?.id, "S01");
  assert.equal(slices[0]?.done, true, "S01 with trailing \u2705 should be done");
  assert.equal(slices[0]?.title, "Plan Limits & Billing Foundation");
  assert.equal(slices[1]?.done, false);
  assert.equal(slices[2]?.done, true, "S03 with trailing \u2705 should be done");
  assert.equal(slices[2]?.title, "Notification System");
});
test("parseRoadmapSlices: prose headers with \u2705 prefix before title detected as done (#1884)", () => {
  const proseContent = `# M014: Prose

## \u2705 S01: Done Slice
Complete.

## S02: Pending Slice
Not done.
`;
  const slices = parseRoadmapSlices(proseContent);
  assert.equal(slices.length, 2);
  assert.equal(slices[0]?.done, true, "prefix \u2705 should mark as done");
  assert.equal(slices[0]?.title, "Done Slice");
  assert.equal(slices[1]?.done, false);
});
test("parseRoadmapSlices: prose headers with \u2705 after separator detected as done (#1884)", () => {
  const proseContent = `# M015: Prose

## S01: \u2705 First Feature
Done.

## S02: Second Feature
Not done.
`;
  const slices = parseRoadmapSlices(proseContent);
  assert.equal(slices.length, 2);
  assert.equal(slices[0]?.done, true, "\u2705 after colon should mark as done");
  assert.equal(slices[0]?.title, "First Feature");
  assert.equal(slices[1]?.done, false);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9yb2FkbWFwLXNsaWNlcy50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IHBhcnNlUm9hZG1hcCB9IGZyb20gXCIuLi9wYXJzZXJzLWxlZ2FjeS50c1wiO1xuaW1wb3J0IHsgcGFyc2VSb2FkbWFwU2xpY2VzLCBleHBhbmREZXBlbmRlbmNpZXMgfSBmcm9tIFwiLi4vcm9hZG1hcC1zbGljZXMudHNcIjtcblxuY29uc3QgY29udGVudCA9IGAjIE0wMDM6IEN1cnJlbnRcblxuKipWaXNpb246KiogQnVpbGQgdGhlIHRoaW5nLlxuXG4jIyBTbGljZXNcbi0gW3hdICoqUzAxOiBGaXJzdCBTbGljZSoqIFxcYHJpc2s6bG93XFxgIFxcYGRlcGVuZHM6W11cXGBcbiAgPiBBZnRlciB0aGlzOiBGaXJzdCBkZW1vIHdvcmtzLlxuLSBbIF0gKipTMDI6IFNlY29uZCBTbGljZSoqIFxcYHJpc2s6bWVkaXVtXFxgIFxcYGRlcGVuZHM6W1MwMV1cXGBcbi0gW3hdICoqUzAzOiBUaGlyZCBTbGljZSoqIFxcYGRlcGVuZHM6W1MwMSwgUzAyXVxcYFxuICA+IEFmdGVyIHRoaXM6IFRoaXJkIGRlbW8gd29ya3MuXG5cbiMjIEJvdW5kYXJ5IE1hcFxuIyMjIFMwMSBcdTIxOTIgUzAyXG5Qcm9kdWNlczpcbiAgZm9vLnRzXG5gO1xuXG50ZXN0KFwicGFyc2VSb2FkbWFwU2xpY2VzIGV4dHJhY3RzIHNsaWNlcyB3aXRoIGRlcGVuZGVuY2llcyBhbmQgcmlza1wiLCAoKSA9PiB7XG4gIGNvbnN0IHNsaWNlcyA9IHBhcnNlUm9hZG1hcFNsaWNlcyhjb250ZW50KTtcbiAgYXNzZXJ0LmVxdWFsKHNsaWNlcy5sZW5ndGgsIDMpO1xuICBhc3NlcnQuZXF1YWwoc2xpY2VzWzBdPy5pZCwgXCJTMDFcIik7XG4gIGFzc2VydC5lcXVhbChzbGljZXNbMF0/LmRvbmUsIHRydWUpO1xuICBhc3NlcnQuZXF1YWwoc2xpY2VzWzBdPy5kZW1vLCBcIkZpcnN0IGRlbW8gd29ya3MuXCIpO1xuICBhc3NlcnQuZGVlcEVxdWFsKHNsaWNlc1sxXT8uZGVwZW5kcywgW1wiUzAxXCJdKTtcbiAgYXNzZXJ0LmVxdWFsKHNsaWNlc1sxXT8ucmlzaywgXCJtZWRpdW1cIik7XG4gIGFzc2VydC5lcXVhbChzbGljZXNbMl0/LnJpc2ssIFwibG93XCIpO1xuICBhc3NlcnQuZGVlcEVxdWFsKHNsaWNlc1syXT8uZGVwZW5kcywgW1wiUzAxXCIsIFwiUzAyXCJdKTtcbn0pO1xuXG50ZXN0KFwicGFyc2VSb2FkbWFwIGludGVncmF0aW9uOiB1c2VzIGV4dHJhY3RlZCBzbGljZSBwYXJzZXJcIiwgKCkgPT4ge1xuICBjb25zdCByb2FkbWFwID0gcGFyc2VSb2FkbWFwKGNvbnRlbnQpO1xuICBhc3NlcnQuZXF1YWwocm9hZG1hcC50aXRsZSwgXCJNMDAzOiBDdXJyZW50XCIpO1xuICBhc3NlcnQuZXF1YWwocm9hZG1hcC52aXNpb24sIFwiQnVpbGQgdGhlIHRoaW5nLlwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJvYWRtYXAuc2xpY2VzLmxlbmd0aCwgMyk7XG4gIGFzc2VydC5lcXVhbChyb2FkbWFwLmJvdW5kYXJ5TWFwLmxlbmd0aCwgMSk7XG59KTtcblxudGVzdChcImV4cGFuZERlcGVuZGVuY2llczogcGxhaW4gSURzLCByYW5nZXMsIGFuZCBlZGdlIGNhc2VzXCIsICgpID0+IHtcbiAgYXNzZXJ0LmRlZXBFcXVhbChleHBhbmREZXBlbmRlbmNpZXMoW10pLCBbXSk7XG4gIGFzc2VydC5kZWVwRXF1YWwoZXhwYW5kRGVwZW5kZW5jaWVzKFtcIlMwMVwiXSksIFtcIlMwMVwiXSk7XG4gIGFzc2VydC5kZWVwRXF1YWwoZXhwYW5kRGVwZW5kZW5jaWVzKFtcIlMwMVwiLCBcIlMwM1wiXSksIFtcIlMwMVwiLCBcIlMwM1wiXSk7XG4gIGFzc2VydC5kZWVwRXF1YWwoZXhwYW5kRGVwZW5kZW5jaWVzKFtcIlMwMS1TMDRcIl0pLCBbXCJTMDFcIiwgXCJTMDJcIiwgXCJTMDNcIiwgXCJTMDRcIl0pO1xuICBhc3NlcnQuZGVlcEVxdWFsKGV4cGFuZERlcGVuZGVuY2llcyhbXCJTMDEtUzAxXCJdKSwgW1wiUzAxXCJdKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChleHBhbmREZXBlbmRlbmNpZXMoW1wiUzAxLi5TMDNcIl0pLCBbXCJTMDFcIiwgXCJTMDJcIiwgXCJTMDNcIl0pO1xuICBhc3NlcnQuZGVlcEVxdWFsKGV4cGFuZERlcGVuZGVuY2llcyhbXCJTMDEtUzAzXCIsIFwiUzA1XCJdKSwgW1wiUzAxXCIsIFwiUzAyXCIsIFwiUzAzXCIsIFwiUzA1XCJdKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChleHBhbmREZXBlbmRlbmNpZXMoW1wiUzA0LVMwMVwiXSksIFtcIlMwNC1TMDFcIl0pO1xuICBhc3NlcnQuZGVlcEVxdWFsKGV4cGFuZERlcGVuZGVuY2llcyhbXCJTMDEtVDA0XCJdKSwgW1wiUzAxLVQwNFwiXSk7XG59KTtcblxudGVzdChcInBhcnNlUm9hZG1hcFNsaWNlczogcmFuZ2Ugc3ludGF4IGluIGRlcGVuZHMgZXhwYW5kZWRcIiwgKCkgPT4ge1xuICBjb25zdCByYW5nZUNvbnRlbnQgPSBgIyBNMDE2OiBUZXN0XFxuXFxuIyMgU2xpY2VzXFxuLSBbeF0gKipTMDE6IEEqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgXFxuLSBbeF0gKipTMDI6IEIqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgXFxuLSBbeF0gKipTMDM6IEMqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgXFxuLSBbeF0gKipTMDQ6IEQqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgXFxuLSBbIF0gKipTMDU6IEUqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltTMDEtUzA0XVxcYFxcbiAgPiBBZnRlciB0aGlzOiBhbGwgZG9uZVxcbmA7XG4gIGNvbnN0IHNsaWNlcyA9IHBhcnNlUm9hZG1hcFNsaWNlcyhyYW5nZUNvbnRlbnQpO1xuICBhc3NlcnQuZXF1YWwoc2xpY2VzLmxlbmd0aCwgNSk7XG4gIGFzc2VydC5kZWVwRXF1YWwoc2xpY2VzWzRdPy5kZXBlbmRzLCBbXCJTMDFcIiwgXCJTMDJcIiwgXCJTMDNcIiwgXCJTMDRcIl0pO1xufSk7XG5cbnRlc3QoXCJwYXJzZVJvYWRtYXBTbGljZXM6IGNvbW1hLXNlcGFyYXRlZCBkZXBlbmRzIHN0aWxsIHdvcmtzXCIsICgpID0+IHtcbiAgY29uc3QgY29tbWFDb250ZW50ID0gYCMgTTAwMTogVGVzdFxcblxcbiMjIFNsaWNlc1xcbi0gWyBdICoqUzA1OiBFKiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbUzAxLFMwMixTMDMsUzA0XVxcYFxcbiAgPiBBZnRlciB0aGlzOiBkb25lXFxuYDtcbiAgY29uc3Qgc2xpY2VzID0gcGFyc2VSb2FkbWFwU2xpY2VzKGNvbW1hQ29udGVudCk7XG4gIGFzc2VydC5kZWVwRXF1YWwoc2xpY2VzWzBdPy5kZXBlbmRzLCBbXCJTMDFcIiwgXCJTMDJcIiwgXCJTMDNcIiwgXCJTMDRcIl0pO1xufSk7XG5cbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuLy8gUmVncmVzc2lvbiAjMTczNjogVGFibGUgZm9ybWF0IHBhcnNpbmdcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG50ZXN0KFwicGFyc2VSb2FkbWFwU2xpY2VzOiB0YWJsZSBmb3JtYXQgdW5kZXIgIyMgU2xpY2VzIGhlYWRpbmcgKCMxNzM2KVwiLCAoKSA9PiB7XG4gIGNvbnN0IHRhYmxlQ29udGVudCA9IFtcbiAgICBcIiMgTTAwMTogVGVzdCBQcm9qZWN0XCIsIFwiXCIsIFwiIyMgU2xpY2VzXCIsIFwiXCIsXG4gICAgXCJ8IFNsaWNlIHwgVGl0bGUgfCBSaXNrIHwgU3RhdHVzIHxcIixcbiAgICBcInwgLS0tIHwgLS0tIHwgLS0tIHwgLS0tIHxcIixcbiAgICBcInwgUzAxIHwgU2V0dXAgRm91bmRhdGlvbiB8IExvdyB8IFt4XSBEb25lIHxcIixcbiAgICBcInwgUzAyIHwgQ29yZSBGZWF0dXJlcyB8IEhpZ2ggfCBbIF0gUGVuZGluZyB8XCIsXG4gICAgXCJ8IFMwMyB8IFBvbGlzaCB8IE1lZGl1bSB8IFt4XSBEb25lIHxcIixcbiAgICBcIlwiLCBcIiMjIEJvdW5kYXJ5IE1hcFwiLFxuICBdLmpvaW4oXCJcXG5cIik7XG4gIGNvbnN0IHNsaWNlcyA9IHBhcnNlUm9hZG1hcFNsaWNlcyh0YWJsZUNvbnRlbnQpO1xuICBhc3NlcnQuZXF1YWwoc2xpY2VzLmxlbmd0aCwgMywgXCJzaG91bGQgcGFyc2UgMyBzbGljZXMgZnJvbSB0YWJsZVwiKTtcbiAgYXNzZXJ0LmVxdWFsKHNsaWNlc1swXT8uaWQsIFwiUzAxXCIpO1xuICBhc3NlcnQuZXF1YWwoc2xpY2VzWzBdPy5kb25lLCB0cnVlKTtcbiAgYXNzZXJ0LmVxdWFsKHNsaWNlc1sxXT8uaWQsIFwiUzAyXCIpO1xuICBhc3NlcnQuZXF1YWwoc2xpY2VzWzFdPy5kb25lLCBmYWxzZSk7XG4gIGFzc2VydC5lcXVhbChzbGljZXNbMl0/LmRvbmUsIHRydWUpO1xufSk7XG5cbnRlc3QoXCJwYXJzZVJvYWRtYXBTbGljZXM6IHRhYmxlIGZvcm1hdCB1bmRlciAjIyBTbGljZSBPdmVydmlldyBoZWFkaW5nICgjMTczNilcIiwgKCkgPT4ge1xuICBjb25zdCB0YWJsZUNvbnRlbnQgPSBbXG4gICAgXCIjIE0wMDI6IEFub3RoZXIgUHJvamVjdFwiLCBcIlwiLCBcIiMjIFNsaWNlIE92ZXJ2aWV3XCIsIFwiXCIsXG4gICAgXCJ8IElEIHwgRGVzY3JpcHRpb24gfCBSaXNrIHwgRG9uZSB8XCIsIFwifC0tLXwtLS18LS0tfC0tLXxcIixcbiAgICBcInwgUzAxIHwgRm91bmRhdGlvbiBXb3JrIHwgSGlnaCB8IFt4XSB8XCIsXG4gICAgXCJ8IFMwMiB8IEFQSSBMYXllciB8IE1lZGl1bSB8IFsgXSB8XCIsIFwiXCIsXG4gIF0uam9pbihcIlxcblwiKTtcbiAgY29uc3Qgc2xpY2VzID0gcGFyc2VSb2FkbWFwU2xpY2VzKHRhYmxlQ29udGVudCk7XG4gIGFzc2VydC5lcXVhbChzbGljZXMubGVuZ3RoLCAyKTtcbiAgYXNzZXJ0LmVxdWFsKHNsaWNlc1swXT8uZG9uZSwgdHJ1ZSk7XG4gIGFzc2VydC5lcXVhbChzbGljZXNbMV0/LmRvbmUsIGZhbHNlKTtcbn0pO1xuXG50ZXN0KFwicGFyc2VSb2FkbWFwU2xpY2VzOiB0YWJsZSB3aXRoIFN0YXR1cyBEb25lL0NvbXBsZXRlIHRleHQgKCMxNzM2KVwiLCAoKSA9PiB7XG4gIGNvbnN0IHRhYmxlQ29udGVudCA9IFtcbiAgICBcIiMgTTAwMzogU3RhdHVzIFRleHRcIiwgXCJcIiwgXCIjIyBTbGljZXNcIiwgXCJcIixcbiAgICBcInwgU2xpY2UgfCBUaXRsZSB8IFJpc2sgfCBTdGF0dXMgfFwiLCBcInwtLS18LS0tfC0tLXwtLS18XCIsXG4gICAgXCJ8IFMwMSB8IEZpcnN0IHwgTG93IHwgRG9uZSB8XCIsXG4gICAgXCJ8IFMwMiB8IFNlY29uZCB8IEhpZ2ggfCBQZW5kaW5nIHxcIixcbiAgICBcInwgUzAzIHwgVGhpcmQgfCBNZWRpdW0gfCBDb21wbGV0ZWQgfFwiLCBcIlwiLFxuICBdLmpvaW4oXCJcXG5cIik7XG4gIGNvbnN0IHNsaWNlcyA9IHBhcnNlUm9hZG1hcFNsaWNlcyh0YWJsZUNvbnRlbnQpO1xuICBhc3NlcnQuZXF1YWwoc2xpY2VzLmxlbmd0aCwgMyk7XG4gIGFzc2VydC5lcXVhbChzbGljZXNbMF0/LmRvbmUsIHRydWUpO1xuICBhc3NlcnQuZXF1YWwoc2xpY2VzWzFdPy5kb25lLCBmYWxzZSk7XG4gIGFzc2VydC5lcXVhbChzbGljZXNbMl0/LmRvbmUsIHRydWUpO1xufSk7XG5cbnRlc3QoXCJwYXJzZVJvYWRtYXBTbGljZXM6IHRhYmxlIHdpdGggZ2x5cGggY29tcGxldGlvbiBtYXJrZXJzICgjMjg0MSlcIiwgKCkgPT4ge1xuICBjb25zdCB0YWJsZUNvbnRlbnQgPSBbXG4gICAgXCIjIE0wMDM6IEdseXBoIFN0YXR1c1wiLCBcIlwiLCBcIiMjIFNsaWNlc1wiLCBcIlwiLFxuICAgIFwifCBTbGljZSB8IFRpdGxlIHwgUmlzayB8IFN0YXR1cyB8XCIsIFwifC0tLXwtLS18LS0tfC0tLXxcIixcbiAgICBcInwgUzAxIHwgRmlyc3QgfCBMb3cgfCBcdTI3MDUgfFwiLFxuICAgIFwifCBTMDIgfCBTZWNvbmQgfCBIaWdoIHwgUGVuZGluZyB8XCIsXG4gICAgXCJ8IFMwMyB8IFRoaXJkIHwgTWVkaXVtIHwgXHUyNjExIHxcIixcbiAgICBcInwgUzA0IHwgRm91cnRoIHwgTWVkaXVtIHwgXHUyNzEzIHxcIiwgXCJcIixcbiAgXS5qb2luKFwiXFxuXCIpO1xuICBjb25zdCBzbGljZXMgPSBwYXJzZVJvYWRtYXBTbGljZXModGFibGVDb250ZW50KTtcbiAgYXNzZXJ0LmVxdWFsKHNsaWNlcy5sZW5ndGgsIDQpO1xuICBhc3NlcnQuZXF1YWwoc2xpY2VzWzBdPy5kb25lLCB0cnVlKTtcbiAgYXNzZXJ0LmVxdWFsKHNsaWNlc1sxXT8uZG9uZSwgZmFsc2UpO1xuICBhc3NlcnQuZXF1YWwoc2xpY2VzWzJdPy5kb25lLCB0cnVlKTtcbiAgYXNzZXJ0LmVxdWFsKHNsaWNlc1szXT8uZG9uZSwgdHJ1ZSk7XG59KTtcblxudGVzdChcInBhcnNlUm9hZG1hcFNsaWNlczogdGFibGUgd2l0aCBoZWF2eSBjaGVjayBtYXJrIFUrMjcxNCAoIzI5NDApXCIsICgpID0+IHtcbiAgY29uc3QgdGFibGVDb250ZW50ID0gW1xuICAgIFwiIyBNMDAzOiBIZWF2eSBDaGVja1wiLCBcIlwiLCBcIiMjIFNsaWNlc1wiLCBcIlwiLFxuICAgIFwifCBTbGljZSB8IFRpdGxlIHwgUmlzayB8IFN0YXR1cyB8XCIsIFwifC0tLXwtLS18LS0tfC0tLXxcIixcbiAgICBcInwgUzAxIHwgRmlyc3QgfCBMb3cgfCBcXHUyNzE0IHxcIixcbiAgICBcInwgUzAyIHwgU2Vjb25kIHwgSGlnaCB8IFBlbmRpbmcgfFwiLCBcIlwiLFxuICBdLmpvaW4oXCJcXG5cIik7XG4gIGNvbnN0IHNsaWNlcyA9IHBhcnNlUm9hZG1hcFNsaWNlcyh0YWJsZUNvbnRlbnQpO1xuICBhc3NlcnQuZXF1YWwoc2xpY2VzLmxlbmd0aCwgMik7XG4gIGFzc2VydC5lcXVhbChzbGljZXNbMF0/LmRvbmUsIHRydWUsIFwiVSsyNzE0IGhlYXZ5IGNoZWNrIG1hcmsgc2hvdWxkIG1hcmsgc2xpY2UgYXMgZG9uZVwiKTtcbiAgYXNzZXJ0LmVxdWFsKHNsaWNlc1sxXT8uZG9uZSwgZmFsc2UpO1xufSk7XG5cbnRlc3QoXCJwYXJzZVJvYWRtYXBTbGljZXM6IHRhYmxlIHdpdGggZGVwZW5kZW5jaWVzIGNvbHVtbiAoIzE3MzYpXCIsICgpID0+IHtcbiAgY29uc3QgdGFibGVDb250ZW50ID0gW1xuICAgIFwiIyBNMDA0OiBEZXBzXCIsIFwiXCIsIFwiIyMgU2xpY2VzXCIsIFwiXCIsXG4gICAgXCJ8IFNsaWNlIHwgVGl0bGUgfCBSaXNrIHwgRGVwZW5kcyB8IFN0YXR1cyB8XCIsIFwifC0tLXwtLS18LS0tfC0tLXwtLS18XCIsXG4gICAgXCJ8IFMwMSB8IEZpcnN0IHwgTG93IHwgTm9uZSB8IERvbmUgfFwiLFxuICAgIFwifCBTMDIgfCBTZWNvbmQgfCBIaWdoIHwgUzAxIHwgUGVuZGluZyB8XCIsXG4gICAgXCJ8IFMwMyB8IFRoaXJkIHwgTWVkaXVtIHwgUzAxLCBTMDIgfCBbIF0gfFwiLCBcIlwiLFxuICBdLmpvaW4oXCJcXG5cIik7XG4gIGNvbnN0IHNsaWNlcyA9IHBhcnNlUm9hZG1hcFNsaWNlcyh0YWJsZUNvbnRlbnQpO1xuICBhc3NlcnQuZXF1YWwoc2xpY2VzLmxlbmd0aCwgMyk7XG4gIGFzc2VydC5kZWVwRXF1YWwoc2xpY2VzWzBdPy5kZXBlbmRzLCBbXSk7XG4gIGFzc2VydC5kZWVwRXF1YWwoc2xpY2VzWzFdPy5kZXBlbmRzLCBbXCJTMDFcIl0pO1xuICBhc3NlcnQuZGVlcEVxdWFsKHNsaWNlc1syXT8uZGVwZW5kcywgW1wiUzAxXCIsIFwiUzAyXCJdKTtcbn0pO1xuXG50ZXN0KFwicGFyc2VSb2FkbWFwU2xpY2VzOiBzdGFuZGFyZCBjaGVja2JveCBmb3JtYXQgc3RpbGwgd29ya3MgKCMxNzM2KVwiLCAoKSA9PiB7XG4gIGNvbnN0IGNoZWNrYm94Q29udGVudCA9IFtcbiAgICBcIiMgTTAwNTogVW5jaGFuZ2VkXCIsIFwiXCIsIFwiIyMgU2xpY2VzXCIsIFwiXCIsXG4gICAgXCItIFt4XSAqKlMwMTogRmlyc3QgU2xpY2UqKiBgcmlzazpsb3dgIGBkZXBlbmRzOltdYFwiLFxuICAgIFwiICA+IEFmdGVyIHRoaXM6IEZpcnN0IGRlbW8gd29ya3MuXCIsXG4gICAgXCItIFsgXSAqKlMwMjogU2Vjb25kIFNsaWNlKiogYHJpc2s6bWVkaXVtYCBgZGVwZW5kczpbUzAxXWBcIiwgXCJcIixcbiAgXS5qb2luKFwiXFxuXCIpO1xuICBjb25zdCBzbGljZXMgPSBwYXJzZVJvYWRtYXBTbGljZXMoY2hlY2tib3hDb250ZW50KTtcbiAgYXNzZXJ0LmVxdWFsKHNsaWNlcy5sZW5ndGgsIDIpO1xuICBhc3NlcnQuZXF1YWwoc2xpY2VzWzBdPy5kb25lLCB0cnVlKTtcbiAgYXNzZXJ0LmVxdWFsKHNsaWNlc1sxXT8uZG9uZSwgZmFsc2UpO1xufSk7XG5cbi8vIC0tLSBQcm9zZSBzbGljZSBoZWFkZXIgY29tcGxldGlvbiBtYXJrZXIgdGVzdHMgKCMxODAzKSAtLS1cblxudGVzdChcInBhcnNlUm9hZG1hcFNsaWNlczogcHJvc2UgaGVhZGVycyB3aXRoIFx1MjcxMyBtYXJrZXIgZGV0ZWN0ZWQgYXMgZG9uZVwiLCAoKSA9PiB7XG4gIGNvbnN0IHByb3NlQ29udGVudCA9IGAjIE0wMTA6IFByb3NlIFJvYWRtYXBcblxuIyMgUzAxOiBcdTI3MTMgRmlyc3QgRmVhdHVyZVxuU29tZSBkZXNjcmlwdGlvbi5cblxuIyMgUzAyOiBTZWNvbmQgRmVhdHVyZVxuTm90IGRvbmUgeWV0LlxuXG4jIyBTMDM6IFx1MjcxMyBUaGlyZCBGZWF0dXJlXG5BbHNvIGRvbmUuXG5gO1xuICBjb25zdCBzbGljZXMgPSBwYXJzZVJvYWRtYXBTbGljZXMocHJvc2VDb250ZW50KTtcbiAgYXNzZXJ0LmVxdWFsKHNsaWNlcy5sZW5ndGgsIDMpO1xuICBhc3NlcnQuZXF1YWwoc2xpY2VzWzBdPy5pZCwgXCJTMDFcIik7XG4gIGFzc2VydC5lcXVhbChzbGljZXNbMF0/LmRvbmUsIHRydWUpO1xuICBhc3NlcnQuZXF1YWwoc2xpY2VzWzBdPy50aXRsZSwgXCJGaXJzdCBGZWF0dXJlXCIpO1xuICBhc3NlcnQuZXF1YWwoc2xpY2VzWzFdPy5kb25lLCBmYWxzZSk7XG4gIGFzc2VydC5lcXVhbChzbGljZXNbMl0/LmRvbmUsIHRydWUpO1xufSk7XG5cbnRlc3QoXCJwYXJzZVJvYWRtYXBTbGljZXM6IHByb3NlIGhlYWRlcnMgd2l0aCAoQ29tcGxldGUpIG1hcmtlciBkZXRlY3RlZCBhcyBkb25lXCIsICgpID0+IHtcbiAgY29uc3QgcHJvc2VDb250ZW50ID0gYCMgTTAxMTogUHJvc2UgUm9hZG1hcFxuXG4jIyBTMDE6IEZpcnN0IEZlYXR1cmUgKENvbXBsZXRlKVxuRG9uZSBzbGljZS5cblxuIyMgUzAyOiBTZWNvbmQgRmVhdHVyZVxuSW4gcHJvZ3Jlc3MuXG5gO1xuICBjb25zdCBzbGljZXMgPSBwYXJzZVJvYWRtYXBTbGljZXMocHJvc2VDb250ZW50KTtcbiAgYXNzZXJ0LmVxdWFsKHNsaWNlcy5sZW5ndGgsIDIpO1xuICBhc3NlcnQuZXF1YWwoc2xpY2VzWzBdPy5kb25lLCB0cnVlKTtcbiAgYXNzZXJ0LmVxdWFsKHNsaWNlc1swXT8udGl0bGUsIFwiRmlyc3QgRmVhdHVyZVwiKTtcbiAgYXNzZXJ0LmVxdWFsKHNsaWNlc1sxXT8uZG9uZSwgZmFsc2UpO1xufSk7XG5cbnRlc3QoXCJwYXJzZVJvYWRtYXBTbGljZXM6IHByb3NlIGhlYWRlcnMgd2l0aCBcdTI3MTMgcHJlZml4IGJlZm9yZSB0aXRsZVwiLCAoKSA9PiB7XG4gIGNvbnN0IHByb3NlQ29udGVudCA9IGAjIE0wMTI6IFByb3NlXG5cbiMjIFx1MjcxMyBTMDE6IERvbmUgU2xpY2VcbkNvbXBsZXRlLlxuXG4jIyBTMDI6IFBlbmRpbmcgU2xpY2Vcbk5vdCBkb25lLlxuYDtcbiAgY29uc3Qgc2xpY2VzID0gcGFyc2VSb2FkbWFwU2xpY2VzKHByb3NlQ29udGVudCk7XG4gIGFzc2VydC5lcXVhbChzbGljZXMubGVuZ3RoLCAyKTtcbiAgYXNzZXJ0LmVxdWFsKHNsaWNlc1swXT8uZG9uZSwgdHJ1ZSk7XG4gIGFzc2VydC5lcXVhbChzbGljZXNbMF0/LnRpdGxlLCBcIkRvbmUgU2xpY2VcIik7XG4gIGFzc2VydC5lcXVhbChzbGljZXNbMV0/LmRvbmUsIGZhbHNlKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDAgUmVncmVzc2lvbiB0ZXN0cyBmb3IgIzE3MTEgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJwYXJzZVJvYWRtYXBTbGljZXM6IEgzIHByb3NlIGhlYWRlcnMgdW5kZXIgIyMgU2xpY2VzIHNlY3Rpb24gdHJpZ2dlcnMgcHJvc2UgZmFsbGJhY2sgKCMxNzExKVwiLCAoKSA9PiB7XG4gIGNvbnN0IHByb3NlVW5kZXJTbGljZXMgPSBgIyBNMDEwOiBNeSBNaWxlc3RvbmVcblxuKipWaXNpb246KiogU2hpcCBpdC5cblxuIyMgU2xpY2VzXG5cbiMjIyBTMDEgXHUyMDE0IFNldHVwIEVudmlyb25tZW50XG5TZXQgdXAgdGhlIGRldiBlbnZpcm9ubWVudCBhbmQgdG9vbGluZy5cblxuIyMjIFMwMiBcdTIwMTQgQnVpbGQgQ29yZVxuSW1wbGVtZW50IHRoZSBjb3JlIGxvZ2ljLlxuKipEZXBlbmRzIG9uOioqIFMwMVxuXG4jIyMgUzAzIFx1MjAxNCBQb2xpc2ggVUlcbkZpbmFsIHBvbGlzaCBhbmQgdGhlbWluZy5cbioqRGVwZW5kcyBvbjoqKiBTMDEsIFMwMlxuYDtcbiAgY29uc3Qgc2xpY2VzID0gcGFyc2VSb2FkbWFwU2xpY2VzKHByb3NlVW5kZXJTbGljZXMpO1xuICBhc3NlcnQuZXF1YWwoc2xpY2VzLmxlbmd0aCwgMywgXCJzaG91bGQgZmluZCAzIHNsaWNlcyBmcm9tIEgzIHByb3NlIGhlYWRlcnMgdW5kZXIgIyMgU2xpY2VzXCIpO1xuICBhc3NlcnQuZXF1YWwoc2xpY2VzWzBdPy5pZCwgXCJTMDFcIik7XG4gIGFzc2VydC5lcXVhbChzbGljZXNbMF0/LnRpdGxlLCBcIlNldHVwIEVudmlyb25tZW50XCIpO1xuICBhc3NlcnQuZXF1YWwoc2xpY2VzWzFdPy5pZCwgXCJTMDJcIik7XG4gIGFzc2VydC5kZWVwRXF1YWwoc2xpY2VzWzFdPy5kZXBlbmRzLCBbXCJTMDFcIl0pO1xuICBhc3NlcnQuZXF1YWwoc2xpY2VzWzJdPy5pZCwgXCJTMDNcIik7XG4gIGFzc2VydC5kZWVwRXF1YWwoc2xpY2VzWzJdPy5kZXBlbmRzLCBbXCJTMDFcIiwgXCJTMDJcIl0pO1xufSk7XG5cbnRlc3QoXCJwYXJzZVJvYWRtYXBTbGljZXM6ICMjIFNsaWNlcyB3aXRoIHZhbGlkIGNoZWNrYm94ZXMgZG9lcyBOT1QgaW52b2tlIHByb3NlIGZhbGxiYWNrXCIsICgpID0+IHtcbiAgY29uc3Qgc2xpY2VzID0gcGFyc2VSb2FkbWFwU2xpY2VzKGNvbnRlbnQpO1xuICBhc3NlcnQuZXF1YWwoc2xpY2VzLmxlbmd0aCwgMyk7XG4gIGFzc2VydC5lcXVhbChzbGljZXNbMF0/LmlkLCBcIlMwMVwiKTtcbiAgYXNzZXJ0LmVxdWFsKHNsaWNlc1swXT8uZG9uZSwgdHJ1ZSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwIFJlZ3Jlc3Npb24gdGVzdCBmb3IgIzE5NDAgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4vLyAnIyMgU2xpY2UgUm9hZG1hcCcgaGVhZGVyIGlzIG5vdCByZWNvZ25pemVkIGJ5IGV4dHJhY3RTbGljZXNTZWN0aW9uLCBjYXVzaW5nXG4vLyBjaGVja2JveC1mb3JtYXQgc2xpY2VzIHRvIGJlIG1pc3NlZCBhbmQgYWxsIHNsaWNlcyByZXBvcnRlZCBhcyBpbmNvbXBsZXRlLlxuXG50ZXN0KFwicGFyc2VSb2FkbWFwU2xpY2VzOiAjIyBTbGljZSBSb2FkbWFwIGhlYWRpbmcgcmVjb2duaXplZCAoIzE5NDApXCIsICgpID0+IHtcbiAgY29uc3Qgcm9hZG1hcENvbnRlbnQgPSBbXG4gICAgXCIjIE0wMDI6IEN1cnJlbnQgTWlsZXN0b25lXCIsIFwiXCIsXG4gICAgXCIqKlZpc2lvbjoqKiBTaGlwIGl0LlwiLCBcIlwiLFxuICAgIFwiIyMgU2xpY2UgUm9hZG1hcFwiLCBcIlwiLFxuICAgIFwiLSBbeF0gKipTMDE6IEZvdW5kYXRpb24qKiBgcmlzazpsb3dgIGBkZXBlbmRzOltdYFwiLFxuICAgIFwiICA+IEFmdGVyIHRoaXM6IGJhc2UgbGF5ZXIgd29ya3MuXCIsXG4gICAgXCItIFt4XSAqKlMwMjogQ29yZSBMb2dpYyoqIGByaXNrOm1lZGl1bWAgYGRlcGVuZHM6W1MwMV1gXCIsXG4gICAgXCItIFsgXSAqKlMwMzogUG9saXNoKiogYHJpc2s6bG93YCBgZGVwZW5kczpbUzAxLFMwMl1gXCIsIFwiXCIsXG4gICAgXCIjIyBCb3VuZGFyeSBNYXBcIixcbiAgXS5qb2luKFwiXFxuXCIpO1xuICBjb25zdCBzbGljZXMgPSBwYXJzZVJvYWRtYXBTbGljZXMocm9hZG1hcENvbnRlbnQpO1xuICBhc3NlcnQuZXF1YWwoc2xpY2VzLmxlbmd0aCwgMywgXCJzaG91bGQgcGFyc2UgMyBzbGljZXMgdW5kZXIgJyMjIFNsaWNlIFJvYWRtYXAnXCIpO1xuICBhc3NlcnQuZXF1YWwoc2xpY2VzWzBdPy5pZCwgXCJTMDFcIik7XG4gIGFzc2VydC5lcXVhbChzbGljZXNbMF0/LmRvbmUsIHRydWUsIFwiUzAxIHNob3VsZCBiZSBtYXJrZWQgZG9uZVwiKTtcbiAgYXNzZXJ0LmVxdWFsKHNsaWNlc1sxXT8uaWQsIFwiUzAyXCIpO1xuICBhc3NlcnQuZXF1YWwoc2xpY2VzWzFdPy5kb25lLCB0cnVlLCBcIlMwMiBzaG91bGQgYmUgbWFya2VkIGRvbmVcIik7XG4gIGFzc2VydC5lcXVhbChzbGljZXNbMl0/LmlkLCBcIlMwM1wiKTtcbiAgYXNzZXJ0LmVxdWFsKHNsaWNlc1syXT8uZG9uZSwgZmFsc2UsIFwiUzAzIHNob3VsZCBiZSBwZW5kaW5nXCIpO1xuICBhc3NlcnQuZGVlcEVxdWFsKHNsaWNlc1syXT8uZGVwZW5kcywgW1wiUzAxXCIsIFwiUzAyXCJdKTtcbn0pO1xuXG50ZXN0KFwicGFyc2VSb2FkbWFwU2xpY2VzOiAjIyBTbGljZXMgd2l0aCBvbmx5IG5vbi1tYXRjaGluZyBsaW5lcyByZXR1cm5zIHByb3NlIGZhbGxiYWNrIHJlc3VsdHNcIiwgKCkgPT4ge1xuICBjb25zdCB3ZWlyZENvbnRlbnQgPSBgIyBNMDIwOiBPZGRcblxuIyMgU2xpY2VzXG5Tb21lIGludHJvZHVjdG9yeSB0ZXh0IHRoYXQgaXMgbm90IGEgY2hlY2tib3ggb3IgYSBzbGljZSBoZWFkZXIuXG5cbiMjIyBTMDE6IEZpcnN0IFRoaW5nXG5EbyB0aGUgZmlyc3QgdGhpbmcuXG5cbiMjIyBTMDI6IFNlY29uZCBUaGluZ1xuRG8gdGhlIHNlY29uZCB0aGluZy5cbmA7XG4gIGNvbnN0IHNsaWNlcyA9IHBhcnNlUm9hZG1hcFNsaWNlcyh3ZWlyZENvbnRlbnQpO1xuICBhc3NlcnQuZXF1YWwoc2xpY2VzLmxlbmd0aCwgMiwgXCJzaG91bGQgZmFsbCB0aHJvdWdoIHRvIHByb3NlIHBhcnNlclwiKTtcbiAgYXNzZXJ0LmVxdWFsKHNsaWNlc1swXT8uaWQsIFwiUzAxXCIpO1xuICBhc3NlcnQuZXF1YWwoc2xpY2VzWzFdPy5pZCwgXCJTMDJcIik7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwIFJlZ3Jlc3Npb24gdGVzdHMgZm9yICMyNTY3IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuLy8gUHJvc2UgSDMgcGFyc2VyIGZhaWxzIG9uIGNvbW1vbiBMTE0tZ2VuZXJhdGVkIHBhdHRlcm5zOiBudW1iZXJlZCBwcmVmaXhlcyxcbi8vIHBhcmVudGhldGljYWwgbnVtYmVyaW5nLCBicmFja2V0ZWQgSURzLCBhbmQgaW5kZW50ZWQgaGVhZGluZ3MuXG5cbnRlc3QoXCJwYXJzZVJvYWRtYXBTbGljZXM6IG51bWJlcmVkIEgzIGhlYWRlcnMgdW5kZXIgIyMgU2xpY2VzICgjMjU2NylcIiwgKCkgPT4ge1xuICBjb25zdCBudW1iZXJlZENvbnRlbnQgPSBgIyBNMDAyOiBNeSBNaWxlc3RvbmVcblxuKipWaXNpb246KiogU2hpcCB0aGUgcHJvZHVjdC5cblxuIyMgU2xpY2VzXG5cbiMjIyAxLiBTMDE6IFNldHVwIEVudmlyb25tZW50XG5TZXQgdXAgdGhlIGRldiBlbnZpcm9ubWVudCBhbmQgdG9vbGluZy5cblxuIyMjIDIuIFMwMjogQnVpbGQgQ29yZVxuSW1wbGVtZW50IHRoZSBjb3JlIGxvZ2ljLlxuKipEZXBlbmRzIG9uOioqIFMwMVxuXG4jIyMgMy4gUzAzOiBQb2xpc2ggVUlcbkZpbmFsIHBvbGlzaCBhbmQgdGhlbWluZy5cbioqRGVwZW5kcyBvbjoqKiBTMDEsIFMwMlxuYDtcbiAgY29uc3Qgc2xpY2VzID0gcGFyc2VSb2FkbWFwU2xpY2VzKG51bWJlcmVkQ29udGVudCk7XG4gIGFzc2VydC5lcXVhbChzbGljZXMubGVuZ3RoLCAzLCBcInNob3VsZCBwYXJzZSAzIHNsaWNlcyBmcm9tIG51bWJlcmVkIEgzIGhlYWRlcnNcIik7XG4gIGFzc2VydC5lcXVhbChzbGljZXNbMF0/LmlkLCBcIlMwMVwiKTtcbiAgYXNzZXJ0LmVxdWFsKHNsaWNlc1swXT8udGl0bGUsIFwiU2V0dXAgRW52aXJvbm1lbnRcIik7XG4gIGFzc2VydC5lcXVhbChzbGljZXNbMV0/LmlkLCBcIlMwMlwiKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChzbGljZXNbMV0/LmRlcGVuZHMsIFtcIlMwMVwiXSk7XG4gIGFzc2VydC5lcXVhbChzbGljZXNbMl0/LmlkLCBcIlMwM1wiKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChzbGljZXNbMl0/LmRlcGVuZHMsIFtcIlMwMVwiLCBcIlMwMlwiXSk7XG59KTtcblxudGVzdChcInBhcnNlUm9hZG1hcFNsaWNlczogcGFyZW50aGV0aWNhbC1udW1iZXJlZCBIMyBoZWFkZXJzICgjMjU2NylcIiwgKCkgPT4ge1xuICBjb25zdCBwYXJlbkNvbnRlbnQgPSBgIyBNMDAyOiBNaWxlc3RvbmVcblxuKipWaXNpb246KiogU2hpcC5cblxuIyMgU2xpY2VzXG5cbiMjIyAoMSkgUzAxOiBTZXR1cFxuU2V0dXAgd29yay5cblxuIyMjICgyKSBTMDI6IEJ1aWxkXG5CdWlsZCB3b3JrLlxuKipEZXBlbmRzIG9uOioqIFMwMVxuYDtcbiAgY29uc3Qgc2xpY2VzID0gcGFyc2VSb2FkbWFwU2xpY2VzKHBhcmVuQ29udGVudCk7XG4gIGFzc2VydC5lcXVhbChzbGljZXMubGVuZ3RoLCAyLCBcInNob3VsZCBwYXJzZSBzbGljZXMgd2l0aCBwYXJlbnRoZXRpY2FsIG51bWJlcmluZ1wiKTtcbiAgYXNzZXJ0LmVxdWFsKHNsaWNlc1swXT8uaWQsIFwiUzAxXCIpO1xuICBhc3NlcnQuZXF1YWwoc2xpY2VzWzBdPy50aXRsZSwgXCJTZXR1cFwiKTtcbiAgYXNzZXJ0LmVxdWFsKHNsaWNlc1sxXT8uaWQsIFwiUzAyXCIpO1xuICBhc3NlcnQuZGVlcEVxdWFsKHNsaWNlc1sxXT8uZGVwZW5kcywgW1wiUzAxXCJdKTtcbn0pO1xuXG50ZXN0KFwicGFyc2VSb2FkbWFwU2xpY2VzOiBicmFja2V0ZWQgc2xpY2UgSURzIGluIEgzIGhlYWRlcnMgKCMyNTY3KVwiLCAoKSA9PiB7XG4gIGNvbnN0IGJyYWNrZXRDb250ZW50ID0gYCMgTTAwMjogTWlsZXN0b25lXG5cbioqVmlzaW9uOioqIFNoaXAuXG5cbiMjIFNsaWNlc1xuXG4jIyMgW1MwMV0gU2V0dXAgRW52aXJvbm1lbnRcblNldHVwIHdvcmsuXG5cbiMjIyBbUzAyXSBCdWlsZCBDb3JlXG5CdWlsZCB3b3JrLlxuKipEZXBlbmRzIG9uOioqIFMwMVxuYDtcbiAgY29uc3Qgc2xpY2VzID0gcGFyc2VSb2FkbWFwU2xpY2VzKGJyYWNrZXRDb250ZW50KTtcbiAgYXNzZXJ0LmVxdWFsKHNsaWNlcy5sZW5ndGgsIDIsIFwic2hvdWxkIHBhcnNlIHNsaWNlcyB3aXRoIGJyYWNrZXRlZCBJRHNcIik7XG4gIGFzc2VydC5lcXVhbChzbGljZXNbMF0/LmlkLCBcIlMwMVwiKTtcbiAgYXNzZXJ0LmVxdWFsKHNsaWNlc1swXT8udGl0bGUsIFwiU2V0dXAgRW52aXJvbm1lbnRcIik7XG4gIGFzc2VydC5lcXVhbChzbGljZXNbMV0/LmlkLCBcIlMwMlwiKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChzbGljZXNbMV0/LmRlcGVuZHMsIFtcIlMwMVwiXSk7XG59KTtcblxudGVzdChcInBhcnNlUm9hZG1hcFNsaWNlczogaW5kZW50ZWQgSDMgaGVhZGVycyB1bmRlciAjIyBTbGljZXMgKCMyNTY3KVwiLCAoKSA9PiB7XG4gIGNvbnN0IGluZGVudGVkQ29udGVudCA9IGAjIE0wMDI6IE1pbGVzdG9uZVxuXG4qKlZpc2lvbjoqKiBTaGlwLlxuXG4jIyBTbGljZXNcblxuICAjIyMgUzAxOiBTZXR1cFxuICBTZXR1cCB3b3JrLlxuXG4gICMjIyBTMDI6IEJ1aWxkXG4gIEJ1aWxkIHdvcmsuXG5gO1xuICBjb25zdCBzbGljZXMgPSBwYXJzZVJvYWRtYXBTbGljZXMoaW5kZW50ZWRDb250ZW50KTtcbiAgYXNzZXJ0LmVxdWFsKHNsaWNlcy5sZW5ndGgsIDIsIFwic2hvdWxkIHBhcnNlIHNsaWNlcyBmcm9tIGluZGVudGVkIEgzIGhlYWRlcnNcIik7XG4gIGFzc2VydC5lcXVhbChzbGljZXNbMF0/LmlkLCBcIlMwMVwiKTtcbiAgYXNzZXJ0LmVxdWFsKHNsaWNlc1swXT8udGl0bGUsIFwiU2V0dXBcIik7XG4gIGFzc2VydC5lcXVhbChzbGljZXNbMV0/LmlkLCBcIlMwMlwiKTtcbiAgYXNzZXJ0LmVxdWFsKHNsaWNlc1sxXT8udGl0bGUsIFwiQnVpbGRcIik7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwIFJlZ3Jlc3Npb24gdGVzdHMgZm9yICMxODg0OiBcdTI3MDUgKFUrMjcwNSkgY29tcGxldGlvbiBtYXJrZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJwYXJzZVJvYWRtYXBTbGljZXM6IHByb3NlIGhlYWRlcnMgd2l0aCBcdTI3MDUgc3VmZml4IGRldGVjdGVkIGFzIGRvbmUgKCMxODg0KVwiLCAoKSA9PiB7XG4gIGNvbnN0IHByb3NlQ29udGVudCA9IGAjIE0wMTM6IFByb3NlIFJvYWRtYXBcblxuIyMjIFMwMTogUGxhbiBMaW1pdHMgJiBCaWxsaW5nIEZvdW5kYXRpb24gXHUyNzA1XG5BbGwgdGFza3MgZG9uZS5cblxuIyMjIFMwMjogVXNhZ2UgVHJhY2tpbmdcbk5vdCBkb25lIHlldC5cblxuIyMjIFMwMzogTm90aWZpY2F0aW9uIFN5c3RlbSBcdTI3MDVcbkFsc28gZG9uZS5cbmA7XG4gIGNvbnN0IHNsaWNlcyA9IHBhcnNlUm9hZG1hcFNsaWNlcyhwcm9zZUNvbnRlbnQpO1xuICBhc3NlcnQuZXF1YWwoc2xpY2VzLmxlbmd0aCwgMyk7XG4gIGFzc2VydC5lcXVhbChzbGljZXNbMF0/LmlkLCBcIlMwMVwiKTtcbiAgYXNzZXJ0LmVxdWFsKHNsaWNlc1swXT8uZG9uZSwgdHJ1ZSwgXCJTMDEgd2l0aCB0cmFpbGluZyBcdTI3MDUgc2hvdWxkIGJlIGRvbmVcIik7XG4gIGFzc2VydC5lcXVhbChzbGljZXNbMF0/LnRpdGxlLCBcIlBsYW4gTGltaXRzICYgQmlsbGluZyBGb3VuZGF0aW9uXCIpO1xuICBhc3NlcnQuZXF1YWwoc2xpY2VzWzFdPy5kb25lLCBmYWxzZSk7XG4gIGFzc2VydC5lcXVhbChzbGljZXNbMl0/LmRvbmUsIHRydWUsIFwiUzAzIHdpdGggdHJhaWxpbmcgXHUyNzA1IHNob3VsZCBiZSBkb25lXCIpO1xuICBhc3NlcnQuZXF1YWwoc2xpY2VzWzJdPy50aXRsZSwgXCJOb3RpZmljYXRpb24gU3lzdGVtXCIpO1xufSk7XG5cbnRlc3QoXCJwYXJzZVJvYWRtYXBTbGljZXM6IHByb3NlIGhlYWRlcnMgd2l0aCBcdTI3MDUgcHJlZml4IGJlZm9yZSB0aXRsZSBkZXRlY3RlZCBhcyBkb25lICgjMTg4NClcIiwgKCkgPT4ge1xuICBjb25zdCBwcm9zZUNvbnRlbnQgPSBgIyBNMDE0OiBQcm9zZVxuXG4jIyBcdTI3MDUgUzAxOiBEb25lIFNsaWNlXG5Db21wbGV0ZS5cblxuIyMgUzAyOiBQZW5kaW5nIFNsaWNlXG5Ob3QgZG9uZS5cbmA7XG4gIGNvbnN0IHNsaWNlcyA9IHBhcnNlUm9hZG1hcFNsaWNlcyhwcm9zZUNvbnRlbnQpO1xuICBhc3NlcnQuZXF1YWwoc2xpY2VzLmxlbmd0aCwgMik7XG4gIGFzc2VydC5lcXVhbChzbGljZXNbMF0/LmRvbmUsIHRydWUsIFwicHJlZml4IFx1MjcwNSBzaG91bGQgbWFyayBhcyBkb25lXCIpO1xuICBhc3NlcnQuZXF1YWwoc2xpY2VzWzBdPy50aXRsZSwgXCJEb25lIFNsaWNlXCIpO1xuICBhc3NlcnQuZXF1YWwoc2xpY2VzWzFdPy5kb25lLCBmYWxzZSk7XG59KTtcblxudGVzdChcInBhcnNlUm9hZG1hcFNsaWNlczogcHJvc2UgaGVhZGVycyB3aXRoIFx1MjcwNSBhZnRlciBzZXBhcmF0b3IgZGV0ZWN0ZWQgYXMgZG9uZSAoIzE4ODQpXCIsICgpID0+IHtcbiAgY29uc3QgcHJvc2VDb250ZW50ID0gYCMgTTAxNTogUHJvc2VcblxuIyMgUzAxOiBcdTI3MDUgRmlyc3QgRmVhdHVyZVxuRG9uZS5cblxuIyMgUzAyOiBTZWNvbmQgRmVhdHVyZVxuTm90IGRvbmUuXG5gO1xuICBjb25zdCBzbGljZXMgPSBwYXJzZVJvYWRtYXBTbGljZXMocHJvc2VDb250ZW50KTtcbiAgYXNzZXJ0LmVxdWFsKHNsaWNlcy5sZW5ndGgsIDIpO1xuICBhc3NlcnQuZXF1YWwoc2xpY2VzWzBdPy5kb25lLCB0cnVlLCBcIlx1MjcwNSBhZnRlciBjb2xvbiBzaG91bGQgbWFyayBhcyBkb25lXCIpO1xuICBhc3NlcnQuZXF1YWwoc2xpY2VzWzBdPy50aXRsZSwgXCJGaXJzdCBGZWF0dXJlXCIpO1xuICBhc3NlcnQuZXF1YWwoc2xpY2VzWzFdPy5kb25lLCBmYWxzZSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxvQkFBb0I7QUFDN0IsU0FBUyxvQkFBb0IsMEJBQTBCO0FBRXZELE1BQU0sVUFBVTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtB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
