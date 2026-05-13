import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DISPATCH_RULES } from "../auto-dispatch.js";
const RULE_NAME_TOKEN = "execution-entry phase (no context)";
function findRule() {
  const matches = DISPATCH_RULES.filter((r) => r.name.includes(RULE_NAME_TOKEN));
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one dispatch rule containing "${RULE_NAME_TOKEN}", found ${matches.length}`
    );
  }
  return matches[0];
}
function buildState(phase) {
  return {
    activeMilestone: { id: "M001", title: "Test milestone" },
    activeSlice: null,
    activeTask: null,
    phase,
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: []
  };
}
function makeBasePath(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `gsd-4671-${prefix}-`));
  mkdirSync(join(dir, ".gsd", "milestones", "M001"), { recursive: true });
  return dir;
}
function buildCtx(basePath, state) {
  return {
    basePath,
    mid: "M001",
    midTitle: "Test milestone",
    state,
    prefs: void 0
  };
}
describe("#4671 execution-entry phase missing-context recovery", () => {
  const executionEntryPhases = [
    "executing",
    "summarizing",
    "validating-milestone",
    "completing-milestone"
  ];
  for (const phase of executionEntryPhases) {
    test(`phase=${phase} with missing CONTEXT.md \u2192 dispatches discuss-milestone`, async () => {
      const basePath = makeBasePath(`missing-${phase}`);
      try {
        const action = await findRule().match(buildCtx(basePath, buildState(phase)));
        assert.ok(action, "rule must return an action when CONTEXT.md is missing");
        assert.strictEqual(action.action, "dispatch");
        if (action.action === "dispatch") {
          assert.strictEqual(action.unitType, "discuss-milestone");
          assert.strictEqual(action.unitId, "M001");
          assert.ok(typeof action.prompt === "string" && action.prompt.length > 0);
        }
      } finally {
        rmSync(basePath, { recursive: true, force: true });
      }
    });
  }
  test("phase=executing with CONTEXT.md present \u2192 falls through", async () => {
    const basePath = makeBasePath("has-context");
    try {
      writeFileSync(
        join(basePath, ".gsd", "milestones", "M001", "M001-CONTEXT.md"),
        "# M001 Context\n\nSome real context.\n"
      );
      const action = await findRule().match(buildCtx(basePath, buildState("executing")));
      assert.strictEqual(action, null, "rule must fall through when CONTEXT.md exists");
    } finally {
      rmSync(basePath, { recursive: true, force: true });
    }
  });
  test("phase=executing accepts finalized CONTEXT.md from GSD_PROJECT_ROOT fallback", async () => {
    const projectRoot = makeBasePath("project-root-context");
    const worktreeBase = makeBasePath("worktree-context");
    const prevProjectRoot = process.env.GSD_PROJECT_ROOT;
    try {
      writeFileSync(
        join(projectRoot, ".gsd", "milestones", "M001", "M001-CONTEXT.md"),
        "# M001 Context\n\nFinalized context at project root.\n"
      );
      process.env.GSD_PROJECT_ROOT = projectRoot;
      const action = await findRule().match(buildCtx(worktreeBase, buildState("executing")));
      assert.strictEqual(
        action,
        null,
        "rule must align with plan-v2 project-root fallback before redispatching"
      );
    } finally {
      if (prevProjectRoot === void 0) {
        delete process.env.GSD_PROJECT_ROOT;
      } else {
        process.env.GSD_PROJECT_ROOT = prevProjectRoot;
      }
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(worktreeBase, { recursive: true, force: true });
    }
  });
  test("phase=pre-planning does not trigger this rule (handled by upstream rule)", async () => {
    const basePath = makeBasePath("pre-planning");
    try {
      const action = await findRule().match(buildCtx(basePath, buildState("pre-planning")));
      assert.strictEqual(
        action,
        null,
        "rule must only target execution-entry phases; pre-planning is handled elsewhere"
      );
    } finally {
      rmSync(basePath, { recursive: true, force: true });
    }
  });
  test("empty CONTEXT.md (whitespace only) \u2192 rule still fires", async () => {
    const basePath = makeBasePath("empty-context");
    try {
      writeFileSync(
        join(basePath, ".gsd", "milestones", "M001", "M001-CONTEXT.md"),
        "   \n	\n"
      );
      const action = await findRule().match(buildCtx(basePath, buildState("summarizing")));
      assert.ok(action, "rule must fire when CONTEXT.md is empty/whitespace-only");
      if (action?.action === "dispatch") {
        assert.strictEqual(action.unitType, "discuss-milestone");
      }
    } finally {
      rmSync(basePath, { recursive: true, force: true });
    }
  });
  test("rule ordering: fires BEFORE execution-entry phase handlers", () => {
    const recoveryIdx = DISPATCH_RULES.findIndex((r) => r.name.includes(RULE_NAME_TOKEN));
    const summarizingIdx = DISPATCH_RULES.findIndex(
      (r) => r.name.startsWith("summarizing \u2192 complete-slice")
    );
    assert.ok(recoveryIdx > -1, "recovery rule must exist");
    assert.ok(summarizingIdx > -1, "summarizing rule must exist");
    assert.ok(
      recoveryIdx < summarizingIdx,
      `recovery rule (idx ${recoveryIdx}) must come before summarizing rule (idx ${summarizingIdx}) so it can redispatch before the plan-v2 gate blocks`
    );
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9leGVjdXRpb24tZW50cnktbWlzc2luZy1jb250ZXh0LTQ2NzEudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBSZWdyZXNzaW9uIHRlc3RzIGZvciAjNDY3MSBcdTIwMTQgZXhlY3V0aW9uLWVudHJ5IHBoYXNlICsgbWlzc2luZyBDT05URVhULm1kLlxuICpcbiAqIFdoZW4gYSBtaWxlc3RvbmUgYWR2YW5jZXMgdG8gYW4gZXhlY3V0aW9uLWVudHJ5IHBoYXNlIChleGVjdXRpbmcgL1xuICogc3VtbWFyaXppbmcgLyB2YWxpZGF0aW5nLW1pbGVzdG9uZSAvIGNvbXBsZXRpbmctbWlsZXN0b25lKSB3aXRob3V0XG4gKiBgQ09OVEVYVC5tZGAgb24gZGlzaywgdGhlIGBwcmUtcGxhbm5pbmcgKG5vIGNvbnRleHQpIFx1MjE5MiBkaXNjdXNzLW1pbGVzdG9uZWBcbiAqIHJ1bGUgbm8gbG9uZ2VyIGZpcmVzIGFuZCB0aGUgcGxhbi12MiBnYXRlIG9ubHkgYmxvY2tzLiBUaGlzIHJ1bGUgcHJvdmlkZXNcbiAqIHRoZSByZWNvdmVyeSBieSByZWRpc3BhdGNoaW5nIHRvIGRpc2N1c3MtbWlsZXN0b25lLlxuICpcbiAqIEV4ZXJjaXNlcyB0aGUgZGlzcGF0Y2ggcnVsZSBmcm9tIERJU1BBVENIX1JVTEVTIGRpcmVjdGx5IHdpdGggYVxuICogRGlzcGF0Y2hDb250ZXh0IGJ1aWx0IGFnYWluc3QgYSByZWFsIHRlbXAgZGlyZWN0b3J5LlxuICovXG5pbXBvcnQgeyB0ZXN0LCBkZXNjcmliZSB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgd3JpdGVGaWxlU3luYywgcm1TeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgRElTUEFUQ0hfUlVMRVMsIHR5cGUgRGlzcGF0Y2hDb250ZXh0IH0gZnJvbSBcIi4uL2F1dG8tZGlzcGF0Y2gudHNcIjtcbmltcG9ydCB0eXBlIHsgR1NEU3RhdGUsIFBoYXNlIH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5cbmNvbnN0IFJVTEVfTkFNRV9UT0tFTiA9IFwiZXhlY3V0aW9uLWVudHJ5IHBoYXNlIChubyBjb250ZXh0KVwiO1xuXG5mdW5jdGlvbiBmaW5kUnVsZSgpIHtcbiAgY29uc3QgbWF0Y2hlcyA9IERJU1BBVENIX1JVTEVTLmZpbHRlcigocikgPT4gci5uYW1lLmluY2x1ZGVzKFJVTEVfTkFNRV9UT0tFTikpO1xuICBpZiAobWF0Y2hlcy5sZW5ndGggIT09IDEpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgZXhwZWN0ZWQgZXhhY3RseSBvbmUgZGlzcGF0Y2ggcnVsZSBjb250YWluaW5nIFwiJHtSVUxFX05BTUVfVE9LRU59XCIsIGZvdW5kICR7bWF0Y2hlcy5sZW5ndGh9YCxcbiAgICApO1xuICB9XG4gIHJldHVybiBtYXRjaGVzWzBdO1xufVxuXG5mdW5jdGlvbiBidWlsZFN0YXRlKHBoYXNlOiBQaGFzZSk6IEdTRFN0YXRlIHtcbiAgcmV0dXJuIHtcbiAgICBhY3RpdmVNaWxlc3RvbmU6IHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0IG1pbGVzdG9uZVwiIH0sXG4gICAgYWN0aXZlU2xpY2U6IG51bGwsXG4gICAgYWN0aXZlVGFzazogbnVsbCxcbiAgICBwaGFzZSxcbiAgICByZWNlbnREZWNpc2lvbnM6IFtdLFxuICAgIGJsb2NrZXJzOiBbXSxcbiAgICBuZXh0QWN0aW9uOiBcIlwiLFxuICAgIHJlZ2lzdHJ5OiBbXSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gbWFrZUJhc2VQYXRoKHByZWZpeDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgZGlyID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgYGdzZC00NjcxLSR7cHJlZml4fS1gKSk7XG4gIG1rZGlyU3luYyhqb2luKGRpciwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICByZXR1cm4gZGlyO1xufVxuXG5mdW5jdGlvbiBidWlsZEN0eChiYXNlUGF0aDogc3RyaW5nLCBzdGF0ZTogR1NEU3RhdGUpOiBEaXNwYXRjaENvbnRleHQge1xuICByZXR1cm4ge1xuICAgIGJhc2VQYXRoLFxuICAgIG1pZDogXCJNMDAxXCIsXG4gICAgbWlkVGl0bGU6IFwiVGVzdCBtaWxlc3RvbmVcIixcbiAgICBzdGF0ZSxcbiAgICBwcmVmczogdW5kZWZpbmVkLFxuICB9O1xufVxuXG5kZXNjcmliZShcIiM0NjcxIGV4ZWN1dGlvbi1lbnRyeSBwaGFzZSBtaXNzaW5nLWNvbnRleHQgcmVjb3ZlcnlcIiwgKCkgPT4ge1xuICBjb25zdCBleGVjdXRpb25FbnRyeVBoYXNlczogUGhhc2VbXSA9IFtcbiAgICBcImV4ZWN1dGluZ1wiLFxuICAgIFwic3VtbWFyaXppbmdcIixcbiAgICBcInZhbGlkYXRpbmctbWlsZXN0b25lXCIsXG4gICAgXCJjb21wbGV0aW5nLW1pbGVzdG9uZVwiLFxuICBdO1xuXG4gIGZvciAoY29uc3QgcGhhc2Ugb2YgZXhlY3V0aW9uRW50cnlQaGFzZXMpIHtcbiAgICB0ZXN0KGBwaGFzZT0ke3BoYXNlfSB3aXRoIG1pc3NpbmcgQ09OVEVYVC5tZCBcdTIxOTIgZGlzcGF0Y2hlcyBkaXNjdXNzLW1pbGVzdG9uZWAsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IGJhc2VQYXRoID0gbWFrZUJhc2VQYXRoKGBtaXNzaW5nLSR7cGhhc2V9YCk7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBhY3Rpb24gPSBhd2FpdCBmaW5kUnVsZSgpLm1hdGNoKGJ1aWxkQ3R4KGJhc2VQYXRoLCBidWlsZFN0YXRlKHBoYXNlKSkpO1xuICAgICAgICBhc3NlcnQub2soYWN0aW9uLCBcInJ1bGUgbXVzdCByZXR1cm4gYW4gYWN0aW9uIHdoZW4gQ09OVEVYVC5tZCBpcyBtaXNzaW5nXCIpO1xuICAgICAgICBhc3NlcnQuc3RyaWN0RXF1YWwoYWN0aW9uIS5hY3Rpb24sIFwiZGlzcGF0Y2hcIik7XG4gICAgICAgIGlmIChhY3Rpb24hLmFjdGlvbiA9PT0gXCJkaXNwYXRjaFwiKSB7XG4gICAgICAgICAgYXNzZXJ0LnN0cmljdEVxdWFsKGFjdGlvbiEudW5pdFR5cGUsIFwiZGlzY3Vzcy1taWxlc3RvbmVcIik7XG4gICAgICAgICAgYXNzZXJ0LnN0cmljdEVxdWFsKGFjdGlvbiEudW5pdElkLCBcIk0wMDFcIik7XG4gICAgICAgICAgYXNzZXJ0Lm9rKHR5cGVvZiBhY3Rpb24hLnByb21wdCA9PT0gXCJzdHJpbmdcIiAmJiBhY3Rpb24hLnByb21wdC5sZW5ndGggPiAwKTtcbiAgICAgICAgfVxuICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgcm1TeW5jKGJhc2VQYXRoLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cblxuICB0ZXN0KFwicGhhc2U9ZXhlY3V0aW5nIHdpdGggQ09OVEVYVC5tZCBwcmVzZW50IFx1MjE5MiBmYWxscyB0aHJvdWdoXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlUGF0aCA9IG1ha2VCYXNlUGF0aChcImhhcy1jb250ZXh0XCIpO1xuICAgIHRyeSB7XG4gICAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgICBqb2luKGJhc2VQYXRoLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcIk0wMDEtQ09OVEVYVC5tZFwiKSxcbiAgICAgICAgXCIjIE0wMDEgQ29udGV4dFxcblxcblNvbWUgcmVhbCBjb250ZXh0LlxcblwiLFxuICAgICAgKTtcbiAgICAgIGNvbnN0IGFjdGlvbiA9IGF3YWl0IGZpbmRSdWxlKCkubWF0Y2goYnVpbGRDdHgoYmFzZVBhdGgsIGJ1aWxkU3RhdGUoXCJleGVjdXRpbmdcIikpKTtcbiAgICAgIGFzc2VydC5zdHJpY3RFcXVhbChhY3Rpb24sIG51bGwsIFwicnVsZSBtdXN0IGZhbGwgdGhyb3VnaCB3aGVuIENPTlRFWFQubWQgZXhpc3RzXCIpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmMoYmFzZVBhdGgsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJwaGFzZT1leGVjdXRpbmcgYWNjZXB0cyBmaW5hbGl6ZWQgQ09OVEVYVC5tZCBmcm9tIEdTRF9QUk9KRUNUX1JPT1QgZmFsbGJhY2tcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHByb2plY3RSb290ID0gbWFrZUJhc2VQYXRoKFwicHJvamVjdC1yb290LWNvbnRleHRcIik7XG4gICAgY29uc3Qgd29ya3RyZWVCYXNlID0gbWFrZUJhc2VQYXRoKFwid29ya3RyZWUtY29udGV4dFwiKTtcbiAgICBjb25zdCBwcmV2UHJvamVjdFJvb3QgPSBwcm9jZXNzLmVudi5HU0RfUFJPSkVDVF9ST09UO1xuICAgIHRyeSB7XG4gICAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgICBqb2luKHByb2plY3RSb290LCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcIk0wMDEtQ09OVEVYVC5tZFwiKSxcbiAgICAgICAgXCIjIE0wMDEgQ29udGV4dFxcblxcbkZpbmFsaXplZCBjb250ZXh0IGF0IHByb2plY3Qgcm9vdC5cXG5cIixcbiAgICAgICk7XG4gICAgICBwcm9jZXNzLmVudi5HU0RfUFJPSkVDVF9ST09UID0gcHJvamVjdFJvb3Q7XG5cbiAgICAgIGNvbnN0IGFjdGlvbiA9IGF3YWl0IGZpbmRSdWxlKCkubWF0Y2goYnVpbGRDdHgod29ya3RyZWVCYXNlLCBidWlsZFN0YXRlKFwiZXhlY3V0aW5nXCIpKSk7XG4gICAgICBhc3NlcnQuc3RyaWN0RXF1YWwoXG4gICAgICAgIGFjdGlvbixcbiAgICAgICAgbnVsbCxcbiAgICAgICAgXCJydWxlIG11c3QgYWxpZ24gd2l0aCBwbGFuLXYyIHByb2plY3Qtcm9vdCBmYWxsYmFjayBiZWZvcmUgcmVkaXNwYXRjaGluZ1wiLFxuICAgICAgKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgaWYgKHByZXZQcm9qZWN0Um9vdCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGRlbGV0ZSBwcm9jZXNzLmVudi5HU0RfUFJPSkVDVF9ST09UO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcHJvY2Vzcy5lbnYuR1NEX1BST0pFQ1RfUk9PVCA9IHByZXZQcm9qZWN0Um9vdDtcbiAgICAgIH1cbiAgICAgIHJtU3luYyhwcm9qZWN0Um9vdCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgICAgcm1TeW5jKHdvcmt0cmVlQmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcInBoYXNlPXByZS1wbGFubmluZyBkb2VzIG5vdCB0cmlnZ2VyIHRoaXMgcnVsZSAoaGFuZGxlZCBieSB1cHN0cmVhbSBydWxlKVwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZVBhdGggPSBtYWtlQmFzZVBhdGgoXCJwcmUtcGxhbm5pbmdcIik7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGFjdGlvbiA9IGF3YWl0IGZpbmRSdWxlKCkubWF0Y2goYnVpbGRDdHgoYmFzZVBhdGgsIGJ1aWxkU3RhdGUoXCJwcmUtcGxhbm5pbmdcIikpKTtcbiAgICAgIGFzc2VydC5zdHJpY3RFcXVhbChcbiAgICAgICAgYWN0aW9uLFxuICAgICAgICBudWxsLFxuICAgICAgICBcInJ1bGUgbXVzdCBvbmx5IHRhcmdldCBleGVjdXRpb24tZW50cnkgcGhhc2VzOyBwcmUtcGxhbm5pbmcgaXMgaGFuZGxlZCBlbHNld2hlcmVcIixcbiAgICAgICk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyhiYXNlUGF0aCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcImVtcHR5IENPTlRFWFQubWQgKHdoaXRlc3BhY2Ugb25seSkgXHUyMTkyIHJ1bGUgc3RpbGwgZmlyZXNcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2VQYXRoID0gbWFrZUJhc2VQYXRoKFwiZW1wdHktY29udGV4dFwiKTtcbiAgICB0cnkge1xuICAgICAgd3JpdGVGaWxlU3luYyhcbiAgICAgICAgam9pbihiYXNlUGF0aCwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJNMDAxLUNPTlRFWFQubWRcIiksXG4gICAgICAgIFwiICAgXFxuXFx0XFxuXCIsXG4gICAgICApO1xuICAgICAgY29uc3QgYWN0aW9uID0gYXdhaXQgZmluZFJ1bGUoKS5tYXRjaChidWlsZEN0eChiYXNlUGF0aCwgYnVpbGRTdGF0ZShcInN1bW1hcml6aW5nXCIpKSk7XG4gICAgICBhc3NlcnQub2soYWN0aW9uLCBcInJ1bGUgbXVzdCBmaXJlIHdoZW4gQ09OVEVYVC5tZCBpcyBlbXB0eS93aGl0ZXNwYWNlLW9ubHlcIik7XG4gICAgICBpZiAoYWN0aW9uPy5hY3Rpb24gPT09IFwiZGlzcGF0Y2hcIikge1xuICAgICAgICBhc3NlcnQuc3RyaWN0RXF1YWwoYWN0aW9uLnVuaXRUeXBlLCBcImRpc2N1c3MtbWlsZXN0b25lXCIpO1xuICAgICAgfVxuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmMoYmFzZVBhdGgsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJydWxlIG9yZGVyaW5nOiBmaXJlcyBCRUZPUkUgZXhlY3V0aW9uLWVudHJ5IHBoYXNlIGhhbmRsZXJzXCIsICgpID0+IHtcbiAgICBjb25zdCByZWNvdmVyeUlkeCA9IERJU1BBVENIX1JVTEVTLmZpbmRJbmRleCgocikgPT4gci5uYW1lLmluY2x1ZGVzKFJVTEVfTkFNRV9UT0tFTikpO1xuICAgIGNvbnN0IHN1bW1hcml6aW5nSWR4ID0gRElTUEFUQ0hfUlVMRVMuZmluZEluZGV4KChyKSA9PlxuICAgICAgci5uYW1lLnN0YXJ0c1dpdGgoXCJzdW1tYXJpemluZyBcdTIxOTIgY29tcGxldGUtc2xpY2VcIiksXG4gICAgKTtcbiAgICBhc3NlcnQub2socmVjb3ZlcnlJZHggPiAtMSwgXCJyZWNvdmVyeSBydWxlIG11c3QgZXhpc3RcIik7XG4gICAgYXNzZXJ0Lm9rKHN1bW1hcml6aW5nSWR4ID4gLTEsIFwic3VtbWFyaXppbmcgcnVsZSBtdXN0IGV4aXN0XCIpO1xuICAgIGFzc2VydC5vayhcbiAgICAgIHJlY292ZXJ5SWR4IDwgc3VtbWFyaXppbmdJZHgsXG4gICAgICBgcmVjb3ZlcnkgcnVsZSAoaWR4ICR7cmVjb3ZlcnlJZHh9KSBtdXN0IGNvbWUgYmVmb3JlIHN1bW1hcml6aW5nIHJ1bGUgKGlkeCAke3N1bW1hcml6aW5nSWR4fSkgc28gaXQgY2FuIHJlZGlzcGF0Y2ggYmVmb3JlIHRoZSBwbGFuLXYyIGdhdGUgYmxvY2tzYCxcbiAgICApO1xuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBWUEsU0FBUyxNQUFNLGdCQUFnQjtBQUMvQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxhQUFhLFdBQVcsZUFBZSxjQUFjO0FBQzlELFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFDdkIsU0FBUyxzQkFBNEM7QUFHckQsTUFBTSxrQkFBa0I7QUFFeEIsU0FBUyxXQUFXO0FBQ2xCLFFBQU0sVUFBVSxlQUFlLE9BQU8sQ0FBQyxNQUFNLEVBQUUsS0FBSyxTQUFTLGVBQWUsQ0FBQztBQUM3RSxNQUFJLFFBQVEsV0FBVyxHQUFHO0FBQ3hCLFVBQU0sSUFBSTtBQUFBLE1BQ1Isa0RBQWtELGVBQWUsWUFBWSxRQUFRLE1BQU07QUFBQSxJQUM3RjtBQUFBLEVBQ0Y7QUFDQSxTQUFPLFFBQVEs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
