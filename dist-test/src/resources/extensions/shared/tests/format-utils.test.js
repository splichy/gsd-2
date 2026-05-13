import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatDuration,
  sparkline,
  stripAnsi
} from "../format-utils.js";
import {
  padRight,
  joinColumns,
  centerLine,
  fitColumns
} from "../layout-utils.js";
describe("formatDuration", () => {
  it("formats seconds", () => {
    assert.equal(formatDuration(0), "0s");
    assert.equal(formatDuration(5e3), "5s");
    assert.equal(formatDuration(59e3), "59s");
  });
  it("formats minutes and seconds", () => {
    assert.equal(formatDuration(6e4), "1m 0s");
    assert.equal(formatDuration(9e4), "1m 30s");
    assert.equal(formatDuration(354e4), "59m 0s");
  });
  it("formats hours and minutes", () => {
    assert.equal(formatDuration(36e5), "1h 0m");
    assert.equal(formatDuration(54e5), "1h 30m");
    assert.equal(formatDuration(72e5), "2h 0m");
  });
});
describe("padRight", () => {
  it("pads plain text to width", () => {
    const result = padRight("abc", 6);
    assert.equal(result, "abc   ");
  });
  it("does not pad when text fills width", () => {
    const result = padRight("abcdef", 6);
    assert.equal(result, "abcdef");
  });
  it("does not pad when text exceeds width", () => {
    const result = padRight("abcdefgh", 6);
    assert.equal(result, "abcdefgh");
  });
});
describe("joinColumns", () => {
  it("joins left and right with spacing", () => {
    const result = joinColumns("left", "right", 20);
    assert.equal(result.length, 20);
    assert.ok(result.startsWith("left"));
    assert.ok(result.endsWith("right"));
  });
  it("truncates when content overflows", () => {
    const result = joinColumns("a".repeat(20), "b".repeat(20), 30);
    assert.ok(result.length <= 30);
  });
});
describe("centerLine", () => {
  it("centers text within width", () => {
    const result = centerLine("hi", 10);
    assert.equal(result, "    hi");
  });
  it("truncates when content exceeds width", () => {
    const result = centerLine("abcdefgh", 4);
    assert.ok(result.length <= 4);
  });
});
describe("fitColumns", () => {
  it("joins parts that fit", () => {
    const result = fitColumns(["aaa", "bbb", "ccc"], 20);
    assert.ok(result.includes("aaa"));
    assert.ok(result.includes("bbb"));
    assert.ok(result.includes("ccc"));
  });
  it("drops parts that overflow", () => {
    const result = fitColumns(["aaa", "bbb", "ccc"], 10);
    assert.ok(result.includes("aaa"));
  });
  it("returns empty string for empty array", () => {
    assert.equal(fitColumns([], 80), "");
  });
  it("filters out empty strings", () => {
    const result = fitColumns(["aaa", "", "bbb"], 80);
    assert.ok(result.includes("aaa"));
    assert.ok(result.includes("bbb"));
  });
});
describe("sparkline", () => {
  it("returns empty string for empty array", () => {
    assert.equal(sparkline([]), "");
  });
  it("renders all lowest blocks for all-zero values", () => {
    const result = sparkline([0, 0, 0]);
    assert.equal(result.length, 3);
    assert.equal(result[0], result[1]);
    assert.equal(result[1], result[2]);
  });
  it("renders highest block for max value", () => {
    const result = sparkline([0, 10, 5]);
    assert.equal(result.length, 3);
    assert.equal(result[1], "\u2588");
  });
  it("handles single value", () => {
    const result = sparkline([42]);
    assert.equal(result.length, 1);
    assert.equal(result, "\u2588");
  });
  it("handles large arrays without stack overflow", () => {
    const largeArray = new Array(1e5).fill(0).map((_, i) => i);
    const result = sparkline(largeArray);
    assert.equal(result.length, 1e5);
  });
});
describe("stripAnsi", () => {
  it("strips ANSI escape sequences", () => {
    const result = stripAnsi("\x1B[31mred\x1B[0m text");
    assert.equal(result, "red text");
  });
  it("returns plain text unchanged", () => {
    assert.equal(stripAnsi("plain text"), "plain text");
  });
  it("strips multiple escape sequences", () => {
    const result = stripAnsi("\x1B[1m\x1B[32mbold green\x1B[0m");
    assert.equal(result, "bold green");
  });
  it("handles empty string", () => {
    assert.equal(stripAnsi(""), "");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL3NoYXJlZC90ZXN0cy9mb3JtYXQtdXRpbHMudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgZGVzY3JpYmUsIGl0IH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQge1xuICBmb3JtYXREdXJhdGlvbixcbiAgc3BhcmtsaW5lLFxuICBzdHJpcEFuc2ksXG59IGZyb20gXCIuLi9mb3JtYXQtdXRpbHMuanNcIjtcbmltcG9ydCB7XG4gIHBhZFJpZ2h0LFxuICBqb2luQ29sdW1ucyxcbiAgY2VudGVyTGluZSxcbiAgZml0Q29sdW1ucyxcbn0gZnJvbSBcIi4uL2xheW91dC11dGlscy5qc1wiO1xuXG5kZXNjcmliZShcImZvcm1hdER1cmF0aW9uXCIsICgpID0+IHtcbiAgaXQoXCJmb3JtYXRzIHNlY29uZHNcIiwgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChmb3JtYXREdXJhdGlvbigwKSwgXCIwc1wiKTtcbiAgICBhc3NlcnQuZXF1YWwoZm9ybWF0RHVyYXRpb24oNV8wMDApLCBcIjVzXCIpO1xuICAgIGFzc2VydC5lcXVhbChmb3JtYXREdXJhdGlvbig1OV8wMDApLCBcIjU5c1wiKTtcbiAgfSk7XG5cbiAgaXQoXCJmb3JtYXRzIG1pbnV0ZXMgYW5kIHNlY29uZHNcIiwgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChmb3JtYXREdXJhdGlvbig2MF8wMDApLCBcIjFtIDBzXCIpO1xuICAgIGFzc2VydC5lcXVhbChmb3JtYXREdXJhdGlvbig5MF8wMDApLCBcIjFtIDMwc1wiKTtcbiAgICBhc3NlcnQuZXF1YWwoZm9ybWF0RHVyYXRpb24oM181NDBfMDAwKSwgXCI1OW0gMHNcIik7XG4gIH0pO1xuXG4gIGl0KFwiZm9ybWF0cyBob3VycyBhbmQgbWludXRlc1wiLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKGZvcm1hdER1cmF0aW9uKDNfNjAwXzAwMCksIFwiMWggMG1cIik7XG4gICAgYXNzZXJ0LmVxdWFsKGZvcm1hdER1cmF0aW9uKDVfNDAwXzAwMCksIFwiMWggMzBtXCIpO1xuICAgIGFzc2VydC5lcXVhbChmb3JtYXREdXJhdGlvbig3XzIwMF8wMDApLCBcIjJoIDBtXCIpO1xuICB9KTtcbn0pO1xuXG5kZXNjcmliZShcInBhZFJpZ2h0XCIsICgpID0+IHtcbiAgaXQoXCJwYWRzIHBsYWluIHRleHQgdG8gd2lkdGhcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IHBhZFJpZ2h0KFwiYWJjXCIsIDYpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIFwiYWJjICAgXCIpO1xuICB9KTtcblxuICBpdChcImRvZXMgbm90IHBhZCB3aGVuIHRleHQgZmlsbHMgd2lkdGhcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IHBhZFJpZ2h0KFwiYWJjZGVmXCIsIDYpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIFwiYWJjZGVmXCIpO1xuICB9KTtcblxuICBpdChcImRvZXMgbm90IHBhZCB3aGVuIHRleHQgZXhjZWVkcyB3aWR0aFwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gcGFkUmlnaHQoXCJhYmNkZWZnaFwiLCA2KTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCBcImFiY2RlZmdoXCIpO1xuICB9KTtcbn0pO1xuXG5kZXNjcmliZShcImpvaW5Db2x1bW5zXCIsICgpID0+IHtcbiAgaXQoXCJqb2lucyBsZWZ0IGFuZCByaWdodCB3aXRoIHNwYWNpbmdcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGpvaW5Db2x1bW5zKFwibGVmdFwiLCBcInJpZ2h0XCIsIDIwKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lmxlbmd0aCwgMjApO1xuICAgIGFzc2VydC5vayhyZXN1bHQuc3RhcnRzV2l0aChcImxlZnRcIikpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuZW5kc1dpdGgoXCJyaWdodFwiKSk7XG4gIH0pO1xuXG4gIGl0KFwidHJ1bmNhdGVzIHdoZW4gY29udGVudCBvdmVyZmxvd3NcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGpvaW5Db2x1bW5zKFwiYVwiLnJlcGVhdCgyMCksIFwiYlwiLnJlcGVhdCgyMCksIDMwKTtcbiAgICAvLyBTaG91bGQgYmUgdHJ1bmNhdGVkIHRvIDMwIGNoYXJzXG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5sZW5ndGggPD0gMzApO1xuICB9KTtcbn0pO1xuXG5kZXNjcmliZShcImNlbnRlckxpbmVcIiwgKCkgPT4ge1xuICBpdChcImNlbnRlcnMgdGV4dCB3aXRoaW4gd2lkdGhcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGNlbnRlckxpbmUoXCJoaVwiLCAxMCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgXCIgICAgaGlcIik7XG4gIH0pO1xuXG4gIGl0KFwidHJ1bmNhdGVzIHdoZW4gY29udGVudCBleGNlZWRzIHdpZHRoXCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBjZW50ZXJMaW5lKFwiYWJjZGVmZ2hcIiwgNCk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5sZW5ndGggPD0gNCk7XG4gIH0pO1xufSk7XG5cbmRlc2NyaWJlKFwiZml0Q29sdW1uc1wiLCAoKSA9PiB7XG4gIGl0KFwiam9pbnMgcGFydHMgdGhhdCBmaXRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGZpdENvbHVtbnMoW1wiYWFhXCIsIFwiYmJiXCIsIFwiY2NjXCJdLCAyMCk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcyhcImFhYVwiKSk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcyhcImJiYlwiKSk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcyhcImNjY1wiKSk7XG4gIH0pO1xuXG4gIGl0KFwiZHJvcHMgcGFydHMgdGhhdCBvdmVyZmxvd1wiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gZml0Q29sdW1ucyhbXCJhYWFcIiwgXCJiYmJcIiwgXCJjY2NcIl0sIDEwKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmluY2x1ZGVzKFwiYWFhXCIpKTtcbiAgICAvLyBNYXkgb3IgbWF5IG5vdCBpbmNsdWRlIGJiYiBkZXBlbmRpbmcgb24gc2VwYXJhdG9yIHdpZHRoXG4gIH0pO1xuXG4gIGl0KFwicmV0dXJucyBlbXB0eSBzdHJpbmcgZm9yIGVtcHR5IGFycmF5XCIsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoZml0Q29sdW1ucyhbXSwgODApLCBcIlwiKTtcbiAgfSk7XG5cbiAgaXQoXCJmaWx0ZXJzIG91dCBlbXB0eSBzdHJpbmdzXCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBmaXRDb2x1bW5zKFtcImFhYVwiLCBcIlwiLCBcImJiYlwiXSwgODApO1xuICAgIGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoXCJhYWFcIikpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoXCJiYmJcIikpO1xuICB9KTtcbn0pO1xuXG5kZXNjcmliZShcInNwYXJrbGluZVwiLCAoKSA9PiB7XG4gIGl0KFwicmV0dXJucyBlbXB0eSBzdHJpbmcgZm9yIGVtcHR5IGFycmF5XCIsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoc3BhcmtsaW5lKFtdKSwgXCJcIik7XG4gIH0pO1xuXG4gIGl0KFwicmVuZGVycyBhbGwgbG93ZXN0IGJsb2NrcyBmb3IgYWxsLXplcm8gdmFsdWVzXCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBzcGFya2xpbmUoWzAsIDAsIDBdKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lmxlbmd0aCwgMyk7XG4gICAgLy8gQWxsIGNoYXJzIHNob3VsZCBiZSB0aGUgc2FtZSAobG93ZXN0IGJsb2NrKVxuICAgIGFzc2VydC5lcXVhbChyZXN1bHRbMF0sIHJlc3VsdFsxXSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdFsxXSwgcmVzdWx0WzJdKTtcbiAgfSk7XG5cbiAgaXQoXCJyZW5kZXJzIGhpZ2hlc3QgYmxvY2sgZm9yIG1heCB2YWx1ZVwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gc3BhcmtsaW5lKFswLCAxMCwgNV0pO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQubGVuZ3RoLCAzKTtcbiAgICAvLyBNaWRkbGUgc2hvdWxkIGJlIGhpZ2hlc3QgYmxvY2sgKFx1MjU4OClcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0WzFdLCBcIlxcdTI1ODhcIik7XG4gIH0pO1xuXG4gIGl0KFwiaGFuZGxlcyBzaW5nbGUgdmFsdWVcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IHNwYXJrbGluZShbNDJdKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lmxlbmd0aCwgMSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgXCJcXHUyNTg4XCIpO1xuICB9KTtcblxuICBpdChcImhhbmRsZXMgbGFyZ2UgYXJyYXlzIHdpdGhvdXQgc3RhY2sgb3ZlcmZsb3dcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGxhcmdlQXJyYXkgPSBuZXcgQXJyYXkoMTAwXzAwMCkuZmlsbCgwKS5tYXAoKF8sIGkpID0+IGkpO1xuICAgIGNvbnN0IHJlc3VsdCA9IHNwYXJrbGluZShsYXJnZUFycmF5KTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lmxlbmd0aCwgMTAwXzAwMCk7XG4gIH0pO1xufSk7XG5cbmRlc2NyaWJlKFwic3RyaXBBbnNpXCIsICgpID0+IHtcbiAgaXQoXCJzdHJpcHMgQU5TSSBlc2NhcGUgc2VxdWVuY2VzXCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBzdHJpcEFuc2koXCJcXHgxYlszMW1yZWRcXHgxYlswbSB0ZXh0XCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIFwicmVkIHRleHRcIik7XG4gIH0pO1xuXG4gIGl0KFwicmV0dXJucyBwbGFpbiB0ZXh0IHVuY2hhbmdlZFwiLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKHN0cmlwQW5zaShcInBsYWluIHRleHRcIiksIFwicGxhaW4gdGV4dFwiKTtcbiAgfSk7XG5cbiAgaXQoXCJzdHJpcHMgbXVsdGlwbGUgZXNjYXBlIHNlcXVlbmNlc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gc3RyaXBBbnNpKFwiXFx4MWJbMW1cXHgxYlszMm1ib2xkIGdyZWVuXFx4MWJbMG1cIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgXCJib2xkIGdyZWVuXCIpO1xuICB9KTtcblxuICBpdChcImhhbmRsZXMgZW1wdHkgc3RyaW5nXCIsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoc3RyaXBBbnNpKFwiXCIpLCBcIlwiKTtcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFNBQVMsVUFBVSxVQUFVO0FBQzdCLE9BQU8sWUFBWTtBQUNuQjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFDUDtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBRVAsU0FBUyxrQkFBa0IsTUFBTTtBQUMvQixLQUFHLG1CQUFtQixNQUFNO0FBQzFCLFdBQU8sTUFBTSxlQUFlLENBQUMsR0FBRyxJQUFJO0FBQ3BDLFdBQU8sTUFBTSxlQUFlLEdBQUssR0FBRyxJQUFJO0FBQ3hDLFdBQU8sTUFBTSxlQUFlLElBQU0sR0FBRyxLQUFLO0FBQUEsRUFDNUMsQ0FBQztBQUVELEtBQUcsK0JBQStCLE1BQU07QUFDdEMsV0FBTyxNQUFNLGVBQWUsR0FBTSxHQUFHLE9BQU87QUFDNUMsV0FBTyxNQUFNLGVBQWUsR0FBTSxHQUFHLFFBQVE7QUFDN0MsV0FBTyxNQUFNLGVBQWUsS0FBUyxHQUFHLFFBQVE7QUFBQSxFQUNsRCxDQUFDO0FBRUQsS0FBRyw2QkFBNkIsTUFBTTtBQUNwQyxXQUFPLE1BQU0sZUFBZSxJQUFTLEdBQUcsT0FBTztBQUMvQyxXQUFPLE1BQU0sZUFBZSxJQUFT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
