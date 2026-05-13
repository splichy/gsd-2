import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  scheduleShutdown,
  cancelShutdown,
  isShutdownPending,
  isDaemonMode,
  registerActiveStream,
  recordBoot,
  drainStreams
} from "../shutdown-gate.js";
function resetGate() {
  cancelShutdown();
  if (globalThis.__gsdShutdownGate) {
    globalThis.__gsdShutdownGate.lastBootAt = 0;
    globalThis.__gsdShutdownGate.activeStreams.clear();
  }
  delete process.env.GSD_WEB_DAEMON_MODE;
}
describe("shutdown-gate", () => {
  afterEach(resetGate);
  describe("default mode (no daemon)", () => {
    test("scheduleShutdown() sets a pending timer", () => {
      scheduleShutdown();
      assert.equal(isShutdownPending(), true);
    });
    test("cancelShutdown() clears the pending timer", () => {
      scheduleShutdown();
      cancelShutdown();
      assert.equal(isShutdownPending(), false);
    });
    test("isDaemonMode() returns false", () => {
      assert.equal(isDaemonMode(), false);
    });
  });
  describe("daemon mode (GSD_WEB_DAEMON_MODE=1)", () => {
    beforeEach(() => {
      process.env.GSD_WEB_DAEMON_MODE = "1";
    });
    test("isDaemonMode() returns true", () => {
      assert.equal(isDaemonMode(), true);
    });
    test("scheduleShutdown() does not schedule a timer", () => {
      scheduleShutdown();
      assert.equal(
        isShutdownPending(),
        false,
        "shutdown timer must not be set in daemon mode"
      );
    });
    test("scheduleShutdown() is safe to call multiple times", () => {
      scheduleShutdown();
      scheduleShutdown();
      scheduleShutdown();
      assert.equal(isShutdownPending(), false);
    });
  });
  describe("daemon mode is not activated by other values", () => {
    test("GSD_WEB_DAEMON_MODE=0 does not enable daemon mode", () => {
      process.env.GSD_WEB_DAEMON_MODE = "0";
      assert.equal(isDaemonMode(), false);
      scheduleShutdown();
      assert.equal(isShutdownPending(), true);
    });
    test("GSD_WEB_DAEMON_MODE=true does not enable daemon mode", () => {
      process.env.GSD_WEB_DAEMON_MODE = "true";
      assert.equal(isDaemonMode(), false);
      scheduleShutdown();
      assert.equal(isShutdownPending(), true);
    });
    test("unset GSD_WEB_DAEMON_MODE does not enable daemon mode", () => {
      delete process.env.GSD_WEB_DAEMON_MODE;
      assert.equal(isDaemonMode(), false);
      scheduleShutdown();
      assert.equal(isShutdownPending(), true);
    });
  });
  describe("double-scheduleShutdown resets timer", () => {
    test("calling scheduleShutdown twice still leaves exactly one pending timer", () => {
      scheduleShutdown();
      scheduleShutdown();
      assert.equal(isShutdownPending(), true);
      cancelShutdown();
      assert.equal(isShutdownPending(), false);
    });
  });
  describe("cancelShutdown after timer fires is a no-op", () => {
    test("cancelShutdown() when no timer is pending does not throw", () => {
      assert.equal(isShutdownPending(), false);
      assert.doesNotThrow(() => cancelShutdown());
      assert.equal(isShutdownPending(), false);
    });
  });
  describe("registerActiveStream \u2014 SSE drain", () => {
    test("drainStreams calls registered unsubscribers and clears active streams", () => {
      const calls = [];
      registerActiveStream(() => calls.push(1));
      registerActiveStream(() => calls.push(2));
      assert.equal(globalThis.__gsdShutdownGate.activeStreams.size, 2);
      drainStreams();
      assert.deepEqual(calls, [1, 2]);
      assert.equal(globalThis.__gsdShutdownGate.activeStreams.size, 0);
    });
    test("deregister prevents callback from being called when drainStreams fires", () => {
      let called = false;
      const deregister = registerActiveStream(() => {
        called = true;
      });
      deregister();
      drainStreams();
      assert.equal(called, false, "deregister must prevent the callback from being called on drain");
      assert.equal(globalThis.__gsdShutdownGate.activeStreams.size, 0);
    });
    test("deregister function removes stream from active set", () => {
      let callCount = 0;
      const deregister = registerActiveStream(() => {
        callCount++;
      });
      assert.equal(globalThis.__gsdShutdownGate.activeStreams.size, 1);
      deregister();
      assert.equal(globalThis.__gsdShutdownGate.activeStreams.size, 0);
      assert.equal(callCount, 0);
    });
    test("multiple streams can be registered and deregistered independently", () => {
      const calls = [];
      const d1 = registerActiveStream(() => calls.push(1));
      const d2 = registerActiveStream(() => calls.push(2));
      const d3 = registerActiveStream(() => calls.push(3));
      assert.equal(globalThis.__gsdShutdownGate.activeStreams.size, 3);
      d2();
      assert.equal(globalThis.__gsdShutdownGate.activeStreams.size, 2);
      d1();
      d3();
      assert.equal(globalThis.__gsdShutdownGate.activeStreams.size, 0);
      assert.deepEqual(calls, [], "no unsubscribers should have fired");
    });
  });
  describe("recordBoot \u2014 phantom-shutdown guard", () => {
    test("recordBoot updates lastBootAt to a recent timestamp", () => {
      const before = Date.now();
      recordBoot();
      const after = Date.now();
      const lastBoot = globalThis.__gsdShutdownGate.lastBootAt;
      assert.ok(lastBoot >= before && lastBoot <= after, "lastBootAt must be within test window");
    });
    test("boot-then-shutdown ordering: lastBootAt is set before timer arms", () => {
      recordBoot();
      scheduleShutdown();
      assert.equal(isShutdownPending(), true);
      cancelShutdown();
    });
    test("shutdown-then-boot ordering: cancelShutdown clears the timer", () => {
      scheduleShutdown();
      assert.equal(isShutdownPending(), true);
      recordBoot();
      cancelShutdown();
      assert.equal(isShutdownPending(), false);
    });
  });
  describe("HMR singleton", () => {
    test("globalThis.__gsdShutdownGate is defined after module load", () => {
      assert.ok(globalThis.__gsdShutdownGate, "singleton must exist on globalThis");
      assert.ok(globalThis.__gsdShutdownGate.activeStreams instanceof Set);
      assert.equal(typeof globalThis.__gsdShutdownGate.lastBootAt, "number");
      assert.equal(typeof globalThis.__gsdShutdownGate.handlersRegistered, "boolean");
    });
    test("module reload does not register duplicate process handlers", async () => {
      const sigtermListeners = process.listenerCount("SIGTERM");
      const beforeExitListeners = process.listenerCount("beforeExit");
      await import(`../shutdown-gate.ts?reload=${Date.now()}`);
      assert.equal(process.listenerCount("SIGTERM"), sigtermListeners);
      assert.equal(process.listenerCount("beforeExit"), beforeExitListeners);
    });
    test("isShutdownPending reflects gate.shutdownTimer (singleton coherence)", () => {
      scheduleShutdown();
      assert.equal(globalThis.__gsdShutdownGate.shutdownTimer !== null, true);
      assert.equal(isShutdownPending(), true);
      cancelShutdown();
      assert.equal(globalThis.__gsdShutdownGate.shutdownTimer, null);
      assert.equal(isShutdownPending(), false);
    });
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vd2ViL2xpYi9fX3Rlc3RzX18vc2h1dGRvd24tZ2F0ZS50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBHU0QtMiBXZWIgXHUyMDE0IFNodXRkb3duIGdhdGUgcmVncmVzc2lvbiB0ZXN0c1xuaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QsIGJlZm9yZUVhY2gsIGFmdGVyRWFjaCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuXG5pbXBvcnQge1xuICBzY2hlZHVsZVNodXRkb3duLFxuICBjYW5jZWxTaHV0ZG93bixcbiAgaXNTaHV0ZG93blBlbmRpbmcsXG4gIGlzRGFlbW9uTW9kZSxcbiAgcmVnaXN0ZXJBY3RpdmVTdHJlYW0sXG4gIHJlY29yZEJvb3QsXG4gIGRyYWluU3RyZWFtcyxcbn0gZnJvbSBcIi4uL3NodXRkb3duLWdhdGUudHNcIjtcblxuLy8gUmVzZXQgZ2F0ZSBzdGF0ZSBiZXR3ZWVuIHRlc3RzIGJ5IGNhbmNlbGxpbmcgYW55IHBlbmRpbmcgc2h1dGRvd24gYW5kXG4vLyBjbGVhcmluZyBlbnYgdmFycy4gV2UgYWxzbyByZXNldCBsYXN0Qm9vdEF0IHZpYSByZWNvcmRCb290IHRyaWNrIChzZXQgdG8gMFxuLy8gYnkgY2FuY2VsbGluZykgXHUyMDE0IGFjdHVhbGx5IHdlIHJlYWNoIGludG8gZ2xvYmFsVGhpcyBmb3IgYSBjbGVhbiByZXNldC5cbmZ1bmN0aW9uIHJlc2V0R2F0ZSgpIHtcbiAgY2FuY2VsU2h1dGRvd24oKTtcbiAgLy8gUmVzZXQgbGFzdEJvb3RBdCBzbyBwaGFudG9tLXNodXRkb3duIGd1YXJkIGRvZXNuJ3QgaW50ZXJmZXJlXG4gIGlmIChnbG9iYWxUaGlzLl9fZ3NkU2h1dGRvd25HYXRlKSB7XG4gICAgZ2xvYmFsVGhpcy5fX2dzZFNodXRkb3duR2F0ZS5sYXN0Qm9vdEF0ID0gMDtcbiAgICBnbG9iYWxUaGlzLl9fZ3NkU2h1dGRvd25HYXRlLmFjdGl2ZVN0cmVhbXMuY2xlYXIoKTtcbiAgfVxuICBkZWxldGUgcHJvY2Vzcy5lbnYuR1NEX1dFQl9EQUVNT05fTU9ERTtcbn1cblxuZGVzY3JpYmUoXCJzaHV0ZG93bi1nYXRlXCIsICgpID0+IHtcbiAgYWZ0ZXJFYWNoKHJlc2V0R2F0ZSk7XG5cbiAgZGVzY3JpYmUoXCJkZWZhdWx0IG1vZGUgKG5vIGRhZW1vbilcIiwgKCkgPT4ge1xuICAgIHRlc3QoXCJzY2hlZHVsZVNodXRkb3duKCkgc2V0cyBhIHBlbmRpbmcgdGltZXJcIiwgKCkgPT4ge1xuICAgICAgc2NoZWR1bGVTaHV0ZG93bigpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGlzU2h1dGRvd25QZW5kaW5nKCksIHRydWUpO1xuICAgIH0pO1xuXG4gICAgdGVzdChcImNhbmNlbFNodXRkb3duKCkgY2xlYXJzIHRoZSBwZW5kaW5nIHRpbWVyXCIsICgpID0+IHtcbiAgICAgIHNjaGVkdWxlU2h1dGRvd24oKTtcbiAgICAgIGNhbmNlbFNodXRkb3duKCk7XG4gICAgICBhc3NlcnQuZXF1YWwoaXNTaHV0ZG93blBlbmRpbmcoKSwgZmFsc2UpO1xuICAgIH0pO1xuXG4gICAgdGVzdChcImlzRGFlbW9uTW9kZSgpIHJldHVybnMgZmFsc2VcIiwgKCkgPT4ge1xuICAgICAgYXNzZXJ0LmVxdWFsKGlzRGFlbW9uTW9kZSgpLCBmYWxzZSk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKFwiZGFlbW9uIG1vZGUgKEdTRF9XRUJfREFFTU9OX01PREU9MSlcIiwgKCkgPT4ge1xuICAgIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgICAgcHJvY2Vzcy5lbnYuR1NEX1dFQl9EQUVNT05fTU9ERSA9IFwiMVwiO1xuICAgIH0pO1xuXG4gICAgdGVzdChcImlzRGFlbW9uTW9kZSgpIHJldHVybnMgdHJ1ZVwiLCAoKSA9PiB7XG4gICAgICBhc3NlcnQuZXF1YWwoaXNEYWVtb25Nb2RlKCksIHRydWUpO1xuICAgIH0pO1xuXG4gICAgdGVzdChcInNjaGVkdWxlU2h1dGRvd24oKSBkb2VzIG5vdCBzY2hlZHVsZSBhIHRpbWVyXCIsICgpID0+IHtcbiAgICAgIHNjaGVkdWxlU2h1dGRvd24oKTtcbiAgICAgIGFzc2VydC5lcXVhbChcbiAgICAgICAgaXNTaHV0ZG93blBlbmRpbmcoKSxcbiAgICAgICAgZmFsc2UsXG4gICAgICAgIFwic2h1dGRvd24gdGltZXIgbXVzdCBub3QgYmUgc2V0IGluIGRhZW1vbiBtb2RlXCIsXG4gICAgICApO1xuICAgIH0pO1xuXG4gICAgdGVzdChcInNjaGVkdWxlU2h1dGRvd24oKSBpcyBzYWZlIHRvIGNhbGwgbXVsdGlwbGUgdGltZXNcIiwgKCkgPT4ge1xuICAgICAgc2NoZWR1bGVTaHV0ZG93bigpO1xuICAgICAgc2NoZWR1bGVTaHV0ZG93bigpO1xuICAgICAgc2NoZWR1bGVTaHV0ZG93bigpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGlzU2h1dGRvd25QZW5kaW5nKCksIGZhbHNlKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoXCJkYWVtb24gbW9kZSBpcyBub3QgYWN0aXZhdGVkIGJ5IG90aGVyIHZhbHVlc1wiLCAoKSA9PiB7XG4gICAgdGVzdChcIkdTRF9XRUJfREFFTU9OX01PREU9MCBkb2VzIG5vdCBlbmFibGUgZGFlbW9uIG1vZGVcIiwgKCkgPT4ge1xuICAgICAgcHJvY2Vzcy5lbnYuR1NEX1dFQl9EQUVNT05fTU9ERSA9IFwiMFwiO1xuICAgICAgYXNzZXJ0LmVxdWFsKGlzRGFlbW9uTW9kZSgpLCBmYWxzZSk7XG4gICAgICBzY2hlZHVsZVNodXRkb3duKCk7XG4gICAgICBhc3NlcnQuZXF1YWwoaXNTaHV0ZG93blBlbmRpbmcoKSwgdHJ1ZSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KFwiR1NEX1dFQl9EQUVNT05fTU9ERT10cnVlIGRvZXMgbm90IGVuYWJsZSBkYWVtb24gbW9kZVwiLCAoKSA9PiB7XG4gICAgICBwcm9jZXNzLmVudi5HU0RfV0VCX0RBRU1PTl9NT0RFID0gXCJ0cnVlXCI7XG4gICAgICBhc3NlcnQuZXF1YWwoaXNEYWVtb25Nb2RlKCksIGZhbHNlKTtcbiAgICAgIHNjaGVkdWxlU2h1dGRvd24oKTtcbiAgICAgIGFzc2VydC5lcXVhbChpc1NodXRkb3duUGVuZGluZygpLCB0cnVlKTtcbiAgICB9KTtcblxuICAgIHRlc3QoXCJ1bnNldCBHU0RfV0VCX0RBRU1PTl9NT0RFIGRvZXMgbm90IGVuYWJsZSBkYWVtb24gbW9kZVwiLCAoKSA9PiB7XG4gICAgICBkZWxldGUgcHJvY2Vzcy5lbnYuR1NEX1dFQl9EQUVNT05fTU9ERTtcbiAgICAgIGFzc2VydC5lcXVhbChpc0RhZW1vbk1vZGUoKSwgZmFsc2UpO1xuICAgICAgc2NoZWR1bGVTaHV0ZG93bigpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGlzU2h1dGRvd25QZW5kaW5nKCksIHRydWUpO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZShcImRvdWJsZS1zY2hlZHVsZVNodXRkb3duIHJlc2V0cyB0aW1lclwiLCAoKSA9PiB7XG4gICAgdGVzdChcImNhbGxpbmcgc2NoZWR1bGVTaHV0ZG93biB0d2ljZSBzdGlsbCBsZWF2ZXMgZXhhY3RseSBvbmUgcGVuZGluZyB0aW1lclwiLCAoKSA9PiB7XG4gICAgICBzY2hlZHVsZVNodXRkb3duKCk7XG4gICAgICBzY2hlZHVsZVNodXRkb3duKCk7XG4gICAgICBhc3NlcnQuZXF1YWwoaXNTaHV0ZG93blBlbmRpbmcoKSwgdHJ1ZSk7XG4gICAgICAvLyBPbmx5IG9uZSB0aW1lciBzaG91bGQgYmUgcGVuZGluZyBcdTIwMTQgY2FuY2VsU2h1dGRvd24gY2xlYXJzIGl0IGNsZWFubHlcbiAgICAgIGNhbmNlbFNodXRkb3duKCk7XG4gICAgICBhc3NlcnQuZXF1YWwoaXNTaHV0ZG93blBlbmRpbmcoKSwgZmFsc2UpO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZShcImNhbmNlbFNodXRkb3duIGFmdGVyIHRpbWVyIGZpcmVzIGlzIGEgbm8tb3BcIiwgKCkgPT4ge1xuICAgIHRlc3QoXCJjYW5jZWxTaHV0ZG93bigpIHdoZW4gbm8gdGltZXIgaXMgcGVuZGluZyBkb2VzIG5vdCB0aHJvd1wiLCAoKSA9PiB7XG4gICAgICBhc3NlcnQuZXF1YWwoaXNTaHV0ZG93blBlbmRpbmcoKSwgZmFsc2UpO1xuICAgICAgYXNzZXJ0LmRvZXNOb3RUaHJvdygoKSA9PiBjYW5jZWxTaHV0ZG93bigpKTtcbiAgICAgIGFzc2VydC5lcXVhbChpc1NodXRkb3duUGVuZGluZygpLCBmYWxzZSk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKFwicmVnaXN0ZXJBY3RpdmVTdHJlYW0gXHUyMDE0IFNTRSBkcmFpblwiLCAoKSA9PiB7XG4gICAgdGVzdChcImRyYWluU3RyZWFtcyBjYWxscyByZWdpc3RlcmVkIHVuc3Vic2NyaWJlcnMgYW5kIGNsZWFycyBhY3RpdmUgc3RyZWFtc1wiLCAoKSA9PiB7XG4gICAgICBjb25zdCBjYWxsczogbnVtYmVyW10gPSBbXTtcbiAgICAgIHJlZ2lzdGVyQWN0aXZlU3RyZWFtKCgpID0+IGNhbGxzLnB1c2goMSkpO1xuICAgICAgcmVnaXN0ZXJBY3RpdmVTdHJlYW0oKCkgPT4gY2FsbHMucHVzaCgyKSk7XG4gICAgICBhc3NlcnQuZXF1YWwoZ2xvYmFsVGhpcy5fX2dzZFNodXRkb3duR2F0ZSEuYWN0aXZlU3RyZWFtcy5zaXplLCAyKTtcbiAgICAgIGRyYWluU3RyZWFtcygpO1xuICAgICAgYXNzZXJ0LmRlZXBFcXVhbChjYWxscywgWzEsIDJdKTtcbiAgICAgIGFzc2VydC5lcXVhbChnbG9iYWxUaGlzLl9fZ3NkU2h1dGRvd25HYXRlIS5hY3RpdmVTdHJlYW1zLnNpemUsIDApO1xuICAgIH0pO1xuXG4gICAgdGVzdChcImRlcmVnaXN0ZXIgcHJldmVudHMgY2FsbGJhY2sgZnJvbSBiZWluZyBjYWxsZWQgd2hlbiBkcmFpblN0cmVhbXMgZmlyZXNcIiwgKCkgPT4ge1xuICAgICAgbGV0IGNhbGxlZCA9IGZhbHNlO1xuICAgICAgY29uc3QgZGVyZWdpc3RlciA9IHJlZ2lzdGVyQWN0aXZlU3RyZWFtKCgpID0+IHtcbiAgICAgICAgY2FsbGVkID0gdHJ1ZTtcbiAgICAgIH0pO1xuXG4gICAgICBkZXJlZ2lzdGVyKCk7XG4gICAgICBkcmFpblN0cmVhbXMoKTtcbiAgICAgIGFzc2VydC5lcXVhbChjYWxsZWQsIGZhbHNlLCBcImRlcmVnaXN0ZXIgbXVzdCBwcmV2ZW50IHRoZSBjYWxsYmFjayBmcm9tIGJlaW5nIGNhbGxlZCBvbiBkcmFpblwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChnbG9iYWxUaGlzLl9fZ3NkU2h1dGRvd25HYXRlIS5hY3RpdmVTdHJlYW1zLnNpemUsIDApO1xuICAgIH0pO1xuXG4gICAgdGVzdChcImRlcmVnaXN0ZXIgZnVuY3Rpb24gcmVtb3ZlcyBzdHJlYW0gZnJvbSBhY3RpdmUgc2V0XCIsICgpID0+IHtcbiAgICAgIGxldCBjYWxsQ291bnQgPSAwO1xuICAgICAgY29uc3QgZGVyZWdpc3RlciA9IHJlZ2lzdGVyQWN0aXZlU3RyZWFtKCgpID0+IHsgY2FsbENvdW50Kys7IH0pO1xuICAgICAgYXNzZXJ0LmVxdWFsKGdsb2JhbFRoaXMuX19nc2RTaHV0ZG93bkdhdGUhLmFjdGl2ZVN0cmVhbXMuc2l6ZSwgMSk7XG4gICAgICBkZXJlZ2lzdGVyKCk7XG4gICAgICBhc3NlcnQuZXF1YWwoZ2xvYmFsVGhpcy5fX2dzZFNodXRkb3duR2F0ZSEuYWN0aXZlU3RyZWFtcy5zaXplLCAwKTtcbiAgICAgIGFzc2VydC5lcXVhbChjYWxsQ291bnQsIDApO1xuICAgIH0pO1xuXG4gICAgdGVzdChcIm11bHRpcGxlIHN0cmVhbXMgY2FuIGJlIHJlZ2lzdGVyZWQgYW5kIGRlcmVnaXN0ZXJlZCBpbmRlcGVuZGVudGx5XCIsICgpID0+IHtcbiAgICAgIGNvbnN0IGNhbGxzOiBudW1iZXJbXSA9IFtdO1xuICAgICAgY29uc3QgZDEgPSByZWdpc3RlckFjdGl2ZVN0cmVhbSgoKSA9PiBjYWxscy5wdXNoKDEpKTtcbiAgICAgIGNvbnN0IGQyID0gcmVnaXN0ZXJBY3RpdmVTdHJlYW0oKCkgPT4gY2FsbHMucHVzaCgyKSk7XG4gICAgICBjb25zdCBkMyA9IHJlZ2lzdGVyQWN0aXZlU3RyZWFtKCgpID0+IGNhbGxzLnB1c2goMykpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGdsb2JhbFRoaXMuX19nc2RTaHV0ZG93bkdhdGUhLmFjdGl2ZVN0cmVhbXMuc2l6ZSwgMyk7XG4gICAgICBkMigpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGdsb2JhbFRoaXMuX19nc2RTaHV0ZG93bkdhdGUhLmFjdGl2ZVN0cmVhbXMuc2l6ZSwgMik7XG4gICAgICBkMSgpO1xuICAgICAgZDMoKTtcbiAgICAgIGFzc2VydC5lcXVhbChnbG9iYWxUaGlzLl9fZ3NkU2h1dGRvd25HYXRlIS5hY3RpdmVTdHJlYW1zLnNpemUsIDApO1xuICAgICAgYXNzZXJ0LmRlZXBFcXVhbChjYWxscywgW10sIFwibm8gdW5zdWJzY3JpYmVycyBzaG91bGQgaGF2ZSBmaXJlZFwiKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoXCJyZWNvcmRCb290IFx1MjAxNCBwaGFudG9tLXNodXRkb3duIGd1YXJkXCIsICgpID0+IHtcbiAgICB0ZXN0KFwicmVjb3JkQm9vdCB1cGRhdGVzIGxhc3RCb290QXQgdG8gYSByZWNlbnQgdGltZXN0YW1wXCIsICgpID0+IHtcbiAgICAgIGNvbnN0IGJlZm9yZSA9IERhdGUubm93KCk7XG4gICAgICByZWNvcmRCb290KCk7XG4gICAgICBjb25zdCBhZnRlciA9IERhdGUubm93KCk7XG4gICAgICBjb25zdCBsYXN0Qm9vdCA9IGdsb2JhbFRoaXMuX19nc2RTaHV0ZG93bkdhdGUhLmxhc3RCb290QXQ7XG4gICAgICBhc3NlcnQub2sobGFzdEJvb3QgPj0gYmVmb3JlICYmIGxhc3RCb290IDw9IGFmdGVyLCBcImxhc3RCb290QXQgbXVzdCBiZSB3aXRoaW4gdGVzdCB3aW5kb3dcIik7XG4gICAgfSk7XG5cbiAgICB0ZXN0KFwiYm9vdC10aGVuLXNodXRkb3duIG9yZGVyaW5nOiBsYXN0Qm9vdEF0IGlzIHNldCBiZWZvcmUgdGltZXIgYXJtc1wiLCAoKSA9PiB7XG4gICAgICAvLyBTaW11bGF0ZTogYm9vdCBhcnJpdmVzLCB0aGVuIHNodXRkb3duIGlzIHNjaGVkdWxlZFxuICAgICAgcmVjb3JkQm9vdCgpO1xuICAgICAgc2NoZWR1bGVTaHV0ZG93bigpO1xuICAgICAgLy8gVGltZXIgaXMgc3RpbGwgcGVuZGluZyAoZ3VhcmQgb25seSBmaXJlcyBpbnNpZGUgdGhlIHRpbWVyIGNhbGxiYWNrKVxuICAgICAgYXNzZXJ0LmVxdWFsKGlzU2h1dGRvd25QZW5kaW5nKCksIHRydWUpO1xuICAgICAgY2FuY2VsU2h1dGRvd24oKTtcbiAgICB9KTtcblxuICAgIHRlc3QoXCJzaHV0ZG93bi10aGVuLWJvb3Qgb3JkZXJpbmc6IGNhbmNlbFNodXRkb3duIGNsZWFycyB0aGUgdGltZXJcIiwgKCkgPT4ge1xuICAgICAgc2NoZWR1bGVTaHV0ZG93bigpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGlzU2h1dGRvd25QZW5kaW5nKCksIHRydWUpO1xuICAgICAgcmVjb3JkQm9vdCgpO1xuICAgICAgY2FuY2VsU2h1dGRvd24oKTtcbiAgICAgIGFzc2VydC5lcXVhbChpc1NodXRkb3duUGVuZGluZygpLCBmYWxzZSk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKFwiSE1SIHNpbmdsZXRvblwiLCAoKSA9PiB7XG4gICAgdGVzdChcImdsb2JhbFRoaXMuX19nc2RTaHV0ZG93bkdhdGUgaXMgZGVmaW5lZCBhZnRlciBtb2R1bGUgbG9hZFwiLCAoKSA9PiB7XG4gICAgICBhc3NlcnQub2soZ2xvYmFsVGhpcy5fX2dzZFNodXRkb3duR2F0ZSwgXCJzaW5nbGV0b24gbXVzdCBleGlzdCBvbiBnbG9iYWxUaGlzXCIpO1xuICAgICAgYXNzZXJ0Lm9rKGdsb2JhbFRoaXMuX19nc2RTaHV0ZG93bkdhdGUuYWN0aXZlU3RyZWFtcyBpbnN0YW5jZW9mIFNldCk7XG4gICAgICBhc3NlcnQuZXF1YWwodHlwZW9mIGdsb2JhbFRoaXMuX19nc2RTaHV0ZG93bkdhdGUubGFzdEJvb3RBdCwgXCJudW1iZXJcIik7XG4gICAgICBhc3NlcnQuZXF1YWwodHlwZW9mIGdsb2JhbFRoaXMuX19nc2RTaHV0ZG93bkdhdGUuaGFuZGxlcnNSZWdpc3RlcmVkLCBcImJvb2xlYW5cIik7XG4gICAgfSk7XG5cbiAgICB0ZXN0KFwibW9kdWxlIHJlbG9hZCBkb2VzIG5vdCByZWdpc3RlciBkdXBsaWNhdGUgcHJvY2VzcyBoYW5kbGVyc1wiLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBzaWd0ZXJtTGlzdGVuZXJzID0gcHJvY2Vzcy5saXN0ZW5lckNvdW50KFwiU0lHVEVSTVwiKTtcbiAgICAgIGNvbnN0IGJlZm9yZUV4aXRMaXN0ZW5lcnMgPSBwcm9jZXNzLmxpc3RlbmVyQ291bnQoXCJiZWZvcmVFeGl0XCIpO1xuXG4gICAgICBhd2FpdCBpbXBvcnQoYC4uL3NodXRkb3duLWdhdGUudHM/cmVsb2FkPSR7RGF0ZS5ub3coKX1gKTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKHByb2Nlc3MubGlzdGVuZXJDb3VudChcIlNJR1RFUk1cIiksIHNpZ3Rlcm1MaXN0ZW5lcnMpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHByb2Nlc3MubGlzdGVuZXJDb3VudChcImJlZm9yZUV4aXRcIiksIGJlZm9yZUV4aXRMaXN0ZW5lcnMpO1xuICAgIH0pO1xuXG4gICAgdGVzdChcImlzU2h1dGRvd25QZW5kaW5nIHJlZmxlY3RzIGdhdGUuc2h1dGRvd25UaW1lciAoc2luZ2xldG9uIGNvaGVyZW5jZSlcIiwgKCkgPT4ge1xuICAgICAgc2NoZWR1bGVTaHV0ZG93bigpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGdsb2JhbFRoaXMuX19nc2RTaHV0ZG93bkdhdGUhLnNodXRkb3duVGltZXIgIT09IG51bGwsIHRydWUpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGlzU2h1dGRvd25QZW5kaW5nKCksIHRydWUpO1xuICAgICAgY2FuY2VsU2h1dGRvd24oKTtcbiAgICAgIGFzc2VydC5lcXVhbChnbG9iYWxUaGlzLl9fZ3NkU2h1dGRvd25HYXRlIS5zaHV0ZG93blRpbWVyLCBudWxsKTtcbiAgICAgIGFzc2VydC5lcXVhbChpc1NodXRkb3duUGVuZGluZygpLCBmYWxzZSk7XG4gICAgfSk7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFDQSxTQUFTLFVBQVUsTUFBTSxZQUFZLGlCQUFpQjtBQUN0RCxPQUFPLFlBQVk7QUFFbkI7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUtQLFNBQVMsWUFBWTtBQUNuQixpQkFBZTtBQUVmLE1BQUksV0FBVyxtQkFBbUI7QUFDaEMsZUFBVyxrQkFBa0IsYUFBYTtBQUMxQyxlQUFXLGtCQUFrQixjQUFjLE1BQU07QUFBQSxFQUNuRDtBQUNBLFNBQU8sUUFBUSxJQUFJO0FBQ3JCO0FBRUEsU0FBUyxpQkFBaUIsTUFBTTtBQUM5QixZQUFVLFNBQVM7QUFFbkIsV0FBUyw0QkFBNEIsTUFBTTtBQUN6QyxTQUFLLDJDQUEyQyxNQUFNO0FBQ3BELHVCQUFpQjtBQUNqQixhQUFPLE1BQU0sa0JBQWtCLEdBQUcsSUFBSTtBQUFBLElBQ3hDLENBQUM7QUFFRCxTQUFLLDZDQUE2QyxNQUFNO0FBQ3RELHVCQUFpQjtBQUNqQixxQkFBZTtBQUNmLGFBQU8sTUFBTSxrQkFBa0IsR0FBRyxLQUFLO0FBQUEsSUFDekMsQ0FBQztBQUVELFNBQUssZ0NBQWdDLE1BQU07QUFDekMsYUFBTyxNQUFNLGFBQWEsR0FBRyxLQUFLO0FBQUEsSUFDcEMsQ0FBQztBQUFBLEVBQ0gsQ0FBQztBQUVELFdBQVMsdUNBQXVDLE1BQU07QUFDcEQsZUFBVyxNQUFNO0FBQ2YsY0FBUSxJQUFJLHNCQUFzQjtBQUFBLElBQ3BDLENBQUM7QUFFRCxTQUFLLCtCQUErQixNQUFNO0FBQ3hDLGFBQU8sTUFBTSxhQUFhLEdBQUcsSUFBSTtBQUFB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
