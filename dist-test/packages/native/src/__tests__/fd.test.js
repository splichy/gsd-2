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
describe("native fd: fuzzyFind()", () => {
  test("finds files matching a query", (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-fd-test-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(tmpDir, "main.rs"), "fn main() {}");
    fs.writeFileSync(path.join(tmpDir, "lib.rs"), "pub mod lib;");
    fs.writeFileSync(path.join(tmpDir, "utils.ts"), "export {}");
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.writeFileSync(path.join(tmpDir, "src", "helper.rs"), "fn helper() {}");
    const result = native.fuzzyFind({ query: "main", path: tmpDir });
    assert.ok(result.matches.length > 0, "Should find at least one match");
    assert.equal(result.matches[0].path, "main.rs");
    assert.equal(result.matches[0].isDirectory, false);
    assert.ok(result.matches[0].score > 0);
  });
  test("returns empty results for non-matching query", (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-fd-test-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(tmpDir, "hello.txt"), "hello");
    const result = native.fuzzyFind({
      query: "zzzznotexist",
      path: tmpDir
    });
    assert.equal(result.matches.length, 0);
    assert.equal(result.totalMatches, 0);
  });
  test("respects maxResults limit", (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-fd-test-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(tmpDir, `file${i}.txt`), "content");
    }
    const result = native.fuzzyFind({
      query: "file",
      path: tmpDir,
      maxResults: 3
    });
    assert.equal(result.matches.length, 3);
    assert.ok(result.totalMatches >= 3);
  });
  test("directories have trailing slash and bonus score", (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-fd-test-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(tmpDir, "models"));
    fs.writeFileSync(path.join(tmpDir, "models.ts"), "export {}");
    const result = native.fuzzyFind({ query: "models", path: tmpDir });
    const dirMatch = result.matches.find((m) => m.isDirectory);
    const fileMatch = result.matches.find((m) => !m.isDirectory);
    assert.ok(dirMatch, "Should find a directory match");
    assert.ok(fileMatch, "Should find a file match");
    assert.ok(dirMatch.path.endsWith("/"), "Directory should have trailing slash");
    assert.ok(dirMatch.score > fileMatch.score, "Directory should score higher");
  });
  test("empty query returns all entries", (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-fd-test-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    fs.writeFileSync(path.join(tmpDir, "b.txt"), "b");
    fs.writeFileSync(path.join(tmpDir, "c.txt"), "c");
    const result = native.fuzzyFind({ query: "", path: tmpDir });
    assert.equal(result.matches.length, 3);
  });
  test("errors on non-existent path", () => {
    assert.throws(
      () => native.fuzzyFind({ query: "test", path: "/nonexistent/path" }),
      { message: /Path not found/ }
    );
  });
  test("fuzzy subsequence matching works", (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-fd-test-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(tmpDir, "MyComponentFile.tsx"), "export {}");
    fs.writeFileSync(path.join(tmpDir, "other.txt"), "other");
    const result = native.fuzzyFind({ query: "mcf", path: tmpDir });
    assert.ok(result.matches.length > 0, "Fuzzy subsequence should match");
    assert.ok(
      result.matches.some((m) => m.path.includes("MyComponentFile")),
      "Should find MyComponentFile via fuzzy match"
    );
  });
  test("reuses the shared fs scan cache until invalidated", (t) => {
    const previousTtl = process.env.FS_SCAN_CACHE_TTL_MS;
    process.env.FS_SCAN_CACHE_TTL_MS = "10000";
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-fd-test-"));
    t.after(() => {
      native.invalidateFsScanCache(tmpDir);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (previousTtl === void 0) {
        delete process.env.FS_SCAN_CACHE_TTL_MS;
      } else {
        process.env.FS_SCAN_CACHE_TTL_MS = previousTtl;
      }
    });
    fs.writeFileSync(path.join(tmpDir, "cached.txt"), "cached");
    native.invalidateFsScanCache(tmpDir);
    const warm = native.fuzzyFind({ query: "cached", path: tmpDir });
    assert.ok(warm.matches.some((m) => m.path === "cached.txt"));
    fs.unlinkSync(path.join(tmpDir, "cached.txt"));
    const cached = native.fuzzyFind({ query: "cached", path: tmpDir });
    assert.ok(
      cached.matches.some((m) => m.path === "cached.txt"),
      "should serve warm results from the shared fs scan cache"
    );
    native.invalidateFsScanCache(tmpDir);
    const refreshed = native.fuzzyFind({ query: "cached", path: tmpDir });
    assert.equal(refreshed.matches.length, 0);
  });
  test("results are sorted by score descending", (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-fd-test-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(tmpDir, "main.ts"), "");
    fs.writeFileSync(path.join(tmpDir, "my_main.ts"), "");
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.writeFileSync(path.join(tmpDir, "src", "main.rs"), "");
    const result = native.fuzzyFind({
      query: "main",
      path: tmpDir,
      maxResults: 100
    });
    for (let i = 1; i < result.matches.length; i++) {
      assert.ok(
        result.matches[i - 1].score >= result.matches[i].score,
        `Match ${i - 1} (score ${result.matches[i - 1].score}) should be >= match ${i} (score ${result.matches[i].score})`
      );
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvbmF0aXZlL3NyYy9fX3Rlc3RzX18vZmQudGVzdC5tanMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IHRlc3QsIGRlc2NyaWJlIH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBjcmVhdGVSZXF1aXJlIH0gZnJvbSBcIm5vZGU6bW9kdWxlXCI7XG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tIFwibm9kZTp1cmxcIjtcbmltcG9ydCAqIGFzIGZzIGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgKiBhcyBvcyBmcm9tIFwibm9kZTpvc1wiO1xuXG5jb25zdCBfX2Rpcm5hbWUgPSBwYXRoLmRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKTtcbmNvbnN0IHJlcXVpcmUgPSBjcmVhdGVSZXF1aXJlKGltcG9ydC5tZXRhLnVybCk7XG5cbi8vIExvYWQgdGhlIG5hdGl2ZSBhZGRvbiBkaXJlY3RseVxuY29uc3QgYWRkb25EaXIgPSBwYXRoLnJlc29sdmUoX19kaXJuYW1lLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwibmF0aXZlXCIsIFwiYWRkb25cIik7XG5jb25zdCBwbGF0Zm9ybVRhZyA9IGAke3Byb2Nlc3MucGxhdGZvcm19LSR7cHJvY2Vzcy5hcmNofWA7XG5jb25zdCBjYW5kaWRhdGVzID0gW1xuICBwYXRoLmpvaW4oYWRkb25EaXIsIGBnc2RfZW5naW5lLiR7cGxhdGZvcm1UYWd9Lm5vZGVgKSxcbiAgcGF0aC5qb2luKGFkZG9uRGlyLCBcImdzZF9lbmdpbmUuZGV2Lm5vZGVcIiksXG5dO1xuXG5sZXQgbmF0aXZlO1xuZm9yIChjb25zdCBjYW5kaWRhdGUgb2YgY2FuZGlkYXRlcykge1xuICB0cnkge1xuICAgIG5hdGl2ZSA9IHJlcXVpcmUoY2FuZGlkYXRlKTtcbiAgICBicmVhaztcbiAgfSBjYXRjaCB7XG4gICAgLy8gdHJ5IG5leHRcbiAgfVxufVxuXG5pZiAoIW5hdGl2ZSkge1xuICBjb25zb2xlLmVycm9yKFwiTmF0aXZlIGFkZG9uIG5vdCBmb3VuZC4gUnVuIGBucG0gcnVuIGJ1aWxkOm5hdGl2ZSAtdyBAZ3NkL25hdGl2ZWAgZmlyc3QuXCIpO1xuICBwcm9jZXNzLmV4aXQoMSk7XG59XG5cbmRlc2NyaWJlKFwibmF0aXZlIGZkOiBmdXp6eUZpbmQoKVwiLCAoKSA9PiB7XG4gIHRlc3QoXCJmaW5kcyBmaWxlcyBtYXRjaGluZyBhIHF1ZXJ5XCIsICh0KSA9PiB7XG4gICAgY29uc3QgdG1wRGlyID0gZnMubWtkdGVtcFN5bmMocGF0aC5qb2luKG9zLnRtcGRpcigpLCBcImdzZC1mZC10ZXN0LVwiKSk7XG4gICAgdC5hZnRlcigoKSA9PiBmcy5ybVN5bmModG1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpO1xuXG4gICAgZnMud3JpdGVGaWxlU3luYyhwYXRoLmpvaW4odG1wRGlyLCBcIm1haW4ucnNcIiksIFwiZm4gbWFpbigpIHt9XCIpO1xuICAgIGZzLndyaXRlRmlsZVN5bmMocGF0aC5qb2luKHRtcERpciwgXCJsaWIucnNcIiksIFwicHViIG1vZCBsaWI7XCIpO1xuICAgIGZzLndyaXRlRmlsZVN5bmMocGF0aC5qb2luKHRtcERpciwgXCJ1dGlscy50c1wiKSwgXCJleHBvcnQge31cIik7XG4gICAgZnMubWtkaXJTeW5jKHBhdGguam9pbih0bXBEaXIsIFwic3JjXCIpKTtcbiAgICBmcy53cml0ZUZpbGVTeW5jKHBhdGguam9pbih0bXBEaXIsIFwic3JjXCIsIFwiaGVscGVyLnJzXCIpLCBcImZuIGhlbHBlcigpIHt9XCIpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gbmF0aXZlLmZ1enp5RmluZCh7IHF1ZXJ5OiBcIm1haW5cIiwgcGF0aDogdG1wRGlyIH0pO1xuXG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5tYXRjaGVzLmxlbmd0aCA+IDAsIFwiU2hvdWxkIGZpbmQgYXQgbGVhc3Qgb25lIG1hdGNoXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQubWF0Y2hlc1swXS5wYXRoLCBcIm1haW4ucnNcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5tYXRjaGVzWzBdLmlzRGlyZWN0b3J5LCBmYWxzZSk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5tYXRjaGVzWzBdLnNjb3JlID4gMCk7XG4gIH0pO1xuXG4gIHRlc3QoXCJyZXR1cm5zIGVtcHR5IHJlc3VsdHMgZm9yIG5vbi1tYXRjaGluZyBxdWVyeVwiLCAodCkgPT4ge1xuICAgIGNvbnN0IHRtcERpciA9IGZzLm1rZHRlbXBTeW5jKHBhdGguam9pbihvcy50bXBkaXIoKSwgXCJnc2QtZmQtdGVzdC1cIikpO1xuICAgIHQuYWZ0ZXIoKCkgPT4gZnMucm1TeW5jKHRtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcblxuICAgIGZzLndyaXRlRmlsZVN5bmMocGF0aC5qb2luKHRtcERpciwgXCJoZWxsby50eHRcIiksIFwiaGVsbG9cIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSBuYXRpdmUuZnV6enlGaW5kKHtcbiAgICAgIHF1ZXJ5OiBcInp6enpub3RleGlzdFwiLFxuICAgICAgcGF0aDogdG1wRGlyLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5tYXRjaGVzLmxlbmd0aCwgMCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC50b3RhbE1hdGNoZXMsIDApO1xuICB9KTtcblxuICB0ZXN0KFwicmVzcGVjdHMgbWF4UmVzdWx0cyBsaW1pdFwiLCAodCkgPT4ge1xuICAgIGNvbnN0IHRtcERpciA9IGZzLm1rZHRlbXBTeW5jKHBhdGguam9pbihvcy50bXBkaXIoKSwgXCJnc2QtZmQtdGVzdC1cIikpO1xuICAgIHQuYWZ0ZXIoKCkgPT4gZnMucm1TeW5jKHRtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcblxuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgMTA7IGkrKykge1xuICAgICAgZnMud3JpdGVGaWxlU3luYyhwYXRoLmpvaW4odG1wRGlyLCBgZmlsZSR7aX0udHh0YCksIFwiY29udGVudFwiKTtcbiAgICB9XG5cbiAgICBjb25zdCByZXN1bHQgPSBuYXRpdmUuZnV6enlGaW5kKHtcbiAgICAgIHF1ZXJ5OiBcImZpbGVcIixcbiAgICAgIHBhdGg6IHRtcERpcixcbiAgICAgIG1heFJlc3VsdHM6IDMsXG4gICAgfSk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm1hdGNoZXMubGVuZ3RoLCAzKTtcbiAgICBhc3NlcnQub2socmVzdWx0LnRvdGFsTWF0Y2hlcyA+PSAzKTtcbiAgfSk7XG5cbiAgdGVzdChcImRpcmVjdG9yaWVzIGhhdmUgdHJhaWxpbmcgc2xhc2ggYW5kIGJvbnVzIHNjb3JlXCIsICh0KSA9PiB7XG4gICAgY29uc3QgdG1wRGlyID0gZnMubWtkdGVtcFN5bmMocGF0aC5qb2luKG9zLnRtcGRpcigpLCBcImdzZC1mZC10ZXN0LVwiKSk7XG4gICAgdC5hZnRlcigoKSA9PiBmcy5ybVN5bmModG1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpO1xuXG4gICAgZnMubWtkaXJTeW5jKHBhdGguam9pbih0bXBEaXIsIFwibW9kZWxzXCIpKTtcbiAgICBmcy53cml0ZUZpbGVTeW5jKHBhdGguam9pbih0bXBEaXIsIFwibW9kZWxzLnRzXCIpLCBcImV4cG9ydCB7fVwiKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IG5hdGl2ZS5mdXp6eUZpbmQoeyBxdWVyeTogXCJtb2RlbHNcIiwgcGF0aDogdG1wRGlyIH0pO1xuXG4gICAgY29uc3QgZGlyTWF0Y2ggPSByZXN1bHQubWF0Y2hlcy5maW5kKChtKSA9PiBtLmlzRGlyZWN0b3J5KTtcbiAgICBjb25zdCBmaWxlTWF0Y2ggPSByZXN1bHQubWF0Y2hlcy5maW5kKChtKSA9PiAhbS5pc0RpcmVjdG9yeSk7XG5cbiAgICBhc3NlcnQub2soZGlyTWF0Y2gsIFwiU2hvdWxkIGZpbmQgYSBkaXJlY3RvcnkgbWF0Y2hcIik7XG4gICAgYXNzZXJ0Lm9rKGZpbGVNYXRjaCwgXCJTaG91bGQgZmluZCBhIGZpbGUgbWF0Y2hcIik7XG4gICAgYXNzZXJ0Lm9rKGRpck1hdGNoLnBhdGguZW5kc1dpdGgoXCIvXCIpLCBcIkRpcmVjdG9yeSBzaG91bGQgaGF2ZSB0cmFpbGluZyBzbGFzaFwiKTtcbiAgICBhc3NlcnQub2soZGlyTWF0Y2guc2NvcmUgPiBmaWxlTWF0Y2guc2NvcmUsIFwiRGlyZWN0b3J5IHNob3VsZCBzY29yZSBoaWdoZXJcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJlbXB0eSBxdWVyeSByZXR1cm5zIGFsbCBlbnRyaWVzXCIsICh0KSA9PiB7XG4gICAgY29uc3QgdG1wRGlyID0gZnMubWtkdGVtcFN5bmMocGF0aC5qb2luKG9zLnRtcGRpcigpLCBcImdzZC1mZC10ZXN0LVwiKSk7XG4gICAgdC5hZnRlcigoKSA9PiBmcy5ybVN5bmModG1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpO1xuXG4gICAgZnMud3JpdGVGaWxlU3luYyhwYXRoLmpvaW4odG1wRGlyLCBcImEudHh0XCIpLCBcImFcIik7XG4gICAgZnMud3JpdGVGaWxlU3luYyhwYXRoLmpvaW4odG1wRGlyLCBcImIudHh0XCIpLCBcImJcIik7XG4gICAgZnMud3JpdGVGaWxlU3luYyhwYXRoLmpvaW4odG1wRGlyLCBcImMudHh0XCIpLCBcImNcIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSBuYXRpdmUuZnV6enlGaW5kKHsgcXVlcnk6IFwiXCIsIHBhdGg6IHRtcERpciB9KTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQubWF0Y2hlcy5sZW5ndGgsIDMpO1xuICB9KTtcblxuICB0ZXN0KFwiZXJyb3JzIG9uIG5vbi1leGlzdGVudCBwYXRoXCIsICgpID0+IHtcbiAgICBhc3NlcnQudGhyb3dzKFxuICAgICAgKCkgPT4gbmF0aXZlLmZ1enp5RmluZCh7IHF1ZXJ5OiBcInRlc3RcIiwgcGF0aDogXCIvbm9uZXhpc3RlbnQvcGF0aFwiIH0pLFxuICAgICAgeyBtZXNzYWdlOiAvUGF0aCBub3QgZm91bmQvIH0sXG4gICAgKTtcbiAgfSk7XG5cbiAgdGVzdChcImZ1enp5IHN1YnNlcXVlbmNlIG1hdGNoaW5nIHdvcmtzXCIsICh0KSA9PiB7XG4gICAgY29uc3QgdG1wRGlyID0gZnMubWtkdGVtcFN5bmMocGF0aC5qb2luKG9zLnRtcGRpcigpLCBcImdzZC1mZC10ZXN0LVwiKSk7XG4gICAgdC5hZnRlcigoKSA9PiBmcy5ybVN5bmModG1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpO1xuXG4gICAgZnMud3JpdGVGaWxlU3luYyhwYXRoLmpvaW4odG1wRGlyLCBcIk15Q29tcG9uZW50RmlsZS50c3hcIiksIFwiZXhwb3J0IHt9XCIpO1xuICAgIGZzLndyaXRlRmlsZVN5bmMocGF0aC5qb2luKHRtcERpciwgXCJvdGhlci50eHRcIiksIFwib3RoZXJcIik7XG5cbiAgICAvLyBcIm1jZlwiIHNob3VsZCBmdXp6eS1tYXRjaCBcIk15Q29tcG9uZW50RmlsZVwiIHZpYSBzdWJzZXF1ZW5jZVxuICAgIGNvbnN0IHJlc3VsdCA9IG5hdGl2ZS5mdXp6eUZpbmQoeyBxdWVyeTogXCJtY2ZcIiwgcGF0aDogdG1wRGlyIH0pO1xuXG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5tYXRjaGVzLmxlbmd0aCA+IDAsIFwiRnV6enkgc3Vic2VxdWVuY2Ugc2hvdWxkIG1hdGNoXCIpO1xuICAgIGFzc2VydC5vayhcbiAgICAgIHJlc3VsdC5tYXRjaGVzLnNvbWUoKG0pID0+IG0ucGF0aC5pbmNsdWRlcyhcIk15Q29tcG9uZW50RmlsZVwiKSksXG4gICAgICBcIlNob3VsZCBmaW5kIE15Q29tcG9uZW50RmlsZSB2aWEgZnV6enkgbWF0Y2hcIixcbiAgICApO1xuICB9KTtcblxuICB0ZXN0KFwicmV1c2VzIHRoZSBzaGFyZWQgZnMgc2NhbiBjYWNoZSB1bnRpbCBpbnZhbGlkYXRlZFwiLCAodCkgPT4ge1xuICAgIGNvbnN0IHByZXZpb3VzVHRsID0gcHJvY2Vzcy5lbnYuRlNfU0NBTl9DQUNIRV9UVExfTVM7XG4gICAgcHJvY2Vzcy5lbnYuRlNfU0NBTl9DQUNIRV9UVExfTVMgPSBcIjEwMDAwXCI7XG5cbiAgICBjb25zdCB0bXBEaXIgPSBmcy5ta2R0ZW1wU3luYyhwYXRoLmpvaW4ob3MudG1wZGlyKCksIFwiZ3NkLWZkLXRlc3QtXCIpKTtcbiAgICB0LmFmdGVyKCgpID0+IHtcbiAgICAgIG5hdGl2ZS5pbnZhbGlkYXRlRnNTY2FuQ2FjaGUodG1wRGlyKTtcbiAgICAgIGZzLnJtU3luYyh0bXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICAgIGlmIChwcmV2aW91c1R0bCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGRlbGV0ZSBwcm9jZXNzLmVudi5GU19TQ0FOX0NBQ0hFX1RUTF9NUztcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHByb2Nlc3MuZW52LkZTX1NDQU5fQ0FDSEVfVFRMX01TID0gcHJldmlvdXNUdGw7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBmcy53cml0ZUZpbGVTeW5jKHBhdGguam9pbih0bXBEaXIsIFwiY2FjaGVkLnR4dFwiKSwgXCJjYWNoZWRcIik7XG4gICAgbmF0aXZlLmludmFsaWRhdGVGc1NjYW5DYWNoZSh0bXBEaXIpO1xuXG4gICAgY29uc3Qgd2FybSA9IG5hdGl2ZS5mdXp6eUZpbmQoeyBxdWVyeTogXCJjYWNoZWRcIiwgcGF0aDogdG1wRGlyIH0pO1xuICAgIGFzc2VydC5vayh3YXJtLm1hdGNoZXMuc29tZSgobSkgPT4gbS5wYXRoID09PSBcImNhY2hlZC50eHRcIikpO1xuXG4gICAgZnMudW5saW5rU3luYyhwYXRoLmpvaW4odG1wRGlyLCBcImNhY2hlZC50eHRcIikpO1xuXG4gICAgY29uc3QgY2FjaGVkID0gbmF0aXZlLmZ1enp5RmluZCh7IHF1ZXJ5OiBcImNhY2hlZFwiLCBwYXRoOiB0bXBEaXIgfSk7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgY2FjaGVkLm1hdGNoZXMuc29tZSgobSkgPT4gbS5wYXRoID09PSBcImNhY2hlZC50eHRcIiksXG4gICAgICBcInNob3VsZCBzZXJ2ZSB3YXJtIHJlc3VsdHMgZnJvbSB0aGUgc2hhcmVkIGZzIHNjYW4gY2FjaGVcIixcbiAgICApO1xuXG4gICAgbmF0aXZlLmludmFsaWRhdGVGc1NjYW5DYWNoZSh0bXBEaXIpO1xuXG4gICAgY29uc3QgcmVmcmVzaGVkID0gbmF0aXZlLmZ1enp5RmluZCh7IHF1ZXJ5OiBcImNhY2hlZFwiLCBwYXRoOiB0bXBEaXIgfSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlZnJlc2hlZC5tYXRjaGVzLmxlbmd0aCwgMCk7XG4gIH0pO1xuXG4gIHRlc3QoXCJyZXN1bHRzIGFyZSBzb3J0ZWQgYnkgc2NvcmUgZGVzY2VuZGluZ1wiLCAodCkgPT4ge1xuICAgIGNvbnN0IHRtcERpciA9IGZzLm1rZHRlbXBTeW5jKHBhdGguam9pbihvcy50bXBkaXIoKSwgXCJnc2QtZmQtdGVzdC1cIikpO1xuICAgIHQuYWZ0ZXIoKCkgPT4gZnMucm1TeW5jKHRtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcblxuICAgIGZzLndyaXRlRmlsZVN5bmMocGF0aC5qb2luKHRtcERpciwgXCJtYWluLnRzXCIpLCBcIlwiKTtcbiAgICBmcy53cml0ZUZpbGVTeW5jKHBhdGguam9pbih0bXBEaXIsIFwibXlfbWFpbi50c1wiKSwgXCJcIik7XG4gICAgZnMubWtkaXJTeW5jKHBhdGguam9pbih0bXBEaXIsIFwic3JjXCIpKTtcbiAgICBmcy53cml0ZUZpbGVTeW5jKHBhdGguam9pbih0bXBEaXIsIFwic3JjXCIsIFwibWFpbi5yc1wiKSwgXCJcIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSBuYXRpdmUuZnV6enlGaW5kKHtcbiAgICAgIHF1ZXJ5OiBcIm1haW5cIixcbiAgICAgIHBhdGg6IHRtcERpcixcbiAgICAgIG1heFJlc3VsdHM6IDEwMCxcbiAgICB9KTtcblxuICAgIGZvciAobGV0IGkgPSAxOyBpIDwgcmVzdWx0Lm1hdGNoZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgcmVzdWx0Lm1hdGNoZXNbaSAtIDFdLnNjb3JlID49IHJlc3VsdC5tYXRjaGVzW2ldLnNjb3JlLFxuICAgICAgICBgTWF0Y2ggJHtpIC0gMX0gKHNjb3JlICR7cmVzdWx0Lm1hdGNoZXNbaSAtIDFdLnNjb3JlfSkgc2hvdWxkIGJlID49IG1hdGNoICR7aX0gKHNjb3JlICR7cmVzdWx0Lm1hdGNoZXNbaV0uc2NvcmV9KWAsXG4gICAgICApO1xuICAgIH1cbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFNBQVMsTUFBTSxnQkFBZ0I7QUFDL0IsT0FBTyxZQUFZO0FBQ25CLFNBQVMscUJBQXFCO0FBQzlCLFlBQVksVUFBVTtBQUN0QixTQUFTLHFCQUFxQjtBQUM5QixZQUFZLFFBQVE7QUFDcEIsWUFBWSxRQUFRO0FBRXBCLE1BQU0sWUFBWSxLQUFLLFFBQVEsY0FBYyxZQUFZLEdBQUcsQ0FBQztBQUM3RCxNQUFNQSxXQUFVLGNBQWMsWUFBWSxHQUFHO0FBRzdDLE1BQU0sV0FBVyxLQUFLLFFBQVEsV0FBVyxNQUFNLE1BQU0sTUFBTSxNQUFNLFVBQVUsT0FBTztBQUNsRixNQUFNLGNBQWMsR0FBRyxRQUFRLFFBQVEsSUFBSSxRQUFRLElBQUk7QUFDdkQsTUFBTSxhQUFhO0FBQUEsRUFDakIsS0FBSyxLQUFLLFVBQVUsY0FBYyxXQUFXLE9BQU87QUFBQSxFQUNwRCxLQUFLLEtBQUssVUFBVSxxQkFBcUI7QUFDM0M7QUFFQSxJQUFJO0FBQ0osV0FBVyxhQUFhLFlBQVk7QUFDbEMsTUFBSTtBQUNGLGFBQVNBLFNBQVEsU0FBUztBQUMxQjtBQUFBLEVBQ0YsUUFBUTtBQUFBLEVBRVI7QUFDRjtBQUVBLElBQUks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
