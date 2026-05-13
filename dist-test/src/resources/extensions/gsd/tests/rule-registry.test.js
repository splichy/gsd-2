import assert from "node:assert/strict";
import { test, describe, beforeEach } from "node:test";
import {
  RuleRegistry,
  getRegistry,
  setRegistry,
  initRegistry,
  resetRegistry,
  convertDispatchRules,
  getOrCreateRegistry
} from "../rule-registry.js";
import { DISPATCH_RULES, getDispatchRuleNames } from "../auto-dispatch.js";
function mockDispatchRule(name, matchPhase) {
  return {
    name,
    when: "dispatch",
    evaluation: "first-match",
    where: async (ctx) => {
      if (ctx.state.phase === matchPhase) {
        return {
          action: "dispatch",
          unitType: `test-${matchPhase}`,
          unitId: "test-id",
          prompt: `Prompt for ${matchPhase}`
        };
      }
      return null;
    },
    then: () => {
    },
    description: `Mock rule for ${matchPhase}`
  };
}
function makeContext(phase) {
  return {
    basePath: "/tmp/test",
    mid: "M001",
    midTitle: "Test Milestone",
    state: {
      phase,
      activeMilestone: { id: "M001", title: "Test" },
      activeSlice: null,
      activeTask: null,
      recentDecisions: [],
      blockers: [],
      nextAction: "",
      registry: []
    },
    prefs: void 0
  };
}
describe("RuleRegistry", () => {
  beforeEach(() => {
    resetRegistry();
  });
  test("construct with dispatch rules, listRules returns them", () => {
    const rules = [
      mockDispatchRule("rule-a", "planning"),
      mockDispatchRule("rule-b", "executing"),
      mockDispatchRule("rule-c", "complete")
    ];
    const registry = new RuleRegistry(rules);
    const listed = registry.listRules();
    const dispatchRules = listed.filter((r) => r.when === "dispatch");
    assert.deepStrictEqual(dispatchRules.length, 3, "listRules returns 3 dispatch rules");
    assert.deepStrictEqual(dispatchRules[0].name, "rule-a", "first rule name is rule-a");
    assert.deepStrictEqual(dispatchRules[1].name, "rule-b", "second rule name is rule-b");
    assert.deepStrictEqual(dispatchRules[2].name, "rule-c", "third rule name is rule-c");
  });
  test("listRules returns correct fields on each rule", () => {
    const rules = [
      mockDispatchRule("check-fields", "planning")
    ];
    const registry = new RuleRegistry(rules);
    const listed = registry.listRules();
    const rule = listed.find((r) => r.name === "check-fields");
    assert.ok(rule !== void 0, "rule found by name");
    assert.deepStrictEqual(rule.when, "dispatch", "when field is dispatch");
    assert.deepStrictEqual(rule.evaluation, "first-match", "evaluation is first-match");
    assert.ok(typeof rule.where === "function", "where is a function");
    assert.ok(typeof rule.then === "function", "then is a function");
    assert.deepStrictEqual(rule.description, "Mock rule for planning", "description is set");
  });
  test("evaluateDispatch returns first matching rule", async () => {
    const rules = [
      mockDispatchRule("rule-planning", "planning"),
      mockDispatchRule("rule-executing", "executing"),
      mockDispatchRule("rule-complete", "complete")
    ];
    const registry = new RuleRegistry(rules);
    const ctx = makeContext("executing");
    const result = await registry.evaluateDispatch(ctx);
    assert.deepStrictEqual(result.action, "dispatch", "result is a dispatch action");
    if (result.action === "dispatch") {
      assert.deepStrictEqual(result.unitType, "test-executing", "matched the executing rule");
      assert.deepStrictEqual(result.prompt, "Prompt for executing", "prompt from matched rule");
    }
  });
  test("evaluateDispatch returns stop when no rule matches", async () => {
    const rules = [
      mockDispatchRule("only-planning", "planning")
    ];
    const registry = new RuleRegistry(rules);
    const ctx = makeContext("blocked");
    const result = await registry.evaluateDispatch(ctx);
    assert.deepStrictEqual(result.action, "stop", "result is a stop action");
    if (result.action === "stop") {
      assert.ok(result.reason.includes("blocked"), "stop reason mentions phase");
    }
  });
  test("evaluateDispatch works with async where predicate", async () => {
    const asyncRule = {
      name: "async-rule",
      when: "dispatch",
      evaluation: "first-match",
      where: async (ctx2) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (ctx2.state.phase === "planning") {
          return {
            action: "dispatch",
            unitType: "async-test",
            unitId: "async-id",
            prompt: "Async prompt"
          };
        }
        return null;
      },
      then: () => {
      }
    };
    const registry = new RuleRegistry([asyncRule]);
    const ctx = makeContext("planning");
    const result = await registry.evaluateDispatch(ctx);
    assert.deepStrictEqual(result.action, "dispatch", "async dispatch resolved");
    if (result.action === "dispatch") {
      assert.deepStrictEqual(result.unitType, "async-test", "async rule matched");
    }
  });
  test("resetState clears all mutable state", () => {
    const registry = new RuleRegistry([]);
    registry.activeHook = {
      hookName: "test-hook",
      triggerUnitType: "execute-task",
      triggerUnitId: "M001/S01/T01",
      cycle: 2,
      pendingRetry: false
    };
    registry.hookQueue.push({
      config: { name: "q", after: [], prompt: "p" },
      triggerUnitType: "execute-task",
      triggerUnitId: "M001/S01/T02"
    });
    registry.cycleCounts.set("test/key", 3);
    registry.retryPending = true;
    registry.retryTrigger = { unitType: "execute-task", unitId: "M001/S01/T01", retryArtifact: "RETRY" };
    registry.resetState();
    assert.deepStrictEqual(registry.getActiveHook(), null, "activeHook cleared");
    assert.deepStrictEqual(registry.hookQueue.length, 0, "hookQueue cleared");
    assert.deepStrictEqual(registry.cycleCounts.size, 0, "cycleCounts cleared");
    assert.deepStrictEqual(registry.isRetryPending(), false, "retryPending cleared");
    assert.deepStrictEqual(registry.consumeRetryTrigger(), null, "retryTrigger cleared");
  });
  test("singleton getRegistry throws when not initialized", () => {
    let threw = false;
    try {
      getRegistry();
    } catch (e) {
      threw = true;
      assert.ok(e.message.includes("not initialized"), "error mentions not initialized");
    }
    assert.ok(threw, "getRegistry threw");
  });
  test("setRegistry / getRegistry round-trips", () => {
    const registry = new RuleRegistry([mockDispatchRule("singleton-test", "planning")]);
    setRegistry(registry);
    const retrieved = getRegistry();
    assert.deepStrictEqual(retrieved, registry, "getRegistry returns the same instance");
    const listed = retrieved.listRules().filter((r) => r.when === "dispatch");
    assert.deepStrictEqual(listed.length, 1, "singleton has 1 dispatch rule");
    assert.deepStrictEqual(listed[0].name, "singleton-test", "rule name matches");
  });
  test("initRegistry creates and sets singleton", () => {
    const rules = [mockDispatchRule("init-test", "executing")];
    const registry = initRegistry(rules);
    assert.deepStrictEqual(getRegistry(), registry, "initRegistry sets the singleton");
    const listed = getRegistry().listRules().filter((r) => r.when === "dispatch");
    assert.deepStrictEqual(listed.length, 1, "singleton has the rule");
  });
  test("evaluateDispatch respects rule order (first match wins)", async () => {
    const ruleFirst = {
      name: "rule-first",
      when: "dispatch",
      evaluation: "first-match",
      where: async (ctx2) => {
        if (ctx2.state.phase === "planning") {
          return { action: "dispatch", unitType: "first-wins", unitId: "id", prompt: "first" };
        }
        return null;
      },
      then: () => {
      }
    };
    const ruleSecond = {
      name: "rule-second",
      when: "dispatch",
      evaluation: "first-match",
      where: async (ctx2) => {
        if (ctx2.state.phase === "planning") {
          return { action: "dispatch", unitType: "second-loses", unitId: "id", prompt: "second" };
        }
        return null;
      },
      then: () => {
      }
    };
    const registry = new RuleRegistry([ruleFirst, ruleSecond]);
    const ctx = makeContext("planning");
    const result = await registry.evaluateDispatch(ctx);
    assert.deepStrictEqual(result.action, "dispatch", "dispatch action returned");
    if (result.action === "dispatch") {
      assert.deepStrictEqual(result.unitType, "first-wins", "first rule won over second");
    }
  });
  test("convertDispatchRules produces correct count of UnifiedRule objects", () => {
    const converted = convertDispatchRules(DISPATCH_RULES);
    assert.deepStrictEqual(converted.length, DISPATCH_RULES.length, `convertDispatchRules produces ${DISPATCH_RULES.length} rules`);
  });
  test("each converted rule has correct when, evaluation, and original name", () => {
    const converted = convertDispatchRules(DISPATCH_RULES);
    for (let i = 0; i < converted.length; i++) {
      const rule = converted[i];
      assert.deepStrictEqual(rule.when, "dispatch", `rule ${i} has when:"dispatch"`);
      assert.deepStrictEqual(rule.evaluation, "first-match", `rule ${i} has evaluation:"first-match"`);
      assert.deepStrictEqual(rule.name, DISPATCH_RULES[i].name, `rule ${i} preserves name "${DISPATCH_RULES[i].name}"`);
      assert.ok(typeof rule.where === "function", `rule ${i} has a where function`);
      assert.ok(typeof rule.then === "function", `rule ${i} has a then function`);
    }
  });
  test("listRules after construction with real dispatch rules returns correct count", () => {
    const converted = convertDispatchRules(DISPATCH_RULES);
    const registry = new RuleRegistry(converted);
    const listed = registry.listRules().filter((r) => r.when === "dispatch");
    assert.deepStrictEqual(listed.length, DISPATCH_RULES.length, `listRules returns ${DISPATCH_RULES.length} dispatch rules`);
  });
  test("rule names from listRules match getDispatchRuleNames in exact order", () => {
    const converted = convertDispatchRules(DISPATCH_RULES);
    const registry = new RuleRegistry(converted);
    const listedNames = registry.listRules().filter((r) => r.when === "dispatch").map((r) => r.name);
    const originalNames = getDispatchRuleNames();
    assert.deepStrictEqual(listedNames.length, originalNames.length, "same number of names");
    for (let i = 0; i < originalNames.length; i++) {
      assert.deepStrictEqual(listedNames[i], originalNames[i], `name at index ${i} matches: "${originalNames[i]}"`);
    }
  });
  test("getOrCreateRegistry lazily creates a registry with empty dispatch rules", () => {
    const registry = getOrCreateRegistry();
    assert.ok(registry instanceof RuleRegistry, "returns a RuleRegistry instance");
    const dispatchRules = registry.listRules().filter((r) => r.when === "dispatch");
    assert.deepStrictEqual(dispatchRules.length, 0, "lazily-created registry has 0 dispatch rules");
  });
  test("getOrCreateRegistry returns existing registry when initialized", () => {
    const rules = [mockDispatchRule("explicit-init", "planning")];
    const explicit = initRegistry(rules);
    const lazy = getOrCreateRegistry();
    assert.deepStrictEqual(lazy, explicit, "getOrCreateRegistry returns the same singleton as initRegistry");
    const dispatchRules = lazy.listRules().filter((r) => r.when === "dispatch");
    assert.deepStrictEqual(dispatchRules.length, 1, "singleton has the explicitly initialized dispatch rule");
  });
  test("listRules returns only dispatch rules when no hooks are configured", () => {
    const converted = convertDispatchRules(DISPATCH_RULES);
    const registry = new RuleRegistry(converted);
    const allRules = registry.listRules();
    const postUnitRules = allRules.filter((r) => r.when === "post-unit");
    const preDispatchRules = allRules.filter((r) => r.when === "pre-dispatch");
    assert.deepStrictEqual(postUnitRules.length, 0, "no post-unit rules when no hooks configured");
    assert.deepStrictEqual(preDispatchRules.length, 0, "no pre-dispatch rules when no hooks configured");
    assert.deepStrictEqual(allRules.length, DISPATCH_RULES.length, "total rules equals dispatch rules only");
  });
  test("listRules dispatch rules appear first, hooks after", () => {
    const converted = convertDispatchRules(DISPATCH_RULES);
    const registry = new RuleRegistry(converted);
    const allRules = registry.listRules();
    for (let i = 0; i < converted.length; i++) {
      assert.deepStrictEqual(allRules[i].when, "dispatch", `rule at index ${i} is a dispatch rule`);
      assert.deepStrictEqual(allRules[i].name, converted[i].name, `dispatch rule at index ${i} has correct name`);
    }
  });
  test("evaluatePostUnit returns null for hook-on-hook prevention", () => {
    const registry = new RuleRegistry([]);
    const result = registry.evaluatePostUnit("hook/code-review", "M001/S01/T01", "/tmp/test");
    assert.deepStrictEqual(result, null, "hook units don't trigger other hooks");
  });
  test("evaluatePostUnit returns null for triage-captures", () => {
    const registry = new RuleRegistry([]);
    const result = registry.evaluatePostUnit("triage-captures", "M001/S01/T01", "/tmp/test");
    assert.deepStrictEqual(result, null, "triage-captures skipped");
  });
  test("evaluatePostUnit returns null for quick-task", () => {
    const registry = new RuleRegistry([]);
    const result = registry.evaluatePostUnit("quick-task", "M001/S01/T01", "/tmp/test");
    assert.deepStrictEqual(result, null, "quick-task skipped");
  });
  test("evaluatePreDispatch bypasses hook units", () => {
    const registry = new RuleRegistry([]);
    const result = registry.evaluatePreDispatch("hook/review", "M001/S01/T01", "prompt", "/tmp/test");
    assert.deepStrictEqual(result.action, "proceed", "hook units always proceed");
    assert.deepStrictEqual(result.prompt, "prompt", "prompt unchanged");
    assert.deepStrictEqual(result.firedHooks.length, 0, "no hooks fired");
  });
  test("evaluatePreDispatch proceeds with empty hooks", () => {
    const registry = new RuleRegistry([]);
    const result = registry.evaluatePreDispatch("execute-task", "M001/S01/T01", "original prompt", "/tmp/test");
    assert.deepStrictEqual(result.action, "proceed", "proceeds when no hooks");
    assert.deepStrictEqual(result.prompt, "original prompt", "prompt unchanged");
  });
  test("evaluateDispatch result includes matchedRule on dispatch match", async () => {
    const rules = [
      mockDispatchRule("my-planning-rule", "planning")
    ];
    const registry = new RuleRegistry(rules);
    const ctx = makeContext("planning");
    const result = await registry.evaluateDispatch(ctx);
    assert.deepStrictEqual(result.action, "dispatch", "result is a dispatch action");
    assert.deepStrictEqual(result.matchedRule, "my-planning-rule", "matchedRule is the rule name");
  });
  test("evaluateDispatch result includes matchedRule '<no-match>' on fallback stop", async () => {
    const rules = [
      mockDispatchRule("only-planning", "planning")
    ];
    const registry = new RuleRegistry(rules);
    const ctx = makeContext("some-unknown-phase");
    const result = await registry.evaluateDispatch(ctx);
    assert.deepStrictEqual(result.action, "stop", "result is a stop action");
    assert.deepStrictEqual(result.matchedRule, "<no-match>", "matchedRule is '<no-match>' on fallback");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9ydWxlLXJlZ2lzdHJ5LnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRCBFeHRlbnNpb24gXHUyMDE0IFJ1bGUgUmVnaXN0cnkgVGVzdHNcbi8vXG4vLyBUZXN0cyB0aGUgUnVsZVJlZ2lzdHJ5IGNsYXNzLCBVbmlmaWVkUnVsZSB0eXBlcywgc2luZ2xldG9uIGFjY2Vzc29ycyxcbi8vIGFuZCBldmFsdWF0aW9uIG1ldGhvZHMgdXNpbmcgbW9jayBydWxlcy5cblxuaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydC9zdHJpY3QnO1xuaW1wb3J0IHsgdGVzdCwgZGVzY3JpYmUsIGJlZm9yZUVhY2ggfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQge1xuICBSdWxlUmVnaXN0cnksXG4gIGdldFJlZ2lzdHJ5LFxuICBzZXRSZWdpc3RyeSxcbiAgaW5pdFJlZ2lzdHJ5LFxuICByZXNldFJlZ2lzdHJ5LFxuICBjb252ZXJ0RGlzcGF0Y2hSdWxlcyxcbiAgZ2V0T3JDcmVhdGVSZWdpc3RyeSxcbn0gZnJvbSBcIi4uL3J1bGUtcmVnaXN0cnkudHNcIjtcbmltcG9ydCB0eXBlIHsgVW5pZmllZFJ1bGUgfSBmcm9tIFwiLi4vcnVsZS10eXBlcy50c1wiO1xuaW1wb3J0IHR5cGUgeyBEaXNwYXRjaEFjdGlvbiwgRGlzcGF0Y2hDb250ZXh0IH0gZnJvbSBcIi4uL2F1dG8tZGlzcGF0Y2gudHNcIjtcbmltcG9ydCB7IERJU1BBVENIX1JVTEVTLCBnZXREaXNwYXRjaFJ1bGVOYW1lcyB9IGZyb20gXCIuLi9hdXRvLWRpc3BhdGNoLnRzXCI7XG5pbXBvcnQgdHlwZSB7IEdTRFN0YXRlIH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBNb2NrIFJ1bGUgRmFjdG9yaWVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBtb2NrRGlzcGF0Y2hSdWxlKG5hbWU6IHN0cmluZywgbWF0Y2hQaGFzZTogc3RyaW5nKTogVW5pZmllZFJ1bGUge1xuICByZXR1cm4ge1xuICAgIG5hbWUsXG4gICAgd2hlbjogXCJkaXNwYXRjaFwiLFxuICAgIGV2YWx1YXRpb246IFwiZmlyc3QtbWF0Y2hcIixcbiAgICB3aGVyZTogYXN5bmMgKGN0eDogRGlzcGF0Y2hDb250ZXh0KTogUHJvbWlzZTxEaXNwYXRjaEFjdGlvbiB8IG51bGw+ID0+IHtcbiAgICAgIGlmIChjdHguc3RhdGUucGhhc2UgPT09IG1hdGNoUGhhc2UpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBhY3Rpb246IFwiZGlzcGF0Y2hcIixcbiAgICAgICAgICB1bml0VHlwZTogYHRlc3QtJHttYXRjaFBoYXNlfWAsXG4gICAgICAgICAgdW5pdElkOiBcInRlc3QtaWRcIixcbiAgICAgICAgICBwcm9tcHQ6IGBQcm9tcHQgZm9yICR7bWF0Y2hQaGFzZX1gLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfSxcbiAgICB0aGVuOiAoKSA9PiB7fSxcbiAgICBkZXNjcmlwdGlvbjogYE1vY2sgcnVsZSBmb3IgJHttYXRjaFBoYXNlfWAsXG4gIH07XG59XG5cbmZ1bmN0aW9uIG1ha2VDb250ZXh0KHBoYXNlOiBzdHJpbmcpOiBEaXNwYXRjaENvbnRleHQge1xuICByZXR1cm4ge1xuICAgIGJhc2VQYXRoOiBcIi90bXAvdGVzdFwiLFxuICAgIG1pZDogXCJNMDAxXCIsXG4gICAgbWlkVGl0bGU6IFwiVGVzdCBNaWxlc3RvbmVcIixcbiAgICBzdGF0ZToge1xuICAgICAgcGhhc2U6IHBoYXNlIGFzIGFueSxcbiAgICAgIGFjdGl2ZU1pbGVzdG9uZTogeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiB9LFxuICAgICAgYWN0aXZlU2xpY2U6IG51bGwsXG4gICAgICBhY3RpdmVUYXNrOiBudWxsLFxuICAgICAgcmVjZW50RGVjaXNpb25zOiBbXSxcbiAgICAgIGJsb2NrZXJzOiBbXSxcbiAgICAgIG5leHRBY3Rpb246IFwiXCIsXG4gICAgICByZWdpc3RyeTogW10sXG4gICAgfSxcbiAgICBwcmVmczogdW5kZWZpbmVkLFxuICB9O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiUnVsZVJlZ2lzdHJ5XCIsICgpID0+IHtcbiAgICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICByZXNldFJlZ2lzdHJ5KCk7XG4gIH0pO1xuXG4gIHRlc3QoXCJjb25zdHJ1Y3Qgd2l0aCBkaXNwYXRjaCBydWxlcywgbGlzdFJ1bGVzIHJldHVybnMgdGhlbVwiLCAoKSA9PiB7XG4gICAgY29uc3QgcnVsZXM6IFVuaWZpZWRSdWxlW10gPSBbXG4gICAgICBtb2NrRGlzcGF0Y2hSdWxlKFwicnVsZS1hXCIsIFwicGxhbm5pbmdcIiksXG4gICAgICBtb2NrRGlzcGF0Y2hSdWxlKFwicnVsZS1iXCIsIFwiZXhlY3V0aW5nXCIpLFxuICAgICAgbW9ja0Rpc3BhdGNoUnVsZShcInJ1bGUtY1wiLCBcImNvbXBsZXRlXCIpLFxuICAgIF07XG4gICAgY29uc3QgcmVnaXN0cnkgPSBuZXcgUnVsZVJlZ2lzdHJ5KHJ1bGVzKTtcbiAgICBjb25zdCBsaXN0ZWQgPSByZWdpc3RyeS5saXN0UnVsZXMoKTtcblxuICAgIC8vIEF0IG1pbmltdW0sIGRpc3BhdGNoIHJ1bGVzIGFyZSByZXR1cm5lZCAoaG9vayBydWxlcyBkZXBlbmQgb24gcHJlZnMpXG4gICAgY29uc3QgZGlzcGF0Y2hSdWxlcyA9IGxpc3RlZC5maWx0ZXIociA9PiByLndoZW4gPT09IFwiZGlzcGF0Y2hcIik7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkaXNwYXRjaFJ1bGVzLmxlbmd0aCwgMywgXCJsaXN0UnVsZXMgcmV0dXJucyAzIGRpc3BhdGNoIHJ1bGVzXCIpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZGlzcGF0Y2hSdWxlc1swXS5uYW1lLCBcInJ1bGUtYVwiLCBcImZpcnN0IHJ1bGUgbmFtZSBpcyBydWxlLWFcIik7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkaXNwYXRjaFJ1bGVzWzFdLm5hbWUsIFwicnVsZS1iXCIsIFwic2Vjb25kIHJ1bGUgbmFtZSBpcyBydWxlLWJcIik7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkaXNwYXRjaFJ1bGVzWzJdLm5hbWUsIFwicnVsZS1jXCIsIFwidGhpcmQgcnVsZSBuYW1lIGlzIHJ1bGUtY1wiKTtcbiAgfSk7XG5cbiAgdGVzdChcImxpc3RSdWxlcyByZXR1cm5zIGNvcnJlY3QgZmllbGRzIG9uIGVhY2ggcnVsZVwiLCAoKSA9PiB7XG4gICAgY29uc3QgcnVsZXM6IFVuaWZpZWRSdWxlW10gPSBbXG4gICAgICBtb2NrRGlzcGF0Y2hSdWxlKFwiY2hlY2stZmllbGRzXCIsIFwicGxhbm5pbmdcIiksXG4gICAgXTtcbiAgICBjb25zdCByZWdpc3RyeSA9IG5ldyBSdWxlUmVnaXN0cnkocnVsZXMpO1xuICAgIGNvbnN0IGxpc3RlZCA9IHJlZ2lzdHJ5Lmxpc3RSdWxlcygpO1xuICAgIGNvbnN0IHJ1bGUgPSBsaXN0ZWQuZmluZChyID0+IHIubmFtZSA9PT0gXCJjaGVjay1maWVsZHNcIikhO1xuXG4gICAgYXNzZXJ0Lm9rKHJ1bGUgIT09IHVuZGVmaW5lZCwgXCJydWxlIGZvdW5kIGJ5IG5hbWVcIik7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChydWxlLndoZW4sIFwiZGlzcGF0Y2hcIiwgXCJ3aGVuIGZpZWxkIGlzIGRpc3BhdGNoXCIpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocnVsZS5ldmFsdWF0aW9uLCBcImZpcnN0LW1hdGNoXCIsIFwiZXZhbHVhdGlvbiBpcyBmaXJzdC1tYXRjaFwiKTtcbiAgICBhc3NlcnQub2sodHlwZW9mIHJ1bGUud2hlcmUgPT09IFwiZnVuY3Rpb25cIiwgXCJ3aGVyZSBpcyBhIGZ1bmN0aW9uXCIpO1xuICAgIGFzc2VydC5vayh0eXBlb2YgcnVsZS50aGVuID09PSBcImZ1bmN0aW9uXCIsIFwidGhlbiBpcyBhIGZ1bmN0aW9uXCIpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocnVsZS5kZXNjcmlwdGlvbiwgXCJNb2NrIHJ1bGUgZm9yIHBsYW5uaW5nXCIsIFwiZGVzY3JpcHRpb24gaXMgc2V0XCIpO1xuICB9KTtcblxuICB0ZXN0KFwiZXZhbHVhdGVEaXNwYXRjaCByZXR1cm5zIGZpcnN0IG1hdGNoaW5nIHJ1bGVcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHJ1bGVzOiBVbmlmaWVkUnVsZVtdID0gW1xuICAgICAgbW9ja0Rpc3BhdGNoUnVsZShcInJ1bGUtcGxhbm5pbmdcIiwgXCJwbGFubmluZ1wiKSxcbiAgICAgIG1vY2tEaXNwYXRjaFJ1bGUoXCJydWxlLWV4ZWN1dGluZ1wiLCBcImV4ZWN1dGluZ1wiKSxcbiAgICAgIG1vY2tEaXNwYXRjaFJ1bGUoXCJydWxlLWNvbXBsZXRlXCIsIFwiY29tcGxldGVcIiksXG4gICAgXTtcbiAgICBjb25zdCByZWdpc3RyeSA9IG5ldyBSdWxlUmVnaXN0cnkocnVsZXMpO1xuICAgIGNvbnN0IGN0eCA9IG1ha2VDb250ZXh0KFwiZXhlY3V0aW5nXCIpO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlZ2lzdHJ5LmV2YWx1YXRlRGlzcGF0Y2goY3R4KTtcblxuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0LmFjdGlvbiwgXCJkaXNwYXRjaFwiLCBcInJlc3VsdCBpcyBhIGRpc3BhdGNoIGFjdGlvblwiKTtcbiAgICBpZiAocmVzdWx0LmFjdGlvbiA9PT0gXCJkaXNwYXRjaFwiKSB7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC51bml0VHlwZSwgXCJ0ZXN0LWV4ZWN1dGluZ1wiLCBcIm1hdGNoZWQgdGhlIGV4ZWN1dGluZyBydWxlXCIpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQucHJvbXB0LCBcIlByb21wdCBmb3IgZXhlY3V0aW5nXCIsIFwicHJvbXB0IGZyb20gbWF0Y2hlZCBydWxlXCIpO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcImV2YWx1YXRlRGlzcGF0Y2ggcmV0dXJucyBzdG9wIHdoZW4gbm8gcnVsZSBtYXRjaGVzXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBydWxlczogVW5pZmllZFJ1bGVbXSA9IFtcbiAgICAgIG1vY2tEaXNwYXRjaFJ1bGUoXCJvbmx5LXBsYW5uaW5nXCIsIFwicGxhbm5pbmdcIiksXG4gICAgXTtcbiAgICBjb25zdCByZWdpc3RyeSA9IG5ldyBSdWxlUmVnaXN0cnkocnVsZXMpO1xuICAgIGNvbnN0IGN0eCA9IG1ha2VDb250ZXh0KFwiYmxvY2tlZFwiKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCByZWdpc3RyeS5ldmFsdWF0ZURpc3BhdGNoKGN0eCk7XG5cbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC5hY3Rpb24sIFwic3RvcFwiLCBcInJlc3VsdCBpcyBhIHN0b3AgYWN0aW9uXCIpO1xuICAgIGlmIChyZXN1bHQuYWN0aW9uID09PSBcInN0b3BcIikge1xuICAgICAgYXNzZXJ0Lm9rKHJlc3VsdC5yZWFzb24uaW5jbHVkZXMoXCJibG9ja2VkXCIpLCBcInN0b3AgcmVhc29uIG1lbnRpb25zIHBoYXNlXCIpO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcImV2YWx1YXRlRGlzcGF0Y2ggd29ya3Mgd2l0aCBhc3luYyB3aGVyZSBwcmVkaWNhdGVcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGFzeW5jUnVsZTogVW5pZmllZFJ1bGUgPSB7XG4gICAgICBuYW1lOiBcImFzeW5jLXJ1bGVcIixcbiAgICAgIHdoZW46IFwiZGlzcGF0Y2hcIixcbiAgICAgIGV2YWx1YXRpb246IFwiZmlyc3QtbWF0Y2hcIixcbiAgICAgIHdoZXJlOiBhc3luYyAoY3R4OiBEaXNwYXRjaENvbnRleHQpOiBQcm9taXNlPERpc3BhdGNoQWN0aW9uIHwgbnVsbD4gPT4ge1xuICAgICAgICAvLyBTaW11bGF0ZSBhc3luYyB3b3JrXG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKHJlc29sdmUgPT4gc2V0VGltZW91dChyZXNvbHZlLCAxKSk7XG4gICAgICAgIGlmIChjdHguc3RhdGUucGhhc2UgPT09IFwicGxhbm5pbmdcIikge1xuICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBhY3Rpb246IFwiZGlzcGF0Y2hcIixcbiAgICAgICAgICAgIHVuaXRUeXBlOiBcImFzeW5jLXRlc3RcIixcbiAgICAgICAgICAgIHVuaXRJZDogXCJhc3luYy1pZFwiLFxuICAgICAgICAgICAgcHJvbXB0OiBcIkFzeW5jIHByb21wdFwiLFxuICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICB9LFxuICAgICAgdGhlbjogKCkgPT4ge30sXG4gICAgfTtcblxuICAgIGNvbnN0IHJlZ2lzdHJ5ID0gbmV3IFJ1bGVSZWdpc3RyeShbYXN5bmNSdWxlXSk7XG4gICAgY29uc3QgY3R4ID0gbWFrZUNvbnRleHQoXCJwbGFubmluZ1wiKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCByZWdpc3RyeS5ldmFsdWF0ZURpc3BhdGNoKGN0eCk7XG5cbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC5hY3Rpb24sIFwiZGlzcGF0Y2hcIiwgXCJhc3luYyBkaXNwYXRjaCByZXNvbHZlZFwiKTtcbiAgICBpZiAocmVzdWx0LmFjdGlvbiA9PT0gXCJkaXNwYXRjaFwiKSB7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC51bml0VHlwZSwgXCJhc3luYy10ZXN0XCIsIFwiYXN5bmMgcnVsZSBtYXRjaGVkXCIpO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcInJlc2V0U3RhdGUgY2xlYXJzIGFsbCBtdXRhYmxlIHN0YXRlXCIsICgpID0+IHtcbiAgICBjb25zdCByZWdpc3RyeSA9IG5ldyBSdWxlUmVnaXN0cnkoW10pO1xuXG4gICAgLy8gU2V0IHVwIHNvbWUgc3RhdGVcbiAgICByZWdpc3RyeS5hY3RpdmVIb29rID0ge1xuICAgICAgaG9va05hbWU6IFwidGVzdC1ob29rXCIsXG4gICAgICB0cmlnZ2VyVW5pdFR5cGU6IFwiZXhlY3V0ZS10YXNrXCIsXG4gICAgICB0cmlnZ2VyVW5pdElkOiBcIk0wMDEvUzAxL1QwMVwiLFxuICAgICAgY3ljbGU6IDIsXG4gICAgICBwZW5kaW5nUmV0cnk6IGZhbHNlLFxuICAgIH07XG4gICAgcmVnaXN0cnkuaG9va1F1ZXVlLnB1c2goe1xuICAgICAgY29uZmlnOiB7IG5hbWU6IFwicVwiLCBhZnRlcjogW10sIHByb21wdDogXCJwXCIgfSxcbiAgICAgIHRyaWdnZXJVbml0VHlwZTogXCJleGVjdXRlLXRhc2tcIixcbiAgICAgIHRyaWdnZXJVbml0SWQ6IFwiTTAwMS9TMDEvVDAyXCIsXG4gICAgfSk7XG4gICAgcmVnaXN0cnkuY3ljbGVDb3VudHMuc2V0KFwidGVzdC9rZXlcIiwgMyk7XG4gICAgcmVnaXN0cnkucmV0cnlQZW5kaW5nID0gdHJ1ZTtcbiAgICByZWdpc3RyeS5yZXRyeVRyaWdnZXIgPSB7IHVuaXRUeXBlOiBcImV4ZWN1dGUtdGFza1wiLCB1bml0SWQ6IFwiTTAwMS9TMDEvVDAxXCIsIHJldHJ5QXJ0aWZhY3Q6IFwiUkVUUllcIiB9O1xuXG4gICAgLy8gUmVzZXRcbiAgICByZWdpc3RyeS5yZXNldFN0YXRlKCk7XG5cbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlZ2lzdHJ5LmdldEFjdGl2ZUhvb2soKSwgbnVsbCwgXCJhY3RpdmVIb29rIGNsZWFyZWRcIik7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZWdpc3RyeS5ob29rUXVldWUubGVuZ3RoLCAwLCBcImhvb2tRdWV1ZSBjbGVhcmVkXCIpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVnaXN0cnkuY3ljbGVDb3VudHMuc2l6ZSwgMCwgXCJjeWNsZUNvdW50cyBjbGVhcmVkXCIpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVnaXN0cnkuaXNSZXRyeVBlbmRpbmcoKSwgZmFsc2UsIFwicmV0cnlQZW5kaW5nIGNsZWFyZWRcIik7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZWdpc3RyeS5jb25zdW1lUmV0cnlUcmlnZ2VyKCksIG51bGwsIFwicmV0cnlUcmlnZ2VyIGNsZWFyZWRcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJzaW5nbGV0b24gZ2V0UmVnaXN0cnkgdGhyb3dzIHdoZW4gbm90IGluaXRpYWxpemVkXCIsICgpID0+IHtcbiAgICBsZXQgdGhyZXcgPSBmYWxzZTtcbiAgICB0cnkge1xuICAgICAgZ2V0UmVnaXN0cnkoKTtcbiAgICB9IGNhdGNoIChlOiBhbnkpIHtcbiAgICAgIHRocmV3ID0gdHJ1ZTtcbiAgICAgIGFzc2VydC5vayhlLm1lc3NhZ2UuaW5jbHVkZXMoXCJub3QgaW5pdGlhbGl6ZWRcIiksIFwiZXJyb3IgbWVudGlvbnMgbm90IGluaXRpYWxpemVkXCIpO1xuICAgIH1cbiAgICBhc3NlcnQub2sodGhyZXcsIFwiZ2V0UmVnaXN0cnkgdGhyZXdcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJzZXRSZWdpc3RyeSAvIGdldFJlZ2lzdHJ5IHJvdW5kLXRyaXBzXCIsICgpID0+IHtcbiAgICBjb25zdCByZWdpc3RyeSA9IG5ldyBSdWxlUmVnaXN0cnkoW21vY2tEaXNwYXRjaFJ1bGUoXCJzaW5nbGV0b24tdGVzdFwiLCBcInBsYW5uaW5nXCIpXSk7XG4gICAgc2V0UmVnaXN0cnkocmVnaXN0cnkpO1xuXG4gICAgY29uc3QgcmV0cmlldmVkID0gZ2V0UmVnaXN0cnkoKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJldHJpZXZlZCwgcmVnaXN0cnksIFwiZ2V0UmVnaXN0cnkgcmV0dXJucyB0aGUgc2FtZSBpbnN0YW5jZVwiKTtcblxuICAgIGNvbnN0IGxpc3RlZCA9IHJldHJpZXZlZC5saXN0UnVsZXMoKS5maWx0ZXIociA9PiByLndoZW4gPT09IFwiZGlzcGF0Y2hcIik7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChsaXN0ZWQubGVuZ3RoLCAxLCBcInNpbmdsZXRvbiBoYXMgMSBkaXNwYXRjaCBydWxlXCIpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwobGlzdGVkWzBdLm5hbWUsIFwic2luZ2xldG9uLXRlc3RcIiwgXCJydWxlIG5hbWUgbWF0Y2hlc1wiKTtcbiAgfSk7XG5cbiAgdGVzdChcImluaXRSZWdpc3RyeSBjcmVhdGVzIGFuZCBzZXRzIHNpbmdsZXRvblwiLCAoKSA9PiB7XG4gICAgY29uc3QgcnVsZXMgPSBbbW9ja0Rpc3BhdGNoUnVsZShcImluaXQtdGVzdFwiLCBcImV4ZWN1dGluZ1wiKV07XG4gICAgY29uc3QgcmVnaXN0cnkgPSBpbml0UmVnaXN0cnkocnVsZXMpO1xuXG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChnZXRSZWdpc3RyeSgpLCByZWdpc3RyeSwgXCJpbml0UmVnaXN0cnkgc2V0cyB0aGUgc2luZ2xldG9uXCIpO1xuICAgIGNvbnN0IGxpc3RlZCA9IGdldFJlZ2lzdHJ5KCkubGlzdFJ1bGVzKCkuZmlsdGVyKHIgPT4gci53aGVuID09PSBcImRpc3BhdGNoXCIpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwobGlzdGVkLmxlbmd0aCwgMSwgXCJzaW5nbGV0b24gaGFzIHRoZSBydWxlXCIpO1xuICB9KTtcblxuICB0ZXN0KFwiZXZhbHVhdGVEaXNwYXRjaCByZXNwZWN0cyBydWxlIG9yZGVyIChmaXJzdCBtYXRjaCB3aW5zKVwiLCBhc3luYyAoKSA9PiB7XG4gICAgLy8gQm90aCBydWxlcyBtYXRjaCBcInBsYW5uaW5nXCIgYnV0IHJ1bGUtZmlyc3Qgc2hvdWxkIHdpblxuICAgIGNvbnN0IHJ1bGVGaXJzdDogVW5pZmllZFJ1bGUgPSB7XG4gICAgICBuYW1lOiBcInJ1bGUtZmlyc3RcIixcbiAgICAgIHdoZW46IFwiZGlzcGF0Y2hcIixcbiAgICAgIGV2YWx1YXRpb246IFwiZmlyc3QtbWF0Y2hcIixcbiAgICAgIHdoZXJlOiBhc3luYyAoY3R4OiBEaXNwYXRjaENvbnRleHQpID0+IHtcbiAgICAgICAgaWYgKGN0eC5zdGF0ZS5waGFzZSA9PT0gXCJwbGFubmluZ1wiKSB7XG4gICAgICAgICAgcmV0dXJuIHsgYWN0aW9uOiBcImRpc3BhdGNoXCIgYXMgY29uc3QsIHVuaXRUeXBlOiBcImZpcnN0LXdpbnNcIiwgdW5pdElkOiBcImlkXCIsIHByb21wdDogXCJmaXJzdFwiIH07XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICB9LFxuICAgICAgdGhlbjogKCkgPT4ge30sXG4gICAgfTtcbiAgICBjb25zdCBydWxlU2Vjb25kOiBVbmlmaWVkUnVsZSA9IHtcbiAgICAgIG5hbWU6IFwicnVsZS1zZWNvbmRcIixcbiAgICAgIHdoZW46IFwiZGlzcGF0Y2hcIixcbiAgICAgIGV2YWx1YXRpb246IFwiZmlyc3QtbWF0Y2hcIixcbiAgICAgIHdoZXJlOiBhc3luYyAoY3R4OiBEaXNwYXRjaENvbnRleHQpID0+IHtcbiAgICAgICAgaWYgKGN0eC5zdGF0ZS5waGFzZSA9PT0gXCJwbGFubmluZ1wiKSB7XG4gICAgICAgICAgcmV0dXJuIHsgYWN0aW9uOiBcImRpc3BhdGNoXCIgYXMgY29uc3QsIHVuaXRUeXBlOiBcInNlY29uZC1sb3Nlc1wiLCB1bml0SWQ6IFwiaWRcIiwgcHJvbXB0OiBcInNlY29uZFwiIH07XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICB9LFxuICAgICAgdGhlbjogKCkgPT4ge30sXG4gICAgfTtcblxuICAgIGNvbnN0IHJlZ2lzdHJ5ID0gbmV3IFJ1bGVSZWdpc3RyeShbcnVsZUZpcnN0LCBydWxlU2Vjb25kXSk7XG4gICAgY29uc3QgY3R4ID0gbWFrZUNvbnRleHQoXCJwbGFubmluZ1wiKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCByZWdpc3RyeS5ldmFsdWF0ZURpc3BhdGNoKGN0eCk7XG5cbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC5hY3Rpb24sIFwiZGlzcGF0Y2hcIiwgXCJkaXNwYXRjaCBhY3Rpb24gcmV0dXJuZWRcIik7XG4gICAgaWYgKHJlc3VsdC5hY3Rpb24gPT09IFwiZGlzcGF0Y2hcIikge1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQudW5pdFR5cGUsIFwiZmlyc3Qtd2luc1wiLCBcImZpcnN0IHJ1bGUgd29uIG92ZXIgc2Vjb25kXCIpO1xuICAgIH1cbiAgfSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwIERpc3BhdGNoIHJ1bGUgY29udmVyc2lvbiB0ZXN0cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuICB0ZXN0KFwiY29udmVydERpc3BhdGNoUnVsZXMgcHJvZHVjZXMgY29ycmVjdCBjb3VudCBvZiBVbmlmaWVkUnVsZSBvYmplY3RzXCIsICgpID0+IHtcbiAgICBjb25zdCBjb252ZXJ0ZWQgPSBjb252ZXJ0RGlzcGF0Y2hSdWxlcyhESVNQQVRDSF9SVUxFUyk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChjb252ZXJ0ZWQubGVuZ3RoLCBESVNQQVRDSF9SVUxFUy5sZW5ndGgsIGBjb252ZXJ0RGlzcGF0Y2hSdWxlcyBwcm9kdWNlcyAke0RJU1BBVENIX1JVTEVTLmxlbmd0aH0gcnVsZXNgKTtcbiAgfSk7XG5cbiAgdGVzdChcImVhY2ggY29udmVydGVkIHJ1bGUgaGFzIGNvcnJlY3Qgd2hlbiwgZXZhbHVhdGlvbiwgYW5kIG9yaWdpbmFsIG5hbWVcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGNvbnZlcnRlZCA9IGNvbnZlcnREaXNwYXRjaFJ1bGVzKERJU1BBVENIX1JVTEVTKTtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGNvbnZlcnRlZC5sZW5ndGg7IGkrKykge1xuICAgICAgY29uc3QgcnVsZSA9IGNvbnZlcnRlZFtpXTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocnVsZS53aGVuLCBcImRpc3BhdGNoXCIsIGBydWxlICR7aX0gaGFzIHdoZW46XCJkaXNwYXRjaFwiYCk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJ1bGUuZXZhbHVhdGlvbiwgXCJmaXJzdC1tYXRjaFwiLCBgcnVsZSAke2l9IGhhcyBldmFsdWF0aW9uOlwiZmlyc3QtbWF0Y2hcImApO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChydWxlLm5hbWUsIERJU1BBVENIX1JVTEVTW2ldLm5hbWUsIGBydWxlICR7aX0gcHJlc2VydmVzIG5hbWUgXCIke0RJU1BBVENIX1JVTEVTW2ldLm5hbWV9XCJgKTtcbiAgICAgIGFzc2VydC5vayh0eXBlb2YgcnVsZS53aGVyZSA9PT0gXCJmdW5jdGlvblwiLCBgcnVsZSAke2l9IGhhcyBhIHdoZXJlIGZ1bmN0aW9uYCk7XG4gICAgICBhc3NlcnQub2sodHlwZW9mIHJ1bGUudGhlbiA9PT0gXCJmdW5jdGlvblwiLCBgcnVsZSAke2l9IGhhcyBhIHRoZW4gZnVuY3Rpb25gKTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJsaXN0UnVsZXMgYWZ0ZXIgY29uc3RydWN0aW9uIHdpdGggcmVhbCBkaXNwYXRjaCBydWxlcyByZXR1cm5zIGNvcnJlY3QgY291bnRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGNvbnZlcnRlZCA9IGNvbnZlcnREaXNwYXRjaFJ1bGVzKERJU1BBVENIX1JVTEVTKTtcbiAgICBjb25zdCByZWdpc3RyeSA9IG5ldyBSdWxlUmVnaXN0cnkoY29udmVydGVkKTtcbiAgICBjb25zdCBsaXN0ZWQgPSByZWdpc3RyeS5saXN0UnVsZXMoKS5maWx0ZXIociA9PiByLndoZW4gPT09IFwiZGlzcGF0Y2hcIik7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChsaXN0ZWQubGVuZ3RoLCBESVNQQVRDSF9SVUxFUy5sZW5ndGgsIGBsaXN0UnVsZXMgcmV0dXJucyAke0RJU1BBVENIX1JVTEVTLmxlbmd0aH0gZGlzcGF0Y2ggcnVsZXNgKTtcbiAgfSk7XG5cbiAgdGVzdChcInJ1bGUgbmFtZXMgZnJvbSBsaXN0UnVsZXMgbWF0Y2ggZ2V0RGlzcGF0Y2hSdWxlTmFtZXMgaW4gZXhhY3Qgb3JkZXJcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGNvbnZlcnRlZCA9IGNvbnZlcnREaXNwYXRjaFJ1bGVzKERJU1BBVENIX1JVTEVTKTtcbiAgICBjb25zdCByZWdpc3RyeSA9IG5ldyBSdWxlUmVnaXN0cnkoY29udmVydGVkKTtcbiAgICBjb25zdCBsaXN0ZWROYW1lcyA9IHJlZ2lzdHJ5Lmxpc3RSdWxlcygpXG4gICAgICAuZmlsdGVyKHIgPT4gci53aGVuID09PSBcImRpc3BhdGNoXCIpXG4gICAgICAubWFwKHIgPT4gci5uYW1lKTtcbiAgICBjb25zdCBvcmlnaW5hbE5hbWVzID0gZ2V0RGlzcGF0Y2hSdWxlTmFtZXMoKTtcblxuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwobGlzdGVkTmFtZXMubGVuZ3RoLCBvcmlnaW5hbE5hbWVzLmxlbmd0aCwgXCJzYW1lIG51bWJlciBvZiBuYW1lc1wiKTtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IG9yaWdpbmFsTmFtZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwobGlzdGVkTmFtZXNbaV0sIG9yaWdpbmFsTmFtZXNbaV0sIGBuYW1lIGF0IGluZGV4ICR7aX0gbWF0Y2hlczogXCIke29yaWdpbmFsTmFtZXNbaV19XCJgKTtcbiAgICB9XG4gIH0pO1xuXG4gIC8vIFx1MjUwMFx1MjUwMCBnZXRPckNyZWF0ZVJlZ2lzdHJ5IChsYXp5IGluaXQgZm9yIGZhY2FkZXMpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4gIHRlc3QoXCJnZXRPckNyZWF0ZVJlZ2lzdHJ5IGxhemlseSBjcmVhdGVzIGEgcmVnaXN0cnkgd2l0aCBlbXB0eSBkaXNwYXRjaCBydWxlc1wiLCAoKSA9PiB7XG4gICAgLy8gQWZ0ZXIgcmVzZXRSZWdpc3RyeSgpLCBnZXRSZWdpc3RyeSgpIHdvdWxkIHRocm93LiBnZXRPckNyZWF0ZVJlZ2lzdHJ5KCkgc2hvdWxkIG5vdC5cbiAgICBjb25zdCByZWdpc3RyeSA9IGdldE9yQ3JlYXRlUmVnaXN0cnkoKTtcbiAgICBhc3NlcnQub2socmVnaXN0cnkgaW5zdGFuY2VvZiBSdWxlUmVnaXN0cnksIFwicmV0dXJucyBhIFJ1bGVSZWdpc3RyeSBpbnN0YW5jZVwiKTtcbiAgICBjb25zdCBkaXNwYXRjaFJ1bGVzID0gcmVnaXN0cnkubGlzdFJ1bGVzKCkuZmlsdGVyKHIgPT4gci53aGVuID09PSBcImRpc3BhdGNoXCIpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZGlzcGF0Y2hSdWxlcy5sZW5ndGgsIDAsIFwibGF6aWx5LWNyZWF0ZWQgcmVnaXN0cnkgaGFzIDAgZGlzcGF0Y2ggcnVsZXNcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJnZXRPckNyZWF0ZVJlZ2lzdHJ5IHJldHVybnMgZXhpc3RpbmcgcmVnaXN0cnkgd2hlbiBpbml0aWFsaXplZFwiLCAoKSA9PiB7XG4gICAgY29uc3QgcnVsZXMgPSBbbW9ja0Rpc3BhdGNoUnVsZShcImV4cGxpY2l0LWluaXRcIiwgXCJwbGFubmluZ1wiKV07XG4gICAgY29uc3QgZXhwbGljaXQgPSBpbml0UmVnaXN0cnkocnVsZXMpO1xuICAgIGNvbnN0IGxhenkgPSBnZXRPckNyZWF0ZVJlZ2lzdHJ5KCk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChsYXp5LCBleHBsaWNpdCwgXCJnZXRPckNyZWF0ZVJlZ2lzdHJ5IHJldHVybnMgdGhlIHNhbWUgc2luZ2xldG9uIGFzIGluaXRSZWdpc3RyeVwiKTtcbiAgICBjb25zdCBkaXNwYXRjaFJ1bGVzID0gbGF6eS5saXN0UnVsZXMoKS5maWx0ZXIociA9PiByLndoZW4gPT09IFwiZGlzcGF0Y2hcIik7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkaXNwYXRjaFJ1bGVzLmxlbmd0aCwgMSwgXCJzaW5nbGV0b24gaGFzIHRoZSBleHBsaWNpdGx5IGluaXRpYWxpemVkIGRpc3BhdGNoIHJ1bGVcIik7XG4gIH0pO1xuXG4gIC8vIFx1MjUwMFx1MjUwMCBIb29rLWRlcml2ZWQgcnVsZXMgaW4gbGlzdFJ1bGVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4gIHRlc3QoXCJsaXN0UnVsZXMgcmV0dXJucyBvbmx5IGRpc3BhdGNoIHJ1bGVzIHdoZW4gbm8gaG9va3MgYXJlIGNvbmZpZ3VyZWRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGNvbnZlcnRlZCA9IGNvbnZlcnREaXNwYXRjaFJ1bGVzKERJU1BBVENIX1JVTEVTKTtcbiAgICBjb25zdCByZWdpc3RyeSA9IG5ldyBSdWxlUmVnaXN0cnkoY29udmVydGVkKTtcbiAgICBjb25zdCBhbGxSdWxlcyA9IHJlZ2lzdHJ5Lmxpc3RSdWxlcygpO1xuICAgIGNvbnN0IHBvc3RVbml0UnVsZXMgPSBhbGxSdWxlcy5maWx0ZXIociA9PiByLndoZW4gPT09IFwicG9zdC11bml0XCIpO1xuICAgIGNvbnN0IHByZURpc3BhdGNoUnVsZXMgPSBhbGxSdWxlcy5maWx0ZXIociA9PiByLndoZW4gPT09IFwicHJlLWRpc3BhdGNoXCIpO1xuXG4gICAgLy8gTm8gcHJlZmVyZW5jZXMgZmlsZSA9IG5vIGhvb2tzXG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChwb3N0VW5pdFJ1bGVzLmxlbmd0aCwgMCwgXCJubyBwb3N0LXVuaXQgcnVsZXMgd2hlbiBubyBob29rcyBjb25maWd1cmVkXCIpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocHJlRGlzcGF0Y2hSdWxlcy5sZW5ndGgsIDAsIFwibm8gcHJlLWRpc3BhdGNoIHJ1bGVzIHdoZW4gbm8gaG9va3MgY29uZmlndXJlZFwiKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGFsbFJ1bGVzLmxlbmd0aCwgRElTUEFUQ0hfUlVMRVMubGVuZ3RoLCBcInRvdGFsIHJ1bGVzIGVxdWFscyBkaXNwYXRjaCBydWxlcyBvbmx5XCIpO1xuICB9KTtcblxuICB0ZXN0KFwibGlzdFJ1bGVzIGRpc3BhdGNoIHJ1bGVzIGFwcGVhciBmaXJzdCwgaG9va3MgYWZ0ZXJcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGNvbnZlcnRlZCA9IGNvbnZlcnREaXNwYXRjaFJ1bGVzKERJU1BBVENIX1JVTEVTKTtcbiAgICBjb25zdCByZWdpc3RyeSA9IG5ldyBSdWxlUmVnaXN0cnkoY29udmVydGVkKTtcbiAgICBjb25zdCBhbGxSdWxlcyA9IHJlZ2lzdHJ5Lmxpc3RSdWxlcygpO1xuXG4gICAgLy8gVmVyaWZ5IGRpc3BhdGNoIHJ1bGVzIGNvbWUgZmlyc3QgKGluZGljZXMgMC4uTi0xKVxuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgY29udmVydGVkLmxlbmd0aDsgaSsrKSB7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGFsbFJ1bGVzW2ldLndoZW4sIFwiZGlzcGF0Y2hcIiwgYHJ1bGUgYXQgaW5kZXggJHtpfSBpcyBhIGRpc3BhdGNoIHJ1bGVgKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoYWxsUnVsZXNbaV0ubmFtZSwgY29udmVydGVkW2ldLm5hbWUsIGBkaXNwYXRjaCBydWxlIGF0IGluZGV4ICR7aX0gaGFzIGNvcnJlY3QgbmFtZWApO1xuICAgIH1cbiAgfSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwIEZhY2FkZSBkZWxlZ2F0aW9uIChwb3N0LXVuaXQtaG9va3MudHMgaW1wb3J0cyB3b3JrIHRocm91Z2ggcmVnaXN0cnkpIFx1MjUwMFx1MjUwMFxuXG4gIHRlc3QoXCJldmFsdWF0ZVBvc3RVbml0IHJldHVybnMgbnVsbCBmb3IgaG9vay1vbi1ob29rIHByZXZlbnRpb25cIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlZ2lzdHJ5ID0gbmV3IFJ1bGVSZWdpc3RyeShbXSk7XG4gICAgY29uc3QgcmVzdWx0ID0gcmVnaXN0cnkuZXZhbHVhdGVQb3N0VW5pdChcImhvb2svY29kZS1yZXZpZXdcIiwgXCJNMDAxL1MwMS9UMDFcIiwgXCIvdG1wL3Rlc3RcIik7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQsIG51bGwsIFwiaG9vayB1bml0cyBkb24ndCB0cmlnZ2VyIG90aGVyIGhvb2tzXCIpO1xuICB9KTtcblxuICB0ZXN0KFwiZXZhbHVhdGVQb3N0VW5pdCByZXR1cm5zIG51bGwgZm9yIHRyaWFnZS1jYXB0dXJlc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVnaXN0cnkgPSBuZXcgUnVsZVJlZ2lzdHJ5KFtdKTtcbiAgICBjb25zdCByZXN1bHQgPSByZWdpc3RyeS5ldmFsdWF0ZVBvc3RVbml0KFwidHJpYWdlLWNhcHR1cmVzXCIsIFwiTTAwMS9TMDEvVDAxXCIsIFwiL3RtcC90ZXN0XCIpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0LCBudWxsLCBcInRyaWFnZS1jYXB0dXJlcyBza2lwcGVkXCIpO1xuICB9KTtcblxuICB0ZXN0KFwiZXZhbHVhdGVQb3N0VW5pdCByZXR1cm5zIG51bGwgZm9yIHF1aWNrLXRhc2tcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlZ2lzdHJ5ID0gbmV3IFJ1bGVSZWdpc3RyeShbXSk7XG4gICAgY29uc3QgcmVzdWx0ID0gcmVnaXN0cnkuZXZhbHVhdGVQb3N0VW5pdChcInF1aWNrLXRhc2tcIiwgXCJNMDAxL1MwMS9UMDFcIiwgXCIvdG1wL3Rlc3RcIik7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQsIG51bGwsIFwicXVpY2stdGFzayBza2lwcGVkXCIpO1xuICB9KTtcblxuICB0ZXN0KFwiZXZhbHVhdGVQcmVEaXNwYXRjaCBieXBhc3NlcyBob29rIHVuaXRzXCIsICgpID0+IHtcbiAgICBjb25zdCByZWdpc3RyeSA9IG5ldyBSdWxlUmVnaXN0cnkoW10pO1xuICAgIGNvbnN0IHJlc3VsdCA9IHJlZ2lzdHJ5LmV2YWx1YXRlUHJlRGlzcGF0Y2goXCJob29rL3Jldmlld1wiLCBcIk0wMDEvUzAxL1QwMVwiLCBcInByb21wdFwiLCBcIi90bXAvdGVzdFwiKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC5hY3Rpb24sIFwicHJvY2VlZFwiLCBcImhvb2sgdW5pdHMgYWx3YXlzIHByb2NlZWRcIik7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQucHJvbXB0LCBcInByb21wdFwiLCBcInByb21wdCB1bmNoYW5nZWRcIik7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQuZmlyZWRIb29rcy5sZW5ndGgsIDAsIFwibm8gaG9va3MgZmlyZWRcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJldmFsdWF0ZVByZURpc3BhdGNoIHByb2NlZWRzIHdpdGggZW1wdHkgaG9va3NcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlZ2lzdHJ5ID0gbmV3IFJ1bGVSZWdpc3RyeShbXSk7XG4gICAgY29uc3QgcmVzdWx0ID0gcmVnaXN0cnkuZXZhbHVhdGVQcmVEaXNwYXRjaChcImV4ZWN1dGUtdGFza1wiLCBcIk0wMDEvUzAxL1QwMVwiLCBcIm9yaWdpbmFsIHByb21wdFwiLCBcIi90bXAvdGVzdFwiKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC5hY3Rpb24sIFwicHJvY2VlZFwiLCBcInByb2NlZWRzIHdoZW4gbm8gaG9va3NcIik7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQucHJvbXB0LCBcIm9yaWdpbmFsIHByb21wdFwiLCBcInByb21wdCB1bmNoYW5nZWRcIik7XG4gIH0pO1xuXG4gIC8vIFx1MjUwMFx1MjUwMCBtYXRjaGVkUnVsZSBwcm92ZW5hbmNlIChTMDIgam91cm5hbCBzdXBwb3J0KSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuICB0ZXN0KFwiZXZhbHVhdGVEaXNwYXRjaCByZXN1bHQgaW5jbHVkZXMgbWF0Y2hlZFJ1bGUgb24gZGlzcGF0Y2ggbWF0Y2hcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHJ1bGVzOiBVbmlmaWVkUnVsZVtdID0gW1xuICAgICAgbW9ja0Rpc3BhdGNoUnVsZShcIm15LXBsYW5uaW5nLXJ1bGVcIiwgXCJwbGFubmluZ1wiKSxcbiAgICBdO1xuICAgIGNvbnN0IHJlZ2lzdHJ5ID0gbmV3IFJ1bGVSZWdpc3RyeShydWxlcyk7XG4gICAgY29uc3QgY3R4ID0gbWFrZUNvbnRleHQoXCJwbGFubmluZ1wiKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCByZWdpc3RyeS5ldmFsdWF0ZURpc3BhdGNoKGN0eCk7XG5cbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC5hY3Rpb24sIFwiZGlzcGF0Y2hcIiwgXCJyZXN1bHQgaXMgYSBkaXNwYXRjaCBhY3Rpb25cIik7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQubWF0Y2hlZFJ1bGUsIFwibXktcGxhbm5pbmctcnVsZVwiLCBcIm1hdGNoZWRSdWxlIGlzIHRoZSBydWxlIG5hbWVcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJldmFsdWF0ZURpc3BhdGNoIHJlc3VsdCBpbmNsdWRlcyBtYXRjaGVkUnVsZSAnPG5vLW1hdGNoPicgb24gZmFsbGJhY2sgc3RvcFwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgcnVsZXM6IFVuaWZpZWRSdWxlW10gPSBbXG4gICAgICBtb2NrRGlzcGF0Y2hSdWxlKFwib25seS1wbGFubmluZ1wiLCBcInBsYW5uaW5nXCIpLFxuICAgIF07XG4gICAgY29uc3QgcmVnaXN0cnkgPSBuZXcgUnVsZVJlZ2lzdHJ5KHJ1bGVzKTtcbiAgICBjb25zdCBjdHggPSBtYWtlQ29udGV4dChcInNvbWUtdW5rbm93bi1waGFzZVwiKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCByZWdpc3RyeS5ldmFsdWF0ZURpc3BhdGNoKGN0eCk7XG5cbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC5hY3Rpb24sIFwic3RvcFwiLCBcInJlc3VsdCBpcyBhIHN0b3AgYWN0aW9uXCIpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0Lm1hdGNoZWRSdWxlLCBcIjxuby1tYXRjaD5cIiwgXCJtYXRjaGVkUnVsZSBpcyAnPG5vLW1hdGNoPicgb24gZmFsbGJhY2tcIik7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFLQSxPQUFPLFlBQVk7QUFDbkIsU0FBUyxNQUFNLFVBQVUsa0JBQWtCO0FBQzNDO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFHUCxTQUFTLGdCQUFnQiw0QkFBNEI7QUFLckQsU0FBUyxpQkFBaUIsTUFBYyxZQUFpQztBQUN2RSxTQUFPO0FBQUEsSUFDTDtBQUFBLElBQ0EsTUFBTTtBQUFBLElBQ04sWUFBWTtBQUFBLElBQ1osT0FBTyxPQUFPLFFBQXlEO0FBQ3JFLFVBQUksSUFBSSxNQUFNLFVBQVUsWUFBWTtBQUNsQyxlQUFPO0FBQUEsVUFDTCxRQUFRO0FBQUEsVUFDUixVQUFVLFFBQVEsVUFBVTtBQUFBLFVBQzVCLFFBQVE7QUFBQSxVQUNSLFFBQVEsY0FBYyxVQUFVO0FBQUEsUUFDbEM7QUFBQSxNQUNGO0FBQ0EsYUFBTztBQUFBLElBQ1Q7QUFBQSxJQUNBLE1BQU0sTUFBTTtBQUFBLElBQUM7QUFBQSxJQUNiLGFBQWEsaUJBQWlCLFVBQVU7QUFBQSxFQUMxQztBQUNGO0FBRUEsU0FBUyxZQUFZLE9BQWdDO0FBQ25ELFNBQU87QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLE9BQU87QUFBQSxNQUNMO0FBQUEsTUFDQSxpQkFBaUIsRUFBRSxJQUFJLFFBQVEsT0FBTyxPQUFPO0FBQUEsTUFDN0MsYUFBYTtBQUFBLE1BQ2IsWUFBWTtBQUFBLE1BQ1osaUJBQWlCLENBQUM7QUFBQSxNQUNsQixVQUFVLENBQUM7QUFBQSxNQUNYLFlBQVk7QUFBQSxNQUNaLFVBQVUsQ0FBQztBQUFBLElBQ2I7QUFBQSxJQUNBLE9BQU87QUFBQSxFQUNUO0FBQ0Y7QUFJQSxTQUFTLGdCQUFnQixNQUFNO0FBQzNCLGFBQVcsTUFBTTtBQUNqQixrQkFBYztBQUFBLEVBQ2hCLENBQUM7QUFFRCxPQUFLLHlEQUF5RCxNQUFNO0FBQ2xFLFVBQU0sUUFBdUI7QUFBQSxNQUMzQixpQkFBaUIsVUFBVSxVQUFVO0FBQUEsTUFDckMsaUJBQWlCLFVBQVUsV0FBVztBQUFBLE1BQ3RDLGlCQUFpQixVQUFVLFVBQVU7QUFBQSxJQUN2QztBQUNBLFVBQU0sV0FBVyxJQUFJLGFBQWEsS0FBSztBQUN2QyxVQUFNLFNBQVMsU0FBUyxVQUFVO0FBR2xDLFVBQU0sZ0JBQWdCLE9BQU8sT0FBTyxPQUFLLEVBQUUsU0FBUyxVQUFVO0FBQzlELFdBQU8sZ0JBQWdCLGNBQWMsUUFBUSxHQUFHLG9DQUFvQztBQUNwRixXQUFPLGdCQUFnQixjQUFjLENBQUMsRUFBRSxNQUFNLFVBQVUsMkJBQTJCO0FBQ25GLFdBQU8sZ0JBQWdCLGNBQWMsQ0FBQyxFQUFFLE1BQU0sVUFBVSw0QkFBNEI7QUFDcEYsV0FBTyxnQkFBZ0IsY0FBYyxDQUFDLEVBQUUsTUFBTSxVQUFVLDJCQUEyQjtBQUFBLEVBQ3JGLENBQUM7QUFFRCxPQUFLLGlEQUFpRCxNQUFNO0FBQzFELFVBQU0sUUFBdUI7QUFBQSxNQUMzQixpQkFBaUIsZ0JBQWdCLFVBQVU7QUFBQSxJQUM3QztBQUNBLFVBQU0sV0FBVyxJQUFJLGFBQWEsS0FBSztBQUN2QyxVQUFNLFNBQVMsU0FBUyxVQUFVO0FBQ2xDLFVBQU0sT0FBTyxPQUFPLEtBQUssT0FBSyxFQUFFLFNBQVMsY0FBYztBQUV2RCxXQUFPLEdBQUcsU0FBUyxRQUFXLG9CQUFvQjtBQUNsRCxXQUFPLGdCQUFnQixLQUFLLE1BQU0sWUFBWSx3QkFBd0I7QUFDdEUsV0FBTyxnQkFBZ0IsS0FBSyxZQUFZLGVBQWUsMkJBQTJCO0FBQ2xGLFdBQU8sR0FBRyxPQUFPLEtBQUssVUFBVSxZQUFZLHFCQUFxQjtBQUNqRSxXQUFPLEdBQUcsT0FBTyxLQUFLLFNBQVMsWUFBWSxvQkFBb0I7QUFDL0QsV0FBTyxnQkFBZ0IsS0FBSyxhQUFhLDBCQUEwQixvQkFBb0I7QUFBQSxFQUN6RixDQUFDO0FBRUQsT0FBSyxnREFBZ0QsWUFBWTtBQUMvRCxVQUFNLFFBQXVCO0FBQUEsTUFDM0IsaUJBQWlCLGlCQUFpQixVQUFVO0FBQUEsTUFDNUMsaUJBQWlCLGtCQUFrQixXQUFXO0FBQUEsTUFDOUMsaUJBQWlCLGlCQUFpQixVQUFVO0FBQUEsSUFDOUM7QUFDQSxVQUFNLFdBQVcsSUFBSSxhQUFhLEtBQUs7QUFDdkMsVUFBTSxNQUFNLFlBQVksV0FBVztBQUNuQyxVQUFNLFNBQVMsTUFBTSxTQUFTLGlCQUFpQixHQUFHO0FBRWxELFdBQU8sZ0JBQWdCLE9BQU8sUUFBUSxZQUFZLDZCQUE2QjtBQUMvRSxRQUFJLE9BQU8sV0FBVyxZQUFZO0FBQ2hDLGFBQU8sZ0JBQWdCLE9BQU8sVUFBVSxrQkFBa0IsNEJBQTRCO0FBQ3RGLGFBQU8sZ0JBQWdCLE9BQU8sUUFBUSx3QkFBd0IsMEJBQTBCO0FBQUEsSUFDMUY7QUFBQSxFQUNGLENBQUM7QUFFRCxPQUFLLHNEQUFzRCxZQUFZO0FBQ3JFLFVBQU0sUUFBdUI7QUFBQSxNQUMzQixpQkFBaUIsaUJBQWlCLFVBQVU7QUFBQSxJQUM5QztBQUNBLFVBQU0sV0FBVyxJQUFJLGFBQWEsS0FBSztBQUN2QyxVQUFNLE1BQU0sWUFBWSxTQUFTO0FBQ2pDLFVBQU0sU0FBUyxNQUFNLFNBQVMsaUJBQWlCLEdBQUc7QUFFbEQsV0FBTyxnQkFBZ0IsT0FBTyxRQUFRLFFBQVEseUJBQXlCO0FBQ3ZFLFFBQUksT0FBTyxXQUFXLFFBQVE7QUFDNUIsYUFBTyxHQUFHLE9BQU8sT0FBTyxTQUFTLFNBQVMsR0FBRyw0QkFBNEI7QUFBQSxJQUMzRTtBQUFBLEVBQ0YsQ0FBQztBQUVELE9BQUsscURBQXFELFlBQVk7QUFDcEUsVUFBTSxZQUF5QjtBQUFBLE1BQzdCLE1BQU07QUFBQSxNQUNOLE1BQU07QUFBQSxNQUNOLFlBQVk7QUFBQSxNQUNaLE9BQU8sT0FBT0EsU0FBeUQ7QUFFckUsY0FBTSxJQUFJLFFBQVEsYUFBVyxXQUFXLFNBQVMsQ0FBQyxDQUFDO0FBQ25ELFlBQUlBLEtBQUksTUFBTSxVQUFVLFlBQVk7QUFDbEMsaUJBQU87QUFBQSxZQUNMLFFBQVE7QUFBQSxZQUNSLFVBQVU7QUFBQSxZQUNWLFFBQVE7QUFBQSxZQUNSLFFBQVE7QUFBQSxVQUNWO0FBQUEsUUFDRjtBQUNBLGVBQU87QUFBQSxNQUNUO0FBQUEsTUFDQSxNQUFNLE1BQU07QUFBQSxNQUFDO0FBQUEsSUFDZjtBQUVBLFVBQU0sV0FBVyxJQUFJLGFBQWEsQ0FBQyxTQUFTLENBQUM7QUFDN0MsVUFBTSxNQUFNLFlBQVksVUFBVTtBQUNsQyxVQUFNLFNBQVMsTUFBTSxTQUFTLGlCQUFpQixHQUFHO0FBRWxELFdBQU8sZ0JBQWdCLE9BQU8sUUFBUSxZQUFZLHlCQUF5QjtBQUMzRSxRQUFJLE9BQU8sV0FBVyxZQUFZO0FBQ2hDLGFBQU8sZ0JBQWdCLE9BQU8sVUFBVSxjQUFjLG9CQUFvQjtBQUFBLElBQzVFO0FBQUEsRUFDRixDQUFDO0FBRUQsT0FBSyx1Q0FBdUMsTUFBTTtBQUNoRCxVQUFNLFdBQVcsSUFBSSxhQUFhLENBQUMsQ0FBQztBQUdwQyxhQUFTLGFBQWE7QUFBQSxNQUNwQixVQUFVO0FBQUEsTUFDVixpQkFBaUI7QUFBQSxNQUNqQixlQUFlO0FBQUEsTUFDZixPQUFPO0FBQUEsTUFDUCxjQUFjO0FBQUEsSUFDaEI7QUFDQSxhQUFTLFVBQVUsS0FBSztBQUFBLE1BQ3RCLFFBQVEsRUFBRSxNQUFNLEtBQUssT0FBTyxDQUFDLEdBQUcsUUFBUSxJQUFJO0FBQUEsTUFDNUMsaUJBQWlCO0FBQUEsTUFDakIsZUFBZTtBQUFBLElBQ2pCLENBQUM7QUFDRCxhQUFTLFlBQVksSUFBSSxZQUFZLENBQUM7QUFDdEMsYUFBUyxlQUFlO0FBQ3hCLGFBQVMsZUFBZSxFQUFFLFVBQVUsZ0JBQWdCLFFBQVEsZ0JBQWdCLGVBQWUsUUFBUTtBQUduRyxhQUFTLFdBQVc7QUFFcEIsV0FBTyxnQkFBZ0IsU0FBUyxjQUFjLEdBQUcsTUFBTSxvQkFBb0I7QUFDM0UsV0FBTyxnQkFBZ0IsU0FBUyxVQUFVLFFBQVEsR0FBRyxtQkFBbUI7QUFDeEUsV0FBTyxnQkFBZ0IsU0FBUyxZQUFZLE1BQU0sR0FBRyxxQkFBcUI7QUFDMUUsV0FBTyxnQkFBZ0IsU0FBUyxlQUFlLEdBQUcsT0FBTyxzQkFBc0I7QUFDL0UsV0FBTyxnQkFBZ0IsU0FBUyxvQkFBb0IsR0FBRyxNQUFNLHNCQUFzQjtBQUFBLEVBQ3JGLENBQUM7QUFFRCxPQUFLLHFEQUFxRCxNQUFNO0FBQzlELFFBQUksUUFBUTtBQUNaLFFBQUk7QUFDRixrQkFBWTtBQUFBLElBQ2QsU0FBUyxHQUFRO0FBQ2YsY0FBUTtBQUNSLGFBQU8sR0FBRyxFQUFFLFFBQVEsU0FBUyxpQkFBaUIsR0FBRyxnQ0FBZ0M7QUFBQSxJQUNuRjtBQUNBLFdBQU8sR0FBRyxPQUFPLG1CQUFtQjtBQUFBLEVBQ3RDLENBQUM7QUFFRCxPQUFLLHlDQUF5QyxNQUFNO0FBQ2xELFVBQU0sV0FBVyxJQUFJLGFBQWEsQ0FBQyxpQkFBaUIsa0JBQWtCLFVBQVUsQ0FBQyxDQUFDO0FBQ2xGLGdCQUFZLFFBQVE7QUFFcEIsVUFBTSxZQUFZLFlBQVk7QUFDOUIsV0FBTyxnQkFBZ0IsV0FBVyxVQUFVLHVDQUF1QztBQUVuRixVQUFNLFNBQVMsVUFBVSxVQUFVLEVBQUUsT0FBTyxPQUFLLEVBQUUsU0FBUyxVQUFVO0FBQ3RFLFdBQU8sZ0JBQWdCLE9BQU8sUUFBUSxHQUFHLCtCQUErQjtBQUN4RSxXQUFPLGdCQUFnQixPQUFPLENBQUMsRUFBRSxNQUFNLGtCQUFrQixtQkFBbUI7QUFBQSxFQUM5RSxDQUFDO0FBRUQsT0FBSywyQ0FBMkMsTUFBTTtBQUNwRCxVQUFNLFFBQVEsQ0FBQyxpQkFBaUIsYUFBYSxXQUFXLENBQUM7QUFDekQsVUFBTSxXQUFXLGFBQWEsS0FBSztBQUVuQyxXQUFPLGdCQUFnQixZQUFZLEdBQUcsVUFBVSxpQ0FBaUM7QUFDakYsVUFBTSxTQUFTLFlBQVksRUFBRSxVQUFVLEVBQUUsT0FBTyxPQUFLLEVBQUUsU0FBUyxVQUFVO0FBQzFFLFdBQU8sZ0JBQWdCLE9BQU8sUUFBUSxHQUFHLHdCQUF3QjtBQUFBLEVBQ25FLENBQUM7QUFFRCxPQUFLLDJEQUEyRCxZQUFZO0FBRTFFLFVBQU0sWUFBeUI7QUFBQSxNQUM3QixNQUFNO0FBQUEsTUFDTixNQUFNO0FBQUEsTUFDTixZQUFZO0FBQUEsTUFDWixPQUFPLE9BQU9BLFNBQXlCO0FBQ3JDLFlBQUlBLEtBQUksTUFBTSxVQUFVLFlBQVk7QUFDbEMsaUJBQU8sRUFBRSxRQUFRLFlBQXFCLFVBQVUsY0FBYyxRQUFRLE1BQU0sUUFBUSxRQUFRO0FBQUEsUUFDOUY7QUFDQSxlQUFPO0FBQUEsTUFDVDtBQUFBLE1BQ0EsTUFBTSxNQUFNO0FBQUEsTUFBQztBQUFBLElBQ2Y7QUFDQSxVQUFNLGFBQTBCO0FBQUEsTUFDOUIsTUFBTTtBQUFBLE1BQ04sTUFBTTtBQUFBLE1BQ04sWUFBWTtBQUFBLE1BQ1osT0FBTyxPQUFPQSxTQUF5QjtBQUNyQyxZQUFJQSxLQUFJLE1BQU0sVUFBVSxZQUFZO0FBQ2xDLGlCQUFPLEVBQUUsUUFBUSxZQUFxQixVQUFVLGdCQUFnQixRQUFRLE1BQU0sUUFBUSxTQUFTO0FBQUEsUUFDakc7QUFDQSxlQUFPO0FBQUEsTUFDVDtBQUFBLE1BQ0EsTUFBTSxNQUFNO0FBQUEsTUFBQztBQUFBLElBQ2Y7QUFFQSxVQUFNLFdBQVcsSUFBSSxhQUFhLENBQUMsV0FBVyxVQUFVLENBQUM7QUFDekQsVUFBTSxNQUFNLFlBQVksVUFBVTtBQUNsQyxVQUFNLFNBQVMsTUFBTSxTQUFTLGlCQUFpQixHQUFHO0FBRWxELFdBQU8sZ0JBQWdCLE9BQU8sUUFBUSxZQUFZLDBCQUEwQjtBQUM1RSxRQUFJLE9BQU8sV0FBVyxZQUFZO0FBQ2hDLGFBQU8sZ0JBQWdCLE9BQU8sVUFBVSxjQUFjLDRCQUE0QjtBQUFBLElBQ3BGO0FBQUEsRUFDRixDQUFDO0FBSUQsT0FBSyxzRUFBc0UsTUFBTTtBQUMvRSxVQUFNLFlBQVkscUJBQXFCLGNBQWM7QUFDckQsV0FBTyxnQkFBZ0IsVUFBVSxRQUFRLGVBQWUsUUFBUSxpQ0FBaUMsZUFBZSxNQUFNLFFBQVE7QUFBQSxFQUNoSSxDQUFDO0FBRUQsT0FBSyx1RUFBdUUsTUFBTTtBQUNoRixVQUFNLFlBQVkscUJBQXFCLGNBQWM7QUFDckQsYUFBUyxJQUFJLEdBQUcsSUFBSSxVQUFVLFFBQVEsS0FBSztBQUN6QyxZQUFNLE9BQU8sVUFBVSxDQUFDO0FBQ3hCLGFBQU8sZ0JBQWdCLEtBQUssTUFBTSxZQUFZLFFBQVEsQ0FBQyxzQkFBc0I7QUFDN0UsYUFBTyxnQkFBZ0IsS0FBSyxZQUFZLGVBQWUsUUFBUSxDQUFDLCtCQUErQjtBQUMvRixhQUFPLGdCQUFnQixLQUFLLE1BQU0sZUFBZSxDQUFDLEVBQUUsTUFBTSxRQUFRLENBQUMsb0JBQW9CLGVBQWUsQ0FBQyxFQUFFLElBQUksR0FBRztBQUNoSCxhQUFPLEdBQUcsT0FBTyxLQUFLLFVBQVUsWUFBWSxRQUFRLENBQUMsdUJBQXVCO0FBQzVFLGFBQU8sR0FBRyxPQUFPLEtBQUssU0FBUyxZQUFZLFFBQVEsQ0FBQyxzQkFBc0I7QUFBQSxJQUM1RTtBQUFBLEVBQ0YsQ0FBQztBQUVELE9BQUssK0VBQStFLE1BQU07QUFDeEYsVUFBTSxZQUFZLHFCQUFxQixjQUFjO0FBQ3JELFVBQU0sV0FBVyxJQUFJLGFBQWEsU0FBUztBQUMzQyxVQUFNLFNBQVMsU0FBUyxVQUFVLEVBQUUsT0FBTyxPQUFLLEVBQUUsU0FBUyxVQUFVO0FBQ3JFLFdBQU8sZ0JBQWdCLE9BQU8sUUFBUSxlQUFlLFFBQVEscUJBQXFCLGVBQWUsTUFBTSxpQkFBaUI7QUFBQSxFQUMxSCxDQUFDO0FBRUQsT0FBSyx1RUFBdUUsTUFBTTtBQUNoRixVQUFNLFlBQVkscUJBQXFCLGNBQWM7QUFDckQsVUFBTSxXQUFXLElBQUksYUFBYSxTQUFTO0FBQzNDLFVBQU0sY0FBYyxTQUFTLFVBQVUsRUFDcEMsT0FBTyxPQUFLLEVBQUUsU0FBUyxVQUFVLEVBQ2pDLElBQUksT0FBSyxFQUFFLElBQUk7QUFDbEIsVUFBTSxnQkFBZ0IscUJBQXFCO0FBRTNDLFdBQU8sZ0JBQWdCLFlBQVksUUFBUSxjQUFjLFFBQVEsc0JBQXNCO0FBQ3ZGLGFBQVMsSUFBSSxHQUFHLElBQUksY0FBYyxRQUFRLEtBQUs7QUFDN0MsYUFBTyxnQkFBZ0IsWUFBWSxDQUFDLEdBQUcsY0FBYyxDQUFDLEdBQUcsaUJBQWlCLENBQUMsY0FBYyxjQUFjLENBQUMsQ0FBQyxHQUFHO0FBQUEsSUFDOUc7QUFBQSxFQUNGLENBQUM7QUFJRCxPQUFLLDJFQUEyRSxNQUFNO0FBRXBGLFVBQU0sV0FBVyxvQkFBb0I7QUFDckMsV0FBTyxHQUFHLG9CQUFvQixjQUFjLGlDQUFpQztBQUM3RSxVQUFNLGdCQUFnQixTQUFTLFVBQVUsRUFBRSxPQUFPLE9BQUssRUFBRSxTQUFTLFVBQVU7QUFDNUUsV0FBTyxnQkFBZ0IsY0FBYyxRQUFRLEdBQUcsOENBQThDO0FBQUEsRUFDaEcsQ0FBQztBQUVELE9BQUssa0VBQWtFLE1BQU07QUFDM0UsVUFBTSxRQUFRLENBQUMsaUJBQWlCLGlCQUFpQixVQUFVLENBQUM7QUFDNUQsVUFBTSxXQUFXLGFBQWEsS0FBSztBQUNuQyxVQUFNLE9BQU8sb0JBQW9CO0FBQ2pDLFdBQU8sZ0JBQWdCLE1BQU0sVUFBVSxnRUFBZ0U7QUFDdkcsVUFBTSxnQkFBZ0IsS0FBSyxVQUFVLEVBQUUsT0FBTyxPQUFLLEVBQUUsU0FBUyxVQUFVO0FBQ3hFLFdBQU8sZ0JBQWdCLGNBQWMsUUFBUSxHQUFHLHdEQUF3RDtBQUFBLEVBQzFHLENBQUM7QUFJRCxPQUFLLHNFQUFzRSxNQUFNO0FBQy9FLFVBQU0sWUFBWSxxQkFBcUIsY0FBYztBQUNyRCxVQUFNLFdBQVcsSUFBSSxhQUFhLFNBQVM7QUFDM0MsVUFBTSxXQUFXLFNBQVMsVUFBVTtBQUNwQyxVQUFNLGdCQUFnQixTQUFTLE9BQU8sT0FBSyxFQUFFLFNBQVMsV0FBVztBQUNqRSxVQUFNLG1CQUFtQixTQUFTLE9BQU8sT0FBSyxFQUFFLFNBQVMsY0FBYztBQUd2RSxXQUFPLGdCQUFnQixjQUFjLFFBQVEsR0FBRyw2Q0FBNkM7QUFDN0YsV0FBTyxnQkFBZ0IsaUJBQWlCLFFBQVEsR0FBRyxnREFBZ0Q7QUFDbkcsV0FBTyxnQkFBZ0IsU0FBUyxRQUFRLGVBQWUsUUFBUSx3Q0FBd0M7QUFBQSxFQUN6RyxDQUFDO0FBRUQsT0FBSyxzREFBc0QsTUFBTTtBQUMvRCxVQUFNLFlBQVkscUJBQXFCLGNBQWM7QUFDckQsVUFBTSxXQUFXLElBQUksYUFBYSxTQUFTO0FBQzNDLFVBQU0sV0FBVyxTQUFTLFVBQVU7QUFHcEMsYUFBUyxJQUFJLEdBQUcsSUFBSSxVQUFVLFFBQVEsS0FBSztBQUN6QyxhQUFPLGdCQUFnQixTQUFTLENBQUMsRUFBRSxNQUFNLFlBQVksaUJBQWlCLENBQUMscUJBQXFCO0FBQzVGLGFBQU8sZ0JBQWdCLFNBQVMsQ0FBQyxFQUFFLE1BQU0sVUFBVSxDQUFDLEVBQUUsTUFBTSwwQkFBMEIsQ0FBQyxtQkFBbUI7QUFBQSxJQUM1RztBQUFBLEVBQ0YsQ0FBQztBQUlELE9BQUssNkRBQTZELE1BQU07QUFDdEUsVUFBTSxXQUFXLElBQUksYUFBYSxDQUFDLENBQUM7QUFDcEMsVUFBTSxTQUFTLFNBQVMsaUJBQWlCLG9CQUFvQixnQkFBZ0IsV0FBVztBQUN4RixXQUFPLGdCQUFnQixRQUFRLE1BQU0sc0NBQXNDO0FBQUEsRUFDN0UsQ0FBQztBQUVELE9BQUsscURBQXFELE1BQU07QUFDOUQsVUFBTSxXQUFXLElBQUksYUFBYSxDQUFDLENBQUM7QUFDcEMsVUFBTSxTQUFTLFNBQVMsaUJBQWlCLG1CQUFtQixnQkFBZ0IsV0FBVztBQUN2RixXQUFPLGdCQUFnQixRQUFRLE1BQU0seUJBQXlCO0FBQUEsRUFDaEUsQ0FBQztBQUVELE9BQUssZ0RBQWdELE1BQU07QUFDekQsVUFBTSxXQUFXLElBQUksYUFBYSxDQUFDLENBQUM7QUFDcEMsVUFBTSxTQUFTLFNBQVMsaUJBQWlCLGNBQWMsZ0JBQWdCLFdBQVc7QUFDbEYsV0FBTyxnQkFBZ0IsUUFBUSxNQUFNLG9CQUFvQjtBQUFBLEVBQzNELENBQUM7QUFFRCxPQUFLLDJDQUEyQyxNQUFNO0FBQ3BELFVBQU0sV0FBVyxJQUFJLGFBQWEsQ0FBQyxDQUFDO0FBQ3BDLFVBQU0sU0FBUyxTQUFTLG9CQUFvQixlQUFlLGdCQUFnQixVQUFVLFdBQVc7QUFDaEcsV0FBTyxnQkFBZ0IsT0FBTyxRQUFRLFdBQVcsMkJBQTJCO0FBQzVFLFdBQU8sZ0JBQWdCLE9BQU8sUUFBUSxVQUFVLGtCQUFrQjtBQUNsRSxXQUFPLGdCQUFnQixPQUFPLFdBQVcsUUFBUSxHQUFHLGdCQUFnQjtBQUFBLEVBQ3RFLENBQUM7QUFFRCxPQUFLLGlEQUFpRCxNQUFNO0FBQzFELFVBQU0sV0FBVyxJQUFJLGFBQWEsQ0FBQyxDQUFDO0FBQ3BDLFVBQU0sU0FBUyxTQUFTLG9CQUFvQixnQkFBZ0IsZ0JBQWdCLG1CQUFtQixXQUFXO0FBQzFHLFdBQU8sZ0JBQWdCLE9BQU8sUUFBUSxXQUFXLHdCQUF3QjtBQUN6RSxXQUFPLGdCQUFnQixPQUFPLFFBQVEsbUJBQW1CLGtCQUFrQjtBQUFBLEVBQzdFLENBQUM7QUFJRCxPQUFLLGtFQUFrRSxZQUFZO0FBQ2pGLFVBQU0sUUFBdUI7QUFBQSxNQUMzQixpQkFBaUIsb0JBQW9CLFVBQVU7QUFBQSxJQUNqRDtBQUNBLFVBQU0sV0FBVyxJQUFJLGFBQWEsS0FBSztBQUN2QyxVQUFNLE1BQU0sWUFBWSxVQUFVO0FBQ2xDLFVBQU0sU0FBUyxNQUFNLFNBQVMsaUJBQWlCLEdBQUc7QUFFbEQsV0FBTyxnQkFBZ0IsT0FBTyxRQUFRLFlBQVksNkJBQTZCO0FBQy9FLFdBQU8sZ0JBQWdCLE9BQU8sYUFBYSxvQkFBb0IsOEJBQThCO0FBQUEsRUFDL0YsQ0FBQztBQUVELE9BQUssOEVBQThFLFlBQVk7QUFDN0YsVUFBTSxRQUF1QjtBQUFBLE1BQzNCLGlCQUFpQixpQkFBaUIsVUFBVTtBQUFBLElBQzlDO0FBQ0EsVUFBTSxXQUFXLElBQUksYUFBYSxLQUFLO0FBQ3ZDLFVBQU0sTUFBTSxZQUFZLG9CQUFvQjtBQUM1QyxVQUFNLFNBQVMsTUFBTSxTQUFTLGlCQUFpQixHQUFHO0FBRWxELFdBQU8sZ0JBQWdCLE9BQU8sUUFBUSxRQUFRLHlCQUF5QjtBQUN2RSxXQUFPLGdCQUFnQixPQUFPLGFBQWEsY0FBYyx5Q0FBeUM7QUFBQSxFQUNwRyxDQUFDO0FBQ0gsQ0FBQzsiLAogICJuYW1lcyI6IFsiY3R4Il0KfQo=
