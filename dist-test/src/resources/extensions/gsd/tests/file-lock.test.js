import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withFileLock, withFileLockSync } from "../file-lock.js";
const require2 = createRequire(import.meta.url);
function hasProperLockfile() {
  try {
    require2("proper-lockfile");
    return true;
  } catch {
    return false;
  }
}
test("withFileLockSync: executes callback when file does not exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-file-lock-test-"));
  try {
    const missingPath = join(dir, "missing.txt");
    let called = 0;
    const result = withFileLockSync(missingPath, () => {
      called++;
      return "ok";
    });
    assert.equal(result, "ok");
    assert.equal(called, 1, "callback should execute exactly once");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("withFileLock: executes callback when file does not exist", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-file-lock-test-"));
  try {
    const missingPath = join(dir, "missing.txt");
    let called = 0;
    const result = await withFileLock(missingPath, async () => {
      called++;
      return "ok";
    });
    assert.equal(result, "ok");
    assert.equal(called, 1, "callback should execute exactly once");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("withFileLockSync: throws ELOCKED by default (no silent fallback)", () => {
  if (!hasProperLockfile() || process.platform === "win32") {
    return;
  }
  const lockfile = require2("proper-lockfile");
  const dir = mkdtempSync(join(tmpdir(), "gsd-file-lock-test-"));
  const filePath = join(dir, "locked.jsonl");
  writeFileSync(filePath, "{}\n", "utf-8");
  const release = lockfile.lockSync(filePath, { retries: 0, stale: 1e4 });
  try {
    let called = 0;
    assert.throws(
      () => {
        withFileLockSync(
          filePath,
          () => {
            called++;
            return "should-not-return";
          },
          { retries: 0 }
        );
      },
      (err) => err?.code === "ELOCKED"
    );
    assert.equal(called, 0, "callback must not run when lock cannot be acquired");
  } finally {
    release();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('withFileLockSync: onLocked="skip" runs callback unlocked on ELOCKED', () => {
  if (!hasProperLockfile() || process.platform === "win32") {
    return;
  }
  const lockfile = require2("proper-lockfile");
  const dir = mkdtempSync(join(tmpdir(), "gsd-file-lock-test-"));
  const filePath = join(dir, "locked.jsonl");
  writeFileSync(filePath, "{}\n", "utf-8");
  const release = lockfile.lockSync(filePath, { retries: 0, stale: 1e4 });
  try {
    let called = 0;
    const result = withFileLockSync(
      filePath,
      () => {
        called++;
        return "fallback-ok";
      },
      { retries: 0, onLocked: "skip" }
    );
    assert.equal(result, "fallback-ok");
    assert.equal(called, 1, "callback should run when onLocked is skip");
  } finally {
    release();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("withFileLock: throws ELOCKED by default (no silent fallback)", async () => {
  if (!hasProperLockfile() || process.platform === "win32") {
    return;
  }
  const lockfile = require2("proper-lockfile");
  const dir = mkdtempSync(join(tmpdir(), "gsd-file-lock-test-"));
  const filePath = join(dir, "locked.jsonl");
  writeFileSync(filePath, "{}\n", "utf-8");
  const release = await lockfile.lock(filePath, { retries: 0, stale: 1e4 });
  try {
    let called = 0;
    await assert.rejects(
      async () => {
        await withFileLock(
          filePath,
          async () => {
            called++;
            return "should-not-return";
          },
          { retries: 0 }
        );
      },
      (err) => err?.code === "ELOCKED"
    );
    assert.equal(called, 0, "callback must not run when lock cannot be acquired");
  } finally {
    await release();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('withFileLock: onLocked="skip" runs callback unlocked on ELOCKED', async () => {
  if (!hasProperLockfile() || process.platform === "win32") {
    return;
  }
  const lockfile = require2("proper-lockfile");
  const dir = mkdtempSync(join(tmpdir(), "gsd-file-lock-test-"));
  const filePath = join(dir, "locked.jsonl");
  writeFileSync(filePath, "{}\n", "utf-8");
  const release = await lockfile.lock(filePath, { retries: 0, stale: 1e4 });
  try {
    let called = 0;
    const result = await withFileLock(
      filePath,
      async () => {
        called++;
        return "fallback-ok";
      },
      { retries: 0, onLocked: "skip" }
    );
    assert.equal(result, "fallback-ok");
    assert.equal(called, 1, "callback should run when onLocked is skip");
  } finally {
    await release();
    rmSync(dir, { recursive: true, force: true });
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9maWxlLWxvY2sudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGNyZWF0ZVJlcXVpcmUgfSBmcm9tIFwibm9kZTptb2R1bGVcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuXG5pbXBvcnQgeyB3aXRoRmlsZUxvY2ssIHdpdGhGaWxlTG9ja1N5bmMgfSBmcm9tIFwiLi4vZmlsZS1sb2NrLnRzXCI7XG5cbmNvbnN0IHJlcXVpcmUgPSBjcmVhdGVSZXF1aXJlKGltcG9ydC5tZXRhLnVybCk7XG5cbmZ1bmN0aW9uIGhhc1Byb3BlckxvY2tmaWxlKCk6IGJvb2xlYW4ge1xuICB0cnkge1xuICAgIHJlcXVpcmUoXCJwcm9wZXItbG9ja2ZpbGVcIik7XG4gICAgcmV0dXJuIHRydWU7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuXG50ZXN0KFwid2l0aEZpbGVMb2NrU3luYzogZXhlY3V0ZXMgY2FsbGJhY2sgd2hlbiBmaWxlIGRvZXMgbm90IGV4aXN0XCIsICgpID0+IHtcbiAgY29uc3QgZGlyID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtZmlsZS1sb2NrLXRlc3QtXCIpKTtcbiAgdHJ5IHtcbiAgICBjb25zdCBtaXNzaW5nUGF0aCA9IGpvaW4oZGlyLCBcIm1pc3NpbmcudHh0XCIpO1xuICAgIGxldCBjYWxsZWQgPSAwO1xuICAgIGNvbnN0IHJlc3VsdCA9IHdpdGhGaWxlTG9ja1N5bmMobWlzc2luZ1BhdGgsICgpID0+IHtcbiAgICAgIGNhbGxlZCsrO1xuICAgICAgcmV0dXJuIFwib2tcIjtcbiAgICB9KTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIFwib2tcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGNhbGxlZCwgMSwgXCJjYWxsYmFjayBzaG91bGQgZXhlY3V0ZSBleGFjdGx5IG9uY2VcIik7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcIndpdGhGaWxlTG9jazogZXhlY3V0ZXMgY2FsbGJhY2sgd2hlbiBmaWxlIGRvZXMgbm90IGV4aXN0XCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgZGlyID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtZmlsZS1sb2NrLXRlc3QtXCIpKTtcbiAgdHJ5IHtcbiAgICBjb25zdCBtaXNzaW5nUGF0aCA9IGpvaW4oZGlyLCBcIm1pc3NpbmcudHh0XCIpO1xuICAgIGxldCBjYWxsZWQgPSAwO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHdpdGhGaWxlTG9jayhtaXNzaW5nUGF0aCwgYXN5bmMgKCkgPT4ge1xuICAgICAgY2FsbGVkKys7XG4gICAgICByZXR1cm4gXCJva1wiO1xuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgXCJva1wiKTtcbiAgICBhc3NlcnQuZXF1YWwoY2FsbGVkLCAxLCBcImNhbGxiYWNrIHNob3VsZCBleGVjdXRlIGV4YWN0bHkgb25jZVwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwid2l0aEZpbGVMb2NrU3luYzogdGhyb3dzIEVMT0NLRUQgYnkgZGVmYXVsdCAobm8gc2lsZW50IGZhbGxiYWNrKVwiLCAoKSA9PiB7XG4gIGlmICghaGFzUHJvcGVyTG9ja2ZpbGUoKSB8fCBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBsb2NrZmlsZSA9IHJlcXVpcmUoXCJwcm9wZXItbG9ja2ZpbGVcIik7XG4gIGNvbnN0IGRpciA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLWZpbGUtbG9jay10ZXN0LVwiKSk7XG4gIGNvbnN0IGZpbGVQYXRoID0gam9pbihkaXIsIFwibG9ja2VkLmpzb25sXCIpO1xuICB3cml0ZUZpbGVTeW5jKGZpbGVQYXRoLCBcInt9XFxuXCIsIFwidXRmLThcIik7XG5cbiAgY29uc3QgcmVsZWFzZSA9IGxvY2tmaWxlLmxvY2tTeW5jKGZpbGVQYXRoLCB7IHJldHJpZXM6IDAsIHN0YWxlOiAxMDAwMCB9KTtcbiAgdHJ5IHtcbiAgICBsZXQgY2FsbGVkID0gMDtcbiAgICBhc3NlcnQudGhyb3dzKFxuICAgICAgKCkgPT4ge1xuICAgICAgICB3aXRoRmlsZUxvY2tTeW5jKFxuICAgICAgICAgIGZpbGVQYXRoLFxuICAgICAgICAgICgpID0+IHtcbiAgICAgICAgICAgIGNhbGxlZCsrO1xuICAgICAgICAgICAgcmV0dXJuIFwic2hvdWxkLW5vdC1yZXR1cm5cIjtcbiAgICAgICAgICB9LFxuICAgICAgICAgIHsgcmV0cmllczogMCB9LFxuICAgICAgICApO1xuICAgICAgfSxcbiAgICAgIChlcnI6IGFueSkgPT4gZXJyPy5jb2RlID09PSBcIkVMT0NLRURcIixcbiAgICApO1xuICAgIGFzc2VydC5lcXVhbChjYWxsZWQsIDAsIFwiY2FsbGJhY2sgbXVzdCBub3QgcnVuIHdoZW4gbG9jayBjYW5ub3QgYmUgYWNxdWlyZWRcIik7XG4gIH0gZmluYWxseSB7XG4gICAgcmVsZWFzZSgpO1xuICAgIHJtU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJ3aXRoRmlsZUxvY2tTeW5jOiBvbkxvY2tlZD1cXFwic2tpcFxcXCIgcnVucyBjYWxsYmFjayB1bmxvY2tlZCBvbiBFTE9DS0VEXCIsICgpID0+IHtcbiAgaWYgKCFoYXNQcm9wZXJMb2NrZmlsZSgpIHx8IHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIikge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IGxvY2tmaWxlID0gcmVxdWlyZShcInByb3Blci1sb2NrZmlsZVwiKTtcbiAgY29uc3QgZGlyID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtZmlsZS1sb2NrLXRlc3QtXCIpKTtcbiAgY29uc3QgZmlsZVBhdGggPSBqb2luKGRpciwgXCJsb2NrZWQuanNvbmxcIik7XG4gIHdyaXRlRmlsZVN5bmMoZmlsZVBhdGgsIFwie31cXG5cIiwgXCJ1dGYtOFwiKTtcblxuICBjb25zdCByZWxlYXNlID0gbG9ja2ZpbGUubG9ja1N5bmMoZmlsZVBhdGgsIHsgcmV0cmllczogMCwgc3RhbGU6IDEwMDAwIH0pO1xuICB0cnkge1xuICAgIGxldCBjYWxsZWQgPSAwO1xuICAgIGNvbnN0IHJlc3VsdCA9IHdpdGhGaWxlTG9ja1N5bmMoXG4gICAgICBmaWxlUGF0aCxcbiAgICAgICgpID0+IHtcbiAgICAgICAgY2FsbGVkKys7XG4gICAgICAgIHJldHVybiBcImZhbGxiYWNrLW9rXCI7XG4gICAgICB9LFxuICAgICAgeyByZXRyaWVzOiAwLCBvbkxvY2tlZDogXCJza2lwXCIgfSxcbiAgICApO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIFwiZmFsbGJhY2stb2tcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGNhbGxlZCwgMSwgXCJjYWxsYmFjayBzaG91bGQgcnVuIHdoZW4gb25Mb2NrZWQgaXMgc2tpcFwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICByZWxlYXNlKCk7XG4gICAgcm1TeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcIndpdGhGaWxlTG9jazogdGhyb3dzIEVMT0NLRUQgYnkgZGVmYXVsdCAobm8gc2lsZW50IGZhbGxiYWNrKVwiLCBhc3luYyAoKSA9PiB7XG4gIGlmICghaGFzUHJvcGVyTG9ja2ZpbGUoKSB8fCBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBsb2NrZmlsZSA9IHJlcXVpcmUoXCJwcm9wZXItbG9ja2ZpbGVcIik7XG4gIGNvbnN0IGRpciA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLWZpbGUtbG9jay10ZXN0LVwiKSk7XG4gIGNvbnN0IGZpbGVQYXRoID0gam9pbihkaXIsIFwibG9ja2VkLmpzb25sXCIpO1xuICB3cml0ZUZpbGVTeW5jKGZpbGVQYXRoLCBcInt9XFxuXCIsIFwidXRmLThcIik7XG5cbiAgY29uc3QgcmVsZWFzZSA9IGF3YWl0IGxvY2tmaWxlLmxvY2soZmlsZVBhdGgsIHsgcmV0cmllczogMCwgc3RhbGU6IDEwMDAwIH0pO1xuICB0cnkge1xuICAgIGxldCBjYWxsZWQgPSAwO1xuICAgIGF3YWl0IGFzc2VydC5yZWplY3RzKFxuICAgICAgYXN5bmMgKCkgPT4ge1xuICAgICAgICBhd2FpdCB3aXRoRmlsZUxvY2soXG4gICAgICAgICAgZmlsZVBhdGgsXG4gICAgICAgICAgYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgY2FsbGVkKys7XG4gICAgICAgICAgICByZXR1cm4gXCJzaG91bGQtbm90LXJldHVyblwiO1xuICAgICAgICAgIH0sXG4gICAgICAgICAgeyByZXRyaWVzOiAwIH0sXG4gICAgICAgICk7XG4gICAgICB9LFxuICAgICAgKGVycjogYW55KSA9PiBlcnI/LmNvZGUgPT09IFwiRUxPQ0tFRFwiLFxuICAgICk7XG4gICAgYXNzZXJ0LmVxdWFsKGNhbGxlZCwgMCwgXCJjYWxsYmFjayBtdXN0IG5vdCBydW4gd2hlbiBsb2NrIGNhbm5vdCBiZSBhY3F1aXJlZFwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBhd2FpdCByZWxlYXNlKCk7XG4gICAgcm1TeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcIndpdGhGaWxlTG9jazogb25Mb2NrZWQ9XFxcInNraXBcXFwiIHJ1bnMgY2FsbGJhY2sgdW5sb2NrZWQgb24gRUxPQ0tFRFwiLCBhc3luYyAoKSA9PiB7XG4gIGlmICghaGFzUHJvcGVyTG9ja2ZpbGUoKSB8fCBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBsb2NrZmlsZSA9IHJlcXVpcmUoXCJwcm9wZXItbG9ja2ZpbGVcIik7XG4gIGNvbnN0IGRpciA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLWZpbGUtbG9jay10ZXN0LVwiKSk7XG4gIGNvbnN0IGZpbGVQYXRoID0gam9pbihkaXIsIFwibG9ja2VkLmpzb25sXCIpO1xuICB3cml0ZUZpbGVTeW5jKGZpbGVQYXRoLCBcInt9XFxuXCIsIFwidXRmLThcIik7XG5cbiAgY29uc3QgcmVsZWFzZSA9IGF3YWl0IGxvY2tmaWxlLmxvY2soZmlsZVBhdGgsIHsgcmV0cmllczogMCwgc3RhbGU6IDEwMDAwIH0pO1xuICB0cnkge1xuICAgIGxldCBjYWxsZWQgPSAwO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHdpdGhGaWxlTG9jayhcbiAgICAgIGZpbGVQYXRoLFxuICAgICAgYXN5bmMgKCkgPT4ge1xuICAgICAgICBjYWxsZWQrKztcbiAgICAgICAgcmV0dXJuIFwiZmFsbGJhY2stb2tcIjtcbiAgICAgIH0sXG4gICAgICB7IHJldHJpZXM6IDAsIG9uTG9ja2VkOiBcInNraXBcIiB9LFxuICAgICk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgXCJmYWxsYmFjay1va1wiKTtcbiAgICBhc3NlcnQuZXF1YWwoY2FsbGVkLCAxLCBcImNhbGxiYWNrIHNob3VsZCBydW4gd2hlbiBvbkxvY2tlZCBpcyBza2lwXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIGF3YWl0IHJlbGVhc2UoKTtcbiAgICBybVN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUNuQixTQUFTLGFBQWEsUUFBUSxxQkFBcUI7QUFDbkQsU0FBUyxxQkFBcUI7QUFDOUIsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUV2QixTQUFTLGNBQWMsd0JBQXdCO0FBRS9DLE1BQU1BLFdBQVUsY0FBYyxZQUFZLEdBQUc7QUFFN0MsU0FBUyxvQkFBNkI7QUFDcEMsTUFBSTtBQUNGLElBQUFBLFNBQVEsaUJBQWlCO0FBQ3pCLFdBQU87QUFBQSxFQUNULFFBQVE7QUFDTixXQUFPO0FBQUEsRUFDVDtBQUNGO0FBRUEsS0FBSyxnRUFBZ0UsTUFBTTtBQUN6RSxRQUFNLE1BQU0sWUFBWSxLQUFLLE9BQU8sR0FBRyxxQkFBcUIsQ0FBQztBQUM3RCxNQUFJO0FBQ0YsVUFBTSxjQUFjLEtBQUssS0FBSyxhQUFhO0FBQzNDLFFBQUksU0FBUztBQUNiLFVBQU0sU0FBUyxpQkFBaUIsYUFBYSxNQUFNO0FBQ2pEO0FBQ0EsYUFBTztBQUFBLElBQ1QsQ0FBQztBQUVELFdBQU8sTUFBTSxRQUFRLElBQUk7QUFDekIsV0FBTyxNQUFNLFFBQVEsR0FBRyxzQ0FBc0M7QUFBQSxFQUNoRSxVQUFFO0FBQ0EsV0FBTyxLQUFLLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsRUFDOUM7QUFDRixDQUFDO0FBRUQsS0FBSyw0REFBNEQsWUFBWTtBQUMzRSxRQUFNLE1BQU0sWUFBWSxLQUFLLE9BQU8sR0FBRyxxQkFBcUIsQ0FBQztBQUM3RCxNQUFJO0FBQ0YsVUFBTSxjQUFjLEtBQUssS0FBSyxhQUFhO0FBQzNDLFFBQUksU0FBUztBQUNiLFVBQU0sU0FBUyxNQUFNLGFBQWEsYUFBYSxZQUFZO0FBQ3pEO0FBQ0Es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
