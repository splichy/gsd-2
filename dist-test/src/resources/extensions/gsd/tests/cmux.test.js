import test, { describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  buildCmuxProgress,
  buildCmuxStatusLabel,
  CmuxClient,
  detectCmuxEnvironment,
  markCmuxPromptShown,
  resetCmuxPromptState,
  resolveCmuxConfig,
  shouldPromptToEnableCmux
} from "../../cmux/index.js";
import { autoEnableCmuxPreferences } from "../commands-cmux.js";
test("detectCmuxEnvironment requires workspace, surface, and socket", () => {
  const detected = detectCmuxEnvironment(
    {
      CMUX_WORKSPACE_ID: "workspace:1",
      CMUX_SURFACE_ID: "surface:2",
      CMUX_SOCKET_PATH: "/tmp/cmux.sock"
    },
    (path2) => path2 === "/tmp/cmux.sock",
    () => true
  );
  assert.equal(detected.available, true);
  assert.equal(detected.cliAvailable, true);
});
test("resolveCmuxConfig enables only when preference and environment are both active", () => {
  const config = resolveCmuxConfig(
    { cmux: { enabled: true, notifications: true, sidebar: true, splits: true } },
    {
      CMUX_WORKSPACE_ID: "workspace:1",
      CMUX_SURFACE_ID: "surface:2",
      CMUX_SOCKET_PATH: "/tmp/cmux.sock"
    },
    () => true,
    () => true
  );
  assert.equal(config.enabled, true);
  assert.equal(config.notifications, true);
  assert.equal(config.sidebar, true);
  assert.equal(config.splits, true);
});
test("shouldPromptToEnableCmux only prompts once per session", () => {
  resetCmuxPromptState();
  assert.equal(shouldPromptToEnableCmux({}, {}, () => false, () => true), false);
  assert.equal(
    shouldPromptToEnableCmux(
      {},
      {
        CMUX_WORKSPACE_ID: "workspace:1",
        CMUX_SURFACE_ID: "surface:2",
        CMUX_SOCKET_PATH: "/tmp/cmux.sock"
      },
      () => true,
      () => true
    ),
    true
  );
  markCmuxPromptShown();
  assert.equal(
    shouldPromptToEnableCmux(
      {},
      {
        CMUX_WORKSPACE_ID: "workspace:1",
        CMUX_SURFACE_ID: "surface:2",
        CMUX_SOCKET_PATH: "/tmp/cmux.sock"
      },
      () => true,
      () => true
    ),
    false
  );
  resetCmuxPromptState();
});
describe("autoEnableCmuxPreferences", () => {
  let tmp;
  let originalCwd;
  beforeEach(() => {
    originalCwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(tmpdir(), "cmux-auto-test-"));
    fs.mkdirSync(path.join(tmp, ".gsd"), { recursive: true });
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  test("writes cmux.enabled true when preferences file exists with no cmux config", () => {
    const prefsPath = path.join(tmp, ".gsd", "preferences.md");
    fs.writeFileSync(prefsPath, [
      "---",
      "version: 1",
      "---",
      "",
      "# GSD Skill Preferences"
    ].join("\n"));
    const result = autoEnableCmuxPreferences();
    assert.equal(result, true);
    const content = fs.readFileSync(prefsPath, "utf-8");
    assert.ok(content.includes("enabled: true"), "should write enabled: true");
    assert.ok(content.includes("notifications: true"), "should default notifications on");
    assert.ok(content.includes("sidebar: true"), "should default sidebar on");
    assert.ok(content.includes("splits: false"), "should default splits off");
  });
  test("returns false when preferences file does not exist", () => {
    const result = autoEnableCmuxPreferences();
    assert.equal(result, false);
  });
  test("preserves existing cmux sub-preferences when auto-enabling", () => {
    const prefsPath = path.join(tmp, ".gsd", "preferences.md");
    fs.writeFileSync(prefsPath, [
      "---",
      "version: 1",
      "cmux:",
      "  splits: true",
      "  browser: true",
      "---",
      "",
      "# GSD Skill Preferences"
    ].join("\n"));
    const result = autoEnableCmuxPreferences();
    assert.equal(result, true);
    const content = fs.readFileSync(prefsPath, "utf-8");
    assert.ok(content.includes("enabled: true"), "should set enabled: true");
    assert.ok(content.includes("splits: true"), "should preserve existing splits: true");
    assert.ok(content.includes("browser: true"), "should preserve existing browser: true");
  });
});
test("buildCmuxStatusLabel and progress prefer deepest active unit", () => {
  const state = {
    activeMilestone: { id: "M001" },
    activeSlice: { id: "S02" },
    activeTask: { id: "T03" },
    phase: "executing",
    progress: {
      milestones: { done: 0, total: 1 },
      slices: { done: 1, total: 3 },
      tasks: { done: 2, total: 5 }
    }
  };
  assert.equal(buildCmuxStatusLabel(state), "M001 S02/T03 \xB7 executing");
  assert.deepEqual(buildCmuxProgress(state), { value: 0.4, label: "2/5 tasks" });
});
describe("createGridLayout", () => {
  function makeMockClient() {
    let nextId = 1;
    const calls = [];
    const client = {
      calls,
      async createGridLayout(count) {
        if (count <= 0) return [];
        const surfaces = [];
        const createSplitFrom = async (source, direction) => {
          calls.push({ source, direction });
          return `surface-${nextId++}`;
        };
        const rightCol = await createSplitFrom("gsd-surface", "right");
        surfaces.push(rightCol);
        if (count === 1) return surfaces;
        const bottomRight = await createSplitFrom(rightCol, "down");
        surfaces.push(bottomRight);
        if (count === 2) return surfaces;
        const bottomLeft = await createSplitFrom("gsd-surface", "down");
        surfaces.push(bottomLeft);
        if (count === 3) return surfaces;
        let lastSurface = bottomRight;
        for (let i = 3; i < count; i++) {
          const next = await createSplitFrom(lastSurface, "down");
          surfaces.push(next);
          lastSurface = next;
        }
        return surfaces;
      }
    };
    return client;
  }
  test("1 agent creates single right split", async () => {
    const mock = makeMockClient();
    const surfaces = await mock.createGridLayout(1);
    assert.equal(surfaces.length, 1);
    assert.deepEqual(mock.calls, [
      { source: "gsd-surface", direction: "right" }
    ]);
  });
  test("2 agents creates right column then splits it down", async () => {
    const mock = makeMockClient();
    const surfaces = await mock.createGridLayout(2);
    assert.equal(surfaces.length, 2);
    assert.deepEqual(mock.calls, [
      { source: "gsd-surface", direction: "right" },
      { source: "surface-1", direction: "down" }
    ]);
  });
  test("3 agents creates 2x2 grid (gsd + 3 agent surfaces)", async () => {
    const mock = makeMockClient();
    const surfaces = await mock.createGridLayout(3);
    assert.equal(surfaces.length, 3);
    assert.deepEqual(mock.calls, [
      { source: "gsd-surface", direction: "right" },
      { source: "surface-1", direction: "down" },
      { source: "gsd-surface", direction: "down" }
    ]);
  });
  test("4 agents creates 2x2 grid with extra split", async () => {
    const mock = makeMockClient();
    const surfaces = await mock.createGridLayout(4);
    assert.equal(surfaces.length, 4);
    assert.deepEqual(mock.calls, [
      { source: "gsd-surface", direction: "right" },
      { source: "surface-1", direction: "down" },
      { source: "gsd-surface", direction: "down" },
      { source: "surface-2", direction: "down" }
    ]);
  });
  test("0 agents returns empty", async () => {
    const mock = makeMockClient();
    const surfaces = await mock.createGridLayout(0);
    assert.equal(surfaces.length, 0);
    assert.equal(mock.calls.length, 0);
  });
});
describe("CmuxClient stdio isolation", () => {
  test("runSync and runAsync execute the cmux CLI without inheriting test stdin", async () => {
    const binDir = fs.mkdtempSync(path.join(tmpdir(), "cmux-bin-"));
    const logPath = path.join(binDir, "calls.jsonl");
    const cmuxPath = path.join(binDir, "cmux");
    const originalPath = process.env.PATH;
    fs.writeFileSync(
      cmuxPath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        `fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
        "if (process.argv.includes('--json')) process.stdout.write(JSON.stringify({surfaces:[{id:'surface-1'}]}));",
        "else process.stdout.write('ok');"
      ].join("\n"),
      "utf-8"
    );
    fs.chmodSync(cmuxPath, 493);
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    try {
      const client = new CmuxClient({
        enabled: true,
        available: true,
        cliAvailable: true,
        notifications: true,
        sidebar: true,
        splits: true,
        browser: false,
        workspaceId: "workspace-1",
        surfaceId: "surface-0",
        socketPath: "/tmp/cmux.sock"
      });
      client.setStatus("M001", "executing");
      await client.listSurfaceIds();
      const calls = fs.readFileSync(logPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
      const commandPrefixes = calls.map((call) => call.slice(0, 2));
      assert.ok(
        commandPrefixes.some((prefix) => JSON.stringify(prefix) === JSON.stringify(["set-status", "gsd"])),
        "set-status command should be invoked"
      );
      assert.ok(
        commandPrefixes.some((prefix) => JSON.stringify(prefix) === JSON.stringify(["list-surfaces", "--json"])),
        "list-surfaces command should be invoked"
      );
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });
});
describe("cmux extension discovery opt-out", () => {
  test("cmux directory has package.json with pi manifest to prevent auto-discovery as extension", () => {
    const cmuxDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../cmux"
    );
    const pkgPath = path.join(cmuxDir, "package.json");
    assert.ok(fs.existsSync(pkgPath), `${pkgPath} must exist`);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    assert.ok(
      pkg.pi !== void 0 && typeof pkg.pi === "object",
      'package.json must have a "pi" field to opt out of extension auto-discovery'
    );
    assert.ok(
      !pkg.pi.extensions?.length,
      "pi.extensions must be empty or absent \u2014 cmux is a library, not an extension"
    );
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9jbXV4LnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFByb2plY3QvQXBwOiBHU0QtMlxuLy8gRmlsZSBQdXJwb3NlOiBVbml0IHRlc3RzIGZvciBjbXV4IGludGVncmF0aW9uLCBsYXlvdXQsIGFuZCBDTEkgaXNvbGF0aW9uLlxuaW1wb3J0IHRlc3QsIHsgZGVzY3JpYmUsIGJlZm9yZUVhY2gsIGFmdGVyRWFjaCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0ICogYXMgZnMgZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCAqIGFzIHBhdGggZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tIFwibm9kZTp1cmxcIjtcbmltcG9ydCB7XG4gIGJ1aWxkQ211eFByb2dyZXNzLFxuICBidWlsZENtdXhTdGF0dXNMYWJlbCxcbiAgQ211eENsaWVudCxcbiAgZGV0ZWN0Q211eEVudmlyb25tZW50LFxuICBtYXJrQ211eFByb21wdFNob3duLFxuICByZXNldENtdXhQcm9tcHRTdGF0ZSxcbiAgcmVzb2x2ZUNtdXhDb25maWcsXG4gIHNob3VsZFByb21wdFRvRW5hYmxlQ211eCxcbn0gZnJvbSBcIi4uLy4uL2NtdXgvaW5kZXgudHNcIjtcbmltcG9ydCB7IGF1dG9FbmFibGVDbXV4UHJlZmVyZW5jZXMgfSBmcm9tIFwiLi4vY29tbWFuZHMtY211eC50c1wiO1xuaW1wb3J0IHR5cGUgeyBDbXV4U3RhdGVJbnB1dCB9IGZyb20gXCIuLi8uLi9zaGFyZWQvY211eC1ldmVudHMudHNcIjtcblxudGVzdChcImRldGVjdENtdXhFbnZpcm9ubWVudCByZXF1aXJlcyB3b3Jrc3BhY2UsIHN1cmZhY2UsIGFuZCBzb2NrZXRcIiwgKCkgPT4ge1xuICBjb25zdCBkZXRlY3RlZCA9IGRldGVjdENtdXhFbnZpcm9ubWVudChcbiAgICB7XG4gICAgICBDTVVYX1dPUktTUEFDRV9JRDogXCJ3b3Jrc3BhY2U6MVwiLFxuICAgICAgQ01VWF9TVVJGQUNFX0lEOiBcInN1cmZhY2U6MlwiLFxuICAgICAgQ01VWF9TT0NLRVRfUEFUSDogXCIvdG1wL2NtdXguc29ja1wiLFxuICAgIH0sXG4gICAgKHBhdGgpID0+IHBhdGggPT09IFwiL3RtcC9jbXV4LnNvY2tcIixcbiAgICAoKSA9PiB0cnVlLFxuICApO1xuICBhc3NlcnQuZXF1YWwoZGV0ZWN0ZWQuYXZhaWxhYmxlLCB0cnVlKTtcbiAgYXNzZXJ0LmVxdWFsKGRldGVjdGVkLmNsaUF2YWlsYWJsZSwgdHJ1ZSk7XG59KTtcblxudGVzdChcInJlc29sdmVDbXV4Q29uZmlnIGVuYWJsZXMgb25seSB3aGVuIHByZWZlcmVuY2UgYW5kIGVudmlyb25tZW50IGFyZSBib3RoIGFjdGl2ZVwiLCAoKSA9PiB7XG4gIGNvbnN0IGNvbmZpZyA9IHJlc29sdmVDbXV4Q29uZmlnKFxuICAgIHsgY211eDogeyBlbmFibGVkOiB0cnVlLCBub3RpZmljYXRpb25zOiB0cnVlLCBzaWRlYmFyOiB0cnVlLCBzcGxpdHM6IHRydWUgfSB9LFxuICAgIHtcbiAgICAgIENNVVhfV09SS1NQQUNFX0lEOiBcIndvcmtzcGFjZToxXCIsXG4gICAgICBDTVVYX1NVUkZBQ0VfSUQ6IFwic3VyZmFjZToyXCIsXG4gICAgICBDTVVYX1NPQ0tFVF9QQVRIOiBcIi90bXAvY211eC5zb2NrXCIsXG4gICAgfSxcbiAgICAoKSA9PiB0cnVlLFxuICAgICgpID0+IHRydWUsXG4gICk7XG4gIGFzc2VydC5lcXVhbChjb25maWcuZW5hYmxlZCwgdHJ1ZSk7XG4gIGFzc2VydC5lcXVhbChjb25maWcubm90aWZpY2F0aW9ucywgdHJ1ZSk7XG4gIGFzc2VydC5lcXVhbChjb25maWcuc2lkZWJhciwgdHJ1ZSk7XG4gIGFzc2VydC5lcXVhbChjb25maWcuc3BsaXRzLCB0cnVlKTtcbn0pO1xuXG50ZXN0KFwic2hvdWxkUHJvbXB0VG9FbmFibGVDbXV4IG9ubHkgcHJvbXB0cyBvbmNlIHBlciBzZXNzaW9uXCIsICgpID0+IHtcbiAgcmVzZXRDbXV4UHJvbXB0U3RhdGUoKTtcbiAgYXNzZXJ0LmVxdWFsKHNob3VsZFByb21wdFRvRW5hYmxlQ211eCh7fSwge30sICgpID0+IGZhbHNlLCAoKSA9PiB0cnVlKSwgZmFsc2UpO1xuXG4gIGFzc2VydC5lcXVhbChcbiAgICBzaG91bGRQcm9tcHRUb0VuYWJsZUNtdXgoXG4gICAgICB7fSxcbiAgICAgIHtcbiAgICAgICAgQ01VWF9XT1JLU1BBQ0VfSUQ6IFwid29ya3NwYWNlOjFcIixcbiAgICAgICAgQ01VWF9TVVJGQUNFX0lEOiBcInN1cmZhY2U6MlwiLFxuICAgICAgICBDTVVYX1NPQ0tFVF9QQVRIOiBcIi90bXAvY211eC5zb2NrXCIsXG4gICAgICB9LFxuICAgICAgKCkgPT4gdHJ1ZSxcbiAgICAgICgpID0+IHRydWUsXG4gICAgKSxcbiAgICB0cnVlLFxuICApO1xuICBtYXJrQ211eFByb21wdFNob3duKCk7XG4gIGFzc2VydC5lcXVhbChcbiAgICBzaG91bGRQcm9tcHRUb0VuYWJsZUNtdXgoXG4gICAgICB7fSxcbiAgICAgIHtcbiAgICAgICAgQ01VWF9XT1JLU1BBQ0VfSUQ6IFwid29ya3NwYWNlOjFcIixcbiAgICAgICAgQ01VWF9TVVJGQUNFX0lEOiBcInN1cmZhY2U6MlwiLFxuICAgICAgICBDTVVYX1NPQ0tFVF9QQVRIOiBcIi90bXAvY211eC5zb2NrXCIsXG4gICAgICB9LFxuICAgICAgKCkgPT4gdHJ1ZSxcbiAgICAgICgpID0+IHRydWUsXG4gICAgKSxcbiAgICBmYWxzZSxcbiAgKTtcbiAgcmVzZXRDbXV4UHJvbXB0U3RhdGUoKTtcbn0pO1xuXG5kZXNjcmliZShcImF1dG9FbmFibGVDbXV4UHJlZmVyZW5jZXNcIiwgKCkgPT4ge1xuICBsZXQgdG1wOiBzdHJpbmc7XG4gIGxldCBvcmlnaW5hbEN3ZDogc3RyaW5nO1xuXG4gIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgIG9yaWdpbmFsQ3dkID0gcHJvY2Vzcy5jd2QoKTtcbiAgICB0bXAgPSBmcy5ta2R0ZW1wU3luYyhwYXRoLmpvaW4odG1wZGlyKCksIFwiY211eC1hdXRvLXRlc3QtXCIpKTtcbiAgICBmcy5ta2RpclN5bmMocGF0aC5qb2luKHRtcCwgXCIuZ3NkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBwcm9jZXNzLmNoZGlyKHRtcCk7XG4gIH0pO1xuXG4gIGFmdGVyRWFjaCgoKSA9PiB7XG4gICAgcHJvY2Vzcy5jaGRpcihvcmlnaW5hbEN3ZCk7XG4gICAgZnMucm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcblxuICB0ZXN0KFwid3JpdGVzIGNtdXguZW5hYmxlZCB0cnVlIHdoZW4gcHJlZmVyZW5jZXMgZmlsZSBleGlzdHMgd2l0aCBubyBjbXV4IGNvbmZpZ1wiLCAoKSA9PiB7XG4gICAgY29uc3QgcHJlZnNQYXRoID0gcGF0aC5qb2luKHRtcCwgXCIuZ3NkXCIsIFwicHJlZmVyZW5jZXMubWRcIik7XG4gICAgZnMud3JpdGVGaWxlU3luYyhwcmVmc1BhdGgsIFtcbiAgICAgIFwiLS0tXCIsXG4gICAgICBcInZlcnNpb246IDFcIixcbiAgICAgIFwiLS0tXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIEdTRCBTa2lsbCBQcmVmZXJlbmNlc1wiLFxuICAgIF0uam9pbihcIlxcblwiKSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhdXRvRW5hYmxlQ211eFByZWZlcmVuY2VzKCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgdHJ1ZSk7XG5cbiAgICBjb25zdCBjb250ZW50ID0gZnMucmVhZEZpbGVTeW5jKHByZWZzUGF0aCwgXCJ1dGYtOFwiKTtcbiAgICBhc3NlcnQub2soY29udGVudC5pbmNsdWRlcyhcImVuYWJsZWQ6IHRydWVcIiksIFwic2hvdWxkIHdyaXRlIGVuYWJsZWQ6IHRydWVcIik7XG4gICAgYXNzZXJ0Lm9rKGNvbnRlbnQuaW5jbHVkZXMoXCJub3RpZmljYXRpb25zOiB0cnVlXCIpLCBcInNob3VsZCBkZWZhdWx0IG5vdGlmaWNhdGlvbnMgb25cIik7XG4gICAgYXNzZXJ0Lm9rKGNvbnRlbnQuaW5jbHVkZXMoXCJzaWRlYmFyOiB0cnVlXCIpLCBcInNob3VsZCBkZWZhdWx0IHNpZGViYXIgb25cIik7XG4gICAgYXNzZXJ0Lm9rKGNvbnRlbnQuaW5jbHVkZXMoXCJzcGxpdHM6IGZhbHNlXCIpLCBcInNob3VsZCBkZWZhdWx0IHNwbGl0cyBvZmZcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJyZXR1cm5zIGZhbHNlIHdoZW4gcHJlZmVyZW5jZXMgZmlsZSBkb2VzIG5vdCBleGlzdFwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXV0b0VuYWJsZUNtdXhQcmVmZXJlbmNlcygpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIGZhbHNlKTtcbiAgfSk7XG5cbiAgdGVzdChcInByZXNlcnZlcyBleGlzdGluZyBjbXV4IHN1Yi1wcmVmZXJlbmNlcyB3aGVuIGF1dG8tZW5hYmxpbmdcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHByZWZzUGF0aCA9IHBhdGguam9pbih0bXAsIFwiLmdzZFwiLCBcInByZWZlcmVuY2VzLm1kXCIpO1xuICAgIGZzLndyaXRlRmlsZVN5bmMocHJlZnNQYXRoLCBbXG4gICAgICBcIi0tLVwiLFxuICAgICAgXCJ2ZXJzaW9uOiAxXCIsXG4gICAgICBcImNtdXg6XCIsXG4gICAgICBcIiAgc3BsaXRzOiB0cnVlXCIsXG4gICAgICBcIiAgYnJvd3NlcjogdHJ1ZVwiLFxuICAgICAgXCItLS1cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMgR1NEIFNraWxsIFByZWZlcmVuY2VzXCIsXG4gICAgXS5qb2luKFwiXFxuXCIpKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF1dG9FbmFibGVDbXV4UHJlZmVyZW5jZXMoKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCB0cnVlKTtcblxuICAgIGNvbnN0IGNvbnRlbnQgPSBmcy5yZWFkRmlsZVN5bmMocHJlZnNQYXRoLCBcInV0Zi04XCIpO1xuICAgIGFzc2VydC5vayhjb250ZW50LmluY2x1ZGVzKFwiZW5hYmxlZDogdHJ1ZVwiKSwgXCJzaG91bGQgc2V0IGVuYWJsZWQ6IHRydWVcIik7XG4gICAgYXNzZXJ0Lm9rKGNvbnRlbnQuaW5jbHVkZXMoXCJzcGxpdHM6IHRydWVcIiksIFwic2hvdWxkIHByZXNlcnZlIGV4aXN0aW5nIHNwbGl0czogdHJ1ZVwiKTtcbiAgICBhc3NlcnQub2soY29udGVudC5pbmNsdWRlcyhcImJyb3dzZXI6IHRydWVcIiksIFwic2hvdWxkIHByZXNlcnZlIGV4aXN0aW5nIGJyb3dzZXI6IHRydWVcIik7XG4gIH0pO1xufSk7XG5cbnRlc3QoXCJidWlsZENtdXhTdGF0dXNMYWJlbCBhbmQgcHJvZ3Jlc3MgcHJlZmVyIGRlZXBlc3QgYWN0aXZlIHVuaXRcIiwgKCkgPT4ge1xuICBjb25zdCBzdGF0ZTogQ211eFN0YXRlSW5wdXQgPSB7XG4gICAgYWN0aXZlTWlsZXN0b25lOiB7IGlkOiBcIk0wMDFcIiB9LFxuICAgIGFjdGl2ZVNsaWNlOiB7IGlkOiBcIlMwMlwiIH0sXG4gICAgYWN0aXZlVGFzazogeyBpZDogXCJUMDNcIiB9LFxuICAgIHBoYXNlOiBcImV4ZWN1dGluZ1wiLFxuICAgIHByb2dyZXNzOiB7XG4gICAgICBtaWxlc3RvbmVzOiB7IGRvbmU6IDAsIHRvdGFsOiAxIH0sXG4gICAgICBzbGljZXM6IHsgZG9uZTogMSwgdG90YWw6IDMgfSxcbiAgICAgIHRhc2tzOiB7IGRvbmU6IDIsIHRvdGFsOiA1IH0sXG4gICAgfSxcbiAgfTtcblxuICBhc3NlcnQuZXF1YWwoYnVpbGRDbXV4U3RhdHVzTGFiZWwoc3RhdGUpLCBcIk0wMDEgUzAyL1QwMyBcdTAwQjcgZXhlY3V0aW5nXCIpO1xuICBhc3NlcnQuZGVlcEVxdWFsKGJ1aWxkQ211eFByb2dyZXNzKHN0YXRlKSwgeyB2YWx1ZTogMC40LCBsYWJlbDogXCIyLzUgdGFza3NcIiB9KTtcbn0pO1xuXG5kZXNjcmliZShcImNyZWF0ZUdyaWRMYXlvdXRcIiwgKCkgPT4ge1xuICAvLyBDcmVhdGUgYSBtb2NrIENtdXhDbGllbnQgdGhhdCB0cmFja3MgY3JlYXRlU3BsaXRGcm9tIGNhbGxzXG4gIGZ1bmN0aW9uIG1ha2VNb2NrQ2xpZW50KCkge1xuICAgIGxldCBuZXh0SWQgPSAxO1xuICAgIGNvbnN0IGNhbGxzOiBBcnJheTx7IHNvdXJjZTogc3RyaW5nIHwgdW5kZWZpbmVkOyBkaXJlY3Rpb246IHN0cmluZyB9PiA9IFtdO1xuXG4gICAgY29uc3QgY2xpZW50ID0ge1xuICAgICAgY2FsbHMsXG4gICAgICBhc3luYyBjcmVhdGVHcmlkTGF5b3V0KGNvdW50OiBudW1iZXIpIHtcbiAgICAgICAgLy8gU2ltdWxhdGUgdGhlIGdyaWQgbGF5b3V0IGxvZ2ljIHdpdGggYSBmYWtlIGNsaWVudFxuICAgICAgICBpZiAoY291bnQgPD0gMCkgcmV0dXJuIFtdO1xuICAgICAgICBjb25zdCBzdXJmYWNlczogc3RyaW5nW10gPSBbXTtcblxuICAgICAgICBjb25zdCBjcmVhdGVTcGxpdEZyb20gPSBhc3luYyAoc291cmNlOiBzdHJpbmcgfCB1bmRlZmluZWQsIGRpcmVjdGlvbjogc3RyaW5nKSA9PiB7XG4gICAgICAgICAgY2FsbHMucHVzaCh7IHNvdXJjZSwgZGlyZWN0aW9uIH0pO1xuICAgICAgICAgIHJldHVybiBgc3VyZmFjZS0ke25leHRJZCsrfWA7XG4gICAgICAgIH07XG5cbiAgICAgICAgY29uc3QgcmlnaHRDb2wgPSBhd2FpdCBjcmVhdGVTcGxpdEZyb20oXCJnc2Qtc3VyZmFjZVwiLCBcInJpZ2h0XCIpO1xuICAgICAgICBzdXJmYWNlcy5wdXNoKHJpZ2h0Q29sKTtcbiAgICAgICAgaWYgKGNvdW50ID09PSAxKSByZXR1cm4gc3VyZmFjZXM7XG5cbiAgICAgICAgY29uc3QgYm90dG9tUmlnaHQgPSBhd2FpdCBjcmVhdGVTcGxpdEZyb20ocmlnaHRDb2wsIFwiZG93blwiKTtcbiAgICAgICAgc3VyZmFjZXMucHVzaChib3R0b21SaWdodCk7XG4gICAgICAgIGlmIChjb3VudCA9PT0gMikgcmV0dXJuIHN1cmZhY2VzO1xuXG4gICAgICAgIGNvbnN0IGJvdHRvbUxlZnQgPSBhd2FpdCBjcmVhdGVTcGxpdEZyb20oXCJnc2Qtc3VyZmFjZVwiLCBcImRvd25cIik7XG4gICAgICAgIHN1cmZhY2VzLnB1c2goYm90dG9tTGVmdCk7XG4gICAgICAgIGlmIChjb3VudCA9PT0gMykgcmV0dXJuIHN1cmZhY2VzO1xuXG4gICAgICAgIGxldCBsYXN0U3VyZmFjZSA9IGJvdHRvbVJpZ2h0O1xuICAgICAgICBmb3IgKGxldCBpID0gMzsgaSA8IGNvdW50OyBpKyspIHtcbiAgICAgICAgICBjb25zdCBuZXh0ID0gYXdhaXQgY3JlYXRlU3BsaXRGcm9tKGxhc3RTdXJmYWNlLCBcImRvd25cIik7XG4gICAgICAgICAgc3VyZmFjZXMucHVzaChuZXh0KTtcbiAgICAgICAgICBsYXN0U3VyZmFjZSA9IG5leHQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gc3VyZmFjZXM7XG4gICAgICB9LFxuICAgIH07XG4gICAgcmV0dXJuIGNsaWVudDtcbiAgfVxuXG4gIHRlc3QoXCIxIGFnZW50IGNyZWF0ZXMgc2luZ2xlIHJpZ2h0IHNwbGl0XCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBtb2NrID0gbWFrZU1vY2tDbGllbnQoKTtcbiAgICBjb25zdCBzdXJmYWNlcyA9IGF3YWl0IG1vY2suY3JlYXRlR3JpZExheW91dCgxKTtcbiAgICBhc3NlcnQuZXF1YWwoc3VyZmFjZXMubGVuZ3RoLCAxKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKG1vY2suY2FsbHMsIFtcbiAgICAgIHsgc291cmNlOiBcImdzZC1zdXJmYWNlXCIsIGRpcmVjdGlvbjogXCJyaWdodFwiIH0sXG4gICAgXSk7XG4gIH0pO1xuXG4gIHRlc3QoXCIyIGFnZW50cyBjcmVhdGVzIHJpZ2h0IGNvbHVtbiB0aGVuIHNwbGl0cyBpdCBkb3duXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBtb2NrID0gbWFrZU1vY2tDbGllbnQoKTtcbiAgICBjb25zdCBzdXJmYWNlcyA9IGF3YWl0IG1vY2suY3JlYXRlR3JpZExheW91dCgyKTtcbiAgICBhc3NlcnQuZXF1YWwoc3VyZmFjZXMubGVuZ3RoLCAyKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKG1vY2suY2FsbHMsIFtcbiAgICAgIHsgc291cmNlOiBcImdzZC1zdXJmYWNlXCIsIGRpcmVjdGlvbjogXCJyaWdodFwiIH0sXG4gICAgICB7IHNvdXJjZTogXCJzdXJmYWNlLTFcIiwgZGlyZWN0aW9uOiBcImRvd25cIiB9LFxuICAgIF0pO1xuICB9KTtcblxuICB0ZXN0KFwiMyBhZ2VudHMgY3JlYXRlcyAyeDIgZ3JpZCAoZ3NkICsgMyBhZ2VudCBzdXJmYWNlcylcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IG1vY2sgPSBtYWtlTW9ja0NsaWVudCgpO1xuICAgIGNvbnN0IHN1cmZhY2VzID0gYXdhaXQgbW9jay5jcmVhdGVHcmlkTGF5b3V0KDMpO1xuICAgIGFzc2VydC5lcXVhbChzdXJmYWNlcy5sZW5ndGgsIDMpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwobW9jay5jYWxscywgW1xuICAgICAgeyBzb3VyY2U6IFwiZ3NkLXN1cmZhY2VcIiwgZGlyZWN0aW9uOiBcInJpZ2h0XCIgfSxcbiAgICAgIHsgc291cmNlOiBcInN1cmZhY2UtMVwiLCBkaXJlY3Rpb246IFwiZG93blwiIH0sXG4gICAgICB7IHNvdXJjZTogXCJnc2Qtc3VyZmFjZVwiLCBkaXJlY3Rpb246IFwiZG93blwiIH0sXG4gICAgXSk7XG4gIH0pO1xuXG4gIHRlc3QoXCI0IGFnZW50cyBjcmVhdGVzIDJ4MiBncmlkIHdpdGggZXh0cmEgc3BsaXRcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IG1vY2sgPSBtYWtlTW9ja0NsaWVudCgpO1xuICAgIGNvbnN0IHN1cmZhY2VzID0gYXdhaXQgbW9jay5jcmVhdGVHcmlkTGF5b3V0KDQpO1xuICAgIGFzc2VydC5lcXVhbChzdXJmYWNlcy5sZW5ndGgsIDQpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwobW9jay5jYWxscywgW1xuICAgICAgeyBzb3VyY2U6IFwiZ3NkLXN1cmZhY2VcIiwgZGlyZWN0aW9uOiBcInJpZ2h0XCIgfSxcbiAgICAgIHsgc291cmNlOiBcInN1cmZhY2UtMVwiLCBkaXJlY3Rpb246IFwiZG93blwiIH0sXG4gICAgICB7IHNvdXJjZTogXCJnc2Qtc3VyZmFjZVwiLCBkaXJlY3Rpb246IFwiZG93blwiIH0sXG4gICAgICB7IHNvdXJjZTogXCJzdXJmYWNlLTJcIiwgZGlyZWN0aW9uOiBcImRvd25cIiB9LFxuICAgIF0pO1xuICB9KTtcblxuICB0ZXN0KFwiMCBhZ2VudHMgcmV0dXJucyBlbXB0eVwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgbW9jayA9IG1ha2VNb2NrQ2xpZW50KCk7XG4gICAgY29uc3Qgc3VyZmFjZXMgPSBhd2FpdCBtb2NrLmNyZWF0ZUdyaWRMYXlvdXQoMCk7XG4gICAgYXNzZXJ0LmVxdWFsKHN1cmZhY2VzLmxlbmd0aCwgMCk7XG4gICAgYXNzZXJ0LmVxdWFsKG1vY2suY2FsbHMubGVuZ3RoLCAwKTtcbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoXCJDbXV4Q2xpZW50IHN0ZGlvIGlzb2xhdGlvblwiLCAoKSA9PiB7XG4gIHRlc3QoXCJydW5TeW5jIGFuZCBydW5Bc3luYyBleGVjdXRlIHRoZSBjbXV4IENMSSB3aXRob3V0IGluaGVyaXRpbmcgdGVzdCBzdGRpblwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmluRGlyID0gZnMubWtkdGVtcFN5bmMocGF0aC5qb2luKHRtcGRpcigpLCBcImNtdXgtYmluLVwiKSk7XG4gICAgY29uc3QgbG9nUGF0aCA9IHBhdGguam9pbihiaW5EaXIsIFwiY2FsbHMuanNvbmxcIik7XG4gICAgY29uc3QgY211eFBhdGggPSBwYXRoLmpvaW4oYmluRGlyLCBcImNtdXhcIik7XG4gICAgY29uc3Qgb3JpZ2luYWxQYXRoID0gcHJvY2Vzcy5lbnYuUEFUSDtcbiAgICBmcy53cml0ZUZpbGVTeW5jKFxuICAgICAgY211eFBhdGgsXG4gICAgICBbXG4gICAgICAgIFwiIyEvdXNyL2Jpbi9lbnYgbm9kZVwiLFxuICAgICAgICBcImNvbnN0IGZzID0gcmVxdWlyZSgnbm9kZTpmcycpO1wiLFxuICAgICAgICBgZnMuYXBwZW5kRmlsZVN5bmMoJHtKU09OLnN0cmluZ2lmeShsb2dQYXRoKX0sIEpTT04uc3RyaW5naWZ5KHByb2Nlc3MuYXJndi5zbGljZSgyKSkgKyAnXFxcXG4nKTtgLFxuICAgICAgICBcImlmIChwcm9jZXNzLmFyZ3YuaW5jbHVkZXMoJy0tanNvbicpKSBwcm9jZXNzLnN0ZG91dC53cml0ZShKU09OLnN0cmluZ2lmeSh7c3VyZmFjZXM6W3tpZDonc3VyZmFjZS0xJ31dfSkpO1wiLFxuICAgICAgICBcImVsc2UgcHJvY2Vzcy5zdGRvdXQud3JpdGUoJ29rJyk7XCIsXG4gICAgICBdLmpvaW4oXCJcXG5cIiksXG4gICAgICBcInV0Zi04XCIsXG4gICAgKTtcbiAgICBmcy5jaG1vZFN5bmMoY211eFBhdGgsIDBvNzU1KTtcbiAgICBwcm9jZXNzLmVudi5QQVRIID0gYCR7YmluRGlyfToke29yaWdpbmFsUGF0aCA/PyBcIlwifWA7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGNsaWVudCA9IG5ldyBDbXV4Q2xpZW50KHtcbiAgICAgICAgZW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgYXZhaWxhYmxlOiB0cnVlLFxuICAgICAgICBjbGlBdmFpbGFibGU6IHRydWUsXG4gICAgICAgIG5vdGlmaWNhdGlvbnM6IHRydWUsXG4gICAgICAgIHNpZGViYXI6IHRydWUsXG4gICAgICAgIHNwbGl0czogdHJ1ZSxcbiAgICAgICAgYnJvd3NlcjogZmFsc2UsXG4gICAgICAgIHdvcmtzcGFjZUlkOiBcIndvcmtzcGFjZS0xXCIsXG4gICAgICAgIHN1cmZhY2VJZDogXCJzdXJmYWNlLTBcIixcbiAgICAgICAgc29ja2V0UGF0aDogXCIvdG1wL2NtdXguc29ja1wiLFxuICAgICAgfSk7XG5cbiAgICAgIGNsaWVudC5zZXRTdGF0dXMoXCJNMDAxXCIsIFwiZXhlY3V0aW5nXCIpO1xuICAgICAgYXdhaXQgY2xpZW50Lmxpc3RTdXJmYWNlSWRzKCk7XG5cbiAgICAgIGNvbnN0IGNhbGxzID0gZnMucmVhZEZpbGVTeW5jKGxvZ1BhdGgsIFwidXRmLThcIikudHJpbSgpLnNwbGl0KFwiXFxuXCIpLm1hcCgobGluZSkgPT4gSlNPTi5wYXJzZShsaW5lKSk7XG4gICAgICBjb25zdCBjb21tYW5kUHJlZml4ZXMgPSBjYWxscy5tYXAoKGNhbGwpID0+IGNhbGwuc2xpY2UoMCwgMikpO1xuICAgICAgYXNzZXJ0Lm9rKFxuICAgICAgICBjb21tYW5kUHJlZml4ZXMuc29tZSgocHJlZml4KSA9PiBKU09OLnN0cmluZ2lmeShwcmVmaXgpID09PSBKU09OLnN0cmluZ2lmeShbXCJzZXQtc3RhdHVzXCIsIFwiZ3NkXCJdKSksXG4gICAgICAgIFwic2V0LXN0YXR1cyBjb21tYW5kIHNob3VsZCBiZSBpbnZva2VkXCIsXG4gICAgICApO1xuICAgICAgYXNzZXJ0Lm9rKFxuICAgICAgICBjb21tYW5kUHJlZml4ZXMuc29tZSgocHJlZml4KSA9PiBKU09OLnN0cmluZ2lmeShwcmVmaXgpID09PSBKU09OLnN0cmluZ2lmeShbXCJsaXN0LXN1cmZhY2VzXCIsIFwiLS1qc29uXCJdKSksXG4gICAgICAgIFwibGlzdC1zdXJmYWNlcyBjb21tYW5kIHNob3VsZCBiZSBpbnZva2VkXCIsXG4gICAgICApO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBwcm9jZXNzLmVudi5QQVRIID0gb3JpZ2luYWxQYXRoO1xuICAgICAgZnMucm1TeW5jKGJpbkRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoXCJjbXV4IGV4dGVuc2lvbiBkaXNjb3Zlcnkgb3B0LW91dFwiLCAoKSA9PiB7XG4gIHRlc3QoXCJjbXV4IGRpcmVjdG9yeSBoYXMgcGFja2FnZS5qc29uIHdpdGggcGkgbWFuaWZlc3QgdG8gcHJldmVudCBhdXRvLWRpc2NvdmVyeSBhcyBleHRlbnNpb25cIiwgKCkgPT4ge1xuICAgIGNvbnN0IGNtdXhEaXIgPSBwYXRoLnJlc29sdmUoXG4gICAgICBwYXRoLmRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKSxcbiAgICAgIFwiLi4vLi4vY211eFwiLFxuICAgICk7XG4gICAgY29uc3QgcGtnUGF0aCA9IHBhdGguam9pbihjbXV4RGlyLCBcInBhY2thZ2UuanNvblwiKTtcbiAgICBhc3NlcnQub2soZnMuZXhpc3RzU3luYyhwa2dQYXRoKSwgYCR7cGtnUGF0aH0gbXVzdCBleGlzdGApO1xuXG4gICAgY29uc3QgcGtnID0gSlNPTi5wYXJzZShmcy5yZWFkRmlsZVN5bmMocGtnUGF0aCwgXCJ1dGYtOFwiKSk7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgcGtnLnBpICE9PSB1bmRlZmluZWQgJiYgdHlwZW9mIHBrZy5waSA9PT0gXCJvYmplY3RcIixcbiAgICAgICdwYWNrYWdlLmpzb24gbXVzdCBoYXZlIGEgXCJwaVwiIGZpZWxkIHRvIG9wdCBvdXQgb2YgZXh0ZW5zaW9uIGF1dG8tZGlzY292ZXJ5JyxcbiAgICApO1xuICAgIGFzc2VydC5vayhcbiAgICAgICFwa2cucGkuZXh0ZW5zaW9ucz8ubGVuZ3RoLFxuICAgICAgXCJwaS5leHRlbnNpb25zIG11c3QgYmUgZW1wdHkgb3IgYWJzZW50IFx1MjAxNCBjbXV4IGlzIGEgbGlicmFyeSwgbm90IGFuIGV4dGVuc2lvblwiLFxuICAgICk7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFFQSxPQUFPLFFBQVEsVUFBVSxZQUFZLGlCQUFpQjtBQUN0RCxPQUFPLFlBQVk7QUFDbkIs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QVc7QUFBQSxRQUNYLGNBQWM7QUFBQSxRQUNkLGVBQWU7QUFBQSxRQUNmLFNBQVM7QUFBQSxRQUNULFFBQVE7QUFBQSxRQUNSLFNBQVM7QUFBQSxRQUNULGFBQWE7QUFBQSxRQUNiLFdBQVc7QUFBQSxRQUNYLFlBQVk7QUFBQSxNQUNkLENBQUM7QUFFRCxhQUFPLFVBQVUsUUFBUSxXQUFXO0FBQ3BDLFlBQU0sT0FBTyxlQUFlO0FBRTVCLFlBQU0sUUFBUSxHQUFHLGFBQWEsU0FBUyxPQUFPLEVBQUUsS0FBSyxFQUFFLE1BQU0sSUFBSSxFQUFFLElBQUksQ0FBQyxTQUFTLEtBQUssTUFBTSxJQUFJLENBQUM7QUFDakcsWUFBTSxrQkFBa0IsTUFBTSxJQUFJLENBQUMsU0FBUyxLQUFLLE1BQU0sR0FBRyxDQUFDLENBQUM7QUFDNUQsYUFBTztBQUFBLFFBQ0wsZ0JBQWdCLEtBQUssQ0FBQyxXQUFXLEtBQUssVUFBVSxNQUFNLE1BQU0sS0FBSyxVQUFVLENBQUMsY0FBYyxLQUFLLENBQUMsQ0FBQztBQUFBLFFBQ2pHO0FBQUEsTUFDRjtBQUNBLGFBQU87QUFBQSxRQUNMLGdCQUFnQixLQUFLLENBQUMsV0FBVyxLQUFLLFVBQVUsTUFBTSxNQUFNLEtBQUssVUFBVSxDQUFDLGlCQUFpQixRQUFRLENBQUMsQ0FBQztBQUFBLFFBQ3ZHO0FBQUEsTUFDRjtBQUFBLElBQ0YsVUFBRTtBQUNBLGNBQVEsSUFBSSxPQUFPO0FBQ25CLFNBQUcsT0FBTyxRQUFRLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDcEQ7QUFBQSxFQUNGLENBQUM7QUFDSCxDQUFDO0FBRUQsU0FBUyxvQ0FBb0MsTUFBTTtBQUNqRCxPQUFLLDJGQUEyRixNQUFNO0FBQ3BHLFVBQU0sVUFBVSxLQUFLO0FBQUEsTUFDbkIsS0FBSyxRQUFRLGNBQWMsWUFBWSxHQUFHLENBQUM7QUFBQSxNQUMzQztBQUFBLElBQ0Y7QUFDQSxVQUFNLFVBQVUsS0FBSyxLQUFLLFNBQVMsY0FBYztBQUNqRCxXQUFPLEdBQUcsR0FBRyxXQUFXLE9BQU8sR0FBRyxHQUFHLE9BQU8sYUFBYTtBQUV6RCxVQUFNLE1BQU0sS0FBSyxNQUFNLEdBQUcsYUFBYSxTQUFTLE9BQU8sQ0FBQztBQUN4RCxXQUFPO0FBQUEsTUFDTCxJQUFJLE9BQU8sVUFBYSxPQUFPLElBQUksT0FBTztBQUFBLE1BQzFDO0FBQUEsSUFDRjtBQUNBLFdBQU87QUFBQSxNQUNMLENBQUMsSUFBSSxHQUFHLFlBQVk7QUFBQSxNQUNwQjtBQUFBLElBQ0Y7QUFBQSxFQUNGLENBQUM7QUFDSCxDQUFDOyIsCiAgIm5hbWVzIjogWyJwYXRoIl0KfQo=
