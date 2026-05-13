import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";
import { CustomWorkflowEngine } from "../custom-workflow-engine.js";
import {
  writeGraph,
  readGraph
} from "../graph.js";
const tmpDirs = [];
function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), "iterate-test-"));
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
function makeTempRun(def, graphSteps, files) {
  const runDir = makeTmpDir();
  writeFileSync(join(runDir, "DEFINITION.yaml"), stringify(def), "utf-8");
  const graph = {
    steps: graphSteps,
    metadata: { name: def.name, createdAt: "2026-01-01T00:00:00.000Z" }
  };
  writeGraph(runDir, graph);
  if (files) {
    for (const [relPath, content] of Object.entries(files)) {
      const absPath = join(runDir, relPath);
      mkdirSync(join(absPath, ".."), { recursive: true });
      writeFileSync(absPath, content, "utf-8");
    }
  }
  return { runDir, engine: new CustomWorkflowEngine(runDir) };
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
async function dispatch(engine) {
  const state = await engine.deriveState("/unused");
  return engine.resolveDispatch(state, { basePath: "/unused" });
}
async function reconcile(engine, unitId) {
  const state = await engine.deriveState("/unused");
  return engine.reconcile(state, {
    unitType: "custom-step",
    unitId,
    startedAt: Date.now() - 1e3,
    finishedAt: Date.now()
  });
}
describe("iterate expansion \u2014 basic", () => {
  it("expands an iterate step into 3 instances and dispatches the first", async () => {
    const def = {
      version: 1,
      name: "iter-wf",
      steps: [
        {
          id: "iter-step",
          name: "Iterate Step",
          prompt: "Process {{item}}",
          requires: [],
          produces: [],
          iterate: { source: "topics.md", pattern: "^- (.+)$" }
        }
      ]
    };
    const graphSteps = [
      makeStep({ id: "iter-step", prompt: "Process {{item}}" })
    ];
    const { runDir, engine } = makeTempRun(def, graphSteps, {
      "topics.md": "- Alpha\n- Beta\n- Gamma\n"
    });
    const result = await dispatch(engine);
    assert.equal(result.action, "dispatch");
    if (result.action === "dispatch") {
      assert.equal(result.step.unitId, "iter-wf/iter-step--001");
      assert.equal(result.step.prompt, "Process Alpha");
    }
    const graph = readGraph(runDir);
    const parent = graph.steps.find((s) => s.id === "iter-step");
    assert.ok(parent, "Parent step should exist");
    assert.equal(parent.status, "expanded");
    const instances = graph.steps.filter((s) => s.parentStepId === "iter-step");
    assert.equal(instances.length, 3);
    assert.equal(instances[0].id, "iter-step--001");
    assert.equal(instances[1].id, "iter-step--002");
    assert.equal(instances[2].id, "iter-step--003");
    assert.equal(instances[0].prompt, "Process Alpha");
    assert.equal(instances[1].prompt, "Process Beta");
    assert.equal(instances[2].prompt, "Process Gamma");
  });
});
describe("iterate expansion \u2014 full dispatch\u2192reconcile sequence", () => {
  it("dispatches all 3 instances sequentially then stops", async () => {
    const def = {
      version: 1,
      name: "seq-wf",
      steps: [
        {
          id: "fan",
          name: "Fan Step",
          prompt: "Handle {{item}}",
          requires: [],
          produces: [],
          iterate: { source: "items.md", pattern: "^- (.+)$" }
        }
      ]
    };
    const graphSteps = [makeStep({ id: "fan", prompt: "Handle {{item}}" })];
    const { engine } = makeTempRun(def, graphSteps, {
      "items.md": "- One\n- Two\n- Three\n"
    });
    let result = await dispatch(engine);
    assert.equal(result.action, "dispatch");
    if (result.action === "dispatch") {
      assert.equal(result.step.unitId, "seq-wf/fan--001");
      assert.equal(result.step.prompt, "Handle One");
    }
    await reconcile(engine, "seq-wf/fan--001");
    result = await dispatch(engine);
    assert.equal(result.action, "dispatch");
    if (result.action === "dispatch") {
      assert.equal(result.step.unitId, "seq-wf/fan--002");
      assert.equal(result.step.prompt, "Handle Two");
    }
    await reconcile(engine, "seq-wf/fan--002");
    result = await dispatch(engine);
    assert.equal(result.action, "dispatch");
    if (result.action === "dispatch") {
      assert.equal(result.step.unitId, "seq-wf/fan--003");
      assert.equal(result.step.prompt, "Handle Three");
    }
    await reconcile(engine, "seq-wf/fan--003");
    result = await dispatch(engine);
    assert.equal(result.action, "stop");
    if (result.action === "stop") {
      assert.equal(result.reason, "All steps complete");
    }
  });
});
describe("iterate expansion \u2014 downstream blocking", () => {
  it("blocks downstream step until all instances are complete", async () => {
    const def = {
      version: 1,
      name: "block-wf",
      steps: [
        {
          id: "fan",
          name: "Fan Step",
          prompt: "Process {{item}}",
          requires: [],
          produces: [],
          iterate: { source: "items.md", pattern: "^- (.+)$" }
        },
        {
          id: "merge",
          name: "Merge Step",
          prompt: "Merge all results",
          requires: ["fan"],
          produces: []
        }
      ]
    };
    const graphSteps = [
      makeStep({ id: "fan", prompt: "Process {{item}}" }),
      makeStep({ id: "merge", prompt: "Merge all results", dependsOn: ["fan"] })
    ];
    const { runDir, engine } = makeTempRun(def, graphSteps, {
      "items.md": "- X\n- Y\n"
    });
    let result = await dispatch(engine);
    assert.equal(result.action, "dispatch");
    if (result.action === "dispatch") {
      assert.equal(result.step.unitId, "block-wf/fan--001");
    }
    let graph = readGraph(runDir);
    const mergeStep = graph.steps.find((s) => s.id === "merge");
    assert.ok(mergeStep);
    assert.deepStrictEqual(mergeStep.dependsOn.sort(), ["fan--001", "fan--002"]);
    await reconcile(engine, "block-wf/fan--001");
    result = await dispatch(engine);
    assert.equal(result.action, "dispatch");
    if (result.action === "dispatch") {
      assert.equal(result.step.unitId, "block-wf/fan--002");
    }
    await reconcile(engine, "block-wf/fan--002");
    result = await dispatch(engine);
    assert.equal(result.action, "dispatch");
    if (result.action === "dispatch") {
      assert.equal(result.step.unitId, "block-wf/merge");
      assert.equal(result.step.prompt, "Merge all results");
    }
    await reconcile(engine, "block-wf/merge");
    result = await dispatch(engine);
    assert.equal(result.action, "stop");
  });
});
describe("iterate expansion \u2014 zero matches", () => {
  it("handles zero-match expansion gracefully", async () => {
    const def = {
      version: 1,
      name: "zero-wf",
      steps: [
        {
          id: "fan",
          name: "Fan Step",
          prompt: "Process {{item}}",
          requires: [],
          produces: [],
          iterate: { source: "items.md", pattern: "^- (.+)$" }
        },
        {
          id: "after",
          name: "After Step",
          prompt: "Do after",
          requires: ["fan"],
          produces: []
        }
      ]
    };
    const graphSteps = [
      makeStep({ id: "fan", prompt: "Process {{item}}" }),
      makeStep({ id: "after", prompt: "Do after", dependsOn: ["fan"] })
    ];
    const { runDir, engine } = makeTempRun(def, graphSteps, {
      "items.md": "No bullet items here\nJust plain text\n"
    });
    const result = await dispatch(engine);
    const graph = readGraph(runDir);
    const parent = graph.steps.find((s) => s.id === "fan");
    assert.ok(parent);
    assert.equal(parent.status, "expanded");
    if (result.action === "dispatch") {
      assert.equal(result.step.unitId, "zero-wf/after");
    } else {
      assert.equal(result.action, "stop");
    }
  });
});
describe("iterate expansion \u2014 missing source artifact", () => {
  it("throws an error mentioning the missing file path", async () => {
    const def = {
      version: 1,
      name: "missing-wf",
      steps: [
        {
          id: "fan",
          name: "Fan Step",
          prompt: "Process {{item}}",
          requires: [],
          produces: [],
          iterate: { source: "nonexistent.md", pattern: "^- (.+)$" }
        }
      ]
    };
    const graphSteps = [
      makeStep({ id: "fan", prompt: "Process {{item}}" })
    ];
    const { engine } = makeTempRun(def, graphSteps);
    await assert.rejects(
      () => dispatch(engine),
      (err) => {
        assert.ok(err.message.includes("nonexistent.md"), `Error should mention the filename: ${err.message}`);
        assert.ok(err.message.includes("Iterate source artifact not found"), `Error should mention it's an iterate source: ${err.message}`);
        return true;
      }
    );
  });
});
describe("iterate expansion \u2014 idempotency", () => {
  it("does not re-expand an already expanded step on subsequent dispatch", async () => {
    const def = {
      version: 1,
      name: "idem-wf",
      steps: [
        {
          id: "fan",
          name: "Fan Step",
          prompt: "Process {{item}}",
          requires: [],
          produces: [],
          iterate: { source: "items.md", pattern: "^- (.+)$" }
        }
      ]
    };
    const graphSteps = [makeStep({ id: "fan", prompt: "Process {{item}}" })];
    const { runDir, engine } = makeTempRun(def, graphSteps, {
      "items.md": "- Uno\n- Dos\n"
    });
    let result = await dispatch(engine);
    assert.equal(result.action, "dispatch");
    if (result.action === "dispatch") {
      assert.equal(result.step.unitId, "idem-wf/fan--001");
    }
    result = await dispatch(engine);
    assert.equal(result.action, "dispatch");
    if (result.action === "dispatch") {
      assert.equal(result.step.unitId, "idem-wf/fan--001");
    }
    const graph = readGraph(runDir);
    const instances = graph.steps.filter((s) => s.parentStepId === "fan");
    assert.equal(instances.length, 2);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9pdGVyYXRlLWVuZ2luZS1pbnRlZ3JhdGlvbi50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIGl0ZXJhdGUtZW5naW5lLWludGVncmF0aW9uLnRlc3QudHMgXHUyMDE0IEludGVncmF0aW9uIHRlc3RzIGZvciBpdGVyYXRlL2Zhbi1vdXRcbiAqIGV4cGFuc2lvbiB3aXJlZCBpbnRvIEN1c3RvbVdvcmtmbG93RW5naW5lLlxuICpcbiAqIFByb3ZlcyB0aGUgZnVsbCBleHBhbnNpb25cdTIxOTJkaXNwYXRjaFx1MjE5MnJlY29uY2lsZSBjeWNsZTogdGhlIGVuZ2luZSByZWFkc1xuICogaXRlcmF0ZSBjb25maWcgZnJvbSBmcm96ZW4gREVGSU5JVElPTi55YW1sLCByZWFkcyB0aGUgc291cmNlIGFydGlmYWN0LFxuICogZXh0cmFjdHMgaXRlbXMgdmlhIHJlZ2V4LCBjYWxscyBleHBhbmRJdGVyYXRpb24oKSB0byByZXdyaXRlIHRoZSBncmFwaCxcbiAqIHBlcnNpc3RzIGl0LCBhbmQgZGlzcGF0Y2hlcyBpbnN0YW5jZSBzdGVwcyBzZXF1ZW50aWFsbHkuXG4gKlxuICogVXNlcyByZWFsIHRlbXAgZGlyZWN0b3JpZXMgd2l0aCBhY3R1YWwgREVGSU5JVElPTi55YW1sLCBHUkFQSC55YW1sLFxuICogYW5kIHNvdXJjZSBhcnRpZmFjdCBmaWxlcyBcdTIwMTQgbm8gbW9ja3MuXG4gKi9cblxuaW1wb3J0IHsgZGVzY3JpYmUsIGl0LCBhZnRlckVhY2ggfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMsIG1rZGlyU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IHN0cmluZ2lmeSB9IGZyb20gXCJ5YW1sXCI7XG5cbmltcG9ydCB7IEN1c3RvbVdvcmtmbG93RW5naW5lIH0gZnJvbSBcIi4uL2N1c3RvbS13b3JrZmxvdy1lbmdpbmUudHNcIjtcbmltcG9ydCB7XG4gIHdyaXRlR3JhcGgsXG4gIHJlYWRHcmFwaCxcbiAgdHlwZSBXb3JrZmxvd0dyYXBoLFxuICB0eXBlIEdyYXBoU3RlcCxcbn0gZnJvbSBcIi4uL2dyYXBoLnRzXCI7XG5pbXBvcnQgdHlwZSB7IFdvcmtmbG93RGVmaW5pdGlvbiB9IGZyb20gXCIuLi9kZWZpbml0aW9uLWxvYWRlci50c1wiO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgSGVscGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuY29uc3QgdG1wRGlyczogc3RyaW5nW10gPSBbXTtcblxuZnVuY3Rpb24gbWFrZVRtcERpcigpOiBzdHJpbmcge1xuICBjb25zdCBkaXIgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcIml0ZXJhdGUtdGVzdC1cIikpO1xuICB0bXBEaXJzLnB1c2goZGlyKTtcbiAgcmV0dXJuIGRpcjtcbn1cblxuYWZ0ZXJFYWNoKCgpID0+IHtcbiAgZm9yIChjb25zdCBkIG9mIHRtcERpcnMpIHtcbiAgICB0cnkgeyBybVN5bmMoZCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlLCBtYXhSZXRyaWVzOiAzLCByZXRyeURlbGF5OiAxMDAgfSk7IH0gY2F0Y2ggeyAvKiBXaW5kb3dzIEVQRVJNICovIH1cbiAgfVxuICB0bXBEaXJzLmxlbmd0aCA9IDA7XG59KTtcblxuLyoqXG4gKiBDcmVhdGUgYSB0ZW1wIHJ1biBkaXJlY3Rvcnkgd2l0aCBERUZJTklUSU9OLnlhbWwsIEdSQVBILnlhbWwsIGFuZCBvcHRpb25hbFxuICogYXJ0aWZhY3QgZmlsZXMuIFJldHVybnMgdGhlIHJ1biBkaXIgcGF0aCBhbmQgZW5naW5lIGluc3RhbmNlLlxuICovXG5mdW5jdGlvbiBtYWtlVGVtcFJ1bihcbiAgZGVmOiBXb3JrZmxvd0RlZmluaXRpb24sXG4gIGdyYXBoU3RlcHM6IEdyYXBoU3RlcFtdLFxuICBmaWxlcz86IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sXG4pOiB7IHJ1bkRpcjogc3RyaW5nOyBlbmdpbmU6IEN1c3RvbVdvcmtmbG93RW5naW5lIH0ge1xuICBjb25zdCBydW5EaXIgPSBtYWtlVG1wRGlyKCk7XG5cbiAgLy8gV3JpdGUgZnJvemVuIERFRklOSVRJT04ueWFtbCAoY2FtZWxDYXNlIFx1MjAxNCBzZXJpYWxpemVkIGZyb20gVFMgb2JqZWN0KVxuICB3cml0ZUZpbGVTeW5jKGpvaW4ocnVuRGlyLCBcIkRFRklOSVRJT04ueWFtbFwiKSwgc3RyaW5naWZ5KGRlZiksIFwidXRmLThcIik7XG5cbiAgLy8gV3JpdGUgR1JBUEgueWFtbCB2aWEgdGhlIHN0YW5kYXJkIHdyaXRlclxuICBjb25zdCBncmFwaDogV29ya2Zsb3dHcmFwaCA9IHtcbiAgICBzdGVwczogZ3JhcGhTdGVwcyxcbiAgICBtZXRhZGF0YTogeyBuYW1lOiBkZWYubmFtZSwgY3JlYXRlZEF0OiBcIjIwMjYtMDEtMDFUMDA6MDA6MDAuMDAwWlwiIH0sXG4gIH07XG4gIHdyaXRlR3JhcGgocnVuRGlyLCBncmFwaCk7XG5cbiAgLy8gV3JpdGUgb3B0aW9uYWwgYXJ0aWZhY3QgZmlsZXNcbiAgaWYgKGZpbGVzKSB7XG4gICAgZm9yIChjb25zdCBbcmVsUGF0aCwgY29udGVudF0gb2YgT2JqZWN0LmVudHJpZXMoZmlsZXMpKSB7XG4gICAgICBjb25zdCBhYnNQYXRoID0gam9pbihydW5EaXIsIHJlbFBhdGgpO1xuICAgICAgbWtkaXJTeW5jKGpvaW4oYWJzUGF0aCwgXCIuLlwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGFic1BhdGgsIGNvbnRlbnQsIFwidXRmLThcIik7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHsgcnVuRGlyLCBlbmdpbmU6IG5ldyBDdXN0b21Xb3JrZmxvd0VuZ2luZShydW5EaXIpIH07XG59XG5cbi8qKiBTaG9ydGhhbmQgdG8gYnVpbGQgYSBHcmFwaFN0ZXAuICovXG5mdW5jdGlvbiBtYWtlU3RlcChvdmVycmlkZXM6IFBhcnRpYWw8R3JhcGhTdGVwPiAmIHsgaWQ6IHN0cmluZyB9KTogR3JhcGhTdGVwIHtcbiAgcmV0dXJuIHtcbiAgICB0aXRsZTogb3ZlcnJpZGVzLmlkLFxuICAgIHN0YXR1czogXCJwZW5kaW5nXCIsXG4gICAgcHJvbXB0OiBgRG8gJHtvdmVycmlkZXMuaWR9YCxcbiAgICBkZXBlbmRzT246IFtdLFxuICAgIC4uLm92ZXJyaWRlcyxcbiAgfTtcbn1cblxuLyoqIERyaXZlIGEgZnVsbCBkZXJpdmVTdGF0ZVx1MjE5MnJlc29sdmVEaXNwYXRjaCBjeWNsZS4gKi9cbmFzeW5jIGZ1bmN0aW9uIGRpc3BhdGNoKGVuZ2luZTogQ3VzdG9tV29ya2Zsb3dFbmdpbmUpIHtcbiAgY29uc3Qgc3RhdGUgPSBhd2FpdCBlbmdpbmUuZGVyaXZlU3RhdGUoXCIvdW51c2VkXCIpO1xuICByZXR1cm4gZW5naW5lLnJlc29sdmVEaXNwYXRjaChzdGF0ZSwgeyBiYXNlUGF0aDogXCIvdW51c2VkXCIgfSk7XG59XG5cbi8qKiBEcml2ZSBhIGZ1bGwgZGVyaXZlU3RhdGVcdTIxOTJyZWNvbmNpbGUgY3ljbGUgZm9yIGEgZ2l2ZW4gdW5pdElkLiAqL1xuYXN5bmMgZnVuY3Rpb24gcmVjb25jaWxlKGVuZ2luZTogQ3VzdG9tV29ya2Zsb3dFbmdpbmUsIHVuaXRJZDogc3RyaW5nKSB7XG4gIGNvbnN0IHN0YXRlID0gYXdhaXQgZW5naW5lLmRlcml2ZVN0YXRlKFwiL3VudXNlZFwiKTtcbiAgcmV0dXJuIGVuZ2luZS5yZWNvbmNpbGUoc3RhdGUsIHtcbiAgICB1bml0VHlwZTogXCJjdXN0b20tc3RlcFwiLFxuICAgIHVuaXRJZCxcbiAgICBzdGFydGVkQXQ6IERhdGUubm93KCkgLSAxMDAwLFxuICAgIGZpbmlzaGVkQXQ6IERhdGUubm93KCksXG4gIH0pO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiaXRlcmF0ZSBleHBhbnNpb24gXHUyMDE0IGJhc2ljXCIsICgpID0+IHtcbiAgaXQoXCJleHBhbmRzIGFuIGl0ZXJhdGUgc3RlcCBpbnRvIDMgaW5zdGFuY2VzIGFuZCBkaXNwYXRjaGVzIHRoZSBmaXJzdFwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgZGVmOiBXb3JrZmxvd0RlZmluaXRpb24gPSB7XG4gICAgICB2ZXJzaW9uOiAxLFxuICAgICAgbmFtZTogXCJpdGVyLXdmXCIsXG4gICAgICBzdGVwczogW1xuICAgICAgICB7XG4gICAgICAgICAgaWQ6IFwiaXRlci1zdGVwXCIsXG4gICAgICAgICAgbmFtZTogXCJJdGVyYXRlIFN0ZXBcIixcbiAgICAgICAgICBwcm9tcHQ6IFwiUHJvY2VzcyB7e2l0ZW19fVwiLFxuICAgICAgICAgIHJlcXVpcmVzOiBbXSxcbiAgICAgICAgICBwcm9kdWNlczogW10sXG4gICAgICAgICAgaXRlcmF0ZTogeyBzb3VyY2U6IFwidG9waWNzLm1kXCIsIHBhdHRlcm46IFwiXi0gKC4rKSRcIiB9LFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9O1xuXG4gICAgY29uc3QgZ3JhcGhTdGVwcyA9IFtcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwiaXRlci1zdGVwXCIsIHByb21wdDogXCJQcm9jZXNzIHt7aXRlbX19XCIgfSksXG4gICAgXTtcblxuICAgIGNvbnN0IHsgcnVuRGlyLCBlbmdpbmUgfSA9IG1ha2VUZW1wUnVuKGRlZiwgZ3JhcGhTdGVwcywge1xuICAgICAgXCJ0b3BpY3MubWRcIjogXCItIEFscGhhXFxuLSBCZXRhXFxuLSBHYW1tYVxcblwiLFxuICAgIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZGlzcGF0Y2goZW5naW5lKTtcblxuICAgIC8vIFNob3VsZCBkaXNwYXRjaCB0aGUgZmlyc3QgaW5zdGFuY2Ugc3RlcFxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuYWN0aW9uLCBcImRpc3BhdGNoXCIpO1xuICAgIGlmIChyZXN1bHQuYWN0aW9uID09PSBcImRpc3BhdGNoXCIpIHtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc3RlcC51bml0SWQsIFwiaXRlci13Zi9pdGVyLXN0ZXAtLTAwMVwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc3RlcC5wcm9tcHQsIFwiUHJvY2VzcyBBbHBoYVwiKTtcbiAgICB9XG5cbiAgICAvLyBWZXJpZnkgb24tZGlzayBncmFwaCBzdGF0ZVxuICAgIGNvbnN0IGdyYXBoID0gcmVhZEdyYXBoKHJ1bkRpcik7XG4gICAgY29uc3QgcGFyZW50ID0gZ3JhcGguc3RlcHMuZmluZCgocykgPT4gcy5pZCA9PT0gXCJpdGVyLXN0ZXBcIik7XG4gICAgYXNzZXJ0Lm9rKHBhcmVudCwgXCJQYXJlbnQgc3RlcCBzaG91bGQgZXhpc3RcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHBhcmVudC5zdGF0dXMsIFwiZXhwYW5kZWRcIik7XG5cbiAgICBjb25zdCBpbnN0YW5jZXMgPSBncmFwaC5zdGVwcy5maWx0ZXIoKHMpID0+IHMucGFyZW50U3RlcElkID09PSBcIml0ZXItc3RlcFwiKTtcbiAgICBhc3NlcnQuZXF1YWwoaW5zdGFuY2VzLmxlbmd0aCwgMyk7XG4gICAgYXNzZXJ0LmVxdWFsKGluc3RhbmNlc1swXS5pZCwgXCJpdGVyLXN0ZXAtLTAwMVwiKTtcbiAgICBhc3NlcnQuZXF1YWwoaW5zdGFuY2VzWzFdLmlkLCBcIml0ZXItc3RlcC0tMDAyXCIpO1xuICAgIGFzc2VydC5lcXVhbChpbnN0YW5jZXNbMl0uaWQsIFwiaXRlci1zdGVwLS0wMDNcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGluc3RhbmNlc1swXS5wcm9tcHQsIFwiUHJvY2VzcyBBbHBoYVwiKTtcbiAgICBhc3NlcnQuZXF1YWwoaW5zdGFuY2VzWzFdLnByb21wdCwgXCJQcm9jZXNzIEJldGFcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGluc3RhbmNlc1syXS5wcm9tcHQsIFwiUHJvY2VzcyBHYW1tYVwiKTtcbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoXCJpdGVyYXRlIGV4cGFuc2lvbiBcdTIwMTQgZnVsbCBkaXNwYXRjaFx1MjE5MnJlY29uY2lsZSBzZXF1ZW5jZVwiLCAoKSA9PiB7XG4gIGl0KFwiZGlzcGF0Y2hlcyBhbGwgMyBpbnN0YW5jZXMgc2VxdWVudGlhbGx5IHRoZW4gc3RvcHNcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGRlZjogV29ya2Zsb3dEZWZpbml0aW9uID0ge1xuICAgICAgdmVyc2lvbjogMSxcbiAgICAgIG5hbWU6IFwic2VxLXdmXCIsXG4gICAgICBzdGVwczogW1xuICAgICAgICB7XG4gICAgICAgICAgaWQ6IFwiZmFuXCIsXG4gICAgICAgICAgbmFtZTogXCJGYW4gU3RlcFwiLFxuICAgICAgICAgIHByb21wdDogXCJIYW5kbGUge3tpdGVtfX1cIixcbiAgICAgICAgICByZXF1aXJlczogW10sXG4gICAgICAgICAgcHJvZHVjZXM6IFtdLFxuICAgICAgICAgIGl0ZXJhdGU6IHsgc291cmNlOiBcIml0ZW1zLm1kXCIsIHBhdHRlcm46IFwiXi0gKC4rKSRcIiB9LFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9O1xuXG4gICAgY29uc3QgZ3JhcGhTdGVwcyA9IFttYWtlU3RlcCh7IGlkOiBcImZhblwiLCBwcm9tcHQ6IFwiSGFuZGxlIHt7aXRlbX19XCIgfSldO1xuXG4gICAgY29uc3QgeyBlbmdpbmUgfSA9IG1ha2VUZW1wUnVuKGRlZiwgZ3JhcGhTdGVwcywge1xuICAgICAgXCJpdGVtcy5tZFwiOiBcIi0gT25lXFxuLSBUd29cXG4tIFRocmVlXFxuXCIsXG4gICAgfSk7XG5cbiAgICAvLyBGaXJzdCBkaXNwYXRjaCB0cmlnZ2VycyBleHBhbnNpb24sIHJldHVybnMgaW5zdGFuY2UgMVxuICAgIGxldCByZXN1bHQgPSBhd2FpdCBkaXNwYXRjaChlbmdpbmUpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuYWN0aW9uLCBcImRpc3BhdGNoXCIpO1xuICAgIGlmIChyZXN1bHQuYWN0aW9uID09PSBcImRpc3BhdGNoXCIpIHtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc3RlcC51bml0SWQsIFwic2VxLXdmL2Zhbi0tMDAxXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zdGVwLnByb21wdCwgXCJIYW5kbGUgT25lXCIpO1xuICAgIH1cblxuICAgIC8vIFJlY29uY2lsZSBpbnN0YW5jZSAxLCBkaXNwYXRjaCBcdTIxOTIgaW5zdGFuY2UgMlxuICAgIGF3YWl0IHJlY29uY2lsZShlbmdpbmUsIFwic2VxLXdmL2Zhbi0tMDAxXCIpO1xuICAgIHJlc3VsdCA9IGF3YWl0IGRpc3BhdGNoKGVuZ2luZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5hY3Rpb24sIFwiZGlzcGF0Y2hcIik7XG4gICAgaWYgKHJlc3VsdC5hY3Rpb24gPT09IFwiZGlzcGF0Y2hcIikge1xuICAgICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zdGVwLnVuaXRJZCwgXCJzZXEtd2YvZmFuLS0wMDJcIik7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnN0ZXAucHJvbXB0LCBcIkhhbmRsZSBUd29cIik7XG4gICAgfVxuXG4gICAgLy8gUmVjb25jaWxlIGluc3RhbmNlIDIsIGRpc3BhdGNoIFx1MjE5MiBpbnN0YW5jZSAzXG4gICAgYXdhaXQgcmVjb25jaWxlKGVuZ2luZSwgXCJzZXEtd2YvZmFuLS0wMDJcIik7XG4gICAgcmVzdWx0ID0gYXdhaXQgZGlzcGF0Y2goZW5naW5lKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmFjdGlvbiwgXCJkaXNwYXRjaFwiKTtcbiAgICBpZiAocmVzdWx0LmFjdGlvbiA9PT0gXCJkaXNwYXRjaFwiKSB7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnN0ZXAudW5pdElkLCBcInNlcS13Zi9mYW4tLTAwM1wiKTtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc3RlcC5wcm9tcHQsIFwiSGFuZGxlIFRocmVlXCIpO1xuICAgIH1cblxuICAgIC8vIFJlY29uY2lsZSBpbnN0YW5jZSAzLCBkaXNwYXRjaCBcdTIxOTIgc2hvdWxkIHN0b3AgKGFsbCBkb25lKVxuICAgIGF3YWl0IHJlY29uY2lsZShlbmdpbmUsIFwic2VxLXdmL2Zhbi0tMDAzXCIpO1xuICAgIHJlc3VsdCA9IGF3YWl0IGRpc3BhdGNoKGVuZ2luZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5hY3Rpb24sIFwic3RvcFwiKTtcbiAgICBpZiAocmVzdWx0LmFjdGlvbiA9PT0gXCJzdG9wXCIpIHtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHQucmVhc29uLCBcIkFsbCBzdGVwcyBjb21wbGV0ZVwiKTtcbiAgICB9XG4gIH0pO1xufSk7XG5cbmRlc2NyaWJlKFwiaXRlcmF0ZSBleHBhbnNpb24gXHUyMDE0IGRvd25zdHJlYW0gYmxvY2tpbmdcIiwgKCkgPT4ge1xuICBpdChcImJsb2NrcyBkb3duc3RyZWFtIHN0ZXAgdW50aWwgYWxsIGluc3RhbmNlcyBhcmUgY29tcGxldGVcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGRlZjogV29ya2Zsb3dEZWZpbml0aW9uID0ge1xuICAgICAgdmVyc2lvbjogMSxcbiAgICAgIG5hbWU6IFwiYmxvY2std2ZcIixcbiAgICAgIHN0ZXBzOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBpZDogXCJmYW5cIixcbiAgICAgICAgICBuYW1lOiBcIkZhbiBTdGVwXCIsXG4gICAgICAgICAgcHJvbXB0OiBcIlByb2Nlc3Mge3tpdGVtfX1cIixcbiAgICAgICAgICByZXF1aXJlczogW10sXG4gICAgICAgICAgcHJvZHVjZXM6IFtdLFxuICAgICAgICAgIGl0ZXJhdGU6IHsgc291cmNlOiBcIml0ZW1zLm1kXCIsIHBhdHRlcm46IFwiXi0gKC4rKSRcIiB9LFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgaWQ6IFwibWVyZ2VcIixcbiAgICAgICAgICBuYW1lOiBcIk1lcmdlIFN0ZXBcIixcbiAgICAgICAgICBwcm9tcHQ6IFwiTWVyZ2UgYWxsIHJlc3VsdHNcIixcbiAgICAgICAgICByZXF1aXJlczogW1wiZmFuXCJdLFxuICAgICAgICAgIHByb2R1Y2VzOiBbXSxcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgfTtcblxuICAgIGNvbnN0IGdyYXBoU3RlcHMgPSBbXG4gICAgICBtYWtlU3RlcCh7IGlkOiBcImZhblwiLCBwcm9tcHQ6IFwiUHJvY2VzcyB7e2l0ZW19fVwiIH0pLFxuICAgICAgbWFrZVN0ZXAoeyBpZDogXCJtZXJnZVwiLCBwcm9tcHQ6IFwiTWVyZ2UgYWxsIHJlc3VsdHNcIiwgZGVwZW5kc09uOiBbXCJmYW5cIl0gfSksXG4gICAgXTtcblxuICAgIGNvbnN0IHsgcnVuRGlyLCBlbmdpbmUgfSA9IG1ha2VUZW1wUnVuKGRlZiwgZ3JhcGhTdGVwcywge1xuICAgICAgXCJpdGVtcy5tZFwiOiBcIi0gWFxcbi0gWVxcblwiLFxuICAgIH0pO1xuXG4gICAgLy8gRmlyc3QgZGlzcGF0Y2g6IGV4cGFuZHMgYW5kIHJldHVybnMgaW5zdGFuY2UgMVxuICAgIGxldCByZXN1bHQgPSBhd2FpdCBkaXNwYXRjaChlbmdpbmUpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuYWN0aW9uLCBcImRpc3BhdGNoXCIpO1xuICAgIGlmIChyZXN1bHQuYWN0aW9uID09PSBcImRpc3BhdGNoXCIpIHtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc3RlcC51bml0SWQsIFwiYmxvY2std2YvZmFuLS0wMDFcIik7XG4gICAgfVxuXG4gICAgLy8gVmVyaWZ5IGRvd25zdHJlYW0gZGVwIHdhcyByZXdyaXR0ZW46IG1lcmdlIG5vdyBkZXBlbmRzIG9uIGZhbi0tMDAxLCBmYW4tLTAwMlxuICAgIGxldCBncmFwaCA9IHJlYWRHcmFwaChydW5EaXIpO1xuICAgIGNvbnN0IG1lcmdlU3RlcCA9IGdyYXBoLnN0ZXBzLmZpbmQoKHMpID0+IHMuaWQgPT09IFwibWVyZ2VcIik7XG4gICAgYXNzZXJ0Lm9rKG1lcmdlU3RlcCk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChtZXJnZVN0ZXAuZGVwZW5kc09uLnNvcnQoKSwgW1wiZmFuLS0wMDFcIiwgXCJmYW4tLTAwMlwiXSk7XG5cbiAgICAvLyBDb21wbGV0ZSBpbnN0YW5jZSAxIG9ubHkgXHUyMDE0IG1lcmdlIHNob3VsZCBOT1QgYmUgZGlzcGF0Y2hhYmxlIHlldFxuICAgIGF3YWl0IHJlY29uY2lsZShlbmdpbmUsIFwiYmxvY2std2YvZmFuLS0wMDFcIik7XG4gICAgcmVzdWx0ID0gYXdhaXQgZGlzcGF0Y2goZW5naW5lKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmFjdGlvbiwgXCJkaXNwYXRjaFwiKTtcbiAgICBpZiAocmVzdWx0LmFjdGlvbiA9PT0gXCJkaXNwYXRjaFwiKSB7XG4gICAgICAvLyBTaG91bGQgZ2V0IGZhbi0tMDAyLCBub3QgbWVyZ2VcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc3RlcC51bml0SWQsIFwiYmxvY2std2YvZmFuLS0wMDJcIik7XG4gICAgfVxuXG4gICAgLy8gQ29tcGxldGUgaW5zdGFuY2UgMiBcdTIwMTQgbm93IG1lcmdlIHNob3VsZCBiZSBkaXNwYXRjaGFibGVcbiAgICBhd2FpdCByZWNvbmNpbGUoZW5naW5lLCBcImJsb2NrLXdmL2Zhbi0tMDAyXCIpO1xuICAgIHJlc3VsdCA9IGF3YWl0IGRpc3BhdGNoKGVuZ2luZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5hY3Rpb24sIFwiZGlzcGF0Y2hcIik7XG4gICAgaWYgKHJlc3VsdC5hY3Rpb24gPT09IFwiZGlzcGF0Y2hcIikge1xuICAgICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zdGVwLnVuaXRJZCwgXCJibG9jay13Zi9tZXJnZVwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc3RlcC5wcm9tcHQsIFwiTWVyZ2UgYWxsIHJlc3VsdHNcIik7XG4gICAgfVxuXG4gICAgLy8gQ29tcGxldGUgbWVyZ2UgXHUyMDE0IGFsbCBkb25lXG4gICAgYXdhaXQgcmVjb25jaWxlKGVuZ2luZSwgXCJibG9jay13Zi9tZXJnZVwiKTtcbiAgICByZXN1bHQgPSBhd2FpdCBkaXNwYXRjaChlbmdpbmUpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuYWN0aW9uLCBcInN0b3BcIik7XG4gIH0pO1xufSk7XG5cbmRlc2NyaWJlKFwiaXRlcmF0ZSBleHBhbnNpb24gXHUyMDE0IHplcm8gbWF0Y2hlc1wiLCAoKSA9PiB7XG4gIGl0KFwiaGFuZGxlcyB6ZXJvLW1hdGNoIGV4cGFuc2lvbiBncmFjZWZ1bGx5XCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBkZWY6IFdvcmtmbG93RGVmaW5pdGlvbiA9IHtcbiAgICAgIHZlcnNpb246IDEsXG4gICAgICBuYW1lOiBcInplcm8td2ZcIixcbiAgICAgIHN0ZXBzOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBpZDogXCJmYW5cIixcbiAgICAgICAgICBuYW1lOiBcIkZhbiBTdGVwXCIsXG4gICAgICAgICAgcHJvbXB0OiBcIlByb2Nlc3Mge3tpdGVtfX1cIixcbiAgICAgICAgICByZXF1aXJlczogW10sXG4gICAgICAgICAgcHJvZHVjZXM6IFtdLFxuICAgICAgICAgIGl0ZXJhdGU6IHsgc291cmNlOiBcIml0ZW1zLm1kXCIsIHBhdHRlcm46IFwiXi0gKC4rKSRcIiB9LFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgaWQ6IFwiYWZ0ZXJcIixcbiAgICAgICAgICBuYW1lOiBcIkFmdGVyIFN0ZXBcIixcbiAgICAgICAgICBwcm9tcHQ6IFwiRG8gYWZ0ZXJcIixcbiAgICAgICAgICByZXF1aXJlczogW1wiZmFuXCJdLFxuICAgICAgICAgIHByb2R1Y2VzOiBbXSxcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgfTtcblxuICAgIGNvbnN0IGdyYXBoU3RlcHMgPSBbXG4gICAgICBtYWtlU3RlcCh7IGlkOiBcImZhblwiLCBwcm9tcHQ6IFwiUHJvY2VzcyB7e2l0ZW19fVwiIH0pLFxuICAgICAgbWFrZVN0ZXAoeyBpZDogXCJhZnRlclwiLCBwcm9tcHQ6IFwiRG8gYWZ0ZXJcIiwgZGVwZW5kc09uOiBbXCJmYW5cIl0gfSksXG4gICAgXTtcblxuICAgIC8vIFNvdXJjZSBmaWxlIGV4aXN0cyBidXQgaGFzIG5vIG1hdGNoaW5nIGxpbmVzXG4gICAgY29uc3QgeyBydW5EaXIsIGVuZ2luZSB9ID0gbWFrZVRlbXBSdW4oZGVmLCBncmFwaFN0ZXBzLCB7XG4gICAgICBcIml0ZW1zLm1kXCI6IFwiTm8gYnVsbGV0IGl0ZW1zIGhlcmVcXG5KdXN0IHBsYWluIHRleHRcXG5cIixcbiAgICB9KTtcblxuICAgIC8vIERpc3BhdGNoIHNob3VsZCBleHBhbmQgd2l0aCB6ZXJvIGluc3RhbmNlc1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRpc3BhdGNoKGVuZ2luZSk7XG5cbiAgICAvLyBWZXJpZnkgcGFyZW50IGlzIGV4cGFuZGVkXG4gICAgY29uc3QgZ3JhcGggPSByZWFkR3JhcGgocnVuRGlyKTtcbiAgICBjb25zdCBwYXJlbnQgPSBncmFwaC5zdGVwcy5maW5kKChzKSA9PiBzLmlkID09PSBcImZhblwiKTtcbiAgICBhc3NlcnQub2socGFyZW50KTtcbiAgICBhc3NlcnQuZXF1YWwocGFyZW50LnN0YXR1cywgXCJleHBhbmRlZFwiKTtcblxuICAgIC8vIFdpdGggemVybyBpbnN0YW5jZXMsIG5vIGluc3RhbmNlIGRlcHMgZXhpc3QuXG4gICAgLy8gZXhwYW5kSXRlcmF0aW9uIHJld3JpdGVzIFwiZmFuXCIgXHUyMTkyIFtdIGluIHRoZSBkb3duc3RyZWFtIGRlcCBsaXN0LFxuICAgIC8vIHNvIFwiYWZ0ZXJcIiBub3cgaGFzIGVtcHR5IGRlcGVuZHNPbiBhbmQgYmVjb21lcyBkaXNwYXRjaGFibGUuXG4gICAgLy8gQnV0IGZpcnN0IGRpc3BhdGNoIGFmdGVyIGV4cGFuc2lvbiBmaW5kcyBubyBwZW5kaW5nIGluc3RhbmNlIHN0ZXBzLlxuICAgIC8vIFRoZSBlbmdpbmUgc2hvdWxkIGVpdGhlciBkaXNwYXRjaCBcImFmdGVyXCIgb3IgcmV0dXJuIHN0b3AuXG4gICAgLy8gTGV0J3MgY2hlY2sgd2hhdCBhY3R1YWxseSBoYXBwZW5lZDpcbiAgICBpZiAocmVzdWx0LmFjdGlvbiA9PT0gXCJkaXNwYXRjaFwiKSB7XG4gICAgICAvLyBUaGUgcmUtcXVlcnkgZm91bmQgXCJhZnRlclwiIHN0ZXAgKHNpbmNlIGl0cyBkZXBzIHdlcmUgcmV3cml0dGVuIHRvIFtdKVxuICAgICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zdGVwLnVuaXRJZCwgXCJ6ZXJvLXdmL2FmdGVyXCIpO1xuICAgIH0gZWxzZSB7XG4gICAgICAvLyBUaGUgZW5naW5lIHJldHVybmVkIHN0b3AgZm9yIHplcm8gaW5zdGFuY2VzXG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmFjdGlvbiwgXCJzdG9wXCIpO1xuICAgIH1cbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoXCJpdGVyYXRlIGV4cGFuc2lvbiBcdTIwMTQgbWlzc2luZyBzb3VyY2UgYXJ0aWZhY3RcIiwgKCkgPT4ge1xuICBpdChcInRocm93cyBhbiBlcnJvciBtZW50aW9uaW5nIHRoZSBtaXNzaW5nIGZpbGUgcGF0aFwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgZGVmOiBXb3JrZmxvd0RlZmluaXRpb24gPSB7XG4gICAgICB2ZXJzaW9uOiAxLFxuICAgICAgbmFtZTogXCJtaXNzaW5nLXdmXCIsXG4gICAgICBzdGVwczogW1xuICAgICAgICB7XG4gICAgICAgICAgaWQ6IFwiZmFuXCIsXG4gICAgICAgICAgbmFtZTogXCJGYW4gU3RlcFwiLFxuICAgICAgICAgIHByb21wdDogXCJQcm9jZXNzIHt7aXRlbX19XCIsXG4gICAgICAgICAgcmVxdWlyZXM6IFtdLFxuICAgICAgICAgIHByb2R1Y2VzOiBbXSxcbiAgICAgICAgICBpdGVyYXRlOiB7IHNvdXJjZTogXCJub25leGlzdGVudC5tZFwiLCBwYXR0ZXJuOiBcIl4tICguKykkXCIgfSxcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgfTtcblxuICAgIGNvbnN0IGdyYXBoU3RlcHMgPSBbXG4gICAgICBtYWtlU3RlcCh7IGlkOiBcImZhblwiLCBwcm9tcHQ6IFwiUHJvY2VzcyB7e2l0ZW19fVwiIH0pLFxuICAgIF07XG5cbiAgICAvLyBObyBzb3VyY2UgZmlsZSB3cml0dGVuXG4gICAgY29uc3QgeyBlbmdpbmUgfSA9IG1ha2VUZW1wUnVuKGRlZiwgZ3JhcGhTdGVwcyk7XG5cbiAgICBhd2FpdCBhc3NlcnQucmVqZWN0cyhcbiAgICAgICgpID0+IGRpc3BhdGNoKGVuZ2luZSksXG4gICAgICAoZXJyOiBFcnJvcikgPT4ge1xuICAgICAgICBhc3NlcnQub2soZXJyLm1lc3NhZ2UuaW5jbHVkZXMoXCJub25leGlzdGVudC5tZFwiKSwgYEVycm9yIHNob3VsZCBtZW50aW9uIHRoZSBmaWxlbmFtZTogJHtlcnIubWVzc2FnZX1gKTtcbiAgICAgICAgYXNzZXJ0Lm9rKGVyci5tZXNzYWdlLmluY2x1ZGVzKFwiSXRlcmF0ZSBzb3VyY2UgYXJ0aWZhY3Qgbm90IGZvdW5kXCIpLCBgRXJyb3Igc2hvdWxkIG1lbnRpb24gaXQncyBhbiBpdGVyYXRlIHNvdXJjZTogJHtlcnIubWVzc2FnZX1gKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9LFxuICAgICk7XG4gIH0pO1xufSk7XG5cbmRlc2NyaWJlKFwiaXRlcmF0ZSBleHBhbnNpb24gXHUyMDE0IGlkZW1wb3RlbmN5XCIsICgpID0+IHtcbiAgaXQoXCJkb2VzIG5vdCByZS1leHBhbmQgYW4gYWxyZWFkeSBleHBhbmRlZCBzdGVwIG9uIHN1YnNlcXVlbnQgZGlzcGF0Y2hcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGRlZjogV29ya2Zsb3dEZWZpbml0aW9uID0ge1xuICAgICAgdmVyc2lvbjogMSxcbiAgICAgIG5hbWU6IFwiaWRlbS13ZlwiLFxuICAgICAgc3RlcHM6IFtcbiAgICAgICAge1xuICAgICAgICAgIGlkOiBcImZhblwiLFxuICAgICAgICAgIG5hbWU6IFwiRmFuIFN0ZXBcIixcbiAgICAgICAgICBwcm9tcHQ6IFwiUHJvY2VzcyB7e2l0ZW19fVwiLFxuICAgICAgICAgIHJlcXVpcmVzOiBbXSxcbiAgICAgICAgICBwcm9kdWNlczogW10sXG4gICAgICAgICAgaXRlcmF0ZTogeyBzb3VyY2U6IFwiaXRlbXMubWRcIiwgcGF0dGVybjogXCJeLSAoLispJFwiIH0sXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgIH07XG5cbiAgICBjb25zdCBncmFwaFN0ZXBzID0gW21ha2VTdGVwKHsgaWQ6IFwiZmFuXCIsIHByb21wdDogXCJQcm9jZXNzIHt7aXRlbX19XCIgfSldO1xuXG4gICAgY29uc3QgeyBydW5EaXIsIGVuZ2luZSB9ID0gbWFrZVRlbXBSdW4oZGVmLCBncmFwaFN0ZXBzLCB7XG4gICAgICBcIml0ZW1zLm1kXCI6IFwiLSBVbm9cXG4tIERvc1xcblwiLFxuICAgIH0pO1xuXG4gICAgLy8gRmlyc3QgZGlzcGF0Y2g6IHRyaWdnZXJzIGV4cGFuc2lvblxuICAgIGxldCByZXN1bHQgPSBhd2FpdCBkaXNwYXRjaChlbmdpbmUpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuYWN0aW9uLCBcImRpc3BhdGNoXCIpO1xuICAgIGlmIChyZXN1bHQuYWN0aW9uID09PSBcImRpc3BhdGNoXCIpIHtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc3RlcC51bml0SWQsIFwiaWRlbS13Zi9mYW4tLTAwMVwiKTtcbiAgICB9XG5cbiAgICAvLyBTZWNvbmQgZGlzcGF0Y2ggd2l0aG91dCByZWNvbmNpbGluZzogc2hvdWxkIHJldHVybiB0aGUgc2FtZSBpbnN0YW5jZVxuICAgIC8vIChncmFwaCBhbHJlYWR5IGV4cGFuZGVkIG9uIGRpc2ssIHBhcmVudCBpcyBcImV4cGFuZGVkXCIgc28gZ2V0TmV4dFBlbmRpbmdTdGVwXG4gICAgLy8gIHNraXBzIGl0IGFuZCByZXR1cm5zIHRoZSBmaXJzdCBwZW5kaW5nIGluc3RhbmNlIHN0ZXApXG4gICAgcmVzdWx0ID0gYXdhaXQgZGlzcGF0Y2goZW5naW5lKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmFjdGlvbiwgXCJkaXNwYXRjaFwiKTtcbiAgICBpZiAocmVzdWx0LmFjdGlvbiA9PT0gXCJkaXNwYXRjaFwiKSB7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnN0ZXAudW5pdElkLCBcImlkZW0td2YvZmFuLS0wMDFcIik7XG4gICAgfVxuXG4gICAgLy8gVmVyaWZ5IG5vIGRvdWJsZS1leHBhbnNpb246IHN0aWxsIG9ubHkgMiBpbnN0YW5jZXNcbiAgICBjb25zdCBncmFwaCA9IHJlYWRHcmFwaChydW5EaXIpO1xuICAgIGNvbnN0IGluc3RhbmNlcyA9IGdyYXBoLnN0ZXBzLmZpbHRlcigocykgPT4gcy5wYXJlbnRTdGVwSWQgPT09IFwiZmFuXCIpO1xuICAgIGFzc2VydC5lcXVhbChpbnN0YW5jZXMubGVuZ3RoLCAyKTtcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQWFBLFNBQVMsVUFBVSxJQUFJLGlCQUFpQjtBQUN4QyxPQUFPLFlBQVk7QUFDbkIsU0FBUyxhQUFhLFFBQVEsZUFBZSxpQkFBaUI7QUFDOUQsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUN2QixTQUFTLGlCQUFpQjtBQUUxQixTQUFTLDRCQUE0QjtBQUNyQztBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsT0FHSztBQUtQLE1BQU0sVUFBb0IsQ0FBQztBQUUzQixTQUFTLGFBQXFCO0FBQzVCLFFBQU0sTUFBTSxZQUFZLEtBQUssT0FBTyxHQUFHLGVBQWUsQ0FBQztBQUN2RCxVQUFRLEtBQUssR0FBRztBQUNoQixTQUFPO0FBQ1Q7QUFFQSxVQUFVLE1BQU07QUFDZCxhQUFXLEtBQUssU0FBUztBQUN2QixRQUFJO0FBQUUsYUFBTyxHQUFHLEVBQUUsV0FBVyxNQUFNLE9BQU8sTUFBTSxZQUFZLEdBQUcsWUFBWSxJQUFJLENBQUM7QUFBQSxJQUFHLFFBQVE7QUFBQSxJQUFzQjtBQUFBLEVBQ25IO0FBQ0EsVUFBUSxTQUFTO0FBQ25CLENBQUM7QUFNRCxTQUFTLFlBQ1AsS0FDQSxZQUNBLE9BQ2tEO0FBQ2xELFFBQU0sU0FBUyxXQUFXO0FBRzFCLGdCQUFjLEtBQUssUUFBUSxpQkFBaUIsR0FBRyxVQUFVLEdBQUcsR0FBRyxPQUFPO0FBR3RFLFFBQU0sUUFBdUI7QUFBQSxJQUMzQixPQUFPO0FB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
