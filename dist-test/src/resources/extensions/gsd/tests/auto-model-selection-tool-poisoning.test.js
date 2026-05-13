import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  selectAndApplyModel,
  ModelPolicyDispatchBlockedError,
  clearToolBaseline
} from "../auto-model-selection.js";
import {
  registerToolCompatibility,
  resetToolCompatibilityRegistry
} from "@gsd/pi-coding-agent";
function makeTempProject() {
  const originalCwd = process.cwd();
  const originalGsdHome = process.env.GSD_HOME;
  const dir = mkdtempSync(join(tmpdir(), "gsd-policy-poison-"));
  const home = mkdtempSync(join(tmpdir(), "gsd-policy-home-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  writeFileSync(join(dir, ".gsd", "PREFERENCES.md"), "---\n---\n", "utf-8");
  process.env.GSD_HOME = home;
  process.chdir(dir);
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
    restoreEnv: () => {
      process.chdir(originalCwd);
      if (originalGsdHome === void 0) delete process.env.GSD_HOME;
      else process.env.GSD_HOME = originalGsdHome;
    }
  };
}
function makeRecordingPi(initialActiveTools) {
  const calls = [];
  let active = [...initialActiveTools];
  return {
    __calls: calls,
    get __activeTools() {
      return active;
    },
    setModel: async (m) => {
      calls.push({ kind: "setModel", payload: `${m.provider}/${m.id}` });
      return true;
    },
    emitBeforeModelSelect: async () => {
      calls.push({ kind: "emitBeforeModelSelect", payload: null });
      return void 0;
    },
    getActiveTools: () => {
      calls.push({ kind: "getActiveTools", payload: [...active] });
      return [...active];
    },
    emitAdjustToolSet: async () => {
      calls.push({ kind: "emitAdjustToolSet", payload: null });
      return void 0;
    },
    setActiveTools: (names) => {
      active = [...names];
      calls.push({ kind: "setActiveTools", payload: [...names] });
    },
    setThinkingLevel: () => {
    }
  };
}
function makeCtx(availableModels) {
  return {
    modelRegistry: {
      getAvailable: () => availableModels,
      getProviderAuthMode: () => "apiKey"
    },
    sessionManager: { getSessionId: () => "test-session" },
    ui: { notify: () => {
    } },
    model: { provider: availableModels[0]?.provider, id: availableModels[0]?.id, api: availableModels[0]?.api }
  };
}
test("vacuous-truth (a): unit type with empty workflow-required tools \u2192 dispatch succeeds", async () => {
  const env = makeTempProject();
  try {
    writeFileSync(
      join(env.dir, ".gsd", "PREFERENCES.md"),
      ["---", "dynamic_routing:", "  enabled: true", "  tier_models:", "    heavy: anthropic/claude-sonnet-4-6", "---"].join("\n"),
      "utf-8"
    );
    const availableModels = [
      { id: "claude-sonnet-4-6", provider: "anthropic", api: "anthropic-messages" }
    ];
    const pi = makeRecordingPi([]);
    clearToolBaseline(pi);
    const result = await selectAndApplyModel(
      makeCtx(availableModels),
      pi,
      "refine-slice",
      "x1",
      env.dir,
      void 0,
      false,
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      void 0,
      true
    );
    assert.equal(result.appliedModel?.id, "claude-sonnet-4-6", "empty requiredTools must not deny dispatch");
    const setModelCalls = pi.__calls.filter((c) => c.kind === "setModel");
    assert.equal(setModelCalls.length, 1, "setModel should have been called exactly once");
  } finally {
    env.restoreEnv();
    env.cleanup();
  }
});
test("vacuous-truth (b): non-empty workflow tool requirement that the model carries \u2192 dispatch succeeds", async () => {
  const env = makeTempProject();
  try {
    const availableModels = [
      { id: "claude-sonnet-4-6", provider: "anthropic", api: "anthropic-messages" }
    ];
    const pi = makeRecordingPi(["gsd_save_gate_result"]);
    clearToolBaseline(pi);
    const result = await selectAndApplyModel(
      makeCtx(availableModels),
      pi,
      "gate-evaluate",
      "g1",
      env.dir,
      void 0,
      false,
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      void 0,
      true
    );
    assert.equal(result.appliedModel?.id, "claude-sonnet-4-6", "compat-required dispatch must succeed");
    const setModelCalls = pi.__calls.filter((c) => c.kind === "setModel");
    assert.equal(setModelCalls.length, 1, "setModel should have been called exactly once");
  } finally {
    env.restoreEnv();
    env.cleanup();
  }
});
test("cross-unit poisoning: prior unit narrowing must not deny next unit's eligible model", async () => {
  const env = makeTempProject();
  try {
    const availableModels = [
      { id: "openai-narrow", provider: "openai", api: "openai-completions" },
      { id: "claude-wide", provider: "anthropic", api: "anthropic-messages" }
    ];
    const pi = makeRecordingPi(["gsd_save_gate_result", "thinking_partner"]);
    clearToolBaseline(pi);
    await selectAndApplyModel(
      makeCtx(availableModels),
      pi,
      "gate-evaluate",
      "n",
      env.dir,
      void 0,
      false,
      { provider: "openai", id: "openai-narrow" },
      void 0,
      true
    );
    const setModelCallsAfterUnitN = pi.__calls.filter((c) => c.kind === "setModel").length;
    assert.ok(setModelCallsAfterUnitN >= 1, "unit-N should have dispatched");
    const beforeCount = pi.__calls.filter((c) => c.kind === "setModel").length;
    await selectAndApplyModel(
      makeCtx(availableModels),
      pi,
      "gate-evaluate",
      "n+1",
      env.dir,
      void 0,
      false,
      { provider: "anthropic", id: "claude-wide" },
      void 0,
      true
    );
    const afterCount = pi.__calls.filter((c) => c.kind === "setModel").length;
    assert.ok(afterCount > beforeCount, "unit-N+1 should reach pi.setModel \u2014 cross-unit narrowing must not block dispatch");
  } finally {
    env.restoreEnv();
    env.cleanup();
  }
});
test("genuinely-impossible (a): workflow tool incompatible with candidate API \u2192 typed error names tool + api", async () => {
  const env = makeTempProject();
  try {
    registerToolCompatibility("gsd_plan_slice", { producesImages: true });
    writeFileSync(
      join(env.dir, ".gsd", "PREFERENCES.md"),
      ["---", "dynamic_routing:", "  enabled: true", "  tier_models:", "    heavy: ollama/ollama-llama-3", "---"].join("\n"),
      "utf-8"
    );
    const availableModels = [
      { id: "ollama-llama-3", provider: "ollama", api: "ollama-chat" }
    ];
    const pi = makeRecordingPi(["gsd_plan_slice"]);
    clearToolBaseline(pi);
    const ctx = makeCtx(availableModels);
    ctx.model = { provider: "ollama", id: "ollama-llama-3", api: "ollama-chat" };
    let thrown;
    try {
      await selectAndApplyModel(
        ctx,
        pi,
        "plan-slice",
        "s1",
        env.dir,
        void 0,
        false,
        { provider: "ollama", id: "ollama-llama-3" },
        void 0,
        true
      );
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof ModelPolicyDispatchBlockedError, "should throw ModelPolicyDispatchBlockedError");
    const err = thrown;
    assert.equal(err.unitType, "plan-slice");
    assert.match(err.message, /tool policy denied/, "throw must surface the tool-compatibility deny reason");
    assert.match(err.message, /gsd_plan_slice/, "throw must name the incompatible tool");
    assert.match(err.message, /ollama-chat/, "throw must name the api for which the tool was filtered");
  } finally {
    resetToolCompatibilityRegistry();
    env.restoreEnv();
    env.cleanup();
  }
});
test("genuinely-impossible (b): cross-provider routing disabled + provider mismatch \u2192 typed error", async () => {
  const env = makeTempProject();
  try {
    const availableModels = [
      { id: "other-model", provider: "other-provider", api: "anthropic-messages" }
    ];
    const pi = makeRecordingPi([]);
    clearToolBaseline(pi);
    const ctx = makeCtx(availableModels);
    ctx.model = { provider: "anthropic", id: "claude-sonnet-4-6", api: "anthropic-messages" };
    writeFileSync(
      join(env.dir, ".gsd", "PREFERENCES.md"),
      ["---", "dynamic_routing:", "  enabled: true", "  cross_provider: false", "  tier_models:", "    heavy: other-provider/other-model", "---"].join("\n"),
      "utf-8"
    );
    let thrown;
    try {
      await selectAndApplyModel(
        ctx,
        pi,
        "plan-slice",
        "s1",
        env.dir,
        void 0,
        false,
        { provider: "anthropic", id: "claude-sonnet-4-6" },
        void 0,
        true
      );
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof ModelPolicyDispatchBlockedError, "should throw ModelPolicyDispatchBlockedError");
    const err = thrown;
    assert.equal(err.unitType, "plan-slice");
    assert.equal(err.unitId, "s1");
    assert.ok(err.reasons.length > 0, "deny reasons should be captured");
  } finally {
    env.restoreEnv();
    env.cleanup();
  }
});
test("restore baseline: setActiveTools(BASELINE) called between units before next dispatch", async () => {
  const env = makeTempProject();
  try {
    const availableModels = [
      { id: "claude-sonnet-4-6", provider: "anthropic", api: "anthropic-messages" }
    ];
    const baselineTools = ["gsd_save_gate_result", "tool_a", "tool_b"];
    const pi = makeRecordingPi(baselineTools);
    clearToolBaseline(pi);
    await selectAndApplyModel(
      makeCtx(availableModels),
      pi,
      "gate-evaluate",
      "u1",
      env.dir,
      void 0,
      false,
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      void 0,
      true
    );
    pi.setActiveTools(["gsd_save_gate_result"]);
    const callsBeforeU2 = pi.__calls.length;
    await selectAndApplyModel(
      makeCtx(availableModels),
      pi,
      "gate-evaluate",
      "u2",
      env.dir,
      void 0,
      false,
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      void 0,
      true
    );
    const u2Calls = pi.__calls.slice(callsBeforeU2);
    const restoreCall = u2Calls.find(
      (c) => c.kind === "setActiveTools" && Array.isArray(c.payload) && c.payload.length === baselineTools.length && baselineTools.every((t) => c.payload.includes(t))
    );
    assert.ok(restoreCall, "setActiveTools(BASELINE) must be called during u2's selectAndApplyModel before dispatch");
    const restoreIdx = u2Calls.indexOf(restoreCall);
    const setModelIdx = u2Calls.findIndex((c) => c.kind === "setModel");
    assert.ok(setModelIdx > restoreIdx, "baseline restore must precede setModel dispatch");
  } finally {
    env.restoreEnv();
    env.cleanup();
  }
});
test("error carries deny reason fragment from applyModelPolicyFilter", async () => {
  const env = makeTempProject();
  try {
    writeFileSync(
      join(env.dir, ".gsd", "PREFERENCES.md"),
      ["---", "dynamic_routing:", "  enabled: true", "  cross_provider: false", "  tier_models:", "    heavy: other-provider/other-model", "---"].join("\n"),
      "utf-8"
    );
    const availableModels = [
      { id: "other-model", provider: "other-provider", api: "anthropic-messages" }
    ];
    const pi = makeRecordingPi([]);
    clearToolBaseline(pi);
    const ctx = makeCtx(availableModels);
    ctx.model = { provider: "anthropic", id: "claude-sonnet-4-6", api: "anthropic-messages" };
    let thrown;
    try {
      await selectAndApplyModel(
        ctx,
        pi,
        "plan-slice",
        "s1",
        env.dir,
        void 0,
        false,
        { provider: "anthropic", id: "claude-sonnet-4-6" },
        void 0,
        true
      );
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown, "should throw");
    assert.match(
      thrown.message,
      /cross-provider routing disabled/,
      "thrown error message should include the per-model deny reason"
    );
    assert.match(thrown.message, /other-provider\/other-model/, "should name the rejected model");
  } finally {
    env.restoreEnv();
    env.cleanup();
  }
});
test("lifecycle: clearToolBaseline forces recapture; subsequent runs respect intervening tool edits", async () => {
  const env = makeTempProject();
  try {
    const availableModels = [
      { id: "claude-sonnet-4-6", provider: "anthropic", api: "anthropic-messages" }
    ];
    const pi = makeRecordingPi(["A", "B", "C"]);
    clearToolBaseline(pi);
    await selectAndApplyModel(
      makeCtx(availableModels),
      pi,
      "gate-evaluate",
      "u1",
      env.dir,
      void 0,
      false,
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      void 0,
      true
    );
    clearToolBaseline(pi);
    pi.setActiveTools(["A", "B"]);
    const callsBeforeU2 = pi.__calls.length;
    await selectAndApplyModel(
      makeCtx(availableModels),
      pi,
      "gate-evaluate",
      "u2",
      env.dir,
      void 0,
      false,
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      void 0,
      true
    );
    const u2Calls = pi.__calls.slice(callsBeforeU2);
    const staleRestore = u2Calls.find(
      (c) => c.kind === "setActiveTools" && Array.isArray(c.payload) && c.payload.includes("C")
    );
    assert.equal(
      staleRestore,
      void 0,
      "after clearToolBaseline, run 2 must NOT restore the run-1 snapshot containing tool C"
    );
    pi.setActiveTools(["A"]);
    const callsBeforeU3 = pi.__calls.length;
    await selectAndApplyModel(
      makeCtx(availableModels),
      pi,
      "gate-evaluate",
      "u3",
      env.dir,
      void 0,
      false,
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      void 0,
      true
    );
    const u3Calls = pi.__calls.slice(callsBeforeU3);
    const restoreToRun2Baseline = u3Calls.find(
      (c) => c.kind === "setActiveTools" && Array.isArray(c.payload) && c.payload.length === 2 && c.payload.includes("A") && c.payload.includes("B") && !c.payload.includes("C")
    );
    assert.ok(
      restoreToRun2Baseline,
      "run 3 must restore the run-2 baseline [A, B] \u2014 proves the recaptured baseline is in use, not the run-1 snapshot"
    );
  } finally {
    env.restoreEnv();
    env.cleanup();
  }
});
test("cross-mode (#4965): isAutoMode=false does NOT restore baseline even when one is recorded", async () => {
  const env = makeTempProject();
  try {
    const availableModels = [
      { id: "claude-sonnet-4-6", provider: "anthropic", api: "anthropic-messages" }
    ];
    const baselineTools = ["gsd_save_gate_result", "tool_a", "tool_b"];
    const pi = makeRecordingPi(baselineTools);
    clearToolBaseline(pi);
    await selectAndApplyModel(
      makeCtx(availableModels),
      pi,
      "gate-evaluate",
      "u-auto",
      env.dir,
      void 0,
      false,
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      void 0,
      /* isAutoMode */
      true
    );
    pi.setActiveTools(["only_user_kept_tool"]);
    const callsBeforeGuided = pi.__calls.length;
    await selectAndApplyModel(
      makeCtx(availableModels),
      pi,
      "gate-evaluate",
      "u-guided",
      env.dir,
      void 0,
      false,
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      void 0,
      /* isAutoMode */
      false
    );
    const guidedCalls = pi.__calls.slice(callsBeforeGuided);
    const baselineRestore = guidedCalls.find(
      (c) => c.kind === "setActiveTools" && Array.isArray(c.payload) && baselineTools.every((t) => c.payload.includes(t))
    );
    assert.equal(
      baselineRestore,
      void 0,
      "guided-flow dispatch (isAutoMode=false) must NOT restore the auto-mode baseline"
    );
  } finally {
    env.restoreEnv();
    env.cleanup();
  }
});
test("cross-mode (#4965): auto \u2192 guided \u2192 auto preserves the original auto-era baseline for the second auto run", async () => {
  const env = makeTempProject();
  try {
    const availableModels = [
      { id: "claude-sonnet-4-6", provider: "anthropic", api: "anthropic-messages" }
    ];
    const baselineTools = ["gsd_save_gate_result", "tool_a", "tool_b"];
    const pi = makeRecordingPi(baselineTools);
    clearToolBaseline(pi);
    await selectAndApplyModel(
      makeCtx(availableModels),
      pi,
      "gate-evaluate",
      "u1",
      env.dir,
      void 0,
      false,
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      void 0,
      /* isAutoMode */
      true
    );
    pi.setActiveTools(["narrow_for_guided"]);
    await selectAndApplyModel(
      makeCtx(availableModels),
      pi,
      "gate-evaluate",
      "u-guided",
      env.dir,
      void 0,
      false,
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      void 0,
      /* isAutoMode */
      false
    );
    pi.setActiveTools(["something_completely_different"]);
    const callsBeforeU2 = pi.__calls.length;
    await selectAndApplyModel(
      makeCtx(availableModels),
      pi,
      "gate-evaluate",
      "u2",
      env.dir,
      void 0,
      false,
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      void 0,
      /* isAutoMode */
      true
    );
    const u2Calls = pi.__calls.slice(callsBeforeU2);
    const restoreCall = u2Calls.find(
      (c) => c.kind === "setActiveTools" && Array.isArray(c.payload) && c.payload.length === baselineTools.length && baselineTools.every((t) => c.payload.includes(t))
    );
    assert.ok(
      restoreCall,
      "auto run 2 must restore the auto-era baseline [A, B, C] \u2014 proves guided-flow didn't corrupt it"
    );
  } finally {
    env.restoreEnv();
    env.cleanup();
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9hdXRvLW1vZGVsLXNlbGVjdGlvbi10b29sLXBvaXNvbmluZy50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFJlZ3Jlc3Npb24gY292ZXJhZ2UgZm9yIHRoZSBtb2RlbC1wb2xpY3kgZGlzcGF0Y2ggYnVncyAoIzQ5NTksICM0NjgxLCAjNDg1MCkuXG4gKlxuICogVGhlIGZpdmUgdGVzdHMgaGVyZSBwaW4gdGhlIGZvdXIgZml4IGxheWVycyBkb2N1bWVudGVkIGluIHRoZSBSQ0Egb24gIzQ5NTk6XG4gKlxuICogICAxLiBWYWN1b3VzLXRydXRoIGd1YXJkOiB3aXRoIGFuIGVtcHR5IHVuaXQtcmVxdWlyZWQgdG9vbCBzdWJzZXQgYW5kIGFuXG4gKiAgICAgIG90aGVyd2lzZS1wZXJtaXR0ZWQgbW9kZWwsIGRpc3BhdGNoIG11c3Qgc3VjY2VlZC4gIFdpdGhvdXQgdGhpcyB0ZXN0LFxuICogICAgICBhbiBvdmVyLWFnZ3Jlc3NpdmUgQ2hhbmdlIDEgKGUuZy4gYWx3YXlzIGRlbnlpbmcpIHdvdWxkIHN0aWxsIHBhc3MgYW55XG4gKiAgICAgIFwibm8gbG9uZ2VyIHRocm93c1wiIGFzc2VydGlvbiB0cml2aWFsbHkuXG4gKiAgIDIuIENyb3NzLXVuaXQgcG9pc29uaW5nOiBwZXItdW5pdCBuYXJyb3dpbmcgYXQgdGhlIGJvdHRvbSBvZlxuICogICAgICBgc2VsZWN0QW5kQXBwbHlNb2RlbGAgbXVzdCBOT1QgYmxlZWQgaW50byB0aGUgbmV4dCB1bml0J3MgcG9saWN5XG4gKiAgICAgIGV2YWx1YXRpb24uICBUaGUgYmFzZWxpbmUtcmVzdG9yZSBwYXRoIChDaGFuZ2UgMikgbXVzdCByZXN0b3JlIHRoZVxuICogICAgICBwcmUtZGlzcGF0Y2ggYWN0aXZlLXRvb2wgc2V0IGJlZm9yZSBwb2xpY3kgcnVucy5cbiAqICAgMy4gR2VudWluZWx5LWltcG9zc2libGUgbmVnYXRpdmU6IHdoZW4gdGhlIHdvcmtmbG93IFJFUVVJUkVTIGEgdG9vbCBub1xuICogICAgICBjYW5kaWRhdGUgbW9kZWwgY2FuIGNhcnJ5LCBkaXNwYXRjaCBtdXN0IHRocm93XG4gKiAgICAgIGBNb2RlbFBvbGljeURpc3BhdGNoQmxvY2tlZEVycm9yYCBcdTIwMTQgcHJvdmluZyBDaGFuZ2UgMSBkaWRuJ3QgYWNjaWRlbnRhbGx5XG4gKiAgICAgIHJlbW92ZSBnYXRpbmcsIGFuZCBDaGFuZ2UgMyB3aXJlZCB0aGUgdHlwZWQgZXJyb3IuXG4gKiAgIDQuIFJlc3RvcmUgaGFwcGVuZWQ6IGFzc2VydCBjYWxsIG9yZGVyaW5nIG9uIGEgcmVjb3JkaW5nIGZha2UgXHUyMDE0IHRoZVxuICogICAgICBiYXNlbGluZSBgc2V0QWN0aXZlVG9vbHNgIGNhbGwgbXVzdCBwcmVjZWRlIHRoZSBuZXh0IGBzZWxlY3RBbmRBcHBseU1vZGVsYFxuICogICAgICByZWFkaW5nIHRoZSBhY3RpdmUgc2V0LlxuICogICA1LiBFcnJvciBtZXNzYWdlIGNhcnJpZXMgcmVhc29uOiB0aGUgdGhyb3cgbXVzdCBpbmNsdWRlIHRoZSBwZXItbW9kZWxcbiAqICAgICAgYHRvb2wgcG9saWN5IGRlbmllZCAoLi4uKWAgcmVhc29uIGZyYWdtZW50IGZyb20gYGFwcGx5TW9kZWxQb2xpY3lGaWx0ZXJgLFxuICogICAgICBzbyB1c2VycyBjYW4gYWN0IG9uIHRoZSBmYWlsdXJlIHdpdGhvdXQgZGlnZ2luZyB0aHJvdWdoIGF1ZGl0IGV2ZW50cy5cbiAqL1xuXG5pbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBta2RpclN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcblxuaW1wb3J0IHtcbiAgc2VsZWN0QW5kQXBwbHlNb2RlbCxcbiAgTW9kZWxQb2xpY3lEaXNwYXRjaEJsb2NrZWRFcnJvcixcbiAgY2xlYXJUb29sQmFzZWxpbmUsXG59IGZyb20gXCIuLi9hdXRvLW1vZGVsLXNlbGVjdGlvbi5qc1wiO1xuaW1wb3J0IHtcbiAgcmVnaXN0ZXJUb29sQ29tcGF0aWJpbGl0eSxcbiAgcmVzZXRUb29sQ29tcGF0aWJpbGl0eVJlZ2lzdHJ5LFxufSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcblxuZnVuY3Rpb24gbWFrZVRlbXBQcm9qZWN0KCk6IHsgZGlyOiBzdHJpbmc7IGNsZWFudXA6ICgpID0+IHZvaWQ7IHJlc3RvcmVFbnY6ICgpID0+IHZvaWQgfSB7XG4gIGNvbnN0IG9yaWdpbmFsQ3dkID0gcHJvY2Vzcy5jd2QoKTtcbiAgY29uc3Qgb3JpZ2luYWxHc2RIb21lID0gcHJvY2Vzcy5lbnYuR1NEX0hPTUU7XG4gIGNvbnN0IGRpciA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXBvbGljeS1wb2lzb24tXCIpKTtcbiAgY29uc3QgaG9tZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXBvbGljeS1ob21lLVwiKSk7XG4gIG1rZGlyU3luYyhqb2luKGRpciwgXCIuZ3NkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgLy8gRW1wdHkgUFJFRkVSRU5DRVMgc28gZGVmYXVsdCB1b2subW9kZWxfcG9saWN5LmVuYWJsZWQgPSB0cnVlIGFwcGxpZXMuXG4gIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiLmdzZFwiLCBcIlBSRUZFUkVOQ0VTLm1kXCIpLCBcIi0tLVxcbi0tLVxcblwiLCBcInV0Zi04XCIpO1xuICBwcm9jZXNzLmVudi5HU0RfSE9NRSA9IGhvbWU7XG4gIHByb2Nlc3MuY2hkaXIoZGlyKTtcbiAgcmV0dXJuIHtcbiAgICBkaXIsXG4gICAgY2xlYW51cDogKCkgPT4ge1xuICAgICAgcm1TeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgICAgcm1TeW5jKGhvbWUsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9LFxuICAgIHJlc3RvcmVFbnY6ICgpID0+IHtcbiAgICAgIHByb2Nlc3MuY2hkaXIob3JpZ2luYWxDd2QpO1xuICAgICAgaWYgKG9yaWdpbmFsR3NkSG9tZSA9PT0gdW5kZWZpbmVkKSBkZWxldGUgcHJvY2Vzcy5lbnYuR1NEX0hPTUU7XG4gICAgICBlbHNlIHByb2Nlc3MuZW52LkdTRF9IT01FID0gb3JpZ2luYWxHc2RIb21lO1xuICAgIH0sXG4gIH07XG59XG5cbmludGVyZmFjZSBSZWNvcmRpbmdQaSB7XG4gIHNldE1vZGVsOiAobTogeyBwcm92aWRlcjogc3RyaW5nOyBpZDogc3RyaW5nIH0pID0+IFByb21pc2U8Ym9vbGVhbj47XG4gIGVtaXRCZWZvcmVNb2RlbFNlbGVjdDogKCkgPT4gUHJvbWlzZTx1bmRlZmluZWQ+O1xuICBnZXRBY3RpdmVUb29sczogKCkgPT4gc3RyaW5nW107XG4gIGVtaXRBZGp1c3RUb29sU2V0OiAoKSA9PiBQcm9taXNlPHVuZGVmaW5lZD47XG4gIHNldEFjdGl2ZVRvb2xzOiAobmFtZXM6IHN0cmluZ1tdKSA9PiB2b2lkO1xuICBzZXRUaGlua2luZ0xldmVsOiAoKSA9PiB2b2lkO1xuICBfX2NhbGxzOiBBcnJheTx7IGtpbmQ6IHN0cmluZzsgcGF5bG9hZDogdW5rbm93biB9PjtcbiAgX19hY3RpdmVUb29sczogc3RyaW5nW107XG59XG5cbmZ1bmN0aW9uIG1ha2VSZWNvcmRpbmdQaShpbml0aWFsQWN0aXZlVG9vbHM6IHN0cmluZ1tdKTogUmVjb3JkaW5nUGkge1xuICBjb25zdCBjYWxsczogQXJyYXk8eyBraW5kOiBzdHJpbmc7IHBheWxvYWQ6IHVua25vd24gfT4gPSBbXTtcbiAgbGV0IGFjdGl2ZSA9IFsuLi5pbml0aWFsQWN0aXZlVG9vbHNdO1xuICByZXR1cm4ge1xuICAgIF9fY2FsbHM6IGNhbGxzLFxuICAgIGdldCBfX2FjdGl2ZVRvb2xzKCkgeyByZXR1cm4gYWN0aXZlOyB9LFxuICAgIHNldE1vZGVsOiBhc3luYyAobSkgPT4ge1xuICAgICAgY2FsbHMucHVzaCh7IGtpbmQ6IFwic2V0TW9kZWxcIiwgcGF5bG9hZDogYCR7bS5wcm92aWRlcn0vJHttLmlkfWAgfSk7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9LFxuICAgIGVtaXRCZWZvcmVNb2RlbFNlbGVjdDogYXN5bmMgKCkgPT4ge1xuICAgICAgY2FsbHMucHVzaCh7IGtpbmQ6IFwiZW1pdEJlZm9yZU1vZGVsU2VsZWN0XCIsIHBheWxvYWQ6IG51bGwgfSk7XG4gICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgIH0sXG4gICAgZ2V0QWN0aXZlVG9vbHM6ICgpID0+IHtcbiAgICAgIGNhbGxzLnB1c2goeyBraW5kOiBcImdldEFjdGl2ZVRvb2xzXCIsIHBheWxvYWQ6IFsuLi5hY3RpdmVdIH0pO1xuICAgICAgcmV0dXJuIFsuLi5hY3RpdmVdO1xuICAgIH0sXG4gICAgZW1pdEFkanVzdFRvb2xTZXQ6IGFzeW5jICgpID0+IHtcbiAgICAgIGNhbGxzLnB1c2goeyBraW5kOiBcImVtaXRBZGp1c3RUb29sU2V0XCIsIHBheWxvYWQ6IG51bGwgfSk7XG4gICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgIH0sXG4gICAgc2V0QWN0aXZlVG9vbHM6IChuYW1lcykgPT4ge1xuICAgICAgYWN0aXZlID0gWy4uLm5hbWVzXTtcbiAgICAgIGNhbGxzLnB1c2goeyBraW5kOiBcInNldEFjdGl2ZVRvb2xzXCIsIHBheWxvYWQ6IFsuLi5uYW1lc10gfSk7XG4gICAgfSxcbiAgICBzZXRUaGlua2luZ0xldmVsOiAoKSA9PiB7fSxcbiAgfSBhcyBSZWNvcmRpbmdQaTtcbn1cblxuZnVuY3Rpb24gbWFrZUN0eChhdmFpbGFibGVNb2RlbHM6IEFycmF5PHsgaWQ6IHN0cmluZzsgcHJvdmlkZXI6IHN0cmluZzsgYXBpOiBzdHJpbmcgfT4pIHtcbiAgcmV0dXJuIHtcbiAgICBtb2RlbFJlZ2lzdHJ5OiB7XG4gICAgICBnZXRBdmFpbGFibGU6ICgpID0+IGF2YWlsYWJsZU1vZGVscyxcbiAgICAgIGdldFByb3ZpZGVyQXV0aE1vZGU6ICgpID0+IFwiYXBpS2V5XCIsXG4gICAgfSxcbiAgICBzZXNzaW9uTWFuYWdlcjogeyBnZXRTZXNzaW9uSWQ6ICgpID0+IFwidGVzdC1zZXNzaW9uXCIgfSxcbiAgICB1aTogeyBub3RpZnk6ICgpID0+IHt9IH0sXG4gICAgbW9kZWw6IHsgcHJvdmlkZXI6IGF2YWlsYWJsZU1vZGVsc1swXT8ucHJvdmlkZXIsIGlkOiBhdmFpbGFibGVNb2RlbHNbMF0/LmlkLCBhcGk6IGF2YWlsYWJsZU1vZGVsc1swXT8uYXBpIH0sXG4gIH0gYXMgYW55O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgMS4gVmFjdW91cy10cnV0aCBndWFyZCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbi8vXG4vLyBUd28gc2NlbmFyaW9zIHBpbiB0aGUgZW1wdHktcmVxdWlyZWRUb29scyBicmFuY2ggYW5kIGEgcGVybWl0dGVkLXRvb2wgYnJhbmNoLlxuLy8gV2l0aG91dCB0aGUgZW1wdHktbGlzdCBzY2VuYXJpbywgYSByZWdyZXNzaW9uIHRoYXQgbWlzaGFuZGxlcyBgcmVxdWlyZWRUb29scyA9IFtdYFxuLy8gKGUuZy4gYnkgdHJlYXRpbmcgYW4gZW1wdHkgYXJyYXkgYXMgXCJkZW55IGFsbFwiIG9yIGJ5IG51bGwtZGVyZWZpbmcgdGhlIGhlbHBlclxuLy8gcmV0dXJuKSB3b3VsZCBzdGlsbCBwYXNzLlxuXG50ZXN0KFwidmFjdW91cy10cnV0aCAoYSk6IHVuaXQgdHlwZSB3aXRoIGVtcHR5IHdvcmtmbG93LXJlcXVpcmVkIHRvb2xzIFx1MjE5MiBkaXNwYXRjaCBzdWNjZWVkc1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGVudiA9IG1ha2VUZW1wUHJvamVjdCgpO1xuICB0cnkge1xuICAgIC8vIGByZWZpbmUtc2xpY2VgIGlzIG5vdCBpbiB0aGUgZ2V0UmVxdWlyZWRXb3JrZmxvd1Rvb2xzRm9yQXV0b1VuaXQgc3dpdGNoXG4gICAgLy8gXHUyMTkyIHJldHVybnMgW10uIEV4ZXJjaXNlcyB0aGUgZW1wdHktcmVxdWlyZWRUb29scyBicmFuY2ggaW5cbiAgICAvLyBhcHBseU1vZGVsUG9saWN5RmlsdGVyIChDb2RlUmFiYml0IE1pbm9yOiBleGlzdGluZyB0ZXN0IHVzZWRcbiAgICAvLyBnYXRlLWV2YWx1YXRlIHdoaWNoIGhhcyBub24tZW1wdHkgcmVxdWlyZWQgdG9vbHMgYW5kIG5ldmVyIGhpdCB0aGlzIHBhdGgpLlxuICAgIC8vXG4gICAgLy8gUFJFRkVSRU5DRVMgd2l0aCB0aWVyX21vZGVscyBpcyByZXF1aXJlZCBzbyByZXNvbHZlUHJlZmVycmVkTW9kZWxDb25maWdcbiAgICAvLyByZXR1cm5zIGEgbm9uLXVuZGVmaW5lZCBtb2RlbENvbmZpZyBcdTIwMTQgb25seSB0aGVuIGRvZXMgc2VsZWN0QW5kQXBwbHlNb2RlbFxuICAgIC8vIHJ1biB0aGUgcG9saWN5IGZpbHRlciB3ZSB3YW50IHRvIGV4ZXJjaXNlLlxuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKGVudi5kaXIsIFwiLmdzZFwiLCBcIlBSRUZFUkVOQ0VTLm1kXCIpLFxuICAgICAgW1wiLS0tXCIsIFwiZHluYW1pY19yb3V0aW5nOlwiLCBcIiAgZW5hYmxlZDogdHJ1ZVwiLCBcIiAgdGllcl9tb2RlbHM6XCIsIFwiICAgIGhlYXZ5OiBhbnRocm9waWMvY2xhdWRlLXNvbm5ldC00LTZcIiwgXCItLS1cIl0uam9pbihcIlxcblwiKSxcbiAgICAgIFwidXRmLThcIixcbiAgICApO1xuICAgIGNvbnN0IGF2YWlsYWJsZU1vZGVscyA9IFtcbiAgICAgIHsgaWQ6IFwiY2xhdWRlLXNvbm5ldC00LTZcIiwgcHJvdmlkZXI6IFwiYW50aHJvcGljXCIsIGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIiB9LFxuICAgIF07XG4gICAgY29uc3QgcGkgPSBtYWtlUmVjb3JkaW5nUGkoW10pO1xuICAgIGNsZWFyVG9vbEJhc2VsaW5lKHBpIGFzIHVua25vd24gYXMgb2JqZWN0KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHNlbGVjdEFuZEFwcGx5TW9kZWwoXG4gICAgICBtYWtlQ3R4KGF2YWlsYWJsZU1vZGVscyksXG4gICAgICBwaSBhcyBhbnksXG4gICAgICBcInJlZmluZS1zbGljZVwiLFxuICAgICAgXCJ4MVwiLFxuICAgICAgZW52LmRpcixcbiAgICAgIHVuZGVmaW5lZCxcbiAgICAgIGZhbHNlLFxuICAgICAgeyBwcm92aWRlcjogXCJhbnRocm9waWNcIiwgaWQ6IFwiY2xhdWRlLXNvbm5ldC00LTZcIiB9LFxuICAgICAgdW5kZWZpbmVkLFxuICAgICAgdHJ1ZSxcbiAgICApO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5hcHBsaWVkTW9kZWw/LmlkLCBcImNsYXVkZS1zb25uZXQtNC02XCIsIFwiZW1wdHkgcmVxdWlyZWRUb29scyBtdXN0IG5vdCBkZW55IGRpc3BhdGNoXCIpO1xuICAgIGNvbnN0IHNldE1vZGVsQ2FsbHMgPSBwaS5fX2NhbGxzLmZpbHRlcihjID0+IGMua2luZCA9PT0gXCJzZXRNb2RlbFwiKTtcbiAgICBhc3NlcnQuZXF1YWwoc2V0TW9kZWxDYWxscy5sZW5ndGgsIDEsIFwic2V0TW9kZWwgc2hvdWxkIGhhdmUgYmVlbiBjYWxsZWQgZXhhY3RseSBvbmNlXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIGVudi5yZXN0b3JlRW52KCk7XG4gICAgZW52LmNsZWFudXAoKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJ2YWN1b3VzLXRydXRoIChiKTogbm9uLWVtcHR5IHdvcmtmbG93IHRvb2wgcmVxdWlyZW1lbnQgdGhhdCB0aGUgbW9kZWwgY2FycmllcyBcdTIxOTIgZGlzcGF0Y2ggc3VjY2VlZHNcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBlbnYgPSBtYWtlVGVtcFByb2plY3QoKTtcbiAgdHJ5IHtcbiAgICAvLyBnYXRlLWV2YWx1YXRlIGhhcyB0b29sIHJlcXVpcmVtZW50IFtcImdzZF9zYXZlX2dhdGVfcmVzdWx0XCJdOyBpZiB0aGVcbiAgICAvLyBtb2RlbCdzIEFQSSBjYW4gY2FycnkgaXQsIHBvbGljeSBtdXN0IHN0aWxsIGFsbG93IGRpc3BhdGNoLiBDb3VudGVyLXRlc3RcbiAgICAvLyB0byAoYSk6IHByb3ZlcyB0aGUgcGF0aCB3aXRoIGEgbm9uLWVtcHR5IHJlcXVpcmVtZW50IGlzbid0IGRlbnlpbmdcbiAgICAvLyBsZWdpdGltYXRlIGRpc3BhdGNoZXMuXG4gICAgY29uc3QgYXZhaWxhYmxlTW9kZWxzID0gW1xuICAgICAgeyBpZDogXCJjbGF1ZGUtc29ubmV0LTQtNlwiLCBwcm92aWRlcjogXCJhbnRocm9waWNcIiwgYXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiIH0sXG4gICAgXTtcbiAgICBjb25zdCBwaSA9IG1ha2VSZWNvcmRpbmdQaShbXCJnc2Rfc2F2ZV9nYXRlX3Jlc3VsdFwiXSk7XG4gICAgY2xlYXJUb29sQmFzZWxpbmUocGkgYXMgdW5rbm93biBhcyBvYmplY3QpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgc2VsZWN0QW5kQXBwbHlNb2RlbChcbiAgICAgIG1ha2VDdHgoYXZhaWxhYmxlTW9kZWxzKSxcbiAgICAgIHBpIGFzIGFueSxcbiAgICAgIFwiZ2F0ZS1ldmFsdWF0ZVwiLFxuICAgICAgXCJnMVwiLFxuICAgICAgZW52LmRpcixcbiAgICAgIHVuZGVmaW5lZCxcbiAgICAgIGZhbHNlLFxuICAgICAgeyBwcm92aWRlcjogXCJhbnRocm9waWNcIiwgaWQ6IFwiY2xhdWRlLXNvbm5ldC00LTZcIiB9LFxuICAgICAgdW5kZWZpbmVkLFxuICAgICAgdHJ1ZSxcbiAgICApO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5hcHBsaWVkTW9kZWw/LmlkLCBcImNsYXVkZS1zb25uZXQtNC02XCIsIFwiY29tcGF0LXJlcXVpcmVkIGRpc3BhdGNoIG11c3Qgc3VjY2VlZFwiKTtcbiAgICBjb25zdCBzZXRNb2RlbENhbGxzID0gcGkuX19jYWxscy5maWx0ZXIoYyA9PiBjLmtpbmQgPT09IFwic2V0TW9kZWxcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHNldE1vZGVsQ2FsbHMubGVuZ3RoLCAxLCBcInNldE1vZGVsIHNob3VsZCBoYXZlIGJlZW4gY2FsbGVkIGV4YWN0bHkgb25jZVwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBlbnYucmVzdG9yZUVudigpO1xuICAgIGVudi5jbGVhbnVwKCk7XG4gIH1cbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgMi4gQ3Jvc3MtdW5pdCBwb2lzb25pbmcgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG50ZXN0KFwiY3Jvc3MtdW5pdCBwb2lzb25pbmc6IHByaW9yIHVuaXQgbmFycm93aW5nIG11c3Qgbm90IGRlbnkgbmV4dCB1bml0J3MgZWxpZ2libGUgbW9kZWxcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBlbnYgPSBtYWtlVGVtcFByb2plY3QoKTtcbiAgdHJ5IHtcbiAgICAvLyBVbml0LU4gcnVucyBhZ2FpbnN0IGFuIGBvcGVuYWktY29tcGxldGlvbnNgIHByb3ZpZGVyIHRoYXQgc3RyaXBzIGEgdG9vbFxuICAgIC8vIChlLmcuIFwidGhpbmtpbmdfcGFydG5lclwiKSB2aWEgYWRqdXN0VG9vbFNldCdzIGhhcmQgZmlsdGVyLiAgV2l0aG91dCB0aGVcbiAgICAvLyBiYXNlbGluZS1yZXN0b3JlIChDaGFuZ2UgMiksIHBpLmdldEFjdGl2ZVRvb2xzKCkgYWZ0ZXJ3YXJkIGlzIG1pc3NpbmdcbiAgICAvLyB0aGF0IHRvb2wsIGJ1dCBpZiB3ZSB1c2VkIGl0IGFzIHRoZSBwb2xpY3kgcmVxdWlyZWQtc2V0IHdlJ2QgZXJyb25lb3VzbHlcbiAgICAvLyBkZW55IHRoZSBuZXh0IHVuaXQuICBXaXRoIENoYW5nZSAxKzIsIHBvbGljeSB1c2VzIHRoZSB3b3JrZmxvdy1yZXF1aXJlZFxuICAgIC8vIHN1YnNldCAoTk9UIHRoZSBsaXZlIHNuYXBzaG90KSwgYW5kIGJhc2VsaW5lIHJlc3RvcmF0aW9uIHJlLXNlZWRzIHRoZVxuICAgIC8vIGFjdGl2ZSBzZXQgYmVmb3JlIHRoZSBuZXh0IHVuaXQuXG4gICAgY29uc3QgYXZhaWxhYmxlTW9kZWxzID0gW1xuICAgICAgeyBpZDogXCJvcGVuYWktbmFycm93XCIsIHByb3ZpZGVyOiBcIm9wZW5haVwiLCBhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIgfSxcbiAgICAgIHsgaWQ6IFwiY2xhdWRlLXdpZGVcIiwgcHJvdmlkZXI6IFwiYW50aHJvcGljXCIsIGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIiB9LFxuICAgIF07XG4gICAgLy8gVGhlIGJhc2VsaW5lIGNvbnRhaW5zIGEgc3ludGhldGljIFwidGhpbmtpbmdfcGFydG5lclwiIHRoYXQgb3BlbmFpLWNvbXBsZXRpb25zXG4gICAgLy8gZG9lcyBub3Qgc3VwcG9ydC5cbiAgICBjb25zdCBwaSA9IG1ha2VSZWNvcmRpbmdQaShbXCJnc2Rfc2F2ZV9nYXRlX3Jlc3VsdFwiLCBcInRoaW5raW5nX3BhcnRuZXJcIl0pO1xuICAgIGNsZWFyVG9vbEJhc2VsaW5lKHBpIGFzIHVua25vd24gYXMgb2JqZWN0KTtcblxuICAgIC8vIFVuaXQtTjogZGlzcGF0Y2ggb24gb3BlbmFpL29wZW5haS1uYXJyb3cuICBTb2Z0IGFkanVzdFRvb2xTZXQgd2lsbCBuYXJyb3dcbiAgICAvLyB0aGUgYWN0aXZlIHNldCwgc2ltdWxhdGluZyBwcm9kdWN0aW9uIHBvaXNvbmluZy5cbiAgICBhd2FpdCBzZWxlY3RBbmRBcHBseU1vZGVsKFxuICAgICAgbWFrZUN0eChhdmFpbGFibGVNb2RlbHMpLFxuICAgICAgcGkgYXMgYW55LFxuICAgICAgXCJnYXRlLWV2YWx1YXRlXCIsXG4gICAgICBcIm5cIixcbiAgICAgIGVudi5kaXIsXG4gICAgICB1bmRlZmluZWQsXG4gICAgICBmYWxzZSxcbiAgICAgIHsgcHJvdmlkZXI6IFwib3BlbmFpXCIsIGlkOiBcIm9wZW5haS1uYXJyb3dcIiB9LFxuICAgICAgdW5kZWZpbmVkLFxuICAgICAgdHJ1ZSxcbiAgICApO1xuXG4gICAgY29uc3Qgc2V0TW9kZWxDYWxsc0FmdGVyVW5pdE4gPSBwaS5fX2NhbGxzLmZpbHRlcihjID0+IGMua2luZCA9PT0gXCJzZXRNb2RlbFwiKS5sZW5ndGg7XG4gICAgYXNzZXJ0Lm9rKHNldE1vZGVsQ2FsbHNBZnRlclVuaXROID49IDEsIFwidW5pdC1OIHNob3VsZCBoYXZlIGRpc3BhdGNoZWRcIik7XG5cbiAgICAvLyBVbml0LU4rMTogbm93IGRpc3BhdGNoIHdpdGggY2xhdWRlLXdpZGUuICBJZiBhY3RpdmUtdG9vbCBzbmFwc2hvdCB3ZXJlXG4gICAgLy8gc3RpbGwgdGhlIHBvbGljeSByZXF1aXJlZC1zZXQsIHRoZSBwcmV2aW91cyBuYXJyb3dpbmcgd291bGRuJ3QgbWF0dGVyXG4gICAgLy8gKGFudGhyb3BpYy1tZXNzYWdlcyBjYW4gY2FycnkgYm90aCB0b29scyksIHNvIHdlIGluc3RlYWQgc2ltdWxhdGUgdGhlXG4gICAgLy8gNDk1OSBwYXRoOiBhIHNlY29uZCB1bml0IHdob3NlIHdvcmtmbG93IHJlcXVpcmVzIFwiZ3NkX3NhdmVfZ2F0ZV9yZXN1bHRcIlxuICAgIC8vIChzbWFsbCkgXHUyMDE0IG11c3Qgc3VjY2VlZCByZWFjaGluZyBwaS5zZXRNb2RlbCBmb3IgY2xhdWRlLXdpZGUuXG4gICAgY29uc3QgYmVmb3JlQ291bnQgPSBwaS5fX2NhbGxzLmZpbHRlcihjID0+IGMua2luZCA9PT0gXCJzZXRNb2RlbFwiKS5sZW5ndGg7XG4gICAgYXdhaXQgc2VsZWN0QW5kQXBwbHlNb2RlbChcbiAgICAgIG1ha2VDdHgoYXZhaWxhYmxlTW9kZWxzKSxcbiAgICAgIHBpIGFzIGFueSxcbiAgICAgIFwiZ2F0ZS1ldmFsdWF0ZVwiLFxuICAgICAgXCJuKzFcIixcbiAgICAgIGVudi5kaXIsXG4gICAgICB1bmRlZmluZWQsXG4gICAgICBmYWxzZSxcbiAgICAgIHsgcHJvdmlkZXI6IFwiYW50aHJvcGljXCIsIGlkOiBcImNsYXVkZS13aWRlXCIgfSxcbiAgICAgIHVuZGVmaW5lZCxcbiAgICAgIHRydWUsXG4gICAgKTtcbiAgICBjb25zdCBhZnRlckNvdW50ID0gcGkuX19jYWxscy5maWx0ZXIoYyA9PiBjLmtpbmQgPT09IFwic2V0TW9kZWxcIikubGVuZ3RoO1xuICAgIGFzc2VydC5vayhhZnRlckNvdW50ID4gYmVmb3JlQ291bnQsIFwidW5pdC1OKzEgc2hvdWxkIHJlYWNoIHBpLnNldE1vZGVsIFx1MjAxNCBjcm9zcy11bml0IG5hcnJvd2luZyBtdXN0IG5vdCBibG9jayBkaXNwYXRjaFwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBlbnYucmVzdG9yZUVudigpO1xuICAgIGVudi5jbGVhbnVwKCk7XG4gIH1cbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgM2EuIEdlbnVpbmVseS1pbXBvc3NpYmxlOiB0b29sLWNvbXBhdGliaWxpdHkgZGVuaWFsIHBhdGggXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4vL1xuLy8gRXhlcmNpc2VzIHRoZSByZWFsIGBnZXRSZXF1aXJlZFdvcmtmbG93VG9vbHNGb3JBdXRvVW5pdGAgXHUyMTkyXG4vLyBgZmlsdGVyVG9vbHNGb3JQcm92aWRlcmAgcGF0aCB0aGF0ICM0OTU5IHdhcyBhYm91dCAoQ29kZVJhYmJpdCBNaW5vcjpcbi8vIGV4aXN0aW5nIDNiIHRlc3QgdXNlZCBjcm9zcy1wcm92aWRlciBkZW5pYWwgd2hpY2ggbmV2ZXIgaGl0IHRoaXMgcGF0aCkuXG4vLyBSZWdpc3RlcnMgYGdzZF9wbGFuX3NsaWNlYCBhcyBgcHJvZHVjZXNJbWFnZXM6IHRydWVgLCB0aGVuIG9mZmVycyBvbmx5IGFuXG4vLyBgb2xsYW1hLWNoYXRgIGNhbmRpZGF0ZSAod2hpY2ggaGFzIGBpbWFnZVRvb2xSZXN1bHRzOiBmYWxzZWApIFx1MjAxNCB0aGVcbi8vIHdvcmtmbG93LXJlcXVpcmVkIHRvb2wgaXMgaW5jb21wYXRpYmxlIHdpdGggdGhlIGNhbmRpZGF0ZSdzIEFQSSwgc28gdGhlXG4vLyBwb2xpY3kgZmlsdGVyIGRlbmllcyB0aGUgbW9kZWwgd2l0aCBhIGB0b29sIHBvbGljeSBkZW5pZWQgKC4uLilgIHJlYXNvbi5cbnRlc3QoXCJnZW51aW5lbHktaW1wb3NzaWJsZSAoYSk6IHdvcmtmbG93IHRvb2wgaW5jb21wYXRpYmxlIHdpdGggY2FuZGlkYXRlIEFQSSBcdTIxOTIgdHlwZWQgZXJyb3IgbmFtZXMgdG9vbCArIGFwaVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGVudiA9IG1ha2VUZW1wUHJvamVjdCgpO1xuICB0cnkge1xuICAgIC8vIFJlZ2lzdGVyIHRoZSB3b3JrZmxvdyB0b29sIGFzIGltYWdlLXByb2R1Y2luZyBmb3IgdGhlIGR1cmF0aW9uIG9mIHRoaXNcbiAgICAvLyB0ZXN0LiBhZnRlckVhY2goKSByZXNldHMgdGhlIHJlZ2lzdHJ5IGJlbG93LlxuICAgIHJlZ2lzdGVyVG9vbENvbXBhdGliaWxpdHkoXCJnc2RfcGxhbl9zbGljZVwiLCB7IHByb2R1Y2VzSW1hZ2VzOiB0cnVlIH0pO1xuXG4gICAgLy8gUFJFRkVSRU5DRVMgbmVlZHMgdGllcl9tb2RlbHMgc28gcmVzb2x2ZVByZWZlcnJlZE1vZGVsQ29uZmlnIHJldHVybnMgYVxuICAgIC8vIG5vbi11bmRlZmluZWQgbW9kZWxDb25maWcgXHUyMDE0IHdpdGhvdXQgdGhhdCwgc2VsZWN0QW5kQXBwbHlNb2RlbCBza2lwcyB0aGVcbiAgICAvLyBlbnRpcmUgcG9saWN5IGJsb2NrIGFuZCB3ZSBuZXZlciByZWFjaCB0aGUgdG9vbC1jb21wYXQgZGVuaWFsIHBhdGguXG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4oZW52LmRpciwgXCIuZ3NkXCIsIFwiUFJFRkVSRU5DRVMubWRcIiksXG4gICAgICBbXCItLS1cIiwgXCJkeW5hbWljX3JvdXRpbmc6XCIsIFwiICBlbmFibGVkOiB0cnVlXCIsIFwiICB0aWVyX21vZGVsczpcIiwgXCIgICAgaGVhdnk6IG9sbGFtYS9vbGxhbWEtbGxhbWEtM1wiLCBcIi0tLVwiXS5qb2luKFwiXFxuXCIpLFxuICAgICAgXCJ1dGYtOFwiLFxuICAgICk7XG5cbiAgICBjb25zdCBhdmFpbGFibGVNb2RlbHMgPSBbXG4gICAgICB7IGlkOiBcIm9sbGFtYS1sbGFtYS0zXCIsIHByb3ZpZGVyOiBcIm9sbGFtYVwiLCBhcGk6IFwib2xsYW1hLWNoYXRcIiB9LFxuICAgIF07XG4gICAgY29uc3QgcGkgPSBtYWtlUmVjb3JkaW5nUGkoW1wiZ3NkX3BsYW5fc2xpY2VcIl0pO1xuICAgIGNsZWFyVG9vbEJhc2VsaW5lKHBpIGFzIHVua25vd24gYXMgb2JqZWN0KTtcblxuICAgIGNvbnN0IGN0eCA9IG1ha2VDdHgoYXZhaWxhYmxlTW9kZWxzKTtcbiAgICAvLyBTYW1lIHByb3ZpZGVyIGFzIGNhbmRpZGF0ZSBzbyB0aGUgY3Jvc3MtcHJvdmlkZXIgZ2F0ZSBkb2Vzbid0IGZpcmUgXHUyMDE0XG4gICAgLy8gd2Ugd2FudCB0aGlzIGRlbmlhbCB0byBjb21lIGZyb20gdG9vbC1jb21wYXRpYmlsaXR5LCBub3QgcHJvdmlkZXIgbWlzbWF0Y2guXG4gICAgY3R4Lm1vZGVsID0geyBwcm92aWRlcjogXCJvbGxhbWFcIiwgaWQ6IFwib2xsYW1hLWxsYW1hLTNcIiwgYXBpOiBcIm9sbGFtYS1jaGF0XCIgfTtcblxuICAgIGxldCB0aHJvd246IHVua25vd247XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IHNlbGVjdEFuZEFwcGx5TW9kZWwoXG4gICAgICAgIGN0eCxcbiAgICAgICAgcGkgYXMgYW55LFxuICAgICAgICBcInBsYW4tc2xpY2VcIixcbiAgICAgICAgXCJzMVwiLFxuICAgICAgICBlbnYuZGlyLFxuICAgICAgICB1bmRlZmluZWQsXG4gICAgICAgIGZhbHNlLFxuICAgICAgICB7IHByb3ZpZGVyOiBcIm9sbGFtYVwiLCBpZDogXCJvbGxhbWEtbGxhbWEtM1wiIH0sXG4gICAgICAgIHVuZGVmaW5lZCxcbiAgICAgICAgdHJ1ZSxcbiAgICAgICk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgdGhyb3duID0gZTtcbiAgICB9XG5cbiAgICBhc3NlcnQub2sodGhyb3duIGluc3RhbmNlb2YgTW9kZWxQb2xpY3lEaXNwYXRjaEJsb2NrZWRFcnJvciwgXCJzaG91bGQgdGhyb3cgTW9kZWxQb2xpY3lEaXNwYXRjaEJsb2NrZWRFcnJvclwiKTtcbiAgICBjb25zdCBlcnIgPSB0aHJvd24gYXMgTW9kZWxQb2xpY3lEaXNwYXRjaEJsb2NrZWRFcnJvcjtcbiAgICBhc3NlcnQuZXF1YWwoZXJyLnVuaXRUeXBlLCBcInBsYW4tc2xpY2VcIik7XG4gICAgYXNzZXJ0Lm1hdGNoKGVyci5tZXNzYWdlLCAvdG9vbCBwb2xpY3kgZGVuaWVkLywgXCJ0aHJvdyBtdXN0IHN1cmZhY2UgdGhlIHRvb2wtY29tcGF0aWJpbGl0eSBkZW55IHJlYXNvblwiKTtcbiAgICBhc3NlcnQubWF0Y2goZXJyLm1lc3NhZ2UsIC9nc2RfcGxhbl9zbGljZS8sIFwidGhyb3cgbXVzdCBuYW1lIHRoZSBpbmNvbXBhdGlibGUgdG9vbFwiKTtcbiAgICBhc3NlcnQubWF0Y2goZXJyLm1lc3NhZ2UsIC9vbGxhbWEtY2hhdC8sIFwidGhyb3cgbXVzdCBuYW1lIHRoZSBhcGkgZm9yIHdoaWNoIHRoZSB0b29sIHdhcyBmaWx0ZXJlZFwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICByZXNldFRvb2xDb21wYXRpYmlsaXR5UmVnaXN0cnkoKTtcbiAgICBlbnYucmVzdG9yZUVudigpO1xuICAgIGVudi5jbGVhbnVwKCk7XG4gIH1cbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgM2IuIEdlbnVpbmVseS1pbXBvc3NpYmxlOiBjcm9zcy1wcm92aWRlciBkZW5pYWwgcGF0aCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbnRlc3QoXCJnZW51aW5lbHktaW1wb3NzaWJsZSAoYik6IGNyb3NzLXByb3ZpZGVyIHJvdXRpbmcgZGlzYWJsZWQgKyBwcm92aWRlciBtaXNtYXRjaCBcdTIxOTIgdHlwZWQgZXJyb3JcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBlbnYgPSBtYWtlVGVtcFByb2plY3QoKTtcbiAgdHJ5IHtcbiAgICAvLyBVc2UgcGxhbi1zbGljZSAod29ya2Zsb3ctcmVxdWlyZWQ6IFtcImdzZF9wbGFuX3NsaWNlXCJdKSBidXQgcHJldGVuZCBub1xuICAgIC8vIGNhbmRpZGF0ZSBtb2RlbCBjYW4gY2FycnkgaXQuICBUaGUgc2ltcGxlc3Qgd2F5OiBwcm92aWRlIGEgbW9kZWwgd2hvc2VcbiAgICAvLyBhcGkgaXMgYSBmaWN0aXRpb3VzIFwibm8tdG9vbHNcIiBzdHJpbmcgXHUyMDE0IGBmaWx0ZXJUb29sc0ZvclByb3ZpZGVyYCByZXR1cm5zXG4gICAgLy8gZXZlcnkgdG9vbCBhcyBmaWx0ZXJlZCBmb3IgYW4gdW5rbm93biBhcGkgd2l0aCB0b29sQ2FsbGluZz1mYWxzZSwgT1Igd2VcbiAgICAvLyBjYW4gcGljayBhIHJlYWwgYXBpIHRoYXQgYWxzbyBkZW5pZXMgdGhlIHRvb2wuICBXZSB1c2UgYW4gYXBpIHRoYXRcbiAgICAvLyBleGlzdHMgYnV0IGhhcyBrbm93biBpbmNvbXBhdGliaWxpdHkgXHUyMDE0IG5vIHN1Y2ggY2FzZSBpcyBwb3J0YWJsZSwgc28gd2VcbiAgICAvLyBmYWxsIGJhY2sgdG8gYSBtb2RlbCB3aG9zZSBhcGkgaXMgcmVjb2duaXplZCB0byBkZW55IGBnc2RfcGxhbl9zbGljZWAuXG4gICAgLy9cbiAgICAvLyBQcmFnbWF0aWMgYXBwcm9hY2g6IG1vbmtleSB0aGUgcG9saWN5IHZpYSBgYWxsb3dDcm9zc1Byb3ZpZGVyPWZhbHNlYCArXG4gICAgLy8gYSBzaW5nbGUgY2FuZGlkYXRlIG1vZGVsIG9uIGEgKmRpZmZlcmVudCogcHJvdmlkZXIgdGhhbiBjdXJyZW50LCB3aGljaFxuICAgIC8vIG1ha2VzIEVWRVJZIGNhbmRpZGF0ZSBkZW5pZWQgZm9yIGNyb3NzLXByb3ZpZGVyLXJvdXRpbmcgcmVhc29ucy4gIFRoaXNcbiAgICAvLyBleGVyY2lzZXMgdGhlIHNhbWUgdGhyb3cgcGF0aCB3aXRoIGEgZGV0ZXJtaW5pc3RpYyBkZW55IHJlYXNvbi5cbiAgICBjb25zdCBhdmFpbGFibGVNb2RlbHMgPSBbXG4gICAgICB7IGlkOiBcIm90aGVyLW1vZGVsXCIsIHByb3ZpZGVyOiBcIm90aGVyLXByb3ZpZGVyXCIsIGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIiB9LFxuICAgIF07XG4gICAgY29uc3QgcGkgPSBtYWtlUmVjb3JkaW5nUGkoW10pO1xuICAgIGNsZWFyVG9vbEJhc2VsaW5lKHBpIGFzIHVua25vd24gYXMgb2JqZWN0KTtcblxuICAgIGNvbnN0IGN0eCA9IG1ha2VDdHgoYXZhaWxhYmxlTW9kZWxzKTtcbiAgICAvLyBjdXJyZW50UHJvdmlkZXIgbWlzbWF0Y2hlcyBcdTIxOTIgY3Jvc3MtcHJvdmlkZXIgZGVuaWFsIHdoZW4gZGlzYWJsZWQuXG4gICAgY3R4Lm1vZGVsID0geyBwcm92aWRlcjogXCJhbnRocm9waWNcIiwgaWQ6IFwiY2xhdWRlLXNvbm5ldC00LTZcIiwgYXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiIH07XG5cbiAgICAvLyBTZXQgZHluYW1pY19yb3V0aW5nLmNyb3NzX3Byb3ZpZGVyPWZhbHNlIHZpYSBQUkVGRVJFTkNFUyBzbyB0aGUgcG9saWN5XG4gICAgLy8gZGlzYWJsZXMgY3Jvc3MtcHJvdmlkZXIgcm91dGluZy5cbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihlbnYuZGlyLCBcIi5nc2RcIiwgXCJQUkVGRVJFTkNFUy5tZFwiKSxcbiAgICAgIFtcIi0tLVwiLCBcImR5bmFtaWNfcm91dGluZzpcIiwgXCIgIGVuYWJsZWQ6IHRydWVcIiwgXCIgIGNyb3NzX3Byb3ZpZGVyOiBmYWxzZVwiLCBcIiAgdGllcl9tb2RlbHM6XCIsIFwiICAgIGhlYXZ5OiBvdGhlci1wcm92aWRlci9vdGhlci1tb2RlbFwiLCBcIi0tLVwiXS5qb2luKFwiXFxuXCIpLFxuICAgICAgXCJ1dGYtOFwiLFxuICAgICk7XG5cbiAgICBsZXQgdGhyb3duOiB1bmtub3duO1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBzZWxlY3RBbmRBcHBseU1vZGVsKFxuICAgICAgICBjdHgsXG4gICAgICAgIHBpIGFzIGFueSxcbiAgICAgICAgXCJwbGFuLXNsaWNlXCIsXG4gICAgICAgIFwiczFcIixcbiAgICAgICAgZW52LmRpcixcbiAgICAgICAgdW5kZWZpbmVkLFxuICAgICAgICBmYWxzZSxcbiAgICAgICAgeyBwcm92aWRlcjogXCJhbnRocm9waWNcIiwgaWQ6IFwiY2xhdWRlLXNvbm5ldC00LTZcIiB9LFxuICAgICAgICB1bmRlZmluZWQsXG4gICAgICAgIHRydWUsXG4gICAgICApO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIHRocm93biA9IGU7XG4gICAgfVxuXG4gICAgYXNzZXJ0Lm9rKHRocm93biBpbnN0YW5jZW9mIE1vZGVsUG9saWN5RGlzcGF0Y2hCbG9ja2VkRXJyb3IsIFwic2hvdWxkIHRocm93IE1vZGVsUG9saWN5RGlzcGF0Y2hCbG9ja2VkRXJyb3JcIik7XG4gICAgY29uc3QgZXJyID0gdGhyb3duIGFzIE1vZGVsUG9saWN5RGlzcGF0Y2hCbG9ja2VkRXJyb3I7XG4gICAgYXNzZXJ0LmVxdWFsKGVyci51bml0VHlwZSwgXCJwbGFuLXNsaWNlXCIpO1xuICAgIGFzc2VydC5lcXVhbChlcnIudW5pdElkLCBcInMxXCIpO1xuICAgIGFzc2VydC5vayhlcnIucmVhc29ucy5sZW5ndGggPiAwLCBcImRlbnkgcmVhc29ucyBzaG91bGQgYmUgY2FwdHVyZWRcIik7XG4gIH0gZmluYWxseSB7XG4gICAgZW52LnJlc3RvcmVFbnYoKTtcbiAgICBlbnYuY2xlYW51cCgpO1xuICB9XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIDQuIFJlc3RvcmUgaGFwcGVuZWQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG50ZXN0KFwicmVzdG9yZSBiYXNlbGluZTogc2V0QWN0aXZlVG9vbHMoQkFTRUxJTkUpIGNhbGxlZCBiZXR3ZWVuIHVuaXRzIGJlZm9yZSBuZXh0IGRpc3BhdGNoXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgZW52ID0gbWFrZVRlbXBQcm9qZWN0KCk7XG4gIHRyeSB7XG4gICAgY29uc3QgYXZhaWxhYmxlTW9kZWxzID0gW1xuICAgICAgeyBpZDogXCJjbGF1ZGUtc29ubmV0LTQtNlwiLCBwcm92aWRlcjogXCJhbnRocm9waWNcIiwgYXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiIH0sXG4gICAgXTtcbiAgICBjb25zdCBiYXNlbGluZVRvb2xzID0gW1wiZ3NkX3NhdmVfZ2F0ZV9yZXN1bHRcIiwgXCJ0b29sX2FcIiwgXCJ0b29sX2JcIl07XG4gICAgY29uc3QgcGkgPSBtYWtlUmVjb3JkaW5nUGkoYmFzZWxpbmVUb29scyk7XG4gICAgY2xlYXJUb29sQmFzZWxpbmUocGkgYXMgdW5rbm93biBhcyBvYmplY3QpO1xuXG4gICAgLy8gRmlyc3QgY2FsbCBjYXB0dXJlcyB0aGUgYmFzZWxpbmUuXG4gICAgYXdhaXQgc2VsZWN0QW5kQXBwbHlNb2RlbChcbiAgICAgIG1ha2VDdHgoYXZhaWxhYmxlTW9kZWxzKSxcbiAgICAgIHBpIGFzIGFueSxcbiAgICAgIFwiZ2F0ZS1ldmFsdWF0ZVwiLFxuICAgICAgXCJ1MVwiLFxuICAgICAgZW52LmRpcixcbiAgICAgIHVuZGVmaW5lZCxcbiAgICAgIGZhbHNlLFxuICAgICAgeyBwcm92aWRlcjogXCJhbnRocm9waWNcIiwgaWQ6IFwiY2xhdWRlLXNvbm5ldC00LTZcIiB9LFxuICAgICAgdW5kZWZpbmVkLFxuICAgICAgdHJ1ZSxcbiAgICApO1xuXG4gICAgLy8gU2ltdWxhdGUgYSBkb3duc3RyZWFtIGNhbGxlciBuYXJyb3dpbmcgdGhlIHRvb2wgc2V0IChwb3N0LXVuaXQgcG9pc29uaW5nKS5cbiAgICBwaS5zZXRBY3RpdmVUb29scyhbXCJnc2Rfc2F2ZV9nYXRlX3Jlc3VsdFwiXSk7XG4gICAgY29uc3QgY2FsbHNCZWZvcmVVMiA9IHBpLl9fY2FsbHMubGVuZ3RoO1xuXG4gICAgLy8gU2Vjb25kIGNhbGwgc2hvdWxkIHJlc3RvcmUgdGhlIGJhc2VsaW5lIGJlZm9yZSByZWFkaW5nIGFueXRoaW5nLlxuICAgIGF3YWl0IHNlbGVjdEFuZEFwcGx5TW9kZWwoXG4gICAgICBtYWtlQ3R4KGF2YWlsYWJsZU1vZGVscyksXG4gICAgICBwaSBhcyBhbnksXG4gICAgICBcImdhdGUtZXZhbHVhdGVcIixcbiAgICAgIFwidTJcIixcbiAgICAgIGVudi5kaXIsXG4gICAgICB1bmRlZmluZWQsXG4gICAgICBmYWxzZSxcbiAgICAgIHsgcHJvdmlkZXI6IFwiYW50aHJvcGljXCIsIGlkOiBcImNsYXVkZS1zb25uZXQtNC02XCIgfSxcbiAgICAgIHVuZGVmaW5lZCxcbiAgICAgIHRydWUsXG4gICAgKTtcblxuICAgIGNvbnN0IHUyQ2FsbHMgPSBwaS5fX2NhbGxzLnNsaWNlKGNhbGxzQmVmb3JlVTIpO1xuICAgIGNvbnN0IHJlc3RvcmVDYWxsID0gdTJDYWxscy5maW5kKFxuICAgICAgYyA9PiBjLmtpbmQgPT09IFwic2V0QWN0aXZlVG9vbHNcIlxuICAgICAgICAmJiBBcnJheS5pc0FycmF5KGMucGF5bG9hZClcbiAgICAgICAgJiYgKGMucGF5bG9hZCBhcyBzdHJpbmdbXSkubGVuZ3RoID09PSBiYXNlbGluZVRvb2xzLmxlbmd0aFxuICAgICAgICAmJiBiYXNlbGluZVRvb2xzLmV2ZXJ5KHQgPT4gKGMucGF5bG9hZCBhcyBzdHJpbmdbXSkuaW5jbHVkZXModCkpLFxuICAgICk7XG4gICAgYXNzZXJ0Lm9rKHJlc3RvcmVDYWxsLCBcInNldEFjdGl2ZVRvb2xzKEJBU0VMSU5FKSBtdXN0IGJlIGNhbGxlZCBkdXJpbmcgdTIncyBzZWxlY3RBbmRBcHBseU1vZGVsIGJlZm9yZSBkaXNwYXRjaFwiKTtcblxuICAgIGNvbnN0IHJlc3RvcmVJZHggPSB1MkNhbGxzLmluZGV4T2YocmVzdG9yZUNhbGwhKTtcbiAgICBjb25zdCBzZXRNb2RlbElkeCA9IHUyQ2FsbHMuZmluZEluZGV4KGMgPT4gYy5raW5kID09PSBcInNldE1vZGVsXCIpO1xuICAgIGFzc2VydC5vayhzZXRNb2RlbElkeCA+IHJlc3RvcmVJZHgsIFwiYmFzZWxpbmUgcmVzdG9yZSBtdXN0IHByZWNlZGUgc2V0TW9kZWwgZGlzcGF0Y2hcIik7XG4gIH0gZmluYWxseSB7XG4gICAgZW52LnJlc3RvcmVFbnYoKTtcbiAgICBlbnYuY2xlYW51cCgpO1xuICB9XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIDUuIEVycm9yIG1lc3NhZ2UgY2FycmllcyByZWFzb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG50ZXN0KFwiZXJyb3IgY2FycmllcyBkZW55IHJlYXNvbiBmcmFnbWVudCBmcm9tIGFwcGx5TW9kZWxQb2xpY3lGaWx0ZXJcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBlbnYgPSBtYWtlVGVtcFByb2plY3QoKTtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihlbnYuZGlyLCBcIi5nc2RcIiwgXCJQUkVGRVJFTkNFUy5tZFwiKSxcbiAgICAgIFtcIi0tLVwiLCBcImR5bmFtaWNfcm91dGluZzpcIiwgXCIgIGVuYWJsZWQ6IHRydWVcIiwgXCIgIGNyb3NzX3Byb3ZpZGVyOiBmYWxzZVwiLCBcIiAgdGllcl9tb2RlbHM6XCIsIFwiICAgIGhlYXZ5OiBvdGhlci1wcm92aWRlci9vdGhlci1tb2RlbFwiLCBcIi0tLVwiXS5qb2luKFwiXFxuXCIpLFxuICAgICAgXCJ1dGYtOFwiLFxuICAgICk7XG5cbiAgICBjb25zdCBhdmFpbGFibGVNb2RlbHMgPSBbXG4gICAgICB7IGlkOiBcIm90aGVyLW1vZGVsXCIsIHByb3ZpZGVyOiBcIm90aGVyLXByb3ZpZGVyXCIsIGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIiB9LFxuICAgIF07XG4gICAgY29uc3QgcGkgPSBtYWtlUmVjb3JkaW5nUGkoW10pO1xuICAgIGNsZWFyVG9vbEJhc2VsaW5lKHBpIGFzIHVua25vd24gYXMgb2JqZWN0KTtcblxuICAgIGNvbnN0IGN0eCA9IG1ha2VDdHgoYXZhaWxhYmxlTW9kZWxzKTtcbiAgICBjdHgubW9kZWwgPSB7IHByb3ZpZGVyOiBcImFudGhyb3BpY1wiLCBpZDogXCJjbGF1ZGUtc29ubmV0LTQtNlwiLCBhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIgfTtcblxuICAgIGxldCB0aHJvd246IEVycm9yIHwgdW5kZWZpbmVkO1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBzZWxlY3RBbmRBcHBseU1vZGVsKFxuICAgICAgICBjdHgsXG4gICAgICAgIHBpIGFzIGFueSxcbiAgICAgICAgXCJwbGFuLXNsaWNlXCIsXG4gICAgICAgIFwiczFcIixcbiAgICAgICAgZW52LmRpcixcbiAgICAgICAgdW5kZWZpbmVkLFxuICAgICAgICBmYWxzZSxcbiAgICAgICAgeyBwcm92aWRlcjogXCJhbnRocm9waWNcIiwgaWQ6IFwiY2xhdWRlLXNvbm5ldC00LTZcIiB9LFxuICAgICAgICB1bmRlZmluZWQsXG4gICAgICAgIHRydWUsXG4gICAgICApO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIHRocm93biA9IGUgYXMgRXJyb3I7XG4gICAgfVxuXG4gICAgYXNzZXJ0Lm9rKHRocm93biwgXCJzaG91bGQgdGhyb3dcIik7XG4gICAgLy8gVGhlIGNyb3NzLXByb3ZpZGVyIGRlbmlhbCBwYXRoIHByb2R1Y2VzOlxuICAgIC8vICAgXCJjcm9zcy1wcm92aWRlciByb3V0aW5nIGRpc2FibGVkIChvdGhlci1wcm92aWRlciAhPSBhbnRocm9waWMpXCJcbiAgICBhc3NlcnQubWF0Y2goXG4gICAgICB0aHJvd24hLm1lc3NhZ2UsXG4gICAgICAvY3Jvc3MtcHJvdmlkZXIgcm91dGluZyBkaXNhYmxlZC8sXG4gICAgICBcInRocm93biBlcnJvciBtZXNzYWdlIHNob3VsZCBpbmNsdWRlIHRoZSBwZXItbW9kZWwgZGVueSByZWFzb25cIixcbiAgICApO1xuICAgIGFzc2VydC5tYXRjaCh0aHJvd24hLm1lc3NhZ2UsIC9vdGhlci1wcm92aWRlclxcL290aGVyLW1vZGVsLywgXCJzaG91bGQgbmFtZSB0aGUgcmVqZWN0ZWQgbW9kZWxcIik7XG4gIH0gZmluYWxseSB7XG4gICAgZW52LnJlc3RvcmVFbnYoKTtcbiAgICBlbnYuY2xlYW51cCgpO1xuICB9XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIDYuIExpZmVjeWNsZTogY2xlYXJUb29sQmFzZWxpbmUgZm9yY2VzIHJlY2FwdHVyZSAoQ29kZVJhYmJpdCBNYWpvcikgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4vL1xuLy8gVGhlIFdlYWtNYXAgYmFzZWxpbmUgaXMga2V5ZWQgcGVyIGBwaWAgaW5zdGFuY2UsIGJ1dCBhdXRvIHNlc3Npb25zIGFyZSBOT1Rcbi8vIDE6MSB3aXRoIGBwaWAgaW5zdGFuY2VzIFx1MjAxNCBhIHNpbmdsZSBgcGlgIGNhbiBob3N0IG11bHRpcGxlIGAvZ3NkIGF1dG9gIHJ1bnNcbi8vIHNlcGFyYXRlZCBieSBzdG9wcywgbWFudWFsIHRvb2wgZWRpdHMsIG9yIGV4dGVuc2lvbiB0b2dnbGVzLiAgV2l0aG91dFxuLy8gYGNsZWFyVG9vbEJhc2VsaW5lKHBpKWAgYXQgc2Vzc2lvbiBib3VuZGFyaWVzLCB0aGUgU0VDT05EIGF1dG8gcnVuIG9uIHRoZVxuLy8gc2FtZSBgcGlgIHdvdWxkIHNpbGVudGx5IHJlc3RvcmUgdGhlIEZJUlNUIHJ1bidzIHNuYXBzaG90IGFuZCB1bmRvIHdoYXRldmVyXG4vLyB0b29sIGNoYW5nZXMgdGhlIHVzZXIgbWFkZSBiZXR3ZWVuIHNlc3Npb25zLiAgVGhpcyB0ZXN0IHBpbnMgdGhlIGNvbnRyYWN0XG4vLyB0aGF0IGBjbGVhclRvb2xCYXNlbGluZWAgY2F1c2VzIHRoZSBuZXh0IGRpc3BhdGNoIHRvIFJFQ0FQVFVSRSBmcm9tIHRoZVxuLy8gbGl2ZSBhY3RpdmUgc2V0IHJhdGhlciB0aGFuIHJlc3RvcmluZyB0aGUgcHJpb3Igc25hcHNob3QuXG50ZXN0KFwibGlmZWN5Y2xlOiBjbGVhclRvb2xCYXNlbGluZSBmb3JjZXMgcmVjYXB0dXJlOyBzdWJzZXF1ZW50IHJ1bnMgcmVzcGVjdCBpbnRlcnZlbmluZyB0b29sIGVkaXRzXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgZW52ID0gbWFrZVRlbXBQcm9qZWN0KCk7XG4gIHRyeSB7XG4gICAgY29uc3QgYXZhaWxhYmxlTW9kZWxzID0gW1xuICAgICAgeyBpZDogXCJjbGF1ZGUtc29ubmV0LTQtNlwiLCBwcm92aWRlcjogXCJhbnRocm9waWNcIiwgYXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiIH0sXG4gICAgXTtcbiAgICBjb25zdCBwaSA9IG1ha2VSZWNvcmRpbmdQaShbXCJBXCIsIFwiQlwiLCBcIkNcIl0pO1xuICAgIGNsZWFyVG9vbEJhc2VsaW5lKHBpIGFzIHVua25vd24gYXMgb2JqZWN0KTtcblxuICAgIC8vIFx1MjUwMFx1MjUwMCBSdW4gMTogY2FwdHVyZXMgYmFzZWxpbmUgW0EsIEIsIENdIFx1MjUwMFx1MjUwMFxuICAgIGF3YWl0IHNlbGVjdEFuZEFwcGx5TW9kZWwoXG4gICAgICBtYWtlQ3R4KGF2YWlsYWJsZU1vZGVscyksXG4gICAgICBwaSBhcyBhbnksXG4gICAgICBcImdhdGUtZXZhbHVhdGVcIixcbiAgICAgIFwidTFcIixcbiAgICAgIGVudi5kaXIsXG4gICAgICB1bmRlZmluZWQsXG4gICAgICBmYWxzZSxcbiAgICAgIHsgcHJvdmlkZXI6IFwiYW50aHJvcGljXCIsIGlkOiBcImNsYXVkZS1zb25uZXQtNC02XCIgfSxcbiAgICAgIHVuZGVmaW5lZCxcbiAgICAgIHRydWUsXG4gICAgKTtcblxuICAgIC8vIFx1MjUwMFx1MjUwMCBTaW11bGF0ZSBgL2dzZCBhdXRvYCBzdG9wICsgaW50ZXJ2ZW5pbmcgdXNlciB0b29sIGVkaXQgXHUyNTAwXHUyNTAwXG4gICAgLy8gKGF1dG8udHMgY2FsbHMgY2xlYXJUb29sQmFzZWxpbmUgaW4gc3RvcEF1dG87IHRoZSB1c2VyIHRoZW4gbXV0YXRlc1xuICAgIC8vIHRvb2xzIHdoaWxlIGF1dG8gaXMgcGF1c2VkLilcbiAgICBjbGVhclRvb2xCYXNlbGluZShwaSBhcyB1bmtub3duIGFzIG9iamVjdCk7XG4gICAgcGkuc2V0QWN0aXZlVG9vbHMoW1wiQVwiLCBcIkJcIl0pOyAvLyB1c2VyIHJlbW92ZWQgQyBiZXR3ZWVuIHNlc3Npb25zXG5cbiAgICAvLyBcdTI1MDBcdTI1MDAgUnVuIDI6IG11c3QgY2FwdHVyZSBbQSwgQl0gYXMgdGhlIE5FVyBiYXNlbGluZSwgbm90IHJlc3RvcmUgW0EsIEIsIENdIFx1MjUwMFx1MjUwMFxuICAgIGNvbnN0IGNhbGxzQmVmb3JlVTIgPSBwaS5fX2NhbGxzLmxlbmd0aDtcbiAgICBhd2FpdCBzZWxlY3RBbmRBcHBseU1vZGVsKFxuICAgICAgbWFrZUN0eChhdmFpbGFibGVNb2RlbHMpLFxuICAgICAgcGkgYXMgYW55LFxuICAgICAgXCJnYXRlLWV2YWx1YXRlXCIsXG4gICAgICBcInUyXCIsXG4gICAgICBlbnYuZGlyLFxuICAgICAgdW5kZWZpbmVkLFxuICAgICAgZmFsc2UsXG4gICAgICB7IHByb3ZpZGVyOiBcImFudGhyb3BpY1wiLCBpZDogXCJjbGF1ZGUtc29ubmV0LTQtNlwiIH0sXG4gICAgICB1bmRlZmluZWQsXG4gICAgICB0cnVlLFxuICAgICk7XG4gICAgY29uc3QgdTJDYWxscyA9IHBpLl9fY2FsbHMuc2xpY2UoY2FsbHNCZWZvcmVVMik7XG4gICAgLy8gTm8gc2V0QWN0aXZlVG9vbHMoW1wiQVwiLCBcIkJcIiwgXCJDXCJdKSBjYWxsIHNob3VsZCBhcHBlYXIgZHVyaW5nIHUyIFx1MjAxNCB0aGF0XG4gICAgLy8gd291bGQgYmUgdGhlIGJ1ZyAocmVzdG9yaW5nIHRoZSBydW4tMSBzbmFwc2hvdCBvdmVyIHRoZSB1c2VyJ3MgZWRpdCkuXG4gICAgY29uc3Qgc3RhbGVSZXN0b3JlID0gdTJDYWxscy5maW5kKFxuICAgICAgYyA9PiBjLmtpbmQgPT09IFwic2V0QWN0aXZlVG9vbHNcIlxuICAgICAgICAmJiBBcnJheS5pc0FycmF5KGMucGF5bG9hZClcbiAgICAgICAgJiYgKGMucGF5bG9hZCBhcyBzdHJpbmdbXSkuaW5jbHVkZXMoXCJDXCIpLFxuICAgICk7XG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgc3RhbGVSZXN0b3JlLFxuICAgICAgdW5kZWZpbmVkLFxuICAgICAgXCJhZnRlciBjbGVhclRvb2xCYXNlbGluZSwgcnVuIDIgbXVzdCBOT1QgcmVzdG9yZSB0aGUgcnVuLTEgc25hcHNob3QgY29udGFpbmluZyB0b29sIENcIixcbiAgICApO1xuXG4gICAgLy8gXHUyNTAwXHUyNTAwIFJ1biAzIChubyBjbGVhcik6IG11dGF0ZSB0byBbQV0sIGV4cGVjdCByZXN0b3JlIHRvIFtBLCBCXSAocnVuLTIgYmFzZWxpbmUpIFx1MjUwMFx1MjUwMFxuICAgIHBpLnNldEFjdGl2ZVRvb2xzKFtcIkFcIl0pO1xuICAgIGNvbnN0IGNhbGxzQmVmb3JlVTMgPSBwaS5fX2NhbGxzLmxlbmd0aDtcbiAgICBhd2FpdCBzZWxlY3RBbmRBcHBseU1vZGVsKFxuICAgICAgbWFrZUN0eChhdmFpbGFibGVNb2RlbHMpLFxuICAgICAgcGkgYXMgYW55LFxuICAgICAgXCJnYXRlLWV2YWx1YXRlXCIsXG4gICAgICBcInUzXCIsXG4gICAgICBlbnYuZGlyLFxuICAgICAgdW5kZWZpbmVkLFxuICAgICAgZmFsc2UsXG4gICAgICB7IHByb3ZpZGVyOiBcImFudGhyb3BpY1wiLCBpZDogXCJjbGF1ZGUtc29ubmV0LTQtNlwiIH0sXG4gICAgICB1bmRlZmluZWQsXG4gICAgICB0cnVlLFxuICAgICk7XG4gICAgY29uc3QgdTNDYWxscyA9IHBpLl9fY2FsbHMuc2xpY2UoY2FsbHNCZWZvcmVVMyk7XG4gICAgY29uc3QgcmVzdG9yZVRvUnVuMkJhc2VsaW5lID0gdTNDYWxscy5maW5kKFxuICAgICAgYyA9PiBjLmtpbmQgPT09IFwic2V0QWN0aXZlVG9vbHNcIlxuICAgICAgICAmJiBBcnJheS5pc0FycmF5KGMucGF5bG9hZClcbiAgICAgICAgJiYgKGMucGF5bG9hZCBhcyBzdHJpbmdbXSkubGVuZ3RoID09PSAyXG4gICAgICAgICYmIChjLnBheWxvYWQgYXMgc3RyaW5nW10pLmluY2x1ZGVzKFwiQVwiKVxuICAgICAgICAmJiAoYy5wYXlsb2FkIGFzIHN0cmluZ1tdKS5pbmNsdWRlcyhcIkJcIilcbiAgICAgICAgJiYgIShjLnBheWxvYWQgYXMgc3RyaW5nW10pLmluY2x1ZGVzKFwiQ1wiKSxcbiAgICApO1xuICAgIGFzc2VydC5vayhcbiAgICAgIHJlc3RvcmVUb1J1bjJCYXNlbGluZSxcbiAgICAgIFwicnVuIDMgbXVzdCByZXN0b3JlIHRoZSBydW4tMiBiYXNlbGluZSBbQSwgQl0gXHUyMDE0IHByb3ZlcyB0aGUgcmVjYXB0dXJlZCBiYXNlbGluZSBpcyBpbiB1c2UsIG5vdCB0aGUgcnVuLTEgc25hcHNob3RcIixcbiAgICApO1xuICB9IGZpbmFsbHkge1xuICAgIGVudi5yZXN0b3JlRW52KCk7XG4gICAgZW52LmNsZWFudXAoKTtcbiAgfVxufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCA3LiBDcm9zcy1tb2RlIGlzb2xhdGlvbiAoIzQ5NjUpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuLy9cbi8vIGBzZWxlY3RBbmRBcHBseU1vZGVsYCBpcyBjYWxsZWQgZnJvbSB0d28gcGxhY2VzOiBhdXRvLW1vZGUgKGBpc0F1dG9Nb2RlPXRydWVgLFxuLy8gZnJvbSBhdXRvL3BoYXNlcy50cykgYW5kIGd1aWRlZC1mbG93IChgaXNBdXRvTW9kZT1mYWxzZWAsIGZyb20gZ3VpZGVkLWZsb3cudHMpLlxuLy8gVGhlIGJhc2VsaW5lIGxpZmVjeWNsZSAoY2xlYXJUb29sQmFzZWxpbmUpIGlzIG93bmVkIGJ5IHN0YXJ0QXV0by9zdG9wQXV0byBcdTIwMTRcbi8vIGd1aWRlZC1mbG93IGhhcyBubyBlcXVpdmFsZW50IGNsZWFyIGhvb2suIElmIGByZXN0b3JlVG9vbEJhc2VsaW5lYCByYW5cbi8vIHVuY29uZGl0aW9uYWxseSwgYW4gaW50ZXJhY3RpdmUgZ3VpZGVkLWZsb3cgZGlzcGF0Y2ggb24gYSBgcGlgIHRoYXQgcHJldmlvdXNseVxuLy8gaG9zdGVkIGFuIGF1dG8gc2Vzc2lvbiB3b3VsZCByZXN1cnJlY3QgdGhlIGF1dG8tZXJhIGJhc2VsaW5lIGFuZCBzaWxlbnRseVxuLy8gb3ZlcndyaXRlIGFueSB1c2VyIHRvb2wgZWRpdHMgbWFkZSBiZXR3ZWVuIHRoZSBhdXRvIGFuZCBndWlkZWQgZGlzcGF0Y2hlcy5cbi8vIFRoZXJlZm9yZSB0aGUgcmVzdG9yZSBpcyBnYXRlZCBieSBgaXNBdXRvTW9kZWAuIEd1aWRlZC1mbG93IGhhcyBpdHMgb3duXG4vLyBuYXJyb3cvcmVzdG9yZSBkaXNjaXBsaW5lIHZpYSBkaXNjdXNzLXRvb2wtc2NvcGluZyBhdCBndWlkZWQtZmxvdy50czo1ODctNjIyLlxuXG50ZXN0KFwiY3Jvc3MtbW9kZSAoIzQ5NjUpOiBpc0F1dG9Nb2RlPWZhbHNlIGRvZXMgTk9UIHJlc3RvcmUgYmFzZWxpbmUgZXZlbiB3aGVuIG9uZSBpcyByZWNvcmRlZFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGVudiA9IG1ha2VUZW1wUHJvamVjdCgpO1xuICB0cnkge1xuICAgIGNvbnN0IGF2YWlsYWJsZU1vZGVscyA9IFtcbiAgICAgIHsgaWQ6IFwiY2xhdWRlLXNvbm5ldC00LTZcIiwgcHJvdmlkZXI6IFwiYW50aHJvcGljXCIsIGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIiB9LFxuICAgIF07XG4gICAgY29uc3QgYmFzZWxpbmVUb29scyA9IFtcImdzZF9zYXZlX2dhdGVfcmVzdWx0XCIsIFwidG9vbF9hXCIsIFwidG9vbF9iXCJdO1xuICAgIGNvbnN0IHBpID0gbWFrZVJlY29yZGluZ1BpKGJhc2VsaW5lVG9vbHMpO1xuICAgIGNsZWFyVG9vbEJhc2VsaW5lKHBpIGFzIHVua25vd24gYXMgb2JqZWN0KTtcblxuICAgIC8vIFx1MjUwMFx1MjUwMCBTdGVwIDE6IGF1dG8tbW9kZSBjYWxsIGNhcHR1cmVzIGJhc2VsaW5lIFtBLCBCLCBDXSBcdTI1MDBcdTI1MDBcbiAgICBhd2FpdCBzZWxlY3RBbmRBcHBseU1vZGVsKFxuICAgICAgbWFrZUN0eChhdmFpbGFibGVNb2RlbHMpLFxuICAgICAgcGkgYXMgYW55LFxuICAgICAgXCJnYXRlLWV2YWx1YXRlXCIsXG4gICAgICBcInUtYXV0b1wiLFxuICAgICAgZW52LmRpcixcbiAgICAgIHVuZGVmaW5lZCxcbiAgICAgIGZhbHNlLFxuICAgICAgeyBwcm92aWRlcjogXCJhbnRocm9waWNcIiwgaWQ6IFwiY2xhdWRlLXNvbm5ldC00LTZcIiB9LFxuICAgICAgdW5kZWZpbmVkLFxuICAgICAgLyogaXNBdXRvTW9kZSAqLyB0cnVlLFxuICAgICk7XG5cbiAgICAvLyBcdTI1MDBcdTI1MDAgU3RlcCAyOiBzaW11bGF0ZSB1c2VyIHRvb2wgZWRpdCBiZXR3ZWVuIGF1dG8gYW5kIGd1aWRlZCBkaXNwYXRjaGVzIFx1MjUwMFx1MjUwMFxuICAgIHBpLnNldEFjdGl2ZVRvb2xzKFtcIm9ubHlfdXNlcl9rZXB0X3Rvb2xcIl0pO1xuICAgIGNvbnN0IGNhbGxzQmVmb3JlR3VpZGVkID0gcGkuX19jYWxscy5sZW5ndGg7XG5cbiAgICAvLyBcdTI1MDBcdTI1MDAgU3RlcCAzOiBndWlkZWQtZmxvdyBkaXNwYXRjaCAoaXNBdXRvTW9kZT1mYWxzZSkgXHUyNTAwXHUyNTAwXG4gICAgYXdhaXQgc2VsZWN0QW5kQXBwbHlNb2RlbChcbiAgICAgIG1ha2VDdHgoYXZhaWxhYmxlTW9kZWxzKSxcbiAgICAgIHBpIGFzIGFueSxcbiAgICAgIFwiZ2F0ZS1ldmFsdWF0ZVwiLFxuICAgICAgXCJ1LWd1aWRlZFwiLFxuICAgICAgZW52LmRpcixcbiAgICAgIHVuZGVmaW5lZCxcbiAgICAgIGZhbHNlLFxuICAgICAgeyBwcm92aWRlcjogXCJhbnRocm9waWNcIiwgaWQ6IFwiY2xhdWRlLXNvbm5ldC00LTZcIiB9LFxuICAgICAgdW5kZWZpbmVkLFxuICAgICAgLyogaXNBdXRvTW9kZSAqLyBmYWxzZSxcbiAgICApO1xuXG4gICAgY29uc3QgZ3VpZGVkQ2FsbHMgPSBwaS5fX2NhbGxzLnNsaWNlKGNhbGxzQmVmb3JlR3VpZGVkKTtcbiAgICAvLyBUaGUgYnVnIHdlJ3JlIGd1YXJkaW5nIGFnYWluc3Q6IGEgc2V0QWN0aXZlVG9vbHMgY2FsbCBkdXJpbmcgdGhlIGd1aWRlZFxuICAgIC8vIGRpc3BhdGNoIHRoYXQgY29udGFpbnMgdGhlIGF1dG8tZXJhIGJhc2VsaW5lIHRvb2xzICh3aGljaCB3b3VsZCBtZWFuIHRoZVxuICAgIC8vIGF1dG8tY2FwdHVyZWQgYmFzZWxpbmUgcmVzdXJyZWN0ZWQgYW5kIG92ZXJ3cm90ZSB0aGUgdXNlcidzIGVkaXQpLlxuICAgIGNvbnN0IGJhc2VsaW5lUmVzdG9yZSA9IGd1aWRlZENhbGxzLmZpbmQoXG4gICAgICBjID0+IGMua2luZCA9PT0gXCJzZXRBY3RpdmVUb29sc1wiXG4gICAgICAgICYmIEFycmF5LmlzQXJyYXkoYy5wYXlsb2FkKVxuICAgICAgICAmJiBiYXNlbGluZVRvb2xzLmV2ZXJ5KHQgPT4gKGMucGF5bG9hZCBhcyBzdHJpbmdbXSkuaW5jbHVkZXModCkpLFxuICAgICk7XG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgYmFzZWxpbmVSZXN0b3JlLFxuICAgICAgdW5kZWZpbmVkLFxuICAgICAgXCJndWlkZWQtZmxvdyBkaXNwYXRjaCAoaXNBdXRvTW9kZT1mYWxzZSkgbXVzdCBOT1QgcmVzdG9yZSB0aGUgYXV0by1tb2RlIGJhc2VsaW5lXCIsXG4gICAgKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBlbnYucmVzdG9yZUVudigpO1xuICAgIGVudi5jbGVhbnVwKCk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiY3Jvc3MtbW9kZSAoIzQ5NjUpOiBhdXRvIFx1MjE5MiBndWlkZWQgXHUyMTkyIGF1dG8gcHJlc2VydmVzIHRoZSBvcmlnaW5hbCBhdXRvLWVyYSBiYXNlbGluZSBmb3IgdGhlIHNlY29uZCBhdXRvIHJ1blwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGVudiA9IG1ha2VUZW1wUHJvamVjdCgpO1xuICB0cnkge1xuICAgIGNvbnN0IGF2YWlsYWJsZU1vZGVscyA9IFtcbiAgICAgIHsgaWQ6IFwiY2xhdWRlLXNvbm5ldC00LTZcIiwgcHJvdmlkZXI6IFwiYW50aHJvcGljXCIsIGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIiB9LFxuICAgIF07XG4gICAgY29uc3QgYmFzZWxpbmVUb29scyA9IFtcImdzZF9zYXZlX2dhdGVfcmVzdWx0XCIsIFwidG9vbF9hXCIsIFwidG9vbF9iXCJdO1xuICAgIGNvbnN0IHBpID0gbWFrZVJlY29yZGluZ1BpKGJhc2VsaW5lVG9vbHMpO1xuICAgIGNsZWFyVG9vbEJhc2VsaW5lKHBpIGFzIHVua25vd24gYXMgb2JqZWN0KTtcblxuICAgIC8vIEF1dG8gcnVuIDEgXHUyMDE0IGNhcHR1cmVzIGJhc2VsaW5lLlxuICAgIGF3YWl0IHNlbGVjdEFuZEFwcGx5TW9kZWwoXG4gICAgICBtYWtlQ3R4KGF2YWlsYWJsZU1vZGVscyksIHBpIGFzIGFueSwgXCJnYXRlLWV2YWx1YXRlXCIsIFwidTFcIixcbiAgICAgIGVudi5kaXIsIHVuZGVmaW5lZCwgZmFsc2UsXG4gICAgICB7IHByb3ZpZGVyOiBcImFudGhyb3BpY1wiLCBpZDogXCJjbGF1ZGUtc29ubmV0LTQtNlwiIH0sXG4gICAgICB1bmRlZmluZWQsIC8qIGlzQXV0b01vZGUgKi8gdHJ1ZSxcbiAgICApO1xuXG4gICAgLy8gR3VpZGVkIGRpc3BhdGNoIGluIGJldHdlZW4gXHUyMDE0IG11c3Qgbm90IGNvcnJ1cHQgdGhlIGJhc2VsaW5lLlxuICAgIHBpLnNldEFjdGl2ZVRvb2xzKFtcIm5hcnJvd19mb3JfZ3VpZGVkXCJdKTtcbiAgICBhd2FpdCBzZWxlY3RBbmRBcHBseU1vZGVsKFxuICAgICAgbWFrZUN0eChhdmFpbGFibGVNb2RlbHMpLCBwaSBhcyBhbnksIFwiZ2F0ZS1ldmFsdWF0ZVwiLCBcInUtZ3VpZGVkXCIsXG4gICAgICBlbnYuZGlyLCB1bmRlZmluZWQsIGZhbHNlLFxuICAgICAgeyBwcm92aWRlcjogXCJhbnRocm9waWNcIiwgaWQ6IFwiY2xhdWRlLXNvbm5ldC00LTZcIiB9LFxuICAgICAgdW5kZWZpbmVkLCAvKiBpc0F1dG9Nb2RlICovIGZhbHNlLFxuICAgICk7XG5cbiAgICAvLyBOb3cgbmFycm93IGZ1cnRoZXIgKHNpbXVsYXRpbmcgYW55IHBvc3QtZ3VpZGVkIHN0YXRlKSBhbmQgcnVuIGF1dG8gdTIuXG4gICAgcGkuc2V0QWN0aXZlVG9vbHMoW1wic29tZXRoaW5nX2NvbXBsZXRlbHlfZGlmZmVyZW50XCJdKTtcbiAgICBjb25zdCBjYWxsc0JlZm9yZVUyID0gcGkuX19jYWxscy5sZW5ndGg7XG5cbiAgICAvLyBBdXRvIHJ1biAyIFx1MjAxNCBtdXN0IHJlc3RvcmUgdGhlIE9SSUdJTkFMIGF1dG8tZXJhIGJhc2VsaW5lLCBub3QgdGhlXG4gICAgLy8gaW50ZXJ2ZW5pbmcgbmFycm93LWZvci1ndWlkZWQgc3RhdGUuXG4gICAgYXdhaXQgc2VsZWN0QW5kQXBwbHlNb2RlbChcbiAgICAgIG1ha2VDdHgoYXZhaWxhYmxlTW9kZWxzKSwgcGkgYXMgYW55LCBcImdhdGUtZXZhbHVhdGVcIiwgXCJ1MlwiLFxuICAgICAgZW52LmRpciwgdW5kZWZpbmVkLCBmYWxzZSxcbiAgICAgIHsgcHJvdmlkZXI6IFwiYW50aHJvcGljXCIsIGlkOiBcImNsYXVkZS1zb25uZXQtNC02XCIgfSxcbiAgICAgIHVuZGVmaW5lZCwgLyogaXNBdXRvTW9kZSAqLyB0cnVlLFxuICAgICk7XG5cbiAgICBjb25zdCB1MkNhbGxzID0gcGkuX19jYWxscy5zbGljZShjYWxsc0JlZm9yZVUyKTtcbiAgICBjb25zdCByZXN0b3JlQ2FsbCA9IHUyQ2FsbHMuZmluZChcbiAgICAgIGMgPT4gYy5raW5kID09PSBcInNldEFjdGl2ZVRvb2xzXCJcbiAgICAgICAgJiYgQXJyYXkuaXNBcnJheShjLnBheWxvYWQpXG4gICAgICAgICYmIChjLnBheWxvYWQgYXMgc3RyaW5nW10pLmxlbmd0aCA9PT0gYmFzZWxpbmVUb29scy5sZW5ndGhcbiAgICAgICAgJiYgYmFzZWxpbmVUb29scy5ldmVyeSh0ID0+IChjLnBheWxvYWQgYXMgc3RyaW5nW10pLmluY2x1ZGVzKHQpKSxcbiAgICApO1xuICAgIGFzc2VydC5vayhcbiAgICAgIHJlc3RvcmVDYWxsLFxuICAgICAgXCJhdXRvIHJ1biAyIG11c3QgcmVzdG9yZSB0aGUgYXV0by1lcmEgYmFzZWxpbmUgW0EsIEIsIENdIFx1MjAxNCBwcm92ZXMgZ3VpZGVkLWZsb3cgZGlkbid0IGNvcnJ1cHQgaXRcIixcbiAgICApO1xuICB9IGZpbmFsbHkge1xuICAgIGVudi5yZXN0b3JlRW52KCk7XG4gICAgZW52LmNsZWFudXAoKTtcbiAgfVxufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUF5QkEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUNuQixTQUFTLGFBQWEsV0FBVyxRQUFRLHFCQUFxQjtBQUM5RCxTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBRXZCO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUNQO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBRVAsU0FBUyxrQkFBZ0Y7QUFDdkYsUUFBTSxjQUFjLFFBQVEsSUFBSTtBQUNoQyxRQUFNLGtCQUFrQixRQUFRLElBQUk7QUFDcEMsUUFBTSxNQUFNLFlBQVksS0FBSyxPQUFPLEdBQUcsb0JBQW9CLENBQUM7QUFDNUQsUUFBTSxPQUFPLFlBQVksS0FBSyxPQUFPLEdBQUcsa0JBQWtCLENBQUM7QUFDM0QsWUFBVSxLQUFLLEtBQUssTUFBTSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFFaEQsZ0JBQWMsS0FBSyxLQUFLLFFBQVEsZ0JBQWdCLEdBQUcsY0FBYyxPQUFPO0FBQ3hFLFVBQVEsSUFBSSxXQUFXO0FBQ3ZCLFVBQVEsTUFBTSxHQUFHO0FBQ2pCLFNBQU87QUFBQSxJQUNMO0FBQUEsSUFDQSxTQUFTLE1BQU07QUFDYixhQUFPLEtBQUssRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFDNUMsYUFBTyxNQUFNLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDL0M7QUFBQSxJQUNBLFlBQVksTUFBTTtBQUNoQixjQUFRLE1BQU0sV0FBVztBQUN6QixVQUFJLG9CQUFvQixPQUFXLFFBQU8sUUFBUSxJQUFJO0FBQUEsVUFDakQsU0FBUSxJQUFJLFdBQVc7QUFBQSxJQUM5QjtBQUFBLEVBQ0Y7QUFDRjtBQWFBLFNBQVMsZ0JBQWdCLG9CQUEyQztBQUNsRSxRQUFNLFFBQW1ELENBQUM7QUFDMUQsTUFBSSxTQUFTLENBQUMsR0FBRyxrQkFBa0I7QUFDbkMsU0FBTztBQUFBLElBQ0wsU0FBUztBQUFBLElBQ1QsSUFBSSxnQkFBZ0I7QUFBRSxhQUFPO0FBQUEsSUFBUTtBQUFBLElBQ3JDLFVBQVUsT0FBTyxNQUFNO0FBQ3JCLFlBQU0sS0FBSyxFQUFFLE1BQU0sWUFBWSxTQUFTLEdBQUcsRUFBRSxRQUFRLElBQUksRUFBRSxFQUFFLEdBQUcsQ0FBQztBQUNqRSxhQUFPO0FBQUEsSUFDVDtBQUFBLElBQ0EsdUJBQXVCLFlBQVk7QUFDakMsWUFBTSxLQUFLLEVBQUUsTUFBTSx5QkFBeUIsU0FBUyxLQUFLLENBQUM7QUFDM0QsYUFBTztBQUFBLElBQ1Q7QUFBQSxJQUNBLGdCQUFnQixNQUFNO0FBQ3BCLFlBQU0sS0FBSyxFQUFFLE1BQU0sa0JBQWtCLFNBQVMsQ0FBQyxHQUFHLE1BQU0sRUFBRSxDQUFDO0FBQzNELGFBQU8sQ0FBQyxHQUFHLE1BQU07QUFBQSxJQUNuQjtBQUFBLElBQ0EsbUJBQW1CLFlBQVk7QUFDN0IsWUFBTSxLQUFLLEVBQUUsTUFBTSxxQkFBcUIsU0FBUyxLQUFLLENBQUM7QUFDdkQsYUFBTztBQUFBLElBQ1Q7QUFBQSxJQUNBLGdCQUFnQixDQUFDLFVBQVU7QUFDekIsZUFBUyxDQUFDLEdBQUcsS0FBSztBQUNsQixZQUFNLEtBQUssRUFBRSxNQUFNLGtCQUFrQixTQUFTLENBQUMsR0FBRyxLQUFLLEVBQUUsQ0FBQztBQUFBLElBQzVEO0FBQUEsSUFDQSxrQkFBa0IsTUFBTTtBQUFBLElBQUM7QUFBQSxFQUMzQjtBQUNGO0FBRUEsU0FBUyxRQUFRLGlCQUF1RTtBQUN0RixTQUFPO0FBQUEsSUFDTCxlQUFlO0FBQUEsTUFDYixjQUFjLE1BQU07QUFBQSxNQUNwQixxQkFBcUIsTUFBTTtBQUFBLElBQzdCO0FBQUEsSUFDQSxnQkFBZ0IsRUFBRSxjQUFjLE1BQU0sZUFBZTtBQUFBLElBQ3JELElBQUksRUFBRSxRQUFRLE1BQU07QUFBQSxJQUFDLEVBQUU7QUFBQSxJQUN2QixPQUFPLEVBQUUsVUFBVSxnQkFBZ0IsQ0FBQyxHQUFHLFVBQVUsSUFBSSxnQkFBZ0IsQ0FBQyxHQUFHLElBQUksS0FBSyxnQkFBZ0IsQ0FBQyxHQUFHLElBQUk7QUFBQSxFQUM1RztBQUNGO0FBU0EsS0FBSyw0RkFBdUYsWUFBWTtBQUN0RyxRQUFNLE1BQU0sZ0JBQWdCO0FBQzVCLE1BQUk7QUFTRjtBQUFBLE1BQ0UsS0FBSyxJQUFJLEtBQUssUUFBUSxnQkFBZ0I7QUFBQSxNQUN0QyxDQUFDLE9BQU8sb0JBQW9CLG1CQUFtQixrQkFBa0IsMENBQTBDLEtBQUssRUFBRSxLQUFLLElBQUk7QUFBQSxNQUMzSDtBQUFBLElBQ0Y7QUFDQSxVQUFNLGtCQUFrQjtBQUFBLE1BQ3RCLEVBQUUsSUFBSSxxQkFBcUIsVUFBVSxhQUFhLEtBQUsscUJBQXFCO0FBQUEsSUFDOUU7QUFDQSxVQUFNLEtBQUssZ0JBQWdCLENBQUMsQ0FBQztBQUM3QixzQkFBa0IsRUFBdUI7QUFFekMsVUFBTSxTQUFTLE1BQU07QUFBQSxNQUNuQixRQUFRLGVBQWU7QUFBQSxNQUN2QjtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQSxJQUFJO0FBQUEsTUFDSjtBQUFBLE1BQ0E7QUFBQSxNQUNBLEVBQUUsVUFBVSxhQUFhLElBQUksb0JBQW9CO0FBQUEsTUFDakQ7QUFBQSxNQUNBO0FBQUEsSUFDRjtBQUVBLFdBQU8sTUFBTSxPQUFPLGNBQWMsSUFBSSxxQkFBcUIsNENBQTRDO0FBQ3ZHLFVBQU0sZ0JBQWdCLEdBQUcsUUFBUSxPQUFPLE9BQUssRUFBRSxTQUFTLFVBQVU7QUFDbEUsV0FBTyxNQUFNLGNBQWMsUUFBUSxHQUFHLCtDQUErQztBQUFBLEVBQ3ZGLFVBQUU7QUFDQSxRQUFJLFdBQVc7QUFDZixRQUFJLFFBQVE7QUFBQSxFQUNkO0FBQ0YsQ0FBQztBQUVELEtBQUssMEdBQXFHLFlBQVk7QUFDcEgsUUFBTSxNQUFNLGdCQUFnQjtBQUM1QixNQUFJO0FBS0YsVUFBTSxrQkFBa0I7QUFBQSxNQUN0QixFQUFFLElBQUkscUJBQXFCLFVBQVUsYUFBYSxLQUFLLHFCQUFxQjtBQUFBLElBQzlFO0FBQ0EsVUFBTSxLQUFLLGdCQUFnQixDQUFDLHNCQUFzQixDQUFDO0FBQ25ELHNCQUFrQixFQUF1QjtBQUV6QyxVQUFNLFNBQVMsTUFBTTtBQUFBLE1BQ25CLFFBQVEsZUFBZTtBQUFBLE1BQ3ZCO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBLElBQUk7QUFBQSxNQUNKO0FBQUEsTUFDQTtBQUFBLE1BQ0EsRUFBRSxVQUFVLGFBQWEsSUFBSSxvQkFBb0I7QUFBQSxNQUNqRDtBQUFBLE1BQ0E7QUFBQSxJQUNGO0FBRUEsV0FBTyxNQUFNLE9BQU8sY0FBYyxJQUFJLHFCQUFxQix1Q0FBdUM7QUFDbEcsVUFBTSxnQkFBZ0IsR0FBRyxRQUFRLE9BQU8sT0FBSyxFQUFFLFNBQVMsVUFBVTtBQUNsRSxXQUFPLE1BQU0sY0FBYyxRQUFRLEdBQUcsK0NBQStDO0FBQUEsRUFDdkYsVUFBRTtBQUNBLFFBQUksV0FBVztBQUNmLFFBQUksUUFBUTtBQUFBLEVBQ2Q7QUFDRixDQUFDO0FBR0QsS0FBSyx1RkFBdUYsWUFBWTtBQUN0RyxRQUFNLE1BQU0sZ0JBQWdCO0FBQzVCLE1BQUk7QUFRRixVQUFNLGtCQUFrQjtBQUFBLE1BQ3RCLEVBQUUsSUFBSSxpQkFBaUIsVUFBVSxVQUFVLEtBQUsscUJBQXFCO0FBQUEsTUFDckUsRUFBRSxJQUFJLGVBQWUsVUFBVSxhQUFhLEtBQUsscUJBQXFCO0FBQUEsSUFDeEU7QUFHQSxVQUFNLEtBQUssZ0JBQWdCLENBQUMsd0JBQXdCLGtCQUFrQixDQUFDO0FBQ3ZFLHNCQUFrQixFQUF1QjtBQUl6QyxVQUFNO0FBQUEsTUFDSixRQUFRLGVBQWU7QUFBQSxNQUN2QjtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQSxJQUFJO0FBQUEsTUFDSjtBQUFBLE1BQ0E7QUFBQSxNQUNBLEVBQUUsVUFBVSxVQUFVLElBQUksZ0JBQWdCO0FBQUEsTUFDMUM7QUFBQSxNQUNBO0FBQUEsSUFDRjtBQUVBLFVBQU0sMEJBQTBCLEdBQUcsUUFBUSxPQUFPLE9BQUssRUFBRSxTQUFTLFVBQVUsRUFBRTtBQUM5RSxXQUFPLEdBQUcsMkJBQTJCLEdBQUcsK0JBQStCO0FBT3ZFLFVBQU0sY0FBYyxHQUFHLFFBQVEsT0FBTyxPQUFLLEVBQUUsU0FBUyxVQUFVLEVBQUU7QUFDbEUsVUFBTTtBQUFBLE1BQ0osUUFBUSxlQUFlO0FBQUEsTUFDdkI7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0EsSUFBSTtBQUFBLE1BQ0o7QUFBQSxNQUNBO0FBQUEsTUFDQSxFQUFFLFVBQVUsYUFBYSxJQUFJLGNBQWM7QUFBQSxNQUMzQztBQUFBLE1BQ0E7QUFBQSxJQUNGO0FBQ0EsVUFBTSxhQUFhLEdBQUcsUUFBUSxPQUFPLE9BQUssRUFBRSxTQUFTLFVBQVUsRUFBRTtBQUNqRSxXQUFPLEdBQUcsYUFBYSxhQUFhLHVGQUFrRjtBQUFBLEVBQ3hILFVBQUU7QUFDQSxRQUFJLFdBQVc7QUFDZixRQUFJLFFBQVE7QUFBQSxFQUNkO0FBQ0YsQ0FBQztBQVdELEtBQUssK0dBQTBHLFlBQVk7QUFDekgsUUFBTSxNQUFNLGdCQUFnQjtBQUM1QixNQUFJO0FBR0YsOEJBQTBCLGtCQUFrQixFQUFFLGdCQUFnQixLQUFLLENBQUM7QUFLcEU7QUFBQSxNQUNFLEtBQUssSUFBSSxLQUFLLFFBQVEsZ0JBQWdCO0FBQUEsTUFDdEMsQ0FBQyxPQUFPLG9CQUFvQixtQkFBbUIsa0JBQWtCLG9DQUFvQyxLQUFLLEVBQUUsS0FBSyxJQUFJO0FBQUEsTUFDckg7QUFBQSxJQUNGO0FBRUEsVUFBTSxrQkFBa0I7QUFBQSxNQUN0QixFQUFFLElBQUksa0JBQWtCLFVBQVUsVUFBVSxLQUFLLGNBQWM7QUFBQSxJQUNqRTtBQUNBLFVBQU0sS0FBSyxnQkFBZ0IsQ0FBQyxnQkFBZ0IsQ0FBQztBQUM3QyxzQkFBa0IsRUFBdUI7QUFFekMsVUFBTSxNQUFNLFFBQVEsZUFBZTtBQUduQyxRQUFJLFFBQVEsRUFBRSxVQUFVLFVBQVUsSUFBSSxrQkFBa0IsS0FBSyxjQUFjO0FBRTNFLFFBQUk7QUFDSixRQUFJO0FBQ0YsWUFBTTtBQUFBLFFBQ0o7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBLElBQUk7QUFBQSxRQUNKO0FBQUEsUUFDQTtBQUFBLFFBQ0EsRUFBRSxVQUFVLFVBQVUsSUFBSSxpQkFBaUI7QUFBQSxRQUMzQztBQUFBLFFBQ0E7QUFBQSxNQUNGO0FBQUEsSUFDRixTQUFTLEdBQUc7QUFDVixlQUFTO0FBQUEsSUFDWDtBQUVBLFdBQU8sR0FBRyxrQkFBa0IsaUNBQWlDLDhDQUE4QztBQUMzRyxVQUFNLE1BQU07QUFDWixXQUFPLE1BQU0sSUFBSSxVQUFVLFlBQVk7QUFDdkMsV0FBTyxNQUFNLElBQUksU0FBUyxzQkFBc0IsdURBQXVEO0FBQ3ZHLFdBQU8sTUFBTSxJQUFJLFNBQVMsa0JBQWtCLHVDQUF1QztBQUNuRixXQUFPLE1BQU0sSUFBSSxTQUFTLGVBQWUseURBQXlEO0FBQUEsRUFDcEcsVUFBRTtBQUNBLG1DQUErQjtBQUMvQixRQUFJLFdBQVc7QUFDZixRQUFJLFFBQVE7QUFBQSxFQUNkO0FBQ0YsQ0FBQztBQUdELEtBQUssb0dBQStGLFlBQVk7QUFDOUcsUUFBTSxNQUFNLGdCQUFnQjtBQUM1QixNQUFJO0FBYUYsVUFBTSxrQkFBa0I7QUFBQSxNQUN0QixFQUFFLElBQUksZUFBZSxVQUFVLGtCQUFrQixLQUFLLHFCQUFxQjtBQUFBLElBQzdFO0FBQ0EsVUFBTSxLQUFLLGdCQUFnQixDQUFDLENBQUM7QUFDN0Isc0JBQWtCLEVBQXVCO0FBRXpDLFVBQU0sTUFBTSxRQUFRLGVBQWU7QUFFbkMsUUFBSSxRQUFRLEVBQUUsVUFBVSxhQUFhLElBQUkscUJBQXFCLEtBQUsscUJBQXFCO0FBSXhGO0FBQUEsTUFDRSxLQUFLLElBQUksS0FBSyxRQUFRLGdCQUFnQjtBQUFBLE1BQ3RDLENBQUMsT0FBTyxvQkFBb0IsbUJBQW1CLDJCQUEyQixrQkFBa0IseUNBQXlDLEtBQUssRUFBRSxLQUFLLElBQUk7QUFBQSxNQUNySjtBQUFBLElBQ0Y7QUFFQSxRQUFJO0FBQ0osUUFBSTtBQUNGLFlBQU07QUFBQSxRQUNKO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQSxJQUFJO0FBQUEsUUFDSjtBQUFBLFFBQ0E7QUFBQSxRQUNBLEVBQUUsVUFBVSxhQUFhLElBQUksb0JBQW9CO0FBQUEsUUFDakQ7QUFBQSxRQUNBO0FBQUEsTUFDRjtBQUFBLElBQ0YsU0FBUyxHQUFHO0FBQ1YsZUFBUztBQUFBLElBQ1g7QUFFQSxXQUFPLEdBQUcsa0JBQWtCLGlDQUFpQyw4Q0FBOEM7QUFDM0csVUFBTSxNQUFNO0FBQ1osV0FBTyxNQUFNLElBQUksVUFBVSxZQUFZO0FBQ3ZDLFdBQU8sTUFBTSxJQUFJLFFBQVEsSUFBSTtBQUM3QixXQUFPLEdBQUcsSUFBSSxRQUFRLFNBQVMsR0FBRyxpQ0FBaUM7QUFBQSxFQUNyRSxVQUFFO0FBQ0EsUUFBSSxXQUFXO0FBQ2YsUUFBSSxRQUFRO0FBQUEsRUFDZDtBQUNGLENBQUM7QUFHRCxLQUFLLHdGQUF3RixZQUFZO0FBQ3ZHLFFBQU0sTUFBTSxnQkFBZ0I7QUFDNUIsTUFBSTtBQUNGLFVBQU0sa0JBQWtCO0FBQUEsTUFDdEIsRUFBRSxJQUFJLHFCQUFxQixVQUFVLGFBQWEsS0FBSyxxQkFBcUI7QUFBQSxJQUM5RTtBQUNBLFVBQU0sZ0JBQWdCLENBQUMsd0JBQXdCLFVBQVUsUUFBUTtBQUNqRSxVQUFNLEtBQUssZ0JBQWdCLGFBQWE7QUFDeEMsc0JBQWtCLEVBQXVCO0FBR3pDLFVBQU07QUFBQSxNQUNKLFFBQVEsZUFBZTtBQUFBLE1BQ3ZCO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBLElBQUk7QUFBQSxNQUNKO0FBQUEsTUFDQTtBQUFBLE1BQ0EsRUFBRSxVQUFVLGFBQWEsSUFBSSxvQkFBb0I7QUFBQSxNQUNqRDtBQUFBLE1BQ0E7QUFBQSxJQUNGO0FBR0EsT0FBRyxlQUFlLENBQUMsc0JBQXNCLENBQUM7QUFDMUMsVUFBTSxnQkFBZ0IsR0FBRyxRQUFRO0FBR2pDLFVBQU07QUFBQSxNQUNKLFFBQVEsZUFBZTtBQUFBLE1BQ3ZCO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBLElBQUk7QUFBQSxNQUNKO0FBQUEsTUFDQTtBQUFBLE1BQ0EsRUFBRSxVQUFVLGFBQWEsSUFBSSxvQkFBb0I7QUFBQSxNQUNqRDtBQUFBLE1BQ0E7QUFBQSxJQUNGO0FBRUEsVUFBTSxVQUFVLEdBQUcsUUFBUSxNQUFNLGFBQWE7QUFDOUMsVUFBTSxjQUFjLFFBQVE7QUFBQSxNQUMxQixPQUFLLEVBQUUsU0FBUyxvQkFDWCxNQUFNLFFBQVEsRUFBRSxPQUFPLEtBQ3RCLEVBQUUsUUFBcUIsV0FBVyxjQUFjLFVBQ2pELGNBQWMsTUFBTSxPQUFNLEVBQUUsUUFBcUIsU0FBUyxDQUFDLENBQUM7QUFBQSxJQUNuRTtBQUNBLFdBQU8sR0FBRyxhQUFhLHlGQUF5RjtBQUVoSCxVQUFNLGFBQWEsUUFBUSxRQUFRLFdBQVk7QUFDL0MsVUFBTSxjQUFjLFFBQVEsVUFBVSxPQUFLLEVBQUUsU0FBUyxVQUFVO0FBQ2hFLFdBQU8sR0FBRyxjQUFjLFlBQVksaURBQWlEO0FBQUEsRUFDdkYsVUFBRTtBQUNBLFFBQUksV0FBVztBQUNmLFFBQUksUUFBUTtBQUFBLEVBQ2Q7QUFDRixDQUFDO0FBR0QsS0FBSyxrRUFBa0UsWUFBWTtBQUNqRixRQUFNLE1BQU0sZ0JBQWdCO0FBQzVCLE1BQUk7QUFDRjtBQUFBLE1BQ0UsS0FBSyxJQUFJLEtBQUssUUFBUSxnQkFBZ0I7QUFBQSxNQUN0QyxDQUFDLE9BQU8sb0JBQW9CLG1CQUFtQiwyQkFBMkIsa0JBQWtCLHlDQUF5QyxLQUFLLEVBQUUsS0FBSyxJQUFJO0FBQUEsTUFDcko7QUFBQSxJQUNGO0FBRUEsVUFBTSxrQkFBa0I7QUFBQSxNQUN0QixFQUFFLElBQUksZUFBZSxVQUFVLGtCQUFrQixLQUFLLHFCQUFxQjtBQUFBLElBQzdFO0FBQ0EsVUFBTSxLQUFLLGdCQUFnQixDQUFDLENBQUM7QUFDN0Isc0JBQWtCLEVBQXVCO0FBRXpDLFVBQU0sTUFBTSxRQUFRLGVBQWU7QUFDbkMsUUFBSSxRQUFRLEVBQUUsVUFBVSxhQUFhLElBQUkscUJBQXFCLEtBQUsscUJBQXFCO0FBRXhGLFFBQUk7QUFDSixRQUFJO0FBQ0YsWUFBTTtBQUFBLFFBQ0o7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBLElBQUk7QUFBQSxRQUNKO0FBQUEsUUFDQTtBQUFBLFFBQ0EsRUFBRSxVQUFVLGFBQWEsSUFBSSxvQkFBb0I7QUFBQSxRQUNqRDtBQUFBLFFBQ0E7QUFBQSxNQUNGO0FBQUEsSUFDRixTQUFTLEdBQUc7QUFDVixlQUFTO0FBQUEsSUFDWDtBQUVBLFdBQU8sR0FBRyxRQUFRLGNBQWM7QUFHaEMsV0FBTztBQUFBLE1BQ0wsT0FBUTtBQUFBLE1BQ1I7QUFBQSxNQUNBO0FBQUEsSUFDRjtBQUNBLFdBQU8sTUFBTSxPQUFRLFNBQVMsK0JBQStCLGdDQUFnQztBQUFBLEVBQy9GLFVBQUU7QUFDQSxRQUFJLFdBQVc7QUFDZixRQUFJLFFBQVE7QUFBQSxFQUNkO0FBQ0YsQ0FBQztBQVlELEtBQUssaUdBQWlHLFlBQVk7QUFDaEgsUUFBTSxNQUFNLGdCQUFnQjtBQUM1QixNQUFJO0FBQ0YsVUFBTSxrQkFBa0I7QUFBQSxNQUN0QixFQUFFLElBQUkscUJBQXFCLFVBQVUsYUFBYSxLQUFLLHFCQUFxQjtBQUFBLElBQzlFO0FBQ0EsVUFBTSxLQUFLLGdCQUFnQixDQUFDLEtBQUssS0FBSyxHQUFHLENBQUM7QUFDMUMsc0JBQWtCLEVBQXVCO0FBR3pDLFVBQU07QUFBQSxNQUNKLFFBQVEsZUFBZTtBQUFBLE1BQ3ZCO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBLElBQUk7QUFBQSxNQUNKO0FBQUEsTUFDQTtBQUFBLE1BQ0EsRUFBRSxVQUFVLGFBQWEsSUFBSSxvQkFBb0I7QUFBQSxNQUNqRDtBQUFBLE1BQ0E7QUFBQSxJQUNGO0FBS0Esc0JBQWtCLEVBQXVCO0FBQ3pDLE9BQUcsZUFBZSxDQUFDLEtBQUssR0FBRyxDQUFDO0FBRzVCLFVBQU0sZ0JBQWdCLEdBQUcsUUFBUTtBQUNqQyxVQUFNO0FBQUEsTUFDSixRQUFRLGVBQWU7QUFBQSxNQUN2QjtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQSxJQUFJO0FBQUEsTUFDSjtBQUFBLE1BQ0E7QUFBQSxNQUNBLEVBQUUsVUFBVSxhQUFhLElBQUksb0JBQW9CO0FBQUEsTUFDakQ7QUFBQSxNQUNBO0FBQUEsSUFDRjtBQUNBLFVBQU0sVUFBVSxHQUFHLFFBQVEsTUFBTSxhQUFhO0FBRzlDLFVBQU0sZUFBZSxRQUFRO0FBQUEsTUFDM0IsT0FBSyxFQUFFLFNBQVMsb0JBQ1gsTUFBTSxRQUFRLEVBQUUsT0FBTyxLQUN0QixFQUFFLFFBQXFCLFNBQVMsR0FBRztBQUFBLElBQzNDO0FBQ0EsV0FBTztBQUFBLE1BQ0w7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLElBQ0Y7QUFHQSxPQUFHLGVBQWUsQ0FBQyxHQUFHLENBQUM7QUFDdkIsVUFBTSxnQkFBZ0IsR0FBRyxRQUFRO0FBQ2pDLFVBQU07QUFBQSxNQUNKLFFBQVEsZUFBZTtBQUFBLE1BQ3ZCO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBLElBQUk7QUFBQSxNQUNKO0FBQUEsTUFDQTtBQUFBLE1BQ0EsRUFBRSxVQUFVLGFBQWEsSUFBSSxvQkFBb0I7QUFBQSxNQUNqRDtBQUFBLE1BQ0E7QUFBQSxJQUNGO0FBQ0EsVUFBTSxVQUFVLEdBQUcsUUFBUSxNQUFNLGFBQWE7QUFDOUMsVUFBTSx3QkFBd0IsUUFBUTtBQUFBLE1BQ3BDLE9BQUssRUFBRSxTQUFTLG9CQUNYLE1BQU0sUUFBUSxFQUFFLE9BQU8sS0FDdEIsRUFBRSxRQUFxQixXQUFXLEtBQ2xDLEVBQUUsUUFBcUIsU0FBUyxHQUFHLEtBQ25DLEVBQUUsUUFBcUIsU0FBUyxHQUFHLEtBQ3BDLENBQUUsRUFBRSxRQUFxQixTQUFTLEdBQUc7QUFBQSxJQUM1QztBQUNBLFdBQU87QUFBQSxNQUNMO0FBQUEsTUFDQTtBQUFBLElBQ0Y7QUFBQSxFQUNGLFVBQUU7QUFDQSxRQUFJLFdBQVc7QUFDZixRQUFJLFFBQVE7QUFBQSxFQUNkO0FBQ0YsQ0FBQztBQWNELEtBQUssNEZBQTRGLFlBQVk7QUFDM0csUUFBTSxNQUFNLGdCQUFnQjtBQUM1QixNQUFJO0FBQ0YsVUFBTSxrQkFBa0I7QUFBQSxNQUN0QixFQUFFLElBQUkscUJBQXFCLFVBQVUsYUFBYSxLQUFLLHFCQUFxQjtBQUFBLElBQzlFO0FBQ0EsVUFBTSxnQkFBZ0IsQ0FBQyx3QkFBd0IsVUFBVSxRQUFRO0FBQ2pFLFVBQU0sS0FBSyxnQkFBZ0IsYUFBYTtBQUN4QyxzQkFBa0IsRUFBdUI7QUFHekMsVUFBTTtBQUFBLE1BQ0osUUFBUSxlQUFlO0FBQUEsTUFDdkI7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0EsSUFBSTtBQUFBLE1BQ0o7QUFBQSxNQUNBO0FBQUEsTUFDQSxFQUFFLFVBQVUsYUFBYSxJQUFJLG9CQUFvQjtBQUFBLE1BQ2pEO0FBQUE7QUFBQSxNQUNpQjtBQUFBLElBQ25CO0FBR0EsT0FBRyxlQUFlLENBQUMscUJBQXFCLENBQUM7QUFDekMsVUFBTSxvQkFBb0IsR0FBRyxRQUFRO0FBR3JDLFVBQU07QUFBQSxNQUNKLFFBQVEsZUFBZTtBQUFBLE1BQ3ZCO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBLElBQUk7QUFBQSxNQUNKO0FBQUEsTUFDQTtBQUFBLE1BQ0EsRUFBRSxVQUFVLGFBQWEsSUFBSSxvQkFBb0I7QUFBQSxNQUNqRDtBQUFBO0FBQUEsTUFDaUI7QUFBQSxJQUNuQjtBQUVBLFVBQU0sY0FBYyxHQUFHLFFBQVEsTUFBTSxpQkFBaUI7QUFJdEQsVUFBTSxrQkFBa0IsWUFBWTtBQUFBLE1BQ2xDLE9BQUssRUFBRSxTQUFTLG9CQUNYLE1BQU0sUUFBUSxFQUFFLE9BQU8sS0FDdkIsY0FBYyxNQUFNLE9BQU0sRUFBRSxRQUFxQixTQUFTLENBQUMsQ0FBQztBQUFBLElBQ25FO0FBQ0EsV0FBTztBQUFBLE1BQ0w7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLElBQ0Y7QUFBQSxFQUNGLFVBQUU7QUFDQSxRQUFJLFdBQVc7QUFDZixRQUFJLFFBQVE7QUFBQSxFQUNkO0FBQ0YsQ0FBQztBQUVELEtBQUssdUhBQTZHLFlBQVk7QUFDNUgsUUFBTSxNQUFNLGdCQUFnQjtBQUM1QixNQUFJO0FBQ0YsVUFBTSxrQkFBa0I7QUFBQSxNQUN0QixFQUFFLElBQUkscUJBQXFCLFVBQVUsYUFBYSxLQUFLLHFCQUFxQjtBQUFBLElBQzlFO0FBQ0EsVUFBTSxnQkFBZ0IsQ0FBQyx3QkFBd0IsVUFBVSxRQUFRO0FBQ2pFLFVBQU0sS0FBSyxnQkFBZ0IsYUFBYTtBQUN4QyxzQkFBa0IsRUFBdUI7QUFHekMsVUFBTTtBQUFBLE1BQ0osUUFBUSxlQUFlO0FBQUEsTUFBRztBQUFBLE1BQVc7QUFBQSxNQUFpQjtBQUFBLE1BQ3RELElBQUk7QUFBQSxNQUFLO0FBQUEsTUFBVztBQUFBLE1BQ3BCLEVBQUUsVUFBVSxhQUFhLElBQUksb0JBQW9CO0FBQUEsTUFDakQ7QUFBQTtBQUFBLE1BQTRCO0FBQUEsSUFDOUI7QUFHQSxPQUFHLGVBQWUsQ0FBQyxtQkFBbUIsQ0FBQztBQUN2QyxVQUFNO0FBQUEsTUFDSixRQUFRLGVBQWU7QUFBQSxNQUFHO0FBQUEsTUFBVztBQUFBLE1BQWlCO0FBQUEsTUFDdEQsSUFBSTtBQUFBLE1BQUs7QUFBQSxNQUFXO0FBQUEsTUFDcEIsRUFBRSxVQUFVLGFBQWEsSUFBSSxvQkFBb0I7QUFBQSxNQUNqRDtBQUFBO0FBQUEsTUFBNEI7QUFBQSxJQUM5QjtBQUdBLE9BQUcsZUFBZSxDQUFDLGdDQUFnQyxDQUFDO0FBQ3BELFVBQU0sZ0JBQWdCLEdBQUcsUUFBUTtBQUlqQyxVQUFNO0FBQUEsTUFDSixRQUFRLGVBQWU7QUFBQSxNQUFHO0FBQUEsTUFBVztBQUFBLE1BQWlCO0FBQUEsTUFDdEQsSUFBSTtBQUFBLE1BQUs7QUFBQSxNQUFXO0FBQUEsTUFDcEIsRUFBRSxVQUFVLGFBQWEsSUFBSSxvQkFBb0I7QUFBQSxNQUNqRDtBQUFBO0FBQUEsTUFBNEI7QUFBQSxJQUM5QjtBQUVBLFVBQU0sVUFBVSxHQUFHLFFBQVEsTUFBTSxhQUFhO0FBQzlDLFVBQU0sY0FBYyxRQUFRO0FBQUEsTUFDMUIsT0FBSyxFQUFFLFNBQVMsb0JBQ1gsTUFBTSxRQUFRLEVBQUUsT0FBTyxLQUN0QixFQUFFLFFBQXFCLFdBQVcsY0FBYyxVQUNqRCxjQUFjLE1BQU0sT0FBTSxFQUFFLFFBQXFCLFNBQVMsQ0FBQyxDQUFDO0FBQUEsSUFDbkU7QUFDQSxXQUFPO0FBQUEsTUFDTDtBQUFBLE1BQ0E7QUFBQSxJQUNGO0FBQUEsRUFDRixVQUFFO0FBQ0EsUUFBSSxXQUFXO0FBQ2YsUUFBSSxRQUFRO0FBQUEsRUFDZDtBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
