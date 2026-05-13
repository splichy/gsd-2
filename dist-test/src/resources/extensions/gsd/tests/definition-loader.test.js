import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadDefinition,
  validateDefinition,
  substituteParams,
  substitutePromptString
} from "../definition-loader.js";
function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), "gsd-defloader-test-"));
}
function writeDefYaml(yaml, name = "test-workflow") {
  const dir = makeTmpDir();
  writeFileSync(join(dir, `${name}.yaml`), yaml, "utf-8");
  return dir;
}
const VALID_3STEP_YAML = `
version: 1
name: "test-workflow"
description: "A test workflow"
params:
  topic: "AI"
steps:
  - id: research
    name: "Research the topic"
    prompt: "Research {{topic}} and write findings to research.md"
    requires: []
    produces:
      - research.md
  - id: outline
    name: "Create outline"
    prompt: "Based on research.md, create an outline in outline.md"
    requires: [research]
    produces:
      - outline.md
  - id: draft
    name: "Write draft"
    prompt: "Write a draft based on outline.md"
    requires: [outline]
    produces:
      - draft.md
`;
test("loadDefinition: valid 3-step YAML returns correct structure", (t) => {
  const dir = writeDefYaml(VALID_3STEP_YAML);
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
    }
  });
  const def = loadDefinition(dir, "test-workflow");
  assert.equal(def.version, 1);
  assert.equal(def.name, "test-workflow");
  assert.equal(def.description, "A test workflow");
  assert.deepEqual(def.params, { topic: "AI" });
  assert.equal(def.steps.length, 3);
  assert.equal(def.steps[0].id, "research");
  assert.equal(def.steps[0].name, "Research the topic");
  assert.equal(def.steps[0].prompt, "Research {{topic}} and write findings to research.md");
  assert.deepEqual(def.steps[0].requires, []);
  assert.deepEqual(def.steps[0].produces, ["research.md"]);
  assert.equal(def.steps[1].id, "outline");
  assert.deepEqual(def.steps[1].requires, ["research"]);
  assert.equal(def.steps[2].id, "draft");
  assert.deepEqual(def.steps[2].requires, ["outline"]);
  assert.deepEqual(def.steps[2].produces, ["draft.md"]);
});
test("validateDefinition: missing version \u2192 error", () => {
  const result = validateDefinition({
    name: "test",
    steps: [{ id: "a", name: "A", prompt: "do A" }]
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("version")));
});
test("validateDefinition: version 2 (unsupported) \u2192 error", () => {
  const result = validateDefinition({
    version: 2,
    name: "test",
    steps: [{ id: "a", name: "A", prompt: "do A" }]
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("Unsupported version: 2")));
});
test("validateDefinition: missing step id \u2192 error", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [{ name: "A", prompt: "do A" }]
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("index 0") && e.includes("id")));
});
test("validateDefinition: missing step prompt \u2192 error", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [{ id: "a", name: "A" }]
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("index 0") && e.includes("prompt")));
});
test("validateDefinition: produces with '..' path traversal \u2192 error", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [{ id: "a", name: "A", prompt: "do A", produces: ["../secret.txt"] }]
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("..") && e.includes("produces")));
});
test("validateDefinition: unknown fields (context_from, iterate) \u2192 accepted silently", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    future_top_level_field: true,
    steps: [{
      id: "a",
      name: "A",
      prompt: "do A",
      context_from: ["other-step"],
      iterate: { source: "file.md", pattern: "^## (.+)" },
      some_future_field: 42
    }]
  });
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});
test("validateDefinition: collects multiple errors in one pass", () => {
  const result = validateDefinition({
    // missing version and name
    steps: [
      { id: "a" },
      // missing name and prompt
      { name: "B", prompt: "do B" }
      // missing id
    ]
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.length >= 4, `Expected \u22654 errors, got ${result.errors.length}: ${result.errors.join("; ")}`);
});
test("validateDefinition: null input \u2192 error", () => {
  const result = validateDefinition(null);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("non-null object")));
});
test("validateDefinition: empty steps array \u2192 error", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: []
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("at least one step")));
});
test("validateDefinition: missing name \u2192 error", () => {
  const result = validateDefinition({
    version: 1,
    steps: [{ id: "a", name: "A", prompt: "do A" }]
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("name")));
});
test("validateDefinition: step is not an object \u2192 error", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: ["not-an-object"]
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("index 0") && e.includes("not an object")));
});
test("validateDefinition: missing step name \u2192 error", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [{ id: "a", prompt: "do A" }]
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("index 0") && e.includes("name")));
});
test("loadDefinition: missing file \u2192 descriptive error", (t) => {
  const dir = makeTmpDir();
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
    }
  });
  assert.throws(
    () => loadDefinition(dir, "nonexistent"),
    (err) => {
      assert.ok(err.message.includes("not found"));
      assert.ok(err.message.includes("nonexistent.yaml"));
      return true;
    }
  );
});
test("loadDefinition: invalid YAML schema \u2192 descriptive error", (t) => {
  const dir = writeDefYaml(`
version: 2
name: "bad"
steps:
  - id: a
    name: "A"
    prompt: "do A"
`);
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
    }
  });
  assert.throws(
    () => loadDefinition(dir, "test-workflow"),
    (err) => {
      assert.ok(err.message.includes("Invalid workflow definition"));
      assert.ok(err.message.includes("Unsupported version"));
      return true;
    }
  );
});
test("loadDefinition: depends_on in YAML maps to requires in TypeScript", (t) => {
  const dir = writeDefYaml(`
version: 1
name: "dep-test"
steps:
  - id: first
    name: "First"
    prompt: "do first"
  - id: second
    name: "Second"
    prompt: "do second"
    depends_on: [first]
`);
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
    }
  });
  const def = loadDefinition(dir, "test-workflow");
  assert.deepEqual(def.steps[1].requires, ["first"]);
});
test("loadDefinition: context_from in YAML maps to contextFrom in TypeScript", (t) => {
  const dir = writeDefYaml(`
version: 1
name: "ctx-test"
steps:
  - id: first
    name: "First"
    prompt: "do first"
  - id: second
    name: "Second"
    prompt: "do second"
    context_from: [first]
`);
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
    }
  });
  const def = loadDefinition(dir, "test-workflow");
  assert.deepEqual(def.steps[1].contextFrom, ["first"]);
});
test("validateDefinition: valid iterate config accepted", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [{
      id: "a",
      name: "A",
      prompt: "do A",
      iterate: { source: "outline.md", pattern: "^## (.+)" }
    }]
  });
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});
test("validateDefinition: iterate missing source \u2192 error", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [{
      id: "a",
      name: "A",
      prompt: "do A",
      iterate: { pattern: "^## (.+)" }
    }]
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("source")));
});
test("validateDefinition: iterate source with .. \u2192 error", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [{
      id: "a",
      name: "A",
      prompt: "do A",
      iterate: { source: "../escape.md", pattern: "(.+)" }
    }]
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("path traversal") || e.includes("..")));
});
test("validateDefinition: iterate invalid regex \u2192 error", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [{
      id: "a",
      name: "A",
      prompt: "do A",
      iterate: { source: "f.md", pattern: "[invalid" }
    }]
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("regex")));
});
test("validateDefinition: iterate pattern without capture group \u2192 error", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [{
      id: "a",
      name: "A",
      prompt: "do A",
      iterate: { source: "f.md", pattern: "^## .+" }
    }]
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("capture group")));
});
test("validateDefinition: valid content-heuristic verify \u2192 accepted", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [{
      id: "a",
      name: "A",
      prompt: "do A",
      verify: { policy: "content-heuristic", minSize: 100, pattern: "^## " }
    }]
  });
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});
test("validateDefinition: valid shell-command verify \u2192 accepted", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [{
      id: "a",
      name: "A",
      prompt: "do A",
      verify: { policy: "shell-command", command: "cat output.md | grep '^## '" }
    }]
  });
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});
test("validateDefinition: valid prompt-verify \u2192 accepted", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [{
      id: "a",
      name: "A",
      prompt: "do A",
      verify: { policy: "prompt-verify", prompt: "Does the output contain at least 3 sections?" }
    }]
  });
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});
test("validateDefinition: valid human-review verify \u2192 accepted", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [{
      id: "a",
      name: "A",
      prompt: "do A",
      verify: { policy: "human-review" }
    }]
  });
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});
test("validateDefinition: invalid verify policy name \u2192 rejected", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [{
      id: "a",
      name: "A",
      prompt: "do A",
      verify: { policy: "magic-check" }
    }]
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("verify.policy must be one of")));
});
test("validateDefinition: shell-command missing command \u2192 rejected", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [{
      id: "a",
      name: "A",
      prompt: "do A",
      verify: { policy: "shell-command" }
    }]
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('requires a non-empty "command"')));
});
test("validateDefinition: prompt-verify missing prompt \u2192 rejected", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [{
      id: "a",
      name: "A",
      prompt: "do A",
      verify: { policy: "prompt-verify" }
    }]
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('requires a non-empty "prompt"')));
});
test("validateDefinition: duplicate step IDs \u2192 error", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [
      { id: "dup", name: "A", prompt: "do A" },
      { id: "dup", name: "B", prompt: "do B" }
    ]
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("Duplicate step id")));
  assert.ok(result.errors.some((e) => e.includes("dup")));
});
test("validateDefinition: dangling dependency \u2192 error", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [
      { id: "a", name: "A", prompt: "do A" },
      { id: "b", name: "B", prompt: "do B", requires: ["nonexistent"] }
    ]
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("requires unknown step")));
  assert.ok(result.errors.some((e) => e.includes("nonexistent")));
});
test("validateDefinition: dangling dependency via depends_on \u2192 error", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [
      { id: "a", name: "A", prompt: "do A" },
      { id: "b", name: "B", prompt: "do B", depends_on: ["ghost"] }
    ]
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("requires unknown step")));
  assert.ok(result.errors.some((e) => e.includes("ghost")));
});
test("validateDefinition: self-referencing dependency \u2192 error", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [
      { id: "a", name: "A", prompt: "do A", requires: ["a"] }
    ]
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("depends on itself")));
});
test("validateDefinition: simple cycle (A\u2192B\u2192A) \u2192 error", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [
      { id: "a", name: "A", prompt: "do A", requires: ["b"] },
      { id: "b", name: "B", prompt: "do B", requires: ["a"] }
    ]
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("Cycle detected")));
});
test("validateDefinition: complex cycle (A\u2192B\u2192C\u2192A) \u2192 error", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [
      { id: "a", name: "A", prompt: "do A", requires: ["c"] },
      { id: "b", name: "B", prompt: "do B", requires: ["a"] },
      { id: "c", name: "C", prompt: "do C", requires: ["b"] }
    ]
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("Cycle detected")));
});
test("validateDefinition: diamond dependency (no cycle) \u2192 accepted", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [
      { id: "a", name: "A", prompt: "do A" },
      { id: "b", name: "B", prompt: "do B", requires: ["a"] },
      { id: "c", name: "C", prompt: "do C", requires: ["a"] },
      { id: "d", name: "D", prompt: "do D", requires: ["b", "c"] }
    ]
  });
  assert.equal(result.valid, true, `Expected valid but got errors: ${result.errors.join("; ")}`);
  assert.equal(result.errors.length, 0);
});
test("validateDefinition: linear chain (no cycle) \u2192 accepted", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [
      { id: "a", name: "A", prompt: "do A" },
      { id: "b", name: "B", prompt: "do B", requires: ["a"] },
      { id: "c", name: "C", prompt: "do C", requires: ["b"] },
      { id: "d", name: "D", prompt: "do D", requires: ["c"] }
    ]
  });
  assert.equal(result.valid, true);
});
test("substituteParams: replaces placeholders with defaults", () => {
  const def = {
    version: 1,
    name: "test",
    params: { topic: "AI", format: "markdown" },
    steps: [
      { id: "a", name: "A", prompt: "Write about {{topic}} in {{format}}", requires: [], produces: [] }
    ]
  };
  const result = substituteParams(def);
  assert.equal(result.steps[0].prompt, "Write about AI in markdown");
});
test("substituteParams: overrides win over defaults", () => {
  const def = {
    version: 1,
    name: "test",
    params: { topic: "AI" },
    steps: [
      { id: "a", name: "A", prompt: "Write about {{topic}}", requires: [], produces: [] }
    ]
  };
  const result = substituteParams(def, { topic: "Robotics" });
  assert.equal(result.steps[0].prompt, "Write about Robotics");
});
test("substituteParams: rejects values containing '..'", () => {
  const def = {
    version: 1,
    name: "test",
    params: { path: "safe" },
    steps: [
      { id: "a", name: "A", prompt: "Read {{path}}", requires: [], produces: [] }
    ]
  };
  assert.throws(
    () => substituteParams(def, { path: "../etc/passwd" }),
    (err) => {
      assert.ok(err.message.includes(".."));
      assert.ok(err.message.includes("path traversal"));
      return true;
    }
  );
});
test("substituteParams: errors on unresolved placeholders", () => {
  const def = {
    version: 1,
    name: "test",
    steps: [
      { id: "a", name: "A", prompt: "Write about {{topic}}", requires: [], produces: [] }
    ]
  };
  assert.throws(
    () => substituteParams(def),
    (err) => {
      assert.ok(err.message.includes("Unresolved"));
      assert.ok(err.message.includes("topic"));
      return true;
    }
  );
});
test("substituteParams: does not mutate the original definition", () => {
  const def = {
    version: 1,
    name: "test",
    params: { topic: "AI" },
    steps: [
      { id: "a", name: "A", prompt: "Write about {{topic}}", requires: [], produces: [] }
    ]
  };
  const original = def.steps[0].prompt;
  substituteParams(def);
  assert.equal(def.steps[0].prompt, original, "Original definition should not be mutated");
});
test("substitutePromptString: replaces known placeholders, leaves unknown", () => {
  const result = substitutePromptString(
    "Hello {{name}}, write about {{topic}}",
    { name: "Agent" }
  );
  assert.equal(result, "Hello Agent, write about {{topic}}");
});
test("substitutePromptString: no placeholders \u2192 unchanged", () => {
  const result = substitutePromptString("No placeholders here", {});
  assert.equal(result, "No placeholders here");
});
test("validateDefinition: steps is not an array \u2192 error", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: "not-an-array"
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("steps") && e.includes("array")));
});
test("validateDefinition: valid minimal step (no requires/produces) \u2192 accepted", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [{ id: "a", name: "A", prompt: "do A" }]
  });
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});
test("loadDefinition: loads without params field \u2192 params is undefined", (t) => {
  const dir = writeDefYaml(`
version: 1
name: "no-params"
steps:
  - id: a
    name: "A"
    prompt: "do A"
`);
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
    }
  });
  const def = loadDefinition(dir, "test-workflow");
  assert.equal(def.params, void 0);
});
test("loadDefinition: loads without description \u2192 description is undefined", (t) => {
  const dir = writeDefYaml(`
version: 1
name: "no-desc"
steps:
  - id: a
    name: "A"
    prompt: "do A"
`);
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
    }
  });
  const def = loadDefinition(dir, "test-workflow");
  assert.equal(def.description, void 0);
});
test("loadDefinition: step with no requires/produces defaults to empty arrays", (t) => {
  const dir = writeDefYaml(`
version: 1
name: "defaults"
steps:
  - id: a
    name: "A"
    prompt: "do A"
`);
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
    }
  });
  const def = loadDefinition(dir, "test-workflow");
  assert.deepEqual(def.steps[0].requires, []);
  assert.deepEqual(def.steps[0].produces, []);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9kZWZpbml0aW9uLWxvYWRlci50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFVuaXQgdGVzdHMgZm9yIGRlZmluaXRpb24tbG9hZGVyLnRzLlxuICpcbiAqIENvdmVycyBWMSBZQU1MIHNjaGVtYSB2YWxpZGF0aW9uICh2YWxpZCArIHZhcmlvdXMgcmVqZWN0aW9uIGNhc2VzKSxcbiAqIGZpbGVzeXN0ZW0gbG9hZGluZywgc25ha2VfY2FzZSBcdTIxOTIgY2FtZWxDYXNlIGNvbnZlcnNpb24sIGZvcndhcmRcbiAqIGNvbXBhdGliaWxpdHkgd2l0aCB1bmtub3duIGZpZWxkcywgcGFyYW1ldGVyIHN1YnN0aXR1dGlvbiwgYW5kIHRoZVxuICogZm91ciBnYXAgdmFsaWRhdGlvbnMgKGR1cGxpY2F0ZSBJRHMsIGRhbmdsaW5nIGRlcHMsIHNlbGYtZGVwcywgY3ljbGVzKS5cbiAqL1xuXG5pbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5cbmltcG9ydCB7XG4gIGxvYWREZWZpbml0aW9uLFxuICB2YWxpZGF0ZURlZmluaXRpb24sXG4gIHN1YnN0aXR1dGVQYXJhbXMsXG4gIHN1YnN0aXR1dGVQcm9tcHRTdHJpbmcsXG59IGZyb20gXCIuLi9kZWZpbml0aW9uLWxvYWRlci50c1wiO1xuaW1wb3J0IHR5cGUgeyBXb3JrZmxvd0RlZmluaXRpb24gfSBmcm9tIFwiLi4vZGVmaW5pdGlvbi1sb2FkZXIudHNcIjtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEhlbHBlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIG1ha2VUbXBEaXIoKTogc3RyaW5nIHtcbiAgcmV0dXJuIG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLWRlZmxvYWRlci10ZXN0LVwiKSk7XG59XG5cbi8qKiBXcml0ZSBhIFlBTUwgc3RyaW5nIGludG8gYSB0ZW1wIGRlZmluaXRpb25zIGRpcmVjdG9yeS4gUmV0dXJucyB0aGUgZGlyIHBhdGguICovXG5mdW5jdGlvbiB3cml0ZURlZllhbWwoeWFtbDogc3RyaW5nLCBuYW1lID0gXCJ0ZXN0LXdvcmtmbG93XCIpOiBzdHJpbmcge1xuICBjb25zdCBkaXIgPSBtYWtlVG1wRGlyKCk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIGAke25hbWV9LnlhbWxgKSwgeWFtbCwgXCJ1dGYtOFwiKTtcbiAgcmV0dXJuIGRpcjtcbn1cblxuY29uc3QgVkFMSURfM1NURVBfWUFNTCA9IGBcbnZlcnNpb246IDFcbm5hbWU6IFwidGVzdC13b3JrZmxvd1wiXG5kZXNjcmlwdGlvbjogXCJBIHRlc3Qgd29ya2Zsb3dcIlxucGFyYW1zOlxuICB0b3BpYzogXCJBSVwiXG5zdGVwczpcbiAgLSBpZDogcmVzZWFyY2hcbiAgICBuYW1lOiBcIlJlc2VhcmNoIHRoZSB0b3BpY1wiXG4gICAgcHJvbXB0OiBcIlJlc2VhcmNoIHt7dG9waWN9fSBhbmQgd3JpdGUgZmluZGluZ3MgdG8gcmVzZWFyY2gubWRcIlxuICAgIHJlcXVpcmVzOiBbXVxuICAgIHByb2R1Y2VzOlxuICAgICAgLSByZXNlYXJjaC5tZFxuICAtIGlkOiBvdXRsaW5lXG4gICAgbmFtZTogXCJDcmVhdGUgb3V0bGluZVwiXG4gICAgcHJvbXB0OiBcIkJhc2VkIG9uIHJlc2VhcmNoLm1kLCBjcmVhdGUgYW4gb3V0bGluZSBpbiBvdXRsaW5lLm1kXCJcbiAgICByZXF1aXJlczogW3Jlc2VhcmNoXVxuICAgIHByb2R1Y2VzOlxuICAgICAgLSBvdXRsaW5lLm1kXG4gIC0gaWQ6IGRyYWZ0XG4gICAgbmFtZTogXCJXcml0ZSBkcmFmdFwiXG4gICAgcHJvbXB0OiBcIldyaXRlIGEgZHJhZnQgYmFzZWQgb24gb3V0bGluZS5tZFwiXG4gICAgcmVxdWlyZXM6IFtvdXRsaW5lXVxuICAgIHByb2R1Y2VzOlxuICAgICAgLSBkcmFmdC5tZFxuYDtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGxvYWREZWZpbml0aW9uOiB2YWxpZCBZQU1MIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwibG9hZERlZmluaXRpb246IHZhbGlkIDMtc3RlcCBZQU1MIHJldHVybnMgY29ycmVjdCBzdHJ1Y3R1cmVcIiwgKHQpID0+IHtcbiAgY29uc3QgZGlyID0gd3JpdGVEZWZZYW1sKFZBTElEXzNTVEVQX1lBTUwpO1xuICB0LmFmdGVyKCgpID0+IHsgdHJ5IHsgcm1TeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlLCBtYXhSZXRyaWVzOiAzLCByZXRyeURlbGF5OiAxMDAgfSk7IH0gY2F0Y2ggeyAvKiBXaW5kb3dzIEVQRVJNICovIH0gfSk7XG5cbiAgY29uc3QgZGVmID0gbG9hZERlZmluaXRpb24oZGlyLCBcInRlc3Qtd29ya2Zsb3dcIik7XG5cbiAgYXNzZXJ0LmVxdWFsKGRlZi52ZXJzaW9uLCAxKTtcbiAgYXNzZXJ0LmVxdWFsKGRlZi5uYW1lLCBcInRlc3Qtd29ya2Zsb3dcIik7XG4gIGFzc2VydC5lcXVhbChkZWYuZGVzY3JpcHRpb24sIFwiQSB0ZXN0IHdvcmtmbG93XCIpO1xuICBhc3NlcnQuZGVlcEVxdWFsKGRlZi5wYXJhbXMsIHsgdG9waWM6IFwiQUlcIiB9KTtcbiAgYXNzZXJ0LmVxdWFsKGRlZi5zdGVwcy5sZW5ndGgsIDMpO1xuXG4gIC8vIFN0ZXAgMTogcmVzZWFyY2hcbiAgYXNzZXJ0LmVxdWFsKGRlZi5zdGVwc1swXS5pZCwgXCJyZXNlYXJjaFwiKTtcbiAgYXNzZXJ0LmVxdWFsKGRlZi5zdGVwc1swXS5uYW1lLCBcIlJlc2VhcmNoIHRoZSB0b3BpY1wiKTtcbiAgYXNzZXJ0LmVxdWFsKGRlZi5zdGVwc1swXS5wcm9tcHQsIFwiUmVzZWFyY2gge3t0b3BpY319IGFuZCB3cml0ZSBmaW5kaW5ncyB0byByZXNlYXJjaC5tZFwiKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChkZWYuc3RlcHNbMF0ucmVxdWlyZXMsIFtdKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChkZWYuc3RlcHNbMF0ucHJvZHVjZXMsIFtcInJlc2VhcmNoLm1kXCJdKTtcblxuICAvLyBTdGVwIDI6IG91dGxpbmUgXHUyMDE0IGRlcGVuZHMgb24gcmVzZWFyY2hcbiAgYXNzZXJ0LmVxdWFsKGRlZi5zdGVwc1sxXS5pZCwgXCJvdXRsaW5lXCIpO1xuICBhc3NlcnQuZGVlcEVxdWFsKGRlZi5zdGVwc1sxXS5yZXF1aXJlcywgW1wicmVzZWFyY2hcIl0pO1xuXG4gIC8vIFN0ZXAgMzogZHJhZnQgXHUyMDE0IGRlcGVuZHMgb24gb3V0bGluZVxuICBhc3NlcnQuZXF1YWwoZGVmLnN0ZXBzWzJdLmlkLCBcImRyYWZ0XCIpO1xuICBhc3NlcnQuZGVlcEVxdWFsKGRlZi5zdGVwc1syXS5yZXF1aXJlcywgW1wib3V0bGluZVwiXSk7XG4gIGFzc2VydC5kZWVwRXF1YWwoZGVmLnN0ZXBzWzJdLnByb2R1Y2VzLCBbXCJkcmFmdC5tZFwiXSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHZhbGlkYXRlRGVmaW5pdGlvbjogcmVqZWN0aW9uIGNhc2VzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwidmFsaWRhdGVEZWZpbml0aW9uOiBtaXNzaW5nIHZlcnNpb24gXHUyMTkyIGVycm9yXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gdmFsaWRhdGVEZWZpbml0aW9uKHtcbiAgICBuYW1lOiBcInRlc3RcIixcbiAgICBzdGVwczogW3sgaWQ6IFwiYVwiLCBuYW1lOiBcIkFcIiwgcHJvbXB0OiBcImRvIEFcIiB9XSxcbiAgfSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQudmFsaWQsIGZhbHNlKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdC5lcnJvcnMuc29tZSgoZSkgPT4gZS5pbmNsdWRlcyhcInZlcnNpb25cIikpKTtcbn0pO1xuXG50ZXN0KFwidmFsaWRhdGVEZWZpbml0aW9uOiB2ZXJzaW9uIDIgKHVuc3VwcG9ydGVkKSBcdTIxOTIgZXJyb3JcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSB2YWxpZGF0ZURlZmluaXRpb24oe1xuICAgIHZlcnNpb246IDIsXG4gICAgbmFtZTogXCJ0ZXN0XCIsXG4gICAgc3RlcHM6IFt7IGlkOiBcImFcIiwgbmFtZTogXCJBXCIsIHByb21wdDogXCJkbyBBXCIgfV0sXG4gIH0pO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnZhbGlkLCBmYWxzZSk7XG4gIGFzc2VydC5vayhyZXN1bHQuZXJyb3JzLnNvbWUoKGUpID0+IGUuaW5jbHVkZXMoXCJVbnN1cHBvcnRlZCB2ZXJzaW9uOiAyXCIpKSk7XG59KTtcblxudGVzdChcInZhbGlkYXRlRGVmaW5pdGlvbjogbWlzc2luZyBzdGVwIGlkIFx1MjE5MiBlcnJvclwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IHZhbGlkYXRlRGVmaW5pdGlvbih7XG4gICAgdmVyc2lvbjogMSxcbiAgICBuYW1lOiBcInRlc3RcIixcbiAgICBzdGVwczogW3sgbmFtZTogXCJBXCIsIHByb21wdDogXCJkbyBBXCIgfV0sXG4gIH0pO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnZhbGlkLCBmYWxzZSk7XG4gIGFzc2VydC5vayhyZXN1bHQuZXJyb3JzLnNvbWUoKGUpID0+IGUuaW5jbHVkZXMoXCJpbmRleCAwXCIpICYmIGUuaW5jbHVkZXMoXCJpZFwiKSkpO1xufSk7XG5cbnRlc3QoXCJ2YWxpZGF0ZURlZmluaXRpb246IG1pc3Npbmcgc3RlcCBwcm9tcHQgXHUyMTkyIGVycm9yXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gdmFsaWRhdGVEZWZpbml0aW9uKHtcbiAgICB2ZXJzaW9uOiAxLFxuICAgIG5hbWU6IFwidGVzdFwiLFxuICAgIHN0ZXBzOiBbeyBpZDogXCJhXCIsIG5hbWU6IFwiQVwiIH1dLFxuICB9KTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC52YWxpZCwgZmFsc2UpO1xuICBhc3NlcnQub2socmVzdWx0LmVycm9ycy5zb21lKChlKSA9PiBlLmluY2x1ZGVzKFwiaW5kZXggMFwiKSAmJiBlLmluY2x1ZGVzKFwicHJvbXB0XCIpKSk7XG59KTtcblxudGVzdChcInZhbGlkYXRlRGVmaW5pdGlvbjogcHJvZHVjZXMgd2l0aCAnLi4nIHBhdGggdHJhdmVyc2FsIFx1MjE5MiBlcnJvclwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IHZhbGlkYXRlRGVmaW5pdGlvbih7XG4gICAgdmVyc2lvbjogMSxcbiAgICBuYW1lOiBcInRlc3RcIixcbiAgICBzdGVwczogW3sgaWQ6IFwiYVwiLCBuYW1lOiBcIkFcIiwgcHJvbXB0OiBcImRvIEFcIiwgcHJvZHVjZXM6IFtcIi4uL3NlY3JldC50eHRcIl0gfV0sXG4gIH0pO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnZhbGlkLCBmYWxzZSk7XG4gIGFzc2VydC5vayhyZXN1bHQuZXJyb3JzLnNvbWUoKGUpID0+IGUuaW5jbHVkZXMoXCIuLlwiKSAmJiBlLmluY2x1ZGVzKFwicHJvZHVjZXNcIikpKTtcbn0pO1xuXG50ZXN0KFwidmFsaWRhdGVEZWZpbml0aW9uOiB1bmtub3duIGZpZWxkcyAoY29udGV4dF9mcm9tLCBpdGVyYXRlKSBcdTIxOTIgYWNjZXB0ZWQgc2lsZW50bHlcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSB2YWxpZGF0ZURlZmluaXRpb24oe1xuICAgIHZlcnNpb246IDEsXG4gICAgbmFtZTogXCJ0ZXN0XCIsXG4gICAgZnV0dXJlX3RvcF9sZXZlbF9maWVsZDogdHJ1ZSxcbiAgICBzdGVwczogW3tcbiAgICAgIGlkOiBcImFcIixcbiAgICAgIG5hbWU6IFwiQVwiLFxuICAgICAgcHJvbXB0OiBcImRvIEFcIixcbiAgICAgIGNvbnRleHRfZnJvbTogW1wib3RoZXItc3RlcFwiXSxcbiAgICAgIGl0ZXJhdGU6IHsgc291cmNlOiBcImZpbGUubWRcIiwgcGF0dGVybjogXCJeIyMgKC4rKVwiIH0sXG4gICAgICBzb21lX2Z1dHVyZV9maWVsZDogNDIsXG4gICAgfV0sXG4gIH0pO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnZhbGlkLCB0cnVlKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5lcnJvcnMubGVuZ3RoLCAwKTtcbn0pO1xuXG50ZXN0KFwidmFsaWRhdGVEZWZpbml0aW9uOiBjb2xsZWN0cyBtdWx0aXBsZSBlcnJvcnMgaW4gb25lIHBhc3NcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSB2YWxpZGF0ZURlZmluaXRpb24oe1xuICAgIC8vIG1pc3NpbmcgdmVyc2lvbiBhbmQgbmFtZVxuICAgIHN0ZXBzOiBbXG4gICAgICB7IGlkOiBcImFcIiB9LCAvLyBtaXNzaW5nIG5hbWUgYW5kIHByb21wdFxuICAgICAgeyBuYW1lOiBcIkJcIiwgcHJvbXB0OiBcImRvIEJcIiB9LCAvLyBtaXNzaW5nIGlkXG4gICAgXSxcbiAgfSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQudmFsaWQsIGZhbHNlKTtcbiAgLy8gU2hvdWxkIGhhdmUgZXJyb3JzIGZvcjogdmVyc2lvbiwgbmFtZSwgc3RlcCAwIG5hbWUsIHN0ZXAgMCBwcm9tcHQsIHN0ZXAgMSBpZFxuICBhc3NlcnQub2socmVzdWx0LmVycm9ycy5sZW5ndGggPj0gNCwgYEV4cGVjdGVkIFx1MjI2NTQgZXJyb3JzLCBnb3QgJHtyZXN1bHQuZXJyb3JzLmxlbmd0aH06ICR7cmVzdWx0LmVycm9ycy5qb2luKFwiOyBcIil9YCk7XG59KTtcblxudGVzdChcInZhbGlkYXRlRGVmaW5pdGlvbjogbnVsbCBpbnB1dCBcdTIxOTIgZXJyb3JcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSB2YWxpZGF0ZURlZmluaXRpb24obnVsbCk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQudmFsaWQsIGZhbHNlKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdC5lcnJvcnMuc29tZSgoZSkgPT4gZS5pbmNsdWRlcyhcIm5vbi1udWxsIG9iamVjdFwiKSkpO1xufSk7XG5cbnRlc3QoXCJ2YWxpZGF0ZURlZmluaXRpb246IGVtcHR5IHN0ZXBzIGFycmF5IFx1MjE5MiBlcnJvclwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IHZhbGlkYXRlRGVmaW5pdGlvbih7XG4gICAgdmVyc2lvbjogMSxcbiAgICBuYW1lOiBcInRlc3RcIixcbiAgICBzdGVwczogW10sXG4gIH0pO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnZhbGlkLCBmYWxzZSk7XG4gIGFzc2VydC5vayhyZXN1bHQuZXJyb3JzLnNvbWUoKGUpID0+IGUuaW5jbHVkZXMoXCJhdCBsZWFzdCBvbmUgc3RlcFwiKSkpO1xufSk7XG5cbnRlc3QoXCJ2YWxpZGF0ZURlZmluaXRpb246IG1pc3NpbmcgbmFtZSBcdTIxOTIgZXJyb3JcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSB2YWxpZGF0ZURlZmluaXRpb24oe1xuICAgIHZlcnNpb246IDEsXG4gICAgc3RlcHM6IFt7IGlkOiBcImFcIiwgbmFtZTogXCJBXCIsIHByb21wdDogXCJkbyBBXCIgfV0sXG4gIH0pO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnZhbGlkLCBmYWxzZSk7XG4gIGFzc2VydC5vayhyZXN1bHQuZXJyb3JzLnNvbWUoKGUpID0+IGUuaW5jbHVkZXMoXCJuYW1lXCIpKSk7XG59KTtcblxudGVzdChcInZhbGlkYXRlRGVmaW5pdGlvbjogc3RlcCBpcyBub3QgYW4gb2JqZWN0IFx1MjE5MiBlcnJvclwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IHZhbGlkYXRlRGVmaW5pdGlvbih7XG4gICAgdmVyc2lvbjogMSxcbiAgICBuYW1lOiBcInRlc3RcIixcbiAgICBzdGVwczogW1wibm90LWFuLW9iamVjdFwiXSxcbiAgfSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQudmFsaWQsIGZhbHNlKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdC5lcnJvcnMuc29tZSgoZSkgPT4gZS5pbmNsdWRlcyhcImluZGV4IDBcIikgJiYgZS5pbmNsdWRlcyhcIm5vdCBhbiBvYmplY3RcIikpKTtcbn0pO1xuXG50ZXN0KFwidmFsaWRhdGVEZWZpbml0aW9uOiBtaXNzaW5nIHN0ZXAgbmFtZSBcdTIxOTIgZXJyb3JcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSB2YWxpZGF0ZURlZmluaXRpb24oe1xuICAgIHZlcnNpb246IDEsXG4gICAgbmFtZTogXCJ0ZXN0XCIsXG4gICAgc3RlcHM6IFt7IGlkOiBcImFcIiwgcHJvbXB0OiBcImRvIEFcIiB9XSxcbiAgfSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQudmFsaWQsIGZhbHNlKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdC5lcnJvcnMuc29tZSgoZSkgPT4gZS5pbmNsdWRlcyhcImluZGV4IDBcIikgJiYgZS5pbmNsdWRlcyhcIm5hbWVcIikpKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgbG9hZERlZmluaXRpb246IGVycm9yIGNhc2VzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwibG9hZERlZmluaXRpb246IG1pc3NpbmcgZmlsZSBcdTIxOTIgZGVzY3JpcHRpdmUgZXJyb3JcIiwgKHQpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRtcERpcigpO1xuICB0LmFmdGVyKCgpID0+IHsgdHJ5IHsgcm1TeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlLCBtYXhSZXRyaWVzOiAzLCByZXRyeURlbGF5OiAxMDAgfSk7IH0gY2F0Y2ggeyAvKiBXaW5kb3dzIEVQRVJNICovIH0gfSk7XG5cbiAgYXNzZXJ0LnRocm93cyhcbiAgICAoKSA9PiBsb2FkRGVmaW5pdGlvbihkaXIsIFwibm9uZXhpc3RlbnRcIiksXG4gICAgKGVycjogRXJyb3IpID0+IHtcbiAgICAgIGFzc2VydC5vayhlcnIubWVzc2FnZS5pbmNsdWRlcyhcIm5vdCBmb3VuZFwiKSk7XG4gICAgICBhc3NlcnQub2soZXJyLm1lc3NhZ2UuaW5jbHVkZXMoXCJub25leGlzdGVudC55YW1sXCIpKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0sXG4gICk7XG59KTtcblxudGVzdChcImxvYWREZWZpbml0aW9uOiBpbnZhbGlkIFlBTUwgc2NoZW1hIFx1MjE5MiBkZXNjcmlwdGl2ZSBlcnJvclwiLCAodCkgPT4ge1xuICBjb25zdCBkaXIgPSB3cml0ZURlZllhbWwoYFxudmVyc2lvbjogMlxubmFtZTogXCJiYWRcIlxuc3RlcHM6XG4gIC0gaWQ6IGFcbiAgICBuYW1lOiBcIkFcIlxuICAgIHByb21wdDogXCJkbyBBXCJcbmApO1xuICB0LmFmdGVyKCgpID0+IHsgdHJ5IHsgcm1TeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlLCBtYXhSZXRyaWVzOiAzLCByZXRyeURlbGF5OiAxMDAgfSk7IH0gY2F0Y2ggeyAvKiBXaW5kb3dzIEVQRVJNICovIH0gfSk7XG5cbiAgYXNzZXJ0LnRocm93cyhcbiAgICAoKSA9PiBsb2FkRGVmaW5pdGlvbihkaXIsIFwidGVzdC13b3JrZmxvd1wiKSxcbiAgICAoZXJyOiBFcnJvcikgPT4ge1xuICAgICAgYXNzZXJ0Lm9rKGVyci5tZXNzYWdlLmluY2x1ZGVzKFwiSW52YWxpZCB3b3JrZmxvdyBkZWZpbml0aW9uXCIpKTtcbiAgICAgIGFzc2VydC5vayhlcnIubWVzc2FnZS5pbmNsdWRlcyhcIlVuc3VwcG9ydGVkIHZlcnNpb25cIikpO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfSxcbiAgKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgbG9hZERlZmluaXRpb246IHNuYWtlX2Nhc2UgXHUyMTkyIGNhbWVsQ2FzZSBjb252ZXJzaW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwibG9hZERlZmluaXRpb246IGRlcGVuZHNfb24gaW4gWUFNTCBtYXBzIHRvIHJlcXVpcmVzIGluIFR5cGVTY3JpcHRcIiwgKHQpID0+IHtcbiAgY29uc3QgZGlyID0gd3JpdGVEZWZZYW1sKGBcbnZlcnNpb246IDFcbm5hbWU6IFwiZGVwLXRlc3RcIlxuc3RlcHM6XG4gIC0gaWQ6IGZpcnN0XG4gICAgbmFtZTogXCJGaXJzdFwiXG4gICAgcHJvbXB0OiBcImRvIGZpcnN0XCJcbiAgLSBpZDogc2Vjb25kXG4gICAgbmFtZTogXCJTZWNvbmRcIlxuICAgIHByb21wdDogXCJkbyBzZWNvbmRcIlxuICAgIGRlcGVuZHNfb246IFtmaXJzdF1cbmApO1xuICB0LmFmdGVyKCgpID0+IHsgdHJ5IHsgcm1TeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlLCBtYXhSZXRyaWVzOiAzLCByZXRyeURlbGF5OiAxMDAgfSk7IH0gY2F0Y2ggeyAvKiBXaW5kb3dzIEVQRVJNICovIH0gfSk7XG5cbiAgY29uc3QgZGVmID0gbG9hZERlZmluaXRpb24oZGlyLCBcInRlc3Qtd29ya2Zsb3dcIik7XG4gIGFzc2VydC5kZWVwRXF1YWwoZGVmLnN0ZXBzWzFdLnJlcXVpcmVzLCBbXCJmaXJzdFwiXSk7XG59KTtcblxudGVzdChcImxvYWREZWZpbml0aW9uOiBjb250ZXh0X2Zyb20gaW4gWUFNTCBtYXBzIHRvIGNvbnRleHRGcm9tIGluIFR5cGVTY3JpcHRcIiwgKHQpID0+IHtcbiAgY29uc3QgZGlyID0gd3JpdGVEZWZZYW1sKGBcbnZlcnNpb246IDFcbm5hbWU6IFwiY3R4LXRlc3RcIlxuc3RlcHM6XG4gIC0gaWQ6IGZpcnN0XG4gICAgbmFtZTogXCJGaXJzdFwiXG4gICAgcHJvbXB0OiBcImRvIGZpcnN0XCJcbiAgLSBpZDogc2Vjb25kXG4gICAgbmFtZTogXCJTZWNvbmRcIlxuICAgIHByb21wdDogXCJkbyBzZWNvbmRcIlxuICAgIGNvbnRleHRfZnJvbTogW2ZpcnN0XVxuYCk7XG4gIHQuYWZ0ZXIoKCkgPT4geyB0cnkgeyBybVN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUsIG1heFJldHJpZXM6IDMsIHJldHJ5RGVsYXk6IDEwMCB9KTsgfSBjYXRjaCB7IC8qIFdpbmRvd3MgRVBFUk0gKi8gfSB9KTtcblxuICBjb25zdCBkZWYgPSBsb2FkRGVmaW5pdGlvbihkaXIsIFwidGVzdC13b3JrZmxvd1wiKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChkZWYuc3RlcHNbMV0uY29udGV4dEZyb20sIFtcImZpcnN0XCJdKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgdmFsaWRhdGVEZWZpbml0aW9uOiBpdGVyYXRlIGZpZWxkIHZhbGlkYXRpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJ2YWxpZGF0ZURlZmluaXRpb246IHZhbGlkIGl0ZXJhdGUgY29uZmlnIGFjY2VwdGVkXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gdmFsaWRhdGVEZWZpbml0aW9uKHtcbiAgICB2ZXJzaW9uOiAxLFxuICAgIG5hbWU6IFwidGVzdFwiLFxuICAgIHN0ZXBzOiBbe1xuICAgICAgaWQ6IFwiYVwiLFxuICAgICAgbmFtZTogXCJBXCIsXG4gICAgICBwcm9tcHQ6IFwiZG8gQVwiLFxuICAgICAgaXRlcmF0ZTogeyBzb3VyY2U6IFwib3V0bGluZS5tZFwiLCBwYXR0ZXJuOiBcIl4jIyAoLispXCIgfSxcbiAgICB9XSxcbiAgfSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQudmFsaWQsIHRydWUpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LmVycm9ycy5sZW5ndGgsIDApO1xufSk7XG5cbnRlc3QoXCJ2YWxpZGF0ZURlZmluaXRpb246IGl0ZXJhdGUgbWlzc2luZyBzb3VyY2UgXHUyMTkyIGVycm9yXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gdmFsaWRhdGVEZWZpbml0aW9uKHtcbiAgICB2ZXJzaW9uOiAxLFxuICAgIG5hbWU6IFwidGVzdFwiLFxuICAgIHN0ZXBzOiBbe1xuICAgICAgaWQ6IFwiYVwiLFxuICAgICAgbmFtZTogXCJBXCIsXG4gICAgICBwcm9tcHQ6IFwiZG8gQVwiLFxuICAgICAgaXRlcmF0ZTogeyBwYXR0ZXJuOiBcIl4jIyAoLispXCIgfSxcbiAgICB9XSxcbiAgfSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQudmFsaWQsIGZhbHNlKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdC5lcnJvcnMuc29tZSgoZSkgPT4gZS5pbmNsdWRlcyhcInNvdXJjZVwiKSkpO1xufSk7XG5cbnRlc3QoXCJ2YWxpZGF0ZURlZmluaXRpb246IGl0ZXJhdGUgc291cmNlIHdpdGggLi4gXHUyMTkyIGVycm9yXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gdmFsaWRhdGVEZWZpbml0aW9uKHtcbiAgICB2ZXJzaW9uOiAxLFxuICAgIG5hbWU6IFwidGVzdFwiLFxuICAgIHN0ZXBzOiBbe1xuICAgICAgaWQ6IFwiYVwiLFxuICAgICAgbmFtZTogXCJBXCIsXG4gICAgICBwcm9tcHQ6IFwiZG8gQVwiLFxuICAgICAgaXRlcmF0ZTogeyBzb3VyY2U6IFwiLi4vZXNjYXBlLm1kXCIsIHBhdHRlcm46IFwiKC4rKVwiIH0sXG4gICAgfV0sXG4gIH0pO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnZhbGlkLCBmYWxzZSk7XG4gIGFzc2VydC5vayhyZXN1bHQuZXJyb3JzLnNvbWUoKGUpID0+IGUuaW5jbHVkZXMoXCJwYXRoIHRyYXZlcnNhbFwiKSB8fCBlLmluY2x1ZGVzKFwiLi5cIikpKTtcbn0pO1xuXG50ZXN0KFwidmFsaWRhdGVEZWZpbml0aW9uOiBpdGVyYXRlIGludmFsaWQgcmVnZXggXHUyMTkyIGVycm9yXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gdmFsaWRhdGVEZWZpbml0aW9uKHtcbiAgICB2ZXJzaW9uOiAxLFxuICAgIG5hbWU6IFwidGVzdFwiLFxuICAgIHN0ZXBzOiBbe1xuICAgICAgaWQ6IFwiYVwiLFxuICAgICAgbmFtZTogXCJBXCIsXG4gICAgICBwcm9tcHQ6IFwiZG8gQVwiLFxuICAgICAgaXRlcmF0ZTogeyBzb3VyY2U6IFwiZi5tZFwiLCBwYXR0ZXJuOiBcIltpbnZhbGlkXCIgfSxcbiAgICB9XSxcbiAgfSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQudmFsaWQsIGZhbHNlKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdC5lcnJvcnMuc29tZSgoZSkgPT4gZS5pbmNsdWRlcyhcInJlZ2V4XCIpKSk7XG59KTtcblxudGVzdChcInZhbGlkYXRlRGVmaW5pdGlvbjogaXRlcmF0ZSBwYXR0ZXJuIHdpdGhvdXQgY2FwdHVyZSBncm91cCBcdTIxOTIgZXJyb3JcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSB2YWxpZGF0ZURlZmluaXRpb24oe1xuICAgIHZlcnNpb246IDEsXG4gICAgbmFtZTogXCJ0ZXN0XCIsXG4gICAgc3RlcHM6IFt7XG4gICAgICBpZDogXCJhXCIsXG4gICAgICBuYW1lOiBcIkFcIixcbiAgICAgIHByb21wdDogXCJkbyBBXCIsXG4gICAgICBpdGVyYXRlOiB7IHNvdXJjZTogXCJmLm1kXCIsIHBhdHRlcm46IFwiXiMjIC4rXCIgfSxcbiAgICB9XSxcbiAgfSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQudmFsaWQsIGZhbHNlKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdC5lcnJvcnMuc29tZSgoZSkgPT4gZS5pbmNsdWRlcyhcImNhcHR1cmUgZ3JvdXBcIikpKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgdmFsaWRhdGVEZWZpbml0aW9uOiB2ZXJpZnkgZmllbGQgdmFsaWRhdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcInZhbGlkYXRlRGVmaW5pdGlvbjogdmFsaWQgY29udGVudC1oZXVyaXN0aWMgdmVyaWZ5IFx1MjE5MiBhY2NlcHRlZFwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IHZhbGlkYXRlRGVmaW5pdGlvbih7XG4gICAgdmVyc2lvbjogMSxcbiAgICBuYW1lOiBcInRlc3RcIixcbiAgICBzdGVwczogW3tcbiAgICAgIGlkOiBcImFcIixcbiAgICAgIG5hbWU6IFwiQVwiLFxuICAgICAgcHJvbXB0OiBcImRvIEFcIixcbiAgICAgIHZlcmlmeTogeyBwb2xpY3k6IFwiY29udGVudC1oZXVyaXN0aWNcIiwgbWluU2l6ZTogMTAwLCBwYXR0ZXJuOiBcIl4jIyBcIiB9LFxuICAgIH1dLFxuICB9KTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC52YWxpZCwgdHJ1ZSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQuZXJyb3JzLmxlbmd0aCwgMCk7XG59KTtcblxudGVzdChcInZhbGlkYXRlRGVmaW5pdGlvbjogdmFsaWQgc2hlbGwtY29tbWFuZCB2ZXJpZnkgXHUyMTkyIGFjY2VwdGVkXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gdmFsaWRhdGVEZWZpbml0aW9uKHtcbiAgICB2ZXJzaW9uOiAxLFxuICAgIG5hbWU6IFwidGVzdFwiLFxuICAgIHN0ZXBzOiBbe1xuICAgICAgaWQ6IFwiYVwiLFxuICAgICAgbmFtZTogXCJBXCIsXG4gICAgICBwcm9tcHQ6IFwiZG8gQVwiLFxuICAgICAgdmVyaWZ5OiB7IHBvbGljeTogXCJzaGVsbC1jb21tYW5kXCIsIGNvbW1hbmQ6IFwiY2F0IG91dHB1dC5tZCB8IGdyZXAgJ14jIyAnXCIgfSxcbiAgICB9XSxcbiAgfSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQudmFsaWQsIHRydWUpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LmVycm9ycy5sZW5ndGgsIDApO1xufSk7XG5cbnRlc3QoXCJ2YWxpZGF0ZURlZmluaXRpb246IHZhbGlkIHByb21wdC12ZXJpZnkgXHUyMTkyIGFjY2VwdGVkXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gdmFsaWRhdGVEZWZpbml0aW9uKHtcbiAgICB2ZXJzaW9uOiAxLFxuICAgIG5hbWU6IFwidGVzdFwiLFxuICAgIHN0ZXBzOiBbe1xuICAgICAgaWQ6IFwiYVwiLFxuICAgICAgbmFtZTogXCJBXCIsXG4gICAgICBwcm9tcHQ6IFwiZG8gQVwiLFxuICAgICAgdmVyaWZ5OiB7IHBvbGljeTogXCJwcm9tcHQtdmVyaWZ5XCIsIHByb21wdDogXCJEb2VzIHRoZSBvdXRwdXQgY29udGFpbiBhdCBsZWFzdCAzIHNlY3Rpb25zP1wiIH0sXG4gICAgfV0sXG4gIH0pO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnZhbGlkLCB0cnVlKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5lcnJvcnMubGVuZ3RoLCAwKTtcbn0pO1xuXG50ZXN0KFwidmFsaWRhdGVEZWZpbml0aW9uOiB2YWxpZCBodW1hbi1yZXZpZXcgdmVyaWZ5IFx1MjE5MiBhY2NlcHRlZFwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IHZhbGlkYXRlRGVmaW5pdGlvbih7XG4gICAgdmVyc2lvbjogMSxcbiAgICBuYW1lOiBcInRlc3RcIixcbiAgICBzdGVwczogW3tcbiAgICAgIGlkOiBcImFcIixcbiAgICAgIG5hbWU6IFwiQVwiLFxuICAgICAgcHJvbXB0OiBcImRvIEFcIixcbiAgICAgIHZlcmlmeTogeyBwb2xpY3k6IFwiaHVtYW4tcmV2aWV3XCIgfSxcbiAgICB9XSxcbiAgfSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQudmFsaWQsIHRydWUpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LmVycm9ycy5sZW5ndGgsIDApO1xufSk7XG5cbnRlc3QoXCJ2YWxpZGF0ZURlZmluaXRpb246IGludmFsaWQgdmVyaWZ5IHBvbGljeSBuYW1lIFx1MjE5MiByZWplY3RlZFwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IHZhbGlkYXRlRGVmaW5pdGlvbih7XG4gICAgdmVyc2lvbjogMSxcbiAgICBuYW1lOiBcInRlc3RcIixcbiAgICBzdGVwczogW3tcbiAgICAgIGlkOiBcImFcIixcbiAgICAgIG5hbWU6IFwiQVwiLFxuICAgICAgcHJvbXB0OiBcImRvIEFcIixcbiAgICAgIHZlcmlmeTogeyBwb2xpY3k6IFwibWFnaWMtY2hlY2tcIiB9LFxuICAgIH1dLFxuICB9KTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC52YWxpZCwgZmFsc2UpO1xuICBhc3NlcnQub2socmVzdWx0LmVycm9ycy5zb21lKChlKSA9PiBlLmluY2x1ZGVzKFwidmVyaWZ5LnBvbGljeSBtdXN0IGJlIG9uZSBvZlwiKSkpO1xufSk7XG5cbnRlc3QoXCJ2YWxpZGF0ZURlZmluaXRpb246IHNoZWxsLWNvbW1hbmQgbWlzc2luZyBjb21tYW5kIFx1MjE5MiByZWplY3RlZFwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IHZhbGlkYXRlRGVmaW5pdGlvbih7XG4gICAgdmVyc2lvbjogMSxcbiAgICBuYW1lOiBcInRlc3RcIixcbiAgICBzdGVwczogW3tcbiAgICAgIGlkOiBcImFcIixcbiAgICAgIG5hbWU6IFwiQVwiLFxuICAgICAgcHJvbXB0OiBcImRvIEFcIixcbiAgICAgIHZlcmlmeTogeyBwb2xpY3k6IFwic2hlbGwtY29tbWFuZFwiIH0sXG4gICAgfV0sXG4gIH0pO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnZhbGlkLCBmYWxzZSk7XG4gIGFzc2VydC5vayhyZXN1bHQuZXJyb3JzLnNvbWUoKGUpID0+IGUuaW5jbHVkZXMoJ3JlcXVpcmVzIGEgbm9uLWVtcHR5IFwiY29tbWFuZFwiJykpKTtcbn0pO1xuXG50ZXN0KFwidmFsaWRhdGVEZWZpbml0aW9uOiBwcm9tcHQtdmVyaWZ5IG1pc3NpbmcgcHJvbXB0IFx1MjE5MiByZWplY3RlZFwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IHZhbGlkYXRlRGVmaW5pdGlvbih7XG4gICAgdmVyc2lvbjogMSxcbiAgICBuYW1lOiBcInRlc3RcIixcbiAgICBzdGVwczogW3tcbiAgICAgIGlkOiBcImFcIixcbiAgICAgIG5hbWU6IFwiQVwiLFxuICAgICAgcHJvbXB0OiBcImRvIEFcIixcbiAgICAgIHZlcmlmeTogeyBwb2xpY3k6IFwicHJvbXB0LXZlcmlmeVwiIH0sXG4gICAgfV0sXG4gIH0pO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnZhbGlkLCBmYWxzZSk7XG4gIGFzc2VydC5vayhyZXN1bHQuZXJyb3JzLnNvbWUoKGUpID0+IGUuaW5jbHVkZXMoJ3JlcXVpcmVzIGEgbm9uLWVtcHR5IFwicHJvbXB0XCInKSkpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBHYXAgdmFsaWRhdGlvbnM6IGR1cGxpY2F0ZSBJRHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJ2YWxpZGF0ZURlZmluaXRpb246IGR1cGxpY2F0ZSBzdGVwIElEcyBcdTIxOTIgZXJyb3JcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSB2YWxpZGF0ZURlZmluaXRpb24oe1xuICAgIHZlcnNpb246IDEsXG4gICAgbmFtZTogXCJ0ZXN0XCIsXG4gICAgc3RlcHM6IFtcbiAgICAgIHsgaWQ6IFwiZHVwXCIsIG5hbWU6IFwiQVwiLCBwcm9tcHQ6IFwiZG8gQVwiIH0sXG4gICAgICB7IGlkOiBcImR1cFwiLCBuYW1lOiBcIkJcIiwgcHJvbXB0OiBcImRvIEJcIiB9LFxuICAgIF0sXG4gIH0pO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnZhbGlkLCBmYWxzZSk7XG4gIGFzc2VydC5vayhyZXN1bHQuZXJyb3JzLnNvbWUoKGUpID0+IGUuaW5jbHVkZXMoXCJEdXBsaWNhdGUgc3RlcCBpZFwiKSkpO1xuICBhc3NlcnQub2socmVzdWx0LmVycm9ycy5zb21lKChlKSA9PiBlLmluY2x1ZGVzKFwiZHVwXCIpKSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEdhcCB2YWxpZGF0aW9uczogZGFuZ2xpbmcgZGVwZW5kZW5jaWVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwidmFsaWRhdGVEZWZpbml0aW9uOiBkYW5nbGluZyBkZXBlbmRlbmN5IFx1MjE5MiBlcnJvclwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IHZhbGlkYXRlRGVmaW5pdGlvbih7XG4gICAgdmVyc2lvbjogMSxcbiAgICBuYW1lOiBcInRlc3RcIixcbiAgICBzdGVwczogW1xuICAgICAgeyBpZDogXCJhXCIsIG5hbWU6IFwiQVwiLCBwcm9tcHQ6IFwiZG8gQVwiIH0sXG4gICAgICB7IGlkOiBcImJcIiwgbmFtZTogXCJCXCIsIHByb21wdDogXCJkbyBCXCIsIHJlcXVpcmVzOiBbXCJub25leGlzdGVudFwiXSB9LFxuICAgIF0sXG4gIH0pO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnZhbGlkLCBmYWxzZSk7XG4gIGFzc2VydC5vayhyZXN1bHQuZXJyb3JzLnNvbWUoKGUpID0+IGUuaW5jbHVkZXMoXCJyZXF1aXJlcyB1bmtub3duIHN0ZXBcIikpKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdC5lcnJvcnMuc29tZSgoZSkgPT4gZS5pbmNsdWRlcyhcIm5vbmV4aXN0ZW50XCIpKSk7XG59KTtcblxudGVzdChcInZhbGlkYXRlRGVmaW5pdGlvbjogZGFuZ2xpbmcgZGVwZW5kZW5jeSB2aWEgZGVwZW5kc19vbiBcdTIxOTIgZXJyb3JcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSB2YWxpZGF0ZURlZmluaXRpb24oe1xuICAgIHZlcnNpb246IDEsXG4gICAgbmFtZTogXCJ0ZXN0XCIsXG4gICAgc3RlcHM6IFtcbiAgICAgIHsgaWQ6IFwiYVwiLCBuYW1lOiBcIkFcIiwgcHJvbXB0OiBcImRvIEFcIiB9LFxuICAgICAgeyBpZDogXCJiXCIsIG5hbWU6IFwiQlwiLCBwcm9tcHQ6IFwiZG8gQlwiLCBkZXBlbmRzX29uOiBbXCJnaG9zdFwiXSB9LFxuICAgIF0sXG4gIH0pO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnZhbGlkLCBmYWxzZSk7XG4gIGFzc2VydC5vayhyZXN1bHQuZXJyb3JzLnNvbWUoKGUpID0+IGUuaW5jbHVkZXMoXCJyZXF1aXJlcyB1bmtub3duIHN0ZXBcIikpKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdC5lcnJvcnMuc29tZSgoZSkgPT4gZS5pbmNsdWRlcyhcImdob3N0XCIpKSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEdhcCB2YWxpZGF0aW9uczogc2VsZi1yZWZlcmVuY2luZyBkZXBlbmRlbmNpZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJ2YWxpZGF0ZURlZmluaXRpb246IHNlbGYtcmVmZXJlbmNpbmcgZGVwZW5kZW5jeSBcdTIxOTIgZXJyb3JcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSB2YWxpZGF0ZURlZmluaXRpb24oe1xuICAgIHZlcnNpb246IDEsXG4gICAgbmFtZTogXCJ0ZXN0XCIsXG4gICAgc3RlcHM6IFtcbiAgICAgIHsgaWQ6IFwiYVwiLCBuYW1lOiBcIkFcIiwgcHJvbXB0OiBcImRvIEFcIiwgcmVxdWlyZXM6IFtcImFcIl0gfSxcbiAgICBdLFxuICB9KTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC52YWxpZCwgZmFsc2UpO1xuICBhc3NlcnQub2socmVzdWx0LmVycm9ycy5zb21lKChlKSA9PiBlLmluY2x1ZGVzKFwiZGVwZW5kcyBvbiBpdHNlbGZcIikpKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgR2FwIHZhbGlkYXRpb25zOiBjeWNsZSBkZXRlY3Rpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJ2YWxpZGF0ZURlZmluaXRpb246IHNpbXBsZSBjeWNsZSAoQVx1MjE5MkJcdTIxOTJBKSBcdTIxOTIgZXJyb3JcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSB2YWxpZGF0ZURlZmluaXRpb24oe1xuICAgIHZlcnNpb246IDEsXG4gICAgbmFtZTogXCJ0ZXN0XCIsXG4gICAgc3RlcHM6IFtcbiAgICAgIHsgaWQ6IFwiYVwiLCBuYW1lOiBcIkFcIiwgcHJvbXB0OiBcImRvIEFcIiwgcmVxdWlyZXM6IFtcImJcIl0gfSxcbiAgICAgIHsgaWQ6IFwiYlwiLCBuYW1lOiBcIkJcIiwgcHJvbXB0OiBcImRvIEJcIiwgcmVxdWlyZXM6IFtcImFcIl0gfSxcbiAgICBdLFxuICB9KTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC52YWxpZCwgZmFsc2UpO1xuICBhc3NlcnQub2socmVzdWx0LmVycm9ycy5zb21lKChlKSA9PiBlLmluY2x1ZGVzKFwiQ3ljbGUgZGV0ZWN0ZWRcIikpKTtcbn0pO1xuXG50ZXN0KFwidmFsaWRhdGVEZWZpbml0aW9uOiBjb21wbGV4IGN5Y2xlIChBXHUyMTkyQlx1MjE5MkNcdTIxOTJBKSBcdTIxOTIgZXJyb3JcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSB2YWxpZGF0ZURlZmluaXRpb24oe1xuICAgIHZlcnNpb246IDEsXG4gICAgbmFtZTogXCJ0ZXN0XCIsXG4gICAgc3RlcHM6IFtcbiAgICAgIHsgaWQ6IFwiYVwiLCBuYW1lOiBcIkFcIiwgcHJvbXB0OiBcImRvIEFcIiwgcmVxdWlyZXM6IFtcImNcIl0gfSxcbiAgICAgIHsgaWQ6IFwiYlwiLCBuYW1lOiBcIkJcIiwgcHJvbXB0OiBcImRvIEJcIiwgcmVxdWlyZXM6IFtcImFcIl0gfSxcbiAgICAgIHsgaWQ6IFwiY1wiLCBuYW1lOiBcIkNcIiwgcHJvbXB0OiBcImRvIENcIiwgcmVxdWlyZXM6IFtcImJcIl0gfSxcbiAgICBdLFxuICB9KTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC52YWxpZCwgZmFsc2UpO1xuICBhc3NlcnQub2socmVzdWx0LmVycm9ycy5zb21lKChlKSA9PiBlLmluY2x1ZGVzKFwiQ3ljbGUgZGV0ZWN0ZWRcIikpKTtcbn0pO1xuXG50ZXN0KFwidmFsaWRhdGVEZWZpbml0aW9uOiBkaWFtb25kIGRlcGVuZGVuY3kgKG5vIGN5Y2xlKSBcdTIxOTIgYWNjZXB0ZWRcIiwgKCkgPT4ge1xuICAvLyBBXHUyMTkyQiwgQVx1MjE5MkMsIEJcdTIxOTJELCBDXHUyMTkyRCBcdTIwMTQgY2xhc3NpYyBkaWFtb25kLCBubyBjeWNsZVxuICBjb25zdCByZXN1bHQgPSB2YWxpZGF0ZURlZmluaXRpb24oe1xuICAgIHZlcnNpb246IDEsXG4gICAgbmFtZTogXCJ0ZXN0XCIsXG4gICAgc3RlcHM6IFtcbiAgICAgIHsgaWQ6IFwiYVwiLCBuYW1lOiBcIkFcIiwgcHJvbXB0OiBcImRvIEFcIiB9LFxuICAgICAgeyBpZDogXCJiXCIsIG5hbWU6IFwiQlwiLCBwcm9tcHQ6IFwiZG8gQlwiLCByZXF1aXJlczogW1wiYVwiXSB9LFxuICAgICAgeyBpZDogXCJjXCIsIG5hbWU6IFwiQ1wiLCBwcm9tcHQ6IFwiZG8gQ1wiLCByZXF1aXJlczogW1wiYVwiXSB9LFxuICAgICAgeyBpZDogXCJkXCIsIG5hbWU6IFwiRFwiLCBwcm9tcHQ6IFwiZG8gRFwiLCByZXF1aXJlczogW1wiYlwiLCBcImNcIl0gfSxcbiAgICBdLFxuICB9KTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC52YWxpZCwgdHJ1ZSwgYEV4cGVjdGVkIHZhbGlkIGJ1dCBnb3QgZXJyb3JzOiAke3Jlc3VsdC5lcnJvcnMuam9pbihcIjsgXCIpfWApO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LmVycm9ycy5sZW5ndGgsIDApO1xufSk7XG5cbnRlc3QoXCJ2YWxpZGF0ZURlZmluaXRpb246IGxpbmVhciBjaGFpbiAobm8gY3ljbGUpIFx1MjE5MiBhY2NlcHRlZFwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IHZhbGlkYXRlRGVmaW5pdGlvbih7XG4gICAgdmVyc2lvbjogMSxcbiAgICBuYW1lOiBcInRlc3RcIixcbiAgICBzdGVwczogW1xuICAgICAgeyBpZDogXCJhXCIsIG5hbWU6IFwiQVwiLCBwcm9tcHQ6IFwiZG8gQVwiIH0sXG4gICAgICB7IGlkOiBcImJcIiwgbmFtZTogXCJCXCIsIHByb21wdDogXCJkbyBCXCIsIHJlcXVpcmVzOiBbXCJhXCJdIH0sXG4gICAgICB7IGlkOiBcImNcIiwgbmFtZTogXCJDXCIsIHByb21wdDogXCJkbyBDXCIsIHJlcXVpcmVzOiBbXCJiXCJdIH0sXG4gICAgICB7IGlkOiBcImRcIiwgbmFtZTogXCJEXCIsIHByb21wdDogXCJkbyBEXCIsIHJlcXVpcmVzOiBbXCJjXCJdIH0sXG4gICAgXSxcbiAgfSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQudmFsaWQsIHRydWUpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBzdWJzdGl0dXRlUGFyYW1zIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwic3Vic3RpdHV0ZVBhcmFtczogcmVwbGFjZXMgcGxhY2Vob2xkZXJzIHdpdGggZGVmYXVsdHNcIiwgKCkgPT4ge1xuICBjb25zdCBkZWY6IFdvcmtmbG93RGVmaW5pdGlvbiA9IHtcbiAgICB2ZXJzaW9uOiAxLFxuICAgIG5hbWU6IFwidGVzdFwiLFxuICAgIHBhcmFtczogeyB0b3BpYzogXCJBSVwiLCBmb3JtYXQ6IFwibWFya2Rvd25cIiB9LFxuICAgIHN0ZXBzOiBbXG4gICAgICB7IGlkOiBcImFcIiwgbmFtZTogXCJBXCIsIHByb21wdDogXCJXcml0ZSBhYm91dCB7e3RvcGljfX0gaW4ge3tmb3JtYXR9fVwiLCByZXF1aXJlczogW10sIHByb2R1Y2VzOiBbXSB9LFxuICAgIF0sXG4gIH07XG4gIGNvbnN0IHJlc3VsdCA9IHN1YnN0aXR1dGVQYXJhbXMoZGVmKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zdGVwc1swXS5wcm9tcHQsIFwiV3JpdGUgYWJvdXQgQUkgaW4gbWFya2Rvd25cIik7XG59KTtcblxudGVzdChcInN1YnN0aXR1dGVQYXJhbXM6IG92ZXJyaWRlcyB3aW4gb3ZlciBkZWZhdWx0c1wiLCAoKSA9PiB7XG4gIGNvbnN0IGRlZjogV29ya2Zsb3dEZWZpbml0aW9uID0ge1xuICAgIHZlcnNpb246IDEsXG4gICAgbmFtZTogXCJ0ZXN0XCIsXG4gICAgcGFyYW1zOiB7IHRvcGljOiBcIkFJXCIgfSxcbiAgICBzdGVwczogW1xuICAgICAgeyBpZDogXCJhXCIsIG5hbWU6IFwiQVwiLCBwcm9tcHQ6IFwiV3JpdGUgYWJvdXQge3t0b3BpY319XCIsIHJlcXVpcmVzOiBbXSwgcHJvZHVjZXM6IFtdIH0sXG4gICAgXSxcbiAgfTtcbiAgY29uc3QgcmVzdWx0ID0gc3Vic3RpdHV0ZVBhcmFtcyhkZWYsIHsgdG9waWM6IFwiUm9ib3RpY3NcIiB9KTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zdGVwc1swXS5wcm9tcHQsIFwiV3JpdGUgYWJvdXQgUm9ib3RpY3NcIik7XG59KTtcblxudGVzdChcInN1YnN0aXR1dGVQYXJhbXM6IHJlamVjdHMgdmFsdWVzIGNvbnRhaW5pbmcgJy4uJ1wiLCAoKSA9PiB7XG4gIGNvbnN0IGRlZjogV29ya2Zsb3dEZWZpbml0aW9uID0ge1xuICAgIHZlcnNpb246IDEsXG4gICAgbmFtZTogXCJ0ZXN0XCIsXG4gICAgcGFyYW1zOiB7IHBhdGg6IFwic2FmZVwiIH0sXG4gICAgc3RlcHM6IFtcbiAgICAgIHsgaWQ6IFwiYVwiLCBuYW1lOiBcIkFcIiwgcHJvbXB0OiBcIlJlYWQge3twYXRofX1cIiwgcmVxdWlyZXM6IFtdLCBwcm9kdWNlczogW10gfSxcbiAgICBdLFxuICB9O1xuICBhc3NlcnQudGhyb3dzKFxuICAgICgpID0+IHN1YnN0aXR1dGVQYXJhbXMoZGVmLCB7IHBhdGg6IFwiLi4vZXRjL3Bhc3N3ZFwiIH0pLFxuICAgIChlcnI6IEVycm9yKSA9PiB7XG4gICAgICBhc3NlcnQub2soZXJyLm1lc3NhZ2UuaW5jbHVkZXMoXCIuLlwiKSk7XG4gICAgICBhc3NlcnQub2soZXJyLm1lc3NhZ2UuaW5jbHVkZXMoXCJwYXRoIHRyYXZlcnNhbFwiKSk7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9LFxuICApO1xufSk7XG5cbnRlc3QoXCJzdWJzdGl0dXRlUGFyYW1zOiBlcnJvcnMgb24gdW5yZXNvbHZlZCBwbGFjZWhvbGRlcnNcIiwgKCkgPT4ge1xuICBjb25zdCBkZWY6IFdvcmtmbG93RGVmaW5pdGlvbiA9IHtcbiAgICB2ZXJzaW9uOiAxLFxuICAgIG5hbWU6IFwidGVzdFwiLFxuICAgIHN0ZXBzOiBbXG4gICAgICB7IGlkOiBcImFcIiwgbmFtZTogXCJBXCIsIHByb21wdDogXCJXcml0ZSBhYm91dCB7e3RvcGljfX1cIiwgcmVxdWlyZXM6IFtdLCBwcm9kdWNlczogW10gfSxcbiAgICBdLFxuICB9O1xuICBhc3NlcnQudGhyb3dzKFxuICAgICgpID0+IHN1YnN0aXR1dGVQYXJhbXMoZGVmKSxcbiAgICAoZXJyOiBFcnJvcikgPT4ge1xuICAgICAgYXNzZXJ0Lm9rKGVyci5tZXNzYWdlLmluY2x1ZGVzKFwiVW5yZXNvbHZlZFwiKSk7XG4gICAgICBhc3NlcnQub2soZXJyLm1lc3NhZ2UuaW5jbHVkZXMoXCJ0b3BpY1wiKSk7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9LFxuICApO1xufSk7XG5cbnRlc3QoXCJzdWJzdGl0dXRlUGFyYW1zOiBkb2VzIG5vdCBtdXRhdGUgdGhlIG9yaWdpbmFsIGRlZmluaXRpb25cIiwgKCkgPT4ge1xuICBjb25zdCBkZWY6IFdvcmtmbG93RGVmaW5pdGlvbiA9IHtcbiAgICB2ZXJzaW9uOiAxLFxuICAgIG5hbWU6IFwidGVzdFwiLFxuICAgIHBhcmFtczogeyB0b3BpYzogXCJBSVwiIH0sXG4gICAgc3RlcHM6IFtcbiAgICAgIHsgaWQ6IFwiYVwiLCBuYW1lOiBcIkFcIiwgcHJvbXB0OiBcIldyaXRlIGFib3V0IHt7dG9waWN9fVwiLCByZXF1aXJlczogW10sIHByb2R1Y2VzOiBbXSB9LFxuICAgIF0sXG4gIH07XG4gIGNvbnN0IG9yaWdpbmFsID0gZGVmLnN0ZXBzWzBdLnByb21wdDtcbiAgc3Vic3RpdHV0ZVBhcmFtcyhkZWYpO1xuICBhc3NlcnQuZXF1YWwoZGVmLnN0ZXBzWzBdLnByb21wdCwgb3JpZ2luYWwsIFwiT3JpZ2luYWwgZGVmaW5pdGlvbiBzaG91bGQgbm90IGJlIG11dGF0ZWRcIik7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHN1YnN0aXR1dGVQcm9tcHRTdHJpbmcgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJzdWJzdGl0dXRlUHJvbXB0U3RyaW5nOiByZXBsYWNlcyBrbm93biBwbGFjZWhvbGRlcnMsIGxlYXZlcyB1bmtub3duXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gc3Vic3RpdHV0ZVByb21wdFN0cmluZyhcbiAgICBcIkhlbGxvIHt7bmFtZX19LCB3cml0ZSBhYm91dCB7e3RvcGljfX1cIixcbiAgICB7IG5hbWU6IFwiQWdlbnRcIiB9LFxuICApO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LCBcIkhlbGxvIEFnZW50LCB3cml0ZSBhYm91dCB7e3RvcGljfX1cIik7XG59KTtcblxudGVzdChcInN1YnN0aXR1dGVQcm9tcHRTdHJpbmc6IG5vIHBsYWNlaG9sZGVycyBcdTIxOTIgdW5jaGFuZ2VkXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gc3Vic3RpdHV0ZVByb21wdFN0cmluZyhcIk5vIHBsYWNlaG9sZGVycyBoZXJlXCIsIHt9KTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgXCJObyBwbGFjZWhvbGRlcnMgaGVyZVwiKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRWRnZSBjYXNlcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcInZhbGlkYXRlRGVmaW5pdGlvbjogc3RlcHMgaXMgbm90IGFuIGFycmF5IFx1MjE5MiBlcnJvclwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IHZhbGlkYXRlRGVmaW5pdGlvbih7XG4gICAgdmVyc2lvbjogMSxcbiAgICBuYW1lOiBcInRlc3RcIixcbiAgICBzdGVwczogXCJub3QtYW4tYXJyYXlcIixcbiAgfSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQudmFsaWQsIGZhbHNlKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdC5lcnJvcnMuc29tZSgoZSkgPT4gZS5pbmNsdWRlcyhcInN0ZXBzXCIpICYmIGUuaW5jbHVkZXMoXCJhcnJheVwiKSkpO1xufSk7XG5cbnRlc3QoXCJ2YWxpZGF0ZURlZmluaXRpb246IHZhbGlkIG1pbmltYWwgc3RlcCAobm8gcmVxdWlyZXMvcHJvZHVjZXMpIFx1MjE5MiBhY2NlcHRlZFwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IHZhbGlkYXRlRGVmaW5pdGlvbih7XG4gICAgdmVyc2lvbjogMSxcbiAgICBuYW1lOiBcInRlc3RcIixcbiAgICBzdGVwczogW3sgaWQ6IFwiYVwiLCBuYW1lOiBcIkFcIiwgcHJvbXB0OiBcImRvIEFcIiB9XSxcbiAgfSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQudmFsaWQsIHRydWUpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LmVycm9ycy5sZW5ndGgsIDApO1xufSk7XG5cbnRlc3QoXCJsb2FkRGVmaW5pdGlvbjogbG9hZHMgd2l0aG91dCBwYXJhbXMgZmllbGQgXHUyMTkyIHBhcmFtcyBpcyB1bmRlZmluZWRcIiwgKHQpID0+IHtcbiAgY29uc3QgZGlyID0gd3JpdGVEZWZZYW1sKGBcbnZlcnNpb246IDFcbm5hbWU6IFwibm8tcGFyYW1zXCJcbnN0ZXBzOlxuICAtIGlkOiBhXG4gICAgbmFtZTogXCJBXCJcbiAgICBwcm9tcHQ6IFwiZG8gQVwiXG5gKTtcbiAgdC5hZnRlcigoKSA9PiB7IHRyeSB7IHJtU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSwgbWF4UmV0cmllczogMywgcmV0cnlEZWxheTogMTAwIH0pOyB9IGNhdGNoIHsgLyogV2luZG93cyBFUEVSTSAqLyB9IH0pO1xuXG4gIGNvbnN0IGRlZiA9IGxvYWREZWZpbml0aW9uKGRpciwgXCJ0ZXN0LXdvcmtmbG93XCIpO1xuICBhc3NlcnQuZXF1YWwoZGVmLnBhcmFtcywgdW5kZWZpbmVkKTtcbn0pO1xuXG50ZXN0KFwibG9hZERlZmluaXRpb246IGxvYWRzIHdpdGhvdXQgZGVzY3JpcHRpb24gXHUyMTkyIGRlc2NyaXB0aW9uIGlzIHVuZGVmaW5lZFwiLCAodCkgPT4ge1xuICBjb25zdCBkaXIgPSB3cml0ZURlZllhbWwoYFxudmVyc2lvbjogMVxubmFtZTogXCJuby1kZXNjXCJcbnN0ZXBzOlxuICAtIGlkOiBhXG4gICAgbmFtZTogXCJBXCJcbiAgICBwcm9tcHQ6IFwiZG8gQVwiXG5gKTtcbiAgdC5hZnRlcigoKSA9PiB7IHRyeSB7IHJtU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSwgbWF4UmV0cmllczogMywgcmV0cnlEZWxheTogMTAwIH0pOyB9IGNhdGNoIHsgLyogV2luZG93cyBFUEVSTSAqLyB9IH0pO1xuXG4gIGNvbnN0IGRlZiA9IGxvYWREZWZpbml0aW9uKGRpciwgXCJ0ZXN0LXdvcmtmbG93XCIpO1xuICBhc3NlcnQuZXF1YWwoZGVmLmRlc2NyaXB0aW9uLCB1bmRlZmluZWQpO1xufSk7XG5cbnRlc3QoXCJsb2FkRGVmaW5pdGlvbjogc3RlcCB3aXRoIG5vIHJlcXVpcmVzL3Byb2R1Y2VzIGRlZmF1bHRzIHRvIGVtcHR5IGFycmF5c1wiLCAodCkgPT4ge1xuICBjb25zdCBkaXIgPSB3cml0ZURlZllhbWwoYFxudmVyc2lvbjogMVxubmFtZTogXCJkZWZhdWx0c1wiXG5zdGVwczpcbiAgLSBpZDogYVxuICAgIG5hbWU6IFwiQVwiXG4gICAgcHJvbXB0OiBcImRvIEFcIlxuYCk7XG4gIHQuYWZ0ZXIoKCkgPT4geyB0cnkgeyBybVN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUsIG1heFJldHJpZXM6IDMsIHJldHJ5RGVsYXk6IDEwMCB9KTsgfSBjYXRjaCB7IC8qIFdpbmRvd3MgRVBFUk0gKi8gfSB9KTtcblxuICBjb25zdCBkZWYgPSBsb2FkRGVmaW5pdGlvbihkaXIsIFwidGVzdC13b3JrZmxvd1wiKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChkZWYuc3RlcHNbMF0ucmVxdWlyZXMsIFtdKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChkZWYuc3RlcHNbMF0ucHJvZHVjZXMsIFtdKTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBU0EsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUNuQixTQUFTLGFBQWEsUUFBUSxxQkFBcUI7QUFDbkQsU0FBUyxZQUFZ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
