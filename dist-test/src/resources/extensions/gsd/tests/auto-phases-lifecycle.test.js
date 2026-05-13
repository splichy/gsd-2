import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runFinalize } from "../auto/phases.js";
import { AutoSession } from "../auto/session.js";
import { readUnitRuntimeRecord, writeUnitRuntimeRecord } from "../unit-runtime.js";
async function runSuccessfulFinalize(s) {
  const unit = s.currentUnit;
  assert.ok(unit, "test setup must provide currentUnit");
  writeUnitRuntimeRecord(s.basePath, unit.type, unit.id, unit.startedAt, {
    phase: "dispatched"
  });
  const deps = {
    clearUnitTimeout() {
    },
    buildSnapshotOpts() {
      return {};
    },
    stopAuto: async () => {
    },
    pauseAuto: async () => {
    },
    updateProgressWidget() {
    },
    postUnitPreVerification: async () => "continue",
    runPostUnitVerification: async () => "continue",
    postUnitPostVerification: async () => "continue"
  };
  return runFinalize(
    {
      ctx: { ui: { notify() {
      } } },
      pi: {},
      s,
      deps,
      prefs: void 0,
      iteration: 1,
      flowId: "flow-1",
      nextSeq: () => 1
    },
    {
      unitType: unit.type,
      unitId: unit.id,
      prompt: "",
      finalPrompt: "",
      pauseAfterUatDispatch: false,
      state: {},
      mid: "M001",
      midTitle: "Milestone",
      isRetry: false,
      previousTier: void 0
    },
    {
      recentUnits: [],
      stuckRecoveryAttempts: 0,
      consecutiveFinalizeTimeouts: 0
    }
  );
}
async function runFinalizeWithDeps(s, depsOverrides) {
  const unit = s.currentUnit;
  assert.ok(unit, "test setup must provide currentUnit");
  writeUnitRuntimeRecord(s.basePath, unit.type, unit.id, unit.startedAt, {
    phase: "dispatched"
  });
  const deps = {
    clearUnitTimeout() {
    },
    buildSnapshotOpts() {
      return {};
    },
    stopAuto: async () => {
    },
    pauseAuto: async () => {
    },
    updateProgressWidget() {
    },
    postUnitPreVerification: async () => "continue",
    runPostUnitVerification: async () => "continue",
    postUnitPostVerification: async () => "continue",
    ...depsOverrides
  };
  return runFinalize(
    {
      ctx: { ui: { notify() {
      } } },
      pi: {},
      s,
      deps,
      prefs: void 0,
      iteration: 1,
      flowId: "flow-1",
      nextSeq: () => 1
    },
    {
      unitType: unit.type,
      unitId: unit.id,
      prompt: "",
      finalPrompt: "",
      pauseAfterUatDispatch: false,
      state: {},
      mid: "M001",
      midTitle: "Milestone",
      isRetry: false,
      previousTier: void 0
    },
    {
      recentUnits: [],
      stuckRecoveryAttempts: 0,
      consecutiveFinalizeTimeouts: 0
    }
  );
}
test("runFinalize clears currentUnit after successful finalize", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-finalize-current-unit-"));
  const s = new AutoSession();
  s.basePath = base;
  s.currentUnit = {
    type: "execute-task",
    id: "M001/S01/T01",
    startedAt: Date.now()
  };
  try {
    const result = await runSuccessfulFinalize(s);
    assert.equal(result.action, "next");
    assert.equal(s.currentUnit, null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("runFinalize marks unit runtime finalized after successful finalize", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-finalize-runtime-"));
  const s = new AutoSession();
  const startedAt = Date.now();
  s.basePath = base;
  s.currentUnit = {
    type: "complete-milestone",
    id: "M001",
    startedAt
  };
  try {
    const result = await runSuccessfulFinalize(s);
    const runtime = readUnitRuntimeRecord(base, "complete-milestone", "M001");
    assert.equal(result.action, "next");
    assert.equal(runtime?.phase, "finalized");
    assert.equal(runtime?.lastProgressKind, "finalize-success");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("runFinalize merges a verified complete-milestone immediately and only once", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-finalize-merge-"));
  t.after(() => {
    rmSync(base, { recursive: true, force: true });
  });
  const s = new AutoSession();
  const startedAt = Date.now();
  let lifecycleMergeCalls = 0;
  let resolverMergeCalls = 0;
  s.basePath = base;
  s.originalBasePath = base;
  s.currentMilestoneId = "M001";
  s.currentUnit = {
    type: "complete-milestone",
    id: "M001",
    startedAt
  };
  const result = await runFinalizeWithDeps(s, {
    preflightCleanRoot: () => ({ stashPushed: false }),
    postflightPopStash: () => ({ needsManualRecovery: false }),
    resolver: {
      mergeAndExit() {
        resolverMergeCalls++;
      }
    },
    lifecycle: {
      exitMilestone(_mid, opts) {
        if (opts.merge) lifecycleMergeCalls++;
        return { ok: true, merged: opts.merge, codeFilesChanged: false };
      }
    }
  });
  assert.equal(result.action, "next");
  assert.equal(lifecycleMergeCalls, 1);
  assert.equal(resolverMergeCalls, 0);
  assert.equal(s.milestoneMergedInPhases, true);
  s.currentUnit = {
    type: "complete-milestone",
    id: "M001",
    startedAt: startedAt + 1
  };
  const second = await runFinalizeWithDeps(s, {
    preflightCleanRoot: () => ({ stashPushed: false }),
    postflightPopStash: () => ({ needsManualRecovery: false }),
    resolver: {
      mergeAndExit() {
        resolverMergeCalls++;
      }
    },
    lifecycle: {
      exitMilestone(_mid, opts) {
        if (opts.merge) lifecycleMergeCalls++;
        return { ok: true, merged: opts.merge, codeFilesChanged: false };
      }
    }
  });
  assert.equal(second.action, "next");
  assert.equal(lifecycleMergeCalls, 1);
  assert.equal(resolverMergeCalls, 0);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9hdXRvLXBoYXNlcy1saWZlY3ljbGUudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IEF1dG8tbG9vcCBwaGFzZSBsaWZlY3ljbGUgcmVncmVzc2lvbiB0ZXN0cy5cbmltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIHJtU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcblxuaW1wb3J0IHsgcnVuRmluYWxpemUgfSBmcm9tIFwiLi4vYXV0by9waGFzZXMudHNcIjtcbmltcG9ydCB7IEF1dG9TZXNzaW9uIH0gZnJvbSBcIi4uL2F1dG8vc2Vzc2lvbi50c1wiO1xuaW1wb3J0IHsgcmVhZFVuaXRSdW50aW1lUmVjb3JkLCB3cml0ZVVuaXRSdW50aW1lUmVjb3JkIH0gZnJvbSBcIi4uL3VuaXQtcnVudGltZS50c1wiO1xuXG5hc3luYyBmdW5jdGlvbiBydW5TdWNjZXNzZnVsRmluYWxpemUoczogQXV0b1Nlc3Npb24pIHtcbiAgY29uc3QgdW5pdCA9IHMuY3VycmVudFVuaXQ7XG4gIGFzc2VydC5vayh1bml0LCBcInRlc3Qgc2V0dXAgbXVzdCBwcm92aWRlIGN1cnJlbnRVbml0XCIpO1xuXG4gIHdyaXRlVW5pdFJ1bnRpbWVSZWNvcmQocy5iYXNlUGF0aCwgdW5pdC50eXBlLCB1bml0LmlkLCB1bml0LnN0YXJ0ZWRBdCwge1xuICAgIHBoYXNlOiBcImRpc3BhdGNoZWRcIixcbiAgfSk7XG5cbiAgY29uc3QgZGVwcyA9IHtcbiAgICBjbGVhclVuaXRUaW1lb3V0KCkge30sXG4gICAgYnVpbGRTbmFwc2hvdE9wdHMoKSB7XG4gICAgICByZXR1cm4ge307XG4gICAgfSxcbiAgICBzdG9wQXV0bzogYXN5bmMgKCkgPT4ge30sXG4gICAgcGF1c2VBdXRvOiBhc3luYyAoKSA9PiB7fSxcbiAgICB1cGRhdGVQcm9ncmVzc1dpZGdldCgpIHt9LFxuICAgIHBvc3RVbml0UHJlVmVyaWZpY2F0aW9uOiBhc3luYyAoKSA9PiBcImNvbnRpbnVlXCIsXG4gICAgcnVuUG9zdFVuaXRWZXJpZmljYXRpb246IGFzeW5jICgpID0+IFwiY29udGludWVcIixcbiAgICBwb3N0VW5pdFBvc3RWZXJpZmljYXRpb246IGFzeW5jICgpID0+IFwiY29udGludWVcIixcbiAgfTtcblxuICByZXR1cm4gcnVuRmluYWxpemUoXG4gICAge1xuICAgICAgY3R4OiB7IHVpOiB7IG5vdGlmeSgpIHt9IH0gfSxcbiAgICAgIHBpOiB7fSxcbiAgICAgIHMsXG4gICAgICBkZXBzLFxuICAgICAgcHJlZnM6IHVuZGVmaW5lZCxcbiAgICAgIGl0ZXJhdGlvbjogMSxcbiAgICAgIGZsb3dJZDogXCJmbG93LTFcIixcbiAgICAgIG5leHRTZXE6ICgpID0+IDEsXG4gICAgfSBhcyBhbnksXG4gICAge1xuICAgICAgdW5pdFR5cGU6IHVuaXQudHlwZSxcbiAgICAgIHVuaXRJZDogdW5pdC5pZCxcbiAgICAgIHByb21wdDogXCJcIixcbiAgICAgIGZpbmFsUHJvbXB0OiBcIlwiLFxuICAgICAgcGF1c2VBZnRlclVhdERpc3BhdGNoOiBmYWxzZSxcbiAgICAgIHN0YXRlOiB7fSBhcyBhbnksXG4gICAgICBtaWQ6IFwiTTAwMVwiLFxuICAgICAgbWlkVGl0bGU6IFwiTWlsZXN0b25lXCIsXG4gICAgICBpc1JldHJ5OiBmYWxzZSxcbiAgICAgIHByZXZpb3VzVGllcjogdW5kZWZpbmVkLFxuICAgIH0sXG4gICAge1xuICAgICAgcmVjZW50VW5pdHM6IFtdLFxuICAgICAgc3R1Y2tSZWNvdmVyeUF0dGVtcHRzOiAwLFxuICAgICAgY29uc2VjdXRpdmVGaW5hbGl6ZVRpbWVvdXRzOiAwLFxuICAgIH0sXG4gICk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJ1bkZpbmFsaXplV2l0aERlcHMoczogQXV0b1Nlc3Npb24sIGRlcHNPdmVycmlkZXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XG4gIGNvbnN0IHVuaXQgPSBzLmN1cnJlbnRVbml0O1xuICBhc3NlcnQub2sodW5pdCwgXCJ0ZXN0IHNldHVwIG11c3QgcHJvdmlkZSBjdXJyZW50VW5pdFwiKTtcblxuICB3cml0ZVVuaXRSdW50aW1lUmVjb3JkKHMuYmFzZVBhdGgsIHVuaXQudHlwZSwgdW5pdC5pZCwgdW5pdC5zdGFydGVkQXQsIHtcbiAgICBwaGFzZTogXCJkaXNwYXRjaGVkXCIsXG4gIH0pO1xuXG4gIGNvbnN0IGRlcHMgPSB7XG4gICAgY2xlYXJVbml0VGltZW91dCgpIHt9LFxuICAgIGJ1aWxkU25hcHNob3RPcHRzKCkge1xuICAgICAgcmV0dXJuIHt9O1xuICAgIH0sXG4gICAgc3RvcEF1dG86IGFzeW5jICgpID0+IHt9LFxuICAgIHBhdXNlQXV0bzogYXN5bmMgKCkgPT4ge30sXG4gICAgdXBkYXRlUHJvZ3Jlc3NXaWRnZXQoKSB7fSxcbiAgICBwb3N0VW5pdFByZVZlcmlmaWNhdGlvbjogYXN5bmMgKCkgPT4gXCJjb250aW51ZVwiLFxuICAgIHJ1blBvc3RVbml0VmVyaWZpY2F0aW9uOiBhc3luYyAoKSA9PiBcImNvbnRpbnVlXCIsXG4gICAgcG9zdFVuaXRQb3N0VmVyaWZpY2F0aW9uOiBhc3luYyAoKSA9PiBcImNvbnRpbnVlXCIsXG4gICAgLi4uZGVwc092ZXJyaWRlcyxcbiAgfTtcblxuICByZXR1cm4gcnVuRmluYWxpemUoXG4gICAge1xuICAgICAgY3R4OiB7IHVpOiB7IG5vdGlmeSgpIHt9IH0gfSxcbiAgICAgIHBpOiB7fSxcbiAgICAgIHMsXG4gICAgICBkZXBzLFxuICAgICAgcHJlZnM6IHVuZGVmaW5lZCxcbiAgICAgIGl0ZXJhdGlvbjogMSxcbiAgICAgIGZsb3dJZDogXCJmbG93LTFcIixcbiAgICAgIG5leHRTZXE6ICgpID0+IDEsXG4gICAgfSBhcyBhbnksXG4gICAge1xuICAgICAgdW5pdFR5cGU6IHVuaXQudHlwZSxcbiAgICAgIHVuaXRJZDogdW5pdC5pZCxcbiAgICAgIHByb21wdDogXCJcIixcbiAgICAgIGZpbmFsUHJvbXB0OiBcIlwiLFxuICAgICAgcGF1c2VBZnRlclVhdERpc3BhdGNoOiBmYWxzZSxcbiAgICAgIHN0YXRlOiB7fSBhcyBhbnksXG4gICAgICBtaWQ6IFwiTTAwMVwiLFxuICAgICAgbWlkVGl0bGU6IFwiTWlsZXN0b25lXCIsXG4gICAgICBpc1JldHJ5OiBmYWxzZSxcbiAgICAgIHByZXZpb3VzVGllcjogdW5kZWZpbmVkLFxuICAgIH0sXG4gICAge1xuICAgICAgcmVjZW50VW5pdHM6IFtdLFxuICAgICAgc3R1Y2tSZWNvdmVyeUF0dGVtcHRzOiAwLFxuICAgICAgY29uc2VjdXRpdmVGaW5hbGl6ZVRpbWVvdXRzOiAwLFxuICAgIH0sXG4gICk7XG59XG5cbnRlc3QoXCJydW5GaW5hbGl6ZSBjbGVhcnMgY3VycmVudFVuaXQgYWZ0ZXIgc3VjY2Vzc2Z1bCBmaW5hbGl6ZVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1maW5hbGl6ZS1jdXJyZW50LXVuaXQtXCIpKTtcbiAgY29uc3QgcyA9IG5ldyBBdXRvU2Vzc2lvbigpO1xuICBzLmJhc2VQYXRoID0gYmFzZTtcbiAgcy5jdXJyZW50VW5pdCA9IHtcbiAgICB0eXBlOiBcImV4ZWN1dGUtdGFza1wiLFxuICAgIGlkOiBcIk0wMDEvUzAxL1QwMVwiLFxuICAgIHN0YXJ0ZWRBdDogRGF0ZS5ub3coKSxcbiAgfTtcblxuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1blN1Y2Nlc3NmdWxGaW5hbGl6ZShzKTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuYWN0aW9uLCBcIm5leHRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHMuY3VycmVudFVuaXQsIG51bGwpO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwicnVuRmluYWxpemUgbWFya3MgdW5pdCBydW50aW1lIGZpbmFsaXplZCBhZnRlciBzdWNjZXNzZnVsIGZpbmFsaXplXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLWZpbmFsaXplLXJ1bnRpbWUtXCIpKTtcbiAgY29uc3QgcyA9IG5ldyBBdXRvU2Vzc2lvbigpO1xuICBjb25zdCBzdGFydGVkQXQgPSBEYXRlLm5vdygpO1xuICBzLmJhc2VQYXRoID0gYmFzZTtcbiAgcy5jdXJyZW50VW5pdCA9IHtcbiAgICB0eXBlOiBcImNvbXBsZXRlLW1pbGVzdG9uZVwiLFxuICAgIGlkOiBcIk0wMDFcIixcbiAgICBzdGFydGVkQXQsXG4gIH07XG5cbiAgdHJ5IHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5TdWNjZXNzZnVsRmluYWxpemUocyk7XG4gICAgY29uc3QgcnVudGltZSA9IHJlYWRVbml0UnVudGltZVJlY29yZChiYXNlLCBcImNvbXBsZXRlLW1pbGVzdG9uZVwiLCBcIk0wMDFcIik7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmFjdGlvbiwgXCJuZXh0XCIpO1xuICAgIGFzc2VydC5lcXVhbChydW50aW1lPy5waGFzZSwgXCJmaW5hbGl6ZWRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJ1bnRpbWU/Lmxhc3RQcm9ncmVzc0tpbmQsIFwiZmluYWxpemUtc3VjY2Vzc1wiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcInJ1bkZpbmFsaXplIG1lcmdlcyBhIHZlcmlmaWVkIGNvbXBsZXRlLW1pbGVzdG9uZSBpbW1lZGlhdGVseSBhbmQgb25seSBvbmNlXCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1maW5hbGl6ZS1tZXJnZS1cIikpO1xuICB0LmFmdGVyKCgpID0+IHtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcblxuICBjb25zdCBzID0gbmV3IEF1dG9TZXNzaW9uKCk7XG4gIGNvbnN0IHN0YXJ0ZWRBdCA9IERhdGUubm93KCk7XG4gIGxldCBsaWZlY3ljbGVNZXJnZUNhbGxzID0gMDtcbiAgbGV0IHJlc29sdmVyTWVyZ2VDYWxscyA9IDA7XG4gIHMuYmFzZVBhdGggPSBiYXNlO1xuICBzLm9yaWdpbmFsQmFzZVBhdGggPSBiYXNlO1xuICBzLmN1cnJlbnRNaWxlc3RvbmVJZCA9IFwiTTAwMVwiO1xuICBzLmN1cnJlbnRVbml0ID0ge1xuICAgIHR5cGU6IFwiY29tcGxldGUtbWlsZXN0b25lXCIsXG4gICAgaWQ6IFwiTTAwMVwiLFxuICAgIHN0YXJ0ZWRBdCxcbiAgfTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5GaW5hbGl6ZVdpdGhEZXBzKHMsIHtcbiAgICBwcmVmbGlnaHRDbGVhblJvb3Q6ICgpID0+ICh7IHN0YXNoUHVzaGVkOiBmYWxzZSB9KSxcbiAgICBwb3N0ZmxpZ2h0UG9wU3Rhc2g6ICgpID0+ICh7IG5lZWRzTWFudWFsUmVjb3Zlcnk6IGZhbHNlIH0pLFxuICAgIHJlc29sdmVyOiB7XG4gICAgICBtZXJnZUFuZEV4aXQoKSB7XG4gICAgICAgIHJlc29sdmVyTWVyZ2VDYWxscysrO1xuICAgICAgfSxcbiAgICB9LFxuICAgIGxpZmVjeWNsZToge1xuICAgICAgZXhpdE1pbGVzdG9uZShfbWlkOiBzdHJpbmcsIG9wdHM6IHsgbWVyZ2U6IGJvb2xlYW4gfSkge1xuICAgICAgICBpZiAob3B0cy5tZXJnZSkgbGlmZWN5Y2xlTWVyZ2VDYWxscysrO1xuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgbWVyZ2VkOiBvcHRzLm1lcmdlLCBjb2RlRmlsZXNDaGFuZ2VkOiBmYWxzZSB9O1xuICAgICAgfSxcbiAgICB9LFxuICB9KTtcblxuICBhc3NlcnQuZXF1YWwocmVzdWx0LmFjdGlvbiwgXCJuZXh0XCIpO1xuICBhc3NlcnQuZXF1YWwobGlmZWN5Y2xlTWVyZ2VDYWxscywgMSk7XG4gIGFzc2VydC5lcXVhbChyZXNvbHZlck1lcmdlQ2FsbHMsIDApO1xuICBhc3NlcnQuZXF1YWwocy5taWxlc3RvbmVNZXJnZWRJblBoYXNlcywgdHJ1ZSk7XG5cbiAgcy5jdXJyZW50VW5pdCA9IHtcbiAgICB0eXBlOiBcImNvbXBsZXRlLW1pbGVzdG9uZVwiLFxuICAgIGlkOiBcIk0wMDFcIixcbiAgICBzdGFydGVkQXQ6IHN0YXJ0ZWRBdCArIDEsXG4gIH07XG4gIGNvbnN0IHNlY29uZCA9IGF3YWl0IHJ1bkZpbmFsaXplV2l0aERlcHMocywge1xuICAgIHByZWZsaWdodENsZWFuUm9vdDogKCkgPT4gKHsgc3Rhc2hQdXNoZWQ6IGZhbHNlIH0pLFxuICAgIHBvc3RmbGlnaHRQb3BTdGFzaDogKCkgPT4gKHsgbmVlZHNNYW51YWxSZWNvdmVyeTogZmFsc2UgfSksXG4gICAgcmVzb2x2ZXI6IHtcbiAgICAgIG1lcmdlQW5kRXhpdCgpIHtcbiAgICAgICAgcmVzb2x2ZXJNZXJnZUNhbGxzKys7XG4gICAgICB9LFxuICAgIH0sXG4gICAgbGlmZWN5Y2xlOiB7XG4gICAgICBleGl0TWlsZXN0b25lKF9taWQ6IHN0cmluZywgb3B0czogeyBtZXJnZTogYm9vbGVhbiB9KSB7XG4gICAgICAgIGlmIChvcHRzLm1lcmdlKSBsaWZlY3ljbGVNZXJnZUNhbGxzKys7XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBtZXJnZWQ6IG9wdHMubWVyZ2UsIGNvZGVGaWxlc0NoYW5nZWQ6IGZhbHNlIH07XG4gICAgICB9LFxuICAgIH0sXG4gIH0pO1xuXG4gIGFzc2VydC5lcXVhbChzZWNvbmQuYWN0aW9uLCBcIm5leHRcIik7XG4gIGFzc2VydC5lcXVhbChsaWZlY3ljbGVNZXJnZUNhbGxzLCAxKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc29sdmVyTWVyZ2VDYWxscywgMCk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUVBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxhQUFhLGNBQWM7QUFDcEMsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUV2QixTQUFTLG1CQUFtQjtBQUM1QixTQUFTLG1CQUFtQjtBQUM1QixTQUFTLHVCQUF1Qiw4QkFBOEI7QUFFOUQsZUFBZSxzQkFBc0IsR0FBZ0I7QUFDbkQsUUFBTSxPQUFPLEVBQUU7QUFDZixTQUFPLEdBQUcsTUFBTSxxQ0FBcUM7QUFFckQseUJBQXVCLEVBQUUsVUFBVSxLQUFLLE1BQU0sS0FBSyxJQUFJLEtBQUssV0FBVztBQUFBLElBQ3JFLE9BQU87QUFBQSxFQUNULENBQUM7QUFFRCxRQUFNLE9BQU87QUFBQSxJQUNYLG1CQUFtQjtBQUFBLElBQUM7QUFBQSxJQUNwQixvQkFBb0I7QUFDbEIsYUFBTyxDQUFDO0FBQUEsSUFDVjtBQUFBLElBQ0EsVUFBVSxZQUFZO0FBQUEsSUFBQztBQUFBLElBQ3ZCLFdBQVcsWUFBWTtBQUFBLElBQUM7QUFBQSxJQUN4Qix1QkFBdUI7QUFBQSxJQUFDO0FBQUEsSUFDeEIseUJBQXlCLFlBQVk7QUFBQSxJQUNyQyx5QkFBeUIsWUFBWTtBQUFBLElBQ3JDLDBCQUEwQixZQUFZO0FBQUEsRUFDeEM7QUFFQSxTQUFPO0FBQUEsSUFDTDtBQUFBLE1BQ0UsS0FBSyxFQUFFLElBQUksRUFBRSxTQUFTO0FBQUEsTUFBQyxFQUFFLEVBQUU7QUFBQSxNQUMzQixJQUFJLENBQUM7QUFBQSxNQUNMO0FBQUEsTUFDQTtBQUFBLE1BQ0EsT0FBTztBQUFBLE1BQ1AsV0FBVztBQUFBLE1BQ1gsUUFBUTtBQUFB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
