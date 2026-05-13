import test from "node:test";
import assert from "node:assert/strict";
import { closeDatabase, openDatabase, _getAdapter } from "../gsd-db.js";
import { UokGateRunner } from "../uok/gate-runner.js";
test.beforeEach(() => {
  closeDatabase();
  const ok = openDatabase(":memory:");
  assert.equal(ok, true);
});
test.afterEach(() => {
  closeDatabase();
});
test("uok gate runner retries timeout failures using deterministic matrix", async () => {
  const runner = new UokGateRunner();
  let calls = 0;
  runner.register({
    id: "timeout-gate",
    type: "verification",
    execute: async (_ctx, attempt) => {
      calls += 1;
      if (attempt < 2) {
        return {
          outcome: "fail",
          failureClass: "timeout",
          rationale: "first attempt timed out"
        };
      }
      return {
        outcome: "pass",
        failureClass: "none",
        rationale: "second attempt passed"
      };
    }
  });
  const result = await runner.run("timeout-gate", {
    basePath: process.cwd(),
    traceId: "trace-a",
    turnId: "turn-a",
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01"
  });
  assert.equal(result.outcome, "pass");
  assert.equal(calls, 2);
  const adapter = _getAdapter();
  const rows = adapter?.prepare("SELECT gate_id, outcome, attempt FROM gate_runs ORDER BY id").all() ?? [];
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.["outcome"], "retry");
  assert.equal(rows[1]?.["outcome"], "pass");
});
test("uok gate runner returns manual-attention for unknown gate id", async () => {
  const runner = new UokGateRunner();
  const result = await runner.run("missing-gate", {
    basePath: process.cwd(),
    traceId: "trace-b",
    turnId: "turn-b"
  });
  assert.equal(result.outcome, "manual-attention");
  assert.equal(result.failureClass, "unknown");
});
test("uok gate runner: gate.execute throws \u2014 outcome is fail, audit emitted, DB row written, no exception escapes", async () => {
  const runner = new UokGateRunner();
  runner.register({
    id: "throwing-gate",
    type: "verification",
    execute: async () => {
      throw new Error("unexpected runtime failure");
    }
  });
  let threw = false;
  let result;
  try {
    result = await runner.run("throwing-gate", {
      basePath: process.cwd(),
      traceId: "trace-throw",
      turnId: "turn-throw"
    });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "run() must not throw when gate.execute throws");
  assert.equal(result?.outcome, "fail");
  assert.equal(result?.failureClass, "unknown");
  assert.equal(result?.rationale, "unexpected runtime failure");
  const adapter = _getAdapter();
  const rows = adapter?.prepare("SELECT gate_id, outcome, failure_class FROM gate_runs WHERE gate_id = 'throwing-gate'").all() ?? [];
  assert.ok(rows.length >= 1, "at least one DB row must be written for a thrown gate");
  assert.equal(rows[0]?.["outcome"], "fail");
});
test("uok gate runner: unknown gate id emits audit + DB row with manual-attention", async () => {
  const runner = new UokGateRunner();
  await runner.run("ghost-gate", {
    basePath: process.cwd(),
    traceId: "trace-ghost",
    turnId: "turn-ghost"
  });
  const adapter = _getAdapter();
  const rows = adapter?.prepare("SELECT gate_id, outcome, failure_class FROM gate_runs WHERE gate_id = 'ghost-gate'").all() ?? [];
  assert.equal(rows.length, 1, "unknown gate must write exactly one DB row");
  assert.equal(rows[0]?.["outcome"], "manual-attention");
});
test("uok gate runner: maxAttempts reported equals retryBudget + 1", async () => {
  const runner = new UokGateRunner();
  runner.register({
    id: "budget-gate",
    type: "verification",
    execute: async () => ({
      outcome: "fail",
      failureClass: "timeout",
      rationale: "always fails"
    })
  });
  const result = await runner.run("budget-gate", {
    basePath: process.cwd(),
    traceId: "trace-budget",
    turnId: "turn-budget"
  });
  assert.equal(result.maxAttempts, 3, "maxAttempts must equal retryBudget + 1");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy91b2stZ2F0ZS1ydW5uZXIudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5cbmltcG9ydCB7IGNsb3NlRGF0YWJhc2UsIG9wZW5EYXRhYmFzZSwgX2dldEFkYXB0ZXIgfSBmcm9tIFwiLi4vZ3NkLWRiLnRzXCI7XG5pbXBvcnQgeyBVb2tHYXRlUnVubmVyIH0gZnJvbSBcIi4uL3Vvay9nYXRlLXJ1bm5lci50c1wiO1xuXG50ZXN0LmJlZm9yZUVhY2goKCkgPT4ge1xuICBjbG9zZURhdGFiYXNlKCk7XG4gIGNvbnN0IG9rID0gb3BlbkRhdGFiYXNlKFwiOm1lbW9yeTpcIik7XG4gIGFzc2VydC5lcXVhbChvaywgdHJ1ZSk7XG59KTtcblxudGVzdC5hZnRlckVhY2goKCkgPT4ge1xuICBjbG9zZURhdGFiYXNlKCk7XG59KTtcblxudGVzdChcInVvayBnYXRlIHJ1bm5lciByZXRyaWVzIHRpbWVvdXQgZmFpbHVyZXMgdXNpbmcgZGV0ZXJtaW5pc3RpYyBtYXRyaXhcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBydW5uZXIgPSBuZXcgVW9rR2F0ZVJ1bm5lcigpO1xuXG4gIGxldCBjYWxscyA9IDA7XG4gIHJ1bm5lci5yZWdpc3Rlcih7XG4gICAgaWQ6IFwidGltZW91dC1nYXRlXCIsXG4gICAgdHlwZTogXCJ2ZXJpZmljYXRpb25cIixcbiAgICBleGVjdXRlOiBhc3luYyAoX2N0eCwgYXR0ZW1wdCkgPT4ge1xuICAgICAgY2FsbHMgKz0gMTtcbiAgICAgIGlmIChhdHRlbXB0IDwgMikge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIG91dGNvbWU6IFwiZmFpbFwiLFxuICAgICAgICAgIGZhaWx1cmVDbGFzczogXCJ0aW1lb3V0XCIsXG4gICAgICAgICAgcmF0aW9uYWxlOiBcImZpcnN0IGF0dGVtcHQgdGltZWQgb3V0XCIsXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvdXRjb21lOiBcInBhc3NcIixcbiAgICAgICAgZmFpbHVyZUNsYXNzOiBcIm5vbmVcIixcbiAgICAgICAgcmF0aW9uYWxlOiBcInNlY29uZCBhdHRlbXB0IHBhc3NlZFwiLFxuICAgICAgfTtcbiAgICB9LFxuICB9KTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5uZXIucnVuKFwidGltZW91dC1nYXRlXCIsIHtcbiAgICBiYXNlUGF0aDogcHJvY2Vzcy5jd2QoKSxcbiAgICB0cmFjZUlkOiBcInRyYWNlLWFcIixcbiAgICB0dXJuSWQ6IFwidHVybi1hXCIsXG4gICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgIHNsaWNlSWQ6IFwiUzAxXCIsXG4gICAgdGFza0lkOiBcIlQwMVwiLFxuICB9KTtcblxuICBhc3NlcnQuZXF1YWwocmVzdWx0Lm91dGNvbWUsIFwicGFzc1wiKTtcbiAgYXNzZXJ0LmVxdWFsKGNhbGxzLCAyKTtcblxuICBjb25zdCBhZGFwdGVyID0gX2dldEFkYXB0ZXIoKTtcbiAgY29uc3Qgcm93cyA9IGFkYXB0ZXI/LnByZXBhcmUoXCJTRUxFQ1QgZ2F0ZV9pZCwgb3V0Y29tZSwgYXR0ZW1wdCBGUk9NIGdhdGVfcnVucyBPUkRFUiBCWSBpZFwiKS5hbGwoKSA/PyBbXTtcbiAgYXNzZXJ0LmVxdWFsKHJvd3MubGVuZ3RoLCAyKTtcbiAgYXNzZXJ0LmVxdWFsKHJvd3NbMF0/LltcIm91dGNvbWVcIl0sIFwicmV0cnlcIik7XG4gIGFzc2VydC5lcXVhbChyb3dzWzFdPy5bXCJvdXRjb21lXCJdLCBcInBhc3NcIik7XG59KTtcblxudGVzdChcInVvayBnYXRlIHJ1bm5lciByZXR1cm5zIG1hbnVhbC1hdHRlbnRpb24gZm9yIHVua25vd24gZ2F0ZSBpZFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHJ1bm5lciA9IG5ldyBVb2tHYXRlUnVubmVyKCk7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bm5lci5ydW4oXCJtaXNzaW5nLWdhdGVcIiwge1xuICAgIGJhc2VQYXRoOiBwcm9jZXNzLmN3ZCgpLFxuICAgIHRyYWNlSWQ6IFwidHJhY2UtYlwiLFxuICAgIHR1cm5JZDogXCJ0dXJuLWJcIixcbiAgfSk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5vdXRjb21lLCBcIm1hbnVhbC1hdHRlbnRpb25cIik7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQuZmFpbHVyZUNsYXNzLCBcInVua25vd25cIik7XG59KTtcblxuLy8gUmVncmVzc2lvbiB0ZXN0cyBmb3IgIzQ5NTBcblxudGVzdChcInVvayBnYXRlIHJ1bm5lcjogZ2F0ZS5leGVjdXRlIHRocm93cyBcdTIwMTQgb3V0Y29tZSBpcyBmYWlsLCBhdWRpdCBlbWl0dGVkLCBEQiByb3cgd3JpdHRlbiwgbm8gZXhjZXB0aW9uIGVzY2FwZXNcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBydW5uZXIgPSBuZXcgVW9rR2F0ZVJ1bm5lcigpO1xuXG4gIHJ1bm5lci5yZWdpc3Rlcih7XG4gICAgaWQ6IFwidGhyb3dpbmctZ2F0ZVwiLFxuICAgIHR5cGU6IFwidmVyaWZpY2F0aW9uXCIsXG4gICAgZXhlY3V0ZTogYXN5bmMgKCkgPT4ge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwidW5leHBlY3RlZCBydW50aW1lIGZhaWx1cmVcIik7XG4gICAgfSxcbiAgfSk7XG5cbiAgbGV0IHRocmV3ID0gZmFsc2U7XG4gIGxldCByZXN1bHQ7XG4gIHRyeSB7XG4gICAgcmVzdWx0ID0gYXdhaXQgcnVubmVyLnJ1bihcInRocm93aW5nLWdhdGVcIiwge1xuICAgICAgYmFzZVBhdGg6IHByb2Nlc3MuY3dkKCksXG4gICAgICB0cmFjZUlkOiBcInRyYWNlLXRocm93XCIsXG4gICAgICB0dXJuSWQ6IFwidHVybi10aHJvd1wiLFxuICAgIH0pO1xuICB9IGNhdGNoIHtcbiAgICB0aHJldyA9IHRydWU7XG4gIH1cblxuICBhc3NlcnQuZXF1YWwodGhyZXcsIGZhbHNlLCBcInJ1bigpIG11c3Qgbm90IHRocm93IHdoZW4gZ2F0ZS5leGVjdXRlIHRocm93c1wiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdD8ub3V0Y29tZSwgXCJmYWlsXCIpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0Py5mYWlsdXJlQ2xhc3MsIFwidW5rbm93blwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdD8ucmF0aW9uYWxlLCBcInVuZXhwZWN0ZWQgcnVudGltZSBmYWlsdXJlXCIpO1xuXG4gIGNvbnN0IGFkYXB0ZXIgPSBfZ2V0QWRhcHRlcigpO1xuICBjb25zdCByb3dzID0gYWRhcHRlcj8ucHJlcGFyZShcIlNFTEVDVCBnYXRlX2lkLCBvdXRjb21lLCBmYWlsdXJlX2NsYXNzIEZST00gZ2F0ZV9ydW5zIFdIRVJFIGdhdGVfaWQgPSAndGhyb3dpbmctZ2F0ZSdcIikuYWxsKCkgPz8gW107XG4gIGFzc2VydC5vayhyb3dzLmxlbmd0aCA+PSAxLCBcImF0IGxlYXN0IG9uZSBEQiByb3cgbXVzdCBiZSB3cml0dGVuIGZvciBhIHRocm93biBnYXRlXCIpO1xuICBhc3NlcnQuZXF1YWwocm93c1swXT8uW1wib3V0Y29tZVwiXSwgXCJmYWlsXCIpO1xufSk7XG5cbnRlc3QoXCJ1b2sgZ2F0ZSBydW5uZXI6IHVua25vd24gZ2F0ZSBpZCBlbWl0cyBhdWRpdCArIERCIHJvdyB3aXRoIG1hbnVhbC1hdHRlbnRpb25cIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBydW5uZXIgPSBuZXcgVW9rR2F0ZVJ1bm5lcigpO1xuXG4gIGF3YWl0IHJ1bm5lci5ydW4oXCJnaG9zdC1nYXRlXCIsIHtcbiAgICBiYXNlUGF0aDogcHJvY2Vzcy5jd2QoKSxcbiAgICB0cmFjZUlkOiBcInRyYWNlLWdob3N0XCIsXG4gICAgdHVybklkOiBcInR1cm4tZ2hvc3RcIixcbiAgfSk7XG5cbiAgY29uc3QgYWRhcHRlciA9IF9nZXRBZGFwdGVyKCk7XG4gIGNvbnN0IHJvd3MgPSBhZGFwdGVyPy5wcmVwYXJlKFwiU0VMRUNUIGdhdGVfaWQsIG91dGNvbWUsIGZhaWx1cmVfY2xhc3MgRlJPTSBnYXRlX3J1bnMgV0hFUkUgZ2F0ZV9pZCA9ICdnaG9zdC1nYXRlJ1wiKS5hbGwoKSA/PyBbXTtcbiAgYXNzZXJ0LmVxdWFsKHJvd3MubGVuZ3RoLCAxLCBcInVua25vd24gZ2F0ZSBtdXN0IHdyaXRlIGV4YWN0bHkgb25lIERCIHJvd1wiKTtcbiAgYXNzZXJ0LmVxdWFsKHJvd3NbMF0/LltcIm91dGNvbWVcIl0sIFwibWFudWFsLWF0dGVudGlvblwiKTtcbn0pO1xuXG50ZXN0KFwidW9rIGdhdGUgcnVubmVyOiBtYXhBdHRlbXB0cyByZXBvcnRlZCBlcXVhbHMgcmV0cnlCdWRnZXQgKyAxXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgcnVubmVyID0gbmV3IFVva0dhdGVSdW5uZXIoKTtcblxuICAvLyB0aW1lb3V0IGhhcyByZXRyeUJ1ZGdldD0yLCBzbyBtYXhBdHRlbXB0cyBzaG91bGQgYmUgM1xuICBydW5uZXIucmVnaXN0ZXIoe1xuICAgIGlkOiBcImJ1ZGdldC1nYXRlXCIsXG4gICAgdHlwZTogXCJ2ZXJpZmljYXRpb25cIixcbiAgICBleGVjdXRlOiBhc3luYyAoKSA9PiAoe1xuICAgICAgb3V0Y29tZTogXCJmYWlsXCIsXG4gICAgICBmYWlsdXJlQ2xhc3M6IFwidGltZW91dFwiLFxuICAgICAgcmF0aW9uYWxlOiBcImFsd2F5cyBmYWlsc1wiLFxuICAgIH0pLFxuICB9KTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5uZXIucnVuKFwiYnVkZ2V0LWdhdGVcIiwge1xuICAgIGJhc2VQYXRoOiBwcm9jZXNzLmN3ZCgpLFxuICAgIHRyYWNlSWQ6IFwidHJhY2UtYnVkZ2V0XCIsXG4gICAgdHVybklkOiBcInR1cm4tYnVkZ2V0XCIsXG4gIH0pO1xuXG4gIC8vIHJldHJ5QnVkZ2V0IGZvciBcInRpbWVvdXRcIiBpcyAyLCBzbyBtYXhBdHRlbXB0cyBtdXN0IGJlIDNcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5tYXhBdHRlbXB0cywgMywgXCJtYXhBdHRlbXB0cyBtdXN0IGVxdWFsIHJldHJ5QnVkZ2V0ICsgMVwiKTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUVuQixTQUFTLGVBQWUsY0FBYyxtQkFBbUI7QUFDekQsU0FBUyxxQkFBcUI7QUFFOUIsS0FBSyxXQUFXLE1BQU07QUFDcEIsZ0JBQWM7QUFDZCxRQUFNLEtBQUssYUFBYSxVQUFVO0FBQ2xDLFNBQU8sTUFBTSxJQUFJLElBQUk7QUFDdkIsQ0FBQztBQUVELEtBQUssVUFBVSxNQUFNO0FBQ25CLGdCQUFjO0FBQ2hCLENBQUM7QUFFRCxLQUFLLHVFQUF1RSxZQUFZO0FBQ3RGLFFBQU0sU0FBUyxJQUFJLGNBQWM7QUFFakMsTUFBSSxRQUFRO0FBQ1osU0FBTyxTQUFTO0FBQUEsSUFDZCxJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixTQUFTLE9BQU8sTUFBTSxZQUFZO0FBQ2hDLGVBQVM7QUFDVCxVQUFJLFVBQVUsR0FBRztBQUNmLGVBQU87QUFBQSxVQUNMLFNBQVM7QUFBQSxVQUNULGNBQWM7QUFBQSxVQUNkLFdBQVc7QUFBQSxRQUNiO0FBQUEsTUFDRjtBQUNBLGFBQU87QUFBQSxRQUNMLFNBQVM7QUFBQSxRQUNULGNBQWM7QUFBQSxRQUNkLFdBQVc7QUFBQSxNQUNiO0FBQUEsSUFDRjtBQUFBLEVBQ0YsQ0FBQztBQUVELFFBQU0sU0FBUyxNQUFNLE9BQU8sSUFBSSxnQkFBZ0I7QUFBQSxJQUM5QyxVQUFVLFFBQVEsSUFBSTtBQUFBLElBQ3RCLFNBQVM7QUFBQSxJQUNULFFBQVE7QUFBQSxJQUNSLGFBQWE7QUFBQSxJQUNiLFNBQVM7QUFBQSxJQUNULFFBQVE7QUFBQSxFQUNWLENBQUM7QUFFRCxTQUFPLE1BQU0sT0FBTyxTQUFTLE1BQU07QUFDbkMsU0FBTyxNQUFNLE9BQU8sQ0FBQztBQUVyQixRQUFNLFVBQVUsWUFBWTtBQUM1QixRQUFNLE9BQU8sU0FBUyxRQUFRLDZEQUE2RCxFQUFFLElBQUksS0FBSyxDQUFDO0FBQ3ZHLFNBQU8sTUFBTSxLQUFLLFFBQVEsQ0FBQztBQUMzQixTQUFPLE1BQU0sS0FBSyxDQUFDLElBQUksU0FBUyxHQUFHLE9BQU87QUFDMUMsU0FBTyxNQUFNLEtBQUssQ0FBQyxJQUFJLFNBQVMsR0FBRyxNQUFNO0FBQzNDLENBQUM7QUFFRCxLQUFLLGdFQUFnRSxZQUFZO0FBQy9FLFFBQU0sU0FBUyxJQUFJLGNBQWM7QUFDakMsUUFBTSxTQUFTLE1BQU0sT0FBTyxJQUFJLGdCQUFnQjtBQUFBLElBQzlDLFVBQVUsUUFBUSxJQUFJO0FBQUEsSUFDdEIsU0FBUztBQUFBLElBQ1QsUUFBUTtBQUFBLEVBQ1YsQ0FBQztBQUVELFNBQU8sTUFBTSxPQUFPLFNBQVMsa0JBQWtCO0FBQy9DLFNBQU8sTUFBTSxPQUFPLGNBQWMsU0FBUztBQUM3QyxDQUFDO0FBSUQsS0FBSyxvSEFBK0csWUFBWTtBQUM5SCxRQUFNLFNBQVMsSUFBSSxjQUFjO0FBRWpDLFNBQU8sU0FBUztBQUFBLElBQ2QsSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sU0FBUyxZQUFZO0FBQ25CLFlBQU0sSUFBSSxNQUFNLDRCQUE0QjtBQUFBLElBQzlDO0FBQUEsRUFDRixDQUFDO0FBRUQsTUFBSSxRQUFRO0FBQ1osTUFBSTtBQUNKLE1BQUk7QUFDRixhQUFTLE1BQU0sT0FBTyxJQUFJLGlCQUFpQjtBQUFBLE1BQ3pDLFVBQVUsUUFBUSxJQUFJO0FBQUEsTUFDdEIsU0FBUztBQUFBLE1BQ1QsUUFBUTtBQUFBLElBQ1YsQ0FBQztBQUFBLEVBQ0gsUUFBUTtBQUNOLFlBQVE7QUFBQSxFQUNWO0FBRUEsU0FBTyxNQUFNLE9BQU8sT0FBTywrQ0FBK0M7QUFDMUUsU0FBTyxNQUFNLFFBQVEsU0FBUyxNQUFNO0FBQ3BDLFNBQU8sTUFBTSxRQUFRLGNBQWMsU0FBUztBQUM1QyxTQUFPLE1BQU0sUUFBUSxXQUFXLDRCQUE0QjtBQUU1RCxRQUFNLFVBQVUsWUFBWTtBQUM1QixRQUFNLE9BQU8sU0FBUyxRQUFRLHVGQUF1RixFQUFFLElBQUksS0FBSyxDQUFDO0FBQ2pJLFNBQU8sR0FBRyxLQUFLLFVBQVUsR0FBRyx1REFBdUQ7QUFDbkYsU0FBTyxNQUFNLEtBQUssQ0FBQyxJQUFJLFNBQVMsR0FBRyxNQUFNO0FBQzNDLENBQUM7QUFFRCxLQUFLLCtFQUErRSxZQUFZO0FBQzlGLFFBQU0sU0FBUyxJQUFJLGNBQWM7QUFFakMsUUFBTSxPQUFPLElBQUksY0FBYztBQUFBLElBQzdCLFVBQVUsUUFBUSxJQUFJO0FBQUEsSUFDdEIsU0FBUztBQUFBLElBQ1QsUUFBUTtBQUFBLEVBQ1YsQ0FBQztBQUVELFFBQU0sVUFBVSxZQUFZO0FBQzVCLFFBQU0sT0FBTyxTQUFTLFFBQVEsb0ZBQW9GLEVBQUUsSUFBSSxLQUFLLENBQUM7QUFDOUgsU0FBTyxNQUFNLEtBQUssUUFBUSxHQUFHLDRDQUE0QztBQUN6RSxTQUFPLE1BQU0sS0FBSyxDQUFDLElBQUksU0FBUyxHQUFHLGtCQUFrQjtBQUN2RCxDQUFDO0FBRUQsS0FBSyxnRUFBZ0UsWUFBWTtBQUMvRSxRQUFNLFNBQVMsSUFBSSxjQUFjO0FBR2pDLFNBQU8sU0FBUztBQUFBLElBQ2QsSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sU0FBUyxhQUFhO0FBQUEsTUFDcEIsU0FBUztBQUFBLE1BQ1QsY0FBYztBQUFBLE1BQ2QsV0FBVztBQUFBLElBQ2I7QUFBQSxFQUNGLENBQUM7QUFFRCxRQUFNLFNBQVMsTUFBTSxPQUFPLElBQUksZUFBZTtBQUFBLElBQzdDLFVBQVUsUUFBUSxJQUFJO0FBQUEsSUFDdEIsU0FBUztBQUFBLElBQ1QsUUFBUTtBQUFBLEVBQ1YsQ0FBQztBQUdELFNBQU8sTUFBTSxPQUFPLGFBQWEsR0FBRyx3Q0FBd0M7QUFDOUUsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
