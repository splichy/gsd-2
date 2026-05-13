import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
  readManifestRuntimeDeps,
  collectRuntimeDependencies,
  verifyRuntimeDependencies,
  resolveLocalSourcePath
} from "./lifecycle-hooks.js";
function tmpDir(prefix, t) {
  const dir = mkdtempSync(join(tmpdir(), `pi-lh-${prefix}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
describe("readManifestRuntimeDeps", () => {
  it("returns empty array when manifest file is missing", (t) => {
    const dir = tmpDir("no-manifest", t);
    assert.deepEqual(readManifestRuntimeDeps(dir), []);
  });
  it("returns empty array for malformed JSON", (t) => {
    const dir = tmpDir("bad-json", t);
    writeFileSync(join(dir, "extension-manifest.json"), "not json{{{", "utf-8");
    assert.deepEqual(readManifestRuntimeDeps(dir), []);
  });
  it("returns runtime deps from valid manifest", (t) => {
    const dir = tmpDir("valid", t);
    writeFileSync(join(dir, "extension-manifest.json"), JSON.stringify({
      dependencies: { runtime: ["claude", "node"] }
    }), "utf-8");
    assert.deepEqual(readManifestRuntimeDeps(dir), ["claude", "node"]);
  });
  it("returns empty array when dependencies exists but runtime is missing", (t) => {
    const dir = tmpDir("no-runtime", t);
    writeFileSync(join(dir, "extension-manifest.json"), JSON.stringify({
      dependencies: {}
    }), "utf-8");
    assert.deepEqual(readManifestRuntimeDeps(dir), []);
  });
  it("returns empty array when runtime is empty", (t) => {
    const dir = tmpDir("empty-runtime", t);
    writeFileSync(join(dir, "extension-manifest.json"), JSON.stringify({
      dependencies: { runtime: [] }
    }), "utf-8");
    assert.deepEqual(readManifestRuntimeDeps(dir), []);
  });
  it("filters out non-string entries in runtime array", (t) => {
    const dir = tmpDir("mixed-types", t);
    writeFileSync(join(dir, "extension-manifest.json"), JSON.stringify({
      dependencies: { runtime: [123, null, "node", false, "python"] }
    }), "utf-8");
    assert.deepEqual(readManifestRuntimeDeps(dir), ["node", "python"]);
  });
  it("returns empty array when no dependencies field at all", (t) => {
    const dir = tmpDir("no-deps-field", t);
    writeFileSync(join(dir, "extension-manifest.json"), JSON.stringify({
      id: "test",
      name: "Test"
    }), "utf-8");
    assert.deepEqual(readManifestRuntimeDeps(dir), []);
  });
});
describe("collectRuntimeDependencies", () => {
  it("aggregates deps from installedPath manifest", (t) => {
    const dir = tmpDir("collect-installed", t);
    writeFileSync(join(dir, "extension-manifest.json"), JSON.stringify({
      dependencies: { runtime: ["claude"] }
    }), "utf-8");
    assert.deepEqual(collectRuntimeDependencies(dir, []), ["claude"]);
  });
  it("aggregates deps from entry path directory manifests", (t) => {
    const root = tmpDir("collect-entry", t);
    const installedDir = join(root, "installed");
    const entryDir = join(root, "entry");
    mkdirSync(installedDir, { recursive: true });
    mkdirSync(entryDir, { recursive: true });
    writeFileSync(join(entryDir, "extension-manifest.json"), JSON.stringify({
      dependencies: { runtime: ["python"] }
    }), "utf-8");
    const deps = collectRuntimeDependencies(installedDir, [join(entryDir, "index.ts")]);
    assert.deepEqual(deps, ["python"]);
  });
  it("deduplicates across multiple directories", (t) => {
    const root = tmpDir("collect-dedup", t);
    const dir1 = join(root, "dir1");
    const dir2 = join(root, "dir2");
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir1, "extension-manifest.json"), JSON.stringify({
      dependencies: { runtime: ["node", "python"] }
    }), "utf-8");
    writeFileSync(join(dir2, "extension-manifest.json"), JSON.stringify({
      dependencies: { runtime: ["python", "claude"] }
    }), "utf-8");
    const deps = collectRuntimeDependencies(dir1, [join(dir2, "index.ts")]);
    assert.equal(deps.length, 3);
    assert.ok(deps.includes("node"));
    assert.ok(deps.includes("python"));
    assert.ok(deps.includes("claude"));
  });
  it("returns empty when no directories have manifests", (t) => {
    const dir = tmpDir("collect-empty", t);
    assert.deepEqual(collectRuntimeDependencies(dir, []), []);
  });
});
describe("verifyRuntimeDependencies", () => {
  it("does not throw for empty deps array", () => {
    assert.doesNotThrow(() => verifyRuntimeDependencies([], "test-source", "pi"));
  });
  it("does not throw when all deps are present", () => {
    assert.doesNotThrow(() => verifyRuntimeDependencies(["node"], "test-source", "pi"));
  });
  it("throws for missing dep with 'Missing runtime dependencies' message", () => {
    assert.throws(
      () => verifyRuntimeDependencies(["__nonexistent_dep_for_test__"], "test-source", "pi"),
      (err) => {
        assert.ok(err.message.includes("Missing runtime dependencies"));
        assert.ok(err.message.includes("__nonexistent_dep_for_test__"));
        return true;
      }
    );
  });
  it("lists all missing deps in error message", () => {
    assert.throws(
      () => verifyRuntimeDependencies(["__missing_1__", "__missing_2__"], "test-source", "pi"),
      (err) => {
        assert.ok(err.message.includes("__missing_1__"));
        assert.ok(err.message.includes("__missing_2__"));
        return true;
      }
    );
  });
  it("includes appName and source in error for retry hint", () => {
    assert.throws(
      () => verifyRuntimeDependencies(["__missing__"], "github:user/repo", "gsd"),
      (err) => {
        assert.ok(err.message.includes("gsd"));
        assert.ok(err.message.includes("github:user/repo"));
        return true;
      }
    );
  });
});
describe("resolveLocalSourcePath", () => {
  it("returns undefined for empty string", () => {
    assert.equal(resolveLocalSourcePath("", "/tmp"), void 0);
  });
  it("returns undefined for npm: source", () => {
    assert.equal(resolveLocalSourcePath("npm:@foo/bar", "/tmp"), void 0);
  });
  it("returns undefined for git URL", () => {
    assert.equal(resolveLocalSourcePath("git:github.com/user/repo", "/tmp"), void 0);
  });
  it("returns undefined for https git URL", () => {
    assert.equal(resolveLocalSourcePath("https://github.com/user/repo", "/tmp"), void 0);
  });
  it("resolves ~ to homedir", () => {
    const result = resolveLocalSourcePath("~", "/tmp");
    if (existsSync(homedir())) {
      assert.equal(result, homedir());
    } else {
      assert.equal(result, void 0);
    }
  });
  it("resolves ~/path relative to homedir", () => {
    const result = resolveLocalSourcePath("~/", "/tmp");
    if (existsSync(homedir())) {
      assert.equal(result, homedir());
    } else {
      assert.equal(result, void 0);
    }
  });
  it("resolves relative path that exists", (t) => {
    const dir = tmpDir("resolve-rel", t);
    const sub = join(dir, "myext");
    mkdirSync(sub, { recursive: true });
    const result = resolveLocalSourcePath("myext", dir);
    assert.equal(result, resolve(dir, "myext"));
  });
  it("returns undefined for relative path that does not exist", (t) => {
    const dir = tmpDir("resolve-noexist", t);
    assert.equal(resolveLocalSourcePath("nonexistent", dir), void 0);
  });
  it("resolves absolute path that exists", (t) => {
    const dir = tmpDir("resolve-abs", t);
    assert.equal(resolveLocalSourcePath(dir, "/irrelevant"), dir);
  });
  it("returns undefined for absolute path that does not exist", () => {
    assert.equal(resolveLocalSourcePath("/tmp/__nonexistent_path_for_test__", "/tmp"), void 0);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL2xpZmVjeWNsZS1ob29rcy50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBta2RpclN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYywgZXhpc3RzU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBob21lZGlyLCB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgam9pbiwgcmVzb2x2ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGRlc2NyaWJlLCBpdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCB7XG5cdHJlYWRNYW5pZmVzdFJ1bnRpbWVEZXBzLFxuXHRjb2xsZWN0UnVudGltZURlcGVuZGVuY2llcyxcblx0dmVyaWZ5UnVudGltZURlcGVuZGVuY2llcyxcblx0cmVzb2x2ZUxvY2FsU291cmNlUGF0aCxcbn0gZnJvbSBcIi4vbGlmZWN5Y2xlLWhvb2tzLmpzXCI7XG5cbmZ1bmN0aW9uIHRtcERpcihwcmVmaXg6IHN0cmluZywgdDogeyBhZnRlcjogKGZuOiAoKSA9PiB2b2lkKSA9PiB2b2lkIH0pOiBzdHJpbmcge1xuXHRjb25zdCBkaXIgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBgcGktbGgtJHtwcmVmaXh9LWApKTtcblx0dC5hZnRlcigoKSA9PiBybVN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpO1xuXHRyZXR1cm4gZGlyO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgcmVhZE1hbmlmZXN0UnVudGltZURlcHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwicmVhZE1hbmlmZXN0UnVudGltZURlcHNcIiwgKCkgPT4ge1xuXHRpdChcInJldHVybnMgZW1wdHkgYXJyYXkgd2hlbiBtYW5pZmVzdCBmaWxlIGlzIG1pc3NpbmdcIiwgKHQpID0+IHtcblx0XHRjb25zdCBkaXIgPSB0bXBEaXIoXCJuby1tYW5pZmVzdFwiLCB0KTtcblx0XHRhc3NlcnQuZGVlcEVxdWFsKHJlYWRNYW5pZmVzdFJ1bnRpbWVEZXBzKGRpciksIFtdKTtcblx0fSk7XG5cblx0aXQoXCJyZXR1cm5zIGVtcHR5IGFycmF5IGZvciBtYWxmb3JtZWQgSlNPTlwiLCAodCkgPT4ge1xuXHRcdGNvbnN0IGRpciA9IHRtcERpcihcImJhZC1qc29uXCIsIHQpO1xuXHRcdHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiZXh0ZW5zaW9uLW1hbmlmZXN0Lmpzb25cIiksIFwibm90IGpzb257e3tcIiwgXCJ1dGYtOFwiKTtcblx0XHRhc3NlcnQuZGVlcEVxdWFsKHJlYWRNYW5pZmVzdFJ1bnRpbWVEZXBzKGRpciksIFtdKTtcblx0fSk7XG5cblx0aXQoXCJyZXR1cm5zIHJ1bnRpbWUgZGVwcyBmcm9tIHZhbGlkIG1hbmlmZXN0XCIsICh0KSA9PiB7XG5cdFx0Y29uc3QgZGlyID0gdG1wRGlyKFwidmFsaWRcIiwgdCk7XG5cdFx0d3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJleHRlbnNpb24tbWFuaWZlc3QuanNvblwiKSwgSlNPTi5zdHJpbmdpZnkoe1xuXHRcdFx0ZGVwZW5kZW5jaWVzOiB7IHJ1bnRpbWU6IFtcImNsYXVkZVwiLCBcIm5vZGVcIl0gfSxcblx0XHR9KSwgXCJ1dGYtOFwiKTtcblx0XHRhc3NlcnQuZGVlcEVxdWFsKHJlYWRNYW5pZmVzdFJ1bnRpbWVEZXBzKGRpciksIFtcImNsYXVkZVwiLCBcIm5vZGVcIl0pO1xuXHR9KTtcblxuXHRpdChcInJldHVybnMgZW1wdHkgYXJyYXkgd2hlbiBkZXBlbmRlbmNpZXMgZXhpc3RzIGJ1dCBydW50aW1lIGlzIG1pc3NpbmdcIiwgKHQpID0+IHtcblx0XHRjb25zdCBkaXIgPSB0bXBEaXIoXCJuby1ydW50aW1lXCIsIHQpO1xuXHRcdHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiZXh0ZW5zaW9uLW1hbmlmZXN0Lmpzb25cIiksIEpTT04uc3RyaW5naWZ5KHtcblx0XHRcdGRlcGVuZGVuY2llczoge30sXG5cdFx0fSksIFwidXRmLThcIik7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChyZWFkTWFuaWZlc3RSdW50aW1lRGVwcyhkaXIpLCBbXSk7XG5cdH0pO1xuXG5cdGl0KFwicmV0dXJucyBlbXB0eSBhcnJheSB3aGVuIHJ1bnRpbWUgaXMgZW1wdHlcIiwgKHQpID0+IHtcblx0XHRjb25zdCBkaXIgPSB0bXBEaXIoXCJlbXB0eS1ydW50aW1lXCIsIHQpO1xuXHRcdHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiZXh0ZW5zaW9uLW1hbmlmZXN0Lmpzb25cIiksIEpTT04uc3RyaW5naWZ5KHtcblx0XHRcdGRlcGVuZGVuY2llczogeyBydW50aW1lOiBbXSB9LFxuXHRcdH0pLCBcInV0Zi04XCIpO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwocmVhZE1hbmlmZXN0UnVudGltZURlcHMoZGlyKSwgW10pO1xuXHR9KTtcblxuXHRpdChcImZpbHRlcnMgb3V0IG5vbi1zdHJpbmcgZW50cmllcyBpbiBydW50aW1lIGFycmF5XCIsICh0KSA9PiB7XG5cdFx0Y29uc3QgZGlyID0gdG1wRGlyKFwibWl4ZWQtdHlwZXNcIiwgdCk7XG5cdFx0d3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJleHRlbnNpb24tbWFuaWZlc3QuanNvblwiKSwgSlNPTi5zdHJpbmdpZnkoe1xuXHRcdFx0ZGVwZW5kZW5jaWVzOiB7IHJ1bnRpbWU6IFsxMjMsIG51bGwsIFwibm9kZVwiLCBmYWxzZSwgXCJweXRob25cIl0gfSxcblx0XHR9KSwgXCJ1dGYtOFwiKTtcblx0XHRhc3NlcnQuZGVlcEVxdWFsKHJlYWRNYW5pZmVzdFJ1bnRpbWVEZXBzKGRpciksIFtcIm5vZGVcIiwgXCJweXRob25cIl0pO1xuXHR9KTtcblxuXHRpdChcInJldHVybnMgZW1wdHkgYXJyYXkgd2hlbiBubyBkZXBlbmRlbmNpZXMgZmllbGQgYXQgYWxsXCIsICh0KSA9PiB7XG5cdFx0Y29uc3QgZGlyID0gdG1wRGlyKFwibm8tZGVwcy1maWVsZFwiLCB0KTtcblx0XHR3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcImV4dGVuc2lvbi1tYW5pZmVzdC5qc29uXCIpLCBKU09OLnN0cmluZ2lmeSh7XG5cdFx0XHRpZDogXCJ0ZXN0XCIsXG5cdFx0XHRuYW1lOiBcIlRlc3RcIixcblx0XHR9KSwgXCJ1dGYtOFwiKTtcblx0XHRhc3NlcnQuZGVlcEVxdWFsKHJlYWRNYW5pZmVzdFJ1bnRpbWVEZXBzKGRpciksIFtdKTtcblx0fSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGNvbGxlY3RSdW50aW1lRGVwZW5kZW5jaWVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcImNvbGxlY3RSdW50aW1lRGVwZW5kZW5jaWVzXCIsICgpID0+IHtcblx0aXQoXCJhZ2dyZWdhdGVzIGRlcHMgZnJvbSBpbnN0YWxsZWRQYXRoIG1hbmlmZXN0XCIsICh0KSA9PiB7XG5cdFx0Y29uc3QgZGlyID0gdG1wRGlyKFwiY29sbGVjdC1pbnN0YWxsZWRcIiwgdCk7XG5cdFx0d3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJleHRlbnNpb24tbWFuaWZlc3QuanNvblwiKSwgSlNPTi5zdHJpbmdpZnkoe1xuXHRcdFx0ZGVwZW5kZW5jaWVzOiB7IHJ1bnRpbWU6IFtcImNsYXVkZVwiXSB9LFxuXHRcdH0pLCBcInV0Zi04XCIpO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwoY29sbGVjdFJ1bnRpbWVEZXBlbmRlbmNpZXMoZGlyLCBbXSksIFtcImNsYXVkZVwiXSk7XG5cdH0pO1xuXG5cdGl0KFwiYWdncmVnYXRlcyBkZXBzIGZyb20gZW50cnkgcGF0aCBkaXJlY3RvcnkgbWFuaWZlc3RzXCIsICh0KSA9PiB7XG5cdFx0Y29uc3Qgcm9vdCA9IHRtcERpcihcImNvbGxlY3QtZW50cnlcIiwgdCk7XG5cdFx0Y29uc3QgaW5zdGFsbGVkRGlyID0gam9pbihyb290LCBcImluc3RhbGxlZFwiKTtcblx0XHRjb25zdCBlbnRyeURpciA9IGpvaW4ocm9vdCwgXCJlbnRyeVwiKTtcblx0XHRta2RpclN5bmMoaW5zdGFsbGVkRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblx0XHRta2RpclN5bmMoZW50cnlEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXHRcdHdyaXRlRmlsZVN5bmMoam9pbihlbnRyeURpciwgXCJleHRlbnNpb24tbWFuaWZlc3QuanNvblwiKSwgSlNPTi5zdHJpbmdpZnkoe1xuXHRcdFx0ZGVwZW5kZW5jaWVzOiB7IHJ1bnRpbWU6IFtcInB5dGhvblwiXSB9LFxuXHRcdH0pLCBcInV0Zi04XCIpO1xuXHRcdGNvbnN0IGRlcHMgPSBjb2xsZWN0UnVudGltZURlcGVuZGVuY2llcyhpbnN0YWxsZWREaXIsIFtqb2luKGVudHJ5RGlyLCBcImluZGV4LnRzXCIpXSk7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChkZXBzLCBbXCJweXRob25cIl0pO1xuXHR9KTtcblxuXHRpdChcImRlZHVwbGljYXRlcyBhY3Jvc3MgbXVsdGlwbGUgZGlyZWN0b3JpZXNcIiwgKHQpID0+IHtcblx0XHRjb25zdCByb290ID0gdG1wRGlyKFwiY29sbGVjdC1kZWR1cFwiLCB0KTtcblx0XHRjb25zdCBkaXIxID0gam9pbihyb290LCBcImRpcjFcIik7XG5cdFx0Y29uc3QgZGlyMiA9IGpvaW4ocm9vdCwgXCJkaXIyXCIpO1xuXHRcdG1rZGlyU3luYyhkaXIxLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblx0XHRta2RpclN5bmMoZGlyMiwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cdFx0d3JpdGVGaWxlU3luYyhqb2luKGRpcjEsIFwiZXh0ZW5zaW9uLW1hbmlmZXN0Lmpzb25cIiksIEpTT04uc3RyaW5naWZ5KHtcblx0XHRcdGRlcGVuZGVuY2llczogeyBydW50aW1lOiBbXCJub2RlXCIsIFwicHl0aG9uXCJdIH0sXG5cdFx0fSksIFwidXRmLThcIik7XG5cdFx0d3JpdGVGaWxlU3luYyhqb2luKGRpcjIsIFwiZXh0ZW5zaW9uLW1hbmlmZXN0Lmpzb25cIiksIEpTT04uc3RyaW5naWZ5KHtcblx0XHRcdGRlcGVuZGVuY2llczogeyBydW50aW1lOiBbXCJweXRob25cIiwgXCJjbGF1ZGVcIl0gfSxcblx0XHR9KSwgXCJ1dGYtOFwiKTtcblx0XHRjb25zdCBkZXBzID0gY29sbGVjdFJ1bnRpbWVEZXBlbmRlbmNpZXMoZGlyMSwgW2pvaW4oZGlyMiwgXCJpbmRleC50c1wiKV0pO1xuXHRcdGFzc2VydC5lcXVhbChkZXBzLmxlbmd0aCwgMyk7XG5cdFx0YXNzZXJ0Lm9rKGRlcHMuaW5jbHVkZXMoXCJub2RlXCIpKTtcblx0XHRhc3NlcnQub2soZGVwcy5pbmNsdWRlcyhcInB5dGhvblwiKSk7XG5cdFx0YXNzZXJ0Lm9rKGRlcHMuaW5jbHVkZXMoXCJjbGF1ZGVcIikpO1xuXHR9KTtcblxuXHRpdChcInJldHVybnMgZW1wdHkgd2hlbiBubyBkaXJlY3RvcmllcyBoYXZlIG1hbmlmZXN0c1wiLCAodCkgPT4ge1xuXHRcdGNvbnN0IGRpciA9IHRtcERpcihcImNvbGxlY3QtZW1wdHlcIiwgdCk7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChjb2xsZWN0UnVudGltZURlcGVuZGVuY2llcyhkaXIsIFtdKSwgW10pO1xuXHR9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgdmVyaWZ5UnVudGltZURlcGVuZGVuY2llcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJ2ZXJpZnlSdW50aW1lRGVwZW5kZW5jaWVzXCIsICgpID0+IHtcblx0aXQoXCJkb2VzIG5vdCB0aHJvdyBmb3IgZW1wdHkgZGVwcyBhcnJheVwiLCAoKSA9PiB7XG5cdFx0YXNzZXJ0LmRvZXNOb3RUaHJvdygoKSA9PiB2ZXJpZnlSdW50aW1lRGVwZW5kZW5jaWVzKFtdLCBcInRlc3Qtc291cmNlXCIsIFwicGlcIikpO1xuXHR9KTtcblxuXHRpdChcImRvZXMgbm90IHRocm93IHdoZW4gYWxsIGRlcHMgYXJlIHByZXNlbnRcIiwgKCkgPT4ge1xuXHRcdGFzc2VydC5kb2VzTm90VGhyb3coKCkgPT4gdmVyaWZ5UnVudGltZURlcGVuZGVuY2llcyhbXCJub2RlXCJdLCBcInRlc3Qtc291cmNlXCIsIFwicGlcIikpO1xuXHR9KTtcblxuXHRpdChcInRocm93cyBmb3IgbWlzc2luZyBkZXAgd2l0aCAnTWlzc2luZyBydW50aW1lIGRlcGVuZGVuY2llcycgbWVzc2FnZVwiLCAoKSA9PiB7XG5cdFx0YXNzZXJ0LnRocm93cyhcblx0XHRcdCgpID0+IHZlcmlmeVJ1bnRpbWVEZXBlbmRlbmNpZXMoW1wiX19ub25leGlzdGVudF9kZXBfZm9yX3Rlc3RfX1wiXSwgXCJ0ZXN0LXNvdXJjZVwiLCBcInBpXCIpLFxuXHRcdFx0KGVycjogRXJyb3IpID0+IHtcblx0XHRcdFx0YXNzZXJ0Lm9rKGVyci5tZXNzYWdlLmluY2x1ZGVzKFwiTWlzc2luZyBydW50aW1lIGRlcGVuZGVuY2llc1wiKSk7XG5cdFx0XHRcdGFzc2VydC5vayhlcnIubWVzc2FnZS5pbmNsdWRlcyhcIl9fbm9uZXhpc3RlbnRfZGVwX2Zvcl90ZXN0X19cIikpO1xuXHRcdFx0XHRyZXR1cm4gdHJ1ZTtcblx0XHRcdH0sXG5cdFx0KTtcblx0fSk7XG5cblx0aXQoXCJsaXN0cyBhbGwgbWlzc2luZyBkZXBzIGluIGVycm9yIG1lc3NhZ2VcIiwgKCkgPT4ge1xuXHRcdGFzc2VydC50aHJvd3MoXG5cdFx0XHQoKSA9PiB2ZXJpZnlSdW50aW1lRGVwZW5kZW5jaWVzKFtcIl9fbWlzc2luZ18xX19cIiwgXCJfX21pc3NpbmdfMl9fXCJdLCBcInRlc3Qtc291cmNlXCIsIFwicGlcIiksXG5cdFx0XHQoZXJyOiBFcnJvcikgPT4ge1xuXHRcdFx0XHRhc3NlcnQub2soZXJyLm1lc3NhZ2UuaW5jbHVkZXMoXCJfX21pc3NpbmdfMV9fXCIpKTtcblx0XHRcdFx0YXNzZXJ0Lm9rKGVyci5tZXNzYWdlLmluY2x1ZGVzKFwiX19taXNzaW5nXzJfX1wiKSk7XG5cdFx0XHRcdHJldHVybiB0cnVlO1xuXHRcdFx0fSxcblx0XHQpO1xuXHR9KTtcblxuXHRpdChcImluY2x1ZGVzIGFwcE5hbWUgYW5kIHNvdXJjZSBpbiBlcnJvciBmb3IgcmV0cnkgaGludFwiLCAoKSA9PiB7XG5cdFx0YXNzZXJ0LnRocm93cyhcblx0XHRcdCgpID0+IHZlcmlmeVJ1bnRpbWVEZXBlbmRlbmNpZXMoW1wiX19taXNzaW5nX19cIl0sIFwiZ2l0aHViOnVzZXIvcmVwb1wiLCBcImdzZFwiKSxcblx0XHRcdChlcnI6IEVycm9yKSA9PiB7XG5cdFx0XHRcdGFzc2VydC5vayhlcnIubWVzc2FnZS5pbmNsdWRlcyhcImdzZFwiKSk7XG5cdFx0XHRcdGFzc2VydC5vayhlcnIubWVzc2FnZS5pbmNsdWRlcyhcImdpdGh1Yjp1c2VyL3JlcG9cIikpO1xuXHRcdFx0XHRyZXR1cm4gdHJ1ZTtcblx0XHRcdH0sXG5cdFx0KTtcblx0fSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHJlc29sdmVMb2NhbFNvdXJjZVBhdGggXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwicmVzb2x2ZUxvY2FsU291cmNlUGF0aFwiLCAoKSA9PiB7XG5cdGl0KFwicmV0dXJucyB1bmRlZmluZWQgZm9yIGVtcHR5IHN0cmluZ1wiLCAoKSA9PiB7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc29sdmVMb2NhbFNvdXJjZVBhdGgoXCJcIiwgXCIvdG1wXCIpLCB1bmRlZmluZWQpO1xuXHR9KTtcblxuXHRpdChcInJldHVybnMgdW5kZWZpbmVkIGZvciBucG06IHNvdXJjZVwiLCAoKSA9PiB7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc29sdmVMb2NhbFNvdXJjZVBhdGgoXCJucG06QGZvby9iYXJcIiwgXCIvdG1wXCIpLCB1bmRlZmluZWQpO1xuXHR9KTtcblxuXHRpdChcInJldHVybnMgdW5kZWZpbmVkIGZvciBnaXQgVVJMXCIsICgpID0+IHtcblx0XHRhc3NlcnQuZXF1YWwocmVzb2x2ZUxvY2FsU291cmNlUGF0aChcImdpdDpnaXRodWIuY29tL3VzZXIvcmVwb1wiLCBcIi90bXBcIiksIHVuZGVmaW5lZCk7XG5cdH0pO1xuXG5cdGl0KFwicmV0dXJucyB1bmRlZmluZWQgZm9yIGh0dHBzIGdpdCBVUkxcIiwgKCkgPT4ge1xuXHRcdGFzc2VydC5lcXVhbChyZXNvbHZlTG9jYWxTb3VyY2VQYXRoKFwiaHR0cHM6Ly9naXRodWIuY29tL3VzZXIvcmVwb1wiLCBcIi90bXBcIiksIHVuZGVmaW5lZCk7XG5cdH0pO1xuXG5cdGl0KFwicmVzb2x2ZXMgfiB0byBob21lZGlyXCIsICgpID0+IHtcblx0XHRjb25zdCByZXN1bHQgPSByZXNvbHZlTG9jYWxTb3VyY2VQYXRoKFwiflwiLCBcIi90bXBcIik7XG5cdFx0aWYgKGV4aXN0c1N5bmMoaG9tZWRpcigpKSkge1xuXHRcdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdCwgaG9tZWRpcigpKTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdCwgdW5kZWZpbmVkKTtcblx0XHR9XG5cdH0pO1xuXG5cdGl0KFwicmVzb2x2ZXMgfi9wYXRoIHJlbGF0aXZlIHRvIGhvbWVkaXJcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlc3VsdCA9IHJlc29sdmVMb2NhbFNvdXJjZVBhdGgoXCJ+L1wiLCBcIi90bXBcIik7XG5cdFx0aWYgKGV4aXN0c1N5bmMoaG9tZWRpcigpKSkge1xuXHRcdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdCwgaG9tZWRpcigpKTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdCwgdW5kZWZpbmVkKTtcblx0XHR9XG5cdH0pO1xuXG5cdGl0KFwicmVzb2x2ZXMgcmVsYXRpdmUgcGF0aCB0aGF0IGV4aXN0c1wiLCAodCkgPT4ge1xuXHRcdGNvbnN0IGRpciA9IHRtcERpcihcInJlc29sdmUtcmVsXCIsIHQpO1xuXHRcdGNvbnN0IHN1YiA9IGpvaW4oZGlyLCBcIm15ZXh0XCIpO1xuXHRcdG1rZGlyU3luYyhzdWIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXHRcdGNvbnN0IHJlc3VsdCA9IHJlc29sdmVMb2NhbFNvdXJjZVBhdGgoXCJteWV4dFwiLCBkaXIpO1xuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQsIHJlc29sdmUoZGlyLCBcIm15ZXh0XCIpKTtcblx0fSk7XG5cblx0aXQoXCJyZXR1cm5zIHVuZGVmaW5lZCBmb3IgcmVsYXRpdmUgcGF0aCB0aGF0IGRvZXMgbm90IGV4aXN0XCIsICh0KSA9PiB7XG5cdFx0Y29uc3QgZGlyID0gdG1wRGlyKFwicmVzb2x2ZS1ub2V4aXN0XCIsIHQpO1xuXHRcdGFzc2VydC5lcXVhbChyZXNvbHZlTG9jYWxTb3VyY2VQYXRoKFwibm9uZXhpc3RlbnRcIiwgZGlyKSwgdW5kZWZpbmVkKTtcblx0fSk7XG5cblx0aXQoXCJyZXNvbHZlcyBhYnNvbHV0ZSBwYXRoIHRoYXQgZXhpc3RzXCIsICh0KSA9PiB7XG5cdFx0Y29uc3QgZGlyID0gdG1wRGlyKFwicmVzb2x2ZS1hYnNcIiwgdCk7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc29sdmVMb2NhbFNvdXJjZVBhdGgoZGlyLCBcIi9pcnJlbGV2YW50XCIpLCBkaXIpO1xuXHR9KTtcblxuXHRpdChcInJldHVybnMgdW5kZWZpbmVkIGZvciBhYnNvbHV0ZSBwYXRoIHRoYXQgZG9lcyBub3QgZXhpc3RcIiwgKCkgPT4ge1xuXHRcdGFzc2VydC5lcXVhbChyZXNvbHZlTG9jYWxTb3VyY2VQYXRoKFwiL3RtcC9fX25vbmV4aXN0ZW50X3BhdGhf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
