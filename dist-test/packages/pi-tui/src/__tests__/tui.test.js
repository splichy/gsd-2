import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Container, CURSOR_MARKER, TUI } from "../tui.js";
function makeTerminal(writes) {
  return {
    isTTY: true,
    columns: 80,
    rows: 24,
    kittyProtocolActive: false,
    start() {
    },
    stop() {
    },
    drainInput: async () => {
    },
    write(data) {
      writes?.push(data);
    },
    moveBy() {
    },
    hideCursor() {
    },
    showCursor() {
    },
    clearLine() {
    },
    clearFromCursor() {
    },
    clearScreen() {
    },
    setTitle() {
    }
  };
}
describe("TUI", () => {
  it("updates an editor line from the real hardware cursor row", () => {
    const writes = [];
    const terminal = makeTerminal(writes);
    let value = "input";
    const tui = new TUI(terminal);
    tui.addChild({
      render: () => ["top", `${value}${CURSOR_MARKER}`, "  GSD  No project loaded - run /gsd to start"],
      invalidate() {
      }
    });
    const anyTui = tui;
    anyTui.doRender();
    const writeCountAfterFirstRender = writes.length;
    value = "input x";
    anyTui.doRender();
    const renderWrite = writes[writeCountAfterFirstRender];
    assert.ok(renderWrite.startsWith("\x1B[?2026h\r"), "editor diff should start at the current cursor row");
    assert.ok(!renderWrite.startsWith("\x1B[?2026h\x1B[1A\r"), "editor diff must not move above the cursor row");
  });
  it("does not swallow a bare Escape keypress while waiting for the cell-size response", () => {
    const tui = new TUI(makeTerminal());
    const received = [];
    tui.setFocus({
      render: () => [],
      handleInput: (data) => {
        received.push(data);
      },
      invalidate() {
      }
    });
    const anyTui = tui;
    anyTui.cellSizeQueryPending = true;
    anyTui.inputBuffer = "";
    anyTui.handleInput("\x1B");
    assert.deepEqual(received, ["\x1B"]);
    assert.equal(anyTui.cellSizeQueryPending, false);
    assert.equal(anyTui.inputBuffer, "");
  });
});
describe("Container", () => {
  function makeDisposableChild(counter) {
    return {
      render: () => [],
      invalidate() {
      },
      dispose() {
        counter.disposed++;
      }
    };
  }
  it("detachChildren() removes children without disposing them", () => {
    const c = new Container();
    const counter = { disposed: 0 };
    c.addChild(makeDisposableChild(counter));
    c.addChild(makeDisposableChild(counter));
    c.detachChildren();
    assert.equal(c.children.length, 0);
    assert.equal(counter.disposed, 0);
  });
  it("clear() still disposes children (regression guard for detach/dispose split)", () => {
    const c = new Container();
    const counter = { disposed: 0 };
    c.addChild(makeDisposableChild(counter));
    c.addChild(makeDisposableChild(counter));
    c.clear();
    assert.equal(c.children.length, 0);
    assert.equal(counter.disposed, 2);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktdHVpL3NyYy9fX3Rlc3RzX18vdHVpLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRC0yICsgcGFja2FnZXMvcGktdHVpL3NyYy9fX3Rlc3RzX18vdHVpLnRlc3QudHMgLSBSZWdyZXNzaW9uIGNvdmVyYWdlIGZvciB0aGUgVFVJIHJlbmRlcmVyIGFuZCBjb250YWluZXIgbGlmZWN5Y2xlLlxuXG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IGRlc2NyaWJlLCBpdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcblxuaW1wb3J0IHsgQ29udGFpbmVyLCBDVVJTT1JfTUFSS0VSLCBUVUkgfSBmcm9tIFwiLi4vdHVpLmpzXCI7XG5pbXBvcnQgdHlwZSB7IENvbXBvbmVudCB9IGZyb20gXCIuLi90dWkuanNcIjtcbmltcG9ydCB0eXBlIHsgVGVybWluYWwgfSBmcm9tIFwiLi4vdGVybWluYWwuanNcIjtcblxuZnVuY3Rpb24gbWFrZVRlcm1pbmFsKHdyaXRlcz86IHN0cmluZ1tdKTogVGVybWluYWwge1xuXHRyZXR1cm4ge1xuXHRcdGlzVFRZOiB0cnVlLFxuXHRcdGNvbHVtbnM6IDgwLFxuXHRcdHJvd3M6IDI0LFxuXHRcdGtpdHR5UHJvdG9jb2xBY3RpdmU6IGZhbHNlLFxuXHRcdHN0YXJ0KCkge30sXG5cdFx0c3RvcCgpIHt9LFxuXHRcdGRyYWluSW5wdXQ6IGFzeW5jICgpID0+IHt9LFxuXHRcdHdyaXRlKGRhdGE6IHN0cmluZykge1xuXHRcdFx0d3JpdGVzPy5wdXNoKGRhdGEpO1xuXHRcdH0sXG5cdFx0bW92ZUJ5KCkge30sXG5cdFx0aGlkZUN1cnNvcigpIHt9LFxuXHRcdHNob3dDdXJzb3IoKSB7fSxcblx0XHRjbGVhckxpbmUoKSB7fSxcblx0XHRjbGVhckZyb21DdXJzb3IoKSB7fSxcblx0XHRjbGVhclNjcmVlbigpIHt9LFxuXHRcdHNldFRpdGxlKCkge30sXG5cdH07XG59XG5cbi8vIFRVSSBjbGVhck9uU2hyaW5rIGRlYm91bmNlIFx1MjAxNCB0ZXN0cyByZW1vdmVkIGluICM0Nzk0IChyZWYgIzQ3ODQpLlxuLy9cbi8vIFRoZSBwcmV2aW91cyB0ZXN0cyBtdXRhdGVkIHByaXZhdGUgZmllbGRzIChgX3Nocmlua0RlYm91bmNlQWN0aXZlYCxcbi8vIGBtYXhMaW5lc1JlbmRlcmVkYCkgYW5kIHRoZW4gYXNzZXJ0ZWQgdGhlIHZhbHVlcyB0aGV5IGp1c3Qgd3JvdGUgXHUyMDE0XG4vLyBwdXJlIHRhdXRvbG9naWVzIHRoYXQgbmV2ZXIgZXhlcmNpc2VkIHRoZSByZWFsIGRlYm91bmNlIHBhdGggaW5cbi8vIGByZW5kZXJOb3coKWAgKHR1aS50czo3MzQtNzU0KS4gQSByZWdyZXNzaW9uIHRoYXQgbmFycm93ZWQgdGhlXG4vLyBjb25kaXRpb24sIHJldmVyc2VkIHRoZSBmbGFnIGZsaXAsIG9yIGRyb3BwZWQgdGhlIFwia2VlcFxuLy8gbWF4TGluZXNSZW5kZXJlZFwiIHJ1bGUgd291bGQgaGF2ZSBwYXNzZWQgYWxsIG9mIHRoZW0uXG4vL1xuLy8gQSBwcm9wZXIgdGVzdCB3b3VsZCAoYSkgcmVuZGVyIGEgY29tcG9uZW50IHRoYXQgcHJvZHVjZXMgTiBsaW5lcyB0b1xuLy8gZXN0YWJsaXNoIGBtYXhMaW5lc1JlbmRlcmVkYCwgKGIpIHN3YXAgaW4gYSBjb21wb25lbnQgdGhhdCBwcm9kdWNlc1xuLy8gTi1rIGxpbmVzIHRvIHRyaWdnZXIgdGhlIHNocmluayBicmFuY2gsIGFuZCAoYykgb2JzZXJ2ZSB0ZXJtaW5hbFxuLy8gd3JpdGVzIHRvIGNvbmZpcm0gdGhlIGRlYm91bmNlIGRlZmVycy9jb21taXRzIHRoZSBmdWxsIHJlZHJhdyBvbiB0aGVcbi8vIGV4cGVjdGVkIHJlbmRlciBjYWxsLlxuLy9cbi8vIFRoYXQgdGVzdCBzZXR1cCByZXF1aXJlcyBleHBvc2luZyBlbm91Z2ggb2YgdGhlIHJlbmRlciBwYXRoIChvclxuLy8gZXh0cmFjdGluZyB0aGUgZGVib3VuY2UgZGVjaXNpb24gaW50byBhIHB1cmUgaGVscGVyKSBcdTIwMTQgZGVmZXJyZWQgdG8gYVxuLy8gc2VwYXJhdGUgcmVmYWN0b3IgUFIgcmF0aGVyIHRoYW4gc2hpcHBpbmcgYSB0YXV0b2xvZ3kuIFNlZSAjNDc5NC5cblxuZGVzY3JpYmUoXCJUVUlcIiwgKCkgPT4ge1xuXHRpdChcInVwZGF0ZXMgYW4gZWRpdG9yIGxpbmUgZnJvbSB0aGUgcmVhbCBoYXJkd2FyZSBjdXJzb3Igcm93XCIsICgpID0+IHtcblx0XHRjb25zdCB3cml0ZXM6IHN0cmluZ1tdID0gW107XG5cdFx0Y29uc3QgdGVybWluYWwgPSBtYWtlVGVybWluYWwod3JpdGVzKTtcblx0XHRsZXQgdmFsdWUgPSBcImlucHV0XCI7XG5cdFx0Y29uc3QgdHVpID0gbmV3IFRVSSh0ZXJtaW5hbCk7XG5cdFx0dHVpLmFkZENoaWxkKHtcblx0XHRcdHJlbmRlcjogKCkgPT4gW1widG9wXCIsIGAke3ZhbHVlfSR7Q1VSU09SX01BUktFUn1gLCBcIiAgR1NEICBObyBwcm9qZWN0IGxvYWRlZCAtIHJ1biAvZ3NkIHRvIHN0YXJ0XCJdLFxuXHRcdFx0aW52YWxpZGF0ZSgpIHt9LFxuXHRcdH0pO1xuXHRcdGNvbnN0IGFueVR1aSA9IHR1aSBhcyBhbnk7XG5cblx0XHRhbnlUdWkuZG9SZW5kZXIoKTtcblx0XHRjb25zdCB3cml0ZUNvdW50QWZ0ZXJGaXJzdFJlbmRlciA9IHdyaXRlcy5sZW5ndGg7XG5cblx0XHR2YWx1ZSA9IFwiaW5wdXQgeFwiO1xuXHRcdGFueVR1aS5kb1JlbmRlcigpO1xuXG5cdFx0Y29uc3QgcmVuZGVyV3JpdGUgPSB3cml0ZXNbd3JpdGVDb3VudEFmdGVyRmlyc3RSZW5kZXJdO1xuXHRcdGFzc2VydC5vayhyZW5kZXJXcml0ZS5zdGFydHNXaXRoKFwiXFx4MWJbPzIwMjZoXFxyXCIpLCBcImVkaXRvciBkaWZmIHNob3VsZCBzdGFydCBhdCB0aGUgY3VycmVudCBjdXJzb3Igcm93XCIpO1xuXHRcdGFzc2VydC5vayghcmVuZGVyV3JpdGUuc3RhcnRzV2l0aChcIlxceDFiWz8yMDI2aFxceDFiWzFBXFxyXCIpLCBcImVkaXRvciBkaWZmIG11c3Qgbm90IG1vdmUgYWJvdmUgdGhlIGN1cnNvciByb3dcIik7XG5cdH0pO1xuXG5cdGl0KFwiZG9lcyBub3Qgc3dhbGxvdyBhIGJhcmUgRXNjYXBlIGtleXByZXNzIHdoaWxlIHdhaXRpbmcgZm9yIHRoZSBjZWxsLXNpemUgcmVzcG9uc2VcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHR1aSA9IG5ldyBUVUkobWFrZVRlcm1pbmFsKCkpO1xuXHRcdGNvbnN0IHJlY2VpdmVkOiBzdHJpbmdbXSA9IFtdO1xuXG5cdFx0dHVpLnNldEZvY3VzKHtcblx0XHRcdHJlbmRlcjogKCkgPT4gW10sXG5cdFx0XHRoYW5kbGVJbnB1dDogKGRhdGE6IHN0cmluZykgPT4ge1xuXHRcdFx0XHRyZWNlaXZlZC5wdXNoKGRhdGEpO1xuXHRcdFx0fSxcblx0XHRcdGludmFsaWRhdGUoKSB7fSxcblx0XHR9KTtcblxuXHRcdGNvbnN0IGFueVR1aSA9IHR1aSBhcyBhbnk7XG5cdFx0YW55VHVpLmNlbGxTaXplUXVlcnlQZW5kaW5nID0gdHJ1ZTtcblx0XHRhbnlUdWkuaW5wdXRCdWZmZXIgPSBcIlwiO1xuXG5cdFx0YW55VHVpLmhhbmRsZUlucHV0KFwiXFx4MWJcIik7XG5cblx0XHRhc3NlcnQuZGVlcEVxdWFsKHJlY2VpdmVkLCBbXCJcXHgxYlwiXSk7XG5cdFx0YXNzZXJ0LmVxdWFsKGFueVR1aS5jZWxsU2l6ZVF1ZXJ5UGVuZGluZywgZmFsc2UpO1xuXHRcdGFzc2VydC5lcXVhbChhbnlUdWkuaW5wdXRCdWZmZXIsIFwiXCIpO1xuXHR9KTtcbn0pO1xuXG5kZXNjcmliZShcIkNvbnRhaW5lclwiLCAoKSA9PiB7XG5cdGZ1bmN0aW9uIG1ha2VEaXNwb3NhYmxlQ2hpbGQoY291bnRlcjogeyBkaXNwb3NlZDogbnVtYmVyIH0pOiBDb21wb25lbnQgJiB7IGRpc3Bvc2UoKTogdm9pZCB9IHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0cmVuZGVyOiAoKSA9PiBbXSxcblx0XHRcdGludmFsaWRhdGUoKSB7fSxcblx0XHRcdGRpc3Bvc2UoKSB7XG5cdFx0XHRcdGNvdW50ZXIuZGlzcG9zZWQrKztcblx0XHRcdH0sXG5cdFx0fTtcblx0fVxuXG5cdGl0KFwiZGV0YWNoQ2hpbGRyZW4oKSByZW1vdmVzIGNoaWxkcmVuIHdpdGhvdXQgZGlzcG9zaW5nIHRoZW1cIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGMgPSBuZXcgQ29udGFpbmVyKCk7XG5cdFx0Y29uc3QgY291bnRlciA9IHsgZGlzcG9zZWQ6IDAgfTtcblx0XHRjLmFkZENoaWxkKG1ha2VEaXNwb3NhYmxlQ2hpbGQoY291bnRlcikpO1xuXHRcdGMuYWRkQ2hpbGQobWFrZURpc3Bvc2FibGVDaGlsZChjb3VudGVyKSk7XG5cblx0XHRjLmRldGFjaENoaWxkcmVuKCk7XG5cblx0XHRhc3NlcnQuZXF1YWwoYy5jaGlsZHJlbi5sZW5ndGgsIDApO1xuXHRcdGFzc2VydC5lcXVhbChjb3VudGVyLmRpc3Bvc2VkLCAwKTtcblx0fSk7XG5cblx0aXQoXCJjbGVhcigpIHN0aWxsIGRpc3Bvc2VzIGNoaWxkcmVuIChyZWdyZXNzaW9uIGd1YXJkIGZvciBkZXRhY2gvZGlzcG9zZSBzcGxpdClcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGMgPSBuZXcgQ29udGFpbmVyKCk7XG5cdFx0Y29uc3QgY291bnRlciA9IHsgZGlzcG9zZWQ6IDAgfTtcblx0XHRjLmFkZENoaWxkKG1ha2VEaXNwb3NhYmxlQ2hpbGQoY291bnRlcikpO1xuXHRcdGMuYWRkQ2hpbGQobWFrZURpc3Bvc2FibGVDaGlsZChjb3VudGVyKSk7XG5cblx0XHRjLmNsZWFyKCk7XG5cblx0XHRhc3NlcnQuZXF1YWwoYy5jaGlsZHJlbi5sZW5ndGgsIDApO1xuXHRcdGFzc2VydC5lcXVhbChjb3VudGVyLmRpc3Bvc2VkLCAyKTtcblx0fSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJB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
