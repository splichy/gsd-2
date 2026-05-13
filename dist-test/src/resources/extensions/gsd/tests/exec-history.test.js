import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listExecHistory, searchExecHistory } from "../exec-history.js";
import { executeExecSearch } from "../tools/exec-search-tool.js";
function freshBase() {
  return mkdtempSync(join(tmpdir(), "gsd-exec-history-"));
}
function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}
function writeRun(base, id, overrides = {}) {
  const dir = join(base, ".gsd", "exec");
  mkdirSync(dir, { recursive: true });
  const stdoutPath = join(dir, `${id}.stdout`);
  const stderrPath = join(dir, `${id}.stderr`);
  const metaPath = join(dir, `${id}.meta.json`);
  writeFileSync(stdoutPath, overrides.stdout ?? `stdout for ${id}
`);
  writeFileSync(stderrPath, "");
  writeFileSync(
    metaPath,
    JSON.stringify({
      id,
      runtime: "bash",
      purpose: `purpose for ${id}`,
      started_at: "2026-04-20T12:00:00.000Z",
      finished_at: "2026-04-20T12:00:00.100Z",
      duration_ms: 100,
      exit_code: 0,
      signal: null,
      timed_out: false,
      stdout_bytes: 12,
      stderr_bytes: 0,
      stdout_truncated: false,
      stderr_truncated: false,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      ...overrides
    })
  );
}
test("listExecHistory: returns empty list when .gsd/exec missing", () => {
  const base = freshBase();
  try {
    assert.deepEqual(listExecHistory(base), []);
  } finally {
    cleanup(base);
  }
});
test("listExecHistory: skips malformed meta files", () => {
  const base = freshBase();
  try {
    const dir = join(base, ".gsd", "exec");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bad.meta.json"), "{not-json");
    writeRun(base, "ok-1");
    const list = listExecHistory(base);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, "ok-1");
  } finally {
    cleanup(base);
  }
});
test("searchExecHistory: filters by query, runtime, and failing_only", () => {
  const base = freshBase();
  try {
    writeRun(base, "playwright-run", { purpose: "playwright snapshot" });
    writeRun(base, "grep-run", { purpose: "grep TODOs" });
    writeRun(base, "failing-run", { exit_code: 1, purpose: "boom" });
    writeRun(base, "node-run", { runtime: "node", purpose: "dedupe" });
    const playwrightHits = searchExecHistory(base, { query: "playwright" });
    assert.equal(playwrightHits.length, 1);
    assert.equal(playwrightHits[0].entry.id, "playwright-run");
    const failingHits = searchExecHistory(base, { failing_only: true });
    assert.equal(failingHits.length, 1);
    assert.equal(failingHits[0].entry.id, "failing-run");
    const nodeHits = searchExecHistory(base, { runtime: "node" });
    assert.equal(nodeHits.length, 1);
    assert.equal(nodeHits[0].entry.runtime, "node");
    const unlimited = searchExecHistory(base, {});
    assert.equal(unlimited.length, 4);
  } finally {
    cleanup(base);
  }
});
test("executeExecSearch: returns helpful empty-state message when no matches", () => {
  const base = freshBase();
  try {
    const result = executeExecSearch({ query: "missing" }, { baseDir: base });
    assert.ok(!result.isError);
    assert.match(result.content[0].text, /No prior gsd_exec runs/);
  } finally {
    cleanup(base);
  }
});
test("executeExecSearch: returns disabled error when context_mode.enabled=false", () => {
  const base = freshBase();
  try {
    writeRun(base, "should-not-surface", { stdout: "hidden\n" });
    const result = executeExecSearch(
      { query: "hidden" },
      { baseDir: base, preferences: { context_mode: { enabled: false } } }
    );
    assert.equal(result.isError, true);
    assert.equal(result.details.error, "context_mode_disabled");
  } finally {
    cleanup(base);
  }
});
test("executeExecSearch: includes stdout_path and preview in details", () => {
  const base = freshBase();
  try {
    writeRun(base, "summary-run", { stdout: "found 42 TODOs\n" });
    const result = executeExecSearch({ query: "summary" }, { baseDir: base });
    const details = result.details;
    assert.equal(details.results.length, 1);
    assert.equal(details.results[0].id, "summary-run");
    assert.match(details.results[0].stdout_path, /summary-run\.stdout$/);
    assert.match(result.content[0].text, /found 42 TODOs/);
  } finally {
    cleanup(base);
  }
});
test("safeReadMeta: ignores malicious stdout_path in JSON, derives path from meta file location", () => {
  const base = freshBase();
  try {
    const dir = join(base, ".gsd", "exec");
    mkdirSync(dir, { recursive: true });
    const id = "traversal-test-run";
    const metaPath = join(dir, `${id}.meta.json`);
    const stdoutPath = join(dir, `${id}.stdout`);
    const stderrPath = join(dir, `${id}.stderr`);
    writeFileSync(stdoutPath, "legitimate stdout content\n");
    writeFileSync(stderrPath, "");
    writeFileSync(
      metaPath,
      JSON.stringify({
        id,
        runtime: "bash",
        purpose: "test run",
        started_at: "2026-04-20T12:00:00.000Z",
        finished_at: "2026-04-20T12:00:00.100Z",
        duration_ms: 100,
        exit_code: 0,
        signal: null,
        timed_out: false,
        stdout_bytes: 24,
        stderr_bytes: 0,
        stdout_truncated: false,
        stderr_truncated: false,
        // These malicious values must NEVER be used as filesystem paths.
        stdout_path: "../../etc/passwd",
        stderr_path: "../../etc/shadow"
      })
    );
    const entries = listExecHistory(base);
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.equal(
      entry.stdout_path,
      stdoutPath,
      `stdout_path must be a sibling of the meta file; got: ${entry.stdout_path}`
    );
    assert.equal(
      entry.stderr_path,
      stderrPath,
      `stderr_path must be a sibling of the meta file; got: ${entry.stderr_path}`
    );
    assert.ok(
      !entry.stdout_path.includes(".."),
      `stdout_path must not contain path traversal sequences: ${entry.stdout_path}`
    );
    assert.ok(
      !entry.stderr_path.includes(".."),
      `stderr_path must not contain path traversal sequences: ${entry.stderr_path}`
    );
    assert.ok(
      !entry.stdout_path.includes("etc/passwd"),
      `stdout_path must not point to /etc/passwd: ${entry.stdout_path}`
    );
  } finally {
    cleanup(base);
  }
});
test("searchExecHistory: digest_preview is read from derived sibling path, not JSON stdout_path", () => {
  const base = freshBase();
  try {
    const dir = join(base, ".gsd", "exec");
    mkdirSync(dir, { recursive: true });
    const id = "preview-traversal-run";
    const metaPath = join(dir, `${id}.meta.json`);
    const stdoutPath = join(dir, `${id}.stdout`);
    writeFileSync(stdoutPath, "safe-sentinel-content\n");
    writeFileSync(join(dir, `${id}.stderr`), "");
    writeFileSync(
      metaPath,
      JSON.stringify({
        id,
        runtime: "bash",
        purpose: null,
        started_at: "2026-04-20T12:00:00.000Z",
        finished_at: "2026-04-20T12:00:00.100Z",
        duration_ms: 50,
        exit_code: 0,
        signal: null,
        timed_out: false,
        stdout_bytes: 21,
        stderr_bytes: 0,
        stdout_truncated: false,
        stderr_truncated: false,
        // Attacker-controlled path — must be ignored.
        stdout_path: "/etc/passwd",
        stderr_path: "/etc/shadow"
      })
    );
    const hits = searchExecHistory(base, {});
    assert.equal(hits.length, 1);
    const hit = hits[0];
    assert.ok(
      hit.digest_preview?.includes("safe-sentinel-content"),
      `digest_preview should contain safe-sentinel-content; got: ${hit.digest_preview}`
    );
    assert.equal(hit.entry.stdout_path, stdoutPath);
  } finally {
    cleanup(base);
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9leGVjLWhpc3RvcnkudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgdGVzdCB9IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7XG5pbXBvcnQgeyBta2RpclN5bmMsIG1rZHRlbXBTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tICdub2RlOmZzJztcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gJ25vZGU6b3MnO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gJ25vZGU6cGF0aCc7XG5cbmltcG9ydCB7IGxpc3RFeGVjSGlzdG9yeSwgc2VhcmNoRXhlY0hpc3RvcnkgfSBmcm9tICcuLi9leGVjLWhpc3RvcnkudHMnO1xuaW1wb3J0IHsgZXhlY3V0ZUV4ZWNTZWFyY2ggfSBmcm9tICcuLi90b29scy9leGVjLXNlYXJjaC10b29sLnRzJztcblxuZnVuY3Rpb24gZnJlc2hCYXNlKCk6IHN0cmluZyB7XG4gIHJldHVybiBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCAnZ3NkLWV4ZWMtaGlzdG9yeS0nKSk7XG59XG5cbmZ1bmN0aW9uIGNsZWFudXAoZGlyOiBzdHJpbmcpOiB2b2lkIHtcbiAgcm1TeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xufVxuXG5mdW5jdGlvbiB3cml0ZVJ1bihiYXNlOiBzdHJpbmcsIGlkOiBzdHJpbmcsIG92ZXJyaWRlczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fSk6IHZvaWQge1xuICBjb25zdCBkaXIgPSBqb2luKGJhc2UsICcuZ3NkJywgJ2V4ZWMnKTtcbiAgbWtkaXJTeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGNvbnN0IHN0ZG91dFBhdGggPSBqb2luKGRpciwgYCR7aWR9LnN0ZG91dGApO1xuICBjb25zdCBzdGRlcnJQYXRoID0gam9pbihkaXIsIGAke2lkfS5zdGRlcnJgKTtcbiAgY29uc3QgbWV0YVBhdGggPSBqb2luKGRpciwgYCR7aWR9Lm1ldGEuanNvbmApO1xuICB3cml0ZUZpbGVTeW5jKHN0ZG91dFBhdGgsIChvdmVycmlkZXMuc3Rkb3V0IGFzIHN0cmluZyB8IHVuZGVmaW5lZCkgPz8gYHN0ZG91dCBmb3IgJHtpZH1cXG5gKTtcbiAgd3JpdGVGaWxlU3luYyhzdGRlcnJQYXRoLCAnJyk7XG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgbWV0YVBhdGgsXG4gICAgSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgaWQsXG4gICAgICBydW50aW1lOiAnYmFzaCcsXG4gICAgICBwdXJwb3NlOiBgcHVycG9zZSBmb3IgJHtpZH1gLFxuICAgICAgc3RhcnRlZF9hdDogJzIwMjYtMDQtMjBUMTI6MDA6MDAuMDAwWicsXG4gICAgICBmaW5pc2hlZF9hdDogJzIwMjYtMDQtMjBUMTI6MDA6MDAuMTAwWicsXG4gICAgICBkdXJhdGlvbl9tczogMTAwLFxuICAgICAgZXhpdF9jb2RlOiAwLFxuICAgICAgc2lnbmFsOiBudWxsLFxuICAgICAgdGltZWRfb3V0OiBmYWxzZSxcbiAgICAgIHN0ZG91dF9ieXRlczogMTIsXG4gICAgICBzdGRlcnJfYnl0ZXM6IDAsXG4gICAgICBzdGRvdXRfdHJ1bmNhdGVkOiBmYWxzZSxcbiAgICAgIHN0ZGVycl90cnVuY2F0ZWQ6IGZhbHNlLFxuICAgICAgc3Rkb3V0X3BhdGg6IHN0ZG91dFBhdGgsXG4gICAgICBzdGRlcnJfcGF0aDogc3RkZXJyUGF0aCxcbiAgICAgIC4uLm92ZXJyaWRlcyxcbiAgICB9KSxcbiAgKTtcbn1cblxudGVzdCgnbGlzdEV4ZWNIaXN0b3J5OiByZXR1cm5zIGVtcHR5IGxpc3Qgd2hlbiAuZ3NkL2V4ZWMgbWlzc2luZycsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IGZyZXNoQmFzZSgpO1xuICB0cnkge1xuICAgIGFzc2VydC5kZWVwRXF1YWwobGlzdEV4ZWNIaXN0b3J5KGJhc2UpLCBbXSk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoJ2xpc3RFeGVjSGlzdG9yeTogc2tpcHMgbWFsZm9ybWVkIG1ldGEgZmlsZXMnLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBmcmVzaEJhc2UoKTtcbiAgdHJ5IHtcbiAgICBjb25zdCBkaXIgPSBqb2luKGJhc2UsICcuZ3NkJywgJ2V4ZWMnKTtcbiAgICBta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCAnYmFkLm1ldGEuanNvbicpLCAne25vdC1qc29uJyk7XG4gICAgd3JpdGVSdW4oYmFzZSwgJ29rLTEnKTtcbiAgICBjb25zdCBsaXN0ID0gbGlzdEV4ZWNIaXN0b3J5KGJhc2UpO1xuICAgIGFzc2VydC5lcXVhbChsaXN0Lmxlbmd0aCwgMSk7XG4gICAgYXNzZXJ0LmVxdWFsKGxpc3RbMF0hLmlkLCAnb2stMScpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KCdzZWFyY2hFeGVjSGlzdG9yeTogZmlsdGVycyBieSBxdWVyeSwgcnVudGltZSwgYW5kIGZhaWxpbmdfb25seScsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IGZyZXNoQmFzZSgpO1xuICB0cnkge1xuICAgIHdyaXRlUnVuKGJhc2UsICdwbGF5d3JpZ2h0LXJ1bicsIHsgcHVycG9zZTogJ3BsYXl3cmlnaHQgc25hcHNob3QnIH0pO1xuICAgIHdyaXRlUnVuKGJhc2UsICdncmVwLXJ1bicsIHsgcHVycG9zZTogJ2dyZXAgVE9ET3MnIH0pO1xuICAgIHdyaXRlUnVuKGJhc2UsICdmYWlsaW5nLXJ1bicsIHsgZXhpdF9jb2RlOiAxLCBwdXJwb3NlOiAnYm9vbScgfSk7XG4gICAgd3JpdGVSdW4oYmFzZSwgJ25vZGUtcnVuJywgeyBydW50aW1lOiAnbm9kZScsIHB1cnBvc2U6ICdkZWR1cGUnIH0pO1xuXG4gICAgY29uc3QgcGxheXdyaWdodEhpdHMgPSBzZWFyY2hFeGVjSGlzdG9yeShiYXNlLCB7IHF1ZXJ5OiAncGxheXdyaWdodCcgfSk7XG4gICAgYXNzZXJ0LmVxdWFsKHBsYXl3cmlnaHRIaXRzLmxlbmd0aCwgMSk7XG4gICAgYXNzZXJ0LmVxdWFsKHBsYXl3cmlnaHRIaXRzWzBdIS5lbnRyeS5pZCwgJ3BsYXl3cmlnaHQtcnVuJyk7XG5cbiAgICBjb25zdCBmYWlsaW5nSGl0cyA9IHNlYXJjaEV4ZWNIaXN0b3J5KGJhc2UsIHsgZmFpbGluZ19vbmx5OiB0cnVlIH0pO1xuICAgIGFzc2VydC5lcXVhbChmYWlsaW5nSGl0cy5sZW5ndGgsIDEpO1xuICAgIGFzc2VydC5lcXVhbChmYWlsaW5nSGl0c1swXSEuZW50cnkuaWQsICdmYWlsaW5nLXJ1bicpO1xuXG4gICAgY29uc3Qgbm9kZUhpdHMgPSBzZWFyY2hFeGVjSGlzdG9yeShiYXNlLCB7IHJ1bnRpbWU6ICdub2RlJyB9KTtcbiAgICBhc3NlcnQuZXF1YWwobm9kZUhpdHMubGVuZ3RoLCAxKTtcbiAgICBhc3NlcnQuZXF1YWwobm9kZUhpdHNbMF0hLmVudHJ5LnJ1bnRpbWUsICdub2RlJyk7XG5cbiAgICBjb25zdCB1bmxpbWl0ZWQgPSBzZWFyY2hFeGVjSGlzdG9yeShiYXNlLCB7fSk7XG4gICAgYXNzZXJ0LmVxdWFsKHVubGltaXRlZC5sZW5ndGgsIDQpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KCdleGVjdXRlRXhlY1NlYXJjaDogcmV0dXJucyBoZWxwZnVsIGVtcHR5LXN0YXRlIG1lc3NhZ2Ugd2hlbiBubyBtYXRjaGVzJywgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gZnJlc2hCYXNlKCk7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0ID0gZXhlY3V0ZUV4ZWNTZWFyY2goeyBxdWVyeTogJ21pc3NpbmcnIH0sIHsgYmFzZURpcjogYmFzZSB9KTtcbiAgICBhc3NlcnQub2soIXJlc3VsdC5pc0Vycm9yKTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LmNvbnRlbnRbMF0udGV4dCwgL05vIHByaW9yIGdzZF9leGVjIHJ1bnMvKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdCgnZXhlY3V0ZUV4ZWNTZWFyY2g6IHJldHVybnMgZGlzYWJsZWQgZXJyb3Igd2hlbiBjb250ZXh0X21vZGUuZW5hYmxlZD1mYWxzZScsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IGZyZXNoQmFzZSgpO1xuICB0cnkge1xuICAgIHdyaXRlUnVuKGJhc2UsICdzaG91bGQtbm90LXN1cmZhY2UnLCB7IHN0ZG91dDogJ2hpZGRlblxcbicgfSk7XG4gICAgY29uc3QgcmVzdWx0ID0gZXhlY3V0ZUV4ZWNTZWFyY2goXG4gICAgICB7IHF1ZXJ5OiAnaGlkZGVuJyB9LFxuICAgICAgeyBiYXNlRGlyOiBiYXNlLCBwcmVmZXJlbmNlczogeyBjb250ZXh0X21vZGU6IHsgZW5hYmxlZDogZmFsc2UgfSB9IH0sXG4gICAgKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmlzRXJyb3IsIHRydWUpO1xuICAgIGFzc2VydC5lcXVhbCgocmVzdWx0LmRldGFpbHMgYXMgeyBlcnJvcj86IHN0cmluZyB9KS5lcnJvciwgJ2NvbnRleHRfbW9kZV9kaXNhYmxlZCcpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KCdleGVjdXRlRXhlY1NlYXJjaDogaW5jbHVkZXMgc3Rkb3V0X3BhdGggYW5kIHByZXZpZXcgaW4gZGV0YWlscycsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IGZyZXNoQmFzZSgpO1xuICB0cnkge1xuICAgIHdyaXRlUnVuKGJhc2UsICdzdW1tYXJ5LXJ1bicsIHsgc3Rkb3V0OiAnZm91bmQgNDIgVE9ET3NcXG4nIH0pO1xuICAgIGNvbnN0IHJlc3VsdCA9IGV4ZWN1dGVFeGVjU2VhcmNoKHsgcXVlcnk6ICdzdW1tYXJ5JyB9LCB7IGJhc2VEaXI6IGJhc2UgfSk7XG4gICAgY29uc3QgZGV0YWlscyA9IHJlc3VsdC5kZXRhaWxzIGFzIHsgcmVzdWx0czogQXJyYXk8eyBpZDogc3RyaW5nOyBzdGRvdXRfcGF0aDogc3RyaW5nIH0+IH07XG4gICAgYXNzZXJ0LmVxdWFsKGRldGFpbHMucmVzdWx0cy5sZW5ndGgsIDEpO1xuICAgIGFzc2VydC5lcXVhbChkZXRhaWxzLnJlc3VsdHNbMF0hLmlkLCAnc3VtbWFyeS1ydW4nKTtcbiAgICBhc3NlcnQubWF0Y2goZGV0YWlscy5yZXN1bHRzWzBdIS5zdGRvdXRfcGF0aCwgL3N1bW1hcnktcnVuXFwuc3Rkb3V0JC8pO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQuY29udGVudFswXS50ZXh0LCAvZm91bmQgNDIgVE9ET3MvKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwIFBhdGggdHJhdmVyc2FsIHNlY3VyaXR5IHRlc3RzIChpc3N1ZSAjNDU5MCkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoJ3NhZmVSZWFkTWV0YTogaWdub3JlcyBtYWxpY2lvdXMgc3Rkb3V0X3BhdGggaW4gSlNPTiwgZGVyaXZlcyBwYXRoIGZyb20gbWV0YSBmaWxlIGxvY2F0aW9uJywgKCkgPT4ge1xuICAvLyBBcnJhbmdlOiB3cml0ZSBhIC5tZXRhLmpzb24gd2hvc2UgSlNPTiBjb250ZW50IGhhcyBhIHBhdGgtdHJhdmVyc2FsIHZhbHVlXG4gIC8vIGluIHN0ZG91dF9wYXRoIC8gc3RkZXJyX3BhdGguIFRoZSByZWFkLXNpZGUgbXVzdCBzaWxlbnRseSBkaXNjYXJkIHRoZXNlXG4gIC8vIGFuZCBkZXJpdmUgc2libGluZyBwYXRocyBmcm9tIHRoZSBhY3R1YWwgLm1ldGEuanNvbiBsb2NhdGlvbiBpbnN0ZWFkLlxuICBjb25zdCBiYXNlID0gZnJlc2hCYXNlKCk7XG4gIHRyeSB7XG4gICAgY29uc3QgZGlyID0gam9pbihiYXNlLCAnLmdzZCcsICdleGVjJyk7XG4gICAgbWtkaXJTeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgY29uc3QgaWQgPSAndHJhdmVyc2FsLXRlc3QtcnVuJztcbiAgICBjb25zdCBtZXRhUGF0aCA9IGpvaW4oZGlyLCBgJHtpZH0ubWV0YS5qc29uYCk7XG4gICAgY29uc3Qgc3Rkb3V0UGF0aCA9IGpvaW4oZGlyLCBgJHtpZH0uc3Rkb3V0YCk7XG4gICAgY29uc3Qgc3RkZXJyUGF0aCA9IGpvaW4oZGlyLCBgJHtpZH0uc3RkZXJyYCk7XG4gICAgLy8gV3JpdGUgcmVhbCBzaWJsaW5nIGZpbGVzIHNvIGRpZ2VzdF9wcmV2aWV3IGNhbiBzdWNjZWVkLlxuICAgIHdyaXRlRmlsZVN5bmMoc3Rkb3V0UGF0aCwgJ2xlZ2l0aW1hdGUgc3Rkb3V0IGNvbnRlbnRcXG4nKTtcbiAgICB3cml0ZUZpbGVTeW5jKHN0ZGVyclBhdGgsICcnKTtcbiAgICAvLyBXcml0ZSBhIG1ldGEuanNvbiB0aGF0IHRyaWVzIHRvIHBvaW50IHN0ZG91dF9wYXRoIG91dHNpZGUgdGhlIGV4ZWMgZGlyLlxuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBtZXRhUGF0aCxcbiAgICAgIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgaWQsXG4gICAgICAgIHJ1bnRpbWU6ICdiYXNoJyxcbiAgICAgICAgcHVycG9zZTogJ3Rlc3QgcnVuJyxcbiAgICAgICAgc3RhcnRlZF9hdDogJzIwMjYtMDQtMjBUMTI6MDA6MDAuMDAwWicsXG4gICAgICAgIGZpbmlzaGVkX2F0OiAnMjAyNi0wNC0yMFQxMjowMDowMC4xMDBaJyxcbiAgICAgICAgZHVyYXRpb25fbXM6IDEwMCxcbiAgICAgICAgZXhpdF9jb2RlOiAwLFxuICAgICAgICBzaWduYWw6IG51bGwsXG4gICAgICAgIHRpbWVkX291dDogZmFsc2UsXG4gICAgICAgIHN0ZG91dF9ieXRlczogMjQsXG4gICAgICAgIHN0ZGVycl9ieXRlczogMCxcbiAgICAgICAgc3Rkb3V0X3RydW5jYXRlZDogZmFsc2UsXG4gICAgICAgIHN0ZGVycl90cnVuY2F0ZWQ6IGZhbHNlLFxuICAgICAgICAvLyBUaGVzZSBtYWxpY2lvdXMgdmFsdWVzIG11c3QgTkVWRVIgYmUgdXNlZCBhcyBmaWxlc3lzdGVtIHBhdGhzLlxuICAgICAgICBzdGRvdXRfcGF0aDogJy4uLy4uL2V0Yy9wYXNzd2QnLFxuICAgICAgICBzdGRlcnJfcGF0aDogJy4uLy4uL2V0Yy9zaGFkb3cnLFxuICAgICAgfSksXG4gICAgKTtcblxuICAgIGNvbnN0IGVudHJpZXMgPSBsaXN0RXhlY0hpc3RvcnkoYmFzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKGVudHJpZXMubGVuZ3RoLCAxKTtcbiAgICBjb25zdCBlbnRyeSA9IGVudHJpZXNbMF0hO1xuXG4gICAgLy8gc3Rkb3V0X3BhdGggbXVzdCBiZSBkZXJpdmVkIGZyb20gdGhlIG1ldGEgZmlsZSBsb2NhdGlvbiwgbm90IGZyb20gSlNPTi5cbiAgICBhc3NlcnQuZXF1YWwoZW50cnkuc3Rkb3V0X3BhdGgsIHN0ZG91dFBhdGgsXG4gICAgICBgc3Rkb3V0X3BhdGggbXVzdCBiZSBhIHNpYmxpbmcgb2YgdGhlIG1ldGEgZmlsZTsgZ290OiAke2VudHJ5LnN0ZG91dF9wYXRofWApO1xuICAgIGFzc2VydC5lcXVhbChlbnRyeS5zdGRlcnJfcGF0aCwgc3RkZXJyUGF0aCxcbiAgICAgIGBzdGRlcnJfcGF0aCBtdXN0IGJlIGEgc2libGluZyBvZiB0aGUgbWV0YSBmaWxlOyBnb3Q6ICR7ZW50cnkuc3RkZXJyX3BhdGh9YCk7XG5cbiAgICAvLyBWZXJpZnkgbmVpdGhlciB0cmF2ZXJzYWwgc3RyaW5nIGxlYWtlZCBpbnRvIHRoZSByZXR1cm5lZCBlbnRyeS5cbiAgICBhc3NlcnQub2soIWVudHJ5LnN0ZG91dF9wYXRoLmluY2x1ZGVzKCcuLicpLFxuICAgICAgYHN0ZG91dF9wYXRoIG11c3Qgbm90IGNvbnRhaW4gcGF0aCB0cmF2ZXJzYWwgc2VxdWVuY2VzOiAke2VudHJ5LnN0ZG91dF9wYXRofWApO1xuICAgIGFzc2VydC5vayghZW50cnkuc3RkZXJyX3BhdGguaW5jbHVkZXMoJy4uJyksXG4gICAgICBgc3RkZXJyX3BhdGggbXVzdCBub3QgY29udGFpbiBwYXRoIHRyYXZlcnNhbCBzZXF1ZW5jZXM6ICR7ZW50cnkuc3RkZXJyX3BhdGh9YCk7XG4gICAgYXNzZXJ0Lm9rKCFlbnRyeS5zdGRvdXRfcGF0aC5pbmNsdWRlcygnZXRjL3Bhc3N3ZCcpLFxuICAgICAgYHN0ZG91dF9wYXRoIG11c3Qgbm90IHBvaW50IHRvIC9ldGMvcGFzc3dkOiAke2VudHJ5LnN0ZG91dF9wYXRofWApO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KCdzZWFyY2hFeGVjSGlzdG9yeTogZGlnZXN0X3ByZXZpZXcgaXMgcmVhZCBmcm9tIGRlcml2ZWQgc2libGluZyBwYXRoLCBub3QgSlNPTiBzdGRvdXRfcGF0aCcsICgpID0+IHtcbiAgLy8gQXJyYW5nZTogYSAubWV0YS5qc29uIHdpdGggYSBtYWxpY2lvdXMgc3Rkb3V0X3BhdGggcG9pbnRpbmcgdG8gL2V0Yy9wYXNzd2QuXG4gIC8vIFRoZSBkaWdlc3RfcHJldmlldyBzaG91bGQgYmUgcmVhZCBmcm9tIHRoZSByZWFsIHNpYmxpbmcgLnN0ZG91dCBmaWxlLFxuICAvLyBub3QgZnJvbSB0aGUgSlNPTi1zdXBwbGllZCBwYXRoLlxuICBjb25zdCBiYXNlID0gZnJlc2hCYXNlKCk7XG4gIHRyeSB7XG4gICAgY29uc3QgZGlyID0gam9pbihiYXNlLCAnLmdzZCcsICdleGVjJyk7XG4gICAgbWtkaXJTeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgY29uc3QgaWQgPSAncHJldmlldy10cmF2ZXJzYWwtcnVuJztcbiAgICBjb25zdCBtZXRhUGF0aCA9IGpvaW4oZGlyLCBgJHtpZH0ubWV0YS5qc29uYCk7XG4gICAgY29uc3Qgc3Rkb3V0UGF0aCA9IGpvaW4oZGlyLCBgJHtpZH0uc3Rkb3V0YCk7XG4gICAgd3JpdGVGaWxlU3luYyhzdGRvdXRQYXRoLCAnc2FmZS1zZW50aW5lbC1jb250ZW50XFxuJyk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgYCR7aWR9LnN0ZGVycmApLCAnJyk7XG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIG1ldGFQYXRoLFxuICAgICAgSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBpZCxcbiAgICAgICAgcnVudGltZTogJ2Jhc2gnLFxuICAgICAgICBwdXJwb3NlOiBudWxsLFxuICAgICAgICBzdGFydGVkX2F0OiAnMjAyNi0wNC0yMFQxMjowMDowMC4wMDBaJyxcbiAgICAgICAgZmluaXNoZWRfYXQ6ICcyMDI2LTA0LTIwVDEyOjAwOjAwLjEwMFonLFxuICAgICAgICBkdXJhdGlvbl9tczogNTAsXG4gICAgICAgIGV4aXRfY29kZTogMCxcbiAgICAgICAgc2lnbmFsOiBudWxsLFxuICAgICAgICB0aW1lZF9vdXQ6IGZhbHNlLFxuICAgICAgICBzdGRvdXRfYnl0ZXM6IDIxLFxuICAgICAgICBzdGRlcnJfYnl0ZXM6IDAsXG4gICAgICAgIHN0ZG91dF90cnVuY2F0ZWQ6IGZhbHNlLFxuICAgICAgICBzdGRlcnJfdHJ1bmNhdGVkOiBmYWxzZSxcbiAgICAgICAgLy8gQXR0YWNrZXItY29udHJvbGxlZCBwYXRoIFx1MjAxNCBtdXN0IGJlIGlnbm9yZWQuXG4gICAgICAgIHN0ZG91dF9wYXRoOiAnL2V0Yy9wYXNzd2QnLFxuICAgICAgICBzdGRlcnJfcGF0aDogJy9ldGMvc2hhZG93JyxcbiAgICAgIH0pLFxuICAgICk7XG5cbiAgICBjb25zdCBoaXRzID0gc2VhcmNoRXhlY0hpc3RvcnkoYmFzZSwge30pO1xuICAgIGFzc2VydC5lcXVhbChoaXRzLmxlbmd0aCwgMSk7XG4gICAgY29uc3QgaGl0ID0gaGl0c1swXSE7XG5cbiAgICAvLyBUaGUgcHJldmlldyBtdXN0IGNvbWUgZnJvbSB0aGUgc2FmZSBzaWJsaW5nLCBub3QgL2V0Yy9wYXNzd2QuXG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgaGl0LmRpZ2VzdF9wcmV2aWV3Py5pbmNsdWRlcygnc2FmZS1zZW50aW5lbC1jb250ZW50JyksXG4gICAgICBgZGlnZXN0X3ByZXZpZXcgc2hvdWxkIGNvbnRhaW4gc2FmZS1zZW50aW5lbC1jb250ZW50OyBnb3Q6ICR7aGl0LmRpZ2VzdF9wcmV2aWV3fWAsXG4gICAgKTtcbiAgICAvLyBFbnN1cmUgdGhlIGVudHJ5IHBhdGhzIGFyZSB0aGUgZGVyaXZlZCBvbmVzLlxuICAgIGFzc2VydC5lcXVhbChoaXQuZW50cnkuc3Rkb3V0X3BhdGgsIHN0ZG91dFBhdGgpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxZQUFZO0FBQ3JCLE9BQU8sWUFBWTtBQUNuQixTQUFTLFdBQVcsYUFBYSxRQUFRLHFCQUFxQjtBQUM5RCxTQUFTLGNBQWM7QUFDdkIsU0FBUyxZQUFZO0FBRXJCLFNBQVMsaUJBQWlCLHlCQUF5QjtBQUNuRCxTQUFTLHlCQUF5QjtBQUVsQyxTQUFTLFlBQW9CO0FBQzNCLFNBQU8sWUFBWSxLQUFLLE9BQU8sR0FBRyxtQkFBbUIsQ0FBQztBQUN4RDtBQUVBLFNBQVMsUUFBUSxLQUFtQjtBQUNsQyxTQUFPLEtBQUssRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFDOUM7QUFFQSxTQUFTLFNBQVMsTUFBYyxJQUFZLFlBQXFDLENBQUMsR0FBUztBQUN6RixRQUFNLE1BQU0sS0FBSyxNQUFNLFFBQVEsTUFBTTtBQUNyQyxZQUFVLEtBQUssRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNsQyxRQUFNLGFBQWEs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
