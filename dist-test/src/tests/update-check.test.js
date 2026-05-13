import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { compareSemver, readUpdateCache, writeUpdateCache, checkForUpdates, fetchLatestVersionFromRegistry } from "../update-check.js";
test("compareSemver returns 0 for equal versions", () => {
  assert.equal(compareSemver("1.0.0", "1.0.0"), 0);
  assert.equal(compareSemver("2.8.3", "2.8.3"), 0);
});
test("compareSemver returns 1 when first is greater", () => {
  assert.equal(compareSemver("2.0.0", "1.0.0"), 1);
  assert.equal(compareSemver("1.1.0", "1.0.0"), 1);
  assert.equal(compareSemver("1.0.1", "1.0.0"), 1);
  assert.equal(compareSemver("2.8.3", "2.7.1"), 1);
});
test("compareSemver returns -1 when first is smaller", () => {
  assert.equal(compareSemver("1.0.0", "2.0.0"), -1);
  assert.equal(compareSemver("1.0.0", "1.1.0"), -1);
  assert.equal(compareSemver("1.0.0", "1.0.1"), -1);
  assert.equal(compareSemver("2.3.11", "2.8.3"), -1);
});
test("compareSemver handles versions with different segment counts", () => {
  assert.equal(compareSemver("1.0", "1.0.0"), 0);
  assert.equal(compareSemver("1.0.0", "1.0"), 0);
  assert.equal(compareSemver("1.0", "1.0.1"), -1);
  assert.equal(compareSemver("1.0.1", "1.0"), 1);
});
test("readUpdateCache returns null for nonexistent file", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-update-cache-"));
  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
  const result = readUpdateCache(join(tmp, "nonexistent"));
  assert.equal(result, null);
});
test("readUpdateCache returns null for malformed JSON", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-update-cache-"));
  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
  const cachePath = join(tmp, ".update-check");
  writeFileSync(cachePath, "not json");
  const result = readUpdateCache(cachePath);
  assert.equal(result, null);
});
test("writeUpdateCache + readUpdateCache round-trips correctly", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-update-cache-"));
  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
  const cachePath = join(tmp, ".update-check");
  const cache = { lastCheck: Date.now(), latestVersion: "3.0.0" };
  writeUpdateCache(cache, cachePath);
  const result = readUpdateCache(cachePath);
  assert.deepEqual(result, cache);
});
test("writeUpdateCache creates parent directories", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-update-cache-"));
  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
  const cachePath = join(tmp, "nested", "dir", ".update-check");
  writeUpdateCache({ lastCheck: Date.now(), latestVersion: "1.0.0" }, cachePath);
  const raw = readFileSync(cachePath, "utf-8");
  assert.ok(raw.includes("1.0.0"));
});
function startMockRegistry(responseBody, statusCode = 200) {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify(responseBody));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
}
test("checkForUpdates calls onUpdate when newer version is available", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-update-"));
  const registry = await startMockRegistry({ version: "99.0.0" });
  t.after(async () => {
    await registry.close();
    rmSync(tmp, { recursive: true, force: true });
  });
  let called = false;
  let reportedCurrent = "";
  let reportedLatest = "";
  await checkForUpdates({
    currentVersion: "1.0.0",
    cachePath: join(tmp, ".update-check"),
    registryUrl: registry.url,
    checkIntervalMs: 0,
    fetchTimeoutMs: 5e3,
    onUpdate: (current, latest) => {
      called = true;
      reportedCurrent = current;
      reportedLatest = latest;
    }
  });
  assert.ok(called, "onUpdate should have been called");
  assert.equal(reportedCurrent, "1.0.0");
  assert.equal(reportedLatest, "99.0.0");
});
test("checkForUpdates does not call onUpdate when already on latest", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-update-"));
  const registry = await startMockRegistry({ version: "1.0.0" });
  t.after(async () => {
    await registry.close();
    rmSync(tmp, { recursive: true, force: true });
  });
  let called = false;
  await checkForUpdates({
    currentVersion: "1.0.0",
    cachePath: join(tmp, ".update-check"),
    registryUrl: registry.url,
    checkIntervalMs: 0,
    fetchTimeoutMs: 5e3,
    onUpdate: () => {
      called = true;
    }
  });
  assert.ok(!called, "onUpdate should not be called when versions match");
});
test("checkForUpdates does not call onUpdate when current is ahead", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-update-"));
  const registry = await startMockRegistry({ version: "1.0.0" });
  t.after(async () => {
    await registry.close();
    rmSync(tmp, { recursive: true, force: true });
  });
  let called = false;
  await checkForUpdates({
    currentVersion: "2.0.0",
    cachePath: join(tmp, ".update-check"),
    registryUrl: registry.url,
    checkIntervalMs: 0,
    fetchTimeoutMs: 5e3,
    onUpdate: () => {
      called = true;
    }
  });
  assert.ok(!called, "onUpdate should not be called when current is ahead");
});
test("checkForUpdates writes cache after successful fetch", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-update-"));
  const cachePath = join(tmp, ".update-check");
  const registry = await startMockRegistry({ version: "5.0.0" });
  t.after(async () => {
    await registry.close();
    rmSync(tmp, { recursive: true, force: true });
  });
  await checkForUpdates({
    currentVersion: "1.0.0",
    cachePath,
    registryUrl: registry.url,
    checkIntervalMs: 0,
    fetchTimeoutMs: 5e3,
    onUpdate: () => {
    }
  });
  const cache = readUpdateCache(cachePath);
  assert.ok(cache, "cache should exist after fetch");
  assert.equal(cache.latestVersion, "5.0.0");
  assert.ok(cache.lastCheck > 0);
});
test("checkForUpdates uses cache and skips fetch when checked recently", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-update-"));
  const cachePath = join(tmp, ".update-check");
  writeUpdateCache({ lastCheck: Date.now(), latestVersion: "10.0.0" }, cachePath);
  const registry = await startMockRegistry({ version: "20.0.0" });
  t.after(async () => {
    await registry.close();
    rmSync(tmp, { recursive: true, force: true });
  });
  let reportedLatest = "";
  await checkForUpdates({
    currentVersion: "1.0.0",
    cachePath,
    registryUrl: registry.url,
    checkIntervalMs: 60 * 60 * 1e3,
    // 1 hour
    fetchTimeoutMs: 5e3,
    onUpdate: (_current, latest) => {
      reportedLatest = latest;
    }
  });
  assert.equal(reportedLatest, "10.0.0");
});
test("checkForUpdates skips notification when cache is fresh and versions match", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-update-"));
  const cachePath = join(tmp, ".update-check");
  writeUpdateCache({ lastCheck: Date.now(), latestVersion: "1.0.0" }, cachePath);
  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
  let called = false;
  await checkForUpdates({
    currentVersion: "1.0.0",
    cachePath,
    checkIntervalMs: 60 * 60 * 1e3,
    fetchTimeoutMs: 5e3,
    onUpdate: () => {
      called = true;
    }
  });
  assert.ok(!called, "onUpdate should not be called when cached version matches current");
});
test("checkForUpdates handles server error gracefully", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-update-"));
  const registry = await startMockRegistry({}, 500);
  t.after(async () => {
    await registry.close();
    rmSync(tmp, { recursive: true, force: true });
  });
  let called = false;
  await checkForUpdates({
    currentVersion: "1.0.0",
    cachePath: join(tmp, ".update-check"),
    registryUrl: registry.url,
    checkIntervalMs: 0,
    fetchTimeoutMs: 5e3,
    onUpdate: () => {
      called = true;
    }
  });
  assert.ok(!called, "onUpdate should not be called on server error");
});
test("checkForUpdates handles network timeout gracefully", async (t) => {
  const server = createServer(() => {
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const tmp = mkdtempSync(join(tmpdir(), "gsd-update-"));
  t.after(async () => {
    await new Promise((r) => server.close(() => r()));
    rmSync(tmp, { recursive: true, force: true });
  });
  let called = false;
  await checkForUpdates({
    currentVersion: "1.0.0",
    cachePath: join(tmp, ".update-check"),
    registryUrl: `http://127.0.0.1:${addr.port}`,
    checkIntervalMs: 0,
    fetchTimeoutMs: 500,
    // Very short timeout
    onUpdate: () => {
      called = true;
    }
  });
  assert.ok(!called, "onUpdate should not be called on timeout");
});
test("checkForUpdates handles missing version field in response", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-update-"));
  const registry = await startMockRegistry({ name: "gsd-pi" });
  t.after(async () => {
    await registry.close();
    rmSync(tmp, { recursive: true, force: true });
  });
  let called = false;
  await checkForUpdates({
    currentVersion: "1.0.0",
    cachePath: join(tmp, ".update-check"),
    registryUrl: registry.url,
    checkIntervalMs: 0,
    fetchTimeoutMs: 5e3,
    onUpdate: () => {
      called = true;
    }
  });
  assert.ok(!called, "onUpdate should not be called when response has no version");
});
test("fetchLatestVersionFromRegistry returns the registry version string", async (t) => {
  const registry = await startMockRegistry({ version: "2.67.0" });
  t.after(async () => {
    await registry.close();
  });
  const latest = await fetchLatestVersionFromRegistry(registry.url, 5e3);
  assert.equal(latest, "2.67.0");
});
test("fetchLatestVersionFromRegistry returns null for blank version strings", async (t) => {
  const registry = await startMockRegistry({ version: "" });
  t.after(async () => {
    await registry.close();
  });
  const latest = await fetchLatestVersionFromRegistry(registry.url, 5e3);
  assert.equal(latest, null);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3Rlc3RzL3VwZGF0ZS1jaGVjay50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdGVzdCBmcm9tICdub2RlOnRlc3QnXG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCdcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBybVN5bmMsIHJlYWRGaWxlU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gJ25vZGU6ZnMnXG5pbXBvcnQgeyBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJ1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSAnbm9kZTpvcydcbmltcG9ydCB7IGNyZWF0ZVNlcnZlciB9IGZyb20gJ25vZGU6aHR0cCdcblxuaW1wb3J0IHsgY29tcGFyZVNlbXZlciwgcmVhZFVwZGF0ZUNhY2hlLCB3cml0ZVVwZGF0ZUNhY2hlLCBjaGVja0ZvclVwZGF0ZXMsIGZldGNoTGF0ZXN0VmVyc2lvbkZyb21SZWdpc3RyeSB9IGZyb20gJy4uL3VwZGF0ZS1jaGVjay5qcydcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBjb21wYXJlU2VtdmVyXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxudGVzdCgnY29tcGFyZVNlbXZlciByZXR1cm5zIDAgZm9yIGVxdWFsIHZlcnNpb25zJywgKCkgPT4ge1xuICBhc3NlcnQuZXF1YWwoY29tcGFyZVNlbXZlcignMS4wLjAnLCAnMS4wLjAnKSwgMClcbiAgYXNzZXJ0LmVxdWFsKGNvbXBhcmVTZW12ZXIoJzIuOC4zJywgJzIuOC4zJyksIDApXG59KVxuXG50ZXN0KCdjb21wYXJlU2VtdmVyIHJldHVybnMgMSB3aGVuIGZpcnN0IGlzIGdyZWF0ZXInLCAoKSA9PiB7XG4gIGFzc2VydC5lcXVhbChjb21wYXJlU2VtdmVyKCcyLjAuMCcsICcxLjAuMCcpLCAxKVxuICBhc3NlcnQuZXF1YWwoY29tcGFyZVNlbXZlcignMS4xLjAnLCAnMS4wLjAnKSwgMSlcbiAgYXNzZXJ0LmVxdWFsKGNvbXBhcmVTZW12ZXIoJzEuMC4xJywgJzEuMC4wJyksIDEpXG4gIGFzc2VydC5lcXVhbChjb21wYXJlU2VtdmVyKCcyLjguMycsICcyLjcuMScpLCAxKVxufSlcblxudGVzdCgnY29tcGFyZVNlbXZlciByZXR1cm5zIC0xIHdoZW4gZmlyc3QgaXMgc21hbGxlcicsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKGNvbXBhcmVTZW12ZXIoJzEuMC4wJywgJzIuMC4wJyksIC0xKVxuICBhc3NlcnQuZXF1YWwoY29tcGFyZVNlbXZlcignMS4wLjAnLCAnMS4xLjAnKSwgLTEpXG4gIGFzc2VydC5lcXVhbChjb21wYXJlU2VtdmVyKCcxLjAuMCcsICcxLjAuMScpLCAtMSlcbiAgYXNzZXJ0LmVxdWFsKGNvbXBhcmVTZW12ZXIoJzIuMy4xMScsICcyLjguMycpLCAtMSlcbn0pXG5cbnRlc3QoJ2NvbXBhcmVTZW12ZXIgaGFuZGxlcyB2ZXJzaW9ucyB3aXRoIGRpZmZlcmVudCBzZWdtZW50IGNvdW50cycsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKGNvbXBhcmVTZW12ZXIoJzEuMCcsICcxLjAuMCcpLCAwKVxuICBhc3NlcnQuZXF1YWwoY29tcGFyZVNlbXZlcignMS4wLjAnLCAnMS4wJyksIDApXG4gIGFzc2VydC5lcXVhbChjb21wYXJlU2VtdmVyKCcxLjAnLCAnMS4wLjEnKSwgLTEpXG4gIGFzc2VydC5lcXVhbChjb21wYXJlU2VtdmVyKCcxLjAuMScsICcxLjAnKSwgMSlcbn0pXG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gcmVhZFVwZGF0ZUNhY2hlIC8gd3JpdGVVcGRhdGVDYWNoZVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbnRlc3QoJ3JlYWRVcGRhdGVDYWNoZSByZXR1cm5zIG51bGwgZm9yIG5vbmV4aXN0ZW50IGZpbGUnLCAodCkgPT4ge1xuICBjb25zdCB0bXAgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCAnZ3NkLXVwZGF0ZS1jYWNoZS0nKSlcbiAgdC5hZnRlcigoKSA9PiB7IHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSB9KTtcblxuICBjb25zdCByZXN1bHQgPSByZWFkVXBkYXRlQ2FjaGUoam9pbih0bXAsICdub25leGlzdGVudCcpKVxuICBhc3NlcnQuZXF1YWwocmVzdWx0LCBudWxsKVxufSlcblxudGVzdCgncmVhZFVwZGF0ZUNhY2hlIHJldHVybnMgbnVsbCBmb3IgbWFsZm9ybWVkIEpTT04nLCAodCkgPT4ge1xuICBjb25zdCB0bXAgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCAnZ3NkLXVwZGF0ZS1jYWNoZS0nKSlcbiAgdC5hZnRlcigoKSA9PiB7IHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSB9KTtcblxuICBjb25zdCBjYWNoZVBhdGggPSBqb2luKHRtcCwgJy51cGRhdGUtY2hlY2snKVxuICB3cml0ZUZpbGVTeW5jKGNhY2hlUGF0aCwgJ25vdCBqc29uJylcbiAgY29uc3QgcmVzdWx0ID0gcmVhZFVwZGF0ZUNhY2hlKGNhY2hlUGF0aClcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgbnVsbClcbn0pXG5cbnRlc3QoJ3dyaXRlVXBkYXRlQ2FjaGUgKyByZWFkVXBkYXRlQ2FjaGUgcm91bmQtdHJpcHMgY29ycmVjdGx5JywgKHQpID0+IHtcbiAgY29uc3QgdG1wID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgJ2dzZC11cGRhdGUtY2FjaGUtJykpXG4gIHQuYWZ0ZXIoKCkgPT4geyBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkgfSk7XG5cbiAgY29uc3QgY2FjaGVQYXRoID0gam9pbih0bXAsICcudXBkYXRlLWNoZWNrJylcbiAgY29uc3QgY2FjaGUgPSB7IGxhc3RDaGVjazogRGF0ZS5ub3coKSwgbGF0ZXN0VmVyc2lvbjogJzMuMC4wJyB9XG4gIHdyaXRlVXBkYXRlQ2FjaGUoY2FjaGUsIGNhY2hlUGF0aClcbiAgY29uc3QgcmVzdWx0ID0gcmVhZFVwZGF0ZUNhY2hlKGNhY2hlUGF0aClcbiAgYXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQsIGNhY2hlKVxufSlcblxudGVzdCgnd3JpdGVVcGRhdGVDYWNoZSBjcmVhdGVzIHBhcmVudCBkaXJlY3RvcmllcycsICh0KSA9PiB7XG4gIGNvbnN0IHRtcCA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksICdnc2QtdXBkYXRlLWNhY2hlLScpKVxuICB0LmFmdGVyKCgpID0+IHsgcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pIH0pO1xuXG4gIGNvbnN0IGNhY2hlUGF0aCA9IGpvaW4odG1wLCAnbmVzdGVkJywgJ2RpcicsICcudXBkYXRlLWNoZWNrJylcbiAgd3JpdGVVcGRhdGVDYWNoZSh7IGxhc3RDaGVjazogRGF0ZS5ub3coKSwgbGF0ZXN0VmVyc2lvbjogJzEuMC4wJyB9LCBjYWNoZVBhdGgpXG4gIGNvbnN0IHJhdyA9IHJlYWRGaWxlU3luYyhjYWNoZVBhdGgsICd1dGYtOCcpXG4gIGFzc2VydC5vayhyYXcuaW5jbHVkZXMoJzEuMC4wJykpXG59KVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIGNoZWNrRm9yVXBkYXRlcyBcdTIwMTQgaW50ZWdyYXRpb24gdGVzdHMgd2l0aCBhIGxvY2FsIEhUVFAgc2VydmVyXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZnVuY3Rpb24gc3RhcnRNb2NrUmVnaXN0cnkocmVzcG9uc2VCb2R5OiBvYmplY3QsIHN0YXR1c0NvZGUgPSAyMDApOiBQcm9taXNlPHsgdXJsOiBzdHJpbmc7IGNsb3NlOiAoKSA9PiBQcm9taXNlPHZvaWQ+IH0+IHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG4gICAgY29uc3Qgc2VydmVyID0gY3JlYXRlU2VydmVyKChfcmVxLCByZXMpID0+IHtcbiAgICAgIHJlcy53cml0ZUhlYWQoc3RhdHVzQ29kZSwgeyAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nIH0pXG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHJlc3BvbnNlQm9keSkpXG4gICAgfSlcbiAgICBzZXJ2ZXIubGlzdGVuKDAsICcxMjcuMC4wLjEnLCAoKSA9PiB7XG4gICAgICBjb25zdCBhZGRyID0gc2VydmVyLmFkZHJlc3MoKSBhcyB7IHBvcnQ6IG51bWJlciB9XG4gICAgICByZXNvbHZlKHtcbiAgICAgICAgdXJsOiBgaHR0cDovLzEyNy4wLjAuMToke2FkZHIucG9ydH1gLFxuICAgICAgICBjbG9zZTogKCkgPT4gbmV3IFByb21pc2U8dm9pZD4oKHIpID0+IHNlcnZlci5jbG9zZSgoKSA9PiByKCkpKSxcbiAgICAgIH0pXG4gICAgfSlcbiAgfSlcbn1cblxudGVzdCgnY2hlY2tGb3JVcGRhdGVzIGNhbGxzIG9uVXBkYXRlIHdoZW4gbmV3ZXIgdmVyc2lvbiBpcyBhdmFpbGFibGUnLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCB0bXAgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCAnZ3NkLXVwZGF0ZS0nKSlcbiAgY29uc3QgcmVnaXN0cnkgPSBhd2FpdCBzdGFydE1vY2tSZWdpc3RyeSh7IHZlcnNpb246ICc5OS4wLjAnIH0pXG4gIHQuYWZ0ZXIoYXN5bmMgKCkgPT4ge1xuICAgIGF3YWl0IHJlZ2lzdHJ5LmNsb3NlKClcbiAgICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSlcbiAgfSk7XG5cbiAgbGV0IGNhbGxlZCA9IGZhbHNlXG4gIGxldCByZXBvcnRlZEN1cnJlbnQgPSAnJ1xuICBsZXQgcmVwb3J0ZWRMYXRlc3QgPSAnJ1xuXG4gIGF3YWl0IGNoZWNrRm9yVXBkYXRlcyh7XG4gICAgY3VycmVudFZlcnNpb246ICcxLjAuMCcsXG4gICAgY2FjaGVQYXRoOiBqb2luKHRtcCwgJy51cGRhdGUtY2hlY2snKSxcbiAgICByZWdpc3RyeVVybDogcmVnaXN0cnkudXJsLFxuICAgIGNoZWNrSW50ZXJ2YWxNczogMCxcbiAgICBmZXRjaFRpbWVvdXRNczogNTAwMCxcbiAgICBvblVwZGF0ZTogKGN1cnJlbnQsIGxhdGVzdCkgPT4ge1xuICAgICAgY2FsbGVkID0gdHJ1ZVxuICAgICAgcmVwb3J0ZWRDdXJyZW50ID0gY3VycmVudFxuICAgICAgcmVwb3J0ZWRMYXRlc3QgPSBsYXRlc3RcbiAgICB9LFxuICB9KVxuXG4gIGFzc2VydC5vayhjYWxsZWQsICdvblVwZGF0ZSBzaG91bGQgaGF2ZSBiZWVuIGNhbGxlZCcpXG4gIGFzc2VydC5lcXVhbChyZXBvcnRlZEN1cnJlbnQsICcxLjAuMCcpXG4gIGFzc2VydC5lcXVhbChyZXBvcnRlZExhdGVzdCwgJzk5LjAuMCcpXG59KVxuXG50ZXN0KCdjaGVja0ZvclVwZGF0ZXMgZG9lcyBub3QgY2FsbCBvblVwZGF0ZSB3aGVuIGFscmVhZHkgb24gbGF0ZXN0JywgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgdG1wID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgJ2dzZC11cGRhdGUtJykpXG4gIGNvbnN0IHJlZ2lzdHJ5ID0gYXdhaXQgc3RhcnRNb2NrUmVnaXN0cnkoeyB2ZXJzaW9uOiAnMS4wLjAnIH0pXG4gIHQuYWZ0ZXIoYXN5bmMgKCkgPT4ge1xuICAgIGF3YWl0IHJlZ2lzdHJ5LmNsb3NlKClcbiAgICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSlcbiAgfSk7XG5cbiAgbGV0IGNhbGxlZCA9IGZhbHNlXG5cbiAgYXdhaXQgY2hlY2tGb3JVcGRhdGVzKHtcbiAgICBjdXJyZW50VmVyc2lvbjogJzEuMC4wJyxcbiAgICBjYWNoZVBhdGg6IGpvaW4odG1wLCAnLnVwZGF0ZS1jaGVjaycpLFxuICAgIHJlZ2lzdHJ5VXJsOiByZWdpc3RyeS51cmwsXG4gICAgY2hlY2tJbnRlcnZhbE1zOiAwLFxuICAgIGZldGNoVGltZW91dE1zOiA1MDAwLFxuICAgIG9uVXBkYXRlOiAoKSA9PiB7IGNhbGxlZCA9IHRydWUgfSxcbiAgfSlcblxuICBhc3NlcnQub2soIWNhbGxlZCwgJ29uVXBkYXRlIHNob3VsZCBub3QgYmUgY2FsbGVkIHdoZW4gdmVyc2lvbnMgbWF0Y2gnKVxufSlcblxudGVzdCgnY2hlY2tGb3JVcGRhdGVzIGRvZXMgbm90IGNhbGwgb25VcGRhdGUgd2hlbiBjdXJyZW50IGlzIGFoZWFkJywgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgdG1wID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgJ2dzZC11cGRhdGUtJykpXG4gIGNvbnN0IHJlZ2lzdHJ5ID0gYXdhaXQgc3RhcnRNb2NrUmVnaXN0cnkoeyB2ZXJzaW9uOiAnMS4wLjAnIH0pXG4gIHQuYWZ0ZXIoYXN5bmMgKCkgPT4ge1xuICAgIGF3YWl0IHJlZ2lzdHJ5LmNsb3NlKClcbiAgICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSlcbiAgfSk7XG5cbiAgbGV0IGNhbGxlZCA9IGZhbHNlXG5cbiAgYXdhaXQgY2hlY2tGb3JVcGRhdGVzKHtcbiAgICBjdXJyZW50VmVyc2lvbjogJzIuMC4wJyxcbiAgICBjYWNoZVBhdGg6IGpvaW4odG1wLCAnLnVwZGF0ZS1jaGVjaycpLFxuICAgIHJlZ2lzdHJ5VXJsOiByZWdpc3RyeS51cmwsXG4gICAgY2hlY2tJbnRlcnZhbE1zOiAwLFxuICAgIGZldGNoVGltZW91dE1zOiA1MDAwLFxuICAgIG9uVXBkYXRlOiAoKSA9PiB7IGNhbGxlZCA9IHRydWUgfSxcbiAgfSlcblxuICBhc3NlcnQub2soIWNhbGxlZCwgJ29uVXBkYXRlIHNob3VsZCBub3QgYmUgY2FsbGVkIHdoZW4gY3VycmVudCBpcyBhaGVhZCcpXG59KVxuXG50ZXN0KCdjaGVja0ZvclVwZGF0ZXMgd3JpdGVzIGNhY2hlIGFmdGVyIHN1Y2Nlc3NmdWwgZmV0Y2gnLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCB0bXAgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCAnZ3NkLXVwZGF0ZS0nKSlcbiAgY29uc3QgY2FjaGVQYXRoID0gam9pbih0bXAsICcudXBkYXRlLWNoZWNrJylcbiAgY29uc3QgcmVnaXN0cnkgPSBhd2FpdCBzdGFydE1vY2tSZWdpc3RyeSh7IHZlcnNpb246ICc1LjAuMCcgfSlcbiAgdC5hZnRlcihhc3luYyAoKSA9PiB7XG4gICAgYXdhaXQgcmVnaXN0cnkuY2xvc2UoKVxuICAgIHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KVxuICB9KTtcblxuICBhd2FpdCBjaGVja0ZvclVwZGF0ZXMoe1xuICAgIGN1cnJlbnRWZXJzaW9uOiAnMS4wLjAnLFxuICAgIGNhY2hlUGF0aCxcbiAgICByZWdpc3RyeVVybDogcmVnaXN0cnkudXJsLFxuICAgIGNoZWNrSW50ZXJ2YWxNczogMCxcbiAgICBmZXRjaFRpbWVvdXRNczogNTAwMCxcbiAgICBvblVwZGF0ZTogKCkgPT4ge30sXG4gIH0pXG5cbiAgY29uc3QgY2FjaGUgPSByZWFkVXBkYXRlQ2FjaGUoY2FjaGVQYXRoKVxuICBhc3NlcnQub2soY2FjaGUsICdjYWNoZSBzaG91bGQgZXhpc3QgYWZ0ZXIgZmV0Y2gnKVxuICBhc3NlcnQuZXF1YWwoY2FjaGUhLmxhdGVzdFZlcnNpb24sICc1LjAuMCcpXG4gIGFzc2VydC5vayhjYWNoZSEubGFzdENoZWNrID4gMClcbn0pXG5cbnRlc3QoJ2NoZWNrRm9yVXBkYXRlcyB1c2VzIGNhY2hlIGFuZCBza2lwcyBmZXRjaCB3aGVuIGNoZWNrZWQgcmVjZW50bHknLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCB0bXAgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCAnZ3NkLXVwZGF0ZS0nKSlcbiAgY29uc3QgY2FjaGVQYXRoID0gam9pbih0bXAsICcudXBkYXRlLWNoZWNrJylcbiAgLy8gV3JpdGUgYSBmcmVzaCBjYWNoZSBlbnRyeVxuICB3cml0ZVVwZGF0ZUNhY2hlKHsgbGFzdENoZWNrOiBEYXRlLm5vdygpLCBsYXRlc3RWZXJzaW9uOiAnMTAuMC4wJyB9LCBjYWNoZVBhdGgpXG5cbiAgLy8gU3RhcnQgc2VydmVyIHRoYXQgd291bGQgcmV0dXJuIGEgZGlmZmVyZW50IHZlcnNpb24gXHUyMDE0IHNob3VsZCBOT1QgYmUgcmVhY2hlZFxuICBjb25zdCByZWdpc3RyeSA9IGF3YWl0IHN0YXJ0TW9ja1JlZ2lzdHJ5KHsgdmVyc2lvbjogJzIwLjAuMCcgfSlcbiAgdC5hZnRlcihhc3luYyAoKSA9PiB7XG4gICAgYXdhaXQgcmVnaXN0cnkuY2xvc2UoKVxuICAgIHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KVxuICB9KTtcblxuICBsZXQgcmVwb3J0ZWRMYXRlc3QgPSAnJ1xuXG4gIGF3YWl0IGNoZWNrRm9yVXBkYXRlcyh7XG4gICAgY3VycmVudFZlcnNpb246ICcxLjAuMCcsXG4gICAgY2FjaGVQYXRoLFxuICAgIHJlZ2lzdHJ5VXJsOiByZWdpc3RyeS51cmwsXG4gICAgY2hlY2tJbnRlcnZhbE1zOiA2MCAqIDYwICogMTAwMCwgLy8gMSBob3VyXG4gICAgZmV0Y2hUaW1lb3V0TXM6IDUwMDAsXG4gICAgb25VcGRhdGU6IChfY3VycmVudCwgbGF0ZXN0KSA9PiB7IHJlcG9ydGVkTGF0ZXN0ID0gbGF0ZXN0IH0sXG4gIH0pXG5cbiAgLy8gU2hvdWxkIHVzZSBjYWNoZWQgdmVyc2lvbiAoMTAuMC4wKSwgbm90IHRoZSBzZXJ2ZXIncyAoMjAuMC4wKVxuICBhc3NlcnQuZXF1YWwocmVwb3J0ZWRMYXRlc3QsICcxMC4wLjAnKVxufSlcblxudGVzdCgnY2hlY2tGb3JVcGRhdGVzIHNraXBzIG5vdGlmaWNhdGlvbiB3aGVuIGNhY2hlIGlzIGZyZXNoIGFuZCB2ZXJzaW9ucyBtYXRjaCcsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IHRtcCA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksICdnc2QtdXBkYXRlLScpKVxuICBjb25zdCBjYWNoZVBhdGggPSBqb2luKHRtcCwgJy51cGRhdGUtY2hlY2snKVxuICB3cml0ZVVwZGF0ZUNhY2hlKHsgbGFzdENoZWNrOiBEYXRlLm5vdygpLCBsYXRlc3RWZXJzaW9uOiAnMS4wLjAnIH0sIGNhY2hlUGF0aClcblxuICB0LmFmdGVyKCgpID0+IHsgcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pIH0pO1xuXG4gIGxldCBjYWxsZWQgPSBmYWxzZVxuXG4gIGF3YWl0IGNoZWNrRm9yVXBkYXRlcyh7XG4gICAgY3VycmVudFZlcnNpb246ICcxLjAuMCcsXG4gICAgY2FjaGVQYXRoLFxuICAgIGNoZWNrSW50ZXJ2YWxNczogNjAgKiA2MCAqIDEwMDAsXG4gICAgZmV0Y2hUaW1lb3V0TXM6IDUwMDAsXG4gICAgb25VcGRhdGU6ICgpID0+IHsgY2FsbGVkID0gdHJ1ZSB9LFxuICB9KVxuXG4gIGFzc2VydC5vayghY2FsbGVkLCAnb25VcGRhdGUgc2hvdWxkIG5vdCBiZSBjYWxsZWQgd2hlbiBjYWNoZWQgdmVyc2lvbiBtYXRjaGVzIGN1cnJlbnQnKVxufSlcblxudGVzdCgnY2hlY2tGb3JVcGRhdGVzIGhhbmRsZXMgc2VydmVyIGVycm9yIGdyYWNlZnVsbHknLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCB0bXAgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCAnZ3NkLXVwZGF0ZS0nKSlcbiAgY29uc3QgcmVnaXN0cnkgPSBhd2FpdCBzdGFydE1vY2tSZWdpc3RyeSh7fSwgNTAwKVxuICB0LmFmdGVyKGFzeW5jICgpID0+IHtcbiAgICBhd2FpdCByZWdpc3RyeS5jbG9zZSgpXG4gICAgcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pXG4gIH0pO1xuXG4gIGxldCBjYWxsZWQgPSBmYWxzZVxuXG4gIGF3YWl0IGNoZWNrRm9yVXBkYXRlcyh7XG4gICAgY3VycmVudFZlcnNpb246ICcxLjAuMCcsXG4gICAgY2FjaGVQYXRoOiBqb2luKHRtcCwgJy51cGRhdGUtY2hlY2snKSxcbiAgICByZWdpc3RyeVVybDogcmVnaXN0cnkudXJsLFxuICAgIGNoZWNrSW50ZXJ2YWxNczogMCxcbiAgICBmZXRjaFRpbWVvdXRNczogNTAwMCxcbiAgICBvblVwZGF0ZTogKCkgPT4geyBjYWxsZWQgPSB0cnVlIH0sXG4gIH0pXG5cbiAgYXNzZXJ0Lm9rKCFjYWxsZWQsICdvblVwZGF0ZSBzaG91bGQgbm90IGJlIGNhbGxlZCBvbiBzZXJ2ZXIgZXJyb3InKVxufSlcblxudGVzdCgnY2hlY2tGb3JVcGRhdGVzIGhhbmRsZXMgbmV0d29yayB0aW1lb3V0IGdyYWNlZnVsbHknLCBhc3luYyAodCkgPT4ge1xuICAvLyBTdGFydCBhIHNlcnZlciB0aGF0IG5ldmVyIHJlc3BvbmRzXG4gIGNvbnN0IHNlcnZlciA9IGNyZWF0ZVNlcnZlcigoKSA9PiB7IC8qIGludGVudGlvbmFsbHkgbmV2ZXIgcmVzcG9uZCAqLyB9KVxuICBhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4gc2VydmVyLmxpc3RlbigwLCAnMTI3LjAuMC4xJywgcmVzb2x2ZSkpXG4gIGNvbnN0IGFkZHIgPSBzZXJ2ZXIuYWRkcmVzcygpIGFzIHsgcG9ydDogbnVtYmVyIH1cbiAgY29uc3QgdG1wID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgJ2dzZC11cGRhdGUtJykpXG5cbiAgdC5hZnRlcihhc3luYyAoKSA9PiB7XG4gICAgYXdhaXQgbmV3IFByb21pc2U8dm9pZD4oKHIpID0+IHNlcnZlci5jbG9zZSgoKSA9PiByKCkpKVxuICAgIHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KVxuICB9KTtcblxuICBsZXQgY2FsbGVkID0gZmFsc2VcblxuICBhd2FpdCBjaGVja0ZvclVwZGF0ZXMoe1xuICAgIGN1cnJlbnRWZXJzaW9uOiAnMS4wLjAnLFxuICAgIGNhY2hlUGF0aDogam9pbih0bXAsICcudXBkYXRlLWNoZWNrJyksXG4gICAgcmVnaXN0cnlVcmw6IGBodHRwOi8vMTI3LjAuMC4xOiR7YWRkci5wb3J0fWAsXG4gICAgY2hlY2tJbnRlcnZhbE1zOiAwLFxuICAgIGZldGNoVGltZW91dE1zOiA1MDAsIC8vIFZlcnkgc2hvcnQgdGltZW91dFxuICAgIG9uVXBkYXRlOiAoKSA9PiB7IGNhbGxlZCA9IHRydWUgfSxcbiAgfSlcblxuICBhc3NlcnQub2soIWNhbGxlZCwgJ29uVXBkYXRlIHNob3VsZCBub3QgYmUgY2FsbGVkIG9uIHRpbWVvdXQnKVxufSlcblxudGVzdCgnY2hlY2tGb3JVcGRhdGVzIGhhbmRsZXMgbWlzc2luZyB2ZXJzaW9uIGZpZWxkIGluIHJlc3BvbnNlJywgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgdG1wID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgJ2dzZC11cGRhdGUtJykpXG4gIGNvbnN0IHJlZ2lzdHJ5ID0gYXdhaXQgc3RhcnRNb2NrUmVnaXN0cnkoeyBuYW1lOiAnZ3NkLXBpJyB9KSAvLyBubyB2ZXJzaW9uIGZpZWxkXG4gIHQuYWZ0ZXIoYXN5bmMgKCkgPT4ge1xuICAgIGF3YWl0IHJlZ2lzdHJ5LmNsb3NlKClcbiAgICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSlcbiAgfSk7XG5cbiAgbGV0IGNhbGxlZCA9IGZhbHNlXG5cbiAgYXdhaXQgY2hlY2tGb3JVcGRhdGVzKHtcbiAgICBjdXJyZW50VmVyc2lvbjogJzEuMC4wJyxcbiAgICBjYWNoZVBhdGg6IGpvaW4odG1wLCAnLnVwZGF0ZS1jaGVjaycpLFxuICAgIHJlZ2lzdHJ5VXJsOiByZWdpc3RyeS51cmwsXG4gICAgY2hlY2tJbnRlcnZhbE1zOiAwLFxuICAgIGZldGNoVGltZW91dE1zOiA1MDAwLFxuICAgIG9uVXBkYXRlOiAoKSA9PiB7IGNhbGxlZCA9IHRydWUgfSxcbiAgfSlcblxuICBhc3NlcnQub2soIWNhbGxlZCwgJ29uVXBkYXRlIHNob3VsZCBub3QgYmUgY2FsbGVkIHdoZW4gcmVzcG9uc2UgaGFzIG5vIHZlcnNpb24nKVxufSlcblxudGVzdCgnZmV0Y2hMYXRlc3RWZXJzaW9uRnJvbVJlZ2lzdHJ5IHJldHVybnMgdGhlIHJlZ2lzdHJ5IHZlcnNpb24gc3RyaW5nJywgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgcmVnaXN0cnkgPSBhd2FpdCBzdGFydE1vY2tSZWdpc3RyeSh7IHZlcnNpb246ICcyLjY3LjAnIH0pXG4gIHQuYWZ0ZXIoYXN5bmMgKCkgPT4ge1xuICAgIGF3YWl0IHJlZ2lzdHJ5LmNsb3NlKClcbiAgfSlcblxuICBjb25zdCBsYXRlc3QgPSBhd2FpdCBmZXRjaExhdGVzdFZlcnNpb25Gcm9tUmVnaXN0cnkocmVnaXN0cnkudXJsLCA1MDAwKVxuICBhc3NlcnQuZXF1YWwobGF0ZXN0LCAnMi42Ny4wJylcbn0pXG5cbnRlc3QoJ2ZldGNoTGF0ZXN0VmVyc2lvbkZyb21SZWdpc3RyeSByZXR1cm5zIG51bGwgZm9yIGJsYW5rIHZlcnNpb24gc3RyaW5ncycsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IHJlZ2lzdHJ5ID0gYXdhaXQgc3RhcnRNb2NrUmVnaXN0cnkoeyB2ZXJzaW9uOiAnJyB9KVxuICB0LmFmdGVyKGFzeW5jICgpID0+IHtcbiAgICBhd2FpdCByZWdpc3RyeS5jbG9zZSgpXG4gIH0pXG5cbiAgY29uc3QgbGF0ZXN0ID0gYXdhaXQgZmV0Y2hMYXRlc3RWZXJzaW9uRnJvbVJlZ2lzdHJ5KHJlZ2lzdHJ5LnVybCwgNTAwMClcbiAgYXNz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
