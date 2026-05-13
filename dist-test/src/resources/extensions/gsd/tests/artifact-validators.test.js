import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { validateArtifact } from "../schemas/validate.js";
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas", "__fixtures__");
function tempBase() {
  const base = join(tmpdir(), `gsd-validator-${randomUUID()}`);
  mkdirSync(base, { recursive: true });
  return base;
}
function hasErrorCode(errors, code) {
  return errors.some((e) => e.code === code);
}
function writeArtifact(base, name, content) {
  const p = join(base, name);
  writeFileSync(p, content, "utf-8");
  return p;
}
test("Deep mode validator: valid PROJECT.md fixture passes", (t) => {
  const result = validateArtifact(join(FIXTURES_DIR, "valid-project.md"), "project");
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.ok, true);
});
test("Deep mode validator: PROJECT.md missing 'What This Is' fails", (t) => {
  const base = tempBase();
  t.after(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  const path = writeArtifact(base, "PROJECT.md", `# Project

## Core Value

Something.

## Current State

Stuff.

## Architecture / Key Patterns

Patterns.

## Capability Contract

See .gsd/REQUIREMENTS.md.

## Milestone Sequence

- [ ] M001: Test \u2014 one
`);
  const result = validateArtifact(path, "project");
  assert.strictEqual(result.ok, false);
  assert.ok(hasErrorCode(result.errors, "missing-section"), "must flag missing section");
});
test("Deep mode validator: PROJECT.md with template tokens fails", (t) => {
  const base = tempBase();
  t.after(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  const path = writeArtifact(base, "PROJECT.md", `# Project

## What This Is

{{whatTheProjectDoes}}

## Core Value

The thing.

## Current State

Now.

## Architecture / Key Patterns

Patterns.

## Capability Contract

See .gsd/REQUIREMENTS.md.

## Milestone Sequence

- [ ] M001: Test \u2014 one
`);
  const result = validateArtifact(path, "project");
  assert.strictEqual(result.ok, false);
  assert.ok(hasErrorCode(result.errors, "template-token"), "must flag unsubstituted template tokens");
});
test("Deep mode validator: PROJECT.md with no milestones fails", (t) => {
  const base = tempBase();
  t.after(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  const path = writeArtifact(base, "PROJECT.md", `# Project

## What This Is

A test.

## Core Value

The thing.

## Current State

Now.

## Architecture / Key Patterns

Patterns.

## Capability Contract

See .gsd/REQUIREMENTS.md.

## Milestone Sequence

(no milestones yet)
`);
  const result = validateArtifact(path, "project");
  assert.strictEqual(result.ok, false);
  assert.ok(hasErrorCode(result.errors, "no-milestones"), "must flag empty milestone sequence");
});
test("Deep mode validator: PROJECT.md with duplicate milestone IDs fails", (t) => {
  const base = tempBase();
  t.after(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  const path = writeArtifact(base, "PROJECT.md", `# Project

## What This Is

A test.

## Core Value

The thing.

## Current State

Now.

## Architecture / Key Patterns

Patterns.

## Capability Contract

See .gsd/REQUIREMENTS.md.

## Milestone Sequence

- [ ] M001: First \u2014 one
- [ ] M001: Duplicate \u2014 two
`);
  const result = validateArtifact(path, "project");
  assert.strictEqual(result.ok, false);
  assert.ok(hasErrorCode(result.errors, "duplicate-milestone"), "must flag duplicate milestone IDs");
});
test("Deep mode validator: missing PROJECT.md file returns file-missing error", () => {
  const result = validateArtifact("/nonexistent/path/PROJECT.md", "project");
  assert.strictEqual(result.ok, false);
  assert.ok(hasErrorCode(result.errors, "file-missing"));
});
test("Deep mode validator: valid REQUIREMENTS.md fixture passes", () => {
  const result = validateArtifact(join(FIXTURES_DIR, "valid-requirements.md"), "requirements");
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.ok, true);
});
test("Deep mode validator: REQUIREMENTS.md missing required section fails", (t) => {
  const base = tempBase();
  t.after(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  const path = writeArtifact(base, "REQUIREMENTS.md", `# Requirements

## Active

## Validated

## Deferred

## Out of Scope

## Coverage Summary
`);
  const result = validateArtifact(path, "requirements");
  assert.strictEqual(result.ok, false);
  assert.ok(hasErrorCode(result.errors, "missing-section"));
});
test("Deep mode validator: requirement under wrong section fails (status-section mismatch)", (t) => {
  const base = tempBase();
  t.after(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  const path = writeArtifact(base, "REQUIREMENTS.md", `# Requirements

## Active

### R001 \u2014 Mismatched
- Class: core-capability
- Status: deferred
- Description: should not be in Active
- Why it matters: status mismatch
- Source: user
- Primary owning slice: none
- Supporting slices: none
- Validation: unmapped
- Notes:

## Validated

## Deferred

## Out of Scope

## Traceability

| ID | Class | Status | Primary owner | Supporting | Proof |
|---|---|---|---|---|---|

## Coverage Summary

- Active requirements: 0
`);
  const result = validateArtifact(path, "requirements");
  assert.strictEqual(result.ok, false);
  assert.ok(hasErrorCode(result.errors, "status-section-mismatch"));
});
test("Deep mode validator: requirement with invalid class fails", (t) => {
  const base = tempBase();
  t.after(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  const path = writeArtifact(base, "REQUIREMENTS.md", `# Requirements

## Active

### R001 \u2014 Bad class
- Class: imaginary-class
- Status: active
- Description: nope
- Why it matters: schema check
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: none
- Validation: unmapped
- Notes:

## Validated

## Deferred

## Out of Scope

## Traceability

| ID | Class | Status | Primary owner | Supporting | Proof |
|---|---|---|---|---|---|

## Coverage Summary

- Active requirements: 1
`);
  const result = validateArtifact(path, "requirements");
  assert.strictEqual(result.ok, false);
  assert.ok(hasErrorCode(result.errors, "invalid-class"));
});
test("Deep mode validator: REQUIREMENTS.md with dangling owner flagged when PROJECT.md provided", (t) => {
  const base = tempBase();
  t.after(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  const projectPath = writeArtifact(base, "PROJECT.md", `# Project

## What This Is
Test.

## Core Value
Thing.

## Current State
Now.

## Architecture / Key Patterns
Patterns.

## Capability Contract
See .gsd/REQUIREMENTS.md.

## Milestone Sequence

- [ ] M001: Real \u2014 present
`);
  const reqPath = writeArtifact(base, "REQUIREMENTS.md", `# Requirements

## Active

### R001 \u2014 Owner points to ghost milestone
- Class: core-capability
- Status: active
- Description: M999 doesn't exist in PROJECT.md
- Why it matters: cross-ref check
- Source: user
- Primary owning slice: M999/S01
- Supporting slices: none
- Validation: unmapped
- Notes:

## Validated

## Deferred

## Out of Scope

## Traceability

| ID | Class | Status | Primary owner | Supporting | Proof |
|---|---|---|---|---|---|

## Coverage Summary

- Active requirements: 1
`);
  const result = validateArtifact(reqPath, "requirements", { crossRefs: { projectPath } });
  assert.strictEqual(result.ok, false);
  assert.ok(hasErrorCode(result.errors, "dangling-owner"));
});
test("Deep mode validator: REQUIREMENTS.md accepts M### primary owner shorthand", (t) => {
  const base = tempBase();
  t.after(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  const reqPath = writeArtifact(base, "REQUIREMENTS.md", [
    "# Requirements",
    "",
    "## Active",
    "",
    "### R001 - Milestone-level owner",
    "- Class: core-capability",
    "- Status: active",
    "- Description: Owner is assigned at milestone granularity.",
    "- Why it matters: Early requirements may not have slices yet.",
    "- Source: user",
    "- Primary owning slice: M001",
    "- Supporting slices: none",
    "- Validation: unmapped",
    "- Notes:",
    "",
    "## Validated",
    "",
    "## Deferred",
    "",
    "## Out of Scope",
    "",
    "## Traceability",
    "",
    "| ID | Class | Status | Primary owner | Supporting | Proof |",
    "|---|---|---|---|---|---|",
    "| R001 | core-capability | active | M001 | none | unmapped |",
    "",
    "## Coverage Summary",
    "",
    "- Active requirements: 1",
    ""
  ].join("\n"));
  const result = validateArtifact(reqPath, "requirements");
  assert.strictEqual(result.ok, true);
  assert.equal(hasErrorCode(result.warnings, "malformed-owner"), false);
});
test("Deep mode validator: roadmap-only cross refs catch dangling slice refs", (t) => {
  const base = tempBase();
  t.after(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  const reqPath = writeArtifact(base, "REQUIREMENTS.md", [
    "# Requirements",
    "",
    "## Active",
    "",
    "### R001 - Bad slice",
    "- Class: core-capability",
    "- Status: active",
    "- Description: Owner references a missing slice in a known roadmap.",
    "- Why it matters: Roadmap-only validation should still catch stale links.",
    "- Source: user",
    "- Primary owning slice: M001/S99",
    "- Supporting slices: none",
    "- Validation: unmapped",
    "- Notes:",
    "",
    "## Validated",
    "",
    "## Deferred",
    "",
    "## Out of Scope",
    "",
    "## Traceability",
    "",
    "| ID | Class | Status | Primary owner | Supporting | Proof |",
    "|---|---|---|---|---|---|",
    "| R001 | core-capability | active | M001/S99 | none | unmapped |",
    "",
    "## Coverage Summary",
    "",
    "- Active requirements: 1",
    ""
  ].join("\n"));
  const roadmapPath = writeArtifact(base, "M001-ROADMAP.md", [
    "# Roadmap",
    "",
    "## Slices",
    "",
    "### S01 - Existing slice",
    "- Risk: low",
    "- Depends: none",
    "- Demo: visible result",
    "",
    "## Definition of Done",
    "",
    "- Slice is complete",
    ""
  ].join("\n"));
  const result = validateArtifact(reqPath, "requirements", {
    crossRefs: { roadmapPaths: { M001: roadmapPath } }
  });
  assert.strictEqual(result.ok, false);
  assert.ok(hasErrorCode(result.errors, "dangling-slice-ref"));
});
test("Deep mode validator: valid ROADMAP.md fixture passes (without cross-refs)", () => {
  const result = validateArtifact(join(FIXTURES_DIR, "valid-roadmap.md"), "roadmap");
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.ok, true);
});
test("Deep mode validator: ROADMAP.md with circular dependencies fails", (t) => {
  const base = tempBase();
  t.after(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  const path = writeArtifact(base, "ROADMAP.md", `# Roadmap

## Slices

### S01 \u2014 Cycle A
- Risk: low
- Depends: S02
- Demo: cycle test

### S02 \u2014 Cycle B
- Risk: low
- Depends: S01
- Demo: cycle test

## Definition of Done

- detect cycles
`);
  const result = validateArtifact(path, "roadmap");
  assert.strictEqual(result.ok, false);
  assert.ok(hasErrorCode(result.errors, "circular-dependency"));
});
test("Deep mode validator: ROADMAP.md with dangling dependency fails", (t) => {
  const base = tempBase();
  t.after(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  const path = writeArtifact(base, "ROADMAP.md", `# Roadmap

## Slices

### S01 \u2014 Real slice
- Risk: low
- Depends: S99
- Demo: dangling test

## Definition of Done

- detect dangling deps
`);
  const result = validateArtifact(path, "roadmap");
  assert.strictEqual(result.ok, false);
  assert.ok(hasErrorCode(result.errors, "dangling-dependency"));
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9hcnRpZmFjdC12YWxpZGF0b3JzLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRC0yIFx1MjAxNCBEZWVwIHBsYW5uaW5nIG1vZGUgYXJ0aWZhY3QgdmFsaWRhdG9yIHRlc3RzLlxuLy8gVmVyaWZpZXMgdmFsaWRhdGVBcnRpZmFjdCgpIGNvcnJlY3RseSBhY2NlcHRzIHZhbGlkIFBST0pFQ1QubWQgLyBSRVFVSVJFTUVOVFMubWQgL1xuLy8gUk9BRE1BUC5tZCBmaXh0dXJlcyBhbmQgZmxhZ3Mgc3BlY2lmaWMgbWFsZm9ybWF0aW9ucyB3aXRoIHRoZSBleHBlY3RlZCBlcnJvciBjb2Rlcy5cblxuaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2RpclN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgam9pbiwgZGlybmFtZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tIFwibm9kZTp1cmxcIjtcblxuaW1wb3J0IHsgdmFsaWRhdGVBcnRpZmFjdCB9IGZyb20gXCIuLi9zY2hlbWFzL3ZhbGlkYXRlLnRzXCI7XG5pbXBvcnQgdHlwZSB7IFZhbGlkYXRpb25FcnJvciB9IGZyb20gXCIuLi9zY2hlbWFzL3ZhbGlkYXRlLnRzXCI7XG5cbmNvbnN0IEZJWFRVUkVTX0RJUiA9IGpvaW4oZGlybmFtZShmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpLCBcIi4uXCIsIFwic2NoZW1hc1wiLCBcIl9fZml4dHVyZXNfX1wiKTtcblxuZnVuY3Rpb24gdGVtcEJhc2UoKTogc3RyaW5nIHtcbiAgY29uc3QgYmFzZSA9IGpvaW4odG1wZGlyKCksIGBnc2QtdmFsaWRhdG9yLSR7cmFuZG9tVVVJRCgpfWApO1xuICBta2RpclN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHJldHVybiBiYXNlO1xufVxuXG5mdW5jdGlvbiBoYXNFcnJvckNvZGUoZXJyb3JzOiBWYWxpZGF0aW9uRXJyb3JbXSwgY29kZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBlcnJvcnMuc29tZShlID0+IGUuY29kZSA9PT0gY29kZSk7XG59XG5cbmZ1bmN0aW9uIHdyaXRlQXJ0aWZhY3QoYmFzZTogc3RyaW5nLCBuYW1lOiBzdHJpbmcsIGNvbnRlbnQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHAgPSBqb2luKGJhc2UsIG5hbWUpO1xuICB3cml0ZUZpbGVTeW5jKHAsIGNvbnRlbnQsIFwidXRmLThcIik7XG4gIHJldHVybiBwO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUFJPSkVDVC5tZCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcIkRlZXAgbW9kZSB2YWxpZGF0b3I6IHZhbGlkIFBST0pFQ1QubWQgZml4dHVyZSBwYXNzZXNcIiwgKHQpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gdmFsaWRhdGVBcnRpZmFjdChqb2luKEZJWFRVUkVTX0RJUiwgXCJ2YWxpZC1wcm9qZWN0Lm1kXCIpLCBcInByb2plY3RcIik7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0LmVycm9ycywgW10pO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0Lm9rLCB0cnVlKTtcbn0pO1xuXG50ZXN0KFwiRGVlcCBtb2RlIHZhbGlkYXRvcjogUFJPSkVDVC5tZCBtaXNzaW5nICdXaGF0IFRoaXMgSXMnIGZhaWxzXCIsICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSB0ZW1wQmFzZSgpO1xuICB0LmFmdGVyKCgpID0+IHsgdHJ5IHsgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTsgfSBjYXRjaCB7fSB9KTtcblxuICBjb25zdCBwYXRoID0gd3JpdGVBcnRpZmFjdChiYXNlLCBcIlBST0pFQ1QubWRcIiwgYCMgUHJvamVjdFxuXG4jIyBDb3JlIFZhbHVlXG5cblNvbWV0aGluZy5cblxuIyMgQ3VycmVudCBTdGF0ZVxuXG5TdHVmZi5cblxuIyMgQXJjaGl0ZWN0dXJlIC8gS2V5IFBhdHRlcm5zXG5cblBhdHRlcm5zLlxuXG4jIyBDYXBhYmlsaXR5IENvbnRyYWN0XG5cblNlZSAuZ3NkL1JFUVVJUkVNRU5UUy5tZC5cblxuIyMgTWlsZXN0b25lIFNlcXVlbmNlXG5cbi0gWyBdIE0wMDE6IFRlc3QgXHUyMDE0IG9uZVxuYCk7XG5cbiAgY29uc3QgcmVzdWx0ID0gdmFsaWRhdGVBcnRpZmFjdChwYXRoLCBcInByb2plY3RcIik7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQub2ssIGZhbHNlKTtcbiAgYXNzZXJ0Lm9rKGhhc0Vycm9yQ29kZShyZXN1bHQuZXJyb3JzLCBcIm1pc3Npbmctc2VjdGlvblwiKSwgXCJtdXN0IGZsYWcgbWlzc2luZyBzZWN0aW9uXCIpO1xufSk7XG5cbnRlc3QoXCJEZWVwIG1vZGUgdmFsaWRhdG9yOiBQUk9KRUNULm1kIHdpdGggdGVtcGxhdGUgdG9rZW5zIGZhaWxzXCIsICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSB0ZW1wQmFzZSgpO1xuICB0LmFmdGVyKCgpID0+IHsgdHJ5IHsgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTsgfSBjYXRjaCB7fSB9KTtcblxuICBjb25zdCBwYXRoID0gd3JpdGVBcnRpZmFjdChiYXNlLCBcIlBST0pFQ1QubWRcIiwgYCMgUHJvamVjdFxuXG4jIyBXaGF0IFRoaXMgSXNcblxue3t3aGF0VGhlUHJvamVjdERvZXN9fVxuXG4jIyBDb3JlIFZhbHVlXG5cblRoZSB0aGluZy5cblxuIyMgQ3VycmVudCBTdGF0ZVxuXG5Ob3cuXG5cbiMjIEFyY2hpdGVjdHVyZSAvIEtleSBQYXR0ZXJuc1xuXG5QYXR0ZXJucy5cblxuIyMgQ2FwYWJpbGl0eSBDb250cmFjdFxuXG5TZWUgLmdzZC9SRVFVSVJFTUVOVFMubWQuXG5cbiMjIE1pbGVzdG9uZSBTZXF1ZW5jZVxuXG4tIFsgXSBNMDAxOiBUZXN0IFx1MjAxNCBvbmVcbmApO1xuXG4gIGNvbnN0IHJlc3VsdCA9IHZhbGlkYXRlQXJ0aWZhY3QocGF0aCwgXCJwcm9qZWN0XCIpO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0Lm9rLCBmYWxzZSk7XG4gIGFzc2VydC5vayhoYXNFcnJvckNvZGUocmVzdWx0LmVycm9ycywgXCJ0ZW1wbGF0ZS10b2tlblwiKSwgXCJtdXN0IGZsYWcgdW5zdWJzdGl0dXRlZCB0ZW1wbGF0ZSB0b2tlbnNcIik7XG59KTtcblxudGVzdChcIkRlZXAgbW9kZSB2YWxpZGF0b3I6IFBST0pFQ1QubWQgd2l0aCBubyBtaWxlc3RvbmVzIGZhaWxzXCIsICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSB0ZW1wQmFzZSgpO1xuICB0LmFmdGVyKCgpID0+IHsgdHJ5IHsgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTsgfSBjYXRjaCB7fSB9KTtcblxuICBjb25zdCBwYXRoID0gd3JpdGVBcnRpZmFjdChiYXNlLCBcIlBST0pFQ1QubWRcIiwgYCMgUHJvamVjdFxuXG4jIyBXaGF0IFRoaXMgSXNcblxuQSB0ZXN0LlxuXG4jIyBDb3JlIFZhbHVlXG5cblRoZSB0aGluZy5cblxuIyMgQ3VycmVudCBTdGF0ZVxuXG5Ob3cuXG5cbiMjIEFyY2hpdGVjdHVyZSAvIEtleSBQYXR0ZXJuc1xuXG5QYXR0ZXJucy5cblxuIyMgQ2FwYWJpbGl0eSBDb250cmFjdFxuXG5TZWUgLmdzZC9SRVFVSVJFTUVOVFMubWQuXG5cbiMjIE1pbGVzdG9uZSBTZXF1ZW5jZVxuXG4obm8gbWlsZXN0b25lcyB5ZXQpXG5gKTtcblxuICBjb25zdCByZXN1bHQgPSB2YWxpZGF0ZUFydGlmYWN0KHBhdGgsIFwicHJvamVjdFwiKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5vaywgZmFsc2UpO1xuICBhc3NlcnQub2soaGFzRXJyb3JDb2RlKHJlc3VsdC5lcnJvcnMsIFwibm8tbWlsZXN0b25lc1wiKSwgXCJtdXN0IGZsYWcgZW1wdHkgbWlsZXN0b25lIHNlcXVlbmNlXCIpO1xufSk7XG5cbnRlc3QoXCJEZWVwIG1vZGUgdmFsaWRhdG9yOiBQUk9KRUNULm1kIHdpdGggZHVwbGljYXRlIG1pbGVzdG9uZSBJRHMgZmFpbHNcIiwgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IHRlbXBCYXNlKCk7XG4gIHQuYWZ0ZXIoKCkgPT4geyB0cnkgeyBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pOyB9IGNhdGNoIHt9IH0pO1xuXG4gIGNvbnN0IHBhdGggPSB3cml0ZUFydGlmYWN0KGJhc2UsIFwiUFJPSkVDVC5tZFwiLCBgIyBQcm9qZWN0XG5cbiMjIFdoYXQgVGhpcyBJc1xuXG5BIHRlc3QuXG5cbiMjIENvcmUgVmFsdWVcblxuVGhlIHRoaW5nLlxuXG4jIyBDdXJyZW50IFN0YXRlXG5cbk5vdy5cblxuIyMgQXJjaGl0ZWN0dXJlIC8gS2V5IFBhdHRlcm5zXG5cblBhdHRlcm5zLlxuXG4jIyBDYXBhYmlsaXR5IENvbnRyYWN0XG5cblNlZSAuZ3NkL1JFUVVJUkVNRU5UUy5tZC5cblxuIyMgTWlsZXN0b25lIFNlcXVlbmNlXG5cbi0gWyBdIE0wMDE6IEZpcnN0IFx1MjAxNCBvbmVcbi0gWyBdIE0wMDE6IER1cGxpY2F0ZSBcdTIwMTQgdHdvXG5gKTtcblxuICBjb25zdCByZXN1bHQgPSB2YWxpZGF0ZUFydGlmYWN0KHBhdGgsIFwicHJvamVjdFwiKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5vaywgZmFsc2UpO1xuICBhc3NlcnQub2soaGFzRXJyb3JDb2RlKHJlc3VsdC5lcnJvcnMsIFwiZHVwbGljYXRlLW1pbGVzdG9uZVwiKSwgXCJtdXN0IGZsYWcgZHVwbGljYXRlIG1pbGVzdG9uZSBJRHNcIik7XG59KTtcblxudGVzdChcIkRlZXAgbW9kZSB2YWxpZGF0b3I6IG1pc3NpbmcgUFJPSkVDVC5tZCBmaWxlIHJldHVybnMgZmlsZS1taXNzaW5nIGVycm9yXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gdmFsaWRhdGVBcnRpZmFjdChcIi9ub25leGlzdGVudC9wYXRoL1BST0pFQ1QubWRcIiwgXCJwcm9qZWN0XCIpO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0Lm9rLCBmYWxzZSk7XG4gIGFzc2VydC5vayhoYXNFcnJvckNvZGUocmVzdWx0LmVycm9ycywgXCJmaWxlLW1pc3NpbmdcIikpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBSRVFVSVJFTUVOVFMubWQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJEZWVwIG1vZGUgdmFsaWRhdG9yOiB2YWxpZCBSRVFVSVJFTUVOVFMubWQgZml4dHVyZSBwYXNzZXNcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSB2YWxpZGF0ZUFydGlmYWN0KGpvaW4oRklYVFVSRVNfRElSLCBcInZhbGlkLXJlcXVpcmVtZW50cy5tZFwiKSwgXCJyZXF1aXJlbWVudHNcIik7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0LmVycm9ycywgW10pO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0Lm9rLCB0cnVlKTtcbn0pO1xuXG50ZXN0KFwiRGVlcCBtb2RlIHZhbGlkYXRvcjogUkVRVUlSRU1FTlRTLm1kIG1pc3NpbmcgcmVxdWlyZWQgc2VjdGlvbiBmYWlsc1wiLCAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gdGVtcEJhc2UoKTtcbiAgdC5hZnRlcigoKSA9PiB7IHRyeSB7IHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7IH0gY2F0Y2gge30gfSk7XG5cbiAgY29uc3QgcGF0aCA9IHdyaXRlQXJ0aWZhY3QoYmFzZSwgXCJSRVFVSVJFTUVOVFMubWRcIiwgYCMgUmVxdWlyZW1lbnRzXG5cbiMjIEFjdGl2ZVxuXG4jIyBWYWxpZGF0ZWRcblxuIyMgRGVmZXJyZWRcblxuIyMgT3V0IG9mIFNjb3BlXG5cbiMjIENvdmVyYWdlIFN1bW1hcnlcbmApO1xuICAvLyBtaXNzaW5nICMjIFRyYWNlYWJpbGl0eVxuXG4gIGNvbnN0IHJlc3VsdCA9IHZhbGlkYXRlQXJ0aWZhY3QocGF0aCwgXCJyZXF1aXJlbWVudHNcIik7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQub2ssIGZhbHNlKTtcbiAgYXNzZXJ0Lm9rKGhhc0Vycm9yQ29kZShyZXN1bHQuZXJyb3JzLCBcIm1pc3Npbmctc2VjdGlvblwiKSk7XG59KTtcblxudGVzdChcIkRlZXAgbW9kZSB2YWxpZGF0b3I6IHJlcXVpcmVtZW50IHVuZGVyIHdyb25nIHNlY3Rpb24gZmFpbHMgKHN0YXR1cy1zZWN0aW9uIG1pc21hdGNoKVwiLCAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gdGVtcEJhc2UoKTtcbiAgdC5hZnRlcigoKSA9PiB7IHRyeSB7IHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7IH0gY2F0Y2gge30gfSk7XG5cbiAgY29uc3QgcGF0aCA9IHdyaXRlQXJ0aWZhY3QoYmFzZSwgXCJSRVFVSVJFTUVOVFMubWRcIiwgYCMgUmVxdWlyZW1lbnRzXG5cbiMjIEFjdGl2ZVxuXG4jIyMgUjAwMSBcdTIwMTQgTWlzbWF0Y2hlZFxuLSBDbGFzczogY29yZS1jYXBhYmlsaXR5XG4tIFN0YXR1czogZGVmZXJyZWRcbi0gRGVzY3JpcHRpb246IHNob3VsZCBub3QgYmUgaW4gQWN0aXZlXG4tIFdoeSBpdCBtYXR0ZXJzOiBzdGF0dXMgbWlzbWF0Y2hcbi0gU291cmNlOiB1c2VyXG4tIFByaW1hcnkgb3duaW5nIHNsaWNlOiBub25lXG4tIFN1cHBvcnRpbmcgc2xpY2VzOiBub25lXG4tIFZhbGlkYXRpb246IHVubWFwcGVkXG4tIE5vdGVzOlxuXG4jIyBWYWxpZGF0ZWRcblxuIyMgRGVmZXJyZWRcblxuIyMgT3V0IG9mIFNjb3BlXG5cbiMjIFRyYWNlYWJpbGl0eVxuXG58IElEIHwgQ2xhc3MgfCBTdGF0dXMgfCBQcmltYXJ5IG93bmVyIHwgU3VwcG9ydGluZyB8IFByb29mIHxcbnwtLS18LS0tfC0tLXwtLS18LS0tfC0tLXxcblxuIyMgQ292ZXJhZ2UgU3VtbWFyeVxuXG4tIEFjdGl2ZSByZXF1aXJlbWVudHM6IDBcbmApO1xuXG4gIGNvbnN0IHJlc3VsdCA9IHZhbGlkYXRlQXJ0aWZhY3QocGF0aCwgXCJyZXF1aXJlbWVudHNcIik7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQub2ssIGZhbHNlKTtcbiAgYXNzZXJ0Lm9rKGhhc0Vycm9yQ29kZShyZXN1bHQuZXJyb3JzLCBcInN0YXR1cy1zZWN0aW9uLW1pc21hdGNoXCIpKTtcbn0pO1xuXG50ZXN0KFwiRGVlcCBtb2RlIHZhbGlkYXRvcjogcmVxdWlyZW1lbnQgd2l0aCBpbnZhbGlkIGNsYXNzIGZhaWxzXCIsICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSB0ZW1wQmFzZSgpO1xuICB0LmFmdGVyKCgpID0+IHsgdHJ5IHsgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTsgfSBjYXRjaCB7fSB9KTtcblxuICBjb25zdCBwYXRoID0gd3JpdGVBcnRpZmFjdChiYXNlLCBcIlJFUVVJUkVNRU5UUy5tZFwiLCBgIyBSZXF1aXJlbWVudHNcblxuIyMgQWN0aXZlXG5cbiMjIyBSMDAxIFx1MjAxNCBCYWQgY2xhc3Ncbi0gQ2xhc3M6IGltYWdpbmFyeS1jbGFzc1xuLSBTdGF0dXM6IGFjdGl2ZVxuLSBEZXNjcmlwdGlvbjogbm9wZVxuLSBXaHkgaXQgbWF0dGVyczogc2NoZW1hIGNoZWNrXG4tIFNvdXJjZTogdXNlclxuLSBQcmltYXJ5IG93bmluZyBzbGljZTogTTAwMS9TMDFcbi0gU3VwcG9ydGluZyBzbGljZXM6IG5vbmVcbi0gVmFsaWRhdGlvbjogdW5tYXBwZWRcbi0gTm90ZXM6XG5cbiMjIFZhbGlkYXRlZFxuXG4jIyBEZWZlcnJlZFxuXG4jIyBPdXQgb2YgU2NvcGVcblxuIyMgVHJhY2VhYmlsaXR5XG5cbnwgSUQgfCBDbGFzcyB8IFN0YXR1cyB8IFByaW1hcnkgb3duZXIgfCBTdXBwb3J0aW5nIHwgUHJvb2YgfFxufC0tLXwtLS18LS0tfC0tLXwtLS18LS0tfFxuXG4jIyBDb3ZlcmFnZSBTdW1tYXJ5XG5cbi0gQWN0aXZlIHJlcXVpcmVtZW50czogMVxuYCk7XG5cbiAgY29uc3QgcmVzdWx0ID0gdmFsaWRhdGVBcnRpZmFjdChwYXRoLCBcInJlcXVpcmVtZW50c1wiKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5vaywgZmFsc2UpO1xuICBhc3NlcnQub2soaGFzRXJyb3JDb2RlKHJlc3VsdC5lcnJvcnMsIFwiaW52YWxpZC1jbGFzc1wiKSk7XG59KTtcblxudGVzdChcIkRlZXAgbW9kZSB2YWxpZGF0b3I6IFJFUVVJUkVNRU5UUy5tZCB3aXRoIGRhbmdsaW5nIG93bmVyIGZsYWdnZWQgd2hlbiBQUk9KRUNULm1kIHByb3ZpZGVkXCIsICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSB0ZW1wQmFzZSgpO1xuICB0LmFmdGVyKCgpID0+IHsgdHJ5IHsgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTsgfSBjYXRjaCB7fSB9KTtcblxuICBjb25zdCBwcm9qZWN0UGF0aCA9IHdyaXRlQXJ0aWZhY3QoYmFzZSwgXCJQUk9KRUNULm1kXCIsIGAjIFByb2plY3RcblxuIyMgV2hhdCBUaGlzIElzXG5UZXN0LlxuXG4jIyBDb3JlIFZhbHVlXG5UaGluZy5cblxuIyMgQ3VycmVudCBTdGF0ZVxuTm93LlxuXG4jIyBBcmNoaXRlY3R1cmUgLyBLZXkgUGF0dGVybnNcblBhdHRlcm5zLlxuXG4jIyBDYXBhYmlsaXR5IENvbnRyYWN0XG5TZWUgLmdzZC9SRVFVSVJFTUVOVFMubWQuXG5cbiMjIE1pbGVzdG9uZSBTZXF1ZW5jZVxuXG4tIFsgXSBNMDAxOiBSZWFsIFx1MjAxNCBwcmVzZW50XG5gKTtcblxuICBjb25zdCByZXFQYXRoID0gd3JpdGVBcnRpZmFjdChiYXNlLCBcIlJFUVVJUkVNRU5UUy5tZFwiLCBgIyBSZXF1aXJlbWVudHNcblxuIyMgQWN0aXZlXG5cbiMjIyBSMDAxIFx1MjAxNCBPd25lciBwb2ludHMgdG8gZ2hvc3QgbWlsZXN0b25lXG4tIENsYXNzOiBjb3JlLWNhcGFiaWxpdHlcbi0gU3RhdHVzOiBhY3RpdmVcbi0gRGVzY3JpcHRpb246IE05OTkgZG9lc24ndCBleGlzdCBpbiBQUk9KRUNULm1kXG4tIFdoeSBpdCBtYXR0ZXJzOiBjcm9zcy1yZWYgY2hlY2tcbi0gU291cmNlOiB1c2VyXG4tIFByaW1hcnkgb3duaW5nIHNsaWNlOiBNOTk5L1MwMVxuLSBTdXBwb3J0aW5nIHNsaWNlczogbm9uZVxuLSBWYWxpZGF0aW9uOiB1bm1hcHBlZFxuLSBOb3RlczpcblxuIyMgVmFsaWRhdGVkXG5cbiMjIERlZmVycmVkXG5cbiMjIE91dCBvZiBTY29wZVxuXG4jIyBUcmFjZWFiaWxpdHlcblxufCBJRCB8IENsYXNzIHwgU3RhdHVzIHwgUHJpbWFyeSBvd25lciB8IFN1cHBvcnRpbmcgfCBQcm9vZiB8XG58LS0tfC0tLXwtLS18LS0tfC0tLXwtLS18XG5cbiMjIENvdmVyYWdlIFN1bW1hcnlcblxuLSBBY3RpdmUgcmVxdWlyZW1lbnRzOiAxXG5gKTtcblxuICBjb25zdCByZXN1bHQgPSB2YWxpZGF0ZUFydGlmYWN0KHJlcVBhdGgsIFwicmVxdWlyZW1lbnRzXCIsIHsgY3Jvc3NSZWZzOiB7IHByb2plY3RQYXRoIH0gfSk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQub2ssIGZhbHNlKTtcbiAgYXNzZXJ0Lm9rKGhhc0Vycm9yQ29kZShyZXN1bHQuZXJyb3JzLCBcImRhbmdsaW5nLW93bmVyXCIpKTtcbn0pO1xuXG50ZXN0KFwiRGVlcCBtb2RlIHZhbGlkYXRvcjogUkVRVUlSRU1FTlRTLm1kIGFjY2VwdHMgTSMjIyBwcmltYXJ5IG93bmVyIHNob3J0aGFuZFwiLCAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gdGVtcEJhc2UoKTtcbiAgdC5hZnRlcigoKSA9PiB7IHRyeSB7IHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7IH0gY2F0Y2gge30gfSk7XG5cbiAgY29uc3QgcmVxUGF0aCA9IHdyaXRlQXJ0aWZhY3QoYmFzZSwgXCJSRVFVSVJFTUVOVFMubWRcIiwgW1xuICAgIFwiIyBSZXF1aXJlbWVudHNcIixcbiAgICBcIlwiLFxuICAgIFwiIyMgQWN0aXZlXCIsXG4gICAgXCJcIixcbiAgICBcIiMjIyBSMDAxIC0gTWlsZXN0b25lLWxldmVsIG93bmVyXCIsXG4gICAgXCItIENsYXNzOiBjb3JlLWNhcGFiaWxpdHlcIixcbiAgICBcIi0gU3RhdHVzOiBhY3RpdmVcIixcbiAgICBcIi0gRGVzY3JpcHRpb246IE93bmVyIGlzIGFzc2lnbmVkIGF0IG1pbGVzdG9uZSBncmFudWxhcml0eS5cIixcbiAgICBcIi0gV2h5IGl0IG1hdHRlcnM6IEVhcmx5IHJlcXVpcmVtZW50cyBtYXkgbm90IGhhdmUgc2xpY2VzIHlldC5cIixcbiAgICBcIi0gU291cmNlOiB1c2VyXCIsXG4gICAgXCItIFByaW1hcnkgb3duaW5nIHNsaWNlOiBNMDAxXCIsXG4gICAgXCItIFN1cHBvcnRpbmcgc2xpY2VzOiBub25lXCIsXG4gICAgXCItIFZhbGlkYXRpb246IHVubWFwcGVkXCIsXG4gICAgXCItIE5vdGVzOlwiLFxuICAgIFwiXCIsXG4gICAgXCIjIyBWYWxpZGF0ZWRcIixcbiAgICBcIlwiLFxuICAgIFwiIyMgRGVmZXJyZWRcIixcbiAgICBcIlwiLFxuICAgIFwiIyMgT3V0IG9mIFNjb3BlXCIsXG4gICAgXCJcIixcbiAgICBcIiMjIFRyYWNlYWJpbGl0eVwiLFxuICAgIFwiXCIsXG4gICAgXCJ8IElEIHwgQ2xhc3MgfCBTdGF0dXMgfCBQcmltYXJ5IG93bmVyIHwgU3VwcG9ydGluZyB8IFByb29mIHxcIixcbiAgICBcInwtLS18LS0tfC0tLXwtLS18LS0tfC0tLXxcIixcbiAgICBcInwgUjAwMSB8IGNvcmUtY2FwYWJpbGl0eSB8IGFjdGl2ZSB8IE0wMDEgfCBub25lIHwgdW5tYXBwZWQgfFwiLFxuICAgIFwiXCIsXG4gICAgXCIjIyBDb3ZlcmFnZSBTdW1tYXJ5XCIsXG4gICAgXCJcIixcbiAgICBcIi0gQWN0aXZlIHJlcXVpcmVtZW50czogMVwiLFxuICAgIFwiXCIsXG4gIF0uam9pbihcIlxcblwiKSk7XG5cbiAgY29uc3QgcmVzdWx0ID0gdmFsaWRhdGVBcnRpZmFjdChyZXFQYXRoLCBcInJlcXVpcmVtZW50c1wiKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5vaywgdHJ1ZSk7XG4gIGFzc2VydC5lcXVhbChoYXNFcnJvckNvZGUocmVzdWx0Lndhcm5pbmdzLCBcIm1hbGZvcm1lZC1vd25lclwiKSwgZmFsc2UpO1xufSk7XG5cbnRlc3QoXCJEZWVwIG1vZGUgdmFsaWRhdG9yOiByb2FkbWFwLW9ubHkgY3Jvc3MgcmVmcyBjYXRjaCBkYW5nbGluZyBzbGljZSByZWZzXCIsICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSB0ZW1wQmFzZSgpO1xuICB0LmFmdGVyKCgpID0+IHsgdHJ5IHsgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTsgfSBjYXRjaCB7fSB9KTtcblxuICBjb25zdCByZXFQYXRoID0gd3JpdGVBcnRpZmFjdChiYXNlLCBcIlJFUVVJUkVNRU5UUy5tZFwiLCBbXG4gICAgXCIjIFJlcXVpcmVtZW50c1wiLFxuICAgIFwiXCIsXG4gICAgXCIjIyBBY3RpdmVcIixcbiAgICBcIlwiLFxuICAgIFwiIyMjIFIwMDEgLSBCYWQgc2xpY2VcIixcbiAgICBcIi0gQ2xhc3M6IGNvcmUtY2FwYWJpbGl0eVwiLFxuICAgIFwiLSBTdGF0dXM6IGFjdGl2ZVwiLFxuICAgIFwiLSBEZXNjcmlwdGlvbjogT3duZXIgcmVmZXJlbmNlcyBhIG1pc3Npbmcgc2xpY2UgaW4gYSBrbm93biByb2FkbWFwLlwiLFxuICAgIFwiLSBXaHkgaXQgbWF0dGVyczogUm9hZG1hcC1vbmx5IHZhbGlkYXRpb24gc2hvdWxkIHN0aWxsIGNhdGNoIHN0YWxlIGxpbmtzLlwiLFxuICAgIFwiLSBTb3VyY2U6IHVzZXJcIixcbiAgICBcIi0gUHJpbWFyeSBvd25pbmcgc2xpY2U6IE0wMDEvUzk5XCIsXG4gICAgXCItIFN1cHBvcnRpbmcgc2xpY2VzOiBub25lXCIsXG4gICAgXCItIFZhbGlkYXRpb246IHVubWFwcGVkXCIsXG4gICAgXCItIE5vdGVzOlwiLFxuICAgIFwiXCIsXG4gICAgXCIjIyBWYWxpZGF0ZWRcIixcbiAgICBcIlwiLFxuICAgIFwiIyMgRGVmZXJyZWRcIixcbiAgICBcIlwiLFxuICAgIFwiIyMgT3V0IG9mIFNjb3BlXCIsXG4gICAgXCJcIixcbiAgICBcIiMjIFRyYWNlYWJpbGl0eVwiLFxuICAgIFwiXCIsXG4gICAgXCJ8IElEIHwgQ2xhc3MgfCBTdGF0dXMgfCBQcmltYXJ5IG93bmVyIHwgU3VwcG9ydGluZyB8IFByb29mIHxcIixcbiAgICBcInwtLS18LS0tfC0tLXwtLS18LS0tfC0tLXxcIixcbiAgICBcInwgUjAwMSB8IGNvcmUtY2FwYWJpbGl0eSB8IGFjdGl2ZSB8IE0wMDEvUzk5IHwgbm9uZSB8IHVubWFwcGVkIHxcIixcbiAgICBcIlwiLFxuICAgIFwiIyMgQ292ZXJhZ2UgU3VtbWFyeVwiLFxuICAgIFwiXCIsXG4gICAgXCItIEFjdGl2ZSByZXF1aXJlbWVudHM6IDFcIixcbiAgICBcIlwiLFxuICBdLmpvaW4oXCJcXG5cIikpO1xuXG4gIGNvbnN0IHJvYWRtYXBQYXRoID0gd3JpdGVBcnRpZmFjdChiYXNlLCBcIk0wMDEtUk9BRE1BUC5tZFwiLCBbXG4gICAgXCIjIFJvYWRtYXBcIixcbiAgICBcIlwiLFxuICAgIFwiIyMgU2xpY2VzXCIsXG4gICAgXCJcIixcbiAgICBcIiMjIyBTMDEgLSBFeGlzdGluZyBzbGljZVwiLFxuICAgIFwiLSBSaXNrOiBsb3dcIixcbiAgICBcIi0gRGVwZW5kczogbm9uZVwiLFxuICAgIFwiLSBEZW1vOiB2aXNpYmxlIHJlc3VsdFwiLFxuICAgIFwiXCIsXG4gICAgXCIjIyBEZWZpbml0aW9uIG9mIERvbmVcIixcbiAgICBcIlwiLFxuICAgIFwiLSBTbGljZSBpcyBjb21wbGV0ZVwiLFxuICAgIFwiXCIsXG4gIF0uam9pbihcIlxcblwiKSk7XG5cbiAgY29uc3QgcmVzdWx0ID0gdmFsaWRhdGVBcnRpZmFjdChyZXFQYXRoLCBcInJlcXVpcmVtZW50c1wiLCB7XG4gICAgY3Jvc3NSZWZzOiB7IHJvYWRtYXBQYXRoczogeyBNMDAxOiByb2FkbWFwUGF0aCB9IH0sXG4gIH0pO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0Lm9rLCBmYWxzZSk7XG4gIGFzc2VydC5vayhoYXNFcnJvckNvZGUocmVzdWx0LmVycm9ycywgXCJkYW5nbGluZy1zbGljZS1yZWZcIikpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBST0FETUFQLm1kIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiRGVlcCBtb2RlIHZhbGlkYXRvcjogdmFsaWQgUk9BRE1BUC5tZCBmaXh0dXJlIHBhc3NlcyAod2l0aG91dCBjcm9zcy1yZWZzKVwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IHZhbGlkYXRlQXJ0aWZhY3Qoam9pbihGSVhUVVJFU19ESVIsIFwidmFsaWQtcm9hZG1hcC5tZFwiKSwgXCJyb2FkbWFwXCIpO1xuICAvLyBNYXkgaGF2ZSBvcnBoYW4tc2xpY2Ugd2FybmluZ3MgKG5vIHJlcXVpcmVtZW50cyBwcm92aWRlZCkgYnV0IG5vIGVycm9yc1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC5lcnJvcnMsIFtdKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5vaywgdHJ1ZSk7XG59KTtcblxudGVzdChcIkRlZXAgbW9kZSB2YWxpZGF0b3I6IFJPQURNQVAubWQgd2l0aCBjaXJjdWxhciBkZXBlbmRlbmNpZXMgZmFpbHNcIiwgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IHRlbXBCYXNlKCk7XG4gIHQuYWZ0ZXIoKCkgPT4geyB0cnkgeyBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pOyB9IGNhdGNoIHt9IH0pO1xuXG4gIGNvbnN0IHBhdGggPSB3cml0ZUFydGlmYWN0KGJhc2UsIFwiUk9BRE1BUC5tZFwiLCBgIyBSb2FkbWFwXG5cbiMjIFNsaWNlc1xuXG4jIyMgUzAxIFx1MjAxNCBDeWNsZSBBXG4tIFJpc2s6IGxvd1xuLSBEZXBlbmRzOiBTMDJcbi0gRGVtbzogY3ljbGUgdGVzdFxuXG4jIyMgUzAyIFx1MjAxNCBDeWNsZSBCXG4tIFJpc2s6IGxvd1xuLSBEZXBlbmRzOiBTMDFcbi0gRGVtbzogY3ljbGUgdGVzdFxuXG4jIyBEZWZpbml0aW9uIG9mIERvbmVcblxuLSBkZXRlY3QgY3ljbGVzXG5gKTtcblxuICBjb25zdCByZXN1bHQgPSB2YWxpZGF0ZUFydGlmYWN0KHBhdGgsIFwicm9hZG1hcFwiKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5vaywgZmFsc2UpO1xuICBhc3NlcnQub2soaGFzRXJyb3JDb2RlKHJlc3VsdC5lcnJvcnMsIFwiY2lyY3VsYXItZGVwZW5kZW5jeVwiKSk7XG59KTtcblxudGVzdChcIkRlZXAgbW9kZSB2YWxpZGF0b3I6IFJPQURNQVAubWQgd2l0aCBkYW5nbGluZyBkZXBlbmRlbmN5IGZhaWxzXCIsICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSB0ZW1wQmFzZSgpO1xuICB0LmFmdGVyKCgpID0+IHsgdHJ5IHsgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTsgfSBjYXRjaCB7fSB9KTtcblxuICBjb25zdCBwYXRoID0gd3JpdGVBcnRpZmFjdChiYXNlLCBcIlJPQURNQVAubWRcIiwgYCMgUm9hZG1hcFxuXG4jIyBTbGljZXNcblxuIyMjIFMwMSBcdTIwMTQgUmVhbCBzbGljZVxuLSBSaXNrOiBsb3dcbi0gRGVwZW5kczogUzk5XG4tIERlbW86IGRhbmdsaW5nIHRlc3RcblxuIyMgRGVmaW5pdGlvbiBvZiBEb25lXG5cbi0gZGV0ZWN0IGRhbmdsaW5nIGRlcHNcbmApO1xuXG4gIGNvbnN0IHJlc3VsdCA9IHZhbGlkYXRlQXJ0aWZhY3QocGF0aCwgXCJyb2FkbWFwXCIpO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0Lm9rLCBmYWxzZSk7XG4gIGFzc2VydC5vayhoYXNFcnJvckNvZGUocmVzdWx0LmVycm9ycywgXCJkYW5nbGluZy1kZXBlbmRlbmN5XCIpKTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBSUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUNuQixTQUFTLFdBQVcsUUFBUSxxQkFBcUI7QUFDakQsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsTUFBTSxlQUFlO0FBQzlCLFNBQVMsa0JBQWtCO0FBQzNCLFNBQVMscUJBQXFCO0FBRTlCLFNBQVMsd0JBQXdCO0FBR2pDLE1BQU0sZUFBZSxLQUFLLFFBQVEsY0FBYyxZQUFZLEdBQUcsQ0FBQyxHQUFHLE1BQU0sV0FBVyxjQUFjO0FBRWxHLFNBQVMsV0FBbUI7QUFDMUIsUUFBTSxPQUFPLEtBQUssT0FBTyxHQUFHLGlCQUFpQixXQUFXLENBQUMsRUFBRTtBQUMzRCxZQUFVLE1BQU0sRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNuQyxTQUFPO0FBQ1Q7QUFFQSxTQUFTLGFBQWEsUUFBMkIsTUFBdUI7QUFDdEUsU0FBTyxPQUFPLEtBQUssT0FBSyxFQUFFLFNBQVMsSUFBSTtBQUN6QztBQUVBLFNBQVMsY0FBYyxNQUFjLE1BQWMsU0FBeUI7QUFDMUUsUUFBTSxJQUFJLEtBQUssTUFBTSxJQUFJO0FBQ3pCLGdCQUFjLEdBQUcsU0FBUyxPQUFPO0FBQ2pD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
