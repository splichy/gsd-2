import test from "node:test";
import assert from "node:assert/strict";
const { runSubprocess, resolveModulePaths } = await import("../web/subprocess-runner.js");
test("resolveModulePaths returns tsLoaderPath and validates it exists", () => {
  const packageRoot = "/fake/package";
  const result = resolveModulePaths(packageRoot, {
    modules: [{ envKey: "MOD", relativePath: "src/mod.ts" }],
    existsSync: () => true
  });
  assert.equal(
    result.tsLoaderPath,
    "/fake/package/src/resources/extensions/gsd/tests/resolve-ts.mjs"
  );
});
test("resolveModulePaths throws when TS loader is missing", () => {
  const packageRoot = "/fake/package";
  assert.throws(
    () => resolveModulePaths(packageRoot, {
      modules: [{ envKey: "MOD", relativePath: "src/mod.ts" }],
      existsSync: () => false,
      label: "test-service"
    }),
    (error) => {
      assert.match(error.message, /test-service/);
      assert.match(error.message, /not found/);
      return true;
    }
  );
});
test("resolveModulePaths throws when any module path is missing", () => {
  const packageRoot = "/fake/package";
  const existingSets = /* @__PURE__ */ new Set([
    "/fake/package/src/resources/extensions/gsd/tests/resolve-ts.mjs"
  ]);
  assert.throws(
    () => resolveModulePaths(packageRoot, {
      modules: [
        { envKey: "MOD_A", relativePath: "src/a.ts" },
        { envKey: "MOD_B", relativePath: "src/b.ts" }
      ],
      existsSync: (p) => existingSets.has(p),
      label: "multi-mod"
    }),
    (error) => {
      assert.match(error.message, /multi-mod/);
      return true;
    }
  );
});
test("resolveModulePaths returns env entries for each module", () => {
  const packageRoot = "/fake/package";
  const result = resolveModulePaths(packageRoot, {
    modules: [
      { envKey: "GSD_MOD_A", relativePath: "src/a.ts" },
      { envKey: "GSD_MOD_B", relativePath: "src/b.ts" }
    ],
    existsSync: () => true
  });
  assert.deepEqual(result.env, {
    GSD_MOD_A: "/fake/package/src/a.ts",
    GSD_MOD_B: "/fake/package/src/b.ts"
  });
});
test("runSubprocess returns parsed JSON from a child process", async () => {
  const result = await runSubprocess({
    packageRoot: process.cwd(),
    script: 'process.stdout.write(JSON.stringify({ hello: "world" }));',
    env: {},
    label: "test"
  });
  assert.deepEqual(result, { hello: "world" });
});
test("runSubprocess rejects when child process exits with error", async () => {
  await assert.rejects(
    () => runSubprocess({
      packageRoot: process.cwd(),
      script: "process.exit(1);",
      env: {},
      label: "exit-test"
    }),
    (error) => {
      assert.match(error.message, /exit-test/);
      assert.match(error.message, /subprocess failed/);
      return true;
    }
  );
});
test("runSubprocess rejects on invalid JSON output", async () => {
  await assert.rejects(
    () => runSubprocess({
      packageRoot: process.cwd(),
      script: 'process.stdout.write("not json");',
      env: {},
      label: "json-test"
    }),
    (error) => {
      assert.match(error.message, /json-test/);
      assert.match(error.message, /invalid JSON/);
      return true;
    }
  );
});
test("runSubprocess applies timeout option", async () => {
  await assert.rejects(
    () => runSubprocess({
      packageRoot: process.cwd(),
      script: "setTimeout(() => {}, 60000);",
      env: {},
      label: "timeout-test",
      timeoutMs: 500
    }),
    (error) => {
      assert.match(error.message, /timeout-test/);
      return true;
    }
  );
});
test("runSubprocess accepts custom maxBuffer", async () => {
  const result = await runSubprocess({
    packageRoot: process.cwd(),
    script: "process.stdout.write(JSON.stringify({ ok: true }));",
    env: {},
    label: "buffer-test",
    maxBuffer: 512
  });
  assert.equal(result.ok, true);
});
test("runSubprocess passes env vars to child process", async () => {
  const result = await runSubprocess({
    packageRoot: process.cwd(),
    script: "process.stdout.write(JSON.stringify({ val: process.env.TEST_VAR }));",
    env: { TEST_VAR: "hello_from_parent" },
    label: "env-test"
  });
  assert.equal(result.val, "hello_from_parent");
});
test("runSubprocess includes stderr in error message on failure", async () => {
  await assert.rejects(
    () => runSubprocess({
      packageRoot: process.cwd(),
      script: 'process.stderr.write("detailed error info"); process.exit(1);',
      env: {},
      label: "stderr-test"
    }),
    (error) => {
      assert.match(error.message, /detailed error info/);
      return true;
    }
  );
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3Rlc3RzL3dlYi1zdWJwcm9jZXNzLXJ1bm5lci50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCJcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiXG5cbmNvbnN0IHsgcnVuU3VicHJvY2VzcywgcmVzb2x2ZU1vZHVsZVBhdGhzIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi93ZWIvc3VicHJvY2Vzcy1ydW5uZXIudHNcIilcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyByZXNvbHZlTW9kdWxlUGF0aHMgXHUyMDE0IGNlbnRyYWxpc2VkIFRTIGxvYWRlciArIG1vZHVsZSBwYXRoIHJlc29sdXRpb25cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG50ZXN0KFwicmVzb2x2ZU1vZHVsZVBhdGhzIHJldHVybnMgdHNMb2FkZXJQYXRoIGFuZCB2YWxpZGF0ZXMgaXQgZXhpc3RzXCIsICgpID0+IHtcbiAgY29uc3QgcGFja2FnZVJvb3QgPSBcIi9mYWtlL3BhY2thZ2VcIlxuICBjb25zdCByZXN1bHQgPSByZXNvbHZlTW9kdWxlUGF0aHMocGFja2FnZVJvb3QsIHtcbiAgICBtb2R1bGVzOiBbeyBlbnZLZXk6IFwiTU9EXCIsIHJlbGF0aXZlUGF0aDogXCJzcmMvbW9kLnRzXCIgfV0sXG4gICAgZXhpc3RzU3luYzogKCkgPT4gdHJ1ZSxcbiAgfSlcbiAgYXNzZXJ0LmVxdWFsKFxuICAgIHJlc3VsdC50c0xvYWRlclBhdGgsXG4gICAgXCIvZmFrZS9wYWNrYWdlL3NyYy9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvdGVzdHMvcmVzb2x2ZS10cy5tanNcIixcbiAgKVxufSlcblxudGVzdChcInJlc29sdmVNb2R1bGVQYXRocyB0aHJvd3Mgd2hlbiBUUyBsb2FkZXIgaXMgbWlzc2luZ1wiLCAoKSA9PiB7XG4gIGNvbnN0IHBhY2thZ2VSb290ID0gXCIvZmFrZS9wYWNrYWdlXCJcbiAgYXNzZXJ0LnRocm93cyhcbiAgICAoKSA9PlxuICAgICAgcmVzb2x2ZU1vZHVsZVBhdGhzKHBhY2thZ2VSb290LCB7XG4gICAgICAgIG1vZHVsZXM6IFt7IGVudktleTogXCJNT0RcIiwgcmVsYXRpdmVQYXRoOiBcInNyYy9tb2QudHNcIiB9XSxcbiAgICAgICAgZXhpc3RzU3luYzogKCkgPT4gZmFsc2UsXG4gICAgICAgIGxhYmVsOiBcInRlc3Qtc2VydmljZVwiLFxuICAgICAgfSksXG4gICAgKGVycm9yOiBFcnJvcikgPT4ge1xuICAgICAgYXNzZXJ0Lm1hdGNoKGVycm9yLm1lc3NhZ2UsIC90ZXN0LXNlcnZpY2UvKVxuICAgICAgYXNzZXJ0Lm1hdGNoKGVycm9yLm1lc3NhZ2UsIC9ub3QgZm91bmQvKVxuICAgICAgcmV0dXJuIHRydWVcbiAgICB9LFxuICApXG59KVxuXG50ZXN0KFwicmVzb2x2ZU1vZHVsZVBhdGhzIHRocm93cyB3aGVuIGFueSBtb2R1bGUgcGF0aCBpcyBtaXNzaW5nXCIsICgpID0+IHtcbiAgY29uc3QgcGFja2FnZVJvb3QgPSBcIi9mYWtlL3BhY2thZ2VcIlxuICBjb25zdCBleGlzdGluZ1NldHMgPSBuZXcgU2V0KFtcbiAgICBcIi9mYWtlL3BhY2thZ2Uvc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9yZXNvbHZlLXRzLm1qc1wiLFxuICBdKVxuICBhc3NlcnQudGhyb3dzKFxuICAgICgpID0+XG4gICAgICByZXNvbHZlTW9kdWxlUGF0aHMocGFja2FnZVJvb3QsIHtcbiAgICAgICAgbW9kdWxlczogW1xuICAgICAgICAgIHsgZW52S2V5OiBcIk1PRF9BXCIsIHJlbGF0aXZlUGF0aDogXCJzcmMvYS50c1wiIH0sXG4gICAgICAgICAgeyBlbnZLZXk6IFwiTU9EX0JcIiwgcmVsYXRpdmVQYXRoOiBcInNyYy9iLnRzXCIgfSxcbiAgICAgICAgXSxcbiAgICAgICAgZXhpc3RzU3luYzogKHA6IHN0cmluZykgPT4gZXhpc3RpbmdTZXRzLmhhcyhwKSxcbiAgICAgICAgbGFiZWw6IFwibXVsdGktbW9kXCIsXG4gICAgICB9KSxcbiAgICAoZXJyb3I6IEVycm9yKSA9PiB7XG4gICAgICBhc3NlcnQubWF0Y2goZXJyb3IubWVzc2FnZSwgL211bHRpLW1vZC8pXG4gICAgICByZXR1cm4gdHJ1ZVxuICAgIH0sXG4gIClcbn0pXG5cbnRlc3QoXCJyZXNvbHZlTW9kdWxlUGF0aHMgcmV0dXJucyBlbnYgZW50cmllcyBmb3IgZWFjaCBtb2R1bGVcIiwgKCkgPT4ge1xuICBjb25zdCBwYWNrYWdlUm9vdCA9IFwiL2Zha2UvcGFja2FnZVwiXG4gIGNvbnN0IHJlc3VsdCA9IHJlc29sdmVNb2R1bGVQYXRocyhwYWNrYWdlUm9vdCwge1xuICAgIG1vZHVsZXM6IFtcbiAgICAgIHsgZW52S2V5OiBcIkdTRF9NT0RfQVwiLCByZWxhdGl2ZVBhdGg6IFwic3JjL2EudHNcIiB9LFxuICAgICAgeyBlbnZLZXk6IFwiR1NEX01PRF9CXCIsIHJlbGF0aXZlUGF0aDogXCJzcmMvYi50c1wiIH0sXG4gICAgXSxcbiAgICBleGlzdHNTeW5jOiAoKSA9PiB0cnVlLFxuICB9KVxuICBhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdC5lbnYsIHtcbiAgICBHU0RfTU9EX0E6IFwiL2Zha2UvcGFja2FnZS9zcmMvYS50c1wiLFxuICAgIEdTRF9NT0RfQjogXCIvZmFrZS9wYWNrYWdlL3NyYy9iLnRzXCIsXG4gIH0pXG59KVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIHJ1blN1YnByb2Nlc3MgXHUyMDE0IHNoYXJlZCBleGVjRmlsZSArIEpTT04ucGFyc2Ugd3JhcHBlclxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbnRlc3QoXCJydW5TdWJwcm9jZXNzIHJldHVybnMgcGFyc2VkIEpTT04gZnJvbSBhIGNoaWxkIHByb2Nlc3NcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5TdWJwcm9jZXNzPHsgaGVsbG86IHN0cmluZyB9Pih7XG4gICAgcGFja2FnZVJvb3Q6IHByb2Nlc3MuY3dkKCksXG4gICAgc2NyaXB0OiAncHJvY2Vzcy5zdGRvdXQud3JpdGUoSlNPTi5zdHJpbmdpZnkoeyBoZWxsbzogXCJ3b3JsZFwiIH0pKTsnLFxuICAgIGVudjoge30sXG4gICAgbGFiZWw6IFwidGVzdFwiLFxuICB9KVxuICBhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdCwgeyBoZWxsbzogXCJ3b3JsZFwiIH0pXG59KVxuXG50ZXN0KFwicnVuU3VicHJvY2VzcyByZWplY3RzIHdoZW4gY2hpbGQgcHJvY2VzcyBleGl0cyB3aXRoIGVycm9yXCIsIGFzeW5jICgpID0+IHtcbiAgYXdhaXQgYXNzZXJ0LnJlamVjdHMoXG4gICAgKCkgPT5cbiAgICAgIHJ1blN1YnByb2Nlc3Moe1xuICAgICAgICBwYWNrYWdlUm9vdDogcHJvY2Vzcy5jd2QoKSxcbiAgICAgICAgc2NyaXB0OiAncHJvY2Vzcy5leGl0KDEpOycsXG4gICAgICAgIGVudjoge30sXG4gICAgICAgIGxhYmVsOiBcImV4aXQtdGVzdFwiLFxuICAgICAgfSksXG4gICAgKGVycm9yOiBFcnJvcikgPT4ge1xuICAgICAgYXNzZXJ0Lm1hdGNoKGVycm9yLm1lc3NhZ2UsIC9leGl0LXRlc3QvKVxuICAgICAgYXNzZXJ0Lm1hdGNoKGVycm9yLm1lc3NhZ2UsIC9zdWJwcm9jZXNzIGZhaWxlZC8pXG4gICAgICByZXR1cm4gdHJ1ZVxuICAgIH0sXG4gIClcbn0pXG5cbnRlc3QoXCJydW5TdWJwcm9jZXNzIHJlamVjdHMgb24gaW52YWxpZCBKU09OIG91dHB1dFwiLCBhc3luYyAoKSA9PiB7XG4gIGF3YWl0IGFzc2VydC5yZWplY3RzKFxuICAgICgpID0+XG4gICAgICBydW5TdWJwcm9jZXNzKHtcbiAgICAgICAgcGFja2FnZVJvb3Q6IHByb2Nlc3MuY3dkKCksXG4gICAgICAgIHNjcmlwdDogJ3Byb2Nlc3Muc3Rkb3V0LndyaXRlKFwibm90IGpzb25cIik7JyxcbiAgICAgICAgZW52OiB7fSxcbiAgICAgICAgbGFiZWw6IFwianNvbi10ZXN0XCIsXG4gICAgICB9KSxcbiAgICAoZXJyb3I6IEVycm9yKSA9PiB7XG4gICAgICBhc3NlcnQubWF0Y2goZXJyb3IubWVzc2FnZSwgL2pzb24tdGVzdC8pXG4gICAgICBhc3NlcnQubWF0Y2goZXJyb3IubWVzc2FnZSwgL2ludmFsaWQgSlNPTi8pXG4gICAgICByZXR1cm4gdHJ1ZVxuICAgIH0sXG4gIClcbn0pXG5cbnRlc3QoXCJydW5TdWJwcm9jZXNzIGFwcGxpZXMgdGltZW91dCBvcHRpb25cIiwgYXN5bmMgKCkgPT4ge1xuICBhd2FpdCBhc3NlcnQucmVqZWN0cyhcbiAgICAoKSA9PlxuICAgICAgcnVuU3VicHJvY2Vzcyh7XG4gICAgICAgIHBhY2thZ2VSb290OiBwcm9jZXNzLmN3ZCgpLFxuICAgICAgICBzY3JpcHQ6ICdzZXRUaW1lb3V0KCgpID0+IHt9LCA2MDAwMCk7JyxcbiAgICAgICAgZW52OiB7fSxcbiAgICAgICAgbGFiZWw6IFwidGltZW91dC10ZXN0XCIsXG4gICAgICAgIHRpbWVvdXRNczogNTAwLFxuICAgICAgfSksXG4gICAgKGVycm9yOiBFcnJvcikgPT4ge1xuICAgICAgYXNzZXJ0Lm1hdGNoKGVycm9yLm1lc3NhZ2UsIC90aW1lb3V0LXRlc3QvKVxuICAgICAgcmV0dXJuIHRydWVcbiAgICB9LFxuICApXG59KVxuXG50ZXN0KFwicnVuU3VicHJvY2VzcyBhY2NlcHRzIGN1c3RvbSBtYXhCdWZmZXJcIiwgYXN5bmMgKCkgPT4ge1xuICAvLyBWZXJpZnkgaXQgZG9lcyBub3QgdGhyb3cgd2l0aCBhIHJlYXNvbmFibGUgYnVmZmVyXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1blN1YnByb2Nlc3M8eyBvazogYm9vbGVhbiB9Pih7XG4gICAgcGFja2FnZVJvb3Q6IHByb2Nlc3MuY3dkKCksXG4gICAgc2NyaXB0OiAncHJvY2Vzcy5zdGRvdXQud3JpdGUoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7JyxcbiAgICBlbnY6IHt9LFxuICAgIGxhYmVsOiBcImJ1ZmZlci10ZXN0XCIsXG4gICAgbWF4QnVmZmVyOiA1MTIsXG4gIH0pXG4gIGFzc2VydC5lcXVhbChyZXN1bHQub2ssIHRydWUpXG59KVxuXG50ZXN0KFwicnVuU3VicHJvY2VzcyBwYXNzZXMgZW52IHZhcnMgdG8gY2hpbGQgcHJvY2Vzc1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1blN1YnByb2Nlc3M8eyB2YWw6IHN0cmluZyB9Pih7XG4gICAgcGFja2FnZVJvb3Q6IHByb2Nlc3MuY3dkKCksXG4gICAgc2NyaXB0OiAncHJvY2Vzcy5zdGRvdXQud3JpdGUoSlNPTi5zdHJpbmdpZnkoeyB2YWw6IHByb2Nlc3MuZW52LlRFU1RfVkFSIH0pKTsnLFxuICAgIGVudjogeyBURVNUX1ZBUjogXCJoZWxsb19mcm9tX3BhcmVudFwiIH0sXG4gICAgbGFiZWw6IFwiZW52LXRlc3RcIixcbiAgfSlcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC52YWwsIFwiaGVsbG9fZnJvbV9wYXJlbnRcIilcbn0pXG5cbnRlc3QoXCJydW5TdWJwcm9jZXNzIGluY2x1ZGVzIHN0ZGVyciBpbiBlcnJvciBtZXNzYWdlIG9uIGZhaWx1cmVcIiwgYXN5bmMgKCkgPT4ge1xuICBhd2FpdCBhc3NlcnQucmVqZWN0cyhcbiAgICAoKSA9PlxuICAgICAgcnVuU3VicHJvY2Vzcyh7XG4gICAgICAgIHBhY2thZ2VSb290OiBwcm9jZXNzLmN3ZCgpLFxuICAgICAgICBzY3JpcHQ6ICdwcm9jZXNzLnN0ZGVyci53cml0ZShcImRldGFpbGVkIGVycm9yIGluZm9cIik7IHByb2Nlc3MuZXhpdCgxKTsnLFxuICAgICAgICBlbnY6IHt9LFxuICAgICAgICBsYWJlbDogXCJzdGRlcnItdGVzdFwiLFxuICAgICAgfSksXG4gICAgKGVycm9yOiBFcnJvcikgPT4ge1xuICAgICAgYXNzZXJ0Lm1hdGNoKGVycm9yLm1lc3NhZ2UsIC9kZXRhaWxlZCBlcnJvciBpbmZvLylcbiAgICAgIHJldHVybiB0cnVlXG4gICAgfSxcbiAgKVxufSlcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7QUFFbkIsTUFBTSxFQUFFLGVBQWUsbUJBQW1CLElBQUksTUFBTSxPQUFPLDZCQUE2QjtBQU14RixLQUFLLG1FQUFtRSxNQUFNO0FBQzVFLFFBQU0sY0FBYztBQUNwQixRQUFNLFNBQVMsbUJBQW1CLGFBQWE7QUFBQSxJQUM3QyxTQUFTLENBQUMsRUFBRSxRQUFRLE9BQU8sY0FBYyxhQUFhLENBQUM7QUFBQSxJQUN2RCxZQUFZLE1BQU07QUFBQSxFQUNwQixDQUFDO0FBQ0QsU0FBTztBQUFBLElBQ0wsT0FBTztBQUFBLElBQ1A7QUFBQSxFQUNGO0FBQ0YsQ0FBQztBQUVELEtBQUssdURBQXVELE1BQU07QUFDaEUsUUFBTSxjQUFjO0FBQ3BCLFNBQU87QUFBQSxJQUNMLE1BQ0UsbUJBQW1CLGFBQWE7QUFBQSxNQUM5QixTQUFTLENBQUMsRUFBRSxRQUFRLE9BQU8sY0FBYyxhQUFhLENBQUM7QUFBQSxNQUN2RCxZQUFZLE1BQU07QUFBQSxNQUNsQixPQUFPO0FBQUEsSUFDVCxDQUFDO0FBQUEsSUFDSCxDQUFDLFVBQWlCO0FBQ2hCLGFBQU8sTUFBTSxNQUFNLFNBQVMsY0FBYztBQUMxQyxhQUFPLE1BQU0sTUFBTSxTQUFTLFdBQVc7QUFDdkMsYUFBTztBQUFBLElBQ1Q7QUFBQSxFQUNGO0FBQ0YsQ0FBQztBQUVELEtBQUssNkRBQTZELE1BQU07QUFDdEUsUUFBTSxjQUFj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
