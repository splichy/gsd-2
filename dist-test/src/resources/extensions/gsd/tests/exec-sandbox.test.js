import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXEC_DEFAULTS, runExecSandbox } from "../exec-sandbox.js";
import { buildExecOptions, executeGsdExec } from "../tools/exec-tool.js";
import { isContextModeEnabled } from "../preferences-types.js";
import { validatePreferences } from "../preferences-validation.js";
function freshBase() {
  return mkdtempSync(join(tmpdir(), "gsd-exec-test-"));
}
function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}
function baseOpts(base, overrides = {}) {
  return {
    baseDir: base,
    clamp_timeout_ms: EXEC_DEFAULTS.clampTimeoutMs,
    default_timeout_ms: 1e4,
    stdout_cap_bytes: 1024,
    stderr_cap_bytes: 1024,
    digest_chars: 120,
    env_allowlist: EXEC_DEFAULTS.envAllowlist,
    ...overrides
  };
}
test("runExecSandbox: captures stdout, persists artifacts, returns digest", async () => {
  const base = freshBase();
  try {
    const result = await runExecSandbox(
      { runtime: "bash", script: "echo hello world" },
      baseOpts(base)
    );
    assert.equal(result.exit_code, 0);
    assert.equal(result.timed_out, false);
    assert.ok(result.digest.includes("hello world"), `digest should contain stdout: ${result.digest}`);
    assert.ok(result.stdout_path.startsWith(join(base, ".gsd", "exec")), "stdout path under .gsd/exec");
    assert.equal(readFileSync(result.stdout_path, "utf-8").trim(), "hello world");
    const meta = JSON.parse(readFileSync(result.meta_path, "utf-8"));
    assert.equal(meta.runtime, "bash");
    assert.equal(meta.exit_code, 0);
  } finally {
    cleanup(base);
  }
});
test("runExecSandbox: enforces stdout cap and marks truncation", async () => {
  const base = freshBase();
  try {
    const result = await runExecSandbox(
      // Emit far more than the cap so truncation triggers.
      { runtime: "bash", script: "head -c 8000 /dev/urandom | base64" },
      baseOpts(base, { stdout_cap_bytes: 256 })
    );
    assert.equal(result.stdout_truncated, true, "should mark stdout truncated");
    assert.ok(result.stdout_bytes <= 256, `stdout_bytes within cap (got ${result.stdout_bytes})`);
    const stdout = readFileSync(result.stdout_path, "utf-8");
    assert.ok(stdout.endsWith("[truncated: stdout cap reached]\n"), "truncation marker appended");
  } finally {
    cleanup(base);
  }
});
test("runExecSandbox: enforces timeout and surfaces timed_out", async () => {
  const base = freshBase();
  try {
    const started = Date.now();
    const result = await runExecSandbox(
      { runtime: "bash", script: "sleep 10" },
      baseOpts(base, { default_timeout_ms: 150, clamp_timeout_ms: 150 })
    );
    const elapsed = Date.now() - started;
    assert.equal(result.timed_out, true);
    assert.ok(elapsed < 5e3, `should return well before 10s (took ${elapsed}ms)`);
  } finally {
    cleanup(base);
  }
});
test("runExecSandbox: forwards only allowlisted env vars", async () => {
  const base = freshBase();
  try {
    const result = await runExecSandbox(
      { runtime: "bash", script: "echo PATH=$PATH SECRET=$GSD_TEST_SECRET" },
      baseOpts(base, {
        env_allowlist: [],
        env: { PATH: "/usr/bin:/bin", HOME: "/tmp", GSD_TEST_SECRET: "should-be-blocked" }
      })
    );
    const stdout = readFileSync(result.stdout_path, "utf-8");
    assert.ok(stdout.includes("PATH=/usr/bin:/bin"), "PATH forwarded");
    assert.ok(!stdout.includes("should-be-blocked"), "non-allowlisted var blocked");
  } finally {
    cleanup(base);
  }
});
test("runExecSandbox: node runtime executes JS", async () => {
  const base = freshBase();
  try {
    const result = await runExecSandbox(
      { runtime: "node", script: 'console.log("node-ok:" + (1+2))' },
      baseOpts(base)
    );
    assert.equal(result.exit_code, 0);
    assert.ok(result.digest.includes("node-ok:3"));
  } finally {
    cleanup(base);
  }
});
test("executeGsdExec: runs by default when context_mode is unset", async () => {
  const base = freshBase();
  try {
    const result = await executeGsdExec(
      { runtime: "bash", script: "echo default-on-run" },
      { baseDir: base, preferences: {} }
    );
    assert.ok(!result.isError, "should succeed with no preferences");
    assert.equal(result.details.operation, "gsd_exec");
    assert.equal(result.details.exit_code, 0);
    assert.ok(result.content[0].text.includes("default-on-run"));
  } finally {
    cleanup(base);
  }
});
test("executeGsdExec: runs when preferences is null (fresh project)", async () => {
  const base = freshBase();
  try {
    const result = await executeGsdExec(
      { runtime: "bash", script: "echo null-prefs-run" },
      { baseDir: base, preferences: null }
    );
    assert.ok(!result.isError, "null preferences should not disable");
    assert.ok(result.content[0].text.includes("null-prefs-run"));
  } finally {
    cleanup(base);
  }
});
test("executeGsdExec: blocked only when context_mode.enabled=false", async () => {
  const base = freshBase();
  try {
    const result = await executeGsdExec(
      { runtime: "bash", script: "echo should-not-run" },
      { baseDir: base, preferences: { context_mode: { enabled: false } } }
    );
    assert.equal(result.isError, true);
    assert.equal(result.details.error, "context_mode_disabled");
  } finally {
    cleanup(base);
  }
});
test("executeGsdExec: runs when enabled explicitly set to true", async () => {
  const base = freshBase();
  try {
    const result = await executeGsdExec(
      { runtime: "bash", script: "echo explicit-on" },
      { baseDir: base, preferences: { context_mode: { enabled: true } } }
    );
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("explicit-on"));
  } finally {
    cleanup(base);
  }
});
test("executeGsdExec: forwards custom exec_env_allowlist from preferences", async () => {
  const base = freshBase();
  try {
    const result = await executeGsdExec(
      {
        runtime: "bash",
        script: 'printf "allowed=%s blocked=%s\\n" "$GSD_ALLOWED" "$GSD_BLOCKED"'
      },
      {
        baseDir: base,
        preferences: {
          context_mode: {
            enabled: true,
            exec_env_allowlist: ["GSD_ALLOWED"]
          }
        },
        env: {
          PATH: "/usr/bin:/bin",
          HOME: "/tmp",
          GSD_ALLOWED: "yes",
          GSD_BLOCKED: "no"
        }
      }
    );
    assert.ok(!result.isError);
    assert.match(result.content[0].text, /allowed=yes blocked=/);
    assert.doesNotMatch(result.content[0].text, /blocked=no/);
  } finally {
    cleanup(base);
  }
});
test("executeGsdExec: enforces per-call timeout override end-to-end", async () => {
  const base = freshBase();
  try {
    const result = await executeGsdExec(
      { runtime: "bash", script: "sleep 2", timeout_ms: 1 },
      { baseDir: base, preferences: { context_mode: { enabled: true, exec_timeout_ms: 1e4 } } }
    );
    assert.equal(result.details.timed_out, true);
    assert.equal(result.isError, true);
  } finally {
    cleanup(base);
  }
});
test("executeGsdExec: rejects empty script", async () => {
  const base = freshBase();
  try {
    const result = await executeGsdExec(
      { runtime: "bash", script: "   " },
      { baseDir: base, preferences: { context_mode: { enabled: true } } }
    );
    assert.equal(result.isError, true);
    assert.equal(result.details.error, "invalid_params");
  } finally {
    cleanup(base);
  }
});
test("validatePreferences: rejects invalid context_mode preference values", () => {
  const result = validatePreferences({
    context_mode: {
      enabled: "false",
      exec_timeout_ms: 999,
      exec_stdout_cap_bytes: 1,
      exec_digest_chars: -1,
      exec_env_allowlist: ["GOOD_NAME", "bad-name"]
    }
  });
  assert.ok(result.errors.length > 0);
  assert.ok(result.errors.includes("context_mode.enabled must be a boolean"));
  assert.ok(result.errors.includes("context_mode.exec_timeout_ms must be a number between 1000 and 600000"));
  assert.ok(result.errors.includes("context_mode.exec_stdout_cap_bytes must be a number between 4096 and 16777216"));
  assert.ok(result.errors.includes("context_mode.exec_digest_chars must be a number between 0 and 4000"));
  assert.ok(result.errors.includes("context_mode.exec_env_allowlist must be an array of valid env var names"));
});
test("isContextModeEnabled: defaults to true; only explicit false disables", () => {
  assert.equal(isContextModeEnabled(void 0), true, "undefined prefs \u2192 on");
  assert.equal(isContextModeEnabled(null), true, "null prefs \u2192 on");
  assert.equal(isContextModeEnabled({}), true, "empty prefs \u2192 on");
  assert.equal(isContextModeEnabled({ context_mode: {} }), true, "empty block \u2192 on");
  assert.equal(isContextModeEnabled({ context_mode: { enabled: true } }), true);
  assert.equal(isContextModeEnabled({ context_mode: { enabled: false } }), false);
});
test("buildExecOptions: clamps out-of-range values to safe defaults", () => {
  const opts = buildExecOptions("/tmp/base", {
    enabled: true,
    exec_timeout_ms: 999999999,
    exec_stdout_cap_bytes: 1,
    exec_digest_chars: -20
  });
  assert.equal(opts.default_timeout_ms, EXEC_DEFAULTS.clampTimeoutMs, "timeout clamped to upper bound");
  assert.equal(opts.stdout_cap_bytes, 4096, "stdout cap clamped to floor");
  assert.equal(opts.digest_chars, 0, "digest chars clamped to floor");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9leGVjLXNhbmRib3gudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgdGVzdCB9IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgcmVhZEZpbGVTeW5jLCBybVN5bmMgfSBmcm9tICdub2RlOmZzJztcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gJ25vZGU6b3MnO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gJ25vZGU6cGF0aCc7XG5cbmltcG9ydCB7IEVYRUNfREVGQVVMVFMsIHJ1bkV4ZWNTYW5kYm94LCB0eXBlIEV4ZWNTYW5kYm94T3B0aW9ucyB9IGZyb20gJy4uL2V4ZWMtc2FuZGJveC50cyc7XG5pbXBvcnQgeyBidWlsZEV4ZWNPcHRpb25zLCBleGVjdXRlR3NkRXhlYyB9IGZyb20gJy4uL3Rvb2xzL2V4ZWMtdG9vbC50cyc7XG5pbXBvcnQgeyBpc0NvbnRleHRNb2RlRW5hYmxlZCB9IGZyb20gJy4uL3ByZWZlcmVuY2VzLXR5cGVzLnRzJztcbmltcG9ydCB7IHZhbGlkYXRlUHJlZmVyZW5jZXMgfSBmcm9tICcuLi9wcmVmZXJlbmNlcy12YWxpZGF0aW9uLnRzJztcblxuZnVuY3Rpb24gZnJlc2hCYXNlKCk6IHN0cmluZyB7XG4gIHJldHVybiBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCAnZ3NkLWV4ZWMtdGVzdC0nKSk7XG59XG5cbmZ1bmN0aW9uIGNsZWFudXAoZGlyOiBzdHJpbmcpOiB2b2lkIHtcbiAgcm1TeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xufVxuXG5mdW5jdGlvbiBiYXNlT3B0cyhiYXNlOiBzdHJpbmcsIG92ZXJyaWRlczogUGFydGlhbDxFeGVjU2FuZGJveE9wdGlvbnM+ID0ge30pOiBFeGVjU2FuZGJveE9wdGlvbnMge1xuICByZXR1cm4ge1xuICAgIGJhc2VEaXI6IGJhc2UsXG4gICAgY2xhbXBfdGltZW91dF9tczogRVhFQ19ERUZBVUxUUy5jbGFtcFRpbWVvdXRNcyxcbiAgICBkZWZhdWx0X3RpbWVvdXRfbXM6IDEwXzAwMCxcbiAgICBzdGRvdXRfY2FwX2J5dGVzOiAxXzAyNCxcbiAgICBzdGRlcnJfY2FwX2J5dGVzOiAxXzAyNCxcbiAgICBkaWdlc3RfY2hhcnM6IDEyMCxcbiAgICBlbnZfYWxsb3dsaXN0OiBFWEVDX0RFRkFVTFRTLmVudkFsbG93bGlzdCxcbiAgICAuLi5vdmVycmlkZXMsXG4gIH07XG59XG5cbnRlc3QoJ3J1bkV4ZWNTYW5kYm94OiBjYXB0dXJlcyBzdGRvdXQsIHBlcnNpc3RzIGFydGlmYWN0cywgcmV0dXJucyBkaWdlc3QnLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBmcmVzaEJhc2UoKTtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5FeGVjU2FuZGJveChcbiAgICAgIHsgcnVudGltZTogJ2Jhc2gnLCBzY3JpcHQ6ICdlY2hvIGhlbGxvIHdvcmxkJyB9LFxuICAgICAgYmFzZU9wdHMoYmFzZSksXG4gICAgKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmV4aXRfY29kZSwgMCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC50aW1lZF9vdXQsIGZhbHNlKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmRpZ2VzdC5pbmNsdWRlcygnaGVsbG8gd29ybGQnKSwgYGRpZ2VzdCBzaG91bGQgY29udGFpbiBzdGRvdXQ6ICR7cmVzdWx0LmRpZ2VzdH1gKTtcbiAgICBhc3NlcnQub2socmVzdWx0LnN0ZG91dF9wYXRoLnN0YXJ0c1dpdGgoam9pbihiYXNlLCAnLmdzZCcsICdleGVjJykpLCAnc3Rkb3V0IHBhdGggdW5kZXIgLmdzZC9leGVjJyk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlYWRGaWxlU3luYyhyZXN1bHQuc3Rkb3V0X3BhdGgsICd1dGYtOCcpLnRyaW0oKSwgJ2hlbGxvIHdvcmxkJyk7XG4gICAgY29uc3QgbWV0YSA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHJlc3VsdC5tZXRhX3BhdGgsICd1dGYtOCcpKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICBhc3NlcnQuZXF1YWwobWV0YS5ydW50aW1lLCAnYmFzaCcpO1xuICAgIGFzc2VydC5lcXVhbChtZXRhLmV4aXRfY29kZSwgMCk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoJ3J1bkV4ZWNTYW5kYm94OiBlbmZvcmNlcyBzdGRvdXQgY2FwIGFuZCBtYXJrcyB0cnVuY2F0aW9uJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gZnJlc2hCYXNlKCk7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuRXhlY1NhbmRib3goXG4gICAgICAvLyBFbWl0IGZhciBtb3JlIHRoYW4gdGhlIGNhcCBzbyB0cnVuY2F0aW9uIHRyaWdnZXJzLlxuICAgICAgeyBydW50aW1lOiAnYmFzaCcsIHNjcmlwdDogJ2hlYWQgLWMgODAwMCAvZGV2L3VyYW5kb20gfCBiYXNlNjQnIH0sXG4gICAgICBiYXNlT3B0cyhiYXNlLCB7IHN0ZG91dF9jYXBfYnl0ZXM6IDI1NiB9KSxcbiAgICApO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc3Rkb3V0X3RydW5jYXRlZCwgdHJ1ZSwgJ3Nob3VsZCBtYXJrIHN0ZG91dCB0cnVuY2F0ZWQnKTtcbiAgICBhc3NlcnQub2socmVzdWx0LnN0ZG91dF9ieXRlcyA8PSAyNTYsIGBzdGRvdXRfYnl0ZXMgd2l0aGluIGNhcCAoZ290ICR7cmVzdWx0LnN0ZG91dF9ieXRlc30pYCk7XG4gICAgY29uc3Qgc3Rkb3V0ID0gcmVhZEZpbGVTeW5jKHJlc3VsdC5zdGRvdXRfcGF0aCwgJ3V0Zi04Jyk7XG4gICAgYXNzZXJ0Lm9rKHN0ZG91dC5lbmRzV2l0aCgnW3RydW5jYXRlZDogc3Rkb3V0IGNhcCByZWFjaGVkXVxcbicpLCAndHJ1bmNhdGlvbiBtYXJrZXIgYXBwZW5kZWQnKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdCgncnVuRXhlY1NhbmRib3g6IGVuZm9yY2VzIHRpbWVvdXQgYW5kIHN1cmZhY2VzIHRpbWVkX291dCcsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IGZyZXNoQmFzZSgpO1xuICB0cnkge1xuICAgIGNvbnN0IHN0YXJ0ZWQgPSBEYXRlLm5vdygpO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bkV4ZWNTYW5kYm94KFxuICAgICAgeyBydW50aW1lOiAnYmFzaCcsIHNjcmlwdDogJ3NsZWVwIDEwJyB9LFxuICAgICAgYmFzZU9wdHMoYmFzZSwgeyBkZWZhdWx0X3RpbWVvdXRfbXM6IDE1MCwgY2xhbXBfdGltZW91dF9tczogMTUwIH0pLFxuICAgICk7XG4gICAgY29uc3QgZWxhcHNlZCA9IERhdGUubm93KCkgLSBzdGFydGVkO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQudGltZWRfb3V0LCB0cnVlKTtcbiAgICBhc3NlcnQub2soZWxhcHNlZCA8IDVfMDAwLCBgc2hvdWxkIHJldHVybiB3ZWxsIGJlZm9yZSAxMHMgKHRvb2sgJHtlbGFwc2VkfW1zKWApO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KCdydW5FeGVjU2FuZGJveDogZm9yd2FyZHMgb25seSBhbGxvd2xpc3RlZCBlbnYgdmFycycsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IGZyZXNoQmFzZSgpO1xuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bkV4ZWNTYW5kYm94KFxuICAgICAgeyBydW50aW1lOiAnYmFzaCcsIHNjcmlwdDogJ2VjaG8gUEFUSD0kUEFUSCBTRUNSRVQ9JEdTRF9URVNUX1NFQ1JFVCcgfSxcbiAgICAgIGJhc2VPcHRzKGJhc2UsIHtcbiAgICAgICAgZW52X2FsbG93bGlzdDogW10sXG4gICAgICAgIGVudjogeyBQQVRIOiAnL3Vzci9iaW46L2JpbicsIEhPTUU6ICcvdG1wJywgR1NEX1RFU1RfU0VDUkVUOiAnc2hvdWxkLWJlLWJsb2NrZWQnIH0sXG4gICAgICB9KSxcbiAgICApO1xuICAgIGNvbnN0IHN0ZG91dCA9IHJlYWRGaWxlU3luYyhyZXN1bHQuc3Rkb3V0X3BhdGgsICd1dGYtOCcpO1xuICAgIGFzc2VydC5vayhzdGRvdXQuaW5jbHVkZXMoJ1BBVEg9L3Vzci9iaW46L2JpbicpLCAnUEFUSCBmb3J3YXJkZWQnKTtcbiAgICBhc3NlcnQub2soIXN0ZG91dC5pbmNsdWRlcygnc2hvdWxkLWJlLWJsb2NrZWQnKSwgJ25vbi1hbGxvd2xpc3RlZCB2YXIgYmxvY2tlZCcpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KCdydW5FeGVjU2FuZGJveDogbm9kZSBydW50aW1lIGV4ZWN1dGVzIEpTJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gZnJlc2hCYXNlKCk7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuRXhlY1NhbmRib3goXG4gICAgICB7IHJ1bnRpbWU6ICdub2RlJywgc2NyaXB0OiAnY29uc29sZS5sb2coXCJub2RlLW9rOlwiICsgKDErMikpJyB9LFxuICAgICAgYmFzZU9wdHMoYmFzZSksXG4gICAgKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmV4aXRfY29kZSwgMCk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5kaWdlc3QuaW5jbHVkZXMoJ25vZGUtb2s6MycpKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwIGV4ZWMtdG9vbCBleGVjdXRvciBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdCgnZXhlY3V0ZUdzZEV4ZWM6IHJ1bnMgYnkgZGVmYXVsdCB3aGVuIGNvbnRleHRfbW9kZSBpcyB1bnNldCcsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IGZyZXNoQmFzZSgpO1xuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGV4ZWN1dGVHc2RFeGVjKFxuICAgICAgeyBydW50aW1lOiAnYmFzaCcsIHNjcmlwdDogJ2VjaG8gZGVmYXVsdC1vbi1ydW4nIH0sXG4gICAgICB7IGJhc2VEaXI6IGJhc2UsIHByZWZlcmVuY2VzOiB7fSB9LFxuICAgICk7XG4gICAgYXNzZXJ0Lm9rKCFyZXN1bHQuaXNFcnJvciwgJ3Nob3VsZCBzdWNjZWVkIHdpdGggbm8gcHJlZmVyZW5jZXMnKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmRldGFpbHMub3BlcmF0aW9uLCAnZ3NkX2V4ZWMnKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmRldGFpbHMuZXhpdF9jb2RlLCAwKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmNvbnRlbnRbMF0udGV4dC5pbmNsdWRlcygnZGVmYXVsdC1vbi1ydW4nKSk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoJ2V4ZWN1dGVHc2RFeGVjOiBydW5zIHdoZW4gcHJlZmVyZW5jZXMgaXMgbnVsbCAoZnJlc2ggcHJvamVjdCknLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBmcmVzaEJhc2UoKTtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBleGVjdXRlR3NkRXhlYyhcbiAgICAgIHsgcnVudGltZTogJ2Jhc2gnLCBzY3JpcHQ6ICdlY2hvIG51bGwtcHJlZnMtcnVuJyB9LFxuICAgICAgeyBiYXNlRGlyOiBiYXNlLCBwcmVmZXJlbmNlczogbnVsbCB9LFxuICAgICk7XG4gICAgYXNzZXJ0Lm9rKCFyZXN1bHQuaXNFcnJvciwgJ251bGwgcHJlZmVyZW5jZXMgc2hvdWxkIG5vdCBkaXNhYmxlJyk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5jb250ZW50WzBdLnRleHQuaW5jbHVkZXMoJ251bGwtcHJlZnMtcnVuJykpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KCdleGVjdXRlR3NkRXhlYzogYmxvY2tlZCBvbmx5IHdoZW4gY29udGV4dF9tb2RlLmVuYWJsZWQ9ZmFsc2UnLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBmcmVzaEJhc2UoKTtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBleGVjdXRlR3NkRXhlYyhcbiAgICAgIHsgcnVudGltZTogJ2Jhc2gnLCBzY3JpcHQ6ICdlY2hvIHNob3VsZC1ub3QtcnVuJyB9LFxuICAgICAgeyBiYXNlRGlyOiBiYXNlLCBwcmVmZXJlbmNlczogeyBjb250ZXh0X21vZGU6IHsgZW5hYmxlZDogZmFsc2UgfSB9IH0sXG4gICAgKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmlzRXJyb3IsIHRydWUpO1xuICAgIGFzc2VydC5lcXVhbCgocmVzdWx0LmRldGFpbHMgYXMgeyBlcnJvcj86IHN0cmluZyB9KS5lcnJvciwgJ2NvbnRleHRfbW9kZV9kaXNhYmxlZCcpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KCdleGVjdXRlR3NkRXhlYzogcnVucyB3aGVuIGVuYWJsZWQgZXhwbGljaXRseSBzZXQgdG8gdHJ1ZScsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IGZyZXNoQmFzZSgpO1xuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGV4ZWN1dGVHc2RFeGVjKFxuICAgICAgeyBydW50aW1lOiAnYmFzaCcsIHNjcmlwdDogJ2VjaG8gZXhwbGljaXQtb24nIH0sXG4gICAgICB7IGJhc2VEaXI6IGJhc2UsIHByZWZlcmVuY2VzOiB7IGNvbnRleHRfbW9kZTogeyBlbmFibGVkOiB0cnVlIH0gfSB9LFxuICAgICk7XG4gICAgYXNzZXJ0Lm9rKCFyZXN1bHQuaXNFcnJvcik7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5jb250ZW50WzBdLnRleHQuaW5jbHVkZXMoJ2V4cGxpY2l0LW9uJykpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KCdleGVjdXRlR3NkRXhlYzogZm9yd2FyZHMgY3VzdG9tIGV4ZWNfZW52X2FsbG93bGlzdCBmcm9tIHByZWZlcmVuY2VzJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gZnJlc2hCYXNlKCk7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZXhlY3V0ZUdzZEV4ZWMoXG4gICAgICB7XG4gICAgICAgIHJ1bnRpbWU6ICdiYXNoJyxcbiAgICAgICAgc2NyaXB0OiAncHJpbnRmIFwiYWxsb3dlZD0lcyBibG9ja2VkPSVzXFxcXG5cIiBcIiRHU0RfQUxMT1dFRFwiIFwiJEdTRF9CTE9DS0VEXCInLFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgYmFzZURpcjogYmFzZSxcbiAgICAgICAgcHJlZmVyZW5jZXM6IHtcbiAgICAgICAgICBjb250ZXh0X21vZGU6IHtcbiAgICAgICAgICAgIGVuYWJsZWQ6IHRydWUsXG4gICAgICAgICAgICBleGVjX2Vudl9hbGxvd2xpc3Q6IFsnR1NEX0FMTE9XRUQnXSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgICBlbnY6IHtcbiAgICAgICAgICBQQVRIOiAnL3Vzci9iaW46L2JpbicsXG4gICAgICAgICAgSE9NRTogJy90bXAnLFxuICAgICAgICAgIEdTRF9BTExPV0VEOiAneWVzJyxcbiAgICAgICAgICBHU0RfQkxPQ0tFRDogJ25vJyxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgKTtcbiAgICBhc3NlcnQub2soIXJlc3VsdC5pc0Vycm9yKTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LmNvbnRlbnRbMF0udGV4dCwgL2FsbG93ZWQ9eWVzIGJsb2NrZWQ9Lyk7XG4gICAgYXNzZXJ0LmRvZXNOb3RNYXRjaChyZXN1bHQuY29udGVudFswXS50ZXh0LCAvYmxvY2tlZD1uby8pO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KCdleGVjdXRlR3NkRXhlYzogZW5mb3JjZXMgcGVyLWNhbGwgdGltZW91dCBvdmVycmlkZSBlbmQtdG8tZW5kJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gZnJlc2hCYXNlKCk7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZXhlY3V0ZUdzZEV4ZWMoXG4gICAgICB7IHJ1bnRpbWU6ICdiYXNoJywgc2NyaXB0OiAnc2xlZXAgMicsIHRpbWVvdXRfbXM6IDEgfSxcbiAgICAgIHsgYmFzZURpcjogYmFzZSwgcHJlZmVyZW5jZXM6IHsgY29udGV4dF9tb2RlOiB7IGVuYWJsZWQ6IHRydWUsIGV4ZWNfdGltZW91dF9tczogMTBfMDAwIH0gfSB9LFxuICAgICk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5kZXRhaWxzLnRpbWVkX291dCwgdHJ1ZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5pc0Vycm9yLCB0cnVlKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdCgnZXhlY3V0ZUdzZEV4ZWM6IHJlamVjdHMgZW1wdHkgc2NyaXB0JywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gZnJlc2hCYXNlKCk7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZXhlY3V0ZUdzZEV4ZWMoXG4gICAgICB7IHJ1bnRpbWU6ICdiYXNoJywgc2NyaXB0OiAnICAgJyB9LFxuICAgICAgeyBiYXNlRGlyOiBiYXNlLCBwcmVmZXJlbmNlczogeyBjb250ZXh0X21vZGU6IHsgZW5hYmxlZDogdHJ1ZSB9IH0gfSxcbiAgICApO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuaXNFcnJvciwgdHJ1ZSk7XG4gICAgYXNzZXJ0LmVxdWFsKChyZXN1bHQuZGV0YWlscyBhcyB7IGVycm9yPzogc3RyaW5nIH0pLmVycm9yLCAnaW52YWxpZF9wYXJhbXMnKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdCgndmFsaWRhdGVQcmVmZXJlbmNlczogcmVqZWN0cyBpbnZhbGlkIGNvbnRleHRfbW9kZSBwcmVmZXJlbmNlIHZhbHVlcycsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gdmFsaWRhdGVQcmVmZXJlbmNlcyh7XG4gICAgY29udGV4dF9tb2RlOiB7XG4gICAgICBlbmFibGVkOiAnZmFsc2UnLFxuICAgICAgZXhlY190aW1lb3V0X21zOiA5OTksXG4gICAgICBleGVjX3N0ZG91dF9jYXBfYnl0ZXM6IDEsXG4gICAgICBleGVjX2RpZ2VzdF9jaGFyczogLTEsXG4gICAgICBleGVjX2Vudl9hbGxvd2xpc3Q6IFsnR09PRF9OQU1FJywgJ2JhZC1uYW1lJ10sXG4gICAgfSxcbiAgfSBhcyBhbnkpO1xuICBhc3NlcnQub2socmVzdWx0LmVycm9ycy5sZW5ndGggPiAwKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdC5lcnJvcnMuaW5jbHVkZXMoJ2NvbnRleHRfbW9kZS5lbmFibGVkIG11c3QgYmUgYSBib29sZWFuJykpO1xuICBhc3NlcnQub2socmVzdWx0LmVycm9ycy5pbmNsdWRlcygnY29udGV4dF9tb2RlLmV4ZWNfdGltZW91dF9tcyBtdXN0IGJlIGEgbnVtYmVyIGJldHdlZW4gMTAwMCBhbmQgNjAwMDAwJykpO1xuICBhc3NlcnQub2socmVzdWx0LmVycm9ycy5pbmNsdWRlcygnY29udGV4dF9tb2RlLmV4ZWNfc3Rkb3V0X2NhcF9ieXRlcyBtdXN0IGJlIGEgbnVtYmVyIGJldHdlZW4gNDA5NiBhbmQgMTY3NzcyMTYnKSk7XG4gIGFzc2VydC5vayhyZXN1bHQuZXJyb3JzLmluY2x1ZGVzKCdjb250ZXh0X21vZGUuZXhlY19kaWdlc3RfY2hhcnMgbXVzdCBiZSBhIG51bWJlciBiZXR3ZWVuIDAgYW5kIDQwMDAnKSk7XG4gIGFzc2VydC5vayhyZXN1bHQuZXJyb3JzLmluY2x1ZGVzKCdjb250ZXh0X21vZGUuZXhlY19lbnZfYWxsb3dsaXN0IG11c3QgYmUgYW4gYXJyYXkgb2YgdmFsaWQgZW52IHZhciBuYW1lcycpKTtcbn0pO1xuXG50ZXN0KCdpc0NvbnRleHRNb2RlRW5hYmxlZDogZGVmYXVsdHMgdG8gdHJ1ZTsgb25seSBleHBsaWNpdCBmYWxzZSBkaXNhYmxlcycsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKGlzQ29udGV4dE1vZGVFbmFibGVkKHVuZGVmaW5lZCksIHRydWUsICd1bmRlZmluZWQgcHJlZnMgXHUyMTkyIG9uJyk7XG4gIGFzc2VydC5lcXVhbChpc0NvbnRleHRNb2RlRW5hYmxlZChudWxsKSwgdHJ1ZSwgJ251bGwgcHJlZnMgXHUyMTkyIG9uJyk7XG4gIGFzc2VydC5lcXVhbChpc0NvbnRleHRNb2RlRW5hYmxlZCh7fSksIHRydWUsICdlbXB0eSBwcmVmcyBcdTIxOTIgb24nKTtcbiAgYXNzZXJ0LmVxdWFsKGlzQ29udGV4dE1vZGVFbmFibGVkKHsgY29udGV4dF9tb2RlOiB7fSB9KSwgdHJ1ZSwgJ2VtcHR5IGJsb2NrIFx1MjE5MiBvbicpO1xuICBhc3NlcnQuZXF1YWwoaXNDb250ZXh0TW9kZUVuYWJsZWQoeyBjb250ZXh0X21vZGU6IHsgZW5hYmxlZDogdHJ1ZSB9IH0pLCB0cnVlKTtcbiAgYXNzZXJ0LmVxdWFsKGlzQ29udGV4dE1vZGVFbmFibGVkKHsgY29udGV4dF9tb2RlOiB7IGVuYWJsZWQ6IGZhbHNlIH0gfSksIGZhbHNlKTtcbn0pO1xuXG50ZXN0KCdidWlsZEV4ZWNPcHRpb25zOiBjbGFtcHMgb3V0LW9mLXJhbmdlIHZhbHVlcyB0byBzYWZlIGRlZmF1bHRzJywgKCkgPT4ge1xuICBjb25zdCBvcHRzID0gYnVpbGRFeGVjT3B0aW9ucygnL3RtcC9iYXNlJywge1xuICAgIGVuYWJsZWQ6IHRydWUsXG4gICAgZXhlY190aW1lb3V0X21zOiA5OTlfOTk5Xzk5OSxcbiAgICBleGVjX3N0ZG91dF9jYXBfYnl0ZXM6IDEsXG4gICAgZXhlY19kaWdlc3RfY2hhcnM6IC0yMCxcbiAgfSk7XG4gIGFzc2VydC5lcXVhbChvcHRzLmRlZmF1bHRfdGltZW91dF9tcywgRVhFQ19ERUZBVUxUUy5jbGFtcFRpbWVvdXRNcywgJ3RpbWVvdXQgY2xhbXBlZCB0byB1cHBlciBib3VuZCcpO1xuICBhc3NlcnQuZXF1YWwob3B0cy5zdGRvdXRfY2FwX2J5dGVzLCA0XzA5NiwgJ3N0ZG91dCBjYXAgY2xhbXBlZCB0byBmbG9vcicpO1xuICBhc3NlcnQuZXF1YWwob3B0cy5kaWdlc3RfY2hhcnMsIDAsICdkaWdlc3QgY2hhcnMgY2xhbXBlZCB0byBmbG9vcicpO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxTQUFTLFlBQVk7QUFDckIsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxjQUFjLGNBQWM7QUFDbEQsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsWUFBWTtBQUVyQixTQUFTLGVBQWUsc0JBQStDO0FBQ3ZFLFNBQVMsa0JBQWtCLHNCQUFzQjtBQUNqRCxTQUFTLDRCQUE0QjtBQUNyQyxTQUFTLDJCQUEyQjtBQUVwQyxTQUFTLFlBQW9CO0FBQzNCLFNBQU8sWUFBWSxLQUFLLE9BQU8sR0FBRyxnQkFBZ0IsQ0FBQztBQUNyRDtBQUVBLFNBQVMsUUFBUSxLQUFt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
