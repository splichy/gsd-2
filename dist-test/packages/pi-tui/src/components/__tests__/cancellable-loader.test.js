import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { CancellableLoader } from "../cancellable-loader.js";
function makeMockTUI() {
  return { requestRender: mock.fn() };
}
describe("CancellableLoader", () => {
  let loader;
  let tui;
  beforeEach(() => {
    tui = makeMockTUI();
  });
  afterEach(() => {
    loader?.dispose();
  });
  it("dispose() aborts the AbortController signal", () => {
    loader = new CancellableLoader(tui, (s) => s, (s) => s, "test");
    assert.equal(loader.aborted, false);
    loader.dispose();
    assert.equal(loader.aborted, true);
  });
  it("dispose() clears the onAbort callback", () => {
    loader = new CancellableLoader(tui, (s) => s, (s) => s, "test");
    loader.onAbort = () => {
    };
    loader.dispose();
    assert.equal(loader.onAbort, void 0);
  });
  it("signal is aborted after dispose()", () => {
    loader = new CancellableLoader(tui, (s) => s, (s) => s, "test");
    const signal = loader.signal;
    assert.equal(signal.aborted, false);
    loader.dispose();
    assert.equal(signal.aborted, true);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktdHVpL3NyYy9jb21wb25lbnRzL19fdGVzdHNfXy9jYW5jZWxsYWJsZS1sb2FkZXIudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gcGktdHVpIENhbmNlbGxhYmxlTG9hZGVyIGNvbXBvbmVudCByZWdyZXNzaW9uIHRlc3RzXG4vLyBDb3B5cmlnaHQgKGMpIDIwMjYgSmVyZW15IE1jU3BhZGRlbiA8amVyZW15QGZsdXhsYWJzLm5ldD5cblxuaW1wb3J0IHsgZGVzY3JpYmUsIGl0LCBtb2NrLCBiZWZvcmVFYWNoLCBhZnRlckVhY2ggfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IENhbmNlbGxhYmxlTG9hZGVyIH0gZnJvbSBcIi4uL2NhbmNlbGxhYmxlLWxvYWRlci5qc1wiO1xuXG5mdW5jdGlvbiBtYWtlTW9ja1RVSSgpIHtcblx0cmV0dXJuIHsgcmVxdWVzdFJlbmRlcjogbW9jay5mbigpIH0gYXMgYW55O1xufVxuXG5kZXNjcmliZShcIkNhbmNlbGxhYmxlTG9hZGVyXCIsICgpID0+IHtcblx0bGV0IGxvYWRlcjogQ2FuY2VsbGFibGVMb2FkZXI7XG5cdGxldCB0dWk6IFJldHVyblR5cGU8dHlwZW9mIG1ha2VNb2NrVFVJPjtcblxuXHRiZWZvcmVFYWNoKCgpID0+IHtcblx0XHR0dWkgPSBtYWtlTW9ja1RVSSgpO1xuXHR9KTtcblxuXHRhZnRlckVhY2goKCkgPT4ge1xuXHRcdGxvYWRlcj8uZGlzcG9zZSgpO1xuXHR9KTtcblxuXHRpdChcImRpc3Bvc2UoKSBhYm9ydHMgdGhlIEFib3J0Q29udHJvbGxlciBzaWduYWxcIiwgKCkgPT4ge1xuXHRcdGxvYWRlciA9IG5ldyBDYW5jZWxsYWJsZUxvYWRlcih0dWksIChzKSA9PiBzLCAocykgPT4gcywgXCJ0ZXN0XCIpO1xuXHRcdGFzc2VydC5lcXVhbChsb2FkZXIuYWJvcnRlZCwgZmFsc2UpO1xuXHRcdGxvYWRlci5kaXNwb3NlKCk7XG5cdFx0YXNzZXJ0LmVxdWFsKGxvYWRlci5hYm9ydGVkLCB0cnVlKTtcblx0fSk7XG5cblx0aXQoXCJkaXNwb3NlKCkgY2xlYXJzIHRoZSBvbkFib3J0IGNhbGxiYWNrXCIsICgpID0+IHtcblx0XHRsb2FkZXIgPSBuZXcgQ2FuY2VsbGFibGVMb2FkZXIodHVpLCAocykgPT4gcywgKHMpID0+IHMsIFwidGVzdFwiKTtcblx0XHRsb2FkZXIub25BYm9ydCA9ICgpID0+IHt9O1xuXHRcdGxvYWRlci5kaXNwb3NlKCk7XG5cdFx0YXNzZXJ0LmVxdWFsKGxvYWRlci5vbkFib3J0LCB1bmRlZmluZWQpO1xuXHR9KTtcblxuXHRpdChcInNpZ25hbCBpcyBhYm9ydGVkIGFmdGVyIGRpc3Bvc2UoKVwiLCAoKSA9PiB7XG5cdFx0bG9hZGVyID0gbmV3IENhbmNlbGxhYmxlTG9hZGVyKHR1aSwgKHMpID0+IHMsIChzKSA9PiBzLCBcInRlc3RcIik7XG5cdFx0Y29uc3Qgc2lnbmFsID0gbG9hZGVyLnNpZ25hbDtcblx0XHRhc3NlcnQuZXF1YWwoc2lnbmFsLmFib3J0ZWQsIGZhbHNlKTtcblx0XHRsb2FkZXIuZGlzcG9zZSgpO1xuXHRcdGFzc2VydC5lcXVhbChzaWduYWwuYWJvcnRlZCwgdHJ1ZSk7XG5cdH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFHQSxTQUFTLFVBQVUsSUFBSSxNQUFNLFlBQVksaUJBQWlCO0FBQzFELE9BQU8sWUFBWTtBQUNuQixTQUFTLHlCQUF5QjtBQUVsQyxTQUFTLGNBQWM7QUFDdEIsU0FBTyxFQUFFLGVBQWUsS0FBSyxHQUFHLEVBQUU7QUFDbkM7QUFFQSxTQUFTLHFCQUFxQixNQUFNO0FBQ25DLE1BQUk7QUFDSixNQUFJO0FBRUosYUFBVyxNQUFNO0FBQ2hCLFVBQU0sWUFBWTtBQUFBLEVBQ25CLENBQUM7QUFFRCxZQUFVLE1BQU07QUFDZixZQUFRLFFBQVE7QUFBQSxFQUNqQixDQUFDO0FBRUQsS0FBRywrQ0FBK0MsTUFBTTtBQUN2RCxhQUFTLElBQUksa0JBQWtCLEtBQUssQ0FBQyxNQUFNLEdBQUcsQ0FBQyxNQUFNLEdBQUcsTUFBTTtBQUM5RCxXQUFPLE1BQU0sT0FBTyxTQUFTLEtBQUs7QUFDbEMsV0FBTyxRQUFRO0FBQ2YsV0FBTyxNQUFNLE9BQU8sU0FBUyxJQUFJO0FBQUEsRUFDbEMsQ0FBQztBQUVELEtBQUcseUNBQXlDLE1BQU07QUFDakQsYUFBUyxJQUFJLGtCQUFrQixLQUFLLENBQUMsTUFBTSxHQUFHLENBQUMsTUFBTSxHQUFHLE1BQU07QUFDOUQsV0FBTyxVQUFVLE1BQU07QUFBQSxJQUFDO0FBQ3hCLFdBQU8sUUFBUTtBQUNmLFdBQU8sTUFBTSxPQUFPLFNBQVMsTUFBUztBQUFBLEVBQ3ZDLENBQUM7QUFFRCxLQUFHLHFDQUFxQyxNQUFNO0FBQzdDLGFBQVMsSUFBSSxrQkFBa0IsS0FBSyxDQUFDLE1BQU0sR0FBRyxDQUFDLE1BQU0sR0FBRyxNQUFNO0FBQzlELFVBQU0sU0FBUyxPQUFPO0FBQ3RCLFdBQU8sTUFBTSxPQUFPLFNBQVMsS0FBSztBQUNsQyxXQUFPLFFBQVE7QUFDZixXQUFPLE1BQU0sT0FBTyxTQUFTLElBQUk7QUFBQSxFQUNsQyxDQUFDO0FBQ0YsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
