import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require2 = createRequire(import.meta.url);
function findRepoRoot(start) {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate repo root (no .git found) from ${start}`);
}
const projectRoot = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
const manifestModulePath = join(projectRoot, "scripts", "lib", "workspace-manifest.cjs");
const verifyScriptPath = join(projectRoot, "scripts", "verify-workspace-coverage.cjs");
describe("workspace manifest (live project)", () => {
  test("returns all eight linkable packages with consistent scope/name", () => {
    const manifest = require2(manifestModulePath);
    const packages = manifest.getLinkablePackages();
    assert.equal(packages.length, 8, "expected exactly 8 linkable packages");
    const names = packages.map((p) => p.packageName).sort();
    assert.deepEqual(names, [
      "@gsd-build/contracts",
      "@gsd-build/mcp-server",
      "@gsd-build/rpc-client",
      "@gsd/native",
      "@gsd/pi-agent-core",
      "@gsd/pi-ai",
      "@gsd/pi-coding-agent",
      "@gsd/pi-tui"
    ]);
    for (const pkg of packages) {
      assert.equal(
        pkg.packageName,
        `${pkg.scope}/${pkg.name}`,
        `${pkg.packageName}: gsd.scope/gsd.name mismatch`
      );
    }
  });
  test("getCorePackages returns only @gsd scope entries", () => {
    const manifest = require2(manifestModulePath);
    const core = manifest.getCorePackages();
    assert.ok(core.length >= 1);
    for (const pkg of core) {
      assert.equal(pkg.scope, "@gsd", `${pkg.packageName} should be @gsd scope`);
    }
  });
  test("every linkable package's package.json 'name' matches its gsd.scope/gsd.name", () => {
    const manifest = require2(manifestModulePath);
    for (const pkg of manifest.getLinkablePackages()) {
      const pkgJson = JSON.parse(readFileSync(pkg.packageJsonPath, "utf8"));
      assert.equal(
        pkgJson.name,
        `${pkg.scope}/${pkg.name}`,
        `${pkg.packageJsonPath}: name != gsd.scope/gsd.name`
      );
    }
  });
});
describe("verify-workspace-coverage CI gate", () => {
  test("passes on the live project (every linkable package has tests)", () => {
    const out = execFileSync(process.execPath, [verifyScriptPath], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"]
    });
    assert.ok(out !== void 0);
  });
  describe("against synthetic workspace fixtures", () => {
    let tmp;
    let fakePackages;
    let fakeManifest;
    let fakeVerify;
    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), "gsd-verify-coverage-"));
      fakePackages = join(tmp, "packages");
      mkdirSync(fakePackages, { recursive: true });
      const scriptsDir = join(tmp, "scripts");
      const scriptsLibDir = join(scriptsDir, "lib");
      mkdirSync(scriptsLibDir, { recursive: true });
      writeFileSync(
        join(scriptsLibDir, "workspace-manifest.cjs"),
        readFileSync(manifestModulePath, "utf8")
      );
      writeFileSync(
        join(scriptsDir, "verify-workspace-coverage.cjs"),
        readFileSync(verifyScriptPath, "utf8")
      );
      fakeManifest = join(scriptsLibDir, "workspace-manifest.cjs");
      fakeVerify = join(scriptsDir, "verify-workspace-coverage.cjs");
    });
    afterEach(() => {
      rmSync(tmp, { recursive: true, force: true });
    });
    function writePackage(dir, pkgJson, extraFiles = {}) {
      const pkgPath = join(fakePackages, dir);
      mkdirSync(pkgPath, { recursive: true });
      writeFileSync(join(pkgPath, "package.json"), JSON.stringify(pkgJson, null, 2));
      for (const [rel, content] of Object.entries(extraFiles)) {
        const full = join(pkgPath, rel);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
      }
    }
    test("FAILS when a linkable package has zero test files", () => {
      writePackage("pkg-a", {
        name: "@gsd/pkg-a",
        version: "1.0.0",
        gsd: { linkable: true, scope: "@gsd", name: "pkg-a" }
      }, {
        "src/index.ts": "export const x = 1;"
      });
      let threw = false;
      let stderr = "";
      try {
        execFileSync(process.execPath, [fakeVerify], {
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"]
        });
      } catch (err) {
        threw = true;
        stderr = err.stderr ?? "";
      }
      assert.ok(threw, "expected verify-workspace-coverage to exit non-zero");
      assert.match(stderr, /no \*\.test\./);
      assert.match(stderr, /pkg-a/);
    });
    test("PASSES when every linkable package has at least one test file", () => {
      writePackage("pkg-a", {
        name: "@gsd/pkg-a",
        version: "1.0.0",
        gsd: { linkable: true, scope: "@gsd", name: "pkg-a" }
      }, {
        "src/index.ts": "export const x = 1;",
        "src/index.test.ts": "import test from 'node:test'; test('ok', () => {});"
      });
      writePackage("pkg-b", {
        name: "@gsd-build/pkg-b",
        version: "1.0.0",
        gsd: { linkable: true, scope: "@gsd-build", name: "pkg-b" }
      }, {
        "src/thing.test.js": ""
      });
      const out = execFileSync(process.execPath, [fakeVerify], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"]
      });
      assert.ok(out !== void 0);
    });
    test("IGNORES non-linkable packages even if they have no tests", () => {
      writePackage("internal-pkg", {
        name: "@gsd-build/internal-pkg",
        version: "1.0.0"
        // Intentionally no gsd.linkable — this package should be skipped entirely.
      }, {
        "src/index.ts": "export const x = 1;"
      });
      const out = execFileSync(process.execPath, [fakeVerify], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"]
      });
      assert.ok(out !== void 0);
    });
    test("FAILS when package.json 'name' disagrees with gsd.scope/gsd.name", () => {
      writePackage("pkg-bad", {
        name: "@gsd/wrong-name",
        version: "1.0.0",
        gsd: { linkable: true, scope: "@gsd", name: "pkg-bad" }
      }, {
        "src/x.test.ts": ""
      });
      let threw = false;
      let stderr = "";
      try {
        execFileSync(process.execPath, [fakeVerify], {
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"]
        });
      } catch (err) {
        threw = true;
        stderr = err.stderr ?? "";
      }
      assert.ok(threw, "expected exit non-zero for name mismatch");
      assert.ok(
        /name.*gsd\.scope\/gsd\.name|gsd\.scope\/gsd\.name.*name/i.test(stderr),
        `expected stderr to explain name mismatch. got: ${stderr}`
      );
      assert.ok(fakeManifest.length > 0);
    });
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3Rlc3RzL3dvcmtzcGFjZS1tYW5pZmVzdC50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBHU0QtMiArIHNyYy90ZXN0cy93b3Jrc3BhY2UtbWFuaWZlc3QudGVzdC50cyBcdTIwMTQgcmVncmVzc2lvbiB0ZXN0cyBmb3IgdGhlIGxpbmthYmxlLXBhY2thZ2VzIHNpbmdsZSBzb3VyY2Ugb2YgdHJ1dGhcbmltcG9ydCB7IGRlc2NyaWJlLCB0ZXN0LCBiZWZvcmVFYWNoLCBhZnRlckVhY2ggfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IGV4ZWNGaWxlU3luYyB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMsIG1rZGlyU3luYywgbWtkdGVtcFN5bmMsIHJlYWRGaWxlU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBqb2luLCBkaXJuYW1lLCByZXNvbHZlIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gXCJub2RlOnVybFwiO1xuaW1wb3J0IHsgY3JlYXRlUmVxdWlyZSB9IGZyb20gXCJub2RlOm1vZHVsZVwiO1xuXG5jb25zdCByZXF1aXJlID0gY3JlYXRlUmVxdWlyZShpbXBvcnQubWV0YS51cmwpO1xuXG4vLyBXYWxrIHVwIGZyb20gdGhpcyBmaWxlJ3MgZGlyZWN0b3J5IHRvIHRoZSByZWFsIHJlcG8gcm9vdC4gQ2FuJ3Qgc3RvcCBhdCB0aGUgZmlyc3QgcGFja2FnZS5qc29uXG4vLyB3aXRoIGEgXCJ3b3Jrc3BhY2VzXCIgZmllbGQgYmVjYXVzZSBjb21waWxlLXRlc3RzLm1qcyBtaXJyb3JzIHBhY2thZ2UuanNvbiArIHBhY2thZ2VzLyBpbnRvXG4vLyBkaXN0LXRlc3QvLCB3aGljaCB3b3VsZCBtYXNxdWVyYWRlIGFzIGEgcmVwbyByb290LiAuZ2l0LyBpcyB0aGUgb25seSByZWxpYWJsZSBkaXNjcmltaW5hdG9yLlxuZnVuY3Rpb24gZmluZFJlcG9Sb290KHN0YXJ0OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRsZXQgZGlyID0gc3RhcnQ7XG5cdGZvciAobGV0IGkgPSAwOyBpIDwgMTA7IGkrKykge1xuXHRcdGlmIChleGlzdHNTeW5jKGpvaW4oZGlyLCBcIi5naXRcIikpKSByZXR1cm4gZGlyO1xuXHRcdGNvbnN0IHBhcmVudCA9IHJlc29sdmUoZGlyLCBcIi4uXCIpO1xuXHRcdGlmIChwYXJlbnQgPT09IGRpcikgYnJlYWs7XG5cdFx0ZGlyID0gcGFyZW50O1xuXHR9XG5cdHRocm93IG5ldyBFcnJvcihgQ291bGQgbm90IGxvY2F0ZSByZXBvIHJvb3QgKG5vIC5naXQgZm91bmQpIGZyb20gJHtzdGFydH1gKTtcbn1cblxuY29uc3QgcHJvamVjdFJvb3QgPSBmaW5kUmVwb1Jvb3QoZGlybmFtZShmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpKTtcbmNvbnN0IG1hbmlmZXN0TW9kdWxlUGF0aCA9IGpvaW4ocHJvamVjdFJvb3QsIFwic2NyaXB0c1wiLCBcImxpYlwiLCBcIndvcmtzcGFjZS1tYW5pZmVzdC5janNcIik7XG5jb25zdCB2ZXJpZnlTY3JpcHRQYXRoID0gam9pbihwcm9qZWN0Um9vdCwgXCJzY3JpcHRzXCIsIFwidmVyaWZ5LXdvcmtzcGFjZS1jb3ZlcmFnZS5janNcIik7XG5cbmRlc2NyaWJlKFwid29ya3NwYWNlIG1hbmlmZXN0IChsaXZlIHByb2plY3QpXCIsICgpID0+IHtcblx0dGVzdChcInJldHVybnMgYWxsIGVpZ2h0IGxpbmthYmxlIHBhY2thZ2VzIHdpdGggY29uc2lzdGVudCBzY29wZS9uYW1lXCIsICgpID0+IHtcblx0XHRjb25zdCBtYW5pZmVzdCA9IHJlcXVpcmUobWFuaWZlc3RNb2R1bGVQYXRoKTtcblx0XHRjb25zdCBwYWNrYWdlcyA9IG1hbmlmZXN0LmdldExpbmthYmxlUGFja2FnZXMoKTtcblx0XHRhc3NlcnQuZXF1YWwocGFja2FnZXMubGVuZ3RoLCA4LCBcImV4cGVjdGVkIGV4YWN0bHkgOCBsaW5rYWJsZSBwYWNrYWdlc1wiKTtcblxuXHRcdGNvbnN0IG5hbWVzID0gcGFja2FnZXMubWFwKChwOiB7IHBhY2thZ2VOYW1lOiBzdHJpbmcgfSkgPT4gcC5wYWNrYWdlTmFtZSkuc29ydCgpO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwobmFtZXMsIFtcblx0XHRcdFwiQGdzZC1idWlsZC9jb250cmFjdHNcIixcblx0XHRcdFwiQGdzZC1idWlsZC9tY3Atc2VydmVyXCIsXG5cdFx0XHRcIkBnc2QtYnVpbGQvcnBjLWNsaWVudFwiLFxuXHRcdFx0XCJAZ3NkL25hdGl2ZVwiLFxuXHRcdFx0XCJAZ3NkL3BpLWFnZW50LWNvcmVcIixcblx0XHRcdFwiQGdzZC9waS1haVwiLFxuXHRcdFx0XCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiLFxuXHRcdFx0XCJAZ3NkL3BpLXR1aVwiLFxuXHRcdF0pO1xuXG5cdFx0Zm9yIChjb25zdCBwa2cgb2YgcGFja2FnZXMpIHtcblx0XHRcdGFzc2VydC5lcXVhbChwa2cucGFja2FnZU5hbWUsIGAke3BrZy5zY29wZX0vJHtwa2cubmFtZX1gLFxuXHRcdFx0XHRgJHtwa2cucGFja2FnZU5hbWV9OiBnc2Quc2NvcGUvZ3NkLm5hbWUgbWlzbWF0Y2hgKTtcblx0XHR9XG5cdH0pO1xuXG5cdHRlc3QoXCJnZXRDb3JlUGFja2FnZXMgcmV0dXJucyBvbmx5IEBnc2Qgc2NvcGUgZW50cmllc1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgbWFuaWZlc3QgPSByZXF1aXJlKG1hbmlmZXN0TW9kdWxlUGF0aCk7XG5cdFx0Y29uc3QgY29yZSA9IG1hbmlmZXN0LmdldENvcmVQYWNrYWdlcygpO1xuXHRcdGFzc2VydC5vayhjb3JlLmxlbmd0aCA+PSAxKTtcblx0XHRmb3IgKGNvbnN0IHBrZyBvZiBjb3JlKSB7XG5cdFx0XHRhc3NlcnQuZXF1YWwocGtnLnNjb3BlLCBcIkBnc2RcIiwgYCR7cGtnLnBhY2thZ2VOYW1lfSBzaG91bGQgYmUgQGdzZCBzY29wZWApO1xuXHRcdH1cblx0fSk7XG5cblx0dGVzdChcImV2ZXJ5IGxpbmthYmxlIHBhY2thZ2UncyBwYWNrYWdlLmpzb24gJ25hbWUnIG1hdGNoZXMgaXRzIGdzZC5zY29wZS9nc2QubmFtZVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgbWFuaWZlc3QgPSByZXF1aXJlKG1hbmlmZXN0TW9kdWxlUGF0aCk7XG5cdFx0Zm9yIChjb25zdCBwa2cgb2YgbWFuaWZlc3QuZ2V0TGlua2FibGVQYWNrYWdlcygpKSB7XG5cdFx0XHRjb25zdCBwa2dKc29uID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocGtnLnBhY2thZ2VKc29uUGF0aCwgXCJ1dGY4XCIpKTtcblx0XHRcdGFzc2VydC5lcXVhbChwa2dKc29uLm5hbWUsIGAke3BrZy5zY29wZX0vJHtwa2cubmFtZX1gLFxuXHRcdFx0XHRgJHtwa2cucGFja2FnZUpzb25QYXRofTogbmFtZSAhPSBnc2Quc2NvcGUvZ3NkLm5hbWVgKTtcblx0XHR9XG5cdH0pO1xufSk7XG5cbmRlc2NyaWJlKFwidmVyaWZ5LXdvcmtzcGFjZS1jb3ZlcmFnZSBDSSBnYXRlXCIsICgpID0+IHtcblx0dGVzdChcInBhc3NlcyBvbiB0aGUgbGl2ZSBwcm9qZWN0IChldmVyeSBsaW5rYWJsZSBwYWNrYWdlIGhhcyB0ZXN0cylcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IG91dCA9IGV4ZWNGaWxlU3luYyhwcm9jZXNzLmV4ZWNQYXRoLCBbdmVyaWZ5U2NyaXB0UGF0aF0sIHtcblx0XHRcdGVuY29kaW5nOiBcInV0ZjhcIixcblx0XHRcdHN0ZGlvOiBbXCJwaXBlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0sXG5cdFx0fSk7XG5cdFx0Ly8gU2NyaXB0IHdyaXRlcyB0byBzdGRlcnIgb24gc3VjY2VzcyAoXCJBbGwgTiBsaW5rYWJsZSBwYWNrYWdlcyBoYXZlIHRlc3QgY292ZXJhZ2UuXCIpO1xuXHRcdC8vIGV4ZWNGaWxlU3luYyByZXR1cm5zIHN0ZG91dCBvbmx5LiBBcyBsb25nIGFzIGl0IGRpZG4ndCB0aHJvdywgZXhpdCB3YXMgMC5cblx0XHRhc3NlcnQub2sob3V0ICE9PSB1bmRlZmluZWQpO1xuXHR9KTtcblxuXHRkZXNjcmliZShcImFnYWluc3Qgc3ludGhldGljIHdvcmtzcGFjZSBmaXh0dXJlc1wiLCAoKSA9PiB7XG5cdFx0bGV0IHRtcDogc3RyaW5nO1xuXHRcdGxldCBmYWtlUGFja2FnZXM6IHN0cmluZztcblx0XHRsZXQgZmFrZU1hbmlmZXN0OiBzdHJpbmc7XG5cdFx0bGV0IGZha2VWZXJpZnk6IHN0cmluZztcblxuXHRcdGJlZm9yZUVhY2goKCkgPT4ge1xuXHRcdFx0dG1wID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtdmVyaWZ5LWNvdmVyYWdlLVwiKSk7XG5cdFx0XHRmYWtlUGFja2FnZXMgPSBqb2luKHRtcCwgXCJwYWNrYWdlc1wiKTtcblx0XHRcdG1rZGlyU3luYyhmYWtlUGFja2FnZXMsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG5cdFx0XHQvLyBDb3B5IHRoZSB0d28gc2NyaXB0IGZpbGVzIGludG8gdGhlIGZha2UgdHJlZSBzbyBSRVBPX1JPT1QgcmVzb2x2ZXMgY29ycmVjdGx5LlxuXHRcdFx0Ly8gTWFuaWZlc3QgdXNlcyBfX2Rpcm5hbWUgXHUyMTkyIHNjcmlwdHMvbGliLyBcdTIxOTIgLi4vLi4vID0gcmVwbyByb290LiBTbyBmYWtlIGxheW91dCBpczpcblx0XHRcdC8vICAgdG1wL1xuXHRcdFx0Ly8gICAgIHBhY2thZ2VzL1xuXHRcdFx0Ly8gICAgIHNjcmlwdHMvXG5cdFx0XHQvLyAgICAgICBsaWIvd29ya3NwYWNlLW1hbmlmZXN0LmNqc1xuXHRcdFx0Ly8gICAgICAgdmVyaWZ5LXdvcmtzcGFjZS1jb3ZlcmFnZS5janNcblx0XHRcdGNvbnN0IHNjcmlwdHNEaXIgPSBqb2luKHRtcCwgXCJzY3JpcHRzXCIpO1xuXHRcdFx0Y29uc3Qgc2NyaXB0c0xpYkRpciA9IGpvaW4oc2NyaXB0c0RpciwgXCJsaWJcIik7XG5cdFx0XHRta2RpclN5bmMoc2NyaXB0c0xpYkRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cdFx0XHR3cml0ZUZpbGVTeW5jKGpvaW4oc2NyaXB0c0xpYkRpciwgXCJ3b3Jrc3BhY2UtbWFuaWZlc3QuY2pzXCIpLFxuXHRcdFx0XHRyZWFkRmlsZVN5bmMobWFuaWZlc3RNb2R1bGVQYXRoLCBcInV0ZjhcIikpO1xuXHRcdFx0d3JpdGVGaWxlU3luYyhqb2luKHNjcmlwdHNEaXIsIFwidmVyaWZ5LXdvcmtzcGFjZS1jb3ZlcmFnZS5janNcIiksXG5cdFx0XHRcdHJlYWRGaWxlU3luYyh2ZXJpZnlTY3JpcHRQYXRoLCBcInV0ZjhcIikpO1xuXHRcdFx0ZmFrZU1hbmlmZXN0ID0gam9pbihzY3JpcHRzTGliRGlyLCBcIndvcmtzcGFjZS1tYW5pZmVzdC5janNcIik7XG5cdFx0XHRmYWtlVmVyaWZ5ID0gam9pbihzY3JpcHRzRGlyLCBcInZlcmlmeS13b3Jrc3BhY2UtY292ZXJhZ2UuY2pzXCIpO1xuXHRcdH0pO1xuXG5cdFx0YWZ0ZXJFYWNoKCgpID0+IHtcblx0XHRcdHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcblx0XHR9KTtcblxuXHRcdGZ1bmN0aW9uIHdyaXRlUGFja2FnZShkaXI6IHN0cmluZywgcGtnSnNvbjogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sIGV4dHJhRmlsZXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fSkge1xuXHRcdFx0Y29uc3QgcGtnUGF0aCA9IGpvaW4oZmFrZVBhY2thZ2VzLCBkaXIpO1xuXHRcdFx0bWtkaXJTeW5jKHBrZ1BhdGgsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXHRcdFx0d3JpdGVGaWxlU3luYyhqb2luKHBrZ1BhdGgsIFwicGFja2FnZS5qc29uXCIpLCBKU09OLnN0cmluZ2lmeShwa2dKc29uLCBudWxsLCAyKSk7XG5cdFx0XHRmb3IgKGNvbnN0IFtyZWwsIGNvbnRlbnRdIG9mIE9iamVjdC5lbnRyaWVzKGV4dHJhRmlsZXMpKSB7XG5cdFx0XHRcdGNvbnN0IGZ1bGwgPSBqb2luKHBrZ1BhdGgsIHJlbCk7XG5cdFx0XHRcdG1rZGlyU3luYyhkaXJuYW1lKGZ1bGwpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblx0XHRcdFx0d3JpdGVGaWxlU3luYyhmdWxsLCBjb250ZW50KTtcblx0XHRcdH1cblx0XHR9XG5cblx0XHR0ZXN0KFwiRkFJTFMgd2hlbiBhIGxpbmthYmxlIHBhY2thZ2UgaGFzIHplcm8gdGVzdCBmaWxlc1wiLCAoKSA9PiB7XG5cdFx0XHR3cml0ZVBhY2thZ2UoXCJwa2ctYVwiLCB7XG5cdFx0XHRcdG5hbWU6IFwiQGdzZC9wa2ctYVwiLFxuXHRcdFx0XHR2ZXJzaW9uOiBcIjEuMC4wXCIsXG5cdFx0XHRcdGdzZDogeyBsaW5rYWJsZTogdHJ1ZSwgc2NvcGU6IFwiQGdzZFwiLCBuYW1lOiBcInBrZy1hXCIgfSxcblx0XHRcdH0sIHtcblx0XHRcdFx0XCJzcmMvaW5kZXgudHNcIjogXCJleHBvcnQgY29uc3QgeCA9IDE7XCIsXG5cdFx0XHR9KTtcblxuXHRcdFx0bGV0IHRocmV3ID0gZmFsc2U7XG5cdFx0XHRsZXQgc3RkZXJyID0gXCJcIjtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGV4ZWNGaWxlU3luYyhwcm9jZXNzLmV4ZWNQYXRoLCBbZmFrZVZlcmlmeV0sIHtcblx0XHRcdFx0XHRlbmNvZGluZzogXCJ1dGY4XCIsXG5cdFx0XHRcdFx0c3RkaW86IFtcInBpcGVcIiwgXCJwaXBlXCIsIFwicGlwZVwiXSxcblx0XHRcdFx0fSk7XG5cdFx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdFx0dGhyZXcgPSB0cnVlO1xuXHRcdFx0XHRzdGRlcnIgPSAoZXJyIGFzIHsgc3RkZXJyPzogc3RyaW5nIH0pLnN0ZGVyciA/PyBcIlwiO1xuXHRcdFx0fVxuXHRcdFx0YXNzZXJ0Lm9rKHRocmV3LCBcImV4cGVjdGVkIHZlcmlmeS13b3Jrc3BhY2UtY292ZXJhZ2UgdG8gZXhpdCBub24temVyb1wiKTtcblx0XHRcdGFzc2VydC5tYXRjaChzdGRlcnIsIC9ubyBcXCpcXC50ZXN0XFwuLyk7XG5cdFx0XHRhc3NlcnQubWF0Y2goc3RkZXJyLCAvcGtnLWEvKTtcblx0XHR9KTtcblxuXHRcdHRlc3QoXCJQQVNTRVMgd2hlbiBldmVyeSBsaW5rYWJsZSBwYWNrYWdlIGhhcyBhdCBsZWFzdCBvbmUgdGVzdCBmaWxlXCIsICgpID0+IHtcblx0XHRcdHdyaXRlUGFja2FnZShcInBrZy1hXCIsIHtcblx0XHRcdFx0bmFtZTogXCJAZ3NkL3BrZy1hXCIsXG5cdFx0XHRcdHZlcnNpb246IFwiMS4wLjBcIixcblx0XHRcdFx0Z3NkOiB7IGxpbmthYmxlOiB0cnVlLCBzY29wZTogXCJAZ3NkXCIsIG5hbWU6IFwicGtnLWFcIiB9LFxuXHRcdFx0fSwge1xuXHRcdFx0XHRcInNyYy9pbmRleC50c1wiOiBcImV4cG9ydCBjb25zdCB4ID0gMTtcIixcblx0XHRcdFx0XCJzcmMvaW5kZXgudGVzdC50c1wiOiBcImltcG9ydCB0ZXN0IGZyb20gJ25vZGU6dGVzdCc7IHRlc3QoJ29rJywgKCkgPT4ge30pO1wiLFxuXHRcdFx0fSk7XG5cdFx0XHR3cml0ZVBhY2thZ2UoXCJwa2ctYlwiLCB7XG5cdFx0XHRcdG5hbWU6IFwiQGdzZC1idWlsZC9wa2ctYlwiLFxuXHRcdFx0XHR2ZXJzaW9uOiBcIjEuMC4wXCIsXG5cdFx0XHRcdGdzZDogeyBsaW5rYWJsZTogdHJ1ZSwgc2NvcGU6IFwiQGdzZC1idWlsZFwiLCBuYW1lOiBcInBrZy1iXCIgfSxcblx0XHRcdH0sIHtcblx0XHRcdFx0XCJzcmMvdGhpbmcudGVzdC5qc1wiOiBcIlwiLFxuXHRcdFx0fSk7XG5cblx0XHRcdGNvbnN0IG91dCA9IGV4ZWNGaWxlU3luYyhwcm9jZXNzLmV4ZWNQYXRoLCBbZmFrZVZlcmlmeV0sIHtcblx0XHRcdFx0ZW5jb2Rpbmc6IFwidXRmOFwiLFxuXHRcdFx0XHRzdGRpbzogW1wicGlwZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdLFxuXHRcdFx0fSk7XG5cdFx0XHRhc3NlcnQub2sob3V0ICE9PSB1bmRlZmluZWQpO1xuXHRcdH0pO1xuXG5cdFx0dGVzdChcIklHTk9SRVMgbm9uLWxpbmthYmxlIHBhY2thZ2VzIGV2ZW4gaWYgdGhleSBoYXZlIG5vIHRlc3RzXCIsICgpID0+IHtcblx0XHRcdHdyaXRlUGFja2FnZShcImludGVybmFsLXBrZ1wiLCB7XG5cdFx0XHRcdG5hbWU6IFwiQGdzZC1idWlsZC9pbnRlcm5hbC1wa2dcIixcblx0XHRcdFx0dmVyc2lvbjogXCIxLjAuMFwiLFxuXHRcdFx0XHQvLyBJbnRlbnRpb25hbGx5IG5vIGdzZC5saW5rYWJsZSBcdTIwMTQgdGhpcyBwYWNrYWdlIHNob3VsZCBiZSBza2lwcGVkIGVudGlyZWx5LlxuXHRcdFx0fSwge1xuXHRcdFx0XHRcInNyYy9pbmRleC50c1wiOiBcImV4cG9ydCBjb25zdCB4ID0gMTtcIixcblx0XHRcdH0pO1xuXHRcdFx0Y29uc3Qgb3V0ID0gZXhlY0ZpbGVTeW5jKHByb2Nlc3MuZXhlY1BhdGgsIFtmYWtlVmVyaWZ5XSwge1xuXHRcdFx0XHRlbmNvZGluZzogXCJ1dGY4XCIsXG5cdFx0XHRcdHN0ZGlvOiBbXCJwaXBlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0sXG5cdFx0XHR9KTtcblx0XHRcdGFzc2VydC5vayhvdXQgIT09IHVuZGVmaW5lZCk7XG5cdFx0fSk7XG5cblx0XHR0ZXN0KFwiRkFJTFMgd2hlbiBwYWNrYWdlLmpzb24gJ25hbWUnIGRpc2FncmVlcyB3aXRoIGdzZC5zY29wZS9nc2QubmFtZVwiLCAoKSA9PiB7XG5cdFx0XHR3cml0ZVBhY2thZ2UoXCJwa2ctYmFkXCIsIHtcblx0XHRcdFx0bmFtZTogXCJAZ3NkL3dyb25nLW5hbWVcIixcblx0XHRcdFx0dmVyc2lvbjogXCIxLjAuMFwiLFxuXHRcdFx0XHRnc2Q6IHsgbGlua2FibGU6IHRydWUsIHNjb3BlOiBcIkBnc2RcIiwgbmFtZTogXCJwa2ctYmFkXCIgfSxcblx0XHRcdH0sIHtcblx0XHRcdFx0XCJzcmMveC50ZXN0LnRzXCI6IFwiXCIsXG5cdFx0XHR9KTtcblxuXHRcdFx0bGV0IHRocmV3ID0gZmFsc2U7XG5cdFx0XHRsZXQgc3RkZXJyID0gXCJcIjtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGV4ZWNGaWxlU3luYyhwcm9jZXNzLmV4ZWNQYXRoLCBbZmFrZVZlcmlmeV0sIHtcblx0XHRcdFx0XHRlbmNvZGluZzogXCJ1dGY4XCIsXG5cdFx0XHRcdFx0c3RkaW86IFtcInBpcGVcIiwgXCJwaXBlXCIsIFwicGlwZVwiXSxcblx0XHRcdFx0fSk7XG5cdFx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdFx0dGhyZXcgPSB0cnVlO1xuXHRcdFx0XHRzdGRlcnIgPSAoZXJyIGFzIHsgc3RkZXJyPzogc3RyaW5nIH0pLnN0ZGVyciA/PyBcIlwiO1xuXHRcdFx0fVxuXHRcdFx0YXNzZXJ0Lm9rKHRocmV3LCBcImV4cGVjdGVkIGV4aXQgbm9uLXplcm8gZm9yIG5hbWUgbWlzbWF0Y2hcIik7XG5cdFx0XHQvLyBFaXRoZXIgdGhlIG1hbmlmZXN0IGl0c2VsZiB0aHJvd3MgKHByZWZlcnJlZCkgb3IgdGhlIHZlcmlmeSBzY3JpcHQgcmVwb3J0cyBpdC5cblx0XHRcdGFzc2VydC5vayhcblx0XHRcdFx0L25hbWUuKmdzZFxcLnNjb3BlXFwvZ3NkXFwubmFtZXxnc2RcXC5zY29wZVxcL2dzZFxcLm5hbWUuKm5hbWUvaS50ZXN0KHN0ZGVyciksXG5cdFx0XHRcdGBleHBlY3RlZCBzdGRlcnIgdG8gZXhwbGFpbiBuYW1lIG1pc21hdGNoLiBnb3Q6ICR7c3RkZXJyfWBcblx0XHRcdCk7XG5cdFx0XHQvLyBFbnN1cmUgdGhlIGZha2UgbWFuaWZlc3QgZmlsZSB3YXMgYWN0dWFsbHkgbG9hZGVkIGluIHRoZSBjaGlsZCBwcm9jZXNzXG5cdFx0XHQvLyAobm90IHRoZSBsaXZlIHJlcG8ncyBtYW5pZmVzdCBieSBhY2NpZGVudCkuXG5cdFx0XHRhc3NlcnQub2soZmFrZU1hbmlmZXN0Lmxlbmd0aCA+IDApO1xuXHRcdH0pO1xuXHR9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQ0EsU0FBUyxVQUFVLE1BQU0sWUFBWSxpQkFBaUI7QUFDdEQsT0FBTyxZQUFZO0FBQ25CLFNBQVMsb0JBQW9CO0FBQzdCLFNBQVMsWUFBWSxXQUFXLGFBQWEsY0FBYyxRQUFRLHFCQUFxQjtBQUN4RixTQUFTLGNBQWM7QUFDdkIsU0FBUyxNQUFNLFNBQVMsZUFBZTtBQUN2QyxTQUFTLHFCQUFxQjtBQUM5QixTQUFTLHFCQUFxQjtBQUU5QixNQUFNQSxXQUFVLGNBQWMsWUFBWSxHQUFHO0FBSzdDLFNBQVMsYUFBYSxPQUF1QjtBQUM1QyxNQUFJLE1BQU07QUFDVixXQUFTLElBQUksR0FBRyxJQUFJLElBQUksS0FBSztBQUM1QixRQUFJLFdBQVcsS0FBSyxLQUFLLE1BQU0sQ0FBQyxFQUFHLFFBQU87QUFDMUMsVUFBTSxTQUFTLFFBQVEsS0FBSyxJQUFJO0FBQ2hDLFFBQUksV0FBVyxJQUFLO0FBQ3BCLFVBQU07QUFBQSxFQUNQO0FBQ0EsUUFBTSxJQUFJLE1BQU0sbURBQW1ELEtBQUssRUFBRTtBQUMzRTtBQUVBLE1BQU0sY0FBYyxhQUFhLFFBQVEsY0FBYyxZQUFZLEdBQUcsQ0FBQyxDQUFDO0FBQ3hFLE1BQU0scUJBQXFCLEtBQUssYUFBYSxXQUFXLE9BQU8sd0JBQXdCO0FBQ3ZGLE1BQU0sbUJBQW1CLEtBQUssYUFBYSxXQUFXLCtCQUErQjtBQUVyRixTQUFTLHFDQUFxQyxNQUFNO0FBQ25ELE9BQUssa0VBQWtFLE1BQU07QUFDNUUsVUFBTSxXQUFXQSxTQUFRLGtCQUFrQjtBQUMzQyxVQUFNLFdBQVcsU0FBUyxvQkFBb0I7QUFDOUMsV0FBTyxNQUFNLFNBQVMsUUFBUSxHQUFHLHNDQUFzQztBQUV2RSxVQUFNLFFBQVEsU0FBUyxJQUFJLENBQUMsTUFBK0IsRUFBRSxXQUFXLEVBQUUsS0FBSztB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
