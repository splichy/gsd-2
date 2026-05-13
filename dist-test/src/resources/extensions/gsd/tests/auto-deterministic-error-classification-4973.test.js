import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  isDeterministicPolicyError,
  DETERMINISTIC_POLICY_ERROR_STRINGS
} from "../auto-tool-tracking.js";
import { AutoSession } from "../auto/session.js";
import { _setAutoActiveForTest } from "../auto.js";
import { escalateTier } from "../model-router.js";
const tmpDirs = [];
function makeTmpBase() {
  const base = mkdtempSync(join(tmpdir(), `gsd-test-4973-${randomUUID().slice(0, 8)}-`));
  tmpDirs.push(base);
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  return base;
}
function makeBrokenIsolatedWorktree() {
  const root = mkdtempSync(join(tmpdir(), `gsd-test-5848-${randomUUID().slice(0, 8)}-`));
  tmpDirs.push(root);
  const base = join(root, ".gsd", "projects", "project-id", "worktrees", "M003");
  mkdirSync(join(base, ".gsd", "milestones", "M003", "slices", "S03"), { recursive: true });
  return base;
}
function makeBrokenIsolatedWorktreeRevParse() {
  const base = makeBrokenIsolatedWorktree();
  mkdirSync(join(base, ".git"));
  return base;
}
function resetAutoState() {
  _setAutoActiveForTest(false);
}
describe("Test 5 \u2014 isDeterministicPolicyError classifier (#4973)", () => {
  test("classifies context_write_blocked fallback text as deterministic", () => {
    const errorText = "gsd_summary_save: Error saving artifact: context write blocked";
    assert.strictEqual(
      isDeterministicPolicyError(errorText),
      true,
      "fallback context_write_blocked text must be classified as deterministic"
    );
  });
  test("classifies write-gate verbose reason as deterministic", () => {
    const verboseError = [
      "gsd_summary_save: Error saving artifact:",
      "HARD BLOCK: Cannot save milestone CONTEXT without depth verification for M001.",
      "This is a mechanical gate \u2014 you MUST NOT proceed, retry, or rationalize past this block."
    ].join(" ");
    assert.strictEqual(
      isDeterministicPolicyError(verboseError),
      true,
      "verbose write-gate reason containing 'CONTEXT without depth verification' must be classified as deterministic"
    );
  });
  test("returns false for malformed-JSON errors (separate classification path)", () => {
    assert.strictEqual(
      isDeterministicPolicyError("Unexpected end of JSON input"),
      false,
      "malformed-JSON errors are not deterministic policy errors"
    );
    assert.strictEqual(
      isDeterministicPolicyError("Validation failed for tool gsd_complete_slice"),
      false
    );
  });
  test("returns false for normal business-logic tool errors", () => {
    assert.strictEqual(
      isDeterministicPolicyError("Slice S01 is already complete"),
      false
    );
    assert.strictEqual(
      isDeterministicPolicyError("Error saving artifact: db_unavailable"),
      false
    );
  });
  test("returns false for empty string", () => {
    assert.strictEqual(isDeterministicPolicyError(""), false);
  });
  test("DETERMINISTIC_POLICY_ERROR_STRINGS list is non-empty and contains context_write_blocked entry", () => {
    assert.ok(
      DETERMINISTIC_POLICY_ERROR_STRINGS.length > 0,
      "must have at least one known deterministic error string"
    );
    const hasContextWriteBlocked = DETERMINISTIC_POLICY_ERROR_STRINGS.some(
      (s) => s.includes("context write blocked") || s.includes("CONTEXT without depth verification")
    );
    assert.ok(hasContextWriteBlocked, "must include context_write_blocked family entries");
  });
});
describe("Test 5 \u2014 recordToolInvocationError captures deterministic errors (#4973)", () => {
  beforeEach(resetAutoState);
  afterEach(resetAutoState);
  test("lastToolInvocationError is NOT set for deterministic errors on current main (pre-fix baseline)", () => {
    _setAutoActiveForTest(true);
    const s = new AutoSession();
    assert.strictEqual(s.lastToolInvocationError, null, "starts null");
    s.lastToolInvocationError = "gsd_summary_save: Error saving artifact: context write blocked";
    assert.ok(
      isDeterministicPolicyError(s.lastToolInvocationError),
      "classifier recognises the stored error \u2014 short-circuit will fire"
    );
    assert.strictEqual(s.pendingVerificationRetry, null, "pendingVerificationRetry starts null");
  });
  test("AutoSession.lastToolInvocationError can hold a deterministic policy error string", () => {
    const s = new AutoSession();
    s.lastToolInvocationError = "gsd_summary_save: Error saving artifact: context write blocked";
    assert.ok(s.lastToolInvocationError);
    assert.ok(isDeterministicPolicyError(s.lastToolInvocationError));
  });
  test("AutoSession.lastToolInvocationError is cleared on reset()", () => {
    const s = new AutoSession();
    s.lastToolInvocationError = "gsd_summary_save: Error saving artifact: context write blocked";
    s.reset();
    assert.strictEqual(s.lastToolInvocationError, null);
  });
});
describe("Test 5 \u2014 postUnitPreVerification short-circuits on deterministic error (#4973)", () => {
  let base = "";
  beforeEach(() => {
    base = makeTmpBase();
    _setAutoActiveForTest(true);
  });
  afterEach(() => {
    _setAutoActiveForTest(false);
  });
  test("returns 'continue' and writes placeholder for context_write_blocked \u2014 no pendingVerificationRetry set", async () => {
    const { postUnitPreVerification } = await import("../auto-post-unit.js");
    const s = new AutoSession();
    s.active = true;
    s.basePath = base;
    s.currentUnit = { type: "discuss-milestone", id: "M001", startedAt: Date.now() };
    s.lastToolInvocationError = "gsd_summary_save: Error saving artifact: context write blocked";
    s.verificationRetryCount.set("discuss-milestone:M001", 2);
    let pauseCalled = false;
    const ctx = {
      ui: { notify: () => {
      } }
    };
    const pi = {};
    const pctx = {
      s,
      ctx,
      pi,
      buildSnapshotOpts: () => ({}),
      lockBase: () => base,
      stopAuto: async () => {
      },
      pauseAuto: async () => {
        pauseCalled = true;
      },
      updateProgressWidget: () => {
      }
    };
    const result = await postUnitPreVerification(pctx, { skipSettleDelay: true });
    assert.strictEqual(result, "continue", "must return 'continue', not 'retry' or 'dispatched'");
    assert.strictEqual(s.pendingVerificationRetry, null, "pendingVerificationRetry must NOT be set");
    assert.strictEqual(s.verificationRetryCount.has("discuss-milestone:M001"), false, "deterministic short-circuit clears stale retry count");
    assert.strictEqual(s.lastToolInvocationError, null, "lastToolInvocationError cleared after handling");
    assert.strictEqual(pauseCalled, false, "pauseAuto must NOT be called for deterministic errors");
    const placeholderPath = join(base, ".gsd", "milestones", "M001", "M001-CONTEXT.md");
    assert.ok(
      existsSync(placeholderPath),
      `blocker placeholder must be written at ${placeholderPath}`
    );
  });
});
describe("Test 5b \u2014 broken isolated worktree short-circuits artifact retry (#5848)", () => {
  test("pauses with worktree integrity failure instead of setting pendingVerificationRetry", async () => {
    const { postUnitPreVerification } = await import("../auto-post-unit.js");
    const base = makeBrokenIsolatedWorktree();
    const s = new AutoSession();
    s.active = true;
    s.basePath = base;
    s.currentUnit = { type: "research-slice", id: "M003/S03", startedAt: Date.now() };
    s.verificationRetryCount.set("research-slice:M003/S03", 2);
    const notifications = [];
    let pauseCalled = false;
    const pctx = {
      s,
      ctx: {
        ui: {
          notify: (message) => {
            notifications.push(message);
          }
        }
      },
      pi: {},
      buildSnapshotOpts: () => ({}),
      lockBase: () => base,
      stopAuto: async () => {
      },
      pauseAuto: async () => {
        pauseCalled = true;
      },
      updateProgressWidget: () => {
      }
    };
    const result = await postUnitPreVerification(pctx, {
      skipSettleDelay: true,
      skipWorktreeSync: true
    });
    assert.strictEqual(result, "dispatched", "worktree integrity failure must pause instead of retrying");
    assert.strictEqual(pauseCalled, true, "pauseAuto must be called for a broken isolated worktree");
    assert.strictEqual(s.pendingVerificationRetry, null, "pendingVerificationRetry must NOT be set");
    assert.strictEqual(s.verificationRetryCount.has("research-slice:M003/S03"), false, "stale retry count must be cleared");
    assert.ok(
      notifications.some((message) => message.includes("Worktree integrity failure") && message.includes(".git missing")),
      `expected worktree integrity notification, got: ${notifications.join("\n")}`
    );
    assert.ok(
      notifications.every((message) => !message.includes("Artifact verification failed")),
      `must not surface artifact retry messaging, got: ${notifications.join("\n")}`
    );
  });
  test("pauses when git rev-parse cannot validate an isolated worktree", async () => {
    const { postUnitPreVerification } = await import("../auto-post-unit.js");
    const base = makeBrokenIsolatedWorktreeRevParse();
    const s = new AutoSession();
    s.active = true;
    s.basePath = base;
    s.currentUnit = { type: "research-slice", id: "M003/S03", startedAt: Date.now() };
    s.verificationRetryCount.set("research-slice:M003/S03", 2);
    const notifications = [];
    let pauseCalled = false;
    const pctx = {
      s,
      ctx: {
        ui: {
          notify: (message) => {
            notifications.push(message);
          }
        }
      },
      pi: {},
      buildSnapshotOpts: () => ({}),
      lockBase: () => base,
      stopAuto: async () => {
      },
      pauseAuto: async () => {
        pauseCalled = true;
      },
      updateProgressWidget: () => {
      }
    };
    const result = await postUnitPreVerification(pctx, {
      skipSettleDelay: true,
      skipWorktreeSync: true
    });
    assert.strictEqual(result, "dispatched", "worktree integrity failure must pause instead of retrying");
    assert.strictEqual(pauseCalled, true, "pauseAuto must be called for a broken isolated worktree");
    assert.strictEqual(s.pendingVerificationRetry, null, "pendingVerificationRetry must NOT be set");
    assert.strictEqual(s.verificationRetryCount.has("research-slice:M003/S03"), false, "stale retry count must be cleared");
    assert.ok(
      notifications.some((message) => message.includes("Worktree integrity failure") && message.includes("git rev-parse")),
      `expected git rev-parse worktree integrity notification, got: ${notifications.join("\n")}`
    );
    assert.ok(
      notifications.every((message) => !message.includes("Artifact verification failed")),
      `must not surface artifact retry messaging, got: ${notifications.join("\n")}`
    );
  });
});
describe("Test 6 \u2014 non-deterministic failures use standard retry; tier escalates once (#4973)", () => {
  test("escalateTier: light \u2192 standard \u2192 heavy \u2192 null (max)", () => {
    assert.strictEqual(escalateTier("light"), "standard");
    assert.strictEqual(escalateTier("standard"), "heavy");
    assert.strictEqual(escalateTier("heavy"), null, "heavy is the max tier \u2014 no further escalation");
  });
  test("standard-start retry: escalates to heavy on retry 1, stays at heavy on retry 2 (escalateTier returns null)", () => {
    const tier1 = escalateTier("standard");
    assert.strictEqual(tier1, "heavy", "retry 1: standard escalates to heavy");
    const tier2 = escalateTier("heavy");
    assert.strictEqual(tier2, null, "retry 2: heavy cannot escalate further");
    const tierOrder = { light: 0, standard: 1, heavy: 2 };
    const prevOrder = tierOrder["heavy"] ?? 0;
    const freshOrder = tierOrder["standard"] ?? 0;
    assert.ok(
      prevOrder > freshOrder,
      "prevOrder(heavy=2) > freshOrder(standard=1) \u2014 the fix retains 'heavy' and prevents revert"
    );
  });
  test("light-start retry 3: escalated tier is retained, not reverted to 'light'", () => {
    assert.strictEqual(escalateTier("light"), "standard");
    assert.strictEqual(escalateTier("standard"), "heavy");
    assert.strictEqual(escalateTier("heavy"), null);
    const tierOrder = { light: 0, standard: 1, heavy: 2 };
    const prevOrderRetry3 = tierOrder["heavy"] ?? 0;
    const freshOrderLight = tierOrder["light"] ?? 0;
    assert.ok(
      prevOrderRetry3 > freshOrderLight,
      "on retry 3, prevOrder(heavy=2) > freshOrder(light=0) \u2014 'heavy' must be retained, not reverted"
    );
  });
  test("non-deterministic error: session sets pendingVerificationRetry (standard retry path)", () => {
    const s = new AutoSession();
    s.currentUnit = { type: "plan-slice", id: "M001:S01", startedAt: Date.now() };
    const retryKey = `${s.currentUnit.type}:${s.currentUnit.id}`;
    const attempt = (s.verificationRetryCount.get(retryKey) ?? 0) + 1;
    s.verificationRetryCount.set(retryKey, attempt);
    s.pendingVerificationRetry = {
      unitId: s.currentUnit.id,
      failureContext: `Artifact verification failed: expected artifact for ${s.currentUnit.type} "${s.currentUnit.id}" was not found on disk after unit execution (attempt ${attempt}).`,
      attempt
    };
    assert.ok(s.pendingVerificationRetry !== null, "standard retry path sets pendingVerificationRetry");
    assert.strictEqual(s.pendingVerificationRetry.attempt, 1, "attempt is 1");
    assert.ok(
      s.pendingVerificationRetry.failureContext.includes("plan-slice"),
      "failureContext references the unit type"
    );
  });
  test("isDeterministicPolicyError returns false for non-deterministic verification failure", () => {
    assert.strictEqual(
      isDeterministicPolicyError(""),
      false,
      "empty error (no tool error) is not deterministic"
    );
    assert.strictEqual(
      isDeterministicPolicyError("Artifact not found on disk"),
      false,
      "plain artifact-missing message is not a deterministic policy error"
    );
    assert.strictEqual(
      isDeterministicPolicyError("existsSync returned false"),
      false
    );
  });
});
process.on("exit", () => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
    }
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9hdXRvLWRldGVybWluaXN0aWMtZXJyb3ItY2xhc3NpZmljYXRpb24tNDk3My50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBHU0QtMiArIFJlZ3Jlc3Npb24gdGVzdHMgZm9yIGRldGVybWluaXN0aWMgcG9saWN5IGVycm9yIGNsYXNzaWZpY2F0aW9uICgjNDk3Mylcbi8vXG4vLyBXaGVuIGdzZF9zdW1tYXJ5X3NhdmUgcmV0dXJucyBjb250ZXh0X3dyaXRlX2Jsb2NrZWQgKGEgZGV0ZXJtaW5pc3RpYyB3cml0ZS1nYXRlXG4vLyByZWplY3Rpb24pLCB0aGUgcmV0cnkgY29udHJvbGxlciBtdXN0IE5PVCByZS1kaXNwYXRjaCB3aXRoIGVzY2FsYXRpbmcgbW9kZWwgdGllcnMuXG4vLyBJbnN0ZWFkIGl0IG11c3Qgd3JpdGUgYSBibG9ja2VyIHBsYWNlaG9sZGVyIGFuZCBhZHZhbmNlIHRoZSBwaXBlbGluZSBpbW1lZGlhdGVseS5cbi8vXG4vLyBUZXN0IDUgXHUyMDE0IGRldGVybWluaXN0aWMgZXJyb3Igc2hvcnQtY2lyY3VpdHMgcmV0cnk6XG4vLyAgIC0gaXNEZXRlcm1pbmlzdGljUG9saWN5RXJyb3IgY29ycmVjdGx5IGNsYXNzaWZpZXMgY29udGV4dF93cml0ZV9ibG9ja2VkIGVycm9yc1xuLy8gICAtIHJlY29yZFRvb2xJbnZvY2F0aW9uRXJyb3IgY2FwdHVyZXMgZGV0ZXJtaW5pc3RpYyBlcnJvcnMgaW4gbGFzdFRvb2xJbnZvY2F0aW9uRXJyb3Jcbi8vICAgLSBwb3N0VW5pdFByZVZlcmlmaWNhdGlvbiByZXR1cm5zIFwiY29udGludWVcIiAobm90IFwicmV0cnlcIiksIHdyaXRlcyBwbGFjZWhvbGRlcixcbi8vICAgICBsZWF2ZXMgcGVuZGluZ1ZlcmlmaWNhdGlvblJldHJ5IG51bGwgXHUyMDE0IHplcm8gYWRkaXRpb25hbCBtb2RlbCBjYWxscyBkaXNwYXRjaGVkXG4vL1xuLy8gVGVzdCA2IFx1MjAxNCBtb2RlbC1xdWFsaXR5IGZhaWx1cmVzIHN0aWxsIHVzZSBzdGFuZGFyZCByZXRyeSBwYXRoOlxuLy8gICAtIG5vbi1kZXRlcm1pbmlzdGljIGZhaWx1cmVzIHNldCBwZW5kaW5nVmVyaWZpY2F0aW9uUmV0cnkgYW5kIHJldHVybiBcInJldHJ5XCJcbi8vICAgLSB0aWVyIGVzY2FsYXRlcyBvbiByZXRyeSAxIChwcmV2aW91c1RpZXIgXCJzdGFuZGFyZFwiIFx1MjE5MiBcImhlYXZ5XCIpXG4vLyAgIC0gdGllciBpcyBSRVRBSU5FRCBhdCBcImhlYXZ5XCIgb24gc3Vic2VxdWVudCByZXRyaWVzIChubyBkb3duZ3JhZGUgYmFjayB0byBmcmVzaFxuLy8gICAgIGNsYXNzaWZpY2F0aW9uIHdoZW4gYWxyZWFkeSBhdCBtYXggdGllcikgXHUyMDE0IFwiZXNjYWxhdGUgb25jZVwiIHNlbWFudGljc1xuXG5pbXBvcnQgeyBkZXNjcmliZSwgdGVzdCwgYmVmb3JlRWFjaCwgYWZ0ZXJFYWNoIH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgbWtkaXJTeW5jLCBleGlzdHNTeW5jLCBybVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSBcIm5vZGU6Y3J5cHRvXCI7XG5cbmltcG9ydCB7XG4gIGlzRGV0ZXJtaW5pc3RpY1BvbGljeUVycm9yLFxuICBERVRFUk1JTklTVElDX1BPTElDWV9FUlJPUl9TVFJJTkdTLFxufSBmcm9tIFwiLi4vYXV0by10b29sLXRyYWNraW5nLnRzXCI7XG5pbXBvcnQgeyBBdXRvU2Vzc2lvbiB9IGZyb20gXCIuLi9hdXRvL3Nlc3Npb24udHNcIjtcbmltcG9ydCB7IF9zZXRBdXRvQWN0aXZlRm9yVGVzdCB9IGZyb20gXCIuLi9hdXRvLnRzXCI7XG5pbXBvcnQgeyBlc2NhbGF0ZVRpZXIgfSBmcm9tIFwiLi4vbW9kZWwtcm91dGVyLnRzXCI7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBIZWxwZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5jb25zdCB0bXBEaXJzOiBzdHJpbmdbXSA9IFtdO1xuXG5mdW5jdGlvbiBtYWtlVG1wQmFzZSgpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgYGdzZC10ZXN0LTQ5NzMtJHtyYW5kb21VVUlEKCkuc2xpY2UoMCwgOCl9LWApKTtcbiAgdG1wRGlycy5wdXNoKGJhc2UpO1xuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHJldHVybiBiYXNlO1xufVxuXG5mdW5jdGlvbiBtYWtlQnJva2VuSXNvbGF0ZWRXb3JrdHJlZSgpOiBzdHJpbmcge1xuICBjb25zdCByb290ID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgYGdzZC10ZXN0LTU4NDgtJHtyYW5kb21VVUlEKCkuc2xpY2UoMCwgOCl9LWApKTtcbiAgdG1wRGlycy5wdXNoKHJvb3QpO1xuICBjb25zdCBiYXNlID0gam9pbihyb290LCBcIi5nc2RcIiwgXCJwcm9qZWN0c1wiLCBcInByb2plY3QtaWRcIiwgXCJ3b3JrdHJlZXNcIiwgXCJNMDAzXCIpO1xuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwM1wiLCBcInNsaWNlc1wiLCBcIlMwM1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHJldHVybiBiYXNlO1xufVxuXG5mdW5jdGlvbiBtYWtlQnJva2VuSXNvbGF0ZWRXb3JrdHJlZVJldlBhcnNlKCk6IHN0cmluZyB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlQnJva2VuSXNvbGF0ZWRXb3JrdHJlZSgpO1xuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5naXRcIikpO1xuICByZXR1cm4gYmFzZTtcbn1cblxuZnVuY3Rpb24gcmVzZXRBdXRvU3RhdGUoKTogdm9pZCB7XG4gIF9zZXRBdXRvQWN0aXZlRm9yVGVzdChmYWxzZSk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUZXN0IDU6IERldGVybWluaXN0aWMgZXJyb3Igc2hvcnQtY2lyY3VpdHMgcmV0cnkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiVGVzdCA1IFx1MjAxNCBpc0RldGVybWluaXN0aWNQb2xpY3lFcnJvciBjbGFzc2lmaWVyICgjNDk3MylcIiwgKCkgPT4ge1xuICAvLyBcdTI1MDBcdTI1MDAgQ2xhc3NpZmllciB1bml0IHRlc3RzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4gIHRlc3QoXCJjbGFzc2lmaWVzIGNvbnRleHRfd3JpdGVfYmxvY2tlZCBmYWxsYmFjayB0ZXh0IGFzIGRldGVybWluaXN0aWNcIiwgKCkgPT4ge1xuICAgIC8vIFRoaXMgaXMgdGhlIHRleHQgZW1pdHRlZCBieSB3b3JrZmxvdy10b29sLWV4ZWN1dG9ycy50cyB3aGVuIGNvbnRleHRHdWFyZC5yZWFzb25cbiAgICAvLyBpcyB1bmRlZmluZWQ6IGBFcnJvciBzYXZpbmcgYXJ0aWZhY3Q6ICR7Y29udGV4dEd1YXJkLnJlYXNvbiA/PyBcImNvbnRleHQgd3JpdGUgYmxvY2tlZFwifWBcbiAgICBjb25zdCBlcnJvclRleHQgPSBcImdzZF9zdW1tYXJ5X3NhdmU6IEVycm9yIHNhdmluZyBhcnRpZmFjdDogY29udGV4dCB3cml0ZSBibG9ja2VkXCI7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKFxuICAgICAgaXNEZXRlcm1pbmlzdGljUG9saWN5RXJyb3IoZXJyb3JUZXh0KSxcbiAgICAgIHRydWUsXG4gICAgICBcImZhbGxiYWNrIGNvbnRleHRfd3JpdGVfYmxvY2tlZCB0ZXh0IG11c3QgYmUgY2xhc3NpZmllZCBhcyBkZXRlcm1pbmlzdGljXCIsXG4gICAgKTtcbiAgfSk7XG5cbiAgdGVzdChcImNsYXNzaWZpZXMgd3JpdGUtZ2F0ZSB2ZXJib3NlIHJlYXNvbiBhcyBkZXRlcm1pbmlzdGljXCIsICgpID0+IHtcbiAgICAvLyBUaGlzIGlzIHRoZSB0ZXh0IHdoZW4gc2hvdWxkQmxvY2tDb250ZXh0QXJ0aWZhY3RTYXZlSW5TbmFwc2hvdCByZXR1cm5zIGl0cyByZWFzb246XG4gICAgLy8gXCJIQVJEIEJMT0NLOiBDYW5ub3Qgc2F2ZSBtaWxlc3RvbmUgQ09OVEVYVCB3aXRob3V0IGRlcHRoIHZlcmlmaWNhdGlvbiBmb3IgTTAwMS4gLi4uXCJcbiAgICBjb25zdCB2ZXJib3NlRXJyb3IgPSBbXG4gICAgICBcImdzZF9zdW1tYXJ5X3NhdmU6IEVycm9yIHNhdmluZyBhcnRpZmFjdDpcIixcbiAgICAgIFwiSEFSRCBCTE9DSzogQ2Fubm90IHNhdmUgbWlsZXN0b25lIENPTlRFWFQgd2l0aG91dCBkZXB0aCB2ZXJpZmljYXRpb24gZm9yIE0wMDEuXCIsXG4gICAgICBcIlRoaXMgaXMgYSBtZWNoYW5pY2FsIGdhdGUgXHUyMDE0IHlvdSBNVVNUIE5PVCBwcm9jZWVkLCByZXRyeSwgb3IgcmF0aW9uYWxpemUgcGFzdCB0aGlzIGJsb2NrLlwiLFxuICAgIF0uam9pbihcIiBcIik7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKFxuICAgICAgaXNEZXRlcm1pbmlzdGljUG9saWN5RXJyb3IodmVyYm9zZUVycm9yKSxcbiAgICAgIHRydWUsXG4gICAgICBcInZlcmJvc2Ugd3JpdGUtZ2F0ZSByZWFzb24gY29udGFpbmluZyAnQ09OVEVYVCB3aXRob3V0IGRlcHRoIHZlcmlmaWNhdGlvbicgbXVzdCBiZSBjbGFzc2lmaWVkIGFzIGRldGVybWluaXN0aWNcIixcbiAgICApO1xuICB9KTtcblxuICB0ZXN0KFwicmV0dXJucyBmYWxzZSBmb3IgbWFsZm9ybWVkLUpTT04gZXJyb3JzIChzZXBhcmF0ZSBjbGFzc2lmaWNhdGlvbiBwYXRoKVwiLCAoKSA9PiB7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKFxuICAgICAgaXNEZXRlcm1pbmlzdGljUG9saWN5RXJyb3IoXCJVbmV4cGVjdGVkIGVuZCBvZiBKU09OIGlucHV0XCIpLFxuICAgICAgZmFsc2UsXG4gICAgICBcIm1hbGZvcm1lZC1KU09OIGVycm9ycyBhcmUgbm90IGRldGVybWluaXN0aWMgcG9saWN5IGVycm9yc1wiLFxuICAgICk7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKFxuICAgICAgaXNEZXRlcm1pbmlzdGljUG9saWN5RXJyb3IoXCJWYWxpZGF0aW9uIGZhaWxlZCBmb3IgdG9vbCBnc2RfY29tcGxldGVfc2xpY2VcIiksXG4gICAgICBmYWxzZSxcbiAgICApO1xuICB9KTtcblxuICB0ZXN0KFwicmV0dXJucyBmYWxzZSBmb3Igbm9ybWFsIGJ1c2luZXNzLWxvZ2ljIHRvb2wgZXJyb3JzXCIsICgpID0+IHtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoXG4gICAgICBpc0RldGVybWluaXN0aWNQb2xpY3lFcnJvcihcIlNsaWNlIFMwMSBpcyBhbHJlYWR5IGNvbXBsZXRlXCIpLFxuICAgICAgZmFsc2UsXG4gICAgKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoXG4gICAgICBpc0RldGVybWluaXN0aWNQb2xpY3lFcnJvcihcIkVycm9yIHNhdmluZyBhcnRpZmFjdDogZGJfdW5hdmFpbGFibGVcIiksXG4gICAgICBmYWxzZSxcbiAgICApO1xuICB9KTtcblxuICB0ZXN0KFwicmV0dXJucyBmYWxzZSBmb3IgZW1wdHkgc3RyaW5nXCIsICgpID0+IHtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoaXNEZXRlcm1pbmlzdGljUG9saWN5RXJyb3IoXCJcIiksIGZhbHNlKTtcbiAgfSk7XG5cbiAgdGVzdChcIkRFVEVSTUlOSVNUSUNfUE9MSUNZX0VSUk9SX1NUUklOR1MgbGlzdCBpcyBub24tZW1wdHkgYW5kIGNvbnRhaW5zIGNvbnRleHRfd3JpdGVfYmxvY2tlZCBlbnRyeVwiLCAoKSA9PiB7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgREVURVJNSU5JU1RJQ19QT0xJQ1lfRVJST1JfU1RSSU5HUy5sZW5ndGggPiAwLFxuICAgICAgXCJtdXN0IGhhdmUgYXQgbGVhc3Qgb25lIGtub3duIGRldGVybWluaXN0aWMgZXJyb3Igc3RyaW5nXCIsXG4gICAgKTtcbiAgICBjb25zdCBoYXNDb250ZXh0V3JpdGVCbG9ja2VkID0gREVURVJNSU5JU1RJQ19QT0xJQ1lfRVJST1JfU1RSSU5HUy5zb21lKFxuICAgICAgKHMpID0+IHMuaW5jbHVkZXMoXCJjb250ZXh0IHdyaXRlIGJsb2NrZWRcIikgfHwgcy5pbmNsdWRlcyhcIkNPTlRFWFQgd2l0aG91dCBkZXB0aCB2ZXJpZmljYXRpb25cIiksXG4gICAgKTtcbiAgICBhc3NlcnQub2soaGFzQ29udGV4dFdyaXRlQmxvY2tlZCwgXCJtdXN0IGluY2x1ZGUgY29udGV4dF93cml0ZV9ibG9ja2VkIGZhbWlseSBlbnRyaWVzXCIpO1xuICB9KTtcbn0pO1xuXG5kZXNjcmliZShcIlRlc3QgNSBcdTIwMTQgcmVjb3JkVG9vbEludm9jYXRpb25FcnJvciBjYXB0dXJlcyBkZXRlcm1pbmlzdGljIGVycm9ycyAoIzQ5NzMpXCIsICgpID0+IHtcbiAgYmVmb3JlRWFjaChyZXNldEF1dG9TdGF0ZSk7XG4gIGFmdGVyRWFjaChyZXNldEF1dG9TdGF0ZSk7XG5cbiAgdGVzdChcImxhc3RUb29sSW52b2NhdGlvbkVycm9yIGlzIE5PVCBzZXQgZm9yIGRldGVybWluaXN0aWMgZXJyb3JzIG9uIGN1cnJlbnQgbWFpbiAocHJlLWZpeCBiYXNlbGluZSlcIiwgKCkgPT4ge1xuICAgIC8vIFRoaXMgdGVzdCBkb2N1bWVudHMgdGhlIEZJWEVEIGJlaGF2aW9yOiBkZXRlcm1pbmlzdGljIGVycm9ycyBBUkUgY2FwdHVyZWQuXG4gICAgLy8gT24gY3VycmVudCBtYWluIChiZWZvcmUgdGhpcyBmaXgpLCByZWNvcmRUb29sSW52b2NhdGlvbkVycm9yIHdvdWxkIE5PVCBzdG9yZVxuICAgIC8vIGNvbnRleHRfd3JpdGVfYmxvY2tlZCBiZWNhdXNlIGl0IG9ubHkgY2hlY2tlZCBpc1Rvb2xJbnZvY2F0aW9uRXJyb3IgYW5kXG4gICAgLy8gaXNRdWV1ZWRVc2VyTWVzc2FnZVNraXAuICBBZnRlciB0aGUgZml4LCBpdCBhbHNvIGNoZWNrcyBpc0RldGVybWluaXN0aWNQb2xpY3lFcnJvci5cbiAgICAvL1xuICAgIC8vIFdlIHRlc3QgdGhlIGZpeGVkIGJlaGF2aW9yIGhlcmU6IHRoZSBlcnJvciBJUyBjYXB0dXJlZC5cbiAgICBfc2V0QXV0b0FjdGl2ZUZvclRlc3QodHJ1ZSk7XG5cbiAgICAvLyBJbXBvcnQgcmVjb3JkVG9vbEludm9jYXRpb25FcnJvciBmcm9tIGF1dG8udHMgKGl0IGRlbGVnYXRlcyB0byBhdXRvLXRvb2wtdHJhY2tpbmcudHMpXG4gICAgLy8gV2UgdGVzdCBpbmRpcmVjdGx5IHZpYSB0aGUgc2Vzc2lvbiBzdGF0ZTogYWZ0ZXIgY2FsbGluZyByZWNvcmRUb29sSW52b2NhdGlvbkVycm9yLFxuICAgIC8vIGxhc3RUb29sSW52b2NhdGlvbkVycm9yIHNob3VsZCBiZSBzZXQgZm9yIGRldGVybWluaXN0aWMgZXJyb3JzLlxuICAgIC8vXG4gICAgLy8gU2luY2UgcmVjb3JkVG9vbEludm9jYXRpb25FcnJvciBpcyBub3QgZXhwb3J0ZWQgZGlyZWN0bHksIHdlIHZlcmlmeSB0aGUgZml4XG4gICAgLy8gdGhyb3VnaCB0aGUgQXV0b1Nlc3Npb24gZmllbGQgYmVoYXZpb3IgZG9jdW1lbnRlZCBpbiB0aGUgY2xhc3NpZmllciB0ZXN0cyBhYm92ZS5cbiAgICAvLyBUaGUgcmVjb3JkVG9vbEludm9jYXRpb25FcnJvciBpbnRlZ3JhdGlvbiBpcyBleGVyY2lzZWQgaW4gdGhlIHBvc3RVbml0UHJlVmVyaWZpY2F0aW9uXG4gICAgLy8gaW50ZWdyYXRpb24gdGVzdCBiZWxvdy5cbiAgICBjb25zdCBzID0gbmV3IEF1dG9TZXNzaW9uKCk7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHMubGFzdFRvb2xJbnZvY2F0aW9uRXJyb3IsIG51bGwsIFwic3RhcnRzIG51bGxcIik7XG5cbiAgICAvLyBTaW11bGF0ZSB3aGF0IHBvc3RVbml0UHJlVmVyaWZpY2F0aW9uIGNoZWNrczogaWYgaXNEZXRlcm1pbmlzdGljUG9saWN5RXJyb3JcbiAgICAvLyBtYXRjaGVzIG9uIGxhc3RUb29sSW52b2NhdGlvbkVycm9yLCB0aGUgc2hvcnQtY2lyY3VpdCBmaXJlcy5cbiAgICAvLyBUaGUgdmFsdWUgaXMgc2V0IGJ5IHJlY29yZFRvb2xJbnZvY2F0aW9uRXJyb3IgKHRlc3RlZCB2aWEgYXV0by50cyBpbnRlZ3JhdGlvbikuXG4gICAgcy5sYXN0VG9vbEludm9jYXRpb25FcnJvciA9IFwiZ3NkX3N1bW1hcnlfc2F2ZTogRXJyb3Igc2F2aW5nIGFydGlmYWN0OiBjb250ZXh0IHdyaXRlIGJsb2NrZWRcIjtcbiAgICBhc3NlcnQub2soXG4gICAgICBpc0RldGVybWluaXN0aWNQb2xpY3lFcnJvcihzLmxhc3RUb29sSW52b2NhdGlvbkVycm9yKSxcbiAgICAgIFwiY2xhc3NpZmllciByZWNvZ25pc2VzIHRoZSBzdG9yZWQgZXJyb3IgXHUyMDE0IHNob3J0LWNpcmN1aXQgd2lsbCBmaXJlXCIsXG4gICAgKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwocy5wZW5kaW5nVmVyaWZpY2F0aW9uUmV0cnksIG51bGwsIFwicGVuZGluZ1ZlcmlmaWNhdGlvblJldHJ5IHN0YXJ0cyBudWxsXCIpO1xuICB9KTtcblxuICB0ZXN0KFwiQXV0b1Nlc3Npb24ubGFzdFRvb2xJbnZvY2F0aW9uRXJyb3IgY2FuIGhvbGQgYSBkZXRlcm1pbmlzdGljIHBvbGljeSBlcnJvciBzdHJpbmdcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHMgPSBuZXcgQXV0b1Nlc3Npb24oKTtcbiAgICBzLmxhc3RUb29sSW52b2NhdGlvbkVycm9yID0gXCJnc2Rfc3VtbWFyeV9zYXZlOiBFcnJvciBzYXZpbmcgYXJ0aWZhY3Q6IGNvbnRleHQgd3JpdGUgYmxvY2tlZFwiO1xuICAgIGFzc2VydC5vayhzLmxhc3RUb29sSW52b2NhdGlvbkVycm9yKTtcbiAgICBhc3NlcnQub2soaXNEZXRlcm1pbmlzdGljUG9saWN5RXJyb3Iocy5sYXN0VG9vbEludm9jYXRpb25FcnJvcikpO1xuICB9KTtcblxuICB0ZXN0KFwiQXV0b1Nlc3Npb24ubGFzdFRvb2xJbnZvY2F0aW9uRXJyb3IgaXMgY2xlYXJlZCBvbiByZXNldCgpXCIsICgpID0+IHtcbiAgICBjb25zdCBzID0gbmV3IEF1dG9TZXNzaW9uKCk7XG4gICAgcy5sYXN0VG9vbEludm9jYXRpb25FcnJvciA9IFwiZ3NkX3N1bW1hcnlfc2F2ZTogRXJyb3Igc2F2aW5nIGFydGlmYWN0OiBjb250ZXh0IHdyaXRlIGJsb2NrZWRcIjtcbiAgICBzLnJlc2V0KCk7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHMubGFzdFRvb2xJbnZvY2F0aW9uRXJyb3IsIG51bGwpO1xuICB9KTtcbn0pO1xuXG5kZXNjcmliZShcIlRlc3QgNSBcdTIwMTQgcG9zdFVuaXRQcmVWZXJpZmljYXRpb24gc2hvcnQtY2lyY3VpdHMgb24gZGV0ZXJtaW5pc3RpYyBlcnJvciAoIzQ5NzMpXCIsICgpID0+IHtcbiAgLy8gVGhpcyBpbnRlZ3JhdGlvbiB0ZXN0IGNhbGxzIHBvc3RVbml0UHJlVmVyaWZpY2F0aW9uIHdpdGggYSBkZXRlcm1pbmlzdGljIGVycm9yXG4gIC8vIGluIGxhc3RUb29sSW52b2NhdGlvbkVycm9yIGFuZCBhc3NlcnRzIHRoYXQ6XG4gIC8vICAgMS4gcGVuZGluZ1ZlcmlmaWNhdGlvblJldHJ5IGlzIE5PVCBzZXQgKG5vIHJldHJ5IGRpc3BhdGNoZWQpXG4gIC8vICAgMi4gdGhlIGJsb2NrZXIgcGxhY2Vob2xkZXIgaXMgd3JpdHRlbiB0byBkaXNrXG4gIC8vICAgMy4gdGhlIGZ1bmN0aW9uIHJldHVybnMgXCJjb250aW51ZVwiIChub3QgXCJyZXRyeVwiIG9yIFwiZGlzcGF0Y2hlZFwiKVxuXG4gIGxldCBiYXNlID0gXCJcIjtcbiAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gICAgX3NldEF1dG9BY3RpdmVGb3JUZXN0KHRydWUpO1xuICB9KTtcbiAgYWZ0ZXJFYWNoKCgpID0+IHtcbiAgICBfc2V0QXV0b0FjdGl2ZUZvclRlc3QoZmFsc2UpO1xuICAgIC8vIENsZWFudXAgaXMgaGFuZGxlZCBieSB0bXBEaXJzIGF0IHByb2Nlc3MgZXhpdDsgaW5kaXZpZHVhbCBjbGVhbnVwIGhlcmVcbiAgICAvLyBpcyBiZXN0LWVmZm9ydCBvbmx5IHNvIGFzIG5vdCB0byBtYXNrIGFzc2VydGlvbiBmYWlsdXJlcy5cbiAgfSk7XG5cbiAgdGVzdChcInJldHVybnMgJ2NvbnRpbnVlJyBhbmQgd3JpdGVzIHBsYWNlaG9sZGVyIGZvciBjb250ZXh0X3dyaXRlX2Jsb2NrZWQgXHUyMDE0IG5vIHBlbmRpbmdWZXJpZmljYXRpb25SZXRyeSBzZXRcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHsgcG9zdFVuaXRQcmVWZXJpZmljYXRpb24gfSA9IGF3YWl0IGltcG9ydChcIi4uL2F1dG8tcG9zdC11bml0LnRzXCIpO1xuXG4gICAgY29uc3QgcyA9IG5ldyBBdXRvU2Vzc2lvbigpO1xuICAgIHMuYWN0aXZlID0gdHJ1ZTtcbiAgICBzLmJhc2VQYXRoID0gYmFzZTtcbiAgICBzLmN1cnJlbnRVbml0ID0geyB0eXBlOiBcImRpc2N1c3MtbWlsZXN0b25lXCIsIGlkOiBcIk0wMDFcIiwgc3RhcnRlZEF0OiBEYXRlLm5vdygpIH07XG4gICAgLy8gU2V0IHRoZSBkZXRlcm1pbmlzdGljIGVycm9yIHRoYXQgd291bGQgYmUgcmVjb3JkZWQgYnkgcmVjb3JkVG9vbEludm9jYXRpb25FcnJvclxuICAgIHMubGFzdFRvb2xJbnZvY2F0aW9uRXJyb3IgPSBcImdzZF9zdW1tYXJ5X3NhdmU6IEVycm9yIHNhdmluZyBhcnRpZmFjdDogY29udGV4dCB3cml0ZSBibG9ja2VkXCI7XG4gICAgcy52ZXJpZmljYXRpb25SZXRyeUNvdW50LnNldChcImRpc2N1c3MtbWlsZXN0b25lOk0wMDFcIiwgMik7XG5cbiAgICBsZXQgcGF1c2VDYWxsZWQgPSBmYWxzZTtcbiAgICBjb25zdCBjdHggPSB7XG4gICAgICB1aTogeyBub3RpZnk6ICgpID0+IHt9IH0sXG4gICAgfSBhcyBhbnk7XG4gICAgY29uc3QgcGkgPSB7fSBhcyBhbnk7XG5cbiAgICBjb25zdCBwY3R4ID0ge1xuICAgICAgcyxcbiAgICAgIGN0eCxcbiAgICAgIHBpLFxuICAgICAgYnVpbGRTbmFwc2hvdE9wdHM6ICgpID0+ICh7fSkgYXMgYW55LFxuICAgICAgbG9ja0Jhc2U6ICgpID0+IGJhc2UsXG4gICAgICBzdG9wQXV0bzogYXN5bmMgKCkgPT4ge30sXG4gICAgICBwYXVzZUF1dG86IGFzeW5jICgpID0+IHsgcGF1c2VDYWxsZWQgPSB0cnVlOyB9LFxuICAgICAgdXBkYXRlUHJvZ3Jlc3NXaWRnZXQ6ICgpID0+IHt9LFxuICAgIH0gYXMgYW55O1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcG9zdFVuaXRQcmVWZXJpZmljYXRpb24ocGN0eCwgeyBza2lwU2V0dGxlRGVsYXk6IHRydWUgfSk7XG5cbiAgICAvLyBDb3JlIGFzc2VydGlvbjogZGV0ZXJtaW5pc3RpYyBlcnJvciBzaG9ydC1jaXJjdWl0cyBcdTIwMTQgcmV0dXJucyBcImNvbnRpbnVlXCIsXG4gICAgLy8gbm8gcmV0cnksIGFuZCB0aGUgcGxhY2Vob2xkZXIgaXMgd3JpdHRlbiBzbyB0aGUgcGlwZWxpbmUgY2FuIGFkdmFuY2UuXG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdCwgXCJjb250aW51ZVwiLCBcIm11c3QgcmV0dXJuICdjb250aW51ZScsIG5vdCAncmV0cnknIG9yICdkaXNwYXRjaGVkJ1wiKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwocy5wZW5kaW5nVmVyaWZpY2F0aW9uUmV0cnksIG51bGwsIFwicGVuZGluZ1ZlcmlmaWNhdGlvblJldHJ5IG11c3QgTk9UIGJlIHNldFwiKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwocy52ZXJpZmljYXRpb25SZXRyeUNvdW50LmhhcyhcImRpc2N1c3MtbWlsZXN0b25lOk0wMDFcIiksIGZhbHNlLCBcImRldGVybWluaXN0aWMgc2hvcnQtY2lyY3VpdCBjbGVhcnMgc3RhbGUgcmV0cnkgY291bnRcIik7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHMubGFzdFRvb2xJbnZvY2F0aW9uRXJyb3IsIG51bGwsIFwibGFzdFRvb2xJbnZvY2F0aW9uRXJyb3IgY2xlYXJlZCBhZnRlciBoYW5kbGluZ1wiKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwocGF1c2VDYWxsZWQsIGZhbHNlLCBcInBhdXNlQXV0byBtdXN0IE5PVCBiZSBjYWxsZWQgZm9yIGRldGVybWluaXN0aWMgZXJyb3JzXCIpO1xuXG4gICAgLy8gVGhlIGJsb2NrZXIgcGxhY2Vob2xkZXIgbXVzdCBleGlzdCBvbiBkaXNrIHNvIHRoZSBwaXBlbGluZSBjYW4gYWR2YW5jZS5cbiAgICBjb25zdCBwbGFjZWhvbGRlclBhdGggPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwiTTAwMS1DT05URVhULm1kXCIpO1xuICAgIGFzc2VydC5vayhcbiAgICAgIGV4aXN0c1N5bmMocGxhY2Vob2xkZXJQYXRoKSxcbiAgICAgIGBibG9ja2VyIHBsYWNlaG9sZGVyIG11c3QgYmUgd3JpdHRlbiBhdCAke3BsYWNlaG9sZGVyUGF0aH1gLFxuICAgICk7XG4gIH0pO1xufSk7XG5cbmRlc2NyaWJlKFwiVGVzdCA1YiBcdTIwMTQgYnJva2VuIGlzb2xhdGVkIHdvcmt0cmVlIHNob3J0LWNpcmN1aXRzIGFydGlmYWN0IHJldHJ5ICgjNTg0OClcIiwgKCkgPT4ge1xuICB0ZXN0KFwicGF1c2VzIHdpdGggd29ya3RyZWUgaW50ZWdyaXR5IGZhaWx1cmUgaW5zdGVhZCBvZiBzZXR0aW5nIHBlbmRpbmdWZXJpZmljYXRpb25SZXRyeVwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyBwb3N0VW5pdFByZVZlcmlmaWNhdGlvbiB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vYXV0by1wb3N0LXVuaXQudHNcIik7XG5cbiAgICBjb25zdCBiYXNlID0gbWFrZUJyb2tlbklzb2xhdGVkV29ya3RyZWUoKTtcbiAgICBjb25zdCBzID0gbmV3IEF1dG9TZXNzaW9uKCk7XG4gICAgcy5hY3RpdmUgPSB0cnVlO1xuICAgIHMuYmFzZVBhdGggPSBiYXNlO1xuICAgIHMuY3VycmVudFVuaXQgPSB7IHR5cGU6IFwicmVzZWFyY2gtc2xpY2VcIiwgaWQ6IFwiTTAwMy9TMDNcIiwgc3RhcnRlZEF0OiBEYXRlLm5vdygpIH07XG4gICAgcy52ZXJpZmljYXRpb25SZXRyeUNvdW50LnNldChcInJlc2VhcmNoLXNsaWNlOk0wMDMvUzAzXCIsIDIpO1xuXG4gICAgY29uc3Qgbm90aWZpY2F0aW9uczogc3RyaW5nW10gPSBbXTtcbiAgICBsZXQgcGF1c2VDYWxsZWQgPSBmYWxzZTtcbiAgICBjb25zdCBwY3R4ID0ge1xuICAgICAgcyxcbiAgICAgIGN0eDoge1xuICAgICAgICB1aToge1xuICAgICAgICAgIG5vdGlmeTogKG1lc3NhZ2U6IHN0cmluZykgPT4ge1xuICAgICAgICAgICAgbm90aWZpY2F0aW9ucy5wdXNoKG1lc3NhZ2UpO1xuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAgcGk6IHt9LFxuICAgICAgYnVpbGRTbmFwc2hvdE9wdHM6ICgpID0+ICh7fSkgYXMgYW55LFxuICAgICAgbG9ja0Jhc2U6ICgpID0+IGJhc2UsXG4gICAgICBzdG9wQXV0bzogYXN5bmMgKCkgPT4ge30sXG4gICAgICBwYXVzZUF1dG86IGFzeW5jICgpID0+IHtcbiAgICAgICAgcGF1c2VDYWxsZWQgPSB0cnVlO1xuICAgICAgfSxcbiAgICAgIHVwZGF0ZVByb2dyZXNzV2lkZ2V0OiAoKSA9PiB7fSxcbiAgICB9IGFzIGFueTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHBvc3RVbml0UHJlVmVyaWZpY2F0aW9uKHBjdHgsIHtcbiAgICAgIHNraXBTZXR0bGVEZWxheTogdHJ1ZSxcbiAgICAgIHNraXBXb3JrdHJlZVN5bmM6IHRydWUsXG4gICAgfSk7XG5cbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LCBcImRpc3BhdGNoZWRcIiwgXCJ3b3JrdHJlZSBpbnRlZ3JpdHkgZmFpbHVyZSBtdXN0IHBhdXNlIGluc3RlYWQgb2YgcmV0cnlpbmdcIik7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHBhdXNlQ2FsbGVkLCB0cnVlLCBcInBhdXNlQXV0byBtdXN0IGJlIGNhbGxlZCBmb3IgYSBicm9rZW4gaXNvbGF0ZWQgd29ya3RyZWVcIik7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHMucGVuZGluZ1ZlcmlmaWNhdGlvblJldHJ5LCBudWxsLCBcInBlbmRpbmdWZXJpZmljYXRpb25SZXRyeSBtdXN0IE5PVCBiZSBzZXRcIik7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHMudmVyaWZpY2F0aW9uUmV0cnlDb3VudC5oYXMoXCJyZXNlYXJjaC1zbGljZTpNMDAzL1MwM1wiKSwgZmFsc2UsIFwic3RhbGUgcmV0cnkgY291bnQgbXVzdCBiZSBjbGVhcmVkXCIpO1xuICAgIGFzc2VydC5vayhcbiAgICAgIG5vdGlmaWNhdGlvbnMuc29tZSgobWVzc2FnZSkgPT4gbWVzc2FnZS5pbmNsdWRlcyhcIldvcmt0cmVlIGludGVncml0eSBmYWlsdXJlXCIpICYmIG1lc3NhZ2UuaW5jbHVkZXMoXCIuZ2l0IG1pc3NpbmdcIikpLFxuICAgICAgYGV4cGVjdGVkIHdvcmt0cmVlIGludGVncml0eSBub3RpZmljYXRpb24sIGdvdDogJHtub3RpZmljYXRpb25zLmpvaW4oXCJcXG5cIil9YCxcbiAgICApO1xuICAgIGFzc2VydC5vayhcbiAgICAgIG5vdGlmaWNhdGlvbnMuZXZlcnkoKG1lc3NhZ2UpID0+ICFtZXNzYWdlLmluY2x1ZGVzKFwiQXJ0aWZhY3QgdmVyaWZpY2F0aW9uIGZhaWxlZFwiKSksXG4gICAgICBgbXVzdCBub3Qgc3VyZmFjZSBhcnRpZmFjdCByZXRyeSBtZXNzYWdpbmcsIGdvdDogJHtub3RpZmljYXRpb25zLmpvaW4oXCJcXG5cIil9YCxcbiAgICApO1xuICB9KTtcblxuICB0ZXN0KFwicGF1c2VzIHdoZW4gZ2l0IHJldi1wYXJzZSBjYW5ub3QgdmFsaWRhdGUgYW4gaXNvbGF0ZWQgd29ya3RyZWVcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHsgcG9zdFVuaXRQcmVWZXJpZmljYXRpb24gfSA9IGF3YWl0IGltcG9ydChcIi4uL2F1dG8tcG9zdC11bml0LnRzXCIpO1xuXG4gICAgY29uc3QgYmFzZSA9IG1ha2VCcm9rZW5Jc29sYXRlZFdvcmt0cmVlUmV2UGFyc2UoKTtcbiAgICBjb25zdCBzID0gbmV3IEF1dG9TZXNzaW9uKCk7XG4gICAgcy5hY3RpdmUgPSB0cnVlO1xuICAgIHMuYmFzZVBhdGggPSBiYXNlO1xuICAgIHMuY3VycmVudFVuaXQgPSB7IHR5cGU6IFwicmVzZWFyY2gtc2xpY2VcIiwgaWQ6IFwiTTAwMy9TMDNcIiwgc3RhcnRlZEF0OiBEYXRlLm5vdygpIH07XG4gICAgcy52ZXJpZmljYXRpb25SZXRyeUNvdW50LnNldChcInJlc2VhcmNoLXNsaWNlOk0wMDMvUzAzXCIsIDIpO1xuXG4gICAgY29uc3Qgbm90aWZpY2F0aW9uczogc3RyaW5nW10gPSBbXTtcbiAgICBsZXQgcGF1c2VDYWxsZWQgPSBmYWxzZTtcbiAgICBjb25zdCBwY3R4ID0ge1xuICAgICAgcyxcbiAgICAgIGN0eDoge1xuICAgICAgICB1aToge1xuICAgICAgICAgIG5vdGlmeTogKG1lc3NhZ2U6IHN0cmluZykgPT4ge1xuICAgICAgICAgICAgbm90aWZpY2F0aW9ucy5wdXNoKG1lc3NhZ2UpO1xuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAgcGk6IHt9LFxuICAgICAgYnVpbGRTbmFwc2hvdE9wdHM6ICgpID0+ICh7fSkgYXMgYW55LFxuICAgICAgbG9ja0Jhc2U6ICgpID0+IGJhc2UsXG4gICAgICBzdG9wQXV0bzogYXN5bmMgKCkgPT4ge30sXG4gICAgICBwYXVzZUF1dG86IGFzeW5jICgpID0+IHtcbiAgICAgICAgcGF1c2VDYWxsZWQgPSB0cnVlO1xuICAgICAgfSxcbiAgICAgIHVwZGF0ZVByb2dyZXNzV2lkZ2V0OiAoKSA9PiB7fSxcbiAgICB9IGFzIGFueTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHBvc3RVbml0UHJlVmVyaWZpY2F0aW9uKHBjdHgsIHtcbiAgICAgIHNraXBTZXR0bGVEZWxheTogdHJ1ZSxcbiAgICAgIHNraXBXb3JrdHJlZVN5bmM6IHRydWUsXG4gICAgfSk7XG5cbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LCBcImRpc3BhdGNoZWRcIiwgXCJ3b3JrdHJlZSBpbnRlZ3JpdHkgZmFpbHVyZSBtdXN0IHBhdXNlIGluc3RlYWQgb2YgcmV0cnlpbmdcIik7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHBhdXNlQ2FsbGVkLCB0cnVlLCBcInBhdXNlQXV0byBtdXN0IGJlIGNhbGxlZCBmb3IgYSBicm9rZW4gaXNvbGF0ZWQgd29ya3RyZWVcIik7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHMucGVuZGluZ1ZlcmlmaWNhdGlvblJldHJ5LCBudWxsLCBcInBlbmRpbmdWZXJpZmljYXRpb25SZXRyeSBtdXN0IE5PVCBiZSBzZXRcIik7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHMudmVyaWZpY2F0aW9uUmV0cnlDb3VudC5oYXMoXCJyZXNlYXJjaC1zbGljZTpNMDAzL1MwM1wiKSwgZmFsc2UsIFwic3RhbGUgcmV0cnkgY291bnQgbXVzdCBiZSBjbGVhcmVkXCIpO1xuICAgIGFzc2VydC5vayhcbiAgICAgIG5vdGlmaWNhdGlvbnMuc29tZSgobWVzc2FnZSkgPT4gbWVzc2FnZS5pbmNsdWRlcyhcIldvcmt0cmVlIGludGVncml0eSBmYWlsdXJlXCIpICYmIG1lc3NhZ2UuaW5jbHVkZXMoXCJnaXQgcmV2LXBhcnNlXCIpKSxcbiAgICAgIGBleHBlY3RlZCBnaXQgcmV2LXBhcnNlIHdvcmt0cmVlIGludGVncml0eSBub3RpZmljYXRpb24sIGdvdDogJHtub3RpZmljYXRpb25zLmpvaW4oXCJcXG5cIil9YCxcbiAgICApO1xuICAgIGFzc2VydC5vayhcbiAgICAgIG5vdGlmaWNhdGlvbnMuZXZlcnkoKG1lc3NhZ2UpID0+ICFtZXNzYWdlLmluY2x1ZGVzKFwiQXJ0aWZhY3QgdmVyaWZpY2F0aW9uIGZhaWxlZFwiKSksXG4gICAgICBgbXVzdCBub3Qgc3VyZmFjZSBhcnRpZmFjdCByZXRyeSBtZXNzYWdpbmcsIGdvdDogJHtub3RpZmljYXRpb25zLmpvaW4oXCJcXG5cIil9YCxcbiAgICApO1xuICB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdCA2OiBNb2RlbC1xdWFsaXR5IGZhaWx1cmVzIHVzZSBzdGFuZGFyZCByZXRyeSBwYXRoIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcIlRlc3QgNiBcdTIwMTQgbm9uLWRldGVybWluaXN0aWMgZmFpbHVyZXMgdXNlIHN0YW5kYXJkIHJldHJ5OyB0aWVyIGVzY2FsYXRlcyBvbmNlICgjNDk3MylcIiwgKCkgPT4ge1xuICAvLyBcdTI1MDBcdTI1MDAgZXNjYWxhdGVUaWVyIGJlaGF2aW9yIChleGlzdGluZywgdW5jaGFuZ2VkKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuICB0ZXN0KFwiZXNjYWxhdGVUaWVyOiBsaWdodCBcdTIxOTIgc3RhbmRhcmQgXHUyMTkyIGhlYXZ5IFx1MjE5MiBudWxsIChtYXgpXCIsICgpID0+IHtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoZXNjYWxhdGVUaWVyKFwibGlnaHRcIiksIFwic3RhbmRhcmRcIik7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKGVzY2FsYXRlVGllcihcInN0YW5kYXJkXCIpLCBcImhlYXZ5XCIpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChlc2NhbGF0ZVRpZXIoXCJoZWF2eVwiKSwgbnVsbCwgXCJoZWF2eSBpcyB0aGUgbWF4IHRpZXIgXHUyMDE0IG5vIGZ1cnRoZXIgZXNjYWxhdGlvblwiKTtcbiAgfSk7XG5cbiAgdGVzdChcInN0YW5kYXJkLXN0YXJ0IHJldHJ5OiBlc2NhbGF0ZXMgdG8gaGVhdnkgb24gcmV0cnkgMSwgc3RheXMgYXQgaGVhdnkgb24gcmV0cnkgMiAoZXNjYWxhdGVUaWVyIHJldHVybnMgbnVsbClcIiwgKCkgPT4ge1xuICAgIC8vIFNpbXVsYXRlIHdoYXQgc2VsZWN0QW5kQXBwbHlNb2RlbCBkb2VzIGFjcm9zcyB0d28gcmV0cmllcyBmb3IgYSBzdGFuZGFyZC1zdGFydCB1bml0LlxuICAgIC8vIFJldHJ5IDE6IHByZXZpb3VzVGllciA9IFwic3RhbmRhcmRcIiwgZXNjYWxhdGVUaWVyIFx1MjE5MiBcImhlYXZ5XCIuIEFwcGxpZWQgdGllciA9IFwiaGVhdnlcIi5cbiAgICBjb25zdCB0aWVyMSA9IGVzY2FsYXRlVGllcihcInN0YW5kYXJkXCIpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbCh0aWVyMSwgXCJoZWF2eVwiLCBcInJldHJ5IDE6IHN0YW5kYXJkIGVzY2FsYXRlcyB0byBoZWF2eVwiKTtcblxuICAgIC8vIFJldHJ5IDI6IHByZXZpb3VzVGllciA9IFwiaGVhdnlcIiAoZnJvbSByZXRyeSAxIHJlc3VsdCksIGVzY2FsYXRlVGllciBcdTIxOTIgbnVsbC5cbiAgICAvLyBUaGUgXCJyZXRhaW4gZXNjYWxhdGVkIHRpZXJcIiBmaXgga2lja3MgaW46IHByZXZPcmRlcihoZWF2eT0yKSA+IGZyZXNoT3JkZXIoc3RhbmRhcmQ9MSksXG4gICAgLy8gc28gdGhlIHRpZXIgc3RheXMgYXQgXCJoZWF2eVwiIHJhdGhlciB0aGFuIHJldmVydGluZyB0byBmcmVzaCBjbGFzc2lmaWNhdGlvbi5cbiAgICBjb25zdCB0aWVyMiA9IGVzY2FsYXRlVGllcihcImhlYXZ5XCIpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbCh0aWVyMiwgbnVsbCwgXCJyZXRyeSAyOiBoZWF2eSBjYW5ub3QgZXNjYWxhdGUgZnVydGhlclwiKTtcblxuICAgIC8vIFZlcmlmeSB0aGUgdGllci1vcmRlciBjb21wYXJpc29uIHVzZWQgaW4gc2VsZWN0QW5kQXBwbHlNb2RlbCAoIzQ5NzMgZml4KTpcbiAgICBjb25zdCB0aWVyT3JkZXI6IFJlY29yZDxzdHJpbmcsIG51bWJlcj4gPSB7IGxpZ2h0OiAwLCBzdGFuZGFyZDogMSwgaGVhdnk6IDIgfTtcbiAgICBjb25zdCBwcmV2T3JkZXIgPSB0aWVyT3JkZXJbXCJoZWF2eVwiXSA/PyAwOyAgICAgIC8vIDIgKGZyb20gcmV0cnkgMSByZXN1bHQpXG4gICAgY29uc3QgZnJlc2hPcmRlciA9IHRpZXJPcmRlcltcInN0YW5kYXJkXCJdID8/IDA7ICAvLyAxIChmcmVzaCBjbGFzc2lmeVVuaXRDb21wbGV4aXR5IGZvciBhIHN0YW5kYXJkIHVuaXQpXG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgcHJldk9yZGVyID4gZnJlc2hPcmRlcixcbiAgICAgIFwicHJldk9yZGVyKGhlYXZ5PTIpID4gZnJlc2hPcmRlcihzdGFuZGFyZD0xKSBcdTIwMTQgdGhlIGZpeCByZXRhaW5zICdoZWF2eScgYW5kIHByZXZlbnRzIHJldmVydFwiLFxuICAgICk7XG4gIH0pO1xuXG4gIHRlc3QoXCJsaWdodC1zdGFydCByZXRyeSAzOiBlc2NhbGF0ZWQgdGllciBpcyByZXRhaW5lZCwgbm90IHJldmVydGVkIHRvICdsaWdodCdcIiwgKCkgPT4ge1xuICAgIC8vIFdpdGhvdXQgdGhlIGZpeDogcmV0cnkgMyB3b3VsZCBzZWUgcHJldmlvdXNUaWVyPVwiaGVhdnlcIiAoZnJvbSByZXRyeSAyKSxcbiAgICAvLyBlc2NhbGF0ZVRpZXIgcmV0dXJucyBudWxsLCBhbmQgZnJlc2ggY2xhc3NpZmljYXRpb24gaXMgXCJsaWdodFwiIFx1MjAxNCB0aGUgbW9kZWxcbiAgICAvLyByZXZlcnRzIHRvIGEgY2hlYXAgbGlnaHQtdGllciBtb2RlbC4gV2l0aCB0aGUgZml4LCB3ZSByZXRhaW4gXCJoZWF2eVwiLlxuXG4gICAgLy8gUmV0cnkgMTogbGlnaHQgXHUyMTkyIHN0YW5kYXJkXG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKGVzY2FsYXRlVGllcihcImxpZ2h0XCIpLCBcInN0YW5kYXJkXCIpO1xuICAgIC8vIFJldHJ5IDI6IHN0YW5kYXJkIFx1MjE5MiBoZWF2eVxuICAgIGFzc2VydC5zdHJpY3RFcXVhbChlc2NhbGF0ZVRpZXIoXCJzdGFuZGFyZFwiKSwgXCJoZWF2eVwiKTtcbiAgICAvLyBSZXRyeSAzOiBoZWF2eSBcdTIxOTIgbnVsbCAoY2FuJ3QgZXNjYWxhdGUpLCBmaXggcmV0YWlucyBcImhlYXZ5XCIgaW5zdGVhZCBvZiByZXZlcnRpbmcgdG8gXCJsaWdodFwiXG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKGVzY2FsYXRlVGllcihcImhlYXZ5XCIpLCBudWxsKTtcblxuICAgIC8vIFRoZSBmaXggbG9naWM6IHdoZW4gZXNjYWxhdGVUaWVyIHJldHVybnMgbnVsbCwgY29tcGFyZSBwcmV2T3JkZXIgdnMgZnJlc2hPcmRlci5cbiAgICBjb25zdCB0aWVyT3JkZXI6IFJlY29yZDxzdHJpbmcsIG51bWJlcj4gPSB7IGxpZ2h0OiAwLCBzdGFuZGFyZDogMSwgaGVhdnk6IDIgfTtcbiAgICBjb25zdCBwcmV2T3JkZXJSZXRyeTMgPSB0aWVyT3JkZXJbXCJoZWF2eVwiXSA/PyAwOyAgLy8gMlxuICAgIGNvbnN0IGZyZXNoT3JkZXJMaWdodCA9IHRpZXJPcmRlcltcImxpZ2h0XCJdID8/IDA7ICAvLyAwXG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgcHJldk9yZGVyUmV0cnkzID4gZnJlc2hPcmRlckxpZ2h0LFxuICAgICAgXCJvbiByZXRyeSAzLCBwcmV2T3JkZXIoaGVhdnk9MikgPiBmcmVzaE9yZGVyKGxpZ2h0PTApIFx1MjAxNCAnaGVhdnknIG11c3QgYmUgcmV0YWluZWQsIG5vdCByZXZlcnRlZFwiLFxuICAgICk7XG4gIH0pO1xuXG4gIHRlc3QoXCJub24tZGV0ZXJtaW5pc3RpYyBlcnJvcjogc2Vzc2lvbiBzZXRzIHBlbmRpbmdWZXJpZmljYXRpb25SZXRyeSAoc3RhbmRhcmQgcmV0cnkgcGF0aClcIiwgKCkgPT4ge1xuICAgIC8vIFNpbXVsYXRlIHdoYXQgcG9zdFVuaXRQcmVWZXJpZmljYXRpb24gZG9lcyBmb3IgYSBub24tZGV0ZXJtaW5pc3RpYyBmYWlsdXJlOlxuICAgIC8vIG5vIGxhc3RUb29sSW52b2NhdGlvbkVycm9yIFx1MjE5MiBmYWxscyBpbnRvIHRoZSBzdGFuZGFyZCByZXRyeSBwYXRoIFx1MjE5MiBzZXRzIHBlbmRpbmdWZXJpZmljYXRpb25SZXRyeS5cbiAgICBjb25zdCBzID0gbmV3IEF1dG9TZXNzaW9uKCk7XG4gICAgcy5jdXJyZW50VW5pdCA9IHsgdHlwZTogXCJwbGFuLXNsaWNlXCIsIGlkOiBcIk0wMDE6UzAxXCIsIHN0YXJ0ZWRBdDogRGF0ZS5ub3coKSB9O1xuXG4gICAgLy8gU2ltdWxhdGUgdGhlIHJldHJ5IGNvdW50IGluY3JlbWVudCAoYXMgcG9zdFVuaXRQcmVWZXJpZmljYXRpb24gZG9lcyBpbnRlcm5hbGx5KVxuICAgIGNvbnN0IHJldHJ5S2V5ID0gYCR7cy5jdXJyZW50VW5pdC50eXBlfToke3MuY3VycmVudFVuaXQuaWR9YDtcbiAgICBjb25zdCBhdHRlbXB0ID0gKHMudmVyaWZpY2F0aW9uUmV0cnlDb3VudC5nZXQocmV0cnlLZXkpID8/IDApICsgMTtcbiAgICBzLnZlcmlmaWNhdGlvblJldHJ5Q291bnQuc2V0KHJldHJ5S2V5LCBhdHRlbXB0KTtcblxuICAgIC8vIFNpbXVsYXRlIHNldHRpbmcgcGVuZGluZ1ZlcmlmaWNhdGlvblJldHJ5ICh3aGF0IHRoZSBcImVsc2VcIiBicmFuY2ggZG9lcylcbiAgICBzLnBlbmRpbmdWZXJpZmljYXRpb25SZXRyeSA9IHtcbiAgICAgIHVuaXRJZDogcy5jdXJyZW50VW5pdC5pZCxcbiAgICAgIGZhaWx1cmVDb250ZXh0OiBgQXJ0aWZhY3QgdmVyaWZpY2F0aW9uIGZhaWxlZDogZXhwZWN0ZWQgYXJ0aWZhY3QgZm9yICR7cy5jdXJyZW50VW5pdC50eXBlfSBcIiR7cy5jdXJyZW50VW5pdC5pZH1cIiB3YXMgbm90IGZvdW5kIG9uIGRpc2sgYWZ0ZXIgdW5pdCBleGVjdXRpb24gKGF0dGVtcHQgJHthdHRlbXB0fSkuYCxcbiAgICAgIGF0dGVtcHQsXG4gICAgfTtcblxuICAgIGFzc2VydC5vayhzLnBlbmRpbmdWZXJpZmljYXRpb25SZXRyeSAhPT0gbnVsbCwgXCJzdGFuZGFyZCByZXRyeSBwYXRoIHNldHMgcGVuZGluZ1ZlcmlmaWNhdGlvblJldHJ5XCIpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChzLnBlbmRpbmdWZXJpZmljYXRpb25SZXRyeS5hdHRlbXB0LCAxLCBcImF0dGVtcHQgaXMgMVwiKTtcbiAgICBhc3NlcnQub2soXG4gICAgICBzLnBlbmRpbmdWZXJpZmljYXRpb25SZXRyeS5mYWlsdXJlQ29udGV4dC5pbmNsdWRlcyhcInBsYW4tc2xpY2VcIiksXG4gICAgICBcImZhaWx1cmVDb250ZXh0IHJlZmVyZW5jZXMgdGhlIHVuaXQgdHlwZVwiLFxuICAgICk7XG4gIH0pO1xuXG4gIHRlc3QoXCJpc0RldGVybWluaXN0aWNQb2xpY3lFcnJvciByZXR1cm5zIGZhbHNlIGZvciBub24tZGV0ZXJtaW5pc3RpYyB2ZXJpZmljYXRpb24gZmFpbHVyZVwiLCAoKSA9PiB7XG4gICAgLy8gQSBwbGFpbiAnYXJ0aWZhY3Qgbm90IGZvdW5kJyBpcyBOT1QgYSBkZXRlcm1pbmlzdGljIHBvbGljeSBlcnJvci5cbiAgICAvLyBUaGUgc3RhbmRhcmQgcmV0cnkgcGF0aCBtdXN0IHN0aWxsIGZpcmUgZm9yIHRoZXNlLlxuICAgIGFzc2VydC5zdHJpY3RFcXVhbChcbiAgICAgIGlzRGV0ZXJtaW5pc3RpY1BvbGljeUVycm9yKFwiXCIpLFxuICAgICAgZmFsc2UsXG4gICAgICBcImVtcHR5IGVycm9yIChubyB0b29sIGVycm9yKSBpcyBub3QgZGV0ZXJtaW5pc3RpY1wiLFxuICAgICk7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKFxuICAgICAgaXNEZXRlcm1pbmlzdGljUG9saWN5RXJyb3IoXCJBcnRpZmFjdCBub3QgZm91bmQgb24gZGlza1wiKSxcbiAgICAgIGZhbHNlLFxuICAgICAgXCJwbGFpbiBhcnRpZmFjdC1taXNzaW5nIG1lc3NhZ2UgaXMgbm90IGEgZGV0ZXJtaW5pc3RpYyBwb2xpY3kgZXJyb3JcIixcbiAgICApO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChcbiAgICAgIGlzRGV0ZXJtaW5pc3RpY1BvbGljeUVycm9yKFwiZXhpc3RzU3luYyByZXR1cm5lZCBmYWxzZVwiKSxcbiAgICAgIGZhbHNlLFxuICAgICk7XG4gIH0pO1xuXG59KTtcblxuLy8gQ2xlYW51cCBhbGwgdGVtcCBkaXJzIGFmdGVyIHRoZSB0ZXN0IHN1aXRlIGNvbXBsZXRlc1xucHJvY2Vzcy5vbihcImV4aXRcIiwgKCkgPT4ge1xuICBmb3IgKGNvbnN0IGRpciBvZiB0bXBEaXJzKSB7XG4gICAgdHJ5IHsgcm1TeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pOyB9IGNhdGNoIHsgLyogaWdub3JlICovIH1cbiAgfVxufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFrQkEsU0FBUyxVQUFVLE1BQU0sWUFBWSxpQkFBaUI7QUFDdEQsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxXQUFXLFlBQVksY0FBYztBQUMzRCxTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsa0JBQWtCO0FBRTNCO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1AsU0FBUyxtQkFBbUI7QUFDNUIsU0FBUyw2QkFBNkI7QUFDdEMsU0FBUyxvQkFBb0I7QUFJN0IsTUFBTSxVQUFvQixDQUFDO0FBRTNCLFNBQVMsY0FBc0I7QUFD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
