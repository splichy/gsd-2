import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createDbTransactionRunner } from "../db-transaction.js";
class FakeTransactionControls {
  calls = [];
  failCall = /* @__PURE__ */ new Set();
  begin() {
    this.record("BEGIN");
  }
  beginRead() {
    this.record("BEGIN DEFERRED");
  }
  commit() {
    this.record("COMMIT");
  }
  rollback() {
    this.record("ROLLBACK");
  }
  record(call) {
    this.calls.push(call);
    if (this.failCall.has(call)) throw new Error(`failed ${call}`);
  }
}
describe("db-transaction", () => {
  test("commits successful write transactions", () => {
    const runner = createDbTransactionRunner();
    const controls = new FakeTransactionControls();
    const result = runner.transaction(controls, () => {
      assert.equal(runner.isInTransaction(), true);
      return "ok";
    });
    assert.equal(result, "ok");
    assert.equal(runner.isInTransaction(), false);
    assert.deepEqual(controls.calls, ["BEGIN", "COMMIT"]);
  });
  test("rolls back failed write transactions and clears depth", () => {
    const runner = createDbTransactionRunner();
    const controls = new FakeTransactionControls();
    assert.throws(
      () => runner.transaction(controls, () => {
        throw new Error("boom");
      }),
      /boom/
    );
    assert.equal(runner.isInTransaction(), false);
    assert.deepEqual(controls.calls, ["BEGIN", "ROLLBACK"]);
  });
  test("nested transactions do not issue nested BEGIN or COMMIT", () => {
    const runner = createDbTransactionRunner();
    const controls = new FakeTransactionControls();
    runner.transaction(controls, () => {
      runner.transaction(controls, () => {
        assert.equal(runner.isInTransaction(), true);
      });
    });
    assert.deepEqual(controls.calls, ["BEGIN", "COMMIT"]);
  });
  test("failed BEGIN does not mark transaction depth active", () => {
    const runner = createDbTransactionRunner();
    const controls = new FakeTransactionControls();
    controls.failCall.add("BEGIN");
    assert.throws(() => runner.transaction(controls, () => void 0), /failed BEGIN/);
    assert.equal(runner.isInTransaction(), false);
    assert.deepEqual(controls.calls, ["BEGIN"]);
  });
  test("read transactions log rollback failures and clear depth", () => {
    const runner = createDbTransactionRunner();
    const controls = new FakeTransactionControls();
    const rollbackErrors = [];
    controls.failCall.add("ROLLBACK");
    assert.throws(
      () => runner.readTransaction(
        controls,
        () => {
          throw new Error("read failed");
        },
        (error) => rollbackErrors.push(error)
      ),
      /read failed/
    );
    assert.equal(runner.isInTransaction(), false);
    assert.deepEqual(controls.calls, ["BEGIN DEFERRED", "ROLLBACK"]);
    assert.equal(rollbackErrors.length, 1);
    assert.match(rollbackErrors[0].message, /failed ROLLBACK/);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9kYi10cmFuc2FjdGlvbi50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBQcm9qZWN0L0FwcDogR1NELTJcbi8vIEZpbGUgUHVycG9zZTogVGVzdHMgZm9yIERCIHRyYW5zYWN0aW9uIGRlcHRoIGFuZCByb2xsYmFjayBoZWxwZXJzLlxuXG5pbXBvcnQgeyBkZXNjcmliZSwgdGVzdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgY3JlYXRlRGJUcmFuc2FjdGlvblJ1bm5lciwgdHlwZSBEYlRyYW5zYWN0aW9uQ29udHJvbHMgfSBmcm9tIFwiLi4vZGItdHJhbnNhY3Rpb24udHNcIjtcblxuY2xhc3MgRmFrZVRyYW5zYWN0aW9uQ29udHJvbHMgaW1wbGVtZW50cyBEYlRyYW5zYWN0aW9uQ29udHJvbHMge1xuICByZWFkb25seSBjYWxsczogc3RyaW5nW10gPSBbXTtcbiAgZmFpbENhbGwgPSBuZXcgU2V0PHN0cmluZz4oKTtcblxuICBiZWdpbigpOiB2b2lkIHtcbiAgICB0aGlzLnJlY29yZChcIkJFR0lOXCIpO1xuICB9XG5cbiAgYmVnaW5SZWFkKCk6IHZvaWQge1xuICAgIHRoaXMucmVjb3JkKFwiQkVHSU4gREVGRVJSRURcIik7XG4gIH1cblxuICBjb21taXQoKTogdm9pZCB7XG4gICAgdGhpcy5yZWNvcmQoXCJDT01NSVRcIik7XG4gIH1cblxuICByb2xsYmFjaygpOiB2b2lkIHtcbiAgICB0aGlzLnJlY29yZChcIlJPTExCQUNLXCIpO1xuICB9XG5cbiAgcHJpdmF0ZSByZWNvcmQoY2FsbDogc3RyaW5nKTogdm9pZCB7XG4gICAgdGhpcy5jYWxscy5wdXNoKGNhbGwpO1xuICAgIGlmICh0aGlzLmZhaWxDYWxsLmhhcyhjYWxsKSkgdGhyb3cgbmV3IEVycm9yKGBmYWlsZWQgJHtjYWxsfWApO1xuICB9XG59XG5cbmRlc2NyaWJlKFwiZGItdHJhbnNhY3Rpb25cIiwgKCkgPT4ge1xuICB0ZXN0KFwiY29tbWl0cyBzdWNjZXNzZnVsIHdyaXRlIHRyYW5zYWN0aW9uc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgcnVubmVyID0gY3JlYXRlRGJUcmFuc2FjdGlvblJ1bm5lcigpO1xuICAgIGNvbnN0IGNvbnRyb2xzID0gbmV3IEZha2VUcmFuc2FjdGlvbkNvbnRyb2xzKCk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBydW5uZXIudHJhbnNhY3Rpb24oY29udHJvbHMsICgpID0+IHtcbiAgICAgIGFzc2VydC5lcXVhbChydW5uZXIuaXNJblRyYW5zYWN0aW9uKCksIHRydWUpO1xuICAgICAgcmV0dXJuIFwib2tcIjtcbiAgICB9KTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIFwib2tcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJ1bm5lci5pc0luVHJhbnNhY3Rpb24oKSwgZmFsc2UpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwoY29udHJvbHMuY2FsbHMsIFtcIkJFR0lOXCIsIFwiQ09NTUlUXCJdKTtcbiAgfSk7XG5cbiAgdGVzdChcInJvbGxzIGJhY2sgZmFpbGVkIHdyaXRlIHRyYW5zYWN0aW9ucyBhbmQgY2xlYXJzIGRlcHRoXCIsICgpID0+IHtcbiAgICBjb25zdCBydW5uZXIgPSBjcmVhdGVEYlRyYW5zYWN0aW9uUnVubmVyKCk7XG4gICAgY29uc3QgY29udHJvbHMgPSBuZXcgRmFrZVRyYW5zYWN0aW9uQ29udHJvbHMoKTtcblxuICAgIGFzc2VydC50aHJvd3MoXG4gICAgICAoKSA9PiBydW5uZXIudHJhbnNhY3Rpb24oY29udHJvbHMsICgpID0+IHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiYm9vbVwiKTtcbiAgICAgIH0pLFxuICAgICAgL2Jvb20vLFxuICAgICk7XG5cbiAgICBhc3NlcnQuZXF1YWwocnVubmVyLmlzSW5UcmFuc2FjdGlvbigpLCBmYWxzZSk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChjb250cm9scy5jYWxscywgW1wiQkVHSU5cIiwgXCJST0xMQkFDS1wiXSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJuZXN0ZWQgdHJhbnNhY3Rpb25zIGRvIG5vdCBpc3N1ZSBuZXN0ZWQgQkVHSU4gb3IgQ09NTUlUXCIsICgpID0+IHtcbiAgICBjb25zdCBydW5uZXIgPSBjcmVhdGVEYlRyYW5zYWN0aW9uUnVubmVyKCk7XG4gICAgY29uc3QgY29udHJvbHMgPSBuZXcgRmFrZVRyYW5zYWN0aW9uQ29udHJvbHMoKTtcblxuICAgIHJ1bm5lci50cmFuc2FjdGlvbihjb250cm9scywgKCkgPT4ge1xuICAgICAgcnVubmVyLnRyYW5zYWN0aW9uKGNvbnRyb2xzLCAoKSA9PiB7XG4gICAgICAgIGFzc2VydC5lcXVhbChydW5uZXIuaXNJblRyYW5zYWN0aW9uKCksIHRydWUpO1xuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICBhc3NlcnQuZGVlcEVxdWFsKGNvbnRyb2xzLmNhbGxzLCBbXCJCRUdJTlwiLCBcIkNPTU1JVFwiXSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJmYWlsZWQgQkVHSU4gZG9lcyBub3QgbWFyayB0cmFuc2FjdGlvbiBkZXB0aCBhY3RpdmVcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJ1bm5lciA9IGNyZWF0ZURiVHJhbnNhY3Rpb25SdW5uZXIoKTtcbiAgICBjb25zdCBjb250cm9scyA9IG5ldyBGYWtlVHJhbnNhY3Rpb25Db250cm9scygpO1xuICAgIGNvbnRyb2xzLmZhaWxDYWxsLmFkZChcIkJFR0lOXCIpO1xuXG4gICAgYXNzZXJ0LnRocm93cygoKSA9PiBydW5uZXIudHJhbnNhY3Rpb24oY29udHJvbHMsICgpID0+IHVuZGVmaW5lZCksIC9mYWlsZWQgQkVHSU4vKTtcblxuICAgIGFzc2VydC5lcXVhbChydW5uZXIuaXNJblRyYW5zYWN0aW9uKCksIGZhbHNlKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKGNvbnRyb2xzLmNhbGxzLCBbXCJCRUdJTlwiXSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJyZWFkIHRyYW5zYWN0aW9ucyBsb2cgcm9sbGJhY2sgZmFpbHVyZXMgYW5kIGNsZWFyIGRlcHRoXCIsICgpID0+IHtcbiAgICBjb25zdCBydW5uZXIgPSBjcmVhdGVEYlRyYW5zYWN0aW9uUnVubmVyKCk7XG4gICAgY29uc3QgY29udHJvbHMgPSBuZXcgRmFrZVRyYW5zYWN0aW9uQ29udHJvbHMoKTtcbiAgICBjb25zdCByb2xsYmFja0Vycm9yczogRXJyb3JbXSA9IFtdO1xuICAgIGNvbnRyb2xzLmZhaWxDYWxsLmFkZChcIlJPTExCQUNLXCIpO1xuXG4gICAgYXNzZXJ0LnRocm93cyhcbiAgICAgICgpID0+IHJ1bm5lci5yZWFkVHJhbnNhY3Rpb24oXG4gICAgICAgIGNvbnRyb2xzLFxuICAgICAgICAoKSA9PiB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwicmVhZCBmYWlsZWRcIik7XG4gICAgICAgIH0sXG4gICAgICAgIChlcnJvcikgPT4gcm9sbGJhY2tFcnJvcnMucHVzaChlcnJvciksXG4gICAgICApLFxuICAgICAgL3JlYWQgZmFpbGVkLyxcbiAgICApO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJ1bm5lci5pc0luVHJhbnNhY3Rpb24oKSwgZmFsc2UpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwoY29udHJvbHMuY2FsbHMsIFtcIkJFR0lOIERFRkVSUkVEXCIsIFwiUk9MTEJBQ0tcIl0pO1xuICAgIGFzc2VydC5lcXVhbChyb2xsYmFja0Vycm9ycy5sZW5ndGgsIDEpO1xuICAgIGFzc2VydC5tYXRjaChyb2xsYmFja0Vycm9yc1swXS5tZXNzYWdlLCAvZmFpbGVkIFJPTExCQUNLLyk7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFHQSxTQUFTLFVBQVUsWUFBWTtBQUMvQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxpQ0FBNkQ7QUFFdEUsTUFBTSx3QkFBeUQ7QUFBQSxFQUNwRCxRQUFrQixDQUFDO0FB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
