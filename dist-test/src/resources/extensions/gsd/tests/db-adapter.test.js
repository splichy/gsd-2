import assert from "node:assert/strict";
import test from "node:test";
import {
  createDbAdapter,
  normalizeDbRow,
  normalizeDbRows
} from "../db-adapter.js";
test("normalizeDbRow returns undefined for missing rows", () => {
  assert.equal(normalizeDbRow(null), void 0);
  assert.equal(normalizeDbRow(void 0), void 0);
});
test("normalizeDbRow converts null-prototype rows to plain objects", () => {
  const raw = /* @__PURE__ */ Object.create(null);
  raw.id = "M001";
  const normalized = normalizeDbRow(raw);
  assert.deepEqual(normalized, { id: "M001" });
  assert.equal(Object.getPrototypeOf(normalized), Object.prototype);
});
test("normalizeDbRows normalizes every row", () => {
  const first = /* @__PURE__ */ Object.create(null);
  first.id = "S01";
  const second = { id: "S02" };
  assert.deepEqual(normalizeDbRows([first, second]), [{ id: "S01" }, { id: "S02" }]);
});
test("createDbAdapter caches prepared statements and clears cache on close", () => {
  const calls = [];
  const rawStatement = {
    run: (...params) => {
      calls.push(["run", params]);
      return { changes: 1 };
    },
    get: (...params) => {
      calls.push(["get", params]);
      const row = /* @__PURE__ */ Object.create(null);
      row.id = "T01";
      return row;
    },
    all: (...params) => {
      calls.push(["all", params]);
      const row = /* @__PURE__ */ Object.create(null);
      row.id = "T02";
      return [row];
    }
  };
  let prepareCount = 0;
  const rawDb = {
    exec: (sql) => calls.push(["exec", sql]),
    prepare: (sql) => {
      prepareCount += 1;
      calls.push(["prepare", sql]);
      return rawStatement;
    },
    close: () => calls.push(["close"])
  };
  const adapter = createDbAdapter(rawDb);
  const first = adapter.prepare("SELECT * FROM tasks WHERE id = ?");
  const second = adapter.prepare("SELECT * FROM tasks WHERE id = ?");
  assert.equal(first, second);
  assert.equal(prepareCount, 1);
  assert.deepEqual(first.get("T01"), { id: "T01" });
  assert.deepEqual(first.all("T02"), [{ id: "T02" }]);
  assert.deepEqual(first.run("T01"), { changes: 1 });
  adapter.close();
  const third = adapter.prepare("SELECT * FROM tasks WHERE id = ?");
  assert.notEqual(third, first);
  assert.equal(prepareCount, 2);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9kYi1hZGFwdGVyLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFByb2plY3QvQXBwOiBHU0QtMlxuLy8gRmlsZSBQdXJwb3NlOiBVbml0IHRlc3RzIGZvciB0aGUgbm9ybWFsaXplZCBTUUxpdGUgYWRhcHRlciB3cmFwcGVyLlxuXG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcblxuaW1wb3J0IHtcbiAgY3JlYXRlRGJBZGFwdGVyLFxuICBub3JtYWxpemVEYlJvdyxcbiAgbm9ybWFsaXplRGJSb3dzLFxufSBmcm9tIFwiLi4vZGItYWRhcHRlci50c1wiO1xuXG50ZXN0KFwibm9ybWFsaXplRGJSb3cgcmV0dXJucyB1bmRlZmluZWQgZm9yIG1pc3Npbmcgcm93c1wiLCAoKSA9PiB7XG4gIGFzc2VydC5lcXVhbChub3JtYWxpemVEYlJvdyhudWxsKSwgdW5kZWZpbmVkKTtcbiAgYXNzZXJ0LmVxdWFsKG5vcm1hbGl6ZURiUm93KHVuZGVmaW5lZCksIHVuZGVmaW5lZCk7XG59KTtcblxudGVzdChcIm5vcm1hbGl6ZURiUm93IGNvbnZlcnRzIG51bGwtcHJvdG90eXBlIHJvd3MgdG8gcGxhaW4gb2JqZWN0c1wiLCAoKSA9PiB7XG4gIGNvbnN0IHJhdyA9IE9iamVjdC5jcmVhdGUobnVsbCkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIHJhdy5pZCA9IFwiTTAwMVwiO1xuXG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBub3JtYWxpemVEYlJvdyhyYXcpO1xuXG4gIGFzc2VydC5kZWVwRXF1YWwobm9ybWFsaXplZCwgeyBpZDogXCJNMDAxXCIgfSk7XG4gIGFzc2VydC5lcXVhbChPYmplY3QuZ2V0UHJvdG90eXBlT2Yobm9ybWFsaXplZCksIE9iamVjdC5wcm90b3R5cGUpO1xufSk7XG5cbnRlc3QoXCJub3JtYWxpemVEYlJvd3Mgbm9ybWFsaXplcyBldmVyeSByb3dcIiwgKCkgPT4ge1xuICBjb25zdCBmaXJzdCA9IE9iamVjdC5jcmVhdGUobnVsbCkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIGZpcnN0LmlkID0gXCJTMDFcIjtcbiAgY29uc3Qgc2Vjb25kID0geyBpZDogXCJTMDJcIiB9O1xuXG4gIGFzc2VydC5kZWVwRXF1YWwobm9ybWFsaXplRGJSb3dzKFtmaXJzdCwgc2Vjb25kXSksIFt7IGlkOiBcIlMwMVwiIH0sIHsgaWQ6IFwiUzAyXCIgfV0pO1xufSk7XG5cbnRlc3QoXCJjcmVhdGVEYkFkYXB0ZXIgY2FjaGVzIHByZXBhcmVkIHN0YXRlbWVudHMgYW5kIGNsZWFycyBjYWNoZSBvbiBjbG9zZVwiLCAoKSA9PiB7XG4gIGNvbnN0IGNhbGxzOiB1bmtub3duW10gPSBbXTtcbiAgY29uc3QgcmF3U3RhdGVtZW50ID0ge1xuICAgIHJ1bjogKC4uLnBhcmFtczogdW5rbm93bltdKSA9PiB7XG4gICAgICBjYWxscy5wdXNoKFtcInJ1blwiLCBwYXJhbXNdKTtcbiAgICAgIHJldHVybiB7IGNoYW5nZXM6IDEgfTtcbiAgICB9LFxuICAgIGdldDogKC4uLnBhcmFtczogdW5rbm93bltdKSA9PiB7XG4gICAgICBjYWxscy5wdXNoKFtcImdldFwiLCBwYXJhbXNdKTtcbiAgICAgIGNvbnN0IHJvdyA9IE9iamVjdC5jcmVhdGUobnVsbCkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICByb3cuaWQgPSBcIlQwMVwiO1xuICAgICAgcmV0dXJuIHJvdztcbiAgICB9LFxuICAgIGFsbDogKC4uLnBhcmFtczogdW5rbm93bltdKSA9PiB7XG4gICAgICBjYWxscy5wdXNoKFtcImFsbFwiLCBwYXJhbXNdKTtcbiAgICAgIGNvbnN0IHJvdyA9IE9iamVjdC5jcmVhdGUobnVsbCkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICByb3cuaWQgPSBcIlQwMlwiO1xuICAgICAgcmV0dXJuIFtyb3ddO1xuICAgIH0sXG4gIH07XG4gIGxldCBwcmVwYXJlQ291bnQgPSAwO1xuICBjb25zdCByYXdEYiA9IHtcbiAgICBleGVjOiAoc3FsOiBzdHJpbmcpID0+IGNhbGxzLnB1c2goW1wiZXhlY1wiLCBzcWxdKSxcbiAgICBwcmVwYXJlOiAoc3FsOiBzdHJpbmcpID0+IHtcbiAgICAgIHByZXBhcmVDb3VudCArPSAxO1xuICAgICAgY2FsbHMucHVzaChbXCJwcmVwYXJlXCIsIHNxbF0pO1xuICAgICAgcmV0dXJuIHJhd1N0YXRlbWVudDtcbiAgICB9LFxuICAgIGNsb3NlOiAoKSA9PiBjYWxscy5wdXNoKFtcImNsb3NlXCJdKSxcbiAgfTtcbiAgY29uc3QgYWRhcHRlciA9IGNyZWF0ZURiQWRhcHRlcihyYXdEYik7XG5cbiAgY29uc3QgZmlyc3QgPSBhZGFwdGVyLnByZXBhcmUoXCJTRUxFQ1QgKiBGUk9NIHRhc2tzIFdIRVJFIGlkID0gP1wiKTtcbiAgY29uc3Qgc2Vjb25kID0gYWRhcHRlci5wcmVwYXJlKFwiU0VMRUNUICogRlJPTSB0YXNrcyBXSEVSRSBpZCA9ID9cIik7XG5cbiAgYXNzZXJ0LmVxdWFsKGZpcnN0LCBzZWNvbmQpO1xuICBhc3NlcnQuZXF1YWwocHJlcGFyZUNvdW50LCAxKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChmaXJzdC5nZXQoXCJUMDFcIiksIHsgaWQ6IFwiVDAxXCIgfSk7XG4gIGFzc2VydC5kZWVwRXF1YWwoZmlyc3QuYWxsKFwiVDAyXCIpLCBbeyBpZDogXCJUMDJcIiB9XSk7XG4gIGFzc2VydC5kZWVwRXF1YWwoZmlyc3QucnVuKFwiVDAxXCIpLCB7IGNoYW5nZXM6IDEgfSk7XG5cbiAgYWRhcHRlci5jbG9zZSgpO1xuICBjb25zdCB0aGlyZCA9IGFkYXB0ZXIucHJlcGFyZShcIlNFTEVDVCAqIEZST00gdGFza3MgV0hFUkUgaWQgPSA/XCIpO1xuXG4gIGFzc2VydC5ub3RFcXVhbCh0aGly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
