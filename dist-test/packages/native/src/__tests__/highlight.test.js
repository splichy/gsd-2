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
const testColors = {
  comment: "\x1B[38;2;106;153;85m",
  keyword: "\x1B[38;2;197;134;192m",
  function: "\x1B[38;2;220;220;170m",
  variable: "\x1B[38;2;156;220;254m",
  string: "\x1B[38;2;206;145;120m",
  number: "\x1B[38;2;181;206;168m",
  type: "\x1B[38;2;78;201;176m",
  operator: "\x1B[38;2;212;212;212m",
  punctuation: "\x1B[38;2;212;212;212m"
};
describe("native highlight: highlightCode()", () => {
  test("highlights JavaScript code with ANSI colors", () => {
    const code = "const x = 42;\n";
    const result = native.highlightCode(code, "javascript", testColors);
    assert.ok(result.includes("\x1B["), "should contain ANSI escape codes");
    assert.ok(result.includes("const"), "should contain 'const'");
    assert.ok(result.includes("42"), "should contain '42'");
    assert.ok(result.includes("\x1B[39m"), "should contain ANSI reset codes");
  });
  test("returns unhighlighted code for unknown language", () => {
    const code = "some random text\n";
    const result = native.highlightCode(code, "nonexistent_lang_xyz", testColors);
    assert.ok(typeof result === "string");
    assert.ok(result.includes("some random text"));
  });
  test("handles null language gracefully", () => {
    const code = "hello world\n";
    const result = native.highlightCode(code, null, testColors);
    assert.ok(typeof result === "string");
    assert.ok(result.includes("hello world"));
  });
  test("handles empty code", () => {
    const result = native.highlightCode("", "javascript", testColors);
    assert.equal(result, "");
  });
  test("handles multiline code", () => {
    const code = 'function foo() {\n  return "bar";\n}\n';
    const result = native.highlightCode(code, "javascript", testColors);
    assert.ok(result.includes("function"));
    assert.ok(result.includes("foo"));
    assert.ok(result.includes("return"));
    assert.ok(result.includes("bar"));
  });
  test("supports optional inserted/deleted colors", () => {
    const colorsWithDiff = {
      ...testColors,
      inserted: "\x1B[38;2;0;255;0m",
      deleted: "\x1B[38;2;255;0;0m"
    };
    const code = "+added line\n-removed line\n";
    const result = native.highlightCode(code, "diff", colorsWithDiff);
    assert.ok(typeof result === "string");
    assert.ok(result.length > 0);
  });
});
describe("native highlight: supportsLanguage()", () => {
  test("returns true for known aliases", () => {
    assert.ok(native.supportsLanguage("javascript"));
    assert.ok(native.supportsLanguage("typescript"));
    assert.ok(native.supportsLanguage("python"));
    assert.ok(native.supportsLanguage("rust"));
    assert.ok(native.supportsLanguage("go"));
    assert.ok(native.supportsLanguage("bash"));
  });
  test("returns true case-insensitively", () => {
    assert.ok(native.supportsLanguage("JavaScript"));
    assert.ok(native.supportsLanguage("PYTHON"));
    assert.ok(native.supportsLanguage("Rust"));
  });
  test("returns true for short aliases", () => {
    assert.ok(native.supportsLanguage("ts"));
    assert.ok(native.supportsLanguage("py"));
    assert.ok(native.supportsLanguage("rs"));
    assert.ok(native.supportsLanguage("rb"));
    assert.ok(native.supportsLanguage("sh"));
  });
  test("returns false for completely unknown languages", () => {
    assert.equal(native.supportsLanguage("nonexistent_lang_xyz"), false);
  });
});
describe("native highlight: getSupportedLanguages()", () => {
  test("returns an array of language names", () => {
    const langs = native.getSupportedLanguages();
    assert.ok(Array.isArray(langs));
    assert.ok(langs.length > 0, "should have at least one language");
  });
  test("includes common languages", () => {
    const langs = native.getSupportedLanguages();
    assert.ok(langs.includes("JavaScript"), "should include JavaScript");
    assert.ok(langs.includes("Python"), "should include Python");
    assert.ok(langs.includes("Rust"), "should include Rust");
    assert.ok(langs.includes("C"), "should include C");
  });
  test("returns strings", () => {
    const langs = native.getSupportedLanguages();
    for (const lang of langs) {
      assert.equal(typeof lang, "string");
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvbmF0aXZlL3NyYy9fX3Rlc3RzX18vaGlnaGxpZ2h0LnRlc3QubWpzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyB0ZXN0LCBkZXNjcmliZSB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgY3JlYXRlUmVxdWlyZSB9IGZyb20gXCJub2RlOm1vZHVsZVwiO1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBmaWxlVVJMVG9QYXRoIH0gZnJvbSBcIm5vZGU6dXJsXCI7XG5cbmNvbnN0IF9fZGlybmFtZSA9IHBhdGguZGlybmFtZShmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuY29uc3QgcmVxdWlyZSA9IGNyZWF0ZVJlcXVpcmUoaW1wb3J0Lm1ldGEudXJsKTtcblxuLy8gTG9hZCB0aGUgbmF0aXZlIGFkZG9uIGRpcmVjdGx5XG5jb25zdCBhZGRvbkRpciA9IHBhdGgucmVzb2x2ZShfX2Rpcm5hbWUsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCJuYXRpdmVcIiwgXCJhZGRvblwiKTtcbmNvbnN0IHBsYXRmb3JtVGFnID0gYCR7cHJvY2Vzcy5wbGF0Zm9ybX0tJHtwcm9jZXNzLmFyY2h9YDtcbmNvbnN0IGNhbmRpZGF0ZXMgPSBbXG4gIHBhdGguam9pbihhZGRvbkRpciwgYGdzZF9lbmdpbmUuJHtwbGF0Zm9ybVRhZ30ubm9kZWApLFxuICBwYXRoLmpvaW4oYWRkb25EaXIsIFwiZ3NkX2VuZ2luZS5kZXYubm9kZVwiKSxcbl07XG5cbmxldCBuYXRpdmU7XG5mb3IgKGNvbnN0IGNhbmRpZGF0ZSBvZiBjYW5kaWRhdGVzKSB7XG4gIHRyeSB7XG4gICAgbmF0aXZlID0gcmVxdWlyZShjYW5kaWRhdGUpO1xuICAgIGJyZWFrO1xuICB9IGNhdGNoIHtcbiAgICAvLyB0cnkgbmV4dFxuICB9XG59XG5cbmlmICghbmF0aXZlKSB7XG4gIGNvbnNvbGUuZXJyb3IoXCJOYXRpdmUgYWRkb24gbm90IGZvdW5kLiBSdW4gYG5wbSBydW4gYnVpbGQ6bmF0aXZlIC13IEBnc2QvbmF0aXZlYCBmaXJzdC5cIik7XG4gIHByb2Nlc3MuZXhpdCgxKTtcbn1cblxuY29uc3QgdGVzdENvbG9ycyA9IHtcbiAgY29tbWVudDogXCJcXHgxYlszODsyOzEwNjsxNTM7ODVtXCIsXG4gIGtleXdvcmQ6IFwiXFx4MWJbMzg7MjsxOTc7MTM0OzE5Mm1cIixcbiAgZnVuY3Rpb246IFwiXFx4MWJbMzg7MjsyMjA7MjIwOzE3MG1cIixcbiAgdmFyaWFibGU6IFwiXFx4MWJbMzg7MjsxNTY7MjIwOzI1NG1cIixcbiAgc3RyaW5nOiBcIlxceDFiWzM4OzI7MjA2OzE0NTsxMjBtXCIsXG4gIG51bWJlcjogXCJcXHgxYlszODsyOzE4MTsyMDY7MTY4bVwiLFxuICB0eXBlOiBcIlxceDFiWzM4OzI7Nzg7MjAxOzE3Nm1cIixcbiAgb3BlcmF0b3I6IFwiXFx4MWJbMzg7MjsyMTI7MjEyOzIxMm1cIixcbiAgcHVuY3R1YXRpb246IFwiXFx4MWJbMzg7MjsyMTI7MjEyOzIxMm1cIixcbn07XG5cbmRlc2NyaWJlKFwibmF0aXZlIGhpZ2hsaWdodDogaGlnaGxpZ2h0Q29kZSgpXCIsICgpID0+IHtcbiAgdGVzdChcImhpZ2hsaWdodHMgSmF2YVNjcmlwdCBjb2RlIHdpdGggQU5TSSBjb2xvcnNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGNvZGUgPSAnY29uc3QgeCA9IDQyO1xcbic7XG4gICAgY29uc3QgcmVzdWx0ID0gbmF0aXZlLmhpZ2hsaWdodENvZGUoY29kZSwgXCJqYXZhc2NyaXB0XCIsIHRlc3RDb2xvcnMpO1xuXG4gICAgLy8gUmVzdWx0IHNob3VsZCBjb250YWluIEFOU0kgZXNjYXBlIHNlcXVlbmNlc1xuICAgIGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoXCJcXHgxYltcIiksIFwic2hvdWxkIGNvbnRhaW4gQU5TSSBlc2NhcGUgY29kZXNcIik7XG4gICAgLy8gUmVzdWx0IHNob3VsZCBjb250YWluIHRoZSBvcmlnaW5hbCB0b2tlbnNcbiAgICBhc3NlcnQub2socmVzdWx0LmluY2x1ZGVzKFwiY29uc3RcIiksIFwic2hvdWxkIGNvbnRhaW4gJ2NvbnN0J1wiKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmluY2x1ZGVzKFwiNDJcIiksIFwic2hvdWxkIGNvbnRhaW4gJzQyJ1wiKTtcbiAgICAvLyBSZXNldCBjb2RlcyBzaG91bGQgYmUgcHJlc2VudFxuICAgIGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoXCJcXHgxYlszOW1cIiksIFwic2hvdWxkIGNvbnRhaW4gQU5TSSByZXNldCBjb2Rlc1wiKTtcbiAgfSk7XG5cbiAgdGVzdChcInJldHVybnMgdW5oaWdobGlnaHRlZCBjb2RlIGZvciB1bmtub3duIGxhbmd1YWdlXCIsICgpID0+IHtcbiAgICBjb25zdCBjb2RlID0gXCJzb21lIHJhbmRvbSB0ZXh0XFxuXCI7XG4gICAgY29uc3QgcmVzdWx0ID0gbmF0aXZlLmhpZ2hsaWdodENvZGUoY29kZSwgXCJub25leGlzdGVudF9sYW5nX3h5elwiLCB0ZXN0Q29sb3JzKTtcblxuICAgIC8vIFBsYWluIHRleHQgc3ludGF4IHNob3VsZCBwYXNzIHRocm91Z2ggd2l0aG91dCBjb2xvciBjb2RlcyBvbiBwbGFpbiBjb250ZW50XG4gICAgYXNzZXJ0Lm9rKHR5cGVvZiByZXN1bHQgPT09IFwic3RyaW5nXCIpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoXCJzb21lIHJhbmRvbSB0ZXh0XCIpKTtcbiAgfSk7XG5cbiAgdGVzdChcImhhbmRsZXMgbnVsbCBsYW5ndWFnZSBncmFjZWZ1bGx5XCIsICgpID0+IHtcbiAgICBjb25zdCBjb2RlID0gXCJoZWxsbyB3b3JsZFxcblwiO1xuICAgIGNvbnN0IHJlc3VsdCA9IG5hdGl2ZS5oaWdobGlnaHRDb2RlKGNvZGUsIG51bGwsIHRlc3RDb2xvcnMpO1xuXG4gICAgYXNzZXJ0Lm9rKHR5cGVvZiByZXN1bHQgPT09IFwic3RyaW5nXCIpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoXCJoZWxsbyB3b3JsZFwiKSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJoYW5kbGVzIGVtcHR5IGNvZGVcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IG5hdGl2ZS5oaWdobGlnaHRDb2RlKFwiXCIsIFwiamF2YXNjcmlwdFwiLCB0ZXN0Q29sb3JzKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCBcIlwiKTtcbiAgfSk7XG5cbiAgdGVzdChcImhhbmRsZXMgbXVsdGlsaW5lIGNvZGVcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGNvZGUgPSAnZnVuY3Rpb24gZm9vKCkge1xcbiAgcmV0dXJuIFwiYmFyXCI7XFxufVxcbic7XG4gICAgY29uc3QgcmVzdWx0ID0gbmF0aXZlLmhpZ2hsaWdodENvZGUoY29kZSwgXCJqYXZhc2NyaXB0XCIsIHRlc3RDb2xvcnMpO1xuXG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcyhcImZ1bmN0aW9uXCIpKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmluY2x1ZGVzKFwiZm9vXCIpKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmluY2x1ZGVzKFwicmV0dXJuXCIpKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmluY2x1ZGVzKFwiYmFyXCIpKTtcbiAgfSk7XG5cbiAgdGVzdChcInN1cHBvcnRzIG9wdGlvbmFsIGluc2VydGVkL2RlbGV0ZWQgY29sb3JzXCIsICgpID0+IHtcbiAgICBjb25zdCBjb2xvcnNXaXRoRGlmZiA9IHtcbiAgICAgIC4uLnRlc3RDb2xvcnMsXG4gICAgICBpbnNlcnRlZDogXCJcXHgxYlszODsyOzA7MjU1OzBtXCIsXG4gICAgICBkZWxldGVkOiBcIlxceDFiWzM4OzI7MjU1OzA7MG1cIixcbiAgICB9O1xuICAgIGNvbnN0IGNvZGUgPSBcIithZGRlZCBsaW5lXFxuLXJlbW92ZWQgbGluZVxcblwiO1xuICAgIGNvbnN0IHJlc3VsdCA9IG5hdGl2ZS5oaWdobGlnaHRDb2RlKGNvZGUsIFwiZGlmZlwiLCBjb2xvcnNXaXRoRGlmZik7XG5cbiAgICBhc3NlcnQub2sodHlwZW9mIHJlc3VsdCA9PT0gXCJzdHJpbmdcIik7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5sZW5ndGggPiAwKTtcbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoXCJuYXRpdmUgaGlnaGxpZ2h0OiBzdXBwb3J0c0xhbmd1YWdlKClcIiwgKCkgPT4ge1xuICB0ZXN0KFwicmV0dXJucyB0cnVlIGZvciBrbm93biBhbGlhc2VzXCIsICgpID0+IHtcbiAgICBhc3NlcnQub2sobmF0aXZlLnN1cHBvcnRzTGFuZ3VhZ2UoXCJqYXZhc2NyaXB0XCIpKTtcbiAgICBhc3NlcnQub2sobmF0aXZlLnN1cHBvcnRzTGFuZ3VhZ2UoXCJ0eXBlc2NyaXB0XCIpKTtcbiAgICBhc3NlcnQub2sobmF0aXZlLnN1cHBvcnRzTGFuZ3VhZ2UoXCJweXRob25cIikpO1xuICAgIGFzc2VydC5vayhuYXRpdmUuc3VwcG9ydHNMYW5ndWFnZShcInJ1c3RcIikpO1xuICAgIGFzc2VydC5vayhuYXRpdmUuc3VwcG9ydHNMYW5ndWFnZShcImdvXCIpKTtcbiAgICBhc3NlcnQub2sobmF0aXZlLnN1cHBvcnRzTGFuZ3VhZ2UoXCJiYXNoXCIpKTtcbiAgfSk7XG5cbiAgdGVzdChcInJldHVybnMgdHJ1ZSBjYXNlLWluc2Vuc2l0aXZlbHlcIiwgKCkgPT4ge1xuICAgIGFzc2VydC5vayhuYXRpdmUuc3VwcG9ydHNMYW5ndWFnZShcIkphdmFTY3JpcHRcIikpO1xuICAgIGFzc2VydC5vayhuYXRpdmUuc3VwcG9ydHNMYW5ndWFnZShcIlBZVEhPTlwiKSk7XG4gICAgYXNzZXJ0Lm9rKG5hdGl2ZS5zdXBwb3J0c0xhbmd1YWdlKFwiUnVzdFwiKSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJyZXR1cm5zIHRydWUgZm9yIHNob3J0IGFsaWFzZXNcIiwgKCkgPT4ge1xuICAgIGFzc2VydC5vayhuYXRpdmUuc3VwcG9ydHNMYW5ndWFnZShcInRzXCIpKTtcbiAgICBhc3NlcnQub2sobmF0aXZlLnN1cHBvcnRzTGFuZ3VhZ2UoXCJweVwiKSk7XG4gICAgYXNzZXJ0Lm9rKG5hdGl2ZS5zdXBwb3J0c0xhbmd1YWdlKFwicnNcIikpO1xuICAgIGFzc2VydC5vayhuYXRpdmUuc3VwcG9ydHNMYW5ndWFnZShcInJiXCIpKTtcbiAgICBhc3NlcnQub2sobmF0aXZlLnN1cHBvcnRzTGFuZ3VhZ2UoXCJzaFwiKSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJyZXR1cm5zIGZhbHNlIGZvciBjb21wbGV0ZWx5IHVua25vd24gbGFuZ3VhZ2VzXCIsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwobmF0aXZlLnN1cHBvcnRzTGFuZ3VhZ2UoXCJub25leGlzdGVudF9sYW5nX3h5elwiKSwgZmFsc2UpO1xuICB9KTtcbn0pO1xuXG5kZXNjcmliZShcIm5hdGl2ZSBoaWdobGlnaHQ6IGdldFN1cHBvcnRlZExhbmd1YWdlcygpXCIsICgpID0+IHtcbiAgdGVzdChcInJldHVybnMgYW4gYXJyYXkgb2YgbGFuZ3VhZ2UgbmFtZXNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGxhbmdzID0gbmF0aXZlLmdldFN1cHBvcnRlZExhbmd1YWdlcygpO1xuICAgIGFzc2VydC5vayhBcnJheS5pc0FycmF5KGxhbmdzKSk7XG4gICAgYXNzZXJ0Lm9rKGxhbmdzLmxlbmd0aCA+IDAsIFwic2hvdWxkIGhhdmUgYXQgbGVhc3Qgb25lIGxhbmd1YWdlXCIpO1xuICB9KTtcblxuICB0ZXN0KFwiaW5jbHVkZXMgY29tbW9uIGxhbmd1YWdlc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgbGFuZ3MgPSBuYXRpdmUuZ2V0U3VwcG9ydGVkTGFuZ3VhZ2VzKCk7XG4gICAgLy8gVGhlc2UgYXJlIHN5bnRlY3QgZGVmYXVsdCBzeW50YXggbmFtZXNcbiAgICBhc3NlcnQub2sobGFuZ3MuaW5jbHVkZXMoXCJKYXZhU2NyaXB0XCIpLCBcInNob3VsZCBpbmNsdWRlIEphdmFTY3JpcHRcIik7XG4gICAgYXNzZXJ0Lm9rKGxhbmdzLmluY2x1ZGVzKFwiUHl0aG9uXCIpLCBcInNob3VsZCBpbmNsdWRlIFB5dGhvblwiKTtcbiAgICBhc3NlcnQub2sobGFuZ3MuaW5jbHVkZXMoXCJSdXN0XCIpLCBcInNob3VsZCBpbmNsdWRlIFJ1c3RcIik7XG4gICAgYXNzZXJ0Lm9rKGxhbmdzLmluY2x1ZGVzKFwiQ1wiKSwgXCJzaG91bGQgaW5jbHVkZSBDXCIpO1xuICB9KTtcblxuICB0ZXN0KFwicmV0dXJucyBzdHJpbmdzXCIsICgpID0+IHtcbiAgICBjb25zdCBsYW5ncyA9IG5hdGl2ZS5nZXRTdXBwb3J0ZWRMYW5ndWFnZXMoKTtcbiAgICBmb3IgKGNvbnN0IGxhbmcgb2YgbGFuZ3MpIHtcbiAgICAgIGFzc2VydC5lcXVhbCh0eXBlb2YgbGFuZywgXCJzdHJpbmdcIik7XG4gICAgfVxuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxNQUFNLGdCQUFnQjtBQUMvQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxxQkFBcUI7QUFDOUIsWUFBWSxVQUFVO0FBQ3RCLFNBQVMscUJBQXFCO0FBRTlCLE1BQU0sWUFBWSxLQUFLLFFBQVEsY0FBYyxZQUFZLEdBQUcsQ0FBQztBQUM3RCxNQUFNQSxXQUFVLGNBQWMsWUFBWSxHQUFHO0FBRzdDLE1BQU0sV0FBVyxLQUFLLFFBQVEsV0FBVyxNQUFNLE1BQU0sTUFBTSxNQUFNLFVBQVUsT0FBTztBQUNsRixNQUFNLGNBQWMsR0FBRyxRQUFRLFFBQVEsSUFBSSxRQUFRLElBQUk7QUFDdkQsTUFBTSxhQUFhO0FBQUEsRUFDakIsS0FBSyxLQUFLLFVBQVUsY0FBYyxXQUFXLE9BQU87QUFBQSxFQUNwRCxLQUFLLEtBQUssVUFBVSxxQkFBcUI7QUFDM0M7QUFFQSxJQUFJO0FBQ0osV0FBVyxhQUFhLFlBQVk7QUFDbEMsTUFBSTtBQUNGLGFBQVNBLFNBQVEsU0FBUztBQUMxQjtBQUFBLEVBQ0YsUUFBUTtBQUFBLEVBRVI7QUFDRjtBQUVBLElBQUksQ0FBQyxRQUFRO0FBQ1gsVUFBUSxNQUFNLDBFQUEwRTtBQUN4RixVQUFRLEtBQUssQ0FBQztBQUNoQjtBQUVBLE1BQU0sYUFBYTtBQUFBLEVBQ2pCLFNBQVM7QUFBQSxFQUNULFNBQVM7QUFBQSxFQUNULFVBQVU7QUFBQSxFQUNWLFVBQVU7QUFBQSxFQUNWLFFBQVE7QUFBQSxFQUNSLFFBQVE7QUFBQSxFQUNSLE1BQU07QUFBQSxFQUNOLFVBQVU7QUFBQSxFQUNWLGFBQWE7QUFDZjtBQUVBLFNBQVMscUNBQXFDLE1BQU07QUFDbEQsT0FBSywrQ0FBK0MsTUFBTTtBQUN4RCxVQUFNLE9BQU87QUFDYixVQUFNLFNBQVMsT0FBTyxjQUFjLE1BQU0sY0FBYyxVQUFVO0FBR2xFLFdBQU8sR0FBRyxPQUFPLFNBQVMsT0FBTyxHQUFHLGtDQUFrQztBQUV0RSxXQUFPLEdBQUcsT0FBTyxTQUFTLE9BQU8sR0FBRyx3QkFBd0I7QUFDNUQsV0FBTyxHQUFHLE9BQU8sU0FBUyxJQUFJLEdBQUcscUJBQXFCO0FBRXRELFdBQU8sR0FBRyxPQUFPLFNBQVMsVUFBVSxHQUFHLGlDQUFpQztBQUFBLEVBQzFFLENBQUM7QUFFRCxPQUFLLG1EQUFtRCxNQUFNO0FBQzVELFVBQU0sT0FBTztBQUNiLFVBQU0sU0FBUyxPQUFPLGNBQWMsTUFBTSx3QkFBd0IsVUFBVTtBQUc1RSxXQUFPLEdBQUcsT0FBTyxXQUFXLFFBQVE7QUFDcEMsV0FBTyxHQUFHLE9BQU8sU0FBUyxrQkFBa0IsQ0FBQztBQUFBLEVBQy9DLENBQUM7QUFFRCxPQUFLLG9DQUFvQyxNQUFNO0FBQzdDLFVBQU0sT0FBTztBQUNiLFVBQU0sU0FBUyxPQUFPLGNBQWMsTUFBTSxNQUFNLFVBQVU7QUFFMUQsV0FBTyxHQUFHLE9BQU8sV0FBVyxRQUFRO0FBQ3BDLFdBQU8sR0FBRyxPQUFPLFNBQVMsYUFBYSxDQUFDO0FBQUEsRUFDMUMsQ0FBQztBQUVELE9BQUssc0JBQXNCLE1BQU07QUFDL0IsVUFBTSxTQUFTLE9BQU8sY0FBYyxJQUFJLGNBQWMsVUFBVTtBQUNoRSxXQUFPLE1BQU0sUUFBUSxFQUFFO0FBQUEsRUFDekIsQ0FBQztBQUVELE9BQUssMEJBQTBCLE1BQU07QUFDbkMsVUFBTSxPQUFPO0FBQ2IsVUFBTSxTQUFTLE9BQU8sY0FBYyxNQUFNLGNBQWMsVUFBVTtBQUVsRSxXQUFPLEdBQUcsT0FBTyxTQUFTLFVBQVUsQ0FBQztBQUNyQyxXQUFPLEdBQUcsT0FBTyxTQUFTLEtBQUssQ0FBQztBQUNoQyxXQUFPLEdBQUcsT0FBTyxTQUFTLFFBQVEsQ0FBQztBQUNuQyxXQUFPLEdBQUcsT0FBTyxTQUFTLEtBQUssQ0FBQztBQUFBLEVBQ2xDLENBQUM7QUFFRCxPQUFLLDZDQUE2QyxNQUFNO0FBQ3RELFVBQU0saUJBQWlCO0FBQUEsTUFDckIsR0FBRztBQUFBLE1BQ0gsVUFBVTtBQUFBLE1BQ1YsU0FBUztBQUFBLElBQ1g7QUFDQSxVQUFNLE9BQU87QUFDYixVQUFNLFNBQVMsT0FBTyxjQUFjLE1BQU0sUUFBUSxjQUFjO0FBRWhFLFdBQU8sR0FBRyxPQUFPLFdBQVcsUUFBUTtBQUNwQyxXQUFPLEdBQUcsT0FBTyxTQUFTLENBQUM7QUFBQSxFQUM3QixDQUFDO0FBQ0gsQ0FBQztBQUVELFNBQVMsd0NBQXdDLE1BQU07QUFDckQsT0FBSyxrQ0FBa0MsTUFBTTtBQUMzQyxXQUFPLEdBQUcsT0FBTyxpQkFBaUIsWUFBWSxDQUFDO0FBQy9DLFdBQU8sR0FBRyxPQUFPLGlCQUFpQixZQUFZLENBQUM7QUFDL0MsV0FBTyxHQUFHLE9BQU8saUJBQWlCLFFBQVEsQ0FBQztBQUMzQyxXQUFPLEdBQUcsT0FBTyxpQkFBaUIsTUFBTSxDQUFDO0FBQ3pDLFdBQU8sR0FBRyxPQUFPLGlCQUFpQixJQUFJLENBQUM7QUFDdkMsV0FBTyxHQUFHLE9BQU8saUJBQWlCLE1BQU0sQ0FBQztBQUFBLEVBQzNDLENBQUM7QUFFRCxPQUFLLG1DQUFtQyxNQUFNO0FBQzVDLFdBQU8sR0FBRyxPQUFPLGlCQUFpQixZQUFZLENBQUM7QUFDL0MsV0FBTyxHQUFHLE9BQU8saUJBQWlCLFFBQVEsQ0FBQztBQUMzQyxXQUFPLEdBQUcsT0FBTyxpQkFBaUIsTUFBTSxDQUFDO0FBQUEsRUFDM0MsQ0FBQztBQUVELE9BQUssa0NBQWtDLE1BQU07QUFDM0MsV0FBTyxHQUFHLE9BQU8saUJBQWlCLElBQUksQ0FBQztBQUN2QyxXQUFPLEdBQUcsT0FBTyxpQkFBaUIsSUFBSSxDQUFDO0FBQ3ZDLFdBQU8sR0FBRyxPQUFPLGlCQUFpQixJQUFJLENBQUM7QUFDdkMsV0FBTyxHQUFHLE9BQU8saUJBQWlCLElBQUksQ0FBQztBQUN2QyxXQUFPLEdBQUcsT0FBTyxpQkFBaUIsSUFBSSxDQUFDO0FBQUEsRUFDekMsQ0FBQztBQUVELE9BQUssa0RBQWtELE1BQU07QUFDM0QsV0FBTyxNQUFNLE9BQU8saUJBQWlCLHNCQUFzQixHQUFHLEtBQUs7QUFBQSxFQUNyRSxDQUFDO0FBQ0gsQ0FBQztBQUVELFNBQVMsNkNBQTZDLE1BQU07QUFDMUQsT0FBSyxzQ0FBc0MsTUFBTTtBQUMvQyxVQUFNLFFBQVEsT0FBTyxzQkFBc0I7QUFDM0MsV0FBTyxHQUFHLE1BQU0sUUFBUSxLQUFLLENBQUM7QUFDOUIsV0FBTyxHQUFHLE1BQU0sU0FBUyxHQUFHLG1DQUFtQztBQUFBLEVBQ2pFLENBQUM7QUFFRCxPQUFLLDZCQUE2QixNQUFNO0FBQ3RDLFVBQU0sUUFBUSxPQUFPLHNCQUFzQjtBQUUzQyxXQUFPLEdBQUcsTUFBTSxTQUFTLFlBQVksR0FBRywyQkFBMkI7QUFDbkUsV0FBTyxHQUFHLE1BQU0sU0FBUyxRQUFRLEdBQUcsdUJBQXVCO0FBQzNELFdBQU8sR0FBRyxNQUFNLFNBQVMsTUFBTSxHQUFHLHFCQUFxQjtBQUN2RCxXQUFPLEdBQUcsTUFBTSxTQUFTLEdBQUcsR0FBRyxrQkFBa0I7QUFBQSxFQUNuRCxDQUFDO0FBRUQsT0FBSyxtQkFBbUIsTUFBTTtBQUM1QixVQUFNLFFBQVEsT0FBTyxzQkFBc0I7QUFDM0MsZUFBVyxRQUFRLE9BQU87QUFDeEIsYUFBTyxNQUFNLE9BQU8sTUFBTSxRQUFRO0FBQUEsSUFDcEM7QUFBQSxFQUNGLENBQUM7QUFDSCxDQUFDOyIsCiAgIm5hbWVzIjogWyJyZXF1aXJlIl0KfQo=
