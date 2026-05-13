import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
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
describe("native grep: search()", () => {
  test("finds matches in buffer content", () => {
    const content = Buffer.from("hello world\nfoo bar\nhello rust\n");
    const result = native.search(content, { pattern: "hello" });
    assert.equal(result.matchCount, 2);
    assert.equal(result.matches.length, 2);
    assert.equal(result.matches[0].line, "hello world");
    assert.equal(result.matches[0].lineNumber, 1);
    assert.equal(result.matches[1].line, "hello rust");
    assert.equal(result.matches[1].lineNumber, 3);
    assert.equal(result.limitReached, false);
  });
  test("supports case-insensitive search", () => {
    const content = Buffer.from("Hello World\nhello world\nHELLO\n");
    const result = native.search(content, {
      pattern: "hello",
      ignoreCase: true
    });
    assert.equal(result.matchCount, 3);
  });
  test("respects maxCount limit", () => {
    const content = Buffer.from("aaa\naaa\naaa\naaa\n");
    const result = native.search(content, {
      pattern: "aaa",
      maxCount: 2
    });
    assert.equal(result.matches.length, 2);
    assert.equal(result.limitReached, true);
  });
  test("returns context lines", () => {
    const content = Buffer.from("line1\nline2\nmatch_here\nline4\nline5\n");
    const result = native.search(content, {
      pattern: "match_here",
      contextBefore: 1,
      contextAfter: 1
    });
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].contextBefore.length, 1);
    assert.equal(result.matches[0].contextBefore[0].line, "line2");
    assert.equal(result.matches[0].contextAfter.length, 1);
    assert.equal(result.matches[0].contextAfter[0].line, "line4");
  });
  test("throws on invalid regex", () => {
    const content = Buffer.from("hello");
    assert.throws(() => {
      native.search(content, { pattern: "[invalid" });
    });
  });
});
describe("native grep: grep()", () => {
  let tmpDir;
  test("returns a promise", async (t) => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-grep-test-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(tmpDir, "file1.txt"), "hello world\n");
    const pending = native.grep({
      pattern: "hello",
      path: tmpDir
    });
    assert.equal(typeof pending?.then, "function");
    const result = await pending;
    assert.equal(result.totalMatches, 1);
  });
  test("searches files on disk", async (t) => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-grep-test-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(tmpDir, "file1.txt"), "hello world\nfoo bar\n");
    fs.writeFileSync(path.join(tmpDir, "file2.txt"), "hello rust\nbaz qux\n");
    fs.writeFileSync(path.join(tmpDir, "file3.log"), "no match here\n");
    const result = await native.grep({
      pattern: "hello",
      path: tmpDir
    });
    assert.equal(result.totalMatches, 2);
    assert.equal(result.filesWithMatches, 2);
    assert.equal(result.matches.length, 2);
    const paths = result.matches.map((m) => m.path);
    assert.deepEqual(paths, [...paths].sort());
  });
  test("respects glob filter", async (t) => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-grep-test-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(tmpDir, "code.ts"), "hello typescript\n");
    fs.writeFileSync(path.join(tmpDir, "code.js"), "hello javascript\n");
    fs.writeFileSync(path.join(tmpDir, "readme.md"), "hello markdown\n");
    const result = await native.grep({
      pattern: "hello",
      path: tmpDir,
      glob: "*.ts"
    });
    assert.equal(result.totalMatches, 1);
    assert.equal(result.matches[0].line, "hello typescript");
  });
  test("respects maxCount", async (t) => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-grep-test-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(tmpDir, `file${i}.txt`), "match_me\n");
    }
    const result = await native.grep({
      pattern: "match_me",
      path: tmpDir,
      maxCount: 3
    });
    assert.ok(result.matches.length <= 3);
    assert.equal(result.limitReached, true);
  });
  test("errors on non-existent path", async () => {
    await assert.rejects(() => {
      return native.grep({
        pattern: "test",
        path: "/nonexistent/path/that/does/not/exist"
      });
    });
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvbmF0aXZlL3NyYy9fX3Rlc3RzX18vZ3JlcC50ZXN0Lm1qcyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgdGVzdCwgZGVzY3JpYmUgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IGNyZWF0ZVJlcXVpcmUgfSBmcm9tIFwibm9kZTptb2R1bGVcIjtcbmltcG9ydCAqIGFzIHBhdGggZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gXCJub2RlOnVybFwiO1xuaW1wb3J0ICogYXMgZnMgZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCAqIGFzIG9zIGZyb20gXCJub2RlOm9zXCI7XG5cbmNvbnN0IF9fZGlybmFtZSA9IHBhdGguZGlybmFtZShmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuY29uc3QgcmVxdWlyZSA9IGNyZWF0ZVJlcXVpcmUoaW1wb3J0Lm1ldGEudXJsKTtcblxuLy8gTG9hZCB0aGUgbmF0aXZlIGFkZG9uIGRpcmVjdGx5XG5jb25zdCBhZGRvbkRpciA9IHBhdGgucmVzb2x2ZShfX2Rpcm5hbWUsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCJuYXRpdmVcIiwgXCJhZGRvblwiKTtcbmNvbnN0IHBsYXRmb3JtVGFnID0gYCR7cHJvY2Vzcy5wbGF0Zm9ybX0tJHtwcm9jZXNzLmFyY2h9YDtcbmNvbnN0IGNhbmRpZGF0ZXMgPSBbXG4gIHBhdGguam9pbihhZGRvbkRpciwgYGdzZF9lbmdpbmUuJHtwbGF0Zm9ybVRhZ30ubm9kZWApLFxuICBwYXRoLmpvaW4oYWRkb25EaXIsIFwiZ3NkX2VuZ2luZS5kZXYubm9kZVwiKSxcbl07XG5cbmxldCBuYXRpdmU7XG5mb3IgKGNvbnN0IGNhbmRpZGF0ZSBvZiBjYW5kaWRhdGVzKSB7XG4gIHRyeSB7XG4gICAgbmF0aXZlID0gcmVxdWlyZShjYW5kaWRhdGUpO1xuICAgIGJyZWFrO1xuICB9IGNhdGNoIHtcbiAgICAvLyB0cnkgbmV4dFxuICB9XG59XG5cbmlmICghbmF0aXZlKSB7XG4gIGNvbnNvbGUuZXJyb3IoXCJOYXRpdmUgYWRkb24gbm90IGZvdW5kLiBSdW4gYG5wbSBydW4gYnVpbGQ6bmF0aXZlIC13IEBnc2QvbmF0aXZlYCBmaXJzdC5cIik7XG4gIHByb2Nlc3MuZXhpdCgxKTtcbn1cblxuZGVzY3JpYmUoXCJuYXRpdmUgZ3JlcDogc2VhcmNoKClcIiwgKCkgPT4ge1xuICB0ZXN0KFwiZmluZHMgbWF0Y2hlcyBpbiBidWZmZXIgY29udGVudFwiLCAoKSA9PiB7XG4gICAgY29uc3QgY29udGVudCA9IEJ1ZmZlci5mcm9tKFwiaGVsbG8gd29ybGRcXG5mb28gYmFyXFxuaGVsbG8gcnVzdFxcblwiKTtcbiAgICBjb25zdCByZXN1bHQgPSBuYXRpdmUuc2VhcmNoKGNvbnRlbnQsIHsgcGF0dGVybjogXCJoZWxsb1wiIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5tYXRjaENvdW50LCAyKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm1hdGNoZXMubGVuZ3RoLCAyKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm1hdGNoZXNbMF0ubGluZSwgXCJoZWxsbyB3b3JsZFwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm1hdGNoZXNbMF0ubGluZU51bWJlciwgMSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5tYXRjaGVzWzFdLmxpbmUsIFwiaGVsbG8gcnVzdFwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm1hdGNoZXNbMV0ubGluZU51bWJlciwgMyk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5saW1pdFJlYWNoZWQsIGZhbHNlKTtcbiAgfSk7XG5cbiAgdGVzdChcInN1cHBvcnRzIGNhc2UtaW5zZW5zaXRpdmUgc2VhcmNoXCIsICgpID0+IHtcbiAgICBjb25zdCBjb250ZW50ID0gQnVmZmVyLmZyb20oXCJIZWxsbyBXb3JsZFxcbmhlbGxvIHdvcmxkXFxuSEVMTE9cXG5cIik7XG4gICAgY29uc3QgcmVzdWx0ID0gbmF0aXZlLnNlYXJjaChjb250ZW50LCB7XG4gICAgICBwYXR0ZXJuOiBcImhlbGxvXCIsXG4gICAgICBpZ25vcmVDYXNlOiB0cnVlLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5tYXRjaENvdW50LCAzKTtcbiAgfSk7XG5cbiAgdGVzdChcInJlc3BlY3RzIG1heENvdW50IGxpbWl0XCIsICgpID0+IHtcbiAgICBjb25zdCBjb250ZW50ID0gQnVmZmVyLmZyb20oXCJhYWFcXG5hYWFcXG5hYWFcXG5hYWFcXG5cIik7XG4gICAgY29uc3QgcmVzdWx0ID0gbmF0aXZlLnNlYXJjaChjb250ZW50LCB7XG4gICAgICBwYXR0ZXJuOiBcImFhYVwiLFxuICAgICAgbWF4Q291bnQ6IDIsXG4gICAgfSk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm1hdGNoZXMubGVuZ3RoLCAyKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmxpbWl0UmVhY2hlZCwgdHJ1ZSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJyZXR1cm5zIGNvbnRleHQgbGluZXNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGNvbnRlbnQgPSBCdWZmZXIuZnJvbShcImxpbmUxXFxubGluZTJcXG5tYXRjaF9oZXJlXFxubGluZTRcXG5saW5lNVxcblwiKTtcbiAgICBjb25zdCByZXN1bHQgPSBuYXRpdmUuc2VhcmNoKGNvbnRlbnQsIHtcbiAgICAgIHBhdHRlcm46IFwibWF0Y2hfaGVyZVwiLFxuICAgICAgY29udGV4dEJlZm9yZTogMSxcbiAgICAgIGNvbnRleHRBZnRlcjogMSxcbiAgICB9KTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQubWF0Y2hlcy5sZW5ndGgsIDEpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQubWF0Y2hlc1swXS5jb250ZXh0QmVmb3JlLmxlbmd0aCwgMSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5tYXRjaGVzWzBdLmNvbnRleHRCZWZvcmVbMF0ubGluZSwgXCJsaW5lMlwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm1hdGNoZXNbMF0uY29udGV4dEFmdGVyLmxlbmd0aCwgMSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5tYXRjaGVzWzBdLmNvbnRleHRBZnRlclswXS5saW5lLCBcImxpbmU0XCIpO1xuICB9KTtcblxuICB0ZXN0KFwidGhyb3dzIG9uIGludmFsaWQgcmVnZXhcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGNvbnRlbnQgPSBCdWZmZXIuZnJvbShcImhlbGxvXCIpO1xuICAgIGFzc2VydC50aHJvd3MoKCkgPT4ge1xuICAgICAgbmF0aXZlLnNlYXJjaChjb250ZW50LCB7IHBhdHRlcm46IFwiW2ludmFsaWRcIiB9KTtcbiAgICB9KTtcbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoXCJuYXRpdmUgZ3JlcDogZ3JlcCgpXCIsICgpID0+IHtcbiAgbGV0IHRtcERpcjtcblxuICB0ZXN0KFwicmV0dXJucyBhIHByb21pc2VcIiwgYXN5bmMgKHQpID0+IHtcbiAgICB0bXBEaXIgPSBmcy5ta2R0ZW1wU3luYyhwYXRoLmpvaW4ob3MudG1wZGlyKCksIFwiZ3NkLWdyZXAtdGVzdC1cIikpO1xuICAgIHQuYWZ0ZXIoKCkgPT4gZnMucm1TeW5jKHRtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcblxuICAgIGZzLndyaXRlRmlsZVN5bmMocGF0aC5qb2luKHRtcERpciwgXCJmaWxlMS50eHRcIiksIFwiaGVsbG8gd29ybGRcXG5cIik7XG5cbiAgICBjb25zdCBwZW5kaW5nID0gbmF0aXZlLmdyZXAoe1xuICAgICAgcGF0dGVybjogXCJoZWxsb1wiLFxuICAgICAgcGF0aDogdG1wRGlyLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHR5cGVvZiBwZW5kaW5nPy50aGVuLCBcImZ1bmN0aW9uXCIpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcGVuZGluZztcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnRvdGFsTWF0Y2hlcywgMSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJzZWFyY2hlcyBmaWxlcyBvbiBkaXNrXCIsIGFzeW5jICh0KSA9PiB7XG4gICAgdG1wRGlyID0gZnMubWtkdGVtcFN5bmMocGF0aC5qb2luKG9zLnRtcGRpcigpLCBcImdzZC1ncmVwLXRlc3QtXCIpKTtcbiAgICB0LmFmdGVyKCgpID0+IGZzLnJtU3luYyh0bXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSk7XG5cbiAgICBmcy53cml0ZUZpbGVTeW5jKHBhdGguam9pbih0bXBEaXIsIFwiZmlsZTEudHh0XCIpLCBcImhlbGxvIHdvcmxkXFxuZm9vIGJhclxcblwiKTtcbiAgICBmcy53cml0ZUZpbGVTeW5jKHBhdGguam9pbih0bXBEaXIsIFwiZmlsZTIudHh0XCIpLCBcImhlbGxvIHJ1c3RcXG5iYXogcXV4XFxuXCIpO1xuICAgIGZzLndyaXRlRmlsZVN5bmMocGF0aC5qb2luKHRtcERpciwgXCJmaWxlMy5sb2dcIiksIFwibm8gbWF0Y2ggaGVyZVxcblwiKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IG5hdGl2ZS5ncmVwKHtcbiAgICAgIHBhdHRlcm46IFwiaGVsbG9cIixcbiAgICAgIHBhdGg6IHRtcERpcixcbiAgICB9KTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQudG90YWxNYXRjaGVzLCAyKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmZpbGVzV2l0aE1hdGNoZXMsIDIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQubWF0Y2hlcy5sZW5ndGgsIDIpO1xuXG4gICAgLy8gTWF0Y2hlcyBzaG91bGQgYmUgc29ydGVkIGJ5IGZpbGUgcGF0aFxuICAgIGNvbnN0IHBhdGhzID0gcmVzdWx0Lm1hdGNoZXMubWFwKChtKSA9PiBtLnBhdGgpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwocGF0aHMsIFsuLi5wYXRoc10uc29ydCgpKTtcbiAgfSk7XG5cbiAgdGVzdChcInJlc3BlY3RzIGdsb2IgZmlsdGVyXCIsIGFzeW5jICh0KSA9PiB7XG4gICAgdG1wRGlyID0gZnMubWtkdGVtcFN5bmMocGF0aC5qb2luKG9zLnRtcGRpcigpLCBcImdzZC1ncmVwLXRlc3QtXCIpKTtcbiAgICB0LmFmdGVyKCgpID0+IGZzLnJtU3luYyh0bXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSk7XG5cbiAgICBmcy53cml0ZUZpbGVTeW5jKHBhdGguam9pbih0bXBEaXIsIFwiY29kZS50c1wiKSwgXCJoZWxsbyB0eXBlc2NyaXB0XFxuXCIpO1xuICAgIGZzLndyaXRlRmlsZVN5bmMocGF0aC5qb2luKHRtcERpciwgXCJjb2RlLmpzXCIpLCBcImhlbGxvIGphdmFzY3JpcHRcXG5cIik7XG4gICAgZnMud3JpdGVGaWxlU3luYyhwYXRoLmpvaW4odG1wRGlyLCBcInJlYWRtZS5tZFwiKSwgXCJoZWxsbyBtYXJrZG93blxcblwiKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IG5hdGl2ZS5ncmVwKHtcbiAgICAgIHBhdHRlcm46IFwiaGVsbG9cIixcbiAgICAgIHBhdGg6IHRtcERpcixcbiAgICAgIGdsb2I6IFwiKi50c1wiLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC50b3RhbE1hdGNoZXMsIDEpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQubWF0Y2hlc1swXS5saW5lLCBcImhlbGxvIHR5cGVzY3JpcHRcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJyZXNwZWN0cyBtYXhDb3VudFwiLCBhc3luYyAodCkgPT4ge1xuICAgIHRtcERpciA9IGZzLm1rZHRlbXBTeW5jKHBhdGguam9pbihvcy50bXBkaXIoKSwgXCJnc2QtZ3JlcC10ZXN0LVwiKSk7XG4gICAgdC5hZnRlcigoKSA9PiBmcy5ybVN5bmModG1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpO1xuXG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCAxMDsgaSsrKSB7XG4gICAgICBmcy53cml0ZUZpbGVTeW5jKHBhdGguam9pbih0bXBEaXIsIGBmaWxlJHtpfS50eHRgKSwgXCJtYXRjaF9tZVxcblwiKTtcbiAgICB9XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBuYXRpdmUuZ3JlcCh7XG4gICAgICBwYXR0ZXJuOiBcIm1hdGNoX21lXCIsXG4gICAgICBwYXRoOiB0bXBEaXIsXG4gICAgICBtYXhDb3VudDogMyxcbiAgICB9KTtcblxuICAgIGFzc2VydC5vayhyZXN1bHQubWF0Y2hlcy5sZW5ndGggPD0gMyk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5saW1pdFJlYWNoZWQsIHRydWUpO1xuICB9KTtcblxuICB0ZXN0KFwiZXJyb3JzIG9uIG5vbi1leGlzdGVudCBwYXRoXCIsIGFzeW5jICgpID0+IHtcbiAgICBhd2FpdCBhc3NlcnQucmVqZWN0cygoKSA9PiB7XG4gICAgICByZXR1cm4gbmF0aXZlLmdyZXAoe1xuICAgICAgICBwYXR0ZXJuOiBcInRlc3RcIixcbiAgICAgICAgcGF0aDogXCIvbm9uZXhpc3RlbnQvcGF0aC90aGF0L2RvZXMvbm90L2V4aXN0XCIsXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFNBQVMsTUFBTSxnQkFBZ0I7QUFDL0IsT0FBTyxZQUFZO0FBQ25CLFNBQVMscUJBQXFCO0FBQzlCLFlBQVksVUFBVTtBQUN0QixTQUFTLHFCQUFxQjtBQUM5QixZQUFZLFFBQVE7QUFDcEIsWUFBWSxRQUFRO0FBRXBCLE1BQU0sWUFBWSxLQUFLLFFBQVEsY0FBYyxZQUFZLEdBQUcsQ0FBQztBQUM3RCxNQUFNQSxXQUFVLGNBQWMsWUFBWSxHQUFHO0FBRzdDLE1BQU0sV0FBVyxLQUFLLFFBQVEsV0FBVyxNQUFNLE1BQU0sTUFBTSxNQUFNLFVBQVUsT0FBTztBQUNsRixNQUFNLGNBQWMsR0FBRyxR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QkFBd0IsT0FBTyxNQUFNO0FBQ3hDLGFBQVMsR0FBRyxZQUFZLEtBQUssS0FBSyxHQUFHLE9BQU8sR0FBRyxnQkFBZ0IsQ0FBQztBQUNoRSxNQUFFLE1BQU0sTUFBTSxHQUFHLE9BQU8sUUFBUSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQyxDQUFDO0FBRWpFLE9BQUcsY0FBYyxLQUFLLEtBQUssUUFBUSxTQUFTLEdBQUcsb0JBQW9CO0FBQ25FLE9BQUcsY0FBYyxLQUFLLEtBQUssUUFBUSxTQUFTLEdBQUcsb0JBQW9CO0FBQ25FLE9BQUcsY0FBYyxLQUFLLEtBQUssUUFBUSxXQUFXLEdBQUcsa0JBQWtCO0FBRW5FLFVBQU0sU0FBUyxNQUFNLE9BQU8sS0FBSztBQUFBLE1BQy9CLFNBQVM7QUFBQSxNQUNULE1BQU07QUFBQSxNQUNOLE1BQU07QUFBQSxJQUNSLENBQUM7QUFFRCxXQUFPLE1BQU0sT0FBTyxjQUFjLENBQUM7QUFDbkMsV0FBTyxNQUFNLE9BQU8sUUFBUSxDQUFDLEVBQUUsTUFBTSxrQkFBa0I7QUFBQSxFQUN6RCxDQUFDO0FBRUQsT0FBSyxxQkFBcUIsT0FBTyxNQUFNO0FBQ3JDLGFBQVMsR0FBRyxZQUFZLEtBQUssS0FBSyxHQUFHLE9BQU8sR0FBRyxnQkFBZ0IsQ0FBQztBQUNoRSxNQUFFLE1BQU0sTUFBTSxHQUFHLE9BQU8sUUFBUSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQyxDQUFDO0FBRWpFLGFBQVMsSUFBSSxHQUFHLElBQUksSUFBSSxLQUFLO0FBQzNCLFNBQUcsY0FBYyxLQUFLLEtBQUssUUFBUSxPQUFPLENBQUMsTUFBTSxHQUFHLFlBQVk7QUFBQSxJQUNsRTtBQUVBLFVBQU0sU0FBUyxNQUFNLE9BQU8sS0FBSztBQUFBLE1BQy9CLFNBQVM7QUFBQSxNQUNULE1BQU07QUFBQSxNQUNOLFVBQVU7QUFBQSxJQUNaLENBQUM7QUFFRCxXQUFPLEdBQUcsT0FBTyxRQUFRLFVBQVUsQ0FBQztBQUNwQyxXQUFPLE1BQU0sT0FBTyxjQUFjLElBQUk7QUFBQSxFQUN4QyxDQUFDO0FBRUQsT0FBSywrQkFBK0IsWUFBWTtBQUM5QyxVQUFNLE9BQU8sUUFBUSxNQUFNO0FBQ3pCLGFBQU8sT0FBTyxLQUFLO0FBQUEsUUFDakIsU0FBUztBQUFBLFFBQ1QsTUFBTTtBQUFBLE1BQ1IsQ0FBQztBQUFBLElBQ0gsQ0FBQztBQUFBLEVBQ0gsQ0FBQztBQUNILENBQUM7IiwKICAibmFtZXMiOiBbInJlcXVpcmUiXQp9Cg==
