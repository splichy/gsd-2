import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeLineHash,
  formatHashLines,
  formatLineTag,
  parseTag,
  validateLineRef,
  applyHashlineEdits,
  HashlineMismatchError,
  parseHashlineText,
  stripNewLinePrefixes
} from "./hashline.js";
function makeTag(line, content) {
  return parseTag(formatLineTag(line, content));
}
describe("computeLineHash", () => {
  it("returns 2-character hash string from nibble alphabet", () => {
    const hash = computeLineHash(1, "hello");
    assert.match(hash, /^[ZPMQVRWSNKTXJBYH]{2}$/);
  });
  it("same content at same line produces same hash", () => {
    const a = computeLineHash(1, "hello");
    const b = computeLineHash(1, "hello");
    assert.equal(a, b);
  });
  it("different content produces different hash", () => {
    const a = computeLineHash(1, "hello");
    const b = computeLineHash(1, "world");
    assert.notEqual(a, b);
  });
  it("empty line produces valid hash", () => {
    const hash = computeLineHash(1, "");
    assert.match(hash, /^[ZPMQVRWSNKTXJBYH]{2}$/);
  });
  it("uses line number for symbol-only lines", () => {
    const a = computeLineHash(1, "***");
    const b = computeLineHash(2, "***");
    assert.notEqual(a, b);
  });
  it("does not use line number for alphanumeric lines", () => {
    const a = computeLineHash(1, "hello");
    const b = computeLineHash(2, "hello");
    assert.equal(a, b);
  });
  it("strips trailing whitespace before hashing", () => {
    const a = computeLineHash(1, "hello");
    const b = computeLineHash(1, "hello   ");
    assert.equal(a, b);
  });
  it("strips CR before hashing", () => {
    const a = computeLineHash(1, "hello");
    const b = computeLineHash(1, "hello\r");
    assert.equal(a, b);
  });
});
describe("formatHashLines", () => {
  it("formats single line", () => {
    const result = formatHashLines("hello");
    const hash = computeLineHash(1, "hello");
    assert.equal(result, `1#${hash}:hello`);
  });
  it("formats multiple lines with 1-indexed numbers", () => {
    const result = formatHashLines("foo\nbar\nbaz");
    const lines = result.split("\n");
    assert.equal(lines.length, 3);
    assert.ok(lines[0].startsWith("1#"));
    assert.ok(lines[1].startsWith("2#"));
    assert.ok(lines[2].startsWith("3#"));
  });
  it("respects custom startLine", () => {
    const result = formatHashLines("foo\nbar", 10);
    const lines = result.split("\n");
    assert.ok(lines[0].startsWith("10#"));
    assert.ok(lines[1].startsWith("11#"));
  });
  it("handles empty lines in content", () => {
    const result = formatHashLines("foo\n\nbar");
    const lines = result.split("\n");
    assert.equal(lines.length, 3);
    assert.match(lines[1], /^2#[ZPMQVRWSNKTXJBYH]{2}:$/);
  });
  it("round-trips with computeLineHash", () => {
    const content = "function hello() {\n  return 42;\n}";
    const formatted = formatHashLines(content);
    const lines = formatted.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/^(\d+)#([ZPMQVRWSNKTXJBYH]{2}):(.*)$/);
      assert.ok(match, `Line ${i} should match hashline format`);
      const lineNum = Number.parseInt(match[1], 10);
      const hash = match[2];
      const lineContent = match[3];
      assert.equal(computeLineHash(lineNum, lineContent), hash);
    }
  });
});
describe("parseTag", () => {
  it("parses valid reference", () => {
    const ref = parseTag("5#QQ");
    assert.deepEqual(ref, { line: 5, hash: "QQ" });
  });
  it("rejects single-character hash", () => {
    assert.throws(() => parseTag("1#Q"), /Invalid line reference/);
  });
  it("parses long hash by taking strict 2-char prefix", () => {
    const ref = parseTag("100#QQQQ");
    assert.deepEqual(ref, { line: 100, hash: "QQ" });
  });
  it("rejects missing separator", () => {
    assert.throws(() => parseTag("5QQ"), /Invalid line reference/);
  });
  it("rejects non-numeric line", () => {
    assert.throws(() => parseTag("abc#Q"), /Invalid line reference/);
  });
  it("rejects line number 0", () => {
    assert.throws(() => parseTag("0#QQ"), /Line number must be >= 1/);
  });
  it("rejects empty string", () => {
    assert.throws(() => parseTag(""), /Invalid line reference/);
  });
});
describe("validateLineRef", () => {
  it("accepts valid ref with matching hash", () => {
    const lines = ["hello", "world"];
    const hash = computeLineHash(1, "hello");
    assert.doesNotThrow(() => validateLineRef({ line: 1, hash }, lines));
  });
  it("rejects line out of range", () => {
    const lines = ["hello"];
    const hash = computeLineHash(1, "hello");
    assert.throws(() => validateLineRef({ line: 2, hash }, lines), /does not exist/);
  });
  it("rejects mismatched hash", () => {
    const lines = ["hello", "world"];
    assert.throws(() => validateLineRef({ line: 1, hash: "ZZ" }, lines), /has changed since last read/);
  });
});
describe("applyHashlineEdits \u2014 replace", () => {
  it("replaces single line", () => {
    const content = "aaa\nbbb\nccc";
    const edits = [{ op: "replace", pos: makeTag(2, "bbb"), lines: ["BBB"] }];
    const result = applyHashlineEdits(content, edits);
    assert.equal(result.lines, "aaa\nBBB\nccc");
    assert.equal(result.firstChangedLine, 2);
  });
  it("range replace (shrink)", () => {
    const content = "aaa\nbbb\nccc\nddd";
    const edits = [{ op: "replace", pos: makeTag(2, "bbb"), end: makeTag(3, "ccc"), lines: ["ONE"] }];
    const result = applyHashlineEdits(content, edits);
    assert.equal(result.lines, "aaa\nONE\nddd");
  });
  it("range replace (same count)", () => {
    const content = "aaa\nbbb\nccc\nddd";
    const edits = [
      { op: "replace", pos: makeTag(2, "bbb"), end: makeTag(3, "ccc"), lines: ["XXX", "YYY"] }
    ];
    const result = applyHashlineEdits(content, edits);
    assert.equal(result.lines, "aaa\nXXX\nYYY\nddd");
  });
  it("replaces first line", () => {
    const content = "first\nsecond\nthird";
    const edits = [{ op: "replace", pos: makeTag(1, "first"), lines: ["FIRST"] }];
    const result = applyHashlineEdits(content, edits);
    assert.equal(result.lines, "FIRST\nsecond\nthird");
  });
  it("replaces last line", () => {
    const content = "first\nsecond\nthird";
    const edits = [{ op: "replace", pos: makeTag(3, "third"), lines: ["THIRD"] }];
    const result = applyHashlineEdits(content, edits);
    assert.equal(result.lines, "first\nsecond\nTHIRD");
  });
});
describe("applyHashlineEdits \u2014 delete", () => {
  it("deletes single line", () => {
    const content = "aaa\nbbb\nccc";
    const edits = [{ op: "replace", pos: makeTag(2, "bbb"), lines: [] }];
    const result = applyHashlineEdits(content, edits);
    assert.equal(result.lines, "aaa\nccc");
  });
  it("deletes range of lines", () => {
    const content = "aaa\nbbb\nccc\nddd";
    const edits = [{ op: "replace", pos: makeTag(2, "bbb"), end: makeTag(3, "ccc"), lines: [] }];
    const result = applyHashlineEdits(content, edits);
    assert.equal(result.lines, "aaa\nddd");
  });
});
describe("applyHashlineEdits \u2014 append", () => {
  it("inserts after a line", () => {
    const content = "aaa\nbbb\nccc";
    const edits = [{ op: "append", pos: makeTag(1, "aaa"), lines: ["NEW"] }];
    const result = applyHashlineEdits(content, edits);
    assert.equal(result.lines, "aaa\nNEW\nbbb\nccc");
    assert.equal(result.firstChangedLine, 2);
  });
  it("inserts multiple lines", () => {
    const content = "aaa\nbbb";
    const edits = [{ op: "append", pos: makeTag(1, "aaa"), lines: ["x", "y", "z"] }];
    const result = applyHashlineEdits(content, edits);
    assert.equal(result.lines, "aaa\nx\ny\nz\nbbb");
  });
  it("inserts at EOF without anchors", () => {
    const content = "aaa\nbbb";
    const edits = [{ op: "append", lines: ["NEW"] }];
    const result = applyHashlineEdits(content, edits);
    assert.equal(result.lines, "aaa\nbbb\nNEW");
  });
});
describe("applyHashlineEdits \u2014 prepend", () => {
  it("inserts before a line", () => {
    const content = "aaa\nbbb\nccc";
    const edits = [{ op: "prepend", pos: makeTag(2, "bbb"), lines: ["NEW"] }];
    const result = applyHashlineEdits(content, edits);
    assert.equal(result.lines, "aaa\nNEW\nbbb\nccc");
  });
  it("prepends at BOF without anchor", () => {
    const content = "aaa\nbbb";
    const edits = [{ op: "prepend", lines: ["NEW"] }];
    const result = applyHashlineEdits(content, edits);
    assert.equal(result.lines, "NEW\naaa\nbbb");
  });
  it("insert before and insert after at same line produce correct order", () => {
    const content = "aaa\nbbb\nccc";
    const edits = [
      { op: "prepend", pos: makeTag(2, "bbb"), lines: ["BEFORE"] },
      { op: "append", pos: makeTag(2, "bbb"), lines: ["AFTER"] }
    ];
    const result = applyHashlineEdits(content, edits);
    assert.equal(result.lines, "aaa\nBEFORE\nbbb\nAFTER\nccc");
  });
});
describe("applyHashlineEdits \u2014 multiple edits", () => {
  it("applies two non-overlapping replaces (bottom-up safe)", () => {
    const content = "aaa\nbbb\nccc\nddd\neee";
    const edits = [
      { op: "replace", pos: makeTag(2, "bbb"), lines: ["BBB"] },
      { op: "replace", pos: makeTag(4, "ddd"), lines: ["DDD"] }
    ];
    const result = applyHashlineEdits(content, edits);
    assert.equal(result.lines, "aaa\nBBB\nccc\nDDD\neee");
  });
  it("empty edits array is a no-op", () => {
    const content = "aaa\nbbb";
    const result = applyHashlineEdits(content, []);
    assert.equal(result.lines, content);
    assert.equal(result.firstChangedLine, void 0);
  });
});
describe("applyHashlineEdits \u2014 errors", () => {
  it("rejects stale hash", () => {
    const content = "aaa\nbbb\nccc";
    const edits = [{ op: "replace", pos: parseTag("2#QQ"), lines: ["BBB"] }];
    assert.throws(() => applyHashlineEdits(content, edits), (err) => err instanceof HashlineMismatchError);
  });
  it("stale hash error shows >>> markers with correct hashes", () => {
    const content = "aaa\nbbb\nccc\nddd\neee";
    const edits = [{ op: "replace", pos: parseTag("2#QQ"), lines: ["BBB"] }];
    try {
      applyHashlineEdits(content, edits);
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof HashlineMismatchError);
      assert.ok(err.message.includes(">>>"));
      const correctHash = computeLineHash(2, "bbb");
      assert.ok(err.message.includes(`2#${correctHash}:bbb`));
    }
  });
  it("rejects out-of-range line", () => {
    const content = "aaa\nbbb";
    const edits = [{ op: "replace", pos: parseTag("10#ZZ"), lines: ["X"] }];
    assert.throws(() => applyHashlineEdits(content, edits), /does not exist/);
  });
  it("rejects range with start > end", () => {
    const content = "aaa\nbbb\nccc\nddd\neee";
    const edits = [{ op: "replace", pos: makeTag(5, "eee"), end: makeTag(2, "bbb"), lines: ["X"] }];
    assert.throws(() => applyHashlineEdits(content, edits));
  });
});
describe("stripNewLinePrefixes", () => {
  it("strips leading '+' when majority of lines start with '+'", () => {
    const lines = ["+line one", "+line two", "+line three"];
    assert.deepEqual(stripNewLinePrefixes(lines), ["line one", "line two", "line three"]);
  });
  it("does NOT strip leading '-' from Markdown list items", () => {
    const lines = ["- item one", "- item two", "- item three"];
    assert.deepEqual(stripNewLinePrefixes(lines), ["- item one", "- item two", "- item three"]);
  });
  it("strips hashline prefixes when all non-empty lines carry them", () => {
    const lines = ["1#WQ:foo", "2#TZ:bar", "3#HX:baz"];
    assert.deepEqual(stripNewLinePrefixes(lines), ["foo", "bar", "baz"]);
  });
  it("does NOT strip hashline prefixes when any non-empty line is plain content", () => {
    const lines = ["1#WQ:foo", "bar", "3#HX:baz"];
    assert.deepEqual(stripNewLinePrefixes(lines), ["1#WQ:foo", "bar", "3#HX:baz"]);
  });
  it("does NOT strip comment lines that look like hashline prefixes", () => {
    assert.deepEqual(stripNewLinePrefixes(["  # Note: Using a fixed version"]), ["  # Note: Using a fixed version"]);
    assert.deepEqual(stripNewLinePrefixes(["# TODO: remove this"]), ["# TODO: remove this"]);
  });
});
describe("parseHashlineText", () => {
  it("returns empty array for null", () => {
    assert.deepEqual(parseHashlineText(null), []);
  });
  it("returns array input as-is when no strip heuristic applies", () => {
    const input = ["- [x] done", "- [ ] todo"];
    assert.equal(parseHashlineText(input), input);
  });
  it("splits string on newline and preserves Markdown list '-' prefix", () => {
    const result = parseHashlineText("- item one\n- item two\n- item three");
    assert.deepEqual(result, ["- item one", "- item two", "- item three"]);
  });
  it("strips '+' diff markers from string input", () => {
    const result = parseHashlineText("+line one\n+line two");
    assert.deepEqual(result, ["line one", "line two"]);
  });
  it("still strips trailing empty from string split", () => {
    assert.deepEqual(parseHashlineText("foo\n"), ["foo"]);
  });
});
describe("applyHashlineEdits \u2014 heuristics", () => {
  it("auto-corrects off-by-one range end that duplicates a closing brace", () => {
    const content = "if (ok) {\n  run();\n}\nafter();";
    const edits = [
      {
        op: "replace",
        pos: makeTag(1, "if (ok) {"),
        end: makeTag(2, "  run();"),
        lines: ["if (ok) {", "  runSafe();", "}"]
      }
    ];
    const result = applyHashlineEdits(content, edits);
    assert.equal(result.lines, "if (ok) {\n  runSafe();\n}\nafter();");
    assert.ok(result.warnings);
    assert.equal(result.warnings.length, 1);
    assert.ok(result.warnings[0].includes("Auto-corrected range replace"));
  });
  it("auto-corrects escaped tab indentation", () => {
    const content = "root\n	child\n		value\nend";
    const edits = [{ op: "replace", pos: makeTag(3, "		value"), lines: ["\\t\\treplaced"] }];
    const result = applyHashlineEdits(content, edits);
    assert.equal(result.lines, "root\n	child\n		replaced\nend");
    assert.ok(result.warnings);
    assert.ok(result.warnings[0].includes("Auto-corrected escaped tab indentation"));
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL3Rvb2xzL2hhc2hsaW5lLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IGRlc2NyaWJlLCBpdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHtcblx0Y29tcHV0ZUxpbmVIYXNoLFxuXHRmb3JtYXRIYXNoTGluZXMsXG5cdGZvcm1hdExpbmVUYWcsXG5cdHBhcnNlVGFnLFxuXHR2YWxpZGF0ZUxpbmVSZWYsXG5cdGFwcGx5SGFzaGxpbmVFZGl0cyxcblx0SGFzaGxpbmVNaXNtYXRjaEVycm9yLFxuXHRwYXJzZUhhc2hsaW5lVGV4dCxcblx0c3RyaXBOZXdMaW5lUHJlZml4ZXMsXG5cdHR5cGUgSGFzaGxpbmVFZGl0LFxuXHR0eXBlIEFuY2hvcixcbn0gZnJvbSBcIi4vaGFzaGxpbmUuanNcIjtcblxuZnVuY3Rpb24gbWFrZVRhZyhsaW5lOiBudW1iZXIsIGNvbnRlbnQ6IHN0cmluZyk6IEFuY2hvciB7XG5cdHJldHVybiBwYXJzZVRhZyhmb3JtYXRMaW5lVGFnKGxpbmUsIGNvbnRlbnQpKTtcbn1cblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBjb21wdXRlTGluZUhhc2hcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG5kZXNjcmliZShcImNvbXB1dGVMaW5lSGFzaFwiLCAoKSA9PiB7XG5cdGl0KFwicmV0dXJucyAyLWNoYXJhY3RlciBoYXNoIHN0cmluZyBmcm9tIG5pYmJsZSBhbHBoYWJldFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgaGFzaCA9IGNvbXB1dGVMaW5lSGFzaCgxLCBcImhlbGxvXCIpO1xuXHRcdGFzc2VydC5tYXRjaChoYXNoLCAvXltaUE1RVlJXU05LVFhKQllIXXsyfSQvKTtcblx0fSk7XG5cblx0aXQoXCJzYW1lIGNvbnRlbnQgYXQgc2FtZSBsaW5lIHByb2R1Y2VzIHNhbWUgaGFzaFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgYSA9IGNvbXB1dGVMaW5lSGFzaCgxLCBcImhlbGxvXCIpO1xuXHRcdGNvbnN0IGIgPSBjb21wdXRlTGluZUhhc2goMSwgXCJoZWxsb1wiKTtcblx0XHRhc3NlcnQuZXF1YWwoYSwgYik7XG5cdH0pO1xuXG5cdGl0KFwiZGlmZmVyZW50IGNvbnRlbnQgcHJvZHVjZXMgZGlmZmVyZW50IGhhc2hcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGEgPSBjb21wdXRlTGluZUhhc2goMSwgXCJoZWxsb1wiKTtcblx0XHRjb25zdCBiID0gY29tcHV0ZUxpbmVIYXNoKDEsIFwid29ybGRcIik7XG5cdFx0YXNzZXJ0Lm5vdEVxdWFsKGEsIGIpO1xuXHR9KTtcblxuXHRpdChcImVtcHR5IGxpbmUgcHJvZHVjZXMgdmFsaWQgaGFzaFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgaGFzaCA9IGNvbXB1dGVMaW5lSGFzaCgxLCBcIlwiKTtcblx0XHRhc3NlcnQubWF0Y2goaGFzaCwgL15bWlBNUVZSV1NOS1RYSkJZSF17Mn0kLyk7XG5cdH0pO1xuXG5cdGl0KFwidXNlcyBsaW5lIG51bWJlciBmb3Igc3ltYm9sLW9ubHkgbGluZXNcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGEgPSBjb21wdXRlTGluZUhhc2goMSwgXCIqKipcIik7XG5cdFx0Y29uc3QgYiA9IGNvbXB1dGVMaW5lSGFzaCgyLCBcIioqKlwiKTtcblx0XHRhc3NlcnQubm90RXF1YWwoYSwgYik7XG5cdH0pO1xuXG5cdGl0KFwiZG9lcyBub3QgdXNlIGxpbmUgbnVtYmVyIGZvciBhbHBoYW51bWVyaWMgbGluZXNcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGEgPSBjb21wdXRlTGluZUhhc2goMSwgXCJoZWxsb1wiKTtcblx0XHRjb25zdCBiID0gY29tcHV0ZUxpbmVIYXNoKDIsIFwiaGVsbG9cIik7XG5cdFx0YXNzZXJ0LmVxdWFsKGEsIGIpO1xuXHR9KTtcblxuXHRpdChcInN0cmlwcyB0cmFpbGluZyB3aGl0ZXNwYWNlIGJlZm9yZSBoYXNoaW5nXCIsICgpID0+IHtcblx0XHRjb25zdCBhID0gY29tcHV0ZUxpbmVIYXNoKDEsIFwiaGVsbG9cIik7XG5cdFx0Y29uc3QgYiA9IGNvbXB1dGVMaW5lSGFzaCgxLCBcImhlbGxvICAgXCIpO1xuXHRcdGFzc2VydC5lcXVhbChhLCBiKTtcblx0fSk7XG5cblx0aXQoXCJzdHJpcHMgQ1IgYmVmb3JlIGhhc2hpbmdcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGEgPSBjb21wdXRlTGluZUhhc2goMSwgXCJoZWxsb1wiKTtcblx0XHRjb25zdCBiID0gY29tcHV0ZUxpbmVIYXNoKDEsIFwiaGVsbG9cXHJcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKGEsIGIpO1xuXHR9KTtcbn0pO1xuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIGZvcm1hdEhhc2hMaW5lc1xuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbmRlc2NyaWJlKFwiZm9ybWF0SGFzaExpbmVzXCIsICgpID0+IHtcblx0aXQoXCJmb3JtYXRzIHNpbmdsZSBsaW5lXCIsICgpID0+IHtcblx0XHRjb25zdCByZXN1bHQgPSBmb3JtYXRIYXNoTGluZXMoXCJoZWxsb1wiKTtcblx0XHRjb25zdCBoYXNoID0gY29tcHV0ZUxpbmVIYXNoKDEsIFwiaGVsbG9cIik7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdCwgYDEjJHtoYXNofTpoZWxsb2ApO1xuXHR9KTtcblxuXHRpdChcImZvcm1hdHMgbXVsdGlwbGUgbGluZXMgd2l0aCAxLWluZGV4ZWQgbnVtYmVyc1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVzdWx0ID0gZm9ybWF0SGFzaExpbmVzKFwiZm9vXFxuYmFyXFxuYmF6XCIpO1xuXHRcdGNvbnN0IGxpbmVzID0gcmVzdWx0LnNwbGl0KFwiXFxuXCIpO1xuXHRcdGFzc2VydC5lcXVhbChsaW5lcy5sZW5ndGgsIDMpO1xuXHRcdGFzc2VydC5vayhsaW5lc1swXS5zdGFydHNXaXRoKFwiMSNcIikpO1xuXHRcdGFzc2VydC5vayhsaW5lc1sxXS5zdGFydHNXaXRoKFwiMiNcIikpO1xuXHRcdGFzc2VydC5vayhsaW5lc1syXS5zdGFydHNXaXRoKFwiMyNcIikpO1xuXHR9KTtcblxuXHRpdChcInJlc3BlY3RzIGN1c3RvbSBzdGFydExpbmVcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlc3VsdCA9IGZvcm1hdEhhc2hMaW5lcyhcImZvb1xcbmJhclwiLCAxMCk7XG5cdFx0Y29uc3QgbGluZXMgPSByZXN1bHQuc3BsaXQoXCJcXG5cIik7XG5cdFx0YXNzZXJ0Lm9rKGxpbmVzWzBdLnN0YXJ0c1dpdGgoXCIxMCNcIikpO1xuXHRcdGFzc2VydC5vayhsaW5lc1sxXS5zdGFydHNXaXRoKFwiMTEjXCIpKTtcblx0fSk7XG5cblx0aXQoXCJoYW5kbGVzIGVtcHR5IGxpbmVzIGluIGNvbnRlbnRcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlc3VsdCA9IGZvcm1hdEhhc2hMaW5lcyhcImZvb1xcblxcbmJhclwiKTtcblx0XHRjb25zdCBsaW5lcyA9IHJlc3VsdC5zcGxpdChcIlxcblwiKTtcblx0XHRhc3NlcnQuZXF1YWwobGluZXMubGVuZ3RoLCAzKTtcblx0XHRhc3NlcnQubWF0Y2gobGluZXNbMV0sIC9eMiNbWlBNUVZSV1NOS1RYSkJZSF17Mn06JC8pO1xuXHR9KTtcblxuXHRpdChcInJvdW5kLXRyaXBzIHdpdGggY29tcHV0ZUxpbmVIYXNoXCIsICgpID0+IHtcblx0XHRjb25zdCBjb250ZW50ID0gXCJmdW5jdGlvbiBoZWxsbygpIHtcXG4gIHJldHVybiA0MjtcXG59XCI7XG5cdFx0Y29uc3QgZm9ybWF0dGVkID0gZm9ybWF0SGFzaExpbmVzKGNvbnRlbnQpO1xuXHRcdGNvbnN0IGxpbmVzID0gZm9ybWF0dGVkLnNwbGl0KFwiXFxuXCIpO1xuXG5cdFx0Zm9yIChsZXQgaSA9IDA7IGkgPCBsaW5lcy5sZW5ndGg7IGkrKykge1xuXHRcdFx0Y29uc3QgbWF0Y2ggPSBsaW5lc1tpXS5tYXRjaCgvXihcXGQrKSMoW1pQTVFWUldTTktUWEpCWUhdezJ9KTooLiopJC8pO1xuXHRcdFx0YXNzZXJ0Lm9rKG1hdGNoLCBgTGluZSAke2l9IHNob3VsZCBtYXRjaCBoYXNobGluZSBmb3JtYXRgKTtcblx0XHRcdGNvbnN0IGxpbmVOdW0gPSBOdW1iZXIucGFyc2VJbnQobWF0Y2ghWzFdLCAxMCk7XG5cdFx0XHRjb25zdCBoYXNoID0gbWF0Y2ghWzJdO1xuXHRcdFx0Y29uc3QgbGluZUNvbnRlbnQgPSBtYXRjaCFbM107XG5cdFx0XHRhc3NlcnQuZXF1YWwoY29tcHV0ZUxpbmVIYXNoKGxpbmVOdW0sIGxpbmVDb250ZW50KSwgaGFzaCk7XG5cdFx0fVxuXHR9KTtcbn0pO1xuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIHBhcnNlVGFnXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuZGVzY3JpYmUoXCJwYXJzZVRhZ1wiLCAoKSA9PiB7XG5cdGl0KFwicGFyc2VzIHZhbGlkIHJlZmVyZW5jZVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVmID0gcGFyc2VUYWcoXCI1I1FRXCIpO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwocmVmLCB7IGxpbmU6IDUsIGhhc2g6IFwiUVFcIiB9KTtcblx0fSk7XG5cblx0aXQoXCJyZWplY3RzIHNpbmdsZS1jaGFyYWN0ZXIgaGFzaFwiLCAoKSA9PiB7XG5cdFx0YXNzZXJ0LnRocm93cygoKSA9PiBwYXJzZVRhZyhcIjEjUVwiKSwgL0ludmFsaWQgbGluZSByZWZlcmVuY2UvKTtcblx0fSk7XG5cblx0aXQoXCJwYXJzZXMgbG9uZyBoYXNoIGJ5IHRha2luZyBzdHJpY3QgMi1jaGFyIHByZWZpeFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVmID0gcGFyc2VUYWcoXCIxMDAjUVFRUVwiKTtcblx0XHRhc3NlcnQuZGVlcEVxdWFsKHJlZiwgeyBsaW5lOiAxMDAsIGhhc2g6IFwiUVFcIiB9KTtcblx0fSk7XG5cblx0aXQoXCJyZWplY3RzIG1pc3Npbmcgc2VwYXJhdG9yXCIsICgpID0+IHtcblx0XHRhc3NlcnQudGhyb3dzKCgpID0+IHBhcnNlVGFnKFwiNVFRXCIpLCAvSW52YWxpZCBsaW5lIHJlZmVyZW5jZS8pO1xuXHR9KTtcblxuXHRpdChcInJlamVjdHMgbm9uLW51bWVyaWMgbGluZVwiLCAoKSA9PiB7XG5cdFx0YXNzZXJ0LnRocm93cygoKSA9PiBwYXJzZVRhZyhcImFiYyNRXCIpLCAvSW52YWxpZCBsaW5lIHJlZmVyZW5jZS8pO1xuXHR9KTtcblxuXHRpdChcInJlamVjdHMgbGluZSBudW1iZXIgMFwiLCAoKSA9PiB7XG5cdFx0YXNzZXJ0LnRocm93cygoKSA9PiBwYXJzZVRhZyhcIjAjUVFcIiksIC9MaW5lIG51bWJlciBtdXN0IGJlID49IDEvKTtcblx0fSk7XG5cblx0aXQoXCJyZWplY3RzIGVtcHR5IHN0cmluZ1wiLCAoKSA9PiB7XG5cdFx0YXNzZXJ0LnRocm93cygoKSA9PiBwYXJzZVRhZyhcIlwiKSwgL0ludmFsaWQgbGluZSByZWZlcmVuY2UvKTtcblx0fSk7XG59KTtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyB2YWxpZGF0ZUxpbmVSZWZcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG5kZXNjcmliZShcInZhbGlkYXRlTGluZVJlZlwiLCAoKSA9PiB7XG5cdGl0KFwiYWNjZXB0cyB2YWxpZCByZWYgd2l0aCBtYXRjaGluZyBoYXNoXCIsICgpID0+IHtcblx0XHRjb25zdCBsaW5lcyA9IFtcImhlbGxvXCIsIFwid29ybGRcIl07XG5cdFx0Y29uc3QgaGFzaCA9IGNvbXB1dGVMaW5lSGFzaCgxLCBcImhlbGxvXCIpO1xuXHRcdGFzc2VydC5kb2VzTm90VGhyb3coKCkgPT4gdmFsaWRhdGVMaW5lUmVmKHsgbGluZTogMSwgaGFzaCB9LCBsaW5lcykpO1xuXHR9KTtcblxuXHRpdChcInJlamVjdHMgbGluZSBvdXQgb2YgcmFuZ2VcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGxpbmVzID0gW1wiaGVsbG9cIl07XG5cdFx0Y29uc3QgaGFzaCA9IGNvbXB1dGVMaW5lSGFzaCgxLCBcImhlbGxvXCIpO1xuXHRcdGFzc2VydC50aHJvd3MoKCkgPT4gdmFsaWRhdGVMaW5lUmVmKHsgbGluZTogMiwgaGFzaCB9LCBsaW5lcyksIC9kb2VzIG5vdCBleGlzdC8pO1xuXHR9KTtcblxuXHRpdChcInJlamVjdHMgbWlzbWF0Y2hlZCBoYXNoXCIsICgpID0+IHtcblx0XHRjb25zdCBsaW5lcyA9IFtcImhlbGxvXCIsIFwid29ybGRcIl07XG5cdFx0YXNzZXJ0LnRocm93cygoKSA9PiB2YWxpZGF0ZUxpbmVSZWYoeyBsaW5lOiAxLCBoYXNoOiBcIlpaXCIgfSwgbGluZXMpLCAvaGFzIGNoYW5nZWQgc2luY2UgbGFzdCByZWFkLyk7XG5cdH0pO1xufSk7XG5cbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuLy8gYXBwbHlIYXNobGluZUVkaXRzIFx1MjAxNCByZXBsYWNlXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuZGVzY3JpYmUoXCJhcHBseUhhc2hsaW5lRWRpdHMgXHUyMDE0IHJlcGxhY2VcIiwgKCkgPT4ge1xuXHRpdChcInJlcGxhY2VzIHNpbmdsZSBsaW5lXCIsICgpID0+IHtcblx0XHRjb25zdCBjb250ZW50ID0gXCJhYWFcXG5iYmJcXG5jY2NcIjtcblx0XHRjb25zdCBlZGl0czogSGFzaGxpbmVFZGl0W10gPSBbeyBvcDogXCJyZXBsYWNlXCIsIHBvczogbWFrZVRhZygyLCBcImJiYlwiKSwgbGluZXM6IFtcIkJCQlwiXSB9XTtcblx0XHRjb25zdCByZXN1bHQgPSBhcHBseUhhc2hsaW5lRWRpdHMoY29udGVudCwgZWRpdHMpO1xuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQubGluZXMsIFwiYWFhXFxuQkJCXFxuY2NjXCIpO1xuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQuZmlyc3RDaGFuZ2VkTGluZSwgMik7XG5cdH0pO1xuXG5cdGl0KFwicmFuZ2UgcmVwbGFjZSAoc2hyaW5rKVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgY29udGVudCA9IFwiYWFhXFxuYmJiXFxuY2NjXFxuZGRkXCI7XG5cdFx0Y29uc3QgZWRpdHM6IEhhc2hsaW5lRWRpdFtdID0gW3sgb3A6IFwicmVwbGFjZVwiLCBwb3M6IG1ha2VUYWcoMiwgXCJiYmJcIiksIGVuZDogbWFrZVRhZygzLCBcImNjY1wiKSwgbGluZXM6IFtcIk9ORVwiXSB9XTtcblx0XHRjb25zdCByZXN1bHQgPSBhcHBseUhhc2hsaW5lRWRpdHMoY29udGVudCwgZWRpdHMpO1xuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQubGluZXMsIFwiYWFhXFxuT05FXFxuZGRkXCIpO1xuXHR9KTtcblxuXHRpdChcInJhbmdlIHJlcGxhY2UgKHNhbWUgY291bnQpXCIsICgpID0+IHtcblx0XHRjb25zdCBjb250ZW50ID0gXCJhYWFcXG5iYmJcXG5jY2NcXG5kZGRcIjtcblx0XHRjb25zdCBlZGl0czogSGFzaGxpbmVFZGl0W10gPSBbXG5cdFx0XHR7IG9wOiBcInJlcGxhY2VcIiwgcG9zOiBtYWtlVGFnKDIsIFwiYmJiXCIpLCBlbmQ6IG1ha2VUYWcoMywgXCJjY2NcIiksIGxpbmVzOiBbXCJYWFhcIiwgXCJZWVlcIl0gfSxcblx0XHRdO1xuXHRcdGNvbnN0IHJlc3VsdCA9IGFwcGx5SGFzaGxpbmVFZGl0cyhjb250ZW50LCBlZGl0cyk7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5saW5lcywgXCJhYWFcXG5YWFhcXG5ZWVlcXG5kZGRcIik7XG5cdH0pO1xuXG5cdGl0KFwicmVwbGFjZXMgZmlyc3QgbGluZVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgY29udGVudCA9IFwiZmlyc3RcXG5zZWNvbmRcXG50aGlyZFwiO1xuXHRcdGNvbnN0IGVkaXRzOiBIYXNobGluZUVkaXRbXSA9IFt7IG9wOiBcInJlcGxhY2VcIiwgcG9zOiBtYWtlVGFnKDEsIFwiZmlyc3RcIiksIGxpbmVzOiBbXCJGSVJTVFwiXSB9XTtcblx0XHRjb25zdCByZXN1bHQgPSBhcHBseUhhc2hsaW5lRWRpdHMoY29udGVudCwgZWRpdHMpO1xuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQubGluZXMsIFwiRklSU1RcXG5zZWNvbmRcXG50aGlyZFwiKTtcblx0fSk7XG5cblx0aXQoXCJyZXBsYWNlcyBsYXN0IGxpbmVcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGNvbnRlbnQgPSBcImZpcnN0XFxuc2Vjb25kXFxudGhpcmRcIjtcblx0XHRjb25zdCBlZGl0czogSGFzaGxpbmVFZGl0W10gPSBbeyBvcDogXCJyZXBsYWNlXCIsIHBvczogbWFrZVRhZygzLCBcInRoaXJkXCIpLCBsaW5lczogW1wiVEhJUkRcIl0gfV07XG5cdFx0Y29uc3QgcmVzdWx0ID0gYXBwbHlIYXNobGluZUVkaXRzKGNvbnRlbnQsIGVkaXRzKTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0LmxpbmVzLCBcImZpcnN0XFxuc2Vjb25kXFxuVEhJUkRcIik7XG5cdH0pO1xufSk7XG5cbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuLy8gYXBwbHlIYXNobGluZUVkaXRzIFx1MjAxNCBkZWxldGVcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG5kZXNjcmliZShcImFwcGx5SGFzaGxpbmVFZGl0cyBcdTIwMTQgZGVsZXRlXCIsICgpID0+IHtcblx0aXQoXCJkZWxldGVzIHNpbmdsZSBsaW5lXCIsICgpID0+IHtcblx0XHRjb25zdCBjb250ZW50ID0gXCJhYWFcXG5iYmJcXG5jY2NcIjtcblx0XHRjb25zdCBlZGl0czogSGFzaGxpbmVFZGl0W10gPSBbeyBvcDogXCJyZXBsYWNlXCIsIHBvczogbWFrZVRhZygyLCBcImJiYlwiKSwgbGluZXM6IFtdIH1dO1xuXHRcdGNvbnN0IHJlc3VsdCA9IGFwcGx5SGFzaGxpbmVFZGl0cyhjb250ZW50LCBlZGl0cyk7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5saW5lcywgXCJhYWFcXG5jY2NcIik7XG5cdH0pO1xuXG5cdGl0KFwiZGVsZXRlcyByYW5nZSBvZiBsaW5lc1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgY29udGVudCA9IFwiYWFhXFxuYmJiXFxuY2NjXFxuZGRkXCI7XG5cdFx0Y29uc3QgZWRpdHM6IEhhc2hsaW5lRWRpdFtdID0gW3sgb3A6IFwicmVwbGFjZVwiLCBwb3M6IG1ha2VUYWcoMiwgXCJiYmJcIiksIGVuZDogbWFrZVRhZygzLCBcImNjY1wiKSwgbGluZXM6IFtdIH1dO1xuXHRcdGNvbnN0IHJlc3VsdCA9IGFwcGx5SGFzaGxpbmVFZGl0cyhjb250ZW50LCBlZGl0cyk7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5saW5lcywgXCJhYWFcXG5kZGRcIik7XG5cdH0pO1xufSk7XG5cbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuLy8gYXBwbHlIYXNobGluZUVkaXRzIFx1MjAxNCBhcHBlbmRcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG5kZXNjcmliZShcImFwcGx5SGFzaGxpbmVFZGl0cyBcdTIwMTQgYXBwZW5kXCIsICgpID0+IHtcblx0aXQoXCJpbnNlcnRzIGFmdGVyIGEgbGluZVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgY29udGVudCA9IFwiYWFhXFxuYmJiXFxuY2NjXCI7XG5cdFx0Y29uc3QgZWRpdHM6IEhhc2hsaW5lRWRpdFtdID0gW3sgb3A6IFwiYXBwZW5kXCIsIHBvczogbWFrZVRhZygxLCBcImFhYVwiKSwgbGluZXM6IFtcIk5FV1wiXSB9XTtcblx0XHRjb25zdCByZXN1bHQgPSBhcHBseUhhc2hsaW5lRWRpdHMoY29udGVudCwgZWRpdHMpO1xuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQubGluZXMsIFwiYWFhXFxuTkVXXFxuYmJiXFxuY2NjXCIpO1xuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQuZmlyc3RDaGFuZ2VkTGluZSwgMik7XG5cdH0pO1xuXG5cdGl0KFwiaW5zZXJ0cyBtdWx0aXBsZSBsaW5lc1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgY29udGVudCA9IFwiYWFhXFxuYmJiXCI7XG5cdFx0Y29uc3QgZWRpdHM6IEhhc2hsaW5lRWRpdFtdID0gW3sgb3A6IFwiYXBwZW5kXCIsIHBvczogbWFrZVRhZygxLCBcImFhYVwiKSwgbGluZXM6IFtcInhcIiwgXCJ5XCIsIFwielwiXSB9XTtcblx0XHRjb25zdCByZXN1bHQgPSBhcHBseUhhc2hsaW5lRWRpdHMoY29udGVudCwgZWRpdHMpO1xuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQubGluZXMsIFwiYWFhXFxueFxcbnlcXG56XFxuYmJiXCIpO1xuXHR9KTtcblxuXHRpdChcImluc2VydHMgYXQgRU9GIHdpdGhvdXQgYW5jaG9yc1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgY29udGVudCA9IFwiYWFhXFxuYmJiXCI7XG5cdFx0Y29uc3QgZWRpdHMgPSBbeyBvcDogXCJhcHBlbmRcIiwgbGluZXM6IFtcIk5FV1wiXSB9XSBhcyB1bmtub3duIGFzIEhhc2hsaW5lRWRpdFtdO1xuXHRcdGNvbnN0IHJlc3VsdCA9IGFwcGx5SGFzaGxpbmVFZGl0cyhjb250ZW50LCBlZGl0cyk7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5saW5lcywgXCJhYWFcXG5iYmJcXG5ORVdcIik7XG5cdH0pO1xufSk7XG5cbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuLy8gYXBwbHlIYXNobGluZUVkaXRzIFx1MjAxNCBwcmVwZW5kXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuZGVzY3JpYmUoXCJhcHBseUhhc2hsaW5lRWRpdHMgXHUyMDE0IHByZXBlbmRcIiwgKCkgPT4ge1xuXHRpdChcImluc2VydHMgYmVmb3JlIGEgbGluZVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgY29udGVudCA9IFwiYWFhXFxuYmJiXFxuY2NjXCI7XG5cdFx0Y29uc3QgZWRpdHM6IEhhc2hsaW5lRWRpdFtdID0gW3sgb3A6IFwicHJlcGVuZFwiLCBwb3M6IG1ha2VUYWcoMiwgXCJiYmJcIiksIGxpbmVzOiBbXCJORVdcIl0gfV07XG5cdFx0Y29uc3QgcmVzdWx0ID0gYXBwbHlIYXNobGluZUVkaXRzKGNvbnRlbnQsIGVkaXRzKTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0LmxpbmVzLCBcImFhYVxcbk5FV1xcbmJiYlxcbmNjY1wiKTtcblx0fSk7XG5cblx0aXQoXCJwcmVwZW5kcyBhdCBCT0Ygd2l0aG91dCBhbmNob3JcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGNvbnRlbnQgPSBcImFhYVxcbmJiYlwiO1xuXHRcdGNvbnN0IGVkaXRzID0gW3sgb3A6IFwicHJlcGVuZFwiLCBsaW5lczogW1wiTkVXXCJdIH1dIGFzIHVua25vd24gYXMgSGFzaGxpbmVFZGl0W107XG5cdFx0Y29uc3QgcmVzdWx0ID0gYXBwbHlIYXNobGluZUVkaXRzKGNvbnRlbnQsIGVkaXRzKTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0LmxpbmVzLCBcIk5FV1xcbmFhYVxcbmJiYlwiKTtcblx0fSk7XG5cblx0aXQoXCJpbnNlcnQgYmVmb3JlIGFuZCBpbnNlcnQgYWZ0ZXIgYXQgc2FtZSBsaW5lIHByb2R1Y2UgY29ycmVjdCBvcmRlclwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgY29udGVudCA9IFwiYWFhXFxuYmJiXFxuY2NjXCI7XG5cdFx0Y29uc3QgZWRpdHM6IEhhc2hsaW5lRWRpdFtdID0gW1xuXHRcdFx0eyBvcDogXCJwcmVwZW5kXCIsIHBvczogbWFrZVRhZygyLCBcImJiYlwiKSwgbGluZXM6IFtcIkJFRk9SRVwiXSB9LFxuXHRcdFx0eyBvcDogXCJhcHBlbmRcIiwgcG9zOiBtYWtlVGFnKDIsIFwiYmJiXCIpLCBsaW5lczogW1wiQUZURVJcIl0gfSxcblx0XHRdO1xuXHRcdGNvbnN0IHJlc3VsdCA9IGFwcGx5SGFzaGxpbmVFZGl0cyhjb250ZW50LCBlZGl0cyk7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5saW5lcywgXCJhYWFcXG5CRUZPUkVcXG5iYmJcXG5BRlRFUlxcbmNjY1wiKTtcblx0fSk7XG59KTtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBhcHBseUhhc2hsaW5lRWRpdHMgXHUyMDE0IG11bHRpcGxlIGVkaXRzXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuZGVzY3JpYmUoXCJhcHBseUhhc2hsaW5lRWRpdHMgXHUyMDE0IG11bHRpcGxlIGVkaXRzXCIsICgpID0+IHtcblx0aXQoXCJhcHBsaWVzIHR3byBub24tb3ZlcmxhcHBpbmcgcmVwbGFjZXMgKGJvdHRvbS11cCBzYWZlKVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgY29udGVudCA9IFwiYWFhXFxuYmJiXFxuY2NjXFxuZGRkXFxuZWVlXCI7XG5cdFx0Y29uc3QgZWRpdHM6IEhhc2hsaW5lRWRpdFtdID0gW1xuXHRcdFx0eyBvcDogXCJyZXBsYWNlXCIsIHBvczogbWFrZVRhZygyLCBcImJiYlwiKSwgbGluZXM6IFtcIkJCQlwiXSB9LFxuXHRcdFx0eyBvcDogXCJyZXBsYWNlXCIsIHBvczogbWFrZVRhZyg0LCBcImRkZFwiKSwgbGluZXM6IFtcIkRERFwiXSB9LFxuXHRcdF07XG5cdFx0Y29uc3QgcmVzdWx0ID0gYXBwbHlIYXNobGluZUVkaXRzKGNvbnRlbnQsIGVkaXRzKTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0LmxpbmVzLCBcImFhYVxcbkJCQlxcbmNjY1xcbkRERFxcbmVlZVwiKTtcblx0fSk7XG5cblx0aXQoXCJlbXB0eSBlZGl0cyBhcnJheSBpcyBhIG5vLW9wXCIsICgpID0+IHtcblx0XHRjb25zdCBjb250ZW50ID0gXCJhYWFcXG5iYmJcIjtcblx0XHRjb25zdCByZXN1bHQgPSBhcHBseUhhc2hsaW5lRWRpdHMoY29udGVudCwgW10pO1xuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQubGluZXMsIGNvbnRlbnQpO1xuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQuZmlyc3RDaGFuZ2VkTGluZSwgdW5kZWZpbmVkKTtcblx0fSk7XG59KTtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBhcHBseUhhc2hsaW5lRWRpdHMgXHUyMDE0IGVycm9yIGNhc2VzXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuZGVzY3JpYmUoXCJhcHBseUhhc2hsaW5lRWRpdHMgXHUyMDE0IGVycm9yc1wiLCAoKSA9PiB7XG5cdGl0KFwicmVqZWN0cyBzdGFsZSBoYXNoXCIsICgpID0+IHtcblx0XHRjb25zdCBjb250ZW50ID0gXCJhYWFcXG5iYmJcXG5jY2NcIjtcblx0XHRjb25zdCBlZGl0czogSGFzaGxpbmVFZGl0W10gPSBbeyBvcDogXCJyZXBsYWNlXCIsIHBvczogcGFyc2VUYWcoXCIyI1FRXCIpLCBsaW5lczogW1wiQkJCXCJdIH1dO1xuXHRcdGFzc2VydC50aHJvd3MoKCkgPT4gYXBwbHlIYXNobGluZUVkaXRzKGNvbnRlbnQsIGVkaXRzKSwgKGVycjogYW55KSA9PiBlcnIgaW5zdGFuY2VvZiBIYXNobGluZU1pc21hdGNoRXJyb3IpO1xuXHR9KTtcblxuXHRpdChcInN0YWxlIGhhc2ggZXJyb3Igc2hvd3MgPj4+IG1hcmtlcnMgd2l0aCBjb3JyZWN0IGhhc2hlc1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgY29udGVudCA9IFwiYWFhXFxuYmJiXFxuY2NjXFxuZGRkXFxuZWVlXCI7XG5cdFx0Y29uc3QgZWRpdHM6IEhhc2hsaW5lRWRpdFtdID0gW3sgb3A6IFwicmVwbGFjZVwiLCBwb3M6IHBhcnNlVGFnKFwiMiNRUVwiKSwgbGluZXM6IFtcIkJCQlwiXSB9XTtcblxuXHRcdHRyeSB7XG5cdFx0XHRhcHBseUhhc2hsaW5lRWRpdHMoY29udGVudCwgZWRpdHMpO1xuXHRcdFx0YXNzZXJ0LmZhaWwoXCJzaG91bGQgaGF2ZSB0aHJvd25cIik7XG5cdFx0fSBjYXRjaCAoZXJyOiBhbnkpIHtcblx0XHRcdGFzc2VydC5vayhlcnIgaW5zdGFuY2VvZiBIYXNobGluZU1pc21hdGNoRXJyb3IpO1xuXHRcdFx0YXNzZXJ0Lm9rKGVyci5tZXNzYWdlLmluY2x1ZGVzKFwiPj4+XCIpKTtcblx0XHRcdGNvbnN0IGNvcnJlY3RIYXNoID0gY29tcHV0ZUxpbmVIYXNoKDIsIFwiYmJiXCIpO1xuXHRcdFx0YXNzZXJ0Lm9rKGVyci5tZXNzYWdlLmluY2x1ZGVzKGAyIyR7Y29ycmVjdEhhc2h9OmJiYmApKTtcblx0XHR9XG5cdH0pO1xuXG5cdGl0KFwicmVqZWN0cyBvdXQtb2YtcmFuZ2UgbGluZVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgY29udGVudCA9IFwiYWFhXFxuYmJiXCI7XG5cdFx0Y29uc3QgZWRpdHM6IEhhc2hsaW5lRWRpdFtdID0gW3sgb3A6IFwicmVwbGFjZVwiLCBwb3M6IHBhcnNlVGFnKFwiMTAjWlpcIiksIGxpbmVzOiBbXCJYXCJdIH1dO1xuXHRcdGFzc2VydC50aHJvd3MoKCkgPT4gYXBwbHlIYXNobGluZUVkaXRzKGNvbnRlbnQsIGVkaXRzKSwgL2RvZXMgbm90IGV4aXN0Lyk7XG5cdH0pO1xuXG5cdGl0KFwicmVqZWN0cyByYW5nZSB3aXRoIHN0YXJ0ID4gZW5kXCIsICgpID0+IHtcblx0XHRjb25zdCBjb250ZW50ID0gXCJhYWFcXG5iYmJcXG5jY2NcXG5kZGRcXG5lZWVcIjtcblx0XHRjb25zdCBlZGl0czogSGFzaGxpbmVFZGl0W10gPSBbeyBvcDogXCJyZXBsYWNlXCIsIHBvczogbWFrZVRhZyg1LCBcImVlZVwiKSwgZW5kOiBtYWtlVGFnKDIsIFwiYmJiXCIpLCBsaW5lczogW1wiWFwiXSB9XTtcblx0XHRhc3NlcnQudGhyb3dzKCgpID0+IGFwcGx5SGFzaGxpbmVFZGl0cyhjb250ZW50LCBlZGl0cykpO1xuXHR9KTtcbn0pO1xuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIHN0cmlwTmV3TGluZVByZWZpeGVzXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuZGVzY3JpYmUoXCJzdHJpcE5ld0xpbmVQcmVmaXhlc1wiLCAoKSA9PiB7XG5cdGl0KFwic3RyaXBzIGxlYWRpbmcgJysnIHdoZW4gbWFqb3JpdHkgb2YgbGluZXMgc3RhcnQgd2l0aCAnKydcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGxpbmVzID0gW1wiK2xpbmUgb25lXCIsIFwiK2xpbmUgdHdvXCIsIFwiK2xpbmUgdGhyZWVcIl07XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChzdHJpcE5ld0xpbmVQcmVmaXhlcyhsaW5lcyksIFtcImxpbmUgb25lXCIsIFwibGluZSB0d29cIiwgXCJsaW5lIHRocmVlXCJdKTtcblx0fSk7XG5cblx0aXQoXCJkb2VzIE5PVCBzdHJpcCBsZWFkaW5nICctJyBmcm9tIE1hcmtkb3duIGxpc3QgaXRlbXNcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGxpbmVzID0gW1wiLSBpdGVtIG9uZVwiLCBcIi0gaXRlbSB0d29cIiwgXCItIGl0ZW0gdGhyZWVcIl07XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChzdHJpcE5ld0xpbmVQcmVmaXhlcyhsaW5lcyksIFtcIi0gaXRlbSBvbmVcIiwgXCItIGl0ZW0gdHdvXCIsIFwiLSBpdGVtIHRocmVlXCJdKTtcblx0fSk7XG5cblx0aXQoXCJzdHJpcHMgaGFzaGxpbmUgcHJlZml4ZXMgd2hlbiBhbGwgbm9uLWVtcHR5IGxpbmVzIGNhcnJ5IHRoZW1cIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGxpbmVzID0gW1wiMSNXUTpmb29cIiwgXCIyI1RaOmJhclwiLCBcIjMjSFg6YmF6XCJdO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwoc3RyaXBOZXdMaW5lUHJlZml4ZXMobGluZXMpLCBbXCJmb29cIiwgXCJiYXJcIiwgXCJiYXpcIl0pO1xuXHR9KTtcblxuXHRpdChcImRvZXMgTk9UIHN0cmlwIGhhc2hsaW5lIHByZWZpeGVzIHdoZW4gYW55IG5vbi1lbXB0eSBsaW5lIGlzIHBsYWluIGNvbnRlbnRcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGxpbmVzID0gW1wiMSNXUTpmb29cIiwgXCJiYXJcIiwgXCIzI0hYOmJhelwiXTtcblx0XHRhc3NlcnQuZGVlcEVxdWFsKHN0cmlwTmV3TGluZVByZWZpeGVzKGxpbmVzKSwgW1wiMSNXUTpmb29cIiwgXCJiYXJcIiwgXCIzI0hYOmJhelwiXSk7XG5cdH0pO1xuXG5cdGl0KFwiZG9lcyBOT1Qgc3RyaXAgY29tbWVudCBsaW5lcyB0aGF0IGxvb2sgbGlrZSBoYXNobGluZSBwcmVmaXhlc1wiLCAoKSA9PiB7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChzdHJpcE5ld0xpbmVQcmVmaXhlcyhbXCIgICMgTm90ZTogVXNpbmcgYSBmaXhlZCB2ZXJzaW9uXCJdKSwgW1wiICAjIE5vdGU6IFVzaW5nIGEgZml4ZWQgdmVyc2lvblwiXSk7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChzdHJpcE5ld0xpbmVQcmVmaXhlcyhbXCIjIFRPRE86IHJlbW92ZSB0aGlzXCJdKSwgW1wiIyBUT0RPOiByZW1vdmUgdGhpc1wiXSk7XG5cdH0pO1xufSk7XG5cbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuLy8gcGFyc2VIYXNobGluZVRleHRcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG5kZXNjcmliZShcInBhcnNlSGFzaGxpbmVUZXh0XCIsICgpID0+IHtcblx0aXQoXCJyZXR1cm5zIGVtcHR5IGFycmF5IGZvciBudWxsXCIsICgpID0+IHtcblx0XHRhc3NlcnQuZGVlcEVxdWFsKHBhcnNlSGFzaGxpbmVUZXh0KG51bGwpLCBbXSk7XG5cdH0pO1xuXG5cdGl0KFwicmV0dXJucyBhcnJheSBpbnB1dCBhcy1pcyB3aGVuIG5vIHN0cmlwIGhldXJpc3RpYyBhcHBsaWVzXCIsICgpID0+IHtcblx0XHRjb25zdCBpbnB1dCA9IFtcIi0gW3hdIGRvbmVcIiwgXCItIFsgXSB0b2RvXCJdO1xuXHRcdGFzc2VydC5lcXVhbChwYXJzZUhhc2hsaW5lVGV4dChpbnB1dCksIGlucHV0KTtcblx0fSk7XG5cblx0aXQoXCJzcGxpdHMgc3RyaW5nIG9uIG5ld2xpbmUgYW5kIHByZXNlcnZlcyBNYXJrZG93biBsaXN0ICctJyBwcmVmaXhcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlc3VsdCA9IHBhcnNlSGFzaGxpbmVUZXh0KFwiLSBpdGVtIG9uZVxcbi0gaXRlbSB0d29cXG4tIGl0ZW0gdGhyZWVcIik7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQsIFtcIi0gaXRlbSBvbmVcIiwgXCItIGl0ZW0gdHdvXCIsIFwiLSBpdGVtIHRocmVlXCJdKTtcblx0fSk7XG5cblx0aXQoXCJzdHJpcHMgJysnIGRpZmYgbWFya2VycyBmcm9tIHN0cmluZyBpbnB1dFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVzdWx0ID0gcGFyc2VIYXNobGluZVRleHQoXCIrbGluZSBvbmVcXG4rbGluZSB0d29cIik7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQsIFtcImxpbmUgb25lXCIsIFwibGluZSB0d29cIl0pO1xuXHR9KTtcblxuXHRpdChcInN0aWxsIHN0cmlwcyB0cmFpbGluZyBlbXB0eSBmcm9tIHN0cmluZyBzcGxpdFwiLCAoKSA9PiB7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChwYXJzZUhhc2hsaW5lVGV4dChcImZvb1xcblwiKSwgW1wiZm9vXCJdKTtcblx0fSk7XG59KTtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBBdXRvLWNvcnJlY3Rpb24gaGV1cmlzdGljc1xuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbmRlc2NyaWJlKFwiYXBwbHlIYXNobGluZUVkaXRzIFx1MjAxNCBoZXVyaXN0aWNzXCIsICgpID0+IHtcblx0aXQoXCJhdXRvLWNvcnJlY3RzIG9mZi1ieS1vbmUgcmFuZ2UgZW5kIHRoYXQgZHVwbGljYXRlcyBhIGNsb3NpbmcgYnJhY2VcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGNvbnRlbnQgPSBcImlmIChvaykge1xcbiAgcnVuKCk7XFxufVxcbmFmdGVyKCk7XCI7XG5cdFx0Y29uc3QgZWRpdHM6IEhhc2hsaW5lRWRpdFtdID0gW1xuXHRcdFx0e1xuXHRcdFx0XHRvcDogXCJyZXBsYWNlXCIsXG5cdFx0XHRcdHBvczogbWFrZVRhZygxLCBcImlmIChvaykge1wiKSxcblx0XHRcdFx0ZW5kOiBtYWtlVGFnKDIsIFwiICBydW4oKTtcIiksXG5cdFx0XHRcdGxpbmVzOiBbXCJpZiAob2spIHtcIiwgXCIgIHJ1blNhZmUoKTtcIiwgXCJ9XCJdLFxuXHRcdFx0fSxcblx0XHRdO1xuXHRcdGNvbnN0IHJlc3VsdCA9IGFwcGx5SGFzaGxpbmVFZGl0cyhjb250ZW50LCBlZGl0cyk7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5saW5lcywgXCJpZiAob2spIHtcXG4gIHJ1blNhZmUoKTtcXG59XFxuYWZ0ZXIoKTtcIik7XG5cdFx0YXNzZXJ0Lm9rKHJlc3VsdC53YXJuaW5ncyk7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdC53YXJuaW5ncyEubGVuZ3RoLCAxKTtcblx0XHRhc3NlcnQub2socmVzdWx0Lndhcm5pbmdzIVswXS5pbmNsdWRlcyhcIkF1dG8tY29ycmVjdGVkIHJhbmdlIHJlcGxhY2VcIikpO1xuXHR9KTtcblxuXHRpdChcImF1dG8tY29ycmVjdHMgZXNjYXBlZCB0YWIgaW5kZW50YXRpb25cIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGNvbnRlbnQgPSBcInJvb3RcXG5cXHRjaGlsZFxcblxcdFxcdHZhbHVlXFxuZW5kXCI7XG5cdFx0Y29uc3QgZWRpdHM6IEhhc2hsaW5lRWRpdFtdID0gW3sgb3A6IFwicmVwbGFjZVwiLCBwb3M6IG1ha2VUYWcoMywgXCJcXHRcXHR2YWx1ZVwiKSwgbGluZXM6IFtcIlxcXFx0XFxcXHRyZXBsYWNlZFwiXSB9XTtcblx0XHRjb25zdCByZXN1bHQgPSBhcHBseUhhc2hsaW5lRWRpdHMoY29udGVudCwgZWRpdHMpO1xuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQubGluZXMsIFwicm9vdFxcblxcdGNoaWxkXFxuXFx0XFx0cmVwbGFjZWRcXG5lbmRcIik7XG5cdFx0YXNzZXJ0Lm9rKHJlc3VsdC53YXJuaW5ncyk7XG5cdFx0YXNzZXJ0Lm9rKHJlc3VsdC53YXJuaW5ncyFbMF0uaW5jbHVkZXMoXCJBdXRvLWNvcnJlY3RlZCBlc2NhcGVkIHRhYiBpbmRlbnRhdGlvblwiKSk7XG5cdH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxTQUFTLFVBQVUsVUFBVTtBQUM3QixPQUFPLFlBQVk7QUFDbkI7QUFBQSxFQUNDO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUdNO0FBRVAsU0FBUyxRQUFRLE1BQWMsU0FBeUI7QUFDdkQsU0FBTyxTQUFTLGNBQWMsTUFBTSxPQUFPLENBQUM7QUFDN0M7QUFNQSxTQUFTLG1CQUFtQixNQUFNO0FBQ2pDLEtBQUcsd0RBQXdELE1BQU07QUFDaEUsVUFBTSxPQUFPLGdCQUFnQixHQUFHLE9BQU87QUFDdkMsV0FBTyxNQUFNLE1BQU0seUJBQXlCO0FBQUEsRUFDN0MsQ0FBQztBQUVELEtBQUcsZ0RBQWdELE1BQU07QUFDeEQsVUFBTSxJQUFJLGdCQUFnQixHQUFHLE9BQU87QUFDcEMsVUFBTSxJQUFJLGdCQUFnQixHQUFHLE9BQU87QUFDcEMsV0FBTyxNQUFNLEdBQUcsQ0FBQztBQUFBLEVBQ2xCLENBQUM7QUFFRCxLQUFHLDZDQUE2QyxNQUFNO0FBQ3JELFVBQU0sSUFBSSxnQkFBZ0IsR0FBRyxPQUFPO0FBQ3BDLFVBQU0sSUFBSSxnQkFBZ0IsR0FBRyxPQUFPO0FBQ3BDLFdBQU8sU0FBUyxHQUFHLENBQUM7QUFBQSxFQUNyQixDQUFDO0FBRUQsS0FBRyxrQ0FBa0MsTUFBTTtBQUMxQyxVQUFNLE9BQU8sZ0JBQWdCLEdBQUcsRUFBRTtBQUNsQyxXQUFPLE1BQU0s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
