import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CONFIG_DIR_NAME } from "../config.js";
import { ExtensionRunner } from "./extensions/runner.js";
import { createHooksRunner, isProjectHooksTrusted } from "./hooks-runner.js";
function makeTempProject() {
  const base = mkdtempSync(join(tmpdir(), "hooks-runner-test-"));
  mkdirSync(join(base, CONFIG_DIR_NAME), { recursive: true });
  return base;
}
function trust(cwd) {
  writeFileSync(join(cwd, CONFIG_DIR_NAME, "hooks.trusted"), "");
}
function stubRuntime() {
  return {
    flagValues: /* @__PURE__ */ new Map(),
    pendingProviderRegistrations: [],
    registerProvider: () => {
    },
    unregisterProvider: () => {
    },
    emitBeforeModelSelect: async () => void 0,
    emitAdjustToolSet: async () => void 0,
    emitExtensionEvent: async () => void 0,
    sendMessage: () => {
    },
    sendUserMessage: () => {
    },
    retryLastTurn: () => {
    },
    appendEntry: () => {
    },
    setSessionName: () => {
    },
    getSessionName: () => void 0,
    setLabel: () => {
    },
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {
    },
    getVisibleSkills: () => void 0,
    setVisibleSkills: () => {
    },
    refreshTools: () => {
    },
    getCommands: () => [],
    setModel: async () => false,
    getThinkingLevel: () => "off",
    setThinkingLevel: () => {
    }
  };
}
function makeRunner(cwd) {
  return new ExtensionRunner(
    [],
    stubRuntime(),
    cwd,
    {},
    {}
  );
}
describe("isProjectHooksTrusted", () => {
  let tmpCwd;
  afterEach(() => {
    if (tmpCwd) rmSync(tmpCwd, { recursive: true, force: true });
    tmpCwd = void 0;
  });
  it("returns false when the marker is missing", () => {
    tmpCwd = makeTempProject();
    assert.equal(isProjectHooksTrusted(tmpCwd), false);
  });
  it("returns true after the marker is written", () => {
    tmpCwd = makeTempProject();
    trust(tmpCwd);
    assert.equal(isProjectHooksTrusted(tmpCwd), true);
  });
});
describe("createHooksRunner \u2014 trust gate", () => {
  let tmpCwd;
  afterEach(() => {
    if (tmpCwd) rmSync(tmpCwd, { recursive: true, force: true });
    tmpCwd = void 0;
  });
  it("ignores project hooks when the trust marker is absent", async () => {
    tmpCwd = makeTempProject();
    const runner = makeRunner(tmpCwd);
    const invocations = [];
    const hooks = createHooksRunner({
      extensionRunner: runner,
      getGlobalSettings: () => ({}),
      getProjectSettings: () => ({
        hooks: {
          SessionStart: [
            { command: `node -e "process.stdout.write('{}')"` }
          ]
        }
      }),
      cwd: tmpCwd,
      onInvocation: (i) => invocations.push(i.command)
    });
    await hooks.fireSessionStart();
    assert.deepEqual(invocations, []);
    hooks.dispose();
  });
  it("runs project hooks when the trust marker is present", async () => {
    tmpCwd = makeTempProject();
    trust(tmpCwd);
    const runner = makeRunner(tmpCwd);
    const invocations = [];
    const hooks = createHooksRunner({
      extensionRunner: runner,
      getGlobalSettings: () => ({}),
      getProjectSettings: () => ({
        hooks: {
          SessionStart: [{ command: `node -e "process.exit(0)"` }]
        }
      }),
      cwd: tmpCwd,
      onInvocation: (i) => invocations.push(i.command)
    });
    await hooks.fireSessionStart();
    assert.deepEqual(invocations, [`node -e "process.exit(0)"`]);
    hooks.dispose();
  });
  it("runs global hooks unconditionally", async () => {
    tmpCwd = makeTempProject();
    const runner = makeRunner(tmpCwd);
    const invocations = [];
    const hooks = createHooksRunner({
      extensionRunner: runner,
      getGlobalSettings: () => ({
        hooks: { SessionStart: [{ command: `node -e "process.exit(0)"` }] }
      }),
      getProjectSettings: () => ({}),
      cwd: tmpCwd,
      onInvocation: (i) => invocations.push(i.command)
    });
    await hooks.fireSessionStart();
    assert.deepEqual(invocations, [`node -e "process.exit(0)"`]);
    hooks.dispose();
  });
});
describe("createHooksRunner \u2014 PreToolUse bridges to tool_call", () => {
  let tmpCwd;
  afterEach(() => {
    if (tmpCwd) rmSync(tmpCwd, { recursive: true, force: true });
    tmpCwd = void 0;
  });
  it("blocks a tool call when the PreToolUse hook returns { block: true }", async () => {
    tmpCwd = makeTempProject();
    const runner = makeRunner(tmpCwd);
    createHooksRunner({
      extensionRunner: runner,
      getGlobalSettings: () => ({
        hooks: {
          PreToolUse: [
            {
              command: `node -e "process.stdout.write(JSON.stringify({block:true,reason:'nope'}))"`
            }
          ]
        }
      }),
      getProjectSettings: () => ({}),
      cwd: tmpCwd
    });
    const result = await runner.emitToolCall({
      type: "tool_call",
      toolCallId: "t1",
      toolName: "bash",
      input: { command: "ls" }
    });
    assert.equal(result?.block, true);
    assert.equal(result?.reason, "nope");
  });
  it("applies filter.tool to scope the hook", async () => {
    tmpCwd = makeTempProject();
    const runner = makeRunner(tmpCwd);
    createHooksRunner({
      extensionRunner: runner,
      getGlobalSettings: () => ({
        hooks: {
          PreToolUse: [
            {
              match: { tool: "bash" },
              command: `node -e "process.stdout.write(JSON.stringify({block:true,reason:'bash-only'}))"`
            }
          ]
        }
      }),
      getProjectSettings: () => ({}),
      cwd: tmpCwd
    });
    const readResult = await runner.emitToolCall({
      type: "tool_call",
      toolCallId: "t2",
      toolName: "read",
      input: { path: "/tmp/x" }
    });
    assert.equal(readResult?.block, void 0);
    const bashResult = await runner.emitToolCall({
      type: "tool_call",
      toolCallId: "t3",
      toolName: "bash",
      input: { command: "rm -rf /" }
    });
    assert.equal(bashResult?.block, true);
  });
  it("treats a non-zero exit as a block when blocking is not disabled", async () => {
    tmpCwd = makeTempProject();
    const runner = makeRunner(tmpCwd);
    createHooksRunner({
      extensionRunner: runner,
      getGlobalSettings: () => ({
        hooks: { PreToolUse: [{ command: `node -e "process.exit(1)"` }] }
      }),
      getProjectSettings: () => ({}),
      cwd: tmpCwd
    });
    const result = await runner.emitToolCall({
      type: "tool_call",
      toolCallId: "t4",
      toolName: "bash",
      input: { command: "ls" }
    });
    assert.equal(result?.block, true);
  });
  it("does not block when blocking: false and exit is non-zero", async () => {
    tmpCwd = makeTempProject();
    const runner = makeRunner(tmpCwd);
    createHooksRunner({
      extensionRunner: runner,
      getGlobalSettings: () => ({
        hooks: { PreToolUse: [{ command: `node -e "process.exit(1)"`, blocking: false }] }
      }),
      getProjectSettings: () => ({}),
      cwd: tmpCwd
    });
    const result = await runner.emitToolCall({
      type: "tool_call",
      toolCallId: "t5",
      toolName: "bash",
      input: { command: "ls" }
    });
    assert.equal(result?.block, void 0);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL2hvb2tzLXJ1bm5lci50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyBkZXNjcmliZSwgaXQsIGFmdGVyRWFjaCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgd3JpdGVGaWxlU3luYywgcm1TeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgQ09ORklHX0RJUl9OQU1FIH0gZnJvbSBcIi4uL2NvbmZpZy5qc1wiO1xuaW1wb3J0IHsgRXh0ZW5zaW9uUnVubmVyIH0gZnJvbSBcIi4vZXh0ZW5zaW9ucy9ydW5uZXIuanNcIjtcbmltcG9ydCB7IGNyZWF0ZUhvb2tzUnVubmVyLCBpc1Byb2plY3RIb29rc1RydXN0ZWQgfSBmcm9tIFwiLi9ob29rcy1ydW5uZXIuanNcIjtcbmltcG9ydCB0eXBlIHsgRXh0ZW5zaW9uUnVudGltZSB9IGZyb20gXCIuL2V4dGVuc2lvbnMvdHlwZXMuanNcIjtcbmltcG9ydCB0eXBlIHsgU2V0dGluZ3MgfSBmcm9tIFwiLi9zZXR0aW5ncy1tYW5hZ2VyLmpzXCI7XG5cbmZ1bmN0aW9uIG1ha2VUZW1wUHJvamVjdCgpIHtcbiAgY29uc3QgYmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiaG9va3MtcnVubmVyLXRlc3QtXCIpKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgQ09ORklHX0RJUl9OQU1FKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHJldHVybiBiYXNlO1xufVxuXG5mdW5jdGlvbiB0cnVzdChjd2Q6IHN0cmluZykge1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oY3dkLCBDT05GSUdfRElSX05BTUUsIFwiaG9va3MudHJ1c3RlZFwiKSwgXCJcIik7XG59XG5cbmZ1bmN0aW9uIHN0dWJSdW50aW1lKCk6IEV4dGVuc2lvblJ1bnRpbWUge1xuICByZXR1cm4ge1xuICAgIGZsYWdWYWx1ZXM6IG5ldyBNYXAoKSxcbiAgICBwZW5kaW5nUHJvdmlkZXJSZWdpc3RyYXRpb25zOiBbXSxcbiAgICByZWdpc3RlclByb3ZpZGVyOiAoKSA9PiB7fSxcbiAgICB1bnJlZ2lzdGVyUHJvdmlkZXI6ICgpID0+IHt9LFxuICAgIGVtaXRCZWZvcmVNb2RlbFNlbGVjdDogYXN5bmMgKCkgPT4gdW5kZWZpbmVkLFxuICAgIGVtaXRBZGp1c3RUb29sU2V0OiBhc3luYyAoKSA9PiB1bmRlZmluZWQsXG4gICAgZW1pdEV4dGVuc2lvbkV2ZW50OiBhc3luYyAoKSA9PiB1bmRlZmluZWQsXG4gICAgc2VuZE1lc3NhZ2U6ICgpID0+IHt9LFxuICAgIHNlbmRVc2VyTWVzc2FnZTogKCkgPT4ge30sXG4gICAgcmV0cnlMYXN0VHVybjogKCkgPT4ge30sXG4gICAgYXBwZW5kRW50cnk6ICgpID0+IHt9LFxuICAgIHNldFNlc3Npb25OYW1lOiAoKSA9PiB7fSxcbiAgICBnZXRTZXNzaW9uTmFtZTogKCkgPT4gdW5kZWZpbmVkLFxuICAgIHNldExhYmVsOiAoKSA9PiB7fSxcbiAgICBnZXRBY3RpdmVUb29sczogKCkgPT4gW10sXG4gICAgZ2V0QWxsVG9vbHM6ICgpID0+IFtdLFxuICAgIHNldEFjdGl2ZVRvb2xzOiAoKSA9PiB7fSxcbiAgICBnZXRWaXNpYmxlU2tpbGxzOiAoKSA9PiB1bmRlZmluZWQsXG4gICAgc2V0VmlzaWJsZVNraWxsczogKCkgPT4ge30sXG4gICAgcmVmcmVzaFRvb2xzOiAoKSA9PiB7fSxcbiAgICBnZXRDb21tYW5kczogKCkgPT4gW10sXG4gICAgc2V0TW9kZWw6IGFzeW5jICgpID0+IGZhbHNlLFxuICAgIGdldFRoaW5raW5nTGV2ZWw6ICgpID0+IFwib2ZmXCIsXG4gICAgc2V0VGhpbmtpbmdMZXZlbDogKCkgPT4ge30sXG4gIH07XG59XG5cbmZ1bmN0aW9uIG1ha2VSdW5uZXIoY3dkOiBzdHJpbmcpOiBFeHRlbnNpb25SdW5uZXIge1xuICByZXR1cm4gbmV3IEV4dGVuc2lvblJ1bm5lcihcbiAgICBbXSxcbiAgICBzdHViUnVudGltZSgpLFxuICAgIGN3ZCxcbiAgICB7fSBhcyBuZXZlcixcbiAgICB7fSBhcyBuZXZlcixcbiAgKTtcbn1cblxuZGVzY3JpYmUoXCJpc1Byb2plY3RIb29rc1RydXN0ZWRcIiwgKCkgPT4ge1xuICBsZXQgdG1wQ3dkOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIGFmdGVyRWFjaCgoKSA9PiB7XG4gICAgaWYgKHRtcEN3ZCkgcm1TeW5jKHRtcEN3ZCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIHRtcEN3ZCA9IHVuZGVmaW5lZDtcbiAgfSk7XG5cbiAgaXQoXCJyZXR1cm5zIGZhbHNlIHdoZW4gdGhlIG1hcmtlciBpcyBtaXNzaW5nXCIsICgpID0+IHtcbiAgICB0bXBDd2QgPSBtYWtlVGVtcFByb2plY3QoKTtcbiAgICBhc3NlcnQuZXF1YWwoaXNQcm9qZWN0SG9va3NUcnVzdGVkKHRtcEN3ZCksIGZhbHNlKTtcbiAgfSk7XG5cbiAgaXQoXCJyZXR1cm5zIHRydWUgYWZ0ZXIgdGhlIG1hcmtlciBpcyB3cml0dGVuXCIsICgpID0+IHtcbiAgICB0bXBDd2QgPSBtYWtlVGVtcFByb2plY3QoKTtcbiAgICB0cnVzdCh0bXBDd2QpO1xuICAgIGFzc2VydC5lcXVhbChpc1Byb2plY3RIb29rc1RydXN0ZWQodG1wQ3dkKSwgdHJ1ZSk7XG4gIH0pO1xufSk7XG5cbmRlc2NyaWJlKFwiY3JlYXRlSG9va3NSdW5uZXIgXHUyMDE0IHRydXN0IGdhdGVcIiwgKCkgPT4ge1xuICBsZXQgdG1wQ3dkOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIGFmdGVyRWFjaCgoKSA9PiB7XG4gICAgaWYgKHRtcEN3ZCkgcm1TeW5jKHRtcEN3ZCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIHRtcEN3ZCA9IHVuZGVmaW5lZDtcbiAgfSk7XG5cbiAgaXQoXCJpZ25vcmVzIHByb2plY3QgaG9va3Mgd2hlbiB0aGUgdHJ1c3QgbWFya2VyIGlzIGFic2VudFwiLCBhc3luYyAoKSA9PiB7XG4gICAgdG1wQ3dkID0gbWFrZVRlbXBQcm9qZWN0KCk7XG4gICAgY29uc3QgcnVubmVyID0gbWFrZVJ1bm5lcih0bXBDd2QpO1xuICAgIGNvbnN0IGludm9jYXRpb25zOiBzdHJpbmdbXSA9IFtdO1xuXG4gICAgY29uc3QgaG9va3MgPSBjcmVhdGVIb29rc1J1bm5lcih7XG4gICAgICBleHRlbnNpb25SdW5uZXI6IHJ1bm5lcixcbiAgICAgIGdldEdsb2JhbFNldHRpbmdzOiAoKTogU2V0dGluZ3MgPT4gKHt9KSxcbiAgICAgIGdldFByb2plY3RTZXR0aW5nczogKCk6IFNldHRpbmdzID0+ICh7XG4gICAgICAgIGhvb2tzOiB7XG4gICAgICAgICAgU2Vzc2lvblN0YXJ0OiBbXG4gICAgICAgICAgICB7IGNvbW1hbmQ6IGBub2RlIC1lIFwicHJvY2Vzcy5zdGRvdXQud3JpdGUoJ3t9JylcImAgfSxcbiAgICAgICAgICBdLFxuICAgICAgICB9LFxuICAgICAgfSksXG4gICAgICBjd2Q6IHRtcEN3ZCxcbiAgICAgIG9uSW52b2NhdGlvbjogKGkpID0+IGludm9jYXRpb25zLnB1c2goaS5jb21tYW5kKSxcbiAgICB9KTtcblxuICAgIGF3YWl0IGhvb2tzLmZpcmVTZXNzaW9uU3RhcnQoKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKGludm9jYXRpb25zLCBbXSk7XG4gICAgaG9va3MuZGlzcG9zZSgpO1xuICB9KTtcblxuICBpdChcInJ1bnMgcHJvamVjdCBob29rcyB3aGVuIHRoZSB0cnVzdCBtYXJrZXIgaXMgcHJlc2VudFwiLCBhc3luYyAoKSA9PiB7XG4gICAgdG1wQ3dkID0gbWFrZVRlbXBQcm9qZWN0KCk7XG4gICAgdHJ1c3QodG1wQ3dkKTtcbiAgICBjb25zdCBydW5uZXIgPSBtYWtlUnVubmVyKHRtcEN3ZCk7XG4gICAgY29uc3QgaW52b2NhdGlvbnM6IHN0cmluZ1tdID0gW107XG5cbiAgICBjb25zdCBob29rcyA9IGNyZWF0ZUhvb2tzUnVubmVyKHtcbiAgICAgIGV4dGVuc2lvblJ1bm5lcjogcnVubmVyLFxuICAgICAgZ2V0R2xvYmFsU2V0dGluZ3M6ICgpOiBTZXR0aW5ncyA9PiAoe30pLFxuICAgICAgZ2V0UHJvamVjdFNldHRpbmdzOiAoKTogU2V0dGluZ3MgPT4gKHtcbiAgICAgICAgaG9va3M6IHtcbiAgICAgICAgICBTZXNzaW9uU3RhcnQ6IFt7IGNvbW1hbmQ6IGBub2RlIC1lIFwicHJvY2Vzcy5leGl0KDApXCJgIH1dLFxuICAgICAgICB9LFxuICAgICAgfSksXG4gICAgICBjd2Q6IHRtcEN3ZCxcbiAgICAgIG9uSW52b2NhdGlvbjogKGkpID0+IGludm9jYXRpb25zLnB1c2goaS5jb21tYW5kKSxcbiAgICB9KTtcblxuICAgIGF3YWl0IGhvb2tzLmZpcmVTZXNzaW9uU3RhcnQoKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKGludm9jYXRpb25zLCBbYG5vZGUgLWUgXCJwcm9jZXNzLmV4aXQoMClcImBdKTtcbiAgICBob29rcy5kaXNwb3NlKCk7XG4gIH0pO1xuXG4gIGl0KFwicnVucyBnbG9iYWwgaG9va3MgdW5jb25kaXRpb25hbGx5XCIsIGFzeW5jICgpID0+IHtcbiAgICB0bXBDd2QgPSBtYWtlVGVtcFByb2plY3QoKTtcbiAgICBjb25zdCBydW5uZXIgPSBtYWtlUnVubmVyKHRtcEN3ZCk7XG4gICAgY29uc3QgaW52b2NhdGlvbnM6IHN0cmluZ1tdID0gW107XG5cbiAgICBjb25zdCBob29rcyA9IGNyZWF0ZUhvb2tzUnVubmVyKHtcbiAgICAgIGV4dGVuc2lvblJ1bm5lcjogcnVubmVyLFxuICAgICAgZ2V0R2xvYmFsU2V0dGluZ3M6ICgpOiBTZXR0aW5ncyA9PiAoe1xuICAgICAgICBob29rczogeyBTZXNzaW9uU3RhcnQ6IFt7IGNvbW1hbmQ6IGBub2RlIC1lIFwicHJvY2Vzcy5leGl0KDApXCJgIH1dIH0sXG4gICAgICB9KSxcbiAgICAgIGdldFByb2plY3RTZXR0aW5nczogKCk6IFNldHRpbmdzID0+ICh7fSksXG4gICAgICBjd2Q6IHRtcEN3ZCxcbiAgICAgIG9uSW52b2NhdGlvbjogKGkpID0+IGludm9jYXRpb25zLnB1c2goaS5jb21tYW5kKSxcbiAgICB9KTtcblxuICAgIGF3YWl0IGhvb2tzLmZpcmVTZXNzaW9uU3RhcnQoKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKGludm9jYXRpb25zLCBbYG5vZGUgLWUgXCJwcm9jZXNzLmV4aXQoMClcImBdKTtcbiAgICBob29rcy5kaXNwb3NlKCk7XG4gIH0pO1xufSk7XG5cbmRlc2NyaWJlKFwiY3JlYXRlSG9va3NSdW5uZXIgXHUyMDE0IFByZVRvb2xVc2UgYnJpZGdlcyB0byB0b29sX2NhbGxcIiwgKCkgPT4ge1xuICBsZXQgdG1wQ3dkOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIGFmdGVyRWFjaCgoKSA9PiB7XG4gICAgaWYgKHRtcEN3ZCkgcm1TeW5jKHRtcEN3ZCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIHRtcEN3ZCA9IHVuZGVmaW5lZDtcbiAgfSk7XG5cbiAgaXQoXCJibG9ja3MgYSB0b29sIGNhbGwgd2hlbiB0aGUgUHJlVG9vbFVzZSBob29rIHJldHVybnMgeyBibG9jazogdHJ1ZSB9XCIsIGFzeW5jICgpID0+IHtcbiAgICB0bXBDd2QgPSBtYWtlVGVtcFByb2plY3QoKTtcbiAgICBjb25zdCBydW5uZXIgPSBtYWtlUnVubmVyKHRtcEN3ZCk7XG5cbiAgICBjcmVhdGVIb29rc1J1bm5lcih7XG4gICAgICBleHRlbnNpb25SdW5uZXI6IHJ1bm5lcixcbiAgICAgIGdldEdsb2JhbFNldHRpbmdzOiAoKTogU2V0dGluZ3MgPT4gKHtcbiAgICAgICAgaG9va3M6IHtcbiAgICAgICAgICBQcmVUb29sVXNlOiBbXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIGNvbW1hbmQ6IGBub2RlIC1lIFwicHJvY2Vzcy5zdGRvdXQud3JpdGUoSlNPTi5zdHJpbmdpZnkoe2Jsb2NrOnRydWUscmVhc29uOidub3BlJ30pKVwiYCxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgXSxcbiAgICAgICAgfSxcbiAgICAgIH0pLFxuICAgICAgZ2V0UHJvamVjdFNldHRpbmdzOiAoKTogU2V0dGluZ3MgPT4gKHt9KSxcbiAgICAgIGN3ZDogdG1wQ3dkLFxuICAgIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVubmVyLmVtaXRUb29sQ2FsbCh7XG4gICAgICB0eXBlOiBcInRvb2xfY2FsbFwiLFxuICAgICAgdG9vbENhbGxJZDogXCJ0MVwiLFxuICAgICAgdG9vbE5hbWU6IFwiYmFzaFwiLFxuICAgICAgaW5wdXQ6IHsgY29tbWFuZDogXCJsc1wiIH0sXG4gICAgfSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdD8uYmxvY2ssIHRydWUpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQ/LnJlYXNvbiwgXCJub3BlXCIpO1xuICB9KTtcblxuICBpdChcImFwcGxpZXMgZmlsdGVyLnRvb2wgdG8gc2NvcGUgdGhlIGhvb2tcIiwgYXN5bmMgKCkgPT4ge1xuICAgIHRtcEN3ZCA9IG1ha2VUZW1wUHJvamVjdCgpO1xuICAgIGNvbnN0IHJ1bm5lciA9IG1ha2VSdW5uZXIodG1wQ3dkKTtcblxuICAgIGNyZWF0ZUhvb2tzUnVubmVyKHtcbiAgICAgIGV4dGVuc2lvblJ1bm5lcjogcnVubmVyLFxuICAgICAgZ2V0R2xvYmFsU2V0dGluZ3M6ICgpOiBTZXR0aW5ncyA9PiAoe1xuICAgICAgICBob29rczoge1xuICAgICAgICAgIFByZVRvb2xVc2U6IFtcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgbWF0Y2g6IHsgdG9vbDogXCJiYXNoXCIgfSxcbiAgICAgICAgICAgICAgY29tbWFuZDogYG5vZGUgLWUgXCJwcm9jZXNzLnN0ZG91dC53cml0ZShKU09OLnN0cmluZ2lmeSh7YmxvY2s6dHJ1ZSxyZWFzb246J2Jhc2gtb25seSd9KSlcImAsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIF0sXG4gICAgICAgIH0sXG4gICAgICB9KSxcbiAgICAgIGdldFByb2plY3RTZXR0aW5nczogKCk6IFNldHRpbmdzID0+ICh7fSksXG4gICAgICBjd2Q6IHRtcEN3ZCxcbiAgICB9KTtcblxuICAgIGNvbnN0IHJlYWRSZXN1bHQgPSBhd2FpdCBydW5uZXIuZW1pdFRvb2xDYWxsKHtcbiAgICAgIHR5cGU6IFwidG9vbF9jYWxsXCIsXG4gICAgICB0b29sQ2FsbElkOiBcInQyXCIsXG4gICAgICB0b29sTmFtZTogXCJyZWFkXCIsXG4gICAgICBpbnB1dDogeyBwYXRoOiBcIi90bXAveFwiIH0sXG4gICAgfSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlYWRSZXN1bHQ/LmJsb2NrLCB1bmRlZmluZWQpO1xuXG4gICAgY29uc3QgYmFzaFJlc3VsdCA9IGF3YWl0IHJ1bm5lci5lbWl0VG9vbENhbGwoe1xuICAgICAgdHlwZTogXCJ0b29sX2NhbGxcIixcbiAgICAgIHRvb2xDYWxsSWQ6IFwidDNcIixcbiAgICAgIHRvb2xOYW1lOiBcImJhc2hcIixcbiAgICAgIGlucHV0OiB7IGNvbW1hbmQ6IFwicm0gLXJmIC9cIiB9LFxuICAgIH0pO1xuICAgIGFzc2VydC5lcXVhbChiYXNoUmVzdWx0Py5ibG9jaywgdHJ1ZSk7XG4gIH0pO1xuXG4gIGl0KFwidHJlYXRzIGEgbm9uLXplcm8gZXhpdCBhcyBhIGJsb2NrIHdoZW4gYmxvY2tpbmcgaXMgbm90IGRpc2FibGVkXCIsIGFzeW5jICgpID0+IHtcbiAgICB0bXBDd2QgPSBtYWtlVGVtcFByb2plY3QoKTtcbiAgICBjb25zdCBydW5uZXIgPSBtYWtlUnVubmVyKHRtcEN3ZCk7XG5cbiAgICBjcmVhdGVIb29rc1J1bm5lcih7XG4gICAgICBleHRlbnNpb25SdW5uZXI6IHJ1bm5lcixcbiAgICAgIGdldEdsb2JhbFNldHRpbmdzOiAoKTogU2V0dGluZ3MgPT4gKHtcbiAgICAgICAgaG9va3M6IHsgUHJlVG9vbFVzZTogW3sgY29tbWFuZDogYG5vZGUgLWUgXCJwcm9jZXNzLmV4aXQoMSlcImAgfV0gfSxcbiAgICAgIH0pLFxuICAgICAgZ2V0UHJvamVjdFNldHRpbmdzOiAoKTogU2V0dGluZ3MgPT4gKHt9KSxcbiAgICAgIGN3ZDogdG1wQ3dkLFxuICAgIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVubmVyLmVtaXRUb29sQ2FsbCh7XG4gICAgICB0eXBlOiBcInRvb2xfY2FsbFwiLFxuICAgICAgdG9vbENhbGxJZDogXCJ0NFwiLFxuICAgICAgdG9vbE5hbWU6IFwiYmFzaFwiLFxuICAgICAgaW5wdXQ6IHsgY29tbWFuZDogXCJsc1wiIH0sXG4gICAgfSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdD8uYmxvY2ssIHRydWUpO1xuICB9KTtcblxuICBpdChcImRvZXMgbm90IGJsb2NrIHdoZW4gYmxvY2tpbmc6IGZhbHNlIGFuZCBleGl0IGlzIG5vbi16ZXJvXCIsIGFzeW5jICgpID0+IHtcbiAgICB0bXBDd2QgPSBtYWtlVGVtcFByb2plY3QoKTtcbiAgICBjb25zdCBydW5uZXIgPSBtYWtlUnVubmVyKHRtcEN3ZCk7XG5cbiAgICBjcmVhdGVIb29rc1J1bm5lcih7XG4gICAgICBleHRlbnNpb25SdW5uZXI6IHJ1bm5lcixcbiAgICAgIGdldEdsb2JhbFNldHRpbmdzOiAoKTogU2V0dGluZ3MgPT4gKHtcbiAgICAgICAgaG9va3M6IHsgUHJlVG9vbFVzZTogW3sgY29tbWFuZDogYG5vZGUgLWUgXCJwcm9jZXNzLmV4aXQoMSlcImAsIGJsb2NraW5nOiBmYWxzZSB9XSB9LFxuICAgICAgfSksXG4gICAgICBnZXRQcm9qZWN0U2V0dGluZ3M6ICgpOiBTZXR0aW5ncyA9PiAoe30pLFxuICAgICAgY3dkOiB0bXBDd2QsXG4gICAgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5uZXIuZW1pdFRvb2xDYWxsKHtcbiAgICAgIHR5cGU6IFwidG9vbF9jYWxsXCIsXG4gICAgICB0b29sQ2FsbElkOiBcInQ1XCIsXG4gICAgICB0b29sTmFtZTogXCJiYXNoXCIsXG4gICAgICBpbnB1dDogeyBjb21tYW5kOiBcImxzXCIgfSxcbiAgICB9KTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Py5ibG9jaywgdW5kZWZpbmVkKTtcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFNBQVMsVUFBVSxJQUFJLGlCQUFpQjtBQUN4QyxPQUFPLFlBQVk7QUFDbkIsU0FBUyxhQUFhLFdBQVcsZUFBZSxjQUFjO0FBQzlELFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFDdkIsU0FBUyx1QkFBdUI7QUFDaEMsU0FBUyx1QkFBdUI7QUFDaEMsU0FBUyxtQkFBbUIsNkJBQTZCO0FBSXpELFNBQVMsa0JBQWtCO0FBQ3pCLFFBQU0sT0FBTyxZQUFZLEtBQUssT0FBTyxHQUFHLG9CQUFvQixDQUFDO0FBQzdELFlBQVUsS0FBSyxNQUFNLGVBQWUsR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQzFELFNBQU87QUFDVDtBQUVBLFNBQVMsTUFBTSxLQUFhO0FBQzFCLGdCQUFjLEtBQUssS0FBSyxpQkFBaUIsZUFBZSxHQUFHLEVBQUU7QUFDL0Q7QUFFQSxTQUFTLGNBQWdDO0FBQ3ZDLFNBQU87QUFBQSxJQUNMLFlBQVksb0JBQUksSUFBSTtBQUFBLElBQ3BCLDhCQUE4QixDQUFDO0FBQUEsSUFDL0Isa0JBQWtCLE1BQU07QUFBQSxJQUFDO0FBQUEsSUFDekIsb0JBQW9CLE1BQU07QUFBQSxJQUFDO0FBQUEsSUFDM0IsdUJBQXVCLFlBQVk7QUFBQSxJQUNuQyxtQkFBbUIsWUFBWTtBQUFBLElBQy9CLG9CQUFvQixZQUFZO0FBQUEsSUFDaEMsYUFBYSxNQUFNO0FBQUEsSUFBQztBQUFBLElBQ3BCLGlCQUFpQixNQUFNO0FBQUEsSUFBQztBQUFB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
