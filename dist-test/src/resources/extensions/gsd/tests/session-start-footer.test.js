import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { autoSession } from "../auto-runtime-state.js";
import { registerHooks } from "../bootstrap/register-hooks.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS_SOURCE = readFileSync(
  join(__dirname, "..", "bootstrap", "register-hooks.ts"),
  "utf-8"
);
test("register-hooks.ts does NOT import hideFooter", () => {
  assert.ok(
    !HOOKS_SOURCE.includes("hideFooter"),
    "register-hooks.ts must not reference hideFooter \u2014 footer is no longer swapped in auto mode"
  );
});
test("session_start handler guards initHealthWidget with !isAutoActive()", () => {
  const sessionStartIdx = HOOKS_SOURCE.indexOf('"session_start"');
  assert.ok(sessionStartIdx > -1, "session_start handler must exist");
  const sessionSwitchIdx = HOOKS_SOURCE.indexOf('"session_switch"');
  assert.ok(sessionSwitchIdx > sessionStartIdx, "session_switch handler must follow session_start");
  const sessionStartBody = HOOKS_SOURCE.slice(sessionStartIdx, sessionSwitchIdx);
  assert.ok(
    sessionStartBody.includes("isAutoActive()"),
    "session_start handler must call isAutoActive()"
  );
  assert.ok(
    sessionStartBody.includes("initHealthWidget"),
    "session_start handler must reference initHealthWidget"
  );
  assert.ok(
    !sessionStartBody.includes("setFooter"),
    "session_start handler must NOT call setFooter"
  );
  const guardIdx = sessionStartBody.indexOf("isAutoActive()");
  const healthIdx = sessionStartBody.indexOf("initHealthWidget");
  assert.ok(
    guardIdx < healthIdx,
    "isAutoActive() guard must appear before initHealthWidget in session_start"
  );
});
test("session_switch toggles gsd-health from runtime auto state without touching the footer", async (t) => {
  const dir = join(
    tmpdir(),
    `gsd-session-switch-widget-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  const tempGsdHome = join(dir, "home");
  mkdirSync(tempGsdHome, { recursive: true });
  const originalCwd = process.cwd();
  const originalGsdHome = process.env.GSD_HOME;
  process.env.GSD_HOME = tempGsdHome;
  process.chdir(dir);
  autoSession.reset();
  t.after(() => {
    autoSession.reset();
    process.chdir(originalCwd);
    if (originalGsdHome === void 0) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
    }
  });
  const handlers = /* @__PURE__ */ new Map();
  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
    }
  };
  registerHooks(pi, []);
  const sessionSwitch = handlers.get("session_switch");
  assert.ok(sessionSwitch, "session_switch handler must be registered");
  let setFooterCallCount = 0;
  const widgetCalls = [];
  const ctx = {
    hasUI: true,
    ui: {
      notify: () => {
      },
      setStatus: () => {
      },
      setFooter: (_footer) => {
        setFooterCallCount++;
      },
      setWorkingMessage: () => {
      },
      onTerminalInput: () => () => {
      },
      setWidget: (key, value) => {
        widgetCalls.push({ key, value });
      }
    },
    sessionManager: { getSessionId: () => null },
    model: null,
    modelRegistry: {
      setDisabledModelProviders: () => {
      },
      getProviderAuthMode: () => void 0,
      isProviderRequestReady: () => false
    }
  };
  autoSession.active = true;
  await sessionSwitch({ reason: "resume" }, ctx);
  assert.deepEqual(
    widgetCalls.filter((call) => call.key === "gsd-health").map((call) => call.value),
    [void 0],
    "session_switch should hide gsd-health when auto is active"
  );
  assert.equal(setFooterCallCount, 0, "session_switch must not call setFooter when auto is active");
  widgetCalls.length = 0;
  autoSession.active = false;
  await sessionSwitch({ reason: "resume" }, ctx);
  assert.deepEqual(
    widgetCalls.filter((call) => call.key === "gsd-progress" || call.key === "gsd-outcome").map((call) => [call.key, call.value]),
    [
      ["gsd-progress", void 0],
      ["gsd-outcome", void 0]
    ],
    "session_switch should clear stale GSD completion widgets when auto is inactive"
  );
  const healthWidgetValues = widgetCalls.filter((call) => call.key === "gsd-health").map((call) => call.value);
  assert.ok(healthWidgetValues.length >= 2, "session_switch should initialize gsd-health when auto is inactive");
  assert.ok(
    healthWidgetValues.every((value) => value !== void 0),
    "session_switch must not hide gsd-health when auto is inactive"
  );
  assert.ok(Array.isArray(healthWidgetValues[0]), "initHealthWidget should publish initial health lines");
  assert.equal(typeof healthWidgetValues.at(-1), "function", "initHealthWidget should register the live widget factory");
  assert.equal(setFooterCallCount, 0, "session_switch must not call setFooter when auto is inactive");
});
test("session_start does NOT call setFooter or suppress gsd-health when isAutoActive() is false", async (t) => {
  const dir = join(
    tmpdir(),
    `gsd-footer-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  mkdirSync(dir, { recursive: true });
  const originalCwd = process.cwd();
  process.chdir(dir);
  t.after(() => {
    process.chdir(originalCwd);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
    }
  });
  let setFooterCallCount = 0;
  let healthWidgetHideCount = 0;
  const handlers = /* @__PURE__ */ new Map();
  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
    }
  };
  registerHooks(pi, []);
  const sessionStart = handlers.get("session_start");
  assert.ok(sessionStart, "session_start handler must be registered");
  await sessionStart({}, {
    hasUI: true,
    ui: {
      notify: () => {
      },
      setStatus: () => {
      },
      setFooter: (_footer) => {
        setFooterCallCount++;
      },
      setWorkingMessage: () => {
      },
      onTerminalInput: () => () => {
      },
      setWidget: (key, value) => {
        if (key === "gsd-health" && value === void 0) healthWidgetHideCount++;
      }
    },
    sessionManager: { getSessionId: () => null },
    model: null
  });
  assert.equal(setFooterCallCount, 0, "setFooter must NOT be called when isAutoActive() is false");
  assert.equal(healthWidgetHideCount, 0, "gsd-health must NOT be hidden when isAutoActive() is false");
});
test("session_start installs the welcome screen as the TUI header", async (t) => {
  const dir = join(
    tmpdir(),
    `gsd-welcome-header-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "bin", "welcome-screen.js"), "export const stale = true;\n", "utf-8");
  writeFileSync(
    join(dir, "dist", "welcome-screen.js"),
    [
      "export function buildWelcomeScreenLines(opts) {",
      "  return [`welcome ${opts.version} ${opts.remoteChannel ?? 'none'} ${opts.width}`];",
      "}",
      ""
    ].join("\n"),
    "utf-8"
  );
  const originalCwd = process.cwd();
  const originalGsdPkgRoot = process.env.GSD_PKG_ROOT;
  const originalGsdBinPath = process.env.GSD_BIN_PATH;
  const originalGsdVersion = process.env.GSD_VERSION;
  const originalFirstRunBanner = process.env.GSD_FIRST_RUN_BANNER;
  process.chdir(dir);
  process.env.GSD_PKG_ROOT = dir;
  process.env.GSD_BIN_PATH = join(dir, "bin", "loader.js");
  process.env.GSD_VERSION = "9.9.9-test";
  delete process.env.GSD_FIRST_RUN_BANNER;
  t.after(() => {
    process.chdir(originalCwd);
    if (originalGsdPkgRoot === void 0) delete process.env.GSD_PKG_ROOT;
    else process.env.GSD_PKG_ROOT = originalGsdPkgRoot;
    if (originalGsdBinPath === void 0) delete process.env.GSD_BIN_PATH;
    else process.env.GSD_BIN_PATH = originalGsdBinPath;
    if (originalGsdVersion === void 0) delete process.env.GSD_VERSION;
    else process.env.GSD_VERSION = originalGsdVersion;
    if (originalFirstRunBanner === void 0) delete process.env.GSD_FIRST_RUN_BANNER;
    else process.env.GSD_FIRST_RUN_BANNER = originalFirstRunBanner;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
    }
  });
  const handlers = /* @__PURE__ */ new Map();
  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
    }
  };
  registerHooks(pi, []);
  const sessionStart = handlers.get("session_start");
  assert.ok(sessionStart, "session_start handler must be registered");
  let headerFactory;
  await sessionStart({}, {
    hasUI: true,
    ui: {
      notify: () => {
      },
      setStatus: () => {
      },
      setFooter: () => {
      },
      setHeader: (factory) => {
        headerFactory = factory;
      },
      setWorkingMessage: () => {
      },
      onTerminalInput: () => () => {
      },
      setWidget: () => {
      }
    },
    sessionManager: { getSessionId: () => null },
    model: null
  });
  assert.equal(typeof headerFactory, "function", "session_start should install a header factory");
  const header = headerFactory({}, {});
  assert.deepEqual(header.render(123), ["welcome 9.9.9-test none 123"]);
});
test("session_start and session_switch apply disabled model provider policy from current preferences", async (t) => {
  const dir = join(
    tmpdir(),
    `gsd-disabled-provider-policy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  const tempGsdHome = join(dir, "home");
  mkdirSync(tempGsdHome, { recursive: true });
  const originalCwd = process.cwd();
  const originalGsdHome = process.env.GSD_HOME;
  process.env.GSD_HOME = tempGsdHome;
  process.chdir(dir);
  t.after(() => {
    process.chdir(originalCwd);
    if (originalGsdHome === void 0) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
    }
  });
  const writePrefs = (providers) => {
    writeFileSync(
      join(dir, ".gsd", "PREFERENCES.md"),
      [
        "---",
        "version: 1",
        "disabled_model_providers:",
        ...providers.map((provider) => `  - ${provider}`),
        "---",
        ""
      ].join("\n"),
      "utf-8"
    );
  };
  const appliedPolicies = [];
  const handlers = /* @__PURE__ */ new Map();
  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
    }
  };
  const ctx = {
    hasUI: true,
    ui: {
      notify: () => {
      },
      setStatus: () => {
      },
      setFooter: () => {
      },
      setWorkingMessage: () => {
      },
      onTerminalInput: () => () => {
      },
      setWidget: () => {
      }
    },
    sessionManager: { getSessionId: () => null },
    model: null,
    modelRegistry: {
      setDisabledModelProviders: (providers) => {
        appliedPolicies.push([...providers]);
      },
      getProviderAuthMode: () => void 0,
      isProviderRequestReady: () => false
    }
  };
  registerHooks(pi, []);
  const sessionStart = handlers.get("session_start");
  const sessionSwitch = handlers.get("session_switch");
  assert.ok(sessionStart, "session_start handler must be registered");
  assert.ok(sessionSwitch, "session_switch handler must be registered");
  writePrefs(["google-gemini-cli", " google-gemini-cli ", "openai-codex"]);
  await sessionStart({}, ctx);
  assert.deepEqual(
    appliedPolicies.at(-1),
    ["google-gemini-cli", "openai-codex"],
    "session_start should apply normalized disabled providers before the first agent turn"
  );
  writePrefs(["anthropic"]);
  await sessionSwitch({ reason: "resume" }, ctx);
  assert.deepEqual(
    appliedPolicies.at(-1),
    ["anthropic"],
    "session_switch should re-read preferences for the switched project/session context"
  );
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9zZXNzaW9uLXN0YXJ0LWZvb3Rlci50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBQcm9qZWN0L0FwcDogR1NELTJcbi8vIEZpbGUgUHVycG9zZTogVmVyaWZpZXMgR1NEIHNlc3Npb24gaG9vayB3aWRnZXQgYW5kIGZvb3RlciBsaWZlY3ljbGUgYmVoYXZpb3IuXG5cbi8qKlxuICogVmVyaWZpZXMgdGhhdCByZWdpc3Rlci1ob29rcy50cyBzdXBwcmVzc2VzIHRoZSBnc2QtaGVhbHRoIHdpZGdldCAobm90IHRoZVxuICogYnVpbHQtaW4gZm9vdGVyKSB3aGVuIGlzQXV0b0FjdGl2ZSgpIGlzIHRydWUsIGNsZWFycyBzdGFsZSBjb21wbGV0aW9uIHdpZGdldHNcbiAqIG9uIGluYWN0aXZlIHNlc3Npb24gc3dpdGNoZXMsIGFuZCB0aGF0IHNldEZvb3RlciBpcyBuZXZlciBjYWxsZWQgYnkgdGhlXG4gKiBleHRlbnNpb24gaW4gZWl0aGVyIHNlc3Npb25fc3RhcnQgb3Igc2Vzc2lvbl9zd2l0Y2guXG4gKlxuICogVGVzdGluZyBzdHJhdGVneTpcbiAqICAgMS4gU291cmNlLWNvZGUgcmVncmVzc2lvbiBndWFyZHM6IHN0cnVjdHVyYWwgY2hlY2tzIG9uIHJlZ2lzdGVyLWhvb2tzLnRzLlxuICogICAyLiBCZWhhdmlvcmFsIGludGVncmF0aW9uIHRlc3RzOiBmaXJlIHRoZSBsaXZlIHNlc3Npb24gaGFuZGxlcnMgd2l0aCBmYWtlXG4gKiAgICAgIGNvbnRleHRzIGFuZCBjb25maXJtIGZvb3Rlci93aWRnZXQgYmVoYXZpb3IgZnJvbSBydW50aW1lIGVmZmVjdHMuXG4gKlxuICogUmVsYXRlcyB0byAjNDMxNC5cbiAqL1xuXG5pbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZGlyU3luYywgcmVhZEZpbGVTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiwgZGlybmFtZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBmaWxlVVJMVG9QYXRoIH0gZnJvbSBcIm5vZGU6dXJsXCI7XG5cbmltcG9ydCB7IGF1dG9TZXNzaW9uIH0gZnJvbSBcIi4uL2F1dG8tcnVudGltZS1zdGF0ZS50c1wiO1xuaW1wb3J0IHsgcmVnaXN0ZXJIb29rcyB9IGZyb20gXCIuLi9ib290c3RyYXAvcmVnaXN0ZXItaG9va3MudHNcIjtcblxuY29uc3QgX19kaXJuYW1lID0gZGlybmFtZShmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuY29uc3QgSE9PS1NfU09VUkNFID0gcmVhZEZpbGVTeW5jKFxuICBqb2luKF9fZGlybmFtZSwgXCIuLlwiLCBcImJvb3RzdHJhcFwiLCBcInJlZ2lzdGVyLWhvb2tzLnRzXCIpLFxuICBcInV0Zi04XCIsXG4pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU291cmNlLWNvZGUgcmVncmVzc2lvbiBndWFyZHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJyZWdpc3Rlci1ob29rcy50cyBkb2VzIE5PVCBpbXBvcnQgaGlkZUZvb3RlclwiLCAoKSA9PiB7XG4gIGFzc2VydC5vayhcbiAgICAhSE9PS1NfU09VUkNFLmluY2x1ZGVzKFwiaGlkZUZvb3RlclwiKSxcbiAgICBcInJlZ2lzdGVyLWhvb2tzLnRzIG11c3Qgbm90IHJlZmVyZW5jZSBoaWRlRm9vdGVyIFx1MjAxNCBmb290ZXIgaXMgbm8gbG9uZ2VyIHN3YXBwZWQgaW4gYXV0byBtb2RlXCIsXG4gICk7XG59KTtcblxudGVzdChcInNlc3Npb25fc3RhcnQgaGFuZGxlciBndWFyZHMgaW5pdEhlYWx0aFdpZGdldCB3aXRoICFpc0F1dG9BY3RpdmUoKVwiLCAoKSA9PiB7XG4gIGNvbnN0IHNlc3Npb25TdGFydElkeCA9IEhPT0tTX1NPVVJDRS5pbmRleE9mKCdcInNlc3Npb25fc3RhcnRcIicpO1xuICBhc3NlcnQub2soc2Vzc2lvblN0YXJ0SWR4ID4gLTEsIFwic2Vzc2lvbl9zdGFydCBoYW5kbGVyIG11c3QgZXhpc3RcIik7XG5cbiAgY29uc3Qgc2Vzc2lvblN3aXRjaElkeCA9IEhPT0tTX1NPVVJDRS5pbmRleE9mKCdcInNlc3Npb25fc3dpdGNoXCInKTtcbiAgYXNzZXJ0Lm9rKHNlc3Npb25Td2l0Y2hJZHggPiBzZXNzaW9uU3RhcnRJZHgsIFwic2Vzc2lvbl9zd2l0Y2ggaGFuZGxlciBtdXN0IGZvbGxvdyBzZXNzaW9uX3N0YXJ0XCIpO1xuXG4gIGNvbnN0IHNlc3Npb25TdGFydEJvZHkgPSBIT09LU19TT1VSQ0Uuc2xpY2Uoc2Vzc2lvblN0YXJ0SWR4LCBzZXNzaW9uU3dpdGNoSWR4KTtcblxuICBhc3NlcnQub2soXG4gICAgc2Vzc2lvblN0YXJ0Qm9keS5pbmNsdWRlcyhcImlzQXV0b0FjdGl2ZSgpXCIpLFxuICAgIFwic2Vzc2lvbl9zdGFydCBoYW5kbGVyIG11c3QgY2FsbCBpc0F1dG9BY3RpdmUoKVwiLFxuICApO1xuICBhc3NlcnQub2soXG4gICAgc2Vzc2lvblN0YXJ0Qm9keS5pbmNsdWRlcyhcImluaXRIZWFsdGhXaWRnZXRcIiksXG4gICAgXCJzZXNzaW9uX3N0YXJ0IGhhbmRsZXIgbXVzdCByZWZlcmVuY2UgaW5pdEhlYWx0aFdpZGdldFwiLFxuICApO1xuICBhc3NlcnQub2soXG4gICAgIXNlc3Npb25TdGFydEJvZHkuaW5jbHVkZXMoXCJzZXRGb290ZXJcIiksXG4gICAgXCJzZXNzaW9uX3N0YXJ0IGhhbmRsZXIgbXVzdCBOT1QgY2FsbCBzZXRGb290ZXJcIixcbiAgKTtcblxuICBjb25zdCBndWFyZElkeCA9IHNlc3Npb25TdGFydEJvZHkuaW5kZXhPZihcImlzQXV0b0FjdGl2ZSgpXCIpO1xuICBjb25zdCBoZWFsdGhJZHggPSBzZXNzaW9uU3RhcnRCb2R5LmluZGV4T2YoXCJpbml0SGVhbHRoV2lkZ2V0XCIpO1xuICBhc3NlcnQub2soXG4gICAgZ3VhcmRJZHggPCBoZWFsdGhJZHgsXG4gICAgXCJpc0F1dG9BY3RpdmUoKSBndWFyZCBtdXN0IGFwcGVhciBiZWZvcmUgaW5pdEhlYWx0aFdpZGdldCBpbiBzZXNzaW9uX3N0YXJ0XCIsXG4gICk7XG59KTtcblxudGVzdChcInNlc3Npb25fc3dpdGNoIHRvZ2dsZXMgZ3NkLWhlYWx0aCBmcm9tIHJ1bnRpbWUgYXV0byBzdGF0ZSB3aXRob3V0IHRvdWNoaW5nIHRoZSBmb290ZXJcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgZGlyID0gam9pbihcbiAgICB0bXBkaXIoKSxcbiAgICBgZ3NkLXNlc3Npb24tc3dpdGNoLXdpZGdldC0ke0RhdGUubm93KCl9LSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiwgOCl9YCxcbiAgKTtcbiAgbWtkaXJTeW5jKGpvaW4oZGlyLCBcIi5nc2RcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBjb25zdCB0ZW1wR3NkSG9tZSA9IGpvaW4oZGlyLCBcImhvbWVcIik7XG4gIG1rZGlyU3luYyh0ZW1wR3NkSG9tZSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgY29uc3Qgb3JpZ2luYWxDd2QgPSBwcm9jZXNzLmN3ZCgpO1xuICBjb25zdCBvcmlnaW5hbEdzZEhvbWUgPSBwcm9jZXNzLmVudi5HU0RfSE9NRTtcbiAgcHJvY2Vzcy5lbnYuR1NEX0hPTUUgPSB0ZW1wR3NkSG9tZTtcbiAgcHJvY2Vzcy5jaGRpcihkaXIpO1xuICBhdXRvU2Vzc2lvbi5yZXNldCgpO1xuICB0LmFmdGVyKCgpID0+IHtcbiAgICBhdXRvU2Vzc2lvbi5yZXNldCgpO1xuICAgIHByb2Nlc3MuY2hkaXIob3JpZ2luYWxDd2QpO1xuICAgIGlmIChvcmlnaW5hbEdzZEhvbWUgPT09IHVuZGVmaW5lZCkgZGVsZXRlIHByb2Nlc3MuZW52LkdTRF9IT01FO1xuICAgIGVsc2UgcHJvY2Vzcy5lbnYuR1NEX0hPTUUgPSBvcmlnaW5hbEdzZEhvbWU7XG4gICAgdHJ5IHsgcm1TeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pOyB9IGNhdGNoIHsgLyogYmVzdC1lZmZvcnQgKi8gfVxuICB9KTtcblxuICBjb25zdCBoYW5kbGVycyA9IG5ldyBNYXA8c3RyaW5nLCAoZXZlbnQ6IHVua25vd24sIGN0eDogYW55KSA9PiBQcm9taXNlPHZvaWQ+IHwgdm9pZD4oKTtcbiAgY29uc3QgcGkgPSB7XG4gICAgb24oZXZlbnQ6IHN0cmluZywgaGFuZGxlcjogKGV2ZW50OiB1bmtub3duLCBjdHg6IGFueSkgPT4gUHJvbWlzZTx2b2lkPiB8IHZvaWQpIHtcbiAgICAgIGhhbmRsZXJzLnNldChldmVudCwgaGFuZGxlcik7XG4gICAgfSxcbiAgfSBhcyBhbnk7XG5cbiAgcmVnaXN0ZXJIb29rcyhwaSwgW10pO1xuXG4gIGNvbnN0IHNlc3Npb25Td2l0Y2ggPSBoYW5kbGVycy5nZXQoXCJzZXNzaW9uX3N3aXRjaFwiKTtcbiAgYXNzZXJ0Lm9rKHNlc3Npb25Td2l0Y2gsIFwic2Vzc2lvbl9zd2l0Y2ggaGFuZGxlciBtdXN0IGJlIHJlZ2lzdGVyZWRcIik7XG5cbiAgbGV0IHNldEZvb3RlckNhbGxDb3VudCA9IDA7XG4gIGNvbnN0IHdpZGdldENhbGxzOiBBcnJheTx7IGtleTogc3RyaW5nOyB2YWx1ZTogdW5rbm93biB9PiA9IFtdO1xuICBjb25zdCBjdHggPSB7XG4gICAgaGFzVUk6IHRydWUsXG4gICAgdWk6IHtcbiAgICAgIG5vdGlmeTogKCkgPT4ge30sXG4gICAgICBzZXRTdGF0dXM6ICgpID0+IHt9LFxuICAgICAgc2V0Rm9vdGVyOiAoX2Zvb3RlcjogdW5rbm93bikgPT4ge1xuICAgICAgICBzZXRGb290ZXJDYWxsQ291bnQrKztcbiAgICAgIH0sXG4gICAgICBzZXRXb3JraW5nTWVzc2FnZTogKCkgPT4ge30sXG4gICAgICBvblRlcm1pbmFsSW5wdXQ6ICgpID0+ICgpID0+IHt9LFxuICAgICAgc2V0V2lkZ2V0OiAoa2V5OiBzdHJpbmcsIHZhbHVlOiB1bmtub3duKSA9PiB7XG4gICAgICAgIHdpZGdldENhbGxzLnB1c2goeyBrZXksIHZhbHVlIH0pO1xuICAgICAgfSxcbiAgICB9LFxuICAgIHNlc3Npb25NYW5hZ2VyOiB7IGdldFNlc3Npb25JZDogKCkgPT4gbnVsbCB9LFxuICAgIG1vZGVsOiBudWxsLFxuICAgIG1vZGVsUmVnaXN0cnk6IHtcbiAgICAgIHNldERpc2FibGVkTW9kZWxQcm92aWRlcnM6ICgpID0+IHt9LFxuICAgICAgZ2V0UHJvdmlkZXJBdXRoTW9kZTogKCkgPT4gdW5kZWZpbmVkLFxuICAgICAgaXNQcm92aWRlclJlcXVlc3RSZWFkeTogKCkgPT4gZmFsc2UsXG4gICAgfSxcbiAgfTtcblxuICBhdXRvU2Vzc2lvbi5hY3RpdmUgPSB0cnVlO1xuICBhd2FpdCBzZXNzaW9uU3dpdGNoISh7IHJlYXNvbjogXCJyZXN1bWVcIiB9LCBjdHgpO1xuICBhc3NlcnQuZGVlcEVxdWFsKFxuICAgIHdpZGdldENhbGxzLmZpbHRlcigoY2FsbCkgPT4gY2FsbC5rZXkgPT09IFwiZ3NkLWhlYWx0aFwiKS5tYXAoKGNhbGwpID0+IGNhbGwudmFsdWUpLFxuICAgIFt1bmRlZmluZWRdLFxuICAgIFwic2Vzc2lvbl9zd2l0Y2ggc2hvdWxkIGhpZGUgZ3NkLWhlYWx0aCB3aGVuIGF1dG8gaXMgYWN0aXZlXCIsXG4gICk7XG4gIGFzc2VydC5lcXVhbChzZXRGb290ZXJDYWxsQ291bnQsIDAsIFwic2Vzc2lvbl9zd2l0Y2ggbXVzdCBub3QgY2FsbCBzZXRGb290ZXIgd2hlbiBhdXRvIGlzIGFjdGl2ZVwiKTtcblxuICB3aWRnZXRDYWxscy5sZW5ndGggPSAwO1xuICBhdXRvU2Vzc2lvbi5hY3RpdmUgPSBmYWxzZTtcbiAgYXdhaXQgc2Vzc2lvblN3aXRjaCEoeyByZWFzb246IFwicmVzdW1lXCIgfSwgY3R4KTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICB3aWRnZXRDYWxsc1xuICAgICAgLmZpbHRlcigoY2FsbCkgPT4gY2FsbC5rZXkgPT09IFwiZ3NkLXByb2dyZXNzXCIgfHwgY2FsbC5rZXkgPT09IFwiZ3NkLW91dGNvbWVcIilcbiAgICAgIC5tYXAoKGNhbGwpID0+IFtjYWxsLmtleSwgY2FsbC52YWx1ZV0pLFxuICAgIFtcbiAgICAgIFtcImdzZC1wcm9ncmVzc1wiLCB1bmRlZmluZWRdLFxuICAgICAgW1wiZ3NkLW91dGNvbWVcIiwgdW5kZWZpbmVkXSxcbiAgICBdLFxuICAgIFwic2Vzc2lvbl9zd2l0Y2ggc2hvdWxkIGNsZWFyIHN0YWxlIEdTRCBjb21wbGV0aW9uIHdpZGdldHMgd2hlbiBhdXRvIGlzIGluYWN0aXZlXCIsXG4gICk7XG4gIGNvbnN0IGhlYWx0aFdpZGdldFZhbHVlcyA9IHdpZGdldENhbGxzXG4gICAgLmZpbHRlcigoY2FsbCkgPT4gY2FsbC5rZXkgPT09IFwiZ3NkLWhlYWx0aFwiKVxuICAgIC5tYXAoKGNhbGwpID0+IGNhbGwudmFsdWUpO1xuXG4gIGFzc2VydC5vayhoZWFsdGhXaWRnZXRWYWx1ZXMubGVuZ3RoID49IDIsIFwic2Vzc2lvbl9zd2l0Y2ggc2hvdWxkIGluaXRpYWxpemUgZ3NkLWhlYWx0aCB3aGVuIGF1dG8gaXMgaW5hY3RpdmVcIik7XG4gIGFzc2VydC5vayhcbiAgICBoZWFsdGhXaWRnZXRWYWx1ZXMuZXZlcnkoKHZhbHVlKSA9PiB2YWx1ZSAhPT0gdW5kZWZpbmVkKSxcbiAgICBcInNlc3Npb25fc3dpdGNoIG11c3Qgbm90IGhpZGUgZ3NkLWhlYWx0aCB3aGVuIGF1dG8gaXMgaW5hY3RpdmVcIixcbiAgKTtcbiAgYXNzZXJ0Lm9rKEFycmF5LmlzQXJyYXkoaGVhbHRoV2lkZ2V0VmFsdWVzWzBdKSwgXCJpbml0SGVhbHRoV2lkZ2V0IHNob3VsZCBwdWJsaXNoIGluaXRpYWwgaGVhbHRoIGxpbmVzXCIpO1xuICBhc3NlcnQuZXF1YWwodHlwZW9mIGhlYWx0aFdpZGdldFZhbHVlcy5hdCgtMSksIFwiZnVuY3Rpb25cIiwgXCJpbml0SGVhbHRoV2lkZ2V0IHNob3VsZCByZWdpc3RlciB0aGUgbGl2ZSB3aWRnZXQgZmFjdG9yeVwiKTtcbiAgYXNzZXJ0LmVxdWFsKHNldEZvb3RlckNhbGxDb3VudCwgMCwgXCJzZXNzaW9uX3N3aXRjaCBtdXN0IG5vdCBjYWxsIHNldEZvb3RlciB3aGVuIGF1dG8gaXMgaW5hY3RpdmVcIik7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEJlaGF2aW9yYWwgdGVzdDogbmVpdGhlciBzZXRGb290ZXIgbm9yIGhlYWx0aCBzdXBwcmVzc2lvbiB3aGVuIGF1dG8gaW5hY3RpdmUgXHUyNTAwXG5cbnRlc3QoXCJzZXNzaW9uX3N0YXJ0IGRvZXMgTk9UIGNhbGwgc2V0Rm9vdGVyIG9yIHN1cHByZXNzIGdzZC1oZWFsdGggd2hlbiBpc0F1dG9BY3RpdmUoKSBpcyBmYWxzZVwiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCBkaXIgPSBqb2luKFxuICAgIHRtcGRpcigpLFxuICAgIGBnc2QtZm9vdGVyLXRlc3QtJHtEYXRlLm5vdygpfS0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDgpfWAsXG4gICk7XG4gIG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gIGNvbnN0IG9yaWdpbmFsQ3dkID0gcHJvY2Vzcy5jd2QoKTtcbiAgcHJvY2Vzcy5jaGRpcihkaXIpO1xuICB0LmFmdGVyKCgpID0+IHtcbiAgICBwcm9jZXNzLmNoZGlyKG9yaWdpbmFsQ3dkKTtcbiAgICB0cnkgeyBybVN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7IH0gY2F0Y2ggeyAvKiBiZXN0LWVmZm9ydCAqLyB9XG4gIH0pO1xuXG4gIGxldCBzZXRGb290ZXJDYWxsQ291bnQgPSAwO1xuICBsZXQgaGVhbHRoV2lkZ2V0SGlkZUNvdW50ID0gMDtcblxuICBjb25zdCBoYW5kbGVycyA9IG5ldyBNYXA8c3RyaW5nLCAoZXZlbnQ6IHVua25vd24sIGN0eDogYW55KSA9PiBQcm9taXNlPHZvaWQ+IHwgdm9pZD4oKTtcbiAgY29uc3QgcGkgPSB7XG4gICAgb24oZXZlbnQ6IHN0cmluZywgaGFuZGxlcjogKGV2ZW50OiB1bmtub3duLCBjdHg6IGFueSkgPT4gUHJvbWlzZTx2b2lkPiB8IHZvaWQpIHtcbiAgICAgIGhhbmRsZXJzLnNldChldmVudCwgaGFuZGxlcik7XG4gICAgfSxcbiAgfSBhcyBhbnk7XG5cbiAgcmVnaXN0ZXJIb29rcyhwaSwgW10pO1xuXG4gIGNvbnN0IHNlc3Npb25TdGFydCA9IGhhbmRsZXJzLmdldChcInNlc3Npb25fc3RhcnRcIik7XG4gIGFzc2VydC5vayhzZXNzaW9uU3RhcnQsIFwic2Vzc2lvbl9zdGFydCBoYW5kbGVyIG11c3QgYmUgcmVnaXN0ZXJlZFwiKTtcblxuICBhd2FpdCBzZXNzaW9uU3RhcnQhKHt9LCB7XG4gICAgaGFzVUk6IHRydWUsXG4gICAgdWk6IHtcbiAgICAgIG5vdGlmeTogKCkgPT4ge30sXG4gICAgICBzZXRTdGF0dXM6ICgpID0+IHt9LFxuICAgICAgc2V0Rm9vdGVyOiAoX2Zvb3RlcjogdW5rbm93bikgPT4ge1xuICAgICAgICBzZXRGb290ZXJDYWxsQ291bnQrKztcbiAgICAgIH0sXG4gICAgICBzZXRXb3JraW5nTWVzc2FnZTogKCkgPT4ge30sXG4gICAgICBvblRlcm1pbmFsSW5wdXQ6ICgpID0+ICgpID0+IHt9LFxuICAgICAgc2V0V2lkZ2V0OiAoa2V5OiBzdHJpbmcsIHZhbHVlOiB1bmtub3duKSA9PiB7XG4gICAgICAgIGlmIChrZXkgPT09IFwiZ3NkLWhlYWx0aFwiICYmIHZhbHVlID09PSB1bmRlZmluZWQpIGhlYWx0aFdpZGdldEhpZGVDb3VudCsrO1xuICAgICAgfSxcbiAgICB9LFxuICAgIHNlc3Npb25NYW5hZ2VyOiB7IGdldFNlc3Npb25JZDogKCkgPT4gbnVsbCB9LFxuICAgIG1vZGVsOiBudWxsLFxuICB9IGFzIGFueSk7XG5cbiAgYXNzZXJ0LmVxdWFsKHNldEZvb3RlckNhbGxDb3VudCwgMCwgXCJzZXRGb290ZXIgbXVzdCBOT1QgYmUgY2FsbGVkIHdoZW4gaXNBdXRvQWN0aXZlKCkgaXMgZmFsc2VcIik7XG4gIGFzc2VydC5lcXVhbChoZWFsdGhXaWRnZXRIaWRlQ291bnQsIDAsIFwiZ3NkLWhlYWx0aCBtdXN0IE5PVCBiZSBoaWRkZW4gd2hlbiBpc0F1dG9BY3RpdmUoKSBpcyBmYWxzZVwiKTtcbn0pO1xuXG50ZXN0KFwic2Vzc2lvbl9zdGFydCBpbnN0YWxscyB0aGUgd2VsY29tZSBzY3JlZW4gYXMgdGhlIFRVSSBoZWFkZXJcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgZGlyID0gam9pbihcbiAgICB0bXBkaXIoKSxcbiAgICBgZ3NkLXdlbGNvbWUtaGVhZGVyLSR7RGF0ZS5ub3coKX0tJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCA4KX1gLFxuICApO1xuICBta2RpclN5bmMoam9pbihkaXIsIFwiYmluXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgbWtkaXJTeW5jKGpvaW4oZGlyLCBcImRpc3RcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcImJpblwiLCBcIndlbGNvbWUtc2NyZWVuLmpzXCIpLCBcImV4cG9ydCBjb25zdCBzdGFsZSA9IHRydWU7XFxuXCIsIFwidXRmLThcIik7XG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbihkaXIsIFwiZGlzdFwiLCBcIndlbGNvbWUtc2NyZWVuLmpzXCIpLFxuICAgIFtcbiAgICAgIFwiZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkV2VsY29tZVNjcmVlbkxpbmVzKG9wdHMpIHtcIixcbiAgICAgIFwiICByZXR1cm4gW2B3ZWxjb21lICR7b3B0cy52ZXJzaW9ufSAke29wdHMucmVtb3RlQ2hhbm5lbCA/PyAnbm9uZSd9ICR7b3B0cy53aWR0aH1gXTtcIixcbiAgICAgIFwifVwiLFxuICAgICAgXCJcIixcbiAgICBdLmpvaW4oXCJcXG5cIiksXG4gICAgXCJ1dGYtOFwiLFxuICApO1xuXG4gIGNvbnN0IG9yaWdpbmFsQ3dkID0gcHJvY2Vzcy5jd2QoKTtcbiAgY29uc3Qgb3JpZ2luYWxHc2RQa2dSb290ID0gcHJvY2Vzcy5lbnYuR1NEX1BLR19ST09UO1xuICBjb25zdCBvcmlnaW5hbEdzZEJpblBhdGggPSBwcm9jZXNzLmVudi5HU0RfQklOX1BBVEg7XG4gIGNvbnN0IG9yaWdpbmFsR3NkVmVyc2lvbiA9IHByb2Nlc3MuZW52LkdTRF9WRVJTSU9OO1xuICBjb25zdCBvcmlnaW5hbEZpcnN0UnVuQmFubmVyID0gcHJvY2Vzcy5lbnYuR1NEX0ZJUlNUX1JVTl9CQU5ORVI7XG4gIHByb2Nlc3MuY2hkaXIoZGlyKTtcbiAgcHJvY2Vzcy5lbnYuR1NEX1BLR19ST09UID0gZGlyO1xuICBwcm9jZXNzLmVudi5HU0RfQklOX1BBVEggPSBqb2luKGRpciwgXCJiaW5cIiwgXCJsb2FkZXIuanNcIik7XG4gIHByb2Nlc3MuZW52LkdTRF9WRVJTSU9OID0gXCI5LjkuOS10ZXN0XCI7XG4gIGRlbGV0ZSBwcm9jZXNzLmVudi5HU0RfRklSU1RfUlVOX0JBTk5FUjtcbiAgdC5hZnRlcigoKSA9PiB7XG4gICAgcHJvY2Vzcy5jaGRpcihvcmlnaW5hbEN3ZCk7XG4gICAgaWYgKG9yaWdpbmFsR3NkUGtnUm9vdCA9PT0gdW5kZWZpbmVkKSBkZWxldGUgcHJvY2Vzcy5lbnYuR1NEX1BLR19ST09UO1xuICAgIGVsc2UgcHJvY2Vzcy5lbnYuR1NEX1BLR19ST09UID0gb3JpZ2luYWxHc2RQa2dSb290O1xuICAgIGlmIChvcmlnaW5hbEdzZEJpblBhdGggPT09IHVuZGVmaW5lZCkgZGVsZXRlIHByb2Nlc3MuZW52LkdTRF9CSU5fUEFUSDtcbiAgICBlbHNlIHByb2Nlc3MuZW52LkdTRF9CSU5fUEFUSCA9IG9yaWdpbmFsR3NkQmluUGF0aDtcbiAgICBpZiAob3JpZ2luYWxHc2RWZXJzaW9uID09PSB1bmRlZmluZWQpIGRlbGV0ZSBwcm9jZXNzLmVudi5HU0RfVkVSU0lPTjtcbiAgICBlbHNlIHByb2Nlc3MuZW52LkdTRF9WRVJTSU9OID0gb3JpZ2luYWxHc2RWZXJzaW9uO1xuICAgIGlmIChvcmlnaW5hbEZpcnN0UnVuQmFubmVyID09PSB1bmRlZmluZWQpIGRlbGV0ZSBwcm9jZXNzLmVudi5HU0RfRklSU1RfUlVOX0JBTk5FUjtcbiAgICBlbHNlIHByb2Nlc3MuZW52LkdTRF9GSVJTVF9SVU5fQkFOTkVSID0gb3JpZ2luYWxGaXJzdFJ1bkJhbm5lcjtcbiAgICB0cnkgeyBybVN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7IH0gY2F0Y2ggeyAvKiBiZXN0LWVmZm9ydCAqLyB9XG4gIH0pO1xuXG4gIGNvbnN0IGhhbmRsZXJzID0gbmV3IE1hcDxzdHJpbmcsIChldmVudDogdW5rbm93biwgY3R4OiBhbnkpID0+IFByb21pc2U8dm9pZD4gfCB2b2lkPigpO1xuICBjb25zdCBwaSA9IHtcbiAgICBvbihldmVudDogc3RyaW5nLCBoYW5kbGVyOiAoZXZlbnQ6IHVua25vd24sIGN0eDogYW55KSA9PiBQcm9taXNlPHZvaWQ+IHwgdm9pZCkge1xuICAgICAgaGFuZGxlcnMuc2V0KGV2ZW50LCBoYW5kbGVyKTtcbiAgICB9LFxuICB9IGFzIGFueTtcblxuICByZWdpc3Rlckhvb2tzKHBpLCBbXSk7XG5cbiAgY29uc3Qgc2Vzc2lvblN0YXJ0ID0gaGFuZGxlcnMuZ2V0KFwic2Vzc2lvbl9zdGFydFwiKTtcbiAgYXNzZXJ0Lm9rKHNlc3Npb25TdGFydCwgXCJzZXNzaW9uX3N0YXJ0IGhhbmRsZXIgbXVzdCBiZSByZWdpc3RlcmVkXCIpO1xuXG4gIGxldCBoZWFkZXJGYWN0b3J5OiAoKHR1aTogdW5rbm93biwgdGhlbWU6IHVua25vd24pID0+IHsgcmVuZGVyKHdpZHRoOiBudW1iZXIpOiBzdHJpbmdbXSB9KSB8IHVuZGVmaW5lZDtcbiAgYXdhaXQgc2Vzc2lvblN0YXJ0ISh7fSwge1xuICAgIGhhc1VJOiB0cnVlLFxuICAgIHVpOiB7XG4gICAgICBub3RpZnk6ICgpID0+IHt9LFxuICAgICAgc2V0U3RhdHVzOiAoKSA9PiB7fSxcbiAgICAgIHNldEZvb3RlcjogKCkgPT4ge30sXG4gICAgICBzZXRIZWFkZXI6IChmYWN0b3J5OiB0eXBlb2YgaGVhZGVyRmFjdG9yeSkgPT4ge1xuICAgICAgICBoZWFkZXJGYWN0b3J5ID0gZmFjdG9yeTtcbiAgICAgIH0sXG4gICAgICBzZXRXb3JraW5nTWVzc2FnZTogKCkgPT4ge30sXG4gICAgICBvblRlcm1pbmFsSW5wdXQ6ICgpID0+ICgpID0+IHt9LFxuICAgICAgc2V0V2lkZ2V0OiAoKSA9PiB7fSxcbiAgICB9LFxuICAgIHNlc3Npb25NYW5hZ2VyOiB7IGdldFNlc3Npb25JZDogKCkgPT4gbnVsbCB9LFxuICAgIG1vZGVsOiBudWxsLFxuICB9IGFzIGFueSk7XG5cbiAgYXNzZXJ0LmVxdWFsKHR5cGVvZiBoZWFkZXJGYWN0b3J5LCBcImZ1bmN0aW9uXCIsIFwic2Vzc2lvbl9zdGFydCBzaG91bGQgaW5zdGFsbCBhIGhlYWRlciBmYWN0b3J5XCIpO1xuICBjb25zdCBoZWFkZXIgPSBoZWFkZXJGYWN0b3J5ISh7fSwge30pO1xuICBhc3NlcnQuZGVlcEVxdWFsKGhlYWRlci5yZW5kZXIoMTIzKSwgW1wid2VsY29tZSA5LjkuOS10ZXN0IG5vbmUgMTIzXCJdKTtcbn0pO1xuXG50ZXN0KFwic2Vzc2lvbl9zdGFydCBhbmQgc2Vzc2lvbl9zd2l0Y2ggYXBwbHkgZGlzYWJsZWQgbW9kZWwgcHJvdmlkZXIgcG9saWN5IGZyb20gY3VycmVudCBwcmVmZXJlbmNlc1wiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCBkaXIgPSBqb2luKFxuICAgIHRtcGRpcigpLFxuICAgIGBnc2QtZGlzYWJsZWQtcHJvdmlkZXItcG9saWN5LSR7RGF0ZS5ub3coKX0tJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCA4KX1gLFxuICApO1xuICBta2RpclN5bmMoam9pbihkaXIsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGNvbnN0IHRlbXBHc2RIb21lID0gam9pbihkaXIsIFwiaG9tZVwiKTtcbiAgbWtkaXJTeW5jKHRlbXBHc2RIb21lLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICBjb25zdCBvcmlnaW5hbEN3ZCA9IHByb2Nlc3MuY3dkKCk7XG4gIGNvbnN0IG9yaWdpbmFsR3NkSG9tZSA9IHByb2Nlc3MuZW52LkdTRF9IT01FO1xuICBwcm9jZXNzLmVudi5HU0RfSE9NRSA9IHRlbXBHc2RIb21lO1xuICBwcm9jZXNzLmNoZGlyKGRpcik7XG4gIHQuYWZ0ZXIoKCkgPT4ge1xuICAgIHByb2Nlc3MuY2hkaXIob3JpZ2luYWxDd2QpO1xuICAgIGlmIChvcmlnaW5hbEdzZEhvbWUgPT09IHVuZGVmaW5lZCkgZGVsZXRlIHByb2Nlc3MuZW52LkdTRF9IT01FO1xuICAgIGVsc2UgcHJvY2Vzcy5lbnYuR1NEX0hPTUUgPSBvcmlnaW5hbEdzZEhvbWU7XG4gICAgdHJ5IHsgcm1TeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pOyB9IGNhdGNoIHsgLyogYmVzdC1lZmZvcnQgKi8gfVxuICB9KTtcblxuICBjb25zdCB3cml0ZVByZWZzID0gKHByb3ZpZGVyczogc3RyaW5nW10pID0+IHtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihkaXIsIFwiLmdzZFwiLCBcIlBSRUZFUkVOQ0VTLm1kXCIpLFxuICAgICAgW1xuICAgICAgICBcIi0tLVwiLFxuICAgICAgICBcInZlcnNpb246IDFcIixcbiAgICAgICAgXCJkaXNhYmxlZF9tb2RlbF9wcm92aWRlcnM6XCIsXG4gICAgICAgIC4uLnByb3ZpZGVycy5tYXAoKHByb3ZpZGVyKSA9PiBgICAtICR7cHJvdmlkZXJ9YCksXG4gICAgICAgIFwiLS0tXCIsXG4gICAgICAgIFwiXCIsXG4gICAgICBdLmpvaW4oXCJcXG5cIiksXG4gICAgICBcInV0Zi04XCIsXG4gICAgKTtcbiAgfTtcblxuICBjb25zdCBhcHBsaWVkUG9saWNpZXM6IHN0cmluZ1tdW10gPSBbXTtcbiAgY29uc3QgaGFuZGxlcnMgPSBuZXcgTWFwPHN0cmluZywgKGV2ZW50OiB1bmtub3duLCBjdHg6IGFueSkgPT4gUHJvbWlzZTx2b2lkPiB8IHZvaWQ+KCk7XG4gIGNvbnN0IHBpID0ge1xuICAgIG9uKGV2ZW50OiBzdHJpbmcsIGhhbmRsZXI6IChldmVudDogdW5rbm93biwgY3R4OiBhbnkpID0+IFByb21pc2U8dm9pZD4gfCB2b2lkKSB7XG4gICAgICBoYW5kbGVycy5zZXQoZXZlbnQsIGhhbmRsZXIpO1xuICAgIH0sXG4gIH0gYXMgYW55O1xuICBjb25zdCBjdHggPSB7XG4gICAgaGFzVUk6IHRydWUsXG4gICAgdWk6IHtcbiAgICAgIG5vdGlmeTogKCkgPT4ge30sXG4gICAgICBzZXRTdGF0dXM6ICgpID0+IHt9LFxuICAgICAgc2V0Rm9vdGVyOiAoKSA9PiB7fSxcbiAgICAgIHNldFdvcmtpbmdNZXNzYWdlOiAoKSA9PiB7fSxcbiAgICAgIG9uVGVybWluYWxJbnB1dDogKCkgPT4gKCkgPT4ge30sXG4gICAgICBzZXRXaWRnZXQ6ICgpID0+IHt9LFxuICAgIH0sXG4gICAgc2Vzc2lvbk1hbmFnZXI6IHsgZ2V0U2Vzc2lvbklkOiAoKSA9PiBudWxsIH0sXG4gICAgbW9kZWw6IG51bGwsXG4gICAgbW9kZWxSZWdpc3RyeToge1xuICAgICAgc2V0RGlzYWJsZWRNb2RlbFByb3ZpZGVyczogKHByb3ZpZGVyczogc3RyaW5nW10pID0+IHtcbiAgICAgICAgYXBwbGllZFBvbGljaWVzLnB1c2goWy4uLnByb3ZpZGVyc10pO1xuICAgICAgfSxcbiAgICAgIGdldFByb3ZpZGVyQXV0aE1vZGU6ICgpID0+IHVuZGVmaW5lZCxcbiAgICAgIGlzUHJvdmlkZXJSZXF1ZXN0UmVhZHk6ICgpID0+IGZhbHNlLFxuICAgIH0sXG4gIH07XG5cbiAgcmVnaXN0ZXJIb29rcyhwaSwgW10pO1xuXG4gIGNvbnN0IHNlc3Npb25TdGFydCA9IGhhbmRsZXJzLmdldChcInNlc3Npb25fc3RhcnRcIik7XG4gIGNvbnN0IHNlc3Npb25Td2l0Y2ggPSBoYW5kbGVycy5nZXQoXCJzZXNzaW9uX3N3aXRjaFwiKTtcbiAgYXNzZXJ0Lm9rKHNlc3Npb25TdGFydCwgXCJzZXNzaW9uX3N0YXJ0IGhhbmRsZXIgbXVzdCBiZSByZWdpc3RlcmVkXCIpO1xuICBhc3NlcnQub2soc2Vzc2lvblN3aXRjaCwgXCJzZXNzaW9uX3N3aXRjaCBoYW5kbGVyIG11c3QgYmUgcmVnaXN0ZXJlZFwiKTtcblxuICB3cml0ZVByZWZzKFtcImdvb2dsZS1nZW1pbmktY2xpXCIsIFwiIGdvb2dsZS1nZW1pbmktY2xpIFwiLCBcIm9wZW5haS1jb2RleFwiXSk7XG4gIGF3YWl0IHNlc3Npb25TdGFydCEoe30sIGN0eCk7XG4gIGFzc2VydC5kZWVwRXF1YWwoXG4gICAgYXBwbGllZFBvbGljaWVzLmF0KC0xKSxcbiAgICBbXCJnb29nbGUtZ2VtaW5pLWNsaVwiLCBcIm9wZW5haS1jb2RleFwiXSxcbiAgICBcInNlc3Npb25fc3RhcnQgc2hvdWxkIGFwcGx5IG5vcm1hbGl6ZWQgZGlzYWJsZWQgcHJvdmlkZXJzIGJlZm9yZSB0aGUgZmlyc3QgYWdlbnQgdHVyblwiLFxuICApO1xuXG4gIHdyaXRlUHJlZnMoW1wiYW50aHJvcGljXCJdKTtcbiAgYXdhaXQgc2Vzc2lvblN3aXRjaCEoeyByZWFzb246IFwicmVzdW1lXCIgfSwgY3R4KTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICBhcHBsaWVkUG9saWNpZXMuYXQoLTEpLFxuICAgIFtcImFudGhyb3BpY1wiXSxcbiAgICBcInNlc3Npb25fc3dpdGNoIHNob3VsZCByZS1yZWFkIHByZWZlcmVuY2VzIGZvciB0aGUgc3dpdGNoZWQgcHJvamVjdC9zZXNzaW9uIGNvbnRleHRcIixcbiAgKTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBaUJBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxXQUFXLGNBQWMsUUFBUSxxQkFBcUI7QUFDL0QsU0FBUyxNQUFNLGVBQWU7QUFDOUIsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMscUJBQXFCO0FBRTlCLFNBQVMsbUJBQW1CO0FBQzVCLFNBQVMscUJBQXFCO0FBRTlCLE1BQU0sWUFBWSxRQUFRLGNBQWMsWUFBWSxHQUFHLENBQUM7QUFDeEQsTUFBTSxlQUFlO0FBQUEsRUFDbkIsS0FBSyxXQUFXLE1BQU0sYUFBYSxtQkFBbUI7QUFBQSxFQUN0RDtBQUNGO0FBSUEsS0FBSyxnREFBZ0QsTUFBTTtBQUN6RCxTQUFPO0FBQUEsSUFDTCxDQUFDLGFBQWEsU0FBUyxZQUFZO0FBQUEsSUFDbkM7QUFBQSxFQUNGO0FBQ0YsQ0FBQztBQUVELEtBQUssc0VBQXNFLE1BQU07QUFDL0UsUUFBTSxrQkFBa0IsYUFBYSxRQUFRLGlCQUFpQjtBQUM5RCxTQUFPLEdBQUcsa0JBQWtCLElBQUksa0NBQWtDO0FBRWxFLFFBQU0sbUJBQW1CLGFBQWEsUUFBUSxrQkFBa0I7QUFDaEUsU0FBTyxHQUFHLG1CQUFtQixpQkFBaUIsa0RBQWtEO0FBRWhHLFFBQU0sbUJBQW1CLGFBQWEsTUFBTSxpQkFBaUIsZ0JBQWdCO0FBRTdFLFNBQU87QUFBQSxJQUNMLGlCQUFpQixTQUFTLGdCQUFnQjtBQUFBLElBQzFDO0FBQUEsRUFDRjtBQUNBLFNBQU87QUFBQSxJQUNMLGlCQUFpQixTQUFTLGtCQUFrQjtBQUFBLElBQzVDO0FBQUEsRUFDRjtBQUNBLFNBQU87QUFBQSxJQUNMLENBQUMsaUJB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
