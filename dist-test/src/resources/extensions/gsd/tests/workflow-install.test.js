import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, sep as pathSep } from "node:path";
import { tmpdir } from "node:os";
import {
  installPlugin,
  uninstallPlugin,
  projectInstallDir
} from "../workflow-install.js";
import { parseWorkflowOverridesOnly } from "../commands/handlers/workflow.js";
const tmpDirs = [];
let savedGsdHome;
function makeTmpBase() {
  const dir = mkdtempSync(join(tmpdir(), "wf-install-test-"));
  tmpDirs.push(dir);
  return dir;
}
beforeEach(() => {
  savedGsdHome = process.env.GSD_HOME;
  process.env.GSD_HOME = makeTmpBase();
});
afterEach(() => {
  if (savedGsdHome === void 0) delete process.env.GSD_HOME;
  else process.env.GSD_HOME = savedGsdHome;
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
    }
  }
  tmpDirs.length = 0;
});
function fakeFetched(content, ext = ".yaml") {
  return {
    url: `https://example.test/raw/foo${ext}`,
    filename: `foo${ext}`,
    ext,
    content,
    sha256: "deadbeef"
  };
}
describe("workflow-install path containment", () => {
  it("installPlugin rejects names with path separators", () => {
    const base = makeTmpBase();
    const target = { dir: projectInstallDir(base), scope: "project" };
    const fetched = fakeFetched("name: ok\nsteps: []\n");
    assert.throws(() => installPlugin(target, fetched, "../evil"), /Invalid plugin name/);
    assert.throws(() => installPlugin(target, fetched, "evil/nested"), /Invalid plugin name/);
    assert.throws(() => installPlugin(target, fetched, ".."), /Invalid plugin name/);
  });
  it("uninstallPlugin rejects names with path separators", () => {
    const base = makeTmpBase();
    assert.throws(() => uninstallPlugin(base, "../evil"), /Invalid plugin name/);
    assert.throws(() => uninstallPlugin(base, "evil/nested"), /Invalid plugin name/);
  });
  it("installPlugin writes a safe name into the target dir", () => {
    const base = makeTmpBase();
    const target = { dir: projectInstallDir(base), scope: "project" };
    const fetched = fakeFetched("name: ok\nsteps: []\n");
    const result = installPlugin(target, fetched, "safe-name");
    assert.ok(result.path.startsWith(target.dir + pathSep) || result.path === join(target.dir, "safe-name.yaml"));
    assert.ok(existsSync(result.path));
  });
  it("uninstallPlugin ignores provenance entries whose filename escapes the dir", () => {
    const base = makeTmpBase();
    const target = { dir: projectInstallDir(base), scope: "project" };
    mkdirSync(target.dir, { recursive: true });
    const bogus = {
      "hijack": {
        source: "https://example.test/x",
        installedAt: (/* @__PURE__ */ new Date()).toISOString(),
        sha256: "0",
        filename: "../../etc/passwd"
      }
    };
    writeFileSync(join(target.dir, ".installed.json"), JSON.stringify(bogus), "utf-8");
    assert.throws(() => uninstallPlugin(base, "hijack"), /Invalid plugin name|Refusing to operate outside/);
  });
});
describe("parseWorkflowOverridesOnly", () => {
  it("keeps all k=v pairs when no name prefix is present", () => {
    const ov = parseWorkflowOverridesOnly("target=src/foo.ts newName=bar");
    assert.equal(ov.target, "src/foo.ts");
    assert.equal(ov.newName, "bar");
  });
  it("does not drop the first argument", () => {
    const ov = parseWorkflowOverridesOnly("a=1 b=2");
    assert.equal(ov.a, "1");
    assert.equal(ov.b, "2");
  });
  it("ignores tokens without `=`", () => {
    const ov = parseWorkflowOverridesOnly("a=1 bareword b=2");
    assert.equal(ov.a, "1");
    assert.equal(ov.b, "2");
    assert.equal(Object.keys(ov).length, 2);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy93b3JrZmxvdy1pbnN0YWxsLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIGdzZC0yIFx1MjAxNCBSZWdyZXNzaW9uIHRlc3RzIGZvciB3b3JrZmxvdy1pbnN0YWxsIHBhdGggY29udGFpbm1lbnQgYW5kIGV4dCBmYWxsYmFjay5cblxuaW1wb3J0IHsgZGVzY3JpYmUsIGl0LCBhZnRlckVhY2gsIGJlZm9yZUVhY2ggfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBybVN5bmMsIG1rZGlyU3luYywgd3JpdGVGaWxlU3luYywgZXhpc3RzU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luLCBzZXAgYXMgcGF0aFNlcCB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5cbmltcG9ydCB7XG4gIGluc3RhbGxQbHVnaW4sXG4gIHVuaW5zdGFsbFBsdWdpbixcbiAgcHJvamVjdEluc3RhbGxEaXIsXG4gIHR5cGUgRmV0Y2hlZENvbnRlbnQsXG4gIHR5cGUgSW5zdGFsbFRhcmdldCxcbn0gZnJvbSBcIi4uL3dvcmtmbG93LWluc3RhbGwudHNcIjtcbmltcG9ydCB7IHBhcnNlV29ya2Zsb3dPdmVycmlkZXNPbmx5IH0gZnJvbSBcIi4uL2NvbW1hbmRzL2hhbmRsZXJzL3dvcmtmbG93LnRzXCI7XG5cbmNvbnN0IHRtcERpcnM6IHN0cmluZ1tdID0gW107XG5sZXQgc2F2ZWRHc2RIb21lOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG5cbmZ1bmN0aW9uIG1ha2VUbXBCYXNlKCk6IHN0cmluZyB7XG4gIGNvbnN0IGRpciA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwid2YtaW5zdGFsbC10ZXN0LVwiKSk7XG4gIHRtcERpcnMucHVzaChkaXIpO1xuICByZXR1cm4gZGlyO1xufVxuXG5iZWZvcmVFYWNoKCgpID0+IHtcbiAgc2F2ZWRHc2RIb21lID0gcHJvY2Vzcy5lbnYuR1NEX0hPTUU7XG4gIHByb2Nlc3MuZW52LkdTRF9IT01FID0gbWFrZVRtcEJhc2UoKTtcbn0pO1xuXG5hZnRlckVhY2goKCkgPT4ge1xuICBpZiAoc2F2ZWRHc2RIb21lID09PSB1bmRlZmluZWQpIGRlbGV0ZSBwcm9jZXNzLmVudi5HU0RfSE9NRTtcbiAgZWxzZSBwcm9jZXNzLmVudi5HU0RfSE9NRSA9IHNhdmVkR3NkSG9tZTtcbiAgZm9yIChjb25zdCBkIG9mIHRtcERpcnMpIHtcbiAgICB0cnkgeyBybVN5bmMoZCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlLCBtYXhSZXRyaWVzOiAzLCByZXRyeURlbGF5OiA1MCB9KTsgfSBjYXRjaCB7IC8qIGlnbm9yZSAqLyB9XG4gIH1cbiAgdG1wRGlycy5sZW5ndGggPSAwO1xufSk7XG5cbmZ1bmN0aW9uIGZha2VGZXRjaGVkKGNvbnRlbnQ6IHN0cmluZywgZXh0OiBcIi55YW1sXCIgfCBcIi5tZFwiID0gXCIueWFtbFwiKTogRmV0Y2hlZENvbnRlbnQge1xuICByZXR1cm4ge1xuICAgIHVybDogYGh0dHBzOi8vZXhhbXBsZS50ZXN0L3Jhdy9mb28ke2V4dH1gLFxuICAgIGZpbGVuYW1lOiBgZm9vJHtleHR9YCxcbiAgICBleHQsXG4gICAgY29udGVudCxcbiAgICBzaGEyNTY6IFwiZGVhZGJlZWZcIixcbiAgfTtcbn1cblxuZGVzY3JpYmUoXCJ3b3JrZmxvdy1pbnN0YWxsIHBhdGggY29udGFpbm1lbnRcIiwgKCkgPT4ge1xuICBpdChcImluc3RhbGxQbHVnaW4gcmVqZWN0cyBuYW1lcyB3aXRoIHBhdGggc2VwYXJhdG9yc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gICAgY29uc3QgdGFyZ2V0OiBJbnN0YWxsVGFyZ2V0ID0geyBkaXI6IHByb2plY3RJbnN0YWxsRGlyKGJhc2UpLCBzY29wZTogXCJwcm9qZWN0XCIgfTtcbiAgICBjb25zdCBmZXRjaGVkID0gZmFrZUZldGNoZWQoXCJuYW1lOiBva1xcbnN0ZXBzOiBbXVxcblwiKTtcbiAgICBhc3NlcnQudGhyb3dzKCgpID0+IGluc3RhbGxQbHVnaW4odGFyZ2V0LCBmZXRjaGVkLCBcIi4uL2V2aWxcIiksIC9JbnZhbGlkIHBsdWdpbiBuYW1lLyk7XG4gICAgYXNzZXJ0LnRocm93cygoKSA9PiBpbnN0YWxsUGx1Z2luKHRhcmdldCwgZmV0Y2hlZCwgXCJldmlsL25lc3RlZFwiKSwgL0ludmFsaWQgcGx1Z2luIG5hbWUvKTtcbiAgICBhc3NlcnQudGhyb3dzKCgpID0+IGluc3RhbGxQbHVnaW4odGFyZ2V0LCBmZXRjaGVkLCBcIi4uXCIpLCAvSW52YWxpZCBwbHVnaW4gbmFtZS8pO1xuICB9KTtcblxuICBpdChcInVuaW5zdGFsbFBsdWdpbiByZWplY3RzIG5hbWVzIHdpdGggcGF0aCBzZXBhcmF0b3JzXCIsICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgICBhc3NlcnQudGhyb3dzKCgpID0+IHVuaW5zdGFsbFBsdWdpbihiYXNlLCBcIi4uL2V2aWxcIiksIC9JbnZhbGlkIHBsdWdpbiBuYW1lLyk7XG4gICAgYXNzZXJ0LnRocm93cygoKSA9PiB1bmluc3RhbGxQbHVnaW4oYmFzZSwgXCJldmlsL25lc3RlZFwiKSwgL0ludmFsaWQgcGx1Z2luIG5hbWUvKTtcbiAgfSk7XG5cbiAgaXQoXCJpbnN0YWxsUGx1Z2luIHdyaXRlcyBhIHNhZmUgbmFtZSBpbnRvIHRoZSB0YXJnZXQgZGlyXCIsICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgICBjb25zdCB0YXJnZXQ6IEluc3RhbGxUYXJnZXQgPSB7IGRpcjogcHJvamVjdEluc3RhbGxEaXIoYmFzZSksIHNjb3BlOiBcInByb2plY3RcIiB9O1xuICAgIGNvbnN0IGZldGNoZWQgPSBmYWtlRmV0Y2hlZChcIm5hbWU6IG9rXFxuc3RlcHM6IFtdXFxuXCIpO1xuICAgIGNvbnN0IHJlc3VsdCA9IGluc3RhbGxQbHVnaW4odGFyZ2V0LCBmZXRjaGVkLCBcInNhZmUtbmFtZVwiKTtcbiAgICBhc3NlcnQub2socmVzdWx0LnBhdGguc3RhcnRzV2l0aCh0YXJnZXQuZGlyICsgcGF0aFNlcCkgfHwgcmVzdWx0LnBhdGggPT09IGpvaW4odGFyZ2V0LmRpciwgXCJzYWZlLW5hbWUueWFtbFwiKSk7XG4gICAgYXNzZXJ0Lm9rKGV4aXN0c1N5bmMocmVzdWx0LnBhdGgpKTtcbiAgfSk7XG5cbiAgaXQoXCJ1bmluc3RhbGxQbHVnaW4gaWdub3JlcyBwcm92ZW5hbmNlIGVudHJpZXMgd2hvc2UgZmlsZW5hbWUgZXNjYXBlcyB0aGUgZGlyXCIsICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgICBjb25zdCB0YXJnZXQ6IEluc3RhbGxUYXJnZXQgPSB7IGRpcjogcHJvamVjdEluc3RhbGxEaXIoYmFzZSksIHNjb3BlOiBcInByb2plY3RcIiB9O1xuICAgIG1rZGlyU3luYyh0YXJnZXQuZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAvLyBTZWVkIGEgbWFsaWNpb3VzIHByb3ZlbmFuY2UgcmVjb3JkLlxuICAgIGNvbnN0IGJvZ3VzID0ge1xuICAgICAgXCJoaWphY2tcIjoge1xuICAgICAgICBzb3VyY2U6IFwiaHR0cHM6Ly9leGFtcGxlLnRlc3QveFwiLFxuICAgICAgICBpbnN0YWxsZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgICBzaGEyNTY6IFwiMFwiLFxuICAgICAgICBmaWxlbmFtZTogXCIuLi8uLi9ldGMvcGFzc3dkXCIsXG4gICAgICB9LFxuICAgIH07XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHRhcmdldC5kaXIsIFwiLmluc3RhbGxlZC5qc29uXCIpLCBKU09OLnN0cmluZ2lmeShib2d1cyksIFwidXRmLThcIik7XG4gICAgYXNzZXJ0LnRocm93cygoKSA9PiB1bmluc3RhbGxQbHVnaW4oYmFzZSwgXCJoaWphY2tcIiksIC9JbnZhbGlkIHBsdWdpbiBuYW1lfFJlZnVzaW5nIHRvIG9wZXJhdGUgb3V0c2lkZS8pO1xuICB9KTtcbn0pO1xuXG5kZXNjcmliZShcInBhcnNlV29ya2Zsb3dPdmVycmlkZXNPbmx5XCIsICgpID0+IHtcbiAgaXQoXCJrZWVwcyBhbGwgaz12IHBhaXJzIHdoZW4gbm8gbmFtZSBwcmVmaXggaXMgcHJlc2VudFwiLCAoKSA9PiB7XG4gICAgY29uc3Qgb3YgPSBwYXJzZVdvcmtmbG93T3ZlcnJpZGVzT25seShcInRhcmdldD1zcmMvZm9vLnRzIG5ld05hbWU9YmFyXCIpO1xuICAgIGFzc2VydC5lcXVhbChvdi50YXJnZXQsIFwic3JjL2Zvby50c1wiKTtcbiAgICBhc3NlcnQuZXF1YWwob3YubmV3TmFtZSwgXCJiYXJcIik7XG4gIH0pO1xuXG4gIGl0KFwiZG9lcyBub3QgZHJvcCB0aGUgZmlyc3QgYXJndW1lbnRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IG92ID0gcGFyc2VXb3JrZmxvd092ZXJyaWRlc09ubHkoXCJhPTEgYj0yXCIpO1xuICAgIGFzc2VydC5lcXVhbChvdi5hLCBcIjFcIik7XG4gICAgYXNzZXJ0LmVxdWFsKG92LmIsIFwiMlwiKTtcbiAgfSk7XG5cbiAgaXQoXCJpZ25vcmVzIHRva2VucyB3aXRob3V0IGA9YFwiLCAoKSA9PiB7XG4gICAgY29uc3Qgb3YgPSBwYXJzZVdvcmtmbG93T3ZlcnJpZGVzT25seShcImE9MSBiYXJld29yZCBiPTJcIik7XG4gICAgYXNzZXJ0LmVxdWFsKG92LmEsIFwiMVwiKTtcbiAgICBhc3NlcnQuZXF1YWwob3YuYiwgXCIyXCIpO1xuICAgIGFzc2VydC5lcXVhbChPYmplY3Qua2V5cyhvdikubGVuZ3RoLCAyKTtcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUVBLFNBQVMsVUFBVSxJQUFJ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
