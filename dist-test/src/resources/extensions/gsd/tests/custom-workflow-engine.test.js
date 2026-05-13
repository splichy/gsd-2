import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CustomWorkflowEngine } from "../custom-workflow-engine.js";
import { CustomExecutionPolicy } from "../custom-execution-policy.js";
import { writeGraph, readGraph } from "../graph.js";
import { stringify } from "yaml";
const tmpDirs = [];
function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), "engine-test-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
    }
  }
  tmpDirs.length = 0;
});
function makeStep(overrides) {
  return {
    title: overrides.id,
    status: "pending",
    prompt: `Do ${overrides.id}`,
    dependsOn: [],
    ...overrides
  };
}
function makeGraph(steps, name = "test-wf") {
  return {
    steps,
    metadata: { name, createdAt: "2026-01-01T00:00:00.000Z" }
  };
}
function setupEngine(steps, name = "test-wf") {
  const runDir = makeTmpDir();
  const graph = makeGraph(steps, name);
  writeGraph(runDir, graph);
  const def = {
    version: 1,
    name,
    steps: steps.map((s) => ({
      id: s.id,
      name: s.title,
      prompt: s.prompt,
      requires: s.dependsOn,
      produces: []
    }))
  };
  writeFileSync(join(runDir, "DEFINITION.yaml"), stringify(def), "utf-8");
  return { engine: new CustomWorkflowEngine(runDir), runDir };
}
describe("CustomWorkflowEngine.deriveState", () => {
  it("returns running phase when steps are pending", async () => {
    const { engine } = setupEngine([
      makeStep({ id: "a" }),
      makeStep({ id: "b", dependsOn: ["a"] })
    ]);
    const state = await engine.deriveState("/unused");
    assert.equal(state.phase, "running");
    assert.equal(state.isComplete, false);
    assert.ok(state.raw, "raw should contain the graph");
  });
  it("returns complete phase when all steps are complete", async () => {
    const { engine } = setupEngine([
      makeStep({ id: "a", status: "complete" }),
      makeStep({ id: "b", status: "complete" })
    ]);
    const state = await engine.deriveState("/unused");
    assert.equal(state.phase, "complete");
    assert.equal(state.isComplete, true);
  });
  it("treats expanded steps as done for completion check", async () => {
    const { engine } = setupEngine([
      makeStep({ id: "a", status: "expanded" }),
      makeStep({ id: "a--001", status: "complete", parentStepId: "a" }),
      makeStep({ id: "b", status: "complete" })
    ]);
    const state = await engine.deriveState("/unused");
    assert.equal(state.phase, "complete");
    assert.equal(state.isComplete, true);
  });
});
describe("CustomWorkflowEngine.resolveDispatch", () => {
  it("returns dispatch for first pending step", async () => {
    const { engine } = setupEngine([
      makeStep({ id: "step-1", prompt: "Do the first thing" }),
      makeStep({ id: "step-2", dependsOn: ["step-1"] })
    ], "my-workflow");
    const state = await engine.deriveState("/unused");
    const dispatch = await engine.resolveDispatch(state, { basePath: "/unused" });
    assert.equal(dispatch.action, "dispatch");
    if (dispatch.action === "dispatch") {
      assert.equal(dispatch.step.unitType, "custom-step");
      assert.equal(dispatch.step.unitId, "my-workflow/step-1");
      assert.equal(dispatch.step.prompt, "Do the first thing");
    }
  });
  it("persists the dispatched step as active in GRAPH.yaml before returning", async () => {
    const { engine, runDir } = setupEngine([
      makeStep({ id: "step-1", prompt: "Do the first thing" }),
      makeStep({ id: "step-2", dependsOn: ["step-1"] })
    ], "my-workflow");
    const state = await engine.deriveState("/unused");
    const dispatch = await engine.resolveDispatch(state, { basePath: "/unused" });
    assert.equal(dispatch.action, "dispatch");
    const graph = readGraph(runDir);
    assert.equal(graph.steps[0].status, "active");
    assert.ok(graph.steps[0].startedAt, "startedAt should be persisted before dispatch returns");
    assert.equal(graph.steps[1].status, "pending");
  });
  it("reuses an already active step on a subsequent dispatch before reconcile", async () => {
    const { engine } = setupEngine([
      makeStep({ id: "step-1", prompt: "Do the first thing" }),
      makeStep({ id: "step-2", dependsOn: ["step-1"] })
    ], "my-workflow");
    let state = await engine.deriveState("/unused");
    const firstDispatch = await engine.resolveDispatch(state, { basePath: "/unused" });
    assert.equal(firstDispatch.action, "dispatch");
    if (firstDispatch.action === "dispatch") {
      assert.equal(firstDispatch.step.unitId, "my-workflow/step-1");
    }
    state = await engine.deriveState("/unused");
    const secondDispatch = await engine.resolveDispatch(state, { basePath: "/unused" });
    assert.equal(secondDispatch.action, "dispatch");
    if (secondDispatch.action === "dispatch") {
      assert.equal(secondDispatch.step.unitId, "my-workflow/step-1");
      assert.equal(secondDispatch.step.prompt, "Do the first thing");
    }
  });
  it("returns stop when all steps are complete", async () => {
    const { engine } = setupEngine([
      makeStep({ id: "a", status: "complete" }),
      makeStep({ id: "b", status: "complete" })
    ]);
    const state = await engine.deriveState("/unused");
    const dispatch = await engine.resolveDispatch(state, { basePath: "/unused" });
    assert.equal(dispatch.action, "stop");
    if (dispatch.action === "stop") {
      assert.equal(dispatch.reason, "All steps complete");
      assert.equal(dispatch.level, "info");
    }
  });
  it("returns stop with dependency details when pending steps are blocked", async () => {
    const { engine } = setupEngine([
      makeStep({ id: "a", dependsOn: ["b"] }),
      makeStep({ id: "b", dependsOn: ["a"] })
    ]);
    const state = await engine.deriveState("/unused");
    const dispatch = await engine.resolveDispatch(state, { basePath: "/unused" });
    assert.equal(dispatch.action, "stop");
    if (dispatch.action === "stop") {
      assert.equal(dispatch.level, "error");
      assert.match(dispatch.reason, /Workflow blocked/);
      assert.match(dispatch.reason, /a waiting on b \(pending\)/);
      assert.match(dispatch.reason, /b waiting on a \(pending\)/);
    }
  });
  it("reports missing dependencies when no pending step can run", async () => {
    const { engine } = setupEngine([
      makeStep({ id: "a", dependsOn: ["missing-step"] })
    ]);
    const state = await engine.deriveState("/unused");
    const dispatch = await engine.resolveDispatch(state, { basePath: "/unused" });
    assert.equal(dispatch.action, "stop");
    if (dispatch.action === "stop") {
      assert.equal(dispatch.level, "error");
      assert.match(dispatch.reason, /a waiting on missing-step \(missing\)/);
    }
  });
  it("does not report expanded dependencies as blockers", async () => {
    const { engine } = setupEngine([
      makeStep({ id: "iter", status: "expanded" }),
      makeStep({ id: "after", dependsOn: ["iter", "missing-step"] })
    ]);
    const state = await engine.deriveState("/unused");
    const dispatch = await engine.resolveDispatch(state, { basePath: "/unused" });
    assert.equal(dispatch.action, "stop");
    if (dispatch.action === "stop") {
      assert.equal(dispatch.level, "error");
      assert.match(dispatch.reason, /after waiting on missing-step \(missing\)/);
      assert.doesNotMatch(dispatch.reason, /iter \(expanded\)/);
    }
  });
  it("respects dependency ordering", async () => {
    const { engine } = setupEngine([
      makeStep({ id: "a" }),
      makeStep({ id: "b", dependsOn: ["a"] }),
      makeStep({ id: "c", dependsOn: ["b"] })
    ], "dep-wf");
    const state = await engine.deriveState("/unused");
    const dispatch = await engine.resolveDispatch(state, { basePath: "/unused" });
    assert.equal(dispatch.action, "dispatch");
    if (dispatch.action === "dispatch") {
      assert.equal(dispatch.step.unitId, "dep-wf/a");
    }
  });
  it("picks next eligible step when earlier deps are complete", async () => {
    const { engine } = setupEngine([
      makeStep({ id: "a", status: "complete" }),
      makeStep({ id: "b", dependsOn: ["a"] }),
      makeStep({ id: "c", dependsOn: ["b"] })
    ], "dep-wf");
    const state = await engine.deriveState("/unused");
    const dispatch = await engine.resolveDispatch(state, { basePath: "/unused" });
    assert.equal(dispatch.action, "dispatch");
    if (dispatch.action === "dispatch") {
      assert.equal(dispatch.step.unitId, "dep-wf/b");
    }
  });
});
describe("CustomWorkflowEngine.reconcile", () => {
  it("marks step complete in GRAPH.yaml on disk", async () => {
    const { engine, runDir } = setupEngine([
      makeStep({ id: "step-1" }),
      makeStep({ id: "step-2", dependsOn: ["step-1"] })
    ], "wf");
    const state = await engine.deriveState("/unused");
    const result = await engine.reconcile(state, {
      unitType: "custom-step",
      unitId: "wf/step-1",
      startedAt: Date.now() - 1e3,
      finishedAt: Date.now()
    });
    assert.equal(result.outcome, "continue");
    const graph = readGraph(runDir);
    assert.equal(graph.steps[0].status, "complete");
    assert.ok(graph.steps[0].finishedAt, "finishedAt should be set");
    assert.equal(graph.steps[1].status, "pending");
  });
  it("returns milestone-complete when all steps done", async () => {
    const { engine } = setupEngine([
      makeStep({ id: "only-step" })
    ], "wf");
    const state = await engine.deriveState("/unused");
    const result = await engine.reconcile(state, {
      unitType: "custom-step",
      unitId: "wf/only-step",
      startedAt: Date.now() - 1e3,
      finishedAt: Date.now()
    });
    assert.equal(result.outcome, "milestone-complete");
  });
  it("handles multi-segment unitId correctly", async () => {
    const { engine, runDir } = setupEngine([
      makeStep({ id: "deep-step" })
    ], "nested/workflow");
    const state = await engine.deriveState("/unused");
    const result = await engine.reconcile(state, {
      unitType: "custom-step",
      unitId: "nested/workflow/deep-step",
      startedAt: Date.now() - 1e3,
      finishedAt: Date.now()
    });
    assert.equal(result.outcome, "milestone-complete");
    const graph = readGraph(runDir);
    assert.equal(graph.steps[0].status, "complete");
  });
  it("re-reads GRAPH.yaml before reconcile so concurrent edits are preserved", async () => {
    const { engine, runDir } = setupEngine([
      makeStep({ id: "step-1" }),
      makeStep({ id: "step-2", dependsOn: ["step-1"] })
    ], "wf");
    const staleState = await engine.deriveState("/unused");
    writeGraph(runDir, makeGraph([
      makeStep({ id: "step-1" }),
      makeStep({ id: "step-2", dependsOn: ["step-1"] }),
      makeStep({ id: "step-3", dependsOn: ["step-2"] })
    ], "wf"));
    const result = await engine.reconcile(staleState, {
      unitType: "custom-step",
      unitId: "wf/step-1",
      startedAt: Date.now() - 1e3,
      finishedAt: Date.now()
    });
    assert.equal(result.outcome, "continue");
    const graph = readGraph(runDir);
    assert.equal(graph.steps.length, 3, "reconcile should preserve the concurrent graph edit");
    assert.equal(graph.steps[0].status, "complete");
    assert.equal(graph.steps[1].status, "pending");
    assert.equal(graph.steps[2].status, "pending");
  });
  it("reconcile completes a step that was previously persisted as active", async () => {
    const { engine, runDir } = setupEngine([
      makeStep({ id: "step-1", prompt: "Do the first thing" }),
      makeStep({ id: "step-2", dependsOn: ["step-1"] })
    ], "wf");
    const state = await engine.deriveState("/unused");
    const dispatch = await engine.resolveDispatch(state, { basePath: "/unused" });
    assert.equal(dispatch.action, "dispatch");
    const activeState = await engine.deriveState("/unused");
    const result = await engine.reconcile(activeState, {
      unitType: "custom-step",
      unitId: "wf/step-1",
      startedAt: Date.now() - 1e3,
      finishedAt: Date.now()
    });
    assert.equal(result.outcome, "continue");
    const graph = readGraph(runDir);
    assert.equal(graph.steps[0].status, "complete");
    assert.ok(graph.steps[0].startedAt, "startedAt should survive reconcile");
    assert.ok(graph.steps[0].finishedAt, "finishedAt should be persisted on completion");
  });
});
describe("CustomWorkflowEngine.getDisplayMetadata", () => {
  it("returns correct progress summary", async () => {
    const { engine } = setupEngine([
      makeStep({ id: "a", status: "complete" }),
      makeStep({ id: "b" }),
      makeStep({ id: "c" })
    ]);
    const state = await engine.deriveState("/unused");
    const meta = engine.getDisplayMetadata(state);
    assert.equal(meta.engineLabel, "WORKFLOW");
    assert.equal(meta.currentPhase, "running");
    assert.equal(meta.progressSummary, "Step 1/3");
    assert.deepStrictEqual(meta.stepCount, { completed: 1, total: 3 });
  });
  it("shows 0/N when no steps complete", async () => {
    const { engine } = setupEngine([
      makeStep({ id: "a" }),
      makeStep({ id: "b" })
    ]);
    const state = await engine.deriveState("/unused");
    const meta = engine.getDisplayMetadata(state);
    assert.equal(meta.progressSummary, "Step 0/2");
  });
  it("shows N/N when all steps complete", async () => {
    const { engine } = setupEngine([
      makeStep({ id: "a", status: "complete" }),
      makeStep({ id: "b", status: "complete" })
    ]);
    const state = await engine.deriveState("/unused");
    const meta = engine.getDisplayMetadata(state);
    assert.equal(meta.progressSummary, "Step 2/2");
    assert.equal(meta.currentPhase, "complete");
  });
});
describe("CustomExecutionPolicy", () => {
  it("verify returns continue", async () => {
    const runDir = makeTmpDir();
    writeFileSync(join(runDir, "DEFINITION.yaml"), stringify({
      version: 1,
      name: "wf",
      description: "test",
      steps: [{ id: "step-1", name: "Step 1", prompt: "do it", produces: "step-1/output.md" }]
    }));
    const policy = new CustomExecutionPolicy(runDir);
    const result = await policy.verify("custom-step", "wf/step-1", { basePath: runDir });
    assert.equal(result, "continue");
  });
  it("selectModel returns null", async () => {
    const policy = new CustomExecutionPolicy("/tmp/run");
    const result = await policy.selectModel("custom-step", "wf/step-1", { basePath: "/tmp" });
    assert.equal(result, null);
  });
  it("recover returns retry", async () => {
    const policy = new CustomExecutionPolicy("/tmp/run");
    const result = await policy.recover("custom-step", "wf/step-1", { basePath: "/tmp" });
    assert.deepStrictEqual(result, { outcome: "retry", reason: "Default retry" });
  });
  it("closeout returns no artifacts", async () => {
    const policy = new CustomExecutionPolicy("/tmp/run");
    const result = await policy.closeout("custom-step", "wf/step-1", {
      basePath: "/tmp",
      startedAt: Date.now()
    });
    assert.deepStrictEqual(result, { committed: false, artifacts: [] });
  });
  it("prepareWorkspace resolves without error", async () => {
    const policy = new CustomExecutionPolicy("/tmp/run");
    await policy.prepareWorkspace("/tmp", "M001");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9jdXN0b20td29ya2Zsb3ctZW5naW5lLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogY3VzdG9tLXdvcmtmbG93LWVuZ2luZS50ZXN0LnRzIFx1MjAxNCBUZXN0cyBmb3IgQ3VzdG9tV29ya2Zsb3dFbmdpbmUgYW5kIEN1c3RvbUV4ZWN1dGlvblBvbGljeS5cbiAqXG4gKiBVc2VzIHJlYWwgdGVtcCBkaXJlY3RvcmllcyB3aXRoIGFjdHVhbCBHUkFQSC55YW1sIGZpbGVzIFx1MjAxNCBubyBtb2Nrcy5cbiAqIFRlc3RzIHRoZSBmdWxsIGVuZ2luZSBsaWZlY3ljbGU6IGRlcml2ZVN0YXRlIFx1MjE5MiByZXNvbHZlRGlzcGF0Y2ggXHUyMTkyIHJlY29uY2lsZS5cbiAqL1xuXG5pbXBvcnQgeyBkZXNjcmliZSwgaXQsIGFmdGVyRWFjaCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIHJtU3luYywgcmVhZEZpbGVTeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgcGFyc2UgfSBmcm9tIFwieWFtbFwiO1xuXG5pbXBvcnQgeyBDdXN0b21Xb3JrZmxvd0VuZ2luZSB9IGZyb20gXCIuLi9jdXN0b20td29ya2Zsb3ctZW5naW5lLnRzXCI7XG5pbXBvcnQgeyBDdXN0b21FeGVjdXRpb25Qb2xpY3kgfSBmcm9tIFwiLi4vY3VzdG9tLWV4ZWN1dGlvbi1wb2xpY3kudHNcIjtcbmltcG9ydCB7IHdyaXRlR3JhcGgsIHJlYWRHcmFwaCwgdHlwZSBXb3JrZmxvd0dyYXBoLCB0eXBlIEdyYXBoU3RlcCB9IGZyb20gXCIuLi9ncmFwaC50c1wiO1xuaW1wb3J0IHsgc3RyaW5naWZ5IH0gZnJvbSBcInlhbWxcIjtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEhlbHBlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmNvbnN0IHRtcERpcnM6IHN0cmluZ1tdID0gW107XG5cbmZ1bmN0aW9uIG1ha2VUbXBEaXIoKTogc3RyaW5nIHtcbiAgY29uc3QgZGlyID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJlbmdpbmUtdGVzdC1cIikpO1xuICB0bXBEaXJzLnB1c2goZGlyKTtcbiAgcmV0dXJuIGRpcjtcbn1cblxuYWZ0ZXJFYWNoKCgpID0+IHtcbiAgZm9yIChjb25zdCBkIG9mIHRtcERpcnMpIHtcbiAgICB0cnkgeyBybVN5bmMoZCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlLCBtYXhSZXRyaWVzOiAzLCByZXRyeURlbGF5OiAxMDAgfSk7IH0gY2F0Y2ggeyAvKiBXaW5kb3dzIEVQRVJNICovIH1cbiAgfVxuICB0bXBEaXJzLmxlbmd0aCA9IDA7XG59KTtcblxuZnVuY3Rpb24gbWFrZVN0ZXAob3ZlcnJpZGVzOiBQYXJ0aWFsPEdyYXBoU3RlcD4gJiB7IGlkOiBzdHJpbmcgfSk6IEdyYXBoU3RlcCB7XG4gIHJldHVybiB7XG4gICAgdGl0bGU6IG92ZXJyaWRlcy5pZCxcbiAgICBzdGF0dXM6IFwicGVuZGluZ1wiLFxuICAgIHByb21wdDogYERvICR7b3ZlcnJpZGVzLmlkfWAsXG4gICAgZGVwZW5kc09uOiBbXSxcbiAgICAuLi5vdmVycmlkZXMsXG4gIH07XG59XG5cbmZ1bmN0aW9uIG1ha2VHcmFwaChzdGVwczogR3JhcGhTdGVwW10sIG5hbWUgPSBcInRlc3Qtd2ZcIik6IFdvcmtmbG93R3JhcGgge1xuICByZXR1cm4ge1xuICAgIHN0ZXBzLFxuICAgIG1ldGFkYXRhOiB7IG5hbWUsIGNyZWF0ZWRBdDogXCIyMDI2LTAxLTAxVDAwOjAwOjAwLjAwMFpcIiB9LFxuICB9O1xufVxuXG4vKiogV3JpdGUgYSBncmFwaCB0byBhIHRlbXAgZGlyIGFuZCByZXR1cm4gZW5naW5lICsgZGlyLiBBbHNvIHdyaXRlcyBhIG1pbmltYWwgREVGSU5JVElPTi55YW1sIHNvIHJlc29sdmVEaXNwYXRjaC9pbmplY3RDb250ZXh0IGNhbiByZWFkIGl0LiAqL1xuZnVuY3Rpb24gc2V0dXBFbmdpbmUoXG4gIHN0ZXBzOiBHcmFwaFN0ZXBbXSxcbiAgbmFtZSA9IFwidGVzdC13ZlwiLFxuKTogeyBlbmdpbmU6IEN1c3RvbVdvcmtmbG93RW5naW5lOyBydW5EaXI6IHN0cmluZyB9IHtcbiAgY29uc3QgcnVuRGlyID0gbWFrZVRtcERpcigpO1xuICBjb25zdCBncmFwaCA9IG1ha2VHcmFwaChzdGVwcywgbmFtZSk7XG4gIHdyaXRlR3JhcGgocnVuRGlyLCBncmFwaCk7XG5cbiAgLy8gV3JpdGUgYSBtaW5pbWFsIERFRklOSVRJT04ueWFtbCBtYXRjaGluZyB0aGUgZ3JhcGggc3RlcHNcbiAgY29uc3QgZGVmID0ge1xuICAgIHZlcnNpb246IDEsXG4gICAgbmFtZSxcbiAgICBzdGVwczogc3RlcHMubWFwKChzKSA9PiAoe1xuICAgICAgaWQ6IHMuaWQsXG4gICAgICBuYW1lOiBzLnRpdGxlLFxuICAgICAgcHJvbXB0OiBzLnByb21wdCxcbiAgICAgIHJlcXVpcmVzOiBzLmRlcGVuZHNPbixcbiAgICAgIHByb2R1Y2VzOiBbXSxcbiAgICB9KSksXG4gIH07XG4gIHdyaXRlRmlsZVN5bmMoam9pbihydW5EaXIsIFwiREVGSU5JVElPTi55YW1sXCIpLCBzdHJpbmdpZnkoZGVmKSwgXCJ1dGYtOFwiKTtcblxuICByZXR1cm4geyBlbmdpbmU6IG5ldyBDdXN0b21Xb3JrZmxvd0VuZ2luZShydW5EaXIpLCBydW5EaXIgfTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGRlcml2ZVN0YXRlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcIkN1c3RvbVdvcmtmbG93RW5naW5lLmRlcml2ZVN0YXRlXCIsICgpID0+IHtcbiAgaXQoXCJyZXR1cm5zIHJ1bm5pbmcgcGhhc2Ugd2hlbiBzdGVwcyBhcmUgcGVuZGluZ1wiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyBlbmdpbmUgfSA9IHNldHVwRW5naW5lKFtcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwiYVwiIH0pLFxuICAgICAgbWFrZVN0ZXAoeyBpZDogXCJiXCIsIGRlcGVuZHNPbjogW1wiYVwiXSB9KSxcbiAgICBdKTtcblxuICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZW5naW5lLmRlcml2ZVN0YXRlKFwiL3VudXNlZFwiKTtcblxuICAgIGFzc2VydC5lcXVhbChzdGF0ZS5waGFzZSwgXCJydW5uaW5nXCIpO1xuICAgIGFzc2VydC5lcXVhbChzdGF0ZS5pc0NvbXBsZXRlLCBmYWxzZSk7XG4gICAgYXNzZXJ0Lm9rKHN0YXRlLnJhdywgXCJyYXcgc2hvdWxkIGNvbnRhaW4gdGhlIGdyYXBoXCIpO1xuICB9KTtcblxuICBpdChcInJldHVybnMgY29tcGxldGUgcGhhc2Ugd2hlbiBhbGwgc3RlcHMgYXJlIGNvbXBsZXRlXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB7IGVuZ2luZSB9ID0gc2V0dXBFbmdpbmUoW1xuICAgICAgbWFrZVN0ZXAoeyBpZDogXCJhXCIsIHN0YXR1czogXCJjb21wbGV0ZVwiIH0pLFxuICAgICAgbWFrZVN0ZXAoeyBpZDogXCJiXCIsIHN0YXR1czogXCJjb21wbGV0ZVwiIH0pLFxuICAgIF0pO1xuXG4gICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBlbmdpbmUuZGVyaXZlU3RhdGUoXCIvdW51c2VkXCIpO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHN0YXRlLnBoYXNlLCBcImNvbXBsZXRlXCIpO1xuICAgIGFzc2VydC5lcXVhbChzdGF0ZS5pc0NvbXBsZXRlLCB0cnVlKTtcbiAgfSk7XG5cbiAgaXQoXCJ0cmVhdHMgZXhwYW5kZWQgc3RlcHMgYXMgZG9uZSBmb3IgY29tcGxldGlvbiBjaGVja1wiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyBlbmdpbmUgfSA9IHNldHVwRW5naW5lKFtcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwiYVwiLCBzdGF0dXM6IFwiZXhwYW5kZWRcIiB9KSxcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwiYS0tMDAxXCIsIHN0YXR1czogXCJjb21wbGV0ZVwiLCBwYXJlbnRTdGVwSWQ6IFwiYVwiIH0pLFxuICAgICAgbWFrZVN0ZXAoeyBpZDogXCJiXCIsIHN0YXR1czogXCJjb21wbGV0ZVwiIH0pLFxuICAgIF0pO1xuXG4gICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBlbmdpbmUuZGVyaXZlU3RhdGUoXCIvdW51c2VkXCIpO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHN0YXRlLnBoYXNlLCBcImNvbXBsZXRlXCIpO1xuICAgIGFzc2VydC5lcXVhbChzdGF0ZS5pc0NvbXBsZXRlLCB0cnVlKTtcbiAgfSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHJlc29sdmVEaXNwYXRjaCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJDdXN0b21Xb3JrZmxvd0VuZ2luZS5yZXNvbHZlRGlzcGF0Y2hcIiwgKCkgPT4ge1xuICBpdChcInJldHVybnMgZGlzcGF0Y2ggZm9yIGZpcnN0IHBlbmRpbmcgc3RlcFwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyBlbmdpbmUgfSA9IHNldHVwRW5naW5lKFtcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwic3RlcC0xXCIsIHByb21wdDogXCJEbyB0aGUgZmlyc3QgdGhpbmdcIiB9KSxcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwic3RlcC0yXCIsIGRlcGVuZHNPbjogW1wic3RlcC0xXCJdIH0pLFxuICAgIF0sIFwibXktd29ya2Zsb3dcIik7XG5cbiAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGVuZ2luZS5kZXJpdmVTdGF0ZShcIi91bnVzZWRcIik7XG4gICAgY29uc3QgZGlzcGF0Y2ggPSBhd2FpdCBlbmdpbmUucmVzb2x2ZURpc3BhdGNoKHN0YXRlLCB7IGJhc2VQYXRoOiBcIi91bnVzZWRcIiB9KTtcblxuICAgIGFzc2VydC5lcXVhbChkaXNwYXRjaC5hY3Rpb24sIFwiZGlzcGF0Y2hcIik7XG4gICAgaWYgKGRpc3BhdGNoLmFjdGlvbiA9PT0gXCJkaXNwYXRjaFwiKSB7XG4gICAgICBhc3NlcnQuZXF1YWwoZGlzcGF0Y2guc3RlcC51bml0VHlwZSwgXCJjdXN0b20tc3RlcFwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChkaXNwYXRjaC5zdGVwLnVuaXRJZCwgXCJteS13b3JrZmxvdy9zdGVwLTFcIik7XG4gICAgICBhc3NlcnQuZXF1YWwoZGlzcGF0Y2guc3RlcC5wcm9tcHQsIFwiRG8gdGhlIGZpcnN0IHRoaW5nXCIpO1xuICAgIH1cbiAgfSk7XG5cbiAgaXQoXCJwZXJzaXN0cyB0aGUgZGlzcGF0Y2hlZCBzdGVwIGFzIGFjdGl2ZSBpbiBHUkFQSC55YW1sIGJlZm9yZSByZXR1cm5pbmdcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHsgZW5naW5lLCBydW5EaXIgfSA9IHNldHVwRW5naW5lKFtcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwic3RlcC0xXCIsIHByb21wdDogXCJEbyB0aGUgZmlyc3QgdGhpbmdcIiB9KSxcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwic3RlcC0yXCIsIGRlcGVuZHNPbjogW1wic3RlcC0xXCJdIH0pLFxuICAgIF0sIFwibXktd29ya2Zsb3dcIik7XG5cbiAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGVuZ2luZS5kZXJpdmVTdGF0ZShcIi91bnVzZWRcIik7XG4gICAgY29uc3QgZGlzcGF0Y2ggPSBhd2FpdCBlbmdpbmUucmVzb2x2ZURpc3BhdGNoKHN0YXRlLCB7IGJhc2VQYXRoOiBcIi91bnVzZWRcIiB9KTtcblxuICAgIGFzc2VydC5lcXVhbChkaXNwYXRjaC5hY3Rpb24sIFwiZGlzcGF0Y2hcIik7XG4gICAgY29uc3QgZ3JhcGggPSByZWFkR3JhcGgocnVuRGlyKTtcbiAgICBhc3NlcnQuZXF1YWwoZ3JhcGguc3RlcHNbMF0uc3RhdHVzLCBcImFjdGl2ZVwiKTtcbiAgICBhc3NlcnQub2soZ3JhcGguc3RlcHNbMF0uc3RhcnRlZEF0LCBcInN0YXJ0ZWRBdCBzaG91bGQgYmUgcGVyc2lzdGVkIGJlZm9yZSBkaXNwYXRjaCByZXR1cm5zXCIpO1xuICAgIGFzc2VydC5lcXVhbChncmFwaC5zdGVwc1sxXS5zdGF0dXMsIFwicGVuZGluZ1wiKTtcbiAgfSk7XG5cbiAgaXQoXCJyZXVzZXMgYW4gYWxyZWFkeSBhY3RpdmUgc3RlcCBvbiBhIHN1YnNlcXVlbnQgZGlzcGF0Y2ggYmVmb3JlIHJlY29uY2lsZVwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyBlbmdpbmUgfSA9IHNldHVwRW5naW5lKFtcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwic3RlcC0xXCIsIHByb21wdDogXCJEbyB0aGUgZmlyc3QgdGhpbmdcIiB9KSxcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwic3RlcC0yXCIsIGRlcGVuZHNPbjogW1wic3RlcC0xXCJdIH0pLFxuICAgIF0sIFwibXktd29ya2Zsb3dcIik7XG5cbiAgICBsZXQgc3RhdGUgPSBhd2FpdCBlbmdpbmUuZGVyaXZlU3RhdGUoXCIvdW51c2VkXCIpO1xuICAgIGNvbnN0IGZpcnN0RGlzcGF0Y2ggPSBhd2FpdCBlbmdpbmUucmVzb2x2ZURpc3BhdGNoKHN0YXRlLCB7IGJhc2VQYXRoOiBcIi91bnVzZWRcIiB9KTtcbiAgICBhc3NlcnQuZXF1YWwoZmlyc3REaXNwYXRjaC5hY3Rpb24sIFwiZGlzcGF0Y2hcIik7XG4gICAgaWYgKGZpcnN0RGlzcGF0Y2guYWN0aW9uID09PSBcImRpc3BhdGNoXCIpIHtcbiAgICAgIGFzc2VydC5lcXVhbChmaXJzdERpc3BhdGNoLnN0ZXAudW5pdElkLCBcIm15LXdvcmtmbG93L3N0ZXAtMVwiKTtcbiAgICB9XG5cbiAgICBzdGF0ZSA9IGF3YWl0IGVuZ2luZS5kZXJpdmVTdGF0ZShcIi91bnVzZWRcIik7XG4gICAgY29uc3Qgc2Vjb25kRGlzcGF0Y2ggPSBhd2FpdCBlbmdpbmUucmVzb2x2ZURpc3BhdGNoKHN0YXRlLCB7IGJhc2VQYXRoOiBcIi91bnVzZWRcIiB9KTtcbiAgICBhc3NlcnQuZXF1YWwoc2Vjb25kRGlzcGF0Y2guYWN0aW9uLCBcImRpc3BhdGNoXCIpO1xuICAgIGlmIChzZWNvbmREaXNwYXRjaC5hY3Rpb24gPT09IFwiZGlzcGF0Y2hcIikge1xuICAgICAgYXNzZXJ0LmVxdWFsKHNlY29uZERpc3BhdGNoLnN0ZXAudW5pdElkLCBcIm15LXdvcmtmbG93L3N0ZXAtMVwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChzZWNvbmREaXNwYXRjaC5zdGVwLnByb21wdCwgXCJEbyB0aGUgZmlyc3QgdGhpbmdcIik7XG4gICAgfVxuICB9KTtcblxuICBpdChcInJldHVybnMgc3RvcCB3aGVuIGFsbCBzdGVwcyBhcmUgY29tcGxldGVcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHsgZW5naW5lIH0gPSBzZXR1cEVuZ2luZShbXG4gICAgICBtYWtlU3RlcCh7IGlkOiBcImFcIiwgc3RhdHVzOiBcImNvbXBsZXRlXCIgfSksXG4gICAgICBtYWtlU3RlcCh7IGlkOiBcImJcIiwgc3RhdHVzOiBcImNvbXBsZXRlXCIgfSksXG4gICAgXSk7XG5cbiAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGVuZ2luZS5kZXJpdmVTdGF0ZShcIi91bnVzZWRcIik7XG4gICAgY29uc3QgZGlzcGF0Y2ggPSBhd2FpdCBlbmdpbmUucmVzb2x2ZURpc3BhdGNoKHN0YXRlLCB7IGJhc2VQYXRoOiBcIi91bnVzZWRcIiB9KTtcblxuICAgIGFzc2VydC5lcXVhbChkaXNwYXRjaC5hY3Rpb24sIFwic3RvcFwiKTtcbiAgICBpZiAoZGlzcGF0Y2guYWN0aW9uID09PSBcInN0b3BcIikge1xuICAgICAgYXNzZXJ0LmVxdWFsKGRpc3BhdGNoLnJlYXNvbiwgXCJBbGwgc3RlcHMgY29tcGxldGVcIik7XG4gICAgICBhc3NlcnQuZXF1YWwoZGlzcGF0Y2gubGV2ZWwsIFwiaW5mb1wiKTtcbiAgICB9XG4gIH0pO1xuXG4gIGl0KFwicmV0dXJucyBzdG9wIHdpdGggZGVwZW5kZW5jeSBkZXRhaWxzIHdoZW4gcGVuZGluZyBzdGVwcyBhcmUgYmxvY2tlZFwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyBlbmdpbmUgfSA9IHNldHVwRW5naW5lKFtcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwiYVwiLCBkZXBlbmRzT246IFtcImJcIl0gfSksXG4gICAgICBtYWtlU3RlcCh7IGlkOiBcImJcIiwgZGVwZW5kc09uOiBbXCJhXCJdIH0pLFxuICAgIF0pO1xuXG4gICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBlbmdpbmUuZGVyaXZlU3RhdGUoXCIvdW51c2VkXCIpO1xuICAgIGNvbnN0IGRpc3BhdGNoID0gYXdhaXQgZW5naW5lLnJlc29sdmVEaXNwYXRjaChzdGF0ZSwgeyBiYXNlUGF0aDogXCIvdW51c2VkXCIgfSk7XG5cbiAgICBhc3NlcnQuZXF1YWwoZGlzcGF0Y2guYWN0aW9uLCBcInN0b3BcIik7XG4gICAgaWYgKGRpc3BhdGNoLmFjdGlvbiA9PT0gXCJzdG9wXCIpIHtcbiAgICAgIGFzc2VydC5lcXVhbChkaXNwYXRjaC5sZXZlbCwgXCJlcnJvclwiKTtcbiAgICAgIGFzc2VydC5tYXRjaChkaXNwYXRjaC5yZWFzb24sIC9Xb3JrZmxvdyBibG9ja2VkLyk7XG4gICAgICBhc3NlcnQubWF0Y2goZGlzcGF0Y2gucmVhc29uLCAvYSB3YWl0aW5nIG9uIGIgXFwocGVuZGluZ1xcKS8pO1xuICAgICAgYXNzZXJ0Lm1hdGNoKGRpc3BhdGNoLnJlYXNvbiwgL2Igd2FpdGluZyBvbiBhIFxcKHBlbmRpbmdcXCkvKTtcbiAgICB9XG4gIH0pO1xuXG4gIGl0KFwicmVwb3J0cyBtaXNzaW5nIGRlcGVuZGVuY2llcyB3aGVuIG5vIHBlbmRpbmcgc3RlcCBjYW4gcnVuXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB7IGVuZ2luZSB9ID0gc2V0dXBFbmdpbmUoW1xuICAgICAgbWFrZVN0ZXAoeyBpZDogXCJhXCIsIGRlcGVuZHNPbjogW1wibWlzc2luZy1zdGVwXCJdIH0pLFxuICAgIF0pO1xuXG4gICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBlbmdpbmUuZGVyaXZlU3RhdGUoXCIvdW51c2VkXCIpO1xuICAgIGNvbnN0IGRpc3BhdGNoID0gYXdhaXQgZW5naW5lLnJlc29sdmVEaXNwYXRjaChzdGF0ZSwgeyBiYXNlUGF0aDogXCIvdW51c2VkXCIgfSk7XG5cbiAgICBhc3NlcnQuZXF1YWwoZGlzcGF0Y2guYWN0aW9uLCBcInN0b3BcIik7XG4gICAgaWYgKGRpc3BhdGNoLmFjdGlvbiA9PT0gXCJzdG9wXCIpIHtcbiAgICAgIGFzc2VydC5lcXVhbChkaXNwYXRjaC5sZXZlbCwgXCJlcnJvclwiKTtcbiAgICAgIGFzc2VydC5tYXRjaChkaXNwYXRjaC5yZWFzb24sIC9hIHdhaXRpbmcgb24gbWlzc2luZy1zdGVwIFxcKG1pc3NpbmdcXCkvKTtcbiAgICB9XG4gIH0pO1xuXG4gIGl0KFwiZG9lcyBub3QgcmVwb3J0IGV4cGFuZGVkIGRlcGVuZGVuY2llcyBhcyBibG9ja2Vyc1wiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyBlbmdpbmUgfSA9IHNldHVwRW5naW5lKFtcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwiaXRlclwiLCBzdGF0dXM6IFwiZXhwYW5kZWRcIiB9KSxcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwiYWZ0ZXJcIiwgZGVwZW5kc09uOiBbXCJpdGVyXCIsIFwibWlzc2luZy1zdGVwXCJdIH0pLFxuICAgIF0pO1xuXG4gICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBlbmdpbmUuZGVyaXZlU3RhdGUoXCIvdW51c2VkXCIpO1xuICAgIGNvbnN0IGRpc3BhdGNoID0gYXdhaXQgZW5naW5lLnJlc29sdmVEaXNwYXRjaChzdGF0ZSwgeyBiYXNlUGF0aDogXCIvdW51c2VkXCIgfSk7XG5cbiAgICBhc3NlcnQuZXF1YWwoZGlzcGF0Y2guYWN0aW9uLCBcInN0b3BcIik7XG4gICAgaWYgKGRpc3BhdGNoLmFjdGlvbiA9PT0gXCJzdG9wXCIpIHtcbiAgICAgIGFzc2VydC5lcXVhbChkaXNwYXRjaC5sZXZlbCwgXCJlcnJvclwiKTtcbiAgICAgIGFzc2VydC5tYXRjaChkaXNwYXRjaC5yZWFzb24sIC9hZnRlciB3YWl0aW5nIG9uIG1pc3Npbmctc3RlcCBcXChtaXNzaW5nXFwpLyk7XG4gICAgICBhc3NlcnQuZG9lc05vdE1hdGNoKGRpc3BhdGNoLnJlYXNvbiwgL2l0ZXIgXFwoZXhwYW5kZWRcXCkvKTtcbiAgICB9XG4gIH0pO1xuXG4gIGl0KFwicmVzcGVjdHMgZGVwZW5kZW5jeSBvcmRlcmluZ1wiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyBlbmdpbmUgfSA9IHNldHVwRW5naW5lKFtcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwiYVwiIH0pLFxuICAgICAgbWFrZVN0ZXAoeyBpZDogXCJiXCIsIGRlcGVuZHNPbjogW1wiYVwiXSB9KSxcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwiY1wiLCBkZXBlbmRzT246IFtcImJcIl0gfSksXG4gICAgXSwgXCJkZXAtd2ZcIik7XG5cbiAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGVuZ2luZS5kZXJpdmVTdGF0ZShcIi91bnVzZWRcIik7XG4gICAgY29uc3QgZGlzcGF0Y2ggPSBhd2FpdCBlbmdpbmUucmVzb2x2ZURpc3BhdGNoKHN0YXRlLCB7IGJhc2VQYXRoOiBcIi91bnVzZWRcIiB9KTtcblxuICAgIC8vIFNob3VsZCBwaWNrIFwiYVwiIChubyBkZXBzKSwgbm90IFwiYlwiIG9yIFwiY1wiXG4gICAgYXNzZXJ0LmVxdWFsKGRpc3BhdGNoLmFjdGlvbiwgXCJkaXNwYXRjaFwiKTtcbiAgICBpZiAoZGlzcGF0Y2guYWN0aW9uID09PSBcImRpc3BhdGNoXCIpIHtcbiAgICAgIGFzc2VydC5lcXVhbChkaXNwYXRjaC5zdGVwLnVuaXRJZCwgXCJkZXAtd2YvYVwiKTtcbiAgICB9XG4gIH0pO1xuXG4gIGl0KFwicGlja3MgbmV4dCBlbGlnaWJsZSBzdGVwIHdoZW4gZWFybGllciBkZXBzIGFyZSBjb21wbGV0ZVwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyBlbmdpbmUgfSA9IHNldHVwRW5naW5lKFtcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwiYVwiLCBzdGF0dXM6IFwiY29tcGxldGVcIiB9KSxcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwiYlwiLCBkZXBlbmRzT246IFtcImFcIl0gfSksXG4gICAgICBtYWtlU3RlcCh7IGlkOiBcImNcIiwgZGVwZW5kc09uOiBbXCJiXCJdIH0pLFxuICAgIF0sIFwiZGVwLXdmXCIpO1xuXG4gICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBlbmdpbmUuZGVyaXZlU3RhdGUoXCIvdW51c2VkXCIpO1xuICAgIGNvbnN0IGRpc3BhdGNoID0gYXdhaXQgZW5naW5lLnJlc29sdmVEaXNwYXRjaChzdGF0ZSwgeyBiYXNlUGF0aDogXCIvdW51c2VkXCIgfSk7XG5cbiAgICAvLyBcImFcIiBpcyBkb25lLCBcImJcIiBkZXBzIG1ldCwgc2hvdWxkIHBpY2sgXCJiXCJcbiAgICBhc3NlcnQuZXF1YWwoZGlzcGF0Y2guYWN0aW9uLCBcImRpc3BhdGNoXCIpO1xuICAgIGlmIChkaXNwYXRjaC5hY3Rpb24gPT09IFwiZGlzcGF0Y2hcIikge1xuICAgICAgYXNzZXJ0LmVxdWFsKGRpc3BhdGNoLnN0ZXAudW5pdElkLCBcImRlcC13Zi9iXCIpO1xuICAgIH1cbiAgfSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHJlY29uY2lsZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJDdXN0b21Xb3JrZmxvd0VuZ2luZS5yZWNvbmNpbGVcIiwgKCkgPT4ge1xuICBpdChcIm1hcmtzIHN0ZXAgY29tcGxldGUgaW4gR1JBUEgueWFtbCBvbiBkaXNrXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB7IGVuZ2luZSwgcnVuRGlyIH0gPSBzZXR1cEVuZ2luZShbXG4gICAgICBtYWtlU3RlcCh7IGlkOiBcInN0ZXAtMVwiIH0pLFxuICAgICAgbWFrZVN0ZXAoeyBpZDogXCJzdGVwLTJcIiwgZGVwZW5kc09uOiBbXCJzdGVwLTFcIl0gfSksXG4gICAgXSwgXCJ3ZlwiKTtcblxuICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZW5naW5lLmRlcml2ZVN0YXRlKFwiL3VudXNlZFwiKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBlbmdpbmUucmVjb25jaWxlKHN0YXRlLCB7XG4gICAgICB1bml0VHlwZTogXCJjdXN0b20tc3RlcFwiLFxuICAgICAgdW5pdElkOiBcIndmL3N0ZXAtMVwiLFxuICAgICAgc3RhcnRlZEF0OiBEYXRlLm5vdygpIC0gMTAwMCxcbiAgICAgIGZpbmlzaGVkQXQ6IERhdGUubm93KCksXG4gICAgfSk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm91dGNvbWUsIFwiY29udGludWVcIik7XG5cbiAgICAvLyBWZXJpZnkgb24tZGlzayBzdGF0ZVxuICAgIGNvbnN0IGdyYXBoID0gcmVhZEdyYXBoKHJ1bkRpcik7XG4gICAgYXNzZXJ0LmVxdWFsKGdyYXBoLnN0ZXBzWzBdLnN0YXR1cywgXCJjb21wbGV0ZVwiKTtcbiAgICBhc3NlcnQub2soZ3JhcGguc3RlcHNbMF0uZmluaXNoZWRBdCwgXCJmaW5pc2hlZEF0IHNob3VsZCBiZSBzZXRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGdyYXBoLnN0ZXBzWzFdLnN0YXR1cywgXCJwZW5kaW5nXCIpO1xuICB9KTtcblxuICBpdChcInJldHVybnMgbWlsZXN0b25lLWNvbXBsZXRlIHdoZW4gYWxsIHN0ZXBzIGRvbmVcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHsgZW5naW5lIH0gPSBzZXR1cEVuZ2luZShbXG4gICAgICBtYWtlU3RlcCh7IGlkOiBcIm9ubHktc3RlcFwiIH0pLFxuICAgIF0sIFwid2ZcIik7XG5cbiAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGVuZ2luZS5kZXJpdmVTdGF0ZShcIi91bnVzZWRcIik7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZW5naW5lLnJlY29uY2lsZShzdGF0ZSwge1xuICAgICAgdW5pdFR5cGU6IFwiY3VzdG9tLXN0ZXBcIixcbiAgICAgIHVuaXRJZDogXCJ3Zi9vbmx5LXN0ZXBcIixcbiAgICAgIHN0YXJ0ZWRBdDogRGF0ZS5ub3coKSAtIDEwMDAsXG4gICAgICBmaW5pc2hlZEF0OiBEYXRlLm5vdygpLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5vdXRjb21lLCBcIm1pbGVzdG9uZS1jb21wbGV0ZVwiKTtcbiAgfSk7XG5cbiAgaXQoXCJoYW5kbGVzIG11bHRpLXNlZ21lbnQgdW5pdElkIGNvcnJlY3RseVwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyBlbmdpbmUsIHJ1bkRpciB9ID0gc2V0dXBFbmdpbmUoW1xuICAgICAgbWFrZVN0ZXAoeyBpZDogXCJkZWVwLXN0ZXBcIiB9KSxcbiAgICBdLCBcIm5lc3RlZC93b3JrZmxvd1wiKTtcblxuICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZW5naW5lLmRlcml2ZVN0YXRlKFwiL3VudXNlZFwiKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBlbmdpbmUucmVjb25jaWxlKHN0YXRlLCB7XG4gICAgICB1bml0VHlwZTogXCJjdXN0b20tc3RlcFwiLFxuICAgICAgdW5pdElkOiBcIm5lc3RlZC93b3JrZmxvdy9kZWVwLXN0ZXBcIixcbiAgICAgIHN0YXJ0ZWRBdDogRGF0ZS5ub3coKSAtIDEwMDAsXG4gICAgICBmaW5pc2hlZEF0OiBEYXRlLm5vdygpLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5vdXRjb21lLCBcIm1pbGVzdG9uZS1jb21wbGV0ZVwiKTtcbiAgICBjb25zdCBncmFwaCA9IHJlYWRHcmFwaChydW5EaXIpO1xuICAgIGFzc2VydC5lcXVhbChncmFwaC5zdGVwc1swXS5zdGF0dXMsIFwiY29tcGxldGVcIik7XG4gIH0pO1xuXG4gIGl0KFwicmUtcmVhZHMgR1JBUEgueWFtbCBiZWZvcmUgcmVjb25jaWxlIHNvIGNvbmN1cnJlbnQgZWRpdHMgYXJlIHByZXNlcnZlZFwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyBlbmdpbmUsIHJ1bkRpciB9ID0gc2V0dXBFbmdpbmUoW1xuICAgICAgbWFrZVN0ZXAoeyBpZDogXCJzdGVwLTFcIiB9KSxcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwic3RlcC0yXCIsIGRlcGVuZHNPbjogW1wic3RlcC0xXCJdIH0pLFxuICAgIF0sIFwid2ZcIik7XG5cbiAgICBjb25zdCBzdGFsZVN0YXRlID0gYXdhaXQgZW5naW5lLmRlcml2ZVN0YXRlKFwiL3VudXNlZFwiKTtcblxuICAgIC8vIFNpbXVsYXRlIGFub3RoZXIgcHJvY2VzcyBhcHBlbmRpbmcgYSBuZXcgc3RlcCBhZnRlciBkZXJpdmVTdGF0ZSgpIHJhbi5cbiAgICB3cml0ZUdyYXBoKHJ1bkRpciwgbWFrZUdyYXBoKFtcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwic3RlcC0xXCIgfSksXG4gICAgICBtYWtlU3RlcCh7IGlkOiBcInN0ZXAtMlwiLCBkZXBlbmRzT246IFtcInN0ZXAtMVwiXSB9KSxcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwic3RlcC0zXCIsIGRlcGVuZHNPbjogW1wic3RlcC0yXCJdIH0pLFxuICAgIF0sIFwid2ZcIikpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZW5naW5lLnJlY29uY2lsZShzdGFsZVN0YXRlLCB7XG4gICAgICB1bml0VHlwZTogXCJjdXN0b20tc3RlcFwiLFxuICAgICAgdW5pdElkOiBcIndmL3N0ZXAtMVwiLFxuICAgICAgc3RhcnRlZEF0OiBEYXRlLm5vdygpIC0gMTAwMCxcbiAgICAgIGZpbmlzaGVkQXQ6IERhdGUubm93KCksXG4gICAgfSk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm91dGNvbWUsIFwiY29udGludWVcIik7XG5cbiAgICBjb25zdCBncmFwaCA9IHJlYWRHcmFwaChydW5EaXIpO1xuICAgIGFzc2VydC5lcXVhbChncmFwaC5zdGVwcy5sZW5ndGgsIDMsIFwicmVjb25jaWxlIHNob3VsZCBwcmVzZXJ2ZSB0aGUgY29uY3VycmVudCBncmFwaCBlZGl0XCIpO1xuICAgIGFzc2VydC5lcXVhbChncmFwaC5zdGVwc1swXS5zdGF0dXMsIFwiY29tcGxldGVcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGdyYXBoLnN0ZXBzWzFdLnN0YXR1cywgXCJwZW5kaW5nXCIpO1xuICAgIGFzc2VydC5lcXVhbChncmFwaC5zdGVwc1syXS5zdGF0dXMsIFwicGVuZGluZ1wiKTtcbiAgfSk7XG5cbiAgaXQoXCJyZWNvbmNpbGUgY29tcGxldGVzIGEgc3RlcCB0aGF0IHdhcyBwcmV2aW91c2x5IHBlcnNpc3RlZCBhcyBhY3RpdmVcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHsgZW5naW5lLCBydW5EaXIgfSA9IHNldHVwRW5naW5lKFtcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwic3RlcC0xXCIsIHByb21wdDogXCJEbyB0aGUgZmlyc3QgdGhpbmdcIiB9KSxcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwic3RlcC0yXCIsIGRlcGVuZHNPbjogW1wic3RlcC0xXCJdIH0pLFxuICAgIF0sIFwid2ZcIik7XG5cbiAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGVuZ2luZS5kZXJpdmVTdGF0ZShcIi91bnVzZWRcIik7XG4gICAgY29uc3QgZGlzcGF0Y2ggPSBhd2FpdCBlbmdpbmUucmVzb2x2ZURpc3BhdGNoKHN0YXRlLCB7IGJhc2VQYXRoOiBcIi91bnVzZWRcIiB9KTtcbiAgICBhc3NlcnQuZXF1YWwoZGlzcGF0Y2guYWN0aW9uLCBcImRpc3BhdGNoXCIpO1xuXG4gICAgY29uc3QgYWN0aXZlU3RhdGUgPSBhd2FpdCBlbmdpbmUuZGVyaXZlU3RhdGUoXCIvdW51c2VkXCIpO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGVuZ2luZS5yZWNvbmNpbGUoYWN0aXZlU3RhdGUsIHtcbiAgICAgIHVuaXRUeXBlOiBcImN1c3RvbS1zdGVwXCIsXG4gICAgICB1bml0SWQ6IFwid2Yvc3RlcC0xXCIsXG4gICAgICBzdGFydGVkQXQ6IERhdGUubm93KCkgLSAxMDAwLFxuICAgICAgZmluaXNoZWRBdDogRGF0ZS5ub3coKSxcbiAgICB9KTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQub3V0Y29tZSwgXCJjb250aW51ZVwiKTtcbiAgICBjb25zdCBncmFwaCA9IHJlYWRHcmFwaChydW5EaXIpO1xuICAgIGFzc2VydC5lcXVhbChncmFwaC5zdGVwc1swXS5zdGF0dXMsIFwiY29tcGxldGVcIik7XG4gICAgYXNzZXJ0Lm9rKGdyYXBoLnN0ZXBzWzBdLnN0YXJ0ZWRBdCwgXCJzdGFydGVkQXQgc2hvdWxkIHN1cnZpdmUgcmVjb25jaWxlXCIpO1xuICAgIGFzc2VydC5vayhncmFwaC5zdGVwc1swXS5maW5pc2hlZEF0LCBcImZpbmlzaGVkQXQgc2hvdWxkIGJlIHBlcnNpc3RlZCBvbiBjb21wbGV0aW9uXCIpO1xuICB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgZ2V0RGlzcGxheU1ldGFkYXRhIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcIkN1c3RvbVdvcmtmbG93RW5naW5lLmdldERpc3BsYXlNZXRhZGF0YVwiLCAoKSA9PiB7XG4gIGl0KFwicmV0dXJucyBjb3JyZWN0IHByb2dyZXNzIHN1bW1hcnlcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHsgZW5naW5lIH0gPSBzZXR1cEVuZ2luZShbXG4gICAgICBtYWtlU3RlcCh7IGlkOiBcImFcIiwgc3RhdHVzOiBcImNvbXBsZXRlXCIgfSksXG4gICAgICBtYWtlU3RlcCh7IGlkOiBcImJcIiB9KSxcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwiY1wiIH0pLFxuICAgIF0pO1xuXG4gICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBlbmdpbmUuZGVyaXZlU3RhdGUoXCIvdW51c2VkXCIpO1xuICAgIGNvbnN0IG1ldGEgPSBlbmdpbmUuZ2V0RGlzcGxheU1ldGFkYXRhKHN0YXRlKTtcblxuICAgIGFzc2VydC5lcXVhbChtZXRhLmVuZ2luZUxhYmVsLCBcIldPUktGTE9XXCIpO1xuICAgIGFzc2VydC5lcXVhbChtZXRhLmN1cnJlbnRQaGFzZSwgXCJydW5uaW5nXCIpO1xuICAgIGFzc2VydC5lcXVhbChtZXRhLnByb2dyZXNzU3VtbWFyeSwgXCJTdGVwIDEvM1wiKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKG1ldGEuc3RlcENvdW50LCB7IGNvbXBsZXRlZDogMSwgdG90YWw6IDMgfSk7XG4gIH0pO1xuXG4gIGl0KFwic2hvd3MgMC9OIHdoZW4gbm8gc3RlcHMgY29tcGxldGVcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHsgZW5naW5lIH0gPSBzZXR1cEVuZ2luZShbXG4gICAgICBtYWtlU3RlcCh7IGlkOiBcImFcIiB9KSxcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwiYlwiIH0pLFxuICAgIF0pO1xuXG4gICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBlbmdpbmUuZGVyaXZlU3RhdGUoXCIvdW51c2VkXCIpO1xuICAgIGNvbnN0IG1ldGEgPSBlbmdpbmUuZ2V0RGlzcGxheU1ldGFkYXRhKHN0YXRlKTtcblxuICAgIGFzc2VydC5lcXVhbChtZXRhLnByb2dyZXNzU3VtbWFyeSwgXCJTdGVwIDAvMlwiKTtcbiAgfSk7XG5cbiAgaXQoXCJzaG93cyBOL04gd2hlbiBhbGwgc3RlcHMgY29tcGxldGVcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHsgZW5naW5lIH0gPSBzZXR1cEVuZ2luZShbXG4gICAgICBtYWtlU3RlcCh7IGlkOiBcImFcIiwgc3RhdHVzOiBcImNvbXBsZXRlXCIgfSksXG4gICAgICBtYWtlU3RlcCh7IGlkOiBcImJcIiwgc3RhdHVzOiBcImNvbXBsZXRlXCIgfSksXG4gICAgXSk7XG5cbiAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGVuZ2luZS5kZXJpdmVTdGF0ZShcIi91bnVzZWRcIik7XG4gICAgY29uc3QgbWV0YSA9IGVuZ2luZS5nZXREaXNwbGF5TWV0YWRhdGEoc3RhdGUpO1xuXG4gICAgYXNzZXJ0LmVxdWFsKG1ldGEucHJvZ3Jlc3NTdW1tYXJ5LCBcIlN0ZXAgMi8yXCIpO1xuICAgIGFzc2VydC5lcXVhbChtZXRhLmN1cnJlbnRQaGFzZSwgXCJjb21wbGV0ZVwiKTtcbiAgfSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEN1c3RvbUV4ZWN1dGlvblBvbGljeSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJDdXN0b21FeGVjdXRpb25Qb2xpY3lcIiwgKCkgPT4ge1xuICBpdChcInZlcmlmeSByZXR1cm5zIGNvbnRpbnVlXCIsIGFzeW5jICgpID0+IHtcbiAgICAvLyB2ZXJpZnkoKSByZWFkcyBERUZJTklUSU9OLnlhbWwgZnJvbSBydW5EaXIgdG8gZmluZCBzdGVwJ3MgdmVyaWZ5IHBvbGljeVxuICAgIGNvbnN0IHJ1bkRpciA9IG1ha2VUbXBEaXIoKTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4ocnVuRGlyLCBcIkRFRklOSVRJT04ueWFtbFwiKSwgc3RyaW5naWZ5KHtcbiAgICAgIHZlcnNpb246IDEsIG5hbWU6IFwid2ZcIiwgZGVzY3JpcHRpb246IFwidGVzdFwiLFxuICAgICAgc3RlcHM6IFt7IGlkOiBcInN0ZXAtMVwiLCBuYW1lOiBcIlN0ZXAgMVwiLCBwcm9tcHQ6IFwiZG8gaXRcIiwgcHJvZHVjZXM6IFwic3RlcC0xL291dHB1dC5tZFwiIH1dLFxuICAgIH0pKTtcbiAgICBjb25zdCBwb2xpY3kgPSBuZXcgQ3VzdG9tRXhlY3V0aW9uUG9saWN5KHJ1bkRpcik7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcG9saWN5LnZlcmlmeShcImN1c3RvbS1zdGVwXCIsIFwid2Yvc3RlcC0xXCIsIHsgYmFzZVBhdGg6IHJ1bkRpciB9KTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCBcImNvbnRpbnVlXCIpO1xuICB9KTtcblxuICBpdChcInNlbGVjdE1vZGVsIHJldHVybnMgbnVsbFwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgcG9saWN5ID0gbmV3IEN1c3RvbUV4ZWN1dGlvblBvbGljeShcIi90bXAvcnVuXCIpO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHBvbGljeS5zZWxlY3RNb2RlbChcImN1c3RvbS1zdGVwXCIsIFwid2Yvc3RlcC0xXCIsIHsgYmFzZVBhdGg6IFwiL3RtcFwiIH0pO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIG51bGwpO1xuICB9KTtcblxuICBpdChcInJlY292ZXIgcmV0dXJucyByZXRyeVwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgcG9saWN5ID0gbmV3IEN1c3RvbUV4ZWN1dGlvblBvbGljeShcIi90bXAvcnVuXCIpO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHBvbGljeS5yZWNvdmVyKFwiY3VzdG9tLXN0ZXBcIiwgXCJ3Zi9zdGVwLTFcIiwgeyBiYXNlUGF0aDogXCIvdG1wXCIgfSk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQsIHsgb3V0Y29tZTogXCJyZXRyeVwiLCByZWFzb246IFwiRGVmYXVsdCByZXRyeVwiIH0pO1xuICB9KTtcblxuICBpdChcImNsb3Nlb3V0IHJldHVybnMgbm8gYXJ0aWZhY3RzXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBwb2xpY3kgPSBuZXcgQ3VzdG9tRXhlY3V0aW9uUG9saWN5KFwiL3RtcC9ydW5cIik7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcG9saWN5LmNsb3Nlb3V0KFwiY3VzdG9tLXN0ZXBcIiwgXCJ3Zi9zdGVwLTFcIiwge1xuICAgICAgYmFzZVBhdGg6IFwiL3RtcFwiLFxuICAgICAgc3RhcnRlZEF0OiBEYXRlLm5vdygpLFxuICAgIH0pO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0LCB7IGNvbW1pdHRlZDogZmFsc2UsIGFydGlmYWN0czogW10gfSk7XG4gIH0pO1xuXG4gIGl0KFwicHJlcGFyZVdvcmtzcGFjZSByZXNvbHZlcyB3aXRob3V0IGVycm9yXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBwb2xpY3kgPSBuZXcgQ3VzdG9tRXhlY3V0aW9uUG9saWN5KFwiL3RtcC9ydW5cIik7XG4gICAgYXdhaXQgcG9saWN5LnByZXBhcmVXb3Jrc3BhY2UoXCIvdG1wXCIsIFwiTTAwMVwiKTsgLy8gU2hvdWxkIG5vdCB0aHJvd1xuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBT0EsU0FBUyxVQUFVLElBQUksaUJBQWlCO0FBQ3hDLE9BQU8sWUFBWTtBQUNuQixTQUFTLGFBQWEsUUFBc0IscUJBQXFCO0FBQ2pFLFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFHdkIsU0FBUyw0QkFBNEI7QUFDckMsU0FBUyw2QkFBNkI7QUFDdEMsU0FBUyxZQUFZLGlCQUFxRDtBQUMxRSxTQUFTLGlCQUFpQjtBQUkxQixNQUFNLFVBQW9CLENBQUM7QUFFM0IsU0FBUyxhQUFxQjtBQUM1QixRQUFNLE1BQU0sWUFBWSxLQUFLLE9BQU8sR0FBRyxjQUFjLENBQUM7QUFDdEQsVUFBUSxLQUFLLEdBQUc7QUFDaEIsU0FBTztBQUNUO0FBRUEsVUFBVSxNQUFNO0FBQ2QsYUFBVyxLQUFLLFNBQVM7QUFDdkIsUUFBSTtBQUFFLGFBQU8sR0FBRyxFQUFFLFdBQVcsTUFBTSxPQUFPLE1BQU0sWUFBWSxHQUFHLFlBQVksSUFBSSxDQUFDO0FBQUEsSUFBRyxRQUFRO0FBQUEsSUFBc0I7QUFBQSxFQUNuSDtBQUNBLFVBQVEsU0FBUztBQUNuQixDQUFDO0FBRUQsU0FBUyxTQUFTLFdBQTJEO0FBQzNFLFNBQU87QUFBQSxJQUNMLE9BQU8sVUFBVTtBQUFBLElBQ2pCLFFBQVE7QUFBQSxJQUNSLFFBQVEsTUFBTSxVQUFVLEVBQUU7QUFBQSxJQUMxQixXQUFXLENBQUM7QUFBQSxJQUNaLEdBQUc7QUFBQSxFQUNMO0FBQ0Y7QUFFQSxTQUFTLFVBQVUsT0FBb0IsT0FBTyxXQUEwQjtBQUN0RSxTQUFPO0FBQUEsSUFDTDtBQUFB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
