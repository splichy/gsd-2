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
describe("native html: htmlToMarkdown()", () => {
  test("converts basic HTML to markdown", () => {
    const html = "<h1>Hello</h1><p>World</p>";
    const result = native.htmlToMarkdown(html);
    assert.ok(result.includes("Hello"), "Should contain heading text");
    assert.ok(result.includes("World"), "Should contain paragraph text");
  });
  test("converts links to markdown links", () => {
    const html = '<p>Visit <a href="https://example.com">Example</a></p>';
    const result = native.htmlToMarkdown(html);
    assert.ok(result.includes("[Example]"), "Should contain markdown link text");
    assert.ok(result.includes("(https://example.com)"), "Should contain markdown link URL");
  });
  test("converts lists to markdown", () => {
    const html = "<ul><li>First</li><li>Second</li><li>Third</li></ul>";
    const result = native.htmlToMarkdown(html);
    assert.ok(result.includes("First"), "Should contain first item");
    assert.ok(result.includes("Second"), "Should contain second item");
    assert.ok(result.includes("Third"), "Should contain third item");
  });
  test("converts bold and italic", () => {
    const html = "<p><strong>bold</strong> and <em>italic</em></p>";
    const result = native.htmlToMarkdown(html);
    assert.ok(result.includes("**bold**") || result.includes("__bold__"), "Should contain bold");
    assert.ok(result.includes("*italic*") || result.includes("_italic_"), "Should contain italic");
  });
  test("handles empty HTML", () => {
    const result = native.htmlToMarkdown("");
    assert.equal(typeof result, "string");
  });
  test("handles plain text", () => {
    const result = native.htmlToMarkdown("Just plain text");
    assert.ok(result.includes("Just plain text"), "Should preserve plain text");
  });
  test("accepts skipImages option", () => {
    const html = '<h1>Title</h1><p>Content with <img src="photo.jpg" alt="photo"> image</p>';
    const result = native.htmlToMarkdown(html, { skipImages: true });
    assert.ok(result.includes("Title"), "Should contain heading");
    assert.ok(result.includes("Content"), "Should contain paragraph text");
  });
  test("accepts cleanContent option", () => {
    const html = '<nav><a href="/home">Home</a></nav><main><h1>Article</h1><p>Body text.</p></main><footer>Copyright</footer>';
    const result = native.htmlToMarkdown(html, { cleanContent: true });
    assert.ok(result.includes("Article") || result.includes("Body text"), "Should contain main content");
  });
  test("converts code blocks", () => {
    const html = "<pre><code>const x = 1;</code></pre>";
    const result = native.htmlToMarkdown(html);
    assert.ok(result.includes("const x = 1;"), "Should contain code content");
  });
  test("converts complex nested HTML", () => {
    const html = '<div><h2>Section</h2><p>Text with <a href="https://example.com"><strong>bold link</strong></a>.</p><ul><li>Item one</li><li>Item two</li></ul></div>';
    const result = native.htmlToMarkdown(html);
    assert.ok(result.includes("Section"), "Should contain heading");
    assert.ok(result.includes("example.com"), "Should contain link");
    assert.ok(result.includes("one"), "Should contain list items");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvbmF0aXZlL3NyYy9fX3Rlc3RzX18vaHRtbC50ZXN0Lm1qcyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgdGVzdCwgZGVzY3JpYmUgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IGNyZWF0ZVJlcXVpcmUgfSBmcm9tIFwibm9kZTptb2R1bGVcIjtcbmltcG9ydCAqIGFzIHBhdGggZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gXCJub2RlOnVybFwiO1xuXG5jb25zdCBfX2Rpcm5hbWUgPSBwYXRoLmRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKTtcbmNvbnN0IHJlcXVpcmUgPSBjcmVhdGVSZXF1aXJlKGltcG9ydC5tZXRhLnVybCk7XG5cbmNvbnN0IGFkZG9uRGlyID0gcGF0aC5yZXNvbHZlKF9fZGlybmFtZSwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIm5hdGl2ZVwiLCBcImFkZG9uXCIpO1xuY29uc3QgcGxhdGZvcm1UYWcgPSBgJHtwcm9jZXNzLnBsYXRmb3JtfS0ke3Byb2Nlc3MuYXJjaH1gO1xuY29uc3QgY2FuZGlkYXRlcyA9IFtcbiAgcGF0aC5qb2luKGFkZG9uRGlyLCBgZ3NkX2VuZ2luZS4ke3BsYXRmb3JtVGFnfS5ub2RlYCksXG4gIHBhdGguam9pbihhZGRvbkRpciwgXCJnc2RfZW5naW5lLmRldi5ub2RlXCIpLFxuXTtcblxubGV0IG5hdGl2ZTtcbmZvciAoY29uc3QgY2FuZGlkYXRlIG9mIGNhbmRpZGF0ZXMpIHtcbiAgdHJ5IHtcbiAgICBuYXRpdmUgPSByZXF1aXJlKGNhbmRpZGF0ZSk7XG4gICAgYnJlYWs7XG4gIH0gY2F0Y2gge1xuICAgIC8vIHRyeSBuZXh0XG4gIH1cbn1cblxuaWYgKCFuYXRpdmUpIHtcbiAgY29uc29sZS5lcnJvcihcIk5hdGl2ZSBhZGRvbiBub3QgZm91bmQuIFJ1biBgbnBtIHJ1biBidWlsZDpuYXRpdmUgLXcgQGdzZC9uYXRpdmVgIGZpcnN0LlwiKTtcbiAgcHJvY2Vzcy5leGl0KDEpO1xufVxuXG5kZXNjcmliZShcIm5hdGl2ZSBodG1sOiBodG1sVG9NYXJrZG93bigpXCIsICgpID0+IHtcbiAgdGVzdChcImNvbnZlcnRzIGJhc2ljIEhUTUwgdG8gbWFya2Rvd25cIiwgKCkgPT4ge1xuICAgIGNvbnN0IGh0bWwgPSBcIjxoMT5IZWxsbzwvaDE+PHA+V29ybGQ8L3A+XCI7XG4gICAgY29uc3QgcmVzdWx0ID0gbmF0aXZlLmh0bWxUb01hcmtkb3duKGh0bWwpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoXCJIZWxsb1wiKSwgXCJTaG91bGQgY29udGFpbiBoZWFkaW5nIHRleHRcIik7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcyhcIldvcmxkXCIpLCBcIlNob3VsZCBjb250YWluIHBhcmFncmFwaCB0ZXh0XCIpO1xuICB9KTtcblxuICB0ZXN0KFwiY29udmVydHMgbGlua3MgdG8gbWFya2Rvd24gbGlua3NcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGh0bWwgPSAnPHA+VmlzaXQgPGEgaHJlZj1cImh0dHBzOi8vZXhhbXBsZS5jb21cIj5FeGFtcGxlPC9hPjwvcD4nO1xuICAgIGNvbnN0IHJlc3VsdCA9IG5hdGl2ZS5odG1sVG9NYXJrZG93bihodG1sKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmluY2x1ZGVzKFwiW0V4YW1wbGVdXCIpLCBcIlNob3VsZCBjb250YWluIG1hcmtkb3duIGxpbmsgdGV4dFwiKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmluY2x1ZGVzKFwiKGh0dHBzOi8vZXhhbXBsZS5jb20pXCIpLCBcIlNob3VsZCBjb250YWluIG1hcmtkb3duIGxpbmsgVVJMXCIpO1xuICB9KTtcblxuICB0ZXN0KFwiY29udmVydHMgbGlzdHMgdG8gbWFya2Rvd25cIiwgKCkgPT4ge1xuICAgIGNvbnN0IGh0bWwgPSBcIjx1bD48bGk+Rmlyc3Q8L2xpPjxsaT5TZWNvbmQ8L2xpPjxsaT5UaGlyZDwvbGk+PC91bD5cIjtcbiAgICBjb25zdCByZXN1bHQgPSBuYXRpdmUuaHRtbFRvTWFya2Rvd24oaHRtbCk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcyhcIkZpcnN0XCIpLCBcIlNob3VsZCBjb250YWluIGZpcnN0IGl0ZW1cIik7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcyhcIlNlY29uZFwiKSwgXCJTaG91bGQgY29udGFpbiBzZWNvbmQgaXRlbVwiKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmluY2x1ZGVzKFwiVGhpcmRcIiksIFwiU2hvdWxkIGNvbnRhaW4gdGhpcmQgaXRlbVwiKTtcbiAgfSk7XG5cbiAgdGVzdChcImNvbnZlcnRzIGJvbGQgYW5kIGl0YWxpY1wiLCAoKSA9PiB7XG4gICAgY29uc3QgaHRtbCA9IFwiPHA+PHN0cm9uZz5ib2xkPC9zdHJvbmc+IGFuZCA8ZW0+aXRhbGljPC9lbT48L3A+XCI7XG4gICAgY29uc3QgcmVzdWx0ID0gbmF0aXZlLmh0bWxUb01hcmtkb3duKGh0bWwpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoXCIqKmJvbGQqKlwiKSB8fCByZXN1bHQuaW5jbHVkZXMoXCJfX2JvbGRfX1wiKSwgXCJTaG91bGQgY29udGFpbiBib2xkXCIpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoXCIqaXRhbGljKlwiKSB8fCByZXN1bHQuaW5jbHVkZXMoXCJfaXRhbGljX1wiKSwgXCJTaG91bGQgY29udGFpbiBpdGFsaWNcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJoYW5kbGVzIGVtcHR5IEhUTUxcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IG5hdGl2ZS5odG1sVG9NYXJrZG93bihcIlwiKTtcbiAgICBhc3NlcnQuZXF1YWwodHlwZW9mIHJlc3VsdCwgXCJzdHJpbmdcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJoYW5kbGVzIHBsYWluIHRleHRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IG5hdGl2ZS5odG1sVG9NYXJrZG93bihcIkp1c3QgcGxhaW4gdGV4dFwiKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmluY2x1ZGVzKFwiSnVzdCBwbGFpbiB0ZXh0XCIpLCBcIlNob3VsZCBwcmVzZXJ2ZSBwbGFpbiB0ZXh0XCIpO1xuICB9KTtcblxuICB0ZXN0KFwiYWNjZXB0cyBza2lwSW1hZ2VzIG9wdGlvblwiLCAoKSA9PiB7XG4gICAgY29uc3QgaHRtbCA9ICc8aDE+VGl0bGU8L2gxPjxwPkNvbnRlbnQgd2l0aCA8aW1nIHNyYz1cInBob3RvLmpwZ1wiIGFsdD1cInBob3RvXCI+IGltYWdlPC9wPic7XG4gICAgY29uc3QgcmVzdWx0ID0gbmF0aXZlLmh0bWxUb01hcmtkb3duKGh0bWwsIHsgc2tpcEltYWdlczogdHJ1ZSB9KTtcbiAgICBhc3NlcnQub2socmVzdWx0LmluY2x1ZGVzKFwiVGl0bGVcIiksIFwiU2hvdWxkIGNvbnRhaW4gaGVhZGluZ1wiKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmluY2x1ZGVzKFwiQ29udGVudFwiKSwgXCJTaG91bGQgY29udGFpbiBwYXJhZ3JhcGggdGV4dFwiKTtcbiAgfSk7XG5cbiAgdGVzdChcImFjY2VwdHMgY2xlYW5Db250ZW50IG9wdGlvblwiLCAoKSA9PiB7XG4gICAgY29uc3QgaHRtbCA9ICc8bmF2PjxhIGhyZWY9XCIvaG9tZVwiPkhvbWU8L2E+PC9uYXY+PG1haW4+PGgxPkFydGljbGU8L2gxPjxwPkJvZHkgdGV4dC48L3A+PC9tYWluPjxmb290ZXI+Q29weXJpZ2h0PC9mb290ZXI+JztcbiAgICBjb25zdCByZXN1bHQgPSBuYXRpdmUuaHRtbFRvTWFya2Rvd24oaHRtbCwgeyBjbGVhbkNvbnRlbnQ6IHRydWUgfSk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcyhcIkFydGljbGVcIikgfHwgcmVzdWx0LmluY2x1ZGVzKFwiQm9keSB0ZXh0XCIpLCBcIlNob3VsZCBjb250YWluIG1haW4gY29udGVudFwiKTtcbiAgfSk7XG5cbiAgdGVzdChcImNvbnZlcnRzIGNvZGUgYmxvY2tzXCIsICgpID0+IHtcbiAgICBjb25zdCBodG1sID0gXCI8cHJlPjxjb2RlPmNvbnN0IHggPSAxOzwvY29kZT48L3ByZT5cIjtcbiAgICBjb25zdCByZXN1bHQgPSBuYXRpdmUuaHRtbFRvTWFya2Rvd24oaHRtbCk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcyhcImNvbnN0IHggPSAxO1wiKSwgXCJTaG91bGQgY29udGFpbiBjb2RlIGNvbnRlbnRcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJjb252ZXJ0cyBjb21wbGV4IG5lc3RlZCBIVE1MXCIsICgpID0+IHtcbiAgICBjb25zdCBodG1sID0gJzxkaXY+PGgyPlNlY3Rpb248L2gyPjxwPlRleHQgd2l0aCA8YSBocmVmPVwiaHR0cHM6Ly9leGFtcGxlLmNvbVwiPjxzdHJvbmc+Ym9sZCBsaW5rPC9zdHJvbmc+PC9hPi48L3A+PHVsPjxsaT5JdGVtIG9uZTwvbGk+PGxpPkl0ZW0gdHdvPC9saT48L3VsPjwvZGl2Pic7XG4gICAgY29uc3QgcmVzdWx0ID0gbmF0aXZlLmh0bWxUb01hcmtkb3duKGh0bWwpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoXCJTZWN0aW9uXCIpLCBcIlNob3VsZCBjb250YWluIGhlYWRpbmdcIik7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcyhcImV4YW1wbGUuY29tXCIpLCBcIlNob3VsZCBjb250YWluIGxpbmtcIik7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcyhcIm9uZVwiKSwgXCJTaG91bGQgY29udGFpbiBsaXN0IGl0ZW1zXCIpO1xuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxNQUFNLGdCQUFnQjtBQUMvQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxxQkFBcUI7QUFDOUIsWUFBWSxVQUFVO0FBQ3RCLFNBQVMscUJBQXFCO0FBRTlCLE1BQU0sWUFBWSxLQUFLLFFBQVEsY0FBYyxZQUFZLEdBQUcsQ0FBQztBQUM3RCxNQUFNQSxXQUFVLGNBQWMsWUFBWSxHQUFHO0FBRTdDLE1BQU0sV0FBVyxLQUFLLFFBQVEsV0FBVyxNQUFNLE1BQU0sTUFBTSxNQUFNLFVBQVUsT0FBTztBQUNsRixNQUFNLGNBQWMsR0FBRyxRQUFRLFFBQVEsSUFBSSxRQUFRLElBQUk7QUFDdkQsTUFBTSxhQUFhO0FBQUEsRUFDakIsS0FBSyxLQUFLLFVBQVUsY0FBYyxXQUFXLE9BQU87QUFBQSxFQUNwRCxLQUFLLEtBQUssVUFBVSxxQkFBcUI7QUFDM0M7QUFFQSxJQUFJO0FBQ0osV0FBVyxhQUFhLFlBQVk7QUFDbEMsTUFBSTtBQUNGLGFBQVNBLFNBQVEsU0FBUztBQUMxQjtBQUFBLEVBQ0YsUUFBUTtBQUFBLEVBRVI7QUFDRjtBQUVBLElBQUksQ0FBQyxRQUFRO0FBQ1gsVUFBUSxNQUFNLDBFQUEwRTtBQUN4RixVQUFRLEtBQUssQ0FBQztBQUNoQjtBQUVBLFNBQVMsaUNBQWlDLE1BQU07QUFDOUMsT0FBSyxtQ0FBbUMsTUFBTTtBQUM1QyxVQUFNLE9BQU87QUFDYixVQUFNLFNBQVMsT0FBTyxlQUFlLElBQUk7QUFDekMsV0FBTyxHQUFHLE9BQU8sU0FBUyxPQUFPLEdBQUcsNkJBQTZCO0FBQ2pFLFdBQU8sR0FBRyxPQUFPLFNBQVMsT0FBTyxHQUFHLCtCQUErQjtBQUFBLEVBQ3JFLENBQUM7QUFFRCxPQUFLLG9DQUFvQyxNQUFNO0FBQzdDLFVBQU0sT0FBTztBQUNiLFVBQU0sU0FBUyxPQUFPLGVBQWUsSUFBSTtBQUN6QyxXQUFPLEdBQUcsT0FBTyxTQUFTLFdBQVcsR0FBRyxtQ0FBbUM7QUFDM0UsV0FBTyxHQUFHLE9BQU8sU0FBUyx1QkFBdUIsR0FBRyxrQ0FBa0M7QUFBQSxFQUN4RixDQUFDO0FBRUQsT0FBSyw4QkFBOEIsTUFBTTtBQUN2QyxVQUFNLE9BQU87QUFDYixVQUFNLFNBQVMsT0FBTyxlQUFlLElBQUk7QUFDekMsV0FBTyxHQUFHLE9BQU8sU0FBUyxPQUFPLEdBQUcsMkJBQTJCO0FBQy9ELFdBQU8sR0FBRyxPQUFPLFNBQVMsUUFBUSxHQUFHLDRCQUE0QjtBQUNqRSxXQUFPLEdBQUcsT0FBTyxTQUFTLE9BQU8sR0FBRywyQkFBMkI7QUFBQSxFQUNqRSxDQUFDO0FBRUQsT0FBSyw0QkFBNEIsTUFBTTtBQUNyQyxVQUFNLE9BQU87QUFDYixVQUFNLFNBQVMsT0FBTyxlQUFlLElBQUk7QUFDekMsV0FBTyxHQUFHLE9BQU8sU0FBUyxVQUFVLEtBQUssT0FBTyxTQUFTLFVBQVUsR0FBRyxxQkFBcUI7QUFDM0YsV0FBTyxHQUFHLE9BQU8sU0FBUyxVQUFVLEtBQUssT0FBTyxTQUFTLFVBQVUsR0FBRyx1QkFBdUI7QUFBQSxFQUMvRixDQUFDO0FBRUQsT0FBSyxzQkFBc0IsTUFBTTtBQUMvQixVQUFNLFNBQVMsT0FBTyxlQUFlLEVBQUU7QUFDdkMsV0FBTyxNQUFNLE9BQU8sUUFBUSxRQUFRO0FBQUEsRUFDdEMsQ0FBQztBQUVELE9BQUssc0JBQXNCLE1BQU07QUFDL0IsVUFBTSxTQUFTLE9BQU8sZUFBZSxpQkFBaUI7QUFDdEQsV0FBTyxHQUFHLE9BQU8sU0FBUyxpQkFBaUIsR0FBRyw0QkFBNEI7QUFBQSxFQUM1RSxDQUFDO0FBRUQsT0FBSyw2QkFBNkIsTUFBTTtBQUN0QyxVQUFNLE9BQU87QUFDYixVQUFNLFNBQVMsT0FBTyxlQUFlLE1BQU0sRUFBRSxZQUFZLEtBQUssQ0FBQztBQUMvRCxXQUFPLEdBQUcsT0FBTyxTQUFTLE9BQU8sR0FBRyx3QkFBd0I7QUFDNUQsV0FBTyxHQUFHLE9BQU8sU0FBUyxTQUFTLEdBQUcsK0JBQStCO0FBQUEsRUFDdkUsQ0FBQztBQUVELE9BQUssK0JBQStCLE1BQU07QUFDeEMsVUFBTSxPQUFPO0FBQ2IsVUFBTSxTQUFTLE9BQU8sZUFBZSxNQUFNLEVBQUUsY0FBYyxLQUFLLENBQUM7QUFDakUsV0FBTyxHQUFHLE9BQU8sU0FBUyxTQUFTLEtBQUssT0FBTyxTQUFTLFdBQVcsR0FBRyw2QkFBNkI7QUFBQSxFQUNyRyxDQUFDO0FBRUQsT0FBSyx3QkFBd0IsTUFBTTtBQUNqQyxVQUFNLE9BQU87QUFDYixVQUFNLFNBQVMsT0FBTyxlQUFlLElBQUk7QUFDekMsV0FBTyxHQUFHLE9BQU8sU0FBUyxjQUFjLEdBQUcsNkJBQTZCO0FBQUEsRUFDMUUsQ0FBQztBQUVELE9BQUssZ0NBQWdDLE1BQU07QUFDekMsVUFBTSxPQUFPO0FBQ2IsVUFBTSxTQUFTLE9BQU8sZUFBZSxJQUFJO0FBQ3pDLFdBQU8sR0FBRyxPQUFPLFNBQVMsU0FBUyxHQUFHLHdCQUF3QjtBQUM5RCxXQUFPLEdBQUcsT0FBTyxTQUFTLGFBQWEsR0FBRyxxQkFBcUI7QUFDL0QsV0FBTyxHQUFHLE9BQU8sU0FBUyxLQUFLLEdBQUcsMkJBQTJCO0FBQUEsRUFDL0QsQ0FBQztBQUNILENBQUM7IiwKICAibmFtZXMiOiBbInJlcXVpcmUiXQp9Cg==
