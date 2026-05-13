import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ExtensionRunner } from "./runner.js";
import { SessionManager } from "../session-manager.js";
import { ModelRegistry } from "../model-registry.js";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuthStorage } from "../auth-storage.js";
function makeMinimalRuntime() {
  return {
    sendMessage: async () => {
    },
    sendUserMessage: async () => {
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
    refreshTools: () => {
    },
    getCommands: () => [],
    setModel: async () => {
    },
    getThinkingLevel: () => void 0,
    setThinkingLevel: () => {
    },
    registerProvider: () => {
    },
    unregisterProvider: () => {
    },
    pendingProviderRegistrations: []
  };
}
function makeThrowingExtension(eventType, error) {
  const handlers = /* @__PURE__ */ new Map();
  handlers.set(eventType, [
    async () => {
      throw error;
    }
  ]);
  return {
    path: "/test/throwing-ext",
    handlers,
    commands: [],
    shortcuts: [],
    diagnostics: []
  };
}
function makeCommandExtension(path, commandName, marker) {
  return {
    path,
    commands: /* @__PURE__ */ new Map([
      [
        commandName,
        {
          name: commandName,
          description: marker,
          handler: async () => {
          }
        }
      ]
    ]),
    handlers: /* @__PURE__ */ new Map(),
    shortcuts: /* @__PURE__ */ new Map(),
    tools: /* @__PURE__ */ new Map(),
    flags: /* @__PURE__ */ new Map(),
    diagnostics: []
  };
}
describe("ExtensionRunner.emitToolCall", () => {
  it("catches throwing extension handler and routes to emitError", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "runner-test-"));
    t.after(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const sessionManager = SessionManager.create(dir, dir);
    const authStorage = AuthStorage.create();
    const modelRegistry = new ModelRegistry(authStorage, join(dir, "models.json"));
    const throwingExt = makeThrowingExtension("tool_call", new Error("handler crashed"));
    const runtime = makeMinimalRuntime();
    const runner = new ExtensionRunner([throwingExt], runtime, dir, sessionManager, modelRegistry);
    const errors = [];
    runner.onError((err) => errors.push(err));
    const event = {
      type: "tool_call",
      toolCallId: "test-123",
      toolName: "test_tool",
      input: {}
    };
    const result = await runner.emitToolCall(event);
    assert.equal(result, void 0);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].error, "handler crashed");
    assert.equal(errors[0].event, "tool_call");
    assert.equal(errors[0].extensionPath, "/test/throwing-ext");
  });
  it("preserves shutdown in tool_call handler context", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "runner-test-"));
    t.after(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const sessionManager = SessionManager.create(dir, dir);
    const authStorage = AuthStorage.create();
    const modelRegistry = new ModelRegistry(authStorage, join(dir, "models.json"));
    const runtime = makeMinimalRuntime();
    let shutdownCount = 0;
    const handlers = /* @__PURE__ */ new Map();
    handlers.set("tool_call", [
      async (_event, ctx) => {
        ctx.shutdown();
      }
    ]);
    const extension = {
      path: "/test/shutdown-on-tool-call",
      handlers,
      commands: /* @__PURE__ */ new Map(),
      shortcuts: /* @__PURE__ */ new Map(),
      tools: /* @__PURE__ */ new Map(),
      flags: /* @__PURE__ */ new Map(),
      diagnostics: []
    };
    const runner = new ExtensionRunner([extension], runtime, dir, sessionManager, modelRegistry);
    runner.bindCore({}, {
      getModel: () => void 0,
      isIdle: () => true,
      abort: () => {
      },
      hasPendingMessages: () => false,
      shutdown: () => {
        shutdownCount += 1;
      },
      getContextUsage: () => void 0,
      compact: () => {
      },
      getSystemPrompt: () => "",
      setCompactionThresholdOverride: () => {
      }
    });
    const errors = [];
    runner.onError((err) => errors.push(err));
    await runner.emitToolCall({
      type: "tool_call",
      toolCallId: "test-123",
      toolName: "test_tool",
      input: {}
    });
    assert.equal(shutdownCount, 1);
    assert.equal(errors.length, 0);
  });
});
describe("ExtensionRunner.createContext", () => {
  it("uses the constructor workspace root instead of ambient process cwd", (t) => {
    const originalCwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), "runner-test-"));
    const projectDir = join(dir, "project");
    t.after(() => {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    });
    const sessionManager = SessionManager.create(dir, dir);
    const authStorage = AuthStorage.create();
    const modelRegistry = new ModelRegistry(authStorage, join(dir, "models.json"));
    const runtime = makeMinimalRuntime();
    const runner = new ExtensionRunner([], runtime, originalCwd, sessionManager, modelRegistry);
    mkdirSync(projectDir);
    const realProjectDir = realpathSync(projectDir);
    process.chdir(realProjectDir);
    assert.equal(runner.createContext().cwd, originalCwd);
    assert.equal(runner.createCommandContext().cwd, originalCwd);
  });
  it("does not let lifecycle event handlers close the TUI", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "runner-test-"));
    t.after(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const sessionManager = SessionManager.create(dir, dir);
    const authStorage = AuthStorage.create();
    const modelRegistry = new ModelRegistry(authStorage, join(dir, "models.json"));
    const runtime = makeMinimalRuntime();
    let shutdownCount = 0;
    const handlers = /* @__PURE__ */ new Map();
    handlers.set("agent_end", [
      async (_event, ctx) => {
        ctx.shutdown();
      }
    ]);
    const extension = {
      path: "/test/shutdown-on-agent-end",
      handlers,
      commands: /* @__PURE__ */ new Map(),
      shortcuts: /* @__PURE__ */ new Map(),
      tools: /* @__PURE__ */ new Map(),
      flags: /* @__PURE__ */ new Map(),
      diagnostics: []
    };
    const runner = new ExtensionRunner([extension], runtime, dir, sessionManager, modelRegistry);
    runner.bindCore({}, {
      getModel: () => void 0,
      isIdle: () => true,
      abort: () => {
      },
      hasPendingMessages: () => false,
      shutdown: () => {
        shutdownCount += 1;
      },
      getContextUsage: () => void 0,
      compact: () => {
      },
      getSystemPrompt: () => "",
      setCompactionThresholdOverride: () => {
      }
    });
    const errors = [];
    runner.onError((err) => errors.push(err));
    await runner.emit({ type: "agent_end", messages: [] });
    assert.equal(shutdownCount, 0);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].event, "agent_end");
    assert.match(errors[0].error, /cannot request TUI shutdown/);
    runner.createCommandContext().shutdown();
    assert.equal(shutdownCount, 1);
  });
});
describe("ExtensionRunner protected commands", () => {
  it("resolves /gsd to the bundled GSD extension even when another extension loads first", () => {
    const dir = mkdtempSync(join(tmpdir(), "runner-test-"));
    try {
      const sessionManager = SessionManager.create(dir, dir);
      const authStorage = AuthStorage.create();
      const modelRegistry = new ModelRegistry(authStorage, join(dir, "models.json"));
      const runtime = makeMinimalRuntime();
      const userExt = makeCommandExtension("/tmp/extensions/user-spoof/index.ts", "gsd", "spoof");
      const gsdExt = makeCommandExtension(`${dir}/extensions/gsd/index.ts`, "gsd", "bundled");
      const runner = new ExtensionRunner([userExt, gsdExt], runtime, dir, sessionManager, modelRegistry);
      const command = runner.getCommand("gsd");
      assert.equal(command?.description, "bundled");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("omits spoofed /gsd from registered extension commands", () => {
    const dir = mkdtempSync(join(tmpdir(), "runner-test-"));
    try {
      const sessionManager = SessionManager.create(dir, dir);
      const authStorage = AuthStorage.create();
      const modelRegistry = new ModelRegistry(authStorage, join(dir, "models.json"));
      const runtime = makeMinimalRuntime();
      const userExt = makeCommandExtension("/tmp/extensions/user-spoof/index.ts", "gsd", "spoof");
      const gsdExt = makeCommandExtension(`${dir}/extensions/gsd/index.ts`, "gsd", "bundled");
      const runner = new ExtensionRunner([userExt, gsdExt], runtime, dir, sessionManager, modelRegistry);
      const commands = runner.getRegisteredCommands();
      assert.deepEqual(commands.map((command) => command.description), ["bundled"]);
      assert.ok(
        runner.getCommandDiagnostics().some((diagnostic) => diagnostic.message.includes("protected command owner")),
        "spoofed /gsd conflict should be reported"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL2V4dGVuc2lvbnMvcnVubmVyLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgZGVzY3JpYmUsIGl0LCBtb2NrIH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IHsgRXh0ZW5zaW9uUnVubmVyIH0gZnJvbSBcIi4vcnVubmVyLmpzXCI7XG5pbXBvcnQgdHlwZSB7IEV4dGVuc2lvbiwgRXh0ZW5zaW9uUnVudGltZSwgVG9vbENhbGxFdmVudCB9IGZyb20gXCIuL2luZGV4LmpzXCI7XG5pbXBvcnQgeyBTZXNzaW9uTWFuYWdlciB9IGZyb20gXCIuLi9zZXNzaW9uLW1hbmFnZXIuanNcIjtcbmltcG9ydCB7IE1vZGVsUmVnaXN0cnkgfSBmcm9tIFwiLi4vbW9kZWwtcmVnaXN0cnkuanNcIjtcbmltcG9ydCB7IG1rZGlyU3luYywgbWtkdGVtcFN5bmMsIHJlYWxwYXRoU3luYywgcm1TeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgQXV0aFN0b3JhZ2UgfSBmcm9tIFwiLi4vYXV0aC1zdG9yYWdlLmpzXCI7XG5cbmZ1bmN0aW9uIG1ha2VNaW5pbWFsUnVudGltZSgpOiBFeHRlbnNpb25SdW50aW1lIHtcblx0cmV0dXJuIHtcblx0XHRzZW5kTWVzc2FnZTogYXN5bmMgKCkgPT4ge30sXG5cdFx0c2VuZFVzZXJNZXNzYWdlOiBhc3luYyAoKSA9PiB7fSxcblx0XHRhcHBlbmRFbnRyeTogKCkgPT4ge30sXG5cdFx0c2V0U2Vzc2lvbk5hbWU6ICgpID0+IHt9LFxuXHRcdGdldFNlc3Npb25OYW1lOiAoKSA9PiB1bmRlZmluZWQsXG5cdFx0c2V0TGFiZWw6ICgpID0+IHt9LFxuXHRcdGdldEFjdGl2ZVRvb2xzOiAoKSA9PiBbXSxcblx0XHRnZXRBbGxUb29sczogKCkgPT4gW10sXG5cdFx0c2V0QWN0aXZlVG9vbHM6ICgpID0+IHt9LFxuXHRcdHJlZnJlc2hUb29sczogKCkgPT4ge30sXG5cdFx0Z2V0Q29tbWFuZHM6ICgpID0+IFtdLFxuXHRcdHNldE1vZGVsOiBhc3luYyAoKSA9PiB7fSxcblx0XHRnZXRUaGlua2luZ0xldmVsOiAoKSA9PiB1bmRlZmluZWQsXG5cdFx0c2V0VGhpbmtpbmdMZXZlbDogKCkgPT4ge30sXG5cdFx0cmVnaXN0ZXJQcm92aWRlcjogKCkgPT4ge30sXG5cdFx0dW5yZWdpc3RlclByb3ZpZGVyOiAoKSA9PiB7fSxcblx0XHRwZW5kaW5nUHJvdmlkZXJSZWdpc3RyYXRpb25zOiBbXSxcblx0fSBhcyB1bmtub3duIGFzIEV4dGVuc2lvblJ1bnRpbWU7XG59XG5cbmZ1bmN0aW9uIG1ha2VUaHJvd2luZ0V4dGVuc2lvbihldmVudFR5cGU6IHN0cmluZywgZXJyb3I6IEVycm9yKTogRXh0ZW5zaW9uIHtcblx0Y29uc3QgaGFuZGxlcnMgPSBuZXcgTWFwKCk7XG5cdGhhbmRsZXJzLnNldChldmVudFR5cGUsIFtcblx0XHRhc3luYyAoKSA9PiB7XG5cdFx0XHR0aHJvdyBlcnJvcjtcblx0XHR9LFxuXHRdKTtcblx0cmV0dXJuIHtcblx0XHRwYXRoOiBcIi90ZXN0L3Rocm93aW5nLWV4dFwiLFxuXHRcdGhhbmRsZXJzLFxuXHRcdGNvbW1hbmRzOiBbXSxcblx0XHRzaG9ydGN1dHM6IFtdLFxuXHRcdGRpYWdub3N0aWNzOiBbXSxcblx0fSBhcyB1bmtub3duIGFzIEV4dGVuc2lvbjtcbn1cblxuZnVuY3Rpb24gbWFrZUNvbW1hbmRFeHRlbnNpb24ocGF0aDogc3RyaW5nLCBjb21tYW5kTmFtZTogc3RyaW5nLCBtYXJrZXI6IHN0cmluZyk6IEV4dGVuc2lvbiB7XG5cdHJldHVybiB7XG5cdFx0cGF0aCxcblx0XHRjb21tYW5kczogbmV3IE1hcChbXG5cdFx0XHRbXG5cdFx0XHRcdGNvbW1hbmROYW1lLFxuXHRcdFx0XHR7XG5cdFx0XHRcdFx0bmFtZTogY29tbWFuZE5hbWUsXG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246IG1hcmtlcixcblx0XHRcdFx0XHRoYW5kbGVyOiBhc3luYyAoKSA9PiB7fSxcblx0XHRcdFx0fSxcblx0XHRcdF0sXG5cdFx0XSksXG5cdFx0aGFuZGxlcnM6IG5ldyBNYXAoKSxcblx0XHRzaG9ydGN1dHM6IG5ldyBNYXAoKSxcblx0XHR0b29sczogbmV3IE1hcCgpLFxuXHRcdGZsYWdzOiBuZXcgTWFwKCksXG5cdFx0ZGlhZ25vc3RpY3M6IFtdLFxuXHR9IGFzIHVua25vd24gYXMgRXh0ZW5zaW9uO1xufVxuXG5kZXNjcmliZShcIkV4dGVuc2lvblJ1bm5lci5lbWl0VG9vbENhbGxcIiwgKCkgPT4ge1xuXHRpdChcImNhdGNoZXMgdGhyb3dpbmcgZXh0ZW5zaW9uIGhhbmRsZXIgYW5kIHJvdXRlcyB0byBlbWl0RXJyb3JcIiwgYXN5bmMgKHQpID0+IHtcblx0XHRjb25zdCBkaXIgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcInJ1bm5lci10ZXN0LVwiKSk7XG5cdFx0dC5hZnRlcigoKSA9PiB7XG5cdFx0XHRybVN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG5cdFx0fSk7XG5cblx0XHRjb25zdCBzZXNzaW9uTWFuYWdlciA9IFNlc3Npb25NYW5hZ2VyLmNyZWF0ZShkaXIsIGRpcik7XG5cdFx0Y29uc3QgYXV0aFN0b3JhZ2UgPSBBdXRoU3RvcmFnZS5jcmVhdGUoKTtcblx0XHRjb25zdCBtb2RlbFJlZ2lzdHJ5ID0gbmV3IE1vZGVsUmVnaXN0cnkoYXV0aFN0b3JhZ2UsIGpvaW4oZGlyLCBcIm1vZGVscy5qc29uXCIpKTtcblxuXHRcdGNvbnN0IHRocm93aW5nRXh0ID0gbWFrZVRocm93aW5nRXh0ZW5zaW9uKFwidG9vbF9jYWxsXCIsIG5ldyBFcnJvcihcImhhbmRsZXIgY3Jhc2hlZFwiKSk7XG5cdFx0Y29uc3QgcnVudGltZSA9IG1ha2VNaW5pbWFsUnVudGltZSgpO1xuXHRcdGNvbnN0IHJ1bm5lciA9IG5ldyBFeHRlbnNpb25SdW5uZXIoW3Rocm93aW5nRXh0XSwgcnVudGltZSwgZGlyLCBzZXNzaW9uTWFuYWdlciwgbW9kZWxSZWdpc3RyeSk7XG5cblx0XHRjb25zdCBlcnJvcnM6IGFueVtdID0gW107XG5cdFx0cnVubmVyLm9uRXJyb3IoKGVycikgPT4gZXJyb3JzLnB1c2goZXJyKSk7XG5cblx0XHRjb25zdCBldmVudDogVG9vbENhbGxFdmVudCA9IHtcblx0XHRcdHR5cGU6IFwidG9vbF9jYWxsXCIsXG5cdFx0XHR0b29sQ2FsbElkOiBcInRlc3QtMTIzXCIsXG5cdFx0XHR0b29sTmFtZTogXCJ0ZXN0X3Rvb2xcIixcblx0XHRcdGlucHV0OiB7fSxcblx0XHR9IGFzIFRvb2xDYWxsRXZlbnQ7XG5cblx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCBydW5uZXIuZW1pdFRvb2xDYWxsKGV2ZW50KTtcblxuXHRcdC8vIFNob3VsZCBub3QgdGhyb3cgXHUyMDE0IGVycm9yIGlzIGNhdWdodCBhbmQgcm91dGVkIHRvIGVtaXRFcnJvclxuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQsIHVuZGVmaW5lZCk7XG5cdFx0YXNzZXJ0LmVxdWFsKGVycm9ycy5sZW5ndGgsIDEpO1xuXHRcdGFzc2VydC5lcXVhbChlcnJvcnNbMF0uZXJyb3IsIFwiaGFuZGxlciBjcmFzaGVkXCIpO1xuXHRcdGFzc2VydC5lcXVhbChlcnJvcnNbMF0uZXZlbnQsIFwidG9vbF9jYWxsXCIpO1xuXHRcdGFzc2VydC5lcXVhbChlcnJvcnNbMF0uZXh0ZW5zaW9uUGF0aCwgXCIvdGVzdC90aHJvd2luZy1leHRcIik7XG5cdH0pO1xuXG5cdGl0KFwicHJlc2VydmVzIHNodXRkb3duIGluIHRvb2xfY2FsbCBoYW5kbGVyIGNvbnRleHRcIiwgYXN5bmMgKHQpID0+IHtcblx0XHRjb25zdCBkaXIgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcInJ1bm5lci10ZXN0LVwiKSk7XG5cdFx0dC5hZnRlcigoKSA9PiB7XG5cdFx0XHRybVN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG5cdFx0fSk7XG5cblx0XHRjb25zdCBzZXNzaW9uTWFuYWdlciA9IFNlc3Npb25NYW5hZ2VyLmNyZWF0ZShkaXIsIGRpcik7XG5cdFx0Y29uc3QgYXV0aFN0b3JhZ2UgPSBBdXRoU3RvcmFnZS5jcmVhdGUoKTtcblx0XHRjb25zdCBtb2RlbFJlZ2lzdHJ5ID0gbmV3IE1vZGVsUmVnaXN0cnkoYXV0aFN0b3JhZ2UsIGpvaW4oZGlyLCBcIm1vZGVscy5qc29uXCIpKTtcblx0XHRjb25zdCBydW50aW1lID0gbWFrZU1pbmltYWxSdW50aW1lKCk7XG5cdFx0bGV0IHNodXRkb3duQ291bnQgPSAwO1xuXHRcdGNvbnN0IGhhbmRsZXJzID0gbmV3IE1hcCgpO1xuXHRcdGhhbmRsZXJzLnNldChcInRvb2xfY2FsbFwiLCBbXG5cdFx0XHRhc3luYyAoX2V2ZW50OiB1bmtub3duLCBjdHg6IHsgc2h1dGRvd246ICgpID0+IHZvaWQgfSkgPT4ge1xuXHRcdFx0XHRjdHguc2h1dGRvd24oKTtcblx0XHRcdH0sXG5cdFx0XSk7XG5cdFx0Y29uc3QgZXh0ZW5zaW9uID0ge1xuXHRcdFx0cGF0aDogXCIvdGVzdC9zaHV0ZG93bi1vbi10b29sLWNhbGxcIixcblx0XHRcdGhhbmRsZXJzLFxuXHRcdFx0Y29tbWFuZHM6IG5ldyBNYXAoKSxcblx0XHRcdHNob3J0Y3V0czogbmV3IE1hcCgpLFxuXHRcdFx0dG9vbHM6IG5ldyBNYXAoKSxcblx0XHRcdGZsYWdzOiBuZXcgTWFwKCksXG5cdFx0XHRkaWFnbm9zdGljczogW10sXG5cdFx0fSBhcyB1bmtub3duIGFzIEV4dGVuc2lvbjtcblx0XHRjb25zdCBydW5uZXIgPSBuZXcgRXh0ZW5zaW9uUnVubmVyKFtleHRlbnNpb25dLCBydW50aW1lLCBkaXIsIHNlc3Npb25NYW5hZ2VyLCBtb2RlbFJlZ2lzdHJ5KTtcblx0XHRydW5uZXIuYmluZENvcmUoe30gYXMgYW55LCB7XG5cdFx0XHRnZXRNb2RlbDogKCkgPT4gdW5kZWZpbmVkLFxuXHRcdFx0aXNJZGxlOiAoKSA9PiB0cnVlLFxuXHRcdFx0YWJvcnQ6ICgpID0+IHt9LFxuXHRcdFx0aGFzUGVuZGluZ01lc3NhZ2VzOiAoKSA9PiBmYWxzZSxcblx0XHRcdHNodXRkb3duOiAoKSA9PiB7XG5cdFx0XHRcdHNodXRkb3duQ291bnQgKz0gMTtcblx0XHRcdH0sXG5cdFx0XHRnZXRDb250ZXh0VXNhZ2U6ICgpID0+IHVuZGVmaW5lZCxcblx0XHRcdGNvbXBhY3Q6ICgpID0+IHt9LFxuXHRcdFx0Z2V0U3lzdGVtUHJvbXB0OiAoKSA9PiBcIlwiLFxuXHRcdFx0c2V0Q29tcGFjdGlvblRocmVzaG9sZE92ZXJyaWRlOiAoKSA9PiB7fSxcblx0XHR9KTtcblxuXHRcdGNvbnN0IGVycm9yczogYW55W10gPSBbXTtcblx0XHRydW5uZXIub25FcnJvcigoZXJyKSA9PiBlcnJvcnMucHVzaChlcnIpKTtcblxuXHRcdGF3YWl0IHJ1bm5lci5lbWl0VG9vbENhbGwoe1xuXHRcdFx0dHlwZTogXCJ0b29sX2NhbGxcIixcblx0XHRcdHRvb2xDYWxsSWQ6IFwidGVzdC0xMjNcIixcblx0XHRcdHRvb2xOYW1lOiBcInRlc3RfdG9vbFwiLFxuXHRcdFx0aW5wdXQ6IHt9LFxuXHRcdH0gYXMgVG9vbENhbGxFdmVudCk7XG5cblx0XHRhc3NlcnQuZXF1YWwoc2h1dGRvd25Db3VudCwgMSk7XG5cdFx0YXNzZXJ0LmVxdWFsKGVycm9ycy5sZW5ndGgsIDApO1xuXHR9KTtcbn0pO1xuXG5kZXNjcmliZShcIkV4dGVuc2lvblJ1bm5lci5jcmVhdGVDb250ZXh0XCIsICgpID0+IHtcblx0aXQoXCJ1c2VzIHRoZSBjb25zdHJ1Y3RvciB3b3Jrc3BhY2Ugcm9vdCBpbnN0ZWFkIG9mIGFtYmllbnQgcHJvY2VzcyBjd2RcIiwgKHQpID0+IHtcblx0XHRjb25zdCBvcmlnaW5hbEN3ZCA9IHByb2Nlc3MuY3dkKCk7XG5cdFx0Y29uc3QgZGlyID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJydW5uZXItdGVzdC1cIikpO1xuXHRcdGNvbnN0IHByb2plY3REaXIgPSBqb2luKGRpciwgXCJwcm9qZWN0XCIpO1xuXHRcdHQuYWZ0ZXIoKCkgPT4ge1xuXHRcdFx0cHJvY2Vzcy5jaGRpcihvcmlnaW5hbEN3ZCk7XG5cdFx0XHRybVN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG5cdFx0fSk7XG5cblx0XHRjb25zdCBzZXNzaW9uTWFuYWdlciA9IFNlc3Npb25NYW5hZ2VyLmNyZWF0ZShkaXIsIGRpcik7XG5cdFx0Y29uc3QgYXV0aFN0b3JhZ2UgPSBBdXRoU3RvcmFnZS5jcmVhdGUoKTtcblx0XHRjb25zdCBtb2RlbFJlZ2lzdHJ5ID0gbmV3IE1vZGVsUmVnaXN0cnkoYXV0aFN0b3JhZ2UsIGpvaW4oZGlyLCBcIm1vZGVscy5qc29uXCIpKTtcblx0XHRjb25zdCBydW50aW1lID0gbWFrZU1pbmltYWxSdW50aW1lKCk7XG5cdFx0Y29uc3QgcnVubmVyID0gbmV3IEV4dGVuc2lvblJ1bm5lcihbXSwgcnVudGltZSwgb3JpZ2luYWxDd2QsIHNlc3Npb25NYW5hZ2VyLCBtb2RlbFJlZ2lzdHJ5KTtcblxuXHRcdG1rZGlyU3luYyhwcm9qZWN0RGlyKTtcblx0XHRjb25zdCByZWFsUHJvamVjdERpciA9IHJlYWxwYXRoU3luYyhwcm9qZWN0RGlyKTtcblx0XHRwcm9jZXNzLmNoZGlyKHJlYWxQcm9qZWN0RGlyKTtcblxuXHRcdGFzc2VydC5lcXVhbChydW5uZXIuY3JlYXRlQ29udGV4dCgpLmN3ZCwgb3JpZ2luYWxDd2QpO1xuXHRcdGFzc2VydC5lcXVhbChydW5uZXIuY3JlYXRlQ29tbWFuZENvbnRleHQoKS5jd2QsIG9yaWdpbmFsQ3dkKTtcblx0fSk7XG5cblx0aXQoXCJkb2VzIG5vdCBsZXQgbGlmZWN5Y2xlIGV2ZW50IGhhbmRsZXJzIGNsb3NlIHRoZSBUVUlcIiwgYXN5bmMgKHQpID0+IHtcblx0XHRjb25zdCBkaXIgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcInJ1bm5lci10ZXN0LVwiKSk7XG5cdFx0dC5hZnRlcigoKSA9PiB7XG5cdFx0XHRybVN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG5cdFx0fSk7XG5cblx0XHRjb25zdCBzZXNzaW9uTWFuYWdlciA9IFNlc3Npb25NYW5hZ2VyLmNyZWF0ZShkaXIsIGRpcik7XG5cdFx0Y29uc3QgYXV0aFN0b3JhZ2UgPSBBdXRoU3RvcmFnZS5jcmVhdGUoKTtcblx0XHRjb25zdCBtb2RlbFJlZ2lzdHJ5ID0gbmV3IE1vZGVsUmVnaXN0cnkoYXV0aFN0b3JhZ2UsIGpvaW4oZGlyLCBcIm1vZGVscy5qc29uXCIpKTtcblx0XHRjb25zdCBydW50aW1lID0gbWFrZU1pbmltYWxSdW50aW1lKCk7XG5cdFx0bGV0IHNodXRkb3duQ291bnQgPSAwO1xuXHRcdGNvbnN0IGhhbmRsZXJzID0gbmV3IE1hcCgpO1xuXHRcdGhhbmRsZXJzLnNldChcImFnZW50X2VuZFwiLCBbXG5cdFx0XHRhc3luYyAoX2V2ZW50OiB1bmtub3duLCBjdHg6IHsgc2h1dGRvd246ICgpID0+IHZvaWQgfSkgPT4ge1xuXHRcdFx0XHRjdHguc2h1dGRvd24oKTtcblx0XHRcdH0sXG5cdFx0XSk7XG5cdFx0Y29uc3QgZXh0ZW5zaW9uID0ge1xuXHRcdFx0cGF0aDogXCIvdGVzdC9zaHV0ZG93bi1vbi1hZ2VudC1lbmRcIixcblx0XHRcdGhhbmRsZXJzLFxuXHRcdFx0Y29tbWFuZHM6IG5ldyBNYXAoKSxcblx0XHRcdHNob3J0Y3V0czogbmV3IE1hcCgpLFxuXHRcdFx0dG9vbHM6IG5ldyBNYXAoKSxcblx0XHRcdGZsYWdzOiBuZXcgTWFwKCksXG5cdFx0XHRkaWFnbm9zdGljczogW10sXG5cdFx0fSBhcyB1bmtub3duIGFzIEV4dGVuc2lvbjtcblx0XHRjb25zdCBydW5uZXIgPSBuZXcgRXh0ZW5zaW9uUnVubmVyKFtleHRlbnNpb25dLCBydW50aW1lLCBkaXIsIHNlc3Npb25NYW5hZ2VyLCBtb2RlbFJlZ2lzdHJ5KTtcblx0XHRydW5uZXIuYmluZENvcmUoe30gYXMgYW55LCB7XG5cdFx0XHRnZXRNb2RlbDogKCkgPT4gdW5kZWZpbmVkLFxuXHRcdFx0aXNJZGxlOiAoKSA9PiB0cnVlLFxuXHRcdFx0YWJvcnQ6ICgpID0+IHt9LFxuXHRcdFx0aGFzUGVuZGluZ01lc3NhZ2VzOiAoKSA9PiBmYWxzZSxcblx0XHRcdHNodXRkb3duOiAoKSA9PiB7XG5cdFx0XHRcdHNodXRkb3duQ291bnQgKz0gMTtcblx0XHRcdH0sXG5cdFx0XHRnZXRDb250ZXh0VXNhZ2U6ICgpID0+IHVuZGVmaW5lZCxcblx0XHRcdGNvbXBhY3Q6ICgpID0+IHt9LFxuXHRcdFx0Z2V0U3lzdGVtUHJvbXB0OiAoKSA9PiBcIlwiLFxuXHRcdFx0c2V0Q29tcGFjdGlvblRocmVzaG9sZE92ZXJyaWRlOiAoKSA9PiB7fSxcblx0XHR9KTtcblxuXHRcdGNvbnN0IGVycm9yczogYW55W10gPSBbXTtcblx0XHRydW5uZXIub25FcnJvcigoZXJyKSA9PiBlcnJvcnMucHVzaChlcnIpKTtcblxuXHRcdGF3YWl0IHJ1bm5lci5lbWl0KHsgdHlwZTogXCJhZ2VudF9lbmRcIiwgbWVzc2FnZXM6IFtdIH0gYXMgYW55KTtcblxuXHRcdGFzc2VydC5lcXVhbChzaHV0ZG93bkNvdW50LCAwKTtcblx0XHRhc3NlcnQuZXF1YWwoZXJyb3JzLmxlbmd0aCwgMSk7XG5cdFx0YXNzZXJ0LmVxdWFsKGVycm9yc1swXS5ldmVudCwgXCJhZ2VudF9lbmRcIik7XG5cdFx0YXNzZXJ0Lm1hdGNoKGVycm9yc1swXS5lcnJvciwgL2Nhbm5vdCByZXF1ZXN0IFRVSSBzaHV0ZG93bi8pO1xuXG5cdFx0cnVubmVyLmNyZWF0ZUNvbW1hbmRDb250ZXh0KCkuc2h1dGRvd24oKTtcblx0XHRhc3NlcnQuZXF1YWwoc2h1dGRvd25Db3VudCwgMSk7XG5cdH0pO1xufSk7XG5cbmRlc2NyaWJlKFwiRXh0ZW5zaW9uUnVubmVyIHByb3RlY3RlZCBjb21tYW5kc1wiLCAoKSA9PiB7XG5cdGl0KFwicmVzb2x2ZXMgL2dzZCB0byB0aGUgYnVuZGxlZCBHU0QgZXh0ZW5zaW9uIGV2ZW4gd2hlbiBhbm90aGVyIGV4dGVuc2lvbiBsb2FkcyBmaXJzdFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgZGlyID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJydW5uZXItdGVzdC1cIikpO1xuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBzZXNzaW9uTWFuYWdlciA9IFNlc3Npb25NYW5hZ2VyLmNyZWF0ZShkaXIsIGRpcik7XG5cdFx0XHRjb25zdCBhdXRoU3RvcmFnZSA9IEF1dGhTdG9yYWdlLmNyZWF0ZSgpO1xuXHRcdFx0Y29uc3QgbW9kZWxSZWdpc3RyeSA9IG5ldyBNb2RlbFJlZ2lzdHJ5KGF1dGhTdG9yYWdlLCBqb2luKGRpciwgXCJtb2RlbHMuanNvblwiKSk7XG5cdFx0XHRjb25zdCBydW50aW1lID0gbWFrZU1pbmltYWxSdW50aW1lKCk7XG5cdFx0XHRjb25zdCB1c2VyRXh0ID0gbWFrZUNvbW1hbmRFeHRlbnNpb24oXCIvdG1wL2V4dGVuc2lvbnMvdXNlci1zcG9vZi9pbmRleC50c1wiLCBcImdzZFwiLCBcInNwb29mXCIpO1xuXHRcdFx0Y29uc3QgZ3NkRXh0ID0gbWFrZUNvbW1hbmRFeHRlbnNpb24oYCR7ZGlyfS9leHRlbnNpb25zL2dzZC9pbmRleC50c2AsIFwiZ3NkXCIsIFwiYnVuZGxlZFwiKTtcblx0XHRcdGNvbnN0IHJ1bm5lciA9IG5ldyBFeHRlbnNpb25SdW5uZXIoW3VzZXJFeHQsIGdzZEV4dF0sIHJ1bnRpbWUsIGRpciwgc2Vzc2lvbk1hbmFnZXIsIG1vZGVsUmVnaXN0cnkpO1xuXG5cdFx0XHRjb25zdCBjb21tYW5kID0gcnVubmVyLmdldENvbW1hbmQoXCJnc2RcIik7XG5cdFx0XHRhc3NlcnQuZXF1YWwoY29tbWFuZD8uZGVzY3JpcHRpb24sIFwiYnVuZGxlZFwiKTtcblx0XHR9IGZpbmFsbHkge1xuXHRcdFx0cm1TeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuXHRcdH1cblx0fSk7XG5cblx0aXQoXCJvbWl0cyBzcG9vZmVkIC9nc2QgZnJvbSByZWdpc3RlcmVkIGV4dGVuc2lvbiBjb21tYW5kc1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgZGlyID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJydW5uZXItdGVzdC1cIikpO1xuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBzZXNzaW9uTWFuYWdlciA9IFNlc3Npb25NYW5hZ2VyLmNyZWF0ZShkaXIsIGRpcik7XG5cdFx0XHRjb25zdCBhdXRoU3RvcmFnZSA9IEF1dGhTdG9yYWdlLmNyZWF0ZSgpO1xuXHRcdFx0Y29uc3QgbW9kZWxSZWdpc3RyeSA9IG5ldyBNb2RlbFJlZ2lzdHJ5KGF1dGhTdG9yYWdlLCBqb2luKGRpciwgXCJtb2RlbHMuanNvblwiKSk7XG5cdFx0XHRjb25zdCBydW50aW1lID0gbWFrZU1pbmltYWxSdW50aW1lKCk7XG5cdFx0XHRjb25zdCB1c2VyRXh0ID0gbWFrZUNvbW1hbmRFeHRlbnNpb24oXCIvdG1wL2V4dGVuc2lvbnMvdXNlci1zcG9vZi9pbmRleC50c1wiLCBcImdzZFwiLCBcInNwb29mXCIpO1xuXHRcdFx0Y29uc3QgZ3NkRXh0ID0gbWFrZUNvbW1hbmRFeHRlbnNpb24oYCR7ZGlyfS9leHRlbnNpb25zL2dzZC9pbmRleC50c2AsIFwiZ3NkXCIsIFwiYnVuZGxlZFwiKTtcblx0XHRcdGNvbnN0IHJ1bm5lciA9IG5ldyBFeHRlbnNpb25SdW5uZXIoW3VzZXJFeHQsIGdzZEV4dF0sIHJ1bnRpbWUsIGRpciwgc2Vzc2lvbk1hbmFnZXIsIG1vZGVsUmVnaXN0cnkpO1xuXG5cdFx0XHRjb25zdCBjb21tYW5kcyA9IHJ1bm5lci5nZXRSZWdpc3RlcmVkQ29tbWFuZHMoKTtcblx0XHRcdGFzc2VydC5kZWVwRXF1YWwoY29tbWFuZHMubWFwKChjb21tYW5kKSA9PiBjb21tYW5kLmRlc2NyaXB0aW9uKSwgW1wiYnVuZGxlZFwiXSk7XG5cdFx0XHRhc3NlcnQub2soXG5cdFx0XHRcdHJ1bm5lci5nZXRDb21tYW5kRGlhZ25vc3RpY3MoKS5zb21lKChkaWFnbm9zdGljKSA9PiBkaWFnbm9zdGljLm1lc3NhZ2UuaW5jbHVkZXMoXCJwcm90ZWN0ZWQgY29tbWFuZCBvd25lclwiKSksXG5cdFx0XHRcdFwic3Bvb2ZlZCAvZ3NkIGNvbmZsaWN0IHNob3VsZCBiZSByZXBvcnRlZFwiLFxuXHRcdFx0KTtcblx0XHR9IGZpbmFsbHkge1xuXHRcdFx0cm1TeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuXHRcdH1cblx0fSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLE9BQU8sWUFBWTtBQUNuQixTQUFTLFVBQVUsVUFBZ0I7QUFDbkMsU0FBUyx1QkFBdUI7QUFFaEMsU0FBUyxzQkFBc0I7QUFDL0IsU0FBUyxxQkFBcUI7QUFDOUIsU0FBUyxXQUFXLGFBQWEsY0FBYyxjQUFjO0FBQzdELFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFDdkIsU0FBUyxtQkFBbUI7QUFFNUIsU0FBUyxxQkFBdUM7QUFDL0MsU0FBTztBQUFBLElBQ04sYUFBYSxZQUFZO0FBQUEsSUFBQztBQUFBLElBQzFCLGlCQUFpQixZQUFZO0FBQUEsSUFBQztBQUFBLElBQzlCLGFBQWEsTUFBTTtBQUFBLElBQUM7QUFBQSxJQUNwQixnQkFBZ0IsTUFBTTtBQUFBLElBQUM7QUFBQSxJQUN2QixnQkFBZ0IsTUFBTTtBQUFBLElBQ3RCLFVBQVUsTUFBTTtBQUFBLElBQUM7QUFBQSxJQUNqQixnQkFBZ0IsTUFBTSxDQUFDO0FBQUEsSUFDdkIsYUFBYSxNQUFNLENBQUM7QUFBQSxJQUNwQixnQkFBZ0IsTUFBTTtBQUFBLElBQUM7QUFBQSxJQUN2QixjQUFjLE1BQU07QUFBQSxJQUFDO0FBQUEsSUFDckIs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
