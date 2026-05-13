import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  computeEditDiff,
  fuzzyFindText,
  generateDiffString,
  normalizeForFuzzyMatch
} from "./edit-diff.js";
describe("edit-diff", () => {
  it("normalizes quotes, dashes, spaces, and trailing whitespace", () => {
    const input = "\u201Chello\u201D\xA0world \u2014 test  \nnext		\n";
    assert.equal(normalizeForFuzzyMatch(input), '"hello" world - test\nnext\n');
  });
  it("falls back to fuzzy matching when unicode punctuation differs", () => {
    const result = fuzzyFindText("const title = \u201CHello\u201D;\n", 'const title = "Hello";\n');
    assert.equal(result.found, true);
    assert.equal(result.usedFuzzyMatch, true);
    assert.equal(result.contentForReplacement, 'const title = "Hello";\n');
  });
  it("renders numbered diffs with the first changed line", () => {
    const result = generateDiffString("line 1\nline 2\nline 3\n", "line 1\nline two\nline 3\n");
    assert.equal(result.firstChangedLine, 2);
    assert.match(result.diff, /-2 line 2/);
    assert.match(result.diff, /\+2 line two/);
  });
  it("respects contextLines and inserts separators for distant changes", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const oldContent = lines.join("\n") + "\n";
    const modified = [...lines];
    modified[1] = "changed 2";
    modified[17] = "changed 18";
    const newContent = modified.join("\n") + "\n";
    const result = generateDiffString(oldContent, newContent, 2);
    assert.match(result.diff, /\.\.\./);
    assert.doesNotMatch(result.diff, /line 10/);
    assert.match(result.diff, /changed 2/);
    assert.match(result.diff, /changed 18/);
  });
  it("handles large files without OOM by falling back to linear diff", () => {
    const lineCount = 3e3;
    const oldLines = Array.from({ length: lineCount }, (_, i) => `line ${i}`);
    const newLines = [...oldLines];
    newLines[1500] = "CHANGED";
    const result = generateDiffString(oldLines.join("\n") + "\n", newLines.join("\n") + "\n");
    assert.ok(result.firstChangedLine !== void 0);
    assert.match(result.diff, /CHANGED/);
  });
  it("computes diffs for preview without native helpers", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "edit-diff-test-"));
    t.after(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const file = join(dir, "sample.ts");
    writeFileSync(file, "const title = \u201CHello\u201D;\n", "utf-8");
    const result = await computeEditDiff(
      file,
      'const title = "Hello";\n',
      'const title = "Hi";\n',
      dir
    );
    assert.ok(!("error" in result), "expected a diff result");
    if (!("error" in result)) {
      assert.equal(result.firstChangedLine, 1);
      assert.match(result.diff, /\+1 const title = "Hi";/);
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL3Rvb2xzL2VkaXQtZGlmZi50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBkZXNjcmliZSwgaXQgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5cbmltcG9ydCB7XG5cdGNvbXB1dGVFZGl0RGlmZixcblx0ZnV6enlGaW5kVGV4dCxcblx0Z2VuZXJhdGVEaWZmU3RyaW5nLFxuXHRub3JtYWxpemVGb3JGdXp6eU1hdGNoLFxufSBmcm9tIFwiLi9lZGl0LWRpZmYuanNcIjtcblxuZGVzY3JpYmUoXCJlZGl0LWRpZmZcIiwgKCkgPT4ge1xuXHRpdChcIm5vcm1hbGl6ZXMgcXVvdGVzLCBkYXNoZXMsIHNwYWNlcywgYW5kIHRyYWlsaW5nIHdoaXRlc3BhY2VcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGlucHV0ID0gXCJcdTIwMUNoZWxsb1x1MjAxRFxcdTAwQTB3b3JsZCBcdTIwMTQgdGVzdCAgXFxubmV4dFxcdFxcdFxcblwiO1xuXHRcdGFzc2VydC5lcXVhbChub3JtYWxpemVGb3JGdXp6eU1hdGNoKGlucHV0KSwgXCJcXFwiaGVsbG9cXFwiIHdvcmxkIC0gdGVzdFxcbm5leHRcXG5cIik7XG5cdH0pO1xuXG5cdGl0KFwiZmFsbHMgYmFjayB0byBmdXp6eSBtYXRjaGluZyB3aGVuIHVuaWNvZGUgcHVuY3R1YXRpb24gZGlmZmVyc1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVzdWx0ID0gZnV6enlGaW5kVGV4dChcImNvbnN0IHRpdGxlID0gXHUyMDFDSGVsbG9cdTIwMUQ7XFxuXCIsIFwiY29uc3QgdGl0bGUgPSBcXFwiSGVsbG9cXFwiO1xcblwiKTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0LmZvdW5kLCB0cnVlKTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0LnVzZWRGdXp6eU1hdGNoLCB0cnVlKTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0LmNvbnRlbnRGb3JSZXBsYWNlbWVudCwgXCJjb25zdCB0aXRsZSA9IFxcXCJIZWxsb1xcXCI7XFxuXCIpO1xuXHR9KTtcblxuXHRpdChcInJlbmRlcnMgbnVtYmVyZWQgZGlmZnMgd2l0aCB0aGUgZmlyc3QgY2hhbmdlZCBsaW5lXCIsICgpID0+IHtcblx0XHRjb25zdCByZXN1bHQgPSBnZW5lcmF0ZURpZmZTdHJpbmcoXCJsaW5lIDFcXG5saW5lIDJcXG5saW5lIDNcXG5cIiwgXCJsaW5lIDFcXG5saW5lIHR3b1xcbmxpbmUgM1xcblwiKTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0LmZpcnN0Q2hhbmdlZExpbmUsIDIpO1xuXHRcdGFzc2VydC5tYXRjaChyZXN1bHQuZGlmZiwgLy0yIGxpbmUgMi8pO1xuXHRcdGFzc2VydC5tYXRjaChyZXN1bHQuZGlmZiwgL1xcKzIgbGluZSB0d28vKTtcblx0fSk7XG5cblx0aXQoXCJyZXNwZWN0cyBjb250ZXh0TGluZXMgYW5kIGluc2VydHMgc2VwYXJhdG9ycyBmb3IgZGlzdGFudCBjaGFuZ2VzXCIsICgpID0+IHtcblx0XHRjb25zdCBsaW5lcyA9IEFycmF5LmZyb20oeyBsZW5ndGg6IDIwIH0sIChfLCBpKSA9PiBgbGluZSAke2kgKyAxfWApO1xuXHRcdGNvbnN0IG9sZENvbnRlbnQgPSBsaW5lcy5qb2luKFwiXFxuXCIpICsgXCJcXG5cIjtcblx0XHRjb25zdCBtb2RpZmllZCA9IFsuLi5saW5lc107XG5cdFx0bW9kaWZpZWRbMV0gPSBcImNoYW5nZWQgMlwiOyAvLyBsaW5lIDJcblx0XHRtb2RpZmllZFsxN10gPSBcImNoYW5nZWQgMThcIjsgLy8gbGluZSAxOFxuXHRcdGNvbnN0IG5ld0NvbnRlbnQgPSBtb2RpZmllZC5qb2luKFwiXFxuXCIpICsgXCJcXG5cIjtcblxuXHRcdGNvbnN0IHJlc3VsdCA9IGdlbmVyYXRlRGlmZlN0cmluZyhvbGRDb250ZW50LCBuZXdDb250ZW50LCAyKTtcblx0XHQvLyBTaG91bGQgY29udGFpbiBzZXBhcmF0b3IgYmV0d2VlbiB0aGUgdHdvIGRpc3RhbnQgY2hhbmdlIHJlZ2lvbnNcblx0XHRhc3NlcnQubWF0Y2gocmVzdWx0LmRpZmYsIC9cXC5cXC5cXC4vKTtcblx0XHQvLyBTaG91bGQgTk9UIGNvbnRhaW4gbGluZXMgZmFyIGZyb20gY2hhbmdlcyAoZS5nLiBsaW5lIDEwKVxuXHRcdGFzc2VydC5kb2VzTm90TWF0Y2gocmVzdWx0LmRpZmYsIC9saW5lIDEwLyk7XG5cdFx0Ly8gU2hvdWxkIGNvbnRhaW4gdGhlIGNoYW5nZWQgbGluZXNcblx0XHRhc3NlcnQubWF0Y2gocmVzdWx0LmRpZmYsIC9jaGFuZ2VkIDIvKTtcblx0XHRhc3NlcnQubWF0Y2gocmVzdWx0LmRpZmYsIC9jaGFuZ2VkIDE4Lyk7XG5cdH0pO1xuXG5cdGl0KFwiaGFuZGxlcyBsYXJnZSBmaWxlcyB3aXRob3V0IE9PTSBieSBmYWxsaW5nIGJhY2sgdG8gbGluZWFyIGRpZmZcIiwgKCkgPT4ge1xuXHRcdC8vIENyZWF0ZSBmaWxlcyBsYXJnZSBlbm91Z2ggdG8gZXhjZWVkIHRoZSBEUCB0aHJlc2hvbGRcblx0XHRjb25zdCBsaW5lQ291bnQgPSAzMDAwO1xuXHRcdGNvbnN0IG9sZExpbmVzID0gQXJyYXkuZnJvbSh7IGxlbmd0aDogbGluZUNvdW50IH0sIChfLCBpKSA9PiBgbGluZSAke2l9YCk7XG5cdFx0Y29uc3QgbmV3TGluZXMgPSBbLi4ub2xkTGluZXNdO1xuXHRcdG5ld0xpbmVzWzE1MDBdID0gXCJDSEFOR0VEXCI7XG5cdFx0Y29uc3QgcmVzdWx0ID0gZ2VuZXJhdGVEaWZmU3RyaW5nKG9sZExpbmVzLmpvaW4oXCJcXG5cIikgKyBcIlxcblwiLCBuZXdMaW5lcy5qb2luKFwiXFxuXCIpICsgXCJcXG5cIik7XG5cdFx0YXNzZXJ0Lm9rKHJlc3VsdC5maXJzdENoYW5nZWRMaW5lICE9PSB1bmRlZmluZWQpO1xuXHRcdGFzc2VydC5tYXRjaChyZXN1bHQuZGlmZiwgL0NIQU5HRUQvKTtcblx0fSk7XG5cblx0aXQoXCJjb21wdXRlcyBkaWZmcyBmb3IgcHJldmlldyB3aXRob3V0IG5hdGl2ZSBoZWxwZXJzXCIsIGFzeW5jICh0KSA9PiB7XG5cdFx0Y29uc3QgZGlyID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJlZGl0LWRpZmYtdGVzdC1cIikpO1xuXHRcdHQuYWZ0ZXIoKCkgPT4ge1xuXHRcdFx0cm1TeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuXHRcdH0pO1xuXG5cdFx0Y29uc3QgZmlsZSA9IGpvaW4oZGlyLCBcInNhbXBsZS50c1wiKTtcblx0XHR3cml0ZUZpbGVTeW5jKGZpbGUsIFwiY29uc3QgdGl0bGUgPSBcdTIwMUNIZWxsb1x1MjAxRDtcXG5cIiwgXCJ1dGYtOFwiKTtcblxuXHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNvbXB1dGVFZGl0RGlmZihcblx0XHRcdGZpbGUsXG5cdFx0XHRcImNvbnN0IHRpdGxlID0gXFxcIkhlbGxvXFxcIjtcXG5cIixcblx0XHRcdFwiY29uc3QgdGl0bGUgPSBcXFwiSGlcXFwiO1xcblwiLFxuXHRcdFx0ZGlyLFxuXHRcdCk7XG5cblx0XHRhc3NlcnQub2soIShcImVycm9yXCIgaW4gcmVzdWx0KSwgXCJleHBlY3RlZCBhIGRpZmYgcmVzdWx0XCIpO1xuXHRcdGlmICghKFwiZXJyb3JcIiBpbiByZXN1bHQpKSB7XG5cdFx0XHRhc3NlcnQuZXF1YWwocmVzdWx0LmZpcnN0Q2hhbmdlZExpbmUsIDEpO1xuXHRcdFx0YXNzZXJ0Lm1hdGNoKHJlc3VsdC5kaWZmLCAvXFwrMSBjb25zdCB0aXRsZSA9IFwiSGlcIjsvKTtc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
