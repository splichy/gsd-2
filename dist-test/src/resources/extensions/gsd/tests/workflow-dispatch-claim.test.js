import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureDispatchLease,
  openDispatchClaim
} from "../auto/workflow-dispatch-claim.js";
function makeSession(overrides) {
  return {
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    ...overrides
  };
}
function makeIterationData(overrides) {
  return {
    unitType: "execute-task",
    unitId: "M001/S001/T001",
    prompt: "Run task",
    finalPrompt: "Run task",
    pauseAfterUatDispatch: false,
    mid: "M001",
    midTitle: "Milestone",
    isRetry: false,
    previousTier: void 0,
    state: {
      activeSlice: { id: "S001" },
      activeTask: { id: "T001" }
    },
    ...overrides
  };
}
function makeDeps(overrides) {
  return {
    getRecentDispatchesForUnit: () => [],
    recordDispatchClaim: () => ({ ok: true, dispatchId: 42 }),
    markDispatchRunning: () => {
    },
    logClaimRejected: () => {
    },
    logClaimFailed: () => {
    },
    ...overrides
  };
}
function makeLeaseDeps(overrides) {
  const calls = [];
  const failures = [];
  const deps = {
    claimMilestoneLease: (workerId, milestoneId) => {
      calls.push(["claim", workerId, milestoneId]);
      return { ok: true, token: 8, expiresAt: "2030-01-01T00:00:00.000Z" };
    },
    logLeaseRecovered: (details) => calls.push(["recovered", details]),
    logLeaseRecoveryFailed: (details) => failures.push(details),
    ...overrides
  };
  return { deps, calls, failures };
}
test("openDispatchClaim degrades when worker identity or lease token is missing", () => {
  assert.deepEqual(
    openDispatchClaim(makeSession({ workerId: null }), "flow", "turn", makeIterationData(), makeDeps({
      recordDispatchClaim: () => assert.fail("recordDispatchClaim should not be called")
    })),
    { kind: "degraded" }
  );
  assert.deepEqual(
    openDispatchClaim(makeSession({ milestoneLeaseToken: null }), "flow", "turn", makeIterationData(), makeDeps({
      recordDispatchClaim: () => assert.fail("recordDispatchClaim should not be called")
    })),
    { kind: "degraded" }
  );
});
test("openDispatchClaim degrades when iteration has no milestone id", () => {
  assert.deepEqual(
    openDispatchClaim(makeSession(), "flow", "turn", makeIterationData({ mid: void 0 }), makeDeps({
      recordDispatchClaim: () => assert.fail("recordDispatchClaim should not be called")
    })),
    { kind: "degraded" }
  );
});
test("openDispatchClaim records attempts and marks successful claims running", () => {
  const running = [];
  const claimInputs = [];
  const outcome = openDispatchClaim(makeSession(), "flow-1", "turn-1", makeIterationData(), makeDeps({
    getRecentDispatchesForUnit: (unitId, limit) => {
      assert.equal(unitId, "M001/S001/T001");
      assert.equal(limit, 1);
      return [{ attempt_n: 2 }];
    },
    recordDispatchClaim: (input) => {
      claimInputs.push(input);
      return { ok: true, dispatchId: 99 };
    },
    markDispatchRunning: (dispatchId) => running.push(dispatchId)
  }));
  assert.deepEqual(outcome, { kind: "opened", dispatchId: 99 });
  assert.deepEqual(running, [99]);
  assert.deepEqual(claimInputs, [{
    traceId: "flow-1",
    turnId: "turn-1",
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    milestoneId: "M001",
    sliceId: "S001",
    taskId: "T001",
    unitType: "execute-task",
    unitId: "M001/S001/T001",
    attemptN: 3
  }]);
});
test("openDispatchClaim skips already-active claims with existing dispatch details", () => {
  const rejected = [];
  const outcome = openDispatchClaim(makeSession(), "flow", "turn", makeIterationData(), makeDeps({
    recordDispatchClaim: () => ({
      ok: false,
      error: "already_active",
      existingId: 12,
      existingWorker: "worker-2"
    }),
    logClaimRejected: (details) => rejected.push(details)
  }));
  assert.deepEqual(outcome, {
    kind: "skip",
    reason: "already-active",
    existingId: 12,
    existingWorker: "worker-2"
  });
  assert.deepEqual(rejected, [{
    unitId: "M001/S001/T001",
    reason: "already_active",
    existingId: 12,
    existingWorker: "worker-2"
  }]);
});
test("openDispatchClaim maps non-active claim rejections to stale lease skips", () => {
  const outcome = openDispatchClaim(makeSession(), "flow", "turn", makeIterationData(), makeDeps({
    recordDispatchClaim: () => ({ ok: false, error: "stale_lease" })
  }));
  assert.deepEqual(outcome, { kind: "skip", reason: "stale-lease" });
});
test("openDispatchClaim degrades on claim write failures", () => {
  const writeError = new Error("db unavailable");
  const logged = [];
  const outcome = openDispatchClaim(makeSession(), "flow", "turn", makeIterationData(), makeDeps({
    recordDispatchClaim: () => {
      throw writeError;
    },
    logClaimFailed: (err) => logged.push(err)
  }));
  assert.deepEqual(outcome, { kind: "degraded" });
  assert.deepEqual(logged, [writeError]);
});
test("ensureDispatchLease degrades without worker identity or milestone id", () => {
  const { deps, calls } = makeLeaseDeps({
    claimMilestoneLease: () => assert.fail("claimMilestoneLease should not be called")
  });
  assert.deepEqual(
    ensureDispatchLease(makeSession({ workerId: null }), "M001", deps),
    { kind: "degraded", reason: "missing-worker" }
  );
  assert.deepEqual(
    ensureDispatchLease(makeSession(), void 0, deps),
    { kind: "degraded", reason: "missing-milestone" }
  );
  assert.deepEqual(calls, []);
});
test("ensureDispatchLease reuses an existing numeric token", () => {
  const { deps, calls } = makeLeaseDeps({
    claimMilestoneLease: () => assert.fail("claimMilestoneLease should not be called")
  });
  const session = makeSession({ milestoneLeaseToken: 7 });
  const outcome = ensureDispatchLease(session, "M001", deps);
  assert.deepEqual(outcome, { kind: "ready", token: 7, recovered: false });
  assert.equal(session.milestoneLeaseToken, 7);
  assert.deepEqual(calls, []);
});
test("ensureDispatchLease claims a lease when the session has no token", () => {
  const { deps, calls, failures } = makeLeaseDeps();
  const session = makeSession({
    currentMilestoneId: "M001",
    milestoneLeaseToken: null
  });
  const outcome = ensureDispatchLease(session, "M001", deps);
  assert.deepEqual(outcome, { kind: "ready", token: 8, recovered: false });
  assert.equal(session.currentMilestoneId, "M001");
  assert.equal(session.milestoneLeaseToken, 8);
  assert.deepEqual(calls, [
    ["claim", "worker-1", "M001"],
    ["recovered", {
      milestoneId: "M001",
      workerId: "worker-1",
      token: 8,
      recovered: false
    }]
  ]);
  assert.deepEqual(failures, []);
});
test("ensureDispatchLease force-reclaims after a stale dispatch claim", () => {
  const { deps, calls } = makeLeaseDeps({
    claimMilestoneLease: (workerId, milestoneId) => {
      calls.push(["claim", workerId, milestoneId]);
      return { ok: true, token: 9, expiresAt: "2030-01-01T00:00:00.000Z" };
    }
  });
  const session = makeSession({ milestoneLeaseToken: 7 });
  const outcome = ensureDispatchLease(session, "M001", deps, { forceReclaim: true });
  assert.deepEqual(outcome, { kind: "ready", token: 9, recovered: true });
  assert.equal(session.milestoneLeaseToken, 9);
  assert.deepEqual(calls, [
    ["claim", "worker-1", "M001"],
    ["recovered", {
      milestoneId: "M001",
      workerId: "worker-1",
      token: 9,
      recovered: true
    }]
  ]);
});
test("ensureDispatchLease blocks when another worker holds the lease", () => {
  const { deps, failures } = makeLeaseDeps({
    claimMilestoneLease: () => ({
      ok: false,
      error: "held_by",
      byWorker: "worker-2",
      expiresAt: "2030-01-01T00:00:00.000Z"
    })
  });
  const session = makeSession({ milestoneLeaseToken: null });
  const outcome = ensureDispatchLease(session, "M001", deps);
  assert.deepEqual(outcome, {
    kind: "blocked",
    reason: "Milestone M001 is held by worker worker-2 until 2030-01-01T00:00:00.000Z."
  });
  assert.equal(session.milestoneLeaseToken, null);
  assert.deepEqual(failures, [{
    milestoneId: "M001",
    workerId: "worker-1",
    reason: "Milestone M001 is held by worker worker-2 until 2030-01-01T00:00:00.000Z."
  }]);
});
test("ensureDispatchLease fails closed on claim errors", () => {
  const { deps, failures } = makeLeaseDeps({
    claimMilestoneLease: () => {
      throw new Error("db unavailable");
    }
  });
  const session = makeSession({ milestoneLeaseToken: null });
  const outcome = ensureDispatchLease(session, "M001", deps);
  assert.deepEqual(outcome, { kind: "failed", reason: "db unavailable" });
  assert.equal(session.milestoneLeaseToken, null);
  assert.deepEqual(failures, [{
    milestoneId: "M001",
    workerId: "worker-1",
    reason: "db unavailable"
  }]);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy93b3JrZmxvdy1kaXNwYXRjaC1jbGFpbS50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBQcm9qZWN0L0FwcDogR1NELTJcbi8vIEZpbGUgUHVycG9zZTogVW5pdCB0ZXN0cyBmb3IgYXV0by1tb2RlIGRpc3BhdGNoIGNsYWltIGFkYXB0ZXIuXG5cbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuXG5pbXBvcnQgdHlwZSB7IEF1dG9TZXNzaW9uIH0gZnJvbSBcIi4uL2F1dG8vc2Vzc2lvbi50c1wiO1xuaW1wb3J0IHR5cGUgeyBJdGVyYXRpb25EYXRhIH0gZnJvbSBcIi4uL2F1dG8vdHlwZXMudHNcIjtcbmltcG9ydCB7XG4gIGVuc3VyZURpc3BhdGNoTGVhc2UsXG4gIG9wZW5EaXNwYXRjaENsYWltLFxuICB0eXBlIEVuc3VyZURpc3BhdGNoTGVhc2VEZXBzLFxuICB0eXBlIE9wZW5EaXNwYXRjaENsYWltRGVwcyxcbn0gZnJvbSBcIi4uL2F1dG8vd29ya2Zsb3ctZGlzcGF0Y2gtY2xhaW0udHNcIjtcblxuZnVuY3Rpb24gbWFrZVNlc3Npb24ob3ZlcnJpZGVzPzogUGFydGlhbDxBdXRvU2Vzc2lvbj4pOiBBdXRvU2Vzc2lvbiB7XG4gIHJldHVybiB7XG4gICAgd29ya2VySWQ6IFwid29ya2VyLTFcIixcbiAgICBtaWxlc3RvbmVMZWFzZVRva2VuOiA3LFxuICAgIC4uLm92ZXJyaWRlcyxcbiAgfSBhcyBBdXRvU2Vzc2lvbjtcbn1cblxuZnVuY3Rpb24gbWFrZUl0ZXJhdGlvbkRhdGEob3ZlcnJpZGVzPzogUGFydGlhbDxJdGVyYXRpb25EYXRhPik6IEl0ZXJhdGlvbkRhdGEge1xuICByZXR1cm4ge1xuICAgIHVuaXRUeXBlOiBcImV4ZWN1dGUtdGFza1wiLFxuICAgIHVuaXRJZDogXCJNMDAxL1MwMDEvVDAwMVwiLFxuICAgIHByb21wdDogXCJSdW4gdGFza1wiLFxuICAgIGZpbmFsUHJvbXB0OiBcIlJ1biB0YXNrXCIsXG4gICAgcGF1c2VBZnRlclVhdERpc3BhdGNoOiBmYWxzZSxcbiAgICBtaWQ6IFwiTTAwMVwiLFxuICAgIG1pZFRpdGxlOiBcIk1pbGVzdG9uZVwiLFxuICAgIGlzUmV0cnk6IGZhbHNlLFxuICAgIHByZXZpb3VzVGllcjogdW5kZWZpbmVkLFxuICAgIHN0YXRlOiB7XG4gICAgICBhY3RpdmVTbGljZTogeyBpZDogXCJTMDAxXCIgfSxcbiAgICAgIGFjdGl2ZVRhc2s6IHsgaWQ6IFwiVDAwMVwiIH0sXG4gICAgfSxcbiAgICAuLi5vdmVycmlkZXMsXG4gIH0gYXMgSXRlcmF0aW9uRGF0YTtcbn1cblxuZnVuY3Rpb24gbWFrZURlcHMob3ZlcnJpZGVzPzogUGFydGlhbDxPcGVuRGlzcGF0Y2hDbGFpbURlcHM+KTogT3BlbkRpc3BhdGNoQ2xhaW1EZXBzIHtcbiAgcmV0dXJuIHtcbiAgICBnZXRSZWNlbnREaXNwYXRjaGVzRm9yVW5pdDogKCkgPT4gW10sXG4gICAgcmVjb3JkRGlzcGF0Y2hDbGFpbTogKCkgPT4gKHsgb2s6IHRydWUsIGRpc3BhdGNoSWQ6IDQyIH0pLFxuICAgIG1hcmtEaXNwYXRjaFJ1bm5pbmc6ICgpID0+IHt9LFxuICAgIGxvZ0NsYWltUmVqZWN0ZWQ6ICgpID0+IHt9LFxuICAgIGxvZ0NsYWltRmFpbGVkOiAoKSA9PiB7fSxcbiAgICAuLi5vdmVycmlkZXMsXG4gIH07XG59XG5cbmZ1bmN0aW9uIG1ha2VMZWFzZURlcHMob3ZlcnJpZGVzPzogUGFydGlhbDxFbnN1cmVEaXNwYXRjaExlYXNlRGVwcz4pOiB7XG4gIGRlcHM6IEVuc3VyZURpc3BhdGNoTGVhc2VEZXBzO1xuICBjYWxsczogdW5rbm93bltdO1xuICBmYWlsdXJlczogdW5rbm93bltdO1xufSB7XG4gIGNvbnN0IGNhbGxzOiB1bmtub3duW10gPSBbXTtcbiAgY29uc3QgZmFpbHVyZXM6IHVua25vd25bXSA9IFtdO1xuICBjb25zdCBkZXBzOiBFbnN1cmVEaXNwYXRjaExlYXNlRGVwcyA9IHtcbiAgICBjbGFpbU1pbGVzdG9uZUxlYXNlOiAod29ya2VySWQsIG1pbGVzdG9uZUlkKSA9PiB7XG4gICAgICBjYWxscy5wdXNoKFtcImNsYWltXCIsIHdvcmtlcklkLCBtaWxlc3RvbmVJZF0pO1xuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHRva2VuOiA4LCBleHBpcmVzQXQ6IFwiMjAzMC0wMS0wMVQwMDowMDowMC4wMDBaXCIgfTtcbiAgICB9LFxuICAgIGxvZ0xlYXNlUmVjb3ZlcmVkOiBkZXRhaWxzID0+IGNhbGxzLnB1c2goW1wicmVjb3ZlcmVkXCIsIGRldGFpbHNdKSxcbiAgICBsb2dMZWFzZVJlY292ZXJ5RmFpbGVkOiBkZXRhaWxzID0+IGZhaWx1cmVzLnB1c2goZGV0YWlscyksXG4gICAgLi4ub3ZlcnJpZGVzLFxuICB9O1xuICByZXR1cm4geyBkZXBzLCBjYWxscywgZmFpbHVyZXMgfTtcbn1cblxudGVzdChcIm9wZW5EaXNwYXRjaENsYWltIGRlZ3JhZGVzIHdoZW4gd29ya2VyIGlkZW50aXR5IG9yIGxlYXNlIHRva2VuIGlzIG1pc3NpbmdcIiwgKCkgPT4ge1xuICBhc3NlcnQuZGVlcEVxdWFsKFxuICAgIG9wZW5EaXNwYXRjaENsYWltKG1ha2VTZXNzaW9uKHsgd29ya2VySWQ6IG51bGwgfSksIFwiZmxvd1wiLCBcInR1cm5cIiwgbWFrZUl0ZXJhdGlvbkRhdGEoKSwgbWFrZURlcHMoe1xuICAgICAgcmVjb3JkRGlzcGF0Y2hDbGFpbTogKCkgPT4gYXNzZXJ0LmZhaWwoXCJyZWNvcmREaXNwYXRjaENsYWltIHNob3VsZCBub3QgYmUgY2FsbGVkXCIpLFxuICAgIH0pKSxcbiAgICB7IGtpbmQ6IFwiZGVncmFkZWRcIiB9LFxuICApO1xuXG4gIGFzc2VydC5kZWVwRXF1YWwoXG4gICAgb3BlbkRpc3BhdGNoQ2xhaW0obWFrZVNlc3Npb24oeyBtaWxlc3RvbmVMZWFzZVRva2VuOiBudWxsIH0pLCBcImZsb3dcIiwgXCJ0dXJuXCIsIG1ha2VJdGVyYXRpb25EYXRhKCksIG1ha2VEZXBzKHtcbiAgICAgIHJlY29yZERpc3BhdGNoQ2xhaW06ICgpID0+IGFzc2VydC5mYWlsKFwicmVjb3JkRGlzcGF0Y2hDbGFpbSBzaG91bGQgbm90IGJlIGNhbGxlZFwiKSxcbiAgICB9KSksXG4gICAgeyBraW5kOiBcImRlZ3JhZGVkXCIgfSxcbiAgKTtcbn0pO1xuXG50ZXN0KFwib3BlbkRpc3BhdGNoQ2xhaW0gZGVncmFkZXMgd2hlbiBpdGVyYXRpb24gaGFzIG5vIG1pbGVzdG9uZSBpZFwiLCAoKSA9PiB7XG4gIGFzc2VydC5kZWVwRXF1YWwoXG4gICAgb3BlbkRpc3BhdGNoQ2xhaW0obWFrZVNlc3Npb24oKSwgXCJmbG93XCIsIFwidHVyblwiLCBtYWtlSXRlcmF0aW9uRGF0YSh7IG1pZDogdW5kZWZpbmVkIH0pLCBtYWtlRGVwcyh7XG4gICAgICByZWNvcmREaXNwYXRjaENsYWltOiAoKSA9PiBhc3NlcnQuZmFpbChcInJlY29yZERpc3BhdGNoQ2xhaW0gc2hvdWxkIG5vdCBiZSBjYWxsZWRcIiksXG4gICAgfSkpLFxuICAgIHsga2luZDogXCJkZWdyYWRlZFwiIH0sXG4gICk7XG59KTtcblxudGVzdChcIm9wZW5EaXNwYXRjaENsYWltIHJlY29yZHMgYXR0ZW1wdHMgYW5kIG1hcmtzIHN1Y2Nlc3NmdWwgY2xhaW1zIHJ1bm5pbmdcIiwgKCkgPT4ge1xuICBjb25zdCBydW5uaW5nOiBudW1iZXJbXSA9IFtdO1xuICBjb25zdCBjbGFpbUlucHV0czogdW5rbm93bltdID0gW107XG5cbiAgY29uc3Qgb3V0Y29tZSA9IG9wZW5EaXNwYXRjaENsYWltKG1ha2VTZXNzaW9uKCksIFwiZmxvdy0xXCIsIFwidHVybi0xXCIsIG1ha2VJdGVyYXRpb25EYXRhKCksIG1ha2VEZXBzKHtcbiAgICBnZXRSZWNlbnREaXNwYXRjaGVzRm9yVW5pdDogKHVuaXRJZCwgbGltaXQpID0+IHtcbiAgICAgIGFzc2VydC5lcXVhbCh1bml0SWQsIFwiTTAwMS9TMDAxL1QwMDFcIik7XG4gICAgICBhc3NlcnQuZXF1YWwobGltaXQsIDEpO1xuICAgICAgcmV0dXJuIFt7IGF0dGVtcHRfbjogMiB9XTtcbiAgICB9LFxuICAgIHJlY29yZERpc3BhdGNoQ2xhaW06IGlucHV0ID0+IHtcbiAgICAgIGNsYWltSW5wdXRzLnB1c2goaW5wdXQpO1xuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGRpc3BhdGNoSWQ6IDk5IH07XG4gICAgfSxcbiAgICBtYXJrRGlzcGF0Y2hSdW5uaW5nOiBkaXNwYXRjaElkID0+IHJ1bm5pbmcucHVzaChkaXNwYXRjaElkKSxcbiAgfSkpO1xuXG4gIGFzc2VydC5kZWVwRXF1YWwob3V0Y29tZSwgeyBraW5kOiBcIm9wZW5lZFwiLCBkaXNwYXRjaElkOiA5OSB9KTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChydW5uaW5nLCBbOTldKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChjbGFpbUlucHV0cywgW3tcbiAgICB0cmFjZUlkOiBcImZsb3ctMVwiLFxuICAgIHR1cm5JZDogXCJ0dXJuLTFcIixcbiAgICB3b3JrZXJJZDogXCJ3b3JrZXItMVwiLFxuICAgIG1pbGVzdG9uZUxlYXNlVG9rZW46IDcsXG4gICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgIHNsaWNlSWQ6IFwiUzAwMVwiLFxuICAgIHRhc2tJZDogXCJUMDAxXCIsXG4gICAgdW5pdFR5cGU6IFwiZXhlY3V0ZS10YXNrXCIsXG4gICAgdW5pdElkOiBcIk0wMDEvUzAwMS9UMDAxXCIsXG4gICAgYXR0ZW1wdE46IDMsXG4gIH1dKTtcbn0pO1xuXG50ZXN0KFwib3BlbkRpc3BhdGNoQ2xhaW0gc2tpcHMgYWxyZWFkeS1hY3RpdmUgY2xhaW1zIHdpdGggZXhpc3RpbmcgZGlzcGF0Y2ggZGV0YWlsc1wiLCAoKSA9PiB7XG4gIGNvbnN0IHJlamVjdGVkOiB1bmtub3duW10gPSBbXTtcblxuICBjb25zdCBvdXRjb21lID0gb3BlbkRpc3BhdGNoQ2xhaW0obWFrZVNlc3Npb24oKSwgXCJmbG93XCIsIFwidHVyblwiLCBtYWtlSXRlcmF0aW9uRGF0YSgpLCBtYWtlRGVwcyh7XG4gICAgcmVjb3JkRGlzcGF0Y2hDbGFpbTogKCkgPT4gKHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBcImFscmVhZHlfYWN0aXZlXCIsXG4gICAgICBleGlzdGluZ0lkOiAxMixcbiAgICAgIGV4aXN0aW5nV29ya2VyOiBcIndvcmtlci0yXCIsXG4gICAgfSksXG4gICAgbG9nQ2xhaW1SZWplY3RlZDogZGV0YWlscyA9PiByZWplY3RlZC5wdXNoKGRldGFpbHMpLFxuICB9KSk7XG5cbiAgYXNzZXJ0LmRlZXBFcXVhbChvdXRjb21lLCB7XG4gICAga2luZDogXCJza2lwXCIsXG4gICAgcmVhc29uOiBcImFscmVhZHktYWN0aXZlXCIsXG4gICAgZXhpc3RpbmdJZDogMTIsXG4gICAgZXhpc3RpbmdXb3JrZXI6IFwid29ya2VyLTJcIixcbiAgfSk7XG4gIGFzc2VydC5kZWVwRXF1YWwocmVqZWN0ZWQsIFt7XG4gICAgdW5pdElkOiBcIk0wMDEvUzAwMS9UMDAxXCIsXG4gICAgcmVhc29uOiBcImFscmVhZHlfYWN0aXZlXCIsXG4gICAgZXhpc3RpbmdJZDogMTIsXG4gICAgZXhpc3RpbmdXb3JrZXI6IFwid29ya2VyLTJcIixcbiAgfV0pO1xufSk7XG5cbnRlc3QoXCJvcGVuRGlzcGF0Y2hDbGFpbSBtYXBzIG5vbi1hY3RpdmUgY2xhaW0gcmVqZWN0aW9ucyB0byBzdGFsZSBsZWFzZSBza2lwc1wiLCAoKSA9PiB7XG4gIGNvbnN0IG91dGNvbWUgPSBvcGVuRGlzcGF0Y2hDbGFpbShtYWtlU2Vzc2lvbigpLCBcImZsb3dcIiwgXCJ0dXJuXCIsIG1ha2VJdGVyYXRpb25EYXRhKCksIG1ha2VEZXBzKHtcbiAgICByZWNvcmREaXNwYXRjaENsYWltOiAoKSA9PiAoeyBvazogZmFsc2UsIGVycm9yOiBcInN0YWxlX2xlYXNlXCIgfSksXG4gIH0pKTtcblxuICBhc3NlcnQuZGVlcEVxdWFsKG91dGNvbWUsIHsga2luZDogXCJza2lwXCIsIHJlYXNvbjogXCJzdGFsZS1sZWFzZVwiIH0pO1xufSk7XG5cbnRlc3QoXCJvcGVuRGlzcGF0Y2hDbGFpbSBkZWdyYWRlcyBvbiBjbGFpbSB3cml0ZSBmYWlsdXJlc1wiLCAoKSA9PiB7XG4gIGNvbnN0IHdyaXRlRXJyb3IgPSBuZXcgRXJyb3IoXCJkYiB1bmF2YWlsYWJsZVwiKTtcbiAgY29uc3QgbG9nZ2VkOiB1bmtub3duW10gPSBbXTtcblxuICBjb25zdCBvdXRjb21lID0gb3BlbkRpc3BhdGNoQ2xhaW0obWFrZVNlc3Npb24oKSwgXCJmbG93XCIsIFwidHVyblwiLCBtYWtlSXRlcmF0aW9uRGF0YSgpLCBtYWtlRGVwcyh7XG4gICAgcmVjb3JkRGlzcGF0Y2hDbGFpbTogKCkgPT4ge1xuICAgICAgdGhyb3cgd3JpdGVFcnJvcjtcbiAgICB9LFxuICAgIGxvZ0NsYWltRmFpbGVkOiBlcnIgPT4gbG9nZ2VkLnB1c2goZXJyKSxcbiAgfSkpO1xuXG4gIGFzc2VydC5kZWVwRXF1YWwob3V0Y29tZSwgeyBraW5kOiBcImRlZ3JhZGVkXCIgfSk7XG4gIGFzc2VydC5kZWVwRXF1YWwobG9nZ2VkLCBbd3JpdGVFcnJvcl0pO1xufSk7XG5cbnRlc3QoXCJlbnN1cmVEaXNwYXRjaExlYXNlIGRlZ3JhZGVzIHdpdGhvdXQgd29ya2VyIGlkZW50aXR5IG9yIG1pbGVzdG9uZSBpZFwiLCAoKSA9PiB7XG4gIGNvbnN0IHsgZGVwcywgY2FsbHMgfSA9IG1ha2VMZWFzZURlcHMoe1xuICAgIGNsYWltTWlsZXN0b25lTGVhc2U6ICgpID0+IGFzc2VydC5mYWlsKFwiY2xhaW1NaWxlc3RvbmVMZWFzZSBzaG91bGQgbm90IGJlIGNhbGxlZFwiKSxcbiAgfSk7XG5cbiAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICBlbnN1cmVEaXNwYXRjaExlYXNlKG1ha2VTZXNzaW9uKHsgd29ya2VySWQ6IG51bGwgfSksIFwiTTAwMVwiLCBkZXBzKSxcbiAgICB7IGtpbmQ6IFwiZGVncmFkZWRcIiwgcmVhc29uOiBcIm1pc3Npbmctd29ya2VyXCIgfSxcbiAgKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICBlbnN1cmVEaXNwYXRjaExlYXNlKG1ha2VTZXNzaW9uKCksIHVuZGVmaW5lZCwgZGVwcyksXG4gICAgeyBraW5kOiBcImRlZ3JhZGVkXCIsIHJlYXNvbjogXCJtaXNzaW5nLW1pbGVzdG9uZVwiIH0sXG4gICk7XG4gIGFzc2VydC5kZWVwRXF1YWwoY2FsbHMsIFtdKTtcbn0pO1xuXG50ZXN0KFwiZW5zdXJlRGlzcGF0Y2hMZWFzZSByZXVzZXMgYW4gZXhpc3RpbmcgbnVtZXJpYyB0b2tlblwiLCAoKSA9PiB7XG4gIGNvbnN0IHsgZGVwcywgY2FsbHMgfSA9IG1ha2VMZWFzZURlcHMoe1xuICAgIGNsYWltTWlsZXN0b25lTGVhc2U6ICgpID0+IGFzc2VydC5mYWlsKFwiY2xhaW1NaWxlc3RvbmVMZWFzZSBzaG91bGQgbm90IGJlIGNhbGxlZFwiKSxcbiAgfSk7XG5cbiAgY29uc3Qgc2Vzc2lvbiA9IG1ha2VTZXNzaW9uKHsgbWlsZXN0b25lTGVhc2VUb2tlbjogNyB9KTtcbiAgY29uc3Qgb3V0Y29tZSA9IGVuc3VyZURpc3BhdGNoTGVhc2Uoc2Vzc2lvbiwgXCJNMDAxXCIsIGRlcHMpO1xuXG4gIGFzc2VydC5kZWVwRXF1YWwob3V0Y29tZSwgeyBraW5kOiBcInJlYWR5XCIsIHRva2VuOiA3LCByZWNvdmVyZWQ6IGZhbHNlIH0pO1xuICBhc3NlcnQuZXF1YWwoc2Vzc2lvbi5taWxlc3RvbmVMZWFzZVRva2VuLCA3KTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChjYWxscywgW10pO1xufSk7XG5cbnRlc3QoXCJlbnN1cmVEaXNwYXRjaExlYXNlIGNsYWltcyBhIGxlYXNlIHdoZW4gdGhlIHNlc3Npb24gaGFzIG5vIHRva2VuXCIsICgpID0+IHtcbiAgY29uc3QgeyBkZXBzLCBjYWxscywgZmFpbHVyZXMgfSA9IG1ha2VMZWFzZURlcHMoKTtcbiAgY29uc3Qgc2Vzc2lvbiA9IG1ha2VTZXNzaW9uKHtcbiAgICBjdXJyZW50TWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgIG1pbGVzdG9uZUxlYXNlVG9rZW46IG51bGwsXG4gIH0pO1xuXG4gIGNvbnN0IG91dGNvbWUgPSBlbnN1cmVEaXNwYXRjaExlYXNlKHNlc3Npb24sIFwiTTAwMVwiLCBkZXBzKTtcblxuICBhc3NlcnQuZGVlcEVxdWFsKG91dGNvbWUsIHsga2luZDogXCJyZWFkeVwiLCB0b2tlbjogOCwgcmVjb3ZlcmVkOiBmYWxzZSB9KTtcbiAgYXNzZXJ0LmVxdWFsKHNlc3Npb24uY3VycmVudE1pbGVzdG9uZUlkLCBcIk0wMDFcIik7XG4gIGFzc2VydC5lcXVhbChzZXNzaW9uLm1pbGVzdG9uZUxlYXNlVG9rZW4sIDgpO1xuICBhc3NlcnQuZGVlcEVxdWFsKGNhbGxzLCBbXG4gICAgW1wiY2xhaW1cIiwgXCJ3b3JrZXItMVwiLCBcIk0wMDFcIl0sXG4gICAgW1wicmVjb3ZlcmVkXCIsIHtcbiAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICAgIHdvcmtlcklkOiBcIndvcmtlci0xXCIsXG4gICAgICB0b2tlbjogOCxcbiAgICAgIHJlY292ZXJlZDogZmFsc2UsXG4gICAgfV0sXG4gIF0pO1xuICBhc3NlcnQuZGVlcEVxdWFsKGZhaWx1cmVzLCBbXSk7XG59KTtcblxudGVzdChcImVuc3VyZURpc3BhdGNoTGVhc2UgZm9yY2UtcmVjbGFpbXMgYWZ0ZXIgYSBzdGFsZSBkaXNwYXRjaCBjbGFpbVwiLCAoKSA9PiB7XG4gIGNvbnN0IHsgZGVwcywgY2FsbHMgfSA9IG1ha2VMZWFzZURlcHMoe1xuICAgIGNsYWltTWlsZXN0b25lTGVhc2U6ICh3b3JrZXJJZCwgbWlsZXN0b25lSWQpID0+IHtcbiAgICAgIGNhbGxzLnB1c2goW1wiY2xhaW1cIiwgd29ya2VySWQsIG1pbGVzdG9uZUlkXSk7XG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgdG9rZW46IDksIGV4cGlyZXNBdDogXCIyMDMwLTAxLTAxVDAwOjAwOjAwLjAwMFpcIiB9O1xuICAgIH0sXG4gIH0pO1xuICBjb25zdCBzZXNzaW9uID0gbWFrZVNlc3Npb24oeyBtaWxlc3RvbmVMZWFzZVRva2VuOiA3IH0pO1xuXG4gIGNvbnN0IG91dGNvbWUgPSBlbnN1cmVEaXNwYXRjaExlYXNlKHNlc3Npb24sIFwiTTAwMVwiLCBkZXBzLCB7IGZvcmNlUmVjbGFpbTogdHJ1ZSB9KTtcblxuICBhc3NlcnQuZGVlcEVxdWFsKG91dGNvbWUsIHsga2luZDogXCJyZWFkeVwiLCB0b2tlbjogOSwgcmVjb3ZlcmVkOiB0cnVlIH0pO1xuICBhc3NlcnQuZXF1YWwoc2Vzc2lvbi5taWxlc3RvbmVMZWFzZVRva2VuLCA5KTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChjYWxscywgW1xuICAgIFtcImNsYWltXCIsIFwid29ya2VyLTFcIiwgXCJNMDAxXCJdLFxuICAgIFtcInJlY292ZXJlZFwiLCB7XG4gICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICB3b3JrZXJJZDogXCJ3b3JrZXItMVwiLFxuICAgICAgdG9rZW46IDksXG4gICAgICByZWNvdmVyZWQ6IHRydWUsXG4gICAgfV0sXG4gIF0pO1xufSk7XG5cbnRlc3QoXCJlbnN1cmVEaXNwYXRjaExlYXNlIGJsb2NrcyB3aGVuIGFub3RoZXIgd29ya2VyIGhvbGRzIHRoZSBsZWFzZVwiLCAoKSA9PiB7XG4gIGNvbnN0IHsgZGVwcywgZmFpbHVyZXMgfSA9IG1ha2VMZWFzZURlcHMoe1xuICAgIGNsYWltTWlsZXN0b25lTGVhc2U6ICgpID0+ICh7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogXCJoZWxkX2J5XCIsXG4gICAgICBieVdvcmtlcjogXCJ3b3JrZXItMlwiLFxuICAgICAgZXhwaXJlc0F0OiBcIjIwMzAtMDEtMDFUMDA6MDA6MDAuMDAwWlwiLFxuICAgIH0pLFxuICB9KTtcbiAgY29uc3Qgc2Vzc2lvbiA9IG1ha2VTZXNzaW9uKHsgbWlsZXN0b25lTGVhc2VUb2tlbjogbnVsbCB9KTtcblxuICBjb25zdCBvdXRjb21lID0gZW5zdXJlRGlzcGF0Y2hMZWFzZShzZXNzaW9uLCBcIk0wMDFcIiwgZGVwcyk7XG5cbiAgYXNzZXJ0LmRlZXBFcXVhbChvdXRjb21lLCB7XG4gICAga2luZDogXCJibG9ja2VkXCIsXG4gICAgcmVhc29uOiBcIk1pbGVzdG9uZSBNMDAxIGlzIGhlbGQgYnkgd29ya2VyIHdvcmtlci0yIHVudGlsIDIwMzAtMDEtMDFUMDA6MDA6MDAuMDAwWi5cIixcbiAgfSk7XG4gIGFzc2VydC5lcXVhbChzZXNzaW9uLm1pbGVzdG9uZUxlYXNlVG9rZW4sIG51bGwpO1xuICBhc3NlcnQuZGVlcEVxdWFsKGZhaWx1cmVzLCBbe1xuICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICB3b3JrZXJJZDogXCJ3b3JrZXItMVwiLFxuICAgIHJlYXNvbjogXCJNaWxlc3RvbmUgTTAwMSBpcyBoZWxkIGJ5IHdvcmtlciB3b3JrZXItMiB1bnRpbCAyMDMwLTAxLTAxVDAwOjAwOjAwLjAwMFouXCIsXG4gIH1dKTtcbn0pO1xuXG50ZXN0KFwiZW5zdXJlRGlzcGF0Y2hMZWFzZSBmYWlscyBjbG9zZWQgb24gY2xhaW0gZXJyb3JzXCIsICgpID0+IHtcbiAgY29uc3QgeyBkZXBzLCBmYWlsdXJlcyB9ID0gbWFrZUxlYXNlRGVwcyh7XG4gICAgY2xhaW1NaWxlc3RvbmVMZWFzZTogKCkgPT4ge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiZGIgdW5hdmFpbGFibGVcIik7XG4gICAgfSxcbiAgfSk7XG4gIGNvbnN0IHNlc3Npb24gPSBtYWtlU2Vzc2lvbih7IG1pbGVzdG9uZUxlYXNlVG9rZW46IG51bGwgfSk7XG5cbiAgY29uc3Qgb3V0Y29tZSA9IGVuc3VyZURpc3BhdGNoTGVhc2Uoc2Vzc2lvbiwgXCJNMDAxXCIsIGRlcHMpO1xuXG4gIGFzc2VydC5kZWVwRXF1YWwob3V0Y29tZSwgeyBraW5kOiBcImZhaWxlZFwiLCByZWFzb246IFwiZGIgdW5hdmFpbGFibGVcIiB9KTtcbiAgYXNzZXJ0LmVxdWFsKHNlc3Npb24ubWlsZXN0b25lTGVhc2VUb2tlbiwgbnVsbCk7XG4gIGFzc2VydC5kZWVwRXF1YWwoZmFpbHVyZXMsIFt7XG4gICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgIHdvcmtlcklkOiBcIndvcmtlci0xXCIsXG4gICAgcmVhc29uOiBcImRiIHVuYXZhaWxhYmxlXCIsXG4gIH1dKTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBR0EsT0FBTyxZQUFZO0FBQ25CLE9BQU8sVUFBVTtBQUlqQjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsT0FHSztBQUVQLFNBQVMsWUFBWSxXQUErQztBQUNsRSxTQUFPO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixxQkFBcUI7QUFBQSxJQUNyQixHQUFHO0FBQUEsRUFDTDtBQUNGO0FBRUEsU0FBUyxrQkFBa0IsV0FBbUQ7QUFDNUUsU0FBTztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsUUFBUTtBQUFBLElBQ1IsUUFBUTtBQUFBLElBQ1IsYUFBYTtBQUFBLElBQ2IsdUJBQXVCO0FBQUEsSUFDdkIsS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLElBQ1QsY0FBYztBQUFBLElBQ2QsT0FBTztBQUFBLE1BQ0wsYUFBYSxFQUFFLElBQUksT0FBTztBQUFBLE1BQzFCLFlBQVksRUFBRSxJQUFJLE9BQU87QUFBQSxJQUMzQjtBQUFBLElBQ0EsR0FBRztBQUFBLEVBQ0w7QUFDRjtBQUVBLFNBQVMsU0FBUyxXQUFtRTtBQUNuRixTQUFPO0FBQUEsSUFDTCw0QkFBNEIsTUFBTSxDQUFDO0FBQUEsSUFDbkMscUJBQXFCLE9BQU8sRUFBRSxJQUFJLE1BQU0sWUFBWSxHQUFHO0FBQUEsSUFDdkQscUJBQXFCLE1BQU07QUFBQSxJQUFDO0FBQUEsSUFDNUIsa0JBQWtCLE1BQU07QUFBQSxJQUFDO0FBQUEsSUFDekIsZ0JBQWdCLE1BQU07QUFBQSxJQUFDO0FBQUEsSUFDdkIsR0FBRztBQUFBLEVBQ0w7QUFD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
