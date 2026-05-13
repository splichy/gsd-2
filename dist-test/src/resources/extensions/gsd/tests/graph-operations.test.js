import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readGraph,
  writeGraph,
  getNextPendingStep,
  markStepComplete,
  expandIteration,
  initializeGraph
} from "../graph.js";
function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), "graph-test-"));
}
function cleanupDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
  }
}
function makeGraph(steps, name = "test-workflow") {
  return {
    steps,
    metadata: { name, createdAt: "2026-01-01T00:00:00.000Z" }
  };
}
function makeStep(overrides) {
  return {
    title: overrides.id,
    status: "pending",
    prompt: `Do ${overrides.id}`,
    dependsOn: [],
    ...overrides
  };
}
describe("writeGraph + readGraph round-trip", () => {
  it("preserves all fields including parentStepId and dependsOn", (t) => {
    const dir = makeTmpDir();
    try {
      const graph = makeGraph([
        makeStep({ id: "step-1", title: "First Step", dependsOn: [] }),
        makeStep({
          id: "step-2",
          title: "Second Step",
          dependsOn: ["step-1"],
          parentStepId: "parent-iter"
        })
      ]);
      writeGraph(dir, graph);
      const loaded = readGraph(dir);
      assert.equal(loaded.steps.length, 2);
      assert.equal(loaded.steps[0].id, "step-1");
      assert.equal(loaded.steps[0].title, "First Step");
      assert.equal(loaded.steps[0].status, "pending");
      assert.deepStrictEqual(loaded.steps[0].dependsOn, []);
      assert.equal(loaded.steps[1].id, "step-2");
      assert.deepStrictEqual(loaded.steps[1].dependsOn, ["step-1"]);
      assert.equal(loaded.steps[1].parentStepId, "parent-iter");
      assert.equal(loaded.metadata.name, "test-workflow");
      assert.equal(loaded.metadata.createdAt, "2026-01-01T00:00:00.000Z");
    } finally {
      cleanupDir(dir);
    }
  });
  it("preserves startedAt and finishedAt fields", (t) => {
    const dir = makeTmpDir();
    try {
      const graph = makeGraph([
        makeStep({
          id: "s1",
          status: "complete",
          startedAt: "2026-01-01T01:00:00.000Z",
          finishedAt: "2026-01-01T01:05:00.000Z"
        })
      ]);
      writeGraph(dir, graph);
      const loaded = readGraph(dir);
      assert.equal(loaded.steps[0].startedAt, "2026-01-01T01:00:00.000Z");
      assert.equal(loaded.steps[0].finishedAt, "2026-01-01T01:05:00.000Z");
    } finally {
      cleanupDir(dir);
    }
  });
  it("creates directory if it does not exist", (t) => {
    const base = makeTmpDir();
    const nested = join(base, "sub", "dir");
    try {
      const graph = makeGraph([makeStep({ id: "s1" })]);
      writeGraph(nested, graph);
      assert.ok(existsSync(join(nested, "GRAPH.yaml")));
      const loaded = readGraph(nested);
      assert.equal(loaded.steps[0].id, "s1");
    } finally {
      cleanupDir(base);
    }
  });
});
describe("readGraph error paths", () => {
  it("throws with descriptive error when file is missing", (t) => {
    const dir = makeTmpDir();
    t.after(() => {
      cleanupDir(dir);
    });
    assert.throws(
      () => readGraph(dir),
      (err) => {
        assert.ok(err.message.includes("GRAPH.yaml not found"));
        assert.ok(err.message.includes(dir));
        return true;
      }
    );
  });
  it("throws with descriptive error when YAML is malformed (missing steps)", (t) => {
    const dir = makeTmpDir();
    t.after(() => {
      cleanupDir(dir);
    });
    writeFileSync(join(dir, "GRAPH.yaml"), "metadata:\n  name: bad\n", "utf-8");
    assert.throws(
      () => readGraph(dir),
      (err) => {
        assert.ok(err.message.includes("missing or invalid 'steps' array"));
        return true;
      }
    );
  });
  it("throws when steps is not an array", (t) => {
    const dir = makeTmpDir();
    t.after(() => {
      cleanupDir(dir);
    });
    writeFileSync(join(dir, "GRAPH.yaml"), "steps: not-an-array\nmetadata:\n  name: bad\n", "utf-8");
    assert.throws(
      () => readGraph(dir),
      (err) => {
        assert.ok(err.message.includes("missing or invalid 'steps' array"));
        return true;
      }
    );
  });
});
describe("getNextPendingStep", () => {
  it("returns first step with all deps complete", (t) => {
    const graph = makeGraph([
      makeStep({ id: "a", status: "complete" }),
      makeStep({ id: "b", dependsOn: ["a"] }),
      makeStep({ id: "c", dependsOn: ["b"] })
    ]);
    const next = getNextPendingStep(graph);
    assert.equal(next?.id, "b");
  });
  it("skips steps with incomplete deps", (t) => {
    const graph = makeGraph([
      makeStep({ id: "a" }),
      makeStep({ id: "b", dependsOn: ["a"] })
    ]);
    const next = getNextPendingStep(graph);
    assert.equal(next?.id, "a");
  });
  it("returns null when all steps are complete", (t) => {
    const graph = makeGraph([
      makeStep({ id: "a", status: "complete" }),
      makeStep({ id: "b", status: "complete" })
    ]);
    assert.equal(getNextPendingStep(graph), null);
  });
  it("returns null when all pending steps are blocked", (t) => {
    const graph = makeGraph([
      makeStep({ id: "a", status: "active" }),
      // not complete
      makeStep({ id: "b", dependsOn: ["a"] })
      // blocked
    ]);
    assert.equal(getNextPendingStep(graph), null);
  });
  it("returns first pending step with no deps when root steps exist", (t) => {
    const graph = makeGraph([
      makeStep({ id: "a" }),
      makeStep({ id: "b" })
    ]);
    const next = getNextPendingStep(graph);
    assert.equal(next?.id, "a");
  });
  it("skips expanded steps", (t) => {
    const graph = makeGraph([
      makeStep({ id: "a", status: "expanded" }),
      makeStep({ id: "b" })
    ]);
    const next = getNextPendingStep(graph);
    assert.equal(next?.id, "b");
  });
  it("treats expanded dependencies as satisfied", (t) => {
    const graph = makeGraph([
      makeStep({ id: "iter", status: "expanded" }),
      makeStep({ id: "after", dependsOn: ["iter"] })
    ]);
    const next = getNextPendingStep(graph);
    assert.equal(next?.id, "after");
  });
});
describe("markStepComplete", () => {
  it("returns new graph with step status 'complete' (original unchanged)", (t) => {
    const original = makeGraph([
      makeStep({ id: "a" }),
      makeStep({ id: "b" })
    ]);
    const updated = markStepComplete(original, "a");
    assert.equal(original.steps[0].status, "pending");
    assert.equal(updated.steps[0].status, "complete");
    assert.equal(updated.steps[0].id, "a");
    assert.equal(updated.steps[1].status, "pending");
  });
  it("sets finishedAt timestamp", (t) => {
    const graph = makeGraph([makeStep({ id: "a" })]);
    const updated = markStepComplete(graph, "a");
    assert.ok(updated.steps[0].finishedAt);
    assert.ok(!isNaN(Date.parse(updated.steps[0].finishedAt)));
  });
  it("throws for unknown step ID", (t) => {
    const graph = makeGraph([makeStep({ id: "a" })]);
    assert.throws(
      () => markStepComplete(graph, "nonexistent"),
      (err) => {
        assert.ok(err.message.includes("Step not found"));
        assert.ok(err.message.includes("nonexistent"));
        return true;
      }
    );
  });
  it("preserves metadata in returned graph", (t) => {
    const graph = makeGraph([makeStep({ id: "a" })], "my-workflow");
    const updated = markStepComplete(graph, "a");
    assert.equal(updated.metadata.name, "my-workflow");
    assert.equal(updated.metadata.createdAt, "2026-01-01T00:00:00.000Z");
  });
});
describe("expandIteration", () => {
  it("creates instance steps with correct IDs (stepId--001, stepId--002)", (t) => {
    const graph = makeGraph([
      makeStep({ id: "iter-step", title: "Process items" }),
      makeStep({ id: "final", dependsOn: ["iter-step"] })
    ]);
    const expanded = expandIteration(
      graph,
      "iter-step",
      ["apple", "banana", "cherry"],
      "Process {{item}}"
    );
    assert.equal(expanded.steps.length, 5);
    assert.equal(expanded.steps[1].id, "iter-step--001");
    assert.equal(expanded.steps[2].id, "iter-step--002");
    assert.equal(expanded.steps[3].id, "iter-step--003");
  });
  it("marks parent step as 'expanded'", (t) => {
    const graph = makeGraph([
      makeStep({ id: "iter", title: "Iterate" })
    ]);
    const expanded = expandIteration(graph, "iter", ["a"], "Do {{item}}");
    assert.equal(expanded.steps[0].status, "expanded");
  });
  it("instance steps have correct titles, prompts, parentStepId, and deps", (t) => {
    const graph = makeGraph([
      makeStep({ id: "pre", status: "complete" }),
      makeStep({ id: "iter", title: "Process", dependsOn: ["pre"] })
    ]);
    const expanded = expandIteration(
      graph,
      "iter",
      ["foo", "bar"],
      "Handle {{item}} carefully"
    );
    const inst1 = expanded.steps[2];
    assert.equal(inst1.title, "Process: foo");
    assert.equal(inst1.prompt, "Handle foo carefully");
    assert.equal(inst1.parentStepId, "iter");
    assert.deepStrictEqual(inst1.dependsOn, ["pre"]);
    assert.equal(inst1.status, "pending");
    const inst2 = expanded.steps[3];
    assert.equal(inst2.title, "Process: bar");
    assert.equal(inst2.prompt, "Handle bar carefully");
    assert.equal(inst2.parentStepId, "iter");
  });
  it("rewrites downstream deps from parent ID to all instance IDs", (t) => {
    const graph = makeGraph([
      makeStep({ id: "iter", title: "Iterate" }),
      makeStep({ id: "after", dependsOn: ["iter"] })
    ]);
    const expanded = expandIteration(
      graph,
      "iter",
      ["x", "y"],
      "Do {{item}}"
    );
    const afterStep = expanded.steps.find((s) => s.id === "after");
    assert.deepStrictEqual(afterStep.dependsOn, ["iter--001", "iter--002"]);
  });
  it("preserves steps that don't depend on the parent", (t) => {
    const graph = makeGraph([
      makeStep({ id: "unrelated" }),
      makeStep({ id: "iter", title: "Iterate" }),
      makeStep({ id: "after", dependsOn: ["iter"] })
    ]);
    const expanded = expandIteration(graph, "iter", ["a"], "{{item}}");
    const unrelated = expanded.steps.find((s) => s.id === "unrelated");
    assert.deepStrictEqual(unrelated.dependsOn, []);
  });
  it("throws for non-pending parent step", (t) => {
    const graph = makeGraph([
      makeStep({ id: "iter", status: "complete" })
    ]);
    assert.throws(
      () => expandIteration(graph, "iter", ["a"], "{{item}}"),
      (err) => {
        assert.ok(err.message.includes("complete"));
        assert.ok(err.message.includes('expected "pending"'));
        return true;
      }
    );
  });
  it("throws for unknown step ID", (t) => {
    const graph = makeGraph([makeStep({ id: "a" })]);
    assert.throws(
      () => expandIteration(graph, "nonexistent", ["a"], "{{item}}"),
      (err) => {
        assert.ok(err.message.includes("step not found"));
        assert.ok(err.message.includes("nonexistent"));
        return true;
      }
    );
  });
  it("does not mutate the input graph", (t) => {
    const graph = makeGraph([
      makeStep({ id: "iter", title: "Iterate" }),
      makeStep({ id: "after", dependsOn: ["iter"] })
    ]);
    const originalStepsLength = graph.steps.length;
    const originalAfterDeps = [...graph.steps[1].dependsOn];
    expandIteration(graph, "iter", ["a", "b"], "{{item}}");
    assert.equal(graph.steps.length, originalStepsLength);
    assert.equal(graph.steps[0].status, "pending");
    assert.deepStrictEqual(graph.steps[1].dependsOn, originalAfterDeps);
  });
});
describe("initializeGraph", () => {
  it("converts a valid 3-step definition to graph with all pending steps", (t) => {
    const def = {
      version: 1,
      name: "test-workflow",
      steps: [
        { id: "s1", name: "Step One", prompt: "Do step one", requires: [], produces: ["out.md"] },
        { id: "s2", name: "Step Two", prompt: "Do step two", requires: ["s1"], produces: [] },
        { id: "s3", name: "Step Three", prompt: "Do step three", requires: ["s1", "s2"], produces: [] }
      ]
    };
    const graph = initializeGraph(def);
    assert.equal(graph.steps.length, 3);
    assert.equal(graph.metadata.name, "test-workflow");
    assert.ok(graph.metadata.createdAt);
    for (const step of graph.steps) {
      assert.equal(step.status, "pending");
    }
    assert.equal(graph.steps[0].id, "s1");
    assert.equal(graph.steps[0].title, "Step One");
    assert.equal(graph.steps[0].prompt, "Do step one");
    assert.deepStrictEqual(graph.steps[0].dependsOn, []);
    assert.equal(graph.steps[1].id, "s2");
    assert.deepStrictEqual(graph.steps[1].dependsOn, ["s1"]);
    assert.equal(graph.steps[2].id, "s3");
    assert.deepStrictEqual(graph.steps[2].dependsOn, ["s1", "s2"]);
  });
});
describe("atomic write safety", () => {
  it("final file exists and .tmp file does not exist after write", (t) => {
    const dir = makeTmpDir();
    try {
      const graph = makeGraph([makeStep({ id: "s1" })]);
      writeGraph(dir, graph);
      assert.ok(existsSync(join(dir, "GRAPH.yaml")));
      assert.ok(!existsSync(join(dir, "GRAPH.yaml.tmp")));
    } finally {
      cleanupDir(dir);
    }
  });
  it("YAML content is valid and parseable", (t) => {
    const dir = makeTmpDir();
    try {
      const graph = makeGraph([makeStep({ id: "s1" })]);
      writeGraph(dir, graph);
      const content = readFileSync(join(dir, "GRAPH.yaml"), "utf-8");
      assert.ok(content.includes("created_at"));
      assert.ok(!content.includes("createdAt"));
      assert.ok(!content.includes("dependsOn"));
    } finally {
      cleanupDir(dir);
    }
  });
});
describe("YAML snake_case / camelCase boundary", () => {
  it("writes snake_case to disk and reads back as camelCase", (t) => {
    const dir = makeTmpDir();
    try {
      const graph = makeGraph([
        makeStep({
          id: "s1",
          dependsOn: ["s0"],
          parentStepId: "parent",
          startedAt: "2026-01-01T00:00:00Z",
          finishedAt: "2026-01-01T00:01:00Z"
        })
      ]);
      writeGraph(dir, graph);
      const raw = readFileSync(join(dir, "GRAPH.yaml"), "utf-8");
      assert.ok(raw.includes("depends_on"));
      assert.ok(raw.includes("parent_step_id"));
      assert.ok(raw.includes("started_at"));
      assert.ok(raw.includes("finished_at"));
      assert.ok(raw.includes("created_at"));
      const loaded = readGraph(dir);
      assert.deepStrictEqual(loaded.steps[0].dependsOn, ["s0"]);
      assert.equal(loaded.steps[0].parentStepId, "parent");
      assert.equal(loaded.steps[0].startedAt, "2026-01-01T00:00:00Z");
      assert.equal(loaded.steps[0].finishedAt, "2026-01-01T00:01:00Z");
    } finally {
      cleanupDir(dir);
    }
  });
  it("omits optional fields from YAML when undefined", (t) => {
    const dir = makeTmpDir();
    try {
      const graph = makeGraph([
        makeStep({ id: "s1" })
      ]);
      writeGraph(dir, graph);
      const raw = readFileSync(join(dir, "GRAPH.yaml"), "utf-8");
      assert.ok(!raw.includes("depends_on"));
      assert.ok(!raw.includes("parent_step_id"));
      assert.ok(!raw.includes("started_at"));
      assert.ok(!raw.includes("finished_at"));
    } finally {
      cleanupDir(dir);
    }
  });
});
describe("edge cases", () => {
  it("handles empty items array in expandIteration", (t) => {
    const graph = makeGraph([
      makeStep({ id: "iter" })
    ]);
    const expanded = expandIteration(graph, "iter", [], "{{item}}");
    assert.equal(expanded.steps.length, 1);
    assert.equal(expanded.steps[0].status, "expanded");
  });
  it("handles graph with single step", (t) => {
    const graph = makeGraph([makeStep({ id: "only" })]);
    const next = getNextPendingStep(graph);
    assert.equal(next?.id, "only");
    const completed = markStepComplete(graph, "only");
    assert.equal(getNextPendingStep(completed), null);
  });
  it("initializeGraph handles steps with empty requires", (t) => {
    const def = {
      version: 1,
      name: "empty-requires",
      steps: [
        { id: "s1", name: "Step", prompt: "Go", requires: [], produces: [] }
      ]
    };
    const graph = initializeGraph(def);
    assert.deepStrictEqual(graph.steps[0].dependsOn, []);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9ncmFwaC1vcGVyYXRpb25zLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogZ3JhcGgtb3BlcmF0aW9ucy50ZXN0LnRzIFx1MjAxNCBDb21wcmVoZW5zaXZlIHRlc3RzIGZvciBncmFwaC50cyBEQUcgb3BlcmF0aW9ucy5cbiAqXG4gKiBDb3ZlcnM6IFlBTUwgSS9PIHJvdW5kLXRyaXBzLCBEQUcgcXVlcmllcyAoZ2V0TmV4dFBlbmRpbmdTdGVwKSxcbiAqIGltbXV0YWJsZSBzdGVwIGNvbXBsZXRpb24sIGl0ZXJhdGlvbiBleHBhbnNpb24gd2l0aCBkb3duc3RyZWFtIGRlcFxuICogcmV3cml0aW5nLCBpbml0aWFsaXplR3JhcGggY29udmVyc2lvbiwgYW5kIGF0b21pYyB3cml0ZSBzYWZldHkuXG4gKi9cblxuaW1wb3J0IHsgZGVzY3JpYmUsIGl0IH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgcm1TeW5jLCByZWFkRmlsZVN5bmMsIHdyaXRlRmlsZVN5bmMsIGV4aXN0c1N5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5cbmltcG9ydCB7XG4gIHJlYWRHcmFwaCxcbiAgd3JpdGVHcmFwaCxcbiAgZ2V0TmV4dFBlbmRpbmdTdGVwLFxuICBtYXJrU3RlcENvbXBsZXRlLFxuICBleHBhbmRJdGVyYXRpb24sXG4gIGluaXRpYWxpemVHcmFwaCxcbiAgdHlwZSBXb3JrZmxvd0dyYXBoLFxuICB0eXBlIEdyYXBoU3RlcCxcbn0gZnJvbSBcIi4uL2dyYXBoLnRzXCI7XG5pbXBvcnQgdHlwZSB7IFdvcmtmbG93RGVmaW5pdGlvbiB9IGZyb20gXCIuLi9kZWZpbml0aW9uLWxvYWRlci50c1wiO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgSGVscGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gbWFrZVRtcERpcigpOiBzdHJpbmcge1xuICByZXR1cm4gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJncmFwaC10ZXN0LVwiKSk7XG59XG5cbmZ1bmN0aW9uIGNsZWFudXBEaXIoZGlyOiBzdHJpbmcpOiB2b2lkIHtcbiAgdHJ5IHsgcm1TeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlLCBtYXhSZXRyaWVzOiAzLCByZXRyeURlbGF5OiAxMDAgfSk7IH0gY2F0Y2ggeyAvKiBXaW5kb3dzIEVQRVJNICovIH1cbn1cblxuLyoqIE1pbmltYWwgdmFsaWQgZ3JhcGggZm9yIHRlc3RpbmcuICovXG5mdW5jdGlvbiBtYWtlR3JhcGgoc3RlcHM6IEdyYXBoU3RlcFtdLCBuYW1lID0gXCJ0ZXN0LXdvcmtmbG93XCIpOiBXb3JrZmxvd0dyYXBoIHtcbiAgcmV0dXJuIHtcbiAgICBzdGVwcyxcbiAgICBtZXRhZGF0YTogeyBuYW1lLCBjcmVhdGVkQXQ6IFwiMjAyNi0wMS0wMVQwMDowMDowMC4wMDBaXCIgfSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gbWFrZVN0ZXAob3ZlcnJpZGVzOiBQYXJ0aWFsPEdyYXBoU3RlcD4gJiB7IGlkOiBzdHJpbmcgfSk6IEdyYXBoU3RlcCB7XG4gIHJldHVybiB7XG4gICAgdGl0bGU6IG92ZXJyaWRlcy5pZCxcbiAgICBzdGF0dXM6IFwicGVuZGluZ1wiLFxuICAgIHByb21wdDogYERvICR7b3ZlcnJpZGVzLmlkfWAsXG4gICAgZGVwZW5kc09uOiBbXSxcbiAgICAuLi5vdmVycmlkZXMsXG4gIH07XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCB3cml0ZUdyYXBoICsgcmVhZEdyYXBoIHJvdW5kLXRyaXAgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwid3JpdGVHcmFwaCArIHJlYWRHcmFwaCByb3VuZC10cmlwXCIsICgpID0+IHtcbiAgaXQoXCJwcmVzZXJ2ZXMgYWxsIGZpZWxkcyBpbmNsdWRpbmcgcGFyZW50U3RlcElkIGFuZCBkZXBlbmRzT25cIiwgKHQpID0+IHtcbiAgICBjb25zdCBkaXIgPSBtYWtlVG1wRGlyKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGdyYXBoID0gbWFrZUdyYXBoKFtcbiAgICAgICAgbWFrZVN0ZXAoeyBpZDogXCJzdGVwLTFcIiwgdGl0bGU6IFwiRmlyc3QgU3RlcFwiLCBkZXBlbmRzT246IFtdIH0pLFxuICAgICAgICBtYWtlU3RlcCh7XG4gICAgICAgICAgaWQ6IFwic3RlcC0yXCIsXG4gICAgICAgICAgdGl0bGU6IFwiU2Vjb25kIFN0ZXBcIixcbiAgICAgICAgICBkZXBlbmRzT246IFtcInN0ZXAtMVwiXSxcbiAgICAgICAgICBwYXJlbnRTdGVwSWQ6IFwicGFyZW50LWl0ZXJcIixcbiAgICAgICAgfSksXG4gICAgICBdKTtcblxuICAgICAgd3JpdGVHcmFwaChkaXIsIGdyYXBoKTtcbiAgICAgIGNvbnN0IGxvYWRlZCA9IHJlYWRHcmFwaChkaXIpO1xuXG4gICAgICBhc3NlcnQuZXF1YWwobG9hZGVkLnN0ZXBzLmxlbmd0aCwgMik7XG4gICAgICBhc3NlcnQuZXF1YWwobG9hZGVkLnN0ZXBzWzBdLmlkLCBcInN0ZXAtMVwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChsb2FkZWQuc3RlcHNbMF0udGl0bGUsIFwiRmlyc3QgU3RlcFwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChsb2FkZWQuc3RlcHNbMF0uc3RhdHVzLCBcInBlbmRpbmdcIik7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGxvYWRlZC5zdGVwc1swXS5kZXBlbmRzT24sIFtdKTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKGxvYWRlZC5zdGVwc1sxXS5pZCwgXCJzdGVwLTJcIik7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGxvYWRlZC5zdGVwc1sxXS5kZXBlbmRzT24sIFtcInN0ZXAtMVwiXSk7XG4gICAgICBhc3NlcnQuZXF1YWwobG9hZGVkLnN0ZXBzWzFdLnBhcmVudFN0ZXBJZCwgXCJwYXJlbnQtaXRlclwiKTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKGxvYWRlZC5tZXRhZGF0YS5uYW1lLCBcInRlc3Qtd29ya2Zsb3dcIik7XG4gICAgICBhc3NlcnQuZXF1YWwobG9hZGVkLm1ldGFkYXRhLmNyZWF0ZWRBdCwgXCIyMDI2LTAxLTAxVDAwOjAwOjAwLjAwMFpcIik7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXBEaXIoZGlyKTtcbiAgICB9XG4gIH0pO1xuXG4gIGl0KFwicHJlc2VydmVzIHN0YXJ0ZWRBdCBhbmQgZmluaXNoZWRBdCBmaWVsZHNcIiwgKHQpID0+IHtcbiAgICBjb25zdCBkaXIgPSBtYWtlVG1wRGlyKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGdyYXBoID0gbWFrZUdyYXBoKFtcbiAgICAgICAgbWFrZVN0ZXAoe1xuICAgICAgICAgIGlkOiBcInMxXCIsXG4gICAgICAgICAgc3RhdHVzOiBcImNvbXBsZXRlXCIsXG4gICAgICAgICAgc3RhcnRlZEF0OiBcIjIwMjYtMDEtMDFUMDE6MDA6MDAuMDAwWlwiLFxuICAgICAgICAgIGZpbmlzaGVkQXQ6IFwiMjAyNi0wMS0wMVQwMTowNTowMC4wMDBaXCIsXG4gICAgICAgIH0pLFxuICAgICAgXSk7XG4gICAgICB3cml0ZUdyYXBoKGRpciwgZ3JhcGgpO1xuICAgICAgY29uc3QgbG9hZGVkID0gcmVhZEdyYXBoKGRpcik7XG5cbiAgICAgIGFzc2VydC5lcXVhbChsb2FkZWQuc3RlcHNbMF0uc3RhcnRlZEF0LCBcIjIwMjYtMDEtMDFUMDE6MDA6MDAuMDAwWlwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChsb2FkZWQuc3RlcHNbMF0uZmluaXNoZWRBdCwgXCIyMDI2LTAxLTAxVDAxOjA1OjAwLjAwMFpcIik7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXBEaXIoZGlyKTtcbiAgICB9XG4gIH0pO1xuXG4gIGl0KFwiY3JlYXRlcyBkaXJlY3RvcnkgaWYgaXQgZG9lcyBub3QgZXhpc3RcIiwgKHQpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWFrZVRtcERpcigpO1xuICAgIGNvbnN0IG5lc3RlZCA9IGpvaW4oYmFzZSwgXCJzdWJcIiwgXCJkaXJcIik7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGdyYXBoID0gbWFrZUdyYXBoKFttYWtlU3RlcCh7IGlkOiBcInMxXCIgfSldKTtcbiAgICAgIHdyaXRlR3JhcGgobmVzdGVkLCBncmFwaCk7XG4gICAgICBhc3NlcnQub2soZXhpc3RzU3luYyhqb2luKG5lc3RlZCwgXCJHUkFQSC55YW1sXCIpKSk7XG5cbiAgICAgIGNvbnN0IGxvYWRlZCA9IHJlYWRHcmFwaChuZXN0ZWQpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGxvYWRlZC5zdGVwc1swXS5pZCwgXCJzMVwiKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cERpcihiYXNlKTtcbiAgICB9XG4gIH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCByZWFkR3JhcGggZXJyb3IgcGF0aHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwicmVhZEdyYXBoIGVycm9yIHBhdGhzXCIsICgpID0+IHtcbiAgaXQoXCJ0aHJvd3Mgd2l0aCBkZXNjcmlwdGl2ZSBlcnJvciB3aGVuIGZpbGUgaXMgbWlzc2luZ1wiLCAodCkgPT4ge1xuICAgIGNvbnN0IGRpciA9IG1ha2VUbXBEaXIoKTtcbiAgICB0LmFmdGVyKCgpID0+IHsgY2xlYW51cERpcihkaXIpOyB9KTtcblxuICAgIGFzc2VydC50aHJvd3MoXG4gICAgICAoKSA9PiByZWFkR3JhcGgoZGlyKSxcbiAgICAgIChlcnI6IEVycm9yKSA9PiB7XG4gICAgICAgIGFzc2VydC5vayhlcnIubWVzc2FnZS5pbmNsdWRlcyhcIkdSQVBILnlhbWwgbm90IGZvdW5kXCIpKTtcbiAgICAgICAgYXNzZXJ0Lm9rKGVyci5tZXNzYWdlLmluY2x1ZGVzKGRpcikpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH0sXG4gICAgKTtcbiAgfSk7XG5cbiAgaXQoXCJ0aHJvd3Mgd2l0aCBkZXNjcmlwdGl2ZSBlcnJvciB3aGVuIFlBTUwgaXMgbWFsZm9ybWVkIChtaXNzaW5nIHN0ZXBzKVwiLCAodCkgPT4ge1xuICAgIGNvbnN0IGRpciA9IG1ha2VUbXBEaXIoKTtcbiAgICB0LmFmdGVyKCgpID0+IHsgY2xlYW51cERpcihkaXIpOyB9KTtcblxuICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiR1JBUEgueWFtbFwiKSwgXCJtZXRhZGF0YTpcXG4gIG5hbWU6IGJhZFxcblwiLCBcInV0Zi04XCIpO1xuICAgIGFzc2VydC50aHJvd3MoXG4gICAgICAoKSA9PiByZWFkR3JhcGgoZGlyKSxcbiAgICAgIChlcnI6IEVycm9yKSA9PiB7XG4gICAgICAgIGFzc2VydC5vayhlcnIubWVzc2FnZS5pbmNsdWRlcyhcIm1pc3Npbmcgb3IgaW52YWxpZCAnc3RlcHMnIGFycmF5XCIpKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9LFxuICAgICk7XG4gIH0pO1xuXG4gIGl0KFwidGhyb3dzIHdoZW4gc3RlcHMgaXMgbm90IGFuIGFycmF5XCIsICh0KSA9PiB7XG4gICAgY29uc3QgZGlyID0gbWFrZVRtcERpcigpO1xuICAgIHQuYWZ0ZXIoKCkgPT4geyBjbGVhbnVwRGlyKGRpcik7IH0pO1xuXG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJHUkFQSC55YW1sXCIpLCBcInN0ZXBzOiBub3QtYW4tYXJyYXlcXG5tZXRhZGF0YTpcXG4gIG5hbWU6IGJhZFxcblwiLCBcInV0Zi04XCIpO1xuICAgIGFzc2VydC50aHJvd3MoXG4gICAgICAoKSA9PiByZWFkR3JhcGgoZGlyKSxcbiAgICAgIChlcnI6IEVycm9yKSA9PiB7XG4gICAgICAgIGFzc2VydC5vayhlcnIubWVzc2FnZS5pbmNsdWRlcyhcIm1pc3Npbmcgb3IgaW52YWxpZCAnc3RlcHMnIGFycmF5XCIpKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9LFxuICAgICk7XG4gIH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBnZXROZXh0UGVuZGluZ1N0ZXAgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiZ2V0TmV4dFBlbmRpbmdTdGVwXCIsICgpID0+IHtcbiAgaXQoXCJyZXR1cm5zIGZpcnN0IHN0ZXAgd2l0aCBhbGwgZGVwcyBjb21wbGV0ZVwiLCAodCkgPT4ge1xuICAgIGNvbnN0IGdyYXBoID0gbWFrZUdyYXBoKFtcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwiYVwiLCBzdGF0dXM6IFwiY29tcGxldGVcIiB9KSxcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwiYlwiLCBkZXBlbmRzT246IFtcImFcIl0gfSksXG4gICAgICBtYWtlU3RlcCh7IGlkOiBcImNcIiwgZGVwZW5kc09uOiBbXCJiXCJdIH0pLFxuICAgIF0pO1xuXG4gICAgY29uc3QgbmV4dCA9IGdldE5leHRQZW5kaW5nU3RlcChncmFwaCk7XG4gICAgYXNzZXJ0LmVxdWFsKG5leHQ/LmlkLCBcImJcIik7XG4gIH0pO1xuXG4gIGl0KFwic2tpcHMgc3RlcHMgd2l0aCBpbmNvbXBsZXRlIGRlcHNcIiwgKHQpID0+IHtcbiAgICBjb25zdCBncmFwaCA9IG1ha2VHcmFwaChbXG4gICAgICBtYWtlU3RlcCh7IGlkOiBcImFcIiB9KSxcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwiYlwiLCBkZXBlbmRzT246IFtcImFcIl0gfSksXG4gICAgXSk7XG5cbiAgICAvLyAnYScgaXMgc3RpbGwgcGVuZGluZywgc28gJ2InIGlzIGJsb2NrZWQsIGJ1dCAnYScgaGFzIG5vIGRlcHMgXHUyMTkyIHJldHVybnMgJ2EnXG4gICAgY29uc3QgbmV4dCA9IGdldE5leHRQZW5kaW5nU3RlcChncmFwaCk7XG4gICAgYXNzZXJ0LmVxdWFsKG5leHQ/LmlkLCBcImFcIik7XG4gIH0pO1xuXG4gIGl0KFwicmV0dXJucyBudWxsIHdoZW4gYWxsIHN0ZXBzIGFyZSBjb21wbGV0ZVwiLCAodCkgPT4ge1xuICAgIGNvbnN0IGdyYXBoID0gbWFrZUdyYXBoKFtcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwiYVwiLCBzdGF0dXM6IFwiY29tcGxldGVcIiB9KSxcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwiYlwiLCBzdGF0dXM6IFwiY29tcGxldGVcIiB9KSxcbiAgICBdKTtcblxuICAgIGFzc2VydC5lcXVhbChnZXROZXh0UGVuZGluZ1N0ZXAoZ3JhcGgpLCBudWxsKTtcbiAgfSk7XG5cbiAgaXQoXCJyZXR1cm5zIG51bGwgd2hlbiBhbGwgcGVuZGluZyBzdGVwcyBhcmUgYmxvY2tlZFwiLCAodCkgPT4ge1xuICAgIGNvbnN0IGdyYXBoID0gbWFrZUdyYXBoKFtcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwiYVwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSksIC8vIG5vdCBjb21wbGV0ZVxuICAgICAgbWFrZVN0ZXAoeyBpZDogXCJiXCIsIGRlcGVuZHNPbjogW1wiYVwiXSB9KSwgIC8vIGJsb2NrZWRcbiAgICBdKTtcblxuICAgIGFzc2VydC5lcXVhbChnZXROZXh0UGVuZGluZ1N0ZXAoZ3JhcGgpLCBudWxsKTtcbiAgfSk7XG5cbiAgaXQoXCJyZXR1cm5zIGZpcnN0IHBlbmRpbmcgc3RlcCB3aXRoIG5vIGRlcHMgd2hlbiByb290IHN0ZXBzIGV4aXN0XCIsICh0KSA9PiB7XG4gICAgY29uc3QgZ3JhcGggPSBtYWtlR3JhcGgoW1xuICAgICAgbWFrZVN0ZXAoeyBpZDogXCJhXCIgfSksXG4gICAgICBtYWtlU3RlcCh7IGlkOiBcImJcIiB9KSxcbiAgICBdKTtcblxuICAgIGNvbnN0IG5leHQgPSBnZXROZXh0UGVuZGluZ1N0ZXAoZ3JhcGgpO1xuICAgIGFzc2VydC5lcXVhbChuZXh0Py5pZCwgXCJhXCIpO1xuICB9KTtcblxuICBpdChcInNraXBzIGV4cGFuZGVkIHN0ZXBzXCIsICh0KSA9PiB7XG4gICAgY29uc3QgZ3JhcGggPSBtYWtlR3JhcGgoW1xuICAgICAgbWFrZVN0ZXAoeyBpZDogXCJhXCIsIHN0YXR1czogXCJleHBhbmRlZFwiIH0pLFxuICAgICAgbWFrZVN0ZXAoeyBpZDogXCJiXCIgfSksXG4gICAgXSk7XG5cbiAgICBjb25zdCBuZXh0ID0gZ2V0TmV4dFBlbmRpbmdTdGVwKGdyYXBoKTtcbiAgICBhc3NlcnQuZXF1YWwobmV4dD8uaWQsIFwiYlwiKTtcbiAgfSk7XG5cbiAgaXQoXCJ0cmVhdHMgZXhwYW5kZWQgZGVwZW5kZW5jaWVzIGFzIHNhdGlzZmllZFwiLCAodCkgPT4ge1xuICAgIGNvbnN0IGdyYXBoID0gbWFrZUdyYXBoKFtcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwiaXRlclwiLCBzdGF0dXM6IFwiZXhwYW5kZWRcIiB9KSxcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwiYWZ0ZXJcIiwgZGVwZW5kc09uOiBbXCJpdGVyXCJdIH0pLFxuICAgIF0pO1xuXG4gICAgY29uc3QgbmV4dCA9IGdldE5leHRQZW5kaW5nU3RlcChncmFwaCk7XG4gICAgYXNzZXJ0LmVxdWFsKG5leHQ/LmlkLCBcImFmdGVyXCIpO1xuICB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgbWFya1N0ZXBDb21wbGV0ZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJtYXJrU3RlcENvbXBsZXRlXCIsICgpID0+IHtcbiAgaXQoXCJyZXR1cm5zIG5ldyBncmFwaCB3aXRoIHN0ZXAgc3RhdHVzICdjb21wbGV0ZScgKG9yaWdpbmFsIHVuY2hhbmdlZClcIiwgKHQpID0+IHtcbiAgICBjb25zdCBvcmlnaW5hbCA9IG1ha2VHcmFwaChbXG4gICAgICBtYWtlU3RlcCh7IGlkOiBcImFcIiB9KSxcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwiYlwiIH0pLFxuICAgIF0pO1xuXG4gICAgY29uc3QgdXBkYXRlZCA9IG1hcmtTdGVwQ29tcGxldGUob3JpZ2luYWwsIFwiYVwiKTtcblxuICAgIC8vIE9yaWdpbmFsIGlzIHVudG91Y2hlZFxuICAgIGFzc2VydC5lcXVhbChvcmlnaW5hbC5zdGVwc1swXS5zdGF0dXMsIFwicGVuZGluZ1wiKTtcblxuICAgIC8vIE5ldyBncmFwaCBoYXMgdGhlIHN0ZXAgY29tcGxldGVcbiAgICBhc3NlcnQuZXF1YWwodXBkYXRlZC5zdGVwc1swXS5zdGF0dXMsIFwiY29tcGxldGVcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHVwZGF0ZWQuc3RlcHNbMF0uaWQsIFwiYVwiKTtcblxuICAgIC8vIE90aGVyIHN0ZXBzIHVuY2hhbmdlZFxuICAgIGFzc2VydC5lcXVhbCh1cGRhdGVkLnN0ZXBzWzFdLnN0YXR1cywgXCJwZW5kaW5nXCIpO1xuICB9KTtcblxuICBpdChcInNldHMgZmluaXNoZWRBdCB0aW1lc3RhbXBcIiwgKHQpID0+IHtcbiAgICBjb25zdCBncmFwaCA9IG1ha2VHcmFwaChbbWFrZVN0ZXAoeyBpZDogXCJhXCIgfSldKTtcbiAgICBjb25zdCB1cGRhdGVkID0gbWFya1N0ZXBDb21wbGV0ZShncmFwaCwgXCJhXCIpO1xuICAgIGFzc2VydC5vayh1cGRhdGVkLnN0ZXBzWzBdLmZpbmlzaGVkQXQpO1xuICAgIC8vIFNob3VsZCBiZSBhIHZhbGlkIElTTyBzdHJpbmdcbiAgICBhc3NlcnQub2soIWlzTmFOKERhdGUucGFyc2UodXBkYXRlZC5zdGVwc1swXS5maW5pc2hlZEF0ISkpKTtcbiAgfSk7XG5cbiAgaXQoXCJ0aHJvd3MgZm9yIHVua25vd24gc3RlcCBJRFwiLCAodCkgPT4ge1xuICAgIGNvbnN0IGdyYXBoID0gbWFrZUdyYXBoKFttYWtlU3RlcCh7IGlkOiBcImFcIiB9KV0pO1xuICAgIGFzc2VydC50aHJvd3MoXG4gICAgICAoKSA9PiBtYXJrU3RlcENvbXBsZXRlKGdyYXBoLCBcIm5vbmV4aXN0ZW50XCIpLFxuICAgICAgKGVycjogRXJyb3IpID0+IHtcbiAgICAgICAgYXNzZXJ0Lm9rKGVyci5tZXNzYWdlLmluY2x1ZGVzKFwiU3RlcCBub3QgZm91bmRcIikpO1xuICAgICAgICBhc3NlcnQub2soZXJyLm1lc3NhZ2UuaW5jbHVkZXMoXCJub25leGlzdGVudFwiKSk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfSxcbiAgICApO1xuICB9KTtcblxuICBpdChcInByZXNlcnZlcyBtZXRhZGF0YSBpbiByZXR1cm5lZCBncmFwaFwiLCAodCkgPT4ge1xuICAgIGNvbnN0IGdyYXBoID0gbWFrZUdyYXBoKFttYWtlU3RlcCh7IGlkOiBcImFcIiB9KV0sIFwibXktd29ya2Zsb3dcIik7XG4gICAgY29uc3QgdXBkYXRlZCA9IG1hcmtTdGVwQ29tcGxldGUoZ3JhcGgsIFwiYVwiKTtcbiAgICBhc3NlcnQuZXF1YWwodXBkYXRlZC5tZXRhZGF0YS5uYW1lLCBcIm15LXdvcmtmbG93XCIpO1xuICAgIGFzc2VydC5lcXVhbCh1cGRhdGVkLm1ldGFkYXRhLmNyZWF0ZWRBdCwgXCIyMDI2LTAxLTAxVDAwOjAwOjAwLjAwMFpcIik7XG4gIH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBleHBhbmRJdGVyYXRpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiZXhwYW5kSXRlcmF0aW9uXCIsICgpID0+IHtcbiAgaXQoXCJjcmVhdGVzIGluc3RhbmNlIHN0ZXBzIHdpdGggY29ycmVjdCBJRHMgKHN0ZXBJZC0tMDAxLCBzdGVwSWQtLTAwMilcIiwgKHQpID0+IHtcbiAgICBjb25zdCBncmFwaCA9IG1ha2VHcmFwaChbXG4gICAgICBtYWtlU3RlcCh7IGlkOiBcIml0ZXItc3RlcFwiLCB0aXRsZTogXCJQcm9jZXNzIGl0ZW1zXCIgfSksXG4gICAgICBtYWtlU3RlcCh7IGlkOiBcImZpbmFsXCIsIGRlcGVuZHNPbjogW1wiaXRlci1zdGVwXCJdIH0pLFxuICAgIF0pO1xuXG4gICAgY29uc3QgZXhwYW5kZWQgPSBleHBhbmRJdGVyYXRpb24oXG4gICAgICBncmFwaCxcbiAgICAgIFwiaXRlci1zdGVwXCIsXG4gICAgICBbXCJhcHBsZVwiLCBcImJhbmFuYVwiLCBcImNoZXJyeVwiXSxcbiAgICAgIFwiUHJvY2VzcyB7e2l0ZW19fVwiLFxuICAgICk7XG5cbiAgICAvLyBQYXJlbnQgKyAzIGluc3RhbmNlcyArIGZpbmFsID0gNSBzdGVwc1xuICAgIGFzc2VydC5lcXVhbChleHBhbmRlZC5zdGVwcy5sZW5ndGgsIDUpO1xuXG4gICAgLy8gSW5zdGFuY2VzIGFyZSBjb3JyZWN0bHkgbmFtZWRcbiAgICBhc3NlcnQuZXF1YWwoZXhwYW5kZWQuc3RlcHNbMV0uaWQsIFwiaXRlci1zdGVwLS0wMDFcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGV4cGFuZGVkLnN0ZXBzWzJdLmlkLCBcIml0ZXItc3RlcC0tMDAyXCIpO1xuICAgIGFzc2VydC5lcXVhbChleHBhbmRlZC5zdGVwc1szXS5pZCwgXCJpdGVyLXN0ZXAtLTAwM1wiKTtcbiAgfSk7XG5cbiAgaXQoXCJtYXJrcyBwYXJlbnQgc3RlcCBhcyAnZXhwYW5kZWQnXCIsICh0KSA9PiB7XG4gICAgY29uc3QgZ3JhcGggPSBtYWtlR3JhcGgoW1xuICAgICAgbWFrZVN0ZXAoeyBpZDogXCJpdGVyXCIsIHRpdGxlOiBcIkl0ZXJhdGVcIiB9KSxcbiAgICBdKTtcblxuICAgIGNvbnN0IGV4cGFuZGVkID0gZXhwYW5kSXRlcmF0aW9uKGdyYXBoLCBcIml0ZXJcIiwgW1wiYVwiXSwgXCJEbyB7e2l0ZW19fVwiKTtcbiAgICBhc3NlcnQuZXF1YWwoZXhwYW5kZWQuc3RlcHNbMF0uc3RhdHVzLCBcImV4cGFuZGVkXCIpO1xuICB9KTtcblxuICBpdChcImluc3RhbmNlIHN0ZXBzIGhhdmUgY29ycmVjdCB0aXRsZXMsIHByb21wdHMsIHBhcmVudFN0ZXBJZCwgYW5kIGRlcHNcIiwgKHQpID0+IHtcbiAgICBjb25zdCBncmFwaCA9IG1ha2VHcmFwaChbXG4gICAgICBtYWtlU3RlcCh7IGlkOiBcInByZVwiLCBzdGF0dXM6IFwiY29tcGxldGVcIiB9KSxcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwiaXRlclwiLCB0aXRsZTogXCJQcm9jZXNzXCIsIGRlcGVuZHNPbjogW1wicHJlXCJdIH0pLFxuICAgIF0pO1xuXG4gICAgY29uc3QgZXhwYW5kZWQgPSBleHBhbmRJdGVyYXRpb24oXG4gICAgICBncmFwaCxcbiAgICAgIFwiaXRlclwiLFxuICAgICAgW1wiZm9vXCIsIFwiYmFyXCJdLFxuICAgICAgXCJIYW5kbGUge3tpdGVtfX0gY2FyZWZ1bGx5XCIsXG4gICAgKTtcblxuICAgIGNvbnN0IGluc3QxID0gZXhwYW5kZWQuc3RlcHNbMl07IC8vIGFmdGVyIHByZSBhbmQgZXhwYW5kZWQgcGFyZW50XG4gICAgYXNzZXJ0LmVxdWFsKGluc3QxLnRpdGxlLCBcIlByb2Nlc3M6IGZvb1wiKTtcbiAgICBhc3NlcnQuZXF1YWwoaW5zdDEucHJvbXB0LCBcIkhhbmRsZSBmb28gY2FyZWZ1bGx5XCIpO1xuICAgIGFzc2VydC5lcXVhbChpbnN0MS5wYXJlbnRTdGVwSWQsIFwiaXRlclwiKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGluc3QxLmRlcGVuZHNPbiwgW1wicHJlXCJdKTtcbiAgICBhc3NlcnQuZXF1YWwoaW5zdDEuc3RhdHVzLCBcInBlbmRpbmdcIik7XG5cbiAgICBjb25zdCBpbnN0MiA9IGV4cGFuZGVkLnN0ZXBzWzNdO1xuICAgIGFzc2VydC5lcXVhbChpbnN0Mi50aXRsZSwgXCJQcm9jZXNzOiBiYXJcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGluc3QyLnByb21wdCwgXCJIYW5kbGUgYmFyIGNhcmVmdWxseVwiKTtcbiAgICBhc3NlcnQuZXF1YWwoaW5zdDIucGFyZW50U3RlcElkLCBcIml0ZXJcIik7XG4gIH0pO1xuXG4gIGl0KFwicmV3cml0ZXMgZG93bnN0cmVhbSBkZXBzIGZyb20gcGFyZW50IElEIHRvIGFsbCBpbnN0YW5jZSBJRHNcIiwgKHQpID0+IHtcbiAgICBjb25zdCBncmFwaCA9IG1ha2VHcmFwaChbXG4gICAgICBtYWtlU3RlcCh7IGlkOiBcIml0ZXJcIiwgdGl0bGU6IFwiSXRlcmF0ZVwiIH0pLFxuICAgICAgbWFrZVN0ZXAoeyBpZDogXCJhZnRlclwiLCBkZXBlbmRzT246IFtcIml0ZXJcIl0gfSksXG4gICAgXSk7XG5cbiAgICBjb25zdCBleHBhbmRlZCA9IGV4cGFuZEl0ZXJhdGlvbihcbiAgICAgIGdyYXBoLFxuICAgICAgXCJpdGVyXCIsXG4gICAgICBbXCJ4XCIsIFwieVwiXSxcbiAgICAgIFwiRG8ge3tpdGVtfX1cIixcbiAgICApO1xuXG4gICAgLy8gJ2FmdGVyJyBzaG91bGQgbm93IGRlcGVuZCBvbiBpdGVyLS0wMDEgYW5kIGl0ZXItLTAwMlxuICAgIGNvbnN0IGFmdGVyU3RlcCA9IGV4cGFuZGVkLnN0ZXBzLmZpbmQoKHMpID0+IHMuaWQgPT09IFwiYWZ0ZXJcIikhO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoYWZ0ZXJTdGVwLmRlcGVuZHNPbiwgW1wiaXRlci0tMDAxXCIsIFwiaXRlci0tMDAyXCJdKTtcbiAgfSk7XG5cbiAgaXQoXCJwcmVzZXJ2ZXMgc3RlcHMgdGhhdCBkb24ndCBkZXBlbmQgb24gdGhlIHBhcmVudFwiLCAodCkgPT4ge1xuICAgIGNvbnN0IGdyYXBoID0gbWFrZUdyYXBoKFtcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwidW5yZWxhdGVkXCIgfSksXG4gICAgICBtYWtlU3RlcCh7IGlkOiBcIml0ZXJcIiwgdGl0bGU6IFwiSXRlcmF0ZVwiIH0pLFxuICAgICAgbWFrZVN0ZXAoeyBpZDogXCJhZnRlclwiLCBkZXBlbmRzT246IFtcIml0ZXJcIl0gfSksXG4gICAgXSk7XG5cbiAgICBjb25zdCBleHBhbmRlZCA9IGV4cGFuZEl0ZXJhdGlvbihncmFwaCwgXCJpdGVyXCIsIFtcImFcIl0sIFwie3tpdGVtfX1cIik7XG4gICAgY29uc3QgdW5yZWxhdGVkID0gZXhwYW5kZWQuc3RlcHMuZmluZCgocykgPT4gcy5pZCA9PT0gXCJ1bnJlbGF0ZWRcIikhO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwodW5yZWxhdGVkLmRlcGVuZHNPbiwgW10pO1xuICB9KTtcblxuICBpdChcInRocm93cyBmb3Igbm9uLXBlbmRpbmcgcGFyZW50IHN0ZXBcIiwgKHQpID0+IHtcbiAgICBjb25zdCBncmFwaCA9IG1ha2VHcmFwaChbXG4gICAgICBtYWtlU3RlcCh7IGlkOiBcIml0ZXJcIiwgc3RhdHVzOiBcImNvbXBsZXRlXCIgfSksXG4gICAgXSk7XG5cbiAgICBhc3NlcnQudGhyb3dzKFxuICAgICAgKCkgPT4gZXhwYW5kSXRlcmF0aW9uKGdyYXBoLCBcIml0ZXJcIiwgW1wiYVwiXSwgXCJ7e2l0ZW19fVwiKSxcbiAgICAgIChlcnI6IEVycm9yKSA9PiB7XG4gICAgICAgIGFzc2VydC5vayhlcnIubWVzc2FnZS5pbmNsdWRlcyhcImNvbXBsZXRlXCIpKTtcbiAgICAgICAgYXNzZXJ0Lm9rKGVyci5tZXNzYWdlLmluY2x1ZGVzKFwiZXhwZWN0ZWQgXFxcInBlbmRpbmdcXFwiXCIpKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9LFxuICAgICk7XG4gIH0pO1xuXG4gIGl0KFwidGhyb3dzIGZvciB1bmtub3duIHN0ZXAgSURcIiwgKHQpID0+IHtcbiAgICBjb25zdCBncmFwaCA9IG1ha2VHcmFwaChbbWFrZVN0ZXAoeyBpZDogXCJhXCIgfSldKTtcbiAgICBhc3NlcnQudGhyb3dzKFxuICAgICAgKCkgPT4gZXhwYW5kSXRlcmF0aW9uKGdyYXBoLCBcIm5vbmV4aXN0ZW50XCIsIFtcImFcIl0sIFwie3tpdGVtfX1cIiksXG4gICAgICAoZXJyOiBFcnJvcikgPT4ge1xuICAgICAgICBhc3NlcnQub2soZXJyLm1lc3NhZ2UuaW5jbHVkZXMoXCJzdGVwIG5vdCBmb3VuZFwiKSk7XG4gICAgICAgIGFzc2VydC5vayhlcnIubWVzc2FnZS5pbmNsdWRlcyhcIm5vbmV4aXN0ZW50XCIpKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9LFxuICAgICk7XG4gIH0pO1xuXG4gIGl0KFwiZG9lcyBub3QgbXV0YXRlIHRoZSBpbnB1dCBncmFwaFwiLCAodCkgPT4ge1xuICAgIGNvbnN0IGdyYXBoID0gbWFrZUdyYXBoKFtcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwiaXRlclwiLCB0aXRsZTogXCJJdGVyYXRlXCIgfSksXG4gICAgICBtYWtlU3RlcCh7IGlkOiBcImFmdGVyXCIsIGRlcGVuZHNPbjogW1wiaXRlclwiXSB9KSxcbiAgICBdKTtcblxuICAgIGNvbnN0IG9yaWdpbmFsU3RlcHNMZW5ndGggPSBncmFwaC5zdGVwcy5sZW5ndGg7XG4gICAgY29uc3Qgb3JpZ2luYWxBZnRlckRlcHMgPSBbLi4uZ3JhcGguc3RlcHNbMV0uZGVwZW5kc09uXTtcblxuICAgIGV4cGFuZEl0ZXJhdGlvbihncmFwaCwgXCJpdGVyXCIsIFtcImFcIiwgXCJiXCJdLCBcInt7aXRlbX19XCIpO1xuXG4gICAgLy8gT3JpZ2luYWwgdW5jaGFuZ2VkXG4gICAgYXNzZXJ0LmVxdWFsKGdyYXBoLnN0ZXBzLmxlbmd0aCwgb3JpZ2luYWxTdGVwc0xlbmd0aCk7XG4gICAgYXNzZXJ0LmVxdWFsKGdyYXBoLnN0ZXBzWzBdLnN0YXR1cywgXCJwZW5kaW5nXCIpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZ3JhcGguc3RlcHNbMV0uZGVwZW5kc09uLCBvcmlnaW5hbEFmdGVyRGVwcyk7XG4gIH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBpbml0aWFsaXplR3JhcGggXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiaW5pdGlhbGl6ZUdyYXBoXCIsICgpID0+IHtcbiAgaXQoXCJjb252ZXJ0cyBhIHZhbGlkIDMtc3RlcCBkZWZpbml0aW9uIHRvIGdyYXBoIHdpdGggYWxsIHBlbmRpbmcgc3RlcHNcIiwgKHQpID0+IHtcbiAgICBjb25zdCBkZWY6IFdvcmtmbG93RGVmaW5pdGlvbiA9IHtcbiAgICAgIHZlcnNpb246IDEsXG4gICAgICBuYW1lOiBcInRlc3Qtd29ya2Zsb3dcIixcbiAgICAgIHN0ZXBzOiBbXG4gICAgICAgIHsgaWQ6IFwiczFcIiwgbmFtZTogXCJTdGVwIE9uZVwiLCBwcm9tcHQ6IFwiRG8gc3RlcCBvbmVcIiwgcmVxdWlyZXM6IFtdLCBwcm9kdWNlczogW1wib3V0Lm1kXCJdIH0sXG4gICAgICAgIHsgaWQ6IFwiczJcIiwgbmFtZTogXCJTdGVwIFR3b1wiLCBwcm9tcHQ6IFwiRG8gc3RlcCB0d29cIiwgcmVxdWlyZXM6IFtcInMxXCJdLCBwcm9kdWNlczogW10gfSxcbiAgICAgICAgeyBpZDogXCJzM1wiLCBuYW1lOiBcIlN0ZXAgVGhyZWVcIiwgcHJvbXB0OiBcIkRvIHN0ZXAgdGhyZWVcIiwgcmVxdWlyZXM6IFtcInMxXCIsIFwiczJcIl0sIHByb2R1Y2VzOiBbXSB9LFxuICAgICAgXSxcbiAgICB9O1xuXG4gICAgY29uc3QgZ3JhcGggPSBpbml0aWFsaXplR3JhcGgoZGVmKTtcblxuICAgIGFzc2VydC5lcXVhbChncmFwaC5zdGVwcy5sZW5ndGgsIDMpO1xuICAgIGFzc2VydC5lcXVhbChncmFwaC5tZXRhZGF0YS5uYW1lLCBcInRlc3Qtd29ya2Zsb3dcIik7XG4gICAgYXNzZXJ0Lm9rKGdyYXBoLm1ldGFkYXRhLmNyZWF0ZWRBdCk7IC8vIElTTyBzdHJpbmdcblxuICAgIC8vIEFsbCBwZW5kaW5nXG4gICAgZm9yIChjb25zdCBzdGVwIG9mIGdyYXBoLnN0ZXBzKSB7XG4gICAgICBhc3NlcnQuZXF1YWwoc3RlcC5zdGF0dXMsIFwicGVuZGluZ1wiKTtcbiAgICB9XG5cbiAgICAvLyBDb3JyZWN0IG1hcHBpbmdcbiAgICBhc3NlcnQuZXF1YWwoZ3JhcGguc3RlcHNbMF0uaWQsIFwiczFcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGdyYXBoLnN0ZXBzWzBdLnRpdGxlLCBcIlN0ZXAgT25lXCIpO1xuICAgIGFzc2VydC5lcXVhbChncmFwaC5zdGVwc1swXS5wcm9tcHQsIFwiRG8gc3RlcCBvbmVcIik7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChncmFwaC5zdGVwc1swXS5kZXBlbmRzT24sIFtdKTtcblxuICAgIGFzc2VydC5lcXVhbChncmFwaC5zdGVwc1sxXS5pZCwgXCJzMlwiKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGdyYXBoLnN0ZXBzWzFdLmRlcGVuZHNPbiwgW1wiczFcIl0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKGdyYXBoLnN0ZXBzWzJdLmlkLCBcInMzXCIpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZ3JhcGguc3RlcHNbMl0uZGVwZW5kc09uLCBbXCJzMVwiLCBcInMyXCJdKTtcbiAgfSk7XG5cbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQXRvbWljIHdyaXRlIHNhZmV0eSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJhdG9taWMgd3JpdGUgc2FmZXR5XCIsICgpID0+IHtcbiAgaXQoXCJmaW5hbCBmaWxlIGV4aXN0cyBhbmQgLnRtcCBmaWxlIGRvZXMgbm90IGV4aXN0IGFmdGVyIHdyaXRlXCIsICh0KSA9PiB7XG4gICAgY29uc3QgZGlyID0gbWFrZVRtcERpcigpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBncmFwaCA9IG1ha2VHcmFwaChbbWFrZVN0ZXAoeyBpZDogXCJzMVwiIH0pXSk7XG4gICAgICB3cml0ZUdyYXBoKGRpciwgZ3JhcGgpO1xuXG4gICAgICBhc3NlcnQub2soZXhpc3RzU3luYyhqb2luKGRpciwgXCJHUkFQSC55YW1sXCIpKSk7XG4gICAgICBhc3NlcnQub2soIWV4aXN0c1N5bmMoam9pbihkaXIsIFwiR1JBUEgueWFtbC50bXBcIikpKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cERpcihkaXIpO1xuICAgIH1cbiAgfSk7XG5cbiAgaXQoXCJZQU1MIGNvbnRlbnQgaXMgdmFsaWQgYW5kIHBhcnNlYWJsZVwiLCAodCkgPT4ge1xuICAgIGNvbnN0IGRpciA9IG1ha2VUbXBEaXIoKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgZ3JhcGggPSBtYWtlR3JhcGgoW21ha2VTdGVwKHsgaWQ6IFwiczFcIiB9KV0pO1xuICAgICAgd3JpdGVHcmFwaChkaXIsIGdyYXBoKTtcblxuICAgICAgY29uc3QgY29udGVudCA9IHJlYWRGaWxlU3luYyhqb2luKGRpciwgXCJHUkFQSC55YW1sXCIpLCBcInV0Zi04XCIpO1xuICAgICAgLy8gU2hvdWxkIGNvbnRhaW4gc25ha2VfY2FzZSBrZXlzXG4gICAgICBhc3NlcnQub2soY29udGVudC5pbmNsdWRlcyhcImNyZWF0ZWRfYXRcIikpO1xuICAgICAgLy8gU2hvdWxkIG5vdCBjb250YWluIGNhbWVsQ2FzZSBrZXlzXG4gICAgICBhc3NlcnQub2soIWNvbnRlbnQuaW5jbHVkZXMoXCJjcmVhdGVkQXRcIikpO1xuICAgICAgYXNzZXJ0Lm9rKCFjb250ZW50LmluY2x1ZGVzKFwiZGVwZW5kc09uXCIpKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cERpcihkaXIpO1xuICAgIH1cbiAgfSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFlBTUwgc25ha2VfY2FzZSAvIGNhbWVsQ2FzZSBib3VuZGFyeSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJZQU1MIHNuYWtlX2Nhc2UgLyBjYW1lbENhc2UgYm91bmRhcnlcIiwgKCkgPT4ge1xuICBpdChcIndyaXRlcyBzbmFrZV9jYXNlIHRvIGRpc2sgYW5kIHJlYWRzIGJhY2sgYXMgY2FtZWxDYXNlXCIsICh0KSA9PiB7XG4gICAgY29uc3QgZGlyID0gbWFrZVRtcERpcigpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBncmFwaCA9IG1ha2VHcmFwaChbXG4gICAgICAgIG1ha2VTdGVwKHtcbiAgICAgICAgICBpZDogXCJzMVwiLFxuICAgICAgICAgIGRlcGVuZHNPbjogW1wiczBcIl0sXG4gICAgICAgICAgcGFyZW50U3RlcElkOiBcInBhcmVudFwiLFxuICAgICAgICAgIHN0YXJ0ZWRBdDogXCIyMDI2LTAxLTAxVDAwOjAwOjAwWlwiLFxuICAgICAgICAgIGZpbmlzaGVkQXQ6IFwiMjAyNi0wMS0wMVQwMDowMTowMFpcIixcbiAgICAgICAgfSksXG4gICAgICBdKTtcblxuICAgICAgd3JpdGVHcmFwaChkaXIsIGdyYXBoKTtcblxuICAgICAgLy8gVmVyaWZ5IHJhdyBZQU1MIHVzZXMgc25ha2VfY2FzZVxuICAgICAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKGpvaW4oZGlyLCBcIkdSQVBILnlhbWxcIiksIFwidXRmLThcIik7XG4gICAgICBhc3NlcnQub2socmF3LmluY2x1ZGVzKFwiZGVwZW5kc19vblwiKSk7XG4gICAgICBhc3NlcnQub2socmF3LmluY2x1ZGVzKFwicGFyZW50X3N0ZXBfaWRcIikpO1xuICAgICAgYXNzZXJ0Lm9rKHJhdy5pbmNsdWRlcyhcInN0YXJ0ZWRfYXRcIikpO1xuICAgICAgYXNzZXJ0Lm9rKHJhdy5pbmNsdWRlcyhcImZpbmlzaGVkX2F0XCIpKTtcbiAgICAgIGFzc2VydC5vayhyYXcuaW5jbHVkZXMoXCJjcmVhdGVkX2F0XCIpKTtcblxuICAgICAgLy8gVmVyaWZ5IHJlYWQgcmV0dXJucyBjYW1lbENhc2VcbiAgICAgIGNvbnN0IGxvYWRlZCA9IHJlYWRHcmFwaChkaXIpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChsb2FkZWQuc3RlcHNbMF0uZGVwZW5kc09uLCBbXCJzMFwiXSk7XG4gICAgICBhc3NlcnQuZXF1YWwobG9hZGVkLnN0ZXBzWzBdLnBhcmVudFN0ZXBJZCwgXCJwYXJlbnRcIik7XG4gICAgICBhc3NlcnQuZXF1YWwobG9hZGVkLnN0ZXBzWzBdLnN0YXJ0ZWRBdCwgXCIyMDI2LTAxLTAxVDAwOjAwOjAwWlwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChsb2FkZWQuc3RlcHNbMF0uZmluaXNoZWRBdCwgXCIyMDI2LTAxLTAxVDAwOjAxOjAwWlwiKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cERpcihkaXIpO1xuICAgIH1cbiAgfSk7XG5cbiAgaXQoXCJvbWl0cyBvcHRpb25hbCBmaWVsZHMgZnJvbSBZQU1MIHdoZW4gdW5kZWZpbmVkXCIsICh0KSA9PiB7XG4gICAgY29uc3QgZGlyID0gbWFrZVRtcERpcigpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBncmFwaCA9IG1ha2VHcmFwaChbXG4gICAgICAgIG1ha2VTdGVwKHsgaWQ6IFwiczFcIiB9KSxcbiAgICAgIF0pO1xuXG4gICAgICB3cml0ZUdyYXBoKGRpciwgZ3JhcGgpO1xuICAgICAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKGpvaW4oZGlyLCBcIkdSQVBILnlhbWxcIiksIFwidXRmLThcIik7XG5cbiAgICAgIC8vIE5vIGRlcGVuZHNfb24sIHBhcmVudF9zdGVwX2lkLCBzdGFydGVkX2F0LCBmaW5pc2hlZF9hdCB3aGVuIHVuZGVmaW5lZC9lbXB0eVxuICAgICAgYXNzZXJ0Lm9rKCFyYXcuaW5jbHVkZXMoXCJkZXBlbmRzX29uXCIpKTtcbiAgICAgIGFzc2VydC5vayghcmF3LmluY2x1ZGVzKFwicGFyZW50X3N0ZXBfaWRcIikpO1xuICAgICAgYXNzZXJ0Lm9rKCFyYXcuaW5jbHVkZXMoXCJzdGFydGVkX2F0XCIpKTtcbiAgICAgIGFzc2VydC5vayghcmF3LmluY2x1ZGVzKFwiZmluaXNoZWRfYXRcIikpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwRGlyKGRpcik7XG4gICAgfVxuICB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRWRnZSBjYXNlcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJlZGdlIGNhc2VzXCIsICgpID0+IHtcbiAgaXQoXCJoYW5kbGVzIGVtcHR5IGl0ZW1zIGFycmF5IGluIGV4cGFuZEl0ZXJhdGlvblwiLCAodCkgPT4ge1xuICAgIGNvbnN0IGdyYXBoID0gbWFrZUdyYXBoKFtcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwiaXRlclwiIH0pLFxuICAgIF0pO1xuXG4gICAgY29uc3QgZXhwYW5kZWQgPSBleHBhbmRJdGVyYXRpb24oZ3JhcGgsIFwiaXRlclwiLCBbXSwgXCJ7e2l0ZW19fVwiKTtcbiAgICAvLyBQYXJlbnQgbWFya2VkIGV4cGFuZGVkLCBubyBpbnN0YW5jZXMgY3JlYXRlZFxuICAgIGFzc2VydC5lcXVhbChleHBhbmRlZC5zdGVwcy5sZW5ndGgsIDEpO1xuICAgIGFzc2VydC5lcXVhbChleHBhbmRlZC5zdGVwc1swXS5zdGF0dXMsIFwiZXhwYW5kZWRcIik7XG4gIH0pO1xuXG4gIGl0KFwiaGFuZGxlcyBncmFwaCB3aXRoIHNpbmdsZSBzdGVwXCIsICh0KSA9PiB7XG4gICAgY29uc3QgZ3JhcGggPSBtYWtlR3JhcGgoW21ha2VTdGVwKHsgaWQ6IFwib25seVwiIH0pXSk7XG4gICAgY29uc3QgbmV4dCA9IGdldE5leHRQZW5kaW5nU3RlcChncmFwaCk7XG4gICAgYXNzZXJ0LmVxdWFsKG5leHQ/LmlkLCBcIm9ubHlcIik7XG5cbiAgICBjb25zdCBjb21wbGV0ZWQgPSBtYXJrU3RlcENvbXBsZXRlKGdyYXBoLCBcIm9ubHlcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGdldE5leHRQZW5kaW5nU3RlcChjb21wbGV0ZWQpLCBudWxsKTtcbiAgfSk7XG5cbiAgaXQoXCJpbml0aWFsaXplR3JhcGggaGFuZGxlcyBzdGVwcyB3aXRoIGVtcHR5IHJlcXVpcmVzXCIsICh0KSA9PiB7XG4gICAgY29uc3QgZGVmOiBXb3JrZmxvd0RlZmluaXRpb24gPSB7XG4gICAgICB2ZXJzaW9uOiAxLFxuICAgICAgbmFtZTogXCJlbXB0eS1yZXF1aXJlc1wiLFxuICAgICAgc3RlcHM6IFtcbiAgICAgICAgeyBpZDogXCJzMVwiLCBuYW1lOiBcIlN0ZXBcIiwgcHJvbXB0OiBcIkdvXCIsIHJlcXVpcmVzOiBbXSwgcHJvZHVjZXM6IFtdIH0sXG4gICAgICBdLFxuICAgIH07XG4gICAgY29uc3QgZ3JhcGggPSBpbml0aWFsaXplR3JhcGgoZGVmKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGdyYXBoLnN0ZXBzWzBdLmRlcGVu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QU0sTUFBTSxhQUFhLEtBQUssS0FBSyxZQUFZLEdBQUcsT0FBTztBQUd6RCxhQUFPLEdBQUcsQ0FBQyxJQUFJLFNBQVMsWUFBWSxDQUFDO0FBQ3JDLGFBQU8sR0FBRyxDQUFDLElBQUksU0FBUyxnQkFBZ0IsQ0FBQztBQUN6QyxhQUFPLEdBQUcsQ0FBQyxJQUFJLFNBQVMsWUFBWSxDQUFDO0FBQ3JDLGFBQU8sR0FBRyxDQUFDLElBQUksU0FBUyxhQUFhLENBQUM7QUFBQSxJQUN4QyxVQUFFO0FBQ0EsaUJBQVcsR0FBRztBQUFBLElBQ2hCO0FBQUEsRUFDRixDQUFDO0FBQ0gsQ0FBQztBQUlELFNBQVMsY0FBYyxNQUFNO0FBQzNCLEtBQUcsZ0RBQWdELENBQUMsTUFBTTtBQUN4RCxVQUFNLFFBQVEsVUFBVTtBQUFBLE1BQ3RCLFNBQVMsRUFBRSxJQUFJLE9BQU8sQ0FBQztBQUFBLElBQ3pCLENBQUM7QUFFRCxVQUFNLFdBQVcsZ0JBQWdCLE9BQU8sUUFBUSxDQUFDLEdBQUcsVUFBVTtBQUU5RCxXQUFPLE1BQU0sU0FBUyxNQUFNLFFBQVEsQ0FBQztBQUNyQyxXQUFPLE1BQU0sU0FBUyxNQUFNLENBQUMsRUFBRSxRQUFRLFVBQVU7QUFBQSxFQUNuRCxDQUFDO0FBRUQsS0FBRyxrQ0FBa0MsQ0FBQyxNQUFNO0FBQzFDLFVBQU0sUUFBUSxVQUFVLENBQUMsU0FBUyxFQUFFLElBQUksT0FBTyxDQUFDLENBQUMsQ0FBQztBQUNsRCxVQUFNLE9BQU8sbUJBQW1CLEtBQUs7QUFDckMsV0FBTyxNQUFNLE1BQU0sSUFBSSxNQUFNO0FBRTdCLFVBQU0sWUFBWSxpQkFBaUIsT0FBTyxNQUFNO0FBQ2hELFdBQU8sTUFBTSxtQkFBbUIsU0FBUyxHQUFHLElBQUk7QUFBQSxFQUNsRCxDQUFDO0FBRUQsS0FBRyxxREFBcUQsQ0FBQyxNQUFNO0FBQzdELFVBQU0sTUFBMEI7QUFBQSxNQUM5QixTQUFTO0FBQUEsTUFDVCxNQUFNO0FBQUEsTUFDTixPQUFPO0FBQUEsUUFDTCxFQUFFLElBQUksTUFBTSxNQUFNLFFBQVEsUUFBUSxNQUFNLFVBQVUsQ0FBQyxHQUFHLFVBQVUsQ0FBQyxFQUFFO0FBQUEsTUFDckU7QUFBQSxJQUNGO0FBQ0EsVUFBTSxRQUFRLGdCQUFnQixHQUFHO0FBQ2pDLFdBQU8sZ0JBQWdCLE1BQU0sTUFBTSxDQUFDLEVBQUUsV0FBVyxDQUFDLENBQUM7QUFBQSxFQUNyRCxDQUFDO0FBQ0gsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
