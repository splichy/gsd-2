import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveExtensionEntries } from "../extension-discovery.js";
function makeTempDir() {
  const dir = join(tmpdir(), `nonext-lib-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
describe("resolveExtensionEntries \u2014 #1709 defence-in-depth", () => {
  test("cmux pattern: pi: {} with an index.js returns no entries", (t) => {
    const root = makeTempDir();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const libDir = join(root, "cmux");
    mkdirSync(libDir);
    writeFileSync(
      join(libDir, "package.json"),
      JSON.stringify({
        name: "@gsd/cmux",
        description: "cmux integration library \u2014 used by other extensions, not an extension itself",
        pi: {}
      })
    );
    writeFileSync(join(libDir, "index.js"), "module.exports.utility = function() {}");
    assert.deepEqual(
      resolveExtensionEntries(libDir),
      [],
      "pi: {} opts out of discovery so the loader never tries a factory call"
    );
  });
  test("pi.extensions: [] returns no entries", (t) => {
    const root = makeTempDir();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const libDir = join(root, "lib-empty");
    mkdirSync(libDir);
    writeFileSync(
      join(libDir, "package.json"),
      JSON.stringify({ name: "lib-empty", pi: { extensions: [] } })
    );
    writeFileSync(join(libDir, "index.js"), "module.exports.helper = function() {}");
    assert.deepEqual(resolveExtensionEntries(libDir), []);
  });
  test("pi present with other fields but no extensions \u2192 no entries (skills-only library)", (t) => {
    const root = makeTempDir();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const libDir = join(root, "lib-with-skills");
    mkdirSync(libDir);
    writeFileSync(
      join(libDir, "package.json"),
      JSON.stringify({
        name: "lib-with-skills",
        pi: { skills: ["./my-skill.md"] }
      })
    );
    writeFileSync(join(libDir, "index.js"), "module.exports.helper = function() {}");
    assert.deepEqual(resolveExtensionEntries(libDir), []);
  });
  test("declared pi.extensions entries are resolved to absolute paths", (t) => {
    const root = makeTempDir();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const extDir = join(root, "declared-ext");
    mkdirSync(extDir);
    writeFileSync(
      join(extDir, "package.json"),
      JSON.stringify({ name: "declared-ext", pi: { extensions: ["./index.js"] } })
    );
    writeFileSync(join(extDir, "index.js"), "module.exports = () => ({})");
    const entries = resolveExtensionEntries(extDir);
    assert.deepEqual(entries, [join(extDir, "index.js")]);
  });
  test("no package.json, no pi manifest \u2192 falls back to index.js (pre-#1709 behaviour)", (t) => {
    const root = makeTempDir();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const extDir = join(root, "legacy-ext");
    mkdirSync(extDir);
    writeFileSync(join(extDir, "index.js"), "module.exports = () => ({})");
    assert.deepEqual(resolveExtensionEntries(extDir), [join(extDir, "index.js")]);
  });
  test("package.json without a pi manifest falls back to index.js discovery", (t) => {
    const root = makeTempDir();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const extDir = join(root, "broken-ext");
    mkdirSync(extDir);
    writeFileSync(join(extDir, "package.json"), JSON.stringify({ name: "broken-ext" }));
    writeFileSync(join(extDir, "index.js"), "module.exports.notAFactory = function() {}");
    assert.deepEqual(resolveExtensionEntries(extDir), [join(extDir, "index.js")]);
  });
  test("malformed package.json falls back to index.js discovery", (t) => {
    const root = makeTempDir();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const badDir = join(root, "bad-json");
    mkdirSync(badDir);
    writeFileSync(join(badDir, "package.json"), "not valid json {{{");
    writeFileSync(join(badDir, "index.js"), "module.exports = () => ({})");
    assert.deepEqual(resolveExtensionEntries(badDir), [join(badDir, "index.js")]);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3Rlc3RzL25vbi1leHRlbnNpb24tbGlicmFyeS50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFJlZ3Jlc3Npb24gdGVzdHMgZm9yICMxNzA5OiBub24tZXh0ZW5zaW9uIGxpYnJhcmllcyBpbiBleHRlbnNpb25zLyBkaXJlY3RvcnlcbiAqIG11c3Qgbm90IHByb2R1Y2Ugc3B1cmlvdXMgXCJFeHRlbnNpb24gZG9lcyBub3QgZXhwb3J0IGEgdmFsaWQgZmFjdG9yeSBmdW5jdGlvblwiXG4gKiBlcnJvcnMuXG4gKlxuICogVGhlIGRlZmVuY2UtaW4tZGVwdGggdGhhdCBjbG9zZWQgIzE3MDkgbW92ZWQgZnJvbSBgbG9hZGVyLnRzYCAoYW4gYWQtaG9jXG4gKiBgaXNOb25FeHRlbnNpb25MaWJyYXJ5YCBwcmVkaWNhdGUpIGludG8gYHJlc29sdmVFeHRlbnNpb25FbnRyaWVzYCBpblxuICogYHNyYy9leHRlbnNpb24tZGlzY292ZXJ5LnRzYDogd2hlbiBhIGRpcmVjdG9yeSdzIHBhY2thZ2UuanNvbiBjYXJyaWVzIGFcbiAqIGBwaWAgbWFuaWZlc3Qgd2l0aCBubyBleHRlbnNpb25zLCB0aGUgZGlzY292ZXJ5IHN0ZXAgcmV0dXJucyBgW11gIHNvIHRoZVxuICogbG9hZGVyIG5ldmVyIGF0dGVtcHRzIGEgZmFjdG9yeSBjYWxsLiBUaGVzZSB0ZXN0cyBleGVyY2lzZSB0aGF0IHJlYWxcbiAqIGZ1bmN0aW9uIGRpcmVjdGx5IFx1MjAxNCBhIHByaW9yIHJldmlzaW9uIGR1cGxpY2F0ZWQgdGhlIGFsZ29yaXRobSBpbnRvIHRoZVxuICogdGVzdCBmaWxlIChkZWFkIHRlc3Q6IGJvdGggY29waWVzIGNvdWxkIGRyaWZ0IGluZGVwZW5kZW50bHkpLlxuICovXG5pbXBvcnQgdGVzdCwgeyBkZXNjcmliZSB9IGZyb20gJ25vZGU6dGVzdCdcbmltcG9ydCBhc3NlcnQgZnJvbSAnbm9kZTphc3NlcnQvc3RyaWN0J1xuaW1wb3J0IHsgbWtkaXJTeW5jLCB3cml0ZUZpbGVTeW5jLCBybVN5bmMgfSBmcm9tICdub2RlOmZzJ1xuaW1wb3J0IHsgam9pbiB9IGZyb20gJ25vZGU6cGF0aCdcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gJ25vZGU6b3MnXG5cbmltcG9ydCB7IHJlc29sdmVFeHRlbnNpb25FbnRyaWVzIH0gZnJvbSAnLi4vZXh0ZW5zaW9uLWRpc2NvdmVyeS50cydcblxuZnVuY3Rpb24gbWFrZVRlbXBEaXIoKTogc3RyaW5nIHtcbiAgY29uc3QgZGlyID0gam9pbih0bXBkaXIoKSwgYG5vbmV4dC1saWItdGVzdC0ke0RhdGUubm93KCl9LSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMil9YClcbiAgbWtkaXJTeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSlcbiAgcmV0dXJuIGRpclxufVxuXG5kZXNjcmliZSgncmVzb2x2ZUV4dGVuc2lvbkVudHJpZXMgXHUyMDE0ICMxNzA5IGRlZmVuY2UtaW4tZGVwdGgnLCAoKSA9PiB7XG4gIHRlc3QoJ2NtdXggcGF0dGVybjogcGk6IHt9IHdpdGggYW4gaW5kZXguanMgcmV0dXJucyBubyBlbnRyaWVzJywgKHQpID0+IHtcbiAgICBjb25zdCByb290ID0gbWFrZVRlbXBEaXIoKVxuICAgIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKHJvb3QsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSlcbiAgICBjb25zdCBsaWJEaXIgPSBqb2luKHJvb3QsICdjbXV4JylcbiAgICBta2RpclN5bmMobGliRGlyKVxuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKGxpYkRpciwgJ3BhY2thZ2UuanNvbicpLFxuICAgICAgSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBuYW1lOiAnQGdzZC9jbXV4JyxcbiAgICAgICAgZGVzY3JpcHRpb246XG4gICAgICAgICAgJ2NtdXggaW50ZWdyYXRpb24gbGlicmFyeSBcdTIwMTQgdXNlZCBieSBvdGhlciBleHRlbnNpb25zLCBub3QgYW4gZXh0ZW5zaW9uIGl0c2VsZicsXG4gICAgICAgIHBpOiB7fSxcbiAgICAgIH0pLFxuICAgIClcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4obGliRGlyLCAnaW5kZXguanMnKSwgJ21vZHVsZS5leHBvcnRzLnV0aWxpdHkgPSBmdW5jdGlvbigpIHt9JylcblxuICAgIGFzc2VydC5kZWVwRXF1YWwoXG4gICAgICByZXNvbHZlRXh0ZW5zaW9uRW50cmllcyhsaWJEaXIpLFxuICAgICAgW10sXG4gICAgICAncGk6IHt9IG9wdHMgb3V0IG9mIGRpc2NvdmVyeSBzbyB0aGUgbG9hZGVyIG5ldmVyIHRyaWVzIGEgZmFjdG9yeSBjYWxsJyxcbiAgICApXG4gIH0pXG5cbiAgdGVzdCgncGkuZXh0ZW5zaW9uczogW10gcmV0dXJucyBubyBlbnRyaWVzJywgKHQpID0+IHtcbiAgICBjb25zdCByb290ID0gbWFrZVRlbXBEaXIoKVxuICAgIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKHJvb3QsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSlcbiAgICBjb25zdCBsaWJEaXIgPSBqb2luKHJvb3QsICdsaWItZW1wdHknKVxuICAgIG1rZGlyU3luYyhsaWJEaXIpXG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4obGliRGlyLCAncGFja2FnZS5qc29uJyksXG4gICAgICBKU09OLnN0cmluZ2lmeSh7IG5hbWU6ICdsaWItZW1wdHknLCBwaTogeyBleHRlbnNpb25zOiBbXSB9IH0pLFxuICAgIClcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4obGliRGlyLCAnaW5kZXguanMnKSwgJ21vZHVsZS5leHBvcnRzLmhlbHBlciA9IGZ1bmN0aW9uKCkge30nKVxuXG4gICAgYXNzZXJ0LmRlZXBFcXVhbChyZXNvbHZlRXh0ZW5zaW9uRW50cmllcyhsaWJEaXIpLCBbXSlcbiAgfSlcblxuICB0ZXN0KCdwaSBwcmVzZW50IHdpdGggb3RoZXIgZmllbGRzIGJ1dCBubyBleHRlbnNpb25zIFx1MjE5MiBubyBlbnRyaWVzIChza2lsbHMtb25seSBsaWJyYXJ5KScsICh0KSA9PiB7XG4gICAgY29uc3Qgcm9vdCA9IG1ha2VUZW1wRGlyKClcbiAgICB0LmFmdGVyKCgpID0+IHJtU3luYyhyb290LCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpXG4gICAgY29uc3QgbGliRGlyID0gam9pbihyb290LCAnbGliLXdpdGgtc2tpbGxzJylcbiAgICBta2RpclN5bmMobGliRGlyKVxuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKGxpYkRpciwgJ3BhY2thZ2UuanNvbicpLFxuICAgICAgSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBuYW1lOiAnbGliLXdpdGgtc2tpbGxzJyxcbiAgICAgICAgcGk6IHsgc2tpbGxzOiBbJy4vbXktc2tpbGwubWQnXSB9LFxuICAgICAgfSksXG4gICAgKVxuICAgIHdyaXRlRmlsZVN5bmMoam9pbihsaWJEaXIsICdpbmRleC5qcycpLCAnbW9kdWxlLmV4cG9ydHMuaGVscGVyID0gZnVuY3Rpb24oKSB7fScpXG5cbiAgICBhc3NlcnQuZGVlcEVxdWFsKHJlc29sdmVFeHRlbnNpb25FbnRyaWVzKGxpYkRpciksIFtdKVxuICB9KVxuXG4gIHRlc3QoJ2RlY2xhcmVkIHBpLmV4dGVuc2lvbnMgZW50cmllcyBhcmUgcmVzb2x2ZWQgdG8gYWJzb2x1dGUgcGF0aHMnLCAodCkgPT4ge1xuICAgIGNvbnN0IHJvb3QgPSBtYWtlVGVtcERpcigpXG4gICAgdC5hZnRlcigoKSA9PiBybVN5bmMocm9vdCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKVxuICAgIGNvbnN0IGV4dERpciA9IGpvaW4ocm9vdCwgJ2RlY2xhcmVkLWV4dCcpXG4gICAgbWtkaXJTeW5jKGV4dERpcilcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihleHREaXIsICdwYWNrYWdlLmpzb24nKSxcbiAgICAgIEpTT04uc3RyaW5naWZ5KHsgbmFtZTogJ2RlY2xhcmVkLWV4dCcsIHBpOiB7IGV4dGVuc2lvbnM6IFsnLi9pbmRleC5qcyddIH0gfSksXG4gICAgKVxuICAgIHdyaXRlRmlsZVN5bmMoam9pbihleHREaXIsICdpbmRleC5qcycpLCAnbW9kdWxlLmV4cG9ydHMgPSAoKSA9PiAoe30pJylcblxuICAgIGNvbnN0IGVudHJpZXMgPSByZXNvbHZlRXh0ZW5zaW9uRW50cmllcyhleHREaXIpXG4gICAgYXNzZXJ0LmRlZXBFcXVhbChlbnRyaWVzLCBbam9pbihleHREaXIsICdpbmRleC5qcycpXSlcbiAgfSlcblxuICB0ZXN0KCdubyBwYWNrYWdlLmpzb24sIG5vIHBpIG1hbmlmZXN0IFx1MjE5MiBmYWxscyBiYWNrIHRvIGluZGV4LmpzIChwcmUtIzE3MDkgYmVoYXZpb3VyKScsICh0KSA9PiB7XG4gICAgY29uc3Qgcm9vdCA9IG1ha2VUZW1wRGlyKClcbiAgICB0LmFmdGVyKCgpID0+IHJtU3luYyhyb290LCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpXG4gICAgY29uc3QgZXh0RGlyID0gam9pbihyb290LCAnbGVnYWN5LWV4dCcpXG4gICAgbWtkaXJTeW5jKGV4dERpcilcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZXh0RGlyLCAnaW5kZXguanMnKSwgJ21vZHVsZS5leHBvcnRzID0gKCkgPT4gKHt9KScpXG5cbiAgICBhc3NlcnQuZGVlcEVxdWFsKHJlc29sdmVFeHRlbnNpb25FbnRyaWVzKGV4dERpciksIFtqb2luKGV4dERpciwgJ2luZGV4LmpzJyldKVxuICB9KVxuXG4gIHRlc3QoJ3BhY2thZ2UuanNvbiB3aXRob3V0IGEgcGkgbWFuaWZlc3QgZmFsbHMgYmFjayB0byBpbmRleC5qcyBkaXNjb3ZlcnknLCAodCkgPT4ge1xuICAgIGNvbnN0IHJvb3QgPSBtYWtlVGVtcERpcigpXG4gICAgdC5hZnRlcigoKSA9PiBybVN5bmMocm9vdCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKVxuICAgIGNvbnN0IGV4dERpciA9IGpvaW4ocm9vdCwgJ2Jyb2tlbi1leHQnKVxuICAgIG1rZGlyU3luYyhleHREaXIpXG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGV4dERpciwgJ3BhY2thZ2UuanNvbicpLCBKU09OLnN0cmluZ2lmeSh7IG5hbWU6ICdicm9rZW4tZXh0JyB9KSlcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZXh0RGlyLCAnaW5kZXguanMnKSwgJ21vZHVsZS5leHBvcnRzLm5vdEFGYWN0b3J5ID0gZnVuY3Rpb24oKSB7fScpXG5cbiAgICAvLyBObyBwaSBtYW5pZmVzdCBcdTIxOTIgbm90IGEgIzE3MDkgb3B0LW91dC4gRGlzY292ZXJ5IGZhbGxzIHRocm91Z2ggdG9cbiAgICAvLyBpbmRleC5qczsgZG93bnN0cmVhbSBsb2FkZXIgc3VyZmFjZXMgdGhlIFwibm90IGEgZmFjdG9yeVwiIGVycm9yXG4gICAgLy8gKHRoYXQncyBleGFjdGx5IHdoYXQgdGhlIGN1cnJlbnQgYmVoYXZpb3VyIGlzIGFuZCB3aGF0ICMxNzA5IGxlZnRcbiAgICAvLyAgaW50YWN0IGZvciByZWFsIGJyb2tlbiBleHRlbnNpb25zKS5cbiAgICBhc3NlcnQuZGVlcEVxdWFsKHJlc29sdmVFeHRlbnNpb25FbnRyaWVzKGV4dERpciksIFtqb2luKGV4dERpciwgJ2luZGV4LmpzJyldKVxuICB9KVxuXG4gIHRlc3QoJ21hbGZvcm1lZCBwYWNrYWdlLmpzb24gZmFsbHMgYmFjayB0byBpbmRleC5qcyBkaXNjb3ZlcnknLCAodCkgPT4ge1xuICAgIGNvbnN0IHJvb3QgPSBtYWtlVGVtcERpcigpXG4gICAgdC5hZnRlcigoKSA9PiBybVN5bmMocm9vdCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKVxuICAgIGNvbnN0IGJhZERpciA9IGpvaW4ocm9vdCwgJ2JhZC1qc29uJylcbiAgICBta2RpclN5bmMoYmFkRGlyKVxuICAgIHdyaXRlRmlsZVN5bmMoam9pbihiYWREaXIsICdwYWNrYWdlLmpzb24nKSwgJ25vdCB2YWxpZCBqc29uIHt7eycpXG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGJhZERpciwgJ2luZGV4LmpzJyksICdtb2R1bGUuZXhwb3J0cyA9ICgpID0+ICh7fSknKVxuXG4gICAgLy8gUGFyc2UgZXJyb3IgaXMgY2F1Z2h0OyBkaXNjb3ZlcnkgY29udGludWVzIHdpdGggaW5kZXguanMgZmFsbGJhY2suXG4gICAgYXNzZXJ0LmRlZXBFcXVhbChyZXNvbHZlRXh0ZW5zaW9uRW50cmllcyhiYWREaXIpLCBbam9pbihiYWREaXIsICdpbmRleC5qcycpXSlcbiAgfSlcbn0pXG4iXSwKICAibWFwcGluZ3MiOiAiQUFhQSxPQUFPLFFBQVEsZ0JBQWdCO0FBQy9CLE9BQU8sWUFBWTtBQUNuQixTQUFTLFdBQVcsZUFBZSxjQUFjO0FBQ2pELFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFFdkIsU0FBUywrQkFBK0I7QUFFeEMsU0FBUyxjQUFzQjtBQUM3QixRQUFNLE1BQU0sS0FBSyxPQUFPLEdBQUcsbUJBQW1CLEtBQUssSUFBSSxDQUFDLElBQUksS0FBSyxPQUFPLEVBQUUsU0FBUyxFQUFFLEVBQUUsTUFBTSxDQUFDLENBQUMsRUFBRTtBQUNqRyxZQUFVLEtBQUssRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNsQyxTQUFPO0FBQ1Q7QUFFQSxTQUFTLHlEQUFvRCxNQUFNO0FBQ2pFLE9BQUssNERBQTRELENBQUMsTUFBTTtBQUN0RSxVQUFNLE9BQU8sWUFBWTtBQUN6QixNQUFFLE1BQU0sTUFBTSxPQUFPLE1BQU0sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUMsQ0FBQztBQUM1RCxVQUFNLFNBQVMsS0FBSyxNQUFNLE1BQU07QUFDaEMsY0FBVSxNQUFNO0FBQ2hCO0FBQUEsTUFDRSxLQUFLLFFBQVEsY0FBYztBQUFBLE1BQzNCLEtBQUssVUFBVTtBQUFBLFFBQ2IsTUFBTTtBQUFBLFFBQ04sYUFDRTtBQUFBLFFBQ0YsSUFBSSxDQUFDO0FBQUEsTUFDUCxDQUFDO0FBQUEsSUFDSDtBQUNBLGtCQUFjLEtBQUssUUFBUSxVQUFVLEdB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
