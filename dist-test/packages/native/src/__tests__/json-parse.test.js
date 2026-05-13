import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require2 = createRequire(import.meta.url);
const addonDir = path.resolve(__dirname, "..", "..", "..", "..", "native", "addon");
const platformTag = `${process.platform}-${process.arch}`;
const candidates = [
  path.join(addonDir, `gsd_engine.${platformTag}.node`),
  path.join(addonDir, "gsd_engine.dev.node")
];
let native;
for (const candidate of candidates) {
  try {
    native = require2(candidate);
    break;
  } catch {
  }
}
if (!native) {
  console.error("Native addon not found. Run `npm run build:native -w @gsd/native` first.");
  process.exit(1);
}
describe("native json: parseJson()", () => {
  test("parses complete JSON object", () => {
    const result = native.parseJson('{"key": "value", "num": 42}');
    assert.equal(result.key, "value");
    assert.equal(result.num, 42);
  });
  test("parses JSON array", () => {
    const result = native.parseJson("[1, 2, 3]");
    assert.deepEqual(result, [1, 2, 3]);
  });
  test("parses JSON string", () => {
    const result = native.parseJson('"hello"');
    assert.equal(result, "hello");
  });
  test("parses JSON number", () => {
    const result = native.parseJson("42.5");
    assert.equal(result, 42.5);
  });
  test("parses JSON boolean", () => {
    assert.equal(native.parseJson("true"), true);
    assert.equal(native.parseJson("false"), false);
  });
  test("parses JSON null", () => {
    assert.equal(native.parseJson("null"), null);
  });
  test("throws on invalid JSON", () => {
    assert.throws(() => native.parseJson("{invalid}"));
  });
});
describe("native json: parsePartialJson()", () => {
  test("parses complete JSON unchanged", () => {
    const result = native.parsePartialJson('{"key": "value"}');
    assert.equal(result.key, "value");
  });
  test("closes unclosed string", () => {
    const result = native.parsePartialJson('{"key": "val');
    assert.equal(result.key, "val");
  });
  test("closes unclosed object", () => {
    const result = native.parsePartialJson('{"key": "value"');
    assert.equal(result.key, "value");
  });
  test("closes unclosed array", () => {
    const result = native.parsePartialJson('{"arr": [1, 2, 3');
    assert.deepEqual(result.arr, [1, 2, 3]);
  });
  test("removes trailing comma in object", () => {
    const result = native.parsePartialJson('{"a": 1, "b": 2,}');
    assert.equal(result.a, 1);
    assert.equal(result.b, 2);
  });
  test("removes trailing comma in array", () => {
    const result = native.parsePartialJson("[1, 2, 3,]");
    assert.deepEqual(result, [1, 2, 3]);
  });
  test("handles truncated value after colon", () => {
    const result = native.parsePartialJson('{"key":');
    assert.equal(result.key, null);
  });
  test("handles truncated true", () => {
    const result = native.parsePartialJson('{"key": tr');
    assert.equal(result.key, true);
  });
  test("handles truncated false", () => {
    const result = native.parsePartialJson('{"key": fal');
    assert.equal(result.key, false);
  });
  test("handles truncated null", () => {
    const result = native.parsePartialJson('{"key": nu');
    assert.equal(result.key, null);
  });
  test("handles nested partial structures", () => {
    const result = native.parsePartialJson('{"a": {"b": [1, 2');
    assert.deepEqual(result.a.b, [1, 2]);
  });
});
describe("native json: parseStreamingJson()", () => {
  test("returns empty object for empty string", () => {
    const result = native.parseStreamingJson("");
    assert.deepEqual(result, {});
  });
  test("returns empty object for whitespace", () => {
    const result = native.parseStreamingJson("   ");
    assert.deepEqual(result, {});
  });
  test("parses complete JSON", () => {
    const result = native.parseStreamingJson('{"tool": "search", "args": {"query": "test"}}');
    assert.equal(result.tool, "search");
    assert.equal(result.args.query, "test");
  });
  test("parses partial JSON (streaming scenario)", () => {
    const result = native.parseStreamingJson('{"tool": "search", "args": {"query": "te');
    assert.equal(result.tool, "search");
    assert.equal(result.args.query, "te");
  });
  test("handles deeply nested partial JSON", () => {
    const result = native.parseStreamingJson('{"a": {"b": {"c": [1, 2, {"d": "val');
    assert.equal(result.a.b.c[2].d, "val");
  });
  test("handles escaped characters in strings", () => {
    const result = native.parseStreamingJson('{"path": "C:\\\\Users\\\\test');
    assert.ok(result.path.includes("C:\\Users\\test"));
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvbmF0aXZlL3NyYy9fX3Rlc3RzX18vanNvbi1wYXJzZS50ZXN0Lm1qcyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgdGVzdCwgZGVzY3JpYmUgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IGNyZWF0ZVJlcXVpcmUgfSBmcm9tIFwibm9kZTptb2R1bGVcIjtcbmltcG9ydCAqIGFzIHBhdGggZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gXCJub2RlOnVybFwiO1xuXG5jb25zdCBfX2Rpcm5hbWUgPSBwYXRoLmRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKTtcbmNvbnN0IHJlcXVpcmUgPSBjcmVhdGVSZXF1aXJlKGltcG9ydC5tZXRhLnVybCk7XG5cbmNvbnN0IGFkZG9uRGlyID0gcGF0aC5yZXNvbHZlKF9fZGlybmFtZSwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIm5hdGl2ZVwiLCBcImFkZG9uXCIpO1xuY29uc3QgcGxhdGZvcm1UYWcgPSBgJHtwcm9jZXNzLnBsYXRmb3JtfS0ke3Byb2Nlc3MuYXJjaH1gO1xuY29uc3QgY2FuZGlkYXRlcyA9IFtcbiAgcGF0aC5qb2luKGFkZG9uRGlyLCBgZ3NkX2VuZ2luZS4ke3BsYXRmb3JtVGFnfS5ub2RlYCksXG4gIHBhdGguam9pbihhZGRvbkRpciwgXCJnc2RfZW5naW5lLmRldi5ub2RlXCIpLFxuXTtcblxubGV0IG5hdGl2ZTtcbmZvciAoY29uc3QgY2FuZGlkYXRlIG9mIGNhbmRpZGF0ZXMpIHtcbiAgdHJ5IHtcbiAgICBuYXRpdmUgPSByZXF1aXJlKGNhbmRpZGF0ZSk7XG4gICAgYnJlYWs7XG4gIH0gY2F0Y2gge1xuICAgIC8vIHRyeSBuZXh0XG4gIH1cbn1cblxuaWYgKCFuYXRpdmUpIHtcbiAgY29uc29sZS5lcnJvcihcIk5hdGl2ZSBhZGRvbiBub3QgZm91bmQuIFJ1biBgbnBtIHJ1biBidWlsZDpuYXRpdmUgLXcgQGdzZC9uYXRpdmVgIGZpcnN0LlwiKTtcbiAgcHJvY2Vzcy5leGl0KDEpO1xufVxuXG5kZXNjcmliZShcIm5hdGl2ZSBqc29uOiBwYXJzZUpzb24oKVwiLCAoKSA9PiB7XG4gIHRlc3QoXCJwYXJzZXMgY29tcGxldGUgSlNPTiBvYmplY3RcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IG5hdGl2ZS5wYXJzZUpzb24oJ3tcImtleVwiOiBcInZhbHVlXCIsIFwibnVtXCI6IDQyfScpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQua2V5LCBcInZhbHVlXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQubnVtLCA0Mik7XG4gIH0pO1xuXG4gIHRlc3QoXCJwYXJzZXMgSlNPTiBhcnJheVwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gbmF0aXZlLnBhcnNlSnNvbihcIlsxLCAyLCAzXVwiKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdCwgWzEsIDIsIDNdKTtcbiAgfSk7XG5cbiAgdGVzdChcInBhcnNlcyBKU09OIHN0cmluZ1wiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gbmF0aXZlLnBhcnNlSnNvbignXCJoZWxsb1wiJyk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgXCJoZWxsb1wiKTtcbiAgfSk7XG5cbiAgdGVzdChcInBhcnNlcyBKU09OIG51bWJlclwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gbmF0aXZlLnBhcnNlSnNvbihcIjQyLjVcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgNDIuNSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJwYXJzZXMgSlNPTiBib29sZWFuXCIsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwobmF0aXZlLnBhcnNlSnNvbihcInRydWVcIiksIHRydWUpO1xuICAgIGFzc2VydC5lcXVhbChuYXRpdmUucGFyc2VKc29uKFwiZmFsc2VcIiksIGZhbHNlKTtcbiAgfSk7XG5cbiAgdGVzdChcInBhcnNlcyBKU09OIG51bGxcIiwgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChuYXRpdmUucGFyc2VKc29uKFwibnVsbFwiKSwgbnVsbCk7XG4gIH0pO1xuXG4gIHRlc3QoXCJ0aHJvd3Mgb24gaW52YWxpZCBKU09OXCIsICgpID0+IHtcbiAgICBhc3NlcnQudGhyb3dzKCgpID0+IG5hdGl2ZS5wYXJzZUpzb24oXCJ7aW52YWxpZH1cIikpO1xuICB9KTtcbn0pO1xuXG5kZXNjcmliZShcIm5hdGl2ZSBqc29uOiBwYXJzZVBhcnRpYWxKc29uKClcIiwgKCkgPT4ge1xuICB0ZXN0KFwicGFyc2VzIGNvbXBsZXRlIEpTT04gdW5jaGFuZ2VkXCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBuYXRpdmUucGFyc2VQYXJ0aWFsSnNvbigne1wia2V5XCI6IFwidmFsdWVcIn0nKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmtleSwgXCJ2YWx1ZVwiKTtcbiAgfSk7XG5cbiAgdGVzdChcImNsb3NlcyB1bmNsb3NlZCBzdHJpbmdcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IG5hdGl2ZS5wYXJzZVBhcnRpYWxKc29uKCd7XCJrZXlcIjogXCJ2YWwnKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmtleSwgXCJ2YWxcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJjbG9zZXMgdW5jbG9zZWQgb2JqZWN0XCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBuYXRpdmUucGFyc2VQYXJ0aWFsSnNvbigne1wia2V5XCI6IFwidmFsdWVcIicpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQua2V5LCBcInZhbHVlXCIpO1xuICB9KTtcblxuICB0ZXN0KFwiY2xvc2VzIHVuY2xvc2VkIGFycmF5XCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBuYXRpdmUucGFyc2VQYXJ0aWFsSnNvbigne1wiYXJyXCI6IFsxLCAyLCAzJyk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQuYXJyLCBbMSwgMiwgM10pO1xuICB9KTtcblxuICB0ZXN0KFwicmVtb3ZlcyB0cmFpbGluZyBjb21tYSBpbiBvYmplY3RcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IG5hdGl2ZS5wYXJzZVBhcnRpYWxKc29uKCd7XCJhXCI6IDEsIFwiYlwiOiAyLH0nKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmEsIDEpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuYiwgMik7XG4gIH0pO1xuXG4gIHRlc3QoXCJyZW1vdmVzIHRyYWlsaW5nIGNvbW1hIGluIGFycmF5XCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBuYXRpdmUucGFyc2VQYXJ0aWFsSnNvbihcIlsxLCAyLCAzLF1cIik7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQsIFsxLCAyLCAzXSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJoYW5kbGVzIHRydW5jYXRlZCB2YWx1ZSBhZnRlciBjb2xvblwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gbmF0aXZlLnBhcnNlUGFydGlhbEpzb24oJ3tcImtleVwiOicpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQua2V5LCBudWxsKTtcbiAgfSk7XG5cbiAgdGVzdChcImhhbmRsZXMgdHJ1bmNhdGVkIHRydWVcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IG5hdGl2ZS5wYXJzZVBhcnRpYWxKc29uKCd7XCJrZXlcIjogdHInKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmtleSwgdHJ1ZSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJoYW5kbGVzIHRydW5jYXRlZCBmYWxzZVwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gbmF0aXZlLnBhcnNlUGFydGlhbEpzb24oJ3tcImtleVwiOiBmYWwnKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmtleSwgZmFsc2UpO1xuICB9KTtcblxuICB0ZXN0KFwiaGFuZGxlcyB0cnVuY2F0ZWQgbnVsbFwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gbmF0aXZlLnBhcnNlUGFydGlhbEpzb24oJ3tcImtleVwiOiBudScpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQua2V5LCBudWxsKTtcbiAgfSk7XG5cbiAgdGVzdChcImhhbmRsZXMgbmVzdGVkIHBhcnRpYWwgc3RydWN0dXJlc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gbmF0aXZlLnBhcnNlUGFydGlhbEpzb24oJ3tcImFcIjoge1wiYlwiOiBbMSwgMicpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwocmVzdWx0LmEuYiwgWzEsIDJdKTtcbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoXCJuYXRpdmUganNvbjogcGFyc2VTdHJlYW1pbmdKc29uKClcIiwgKCkgPT4ge1xuICB0ZXN0KFwicmV0dXJucyBlbXB0eSBvYmplY3QgZm9yIGVtcHR5IHN0cmluZ1wiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gbmF0aXZlLnBhcnNlU3RyZWFtaW5nSnNvbihcIlwiKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdCwge30pO1xuICB9KTtcblxuICB0ZXN0KFwicmV0dXJucyBlbXB0eSBvYmplY3QgZm9yIHdoaXRlc3BhY2VcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IG5hdGl2ZS5wYXJzZVN0cmVhbWluZ0pzb24oXCIgICBcIik7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQsIHt9KTtcbiAgfSk7XG5cbiAgdGVzdChcInBhcnNlcyBjb21wbGV0ZSBKU09OXCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBuYXRpdmUucGFyc2VTdHJlYW1pbmdKc29uKCd7XCJ0b29sXCI6IFwic2VhcmNoXCIsIFwiYXJnc1wiOiB7XCJxdWVyeVwiOiBcInRlc3RcIn19Jyk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC50b29sLCBcInNlYXJjaFwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmFyZ3MucXVlcnksIFwidGVzdFwiKTtcbiAgfSk7XG5cbiAgdGVzdChcInBhcnNlcyBwYXJ0aWFsIEpTT04gKHN0cmVhbWluZyBzY2VuYXJpbylcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IG5hdGl2ZS5wYXJzZVN0cmVhbWluZ0pzb24oJ3tcInRvb2xcIjogXCJzZWFyY2hcIiwgXCJhcmdzXCI6IHtcInF1ZXJ5XCI6IFwidGUnKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnRvb2wsIFwic2VhcmNoXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuYXJncy5xdWVyeSwgXCJ0ZVwiKTtcbiAgfSk7XG5cbiAgdGVzdChcImhhbmRsZXMgZGVlcGx5IG5lc3RlZCBwYXJ0aWFsIEpTT05cIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IG5hdGl2ZS5wYXJzZVN0cmVhbWluZ0pzb24oJ3tcImFcIjoge1wiYlwiOiB7XCJjXCI6IFsxLCAyLCB7XCJkXCI6IFwidmFsJyk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5hLmIuY1syXS5kLCBcInZhbFwiKTtcbiAgfSk7XG5cbiAgdGVzdChcImhhbmRsZXMgZXNjYXBlZCBjaGFyYWN0ZXJzIGluIHN0cmluZ3NcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IG5hdGl2ZS5wYXJzZVN0cmVhbWluZ0pzb24oJ3tcInBhdGhcIjogXCJDOlxcXFxcXFxcVXNlcnNcXFxcXFxcXHRlc3QnKTtcbiAgICBhc3NlcnQub2socmVzdWx0LnBhdGguaW5jbHVkZXMoXCJDOlxcXFxVc2Vyc1xcXFx0ZXN0XCIpKTtcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFNBQVMsTUFBTSxnQkFBZ0I7QUFDL0IsT0FBTyxZQUFZO0FBQ25CLFNBQVMscUJBQXFCO0FBQzlCLFlBQVksVUFBVTtBQUN0QixTQUFTLHFCQUFxQjtBQUU5QixNQUFNLFlBQVksS0FBSyxR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
