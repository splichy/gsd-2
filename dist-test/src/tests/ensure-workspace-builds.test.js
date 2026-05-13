import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const require2 = createRequire(import.meta.url);
const { newestSrcMtime, detectStalePackages } = require2("../../scripts/ensure-workspace-builds.cjs");
describe("newestSrcMtime", () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gsd-mtime-test-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
  it("returns 0 for a non-existent directory", () => {
    assert.equal(newestSrcMtime(join(tmp, "does-not-exist")), 0);
  });
  it("returns 0 when directory has no .ts files", () => {
    writeFileSync(join(tmp, "index.js"), "");
    writeFileSync(join(tmp, "config.json"), "");
    assert.equal(newestSrcMtime(tmp), 0);
  });
  it("returns the mtime of a single .ts file", () => {
    const file = join(tmp, "index.ts");
    writeFileSync(file, "");
    const mtime = /* @__PURE__ */ new Date("2024-01-15T10:00:00Z");
    utimesSync(file, mtime, mtime);
    assert.equal(newestSrcMtime(tmp), mtime.getTime());
  });
  it("returns the max mtime across multiple .ts files", () => {
    const older = join(tmp, "a.ts");
    const newer = join(tmp, "b.ts");
    writeFileSync(older, "");
    writeFileSync(newer, "");
    utimesSync(older, /* @__PURE__ */ new Date("2024-01-01T00:00:00Z"), /* @__PURE__ */ new Date("2024-01-01T00:00:00Z"));
    utimesSync(newer, /* @__PURE__ */ new Date("2024-06-01T00:00:00Z"), /* @__PURE__ */ new Date("2024-06-01T00:00:00Z"));
    assert.equal(newestSrcMtime(tmp), (/* @__PURE__ */ new Date("2024-06-01T00:00:00Z")).getTime());
  });
  it("recurses into subdirectories", () => {
    const subdir = join(tmp, "nested", "deep");
    mkdirSync(subdir, { recursive: true });
    const file = join(subdir, "util.ts");
    writeFileSync(file, "");
    const mtime = /* @__PURE__ */ new Date("2024-03-01T00:00:00Z");
    utimesSync(file, mtime, mtime);
    assert.equal(newestSrcMtime(tmp), mtime.getTime());
  });
  it("skips node_modules entirely", () => {
    const nm = join(tmp, "node_modules", "some-pkg");
    mkdirSync(nm, { recursive: true });
    const nmFile = join(nm, "index.ts");
    writeFileSync(nmFile, "");
    const future = /* @__PURE__ */ new Date("2099-01-01T00:00:00Z");
    utimesSync(nmFile, future, future);
    assert.equal(newestSrcMtime(tmp), 0);
  });
});
describe("detectStalePackages", () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gsd-stale-test-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
  function createFakePackage(packagesDir, pkgName, opts = {}) {
    const pkgDir = join(packagesDir, pkgName);
    const srcDir = join(pkgDir, "src");
    const distDir = join(pkgDir, "dist");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "index.ts"), "export const x = 1;");
    if (!opts.missingDist) {
      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(distDir, "index.js"), "export const x = 1;");
    }
    if (opts.srcNewerThanDist && !opts.missingDist) {
      const distTime = /* @__PURE__ */ new Date("2024-06-01T00:00:00Z");
      const srcTime = /* @__PURE__ */ new Date("2024-06-01T00:00:01Z");
      utimesSync(join(distDir, "index.js"), distTime, distTime);
      utimesSync(join(srcDir, "index.ts"), srcTime, srcTime);
    }
  }
  it("detects missing dist/ as stale regardless of .git presence", () => {
    const packagesDir = join(tmp, "packages");
    mkdirSync(packagesDir, { recursive: true });
    createFakePackage(packagesDir, "test-pkg", { missingDist: true });
    const result = detectStalePackages(tmp, ["test-pkg"]);
    assert.deepEqual(result, ["test-pkg"]);
  });
  it("detects stale src > dist timestamps in a git repo (dev clone)", () => {
    mkdirSync(join(tmp, ".git"), { recursive: true });
    const packagesDir = join(tmp, "packages");
    mkdirSync(packagesDir, { recursive: true });
    createFakePackage(packagesDir, "test-pkg", { srcNewerThanDist: true });
    const result = detectStalePackages(tmp, ["test-pkg"]);
    assert.deepEqual(result, ["test-pkg"]);
  });
  it("skips staleness check when not in a git repo (npm tarball install)", () => {
    const packagesDir = join(tmp, "packages");
    mkdirSync(packagesDir, { recursive: true });
    createFakePackage(packagesDir, "test-pkg", { srcNewerThanDist: true });
    const result = detectStalePackages(tmp, ["test-pkg"]);
    assert.deepEqual(result, [], "should not detect staleness in npm tarball installs (no .git)");
  });
  it("still detects missing dist/ in npm tarball installs", () => {
    const packagesDir = join(tmp, "packages");
    mkdirSync(packagesDir, { recursive: true });
    createFakePackage(packagesDir, "test-pkg", { missingDist: true });
    const result = detectStalePackages(tmp, ["test-pkg"]);
    assert.deepEqual(result, ["test-pkg"]);
  });
  it("returns empty array when dist/ is up to date", () => {
    mkdirSync(join(tmp, ".git"), { recursive: true });
    const packagesDir = join(tmp, "packages");
    mkdirSync(packagesDir, { recursive: true });
    createFakePackage(packagesDir, "test-pkg");
    const result = detectStalePackages(tmp, ["test-pkg"]);
    assert.deepEqual(result, []);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3Rlc3RzL2Vuc3VyZS13b3Jrc3BhY2UtYnVpbGRzLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IGRlc2NyaWJlLCBpdCwgYmVmb3JlRWFjaCwgYWZ0ZXJFYWNoIH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgd3JpdGVGaWxlU3luYywgbWtkaXJTeW5jLCBybVN5bmMsIHV0aW1lc1N5bmMsIHN0YXRTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgY3JlYXRlUmVxdWlyZSB9IGZyb20gXCJub2RlOm1vZHVsZVwiO1xuXG5jb25zdCByZXF1aXJlID0gY3JlYXRlUmVxdWlyZShpbXBvcnQubWV0YS51cmwpO1xuY29uc3QgeyBuZXdlc3RTcmNNdGltZSwgZGV0ZWN0U3RhbGVQYWNrYWdlcyB9ID0gcmVxdWlyZShcIi4uLy4uL3NjcmlwdHMvZW5zdXJlLXdvcmtzcGFjZS1idWlsZHMuY2pzXCIpO1xuXG5kZXNjcmliZShcIm5ld2VzdFNyY010aW1lXCIsICgpID0+IHtcbiAgbGV0IHRtcDogc3RyaW5nO1xuXG4gIGJlZm9yZUVhY2goKCkgPT4geyB0bXAgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1tdGltZS10ZXN0LVwiKSk7IH0pO1xuICBhZnRlckVhY2goKCkgPT4geyBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7IH0pO1xuXG4gIGl0KFwicmV0dXJucyAwIGZvciBhIG5vbi1leGlzdGVudCBkaXJlY3RvcnlcIiwgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChuZXdlc3RTcmNNdGltZShqb2luKHRtcCwgXCJkb2VzLW5vdC1leGlzdFwiKSksIDApO1xuICB9KTtcblxuICBpdChcInJldHVybnMgMCB3aGVuIGRpcmVjdG9yeSBoYXMgbm8gLnRzIGZpbGVzXCIsICgpID0+IHtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4odG1wLCBcImluZGV4LmpzXCIpLCBcIlwiKTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4odG1wLCBcImNvbmZpZy5qc29uXCIpLCBcIlwiKTtcbiAgICBhc3NlcnQuZXF1YWwobmV3ZXN0U3JjTXRpbWUodG1wKSwgMCk7XG4gIH0pO1xuXG4gIGl0KFwicmV0dXJucyB0aGUgbXRpbWUgb2YgYSBzaW5nbGUgLnRzIGZpbGVcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGZpbGUgPSBqb2luKHRtcCwgXCJpbmRleC50c1wiKTtcbiAgICB3cml0ZUZpbGVTeW5jKGZpbGUsIFwiXCIpO1xuICAgIGNvbnN0IG10aW1lID0gbmV3IERhdGUoXCIyMDI0LTAxLTE1VDEwOjAwOjAwWlwiKTtcbiAgICB1dGltZXNTeW5jKGZpbGUsIG10aW1lLCBtdGltZSk7XG4gICAgYXNzZXJ0LmVxdWFsKG5ld2VzdFNyY010aW1lKHRtcCksIG10aW1lLmdldFRpbWUoKSk7XG4gIH0pO1xuXG4gIGl0KFwicmV0dXJucyB0aGUgbWF4IG10aW1lIGFjcm9zcyBtdWx0aXBsZSAudHMgZmlsZXNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IG9sZGVyID0gam9pbih0bXAsIFwiYS50c1wiKTtcbiAgICBjb25zdCBuZXdlciA9IGpvaW4odG1wLCBcImIudHNcIik7XG4gICAgd3JpdGVGaWxlU3luYyhvbGRlciwgXCJcIik7XG4gICAgd3JpdGVGaWxlU3luYyhuZXdlciwgXCJcIik7XG4gICAgdXRpbWVzU3luYyhvbGRlciwgbmV3IERhdGUoXCIyMDI0LTAxLTAxVDAwOjAwOjAwWlwiKSwgbmV3IERhdGUoXCIyMDI0LTAxLTAxVDAwOjAwOjAwWlwiKSk7XG4gICAgdXRpbWVzU3luYyhuZXdlciwgbmV3IERhdGUoXCIyMDI0LTA2LTAxVDAwOjAwOjAwWlwiKSwgbmV3IERhdGUoXCIyMDI0LTA2LTAxVDAwOjAwOjAwWlwiKSk7XG4gICAgYXNzZXJ0LmVxdWFsKG5ld2VzdFNyY010aW1lKHRtcCksIG5ldyBEYXRlKFwiMjAyNC0wNi0wMVQwMDowMDowMFpcIikuZ2V0VGltZSgpKTtcbiAgfSk7XG5cbiAgaXQoXCJyZWN1cnNlcyBpbnRvIHN1YmRpcmVjdG9yaWVzXCIsICgpID0+IHtcbiAgICBjb25zdCBzdWJkaXIgPSBqb2luKHRtcCwgXCJuZXN0ZWRcIiwgXCJkZWVwXCIpO1xuICAgIG1rZGlyU3luYyhzdWJkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIGNvbnN0IGZpbGUgPSBqb2luKHN1YmRpciwgXCJ1dGlsLnRzXCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoZmlsZSwgXCJcIik7XG4gICAgY29uc3QgbXRpbWUgPSBuZXcgRGF0ZShcIjIwMjQtMDMtMDFUMDA6MDA6MDBaXCIpO1xuICAgIHV0aW1lc1N5bmMoZmlsZSwgbXRpbWUsIG10aW1lKTtcbiAgICBhc3NlcnQuZXF1YWwobmV3ZXN0U3JjTXRpbWUodG1wKSwgbXRpbWUuZ2V0VGltZSgpKTtcbiAgfSk7XG5cbiAgaXQoXCJza2lwcyBub2RlX21vZHVsZXMgZW50aXJlbHlcIiwgKCkgPT4ge1xuICAgIGNvbnN0IG5tID0gam9pbih0bXAsIFwibm9kZV9tb2R1bGVzXCIsIFwic29tZS1wa2dcIik7XG4gICAgbWtkaXJTeW5jKG5tLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBjb25zdCBubUZpbGUgPSBqb2luKG5tLCBcImluZGV4LnRzXCIpO1xuICAgIHdyaXRlRmlsZVN5bmMobm1GaWxlLCBcIlwiKTtcbiAgICBjb25zdCBmdXR1cmUgPSBuZXcgRGF0ZShcIjIwOTktMDEtMDFUMDA6MDA6MDBaXCIpO1xuICAgIHV0aW1lc1N5bmMobm1GaWxlLCBmdXR1cmUsIGZ1dHVyZSk7XG4gICAgYXNzZXJ0LmVxdWFsKG5ld2VzdFNyY010aW1lKHRtcCksIDApO1xuICB9KTtcbn0pO1xuXG5kZXNjcmliZShcImRldGVjdFN0YWxlUGFja2FnZXNcIiwgKCkgPT4ge1xuICBsZXQgdG1wOiBzdHJpbmc7XG5cbiAgYmVmb3JlRWFjaCgoKSA9PiB7IHRtcCA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXN0YWxlLXRlc3QtXCIpKTsgfSk7XG4gIGFmdGVyRWFjaCgoKSA9PiB7IHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTsgfSk7XG5cbiAgLyoqXG4gICAqIEhlbHBlciB0byBjcmVhdGUgYSBmYWtlIHdvcmtzcGFjZSBwYWNrYWdlIHdpdGggc3JjLyBhbmQgZGlzdC8gZGlyZWN0b3JpZXMuXG4gICAqIFNldHMgdGltZXN0YW1wcyB0byBzaW11bGF0ZSBucG0gdGFyYmFsbCBleHRyYWN0aW9uIHdoZXJlIHNyYy8gZmlsZXMgY2FuIGJlXG4gICAqIDEgc2Vjb25kIG5ld2VyIHRoYW4gZGlzdC8gZmlsZXMuXG4gICAqL1xuICBmdW5jdGlvbiBjcmVhdGVGYWtlUGFja2FnZShcbiAgICBwYWNrYWdlc0Rpcjogc3RyaW5nLFxuICAgIHBrZ05hbWU6IHN0cmluZyxcbiAgICBvcHRzOiB7IHNyY05ld2VyVGhhbkRpc3Q/OiBib29sZWFuOyBtaXNzaW5nRGlzdD86IGJvb2xlYW4gfSA9IHt9LFxuICApOiB2b2lkIHtcbiAgICBjb25zdCBwa2dEaXIgPSBqb2luKHBhY2thZ2VzRGlyLCBwa2dOYW1lKTtcbiAgICBjb25zdCBzcmNEaXIgPSBqb2luKHBrZ0RpciwgXCJzcmNcIik7XG4gICAgY29uc3QgZGlzdERpciA9IGpvaW4ocGtnRGlyLCBcImRpc3RcIik7XG4gICAgbWtkaXJTeW5jKHNyY0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHNyY0RpciwgXCJpbmRleC50c1wiKSwgXCJleHBvcnQgY29uc3QgeCA9IDE7XCIpO1xuXG4gICAgaWYgKCFvcHRzLm1pc3NpbmdEaXN0KSB7XG4gICAgICBta2RpclN5bmMoZGlzdERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlzdERpciwgXCJpbmRleC5qc1wiKSwgXCJleHBvcnQgY29uc3QgeCA9IDE7XCIpO1xuICAgIH1cblxuICAgIGlmIChvcHRzLnNyY05ld2VyVGhhbkRpc3QgJiYgIW9wdHMubWlzc2luZ0Rpc3QpIHtcbiAgICAgIC8vIFNpbXVsYXRlIG5wbSB0YXJiYWxsIGV4dHJhY3Rpb246IHNyYy8gaXMgMSBzZWNvbmQgbmV3ZXIgdGhhbiBkaXN0L1xuICAgICAgY29uc3QgZGlzdFRpbWUgPSBuZXcgRGF0ZShcIjIwMjQtMDYtMDFUMDA6MDA6MDBaXCIpO1xuICAgICAgY29uc3Qgc3JjVGltZSA9IG5ldyBEYXRlKFwiMjAyNC0wNi0wMVQwMDowMDowMVpcIik7XG4gICAgICB1dGltZXNTeW5jKGpvaW4oZGlzdERpciwgXCJpbmRleC5qc1wiKSwgZGlzdFRpbWUsIGRpc3RUaW1lKTtcbiAgICAgIHV0aW1lc1N5bmMoam9pbihzcmNEaXIsIFwiaW5kZXgudHNcIiksIHNyY1RpbWUsIHNyY1RpbWUpO1xuICAgIH1cbiAgfVxuXG4gIGl0KFwiZGV0ZWN0cyBtaXNzaW5nIGRpc3QvIGFzIHN0YWxlIHJlZ2FyZGxlc3Mgb2YgLmdpdCBwcmVzZW5jZVwiLCAoKSA9PiB7XG4gICAgY29uc3QgcGFja2FnZXNEaXIgPSBqb2luKHRtcCwgXCJwYWNrYWdlc1wiKTtcbiAgICBta2RpclN5bmMocGFja2FnZXNEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIGNyZWF0ZUZha2VQYWNrYWdlKHBhY2thZ2VzRGlyLCBcInRlc3QtcGtnXCIsIHsgbWlzc2luZ0Rpc3Q6IHRydWUgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBkZXRlY3RTdGFsZVBhY2thZ2VzKHRtcCwgW1widGVzdC1wa2dcIl0pO1xuICAgIGFzc2VydC5kZWVwRXF1YWwocmVzdWx0LCBbXCJ0ZXN0LXBrZ1wiXSk7XG4gIH0pO1xuXG4gIGl0KFwiZGV0ZWN0cyBzdGFsZSBzcmMgPiBkaXN0IHRpbWVzdGFtcHMgaW4gYSBnaXQgcmVwbyAoZGV2IGNsb25lKVwiLCAoKSA9PiB7XG4gICAgLy8gU2ltdWxhdGUgYSBnaXQgcmVwbyBieSBjcmVhdGluZyAuZ2l0IGRpcmVjdG9yeVxuICAgIG1rZGlyU3luYyhqb2luKHRtcCwgXCIuZ2l0XCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBjb25zdCBwYWNrYWdlc0RpciA9IGpvaW4odG1wLCBcInBhY2thZ2VzXCIpO1xuICAgIG1rZGlyU3luYyhwYWNrYWdlc0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgY3JlYXRlRmFrZVBhY2thZ2UocGFja2FnZXNEaXIsIFwidGVzdC1wa2dcIiwgeyBzcmNOZXdlclRoYW5EaXN0OiB0cnVlIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gZGV0ZWN0U3RhbGVQYWNrYWdlcyh0bXAsIFtcInRlc3QtcGtnXCJdKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdCwgW1widGVzdC1wa2dcIl0pO1xuICB9KTtcblxuICBpdChcInNraXBzIHN0YWxlbmVzcyBjaGVjayB3aGVuIG5vdCBpbiBhIGdpdCByZXBvIChucG0gdGFyYmFsbCBpbnN0YWxsKVwiLCAoKSA9PiB7XG4gICAgLy8gTm8gLmdpdCBkaXJlY3RvcnkgXHUyMDE0IHNpbXVsYXRlcyBucG0gaW5zdGFsbCBmcm9tIHRhcmJhbGxcbiAgICBjb25zdCBwYWNrYWdlc0RpciA9IGpvaW4odG1wLCBcInBhY2thZ2VzXCIpO1xuICAgIG1rZGlyU3luYyhwYWNrYWdlc0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgY3JlYXRlRmFrZVBhY2thZ2UocGFja2FnZXNEaXIsIFwidGVzdC1wa2dcIiwgeyBzcmNOZXdlclRoYW5EaXN0OiB0cnVlIH0pO1xuXG4gICAgLy8gRXZlbiB0aG91Z2ggc3JjLyBpcyBuZXdlciB0aGFuIGRpc3QvLCB0aGUgc2NyaXB0IHNob3VsZCBOT1QgZGV0ZWN0IGl0XG4gICAgLy8gYXMgc3RhbGUgYmVjYXVzZSB3ZSdyZSBpbiBhbiBucG0gdGFyYmFsbCAobm8gLmdpdCBkaXJlY3RvcnkpLlxuICAgIC8vIFRoZSB0aW1lc3RhbXAgZGlmZmVyZW5jZSBpcyBhbiBhcnRpZmFjdCBvZiBucG0gdGFyYmFsbCBleHRyYWN0aW9uLlxuICAgIGNvbnN0IHJlc3VsdCA9IGRldGVjdFN0YWxlUGFja2FnZXModG1wLCBbXCJ0ZXN0LXBrZ1wiXSk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQsIFtdLCBcInNob3VsZCBub3QgZGV0ZWN0IHN0YWxlbmVzcyBpbiBucG0gdGFyYmFsbCBpbnN0YWxscyAobm8gLmdpdClcIik7XG4gIH0pO1xuXG4gIGl0KFwic3RpbGwgZGV0ZWN0cyBtaXNzaW5nIGRpc3QvIGluIG5wbSB0YXJiYWxsIGluc3RhbGxzXCIsICgpID0+IHtcbiAgICAvLyBObyAuZ2l0IGRpcmVjdG9yeSBcdTIwMTQgc2ltdWxhdGVzIG5wbSBpbnN0YWxsIGZyb20gdGFyYmFsbFxuICAgIGNvbnN0IHBhY2thZ2VzRGlyID0gam9pbih0bXAsIFwicGFja2FnZXNcIik7XG4gICAgbWtkaXJTeW5jKHBhY2thZ2VzRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBjcmVhdGVGYWtlUGFja2FnZShwYWNrYWdlc0RpciwgXCJ0ZXN0LXBrZ1wiLCB7IG1pc3NpbmdEaXN0OiB0cnVlIH0pO1xuXG4gICAgLy8gTWlzc2luZyBkaXN0LyBzaG91bGQgYWx3YXlzIGJlIGRldGVjdGVkLCBldmVuIGluIG5wbSBpbnN0YWxsc1xuICAgIGNvbnN0IHJlc3VsdCA9IGRldGVjdFN0YWxlUGFja2FnZXModG1wLCBbXCJ0ZXN0LXBrZ1wiXSk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQsIFtcInRlc3QtcGtnXCJdKTtcbiAgfSk7XG5cbiAgaXQoXCJyZXR1cm5zIGVtcHR5IGFycmF5IHdoZW4gZGlzdC8gaXMgdXAgdG8gZGF0ZVwiLCAoKSA9PiB7XG4gICAgbWtkaXJTeW5jKGpvaW4odG1wLCBcIi5naXRcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIGNvbnN0IHBhY2thZ2VzRGlyID0gam9pbih0bXAsIFwicGFja2FnZXNcIik7XG4gICAgbWtkaXJTeW5jKHBhY2thZ2VzRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBjcmVhdGVGYWtlUGFja2FnZShwYWNrYWdlc0RpciwgXCJ0ZXN0LXBrZ1wiKTtcbiAgICAvLyBEZWZhdWx0OiB0aW1lc3RhbXBzIGFyZSBlcXVhbCAoYm90aCBzZXQgYnkgd3JpdGVGaWxlU3luYyBhdCB+c2FtZSB0aW1lKVxuXG4gICAgY29uc3QgcmVzdWx0ID0gZGV0ZWN0U3RhbGVQYWNrYWdlcyh0bXAsIFtcInRlc3QtcGtnXCJdKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdCwgW10pO1xuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxVQUFVLElBQUksWUFBWSxpQkFBaUI7QUFDcEQsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxlQUFlLFdBQVcsUUFBUSxrQkFBNEI7QUFDcEYsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsWUFBWTtBQUNyQixTQUFTLHFCQUFxQjtBQUU5QixNQUFNQSxXQUFVLGNBQWMsWUFBWSxHQUFHO0FBQzdDLE1BQU0sRUFBRSxnQkFBZ0Isb0JBQW9CLElBQUlBLFNBQVEsMkNBQTJDO0FBRW5HLFNBQVMsa0JBQWtCLE1BQU07QUFDL0IsTUFBSTtBQUVKLGFBQVcsTUFBTTtBQUFFLFVBQU0sWUFBWSxLQUFLLE9BQU8sR0FBRyxpQkFBaUIsQ0FBQztBQUFBLEVBQUcsQ0FBQztBQUMxRSxZQUFVLE1BQU07QUFBRSxXQUFPLEtBQUssRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUFHLENBQUM7QUFFbEUsS0FBRywwQ0FBMEMsTUFBTTtBQUNqRCxXQUFPLE1BQU0sZUFBZSxLQUFLLEtBQUssZ0JBQWdCLENBQUMsR0FBRyxDQUFDO0FBQUEsRUFD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
