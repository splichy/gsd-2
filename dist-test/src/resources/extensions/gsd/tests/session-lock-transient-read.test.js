import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import {
  acquireSessionLock,
  getSessionLockStatus,
  releaseSessionLock,
  readExistingLockDataWithRetry
} from "../session-lock.js";
import { gsdRoot } from "../paths.js";
import { createTestContext } from "./test-helpers.js";
const { assertEq, assertTrue, report } = createTestContext();
async function main() {
  console.log("\n=== 1. readExistingLockDataWithRetry reads file normally ===");
  {
    const base = mkdtempSync(join(tmpdir(), "gsd-transient-"));
    mkdirSync(join(base, ".gsd"), { recursive: true });
    try {
      const lockFile = join(gsdRoot(base), "auto.lock");
      const lockData = {
        pid: process.pid,
        startedAt: (/* @__PURE__ */ new Date()).toISOString(),
        unitType: "execute-task",
        unitId: "M001/S01/T01",
        unitStartedAt: (/* @__PURE__ */ new Date()).toISOString(),
        sessionFile: "test-session.json"
      };
      writeFileSync(lockFile, JSON.stringify(lockData, null, 2));
      const result = readExistingLockDataWithRetry(lockFile);
      assertTrue(result !== null, "data returned for readable file");
      assertEq(result.pid, process.pid, "correct PID read");
      assertEq(result.sessionFile, "test-session.json", "correct sessionFile read");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
  console.log("\n=== 2. readExistingLockDataWithRetry returns null for missing file ===");
  {
    const base = mkdtempSync(join(tmpdir(), "gsd-transient-"));
    mkdirSync(join(base, ".gsd"), { recursive: true });
    try {
      const lockFile = join(gsdRoot(base), "auto.lock");
      const result = readExistingLockDataWithRetry(lockFile, { maxAttempts: 2, delayMs: 10 });
      assertEq(result, null, "null for truly missing file after retries");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
  console.log("\n=== 3. readExistingLockDataWithRetry recovers after transient unavailability ===");
  {
    const base = mkdtempSync(join(tmpdir(), "gsd-transient-"));
    mkdirSync(join(base, ".gsd"), { recursive: true });
    try {
      const lockFile = join(gsdRoot(base), "auto.lock");
      const tmpFile = lockFile + ".hidden";
      const lockData = {
        pid: process.pid,
        startedAt: (/* @__PURE__ */ new Date()).toISOString(),
        unitType: "execute-task",
        unitId: "M001/S01/T01",
        unitStartedAt: (/* @__PURE__ */ new Date()).toISOString(),
        sessionFile: "recovery-session.json"
      };
      writeFileSync(lockFile, JSON.stringify(lockData, null, 2));
      renameSync(lockFile, tmpFile);
      spawn("bash", ["-c", `sleep 0.05 && mv "${tmpFile}" "${lockFile}"`], { stdio: "ignore", detached: true }).unref();
      const result = readExistingLockDataWithRetry(lockFile, { maxAttempts: 8, delayMs: 400 });
      assertTrue(result !== null, "data recovered after transient unavailability");
      if (result) {
        assertEq(result.pid, process.pid, "correct PID after recovery");
        assertEq(result.sessionFile, "recovery-session.json", "correct sessionFile after recovery");
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
  console.log("\n=== 4. readExistingLockDataWithRetry recovers from transient permission error ===");
  {
    const base = mkdtempSync(join(tmpdir(), "gsd-transient-"));
    mkdirSync(join(base, ".gsd"), { recursive: true });
    try {
      const lockFile = join(gsdRoot(base), "auto.lock");
      const lockData = {
        pid: process.pid,
        startedAt: (/* @__PURE__ */ new Date()).toISOString(),
        unitType: "execute-task",
        unitId: "M001/S01/T01",
        unitStartedAt: (/* @__PURE__ */ new Date()).toISOString(),
        sessionFile: "perm-session.json"
      };
      writeFileSync(lockFile, JSON.stringify(lockData, null, 2));
      chmodSync(lockFile, 0);
      spawn("bash", ["-c", `sleep 0.05 && chmod 644 "${lockFile}"`], { stdio: "ignore", detached: true }).unref();
      const result = readExistingLockDataWithRetry(lockFile, { maxAttempts: 8, delayMs: 400 });
      assertTrue(result !== null, "data recovered after transient permission error");
      if (result) {
        assertEq(result.pid, process.pid, "correct PID after permission recovery");
      }
      try {
        chmodSync(lockFile, 420);
      } catch {
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
  console.log("\n=== 5. getSessionLockStatus tolerates transient lock file unavailability ===");
  {
    const base = mkdtempSync(join(tmpdir(), "gsd-transient-"));
    mkdirSync(join(base, ".gsd"), { recursive: true });
    try {
      const result = acquireSessionLock(base);
      assertTrue(result.acquired, "lock acquired");
      const status1 = getSessionLockStatus(base);
      assertTrue(status1.valid, "lock valid before transient failure");
      const lockFile = join(gsdRoot(base), "auto.lock");
      const tmpFile = lockFile + ".hidden";
      renameSync(lockFile, tmpFile);
      setTimeout(() => {
        try {
          renameSync(tmpFile, lockFile);
        } catch {
        }
      }, 30);
      await new Promise((r) => setTimeout(r, 60));
      const status2 = getSessionLockStatus(base);
      assertTrue(status2.valid, "lock still valid after transient file disappearance (OS lock held)");
      try {
        renameSync(tmpFile, lockFile);
      } catch {
      }
      releaseSessionLock(base);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
  console.log("\n=== 6. Default retry params: function works with defaults ===");
  {
    const base = mkdtempSync(join(tmpdir(), "gsd-transient-"));
    mkdirSync(join(base, ".gsd"), { recursive: true });
    try {
      const lockFile = join(gsdRoot(base), "auto.lock");
      const lockData = {
        pid: process.pid,
        startedAt: (/* @__PURE__ */ new Date()).toISOString(),
        unitType: "execute-task",
        unitId: "M001/S01/T01",
        unitStartedAt: (/* @__PURE__ */ new Date()).toISOString(),
        sessionFile: "status-session.json"
      };
      writeFileSync(lockFile, JSON.stringify(lockData, null, 2));
      const result = readExistingLockDataWithRetry(lockFile);
      assertTrue(result !== null, "default params work for readable file");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
  report();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9zZXNzaW9uLWxvY2stdHJhbnNpZW50LXJlYWQudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBzZXNzaW9uLWxvY2stdHJhbnNpZW50LXJlYWQudGVzdC50cyBcdTIwMTQgVGVzdHMgZm9yIHRyYW5zaWVudCBsb2NrIGZpbGUgdW5yZWFkYWJpbGl0eSAoIzIzMjQpLlxuICpcbiAqIFJlZ3Jlc3Npb24gY292ZXJhZ2UgZm9yOlxuICogICAjMjMyNCAgb25Db21wcm9taXNlZCBkZWNsYXJlcyBsb2NrIGxvc3Qgd2hlbiB0aGUgbG9jayBmaWxlIGlzIHRlbXBvcmFyaWx5XG4gKiAgICAgICAgICB1bnJlYWRhYmxlIChORlMvQ0lGUyBsYXRlbmN5LCBtYWNPUyBBUEZTIHNuYXBzaG90LCBjb25jdXJyZW50IHByb2Nlc3NcbiAqICAgICAgICAgIGJyaWVmbHkgaG9sZGluZyB0aGUgZmlsZSkuXG4gKlxuICogVGVzdHM6XG4gKiAgIC0gcmVhZEV4aXN0aW5nTG9ja0RhdGFXaXRoUmV0cnkgcmV0cmllcyBvbiB0cmFuc2llbnQgcmVhZCBmYWlsdXJlXG4gKiAgIC0gcmVhZEV4aXN0aW5nTG9ja0RhdGFXaXRoUmV0cnkgcmV0dXJucyBkYXRhIHdoZW4gZmlsZSBiZWNvbWVzIHJlYWRhYmxlIGFmdGVyIHJldHJpZXNcbiAqICAgLSByZWFkRXhpc3RpbmdMb2NrRGF0YVdpdGhSZXRyeSByZXR1cm5zIG51bGwgb25seSB3aGVuIEFMTCByZXRyaWVzIGV4aGF1c3RlZFxuICogICAtIG9uQ29tcHJvbWlzZWQgZG9lcyBub3QgZGVjbGFyZSBjb21wcm9taXNlIHdoZW4gbG9jayBmaWxlIGlzIHRyYW5zaWVudGx5IHVucmVhZGFibGVcbiAqL1xuXG5pbXBvcnQgeyBta2R0ZW1wU3luYywgbWtkaXJTeW5jLCB3cml0ZUZpbGVTeW5jLCBybVN5bmMsIGV4aXN0c1N5bmMsIHJlbmFtZVN5bmMsIHVubGlua1N5bmMsIGNobW9kU3luYyB9IGZyb20gJ25vZGU6ZnMnO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gJ25vZGU6cGF0aCc7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tICdub2RlOm9zJztcbmltcG9ydCB7IGV4ZWNTeW5jLCBzcGF3biB9IGZyb20gJ25vZGU6Y2hpbGRfcHJvY2Vzcyc7XG5cbmltcG9ydCB7XG4gIGFjcXVpcmVTZXNzaW9uTG9jayxcbiAgZ2V0U2Vzc2lvbkxvY2tTdGF0dXMsXG4gIHJlbGVhc2VTZXNzaW9uTG9jayxcbiAgcmVhZEV4aXN0aW5nTG9ja0RhdGFXaXRoUmV0cnksXG4gIHR5cGUgU2Vzc2lvbkxvY2tEYXRhLFxufSBmcm9tICcuLi9zZXNzaW9uLWxvY2sudHMnO1xuaW1wb3J0IHsgZ3NkUm9vdCB9IGZyb20gJy4uL3BhdGhzLnRzJztcbmltcG9ydCB7IGNyZWF0ZVRlc3RDb250ZXh0IH0gZnJvbSAnLi90ZXN0LWhlbHBlcnMudHMnO1xuXG5jb25zdCB7IGFzc2VydEVxLCBhc3NlcnRUcnVlLCByZXBvcnQgfSA9IGNyZWF0ZVRlc3RDb250ZXh0KCk7XG5cbmFzeW5jIGZ1bmN0aW9uIG1haW4oKTogUHJvbWlzZTx2b2lkPiB7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIDEuIHJlYWRFeGlzdGluZ0xvY2tEYXRhV2l0aFJldHJ5IHN1Y2NlZWRzIG9uIGZpcnN0IHJlYWQgd2hlbiBmaWxlIGlzIGZpbmUgXHUyNTAwXG4gIGNvbnNvbGUubG9nKCdcXG49PT0gMS4gcmVhZEV4aXN0aW5nTG9ja0RhdGFXaXRoUmV0cnkgcmVhZHMgZmlsZSBub3JtYWxseSA9PT0nKTtcbiAge1xuICAgIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCAnZ3NkLXRyYW5zaWVudC0nKSk7XG4gICAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgJy5nc2QnKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgbG9ja0ZpbGUgPSBqb2luKGdzZFJvb3QoYmFzZSksICdhdXRvLmxvY2snKTtcbiAgICAgIGNvbnN0IGxvY2tEYXRhOiBTZXNzaW9uTG9ja0RhdGEgPSB7XG4gICAgICAgIHBpZDogcHJvY2Vzcy5waWQsXG4gICAgICAgIHN0YXJ0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgICB1bml0VHlwZTogJ2V4ZWN1dGUtdGFzaycsXG4gICAgICAgIHVuaXRJZDogJ00wMDEvUzAxL1QwMScsXG4gICAgICAgIHVuaXRTdGFydGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgc2Vzc2lvbkZpbGU6ICd0ZXN0LXNlc3Npb24uanNvbicsXG4gICAgICB9O1xuICAgICAgd3JpdGVGaWxlU3luYyhsb2NrRmlsZSwgSlNPTi5zdHJpbmdpZnkobG9ja0RhdGEsIG51bGwsIDIpKTtcblxuICAgICAgY29uc3QgcmVzdWx0ID0gcmVhZEV4aXN0aW5nTG9ja0RhdGFXaXRoUmV0cnkobG9ja0ZpbGUpO1xuICAgICAgYXNzZXJ0VHJ1ZShyZXN1bHQgIT09IG51bGwsICdkYXRhIHJldHVybmVkIGZvciByZWFkYWJsZSBmaWxlJyk7XG4gICAgICBhc3NlcnRFcShyZXN1bHQhLnBpZCwgcHJvY2Vzcy5waWQsICdjb3JyZWN0IFBJRCByZWFkJyk7XG4gICAgICBhc3NlcnRFcShyZXN1bHQhLnNlc3Npb25GaWxlLCAndGVzdC1zZXNzaW9uLmpzb24nLCAnY29ycmVjdCBzZXNzaW9uRmlsZSByZWFkJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIDIuIHJlYWRFeGlzdGluZ0xvY2tEYXRhV2l0aFJldHJ5IHJldHVybnMgbnVsbCBmb3IgdHJ1bHkgbWlzc2luZyBmaWxlIFx1MjUwMFx1MjUwMFxuICBjb25zb2xlLmxvZygnXFxuPT09IDIuIHJlYWRFeGlzdGluZ0xvY2tEYXRhV2l0aFJldHJ5IHJldHVybnMgbnVsbCBmb3IgbWlzc2luZyBmaWxlID09PScpO1xuICB7XG4gICAgY29uc3QgYmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksICdnc2QtdHJhbnNpZW50LScpKTtcbiAgICBta2RpclN5bmMoam9pbihiYXNlLCAnLmdzZCcpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCBsb2NrRmlsZSA9IGpvaW4oZ3NkUm9vdChiYXNlKSwgJ2F1dG8ubG9jaycpO1xuICAgICAgLy8gRmlsZSBkb2Vzbid0IGV4aXN0XG4gICAgICBjb25zdCByZXN1bHQgPSByZWFkRXhpc3RpbmdMb2NrRGF0YVdpdGhSZXRyeShsb2NrRmlsZSwgeyBtYXhBdHRlbXB0czogMiwgZGVsYXlNczogMTAgfSk7XG4gICAgICBhc3NlcnRFcShyZXN1bHQsIG51bGwsICdudWxsIGZvciB0cnVseSBtaXNzaW5nIGZpbGUgYWZ0ZXIgcmV0cmllcycpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCAzLiByZWFkRXhpc3RpbmdMb2NrRGF0YVdpdGhSZXRyeSByZWNvdmVycyBhZnRlciB0cmFuc2llbnQgcmVuYW1lIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBjb25zb2xlLmxvZygnXFxuPT09IDMuIHJlYWRFeGlzdGluZ0xvY2tEYXRhV2l0aFJldHJ5IHJlY292ZXJzIGFmdGVyIHRyYW5zaWVudCB1bmF2YWlsYWJpbGl0eSA9PT0nKTtcbiAge1xuICAgIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCAnZ3NkLXRyYW5zaWVudC0nKSk7XG4gICAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgJy5nc2QnKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgbG9ja0ZpbGUgPSBqb2luKGdzZFJvb3QoYmFzZSksICdhdXRvLmxvY2snKTtcbiAgICAgIGNvbnN0IHRtcEZpbGUgPSBsb2NrRmlsZSArICcuaGlkZGVuJztcbiAgICAgIGNvbnN0IGxvY2tEYXRhOiBTZXNzaW9uTG9ja0RhdGEgPSB7XG4gICAgICAgIHBpZDogcHJvY2Vzcy5waWQsXG4gICAgICAgIHN0YXJ0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgICB1bml0VHlwZTogJ2V4ZWN1dGUtdGFzaycsXG4gICAgICAgIHVuaXRJZDogJ00wMDEvUzAxL1QwMScsXG4gICAgICAgIHVuaXRTdGFydGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgc2Vzc2lvbkZpbGU6ICdyZWNvdmVyeS1zZXNzaW9uLmpzb24nLFxuICAgICAgfTtcbiAgICAgIHdyaXRlRmlsZVN5bmMobG9ja0ZpbGUsIEpTT04uc3RyaW5naWZ5KGxvY2tEYXRhLCBudWxsLCAyKSk7XG5cbiAgICAgIC8vIFNpbXVsYXRlIHRyYW5zaWVudCB1bmF2YWlsYWJpbGl0eTogbW92ZSBmaWxlIGF3YXksIHNwYXduIGEgY2hpbGQgcHJvY2Vzc1xuICAgICAgLy8gdG8gcmVzdG9yZSBpdCBzaG9ydGx5IGFmdGVyLiBUaGUgY2hpbGQgcnVucyBvdXRzaWRlIG91ciBldmVudCBsb29wIHNvIGl0XG4gICAgICAvLyBmaXJlcyBldmVuIGR1cmluZyBidXN5LXdhaXQgcmV0cmllcy4gR2l2ZSB0aGUgdGVzdCBleHRyYSByZXRyeSBidWRnZXQgc29cbiAgICAgIC8vIGl0IHN0YXlzIHN0YWJsZSB1bmRlciBmdWxsLXN1aXRlIENQVSBjb250ZW50aW9uLlxuICAgICAgcmVuYW1lU3luYyhsb2NrRmlsZSwgdG1wRmlsZSk7XG4gICAgICBzcGF3bignYmFzaCcsIFsnLWMnLCBgc2xlZXAgMC4wNSAmJiBtdiBcIiR7dG1wRmlsZX1cIiBcIiR7bG9ja0ZpbGV9XCJgXSwgeyBzdGRpbzogJ2lnbm9yZScsIGRldGFjaGVkOiB0cnVlIH0pLnVucmVmKCk7XG5cbiAgICAgIGNvbnN0IHJlc3VsdCA9IHJlYWRFeGlzdGluZ0xvY2tEYXRhV2l0aFJldHJ5KGxvY2tGaWxlLCB7IG1heEF0dGVtcHRzOiA4LCBkZWxheU1zOiA0MDAgfSk7XG4gICAgICBhc3NlcnRUcnVlKHJlc3VsdCAhPT0gbnVsbCwgJ2RhdGEgcmVjb3ZlcmVkIGFmdGVyIHRyYW5zaWVudCB1bmF2YWlsYWJpbGl0eScpO1xuICAgICAgaWYgKHJlc3VsdCkge1xuICAgICAgICBhc3NlcnRFcShyZXN1bHQucGlkLCBwcm9jZXNzLnBpZCwgJ2NvcnJlY3QgUElEIGFmdGVyIHJlY292ZXJ5Jyk7XG4gICAgICAgIGFzc2VydEVxKHJlc3VsdC5zZXNzaW9uRmlsZSwgJ3JlY292ZXJ5LXNlc3Npb24uanNvbicsICdjb3JyZWN0IHNlc3Npb25GaWxlIGFmdGVyIHJlY292ZXJ5Jyk7XG4gICAgICB9XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIDQuIHJlYWRFeGlzdGluZ0xvY2tEYXRhV2l0aFJldHJ5IHJlY292ZXJzIGZyb20gdHJhbnNpZW50IHBlcm1pc3Npb24gZXJyb3IgXHUyNTAwXG4gIGNvbnNvbGUubG9nKCdcXG49PT0gNC4gcmVhZEV4aXN0aW5nTG9ja0RhdGFXaXRoUmV0cnkgcmVjb3ZlcnMgZnJvbSB0cmFuc2llbnQgcGVybWlzc2lvbiBlcnJvciA9PT0nKTtcbiAge1xuICAgIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCAnZ3NkLXRyYW5zaWVudC0nKSk7XG4gICAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgJy5nc2QnKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgbG9ja0ZpbGUgPSBqb2luKGdzZFJvb3QoYmFzZSksICdhdXRvLmxvY2snKTtcbiAgICAgIGNvbnN0IGxvY2tEYXRhOiBTZXNzaW9uTG9ja0RhdGEgPSB7XG4gICAgICAgIHBpZDogcHJvY2Vzcy5waWQsXG4gICAgICAgIHN0YXJ0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgICB1bml0VHlwZTogJ2V4ZWN1dGUtdGFzaycsXG4gICAgICAgIHVuaXRJZDogJ00wMDEvUzAxL1QwMScsXG4gICAgICAgIHVuaXRTdGFydGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgc2Vzc2lvbkZpbGU6ICdwZXJtLXNlc3Npb24uanNvbicsXG4gICAgICB9O1xuICAgICAgd3JpdGVGaWxlU3luYyhsb2NrRmlsZSwgSlNPTi5zdHJpbmdpZnkobG9ja0RhdGEsIG51bGwsIDIpKTtcblxuICAgICAgLy8gUmVtb3ZlIHJlYWQgcGVybWlzc2lvbiB0byBzaW11bGF0ZSBORlMvQ0lGUyBsYXRlbmN5LCB0aGVuIHNwYXduIGEgY2hpbGRcbiAgICAgIC8vIHRvIHJlc3RvcmUgcGVybWlzc2lvbnMgc2hvcnRseSBhZnRlciAocnVucyBvdXRzaWRlIG91ciBldmVudCBsb29wKS5cbiAgICAgIC8vIFVzZSB0aGUgc2FtZSB3aWRlciByZXRyeSB3aW5kb3cgYXMgdGhlIHJlbmFtZSBjYXNlIGZvciBmdWxsLXN1aXRlIHN0YWJpbGl0eS5cbiAgICAgIGNobW9kU3luYyhsb2NrRmlsZSwgMG8wMDApO1xuICAgICAgc3Bhd24oJ2Jhc2gnLCBbJy1jJywgYHNsZWVwIDAuMDUgJiYgY2htb2QgNjQ0IFwiJHtsb2NrRmlsZX1cImBdLCB7IHN0ZGlvOiAnaWdub3JlJywgZGV0YWNoZWQ6IHRydWUgfSkudW5yZWYoKTtcblxuICAgICAgY29uc3QgcmVzdWx0ID0gcmVhZEV4aXN0aW5nTG9ja0RhdGFXaXRoUmV0cnkobG9ja0ZpbGUsIHsgbWF4QXR0ZW1wdHM6IDgsIGRlbGF5TXM6IDQwMCB9KTtcbiAgICAgIGFzc2VydFRydWUocmVzdWx0ICE9PSBudWxsLCAnZGF0YSByZWNvdmVyZWQgYWZ0ZXIgdHJhbnNpZW50IHBlcm1pc3Npb24gZXJyb3InKTtcbiAgICAgIGlmIChyZXN1bHQpIHtcbiAgICAgICAgYXNzZXJ0RXEocmVzdWx0LnBpZCwgcHJvY2Vzcy5waWQsICdjb3JyZWN0IFBJRCBhZnRlciBwZXJtaXNzaW9uIHJlY292ZXJ5Jyk7XG4gICAgICB9XG5cbiAgICAgIC8vIEVuc3VyZSBwZXJtaXNzaW9ucyByZXN0b3JlZCBmb3IgY2xlYW51cFxuICAgICAgdHJ5IHsgY2htb2RTeW5jKGxvY2tGaWxlLCAwbzY0NCk7IH0gY2F0Y2ggeyAvKiBiZXN0LWVmZm9ydCAqLyB9XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIDUuIGdldFNlc3Npb25Mb2NrU3RhdHVzIGRvZXMgbm90IGZhbHNlLXBvc2l0aXZlIG9uIHRyYW5zaWVudCByZWFkIGZhaWx1cmUgXHUyNTAwXG4gIGNvbnNvbGUubG9nKCdcXG49PT0gNS4gZ2V0U2Vzc2lvbkxvY2tTdGF0dXMgdG9sZXJhdGVzIHRyYW5zaWVudCBsb2NrIGZpbGUgdW5hdmFpbGFiaWxpdHkgPT09Jyk7XG4gIHtcbiAgICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgJ2dzZC10cmFuc2llbnQtJykpO1xuICAgIG1rZGlyU3luYyhqb2luKGJhc2UsICcuZ3NkJyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGFjcXVpcmVTZXNzaW9uTG9jayhiYXNlKTtcbiAgICAgIGFzc2VydFRydWUocmVzdWx0LmFjcXVpcmVkLCAnbG9jayBhY3F1aXJlZCcpO1xuXG4gICAgICAvLyBWYWxpZGF0ZSB3b3JrcyBpbml0aWFsbHlcbiAgICAgIGNvbnN0IHN0YXR1czEgPSBnZXRTZXNzaW9uTG9ja1N0YXR1cyhiYXNlKTtcbiAgICAgIGFzc2VydFRydWUoc3RhdHVzMS52YWxpZCwgJ2xvY2sgdmFsaWQgYmVmb3JlIHRyYW5zaWVudCBmYWlsdXJlJyk7XG5cbiAgICAgIC8vIFRlbXBvcmFyaWx5IGhpZGUgdGhlIGxvY2sgZmlsZVxuICAgICAgY29uc3QgbG9ja0ZpbGUgPSBqb2luKGdzZFJvb3QoYmFzZSksICdhdXRvLmxvY2snKTtcbiAgICAgIGNvbnN0IHRtcEZpbGUgPSBsb2NrRmlsZSArICcuaGlkZGVuJztcbiAgICAgIHJlbmFtZVN5bmMobG9ja0ZpbGUsIHRtcEZpbGUpO1xuXG4gICAgICAvLyBTY2hlZHVsZSByZXN0b3JhdGlvblxuICAgICAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgIHRyeSB7IHJlbmFtZVN5bmModG1wRmlsZSwgbG9ja0ZpbGUpOyB9IGNhdGNoIHsgLyogYmVzdC1lZmZvcnQgKi8gfVxuICAgICAgfSwgMzApO1xuXG4gICAgICAvLyBTbWFsbCBkZWxheSB0byBlbnN1cmUgcmVzdG9yYXRpb24gcnVucywgdGhlbiBjaGVjayBcdTIwMTQgd2l0aCB0aGUgT1MgbG9ja1xuICAgICAgLy8gc3RpbGwgaGVsZCwgZ2V0U2Vzc2lvbkxvY2tTdGF0dXMgc2hvdWxkIHJldHVybiB2YWxpZD10cnVlIGV2ZW4gaWYgdGhlXG4gICAgICAvLyBsb2NrIGZpbGUgd2FzIGJyaWVmbHkgbWlzc2luZyAoaXQgY2hlY2tzIF9yZWxlYXNlRnVuY3Rpb24gZmlyc3QpLlxuICAgICAgYXdhaXQgbmV3IFByb21pc2UociA9PiBzZXRUaW1lb3V0KHIsIDYwKSk7XG4gICAgICBjb25zdCBzdGF0dXMyID0gZ2V0U2Vzc2lvbkxvY2tTdGF0dXMoYmFzZSk7XG4gICAgICBhc3NlcnRUcnVlKHN0YXR1czIudmFsaWQsICdsb2NrIHN0aWxsIHZhbGlkIGFmdGVyIHRyYW5zaWVudCBmaWxlIGRpc2FwcGVhcmFuY2UgKE9TIGxvY2sgaGVsZCknKTtcblxuICAgICAgLy8gUmVzdG9yZSBpZiBub3QgeWV0IHJlc3RvcmVkXG4gICAgICB0cnkgeyByZW5hbWVTeW5jKHRtcEZpbGUsIGxvY2tGaWxlKTsgfSBjYXRjaCB7IC8qIGFscmVhZHkgcmVzdG9yZWQgKi8gfVxuXG4gICAgICByZWxlYXNlU2Vzc2lvbkxvY2soYmFzZSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIDYuIFJldHJ5IGRlZmF1bHRzOiAzIGF0dGVtcHRzIHdpdGggMjAwbXMgZGVsYXkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGNvbnNvbGUubG9nKCdcXG49PT0gNi4gRGVmYXVsdCByZXRyeSBwYXJhbXM6IGZ1bmN0aW9uIHdvcmtzIHdpdGggZGVmYXVsdHMgPT09Jyk7XG4gIHtcbiAgICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgJ2dzZC10cmFuc2llbnQtJykpO1xuICAgIG1rZGlyU3luYyhqb2luKGJhc2UsICcuZ3NkJyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGxvY2tGaWxlID0gam9pbihnc2RSb290KGJhc2UpLCAnYXV0by5sb2NrJyk7XG4gICAgICBjb25zdCBsb2NrRGF0YTogU2Vzc2lvbkxvY2tEYXRhID0ge1xuICAgICAgICBwaWQ6IHByb2Nlc3MucGlkLFxuICAgICAgICBzdGFydGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgdW5pdFR5cGU6ICdleGVjdXRlLXRhc2snLFxuICAgICAgICB1bml0SWQ6ICdNMDAxL1MwMS9UMDEnLFxuICAgICAgICB1bml0U3RhcnRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICAgIHNlc3Npb25GaWxlOiAnc3RhdHVzLXNlc3Npb24uanNvbicsXG4gICAgICB9O1xuICAgICAgd3JpdGVGaWxlU3luYyhsb2NrRmlsZSwgSlNPTi5zdHJpbmdpZnkobG9ja0RhdGEsIG51bGwsIDIpKTtcblxuICAgICAgLy8gQ2FsbCB3aXRoIG5vIG9wdGlvbnMgXHUyMDE0IHVzZXMgZGVmYXVsdHMgKDMgYXR0ZW1wdHMsIDIwMG1zKVxuICAgICAgY29uc3QgcmVzdWx0ID0gcmVhZEV4aXN0aW5nTG9ja0RhdGFXaXRoUmV0cnkobG9ja0ZpbGUpO1xuICAgICAgYXNzZXJ0VHJ1ZShyZXN1bHQgIT09IG51bGwsICdkZWZhdWx0IHBhcmFtcyB3b3JrIGZvciByZWFkYWJsZSBmaWxlJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9XG5cbiAgcmVwb3J0KCk7XG59XG5cbm1haW4oKS5jYXRjaCgoZXJyb3IpID0+IHtcbiAgY29uc29sZS5lcnJvcihlcnJvcik7XG4gIHByb2Nlc3MuZXhpdCgxKTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBZUEsU0FBUyxhQUFhLFdBQVcsZUFBZSxRQUFvQixZQUF3QixpQkFBaUI7QUFDN0csU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUN2QixTQUFtQixhQUFhO0FBRWhDO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BRUs7QUFDUCxTQUFTLGVBQWU7QUFDeEIsU0FBUyx5QkFBeUI7QUFFbEMsTUFBTSxFQUFFLFVBQVUsWUFBWSxPQUFPLElBQUksa0JBQWtCO0FBRTNELGVBQWUsT0FBc0I7QUFHbkMsVUFBUSxJQUFJLGdFQUFnRTtBQUM1RTtBQUNFLFVB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
