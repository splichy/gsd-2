import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { tmpdir } from "node:os";
import { sortExtensionPaths } from "../extension-sort.js";
function makeTempDir() {
  const dir = join(tmpdir(), `ext-sort-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function makeExtension(baseDir, id, deps) {
  const extDir = join(baseDir, id);
  mkdirSync(extDir, { recursive: true });
  const manifest = {
    id,
    name: id,
    version: "1.0.0",
    description: "test extension",
    tier: "bundled",
    requires: { platform: "node" },
    ...deps && deps.length > 0 ? { dependencies: { extensions: deps } } : {}
  };
  writeFileSync(join(extDir, "extension-manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(extDir, "index.ts"), `export default function() {}`);
  return join(extDir, "index.ts");
}
describe("sortExtensionPaths", () => {
  test("Test 1: no deps \u2014 returns alphabetically sorted by ID, zero warnings", (t) => {
    const dir = makeTempDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const pathC = makeExtension(dir, "test.c");
    const pathA = makeExtension(dir, "test.a");
    const pathB = makeExtension(dir, "test.b");
    const result = sortExtensionPaths([pathC, pathA, pathB]);
    assert.equal(result.warnings.length, 0, "no warnings expected");
    assert.equal(result.sortedPaths.length, 3);
    const ids = result.sortedPaths.map((p) => basename(dirname(p)));
    assert.deepEqual(ids, ["test.a", "test.b", "test.c"]);
  });
  test("Test 2: linear chain \u2014 B depends on A, A appears before B", (t) => {
    const dir = makeTempDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const pathA = makeExtension(dir, "chain.a");
    const pathB = makeExtension(dir, "chain.b", ["chain.a"]);
    const result = sortExtensionPaths([pathB, pathA]);
    assert.equal(result.warnings.length, 0, "no warnings expected");
    assert.equal(result.sortedPaths.length, 2);
    const aIdx = result.sortedPaths.indexOf(pathA);
    const bIdx = result.sortedPaths.indexOf(pathB);
    assert.ok(aIdx < bIdx, "A must appear before B");
  });
  test("Test 3: diamond \u2014 D depends on B and C; B and C depend on A \u2192 A first, B/C alphabetically, then D", (t) => {
    const dir = makeTempDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const pathA = makeExtension(dir, "diamond.a");
    const pathB = makeExtension(dir, "diamond.b", ["diamond.a"]);
    const pathC = makeExtension(dir, "diamond.c", ["diamond.a"]);
    const pathD = makeExtension(dir, "diamond.d", ["diamond.b", "diamond.c"]);
    const result = sortExtensionPaths([pathD, pathC, pathB, pathA]);
    assert.equal(result.warnings.length, 0, "no warnings expected");
    assert.equal(result.sortedPaths.length, 4);
    const sorted = result.sortedPaths;
    const aIdx = sorted.indexOf(pathA);
    const bIdx = sorted.indexOf(pathB);
    const cIdx = sorted.indexOf(pathC);
    const dIdx = sorted.indexOf(pathD);
    assert.ok(aIdx < bIdx, "A must be before B");
    assert.ok(aIdx < cIdx, "A must be before C");
    assert.ok(bIdx < dIdx, "B must be before D");
    assert.ok(cIdx < dIdx, "C must be before D");
    assert.ok(bIdx < cIdx, "B before C alphabetically");
  });
  test("Test 4: missing dep \u2014 warns with correct format, extension still in output", (t) => {
    const dir = makeTempDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const pathA = makeExtension(dir, "test.a", ["gsd.nonexistent"]);
    const result = sortExtensionPaths([pathA]);
    assert.equal(result.sortedPaths.length, 1, "A still in output");
    assert.ok(result.sortedPaths.includes(pathA), "pathA in sorted output");
    assert.equal(result.warnings.length, 1, "one warning for missing dep");
    const w = result.warnings[0];
    assert.equal(w.declaringId, "test.a");
    assert.equal(w.missingId, "gsd.nonexistent");
    assert.equal(w.message, "Extension 'test.a' declares dependency 'gsd.nonexistent' which is not installed \u2014 loading anyway");
  });
  test("Test 5: cycle \u2014 A depends on B, B depends on A \u2192 both loaded, cycle warnings emitted, appended alphabetically", (t) => {
    const dir = makeTempDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const pathA = makeExtension(dir, "cycle.a", ["cycle.b"]);
    const pathB = makeExtension(dir, "cycle.b", ["cycle.a"]);
    const result = sortExtensionPaths([pathA, pathB]);
    assert.equal(result.sortedPaths.length, 2, "both extensions in output");
    assert.ok(result.sortedPaths.includes(pathA), "pathA in output");
    assert.ok(result.sortedPaths.includes(pathB), "pathB in output");
    assert.ok(result.warnings.length > 0, "cycle warnings emitted");
    const hasCycleWarning = result.warnings.some((w) => w.message.includes("form a dependency cycle"));
    assert.ok(hasCycleWarning, "cycle warning with correct format");
    const aIdx = result.sortedPaths.indexOf(pathA);
    const bIdx = result.sortedPaths.indexOf(pathB);
    assert.ok(aIdx < bIdx, "cycle participants appended alphabetically");
  });
  test("Test 6: self-dep \u2014 A declares dependency on itself \u2192 no warning, A still in output", (t) => {
    const dir = makeTempDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const pathA = makeExtension(dir, "self.a", ["self.a"]);
    const result = sortExtensionPaths([pathA]);
    assert.equal(result.sortedPaths.length, 1, "A still in output");
    assert.ok(result.sortedPaths.includes(pathA), "pathA in output");
    assert.equal(result.warnings.length, 0, "no warnings for self-dep");
  });
  test("Test 7: no manifest \u2014 paths without extension-manifest.json prepended in input order, zero warnings", (t) => {
    const dir = makeTempDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const noManifestA = join(dir, "no-manifest-a", "index.ts");
    const noManifestB = join(dir, "no-manifest-b", "index.ts");
    mkdirSync(join(dir, "no-manifest-a"), { recursive: true });
    mkdirSync(join(dir, "no-manifest-b"), { recursive: true });
    writeFileSync(noManifestA, "export default function() {}");
    writeFileSync(noManifestB, "export default function() {}");
    const result = sortExtensionPaths([noManifestA, noManifestB]);
    assert.equal(result.warnings.length, 0, "no warnings expected");
    assert.equal(result.sortedPaths.length, 2);
    assert.equal(result.sortedPaths[0], noManifestA);
    assert.equal(result.sortedPaths[1], noManifestB);
  });
  test("Test 8: mixed \u2014 no-manifest paths first (input order), then topologically sorted manifest paths", (t) => {
    const dir = makeTempDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const noManifestX = join(dir, "no-manifest-x", "index.ts");
    mkdirSync(join(dir, "no-manifest-x"), { recursive: true });
    writeFileSync(noManifestX, "export default function() {}");
    const pathA = makeExtension(dir, "mixed.a");
    const pathB = makeExtension(dir, "mixed.b", ["mixed.a"]);
    const result = sortExtensionPaths([noManifestX, pathB, pathA]);
    assert.equal(result.warnings.length, 0, "no warnings expected");
    assert.equal(result.sortedPaths.length, 3);
    assert.equal(result.sortedPaths[0], noManifestX, "no-manifest path must be first");
    const aIdx = result.sortedPaths.indexOf(pathA);
    const bIdx = result.sortedPaths.indexOf(pathB);
    assert.ok(aIdx < bIdx, "A must be before B (dependency order)");
  });
  test("Test 9: string deps instead of array \u2014 treated as empty, no crash, extension in output", (t) => {
    const dir = makeTempDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const extDir = join(dir, "bad.deps");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, "extension-manifest.json"), JSON.stringify({
      id: "bad.deps",
      name: "bad.deps",
      version: "1.0.0",
      description: "test",
      tier: "bundled",
      requires: { platform: "node" },
      dependencies: { extensions: "not-an-array" }
    }));
    writeFileSync(join(extDir, "index.ts"), "export default function() {}");
    const pathBadDeps = join(extDir, "index.ts");
    const result = sortExtensionPaths([pathBadDeps]);
    assert.equal(result.warnings.length, 0, "no warnings expected for string deps");
    assert.equal(result.sortedPaths.length, 1, "extension still in output");
    assert.ok(result.sortedPaths.includes(pathBadDeps), "pathBadDeps in output");
  });
  test("Test 10: null deps \u2014 treated as empty, no crash, extension in output", (t) => {
    const dir = makeTempDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const extDir = join(dir, "null.deps");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, "extension-manifest.json"), JSON.stringify({
      id: "null.deps",
      name: "null.deps",
      version: "1.0.0",
      description: "test",
      tier: "bundled",
      requires: { platform: "node" },
      dependencies: { extensions: null }
    }));
    writeFileSync(join(extDir, "index.ts"), "export default function() {}");
    const pathNullDeps = join(extDir, "index.ts");
    const result = sortExtensionPaths([pathNullDeps]);
    assert.equal(result.warnings.length, 0, "no warnings expected for null deps");
    assert.equal(result.sortedPaths.length, 1, "extension still in output");
    assert.ok(result.sortedPaths.includes(pathNullDeps), "pathNullDeps in output");
  });
  test("Test 11: numeric deps \u2014 treated as empty, no crash, extension in output", (t) => {
    const dir = makeTempDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const extDir = join(dir, "num.deps");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, "extension-manifest.json"), JSON.stringify({
      id: "num.deps",
      name: "num.deps",
      version: "1.0.0",
      description: "test",
      tier: "bundled",
      requires: { platform: "node" },
      dependencies: { extensions: 42 }
    }));
    writeFileSync(join(extDir, "index.ts"), "export default function() {}");
    const pathNumDeps = join(extDir, "index.ts");
    const result = sortExtensionPaths([pathNumDeps]);
    assert.equal(result.warnings.length, 0, "no warnings expected for numeric deps");
    assert.equal(result.sortedPaths.length, 1, "extension still in output");
    assert.ok(result.sortedPaths.includes(pathNumDeps), "pathNumDeps in output");
  });
  test("Test 12: chain with missing middle \u2014 A depends on B, B depends on missing C", (t) => {
    const dir = makeTempDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const pathA = makeExtension(dir, "chain.mid.a", ["chain.mid.b"]);
    const pathB = makeExtension(dir, "chain.mid.b", ["chain.mid.c"]);
    const result = sortExtensionPaths([pathA, pathB]);
    assert.equal(result.warnings.length, 1, "one missing dep warning for B\u2192C");
    assert.equal(result.warnings[0].declaringId, "chain.mid.b");
    assert.equal(result.warnings[0].missingId, "chain.mid.c");
    const hasCycleWarning = result.warnings.some((w) => w.message.includes("form a dependency cycle"));
    assert.ok(!hasCycleWarning, "no cycle warning expected");
    assert.equal(result.sortedPaths.length, 2);
    assert.ok(result.sortedPaths.includes(pathA), "pathA in output");
    assert.ok(result.sortedPaths.includes(pathB), "pathB in output");
    const aIdx = result.sortedPaths.indexOf(pathA);
    const bIdx = result.sortedPaths.indexOf(pathB);
    assert.ok(bIdx < aIdx, "B must appear before A");
  });
  test("Test 13: duplicate dependency declarations \u2014 A declares B twice, no double-counting", (t) => {
    const dir = makeTempDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const pathB = makeExtension(dir, "dup.b");
    const pathA = makeExtension(dir, "dup.a", ["dup.b", "dup.b"]);
    const result = sortExtensionPaths([pathA, pathB]);
    assert.equal(result.sortedPaths.length, 2);
    const aIdx = result.sortedPaths.indexOf(pathA);
    const bIdx = result.sortedPaths.indexOf(pathB);
    assert.ok(bIdx < aIdx, "B must appear before A");
    const hasCycleWarning = result.warnings.some((w) => w.message.includes("form a dependency cycle"));
    assert.ok(!hasCycleWarning, "no cycle warning expected for duplicate deps");
  });
  test("Test 14: empty paths array \u2014 returns empty result with no warnings", (_t) => {
    const result = sortExtensionPaths([]);
    assert.equal(result.warnings.length, 0, "no warnings for empty input");
    assert.equal(result.sortedPaths.length, 0, "no paths in output");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3Rlc3RzL2V4dGVuc2lvbi1zb3J0LnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRC0yIFx1MjAxNCBFeHRlbnNpb24gU29ydCBUZXN0c1xuLy8gQ29weXJpZ2h0IChjKSAyMDI2IEplcmVteSBNY1NwYWRkZW4gPGplcmVteUBmbHV4bGFicy5uZXQ+XG5cbmltcG9ydCB0ZXN0LCB7IGRlc2NyaWJlIH0gZnJvbSAnbm9kZTp0ZXN0J1xuaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydC9zdHJpY3QnXG5pbXBvcnQgeyBta2RpclN5bmMsIHdyaXRlRmlsZVN5bmMsIHJtU3luYyB9IGZyb20gJ25vZGU6ZnMnXG5pbXBvcnQgeyBqb2luLCBiYXNlbmFtZSwgZGlybmFtZSB9IGZyb20gJ25vZGU6cGF0aCdcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gJ25vZGU6b3MnXG5pbXBvcnQgeyBzb3J0RXh0ZW5zaW9uUGF0aHMgfSBmcm9tICcuLi9leHRlbnNpb24tc29ydC50cydcblxuZnVuY3Rpb24gbWFrZVRlbXBEaXIoKTogc3RyaW5nIHtcbiAgY29uc3QgZGlyID0gam9pbih0bXBkaXIoKSwgYGV4dC1zb3J0LXRlc3QtJHtEYXRlLm5vdygpfS0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIpfWApXG4gIG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pXG4gIHJldHVybiBkaXJcbn1cblxuZnVuY3Rpb24gbWFrZUV4dGVuc2lvbihiYXNlRGlyOiBzdHJpbmcsIGlkOiBzdHJpbmcsIGRlcHM/OiBzdHJpbmdbXSk6IHN0cmluZyB7XG4gIGNvbnN0IGV4dERpciA9IGpvaW4oYmFzZURpciwgaWQpXG4gIG1rZGlyU3luYyhleHREaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pXG4gIGNvbnN0IG1hbmlmZXN0ID0ge1xuICAgIGlkLFxuICAgIG5hbWU6IGlkLFxuICAgIHZlcnNpb246ICcxLjAuMCcsXG4gICAgZGVzY3JpcHRpb246ICd0ZXN0IGV4dGVuc2lvbicsXG4gICAgdGllcjogJ2J1bmRsZWQnLFxuICAgIHJlcXVpcmVzOiB7IHBsYXRmb3JtOiAnbm9kZScgfSxcbiAgICAuLi4oZGVwcyAmJiBkZXBzLmxlbmd0aCA+IDAgPyB7IGRlcGVuZGVuY2llczogeyBleHRlbnNpb25zOiBkZXBzIH0gfSA6IHt9KSxcbiAgfVxuICB3cml0ZUZpbGVTeW5jKGpvaW4oZXh0RGlyLCAnZXh0ZW5zaW9uLW1hbmlmZXN0Lmpzb24nKSwgSlNPTi5zdHJpbmdpZnkobWFuaWZlc3QpKVxuICB3cml0ZUZpbGVTeW5jKGpvaW4oZXh0RGlyLCAnaW5kZXgudHMnKSwgYGV4cG9ydCBkZWZhdWx0IGZ1bmN0aW9uKCkge31gKVxuICByZXR1cm4gam9pbihleHREaXIsICdpbmRleC50cycpXG59XG5cbmRlc2NyaWJlKCdzb3J0RXh0ZW5zaW9uUGF0aHMnLCAoKSA9PiB7XG4gIHRlc3QoJ1Rlc3QgMTogbm8gZGVwcyBcdTIwMTQgcmV0dXJucyBhbHBoYWJldGljYWxseSBzb3J0ZWQgYnkgSUQsIHplcm8gd2FybmluZ3MnLCAodCkgPT4ge1xuICAgIGNvbnN0IGRpciA9IG1ha2VUZW1wRGlyKClcbiAgICB0LmFmdGVyKCgpID0+IHJtU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSlcblxuICAgIGNvbnN0IHBhdGhDID0gbWFrZUV4dGVuc2lvbihkaXIsICd0ZXN0LmMnKVxuICAgIGNvbnN0IHBhdGhBID0gbWFrZUV4dGVuc2lvbihkaXIsICd0ZXN0LmEnKVxuICAgIGNvbnN0IHBhdGhCID0gbWFrZUV4dGVuc2lvbihkaXIsICd0ZXN0LmInKVxuXG4gICAgY29uc3QgcmVzdWx0ID0gc29ydEV4dGVuc2lvblBhdGhzKFtwYXRoQywgcGF0aEEsIHBhdGhCXSlcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQud2FybmluZ3MubGVuZ3RoLCAwLCAnbm8gd2FybmluZ3MgZXhwZWN0ZWQnKVxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc29ydGVkUGF0aHMubGVuZ3RoLCAzKVxuICAgIC8vIEEgYmVmb3JlIEIgYmVmb3JlIENcbiAgICBjb25zdCBpZHMgPSByZXN1bHQuc29ydGVkUGF0aHMubWFwKHAgPT4gYmFzZW5hbWUoZGlybmFtZShwKSkpXG4gICAgYXNzZXJ0LmRlZXBFcXVhbChpZHMsIFsndGVzdC5hJywgJ3Rlc3QuYicsICd0ZXN0LmMnXSlcbiAgfSlcblxuICB0ZXN0KCdUZXN0IDI6IGxpbmVhciBjaGFpbiBcdTIwMTQgQiBkZXBlbmRzIG9uIEEsIEEgYXBwZWFycyBiZWZvcmUgQicsICh0KSA9PiB7XG4gICAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoKVxuICAgIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKVxuXG4gICAgY29uc3QgcGF0aEEgPSBtYWtlRXh0ZW5zaW9uKGRpciwgJ2NoYWluLmEnKVxuICAgIGNvbnN0IHBhdGhCID0gbWFrZUV4dGVuc2lvbihkaXIsICdjaGFpbi5iJywgWydjaGFpbi5hJ10pXG5cbiAgICBjb25zdCByZXN1bHQgPSBzb3J0RXh0ZW5zaW9uUGF0aHMoW3BhdGhCLCBwYXRoQV0pXG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lndhcm5pbmdzLmxlbmd0aCwgMCwgJ25vIHdhcm5pbmdzIGV4cGVjdGVkJylcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnNvcnRlZFBhdGhzLmxlbmd0aCwgMilcbiAgICBjb25zdCBhSWR4ID0gcmVzdWx0LnNvcnRlZFBhdGhzLmluZGV4T2YocGF0aEEpXG4gICAgY29uc3QgYklkeCA9IHJlc3VsdC5zb3J0ZWRQYXRocy5pbmRleE9mKHBhdGhCKVxuICAgIGFzc2VydC5vayhhSWR4IDwgYklkeCwgJ0EgbXVzdCBhcHBlYXIgYmVmb3JlIEInKVxuICB9KVxuXG4gIHRlc3QoJ1Rlc3QgMzogZGlhbW9uZCBcdTIwMTQgRCBkZXBlbmRzIG9uIEIgYW5kIEM7IEIgYW5kIEMgZGVwZW5kIG9uIEEgXHUyMTkyIEEgZmlyc3QsIEIvQyBhbHBoYWJldGljYWxseSwgdGhlbiBEJywgKHQpID0+IHtcbiAgICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcigpXG4gICAgdC5hZnRlcigoKSA9PiBybVN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpXG5cbiAgICBjb25zdCBwYXRoQSA9IG1ha2VFeHRlbnNpb24oZGlyLCAnZGlhbW9uZC5hJylcbiAgICBjb25zdCBwYXRoQiA9IG1ha2VFeHRlbnNpb24oZGlyLCAnZGlhbW9uZC5iJywgWydkaWFtb25kLmEnXSlcbiAgICBjb25zdCBwYXRoQyA9IG1ha2VFeHRlbnNpb24oZGlyLCAnZGlhbW9uZC5jJywgWydkaWFtb25kLmEnXSlcbiAgICBjb25zdCBwYXRoRCA9IG1ha2VFeHRlbnNpb24oZGlyLCAnZGlhbW9uZC5kJywgWydkaWFtb25kLmInLCAnZGlhbW9uZC5jJ10pXG5cbiAgICBjb25zdCByZXN1bHQgPSBzb3J0RXh0ZW5zaW9uUGF0aHMoW3BhdGhELCBwYXRoQywgcGF0aEIsIHBhdGhBXSlcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQud2FybmluZ3MubGVuZ3RoLCAwLCAnbm8gd2FybmluZ3MgZXhwZWN0ZWQnKVxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc29ydGVkUGF0aHMubGVuZ3RoLCA0KVxuICAgIGNvbnN0IHNvcnRlZCA9IHJlc3VsdC5zb3J0ZWRQYXRoc1xuICAgIGNvbnN0IGFJZHggPSBzb3J0ZWQuaW5kZXhPZihwYXRoQSlcbiAgICBjb25zdCBiSWR4ID0gc29ydGVkLmluZGV4T2YocGF0aEIpXG4gICAgY29uc3QgY0lkeCA9IHNvcnRlZC5pbmRleE9mKHBhdGhDKVxuICAgIGNvbnN0IGRJZHggPSBzb3J0ZWQuaW5kZXhPZihwYXRoRClcblxuICAgIGFzc2VydC5vayhhSWR4IDwgYklkeCwgJ0EgbXVzdCBiZSBiZWZvcmUgQicpXG4gICAgYXNzZXJ0Lm9rKGFJZHggPCBjSWR4LCAnQSBtdXN0IGJlIGJlZm9yZSBDJylcbiAgICBhc3NlcnQub2soYklkeCA8IGRJZHgsICdCIG11c3QgYmUgYmVmb3JlIEQnKVxuICAgIGFzc2VydC5vayhjSWR4IDwgZElkeCwgJ0MgbXVzdCBiZSBiZWZvcmUgRCcpXG4gICAgYXNzZXJ0Lm9rKGJJZHggPCBjSWR4LCAnQiBiZWZvcmUgQyBhbHBoYWJldGljYWxseScpXG4gIH0pXG5cbiAgdGVzdCgnVGVzdCA0OiBtaXNzaW5nIGRlcCBcdTIwMTQgd2FybnMgd2l0aCBjb3JyZWN0IGZvcm1hdCwgZXh0ZW5zaW9uIHN0aWxsIGluIG91dHB1dCcsICh0KSA9PiB7XG4gICAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoKVxuICAgIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKVxuXG4gICAgY29uc3QgcGF0aEEgPSBtYWtlRXh0ZW5zaW9uKGRpciwgJ3Rlc3QuYScsIFsnZ3NkLm5vbmV4aXN0ZW50J10pXG5cbiAgICBjb25zdCByZXN1bHQgPSBzb3J0RXh0ZW5zaW9uUGF0aHMoW3BhdGhBXSlcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc29ydGVkUGF0aHMubGVuZ3RoLCAxLCAnQSBzdGlsbCBpbiBvdXRwdXQnKVxuICAgIGFzc2VydC5vayhyZXN1bHQuc29ydGVkUGF0aHMuaW5jbHVkZXMocGF0aEEpLCAncGF0aEEgaW4gc29ydGVkIG91dHB1dCcpXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC53YXJuaW5ncy5sZW5ndGgsIDEsICdvbmUgd2FybmluZyBmb3IgbWlzc2luZyBkZXAnKVxuICAgIGNvbnN0IHcgPSByZXN1bHQud2FybmluZ3NbMF1cbiAgICBhc3NlcnQuZXF1YWwody5kZWNsYXJpbmdJZCwgJ3Rlc3QuYScpXG4gICAgYXNzZXJ0LmVxdWFsKHcubWlzc2luZ0lkLCAnZ3NkLm5vbmV4aXN0ZW50JylcbiAgICBhc3NlcnQuZXF1YWwody5tZXNzYWdlLCBcIkV4dGVuc2lvbiAndGVzdC5hJyBkZWNsYXJlcyBkZXBlbmRlbmN5ICdnc2Qubm9uZXhpc3RlbnQnIHdoaWNoIGlzIG5vdCBpbnN0YWxsZWQgXHUyMDE0IGxvYWRpbmcgYW55d2F5XCIpXG4gIH0pXG5cbiAgdGVzdCgnVGVzdCA1OiBjeWNsZSBcdTIwMTQgQSBkZXBlbmRzIG9uIEIsIEIgZGVwZW5kcyBvbiBBIFx1MjE5MiBib3RoIGxvYWRlZCwgY3ljbGUgd2FybmluZ3MgZW1pdHRlZCwgYXBwZW5kZWQgYWxwaGFiZXRpY2FsbHknLCAodCkgPT4ge1xuICAgIGNvbnN0IGRpciA9IG1ha2VUZW1wRGlyKClcbiAgICB0LmFmdGVyKCgpID0+IHJtU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSlcblxuICAgIGNvbnN0IHBhdGhBID0gbWFrZUV4dGVuc2lvbihkaXIsICdjeWNsZS5hJywgWydjeWNsZS5iJ10pXG4gICAgY29uc3QgcGF0aEIgPSBtYWtlRXh0ZW5zaW9uKGRpciwgJ2N5Y2xlLmInLCBbJ2N5Y2xlLmEnXSlcblxuICAgIGNvbnN0IHJlc3VsdCA9IHNvcnRFeHRlbnNpb25QYXRocyhbcGF0aEEsIHBhdGhCXSlcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc29ydGVkUGF0aHMubGVuZ3RoLCAyLCAnYm90aCBleHRlbnNpb25zIGluIG91dHB1dCcpXG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5zb3J0ZWRQYXRocy5pbmNsdWRlcyhwYXRoQSksICdwYXRoQSBpbiBvdXRwdXQnKVxuICAgIGFzc2VydC5vayhyZXN1bHQuc29ydGVkUGF0aHMuaW5jbHVkZXMocGF0aEIpLCAncGF0aEIgaW4gb3V0cHV0JylcbiAgICBhc3NlcnQub2socmVzdWx0Lndhcm5pbmdzLmxlbmd0aCA+IDAsICdjeWNsZSB3YXJuaW5ncyBlbWl0dGVkJylcbiAgICBjb25zdCBoYXNDeWNsZVdhcm5pbmcgPSByZXN1bHQud2FybmluZ3Muc29tZSh3ID0+IHcubWVzc2FnZS5pbmNsdWRlcygnZm9ybSBhIGRlcGVuZGVuY3kgY3ljbGUnKSlcbiAgICBhc3NlcnQub2soaGFzQ3ljbGVXYXJuaW5nLCAnY3ljbGUgd2FybmluZyB3aXRoIGNvcnJlY3QgZm9ybWF0JylcbiAgICAvLyBBcHBlbmRlZCBhbHBoYWJldGljYWxseTogY3ljbGUuYSBiZWZvcmUgY3ljbGUuYlxuICAgIGNvbnN0IGFJZHggPSByZXN1bHQuc29ydGVkUGF0aHMuaW5kZXhPZihwYXRoQSlcbiAgICBjb25zdCBiSWR4ID0gcmVzdWx0LnNvcnRlZFBhdGhzLmluZGV4T2YocGF0aEIpXG4gICAgYXNzZXJ0Lm9rKGFJZHggPCBiSWR4LCAnY3ljbGUgcGFydGljaXBhbnRzIGFwcGVuZGVkIGFscGhhYmV0aWNhbGx5JylcbiAgfSlcblxuICB0ZXN0KCdUZXN0IDY6IHNlbGYtZGVwIFx1MjAxNCBBIGRlY2xhcmVzIGRlcGVuZGVuY3kgb24gaXRzZWxmIFx1MjE5MiBubyB3YXJuaW5nLCBBIHN0aWxsIGluIG91dHB1dCcsICh0KSA9PiB7XG4gICAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoKVxuICAgIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKVxuXG4gICAgY29uc3QgcGF0aEEgPSBtYWtlRXh0ZW5zaW9uKGRpciwgJ3NlbGYuYScsIFsnc2VsZi5hJ10pXG5cbiAgICBjb25zdCByZXN1bHQgPSBzb3J0RXh0ZW5zaW9uUGF0aHMoW3BhdGhBXSlcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc29ydGVkUGF0aHMubGVuZ3RoLCAxLCAnQSBzdGlsbCBpbiBvdXRwdXQnKVxuICAgIGFzc2VydC5vayhyZXN1bHQuc29ydGVkUGF0aHMuaW5jbHVkZXMocGF0aEEpLCAncGF0aEEgaW4gb3V0cHV0JylcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lndhcm5pbmdzLmxlbmd0aCwgMCwgJ25vIHdhcm5pbmdzIGZvciBzZWxmLWRlcCcpXG4gIH0pXG5cbiAgdGVzdCgnVGVzdCA3OiBubyBtYW5pZmVzdCBcdTIwMTQgcGF0aHMgd2l0aG91dCBleHRlbnNpb24tbWFuaWZlc3QuanNvbiBwcmVwZW5kZWQgaW4gaW5wdXQgb3JkZXIsIHplcm8gd2FybmluZ3MnLCAodCkgPT4ge1xuICAgIGNvbnN0IGRpciA9IG1ha2VUZW1wRGlyKClcbiAgICB0LmFmdGVyKCgpID0+IHJtU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSlcblxuICAgIC8vIENyZWF0ZSB0d28gcGF0aHMgd2l0aG91dCBtYW5pZmVzdHNcbiAgICBjb25zdCBub01hbmlmZXN0QSA9IGpvaW4oZGlyLCAnbm8tbWFuaWZlc3QtYScsICdpbmRleC50cycpXG4gICAgY29uc3Qgbm9NYW5pZmVzdEIgPSBqb2luKGRpciwgJ25vLW1hbmlmZXN0LWInLCAnaW5kZXgudHMnKVxuICAgIG1rZGlyU3luYyhqb2luKGRpciwgJ25vLW1hbmlmZXN0LWEnKSwgeyByZWN1cnNpdmU6IHRydWUgfSlcbiAgICBta2RpclN5bmMoam9pbihkaXIsICduby1tYW5pZmVzdC1iJyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pXG4gICAgd3JpdGVGaWxlU3luYyhub01hbmlmZXN0QSwgJ2V4cG9ydCBkZWZhdWx0IGZ1bmN0aW9uKCkge30nKVxuICAgIHdyaXRlRmlsZVN5bmMobm9NYW5pZmVzdEIsICdleHBvcnQgZGVmYXVsdCBmdW5jdGlvbigpIHt9JylcblxuICAgIGNvbnN0IHJlc3VsdCA9IHNvcnRFeHRlbnNpb25QYXRocyhbbm9NYW5pZmVzdEEsIG5vTWFuaWZlc3RCXSlcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQud2FybmluZ3MubGVuZ3RoLCAwLCAnbm8gd2FybmluZ3MgZXhwZWN0ZWQnKVxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc29ydGVkUGF0aHMubGVuZ3RoLCAyKVxuICAgIC8vIElucHV0IG9yZGVyIHByZXNlcnZlZFxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc29ydGVkUGF0aHNbMF0sIG5vTWFuaWZlc3RBKVxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc29ydGVkUGF0aHNbMV0sIG5vTWFuaWZlc3RCKVxuICB9KVxuXG4gIHRlc3QoJ1Rlc3QgODogbWl4ZWQgXHUyMDE0IG5vLW1hbmlmZXN0IHBhdGhzIGZpcnN0IChpbnB1dCBvcmRlciksIHRoZW4gdG9wb2xvZ2ljYWxseSBzb3J0ZWQgbWFuaWZlc3QgcGF0aHMnLCAodCkgPT4ge1xuICAgIGNvbnN0IGRpciA9IG1ha2VUZW1wRGlyKClcbiAgICB0LmFmdGVyKCgpID0+IHJtU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSlcblxuICAgIC8vIE5vLW1hbmlmZXN0IHBhdGhzXG4gICAgY29uc3Qgbm9NYW5pZmVzdFggPSBqb2luKGRpciwgJ25vLW1hbmlmZXN0LXgnLCAnaW5kZXgudHMnKVxuICAgIG1rZGlyU3luYyhqb2luKGRpciwgJ25vLW1hbmlmZXN0LXgnKSwgeyByZWN1cnNpdmU6IHRydWUgfSlcbiAgICB3cml0ZUZpbGVTeW5jKG5vTWFuaWZlc3RYLCAnZXhwb3J0IGRlZmF1bHQgZnVuY3Rpb24oKSB7fScpXG5cbiAgICAvLyBNYW5pZmVzdCBwYXRoczogQiBkZXBlbmRzIG9uIEFcbiAgICBjb25zdCBwYXRoQSA9IG1ha2VFeHRlbnNpb24oZGlyLCAnbWl4ZWQuYScpXG4gICAgY29uc3QgcGF0aEIgPSBtYWtlRXh0ZW5zaW9uKGRpciwgJ21peGVkLmInLCBbJ21peGVkLmEnXSlcblxuICAgIC8vIElucHV0IG9yZGVyOiBub01hbmlmZXN0WCwgcGF0aEIgKGRlcGVuZGVudCksIHBhdGhBIChkZXBlbmRlbmN5KVxuICAgIGNvbnN0IHJlc3VsdCA9IHNvcnRFeHRlbnNpb25QYXRocyhbbm9NYW5pZmVzdFgsIHBhdGhCLCBwYXRoQV0pXG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lndhcm5pbmdzLmxlbmd0aCwgMCwgJ25vIHdhcm5pbmdzIGV4cGVjdGVkJylcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnNvcnRlZFBhdGhzLmxlbmd0aCwgMylcblxuICAgIC8vIG5vLW1hbmlmZXN0IGZpcnN0XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zb3J0ZWRQYXRoc1swXSwgbm9NYW5pZmVzdFgsICduby1tYW5pZmVzdCBwYXRoIG11c3QgYmUgZmlyc3QnKVxuXG4gICAgLy8gdGhlbiBkZXBlbmRlbmN5LW9yZGVyZWQgbWFuaWZlc3RzOiBBIGJlZm9yZSBCXG4gICAgY29uc3QgYUlkeCA9IHJlc3VsdC5zb3J0ZWRQYXRocy5pbmRleE9mKHBhdGhBKVxuICAgIGNvbnN0IGJJZHggPSByZXN1bHQuc29ydGVkUGF0aHMuaW5kZXhPZihwYXRoQilcbiAgICBhc3NlcnQub2soYUlkeCA8IGJJZHgsICdBIG11c3QgYmUgYmVmb3JlIEIgKGRlcGVuZGVuY3kgb3JkZXIpJylcbiAgfSlcblxuICB0ZXN0KCdUZXN0IDk6IHN0cmluZyBkZXBzIGluc3RlYWQgb2YgYXJyYXkgXHUyMDE0IHRyZWF0ZWQgYXMgZW1wdHksIG5vIGNyYXNoLCBleHRlbnNpb24gaW4gb3V0cHV0JywgKHQpID0+IHtcbiAgICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcigpXG4gICAgdC5hZnRlcigoKSA9PiBybVN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpXG5cbiAgICBjb25zdCBleHREaXIgPSBqb2luKGRpciwgJ2JhZC5kZXBzJylcbiAgICBta2RpclN5bmMoZXh0RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KVxuICAgIHdyaXRlRmlsZVN5bmMoam9pbihleHREaXIsICdleHRlbnNpb24tbWFuaWZlc3QuanNvbicpLCBKU09OLnN0cmluZ2lmeSh7XG4gICAgICBpZDogJ2JhZC5kZXBzJywgbmFtZTogJ2JhZC5kZXBzJywgdmVyc2lvbjogJzEuMC4wJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAndGVzdCcsIHRpZXI6ICdidW5kbGVkJywgcmVxdWlyZXM6IHsgcGxhdGZvcm06ICdub2RlJyB9LFxuICAgICAgZGVwZW5kZW5jaWVzOiB7IGV4dGVuc2lvbnM6ICdub3QtYW4tYXJyYXknIH1cbiAgICB9KSlcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZXh0RGlyLCAnaW5kZXgudHMnKSwgJ2V4cG9ydCBkZWZhdWx0IGZ1bmN0aW9uKCkge30nKVxuICAgIGNvbnN0IHBhdGhCYWREZXBzID0gam9pbihleHREaXIsICdpbmRleC50cycpXG5cbiAgICBjb25zdCByZXN1bHQgPSBzb3J0RXh0ZW5zaW9uUGF0aHMoW3BhdGhCYWREZXBzXSlcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQud2FybmluZ3MubGVuZ3RoLCAwLCAnbm8gd2FybmluZ3MgZXhwZWN0ZWQgZm9yIHN0cmluZyBkZXBzJylcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnNvcnRlZFBhdGhzLmxlbmd0aCwgMSwgJ2V4dGVuc2lvbiBzdGlsbCBpbiBvdXRwdXQnKVxuICAgIGFzc2VydC5vayhyZXN1bHQuc29ydGVkUGF0aHMuaW5jbHVkZXMocGF0aEJhZERlcHMpLCAncGF0aEJhZERlcHMgaW4gb3V0cHV0JylcbiAgfSlcblxuICB0ZXN0KCdUZXN0IDEwOiBudWxsIGRlcHMgXHUyMDE0IHRyZWF0ZWQgYXMgZW1wdHksIG5vIGNyYXNoLCBleHRlbnNpb24gaW4gb3V0cHV0JywgKHQpID0+IHtcbiAgICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcigpXG4gICAgdC5hZnRlcigoKSA9PiBybVN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpXG5cbiAgICBjb25zdCBleHREaXIgPSBqb2luKGRpciwgJ251bGwuZGVwcycpXG4gICAgbWtkaXJTeW5jKGV4dERpciwgeyByZWN1cnNpdmU6IHRydWUgfSlcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZXh0RGlyLCAnZXh0ZW5zaW9uLW1hbmlmZXN0Lmpzb24nKSwgSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgaWQ6ICdudWxsLmRlcHMnLCBuYW1lOiAnbnVsbC5kZXBzJywgdmVyc2lvbjogJzEuMC4wJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAndGVzdCcsIHRpZXI6ICdidW5kbGVkJywgcmVxdWlyZXM6IHsgcGxhdGZvcm06ICdub2RlJyB9LFxuICAgICAgZGVwZW5kZW5jaWVzOiB7IGV4dGVuc2lvbnM6IG51bGwgfVxuICAgIH0pKVxuICAgIHdyaXRlRmlsZVN5bmMoam9pbihleHREaXIsICdpbmRleC50cycpLCAnZXhwb3J0IGRlZmF1bHQgZnVuY3Rpb24oKSB7fScpXG4gICAgY29uc3QgcGF0aE51bGxEZXBzID0gam9pbihleHREaXIsICdpbmRleC50cycpXG5cbiAgICBjb25zdCByZXN1bHQgPSBzb3J0RXh0ZW5zaW9uUGF0aHMoW3BhdGhOdWxsRGVwc10pXG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lndhcm5pbmdzLmxlbmd0aCwgMCwgJ25vIHdhcm5pbmdzIGV4cGVjdGVkIGZvciBudWxsIGRlcHMnKVxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc29ydGVkUGF0aHMubGVuZ3RoLCAxLCAnZXh0ZW5zaW9uIHN0aWxsIGluIG91dHB1dCcpXG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5zb3J0ZWRQYXRocy5pbmNsdWRlcyhwYXRoTnVsbERlcHMpLCAncGF0aE51bGxEZXBzIGluIG91dHB1dCcpXG4gIH0pXG5cbiAgdGVzdCgnVGVzdCAxMTogbnVtZXJpYyBkZXBzIFx1MjAxNCB0cmVhdGVkIGFzIGVtcHR5LCBubyBjcmFzaCwgZXh0ZW5zaW9uIGluIG91dHB1dCcsICh0KSA9PiB7XG4gICAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoKVxuICAgIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKVxuXG4gICAgY29uc3QgZXh0RGlyID0gam9pbihkaXIsICdudW0uZGVwcycpXG4gICAgbWtkaXJTeW5jKGV4dERpciwgeyByZWN1cnNpdmU6IHRydWUgfSlcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZXh0RGlyLCAnZXh0ZW5zaW9uLW1hbmlmZXN0Lmpzb24nKSwgSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgaWQ6ICdudW0uZGVwcycsIG5hbWU6ICdudW0uZGVwcycsIHZlcnNpb246ICcxLjAuMCcsXG4gICAgICBkZXNjcmlwdGlvbjogJ3Rlc3QnLCB0aWVyOiAnYnVuZGxlZCcsIHJlcXVpcmVzOiB7IHBsYXRmb3JtOiAnbm9kZScgfSxcbiAgICAgIGRlcGVuZGVuY2llczogeyBleHRlbnNpb25zOiA0MiB9XG4gICAgfSkpXG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGV4dERpciwgJ2luZGV4LnRzJyksICdleHBvcnQgZGVmYXVsdCBmdW5jdGlvbigpIHt9JylcbiAgICBjb25zdCBwYXRoTnVtRGVwcyA9IGpvaW4oZXh0RGlyLCAnaW5kZXgudHMnKVxuXG4gICAgY29uc3QgcmVzdWx0ID0gc29ydEV4dGVuc2lvblBhdGhzKFtwYXRoTnVtRGVwc10pXG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lndhcm5pbmdzLmxlbmd0aCwgMCwgJ25vIHdhcm5pbmdzIGV4cGVjdGVkIGZvciBudW1lcmljIGRlcHMnKVxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc29ydGVkUGF0aHMubGVuZ3RoLCAxLCAnZXh0ZW5zaW9uIHN0aWxsIGluIG91dHB1dCcpXG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5zb3J0ZWRQYXRocy5pbmNsdWRlcyhwYXRoTnVtRGVwcyksICdwYXRoTnVtRGVwcyBpbiBvdXRwdXQnKVxuICB9KVxuXG4gIHRlc3QoJ1Rlc3QgMTI6IGNoYWluIHdpdGggbWlzc2luZyBtaWRkbGUgXHUyMDE0IEEgZGVwZW5kcyBvbiBCLCBCIGRlcGVuZHMgb24gbWlzc2luZyBDJywgKHQpID0+IHtcbiAgICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcigpXG4gICAgdC5hZnRlcigoKSA9PiBybVN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpXG5cbiAgICBjb25zdCBwYXRoQSA9IG1ha2VFeHRlbnNpb24oZGlyLCAnY2hhaW4ubWlkLmEnLCBbJ2NoYWluLm1pZC5iJ10pXG4gICAgY29uc3QgcGF0aEIgPSBtYWtlRXh0ZW5zaW9uKGRpciwgJ2NoYWluLm1pZC5iJywgWydjaGFpbi5taWQuYyddKSAvLyBDIGlzIG5vdCBpbnN0YWxsZWRcblxuICAgIGNvbnN0IHJlc3VsdCA9IHNvcnRFeHRlbnNpb25QYXRocyhbcGF0aEEsIHBhdGhCXSlcblxuICAgIC8vIE1pc3NpbmcgZGVwIHdhcm5pbmcgZm9yIEJcdTIxOTJDXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC53YXJuaW5ncy5sZW5ndGgsIDEsICdvbmUgbWlzc2luZyBkZXAgd2FybmluZyBmb3IgQlx1MjE5MkMnKVxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQud2FybmluZ3NbMF0uZGVjbGFyaW5nSWQsICdjaGFpbi5taWQuYicpXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC53YXJuaW5nc1swXS5taXNzaW5nSWQsICdjaGFpbi5taWQuYycpXG5cbiAgICAvLyBObyBjeWNsZSB3YXJuaW5nXG4gICAgY29uc3QgaGFzQ3ljbGVXYXJuaW5nID0gcmVzdWx0Lndhcm5pbmdzLnNvbWUodyA9PiB3Lm1lc3NhZ2UuaW5jbHVkZXMoJ2Zvcm0gYSBkZXBlbmRlbmN5IGN5Y2xlJykpXG4gICAgYXNzZXJ0Lm9rKCFoYXNDeWNsZVdhcm5pbmcsICdubyBjeWNsZSB3YXJuaW5nIGV4cGVjdGVkJylcblxuICAgIC8vIEJvdGggQSBhbmQgQiBpbiBvdXRwdXRcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnNvcnRlZFBhdGhzLmxlbmd0aCwgMilcbiAgICBhc3NlcnQub2socmVzdWx0LnNvcnRlZFBhdGhzLmluY2x1ZGVzKHBhdGhBKSwgJ3BhdGhBIGluIG91dHB1dCcpXG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5zb3J0ZWRQYXRocy5pbmNsdWRlcyhwYXRoQiksICdwYXRoQiBpbiBvdXRwdXQnKVxuXG4gICAgLy8gQiBiZWZvcmUgQSAoQiBpcyBhIGRlcGVuZGVuY3kgb2YgQSlcbiAgICBjb25zdCBhSWR4ID0gcmVzdWx0LnNvcnRlZFBhdGhzLmluZGV4T2YocGF0aEEpXG4gICAgY29uc3QgYklkeCA9IHJlc3VsdC5zb3J0ZWRQYXRocy5pbmRleE9mKHBhdGhCKVxuICAgIGFzc2VydC5vayhiSWR4IDwgYUlkeCwgJ0IgbXVzdCBhcHBlYXIgYmVmb3JlIEEnKVxuICB9KVxuXG4gIHRlc3QoJ1Rlc3QgMTM6IGR1cGxpY2F0ZSBkZXBlbmRlbmN5IGRlY2xhcmF0aW9ucyBcdTIwMTQgQSBkZWNsYXJlcyBCIHR3aWNlLCBubyBkb3VibGUtY291bnRpbmcnLCAodCkgPT4ge1xuICAgIGNvbnN0IGRpciA9IG1ha2VUZW1wRGlyKClcbiAgICB0LmFmdGVyKCgpID0+IHJtU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSlcblxuICAgIGNvbnN0IHBhdGhCID0gbWFrZUV4dGVuc2lvbihkaXIsICdkdXAuYicpXG4gICAgY29uc3QgcGF0aEEgPSBtYWtlRXh0ZW5zaW9uKGRpciwgJ2R1cC5hJywgWydkdXAuYicsICdkdXAuYiddKVxuXG4gICAgY29uc3QgcmVzdWx0ID0gc29ydEV4dGVuc2lvblBhdGhzKFtwYXRoQSwgcGF0aEJdKVxuXG4gICAgLy8gQiBiZWZvcmUgQVxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc29ydGVkUGF0aHMubGVuZ3RoLCAyKVxuICAgIGNvbnN0IGFJZHggPSByZXN1bHQuc29ydGVkUGF0aHMuaW5kZXhPZihwYXRoQSlcbiAgICBjb25zdCBiSWR4ID0gcmVzdWx0LnNvcnRlZFBhdGhzLmluZGV4T2YocGF0aEIpXG4gICAgYXNzZXJ0Lm9rKGJJZHggPCBhSWR4LCAnQiBtdXN0IGFwcGVhciBiZWZvcmUgQScpXG5cbiAgICAvLyBObyBjeWNsZSB3YXJuaW5nXG4gICAgY29uc3QgaGFzQ3ljbGVXYXJuaW5nID0gcmVzdWx0Lndhcm5pbmdzLnNvbWUodyA9PiB3Lm1lc3NhZ2UuaW5jbHVkZXMoJ2Zvcm0gYSBkZXBlbmRlbmN5IGN5Y2xlJykpXG4gICAgYXNzZXJ0Lm9rKCFoYXNDeWNsZVdhcm5pbmcsICdubyBjeWNsZSB3YXJuaW5nIGV4cGVjdGVkIGZvciBkdXBsaWNhdGUgZGVwcycpXG4gIH0pXG5cbiAgdGVzdCgnVGVzdCAxNDogZW1wdHkgcGF0aHMgYXJyYXkgXHUyMDE0IHJldHVybnMgZW1wdHkgcmVzdWx0IHdpdGggbm8gd2FybmluZ3MnLCAoX3QpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBzb3J0RXh0ZW5zaW9uUGF0aHMoW10pXG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lndhcm5pbmdzLmxlbmd0aCwgMCwgJ25vIHdhcm5pbmdzIGZvciBlbXB0eSBpbnB1dCcpXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zb3J0ZWRQYXRocy5sZW5ndGgsIDAsICdubyBwYXRocyBpbiBvdXRwdXQnKVxuICB9KVxufSlcbiJdLAogICJtYXBwaW5ncyI6ICJBQUdBLE9BQU8sUUFBUSxnQkFBZ0I7QUFDL0IsT0FBTyxZQUFZO0FBQ25CLFNBQVMsV0FBVyxlQUFlLGNBQWM7QUFDakQsU0FBUyxNQUFNLFVBQVUsZUFBZTtBQUN4QyxTQUFTLGNBQWM7QUFDdkIsU0FBUywwQkFBMEI7QUFFbkMsU0FBUyxjQUFzQjtBQUM3QixRQUFNLE1BQU0sS0FBSyxPQUFPLEdBQUcsaUJBQWlCLEtBQUssSUFBSSxDQUFDLElBQUksS0FBSyxPQUFPLEVBQUUsU0FBUyxFQUFFLEVBQUUsTUFBTSxDQUFDLENBQUMsRUFBRTtBQUMvRixZQUFVLEtBQUssRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNsQyxTQUFPO0FBQ1Q7QUFFQSxTQUFTLGNBQWMsU0FBaUIsSUFBWSxNQUF5QjtBQUMzRSxRQUFNLFNBQVMsS0FBSyxTQUFTLEVBQUU7QUFDL0IsWUFBVSxRQUFRLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDckMsUUFBTSxXQUFXO0FBQUEsSUFDZjtBQUFBLElBQ0EsTUFBTTtBQUFBLElBQ04sU0FBUztBQUFBLElBQ1QsYUFBYTtBQUFBLElBQ2IsTUFBTTtBQUFBLElBQ04sVUFBVSxFQUFFLFVBQVUsT0FBTztBQUFBLElBQzdC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
