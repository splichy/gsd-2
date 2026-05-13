import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require2 = createRequire(import.meta.url);
const addonDir = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "native",
  "addon"
);
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
  console.error(
    "Native addon not found. Run `npm run build:native -w @gsd/native` first."
  );
  process.exit(1);
}
describe("native glob: glob()", () => {
  test("finds files matching a pattern", async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-glob-test-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(tmpDir, "file1.ts"), "const a = 1;");
    fs.writeFileSync(path.join(tmpDir, "file2.ts"), "const b = 2;");
    fs.writeFileSync(path.join(tmpDir, "file3.js"), "const c = 3;");
    const result = await native.glob({ pattern: "*.ts", path: tmpDir });
    assert.equal(result.totalMatches, 2);
    assert.equal(result.matches.length, 2);
    const paths = result.matches.map((m) => m.path).sort();
    assert.deepEqual(paths, ["file1.ts", "file2.ts"]);
  });
  test("recursive matching into subdirectories", async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-glob-test-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.mkdirSync(path.join(tmpDir, "src", "nested"));
    fs.writeFileSync(path.join(tmpDir, "root.ts"), "");
    fs.writeFileSync(path.join(tmpDir, "src", "a.ts"), "");
    fs.writeFileSync(path.join(tmpDir, "src", "nested", "b.ts"), "");
    const result = await native.glob({ pattern: "*.ts", path: tmpDir });
    assert.equal(result.totalMatches, 3);
    const paths = result.matches.map((m) => m.path).sort();
    assert.ok(paths.includes("root.ts"));
    assert.ok(paths.includes("src/a.ts"));
    assert.ok(paths.includes("src/nested/b.ts"));
  });
  test("respects maxResults limit", async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-glob-test-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(tmpDir, `file${i}.txt`), "");
    }
    const result = await native.glob({
      pattern: "*.txt",
      path: tmpDir,
      maxResults: 3
    });
    assert.equal(result.matches.length, 3);
    assert.equal(result.totalMatches, 3);
  });
  test("filters by file type (directories only)", async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-glob-test-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(tmpDir, "dir1"));
    fs.mkdirSync(path.join(tmpDir, "dir2"));
    fs.writeFileSync(path.join(tmpDir, "file.txt"), "");
    const result = await native.glob({
      pattern: "*",
      path: tmpDir,
      recursive: false,
      fileType: 2
      // Dir
    });
    assert.equal(result.totalMatches, 2);
    const paths = result.matches.map((m) => m.path).sort();
    assert.deepEqual(paths, ["dir1", "dir2"]);
  });
  test("respects .gitignore", async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-glob-test-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(tmpDir, ".git"));
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "ignored.txt\n");
    fs.writeFileSync(path.join(tmpDir, "kept.txt"), "");
    fs.writeFileSync(path.join(tmpDir, "ignored.txt"), "");
    const result = await native.glob({
      pattern: "*.txt",
      path: tmpDir,
      gitignore: true
    });
    assert.equal(result.totalMatches, 1);
    assert.equal(result.matches[0].path, "kept.txt");
  });
  test("includes gitignored files when gitignore=false", async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-glob-test-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(tmpDir, ".git"));
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "ignored.txt\n");
    fs.writeFileSync(path.join(tmpDir, "kept.txt"), "");
    fs.writeFileSync(path.join(tmpDir, "ignored.txt"), "");
    const result = await native.glob({
      pattern: "*.txt",
      path: tmpDir,
      gitignore: false
    });
    assert.equal(result.totalMatches, 2);
  });
  test("skips node_modules by default", async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-glob-test-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(tmpDir, "node_modules"));
    fs.writeFileSync(path.join(tmpDir, "node_modules", "dep.js"), "");
    fs.writeFileSync(path.join(tmpDir, "app.js"), "");
    const result = await native.glob({
      pattern: "*.js",
      path: tmpDir,
      gitignore: false
    });
    assert.equal(result.totalMatches, 1);
    assert.equal(result.matches[0].path, "app.js");
  });
  test("sortByMtime returns most recent first", async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-glob-test-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(tmpDir, "old.txt"), "old");
    const now = /* @__PURE__ */ new Date();
    fs.utimesSync(
      path.join(tmpDir, "old.txt"),
      new Date(now.getTime() - 5e3),
      new Date(now.getTime() - 5e3)
    );
    fs.writeFileSync(path.join(tmpDir, "new.txt"), "new");
    const result = await native.glob({
      pattern: "*.txt",
      path: tmpDir,
      sortByMtime: true
    });
    assert.equal(result.totalMatches, 2);
    assert.equal(result.matches[0].path, "new.txt");
    assert.equal(result.matches[1].path, "old.txt");
  });
  test("errors on non-existent path", async () => {
    await assert.rejects(
      () => native.glob({
        pattern: "*.txt",
        path: "/nonexistent/path/that/does/not/exist"
      }),
      /Path not found/
    );
  });
  test("returns mtime for each entry", async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-glob-test-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(tmpDir, "test.txt"), "content");
    const result = await native.glob({ pattern: "*.txt", path: tmpDir });
    assert.equal(result.matches.length, 1);
    assert.ok(typeof result.matches[0].mtime === "number");
    const oneMinuteAgo = Date.now() - 6e4;
    assert.ok(result.matches[0].mtime > oneMinuteAgo);
  });
});
describe("native glob: invalidateFsScanCache()", () => {
  test("can be called with a path", () => {
    native.invalidateFsScanCache("/tmp");
  });
  test("can be called without arguments", () => {
    native.invalidateFsScanCache();
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvbmF0aXZlL3NyYy9fX3Rlc3RzX18vZ2xvYi50ZXN0Lm1qcyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgdGVzdCwgZGVzY3JpYmUgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IGNyZWF0ZVJlcXVpcmUgfSBmcm9tIFwibm9kZTptb2R1bGVcIjtcbmltcG9ydCAqIGFzIHBhdGggZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gXCJub2RlOnVybFwiO1xuaW1wb3J0ICogYXMgZnMgZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCAqIGFzIG9zIGZyb20gXCJub2RlOm9zXCI7XG5cbmNvbnN0IF9fZGlybmFtZSA9IHBhdGguZGlybmFtZShmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuY29uc3QgcmVxdWlyZSA9IGNyZWF0ZVJlcXVpcmUoaW1wb3J0Lm1ldGEudXJsKTtcblxuLy8gTG9hZCB0aGUgbmF0aXZlIGFkZG9uIGRpcmVjdGx5XG5jb25zdCBhZGRvbkRpciA9IHBhdGgucmVzb2x2ZShcbiAgX19kaXJuYW1lLFxuICBcIi4uXCIsXG4gIFwiLi5cIixcbiAgXCIuLlwiLFxuICBcIi4uXCIsXG4gIFwibmF0aXZlXCIsXG4gIFwiYWRkb25cIixcbik7XG5jb25zdCBwbGF0Zm9ybVRhZyA9IGAke3Byb2Nlc3MucGxhdGZvcm19LSR7cHJvY2Vzcy5hcmNofWA7XG5jb25zdCBjYW5kaWRhdGVzID0gW1xuICBwYXRoLmpvaW4oYWRkb25EaXIsIGBnc2RfZW5naW5lLiR7cGxhdGZvcm1UYWd9Lm5vZGVgKSxcbiAgcGF0aC5qb2luKGFkZG9uRGlyLCBcImdzZF9lbmdpbmUuZGV2Lm5vZGVcIiksXG5dO1xuXG5sZXQgbmF0aXZlO1xuZm9yIChjb25zdCBjYW5kaWRhdGUgb2YgY2FuZGlkYXRlcykge1xuICB0cnkge1xuICAgIG5hdGl2ZSA9IHJlcXVpcmUoY2FuZGlkYXRlKTtcbiAgICBicmVhaztcbiAgfSBjYXRjaCB7XG4gICAgLy8gdHJ5IG5leHRcbiAgfVxufVxuXG5pZiAoIW5hdGl2ZSkge1xuICBjb25zb2xlLmVycm9yKFxuICAgIFwiTmF0aXZlIGFkZG9uIG5vdCBmb3VuZC4gUnVuIGBucG0gcnVuIGJ1aWxkOm5hdGl2ZSAtdyBAZ3NkL25hdGl2ZWAgZmlyc3QuXCIsXG4gICk7XG4gIHByb2Nlc3MuZXhpdCgxKTtcbn1cblxuZGVzY3JpYmUoXCJuYXRpdmUgZ2xvYjogZ2xvYigpXCIsICgpID0+IHtcbiAgdGVzdChcImZpbmRzIGZpbGVzIG1hdGNoaW5nIGEgcGF0dGVyblwiLCBhc3luYyAodCkgPT4ge1xuICAgIGNvbnN0IHRtcERpciA9IGZzLm1rZHRlbXBTeW5jKHBhdGguam9pbihvcy50bXBkaXIoKSwgXCJnc2QtZ2xvYi10ZXN0LVwiKSk7XG4gICAgdC5hZnRlcigoKSA9PiBmcy5ybVN5bmModG1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpO1xuXG4gICAgZnMud3JpdGVGaWxlU3luYyhwYXRoLmpvaW4odG1wRGlyLCBcImZpbGUxLnRzXCIpLCBcImNvbnN0IGEgPSAxO1wiKTtcbiAgICBmcy53cml0ZUZpbGVTeW5jKHBhdGguam9pbih0bXBEaXIsIFwiZmlsZTIudHNcIiksIFwiY29uc3QgYiA9IDI7XCIpO1xuICAgIGZzLndyaXRlRmlsZVN5bmMocGF0aC5qb2luKHRtcERpciwgXCJmaWxlMy5qc1wiKSwgXCJjb25zdCBjID0gMztcIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBuYXRpdmUuZ2xvYih7IHBhdHRlcm46IFwiKi50c1wiLCBwYXRoOiB0bXBEaXIgfSk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnRvdGFsTWF0Y2hlcywgMik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5tYXRjaGVzLmxlbmd0aCwgMik7XG4gICAgY29uc3QgcGF0aHMgPSByZXN1bHQubWF0Y2hlcy5tYXAoKG0pID0+IG0ucGF0aCkuc29ydCgpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwocGF0aHMsIFtcImZpbGUxLnRzXCIsIFwiZmlsZTIudHNcIl0pO1xuICB9KTtcblxuICB0ZXN0KFwicmVjdXJzaXZlIG1hdGNoaW5nIGludG8gc3ViZGlyZWN0b3JpZXNcIiwgYXN5bmMgKHQpID0+IHtcbiAgICBjb25zdCB0bXBEaXIgPSBmcy5ta2R0ZW1wU3luYyhwYXRoLmpvaW4ob3MudG1wZGlyKCksIFwiZ3NkLWdsb2ItdGVzdC1cIikpO1xuICAgIHQuYWZ0ZXIoKCkgPT4gZnMucm1TeW5jKHRtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcblxuICAgIGZzLm1rZGlyU3luYyhwYXRoLmpvaW4odG1wRGlyLCBcInNyY1wiKSk7XG4gICAgZnMubWtkaXJTeW5jKHBhdGguam9pbih0bXBEaXIsIFwic3JjXCIsIFwibmVzdGVkXCIpKTtcbiAgICBmcy53cml0ZUZpbGVTeW5jKHBhdGguam9pbih0bXBEaXIsIFwicm9vdC50c1wiKSwgXCJcIik7XG4gICAgZnMud3JpdGVGaWxlU3luYyhwYXRoLmpvaW4odG1wRGlyLCBcInNyY1wiLCBcImEudHNcIiksIFwiXCIpO1xuICAgIGZzLndyaXRlRmlsZVN5bmMocGF0aC5qb2luKHRtcERpciwgXCJzcmNcIiwgXCJuZXN0ZWRcIiwgXCJiLnRzXCIpLCBcIlwiKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IG5hdGl2ZS5nbG9iKHsgcGF0dGVybjogXCIqLnRzXCIsIHBhdGg6IHRtcERpciB9KTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQudG90YWxNYXRjaGVzLCAzKTtcbiAgICBjb25zdCBwYXRocyA9IHJlc3VsdC5tYXRjaGVzLm1hcCgobSkgPT4gbS5wYXRoKS5zb3J0KCk7XG4gICAgYXNzZXJ0Lm9rKHBhdGhzLmluY2x1ZGVzKFwicm9vdC50c1wiKSk7XG4gICAgYXNzZXJ0Lm9rKHBhdGhzLmluY2x1ZGVzKFwic3JjL2EudHNcIikpO1xuICAgIGFzc2VydC5vayhwYXRocy5pbmNsdWRlcyhcInNyYy9uZXN0ZWQvYi50c1wiKSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJyZXNwZWN0cyBtYXhSZXN1bHRzIGxpbWl0XCIsIGFzeW5jICh0KSA9PiB7XG4gICAgY29uc3QgdG1wRGlyID0gZnMubWtkdGVtcFN5bmMocGF0aC5qb2luKG9zLnRtcGRpcigpLCBcImdzZC1nbG9iLXRlc3QtXCIpKTtcbiAgICB0LmFmdGVyKCgpID0+IGZzLnJtU3luYyh0bXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSk7XG5cbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IDEwOyBpKyspIHtcbiAgICAgIGZzLndyaXRlRmlsZVN5bmMocGF0aC5qb2luKHRtcERpciwgYGZpbGUke2l9LnR4dGApLCBcIlwiKTtcbiAgICB9XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBuYXRpdmUuZ2xvYih7XG4gICAgICBwYXR0ZXJuOiBcIioudHh0XCIsXG4gICAgICBwYXRoOiB0bXBEaXIsXG4gICAgICBtYXhSZXN1bHRzOiAzLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5tYXRjaGVzLmxlbmd0aCwgMyk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC50b3RhbE1hdGNoZXMsIDMpO1xuICB9KTtcblxuICB0ZXN0KFwiZmlsdGVycyBieSBmaWxlIHR5cGUgKGRpcmVjdG9yaWVzIG9ubHkpXCIsIGFzeW5jICh0KSA9PiB7XG4gICAgY29uc3QgdG1wRGlyID0gZnMubWtkdGVtcFN5bmMocGF0aC5qb2luKG9zLnRtcGRpcigpLCBcImdzZC1nbG9iLXRlc3QtXCIpKTtcbiAgICB0LmFmdGVyKCgpID0+IGZzLnJtU3luYyh0bXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSk7XG5cbiAgICBmcy5ta2RpclN5bmMocGF0aC5qb2luKHRtcERpciwgXCJkaXIxXCIpKTtcbiAgICBmcy5ta2RpclN5bmMocGF0aC5qb2luKHRtcERpciwgXCJkaXIyXCIpKTtcbiAgICBmcy53cml0ZUZpbGVTeW5jKHBhdGguam9pbih0bXBEaXIsIFwiZmlsZS50eHRcIiksIFwiXCIpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgbmF0aXZlLmdsb2Ioe1xuICAgICAgcGF0dGVybjogXCIqXCIsXG4gICAgICBwYXRoOiB0bXBEaXIsXG4gICAgICByZWN1cnNpdmU6IGZhbHNlLFxuICAgICAgZmlsZVR5cGU6IDIsIC8vIERpclxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC50b3RhbE1hdGNoZXMsIDIpO1xuICAgIGNvbnN0IHBhdGhzID0gcmVzdWx0Lm1hdGNoZXMubWFwKChtKSA9PiBtLnBhdGgpLnNvcnQoKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHBhdGhzLCBbXCJkaXIxXCIsIFwiZGlyMlwiXSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJyZXNwZWN0cyAuZ2l0aWdub3JlXCIsIGFzeW5jICh0KSA9PiB7XG4gICAgY29uc3QgdG1wRGlyID0gZnMubWtkdGVtcFN5bmMocGF0aC5qb2luKG9zLnRtcGRpcigpLCBcImdzZC1nbG9iLXRlc3QtXCIpKTtcbiAgICB0LmFmdGVyKCgpID0+IGZzLnJtU3luYyh0bXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSk7XG5cbiAgICAvLyBJbml0IGEgZ2l0IHJlcG8gc28gLmdpdGlnbm9yZSBpcyByZXNwZWN0ZWRcbiAgICBmcy5ta2RpclN5bmMocGF0aC5qb2luKHRtcERpciwgXCIuZ2l0XCIpKTtcbiAgICBmcy53cml0ZUZpbGVTeW5jKHBhdGguam9pbih0bXBEaXIsIFwiLmdpdGlnbm9yZVwiKSwgXCJpZ25vcmVkLnR4dFxcblwiKTtcbiAgICBmcy53cml0ZUZpbGVTeW5jKHBhdGguam9pbih0bXBEaXIsIFwia2VwdC50eHRcIiksIFwiXCIpO1xuICAgIGZzLndyaXRlRmlsZVN5bmMocGF0aC5qb2luKHRtcERpciwgXCJpZ25vcmVkLnR4dFwiKSwgXCJcIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBuYXRpdmUuZ2xvYih7XG4gICAgICBwYXR0ZXJuOiBcIioudHh0XCIsXG4gICAgICBwYXRoOiB0bXBEaXIsXG4gICAgICBnaXRpZ25vcmU6IHRydWUsXG4gICAgfSk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnRvdGFsTWF0Y2hlcywgMSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5tYXRjaGVzWzBdLnBhdGgsIFwia2VwdC50eHRcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJpbmNsdWRlcyBnaXRpZ25vcmVkIGZpbGVzIHdoZW4gZ2l0aWdub3JlPWZhbHNlXCIsIGFzeW5jICh0KSA9PiB7XG4gICAgY29uc3QgdG1wRGlyID0gZnMubWtkdGVtcFN5bmMocGF0aC5qb2luKG9zLnRtcGRpcigpLCBcImdzZC1nbG9iLXRlc3QtXCIpKTtcbiAgICB0LmFmdGVyKCgpID0+IGZzLnJtU3luYyh0bXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSk7XG5cbiAgICBmcy5ta2RpclN5bmMocGF0aC5qb2luKHRtcERpciwgXCIuZ2l0XCIpKTtcbiAgICBmcy53cml0ZUZpbGVTeW5jKHBhdGguam9pbih0bXBEaXIsIFwiLmdpdGlnbm9yZVwiKSwgXCJpZ25vcmVkLnR4dFxcblwiKTtcbiAgICBmcy53cml0ZUZpbGVTeW5jKHBhdGguam9pbih0bXBEaXIsIFwia2VwdC50eHRcIiksIFwiXCIpO1xuICAgIGZzLndyaXRlRmlsZVN5bmMocGF0aC5qb2luKHRtcERpciwgXCJpZ25vcmVkLnR4dFwiKSwgXCJcIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBuYXRpdmUuZ2xvYih7XG4gICAgICBwYXR0ZXJuOiBcIioudHh0XCIsXG4gICAgICBwYXRoOiB0bXBEaXIsXG4gICAgICBnaXRpZ25vcmU6IGZhbHNlLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC50b3RhbE1hdGNoZXMsIDIpO1xuICB9KTtcblxuICB0ZXN0KFwic2tpcHMgbm9kZV9tb2R1bGVzIGJ5IGRlZmF1bHRcIiwgYXN5bmMgKHQpID0+IHtcbiAgICBjb25zdCB0bXBEaXIgPSBmcy5ta2R0ZW1wU3luYyhwYXRoLmpvaW4ob3MudG1wZGlyKCksIFwiZ3NkLWdsb2ItdGVzdC1cIikpO1xuICAgIHQuYWZ0ZXIoKCkgPT4gZnMucm1TeW5jKHRtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcblxuICAgIGZzLm1rZGlyU3luYyhwYXRoLmpvaW4odG1wRGlyLCBcIm5vZGVfbW9kdWxlc1wiKSk7XG4gICAgZnMud3JpdGVGaWxlU3luYyhwYXRoLmpvaW4odG1wRGlyLCBcIm5vZGVfbW9kdWxlc1wiLCBcImRlcC5qc1wiKSwgXCJcIik7XG4gICAgZnMud3JpdGVGaWxlU3luYyhwYXRoLmpvaW4odG1wRGlyLCBcImFwcC5qc1wiKSwgXCJcIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBuYXRpdmUuZ2xvYih7XG4gICAgICBwYXR0ZXJuOiBcIiouanNcIixcbiAgICAgIHBhdGg6IHRtcERpcixcbiAgICAgIGdpdGlnbm9yZTogZmFsc2UsXG4gICAgfSk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnRvdGFsTWF0Y2hlcywgMSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5tYXRjaGVzWzBdLnBhdGgsIFwiYXBwLmpzXCIpO1xuICB9KTtcblxuICB0ZXN0KFwic29ydEJ5TXRpbWUgcmV0dXJucyBtb3N0IHJlY2VudCBmaXJzdFwiLCBhc3luYyAodCkgPT4ge1xuICAgIGNvbnN0IHRtcERpciA9IGZzLm1rZHRlbXBTeW5jKHBhdGguam9pbihvcy50bXBkaXIoKSwgXCJnc2QtZ2xvYi10ZXN0LVwiKSk7XG4gICAgdC5hZnRlcigoKSA9PiBmcy5ybVN5bmModG1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpO1xuXG4gICAgZnMud3JpdGVGaWxlU3luYyhwYXRoLmpvaW4odG1wRGlyLCBcIm9sZC50eHRcIiksIFwib2xkXCIpO1xuICAgIC8vIEVuc3VyZSBkaWZmZXJlbnQgbXRpbWVcbiAgICBjb25zdCBub3cgPSBuZXcgRGF0ZSgpO1xuICAgIGZzLnV0aW1lc1N5bmMoXG4gICAgICBwYXRoLmpvaW4odG1wRGlyLCBcIm9sZC50eHRcIiksXG4gICAgICBuZXcgRGF0ZShub3cuZ2V0VGltZSgpIC0gNTAwMCksXG4gICAgICBuZXcgRGF0ZShub3cuZ2V0VGltZSgpIC0gNTAwMCksXG4gICAgKTtcbiAgICBmcy53cml0ZUZpbGVTeW5jKHBhdGguam9pbih0bXBEaXIsIFwibmV3LnR4dFwiKSwgXCJuZXdcIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBuYXRpdmUuZ2xvYih7XG4gICAgICBwYXR0ZXJuOiBcIioudHh0XCIsXG4gICAgICBwYXRoOiB0bXBEaXIsXG4gICAgICBzb3J0QnlNdGltZTogdHJ1ZSxcbiAgICB9KTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQudG90YWxNYXRjaGVzLCAyKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm1hdGNoZXNbMF0ucGF0aCwgXCJuZXcudHh0XCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQubWF0Y2hlc1sxXS5wYXRoLCBcIm9sZC50eHRcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJlcnJvcnMgb24gbm9uLWV4aXN0ZW50IHBhdGhcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGF3YWl0IGFzc2VydC5yZWplY3RzKFxuICAgICAgKCkgPT5cbiAgICAgICAgbmF0aXZlLmdsb2Ioe1xuICAgICAgICAgIHBhdHRlcm46IFwiKi50eHRcIixcbiAgICAgICAgICBwYXRoOiBcIi9ub25leGlzdGVudC9wYXRoL3RoYXQvZG9lcy9ub3QvZXhpc3RcIixcbiAgICAgICAgfSksXG4gICAgICAvUGF0aCBub3QgZm91bmQvLFxuICAgICk7XG4gIH0pO1xuXG4gIHRlc3QoXCJyZXR1cm5zIG10aW1lIGZvciBlYWNoIGVudHJ5XCIsIGFzeW5jICh0KSA9PiB7XG4gICAgY29uc3QgdG1wRGlyID0gZnMubWtkdGVtcFN5bmMocGF0aC5qb2luKG9zLnRtcGRpcigpLCBcImdzZC1nbG9iLXRlc3QtXCIpKTtcbiAgICB0LmFmdGVyKCgpID0+IGZzLnJtU3luYyh0bXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSk7XG5cbiAgICBmcy53cml0ZUZpbGVTeW5jKHBhdGguam9pbih0bXBEaXIsIFwidGVzdC50eHRcIiksIFwiY29udGVudFwiKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IG5hdGl2ZS5nbG9iKHsgcGF0dGVybjogXCIqLnR4dFwiLCBwYXRoOiB0bXBEaXIgfSk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm1hdGNoZXMubGVuZ3RoLCAxKTtcbiAgICBhc3NlcnQub2sodHlwZW9mIHJlc3VsdC5tYXRjaGVzWzBdLm10aW1lID09PSBcIm51bWJlclwiKTtcbiAgICAvLyBtdGltZSBzaG91bGQgYmUgd2l0aGluIHRoZSBsYXN0IG1pbnV0ZVxuICAgIGNvbnN0IG9uZU1pbnV0ZUFnbyA9IERhdGUubm93KCkgLSA2MF8wMDA7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5tYXRjaGVzWzBdLm10aW1lID4gb25lTWludXRlQWdvKTtcbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoXCJuYXRpdmUgZ2xvYjogaW52YWxpZGF0ZUZzU2NhbkNhY2hlKClcIiwgKCkgPT4ge1xuICB0ZXN0KFwiY2FuIGJlIGNhbGxlZCB3aXRoIGEgcGF0aFwiLCAoKSA9PiB7XG4gICAgLy8gU2hvdWxkIG5vdCB0aHJvd1xuICAgIG5hdGl2ZS5pbnZhbGlkYXRlRnNTY2FuQ2FjaGUoXCIvdG1wXCIpO1xuICB9KTtcblxuICB0ZXN0KFwiY2FuIGJlIGNhbGxlZCB3aXRob3V0IGFyZ3VtZW50c1wiLCAoKSA9PiB7XG4gICAgLy8gU2hvdWxkIG5vdCB0aHJv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
